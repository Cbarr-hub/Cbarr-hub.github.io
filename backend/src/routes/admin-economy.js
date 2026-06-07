// Admin economy controls: the playtime earning rate/cap, the player→account
// map, and a manual "credit now" trigger. Admin-only; mutations are CSRF-gated.
// Reads/writes go through app.economy (backend/src/economy.js).

import { requireAdmin } from '../middleware/auth.js';

export default async function adminEconomyRoutes(app) {
  const eco = app.economy;

  // Current rate + per-session cap.
  app.get('/settings', { preHandler: requireAdmin }, async () => eco.getEconomySettings());

  // Update the rate and/or cap. Both optional; validated to sane ranges.
  app.put('/settings', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        properties: {
          dollarsPerHour: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          maxSessionMinutes: { type: 'integer', minimum: 1, maximum: 100_000 },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => eco.setEconomySettings(req.body));

  // The seen-players roster with their linked account + lifetime playtime.
  app.get('/players', { preHandler: requireAdmin }, async () => eco.listPlayers());

  // Site users for the link dropdown (id + display name only).
  app.get('/users', { preHandler: requireAdmin }, async () =>
    app.db.prepare('SELECT id, display_name AS name FROM users ORDER BY display_name COLLATE NOCASE').all());

  // Link a tracked identity to a site account (userId: null unlinks).
  app.put('/players/:playerId/account', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { playerId: { type: 'integer', minimum: 1 } }, required: ['playerId'] },
      body: {
        type: 'object',
        required: ['userId'],
        properties: { userId: { type: ['integer', 'null'], minimum: 1 } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try {
      return eco.linkAccount(req.params.playerId, req.body.userId);
    } catch (err) {
      if (err.code === 'UNKNOWN_PLAYER') return reply.code(404).send({ error: 'unknown player' });
      if (err.code === 'UNKNOWN_USER') return reply.code(400).send({ error: 'unknown user' });
      throw err;
    }
  });

  // Manually run the reconciler (it also runs on a timer + at boot).
  app.post('/credit', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
  }, async () => eco.creditPlaytime());
}
