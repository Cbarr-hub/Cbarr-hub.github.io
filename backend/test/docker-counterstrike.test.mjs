import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import * as cs from '../src/servers/connectors/counterstrike-profile.js';
import { DockerCounterStrikeConnector } from '../src/servers/connectors/docker/counterstrike.js';

function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
  runMigrations(db);
  return db;
}

const CS = { id: 'counterstrike', name: 'Counter-Strike', backend: 'docker', container: 'cs2', port: 27015 };

// ── shared pure module ──────────────────────────────────────────────────────────
test('cs-profile validate: map (stock/ws), mode, maxPlayers', () => {
  const base = cs.defaultProfileSettings();
  assert.equal(cs.validateProfileSettings({ ...base, map: 'ws:3071005299' }).map, 'ws:3071005299');
  assert.throws(() => cs.validateProfileSettings({ ...base, map: 'ws:abc' }), /workshop id/);
  assert.throws(() => cs.validateProfileSettings({ ...base, gameMode: 'nope' }), /game mode/);
  assert.throws(() => cs.validateProfileSettings({ ...base, maxPlayers: 99 }), /maxPlayers/);
});

test('cs-profile buildChangeMapCmd: stock vs workshop vs invalid', () => {
  assert.equal(cs.buildChangeMapCmd('de_dust2'), 'changelevel de_dust2');
  assert.equal(cs.buildChangeMapCmd('ws:123'), 'host_workshop_map 123');
  assert.throws(() => cs.buildChangeMapCmd('ws:bad'), /workshop id/);
  assert.throws(() => cs.buildChangeMapCmd('bad map!'), /invalid map/);
});

test('cs-profile groups are Map & Mode / Advanced', () => {
  const { groups } = cs.profileGroups([{ value: 'de_dust2', label: 'de_dust2' }], 'note');
  assert.deepEqual(groups.map((g) => g.key), ['map', 'advanced']);
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

test('DockerCS reuses the DB-backed workshop catalog + config library', () => {
  const store = createServerStore(testDb());
  const conn = new DockerCounterStrikeConnector(CS, {}, store);
  conn.addMap({ workshopId: '42', name: 'Aim Map' });
  assert.ok(conn.listMaps().some((m) => m.workshopId === '42' && m.name === 'Aim Map'));
  const cfg = conn.createConfig({ name: 'comp', body: 'mp_maxrounds 24' });
  assert.equal(conn.getConfig(cfg.id).body, 'mp_maxrounds 24');
});

test('DockerCS live control is gated on CS2_RCON_PASSWORD', async () => {
  delete process.env.CS2_RCON_PASSWORD;
  const conn = new DockerCounterStrikeConnector(CS, {}, createServerStore(testDb()));
  assert.equal((await conn.getLive()).available, false);
  // apply pushes via RCON → without a password it fails fast (no socket opened)
  await assert.rejects(() => conn.applyProfileSettings(cs.defaultProfileSettings()), (e) => e.code === 'NO_RCON');

  process.env.CS2_RCON_PASSWORD = 'x';
  assert.equal((await conn.getLive()).available, true);
  delete process.env.CS2_RCON_PASSWORD;
});
