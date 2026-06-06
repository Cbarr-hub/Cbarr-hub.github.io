// Single source of truth mapping a logical game-server id to its container.
//
// The locator (container name) MUST only ever come from this table — never from
// a request parameter. The HTTP layer accepts an opaque `id` ("factorio"), looks
// it up here, and the locator never crosses the API boundary. That guarantees the
// control panel can only ever touch these five servers, no matter what a client
// sends.
//
// `port` is the game's public (port-forwarded) port; `connect` picks how the
// join string is rendered — 'cs' yields the in-console `connect host:port`
// command, 'address' yields a plain `host:port`. These + the public host
// (env PUBLIC_HOST) are the single source of truth for the join strings the
// panel shows. Update here if a port or forward changes.
//
// GMOD shares the Source `connect` join style with CS but uses port 27066 —
// CS already reserves the 27000-27039 external forward range on the router.

// `steam` (optional) powers the one-click "Play" launch button: a
// `steam://run/<appid>//<args>` URL that opens the game AND connects. Source
// games take `+connect host:port`; Factorio takes `--mp-connect host:port`.
// Minecraft (Java) has no launch-and-connect URL scheme, so it has no `steam`
// entry and the panel shows copy-only for it.
// Array order drives the panel's tab order + Quick Connect list (Minecraft is
// kept last for a cleaner layout). VMIDs stay bound to ids regardless of order.
// `backend` selects the transport; all entries are 'docker' (locator = the
// `container` name) and it defaults to 'docker'. A server whose backend client
// isn't configured is simply skipped, so a host can run a subset. (An optional
// `rconPort` overrides a game image's default RCON port, e.g. itzg's 25575.)
// `identityKind` is the native id namespace each game exposes — the key that lets
// one player record span games. SteamID64 is shared across the three Source games
// (the cross-game whitelist seed); Minecraft uses the Mojang UUID; Factorio has
// only an account name. Consumed by the session catalog seed + the host collector.
//
// `collect` + `rconEnvKey` drive the host session collector (tools/
// gt-session-tracker.mjs) so it has no game list of its own to drift from this one:
//   • collect 'log'  → tail `docker logs` and parse join/leave (Minecraft, Factorio).
//   • collect 'rcon' → poll RCON `status`; `rconEnvKey` names the env var holding
//     that game's RCON password (the Source games — GMOD/Prop Hunt/CS2).
// Games with no `collect` are not session-tracked.
export const SERVERS = [
  { id: 'counterstrike', name: 'Counter-Strike',     backend: 'docker', container: 'counterstrike', connector: 'counterstrike', port: 27015, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'CS2_RCON_PASSWORD',      steam: { appid: 730,    arg: '+connect' } },
  { id: 'factorio',      name: 'Factorio',           backend: 'docker', container: 'factorio', connector: 'factorio',      port: 34197, connect: 'address', identityKind: 'factorio',  collect: 'log',                                       steam: { appid: 427520, arg: '--mp-connect' } },
  { id: 'gmod',          name: 'TTT',                backend: 'docker', container: 'gmod', connector: 'gmod',          port: 27066, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'GMOD_RCON_PASSWORD',     steam: { appid: 4000,   arg: '+connect' } },
  { id: 'prophunt',      name: 'Prop Hunt',          backend: 'docker', container: 'prophunt', connector: 'prophunt',      port: 27067, connect: 'cs',      identityKind: 'steam',     collect: 'rcon', rconEnvKey: 'PROPHUNT_RCON_PASSWORD', steam: { appid: 4000,   arg: '+connect' } },
  { id: 'minecraft',     name: 'Minecraft',          backend: 'docker', container: 'minecraft', connector: 'minecraft',     port: 25565, connect: 'address', identityKind: 'minecraft', collect: 'log' },
];

/** Render the copy-pastable join string for a server given the public host. */
export function connectString(server, host) {
  if (!host || !server.port) return null;
  const addr = `${host}:${server.port}`;
  return server.connect === 'cs' ? `connect ${addr}` : addr;
}

/**
 * Build the one-click Steam launch URL (open the game + connect to this server),
 * or null when the game has no registered launch scheme. The args are
 * URL-encoded so spaces survive the `steam://run/<appid>//<args>` form.
 */
export function launchUrl(server, host) {
  if (!host || !server.port || !server.steam) return null;
  const args = `${server.steam.arg} ${host}:${server.port}`;
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
