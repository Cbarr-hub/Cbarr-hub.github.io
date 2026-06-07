// Forum (threads + comments, mounted at /api/forum). Threads and comments are
// tied to a user account (author_id FK), so the two write routes (POST /threads,
// POST /threads/:id/comments) are gated by `requireAuth` (preHandler) and
// CSRF-protected (`app.csrfProtection` onRequest). Reads (GET /threads,
// GET /threads/:id, GET /threads/:id/comments) are public and unauthenticated.
// No per-route rate limit is applied here (the global limiter, if any, still
// covers them); auth + CSRF are the write-path guards.
import { requireAuth } from '../middleware/auth.js';

export default async function forumRoutes(app) {
  app.get('/threads', async () => {
    return app.db.prepare(`
      SELECT t.id, t.title, t.body, t.created_at,
             u.display_name AS author,
             (SELECT COUNT(*) FROM comments c WHERE c.thread_id = t.id) AS comment_count
      FROM threads t
      JOIN users u ON u.id = t.author_id
      ORDER BY t.created_at DESC
    `).all();
  });

  app.get('/threads/:id', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const row = app.db.prepare(`
      SELECT t.id, t.title, t.body, t.created_at, u.display_name AS author
      FROM threads t JOIN users u ON u.id = t.author_id
      WHERE t.id = ?
    `).get(req.params.id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  app.post('/threads', {
    preHandler: requireAuth,
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['title', 'body'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', minLength: 1, maxLength: 20_000 },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const result = app.db.prepare(
      'INSERT INTO threads (author_id, title, body) VALUES (?, ?, ?)'
    ).run(req.currentUser.id, req.body.title, req.body.body);
    return { id: result.lastInsertRowid };
  });

  app.get('/threads/:id/comments', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' } } } },
  }, async (req) => {
    return app.db.prepare(`
      SELECT c.id, c.body, c.created_at, u.display_name AS author
      FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.thread_id = ?
      ORDER BY c.created_at ASC
    `).all(req.params.id);
  });

  app.post('/threads/:id/comments', {
    preHandler: requireAuth,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 5000 } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    const thread = app.db.prepare('SELECT id FROM threads WHERE id = ?').get(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'thread not found' });

    // The existence check above and the insert below are not atomic: a thread
    // deleted in the gap makes the comments.thread_id FK violation surface. Map
    // it to the same clean 404 instead of letting it bubble up as a 500.
    let result;
    try {
      result = app.db.prepare(
        'INSERT INTO comments (thread_id, author_id, body) VALUES (?, ?, ?)'
      ).run(req.params.id, req.currentUser.id, req.body.body);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return reply.code(404).send({ error: 'thread not found' });
      }
      throw err;
    }
    return { id: result.lastInsertRowid };
  });
}
