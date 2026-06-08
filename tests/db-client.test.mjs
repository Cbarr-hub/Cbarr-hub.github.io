// Covers db.js's api() CSRF self-heal: a mutating request that 403s with a
// CSRF-shaped error clears the cached token and retries exactly once (which
// re-fetches a fresh token), but never loops and never retries a non-CSRF 403.
//
// db.js has no native deps, so it runs on the host node. It caches csrfToken at
// module scope (cleared only by dbLogout), so each test imports a FRESH copy via
// a cache-busting query string to start from a clean cache. global.fetch is
// stubbed per test to record every call and script the responses.

import assert from 'node:assert/strict';
import test from 'node:test';

// Fresh module instance per test → module-level csrfToken cache is reset.
let importSeq = 0;
function freshDb() {
  return import(`../db.js?case=${importSeq++}`);
}

// Minimal Response-ish object matching what db.js reads: status, ok, text()
// (the api() wrapper) and json() (getCsrfToken). api() also checks
// res.status === 204; we never use that here.
function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() {
      return body === undefined ? '' : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

// Build a fetch stub from an array of handlers. Each handler inspects the
// recorded call and returns a Response (or undefined to fall through). Records
// every call as { url, method, headers } for assertions.
function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {} };
    calls.push(call);
    const res = handler(call, calls);
    if (res === undefined) throw new Error(`unexpected fetch: ${call.method} ${url}`);
    return res;
  };
  return calls;
}

const originalFetch = global.fetch;
test.afterEach(() => {
  global.fetch = originalFetch;
});

const START = '/api/servers/minecraft/actions/start';
const CSRF = '/api/csrf';

test('a CSRF-shaped 403 on a mutating request clears the cache and retries once', async () => {
  const { dbServerAction } = await freshDb();

  let postCount = 0;
  let csrfCount = 0;
  const calls = stubFetch((call) => {
    if (call.url === CSRF) {
      csrfCount += 1;
      // First token is 'stale', the refetch yields 'new'.
      return jsonResponse(200, { token: csrfCount === 1 ? 'stale' : 'new' });
    }
    if (call.url === START && call.method === 'POST') {
      postCount += 1;
      if (postCount === 1) return jsonResponse(403, { error: 'Invalid csrf token' });
      return jsonResponse(200, { ok: true });
    }
    return undefined;
  });

  const result = await dbServerAction('minecraft', 'start');

  assert.deepEqual(result, { ok: true }, 'retried POST resolves with the 200 body');
  assert.equal(csrfCount, 2, '/api/csrf is fetched a second time after the cache clear');
  assert.equal(postCount, 2, 'the POST is attempted exactly twice');

  // The first POST carried the stale token; the retried POST carried the fresh one.
  const posts = calls.filter((c) => c.url === START);
  assert.equal(posts[0].headers['x-csrf-token'], 'stale');
  assert.equal(posts[1].headers['x-csrf-token'], 'new', 'retry sends the refetched token');
});

test('a CSRF-403 on BOTH attempts rejects exactly once (no infinite retry)', async () => {
  const { dbServerAction } = await freshDb();

  let postCount = 0;
  let csrfCount = 0;
  stubFetch((call) => {
    if (call.url === CSRF) {
      csrfCount += 1;
      return jsonResponse(200, { token: `t${csrfCount}` });
    }
    if (call.url === START && call.method === 'POST') {
      postCount += 1;
      return jsonResponse(403, { error: 'Invalid csrf token', code: 'FST_CSRF_INVALID_TOKEN' });
    }
    return undefined;
  });

  await assert.rejects(
    dbServerAction('minecraft', 'start'),
    (err) => err.status === 403 && /csrf/i.test(err.message),
  );

  assert.equal(postCount, 2, 'exactly one retry, then it gives up');
  assert.equal(csrfCount, 2, 'token refetched once for the single retry');
});

test('a non-CSRF 403 is NOT retried and rejects immediately', async () => {
  const { dbServerAction } = await freshDb();

  let postCount = 0;
  let csrfCount = 0;
  stubFetch((call) => {
    if (call.url === CSRF) {
      csrfCount += 1;
      return jsonResponse(200, { token: 'tok' });
    }
    if (call.url === START && call.method === 'POST') {
      postCount += 1;
      return jsonResponse(403, { error: 'admin required' });
    }
    return undefined;
  });

  await assert.rejects(
    dbServerAction('minecraft', 'start'),
    (err) => err.status === 403 && err.message === 'admin required',
  );

  assert.equal(postCount, 1, 'no retry on a non-CSRF 403');
  assert.equal(csrfCount, 1, 'token is fetched once and never refetched');
});
