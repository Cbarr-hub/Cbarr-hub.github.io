import argon2 from 'argon2';
import { requireAdmin } from '../middleware/auth.js';

export default async function adminRoutes(app) {
  app.post('/users', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['username', 'displayName', 'password'],
        properties: {
          username: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' },
          displayName: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 12, maxLength: 512 },
          isAdmin: { type: 'boolean', default: false },
        },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const { username, displayName, password, isAdmin } = req.body;
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const result = app.db.transaction(() => {
        const r = app.db.prepare(
          'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
        ).run(username, displayName, hash, isAdmin ? 1 : 0);
        app.db.prepare(
          'INSERT INTO balances (user_id, dollars) VALUES (?, 5000)'
        ).run(r.lastInsertRowid);
        return r.lastInsertRowid;
      })();
      return { id: result };
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'username taken' });
      }
      throw err;
    }
  });

  app.get('/users', { preHandler: requireAdmin }, async () => {
    return app.db.prepare(`
      SELECT id, username, display_name, is_admin, created_at
      FROM users ORDER BY created_at DESC
    `).all();
  });

  app.delete('/users/:id', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    if (req.params.id === req.currentUser.id) {
      return reply.code(400).send({ error: 'cannot delete self' });
    }
    const result = app.db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
