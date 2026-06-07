import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';
import { createServerStore } from '../src/servers/store.js';
import { createEconomy } from '../src/economy.js';
import { listServers } from '../src/servers/registry.js';

const steam = (name, uid) => ({ name, uid, identityKind: 'steam' });

// A DB with the schema, the hosted games seeded, and one site user (+balance).
function setup() {
  const db = testDb({ foreignKeys: true });
  const store = createServerStore(db);
  store.seedHostedGames(listServers());
  const eco = createEconomy(db);
  const userId = db.prepare(
    'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)',
  ).run('wiley', 'Wiley', 'x').lastInsertRowid;
  db.prepare('INSERT INTO balances (user_id, dollars) VALUES (?, ?)').run(userId, 5000);
  const balanceOf = (uid = userId) => db.prepare('SELECT dollars FROM balances WHERE user_id = ?').get(uid).dollars;
  const playerId = (uid) => db.prepare('SELECT id FROM players WHERE uid = ?').get(uid).id;
  // Open + immediately close a session so a players row exists and is "settled".
  const seenPlayer = (uid, name = 'P') => {
    const sid = store.recordJoin('gmod', steam(name, uid), 1, 'rcon');
    store.closeSession(sid, 2);
    return playerId(uid);
  };
  return { db, store, eco, userId, balanceOf, playerId, seenPlayer };
}

test('getEconomySettings returns the migration defaults', () => {
  const { eco } = setup();
  assert.deepEqual(eco.getEconomySettings(), { dollarsPerHour: 100, maxSessionMinutes: 600 });
});

test('setEconomySettings updates + clamps and persists', () => {
  const { eco } = setup();
  assert.deepEqual(eco.setEconomySettings({ dollarsPerHour: 250 }), { dollarsPerHour: 250, maxSessionMinutes: 600 });
  // negative rate clamps to 0; cap floors at 1
  assert.deepEqual(eco.setEconomySettings({ dollarsPerHour: -5, maxSessionMinutes: 0 }), { dollarsPerHour: 0, maxSessionMinutes: 1 });
  // partial update keeps the other value
  assert.equal(eco.setEconomySettings({ maxSessionMinutes: 120 }).dollarsPerHour, 0);
});

test('listPlayers reports seen players with lifetime playtime and link state', () => {
  const { store, eco, userId, playerId } = setup();
  const sid = store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.closeSession(sid, 1000 + 3600); // 1h
  let [p] = eco.listPlayers();
  assert.equal(p.uid, '111');
  assert.equal(p.sessions, 1);
  assert.equal(p.totalMinutes, 60);
  assert.equal(p.userId, null); // unlinked

  eco.linkAccount(playerId('111'), userId);
  [p] = eco.listPlayers();
  assert.equal(p.userId, userId);
  assert.equal(p.userName, 'Wiley');
});

test('linking settles pre-link closed sessions without paying for them', () => {
  const { store, eco, userId, balanceOf, playerId, db } = setup();
  const sid = store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.closeSession(sid, 1000 + 3600); // 1h BEFORE linking

  eco.linkAccount(playerId('111'), userId);
  // that session is now stamped credited_at (settled, not paid)
  assert.equal(db.prepare('SELECT credited_at FROM server_sessions WHERE id = ?').get(sid).credited_at != null, true);

  const res = eco.creditPlaytime();
  assert.equal(res.dollars, 0);
  assert.equal(balanceOf(), 5000); // unchanged — pre-link playtime isn't paid
});

test('creditPlaytime pays post-link closed sessions once (idempotent)', () => {
  const { store, eco, userId, balanceOf, seenPlayer } = setup();
  eco.linkAccount(seenPlayer('111', 'Alice'), userId);
  // a 2h session entirely after the link
  const sid = store.recordJoin('gmod', steam('Alice', '111'), 10_000, 'rcon');
  store.closeSession(sid, 10_000 + 2 * 3600);

  const res = eco.creditPlaytime();
  assert.equal(res.sessions, 1);
  assert.equal(res.dollars, 200);      // 2h * $100/h
  assert.equal(balanceOf(), 5200);

  // running again pays nothing (already credited)
  assert.deepEqual(eco.creditPlaytime(), { sessions: 0, dollars: 0, byUser: {} });
  assert.equal(balanceOf(), 5200);
});

test('a session longer than the cap is paid only up to the cap', () => {
  const { store, eco, userId, balanceOf, seenPlayer } = setup();
  eco.setEconomySettings({ dollarsPerHour: 100, maxSessionMinutes: 60 }); // cap 1h
  eco.linkAccount(seenPlayer('111', 'A'), userId);
  const sid = store.recordJoin('gmod', steam('A', '111'), 10_000, 'rcon');
  store.closeSession(sid, 10_000 + 5 * 3600); // 5h, but cap is 1h
  assert.equal(eco.creditPlaytime().dollars, 100); // capped to 1h * $100
  assert.equal(balanceOf(), 5100);
});

test('unlinked players never earn; unlink removes the link', () => {
  const { store, eco, userId, balanceOf, playerId } = setup();
  // unlinked player with a closed session
  const sid = store.recordJoin('gmod', steam('Bob', '222'), 10_000, 'rcon');
  store.closeSession(sid, 10_000 + 3600);
  assert.equal(eco.creditPlaytime().dollars, 0);
  assert.equal(balanceOf(), 5000);

  // link, unlink — a session after unlink earns nothing
  eco.linkAccount(playerId('222'), userId);
  eco.linkAccount(playerId('222'), null); // unlink
  const sid2 = store.recordJoin('gmod', steam('Bob', '222'), 20_000, 'rcon');
  store.closeSession(sid2, 20_000 + 3600);
  assert.equal(eco.creditPlaytime().dollars, 0);
  assert.equal(balanceOf(), 5000);
});

test('open (still-online) sessions are not credited until they close', () => {
  const { store, eco, userId, balanceOf, seenPlayer } = setup();
  eco.linkAccount(seenPlayer('111', 'A'), userId);
  store.recordJoin('gmod', steam('A', '111'), 10_000, 'rcon'); // still open (no closeSession)
  assert.equal(eco.creditPlaytime().dollars, 0);
  assert.equal(balanceOf(), 5000);
});

test('linkAccount validates player and user existence', () => {
  const { eco, userId, store, playerId } = setup();
  assert.throws(() => eco.linkAccount(9999, userId), (e) => e.code === 'UNKNOWN_PLAYER');
  store.recordJoin('gmod', steam('A', '111'), 1, 'rcon');
  assert.throws(() => eco.linkAccount(playerId('111'), 9999), (e) => e.code === 'UNKNOWN_USER');
});
