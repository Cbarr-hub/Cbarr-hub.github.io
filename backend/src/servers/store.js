// Persistence for the game-server control panel.
//
// Pure DB access over better-sqlite3 — no Fastify, no transport, no game knowledge.
// One store is created per app from the shared DB and injected into the
// connectors (servers/service.js → connectors). Connectors call these methods;
// the store never touches a container/VM. All control-panel rows are scoped by
// `serverId` (the registry id, e.g. 'counterstrike') so one server can never see
// another's rows; the session-tracking rows are scoped by hosted-game slug.
//
// Five concerns, in section order below:
//   1. Workshop map catalog  — persisted Steam Workshop maps (migration 002).
//   2. Config library        — reusable raw cfg snippets (migration 002).
//   3. Startup-config profiles — named structured boot configs (migration 003).
//   4. Player-session tracking — who joined/left each hosted server. WRITES here
//      are the tested canonical SQL; the host collector (tools/gt-session-tracker.mjs)
//      mirrors the same statements via the sqlite3 CLI (migration 005/006).
//   5. Presence + cross-game activity — read-only roster/timeline views over the
//      session rows for the panel's "Events"/fleet badges.

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

    // ── player-session tracking (shared with the host collector) ──
    // The five game servers live in the party-games `games` table tagged
    // hosted=1; sessions FK to games(id). slug→id is cached below.
    // Conflict target carries the partial-index predicate (migration 006:
    // `idx_games_slug ... WHERE hosted = 1`) — SQLite requires the WHERE clause in
    // the ON CONFLICT target to match the partial unique index it should use.
    upsertHostedGame: db.prepare(
      `INSERT INTO games (name, slug, identity_kind, hosted) VALUES (?, ?, ?, 1)
       ON CONFLICT(slug) WHERE hosted = 1
         DO UPDATE SET name = excluded.name, identity_kind = excluded.identity_kind`,
    ),
    listHostedGames: db.prepare(
      `SELECT id, slug FROM games WHERE hosted = 1`,
    ),
    upsertPlayer: db.prepare(
      `INSERT INTO players (identity_kind, uid, name) VALUES (?, ?, ?)
       ON CONFLICT(identity_kind, uid)
         DO UPDATE SET name = excluded.name, last_seen = unixepoch()
       RETURNING id`,
    ),
    openSession: db.prepare(
      `INSERT INTO server_sessions
         (game_id, player_id, identity_kind, uid, name, joined_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    closeSession: db.prepare(
      `UPDATE server_sessions SET left_at = ? WHERE id = ? AND left_at IS NULL`,
    ),
    closeAllOpen: db.prepare(
      `UPDATE server_sessions SET left_at = ?, source = ? WHERE left_at IS NULL`,
    ),
    listSessions: db.prepare(
      `SELECT id, name, uid, identity_kind AS identityKind, joined_at, left_at, source
         FROM server_sessions
        WHERE game_id = ?
        ORDER BY joined_at DESC
        LIMIT ?`,
    ),
    // ── presence + cross-game activity ──
    // Open-session counts per hosted slug (uses idx_sessions_game_open).
    onlineCounts: db.prepare(
      `SELECT g.slug AS slug, COUNT(*) AS n
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE s.left_at IS NULL AND g.hosted = 1
        GROUP BY g.slug`,
    ),
    // Who's online right now, across every hosted server (newest join first).
    listOnline: db.prepare(
      `SELECT g.slug AS slug, g.name AS gameName, s.name, s.uid,
              s.identity_kind AS identityKind, s.joined_at, s.source
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE s.left_at IS NULL AND g.hosted = 1
        ORDER BY s.joined_at DESC`,
    ),
    // Recent join/leave activity merged across all hosted servers (the timeline).
    recentSessions: db.prepare(
      `SELECT s.id, g.slug AS slug, g.name AS gameName, s.name, s.uid,
              s.identity_kind AS identityKind, s.joined_at, s.left_at, s.source
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE g.hosted = 1
        ORDER BY s.joined_at DESC
        LIMIT ?`,
    ),
  };

  const parseSettings = (json) => { try { return JSON.parse(json); } catch { return {}; } };

  // Lazy slug→games.id cache for the hosted servers (rebuilt by seedHostedGames).
  let gameIdBySlug = null;
  const gameId = (slug) => {
    if (!gameIdBySlug) {
      gameIdBySlug = new Map(stmts.listHostedGames.all().map((r) => [r.slug, r.id]));
    }
    return gameIdBySlug.get(slug) ?? null;
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

    // ── player-session tracking ──────────────────────────────────────────────
    // Idempotently register the hosted game servers (hosted=1) in the `games`
    // catalog from the registry, so adding a server needs no migration. Rebuilds
    // the slug→id cache. `list` is registry entries { id, name, identityKind }.
    seedHostedGames(list) {
      const tx = db.transaction(() => {
        for (const s of list) {
          if (!s.identityKind) continue;
          stmts.upsertHostedGame.run(s.name, s.id, s.identityKind);
        }
      });
      tx();
      gameIdBySlug = null; // force a rebuild on next read
    },

    // Record a player joining `slug` at `now` (unix seconds). When the player has
    // a uid (not CS2-redacted), upsert the global `players` row so it doubles as
    // the whitelist roster; always open a session snapshotting the join. Returns
    // the new session id, or null if the slug isn't a known hosted game.
    recordJoin(slug, p, now, source = 'log') {
      const gid = gameId(slug);
      if (gid == null) return null;
      let playerId = null;
      if (p.uid != null) {
        playerId = stmts.upsertPlayer.get(p.identityKind, String(p.uid), p.name).id;
      }
      const { lastInsertRowid } = stmts.openSession.run(
        gid, playerId, p.identityKind, p.uid != null ? String(p.uid) : null, p.name, now, source,
      );
      return lastInsertRowid;
    },
    closeSession(id, leftAt) {
      return stmts.closeSession.run(leftAt, id).changes > 0;
    },
    // Close every still-open session across ALL hosted servers at once (collector
    // or container restart: we can't know the real leave time, so stamp `leftAt`
    // on every open row and tag them with `source` — 'reconciled' by default — so
    // the timeline shows the leave was inferred). Returns the number of rows closed.
    closeAllOpenSessions(leftAt, source = 'reconciled') {
      return stmts.closeAllOpen.run(leftAt, source).changes;
    },
    listSessions(slug, { limit = 200 } = {}) {
      const gid = gameId(slug);
      if (gid == null) return [];
      const lim = Math.min(500, Math.max(1, Number(limit) || 200));
      return stmts.listSessions.all(gid, lim);
    },

    // ── presence + cross-game activity ───────────────────────────────────────
    // These are read-only aggregate views over server_sessions for the panel.
    //
    // Open-session count per hosted slug, e.g. { gmod: 2, minecraft: 1 } — drives
    // the fleet tiles' "playing now" badge. Slugs with nobody online are omitted
    // (GROUP BY only yields rows that have at least one open session).
    onlineCountsBySlug() {
      const out = {};
      for (const r of stmts.onlineCounts.all()) out[r.slug] = r.n;
      return out;
    },
    // The live roster across all hosted servers (every session with left_at NULL),
    // newest join first. Each row carries the player snapshot plus the game's slug
    // and display name for rendering "who's on which server right now".
    listOnline() {
      return stmts.listOnline.all();
    },
    // Newest-first join/leave feed across all hosted servers (the Events timeline).
    // Includes closed sessions (left_at set), unlike listOnline. `limit` is clamped
    // to 1..500 (default 100) to bound the read.
    recentSessions({ limit = 100 } = {}) {
      const lim = Math.min(500, Math.max(1, Number(limit) || 100));
      return stmts.recentSessions.all(lim);
    },
  };
}
