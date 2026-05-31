// Single source of truth mapping a logical game-server id to its Proxmox VMID.
//
// VMIDs MUST only ever come from this table — never from a request parameter.
// The HTTP layer accepts an opaque `id` ("factorio"), looks it up here, and the
// VMID never crosses the API boundary. That guarantees the control panel can
// only ever touch these three VMs, no matter what a client sends.
//
// VMIDs are from INFRA.md: CS=100, Factorio=101, Minecraft=102.

export const SERVERS = [
  { id: 'counterstrike', name: 'Counter-Strike', vmid: 100, connector: 'counterstrike' },
  { id: 'factorio',      name: 'Factorio',       vmid: 101, connector: 'factorio' },
  { id: 'minecraft',     name: 'Minecraft',      vmid: 102, connector: 'minecraft' },
];

const BY_ID = new Map(SERVERS.map((s) => [s.id, s]));

/** @returns the registry entry for `id`, or undefined if unknown. */
export function getServer(id) {
  return BY_ID.get(id);
}

export function listServers() {
  return SERVERS;
}
