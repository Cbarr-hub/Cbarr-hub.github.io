import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { getServer, listServers } from '../src/servers/registry.js';
import { BaseConnector, normalizeStatus } from '../src/servers/connectors/base.js';
import { createServerService, ServerControlError } from '../src/servers/service.js';
import { getVar, setVar, setVars } from '../src/servers/cfgvars.js';
import { getCvar, setCvars } from '../src/servers/cvars.js';

// A fake ProxmoxClient: records calls, returns canned data. No network.
function fakeClient(overrides = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    statusCurrent: overrides.statusCurrent ?? ((vmid) => {
      calls.push(['statusCurrent', vmid]);
      return Promise.resolve({ status: 'running', uptime: 3600 });
    }),
    start: rec('start'),
    stop: rec('stop'),
    shutdown: rec('shutdown'),
    reboot: rec('reboot'),
    agentExec: overrides.agentExec ?? (() => Promise.resolve({ pid: 1 })),
    agentExecStatus: overrides.agentExecStatus
      ?? (() => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'ok' })),
    agentFileRead: overrides.agentFileRead
      ?? (() => Promise.resolve({ content: 'hello=world\n', truncated: false })),
    agentFileWrite: overrides.agentFileWrite ?? rec('agentFileWrite'),
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
test('registry maps ids to the documented VMIDs', () => {
  assert.equal(getServer('counterstrike').vmid, 100);
  assert.equal(getServer('factorio').vmid, 101);
  assert.equal(getServer('minecraft').vmid, 102);
  assert.equal(getServer('nope'), undefined);
  assert.equal(listServers().length, 3);
});

// ── status normalization ────────────────────────────────────────────────────────
test('normalizeStatus maps proxmox payloads to a stable shape', () => {
  assert.equal(normalizeStatus({ status: 'running', uptime: 10 }).status, 'running');
  assert.equal(normalizeStatus({ status: 'stopped' }).status, 'stopped');
  assert.equal(normalizeStatus({ status: 'paused' }).status, 'unknown');
  assert.equal(normalizeStatus(null).status, 'unknown');
});

// ── service: not configured ──────────────────────────────────────────────────────
test('service without a client reports not-configured', async () => {
  const svc = createServerService({ client: null });
  assert.equal(svc.isConfigured(), false);
  await assert.rejects(() => svc.listServers(), (e) =>
    e instanceof ServerControlError && e.code === 'NOT_CONFIGURED');
  await assert.rejects(() => svc.doAction('factorio', 'start'), (e) =>
    e.code === 'NOT_CONFIGURED');
});

// ── service: list + status ──────────────────────────────────────────────────────
test('listServers returns every server with normalized status', async () => {
  const svc = createServerService({ client: fakeClient() });
  const list = await svc.listServers();
  assert.equal(list.length, 3);
  assert.ok(list.every((s) => s.status === 'running'));
  assert.equal(list.find((s) => s.id === 'factorio').vmid, 101);
});

test('listServers captures per-server errors without failing the whole list', async () => {
  const client = fakeClient({
    statusCurrent: (vmid) => vmid === 101
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ status: 'stopped' }),
  });
  const svc = createServerService({ client });
  const list = await svc.listServers();
  const f = list.find((s) => s.id === 'factorio');
  assert.equal(f.status, 'unknown');
  assert.match(f.error, /boom/);
});

// ── service: power actions ──────────────────────────────────────────────────────
test('doAction dispatches to the right client method using the registry vmid', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });
  await svc.doAction('minecraft', 'shutdown');
  assert.deepEqual(client.calls.at(-1), ['shutdown', 102]);
});

test('doAction rejects unknown actions and unknown servers', async () => {
  const svc = createServerService({ client: fakeClient() });
  await assert.rejects(() => svc.doAction('factorio', 'selfdestruct'), (e) =>
    e.code === 'BAD_ACTION');
  await assert.rejects(() => svc.doAction('halflife', 'start'), (e) =>
    e.code === 'UNKNOWN_SERVER');
});

// ── service: config (whitelist) ──────────────────────────────────────────────────
test('config read/write only allows whitelisted files', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });

  const { files } = svc.listConfig('minecraft');
  assert.ok(files.includes('server.properties'));

  const read = await svc.readConfig('minecraft', 'server.properties');
  assert.equal(read.content, 'hello=world\n');

  await assert.rejects(() => svc.readConfig('minecraft', '/etc/shadow'), (e) =>
    e.code === 'UNKNOWN_CONFIG');
});

// ── service: update recipe ──────────────────────────────────────────────────────
test('runUpdate runs the connector recipe and returns step output', async () => {
  const client = fakeClient();
  const svc = createServerService({ client });
  const res = await svc.runUpdate('factorio');
  assert.ok(Array.isArray(res.steps));
  assert.equal(res.steps[0].exitCode, 0);
});

test('LinuxGSM update drops to the owning user via runuser and calls the instance script', async () => {
  const execCmds = [];
  const client = fakeClient({
    agentExec: (_vmid, { command }) => { execCmds.push(command); return Promise.resolve({ pid: 1 }); },
  });
  const svc = createServerService({ client });
  await svc.runUpdate('counterstrike');

  // first step = update, second = restart; both run as miles via runuser
  assert.equal(execCmds.length, 2);
  for (const cmd of execCmds) {
    assert.equal(cmd[0], '/usr/sbin/runuser');
    assert.deepEqual(cmd.slice(1, 4), ['-u', 'miles', '--']);
  }
  assert.match(execCmds[0].at(-1), /cd \/home\/miles\/csserver && \.\/cs2server update/);
  assert.match(execCmds[1].at(-1), /\.\/cs2server restart/);
});

test('Minecraft update runs the Mojang jar-swap recipe', async () => {
  const manifest = {
    latest: { release: '1.21' },
    versions: [{ id: '1.21', type: 'release', url: 'https://example.test/ver.json' }],
  };
  const versionData = { downloads: { server: { url: 'https://example.test/server.jar' } } };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('version_manifest') ? manifest : versionData),
  });
  try {
    const svc = createServerService({ client: fakeClient() });
    const res = await svc.runUpdate('minecraft');
    assert.equal(res.ok, true);
    assert.equal(res.version, '1.21');
    assert.ok(res.steps.length >= 2); // stop + download(+replace) + start
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── cfgvars helper ──────────────────────────────────────────────────────────────
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

// ── CS quick settings (game-config based) ─────────────────────────────────────────
const CS_GAME_CFG = 'hostname "LinuxGSM"\nmap "de_anubis"\nmapcyclefile "mapcycle.txt"\n' +
  'game_alias "competitive"\nhost_workshop_collection \nhost_workshop_map "3071005299"\n';
const CS_INSTANCE_CFG = 'gslt=""\nstartmap="de_anubis"\nmaxplayers="10"\n';

function csClient(onWrite) {
  const isGame = (f) => f.endsWith('/cfg/cs2server.cfg');
  return fakeClient({
    agentFileRead: (_vmid, file) => Promise.resolve({
      content: isGame(file) ? CS_GAME_CFG : CS_INSTANCE_CFG, truncated: false,
    }),
    agentFileWrite: (_vmid, file, content) => { if (onWrite) onWrite(file, content); return Promise.resolve(); },
    agentExec: () => Promise.resolve({ pid: 1 }),
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0,
      'out-data': '/maps/de_dust2.vpk\n/maps/de_anubis.vpk\n/maps/de_dust2_vanity.vpk\n/maps/lobby_mapveto.vpk\n' }),
  });
}

test('CS getSettings reflects the workshop map in effect, with catalog names', async () => {
  const svc = createServerService({ client: csClient(), db: testDb() });
  const s = await svc.getSettings('counterstrike');
  assert.equal(s.game, 'counterstrike');
  // host_workshop_map overrides the stock `map`, so the effective map is the workshop one
  assert.equal(s.map.current, 'ws:3071005299');
  assert.equal(s.gameMode.value, 'competitive');
  assert.equal(s.maxPlayers, 10);
  // Assembly comes from the seeded catalog
  assert.ok(s.map.workshop.some((w) => w.id === '3071005299' && w.name === 'Assembly'));
  // stock list comes from installed vpks, minus the _vanity entry
  assert.ok(s.map.stock.includes('de_dust2') && !s.map.stock.includes('de_dust2_vanity'));
  assert.equal(s.configs.selectedId, null); // none selected by default
});

test('CS setSettings: stock map clears the workshop override', async () => {
  const writes = {};
  const svc = createServerService({ client: csClient((f, c) => { writes[f.endsWith('/cfg/cs2server.cfg') ? 'game' : 'inst'] = c; }) });
  await svc.setSettings('counterstrike', { map: 'de_nuke', gameMode: 'deathmatch', maxPlayers: 12 });
  assert.equal(getCvar(writes.game, 'map'), 'de_nuke');
  assert.equal(getCvar(writes.game, 'host_workshop_map'), '');     // cleared
  assert.equal(getCvar(writes.game, 'game_alias'), 'deathmatch');
  assert.equal(getVar(writes.inst, 'maxplayers'), '12');
});

test('CS setSettings: workshop selection and ID override set host_workshop_map', async () => {
  let game1 = '';
  const svc1 = createServerService({ client: csClient((f, c) => { if (f.endsWith('/cfg/cs2server.cfg')) game1 = c; }) });
  await svc1.setSettings('counterstrike', { map: 'ws:123456' });
  assert.equal(getCvar(game1, 'host_workshop_map'), '123456');

  let game2 = '';
  const svc2 = createServerService({ client: csClient((f, c) => { if (f.endsWith('/cfg/cs2server.cfg')) game2 = c; }) });
  await svc2.setSettings('counterstrike', { map: 'de_dust2', workshopId: '999' }); // override wins
  assert.equal(getCvar(game2, 'host_workshop_map'), '999');
});

test('CS setSettings rejects bad values', async () => {
  const svc = createServerService({ client: csClient() });
  await assert.rejects(() => svc.setSettings('counterstrike', { gameMode: 'bogus' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { maxPlayers: 999 }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { map: 'de nuke; rm' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { workshopId: 'abc' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { hostname: 'a"b' }), (e) => e.code === 'BAD_SETTING');
});

// ── CS catalog + config library (Phase 2) ─────────────────────────────────────────
test('CS map catalog: add, rename, delete via the service', async () => {
  const svc = createServerService({ client: csClient(), db: testDb() });
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
  const svc = createServerService({ client: csClient(), db: testDb() });
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

test('CS setSettings deploys the selected config to active.cfg and execs it', async () => {
  const writes = {};
  const svc = createServerService({ client: csClient((f, c) => { writes[f] = c; }), db: testDb() });
  const cfg = await svc.createConfig('counterstrike', { name: 'bhop', body: 'sv_autobunnyhopping 1\n' });

  await svc.setSettings('counterstrike', { map: 'de_dust2', configId: cfg.id });

  const activeKey = Object.keys(writes).find((k) => k.endsWith('/cfg/gamertown/active.cfg'));
  assert.equal(writes[activeKey], 'sv_autobunnyhopping 1\n');             // body deployed
  const gameKey = Object.keys(writes).find((k) => k.endsWith('/cfg/cs2server.cfg'));
  assert.match(writes[gameKey], /^[ \t]*exec gamertown\/active[ \t]*$/m);  // exec line added
  const instKey = Object.keys(writes).find((k) => k.endsWith('/cs2server/cs2server.cfg'));
  assert.equal(getVar(writes[instKey], 'gt_active_config'), String(cfg.id)); // selection recorded
});

test('CS setSettings with configId="" clears the active config', async () => {
  const writes = {};
  const svc = createServerService({ client: csClient((f, c) => { writes[f] = c; }), db: testDb() });
  await svc.setSettings('counterstrike', { configId: '' });
  const activeKey = Object.keys(writes).find((k) => k.endsWith('/cfg/gamertown/active.cfg'));
  assert.equal(writes[activeKey], '');
  const instKey = Object.keys(writes).find((k) => k.endsWith('/cs2server/cs2server.cfg'));
  assert.equal(getVar(writes[instKey], 'gt_active_config'), '');
});

test('non-CS servers reject catalog + config ops as unsupported', async () => {
  const svc = createServerService({ client: fakeClient(), db: testDb() });
  await assert.rejects(async () => svc.listMaps('factorio'), (e) => e.code === 'NOT_SUPPORTED');
  await assert.rejects(async () => svc.listConfigs('minecraft'), (e) => e.code === 'NOT_SUPPORTED');
});

// ── live commands / RCON (Phase 3) ────────────────────────────────────────────────
const CS_GAME_CFG_RCON = CS_GAME_CFG + 'rcon_password "secret"\n';
function csClientRcon(opts = {}) {
  return fakeClient({
    agentFileRead: (_v, f) => Promise.resolve({
      content: f.endsWith('/cfg/cs2server.cfg') ? CS_GAME_CFG_RCON : CS_INSTANCE_CFG,
    }),
    agentExec: opts.agentExec,
    agentExecStatus: opts.agentExecStatus,
  });
}

test('CS getLive reflects rcon_password presence', async () => {
  const off = createServerService({ client: csClient(), db: testDb() });
  assert.equal((await off.getLive('counterstrike')).available, false);

  const on = createServerService({ client: csClientRcon(), db: testDb() });
  const live = await on.getLive('counterstrike');
  assert.equal(live.available, true);
  assert.ok(live.actions.some((a) => a.key === 'bunnyhop_on'));
});

test('CS runLiveAction sends the mapped command via rcon (argv command, stdin password)', async () => {
  const calls = [];
  const client = csClientRcon({
    agentExec: (_v, { command, input }) => { calls.push({ command, input }); return Promise.resolve({ pid: 1 }); },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'done' }),
  });
  const svc = createServerService({ client, db: testDb() });
  const res = await svc.runLiveAction('counterstrike', 'restart_round');
  assert.equal(res.output, 'done');
  const c = calls.at(-1);
  assert.equal(c.command[0], '/usr/bin/python3');
  assert.ok(c.command.includes('27015'));
  assert.equal(c.command.at(-1), 'mp_restartgame 1');   // command is a plain argv element
  assert.equal(c.input, 'secret');                       // password via stdin
  assert.ok(!c.command.includes('secret'));              // never in argv / process list
});

test('CS sendCommand validates input; unknown action rejected', async () => {
  const svc = createServerService({ client: csClientRcon(), db: testDb() });
  await assert.rejects(async () => svc.sendCommand('counterstrike', ''), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svc.sendCommand('counterstrike', 'a\nb'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svc.runLiveAction('counterstrike', 'nope'), (e) => e.code === 'BAD_SETTING');
});

test('rcon auth failure surfaces RCON_AUTH', async () => {
  const client = csClientRcon({
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 1, 'err-data': 'rcon: auth failed' }),
  });
  const svc = createServerService({ client, db: testDb() });
  await assert.rejects(async () => svc.runLiveAction('counterstrike', 'restart_round'), (e) => e.code === 'RCON_AUTH');
});

test('Factorio live is available and maps actions to console commands', async () => {
  const calls = [];
  const client = fakeClient({
    agentExec: (_v, { command, input }) => { calls.push({ command, input }); return Promise.resolve({ pid: 1 }); },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': '5 hours' }),
  });
  const svc = createServerService({ client, db: testDb() });
  assert.equal((await svc.getLive('factorio')).available, true);
  const res = await svc.runLiveAction('factorio', 'time');
  assert.equal(res.output, '5 hours');
  assert.equal(calls.at(-1).command.at(-1), '/time');
  assert.equal(calls.at(-1).input, 'CHANGE_ME'); // LinuxGSM default rcon password fallback
});

test('a non-RCON base server reports live unavailable', async () => {
  const base = new BaseConnector({ id: 'x', name: 'X', vmid: 1 }, fakeClient());
  assert.equal((await base.getLive()).available, false);
  await assert.rejects(async () => base.sendCommand('x'), (e) => e.code === 'NO_RCON');
});

test('a connector with no quick settings returns empty fields by default', async () => {
  const base = new BaseConnector({ id: 'x', name: 'X', vmid: 1 }, fakeClient());
  assert.deepEqual(await base.getSettings(), { fields: [] });
});

test('Minecraft exposes world-management sections', async () => {
  const svc = createServerService({ client: fakeClient() });
  const s = await svc.getSettings('minecraft');
  assert.ok(Array.isArray(s.sections) && s.sections.length > 0);
  assert.ok(s.sections.some((sec) => sec.key === 'loadWorld'));
});

// ── connection strings ────────────────────────────────────────────────────────────
test('connect strings render per game from the registry + public host', async () => {
  const svc = createServerService({ client: fakeClient(), publicHost: '1.2.3.4' });
  const list = await svc.listServers();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.connect]));
  assert.equal(byId.counterstrike.string, 'connect 1.2.3.4:27015');
  assert.equal(byId.factorio.string, '1.2.3.4:34197');
  assert.equal(byId.minecraft.string, '1.2.3.4:25565');
});
