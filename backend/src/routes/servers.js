// HTTP layer for game-server control. Thin by design: authenticate (admin only),
// validate input shape, dispatch, map typed errors to status codes. The
// service-level composites (list/status/power/presence/stats/map) are
// hand-written routes; every per-connector operation is one row in the OPS
// table and is dispatched straight to svc.connectorFor(id)[op]. No transport
// or game knowledge lives here.

import { requireAdmin } from '../middleware/auth.js';
import { ServerControlError } from '../servers/service.js';

const ID_PARAM = { type: 'string', pattern: '^[a-z0-9-]{1,32}$' };
const WS_PARAM = { type: 'string', pattern: '^[0-9]{1,20}$' };
const CONFIG_ID_PARAM = { type: 'integer', minimum: 1 };
const SESSION_ID_PARAM = { type: 'integer', minimum: 1 };
const PLAYER_PARAM = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' };
const FILE_PARAM = { type: 'string', minLength: 1, maxLength: 128 };
const CONFIG_BODY_MAX = 16_000;
const PROFILE_NAME = { type: 'string', minLength: 1, maxLength: 48 };
// Profile startup commands: a capped list of RCON strings (the connector
// re-validates each via validateLiveCommand). Matches MAX_PROFILE_COMMANDS in engine.js.
const PROFILE_COMMANDS = { type: 'array', items: { type: 'string', maxLength: 512 }, maxItems: 25 };

// Querystring for the activity-timeline read (`limit` bound + linked/unlinked
// toggle). Fastify's default ajv strips unknown query params (removeAdditional).
const SESSION_LIST_QS = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    includeUnlinked: { type: 'boolean', default: false },
  },
  additionalProperties: false,
};

// Map a typed error code → HTTP status. Covers the ServerControlError codes plus
// the plain code-bearing errors the connectors' catalog/config/live ops throw.
const CODE_STATUS = {
  NOT_CONFIGURED: 503,
  UNKNOWN_SERVER: 404,
  UNKNOWN_CONFIG: 404,
  BAD_ACTION: 400,
  BAD_SETTING: 400,
  NOT_FOUND: 404,
  NOT_SUPPORTED: 404,
  NO_SETTINGS: 404,
  NO_UPDATE_RECIPE: 501,
  NO_RCON: 503,
  RCON_AUTH: 502,
  RCON_ERROR: 502,
  DOCKER_TIMEOUT: 504,
};

// Build a `params` JSON-schema where every listed property is required.
const P = (props) => ({ params: { type: 'object', properties: props, required: Object.keys(props) } });

// Body schemas for the OPS rows. These are the byte-level HTTP contract —
// preserve every pattern / maxLength / additionalProperties flag.
const S = {
  settings: {
    type: 'object',
    properties: {
      // Factorio / Minecraft quick-settings sections
      section:      { type: 'string', maxLength: 32 },
      saveName:     { type: 'string', maxLength: 64 },
      // Factorio new-world generation
      preset:       { type: 'string', maxLength: 32 },
      seed:         { type: 'string', maxLength: 12 },
      startingArea: { type: 'string', maxLength: 16 },
      oreFrequency: { type: 'string', maxLength: 16 },
      oreSize:      { type: 'string', maxLength: 16 },
      oreRichness:  { type: 'string', maxLength: 16 },
      enemies:      { type: 'string', maxLength: 16 },
    },
    // connector validates game-specific fields; no additionalProperties restriction
  },
  addMap: {
    type: 'object',
    // name is optional — when omitted the connector auto-fetches the Workshop title.
    properties: { workshopId: WS_PARAM, name: { type: 'string', maxLength: 64 } },
    required: ['workshopId'],
    additionalProperties: false,
  },
  collection: { type: 'object', properties: { collectionId: WS_PARAM }, required: ['collectionId'], additionalProperties: false },
  mapName: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['name'], additionalProperties: false },
  config: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, body: { type: 'string', maxLength: CONFIG_BODY_MAX } },
    required: ['name'],
    additionalProperties: false,
  },
  profile: {
    type: 'object',
    properties: { name: PROFILE_NAME, settings: { type: 'object' }, commands: PROFILE_COMMANDS },
    required: ['name'],
    additionalProperties: false,
  },
  profileName: { type: 'object', properties: { name: PROFILE_NAME }, required: ['name'], additionalProperties: false },
  profilePatch: {
    type: 'object',
    properties: { name: PROFILE_NAME, settings: { type: 'object' }, commands: PROFILE_COMMANDS },
    additionalProperties: false,
  },
  command: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['command'], additionalProperties: false },
  liveAction: {
    type: 'object',
    properties: {
      action: { type: 'string', minLength: 1, maxLength: 64 },
      value:  { type: 'string', maxLength: 80 }, // optional param, e.g. change_map target
    },
    required: ['action'],
    additionalProperties: false,
  },
  content: { type: 'object', properties: { content: { type: 'string', maxLength: 1_000_000 } }, required: ['content'], additionalProperties: false },
};

// ── connector operation table ───────────────────────────────────────────────
// [method, path, op, opts] — one row per connector pass-through route. The
// registrar below turns each into an admin-only route whose handler is
// `svc.connectorFor(req.params.id)[op](...args(req))`.
//   op      the connector method name
//   args    builds the connector argument list from the request (default [])
//   csrf    adds the CSRF onRequest guard (mutating routes)
//   bust    svc.clearStatusCache() after success — the mutations whose effect
//           must show on the next status read (setSettings / applyProfile /
//           update; doAction busts inside the service itself)
//   params  extra :path params merged into P({ id: ID_PARAM, … })
//   body    body schema (S.*)
//   wrap    reshapes the connector result for the HTTP response
// DECLARATION ORDER MATTERS for static-vs-param matching: '/maps/sync' and
// '/maps/collection' stay before '/maps/:workshopId'; '/profiles/schema' and
// '/profiles/capture' before '/profiles/:profileId'.
const OPS = [
  // ── structured quick settings (map / game mode / …) ──
  ['get',    '/:id/settings',                  'getSettings'],
  ['put',    '/:id/settings',                  'setSettings',     { csrf: true, bust: true, body: S.settings, args: (r) => [r.body] }],
  // ── workshop map catalog (Phase 2; CS) ── sync installs collection maps into
  // the single garrysmod/maps/ source (GMOD); collection imports a public Steam
  // Workshop collection with names auto-fetched (CS).
  ['get',    '/:id/maps',                      'listMaps'],
  ['post',   '/:id/maps',                      'addMap',          { csrf: true, body: S.addMap, args: (r) => [r.body] }],
  ['post',   '/:id/maps/sync',                 'syncMaps',        { csrf: true }],
  ['post',   '/:id/maps/collection',           'importCollection', { csrf: true, body: S.collection, args: (r) => [r.body.collectionId] }],
  ['patch',  '/:id/maps/:workshopId',          'renameMap',       { csrf: true, params: { workshopId: WS_PARAM }, body: S.mapName, args: (r) => [r.params.workshopId, r.body.name] }],
  ['delete', '/:id/maps/:workshopId',          'deleteMap',       { csrf: true, params: { workshopId: WS_PARAM }, args: (r) => [r.params.workshopId] }],
  // ── config library (Phase 2; CS) ──
  ['get',    '/:id/configs',                   'listConfigs'],
  ['get',    '/:id/configs/:configId',         'getConfig',       { params: { configId: CONFIG_ID_PARAM }, args: (r) => [r.params.configId] }],
  ['post',   '/:id/configs',                   'createConfig',    { csrf: true, body: S.config, args: (r) => [r.body] }],
  ['delete', '/:id/configs/:configId',         'deleteConfig',    { csrf: true, params: { configId: CONFIG_ID_PARAM }, args: (r) => [r.params.configId] }],
  // ── startup-config profiles ──
  ['get',    '/:id/profiles',                  'listProfiles'],
  ['get',    '/:id/profiles/schema',           'profileSchema'],
  ['post',   '/:id/profiles',                  'createProfile',   { csrf: true, body: S.profile, args: (r) => [r.body] }],
  ['post',   '/:id/profiles/capture',          'captureProfile',  { csrf: true, body: S.profileName, args: (r) => [r.body.name] }],
  ['get',    '/:id/profiles/:profileId',       'getProfile',      { params: { profileId: CONFIG_ID_PARAM }, args: (r) => [r.params.profileId] }],
  ['put',    '/:id/profiles/:profileId',       'updateProfile',   { csrf: true, params: { profileId: CONFIG_ID_PARAM }, body: S.profilePatch, args: (r) => [r.params.profileId, r.body] }],
  ['delete', '/:id/profiles/:profileId',       'deleteProfile',   { csrf: true, params: { profileId: CONFIG_ID_PARAM }, args: (r) => [r.params.profileId] }],
  ['post',   '/:id/profiles/:profileId/apply', 'applyProfile',    { csrf: true, bust: true, params: { profileId: CONFIG_ID_PARAM }, args: (r) => [r.params.profileId] }],
  ['post',   '/:id/profiles/:profileId/commands', 'runProfileCommands', { csrf: true, params: { profileId: CONFIG_ID_PARAM }, args: (r) => [r.params.profileId] }],
  // ── live commands (Phase 3; RCON / console) ──
  ['get',    '/:id/live',                      'getLive'],
  ['post',   '/:id/live/command',              'sendCommand',     { csrf: true, body: S.command, args: (r) => [r.body.command] }],
  ['post',   '/:id/live/action',               'runLiveAction',   { csrf: true, body: S.liveAction, args: (r) => [r.body.action, r.body.value] }],
  // ── raw config files (Phase 3) ──
  ['get',    '/:id/config',                    'listConfigFiles', { wrap: (files, r) => ({ id: r.params.id, files }) }],
  ['get',    '/:id/config/:file',              'readConfig',      { params: { file: FILE_PARAM }, args: (r) => [r.params.file] }],
  ['put',    '/:id/config/:file',              'writeConfig',     { csrf: true, params: { file: FILE_PARAM }, body: S.content, args: (r) => [r.params.file, r.body.content] }],
  // ── update recipe (Phase 3) ──
  ['post',   '/:id/update',                    'update',          { csrf: true, bust: true }],
];

export default async function serversRoutes(app) {
  const svc = app.serverService;

  // Translate a typed (code-bearing) error into a clean HTTP response. Returns
  // true if handled, false if the caller should rethrow (→ 500). A
  // ServerControlError always maps (unknown code → 400).
  function sendErr(err, reply) {
    if (err instanceof ServerControlError) {
      reply.code(CODE_STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
      return true;
    }
    const status = err?.code && CODE_STATUS[err.code];
    if (status) {
      reply.code(status).send({ error: err.message, code: err.code });
      return true;
    }
    // A transport failure (Docker engine unreachable / refused) is an upstream
    // error, not a 500 — surface it as 502 without coupling to the docker module.
    if (err?.name === 'DockerError') {
      app.log.error({ err }, 'docker upstream error');
      reply.code(502).send({ error: 'upstream Docker error', detail: err.message, code: 'DOCKER_ERROR' });
      return true;
    }
    return false;
  }

  // Register an admin-only route. `handler(req, reply)` may throw typed errors
  // (sendErr maps them); anything else rethrows. `csrf` adds the CSRF onRequest
  // guard for mutating routes; `schema` is the optional Fastify schema.
  const route = (method, path, handler, { csrf = false, schema } = {}) => {
    const opts = { preHandler: requireAdmin };
    if (csrf) opts.onRequest = app.csrfProtection;
    if (schema) opts.schema = schema;
    app[method](path, opts, async (req, reply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (sendErr(err, reply)) return;
        throw err;
      }
    });
  };

  // ── list + status ───────────────────────────────────────────────────────────
  route('get', '/', (req) => svc.listServers({ mode: req.query.mode }), {
    schema: {
      querystring: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['quick', 'full'] } },
        additionalProperties: false,
      },
    },
  });

  // Host (node) dashboard. Static '/node' is declared before '/:id' so the
  // parametric matcher can't shadow it.
  route('get', '/node', () => svc.getNodeStatus());

  // ── presence + activity (read-only). Static paths before '/:id'. ─────────────
  route('get', '/online', () => svc.listOnline());
  route('get', '/activity', (req) => svc.recentActivity({
    limit: req.query.limit,
    includeUnlinked: req.query.includeUnlinked,
  }), {
    schema: { querystring: SESSION_LIST_QS },
  });
  // Aggregate session analytics (the "Pulse" view). Static path before '/:id'.
  route('get', '/stats', (req) => svc.sessionStats({ days: req.query.days, tz: req.query.tz }), {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 0, maximum: 365 },
          tz: { type: 'integer', minimum: -840, maximum: 840 },
        },
        additionalProperties: false,
      },
    },
  });
  route('get', '/map/status', () => svc.getBlueMapStatus());
  route('get', '/:id/map/sessions/:sessionId', (req) => svc.getOnlinePlayerPosition(req.params.id, req.params.sessionId), {
    schema: P({ id: ID_PARAM, sessionId: SESSION_ID_PARAM }),
  });
  route('get', '/:id/map/players/:player', (req) => svc.getOnlinePlayerPositionByName(req.params.id, req.params.player), {
    schema: P({ id: ID_PARAM, player: PLAYER_PARAM }),
  });

  route('get', '/:id', (req) => svc.getStatus(req.params.id, { mode: req.query.mode }), {
    schema: {
      ...P({ id: ID_PARAM }),
      querystring: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['quick', 'full'] } },
        additionalProperties: false,
      },
    },
  });

  // ── power actions ─────────────────────────────────────────────────────────────
  // The legacy startGame/stopGame/restartGame names stay accepted (service maps
  // them to container power) so an older client can never hit BAD_ACTION.
  route('post', '/:id/actions/:action', (req) => svc.doAction(req.params.id, req.params.action), {
    csrf: true,
    schema: P({
      id: ID_PARAM,
      action: { type: 'string', enum: ['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame'] },
    }),
  });

  // ── connector operations (the OPS table) ──────────────────────────────────────
  for (const [method, path, op, opts = {}] of OPS) {
    const { csrf = false, bust = false, params, body, args = () => [], wrap } = opts;
    const schema = { ...P({ id: ID_PARAM, ...params }), ...(body ? { body } : {}) };
    route(method, path, async (req) => {
      const result = await svc.connectorFor(req.params.id)[op](...args(req));
      if (bust) svc.clearStatusCache();
      return wrap ? wrap(result, req) : result;
    }, { csrf, schema });
  }
}
