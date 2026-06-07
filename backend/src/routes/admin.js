import { requireAdmin } from '../middleware/auth.js';
import { createUser, isDuplicateUserError } from '../users.js';

// Admin user-management routes (mounted at /api/admin). Every route is
// admin-gated via requireAdmin, and the mutating ones (POST/DELETE) also run
// app.csrfProtection:
//   POST   /users      create a user (409 on dup, 400 on validation)
//   GET    /users      list users (no password hashes)
//   DELETE /users/:id  delete a user (400 self-delete, 404 if missing)
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
    try {
      return { id: await createUser(app.db, { username, displayName, password, isAdmin }) };
    } catch (err) {
      if (isDuplicateUserError(err)) {
        return reply.code(409).send({ error: 'username taken' });
      }
      // createUser re-validates after trimming (e.g. an all-whitespace displayName
      // that slips past the schema's pre-trim minLength) — surface that as a 400,
      // not a generic 500.
      if (err.code === 'VALIDATION_ERROR') {
        return reply.code(400).send({ error: err.message });
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
