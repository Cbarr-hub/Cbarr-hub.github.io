// One-shot seed: inserts the original Gamertown roster (all admin) and the
// canonical party-games list. Safe to re-run — idempotent by name so existing
// rows are preserved. Passwords are hashed with argon2id.
//
// Party games are seeded WITHOUT explicit ids (auto-assigned): the `games` table is
// now shared with the hosted game *servers* (hosted=1, auto-inserted on app boot —
// see store.seedHostedGames), so hardcoded ids 1..N would collide with the server
// rows on a fresh DB and silently drop party games. Keying by name (hosted=0)
// avoids that coupling entirely.

import { loadEnv } from './env.js';
import { openDb, runMigrations } from './db.js';
import { createUser } from './users.js';

const SEED_USERS = [
  { username: 'Wiley',   displayName: 'Wiley',   password: 'tree', isAdmin: true },
  { username: 'Miles',   displayName: 'Miles',   password: 'tree', isAdmin: true },
  { username: 'Jack',    displayName: 'Jack',    password: 'tree', isAdmin: true },
  { username: 'Gabe',    displayName: 'Gabe',    password: 'tree', isAdmin: true },
  { username: 'Austin',  displayName: 'Austin',  password: 'tree', isAdmin: true },
  { username: 'Connor',  displayName: 'Connor',  password: 'tree', isAdmin: true },
  { username: 'Patrick', displayName: 'Patrick', password: 'tree', isAdmin: true },
];

const SEED_GAMES = [
  { name: 'Lethal Company',              minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { name: 'Lockdown Protocol',           minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { name: 'RV There Yet',                minplayers: 3, maxplayers: 4, time_minutes: 90 },
  { name: 'Goofy Gorillas',              minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { name: 'Super Battle Golf',           minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { name: 'CSGO',                        minplayers: 2, maxplayers: 5, time_minutes: 60 },
  { name: 'Buckshot Roulette',           minplayers: 4, maxplayers: 4, time_minutes: 60 },
  { name: 'Peak',                        minplayers: 3, maxplayers: 6, time_minutes: 90 },
  { name: 'Gamble with your friends',    minplayers: 3, maxplayers: 8, time_minutes: 90 },
  { name: 'Rocket League',               minplayers: 2, maxplayers: 4, time_minutes: 30 },
  { name: 'Halo',                        minplayers: 2, maxplayers: 8, time_minutes: 90 },
  { name: 'Risk of Rain',                minplayers: 2, maxplayers: 4, time_minutes: 90 },
  { name: 'Just Another Night Shift',    minplayers: 4, maxplayers: 4, time_minutes: 60 },
  { name: 'League of Legends',           minplayers: 2, maxplayers: 5, time_minutes: 30 },
  { name: 'Age of Empires',              minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { name: 'Last Train Out of Wormtown',  minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { name: 'Oh Deer',                     minplayers: 4, maxplayers: 4, time_minutes: 60 },
];

const env = loadEnv();
const db = openDb(env.DB_PATH);
runMigrations(db);

const userExists = db.prepare('SELECT id FROM users WHERE username = ?');
// Idempotent by name, scoped to party games (hosted=0) — never touches the hosted
// server rows and never assumes a fixed id.
const insertGame = db.prepare(`
  INSERT INTO games (name, players, minplayers, maxplayers, time_minutes)
  SELECT ?, NULL, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM games WHERE name = ? AND hosted = 0)
`);

let usersCreated = 0;
for (const u of SEED_USERS) {
  if (userExists.get(u.username)) continue;
  await createUser(db, { ...u, minPasswordLength: 1 });
  usersCreated += 1;
}

let gamesCreated = 0;
for (const g of SEED_GAMES) {
  const r = insertGame.run(g.name, g.minplayers, g.maxplayers, g.time_minutes, g.name);
  if (r.changes > 0) gamesCreated += 1;
}

console.log(`Seed complete. Users created: ${usersCreated}/${SEED_USERS.length}. Games created: ${gamesCreated}/${SEED_GAMES.length}.`);
db.close();
