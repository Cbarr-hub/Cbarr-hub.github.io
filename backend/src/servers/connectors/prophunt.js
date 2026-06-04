// Prop Hunt connector — a second LinuxGSM GMOD instance (VM 105,
// /home/miles/phserver) running the Prop Hunt: X2Z gamemode.
//
// Extends GmodConnector to reuse the GMOD machinery (path layout, map sync via
// gmad, status/power, RCON transport). Differences from TTT:
//   - boots ONE ph_ map under gamemode="prop_hunt" (no rotation);
//   - content mounts from the public Workshop collection 3737190377 (the X2Z
//     gamemode ships the prop_hunt/base_phx folders + 7 ph_ maps + taunts + a
//     loadout manager); clients auto-download via the collection.
//   - X2Z gameplay tuning is mostly via the in-game X Menu (!phmenu), stored in
//     garrysmod/data/phx_data. Only a handful of real server cvars exist (below);
//     the panel exposes those + a Controls/Menus reference + the raw config editor.
//
// Layout under /home/miles/phserver (own serverfiles, port 27067):
//   instance cfg : lgsm/config-lgsm/gmodserver/gmodserver.cfg
//     gamemode="prop_hunt"  defaultmap="ph_…"  maxplayers  wscollectionid="3737190377"
//     port="27067"          gslt (dedicated; out-of-band)
//   game cfg : serverfiles/garrysmod/cfg/gmodserver.cfg  (+servercfgfile)
//     ph_*/phx_* cvars + rcon_password + `exec gamertown/active`
//   escape hatch : cfg/gamertown/active.cfg  (free-text extra cvars; re-execable live)

import { GmodConnector } from './gmod.js';
import { getVar, setVars } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';
import { badSetting, MAP_NAME_RE } from '../errors.js';

const GAMEMODE   = 'prop_hunt';
const COLLECTION = '3737190377';   // public X2Z collection (gamemode + maps + extras)
const DEFAULT_MAP = 'ph_restaurant';

// The managed config the game cfg execs last, holding the rawConfig body.
const ACTIVE_EXEC  = 'gamertown/active';
const EXEC_LINE_RE = /^[ \t]*exec[ \t]+gamertown\/active[ \t]*$/m;

// Real X2Z server cvars (from the gamemode's CreateConVar), all booleans (0/1).
// Most gameplay tuning (round length, prop balance, taunts) is in the in-game X
// Menu (!phmenu) → garrysmod/data/phx_data, not cvars.
const PH_CVARS = [
  { cvar: 'fretta_waitforplayers',      key: 'waitForPlayers', label: 'Wait for players before a round starts', def: 1 },
  { cvar: 'ph_enable_team_itemspawner', key: 'teamItemSpawner', label: 'Enable team item spawners',             def: 1 },
  { cvar: 'ph_kick_non_admin_access',   key: 'kickNonAdmin',   label: 'Kick non-admins who probe admin access',  def: 0 },
  { cvar: 'phx_integrity_check',        key: 'integrityCheck', label: 'Addon-conflict integrity check (keep on)', def: 1 },
  { cvar: 'phx_verbose',                key: 'verboseLog',     label: 'Verbose server logging',                   def: 0 },
];

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

// Live (RCON) curated actions — real X2Z console commands + generic movement toggles.
const PH_LIVE_ACTIONS = [
  { key: 'next_round',   label: 'Next Round' },
  { key: 'map_vote',     label: 'Start Map Vote' },
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
  next_round:   'ph_force_end_round',                                 // X2Z: force-ends the round → next
  map_vote:     'mv_start',                                           // X2Z: start a map vote
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

const asBool = (v) => (v === 1 || v === '1' || v === true ? '1' : '0');

export class PropHuntConnector extends GmodConnector {
  gsmDir = '/home/miles/phserver';
  mapPrefixes = ['ph_', 'gm_'];

  // ── editable config files (the "edit the mod config" surface) ─────────────────
  // Inherits the GMOD set (game cfg `server.cfg`, instance cfg `lgsm.cfg`) and adds
  // the live-execable extra-cvars file plus X2Z's editable data files (weapon
  // loadouts, admin list). These open in the panel's Raw Config editor.
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

  // ── startup-config profile ────────────────────────────────────────────────────
  defaultProfileSettings() {
    const d = { propHuntMap: DEFAULT_MAP, workshopCollection: COLLECTION, maxPlayers: 16, rawConfig: '' };
    for (const f of PH_CVARS) d[f.key] = asBool(f.def);
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

    const coll = String(s.workshopCollection ?? '').trim();
    if (coll !== '' && !/^\d{1,20}$/.test(coll)) throw badSetting('workshop collection id must be digits');
    out.workshopCollection = coll;

    for (const f of PH_CVARS) out[f.key] = asBool(s[f.key] === undefined ? f.def : s[f.key]);

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
    const boolField = (f) => ({ key: f.key, label: f.label, type: 'bool' });
    const infoField = (c) => ({ key: c.key, label: c.label, type: 'info', help: c.help });
    return {
      groups: [
        {
          key: 'map', title: 'Map & Workshop',
          fields: [
            { key: 'propHuntMap', label: 'Starting Map', type: 'select', options: mapOpts,
              help: 'The ph_ map the server boots into (default ph_restaurant). Pick any installed map; change maps live in the Runtime panel.' },
            { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text',
              placeholder: '3737190377',
              help: 'The Steam Workshop collection GMOD mounts at boot — the X2Z gamemode + ph_ maps + extras. Default 3737190377.' },
            { key: 'syncMaps', label: 'Sync Maps', type: 'mapsync',
              help: 'Refresh the installed ph_ map list from the mounted collection (run after the collection changes + a restart).' },
            { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1 },
          ],
        },
        {
          key: 'x2z', title: 'X2Z Settings',
          fields: PH_CVARS.map(boolField),
          note: 'Round length, prop balance, taunts and most gameplay options are set in the in-game X Menu (!phmenu) — see Controls & In-Game Menus below. These are the server-side cvar toggles.',
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
    };
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);
    const P = this.paths;

    if (!s.propHuntMap) throw badSetting('pick a starting map (e.g. ph_restaurant).');

    let inst = (await this.client.agentFileRead(this.vmid, P.instanceCfg)).content ?? '';
    inst = setVars(inst, {
      gamemode: GAMEMODE,
      defaultmap: s.propHuntMap,
      maxplayers: String(s.maxPlayers),
      wscollectionid: s.workshopCollection,
      ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
    });
    await this.client.agentFileWrite(this.vmid, P.instanceCfg, inst);

    let game = (await this.client.agentFileRead(this.vmid, P.serverCfg)).content ?? '';
    const cvars = {};
    for (const f of PH_CVARS) cvars[f.cvar] = s[f.key];
    game = setCvars(game, cvars);
    if (!EXEC_LINE_RE.test(game)) game = game.replace(/\n*$/, '') + `\nexec ${ACTIVE_EXEC}\n`;
    await this.client.agentFileWrite(this.vmid, P.serverCfg, game);

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
    const doc = {
      propHuntMap: (getVar(inst, 'defaultmap') || DEFAULT_MAP).trim(),
      workshopCollection: (getVar(inst, 'wscollectionid') || COLLECTION).trim(),
      maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
      rawConfig: active,
    };
    for (const f of PH_CVARS) {
      const v = getCvar(game, f.cvar);
      doc[f.key] = asBool(v === undefined || v === '' ? f.def : v);
    }
    return this.validateProfileSettings(doc);
  }

  // ── live commands (Source RCON on the game port) ──────────────────────────────
  async getLive() {
    const pw = await this.rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in the game cfg and restart' };
    return {
      available: true,
      actions: PH_LIVE_ACTIONS,
      changeMap: true,
      commandHint: 'any GMOD/X2Z console command, e.g. changelevel ph_office_fsg_v2, ph_force_end_round, mv_start, status',
    };
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') {
      const v = String(value ?? '').trim();
      if (!MAP_NAME_RE.test(v)) throw badSetting(`invalid map: ${v}`);
      return this.runRcon(`changelevel ${v}`);
    }
    const cmd = PH_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return this.runRcon(cmd);
  }
}
