import { requireAuth } from '../middleware/auth.js';

export default async function balancesRoutes(app) {
  app.get('/', async () => {
    const rows = app.db.prepare(`
      SELECT u.display_name AS name, b.dollars
      FROM balances b
      JOIN users u ON u.id = b.user_id
      ORDER BY b.dollars DESC
    `).all();
    return rows;
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const row = app.db.prepare(
      'SELECT dollars FROM balances WHERE user_id = ?'
    ).get(req.currentUser.id);
    return { dollars: row?.dollars ?? 0 };
  });

  app.post('/me', {
    preHandler: requireAuth,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['dollars'],
        properties: { dollars: { type: 'integer', minimum: 0, maximum: 1_000_000_000 } },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    app.db.prepare(`
      INSERT INTO balances (user_id, dollars) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET dollars = excluded.dollars
    `).run(req.currentUser.id, req.body.dollars);
    return { ok: true };
  });
}
