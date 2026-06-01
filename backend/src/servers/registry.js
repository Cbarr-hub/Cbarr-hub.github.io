// Single source of truth mapping a logical game-server id to its Proxmox VMID.
//
// VMIDs MUST only ever come from this table — never from a request parameter.
// The HTTP layer accepts an opaque `id` ("factorio"), looks it up here, and the
// VMID never crosses the API boundary. That guarantees the control panel can
// only ever touch these three VMs, no matter what a client sends.
//
// VMIDs are from INFRA.md: CS=100, Factorio=101, Minecraft=102, GMOD/TTT=104.
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
export const SERVERS = [
  { id: 'counterstrike', name: 'Counter-Strike',     vmid: 100, connector: 'counterstrike', port: 27015, connect: 'cs',      steam: { appid: 730,    arg: '+connect' } },
  { id: 'factorio',      name: 'Factorio',           vmid: 101, connector: 'factorio',      port: 34197, connect: 'address', steam: { appid: 427520, arg: '--mp-connect' } },
  { id: 'minecraft',     name: 'Minecraft',          vmid: 102, connector: 'minecraft',     port: 25565, connect: 'address' },
  { id: 'gmod',          name: "Garry's Mod (TTT)",  vmid: 104, connector: 'gmod',          port: 27066, connect: 'cs',      steam: { appid: 4000,   arg: '+connect' } },
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
