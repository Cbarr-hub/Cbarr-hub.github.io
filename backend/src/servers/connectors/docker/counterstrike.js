// Dockerized Counter-Strike 2 connector — target image `joedwards32/cs2`.
//
// IMPORTANT MODEL DIFFERENCE (needs host validation): unlike the LinuxGSM VM
// connector, this image is ENV-DRIVEN at startup — map, mode, max-players, RCON
// password and the GSLT come from container environment variables (CS2_STARTMAP,
// CS2_GAMEALIAS, CS2_MAXPLAYERS, CS2_RCONPW, SRCDS_TOKEN, …) set in
// servers.compose.yml, NOT from an editable cs2server.cfg. There is no in-container
// file whose edit changes the boot config, and the scoped socket-proxy can't
// recreate the container with new env.
//
// So the split is:
//   - PERSISTENT boot defaults  → servers.compose.yml env (edit + recreate).
//   - applyProfileSettings()    → pushes the profile LIVE via RCON to the running
//                                 server (map/mode/hostname/extra cvars). Effective
//                                 immediately; reverts to the compose env on restart.
// The DB-backed workshop catalog + config library + live RCON port over cleanly.

import { DockerBaseConnector } from '../docker-base.js';
import * as csProfile from '../counterstrike-profile.js';
import { fetchItemTitle, fetchCollectionMaps } from '../../steam-workshop.js';
import { rconExchange } from '../../rcon-tcp.js';
import { validateLiveCommand } from '../../rcon.js';
import { badSetting, notFound, duplicateError } from '../../errors.js';

// joedwards32/cs2 install/cfg layout (image-dependent — validate on the host).
const CFG = '/home/steam/cs2-dedicated/game/csgo/cfg';

// Steam Workshop titles are free-text (quotes, newlines, arbitrary length); the
// catalog stores short display names, so coerce an auto-fetched title into one.
const sanitizeAutoName = (title, id) =>
  String(title ?? '').replace(/["\r\n]/g, '').trim().slice(0, 64) || `Workshop ${id}`;

export class DockerCounterStrikeConnector extends DockerBaseConnector {
  configFiles = {
    'server.cfg':   `${CFG}/server.cfg`,
    'autoexec.cfg': `${CFG}/autoexec.cfg`,
  };

  #password() { return process.env.CS2_RCON_PASSWORD ?? ''; }
  #rcon(command) {
    const password = this.#password();
    if (!password) { const e = new Error('CS2_RCON_PASSWORD is not set'); e.code = 'NO_RCON'; throw e; }
    return rconExchange({ host: this.server.container, port: this.server.rconPort ?? 27015, password, command });
  }

  // Profiles own the startup config (the Profiles panel), so getSettings exists
  // only to feed the Runtime panel's live change-map dropdown — the SAME shape the
  // VM/GMOD connectors return: stock maps + the saved workshop catalog (by name).
  // Without this the dropdown is empty (the base default returns no `map` block).
  // The container's boot map is env-driven (unreadable from a file), so `current`
  // reflects the active profile's saved map when there is one.
  async getSettings() {
    const catalog = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    let current = '';
    if (this.store) {
      const activeId = this.store.getActiveProfileId(this.server.id);
      const active = activeId != null ? this.store.getProfile(this.server.id, activeId) : null;
      if (active?.settings?.map) current = active.settings.map;
    }
    return {
      game: 'counterstrike',
      map: {
        stock: csProfile.STOCK_FALLBACK,
        workshop: catalog.map((w) => ({ id: w.workshopId, name: w.name })),
        current,
      },
    };
  }

  // ── startup-config profiles (shared validation/schema) ──────────────────────
  defaultProfileSettings()    { return csProfile.defaultProfileSettings(); }
  validateProfileSettings(s)  { return csProfile.validateProfileSettings(s); }

  async profileSchema() {
    const catalog = this.store ? this.store.listWorkshopMaps(this.server.id) : [];
    const mapOpts = [
      ...csProfile.STOCK_FALLBACK.map((m) => ({ value: m, label: m })),
      ...catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),
    ];
    return csProfile.profileGroups(mapOpts,
      'A Workshop map overrides a stock map. NOTE: for the container, Apply pushes settings LIVE via RCON; ' +
      'persistent boot defaults (map/mode/max-players) live in servers.compose.yml env.');
  }

  // Apply the profile LIVE via RCON (one combined command). Persistent boot config
  // is the compose env — documented in the returned note.
  async applyProfileSettings(settings) {
    const s = this.validateProfileSettings(settings);
    const parts = [];
    if (s.hostname) parts.push(`hostname "${s.hostname}"`);
    parts.push(`game_alias ${s.gameMode}`);
    // Structured Match-Rules cvars (bools as 0/1). Pushed before the map change so
    // mp_roundtime_defuse etc. bite on the reload the changelevel/host_workshop_map triggers.
    for (const f of csProfile.CS_CVAR_FIELDS) {
      parts.push(`${f.cvar} ${f.bool ? (s[f.key] ? 1 : 0) : s[f.key]}`);
    }
    parts.push(csProfile.buildChangeMapCmd(s.map)); // changelevel / host_workshop_map
    if (s.rawConfig) parts.push(...s.rawConfig.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    await this.#rcon(parts.join('; '));
    return {
      ok: true,
      note: 'Applied live via RCON. Max-players and persistent boot defaults live in servers.compose.yml env (edit + recreate the container to change them).',
    };
  }

  // Env-driven boot config isn't readable back from the container, so capture
  // returns the validated defaults (the profile editor is the source of truth).
  async captureProfileSettings() {
    return this.validateProfileSettings(csProfile.defaultProfileSettings());
  }

  // ── workshop map catalog (DB-backed; transport-agnostic) ────────────────────
  listMaps() { return this.requireStore().listWorkshopMaps(this.server.id); }
  // Add one map. When `name` is omitted/blank the title is pulled from Steam
  // (keyless Workshop lookup); a user-supplied name is validated as before.
  async addMap({ workshopId, name } = {}) {
    this.requireStore();
    const id = String(workshopId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw badSetting('workshop id must be 1–20 digits');
    const provided = String(name ?? '').trim();
    const nm = provided
      ? csProfile.validMapName(provided)
      : sanitizeAutoName(await fetchItemTitle(id), id);
    return this.store.addWorkshopMap(this.server.id, { workshopId: id, name: nm });
  }
  // Import every item in a public Steam Workshop collection into the catalog,
  // names fetched automatically. Upserts (re-importing refreshes names), so it's
  // safe to run repeatedly. Returns the count processed + the refreshed catalog.
  async importCollection(collectionId) {
    this.requireStore();
    const maps = await fetchCollectionMaps(collectionId);
    if (!maps.length) throw badSetting('that Workshop collection has no items.');
    for (const m of maps) {
      this.store.addWorkshopMap(this.server.id, { workshopId: m.workshopId, name: sanitizeAutoName(m.name, m.workshopId) });
    }
    const catalog = this.store.listWorkshopMaps(this.server.id);
    // Unified collection-import shape (same as GMOD/PH so the panel renders identically).
    // CS catalogs live — selectable immediately, no restart needed.
    return {
      ok: true,
      imported: maps.length,
      maps: catalog.map((w) => ({ value: `ws:${w.workshopId}`, label: w.name })),
      requiresRestart: false,
      note: 'Imported into the live catalog — selectable immediately; Apply changes the running map over RCON.',
    };
  }
  renameMap(workshopId, name) {
    this.requireStore();
    const nm = csProfile.validMapName(name);
    if (!this.store.renameWorkshopMap(this.server.id, String(workshopId), nm)) throw notFound('workshop map not found');
    return this.store.getWorkshopMap(this.server.id, workshopId);
  }
  deleteMap(workshopId) {
    if (!this.requireStore().deleteWorkshopMap(this.server.id, String(workshopId))) throw notFound('workshop map not found');
    return { ok: true };
  }

  // ── config library (DB-backed; transport-agnostic) ──────────────────────────
  listConfigs() { return this.requireStore().listConfigs(this.server.id); }
  getConfig(id) {
    const cfg = this.requireStore().getConfig(this.server.id, id);
    if (!cfg) throw notFound('config not found');
    return cfg;
  }
  createConfig({ name, body } = {}) {
    this.requireStore();
    const nm = csProfile.validConfigName(name);
    const b  = csProfile.validConfigBody(body);
    try { return this.store.createConfig(this.server.id, { name: nm, body: b }); }
    catch (e) { throw duplicateError(e, nm, 'config'); }
  }
  updateConfig(id, { name, body } = {}) {
    this.requireStore();
    const patch = {};
    if (name !== undefined) patch.name = csProfile.validConfigName(name);
    if (body !== undefined) patch.body = csProfile.validConfigBody(body);
    let updated;
    try { updated = this.store.updateConfig(this.server.id, id, patch); }
    catch (e) { throw duplicateError(e, patch.name, 'config'); }
    if (!updated) throw notFound('config not found');
    return updated;
  }
  deleteConfig(id) {
    if (!this.requireStore().deleteConfig(this.server.id, id)) throw notFound('config not found');
    return { ok: true };
  }

  // ── update the game client (SteamCMD app_update, in-container) ───────────────
  // joedwards32/cs2 ships SteamCMD; refresh the CS2 dedicated files in place, then
  // the panel restarts the container to run the new build. CS2 is Steam appid 730
  // (anonymous). Paths are image-specific — validate on the host.
  async update() {
    const cmd = '/home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/cs2-dedicated '
      + '+login anonymous +app_update 730 +quit';
    const res = await this.runShell(cmd, { timeoutMs: 1_800_000 });
    return {
      ok: res.exitCode === 0,
      note: 'CS2 files refreshed via SteamCMD — restart the server to run the new build.',
      steps: [{ name: 'steamcmd +app_update 730', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }],
    };
  }

  // ── live commands (Source-RCON over TCP) ────────────────────────────────────
  async getLive() {
    if (!this.#password()) return { available: false, reason: 'CS2_RCON_PASSWORD is not set' };
    return {
      available: true,
      actions: csProfile.CS_LIVE_ACTIONS,
      controls: csProfile.CS_LIVE_CONTROLS,
      changeMap: true,
      commandHint: 'any CS2 console command, e.g. bot_add, mp_warmup_end',
    };
  }

  async sendCommand(command) {
    return { output: await this.#rcon(validateLiveCommand(command)) };
  }

  async runLiveAction(key, value) {
    if (key === 'change_map') return { output: await this.#rcon(csProfile.buildChangeMapCmd(value)) };
    const range = csProfile.csRangeCmd(key, value); // slider (clamped) before actions
    if (range) return { output: await this.#rcon(range) };
    const cmd = csProfile.CS_ACTION_CMDS[key];
    if (!cmd) throw badSetting(`unknown live action: ${key}`);
    return { output: await this.#rcon(cmd) };
  }
}
