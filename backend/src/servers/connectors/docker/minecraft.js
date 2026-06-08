// Dockerized Minecraft connector — target image `itzg/minecraft-server`.
//
// Reuses the transport-agnostic server.properties profile logic (../minecraft-profile.js)
// and inherits status/power/config from DockerBaseConnector. The two things that
// genuinely differ from the VM connector:
//   1. the world + config files live under /data (the image's data volume), and
//   2. live control is real Source-RCON over TCP (the app reaches the container's
//      RCON port by service name) — not the VM's tmux-console read-back.

import { DockerBaseConnector, clampNumber } from '../docker-base.js';
import * as mcProfile from '../minecraft-profile.js';
import { rconExchange } from '../../rcon-tcp.js';
import { validateLiveCommand } from '../../rcon.js';
import { badSetting } from '../../errors.js';

const DATA  = '/data';
const PROPS = `${DATA}/server.properties`;
const MC_TARGET_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DIMENSION_MAP_IDS = {
  'minecraft:overworld': 'overworld',
  'minecraft:the_nether': 'nether',
  'minecraft:the_end': 'end',
};

const MC_LIVE_ACTIONS = [
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
];
const MC_ACTION_CMDS = {
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
};

// Continuous live cvars → sliders. Each clamps to its bounds in runLiveAction via
// clampNumber, which treats 0 as a real value (time 0 stays 0) but maps an empty/
// non-numeric value to `default`. NOTE: gamerule identifiers on the deployed build
// (validated live against itzg/minecraft-server v26.1.2) are snake_case —
// keep_inventory, random_tick_speed, players_sleeping_percentage — and mob spawning
// is the renamed `spawn_mobs` rule (NOT do_mob_spawning). Re-validate with
// backend/test-live/rcon-smoke.mjs if the pinned VERSION changes.
const MC_LIVE_CONTROLS = [
  { key: 'time',       label: 'Time of Day',       min: 0, max: 24000, step: 1000, default: 6000 },
  { key: 'randomtick', label: 'Random Tick Speed', min: 0, max: 20,    step: 1,    default: 3 },
  { key: 'sleeppct',   label: 'Sleep %',           min: 0, max: 100,   step: 5,    default: 100, suffix: '%' },
];

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

export class DockerMinecraftConnector extends DockerBaseConnector {
  configFiles = {
    'server.properties':   PROPS,
    'whitelist.json':      `${DATA}/whitelist.json`,
    'ops.json':            `${DATA}/ops.json`,
    'banned-players.json': `${DATA}/banned-players.json`,
    'banned-ips.json':     `${DATA}/banned-ips.json`,
  };

  // ── world discovery (for the profile world picker) ──────────────────────────
  async #currentWorld() {
    try {
      const { content = '' } = await this.client.agentFileRead(this.vmid, PROPS);
      return content.match(/^level-name\s*=\s*(.+)$/m)?.[1]?.trim() || 'world';
    } catch {
      return 'world';
    }
  }

  async #listWorlds() {
    try {
      const res = await this.runShell(
        `find "${DATA}" -maxdepth 2 -name level.dat -printf '%h\\n' 2>/dev/null | while read d; do basename "$d"; done`,
        { timeoutMs: 15_000 },
      );
      return (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── startup-config profiles (shared server.properties logic) ────────────────
  defaultProfileSettings()    { return mcProfile.defaultProfileSettings(); }
  validateProfileSettings(s)  { return mcProfile.validateProfileSettings(s); }

  async profileSchema() {
    const [worlds, current] = await Promise.all([this.#listWorlds(), this.#currentWorld()]);
    const names = [...new Set([current, ...worlds].filter(Boolean))];
    const worldOpts = [{ value: '', label: '(keep current world)' }, ...names.map((w) => ({ value: w, label: w }))];
    return { groups: mcProfile.profileGroups(worldOpts), note: mcProfile.PROFILE_NOTE, cvarRef: mcProfile.CVAR_REF };
  }

  async applyProfileSettings(settings) {
    const text = (await this.client.agentFileRead(this.vmid, PROPS)).content ?? '';
    await this.client.agentFileWrite(this.vmid, PROPS, mcProfile.applyProps(text, settings));
    return { ok: true };
  }

  async captureProfileSettings() {
    const text = await this.client.agentFileRead(this.vmid, PROPS).then((r) => r.content ?? '').catch(() => '');
    return mcProfile.captureProps(text);
  }

  // ── live commands (Source-RCON over TCP) ────────────────────────────────────
  // The container is reachable by its compose service name; RCON port defaults to
  // itzg's 25575 (override with the registry entry's `rconPort`). The password
  // comes from the host secrets file via env, never the repo.
  #rcon(command) {
    return rconExchange({
      host: this.server.container,
      port: this.server.rconPort ?? 25575,
      password: process.env.MINECRAFT_RCON_PASSWORD ?? '',
      command,
    });
  }

  async getLive() {
    if (!process.env.MINECRAFT_RCON_PASSWORD) {
      return { available: false, reason: 'MINECRAFT_RCON_PASSWORD is not set' };
    }
    // No changeMap — switching worlds is restart-only (the profile world picker).
    return { available: true, actions: MC_LIVE_ACTIONS, controls: MC_LIVE_CONTROLS, commandHint: 'Minecraft RCON' };
  }

  async sendCommand(command) {
    return { output: await this.#rcon(validateLiveCommand(command)) };
  }

  async listOnlinePlayers() {
    // Match getLive()'s gate: with no RCON password there's nothing to ask the server,
    // so short-circuit instead of opening a socket that rconExchange would just reject.
    if (!process.env.MINECRAFT_RCON_PASSWORD) return [];
    const output = await this.#rcon('list');
    return parseMinecraftPlayerList(output).map((name) => ({
      name,
      uid: null,
      identityKind: 'minecraft',
    }));
  }

  async runLiveAction(key, value) {
    // Range sliders (clamped to their bounds) come first, then keyed actions.
    if (key === 'time')       return { output: await this.#rcon(`time set ${clampNumber(value, 0, 24000, 6000)}`) };
    if (key === 'randomtick') return { output: await this.#rcon(`gamerule random_tick_speed ${clampNumber(value, 0, 20, 3)}`) };
    if (key === 'sleeppct')   return { output: await this.#rcon(`gamerule players_sleeping_percentage ${clampNumber(value, 0, 100, 100)}`) };
    const cmd = MC_ACTION_CMDS[key];
    if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
    return { output: await this.#rcon(cmd) };
  }

  // ── update the game client ───────────────────────────────────────────────────
  // itzg/minecraft-server re-resolves + downloads the configured VERSION on every
  // start, so updating the server jar is just a restart. Set VERSION=LATEST in the
  // compose env to track the newest release; otherwise it re-pulls the pinned one.
  async getPlayerPosition(target) {
    const entity = String(target ?? '').trim();
    if (!MC_TARGET_RE.test(entity)) throw badSetting('invalid Minecraft player id');

    const [posOut, dimOut, rotOut] = await Promise.all([
      this.#rcon(`data get entity ${entity} Pos`),
      this.#rcon(`data get entity ${entity} Dimension`),
      this.#rcon(`data get entity ${entity} Rotation`).catch(() => ''),
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
  }

  async update() {
    await this.reboot();
    return {
      ok: true,
      note: 'Restarted — itzg/minecraft-server re-downloaded the configured VERSION on boot. '
        + 'Set VERSION=LATEST in servers.compose.yml to always pull the newest release.',
    };
  }
}
