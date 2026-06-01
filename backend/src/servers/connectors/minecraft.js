// Minecraft connector — plain (non-LinuxGSM) server.
//
// Verified layout (VM 102, 192.168.1.68) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/MinecraftServer   (owned by user `miles`)
//   launch      : `./start.sh` inside a tmux session named `minecraft`
//   service     : systemd unit `minecraft.service`

import { BaseConnector } from './base.js';
import { validateLiveCommand } from '../rcon.js';
import * as backups from '../backups.js';

const DIR = '/home/miles/MinecraftServer';
const PROPS = `${DIR}/server.properties`;
const STAGING = `${DIR}/.restore-staging`;

const BK_PREFIX = 'minecraft';
const BK_EXT    = '.tar.gz';

// Live curated actions (sent to the tmux console).
const MC_LIVE_ACTIONS = [
  { key: 'list', label: 'List Players' },
  { key: 'save', label: 'Save World' },
];
const MC_ACTION_CMDS = { list: 'list', save: 'save-all' };

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
const badSetting = (msg) => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };

const GAMEMODES    = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

export class MinecraftConnector extends BaseConnector {
  configFiles = {
    'server.properties':   PROPS,
    'whitelist.json':      `${DIR}/whitelist.json`,
    'ops.json':            `${DIR}/ops.json`,
    'banned-players.json': `${DIR}/banned-players.json`,
    'banned-ips.json':     `${DIR}/banned-ips.json`,
  };

  // ── private helpers ──────────────────────────────────────────────────────────

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
      // Find directories containing level.dat — those are real Minecraft worlds.
      const res = await this.runShell(
        `find "${DIR}" -maxdepth 2 -name level.dat -printf '%h\\n' 2>/dev/null | while read d; do basename "$d"; done`,
        { asUser: 'miles', timeoutMs: 15_000 },
      );
      return (res.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── game process ────────────────────────────────────────────────────────────

  async gameRunning() {
    const res = await this.runShell('systemctl is-active minecraft', { timeoutMs: 10_000 });
    return res.stdout.trim() === 'active';
  }

  // Start/restart may be fired right after a Start VM, so wait out the guest
  // agent's post-boot warm-up (up to 45s) instead of erroring immediately.
  async startGame() {
    await this.runShell('systemctl start minecraft', { timeoutMs: 30_000, awaitAgentMs: 45_000 });
    return { ok: true };
  }

  async stopGame() {
    await this.runShell('systemctl stop minecraft', { timeoutMs: 60_000 });
    return { ok: true };
  }

  async restartGame() {
    await this.runShell('systemctl restart minecraft', { timeoutMs: 90_000, awaitAgentMs: 45_000 });
    return { ok: true };
  }

  // ── live commands (Phase 3; via the tmux console — no RCON) ──────────────────
  // Send to the `minecraft` tmux session, then read back the log tail as
  // best-effort output (the console has no response channel like RCON does).
  async #console(cmd) {
    const safe = String(cmd).replace(/'/g, "'\\''"); // single-quote-safe for the shell
    const res = await this.runShell(
      `tmux send-keys -t minecraft '${safe}' Enter; sleep 1; tail -n 6 "${DIR}/logs/latest.log" 2>/dev/null`,
      { asUser: 'miles', timeoutMs: 12_000 },
    );
    return { output: res.stdout ?? '' };
  }

  async getLive() {
    return {
      available: true,
      actions: MC_LIVE_ACTIONS,
      commandHint: 'Minecraft console (no RCON — output is read back from the server log)',
    };
  }

  async sendCommand(command) {
    return this.#console(validateLiveCommand(command));
  }

  async runLiveAction(key) {
    const cmd = MC_ACTION_CMDS[key];
    if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
    return this.#console(cmd);
  }

  // ── update (jar upgrade) ─────────────────────────────────────────────────────

  async update() {
    // 1. Resolve latest stable release from Mojang's launcher manifest.
    const manifestRes = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    if (!manifestRes.ok) throw new Error(`Mojang manifest fetch failed: ${manifestRes.status}`);
    const manifest = await manifestRes.json();

    const latestId    = manifest.latest.release;
    const versionMeta = manifest.versions.find(v => v.id === latestId && v.type === 'release');
    if (!versionMeta) throw new Error(`latest release ${latestId} not found in manifest`);

    const versionRes = await fetch(versionMeta.url);
    if (!versionRes.ok) throw new Error(`version data fetch failed for ${latestId}: ${versionRes.status}`);
    const versionData = await versionRes.json();

    const jarUrl = versionData.downloads?.server?.url;
    if (!jarUrl) throw new Error(`no server download entry for ${latestId}`);

    const steps = [];

    // 2. Stop the game service (guest agent runs as root, no sudo needed).
    const stopRes = await this.runShell('systemctl stop minecraft', { timeoutMs: 60_000 });
    steps.push({ name: `stop  [target: ${latestId}]`, ...stopRes });

    // 3. Download new jar, back up old one.
    const dlRes = await this.runShell(
      `cd "${DIR}" && curl -fL -o server.jar.new "${jarUrl}" && mv server.jar server.jar.bak && mv server.jar.new server.jar`,
      { asUser: 'miles', timeoutMs: 300_000 },
    );
    steps.push({ name: 'download + replace jar', ...dlRes });

    if (dlRes.exitCode !== 0) {
      // Attempt recovery restart so the server isn't left permanently down.
      await this.runShell('systemctl start minecraft', { timeoutMs: 30_000 }).catch(() => {});
      return { ok: false, version: latestId, steps };
    }

    // 4. Restart.
    const startRes = await this.runShell('systemctl start minecraft', { timeoutMs: 30_000 });
    steps.push({ name: 'start', ...startRes });

    return { ok: true, version: latestId, steps };
  }

  // ── world operations (Quick Settings) ───────────────────────────────────────
  // The active world + structured server.properties are the startup config →
  // Profiles panel. Quick Settings keeps just the snapshot operation.

  async getSettings() {
    return {
      sections: [
        {
          key:       'saveAs',
          title:     'Back Up Current World As',
          saveLabel: 'Back Up',
          fields: [
            { key: 'saveName', label: 'Backup Name', type: 'text', value: '' },
          ],
        },
      ],
      note: 'Makes a local copy of the active world. Offsite backups are below.',
    };
  }

  async setSettings(values = {}) {
    const bad = msg => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };
    const { section, saveName } = values;

    if (!section) throw bad('section is required');
    if (!saveName || typeof saveName !== 'string' || !saveName.trim()) throw bad('world name is required');

    const cleanName = saveName.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanName)) {
      throw bad('world name may only contain letters, digits, underscores, and hyphens (max 64 chars)');
    }

    if (section === 'loadWorld') {
      const { content: raw = '' } = await this.client.agentFileRead(this.vmid, PROPS);
      const hasKey = /^level-name\s*=/m.test(raw);
      const updated = hasKey
        ? raw.replace(/^(level-name\s*=\s*).+$/m, `$1${cleanName}`)
        : `${raw}\nlevel-name=${cleanName}\n`;
      await this.client.agentFileWrite(this.vmid, PROPS, updated);
      return { ok: true, action: 'loadWorld', world: cleanName };
    }

    if (section === 'saveAs') {
      const currentWorld = await this.#currentWorld();

      // Best-effort flush: ask the running server to save before we copy.
      const vmStatus = await this.status().catch(() => ({ status: 'unknown' }));
      if (vmStatus.status === 'running') {
        await this.runShell(
          `tmux send-keys -t minecraft 'save-all' Enter`,
          { asUser: 'miles', timeoutMs: 10_000 },
        ).catch(() => {});
        await new Promise(r => setTimeout(r, 3_000));
      }

      const src  = `${DIR}/${currentWorld}`;
      const dest = `${DIR}/${cleanName}`;
      const cpRes = await this.runShell(`cp -r "${src}" "${dest}"`, {
        asUser: 'miles', timeoutMs: 60_000,
      });
      if (cpRes.exitCode !== 0) throw bad(`backup failed: ${cpRes.stderr || cpRes.stdout}`);
      return { ok: true, action: 'saveAs', world: cleanName, source: currentWorld };
    }

    throw bad(`unknown section: ${section}`);
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // A Minecraft profile is the startup config: the active world (level-name) plus
  // a structured server.properties subset (gamemode, difficulty, players, pvp,
  // whitelist toggle, motd, …). Player *lists* (whitelist.json / ops.json) stay in
  // the in-game commands / raw Config Files editor; world snapshots stay in Quick
  // Settings. No on-box gt_active_profile mirror (MC rewrites server.properties on
  // boot and would drop an unknown key) — the SQLite pointer is authoritative.

  defaultProfileSettings() {
    return {
      world: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 20,
      motd: 'Gamertown', pvp: '1', hardcore: '0', whitelist: '0', onlineMode: '1',
      viewDistance: 10, spawnProtection: 16,
    };
  }

  validateProfileSettings(s = {}) {
    const out = {};
    out.world = String(s.world ?? '').trim();
    if (out.world && !/^[a-zA-Z0-9_-]{1,64}$/.test(out.world)) throw badSetting('invalid world name');
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

  async profileSchema() {
    const [worlds, current] = await Promise.all([this.#listWorlds(), this.#currentWorld()]);
    const names = [...new Set([current, ...worlds].filter(Boolean))];
    const worldOpts = [{ value: '', label: '(keep current world)' }, ...names.map((w) => ({ value: w, label: w }))];
    const enumOpts = (arr) => arr.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
    return {
      groups: [
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
      ],
      note: 'A profile is the startup config the server boots as. Changes apply on the next restart.',
    };
  }

  async applyProfileSettings(settings) {
    const s = this.validateProfileSettings(settings);
    let text = (await this.client.agentFileRead(this.vmid, PROPS)).content ?? '';
    const set = (k, v) => { text = setProp(text, k, v); };
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
    await this.client.agentFileWrite(this.vmid, PROPS, text);
    return { ok: true };
  }

  async captureProfileSettings() {
    const text = await this.client.agentFileRead(this.vmid, PROPS).then((r) => r.content ?? '').catch(() => '');
    const boolp = (k, def) => { const v = getProp(text, k); return v === 'true' ? '1' : v === 'false' ? '0' : def; };
    const nump  = (k, def) => { const v = Number(getProp(text, k)); return Number.isFinite(v) ? v : def; };
    return this.validateProfileSettings({
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

  // ── offsite backups (Phase 4; rclone → R2) ───────────────────────────────────
  // A backup tar.gz's the active world dir and streams it to R2. Restore is
  // destructive (overwrites the live world), so it stops → swaps → restarts.

  async listBackups() {
    return backups.listBackups(this, { asUser: 'miles', prefix: BK_PREFIX, ext: BK_EXT });
  }

  async createBackup() {
    if (!(await backups.rcloneReady(this, 'miles'))) {
      throw backups.badSetting('rclone/R2 not configured on this VM');
    }
    const world = await this.#currentWorld();

    // Best-effort flush before archiving, if the server is up.
    const vmStatus = await this.status().catch(() => ({ status: 'unknown' }));
    if (vmStatus.status === 'running') {
      await this.runShell(`tmux send-keys -t minecraft 'save-all' Enter`, {
        asUser: 'miles', timeoutMs: 10_000,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3_000));
    }

    const name = `${backups.safeBase(world, 'world')}_${backups.timestamp()}`;
    const dest = backups.r2Path(BK_PREFIX, name, BK_EXT);
    // Stream tar → R2 in one pipe; no temp file, no agent-stdout payload.
    const res = await this.runShell(
      `tar -czf - -C "${DIR}" "${world}" | rclone rcat "${dest}"`,
      { asUser: 'miles', timeoutMs: 300_000 },
    );
    if (res.exitCode !== 0) throw backups.badSetting(`backup upload failed: ${res.stderr || res.stdout}`);
    return { ok: true, action: 'backup', name };
  }

  async restoreBackup(name) {
    if (!backups.NAME_RE.test(name)) throw backups.badSetting('invalid backup name');
    if (!(await backups.rcloneReady(this, 'miles'))) {
      throw backups.badSetting('rclone/R2 not configured on this VM');
    }
    if (!(await backups.objectExists(this, { asUser: 'miles', prefix: BK_PREFIX, name, ext: BK_EXT }))) {
      throw backups.notFound('backup not found');
    }
    const world = await this.#currentWorld();
    const obj   = backups.r2Path(BK_PREFIX, name, BK_EXT);
    const steps = [];

    // 1. Stop the service (guest agent runs as root — no sudo needed).
    const stop = await this.runShell('systemctl stop minecraft', { timeoutMs: 60_000 });
    steps.push({ name: 'stop', ...stop });

    // 2. Download + extract into a staging dir (don't touch the live world yet).
    const stage = await this.runShell(
      `rm -rf "${STAGING}" && mkdir -p "${STAGING}" && rclone cat "${obj}" | tar -xzf - -C "${STAGING}"`,
      { asUser: 'miles', timeoutMs: 300_000 },
    );
    steps.push({ name: 'download + extract', ...stage });

    if (stage.exitCode !== 0) {
      // Nothing destructive happened yet — clean up and bring the server back.
      await this.runShell(`rm -rf "${STAGING}"`, { asUser: 'miles', timeoutMs: 30_000 }).catch(() => {});
      const recover = await this.runShell('systemctl start minecraft', { timeoutMs: 30_000 })
        .catch((e) => ({ exitCode: 1, stdout: '', stderr: e.message }));
      steps.push({ name: 'start (recovery)', ...recover });
      return { ok: false, action: 'restore', world, steps };
    }

    // 3. Swap the single extracted top-level dir into place as the active world.
    const swap = await this.runShell(
      `top="$(ls -1 "${STAGING}")" && rm -rf "${DIR}/${world}" && ` +
      `mv "${STAGING}/$top" "${DIR}/${world}" && rmdir "${STAGING}" 2>/dev/null; true`,
      { asUser: 'miles', timeoutMs: 60_000 },
    );
    steps.push({ name: 'swap world', ...swap });

    // 4. Restart.
    const start = await this.runShell('systemctl start minecraft', { timeoutMs: 30_000 });
    steps.push({ name: 'start', ...start });

    return { ok: swap.exitCode === 0 && start.exitCode === 0, action: 'restore', world, steps };
  }

  async deleteBackup(name) {
    return backups.deleteBackup(this, { asUser: 'miles', prefix: BK_PREFIX, name, ext: BK_EXT });
  }
}
