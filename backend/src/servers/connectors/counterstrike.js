// Counter-Strike 2 connector — LinuxGSM instance `cs2server`.
//
// Verified layout (VM 100, 192.168.1.75) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/csserver   (owned by user `miles`)
//   control     : ./cs2server start|stop|restart|update   (run as miles)
//
// Quick settings (map + game mode + max players) are stored in the LinuxGSM
// instance config and applied to the launch command. They take effect on the
// next server restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVars } from '../cfgvars.js';

const DIR = '/home/miles/csserver';
const INSTANCE_CFG = `${DIR}/lgsm/config-lgsm/cs2server/cs2server.cfg`;
const MAPS_DIR = `${DIR}/serverfiles/game/csgo/maps`;

// CS2 game modes are the (game_type, game_mode) launch cvar pair.
const MODES = {
  competitive: { type: 0, mode: 1, label: 'Competitive' },
  wingman:     { type: 0, mode: 2, label: 'Wingman (2v2)' },
  casual:      { type: 0, mode: 0, label: 'Casual' },
  deathmatch:  { type: 1, mode: 2, label: 'Deathmatch' },
  armsrace:    { type: 1, mode: 0, label: 'Arms Race' },
  demolition:  { type: 1, mode: 1, label: 'Demolition' },
};
const MODE_KEYS = Object.keys(MODES);

// Reasonable fallback if the maps directory can't be listed.
const STOCK_MAPS = [
  'de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage',
  'de_nuke', 'de_overpass', 'de_train', 'de_vertigo', 'cs_italy', 'cs_office',
];

// The launch line we manage. LGSM expands the ${...} refs itself, so they stay
// literal in the file. Only +game_type / +game_mode change per game mode.
function startParameters(type, mode) {
  return `-dedicated -ip \${ip} -port \${port} -maxplayers \${maxplayers} ` +
    `-authkey \${wsapikey} +game_type ${type} +game_mode ${mode} +exec \${selfname}.cfg`;
}

function modeKeyFromTypeMode(type, mode) {
  return MODE_KEYS.find((k) => MODES[k].type === Number(type) && MODES[k].mode === Number(mode));
}

export class CounterStrikeConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'cs2server';

  configFiles = {
    'server.cfg': `${DIR}/serverfiles/game/csgo/cfg/cs2server.cfg`,
    'lgsm.cfg': INSTANCE_CFG,
    'lgsm-common.cfg': `${DIR}/lgsm/config-lgsm/cs2server/common.cfg`,
  };

  // List installed, playable maps (drop _vanity duplicates and non-game vpks).
  async #listMaps() {
    try {
      const res = await this.runShell(`ls -1 ${MAPS_DIR}/*.vpk 2>/dev/null`, { asUser: this.gsmUser, timeoutMs: 15_000 });
      const names = (res.stdout || '')
        .split('\n')
        .map((l) => l.trim().replace(/^.*\//, '').replace(/\.vpk$/, ''))
        .filter((n) => /^(de|cs|ar|dz|gd|coop)_/.test(n) && !n.endsWith('_vanity'));
      const uniq = [...new Set(names)].sort();
      return uniq.length ? uniq : STOCK_MAPS;
    } catch {
      return STOCK_MAPS;
    }
  }

  async getSettings() {
    const { content } = await this.client.agentFileRead(this.vmid, INSTANCE_CFG)
      .then((r) => ({ content: r.content ?? '' }))
      .catch(() => ({ content: '' }));

    const startmap = getVar(content, 'startmap') || 'de_dust2';
    const wsstartmap = getVar(content, 'wsstartmap') || '';
    const maxplayers = Number(getVar(content, 'maxplayers') || 10);
    const sp = getVar(content, 'startparameters') || '';
    const mm = sp.match(/\+game_type\s+(\d+)\s+\+game_mode\s+(\d+)/);
    const modeKey = (mm && modeKeyFromTypeMode(mm[1], mm[2])) || 'competitive';

    const maps = await this.#listMaps();
    // Ensure the current map is selectable even if not in the listed set.
    const mapOptions = [...new Set([startmap, ...maps])].map((m) => ({ value: m, label: m }));

    return {
      fields: [
        { key: 'map', label: 'Starting Map', type: 'select', value: startmap, options: mapOptions },
        { key: 'gameMode', label: 'Game Mode', type: 'select', value: modeKey,
          options: MODE_KEYS.map((k) => ({ value: k, label: MODES[k].label })) },
        { key: 'maxPlayers', label: 'Max Players', type: 'number', value: maxplayers, min: 1, max: 64 },
      ],
      note: wsstartmap
        ? 'A Workshop start-map is currently set; choosing a stock map here clears it. Changes apply on restart.'
        : 'Changes apply on the next server restart.',
    };
  }

  async setSettings(values = {}) {
    const { map, gameMode, maxPlayers } = values;
    if (gameMode !== undefined && !MODES[gameMode]) {
      const e = new Error(`invalid game mode: ${gameMode}`); e.code = 'BAD_SETTING'; throw e;
    }
    const mp = maxPlayers === undefined ? undefined : Number(maxPlayers);
    if (mp !== undefined && (!Number.isInteger(mp) || mp < 1 || mp > 64)) {
      const e = new Error('maxPlayers must be an integer 1–64'); e.code = 'BAD_SETTING'; throw e;
    }
    if (map !== undefined && !/^[a-z0-9_]{1,64}$/.test(map)) {
      const e = new Error(`invalid map name: ${map}`); e.code = 'BAD_SETTING'; throw e;
    }

    const { content } = await this.client.agentFileRead(this.vmid, INSTANCE_CFG);
    const updates = {};
    if (map !== undefined) { updates.startmap = map; updates.wsstartmap = ''; } // stock map → clear workshop
    if (mp !== undefined) updates.maxplayers = String(mp);
    if (gameMode !== undefined) {
      const { type, mode } = MODES[gameMode];
      updates.startparameters = startParameters(type, mode);
    }
    const next = setVars(content, updates);
    await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, next);
    return { ok: true, applied: { map, gameMode, maxPlayers: mp } };
  }
}
