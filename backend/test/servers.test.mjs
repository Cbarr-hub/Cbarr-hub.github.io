import assert from 'node:assert/strict';
import test from 'node:test';

import { getServer, listServers } from '../src/servers/registry.js';
import { normalizeStatus } from '../src/servers/connectors/base.js';
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

test('Minecraft has no automated updater', async () => {
  const svc = createServerService({ client: fakeClient() });
  await assert.rejects(() => svc.runUpdate('minecraft'), (e) => e.code === 'NO_UPDATE_RECIPE');
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

test('CS getSettings reflects the workshop map actually in effect', async () => {
  const svc = createServerService({ client: csClient() });
  const s = await svc.getSettings('counterstrike');
  const byKey = Object.fromEntries(s.fields.map((f) => [f.key, f]));
  // host_workshop_map overrides the stock `map`, so effective map is the workshop one
  assert.equal(byKey.map.value, 'ws:3071005299');
  assert.equal(byKey.gameMode.value, 'competitive');
  assert.equal(byKey.maxPlayers.value, 10);
  // Assembly is offered as a labelled workshop option
  assert.ok(byKey.map.options.some((o) => o.value === 'ws:3071005299' && /Assembly/.test(o.label)));
  const mapVals = byKey.map.options.map((o) => o.value);
  assert.ok(mapVals.includes('de_dust2') && !mapVals.includes('de_dust2_vanity'));
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

test('servers without quick settings return empty fields', async () => {
  const svc = createServerService({ client: fakeClient() });
  const s = await svc.getSettings('minecraft');
  assert.deepEqual(s.fields, []);
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
