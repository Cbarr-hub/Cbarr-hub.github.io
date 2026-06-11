// Factorio spec — image `factoriotools/factorio`.
//
// The container always loads saves/_active.zip (SAVE_NAME=_active), so "switch
// world" = copy the chosen save over _active.zip + restart. Profile fields span
// server-settings.json and map-settings.json — the latter's world rules are
// baked into a save at GENERATION (only a NEWLY generated world is affected;
// a running world is changed via the live Game Speed / Evolution controls).

import { badSetting, SAFE_NAME_RE } from '../../errors.js';

const CONFIG = '/factorio/config';
const SAVES  = '/factorio/saves';
const SERVER_SETTINGS = `${CONFIG}/server-settings.json`;
const MAP_SETTINGS    = `${CONFIG}/map-settings.json`;
const ACTIVE = `${SAVES}/_active.zip`; // the save the container always loads

const VISIBILITY_OPTS = [
  { value: 'public', label: 'Public (listed) + LAN' },
  { value: 'lan',    label: 'LAN only' },
];

const PROFILE_NOTE =
  'A profile is the startup config the server boots as. Changes apply on the next restart. ' +
  'Public visibility also needs a Factorio.com token in server-settings.json. ' +
  'World Rules (evolution / pollution / expansion / research cost) live in map-settings.json, ' +
  'which is baked into a save at GENERATION — so they only affect a NEWLY generated world. ' +
  'To change a running world, use the live Game Speed / Evolution controls.';

// Embedded reference for the Raw-Config sidebar (names are JSON key paths).
const FACTORIO_CVAR_REF = [
  { name: 'name',              type: 'text',   group: 'server-settings.json', help: 'Server name shown in the browser' },
  { name: 'max_players',       type: 'number', default: 0, min: 0, max: 500, group: 'server-settings.json', help: '0 = unlimited' },
  { name: 'autosave_interval', type: 'number', default: 10, min: 1, max: 240, group: 'server-settings.json', help: 'Minutes between autosaves' },
  { name: 'auto_pause',        type: 'bool',   default: 1, group: 'server-settings.json', help: 'Pause the game when no players are connected' },
  { name: 'game_password',     type: 'text',   group: 'server-settings.json', help: 'Join password (blank = none)' },
  { name: 'enemy_evolution.enabled', type: 'bool', default: 1, group: 'map-settings.json', help: 'Biter evolution (new world only)' },
  { name: 'pollution.enabled',       type: 'bool', default: 1, group: 'map-settings.json', help: 'Pollution spread (new world only)' },
  { name: 'enemy_expansion.enabled', type: 'bool', default: 1, group: 'map-settings.json', help: 'Biter base expansion (new world only)' },
  { name: 'difficulty_settings.technology_price_multiplier', type: 'number', default: 1, min: 0.25, max: 10, group: 'map-settings.json', help: 'Research cost multiplier (new world only)' },
];

// '1' / '0' normalizer for the bool-ish world-rule toggles.
const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');

async function readJson(conn, path) {
  const text = await conn.fileText(path);
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

async function listSaves(conn) {
  try {
    const res = await conn.runShell(`ls -1 "${SAVES}"/*.zip 2>/dev/null`, { timeoutMs: 15_000 });
    return (res.stdout || '').split('\n')
      .map((l) => l.trim().replace(/^.*\//, '').replace(/\.zip$/, ''))
      .filter((n) => n.length > 0 && n !== '_active' && !n.startsWith('_autosave'));
  } catch {
    return [];
  }
}

export const factorioSpec = {
  id: 'factorio',

  configFiles: {
    'server-settings.json': SERVER_SETTINGS,
    'map-gen-settings.json': `${CONFIG}/map-gen-settings.json`,
    'map-settings.json':     MAP_SETTINGS,
  },

  rcon: {
    port: 'rconPort',
    portFallback: 27015,
    password: { file: `${CONFIG}/rconpw` },
    gateReason: 'RCON password file (/factorio/config/rconpw) not readable',
  },

  live: {
    actions: [
      { key: 'players',       label: 'List Players' },
      { key: 'time',          label: 'Map Time' },
      { key: 'show_evolution',label: 'Evolution %' },
      { key: 'save',          label: 'Save Now' },
      { key: 'peaceful_on',   label: 'Peaceful On' },
      { key: 'peaceful_off',  label: 'Peaceful Off' },
      { key: 'alwaysday_on',  label: 'Always Day On' },
      { key: 'alwaysday_off', label: 'Always Day Off' },
      // /c (console command), like /sc, DISABLES Steam achievements for the save
      // (surfaced in commandHint). The effect mutates the running save.
      { key: 'research_all',  label: 'Research All' },
      { key: 'cheat_mode_on', label: 'Cheat Mode On' },
    ],
    actionCmds: {
      players: '/players', time: '/time', show_evolution: '/evolution', save: '/server-save',
      peaceful_on:  '/sc game.surfaces[1].peaceful_mode=true',
      peaceful_off: '/sc game.surfaces[1].peaceful_mode=false',
      alwaysday_on: '/sc game.surfaces[1].always_day=true',
      alwaysday_off:'/sc game.surfaces[1].always_day=false',
      research_all: '/c game.forces.player.research_all_technologies()',
      cheat_mode_on:'/c for _,p in pairs(game.players) do p.cheat_mode=true end',
    },
    // Sliders pushed via /silent-command (disables achievements). Soft clamp:
    // a literal 0 is a real input (game_speed 0 clamps UP to 0.25, evolution 0
    // stays 0); an empty/non-numeric value falls back to `default`.
    controls: [
      { key: 'game_speed', label: 'Game Speed', min: 0.25, max: 4, step: 0.25, default: 1, suffix: '×',
        cmd: (n) => `/sc game.speed=${n}` },
      { key: 'evolution',  label: 'Evolution',  min: 0,    max: 1, step: 0.05, default: 0,
        cmd: (n) => `/sc game.forces["enemy"].set_evolution_factor(${n})` },
    ],
    commandHint: 'Factorio console, e.g. /players, /time, /server-save, /c game.speed=1. '
      + 'Note: /sc and /c controls — Game Speed, Evolution, Peaceful, Always Day, Research All, '
      + 'Cheat Mode — disable Steam achievements for the save.',
  },

  profile: {
    defaults() {
      return {
        saveName: '', serverName: 'Gamertown Factorio', description: '',
        maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
        autoPause: '1', evolutionEnabled: '1', pollutionEnabled: '1',
        expansionEnabled: '1', techPriceMultiplier: 1,
      };
    },

    validate(conn, s = {}) {
      const out = {};
      out.saveName = String(s.saveName ?? '').trim();
      if (out.saveName && !SAFE_NAME_RE.test(out.saveName)) throw badSetting('invalid world name');
      out.serverName  = String(s.serverName ?? '').slice(0, 200);
      out.description = String(s.description ?? '').slice(0, 500);
      const mp = Number(s.maxPlayers);
      if (!Number.isInteger(mp) || mp < 0 || mp > 500) throw badSetting('max players must be 0–500 (0 = unlimited)');
      out.maxPlayers = mp;
      out.visibility = s.visibility === 'public' ? 'public' : 'lan';
      out.password = String(s.password ?? '').slice(0, 100);
      const ai = Number(s.autosaveInterval);
      if (!Number.isInteger(ai) || ai < 1 || ai > 240) throw badSetting('autosave interval must be 1–240 minutes');
      out.autosaveInterval = ai;
      out.autoPause        = bool(s.autoPause);
      out.evolutionEnabled = bool(s.evolutionEnabled);
      out.pollutionEnabled = bool(s.pollutionEnabled);
      out.expansionEnabled = bool(s.expansionEnabled);
      const tpm = Number(s.techPriceMultiplier);
      if (!(tpm >= 0.25 && tpm <= 10)) throw badSetting('tech price multiplier must be 0.25–10');
      out.techPriceMultiplier = tpm;
      return out;
    },

    async schema(conn) {
      const saves = await listSaves(conn);
      const saveOpts = [{ value: '', label: '(keep current world)' }, ...saves.map((n) => ({ value: n, label: n }))];
      return {
        groups: [
          {
            key: 'world', title: 'World',
            fields: [
              { key: 'saveName', label: 'Active World', type: 'select', options: saveOpts, basic: true,
                help: 'Which saved world the server loads on (re)start. Create/copy/generate worlds in Quick Settings below.' },
            ],
          },
          {
            key: 'server', title: 'Server Settings',
            fields: [
              { key: 'serverName',  label: 'Server Name',  type: 'text', basic: true },
              { key: 'description', label: 'Description',   type: 'text' },
              { key: 'maxPlayers',  label: 'Max Players (0 = unlimited)', type: 'number', min: 0, max: 500, step: 1, basic: true },
              { key: 'visibility',  label: 'Visibility',    type: 'select', options: VISIBILITY_OPTS },
              { key: 'password',    label: 'Game Password (blank = none)', type: 'text', basic: true },
              { key: 'autosaveInterval', label: 'Autosave Interval (min)', type: 'number', min: 1, max: 240, step: 1 },
            ],
          },
          {
            key: 'rules', title: 'World Rules',
            fields: [
              { key: 'autoPause',        label: 'Auto-pause when empty', type: 'bool', basic: true },
              { key: 'evolutionEnabled', label: 'Biter Evolution',       type: 'bool', basic: true },
              { key: 'pollutionEnabled', label: 'Pollution',             type: 'bool', basic: true },
              { key: 'expansionEnabled', label: 'Biter Expansion',       type: 'bool', basic: true },
              { key: 'techPriceMultiplier', label: 'Research Cost ×', type: 'number', min: 0.25, max: 10, step: 0.25, basic: true,
                help: 'World rules below are baked into a save at generation — they only affect a NEWLY generated world.' },
            ],
          },
        ],
        note: PROFILE_NOTE,
        cvarRef: FACTORIO_CVAR_REF,
      };
    },

    async apply(conn, settings) {
      const s = factorioSpec.profile.validate(conn, settings);

      const json = await readJson(conn, SERVER_SETTINGS);
      json.name              = s.serverName;
      json.description       = s.description;
      json.max_players       = s.maxPlayers;
      json.visibility        = s.visibility === 'public'
        ? { public: true, lan: true }
        : { public: false, lan: true };
      json.game_password     = s.password;
      json.autosave_interval = s.autosaveInterval;
      json.auto_pause        = s.autoPause === '1';
      await conn.client.fileWrite(conn.vmid, SERVER_SETTINGS, JSON.stringify(json, null, 2) + '\n');

      // World rules → map-settings.json (generation-time truth; see PROFILE_NOTE).
      const mjson = await readJson(conn, MAP_SETTINGS);
      mjson.enemy_evolution = { ...(mjson.enemy_evolution || {}), enabled: s.evolutionEnabled === '1' };
      mjson.pollution       = { ...(mjson.pollution       || {}), enabled: s.pollutionEnabled === '1' };
      mjson.enemy_expansion = { ...(mjson.enemy_expansion || {}), enabled: s.expansionEnabled === '1' };
      mjson.difficulty_settings = {
        ...(mjson.difficulty_settings || {}),
        technology_price_multiplier: s.techPriceMultiplier,
      };
      await conn.client.fileWrite(conn.vmid, MAP_SETTINGS, JSON.stringify(mjson, null, 2) + '\n');

      // Stage the chosen save as the active world (takes effect on restart).
      if (s.saveName) {
        const res = await conn.runShell(`cp -f "${SAVES}/${s.saveName}.zip" "${ACTIVE}"`, { timeoutMs: 60_000 });
        if (res.exitCode !== 0) throw badSetting(`could not set active world: ${res.stderr || res.stdout}`);
      }
      return { ok: true };
    },

    // Capture clamps out-of-range hand-edited values to the validator's accepted
    // range so the capture↔apply round-trip can't throw. The container loads
    // _active.zip, so the original world name isn't recoverable — saveName stays ''.
    async capture(conn) {
      const json = await readJson(conn, SERVER_SETTINGS);
      const mjson = await readJson(conn, MAP_SETTINGS);
      return factorioSpec.profile.validate(conn, {
        serverName: json.name ?? '',
        description: json.description ?? '',
        maxPlayers: Number.isInteger(json.max_players) ? Math.max(0, Math.min(500, json.max_players)) : 0,
        visibility: json.visibility?.public ? 'public' : 'lan',
        password: json.game_password ?? '',
        autosaveInterval: Number.isInteger(json.autosave_interval) ? Math.max(1, Math.min(240, json.autosave_interval)) : 10,
        autoPause: json.auto_pause === false ? '0' : '1',
        evolutionEnabled: mjson.enemy_evolution?.enabled === false ? '0' : '1',
        pollutionEnabled: mjson.pollution?.enabled       === false ? '0' : '1',
        expansionEnabled: mjson.enemy_expansion?.enabled === false ? '0' : '1',
        techPriceMultiplier: Number.isFinite(mjson.difficulty_settings?.technology_price_multiplier)
          ? Math.max(0.25, Math.min(10, mjson.difficulty_settings.technology_price_multiplier)) : 1,
        saveName: '',
      });
    },
  },

  // ── quick settings: copy the live world to a named save ──────────────────────
  async getSettings() {
    return {
      sections: [
        {
          key: 'saveAs', title: 'Save Current World As', saveLabel: 'Save As',
          fields: [{ key: 'saveName', label: 'Save Name', type: 'text', value: '' }],
        },
      ],
      note: 'Copies the active world to a named save. World generation is a follow-up for the container build.',
    };
  },

  async setSettings(conn, values = {}) {
    const { section, saveName } = values;
    if (section !== 'saveAs') throw badSetting(`unknown section: ${section}`);
    const clean = String(saveName ?? '').trim();
    if (!clean || !SAFE_NAME_RE.test(clean)) throw badSetting('save name may only contain letters, digits, _ and - (max 64)');
    const res = await conn.runShell(`cp -f "${ACTIVE}" "${SAVES}/${clean}.zip"`, { timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw badSetting(`save failed: ${res.stderr || res.stdout}`);
    return { ok: true, action: 'saveAs', saveName: clean };
  },

  async connectPassword(conn) {
    const json = await readJson(conn, SERVER_SETTINGS);
    return typeof json.game_password === 'string' ? json.game_password : '';
  },

  // A true version bump needs a host `docker compose pull` — the app can't pull
  // images through the scoped socket-proxy.
  update: {
    kind: 'reboot',
    note: 'Restarted (re-validates the Factorio binary). To upgrade Factorio itself, bump the image '
      + 'tag / VERSION and run `docker compose pull` on the host — the app can\'t pull images.',
  },
};
