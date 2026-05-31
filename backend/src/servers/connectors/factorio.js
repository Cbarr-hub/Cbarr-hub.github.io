// Factorio connector — LinuxGSM instance `fctrserver`.
//
// Verified layout (VM 101, 192.168.1.74) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/fctrserver   (owned by user `miles`)
//   control     : ./fctrserver start|stop|restart|update   (run as miles)
//
// Save management:
//   saves live at : serverfiles/saves/*.zip
//   active save   : `savegame` var in lgsm/config-lgsm/fctrserver/fctrserver.cfg
//                   LinuxGSM uses --start-server "saves/<name>.zip"; set just the
//                   base name (no path, no .zip extension).
//   new worlds    : factorio --create "saves/<name>.zip" --map-gen-settings <json>
//                   [--preset <preset>]   (preset tweaks non-resource settings)

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVar } from '../cfgvars.js';

const DIR       = '/home/miles/fctrserver';
const SAVES_DIR = `${DIR}/serverfiles/saves`;
const LGSM_CFG  = `${DIR}/lgsm/config-lgsm/fctrserver/fctrserver.cfg`;
const FACTORIO  = `${DIR}/serverfiles/bin/x64/factorio`;

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
        .filter(n => n.length > 0);
    } catch {
      return [];
    }
  }

  async getSettings() {
    const [saves, lgsmText] = await Promise.all([
      this.#listSaves(),
      this.client.agentFileRead(this.vmid, LGSM_CFG).then(r => r.content ?? '').catch(() => ''),
    ]);

    const rawSave    = getVar(lgsmText, 'savegame') || '';
    const currentSave = rawSave.replace(/^.*\//, '').replace(/\.zip$/, '');

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
              options: saveOpts.length ? saveOpts : [{ value: '', label: '(no saves found)' }],
            },
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

    // ── Load an existing save ────────────────────────────────────────────────
    if (section === 'loadWorld') {
      const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
      await this.client.agentFileWrite(this.vmid, LGSM_CFG, setVar(lgsmText, 'savegame', cleanName));
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

      // Write map-gen-settings to the home dir (readable by miles as root writes 644).
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

      if (createResult.exitCode !== 0) {
        throw bad(`world generation failed: ${(createResult.stderr || createResult.stdout).slice(0, 300)}`);
      }

      // Set the new save as active.
      const lgsmText = (await this.client.agentFileRead(this.vmid, LGSM_CFG)).content ?? '';
      await this.client.agentFileWrite(this.vmid, LGSM_CFG, setVar(lgsmText, 'savegame', cleanName));

      return {
        ok:       true,
        action:   'generate',
        saveName: cleanName,
        steps:    [{ name: 'create', ...createResult }],
      };
    }

    throw bad(`unknown section: ${section}`);
  }
}
