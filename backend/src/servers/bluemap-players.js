// Feeds BlueMap's native live-player markers in standalone (CLI) mode.
//
// BlueMap's webapp polls `<webroot>/maps/<id>/live/players.json` and renders each
// entry as a head-billboard marker, plus loads the head texture from
// `<webroot>/assets/playerheads/<uuid>.png`. With the plugin/mod those files are
// written by the server; we run the standalone renderer, so nothing writes them.
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
// `assets/playerheads/<uuid>.png` filename always agree (BlueMap builds the head
// URL straight from the players.json uuid, so they only need to match each other).
export function normalizeUuid(raw) {
  const hex = String(raw || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 32) return String(raw || '').trim().toLowerCase() || null;
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
  const skinSeen = new Set();     // uuids whose head PNG we've fetched this process

  async function ensureDirs() {
    const dirs = MAP_DIMENSIONS.map((m) => `${WEB}/maps/${m.mapId}/live`)
      .concat(`${WEB}/assets/playerheads`)
      .map((d) => `"${d.replace(/"/g, '\\"')}"`)
      .join(' ');
    const { pid } = await dockerClient.agentExec(opts.container, {
      command: ['/bin/sh', '-c', `mkdir -p ${dirs}`],
    });
    await dockerClient.agentExecStatus(opts.container, pid);
  }

  async function ensureSkin(uuid) {
    if (!uuid || skinSeen.has(uuid) || !fetchImpl) return;
    skinSeen.add(uuid); // mark before fetch so we don't hammer on repeated ticks
    try {
      const res = await fetchImpl(`${opts.skinBase}/${uuid}/64.png`);
      if (!res?.ok) throw new Error(`skin fetch ${res?.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await dockerClient.agentFileWriteBytes(opts.container, `${WEB}/assets/playerheads/${uuid}.png`, buf);
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
        logger.debug?.({ err, player: row.name }, 'BlueMap player position lookup failed');
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
      if (players.length === 0 && emptyWritten) return { players: 0 };

      await ensureDirs();
      for (const p of players) await ensureSkin(p.uuid);
      for (const { mapId } of MAP_DIMENSIONS) {
        await dockerClient.agentFileWrite(
          opts.container,
          `${WEB}/maps/${mapId}/live/players.json`,
          buildPlayersJson(players, mapId),
        );
      }
      emptyWritten = players.length === 0;
      return { players: players.length };
    } catch (err) {
      logger.error?.({ err }, 'BlueMap players write failed');
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
