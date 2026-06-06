-- Narrow the games.slug uniqueness to the hosted servers only.
-- 005 created a GLOBAL unique index on games(slug); that over-constrains the
-- shared catalog — only the five game *servers* (hosted=1) carry a slug today,
-- but a party game (hosted=0) could legitimately want one later, and a global
-- unique index would force every party row's slug to stay distinct/NULL.
-- Make it PARTIAL so the constraint applies to hosted rows only.
-- (No `PRAGMA foreign_keys` here — migrations run inside a transaction where that
-- pragma is a no-op; openDb() enables FK enforcement on the live connection.)

-- Convention reminder for future `games` consumers:
--   hosted = 1 → a game *server* (slug set, e.g. 'counterstrike'); filter these
--                OUT of the party-games picker.
--   hosted = 0 → a party/gambling game (slug NULL today).
DROP INDEX IF EXISTS idx_games_slug;
CREATE UNIQUE INDEX idx_games_slug ON games(slug) WHERE hosted = 1;
