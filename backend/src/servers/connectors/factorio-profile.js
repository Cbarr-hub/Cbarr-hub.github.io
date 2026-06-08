// Pure Factorio profile logic, shared by the base (VM/LinuxGSM) and Docker
// (factoriotools) connectors. Transport-agnostic: it operates on the parsed
// server-settings.json object + the structured settings doc, so each connector
// just supplies read/write of that file and its own save/active-world handling.
//
// PROFILE SCHEMA (fields span TWO config files + the active save)
//   Fields (defaultProfileSettings):
//     saveName    - which saved world to stage as the active one ('' = keep
//                   current); SAFE_NAME_RE. The active-world copy is the
//                   connector's job (it's a file op), not done here.
//     server-settings.json knobs → applyServerSettings / captureServerSettings:
//       serverName (≤200), description (≤500), maxPlayers (0–500, 0=unlimited),
//       visibility ('public' adds {public,lan}; anything else → 'lan'-only),
//       password (≤100), autosaveInterval (1–240 min), autoPause (bool '1'/'0').
//     map-settings.json world rules → applyMapSettings / captureMapSettings:
//       evolutionEnabled / pollutionEnabled / expansionEnabled (bool '1'/'0'),
//       techPriceMultiplier (0.25–10). These are baked into a save AT GENERATION,
//       so they only affect a NEWLY generated world (see PROFILE_NOTE) — a running
//       world is changed via the live Game Speed / Evolution RCON sliders.
//       NOTE: Factorio 2.0 removed MapGenSize 'large'/'very-large' (hard crash);
//       map size is not a profile field here, but keep that constraint in mind for
//       any map-gen tooling.
//   validate (validateProfileSettings): coerces/clamps every field, throwing
//     badSetting on bad world names, out-of-range players/autosave/tech-multiplier;
//     bool-ish toggles normalize to '1'/'0' via the local `bool` helper.
//   apply: the connector reads each JSON file, runs applyServerSettings /
//     applyMapSettings to mutate the parsed object, writes it back, then stages the
//     chosen save; changes take effect on the next restart.
//   capture: captureServerSettings + captureMapSettings read the two files back
//     into a pre-validation doc (the connector merges them, leaving saveName='').

import { badSetting, SAFE_NAME_RE } from '../errors.js';

export const VISIBILITY_OPTS = [
  { value: 'public', label: 'Public (listed) + LAN' },
  { value: 'lan',    label: 'LAN only' },
];

export const PROFILE_NOTE =
  'A profile is the startup config the server boots as. Changes apply on the next restart. ' +
  'Public visibility also needs a Factorio.com token in server-settings.json. ' +
  'World Rules (evolution / pollution / expansion / research cost) live in map-settings.json, ' +
  'which is baked into a save at GENERATION — so they only affect a NEWLY generated world. ' +
  'To change a running world, use the live Game Speed / Evolution controls.';

// Embedded cvar reference for the Raw-Config power-tools sidebar (built from the
// world-settings knobs above). name = the server-settings.json / map-settings.json
// JSON key path; the UI uses it for autocomplete / docs only.
export const FACTORIO_CVAR_REF = [
  { name: 'name',                        type: 'text',   group: 'server-settings.json', help: 'Server name shown in the browser' },
  { name: 'max_players',                 type: 'number', default: 0, min: 0, max: 500, group: 'server-settings.json', help: '0 = unlimited' },
  { name: 'autosave_interval',           type: 'number', default: 10, min: 1, max: 240, group: 'server-settings.json', help: 'Minutes between autosaves' },
  { name: 'auto_pause',                  type: 'bool',   default: 1, group: 'server-settings.json', help: 'Pause the game when no players are connected' },
  { name: 'game_password',               type: 'text',   group: 'server-settings.json', help: 'Join password (blank = none)' },
  { name: 'enemy_evolution.enabled',     type: 'bool',   default: 1, group: 'map-settings.json', help: 'Biter evolution (new world only)' },
  { name: 'pollution.enabled',           type: 'bool',   default: 1, group: 'map-settings.json', help: 'Pollution spread (new world only)' },
  { name: 'enemy_expansion.enabled',     type: 'bool',   default: 1, group: 'map-settings.json', help: 'Biter base expansion (new world only)' },
  { name: 'difficulty_settings.technology_price_multiplier', type: 'number', default: 1, min: 0.25, max: 10, group: 'map-settings.json', help: 'Research cost multiplier (new world only)' },
];

export function defaultProfileSettings() {
  return {
    saveName: '', serverName: 'Gamertown Factorio', description: '',
    maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
    // World rules — auto_pause lives in server-settings.json; the evolution /
    // pollution / expansion / tech knobs live in map-settings.json (boot truth,
    // only affects a NEWLY generated world — see PROFILE_NOTE).
    autoPause: '1', evolutionEnabled: '1', pollutionEnabled: '1',
    expansionEnabled: '1', techPriceMultiplier: 1,
  };
}

// '1' / '0' normalizer for the bool-ish world-rule toggles.
const bool = (v) => (String(v) === '1' || v === true ? '1' : '0');

export function validateProfileSettings(s = {}) {
  const out = {};
  out.saveName = String(s.saveName ?? '').trim();
  if (out.saveName && !SAFE_NAME_RE.test(out.saveName)) throw badSetting('invalid world name');
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
  // World rules.
  out.autoPause        = bool(s.autoPause);
  out.evolutionEnabled = bool(s.evolutionEnabled);
  out.pollutionEnabled = bool(s.pollutionEnabled);
  out.expansionEnabled = bool(s.expansionEnabled);
  const tpm = Number(s.techPriceMultiplier);
  if (!(tpm >= 0.25 && tpm <= 10)) throw badSetting('tech price multiplier must be 0.25–10');
  out.techPriceMultiplier = tpm;
  return out;
}

// Materialize the validated server-settings knobs onto a parsed server-settings.json
// object, returning the mutated object. (Active-world selection is the connector's
// job — it differs per transport.)
export function applyServerSettings(json, validated) {
  json.name              = validated.serverName;
  json.description       = validated.description;
  json.max_players       = validated.maxPlayers;
  json.visibility        = validated.visibility === 'public'
    ? { public: true, lan: true }
    : { public: false, lan: true };
  json.game_password     = validated.password;
  json.autosave_interval = validated.autosaveInterval;
  json.auto_pause        = validated.autoPause === '1';
  return json;
}

// Materialize the validated world-rule knobs onto a parsed map-settings.json
// object, returning the mutated object. map-settings.json is baked into the save
// at GENERATION, so editing it only affects a NEWLY generated world — a running
// world is changed via the live RCON /sc controls (see docker/factorio.js).
export function applyMapSettings(json, validated) {
  json.enemy_evolution = { ...(json.enemy_evolution || {}), enabled: validated.evolutionEnabled === '1' };
  json.pollution       = { ...(json.pollution       || {}), enabled: validated.pollutionEnabled === '1' };
  json.enemy_expansion = { ...(json.enemy_expansion || {}), enabled: validated.expansionEnabled === '1' };
  json.difficulty_settings = {
    ...(json.difficulty_settings || {}),
    technology_price_multiplier: validated.techPriceMultiplier,
  };
  return json;
}

// Read the server-settings.json knobs back into a (pre-validation) settings doc.
// max_players / autosave_interval are clamped to the validator's accepted range
// (same rationale as captureMapSettings' techPriceMultiplier): a hand-edited
// server-settings.json can hold an out-of-range value, and capture re-runs
// validateProfileSettings — an unclamped value would throw and break the
// capture↔apply round-trip. (autosave_interval=0 is an integer, so the ternary
// won't rescue it; the clamp floors it to 1.)
export function captureServerSettings(json = {}) {
  return {
    serverName: json.name ?? '',
    description: json.description ?? '',
    maxPlayers: Number.isInteger(json.max_players) ? Math.max(0, Math.min(500, json.max_players)) : 0,
    visibility: json.visibility?.public ? 'public' : 'lan',
    password: json.game_password ?? '',
    autosaveInterval: Number.isInteger(json.autosave_interval) ? Math.max(1, Math.min(240, json.autosave_interval)) : 10,
    autoPause: json.auto_pause === false ? '0' : '1',
  };
}

// Read the map-settings.json world rules back into a (pre-validation) settings doc.
// The connector merges this over captureServerSettings (the two files are separate).
export function captureMapSettings(json = {}) {
  return {
    evolutionEnabled: json.enemy_evolution?.enabled === false ? '0' : '1',
    pollutionEnabled: json.pollution?.enabled       === false ? '0' : '1',
    expansionEnabled: json.enemy_expansion?.enabled === false ? '0' : '1',
    // Clamp to the validator's accepted range: a hand-edited save can hold a value
    // outside 0.25–10, and capture re-runs validateProfileSettings — an unclamped
    // out-of-range value would throw and break the capture↔apply round-trip.
    techPriceMultiplier: Number.isFinite(json.difficulty_settings?.technology_price_multiplier)
      ? Math.max(0.25, Math.min(10, json.difficulty_settings.technology_price_multiplier)) : 1,
  };
}

// The Profiles editor groups (World / Server Settings). `saveOpts` is the
// connector-supplied <select> option list for the active world.
export function profileGroups(saveOpts) {
  return [
    {
      key: 'world', title: 'World',
      fields: [
        { key: 'saveName', label: 'Active World', type: 'select', options: saveOpts, basic: true,
          help: 'Which saved world the server loads on (re)start. Create/copy/generate worlds in Quick Settings below.' },
      ],
    },
    {
      key: 'server', title: 'Server Settings',
      fields: [
        { key: 'serverName',  label: 'Server Name',  type: 'text', basic: true },
        { key: 'description', label: 'Description',   type: 'text' },
        { key: 'maxPlayers',  label: 'Max Players (0 = unlimited)', type: 'number', min: 0, max: 500, step: 1, basic: true },
        { key: 'visibility',  label: 'Visibility',    type: 'select', options: VISIBILITY_OPTS },
        { key: 'password',    label: 'Game Password (blank = none)', type: 'text', basic: true },
        { key: 'autosaveInterval', label: 'Autosave Interval (min)', type: 'number', min: 1, max: 240, step: 1 },
      ],
    },
    {
      key: 'rules', title: 'World Rules',
      fields: [
        { key: 'autoPause',        label: 'Auto-pause when empty', type: 'bool', basic: true },
        { key: 'evolutionEnabled', label: 'Biter Evolution',       type: 'bool', basic: true },
        { key: 'pollutionEnabled', label: 'Pollution',             type: 'bool', basic: true },
        { key: 'expansionEnabled', label: 'Biter Expansion',       type: 'bool', basic: true },
        { key: 'techPriceMultiplier', label: 'Research Cost ×', type: 'number', min: 0.25, max: 10, step: 0.25, basic: true,
          help: 'World rules below are baked into a save at generation — they only affect a NEWLY generated world.' },
      ],
    },
  ];
}
