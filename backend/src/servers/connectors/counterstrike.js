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
// Phase 2 additions (see SERVER_PANEL_PLAN.md):
//   - The workshop-map catalog + reusable config library are persisted in SQLite
//     (this.store), not hardcoded. Adding/renaming maps and editing configs are
//     pure DB ops; getSettings reads the catalog to build the map dropdown.
//   - A selected config is "deployed" by materializing its body into
//     cfg/gamertown/active.cfg and ensuring cs2server.cfg execs it. Map + config
//     then both apply on the next restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVar } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';

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

const badSetting = (msg) => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };
const notFound   = (what) => { const e = new Error(`${what} not found`); e.code = 'NOT_FOUND'; return e; };

export class CounterStrikeConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'cs2server';

  configFiles = {
    'server.cfg': GAME_CFG,
    'lgsm.cfg': INSTANCE_CFG,
    'lgsm-common.cfg': `${DIR}/lgsm/config-lgsm/cs2server/common.cfg`,
  };

  #store() {
    if (!this.store) {
      const e = new Error('persistence store is not configured');
      e.code = 'NOT_CONFIGURED';
      throw e;
    }
    return this.store;
  }

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

  // ── structured settings (consumed by the bespoke CS panel) ──────────────────
  async getSettings() {
    const game = await this.client.agentFileRead(this.vmid, GAME_CFG)
      .then((r) => r.content ?? '').catch(() => '');
    const inst = await this.client.agentFileRead(this.vmid, INSTANCE_CFG)
      .then((r) => r.content ?? '').catch(() => '');

    const hwm        = (getCvar(game, 'host_workshop_map') || '').trim();
    const stockMap   = getCvar(game, 'map') || 'de_dust2';
    const alias      = (getCvar(game, 'game_alias') || 'competitive').trim();
    const hostname   = getCvar(game, 'hostname') ?? '';
    const maxplayers = Number(getVar(inst, 'maxplayers') || 10);
    const activeCfg  = getVar(inst, 'gt_active_config') || '';

    const stock    = await this.#listMaps();
    const catalog  = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    const configs  = this.store ? this.store.listConfigs(this.server.id) : [];

    const workshop = catalog.map((w) => ({ id: w.workshopId, name: w.name }));
    // If the active workshop map isn't catalogued, surface it anyway so the
    // dropdown can show + keep the current selection (fallback name).
    if (hwm && !workshop.some((w) => w.id === hwm)) {
      const fallback = getVar(inst, 'gt_workshop_name') || `Workshop ${hwm}`;
      workshop.unshift({ id: hwm, name: fallback });
    }

    return {
      game: 'counterstrike',
      map: {
        current: hwm ? `ws:${hwm}` : stockMap, // 'de_dust2' or 'ws:<id>'
        stock,
        workshop,
      },
      gameMode: {
        value: GAME_ALIASES[alias] ? alias : 'competitive',
        options: Object.entries(GAME_ALIASES).map(([value, label]) => ({ value, label })),
      },
      maxPlayers: maxplayers,
      hostname, // shown under Advanced
      configs: {
        options: configs.map((c) => ({ id: c.id, name: c.name })),
        selectedId: activeCfg ? Number(activeCfg) : null,
      },
      note: 'Workshop map overrides a stock map. Map + config changes apply on the next server restart.',
    };
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

  // Write the selected config's body into active.cfg. configId '' / null clears
  // it (empty file = no-op exec). Returns the id string to store for the UI.
  async #deployConfig(configId) {
    let body = '', selectedId = '';
    if (configId !== '' && configId != null) {
      const cfg = this.store?.getConfig(this.server.id, configId);
      if (!cfg) throw badSetting(`unknown config: ${configId}`);
      body = cfg.body || '';
      selectedId = String(cfg.id);
    }
    await this.runShell(`mkdir -p "${GT_DIR}"`, { asUser: this.gsmUser, timeoutMs: 10_000 });
    await this.client.agentFileWrite(this.vmid, ACTIVE_CFG, body);
    return selectedId;
  }

  async setSettings(values = {}) {
    const { map, workshopId, gameMode, maxPlayers, hostname, configId } = values;

    if (gameMode !== undefined && !GAME_ALIASES[gameMode]) throw badSetting(`invalid game mode: ${gameMode}`);
    const mp = maxPlayers === undefined ? undefined : Number(maxPlayers);
    if (mp !== undefined && (!Number.isInteger(mp) || mp < 1 || mp > 64)) throw badSetting('maxPlayers must be 1–64');
    if (workshopId !== undefined && workshopId !== '' && !/^\d{1,20}$/.test(workshopId)) throw badSetting(`invalid workshop id: ${workshopId}`);
    if (hostname !== undefined && /["\n\r]/.test(hostname)) throw badSetting('server name may not contain quotes or newlines');

    // Resolve the desired map source.
    let wsId, stock;
    if (workshopId) wsId = workshopId;
    else if (typeof map === 'string' && map.startsWith('ws:')) wsId = map.slice(3);
    else if (typeof map === 'string' && map) {
      if (!/^[a-z0-9_]{1,64}$/.test(map)) throw badSetting(`invalid map name: ${map}`);
      stock = map;
    }
    if (wsId !== undefined && !/^\d{1,20}$/.test(wsId)) throw badSetting(`invalid workshop id: ${wsId}`);

    // ── game cfg (map / workshop / alias / hostname) + active-config exec line ──
    let game = (await this.client.agentFileRead(this.vmid, GAME_CFG)).content ?? '';
    const cvars = {};
    if (wsId !== undefined) {
      cvars.host_workshop_map = wsId;                 // overrides stock map
    } else if (stock !== undefined) {
      cvars.map = stock;
      cvars.host_workshop_map = '';                   // clear workshop so stock map loads
      cvars.host_workshop_collection = '';
    }
    if (gameMode !== undefined) cvars.game_alias = gameMode;
    if (hostname !== undefined) cvars.hostname = hostname;

    let gameChanged = false;
    if (Object.keys(cvars).length) { game = setCvars(game, cvars); gameChanged = true; }
    const ensured = await this.#ensureActiveExec(game);
    game = ensured.text;
    if (gameChanged || ensured.changed) await this.client.agentFileWrite(this.vmid, GAME_CFG, game);

    // ── active config deploy (only when configId is present in the request) ──
    let selectedConfigId;
    if ('configId' in values) selectedConfigId = await this.#deployConfig(configId);

    // ── instance cfg (maxplayers + active config id) ──
    if (mp !== undefined || selectedConfigId !== undefined) {
      let inst = (await this.client.agentFileRead(this.vmid, INSTANCE_CFG)).content ?? '';
      if (mp !== undefined) inst = setVar(inst, 'maxplayers', String(mp));
      if (selectedConfigId !== undefined) inst = setVar(inst, 'gt_active_config', selectedConfigId);
      await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, inst);
    }

    return { ok: true, applied: { map: stock, workshopMap: wsId, gameMode, maxPlayers: mp, hostname, configId: selectedConfigId } };
  }

  // ── workshop map catalog (DB-backed) ────────────────────────────────────────
  listMaps() {
    return this.#store().listWorkshopMaps(this.server.id);
  }

  addMap({ workshopId, name } = {}) {
    this.#store();
    const id = String(workshopId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop id must be 1–20 digits');
    const nm = this.#validMapName(name);
    return this.store.addWorkshopMap(this.server.id, { workshopId: id, name: nm });
  }

  renameMap(workshopId, name) {
    this.#store();
    const nm = this.#validMapName(name);
    if (!this.store.renameWorkshopMap(this.server.id, String(workshopId), nm)) throw notFound('workshop map');
    return this.store.getWorkshopMap(this.server.id, workshopId);
  }

  deleteMap(workshopId) {
    if (!this.#store().deleteWorkshopMap(this.server.id, String(workshopId))) throw notFound('workshop map');
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
    return this.#store().listConfigs(this.server.id);
  }

  getConfig(id) {
    const cfg = this.#store().getConfig(this.server.id, id);
    if (!cfg) throw notFound('config');
    return cfg;
  }

  createConfig({ name, body } = {}) {
    this.#store();
    const nm = this.#validConfigName(name);
    const b  = this.#validConfigBody(body);
    try {
      return this.store.createConfig(this.server.id, { name: nm, body: b });
    } catch (e) {
      throw this.#mapDbErr(e, nm);
    }
  }

  updateConfig(id, { name, body } = {}) {
    this.#store();
    const patch = {};
    if (name !== undefined) patch.name = this.#validConfigName(name);
    if (body !== undefined) patch.body = this.#validConfigBody(body);
    let updated;
    try {
      updated = this.store.updateConfig(this.server.id, id, patch);
    } catch (e) {
      throw this.#mapDbErr(e, patch.name);
    }
    if (!updated) throw notFound('config');
    return updated;
  }

  deleteConfig(id) {
    if (!this.#store().deleteConfig(this.server.id, id)) throw notFound('config');
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

  #mapDbErr(e, name) {
    if (/UNIQUE/.test(e?.message || '')) return badSetting(`a config named "${name}" already exists`);
    return e;
  }
}
