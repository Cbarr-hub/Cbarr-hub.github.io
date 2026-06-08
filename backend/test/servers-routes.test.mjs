import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import serversRoutes from '../src/routes/servers.js';

function baseService(overrides = {}) {
  return {
    listServers: async () => [],
    getNodeStatus: async () => ({ kind: 'docker' }),
    getStatus: async (id) => ({ id, status: 'running' }),
    doAction: async (id, action) => ({ ok: true, id, action }),
    getSettings: async () => ({ fields: [] }),
    setSettings: async () => ({ ok: true }),
    listMaps: async () => [],
    syncMaps: async () => ({ ok: true }),
    addMap: async () => ({ ok: true }),
    importCollection: async () => ({ ok: true }),
    renameMap: async () => ({ ok: true }),
    deleteMap: async () => ({ ok: true }),
    listConfigs: async () => [],
    getConfig: async () => ({}),
    createConfig: async () => ({}),
    updateConfig: async () => ({}),
    deleteConfig: async () => ({ ok: true }),
    listProfiles: async () => ({ profiles: [], activeId: null }),
    profileSchema: async () => ({ groups: [] }),
    createProfile: async () => ({}),
    captureProfile: async () => ({}),
    getProfile: async () => ({}),
    updateProfile: async () => ({}),
    deleteProfile: async () => ({ ok: true }),
    applyProfile: async () => ({ ok: true }),
    getLive: async () => ({ available: false }),
    sendCommand: async () => ({ output: '' }),
    runLiveAction: async () => ({ output: '' }),
    listSessions: async () => [],
    listConfig: async () => ({ files: [] }),
    readConfig: async () => ({ content: '' }),
    writeConfig: async () => ({ ok: true }),
    getBlueMapStatus: async () => ({ state: 'rendering', map: 'nether', percent: 45.1 }),
    runUpdate: async () => ({ ok: true }),
    ...overrides,
  };
}

async function routeApp({ user = { id: 1, isAdmin: true }, service = baseService() } = {}) {
  const app = Fastify({ logger: false });
  app.decorate('serverService', service);
  app.decorate('csrfProtection', async (req, reply) => {
    if (req.headers['x-csrf-token'] !== 'ok') reply.code(403).send({ error: 'csrf required' });
  });
  app.decorateRequest('currentUser', null);
  app.addHook('preHandler', async (req) => { req.currentUser = user; });
  await app.register(serversRoutes, { prefix: '/api/servers' });
  return app;
}

test('servers routes require admin access', async () => {
  const anon = await routeApp({ user: null });
  try {
    assert.equal((await anon.inject({ method: 'GET', url: '/api/servers' })).statusCode, 401);
  } finally { await anon.close(); }

  const normal = await routeApp({ user: { id: 2, isAdmin: false } });
  try {
    assert.equal((await normal.inject({ method: 'GET', url: '/api/servers' })).statusCode, 403);
  } finally { await normal.close(); }

  const admin = await routeApp();
  try {
    const res = await admin.inject({ method: 'GET', url: '/api/servers' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  } finally { await admin.close(); }
});

test('servers routes keep static /node before /:id and validate id params', async () => {
  const app = await routeApp({
    service: baseService({
      getNodeStatus: async () => ({ kind: 'docker', name: 'keeper' }),
      getStatus: async () => { throw new Error('node route was shadowed'); },
    }),
  });
  try {
    const node = await app.inject({ method: 'GET', url: '/api/servers/node' });
    assert.equal(node.statusCode, 200);
    assert.equal(node.json().name, 'keeper');

    const invalid = await app.inject({ method: 'GET', url: '/api/servers/Bad_ID' });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('servers routes validate and forward quick/full status mode', async () => {
  const calls = [];
  const app = await routeApp({
    service: baseService({
      listServers: async (opts) => { calls.push(['list', opts]); return []; },
      getStatus: async (id, opts) => { calls.push(['status', id, opts]); return { id, status: 'running' }; },
    }),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers?mode=quick' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/gmod?mode=full' })).statusCode, 200);
    assert.deepEqual(calls, [
      ['list', { mode: 'quick' }],
      ['status', 'gmod', { mode: 'full' }],
    ]);

    const invalid = await app.inject({ method: 'GET', url: '/api/servers?mode=slow' });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('servers routes expose BlueMap render status on a static path', async () => {
  const app = await routeApp({
    service: baseService({
      getBlueMapStatus: async () => ({ state: 'rendering', map: 'nether', percent: 45.1 }),
      getStatus: async () => { throw new Error('map status route was shadowed'); },
    }),
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/servers/map/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().map, 'nether');
    assert.equal(res.json().percent, 45.1);
  } finally { await app.close(); }
});

test('servers mutating routes require csrf and dispatch after a valid token', async () => {
  const calls = [];
  const app = await routeApp({
    service: baseService({
      doAction: async (id, action) => { calls.push([id, action]); return { ok: true }; },
    }),
  });
  try {
    const blocked = await app.inject({ method: 'POST', url: '/api/servers/minecraft/actions/start' });
    assert.equal(blocked.statusCode, 403);
    assert.deepEqual(calls, []);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/servers/minecraft/actions/start',
      headers: { 'x-csrf-token': 'ok' },
    });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(calls, [['minecraft', 'start']]);
  } finally { await app.close(); }
});

test('servers routes map typed RCON and Docker errors', async () => {
  const app = await routeApp({
    service: baseService({
      getLive: async () => { const e = new Error('bad password'); e.code = 'RCON_AUTH'; throw e; },
      getStatus: async () => { const e = new Error('socket proxy down'); e.name = 'DockerError'; throw e; },
      getSettings: async () => { const e = new Error('docker POST /exec/slow/start timed out'); e.name = 'DockerError'; e.code = 'DOCKER_TIMEOUT'; throw e; },
    }),
  });
  try {
    const rcon = await app.inject({ method: 'GET', url: '/api/servers/gmod/live' });
    assert.equal(rcon.statusCode, 502);
    assert.equal(rcon.json().code, 'RCON_AUTH');

    const docker = await app.inject({ method: 'GET', url: '/api/servers/gmod' });
    assert.equal(docker.statusCode, 502);
    assert.equal(docker.json().code, 'DOCKER_ERROR');

    const timeout = await app.inject({ method: 'GET', url: '/api/servers/gmod/settings' });
    assert.equal(timeout.statusCode, 504);
    assert.equal(timeout.json().code, 'DOCKER_TIMEOUT');
  } finally { await app.close(); }
});
