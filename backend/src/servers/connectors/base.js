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
   * @param {import('../store.js').createServerStore|null} [store]
   *        persisted catalog/config store; null when no DB is wired (e.g. tests).
   */
  constructor(server, client, store = null) {
    this.server = server;
    this.client = client;
    this.store = store;
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
  // Subclasses override to start/stop/restart the game server process in the VM.
  startGame()   { const e = new Error('startGame not implemented');   e.code = 'BAD_ACTION'; throw e; }
  stopGame()    { const e = new Error('stopGame not implemented');    e.code = 'BAD_ACTION'; throw e; }
  restartGame() { const e = new Error('restartGame not implemented'); e.code = 'BAD_ACTION'; throw e; }

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
  //
  // `awaitAgentMs` (default 0): the QEMU guest agent only comes up ~20-40s after
  // a VM powers on, so an exec issued right after a Start VM fails with "QEMU
  // guest agent is not running". When set, we retry ONLY that specific error for
  // up to this long before giving up — letting actions like Start Hosting wait
  // out a freshly-booted VM instead of erroring. Passive reads leave it at 0.
  async runCommand(command, { input, timeoutMs = 120_000, pollMs = 1000, awaitAgentMs = 0 } = {}) {
    const { pid } = await this.#execAwaitingAgent(command, input, awaitAgentMs, pollMs);
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

  // Kick off agentExec, retrying ONLY the "guest agent is not running" upstream
  // error for up to `awaitAgentMs` (the post-boot window). Any other error, or
  // exhausting the window, rethrows so callers still see real failures.
  async #execAwaitingAgent(command, input, awaitAgentMs, pollMs) {
    const deadline = Date.now() + awaitAgentMs;
    for (;;) {
      try {
        return await this.client.agentExec(this.vmid, { command, input });
      } catch (err) {
        const agentDown = /guest agent is not running/i.test(err?.message ?? '');
        if (agentDown && Date.now() < deadline) {
          await sleep(pollMs);
          continue;
        }
        throw err;
      }
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

  // ── persisted catalog + config library (Phase 2; Counter-Strike only today) ──
  // DB-backed lists a connector may expose via this.store. Default: unsupported,
  // so non-CS servers reject these cleanly instead of NPE-ing on a null store.
  listMaps()     { throw unsupportedCapability('a workshop map catalog'); }
  addMap()       { throw unsupportedCapability('a workshop map catalog'); }
  renameMap()    { throw unsupportedCapability('a workshop map catalog'); }
  deleteMap()    { throw unsupportedCapability('a workshop map catalog'); }
  listConfigs()  { throw unsupportedCapability('a config library'); }
  getConfig()    { throw unsupportedCapability('a config library'); }
  createConfig() { throw unsupportedCapability('a config library'); }
  updateConfig() { throw unsupportedCapability('a config library'); }
  deleteConfig() { throw unsupportedCapability('a config library'); }

  // ── offsite backups (Phase 4; Factorio + Minecraft via rclone → R2) ──────────
  // Point-in-time archives pushed off the VM. Default: unsupported (e.g. CS).
  listBackups()   { throw unsupportedCapability('backups'); }
  createBackup()  { throw unsupportedCapability('backups'); }
  restoreBackup() { throw unsupportedCapability('backups'); }
  deleteBackup()  { throw unsupportedCapability('backups'); }

  // ── live commands (Phase 3) ─────────────────────────────────────────────────
  // Runtime control of a running server. getLive() advertises whether live
  // control is available + the curated action buttons; sendCommand/runLiveAction
  // execute. Default: unavailable.
  async getLive() { return { available: false, reason: 'no live control for this server' }; }
  async sendCommand() { const e = new Error('live commands are not supported for this server'); e.code = 'NO_RCON'; throw e; }
  async runLiveAction() { const e = new Error('live actions are not supported for this server'); e.code = 'NO_RCON'; throw e; }
}

function unsupportedCapability(what) {
  const err = new Error(`this server has no ${what}`);
  err.code = 'NOT_SUPPORTED';
  return err;
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
