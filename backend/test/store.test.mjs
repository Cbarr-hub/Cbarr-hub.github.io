import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';
import { createServerStore } from '../src/servers/store.js';
import { buildConnectors } from '../src/servers/connectors/index.js';
import { listServers } from '../src/servers/registry.js';

const storeDb = () => testDb({ foreignKeys: true });
function addUser(db, id, name) {
  db.prepare('INSERT INTO users (id, username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)')
    .run(id, `user${id}`, name, 'hash');
  return id;
}
function linkPlayer(db, identityKind, uid, userId) {
  const player = db.prepare('SELECT id FROM players WHERE identity_kind = ? AND uid = ?').get(identityKind, uid);
  assert.ok(player, `missing player ${identityKind}:${uid}`);
  db.prepare('INSERT INTO player_accounts (player_id, user_id) VALUES (?, ?)').run(player.id, userId);
  return player.id;
}

// ── seed ────────────────────────────────────────────────────────────────────────
test('migration seeds the Assembly workshop map for counterstrike', () => {
  const store = createServerStore(storeDb());
  const maps = store.listWorkshopMaps('counterstrike');
  assert.equal(maps.length, 1);
  assert.equal(maps[0].workshopId, '3071005299');
  assert.equal(maps[0].name, 'Assembly');
});

// ── workshop map catalog ─────────────────────────────────────────────────────────
test('workshop maps: add, get, rename, delete, and server isolation', () => {
  const store = createServerStore(storeDb());

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
  const store = createServerStore(storeDb());

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
  const store = createServerStore(storeDb());
  store.createConfig('counterstrike', { name: 'dup', body: 'a' });
  assert.throws(() => store.createConfig('counterstrike', { name: 'dup', body: 'b' }));
  // same name under a different server is fine
  assert.ok(store.createConfig('factorio', { name: 'dup', body: 'b' }).id > 0);
});

// ── wiring ───────────────────────────────────────────────────────────────────────
test('buildConnectors injects the store into every connector', () => {
  const store = createServerStore(storeDb());
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

// Count still-open sessions (left_at IS NULL) for a hosted slug straight from the
// DB — the store no longer exposes a listOpenSessions helper (the API derives
// "online" from left_at on the regular session list).
const openCount = (db, slug) =>
  db.prepare(
    `SELECT COUNT(*) n FROM server_sessions s
       JOIN games g ON g.id = s.game_id
      WHERE g.slug = ? AND s.left_at IS NULL`,
  ).get(slug).n;

test('seedHostedGames registers the five servers in games(hosted=1)', () => {
  const db = storeDb();
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
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());

  const sid = store.recordJoin('gmod', steam('Alice', '76561197960290419'), 1000, 'rcon');
  assert.ok(sid > 0);
  assert.equal(openCount(db, 'gmod'), 1);
  const [open] = store.listSessions('gmod', { includeUnlinked: true });
  assert.equal(open.left_at, null); // still online
  assert.equal(open.name, 'Alice');
  assert.equal(open.uid, '76561197960290419');
  assert.equal(open.identityKind, 'steam');

  // one players row, linked to the session
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  assert.equal(db.prepare('SELECT player_id FROM server_sessions WHERE id = ?').get(sid).player_id != null, true);

  assert.equal(store.closeSession(sid, 1600), true);
  assert.equal(openCount(db, 'gmod'), 0);
  const all = store.listSessions('gmod', { includeUnlinked: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].left_at, 1600);
});

test('a rejoin updates the player name/last_seen without a duplicate player row', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '76561197960290419'), 1000, 'rcon');
  store.recordJoin('gmod', steam('Alice_2', '76561197960290419'), 2000, 'rcon');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  assert.equal(db.prepare('SELECT name FROM players').get().name, 'Alice_2');
  assert.equal(openCount(db, 'gmod'), 2);
  // The RETURNING-on-conflict (DO UPDATE) path must link BOTH sessions to the one
  // players row — this is what the whitelist-seed design hinges on.
  const playerId = db.prepare('SELECT id FROM players').get().id;
  const links = db.prepare('SELECT player_id FROM server_sessions ORDER BY id').all();
  assert.deepEqual(links, [{ player_id: playerId }, { player_id: playerId }]);
});

test('a SteamID player spans games as ONE player row (whitelist seed)', () => {
  const db = storeDb();
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
  const db = storeDb();
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
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.recordJoin('minecraft', { name: 'Notch', uid: 'uuid-1', identityKind: 'minecraft' }, 1000, 'log');
  assert.equal(store.closeAllOpenSessions(2000), 2);
  assert.equal(openCount(db, 'gmod'), 0);
  assert.equal(store.listSessions('minecraft', { includeUnlinked: true })[0].source, 'reconciled');
});

test('session methods on an unknown slug return [] / null instead of throwing', () => {
  const store = createServerStore(storeDb());
  store.seedHostedGames(listServers());
  assert.deepEqual(store.listSessions('nope'), []);
  assert.equal(store.recordJoin('nope', steam('x', '1'), 1, 'rcon'), null);
});

// ── presence + cross-game activity ────────────────────────────────────────────────
test('onlineCountsBySlug counts only linked still-open sessions, per slug', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');       // open
  const closed = store.recordJoin('gmod', steam('Bob', '222'), 1000, 'rcon');
  store.closeSession(closed, 1100);                                     // closed → not counted
  store.recordJoin('minecraft', { name: 'Notch', uid: 'u1', identityKind: 'minecraft' }, 1000, 'log'); // open
  addUser(db, 1, 'Alice User');
  addUser(db, 2, 'Notch User');
  linkPlayer(db, 'steam', '111', 1);
  linkPlayer(db, 'minecraft', 'u1', 2);
  assert.deepEqual(store.onlineCountsBySlug(), { gmod: 1, minecraft: 1 });
});

test('listOnline returns the live roster across hosted servers with game name', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  const closed = store.recordJoin('gmod', steam('Bob', '222'), 900, 'rcon');
  store.closeSession(closed, 950);
  addUser(db, 1, 'Alice User');
  linkPlayer(db, 'steam', '111', 1);
  const online = store.listOnline();
  assert.equal(online.length, 1);
  assert.equal(online[0].name, 'Alice');
  assert.equal(online[0].userName, 'Alice User');
  assert.equal(online[0].slug, 'gmod');
  assert.equal(online[0].gameName, 'TTT');
});

test('recentSessions merges linked servers newest-first and respects limit', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('A', '1'), 1000, 'rcon');
  store.recordJoin('minecraft', { name: 'B', uid: 'u', identityKind: 'minecraft' }, 2000, 'log');
  store.recordJoin('prophunt', steam('C', '3'), 1500, 'rcon');
  addUser(db, 1, 'A User');
  addUser(db, 2, 'B User');
  addUser(db, 3, 'C User');
  linkPlayer(db, 'steam', '1', 1);
  linkPlayer(db, 'minecraft', 'u', 2);
  linkPlayer(db, 'steam', '3', 3);
  const all = store.recentSessions({ limit: 100 });
  assert.deepEqual(all.map((s) => s.name), ['B', 'C', 'A']); // by joined_at DESC
  assert.deepEqual(all.map((s) => s.userName), ['B User', 'C User', 'A User']);
  assert.equal(all[0].slug, 'minecraft');
  assert.equal(store.recentSessions({ limit: 1 }).length, 1);
});
