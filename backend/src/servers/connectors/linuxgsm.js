// Shared connector for LinuxGSM-managed game servers (Counter-Strike, Factorio).
//
// LinuxGSM installs each game under a normal user's home as an instance with a
// control script (e.g. ~/csserver/cs2server). Management is done by running that
// script as the owning user: `./<script> start|stop|restart|update`. Subclasses
// only declare the instance specifics (user, dir, script) + their config-file
// whitelist; all the LinuxGSM mechanics live here.

import { BaseConnector } from './base.js';

export class LinuxGsmConnector extends BaseConnector {
  // Subclasses set these:
  gsmUser = 'miles';   // OS user that owns the install
  gsmDir = '';         // e.g. /home/miles/csserver
  gsmScript = '';      // e.g. cs2server

  #gsm(action, timeoutMs) {
    return this.runShell(`cd ${this.gsmDir} && ./${this.gsmScript} ${action}`, {
      asUser: this.gsmUser,
      timeoutMs,
    });
  }

  // LinuxGSM `update` validates/updates server files via SteamCMD, then we
  // restart the instance so the new build is live.
  async update() {
    const upd = await this.#gsm('update', 600_000);
    const restart = await this.#gsm('restart', 120_000);
    return { steps: [{ name: 'update', ...upd }, { name: 'restart', ...restart }] };
  }
}
