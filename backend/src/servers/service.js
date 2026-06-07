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
import { parseBlueMapStatus } from './bluemap-status.js';

export class ServerControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServerControlError';
    this.code = code; // 'NOT_CONFIGURED' | 'UNKNOWN_SERVER' | 'UNKNOWN_CONFIG' | 'BAD_ACTION'
  }
}

const POWER_ACTIONS = new Set(['start', 'shutdown', 'reboot', 'stop', 'startGame', 'stopGame', 'restartGame']);
// Status-cache freshness windows. 'quick' lists skip per-container stats so they
// poll fast and tolerate only ~1s of staleness; 'full' lists carry cpu/mem and
// refresh less often. The host dashboard (containers count etc.) moves slowly, so
// it caches for a minute. clearStatusCache() drops all of these on a mutation.
const LIST_CACHE_TTL_MS = { quick: 1_000, full: 3_000 };
const NODE_CACHE_TTL_MS = 60_000;

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
  // Register the hosted game servers in the `games` catalog (hosted=1) so the
  // session collector + the Events section can resolve a slug → game row. Cheap +
  // idempotent; keeps the registry the single source of truth.
  // Catalog convention (the `games` table is shared): hosted=1 rows are game
  // *servers* (slug set, e.g. 'counterstrike'); hosted=0 rows are party/gambling
  // games (slug NULL today). Any consumer of `games` must filter by `hosted`
  // accordingly — e.g. /api/games returns only hosted=0. The slug uniqueness is
  // a PARTIAL index scoped to hosted=1 (migration 006).
  if (store) store.seedHostedGames(listServers());
  const connectors = dockerClient
    ? buildConnectors({ docker: dockerClient }, store)
    : null;
  // Status caches. The servers panel polls `listServers`/`getNodeStatus` on a
  // short interval and several browser tabs can poll at once, so each compute is
  // an expensive fan-out of Docker stats calls. Two caches absorb that:
  //   - `listCache`: per-mode (one entry each for 'quick'/'full'), TTL'd + with
  //     in-flight dedup. See cachedServerList for the full contract.
  //   - `nodeCache`: a single 60s entry for the host dashboard.
  // Both are deliberately allowed to serve data up to TTL_MS stale; a mutation
  // (power action / settings / profile apply / update) calls clearStatusCache to
  // drop everything so the next read reflects the change immediately.
  const listCache = new Map();
  let nodeCache = null;

  function clearStatusCache() {
    listCache.clear();
    // nodeStatus carries the volatile containers/containersRunning counts, so a
    // power action must invalidate it too — otherwise the host dashboard's
    // running count lags the per-server list by up to NODE_CACHE_TTL_MS.
    nodeCache = null;
  }

  function listMode(opts = {}) {
    return opts.mode === 'quick' ? 'quick' : 'full';
  }

  async function computeServerList(mode) {
    // One cheap query for all servers' "playing now" counts (host-tracked).
    const online = store ? store.onlineCountsBySlug() : {};
    return Promise.all(listServers().map(async (server) => {
      const meta = { ...publicMeta(server), online: online[server.id] ?? 0 };
      const connector = connectors.get(server.id);
      if (!connector) return { ...meta, status: 'unknown', reason: 'backend not configured' };
      try {
        const status = await connector.status({ stats: mode !== 'quick' });
        return { ...meta, ...status };
      } catch (err) {
        return { ...meta, status: 'unknown', error: err.message };
      }
    }));
  }

  // Per-mode cached server list with in-flight de-duplication. Cache contract:
  //   - While a compute is in flight (`!settled`), every caller for that mode
  //     shares the SAME promise — N concurrent pollers trigger ONE fan-out.
  //   - Once settled, a fulfilled entry is reused for up to LIST_CACHE_TTL_MS[mode]
  //     (quick 1s / full 3s), so callers may see data that is at-most-TTL stale.
  //     This bounded staleness is intentional; mutations clearStatusCache() to
  //     force a fresh read. After the TTL, the next caller recomputes.
  //   - A REJECTED compute is never cached: the .catch guard evicts the failing
  //     entry (only if it's still the live one — `=== promise` avoids clobbering a
  //     newer entry that already replaced it after clearStatusCache or a recompute),
  //     so the very next caller retries instead of being served a cached error.
  // `entry.settled` is flipped in .finally (after .catch), so an in-flight entry
  // reads as `!settled` for the whole compute regardless of outcome.
  async function cachedServerList(mode) {
    const now = Date.now();
    const cached = listCache.get(mode);
    if (cached && (!cached.settled || now - cached.at < LIST_CACHE_TTL_MS[mode])) {
      return cached.promise;
    }
    const entry = { at: now, settled: false, promise: null };
    const promise = computeServerList(mode)
      .catch((err) => {
        if (listCache.get(mode)?.promise === promise) listCache.delete(mode);
        throw err;
      })
      .finally(() => { entry.settled = true; });
    entry.promise = promise;
    listCache.set(mode, entry);
    return promise;
  }

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
        const now = Date.now();
        if (nodeCache && now - nodeCache.at < NODE_CACHE_TTL_MS) return nodeCache.value;
        const value = { kind: 'docker', ...(await dockerClient.nodeStatus()) };
        nodeCache = { at: now, value };
        return value;
      }
      throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
    },

    // List every server with its current status. Status failures are captured
    // per-server so one unreachable VM doesn't blank the whole list.
    async listServers(opts = {}) {
      if (!connectors) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      return cachedServerList(listMode(opts));
    },

    async getStatus(id, opts = {}) {
      const server = getServer(id);
      if (!server) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      const status = await connectorFor(id).status({ stats: listMode(opts) !== 'quick' });
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
      clearStatusCache();
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
      clearStatusCache();
      return connectorFor(id).update();
    },

    // ── structured quick settings ────────────────────────────────────────────
    getSettings(id) {
      return connectorFor(id).getSettings();
    },
    setSettings(id, values) {
      clearStatusCache();
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
      clearStatusCache();
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

    // ── player sessions (read-only; written host-side by the collector) ───────
    // Validate the id against the registry (like getStatus) so an unknown server
    // 404s instead of silently returning []. With no DB, sessions are empty.
    listSessions(id, opts = {}) {
      if (!getServer(id)) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      return store ? store.listSessions(id, opts) : [];
    },

    // ── presence + activity (read-only; written host-side) ───────────────────
    // Who's online across every hosted server, right now.
    listOnline() {
      return store ? store.listOnline() : [];
    },
    // Newest-first join/leave feed merged across all hosted servers (timeline).
    recentActivity(opts = {}) {
      return store ? store.recentSessions(opts) : [];
    },

    async getBlueMapStatus() {
      if (!dockerClient) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      const logs = await dockerClient.containerLogs('bluemap', { tail: 300 });
      return {
        container: 'bluemap',
        checkedAt: new Date().toISOString(),
        ...parseBlueMapStatus(logs),
      };
    },
  };
}
