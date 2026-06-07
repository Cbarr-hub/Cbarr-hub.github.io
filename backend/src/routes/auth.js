import argon2 from 'argon2';
import { createSession, destroySession } from '../session.js';

const MISSING_USER_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$aLrbt2x54aDsl/Q6P0L6dQ$QvQywnWrthKLgKmdaZpNYR3XYD2bBUWevBXMulpaOhc';

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 64 },
      password: { type: 'string', minLength: 1, maxLength: 512 },
    },
    additionalProperties: false,
  },
};

export default async function authRoutes(app) {
  // Called by Caddy forward_auth before serving any protected page.
  // Returns 204 if the session is valid, 302 to /signin.html if not.
  app.get('/gate', async (req, reply) => {
    if (req.currentUser) return reply.code(204).send();
    return reply.redirect('/signin.html', 302);
  });

  app.post('/login', {
    schema: loginSchema,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    onRequest: app.csrfProtection,
  }, async (req, reply) => {
    const { username, password } = req.body;

    const user = app.db.prepare(
      'SELECT id, password_hash FROM users WHERE username = ?'
    ).get(username);

    const hash = user?.password_hash ?? MISSING_USER_HASH;
    let valid = false;
    try {
      valid = await argon2.verify(hash, password);
    } catch {
      valid = false;
    }

    if (!user || !valid) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const { id: sessionId } = createSession(app.db, user.id);
    req.session.set('id', sessionId);

    return { ok: true };
  });

  app.post('/logout', {
    onRequest: app.csrfProtection,
  }, async (req) => {
    const sessionId = req.session.get('id');
    destroySession(app.db, sessionId);
    req.session.delete();
    return { ok: true };
  });
}
