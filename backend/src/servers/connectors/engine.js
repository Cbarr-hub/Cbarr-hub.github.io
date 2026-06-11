// The one game-server connector. Per-game differences live in a SPEC (data
// tables + the genuinely imperative functions: validate/apply/capture, map
// sync, quick ops) under specs/; this engine interprets the spec and owns
// everything generic:
//
//   status/power        container-level via the Docker client (the container IS
//                       the game: running == hosting).
//   exec/config files   runShell/runCommand + whitelisted read/write from
//                       spec.configFiles.
//   profiles            persistence lifecycle (list/get/create/update/delete/
//                       apply/capture + auto-seeded "Default") — the game
//                       semantics come from spec.profile.{defaults,validate,
//                       schema,apply,capture}.
//   live control        getLive/sendCommand/runLiveAction driven by
//                       spec.live.{actions,actionCmds,controls,changeMapCmd};
//                       RCON over TCP with the password from spec.rcon.password
//                       ({env} | {file} | {cfgCvar}) — file reads TTL-cached so
//                       a slider drag isn't a docker exec per tick, short enough
//                       that a password rotation takes effect in ~a minute.
//   update              spec.update: {kind:'exec',argv,timeoutMs,…} |
//                       {kind:'reboot',note} | a custom function.
//   workshop catalog /  store-backed generics enabled by spec.catalog /
//   config library      spec.configLibrary (CS); spec.maps.* overrides for the
//                       gmad-based GMOD flow.

import { rconExchange, validateLiveCommand } from '../rcon-tcp.js';
import { getCvar } from '../line-config.js';
import { badSetting, notFound, notSupported, duplicateError } from '../errors.js';

const RCON_FILE_TTL_MS = 60_000;

// Coerce a slider/profile value into [min, max], substituting `fallback` for
// empty/null/undefined/non-finite input. The final clamp also guards `fallback`
// itself being out of range.
export function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') {
    return Math.max(min, Math.min(max, fallback));
  }
  const n = Number(value);
  const effective = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, effective));
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

function validProfileName(name) {
  const nm = String(name ?? '').trim();
  if (!/^[A-Za-z0-9 _-]{1,48}$/.test(nm)) {
    throw badSetting('profile name must be 1–48 chars: letters, digits, spaces, _ or -');
  }
  return nm;
}

export class GameConnector {
  /**
   * @param {object} server  registry entry { id, name, container, port, rconPort, … }
   * @param {object} spec    the per-game spec (specs/<game>.js)
   * @param {import('../../docker/client.js').DockerClient} client
   * @param {import('../store.js').createServerStore|null} [store]
   */
  constructor(server, spec, client, store = null) {
    this.server = server;
    this.spec = spec;
    this.client = client;
    this.store = store;
    this.#rconFileCache = { at: 0, value: '' };
  }

  #rconFileCache;

  get vmid() { return this.server.container; }
  get configFiles() { return this.spec.configFiles ?? {}; }

  // ── status / power ──────────────────────────────────────────────────────────
  async status(options = {}) {
    const data = await this.client.statusCurrent(this.vmid, options);
    const base = normalizeStatus(data);
    base.gameStatus = base.status === 'running' ? 'hosting' : 'down';
    return base;
  }

  start()    { return this.client.start(this.vmid); }
  shutdown() { return this.client.shutdown(this.vmid); }
  reboot()   { return this.client.reboot(this.vmid); }
  stop()     { return this.client.stop(this.vmid); }

  // ── in-container command execution ──────────────────────────────────────────
  runCommand(command, { input, timeoutMs = 120_000 } = {}) {
    return this.client.exec(this.vmid, command, { input, timeoutMs });
  }

  runShell(shellCommand, opts = {}) {
    return this.runCommand(['/bin/bash', '-lc', shellCommand], opts);
  }

  // ── config files ────────────────────────────────────────────────────────────
  listConfigFiles() { return Object.keys(this.configFiles); }

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

  // Read a whole in-container file, '' on any failure — the common spec idiom.
  fileText(path) {
    return this.client.fileRead(this.vmid, path).then((r) => r.content ?? '').catch(() => '');
  }

  // ── quick settings ──────────────────────────────────────────────────────────
  async getSettings() {
    if (this.spec.getSettings) return this.spec.getSettings(this);
    return { fields: [] };
  }

  async setSettings(values) {
    if (this.spec.setSettings) return this.spec.setSettings(this, values);
    const err = new Error('this server has no quick settings');
    err.code = 'NO_SETTINGS';
    throw err;
  }

  // ── update recipe ───────────────────────────────────────────────────────────
  async update() {
    const u = this.spec.update;
    if (!u) {
      const err = new Error(`no update recipe defined for ${this.server.id}`);
      err.code = 'NO_UPDATE_RECIPE';
      throw err;
    }
    if (typeof u === 'function') return u(this);
    if (u.kind === 'reboot') {
      await this.reboot();
      return { ok: true, note: u.note };
    }
    const res = await this.runCommand(u.argv, { timeoutMs: u.timeoutMs });
    return {
      ok: res.exitCode === 0,
      note: u.note,
      steps: [{ name: u.stepName, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }],
    };
  }

  // ── workshop map catalog ────────────────────────────────────────────────────
  // Store-backed generics when spec.catalog is set (CS); spec.maps.* overrides
  // for games whose maps are filesystem-driven (the GMOD gmad flow).
  listMaps() {
    if (this.spec.maps?.list) return this.spec.maps.list(this);
    if (this.spec.catalog) return this.requireStore().listWorkshopMaps(this.server.id);
    throw notSupported('a workshop map catalog');
  }
  syncMaps() {
    if (this.spec.maps?.sync) return this.spec.maps.sync(this);
    throw notSupported('workshop map sync');
  }
  addMap(body) {
    if (this.spec.maps?.add) return this.spec.maps.add(this, body);
    throw notSupported('a workshop map catalog');
  }
  importCollection(collectionId) {
    if (this.spec.maps?.importCollection) return this.spec.maps.importCollection(this, collectionId);
    throw notSupported('workshop collection import');
  }
  renameMap(workshopId, name) {
    if (!this.spec.catalog) throw notSupported('a workshop map catalog');
    const nm = this.spec.validMapName ? this.spec.validMapName(name) : String(name);
    if (!this.requireStore().renameWorkshopMap(this.server.id, workshopId, nm)) throw notFound('map not found');
    return this.store.getWorkshopMap(this.server.id, workshopId);
  }
  deleteMap(workshopId) {
    if (!this.spec.catalog) throw notSupported('a workshop map catalog');
    if (!this.requireStore().deleteWorkshopMap(this.server.id, workshopId)) throw notFound('map not found');
    return { ok: true };
  }

  // ── config library (DB-backed; CS only) ─────────────────────────────────────
  #libValidators() {
    const lib = this.spec.configLibrary;
    if (!lib) throw notSupported('a config library');
    return lib;
  }
  listConfigs() { this.#libValidators(); return this.requireStore().listConfigs(this.server.id); }
  getConfig(id) {
    this.#libValidators();
    const cfg = this.requireStore().getConfig(this.server.id, id);
    if (!cfg) throw notFound('config not found');
    return cfg;
  }
  createConfig({ name, body } = {}) {
    const lib = this.#libValidators();
    this.requireStore();
    const nm = lib.validName(name);
    const b = lib.validBody(body);
    try { return this.store.createConfig(this.server.id, { name: nm, body: b }); }
    catch (e) { throw duplicateError(e, nm, 'config'); }
  }
  deleteConfig(id) {
    this.#libValidators();
    if (!this.requireStore().deleteConfig(this.server.id, id)) throw notFound('config not found');
    return { ok: true };
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // The engine owns persistence + lifecycle; the spec supplies the semantics.
  requireStore() {
    if (!this.store) {
      const e = new Error('persistence store is not configured');
      e.code = 'NOT_CONFIGURED';
      throw e;
    }
    return this.store;
  }

  defaultProfileSettings() {
    return this.spec.profile?.defaults ? this.spec.profile.defaults(this) : null;
  }

  validateProfileSettings(s) {
    if (this.spec.profile?.validate) return this.spec.profile.validate(this, s ?? {});
    return s ?? {};
  }

  async profileSchema() {
    if (this.spec.profile?.schema) return this.spec.profile.schema(this);
    return { groups: [] };
  }

  async applyProfileSettings(settings, profileId) {
    if (!this.spec.profile?.apply) throw notSupported('profiles');
    return this.spec.profile.apply(this, settings, profileId);
  }

  async captureProfileSettings() {
    if (!this.spec.profile?.capture) throw notSupported('profiles');
    return this.spec.profile.capture(this);
  }

  // List profiles (+ the active profile id). Seeds a "Default" the first time —
  // only when the spec defines defaults — so the list is never empty.
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

  async applyProfile(id) {
    const store = this.requireStore();
    const p = store.getProfile(this.server.id, id);
    if (!p) throw notFound('profile not found');
    await this.applyProfileSettings(p.settings, id);
    store.setActiveProfile(this.server.id, id);
    return { ok: true, id, name: p.name };
  }

  async captureProfile(name) {
    const store = this.requireStore();
    const nm = validProfileName(name);
    const settings = await this.captureProfileSettings();
    try { return store.createProfile(this.server.id, { name: nm, settings }); }
    catch (e) { throw duplicateError(e, nm, 'profile'); }
  }

  // ── live control (Source RCON over TCP) ─────────────────────────────────────
  async rconCreds() {
    const r = this.spec.rcon ?? {};
    const port = (r.port === 'rconPort' ? this.server.rconPort : this.server.port) ?? r.portFallback;
    const src = r.password ?? {};
    let password = '';
    if (src.env) {
      password = process.env[src.env] ?? '';
    } else if (src.file) {
      // TTL-cached: live calls shouldn't cost a docker exec each, but a rotated
      // password must take effect without an app restart.
      const now = Date.now();
      if (now - this.#rconFileCache.at > RCON_FILE_TTL_MS) {
        this.#rconFileCache = { at: now, value: (await this.fileText(src.file)).trim() };
      }
      password = this.#rconFileCache.value;
    } else if (src.cfgCvar) {
      // Re-read per call: an Apply that sets the password must take effect
      // without a connector reload.
      const text = await this.fileText(this.configFiles[src.cfgCvar.file] ?? src.cfgCvar.file);
      password = (getCvar(text, src.cfgCvar.name) || '').trim();
    }
    return { password, port };
  }

  async runRcon(command) {
    const { password, port } = await this.rconCreds();
    if (!password) { const e = new Error('RCON password is not set'); e.code = 'NO_RCON'; throw e; }
    return { output: await rconExchange({ host: this.server.container, port, password, command }) };
  }

  async getLive() {
    const live = this.spec.live;
    if (!live) return { available: false, reason: 'no live control for this server' };
    const { password } = await this.rconCreds();
    if (!password) return { available: false, reason: this.spec.rcon?.gateReason ?? 'RCON is not configured' };
    return {
      available: true,
      actions: live.actions,
      ...(live.controls?.length
        ? { controls: live.controls.map(({ cmd, strict, ...row }) => row) }
        : {}),
      ...(live.changeMapCmd ? { changeMap: true } : {}),
      commandHint: live.commandHint,
    };
  }

  async sendCommand(command) {
    return this.runRcon(validateLiveCommand(command));
  }

  // Dispatch one Runtime-panel key: live change-map → control slider (clamped)
  // → curated action button. `value` is consumed by change_map + the sliders.
  async runLiveAction(key, value) {
    const live = this.spec.live;
    if (!live) { const e = new Error('live actions are not supported for this server'); e.code = 'NO_RCON'; throw e; }
    if (key === 'change_map' && live.changeMapCmd) return this.runRcon(live.changeMapCmd(value));
    const ctl = (live.controls ?? []).find((c) => c.key === key);
    if (ctl) {
      let n;
      if (ctl.strict) {
        // GMOD-family semantics: a non-numeric value is an error, not a default.
        n = Number(value);
        if (!Number.isFinite(n)) throw badSetting(`invalid value for ${ctl.label}`);
        n = Math.min(ctl.max, Math.max(ctl.min, n));
      } else {
        n = clampNumber(value, ctl.min, ctl.max, ctl.default);
      }
      return this.runRcon(ctl.cmd(n));
    }
    const cmd = live.actionCmds?.[key];
    if (typeof cmd === 'function') return this.runRcon(cmd(this, value));
    if (cmd) return this.runRcon(cmd);
    throw badSetting(`unknown live action: ${key}`);
  }

  // ── optional per-spec extras (presence / map / join string) ─────────────────
  connectPassword() {
    return this.spec.connectPassword ? this.spec.connectPassword(this) : '';
  }
}

// Wire the optional presence/position hooks onto the prototype only when a spec
// has them: service.js feature-detects `connector.listOnlinePlayers` /
// `connector.getPlayerPosition`, so games without them must NOT expose the
// methods at all (a throwing stub would break the capability check).
export function buildConnector(server, spec, client, store = null) {
  const conn = new GameConnector(server, spec, client, store);
  if (spec.listOnlinePlayers) conn.listOnlinePlayers = () => spec.listOnlinePlayers(conn);
  if (spec.getPlayerPosition) conn.getPlayerPosition = (target, p) => spec.getPlayerPosition(conn, target, p);
  return conn;
}
