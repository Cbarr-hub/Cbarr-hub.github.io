-- Per-session earnings + a link-queue dismiss flag.
--
-- (1) credited_dollars: the dollars actually credited for a session, recorded by
--     the app reconciler at credit time (and 0 when a session is settled-without-
--     paying at link time). Lets the Economy view show ACTUAL credited earnings
--     per player. NULL = produced before this column existed, or not yet
--     processed; the earnings aggregate COALESCEs NULL → 0, so no backfill: the
--     per-player total starts from a clean baseline and grows as sessions credit.
--
-- (2) players.ignored: a tracked identity can be DISMISSED from the link to-do
--     list (the Activity "Link queue"). Dismiss is reversible and does NOT hide
--     the identity's sessions from Activity or Pulse stats — it only removes the
--     "needs linking" affordance.
--
-- (No `PRAGMA foreign_keys` here — migrations run inside a transaction where that
-- pragma is a no-op; openDb() enables FK enforcement on the live connection.)

ALTER TABLE server_sessions ADD COLUMN credited_dollars INTEGER;

ALTER TABLE players ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
