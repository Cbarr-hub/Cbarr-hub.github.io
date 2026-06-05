#!/usr/bin/env bash
# Weekly Gamertown backup -> Cloudflare R2: app DB + Factorio save + Minecraft world.
#
# Version-controlled copy of the host runner. It is installed on the keeper at
#   /usr/local/bin/gt-backup.sh
# and fired weekly (Mon 04:00) by the systemd timer `gt-db-backup.timer` (the unit files
# are vendored alongside this script in tools/systemd/). rclone authenticates via the host's
# /root/.config/rclone/rclone.conf (the `r2` remote) — no keys live here.
# To deploy a change: copy this file to /usr/local/bin/gt-backup.sh on the keeper (chmod +x).
# Full backup map + restore steps → docs/disaster-recovery.md.
set -euo pipefail
TS=$(date -u +%Y%m%d_%H%M%S)
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT

# --- app DB (consistent .backup), keep 7 ---
DB=/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite
sqlite3 "$DB" ".backup '$TMP'"
rclone copyto "$TMP" "r2:gamertown-backups/app/gamertown_${TS}.sqlite"
rclone lsf r2:gamertown-backups/app/ | grep "\.sqlite$" | sort | head -n -7 | while read f; do rclone deletefile "r2:gamertown-backups/app/$f" || true; done

# --- Factorio active save (small), keep 3 ---
FS=/var/lib/docker/volumes/gamertown_factorio-data/_data/saves/_active.zip
[ -f "$FS" ] && rclone copyto "$FS" "r2:gamertown-backups/factorio/_active_${TS}.zip" && \
  rclone lsf r2:gamertown-backups/factorio/ | grep "^_active_" | sort | head -n -3 | while read f; do rclone deletefile "r2:gamertown-backups/factorio/$f" || true; done

# --- Minecraft world (~8G raw / ~5G gz), keep 3. Flush + pause saves via the container's
#     rcon-cli so the on-disk world is consistent during the tar; the trap always re-enables
#     saving. The world dir is the level-name; the object is "<level>_<ts>.tar.gz". ---
MCV=/var/lib/docker/volumes/gamertown_mc-data/_data
LEVEL=$(grep -E "^level-name=" "$MCV/server.properties" 2>/dev/null | cut -d= -f2 | tr -d "\r" || true)
if [ -n "${LEVEL:-}" ] && [ -d "$MCV/$LEVEL" ]; then
  trap 'docker exec minecraft rcon-cli save-on >/dev/null 2>&1 || true; rm -f "$TMP"' EXIT
  docker exec minecraft rcon-cli save-off >/dev/null 2>&1 || true
  docker exec minecraft rcon-cli save-all flush >/dev/null 2>&1 || true
  sync
  tar -czf - -C "$MCV" "$LEVEL" | rclone rcat "r2:gamertown-backups/minecraft/${LEVEL}_${TS}.tar.gz"
  docker exec minecraft rcon-cli save-on >/dev/null 2>&1 || true
  rclone lsf r2:gamertown-backups/minecraft/ | grep "\.tar\.gz$" | sort | head -n -3 | while read f; do rclone deletefile "r2:gamertown-backups/minecraft/$f" || true; done
fi

echo "backed up app DB + factorio save + minecraft world (ts=$TS)"
