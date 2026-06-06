-- Player-session tracking. A host-side collector (tools/gt-session-tracker.mjs)
-- records who joins/leaves each hosted game server; the app reads these for the
-- servers panel's standalone "Events" section. See docs/infrastructure.md.
-- (No `PRAGMA foreign_keys` here — migrations run inside a transaction where that
-- pragma is a no-op; openDb() enables FK enforcement on the live connection.)

-- Reuse the existing party-games `games` table as the single game catalog: a
-- `hosted` boolean separates the five game *servers* (hosted=1, seeded from the
-- registry on app boot) from the party/gambling games (hosted=0). `slug` is the
-- registry id (e.g. 'counterstrike'); `identity_kind` is the native id namespace.
ALTER TABLE games ADD COLUMN hosted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE games ADD COLUMN slug TEXT;
ALTER TABLE games ADD COLUMN identity_kind TEXT;
-- Unique slug for the hosted servers. SQLite treats NULLs as distinct, so the many
-- party-games rows (slug NULL) coexist; a plain (non-partial) index so it can serve
-- as the `ON CONFLICT(slug)` upsert target for seedHostedGames.
CREATE UNIQUE INDEX idx_games_slug ON games(slug);

-- Global player identity, one row per (identity_kind, uid) — a SteamID64 spans
-- GMOD/Prop Hunt/CS2, so this is the cross-game whitelist seed. Null-uid players
-- (CS2 redacts SteamIDs) get NO row here; the session still snapshots the name.
CREATE TABLE players (
  id            INTEGER PRIMARY KEY,
  identity_kind TEXT    NOT NULL,                -- 'steam' | 'minecraft' | 'factorio'
  uid           TEXT    NOT NULL,                -- SteamID64 / Mojang UUID / Factorio name
  name          TEXT    NOT NULL,                -- most-recent display name
  first_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (identity_kind, uid)
);

-- One row per visit. left_at IS NULL == still online. `source` records how the
-- row was produced: 'log' (Minecraft/Factorio log tail), 'rcon' (Source poll),
-- 'reconciled' (closed on collector/container restart, leave time unknowable).
CREATE TABLE server_sessions (
  id            INTEGER PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id),
  player_id     INTEGER REFERENCES players(id),  -- null when uid unknown (CS2)
  identity_kind TEXT    NOT NULL,
  uid           TEXT,                            -- snapshot; null for CS2-redacted
  name          TEXT    NOT NULL,                -- snapshot at join
  joined_at     INTEGER NOT NULL,
  left_at       INTEGER,                         -- null == still online
  source        TEXT    NOT NULL DEFAULT 'log'
);

CREATE INDEX idx_sessions_game_open ON server_sessions (game_id) WHERE left_at IS NULL;
CREATE INDEX idx_sessions_game_time ON server_sessions (game_id, joined_at DESC);
CREATE INDEX idx_sessions_player    ON server_sessions (player_id);
