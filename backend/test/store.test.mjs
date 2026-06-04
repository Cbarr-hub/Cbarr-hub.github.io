import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import { buildConnectors } from '../src/servers/connectors/index.js';

// In-memory DB with all migrations applied (mirrors what openDb does, minus the
// file/WAL setup which an in-memory DB doesn't need).
function testDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  );`);
  runMigrations(db);
  return db;
}

// ── seed ────────────────────────────────────────────────────────────────────────
test('migration seeds the Assembly workshop map for counterstrike', () => {
  const store = createServerStore(testDb());
  const maps = store.listWorkshopMaps('counterstrike');
  assert.equal(maps.length, 1);
  assert.equal(maps[0].workshopId, '3071005299');
  assert.equal(maps[0].name, 'Assembly');
});

// ── workshop map catalog ─────────────────────────────────────────────────────────
test('workshop maps: add, get, rename, delete, and server isolation', () => {
  const store = createServerStore(testDb());

  const added = store.addWorkshopMap('counterstrike', { workshopId: '12345', name: 'Cobblestone' });
  assert.equal(added.workshopId, '12345');
  assert.equal(added.name, 'Cobblestone');

  // numeric workshopId is coerced to text and still matches
  assert.equal(store.getWorkshopMap('counterstrike', 12345).name, 'Cobblestone');

  // re-adding the same id updates the name (upsert)
  store.addWorkshopMap('counterstrike', { workshopId: '12345', name: 'Cobble' });
  assert.equal(store.getWorkshopMap('counterstrike', '12345').name, 'Cobble');

  // rename
  assert.equal(store.renameWorkshopMap('counterstrike', '12345', 'Cobblestone II'), true);
  assert.equal(store.getWorkshopMap('counterstrike', '12345').name, 'Cobblestone II');
  assert.equal(store.renameWorkshopMap('counterstrike', 'nope', 'x'), false);

  // ordering is by name, case-insensitive (Assembly, Cobblestone II)
  assert.deepEqual(
    store.listWorkshopMaps('counterstrike').map((m) => m.name),
    ['Assembly', 'Cobblestone II'],
  );

  // a different server sees nothing
  assert.equal(store.listWorkshopMaps('factorio').length, 0);

  // delete
  assert.equal(store.deleteWorkshopMap('counterstrike', '12345'), true);
  assert.equal(store.deleteWorkshopMap('counterstrike', '12345'), false);
  assert.equal(store.getWorkshopMap('counterstrike', '12345'), null);
});

// ── config library ───────────────────────────────────────────────────────────────
test('configs: create, get, update (partial), list, delete', () => {
  const store = createServerStore(testDb());

  const cfg = store.createConfig('counterstrike', {
    name: 'bunnyhop',
    body: 'sv_cheats 1\nsv_autobunnyhopping 1\n',
  });
  assert.ok(cfg.id > 0);
  assert.equal(cfg.name, 'bunnyhop');
  assert.match(cfg.body, /autobunnyhopping/);

  // body defaults to empty string when omitted
  const empty = store.createConfig('counterstrike', { name: 'blank' });
  assert.equal(empty.body, '');

  // partial update: change body only, keep name
  const updated = store.updateConfig('counterstrike', cfg.id, { body: 'sv_cheats 0\n' });
  assert.equal(updated.name, 'bunnyhop');
  assert.equal(updated.body, 'sv_cheats 0\n');

  // updating a missing id returns null
  assert.equal(store.updateConfig('counterstrike', 9999, { name: 'x' }), null);

  // list returns metadata (no body), sorted by name
  const list = store.listConfigs('counterstrike');
  assert.deepEqual(list.map((c) => c.name), ['blank', 'bunnyhop']);
  assert.equal('body' in list[0], false);

  // getConfig is server-scoped
  assert.equal(store.getConfig('factorio', cfg.id), null);

  // delete
  assert.equal(store.deleteConfig('counterstrike', cfg.id), true);
  assert.equal(store.deleteConfig('counterstrike', cfg.id), false);
  assert.equal(store.getConfig('counterstrike', cfg.id), null);
});

test('config names are unique per server', () => {
  const store = createServerStore(testDb());
  store.createConfig('counterstrike', { name: 'dup', body: 'a' });
  assert.throws(() => store.createConfig('counterstrike', { name: 'dup', body: 'b' }));
  // same name under a different server is fine
  assert.ok(store.createConfig('factorio', { name: 'dup', body: 'b' }).id > 0);
});

// ── wiring ───────────────────────────────────────────────────────────────────────
test('buildConnectors injects the store into every connector', () => {
  const store = createServerStore(testDb());
  const connectors = buildConnectors({ proxmox: /* client */ {} }, store);
  for (const c of connectors.values()) {
    assert.equal(c.store, store);
  }
});

test('buildConnectors tolerates a null store (no DB wired)', () => {
  const connectors = buildConnectors({ proxmox: {} }, null);
  assert.equal(connectors.get('counterstrike').store, null);
});
