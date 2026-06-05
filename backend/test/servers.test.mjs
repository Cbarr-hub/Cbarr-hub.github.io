import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { getServer, listServers } from '../src/servers/registry.js';
import { BaseConnector, normalizeStatus } from '../src/servers/connectors/base.js';
import { createServerService, ServerControlError } from '../src/servers/service.js';
import { getVar, setVar, setVars } from '../src/servers/cfgvars.js';
import { getCvar, setCvars } from '../src/servers/cvars.js';

// A fake DockerClient. It duck-types the transport surface the connectors consume
// (statusCurrent / start / stop / shutdown / reboot / agentExec / agentExecStatus /
// agentFileRead / agentFileWrite / nodeStatus), records calls, and returns canned
// data — no containers, no RCON sockets. `files` backs agentFileRead/Write by path.
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
    start: rec('start'),
    stop: rec('stop'),
    shutdown: rec('shutdown'),
    reboot: rec('reboot'),
    agentExec: overrides.agentExec ?? (() => Promise.resolve({ pid: 'p' })),
    agentExecStatus: overrides.agentExecStatus
      ?? (() => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' })),
    agentFileRead: overrides.agentFileRead ?? ((_c, path) => Promise.resolve({ content: files[path] ?? '' })),
    agentFileWrite: overrides.agentFileWrite ?? ((_c, path, content) => { files[path] = content; return Promise.resolve(null); }),
  };
}

// In-memory DB with all migrations applied (backs the connector store).
function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);
  runMigrations(db);
  return db;
}

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
  const svc = createServerService({});
  assert.equal(svc.isConfigured(), false);
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

test('CS config library: CRUD + unique name + validation', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), db: testDb() });
  const c = await svc.createConfig('counterstrike', { name: 'bunnyhop', body: 'sv_autobunnyhopping 1\n' });
  assert.ok(c.id > 0);
  assert.equal((await svc.getConfig('counterstrike', c.id)).body, 'sv_autobunnyhopping 1\n');

  const u = await svc.updateConfig('counterstrike', c.id, { body: 'sv_autobunnyhopping 0\n' });
  assert.equal(u.name, 'bunnyhop');            // unchanged
  assert.equal(u.body, 'sv_autobunnyhopping 0\n');
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

// ── BaseConnector defaults ──────────────────────────────────────────────────────
test('a base server reports live unavailable and has no quick settings', async () => {
  const base = new BaseConnector({ id: 'x', name: 'X', vmid: 1 }, fakeDocker());
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

test('a launch URL needs a public host', async () => {
  const svc = createServerService({ dockerClient: fakeDocker(), publicHost: '' });
  const cs = (await svc.listServers()).find((s) => s.id === 'counterstrike');
  assert.equal(cs.connect.launch, null);
});
