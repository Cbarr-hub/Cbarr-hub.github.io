// Counter-Strike 2 connector — LinuxGSM instance `cs2server`.
//
// Verified layout (VM 100, 192.168.1.75) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/csserver   (owned by user `miles`)
//   control     : ./cs2server start|stop|restart|update   (run as miles)

import { LinuxGsmConnector } from './linuxgsm.js';

const DIR = '/home/miles/csserver';

export class CounterStrikeConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'cs2server';

  configFiles = {
    // Game server config (hostname, rcon, sv_*, etc.)
    'server.cfg': `${DIR}/serverfiles/game/csgo/cfg/cs2server.cfg`,
    // LinuxGSM instance config (start params, ports, branch)
    'lgsm.cfg': `${DIR}/lgsm/config-lgsm/cs2server/cs2server.cfg`,
    'lgsm-common.cfg': `${DIR}/lgsm/config-lgsm/cs2server/common.cfg`,
  };
}
