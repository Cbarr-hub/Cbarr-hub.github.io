import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';
import { connectString, getServer, launchUrl, listServers } from '../src/servers/registry.js';
import { GameConnector, normalizeStatus } from '../src/servers/connectors/engine.js';
import { createServerService, ServerControlError } from '../src/servers/service.js';
import { createServerStore } from '../src/servers/store.js';
import { getVar, setVar, setVars, getCvar, setCvars } from '../src/servers/line-config.js';

// A fake DockerClient. It duck-types the transport surface the connectors consume
// (statusCurrent / start / stop / shutdown / reboot / exec / fileRead / fileWrite /
// nodeStatus), records calls, and returns canned data — no containers, no RCON
// sockets. `files` backs fileRead/fileWrite by path.
//
// This file exercises the backend-agnostic SERVICE layer (orchestration, registry,
// whitelist, DB-backed catalog/config, connect strings). The Docker connectors'
// own behaviour (profile round-trips, RCON-over-TCP gating, container lifecycle) is
// covered in docker-*.test.mjs.
function fakeDocker(overrides = {}) {
  const calls = [];
  const files = overrides.files ?? {};
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    files,
    statusCurrent: overrides.statusCurrent ?? ((c) => {
      calls.push(['statusCurrent', c]);
      return Promise.resolve({ status: 'running', uptime: 3600, cpu: 0.05, mem: 100, maxmem: 2000 });
    }),
    nodeStatus: overrides.nodeStatus ?? (() => Promise.resolve({
      name: 'keeper', engineVersion: '26.0', os: 'Debian', kernel: '6.x',
      ncpu: 4, memTotal: 12e9, containers: 8, containersRunning: 8,
    })),
    containerLogs: overrides.containerLogs ?? ((c) => {
      calls.push(['containerLogs', c]);
      return Promise.resolve("[21:59:08 INFO] updating map 'nether': 45.11% (ETA: 49 minutes)\n");
    }),
    start: rec('start'),
    stop: rec('stop'),
    shutdown: rec('shutdown'),
    reboot: rec('reboot'),
    exec: overrides.exec
      ?? (() => Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false })),
    fileRead: overrides.fileRead ?? ((_c, path) => Promise.resolve({ content: files[path] ?? '', truncated: false })),
    fileWrite: overrides.fileWrite ?? ((_c, path, content) => { files[path] = content; return Promise.resolve(null); }),
  };
}

// In-memory DB with all migrations applied (backs the connector store).
// ── registry ──────────────────────────────────────────────────────────────────
test('registry maps ids to their containers (all docker-backed)', () => {
  assert.equal(getServer('counterstrike').container, 'counterstrike');
  assert.equal(getServer('factorio').container, 'factorio');
  assert.equal(getServer('minecraft').container, 'minecraft');
  assert.equal(getServer('gmod').container, 'gmod');
  assert.equal(getServer('prophunt').container, 'prophunt');
  assert.ok(listServers().every((s) => s.backend === 'docker'));
  assert.equal(getServer('nope'), undefined);
  assert.equal(listServers().length, 5);
});

// ── status normalization ────────────────────────────────────────────────────────
test('normalizeStatus maps the qemu/container status payload to a stable shape', () => {
  assert.equal(normalizeStatus({ status: 'running', uptime: 10 }).status, 'running');
  assert.equal(normalizeStatus({ status: 'stopped' }).status, 'stopped');
  assert.equal(normalizeStatus({ status: 'paused' }).status, 'unknown');
  assert.equal(normalizeStatus(null).status, 'unknown');
});

// ── service: not configured ──────────────────────────────────────────────────────
test('service without a docker client reports not-configured', async () => {
  const svc = createServerService({ dockerClient: null });
  await assert.rejects(() => svc.listServers(), (e) =>
    e instanceof ServerControlError && e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => svc.doAction('factorio', 'start'), (e) => e.code === 'NOT_CONFIGURED');
});

// ── service: list + status ──────────────────────────────────────────────────────
test('listServers returns every server with normalized status', async () => {
  const svc = createServerService({ dockerClient: fakeDocker() });
  const list = await svc.listServers();
  assert.equal(list.length, 5);
  assert.ok(list.every((s) => s.status === 'running'));
  // a single-purpose game container that's running == hosting
  assert.ok(list.every((s) => s.gameStatus === 'hosting'));
  // the internal container locator is never leaked to the API
  assert.ok(list.every((s) => s.vmid === undefined && s.container === undefined));
});

test('listServers quick mode skips per-container stats', async () => {
  const seen = [];
  const svc = createServerService({ dockerClient: fakeDocker({
    statusCurrent: (c, opts) => {
      seen.push([c, opts]);
      return Promise.resolve({ status: 'running', uptime: 10, cpu: opts?.stats === false ? null : 0.2, mem: 50, maxmem: 100 });
    },
  }) });
  const quick = await svc.listServers({ mode: 'quick' });
  assert.equal(quick.length, 5);
  assert.ok(seen.every(([, opts]) => opts?.stats === false));
  assert.ok(quick.every((s) => s.cpu == null));
});

test('listServers captures per-server errors without failing the whole list', async () => {
  const svc = createServerService({ dockerClient: fakeDocker({
    statusCurrent: (c) => c === 'factorio'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ status: 'stopped' }),
  }) });
  const list = await svc.listServers();
  const f = list.find((s) => s.id === 'factorio');
  assert.equal(f.status, 'unknown');
  assert.match(f.error, /boom/);
});

// ── node dashboard (docker host/engine facts) ────────────────────────────────────
test('getNodeStatus returns the docker host/engine facts', async () => {
  const svc = createServerService({ dockerClient: fakeDocker() });
  const n = await svc.getNodeStatus();
  assert.equal(n.kind, 'docker');
  assert.equal(n.ncpu, 4);
  assert.equal(n.containersRunning, 8);
});

test('getNodeStatus without a client reports not-configured', async () => {
  const svc = createServerService({});
  await assert.rejects(() => svc.getNodeStatus(), (e) =>
    e instanceof ServerControlError && e.code === 'NOT_CONFIGURED');
});

test('getBlueMapStatus parses the bluemap container render log', async () => {
  const client = fakeDocker();
  const svc = createServerService({ dockerClient: client });
  const status = await svc.getBlueMapStatus();
  assert.equal(status.container, 'bluemap');
  assert.equal(status.state, 'rendering');
  assert.equal(status.map, 'nether');
  assert.equal(status.percent, 45.1);
  assert.deepEqual(client.calls.at(-1), ['containerLogs', 'bluemap']);
});

// ── service: power actions ──────────────────────────────────────────────────────
test('doAction dispatches to the right client method using the container locator', async () => {
  const client = fakeDocker();
  const svc = createServerService({ dockerClient: client });
  await svc.doAction('minecraft', 'shutdown');
  assert.deepEqual(client.calls.at(-1), ['shutdown', 'minecraft']);
});

test('doAction rejects unknown actions and unknown servers', async () => {
  const svc = createServerService({ dockerClient: fakeDocker() });
  await assert.rejects(() => svc.doAction('factorio', 'selfdestruct'), (e) => e.code === 'BAD_ACTION');
  await assert.rejects(() => svc.doAction('halflife', 'start'), (e) => e.code === 'UNKNOWN_SERVER');
});

// ── service: config (whitelist) ──────────────────────────────────────────────────
test('config read/write only allows whitelisted files', async () => {
  const client = fakeDocker({ files: { '/data/server.properties': 'level-name=world\n' } });
  const svc = createServerService({ dockerClient: client });

  const { files } = svc.listConfig('minecraft');
  assert.ok(files.includes('server.properties'));

  const read = await svc.readConfig('minecraft', 'server.properties');
  assert.equal(read.content, 'level-name=world\n');

  await assert.rejects(() => svc.readConfig('minecraft', '/etc/shadow'), (e) => e.code === 'UNKNOWN_CONFIG');
});

// ── cfgvars helper (LinuxGSM shell-style cfg) ────────────────────────────────────
test('cfgvars reads, replaces, and appends shell-style assignments', () => {
  const text = 'gslt=""\nstartmap="de_anubis"\nmaxplayers="10"\n';
  assert.equal(getVar(text, 'startmap'), 'de_anubis');
  assert.equal(getVar(text, 'maxplayers'), '10');
  assert.equal(getVar(text, 'missing'), undefined);

  const replaced = setVar(text, 'startmap', 'de_dust2');
  assert.equal(getVar(replaced, 'startmap'), 'de_dust2');
  assert.match(replaced, /maxplayers="10"/); // others untouched

  const appended = setVar(text, 'newvar', 'x');
  assert.equal(getVar(appended, 'newvar'), 'x');

  const multi = setVars(text, { startmap: 'de_nuke', maxplayers: '12' });
  assert.equal(getVar(multi, 'startmap'), 'de_nuke');
  assert.equal(getVar(multi, 'maxplayers'), '12');
});

// ── cvars helper (Source-engine cfg) ──────────────────────────────────────────────
test('cvars reads/sets Source cfg cvars without matching prefix collisions', () => {
  const cfg = 'map "de_anubis"\nmapcyclefile "mapcycle.txt"\nhost_workshop_map "3071005299"\ngame_alias "competitive"\n';
  assert.equal(getCvar(cfg, 'map'), 'de_anubis');               // not "mapcyclefile"
  assert.equal(getCvar(cfg, 'host_workshop_map'), '3071005299');
  assert.equal(getCvar(cfg, 'absent'), undefined);
  const out = setCvars(cfg, { map: 'de_nuke', host_workshop_map: '' });
  assert.equal(getCvar(out, 'map'), 'de_nuke');
  assert.equal(getCvar(out, 'host_workshop_map'), '');
  assert.match(out, /mapcyclefile "mapcycle.txt"/);             // untouched
});

// ── CS workshop catalog + config library (DB-backed, via the docker connector) ───
test('CS map catalog: add, rename, delete via the service', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  assert.ok((await svc.listMaps('counterstrike')).some((m) => m.workshopId === '3071005299')); // seed

  const added = await svc.addMap('counterstrike', { workshopId: '555', name: 'Mirage WS' });
  assert.equal(added.name, 'Mirage WS');
  const renamed = await svc.renameMap('counterstrike', '555', 'Mirage WS2');
  assert.equal(renamed.name, 'Mirage WS2');
  await svc.deleteMap('counterstrike', '555');
  assert.equal((await svc.listMaps('counterstrike')).some((m) => m.workshopId === '555'), false);

  await assert.rejects(async () => svc.addMap('counterstrike', { workshopId: 'abc', name: 'x' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svc.renameMap('counterstrike', 'nope', 'x'), (e) => e.code === 'NOT_FOUND');
});

test('CS config library: create/get/list/delete + unique name + validation', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  const c = await svc.createConfig('counterstrike', { name: 'bunnyhop', body: 'sv_autobunnyhopping 1\n' });
  assert.ok(c.id > 0);
  assert.equal((await svc.getConfig('counterstrike', c.id)).body, 'sv_autobunnyhopping 1\n');
  assert.ok((await svc.listConfigs('counterstrike')).some((x) => x.name === 'bunnyhop'));

  await assert.rejects(async () => svc.createConfig('counterstrike', { name: 'bunnyhop', body: '' }), (e) => e.code === 'BAD_SETTING'); // dup
  await assert.rejects(async () => svc.createConfig('counterstrike', { name: 'bad name!', body: '' }), (e) => e.code === 'BAD_SETTING'); // chars

  await svc.deleteConfig('counterstrike', c.id);
  await assert.rejects(async () => svc.getConfig('counterstrike', c.id), (e) => e.code === 'NOT_FOUND');
});

test('non-CS servers reject catalog + config ops as unsupported', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  await assert.rejects(async () => svc.listMaps('factorio'), (e) => e.code === 'NOT_SUPPORTED');
  await assert.rejects(async () => svc.listConfigs('minecraft'), (e) => e.code === 'NOT_SUPPORTED');
});

// ── live control gating (these paths never open an RCON socket) ──────────────────
test('CS live control gates on CS2_RCON_PASSWORD', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  delete process.env.CS2_RCON_PASSWORD;
  assert.equal((await svc.getLive('counterstrike')).available, false);

  process.env.CS2_RCON_PASSWORD = 'secret';
  const live = await svc.getLive('counterstrike');
  assert.equal(live.available, true);
  assert.equal(live.changeMap, true);
  assert.ok(Array.isArray(live.actions) && live.actions.length > 0);
  delete process.env.CS2_RCON_PASSWORD;
});

test('CS sendCommand + runLiveAction reject bad input before opening a socket', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  await assert.rejects(async () => svc.sendCommand('counterstrike', ''), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svc.sendCommand('counterstrike', 'a\nb'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svc.runLiveAction('counterstrike', 'nope'), (e) => e.code === 'BAD_SETTING');
});

test('Factorio live availability reflects the rcon password file', async () => {
  const off = createServerService({ dockerClient: fakeDocker() });
  assert.equal((await off.getLive('factorio')).available, false); // no rconpw file

  const on = createServerService({ dockerClient: fakeDocker({
    files: { '/factorio/config/rconpw': 'sekret\n' },
  }) });
  assert.equal((await on.getLive('factorio')).available, true);
});

test('Factorio Quick Settings exposes the Save-As operation', async () => {
  const svc = createServerService({ dockerClient: fakeDocker() });
  const s = await svc.getSettings('factorio');
  assert.deepEqual(s.sections.map((sec) => sec.key), ['saveAs']);
});

test('Minecraft live control gates on MINECRAFT_RCON_PASSWORD', async () => {
  const svc = createServerService({ dockerClient: fakeDocker() });
  delete process.env.MINECRAFT_RCON_PASSWORD;
  assert.equal((await svc.getLive('minecraft')).available, false);
  process.env.MINECRAFT_RCON_PASSWORD = 'pw';
  assert.equal((await svc.getLive('minecraft')).available, true);
  delete process.env.MINECRAFT_RCON_PASSWORD;
});

// ── engine defaults (a spec-less connector) ─────────────────────────────────────
test('a base server reports live unavailable and has no quick settings', async () => {
  const base = new GameConnector({ id: 'x', name: 'X', container: 'x' }, {}, fakeDocker());
  assert.equal((await base.getLive()).available, false);
  await assert.rejects(async () => base.sendCommand('x'), (e) => e.code === 'NO_RCON');
  assert.deepEqual(await base.getSettings(), { fields: [] });
});

// ── connection strings + launch URLs (registry + public host) ────────────────────
test('connect strings render per game from the registry + public host', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), publicHost: '1.2.3.4' });
  const list = await svc.listServers();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.connect]));
  assert.equal(byId.counterstrike.string, 'connect 1.2.3.4:27015');
  assert.equal(byId.factorio.string, '1.2.3.4:34197');
  assert.equal(byId.minecraft.string, '1.2.3.4:25565');
  assert.equal(byId.gmod.string, 'connect 1.2.3.4:27066');
});

test('launch URLs open the game + connect; Minecraft has none', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), publicHost: '1.2.3.4' });
  const list = await svc.listServers();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.connect]));
  // Source games: steam://run/<appid>//+connect host:port (args URL-encoded)
  assert.equal(byId.counterstrike.launch, 'steam://run/730//%2Bconnect%201.2.3.4%3A27015');
  assert.equal(byId.gmod.launch, 'steam://run/4000//%2Bconnect%201.2.3.4%3A27066');
  // Factorio: --mp-connect
  assert.equal(byId.factorio.launch, 'steam://run/427520//--mp-connect%201.2.3.4%3A34197');
  // Minecraft (Java) has no launch-and-connect scheme
  assert.equal(byId.minecraft.launch, null);
});

test('passworded connect strings include the password in copy and launch forms', () => {
  const cs = getServer('counterstrike');
  const factorio = getServer('factorio');
  assert.equal(connectString(cs, '1.2.3.4', 'secret'), 'password "secret"; connect 1.2.3.4:27015');
  assert.equal(launchUrl(cs, '1.2.3.4', 'secret'), 'steam://run/730//%2Bpassword%20%22secret%22%20%2Bconnect%201.2.3.4%3A27015');
  assert.equal(connectString(factorio, '1.2.3.4', 'secret'), '1.2.3.4:34197 (password: secret)');
  assert.equal(launchUrl(factorio, '1.2.3.4', 'secret'), 'steam://run/427520//--mp-connect%201.2.3.4%3A34197%20--password%20secret');
});

test('a launch URL needs a public host', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), publicHost: '' });
  const cs = (await svc.listServers()).find((s) => s.id === 'counterstrike');
  assert.equal(cs.connect.launch, null);
});

// ── live-presence overlay ────────────────────────────────────────────────────────
// The overlay (service.js: samePresencePlayer / readLivePresence / mergeLiveOnlineRows /
// computeServerList online count) surfaces players a connector reports via RCON
// `listOnlinePlayers()` even before the host session-tracker has recorded them, and
// dedups them against open host sessions. These tests inject STUB connectors through
// the service's `connectorsOverride` test seam so the overlay runs without a real
// RCON socket (the live Docker connectors hit rcon-tcp, covered in docker-*.test.mjs).

// A deterministic stub connector. `players` is what listOnlinePlayers() reports while
// "running"; power actions flip `running` (a stopped server reports nobody online).
// `getPlayerPosition` is taken from the override (omit it entirely to exercise the
// NOT_SUPPORTED path). Tracks call counts so a test can assert re-poll behaviour.
function stubConnector({ players = [], running = true, getPlayerPosition, listOnlinePlayers } = {}) {
  const state = { running };
  const calls = { listOnlinePlayers: 0, getPlayerPosition: 0 };
  const conn = {
    state,
    calls,
    async status() {
      return state.running
        ? { status: 'running', gameStatus: 'hosting' }
        : { status: 'stopped', gameStatus: 'offline' };
    },
    async listOnlinePlayers() {
      calls.listOnlinePlayers += 1;
      if (listOnlinePlayers) return listOnlinePlayers(calls.listOnlinePlayers, state);
      return state.running ? players.map((p) => ({ ...p })) : [];
    },
    async start()    { state.running = true; },
    async stop()     { state.running = false; },
    async shutdown() { state.running = false; },
    async reboot()   { state.running = true; },
  };
  if (getPlayerPosition) {
    conn.getPlayerPosition = async (...args) => { calls.getPlayerPosition += 1; return getPlayerPosition(...args); };
  }
  return conn;
}

// Build a service whose `minecraft` server is backed by `conn` (other servers have no
// connector, which is fine — the overlay skips them). Optional db backs host sessions.
function svcWithMinecraft(conn, { db } = {}) {
  return createServerService({ db, connectorsOverride: new Map([['minecraft', conn]]) });
}

// Open a host session for `slug` directly via the store (the same canonical write the
// host collector mirrors), so the overlay has a real session row to dedup against.
function seedOpenSession(db, slug, { identityKind, uid = null, name }, joinedAt = 1_000) {
  return createServerStore(db).recordJoin(slug, { identityKind, uid, name }, joinedAt, 'log');
}

test('overlay: tile online count equals the deduplicated /online roster (Finding A)', async () => {
  // Host session for Alice + a DIFFERENT live player Bob → the union is 2. The old
  // Math.max(|host|=1, |live|=1) under-reported as 1. (Build the service first so it
  // seeds the hosted `games` rows the session insert FKs to.)
  const db = testDb();
  const svc = svcWithMinecraft(stubConnector({ players: [{ name: 'Bob' }] }), { db });
  seedOpenSession(db, 'minecraft', { identityKind: 'minecraft', uid: 'uuid-alice', name: 'Alice' });

  const roster = await svc.listOnline();
  const tiles = await svc.listServers({ mode: 'quick' });
  const mcOnline = roster.filter((r) => r.slug === 'minecraft').length;
  assert.equal(mcOnline, 2);
  assert.equal(tiles.find((t) => t.id === 'minecraft').online, mcOnline);
});

test('overlay: a live player matching a host session by name is not double-counted (Finding A)', async () => {
  // Host session for Bob AND a live player Bob (same name) → the badge stays 1.
  const db = testDb();
  const svc = svcWithMinecraft(stubConnector({ players: [{ name: 'Bob' }] }), { db });
  seedOpenSession(db, 'minecraft', { identityKind: 'minecraft', uid: 'uuid-bob', name: 'Bob' });

  const roster = await svc.listOnline();
  const tiles = await svc.listServers({ mode: 'quick' });
  assert.equal(roster.filter((r) => r.slug === 'minecraft').length, 1);
  assert.equal(tiles.find((t) => t.id === 'minecraft').online, 1);
});

test('overlay: a transient listOnlinePlayers() failure preserves live joined_at (Finding B)', async () => {
  // dheagman is live-only (no host session). The poll succeeds on calls 1 & 3 but
  // throws on call 2. With Date.now stubbed we advance past LIVE_PRESENCE_TTL_MS
  // between ticks so each listOnline() re-polls. The failed tick must NOT rewind the
  // first-seen time: tick 3 must still show the tick-1 join time.
  const realNow = Date.now;
  let clock = 5_000_000; // ms; Math.floor(clock/1000) is the unix-seconds joined_at
  Date.now = () => clock;
  try {
    const conn = stubConnector({
      listOnlinePlayers: (n) => {
        if (n === 2) throw new Error('rcon timeout');
        return [{ name: 'dheagman', uid: null }];
      },
    });
    const svc = svcWithMinecraft(conn); // no db → live-only

    const t1 = Math.floor(clock / 1000);
    const tick1 = await svc.listOnline();
    const row1 = tick1.find((r) => r.slug === 'minecraft' && r.name === 'dheagman');
    assert.ok(row1, 'tick 1 surfaces dheagman');
    assert.equal(row1.joined_at, t1);

    clock += 2_000;            // expire the 1s live-presence cache → re-poll (throws)
    const tick2 = await svc.listOnline();
    assert.equal(tick2.find((r) => r.slug === 'minecraft' && r.name === 'dheagman'), undefined,
      'failed poll emits no live row that cycle');

    clock += 2_000;            // expire again → re-poll (succeeds)
    const tick3 = await svc.listOnline();
    const row3 = tick3.find((r) => r.slug === 'minecraft' && r.name === 'dheagman');
    assert.ok(row3, 'tick 3 surfaces dheagman again');
    assert.equal(row3.joined_at, t1, 'join time is preserved, not rewound to t3');
    assert.equal(conn.calls.listOnlinePlayers, 3);
  } finally {
    Date.now = realNow;
  }
});

test('overlay: clearStatusCache drops the live-presence cache (Finding C)', async () => {
  const conn = stubConnector({ players: [{ name: 'Steve' }] });
  const svc = svcWithMinecraft(conn);

  const warm = await svc.listServers({ mode: 'quick' });
  assert.equal(warm.find((t) => t.id === 'minecraft').online, 1);
  assert.equal(conn.calls.listOnlinePlayers, 1);

  // Stopping the server mutates state → clearStatusCache() must drop the cached live
  // presence so the very next list re-polls (now reporting nobody) instead of serving
  // the stale online>0 for up to LIVE_PRESENCE_TTL_MS.
  await svc.doAction('minecraft', 'stop');
  const after = await svc.listServers({ mode: 'quick' });
  assert.equal(conn.calls.listOnlinePlayers, 2, 'live presence was re-polled, not served stale');
  const mc = after.find((t) => t.id === 'minecraft');
  assert.equal(mc.online, 0);
  assert.equal(mc.status, 'stopped');
});

test('overlay: a live-only player surfaces as a synthetic live roster row (Finding D)', async () => {
  const svc = svcWithMinecraft(stubConnector({ players: [{ name: 'Notch' }] }));
  const roster = await svc.listOnline();
  const row = roster.find((r) => r.name === 'Notch');
  assert.ok(row, 'Notch appears in the roster');
  assert.equal(row.id, 'live:minecraft:Notch');
  assert.equal(row.source, 'live');
  assert.equal(row.live, true);
  assert.equal(row.slug, 'minecraft');
});

test('overlay: a live player matching an open host session (name or uid) is deduped (Finding D)', async () => {
  // Open host session for steve / uuid-steve. A live row that matches by uid is NOT
  // duplicated; nor is one that matches by case-insensitive name.
  // Build the service FIRST so it seeds the hosted `games` rows recordJoin FKs to
  // (seeding before the service makes recordJoin a no-op → no host row to dedup against).
  const dbByUid = testDb();
  const byUid = svcWithMinecraft(
    stubConnector({ players: [{ name: 'someone-else', uid: 'uuid-steve' }] }), { db: dbByUid });
  seedOpenSession(dbByUid, 'minecraft', { identityKind: 'minecraft', uid: 'uuid-steve', name: 'Steve' });
  const rosterUid = await byUid.listOnline();
  assert.equal(rosterUid.filter((r) => r.slug === 'minecraft').length, 1, 'uid match → no duplicate');
  assert.equal(rosterUid.some((r) => r.source === 'live'), false);

  const dbByName = testDb();
  const byName = svcWithMinecraft(
    stubConnector({ players: [{ name: 'sTeVe', uid: null }] }), { db: dbByName });
  seedOpenSession(dbByName, 'minecraft', { identityKind: 'minecraft', uid: 'uuid-steve', name: 'Steve' });
  const rosterName = await byName.listOnline();
  assert.equal(rosterName.filter((r) => r.slug === 'minecraft').length, 1, 'case-insensitive name match → no duplicate');
  assert.equal(rosterName.some((r) => r.source === 'live'), false);
});

test('getOnlinePlayerPositionByName: NOT_FOUND when absent, online when present (Finding D)', async () => {
  const svc = svcWithMinecraft(stubConnector({
    players: [{ name: 'Steve' }],
    getPlayerPosition: (target) => ({ name: target, x: 1, y: 64, z: 2, connected: true }),
  }));

  await assert.rejects(
    () => svc.getOnlinePlayerPositionByName('minecraft', 'Ghost'),
    (e) => e instanceof ServerControlError && e.code === 'NOT_FOUND');

  const present = await svc.getOnlinePlayerPositionByName('minecraft', 'Steve');
  assert.equal(present.online, true);
  assert.equal(present.position.x, 1);
});

test('getOnlinePlayerPositionByName: online=false + reason when position is disconnected (Finding D/E)', async () => {
  const svc = svcWithMinecraft(stubConnector({
    players: [{ name: 'Steve' }],
    getPlayerPosition: () => ({ connected: false, reason: 'player left mid-lookup' }),
  }));
  const res = await svc.getOnlinePlayerPositionByName('minecraft', 'Steve');
  assert.equal(res.online, false);
  assert.equal(res.reason, 'player left mid-lookup');
});

test('getOnlinePlayerPosition: NOT_FOUND for a missing session, NOT_SUPPORTED without getPlayerPosition (Finding D)', async () => {
  // No matching open session → openSessionById returns null → NOT_FOUND.
  const dbMissing = testDb();
  const missing = svcWithMinecraft(stubConnector({ players: [] }), { db: dbMissing });
  await assert.rejects(
    () => missing.getOnlinePlayerPosition('minecraft', 12345),
    (e) => e instanceof ServerControlError && e.code === 'NOT_FOUND');

  // An open session exists, but the connector exposes no getPlayerPosition → NOT_SUPPORTED.
  const dbHasSession = testDb();
  const unsupported = svcWithMinecraft(stubConnector({ players: [] }), { db: dbHasSession }); // build first → seeds hosted games
  const sessionId = seedOpenSession(dbHasSession, 'minecraft', { identityKind: 'minecraft', uid: 'uuid-x', name: 'Xavier' });
  await assert.rejects(
    () => unsupported.getOnlinePlayerPosition('minecraft', sessionId),
    (e) => e instanceof ServerControlError && e.code === 'NOT_SUPPORTED');
});
