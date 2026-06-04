// Pure Factorio profile logic, shared by the Proxmox (VM/LinuxGSM) and Docker
// (factoriotools) connectors. Transport-agnostic: it operates on the parsed
// server-settings.json object + the structured settings doc, so each connector
// just supplies read/write of that file and its own save/active-world handling.

import { badSetting, SAFE_NAME_RE } from '../errors.js';

export const VISIBILITY_OPTS = [
  { value: 'public', label: 'Public (listed) + LAN' },
  { value: 'lan',    label: 'LAN only' },
];

export const PROFILE_NOTE =
  'A profile is the startup config the server boots as. Changes apply on the next restart. ' +
  'Public visibility also needs a Factorio.com token in server-settings.json.';

export function defaultProfileSettings() {
  return {
    saveName: '', serverName: 'Gamertown Factorio', description: '',
    maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
  };
}

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
  return json;
}

// Read the server-settings.json knobs back into a (pre-validation) settings doc.
export function captureServerSettings(json = {}) {
  return {
    serverName: json.name ?? '',
    description: json.description ?? '',
    maxPlayers: Number.isInteger(json.max_players) ? json.max_players : 0,
    visibility: json.visibility?.public ? 'public' : 'lan',
    password: json.game_password ?? '',
    autosaveInterval: Number.isInteger(json.autosave_interval) ? json.autosave_interval : 10,
  };
}

// The Profiles editor groups (World / Server Settings). `saveOpts` is the
// connector-supplied <select> option list for the active world.
export function profileGroups(saveOpts) {
  return [
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
  ];
}
