#!/usr/bin/env bash
# Encrypt the host's full secret set with age and push it to R2 (the same rclone
# remote as game-save backups). Runs ON DEMAND — after you edit secrets — never at
# app boot. The decryption key/passphrase is the one thing you keep in a personal
# password manager; it never lives on this host or in the repo.
#
# Bundles everything DR needs that exists ONLY on this host, into one tar:
#   - app/Caddy secrets env   /etc/gamertown/secrets.env   (SITE_ADDRESS, CADDY_TLS, RCON pw)
#   - Compose project env     /root/gamertown/.env         (GSLTs + game interpolation)
#   - TLS origin cert dir     /etc/gamertown/certs/        (gamertown.solutions.{pem,key})
# Missing sources are skipped with a warning (so it still works on a partial host).
#
# Config (env): GT_SECRETS_FILE, GT_PROJECT_ENV, GT_CERTS_DIR (set any to "" to skip),
#   GT_RCLONE_REMOTE, GT_R2_BUCKET, and EITHER GT_AGE_RECIPIENT (an age public key —
#   non-interactive) or none (age -p prompts for a passphrase, needs a real TTY).
set -euo pipefail

SECRETS_FILE="${GT_SECRETS_FILE:-/etc/gamertown/secrets.env}"
PROJECT_ENV="${GT_PROJECT_ENV:-/root/gamertown/.env}"
CERTS_DIR="${GT_CERTS_DIR:-/etc/gamertown/certs}"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
DEST="${REMOTE}:${BUCKET}/secrets/secrets.tar.age"

command -v age    >/dev/null || { echo "age not installed (apt install age)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

# Collect the sources that exist, as paths relative to / so a restore lands them back
# in place (tar -C / … then restore with tar -xzf -C /).
rels=()
for p in "$SECRETS_FILE" "$PROJECT_ENV" "$CERTS_DIR"; do
  [ -n "$p" ] || continue
  if [ -e "$p" ]; then rels+=("${p#/}"); else echo "warn: skipping missing $p" >&2; fi
done
[ "${#rels[@]}" -gt 0 ] || { echo "nothing to back up" >&2; exit 1; }

tmp_tar="$(mktemp)"; tmp_age="$(mktemp)"; trap 'rm -f "$tmp_tar" "$tmp_age"' EXIT
tar -czf "$tmp_tar" -C / "${rels[@]}"      # preserves modes (600 on the secrets/key)

if [ -n "${GT_AGE_RECIPIENT:-}" ]; then
  age -r "$GT_AGE_RECIPIENT" -o "$tmp_age" "$tmp_tar"
else
  echo "no GT_AGE_RECIPIENT set — using passphrase mode (age will prompt)…" >&2
  age -p -o "$tmp_age" "$tmp_tar"
fi

rclone copyto "$tmp_age" "$DEST"
echo "backed up ${#rels[@]} item(s) → $DEST"
printf '  - /%s\n' "${rels[@]}"
