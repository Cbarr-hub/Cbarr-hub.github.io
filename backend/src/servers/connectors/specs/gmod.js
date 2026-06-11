// GMOD (TTT) spec — the LinuxGSM `gmodserver` container running terrortown.
// Also the shared home for the GMOD-family pieces specs/prophunt.js composes
// (path layout, gmad map machinery, slider rows, bhop/cheats strings,
// getSettings factory, connect-password lookup, update recipe).
// Settings live in the LinuxGSM instance cfg (gamemode/defaultmap/maxplayers/
// wscollectionid — the collection mounts at BOOT only), the game cfg
// (ttt_* cvars + rcon_password; +servercfgfile, NOT server.cfg), and
// mapcycle.txt; all take effect on restart. See CLAUDE.md § GMOD gotchas.

import { getVar, setVars, getCvar, setCvars } from '../../line-config.js';
import { badSetting, MAP_NAME_RE } from '../../errors.js';
import { fetchCollectionMaps } from '../../steam-workshop.js';

// ── shared GMOD-family layout (/data, LinuxGSM instance `gmodserver`) ──────────
const DATA = '/data';
const GARRYSMOD = `${DATA}/serverfiles/garrysmod`;
const LGSM = `${DATA}/lgsm/config-lgsm/gmodserver`;

export const GMOD_PATHS = {
  garrysmod:   GARRYSMOD,
  serverCfg:   `${GARRYSMOD}/cfg/gmodserver.cfg`,
  mapcycle:    `${GARRYSMOD}/mapcycle.txt`,
  mapsDir:     `${GARRYSMOD}/maps`,
  cacheSrcds:  `${GARRYSMOD}/cache/srcds`,
  instanceCfg: `${LGSM}/gmodserver.cfg`,
  commonCfg:   `${LGSM}/common.cfg`,
  // Workshop content lands in one of two spots depending on the downloader:
  // the legacy in-process cache (cache/srcds) OR the SteamCMD workshop path.
  steamWs:     `${DATA}/serverfiles/steam_cache/content/4000`,
  gmad:        `${DATA}/serverfiles/bin/gmad_linux`,
};

// The config-file whitelist both gamemodes share (PH adds its X2Z files on top).
export const GMOD_FAMILY_CONFIG_FILES = {
  'server.cfg':      GMOD_PATHS.serverCfg,
  'mapcycle.txt':    GMOD_PATHS.mapcycle,
  'lgsm.cfg':        GMOD_PATHS.instanceCfg,
  'lgsm-common.cfg': GMOD_PATHS.commonCfg,
};

// Maps that ship with the base install, so they're always loadable even with no
// workshop collection — the safe floor for defaults + the boot-map guard.
export const STOCK_ALWAYS = ['gm_construct', 'gm_flatgrass'];
export const TTT_DEFAULT_COLLECTION = '3736674438';
export const TTT_DEFAULT_MAPS = ['ttt_clue_se', 'ttt_diescraper', 'ttt_dolls', 'ttt_minecraft_b5', 'ttt_waterworld'];

// Discoverable map-name prefixes (PH uses ph_/gm_ — see specs/prophunt.js).
const TTT_PREFIXES = ['ttt_', 'gm_'];

// ── shared map machinery (gmad extraction; parameterized by mapPrefixes) ───────

// The SINGLE source of truth for available maps: installed .bsp files under
// garrysmod/maps/ — collection maps appear only once syncMaps() extracts them.
export async function installedMaps(conn, mapPrefixes) {
  try {
    // List basenames of the installed .bsp files (strip dir + extension via sed).
    const res = await conn.runShell(
      `ls -1 ${GMOD_PATHS.mapsDir}/*.bsp 2>/dev/null | sed -E 's#.*/##; s#\\.bsp$##' | sort -u`,
      { timeoutMs: 15_000 },
    );
    // Keep only this gamemode's prefixes so an unrelated bsp can't appear in the
    // picker; any failure (dir missing, exec error) degrades to an empty list.
    const escapeRe = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(${mapPrefixes.map(escapeRe).join('|')})[a-z0-9_]+$`);
    const names = (res.stdout || '').split('\n')
      .map((l) => l.trim())
      .filter((n) => re.test(n));
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

// Extract every downloaded .gma's maps/*.bsp into garrysmod/maps/ (the dir
// installedMaps reads). Scans BOTH download spots (cache/srcds + steam_cache);
// a packed .bsp is self-contained, so it loads with no mount. Idempotent (cp -n).
export async function syncMaps(conn, mapPrefixes) {
  const P = GMOD_PATHS;
  const script = [
    'tmp=$(mktemp -d) || exit 1',
    `for g in ${P.cacheSrcds}/*.gma ${P.steamWs}/*/*.gma; do`,
    '  [ -e "$g" ] || continue',
    `  rm -rf "$tmp/x"; "${P.gmad}" extract -file "$g" -out "$tmp/x" >/dev/null 2>&1 || continue`,
    `  find "$tmp/x" -name '*.bsp' -exec cp -n {} ${P.mapsDir}/ ';'`,
    'done',
    'rm -rf "$tmp"',
  ].join('\n');
  await conn.runShell(script, { timeoutMs: 300_000 });
  return { ok: true, maps: await installedMaps(conn, mapPrefixes) };
}

// Collection import (same POST route as CS2). Mount is boot-only, so this writes
// the id for the NEXT restart, best-effort syncs already-downloaded .gma, and
// returns the member titles (advisory) + requiresRestart:true.
export async function importCollection(conn, mapPrefixes, collectionId) {
  const id = String(collectionId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop collection id must be digits');

  // 1) Persist the collection id into the instance cfg so the NEXT boot mounts it.
  let inst = (await conn.client.fileRead(conn.vmid, GMOD_PATHS.instanceCfg)).content ?? '';
  inst = setVars(inst, { wscollectionid: id });
  await conn.client.fileWrite(conn.vmid, GMOD_PATHS.instanceCfg, inst);

  // 2) Best-effort: extract any already-downloaded .gma into maps/ (no-op pre-restart).
  await syncMaps(conn, mapPrefixes).catch(() => {});

  // 3) Member titles for display (keyless). These are Workshop titles, not bsp
  //    names — informational only (private/empty collections just skip).
  let members = [];
  try { members = await fetchCollectionMaps(id); } catch { /* private/empty → skip */ }
  const installed = await installedMaps(conn, mapPrefixes);

  return {
    ok: true,
    imported: installed.length,
    maps: installed.map((m) => ({ value: m, label: m })),
    members: members.map((m) => ({ id: m.workshopId, title: m.name })), // advisory
    requiresRestart: true,
    note: `Collection ${id} set. Restart Hosting so Steam downloads + mounts it, then “Sync from Collection” to install its maps.`,
  };
}

// ── shared quick-settings feed (the Runtime panel's live change-map dropdown) ──
// Profiles own the startup config; this only feeds the loadable map list.
export function makeGmodGetSettings({ mapPrefixes, knownCollectionMaps = [] }) {
  return async function getSettings(conn) {
    const [inst, maps] = await Promise.all([
      conn.fileText(GMOD_PATHS.instanceCfg),
      installedMaps(conn, mapPrefixes),
    ]);
    const defaultMap = (getVar(inst, 'defaultmap') || '').trim();
    const stock      = maps.filter((m) => STOCK_ALWAYS.includes(m));
    const collection = [...new Set([...maps.filter((m) => !STOCK_ALWAYS.includes(m)), ...knownCollectionMaps])].sort();
    return {
      game: conn.server.id,
      map: { stock: stock.length ? stock : STOCK_ALWAYS, collection, workshop: [], current: defaultMap },
    };
  };
}

// Join-string password: the game cfg's sv_password (blank = none).
export async function gmodConnectPassword(conn) {
  const game = await conn.fileText(GMOD_PATHS.serverCfg);
  return (getCvar(game, 'sv_password') || '').trim();
}

// ── shared live-control pieces ─────────────────────────────────────────────────

// Build the live change-map command, validating the map name (lowercase a-z0-9_).
// changelevel only reaches maps mounted at the last boot — see CLAUDE.md § GMOD workshop.
export function changeMapCmd(value) {
  const v = String(value ?? '').trim();
  if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
  return `changelevel ${v}`;
}

// GMOD has NO sv_autobunnyhopping/sv_enablebunnyhopping (CS2-only; validated live —
// "Unknown command"); the honest bhop is sv_airaccelerate air control (12 ≈ default).
export const GMOD_BHOP_CMDS = {
  bhop_on:  'sv_cheats 1; sv_airaccelerate 1000',
  bhop_off: 'sv_airaccelerate 12',
};
export const GMOD_CHEATS_CMDS = {
  cheats_on:  'sv_cheats 1',
  cheats_off: 'sv_cheats 0',
};

// Shared live sliders. `strict` clamp semantics: non-numeric throws badSetting
// instead of defaulting; finite values still clamp to [min,max]. Intentionally NO
// player-speed slider: hl2_normspeed is HL2-only (validated live), sv_maxspeed
// only caps — TTT/PH set speed in gamemode Lua.
export const GMOD_FAMILY_CONTROLS = [
  { key: 'gravity',   label: 'Gravity',    min: 0,    max: 1000, step: 25,   default: 600, suffix: '',  strict: true,
    cmd: (n) => `sv_gravity ${Math.round(n)}` },
  { key: 'timescale', label: 'Game Speed', min: 0.25, max: 3,    step: 0.25, default: 1,   suffix: '×', strict: true,
    cmd: (n) => `sv_cheats 1; host_timescale ${n}` },
];

// Update via LinuxGSM in-container; the panel restarts to run the new build.
export const GMOD_UPDATE = {
  kind: 'exec',
  argv: ['/bin/bash', '-lc', `${DATA}/gmodserver update`],
  timeoutMs: 1_800_000,
  stepName: 'gmodserver update',
  note: 'Game files updated via LinuxGSM — restart the server to run the new build.',
};

// ── TTT live control (Source RCON on the game port) ────────────────────────────

// Curated actions — genuinely binary toggles + instant commands; numeric-range
// pairs (gravity / timescale) render as sliders instead.
const TTT_LIVE_ACTIONS = [
  { key: 'restart_round', label: 'Restart Round' },
  { key: 'cleanup',       label: 'Clean Up Props' },
  { key: 'bhop_on',       label: 'Bunnyhop On' },
  { key: 'bhop_off',      label: 'Bunnyhop Off' },
  { key: 'alltalk_on',    label: 'All-talk On' },
  { key: 'alltalk_off',   label: 'All-talk Off' },
  { key: 'cheats_on',     label: 'Cheats On' },
  { key: 'cheats_off',    label: 'Cheats Off' },
  { key: 'players',       label: 'List Players' },
];
const TTT_ACTION_CMDS = {
  restart_round: 'ttt_roundrestart',
  cleanup:       'gmod_admin_cleanup',
  ...GMOD_BHOP_CMDS,
  alltalk_on:    'sv_alltalk 1',
  alltalk_off:   'sv_alltalk 0',
  ...GMOD_CHEATS_CMDS,
  players:       'status',
};

// Shared sliders + TTT next-round tuning (takes effect next round, not mid-round).
const TTT_LIVE_CONTROLS = [
  ...GMOD_FAMILY_CONTROLS,
  { key: 'traitor_pct', label: 'Traitor Ratio', min: 0.05, max: 0.5, step: 0.01, default: 0.25, suffix: '', strict: true,
    cmd: (n) => `ttt_traitor_pct ${n}` },
  { key: 'round_limit', label: 'Rounds/Map',    min: 1,    max: 15,  step: 1,    default: 6,    suffix: '', strict: true,
    cmd: (n) => `ttt_round_limit ${Math.round(n)}` },
];

// ── TTT profile (the whole startup config) ─────────────────────────────────────

// TTT cvar field table — defaults/validate/schema/apply/capture all iterate this
// one list. pct fields are 0..1 fractions; `bool` rows are 0/1 toggles.
const TTT_FIELDS = [
  { cvar: 'ttt_round_limit',          key: 'roundLimit',     label: 'Rounds per Map',        def: 6,    min: 1,  max: 100,  int: true,             group: 'round' },
  { cvar: 'ttt_time_limit_minutes',   key: 'timeLimit',      label: 'Time Limit (min)',      def: 75,   min: 1,  max: 600,  int: true,             group: 'round' },
  { cvar: 'ttt_preptime_seconds',     key: 'prepTime',       label: 'Prep Time (s)',         def: 30,   min: 5,  max: 120,  int: true,             group: 'round' },
  { cvar: 'ttt_haste',                key: 'haste',          label: 'Haste Mode',            def: 1,    min: 0,  max: 1,    int: true, bool: true, group: 'round' },
  { cvar: 'ttt_haste_starting_minutes', key: 'hasteStart',   label: 'Haste Start (min)',     def: 5,    min: 1,  max: 20,   int: true,             group: 'round' },
  { cvar: 'ttt_postround_dm',         key: 'postroundDm',    label: 'Post-round Deathmatch',  def: 0,    min: 0,  max: 1,    int: true, bool: true, group: 'round' },
  { cvar: 'sv_alltalk',               key: 'allTalk',        label: 'All-talk Voice',         def: 1,    min: 0,  max: 1,    int: true, bool: true, group: 'round' },
  { cvar: 'ttt_traitor_pct',          key: 'traitorPct',     label: 'Traitor Ratio (0–1)',   def: 0.25, min: 0,  max: 1,                           group: 'roles' },
  { cvar: 'ttt_traitor_max',          key: 'traitorMax',     label: 'Max Traitors',          def: 32,   min: 1,  max: 64,   int: true,             group: 'roles' },
  { cvar: 'ttt_detective_pct',        key: 'detectivePct',   label: 'Detective Ratio (0–1)', def: 0.13, min: 0,  max: 1,                           group: 'roles' },
  { cvar: 'ttt_detective_max',        key: 'detectiveMax',   label: 'Max Detectives',        def: 32,   min: 1,  max: 64,   int: true,             group: 'roles' },
  { cvar: 'ttt_detective_min_players', key: 'detMinPlayers', label: 'Min Players for Det.',  def: 5,    min: 0,  max: 32,   int: true,             group: 'roles' },
  { cvar: 'ttt_minimum_players',      key: 'minPlayers',     label: 'Min Players to Start',  def: 2,    min: 1,  max: 64,   int: true,             group: 'roles' },
  { cvar: 'ttt_credits_starting',     key: 'creditsStart',   label: 'Starting Credits',      def: 2,    min: 0,  max: 8,    int: true,             group: 'roles' },
  { cvar: 'ttt_karma',                key: 'karma',          label: 'Karma System',          def: 1,    min: 0,  max: 1,    int: true, bool: true, group: 'roles' },
  { cvar: 'ttt_karma_low_autokick',   key: 'karmaAutokick',  label: 'Karma Autokick',        def: 0,    min: 0,  max: 1,    int: true, bool: true, group: 'roles' },
  { cvar: 'ttt_karma_low_ban',        key: 'karmaBan',       label: 'Karma Auto-ban',        def: 0,    min: 0,  max: 1,    int: true, bool: true, group: 'roles' },
];

// `basic` flags: the knobs the panel's Tweak mode shows (the rest stay in Full).
const TTT_BASIC = new Set(['roundLimit', 'prepTime', 'haste', 'traitorPct', 'detMinPlayers', 'minPlayers', 'creditsStart', 'karma']);

function tttDefaults() {
  // The server boots into the FIRST map of the rotation; the known collection
  // maps are the safe default rotation (workshop maps need a collection).
  const d = {
    maxPlayers: 16, workshopCollection: TTT_DEFAULT_COLLECTION,
    useMapcycle: '1', mapcycle: [...TTT_DEFAULT_MAPS],
  };
  for (const f of TTT_FIELDS) d[f.key] = f.def;
  return d;
}

function tttValidate(s = {}) {
  const out = {};

  const mp = Number(s.maxPlayers);
  if (!Number.isInteger(mp) || mp < 1 || mp > 128) throw badSetting('maxPlayers must be 1–128');
  out.maxPlayers = mp;

  const coll = String(s.workshopCollection ?? '').trim();
  if (coll !== '' && !/^\d{1,20}$/.test(coll)) throw badSetting('workshop collection id must be digits');
  out.workshopCollection = coll;

  for (const f of TTT_FIELDS) {
    const n = Number(s[f.key]);
    if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
    if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
    if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
    out[f.key] = n;
  }

  out.useMapcycle = String(s.useMapcycle) === '0' ? '0' : '1';

  const raw = Array.isArray(s.mapcycle) ? s.mapcycle : String(s.mapcycle ?? '').split('\n');
  const cycle = raw.map((l) => String(l).trim()).filter((l) => l && !l.startsWith('//'));
  for (const l of cycle) if (!MAP_NAME_RE.test(l)) throw badSetting(`invalid map in cycle: ${l}`);
  out.mapcycle = cycle;

  return out;
}

async function tttSchema(conn) {
  const discovered = await installedMaps(conn, TTT_PREFIXES);
  // Stock fallbacks + discovered maps; combos (custom:true) let a collection map
  // be typed before its first download. Stock/Collection groups the builder UI.
  const mapOpts = [...new Set([...STOCK_ALWAYS, ...discovered, ...TTT_DEFAULT_MAPS])].map((m) => ({
    value: m, label: m, group: STOCK_ALWAYS.includes(m) ? 'Stock' : 'Collection',
  }));
  // bool rows render as switches, numeric rows as bounded inputs; the per-row
  // `group` tag is advisory (round vs roles) within the single flat Gameplay group.
  const numField = (f) => f.bool
    ? { key: f.key, label: f.label, type: 'bool', group: f.group, ...(TTT_BASIC.has(f.key) ? { basic: true } : {}) }
    : { key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01, group: f.group, ...(TTT_BASIC.has(f.key) ? { basic: true } : {}) };

  return {
    groups: [
      {
        key: 'map', title: 'Maps & Rotation',
        fields: [
          { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text', basic: true,
            placeholder: 'Steam Workshop collection id',
            help: 'Steam stores & manages these maps. Set this, build the rotation, then Apply — that restarts the server so Steam downloads the collection.' },
          { key: 'syncMaps', label: 'Workshop Maps', type: 'mapsync', basic: true,
            help: 'Added a map to the collection? Restart Hosting to download it, then Sync to install it into the list below.' },
          { key: 'mapcycle', label: 'Map Rotation', type: 'maplist', custom: true, basic: true, options: mapOpts,
            help: 'The server boots into the FIRST map and (with auto-rotate on) advances down the list after each round/time limit. Type collection map names; gm_construct is the always-available fallback.' },
          { key: 'useMapcycle', label: 'Auto-rotate through the rotation', type: 'bool', basic: true },
        ],
      },
      {
        key: 'gameplay', title: 'Gameplay',
        fields: [
          { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1, basic: true },
          ...TTT_FIELDS.map(numField),
        ],
      },
    ],
    note: 'A profile is the startup config the server boots as. Apply saves it and restarts the server (which downloads + mounts your Workshop collection). Maps come from the collection; gm_construct is the always-available fallback.',
    // Embedded cvar reference for the Raw Config tab (same TTT_FIELDS table).
    cvarRef: TTT_FIELDS.map((f) => ({
      name: f.cvar, type: f.bool ? 'bool' : 'number', default: f.def,
      ...(f.bool ? {} : { min: f.min, max: f.max }), group: f.group,
    })).concat([
      { name: 'ttt_always_use_mapcycle', type: 'bool', default: 1, help: 'rotate via mapcycle.txt' },
      { name: 'rcon_password', type: 'text', help: 'enables the Runtime panel' },
      { name: 'sv_cheats', type: 'bool', default: 0 },
    ]),
  };
}

// Apply only WRITES the startup files; the panel's Apply does the restart that
// re-reads them (and mounts the workshop collection). Capture is the inverse read.
async function tttApply(conn, settings, profileId) {
  const s = tttValidate(settings);
  const P = GMOD_PATHS;

  // Boot map = FIRST rotation entry (stock fallback if empty). One deduped list
  // drives the guard, the boot map, and the written rotation so they can't diverge.
  const rotation = [...new Set(s.mapcycle.length ? s.mapcycle : ['gm_construct'])];
  const bootMap = rotation[0];

  // Boot-map guard: with NO collection set, a workshop boot map mounts nothing and
  // bricks the boot ("no active map" — the exact brick we hit). Trust any map once
  // a collection is set.
  if (!s.workshopCollection) {
    const loadable = new Set([...(await installedMaps(conn, TTT_PREFIXES)), ...STOCK_ALWAYS]);
    const missing = rotation.filter((m) => !loadable.has(m));
    if (missing.length) {
      throw badSetting(
        `no Workshop Collection is set, so only stock maps can load (${[...loadable].sort().join(', ')}). ` +
        `These need a collection: ${missing.join(', ')}. Set a Workshop Collection ID to use workshop maps, ` +
        `then Restart Hosting once so Steam downloads them.`,
      );
    }
  }

  let inst = (await conn.client.fileRead(conn.vmid, P.instanceCfg)).content ?? '';
  inst = setVars(inst, {
    defaultmap: bootMap,
    maxplayers: String(s.maxPlayers),
    wscollectionid: s.workshopCollection,
    ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
  });
  await conn.client.fileWrite(conn.vmid, P.instanceCfg, inst);

  let game = (await conn.client.fileRead(conn.vmid, P.serverCfg)).content ?? '';
  const cvars = { ttt_always_use_mapcycle: s.useMapcycle };
  for (const f of TTT_FIELDS) cvars[f.cvar] = String(s[f.key]);
  game = setCvars(game, cvars);
  await conn.client.fileWrite(conn.vmid, P.serverCfg, game);

  await conn.client.fileWrite(conn.vmid, P.mapcycle, rotation.join('\n') + '\n');
  return { ok: true };
}

async function tttCapture(conn) {
  const P = GMOD_PATHS;
  const [game, inst, mapcycle] = await Promise.all([
    conn.fileText(P.serverCfg),
    conn.fileText(P.instanceCfg),
    conn.fileText(P.mapcycle),
  ]);
  const num = (cvar, def) => {
    const v = getCvar(game, cvar);
    return v === undefined || v === '' ? def : Number(v);
  };
  // Boot map stays the first rotation entry. Lowercase both: an out-of-band
  // mixed-case Workshop title would fail MAP_NAME_RE and make capture throw.
  const bootMap = (getVar(inst, 'defaultmap') || 'gm_construct').trim().toLowerCase();
  let cycle = mapcycle.replace(/\r/g, '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (cycle[0] !== bootMap) cycle = [bootMap, ...cycle.filter((m) => m !== bootMap)];

  const doc = {
    maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
    workshopCollection: (getVar(inst, 'wscollectionid') || '').trim(),
    useMapcycle: num('ttt_always_use_mapcycle', 1) ? '1' : '0',
    mapcycle: cycle,
  };
  for (const f of TTT_FIELDS) doc[f.key] = num(f.cvar, f.def);
  return tttValidate(doc);
}

// ── the spec ───────────────────────────────────────────────────────────────────

export const gmodSpec = {
  id: 'gmod',

  configFiles: GMOD_FAMILY_CONFIG_FILES,

  rcon: {
    port: 'port', // Source RCON listens on the game port (like CS2)
    password: { env: 'GMOD_RCON_PASSWORD' },
    gateReason: 'RCON disabled — set rcon_password in server.cfg and restart',
  },

  live: {
    actions: TTT_LIVE_ACTIONS,
    actionCmds: TTT_ACTION_CMDS,
    controls: TTT_LIVE_CONTROLS,
    changeMapCmd,
    commandHint: 'any GMOD/TTT console command, e.g. ttt_round_limit 5, changelevel ttt_…, status',
  },

  profile: {
    defaults: () => tttDefaults(),
    validate: (conn, s) => tttValidate(s),
    schema: (conn) => tttSchema(conn),
    apply: (conn, settings, profileId) => tttApply(conn, settings, profileId),
    capture: (conn) => tttCapture(conn),
  },

  maps: {
    sync: (conn) => syncMaps(conn, TTT_PREFIXES),
    importCollection: (conn, collectionId) => importCollection(conn, TTT_PREFIXES, collectionId),
  },

  getSettings: makeGmodGetSettings({ mapPrefixes: TTT_PREFIXES, knownCollectionMaps: TTT_DEFAULT_MAPS }),

  connectPassword: gmodConnectPassword,

  update: GMOD_UPDATE,
};
