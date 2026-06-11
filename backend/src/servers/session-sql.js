// Canonical player-session WRITE SQL (+ the shared open-session count) — the
// SINGLE SOURCE OF TRUTH for the session-tracking statements.
//
// Dependency-free on purpose: store.js prepares these strings over
// better-sqlite3 (the tested copy), and the host-side collector
// (tools/gt-session-tracker.mjs) renders the same statements through the
// sqlite3 CLI — it inlines quoted values where this module uses `?`
// placeholders. Change a statement here and the collector port must follow
// (and vice versa). Migrations 005/006 define the schema these write to.

// The five game servers live in the party-games `games` table tagged hosted=1.
// The conflict target MUST carry the partial-index predicate — migration 006's
// `idx_games_slug … WHERE hosted = 1` is a PARTIAL unique index, and SQLite
// requires the WHERE clause in the ON CONFLICT target to match it exactly.
export const upsertHostedGame =
  `INSERT INTO games (name, slug, identity_kind, hosted) VALUES (?, ?, ?, 1)
   ON CONFLICT(slug) WHERE hosted = 1
     DO UPDATE SET name = excluded.name, identity_kind = excluded.identity_kind`;

export const listHostedGames = 'SELECT id, slug FROM games WHERE hosted = 1';

// Global cross-game player roster (the whitelist seed): one row per
// (identity_kind, uid), name/last_seen refreshed on every join. RETURNING id
// is what links both new and rejoining players' sessions to the one row.
export const upsertPlayer =
  `INSERT INTO players (identity_kind, uid, name) VALUES (?, ?, ?)
   ON CONFLICT(identity_kind, uid)
     DO UPDATE SET name = excluded.name, last_seen = unixepoch()
   RETURNING id`;

export const openSession =
  `INSERT INTO server_sessions
     (game_id, player_id, identity_kind, uid, name, joined_at, source)
   VALUES (?, ?, ?, ?, ?, ?, ?)`;

export const closeSession =
  'UPDATE server_sessions SET left_at = ? WHERE id = ? AND left_at IS NULL';

// Close every still-open session at once (collector/container restart: the
// real leave time is unknowable, so stamp left_at and re-tag source —
// 'reconciled' — so the timeline shows the leave was inferred).
export const closeAllOpen =
  'UPDATE server_sessions SET left_at = ?, source = ? WHERE left_at IS NULL';

// Open-session count across all hosted servers — the players-online gate
// tools/gt-maintenance.mjs polls (BlueMap CPU cap + idle-only update checks).
export const onlineCount =
  `SELECT COUNT(*) AS n
     FROM server_sessions s JOIN games g ON g.id = s.game_id
    WHERE s.left_at IS NULL AND g.hosted = 1`;
