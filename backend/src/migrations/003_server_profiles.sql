PRAGMA foreign_keys = ON;

-- Named startup-config "profiles": the full, structured set of settings a server
-- boots as (map + rotation, gameplay, etc.). `settings` is a JSON doc whose shape
-- is game-specific — each connector's profileSchema() declares the fields and the
-- panel renders them. Scoped per server_id; profiles never cross games.
CREATE TABLE server_profiles (
  id         INTEGER PRIMARY KEY,
  server_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  settings   TEXT    NOT NULL DEFAULT '{}',   -- JSON
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (server_id, name)
);

-- Which profile each server currently boots as (its active startup config). One
-- row per server. The connector also mirrors this on-box (a gt_active_profile
-- var) for resilience, but this table is the authoritative pointer the app reads.
CREATE TABLE server_active_profile (
  server_id  TEXT    PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES server_profiles(id) ON DELETE CASCADE
);
