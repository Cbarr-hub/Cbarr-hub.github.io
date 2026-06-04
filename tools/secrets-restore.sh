#!/usr/bin/env bash
# Pull the age-encrypted secrets blob from R2 and decrypt it back to the host
# secrets file. Used when rebuilding a host. Needs the DR kit (kept in a personal
# password manager, NOT here): a read-only R2 token for rclone + the age
# key/passphrase to decrypt.
#
# Config (env): GT_SECRETS_FILE, GT_RCLONE_REMOTE, GT_R2_BUCKET, and optionally
#   GT_AGE_IDENTITY (path to an age identity file; otherwise age -d prompts).
set -euo pipefail

SECRETS_FILE="${GT_SECRETS_FILE:-/etc/gamertown/secrets.env}"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
SRC="${REMOTE}:${BUCKET}/secrets/secrets.env.age"

command -v age    >/dev/null || { echo "age not installed (apt install age)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
rclone copyto "$SRC" "$tmp"

umask 077
mkdir -p "$(dirname "$SECRETS_FILE")"
if [ -n "${GT_AGE_IDENTITY:-}" ]; then
  age -d -i "$GT_AGE_IDENTITY" -o "$SECRETS_FILE" "$tmp"
else
  age -d -o "$SECRETS_FILE" "$tmp"
fi
chmod 600 "$SECRETS_FILE"
echo "restored secrets → $SECRETS_FILE"
