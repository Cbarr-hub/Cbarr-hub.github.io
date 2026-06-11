// BaseConnector: the generic capabilities every game server shares.
//
// A connector wraps one registry entry + the shared transport client and exposes a
// game-agnostic interface: status, power actions, guarded in-VM command
// execution, and whitelisted config read/write. Game-specific connectors extend
// this class to declare their config-file whitelist and `update()` recipe — all
// game knowledge lives in the subclass, never in the service or route layers.
//
// ── connector lifecycle contract (what a subclass implements) ────────────────
// The base owns the generic, persisted, transport-driven machinery; a subclass
// supplies only the game semantics through these override points. Anything left
// at the base default cleanly reports "not supported" rather than crashing.
//
//   status / power     status() + start/shutdown/reboot/stop are inherited and
//                      transport-driven (the container IS the game: running ==
//                      hosting).
//   config files       override the `configFiles` getter to whitelist the only
//                      guest paths read/writeConfig may touch (logical name → path).
//   quick settings     getSettings/setSettings expose a small validated field set
//                      the UI renders without game knowledge (default: none).
//   update recipe      override update() with the game's updater (default throws
//                      NO_UPDATE_RECIPE).
//   profiles           the base owns persistence + lifecycle (list/get/create/
//                      update/delete/apply/capture + auto-seeded "Default"); a
//                      subclass supplies the semantics via profileSchema /
//                      defaultProfileSettings / validateProfileSettings /
//                      applyProfileSettings / captureProfileSettings.
//   live control       getLive advertises availability + actions/controls;
//                      sendCommand/runLiveAction execute (default: unavailable).
//   catalog/library    listMaps/syncMaps/…/listConfigs (DB-backed, CS only today)
//                      default to notSupported() so a null store never NPEs.

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
  // The container IS the game: running == hosting, anything else == down.
  async status(options = {}) {
    const data = await this.client.statusCurrent(this.vmid, options);
    const base = normalizeStatus(data);
    base.gameStatus = base.status === 'running' ? 'hosting' : 'down';
    return base;
  }

  // ── power ────────────────────────────────────────────────────────────────────
  start()    { return this.client.start(this.vmid); }
  shutdown() { return this.client.shutdown(this.vmid); } // graceful
  reboot()   { return this.client.reboot(this.vmid); }   // graceful reboot
  stop()     { return this.client.stop(this.vmid); }     // hard power-off (force)

  // ── in-container command execution ──────────────────────────────────────────
  // Run a /bin/bash login-shell command line inside the container. Exec already
  // runs as the container's game user, so there is no privilege-drop wrapping.
  // (`asUser` is accepted-and-ignored for legacy callers.)
  runShell(shellCommand, { asUser, ...opts } = {}) {
    return this.runCommand(['/bin/bash', '-lc', shellCommand], opts);
  }

  // Run an argv to completion inside the container. Docker exec is synchronous
  // (create → start → inspect), so this is a single client call.
  // `command` is an argv array, e.g. ['/bin/bash', '-lc', 'ls'].
  runCommand(command, { input, timeoutMs = 120_000 } = {}) {
    return this.client.exec(this.vmid, command, { input, timeoutMs });
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
    const res = await this.client.fileRead(this.vmid, path);
    return { name, content: res.content ?? '', truncated: Boolean(res.truncated) };
  }

  async writeConfig(name, content) {
    const path = this.#resolveConfig(name);
    await this.client.fileWrite(this.vmid, path, content);
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

// Map the container status payload to our normalized shape.
export function normalizeStatus(data) {
  const qmpStatus = data?.status ?? 'unknown'; // 'running' | 'stopped'
  return {
    status: qmpStatus === 'running' ? 'running' : qmpStatus === 'stopped' ? 'stopped' : 'unknown',
    uptime: data?.uptime ?? 0,             // seconds (0 when stopped)
    cpu: data?.cpu ?? null,                // cores'-worth 0..ncpu
    maxmem: data?.maxmem ?? null,          // bytes
    mem: data?.mem ?? null,                // bytes
    raw: qmpStatus,
  };
}
