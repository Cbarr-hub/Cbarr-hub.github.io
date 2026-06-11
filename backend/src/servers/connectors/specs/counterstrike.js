// Counter-Strike 2 spec — image `joedwards32/cs2`.
//
// IMPORTANT MODEL DIFFERENCE: this image is ENV-DRIVEN at startup — map, mode,
// max-players, RCON password and the GSLT come from container environment
// variables (CS2_STARTMAP, CS2_GAMEALIAS, CS2_MAXPLAYERS, CS2_RCONPW,
// SRCDS_TOKEN, …) set in servers.compose.yml, NOT from an editable
// cs2server.cfg. There is no in-container file whose edit changes the boot
// config, and the scoped socket-proxy can't recreate the container with new env.
//
// So the split is:
//   - PERSISTENT boot defaults → servers.compose.yml env (edit + recreate).
//   - profile.apply            → pushes the profile LIVE via RCON to the running
//                                server (map/mode/hostname/extra cvars), NEVER a
//                                restart (a restart would just revert to the
//                                compose env). Effective immediately; reverts to
//                                the compose env on restart. profileGroups()
//                                carries an `apply: { mode:'live', … }` descriptor
//                                so the panel relabels the button ("Apply Live")
//                                and skips the reboot a file-based game would do.
//   - capture                  → env-driven boot config isn't readable back from
//                                the container, so capture returns the validated
//                                defaults (the editor is the source of truth).
// The DB-backed workshop catalog + config library + live RCON port over cleanly.

import { badSetting, MAP_NAME_RE } from '../../errors.js';
import { fetchItemTitle, fetchCollectionMaps } from '../../steam-workshop.js';

// joedwards32/cs2 install/cfg layout (image-dependent — validated on the host).
const CFG = '/home/steam/cs2-dedicated/game/csgo/cfg';
const RCON_BATCH_LIMIT = 1800;

// CS2 game-mode aliases (game_alias sets game_type+game_mode under the hood).
export const GAME_ALIASES = {
  competitive: 'Competitive',
  casual: 'Casual',
  deathmatch: 'Deathmatch',
  wingman: 'Wingman (2v2)',
};
export const LOADOUT_MODES = {
  normal: 'Normal',
  zeus_battle: 'Zeus Battle',
};

export const STOCK_FALLBACK = [
  'de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage',
  'de_nuke', 'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office',
];

// Live (RCON) curated actions. CS2 serves Source RCON on the game port (27015).
const CS_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'bunnyhop_on',   label: 'Bunnyhop On' },
  { key: 'bunnyhop_off',  label: 'Bunnyhop Off' },
  // Phase 2 presets. All ephemeral (RCON) — they revert on container restart.
  { key: 'warmup_end',       label: 'End Warmup' },
  { key: 'add_bot',          label: 'Add Bot' },
  { key: 'kick_bots',        label: 'Kick Bots', danger: true },
  { key: 'list_players',     label: 'List Players' },
  { key: 'knife_only',       label: 'Knife Only' },
  { key: 'zeus_battle',      label: 'Zeus Battle' },
  { key: 'infinite_ammo_on', label: 'Infinite Ammo On' },
  { key: 'infinite_ammo_off',label: 'Infinite Ammo Off' },
];
const CS_ACTION_CMDS = {
  restart_round: 'mp_restartgame 1',
  cheats_on:     'sv_cheats 1',
  cheats_off:    'sv_cheats 0',
  bunnyhop_on:   'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000',
  bunnyhop_off:  'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12',
  warmup_end:    'mp_warmup_end',
  add_bot:       'bot_add',
  kick_bots:     'bot_kick',
  list_players:  'status',
  knife_only:    'mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary ""; mp_t_default_secondary ""; mp_free_armor 0; mp_buy_allow_guns 0; mp_restartgame 1',
  zeus_battle:   'game_alias competitive; mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary weapon_taser; mp_t_default_secondary weapon_taser; mp_weapons_allow_zeus 1; mp_free_armor 0; mp_max_armor 0; mp_buy_allow_guns 0; mp_buy_allow_grenades 1; mp_startmoney 800; mp_maxmoney 16000; mp_restartgame 1',
  infinite_ammo_on:  'sv_cheats 1; sv_infinite_ammo 1',
  infinite_ammo_off: 'sv_infinite_ammo 0; sv_cheats 0',
};

function loadoutModeCmd(mode = 'normal') {
  if (mode === 'zeus_battle') return CS_ACTION_CMDS.zeus_battle;
  return '';
}

function gameAliasForProfile(s = {}) {
  return s.loadoutMode === 'zeus_battle' ? 'competitive' : s.gameMode;
}

export const MAX_RAW_CONFIG_CHARS = 16_000;
export const MAX_RAW_CONFIG_LINE_CHARS = 512;
export const MAX_HOSTNAME_CHARS = 128;

// Setting bot_quota 0 leaves any already-spawned bots in the server, so pair it with
// bot_kick to actually clear the round. Shared by the live `bots` slider and the
// Match-Rules profile apply so both paths emit the same combined command.
export function botQuotaCmd(n) {
  return Math.round(Number(n)) === 0 ? 'bot_quota 0; bot_kick' : `bot_quota ${Math.round(Number(n))}`;
}

// Structured, live-settable mp_/sv_/bot_ cvars (the "Match Rules" group). Pushed in
// profile.apply's live RCON batch; they revert to the compose env on restart.
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

// Tinkerer "Tweak" surface: the Match-Rules + Bots knobs flagged basic so the persona
// panel's Tweak mode shows just these (autoBalance + warmupTime stay in Full → Profiles).
// The Match Rules group mapper propagates the flag onto the rendered field objects.
const CS_BASIC = new Set(['maxRounds', 'roundTime', 'freezeTime', 'buyTime', 'startMoney', 'friendlyFire', 'overtime', 'botQuota', 'botDifficulty']);

// NOTE: maxPlayers is deliberately NOT a profile field. The joedwards32/cs2 image
// reads max-players from the container env (CS2_MAXPLAYERS), which Apply (live
// RCON) can't change and the app can't recreate the container to change — so a
// maxPlayers input would silently do nothing. It lives in servers.compose.yml env.
export function defaultProfileSettings() {
  const d = { map: 'de_dust2', gameMode: 'competitive', loadoutMode: 'normal', hostname: '', password: '', rawConfig: '' };
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
  if (!LOADOUT_MODES[s.loadoutMode ?? 'normal']) throw badSetting(`invalid loadout mode: ${s.loadoutMode}`);
  out.loadoutMode = s.loadoutMode ?? 'normal';
  const hostname = String(s.hostname ?? '');
  // Reject `;` too: hostname is pushed LIVE over RCON as `hostname "<value>"`, and
  // Source treats `;` as a console command separator even inside a quoted arg, so an
  // unescaped `;` would let a crafted name chain arbitrary cvars (RCON injection).
  if (/["\n\r;]/.test(hostname)) throw badSetting('server name may not contain quotes, semicolons, or newlines');
  if (hostname.length > MAX_HOSTNAME_CHARS) throw badSetting(`server name too long (max ${MAX_HOSTNAME_CHARS} chars)`);
  out.hostname = hostname;
  const password = String(s.password ?? '');
  if (/["\n\r;]/.test(password)) throw badSetting('server password may not contain quotes, semicolons, or newlines');
  if (password.length > 100) throw badSetting('server password too long (max 100 chars)');
  out.password = password;
  const raw = String(s.rawConfig ?? '');
  if (raw.length > MAX_RAW_CONFIG_CHARS) throw badSetting(`extra cvars too large (max ${MAX_RAW_CONFIG_CHARS} chars)`);
  if (raw.includes('\0')) throw badSetting('extra cvars may not contain null bytes');
  for (const line of raw.split(/\r?\n/)) {
    if (line.length > MAX_RAW_CONFIG_LINE_CHARS) {
      throw badSetting(`extra cvar lines must be ${MAX_RAW_CONFIG_LINE_CHARS} chars or shorter`);
    }
  }
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

// The Profiles editor groups (Map & Mode / Match Rules / Advanced). `mapOpts` is
// the spec-supplied <select> option list (stock + saved workshop maps).
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
          { key: 'map', label: 'Map', type: 'select', addWorkshop: true, addCollection: true, options: mapOpts, basic: true,
            help: 'Pick a stock map or a saved Workshop map (by name). Use “＋ Workshop Map” to add one by id, or “⤓ Import Collection” to pull every map from a Steam collection (names fetched automatically). A Workshop map overrides the stock map.' },
          { key: 'gameMode', label: 'Game Mode', type: 'select', basic: true,
            options: Object.entries(GAME_ALIASES).map(([value, label]) => ({ value, label })) },
          { key: 'loadoutMode', label: 'Loadout Mode', type: 'select', basic: true,
            options: Object.entries(LOADOUT_MODES).map(([value, label]) => ({ value, label })) },
        ],
      },
      {
        key: 'rules', title: 'Match Rules',
        fields: CS_CVAR_FIELDS.map((f) =>
          f.bool
            ? { key: f.key, label: f.label, type: 'bool', ...(CS_BASIC.has(f.key) ? { basic: true } : {}) }
            : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01, ...(CS_BASIC.has(f.key) ? { basic: true } : {}) }),
      },
      {
        key: 'advanced', title: 'Advanced',
        fields: [
          { key: 'hostname', label: 'Server Name', type: 'text', basic: true },
          { key: 'password', label: 'Server Password (blank = none)', type: 'text', basic: true },
          { key: 'rawConfig', label: 'Extra live RCON commands', type: 'textarea',
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
  if (b.length > MAX_RAW_CONFIG_CHARS) throw badSetting(`config body too large (max ${MAX_RAW_CONFIG_CHARS} chars)`);
  if (b.includes('\0')) throw badSetting('config body may not contain null bytes');
  for (const line of b.split(/\r?\n/)) {
    if (line.length > MAX_RAW_CONFIG_LINE_CHARS) {
      throw badSetting(`config lines must be ${MAX_RAW_CONFIG_LINE_CHARS} chars or shorter`);
    }
  }
  return b;
}

// Steam Workshop titles are free-text (quotes, newlines, arbitrary length); the
// catalog stores short display names, so coerce an auto-fetched title into one.
const sanitizeAutoName = (title, id) =>
  String(title ?? '').replace(/["\r\n]/g, '').trim().slice(0, 64) || `Workshop ${id}`;

function rawConfigCommands(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
}

// Pack the ordered command list into the fewest "a; b; c" batches that each stay
// within RCON_BATCH_LIMIT chars, preserving order (so profile.apply's map-change
// stays LAST). `len` tracks the actual joined length: the first command in a
// batch adds its bare length, each subsequent one adds 2 ("; ") + its length;
// the flush check predicts the post-append length before committing. A single
// command over the limit throws (it can't be split). One await per batch in the
// caller means any RCON rejection (auth/timeout/connection) propagates.
function rconBatches(commands) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const cmd of commands) {
    if (cmd.length > RCON_BATCH_LIMIT) {
      throw badSetting(`RCON command too large (max ${RCON_BATCH_LIMIT} chars)`);
    }
    const extra = cur.length ? 2 : 0; // "; "
    if (cur.length && len + extra + cmd.length > RCON_BATCH_LIMIT) {
      batches.push(cur.join('; '));
      cur = [];
      len = 0;
    }
    cur.push(cmd);
    len += (cur.length > 1 ? 2 : 0) + cmd.length;
  }
  if (cur.length) batches.push(cur.join('; '));
  return batches;
}

export const counterstrikeSpec = {
  id: 'counterstrike',

  configFiles: {
    'server.cfg':   `${CFG}/server.cfg`,
    'autoexec.cfg': `${CFG}/autoexec.cfg`,
  },

  rcon: {
    port: 'rconPort',
    portFallback: 27015,
    password: { env: 'CS2_RCON_PASSWORD' },
    gateReason: 'CS2_RCON_PASSWORD is not set',
  },

  live: {
    actions: CS_LIVE_ACTIONS,
    actionCmds: CS_ACTION_CMDS,
    // Range sliders — continuous cvars pushed via runLiveAction(key, value),
    // clamped to bounds. `strict`: a non-numeric value is an error, not a
    // default. Gravity is cheats-gated, so it auto-prefixes sv_cheats 1. These
    // map onto the same cvars as CS_CVAR_FIELDS but are ephemeral nudges
    // (Profiles Apply is the persistent path).
    controls: [
      { key: 'gravity',    label: 'Gravity',     min: 100, max: 2000,  step: 50,  default: 800, strict: true,
        cmd: (n) => `sv_cheats 1; sv_gravity ${Math.round(n)}` },
      { key: 'roundtime',  label: 'Round Time',  min: 1,   max: 60,    step: 1,   default: 2, suffix: 'min', strict: true,
        cmd: (n) => `mp_roundtime_defuse ${n}; mp_roundtime ${n}` },
      { key: 'startmoney', label: 'Start Money', min: 0,   max: 16000, step: 500, default: 800, strict: true,
        cmd: (n) => `mp_startmoney ${Math.round(n)}; mp_maxmoney 16000` },
      { key: 'bots',       label: 'Bot Count',   min: 0,   max: 10,    step: 1,   default: 0, strict: true,
        cmd: (n) => botQuotaCmd(n) },
    ],
    changeMapCmd: buildChangeMapCmd,
    commandHint: 'any CS2 console command, e.g. bot_add, mp_warmup_end',
  },

  profile: {
    defaults() { return defaultProfileSettings(); },
    validate(conn, s) { return validateProfileSettings(s); },

    async schema(conn) {
      const catalog = conn.store ? conn.store.listWorkshopMaps(conn.server.id) : [];
      const mapOpts = [
        ...STOCK_FALLBACK.map((m) => ({ value: m, label: m })),
        ...catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),
      ];
      return profileGroups(mapOpts,
        'A Workshop map overrides a stock map. NOTE: for the container, Apply pushes settings LIVE via RCON; ' +
        'persistent boot defaults (map/mode/max-players) live in servers.compose.yml env.');
    },

    // Apply the profile LIVE via RCON (ordered, batched). Persistent boot config
    // is the compose env — documented in the returned note.
    async apply(conn, settings) {
      const s = validateProfileSettings(settings);
      const parts = [];
      if (s.hostname) parts.push(`hostname "${s.hostname}"`);
      parts.push(`sv_password "${s.password}"`);
      parts.push(`game_alias ${gameAliasForProfile(s)}`);
      // Structured Match-Rules cvars (bools as 0/1). Pushed before the map change so
      // mp_roundtime_defuse etc. bite on the reload the changelevel/host_workshop_map triggers.
      for (const f of CS_CVAR_FIELDS) {
        const value = f.bool ? (s[f.key] ? 1 : 0) : s[f.key];
        parts.push(f.cvar === 'bot_quota' ? botQuotaCmd(value) : `${f.cvar} ${value}`);
      }
      const loadout = loadoutModeCmd(s.loadoutMode);
      if (loadout) parts.push(loadout);
      parts.push(...rawConfigCommands(s.rawConfig));
      parts.push(buildChangeMapCmd(s.map)); // changelevel / host_workshop_map — LAST
      for (const batch of rconBatches(parts)) await conn.runRcon(batch);
      return {
        ok: true,
        note: 'Applied live via RCON. Max-players and persistent boot defaults live in servers.compose.yml env (edit + recreate the container to change them).',
      };
    },

    // Env-driven boot config isn't readable back from the container, so capture
    // returns the validated defaults (the profile editor is the source of truth).
    async capture() {
      return validateProfileSettings(defaultProfileSettings());
    },
  },

  // Profiles own the startup config (the Profiles panel), so getSettings exists
  // only to feed the Runtime panel's live change-map dropdown — the SAME shape
  // the GMOD-family connectors return: stock maps + the saved workshop catalog
  // (by name). Without this the dropdown is empty. The container's boot map is
  // env-driven (unreadable from a file), so `current` reflects the active
  // profile's saved map when there is one.
  async getSettings(conn) {
    const catalog = conn.store ? conn.store.listWorkshopMaps(conn.server.id) : [];
    let current = '';
    if (conn.store) {
      const activeId = conn.store.getActiveProfileId(conn.server.id);
      const active = activeId != null ? conn.store.getProfile(conn.server.id, activeId) : null;
      if (active?.settings?.map) current = active.settings.map;
    }
    return {
      game: 'counterstrike',
      map: {
        stock: STOCK_FALLBACK,
        workshop: catalog.map((w) => ({ id: w.workshopId, name: w.name })),
        current,
      },
    };
  },

  // The public join string must reflect the password a freshly-booted container
  // actually enforces — which is none. A profile's sv_password is only ever pushed
  // LIVE over RCON (profile.apply) and reverts on ANY restart; the compose env
  // (CS2_PW/unset) isn't readable through the scoped socket-proxy. Advertising
  // the saved profile password would tell joiners to enter one the server has
  // dropped, so always report "no password".
  connectPassword() {
    return '';
  },

  // ── workshop map catalog (DB-backed; transport-agnostic) ────────────────────
  // list/rename/delete are the store-backed engine generics (catalog + validMapName).
  catalog: true,
  validMapName,
  maps: {
    // Add one map. When `name` is omitted/blank the title is pulled from Steam
    // (keyless Workshop lookup); a user-supplied name is validated as before.
    async add(conn, { workshopId, name } = {}) {
      conn.requireStore();
      const id = String(workshopId ?? '').trim();
      if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop id must be 1–20 digits');
      const provided = String(name ?? '').trim();
      const nm = provided
        ? validMapName(provided)
        : sanitizeAutoName(await fetchItemTitle(id), id);
      return conn.store.addWorkshopMap(conn.server.id, { workshopId: id, name: nm });
    },
    // Import every item in a public Steam Workshop collection into the catalog,
    // names fetched automatically. Upserts (re-importing refreshes names), so it's
    // safe to run repeatedly. Returns the count processed + the refreshed catalog.
    async importCollection(conn, collectionId) {
      conn.requireStore();
      const maps = await fetchCollectionMaps(collectionId);
      if (!maps.length) throw badSetting('that Workshop collection has no items.');
      for (const m of maps) {
        conn.store.addWorkshopMap(conn.server.id, { workshopId: m.workshopId, name: sanitizeAutoName(m.name, m.workshopId) });
      }
      const catalog = conn.store.listWorkshopMaps(conn.server.id);
      // Unified collection-import shape (same as GMOD/PH so the panel renders identically).
      // CS catalogs live — selectable immediately, no restart needed.
      return {
        ok: true,
        imported: maps.length,
        maps: catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),
        requiresRestart: false,
        note: 'Imported into the live catalog — selectable immediately; Apply changes the running map over RCON.',
      };
    },
  },

  // ── config library (DB-backed; engine generics) ──────────────────────────────
  configLibrary: { validName: validConfigName, validBody: validConfigBody },

  // ── update the game client (SteamCMD app_update, in-container) ───────────────
  // joedwards32/cs2 ships SteamCMD; refresh the CS2 dedicated files in place, then
  // the panel restarts the container to run the new build. CS2 is Steam appid 730
  // (anonymous). Paths are image-specific — validated on the host.
  update: {
    kind: 'exec',
    argv: ['/bin/bash', '-lc',
      '/home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/cs2-dedicated +login anonymous +app_update 730 +quit'],
    timeoutMs: 1_800_000,
    stepName: 'steamcmd +app_update 730',
    note: 'CS2 files refreshed via SteamCMD — restart the server to run the new build.',
  },
};
