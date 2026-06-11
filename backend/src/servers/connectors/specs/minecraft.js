// Minecraft spec — image `itzg/minecraft-server`.
//
// Layout: the world + config files live under /data (the image's data volume).
// Live control is Source-RCON over TCP (the app reaches the container's RCON
// port by service name; itzg's default is 25575, overridable via the registry
// entry's `rconPort`) with the password from MINECRAFT_RCON_PASSWORD — the host
// secrets file via env, never the repo.
//
// PROFILE (a profile materializes onto server.properties keys)
//   Fields (defaults → on-disk key):
//     world (level-name, '' = keep current; SAFE_NAME_RE), gamemode (one of
//     GAMEMODES, else 'survival'), difficulty (DIFFICULTIES, else 'normal'),
//     maxPlayers (max-players, 1–200), motd (≤200, single line), pvp, hardcore,
//     whitelist (white-list), onlineMode (online-mode), allowNether (allow-nether),
//     spawnMonsters (spawn-monsters), commandBlocks (enable-command-block) — all
//     bool '1'/'0' here, written 'true'/'false' — viewDistance (view-distance,
//     3–32), simulationDistance (simulation-distance, 3–32), spawnProtection
//     (spawn-protection, 0–1000), playerIdleTimeout (player-idle-timeout, 0–1440).
//   validate: integer-bounds-checks the numbers (throws badSetting out of range),
//     normalizes enums to their fallbacks, coerces bools to '1'/'0', and bounds
//     the motd. Used directly by applyProps + captureProps.
//   apply (applyProps): validates `settings`, then setProp's each managed key onto
//     the existing server.properties text (empty world keeps the current
//     level-name) and writes it back.
//   capture (captureProps): getProp's each managed key out of the text into a doc,
//     then runs it back through the validator (so capture also bounds-checks).
//     CVAR_REF is the on-disk key reference for the Raw Config editor.

import { badSetting, SAFE_NAME_RE } from '../../errors.js';

const DATA  = '/data';
const PROPS = `${DATA}/server.properties`;
const MC_TARGET_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DIMENSION_MAP_IDS = {
  'minecraft:overworld': 'overworld',
  'minecraft:the_nether': 'nether',
  'minecraft:the_end': 'end',
};

export const GAMEMODES    = ['survival', 'creative', 'adventure', 'spectator'];
export const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

const PROFILE_NOTE =
  'A profile is the startup config the server boots as. Changes apply on the next restart.';

// ── server.properties text helpers ───────────────────────────────────────────
// server.properties is plain key=value (no quotes). Tiny get/set helpers. setProp
// uses a function replacer so a value with `$` isn't treated as a backreference.
function getProp(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}
function setProp(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return re.test(text) ? text.replace(re, () => line) : text.replace(/\n*$/, '') + `\n${line}\n`;
}

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
  set('simulation-distance', String(s.simulationDistance));
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
    simulationDistance: nump('simulation-distance', 10),
    playerIdleTimeout: nump('player-idle-timeout', 0),
  });
}

// The Profiles editor groups (World / Gameplay / Access). `worldOpts` is the
// discovered <select> option list for the active world.
function profileGroups(worldOpts) {
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
const CVAR_REF = [
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

// ── world discovery (for the profile world picker) ────────────────────────────
async function currentWorld(conn) {
  try {
    const { content = '' } = await conn.client.fileRead(conn.vmid, PROPS);
    return content.match(/^level-name\s*=\s*(.+)$/m)?.[1]?.trim() || 'world';
  } catch {
    return 'world';
  }
}

async function listWorlds(conn) {
  try {
    const res = await conn.runShell(
      `find "${DATA}" -maxdepth 2 -name level.dat -printf '%h\\n' 2>/dev/null | while read d; do basename "$d"; done`,
      { timeoutMs: 15_000 },
    );
    return (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── presence / position parsing (BlueMap live markers) ────────────────────────
function parseMinecraftVector(text, count) {
  const m = String(text || '').match(/\[\s*([-+]?\d+(?:\.\d+)?)(?:[dDfF])?\s*,\s*([-+]?\d+(?:\.\d+)?)(?:[dDfF])?(?:\s*,\s*([-+]?\d+(?:\.\d+)?)(?:[dDfF])?)?\s*\]/);
  if (!m) return null;
  const values = [Number(m[1]), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])];
  if (values.slice(0, count).some((n) => !Number.isFinite(n))) return null;
  return values;
}

// Whether an RCON `data get entity … Pos` reply contains a vector-looking value at all.
// A "no entity" reply (offline player) carries no `[…]` bracket ("No entity was found",
// "Found no elements"); a bracketed reply whose numbers don't parse is genuine corruption.
function hasVectorBracket(text) {
  return /\[/.test(String(text || ''));
}

function parseMinecraftDimension(text) {
  return String(text || '').match(/"([^"]+)"/)?.[1]
    || String(text || '').match(/\b(minecraft:[a-z0-9_./-]+)\b/)?.[1]
    || 'minecraft:overworld';
}

function mapIdForDimension(dimension) {
  return DIMENSION_MAP_IDS[dimension] || 'overworld';
}

function blueMapAnchor({ x, y, z, mapId }) {
  return `${mapId}:${Math.round(x)}:${Math.round(y)}:${Math.round(z)}:390:0.1:0.19:0:0:perspective`;
}

export function parseMinecraftPlayerList(text) {
  const body = String(text || '').split(':').slice(1).join(':').trim();
  if (!body) return [];
  return body
    .split(',')
    .map((p) => p.trim())
    .filter((p) => MC_TARGET_RE.test(p));
}

// Parse /data/usercache.json (itzg/minecraft-server) into a lowercased
// name→uuid map. Best-effort: any read/parse failure serves the last good map.
// TTL-cached per connector: the BlueMap marker tick calls listOnlinePlayers
// every few seconds, and a docker-exec cat per tick was the single biggest
// proxy-traffic cost. A brand-new player gets a default head for up to 60s.
const USERCACHE_TTL_MS = 60_000;
const usercacheByConn = new WeakMap();
async function usercache(conn) {
  const hit = usercacheByConn.get(conn);
  if (hit && Date.now() - hit.at < USERCACHE_TTL_MS) return hit.map;
  try {
    const { content = '' } = await conn.client.fileRead(conn.vmid, `${DATA}/usercache.json`);
    const map = new Map();
    for (const entry of JSON.parse(content || '[]')) {
      if (entry?.name && entry?.uuid) map.set(String(entry.name).toLowerCase(), String(entry.uuid));
    }
    usercacheByConn.set(conn, { at: Date.now(), map });
    return map;
  } catch {
    return hit?.map ?? new Map();
  }
}

export const minecraftSpec = {
  id: 'minecraft',

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
    password: { env: 'MINECRAFT_RCON_PASSWORD' },
    gateReason: 'MINECRAFT_RCON_PASSWORD is not set',
  },

  // No changeMapCmd — switching worlds is restart-only (the profile world picker).
  live: {
    actions: [
      { key: 'list', label: 'List Players' },
      { key: 'save', label: 'Save World' },
      { key: 'day',   label: 'Set Day' },
      { key: 'night', label: 'Set Night' },
      { key: 'clear', label: 'Clear Weather' },
      { key: 'rain',  label: 'Rain' },
      { key: 'keepinv_on',  label: 'Keep Inventory On' },
      { key: 'keepinv_off', label: 'Keep Inventory Off' },
      { key: 'mobs_on',  label: 'Mob Spawning On' },
      { key: 'mobs_off', label: 'Mob Spawning Off' },
      // Fun gamerule pack (Phase 2). NOTE: gamerules are saved per-world in level.dat, so
      // these PERSIST across container restarts — they are not ephemeral like Source cvars.
      // Only `thunder` (weather) is transient. snake_case rule names match the deployed
      // build (see the controls note below); host-validate if the pinned VERSION changes.
      { key: 'daycycle_on',     label: 'Day/Night Cycle On' },
      { key: 'daycycle_off',    label: 'Day/Night Cycle Off' },
      { key: 'griefing_on',     label: 'Mobs Break Blocks On' },
      { key: 'griefing_off',    label: 'Mobs Break Blocks Off' },
      { key: 'falldmg_on',      label: 'Fall Damage On' },
      { key: 'falldmg_off',     label: 'Fall Damage Off' },
      { key: 'instarespawn_on', label: 'Instant Respawn On' },
      { key: 'instarespawn_off',label: 'Instant Respawn Off' },
      { key: 'phantoms_on',     label: 'Phantoms On' },
      { key: 'phantoms_off',    label: 'Phantoms Off' },
      { key: 'firetick_on',     label: 'Fire Spreads On' },
      { key: 'firetick_off',    label: 'Fire Spreads Off' },
      { key: 'thunder',         label: 'Thunderstorm' },
    ],
    actionCmds: {
      list: 'list', save: 'save-all',
      day: 'time set day', night: 'time set night',
      clear: 'weather clear', rain: 'weather rain',
      keepinv_on:  'gamerule keep_inventory true',
      keepinv_off: 'gamerule keep_inventory false',
      mobs_on:  'gamerule spawn_mobs true',
      mobs_off: 'gamerule spawn_mobs false',
      daycycle_on:      'gamerule do_daylight_cycle true',
      daycycle_off:     'gamerule do_daylight_cycle false',
      griefing_on:      'gamerule mob_griefing true',
      griefing_off:     'gamerule mob_griefing false',
      falldmg_on:       'gamerule fall_damage true',
      falldmg_off:      'gamerule fall_damage false',
      instarespawn_on:  'gamerule do_immediate_respawn true',
      instarespawn_off: 'gamerule do_immediate_respawn false',
      phantoms_on:      'gamerule do_insomnia true',
      phantoms_off:     'gamerule do_insomnia false',
      firetick_on:      'gamerule do_fire_tick true',
      firetick_off:     'gamerule do_fire_tick false',
      thunder:          'weather thunder',
    },
    // Continuous live cvars → sliders. Soft clampNumber semantics (no `strict`):
    // 0 is a real value (time 0 stays 0) but an empty/non-numeric value maps to
    // `default`. NOTE: gamerule identifiers on the deployed build (validated live
    // against itzg/minecraft-server v26.1.2) are snake_case — keep_inventory,
    // random_tick_speed, players_sleeping_percentage — and mob spawning is the
    // renamed `spawn_mobs` rule (NOT do_mob_spawning). Re-validate with
    // backend/test-live/rcon-smoke.mjs if the pinned VERSION changes.
    controls: [
      { key: 'time',       label: 'Time of Day',       min: 0, max: 24000, step: 1000, default: 6000,
        cmd: (n) => `time set ${n}` },
      { key: 'randomtick', label: 'Random Tick Speed', min: 0, max: 20,    step: 1,    default: 3,
        cmd: (n) => `gamerule random_tick_speed ${n}` },
      { key: 'sleeppct',   label: 'Sleep %',           min: 0, max: 100,   step: 5,    default: 100, suffix: '%',
        cmd: (n) => `gamerule players_sleeping_percentage ${n}` },
    ],
    commandHint: 'Minecraft RCON',
  },

  profile: {
    defaults() {
      return {
        world: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 20,
        motd: 'Gamertown', pvp: '1', hardcore: '0', whitelist: '0', onlineMode: '1',
        viewDistance: 10, spawnProtection: 16,
        allowNether: '1', spawnMonsters: '1', commandBlocks: '0',
        simulationDistance: 10, playerIdleTimeout: 0,
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
    // Match getLive()'s gate: with no RCON password there's nothing to ask the server,
    // so short-circuit instead of opening a socket that rconExchange would just reject.
    const { password } = await conn.rconCreds();
    if (!password) return [];
    const { output } = await conn.runRcon('list');
    const names = parseMinecraftPlayerList(output);
    if (!names.length) return [];
    // RCON `list` is names-only, but live presence + the BlueMap skin markers need
    // the Mojang UUID. itzg/minecraft-server keeps a name→uuid cache on disk, so
    // resolve from there (best-effort — a brand-new player not yet cached comes
    // back uid:null and just falls back to a default head).
    const uuidByName = await usercache(conn);
    return names.map((name) => ({
      name,
      uid: uuidByName.get(name.toLowerCase()) || null,
      identityKind: 'minecraft',
    }));
  },

  async getPlayerPosition(conn, target) {
    const entity = String(target ?? '').trim();
    if (!MC_TARGET_RE.test(entity)) throw badSetting('invalid Minecraft player id');

    const rcon = (cmd) => conn.runRcon(cmd).then((r) => r.output);
    const [posOut, dimOut, rotOut] = await Promise.all([
      rcon(`data get entity ${entity} Pos`),
      rcon(`data get entity ${entity} Dimension`),
      rcon(`data get entity ${entity} Rotation`).catch(() => ''),
    ]);
    const pos = parseMinecraftVector(posOut, 3);
    if (!pos) {
      // An offline / just-left player has no entity to query, so RCON answers with a
      // not-found message (no `[x, y, z]` vector). Mirror the Factorio connector's
      // graceful offline shape so the map UI gets `connected:false` instead of a 400.
      // Only a vector-LOOKING reply whose numbers aren't finite is genuine corruption.
      if (!hasVectorBracket(posOut)) {
        return {
          connected: false,
          reason: 'player is not online',
          name: entity,
          updatedAt: new Date().toISOString(),
        };
      }
      throw badSetting('could not parse Minecraft player position');
    }
    const rot = parseMinecraftVector(rotOut, 2) || [null, null];
    const dimension = parseMinecraftDimension(dimOut);
    const out = {
      x: pos[0],
      y: pos[1],
      z: pos[2],
      dimension,
      mapId: mapIdForDimension(dimension),
      yaw: rot[0],
      pitch: rot[1],
      updatedAt: new Date().toISOString(),
    };
    return { ...out, anchor: blueMapAnchor(out) };
  },

  // itzg/minecraft-server re-resolves + downloads the configured VERSION on every
  // start, so updating the server jar is just a restart. Set VERSION=LATEST in the
  // compose env to track the newest release; otherwise it re-pulls the pinned one.
  update: {
    kind: 'reboot',
    note: 'Restarted — itzg/minecraft-server re-downloaded the configured VERSION on boot. '
      + 'Set VERSION=LATEST in servers.compose.yml to always pull the newest release.',
  },
};
