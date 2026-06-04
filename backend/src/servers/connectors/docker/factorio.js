// Dockerized Factorio connector — target image `factoriotools/factorio`.
//
// Reuses the transport-agnostic server-settings.json profile logic
// (../factorio-profile.js) and inherits status/power/config from
// DockerBaseConnector. What differs from the LinuxGSM VM connector:
//   - layout: saves at /factorio/saves, config at /factorio/config (no LinuxGSM)
//   - active world: the container is configured to always load
//     /factorio/saves/_active.zip (SAVE_NAME=_active in servers.compose.yml), so
//     "switch world" = copy the chosen save over _active.zip and restart.
//   - live control: factoriotools exposes RCON on 27015 with the password in
//     /factorio/config/rconpw — we read it and speak RCON over TCP.
//
// NOTE: container-side world operations (save-as / generate) need validation on a
// real container; save-as (a file copy) is wired here, world-gen is a follow-up.

import { DockerBaseConnector } from '../docker-base.js';
import * as fctrProfile from '../factorio-profile.js';
import { rconExchange } from '../../rcon-tcp.js';
import { validateLiveCommand } from '../../rcon.js';
import { badSetting, SAFE_NAME_RE } from '../../errors.js';

const CONFIG = '/factorio/config';
const SAVES  = '/factorio/saves';
const SERVER_SETTINGS = `${CONFIG}/server-settings.json`;
const ACTIVE = `${SAVES}/_active.zip`; // the save the container always loads

const FACTORIO_LIVE_ACTIONS = [
  { key: 'players', label: 'List Players' },
  { key: 'time',    label: 'Map Time' },
];
const FACTORIO_ACTION_CMDS = { players: '/players', time: '/time' };

export class DockerFactorioConnector extends DockerBaseConnector {
  configFiles = {
    'server-settings.json': SERVER_SETTINGS,
    'map-gen-settings.json': `${CONFIG}/map-gen-settings.json`,
    'map-settings.json':     `${CONFIG}/map-settings.json`,
  };

  async #listSaves() {
    try {
      const res = await this.runShell(`ls -1 "${SAVES}"/*.zip 2>/dev/null`, { timeoutMs: 15_000 });
      return (res.stdout || '').split('\n')
        .map((l) => l.trim().replace(/^.*\//, '').replace(/\.zip$/, ''))
        .filter((n) => n.length > 0 && n !== '_active' && !n.startsWith('_autosave'));
    } catch {
      return [];
    }
  }

  // ── startup-config profiles (shared server-settings.json logic) ─────────────
  defaultProfileSettings()    { return fctrProfile.defaultProfileSettings(); }
  validateProfileSettings(s)  { return fctrProfile.validateProfileSettings(s); }

  async profileSchema() {
    const saves = await this.#listSaves();
    const saveOpts = [{ value: '', label: '(keep current world)' }, ...saves.map((n) => ({ value: n, label: n }))];
    return { groups: fctrProfile.profileGroups(saveOpts), note: fctrProfile.PROFILE_NOTE };
  }

  async applyProfileSettings(settings) {
    const s = this.validateProfileSettings(settings);

    const text = (await this.client.agentFileRead(this.vmid, SERVER_SETTINGS)).content ?? '';
    let json; try { json = JSON.parse(text || '{}'); } catch { json = {}; }
    fctrProfile.applyServerSettings(json, s);
    await this.client.agentFileWrite(this.vmid, SERVER_SETTINGS, JSON.stringify(json, null, 2) + '\n');

    // Active world: stage the chosen save as the one the container loads. Takes
    // effect on the next restart (the panel's Apply restarts the container).
    if (s.saveName) {
      const res = await this.runShell(`cp -f "${SAVES}/${s.saveName}.zip" "${ACTIVE}"`, { timeoutMs: 60_000 });
      if (res.exitCode !== 0) throw badSetting(`could not set active world: ${res.stderr || res.stdout}`);
    }
    return { ok: true };
  }

  async captureProfileSettings() {
    const text = await this.client.agentFileRead(this.vmid, SERVER_SETTINGS).then((r) => r.content ?? '').catch(() => '');
    let json = {}; try { json = JSON.parse(text || '{}'); } catch {}
    // The container loads _active.zip, so the original world name isn't recoverable
    // here — capture the server-settings knobs and leave the world as "keep current".
    return this.validateProfileSettings({ ...fctrProfile.captureServerSettings(json), saveName: '' });
  }

  // ── quick settings: copy the live world to a named save ─────────────────────
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
  }

  async setSettings(values = {}) {
    const { section, saveName } = values;
    if (section !== 'saveAs') throw badSetting(`unknown section: ${section}`);
    const clean = String(saveName ?? '').trim();
    if (!clean || !SAFE_NAME_RE.test(clean)) throw badSetting('save name may only contain letters, digits, _ and - (max 64)');
    const res = await this.runShell(`cp -f "${ACTIVE}" "${SAVES}/${clean}.zip"`, { timeoutMs: 60_000 });
    if (res.exitCode !== 0) throw badSetting(`save failed: ${res.stderr || res.stdout}`);
    return { ok: true, action: 'saveAs', saveName: clean };
  }

  // ── live commands (Source-RCON over TCP) ────────────────────────────────────
  async #rconCreds() {
    const password = (await this.client.agentFileRead(this.vmid, `${CONFIG}/rconpw`)
      .then((r) => r.content ?? '').catch(() => '')).trim();
    return { password, port: this.server.rconPort ?? 27015 };
  }

  async getLive() {
    const { password } = await this.#rconCreds();
    if (!password) return { available: false, reason: 'RCON password file (/factorio/config/rconpw) not readable' };
    return {
      available: true,
      actions: FACTORIO_LIVE_ACTIONS,
      commandHint: 'Factorio console, e.g. /players, /time, /server-save, /c game.speed=1',
    };
  }

  async sendCommand(command) {
    const cmd = validateLiveCommand(command);
    const { password, port } = await this.#rconCreds();
    return { output: await rconExchange({ host: this.server.container, port, password, command: cmd }) };
  }

  async runLiveAction(key) {
    const cmd = FACTORIO_ACTION_CMDS[key];
    if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
    const { password, port } = await this.#rconCreds();
    return { output: await rconExchange({ host: this.server.container, port, password, command: cmd }) };
  }
}
