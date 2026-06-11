// Dockerized GMOD-family connector — LinuxGSM `gmodserver` running in a container.
//
// The GMOD/Prop Hunt connectors already drive everything through fileRead/Write
// + runShell + this.paths + this.vmid, all duck-typed by DockerClient — so the hard,
// validated logic (gmad map-sync, TTT/PH profiles, mapcycle, the workshop-at-boot
// boot-map guard, getSettings) is INHERITED unchanged. `dockerizeGmod(Base)` layers
// on only the handful of Docker-specific differences, so it works on top of either
// GmodConnector (TTT) or PropHuntConnector:
//   - the locator is the container name (not a vmid);
//   - DockerClient.agentExec already runs as the container's game user, so the VM's
//     `runuser -u <user>` indirection — and Prop Hunt's chown-back — are dropped;
//   - the container IS the game: status running == hosting, and the game lifecycle
//     maps to container power (a restart is also what remounts the Workshop
//     collection, preserving the "Apply = apply + restart" behavior);
//   - live RCON is TCP from the app to the game port (no python in the container),
//     with the password from env (the image entrypoint seeds the same value into the
//     game cfg) — the docker/counterstrike.js pattern.

import { rconExchange } from '../../rcon-tcp.js';
import { GmodConnector } from '../gmod.js';

// The in-container LinuxGSM instance root: the image installs the gmodserver instance
// here and mounts a named volume at it. Both the TTT and Prop Hunt containers use this
// same layout (only env + the volume differ); `paths` in GmodConnector derives the rest.
const DATA_DIR = '/data';

export function dockerizeGmod(Base) {
  return class extends Base {
    gsmDir = DATA_DIR;

    // Registry locator for a docker entry is the container name.
    get vmid() { return this.server.container; }

    // agentExec already runs as the container's game user, so drop the VM's
    // `runuser -u <user>` wrapping (and, for Prop Hunt, the chown-back below).
    runShell(shellCommand, opts = {}) {
      const { asUser, ...rest } = opts;
      return this.runCommand(['/bin/bash', '-lc', shellCommand], rest);
    }

    // Update the game client via LinuxGSM (SteamCMD under the hood), in-container.
    // `./gmodserver update` refreshes serverfiles; the panel then restarts the
    // container to run the new build (also remounts the Workshop collection).
    async update() {
      const res = await this.runShell(`${this.gsmDir}/${this.gsmScript} update`, { timeoutMs: 1_800_000 });
      return {
        ok: res.exitCode === 0,
        note: 'Game files updated via LinuxGSM — restart the server to run the new build.',
        steps: [{ name: `${this.gsmScript} update`, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }],
      };
    }

    // Live RCON over TCP to the container's game port. The password comes from env
    // (`rconEnvKey`, set per game below) — the same value the image entrypoint wrote
    // into the game cfg's rcon_password. Overrides GmodConnector.runRcon so all the
    // inherited live-action command mapping (sendCommand / runLiveAction) flows here.
    async rconPassword() { return process.env[this.rconEnvKey] ?? ''; }
    async runRcon(command) {
      const password = await this.rconPassword();
      if (!password) { const e = new Error('RCON password is not set'); e.code = 'NO_RCON'; throw e; }
      return { output: await rconExchange({ host: this.server.container, port: this.server.port, password, command }) };
    }
  };
}

export class DockerGmodConnector extends dockerizeGmod(GmodConnector) {
  rconEnvKey = 'GMOD_RCON_PASSWORD';
}
