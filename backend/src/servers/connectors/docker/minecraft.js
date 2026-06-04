// Dockerized Minecraft connector — target image `itzg/minecraft-server`.
//
// Reuses the transport-agnostic server.properties profile logic (../minecraft-profile.js)
// and inherits status/power/config from DockerBaseConnector. The two things that
// genuinely differ from the VM connector:
//   1. the world + config files live under /data (the image's data volume), and
//   2. live control is real Source-RCON over TCP (the app reaches the container's
//      RCON port by service name) — not the VM's tmux-console read-back.

import { DockerBaseConnector } from '../docker-base.js';
import * as mcProfile from '../minecraft-profile.js';
import { rconExchange } from '../../rcon-tcp.js';
import { validateLiveCommand } from '../../rcon.js';

const DATA  = '/data';
const PROPS = `${DATA}/server.properties`;

const MC_LIVE_ACTIONS = [
  { key: 'list', label: 'List Players' },
  { key: 'save', label: 'Save World' },
];
const MC_ACTION_CMDS = { list: 'list', save: 'save-all' };

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
    return { groups: mcProfile.profileGroups(worldOpts), note: mcProfile.PROFILE_NOTE };
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
    return { available: true, actions: MC_LIVE_ACTIONS, commandHint: 'Minecraft RCON' };
  }

  async sendCommand(command) {
    return { output: await this.#rcon(validateLiveCommand(command)) };
  }

  async runLiveAction(key) {
    const cmd = MC_ACTION_CMDS[key];
    if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
    return { output: await this.#rcon(cmd) };
  }
}
