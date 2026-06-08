#!/usr/bin/env node
// Host-side maintenance runner for Gamertown.
//
// Responsibilities:
//   1. Tune BlueMap's live Docker CPU quota from player presence.
//   2. Run game-server update checks hourly, but only while nobody is online.
//
// This intentionally runs on the Docker host, not inside the app container. Image
// pulls / Compose recreates need full host Docker access; the website only gets a
// scoped socket proxy.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const ROOT = process.env.GT_ROOT || process.cwd();
const DB = process.env.GT_DB_PATH
  || '/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite';
const LOCK_DIR = process.env.GT_MAINT_LOCK_DIR || '/tmp/gamertown-maintenance.lock';

const RESOURCE_POLL_MS = seconds('GT_RESOURCE_POLL_SECONDS', 60) * 1000;
const UPDATE_INTERVAL_MS = seconds('GT_UPDATE_INTERVAL_SECONDS', 3600) * 1000;
const IDLE_DELAY_MS = seconds('GT_BLUEMAP_IDLE_DELAY_SECONDS', 300) * 1000;
const ACTIVE_CPUS = number('GT_BLUEMAP_ACTIVE_CPUS', 2);
const IDLE_CPUS = number('GT_BLUEMAP_IDLE_CPUS', 0); // 0 = auto: host cpus - reserve
const RESERVED_CPUS = number('GT_BLUEMAP_RESERVED_CPUS', 4);
const RESTART_STEAM = bool('GT_MAINT_RESTART_STEAM', true);

const COMPOSE_FILES = (process.env.GT_COMPOSE_FILES || 'docker-compose.yml,servers.compose.yml')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IMAGE_SERVICES = ['minecraft', 'factorio'];
const STEAM_UPDATERS = [
  {
    service: 'counterstrike',
    command: '/home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/cs2-dedicated +login anonymous +app_update 730 +quit',
  },
  { service: 'gmod', command: '/data/gmodserver update' },
  { service: 'prophunt', command: '/data/gmodserver update' },
];

let idleSince = null;
let lastBlueMapCpus = null;
let lastUpdateAt = 0;
let updateRunning = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function number(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function seconds(name, def) {
  return Math.max(1, number(name, def));
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function composeArgs() {
  return COMPOSE_FILES.flatMap((file) => ['-f', file]);
}

async function run(cmd, args, { cwd = ROOT, env = process.env } = {}) {
  log('$', cmd, ...args);
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function querySql(sql) {
  if (!existsSync(DB)) throw new Error(`DB not found: ${DB}`);
  const { stdout } = await execFileP('sqlite3', ['-bail', '-json', '-cmd', '.timeout 5000', DB, sql]);
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function onlineCount() {
  const rows = await querySql(
    `SELECT COUNT(*) AS n
       FROM server_sessions s JOIN games g ON g.id = s.game_id
      WHERE s.left_at IS NULL AND g.hosted = 1;`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function hostCpus() {
  const { stdout } = await execFileP('docker', ['info', '--format', '{{.NCPU}}']);
  return Math.max(1, Number(stdout.trim()) || 1);
}

function targetBlueMapCpus({ online, cpus }) {
  if (online > 0) return Math.max(1, Math.min(cpus, Math.floor(ACTIVE_CPUS)));
  const idle = IDLE_CPUS > 0 ? IDLE_CPUS : Math.max(1, cpus - Math.max(0, Math.floor(RESERVED_CPUS)));
  return Math.max(1, Math.min(cpus, Math.floor(idle)));
}

async function tuneBlueMapOnce() {
  let online;
  try {
    online = await onlineCount();
  } catch (err) {
    log('presence unavailable, keeping BlueMap at active cap:', err.message);
    online = 1; // fail safe: assume a player might be online
  }

  const cpus = await hostCpus();
  let effectiveOnline = online;
  if (online === 0) {
    if (idleSince == null) idleSince = Date.now();
    if (lastBlueMapCpus != null && Date.now() - idleSince < IDLE_DELAY_MS) effectiveOnline = 1;
  } else {
    idleSince = null;
  }

  const target = targetBlueMapCpus({ online: effectiveOnline, cpus });
  if (target === lastBlueMapCpus) return { online, cpus, target, changed: false };
  await run('docker', ['update', '--cpus', String(target), 'bluemap']);
  lastBlueMapCpus = target;
  log(`BlueMap cpu cap -> ${target}/${cpus} cpus (${online} online)`);
  return { online, cpus, target, changed: true };
}

async function containerRunning(name) {
  try {
    const { stdout } = await execFileP('docker', ['inspect', '-f', '{{.State.Running}}', name]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    mkdirSync(LOCK_DIR);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

async function assertEmpty(reason) {
  const n = await onlineCount();
  if (n > 0) throw new Error(`${reason}: ${n} player(s) online`);
}

async function updateOnce() {
  if (updateRunning) return;
  updateRunning = true;
  try {
    await assertEmpty('maintenance skipped');
    if (!acquireLock()) {
      log('maintenance already running elsewhere; skipping');
      return;
    }
    try {
      log('starting no-player maintenance update');

      await run('docker', ['compose', ...composeArgs(), 'pull', ...IMAGE_SERVICES]);
      await assertEmpty('compose recreate skipped');
      await run('docker', ['compose', ...composeArgs(), 'up', '-d', '--no-deps', ...IMAGE_SERVICES]);

      for (const { service, command } of STEAM_UPDATERS) {
        if (!(await containerRunning(service))) {
          log(`${service}: not running, skipping updater`);
          continue;
        }
        await assertEmpty(`${service} update skipped`);
        await run('docker', ['exec', service, 'sh', '-lc', command]);
        if (RESTART_STEAM) {
          await assertEmpty(`${service} restart skipped`);
          await run('docker', ['restart', service]);
        }
      }

      log('maintenance update complete');
    } finally {
      releaseLock();
    }
  } catch (err) {
    log('maintenance update skipped/failed:', err.message);
  } finally {
    updateRunning = false;
    lastUpdateAt = Date.now();
  }
}

async function daemon() {
  log('maintenance daemon starting');
  lastUpdateAt = Date.now();
  await tuneBlueMapOnce().catch((err) => log('BlueMap tuning failed:', err.message));
  setInterval(() => tuneBlueMapOnce().catch((err) => log('BlueMap tuning failed:', err.message)), RESOURCE_POLL_MS);
  setInterval(() => {
    if (Date.now() - lastUpdateAt >= UPDATE_INTERVAL_MS) updateOnce();
  }, 60_000);
}

const cmd = process.argv[2] || 'daemon';
if (cmd === 'resources') {
  await tuneBlueMapOnce();
} else if (cmd === 'updates') {
  await updateOnce();
} else if (cmd === 'daemon') {
  await daemon();
} else {
  console.error('usage: gt-maintenance.mjs [daemon|resources|updates]');
  process.exit(2);
}
