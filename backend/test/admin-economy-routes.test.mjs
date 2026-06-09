import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import adminEconomyRoutes from '../src/routes/admin-economy.js';

// Minimal app.economy stub (only what the routes touch).
function ecoStub(overrides = {}) {
  return {
    getEconomySettings: () => ({ dollarsPerHour: 100, maxSessionMinutes: 600 }),
    setEconomySettings: (b) => b,
    listPlayers: () => [],
    linkAccount: () => ({ ok: true }),
    creditPlaytime: () => ({ sessions: 0, dollars: 0, byUser: {} }),
    setPlayerIgnored: (id, ignored) => ({ ok: true, ignored: !!ignored }),
    ...overrides,
  };
}

async function ecoApp({ user = { id: 1, isAdmin: true }, economy = ecoStub() } = {}) {
  const app = Fastify({ logger: false });
  app.decorate('economy', economy);
  app.decorate('db', { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }) });
  app.decorate('csrfProtection', async (req, reply) => {
    if (req.headers['x-csrf-token'] !== 'ok') reply.code(403).send({ error: 'csrf required' });
  });
  app.decorateRequest('currentUser', null);
  app.addHook('preHandler', async (req) => { req.currentUser = user; });
  await app.register(adminEconomyRoutes, { prefix: '/api/admin/economy' });
  return app;
}

const IGNORE = '/api/admin/economy/players/7/ignore';

test('PUT ignore dismisses a player with admin + csrf and forwards args', async () => {
  const calls = [];
  const app = await ecoApp({
    economy: ecoStub({ setPlayerIgnored: (id, ig) => { calls.push([id, ig]); return { ok: true, ignored: ig }; } }),
  });
  try {
    const res = await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: { ignored: true } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, ignored: true });
    assert.deepEqual(calls, [[7, true]]);
  } finally { await app.close(); }
});

test('PUT ignore requires csrf, requires admin, and validates the body', async () => {
  let app = await ecoApp();                                   // no csrf token
  try {
    assert.equal((await app.inject({ method: 'PUT', url: IGNORE, payload: { ignored: true } })).statusCode, 403);
  } finally { await app.close(); }

  app = await ecoApp({ user: { id: 2, isAdmin: false } });    // non-admin
  try {
    assert.equal((await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: { ignored: true } })).statusCode, 403);
  } finally { await app.close(); }

  app = await ecoApp({ user: null });                          // anonymous
  try {
    assert.equal((await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: { ignored: true } })).statusCode, 401);
  } finally { await app.close(); }

  app = await ecoApp();                                        // bad body
  try {
    assert.equal((await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: { ignored: 'yes' } })).statusCode, 400);
  } finally { await app.close(); }
});

test('PUT ignore maps UNKNOWN_PLAYER to 404', async () => {
  const app = await ecoApp({
    economy: ecoStub({ setPlayerIgnored: () => { throw Object.assign(new Error('unknown player'), { code: 'UNKNOWN_PLAYER' }); } }),
  });
  try {
    const res = await app.inject({ method: 'PUT', url: IGNORE, headers: { 'x-csrf-token': 'ok' }, payload: { ignored: true } });
    assert.equal(res.statusCode, 404);
  } finally { await app.close(); }
});
