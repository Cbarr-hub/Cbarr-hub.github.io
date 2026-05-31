// Single source of truth mapping a logical game-server id to its Proxmox VMID.
//
// VMIDs MUST only ever come from this table — never from a request parameter.
// The HTTP layer accepts an opaque `id` ("factorio"), looks it up here, and the
// VMID never crosses the API boundary. That guarantees the control panel can
// only ever touch these three VMs, no matter what a client sends.
//
// VMIDs are from INFRA.md: CS=100, Factorio=101, Minecraft=102.
//
// `port` is the game's public (port-forwarded) port; `connect` picks how the
// join string is rendered — 'cs' yields the in-console `connect host:port`
// command, 'address' yields a plain `host:port`. These + the public host
// (env PUBLIC_HOST) are the single source of truth for the join strings the
// panel shows. Update here if a port or forward changes.

export const SERVERS = [
  { id: 'counterstrike', name: 'Counter-Strike', vmid: 100, connector: 'counterstrike', port: 27015, connect: 'cs' },
  { id: 'factorio',      name: 'Factorio',       vmid: 101, connector: 'factorio',      port: 34197, connect: 'address' },
  { id: 'minecraft',     name: 'Minecraft',      vmid: 102, connector: 'minecraft',     port: 25565, connect: 'address' },
];

/** Render the copy-pastable join string for a server given the public host. */
export function connectString(server, host) {
  if (!host || !server.port) return null;
  const addr = `${host}:${server.port}`;
  return server.connect === 'cs' ? `connect ${addr}` : addr;
}

const BY_ID = new Map(SERVERS.map((s) => [s.id, s]));

/** @returns the registry entry for `id`, or undefined if unknown. */
export function getServer(id) {
  return BY_ID.get(id);
}

export function listServers() {
  return SERVERS;
}
