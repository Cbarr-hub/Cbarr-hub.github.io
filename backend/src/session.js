import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Server-side session lifetime. Every login mints a session row valid for 30
// days; the cookie's maxAge (set in server.js) mirrors this.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
// Sliding-window refresh: when a looked-up session is within 7 days of expiry,
// its expiry is bumped back to a full TTL so active users stay signed in.
const SESSION_REFRESH_THRESHOLD = 60 * 60 * 24 * 7;
export const SESSION_COOKIE = 'gt_session';

export function loadOrCreateSessionKey(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const key = readFileSync(absolute);
    if (key.length === 32) return key;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(absolute, key, { mode: 0o600 });
  return key;
}

// Mint a fresh session for `userId`: a 256-bit random id and an expiry one full
// TTL out. Returns { id, expiresAt }; the caller stores the id in the cookie.
export function createSession(db, userId) {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(id, userId, expiresAt);
  return { id, expiresAt };
}

export function destroySession(db, sessionId) {
  if (!sessionId) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// Resolve a session id to its (joined) user row, or null if the id is missing,
// unknown, or expired. Applies the sliding-window refresh: if the session is
// within SESSION_REFRESH_THRESHOLD of expiry, its expiry is extended in place.
//
// Concurrent requests for the same session can both perform the refresh UPDATE,
// but each writes essentially the same `now + TTL` value, so the double-write is
// harmless (last writer wins with a near-identical timestamp) and not worth
// guarding with a transaction.
export function lookupSession(db, sessionId) {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT s.id, s.user_id, s.expires_at,
           u.username, u.display_name, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > unixepoch()
  `).get(sessionId);
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at - now < SESSION_REFRESH_THRESHOLD) {
    const newExpiry = now + SESSION_TTL_SECONDS;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(newExpiry, sessionId);
    row.expires_at = newExpiry;
  }
  return row;
}

export { SESSION_TTL_SECONDS };
