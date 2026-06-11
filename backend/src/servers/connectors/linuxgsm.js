// Shared connector base for LinuxGSM-managed game servers (the GMOD family).
//
// LinuxGSM installs each game as an instance with a control script (e.g.
// /data/gmodserver); subclasses declare the instance specifics (dir, script) +
// their config-file whitelist. The game lifecycle itself is container power
// (the dockerize mixin), so no runtime LinuxGSM machinery lives here anymore.

import { BaseConnector } from './base.js';

export class LinuxGsmConnector extends BaseConnector {
  // Subclasses set these:
  gsmUser = 'miles';   // OS user that owns the install (in-container)
  gsmDir = '';         // e.g. /data
  gsmScript = '';      // e.g. gmodserver
}
