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

// Single fetch wrapper every db* helper goes through. Contract:
//   - Always same-origin with cookies (the session is an HttpOnly cookie).
//   - GET/HEAD send no body and no CSRF header; any other method sends a JSON
//     body (when `body` is given) and an `x-csrf-token` header.
//   - `query` is an object → URLSearchParams; null/undefined values are dropped.
//   - Response shape: HTTP 204 → null; otherwise the parsed JSON body (or null
//     for an empty body). Non-2xx throws an Error whose `.message` is the
//     server's `error` field (falling back to `request failed (<status>)`),
//     with `.status` and `.data` attached for callers that need them.
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

// ── reviews (testimony registry) ──────────────────────────────────────────────

export async function dbGetReviews() {
  return (await api('/reviews')) ?? [];
}

export async function dbAddReview({ name, rating, message }) {
  return api('/reviews', { method: 'POST', body: { name, rating, message } });
}

// ── game-server control (servers page, admin-only) ────────────────────────────

export async function dbGetServers({ mode } = {}) {
  return (await api('/servers', { query: { mode } })) ?? [];
}

export async function dbGetServerStatus(id, { mode } = {}) {
  return api(`/servers/${encodeURIComponent(id)}`, { query: { mode } });
}

// Host-level Proxmox node snapshot (CPU/RAM/load/uptime) for the dashboard.
export async function dbGetNodeStatus() {
  return api('/servers/node');
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

// ── CS workshop-map catalog ───────────────────────────────────────────────────
export async function dbListServerMaps(id) {
  return (await api(`/servers/${encodeURIComponent(id)}/maps`)) ?? [];
}

// name is optional — omit it and the backend auto-fetches the Workshop title.
export async function dbAddServerMap(id, workshopId, name) {
  const body = name == null || name === '' ? { workshopId } : { workshopId, name };
  return api(`/servers/${encodeURIComponent(id)}/maps`, { method: 'POST', body });
}

// Import every map in a public Steam Workshop collection (CS). Returns { ok, imported, maps }.
export async function dbImportServerCollection(id, collectionId) {
  return api(`/servers/${encodeURIComponent(id)}/maps/collection`, { method: 'POST', body: { collectionId } });
}

// Install collection maps into the single maps source (GMOD). Returns { ok, maps }.
export async function dbSyncServerMaps(id) {
  return api(`/servers/${encodeURIComponent(id)}/maps/sync`, { method: 'POST' });
}

export async function dbRenameServerMap(id, workshopId, name) {
  return api(`/servers/${encodeURIComponent(id)}/maps/${encodeURIComponent(workshopId)}`, { method: 'PATCH', body: { name } });
}

export async function dbDeleteServerMap(id, workshopId) {
  return api(`/servers/${encodeURIComponent(id)}/maps/${encodeURIComponent(workshopId)}`, { method: 'DELETE' });
}

// ── CS saved game-state config library ────────────────────────────────────────
export async function dbListServerConfigs(id) {
  return (await api(`/servers/${encodeURIComponent(id)}/configs`)) ?? [];
}

export async function dbGetServerConfigBody(id, configId) {
  return api(`/servers/${encodeURIComponent(id)}/configs/${encodeURIComponent(configId)}`);
}

export async function dbCreateServerConfig(id, name, body) {
  return api(`/servers/${encodeURIComponent(id)}/configs`, { method: 'POST', body: { name, body } });
}

export async function dbUpdateServerConfig(id, configId, patch) {
  return api(`/servers/${encodeURIComponent(id)}/configs/${encodeURIComponent(configId)}`, { method: 'PUT', body: patch });
}

export async function dbDeleteServerConfig(id, configId) {
  return api(`/servers/${encodeURIComponent(id)}/configs/${encodeURIComponent(configId)}`, { method: 'DELETE' });
}

// ── live / runtime commands (RCON / console) ──────────────────────────────────
export async function dbGetServerLive(id) {
  return api(`/servers/${encodeURIComponent(id)}/live`);
}

export async function dbServerLiveCommand(id, command) {
  return api(`/servers/${encodeURIComponent(id)}/live/command`, { method: 'POST', body: { command } });
}

export async function dbServerLiveAction(id, action, value) {
  const body = value === undefined ? { action } : { action, value };
  return api(`/servers/${encodeURIComponent(id)}/live/action`, { method: 'POST', body });
}

// ── player sessions (the standalone "Events" section; written host-side by the collector) ─
export async function dbGetServerSessions(id, { limit } = {}) {
  const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
  return (await api(`/servers/${encodeURIComponent(id)}/sessions${qs}`)) ?? [];
}

// ── presence + cross-game activity timeline ───────────────────────────────────
// Who's online across every hosted server, right now.
export async function dbGetOnline() {
  return (await api('/servers/online')) ?? [];
}
// Newest-first join/leave feed merged across all servers (the Activity view).
export async function dbGetActivity({ limit } = {}) {
  return (await api('/servers/activity', { query: { limit } })) ?? [];
}

// ── startup-config profiles (named, structured loadouts) ──────────────────────
export async function dbListProfiles(id) {
  return api(`/servers/${encodeURIComponent(id)}/profiles`);
}

export async function dbGetProfileSchema(id) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/schema`);
}

export async function dbGetProfile(id, profileId) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/${encodeURIComponent(profileId)}`);
}

// settings omitted → backend seeds the new profile from connector defaults.
export async function dbCreateProfile(id, name, settings) {
  const body = settings === undefined ? { name } : { name, settings };
  return api(`/servers/${encodeURIComponent(id)}/profiles`, { method: 'POST', body });
}

export async function dbUpdateProfile(id, profileId, patch) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/${encodeURIComponent(profileId)}`, { method: 'PUT', body: patch });
}

export async function dbDeleteProfile(id, profileId) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
}

export async function dbApplyProfile(id, profileId) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/${encodeURIComponent(profileId)}/apply`, { method: 'POST' });
}

export async function dbCaptureProfile(id, name) {
  return api(`/servers/${encodeURIComponent(id)}/profiles/capture`, { method: 'POST', body: { name } });
}

// ── admin DB viewer (read-only, admin-only) ───────────────────────────────────
// All GET → no CSRF needed; api() supplies cookies. Return shapes are exactly the
// /api/admin/db/* route responses (see backend/src/routes/admin-db.js).
export async function dbAdminTables() {
  return (await api('/admin/db/tables')) ?? [];
}

export async function dbAdminTableRows(table, { limit, offset, sort, dir, q } = {}) {
  return api(`/admin/db/tables/${encodeURIComponent(table)}`, {
    query: { limit, offset, sort, dir, q },
  });
}

export async function dbAdminQuery(sql) {
  return api('/admin/db/query', { query: { sql } });
}

// ── playtime economy (admin-only) ─────────────────────────────────────────────
// The earning rate ($/hour) + per-session cap, the seen-players roster with their
// linked site account, and the admin actions to set the rate / link / credit now.
export async function dbGetEconomySettings() {
  return api('/admin/economy/settings');
}

export async function dbSetEconomySettings(patch) {
  return api('/admin/economy/settings', { method: 'PUT', body: patch });
}

export async function dbGetEconomyPlayers() {
  return (await api('/admin/economy/players')) ?? [];
}

export async function dbGetEconomyUsers() {
  return (await api('/admin/economy/users')) ?? [];
}

// userId: a users.id, or null to unlink.
export async function dbLinkPlayerAccount(playerId, userId) {
  return api(`/admin/economy/players/${encodeURIComponent(playerId)}/account`, {
    method: 'PUT',
    body: { userId },
  });
}

export async function dbCreditPlaytime() {
  return api('/admin/economy/credit', { method: 'POST' });
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
