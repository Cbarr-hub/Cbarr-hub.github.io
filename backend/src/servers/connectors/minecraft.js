// Minecraft connector.
//
// ⚠️ The in-VM paths / service name below are NOT documented in INFRA.md — they
// are sensible defaults for a systemd-managed Java server. Verify against the
// actual Minecraft VM (VMID 102) and adjust these constants.

import { BaseConnector } from './base.js';

const SERVICE = 'minecraft';                 // systemd unit name
const SERVER_DIR = '/srv/minecraft';
const PROPERTIES = `${SERVER_DIR}/server.properties`;
const WHITELIST = `${SERVER_DIR}/whitelist.json`;
const OPS = `${SERVER_DIR}/ops.json`;
const UPDATE_SCRIPT = `${SERVER_DIR}/update.sh`; // optional helper that swaps in a new server.jar

export class MinecraftConnector extends BaseConnector {
  configFiles = {
    'server.properties': PROPERTIES,
    'whitelist.json': WHITELIST,
    'ops.json': OPS,
  };

  async update() {
    const upd = await this.runCommand(['/bin/bash', UPDATE_SCRIPT], { timeoutMs: 300_000 });
    const restart = await this.runCommand(['/bin/systemctl', 'restart', SERVICE]);
    return { steps: [{ name: 'update', ...upd }, { name: 'restart', ...restart }] };
  }
}
