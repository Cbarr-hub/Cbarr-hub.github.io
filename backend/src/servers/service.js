// Service / orchestration layer for game-server control.
//
// Sits between the HTTP routes and the connectors, but only for the genuinely
// composite reads/mutations (status caches, presence overlay, power actions,
// session analytics, BlueMap). Plain per-connector operations are NOT wrapped
// here — the route layer's OPS table dispatches them via connectorFor(id)
// directly. It knows nothing about Fastify, requests, auth, or transport.

import { listServers, getServer, connectString, launchUrl } from './registry.js';
import { buildConnectors } from './connectors/index.js';
import { createServerStore } from './store.js';
import { parseBlueMapStatus } from './bluemap.js';

export class ServerControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ServerControlError';
    this.code = code; // 'NOT_CONFIGURED' | 'UNKNOWN_SERVER' | 'UNKNOWN_CONFIG' | 'BAD_ACTION'
  }
}

const POWER_ACTIONS = new Set(['start', 'shutdown', 'reboot', 'stop']);
// The container IS the game, so the legacy game-service action names alias to
// container power at this boundary ("never BAD_ACTION" — see docker.test.mjs).
const LEGACY_POWER_ALIAS = { startGame: 'start', stopGame: 'shutdown', restartGame: 'reboot' };
// Status-cache freshness windows. 'quick' lists skip per-container stats so they
// poll fast and tolerate only ~1s of staleness; 'full' lists carry cpu/mem and
// refresh less often. The host dashboard (containers count etc.) moves slowly, so
// it caches for a minute. clearStatusCache() drops all of these on a mutation.
const LIST_CACHE_TTL_MS = { quick: 1_000, full: 3_000 };
const NODE_CACHE_TTL_MS = 60_000;
const LIVE_PRESENCE_TTL_MS = 1_000;

function samePresencePlayer(row, slug, player) {
  if (row.slug !== slug) return false;
  const uid = String(player.uid || '').trim();
  if (uid && String(row.uid || '').trim() === uid) return true;
  return String(row.name || '').trim().toLowerCase() === String(player.name || '').trim().toLowerCase();
}

function livePresenceKey(slug, player) {
  return `${slug}:${String(player.uid || player.name || '').trim().toLowerCase()}`;
}

/**
 * @param {object} deps
 * @param {import('../docker/client.js').DockerClient|null} [deps.dockerClient]
 *        Docker transport, or null when DOCKER_HOST isn't configured.
 * @param {import('better-sqlite3').Database|null} [deps.db]
 *        shared DB; backs the connectors' persisted catalog/config store.
 * @param {Map<string, object>|null} [deps.connectorsOverride]
 *        TEST SEAM ONLY — a pre-built id→connector map that REPLACES the registry's
 *        Docker connectors. Lets a test inject stub connectors with deterministic
 *        listOnlinePlayers()/getPlayerPosition()/status() so the live-presence
 *        overlay can be exercised without a real RCON socket. Production never
 *        passes it (connectors are built from dockerClient).
 *
 * The service is "configured" when the Docker backend is wired; each server in
 * the registry binds to its backend and is skipped when that backend is absent.
 */
export function createServerService({ dockerClient = null, publicHost = '', db = null, connectorsOverride = null }) {
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
  const connectors = connectorsOverride
    ?? (dockerClient ? buildConnectors({ docker: dockerClient }, store) : null);
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
  let livePresenceCache = null;
  const liveSeenAt = new Map();

  function clearStatusCache() {
    listCache.clear();
    // nodeStatus carries the volatile containers/containersRunning counts, so a
    // power action must invalidate it too — otherwise the host dashboard's
    // running count lags the per-server list by up to NODE_CACHE_TTL_MS.
    nodeCache = null;
    // The live-presence overlay caches the last poll for LIVE_PRESENCE_TTL_MS too,
    // so a just-stopped server could otherwise still report online>0 on the next
    // list. Drop it (and the first-seen map) so the post-mutation read re-polls.
    livePresenceCache = null;
    liveSeenAt.clear();
  }

  function listMode(opts = {}) {
    return opts.mode === 'quick' ? 'quick' : 'full';
  }

  async function computeServerList(mode) {
    // The tile's "playing now" badge must equal the deduplicated /online roster:
    // mergeLiveOnlineRows is the UNION of host-tracked sessions + live-overlay
    // players, so Math.max(|host|,|live|) under-reports when the two sets overlap by
    // DIFFERENT members. Count per slug off the SAME merged roster so the badge ==
    // listOnline().filter(r => r.slug === server.id).length by construction.
    const hostRows = store ? store.listOnline() : [];
    const live = await readLivePresence();
    const onlineBySlug = {};
    for (const row of mergeLiveOnlineRows(hostRows, live)) {
      onlineBySlug[row.slug] = (onlineBySlug[row.slug] ?? 0) + 1;
    }
    return Promise.all(listServers().map(async (server) => {
      const connector = connectors.get(server.id);
      const meta = { ...(await publicMeta(server, connector)), online: onlineBySlug[server.id] ?? 0 };
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

  async function readLivePresence() {
    if (!connectors) return new Map();
    const now = Date.now();
    if (livePresenceCache && now - livePresenceCache.at < LIVE_PRESENCE_TTL_MS) return livePresenceCache.promise;
    const seenAt = Math.floor(now / 1000);
    const promise = Promise.all(listServers().map(async (server) => {
      const connector = connectors.get(server.id);
      if (!connector?.listOnlinePlayers) return [server.id, []];
      try {
        const players = await connector.listOnlinePlayers();
        return [server.id, (players || []).map((p) => ({
          ...p,
          name: String(p?.name || '').trim(),
          identityKind: p?.identityKind || server.identityKind || null,
        })).filter((p) => p.name)];
      } catch {
        // Read FAILED — distinguish from "nobody online" with a null sentinel so
        // the eviction pass below leaves this slug's first-seen timestamps intact.
        // Returning [] here would evict them and the next good poll would re-stamp
        // joinedAt=now, rewinding live-only players' displayed join time.
        return [server.id, null];
      }
    })).then((entries) => {
      // Only slugs that actually returned a roster (incl. a genuine []) participate
      // in eviction; a failed slug (null) preserves its liveSeenAt keys + emits no
      // rows this cycle. Build the surviving-key set from succeeding slugs only.
      const succeeded = new Set();
      const active = new Set();
      const bySlug = new Map();
      for (const [slug, players] of entries) {
        if (players === null) { bySlug.set(slug, []); continue; }
        succeeded.add(slug);
        const rows = [];
        for (const player of players) {
          const key = livePresenceKey(slug, player);
          if (!liveSeenAt.has(key)) liveSeenAt.set(key, seenAt);
          active.add(key);
          rows.push({ ...player, joinedAt: liveSeenAt.get(key), live: true });
        }
        bySlug.set(slug, rows);
      }
      for (const key of liveSeenAt.keys()) {
        // Key shape is `${slug}:${uid||name}` — only evict a key whose slug polled
        // successfully this cycle and didn't report that player; a failed slug's
        // keys are kept so their first-seen time survives the transient error.
        const slug = key.slice(0, key.indexOf(':'));
        if (succeeded.has(slug) && !active.has(key)) liveSeenAt.delete(key);
      }
      return bySlug;
    });
    livePresenceCache = { at: now, promise };
    return promise;
  }

  function mergeLiveOnlineRows(rows, liveBySlug) {
    const out = [...rows];
    for (const server of listServers()) {
      for (const player of liveBySlug.get(server.id) || []) {
        if (out.some((row) => samePresencePlayer(row, server.id, player))) continue;
        out.push({
          id: `live:${server.id}:${player.name}`,
          slug: server.id,
          gameName: server.name,
          playerId: null,
          name: player.name,
          uid: player.uid || null,
          identityKind: player.identityKind || server.identityKind || null,
          joined_at: player.joinedAt,
          source: 'live',
          userId: null,
          userName: null,
          live: true,
        });
      }
    }
    out.sort((a, b) => (b.joined_at ?? 0) - (a.joined_at ?? 0));
    return out;
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
  async function publicMeta(server, connector = null) {
    let password = '';
    if (connector?.connectPassword) {
      try { password = await connector.connectPassword(); } catch { password = ''; }
    }
    return {
      id: server.id,
      name: server.name,
      connect: {
        host: publicHost,
        port: server.port,
        password: password || null,
        string: connectString(server, publicHost, password),
        launch: launchUrl(server, publicHost, password),
      },
    };
  }

  return {
    // Host-level dashboard: the Docker host/engine facts (kind:'docker'); the UI
    // pairs that with the per-container cpu/mem it already gets from /api/servers.
    // Throws NOT_CONFIGURED when the backend isn't wired.
    async getNodeStatus() {
      if (!dockerClient) {
        throw new ServerControlError('server control is not configured', 'NOT_CONFIGURED');
      }
      const now = Date.now();
      // Cache the in-flight PROMISE (not just the resolved value) so concurrent
      // cold-cache callers share one dockerClient.nodeStatus() fan-out instead of
      // each firing their own — same dedup pattern as cachedServerList. A rejected
      // compute is evicted so the next caller retries.
      if (nodeCache && (!nodeCache.settled || now - nodeCache.at < NODE_CACHE_TTL_MS)) {
        return nodeCache.promise;
      }
      const entry = { at: now, settled: false, promise: null };
      const promise = dockerClient.nodeStatus()
        .then((status) => ({ kind: 'docker', ...status }))
        .catch((err) => { if (nodeCache?.promise === promise) nodeCache = null; throw err; })
        .finally(() => { entry.settled = true; });
      entry.promise = promise;
      nodeCache = entry;
      return promise;
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
      const connector = connectorFor(id);
      const status = await connector.status({ stats: listMode(opts) !== 'quick' });
      return { ...(await publicMeta(server, connector)), ...status };
    },

    // action ∈ start|shutdown|reboot|stop (+ the legacy aliases). Returns
    // { ok, action } (the backend returns a task id we don't surface yet).
    async doAction(id, action) {
      const verb = LEGACY_POWER_ALIAS[action] ?? action;
      if (!POWER_ACTIONS.has(verb)) {
        throw new ServerControlError(`invalid action: ${action}`, 'BAD_ACTION');
      }
      const connector = connectorFor(id);
      await connector[verb]();
      clearStatusCache();
      return { ok: true, action };
    },

    // ── connector dispatch seam (the route layer's OPS table) ────────────────
    // Resolve one server's connector (typed NOT_CONFIGURED / UNKNOWN_SERVER
    // errors). The per-connector operations (settings/maps/configs/profiles/
    // live/config-files/update) are invoked on the connector directly;
    // clearStatusCache is exposed alongside so the mutating ops can bust the
    // status caches after success.
    connectorFor,
    clearStatusCache,

    // ── presence + activity (read-only; written host-side) ───────────────────
    // Who's online across every hosted server, right now.
    async listOnline() {
      const rows = store ? store.listOnline() : [];
      return mergeLiveOnlineRows(rows, await readLivePresence());
    },
    // Live online players for ONE server, each with a current position — the source
    // for the BlueMap live-marker writer. Unlike listTrackedOnline() (host-tracker
    // rows, which are empty without the keeper-side collector), this asks the game
    // server directly over RCON, so markers work in dev too and reflect real-time
    // presence. One server only (no fan-out): one `list` + one position per player.
    async liveOnlineWithPositions(id) {
      const server = getServer(id);
      if (!server) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      const connector = connectorFor(id);
      if (!connector?.listOnlinePlayers || !connector?.getPlayerPosition) return [];
      const online = (await connector.listOnlinePlayers()) || [];
      const out = [];
      for (const p of online) {
        const name = String(p?.name || '').trim();
        if (!name) continue;
        let position;
        try {
          // Position by NAME (Minecraft `data get entity <name>` is reliable); the
          // uid is only carried through for the marker/skin key.
          position = await connector.getPlayerPosition(name, p);
        } catch {
          continue; // skip a player we can't currently position
        }
        if (!position || position.connected === false) continue;
        out.push({
          name,
          uid: p.uid || null,
          identityKind: p.identityKind || server.identityKind || null,
          position,
        });
      }
      return out;
    },
    // Newest-first join/leave feed merged across all hosted servers (timeline).
    recentActivity(opts = {}) {
      return store ? store.recentSessions(opts) : [];
    },

    // Aggregate session analytics for the "Pulse" view. `days` (0..365; default 30,
    // 0 = all time) sets the window; `tz` is the viewer's UTC offset in MINUTES
    // (what `-new Date().getTimezoneOffset()` gives) for local-time heatmap buckets.
    sessionStats({ days, tz } = {}) {
      const empty = {
        range: { days: 0, since: 0, tz: 0 },
        totals: { sessions: 0, players: 0, hours: 0 },
        perGame: [], topPlayers: [], heatmap: [], busiest: null,
      };
      if (!store) return empty;
      // Explicit default so `days === 0` means "all time" rather than falling
      // through `|| 30`. Then clamp to [0, 365].
      const dRaw = days === undefined ? 30 : Math.trunc(Number(days) || 0);
      const d = Math.max(0, Math.min(365, dRaw));
      const t = Math.max(-840, Math.min(840, Math.trunc(Number(tz) || 0)));
      const now = Math.floor(Date.now() / 1000);
      const since = d === 0 ? 0 : now - d * 86400;
      const raw = store.sessionStats({ since, tzMod: `${t} minutes` });
      const toHours = (secs) => Math.round(((secs || 0) / 3600) * 10) / 10;
      let busiest = null;
      for (const c of raw.heatmap) {
        if (!busiest || c.n > busiest.count) busiest = { weekday: c.wd, hour: c.hr, count: c.n };
      }
      return {
        range: { days: d, since, tz: t },
        totals: {
          sessions: raw.totals.sessions || 0,
          players: raw.totals.players || 0,
          hours: toHours(raw.totals.secs),
        },
        perGame: raw.perGame.map((g) => ({
          slug: g.slug, name: g.name, sessions: g.sessions, players: g.players, hours: toHours(g.secs),
        })),
        topPlayers: raw.topPlayers.map((p) => ({
          playerId: p.playerId, name: p.name, userId: p.userId, userName: p.userName,
          sessions: p.sessions, games: p.games, hours: toHours(p.secs),
        })),
        heatmap: raw.heatmap,
        busiest,
      };
    },

    async getOnlinePlayerPosition(id, sessionId) {
      const server = getServer(id);
      if (!server) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      if (!server.identityKind) throw new ServerControlError(`${server.name} has no player identity namespace`, 'NOT_SUPPORTED');
      if (!store) return { serverId: id, serverName: server.name, linked: false, online: false, reason: 'database unavailable' };
      const session = store.openSessionById(id, sessionId);
      if (!session) throw new ServerControlError('online player session not found', 'NOT_FOUND');
      const connector = connectorFor(id);
      if (!connector.getPlayerPosition) {
        throw new ServerControlError(`${server.name} position lookup is not supported`, 'NOT_SUPPORTED');
      }
      const target = session.name || session.uid;
      const position = await connector.getPlayerPosition(target, session);
      const online = position?.connected === false ? false : true;
      return {
        serverId: id,
        serverName: server.name,
        linked: true,
        online,
        player: {
          id: session.playerId,
          identityKind: session.identityKind,
          uid: session.uid,
          name: session.userName || session.name,
        },
        session,
        position,
        ...(online ? {} : { reason: position?.reason || `${server.name} position unavailable` }),
      };
    },

    async getOnlinePlayerPositionByName(id, playerName) {
      const server = getServer(id);
      if (!server) throw new ServerControlError(`unknown server: ${id}`, 'UNKNOWN_SERVER');
      if (!server.identityKind) throw new ServerControlError(`${server.name} has no player identity namespace`, 'NOT_SUPPORTED');
      const connector = connectorFor(id);
      if (!connector.getPlayerPosition) {
        throw new ServerControlError(`${server.name} position lookup is not supported`, 'NOT_SUPPORTED');
      }
      const target = String(playerName || '').trim();
      if (connector.listOnlinePlayers) {
        const players = await connector.listOnlinePlayers();
        if (!(players || []).some((p) => String(p?.name || '').trim().toLowerCase() === target.toLowerCase())) {
          throw new ServerControlError('online player not found', 'NOT_FOUND');
        }
      }
      const position = await connector.getPlayerPosition(target, { name: target, identityKind: server.identityKind });
      const online = position?.connected === false ? false : true;
      return {
        serverId: id,
        serverName: server.name,
        linked: true,
        online,
        player: {
          id: null,
          identityKind: server.identityKind,
          uid: null,
          name: position?.name || target,
        },
        session: {
          id: null,
          playerId: null,
          name: position?.name || target,
          uid: null,
          identityKind: server.identityKind,
          joined_at: null,
          source: 'live',
        },
        position,
        ...(online ? {} : { reason: position?.reason || `${server.name} position unavailable` }),
      };
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
