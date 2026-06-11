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

test('listPlayers clamps each session to 24h (mirrors the store DUR cap)', () => {
  const { store, eco } = setup();
  const sid = store.recordJoin('gmod', steam('Alice', '111'), 1000, 'rcon');
  store.closeSession(sid, 1000 + 30 * 3600); // a 30h session…
  const [p] = eco.listPlayers();
  assert.equal(p.totalSeconds, 86400);       // …counts as at most 24h
  assert.equal(p.totalMinutes, 1440);
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

test('a session open across the link earns only post-link minutes when it later closes', () => {
  const { store, eco, userId, balanceOf, playerId, db } = setup();
  const T0 = 10_000;
  const T2 = 10_000 + 2 * 3600; // 2h later — the full uncapped span
  // Player joins and stays ONLINE (no closeSession) when we link the account.
  const sid = store.recordJoin('gmod', steam('A', '111'), T0, 'rcon');
  eco.linkAccount(playerId('111'), userId);

  // First link must have split the straddling session: the original row is now
  // closed + settled (credited_at stamped) so its pre-link span can never pay…
  const orig = db.prepare('SELECT left_at, credited_at FROM server_sessions WHERE id = ?').get(sid);
  assert.equal(orig.left_at != null, true);
  assert.equal(orig.credited_at != null, true);
  // …and a fresh uncredited 'reconciled' session was re-opened from link time.
  const reopened = db
    .prepare("SELECT id, left_at, credited_at FROM server_sessions WHERE player_id = ? AND source = 'reconciled' AND id != ?")
    .get(playerId('111'), sid);
  assert.equal(reopened.left_at, null);     // still open
  assert.equal(reopened.credited_at, null); // not yet paid

  // The collector later observes the leave; closeSession targets the ORIGINAL id,
  // which is already closed, so it's a no-op and the pre-link span stays settled.
  store.closeSession(sid, T2);
  // With the bug, this credits the full 2h ($200) for the pre-link window.
  const res = eco.creditPlaytime();
  assert.equal(res.dollars, 0);
  assert.equal(balanceOf(), 5000); // only post-link playtime can earn — none yet

  // Close the re-opened post-link session and confirm it bills only its own span
  // (from link time forward), never the leaked pre-link 2h.
  const linkAt = db.prepare('SELECT joined_at FROM server_sessions WHERE id = ?').get(reopened.id).joined_at;
  store.closeSession(reopened.id, linkAt + 1800); // 30 min of genuine post-link time
  const res2 = eco.creditPlaytime();
  assert.equal(res2.dollars, 50);  // 0.5h * $100/h — strictly less than the full 2h $200
  assert.equal(balanceOf(), 5050);
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

test('creditPlaytime records credited_dollars per paid session', () => {
  const { store, eco, userId, seenPlayer, db } = setup();
  eco.linkAccount(seenPlayer('111', 'A'), userId);
  const sid = store.recordJoin('gmod', steam('A', '111'), 10_000, 'rcon');
  store.closeSession(sid, 10_000 + 2 * 3600); // 2h → $200
  eco.creditPlaytime();
  assert.equal(db.prepare('SELECT credited_dollars FROM server_sessions WHERE id = ?').get(sid).credited_dollars, 200);
});

test('settle-at-link and the split pre-link span record credited_dollars = 0 (reopened stays NULL)', () => {
  const { store, eco, userId, playerId, db } = setup();
  const closed = store.recordJoin('gmod', steam('A', '111'), 1000, 'rcon');
  store.closeSession(closed, 1000 + 3600);    // closed BEFORE the link → settled
  const open = store.recordJoin('gmod', steam('A', '111'), 5000, 'rcon'); // still open at link → split
  eco.linkAccount(playerId('111'), userId);

  assert.equal(db.prepare('SELECT credited_dollars FROM server_sessions WHERE id = ?').get(closed).credited_dollars, 0);
  assert.equal(db.prepare('SELECT credited_dollars FROM server_sessions WHERE id = ?').get(open).credited_dollars, 0);
  const reopened = db.prepare(
    "SELECT credited_dollars FROM server_sessions WHERE player_id = ? AND source = 'reconciled'",
  ).get(playerId('111'));
  assert.equal(reopened.credited_dollars, null); // earns when it later closes
});

test('listPlayers.earned sums actual credited dollars (linked earns, unlinked 0)', () => {
  const { store, eco, userId, seenPlayer } = setup();
  eco.linkAccount(seenPlayer('111', 'Alice'), userId);
  const sid = store.recordJoin('gmod', steam('Alice', '111'), 10_000, 'rcon');
  store.closeSession(sid, 10_000 + 2 * 3600);
  eco.creditPlaytime();
  const unlinked = store.recordJoin('gmod', steam('Bob', '222'), 1000, 'rcon');
  store.closeSession(unlinked, 1000 + 3600);

  const players = eco.listPlayers();
  assert.equal(players.find((p) => p.uid === '111').earned, 200);
  assert.equal(players.find((p) => p.uid === '222').earned, 0);
});

test('setPlayerIgnored toggles the flag; listPlayers still includes ignored players', () => {
  const { eco, seenPlayer } = setup();
  const pid = seenPlayer('111', 'A');
  assert.equal(eco.listPlayers().find((p) => p.id === pid).ignored, 0);

  assert.deepEqual(eco.setPlayerIgnored(pid, true), { ok: true, ignored: true });
  const p = eco.listPlayers().find((x) => x.id === pid);
  assert.ok(p, 'ignored players still appear in the earnings roster');
  assert.equal(p.ignored, 1);

  eco.setPlayerIgnored(pid, false);
  assert.equal(eco.listPlayers().find((x) => x.id === pid).ignored, 0);
  assert.throws(() => eco.setPlayerIgnored(9999, true), (e) => e.code === 'UNKNOWN_PLAYER');
});
