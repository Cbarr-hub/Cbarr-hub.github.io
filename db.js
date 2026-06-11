// Thin client for the Gamertown backend. Every function calls /api/* on the
// same origin. The browser no longer talks to Supabase directly.
//
// Function names are preserved from the pre-backend version so existing
// callers don't have to change. Where a function used to take a username or
// author argument, the server now derives that from the session cookie —
// the argument is accepted and ignored.

const API = '/api';

// CSRF token cache. The backend's @fastify/csrf-protection is session-bound
// (sessionPlugin: '@fastify/secure-session'), so a token stays valid for the
// life of the secure-session cookie — including across login, since login
// reuses the same cookie rather than rotating its CSRF secret. We therefore
// fetch once and reuse. dbLogout() clears it (defensive); a hard navigation
// after sign-in resets this module's state anyway.
let csrfToken = null;

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  const res = await fetch(`${API}/csrf`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`csrf token fetch failed (${res.status})`);
  const { token } = await res.json();
  csrfToken = token;
  return token;
}

// Single fetch wrapper every db* helper goes through — ALSO exported directly:
// the servers panel (servers.html) calls api() with raw /servers, /admin/db and
// /admin/economy paths instead of one named wrapper per endpoint. Contract:
//   - Always same-origin with cookies (the session is an HttpOnly cookie).
//   - GET/HEAD send no body and no CSRF header; any other method sends a JSON
//     body (when `body` is given) and an `x-csrf-token` header.
//   - `query` is an object → URLSearchParams; null/undefined values are dropped.
//   - Response shape: HTTP 204 → null; otherwise the parsed JSON body (or null
//     for an empty body). Non-2xx throws an Error whose `.message` is the
//     server's `error` field (falling back to `request failed (<status>)`),
//     with `.status` and `.data` attached for callers that need them.
export async function api(path, { method = 'GET', body, query, _retried = false } = {}) {
  const headers = { 'Accept': 'application/json' };
  const init = { method, credentials: 'same-origin', headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-csrf-token'] = await getCsrfToken();
  }

  let url = `${API}${path}`;
  if (query) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) usp.set(k, String(v));
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Self-heal a stale CSRF token exactly once. The cached token (and the
    // server's _csrf secret) can be dropped when the secure-session cookie is
    // lost — an expired/invalid session, or the 30-day maxAge elapsing on a
    // long-lived polling page — which makes csrfProtection 403 every mutating
    // request. The stale cached token would then fail forever. So on a
    // CSRF-shaped 403 from a mutating request, clear the cache and retry once
    // (which re-fetches a fresh token via getCsrfToken). A genuinely logged-out
    // user still fails the retry and sees the error as before; non-CSRF 403s
    // (e.g. "admin required") are never retried.
    const isMutating = method !== 'GET' && method !== 'HEAD';
    const csrfShaped =
      /csrf/i.test(data?.error ?? '') || String(data?.code ?? '').startsWith('FST_CSRF');
    if (isMutating && res.status === 403 && csrfShaped && !_retried) {
      csrfToken = null;
      return api(path, { method, body, query, _retried: true });
    }
    const err = new Error(data?.error ?? `request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Balance ───────────────────────────────────────────────────────────────────

export async function dbUpsertBalance(_username, dollers, _ignoreDuplicates = false) {
  await api('/balances/me', { method: 'POST', body: { dollars: Math.round(dollers) } });
}

export async function dbGetBalance(username) {
  // Server returns balance for the signed-in user via /balances/me; for arbitrary
  // users we filter the public list. Kept for back-compat with existing callers.
  const all = await api('/balances');
  const row = (all ?? []).find(b => b.name === username);
  return row ? { Dollers: row.dollars } : null;
}

export async function dbGetMyBalance() {
  const row = await api('/balances/me');
  return row?.dollars ?? null;
}

export async function dbGetAllBalances() {
  const rows = await api('/balances');
  return (rows ?? []).map(r => ({ Name: r.name, Dollers: r.dollars }));
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function dbGetAllUsers() {
  // User enumeration is intentionally not exposed by the backend. Callers that
  // need display names should use dbGetAllBalances() instead.
  return [];
}

export async function dbFindUser(username, password) {
  await api('/auth/login', { method: 'POST', body: { username, password } });
  const me = await api('/me');
  return { Username: me.username };
}

export async function dbInsertUser(_username, _password) {
  throw new Error('Public sign-up is disabled. Ask an admin to create your account.');
}

export async function dbLogout() {
  await api('/auth/logout', { method: 'POST' });
  csrfToken = null;
}

export async function dbWhoAmI() {
  try {
    return await api('/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

// ── gambling_events ───────────────────────────────────────────────────────────

export async function dbGetEvents({ fields: _fields = '*', ascending = false, limit } = {}) {
  const rows = await api('/events', { query: { ascending, limit } });
  return (rows ?? []).map(r => ({
    ...r.payload,
    id: r.id,
    type: r.type,
    created_at: r.created_at,
    author: r.author,
  }));
}

export async function dbInsertEvent(event) {
  const { type, ...payload } = event ?? {};
  // buildGamblingEvent uses event_type, not type — fall back so both work
  const eventType = type ?? payload.event_type;
  if (!eventType) throw new Error('event type is required');
  await api('/events', { method: 'POST', body: { type: eventType, payload } });
}

// ── games (wheel page) ────────────────────────────────────────────────────────

export async function dbGetAllGames() {
  return (await api('/games')) ?? [];
}

// ── reviews (testimony registry) ──────────────────────────────────────────────

export async function dbGetReviews() {
  return (await api('/reviews')) ?? [];
}

export async function dbAddReview({ name, rating, message }) {
  return api('/reviews', { method: 'POST', body: { name, rating, message } });
}

// ── game-server presence (servers page) ──────────────────────────────────────
// The rest of the servers/admin-db/admin-economy surface is reached straight
// through api() above (see servers.html); only the activity feed keeps a named
// wrapper. includeUnlinked:true folds in the old dbGetActivityAll (link queue).
export async function dbGetActivity({ limit, includeUnlinked } = {}) {
  return (await api('/servers/activity', {
    query: { limit, includeUnlinked: includeUnlinked ? true : undefined },
  })) ?? [];
}

// ── leaderboard (fishtank page) ───────────────────────────────────────────────

export async function dbInsertScore(_name, seconds) {
  await api('/leaderboard', { method: 'POST', body: { seconds } });
}

export async function dbGetTopScores(limit = 10) {
  return (await api('/leaderboard', { query: { limit } })) ?? [];
}

// ── forum (threads + comments) ────────────────────────────────────────────────

export async function dbGetThreads() {
  const rows = await api('/forum/threads');
  return (rows ?? []).map(r => ({
    ...r,
    comments: [{ count: r.comment_count }],
  }));
}

export async function dbGetThread(id) {
  return api(`/forum/threads/${encodeURIComponent(id)}`);
}

export async function dbInsertThread(_author, title, body) {
  await api('/forum/threads', { method: 'POST', body: { title, body } });
}

export async function dbGetThreadComments(threadId) {
  return (await api(`/forum/threads/${encodeURIComponent(threadId)}/comments`)) ?? [];
}

export async function dbInsertComment(threadId, _author, body) {
  await api(`/forum/threads/${encodeURIComponent(threadId)}/comments`, {
    method: 'POST',
    body: { body },
  });
}
