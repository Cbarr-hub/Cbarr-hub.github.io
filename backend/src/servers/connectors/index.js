// Builds connector instances from the registry + the per-backend transport
// clients, and exposes a lookup. SPECS is the only place that wires a game id
// to its spec; a registry `connector` key with no spec FAILS LOUDLY (a typo or
// rename must never silently drop a game's custom behavior).

import { listServers } from '../registry.js';
import { buildConnector } from './engine.js';
import { factorioSpec } from './specs/factorio.js';
import { minecraftSpec } from './specs/minecraft.js';
import { counterstrikeSpec } from './specs/counterstrike.js';
import { gmodSpec } from './specs/gmod.js';
import { prophuntSpec } from './specs/prophunt.js';
import { rlcraftSpec } from './specs/rlcraft.js';

const SPECS = {
  factorio: factorioSpec,
  minecraft: minecraftSpec,
  counterstrike: counterstrikeSpec,
  gmod: gmodSpec,
  prophunt: prophuntSpec,
  rlcraft: rlcraftSpec,
};

/**
 * @param {{ docker?: object|null }} clients
 *        the transport client per backend; a backend with no client is skipped.
 * @param {import('../store.js').createServerStore|null} [store]
 *        shared persistence store (workshop catalog + config library), or null.
 * @returns {Map<string, import('./engine.js').GameConnector>} keyed by server id
 */
export function buildConnectors(clients = {}, store = null) {
  const map = new Map();
  for (const server of listServers()) {
    const backend = server.backend ?? 'docker';
    const client = clients[backend];
    if (!client) continue; // this backend isn't configured on this host
    const spec = SPECS[server.connector];
    if (!spec) {
      throw new Error(`no spec for connector '${server.connector}' (server ${server.id})`);
    }
    map.set(server.id, buildConnector(server, spec, client, store));
  }
  return map;
}
