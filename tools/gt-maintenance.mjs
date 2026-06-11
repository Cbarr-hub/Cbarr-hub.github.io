#!/usr/bin/env node
// Host-side maintenance runner for Gamertown: hourly game-server update checks,
// run only while nobody is online (presence read from the session-tracker's
// open-session rows).
//
// This intentionally runs on the Docker host, not inside the app container. Image
// pulls / Compose recreates need full host Docker access; the website only gets a
// scoped socket proxy. (BlueMap CPU tuning used to live here too — the app-side
// tuner in backend/src/servers/bluemap.js is now the single owner of that policy.)
//
// Pure Node by design (no node_modules on the host): the imported backend modules
// are dependency-free (node builtins only).

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { onlineCount as ONLINE_COUNT_SQL } from '../backend/src/servers/session-sql.js';
import { counterstrikeSpec } from '../backend/src/servers/connectors/specs/counterstrike.js';
import { gmodSpec } from '../backend/src/servers/connectors/specs/gmod.js';

const execFileP = promisify(execFile);

const ROOT = process.env.GT_ROOT || process.cwd();
const DB = process.env.GT_DB_PATH
  || '/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite';
const LOCK_DIR = process.env.GT_MAINT_LOCK_DIR || '/tmp/gamertown-maintenance.lock';

const UPDATE_INTERVAL_MS = seconds('GT_UPDATE_INTERVAL_SECONDS', 3600) * 1000;
const RESTART_STEAM = bool('GT_MAINT_RESTART_STEAM', true);

const COMPOSE_FILES = (process.env.GT_COMPOSE_FILES || 'docker-compose.yml,servers.compose.yml')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IMAGE_SERVICES = ['minecraft', 'factorio'];
// In-container SteamCMD update commands come from the connector specs (the single
// source of truth the panel's in-app Update button also runs): spec.update.argv is
// ['/bin/bash', '-lc', <command>] — the command is the last element, executed here
// under a `docker exec <svc> sh -lc` wrapper. Prop Hunt shares GMOD's LinuxGSM
// recipe (prophuntSpec.update IS gmodSpec's GMOD_UPDATE object).
const STEAM_UPDATERS = [
  { service: 'counterstrike', command: counterstrikeSpec.update.argv.at(-1) },
  { service: 'gmod',          command: gmodSpec.update.argv.at(-1) },
  { service: 'prophunt',      command: gmodSpec.update.argv.at(-1) },
];

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

// Open-session count across the hosted servers — the canonical presence read
// (backend/src/servers/session-sql.js), gating the idle-only update path.
async function onlineCount() {
  const rows = await querySql(ONLINE_COUNT_SQL);
  return Number(rows[0]?.n ?? 0);
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
  // Check every minute whether the hourly update window has elapsed; updateOnce
  // itself re-verifies nobody is online before (and during) each step.
  setInterval(() => {
    if (Date.now() - lastUpdateAt >= UPDATE_INTERVAL_MS) updateOnce();
  }, 60_000);
}

await daemon();
