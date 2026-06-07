import { lookupSession, SESSION_COOKIE } from '../session.js';

// Global preHandler that resolves the signed-in user for every request.
// Reads the session id from the secure-session cookie, looks the (non-expired)
// session up in SQLite, and stashes the user on `req.currentUser` (left null for
// anonymous requests). A stale cookie pointing at an expired/missing session is
// cleared so the browser stops sending it. Route guards below read currentUser.
export function attachSession(app) {
  app.decorateRequest('currentUser', null);

  app.addHook('preHandler', async (req) => {
    const sessionId = req.session.get('id');
    if (!sessionId) return;
    const row = lookupSession(app.db, sessionId);
    if (!row) {
      req.session.delete();
      return;
    }
    req.currentUser = {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: row.is_admin === 1,
    };
  });
}

// Route guard: reject anonymous requests with 401. Used as a `preHandler`.
// Calling reply.send() inside a Fastify preHandler short-circuits the lifecycle,
// so the route handler never runs once we 401 here (the explicit return is for
// clarity/symmetry with requireAdmin — Fastify halts either way).
export async function requireAuth(req, reply) {
  if (!req.currentUser) {
    reply.code(401).send({ error: 'authentication required' });
    return;
  }
}

// Route guard: require an authenticated admin. 401 for anonymous, 403 for a
// signed-in non-admin. Same short-circuit semantics as requireAuth.
export async function requireAdmin(req, reply) {
  if (!req.currentUser) {
    reply.code(401).send({ error: 'authentication required' });
    return;
  }
  if (!req.currentUser.isAdmin) {
    reply.code(403).send({ error: 'admin required' });
  }
}

export { SESSION_COOKIE };
