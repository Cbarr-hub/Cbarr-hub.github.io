// BaseConnector: the generic capabilities every game server shares.
//
// A connector wraps one registry entry + the shared transport client and exposes a
// game-agnostic interface: status, power actions, guarded in-VM command
// execution, and whitelisted config read/write. Game-specific connectors extend
// this class to declare their config-file whitelist and `update()` recipe — all
// game knowledge lives in the subclass, never in the service or route layers.

import { badSetting, notFound, notSupported, duplicateError } from '../errors.js';

export class BaseConnector {
  /**
   * @param {object} server  registry entry { id, name, container }
   * @param {import('../../docker/client.js').DockerClient} client
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
  // Map of logical file name -> absolute path inside the VM. A getter (not a
  // field) so subclasses can override it with a computed getter (e.g. paths
  // derived from this.gsmDir) without an instance field shadowing them.
  get configFiles() { return {}; }

  // ── status ─────────────────────────────────────────────────────────────────
  async status(options = {}) {
    const data = await this.client.statusCurrent(this.vmid, options);
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
    const { pid } = await this.#execAwaitingAgent(command, input, awaitAgentMs, pollMs, timeoutMs);
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
  async #execAwaitingAgent(command, input, awaitAgentMs, pollMs, timeoutMs) {
    const deadline = Date.now() + awaitAgentMs;
    for (;;) {
      try {
        return await this.client.agentExec(this.vmid, { command, input, timeoutMs });
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
  listMaps()     { throw notSupported('a workshop map catalog'); }
  syncMaps()     { throw notSupported('workshop map sync'); }
  addMap()       { throw notSupported('a workshop map catalog'); }
  importCollection() { throw notSupported('workshop collection import'); }
  renameMap()    { throw notSupported('a workshop map catalog'); }
  deleteMap()    { throw notSupported('a workshop map catalog'); }
  listConfigs()  { throw notSupported('a config library'); }
  getConfig()    { throw notSupported('a config library'); }
  createConfig() { throw notSupported('a config library'); }
  updateConfig() { throw notSupported('a config library'); }
  deleteConfig() { throw notSupported('a config library'); }

  // ── startup-config profiles ──────────────────────────────────────────────────
  // A profile is the full, named, structured startup config a server boots as.
  // The base owns persistence + lifecycle (list/get/create/update/delete/apply/
  // capture); subclasses supply the game semantics through these hooks:
  //   profileSchema()            → editor shape { groups:[{ key, title, fields }] }
  //   defaultProfileSettings()   → seed doc for the first "Default" profile (or null)
  //   validateProfileSettings(s) → normalize/validate a doc before persist/apply
  //   applyProfileSettings(s,id) → materialize a doc onto the VM's config files
  //   captureProfileSettings()   → read the VM's current files back into a doc
  async profileSchema()            { return { groups: [] }; }
  defaultProfileSettings()         { return null; }
  validateProfileSettings(s)       { return s ?? {}; }
  async applyProfileSettings()     { throw notSupported('profiles'); }
  async captureProfileSettings()   { throw notSupported('profiles'); }

  requireStore() {
    if (!this.store) {
      const e = new Error('persistence store is not configured');
      e.code = 'NOT_CONFIGURED';
      throw e;
    }
    return this.store;
  }

  // List profiles (+ the active profile id). Seeds a "Default" the first time so
  // the list is never empty — only when the connector defines defaults.
  listProfiles() {
    const store = this.requireStore();
    if (store.countProfiles(this.server.id) === 0) {
      const def = this.defaultProfileSettings();
      if (def) {
        try { store.createProfile(this.server.id, { name: 'Default', settings: def }); }
        catch { /* concurrent seed — ignore the UNIQUE collision */ }
      }
    }
    return {
      profiles: store.listProfiles(this.server.id),
      activeId: store.getActiveProfileId(this.server.id),
    };
  }

  getProfile(id) {
    const p = this.requireStore().getProfile(this.server.id, id);
    if (!p) throw notFound('profile not found');
    return p;
  }

  createProfile({ name, settings } = {}) {
    const store = this.requireStore();
    const nm = validProfileName(name);
    const st = this.validateProfileSettings(settings ?? this.defaultProfileSettings() ?? {});
    try { return store.createProfile(this.server.id, { name: nm, settings: st }); }
    catch (e) { throw duplicateError(e, nm, 'profile'); }
  }

  updateProfile(id, { name, settings } = {}) {
    const store = this.requireStore();
    const patch = {};
    if (name !== undefined) patch.name = validProfileName(name);
    if (settings !== undefined) patch.settings = this.validateProfileSettings(settings);
    let updated;
    try { updated = store.updateProfile(this.server.id, id, patch); }
    catch (e) { throw duplicateError(e, patch.name, 'profile'); }
    if (!updated) throw notFound('profile not found');
    return updated;
  }

  deleteProfile(id) {
    if (!this.requireStore().deleteProfile(this.server.id, id)) throw notFound('profile not found');
    return { ok: true };
  }

  // Write a saved profile onto the box as the active startup config.
  async applyProfile(id) {
    const store = this.requireStore();
    const p = store.getProfile(this.server.id, id);
    if (!p) throw notFound('profile not found');
    await this.applyProfileSettings(p.settings, id);
    store.setActiveProfile(this.server.id, id);
    return { ok: true, id, name: p.name };
  }

  // Snapshot the box's current startup files into a new named profile.
  async captureProfile(name) {
    const store = this.requireStore();
    const nm = validProfileName(name);
    const settings = await this.captureProfileSettings();
    try { return store.createProfile(this.server.id, { name: nm, settings }); }
    catch (e) { throw duplicateError(e, nm, 'profile'); }
  }

  // ── live commands (Phase 3) ─────────────────────────────────────────────────
  // Runtime control of a running server. getLive() advertises whether live
  // control is available + the curated action buttons; sendCommand/runLiveAction
  // execute. Default: unavailable.
  async getLive() { return { available: false, reason: 'no live control for this server' }; }
  async sendCommand() { const e = new Error('live commands are not supported for this server'); e.code = 'NO_RCON'; throw e; }
  async runLiveAction() { const e = new Error('live actions are not supported for this server'); e.code = 'NO_RCON'; throw e; }
}

function validProfileName(name) {
  const nm = String(name ?? '').trim();
  if (!/^[A-Za-z0-9 _-]{1,48}$/.test(nm)) {
    throw badSetting('profile name must be 1–48 chars: letters, digits, spaces, _ or -');
  }
  return nm;
}

// Map the qemu/container status payload to our normalized shape.
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
