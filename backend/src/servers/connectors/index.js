// Builds connector instances from the registry + the per-backend transport
// clients, and exposes a lookup. The per-backend class maps below are the only
// place that wire a game id to its custom connector implementation.

import { listServers } from '../registry.js';
import { DockerBaseConnector } from './docker-base.js';
import { DockerMinecraftConnector } from './docker/minecraft.js';
import { DockerFactorioConnector } from './docker/factorio.js';
import { DockerCounterStrikeConnector } from './docker/counterstrike.js';
import { DockerGmodConnector } from './docker/gmod.js';
import { DockerPropHuntConnector } from './docker/prophunt.js';

// connector key -> class, per backend. A backend's fallback (used when a server
// names no custom connector) is its generic base connector. Docker is the only
// backend today; the per-backend shape is kept cheap so another could be added.
const CONNECTOR_CLASSES = {
  docker: {
    minecraft: DockerMinecraftConnector,
    factorio: DockerFactorioConnector,
    counterstrike: DockerCounterStrikeConnector,
    gmod: DockerGmodConnector,
    prophunt: DockerPropHuntConnector,
  },
};

const FALLBACK = { docker: DockerBaseConnector };

/**
 * @param {{ docker?: object|null }} clients
 *        the transport client per backend; a backend with no client is skipped.
 * @param {import('../store.js').createServerStore|null} [store]
 *        shared persistence store (workshop catalog + config library), or null.
 * @returns {Map<string, DockerBaseConnector>} keyed by server id
 */
export function buildConnectors(clients = {}, store = null) {
  const map = new Map();
  for (const server of listServers()) {
    const backend = server.backend ?? 'docker';
    const client = clients[backend];
    if (!client) continue; // this backend isn't configured on this host
    const Cls = CONNECTOR_CLASSES[backend]?.[server.connector] ?? FALLBACK[backend] ?? DockerBaseConnector;
    map.set(server.id, new Cls(server, client, store));
  }
  return map;
}
