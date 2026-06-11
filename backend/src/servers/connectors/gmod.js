// Garry's Mod connector — LinuxGSM instance `gmodserver`, running the
// Trouble in Terrorist Town (terrortown) gamemode.
//
// This class also serves as the shared base for other GMOD-family gamemodes
// (e.g. Prop Hunt — see prophunt.js). To make it subclassable, install paths are
// derived from `this.gsmDir` via lazy getters (a frozen field would bake in the
// parent's dir), the discoverable-map name prefixes are an overridable
// `mapPrefixes`, and live RCON uses the registry game port (`this.server.port`).
// A subclass points `gsmDir` at its own instance and overrides the gamemode
// semantics (profile schema / apply / capture / live actions); the TTT specifics
// below stay here.
//
// Verified layout (the gmod container, LinuxGSM under /data) — see CLAUDE.md § Known gotchas (GMOD):
//   install dir : /home/miles/gmodserver   (owned by user `miles`)
//   control     : ./gmodserver start|stop|restart|update   (run as miles)
//
// Where TTT settings live (this is the whole game model):
//   instance cfg : lgsm/config-lgsm/gmodserver/gmodserver.cfg
//     gamemode="terrortown"          the gamemode (we keep this pinned)
//     defaultmap="ttt_…"             map the server boots into
//     maxplayers="<n>"               player slots
//     wscollectionid="<id>"          Steam Workshop COLLECTION — auto-downloads
//                                    all its maps/addons on (re)start
//   common cfg : lgsm/config-lgsm/gmodserver/common.cfg
//     rconpassword / gslt            (set out-of-band; not edited here)
//   game cfg : serverfiles/garrysmod/cfg/gmodserver.cfg   (Source cvars; launched
//              via `+servercfgfile gmodserver.cfg` — NOT a server.cfg)
//     ttt_round_limit / ttt_time_limit_minutes        when the map rotates
//     ttt_always_use_mapcycle 1                        rotate via mapcycle.txt
//     ttt_traitor_pct / ttt_traitor_max               traitor ratio + cap
//     ttt_detective_pct / ttt_detective_max           detective ratio + cap
//     ttt_minimum_players                              players needed to start
//     rcon_password                                    enables the Runtime panel
//   map rotation : serverfiles/garrysmod/mapcycle.txt  (one map name per line)
// All of the above apply on the next server restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVars, getCvar, setCvars } from '../line-config.js';
import { rconCommand, validateLiveCommand } from '../rcon.js';
import { badSetting, MAP_NAME_RE } from '../errors.js';
import { fetchCollectionMaps } from '../steam-workshop.js';

// Maps that ship with the base install, so they're always loadable even with no
// workshop collection — the safe floor for defaults + the boot-map guard.
const STOCK_ALWAYS = ['gm_construct', 'gm_flatgrass'];
export const TTT_DEFAULT_COLLECTION = '3736674438';
export const TTT_DEFAULT_MAPS = ['ttt_clue_se', 'ttt_diescraper', 'ttt_dolls', 'ttt_minecraft_b5', 'ttt_waterworld'];

// Live (RCON) curated actions — the genuinely BINARY toggles + instant commands
// that work in ANY GMOD gamemode (so TTT gets the same ones Prop Hunt offers; the
// X2Z-specific Next Round / Map Vote / Apply Config have no stock TTT equivalent,
// so they're left out). The on/off pairs that were really just two points on a
// numeric range (gravity / speed / timescale) now render as sliders — see
// GMOD_LIVE_CONTROLS below. The live change-map control is separate (changeMap).
export const GMOD_LIVE_ACTIONS = [
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
// Shared bhop/cheats toggle strings — identical across every GMOD-family gamemode
// (TTT, Prop Hunt). Exported so each connector's action map spreads in the same copy
// instead of duplicating the literals (the change leaked into PH_ACTION_CMDS too).
// GMOD's Source engine has NO sv_autobunnyhopping/sv_enablebunnyhopping (those are
// CS2-only) — validated live, they error "Unknown command". The honest GMOD bhop is
// loose air control via sv_airaccelerate (high = bhop-friendly; 12 ≈ default).
export const GMOD_BHOP_CMDS = {
  bhop_on:  'sv_cheats 1; sv_airaccelerate 1000',
  bhop_off: 'sv_airaccelerate 12',
};
export const GMOD_CHEATS_CMDS = {
  cheats_on:  'sv_cheats 1',
  cheats_off: 'sv_cheats 0',
};
export const GMOD_ACTION_CMDS = {
  restart_round: 'ttt_roundrestart',
  cleanup:       'gmod_admin_cleanup',
  ...GMOD_BHOP_CMDS,
  alltalk_on:    'sv_alltalk 1',
  alltalk_off:   'sv_alltalk 0',
  ...GMOD_CHEATS_CMDS,
  players:       'status',
};

// Live RANGE controls — cvars whose value is a continuous range, rendered as a
// slider in the Runtime panel. The connector turns the chosen value into the
// RCON command via gmodRangeCmd(). Shared by TTT + Prop Hunt (both srcds).
// NOTE: there is intentionally NO "player speed" control. GMOD has no server cvar
// for walk speed (hl2_normspeed is HL2-only → "Unknown command" here, validated live;
// sv_maxspeed only caps, and TTT/PH set speed in gamemode Lua), so a slider would be
// misleading. Game Speed (host_timescale) + gravity are the honest movement knobs.
export const GMOD_SHARED_LIVE_CONTROLS = [
  { key: 'gravity',     label: 'Gravity',       min: 0,    max: 1000, step: 25,   default: 600,  suffix: '' },
  { key: 'timescale',   label: 'Game Speed',    min: 0.25, max: 3,    step: 0.25, default: 1,    suffix: '×' },
];

export const TTT_LIVE_CONTROLS = [
  ...GMOD_SHARED_LIVE_CONTROLS,
  // TTT next-round tuning (takes effect on the next round, not mid-round).
  { key: 'traitor_pct', label: 'Traitor Ratio', min: 0.05, max: 0.5,  step: 0.01, default: 0.25, suffix: '' },
  { key: 'round_limit', label: 'Rounds/Map',    min: 1,    max: 15,   step: 1,    default: 6,    suffix: '' },
];

// Back-compat export for code that historically used this as the TTT control set.
export const GMOD_LIVE_CONTROLS = TTT_LIVE_CONTROLS;

// Build the RCON command for a range control's chosen value. timescale needs
// sv_cheats. Clamps to the control's bounds so an out-of-range value can't be injected.
export function gmodRangeCmd(key, value, controls = TTT_LIVE_CONTROLS) {
  const ctl = controls.find((c) => c.key === key);
  if (!ctl) return null;
  let n = Number(value);
  if (!Number.isFinite(n)) throw badSetting(`invalid value for ${ctl.label}`);
  n = Math.min(ctl.max, Math.max(ctl.min, n));
  switch (key) {
    case 'gravity':     return `sv_gravity ${Math.round(n)}`;
    case 'timescale':   return `sv_cheats 1; host_timescale ${n}`;
    case 'traitor_pct': return `ttt_traitor_pct ${n}`;
    case 'round_limit': return `ttt_round_limit ${Math.round(n)}`;
    default:            return null;
  }
}

// TTT cvar field specs (key in server.cfg, UI label, numeric bounds). pct fields
// are 0..1 fractions; the rest are integers; `bool` rows are 0/1 toggles the UI
// renders as switches. `group` tags partition the panel into two readable groups.
// Kept as data so getSettings builds the panel and setSettings validates from one
// source (the data-table pattern — apply/capture/validate all iterate this list).
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

// Tinkerer "Tweak" surface: the high-value TTT knobs flagged basic so the persona
// panel's Tweak mode shows just these (the rest stay in Full → Profiles). numField
// propagates the flag onto the rendered field objects.
const TTT_BASIC = new Set(['roundLimit', 'prepTime', 'haste', 'traitorPct', 'detMinPlayers', 'minPlayers', 'creditsStart', 'karma']);

export class GmodConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = '/home/miles/gmodserver';
  gsmScript = 'gmodserver';

  // The Source game-config basename, launched via `+servercfgfile`. NOT a server.cfg.
  gameCfgName = 'gmodserver.cfg';
  // Discoverable map-name prefixes (a subclass overrides, e.g. ph_ for Prop Hunt).
  mapPrefixes = ['ttt_', 'gm_'];

  knownCollectionMaps() {
    return this.server.id === 'gmod' ? TTT_DEFAULT_MAPS : [];
  }

  defaultWorkshopCollection() {
    return this.server.id === 'gmod' ? TTT_DEFAULT_COLLECTION : '';
  }

  // Install paths, derived from gsmDir so a subclass with a different instance dir
  // gets the right paths (lazy getter — a field would freeze the parent's gsmDir).
  get paths() {
    const dir = this.gsmDir;
    const garrysmod = `${dir}/serverfiles/garrysmod`;
    const lgsm = `${dir}/lgsm/config-lgsm/${this.gsmScript}`;
    return {
      garrysmod,
      serverCfg:   `${garrysmod}/cfg/${this.gameCfgName}`,
      mapcycle:    `${garrysmod}/mapcycle.txt`,
      mapsDir:     `${garrysmod}/maps`,
      cacheSrcds:  `${garrysmod}/cache/srcds`,
      instanceCfg: `${lgsm}/${this.gsmScript}.cfg`,
      commonCfg:   `${lgsm}/common.cfg`,
      // Workshop content lands in one of two spots depending on the downloader:
      // the legacy in-process cache (cache/srcds) OR the SteamCMD workshop path.
      steamWs:     `${dir}/serverfiles/steam_cache/content/4000`,
      gmad:        `${dir}/serverfiles/bin/gmad_linux`,
    };
  }

  get configFiles() {
    const P = this.paths;
    return {
      'server.cfg':      P.serverCfg,
      'mapcycle.txt':    P.mapcycle,
      'lgsm.cfg':        P.instanceCfg,
      'lgsm-common.cfg': P.commonCfg,
    };
  }

  // The SINGLE source of truth for available maps: installed .bsp files under
  // garrysmod/maps/ (stock gm_construct/gm_flatgrass + whatever syncMaps() has
  // extracted from the collection). No cache reconciliation — collection maps only
  // appear here once installed via syncMaps. Filtered by `mapPrefixes`.
  async installedMaps() {
    try {
      const P = this.paths;
      // List basenames of the installed .bsp files (strip dir + extension via sed).
      const res = await this.runShell(
        `ls -1 ${P.mapsDir}/*.bsp 2>/dev/null | sed -E 's#.*/##; s#\\.bsp$##' | sort -u`,
        { asUser: this.gsmUser, timeoutMs: 15_000 },
      );
      // Keep only maps whose name starts with one of this gamemode's prefixes
      // (ttt_/gm_ for TTT, ph_/gm_ for PH) so an unrelated bsp can't appear in the
      // picker. Names are lowercase a-z0-9_ (matches Source/GMOD bsp naming). Any
      // failure (dir missing, exec error) degrades to an empty list, never throws.
      const escapeRe = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^(${this.mapPrefixes.map(escapeRe).join('|')})[a-z0-9_]+$`);
      const names = (res.stdout || '').split('\n')
        .map((l) => l.trim())
        .filter((n) => re.test(n));
      return [...new Set(names)].sort();
    } catch {
      return [];
    }
  }

  // Install collection maps as the single source of truth. GMOD scatters downloaded
  // workshop content across two locations/formats — legacy addons as
  // cache/srcds/<id>.gma and modern ones as steam_cache/content/4000/<id>/*.gma — so
  // there is no single existing place with every map. syncMaps extracts each
  // downloaded map's maps/*.bsp into garrysmod/maps/ (the engine's canonical map
  // dir), which installedMaps() then reads as the ONE source. These TTT map addons
  // are self-contained (packed .bsp), so an extracted map loads with no mount
  // dependency. Idempotent (cp -n). Returns the refreshed installed-map list.
  async syncMaps() {
    const P = this.paths;
    const script = [
      'tmp=$(mktemp -d) || exit 1',
      `for g in ${P.cacheSrcds}/*.gma ${P.steamWs}/*/*.gma; do`,
      '  [ -e "$g" ] || continue',
      `  rm -rf "$tmp/x"; "${P.gmad}" extract -file "$g" -out "$tmp/x" >/dev/null 2>&1 || continue`,
      `  find "$tmp/x" -name '*.bsp' -exec cp -n {} ${P.mapsDir}/ ';'`,
      'done',
      'rm -rf "$tmp"',
    ].join('\n');
    await this.runShell(script, { asUser: this.gsmUser, timeoutMs: 300_000 });
    return { ok: true, maps: await this.installedMaps() };
  }

  // Unified Steam Workshop collection import (the same POST /:id/maps/collection
  // route CS2 uses). GMOD/PH can't live-mount an arbitrary collection — mount is
  // boot-only — so this: (1) writes the collection id into the instance cfg so the
  // NEXT restart downloads + mounts it, (2) best-effort syncs any already-downloaded
  // .gma into maps/ (a no-op pre-restart), and (3) returns the member titles (keyless,
  // advisory) plus requiresRestart:true. PropHuntConnector inherits this unchanged —
  // `this.paths`/`installedMaps` are subclass-derived, so it writes the PH cfg.
  async importCollection(collectionId) {
    const id = String(collectionId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop collection id must be digits');

    // 1) Persist the collection id into the instance cfg so the NEXT boot mounts it.
    const P = this.paths;
    let inst = (await this.client.fileRead(this.vmid, P.instanceCfg)).content ?? '';
    inst = setVars(inst, { wscollectionid: id });
    await this.client.fileWrite(this.vmid, P.instanceCfg, inst);

    // 2) Best-effort: extract any already-downloaded .gma into maps/ (no-op pre-restart).
    await this.syncMaps().catch(() => {});

    // 3) Member titles for display (keyless). These are Workshop titles, not bsp
    //    names — informational only (private/empty collections just skip).
    let members = [];
    try { members = await fetchCollectionMaps(id); } catch { /* private/empty → skip */ }
    const installed = await this.installedMaps();

    return {
      ok: true,
      imported: installed.length,
      maps: installed.map((m) => ({ value: m, label: m })),
      members: members.map((m) => ({ id: m.workshopId, title: m.name })), // advisory
      requiresRestart: true,
      note: `Collection ${id} set. Restart Hosting so Steam downloads + mounts it, then “Sync from Collection” to install its maps.`,
    };
  }

  // Profiles own the startup config (the Profiles panel). getSettings is kept only
  // to feed the Runtime panel's live change-map dropdown with the loadable maps.
  async getSettings() {
    const P = this.paths;
    const [inst, maps] = await Promise.all([
      this.client.fileRead(this.vmid, P.instanceCfg).then((r) => r.content ?? '').catch(() => ''),
      this.installedMaps(),
    ]);
    const defaultMap = (getVar(inst, 'defaultmap') || '').trim();
    const stock      = maps.filter((m) => STOCK_ALWAYS.includes(m));
    const collection = [...new Set([...maps.filter((m) => !STOCK_ALWAYS.includes(m)), ...this.knownCollectionMaps()])].sort();
    return {
      game: this.server.id,
      // Stock vs collection maps as separate groups so the live change-map shows
      // two categories. GMOD maps are plain bsp names (no ws: ids).
      map: { stock: stock.length ? stock : STOCK_ALWAYS, collection, workshop: [], current: defaultMap },
    };
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // A GMOD profile is the whole TTT startup config: starting map + ordered
  // rotation, the ttt_* gameplay cvars, player slots, and the workshop collection.
  // applyProfile writes them across the instance cfg (defaultmap / maxplayers /
  // wscollectionid + the gt_active_profile mirror), the game cfg (ttt_* +
  // ttt_always_use_mapcycle), and mapcycle.txt. applyProfileSettings only WRITES
  // those files — none of it is live; the restart that re-reads them (and downloads +
  // mounts the workshop collection) is the panel's "Apply = apply config + restart"
  // step, NOT something this method does. captureProfileSettings is the inverse read.

  defaultProfileSettings() {
    // The server boots into the FIRST map of the rotation; default it to a stock
    // map that always exists (TTT runs fine on it). Workshop maps need a collection.
    const d = {
      maxPlayers: 16, workshopCollection: this.defaultWorkshopCollection(),
      useMapcycle: '1', mapcycle: this.knownCollectionMaps().length ? [...this.knownCollectionMaps()] : ['gm_construct'],
    };
    for (const f of TTT_FIELDS) d[f.key] = f.def;
    return d;
  }

  validateProfileSettings(s = {}) {
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

  async profileSchema() {
    const discovered = await this.installedMaps();
    // Always offer the stock fallback maps (gm_construct/gm_flatgrass), plus what
    // the collection has downloaded. The map fields are combos (custom:true) so a
    // collection map can be typed as the start map even before its first download.
    // Tag each map Stock vs Collection so the rotation builder shows two groups.
    const mapOpts = [...new Set([...STOCK_ALWAYS, ...discovered, ...this.knownCollectionMaps()])].map((m) => ({
      value: m, label: m, group: STOCK_ALWAYS.includes(m) ? 'Stock' : 'Collection',
    }));
    // bool rows render as switches; numeric rows as bounded number inputs. The
    // `group` tag on each TTT_FIELDS row is advisory metadata (round vs roles) the
    // panel can use to sub-head the list; the schema keeps the single Gameplay group
    // so the field order stays one flat, predictable list.
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
      // Embedded cvar reference (autocomplete / inline docs for the Raw Config tab),
      // built from the same TTT_FIELDS table the profile renders/validates from.
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

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);
    const P = this.paths;

    // The server boots into the FIRST map of the rotation (stock fallback if the
    // rotation is somehow empty). One ordered list drives both boot + rotation.
    // De-dup (order-preserving): a repeated entry would write a no-op map change
    // into mapcycle.txt. This single deduped list drives the boot-map guard, the
    // boot map, and the written rotation so they can't diverge.
    const rotation = [...new Set(s.mapcycle.length ? s.mapcycle : ['gm_construct'])];
    const bootMap = rotation[0];

    // Boot-map guard. With NO workshop collection set, only stock maps can load —
    // a workshop map mounts nothing and leaves the server with "no active map"
    // (the exact brick we hit). Block that; trust any map once a collection is set
    // (GMOD downloads + mounts it at boot before loading the map).
    if (!s.workshopCollection) {
      const loadable = new Set([...(await this.installedMaps()), ...STOCK_ALWAYS]);
      const missing = rotation.filter((m) => !loadable.has(m));
      if (missing.length) {
        throw badSetting(
          `no Workshop Collection is set, so only stock maps can load (${[...loadable].sort().join(', ')}). ` +
          `These need a collection: ${missing.join(', ')}. Set a Workshop Collection ID to use workshop maps, ` +
          `then Restart Hosting once so Steam downloads them.`,
        );
      }
    }

    let inst = (await this.client.fileRead(this.vmid, P.instanceCfg)).content ?? '';
    inst = setVars(inst, {
      defaultmap: bootMap,
      maxplayers: String(s.maxPlayers),
      wscollectionid: s.workshopCollection,
      ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
    });
    await this.client.fileWrite(this.vmid, P.instanceCfg, inst);

    let game = (await this.client.fileRead(this.vmid, P.serverCfg)).content ?? '';
    const cvars = { ttt_always_use_mapcycle: s.useMapcycle };
    for (const f of TTT_FIELDS) cvars[f.cvar] = String(s[f.key]);
    game = setCvars(game, cvars);
    await this.client.fileWrite(this.vmid, P.serverCfg, game);

    await this.client.fileWrite(this.vmid, P.mapcycle, rotation.join('\n') + '\n');
    return { ok: true };
  }

  async captureProfileSettings() {
    const P = this.paths;
    const [game, inst, mapcycle] = await Promise.all([
      this.client.fileRead(this.vmid, P.serverCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.fileRead(this.vmid, P.instanceCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.fileRead(this.vmid, P.mapcycle).then((r) => r.content ?? '').catch(() => ''),
    ]);
    const num = (cvar, def) => {
      const v = getCvar(game, cvar);
      return v === undefined || v === '' ? def : Number(v);
    };
    // Preserve the invariant: the boot map (defaultmap) is the first rotation entry.
    // Lowercase: bsp names are lowercase, but a defaultmap set out-of-band can leak
    // a mixed-case Workshop title, which validateProfileSettings (lowercase-only
    // MAP_NAME_RE) would reject — making capture throw instead of snapshotting.
    const bootMap = (getVar(inst, 'defaultmap') || 'gm_construct').trim().toLowerCase();
    // Lowercase the rotation lines too (same reason as bootMap): a mixed-case
    // Workshop title set out-of-band in mapcycle.txt would fail the lowercase-only
    // MAP_NAME_RE in validateProfileSettings, making capture throw instead of snapshot.
    let cycle = mapcycle.replace(/\r/g, '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
    if (cycle[0] !== bootMap) cycle = [bootMap, ...cycle.filter((m) => m !== bootMap)];

    const doc = {
      maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
      workshopCollection: (getVar(inst, 'wscollectionid') || '').trim(),
      useMapcycle: num('ttt_always_use_mapcycle', 1) ? '1' : '0',
      mapcycle: cycle,
    };
    for (const f of TTT_FIELDS) doc[f.key] = num(f.cvar, f.def);
    return this.validateProfileSettings(doc);
  }

  // ── live commands (Source RCON on the game port, like CS2) ──
  // The RCON password is read live from the game cfg's `rcon_password` cvar (the VM
  // path; the Docker subclass overrides this to read it from env instead). Empty ⇒
  // RCON is disabled and getLive() reports unavailable. Cached nowhere — re-read per
  // call so an Apply that sets the password takes effect without a connector reload.
  async rconPassword() {
    const game = await this.client.fileRead(this.vmid, this.paths.serverCfg).then((r) => r.content ?? '').catch(() => '');
    return (getCvar(game, 'rcon_password') || '').trim();
  }

  async connectPassword() {
    const game = await this.client.fileRead(this.vmid, this.paths.serverCfg).then((r) => r.content ?? '').catch(() => '');
    return (getCvar(game, 'sv_password') || '').trim();
  }

  async getLive() {
    const pw = await this.rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in server.cfg and restart' };
    return {
      available: true,
      actions: GMOD_LIVE_ACTIONS,
      controls: TTT_LIVE_CONTROLS, // panel renders these as sliders
      changeMap: true, // panel renders a live change-map control
      commandHint: 'any GMOD/TTT console command, e.g. ttt_round_limit 5, changelevel ttt_…, status',
    };
  }

  // Run one RCON command, returning { output }. The TRANSPORT is overridable so the
  // Docker subclass (docker/gmod.js) can reach the game port over TCP instead of the
  // in-guest python client, while inheriting all the live-action command mapping below.
  async runRcon(command) {
    return rconCommand(this, { port: this.server.port, password: await this.rconPassword(), command });
  }

  // Free-text console passthrough (the Runtime console input). validateLiveCommand
  // trims + rejects empty / overlong / multi-line input; the command then runs
  // verbatim over RCON. Distinct from runLiveAction, which maps curated keys to cmds.
  async sendCommand(command) {
    return this.runRcon(validateLiveCommand(command));
  }

  // Build the live change-map command, validating the map name (lowercase a-z0-9_).
  // Shared with PropHuntConnector so the change_map branch + map guard live once
  // (changelevel only reaches maps mounted at the last boot — see CLAUDE.md § GMOD workshop).
  changeMapCmd(value) {
    const v = String(value ?? '').trim();
    if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
    return `changelevel ${v}`;
  }

  // Dispatch one Runtime-panel control to its RCON command, in priority order:
  //   1. the live change-map dropdown (`change_map`) → `changelevel <map>` (only
  //      reaches maps mounted at the last boot — see CLAUDE.md § GMOD workshop);
  //   2. a slider value (`gmodRangeCmd` returns null for non-range keys) → its cvar;
  //   3. a curated action button (`GMOD_ACTION_CMDS`).
  // `value` is only consumed by change_map + the sliders; action buttons ignore it.
  async runLiveAction(key, value) {
    if (key === 'change_map') return this.runRcon(this.changeMapCmd(value));
    const range = gmodRangeCmd(key, value, TTT_LIVE_CONTROLS);
    if (range) return this.runRcon(range);
    const cmd = GMOD_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return this.runRcon(cmd);
  }
}
