// Factorio connector — LinuxGSM instance `fctrserver`.
//
// Verified layout (VM 101, 192.168.1.74) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/fctrserver   (owned by user `miles`)
//   control     : ./fctrserver start|stop|restart|update   (run as miles)

import { LinuxGsmConnector } from './linuxgsm.js';

const DIR = '/home/miles/fctrserver';

export class FactorioConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'fctrserver';

  configFiles = {
    // Factorio headless server settings (name, description, visibility, admins…)
    'server-settings.json': `${DIR}/serverfiles/data/server-settings.json`,
    // LinuxGSM instance config (start params, save name, ports)
    'lgsm.cfg': `${DIR}/lgsm/config-lgsm/fctrserver/fctrserver.cfg`,
    'lgsm-common.cfg': `${DIR}/lgsm/config-lgsm/fctrserver/common.cfg`,
  };
}
