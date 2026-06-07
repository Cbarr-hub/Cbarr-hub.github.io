import { requireAuth } from '../middleware/auth.js';

export default async function eventsRoutes(app) {
  app.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          ascending: { type: 'boolean', default: false },
        },
      },
    },
  }, async (req) => {
    const { limit, ascending } = req.query;
    const order = ascending ? 'ASC' : 'DESC';
    const sql = `
      SELECT e.id, e.type, e.payload, e.created_at, u.display_name AS author
      FROM gambling_events e JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at ${order}
      ${limit ? 'LIMIT ?' : ''}
    `;
    const rows = limit
      ? app.db.prepare(sql).all(limit)
      : app.db.prepare(sql).all();
    // Guard each parse: a single corrupt payload row shouldn't 500 the feed.
    const parsePayload = (json) => { try { return JSON.parse(json); } catch { return {}; } };
    return rows.map(r => ({ ...r, payload: parsePayload(r.payload) }));
  });

  app.post('/', {
    preHandler: requireAuth,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', minLength: 1, maxLength: 64 },
          payload: { type: 'object' },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const payload = JSON.stringify(req.body.payload ?? {});
    const result = app.db.prepare(
      'INSERT INTO gambling_events (user_id, type, payload) VALUES (?, ?, ?)'
    ).run(req.currentUser.id, req.body.type, payload);
    return { id: result.lastInsertRowid };
  });
}
