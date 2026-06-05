// HTTP layer for game-server control. Thin by design: authenticate (admin only),
// validate input shape, call app.serverService, map typed errors to status codes.
// No transport or game knowledge lives here.

import { requireAdmin } from '../middleware/auth.js';
import { ServerControlError } from '../servers/service.js';

const ID_PARAM = { type: 'string', pattern: '^[a-z0-9-]{1,32}$' };
const WS_PARAM = { type: 'string', pattern: '^[0-9]{1,20}$' };
const CONFIG_ID_PARAM = { type: 'integer', minimum: 1 };
const BACKUP_NAME_PARAM = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const FILE_PARAM = { type: 'string', minLength: 1, maxLength: 128 };

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
};

// Build a `params` JSON-schema where every listed property is required.
const P = (props) => ({ params: { type: 'object', properties: props, required: Object.keys(props) } });

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
  route('get', '/', () => svc.listServers());

  // Host (node) dashboard. Static '/node' is declared before '/:id' so the
  // parametric matcher can't shadow it.
  route('get', '/node', () => svc.getNodeStatus());
  route('get', '/:id', (req) => svc.getStatus(req.params.id), { schema: P({ id: ID_PARAM }) });

  // ── power actions ─────────────────────────────────────────────────────────────
  route('post', '/:id/actions/:action', (req) => svc.doAction(req.params.id, req.params.action), {
    csrf: true,
    schema: P({
      id: ID_PARAM,
      action: { type: 'string', enum: ['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame'] },
    }),
  });

  // ── structured quick settings (map / game mode / …) ──────────────────────────
  route('get', '/:id/settings', (req) => svc.getSettings(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('put', '/:id/settings', (req) => svc.setSettings(req.params.id, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: {
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
    },
  });

  // ── workshop map catalog (Phase 2; CS) ────────────────────────────────────────
  route('get', '/:id/maps', (req) => svc.listMaps(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('post', '/:id/maps', (req) => svc.addMap(req.params.id, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: {
        type: 'object',
        properties: { workshopId: WS_PARAM, name: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['workshopId', 'name'],
        additionalProperties: false,
      },
    },
  });
  // Install collection maps into the single garrysmod/maps/ source (GMOD). Static
  // '/maps/sync' is declared before '/maps/:workshopId' so it can't be shadowed.
  route('post', '/:id/maps/sync', (req) => svc.syncMaps(req.params.id), { csrf: true, schema: P({ id: ID_PARAM }) });
  route('patch', '/:id/maps/:workshopId', (req) => svc.renameMap(req.params.id, req.params.workshopId, req.body.name), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM, workshopId: WS_PARAM }),
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['name'], additionalProperties: false },
    },
  });
  route('delete', '/:id/maps/:workshopId', (req) => svc.deleteMap(req.params.id, req.params.workshopId), {
    csrf: true, schema: P({ id: ID_PARAM, workshopId: WS_PARAM }),
  });

  // ── config library (Phase 2; CS) ──────────────────────────────────────────────
  route('get', '/:id/configs', (req) => svc.listConfigs(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('get', '/:id/configs/:configId', (req) => svc.getConfig(req.params.id, req.params.configId), {
    schema: P({ id: ID_PARAM, configId: CONFIG_ID_PARAM }),
  });
  route('post', '/:id/configs', (req) => svc.createConfig(req.params.id, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, body: { type: 'string', maxLength: 100_000 } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  });
  route('put', '/:id/configs/:configId', (req) => svc.updateConfig(req.params.id, req.params.configId, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM, configId: CONFIG_ID_PARAM }),
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, body: { type: 'string', maxLength: 100_000 } },
        additionalProperties: false,
      },
    },
  });
  route('delete', '/:id/configs/:configId', (req) => svc.deleteConfig(req.params.id, req.params.configId), {
    csrf: true, schema: P({ id: ID_PARAM, configId: CONFIG_ID_PARAM }),
  });

  // ── startup-config profiles ───────────────────────────────────────────────────
  // Static sub-paths (/schema, /capture) are declared before '/:profileId' so the
  // parametric matcher can't shadow them.
  route('get', '/:id/profiles', (req) => svc.listProfiles(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('get', '/:id/profiles/schema', (req) => svc.profileSchema(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('post', '/:id/profiles', (req) => svc.createProfile(req.params.id, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 48 }, settings: { type: 'object' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  });
  route('post', '/:id/profiles/capture', (req) => svc.captureProfile(req.params.id, req.body.name), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 48 } }, required: ['name'], additionalProperties: false },
    },
  });
  route('get', '/:id/profiles/:profileId', (req) => svc.getProfile(req.params.id, req.params.profileId), {
    schema: P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }),
  });
  route('put', '/:id/profiles/:profileId', (req) => svc.updateProfile(req.params.id, req.params.profileId, req.body), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }),
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 48 }, settings: { type: 'object' } },
        additionalProperties: false,
      },
    },
  });
  route('delete', '/:id/profiles/:profileId', (req) => svc.deleteProfile(req.params.id, req.params.profileId), {
    csrf: true, schema: P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }),
  });
  route('post', '/:id/profiles/:profileId/apply', (req) => svc.applyProfile(req.params.id, req.params.profileId), {
    csrf: true, schema: P({ id: ID_PARAM, profileId: CONFIG_ID_PARAM }),
  });

  // ── offsite backups (Phase 4; Factorio + Minecraft via rclone → R2) ───────────
  route('get', '/:id/backups', (req) => svc.listBackups(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('post', '/:id/backups', (req) => svc.createBackup(req.params.id), { csrf: true, schema: P({ id: ID_PARAM }) });
  route('post', '/:id/backups/:name/restore', (req) => svc.restoreBackup(req.params.id, req.params.name), {
    csrf: true, schema: P({ id: ID_PARAM, name: BACKUP_NAME_PARAM }),
  });
  route('delete', '/:id/backups/:name', (req) => svc.deleteBackup(req.params.id, req.params.name), {
    csrf: true, schema: P({ id: ID_PARAM, name: BACKUP_NAME_PARAM }),
  });

  // ── live commands (Phase 3; RCON / console) ───────────────────────────────────
  route('get', '/:id/live', (req) => svc.getLive(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('post', '/:id/live/command', (req) => svc.sendCommand(req.params.id, req.body.command), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: { type: 'object', properties: { command: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['command'], additionalProperties: false },
    },
  });
  route('post', '/:id/live/action', (req) => svc.runLiveAction(req.params.id, req.body.action, req.body.value), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM }),
      body: {
        type: 'object',
        properties: {
          action: { type: 'string', minLength: 1, maxLength: 64 },
          value:  { type: 'string', maxLength: 80 }, // optional param, e.g. change_map target
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  });

  // ── raw config files (Phase 3) ────────────────────────────────────────────────
  route('get', '/:id/config', (req) => svc.listConfig(req.params.id), { schema: P({ id: ID_PARAM }) });
  route('get', '/:id/config/:file', (req) => svc.readConfig(req.params.id, req.params.file), {
    schema: P({ id: ID_PARAM, file: FILE_PARAM }),
  });
  route('put', '/:id/config/:file', (req) => svc.writeConfig(req.params.id, req.params.file, req.body.content), {
    csrf: true,
    schema: {
      ...P({ id: ID_PARAM, file: FILE_PARAM }),
      body: { type: 'object', properties: { content: { type: 'string', maxLength: 1_000_000 } }, required: ['content'], additionalProperties: false },
    },
  });

  // ── update recipe (Phase 3) ─────────────────────────────────────────────────
  route('post', '/:id/update', (req) => svc.runUpdate(req.params.id), { csrf: true, schema: P({ id: ID_PARAM }) });
}
