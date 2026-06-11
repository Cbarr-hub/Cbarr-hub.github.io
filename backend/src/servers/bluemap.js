// Everything BlueMap: live player markers, render-status parsing, and the CPU
// tuner — one module (replaces bluemap-players.js / bluemap-status.js /
// bluemap-resources.js).
//
// MARKERS — BlueMap's webapp polls `<webroot>/maps/<id>/live/players.json` and
// renders each entry as a head-billboard marker, loading the head texture from
// the SAME map's asset root (`<webroot>/maps/<id>/assets/playerheads/<uuid>.png`
// — NOT a global dir; per-map triplication is forced by BlueMap v5). With the
// plugin/mod the game server writes these; we run the standalone renderer, so
// this controller polls live players over RCON (serverService
// .liveOnlineWithPositions) and writes the files into the `bluemap` container
// through the scoped docker-proxy — live markers with real skins, no
// Fabric/Paper. Perf model: dirs are created once (re-checked only after a
// failure), the usercache read is TTL-cached in the minecraft spec, the tick
// backs off 2s→10s while nobody is online, and the JSON is built once with only
// the `foreign` flag flipped per map.
//
// TUNER — keep render CPU off the game while people play: active = a small cap,
// idle = host cpus minus a reserve, with an idle-delay hysteresis. Presence
// comes from a cheap injected countOnline() (one indexed sqlite COUNT over the
// host tracker's open sessions — no RCON, no docker calls); host NCPU is static
// and fetched once. (gt-maintenance.mjs used to carry a duplicate of this
// policy; the app-side tuner is the one that runs everywhere.)

const WEB = '/app/web';

// The three rendered dimensions (must match servers.compose.yml `-m` + map IDs).
// `foreign` players (current dimension != this map) stay in BlueMap's player
// list but aren't drawn as markers on the wrong map.
const MAP_DIMENSIONS = [
  { mapId: 'overworld' },
  { mapId: 'nether' },
  { mapId: 'end' },
];

const BILLION = 1_000_000_000;

function boolValue(value, def = true) {
  if (value === undefined || value === null || value === '') return def;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function numValue(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

// Self-rescheduling poller: setTimeout chain (not setInterval) so `delayMs` may
// be a function and the cadence can change between ticks (the marker idle
// backoff). tick() owns its own in-flight guard.
export function makePoller(tick, delayMs) {
  let timer = null;
  let stopped = true;
  const schedule = () => {
    if (stopped) return;
    const d = typeof delayMs === 'function' ? delayMs() : delayMs;
    timer = setTimeout(async () => { await tick(); schedule(); }, d);
    timer.unref?.();
  };
  return {
    start() {
      if (!stopped) return false;
      stopped = false;
      Promise.resolve(tick()).then(schedule);
      return true;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// ── render status (GET /api/servers/map/status) ────────────────────────────────

const PROGRESS_RE = /updating map '([^']+)':\s*([0-9]+(?:\.[0-9]+)?)%\s*(?:\(ETA:\s*([^)]+)\))?/i;

function cleanLine(line) {
  return String(line || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function mapName(id) {
  return String(id || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function parseBlueMapStatus(logText) {
  const lines = String(logText || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length) {
    return { state: 'unknown', message: 'Render status unavailable', percent: null, map: null, eta: null };
  }

  let latestProgress = null;
  let progressIndex = -1;
  let completeIndex = -1;
  let waitingIndex = -1;
  let startingIndex = -1;

  lines.forEach((line, i) => {
    const m = PROGRESS_RE.exec(line);
    if (m) {
      latestProgress = { map: m[1], percent: percent(m[2]), eta: m[3] || null };
      progressIndex = i;
    }
    if (/Your maps are now all up-to-date!/i.test(line)) completeIndex = i;
    if (/Waiting for changes on the world-files/i.test(line)) waitingIndex = i;
    if (/Starting webserver|Loading resources|Start updating \d+ maps?/i.test(line)) startingIndex = i;
  });

  if (completeIndex > progressIndex || waitingIndex > progressIndex) {
    return { state: 'complete', message: 'Render complete', percent: 100, map: null, eta: null };
  }

  if (latestProgress) {
    const eta = latestProgress.eta ? ` - ETA ${latestProgress.eta}` : '';
    return {
      state: 'rendering',
      message: `${mapName(latestProgress.map)} rendering ${latestProgress.percent}%${eta}`,
      ...latestProgress,
    };
  }

  if (startingIndex >= 0) {
    return { state: 'starting', message: 'Render starting', percent: null, map: null, eta: null };
  }

  // Don't surface a raw, unmatched container log line (could be a stack-trace
  // fragment / noise) into the user-facing status pill — use a generic message.
  return { state: 'unknown', message: 'Render status unavailable', percent: null, map: null, eta: null };
}

// ── live player markers ─────────────────────────────────────────────────────────

// Normalize a Mojang UUID to dashed lowercase so the players.json `uuid` and the
// `assets/playerheads/<uuid>.png` filename always agree. FAIL CLOSED: anything
// that isn't exactly 32 hex chars returns null (callers skip it). The value
// flows into a container file path and an outbound skin URL, so we never hand
// back raw input — a stray `/` or `..` would otherwise become a path-traversal
// / URL sink.
export function normalizeUuid(raw) {
  const hex = String(raw || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Pure helper (unit-tested): serialize the players.json for one map.
export function buildPlayersJson(players, mapId) {
  return JSON.stringify({
    players: (players || []).map((p) => ({
      uuid: p.uuid,
      name: p.name,
      foreign: p.mapId !== mapId,
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { pitch: p.pitch ?? 0, yaw: p.yaw ?? 0, roll: 0 },
    })),
  });
}

export function blueMapPlayersOptions(env = {}) {
  return {
    enabled: boolValue(env.BLUEMAP_PLAYERS_AUTOWRITE, true),
    container: String(env.BLUEMAP_CONTAINER || 'bluemap'),
    pollMs: Math.max(1000, numValue(env.BLUEMAP_PLAYERS_POLL_MS, 2000)),
    idlePollMs: Math.max(1000, numValue(env.BLUEMAP_PLAYERS_IDLE_POLL_MS, 10_000)),
    skinBase: String(env.BLUEMAP_SKIN_BASE || 'https://mc-heads.net/avatar').replace(/\/+$/, ''),
    skinTimeoutMs: Math.max(1000, numValue(env.BLUEMAP_SKIN_TIMEOUT_MS, 5000)),
    serverId: String(env.BLUEMAP_PLAYERS_SERVER || 'minecraft'),
  };
}

export function createBlueMapPlayersController({
  dockerClient,
  serverService,
  logger = console,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const opts = blueMapPlayersOptions(env);
  let inFlight = false;
  let emptyWritten = false;       // wrote the "nobody online" file already
  let lastCount = 0;              // drives the idle backoff cadence
  let dirsReady = false;          // mkdir once; re-checked only after a failure
  let failStreak = 0;             // consecutive tick() failures (throttles error logs)
  const skinSeen = new Set();     // uuids whose head PNG we've written this process

  async function ensureDirs() {
    if (dirsReady) return;
    // Per-map live + asset dirs (BlueMap serves heads from each map's own root).
    const dirs = MAP_DIMENSIONS
      .flatMap((m) => [`${WEB}/maps/${m.mapId}/live`, `${WEB}/maps/${m.mapId}/assets/playerheads`])
      .map((d) => `"${d.replace(/"/g, '\\"')}"`)
      .join(' ');
    const r = await dockerClient.exec(opts.container, ['/bin/sh', '-c', `mkdir -p ${dirs}`]);
    if (r?.exitCode != null && r.exitCode !== 0) {
      throw new Error(`bluemap mkdir failed: ${r.stderr || `exit ${r.exitCode}`}`);
    }
    dirsReady = true;
  }

  async function ensureSkin(uuid) {
    if (!uuid || skinSeen.has(uuid) || !fetchImpl) return;
    skinSeen.add(uuid); // mark before fetch so concurrent ticks don't double-fetch
    try {
      // Bound the outbound fetch so a hung head service can't stall the loop.
      const res = await fetchImpl(`${opts.skinBase}/${uuid}/64.png`, { signal: AbortSignal.timeout(opts.skinTimeoutMs) });
      if (!res?.ok) throw new Error(`skin fetch ${res?.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Write the head under EACH rendered map's asset root — that's where
      // BlueMap loads it from.
      for (const { mapId } of MAP_DIMENSIONS) {
        await dockerClient.fileWriteBytes(opts.container, `${WEB}/maps/${mapId}/assets/playerheads/${uuid}.png`, buf);
      }
    } catch (err) {
      skinSeen.delete(uuid); // let a later tick retry; BlueMap shows a default head meanwhile
      logger.debug?.({ err, uuid }, 'BlueMap skin head fetch failed');
    }
  }

  async function collectPlayers() {
    // Live presence straight from the game server over RCON (one `list` + one
    // position per player). Works WITHOUT the host session-tracker (so it
    // renders in dev too); each row carries the Mojang UUID (resolved from the
    // server's usercache, TTL-cached in the minecraft spec).
    const online = await serverService.liveOnlineWithPositions(opts.serverId);
    const players = [];
    for (const row of online) {
      const uuid = normalizeUuid(row.uid);
      if (!uuid) continue; // markers + skins are keyed on the Mojang UUID
      const pos = row.position;
      if (!pos || pos.connected === false) continue;
      players.push({
        uuid,
        name: row.name || 'player',
        x: pos.x, y: pos.y, z: pos.z,
        yaw: pos.yaw, pitch: pos.pitch,
        mapId: pos.mapId || 'overworld',
      });
    }
    return players;
  }

  async function tick() {
    if (!opts.enabled || !dockerClient || !serverService) return null;
    if (inFlight) return null;
    inFlight = true;
    try {
      const players = await collectPlayers();
      lastCount = players.length;
      // Nobody online: clear the markers once, then idle until someone joins.
      if (players.length === 0 && emptyWritten) { failStreak = 0; return { players: 0 }; }

      await ensureDirs();
      await Promise.allSettled(players.map((p) => ensureSkin(p.uuid)));
      for (const { mapId } of MAP_DIMENSIONS) {
        await dockerClient.fileWrite(
          opts.container,
          `${WEB}/maps/${mapId}/live/players.json`,
          buildPlayersJson(players, mapId),
        );
      }
      emptyWritten = players.length === 0;
      failStreak = 0;
      return { players: players.length };
    } catch (err) {
      // Degrade quietly: a stopped bluemap container / docker-proxy blip would
      // otherwise log at error every tick. Error on the first failure, then
      // drop to debug until a tick succeeds again. Re-check the dirs next tick
      // (a recreated container starts with an empty web volume).
      dirsReady = false;
      failStreak += 1;
      logger[failStreak === 1 ? 'error' : 'debug']?.({ err, failStreak }, 'BlueMap players write failed');
      return { error: err };
    } finally {
      inFlight = false;
    }
  }

  const poller = makePoller(tick, () => (lastCount > 0 ? opts.pollMs : opts.idlePollMs));

  function start() {
    if (!opts.enabled || !dockerClient || !serverService) return false;
    return poller.start();
  }

  return { start, stop: poller.stop, tick, options: opts };
}

// ── CPU tuner ───────────────────────────────────────────────────────────────────

function clampCpus(value, hostCpus) {
  const n = Math.max(1, Math.floor(Number(value) || 1));
  return hostCpus > 0 ? Math.min(n, hostCpus) : n;
}

export function targetBlueMapCpus({
  onlineCount = 0,
  hostCpus = 1,
  activeCpus = 2,
  idleCpus = 0,
  reservedCpus = 4,
} = {}) {
  const host = Math.max(1, Math.floor(Number(hostCpus) || 1));
  if (onlineCount > 0) return clampCpus(activeCpus, host);
  const idle = Number(idleCpus) > 0
    ? idleCpus
    : Math.max(1, host - Math.max(0, Math.floor(Number(reservedCpus) || 0)));
  return clampCpus(idle, host);
}

export function blueMapResourceOptions(env = {}) {
  return {
    enabled: boolValue(env.BLUEMAP_RESOURCE_AUTOTUNE, true),
    container: String(env.BLUEMAP_CONTAINER || 'bluemap'),
    pollMs: Math.max(10, numValue(env.BLUEMAP_RESOURCE_POLL_SECONDS, 60)) * 1000,
    idleDelayMs: Math.max(0, numValue(env.BLUEMAP_IDLE_DELAY_SECONDS, 300)) * 1000,
    activeCpus: numValue(env.BLUEMAP_ACTIVE_CPUS, 2),
    idleCpus: numValue(env.BLUEMAP_IDLE_CPUS, 0),
    reservedCpus: numValue(env.BLUEMAP_RESERVED_CPUS, 4),
  };
}

export function createBlueMapResourceController({
  dockerClient,
  countOnline,          // () => number — open host-tracked sessions (cheap sqlite COUNT)
  logger = console,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const opts = blueMapResourceOptions(env);
  let inFlight = false;
  let lastApplied = null;
  let lastMode = null;
  let idleSince = null;
  let hostCpus = null; // NCPU is static — fetched once on the first tick

  async function tick() {
    if (!opts.enabled || !dockerClient || !countOnline) return null;
    if (inFlight) return null;
    inFlight = true;
    try {
      let onlineCount;
      try {
        onlineCount = Number(countOnline()) || 0;
      } catch (err) {
        // Presence unavailable — fail safe: assume someone might be online so
        // the renderer stays capped low rather than starving a live game.
        logger.debug?.({ err }, 'BlueMap tuner presence read failed');
        onlineCount = 1;
      }
      if (hostCpus == null) {
        hostCpus = (await dockerClient.nodeStatus().catch(() => ({})))?.ncpu ?? 1;
      }

      let mode = onlineCount > 0 ? 'active' : 'idle';
      if (onlineCount > 0) {
        idleSince = null;
      } else {
        if (idleSince == null) idleSince = now();
        const idleReady = lastMode == null || lastMode === 'idle' || now() - idleSince >= opts.idleDelayMs;
        if (!idleReady) mode = 'active';
      }

      const cpus = targetBlueMapCpus({
        onlineCount: mode === 'active' ? Math.max(1, onlineCount) : 0,
        hostCpus,
        activeCpus: opts.activeCpus,
        idleCpus: opts.idleCpus,
        reservedCpus: opts.reservedCpus,
      });
      const nanoCpus = cpus * BILLION;

      if (lastApplied !== nanoCpus) {
        await dockerClient.setNanoCpus(opts.container, nanoCpus);
        lastApplied = nanoCpus;
        logger.info?.({ container: opts.container, mode, onlineCount, cpus, hostCpus }, 'updated BlueMap cpu cap');
      }
      lastMode = mode;
      return { container: opts.container, mode, onlineCount, cpus, hostCpus };
    } catch (err) {
      logger.error?.({ err }, 'BlueMap cpu tuning failed');
      return { error: err };
    } finally {
      inFlight = false;
    }
  }

  const poller = makePoller(tick, () => opts.pollMs);

  function start() {
    if (!opts.enabled || !dockerClient || !countOnline) return false;
    return poller.start();
  }

  return { start, stop: poller.stop, tick, options: opts };
}
