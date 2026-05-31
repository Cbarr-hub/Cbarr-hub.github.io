// Persistence for the game-server control panel: the Steam Workshop map catalog
// and the reusable game-state config library (see SERVER_PANEL_PLAN.md, Phase 1).
//
// Pure DB access over better-sqlite3 — no Fastify, no Proxmox, no game knowledge.
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
  };

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
  };
}
