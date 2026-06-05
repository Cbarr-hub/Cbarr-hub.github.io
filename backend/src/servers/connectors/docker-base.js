// DockerBaseConnector — BaseConnector for servers whose backend is a container.
//
// The ONLY structural difference from a VM connector is the locator: a
// container name instead of a VMID. Because DockerClient duck-types the transport
// surface BaseConnector consumes, everything else (status, power, exec, config
// read/write, profiles) is inherited unchanged — `this.client` is just a
// DockerClient and `this.vmid` resolves to the container name.
//
// This class is usable directly for a well-imaged server (status + power), and is
// the parent for game-specific Docker connectors (e.g. the Minecraft one).

import { BaseConnector } from './base.js';

export class DockerBaseConnector extends BaseConnector {
  // The registry locator for a docker entry is `container`, surfaced through the
  // same `vmid` getter the transport methods read.
  get vmid() { return this.server.container; }

  // The container IS the game: if it's running, the server is hosting. (The
  // base (VM) default distinguishes "VM up" from "game process up"; for a
  // single-purpose game container there's no such gap.)
  async gameRunning() { return true; }
}
