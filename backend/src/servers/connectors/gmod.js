// Garry's Mod connector — LinuxGSM instance `gmodserver`, running the
// Trouble in Terrorist Town (terrortown) gamemode.
//
// Verified layout (VM 104) — see INFRA.md "Game Server VMs":
//   install dir : /home/miles/gmodserver   (owned by user `miles`)
//   control     : ./gmodserver start|stop|restart|update   (run as miles)
//
// Where TTT settings live (this is the whole game model):
//   instance cfg : lgsm/config-lgsm/gmodserver/gmodserver.cfg
//     gamemode="terrortown"          the gamemode (we keep this pinned)
//     defaultmap="ttt_…"             map the server boots into
//     maxplayers="<n>"               player slots
//     wscollectionid="<id>"          Steam Workshop COLLECTION — auto-downloads
//                                    all its maps/addons on (re)start
//   common cfg : lgsm/config-lgsm/gmodserver/common.cfg
//     rconpassword / gslt            (set out-of-band; not edited here)
//   game cfg : serverfiles/garrysmod/cfg/gmodserver.cfg   (Source cvars; launched
//              via `+servercfgfile gmodserver.cfg` — NOT a server.cfg)
//     ttt_round_limit / ttt_time_limit_minutes        when the map rotates
//     ttt_always_use_mapcycle 1                        rotate via mapcycle.txt
//     ttt_traitor_pct / ttt_traitor_max               traitor ratio + cap
//     ttt_detective_pct / ttt_detective_max           detective ratio + cap
//     ttt_minimum_players                              players needed to start
//     rcon_password                                    enables the Runtime panel
//   map rotation : serverfiles/garrysmod/mapcycle.txt  (one map name per line)
// All of the above apply on the next server restart.

import { LinuxGsmConnector } from './linuxgsm.js';
import { getVar, setVars } from '../cfgvars.js';
import { getCvar, setCvars } from '../cvars.js';
import { rconCommand, validateLiveCommand } from '../rcon.js';

const DIR        = '/home/miles/gmodserver';
const GARRYSMOD  = `${DIR}/serverfiles/garrysmod`;
// LinuxGSM launches srcds with `+servercfgfile gmodserver.cfg`, so the Source
// game config (where TTT cvars + rcon_password live) is cfg/gmodserver.cfg —
// NOT a server.cfg. Distinct from the LinuxGSM *instance* cfg of the same name.
const SERVER_CFG = `${GARRYSMOD}/cfg/gmodserver.cfg`;
const MAPCYCLE   = `${GARRYSMOD}/mapcycle.txt`;
const INSTANCE_CFG = `${DIR}/lgsm/config-lgsm/gmodserver/gmodserver.cfg`;
const COMMON_CFG   = `${DIR}/lgsm/config-lgsm/gmodserver/common.cfg`;
const MAPS_DIR   = `${GARRYSMOD}/maps`;

// GMOD serves Source RCON on the game port (27066 — see registry).
const RCON_PORT = 27066;
const GMOD_LIVE_ACTIONS = [
  { key: 'players', label: 'List Players' },
];
const GMOD_ACTION_CMDS = { players: 'status' };

const MAP_RE = /^[a-z0-9_]{1,64}$/;

// Maps that ship with the base install, so they're always loadable even with no
// workshop collection — the safe floor for defaults + the boot-map guard.
const STOCK_ALWAYS = ['gm_construct', 'gm_flatgrass'];

const badSetting = (msg) => { const e = new Error(msg); e.code = 'BAD_SETTING'; return e; };

// TTT cvar field specs (key in server.cfg, UI label, numeric bounds). pct fields
// are 0..1 fractions; the rest are integers. Kept as data so getSettings builds
// the panel and setSettings validates from one source.
const TTT_FIELDS = [
  { cvar: 'ttt_round_limit',        key: 'roundLimit',     label: 'Rounds per Map',        def: 6,    min: 1,  max: 100,  int: true },
  { cvar: 'ttt_time_limit_minutes', key: 'timeLimit',      label: 'Time Limit (min)',      def: 75,   min: 1,  max: 600,  int: true },
  { cvar: 'ttt_traitor_pct',        key: 'traitorPct',     label: 'Traitor Ratio (0–1)',   def: 0.25, min: 0,  max: 1 },
  { cvar: 'ttt_traitor_max',        key: 'traitorMax',     label: 'Max Traitors',          def: 32,   min: 1,  max: 64,   int: true },
  { cvar: 'ttt_detective_pct',      key: 'detectivePct',   label: 'Detective Ratio (0–1)', def: 0.13, min: 0,  max: 1 },
  { cvar: 'ttt_detective_max',      key: 'detectiveMax',   label: 'Max Detectives',        def: 32,   min: 1,  max: 64,   int: true },
  { cvar: 'ttt_minimum_players',    key: 'minPlayers',     label: 'Min Players to Start',  def: 2,    min: 1,  max: 64,   int: true },
];

export class GmodConnector extends LinuxGsmConnector {
  gsmUser = 'miles';
  gsmDir = DIR;
  gsmScript = 'gmodserver';

  configFiles = {
    'server.cfg':      SERVER_CFG,
    'mapcycle.txt':    MAPCYCLE,
    'lgsm.cfg':        INSTANCE_CFG,
    'lgsm-common.cfg': COMMON_CFG,
  };

  // List available ttt_* maps. Two sources, unioned: maps extracted under
  // garrysmod/maps/, AND maps inside downloaded Steam Workshop addons (which mount
  // straight from .gma in the cache and are never written to maps/). The .gma
  // file list embeds each `maps/<name>.bsp` path, so grep pulls them out without
  // unpacking. This is what populates both the Startup map select and the live
  // change-map control with the collection's maps.
  // Maps offered to the panel = what will actually LOAD on the next boot:
  //   - stock .bsp maps under garrysmod/maps/ (always present: gm_construct, …)
  //   - workshop maps from the mounted collection cache, but ONLY when a
  //     wscollectionid is set. An empty collection mounts 0 addons, so those
  //     cached .gma maps can't load — offering them is what let a profile pick an
  //     unmountable boot map and brick startup. So the list is collection-driven.
  async #listMaps() {
    const inst = await this.client.agentFileRead(this.vmid, INSTANCE_CFG)
      .then((r) => r.content ?? '').catch(() => '');
    const collectionSet = !!(getVar(inst, 'wscollectionid') || '').trim();
    try {
      const cacheCmd = collectionSet
        ? `LANG=C grep -ahoE 'maps/[A-Za-z0-9_]+\\.bsp' ${GARRYSMOD}/cache/srcds/*.gma 2>/dev/null;`
        : '';
      const res = await this.runShell(
        `{ ls -1 ${MAPS_DIR}/*.bsp 2>/dev/null; ${cacheCmd} } | sed -E 's#.*/##; s#\\.bsp$##' | sort -u`,
        { asUser: this.gsmUser, timeoutMs: 20_000 },
      );
      const names = (res.stdout || '').split('\n')
        .map((l) => l.trim())
        .filter((n) => /^(ttt_|gm_)[a-z0-9_]*$/.test(n));
      return [...new Set(names)].sort();
    } catch {
      return [];
    }
  }

  async getSettings() {
    const [game, inst, mapcycle, maps] = await Promise.all([
      this.client.agentFileRead(this.vmid, SERVER_CFG).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, INSTANCE_CFG).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, MAPCYCLE).then((r) => r.content ?? '').catch(() => ''),
      this.#listMaps(),
    ]);

    const defaultMap = (getVar(inst, 'defaultmap') || '').trim();
    const collection = (getVar(inst, 'wscollectionid') || '').trim();
    const maxplayers = Number(getVar(inst, 'maxplayers') || 16);

    const num = (cvar, def) => {
      const v = getCvar(game, cvar);
      return v === undefined || v === '' ? def : Number(v);
    };
    const useMapcycle = num('ttt_always_use_mapcycle', 1) ? '1' : '0';

    // Map select: installed ttt_* maps, plus the current defaultmap if not listed.
    const mapOpts = maps.map((m) => ({ value: m, label: m }));
    if (defaultMap && !mapOpts.some((o) => o.value === defaultMap)) {
      mapOpts.unshift({ value: defaultMap, label: defaultMap });
    }
    if (!mapOpts.length) mapOpts.push({ value: defaultMap || 'ttt_minecraft_b5', label: defaultMap || 'ttt_minecraft_b5' });

    const tttFields = TTT_FIELDS.map((f) => ({
      key: f.key, label: f.label, type: 'number', value: num(f.cvar, f.def),
      min: f.min, max: f.max,
    }));

    return {
      game: 'gmod',
      // CS-compatible `map` block so the Runtime panel's live change-map dropdown
      // (which reads data.map.stock/workshop/current) populates with the same maps.
      // GMOD maps are plain bsp names, so they all go in `stock`.
      map: { stock: maps.length ? maps : [defaultMap].filter(Boolean), workshop: [], current: defaultMap },
      sections: [
        {
          key: 'ttt',
          title: 'TTT Settings',
          saveLabel: 'Apply (restart to take effect)',
          fields: [
            { key: 'map', label: 'Starting Map', type: 'select', value: defaultMap || mapOpts[0].value, options: mapOpts },
            { key: 'maxPlayers', label: 'Max Players', type: 'number', value: maxplayers, min: 1, max: 128 },
            { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text', value: collection, placeholder: 'Steam collection id (auto-downloads maps)' },
            ...tttFields,
            { key: 'useMapcycle', label: 'Auto-rotate via Map Cycle', type: 'select', value: useMapcycle,
              options: [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }] },
            { key: 'mapcycle', label: 'Map Cycle (one per line)', type: 'textarea', value: mapcycle.replace(/\r/g, ''),
              placeholder: 'ttt_minecraft_b5\nttt_rooftops_a3_v2\nttt_67thway_v3' },
          ],
        },
      ],
      note: 'Map collection auto-downloads on restart. Maps rotate after the round or time limit using the Map Cycle. All changes apply on the next server restart.',
    };
  }

  async setSettings(values = {}) {
    const { section } = values;
    if (section && section !== 'ttt') throw badSetting(`unknown section: ${section}`);

    // ── instance cfg: map / players / workshop collection ──
    const instVars = {};
    if (values.map !== undefined) {
      const map = String(values.map).trim();
      if (!MAP_RE.test(map)) throw badSetting(`invalid map name: ${map}`);
      instVars.defaultmap = map;
    }
    if (values.maxPlayers !== undefined) {
      const mp = Number(values.maxPlayers);
      if (!Number.isInteger(mp) || mp < 1 || mp > 128) throw badSetting('maxPlayers must be 1–128');
      instVars.maxplayers = String(mp);
    }
    if (values.workshopCollection !== undefined) {
      const id = String(values.workshopCollection).trim();
      if (id !== '' && !/^\d{1,20}$/.test(id)) throw badSetting('workshop collection id must be digits');
      instVars.wscollectionid = id;
    }
    if (Object.keys(instVars).length) {
      let inst = (await this.client.agentFileRead(this.vmid, INSTANCE_CFG)).content ?? '';
      inst = setVars(inst, instVars);
      await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, inst);
    }

    // ── server.cfg: TTT cvars + mapcycle toggle ──
    const cvars = {};
    for (const f of TTT_FIELDS) {
      if (values[f.key] === undefined) continue;
      const n = Number(values[f.key]);
      if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
      if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
      if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
      cvars[f.cvar] = String(n);
    }
    if (values.useMapcycle !== undefined) {
      cvars.ttt_always_use_mapcycle = String(values.useMapcycle) === '0' ? '0' : '1';
    }
    if (Object.keys(cvars).length) {
      let game = (await this.client.agentFileRead(this.vmid, SERVER_CFG)).content ?? '';
      game = setCvars(game, cvars);
      await this.client.agentFileWrite(this.vmid, SERVER_CFG, game);
    }

    // ── mapcycle.txt: sanitized list of map names ──
    if (values.mapcycle !== undefined) {
      const lines = String(values.mapcycle).split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'));
      for (const l of lines) {
        if (!MAP_RE.test(l)) throw badSetting(`invalid map in cycle: ${l}`);
      }
      await this.client.agentFileWrite(this.vmid, MAPCYCLE, lines.join('\n') + (lines.length ? '\n' : ''));
    }

    return { ok: true, applied: { section: 'ttt' } };
  }

  // ── startup-config profiles ─────────────────────────────────────────────────
  // A GMOD profile is the whole TTT startup config: starting map + ordered
  // rotation, the ttt_* gameplay cvars, player slots, and the workshop collection.
  // applyProfile writes them across the instance cfg (defaultmap / maxplayers /
  // wscollectionid + the gt_active_profile mirror), the game cfg (ttt_* +
  // ttt_always_use_mapcycle), and mapcycle.txt. Takes effect on the next restart.

  defaultProfileSettings() {
    // Boot to a stock map that always exists (TTT runs fine on it). Workshop maps
    // become available once a collection is set — never default to one.
    const d = {
      map: 'gm_construct', maxPlayers: 16, workshopCollection: '',
      useMapcycle: '1', mapcycle: ['gm_construct'],
    };
    for (const f of TTT_FIELDS) d[f.key] = f.def;
    return d;
  }

  validateProfileSettings(s = {}) {
    const out = {};

    const map = String(s.map ?? '').trim();
    if (!MAP_RE.test(map)) throw badSetting(`invalid map name: ${map}`);
    out.map = map;

    const mp = Number(s.maxPlayers);
    if (!Number.isInteger(mp) || mp < 1 || mp > 128) throw badSetting('maxPlayers must be 1–128');
    out.maxPlayers = mp;

    const coll = String(s.workshopCollection ?? '').trim();
    if (coll !== '' && !/^\d{1,20}$/.test(coll)) throw badSetting('workshop collection id must be digits');
    out.workshopCollection = coll;

    for (const f of TTT_FIELDS) {
      const n = Number(s[f.key]);
      if (Number.isNaN(n)) throw badSetting(`${f.label} must be a number`);
      if (n < f.min || n > f.max) throw badSetting(`${f.label} must be ${f.min}–${f.max}`);
      if (f.int && !Number.isInteger(n)) throw badSetting(`${f.label} must be a whole number`);
      out[f.key] = n;
    }

    out.useMapcycle = String(s.useMapcycle) === '0' ? '0' : '1';

    const raw = Array.isArray(s.mapcycle) ? s.mapcycle : String(s.mapcycle ?? '').split('\n');
    const cycle = raw.map((l) => String(l).trim()).filter((l) => l && !l.startsWith('//'));
    for (const l of cycle) if (!MAP_RE.test(l)) throw badSetting(`invalid map in cycle: ${l}`);
    out.mapcycle = cycle;

    return out;
  }

  async profileSchema() {
    const discovered = await this.#listMaps();
    // Always offer the stock fallback maps (gm_construct/gm_flatgrass), plus what
    // the collection has downloaded. The map fields are combos (custom:true) so a
    // collection map can be typed as the start map even before its first download.
    const mapOpts = [...new Set([...STOCK_ALWAYS, ...discovered])].map((m) => ({ value: m, label: m }));
    const numField = (f) => ({ key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.int ? 1 : 0.01 });

    return {
      groups: [
        {
          key: 'map', title: 'Maps & Rotation',
          fields: [
            { key: 'workshopCollection', label: 'Workshop Collection ID', type: 'text',
              placeholder: 'Steam Workshop collection id',
              help: 'Steam stores & manages these maps. Set this, then pick your start map / rotation from the collection. After changing it, Apply then Restart Hosting once so Steam downloads the maps.' },
            { key: 'map', label: 'Starting Map', type: 'select', custom: true, options: mapOpts,
              help: 'Pick one of your collection’s maps (type its name — selectable even before its first download). gm_construct is the always-available fallback.' },
            { key: 'useMapcycle', label: 'Auto-rotate through the rotation', type: 'bool' },
            { key: 'mapcycle', label: 'Map Rotation (in order)', type: 'maplist', custom: true, options: mapOpts,
              help: 'After each round/time limit the server advances to the next map. Add collection maps by name; gm_construct works as a fallback.' },
          ],
        },
        {
          key: 'gameplay', title: 'Gameplay',
          fields: [
            { key: 'maxPlayers', label: 'Max Players', type: 'number', min: 1, max: 128, step: 1 },
            ...TTT_FIELDS.map(numField),
          ],
        },
      ],
      note: 'A profile is the startup config the server boots as. Maps come from your Workshop Collection (gm_construct is the fallback). Changes apply on the next restart.',
    };
  }

  async applyProfileSettings(settings, profileId) {
    const s = this.validateProfileSettings(settings);

    // Boot-map guard. With NO workshop collection set, only stock maps can load —
    // a workshop map would mount nothing and leave the server with "no active map"
    // (the exact brick we hit). So block a non-stock boot/rotation map when the
    // collection is empty. When a collection IS set we trust it: GMOD downloads +
    // mounts it at boot before loading the map, so its maps are fine.
    if (!s.workshopCollection) {
      const loadable = new Set([...(await this.#listMaps()), ...STOCK_ALWAYS]);
      const missing = [...new Set([s.map, ...s.mapcycle])].filter((m) => !loadable.has(m));
      if (missing.length) {
        throw badSetting(
          `no Workshop Collection is set, so only stock maps can load (${[...loadable].sort().join(', ')}). ` +
          `These need a collection: ${missing.join(', ')}. Set a Workshop Collection ID to use workshop maps, ` +
          `then Restart Hosting once so Steam downloads them.`,
        );
      }
    }

    let inst = (await this.client.agentFileRead(this.vmid, INSTANCE_CFG)).content ?? '';
    inst = setVars(inst, {
      defaultmap: s.map,
      maxplayers: String(s.maxPlayers),
      wscollectionid: s.workshopCollection,
      ...(profileId != null ? { gt_active_profile: String(profileId) } : {}),
    });
    await this.client.agentFileWrite(this.vmid, INSTANCE_CFG, inst);

    let game = (await this.client.agentFileRead(this.vmid, SERVER_CFG)).content ?? '';
    const cvars = { ttt_always_use_mapcycle: s.useMapcycle };
    for (const f of TTT_FIELDS) cvars[f.cvar] = String(s[f.key]);
    game = setCvars(game, cvars);
    await this.client.agentFileWrite(this.vmid, SERVER_CFG, game);

    await this.client.agentFileWrite(this.vmid, MAPCYCLE, s.mapcycle.join('\n') + (s.mapcycle.length ? '\n' : ''));
    return { ok: true };
  }

  async captureProfileSettings() {
    const [game, inst, mapcycle] = await Promise.all([
      this.client.agentFileRead(this.vmid, SERVER_CFG).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, INSTANCE_CFG).then((r) => r.content ?? '').catch(() => ''),
      this.client.agentFileRead(this.vmid, MAPCYCLE).then((r) => r.content ?? '').catch(() => ''),
    ]);
    const num = (cvar, def) => {
      const v = getCvar(game, cvar);
      return v === undefined || v === '' ? def : Number(v);
    };
    const doc = {
      map: (getVar(inst, 'defaultmap') || 'ttt_minecraft_b5').trim(),
      maxPlayers: Number(getVar(inst, 'maxplayers') || 16),
      workshopCollection: (getVar(inst, 'wscollectionid') || '').trim(),
      useMapcycle: num('ttt_always_use_mapcycle', 1) ? '1' : '0',
      mapcycle: mapcycle.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean),
    };
    for (const f of TTT_FIELDS) doc[f.key] = num(f.cvar, f.def);
    return this.validateProfileSettings(doc);
  }

  // ── live commands (Source RCON on the game port, like CS2) ──
  async #rconPassword() {
    const game = await this.client.agentFileRead(this.vmid, SERVER_CFG).then((r) => r.content ?? '').catch(() => '');
    return (getCvar(game, 'rcon_password') || '').trim();
  }

  async getLive() {
    const pw = await this.#rconPassword();
    if (!pw) return { available: false, reason: 'RCON disabled — set rcon_password in server.cfg and restart' };
    return {
      available: true,
      actions: GMOD_LIVE_ACTIONS,
      changeMap: true, // panel renders a live change-map control
      commandHint: 'any GMOD/TTT console command, e.g. ttt_round_limit 5, changelevel ttt_…, status',
    };
  }

  async sendCommand(command) {
    const cmd = validateLiveCommand(command);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') {
      const v = String(value ?? '').trim();
      if (!MAP_RE.test(v)) throw badSetting(`invalid map: ${v}`);
      return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: `changelevel ${v}` });
    }
    const cmd = GMOD_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return rconCommand(this, { port: RCON_PORT, password: await this.#rconPassword(), command: cmd });
  }
}
