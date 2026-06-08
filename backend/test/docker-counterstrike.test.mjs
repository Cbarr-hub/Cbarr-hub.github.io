import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { testDb } from './test-db.js';
import { createServerStore } from '../src/servers/store.js';
import * as cs from '../src/servers/connectors/counterstrike-profile.js';
import { DockerCounterStrikeConnector } from '../src/servers/connectors/docker/counterstrike.js';

const CS = { id: 'counterstrike', name: 'Counter-Strike', backend: 'docker', container: 'cs2', port: 27015 };

// Minimal Source-RCON server that captures the first exec command body, replies to
// auth, then echoes the END sentinel so rconExchange resolves. Lets us assert the
// exact command string applyProfileSettings sends over the real wire.
function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8);
  b.copy(buf, 12); buf.writeInt8(0, 12 + b.length); buf.writeInt8(0, 13 + b.length);
  return buf;
}
async function withRconCapture(run) {
  const commands = [];
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
        commands.push(body);
      }
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try { await run({ port }); } finally { await new Promise((res) => server.close(res)); }
  return { command: commands[0] ?? null, commands };
}

async function captureCsRcon(run) {
  const prev = process.env.CS2_RCON_PASSWORD;
  try {
    process.env.CS2_RCON_PASSWORD = 'x';
    return await withRconCapture(async ({ port }) => {
      const conn = new DockerCounterStrikeConnector(
        { ...CS, container: '127.0.0.1', rconPort: port }, {});
      await run(conn);
    });
  } finally {
    if (prev === undefined) delete process.env.CS2_RCON_PASSWORD;
    else process.env.CS2_RCON_PASSWORD = prev;
  }
}

// ── shared pure module ──────────────────────────────────────────────────────────
test('cs-profile validate: map (stock/ws), mode, hostname (no maxPlayers — env-only)', () => {
  const base = cs.defaultProfileSettings();
  assert.equal(base.maxPlayers, undefined); // maxPlayers is NOT a profile field (compose env)
  assert.equal(cs.validateProfileSettings({ ...base, map: 'ws:3071005299' }).map, 'ws:3071005299');
  assert.throws(() => cs.validateProfileSettings({ ...base, map: 'ws:abc' }), /workshop id/);
  assert.throws(() => cs.validateProfileSettings({ ...base, map: 'Bad Map!' }), /invalid map/);
  assert.throws(() => cs.validateProfileSettings({ ...base, gameMode: 'nope' }), /game mode/);
  assert.throws(() => cs.validateProfileSettings({ ...base, hostname: 'a"b' }), /server name/);
  assert.throws(() => cs.validateProfileSettings({ ...base, hostname: 'x'.repeat(cs.MAX_HOSTNAME_CHARS + 1) }), /server name too long/);
  assert.throws(() => cs.validateProfileSettings({ ...base, rawConfig: 'x'.repeat(cs.MAX_RAW_CONFIG_CHARS + 1) }), /extra cvars too large/);
  assert.throws(() => cs.validateProfileSettings({ ...base, rawConfig: 'x'.repeat(cs.MAX_RAW_CONFIG_LINE_CHARS + 1) }), /extra cvar lines/);
  // a stray maxPlayers is ignored, not persisted
  assert.equal(cs.validateProfileSettings({ ...base, maxPlayers: 99 }).maxPlayers, undefined);
});

test('cs-profile schema applies LIVE over RCON (no restart) and drops maxPlayers', () => {
  const { groups, apply } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.equal(apply?.mode, 'live');
  assert.ok(apply.label && apply.note);
  assert.ok(!groups[0].fields.some((f) => f.key === 'maxPlayers'));
});

test('cs-profile CS_CVAR_FIELDS: seeded as defaults, validated within bounds', () => {
  const base = cs.defaultProfileSettings();
  // every cvar field is seeded to its default
  for (const f of cs.CS_CVAR_FIELDS) assert.equal(base[f.key], f.def);
  // round-trip leaves valid values untouched (coerced to number)
  assert.equal(cs.validateProfileSettings({ ...base, maxRounds: 30 }).maxRounds, 30);
  assert.equal(cs.validateProfileSettings({ ...base, friendlyFire: '0' }).friendlyFire, 0);
  // out-of-bounds and non-integer rejected
  assert.throws(() => cs.validateProfileSettings({ ...base, maxRounds: 999 }), /Max Rounds must be 0–60/);
  assert.throws(() => cs.validateProfileSettings({ ...base, botQuota: -1 }), /Bots must be 0–64/);
  assert.throws(() => cs.validateProfileSettings({ ...base, freezeTime: 'x' }), /must be a number/);
  assert.throws(() => cs.validateProfileSettings({ ...base, buyTime: 2.5 }), /whole number/);
  // a float cvar (roundTime) accepts fractional values
  assert.equal(cs.validateProfileSettings({ ...base, roundTime: 1.92 }).roundTime, 1.92);
});

test('cs-profile schema: Match Rules group + embedded cvarRef', () => {
  const { groups, cvarRef } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  const rules = groups.find((g) => g.key === 'rules');
  assert.ok(rules && rules.title === 'Match Rules');
  // bools render as bool, numbers carry bounds
  assert.equal(rules.fields.find((f) => f.key === 'friendlyFire').type, 'bool');
  const mr = rules.fields.find((f) => f.key === 'maxRounds');
  assert.deepEqual([mr.type, mr.min, mr.max], ['number', 0, 60]);
  // cvarRef is embedded and covers every CS_CVAR_FIELDS cvar
  assert.ok(Array.isArray(cvarRef));
  for (const f of cs.CS_CVAR_FIELDS) assert.ok(cvarRef.some((r) => r.name === f.cvar));
  assert.ok(cvarRef.some((r) => r.name === 'sv_gravity' && r.help));
});

test('cs-profile csRangeCmd: clamps to bounds, gravity gates cheats, unknown → null', () => {
  assert.equal(cs.csRangeCmd('gravity', 99999), 'sv_cheats 1; sv_gravity 2000'); // clamp high
  assert.equal(cs.csRangeCmd('gravity', 0), 'sv_cheats 1; sv_gravity 100');      // clamp low
  assert.equal(cs.csRangeCmd('startmoney', 800), 'mp_startmoney 800; mp_maxmoney 16000');
  assert.equal(cs.csRangeCmd('roundtime', 5), 'mp_roundtime_defuse 5; mp_roundtime 5');
  assert.equal(cs.csRangeCmd('bots', 99), 'bot_quota 10');
  assert.equal(cs.csRangeCmd('bots', 0), 'bot_quota 0; bot_kick');
  assert.equal(cs.csRangeCmd('nope', 1), null);
  assert.throws(() => cs.csRangeCmd('gravity', 'NaN'), /invalid value/);
});

test('cs-profile botQuotaCmd: zero also kicks, non-zero sets the quota (rounded)', () => {
  assert.equal(cs.botQuotaCmd(0), 'bot_quota 0; bot_kick');
  assert.equal(cs.botQuotaCmd(5), 'bot_quota 5');
  assert.equal(cs.botQuotaCmd(0.4), 'bot_quota 0; bot_kick'); // rounds to 0 → kick
});

test('cs-profile buildChangeMapCmd: stock vs workshop vs invalid', () => {
  assert.equal(cs.buildChangeMapCmd('de_dust2'), 'changelevel de_dust2');
  assert.equal(cs.buildChangeMapCmd('ws:123'), 'host_workshop_map 123');
  assert.throws(() => cs.buildChangeMapCmd('ws:bad'), /workshop id/);
  assert.throws(() => cs.buildChangeMapCmd('bad map!'), /invalid map/);
});

test('cs-profile groups are Map & Mode / Match Rules / Advanced', () => {
  const { groups } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.deepEqual(groups.map((g) => g.key), ['map', 'rules', 'advanced']);
});

// ── Docker connector ────────────────────────────────────────────────────────────
test('DockerCS profileSchema includes stock + saved workshop maps', async () => {
  const store = createServerStore(testDb());
  store.addWorkshopMap('counterstrike', { workshopId: '777', name: 'My WS Map' });
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const { groups } = await conn.profileSchema();
  const mapField = groups[0].fields.find((f) => f.key === 'map');
  assert.ok(mapField.options.some((o) => o.value === 'de_dust2'));
  assert.ok(mapField.options.some((o) => o.value === 'ws:777' && o.label === 'My WS Map'));
});

test('DockerCS connectPassword is always empty (live sv_password reverts on restart)', async () => {
  const store = createServerStore(testDb());
  const prof = store.createProfile('counterstrike', {
    name: 'pw', settings: { ...cs.defaultProfileSettings(), password: 'secret123' },
  });
  store.setActiveProfile('counterstrike', prof.id);
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  // Even with an active profile carrying a password, the join string must advertise
  // none — a freshly-booted container enforces no password (compose env / unset).
  assert.equal(await conn.connectPassword(), '');
});

test('DockerCS reuses the DB-backed workshop catalog + config library', () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  conn.addMap({ workshopId: '42', name: 'Aim Map' });
  assert.ok(conn.listMaps().some((m) => m.workshopId === '42' && m.name === 'Aim Map'));
  const cfg = conn.createConfig({ name: 'comp', body: 'mp_maxrounds 24' });
  assert.equal(conn.getConfig(cfg.id).body, 'mp_maxrounds 24');
  const updated = conn.updateConfig(cfg.id, { name: 'scrim', body: 'mp_roundtime 5\nmp_freezetime 3' });
  assert.equal(updated.name, 'scrim');
  assert.equal(conn.getConfig(cfg.id).body, 'mp_roundtime 5\nmp_freezetime 3');
  assert.deepEqual(conn.deleteConfig(cfg.id), { ok: true });
  assert.throws(() => conn.getConfig(cfg.id), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => conn.createConfig({ name: 'bad name!', body: '' }), (e) => e.code === 'BAD_SETTING');
  assert.throws(() => conn.createConfig({ name: 'too_long', body: 'x'.repeat(cs.MAX_RAW_CONFIG_LINE_CHARS + 1) }),
    (e) => e.code === 'BAD_SETTING');
});

test('DockerCS addMap auto-fetches the Workshop title when name is omitted', async () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: '999', result: 1, title: 'Cobblestone Redux' }] } }),
  });
  try {
    const row = await conn.addMap({ workshopId: '999' });          // no name → auto
    assert.equal(row.name, 'Cobblestone Redux');
    const provided = await conn.addMap({ workshopId: '1000', name: 'Hand Named' });
    assert.equal(provided.name, 'Hand Named');                     // explicit name wins
  } finally { globalThis.fetch = realFetch; }
});

test('DockerCS importCollection imports every child with fetched names', async () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => String(url).includes('GetCollectionDetails')
      ? { response: { collectiondetails: [{ result: 1, children: [{ publishedfileid: '11' }, { publishedfileid: '22' }] }] } }
      : { response: { publishedfiledetails: [
          { publishedfileid: '11', result: 1, title: 'Map One' },
          { publishedfileid: '22', result: 1, title: 'Map Two' },
        ] } },
  });
  try {
    const r = await conn.importCollection('123');
    assert.equal(r.imported, 2);
    // unified shape: selectable {value,label} options, live (no restart)
    assert.equal(r.requiresRestart, false);
    assert.ok(r.maps.some((m) => m.value === 'ws:11' && m.label === 'Map One'));
    assert.ok(r.maps.some((m) => m.value === 'ws:22' && m.label === 'Map Two'));
    assert.ok(typeof r.note === 'string');
    const names = store.listWorkshopMaps('counterstrike').map((m) => m.name);
    assert.ok(names.includes('Map One') && names.includes('Map Two'));
  } finally { globalThis.fetch = realFetch; }
});

test('DockerCS update runs SteamCMD app_update 730 in-container', async () => {
  const calls = [];
  const client = { async agentExec(_c, { command }) { calls.push(command.join(' ')); return { pid: 'p' }; },
    async agentExecStatus() { return { exited: 1, exitcode: 0, 'out-data': 'ok', 'err-data': '' }; } };
  const conn = new DockerCounterStrikeConnector(CS, client);
  const res = await conn.update();
  assert.equal(res.ok, true);
  assert.equal(calls[0],
    '/bin/bash -lc /home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/cs2-dedicated +login anonymous +app_update 730 +quit');
  assert.equal(res.steps[0].name, 'steamcmd +app_update 730');
});

test('DockerCS live control is gated on CS2_RCON_PASSWORD', async () => {
  delete process.env.CS2_RCON_PASSWORD;
  const conn = new DockerCounterStrikeConnector(CS, {});
  assert.equal((await conn.getLive()).available, false);
  // apply pushes via RCON → without a password it fails fast (no socket opened)
  await assert.rejects(() => conn.applyProfileSettings(cs.defaultProfileSettings()), (e) => e.code === 'NO_RCON');

  process.env.CS2_RCON_PASSWORD = 'x';
  const live = await conn.getLive();
  assert.equal(live.available, true);
  // Exact advertised runtime inventory: every key below has a runLiveAction test.
  assert.deepEqual(live.actions.map((a) => a.key),
    ['restart_round', 'cheats_on', 'cheats_off', 'bunnyhop_on', 'bunnyhop_off',
     'warmup_end', 'add_bot', 'kick_bots', 'list_players', 'knife_only', 'zeus_battle', 'infinite_ammo_on', 'infinite_ammo_off']);
  assert.deepEqual(live.controls.map((c) => c.key), ['gravity', 'roundtime', 'startmoney', 'bots']);
  assert.equal(live.changeMap, true);
  assert.match(live.commandHint, /mp_warmup_end/);
  assert.ok(!live.actions.some((a) => a.key === 'apply_config'), 'no dead exec gamertown/active action');
  delete process.env.CS2_RCON_PASSWORD;
});

test('DockerCS runLiveAction sends every advertised button action', async () => {
  const expected = {
    restart_round: 'mp_restartgame 1',
    cheats_on: 'sv_cheats 1',
    cheats_off: 'sv_cheats 0',
    bunnyhop_on: 'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000',
    bunnyhop_off: 'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12',
    warmup_end: 'mp_warmup_end',
    add_bot: 'bot_add',
    kick_bots: 'bot_kick',
    list_players: 'status',
    knife_only: 'mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary ""; mp_t_default_secondary ""; mp_free_armor 0; mp_buy_allow_guns 0; mp_restartgame 1',
    zeus_battle: 'game_alias competitive; mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary weapon_taser; mp_t_default_secondary weapon_taser; mp_weapons_allow_zeus 1; mp_free_armor 0; mp_max_armor 0; mp_buy_allow_guns 0; mp_buy_allow_grenades 1; mp_startmoney 800; mp_maxmoney 16000; mp_restartgame 1',
    infinite_ammo_on: 'sv_cheats 1; sv_infinite_ammo 1',
    infinite_ammo_off: 'sv_infinite_ammo 0; sv_cheats 0',
  };
  assert.deepEqual(cs.CS_LIVE_ACTIONS.map((a) => a.key), Object.keys(expected));
  assert.deepEqual(Object.keys(cs.CS_ACTION_CMDS), Object.keys(expected));
  for (const [key, commandText] of Object.entries(expected)) {
    const { command } = await captureCsRcon((conn) => conn.runLiveAction(key));
    assert.equal(command, commandText, key);
  }
});

test('DockerCS runLiveAction sends every advertised slider control', async () => {
  const cases = [
    ['gravity', 250, 'sv_cheats 1; sv_gravity 250'],
    ['roundtime', 5, 'mp_roundtime_defuse 5; mp_roundtime 5'],
    ['startmoney', 1200, 'mp_startmoney 1200; mp_maxmoney 16000'],
    ['bots', 3, 'bot_quota 3'],
    ['bots', 0, 'bot_quota 0; bot_kick'],
  ];
  assert.deepEqual(cs.CS_LIVE_CONTROLS.map((c) => c.key), ['gravity', 'roundtime', 'startmoney', 'bots']);
  for (const [key, value, commandText] of cases) {
    const { command } = await captureCsRcon((conn) => conn.runLiveAction(key, value));
    assert.equal(command, commandText, key);
  }
});

test('DockerCS runLiveAction handles stock/workshop map changes and rejects unknown keys', async () => {
  assert.equal((await captureCsRcon((conn) => conn.runLiveAction('change_map', 'de_mirage'))).command,
    'changelevel de_mirage');
  assert.equal((await captureCsRcon((conn) => conn.runLiveAction('change_map', 'ws:3071005299'))).command,
    'host_workshop_map 3071005299');

  const conn = new DockerCounterStrikeConnector(CS, {});
  await assert.rejects(() => conn.runLiveAction('change_map', 'bad map!'), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.runLiveAction('bogus_action'), (e) => e.code === 'BAD_SETTING');
});

test('DockerCS sendCommand validates and sends raw console commands', async () => {
  const { command } = await captureCsRcon((conn) => conn.sendCommand('mp_warmup_end'));
  assert.equal(command, 'mp_warmup_end');

  const conn = new DockerCounterStrikeConnector(CS, {});
  await assert.rejects(() => conn.sendCommand(''), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.sendCommand('status\nquit'), (e) => e.code === 'BAD_SETTING');
});

test('DockerCS applyProfileSettings pushes Match-Rules cvars in the live RCON batch', async () => {
  // Stand up a throwaway RCON server that captures the command the connector sends,
  // so we assert the REAL applyProfileSettings batch (not a reimplementation).
  const { command } = await withRconCapture(async (server) => {
    process.env.CS2_RCON_PASSWORD = 'x';
    const conn = new DockerCounterStrikeConnector(
      { ...CS, container: '127.0.0.1', rconPort: server.port }, {});
    try {
      await conn.applyProfileSettings({ ...cs.defaultProfileSettings(), maxRounds: 30, friendlyFire: 0, overtime: 1, botQuota: 0 });
    } finally { delete process.env.CS2_RCON_PASSWORD; }
  });
  assert.ok(command.includes('mp_maxrounds 30'), 'maxRounds pushed');
  assert.ok(command.includes('mp_friendlyfire 0'), 'bool friendlyFire pushed as 0');
  assert.ok(command.includes('mp_overtime_enable 1'), 'bool overtime pushed as 1');
  assert.ok(command.includes('bot_quota 0; bot_kick'), 'botQuota 0 emits the combined kick command');
  assert.ok(command.includes('game_alias competitive') && command.includes('changelevel de_dust2'),
    'map + mode still in the batch');
});

test('DockerCS applyProfileSettings chunks rawConfig into bounded RCON batches', async () => {
  const rawConfig = Array.from({ length: 20 }, (_, i) => `say ${'x'.repeat(180)}${i}`).join('\n');
  const { commands } = await withRconCapture(async (server) => {
    process.env.CS2_RCON_PASSWORD = 'x';
    const conn = new DockerCounterStrikeConnector(
      { ...CS, container: '127.0.0.1', rconPort: server.port }, {});
    try {
      await conn.applyProfileSettings({ ...cs.defaultProfileSettings(), rawConfig });
    } finally { delete process.env.CS2_RCON_PASSWORD; }
  });
  assert.ok(commands.length > 1, 'large rawConfig should be split across RCON calls');
  assert.ok(commands.every((cmd) => cmd.length <= 1800), 'each RCON batch stays bounded');
  assert.ok(commands.at(-1).endsWith('changelevel de_dust2'), 'map change is sent last after cvar/raw batches');
});
