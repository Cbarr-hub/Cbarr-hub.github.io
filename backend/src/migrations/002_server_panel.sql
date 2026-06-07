-- Game-server control panel persistence: the per-server Steam Workshop map
-- catalog and the reusable raw-cfg library (both backed by store.js). Rows are
-- scoped by `server_id` (the registry id). Seeds CS's one previously-hardcoded
-- workshop map so the catalog starts non-empty. (`PRAGMA foreign_keys` is a no-op
-- inside the migration transaction; openDb() enables FK on the live connection.)
PRAGMA foreign_keys = ON;

-- Persisted Steam Workshop map catalog. CS is the only consumer today, but the
-- server_id column keeps it generic so other games could persist maps later.
CREATE TABLE server_workshop_maps (
  server_id   TEXT    NOT NULL,
  workshop_id TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (server_id, workshop_id)
);

-- Reusable game-state config snippets (e.g. bunnyhop). `body` is the raw cfg
-- text the connector materializes + execs in-guest. Unique name per server.
CREATE TABLE server_configs (
  id         INTEGER PRIMARY KEY,
  server_id  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (server_id, name)
);

-- Seed the previously hardcoded WORKSHOP_MAPS entry so the catalog starts where
-- connectors/counterstrike.js left off (Assembly).
INSERT INTO server_workshop_maps (server_id, workshop_id, name)
VALUES ('counterstrike', '3071005299', 'Assembly');
