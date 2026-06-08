import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import * as fp from '../src/servers/connectors/factorio-profile.js';
import { DockerFactorioConnector } from '../src/servers/connectors/docker/factorio.js';
import { getServer } from '../src/servers/registry.js';

// Minimal Source-RCON server that captures the first exec command body (so we can
// assert the exact /sc string runLiveAction sends over the real wire), then replies
// to auth + the END sentinel so rconExchange resolves. Mirrors docker-counterstrike.
function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}
async function withRconCapture(run) {
  let command = null;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('ascii', 12, 4 + size - 2);
        buf = buf.subarray(4 + size);
        if (type === 3) { sock.write(encodeRcon(id, 2, '')); continue; } // auth ok
        if (id === 3) { sock.write(encodeRcon(3, 0, '')); continue; }    // END sentinel echo
        if (command === null) command = body;                            // first real exec
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return { command };
}

// ── pure profile module ─────────────────────────────────────────────────────────
test('factorio-profile validate normalizes + rejects bad values', () => {
  const base = fp.defaultProfileSettings();
  assert.equal(fp.validateProfileSettings({ ...base, visibility: 'nope' }).visibility, 'lan');
  assert.throws(() => fp.validateProfileSettings({ ...base, maxPlayers: 999 }), /max players/);
  assert.throws(() => fp.validateProfileSettings({ ...base, autosaveInterval: 0 }), /autosave/);
  assert.throws(() => fp.validateProfileSettings({ ...base, saveName: 'bad name!' }), /invalid world/);
});

test('factorio-profile applyServerSettings + captureServerSettings round-trip', () => {
  const v = fp.validateProfileSettings({
    ...fp.defaultProfileSettings(), serverName: 'GT', description: 'd',
    maxPlayers: 12, visibility: 'public', password: 'pw', autosaveInterval: 7,
  });
  const json = fp.applyServerSettings({}, v);
  assert.equal(json.name, 'GT');
  assert.equal(json.max_players, 12);
  assert.deepEqual(json.visibility, { public: true, lan: true });
  assert.equal(json.game_password, 'pw');
  assert.equal(json.autosave_interval, 7);

  const c = fp.captureServerSettings(json);
  assert.equal(c.serverName, 'GT');
  assert.equal(c.visibility, 'public');
  assert.equal(c.maxPlayers, 12);
});

test('factorio-profile captureServerSettings clamps out-of-range max_players + autosave_interval', () => {
  // A hand-edited server-settings.json can hold values outside the validator's
  // range; capture must clamp (not pass through) so the re-validation it feeds
  // doesn't throw. autosave_interval=0 is an integer, so the clamp (not the
  // ternary fallback) is what floors it to 1.
  const c = fp.captureServerSettings({ name: 'Srv', max_players: 600, autosave_interval: 0 });
  assert.equal(c.maxPlayers, 500);
  assert.equal(c.autosaveInterval, 1);
});

test('factorio-profile groups are World + Server Settings + World Rules', () => {
  const g = fp.profileGroups([{ value: '', label: 'x' }]);
  assert.deepEqual(g.map((x) => x.key), ['world', 'server', 'rules']);
  const rules = g.find((x) => x.key === 'rules');
  assert.deepEqual(rules.fields.map((f) => f.key),
    ['autoPause', 'evolutionEnabled', 'pollutionEnabled', 'expansionEnabled', 'techPriceMultiplier']);
});

// ── world rules (§2d) ───────────────────────────────────────────────────────────
test('factorio-profile world rules default to enabled / 1×', () => {
  const d = fp.defaultProfileSettings();
  assert.equal(d.autoPause, '1');
  assert.equal(d.evolutionEnabled, '1');
  assert.equal(d.pollutionEnabled, '1');
  assert.equal(d.expansionEnabled, '1');
  assert.equal(d.techPriceMultiplier, 1);
});

test('factorio-profile validate normalizes world-rule bools + bounds tech multiplier', () => {
  const base = fp.defaultProfileSettings();
  const v = fp.validateProfileSettings({ ...base, autoPause: true, evolutionEnabled: 0, pollutionEnabled: 'x', expansionEnabled: '1' });
  assert.equal(v.autoPause, '1');
  assert.equal(v.evolutionEnabled, '0');
  assert.equal(v.pollutionEnabled, '0'); // non-'1' → '0'
  assert.equal(v.expansionEnabled, '1');
  assert.throws(() => fp.validateProfileSettings({ ...base, techPriceMultiplier: 0.1 }), /tech price/);
  assert.throws(() => fp.validateProfileSettings({ ...base, techPriceMultiplier: 11 }), /tech price/);
  assert.equal(fp.validateProfileSettings({ ...base, techPriceMultiplier: 2.5 }).techPriceMultiplier, 2.5);
});

test('factorio-profile auto_pause round-trips through server-settings', () => {
  const base = fp.defaultProfileSettings();
  const off = fp.applyServerSettings({}, fp.validateProfileSettings({ ...base, autoPause: '0' }));
  assert.equal(off.auto_pause, false);
  assert.equal(fp.captureServerSettings(off).autoPause, '0');
  assert.equal(fp.captureServerSettings({}).autoPause, '1'); // absent → on
});

test('factorio-profile applyMapSettings + captureMapSettings round-trip', () => {
  const v = fp.validateProfileSettings({
    ...fp.defaultProfileSettings(),
    evolutionEnabled: '0', pollutionEnabled: '1', expansionEnabled: '0', techPriceMultiplier: 4,
  });
  const m = fp.applyMapSettings({ enemy_evolution: { time_factor: 1 } }, v);
  assert.equal(m.enemy_evolution.enabled, false);
  assert.equal(m.enemy_evolution.time_factor, 1); // preserves existing keys
  assert.equal(m.pollution.enabled, true);
  assert.equal(m.enemy_expansion.enabled, false);
  assert.equal(m.difficulty_settings.technology_price_multiplier, 4);

  const c = fp.captureMapSettings(m);
  assert.equal(c.evolutionEnabled, '0');
  assert.equal(c.pollutionEnabled, '1');
  assert.equal(c.expansionEnabled, '0');
  assert.equal(c.techPriceMultiplier, 4);
});

test('factorio-profile cvarRef covers both settings files', () => {
  const names = fp.FACTORIO_CVAR_REF.map((c) => c.name);
  assert.ok(names.includes('auto_pause'));
  assert.ok(names.includes('enemy_evolution.enabled'));
  assert.ok(names.includes('difficulty_settings.technology_price_multiplier'));
  for (const c of fp.FACTORIO_CVAR_REF) assert.ok(c.name && c.type && c.group, 'cvarRef row needs name/type/group');
});

// ── Docker connector ────────────────────────────────────────────────────────────
function fakeFctrClient(files = {}) {
  const execs = [];
  return {
    files, execs,
    async statusCurrent() { return { status: 'running', uptime: 1 }; },
    async agentFileRead(_c, path) { return { content: files[path] ?? '' }; },
    async agentFileWrite(_c, path, content) { files[path] = content; return null; },
    async agentExec(_c, { command }) { execs.push(command); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': '', 'err-data': '' }; },
  };
}

const FCTR = { id: 'factorio', name: 'Factorio', backend: 'docker', container: 'factorio', port: 34197 };
const SS = '/factorio/config/server-settings.json';
const MS = '/factorio/config/map-settings.json';

test('DockerFactorio applyProfileSettings writes server-settings.json + map-settings.json + stages the active world', async () => {
  const client = fakeFctrClient({ [SS]: '{}', [MS]: '{}' });
  const conn = new DockerFactorioConnector(FCTR, client);
  await conn.applyProfileSettings({
    saveName: 'myworld', serverName: 'GTown', description: 'hi',
    maxPlayers: 5, visibility: 'public', password: 'p', autosaveInterval: 7,
    autoPause: '0', evolutionEnabled: '0', pollutionEnabled: '1', expansionEnabled: '0', techPriceMultiplier: 3,
  });
  const json = JSON.parse(client.files[SS]);
  assert.equal(json.name, 'GTown');
  assert.equal(json.max_players, 5);
  assert.equal(json.game_password, 'p');
  assert.equal(json.auto_pause, false);
  // world rules land in map-settings.json (boot truth, new-world only)
  const map = JSON.parse(client.files[MS]);
  assert.equal(map.enemy_evolution.enabled, false);
  assert.equal(map.pollution.enabled, true);
  assert.equal(map.enemy_expansion.enabled, false);
  assert.equal(map.difficulty_settings.technology_price_multiplier, 3);
  // active world staged as _active.zip via cp
  assert.ok(client.execs.some((c) => c.join(' ').includes('myworld.zip') && c.join(' ').includes('_active.zip')));
});

test('DockerFactorio profileSchema exposes a World Rules group + cvarRef', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeFctrClient({ [SS]: '{}' }));
  const schema = await conn.profileSchema();
  assert.ok(schema.groups.some((g) => g.key === 'rules'));
  assert.ok(Array.isArray(schema.cvarRef) && schema.cvarRef.length > 0);
});

test('DockerFactorio captureProfileSettings merges map-settings world rules', async () => {
  const client = fakeFctrClient({
    [SS]: JSON.stringify({ name: 'Srv', auto_pause: false }),
    [MS]: JSON.stringify({ enemy_evolution: { enabled: false }, difficulty_settings: { technology_price_multiplier: 5 } }),
  });
  const conn = new DockerFactorioConnector(FCTR, client);
  const c = await conn.captureProfileSettings();
  assert.equal(c.autoPause, '0');
  assert.equal(c.evolutionEnabled, '0');
  assert.equal(c.techPriceMultiplier, 5);
});

test('DockerFactorio captureProfileSettings clamps out-of-range server-settings (no 400)', async () => {
  // A Raw-Config edit could set max_players=600 / autosave_interval=0 on disk;
  // captureProfileSettings re-runs validateProfileSettings, so without a clamp on
  // read the snapshot would 400. It must clamp instead (mirrors techPriceMultiplier).
  const client = fakeFctrClient({
    [SS]: JSON.stringify({ name: 'Srv', max_players: 600, autosave_interval: 0 }),
    [MS]: '{}',
  });
  const conn = new DockerFactorioConnector(FCTR, client);
  await assert.doesNotReject(() => conn.captureProfileSettings());
  const c = await conn.captureProfileSettings();
  assert.equal(c.maxPlayers, 500);
  assert.equal(c.autosaveInterval, 1);
});

test('DockerFactorio captureProfileSettings reads server-settings (world = keep current)', async () => {
  const client = fakeFctrClient({ [SS]: JSON.stringify({
    name: 'Srv', max_players: 8, visibility: { public: false, lan: true },
    game_password: '', autosave_interval: 15,
  }) });
  const conn = new DockerFactorioConnector(FCTR, client);
  const c = await conn.captureProfileSettings();
  assert.equal(c.serverName, 'Srv');
  assert.equal(c.maxPlayers, 8);
  assert.equal(c.visibility, 'lan');
  assert.equal(c.saveName, ''); // container loads _active.zip; original name not recoverable
});

test('DockerFactorio getLive is unavailable without an rconpw file', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeFctrClient());
  assert.equal((await conn.getLive()).available, false);
});

test('DockerFactorio getLive is available once rconpw is readable, with actions + controls', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeFctrClient({ '/factorio/config/rconpw': 'secret\n' }));
  const live = await conn.getLive();
  assert.equal(live.available, true);
  assert.deepEqual(live.actions.map((a) => a.key),
    ['players', 'time', 'show_evolution', 'save', 'peaceful_on', 'peaceful_off', 'alwaysday_on', 'alwaysday_off']);
  assert.deepEqual(live.controls.map((c) => c.key), ['game_speed', 'evolution']);
  for (const c of live.controls) {
    assert.ok(Number.isFinite(c.min) && Number.isFinite(c.max) && c.min < c.max);
  }
  assert.match(live.commandHint, /achievement/i); // /sc caveat surfaced
});

// Each withRconCapture run captures the FIRST exec, so use one server per assertion.
async function captureLive(key, value) {
  const client = fakeFctrClient({ '/factorio/config/rconpw': 'secret\n' });
  const { command } = await withRconCapture(async ({ port }) => {
    const server = { ...FCTR, container: '127.0.0.1', rconPort: port };
    const conn = new DockerFactorioConnector(server, client);
    await conn.runLiveAction(key, value);
  });
  return command;
}

test('DockerFactorio runLiveAction clamps game_speed to its bounds and pushes /sc', async () => {
  assert.equal(await captureLive('game_speed', 99), '/sc game.speed=4');    // clamp high
  assert.equal(await captureLive('game_speed', -5), '/sc game.speed=0.25'); // clamp low
  assert.equal(await captureLive('game_speed', 0),  '/sc game.speed=0.25'); // zero parses, then clamps low
  assert.equal(await captureLive('game_speed', 2),  '/sc game.speed=2');    // in range
});

test('DockerFactorio runLiveAction clamps evolution and pushes set_evolution_factor', async () => {
  assert.equal(await captureLive('evolution', 5),
    '/sc game.forces["enemy"].set_evolution_factor(1)');  // clamp high
  assert.equal(await captureLive('evolution', -1),
    '/sc game.forces["enemy"].set_evolution_factor(0)');  // clamp low
  assert.equal(await captureLive('evolution', 0),
    '/sc game.forces["enemy"].set_evolution_factor(0)');  // zero is preserved
});

test('DockerFactorio runLiveAction maps the new actions to their commands', async () => {
  assert.equal(await captureLive('save'), '/server-save');
  assert.equal(await captureLive('peaceful_on'), '/sc game.surfaces[1].peaceful_mode=true');
  assert.equal(await captureLive('show_evolution'), '/evolution');
});

test('DockerFactorio runLiveAction rejects unknown keys with BAD_SETTING', async () => {
  const conn = new DockerFactorioConnector(
    { ...FCTR, container: '127.0.0.1' },
    fakeFctrClient({ '/factorio/config/rconpw': 'secret\n' }),
  );
  await assert.rejects(() => conn.runLiveAction('nope'), (e) => e.code === 'BAD_SETTING');
});

// ── registry: Factorio RCON port (factoriotools exposes RCON on 27015) ───────────
// `port` (34197) is the UDP game port; RCON is a separate TCP port. The registry
// must carry rconPort so consumers that do `rconPort ?? port` (the host session
// tracker) resolve to 27015, not the wrong game port.
test('registry: factorio carries rconPort 27015 (RCON port, not the game port)', () => {
  const s = getServer('factorio');
  assert.equal(s.rconPort, 27015);
  assert.equal(s.port, 34197); // game/UDP port stays distinct
  // Cross-source invariant: the tracker-effective port (`rconPort ?? port`) and the
  // connector-effective port (`rconPort ?? 27015`) must agree — both → 27015.
  assert.equal(s.rconPort ?? s.port, s.rconPort ?? 27015);
  assert.equal(s.rconPort ?? s.port, 27015);
});
