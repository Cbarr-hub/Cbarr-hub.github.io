import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';
import { withRconCapture, withEnv } from './harness.mjs';
import { createServerStore } from '../src/servers/store.js';
import { buildConnector } from '../src/servers/connectors/engine.js';
import * as cs from '../src/servers/connectors/specs/counterstrike.js';

// The live-action/control/sendCommand/update command canon for the CS connector
// is pinned in connector-goldens.test.mjs; this file keeps the pure profile/
// validation tests (now on the spec's exported helpers) plus the per-game quirks
// (live-apply batching/chunking, the workshop catalog + config library,
// auto-name fetch, connectPassword, strict slider clamping).

const CS = { id: 'counterstrike', name: 'Counter-Strike', backend: 'docker', container: 'cs2', port: 27015 };

const buildCs = (row, store = null) => buildConnector(row, cs.counterstrikeSpec, {}, store);

function captureCsRcon(run) {
  return withEnv('CS2_RCON_PASSWORD', 'x', () =>
    withRconCapture(async ({ port }) => {
      const conn = buildCs({ ...CS, container: '127.0.0.1', rconPort: port });
      await run(conn);
    }));
}

// ── shared pure helpers (spec surface) ──────────────────────────────────────────
test('cs-spec validate: map (stock/ws), mode, hostname (no maxPlayers — env-only)', () => {
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

test('cs-spec schema applies LIVE over RCON (no restart) and drops maxPlayers', () => {
  const { groups, apply } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.equal(apply?.mode, 'live');
  assert.ok(apply.label && apply.note);
  assert.ok(!groups[0].fields.some((f) => f.key === 'maxPlayers'));
});

test('cs-spec CS_CVAR_FIELDS: seeded as defaults, validated within bounds', () => {
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

test('cs-spec schema: Match Rules group + embedded cvarRef', () => {
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

test('cs-spec live sliders: clamp to bounds, gravity gates cheats, unknown/NaN reject', async () => {
  // The old csRangeCmd surface is now the spec's strict control rows, dispatched
  // by the engine — exercise the REAL runLiveAction path via loopback capture.
  const { commands } = await captureCsRcon(async (conn) => {
    await conn.runLiveAction('gravity', 99999); // clamp high
    await conn.runLiveAction('gravity', 0);     // clamp low
    await conn.runLiveAction('startmoney', 800);
    await conn.runLiveAction('roundtime', 5);
    await conn.runLiveAction('bots', 99);       // clamp to 10
    await conn.runLiveAction('bots', 0);        // zero also kicks
  });
  assert.deepEqual(commands, [
    'sv_cheats 1; sv_gravity 2000',
    'sv_cheats 1; sv_gravity 100',
    'mp_startmoney 800; mp_maxmoney 16000',
    'mp_roundtime_defuse 5; mp_roundtime 5',
    'bot_quota 10',
    'bot_quota 0; bot_kick',
  ]);
  // strict slider semantics: a non-numeric value is an error, not a default
  await assert.rejects(
    () => captureCsRcon((conn) => conn.runLiveAction('gravity', 'NaN')), /invalid value/);
  // an unknown key falls through sliders + actions → BAD_SETTING before any RCON I/O
  const conn = buildCs(CS);
  await assert.rejects(() => conn.runLiveAction('nope', 1), (e) => e.code === 'BAD_SETTING');
});

test('cs-spec botQuotaCmd: zero also kicks, non-zero sets the quota (rounded)', () => {
  assert.equal(cs.botQuotaCmd(0), 'bot_quota 0; bot_kick');
  assert.equal(cs.botQuotaCmd(5), 'bot_quota 5');
  assert.equal(cs.botQuotaCmd(0.4), 'bot_quota 0; bot_kick'); // rounds to 0 → kick
});

test('cs-spec buildChangeMapCmd: stock vs workshop vs invalid', () => {
  assert.equal(cs.buildChangeMapCmd('de_dust2'), 'changelevel de_dust2');
  assert.equal(cs.buildChangeMapCmd('ws:123'), 'host_workshop_map 123');
  assert.throws(() => cs.buildChangeMapCmd('ws:bad'), /workshop id/);
  assert.throws(() => cs.buildChangeMapCmd('bad map!'), /invalid map/);
});

test('cs-spec groups are Map & Mode / Match Rules / Advanced', () => {
  const { groups } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.deepEqual(groups.map((g) => g.key), ['map', 'rules', 'advanced']);
});

// ── spec-built connector ────────────────────────────────────────────────────────
test('CS spec profileSchema includes stock + saved workshop maps', async () => {
  const store = createServerStore(testDb());
  store.addWorkshopMap('counterstrike', { workshopId: '777', name: 'My WS Map' });
  const conn = buildCs(CS, store);
  const { groups } = await conn.profileSchema();
  const mapField = groups[0].fields.find((f) => f.key === 'map');
  assert.ok(mapField.options.some((o) => o.value === 'de_dust2'));
  assert.ok(mapField.options.some((o) => o.value === 'ws:777' && o.label === 'My WS Map'));
});

test('CS spec connectPassword is always empty (live sv_password reverts on restart)', async () => {
  const store = createServerStore(testDb());
  const prof = store.createProfile('counterstrike', {
    name: 'pw', settings: { ...cs.defaultProfileSettings(), password: 'secret123' },
  });
  store.setActiveProfile('counterstrike', prof.id);
  const conn = buildCs(CS, store);
  // Even with an active profile carrying a password, the join string must advertise
  // none — a freshly-booted container enforces no password (compose env / unset).
  assert.equal(await conn.connectPassword(), '');
});

test('CS spec reuses the DB-backed workshop catalog + config library', () => {
  const store = createServerStore(testDb());
  const conn = buildCs(CS, store);
  conn.addMap({ workshopId: '42', name: 'Aim Map' });
  assert.ok(conn.listMaps().some((m) => m.workshopId === '42' && m.name === 'Aim Map'));
  const cfg = conn.createConfig({ name: 'comp', body: 'mp_maxrounds 24' });
  assert.equal(conn.getConfig(cfg.id).body, 'mp_maxrounds 24');
  assert.ok(conn.listConfigs().some((c) => c.id === cfg.id && c.name === 'comp'));
  assert.deepEqual(conn.deleteConfig(cfg.id), { ok: true });
  assert.throws(() => conn.getConfig(cfg.id), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => conn.createConfig({ name: 'bad name!', body: '' }), (e) => e.code === 'BAD_SETTING');
  assert.throws(() => conn.createConfig({ name: 'too_long', body: 'x'.repeat(cs.MAX_RAW_CONFIG_LINE_CHARS + 1) }),
    (e) => e.code === 'BAD_SETTING');
});

test('CS spec addMap auto-fetches the Workshop title when name is omitted', async () => {
  const store = createServerStore(testDb());
  const conn = buildCs(CS, store);
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

test('CS spec importCollection imports every child with fetched names', async () => {
  const store = createServerStore(testDb());
  const conn = buildCs(CS, store);
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

test('CS spec applyProfileSettings fails fast without CS2_RCON_PASSWORD', async () => {
  await withEnv('CS2_RCON_PASSWORD', undefined, async () => {
    const conn = buildCs(CS);
    // apply pushes via RCON → without a password it fails fast (no socket opened)
    await assert.rejects(() => conn.applyProfileSettings(cs.defaultProfileSettings()), (e) => e.code === 'NO_RCON');
  });
});

test('CS spec applyProfileSettings pushes Match-Rules cvars in the live RCON batch', async () => {
  // Stand up a throwaway RCON server that captures the command the connector sends,
  // so we assert the REAL applyProfileSettings batch (not a reimplementation).
  const { command } = await captureCsRcon((conn) =>
    conn.applyProfileSettings({ ...cs.defaultProfileSettings(), maxRounds: 30, friendlyFire: 0, overtime: 1, botQuota: 0 }));
  assert.ok(command.includes('mp_maxrounds 30'), 'maxRounds pushed');
  assert.ok(command.includes('mp_friendlyfire 0'), 'bool friendlyFire pushed as 0');
  assert.ok(command.includes('mp_overtime_enable 1'), 'bool overtime pushed as 1');
  assert.ok(command.includes('bot_quota 0; bot_kick'), 'botQuota 0 emits the combined kick command');
  assert.ok(command.includes('game_alias competitive') && command.includes('changelevel de_dust2'),
    'map + mode still in the batch');
});

test('CS spec applyProfileSettings chunks rawConfig into bounded RCON batches', async () => {
  const rawConfig = Array.from({ length: 20 }, (_, i) => `say ${'x'.repeat(180)}${i}`).join('\n');
  const { commands } = await captureCsRcon((conn) =>
    conn.applyProfileSettings({ ...cs.defaultProfileSettings(), rawConfig }));
  assert.ok(commands.length > 1, 'large rawConfig should be split across RCON calls');
  assert.ok(commands.every((cmd) => cmd.length <= 1800), 'each RCON batch stays bounded');
  assert.ok(commands.at(-1).endsWith('changelevel de_dust2'), 'map change is sent last after cvar/raw batches');
});
