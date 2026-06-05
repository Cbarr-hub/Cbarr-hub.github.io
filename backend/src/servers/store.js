// Persistence for the game-server control panel: the Steam Workshop map catalog
// and the reusable game-state config library.
//
// Pure DB access over better-sqlite3 — no Fastify, no transport, no game knowledge.
// One store is created per app from the shared DB and injected into the
// connectors (servers/service.js → connectors). Connectors call these methods;
// the store never touches a VM. All ids are scoped by `serverId` (the registry
// id, e.g. 'counterstrike') so one server can never see another's rows.

export function createServerStore(db) {
  const stmts = {
    // ── workshop map catalog ──
    listMaps: db.prepare(
      `SELECT workshop_id AS workshopId, name, created_at, updated_at
         FROM server_workshop_maps
        WHERE server_id = ?
        ORDER BY name COLLATE NOCASE`,
    ),
    getMap: db.prepare(
      `SELECT workshop_id AS workshopId, name, created_at, updated_at
         FROM server_workshop_maps
        WHERE server_id = ? AND workshop_id = ?`,
    ),
    upsertMap: db.prepare(
      `INSERT INTO server_workshop_maps (server_id, workshop_id, name)
            VALUES (?, ?, ?)
       ON CONFLICT(server_id, workshop_id)
         DO UPDATE SET name = excluded.name, updated_at = unixepoch()`,
    ),
    renameMap: db.prepare(
      `UPDATE server_workshop_maps SET name = ?, updated_at = unixepoch()
        WHERE server_id = ? AND workshop_id = ?`,
    ),
    deleteMap: db.prepare(
      `DELETE FROM server_workshop_maps WHERE server_id = ? AND workshop_id = ?`,
    ),

    // ── config library ──
    listConfigs: db.prepare(
      `SELECT id, name, created_at, updated_at
         FROM server_configs
        WHERE server_id = ?
        ORDER BY name COLLATE NOCASE`,
    ),
    getConfig: db.prepare(
      `SELECT id, name, body, created_at, updated_at
         FROM server_configs
        WHERE server_id = ? AND id = ?`,
    ),
    insertConfig: db.prepare(
      `INSERT INTO server_configs (server_id, name, body) VALUES (?, ?, ?)`,
    ),
    updateConfig: db.prepare(
      `UPDATE server_configs SET name = ?, body = ?, updated_at = unixepoch()
        WHERE server_id = ? AND id = ?`,
    ),
    deleteConfig: db.prepare(
      `DELETE FROM server_configs WHERE server_id = ? AND id = ?`,
    ),

    // ── startup-config profiles ──
    listProfiles: db.prepare(
      `SELECT id, name, created_at, updated_at
         FROM server_profiles
        WHERE server_id = ?
        ORDER BY name COLLATE NOCASE`,
    ),
    getProfile: db.prepare(
      `SELECT id, name, settings, created_at, updated_at
         FROM server_profiles
        WHERE server_id = ? AND id = ?`,
    ),
    countProfiles: db.prepare(
      `SELECT COUNT(*) AS n FROM server_profiles WHERE server_id = ?`,
    ),
    insertProfile: db.prepare(
      `INSERT INTO server_profiles (server_id, name, settings) VALUES (?, ?, ?)`,
    ),
    updateProfile: db.prepare(
      `UPDATE server_profiles SET name = ?, settings = ?, updated_at = unixepoch()
        WHERE server_id = ? AND id = ?`,
    ),
    deleteProfile: db.prepare(
      `DELETE FROM server_profiles WHERE server_id = ? AND id = ?`,
    ),
    clearActiveForProfile: db.prepare(
      `DELETE FROM server_active_profile WHERE server_id = ? AND profile_id = ?`,
    ),
    getActiveProfile: db.prepare(
      `SELECT profile_id FROM server_active_profile WHERE server_id = ?`,
    ),
    setActiveProfile: db.prepare(
      `INSERT INTO server_active_profile (server_id, profile_id) VALUES (?, ?)
       ON CONFLICT(server_id) DO UPDATE SET profile_id = excluded.profile_id`,
    ),
  };

  const parseSettings = (json) => { try { return JSON.parse(json); } catch { return {}; } };

  return {
    // ── workshop map catalog ─────────────────────────────────────────────────
    listWorkshopMaps(serverId) {
      return stmts.listMaps.all(serverId);
    },
    getWorkshopMap(serverId, workshopId) {
      return stmts.getMap.get(serverId, String(workshopId)) ?? null;
    },
    // Add a map, or update its name if the workshop id already exists. Returns
    // the stored row.
    addWorkshopMap(serverId, { workshopId, name }) {
      stmts.upsertMap.run(serverId, String(workshopId), name);
      return this.getWorkshopMap(serverId, workshopId);
    },
    // Rename an existing map. Returns true if a row was updated.
    renameWorkshopMap(serverId, workshopId, name) {
      return stmts.renameMap.run(name, serverId, String(workshopId)).changes > 0;
    },
    // Remove a map from the catalog. Returns true if a row was deleted.
    deleteWorkshopMap(serverId, workshopId) {
      return stmts.deleteMap.run(serverId, String(workshopId)).changes > 0;
    },

    // ── config library ───────────────────────────────────────────────────────
    listConfigs(serverId) {
      return stmts.listConfigs.all(serverId);
    },
    getConfig(serverId, id) {
      return stmts.getConfig.get(serverId, id) ?? null;
    },
    createConfig(serverId, { name, body = '' }) {
      const { lastInsertRowid } = stmts.insertConfig.run(serverId, name, body);
      return this.getConfig(serverId, lastInsertRowid);
    },
    // Partial update: only the provided fields change. Returns the updated row,
    // or null if no such config exists.
    updateConfig(serverId, id, { name, body } = {}) {
      const existing = this.getConfig(serverId, id);
      if (!existing) return null;
      stmts.updateConfig.run(name ?? existing.name, body ?? existing.body, serverId, id);
      return this.getConfig(serverId, id);
    },
    deleteConfig(serverId, id) {
      return stmts.deleteConfig.run(serverId, id).changes > 0;
    },

    // ── startup-config profiles ──────────────────────────────────────────────
    // `settings` is stored as a JSON string and (de)serialized here so callers
    // only ever see/pass plain objects. listProfiles omits the body for cheap
    // catalogs; getProfile returns the parsed settings.
    listProfiles(serverId) {
      return stmts.listProfiles.all(serverId);
    },
    getProfile(serverId, id) {
      const row = stmts.getProfile.get(serverId, id);
      if (!row) return null;
      return { ...row, settings: parseSettings(row.settings) };
    },
    countProfiles(serverId) {
      return stmts.countProfiles.get(serverId).n;
    },
    createProfile(serverId, { name, settings = {} }) {
      const { lastInsertRowid } = stmts.insertProfile.run(serverId, name, JSON.stringify(settings));
      return this.getProfile(serverId, lastInsertRowid);
    },
    // Partial update: only provided fields change. Returns the updated row or null.
    updateProfile(serverId, id, { name, settings } = {}) {
      const existing = this.getProfile(serverId, id);
      if (!existing) return null;
      const nextName = name ?? existing.name;
      const nextSettings = settings === undefined ? existing.settings : settings;
      stmts.updateProfile.run(nextName, JSON.stringify(nextSettings), serverId, id);
      return this.getProfile(serverId, id);
    },
    // Delete a profile and clear the active pointer if it referenced it (explicit
    // clear so it's correct even when SQLite FK cascade isn't enforced).
    deleteProfile(serverId, id) {
      const tx = db.transaction(() => {
        stmts.clearActiveForProfile.run(serverId, id);
        return stmts.deleteProfile.run(serverId, id).changes;
      });
      return tx() > 0;
    },
    getActiveProfileId(serverId) {
      return stmts.getActiveProfile.get(serverId)?.profile_id ?? null;
    },
    setActiveProfile(serverId, id) {
      stmts.setActiveProfile.run(serverId, id);
    },
  };
}
