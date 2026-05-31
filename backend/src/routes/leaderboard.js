import { requireAuth } from '../middleware/auth.js';

export default async function leaderboardRoutes(app) {
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
      },
    },
  }, async (req) => {
    const { limit } = req.query;
    return app.db.prepare(`
      SELECT u.display_name AS name, l.seconds
      FROM leaderboard l JOIN users u ON u.id = l.user_id
      ORDER BY l.seconds DESC
      LIMIT ?
    `).all(limit);
  });

  app.post('/', {
    preHandler: requireAuth,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['seconds'],
        properties: { seconds: { type: 'number', minimum: 0, maximum: 86400 } },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const result = app.db.prepare(
      'INSERT INTO leaderboard (user_id, seconds) VALUES (?, ?)'
    ).run(req.currentUser.id, req.body.seconds);
    return { id: result.lastInsertRowid };
  });
}
