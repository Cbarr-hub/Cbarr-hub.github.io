// Builds connector instances from the registry + a shared ProxmoxClient and
// exposes a lookup. The map from registry `connector` key -> class is the only
// place that wires a game id to its custom connector implementation.

import { listServers } from '../registry.js';
import { BaseConnector } from './base.js';
import { FactorioConnector } from './factorio.js';
import { MinecraftConnector } from './minecraft.js';
import { CounterStrikeConnector } from './counterstrike.js';

const CONNECTOR_CLASSES = {
  factorio: FactorioConnector,
  minecraft: MinecraftConnector,
  counterstrike: CounterStrikeConnector,
};

/**
 * @param {import('../../proxmox/client.js').ProxmoxClient} client
 * @param {import('../store.js').createServerStore|null} [store]
 *        shared persistence store (workshop catalog + config library), or null.
 * @returns {Map<string, BaseConnector>} keyed by server id
 */
export function buildConnectors(client, store = null) {
  const map = new Map();
  for (const server of listServers()) {
    const Cls = CONNECTOR_CLASSES[server.connector] ?? BaseConnector;
    map.set(server.id, new Cls(server, client, store));
  }
  return map;
}
