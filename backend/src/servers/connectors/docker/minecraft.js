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

const DATA  = '/data';
const PROPS = `${DATA}/server.properties`;

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
];
const MC_ACTION_CMDS = {
  list: 'list', save: 'save-all',
  day: 'time set day', night: 'time set night',
  clear: 'weather clear', rain: 'weather rain',
  keepinv_on:  'gamerule keep_inventory true',
  keepinv_off: 'gamerule keep_inventory false',
  mobs_on:  'gamerule spawn_mobs true',
  mobs_off: 'gamerule spawn_mobs false',
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
  async update() {
    await this.reboot();
    return {
      ok: true,
      note: 'Restarted — itzg/minecraft-server re-downloaded the configured VERSION on boot. '
        + 'Set VERSION=LATEST in servers.compose.yml to always pull the newest release.',
    };
  }
}
