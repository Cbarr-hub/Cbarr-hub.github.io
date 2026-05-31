// BaseConnector: the generic capabilities every game server shares.
//
// A connector wraps one registry entry + the shared ProxmoxClient and exposes a
// game-agnostic interface: status, power actions, guarded in-VM command
// execution, and whitelisted config read/write. Game-specific connectors extend
// this class to declare their config-file whitelist and `update()` recipe — all
// game knowledge lives in the subclass, never in the service or route layers.

export class BaseConnector {
  /**
   * @param {object} server  registry entry { id, name, vmid }
   * @param {import('../../proxmox/client.js').ProxmoxClient} client
   */
  constructor(server, client) {
    this.server = server;
    this.client = client;
  }

  get vmid() { return this.server.vmid; }

  // Subclasses override: the only guest paths this connector may read/write.
  // Map of logical file name -> absolute path inside the VM.
  configFiles = {};

  // ── status ─────────────────────────────────────────────────────────────────
  async status() {
    const data = await this.client.statusCurrent(this.vmid);
    const base = normalizeStatus(data);
    if (base.status === 'running') {
      try {
        base.gameStatus = (await this.gameRunning()) ? 'hosting' : 'idle';
      } catch {
        base.gameStatus = 'unknown';
      }
    } else {
      base.gameStatus = 'down';
    }
    return base;
  }

  // Subclasses override: return true when the game server process is running.
  async gameRunning() { return false; }

  // ── power (VM-level) ─────────────────────────────────────────────────────────
  start()    { return this.client.start(this.vmid); }
  shutdown() { return this.client.shutdown(this.vmid); } // graceful ACPI
  reboot()   { return this.client.reboot(this.vmid); }   // graceful reboot
  stop()     { return this.client.stop(this.vmid); }     // hard power-off (force)

  // ── game process (in-VM) ─────────────────────────────────────────────────────
  // Subclasses override to start/stop the game server process inside the VM.
  startGame() { const e = new Error('startGame not implemented'); e.code = 'BAD_ACTION'; throw e; }
  stopGame()  { const e = new Error('stopGame not implemented');  e.code = 'BAD_ACTION'; throw e; }

  // ── in-VM command execution (Phase 2) ──────────────────────────────────────
  // Run a /bin/bash login-shell command line inside the guest. The QEMU guest
  // agent executes as ROOT; pass `asUser` to drop privileges with runuser
  // (LinuxGSM and most game servers refuse to run as root).
  runShell(shellCommand, { asUser, ...opts } = {}) {
    const command = asUser
      ? ['/usr/sbin/runuser', '-u', asUser, '--', '/bin/bash', '-lc', shellCommand]
      : ['/bin/bash', '-lc', shellCommand];
    return this.runCommand(command, opts);
  }

  // Runs a command via the guest agent and polls until it exits (or times out).
  // `command` is an argv array, e.g. ['/bin/systemctl', 'restart', 'factorio'].
  async runCommand(command, { input, timeoutMs = 120_000, pollMs = 1000 } = {}) {
    const { pid } = await this.client.agentExec(this.vmid, { command, input });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const st = await this.client.agentExecStatus(this.vmid, pid);
      if (st.exited) {
        return {
          exitCode: st.exitcode ?? null,
          signal: st.signal ?? null,
          stdout: st['out-data'] ?? '',
          stderr: st['err-data'] ?? '',
          truncated: Boolean(st['out-truncated'] || st['err-truncated']),
        };
      }
      if (Date.now() > deadline) {
        throw new Error(`command timed out after ${timeoutMs}ms (pid ${pid})`);
      }
      await sleep(pollMs);
    }
  }

  // ── config files (Phase 3) ──────────────────────────────────────────────────
  listConfigFiles() {
    return Object.keys(this.configFiles);
  }

  #resolveConfig(name) {
    const path = this.configFiles[name];
    if (!path) {
      const err = new Error(`unknown config file: ${name}`);
      err.code = 'UNKNOWN_CONFIG';
      throw err;
    }
    return path;
  }

  async readConfig(name) {
    const path = this.#resolveConfig(name);
    const res = await this.client.agentFileRead(this.vmid, path);
    return { name, content: res.content ?? '', truncated: Boolean(res.truncated) };
  }

  async writeConfig(name, content) {
    const path = this.#resolveConfig(name);
    await this.client.agentFileWrite(this.vmid, path, content);
    return { name, ok: true };
  }

  // ── structured "quick settings" ─────────────────────────────────────────────
  // A connector may expose a small set of high-value, validated settings (e.g.
  // map + game mode) as a generic field schema the UI renders without knowing
  // the game. Default: none. Returns { fields: [...], note? }.
  async getSettings() {
    return { fields: [] };
  }

  async setSettings() {
    const err = new Error('this server has no quick settings');
    err.code = 'NO_SETTINGS';
    throw err;
  }

  // ── update recipe (Phase 3) ─────────────────────────────────────────────────
  // Default: no-op that reports the game has no automated updater. Subclasses
  // override with a real recipe (usually one or more runCommand calls).
  async update() {
    const err = new Error(`no update recipe defined for ${this.server.id}`);
    err.code = 'NO_UPDATE_RECIPE';
    throw err;
  }
}

// Map Proxmox's qemu status payload to our normalized shape.
export function normalizeStatus(data) {
  const qmpStatus = data?.status ?? 'unknown'; // 'running' | 'stopped'
  return {
    status: qmpStatus === 'running' ? 'running' : qmpStatus === 'stopped' ? 'stopped' : 'unknown',
    uptime: data?.uptime ?? 0,             // seconds (0 when stopped)
    cpu: data?.cpu ?? null,                // fraction 0..1
    maxmem: data?.maxmem ?? null,          // bytes
    mem: data?.mem ?? null,                // bytes
    raw: qmpStatus,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
