#!/usr/bin/env bash
# GMOD-family container entrypoint (runs as the linuxgsm user).
#
#   First boot:  install LinuxGSM gmodserver + GMOD + CS:S content into /data
#                (the volume), then seed gamemode/collection/default-map defaults.
#   Every boot:  re-apply secrets/identity from env (GSLT, rcon_password, port),
#                WITHOUT clobbering the panel-managed profile (cvars / mapcycle /
#                defaultmap live in the volume after first boot).
#   Then run the server in the FOREGROUND so the container lifecycle == the server
#   lifecycle (stop = container stop; "Apply = restart" remounts the Workshop
#   collection). SIGTERM → graceful LinuxGSM stop.
set -uo pipefail
cd /data

SF=/data/serverfiles
GARRYS="$SF/garrysmod"
GAME_CFG="$GARRYS/cfg/gmodserver.cfg"
INST_CFG=/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg
COMMON_CFG=/data/lgsm/config-lgsm/gmodserver/common.cfg
MOUNT_CFG="$GARRYS/cfg/mount.cfg"
CSS_DIR="$SF/css-content"
CONSOLE_LOG=/data/log/console/gmodserver-console.log

log() { echo "[entrypoint] $*"; }

# ── 1. First-boot install ─────────────────────────────────────────────────────
if [ ! -x /data/gmodserver ]; then
  log "installing LinuxGSM gmodserver…"
  curl -Lo /data/linuxgsm.sh https://linuxgsm.sh && chmod +x /data/linuxgsm.sh
  /data/linuxgsm.sh gmodserver
fi
if [ ! -f "$SF/srcds_run" ]; then
  log "auto-installing GMOD serverfiles (this is large; one-time)…"
  /data/gmodserver auto-install || log "auto-install returned non-zero (continuing)"
fi

# ── 2. CS:S content into a sibling dir, mounted via mount.cfg ──────────────────
# CS:S supplies textures for custom TTT maps; stock maps (gm_construct) don't need
# it. SKIP_CSS=1 skips the ~3GB pull (handy for a quick boot test).
if [ -n "${SKIP_CSS:-}" ]; then
  log "SKIP_CSS set — skipping CS:S content (custom-map textures may be missing)"
elif [ ! -d "$CSS_DIR/cstrike" ]; then
  log "downloading Counter-Strike: Source content (~3GB; one-time)…"
  # LinuxGSM installs steamcmd under the game user's home (~/.steam/steamcmd), NOT in
  # serverfiles — check that (and a couple of fallbacks) so CS:S actually downloads.
  STEAMCMD=""
  for c in "$SF/steamcmd/steamcmd.sh" "${HOME:-/data}/.steam/steamcmd/steamcmd.sh" \
           /data/.steam/steamcmd/steamcmd.sh "$(command -v steamcmd || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then STEAMCMD="$c"; break; fi
  done
  if [ -n "${STEAMCMD:-}" ] && [ -x "$STEAMCMD" ]; then
    log "using steamcmd at $STEAMCMD"
    "$STEAMCMD" +force_install_dir "$CSS_DIR" +login anonymous +app_update 232330 validate +quit \
      || log "CS:S download returned non-zero (maps may have missing textures)"
  else
    log "steamcmd not found; skipping CS:S (TTT maps may be missing textures)"
  fi
fi
if [ -d "$CSS_DIR/cstrike" ]; then
  mkdir -p "$(dirname "$MOUNT_CFG")"
  cat > "$MOUNT_CFG" <<EOF
"cfg"
{
	"cstrike"		"$CSS_DIR/cstrike"
}
EOF
fi

# ── 3. Seed identity/secrets from env ─────────────────────────────────────────
# shell-var style (LinuxGSM cfgs): key="value"
seedvar() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"; touch "$f"
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    sed -i "s#^${k}=.*#${k}=\"${v}\"#" "$f"
  else
    echo "${k}=\"${v}\"" >> "$f"
  fi
}
# Source cvar style (game cfg): key value
seedcvar() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"; touch "$f"
  if grep -q "^${k}[[:space:]]" "$f" 2>/dev/null; then
    sed -i "s#^${k}[[:space:]].*#${k} \"${v}\"#" "$f"
  else
    echo "${k} \"${v}\"" >> "$f"
  fi
}

# every boot — secrets + identity
[ -n "${GSLT:-}" ] && seedvar "$COMMON_CFG" gslt "$GSLT"
seedvar "$INST_CFG" port "${PORT:-27066}"
[ -n "${RCON_PASSWORD:-}" ] && seedcvar "$GAME_CFG" rcon_password "$RCON_PASSWORD"

# first boot only — defaults the panel profile may later override
if [ ! -f /data/.gt-seeded ]; then
  seedvar "$INST_CFG" gamemode "${GAMEMODE:-terrortown}"
  [ -n "${WORKSHOP_COLLECTION:-}" ] && seedvar "$INST_CFG" wscollectionid "$WORKSHOP_COLLECTION"
  [ -n "${DEFAULT_MAP:-}" ]         && seedvar "$INST_CFG" defaultmap "$DEFAULT_MAP"
  touch /data/.gt-seeded
fi

# ── 4. Foreground run (container == server) ───────────────────────────────────
shutdown() { log "SIGTERM → stopping gmodserver"; /data/gmodserver stop || true; exit 0; }
trap shutdown SIGTERM SIGINT

log "starting gmodserver"
/data/gmodserver start || log "start returned non-zero"
mkdir -p "$(dirname "$CONSOLE_LOG")"; touch "$CONSOLE_LOG"
# Keep the container alive + stream the server console; wait so the trap fires.
tail -n +1 -F "$CONSOLE_LOG" &
wait $!
