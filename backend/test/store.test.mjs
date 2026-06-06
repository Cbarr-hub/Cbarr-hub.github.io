import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';
import { createServerStore } from '../src/servers/store.js';
import { buildConnectors } from '../src/servers/connectors/index.js';
import { listServers } from '../src/servers/registry.js';

// In-memory DB with all migrations applied (mirrors what openDb does, minus the
// file/WAL setup which an in-memory DB doesn't need).
function testDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // match openDb so the new FK REFERENCES are exercised
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
  const connectors = buildConnectors({ docker: /* client */ {} }, store);
  for (const c of connectors.values()) {
    assert.equal(c.store, store);
  }
});

test('buildConnectors tolerates a null store (no DB wired)', () => {
  const connectors = buildConnectors({ docker: {} }, null);
  assert.equal(connectors.get('counterstrike').store, null);
});

// ── player-session tracking ──────────────────────────────────────────────────────
const steam = (name, uid) => ({ name, uid, identityKind: 'steam' });

test('seedHostedGames registers the five servers in games(hosted=1)', () => {
  const db = testDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const hosted = db.prepare('SELECT slug, identity_kind AS k FROM games WHERE hosted = 1 ORDER BY slug').all();
  assert.deepEqual(hosted.map((r) => r.slug), ['counterstrike', 'factorio', 'gmod', 'minecraft', 'prophunt']);
  assert.equal(hosted.find((r) => r.slug === 'minecraft').k, 'minecraft');
  // idempotent re-seed doesn't duplicate
  store.seedHostedGames(listServers());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM games WHERE hosted = 1').get().n, 5);
  // party-games rows are untouched (still hosted=0)
});

test('recordJoin opens a session + upserts the global player; closeSession ends it', () => {
  const db = testDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());

  const sid = store.recordJoin('gmod', steam('Alice', '76561197960290419'), 1000, 'rcon');
  assert.ok(sid > 0);
  let open = store.listOpenSessions('gmod');
  assert.equal(open.length, 1);
  assert.equal(open[0].name, 'Alice');
  assert.equal(open[0].uid, '76561197960290419');
  assert.equal(open[0].identityKind, 'steam');

  // one players row, linked to the session
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  assert.equal(db.prepare('SELECT player_id FROM server_sessions WHERE id = ?').get(sid).player_id != null, true);

  assert.equal(store.closeSession(sid, 1600), true);
  assert.equal(store.listOpenSessions('gmod').length, 0);
  const all = store.listSessions('gmod');
  assert.equal(all.length, 1);
  assert.equal(all[0].left_at, 1600);
});

test('a rejoin updates the player name/last_seen without a duplicate player row', () => {
  const db = testDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '76561197960290419'), 1000, 'rcon');
  store.recordJoin('gmod', steam('Alice_2', '76561197960290419'), 2000, 'rcon');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  assert.equal(db.prepare('SELECT name FROM players').get().name, 'Alice_2');
  assert.equal(store.listOpenSessions('gmod').length, 2);
  // The RETURNING-on-conflict (DO UPDATE) path must link BOTH sessions to the one
  // players row — this is what the whitelist-seed design hinges on.
  const playerId = db.prepare('SELECT id FROM players').get().id;
  const links = db.prepare('SELECT player_id FROM server_sessions ORDER BY id').all();
  assert.deepEqual(links, [{ player_id: playerId }, { player_id: playerId }]);
});

test('a SteamID player spans games as ONE player row (whitelist seed)', () => {
  const db = testDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '76561197960290419'), 1000, 'rcon');
  store.recordJoin('prophunt', steam('Alice', '76561197960290419'), 1100, 'rcon');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  // Both the gmod and prophunt sessions resolve to that single cross-game player row.
  const playerId = db.prepare('SELECT id FROM players').get().id;
  const links = db.prepare('SELECT player_id FROM server_sessions ORDER BY id').all();
  assert.deepEqual(links, [{ player_id: playerId }, { player_id: playerId }]);
});

test('a null-uid session (CS2-redacted) records no player row', () => {
  const db = testDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const sid = store.recordJoin('counterstrike', steam('Carol', null), 1000, 'rcon');
  assert.ok(sid > 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 0);
  const row = db.prepare('SELECT player_id, uid FROM server_sessions WHERE id = ?').get(sid);
  assert.equal(row.player_id, null);
  assert.equal(row.uid, null);
});

test('closeAllOpenSessions reconciles every open row', () => {
  const store = createServerStore(testDb());
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.recordJoin('minecraft', { name: 'Notch', uid: 'uuid-1', identityKind: 'minecraft' }, 1000, 'log');
  assert.equal(store.closeAllOpenSessions(2000), 2);
  assert.equal(store.listOpenSessions('gmod').length, 0);
  assert.equal(store.listSessions('minecraft')[0].source, 'reconciled');
});

test('session methods on an unknown slug return [] / null instead of throwing', () => {
  const store = createServerStore(testDb());
  store.seedHostedGames(listServers());
  assert.deepEqual(store.listSessions('nope'), []);
  assert.deepEqual(store.listOpenSessions('nope'), []);
  assert.equal(store.recordJoin('nope', steam('x', '1'), 1, 'rcon'), null);
});
