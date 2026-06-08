#!/usr/bin/env bash
# Restore production backup snapshots into the local dev Docker volumes.
#
# Defaults to all restorable prod data: app DB, Factorio active save, and
# Minecraft world. Use target flags to restore only one part:
#   tools/dev-restore-data.sh
#   tools/dev-restore-data.sh --db
#   tools/dev-restore-data.sh --worlds --keep-bluemap
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CONF="$SCRIPT_DIR/gt-modes.conf"
REMOTE="${GT_RCLONE_REMOTE:-r2}"
BUCKET="${GT_R2_BUCKET:-gamertown-backups}"

TARGETS=()
DB_NAME=""
FACTORIO_NAME=""
MINECRAFT_NAME=""
KEEP_BLUEMAP=0

usage() {
  cat <<'EOF'
dev-restore-data.sh - restore prod backups into local dev volumes

Targets:
  --all         app DB + Factorio + Minecraft (default)
  --db          app SQLite DB only
  --factorio    Factorio saves/_active.zip only
  --minecraft   Minecraft world only
  --worlds      Factorio + Minecraft

Options:
  --db-name NAME
  --factorio-name NAME
  --minecraft-name NAME
  --keep-bluemap

Examples:
  tools/gt.sh seed-dev
  tools/gt.sh seed-dev --db
  tools/gt.sh seed-dev --worlds --keep-bluemap
EOF
}

conf_get() {
  [ -f "$CONF" ] || { echo "ERROR: missing $CONF" >&2; exit 1; }
  local k_esc line
  k_esc="${1//./\\.}"
  line="$(grep -E "^[[:space:]]*${k_esc}[[:space:]]*=" "$CONF" | head -1 || true)"
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf '%s' "$line"
}

add_target() {
  local t="$1" seen
  for seen in "${TARGETS[@]:-}"; do [ "$seen" = "$t" ] && return 0; done
  TARGETS+=("$t")
}

add_all() {
  add_target db
  add_target factorio
  add_target minecraft
}

add_worlds() {
  add_target factorio
  add_target minecraft
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) add_all; shift ;;
    --db) add_target db; shift ;;
    --factorio) add_target factorio; shift ;;
    --minecraft) add_target minecraft; shift ;;
    --worlds) add_worlds; shift ;;
    --db-name) DB_NAME="${2:-}"; [ -n "$DB_NAME" ] || { echo "missing --db-name value" >&2; exit 1; }; shift 2 ;;
    --factorio-name) FACTORIO_NAME="${2:-}"; [ -n "$FACTORIO_NAME" ] || { echo "missing --factorio-name value" >&2; exit 1; }; shift 2 ;;
    --minecraft-name) MINECRAFT_NAME="${2:-}"; [ -n "$MINECRAFT_NAME" ] || { echo "missing --minecraft-name value" >&2; exit 1; }; shift 2 ;;
    --keep-bluemap) KEEP_BLUEMAP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

[ "${#TARGETS[@]}" -gt 0 ] || add_all

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
command -v rclone >/dev/null || { echo "rclone not found; run tools/gt.sh dev --fresh first" >&2; exit 1; }

PROJECT="$(conf_get project.dev)"
[ -n "$PROJECT" ] || { echo "project.dev missing in $CONF" >&2; exit 1; }

GT_VOL="${PROJECT}_gt-data"
FACTORIO_VOL="${PROJECT}_factorio-data"
MC_VOL="${PROJECT}_mc-data"
BLUEMAP_DATA_VOL="${PROJECT}_bluemap-data"
BLUEMAP_WEB_VOL="${PROJECT}_bluemap-web"
mkdir -p "$REPO_ROOT/.secrets"
TEMP_ROOT="$(mktemp -d "$REPO_ROOT/.secrets/dev-seed.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

latest_r2() {
  local prefix="$1" pattern="$2" name
  name="$(rclone lsf "${REMOTE}:${BUCKET}/${prefix}/" | grep -E "$pattern" | sort | tail -1 || true)"
  [ -n "$name" ] || { echo "no matching backups under ${REMOTE}:${BUCKET}/${prefix}/" >&2; exit 1; }
  printf '%s' "$name"
}

assert_snapshot_name() {
  local kind="$1" name="$2"
  [ -n "$name" ] || { echo "[ERROR] $kind snapshot name resolved empty" >&2; exit 1; }
  case "$name" in -*) echo "[ERROR] invalid $kind snapshot name '$name'" >&2; exit 1 ;; esac
}

assert_downloaded_file() {
  local path="$1" label="$2"
  [ -s "$path" ] || { echo "[ERROR] $label download missing or empty: $path" >&2; exit 1; }
}

ensure_volume() {
  docker volume create "$1" >/dev/null
}

is_running() {
  docker ps -q -f "name=^$1$" | grep -q .
}

stop_if_running() {
  if is_running "$1"; then
    echo "[*] stopping $1"
    docker stop "$1" >/dev/null || { echo "[ERROR] failed to stop $1" >&2; return 2; }
    return 0
  fi
  return 1
}

start_if_was_running() {
  local name="$1" was="$2"
  if [ "$was" = "1" ]; then
    echo "[*] starting $name"
    docker start "$name" >/dev/null || echo "[WARN] failed to restart $name; start it manually when ready" >&2
  fi
}

restore_db() {
  ensure_volume "$GT_VOL"
  if [ -n "$DB_NAME" ]; then
    GT_DATA_VOLUME="$GT_VOL" "$SCRIPT_DIR/db-restore.sh" "$DB_NAME"
  else
    GT_DATA_VOLUME="$GT_VOL" "$SCRIPT_DIR/db-restore.sh"
  fi
}

restore_factorio() {
  ensure_volume "$FACTORIO_VOL"
  local name="${FACTORIO_NAME:-}"
  [ -n "$name" ] || name="$(latest_r2 factorio '^_active_.*\.zip$')"
  assert_snapshot_name "Factorio" "$name"
  echo "[*] Factorio snapshot: $name"
  local dir="$TEMP_ROOT/factorio"
  mkdir -p "$dir"
  rclone copyto "${REMOTE}:${BUCKET}/factorio/${name}" "$dir/_active.zip"
  assert_downloaded_file "$dir/_active.zip" "Factorio snapshot"
  cat > "$dir/restore-factorio.sh" <<'EOF'
set -eu
mkdir -p /factorio/saves
cp /work/_active.zip /factorio/saves/_active.zip
chmod 777 /factorio/saves
chmod 666 /factorio/saves/_active.zip
EOF

  local was=0
  if stop_if_running factorio; then
    was=1
  else
    local rc=$?
    [ "$rc" -eq 1 ] || exit "$rc"
  fi
  local code=0
  docker run --rm -v "${FACTORIO_VOL}:/factorio" -v "${dir}:/work:ro" alpine sh /work/restore-factorio.sh || code=$?
  start_if_was_running factorio "$was"
  [ "$code" -eq 0 ] || { echo "[ERROR] Factorio restore failed" >&2; exit "$code"; }
  echo "[OK] restored $name -> $FACTORIO_VOL:/factorio/saves/_active.zip"
}

restore_minecraft() {
  ensure_volume "$MC_VOL"
  local name="${MINECRAFT_NAME:-}"
  [ -n "$name" ] || name="$(latest_r2 minecraft '\.tar\.gz$')"
  assert_snapshot_name "Minecraft" "$name"
  echo "[*] Minecraft snapshot: $name"
  local dir="$TEMP_ROOT/minecraft"
  mkdir -p "$dir"
  rclone copyto "${REMOTE}:${BUCKET}/minecraft/${name}" "$dir/world.tar.gz"
  assert_downloaded_file "$dir/world.tar.gz" "Minecraft snapshot"
  cat > "$dir/restore-minecraft.sh" <<'EOF'
set -eu
top="$(tar -tzf /work/world.tar.gz | head -n 1 | cut -d/ -f1)"
case "$top" in
  ""|/*|.*|*../*) echo "unsafe top-level world dir: $top" >&2; exit 1 ;;
esac
rm -rf "/data/$top"
tar -xzf /work/world.tar.gz -C /data
chmod -R u+rwX,go+rX "/data/$top"
printf "%s" "$top" > /out/level.txt
EOF
  cat > "$dir/clear-bluemap.sh" <<'EOF'
set -eu
find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find /web -mindepth 1 -maxdepth 1 -exec rm -rf {} +
EOF

  local blue_was=0 mc_was=0 level=""
  if [ "$KEEP_BLUEMAP" != "1" ]; then
    ensure_volume "$BLUEMAP_DATA_VOL"
    ensure_volume "$BLUEMAP_WEB_VOL"
  fi
  if stop_if_running minecraft; then
    mc_was=1
  else
    local rc=$?
    [ "$rc" -eq 1 ] || exit "$rc"
  fi
  if stop_if_running bluemap; then
    blue_was=1
  else
    local rc=$?
    if [ "$rc" -ne 1 ]; then
      start_if_was_running minecraft "$mc_was"
      exit "$rc"
    fi
  fi
  local code=0
  docker run --rm -v "${MC_VOL}:/data" -v "${dir}:/work:ro" -v "${dir}:/out" alpine sh /work/restore-minecraft.sh || code=$?
  level="$(cat "$dir/level.txt" 2>/dev/null || true)"

  if [ "$code" -eq 0 ] && [ "$KEEP_BLUEMAP" != "1" ]; then
    echo "[*] clearing dev BlueMap render cache for restored Minecraft world"
    docker run --rm -v "${BLUEMAP_DATA_VOL}:/data" -v "${BLUEMAP_WEB_VOL}:/web" -v "${dir}:/work:ro" alpine sh /work/clear-bluemap.sh \
      || echo "[WARN] could not clear BlueMap cache; map may show stale dev tiles" >&2
  fi

  start_if_was_running minecraft "$mc_was"
  start_if_was_running bluemap "$blue_was"
  [ "$code" -eq 0 ] || { echo "[ERROR] Minecraft restore failed" >&2; exit "$code"; }
  echo "[OK] restored $name -> $MC_VOL:/data/$level"
  [ -n "$level" ] && echo "    Effective MC_LEVEL should be '$level' (check .env.local if Minecraft starts a new world)."
}

echo "[*] dev project: $PROJECT; targets: ${TARGETS[*]}"
for target in "${TARGETS[@]}"; do
  case "$target" in
    db) restore_db ;;
    factorio) restore_factorio ;;
    minecraft) restore_minecraft ;;
  esac
done

echo "[OK] dev seed complete"
