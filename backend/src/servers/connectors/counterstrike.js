// Counter-Strike 2 connector — LinuxGSM instance `cs2server`.
//
// Verified layout (VM 100, 192.168.1.75) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/csserver   (owned by user `miles`)
//   control     : ./cs2server start|stop|restart|update   (run as miles)
//
// Map + game mode come from the exec'd game config (the cs2 process launches
// with just `+exec cs2server.cfg`), NOT from LinuxGSM start params:
//   game cfg : serverfiles/game/csgo/cfg/cs2server.cfg
//     map "<stock>"                 stock map (used when no workshop map set)
//     host_workshop_map "<id>"      Steam Workshop map — OVERRIDES `map`
//     game_alias "<alias>"          game mode (competitive/casual/deathmatch/wingman)
//     hostname "<name>"             server name in the browser
//     exec gamertown/active         applies the selected saved config (see below)
//   maxplayers + gt_active_config live in the LGSM instance cfg.
// Changes apply on the next server restart.
//
// Workshop-map catalog + config library (SQLite-backed):
//   - The workshop-map catalog + reusable config library are persisted in SQLite
//     (this.store), not hardcoded. Adding/renaming maps and editing configs are
//     pure DB ops; getSettings reads the catalog to build the map dropdown.
//   - A selected config is "deployed" by materializing its body into
//     cfg/gamertown/active.cfg and ensuring cs2server.cfg execs it. Map + config
//     then both apply on the next restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVar } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';
import { rconCommand, validateLiveCommand } from '../rcon.js';
import { badSetting, notFound, duplicateError } from '../errors.js';
import * as csProfile from './counterstrike-profile.js';

const DIR          = '/home/miles/csserver';
const CFG_DIR      = `${DIR}/serverfiles/game/csgo/cfg`;
const GAME_CFG     = `${CFG_DIR}/cs2server.cfg`;
const INSTANCE_CFG = `${DIR}/lgsm/config-lgsm/cs2server/cs2server.cfg`;
const MAPS_DIR     = `${DIR}/serverfiles/game/csgo/maps`;

// Managed config that cs2server.cfg execs last, holding the selected saved
// config's body. `ACTIVE_EXEC` is the path relative to cfg/ that `exec` wants.
const GT_DIR       = `${CFG_DIR}/gamertown`;
const ACTIVE_CFG   = `${GT_DIR}/active.cfg`;
const ACTIVE_EXEC  = 'gamertown/active';
const EXEC_LINE_RE = /^[ \t]*exec[ \t]+gamertown\/active[ \t]*$/m;

// CS2 serves Source RCON on the game port. Game aliases, stock maps, live-action
// maps, validation + the editor schema are shared via ./counterstrike-profile.js.
const RCON_PORT = 27015;

export class CounterStrikeConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'cs2server';

  configFiles = {
    'server.cfg': GAME_CFG,
    'lgsm.cfg': INSTANCE_CFG,
    'lgsm-common.cfg': `${DIR}/lgsm/config-lgsm/cs2server/common.cfg`,
  };

  async #listMaps() {
    try {
      const res = await this.runShell(`ls -1 ${MAPS_DIR}/*.vpk 2>/dev/null`, { asUser: this.gsmUser, timeoutMs: 15_000 });
      const names = (res.stdout || '').split('\n')
        .map((l) => l.trim().replace(/^.*\//, '').replace(/\.vpk$/, ''))
        .filter((n) => /^(de|cs|ar|dz|gd|coop)_/.test(n) && !n.endsWith('_vanity'));
      const uniq = [...new Set(names)].sort();
      return uniq.length ? uniq : csProfile.STOCK_FALLBACK;
    } catch {
      return csProfile.STOCK_FALLBACK;
    }
  }

  // Profiles own the startup config (the Profiles panel). getSettings is kept only
  // to feed the Runtime panel's live change-map dropdown (stock + workshop maps).
  async getSettings() {
    const game = await this.client.agentFileRead(this.vmid, GAME_CFG)
      .then((r) => r.content ?? '').catch(() => '');
    const hwm      = (getCvar(game, 'host_workshop_map') || '').trim();
    const stockMap = getCvar(game, 'map') || 'de_dust2';
    const stock    = await this.#listMaps();
    const catalog  = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    const workshop = catalog.map((w) => ({ id: w.workshopId, name: w.name }));
    if (hwm && !workshop.some((w) => w.id === hwm)) workshop.unshift({ id: hwm, name: `Workshop ${hwm}` });
    return {
      game: 'counterstrike',
      map: { current: hwm ? `ws:${hwm}` : stockMap, stock, workshop },
    };
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // A CS profile is the startup config: map (stock or ws:<id>) + game mode + max
  // players + server name + a raw extra-cvars block (the bunnyhop-style escape
  // hatch, deployed to gamertown/active.cfg). Replaces the old bespoke CS panel.

  defaultProfileSettings()    { return csProfile.defaultProfileSettings(); }
  validateProfileSettings(s)  { return csProfile.validateProfileSettings(s); }

  async profileSchema() {
    const stock   = await this.#listMaps();
    const catalog = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    const mapOpts = [
      ...stock.map((m) => ({ value: m, label: m })),
      ...catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),  // by name, not id
    ];
    return csProfile.profileGroups(mapOpts,
      'A profile is the startup config. A Workshop map overrides a stock map. Extra cvars deploy to ' +
      'gamertown/active.cfg (exec on map load, or live via Runtime → Apply Config). Changes apply on the next restart.');
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);

    // game cfg: map / workshop / mode / hostname + ensure the active.cfg exec line
    let game = (await this.client.agentFileRead(this.vmid, GAME_CFG)).content ?? '';
    const cvars = {};
    if (s.map.startsWith('ws:')) {
      cvars.host_workshop_map = s.map.slice(3);          // overrides the stock map
    } else {
      cvars.map = s.map;
      cvars.host_workshop_map = '';
      cvars.host_workshop_collection = '';
    }
    cvars.game_alias = s.gameMode;
    cvars.hostname = s.hostname;
    game = setCvars(game, cvars);
    const ensured = await this.#ensureActiveExec(game);
    await this.client.agentFileWrite(this.vmid, GAME_CFG, ensured.text);

    // deploy the extra-cvars block to gamertown/active.cfg (exec'd by cs2server.cfg)
    await this.runShell(`mkdir -p "${GT_DIR}"`, { asUser: this.gsmUser, timeoutMs: 10_000 });
    await this.client.agentFileWrite(this.vmid, ACTIVE_CFG, s.rawConfig);

    // instance cfg: maxplayers + on-box active-profile mirror
    let inst = (await this.client.agentFileRead(this.vmid, INSTANCE_CFG)).content ?? '';
    inst = setVar(inst, 'maxplayers', String(s.maxPlayers));
    if (profileId != null) inst = setVar(inst, 'gt_active_profile', String(profileId));
    await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, inst);
    return { ok: true };
  }

  async captureProfileSettings() {
    const game   = await this.client.agentFileRead(this.vmid, GAME_CFG).then((r) => r.content ?? '').catch(() => '');
    const inst   = await this.client.agentFileRead(this.vmid, INSTANCE_CFG).then((r) => r.content ?? '').catch(() => '');
    const active = await this.client.agentFileRead(this.vmid, ACTIVE_CFG).then((r) => r.content ?? '').catch(() => '');
    const hwm   = (getCvar(game, 'host_workshop_map') || '').trim();
    const alias = (getCvar(game, 'game_alias') || 'competitive').trim();
    return this.validateProfileSettings({
      map: hwm ? `ws:${hwm}` : (getCvar(game, 'map') || 'de_dust2'),
      gameMode: csProfile.GAME_ALIASES[alias] ? alias : 'competitive',
      maxPlayers: Number(getVar(inst, 'maxplayers') || 10),
      hostname: getCvar(game, 'hostname') ?? '',
      rawConfig: active,
    });
  }

  // Ensure cs2server.cfg execs the managed active.cfg, creating the file if
  // needed so the exec never warns. Returns the (possibly extended) text.
  async #ensureActiveExec(gameText) {
    if (EXEC_LINE_RE.test(gameText)) return { text: gameText, changed: false };
    await this.runShell(`mkdir -p "${GT_DIR}" && touch "${ACTIVE_CFG}"`, {
      asUser: this.gsmUser, timeoutMs: 10_000,
    });
    return { text: gameText.replace(/\n*$/, '') + `\nexec ${ACTIVE_EXEC}\n`, changed: true };
  }

  // ── workshop map catalog (DB-backed) ────────────────────────────────────────
  listMaps() {
    return this.requireStore().listWorkshopMaps(this.server.id);
  }

  addMap({ workshopId, name } = {}) {
    this.requireStore();
    const id = String(workshopId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop id must be 1–20 digits');
    const nm = csProfile.validMapName(name);
    return this.store.addWorkshopMap(this.server.id, { workshopId: id, name: nm });
  }

  renameMap(workshopId, name) {
    this.requireStore();
    const nm = csProfile.validMapName(name);
    if (!this.store.renameWorkshopMap(this.server.id, String(workshopId), nm)) throw notFound('workshop map not found');
    return this.store.getWorkshopMap(this.server.id, workshopId);
  }

  deleteMap(workshopId) {
    if (!this.requireStore().deleteWorkshopMap(this.server.id, String(workshopId))) throw notFound('workshop map not found');
    return { ok: true };
  }

  // ── config library (DB-backed) ──────────────────────────────────────────────
  listConfigs() {
    return this.requireStore().listConfigs(this.server.id);
  }

  getConfig(id) {
    const cfg = this.requireStore().getConfig(this.server.id, id);
    if (!cfg) throw notFound('config not found');
    return cfg;
  }

  createConfig({ name, body } = {}) {
    this.requireStore();
    const nm = csProfile.validConfigName(name);
    const b  = csProfile.validConfigBody(body);
    try {
      return this.store.createConfig(this.server.id, { name: nm, body: b });
    } catch (e) {
      throw duplicateError(e, nm, 'config');
    }
  }

  updateConfig(id, { name, body } = {}) {
    this.requireStore();
    const patch = {};
    if (name !== undefined) patch.name = csProfile.validConfigName(name);
    if (body !== undefined) patch.body = csProfile.validConfigBody(body);
    let updated;
    try {
      updated = this.store.updateConfig(this.server.id, id, patch);
    } catch (e) {
      throw duplicateError(e, patch.name, 'config');
    }
    if (!updated) throw notFound('config not found');
    return updated;
  }

  deleteConfig(id) {
    if (!this.requireStore().deleteConfig(this.server.id, id)) throw notFound('config not found');
    return { ok: true };
  }

  // ── live commands (Phase 3; CS2 Source RCON on the game port) ────────────────
  async #rconPassword() {
    const game = await this.client.agentFileRead(this.vmid, GAME_CFG).then((r) => r.content ?? '').catch(() => '');
    return (getCvar(game, 'rcon_password') || '').trim();
  }

  async getLive() {
    const pw = await this.#rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in cs2server.cfg and restart' };
    return {
      available: true,
      actions: csProfile.CS_LIVE_ACTIONS,
      changeMap: true, // panel renders a live change-map control (uses the same map options as Startup)
      commandHint: 'any CS2 console command, e.g. bot_add, mp_warmup_end, exec gamertown/active',
    };
  }

  async sendCommand(command) {
    const cmd = validateLiveCommand(command);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }

  async runLiveAction(key, value) {
    // Live map change on the running server — runtime-only; reverts to the cfg's
    // map on restart (Startup sets the persistent map).
    if (key === 'change_map') {
      const cmd = csProfile.buildChangeMapCmd(value);
      return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
    }
    const cmd = csProfile.CS_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }
}
