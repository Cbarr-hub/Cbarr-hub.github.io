import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { testDb } from './test-db.js';
import forumRoutes from '../src/routes/forum.js';

// Boot the forum route module over a real in-memory DB (FK enforcement ON, so
// the comments.thread_id FK actually fires). The harness stubs auth + CSRF so we
// exercise the handler logic, not the middleware.
async function forumApp({ user = { id: 1 } } = {}) {
  const db = testDb({ foreignKeys: true });
  // A user is required for the author_id FK on threads/comments.
  if (user) {
    db.prepare(
      'INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
    ).run(user.id, `u${user.id}`, `U${user.id}`, 'hash');
  }

  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('csrfProtection', async () => {}); // no-op: CSRF passes
  app.decorateRequest('currentUser', null);
  app.addHook('onRequest', async (req) => { req.currentUser = user; });
  await app.register(forumRoutes, { prefix: '/api/forum' });
  return { app, db };
}

test('POST comment 404s when the thread does not exist (pre-check)', async () => {
  const { app } = await forumApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forum/threads/999/comments',
      payload: { body: 'orphan comment' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'thread not found');
  } finally {
    await app.close();
  }
});

test('POST comment inserts on a live thread', async () => {
  const { app, db } = await forumApp();
  db.prepare('INSERT INTO threads (id, author_id, title, body) VALUES (1, 1, ?, ?)')
    .run('t', 'b');
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forum/threads/1/comments',
      payload: { body: 'a real comment' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Number.isInteger(res.json().id));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comments').get().n, 1);
  } finally {
    await app.close();
  }
});

test('POST comment maps the FK-violation TOCTOU to a clean 404, not a 500', async () => {
  // Simulate the race: the pre-check sees the thread, then it's deleted before
  // the insert. We force that ordering by deleting the thread inside a route
  // onRequest hook is overkill; instead delete via a stubbed prepare. Simplest:
  // make the pre-check pass against a thread that the insert then can't satisfy
  // by deleting it between handler steps using a SELECT-trigger is not portable.
  // So: open with FK ON, insert thread, then monkeypatch db.prepare so the
  // existence SELECT still returns the row but the table is empty at insert time.
  const { app, db } = await forumApp();
  db.prepare('INSERT INTO threads (id, author_id, title, body) VALUES (1, 1, ?, ?)')
    .run('t', 'b');

  const realPrepare = db.prepare.bind(db);
  let firstSelect = true;
  db.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (sql.startsWith('SELECT id FROM threads') && firstSelect) {
      firstSelect = false;
      return {
        get: (...args) => {
          const row = stmt.get(...args);          // thread still present
          realPrepare('DELETE FROM threads WHERE id = ?').run(1); // race: delete
          return row;                              // pre-check passes anyway
        },
      };
    }
    return stmt;
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forum/threads/1/comments',
      payload: { body: 'comment into a vanished thread' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'thread not found');
  } finally {
    db.prepare = realPrepare;
    await app.close();
  }
});
