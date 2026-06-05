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
// Verified layout (VM 104) — see INFRA.md "Game Server VMs":
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
import { getVar, setVars } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';
import { rconCommand, validateLiveCommand } from '../rcon.js';
import { badSetting, MAP_NAME_RE } from '../errors.js';

// Maps that ship with the base install, so they're always loadable even with no
// workshop collection — the safe floor for defaults + the boot-map guard.
const STOCK_ALWAYS = ['gm_construct', 'gm_flatgrass'];

// Live (RCON) curated actions. These are generic Source-engine toggles that work
// in ANY GMOD gamemode, so TTT gets the SAME runtime buttons Prop Hunt offers
// (the X2Z-mod-specific Next Round / Map Vote / Apply Config in PH have no stock
// TTT equivalent, so they're intentionally left out). The live change-map control
// is rendered separately (changeMap: true below).
const GMOD_LIVE_ACTIONS = [
  { key: 'lowgrav_on',   label: 'Low Gravity On' },
  { key: 'lowgrav_off',  label: 'Low Gravity Off' },
  { key: 'speed_on',     label: 'Speed Boost On' },
  { key: 'speed_off',    label: 'Speed Boost Off' },
  { key: 'bhop_on',      label: 'Bunnyhop On' },
  { key: 'bhop_off',     label: 'Bunnyhop Off' },
  { key: 'slowmo_on',    label: 'Slow-Mo On' },
  { key: 'slowmo_off',   label: 'Slow-Mo Off' },
  { key: 'cheats_on',    label: 'Cheats On' },
  { key: 'cheats_off',   label: 'Cheats Off' },
  { key: 'players',      label: 'List Players' },
];
const GMOD_ACTION_CMDS = {
  lowgrav_on:   'sv_gravity 200',
  lowgrav_off:  'sv_gravity 600',
  speed_on:     'sv_cheats 1; hl2_normspeed 320; hl2_sprintspeed 480',
  speed_off:    'hl2_normspeed 190; hl2_sprintspeed 320',
  bhop_on:      'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_airaccelerate 1000',
  bhop_off:     'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_airaccelerate 12',
  slowmo_on:    'sv_cheats 1; host_timescale 0.5',
  slowmo_off:   'host_timescale 1',
  cheats_on:    'sv_cheats 1',
  cheats_off:   'sv_cheats 0',
  players:      'status',
};

// TTT cvar field specs (key in server.cfg, UI label, numeric bounds). pct fields
// are 0..1 fractions; the rest are integers. Kept as data so getSettings builds
// the panel and setSettings validates from one source.
const TTT_FIELDS = [
  { cvar: 'ttt_round_limit',        key: 'roundLimit',     label: 'Rounds per Map',        def: 6,    min: 1,  max: 100,  int: true },
  { cvar: 'ttt_time_limit_minutes', key: 'timeLimit',      label: 'Time Limit (min)',      def: 75,   min: 1,  max: 600,  int: true },
  { cvar: 'ttt_traitor_pct',        key: 'traitorPct',     label: 'Traitor Ratio (0–1)',   def: 0.25, min: 0,  max: 1 },
  { cvar: 'ttt_traitor_max',        key: 'traitorMax',     label: 'Max Traitors',          def: 32,   min: 1,  max: 64,   int: true },
  { cvar: 'ttt_detective_pct',      key: 'detectivePct',   label: 'Detective Ratio (0–1)', def: 0.13, min: 0,  max: 1 },
  { cvar: 'ttt_detective_max',      key: 'detectiveMax',   label: 'Max Detectives',        def: 32,   min: 1,  max: 64,   int: true },
  { cvar: 'ttt_minimum_players',    key: 'minPlayers',     label: 'Min Players to Start',  def: 2,    min: 1,  max: 64,   int: true },
];

export class GmodConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = '/home/miles/gmodserver';
  gsmScript = 'gmodserver';

  // The Source game-config basename, launched via `+servercfgfile`. NOT a server.cfg.
  gameCfgName = 'gmodserver.cfg';
  // Discoverable map-name prefixes (a subclass overrides, e.g. ph_ for Prop Hunt).
  mapPrefixes = ['ttt_', 'gm_'];

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
      const res = await this.runShell(
        `ls -1 ${P.mapsDir}/*.bsp 2>/dev/null | sed -E 's#.*/##; s#\\.bsp$##' | sort -u`,
        { asUser: this.gsmUser, timeoutMs: 15_000 },
      );
      const re = new RegExp(`^(${this.mapPrefixes.join('|')})[a-z0-9_]*$`);
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

  // Profiles own the startup config (the Profiles panel). getSettings is kept only
  // to feed the Runtime panel's live change-map dropdown with the loadable maps.
  async getSettings() {
    const P = this.paths;
    const [inst, maps] = await Promise.all([
      this.client.agentFileRead(this.vmid, P.instanceCfg).then((r) => r.content ?? '').catch(() => ''),
      this.installedMaps(),
    ]);
    const defaultMap = (getVar(inst, 'defaultmap') || '').trim();
    const stock      = maps.filter((m) => STOCK_ALWAYS.includes(m));
    const collection = maps.filter((m) => !STOCK_ALWAYS.includes(m));
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
  // ttt_always_use_mapcycle), and mapcycle.txt. Takes effect on the next restart.

  defaultProfileSettings() {
    // The server boots into the FIRST map of the rotation; default it to a stock
    // map that always exists (TTT runs fine on it). Workshop maps need a collection.
    const d = {
      maxPlayers: 16, workshopCollection: '',
      useMapcycle: '1', mapcycle: ['gm_construct'],
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
    const mapOpts = [...new Set([...STOCK_ALWAYS, ...discovered])].map((m) => ({
      value: m, label: m, group: STOCK_ALWAYS.includes(m) ? 'Stock' : 'Collection',
    }));
    const numField = (f) => ({ key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01 });

    return {
      groups: [
        {
          key: 'map', title: 'Maps & Rotation',
          fields: [
            { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text',
              placeholder: 'Steam Workshop collection id',
              help: 'Steam stores & manages these maps. Set this, build the rotation, then Apply — that restarts the server so Steam downloads the collection.' },
            { key: 'syncMaps', label: 'Workshop Maps', type: 'mapsync',
              help: 'Added a map to the collection? Restart Hosting to download it, then Sync to install it into the list below.' },
            { key: 'mapcycle', label: 'Map Rotation', type: 'maplist', custom: true, options: mapOpts,
              help: 'The server boots into the FIRST map and (with auto-rotate on) advances down the list after each round/time limit. Type collection map names; gm_construct is the always-available fallback.' },
            { key: 'useMapcycle', label: 'Auto-rotate through the rotation', type: 'bool' },
          ],
        },
        {
          key: 'gameplay', title: 'Gameplay',
          fields: [
            { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1 },
            ...TTT_FIELDS.map(numField),
          ],
        },
      ],
      note: 'A profile is the startup config the server boots as. Apply saves it and restarts the server (which downloads + mounts your Workshop collection). Maps come from the collection; gm_construct is the always-available fallback.',
    };
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);
    const P = this.paths;

    // The server boots into the FIRST map of the rotation (stock fallback if the
    // rotation is somehow empty). One ordered list drives both boot + rotation.
    const rotation = s.mapcycle.length ? s.mapcycle : ['gm_construct'];
    const bootMap = rotation[0];

    // Boot-map guard. With NO workshop collection set, only stock maps can load —
    // a workshop map mounts nothing and leaves the server with "no active map"
    // (the exact brick we hit). Block that; trust any map once a collection is set
    // (GMOD downloads + mounts it at boot before loading the map).
    if (!s.workshopCollection) {
      const loadable = new Set([...(await this.installedMaps()), ...STOCK_ALWAYS]);
      const missing = [...new Set(rotation)].filter((m) => !loadable.has(m));
      if (missing.length) {
        throw badSetting(
          `no Workshop Collection is set, so only stock maps can load (${[...loadable].sort().join(', ')}). ` +
          `These need a collection: ${missing.join(', ')}. Set a Workshop Collection ID to use workshop maps, ` +
          `then Restart Hosting once so Steam downloads them.`,
        );
      }
    }

    let inst = (await this.client.agentFileRead(this.vmid, P.instanceCfg)).content ?? '';
    inst = setVars(inst, {
      defaultmap: bootMap,
      maxplayers: String(s.maxPlayers),
      wscollectionid: s.workshopCollection,
      ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
    });
    await this.client.agentFileWrite(this.vmid, P.instanceCfg, inst);

    let game = (await this.client.agentFileRead(this.vmid, P.serverCfg)).content ?? '';
    const cvars = { ttt_always_use_mapcycle: s.useMapcycle };
    for (const f of TTT_FIELDS) cvars[f.cvar] = String(s[f.key]);
    game = setCvars(game, cvars);
    await this.client.agentFileWrite(this.vmid, P.serverCfg, game);

    await this.client.agentFileWrite(this.vmid, P.mapcycle, rotation.join('\n') + '\n');
    return { ok: true };
  }

  async captureProfileSettings() {
    const P = this.paths;
    const [game, inst, mapcycle] = await Promise.all([
      this.client.agentFileRead(this.vmid, P.serverCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, P.instanceCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, P.mapcycle).then((r) => r.content ?? '').catch(() => ''),
    ]);
    const num = (cvar, def) => {
      const v = getCvar(game, cvar);
      return v === undefined || v === '' ? def : Number(v);
    };
    // Preserve the invariant: the boot map (defaultmap) is the first rotation entry.
    const bootMap = (getVar(inst, 'defaultmap') || 'gm_construct').trim();
    let cycle = mapcycle.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
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
  async rconPassword() {
    const game = await this.client.agentFileRead(this.vmid, this.paths.serverCfg).then((r) => r.content ?? '').catch(() => '');
    return (getCvar(game, 'rcon_password') || '').trim();
  }

  async getLive() {
    const pw = await this.rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in server.cfg and restart' };
    return {
      available: true,
      actions: GMOD_LIVE_ACTIONS,
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

  async sendCommand(command) {
    return this.runRcon(validateLiveCommand(command));
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') {
      const v = String(value ?? '').trim();
      if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
      return this.runRcon(`changelevel ${v}`);
    }
    const cmd = GMOD_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return this.runRcon(cmd);
  }
}
