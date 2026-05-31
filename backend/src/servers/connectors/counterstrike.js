// Counter-Strike connector.
//
// ⚠️ The in-VM paths / service name below are NOT documented in INFRA.md — they
// are sensible defaults for a SteamCMD-managed dedicated server. Verify against
// the actual Counter-Strike VM (VMID 100) and adjust these constants.

import { BaseConnector } from './base.js';

const SERVICE = 'counterstrike';                    // systemd unit name
const CFG_DIR = '/home/steam/cs/game/csgo/cfg';     // CS2 layout; adjust for CS:GO/CS:S
const SERVER_CFG = `${CFG_DIR}/server.cfg`;
const STEAM_APP_ID = '730';                         // CS2 dedicated server appid
const STEAMCMD = '/home/steam/steamcmd/steamcmd.sh';
const INSTALL_DIR = '/home/steam/cs';

export class CounterStrikeConnector extends BaseConnector {
  configFiles = {
    'server.cfg': SERVER_CFG,
  };

  // Update via SteamCMD, then restart the service.
  async update() {
    const upd = await this.runCommand([
      '/bin/bash', STEAMCMD,
      '+force_install_dir', INSTALL_DIR,
      '+login', 'anonymous',
      '+app_update', STEAM_APP_ID, 'validate',
      '+quit',
    ], { timeoutMs: 600_000 });
    const restart = await this.runCommand(['/bin/systemctl', 'restart', SERVICE]);
    return { steps: [{ name: 'update', ...upd }, { name: 'restart', ...restart }] };
  }
}
