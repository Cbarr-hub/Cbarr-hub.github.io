// Service / orchestration layer for game-server control.
//
// Sits between the HTTP routes and the connectors. Responsibilities:
//   - validate a logical server id against the registry
//   - dispatch the requested operation to that server's connector
//   - normalize results and raise typed errors the route layer maps to HTTP
// It knows nothing about Fastify, requests, auth, or transport HTTP details.

import { listServers, getServer, connectString, launchUrl } from './registry.js';
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
 * @param {import('../docker/client.js').DockerClient|null} [deps.dockerClient]
 *        Docker transport, or null when DOCKER_HOST isn't configured.
 * @param {import('better-sqlite3').Database|null} [deps.db]
 *        shared DB; backs the connectors' persisted catalog/config store.
 *
 * The service is "configured" when the Docker backend is wired; each server in
 * the registry binds to its backend and is skipped when that backend is absent.
 */
export function createServerService({ dockerClient = null, publicHost = '', db = null }) {
  const store = db ? createServerStore(db) : null;
  const connectors = dockerClient
    ? buildConnectors({ docker: dockerClient }, store)
    : null;

  function connectorFor(id) {
    if (!connectors) {
      throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
    }
    const c = connectors.get(id);
    if (!c) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
    return c;
  }

  // Shape a registry entry for the API — expose only public-facing fields (the
  // container locator stays server-side).
  function publicMeta(server) {
    return {
      id: server.id,
      name: server.name,
      connect: {
        host: publicHost,
        port: server.port,
        string: connectString(server, publicHost),
        launch: launchUrl(server, publicHost),
      },
    };
  }

  return {
    isConfigured: () => Boolean(connectors),

    // Host-level dashboard: the Docker host/engine facts (kind:'docker'); the UI
    // pairs that with the per-container cpu/mem it already gets from /api/servers.
    // Throws NOT_CONFIGURED when the backend isn't wired.
    async getNodeStatus() {
      if (dockerClient) {
        return { kind: 'docker', ...(await dockerClient.nodeStatus()) };
      }
      throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
    },

    // List every server with its current status. Status failures are captured
    // per-server so one unreachable VM doesn't blank the whole list.
    async listServers() {
      if (!connectors) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      return Promise.all(listServers().map(async (server) => {
        const meta = publicMeta(server);
        const connector = connectors.get(server.id);
        if (!connector) return { ...meta, status: 'unknown', reason: 'backend not configured' };
        try {
          const status = await connector.status();
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

    // action ∈ start|shutdown|reboot|stop. Returns { ok, action } (the backend
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
    syncMaps(id) {
      return connectorFor(id).syncMaps();
    },
    addMap(id, body) {
      return connectorFor(id).addMap(body);
    },
    importCollection(id, collectionId) {
      return connectorFor(id).importCollection(collectionId);
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

    // ── startup-config profiles ──────────────────────────────────────────────
    listProfiles(id) {
      return connectorFor(id).listProfiles();
    },
    profileSchema(id) {
      return connectorFor(id).profileSchema();
    },
    getProfile(id, profileId) {
      return connectorFor(id).getProfile(profileId);
    },
    createProfile(id, body) {
      return connectorFor(id).createProfile(body);
    },
    updateProfile(id, profileId, body) {
      return connectorFor(id).updateProfile(profileId, body);
    },
    deleteProfile(id, profileId) {
      return connectorFor(id).deleteProfile(profileId);
    },
    applyProfile(id, profileId) {
      return connectorFor(id).applyProfile(profileId);
    },
    captureProfile(id, name) {
      return connectorFor(id).captureProfile(name);
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
