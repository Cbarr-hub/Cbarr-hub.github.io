// Counter-Strike 2 connector — LinuxGSM instance `cs2server`.
//
// Verified layout (VM 100, 192.168.1.75) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/csserver   (owned by user `miles`)
//   control     : ./cs2server start|stop|restart|update   (run as miles)
//
// Map + game mode actually come from the exec'd game config (the cs2 process
// launches with just `+exec cs2server.cfg`), NOT from LinuxGSM start params:
//   game cfg : serverfiles/game/csgo/cfg/cs2server.cfg
//     map "<stock>"                 stock map (used when no workshop map set)
//     host_workshop_map "<id>"      Steam Workshop map — OVERRIDES `map`
//     game_alias "<alias>"          game mode (competitive/casual/deathmatch/wingman)
//     hostname "<name>"             server name in the browser
//   maxplayers lives in the LGSM instance cfg (flows to -maxplayers).
// Changes apply on the next server restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVar } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';

const DIR = '/home/miles/csserver';
const GAME_CFG = `${DIR}/serverfiles/game/csgo/cfg/cs2server.cfg`;
const INSTANCE_CFG = `${DIR}/lgsm/config-lgsm/cs2server/cs2server.cfg`;
const MAPS_DIR = `${DIR}/serverfiles/game/csgo/maps`;

// Curated Steam Workshop maps the panel offers. Add { id, name } entries to
// extend the dropdown; arbitrary IDs can still be entered in the override field.
const WORKSHOP_MAPS = [
  { id: '3071005299', name: 'Assembly' },
];

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

  async getSettings() {
    const game = await this.client.agentFileRead(this.vmid, GAME_CFG)
      .then((r) => r.content ?? '').catch(() => '');
    const inst = await this.client.agentFileRead(this.vmid, INSTANCE_CFG)
      .then((r) => r.content ?? '').catch(() => '');

    const hwm = (getCvar(game, 'host_workshop_map') || '').trim();
    const stockMap = getCvar(game, 'map') || 'de_dust2';
    const alias = (getCvar(game, 'game_alias') || 'competitive').trim();
    const hostname = getCvar(game, 'hostname') ?? '';
    const maxplayers = Number(getVar(inst, 'maxplayers') || 10);
    const storedName = getVar(inst, 'gt_workshop_name') || '';

    const stock = await this.#listMaps();
    // Build the map dropdown: stock maps + curated workshop maps.
    const options = [
      ...stock.map((m) => ({ value: m, label: m })),
      ...WORKSHOP_MAPS.map((w) => ({ value: `ws:${w.id}`, label: `${w.name} (Workshop)` })),
    ];
    const current = hwm ? `ws:${hwm}` : stockMap;
    // Make sure the current selection is always present, even an unknown workshop id.
    if (!options.some((o) => o.value === current)) {
      const label = hwm
        ? `${storedName || `Workshop ${hwm}`} (Workshop)`
        : stockMap;
      options.unshift({ value: current, label });
    }

    // Pre-fill the Map Name field: use the curated name if known, stored name otherwise.
    const curatedEntry = WORKSHOP_MAPS.find((w) => w.id === hwm);
    const workshopNameValue = hwm ? (curatedEntry?.name ?? storedName) : '';

    return {
      fields: [
        { key: 'map', label: 'Map', type: 'select', value: current, options },
        { key: 'workshopId', label: 'Workshop ID', type: 'text', value: '',
          placeholder: 'overrides Map with this Workshop ID' },
        { key: 'workshopName', label: 'Map Name', type: 'text', value: workshopNameValue,
          placeholder: 'display name for Workshop ID above (e.g. Cobblestone)' },
        { key: 'gameMode', label: 'Game Mode', type: 'select',
          value: GAME_ALIASES[alias] ? alias : 'competitive',
          options: Object.entries(GAME_ALIASES).map(([v, l]) => ({ value: v, label: l })) },
        { key: 'maxPlayers', label: 'Max Players', type: 'number', value: maxplayers, min: 1, max: 64 },
        { key: 'hostname', label: 'Server Name', type: 'text', value: hostname },
      ],
      note: 'Workshop map (or Workshop ID override) takes precedence over a stock map. Changes apply on the next server restart.',
    };
  }

  async setSettings(values = {}) {
    const { map, workshopId, workshopName, gameMode, maxPlayers, hostname } = values;
    const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };

    if (gameMode !== undefined && !GAME_ALIASES[gameMode]) throw bad(`invalid game mode: ${gameMode}`);
    const mp = maxPlayers === undefined ? undefined : Number(maxPlayers);
    if (mp !== undefined && (!Number.isInteger(mp) || mp < 1 || mp > 64)) throw bad('maxPlayers must be 1–64');
    if (workshopId !== undefined && workshopId !== '' && !/^\d{1,20}$/.test(workshopId)) throw bad(`invalid workshop id: ${workshopId}`);
    if (workshopName !== undefined && /["\n\r]/.test(workshopName)) throw bad('map name may not contain quotes or newlines');
    if (hostname !== undefined && /["\n\r]/.test(hostname)) throw bad('server name may not contain quotes or newlines');

    // Resolve the desired map source.
    let wsId, stock;
    if (workshopId) wsId = workshopId;
    else if (typeof map === 'string' && map.startsWith('ws:')) wsId = map.slice(3);
    else if (typeof map === 'string' && map) {
      if (!/^[a-z0-9_]{1,64}$/.test(map)) throw bad(`invalid map name: ${map}`);
      stock = map;
    }
    if (wsId !== undefined && !/^\d{1,20}$/.test(wsId)) throw bad(`invalid workshop id: ${wsId}`);

    // ── game cfg (map / workshop / alias / hostname) ──
    const game = (await this.client.agentFileRead(this.vmid, GAME_CFG)).content ?? '';
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
    if (Object.keys(cvars).length) {
      await this.client.agentFileWrite(this.vmid, GAME_CFG, setCvars(game, cvars));
    }

    // ── instance cfg (maxplayers + workshop display name) ──
    const needsInstWrite = mp !== undefined || wsId !== undefined || stock !== undefined;
    if (needsInstWrite) {
      const inst = (await this.client.agentFileRead(this.vmid, INSTANCE_CFG)).content ?? '';
      let newInst = inst;
      if (mp !== undefined) newInst = setVar(newInst, 'maxplayers', String(mp));
      // Store the human-readable name for workshop maps; clear it when switching to stock.
      if (wsId !== undefined) newInst = setVar(newInst, 'gt_workshop_name', workshopName ?? '');
      else if (stock !== undefined) newInst = setVar(newInst, 'gt_workshop_name', '');
      await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, newInst);
    }

    return { ok: true, applied: { map: stock, workshopMap: wsId, workshopName, gameMode, maxPlayers: mp, hostname } };
  }
}
