-- Playtime economy + presence support.
--
-- Adds (1) a generic key/value app-settings store (first use: the playtime
-- earning rate + per-session cap), (2) a mapping from a tracked game identity
-- (players.id) to a site account (users.id) so playtime can pay a real balance,
-- and (3) a `credited_at` marker on server_sessions so the app-side reconciler
-- credits each closed session exactly once.
--
-- (No `PRAGMA foreign_keys` here — migrations run inside a transaction where that
-- pragma is a no-op; openDb() enables FK enforcement on the live connection.)

-- Generic admin-editable settings. Values are stored as TEXT and parsed by the
-- reader (numbers via Number()), so this table can hold future config too.
CREATE TABLE app_settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Link a game identity to a site account. One identity pays at most one account
-- (player_id PK); an account may own several identities (Steam + Minecraft + …).
-- Only linked identities accrue playtime earnings. ON DELETE CASCADE so removing
-- a user or player tidies the link.
CREATE TABLE player_accounts (
  player_id  INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL    REFERENCES users(id)   ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_player_accounts_user ON player_accounts (user_id);

-- When set, this session has already been paid out (or settled at link time for
-- sessions that predate the account link). NULL = not yet credited. The host
-- collector never sets this — it's owned by the app's reconciler.
ALTER TABLE server_sessions ADD COLUMN credited_at INTEGER;

-- Drives the reconciler's "what still needs paying" scan.
CREATE INDEX idx_sessions_uncredited
  ON server_sessions (player_id)
  WHERE left_at IS NOT NULL AND credited_at IS NULL;

-- Defaults so the admin panel shows sane starting values (editable in the UI).
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('playtime_dollars_per_hour',    '100'),
  ('playtime_max_session_minutes', '600');
