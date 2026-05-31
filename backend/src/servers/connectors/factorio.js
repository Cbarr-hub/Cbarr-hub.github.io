// Factorio connector.
//
// ⚠️ The in-VM paths / service name below are NOT documented in INFRA.md — they
// are sensible defaults for a headless Factorio install. Verify against the
// actual Factorio VM (VMID 101) and adjust these constants; everything else in
// the stack is path-agnostic.

import { BaseConnector } from './base.js';

const SERVICE = 'factorio';                         // systemd unit name
const SETTINGS = '/opt/factorio/data/server-settings.json';
const MAP_GEN = '/opt/factorio/data/map-gen-settings.json';
const UPDATE_SCRIPT = '/opt/factorio/update.sh';    // optional helper that pulls the latest headless build

export class FactorioConnector extends BaseConnector {
  configFiles = {
    'server-settings.json': SETTINGS,
    'map-gen-settings.json': MAP_GEN,
  };

  // Run the install's update helper, then restart the service so the new binary
  // is live. Returns the combined command output for display in the UI.
  async update() {
    const upd = await this.runCommand(['/bin/bash', UPDATE_SCRIPT], { timeoutMs: 300_000 });
    const restart = await this.runCommand(['/bin/systemctl', 'restart', SERVICE]);
    return { steps: [{ name: 'update', ...upd }, { name: 'restart', ...restart }] };
  }
}
