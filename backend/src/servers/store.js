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
//   4. Player-session tracking — who joined/left each hosted server. The write
//      SQL is imported from ./session-sql.js (the single source of truth the
//      host collector tools/gt-session-tracker.mjs mirrors via the sqlite3 CLI;
//      migration 005/006).
//   5. Presence + cross-game activity — read-only roster/timeline views over the
//      session rows for the panel's "Events"/fleet badges.

import * as sessionSql from './session-sql.js';

export function createServerStore(db) {
  // The three per-server catalogs (maps / configs / profiles) share a
  // list/get/delete statement shape: rows scoped by server_id, listed by name
  // (case-insensitive), fetched + deleted by `key`. Projections stay explicit
  // per table; the write statements stay hand-written below.
  const crud = (table, key, listCols, getCols = listCols) => ({
    list: db.prepare(`SELECT ${listCols} FROM ${table} WHERE server_id = ? ORDER BY name COLLATE NOCASE`),
    get: db.prepare(`SELECT ${getCols} FROM ${table} WHERE server_id = ? AND ${key} = ?`),
    delete: db.prepare(`DELETE FROM ${table} WHERE server_id = ? AND ${key} = ?`),
  });
  const maps = crud('server_workshop_maps', 'workshop_id',
    'workshop_id AS workshopId, name, created_at, updated_at');
  const configs = crud('server_configs', 'id',
    'id, name, created_at, updated_at',
    'id, name, body, created_at, updated_at');
  const profiles = crud('server_profiles', 'id',
    'id, name, created_at, updated_at',
    'id, name, settings, created_at, updated_at');
  // The session-projection reads all surface the linked site account (if any) via
  // the same player_accounts→users hop. `kind` is INNER `JOIN` (linked-only) or
  // `LEFT JOIN` (include unlinked); ACCOUNT_COLS are the two columns it contributes.
  const accountJoin = (kind) => `
         ${kind} player_accounts pa ON pa.player_id = s.player_id
         ${kind} users u            ON u.id = pa.user_id`;
  const ACCOUNT_COLS = 'pa.user_id AS userId, u.display_name AS userName';

  // Pulse analytics: one session's billable seconds, clamped to ≥0 and capped at
  // 24h so a never-closed / 'reconciled' row can't dominate an aggregate (86400
  // mirrors the spirit of the economy's per-session cap). Static SQL text — safe
  // to interpolate (no user input). Open sessions count up to "now".
  const DUR = 'MAX(0, MIN(COALESCE(s.left_at, unixepoch()) - s.joined_at, 86400))';

  // The session-projection reads share one SELECT shape: server_sessions s
  // joined to games g + the account hop (`accounts` is the accountJoin kind),
  // optionally LEFT JOIN players p (the `ignored` flag), scoped by `where`.
  // `cols` keeps each read's documented projection (store.test.mjs pins the
  // column sets, so the shapes can't silently drift).
  const sessionSelect = ({ cols, accounts = 'LEFT JOIN', players = false, where, tail = '' }) => db.prepare(
    `SELECT ${cols},
            ${ACCOUNT_COLS}
       FROM server_sessions s JOIN games g ON g.id = s.game_id${accountJoin(accounts)}
       ${players ? 'LEFT JOIN players p ON p.id = s.player_id' : ''}
      WHERE ${where}
      ${tail}`,
  );
  // Timeline projection: includes closed sessions (left_at) and the additive
  // players-join `ignored` flag (no row filtering — dismissed identities still
  // appear; the panel just drops their link affordance).
  const RECENT_COLS = `s.id, s.player_id AS playerId, g.slug AS slug, g.name AS gameName, s.name, s.uid,
            s.identity_kind AS identityKind, s.joined_at, s.left_at, s.source,
            COALESCE(p.ignored, 0) AS ignored`;

  const stmts = {
    // ── workshop map catalog (list/get/delete via crud above) ──
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

    // ── config library (list/get/delete via crud above) ──
    insertConfig: db.prepare(
      `INSERT INTO server_configs (server_id, name, body) VALUES (?, ?, ?)`,
    ),

    // ── startup-config profiles (list/get/delete via crud above) ──
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

    // ── player-session tracking ──
    // The five game servers live in the party-games `games` table tagged
    // hosted=1; sessions FK to games(id). slug→id is cached below. The SQL
    // itself is the canonical copy in ./session-sql.js (shared with the host
    // collector) — prepare it, never inline a duplicate here.
    upsertHostedGame: db.prepare(sessionSql.upsertHostedGame),
    listHostedGames: db.prepare(sessionSql.listHostedGames),
    upsertPlayer: db.prepare(sessionSql.upsertPlayer),
    openSession: db.prepare(sessionSql.openSession),
    closeSession: db.prepare(sessionSql.closeSession),
    closeAllOpen: db.prepare(sessionSql.closeAllOpen),
    // ── presence + cross-game activity (sessionSelect above) ──
    // Who's online right now, across every hosted server (newest join first).
    listOnline: sessionSelect({
      cols: `s.id, g.slug AS slug, g.name AS gameName, s.player_id AS playerId,
            s.name, s.uid, s.identity_kind AS identityKind, s.joined_at, s.source`,
      where: 's.left_at IS NULL AND g.hosted = 1',
      tail: 'ORDER BY s.joined_at DESC',
    }),
    // Recent join/leave activity merged across all hosted servers (the
    // timeline): linked-only (INNER account join) vs everyone.
    recentSessionsLinked: sessionSelect({
      cols: RECENT_COLS, accounts: 'JOIN', players: true,
      where: 'g.hosted = 1', tail: 'ORDER BY s.joined_at DESC LIMIT ?',
    }),
    recentSessionsAll: sessionSelect({
      cols: RECENT_COLS, players: true,
      where: 'g.hosted = 1', tail: 'ORDER BY s.joined_at DESC LIMIT ?',
    }),
    openSessionById: sessionSelect({
      cols: `s.id, s.player_id AS playerId, s.name, s.uid,
            s.identity_kind AS identityKind, s.joined_at, s.source`,
      where: 'g.slug = ? AND g.hosted = 1 AND s.id = ? AND s.left_at IS NULL',
      tail: 'LIMIT 1',
    }),

    // ── pulse activity stats ──
    // Four read-only aggregates over the session rows for the "Pulse" view. All
    // scope to hosted games within a `since` window (?). Earnings/credits aren't
    // touched here — this is pure playtime shape.
    statsTotals: db.prepare(
      `SELECT COUNT(*) AS sessions,
              COUNT(DISTINCT s.player_id) AS players,
              COALESCE(SUM(${DUR}), 0) AS secs
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE g.hosted = 1 AND s.joined_at >= ?`,
    ),
    statsPerGame: db.prepare(
      `SELECT g.slug AS slug, g.name AS name,
              COUNT(*) AS sessions,
              COUNT(DISTINCT s.player_id) AS players,
              COALESCE(SUM(${DUR}), 0) AS secs
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE g.hosted = 1 AND s.joined_at >= ?
        GROUP BY g.id
        ORDER BY secs DESC`,
    ),
    statsTopPlayers: db.prepare(
      `SELECT s.player_id AS playerId, p.name AS name, ${ACCOUNT_COLS},
              COUNT(*) AS sessions,
              COUNT(DISTINCT s.game_id) AS games,
              COALESCE(SUM(${DUR}), 0) AS secs
         FROM server_sessions s
         JOIN games g ON g.id = s.game_id
         JOIN players p ON p.id = s.player_id${accountJoin('LEFT JOIN')}
        WHERE g.hosted = 1 AND s.joined_at >= ? AND s.player_id IS NOT NULL
        GROUP BY s.player_id
        ORDER BY secs DESC
        LIMIT 15`,
    ),
    // Heatmap = where/when sessions START, in the viewer's local time. The tz
    // offset is passed as a SQLite datetime modifier bound param ('±N minutes'),
    // applied to both strftime() calls — so bind order is (tzMod, tzMod, since).
    statsHeatmap: db.prepare(
      `SELECT CAST(strftime('%w', s.joined_at, 'unixepoch', ?) AS INTEGER) AS wd,
              CAST(strftime('%H', s.joined_at, 'unixepoch', ?) AS INTEGER) AS hr,
              COUNT(*) AS n
         FROM server_sessions s JOIN games g ON g.id = s.game_id
        WHERE g.hosted = 1 AND s.joined_at >= ?
        GROUP BY wd, hr`,
    ),
  };

  const parseSettings = (json) => { try { return JSON.parse(json); } catch { return {}; } };
  // Profile settings are a plain-object contract (see getProfile). Coerce anything
  // else (null/array/scalar) to {} on the way in so getProfile never yields a
  // non-object back to callers.
  const asSettings = (s) => (s && typeof s === 'object' && !Array.isArray(s) ? s : {});

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
      return maps.list.all(serverId);
    },
    getWorkshopMap(serverId, workshopId) {
      return maps.get.get(serverId, String(workshopId)) ?? null;
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
      return maps.delete.run(serverId, String(workshopId)).changes > 0;
    },

    // ── config library ───────────────────────────────────────────────────────
    listConfigs(serverId) {
      return configs.list.all(serverId);
    },
    getConfig(serverId, id) {
      return configs.get.get(serverId, id) ?? null;
    },
    createConfig(serverId, { name, body = '' }) {
      const { lastInsertRowid } = stmts.insertConfig.run(serverId, name, body);
      return this.getConfig(serverId, lastInsertRowid);
    },
    deleteConfig(serverId, id) {
      return configs.delete.run(serverId, id).changes > 0;
    },

    // ── startup-config profiles ──────────────────────────────────────────────
    // `settings` is stored as a JSON string and (de)serialized here so callers
    // only ever see/pass plain objects. listProfiles omits the body for cheap
    // catalogs; getProfile returns the parsed settings.
    listProfiles(serverId) {
      return profiles.list.all(serverId);
    },
    getProfile(serverId, id) {
      const row = profiles.get.get(serverId, id);
      if (!row) return null;
      return { ...row, settings: parseSettings(row.settings) };
    },
    countProfiles(serverId) {
      return stmts.countProfiles.get(serverId).n;
    },
    createProfile(serverId, { name, settings = {} }) {
      const { lastInsertRowid } = stmts.insertProfile.run(serverId, name, JSON.stringify(asSettings(settings)));
      return this.getProfile(serverId, lastInsertRowid);
    },
    // Partial update: only provided fields change. Returns the updated row or null.
    updateProfile(serverId, id, { name, settings } = {}) {
      const existing = this.getProfile(serverId, id);
      if (!existing) return null;
      const nextName = name ?? existing.name;
      // existing.settings is already a parsed object; only sanitize a fresh value.
      const nextSettings = settings === undefined ? existing.settings : asSettings(settings);
      stmts.updateProfile.run(nextName, JSON.stringify(nextSettings), serverId, id);
      return this.getProfile(serverId, id);
    },
    // Delete a profile and clear the active pointer if it referenced it (explicit
    // clear so it's correct even when SQLite FK cascade isn't enforced).
    deleteProfile(serverId, id) {
      const tx = db.transaction(() => {
        stmts.clearActiveForProfile.run(serverId, id);
        return profiles.delete.run(serverId, id).changes;
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
    // ── presence + cross-game activity ───────────────────────────────────────
    // Read-only aggregate views over server_sessions for the panel.
    // The live roster across all hosted servers (every session with left_at NULL),
    // newest join first. Each row carries the player snapshot plus the game's slug
    // and display name for rendering "who's on which server right now".
    listOnline() {
      return stmts.listOnline.all();
    },
    // Newest-first join/leave feed across all hosted servers (the Events timeline).
    // Includes closed sessions (left_at set), unlike listOnline. `limit` is clamped
    // to 1..500 (default 100) to bound the read.
    recentSessions({ limit = 100, includeUnlinked = false } = {}) {
      const lim = Math.min(500, Math.max(1, Number(limit) || 100));
      return (includeUnlinked ? stmts.recentSessionsAll : stmts.recentSessionsLinked).all(lim);
    },
    // Raw Pulse aggregates over sessions since `since` (unix seconds), bucketed in
    // the viewer's local time via `tzMod` (a SQLite '±N minutes' modifier). Returns
    // raw rows; service.js shapes secs→hours and computes the busiest cell.
    sessionStats({ since = 0, tzMod = '0 minutes' } = {}) {
      return {
        totals: stmts.statsTotals.get(since),
        perGame: stmts.statsPerGame.all(since),
        topPlayers: stmts.statsTopPlayers.all(since),
        heatmap: stmts.statsHeatmap.all(tzMod, tzMod, since),
      };
    },
    openSessionById(slug, sessionId) {
      return stmts.openSessionById.get(slug, Number(sessionId)) ?? null;
    },
  };
}
