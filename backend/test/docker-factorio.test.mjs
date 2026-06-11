import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient } from './harness.mjs';
import * as fp from '../src/servers/connectors/factorio-profile.js';
import { DockerFactorioConnector } from '../src/servers/connectors/docker/factorio.js';
import { getServer } from '../src/servers/registry.js';

// The live-action/control/sendCommand/update command canon for the Factorio
// connector is pinned in connector-goldens.test.mjs; this file keeps the pure
// factorio-profile module tests plus the per-game quirks (apply/capture through
// the two settings files, _active.zip staging, Save As, the rconPort invariant).

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
const FCTR = { id: 'factorio', name: 'Factorio', backend: 'docker', container: 'factorio', port: 34197 };
const SS = '/factorio/config/server-settings.json';
const MS = '/factorio/config/map-settings.json';

test('DockerFactorio applyProfileSettings writes server-settings.json + map-settings.json + stages the active world', async () => {
  const client = fakeDockerClient({ [SS]: '{}', [MS]: '{}' });
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
  assert.ok(client.execCalls.some((c) => c.command.join(' ').includes('myworld.zip') && c.command.join(' ').includes('_active.zip')));
});

test('DockerFactorio profileSchema exposes a World Rules group + cvarRef', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeDockerClient({ [SS]: '{}' }));
  const schema = await conn.profileSchema();
  assert.ok(schema.groups.some((g) => g.key === 'rules'));
  assert.ok(Array.isArray(schema.cvarRef) && schema.cvarRef.length > 0);
});

test('DockerFactorio captureProfileSettings merges map-settings world rules', async () => {
  const client = fakeDockerClient({
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
  const client = fakeDockerClient({
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
  const client = fakeDockerClient({ [SS]: JSON.stringify({
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

test('DockerFactorio getSettings exposes only the Save As quick operation', async () => {
  const conn = new DockerFactorioConnector(FCTR, fakeDockerClient());
  const settings = await conn.getSettings();
  assert.deepEqual(settings.sections.map((s) => s.key), ['saveAs']);
  assert.equal(settings.sections[0].saveLabel, 'Save As');
  assert.deepEqual(settings.sections[0].fields.map((f) => f.key), ['saveName']);
  assert.match(settings.note, /active world/i);
});

test('DockerFactorio setSettings saveAs copies _active.zip to the requested save', async () => {
  const client = fakeDockerClient();
  const conn = new DockerFactorioConnector(FCTR, client);
  const result = await conn.setSettings({ section: 'saveAs', saveName: 'new_save-1' });
  assert.deepEqual(result, { ok: true, action: 'saveAs', saveName: 'new_save-1' });
  assert.deepEqual(client.execCalls.at(-1).command, [
    '/bin/bash',
    '-lc',
    'cp -f "/factorio/saves/_active.zip" "/factorio/saves/new_save-1.zip"',
  ]);
});

test('DockerFactorio setSettings validates section and save name before copying', async () => {
  const client = fakeDockerClient();
  const conn = new DockerFactorioConnector(FCTR, client);
  await assert.rejects(() => conn.setSettings({ section: 'world', saveName: 'ok' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.setSettings({ section: 'saveAs', saveName: 'bad name!' }), (e) => e.code === 'BAD_SETTING');
  await assert.rejects(() => conn.setSettings({ section: 'saveAs', saveName: '' }), (e) => e.code === 'BAD_SETTING');
  assert.deepEqual(client.execCalls, []);
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
