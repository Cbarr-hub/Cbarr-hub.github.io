// Single source of truth mapping a logical game-server id to its container.
//
// The locator (container name) MUST only ever come from this table — never from
// a request parameter. The HTTP layer accepts an opaque `id` ("factorio"), looks
// it up here, and the locator never crosses the API boundary. That guarantees the
// control panel can only ever touch these six servers, no matter what a client
// sends.
//
// GMOD shares the Source `connect` join style with CS but uses port 27066 —
// CS already reserves the 27000-27039 external forward range on the router.
// `steam` powers the one-click "Play" launch (`steam://run/<appid>//<args>`):
// Source games take `+connect host:port`, Factorio `--mp-connect host:port`;
// Minecraft (Java) has no launch-and-connect scheme, so no `steam` entry
// (copy-only in the panel). Array order drives the panel's tab order + Quick
// Connect list (Minecraft kept last for a cleaner layout).
//
// Per-entry fields (full reference + rationale → docs/backend.md):
//   id            public API key — the only identifier crossing the boundary
//   name          panel display name
//   backend       transport client ('docker' for all; skipped if unconfigured)
//   container     Docker container name = the locator (never from a request)
//   connector     connector-class key in connectors/index.js (≈ id)
//   port          public (forwarded) game port → join string + launch URL
//   connect       join-string style: 'cs' → `connect host:port`; 'address' → `host:port`
//   identityKind  player-id namespace ('steam'|'minecraft'|'factorio');
//                 SteamID64 spans the three Source games (whitelist seed)
//   collect       host session-collector mode: 'log' tails docker logs,
//                 'rcon' polls `status` (absent → not session-tracked)
//   rconEnvKey    (collect 'rcon') env var holding that game's RCON password
//   rconPort      (optional) overrides the image's default RCON port
//   steam         (optional) { appid, arg } for the launch URL above
export const SERVERS = [
  { id: 'counterstrike', name: 'Counter-Strike',     backend: 'docker', container: 'counterstrike', connector: 'counterstrike', port: 27015, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'CS2_RCON_PASSWORD',      steam: { appid: 730,    arg: '+connect' } },
  { id: 'factorio',      name: 'Factorio',           backend: 'docker', container: 'factorio', connector: 'factorio',      port: 34197, connect: 'address', identityKind: 'factorio',  collect: 'log', rconPort: 27015,                      steam: { appid: 427520, arg: '--mp-connect' } },
  { id: 'gmod',          name: 'TTT',                backend: 'docker', container: 'gmod', connector: 'gmod',          port: 27066, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'GMOD_RCON_PASSWORD',     steam: { appid: 4000,   arg: '+connect' } },
  { id: 'prophunt',      name: 'Prop Hunt',          backend: 'docker', container: 'prophunt', connector: 'prophunt',      port: 27067, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'PROPHUNT_RCON_PASSWORD', steam: { appid: 4000,   arg: '+connect' } },
  { id: 'minecraft',     name: 'Minecraft',          backend: 'docker', container: 'minecraft', connector: 'minecraft',     port: 25565, connect: 'address', identityKind: 'minecraft', collect: 'log' },
  // RLCraft (modded Minecraft, Forge 1.12.2) — its own connector spec (1.12.2
  // gamerules/cvars differ from vanilla). Shares the Mojang-UUID identity
  // namespace; log-collected like vanilla MC. No rconPort → spec portFallback
  // 25575. No `steam` (Java MC has no launch URL → copy-only join string).
  { id: 'rlcraft',       name: 'RLCraft',            backend: 'docker', container: 'rlcraft', connector: 'rlcraft',       port: 25566, connect: 'address', identityKind: 'minecraft', collect: 'log' },
];

function quoteConsole(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render the copy-pastable join string for a server given the public host. */
export function connectString(server, host, password = '') {
  if (!host || !server.port) return null;
  const addr = `${host}:${server.port}`;
  if (server.connect === 'cs') {
    return password ? `password ${quoteConsole(password)}; connect ${addr}` : `connect ${addr}`;
  }
  if (server.id === 'factorio' && password) return `${addr} (password: ${password})`;
  return addr;
}

/**
 * Build the one-click Steam launch URL (open the game + connect to this server),
 * or null when the game has no registered launch scheme. The args are
 * URL-encoded so spaces survive the `steam://run/<appid>//<args>` form.
 */
export function launchUrl(server, host, password = '') {
  if (!host || !server.port || !server.steam) return null;
  const addr = `${host}:${server.port}`;
  let args = `${server.steam.arg} ${addr}`;
  if (password) {
    if (server.connect === 'cs') args = `+password ${quoteConsole(password)} ${args}`;
    else if (server.id === 'factorio') args = `${args} --password ${password}`;
  }
  return `steam://run/${server.steam.appid}//${encodeURIComponent(args)}`;
}

const BY_ID = new Map(SERVERS.map((s) => [s.id, s]));

/** @returns the registry entry for `id`, or undefined if unknown. */
export function getServer(id) {
  return BY_ID.get(id);
}

export function listServers() {
  return SERVERS;
}
