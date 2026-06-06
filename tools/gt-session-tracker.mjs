#!/usr/bin/env node
// Host-side player-session collector for the Gamertown game servers.
//
// Runs on the keeper as a long-running systemd service (tools/systemd/
// gt-session-tracker.service), INDEPENDENT of the website/app container. It writes
// join/leave rows into the same SQLite DB the app reads for the servers panel's
// standalone "Events" section. Host root has full `docker logs`/`docker inspect` + direct DB-volume
// access; the app only reaches Docker through the scoped socket-proxy, which is why
// this lives host-side. Mirror of the gt-backup.sh model.
//
// Hybrid collection (per the design):
//   • Minecraft + Factorio → tail `docker logs -f -t` and parse join/leave lines
//     (accurate timestamps; Minecraft also yields the Mojang UUID).
//   • GMOD / Prop Hunt / CS2 → poll RCON `status` every 60s and diff (±60s).
//     GMOD/PH give SteamID64; CS2 redacts it → name-only.
//
// Pure Node by design (no node_modules on the host): it imports three
// dependency-free repo modules and shells out to `docker` + `sqlite3` (both already
// used by gt-backup.sh). Needs `node` + `sqlite3` on the keeper. NEEDS HOST
// VALIDATION against the real containers (log formats / sqlite3 -json support).
//
// Install (on the keeper):
//   cp tools/systemd/gt-session-tracker.service /etc/systemd/system/
//   systemctl daemon-reload && systemctl enable --now gt-session-tracker
//   journalctl -u gt-session-tracker -f

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { listServers } from '../backend/src/servers/registry.js';
import { rconExchange } from '../backend/src/servers/rcon-tcp.js';
import {
  parseSourceStatus, parseMinecraftLog, parseFactorioLog,
} from '../backend/src/servers/connectors/online-parse.js';

const execFileP = promisify(execFile);

const DB = process.env.GT_DB_PATH
  || '/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite';
const POLL_MS = Number(process.env.GT_POLL_MS) || 60_000;

const SERVERS = listServers();
const byId = new Map(SERVERS.map((s) => [s.id, s]));

// Collection path + RCON env var come from the registry (registry.js is the single
// source of truth: each server carries `collect: 'log'|'rcon'` and, for rcon, a
// `rconEnvKey`). Deriving them here means this collector has no game list of its own
// to drift from the registry.
const LOG_GAMES  = new Set(SERVERS.filter((s) => s.collect === 'log').map((s) => s.id));
const RCON_GAMES = new Set(SERVERS.filter((s) => s.collect === 'rcon').map((s) => s.id));
const rconEnvKey = (slug) => byId.get(slug)?.rconEnvKey;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

// ── sqlite3 CLI helpers ───────────────────────────────────────────────────────
// We can't load better-sqlite3 on the host, so writes go through the `sqlite3` CLI
// (TEXT values single-quote-escaped). The canonical, tested SQL lives in
// backend/src/servers/store.js — keep these in sync.
const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
// Set the busy timeout with the `.timeout` DOT-COMMAND, run before the SQL via -cmd.
// NOT `PRAGMA busy_timeout=N;` prefixed onto the SQL: that pragma EMITS its value as
// a result row, which in `-json` mode pollutes querySql() with a phantom {timeout:N}
// row (and concatenates a second JSON array onto real results, breaking JSON.parse).
const TIMEOUT_ARGS = ['-cmd', '.timeout 5000'];
// `-bail` aborts the script on the FIRST error instead of plowing on to later
// statements. Our multi-statement writes are wrapped in BEGIN…COMMIT, so if an
// INSERT fails (e.g. a NULL into a NOT NULL column) -bail stops BEFORE the COMMIT,
// leaving the transaction to roll back rather than partially commit a sibling
// statement. Defense-in-depth behind recordJoin's explicit null-game guard. It does
// not affect the normal `.timeout` dot-command or `-json` output paths.
const BAIL = '-bail';

async function runSql(sql) {
  await execFileP('sqlite3', [BAIL, ...TIMEOUT_ARGS, DB, sql]);
}
async function querySql(sql) {
  const { stdout } = await execFileP('sqlite3', [BAIL, '-json', ...TIMEOUT_ARGS, DB, sql]);
  return stdout.trim() ? JSON.parse(stdout) : [];
}

// Fail fast if the host `sqlite3` predates the features we depend on: `-json`
// output (>= 3.33) and the `unixepoch()` function (>= 3.38). Unlike the app
// (better-sqlite3 bundles a modern engine) the collector uses the host CLI, whose
// version is whatever the keeper's distro ships — the same class of host-tool
// version trap as the rclone 1.60-vs-1.66 R2 issue. 3.38 covers both.
async function assertSqliteVersion() {
  let raw = '';
  try { ({ stdout: raw } = await execFileP('sqlite3', ['--version'])); }
  catch { log('FATAL: `sqlite3` CLI not found on host (required by the collector)'); process.exit(1); }
  const ver = raw.trim().split(/\s+/)[0] || '';
  const [maj = 0, min = 0] = ver.split('.').map(Number);
  if (maj < 3 || (maj === 3 && min < 38)) {
    log(`FATAL: host sqlite3 ${ver} is too old; need >= 3.38 (unixepoch(), -json output)`);
    process.exit(1);
  }
  log(`sqlite3 ${ver} OK`);
}

// Resolve a hosted game's slug → games.id, or null if it isn't seeded yet. The app
// seeds the `games` table (hosted=1) from the registry on boot; if the collector
// raced ahead of that, the id is still null. Positive results are cached (the id is
// stable once seeded); a null is NOT cached, so a later poll re-resolves it.
const gidCache = new Map();
async function gameIdFor(slug) {
  if (gidCache.has(slug)) return gidCache.get(slug);
  const rows = await querySql(`SELECT id FROM games WHERE slug=${q(slug)} AND hosted=1;`);
  const gid = rows.length ? rows[0].id : null;
  if (gid != null) gidCache.set(slug, gid);
  return gid;
}

// Open a session (snapshotting the join). When the player has a uid (not
// CS2-redacted), upsert the global `players` roster first and link the session.
// Runs as ONE sqlite3 invocation (= one connection): wrapped in a transaction for
// atomicity and ending in `SELECT last_insert_rowid()` so we can return the new
// session id (the CLI can't otherwise report it) — callers track that id directly
// instead of re-reading the row by name (which mis-handles duplicate names).
//
// Mirrors store.js recordJoin: resolve the hosted game_id FIRST and bail if null,
// returning without touching the DB. The old inline `game_id=(SELECT …)` inserted a
// possibly-NULL gid into the NOT NULL server_sessions.game_id, which on an unseeded
// DB both threw AND orphaned a `players` row (the player upsert had already committed
// in an earlier statement). Resolving first keeps it graceful and side-effect-free.
async function recordJoin(slug, p, ts, source) {
  const gid = await gameIdFor(slug);
  if (gid == null) { log(`${slug}: not a seeded hosted game — skipping join for ${p.name}`); return null; }
  let playerSql = '';
  let playerId = 'NULL';
  if (p.uid != null) {
    playerSql = `INSERT INTO players (identity_kind, uid, name) VALUES (${q(p.identityKind)}, ${q(p.uid)}, ${q(p.name)})
      ON CONFLICT(identity_kind, uid) DO UPDATE SET name=excluded.name, last_seen=unixepoch();`;
    playerId = `(SELECT id FROM players WHERE identity_kind=${q(p.identityKind)} AND uid=${q(p.uid)})`;
  }
  const rows = await querySql(
    'BEGIN IMMEDIATE;' +
    playerSql +
    `INSERT INTO server_sessions (game_id, player_id, identity_kind, uid, name, joined_at, source)
       VALUES (${gid}, ${playerId}, ${q(p.identityKind)}, ${q(p.uid)}, ${q(p.name)}, ${ts}, ${q(source)});` +
    'SELECT last_insert_rowid() AS id;' +
    'COMMIT;',
  );
  return rows.length ? rows[rows.length - 1].id : null;
}
async function closeSession(id, ts) {
  await runSql(`UPDATE server_sessions SET left_at=${ts} WHERE id=${id} AND left_at IS NULL;`);
}
// Close a game's still-open sessions (collector/container restart — real leave
// time unknowable). `slug` omitted = all games (startup reconciliation).
async function reconcile(slug, ts) {
  const where = slug
    ? `game_id=(SELECT id FROM games WHERE slug=${q(slug)} AND hosted=1) AND left_at IS NULL`
    : 'left_at IS NULL';
  await runSql(`UPDATE server_sessions SET left_at=${ts}, source='reconciled' WHERE ${where};`);
}
async function openSessionsFor(slug) {
  return querySql(
    `SELECT id, uid, name FROM server_sessions
      WHERE game_id=(SELECT id FROM games WHERE slug=${q(slug)} AND hosted=1) AND left_at IS NULL;`,
  );
}

// ── docker helpers ────────────────────────────────────────────────────────────
async function dockerInspect(container, fmt) {
  try {
    const { stdout } = await execFileP('docker', ['inspect', '-f', fmt, container]);
    return stdout.trim();
  } catch { return ''; }
}
const isRunning = async (c) => (await dockerInspect(c, '{{.State.Running}}')) === 'true';
// First non-empty bridge IP — the host can route to it for RCON.
const containerIp = (c) =>
  dockerInspect(c, '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}').then((s) => s.split(' ').filter(Boolean)[0] || '');

// Cache the bridge IP per container so a steady-state poll tick doesn't spawn a
// `docker inspect` every 60s just to re-derive an IP that only changes on a restart.
// `prevRunning` tracks the last observed run state; we re-resolve the IP only when the
// container transitions back to running (false→true), i.e. a restart may have changed
// it, or when we have no cached IP yet. Keyed by container name.
const ipCache = new Map(); // container → { prevRunning, ip }
async function cachedContainerIp(container, running) {
  let e = ipCache.get(container);
  if (!e) { e = { prevRunning: false, ip: '' }; ipCache.set(container, e); }
  if (running && (!e.prevRunning || !e.ip)) e.ip = await containerIp(container);
  e.prevRunning = running;
  return running ? e.ip : '';
}

// ── log-tailed games (Minecraft, Factorio) ────────────────────────────────────
// Event-driven: maintain an in-memory name→sessionId map of the currently-open
// sessions for this game. `docker logs --tail=0` only shows NEW lines, so a player
// already online when the collector starts isn't seen until they rejoin (accepted).
function startLogTail(server) {
  const { id: slug, container, identityKind } = server;
  // name → open session id. Keyed by name because that's all a join/leave log line
  // carries; for these two games the name is effectively unique per live connection
  // (Minecraft online-mode rejects duplicate usernames; one Factorio account = one
  // connection), so the same-name guard below is safe.
  const open = new Map();
  const pendingUuid = new Map(); // Minecraft: name → uuid seen just before join
  const parse = slug === 'minecraft' ? parseMinecraftLog : parseFactorioLog;

  const spawnTail = async () => {
    if (!(await isRunning(container))) { setTimeout(spawnTail, 5_000); return; }
    await reconcile(slug, nowSec()).catch((e) => log(`${slug}: reconcile failed`, e.message));
    open.clear(); pendingUuid.clear();
    log(`${slug}: tailing docker logs`);

    const child = spawn('docker', ['logs', '-f', '-t', '--tail=0', container]);
    // Serialize event handling: handleEvent's check-then-act on the in-memory `open`
    // map is async (it awaits recordJoin), so dispatching events fire-and-forget would
    // interleave a join+leave from the same chunk — dropping the leave (session stuck
    // open) or double-opening. Chain each event onto a single per-stream promise so
    // they apply in log order. Parsing stays synchronous; only the DB writes serialize.
    let queue = Promise.resolve();
    const processLine = (raw) => {
      if (!raw.trim()) return;
      // Strip the `docker logs -t` RFC3339 prefix → accurate event timestamp.
      const sp = raw.indexOf(' ');
      const ts = Math.floor((Date.parse(raw.slice(0, sp)) || Date.now()) / 1000);
      const ev = parse(raw.slice(sp + 1));
      if (!ev) return;
      queue = queue.then(() => handleEvent(ev, ts)).catch((e) => log(`${slug}: write failed`, e.message));
    };
    // Stream chunks are arbitrary byte boundaries — buffer a partial trailing line
    // across 'data' events so a join/leave split across a chunk boundary isn't lost.
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        processLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', () => {}); // docker logs noise
    child.on('exit', () => {
      // Flush any residual partial line (a last event with no trailing newline) before
      // respawning, so a leave emitted right as the stream closed isn't dropped.
      if (buf) { processLine(buf); buf = ''; }
      log(`${slug}: log stream ended; respawning`);
      setTimeout(spawnTail, 3_000);
    });
  };

  const handleEvent = async (ev, ts) => {
    if (ev.kind === 'uuid') { pendingUuid.set(ev.name, ev.uuid); return; }
    if (ev.kind === 'join') {
      if (open.has(ev.name)) return; // already tracked
      const uid = slug === 'minecraft' ? (pendingUuid.get(ev.name) ?? null) : ev.name;
      pendingUuid.delete(ev.name);
      const id = await recordJoin(slug, { name: ev.name, uid, identityKind }, ts, 'log');
      if (id != null) open.set(ev.name, id);
      return;
    }
    if (ev.kind === 'leave') {
      const id = open.get(ev.name);
      if (id != null) { await closeSession(id, ts); open.delete(ev.name); }
    }
  };

  spawnTail();
}

// ── RCON-polled games (GMOD, Prop Hunt, CS2) ───────────────────────────────────
async function pollRcon(server) {
  const { id: slug, container, identityKind } = server;
  const running = await isRunning(container);
  if (!running) {
    // Mark down so the next running tick re-resolves the IP (a restart may change it).
    const e = ipCache.get(container);
    if (e) e.prevRunning = false;
    return;
  }
  const envKey = rconEnvKey(slug);
  const password = process.env[envKey] || '';
  if (!password) { log(`${slug}: no RCON password (${envKey}) — skipping`); return; }
  const host = await cachedContainerIp(container, running);
  if (!host) { log(`${slug}: no container IP — skipping`); return; }

  const port = server.rconPort ?? server.port;
  const output = await rconExchange({ host, port, password, command: 'status' });
  const { players, valid } = parseSourceStatus(output);

  // The three Source games are SteamID-or-skip EXCEPT CS2, whose `status` redacts the
  // SteamID (legitimately name-only → uid:null). For GMOD/Prop Hunt, DROP rows whose
  // uid is null: a player whose SteamID is briefly unresolved would otherwise be keyed
  // by name now and by SteamID once resolved, churning close+reopen. Dropping them
  // means a stable key (uid) and at worst a one-poll delay until the SteamID resolves.
  const roster = slug === 'counterstrike' ? players : players.filter((p) => p.uid != null);

  const ts = nowSec();
  // Diff key: the SteamID64 when present (GMOD/PH), else the name (CS2, name-only —
  // same-name CS2 players can't be told apart; the parser also exposes a per-row
  // `slot` reserved for that once the CS2 status format is host-validated).
  const keyOf = (e) => e.uid ?? `name:${e.name}`;
  const live = new Map(roster.map((p) => [keyOf(p), p]));
  // TODO(perf): this DB read runs every tick even when idle. Safe to skip only when
  // `valid && roster unchanged since last tick && no open rows`; left in for now to
  // keep the close logic correct (no stale in-memory map). The IP inspect — the other
  // per-tick spawn — is already cached above.
  const openRows = await openSessionsFor(slug);
  const openByKey = new Map(openRows.map((r) => [keyOf(r), r]));

  // Open/refresh anyone newly present.
  for (const [key, p] of live) {
    if (!openByKey.has(key)) await recordJoin(slug, { ...p, identityKind }, ts, 'rcon');
  }
  // Close departed players — but ONLY when this poll returned a trustworthy status
  // block (`valid`, reported by the parser: a legacy header/row or the CS2 block was
  // seen). An empty/partial response (RCON hiccup, map change, truncated multi-packet)
  // reads as valid:false, so we DON'T believe its empty roster and close+reopen every
  // session, fragmenting the history. A genuinely emptied server still returns a real
  // status block (valid:true), so its last stragglers do get closed.
  if (valid) {
    for (const [key, row] of openByKey) {
      if (!live.has(key)) await closeSession(row.id, ts);
    }
  } else if (openByKey.size) {
    log(`${slug}: status response unrecognized (${roster.length} parsed) — skipping close pass`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  log(`gt-session-tracker starting (db=${DB}, poll=${POLL_MS}ms)`);
  await assertSqliteVersion();
  await reconcile(null, nowSec()).catch((e) => log('startup reconcile failed', e.message));

  for (const s of SERVERS) {
    if (LOG_GAMES.has(s.id)) startLogTail(s);
  }

  const rconServers = SERVERS.filter((s) => RCON_GAMES.has(s.id));
  const inFlight = new Set();
  const tick = () => {
    for (const s of rconServers) {
      if (inFlight.has(s.id)) continue;
      inFlight.add(s.id);
      pollRcon(s).catch((e) => log(`${s.id}: poll failed`, e.message)).finally(() => inFlight.delete(s.id));
    }
  };
  tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => { log('fatal', e); process.exit(1); });
