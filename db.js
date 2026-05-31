// Thin client for the Gamertown backend. Every function calls /api/* on the
// same origin. The browser no longer talks to Supabase directly.
//
// Function names are preserved from the pre-backend version so existing
// callers don't have to change. Where a function used to take a username or
// author argument, the server now derives that from the session cookie —
// the argument is accepted and ignored.

const API = '/api';

let csrfToken = null;

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  const res = await fetch(`${API}/csrf`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`csrf token fetch failed (${res.status})`);
  const { token } = await res.json();
  csrfToken = token;
  return token;
}

async function api(path, { method = 'GET', body, query } = {}) {
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

// ── game-server control (servers page, admin-only) ────────────────────────────

export async function dbGetServers() {
  return (await api('/servers')) ?? [];
}

export async function dbGetServerStatus(id) {
  return api(`/servers/${encodeURIComponent(id)}`);
}

// action ∈ start | shutdown | reboot | stop
export async function dbServerAction(id, action) {
  return api(`/servers/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
  });
}

export async function dbListServerConfig(id) {
  return api(`/servers/${encodeURIComponent(id)}/config`);
}

export async function dbReadServerConfig(id, file) {
  return api(`/servers/${encodeURIComponent(id)}/config/${encodeURIComponent(file)}`);
}

export async function dbWriteServerConfig(id, file, content) {
  return api(`/servers/${encodeURIComponent(id)}/config/${encodeURIComponent(file)}`, {
    method: 'PUT',
    body: { content },
  });
}

export async function dbUpdateServer(id) {
  return api(`/servers/${encodeURIComponent(id)}/update`, { method: 'POST' });
}

export async function dbGetServerSettings(id) {
  return api(`/servers/${encodeURIComponent(id)}/settings`);
}

export async function dbSaveServerSettings(id, values) {
  return api(`/servers/${encodeURIComponent(id)}/settings`, { method: 'PUT', body: values });
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
