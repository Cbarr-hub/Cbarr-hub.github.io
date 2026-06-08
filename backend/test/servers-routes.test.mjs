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
    getCurrentMinecraftPosition: async () => ({ serverId: 'minecraft', linked: false }),
    getCurrentPlayerPosition: async (id) => ({ serverId: id, linked: false }),
    getOnlinePlayerPosition: async (id, sessionId) => ({ serverId: id, sessionId }),
    getOnlinePlayerPositionByName: async (id, player) => ({ serverId: id, player }),
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
      getCurrentMinecraftPosition: async (userId) => ({ serverId: 'minecraft', userId }),
      getCurrentPlayerPosition: async (id, userId) => ({ serverId: id, userId }),
      getOnlinePlayerPosition: async (id, sessionId) => ({ serverId: id, sessionId }),
      getOnlinePlayerPositionByName: async (id, player) => ({ serverId: id, player }),
      getStatus: async () => { throw new Error('map status route was shadowed'); },
    }),
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/servers/map/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().map, 'nether');
    assert.equal(res.json().percent, 45.1);
    const me = await app.inject({ method: 'GET', url: '/api/servers/map/me' });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().serverId, 'minecraft');
    const factorio = await app.inject({ method: 'GET', url: '/api/servers/factorio/map/me' });
    assert.equal(factorio.statusCode, 200);
    assert.equal(factorio.json().serverId, 'factorio');
    const session = await app.inject({ method: 'GET', url: '/api/servers/minecraft/map/sessions/12' });
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), { serverId: 'minecraft', sessionId: 12 });
    const player = await app.inject({ method: 'GET', url: '/api/servers/minecraft/map/players/dheagman' });
    assert.equal(player.statusCode, 200);
    assert.deepEqual(player.json(), { serverId: 'minecraft', player: 'dheagman' });
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

test('servers routes accept and dispatch every mutating command endpoint shape', async () => {
  const calls = [];
  const rec = (name, result = { ok: true }) => async (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const app = await routeApp({
    service: baseService({
      doAction: rec('doAction'),
      setSettings: rec('setSettings'),
      addMap: rec('addMap'),
      syncMaps: rec('syncMaps'),
      importCollection: rec('importCollection'),
      renameMap: rec('renameMap'),
      deleteMap: rec('deleteMap'),
      createConfig: rec('createConfig'),
      updateConfig: rec('updateConfig'),
      deleteConfig: rec('deleteConfig'),
      createProfile: rec('createProfile'),
      captureProfile: rec('captureProfile'),
      updateProfile: rec('updateProfile'),
      deleteProfile: rec('deleteProfile'),
      applyProfile: rec('applyProfile'),
      sendCommand: rec('sendCommand'),
      runLiveAction: rec('runLiveAction'),
      writeConfig: rec('writeConfig'),
      runUpdate: rec('runUpdate'),
    }),
  });
  try {
    const rows = [
      ...['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame'].map((action) => ({
        method: 'POST', url: `/api/servers/gmod/actions/${action}`, call: ['doAction', 'gmod', action],
      })),
      { method: 'PUT', url: '/api/servers/factorio/settings', body: { section: 'saveAs', saveName: 'new_save' }, call: ['setSettings', 'factorio', { section: 'saveAs', saveName: 'new_save' }] },
      { method: 'POST', url: '/api/servers/counterstrike/maps', body: { workshopId: '123', name: 'Aim' }, call: ['addMap', 'counterstrike', { workshopId: '123', name: 'Aim' }] },
      { method: 'POST', url: '/api/servers/gmod/maps/sync', call: ['syncMaps', 'gmod'] },
      { method: 'POST', url: '/api/servers/counterstrike/maps/collection', body: { collectionId: '456' }, call: ['importCollection', 'counterstrike', '456'] },
      { method: 'PATCH', url: '/api/servers/counterstrike/maps/123', body: { name: 'Renamed' }, call: ['renameMap', 'counterstrike', '123', 'Renamed'] },
      { method: 'DELETE', url: '/api/servers/counterstrike/maps/123', call: ['deleteMap', 'counterstrike', '123'] },
      { method: 'POST', url: '/api/servers/counterstrike/configs', body: { name: 'scrim', body: 'mp_maxrounds 24' }, call: ['createConfig', 'counterstrike', { name: 'scrim', body: 'mp_maxrounds 24' }] },
      { method: 'PUT', url: '/api/servers/counterstrike/configs/7', body: { body: 'mp_roundtime 5' }, call: ['updateConfig', 'counterstrike', 7, { body: 'mp_roundtime 5' }] },
      { method: 'DELETE', url: '/api/servers/counterstrike/configs/7', call: ['deleteConfig', 'counterstrike', 7] },
      { method: 'POST', url: '/api/servers/minecraft/profiles', body: { name: 'Survival', settings: { difficulty: 'hard' } }, call: ['createProfile', 'minecraft', { name: 'Survival', settings: { difficulty: 'hard' } }] },
      { method: 'POST', url: '/api/servers/minecraft/profiles/capture', body: { name: 'Captured' }, call: ['captureProfile', 'minecraft', 'Captured'] },
      { method: 'PUT', url: '/api/servers/minecraft/profiles/9', body: { settings: { difficulty: 'normal' } }, call: ['updateProfile', 'minecraft', 9, { settings: { difficulty: 'normal' } }] },
      { method: 'DELETE', url: '/api/servers/minecraft/profiles/9', call: ['deleteProfile', 'minecraft', 9] },
      { method: 'POST', url: '/api/servers/minecraft/profiles/9/apply', call: ['applyProfile', 'minecraft', 9] },
      { method: 'POST', url: '/api/servers/gmod/live/command', body: { command: 'status' }, call: ['sendCommand', 'gmod', 'status'] },
      { method: 'POST', url: '/api/servers/gmod/live/action', body: { action: 'gravity', value: '250' }, call: ['runLiveAction', 'gmod', 'gravity', '250'] },
      { method: 'PUT', url: '/api/servers/minecraft/config/server.properties', body: { content: 'level-name=world\n' }, call: ['writeConfig', 'minecraft', 'server.properties', 'level-name=world\n'] },
      { method: 'POST', url: '/api/servers/minecraft/update', call: ['runUpdate', 'minecraft'] },
    ];

    for (const row of rows) {
      const res = await app.inject({
        method: row.method,
        url: row.url,
        headers: { 'x-csrf-token': 'ok' },
        ...(row.body === undefined ? {} : { payload: row.body }),
      });
      assert.equal(res.statusCode, 200, `${row.method} ${row.url}: ${res.body}`);
    }
    assert.deepEqual(calls, rows.map((r) => r.call));
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
