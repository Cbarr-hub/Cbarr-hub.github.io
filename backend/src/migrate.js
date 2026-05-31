import { openDb, runMigrations } from './db.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const db = openDb(env.DB_PATH);
runMigrations(db);
console.log('Migrations applied.');
db.close();
