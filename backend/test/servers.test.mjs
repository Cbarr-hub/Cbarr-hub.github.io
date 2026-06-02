import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { getServer, listServers } from '../src/servers/registry.js';
import { BaseConnector, normalizeStatus } from '../src/servers/connectors/base.js';
import { createServerService, ServerControlError, normalizeNodeStatus } from '../src/servers/service.js';
import { getVar, setVar, setVars } from '../src/servers/cfgvars.js';
import { getCvar, setCvars } from '../src/servers/cvars.js';

// A fake ProxmoxClient: records calls, returns canned data. No network.
function fakeClient(overrides = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    node: 'pve',
    nodeStatus: overrides.nodeStatus ?? (() => {
      calls.push(['nodeStatus']);
      return Promise.resolve({
        uptime: 7200, cpu: 0.25,
        cpuinfo: { cpus: 4, model: 'Test CPU' },
        loadavg: ['0.50', '0.40', '0.30'],
        memory: { total: 8e9, used: 4e9, free: 4e9 },
        swap: { total: 2e9, used: 1e8 },
        rootfs: { total: 1e11, used: 3e10 },
        kversion: 'Linux 6.x', pveversion: 'pve-manager/8.0',
      });
    }),
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
  assert.equal(getServer('gmod').vmid, 104);
  assert.equal(getServer('prophunt').vmid, 105);
  assert.equal(getServer('nope'), undefined);
  assert.equal(listServers().length, 5);
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
  assert.equal(list.length, 5);
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

// ── node dashboard ──────────────────────────────────────────────────────────────
test('normalizeNodeStatus shapes the proxmox node payload defensively', () => {
  const n = normalizeNodeStatus({
    uptime: 100, cpu: 0.5, cpuinfo: { cpus: 8, model: 'Xeon' },
    loadavg: ['1.0', '0.5', 'nan'], memory: { total: 100, used: 60 },
    swap: { total: 10, used: 2 }, rootfs: { total: 1000, used: 400 },
    kversion: 'k', pveversion: 'pve',
  });
  assert.equal(n.cpu, 0.5);
  assert.equal(n.cpus, 8);
  assert.deepEqual(n.loadavg, [1.0, 0.5]); // non-finite dropped
  assert.equal(n.memory.used, 60);
  assert.equal(n.rootfs.total, 1000);
  // empty/partial payload never throws and defaults cleanly
  const empty = normalizeNodeStatus(null);
  assert.equal(empty.uptime, 0);
  assert.equal(empty.cpu, null);
  assert.deepEqual(empty.loadavg, []);
});

test('getNodeStatus returns the node name plus normalized host stats', async () => {
  const svc = createServerService({ client: fakeClient() });
  const n = await svc.getNodeStatus();
  assert.equal(n.node, 'pve');
  assert.equal(n.cpus, 4);
  assert.equal(n.memory.total, 8e9);
  assert.deepEqual(n.loadavg, [0.5, 0.4, 0.3]);
});

test('getNodeStatus without a client reports not-configured', async () => {
  const svc = createServerService({ client: null });
  await assert.rejects(() => svc.getNodeStatus(), (e) =>
    e instanceof ServerControlError && e.code === 'NOT_CONFIGURED');
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

test('CS getSettings returns the map block for the live change-map (config now in Profiles)', async () => {
  const svc = createServerService({ client: csClient(), db: testDb() });
  const s = await svc.getSettings('counterstrike');
  assert.equal(s.game, 'counterstrike');
  // host_workshop_map overrides the stock `map`, so the effective map is the workshop one
  assert.equal(s.map.current, 'ws:3071005299');
  // Assembly comes from the seeded catalog
  assert.ok(s.map.workshop.some((w) => w.id === '3071005299' && w.name === 'Assembly'));
  // stock list comes from installed vpks, minus the _vanity entry
  assert.ok(s.map.stock.includes('de_dust2') && !s.map.stock.includes('de_dust2_vanity'));
  assert.equal(s.gameMode, undefined); // game mode + config moved to the Profiles panel
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

test('restartGame action runs the LinuxGSM restart as the owning user', async () => {
  const cmds = [];
  const client = fakeClient({ agentExec: (_v, { command }) => { cmds.push(command); return Promise.resolve({ pid: 1 }); } });
  const svc = createServerService({ client });
  await svc.doAction('counterstrike', 'restartGame');
  const c = cmds.at(-1);
  assert.equal(c[0], '/usr/sbin/runuser');
  assert.match(c.at(-1), /\.\/cs2server restart/);
});

test('CS change_map issues the verified RCON command (stock vs workshop)', async () => {
  const cmds = [];
  const client = csClientRcon({
    agentExec: (_v, { command }) => { cmds.push(command); return Promise.resolve({ pid: 1 }); },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'ok' }),
  });
  const svc = createServerService({ client, db: testDb() });
  await svc.runLiveAction('counterstrike', 'change_map', 'de_dust2');
  assert.equal(cmds.at(-1).at(-1), 'changelevel de_dust2');
  await svc.runLiveAction('counterstrike', 'change_map', 'ws:3071005299');
  assert.equal(cmds.at(-1).at(-1), 'host_workshop_map 3071005299');
  await assert.rejects(async () => svc.runLiveAction('counterstrike', 'change_map', 'bad map!'), (e) => e.code === 'BAD_SETTING');
});

test('CS apply_config execs the deployed active.cfg live', async () => {
  const cmds = [];
  const client = csClientRcon({
    agentExec: (_v, { command }) => { cmds.push(command); return Promise.resolve({ pid: 1 }); },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'ok' }),
  });
  const svc = createServerService({ client, db: testDb() });
  await svc.runLiveAction('counterstrike', 'apply_config');
  assert.equal(cmds.at(-1).at(-1), 'exec gamertown/active');
});

test('LinuxGSM gameRunning maps the port-check exit code to gameStatus', async () => {
  // running VM + game port bound (grep exits 0) → hosting
  const hosting = createServerService({ client: fakeClient(), db: testDb() });
  assert.equal((await hosting.getStatus('counterstrike')).gameStatus, 'hosting');
  // running VM + port not bound (grep exits 1) → idle
  const idle = createServerService({
    client: fakeClient({ agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 1, 'out-data': '' }) }),
    db: testDb(),
  });
  assert.equal((await idle.getStatus('counterstrike')).gameStatus, 'idle');
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

test('Minecraft Quick Settings exposes the snapshot operation (config now in Profiles)', async () => {
  const svc = createServerService({ client: fakeClient() });
  const s = await svc.getSettings('minecraft');
  // active world + properties moved to the Profiles panel; Quick Settings is ops-only
  assert.deepEqual(s.sections.map((sec) => sec.key), ['saveAs']);
});

// ── offsite backups (Phase 4; rclone → R2) ──────────────────────────────────────
// A fake client that simulates rclone on the VM: it records every shell command
// and returns canned stdout per command kind (keyed by pid → command).
function bkClient({ rcloneReady = true, lsjson = '[]', exists = true } = {}) {
  const cmds = [];
  const byPid = {};
  let pid = 0;
  const client = fakeClient({
    statusCurrent: () => Promise.resolve({ status: 'stopped' }), // skip MC flush delay
    agentFileRead: (_v, f) => Promise.resolve({
      content: /server\.properties$/.test(f)
        ? 'level-name=world\n'
        : 'savename="myworld"\nsavegame="/home/miles/fctrserver/serverfiles/saves/myworld.zip"\n',
    }),
    agentExec: (_v, { command, input }) => {
      const sh = command.at(-1);
      cmds.push({ command, input, sh });
      pid += 1; byPid[pid] = sh;
      return Promise.resolve({ pid });
    },
    agentExecStatus: (_v, p) => {
      const sh = byPid[p] || '';
      let out = 'ok';
      if (/rclone listremotes/.test(sh)) out = rcloneReady ? 'r2:\n' : 'other:\n';
      else if (/rclone lsjson/.test(sh)) out = lsjson;
      else if (/rclone lsf/.test(sh)) out = exists ? 'myworld_20260101_000000.zip\n' : '';
      else if (/_autosave/.test(sh)) out = ''; // no autosave → fall back to active save
      return Promise.resolve({ exited: 1, exitcode: 0, 'out-data': out });
    },
  });
  return { client, cmds };
}

test('Counter-Strike rejects backup ops as unsupported', async () => {
  const svc = createServerService({ client: fakeClient(), db: testDb() });
  await assert.rejects(async () => svc.listBackups('counterstrike'), (e) => e.code === 'NOT_SUPPORTED');
  await assert.rejects(async () => svc.createBackup('counterstrike'), (e) => e.code === 'NOT_SUPPORTED');
});

test('listBackups reports unavailable when rclone/R2 is not configured', async () => {
  const { client } = bkClient({ rcloneReady: false });
  const svc = createServerService({ client });
  const res = await svc.listBackups('factorio');
  assert.equal(res.available, false);
  assert.match(res.reason, /not configured/);
  assert.deepEqual(res.backups, []);
});

test('listBackups parses rclone lsjson, strips ext, and sorts newest-first', async () => {
  const lsjson = JSON.stringify([
    { Name: 'a_20260101_000000.zip', Size: 10, ModTime: '2026-01-01T00:00:00Z', IsDir: false },
    { Name: 'b_20260201_000000.zip', Size: 20, ModTime: '2026-02-01T00:00:00Z', IsDir: false },
    { Name: 'subdir', IsDir: true },
  ]);
  const { client } = bkClient({ lsjson });
  const svc = createServerService({ client });
  const res = await svc.listBackups('factorio');
  assert.equal(res.available, true);
  assert.equal(res.backups.length, 2);                 // dir excluded
  assert.equal(res.backups[0].name, 'b_20260201_000000'); // newest first, ext stripped
  assert.equal(res.backups[1].size, 10);
});

test('Factorio createBackup uploads the active save zip to the R2 factorio prefix as miles', async () => {
  const { client, cmds } = bkClient();
  const svc = createServerService({ client });
  const res = await svc.createBackup('factorio');
  assert.match(res.name, /^myworld_\d{8}_\d{6}$/);
  const up = cmds.find((c) => /rclone copyto/.test(c.sh) && /factorio\//.test(c.sh));
  assert.equal(up.command[0], '/usr/sbin/runuser');
  assert.deepEqual(up.command.slice(1, 4), ['-u', 'miles', '--']);
  assert.match(up.sh, /serverfiles\/saves\/myworld\.zip" "r2:gamertown-backups\/factorio\/myworld_\d{8}_\d{6}\.zip"/);
});

test('Factorio restoreBackup downloads the backup into saves as a loadable save (no restart)', async () => {
  const { client, cmds } = bkClient();
  const svc = createServerService({ client });
  const res = await svc.restoreBackup('factorio', 'myworld_20260101_000000');
  assert.equal(res.action, 'restore');
  const dl = cmds.find((c) => /rclone copyto/.test(c.sh));
  assert.match(dl.sh, /"r2:gamertown-backups\/factorio\/myworld_20260101_000000\.zip" "[^"]*\/saves\/myworld_20260101_000000\.zip"/);
  assert.ok(!cmds.some((c) => /systemctl|fctrserver (start|stop|restart)/.test(c.sh))); // no restart
});

test('Minecraft createBackup streams a tar.gz of the world to R2', async () => {
  const { client, cmds } = bkClient();
  const svc = createServerService({ client });
  const res = await svc.createBackup('minecraft');
  assert.match(res.name, /^world_\d{8}_\d{6}$/);
  const up = cmds.find((c) => /rclone rcat/.test(c.sh));
  assert.match(up.sh, /tar -czf - -C "[^"]*MinecraftServer" "world" \| rclone rcat "r2:gamertown-backups\/minecraft\/world_\d{8}_\d{6}\.tar\.gz"/);
});

test('Minecraft restoreBackup stops, restores, and restarts in order', async () => {
  const { client, cmds } = bkClient();
  const svc = createServerService({ client });
  const res = await svc.restoreBackup('minecraft', 'world_20260101_000000');
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.map((s) => s.name), ['stop', 'download + extract', 'swap world', 'start']);
  assert.ok(cmds.some((c) => /systemctl stop minecraft/.test(c.sh)));
  assert.ok(cmds.some((c) => /rclone cat "r2:gamertown-backups\/minecraft\/world_20260101_000000\.tar\.gz" \| tar -xzf -/.test(c.sh)));
  assert.ok(cmds.some((c) => /systemctl start minecraft/.test(c.sh)));
});

test('deleteBackup removes the object; missing backup → NOT_FOUND; bad name → BAD_SETTING', async () => {
  const ok = bkClient();
  const svcOk = createServerService({ client: ok.client });
  const del = await svcOk.deleteBackup('factorio', 'myworld_20260101_000000');
  assert.equal(del.ok, true);
  assert.ok(ok.cmds.some((c) => /rclone deletefile "r2:gamertown-backups\/factorio\/myworld_20260101_000000\.zip"/.test(c.sh)));

  const missing = bkClient({ exists: false });
  const svcMissing = createServerService({ client: missing.client });
  await assert.rejects(async () => svcMissing.deleteBackup('factorio', 'gone_20260101_000000'), (e) => e.code === 'NOT_FOUND');

  await assert.rejects(async () => svcOk.restoreBackup('factorio', 'bad name!'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(async () => svcOk.deleteBackup('minecraft', 'bad;rm -rf'), (e) => e.code === 'BAD_SETTING');
});

// ── connection strings ────────────────────────────────────────────────────────────
test('connect strings render per game from the registry + public host', async () => {
  const svc = createServerService({ client: fakeClient(), publicHost: '1.2.3.4' });
  const list = await svc.listServers();
  const byId = Object.fromEntries(list.map((s) => [s.id, s.connect]));
  assert.equal(byId.counterstrike.string, 'connect 1.2.3.4:27015');
  assert.equal(byId.factorio.string, '1.2.3.4:34197');
  assert.equal(byId.minecraft.string, '1.2.3.4:25565');
  assert.equal(byId.gmod.string, 'connect 1.2.3.4:27066');
});

test('launch URLs open the game + connect; Minecraft has none', async () => {
  const svc = createServerService({ client: fakeClient(), publicHost: '1.2.3.4' });
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
  const svc = createServerService({ client: fakeClient(), publicHost: '' });
  const cs = (await svc.listServers()).find((s) => s.id === 'counterstrike');
  assert.equal(cs.connect.launch, null);
});

// ── guest-agent post-boot auto-wait ─────────────────────────────────────────────
test('runCommand waits out a not-yet-ready guest agent, then succeeds', async () => {
  let attempts = 0;
  const client = fakeClient({
    agentExec: () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error('proxmox ... 500: QEMU guest agent is not running'));
      return Promise.resolve({ pid: 7 });
    },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'started' }),
  });
  const conn = new BaseConnector(getServer('factorio'), client);
  const res = await conn.runCommand(['/bin/true'], { awaitAgentMs: 5_000, pollMs: 5 });
  assert.equal(attempts, 3);           // retried until the agent answered
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, 'started');
});

test('runCommand still fails fast on agent-down when no wait budget is given', async () => {
  const client = fakeClient({
    agentExec: () => Promise.reject(new Error('500: QEMU guest agent is not running')),
  });
  const conn = new BaseConnector(getServer('factorio'), client);
  await assert.rejects(() => conn.runCommand(['/bin/true']), /guest agent is not running/);
});

test('runCommand does NOT retry non-agent errors even with a wait budget', async () => {
  let attempts = 0;
  const client = fakeClient({
    agentExec: () => { attempts += 1; return Promise.reject(new Error('500: some other failure')); },
  });
  const conn = new BaseConnector(getServer('factorio'), client);
  await assert.rejects(() => conn.runCommand(['/bin/true'], { awaitAgentMs: 5_000, pollMs: 5 }), /some other failure/);
  assert.equal(attempts, 1);           // tried once, did not loop
});

// ── GMOD / TTT connector ───────────────────────────────────────────────────────────
const GMOD_SERVER_CFG = [
  'hostname "Gamertown TTT"',
  'ttt_round_limit 6',
  'ttt_traitor_pct 0.25',
  'ttt_minimum_players 2',
].join('\n') + '\n';
const GMOD_INSTANCE_CFG = 'gamemode="terrortown"\ndefaultmap="ttt_minecraft_b5"\nmaxplayers="16"\nwscollectionid=""\n';

function gmodClient(opts = {}) {
  const writes = [];
  const files = {
    server: opts.serverCfg ?? GMOD_SERVER_CFG,
    inst: GMOD_INSTANCE_CFG,
    mapcycle: opts.mapcycle ?? 'ttt_minecraft_b5\n',
  };
  const pick = (f) =>
    f.endsWith('/cfg/gmodserver.cfg') ? files.server
    : f.endsWith('/mapcycle.txt') ? files.mapcycle
    : f.includes('config-lgsm') ? files.inst
    : '';
  const client = fakeClient({
    agentFileRead: (_v, f) => Promise.resolve({ content: pick(f) }),
    agentFileWrite: (_v, path, content) => { writes.push({ path, content }); return Promise.resolve(); },
    agentExec: opts.agentExec,
    agentExecStatus: opts.agentExecStatus,
  });
  return { client, writes };
}

test('GMOD getSettings returns just the map block for the live change-map (config now in Profiles)', async () => {
  const { client } = gmodClient();
  const svc = createServerService({ client, db: testDb() });
  const s = await svc.getSettings('gmod');
  assert.equal(s.game, 'gmod');
  assert.equal(s.map.current, 'ttt_minecraft_b5');  // from instance defaultmap
  assert.ok(Array.isArray(s.map.stock));
  assert.equal(s.sections, undefined);              // TTT config moved to the Profiles panel
});

test('GMOD live RCON gates on rcon_password and builds a safe argv', async () => {
  const off = gmodClient();
  const svcOff = createServerService({ client: off.client, db: testDb() });
  assert.equal((await svcOff.getLive('gmod')).available, false);

  const calls = [];
  const on = gmodClient({
    serverCfg: GMOD_SERVER_CFG + 'rcon_password "ttt-secret"\n',
    agentExec: (_v, { command, input }) => { calls.push({ command, input }); return Promise.resolve({ pid: 1 }); },
    agentExecStatus: () => Promise.resolve({ exited: 1, exitcode: 0, 'out-data': 'players: 3' }),
  });
  const svc = createServerService({ client: on.client, db: testDb() });
  assert.equal((await svc.getLive('gmod')).available, true);

  const res = await svc.runLiveAction('gmod', 'change_map', 'ttt_waterworld');
  assert.equal(res.output, 'players: 3');
  const c = calls.at(-1);
  assert.ok(c.command.includes('27066'));
  assert.equal(c.command.at(-1), 'changelevel ttt_waterworld');
  assert.equal(c.input, 'ttt-secret');
  assert.ok(!c.command.includes('ttt-secret'));
  await assert.rejects(() => svc.runLiveAction('gmod', 'change_map', 'bad map'), (e) => e.code === 'BAD_SETTING');
});
