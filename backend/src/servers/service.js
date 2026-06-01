// Service / orchestration layer for game-server control.
//
// Sits between the HTTP routes and the connectors. Responsibilities:
//   - validate a logical server id against the registry
//   - dispatch the requested operation to that server's connector
//   - normalize results and raise typed errors the route layer maps to HTTP
// It knows nothing about Fastify, requests, auth, or Proxmox HTTP details.

import { listServers, getServer, connectString } from './registry.js';
import { buildConnectors } from './connectors/index.js';
import { createServerStore } from './store.js';

export class ServerControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServerControlError';
    this.code = code; // 'NOT_CONFIGURED' | 'UNKNOWN_SERVER' | 'UNKNOWN_CONFIG' | 'BAD_ACTION'
  }
}

const POWER_ACTIONS = new Set(['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame']);

/**
 * @param {object} deps
 * @param {import('../proxmox/client.js').ProxmoxClient|null} deps.client
 *        null when PVE isn't configured — every call then throws NOT_CONFIGURED.
 * @param {import('better-sqlite3').Database|null} [deps.db]
 *        shared DB; backs the connectors' persisted catalog/config store.
 */
export function createServerService({ client, publicHost = '', db = null }) {
  const store = db ? createServerStore(db) : null;
  const connectors = client ? buildConnectors(client, store) : null;

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
    return {
      id: server.id,
      name: server.name,
      vmid: server.vmid,
      connect: { host: publicHost, port: server.port, string: connectString(server, publicHost) },
    };
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

    // ── structured quick settings ────────────────────────────────────────────
    getSettings(id) {
      return connectorFor(id).getSettings();
    },
    setSettings(id, values) {
      return connectorFor(id).setSettings(values);
    },

    // ── workshop map catalog (Phase 2; CS) ───────────────────────────────────
    listMaps(id) {
      return connectorFor(id).listMaps();
    },
    addMap(id, body) {
      return connectorFor(id).addMap(body);
    },
    renameMap(id, workshopId, name) {
      return connectorFor(id).renameMap(workshopId, name);
    },
    deleteMap(id, workshopId) {
      return connectorFor(id).deleteMap(workshopId);
    },

    // ── config library (Phase 2; CS) ─────────────────────────────────────────
    listConfigs(id) {
      return connectorFor(id).listConfigs();
    },
    getConfig(id, configId) {
      return connectorFor(id).getConfig(configId);
    },
    createConfig(id, body) {
      return connectorFor(id).createConfig(body);
    },
    updateConfig(id, configId, body) {
      return connectorFor(id).updateConfig(configId, body);
    },
    deleteConfig(id, configId) {
      return connectorFor(id).deleteConfig(configId);
    },

    // ── offsite backups (Phase 4; Factorio + Minecraft) ──────────────────────
    listBackups(id) {
      return connectorFor(id).listBackups();
    },
    createBackup(id) {
      return connectorFor(id).createBackup();
    },
    restoreBackup(id, name) {
      return connectorFor(id).restoreBackup(name);
    },
    deleteBackup(id, name) {
      return connectorFor(id).deleteBackup(name);
    },

    // ── live commands (Phase 3) ──────────────────────────────────────────────
    getLive(id) {
      return connectorFor(id).getLive();
    },
    sendCommand(id, command) {
      return connectorFor(id).sendCommand(command);
    },
    runLiveAction(id, action, value) {
      return connectorFor(id).runLiveAction(action, value);
    },
  };
}
