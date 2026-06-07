import argon2 from 'argon2';

// Allowed username shape: 1–64 chars of letters, digits, and . _ - (no spaces).
// Usernames are stored UNIQUE COLLATE NOCASE, so they're effectively case-insensitive.
export const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// Every new account is seeded with this gambling balance (balances row).
export const STARTING_DOLLARS = 5000;

// True when a DB error is the UNIQUE-constraint violation from inserting a
// duplicate username — callers map this to a 409 / "already exists".
export function isDuplicateUserError(err) {
  return String(err?.message ?? '').includes('UNIQUE');
}

// Throw a VALIDATION_ERROR (Error with code:'VALIDATION_ERROR') if the input
// fails any rule:
//   - username must match USERNAME_RE
//   - displayName must be non-empty after trimming
//   - password must be at least `minPasswordLength` characters (default 12)
// Note: this checks the values as passed; createUser trims username/displayName
// first, so an all-whitespace displayName is caught even if a route schema's
// pre-trim minLength let it through.
export function assertValidUserInput({ username, displayName, password }, { minPasswordLength = 12 } = {}) {
  if (!USERNAME_RE.test(username)) {
    throw Object.assign(new Error('invalid username'), { code: 'VALIDATION_ERROR' });
  }
  if (!displayName?.trim()) {
    throw Object.assign(new Error('display name is required'), { code: 'VALIDATION_ERROR' });
  }
  if (password.length < minPasswordLength) {
    throw Object.assign(new Error(`password must be at least ${minPasswordLength} characters`), {
      code: 'VALIDATION_ERROR',
    });
  }
}

// Create a user + their starting balance atomically. Trims username/displayName,
// re-validates (see assertValidUserInput), argon2id-hashes the password, then
// inserts the users row and a STARTING_DOLLARS balances row in one transaction.
// Returns the new user id. Throws VALIDATION_ERROR on bad input, or a UNIQUE
// constraint error (see isDuplicateUserError) on a taken username.
export async function createUser(db, {
  username,
  displayName,
  password,
  isAdmin = false,
  minPasswordLength = 12,
}) {
  const user = {
    username: username.trim(),
    displayName: displayName.trim(),
    password,
    isAdmin: Boolean(isAdmin),
  };
  assertValidUserInput(user, { minPasswordLength });

  const hash = await argon2.hash(user.password, { type: argon2.argon2id });
  return db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)'
    ).run(user.username, user.displayName, hash, user.isAdmin ? 1 : 0);
    db.prepare('INSERT INTO balances (user_id, dollars) VALUES (?, ?)')
      .run(result.lastInsertRowid, STARTING_DOLLARS);
    return result.lastInsertRowid;
  })();
}
