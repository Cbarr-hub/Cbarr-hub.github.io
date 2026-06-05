#!/usr/bin/env bash
# Gamertown dev stack wrapper.
#
# Runs the FULL stack (app + caddy + docker-proxy + all 5 game containers) with the
# dev override (localhost + self-signed + nodemon live reload), chaining the three
# env sources compose needs for ${...} interpolation:
#   .secrets/etc/gamertown/secrets.env   (CS2_RCON_PASSWORD, CS2_GSLT, app/caddy)
#   .secrets/root/gamertown/.env         (MC/GMOD/PH RCON, GSLTs, SKIP_CSS, MC_LEVEL)
#   .env.local                           (GT_SECRETS_FILE, GT_CERTS_DIR)
#
# Run tools/setup.sh first (it creates .secrets/ + .env.local). Then:
#   tools/dev.sh                  # up -d --build (default)
#   tools/dev.sh logs -f app      # follow app logs
#   tools/dev.sh ps               # status
#   tools/dev.sh down             # stop the stack
#   tools/dev.sh up -d minecraft  # just one service
#
# Tip: SKIP_CSS=1 tools/dev.sh   to skip GMOD's ~3GB CS:S pull on first boot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
secrets="$REPO_ROOT/.secrets/etc/gamertown/secrets.env"
projenv="$REPO_ROOT/.secrets/root/gamertown/.env"
envlocal="$REPO_ROOT/.env.local"

for f in "$secrets" "$projenv" "$envlocal"; do
  [ -f "$f" ] || { echo "ERROR: missing $f - run tools/setup.sh first." >&2; exit 1; }
done

# Default action when no args given.
if [ "$#" -eq 0 ]; then set -- up -d --build; fi
args=("$@")

docker compose \
  --project-directory "$REPO_ROOT" \
  --env-file "$secrets" --env-file "$projenv" --env-file "$envlocal" \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/servers.compose.yml" \
  -f "$REPO_ROOT/mc-mem.override.yml" \
  -f "$REPO_ROOT/docker-compose.dev.yml" \
  "${args[@]}"
code=$?

# After a successful `up`, point the user at the local site.
if [ "$code" -eq 0 ]; then
  for a in "${args[@]}"; do
    if [ "$a" = "up" ]; then
      printf '\n  Gamertown (dev) is up -> https://localhost\n'
      printf '  (accept the self-signed cert; logs: tools/dev.sh logs -f app)\n'
      break
    fi
  done
fi
exit "$code"
