import { lookupSession, SESSION_COOKIE } from '../session.js';

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

export async function requireAuth(req, reply) {
  if (!req.currentUser) {
    reply.code(401).send({ error: 'authentication required' });
  }
}

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
