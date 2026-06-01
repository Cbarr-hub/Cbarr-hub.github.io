// Service / orchestration layer for game-server control.
//
// Sits between the HTTP routes and the connectors. Responsibilities:
//   - validate a logical server id against the registry
//   - dispatch the requested operation to that server's connector
//   - normalize results and raise typed errors the route layer maps to HTTP
// It knows nothing about Fastify, requests, auth, or Proxmox HTTP details.

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

// Shape Proxmox's `/nodes/{node}/status` payload into a stable, UI-friendly
// dashboard object. Proxmox reports cpu as a 0..1 fraction and memory/rootfs in
// bytes; we keep raw values and let the client render gauges. Everything is
// defensively defaulted so a partial payload never blanks the whole dashboard.
export function normalizeNodeStatus(data) {
  const mem = data?.memory ?? {};
  const swap = data?.swap ?? {};
  const root = data?.rootfs ?? {};
  const cpus = data?.cpuinfo?.cpus ?? null;
  return {
    uptime: data?.uptime ?? 0,                         // seconds
    cpu: data?.cpu ?? null,                             // fraction 0..1
    cpus,                                               // logical core count
    cpuModel: data?.cpuinfo?.model ?? null,
    loadavg: Array.isArray(data?.loadavg)               // ['0.10','0.20','0.30']
      ? data.loadavg.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [],
    memory: { total: mem.total ?? null, used: mem.used ?? null, free: mem.free ?? null },
    swap: { total: swap.total ?? null, used: swap.used ?? null },
    rootfs: { total: root.total ?? null, used: root.used ?? null },
    kversion: data?.kversion ?? null,
    pveversion: data?.pveversion ?? null,
  };
}

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

    // Host-level dashboard: live resource snapshot of the Proxmox node itself.
    // Returns { node: <name>, ...normalized } so the UI can render CPU/RAM/load
    // gauges. Throws NOT_CONFIGURED when PVE isn't wired up.
    async getNodeStatus() {
      if (!client) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      const data = await client.nodeStatus();
      return { node: client.node, ...normalizeNodeStatus(data) };
    },

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
    syncMaps(id) {
      return connectorFor(id).syncMaps();
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
