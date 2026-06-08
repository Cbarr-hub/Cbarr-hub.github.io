import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, runMigrations } from '../src/db.js';
import { createUser, isDuplicateUserError, STARTING_DOLLARS } from '../src/users.js';

// createUser writes to two tables (users + balances) in one transaction. These
// tests cover the happy path, genuine username clashes, and the regression where
// a stale orphan balances row was mis-reported as "username taken".

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'gt-users-'));
  const db = openDb(join(dir, 'test.sqlite')); // openDb enables FK enforcement
  runMigrations(db);
  return { db, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const PW = 'a-good-password'; // ≥ 12 chars

test('createUser inserts the user + a starting balance', async () => {
  const { db, cleanup } = freshDb();
  try {
    const id = await createUser(db, { username: 'alice', displayName: 'Alice', password: PW });
    assert.equal(db.prepare('SELECT username FROM users WHERE id=?').get(id).username, 'alice');
    assert.equal(db.prepare('SELECT dollars FROM balances WHERE user_id=?').get(id).dollars, STARTING_DOLLARS);
  } finally { cleanup(); }
});

test('a genuinely taken username (case-insensitive) is flagged as a username clash', async () => {
  const { db, cleanup } = freshDb();
  try {
    await createUser(db, { username: 'bob', displayName: 'Bob', password: PW });
    await assert.rejects(
      () => createUser(db, { username: 'BOB', displayName: 'Bob II', password: PW }),
      (err) => isDuplicateUserError(err) === true,
    );
  } finally { cleanup(); }
});

test('an orphan balances row does NOT masquerade as "username taken" — createUser self-heals', async () => {
  const { db, cleanup } = freshDb();
  try {
    // Simulate a pre-FK-cascade leftover: a balances row whose user is gone, sitting
    // on the very id the next user will be assigned (max users id + 1).
    const nextId = (db.prepare('SELECT max(id) m FROM users').get().m || 0) + 1;
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO balances (user_id, dollars) VALUES (?, ?)').run(nextId, 999);
    db.pragma('foreign_keys = ON');

    const id = await createUser(db, { username: 'carol', displayName: 'Carol', password: PW });
    assert.equal(id, nextId);
    // The stale balance is adopted/reset to the standard starting balance.
    assert.equal(db.prepare('SELECT dollars FROM balances WHERE user_id=?').get(id).dollars, STARTING_DOLLARS);
    assert.equal(db.prepare('SELECT count(*) c FROM users WHERE username=?').get('carol').c, 1);
  } finally { cleanup(); }
});

test('isDuplicateUserError matches ONLY the username constraint, not other UNIQUE errors', () => {
  assert.equal(isDuplicateUserError(new Error('UNIQUE constraint failed: users.username')), true);
  assert.equal(isDuplicateUserError(new Error('UNIQUE constraint failed: balances.user_id')), false);
  assert.equal(isDuplicateUserError(new Error('some other failure')), false);
  assert.equal(isDuplicateUserError(null), false);
});
