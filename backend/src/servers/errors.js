// Shared coded errors + name patterns for the game-server layer.
//
// Connectors throw plain Errors carrying a `.code` the route layer maps to an
// HTTP status (see routes/servers.js CODE_STATUS). These factories keep the
// codes + messages identical everywhere instead of each connector redefining
// its own `badSetting`/`notFound`.

/** Make an Error carrying a `.code` (the route layer maps code → HTTP status). */
export const codedError = (code, message) => Object.assign(new Error(message), { code });

/** 400 — invalid input / setting. */
export const badSetting = (msg) => codedError('BAD_SETTING', msg);

/** 404 — a named resource doesn't exist. Pass the full message (e.g. "profile not found"). */
export const notFound = (msg) => codedError('NOT_FOUND', msg);

/** 404 — this server doesn't offer a capability (maps, backups, profiles, …). */
export const notSupported = (what) => codedError('NOT_SUPPORTED', `this server has no ${what}`);

/** Map a SQLite UNIQUE violation to a friendly BAD_SETTING; otherwise pass the error through. */
export const duplicateError = (e, name, kind = 'item') =>
  /UNIQUE/.test(e?.message || '') ? badSetting(`a ${kind} named "${name}" already exists`) : e;

// Map name charsets, shared by the connectors' validators.
export const MAP_NAME_RE  = /^[a-z0-9_]{1,64}$/;       // Source/GMOD map names
export const SAFE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;   // save / world / config names
