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
import { badSetting, notFound, duplicateError, MAP_NAME_RE } from '../errors.js';

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

// CS2 game-mode aliases (game_alias sets game_type+game_mode under the hood).
const GAME_ALIASES = {
  competitive: 'Competitive',
  casual: 'Casual',
  deathmatch: 'Deathmatch',
  wingman: 'Wingman (2v2)',
};

const STOCK_FALLBACK = [
  'de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage',
  'de_nuke', 'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office',
];

// Live (RCON) curated actions. CS2 serves Source RCON on the game port (27015).
const RCON_PORT = 27015;
const CS_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'apply_config',  label: 'Apply Config' },   // re-exec the deployed gamertown/active.cfg live
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'bunnyhop_on',   label: 'Bunnyhop On' },
  { key: 'bunnyhop_off',  label: 'Bunnyhop Off' },
];
const CS_ACTION_CMDS = {
  restart_round: 'mp_restartgame 1',
  apply_config:  'exec gamertown/active',
  cheats_on:     'sv_cheats 1',
  cheats_off:    'sv_cheats 0',
  bunnyhop_on:   'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000',
  bunnyhop_off:  'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12',
};


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
      return uniq.length ? uniq : STOCK_FALLBACK;
    } catch {
      return STOCK_FALLBACK;
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

  defaultProfileSettings() {
    return { map: 'de_dust2', gameMode: 'competitive', maxPlayers: 10, hostname: '', rawConfig: '' };
  }

  validateProfileSettings(s = {}) {
    const out = {};
    const map = String(s.map ?? '').trim();
    if (map.startsWith('ws:')) {
      const id = map.slice(3);
      if (!/^\d{1,20}$/.test(id)) throw badSetting(`invalid workshop id: ${id}`);
      out.map = `ws:${id}`;
    } else {
      if (!MAP_NAME_RE.test(map)) throw badSetting(`invalid map name: ${map}`);
      out.map = map;
    }
    if (!GAME_ALIASES[s.gameMode]) throw badSetting(`invalid game mode: ${s.gameMode}`);
    out.gameMode = s.gameMode;
    const mp = Number(s.maxPlayers);
    if (!Number.isInteger(mp) || mp < 1 || mp > 64) throw badSetting('maxPlayers must be 1–64');
    out.maxPlayers = mp;
    const hostname = String(s.hostname ?? '');
    if (/["\n\r]/.test(hostname)) throw badSetting('server name may not contain quotes or newlines');
    out.hostname = hostname;
    const raw = String(s.rawConfig ?? '');
    if (raw.length > 100_000) throw badSetting('extra cvars too large (max 100000 chars)');
    if (raw.includes('\0')) throw badSetting('extra cvars may not contain null bytes');
    out.rawConfig = raw;
    return out;
  }

  async profileSchema() {
    const stock   = await this.#listMaps();
    const catalog = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    const mapOpts = [
      ...stock.map((m) => ({ value: m, label: m })),
      ...catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),  // by name, not id
    ];
    return {
      groups: [
        {
          key: 'map', title: 'Map & Mode',
          fields: [
            { key: 'map', label: 'Map', type: 'select', addWorkshop: true, options: mapOpts,
              help: 'Pick a stock map or a saved Workshop map (by name). Use “＋ Workshop Map” to add a new one by its Steam id — a Workshop map overrides the stock map.' },
            { key: 'gameMode', label: 'Game Mode', type: 'select',
              options: Object.entries(GAME_ALIASES).map(([value, label]) => ({ value, label })) },
            { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 64, step: 1 },
          ],
        },
        {
          key: 'advanced', title: 'Advanced',
          fields: [
            { key: 'hostname', label: 'Server Name', type: 'text' },
            { key: 'rawConfig', label: 'Extra cvars (deployed as a live-execable config)', type: 'textarea',
              placeholder: 'sv_cheats 1\nsv_autobunnyhopping 1\nsv_enablebunnyhopping 1' },
          ],
        },
      ],
      note: 'A profile is the startup config. A Workshop map overrides a stock map. Extra cvars deploy to gamertown/active.cfg (exec on map load, or live via Runtime → Apply Config). Changes apply on the next restart.',
    };
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
      gameMode: GAME_ALIASES[alias] ? alias : 'competitive',
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
    const nm = this.#validMapName(name);
    return this.store.addWorkshopMap(this.server.id, { workshopId: id, name: nm });
  }

  renameMap(workshopId, name) {
    this.requireStore();
    const nm = this.#validMapName(name);
    if (!this.store.renameWorkshopMap(this.server.id, String(workshopId), nm)) throw notFound('workshop map not found');
    return this.store.getWorkshopMap(this.server.id, workshopId);
  }

  deleteMap(workshopId) {
    if (!this.requireStore().deleteWorkshopMap(this.server.id, String(workshopId))) throw notFound('workshop map not found');
    return { ok: true };
  }

  #validMapName(name) {
    const nm = String(name ?? '').trim();
    if (!nm) throw badSetting('map name is required');
    if (/["\n\r]/.test(nm)) throw badSetting('map name may not contain quotes or newlines');
    if (nm.length > 64) throw badSetting('map name too long (max 64 chars)');
    return nm;
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
    const nm = this.#validConfigName(name);
    const b  = this.#validConfigBody(body);
    try {
      return this.store.createConfig(this.server.id, { name: nm, body: b });
    } catch (e) {
      throw duplicateError(e, nm, 'config');
    }
  }

  updateConfig(id, { name, body } = {}) {
    this.requireStore();
    const patch = {};
    if (name !== undefined) patch.name = this.#validConfigName(name);
    if (body !== undefined) patch.body = this.#validConfigBody(body);
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

  #validConfigName(name) {
    const nm = String(name ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nm)) {
      throw badSetting('config name may only contain letters, digits, underscores, and hyphens (max 64 chars)');
    }
    return nm;
  }

  #validConfigBody(body) {
    const b = String(body ?? '');
    if (b.length > 100_000) throw badSetting('config body too large (max 100000 chars)');
    if (b.includes('\0')) throw badSetting('config body may not contain null bytes');
    return b;
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
      actions: CS_LIVE_ACTIONS,
      changeMap: true, // panel renders a live change-map control (uses the same map options as Startup)
      commandHint: 'any CS2 console command, e.g. bot_add, mp_warmup_end, exec gamertown/active',
    };
  }

  async sendCommand(command) {
    const cmd = validateLiveCommand(command);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') return this.#changeMapLive(value);
    const cmd = CS_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }

  // Live map change on the running server (verified RCON commands):
  //   stock    'de_dust2'        → changelevel de_dust2
  //   workshop 'ws:3071005299'   → host_workshop_map 3071005299 (cvar alone loads it)
  // Runtime-only — reverts to the cfg's map on restart (Startup sets the persistent map).
  async #changeMapLive(value) {
    const v = String(value ?? '').trim();
    let cmd;
    if (v.startsWith('ws:')) {
      const id = v.slice(3);
      if (!/^\d{1,20}$/.test(id)) throw badSetting(`invalid workshop id: ${id}`);
      cmd = `host_workshop_map ${id}`;
    } else {
      if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
      cmd = `changelevel ${v}`;
    }
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }
}
