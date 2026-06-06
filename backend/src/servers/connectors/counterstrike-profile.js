// Pure Counter-Strike 2 profile/validation logic + curated RCON actions, shared
// by the base (LinuxGSM) and Docker connectors. Transport-agnostic: no file or
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

// Live (RCON) range sliders — continuous cvars pushed via runLiveAction(key, value),
// each clamped to its bounds in csRangeCmd. Gravity is cheats-gated, so it
// auto-prefixes sv_cheats 1. These map onto the same cvars as CS_CVAR_FIELDS but
// are ephemeral nudges (Profiles Apply is the persistent path).
export const CS_LIVE_CONTROLS = [
  { key: 'gravity',    label: 'Gravity',     min: 100, max: 2000,  step: 50,  default: 800 },
  { key: 'roundtime',  label: 'Round Time',  min: 1,   max: 60,    step: 1,   default: 2, suffix: 'min' },
  { key: 'startmoney', label: 'Start Money', min: 0,   max: 16000, step: 500, default: 800 },
  { key: 'bots',       label: 'Bot Count',   min: 0,   max: 10,    step: 1,   default: 0 },
];

// Build the RCON command for a live slider (value clamped to the control's bounds).
// Returns null for an unknown key so runLiveAction can fall through to actions.
export function csRangeCmd(key, value) {
  const ctl = CS_LIVE_CONTROLS.find((c) => c.key === key);
  if (!ctl) return null;
  let n = Number(value);
  if (!Number.isFinite(n)) throw badSetting(`invalid value for ${ctl.label}`);
  n = Math.min(ctl.max, Math.max(ctl.min, n));
  switch (key) {
    case 'gravity':    return `sv_cheats 1; sv_gravity ${Math.round(n)}`;
    case 'roundtime':  return `mp_roundtime_defuse ${n}; mp_roundtime ${n}`;
    case 'startmoney': return `mp_startmoney ${Math.round(n)}; mp_maxmoney 16000`;
    case 'bots':       return `bot_quota ${Math.round(n)}`;
    default:           return null;
  }
}

// Structured, live-settable mp_/sv_/bot_ cvars (the "Match Rules" group). Pushed in
// applyProfileSettings's live RCON batch; they revert to the compose env on restart.
// `bool` rows render as a checkbox (0/1); the rest as bounded numbers.
export const CS_CVAR_FIELDS = [
  { cvar: 'mp_maxrounds',        key: 'maxRounds',     label: 'Max Rounds',         def: 24,   min: 0,    max: 60,    int: true },
  { cvar: 'mp_roundtime_defuse', key: 'roundTime',     label: 'Round Time (min)',   def: 1.92, min: 0.25, max: 60 },
  { cvar: 'mp_freezetime',       key: 'freezeTime',    label: 'Freeze Time (s)',    def: 15,   min: 0,    max: 60,    int: true },
  { cvar: 'mp_buytime',          key: 'buyTime',       label: 'Buy Time (s)',       def: 20,   min: 0,    max: 120,   int: true },
  { cvar: 'mp_startmoney',       key: 'startMoney',    label: 'Start Money',        def: 800,  min: 0,    max: 16000, int: true },
  { cvar: 'mp_friendlyfire',     key: 'friendlyFire',  label: 'Friendly Fire',      def: 1,    min: 0,    max: 1,     int: true, bool: true },
  { cvar: 'mp_autoteambalance',  key: 'autoBalance',   label: 'Auto Team Balance',  def: 1,    min: 0,    max: 1,     int: true, bool: true },
  { cvar: 'mp_overtime_enable',  key: 'overtime',      label: 'Overtime',           def: 0,    min: 0,    max: 1,     int: true, bool: true },
  { cvar: 'mp_warmuptime',       key: 'warmupTime',    label: 'Warmup Time (s)',    def: 60,   min: 0,    max: 600,   int: true },
  { cvar: 'bot_quota',           key: 'botQuota',      label: 'Bots',               def: 0,    min: 0,    max: 64,    int: true },
  { cvar: 'bot_difficulty',      key: 'botDifficulty', label: 'Bot Difficulty',     def: 2,    min: 0,    max: 3,     int: true },
];

// NOTE: maxPlayers is deliberately NOT a profile field. The joedwards32/cs2 image
// reads max-players from the container env (CS2_MAXPLAYERS), which Apply (live
// RCON) can't change and the app can't recreate the container to change — so a
// maxPlayers input would silently do nothing. It lives in servers.compose.yml env.
export function defaultProfileSettings() {
  const d = { map: 'de_dust2', gameMode: 'competitive', hostname: '', rawConfig: '' };
  for (const f of CS_CVAR_FIELDS) d[f.key] = f.def;
  return d;
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
  const hostname = String(s.hostname ?? '');
  if (/["\n\r]/.test(hostname)) throw badSetting('server name may not contain quotes or newlines');
  out.hostname = hostname;
  const raw = String(s.rawConfig ?? '');
  if (raw.length > 100_000) throw badSetting('extra cvars too large (max 100000 chars)');
  if (raw.includes('\0')) throw badSetting('extra cvars may not contain null bytes');
  out.rawConfig = raw;
  // Structured Match-Rules cvars: bounded numbers (bools validate as 0/1 numbers).
  for (const f of CS_CVAR_FIELDS) {
    const n = Number(s[f.key] === undefined ? f.def : s[f.key]);
    if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
    if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
    if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
    out[f.key] = n;
  }
  return out;
}

// The Profiles editor groups (Map & Mode / Advanced). `mapOpts` is the
// connector-supplied <select> option list (stock + saved workshop maps).
//
// CS applies LIVE over RCON (not by restarting), so the schema carries an `apply`
// descriptor the panel uses to relabel the Apply button and skip the reboot a
// restart-based game would do (a restart would just revert to the compose env).
export function profileGroups(mapOpts, note) {
  return {
    groups: [
      {
        key: 'map', title: 'Map & Mode',
        fields: [
          { key: 'map', label: 'Map', type: 'select', addWorkshop: true, addCollection: true, options: mapOpts,
            help: 'Pick a stock map or a saved Workshop map (by name). Use “＋ Workshop Map” to add one by id, or “⤓ Import Collection” to pull every map from a Steam collection (names fetched automatically). A Workshop map overrides the stock map.' },
          { key: 'gameMode', label: 'Game Mode', type: 'select',
            options: Object.entries(GAME_ALIASES).map(([value, label]) => ({ value, label })) },
        ],
      },
      {
        key: 'rules', title: 'Match Rules',
        fields: CS_CVAR_FIELDS.map((f) =>
          f.bool
            ? { key: f.key, label: f.label, type: 'bool' }
            : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01 }),
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
    // Embedded cvar reference (autocomplete/docs for the Raw Config + Extra-cvars
    // editor). Built from CS_CVAR_FIELDS plus a few live-only knobs.
    cvarRef: [
      ...CS_CVAR_FIELDS.map((f) => ({
        name: f.cvar, type: f.bool ? 'bool' : 'number',
        default: f.def, min: f.min, max: f.max, group: 'Match Rules',
      })),
      { name: 'sv_gravity', type: 'number', default: 800, min: 100, max: 2000, help: 'needs sv_cheats 1', group: 'Live' },
      { name: 'sv_cheats',  type: 'bool',   default: 0,   group: 'Live' },
      { name: 'sv_autobunnyhopping',  type: 'bool', default: 0, help: 'needs sv_cheats 1', group: 'Live' },
      { name: 'sv_enablebunnyhopping', type: 'bool', default: 0, help: 'needs sv_cheats 1', group: 'Live' },
      { name: 'mp_maxmoney', type: 'number', default: 16000, min: 0, max: 65535, group: 'Match Rules' },
    ],
    apply: {
      mode: 'live',
      label: '▶ Apply Live',
      confirm: 'Apply this profile to the running server now (live, over RCON)?',
      note: 'Apply pushes Map · Mode · Server Name · Extra cvars to the running server instantly over RCON — no restart. These reset to the container defaults (servers.compose.yml env) on the next restart; Max Players also lives there.',
    },
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
