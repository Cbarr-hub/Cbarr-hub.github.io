import Database from 'better-sqlite3';

import { runMigrations } from '../src/db.js';

export function testDb({ foreignKeys = false } = {}) {
  const db = new Database(':memory:');
  if (foreignKeys) db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
