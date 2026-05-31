import assert from 'node:assert/strict';
import test from 'node:test';

import { getServer, listServers } from '../src/servers/registry.js';
import { normalizeStatus } from '../src/servers/connectors/base.js';
import { createServerService, ServerControlError } from '../src/servers/service.js';
import { getVar, setVar, setVars } from '../src/servers/cfgvars.js';

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

// ── CS quick settings ────────────────────────────────────────────────────────────
const CS_CFG = 'gslt=""\nwsstartmap="3071005299"\nstartmap="de_anubis"\nmaxplayers="10"\n';

function csClient(onWrite) {
  return fakeClient({
    agentFileRead: () => Promise.resolve({ content: CS_CFG, truncated: false }),
    agentFileWrite: (_vmid, _file, content) => { if (onWrite) onWrite(content); return Promise.resolve(); },
    // #listMaps → ls output
    agentExec: () => Promise.resolve({ pid: 1 }),
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0,
      'out-data': '/maps/de_dust2.vpk\n/maps/de_anubis.vpk\n/maps/de_dust2_vanity.vpk\n/maps/lobby_mapveto.vpk\n' }),
  });
}

test('CS getSettings exposes map + gameMode + maxPlayers with current values', async () => {
  const svc = createServerService({ client: csClient() });
  const s = await svc.getSettings('counterstrike');
  const byKey = Object.fromEntries(s.fields.map((f) => [f.key, f]));
  assert.equal(byKey.map.value, 'de_anubis');
  assert.equal(byKey.maxPlayers.value, 10);
  assert.equal(byKey.gameMode.value, 'competitive'); // no +game_type yet → default
  // _vanity / non-game maps filtered out, real maps present
  const mapVals = byKey.map.options.map((o) => o.value);
  assert.ok(mapVals.includes('de_dust2') && mapVals.includes('de_anubis'));
  assert.ok(!mapVals.includes('de_dust2_vanity') && !mapVals.includes('lobby_mapveto'));
});

test('CS setSettings writes map/maxplayers and a managed startparameters with game mode', async () => {
  let written = '';
  const svc = createServerService({ client: csClient((c) => { written = c; }) });
  await svc.setSettings('counterstrike', { map: 'de_nuke', gameMode: 'deathmatch', maxPlayers: 12 });
  assert.equal(getVar(written, 'startmap'), 'de_nuke');
  assert.equal(getVar(written, 'wsstartmap'), '');     // workshop cleared for stock map
  assert.equal(getVar(written, 'maxplayers'), '12');
  assert.match(getVar(written, 'startparameters'), /\+game_type 1 \+game_mode 2/); // deathmatch
});

test('CS setSettings rejects bad values', async () => {
  const svc = createServerService({ client: csClient() });
  await assert.rejects(() => svc.setSettings('counterstrike', { gameMode: 'bogus' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { maxPlayers: 999 }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => svc.setSettings('counterstrike', { map: 'de nuke; rm' }), (e) => e.code === 'BAD_SETTING');
});

test('servers without quick settings return empty fields', async () => {
  const svc = createServerService({ client: fakeClient() });
  const s = await svc.getSettings('minecraft');
  assert.deepEqual(s.fields, []);
});
