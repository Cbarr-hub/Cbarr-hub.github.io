import argon2 from 'argon2';

export const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const STARTING_DOLLARS = 5000;

export function isDuplicateUserError(err) {
  return String(err?.message ?? '').includes('UNIQUE');
}

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
