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
      app.log.error({ err }, 'proxmox upstream error');
      reply.code(502).send({ error: 'upstream Proxmox error', detail: err.message });
      return true;
    }
    return false;
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
          action: { type: 'string', enum: ['start', 'shutdown', 'reboot', 'stop'] },
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
