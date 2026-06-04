#!/usr/bin/env bash
# Pull the age-encrypted secret bundle from R2 and decrypt it (the counterpart to
# secrets-backup.sh). Needs the DR kit (kept in a personal password manager, NOT
# here): a read-only R2 token for rclone + the age key/passphrase.
#
# By default it extracts to a STAGING dir and lists what's inside — it does NOT
# touch live secrets/certs. Pass --in-place to restore to the real paths
# (/etc/gamertown/*, /root/gamertown/.env); STOP the stack first if the host is live.
#
# Config (env): GT_RCLONE_REMOTE, GT_R2_BUCKET, and optionally GT_AGE_IDENTITY (path
#   to an age identity file; otherwise age -d prompts for the passphrase — needs a TTY).
# Usage: tools/secrets-restore.sh [--in-place]
set -euo pipefail

REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
SRC="${REMOTE}:${BUCKET}/secrets/secrets.tar.age"
INPLACE=0; [ "${1:-}" = "--in-place" ] && INPLACE=1

command -v age    >/dev/null || { echo "age not installed (apt install age)" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

tmp_age="$(mktemp)"; tmp_tar="$(mktemp)"; trap 'rm -f "$tmp_age" "$tmp_tar"' EXIT
rclone copyto "$SRC" "$tmp_age"

umask 077
if [ -n "${GT_AGE_IDENTITY:-}" ]; then
  age -d -i "$GT_AGE_IDENTITY" -o "$tmp_tar" "$tmp_age"
else
  age -d -o "$tmp_tar" "$tmp_age"   # prompts for the passphrase
fi

if [ "$INPLACE" = 1 ]; then
  tar -xzf "$tmp_tar" -C /          # lands files back at their original absolute paths
  echo "restored secret bundle IN PLACE (/etc/gamertown/*, /root/gamertown/.env)"
  echo "→ review, then bring the stack up: docker compose … up -d"
else
  dest="$(mktemp -d /tmp/gt-secrets.XXXXXX)"
  tar -xzf "$tmp_tar" -C "$dest"
  echo "restored secret bundle → $dest (staging — copy into place, or re-run with --in-place)"
  find "$dest" -type f -printf '  %P\n'
fi
