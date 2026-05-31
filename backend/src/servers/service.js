// Service / orchestration layer for game-server control.
//
// Sits between the HTTP routes and the connectors. Responsibilities:
//   - validate a logical server id against the registry
//   - dispatch the requested operation to that server's connector
//   - normalize results and raise typed errors the route layer maps to HTTP
// It knows nothing about Fastify, requests, auth, or Proxmox HTTP details.

import { listServers, getServer } from './registry.js';
import { buildConnectors } from './connectors/index.js';

export class ServerControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServerControlError';
    this.code = code; // 'NOT_CONFIGURED' | 'UNKNOWN_SERVER' | 'UNKNOWN_CONFIG' | 'BAD_ACTION'
  }
}

const POWER_ACTIONS = new Set(['start', 'shutdown', 'reboot', 'stop']);

/**
 * @param {object} deps
 * @param {import('../proxmox/client.js').ProxmoxClient|null} deps.client
 *        null when PVE isn't configured — every call then throws NOT_CONFIGURED.
 */
export function createServerService({ client }) {
  const connectors = client ? buildConnectors(client) : null;

  function connectorFor(id) {
    if (!connectors) {
      throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
    }
    const c = connectors.get(id);
    if (!c) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
    return c;
  }

  // Shape a registry entry for the API (never leak internal-only fields beyond vmid).
  function publicMeta(server) {
    return { id: server.id, name: server.name, vmid: server.vmid };
  }

  return {
    isConfigured: () => Boolean(connectors),

    // List every server with its current status. Status failures are captured
    // per-server so one unreachable VM doesn't blank the whole list.
    async listServers() {
      if (!connectors) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      return Promise.all(listServers().map(async (server) => {
        const meta = publicMeta(server);
        try {
          const status = await connectors.get(server.id).status();
          return { ...meta, ...status };
        } catch (err) {
          return { ...meta, status: 'unknown', error: err.message };
        }
      }));
    },

    async getStatus(id) {
      const server = getServer(id);
      if (!server) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      const status = await connectorFor(id).status();
      return { ...publicMeta(server), ...status };
    },

    // action ∈ start|shutdown|reboot|stop. Returns { ok, action } (Proxmox
    // returns a task id we don't surface yet).
    async doAction(id, action) {
      if (!POWER_ACTIONS.has(action)) {
        throw new ServerControlError(`invalid action: ${action}`, 'BAD_ACTION');
      }
      const connector = connectorFor(id);
      await connector[action]();
      return { ok: true, action };
    },

    // ── config + update (Phase 3) ────────────────────────────────────────────
    listConfig(id) {
      return { id, files: connectorFor(id).listConfigFiles() };
    },
    readConfig(id, file) {
      return connectorFor(id).readConfig(file);
    },
    writeConfig(id, file, content) {
      return connectorFor(id).writeConfig(file, content);
    },
    runUpdate(id) {
      return connectorFor(id).update();
    },
  };
}
