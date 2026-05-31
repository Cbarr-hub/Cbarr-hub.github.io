// Minecraft connector — plain (non-LinuxGSM) server.
//
// Verified layout (VM 102, 192.168.1.68) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/MinecraftServer   (owned by user `miles`)
//   launch      : `./start.sh` inside a tmux session named `minecraft`
//   updates     : manual server.jar swap — no automated updater
//
// So this connector exposes config editing only; `update()` is intentionally
// unsupported (the route returns 501).

import { BaseConnector } from './base.js';

const DIR = '/home/miles/MinecraftServer';

export class MinecraftConnector extends BaseConnector {
  configFiles = {
    'server.properties': `${DIR}/server.properties`,
    'whitelist.json': `${DIR}/whitelist.json`,
    'ops.json': `${DIR}/ops.json`,
    'banned-players.json': `${DIR}/banned-players.json`,
    'banned-ips.json': `${DIR}/banned-ips.json`,
  };

  async update() {
    const err = new Error(
      'Minecraft has no automated updater — replace server.jar in ' +
      `${DIR} manually, then restart.`
    );
    err.code = 'NO_UPDATE_RECIPE';
    throw err;
  }
}
