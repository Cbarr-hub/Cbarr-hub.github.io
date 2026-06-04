#!/usr/bin/env bash
# Consistent online snapshot of the app SQLite DB (users, sessions, server
# Profiles) → R2, via the same rclone remote as worlds + secrets. The DB lives in
# the gt-data named volume; the slim app image has no sqlite3, so we take the
# snapshot from a throwaway sqlite container mounted on that volume. Schedule with
# a systemd timer (e.g. nightly) or alongside the world-backup job.
#
# Config (env): GT_DATA_VOLUME (run `docker volume ls` to find it — it's
# "<project>_gt-data"), GT_DB_PATH (path inside the volume), GT_RCLONE_REMOTE,
# GT_R2_BUCKET, GT_SQLITE_IMAGE.
set -euo pipefail

VOLUME="${GT_DATA_VOLUME:-gamertown_gt-data}"
DB_PATH="${GT_DB_PATH:-/data/gamertown.sqlite}"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
SQLITE_IMAGE="${GT_SQLITE_IMAGE:-keinos/sqlite3:latest}"

command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

ts="$(date -u +%Y%m%d_%H%M%S)"
DEST="${REMOTE}:${BUCKET}/app/gamertown_${ts}.sqlite"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# `.backup` is a safe hot copy even while the app is writing (WAL-aware).
docker run --rm -v "${VOLUME}:/data" -v "${tmp}:/out" "$SQLITE_IMAGE" \
  sqlite3 "$DB_PATH" ".backup '/out/gt.sqlite'"

rclone copyto "${tmp}/gt.sqlite" "$DEST"
echo "backed up DB → $DEST"
