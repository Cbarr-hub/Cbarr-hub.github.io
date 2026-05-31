// One-shot seed: inserts the original Gamertown roster (all admin) and the
// canonical games list. Safe to re-run — uses INSERT OR IGNORE so existing
// rows are preserved. Passwords are pre-hashed with argon2id.

import argon2 from 'argon2';

import { loadEnv } from './env.js';
import { openDb, runMigrations } from './db.js';

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
  { id: 1,  name: 'Lethal Company',              minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { id: 2,  name: 'Lockdown Protocol',           minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { id: 3,  name: 'RV There Yet',                minplayers: 3, maxplayers: 4, time_minutes: 90 },
  { id: 4,  name: 'Goofy Gorillas',              minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { id: 5,  name: 'Super Battle Golf',           minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { id: 6,  name: 'CSGO',                        minplayers: 2, maxplayers: 5, time_minutes: 60 },
  { id: 7,  name: 'Buckshot Roulette',           minplayers: 4, maxplayers: 4, time_minutes: 60 },
  { id: 8,  name: 'Peak',                        minplayers: 3, maxplayers: 6, time_minutes: 90 },
  { id: 9,  name: 'Gamble with your friends',    minplayers: 3, maxplayers: 8, time_minutes: 90 },
  { id: 10, name: 'Rocket League',               minplayers: 2, maxplayers: 4, time_minutes: 30 },
  { id: 11, name: 'Halo',                        minplayers: 2, maxplayers: 8, time_minutes: 90 },
  { id: 12, name: 'Risk of Rain',                minplayers: 2, maxplayers: 4, time_minutes: 90 },
  { id: 13, name: 'Just Another Night Shift',    minplayers: 4, maxplayers: 4, time_minutes: 60 },
  { id: 14, name: 'League of Legends',           minplayers: 2, maxplayers: 5, time_minutes: 30 },
  { id: 15, name: 'Age of Empires',              minplayers: 4, maxplayers: 8, time_minutes: 90 },
  { id: 16, name: 'Last Train Out of Wormtown',  minplayers: 5, maxplayers: 8, time_minutes: 90 },
  { id: 17, name: 'Oh Deer',                     minplayers: 4, maxplayers: 4, time_minutes: 60 },
];

const env = loadEnv();
const db = openDb(env.DB_PATH);
runMigrations(db);

const userExists = db.prepare('SELECT id FROM users WHERE username = ?');
const insertUser = db.prepare(
  'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
);
const insertBalance = db.prepare('INSERT INTO balances (user_id, dollars) VALUES (?, 5000)');
const insertGame = db.prepare(`
  INSERT OR IGNORE INTO games (id, name, players, minplayers, maxplayers, time_minutes)
  VALUES (?, ?, NULL, ?, ?, ?)
`);

let usersCreated = 0;
for (const u of SEED_USERS) {
  if (userExists.get(u.username)) continue;
  const hash = await argon2.hash(u.password, { type: argon2.argon2id });
  const tx = db.transaction(() => {
    const r = insertUser.run(u.username, u.displayName, hash, u.isAdmin ? 1 : 0);
    insertBalance.run(r.lastInsertRowid);
  });
  tx();
  usersCreated += 1;
}

let gamesCreated = 0;
for (const g of SEED_GAMES) {
  const r = insertGame.run(g.id, g.name, g.minplayers, g.maxplayers, g.time_minutes);
  if (r.changes > 0) gamesCreated += 1;
}

console.log(`Seed complete. Users created: ${usersCreated}/${SEED_USERS.length}. Games created: ${gamesCreated}/${SEED_GAMES.length}.`);
db.close();
