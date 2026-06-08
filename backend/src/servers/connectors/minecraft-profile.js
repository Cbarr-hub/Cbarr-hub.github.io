// Pure server.properties profile logic, shared by the base (VM) and Docker
// Minecraft connectors. Everything here is transport-agnostic: it operates on the
// server.properties TEXT, so each connector just supplies read/write of that file
// (via the guest agent on a VM, or `cat`/`tee` in a container).
//
// PROFILE SCHEMA (a profile materializes onto server.properties keys)
//   Fields (defaultProfileSettings → on-disk key):
//     world (level-name, '' = keep current; SAFE_NAME_RE), gamemode (one of
//     GAMEMODES, else 'survival'), difficulty (DIFFICULTIES, else 'normal'),
//     maxPlayers (max-players, 1–200), motd (≤200, single line), pvp, hardcore,
//     whitelist (white-list), onlineMode (online-mode), allowNether (allow-nether),
//     spawnMonsters (spawn-monsters), commandBlocks (enable-command-block) — all
//     bool '1'/'0' here, written 'true'/'false' — viewDistance (view-distance,
//     3–32), simulationDistance (simulation-distance, 3–32), spawnProtection
//     (spawn-protection, 0–1000), playerIdleTimeout (player-idle-timeout, 0–1440).
//   validate (validateProfileSettings): integer-bounds-checks the numbers (throws
//     badSetting out of range), normalizes enums to their fallbacks, coerces bools
//     to '1'/'0', and bounds the motd. Used directly by applyProps + captureProps.
//   apply (applyProps): validates `settings`, then setProp's each managed key onto
//     the existing server.properties text (empty world keeps the current level-name)
//     and returns the new text — the connector just writes it back.
//   capture (captureProps): getProp's each managed key out of the text into a doc,
//     then runs it back through validateProfileSettings (so capture also bounds-
//     checks). CVAR_REF is the on-disk key reference for the Raw Config editor.

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
    allowNether: '1', spawnMonsters: '1', commandBlocks: '0',
    simulationDistance: 10, playerIdleTimeout: 0,
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
  out.maxPlayers      = intIn(s.maxPlayers ?? 20, 1, 200, 'max players');
  out.viewDistance    = intIn(s.viewDistance ?? 10, 3, 32, 'view distance');
  out.spawnProtection = intIn(s.spawnProtection ?? 16, 0, 1000, 'spawn protection');
  out.simulationDistance = intIn(s.simulationDistance ?? 10, 3, 32, 'simulation distance');
  out.playerIdleTimeout  = intIn(s.playerIdleTimeout ?? 0, 0, 1440, 'idle timeout');
  const motd = String(s.motd ?? '');
  if (motd.length > 200 || /[\n\r]/.test(motd)) throw badSetting('motd must be ≤200 chars, single line');
  out.motd = motd;
  const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');
  out.pvp = bool(s.pvp); out.hardcore = bool(s.hardcore);
  out.whitelist = bool(s.whitelist); out.onlineMode = bool(s.onlineMode);
  out.allowNether   = bool(s.allowNether ?? '1');
  out.spawnMonsters = bool(s.spawnMonsters ?? '1');
  out.commandBlocks = bool(s.commandBlocks ?? '0');
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
  set('allow-nether', s.allowNether === '1' ? 'true' : 'false');
  set('spawn-monsters', s.spawnMonsters === '1' ? 'true' : 'false');
  set('enable-command-block', s.commandBlocks === '1' ? 'true' : 'false');
  set('simulation-distance', String(s.simulationDistance));
  set('player-idle-timeout', String(s.playerIdleTimeout));
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
    allowNether: boolp('allow-nether', '1'),
    spawnMonsters: boolp('spawn-monsters', '1'),
    commandBlocks: boolp('enable-command-block', '0'),
    simulationDistance: nump('simulation-distance', 10),
    playerIdleTimeout: nump('player-idle-timeout', 0),
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
        { key: 'world', label: 'Active World', type: 'select', options: worldOpts, basic: true,
          help: 'Which world the server loads on (re)start. Snapshot/back up worlds in Quick Settings below.' },
      ],
    },
    {
      key: 'gameplay', title: 'Gameplay',
      fields: [
        { key: 'gamemode',   label: 'Game Mode',  type: 'select', options: enumOpts(GAMEMODES), basic: true },
        { key: 'difficulty', label: 'Difficulty', type: 'select', options: enumOpts(DIFFICULTIES), basic: true },
        { key: 'hardcore',   label: 'Hardcore',   type: 'bool', basic: true },
        { key: 'pvp',        label: 'PvP',        type: 'bool', basic: true },
        { key: 'allowNether',   label: 'Allow Nether',   type: 'bool' },
        { key: 'spawnMonsters', label: 'Spawn Monsters', type: 'bool' },
        { key: 'commandBlocks', label: 'Command Blocks',  type: 'bool' },
        { key: 'maxPlayers',      label: 'Max Players',   type: 'number', min: 1, max: 200, step: 1, basic: true },
        { key: 'viewDistance',    label: 'View Distance', type: 'number', min: 3, max: 32, step: 1 },
        { key: 'simulationDistance', label: 'Simulation Distance', type: 'number', min: 3, max: 32, step: 1 },
        { key: 'spawnProtection', label: 'Spawn Protection (blocks)', type: 'number', min: 0, max: 1000, step: 1 },
        { key: 'playerIdleTimeout',  label: 'Idle Kick (min, 0=off)', type: 'number', min: 0, max: 1440, step: 1 },
      ],
    },
    {
      key: 'access', title: 'Access',
      fields: [
        { key: 'whitelist',  label: 'Whitelist enabled', type: 'bool', basic: true,
          help: 'Manage the player list with the in-game whitelist command or whitelist.json (Raw Config Files).' },
        { key: 'onlineMode', label: 'Online Mode (Mojang auth)', type: 'bool' },
        { key: 'motd',       label: 'MOTD (server-list message)', type: 'text', basic: true },
      ],
    },
  ];
}

// Reference catalog of the server.properties keys this connector manages — the
// Raw Config tab reads it for autocomplete + inline docs (name is the on-disk
// key, not the camelCase settings key). Booleans are 'true'/'false' in the file.
export const CVAR_REF = [
  { name: 'gamemode',             type: 'select', default: 'survival', group: 'gameplay', help: GAMEMODES.join(' / ') },
  { name: 'difficulty',           type: 'select', default: 'normal',   group: 'gameplay', help: DIFFICULTIES.join(' / ') },
  { name: 'hardcore',             type: 'bool',   default: 'false',    group: 'gameplay' },
  { name: 'pvp',                  type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'allow-nether',         type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'spawn-monsters',       type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'enable-command-block', type: 'bool',   default: 'false',    group: 'gameplay' },
  { name: 'max-players',          type: 'number', default: 20, min: 1, max: 200,  group: 'gameplay' },
  { name: 'view-distance',        type: 'number', default: 10, min: 3, max: 32,   group: 'gameplay' },
  { name: 'simulation-distance',  type: 'number', default: 10, min: 3, max: 32,   group: 'gameplay' },
  { name: 'spawn-protection',     type: 'number', default: 16, min: 0, max: 1000, group: 'gameplay' },
  { name: 'player-idle-timeout',  type: 'number', default: 0,  min: 0, max: 1440, group: 'gameplay', help: 'minutes; 0 = off' },
  { name: 'white-list',           type: 'bool',   default: 'false',    group: 'access' },
  { name: 'online-mode',          type: 'bool',   default: 'true',     group: 'access' },
  { name: 'motd',                 type: 'text',   default: 'Gamertown', group: 'access' },
  { name: 'level-name',           type: 'text',   default: 'world',    group: 'world' },
];
