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
test('configs: create, get, list, delete', () => {
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

// ── startup-config profiles ────────────────────────────────────────────────────────
// getProfile documents a plain-object `settings` contract, so create/update must
// coerce a non-object (null/array/scalar) to {} rather than persist it verbatim.
test('profile settings are coerced to a plain object on create/update', () => {
  const store = createServerStore(storeDb());

  // create with settings:null → stored/read back as {}
  const created = store.createProfile('counterstrike', { name: 'P1', settings: null });
  assert.deepEqual(store.getProfile('counterstrike', created.id).settings, {});

  // update with settings:null → {} (NOT null)
  store.updateProfile('counterstrike', created.id, { settings: null });
  assert.deepEqual(store.getProfile('counterstrike', created.id).settings, {});

  // update with a real object then omit settings → prior object is preserved
  store.updateProfile('counterstrike', created.id, { settings: { maxRounds: 30 } });
  store.updateProfile('counterstrike', created.id, { name: 'P1-renamed' });
  const kept = store.getProfile('counterstrike', created.id);
  assert.equal(kept.name, 'P1-renamed');
  assert.deepEqual(kept.settings, { maxRounds: 30 });

  // other non-objects (scalar, array) also coerce to {}
  const scalar = store.createProfile('counterstrike', { name: 'P2', settings: 'foo' });
  assert.deepEqual(store.getProfile('counterstrike', scalar.id).settings, {});
  const arr = store.createProfile('counterstrike', { name: 'P3', settings: [] });
  assert.deepEqual(store.getProfile('counterstrike', arr.id).settings, {});
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
  const [open] = store.listOnline(); // still online → on the live roster
  assert.equal(open.slug, 'gmod');
  assert.equal(open.name, 'Alice');
  assert.equal(open.uid, '76561197960290419');
  assert.equal(open.identityKind, 'steam');

  // one players row, linked to the session
  assert.equal(db.prepare('SELECT COUNT(*) n FROM players').get().n, 1);
  assert.equal(db.prepare('SELECT player_id FROM server_sessions WHERE id = ?').get(sid).player_id != null, true);

  assert.equal(store.closeSession(sid, 1600), true);
  assert.equal(openCount(db, 'gmod'), 0);
  assert.deepEqual(store.listOnline(), []); // closed → off the live roster
  const all = store.recentSessions({ includeUnlinked: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].slug, 'gmod');
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
  assert.equal(openCount(db, 'minecraft'), 0);
  const mc = store.recentSessions({ includeUnlinked: true }).find((s) => s.slug === 'minecraft');
  assert.equal(mc.source, 'reconciled');
  assert.equal(mc.left_at, 2000);
});

test('recordJoin on an unknown slug returns null instead of throwing', () => {
  const store = createServerStore(storeDb());
  store.seedHostedGames(listServers());
  assert.equal(store.recordJoin('nope', steam('x', '1'), 1, 'rcon'), null);
});

// ── presence + cross-game activity ────────────────────────────────────────────────
test('listOnline returns linked and unlinked live roster rows with game name', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.recordJoin('minecraft', { name: 'Notch', uid: 'u1', identityKind: 'minecraft' }, 1100, 'log');
  const closed = store.recordJoin('gmod', steam('Bob', '222'), 900, 'rcon');
  store.closeSession(closed, 950);
  addUser(db, 1, 'Alice User');
  linkPlayer(db, 'steam', '111', 1);
  const online = store.listOnline();
  assert.deepEqual(online.map((r) => r.name), ['Notch', 'Alice']);
  assert.equal(online[0].userName, null);
  assert.equal(online[0].slug, 'minecraft');
  assert.equal(online[0].gameName, 'Minecraft');
  assert.equal(online[1].userName, 'Alice User');
  assert.equal(online[1].slug, 'gmod');
  assert.equal(online[1].gameName, 'TTT');
});

// Lock each projection's column shape so the shared accountJoin/ACCOUNT_COLS
// refactor stays output-preserving (the JOINs differ, the shapes must not drift).
test('listOnline and openSessionById each project their documented column set', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const sid = store.recordJoin('minecraft', { name: 'Notch', uid: 'u1', identityKind: 'minecraft' }, 1000, 'log');

  const [row] = store.listOnline();
  assert.deepEqual(Object.keys(row).sort(), [
    'gameName', 'id', 'identityKind', 'joined_at', 'name',
    'playerId', 'slug', 'source', 'uid', 'userId', 'userName',
  ].sort());

  const byId = store.openSessionById('minecraft', sid);
  assert.deepEqual(Object.keys(byId).sort(), [
    'id', 'identityKind', 'joined_at', 'name', 'playerId',
    'source', 'uid', 'userId', 'userName',
  ].sort());
  // openSessionById is a single-row lookup: no left_at (always open) and no slug/gameName.
  assert.equal('left_at' in byId, false);
  assert.equal('slug' in byId, false);
});

test('openSessionById returns only a matching still-open session for that hosted server', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const open = store.recordJoin('minecraft', { name: 'Notch', uid: 'u1', identityKind: 'minecraft' }, 1000, 'log');
  const closed = store.recordJoin('minecraft', { name: 'Alex', uid: 'u2', identityKind: 'minecraft' }, 1000, 'log');
  store.closeSession(closed, 1200);
  assert.equal(store.openSessionById('minecraft', open).name, 'Notch');
  assert.equal(store.openSessionById('gmod', open), null);
  assert.equal(store.openSessionById('minecraft', closed), null);
});

// idx_games_slug is partial (WHERE hosted=1), so a hosted=0 game may legitimately
// share a slug with a hosted server. openSessionById must scope to hosted=1
// (the `g.hosted = 1` guard), or it could resolve a non-hosted session sharing
// the slug.
test('openSessionById ignores a non-hosted session sharing a hosted slug', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());

  // Open a real session on the hosted minecraft server for a known player.
  const sid = store.recordJoin('minecraft', { name: 'Notch', uid: 'u1', identityKind: 'minecraft' }, 1000, 'log');
  assert.ok(sid > 0);
  const playerId = db.prepare('SELECT id FROM players WHERE uid = ?').get('u1').id;

  // Forge a hosted=0 games row that re-uses the 'minecraft' slug (the partial index
  // permits it) and an open session on it for the SAME player — recordJoin can't
  // produce this, so build it with raw INSERTs.
  const { lastInsertRowid: ghostGameId } = db
    .prepare('INSERT INTO games (name, slug, identity_kind, hosted) VALUES (?, ?, ?, 0)')
    .run('Ghost Minecraft', 'minecraft', 'minecraft');
  const { lastInsertRowid: ghostSid } = db.prepare(
    `INSERT INTO server_sessions (game_id, player_id, identity_kind, uid, name, joined_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ghostGameId, playerId, 'minecraft', 'u1', 'Ghost', 2000, 'log');

  // The hosted session resolves; the ghost session is invisible despite the slug.
  assert.equal(store.openSessionById('minecraft', sid).name, 'Notch');
  assert.equal(store.openSessionById('minecraft', ghostSid), null);
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

// ── pulse activity stats ──────────────────────────────────────────────────────────
test('sessionStats aggregates totals, per-game, and top players (24h clamp + linked name)', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  addUser(db, 1, 'Linked One');

  let sid = store.recordJoin('gmod', steam('Alice', 'a1'), 1000, 'rcon');
  store.closeSession(sid, 1000 + 3600);                  // Alice: gmod 1h
  sid = store.recordJoin('gmod', steam('Bob', 'b1'), 2000, 'rcon');
  store.closeSession(sid, 2000 + 2 * 3600);              // Bob: gmod 2h
  sid = store.recordJoin('prophunt', steam('Bob', 'b1'), 4000, 'rcon');
  store.closeSession(sid, 4000 + 3600);                  // Bob: prophunt 1h (spans 2 games)
  sid = store.recordJoin('minecraft', { name: 'Alex', uid: 'amc', identityKind: 'minecraft' }, 3000, 'log');
  store.closeSession(sid, 3000 + 1800);                  // Alex: minecraft 0.5h
  store.recordJoin('gmod', steam('Carol', 'c1'), 100, 'rcon'); // open + ancient → clamps to 24h
  linkPlayer(db, 'steam', 'b1', 1);

  const s = store.sessionStats({ since: 0, tzMod: '0 minutes' });
  assert.equal(s.totals.sessions, 5);
  assert.equal(s.totals.players, 4);                     // a1, b1, amc, c1
  assert.equal(s.totals.secs, 3600 + 7200 + 3600 + 1800 + 86400); // Carol clamped to 86400

  assert.deepEqual(s.perGame.map((g) => g.slug), ['gmod', 'prophunt', 'minecraft']);
  assert.equal(s.perGame[0].secs, 3600 + 7200 + 86400);  // gmod
  assert.equal(s.perGame[0].players, 3);

  assert.equal(s.topPlayers[0].name, 'Carol');           // clamped 24h is the most
  assert.equal(s.topPlayers[0].secs, 86400);
  assert.equal(s.topPlayers[1].name, 'Bob');
  assert.equal(s.topPlayers[1].secs, 10800);
  assert.equal(s.topPlayers[1].sessions, 2);
  assert.equal(s.topPlayers[1].games, 2);                // distinct game_id count
  assert.equal(s.topPlayers[1].userName, 'Linked One');  // linked account surfaces

  // `since` excludes older joins (only Alex@3000 + Bob-prophunt@4000 remain)
  assert.equal(store.sessionStats({ since: 2500, tzMod: '0 minutes' }).totals.sessions, 2);
});

test('sessionStats heatmap buckets session starts by weekday×hour in the viewer tz', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const T = 1704067200; // 2024-01-01 00:00:00 UTC = Monday (%w=1), hour 0
  const sid = store.recordJoin('gmod', steam('A', 'a1'), T, 'rcon');
  store.closeSession(sid, T + 600);

  assert.deepEqual(store.sessionStats({ since: 0, tzMod: '0 minutes' }).heatmap, [{ wd: 1, hr: 0, n: 1 }]);
  // shift one hour earlier → 2023-12-31 23:00 = Sunday (%w=0), hour 23
  assert.deepEqual(store.sessionStats({ since: 0, tzMod: '-60 minutes' }).heatmap, [{ wd: 0, hr: 23, n: 1 }]);
});

test('sessionStats top players cap at 15 and exclude null-player (CS2) rows', () => {
  const db = storeDb();
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  for (let i = 0; i < 16; i++) {
    const sid = store.recordJoin('gmod', steam(`P${i}`, `u${i}`), 1000 + i, 'rcon');
    store.closeSession(sid, 1000 + i + (i + 1) * 60);   // increasing durations
  }
  const cs = store.recordJoin('counterstrike', steam('NameOnly', null), 5000, 'rcon'); // null uid → null player_id
  store.closeSession(cs, 5000 + 3600);

  const s = store.sessionStats({ since: 0, tzMod: '0 minutes' });
  assert.equal(s.topPlayers.length, 15);
  assert.ok(s.topPlayers.every((p) => p.playerId != null && p.name !== 'NameOnly'));
});
