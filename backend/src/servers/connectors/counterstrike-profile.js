// Pure Counter-Strike 2 profile/validation logic + curated RCON actions, shared
// by the Proxmox (LinuxGSM) and Docker connectors. Transport-agnostic: no file or
// container access here, just validation, the editor schema, and command builders.

import { badSetting, MAP_NAME_RE } from '../errors.js';

// CS2 game-mode aliases (game_alias sets game_type+game_mode under the hood).
export const GAME_ALIASES = {
  competitive: 'Competitive',
  casual: 'Casual',
  deathmatch: 'Deathmatch',
  wingman: 'Wingman (2v2)',
};

export const STOCK_FALLBACK = [
  'de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage',
  'de_nuke', 'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office',
];

// Live (RCON) curated actions. CS2 serves Source RCON on the game port (27015).
export const CS_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'apply_config',  label: 'Apply Config' },
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'bunnyhop_on',   label: 'Bunnyhop On' },
  { key: 'bunnyhop_off',  label: 'Bunnyhop Off' },
];
export const CS_ACTION_CMDS = {
  restart_round: 'mp_restartgame 1',
  apply_config:  'exec gamertown/active',
  cheats_on:     'sv_cheats 1',
  cheats_off:    'sv_cheats 0',
  bunnyhop_on:   'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000',
  bunnyhop_off:  'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12',
};

export function defaultProfileSettings() {
  return { map: 'de_dust2', gameMode: 'competitive', maxPlayers: 10, hostname: '', rawConfig: '' };
}

export function validateProfileSettings(s = {}) {
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

// The Profiles editor groups (Map & Mode / Advanced). `mapOpts` is the
// connector-supplied <select> option list (stock + saved workshop maps).
export function profileGroups(mapOpts, note) {
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
    note,
  };
}

// Build the RCON command to change to a map value ('de_dust2' or 'ws:<id>').
export function buildChangeMapCmd(value) {
  const v = String(value ?? '').trim();
  if (v.startsWith('ws:')) {
    const id = v.slice(3);
    if (!/^\d{1,20}$/.test(id)) throw badSetting(`invalid workshop id: ${id}`);
    return `host_workshop_map ${id}`;
  }
  if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
  return `changelevel ${v}`;
}

// Validators reused by the DB-backed catalog/config library.
export function validMapName(name) {
  const nm = String(name ?? '').trim();
  if (!nm) throw badSetting('map name is required');
  if (/["\n\r]/.test(nm)) throw badSetting('map name may not contain quotes or newlines');
  if (nm.length > 64) throw badSetting('map name too long (max 64 chars)');
  return nm;
}
export function validConfigName(name) {
  const nm = String(name ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(nm)) {
    throw badSetting('config name may only contain letters, digits, underscores, and hyphens (max 64 chars)');
  }
  return nm;
}
export function validConfigBody(body) {
  const b = String(body ?? '');
  if (b.length > 100_000) throw badSetting('config body too large (max 100000 chars)');
  if (b.includes('\0')) throw badSetting('config body may not contain null bytes');
  return b;
}
