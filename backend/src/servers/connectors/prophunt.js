// Prop Hunt connector — a second LinuxGSM GMOD instance (VM 105,
// /home/miles/phserver) running the Prop Hunt: X2Z gamemode.
//
// Extends GmodConnector to reuse the GMOD machinery (path layout, map sync via
// gmad, status/power, RCON transport) and overrides the gamemode semantics:
//   - a profile boots ONE ph_ map under gamemode="prop_hunt" (no rotation);
//   - the X2Z gamemode + ph_ maps + extras install by Workshop item ID via SteamCMD.
//     Steam removed the source collections, so host_workshop_collection is bypassed
//     (wscollectionid stays empty). syncMaps() downloads the active profile's item
//     ids, extracts maps into garrysmod/maps/ and any gamemode into
//     garrysmod/gamemodes/, and writes a resource.AddWorkshop autorun for clients.
//
// Layout mirrors VM 104, under /home/miles/phserver (own serverfiles, own ports):
//   instance cfg : lgsm/config-lgsm/gmodserver/gmodserver.cfg
//     gamemode="prop_hunt"  defaultmap="ph_…"  maxplayers  wscollectionid="" (empty)
//     port="27067"          gslt (dedicated token; set out-of-band, never committed)
//   game cfg : serverfiles/garrysmod/cfg/gmodserver.cfg  (+servercfgfile)
//     ph_* cvars + rcon_password + `exec gamertown/active`
//   escape hatch : cfg/gamertown/active.cfg  (free-text extra cvars; re-execable live)

import { GmodConnector } from './gmod.js';
import { getVar, setVars } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';
import { rconCommand } from '../rcon.js';
import { badSetting, MAP_NAME_RE } from '../errors.js';

const GAMEMODE = 'prop_hunt';

// The managed config the game cfg execs last, holding the rawConfig body.
const ACTIVE_EXEC  = 'gamertown/active';
const EXEC_LINE_RE = /^[ \t]*exec[ \t]+gamertown\/active[ \t]*$/m;

// Prop Hunt (X2Z) gameplay cvars. Data-driven like TTT_FIELDS so adding a tunable
// later is a one-line change. Placeholder defaults — refine once X2Z is live.
const PH_FIELDS = [
  { cvar: 'ph_roundtime',        key: 'roundTime',   label: 'Round Time (s)',        def: 240, min: 30, max: 1800, int: true },
  { cvar: 'ph_setuptime',        key: 'setupTime',   label: 'Hiding Time (s)',       def: 30,  min: 5,  max: 300,  int: true },
  { cvar: 'ph_hunter_blindtime', key: 'hunterBlind', label: 'Hunter Blind Time (s)', def: 20,  min: 0,  max: 120,  int: true },
];

// Live (RCON) curated actions: next round, the four movement toggles, cheats, and
// re-exec the deployed config. Command strings are tunable; sv_cheats-gated ones
// flip cheats on as needed (this is a friend server).
const PH_LIVE_ACTIONS = [
  { key: 'next_round',   label: 'Next Round' },
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
  { key: 'apply_config', label: 'Apply Config' },
  { key: 'players',      label: 'List Players' },
];
const PH_ACTION_CMDS = {
  next_round:   'ph_restartround',  // TODO: confirm X2Z's round-restart command on the box
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
  apply_config: `exec ${ACTIVE_EXEC}`,
  players:      'status',
};

export class PropHuntConnector extends GmodConnector {
  gsmDir = '/home/miles/phserver';
  mapPrefixes = ['ph_', 'gm_'];

  // ── editable config files (the "edit the mod config" surface) ─────────────────
  // Inherits the GMOD set — the game cfg (`server.cfg`, where ph_/phx_ cvars go) and
  // the LinuxGSM instance cfg (`lgsm.cfg`, where wscollectionid/gamemode/ports live) —
  // and adds the live-execable extra-cvars file plus X2Z's editable data files
  // (weapon loadouts, admin list). These open in the panel's Raw Config editor.
  get configFiles() {
    const P = this.paths;
    return {
      ...super.configFiles,
      'active.cfg':  `${P.garrysmod}/cfg/gamertown/active.cfg`,
      'phx-loadout': `${P.garrysmod}/data/phx_data/swep_manager/loadoutinfo.txt`,
      'phx-admins':  `${P.garrysmod}/data/phx_data/admins.txt`,
    };
  }

  // The QEMU guest agent writes as root; chown edited files back to the game user so
  // the gamemode (running as miles) can keep updating its own data files afterward.
  async writeConfig(name, content) {
    const res = await super.writeConfig(name, content);
    const path = this.configFiles[name];
    if (path) {
      await this.runShell(`chown ${this.gsmUser}:${this.gsmUser} "${path}"`, { timeoutMs: 10_000 }).catch(() => {});
    }
    return res;
  }

  // ── startup-config profiles ───────────────────────────────────────────────────
  defaultProfileSettings() {
    const d = { maxPlayers: 16, propHuntMap: 'ph_factory', workshopItems: [], rawConfig: '' };
    for (const f of PH_FIELDS) d[f.key] = f.def;
    return d;
  }

  validateProfileSettings(s = {}) {
    const out = {};

    const mp = Number(s.maxPlayers);
    if (!Number.isInteger(mp) || mp < 1 || mp > 128) throw badSetting('maxPlayers must be 1–128');
    out.maxPlayers = mp;

    const ph = String(s.propHuntMap ?? '').trim();
    if (ph !== '' && !MAP_NAME_RE.test(ph)) throw badSetting(`invalid Prop Hunt map: ${ph}`);
    out.propHuntMap = ph;

    // Workshop items: an array, or a free-text list (newline/space/comma separated)
    // of numeric Steam Workshop item ids (the gamemode + ph_ maps + extras).
    const rawItems = Array.isArray(s.workshopItems) ? s.workshopItems : String(s.workshopItems ?? '').split(/[\s,]+/);
    const items = rawItems.map((x) => String(x).trim()).filter(Boolean);
    for (const id of items) if (!/^\d{1,20}$/.test(id)) throw badSetting(`invalid workshop item id: ${id}`);
    out.workshopItems = [...new Set(items)];

    for (const f of PH_FIELDS) {
      const n = Number(s[f.key] === undefined ? f.def : s[f.key]);
      if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
      if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
      if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
      out[f.key] = n;
    }

    const raw = String(s.rawConfig ?? '');
    if (raw.length > 100_000) throw badSetting('extra cvars too large (max 100000 chars)');
    if (raw.includes('\0')) throw badSetting('extra cvars may not contain null bytes');
    out.rawConfig = raw;

    return out;
  }

  async profileSchema() {
    const discovered = await this.installedMaps();
    const phMaps = [...new Set(discovered.filter((m) => m.startsWith('ph_')))];
    const mapOpts = phMaps.map((m) => ({ value: m, label: m }));
    const numField = (f) => ({ key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: 1 });
    return {
      groups: [
        {
          key: 'map', title: 'Map & Workshop',
          fields: [
            { key: 'propHuntMap', label: 'Boot Map', type: 'select', custom: true, options: mapOpts,
              help: 'The ph_ map the server boots into (e.g. ph_factory). Add ids below + Sync to install, or type a name.' },
            { key: 'workshopItems', label: 'Extra Workshop Item IDs (optional)', type: 'textarea',
              placeholder: '2176546751\n2850799895\n…',
              help: 'Optional — extra Workshop item ids (one per line) to install on top of the mounted collection. The X2Z gamemode + ph_ maps come from the collection (wscollectionid, in lgsm.cfg); leave blank to use just the collection. Then Sync.' },
            { key: 'syncMaps', label: 'Sync Maps', type: 'mapsync',
              help: 'Refresh the installed ph_ map list from the mounted Workshop collection (and download any extra item ids above).' },
            { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1 },
          ],
        },
        {
          key: 'gameplay', title: 'Prop Hunt Gameplay',
          fields: PH_FIELDS.map(numField),
        },
        {
          key: 'advanced', title: 'Advanced',
          fields: [
            { key: 'rawConfig', label: 'Extra cvars (deployed as a live-execable config)', type: 'textarea',
              placeholder: 'ph_prop_lock 1\nph_thirdperson 1' },
          ],
        },
      ],
      note: 'A profile is the startup config the server boots as (Prop Hunt: X2Z). The gamemode + maps mount from the Workshop collection (wscollectionid in lgsm.cfg). Apply saves the boot map + settings and restarts. Extra cvars deploy to gamertown/active.cfg (re-execable via Runtime → Apply Config).',
    };
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);
    const P = this.paths;

    if (!s.propHuntMap) throw badSetting('pick a Prop Hunt boot map (e.g. ph_factory).');

    // NOTE: wscollectionid is intentionally NOT written here. The server mounts its
    // content from the public X2Z Workshop collection (3737190377) set in the instance
    // cfg on the box (editable via the raw config editor); Apply must not clobber it.
    let inst = (await this.client.agentFileRead(this.vmid, P.instanceCfg)).content ?? '';
    inst = setVars(inst, {
      gamemode: GAMEMODE,
      defaultmap: s.propHuntMap,
      maxplayers: String(s.maxPlayers),
      ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
    });
    await this.client.agentFileWrite(this.vmid, P.instanceCfg, inst);

    let game = (await this.client.agentFileRead(this.vmid, P.serverCfg)).content ?? '';
    const cvars = {};
    for (const f of PH_FIELDS) cvars[f.cvar] = String(s[f.key]);
    game = setCvars(game, cvars);
    if (!EXEC_LINE_RE.test(game)) game = game.replace(/\n*$/, '') + `\nexec ${ACTIVE_EXEC}\n`;
    await this.client.agentFileWrite(this.vmid, P.serverCfg, game);

    // Deploy the extra-cvars block to gamertown/active.cfg (exec'd by the game cfg).
    await this.runShell(`mkdir -p "${P.garrysmod}/cfg/gamertown"`, { asUser: this.gsmUser, timeoutMs: 10_000 });
    await this.client.agentFileWrite(this.vmid, `${P.garrysmod}/cfg/gamertown/active.cfg`, s.rawConfig);
    return { ok: true };
  }

  async captureProfileSettings() {
    const P = this.paths;
    const [game, inst, active] = await Promise.all([
      this.client.agentFileRead(this.vmid, P.serverCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, P.instanceCfg).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, `${P.garrysmod}/cfg/gamertown/active.cfg`).then((r) => r.content ?? '').catch(() => ''),
    ]);
    const num = (cvar, def) => {
      const v = getCvar(game, cvar);
      return v === undefined || v === '' ? def : Number(v);
    };
    const doc = {
      maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
      propHuntMap: (getVar(inst, 'defaultmap') || 'ph_factory').trim(),
      workshopItems: [],   // installed by id; not derivable from the cfg
      rawConfig: active,
    };
    for (const f of PH_FIELDS) doc[f.key] = num(f.cvar, f.def);
    return this.validateProfileSettings(doc);
  }

  // ── workshop install by id (collections bypassed) ─────────────────────────────
  // Steam removed the source collections, so instead of host_workshop_collection we
  // download each item by id via SteamCMD (anonymous), stage the .gma where the GMOD
  // map-extractor scans, install any gamemode folder into garrysmod/gamemodes/, and
  // write the resource.AddWorkshop autorun so joining clients fetch the content.
  // Wired to the panel's "Sync" action (POST /:id/maps/sync); ids come from the
  // active profile.
  async syncMaps() {
    const P = this.paths;
    const items = this.#activeWorkshopItems();

    if (items.length) {
      const steamcmd = '$HOME/.local/share/Steam/steamcmd/steamcmd.sh';
      const dl = items.map((id) => `+workshop_download_item 4000 ${id}`).join(' ');
      // Download (anonymous). 30-min budget — first run pulls the gamemode + maps.
      await this.runShell(`${steamcmd} +login anonymous ${dl} +quit`, { asUser: this.gsmUser, timeoutMs: 1_800_000 });
      // Stage downloaded .gma into the dir syncMaps scans, then install gamemode folders.
      const wsDl = '$HOME/.local/share/Steam/steamapps/workshop/content/4000';
      await this.runShell([
        `mkdir -p "${P.steamWs}" "${P.garrysmod}/gamemodes"`,
        `for d in ${wsDl}/*; do [ -d "$d" ] || continue; id=$(basename "$d");`,
        `  mkdir -p "${P.steamWs}/$id"; cp -n "$d"/*.gma "${P.steamWs}/$id/" 2>/dev/null || true; done`,
        'tmp=$(mktemp -d) || exit 1',
        `for g in ${P.steamWs}/*/*.gma; do [ -e "$g" ] || continue;`,
        `  rm -rf "$tmp/x"; "${P.gmad}" extract -file "$g" -out "$tmp/x" >/dev/null 2>&1 || continue;`,
        `  [ -d "$tmp/x/gamemodes" ] && cp -rn "$tmp/x/gamemodes/." "${P.garrysmod}/gamemodes/" 2>/dev/null || true; done`,
        'rm -rf "$tmp"',
      ].join('\n'), { asUser: this.gsmUser, timeoutMs: 900_000 });
      await this.#writeWorkshopAutorun(items);
    }
    // Extract maps (.bsp) into garrysmod/maps/ via the inherited GMOD sync.
    return super.syncMaps();
  }

  #activeWorkshopItems() {
    try {
      const activeId = this.store?.getActiveProfileId(this.server.id);
      if (!activeId) return [];
      const p = this.store.getProfile(this.server.id, activeId);
      const items = p?.settings?.workshopItems;
      return Array.isArray(items) ? items.filter((id) => /^\d{1,20}$/.test(String(id))) : [];
    } catch {
      return [];
    }
  }

  async #writeWorkshopAutorun(items) {
    const P = this.paths;
    const lua = '-- Auto-generated by Gamertown — clients download these Workshop items on join.\n'
      + items.map((id) => `resource.AddWorkshop("${id}")`).join('\n') + '\n';
    await this.runShell(`mkdir -p "${P.garrysmod}/lua/autorun/server"`, { asUser: this.gsmUser, timeoutMs: 10_000 });
    await this.client.agentFileWrite(this.vmid, `${P.garrysmod}/lua/autorun/server/gtown_workshop.lua`, lua);
  }

  // ── live commands (Source RCON on the game port) ──────────────────────────────
  async getLive() {
    const pw = await this.rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in the game cfg and restart' };
    return {
      available: true,
      actions: PH_LIVE_ACTIONS,
      changeMap: true,
      commandHint: 'any GMOD console command, e.g. changelevel ph_factory, sv_gravity 200, status',
    };
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') {
      const v = String(value ?? '').trim();
      if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
      return rconCommand(this, { port: this.server.port, password: await this.rconPassword(), command: `changelevel ${v}` });
    }
    const cmd = PH_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return rconCommand(this, { port: this.server.port, password: await this.rconPassword(), command: cmd });
  }
}
