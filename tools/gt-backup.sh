#!/usr/bin/env bash
# Gamertown backup -> Cloudflare R2: app DB + Factorio save + Minecraft world.
#
# Version-controlled mirror of the host runner. Installed on the keeper at
#   /usr/local/bin/gt-backup.sh
# and fired weekly (Mon 04:00) by the systemd timer `gt-db-backup.timer` (units vendored
# in tools/systemd/). rclone authenticates via /root/.config/rclone/rclone.conf (`r2`) —
# no keys live here. To deploy a change: copy this file to /usr/local/bin/gt-backup.sh
# (chmod +x). Full backup map + restore steps -> docs/disaster-recovery.md.
#
# Usage:
#   gt-backup.sh                    # ALL three, default prefixes/retention (the weekly timer)
#   gt-backup.sh all                # same as no args
#   gt-backup.sh db        [--prefix P] [--keep N]   # default prefix=app       keep=7
#   gt-backup.sh factorio  [--prefix P] [--keep N]   # default prefix=factorio  keep=3
#   gt-backup.sh minecraft [--prefix P] [--keep N]   # default prefix=minecraft keep=3
#
# Env:
#   GT_STRICT=1   drop the `|| true` masking on the Minecraft flush, and VERIFY each
#                 uploaded object actually landed in R2 (used by `gt prod` pre-deploy).
#                 The weekly timer omits it so a transient RCON hiccup can't abort the job.
set -euo pipefail

TS=$(date -u +%Y%m%d_%H%M%S)
REMOTE=r2
BUCKET=gamertown-backups
STRICT="${GT_STRICT:-0}"

# Verify an object exists in R2 (best-effort unless STRICT, where a miss is fatal).
verify_landed() {   # $1=prefix $2=object-name
  [ "$STRICT" = "1" ] || return 0
  rclone lsf "${REMOTE}:${BUCKET}/$1/" | grep -qx "$2" || {
    echo "verify failed: $1/$2 is not in R2 after upload" >&2; return 1; }
}

prune() {   # $1=prefix $2=grep-pattern $3=keep-N
  rclone lsf "${REMOTE}:${BUCKET}/$1/" | grep "$2" | sort | head -n "-$3" \
    | while read -r f; do rclone deletefile "${REMOTE}:${BUCKET}/$1/$f" || true; done
}

# --- app DB (consistent .backup) ---
backup_db() {
  local prefix="${1:-app}" keep="${2:-7}"
  local db=/var/lib/docker/volumes/gamertown_gt-data/_data/gamertown.sqlite
  local tmp obj; tmp="$(mktemp)"; obj="gamertown_${TS}.sqlite"
  sqlite3 "$db" ".backup '$tmp'"
  rclone copyto "$tmp" "${REMOTE}:${BUCKET}/${prefix}/${obj}"
  rm -f "$tmp"
  verify_landed "$prefix" "$obj"
  prune "$prefix" "\.sqlite$" "$keep"
}

# --- Factorio active save (small) ---
backup_factorio() {
  local prefix="${1:-factorio}" keep="${2:-3}"
  local fs=/var/lib/docker/volumes/gamertown_factorio-data/_data/saves/_active.zip
  [ -f "$fs" ] || { echo "factorio: no _active.zip — skipping" >&2; return 0; }
  local obj="_active_${TS}.zip"
  rclone copyto "$fs" "${REMOTE}:${BUCKET}/${prefix}/${obj}"
  verify_landed "$prefix" "$obj"
  prune "$prefix" "^_active_" "$keep"
}

# --- Minecraft world (~8G raw / ~5G gz). Flush + pause saves via the container's
#     rcon-cli so the on-disk world is consistent during the tar. save-on is re-enabled
#     UNCONDITIONALLY before returning — we capture the failure in $rc rather than letting
#     `set -e` abort with saving still off (a RETURN trap is NOT run on a set -e abort, so
#     it can't be the safety net). The world dir is the level-name; object is
#     "<level>_<ts>.tar.gz". ---
backup_minecraft() {
  local prefix="${1:-minecraft}" keep="${2:-3}" rc=0
  local mcv=/var/lib/docker/volumes/gamertown_mc-data/_data level obj
  level="$(grep -E "^level-name=" "$mcv/server.properties" 2>/dev/null | cut -d= -f2 | tr -d "\r" || true)"
  [ -n "${level:-}" ] && [ -d "$mcv/$level" ] || { echo "minecraft: no world (level='${level:-}') — skipping" >&2; return 0; }
  obj="${level}_${TS}.tar.gz"
  # Pause saves. Under STRICT a flush failure is real (propagated via $rc); otherwise masked.
  if [ "$STRICT" = "1" ]; then
    { docker exec minecraft rcon-cli save-off >/dev/null && docker exec minecraft rcon-cli save-all flush >/dev/null; } || rc=$?
  else
    docker exec minecraft rcon-cli save-off >/dev/null 2>&1 || true
    docker exec minecraft rcon-cli save-all flush >/dev/null 2>&1 || true
  fi
  # Snapshot only if pausing succeeded. `|| rc=$?` keeps set -e from aborting here so the
  # save-on below ALWAYS runs (pipefail makes $rc reflect a failing tar OR rclone).
  if [ "$rc" -eq 0 ]; then
    sync
    tar -czf - -C "$mcv" "$level" | rclone rcat "${REMOTE}:${BUCKET}/${prefix}/${obj}" || rc=$?
  fi
  docker exec minecraft rcon-cli save-on >/dev/null 2>&1 || true   # ALWAYS re-enable saving
  [ "$rc" -eq 0 ] || return "$rc"                                  # failed: skip verify/prune, propagate
  verify_landed "$prefix" "$obj"
  prune "$prefix" "\.tar\.gz$" "$keep"
}

# Parse [--prefix P] [--keep N] after a target name; sets PREFIX/KEEP from the passed defaults.
parse_opts() {   # $1=default-prefix $2=default-keep, then the remaining CLI args
  PREFIX="$1"; KEEP="$2"; shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --prefix) PREFIX="$2"; shift 2 ;;
      --keep)   KEEP="$2";   shift 2 ;;
      *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
  done
}

case "${1:-}" in
  ""|all)
    # The weekly timer's path — IDENTICAL objects + prune as before the refactor.
    backup_db        app       7
    backup_factorio  factorio  3
    backup_minecraft minecraft 3
    echo "backed up app DB + factorio save + minecraft world (ts=$TS)"
    ;;
  db)        shift; parse_opts app       7 "$@"; backup_db        "$PREFIX" "$KEEP"; echo "backed up app DB -> $PREFIX (ts=$TS)" ;;
  factorio)  shift; parse_opts factorio  3 "$@"; backup_factorio  "$PREFIX" "$KEEP"; echo "backed up factorio save -> $PREFIX (ts=$TS)" ;;
  minecraft) shift; parse_opts minecraft 3 "$@"; backup_minecraft "$PREFIX" "$KEEP"; echo "backed up minecraft world -> $PREFIX (ts=$TS)" ;;
  *) echo "usage: gt-backup.sh [all|db|factorio|minecraft] [--prefix P] [--keep N]" >&2; exit 1 ;;
esac
