#!/usr/bin/env bash
# Restore the app SQLite DB from an R2 snapshot into the gt-data volume. Pass a
# specific backup filename, or omit to take the newest. STOP the stack first
# (`docker compose down`) so the app isn't mid-write, then run this, then `up`.
#
# Config (env): GT_DATA_VOLUME, GT_DB_PATH, GT_RCLONE_REMOTE, GT_R2_BUCKET.
# Usage: tools/db-restore.sh [gamertown_YYYYMMDD_HHMMSS.sqlite]
set -euo pipefail

VOLUME="${GT_DATA_VOLUME:-gamertown_gt-data}"
DB_PATH="${GT_DB_PATH:-/data/gamertown.sqlite}"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
NAME="${1:-}"

command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

if [ -z "$NAME" ]; then
  NAME="$(rclone lsf "${REMOTE}:${BUCKET}/app/" | grep '\.sqlite$' | sort | tail -1)"
  [ -n "$NAME" ] || { echo "no DB backups found under ${REMOTE}:${BUCKET}/app/" >&2; exit 1; }
fi
SRC="${REMOTE}:${BUCKET}/app/${NAME}"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rclone copyto "$SRC" "${tmp}/gt.sqlite"

# Drop any stale WAL/SHM so the restored file is authoritative.
docker run --rm -v "${VOLUME}:/data" -v "${tmp}:/in:ro" alpine \
  sh -c "cp /in/gt.sqlite '${DB_PATH}' && rm -f '${DB_PATH}-wal' '${DB_PATH}-shm'"

echo "restored $SRC → ${VOLUME}:${DB_PATH}"
echo "now start the stack: docker compose up -d"
