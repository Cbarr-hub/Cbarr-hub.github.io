// Prop Hunt spec — a second LinuxGSM gmodserver container (port 27067) running
// the Prop Hunt: X2Z gamemode.
//
// Composes the shared GMOD-family pieces from specs/gmod.js (the /data layout,
// gmad map machinery, gravity/timescale slider rows, bhop/cheats strings, the
// change-map guard, getSettings/connectPassword, the LinuxGSM update recipe) —
// no class hierarchy. Differences from TTT:
//   - boots ONE ph_ map under gamemode="prop_hunt" (no rotation);
//   - content mounts from the public Workshop collection 3737190377 (the X2Z
//     gamemode ships the prop_hunt/base_phx folders + 7 ph_ maps + taunts + a
//     loadout manager); clients auto-download via the collection.
//   - X2Z gameplay tuning is mostly via the in-game X Menu (!phmenu), stored in
//     garrysmod/data/phx_data. Only a handful of real server cvars exist (below);
//     the panel exposes those + a Controls/Menus reference + the raw config editor.
//   - the game cfg execs cfg/gamertown/active.cfg last — the free-text rawConfig
//     escape hatch, re-execable live via the apply_config action.

import {
  GMOD_PATHS, GMOD_FAMILY_CONFIG_FILES, GMOD_FAMILY_CONTROLS, GMOD_BHOP_CMDS, GMOD_CHEATS_CMDS,
  GMOD_UPDATE, changeMapCmd, installedMaps, syncMaps, importCollection,
  makeGmodGetSettings, gmodConnectPassword,
} from './gmod.js';
import { getVar, setVars, getCvar, setCvars } from '../../line-config.js';
import { badSetting, MAP_NAME_RE } from '../../errors.js';

const GAMEMODE    = 'prop_hunt';
const COLLECTION  = '3737190377';   // public X2Z collection (gamemode + maps + extras)
const DEFAULT_MAP = 'ph_restaurant';

const PH_PREFIXES = ['ph_', 'gm_'];

// The managed config the game cfg execs last, holding the rawConfig body.
const ACTIVE_EXEC  = 'gamertown/active';
const ACTIVE_CFG   = `${GMOD_PATHS.garrysmod}/cfg/gamertown/active.cfg`;
const EXEC_LINE_RE = /^[ \t]*exec[ \t]+gamertown\/active[ \t]*$/m;

// Real X2Z server cvars (from the gamemode's CreateConVar). The typed-table shape
// mirrors TTT_FIELDS: `bool` rows are 0/1 toggles; numeric rows carry def/min/max
// (+int). default/validate/schema/apply/capture all iterate this one list, so a row
// is added in exactly one place. Round length / prop balance still also live in the
// in-game X Menu (!phmenu) → garrysmod/data/phx_data, but these cvars take effect.
const PH_CVARS = [
  // booleans:
  { cvar: 'fretta_waitforplayers',      key: 'waitForPlayers',  label: 'Wait for players before a round starts', def: 1, bool: true },
  { cvar: 'ph_enable_team_itemspawner', key: 'teamItemSpawner', label: 'Enable team item spawners',              def: 1, bool: true },
  { cvar: 'ph_swap_teams_every_round',  key: 'swapTeams',       label: 'Swap teams each round',                  def: 1, bool: true },
  { cvar: 'ph_enable_lucky_balls',      key: 'luckyBalls',      label: 'Lucky balls',                            def: 1, bool: true },
  { cvar: 'ph_freezecam',               key: 'freezecam',       label: 'Freeze-cam on death',                    def: 1, bool: true },
  { cvar: 'ph_kick_non_admin_access',   key: 'kickNonAdmin',    label: 'Kick non-admins who probe admin access', def: 0, bool: true },
  { cvar: 'phx_integrity_check',        key: 'integrityCheck',  label: 'Addon-conflict integrity check (keep on)', def: 1, bool: true },
  { cvar: 'phx_verbose',                key: 'verboseLog',      label: 'Verbose server logging',                 def: 0, bool: true },
  // numerics:
  { cvar: 'ph_round_time',              key: 'roundTime',       label: 'Round Time (s)',      def: 250, min: 60, max: 600, int: true },
  { cvar: 'ph_hunter_blindlock_time',  key: 'blindTime',       label: 'Hide Time (s)',       def: 30,  min: 10, max: 60,  int: true },
  { cvar: 'ph_rounds_per_map',          key: 'roundsPerMap',    label: 'Rounds per Map',      def: 10,  min: 1,  max: 20,  int: true },
  { cvar: 'ph_prop_jumppower',          key: 'propJump',        label: 'Prop Jump Power',     def: 1.4, min: 1,  max: 3 },
  { cvar: 'ph_hunter_fire_penalty',     key: 'firePenalty',     label: 'Hunter Fire Penalty', def: 10,  min: 0,  max: 25,  int: true },
];

// Tinkerer "Tweak" surface: the fun/practical Hunt Rules knobs flagged basic so the
// persona panel's Tweak mode shows just these (the rest stay in Full → Profiles).
const PH_BASIC = new Set(['waitForPlayers', 'swapTeams', 'luckyBalls', 'roundTime', 'blindTime', 'roundsPerMap', 'propJump']);

// Default controls + how to reach X2Z's in-game menus (shown read-only in the
// "Controls & In-Game Menus" config section). Commands verified from the gamemode.
const PH_CONTROLS = [
  { key: 'doc_xmenu',    label: 'X Menu (settings / admin)', help: 'Type !phmenu in chat, or bind a key to "ph_x_menu". Round & gameplay options live here.' },
  { key: 'doc_propmenu', label: 'Prop selection menu',       help: 'Type !propmenu, or the "ph_prop_menu" console command (prop locking / model picks).' },
  { key: 'doc_taunts',   label: 'Taunt menu',                help: 'Bind a key to "ph_showtaunts" to taunt on demand (auto/random taunts also fire per round).' },
  { key: 'doc_tp',       label: 'Toggle third-person',       help: 'Console command "ph_toggle_tp" — e.g. bind a key: bind p ph_toggle_tp' },
  { key: 'doc_rtv',      label: 'Rock the Vote (map change)', help: 'Players type !rtv (or "rtv_start"). Admins can force a map vote with "mv_start".' },
  { key: 'doc_unstuck',  label: 'Unstuck a prop',            help: 'Type !unstuck or !stuck in chat if a prop gets wedged in geometry.' },
  { key: 'doc_forceend', label: 'Force end the round (admin)', help: 'Type !phforceend in chat, or "ph_force_end_round" (also the Runtime → Next Round button).' },
  { key: 'doc_move',     label: 'Default movement',          help: 'WASD move · Space jump · Shift sprint · Ctrl crouch. Full prop controls + rotation binds are listed on the X Menu help page (F1).' },
];

// Live (RCON) curated actions — real X2Z console commands + the genuinely binary
// toggles. The gravity/timescale on-off pairs are sliders (GMOD_FAMILY_CONTROLS).
const PH_LIVE_ACTIONS = [
  { key: 'next_round',     label: 'Next Round' },
  { key: 'map_vote',       label: 'Start Map Vote' },
  { key: 'luckyballs_on',  label: 'Lucky Balls On' },
  { key: 'luckyballs_off', label: 'Lucky Balls Off' },
  { key: 'autotaunt_on',   label: 'Auto-taunt On' },
  { key: 'autotaunt_off',  label: 'Auto-taunt Off' },
  { key: 'bhop_on',        label: 'Bunnyhop On' },
  { key: 'bhop_off',       label: 'Bunnyhop Off' },
  { key: 'cheats_on',      label: 'Cheats On' },
  { key: 'cheats_off',     label: 'Cheats Off' },
  { key: 'apply_config',   label: 'Apply Config' },
  { key: 'players',        label: 'List Players' },
];
const PH_ACTION_CMDS = {
  next_round:     'ph_force_end_round',                               // X2Z: force-ends the round → next
  map_vote:       'mv_start',                                         // X2Z: start a map vote
  luckyballs_on:  'ph_enable_lucky_balls 1',
  luckyballs_off: 'ph_enable_lucky_balls 0',
  autotaunt_on:   'ph_autotaunt_enabled 1',
  autotaunt_off:  'ph_autotaunt_enabled 0',
  // bhop/cheats are identical to TTT — spread the shared strings from specs/gmod.js
  // so the air-control bhop note + values live in exactly one place.
  ...GMOD_BHOP_CMDS,
  ...GMOD_CHEATS_CMDS,
  apply_config:   `exec ${ACTIVE_EXEC}`,
  players:        'status',
};

// Live RANGE controls: the shared GMOD sliders (strict) plus two PH-specific
// next-round timers (round + hide time). The PH rows use the SOFT clamp (no
// `strict`): the engine's clampNumber means a literal 0 clamps to min and an
// empty/non-numeric value falls back to the row's default.
const PH_LIVE_CONTROLS = [
  ...GMOD_FAMILY_CONTROLS,
  { key: 'ph_round_time', label: 'Round Time', min: 60, max: 600, step: 10, default: 250, suffix: 's',
    cmd: (n) => `ph_round_time ${Math.round(n)}` },
  { key: 'ph_blind_time', label: 'Hide Time',  min: 10, max: 60,  step: 5,  default: 30,  suffix: 's',
    cmd: (n) => `ph_hunter_blindlock_time ${Math.round(n)}` },
];

const asBool = (v) => (v === 1 || v === '1' || v === true ? '1' : '0');

// ── PH profile (startup config) ────────────────────────────────────────────────

function phDefaults() {
  const d = { propHuntMap: DEFAULT_MAP, workshopCollection: COLLECTION, maxPlayers: 16, rawConfig: '' };
  for (const f of PH_CVARS) d[f.key] = f.bool ? asBool(f.def) : f.def;
  return d;
}

function phValidate(s = {}) {
  const out = {};

  const mp = Number(s.maxPlayers);
  if (!Number.isInteger(mp) || mp < 1 || mp > 128) throw badSetting('maxPlayers must be 1–128');
  out.maxPlayers = mp;

  const ph = String(s.propHuntMap ?? '').trim();
  if (ph !== '' && !MAP_NAME_RE.test(ph)) throw badSetting(`invalid Prop Hunt map: ${ph}`);
  out.propHuntMap = ph;

  const coll = String(s.workshopCollection ?? '').trim();
  if (coll !== '' && !/^\d{1,20}$/.test(coll)) throw badSetting('workshop collection id must be digits');
  out.workshopCollection = coll;

  for (const f of PH_CVARS) {
    if (f.bool) { out[f.key] = asBool(s[f.key] === undefined ? f.def : s[f.key]); continue; }
    const n = Number(s[f.key] === undefined ? f.def : s[f.key]);
    if (Number.isNaN(n) || n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
    if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
    out[f.key] = n;
  }

  const raw = String(s.rawConfig ?? '');
  if (raw.length > 100_000) throw badSetting('extra cvars too large (max 100000 chars)');
  if (raw.includes('\0')) throw badSetting('extra cvars may not contain null bytes');
  out.rawConfig = raw;

  return out;
}

async function phSchema(conn) {
  const discovered = await installedMaps(conn, PH_PREFIXES);
  const phMaps = [...new Set(discovered.filter((m) => m.startsWith('ph_')))];
  const mapOpts = phMaps.map((m) => ({ value: m, label: m }));
  const cvarField = (f) => f.bool
    ? { key: f.key, label: f.label, type: 'bool', ...(PH_BASIC.has(f.key) ? { basic: true } : {}) }
    : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.1, ...(PH_BASIC.has(f.key) ? { basic: true } : {}) };
  const infoField = (c) => ({ key: c.key, label: c.label, type: 'info', help: c.help });
  return {
    groups: [
      {
        key: 'map', title: 'Map & Workshop',
        fields: [
          { key: 'propHuntMap', label: 'Starting Map', type: 'select', options: mapOpts, basic: true,
            help: 'The ph_ map the server boots into (default ph_restaurant). Pick any installed map; change maps live in the Runtime panel.' },
          { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text',
            placeholder: '3737190377',
            readOnly: true,
            help: 'Read-only here: Apply does not rewrite the Prop Hunt collection, because changing it can break the X2Z mount. Use Import Collection or Raw Config when you intentionally need to change it.' },
          { key: 'syncMaps', label: 'Sync Maps', type: 'mapsync',
            help: 'Refresh the installed ph_ map list from the mounted collection (run after the collection changes + a restart).' },
          { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1, basic: true },
        ],
      },
      {
        key: 'x2z', title: 'X2Z Settings',
        fields: PH_CVARS.map(cvarField),
        note: 'Round timers, prop balance and toggles below are the server-side cvars. Taunt packs, loadouts and finer tuning still live in the in-game X Menu (!phmenu) — see Controls & In-Game Menus below.',
      },
      {
        key: 'controls', title: 'Controls & In-Game Menus',
        fields: PH_CONTROLS.map(infoField),
      },
      {
        key: 'advanced', title: 'Advanced',
        fields: [
          { key: 'rawConfig', label: 'Extra cvars (deployed as a live-execable config)', type: 'textarea',
            placeholder: 'phx_verbose 1\nsv_gravity 600' },
        ],
      },
    ],
    note: 'A profile is the startup config the server boots as (Prop Hunt: X2Z). The gamemode + maps mount from the Workshop collection. ',
    // Embedded cvar reference (autocomplete / inline docs for the Raw Config tab),
    // built from the same PH_CVARS table the profile renders/validates from.
    cvarRef: PH_CVARS.map((f) => ({
      name: f.cvar, type: f.bool ? 'bool' : 'number', default: f.def,
      ...(f.bool ? {} : { min: f.min, max: f.max }),
    })).concat([
      { name: 'ph_autotaunt_enabled', type: 'bool', default: 1, help: 'auto/random taunts each round' },
      { name: 'rcon_password', type: 'text', help: 'enables the Runtime panel' },
      { name: 'sv_cheats', type: 'bool', default: 0 },
      { name: 'sv_gravity', type: 'number', min: 0, max: 1000, default: 600 },
    ]),
  };
}

async function phApply(conn, settings, profileId) {
  const s = phValidate(settings);
  const P = GMOD_PATHS;

  if (!s.propHuntMap) throw badSetting('pick a starting map (e.g. ph_restaurant).');

  // NOTE: deliberately do NOT write wscollectionid here. Apply must not be able to
  // break the X2Z mount (an empty/changed collection bricks the gamemode boot) — the
  // collection id is managed only via importCollection / the Raw Config editor.
  let inst = (await conn.client.fileRead(conn.vmid, P.instanceCfg)).content ?? '';
  inst = setVars(inst, {
    gamemode: GAMEMODE,
    defaultmap: s.propHuntMap,
    maxplayers: String(s.maxPlayers),
    ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
  });
  await conn.client.fileWrite(conn.vmid, P.instanceCfg, inst);

  let game = (await conn.client.fileRead(conn.vmid, P.serverCfg)).content ?? '';
  const cvars = {};
  for (const f of PH_CVARS) cvars[f.cvar] = s[f.key];
  game = setCvars(game, cvars);
  if (!EXEC_LINE_RE.test(game)) game = game.replace(/\n*$/, '') + `\nexec ${ACTIVE_EXEC}\n`;
  await conn.client.fileWrite(conn.vmid, P.serverCfg, game);

  await conn.runShell(`mkdir -p "${P.garrysmod}/cfg/gamertown"`, { timeoutMs: 10_000 });
  await conn.client.fileWrite(conn.vmid, ACTIVE_CFG, s.rawConfig);
  return { ok: true };
}

async function phCapture(conn) {
  const P = GMOD_PATHS;
  const [game, inst, active] = await Promise.all([
    conn.fileText(P.serverCfg),
    conn.fileText(P.instanceCfg),
    conn.fileText(ACTIVE_CFG),
  ]);
  const doc = {
    // Lowercase like the TTT capture: a mixed-case Workshop title set as
    // defaultmap out-of-band would otherwise fail validate's lowercase-only
    // MAP_NAME_RE and make capture throw instead of snapshotting.
    propHuntMap: (getVar(inst, 'defaultmap') || DEFAULT_MAP).trim().toLowerCase(),
    workshopCollection: (getVar(inst, 'wscollectionid') || COLLECTION).trim(),
    maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
    rawConfig: active,
  };
  for (const f of PH_CVARS) {
    const v = getCvar(game, f.cvar);
    if (f.bool) { doc[f.key] = asBool(v === undefined || v === '' ? f.def : v); }
    else { doc[f.key] = v === undefined || v === '' ? f.def : Number(v); }
  }
  return phValidate(doc);
}

// ── the spec ───────────────────────────────────────────────────────────────────

export const prophuntSpec = {
  id: 'prophunt',

  // The shared GMOD set (game cfg `server.cfg`, instance cfg `lgsm.cfg`) plus the
  // live-execable extra-cvars file and X2Z's editable data files (weapon loadouts,
  // admin list). These open in the panel's Raw Config editor.
  configFiles: {
    ...GMOD_FAMILY_CONFIG_FILES,
    'active.cfg':  ACTIVE_CFG,
    'phx-loadout': `${GMOD_PATHS.garrysmod}/data/phx_data/swep_manager/loadoutinfo.txt`,
    'phx-admins':  `${GMOD_PATHS.garrysmod}/data/phx_data/admins.txt`,
  },

  rcon: {
    port: 'port', // Source RCON listens on the game port
    password: { env: 'PROPHUNT_RCON_PASSWORD' },
    gateReason: 'RCON disabled — set rcon_password in the game cfg and restart',
  },

  live: {
    actions: PH_LIVE_ACTIONS,
    actionCmds: PH_ACTION_CMDS,
    controls: PH_LIVE_CONTROLS,
    changeMapCmd,
    commandHint: 'any GMOD/X2Z console command, e.g. changelevel ph_office_fsg_v2, ph_force_end_round, mv_start, status',
  },

  profile: {
    defaults: () => phDefaults(),
    validate: (conn, s) => phValidate(s),
    schema: (conn) => phSchema(conn),
    apply: (conn, settings, profileId) => phApply(conn, settings, profileId),
    capture: (conn) => phCapture(conn),
  },

  maps: {
    sync: (conn) => syncMaps(conn, PH_PREFIXES),
    importCollection: (conn, collectionId) => importCollection(conn, PH_PREFIXES, collectionId),
  },

  getSettings: makeGmodGetSettings({ mapPrefixes: PH_PREFIXES }),

  connectPassword: gmodConnectPassword,

  update: GMOD_UPDATE,
};
