#!/usr/bin/env bash
# Encrypt the host secrets file with age and push it to R2 via the existing
# rclone remote (the same one used for game-save backups). Runs ON DEMAND — after
# you edit secrets — never at app boot. See secrets.env.example + the plan's DR
# section. The decryption key/passphrase is the one thing you keep in a personal
# password manager; it never lives on this host or in the repo.
#
# Config (env): GT_SECRETS_FILE, GT_RCLONE_REMOTE, GT_R2_BUCKET, and EITHER
#   GT_AGE_RECIPIENT (an age public key, non-interactive) or none (age -p prompts).
set -euo pipefail

SECRETS_FILE="${GT_SECRETS_FILE:-/etc/gamertown/secrets.env}"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
DEST="${REMOTE}:${BUCKET}/secrets/secrets.env.age"

[ -f "$SECRETS_FILE" ] || { echo "no secrets file at $SECRETS_FILE" >&2; exit 1; }
command -v age    >/dev/null || { echo "age not installed (apt install age)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
if [ -n "${GT_AGE_RECIPIENT:-}" ]; then
  age -r "$GT_AGE_RECIPIENT" -o "$tmp" "$SECRETS_FILE"
else
  echo "no GT_AGE_RECIPIENT set — using passphrase mode (age will prompt)…" >&2
  age -p -o "$tmp" "$SECRETS_FILE"
fi

rclone copyto "$tmp" "$DEST"
echo "backed up secrets → $DEST"
