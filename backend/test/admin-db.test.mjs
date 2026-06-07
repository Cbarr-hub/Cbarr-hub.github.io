import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';

import { buildApp } from '../src/server.js';

// Spin up the real Fastify app against a throwaway on-disk DB + session key, seed
// an admin + a normal user, and exercise the admin-db routes over HTTP via
// app.inject (so the requireAdmin gate, querystring schemas, and JSON
// serialization are all in the loop). Mirrors the service tests' temp-DB style,
// but at the HTTP layer because this route's whole job is the gate + validation.

// Build an app bound to a fresh temp dir. Returns { app, dir } — caller closes
// the app and removes the dir.
async function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), 'gt-admindb-'));
  const env = {
    PORT: 0,
    HOST: '127.0.0.1',
    DB_PATH: join(dir, 'test.sqlite'),
    SESSION_KEY_PATH: join(dir, 'session-key'),
    NODE_ENV: 'test',
    PUBLIC_HOST: '127.0.0.1',
    DOCKER_HOST: '', // no docker → /api/servers degrades, irrelevant here
    DOCKER_API_VERSION: '',
  };
  const app = await buildApp(env);
  return { app, dir };
}

// Seed a user directly in the DB (bypasses the admin-create CSRF dance).
async function seedUser(app, { username, password, isAdmin }) {
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const r = app.db
    .prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)')
    .run(username, username, hash, isAdmin ? 1 : 0);
  return r.lastInsertRowid;
}

// light-my-request URL-DECODES Set-Cookie values into res.cookies. To replay a
// cookie on a later request we must re-encode it so secure-session/csrf receive
// the exact bytes they set (else "the cookie is malformed"). This jar merges
// cookies across responses and renders a proper `Cookie` header.
function mergeCookies(jar, res) {
  for (const c of res.cookies) jar.set(c.name, c.value);
  return jar;
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('; ');
}

// Log in and return the cookie header string to attach on subsequent requests.
// Establishes the secure-session cookie + a CSRF token first (login is
// CSRF-protected), then posts credentials.
async function login(app, username, password) {
  const jar = new Map();

  const csrfRes = await app.inject({ method: 'GET', url: '/api/csrf' });
  const csrfToken = csrfRes.json().token;
  mergeCookies(jar, csrfRes);

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { cookie: cookieHeader(jar), 'x-csrf-token': csrfToken },
    payload: { username, password },
  });
  assert.equal(loginRes.statusCode, 200, `login should succeed: ${loginRes.body}`);
  mergeCookies(jar, loginRes);

  return cookieHeader(jar);
}

// GET helper with an optional cookie.
function get(app, url, cookie) {
  const headers = cookie ? { cookie } : {};
  return app.inject({ method: 'GET', url, headers });
}

// ── auth gate ────────────────────────────────────────────────────────────────
test('GET /tables: 401 unauthenticated', async () => {
  const { app, dir } = await freshApp();
  try {
    const res = await get(app, '/api/admin/db/tables');
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables: 403 for a non-admin user', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'normie', password: 'a-good-password', isAdmin: false });
    const cookie = await login(app, 'normie', 'a-good-password');
    const res = await get(app, '/api/admin/db/tables', cookie);
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── schema overview ──────────────────────────────────────────────────────────
test('GET /tables: lists every real table with counts + masked columns flagged', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');

    const res = await get(app, '/api/admin/db/tables', cookie);
    assert.equal(res.statusCode, 200);
    const tables = res.json();
    const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

    // All 16 real tables + the migrations meta table; no sqlite_% internals.
    const expected = [
      'balances', 'comments', 'gambling_events', 'games', 'leaderboard', 'players',
      'reviews', 'schema_migrations', 'server_active_profile', 'server_configs',
      'server_profiles', 'server_sessions', 'server_workshop_maps', 'sessions',
      'threads', 'users',
    ];
    for (const name of expected) assert.ok(byName[name], `missing table ${name}`);
    assert.ok(!tables.some((t) => t.name.startsWith('sqlite_')));
    // ordered by name
    assert.deepEqual(tables.map((t) => t.name), [...tables.map((t) => t.name)].sort());

    // users has the admin we seeded → rows >= 1, and password_hash is flagged.
    assert.ok(byName.users.rows >= 1);
    const pw = byName.users.columns.find((c) => c.name === 'password_hash');
    assert.equal(pw.masked, true);
    const id = byName.users.columns.find((c) => c.name === 'id');
    assert.equal(id.pk, true);
    assert.equal(id.masked, undefined); // key omitted for non-masked cols
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── row grid: masking, allowlists, clamping, search, sort ────────────────────
test('GET /tables/users: masks password_hash in every row, never leaks the hash', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    await seedUser(app, { username: 'other', password: 'another-password', isAdmin: false });
    const cookie = await login(app, 'boss', 'admin-password-1');

    const res = await get(app, '/api/admin/db/tables/users', cookie);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.table, 'users');
    assert.ok(body.rows.length >= 2);
    for (const row of body.rows) {
      assert.equal(row.password_hash, '[masked]');
    }
    // the literal hash prefix must appear nowhere in the serialized payload
    assert.ok(!res.body.includes('$argon2id$'));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table: bogus table → 404', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    const res = await get(app, '/api/admin/db/tables/no_such_table', cookie);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'no such table');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table: injection-shaped table name is not an allowlisted table → 404', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    // url-encoded `users"; DROP TABLE users;--`
    const res = await get(
      app,
      `/api/admin/db/tables/${encodeURIComponent('users"; DROP TABLE users;--')}`,
      cookie,
    );
    assert.equal(res.statusCode, 404);
    // users table is intact afterwards
    const still = app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    assert.ok(still);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table?sort=nonexistent → 400 bad sort column', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    const res = await get(app, '/api/admin/db/tables/users?sort=not_a_column', cookie);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'bad sort column');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table?limit=9999 → schema rejects (>200)', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    // The querystring schema caps limit at 200, so 9999 is a validation 400.
    const res = await get(app, '/api/admin/db/tables/users?limit=9999', cookie);
    assert.equal(res.statusCode, 400);

    // And the in-handler clamp guarantees rows never exceed 200 at the max.
    const ok = await get(app, '/api/admin/db/tables/users?limit=200', cookie);
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.json().rows.length <= 200);
    assert.equal(ok.json().limit, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table?q=...: filters rows and total reflects the filtered set', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'alpha', password: 'admin-password-1', isAdmin: true });
    await seedUser(app, { username: 'bravo', password: 'another-password', isAdmin: false });
    await seedUser(app, { username: 'alphonse', password: 'third-password-x', isAdmin: false });
    const cookie = await login(app, 'alpha', 'admin-password-1');

    const all = (await get(app, '/api/admin/db/tables/users', cookie)).json();
    assert.equal(all.total, 3);

    const filtered = (await get(app, '/api/admin/db/tables/users?q=alph', cookie)).json();
    assert.equal(filtered.total, 2); // alpha + alphonse
    assert.ok(filtered.rows.every((r) => r.username.startsWith('alph')));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table: sort dir flips order', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'aaa', password: 'admin-password-1', isAdmin: true });
    await seedUser(app, { username: 'mmm', password: 'another-password', isAdmin: false });
    await seedUser(app, { username: 'zzz', password: 'third-password-x', isAdmin: false });
    const cookie = await login(app, 'aaa', 'admin-password-1');

    const asc = (await get(app, '/api/admin/db/tables/users?sort=username&dir=asc', cookie)).json();
    const desc = (await get(app, '/api/admin/db/tables/users?sort=username&dir=desc', cookie)).json();
    assert.equal(asc.rows[0].username, 'aaa');
    assert.equal(desc.rows[0].username, 'zzz');
    assert.deepEqual(asc.rows.map((r) => r.username), [...desc.rows.map((r) => r.username)].reverse());
    assert.equal(asc.dir, 'asc');
    assert.equal(desc.dir, 'desc');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table?sort=password_hash → 400 (masked column is not sortable)', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    // password_hash is a REAL column but masked → sorting by it would leak the
    // hash's relative ordering as an oracle, so it's rejected like a bad column.
    const res = await get(app, '/api/admin/db/tables/users?sort=password_hash', cookie);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'bad sort column');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /tables/:table?q: search excludes masked columns (cannot probe the hash)', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    // 'argon2id' lives only inside password_hash → masked → excluded from search.
    const res = await get(app, '/api/admin/db/tables/users?q=argon2id', cookie);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().total, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SELECT-only query box ────────────────────────────────────────────────────
test('GET /query: SELECT 1 AS n returns the row', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent('SELECT 1 AS n')}`, cookie);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.rows, [{ n: 1 }]);
    assert.deepEqual(body.columns, ['n']);
    assert.equal(body.capped, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: UPDATE/DELETE/INSERT are rejected as non-SELECT', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    for (const sql of [
      'UPDATE users SET is_admin = 1',
      'DELETE FROM users',
      "INSERT INTO reviews (name, rating, message) VALUES ('x', 5, 'sneaky message')",
    ]) {
      const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent(sql)}`, cookie);
      assert.equal(res.statusCode, 400, `should reject: ${sql}`);
      assert.equal(res.json().error, 'SELECT only');
    }
    // and nothing was written
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM reviews').get().c, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: multi-statement (;) is rejected before prepare', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    const sql = 'SELECT 1; DROP TABLE users';
    const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent(sql)}`, cookie);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'single statement only');
    // users still present
    assert.ok(app.db.prepare("SELECT name FROM sqlite_master WHERE name='users'").get());
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: SELECT * value-masks password_hash; naming the column is rejected', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');

    // SELECT * keeps the real column name → value-masked; the raw hash never ships.
    const star = await get(app, `/api/admin/db/query?sql=${encodeURIComponent('SELECT * FROM users')}`, cookie);
    assert.equal(star.statusCode, 200);
    const body = star.json();
    assert.ok(body.rows.length >= 1);
    for (const row of body.rows) assert.equal(row.password_hash, '[masked]');
    assert.ok(!star.body.includes('$argon2id$'));

    // Referencing the masked column by name/alias/expression is rejected outright —
    // output-name masking can't be trusted once the caller controls the projection.
    for (const sql of [
      'SELECT password_hash FROM users',
      'SELECT password_hash AS pw FROM users',
      'SELECT substr(password_hash,1,8) AS x FROM users',
    ]) {
      const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent(sql)}`, cookie);
      assert.equal(res.statusCode, 400, `should reject: ${sql}`);
      assert.ok(!res.body.includes('$argon2id$'), `must not leak the hash for: ${sql}`);
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: writes via ... RETURNING are rejected and do not mutate', async () => {
  const { app, dir } = await freshApp();
  try {
    const id = await seedUser(app, { username: 'alice', password: 'a-good-password', isAdmin: false });
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    for (const sql of [
      `UPDATE users SET is_admin = 1 WHERE id = ${id} RETURNING id`,
      "INSERT INTO reviews (name, rating, message) VALUES ('x', 5, 'y') RETURNING id",
      `DELETE FROM users WHERE id = ${id} RETURNING id`,
    ]) {
      const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent(sql)}`, cookie);
      assert.equal(res.statusCode, 400, `should reject: ${sql}`);
      assert.equal(res.json().error, 'SELECT only');
    }
    // alice untouched + present + still non-admin; no review row inserted
    const alice = app.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(id);
    assert.ok(alice && alice.is_admin === 0, 'alice must be unchanged');
    assert.equal(app.db.prepare('SELECT COUNT(*) c FROM reviews').get().c, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: a syntactically broken SQL → 400, never 500', async () => {
  const { app, dir } = await freshApp();
  try {
    await seedUser(app, { username: 'boss', password: 'admin-password-1', isAdmin: true });
    const cookie = await login(app, 'boss', 'admin-password-1');
    const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent('SELECT FROM bogus')}`, cookie);
    assert.equal(res.statusCode, 400);
    assert.ok(typeof res.json().error === 'string');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /query: 401 unauthenticated, 403 for non-admin', async () => {
  const { app, dir } = await freshApp();
  try {
    const anon = await get(app, `/api/admin/db/query?sql=${encodeURIComponent('SELECT 1')}`);
    assert.equal(anon.statusCode, 401);

    await seedUser(app, { username: 'normie', password: 'a-good-password', isAdmin: false });
    const cookie = await login(app, 'normie', 'a-good-password');
    const res = await get(app, `/api/admin/db/query?sql=${encodeURIComponent('SELECT 1')}`, cookie);
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
