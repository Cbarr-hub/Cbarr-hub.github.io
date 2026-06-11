import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';

import serversRoutes from '../src/routes/servers.js';

// The OPS dispatcher in routes/servers.js calls svc.connectorFor(id)[op](…) for
// every connector pass-through route, so the stub service carries the composite
// methods directly plus a connectorFor returning a stub connector.
// `connectorOverrides` is an object (or an (id) => object factory, so per-op
// recorders can see which server id was resolved) merged over the defaults.
function baseConnector(overrides = {}) {
  return {
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
    listConfigFiles: () => [],
    readConfig: async () => ({ content: '' }),
    writeConfig: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
    ...overrides,
  };
}

function baseService(overrides = {}, connectorOverrides) {
  return {
    listServers: async () => [],
    getNodeStatus: async () => ({ kind: 'docker' }),
    getStatus: async (id) => ({ id, status: 'running' }),
    doAction: async (id, action) => ({ ok: true, id, action }),
    getBlueMapStatus: async () => ({ state: 'rendering', map: 'nether', percent: 45.1 }),
    getOnlinePlayerPosition: async (id, sessionId) => ({ serverId: id, sessionId }),
    getOnlinePlayerPositionByName: async (id, player) => ({ serverId: id, player }),
    clearStatusCache() {},
    connectorFor: (id) => baseConnector(
      typeof connectorOverrides === 'function' ? connectorOverrides(id) : connectorOverrides,
    ),
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
    const session = await app.inject({ method: 'GET', url: '/api/servers/minecraft/map/sessions/12' });
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), { serverId: 'minecraft', sessionId: 12 });
    const player = await app.inject({ method: 'GET', url: '/api/servers/minecraft/map/players/dheagman' });
    assert.equal(player.statusCode, 200);
    assert.deepEqual(player.json(), { serverId: 'minecraft', player: 'dheagman' });
    // the per-user position endpoints were removed outright
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/map/me' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/factorio/map/me' })).statusCode, 404);
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
  const busts = [];
  // Connector-op recorder: the dispatcher resolves connectorFor(id) then calls
  // the op with the request-derived args, so each call records [name, id, ...args]
  // — the same tuples the old service-stub recorder produced.
  const rec = (name, id, result = { ok: true }) => async (...args) => {
    calls.push([name, id, ...args]);
    return result;
  };
  const app = await routeApp({
    service: baseService({
      doAction: async (id, action) => { calls.push(['doAction', id, action]); return { ok: true }; },
      clearStatusCache: () => { busts.push(calls.at(-1)?.[0] ?? null); },
    }, (id) => ({
      setSettings: rec('setSettings', id),
      addMap: rec('addMap', id),
      syncMaps: rec('syncMaps', id),
      importCollection: rec('importCollection', id),
      renameMap: rec('renameMap', id),
      deleteMap: rec('deleteMap', id),
      createConfig: rec('createConfig', id),
      deleteConfig: rec('deleteConfig', id),
      createProfile: rec('createProfile', id),
      captureProfile: rec('captureProfile', id),
      updateProfile: rec('updateProfile', id),
      deleteProfile: rec('deleteProfile', id),
      applyProfile: rec('applyProfile', id),
      sendCommand: rec('sendCommand', id),
      runLiveAction: rec('runLiveAction', id),
      writeConfig: rec('writeConfig', id),
      update: rec('runUpdate', id), // connector method is update(); keep the recorded name
    })),
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
    // The status caches are busted (after success) by exactly this op set; the
    // power actions bust inside the real service's doAction instead.
    assert.deepEqual(busts, ['setSettings', 'applyProfile', 'runUpdate']);
  } finally { await app.close(); }
});

test('servers routes map typed RCON and Docker errors', async () => {
  const app = await routeApp({
    service: baseService({
      getStatus: async () => { const e = new Error('socket proxy down'); e.name = 'DockerError'; throw e; },
    }, {
      getLive: async () => { const e = new Error('bad password'); e.code = 'RCON_AUTH'; throw e; },
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

test('servers /activity querystring schema: valid honored, unknown ignored, bounds enforced', async () => {
  const app = await routeApp({ service: baseService({ recentActivity: async () => [] }) });
  try {
    // Valid params accepted (the SESSION_LIST_QS schema).
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/activity?limit=5&includeUnlinked=true' })).statusCode, 200);
    // Unknown query params are harmlessly stripped (Fastify removeAdditional), not rejected.
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/activity?bogus=1' })).statusCode, 200);
    // The `limit` bound is enforced both ways.
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/activity?limit=9999' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/activity?limit=0' })).statusCode, 400);
    // The per-server /:id/sessions endpoint was removed outright.
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/minecraft/sessions' })).statusCode, 404);
  } finally { await app.close(); }
});

test('servers /stats forwards days/tz, enforces bounds, and sits before /:id', async () => {
  const calls = [];
  const app = await routeApp({
    service: baseService({
      sessionStats: async (opts) => { calls.push(opts); return { range: { days: 30 }, totals: {}, perGame: [], topPlayers: [], heatmap: [], busiest: null }; },
      getStatus: async () => { throw new Error('/stats was shadowed by /:id'); },
    }),
  });
  try {
    const ok = await app.inject({ method: 'GET', url: '/api/servers/stats?days=30&tz=-300' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(calls, [{ days: 30, tz: -300 }]);
    // out-of-range rejected by the schema
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/stats?days=999' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/stats?tz=99999' })).statusCode, 400);
    // unknown query param is harmlessly stripped (removeAdditional), not rejected
    assert.equal((await app.inject({ method: 'GET', url: '/api/servers/stats?bogus=1' })).statusCode, 200);
  } finally { await app.close(); }
});
