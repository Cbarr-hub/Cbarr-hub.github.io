import assert from 'node:assert/strict';
import test from 'node:test';

import { testDb } from './test-db.js';

test('migration 004 creates the reviews table', () => {
  const db = testDb();
  const cols = db.prepare('PRAGMA table_info(reviews)').all().map((c) => c.name);
  assert.deepEqual(cols.sort(), ['created_at', 'id', 'message', 'name', 'rating']);
});

test('reviews: insert + list newest-first (matches the route query)', () => {
  const db = testDb();
  const ins = db.prepare('INSERT INTO reviews (name, rating, message, created_at) VALUES (?, ?, ?, ?)');
  ins.run('Alice', 5, 'Top notch testimony', 100);
  ins.run('Bob', 3, 'It was adequate enough', 200);

  const rows = db.prepare(
    'SELECT id, name, rating, message, created_at FROM reviews ORDER BY created_at DESC',
  ).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Bob');   // newest first
  assert.equal(rows[1].name, 'Alice');
});

test('reviews: created_at defaults to a unix timestamp', () => {
  const db = testDb();
  const before = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO reviews (name, rating, message) VALUES (?, ?, ?)')
    .run('Cy', 4, 'Default timestamp please');
  const row = db.prepare('SELECT created_at FROM reviews').get();
  assert.ok(Number.isInteger(row.created_at));
  assert.ok(row.created_at >= before - 5);
});

test('reviews: rating CHECK rejects out-of-range, accepts the 1..5 edges', () => {
  const db = testDb();
  const ins = db.prepare('INSERT INTO reviews (name, rating, message) VALUES (?, ?, ?)');
  for (const bad of [0, 6, -1]) {
    assert.throws(() => ins.run('X', bad, 'a sufficiently long message'), /CHECK/);
  }
  assert.doesNotThrow(() => ins.run('Lo', 1, 'edge low value'));
  assert.doesNotThrow(() => ins.run('Hi', 5, 'edge high value'));
});
