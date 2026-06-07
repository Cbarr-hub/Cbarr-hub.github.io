import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import { testDb } from './test-db.js';
import eventsRoutes from '../src/routes/events.js';

// Build a Fastify app with the events routes mounted and a real in-memory DB.
async function eventsApp({ user = { id: 1, isAdmin: false } } = {}) {
  const db = testDb();
  db.prepare(
    'INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)',
  ).run(1, 'wiley', 'Wiley', 'x');
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('csrfProtection', async (req, reply) => {
    if (req.headers['x-csrf-token'] !== 'ok') reply.code(403).send({ error: 'csrf required' });
  });
  app.decorateRequest('currentUser', null);
  app.addHook('preHandler', async (req) => { req.currentUser = user; });
  await app.register(eventsRoutes, { prefix: '/api/events' });
  return { app, db };
}

test('GET /api/events parses each row payload as JSON', async () => {
  const { app, db } = await eventsApp();
  db.prepare('INSERT INTO gambling_events (user_id, type, payload) VALUES (?, ?, ?)')
    .run(1, 'bet', JSON.stringify({ amount: 5 }));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.length, 1);
    assert.deepEqual(body[0].payload, { amount: 5 });
    assert.equal(body[0].author, 'Wiley');
  } finally {
    await app.close();
  }
});

test('GET /api/events tolerates a corrupt payload row (no 500)', async () => {
  const { app, db } = await eventsApp();
  // A row whose payload is not valid JSON — must not crash the whole feed.
  db.prepare('INSERT INTO gambling_events (user_id, type, payload) VALUES (?, ?, ?)')
    .run(1, 'bad', 'not-json{');
  db.prepare('INSERT INTO gambling_events (user_id, type, payload) VALUES (?, ?, ?)')
    .run(1, 'good', JSON.stringify({ ok: true }));
  try {
    const res = await app.inject({ method: 'GET', url: '/api/events' });
    assert.equal(res.statusCode, 200); // no 500 despite the corrupt row
    const body = res.json();
    assert.equal(body.length, 2);
    const byType = Object.fromEntries(body.map((r) => [r.type, r.payload]));
    assert.deepEqual(byType.bad, {}); // corrupt row falls back to {}
    assert.deepEqual(byType.good, { ok: true });
  } finally {
    await app.close();
  }
});
