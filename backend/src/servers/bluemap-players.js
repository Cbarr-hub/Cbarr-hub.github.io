// Feeds BlueMap's native live-player markers in standalone (CLI) mode.
//
// BlueMap's webapp polls `<webroot>/maps/<id>/live/players.json` and renders each
// entry as a head-billboard marker, plus loads the head texture from the SAME
// map's asset root — `<webroot>/maps/<id>/assets/playerheads/<uuid>.png` — NOT a
// global dir (BlueMapApp builds it as map.data.mapDataRoot + '/assets/playerheads/').
// A player shows in every map's list (foreign), so the head must exist under all
// rendered maps. With the plugin/mod the server writes these; we run the standalone
// renderer, so nothing writes them.
// This controller reuses the app's existing RCON position lookup
// (serverService.getOnlinePlayerPosition*) to write the same files into the
// `bluemap` container through the scoped docker-proxy (EXEC), giving live markers
// with real skins without switching Minecraft to Fabric/Paper.

const WEB = '/app/web';

// The three rendered dimensions (must match servers.compose.yml `-m` + map IDs).
// `foreign` players (those whose current dimension != this map) stay in BlueMap's
// player list but aren't drawn as markers on the wrong map.
const MAP_DIMENSIONS = [
  { mapId: 'overworld' },
  { mapId: 'nether' },
  { mapId: 'end' },
];

function boolValue(value, def = true) {
  if (value === undefined || value === null || value === '') return def;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function numValue(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

// Normalize a Mojang UUID to dashed lowercase so the players.json `uuid` and the
// `assets/playerheads/<uuid>.png` filename always agree. FAIL CLOSED: anything that
// isn't exactly 32 hex chars returns null (callers skip it). The value flows into a
// container file path and an outbound skin URL, so we never hand back raw input —
// a stray `/` or `..` would otherwise become a path-traversal / URL sink.
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
  let timer = null;
  let inFlight = false;
  let emptyWritten = false;       // wrote the "nobody online" file already
  let failStreak = 0;             // consecutive tick() failures (throttles error logs)
  let authWarned = false;         // emitted the RCON-auth warning already
  const skinSeen = new Set();     // uuids whose head PNG we've written this process

  async function ensureDirs() {
    // Per-map live + asset dirs (BlueMap serves heads from each map's own root).
    const dirs = MAP_DIMENSIONS
      .flatMap((m) => [`${WEB}/maps/${m.mapId}/live`, `${WEB}/maps/${m.mapId}/assets/playerheads`])
      .map((d) => `"${d.replace(/"/g, '\\"')}"`)
      .join(' ');
    const { pid } = await dockerClient.agentExec(opts.container, {
      command: ['/bin/sh', '-c', `mkdir -p ${dirs}`],
    });
    const r = await dockerClient.agentExecStatus(opts.container, pid);
    if (r?.exitcode != null && r.exitcode !== 0) {
      throw new Error(`bluemap mkdir failed: ${r['err-data'] || `exit ${r.exitcode}`}`);
    }
  }

  async function ensureSkin(uuid) {
    if (!uuid || skinSeen.has(uuid) || !fetchImpl) return;
    skinSeen.add(uuid); // mark before fetch so concurrent ticks don't double-fetch
    try {
      // Bound the outbound fetch so a hung head service can't stall the loop.
      const res = await fetchImpl(`${opts.skinBase}/${uuid}/64.png`, { signal: AbortSignal.timeout(opts.skinTimeoutMs) });
      if (!res?.ok) throw new Error(`skin fetch ${res?.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Write the head under EACH rendered map's asset root — that's where BlueMap
      // loads it from, and a foreign player still shows in other maps' lists.
      for (const { mapId } of MAP_DIMENSIONS) {
        await dockerClient.agentFileWriteBytes(opts.container, `${WEB}/maps/${mapId}/assets/playerheads/${uuid}.png`, buf);
      }
    } catch (err) {
      skinSeen.delete(uuid); // let a later tick retry; BlueMap shows a default head meanwhile
      logger.debug?.({ err, uuid }, 'BlueMap skin head fetch failed');
    }
  }

  async function collectPlayers() {
    // Host-tracked rows only (carry the per-session id + Mojang UUID, no RCON):
    // avoids the cross-server live-presence fan-out on this tight loop.
    const online = (await serverService.listTrackedOnline())
      .filter((r) => r.slug === opts.serverId && r.id != null);
    const players = [];
    for (const row of online) {
      try {
        const res = await serverService.getOnlinePlayerPosition(opts.serverId, row.id);
        authWarned = false; // a successful lookup means the RCON creds are fine
        const pos = res?.position;
        if (!res?.online || !pos || pos.connected === false) continue;
        const uuid = normalizeUuid(row.uid || res.player?.uid);
        if (!uuid) continue; // markers + skins are keyed on the Mojang UUID
        players.push({
          uuid,
          name: row.userName || row.name || res.player?.name || 'player',
          x: pos.x, y: pos.y, z: pos.z,
          yaw: pos.yaw, pitch: pos.pitch,
          mapId: pos.mapId || 'overworld',
        });
      } catch (err) {
        // A wrong password / RCON misconfig fails every row identically — surface
        // it ONCE at warn so the feature doesn't silently die; everything else
        // (player just left → no entity) stays at debug.
        if (err?.code === 'RCON_AUTH' && !authWarned) {
          authWarned = true;
          logger.warn?.({ err }, 'BlueMap live players: RCON auth failed — check MINECRAFT_RCON_PASSWORD');
        } else {
          logger.debug?.({ err, player: row.name }, 'BlueMap player position lookup failed');
        }
      }
    }
    return players;
  }

  async function tick() {
    if (!opts.enabled || !dockerClient || !serverService) return null;
    if (inFlight) return null;
    inFlight = true;
    try {
      const players = await collectPlayers();
      // Nobody online: clear the markers once, then idle until someone joins.
      if (players.length === 0 && emptyWritten) { failStreak = 0; return { players: 0 }; }

      await ensureDirs();
      await Promise.allSettled(players.map((p) => ensureSkin(p.uuid)));
      for (const { mapId } of MAP_DIMENSIONS) {
        await dockerClient.agentFileWrite(
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
      // otherwise log at error every pollMs (2s). Error on the first failure,
      // then drop to debug until a tick succeeds again.
      failStreak += 1;
      logger[failStreak === 1 ? 'error' : 'debug']?.({ err, failStreak }, 'BlueMap players write failed');
      return { error: err };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!opts.enabled || !dockerClient || !serverService || timer) return false;
    tick();
    timer = setInterval(tick, opts.pollMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, options: opts };
}
