// Factorio connector — LinuxGSM instance `fctrserver`.
//
// Verified layout (VM 101, 192.168.1.74) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/fctrserver   (owned by user `miles`)
//   control     : ./fctrserver start|stop|restart|update   (run as miles)
//
// Save management:
//   saves live at : serverfiles/saves/*.zip  (autosaves: _autosave*.zip here too)
//   active save   : controlled via `startparameters` in fctrserver.cfg — the
//                   _default.cfg hardcodes save1.zip, so we must override
//                   `startparameters` (and `savename` for bookkeeping) whenever
//                   changing worlds. Template: --bind ${ip} --start-server
//                   ${serverfiles}/saves/<name>.zip --server-settings ...
//   new worlds    : factorio --create "saves/<name>.zip" --map-gen-settings <json>
//                   [--preset <preset>]   (preset tweaks non-resource settings)
//                   Requires exclusive lock → stop game process first.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVar } from '../cfgvars.js';
import { rconCommand, validateLiveCommand } from '../rcon.js';
import * as backups from '../backups.js';

const BK_PREFIX = 'factorio';
const BK_EXT    = '.zip';

const DIR        = '/home/miles/fctrserver';
const SAVES_DIR  = `${DIR}/serverfiles/saves`;
const LGSM_CFG   = `${DIR}/lgsm/config-lgsm/fctrserver/fctrserver.cfg`;
const COMMON_CFG = `${DIR}/lgsm/config-lgsm/fctrserver/common.cfg`;
const FACTORIO   = `${DIR}/serverfiles/bin/x64/factorio`;
const SERVER_SETTINGS = `${DIR}/serverfiles/data/server-settings.json`;

const VISIBILITY_OPTS = [
  { value: 'public', label: 'Public (listed) + LAN' },
  { value: 'lan',    label: 'LAN only' },
];

const SAVE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const badSetting = (msg) => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };

// Live (RCON) curated actions — read-only commands validated to work headless.
const FACTORIO_LIVE_ACTIONS = [
  { key: 'players', label: 'List Players' },
  { key: 'time',    label: 'Map Time' },
];
const FACTORIO_ACTION_CMDS = { players: '/players', time: '/time' };

// Shell-variable template written into fctrserver.cfg to override the hardcoded
// save1.zip in _default.cfg. ${ip}, ${serverfiles}, etc. are expanded by bash
// when LinuxGSM sources the config — they must appear as literal text here.
const buildStartParams = (saveName) =>
  '--bind ${ip} --start-server ${serverfiles}/saves/' + saveName +
  '.zip --server-settings ${servercfgfullpath} --port ${port}' +
  ' --rcon-port ${rconport} --rcon-password ${rconpassword}';

const PRESETS = [
  { value: 'default',        label: 'Default' },
  { value: 'marathon',       label: 'Marathon (slow depletion)' },
  { value: 'rail-world',     label: 'Rail World (sparse/distant)' },
  { value: 'rich-resources', label: 'Rich Resources' },
  { value: 'death-world',    label: 'Death World (hard enemies)' },
];

const DENSITY_OPTS = [
  { value: 'very-low',  label: 'Very Low' },
  { value: 'low',       label: 'Low' },
  { value: 'normal',    label: 'Normal' },
  { value: 'high',      label: 'High' },
  { value: 'very-high', label: 'Very High' },
];

const ENEMY_OPTS = [
  { value: 'none',      label: 'None (peaceful)' },
  { value: 'very-low',  label: 'Very Low' },
  { value: 'low',       label: 'Low' },
  { value: 'normal',    label: 'Normal' },
  { value: 'high',      label: 'High' },
  { value: 'very-high', label: 'Very High' },
];

const START_OPTS = [
  { value: 'very-low',  label: 'Very Small' },
  { value: 'low',       label: 'Small' },
  { value: 'normal',    label: 'Normal' },
  { value: 'high',      label: 'Large' },
  { value: 'very-high', label: 'Very Large' },
];

const VALID_PRESET   = new Set(PRESETS.map(p => p.value));
const VALID_DENSITY  = new Set(['very-low', 'low', 'normal', 'high', 'very-high']);
const VALID_ENEMY    = new Set(['none', ...VALID_DENSITY]);
const VALID_START    = new Set(['very-low', 'low', 'normal', 'high', 'very-high']);

export class FactorioConnector extends LinuxGsmConnector {
  gsmUser   = 'miles';
  gsmDir    = DIR;
  gsmScript = 'fctrserver';

  configFiles = {
    'server-settings.json': `${DIR}/serverfiles/data/server-settings.json`,
    'lgsm.cfg':             LGSM_CFG,
    'lgsm-common.cfg':      `${DIR}/lgsm/config-lgsm/fctrserver/common.cfg`,
  };

  async #listSaves() {
    try {
      const res = await this.runShell(`ls -1 "${SAVES_DIR}"/*.zip 2>/dev/null`, {
        asUser: this.gsmUser, timeoutMs: 15_000,
      });
      return (res.stdout || '').split('\n')
        .map(l => l.trim().replace(/^.*\//, '').replace(/\.zip$/, ''))
        .filter(n => n.length > 0 && !n.startsWith('_')); // exclude _autosave* files
    } catch {
      return [];
    }
  }

  async #latestAutosave() {
    try {
      const res = await this.runShell(
        `ls -t "${SAVES_DIR}"/_autosave*.zip 2>/dev/null | head -1`,
        { asUser: this.gsmUser, timeoutMs: 15_000 },
      );
      return res.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // Operations panel (Quick Settings): create/generate saves. The *active* world
  // + server settings are the startup config — those live in the Profiles panel.
  async getSettings() {
    return {
      sections: [
        {
          key:       'saveAs',
          title:     'Save Current World As',
          saveLabel: 'Save As',
          fields: [
            { key: 'saveName', label: 'Save Name', type: 'text', value: '' },
          ],
        },
        {
          key:       'newWorld',
          title:     'Generate New World',
          saveLabel: 'Generate World',
          fields: [
            { key: 'saveName',     label: 'Name',           type: 'text',   value: 'new_world' },
            { key: 'preset',       label: 'Preset',         type: 'select', value: 'default',  options: PRESETS },
            { key: 'seed',         label: 'Seed',           type: 'text',   value: '',         placeholder: 'blank = random' },
            { key: 'startingArea', label: 'Starting Area',  type: 'select', value: 'normal',   options: START_OPTS },
            { key: 'oreFrequency', label: 'Ore Frequency',  type: 'select', value: 'normal',   options: DENSITY_OPTS },
            { key: 'oreSize',      label: 'Ore Patch Size', type: 'select', value: 'normal',   options: DENSITY_OPTS },
            { key: 'oreRichness',  label: 'Ore Richness',   type: 'select', value: 'normal',   options: DENSITY_OPTS },
            { key: 'enemies',      label: 'Enemies',        type: 'select', value: 'normal',   options: ENEMY_OPTS },
          ],
        },
      ],
      note: 'Changes apply on next server restart. "Generate World" creates a new save and sets it as active.',
    };
  }

  async setSettings(values = {}) {
    const bad = msg => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };
    const { section, saveName } = values;

    if (!section) throw bad('section is required');
    if (!saveName || typeof saveName !== 'string' || !saveName.trim()) throw bad('save name is required');

    const cleanName = saveName.trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cleanName)) {
      throw bad('save name may only contain letters, digits, underscores, and hyphens (max 64 chars)');
    }

    // ── Copy current world state to a named save ────────────────────────────
    if (section === 'saveAs') {
      // Source: latest autosave (most current state), or current savegame if no autosave exists.
      const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
      const rawSave  = getVar(lgsmText, 'savegame') || '';
      const currName = rawSave.replace(/^.*\//, '').replace(/\.zip$/, '');

      const source = await this.#latestAutosave()
        ?? (currName ? `${SAVES_DIR}/${currName}.zip` : null);

      if (!source) throw bad('no autosave or active save found to copy from');

      const dest   = `${SAVES_DIR}/${cleanName}.zip`;
      const cpRes  = await this.runShell(`cp "${source}" "${dest}"`, {
        asUser: this.gsmUser, timeoutMs: 30_000,
      });
      if (cpRes.exitCode !== 0) throw bad(`copy failed: ${cpRes.stderr || cpRes.stdout}`);

      return { ok: true, action: 'saveAs', saveName: cleanName, source };
    }

    // ── Load an existing save ────────────────────────────────────────────────
    if (section === 'loadWorld') {
      const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
      let updated = setVar(lgsmText, 'savename', cleanName);
      updated = setVar(updated, 'startparameters', buildStartParams(cleanName));
      await this.client.agentFileWrite(this.vmid, LGSM_CFG, updated);
      return { ok: true, action: 'load', saveName: cleanName };
    }

    // ── Generate a new world ─────────────────────────────────────────────────
    if (section === 'newWorld') {
      const {
        preset       = 'default',
        seed         = '',
        startingArea = 'normal',
        oreFrequency = 'normal',
        oreSize      = 'normal',
        oreRichness  = 'normal',
        enemies      = 'normal',
      } = values;

      if (!VALID_PRESET.has(preset))      throw bad(`invalid preset: ${preset}`);
      if (seed !== '' && !/^\d{1,10}$/.test(String(seed))) throw bad('seed must be a number or blank');
      if (!VALID_START.has(startingArea)) throw bad(`invalid startingArea`);
      if (!VALID_DENSITY.has(oreFrequency)) throw bad(`invalid oreFrequency`);
      if (!VALID_DENSITY.has(oreSize))    throw bad(`invalid oreSize`);
      if (!VALID_DENSITY.has(oreRichness)) throw bad(`invalid oreRichness`);
      if (!VALID_ENEMY.has(enemies))      throw bad(`invalid enemies`);

      const oreCtrl   = { frequency: oreFrequency, size: oreSize, richness: oreRichness };
      const enemyCtrl = enemies === 'none'
        ? { frequency: 'none', size: 'none', richness: 'none' }
        : { frequency: enemies, size: enemies, richness: 'normal' };

      const mapGenSettings = {
        starting_area: startingArea,
        autoplace_controls: {
          coal:           oreCtrl,
          stone:          oreCtrl,
          'copper-ore':   oreCtrl,
          'iron-ore':     oreCtrl,
          'uranium-ore':  oreCtrl,
          'crude-oil':    oreCtrl,
          'enemy-base':   enemyCtrl,
        },
      };
      if (seed) mapGenSettings.seed = Number(seed);

      // factorio --create requires an exclusive lock on the install dir.
      // Stop the game process first if the VM is running, then restart after.
      const vmStatus  = await this.status();
      const wasActive = vmStatus.status === 'running';
      const steps     = [];

      const lgsm = (action, ms = 120_000) =>
        this.runShell(`cd "${DIR}" && ./${this.gsmScript} ${action}`, {
          asUser: this.gsmUser, timeoutMs: ms,
        });

      if (wasActive) {
        const stopRes = await lgsm('stop');
        steps.push({ name: 'stop', ...stopRes });
        // Give the OS a moment to release the exclusive lock after the process exits.
        await new Promise(r => setTimeout(r, 3_000));
      }

      // Write map-gen-settings to the home dir (readable by miles; root writes 644).
      const settingsPath = `/home/miles/factorio-map-gen-settings.json`;
      await this.client.agentFileWrite(this.vmid, settingsPath, JSON.stringify(mapGenSettings, null, 2));

      const savePath = `${SAVES_DIR}/${cleanName}.zip`;
      let cmd = `"${FACTORIO}" --create "${savePath}" --map-gen-settings "${settingsPath}"`;
      if (preset !== 'default') cmd += ` --preset "${preset}"`;

      let createResult;
      try {
        createResult = await this.runShell(cmd, { asUser: this.gsmUser, timeoutMs: 120_000 });
      } finally {
        await this.runShell(`rm -f "${settingsPath}"`, { asUser: this.gsmUser, timeoutMs: 10_000 }).catch(() => {});
      }
      steps.push({ name: 'create', ...createResult });

      if (createResult.exitCode !== 0) {
        // Recovery-restart the previous world so the server isn't left stopped.
        if (wasActive) {
          const restartRes = await lgsm('start').catch(e => ({ exitCode: 1, stdout: '', stderr: e.message }));
          steps.push({ name: 'start (recovery)', ...restartRes });
        }
        // Return steps rather than throwing so the full Factorio output is visible
        // in the UI output panel instead of being truncated in the error bar.
        return { ok: false, action: 'generate', saveName: cleanName, steps };
      }

      // Set the new save as active then bring the server back up.
      const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
      let updatedCfg = setVar(lgsmText, 'savename', cleanName);
      updatedCfg = setVar(updatedCfg, 'startparameters', buildStartParams(cleanName));
      await this.client.agentFileWrite(this.vmid, LGSM_CFG, updatedCfg);

      if (wasActive) {
        const startRes = await lgsm('start');
        steps.push({ name: 'start', ...startRes });
      }

      return { ok: true, action: 'generate', saveName: cleanName, steps };
    }

    throw bad(`unknown section: ${section}`);
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // A Factorio profile is the startup config: which saved world boots + the
  // structured server-settings.json knobs (name, players, visibility, password,
  // autosave). Creating/copying/generating saves stays in Quick Settings (those
  // are operations on the save store, not config).

  defaultProfileSettings() {
    return {
      saveName: '', serverName: 'Gamertown Factorio', description: '',
      maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
    };
  }

  validateProfileSettings(s = {}) {
    const out = {};
    out.saveName = String(s.saveName ?? '').trim();
    if (out.saveName && !SAVE_NAME_RE.test(out.saveName)) throw badSetting('invalid world name');
    out.serverName  = String(s.serverName ?? '').slice(0, 200);
    out.description = String(s.description ?? '').slice(0, 500);
    const mp = Number(s.maxPlayers);
    if (!Number.isInteger(mp) || mp < 0 || mp > 500) throw badSetting('max players must be 0–500 (0 = unlimited)');
    out.maxPlayers = mp;
    out.visibility = s.visibility === 'public' ? 'public' : 'lan';
    out.password = String(s.password ?? '').slice(0, 100);
    const ai = Number(s.autosaveInterval);
    if (!Number.isInteger(ai) || ai < 1 || ai > 240) throw badSetting('autosave interval must be 1–240 minutes');
    out.autosaveInterval = ai;
    return out;
  }

  async profileSchema() {
    const saves = await this.#listSaves();
    const saveOpts = [{ value: '', label: '(keep current world)' }, ...saves.map(n => ({ value: n, label: n }))];
    return {
      groups: [
        {
          key: 'world', title: 'World',
          fields: [
            { key: 'saveName', label: 'Active World', type: 'select', options: saveOpts,
              help: 'Which saved world the server loads on (re)start. Create/copy/generate worlds in Quick Settings below.' },
          ],
        },
        {
          key: 'server', title: 'Server Settings',
          fields: [
            { key: 'serverName',  label: 'Server Name',  type: 'text' },
            { key: 'description', label: 'Description',   type: 'text' },
            { key: 'maxPlayers',  label: 'Max Players (0 = unlimited)', type: 'number', min: 0, max: 500, step: 1 },
            { key: 'visibility',  label: 'Visibility',    type: 'select', options: VISIBILITY_OPTS },
            { key: 'password',    label: 'Game Password (blank = none)', type: 'text' },
            { key: 'autosaveInterval', label: 'Autosave Interval (min)', type: 'number', min: 1, max: 240, step: 1 },
          ],
        },
      ],
      note: 'A profile is the startup config the server boots as. Changes apply on the next restart. Public visibility also needs a Factorio.com token in server-settings.json.',
    };
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);

    // server-settings.json — structured server config (JSON: parse/modify/write).
    const text = (await this.client.agentFileRead(this.vmid, SERVER_SETTINGS)).content ?? '';
    let json;
    try { json = JSON.parse(text || '{}'); } catch { json = {}; }
    json.name              = s.serverName;
    json.description        = s.description;
    json.max_players        = s.maxPlayers;
    json.visibility         = s.visibility === 'public' ? { public: true, lan: true } : { public: false, lan: true };
    json.game_password      = s.password;
    json.autosave_interval  = s.autosaveInterval;
    await this.client.agentFileWrite(this.vmid, SERVER_SETTINGS, JSON.stringify(json, null, 2) + '\n');

    // active world (optional) + on-box active-profile mirror, in the LGSM cfg
    let lgsm = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
    if (s.saveName) {
      lgsm = setVar(lgsm, 'savename', s.saveName);
      lgsm = setVar(lgsm, 'startparameters', buildStartParams(s.saveName));
    }
    if (profileId != null) lgsm = setVar(lgsm, 'gt_active_profile', String(profileId));
    await this.client.agentFileWrite(this.vmid, LGSM_CFG, lgsm);
    return { ok: true };
  }

  async captureProfileSettings() {
    const [settingsText, lgsmText] = await Promise.all([
      this.client.agentFileRead(this.vmid, SERVER_SETTINGS).then(r => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, LGSM_CFG).then(r => r.content ?? '').catch(() => ''),
    ]);
    let j = {};
    try { j = JSON.parse(settingsText || '{}'); } catch {}
    const rawParams = getVar(lgsmText, 'startparameters') || '';
    const m = rawParams.match(/--start-server\s+\S*\/([^/"\s]+)\.zip/);
    const currentSave = m?.[1] || getVar(lgsmText, 'savename') || '';
    return this.validateProfileSettings({
      saveName: SAVE_NAME_RE.test(currentSave) ? currentSave : '',
      serverName: j.name ?? '',
      description: j.description ?? '',
      maxPlayers: Number.isInteger(j.max_players) ? j.max_players : 0,
      visibility: j.visibility?.public ? 'public' : 'lan',
      password: j.game_password ?? '',
      autosaveInterval: Number.isInteger(j.autosave_interval) ? j.autosave_interval : 10,
    });
  }

  // ── offsite backups (Phase 4; rclone → R2) ───────────────────────────────────
  // A backup uploads the current save zip to R2. Restore downloads it back into
  // saves/ as a *loadable* save (user then picks it via "Load Existing World") —
  // no active-save change, no restart.

  async listBackups() {
    return backups.listBackups(this, { asUser: this.gsmUser, prefix: BK_PREFIX, ext: BK_EXT });
  }

  async createBackup() {
    if (!(await backups.rcloneReady(this, this.gsmUser))) {
      throw backups.badSetting('rclone/R2 not configured on this VM');
    }
    // Source: latest autosave (most current state) or the active savegame.
    const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
    const rawSave  = getVar(lgsmText, 'savegame') || '';
    const currName = rawSave.replace(/^.*\//, '').replace(/\.zip$/, '') || getVar(lgsmText, 'savename') || '';
    const source   = (await this.#latestAutosave())
      ?? (currName ? `${SAVES_DIR}/${currName}.zip` : null);
    if (!source) throw backups.badSetting('no autosave or active save found to back up');

    const name = `${backups.safeBase(currName, 'save')}_${backups.timestamp()}`;
    return backups.uploadFile(this, { asUser: this.gsmUser, source, prefix: BK_PREFIX, name, ext: BK_EXT });
  }

  async restoreBackup(name) {
    if (!backups.NAME_RE.test(name)) throw backups.badSetting('invalid backup name');
    if (!(await backups.rcloneReady(this, this.gsmUser))) {
      throw backups.badSetting('rclone/R2 not configured on this VM');
    }
    if (!(await backups.objectExists(this, { asUser: this.gsmUser, prefix: BK_PREFIX, name, ext: BK_EXT }))) {
      throw backups.notFound('backup not found');
    }
    const dest = `${SAVES_DIR}/${name}.zip`;
    const res  = await this.runShell(
      `rclone copyto "${backups.r2Path(BK_PREFIX, name, BK_EXT)}" "${dest}"`,
      { asUser: this.gsmUser, timeoutMs: 300_000 },
    );
    if (res.exitCode !== 0) throw backups.badSetting(`restore failed: ${res.stderr || res.stdout}`);
    return { ok: true, action: 'restore', saveName: name, note: 'Downloaded into saves — load it via "Load Existing World".' };
  }

  async deleteBackup(name) {
    return backups.deleteBackup(this, { asUser: this.gsmUser, prefix: BK_PREFIX, name, ext: BK_EXT });
  }

  // ── live commands (Phase 3; Factorio Source RCON) ────────────────────────────
  async #rconCreds() {
    const common = await this.client.agentFileRead(this.vmid, COMMON_CFG).then((r) => r.content ?? '').catch(() => '');
    // rconpassword/rconport fall back to LinuxGSM's running defaults when not overridden.
    const password = getVar(common, 'rconpassword') || 'CHANGE_ME';
    const port = Number(getVar(common, 'rconport') || 34198);
    return { password, port };
  }

  async getLive() {
    return {
      available: true,
      actions: FACTORIO_LIVE_ACTIONS,
      commandHint: 'Factorio console, e.g. /players, /time, /server-save, /c game.speed=1',
    };
  }

  async sendCommand(command) {
    const cmd = validateLiveCommand(command);
    const { password, port } = await this.#rconCreds();
    return rconCommand(this, { port, password, command: cmd });
  }

  async runLiveAction(key) {
    const cmd = FACTORIO_ACTION_CMDS[key];
    if (!cmd) { const e = new Error(`unknown live action: ${key}`); e.code = 'BAD_SETTING'; throw e; }
    const { password, port } = await this.#rconCreds();
    return rconCommand(this, { port, password, command: cmd });
  }
}
