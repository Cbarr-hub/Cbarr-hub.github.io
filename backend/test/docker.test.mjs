import assert from 'node:assert/strict';
import test from 'node:test';

import { DockerClient } from '../src/docker/client.js';
import { DockerBaseConnector } from '../src/servers/connectors/docker-base.js';
import { DockerMinecraftConnector } from '../src/servers/connectors/docker/minecraft.js';
import { DockerFactorioConnector } from '../src/servers/connectors/docker/factorio.js';
import { DockerCounterStrikeConnector } from '../src/servers/connectors/docker/counterstrike.js';
import { DockerGmodConnector } from '../src/servers/connectors/docker/gmod.js';
import { buildConnectors } from '../src/servers/connectors/index.js';

// ── a fake fetch that records calls and returns canned Engine responses ─────────
function res({ ok = true, status = 200, json, bytes, text } = {}) {
  return {
    ok, status, statusText: String(status),
    async text() { return text ?? (json !== undefined ? JSON.stringify(json) : ''); },
    async arrayBuffer() { return (bytes ?? new Uint8Array()).buffer; },
  };
}

// Build a Docker (Tty:false) multiplexed frame: [type,0,0,0, size BE] + payload.
function frame(type, str) {
  const payload = Buffer.from(str, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = type;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method, path, body: init.body });
    for (const [re, handler] of routes) {
      if (re.test(`${method} ${path}`)) return handler(`${method} ${path}`, init);
    }
    return res({ ok: false, status: 404 });
  };
  return { fetchImpl, calls };
}

// ── DockerClient: status maps inspect (+stats) to the normalizeStatus shape ─────
test('DockerClient.statusCurrent maps a running container to normalizeStatus shape', async () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: {
      State: { Running: true, StartedAt: startedAt }, HostConfig: { Memory: 0 },
    } })],
    [/^GET \/containers\/mc\/stats/, () => res({ json: {
      memory_stats: { usage: 500, limit: 2000 },
      cpu_stats:    { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 600 },
    } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc');
  assert.equal(s.status, 'running');
  assert.ok(s.uptime >= 59 && s.uptime <= 61);
  assert.equal(s.mem, 500);
  assert.equal(s.maxmem, 2000);
  assert.ok(s.cpu > 0); // (100/400)*2 = 0.5
});

test('DockerClient.statusCurrent reports stopped, and tolerates missing stats', async () => {
  const { fetchImpl } = fakeFetch([
    [/^GET \/containers\/mc\/json$/, () => res({ json: { State: { Running: false } } })],
    [/^GET \/containers\/mc\/stats/, () => res({ ok: false, status: 500 })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const s = await c.statusCurrent('mc');
  assert.equal(s.status, 'stopped');
  assert.equal(s.uptime, 0);
  assert.equal(s.cpu, null);
});

test('DockerClient power actions hit the right endpoints (stop=kill, shutdown=stop)', async () => {
  const { fetchImpl, calls } = fakeFetch([[/^POST /, () => res({ status: 204 })]]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  await c.start('mc'); await c.shutdown('mc'); await c.stop('mc'); await c.reboot('mc');
  assert.deepEqual(calls.map((x) => x.path), [
    '/containers/mc/start', '/containers/mc/stop', '/containers/mc/kill', '/containers/mc/restart',
  ]);
});

test('DockerClient.agentExec runs to completion and agentExecStatus returns the exited shape', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, () => res({ json: { Id: 'exec123' } })],
    [/^POST \/exec\/exec123\/start$/, () => res({ bytes: new Uint8Array(
      Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')]),
    ) })],
    [/^GET \/exec\/exec123\/json$/, () => res({ json: { ExitCode: 0, Running: false } })],
  ]);
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const { pid } = await c.agentExec('mc', { command: ['/bin/sh', '-lc', 'echo hello'] });
  assert.equal(pid, 'exec123');
  const st = await c.agentExecStatus('mc', pid);
  assert.equal(st.exited, 1);
  assert.equal(st.exitcode, 0);
  assert.equal(st['out-data'], 'hello\n');   // stdout (type 1)
  assert.equal(st['err-data'], 'oops\n');    // stderr (type 2)
  // the create body advertised the argv
  const create = calls.find((x) => x.path === '/containers/mc/exec');
  assert.match(create.body, /"Cmd":\["\/bin\/sh","-lc","echo hello"\]/);
});

test('DockerClient.agentExec rejects stdin input (use TCP for interactive I/O)', async () => {
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl: async () => res({}) });
  await assert.rejects(() => c.agentExec('mc', { command: ['x'], input: 'hi' }), (e) => e.code === 'NO_STDIN');
});

test('DockerClient.agentFileRead/Write round-trip via exec', async () => {
  let written = null;
  const { fetchImpl } = fakeFetch([
    [/^POST \/containers\/mc\/exec$/, (_l, init) => {
      const cmd = JSON.parse(init.body).Cmd.join(' ');
      // stash which kind of exec this is so start can return the right stream
      lastCmd = cmd;
      return res({ json: { Id: cmd.includes('base64 -d') ? 'w' : 'r' } });
    }],
    [/^POST \/exec\/r\/start$/, () => res({ bytes: new Uint8Array(frame(1, 'level-name=world\n')) })],
    [/^POST \/exec\/w\/start$/, (_l) => {
      // capture the base64 payload that file-write pipes in
      const m = lastCmd.match(/printf %s "([^"]+)"/);
      written = Buffer.from(m[1], 'base64').toString('utf8');
      return res({ bytes: new Uint8Array() });
    }],
    [/^GET \/exec\/[rw]\/json$/, () => res({ json: { ExitCode: 0 } })],
  ]);
  let lastCmd = '';
  const c = new DockerClient({ host: 'tcp://docker-proxy:2375', fetchImpl });
  const read = await c.agentFileRead('mc', '/data/server.properties');
  assert.equal(read.content, 'level-name=world\n');
  await c.agentFileWrite('mc', '/data/server.properties', 'level-name=new\n');
  assert.equal(written, 'level-name=new\n');
});

// ── Docker connectors: locator + container-is-game + shared profile logic ───────
function fakeDockerClient(files = {}) {
  return {
    files,
    async statusCurrent() { return { status: 'running', uptime: 10, cpu: 0.1, mem: 1, maxmem: 2 }; },
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec() { return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
  };
}

const MC_DOCKER = { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 };

test('DockerBaseConnector uses the container as its locator and treats running == hosting', async () => {
  const conn = new DockerBaseConnector({ id: 'x', container: 'box' }, fakeDockerClient());
  assert.equal(conn.vmid, 'box');
  const s = await conn.status();
  assert.equal(s.status, 'running');
  assert.equal(s.gameStatus, 'hosting');
});

test('DockerMinecraftConnector apply/capture round-trips /data/server.properties', async () => {
  const PROPS = '/data/server.properties';
  const client = fakeDockerClient({ [PROPS]: 'level-name=world\nmax-players=20\n' });
  const conn = new DockerMinecraftConnector(MC_DOCKER, client);
  await conn.applyProfileSettings({
    world: 'GTown', gamemode: 'creative', difficulty: 'hard', maxPlayers: 8, motd: 'Hi',
    pvp: '0', hardcore: '1', whitelist: '1', onlineMode: '0', viewDistance: 16, spawnProtection: 0,
  });
  assert.match(client.files[PROPS], /level-name=GTown/);
  assert.match(client.files[PROPS], /gamemode=creative/);
  assert.match(client.files[PROPS], /white-list=true/);

  const captured = await conn.captureProfileSettings();
  assert.equal(captured.world, 'GTown');
  assert.equal(captured.gamemode, 'creative');
  assert.equal(captured.whitelist, '1');
});

test('DockerMinecraftConnector.getLive is unavailable without an RCON password', async () => {
  delete process.env.MINECRAFT_RCON_PASSWORD;
  const conn = new DockerMinecraftConnector(MC_DOCKER, fakeDockerClient());
  const live = await conn.getLive();
  assert.equal(live.available, false);
});

// ── factory wiring: backend selection ───────────────────────────────────────────
test('buildConnectors builds every docker-backed entry, and skips when no client', () => {
  const docker = fakeDockerClient();
  // A docker client → all five (docker-backed) registry entries build.
  const built = buildConnectors({ docker });
  assert.equal(built.size, 5);
  assert.ok(built.get('minecraft') instanceof DockerMinecraftConnector);

  // No docker client → every entry is skipped (nothing to build).
  const none = buildConnectors({ docker: null });
  assert.equal(none.size, 0);
});

// ── action surface the control panel relies on (container == game) ──────────────
// The panel collapsed the old Game-Service / Virtual-Machine split into one
// container-power model (Start/Restart/Stop). Codify what Docker connectors
// actually support: the container IS the game, so the game-service actions alias
// onto container power (no separate in-VM service to error on); and every image
// now has an in-panel updater (SteamCMD for the Steam games, re-download on
// restart for the others) instead of NO_UPDATE_RECIPE.
test('non-LinuxGSM Docker connectors: container IS the game (game-service → container power; updatable)', async () => {
  const FX = { id: 'factorio', name: 'Factorio', backend: 'docker', container: 'factorio', port: 34197 };
  const CS = { id: 'counterstrike', name: 'CS', backend: 'docker', container: 'counterstrike', port: 27015 };
  const make = (Cls, server) => {
    const calls = [];
    const client = fakeDockerClient();
    client.start = () => { calls.push('start'); return Promise.resolve(); };
    client.shutdown = () => { calls.push('shutdown'); return Promise.resolve(); };
    client.reboot = () => { calls.push('reboot'); return Promise.resolve(); };
    return { conn: new Cls(server, client), calls };
  };
  for (const [Cls, server] of [
    [DockerMinecraftConnector, MC_DOCKER],
    [DockerFactorioConnector, FX],
    [DockerCounterStrikeConnector, CS],
  ]) {
    const { conn, calls } = make(Cls, server);
    // game-service actions map to container start/shutdown/reboot (never BAD_ACTION).
    await conn.startGame(); await conn.stopGame(); await conn.restartGame();
    assert.deepEqual(calls, ['start', 'shutdown', 'reboot']);
    // …and update() now resolves (no NO_UPDATE_RECIPE).
    const upd = await conn.update();
    assert.ok(upd && upd.ok !== false, `${server.id} update should resolve`);
  }
});

test('DockerGmod maps the game-service actions onto container power', async () => {
  const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
  const calls = [];
  const client = fakeDockerClient();
  client.start = () => { calls.push('start'); return Promise.resolve(); };
  client.shutdown = () => { calls.push('shutdown'); return Promise.resolve(); };
  client.reboot = () => { calls.push('reboot'); return Promise.resolve(); };
  const conn = new DockerGmodConnector(GMOD, client);
  await conn.startGame(); await conn.stopGame(); await conn.restartGame();
  assert.deepEqual(calls, ['start', 'shutdown', 'reboot']);
});

// The Runtime panel's live change-map dropdown reads getSettings().map. CS uses the
// generic Profiles panel for startup config, so its getSettings returns ONLY the map
// block (stock + the saved workshop catalog) — no fields/sections (which would
// double-render a Quick Settings panel).
test('DockerCounterStrike.getSettings feeds the live change-map dropdown (stock + workshop)', async () => {
  const CS = { id: 'counterstrike', name: 'CS', backend: 'docker', container: 'counterstrike', port: 27015 };
  const store = {
    listWorkshopMaps: () => [{ workshopId: '123', name: 'Assembly' }],
    getActiveProfileId: () => 7,
    getProfile: () => ({ id: 7, name: 'p', settings: { map: 'ws:123' } }),
  };
  const conn = new DockerCounterStrikeConnector(CS, fakeDockerClient(), store);
  const s = await conn.getSettings();
  assert.ok(Array.isArray(s.map.stock) && s.map.stock.length > 0); // stock maps present
  assert.deepEqual(s.map.workshop, [{ id: '123', name: 'Assembly' }]); // saved workshop maps, by name
  assert.equal(s.map.current, 'ws:123'); // current reflects the active profile's map
  assert.equal(s.fields, undefined); // no Quick Settings double-render
  assert.equal(s.sections, undefined);
});

// TTT exposes the genuinely-binary toggles as buttons (bhop/cheats + list players)
// and the continuous cvars (gravity/speed/timescale) as slider CONTROLS, not the
// old on/off button pairs.
test('DockerGmod (TTT) getLive: binary toggles as buttons, ranges as slider controls', async () => {
  const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
  const prev = process.env.GMOD_RCON_PASSWORD;
  process.env.GMOD_RCON_PASSWORD = 'secret';
  try {
    const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
    const live = await conn.getLive();
    assert.equal(live.available, true);
    assert.equal(live.changeMap, true);
    const keys = live.actions.map((a) => a.key);
    for (const k of ['bhop_on', 'bhop_off', 'cheats_on', 'cheats_off', 'players']) {
      assert.ok(keys.includes(k), `expected runtime action ${k}`);
    }
    // the old on/off range pairs are gone from the buttons…
    for (const k of ['lowgrav_on', 'speed_on', 'slowmo_on']) {
      assert.ok(!keys.includes(k), `range action ${k} should be a slider now`);
    }
    // …and present as range controls instead. The base gravity/speed/timescale
    // sliders are always there; the redesign adds more (traitor_pct/round_limit),
    // so assert inclusion rather than an exact list.
    const ctlKeys = (live.controls || []).map((c) => c.key);
    for (const k of ['gravity', 'speed', 'timescale']) assert.ok(ctlKeys.includes(k), `expected slider ${k}`);
    const gravity = live.controls.find((c) => c.key === 'gravity');
    assert.ok(gravity.min != null && gravity.max != null && gravity.step != null && gravity.default != null);
  } finally {
    if (prev === undefined) delete process.env.GMOD_RCON_PASSWORD; else process.env.GMOD_RCON_PASSWORD = prev;
  }
});

// The range sliders push a single value → an RCON command via runLiveAction(key, value).
test('DockerGmod runLiveAction maps range keys to clamped cvar commands', async () => {
  const GMOD = { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 };
  const prev = process.env.GMOD_RCON_PASSWORD;
  process.env.GMOD_RCON_PASSWORD = 'secret';
  const sent = [];
  try {
    const conn = new DockerGmodConnector(GMOD, fakeDockerClient());
    conn.runRcon = async (command) => { sent.push(command); return { output: '' }; };
    await conn.runLiveAction('gravity', '250');
    await conn.runLiveAction('timescale', '0.5');
    await conn.runLiveAction('gravity', '99999'); // clamps to max 1000
    assert.equal(sent[0], 'sv_gravity 250');
    assert.equal(sent[1], 'sv_cheats 1; host_timescale 0.5');
    assert.equal(sent[2], 'sv_gravity 1000');
  } finally {
    if (prev === undefined) delete process.env.GMOD_RCON_PASSWORD; else process.env.GMOD_RCON_PASSWORD = prev;
  }
});
