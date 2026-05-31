// Minecraft connector — plain (non-LinuxGSM) server.
//
// Verified layout (VM 102, 192.168.1.68) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/MinecraftServer   (owned by user `miles`)
//   launch      : `./start.sh` inside a tmux session named `minecraft`
//   service     : systemd unit `minecraft.service`

import { BaseConnector } from './base.js';

const DIR = '/home/miles/MinecraftServer';
const PROPS = `${DIR}/server.properties`;

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

  // ── world management (Quick Settings) ───────────────────────────────────────

  async getSettings() {
    const [worlds, currentWorld] = await Promise.all([
      this.#listWorlds(),
      this.#currentWorld(),
    ]);

    const worldOpts = worlds.map(w => ({ value: w, label: w }));
    if (!worldOpts.some(o => o.value === currentWorld)) {
      worldOpts.unshift({ value: currentWorld, label: currentWorld });
    }

    return {
      sections: [
        {
          key:       'loadWorld',
          title:     'Load World',
          saveLabel: 'Load World',
          fields: [
            {
              key:     'saveName',
              label:   'World',
              type:    'select',
              value:   currentWorld,
              options: worldOpts.length
                ? worldOpts
                : [{ value: currentWorld, label: currentWorld }],
            },
          ],
        },
        {
          key:       'saveAs',
          title:     'Back Up Current World As',
          saveLabel: 'Back Up',
          fields: [
            { key: 'saveName', label: 'Backup Name', type: 'text', value: '' },
          ],
        },
      ],
      note: 'Load World takes effect after server restart.',
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
}
