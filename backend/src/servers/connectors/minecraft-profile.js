// Pure server.properties profile logic, shared by the Proxmox (VM) and Docker
// Minecraft connectors. Everything here is transport-agnostic: it operates on the
// server.properties TEXT, so each connector just supplies read/write of that file
// (via the guest agent on a VM, or `cat`/`tee` in a container).

import { badSetting, SAFE_NAME_RE } from '../errors.js';

export const GAMEMODES    = ['survival', 'creative', 'adventure', 'spectator'];
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

export const PROFILE_NOTE =
  'A profile is the startup config the server boots as. Changes apply on the next restart.';

// server.properties is plain key=value (no quotes). Tiny get/set helpers. setProp
// uses a function replacer so a value with `$` isn't treated as a backreference.
export function getProp(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}
export function setProp(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return re.test(text) ? text.replace(re, () => line) : text.replace(/\n*$/, '') + `\n${line}\n`;
}

export function defaultProfileSettings() {
  return {
    world: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 20,
    motd: 'Gamertown', pvp: '1', hardcore: '0', whitelist: '0', onlineMode: '1',
    viewDistance: 10, spawnProtection: 16,
  };
}

export function validateProfileSettings(s = {}) {
  const out = {};
  out.world = String(s.world ?? '').trim();
  if (out.world && !SAFE_NAME_RE.test(out.world)) throw badSetting('invalid world name');
  out.gamemode   = GAMEMODES.includes(s.gamemode) ? s.gamemode : 'survival';
  out.difficulty = DIFFICULTIES.includes(s.difficulty) ? s.difficulty : 'normal';
  const intIn = (v, lo, hi, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw badSetting(`${label} must be ${lo}–${hi}`);
    return n;
  };
  out.maxPlayers      = intIn(s.maxPlayers, 1, 200, 'max players');
  out.viewDistance    = intIn(s.viewDistance, 3, 32, 'view distance');
  out.spawnProtection = intIn(s.spawnProtection, 0, 1000, 'spawn protection');
  const motd = String(s.motd ?? '');
  if (motd.length > 200 || /[\n\r]/.test(motd)) throw badSetting('motd must be ≤200 chars, single line');
  out.motd = motd;
  const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');
  out.pvp = bool(s.pvp); out.hardcore = bool(s.hardcore);
  out.whitelist = bool(s.whitelist); out.onlineMode = bool(s.onlineMode);
  return out;
}

// Validate `settings` and materialize them onto server.properties `text`,
// returning the new text. (Empty `world` keeps the current level-name.)
export function applyProps(text, settings) {
  const s = validateProfileSettings(settings);
  let out = text;
  const set = (k, v) => { out = setProp(out, k, v); };
  if (s.world) set('level-name', s.world);
  set('gamemode', s.gamemode);
  set('difficulty', s.difficulty);
  set('max-players', String(s.maxPlayers));
  set('motd', s.motd);
  set('pvp', s.pvp === '1' ? 'true' : 'false');
  set('hardcore', s.hardcore === '1' ? 'true' : 'false');
  set('white-list', s.whitelist === '1' ? 'true' : 'false');
  set('online-mode', s.onlineMode === '1' ? 'true' : 'false');
  set('view-distance', String(s.viewDistance));
  set('spawn-protection', String(s.spawnProtection));
  return out;
}

// Read server.properties `text` back into a validated settings doc (bools as 1/0).
export function captureProps(text) {
  const boolp = (k, def) => { const v = getProp(text, k); return v === 'true' ? '1' : v === 'false' ? '0' : def; };
  const nump  = (k, def) => { const v = Number(getProp(text, k)); return Number.isFinite(v) ? v : def; };
  return validateProfileSettings({
    world: (getProp(text, 'level-name') || 'world').trim(),
    gamemode: getProp(text, 'gamemode') || 'survival',
    difficulty: getProp(text, 'difficulty') || 'normal',
    maxPlayers: nump('max-players', 20),
    motd: getProp(text, 'motd') ?? '',
    pvp: boolp('pvp', '1'),
    hardcore: boolp('hardcore', '0'),
    whitelist: boolp('white-list', '0'),
    onlineMode: boolp('online-mode', '1'),
    viewDistance: nump('view-distance', 10),
    spawnProtection: nump('spawn-protection', 16),
  });
}

// The Profiles editor groups (World / Gameplay / Access). `worldOpts` is the
// connector-supplied <select> option list for the active world (it discovers
// worlds differently per transport).
export function profileGroups(worldOpts) {
  const enumOpts = (arr) => arr.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
  return [
    {
      key: 'world', title: 'World',
      fields: [
        { key: 'world', label: 'Active World', type: 'select', options: worldOpts,
          help: 'Which world the server loads on (re)start. Snapshot/back up worlds in Quick Settings below.' },
      ],
    },
    {
      key: 'gameplay', title: 'Gameplay',
      fields: [
        { key: 'gamemode',   label: 'Game Mode',  type: 'select', options: enumOpts(GAMEMODES) },
        { key: 'difficulty', label: 'Difficulty', type: 'select', options: enumOpts(DIFFICULTIES) },
        { key: 'hardcore',   label: 'Hardcore',   type: 'bool' },
        { key: 'pvp',        label: 'PvP',        type: 'bool' },
        { key: 'maxPlayers',      label: 'Max Players',   type: 'number', min: 1, max: 200, step: 1 },
        { key: 'viewDistance',    label: 'View Distance', type: 'number', min: 3, max: 32, step: 1 },
        { key: 'spawnProtection', label: 'Spawn Protection (blocks)', type: 'number', min: 0, max: 1000, step: 1 },
      ],
    },
    {
      key: 'access', title: 'Access',
      fields: [
        { key: 'whitelist',  label: 'Whitelist enabled', type: 'bool',
          help: 'Manage the player list with the in-game whitelist command or whitelist.json (Raw Config Files).' },
        { key: 'onlineMode', label: 'Online Mode (Mojang auth)', type: 'bool' },
        { key: 'motd',       label: 'MOTD (server-list message)', type: 'text' },
      ],
    },
  ];
}
