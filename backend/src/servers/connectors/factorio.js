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

const DIR       = '/home/miles/fctrserver';
const SAVES_DIR = `${DIR}/serverfiles/saves`;
const LGSM_CFG  = `${DIR}/lgsm/config-lgsm/fctrserver/fctrserver.cfg`;
const FACTORIO  = `${DIR}/serverfiles/bin/x64/factorio`;

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
  { value: 'very-small', label: 'Very Small' },
  { value: 'small',      label: 'Small' },
  { value: 'normal',     label: 'Normal' },
  { value: 'large',      label: 'Large' },
  { value: 'very-large', label: 'Very Large' },
];

const VALID_PRESET   = new Set(PRESETS.map(p => p.value));
const VALID_DENSITY  = new Set(['very-low', 'low', 'normal', 'high', 'very-high']);
const VALID_ENEMY    = new Set(['none', ...VALID_DENSITY]);
const VALID_START    = new Set(['very-small', 'small', 'normal', 'large', 'very-large']);

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

  async getSettings() {
    const [saves, lgsmText] = await Promise.all([
      this.#listSaves(),
      this.client.agentFileRead(this.vmid, LGSM_CFG).then(r => r.content ?? '').catch(() => ''),
    ]);

    // Derive current save from startparameters (authoritative) or savename fallback.
    const rawParams  = getVar(lgsmText, 'startparameters') || '';
    const paramMatch = rawParams.match(/--start-server\s+\S*\/([^/"\s]+)\.zip/);
    const currentSave = paramMatch?.[1] || getVar(lgsmText, 'savename') || '';

    const saveOpts = saves.map(s => ({ value: s, label: s }));
    if (currentSave && !saveOpts.some(o => o.value === currentSave)) {
      saveOpts.unshift({ value: currentSave, label: currentSave });
    }

    return {
      sections: [
        {
          key:       'loadWorld',
          title:     'Load Existing World',
          saveLabel: 'Load World',
          fields: [
            {
              key:     'saveName',
              label:   'World',
              type:    'select',
              value:   currentSave || saves[0] || '',
              options: saveOpts.length
                ? saveOpts
                : [{ value: '', label: '(no named saves — use Save Current World As first)' }],
            },
          ],
        },
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
}
