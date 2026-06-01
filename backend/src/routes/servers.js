// HTTP layer for game-server control. Thin by design: authenticate (admin only),
// validate input shape, call app.serverService, map typed errors to status codes.
// No Proxmox or game knowledge lives here.

import { requireAdmin } from '../middleware/auth.js';
import { ServerControlError } from '../servers/service.js';
import { ProxmoxError } from '../proxmox/client.js';

const ERROR_STATUS = {
  NOT_CONFIGURED: 503,
  UNKNOWN_SERVER: 404,
  UNKNOWN_CONFIG: 404,
  BAD_ACTION: 400,
};

const ID_PARAM = { type: 'string', pattern: '^[a-z0-9-]{1,32}$' };
const WS_PARAM = { type: 'string', pattern: '^[0-9]{1,20}$' };
const CONFIG_ID_PARAM = { type: 'integer', minimum: 1 };
const BACKUP_NAME_PARAM = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };

// Map a typed error code → HTTP status for the catalog/config endpoints.
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

export default async function serversRoutes(app) {
  const svc = app.serverService;

  // Translate service/proxmox errors into a clean HTTP response. Returns true if
  // it handled the error, false if the caller should rethrow.
  function handleError(err, reply) {
    if (err instanceof ServerControlError) {
      reply.code(ERROR_STATUS[err.code] ?? 400).send({ error: err.message, code: err.code });
      return true;
    }
    if (err?.code === 'UNKNOWN_CONFIG') {
      reply.code(404).send({ error: err.message, code: 'UNKNOWN_CONFIG' });
      return true;
    }
    if (err instanceof ProxmoxError) {
      // The QEMU guest agent only comes up ~20-40s after the VM powers on, so a
      // command issued through it (Start Hosting, settings, update, live, …)
      // right after a VM start fails with this specific upstream message.
      // Surface it as actionable guidance instead of a generic 502.
      if (/guest agent is not running/i.test(err.message)) {
        reply.code(503).send({
          error: "The VM is still booting — its guest agent isn't ready yet. Wait ~30s after starting the VM, hit Refresh Status, then try again.",
          code: 'AGENT_NOT_READY',
        });
        return true;
      }
      app.log.error({ err }, 'proxmox upstream error');
      reply.code(502).send({ error: 'upstream Proxmox error', detail: err.message });
      return true;
    }
    return false;
  }

  // Like handleError but also maps plain code-bearing errors (BAD_SETTING,
  // NOT_FOUND, NOT_SUPPORTED, …) thrown by the connectors' catalog/config ops.
  function sendErr(err, reply) {
    const status = err?.code && CODE_STATUS[err.code];
    if (status) {
      reply.code(status).send({ error: err.message, code: err.code });
      return true;
    }
    return handleError(err, reply);
  }

  // ── list + status ───────────────────────────────────────────────────────────
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return await svc.listServers();
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  // ── host (node) dashboard ─────────────────────────────────────────────────────
  // Static route declared before '/:id' so it can never be shadowed by the
  // parametric matcher (Fastify prefers static, but keeping it explicit is clear).
  app.get('/node', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return await svc.getNodeStatus();
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  app.get('/:id', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try {
      return await svc.getStatus(req.params.id);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  // ── power actions ─────────────────────────────────────────────────────────────
  app.post('/:id/actions/:action', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: {
        type: 'object',
        properties: {
          id: ID_PARAM,
          action: { type: 'string', enum: ['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame'] },
        },
        required: ['id', 'action'],
      },
    },
  }, async (req, reply) => {
    try {
      return await svc.doAction(req.params.id, req.params.action);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  // ── structured quick settings (map / game mode / …) ──────────────────────────
  app.get('/:id/settings', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try {
      return await svc.getSettings(req.params.id);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  app.put('/:id/settings', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          // Counter-Strike
          map:        { type: 'string', maxLength: 80 },
          workshopId: { type: 'string', maxLength: 20 },
          gameMode:   { type: 'string', maxLength: 32 },
          maxPlayers: { type: 'integer', minimum: 1, maximum: 64 },
          hostname:   { type: 'string', maxLength: 64 },
          configId:   { type: ['integer', 'string', 'null'] }, // selected saved config to deploy ('' = none)
          // Factorio (shared by both sections)
          section:     { type: 'string', maxLength: 32 },
          saveName:    { type: 'string', maxLength: 64 },
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
  }, async (req, reply) => {
    try {
      return await svc.setSettings(req.params.id, req.body);
    } catch (err) {
      if (err?.code === 'BAD_SETTING') {
        return reply.code(400).send({ error: err.message, code: 'BAD_SETTING' });
      }
      if (err?.code === 'NO_SETTINGS') {
        return reply.code(404).send({ error: err.message, code: 'NO_SETTINGS' });
      }
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  // ── workshop map catalog (Phase 2; CS) ────────────────────────────────────────
  app.get('/:id/maps', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return svc.listMaps(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/maps', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: { workshopId: WS_PARAM, name: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['workshopId', 'name'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return svc.addMap(req.params.id, req.body); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // Install collection maps into the single garrysmod/maps/ source (GMOD). Static
  // path declared before '/:workshopId' so it can't be shadowed.
  app.post('/:id/maps/sync', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return await svc.syncMaps(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.patch('/:id/maps/:workshopId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM, workshopId: WS_PARAM }, required: ['id', 'workshopId'] },
      body: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['name'], additionalProperties: false },
    },
  }, async (req, reply) => {
    try { return svc.renameMap(req.params.id, req.params.workshopId, req.body.name); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.delete('/:id/maps/:workshopId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, workshopId: WS_PARAM }, required: ['id', 'workshopId'] } },
  }, async (req, reply) => {
    try { return svc.deleteMap(req.params.id, req.params.workshopId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // ── config library (Phase 2; CS) ──────────────────────────────────────────────
  app.get('/:id/configs', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return svc.listConfigs(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.get('/:id/configs/:configId', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, configId: CONFIG_ID_PARAM }, required: ['id', 'configId'] } },
  }, async (req, reply) => {
    try { return svc.getConfig(req.params.id, req.params.configId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/configs', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, body: { type: 'string', maxLength: 100_000 } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return svc.createConfig(req.params.id, req.body); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.put('/:id/configs/:configId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM, configId: CONFIG_ID_PARAM }, required: ['id', 'configId'] },
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 }, body: { type: 'string', maxLength: 100_000 } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return svc.updateConfig(req.params.id, req.params.configId, req.body); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.delete('/:id/configs/:configId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, configId: CONFIG_ID_PARAM }, required: ['id', 'configId'] } },
  }, async (req, reply) => {
    try { return svc.deleteConfig(req.params.id, req.params.configId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // ── startup-config profiles ───────────────────────────────────────────────────
  // Static sub-paths (/schema, /capture) are declared before '/:profileId' so the
  // parametric matcher can't shadow them.
  app.get('/:id/profiles', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return svc.listProfiles(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.get('/:id/profiles/schema', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return await svc.profileSchema(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/profiles', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 48 }, settings: { type: 'object' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return svc.createProfile(req.params.id, req.body); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/profiles/capture', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 48 } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return await svc.captureProfile(req.params.id, req.body.name); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.get('/:id/profiles/:profileId', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, profileId: CONFIG_ID_PARAM }, required: ['id', 'profileId'] } },
  }, async (req, reply) => {
    try { return svc.getProfile(req.params.id, req.params.profileId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.put('/:id/profiles/:profileId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM, profileId: CONFIG_ID_PARAM }, required: ['id', 'profileId'] },
      body: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 48 }, settings: { type: 'object' } },
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return svc.updateProfile(req.params.id, req.params.profileId, req.body); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.delete('/:id/profiles/:profileId', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, profileId: CONFIG_ID_PARAM }, required: ['id', 'profileId'] } },
  }, async (req, reply) => {
    try { return svc.deleteProfile(req.params.id, req.params.profileId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/profiles/:profileId/apply', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, profileId: CONFIG_ID_PARAM }, required: ['id', 'profileId'] } },
  }, async (req, reply) => {
    try { return await svc.applyProfile(req.params.id, req.params.profileId); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // ── offsite backups (Phase 4; Factorio + Minecraft via rclone → R2) ───────────
  app.get('/:id/backups', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return await svc.listBackups(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/backups', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return await svc.createBackup(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/backups/:name/restore', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, name: BACKUP_NAME_PARAM }, required: ['id', 'name'] } },
  }, async (req, reply) => {
    try { return await svc.restoreBackup(req.params.id, req.params.name); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.delete('/:id/backups/:name', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM, name: BACKUP_NAME_PARAM }, required: ['id', 'name'] } },
  }, async (req, reply) => {
    try { return await svc.deleteBackup(req.params.id, req.params.name); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // ── live commands (Phase 3; RCON / console) ───────────────────────────────────
  app.get('/:id/live', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try { return await svc.getLive(req.params.id); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/live/command', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
      body: {
        type: 'object',
        properties: { command: { type: 'string', minLength: 1, maxLength: 512 } },
        required: ['command'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try { return await svc.sendCommand(req.params.id, req.body.command); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  app.post('/:id/live/action', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] },
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
  }, async (req, reply) => {
    try { return await svc.runLiveAction(req.params.id, req.body.action, req.body.value); }
    catch (err) { if (sendErr(err, reply)) return; throw err; }
  });

  // ── config files (Phase 3) ────────────────────────────────────────────────────
  app.get('/:id/config', {
    preHandler: requireAdmin,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try {
      return svc.listConfig(req.params.id);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  app.get('/:id/config/:file', {
    preHandler: requireAdmin,
    schema: {
      params: {
        type: 'object',
        properties: { id: ID_PARAM, file: { type: 'string', minLength: 1, maxLength: 128 } },
        required: ['id', 'file'],
      },
    },
  }, async (req, reply) => {
    try {
      return await svc.readConfig(req.params.id, req.params.file);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  app.put('/:id/config/:file', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: {
      params: {
        type: 'object',
        properties: { id: ID_PARAM, file: { type: 'string', minLength: 1, maxLength: 128 } },
        required: ['id', 'file'],
      },
      body: {
        type: 'object',
        properties: { content: { type: 'string', maxLength: 1_000_000 } },
        required: ['content'],
        additionalProperties: false,
      },
    },
  }, async (req, reply) => {
    try {
      return await svc.writeConfig(req.params.id, req.params.file, req.body.content);
    } catch (err) {
      if (handleError(err, reply)) return;
      throw err;
    }
  });

  // ── update recipe (Phase 3) ─────────────────────────────────────────────────
  app.post('/:id/update', {
    preHandler: requireAdmin,
    onRequest: app.csrfProtection,
    schema: { params: { type: 'object', properties: { id: ID_PARAM }, required: ['id'] } },
  }, async (req, reply) => {
    try {
      return await svc.runUpdate(req.params.id);
    } catch (err) {
      if (err?.code === 'NO_UPDATE_RECIPE') {
        return reply.code(501).send({ error: err.message, code: 'NO_UPDATE_RECIPE' });
      }
      if (handleError(err, reply)) return;
      throw err;
    }
  });
}
