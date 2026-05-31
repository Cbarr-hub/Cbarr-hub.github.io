import argon2 from 'argon2';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';

import { loadEnv } from './env.js';
import { openDb, runMigrations } from './db.js';

const env = loadEnv();
const db = openDb(env.DB_PATH);
runMigrations(db);

const cmd = process.argv[2];

async function promptHidden(question) {
  let muted = false;
  const mutedStdout = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output: mutedStdout, terminal: true });
  const promise = rl.question(question);
  muted = true;
  const answer = await promise;
  rl.close();
  stdout.write('\n');
  return answer;
}

async function prompt(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function createUser({ admin }) {
  const username = (await prompt('Username: ')).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) {
    console.error('Invalid username. Allowed: letters, digits, _ . - (max 64).');
    process.exit(1);
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.error('Username already exists.');
    process.exit(1);
  }

  const displayName = (await prompt('Display name: ')).trim();
  if (!displayName) {
    console.error('Display name is required.');
    process.exit(1);
  }

  const password = await promptHidden('Password (min 12 chars): ');
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  const confirm = await promptHidden('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  const id = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
    ).run(username, displayName, hash, admin ? 1 : 0);
    db.prepare('INSERT INTO balances (user_id, dollars) VALUES (?, 5000)').run(r.lastInsertRowid);
    return r.lastInsertRowid;
  })();

  console.log(`Created ${admin ? 'admin' : 'user'} "${username}" (id=${id}).`);
}

async function listUsers() {
  const rows = db.prepare(`
    SELECT id, username, display_name, is_admin, datetime(created_at, 'unixepoch') AS created
    FROM users ORDER BY created_at DESC
  `).all();
  if (rows.length === 0) {
    console.log('(no users)');
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}\t${r.username}\t${r.display_name}\t${r.is_admin ? 'admin' : 'user'}\t${r.created}`);
  }
}

async function deleteUser() {
  const username = (await prompt('Username to delete: ')).trim();
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
  console.log(result.changes ? `Deleted ${username}.` : `No user named ${username}.`);
}

try {
  switch (cmd) {
    case 'create-user':  await createUser({ admin: false }); break;
    case 'create-admin': await createUser({ admin: true }); break;
    case 'list-users':   await listUsers(); break;
    case 'delete-user':  await deleteUser(); break;
    default:
      console.log('Usage: node src/cli.js <create-user | create-admin | list-users | delete-user>');
      process.exit(cmd ? 1 : 0);
  }
} finally {
  db.close();
}
