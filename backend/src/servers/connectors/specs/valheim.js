// Valheim spec — image `ghcr.io/community-valheim-tools/valheim-server`
// (lloesche/valheim-server-docker: steamcmd install, idle-gated auto-update,
// zip backups, supervisord; /config = worlds + lists + backups).
//
// Valheim has NO RCON / remote console. This spec therefore deliberately omits:
//   - `rcon` + `live`         → the Runtime tab reports "no live control"; profile
//                               startup commands skip gracefully (engine.js).
//   - `listOnlinePlayers`     → the A2S query the image exposes reports EMPTY player
//                               names for Valheim, so a live overlay is impossible.
//                               Presence comes from the host session-tracker tailing
//                               the container log (online-parse.js parseValheimLog).
//   - `getPlayerPosition`     → no web map for Valheim.
//   - `getSettings` (Save As) → the image's own BACKUPS cron zips /config/worlds_local.
//
// Boot config = the container env (SERVER_NAME / WORLD_NAME / SERVER_PASS /
// SERVER_ARGS), which the app can't change (compose owns it). Profiles therefore
// write /config/gamertown.env, which servers.compose.yml's PRE_SERVER_RUN_HOOK
// sources in the launcher's OWN shell right before it builds the command line
// (`. /config/gamertown.env`), so the file overrides the env on every (re)start.
// An EMPTY profile field means "inherit the compose value" — the auto-seeded
// Default profile only pins the save cadence (which equals the game defaults).
// Deleting the file falls all the way back to compose.

import { badSetting, SAFE_NAME_RE } from '../../errors.js';

const CONFIG = '/config';
const WORLDS = `${CONFIG}/worlds_local`;
export const PROFILE_ENV = `${CONFIG}/gamertown.env`;

// World-modifier vocab (Valheim ≥ 0.217 "World Modifiers"; `-preset` applies a
// bundle, `-modifier` tunes one axis, `-setkey` toggles a global key). The launcher
// must see `-preset` FIRST, then `-modifier`, then `-setkey` — later args win.
export const PRESETS = ['normal', 'casual', 'easy', 'hard', 'hardcore', 'immersive', 'hammer'];
export const MODIFIERS = {
  combat:       ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources:    ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids:        ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals:      ['casual', 'hard', 'veryhard'],
};
export const SETKEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];

const MODIFIER_LABEL = {
  combat: 'Combat', deathpenalty: 'Death Penalty', resources: 'Resources', raids: 'Raids', portals: 'Portals',
};
const SETKEY_LABEL = {
  nobuildcost: 'No build cost', playerevents: 'Player-based events',
  passivemobs: 'Passive mobs', nomap: 'No map',
};

const PROFILE_NOTE =
  'A profile is the startup config the server boots as; Apply writes /config/gamertown.env and restarts ' +
  'the container (the image sources that file right before launching the game, overriding the compose ' +
  'environment). Empty fields inherit the compose value. World modifiers are rendered as ' +
  '-preset, then -modifier, then -setkey (later flags win). Valheim has no remote console, so there is ' +
  'no live control and no startup commands — everything is boot config.';

// Embedded reference for the Config sidebar (names are launcher flags / env keys).
const VALHEIM_CVAR_REF = [
  { name: 'SERVER_NAME',   type: 'text',   group: 'gamertown.env', help: 'Server browser name (-name)' },
  { name: 'WORLD_NAME',    type: 'text',   group: 'gamertown.env', help: 'World file under worlds_local (-world); a new name creates a new world' },
  { name: 'SERVER_PASS',   type: 'text',   group: 'gamertown.env', help: 'Join password, ≥5 chars, not contained in the world name (-password)' },
  { name: '-preset',       type: 'text',   group: 'SERVER_ARGS', help: PRESETS.join(' | ') },
  { name: '-modifier',     type: 'text',   group: 'SERVER_ARGS', help: 'combat | deathpenalty | resources | raids | portals <value>' },
  { name: '-setkey',       type: 'text',   group: 'SERVER_ARGS', help: SETKEYS.join(' | ') },
  { name: '-saveinterval', type: 'number', default: 1800, min: 300, max: 7200, group: 'SERVER_ARGS', help: 'Seconds between world saves' },
  { name: '-backups',      type: 'number', default: 4, min: 1, max: 20, group: 'SERVER_ARGS', help: 'Rolling in-game backups to keep' },
  { name: 'adminlist.txt', type: 'text',   group: 'lists', help: 'One SteamID64 per line (F2 in-game shows IDs); // comments' },
];

const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');

// ── shell-env file helpers ─────────────────────────────────────────────────────
// The file is SOURCED by bash, so every value is single-quoted (the only shell
// quoting with no expansions); an embedded ' becomes '\''.
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function unquote(raw) {
  const v = String(raw ?? '').trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/'\\''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/** Parse the KEY=value lines of gamertown.env (comments/blank lines ignored). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** Render the validated profile as SERVER_ARGS: -preset, then -modifier, then -setkey, then save cadence. */
export function renderServerArgs(s) {
  const args = [];
  if (s.preset) args.push('-preset', s.preset);
  for (const key of Object.keys(MODIFIERS)) if (s[key]) args.push('-modifier', key, s[key]);
  for (const key of SETKEYS) if (s[key] === '1') args.push('-setkey', key);
  args.push('-saveinterval', String(s.saveInterval), '-backups', String(s.backups));
  return args.join(' ');
}

/** Inverse of renderServerArgs (unknown flags are ignored, never fatal). */
export function parseServerArgs(text) {
  const out = {};
  const t = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < t.length; i++) {
    const flag = t[i];
    if (flag === '-preset')            out.preset = t[++i] ?? '';
    else if (flag === '-modifier')     { const k = t[++i]; const v = t[++i]; if (k && v && MODIFIERS[k]) out[k] = v; }
    else if (flag === '-setkey')       { const k = t[++i]; if (k && SETKEYS.includes(k)) out[k] = '1'; }
    else if (flag === '-saveinterval') out.saveInterval = Number(t[++i]);
    else if (flag === '-backups')      out.backups = Number(t[++i]);
  }
  return out;
}

/** The exact file Apply writes for a validated profile doc. */
export function renderEnvFile(s) {
  const lines = [
    '# Managed by the Gamertown servers panel (Profiles → Apply).',
    '# Sourced by the container\'s PRE_SERVER_RUN_HOOK right before each server start;',
    '# keys here override the compose environment. Delete this file to fall back to compose.',
  ];
  if (s.serverName) lines.push(`SERVER_NAME=${shellQuote(s.serverName)}`);
  const world = s.newWorld || s.world;
  if (world)        lines.push(`WORLD_NAME=${shellQuote(world)}`);
  if (s.password)   lines.push(`SERVER_PASS=${shellQuote(s.password)}`);
  lines.push(`SERVER_ARGS=${shellQuote(renderServerArgs(s))}`);
  return lines.join('\n') + '\n';
}

async function listWorlds(conn) {
  try {
    const res = await conn.runShell(`ls -1 "${WORLDS}"/*.fwl 2>/dev/null`, { timeoutMs: 15_000 });
    return (res.stdout || '').split('\n')
      .map((l) => l.trim().replace(/^.*\//, '').replace(/\.fwl$/, ''))
      .filter((n) => n.length > 0 && SAFE_NAME_RE.test(n));
  } catch {
    return [];
  }
}

function validateProfileSettings(s = {}) {
  const out = {};
  out.serverName = String(s.serverName ?? '').trim().slice(0, 64);
  if (/[\r\n]/.test(out.serverName)) throw badSetting('server name may not span lines');
  out.world = String(s.world ?? '').trim();
  if (out.world && !SAFE_NAME_RE.test(out.world)) throw badSetting('invalid world name');
  out.newWorld = String(s.newWorld ?? '').trim();
  if (out.newWorld && !SAFE_NAME_RE.test(out.newWorld)) throw badSetting('invalid new world name (letters, digits, _ and -; max 64)');
  out.password = String(s.password ?? '');
  if (out.password && (out.password.length < 5 || out.password.length > 64 || /\s/.test(out.password))) {
    throw badSetting('password must be 5–64 characters with no whitespace (blank = inherit)');
  }
  const world = out.newWorld || out.world;
  if (out.password && world && world.toLowerCase().includes(out.password.toLowerCase())) {
    throw badSetting('Valheim rejects a password contained in the world name');
  }
  out.preset = String(s.preset ?? '');
  if (out.preset && !PRESETS.includes(out.preset)) throw badSetting(`preset must be one of ${PRESETS.join(', ')}`);
  for (const [key, allowed] of Object.entries(MODIFIERS)) {
    out[key] = String(s[key] ?? '');
    if (out[key] && !allowed.includes(out[key])) throw badSetting(`${key} must be one of ${allowed.join(', ')}`);
  }
  for (const key of SETKEYS) out[key] = bool(s[key]);
  const si = Number(s.saveInterval);
  if (!Number.isInteger(si) || si < 300 || si > 7200) throw badSetting('save interval must be 300–7200 seconds');
  out.saveInterval = si;
  const bk = Number(s.backups);
  if (!Number.isInteger(bk) || bk < 1 || bk > 20) throw badSetting('backups must be 1–20');
  out.backups = bk;
  return out;
}

// connectPassword: the applied file wins, else the container's own env (compose
// SERVER_PASS). The exec is 60s-cached per connector so the fleet poll doesn't
// spawn a `printenv` every tick (the CS/Factorio precedent for join secrets).
const PASSWORD_TTL_MS = 60_000;
const passwordCache = new WeakMap(); // conn → { at, value }

export const valheimSpec = {
  id: 'valheim',

  configFiles: {
    'adminlist.txt':     `${CONFIG}/adminlist.txt`,
    'permittedlist.txt': `${CONFIG}/permittedlist.txt`,
    'bannedlist.txt':    `${CONFIG}/bannedlist.txt`,
    'gamertown.env':     PROFILE_ENV,
  },

  profile: {
    defaults() {
      return {
        serverName: '', world: '', newWorld: '', password: '',
        preset: '', combat: '', deathpenalty: '', resources: '', raids: '', portals: '',
        nobuildcost: '0', playerevents: '0', passivemobs: '0', nomap: '0',
        saveInterval: 1800, backups: 4,
      };
    },

    validate(conn, s = {}) { return validateProfileSettings(s); },

    async schema(conn) {
      const worlds = await listWorlds(conn);
      const worldOpts = [{ value: '', label: '(inherit — the compose WORLD_NAME)' }, ...worlds.map((n) => ({ value: n, label: n }))];
      return {
        groups: [
          {
            key: 'server', title: 'Server',
            fields: [
              { key: 'serverName', label: 'Server Name (blank = inherit)', type: 'text', basic: true },
              { key: 'world',      label: 'World', type: 'select', options: worldOpts, basic: true,
                help: 'Existing worlds under /config/worlds_local. Switching never deletes a world.' },
              { key: 'newWorld',   label: 'New World Name', type: 'text',
                help: 'Creates (or switches to) a world by name on the next start; takes precedence over the picker.' },
              { key: 'password',   label: 'Join Password (blank = inherit)', type: 'text', basic: true,
                help: '5–64 characters, not contained in the world name.' },
            ],
          },
          {
            key: 'modifiers', title: 'World Modifiers',
            fields: [
              { key: 'preset', label: 'Preset', type: 'select', basic: true,
                options: [{ value: '', label: '(game default)' }, ...PRESETS.map((p) => ({ value: p, label: p }))] },
              ...Object.entries(MODIFIERS).map(([key, vals]) => ({
                key, label: MODIFIER_LABEL[key], type: 'select',
                options: [{ value: '', label: '(default)' }, ...vals.map((v) => ({ value: v, label: v }))],
              })),
              ...SETKEYS.map((key) => ({ key, label: SETKEY_LABEL[key], type: 'bool' })),
            ],
          },
          {
            key: 'saves', title: 'Saves',
            fields: [
              { key: 'saveInterval', label: 'Save Interval (s)', type: 'number', min: 300, max: 7200, step: 60 },
              { key: 'backups',      label: 'In-game Backups to Keep', type: 'number', min: 1, max: 20, step: 1 },
            ],
          },
        ],
        note: PROFILE_NOTE,
        cvarRef: VALHEIM_CVAR_REF,
      };
    },

    async apply(conn, settings) {
      const s = validateProfileSettings(settings);
      await conn.client.fileWrite(conn.vmid, PROFILE_ENV, renderEnvFile(s));
      passwordCache.delete(conn);
      return { ok: true };
    },

    // Read the applied file back through the validator (hand-edits are clamped
    // to the accepted vocab; an absent file is exactly the defaults).
    async capture(conn) {
      const env = parseEnvFile(await conn.fileText(PROFILE_ENV));
      const args = parseServerArgs(env.SERVER_ARGS);
      const d = valheimSpec.profile.defaults();
      const pick = (v, allowed) => (allowed.includes(v) ? v : '');
      return validateProfileSettings({
        ...d,
        serverName: env.SERVER_NAME ?? '',
        world: SAFE_NAME_RE.test(env.WORLD_NAME ?? '') ? env.WORLD_NAME : '',
        password: /^\S{5,64}$/.test(env.SERVER_PASS ?? '') ? env.SERVER_PASS : '',
        preset: pick(args.preset ?? '', PRESETS),
        ...Object.fromEntries(Object.entries(MODIFIERS).map(([k, vals]) => [k, pick(args[k] ?? '', vals)])),
        ...Object.fromEntries(SETKEYS.map((k) => [k, args[k] ?? '0'])),
        saveInterval: Number.isInteger(args.saveInterval) ? Math.max(300, Math.min(7200, args.saveInterval)) : d.saveInterval,
        backups: Number.isInteger(args.backups) ? Math.max(1, Math.min(20, args.backups)) : d.backups,
      });
    },
  },

  async connectPassword(conn) {
    const now = Date.now();
    const hit = passwordCache.get(conn);
    if (hit && now - hit.at < PASSWORD_TTL_MS) return hit.value;
    let value = parseEnvFile(await conn.fileText(PROFILE_ENV)).SERVER_PASS ?? '';
    if (!value) {
      try {
        const res = await conn.runShell('printenv SERVER_PASS', { timeoutMs: 10_000 });
        value = res.exitCode === 0 ? String(res.stdout || '').trim() : '';
      } catch { value = ''; }
    }
    passwordCache.set(conn, { at: now, value });
    return value;
  },

  // The image's own updater (steamcmd, idle-gated cron) traps SIGHUP → checks
  // NOW and restarts only the game process if files changed. No image pull is
  // involved, so this is a real in-container update (unlike MC/Factorio reboots).
  update: {
    argv: ['/bin/bash', '-lc', 'supervisorctl signal HUP valheim-updater'],
    timeoutMs: 30_000,
    stepName: 'update-check',
    note: 'Asked the in-container updater to check Steam now; it restarts the game only if files changed '
      + '(watch the container log). The wrapper image itself is pulled by host maintenance.',
  },
};
