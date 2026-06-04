// Builds connector instances from the registry + the per-backend transport
// clients, and exposes a lookup. The per-backend class maps below are the only
// place that wire a game id to its custom connector implementation.

import { listServers } from '../registry.js';
import { BaseConnector } from './base.js';
import { DockerBaseConnector } from './docker-base.js';
import { FactorioConnector } from './factorio.js';
import { MinecraftConnector } from './minecraft.js';
import { CounterStrikeConnector } from './counterstrike.js';
import { GmodConnector } from './gmod.js';
import { PropHuntConnector } from './prophunt.js';
import { DockerMinecraftConnector } from './docker/minecraft.js';
import { DockerFactorioConnector } from './docker/factorio.js';
import { DockerCounterStrikeConnector } from './docker/counterstrike.js';

// connector key -> class, per backend. A backend's fallback (used when a server
// names no custom connector) is its generic base connector.
const CONNECTOR_CLASSES = {
  proxmox: {
    factorio: FactorioConnector,
    minecraft: MinecraftConnector,
    counterstrike: CounterStrikeConnector,
    gmod: GmodConnector,
    prophunt: PropHuntConnector,
  },
  docker: {
    minecraft: DockerMinecraftConnector,
    factorio: DockerFactorioConnector,
    counterstrike: DockerCounterStrikeConnector,
  },
};

const FALLBACK = { proxmox: BaseConnector, docker: DockerBaseConnector };

/**
 * @param {{ proxmox?: object|null, docker?: object|null }} clients
 *        the transport client per backend; a backend with no client is skipped.
 * @param {import('../store.js').createServerStore|null} [store]
 *        shared persistence store (workshop catalog + config library), or null.
 * @returns {Map<string, BaseConnector>} keyed by server id
 */
export function buildConnectors(clients = {}, store = null) {
  const map = new Map();
  for (const server of listServers()) {
    const backend = server.backend ?? 'proxmox';
    const client = clients[backend];
    if (!client) continue; // this backend isn't configured on this host
    const Cls = CONNECTOR_CLASSES[backend]?.[server.connector] ?? FALLBACK[backend] ?? BaseConnector;
    map.set(server.id, new Cls(server, client, store));
  }
  return map;
}
