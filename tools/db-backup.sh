#!/usr/bin/env bash
# Consistent online snapshot of the app SQLite DB (users, sessions, server
# Profiles) → R2, via the same rclone remote as worlds + secrets. The DB lives in
# the gt-data named volume. Schedule with a systemd timer (e.g. nightly) or
# alongside the world-backup job.
#
# Snapshot strategy (in order of preference):
#   1. Host `sqlite3` if installed — fastest, no image pull, and the path proven
#      in production on the keeper. We resolve the volume's host mountpoint via
#      `docker volume inspect` and `.backup` the DB straight off disk.
#   2. Otherwise a throwaway sqlite container mounted on the volume — but run as
#      ROOT (`--user root`). The slim app image has no sqlite3, and keinos/sqlite3
#      defaults to a NON-root user that can neither read the app-owned DB in the
#      volume nor write the snapshot to the root-owned temp dir (the original
#      "cannot open /out/gt.sqlite" failure). Root fixes both.
#
# Config (env): GT_DATA_VOLUME (run `docker volume ls` to find it — it's
# "<project>_gt-data"), GT_DB_PATH (the DB path inside the /data mount — same knob
# as db-restore.sh), GT_RCLONE_REMOTE, GT_R2_BUCKET, GT_SQLITE_IMAGE, GT_KEEP (how
# many snapshots to retain in R2; 0 = keep all).
set -euo pipefail

VOLUME="${GT_DATA_VOLUME:-gamertown_gt-data}"
DB_PATH="${GT_DB_PATH:-/data/gamertown.sqlite}"   # path inside the /data volume mount
DB_REL="${DB_PATH#/data/}"                         # …relative to the volume root, for host sqlite3
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"
SQLITE_IMAGE="${GT_SQLITE_IMAGE:-keinos/sqlite3:latest}"
KEEP="${GT_KEEP:-7}"

command -v rclone >/dev/null || { echo "rclone not installed" >&2; exit 1; }

ts="$(date -u +%Y%m%d_%H%M%S)"
DEST="${REMOTE}:${BUCKET}/app/gamertown_${ts}.sqlite"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# `.backup` is a safe hot copy even while the app is writing (WAL-aware).
if command -v sqlite3 >/dev/null; then
  mount="$(docker volume inspect -f '{{.Mountpoint}}' "$VOLUME")"
  sqlite3 "${mount}/${DB_REL}" ".backup '${tmp}/gt.sqlite'"
else
  docker run --rm --user root \
    -v "${VOLUME}:/data" -v "${tmp}:/out" "$SQLITE_IMAGE" \
    sqlite3 "$DB_PATH" ".backup '/out/gt.sqlite'"
fi

rclone copyto "${tmp}/gt.sqlite" "$DEST"
echo "backed up DB → $DEST"

# Prune: keep only the newest $KEEP snapshots (ordered by the timestamp in the
# name, which sorts lexically). Mirrors the world-backup auto-prune.
if [ "$KEEP" -gt 0 ]; then
  mapfile -t old < <(rclone lsf "${REMOTE}:${BUCKET}/app/" --include 'gamertown_*.sqlite' \
    | sort -r | tail -n +"$((KEEP + 1))")
  for f in "${old[@]}"; do
    rclone deletefile "${REMOTE}:${BUCKET}/app/${f}" && echo "pruned old snapshot → ${f}"
  done
fi
