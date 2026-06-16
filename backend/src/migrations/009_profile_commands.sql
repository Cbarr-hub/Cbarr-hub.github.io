-- Startup commands on a profile.
--
-- A profile stores its boot config in `settings` (materialized onto
-- server.properties / cfg files). `commands` adds an optional ordered list of
-- raw RCON commands (JSON array of strings) that the panel REPLAYS after the
-- profile is applied and the server is back up — so a profile can pin
-- runtime-only state that the boot config can't hold (Source cvars that reset
-- every restart, gamerules, etc.). NULL = no startup commands (treated as []).
--
-- (No `PRAGMA foreign_keys` here — migrations run inside a transaction where that
-- pragma is a no-op; openDb() enables FK enforcement on the live connection.)

ALTER TABLE server_profiles ADD COLUMN commands TEXT;
