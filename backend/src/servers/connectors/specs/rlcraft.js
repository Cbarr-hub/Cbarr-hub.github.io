// RLCraft spec — modded Minecraft (Forge 1.12.2, modpack v2.9.3) on the
// `itzg/minecraft-server:java8` image. Same /data layout + vanilla RCON as the
// regular Minecraft server, so it REUSES minecraft.js's version-agnostic plumbing
// (server.properties text helpers, world discovery, usercache UUID resolution,
// the player-list parser). It OVERRIDES only what differs on 1.12.2:
//   • gamerules are camelCase (keepInventory, doDaylightCycle, …) and a smaller
//     set — the modern snake_case rules (do_insomnia, players_sleeping_percentage,
//     do_immediate_respawn, fall_damage) don't exist here, so they're dropped;
//   • `simulation-distance` is a 1.18+ property — dropped from the profile;
//   • there's no `data get entity` command (1.13+), so getPlayerPosition is
//     omitted (BlueMap doesn't support 1.12.2 anyway — no web map for RLCraft).
// Live control is RCON (itzg default 25575, password from RLCRAFT_RCON_PASSWORD).

import { badSetting, SAFE_NAME_RE } from '../../errors.js';
import {
  getProp, setProp, listWorlds, currentWorld, usercache,
  parseMinecraftPlayerList, GAMEMODES, DIFFICULTIES, PROFILE_NOTE,
} from './minecraft.js';

const DATA  = '/data';
const PROPS = `${DATA}/server.properties`;

export { GAMEMODES, DIFFICULTIES };

// ── profile validation (server.properties; bools as '1'/'0' here, 'true'/'false'
// on disk). Mirrors minecraft.js minus `simulationDistance` (1.18+ only). ───────
function validateProfileSettings(s = {}) {
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

// Materialize validated settings onto the text (empty `world` keeps level-name).
function applyProps(text, settings) {
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
  set('player-idle-timeout', String(s.playerIdleTimeout));
  return out;
}

// Read server.properties `text` back into a validated settings doc (bools as 1/0).
function captureProps(text) {
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
    playerIdleTimeout: nump('player-idle-timeout', 0),
  });
}

// The Profiles editor groups (World / Gameplay / Access) — minecraft.js minus
// the simulationDistance field.
function profileGroups(worldOpts) {
  const enumOpts = (arr) => arr.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
  return [
    {
      key: 'world', title: 'World',
      fields: [
        { key: 'world', label: 'Active World', type: 'select', options: worldOpts, basic: true,
          help: 'Which world the server loads on (re)start. RLCraft worlds are large — back up before switching.' },
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

// Raw Config tab reference (on-disk keys). 1.12.2 set — no simulation-distance.
const CVAR_REF = [
  { name: 'gamemode',             type: 'select', default: 'survival', group: 'gameplay', help: GAMEMODES.join(' / ') },
  { name: 'difficulty',           type: 'select', default: 'normal',   group: 'gameplay', help: DIFFICULTIES.join(' / ') },
  { name: 'hardcore',             type: 'bool',   default: 'false',    group: 'gameplay' },
  { name: 'pvp',                  type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'allow-nether',         type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'spawn-monsters',       type: 'bool',   default: 'true',     group: 'gameplay' },
  { name: 'enable-command-block', type: 'bool',   default: 'true',     group: 'gameplay', help: 'RLCraft structures depend on this' },
  { name: 'max-players',          type: 'number', default: 20, min: 1, max: 200,  group: 'gameplay' },
  { name: 'view-distance',        type: 'number', default: 10, min: 3, max: 32,   group: 'gameplay' },
  { name: 'spawn-protection',     type: 'number', default: 16, min: 0, max: 1000, group: 'gameplay' },
  { name: 'player-idle-timeout',  type: 'number', default: 0,  min: 0, max: 1440, group: 'gameplay', help: 'minutes; 0 = off' },
  { name: 'white-list',           type: 'bool',   default: 'false',    group: 'access' },
  { name: 'online-mode',          type: 'bool',   default: 'true',     group: 'access' },
  { name: 'motd',                 type: 'text',   default: 'Gamertown', group: 'access' },
  { name: 'level-name',           type: 'text',   default: 'world',    group: 'world' },
  { name: 'level-type',           type: 'text',   default: 'BIOMESOP', group: 'world', help: 'first-boot only (set via LEVEL_TYPE env)' },
];

export const rlcraftSpec = {
  id: 'rlcraft',

  configFiles: {
    'server.properties':   PROPS,
    'whitelist.json':      `${DATA}/whitelist.json`,
    'ops.json':            `${DATA}/ops.json`,
    'banned-players.json': `${DATA}/banned-players.json`,
    'banned-ips.json':     `${DATA}/banned-ips.json`,
  },

  rcon: {
    port: 'rconPort',
    portFallback: 25575,
    password: { env: 'RLCRAFT_RCON_PASSWORD' },
    gateReason: 'RLCRAFT_RCON_PASSWORD is not set',
  },

  // No changeMapCmd — switching worlds is restart-only (the profile world picker).
  // 1.12.2 gamerules are camelCase; only rules that exist in 1.12.2 are advertised
  // (dropped vs vanilla minecraft: fall_damage, do_immediate_respawn, do_insomnia,
  // players_sleeping_percentage — none exist on 1.12.2).
  live: {
    actions: [
      { key: 'list', label: 'List Players' },
      { key: 'save', label: 'Save World' },
      { key: 'day',   label: 'Set Day' },
      { key: 'night', label: 'Set Night' },
      { key: 'clear', label: 'Clear Weather' },
      { key: 'rain',  label: 'Rain' },
      { key: 'thunder', label: 'Thunderstorm' },
      { key: 'keepinv_on',  label: 'Keep Inventory On' },
      { key: 'keepinv_off', label: 'Keep Inventory Off' },
      { key: 'mobs_on',  label: 'Mob Spawning On' },
      { key: 'mobs_off', label: 'Mob Spawning Off' },
      { key: 'daycycle_on',  label: 'Day/Night Cycle On' },
      { key: 'daycycle_off', label: 'Day/Night Cycle Off' },
      { key: 'griefing_on',  label: 'Mobs Break Blocks On' },
      { key: 'griefing_off', label: 'Mobs Break Blocks Off' },
      { key: 'firetick_on',  label: 'Fire Spreads On' },
      { key: 'firetick_off', label: 'Fire Spreads Off' },
    ],
    actionCmds: {
      list: 'list', save: 'save-all',
      day: 'time set day', night: 'time set night',
      clear: 'weather clear', rain: 'weather rain', thunder: 'weather thunder',
      keepinv_on:  'gamerule keepInventory true',
      keepinv_off: 'gamerule keepInventory false',
      mobs_on:  'gamerule doMobSpawning true',
      mobs_off: 'gamerule doMobSpawning false',
      daycycle_on:  'gamerule doDaylightCycle true',
      daycycle_off: 'gamerule doDaylightCycle false',
      griefing_on:  'gamerule mobGriefing true',
      griefing_off: 'gamerule mobGriefing false',
      firetick_on:  'gamerule doFireTick true',
      firetick_off: 'gamerule doFireTick false',
    },
    // Soft clamp (no `strict`): 0 is a real value, empty/non-numeric → default.
    // randomTickSpeed is camelCase on 1.12.2; sleeppct dropped (1.17+ rule).
    controls: [
      { key: 'time',       label: 'Time of Day',       min: 0, max: 24000, step: 1000, default: 6000,
        cmd: (n) => `time set ${n}` },
      { key: 'randomtick', label: 'Random Tick Speed', min: 0, max: 20,    step: 1,    default: 3,
        cmd: (n) => `gamerule randomTickSpeed ${n}` },
    ],
    commandHint: 'Minecraft RCON (Forge 1.12.2)',
  },

  profile: {
    defaults() {
      return {
        world: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 20,
        motd: 'Gamertown', pvp: '1', hardcore: '0', whitelist: '0', onlineMode: '1',
        viewDistance: 10, spawnProtection: 16,
        allowNether: '1', spawnMonsters: '1', commandBlocks: '0',
        playerIdleTimeout: 0,
      };
    },

    validate(conn, s = {}) {
      return validateProfileSettings(s);
    },

    async schema(conn) {
      const [worlds, current] = await Promise.all([listWorlds(conn), currentWorld(conn)]);
      const names = [...new Set([current, ...worlds].filter(Boolean))];
      const worldOpts = [{ value: '', label: '(keep current world)' }, ...names.map((w) => ({ value: w, label: w }))];
      return { groups: profileGroups(worldOpts), note: PROFILE_NOTE, cvarRef: CVAR_REF };
    },

    async apply(conn, settings) {
      const text = (await conn.client.fileRead(conn.vmid, PROPS)).content ?? '';
      await conn.client.fileWrite(conn.vmid, PROPS, applyProps(text, settings));
      return { ok: true };
    },

    async capture(conn) {
      return captureProps(await conn.fileText(PROPS));
    },
  },

  async listOnlinePlayers(conn) {
    // Match getLive()'s gate: no RCON password → nothing to ask the server.
    const { password } = await conn.rconCreds();
    if (!password) return [];
    const { output } = await conn.runRcon('list');
    const names = parseMinecraftPlayerList(output);
    if (!names.length) return [];
    // RCON `list` is names-only; resolve Mojang UUIDs from the on-disk usercache
    // (a not-yet-cached player comes back uid:null → default head).
    const uuidByName = await usercache(conn);
    return names.map((name) => ({
      name,
      uid: uuidByName.get(name.toLowerCase()) || null,
      identityKind: 'minecraft',
    }));
  },

  // No getPlayerPosition: 1.12.2 has no `data get entity`, and BlueMap doesn't
  // support < 1.13, so there's no map to feed positions to. The engine
  // feature-detects this, so omitting it cleanly disables position queries.

  // The image re-resolves the configured pack/VERSION on every start — update =
  // restart. A true RLCraft pack bump is a CF_FILE_ID change + redeploy.
  update: {
    kind: 'reboot',
    note: 'Restarted — itzg/minecraft-server re-resolved the configured RLCraft pack on boot. '
      + 'To move to a new RLCraft release, bump CF_FILE_ID in servers.compose.yml and redeploy.',
  },
};
