#!/usr/bin/env bash
# Nightly Gamertown backup -> Cloudflare R2: app DB (consistent .backup) + Factorio save.
#
# Version-controlled copy of the host runner. It is installed on the keeper at
#   /usr/local/bin/gt-backup.sh
# and fired nightly (04:00) by the systemd timer `gt-db-backup.timer`. rclone authenticates
# via the host's /root/.config/rclone/rclone.conf (the `r2` remote) — no keys live here.
# To deploy a change: copy this file to /usr/local/bin/gt-backup.sh on the keeper (chmod +x).
# Full backup map + restore steps → DISASTER_RECOVERY.md.
set -euo pipefail
TS=$(date -u +%Y%m%d_%H%M%S)
DB=/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite
TMP=$(mktemp); trap "rm -f $TMP" EXIT
sqlite3 "$DB" ".backup '$TMP'"
rclone copyto "$TMP" "r2:gamertown-backups/app/gamertown_${TS}.sqlite"
# keep the 7 newest DB snapshots
rclone lsf r2:gamertown-backups/app/ | grep "\.sqlite$" | sort | head -n -7 | while read f; do rclone deletefile "r2:gamertown-backups/app/$f" || true; done
# Factorio active save (small)
FS=/var/lib/docker/volumes/gamertown_factorio-data/_data/saves/_active.zip
[ -f "$FS" ] && rclone copyto "$FS" "r2:gamertown-backups/factorio/_active_${TS}.zip" && \
  rclone lsf r2:gamertown-backups/factorio/ | grep "^_active_" | sort | head -n -3 | while read f; do rclone deletefile "r2:gamertown-backups/factorio/$f" || true; done
echo "backed up app DB + factorio save (ts=$TS)"
