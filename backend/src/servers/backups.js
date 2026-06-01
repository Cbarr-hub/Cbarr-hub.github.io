// Shared rclone → Cloudflare R2 backup helpers.
//
// Backups are point-in-time archives pushed off the game VM to an R2 bucket, so
// they survive a VM/disk loss (distinct from "Save As", which makes a *loadable*
// save on the VM itself). rclone runs INSIDE each game VM (invoked via the guest
// agent); archive bytes stream VM↔R2 over pipes, never through the agent stdout.
//
// SECURITY: the app never holds R2 credentials. rclone reads them from its own
// on-VM config (/home/miles/.config/rclone/rclone.conf) — same posture as RCON
// passwords. Object keys are built only from the fixed bucket/prefix/ext and a
// strictly-validated name, so the shell strings carry no metacharacters.

const REMOTE = 'r2';
const BUCKET = 'gamertown-backups';

// A backup "name" = the object filename minus its extension.
export const NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function badSetting(msg) {
  const e = new Error(msg);
  e.code = 'BAD_SETTING';
  return e;
}

export function notFound(msg) {
  const e = new Error(msg);
  e.code = 'NOT_FOUND';
  return e;
}

export function r2Dir(prefix) { return `${REMOTE}:${BUCKET}/${prefix}/`; }
export function r2Path(prefix, name, ext) { return `${REMOTE}:${BUCKET}/${prefix}/${name}${ext}`; }

// UTC YYYYMMDD_HHMMSS — generated in Node to avoid guest-timezone surprises.
export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

// Sanitize a derived base name (active save / world) down to the allowed charset.
export function safeBase(raw, fallback) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(raw || '') ? raw : fallback;
}

// True when rclone is installed and an `r2:` remote is configured on the VM.
export async function rcloneReady(conn, asUser) {
  try {
    const res = await conn.runShell(
      'command -v rclone >/dev/null 2>&1 && rclone listremotes',
      { asUser, timeoutMs: 15_000 },
    );
    return res.exitCode === 0 && /^r2:/m.test(res.stdout || '');
  } catch {
    return false;
  }
}

// { available, backups: [{ name, label, size, createdAt }], reason? }
export async function listBackups(conn, { asUser, prefix, ext }) {
  if (!(await rcloneReady(conn, asUser))) {
    return { available: false, backups: [], reason: 'rclone/R2 not configured on this VM' };
  }
  const res = await conn.runShell(`rclone lsjson "${r2Dir(prefix)}"`, { asUser, timeoutMs: 30_000 });
  // A missing prefix (no backups yet) makes rclone exit non-zero — treat as empty.
  if (res.exitCode !== 0) return { available: true, backups: [] };

  let entries = [];
  try { entries = JSON.parse(res.stdout || '[]'); } catch { entries = []; }

  const backups = entries
    .filter((e) => !e.IsDir && typeof e.Name === 'string' && e.Name.endsWith(ext))
    .map((e) => {
      const name = e.Name.slice(0, -ext.length);
      return { name, label: name, size: e.Size ?? null, createdAt: e.ModTime ?? null };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return { available: true, backups };
}

export async function objectExists(conn, { asUser, prefix, name, ext }) {
  const res = await conn.runShell(`rclone lsf "${r2Path(prefix, name, ext)}"`, { asUser, timeoutMs: 20_000 });
  return res.exitCode === 0 && (res.stdout || '').trim().length > 0;
}

// Shared upload of an existing single file (Factorio's .zip case).
export async function uploadFile(conn, { asUser, source, prefix, name, ext }) {
  const res = await conn.runShell(`rclone copyto "${source}" "${r2Path(prefix, name, ext)}"`, {
    asUser, timeoutMs: 300_000,
  });
  if (res.exitCode !== 0) throw badSetting(`backup upload failed: ${res.stderr || res.stdout}`);
  return { ok: true, action: 'backup', name };
}

export async function deleteBackup(conn, { asUser, prefix, name, ext }) {
  if (!NAME_RE.test(name)) throw badSetting('invalid backup name');
  if (!(await rcloneReady(conn, asUser))) throw badSetting('rclone/R2 not configured on this VM');
  if (!(await objectExists(conn, { asUser, prefix, name, ext }))) throw notFound('backup not found');

  const res = await conn.runShell(`rclone deletefile "${r2Path(prefix, name, ext)}"`, { asUser, timeoutMs: 30_000 });
  if (res.exitCode !== 0) throw badSetting(`delete failed: ${res.stderr || res.stdout}`);
  return { ok: true, action: 'delete', name };
}
