#!/usr/bin/env bash
# gt — Gamertown unified dispatcher (Linux / macOS / keeper).
#
# One command per mode (the Windows counterpart is tools/gt.ps1):
#   gt.sh dev --fresh           blank machine -> working dev stack (deps, secrets, DB, up)
#   gt.sh dev --prod-like       existing data, prod-shaped (real cert, gamertown.solutions, VAC)
#   gt.sh dev --prod-like --app app only (no game servers)
#   gt.sh dev <compose args...> passthrough (ps / logs -f app / down / up -d minecraft)
#   gt.sh prod                  KEEPER ONLY: backup-first deploy (abort on backup fail)
#   gt.sh prod --dry-run        print every resolved command, do nothing
#   gt.sh prod --rollback       restore predeploy DB + checkout last SHA + redeploy
#   gt.sh restore-db [name]     restore the app DB from R2 (DR-grade)
#   gt.sh seed-dev [flags]      restore prod DB/world snapshots into dev volumes
#
# Mode/env/compose mapping lives in tools/gt-modes.conf (shared with gt.ps1).
# This dispatcher CALLS the existing primitives (setup.sh, db-restore.sh,
# dev-restore-data.sh, gt-backup.sh) rather than reimplementing them.
set -uo pipefail   # NOTE: not -e; compose/git writes to stderr and we judge by exit code.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CONF="$SCRIPT_DIR/gt-modes.conf"

# prod-flag globals (defaults satisfy set -u)
FORCE=0; DRYRUN=0; PULL=0; AUTORB=0
RESTORE_FORCE=0

# ── shared mode config (no associative arrays → portable to bash 3.2) ───────────
conf_get() {   # $1=key → prints the (space-separated) value, trimmed
  [ -f "$CONF" ] || { echo "ERROR: missing $CONF" >&2; exit 1; }
  local k_esc line
  k_esc="${1//./\\.}"
  line="$(grep -E "^[[:space:]]*${k_esc}[[:space:]]*=" "$CONF" | head -1)"
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"   # ltrim
  line="${line%"${line##*[![:space:]]}"}"   # rtrim
  printf '%s' "$line"
}

is_keeper() { [ -f /etc/gamertown/secrets.env ]; }
data_volume() { if is_keeper; then printf '%s_gt-data' "$(conf_get project.keeper)"; else printf '%s_gt-data' "$(conf_get project.dev)"; fi; }

# Build + run (or, under DRYRUN, print) a docker compose invocation for a mode.
# $1=mode (dev-fresh|dev-prodlike|dev-prodlike-app|prod), rest = compose args.
compose_for() {
  local mode="$1"; shift
  local proj f chainkey
  if [ "$mode" = "prod" ]; then proj="$(conf_get project.keeper)"; else proj="$(conf_get project.dev)"; fi
  local -a cmd=(docker compose -p "$proj" --project-directory "$REPO_ROOT")
  if [ "$mode" != "prod" ]; then
    chainkey="env_chain"; [ "$mode" = "dev-prodlike-app" ] && chainkey="env_chain.app"
    for f in $(conf_get "$chainkey"); do cmd+=(--env-file "$REPO_ROOT/$f"); done
  fi
  for f in $(conf_get "compose.$mode"); do cmd+=(-f "$REPO_ROOT/$f"); done
  cmd+=("$@")
  if [ "$DRYRUN" = "1" ]; then printf '  [dry-run] %s\n' "${cmd[*]}"; return 0; fi
  "${cmd[@]}"
}

run() {   # echo under dry-run, else execute
  if [ "$DRYRUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

# ── shared checks ──────────────────────────────────────────────────────────────
DEV_SECRETS="$REPO_ROOT/.secrets/etc/gamertown/secrets.env"
DEV_PROJENV="$REPO_ROOT/.secrets/root/gamertown/.env"
DEV_ENVLOCAL="$REPO_ROOT/.env.local"
RCON_KEYS="MINECRAFT_RCON_PASSWORD CS2_RCON_PASSWORD GMOD_RCON_PASSWORD PROPHUNT_RCON_PASSWORD"

require_dev_files() {   # all three present, else point at --fresh
  local f missing=0
  for f in "$DEV_SECRETS" "$DEV_PROJENV" "$DEV_ENVLOCAL"; do
    [ -f "$f" ] || { echo "  missing: $f" >&2; missing=1; }
  done
  [ "$missing" -eq 0 ] || { echo "ERROR: dev secrets not set up. Run: tools/gt.sh dev --fresh" >&2; exit 1; }
}

require_rcon_keys() {   # the 4 ${..:?} interpolation vars must be non-empty
  local k
  for k in $RCON_KEYS; do
    grep -qE "^${k}=.+" "$DEV_SECRETS" || { echo "ERROR: $k missing/empty in $DEV_SECRETS (needed for compose interpolation)." >&2; exit 1; }
  done
}

require_tty() {
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    echo "ERROR: 'gt dev --fresh' needs an interactive terminal for the age passphrase." >&2
    echo "  Run it in a real terminal, or use an age identity file (GT_AGE_IDENTITY) — see docs/local-dev.md." >&2
    exit 1
  fi
}

poll_health() {   # $1=label $2=url, rest = extra curl args. Bounded ~60s.
  local label="$1" url="$2"; shift 2
  local i
  echo "[*] waiting for $label health: $url"
  for i in $(seq 1 30); do
    if curl -sk --max-time 4 "$@" "$url" 2>/dev/null | grep -q '"ok":true'; then
      echo "[OK] $label healthy"; return 0
    fi
    sleep 2
  done
  echo "[WARN] $label not healthy after ~60s (it may still be starting)" >&2
  return 1
}

# ── dev ─────────────────────────────────────────────────────────────────────────
preseed_db() {   # create the gt-data volume and seed the app DB BEFORE `up`
  local vol; vol="$(data_volume)"
  docker volume create "$vol" >/dev/null
  if [ "$RESTORE_FORCE" != "1" ] && docker run --rm -v "${vol}:/d" alpine test -s /d/gamertown.sqlite 2>/dev/null; then
    echo "[*] $vol already has a DB — skipping restore (pass --restore to force a fresh pull)"
    return 0
  fi
  echo "[*] restoring app DB from R2 into $vol (so login works)…"
  GT_DATA_VOLUME="$vol" "$SCRIPT_DIR/db-restore.sh" || \
    echo "[WARN] DB restore failed — login may not work; retry later with: tools/gt.sh restore-db" >&2
}

dev_fresh() {
  require_tty
  echo "== gt dev --fresh =="
  "$SCRIPT_DIR/setup.sh"            # deps + secrets + .env.local (age prompts on the TTY)
  require_dev_files
  require_rcon_keys
  preseed_db
  echo "[*] building + starting the dev stack…"
  compose_for dev-fresh up -d --build || { echo "ERROR: compose up failed (see output above)." >&2; exit 1; }
  poll_health app "https://localhost/api/health" || true
  cat <<EOF

[OK] Web app + login ready at https://localhost  (accept the self-signed cert)
     Game servers download on first boot (CS2 ~30GB) and become joinable later.
     Status: tools/gt.sh dev ps      Logs: tools/gt.sh dev logs -f counterstrike
EOF
}

dev_prodlike() {   # $1 = fleet|app
  local shape="$1" mode
  echo "== gt dev --prod-like ($shape) =="
  if [ "$shape" = "app" ]; then
    [ -f "$DEV_ENVLOCAL" ] || { echo "ERROR: .env.local missing — run: tools/gt.sh dev --fresh" >&2; exit 1; }
    mode="dev-prodlike-app"
  else
    require_dev_files; require_rcon_keys
    mode="dev-prodlike"
  fi
  if grep -q "gamertown.solutions" /etc/hosts 2>/dev/null; then
    echo "[*] hosts entry present (gamertown.solutions) — good"
  else
    echo "[!] hosts entry missing. To browse the site in a browser, add (needs sudo):"
    echo "      127.0.0.1 gamertown.solutions www.gamertown.solutions"
  fi
  compose_for "$mode" up -d --build || { echo "ERROR: compose up failed (see output above)." >&2; exit 1; }
  poll_health app "https://gamertown.solutions/api/health" --resolve gamertown.solutions:443:127.0.0.1 || true
  echo "[OK] prod-like stack up. Browse https://gamertown.solutions (after the hosts entry)."
  [ "$shape" = "fleet" ] && echo "    Note: the bundle ships no CS2_GSLT, so CS2 boots tokenless (LAN-only) even here."
}

cmd_dev() {
  local mode="" shape="fleet"
  local -a pass=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --fresh)      mode="fresh" ;;
      --prod-like)  mode="prodlike" ;;
      --app)        shape="app" ;;
      --restore)    RESTORE_FORCE=1 ;;
      *)            pass+=("$1") ;;
    esac
    shift
  done
  if [ -n "$mode" ] && [ "${#pass[@]}" -gt 0 ]; then
    echo "ERROR: don't mix a mode flag with passthrough args (${pass[*]})." >&2; exit 1
  fi
  case "$mode" in
    fresh)     dev_fresh ;;
    prodlike)  dev_prodlike "$shape" ;;
    "")        require_dev_files
               if [ "${#pass[@]}" -eq 0 ]; then pass=(up -d --build); fi
               compose_for dev-fresh "${pass[@]}" ;;
  esac
}

# ── prod (keeper) ────────────────────────────────────────────────────────────────
assert_keeper() {
  if ! is_keeper; then
    echo "ERROR: 'gt prod' must run ON THE KEEPER (no /etc/gamertown/secrets.env found here)." >&2
    echo "  ssh root@192.168.1.241   then:   cd /root/gamertown && tools/gt.sh prod" >&2
    exit 1
  fi
}

disk_preflight() {
  local avail mnt
  avail="$(df -Pk "$REPO_ROOT" | awk 'NR==2{print $4}')"
  mnt="$(df -Ph "$REPO_ROOT" | awk 'NR==2{print $6}')"
  if [ -n "${avail:-}" ] && [ "$avail" -lt 2097152 ]; then
    echo "[!] low disk on $mnt ($(( avail / 1024 )) MB free) — the image build may fail." >&2
  fi
}

secrets_staleness_nudge() {
  command -v rclone >/dev/null 2>&1 || return 0
  local sec_m iso r2_m
  sec_m="$(stat -c %Y /etc/gamertown/secrets.env 2>/dev/null || echo 0)"
  iso="$(rclone lsjson "r2:gamertown-backups/secrets/secrets.tar.age" 2>/dev/null | sed -n 's/.*"ModTime":"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$iso" ] || return 0
  r2_m="$(date -d "$iso" +%s 2>/dev/null || echo 0)"
  if [ "$sec_m" -gt "$r2_m" ]; then
    echo "[!] /etc/gamertown/secrets.env is newer than the last offsite backup — consider: tools/secrets-backup.sh" >&2
  fi
}

prod_rollback() {
  local anchor="$REPO_ROOT/.last-deploy" sha vol
  [ -f "$anchor" ] || { echo "ERROR: no $anchor — nothing to roll back to." >&2; exit 1; }
  sha="$(cat "$anchor")"
  vol="$(data_volume)"
  echo "== gt prod --rollback -> $sha =="
  compose_for prod down
  echo "[*] restoring the pre-deploy DB snapshot (predeploy/) …"
  # The DB revert IS the point of a rollback — a failed restore is fatal (don't bring the
  # stack back up on the post-bad-deploy DB and falsely report "healthy"). Stack stays down.
  GT_DATA_VOLUME="$vol" GT_R2_PREFIX=predeploy run "$SCRIPT_DIR/db-restore.sh" || {
    echo "[ERROR] predeploy DB restore failed — ABORTING rollback; DB NOT reverted. Restore it manually before starting the stack." >&2
    exit 1
  }
  # checkout -B (not a bare SHA) so HEAD stays ON main — a detached HEAD would make the
  # NEXT `gt prod` fail its branch check and never reach the reconcile step.
  run git -C "$REPO_ROOT" checkout -B main "$sha"
  compose_for prod up -d --build || { echo "ERROR: compose up failed during rollback." >&2; exit 1; }
  [ "$DRYRUN" = "1" ] || poll_health app "https://gamertown.solutions/api/health" || { echo "[ERROR] still unhealthy after rollback." >&2; exit 1; }
  echo "[OK] rolled back to $sha (on main)."
}

prod_deploy() {
  local branch sha label=""
  [ "$DRYRUN" = "1" ] && label=" (dry-run)"
  echo "== gt prod${label} =="

  # 1. cheap fail-fast checks BEFORE the backup
  run git -C "$REPO_ROOT" fetch --quiet origin
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [ "$branch" != "main" ]; then
    echo "ERROR: keeper checkout is on '$branch', expected 'main'." >&2
    [ "$branch" = "HEAD" ] && echo "  (detached HEAD — run: git -C $REPO_ROOT checkout main)" >&2
    [ "$DRYRUN" = "1" ] || exit 1
  fi
  if [ "$DRYRUN" != "1" ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
    echo "ERROR: keeper working tree is dirty. Reconcile (git stash / git checkout .) then retry." >&2
    exit 1
  fi

  # 2. rollback anchor
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ "$DRYRUN" = "1" ]; then
    printf '  [dry-run] %s\n' "printf '%s\n' '$sha' > '$REPO_ROOT/.last-deploy'"
  else
    printf '%s\n' "$sha" > "$REPO_ROOT/.last-deploy"
  fi
  echo "[*] rollback anchor recorded: $sha"

  # 3-4. non-blocking nudges
  secrets_staleness_nudge
  disk_preflight

  # 5. PRE-DEPLOY BACKUP — DB only, strict, to predeploy/ (abort unless --force)
  echo "[*] pre-deploy backup: DB -> predeploy/ (keep 10, strict, verified)…"
  if [ "$DRYRUN" = "1" ]; then
    printf '  [dry-run] %s\n' "GT_STRICT=1 $SCRIPT_DIR/gt-backup.sh db --prefix predeploy --keep 10"
  elif GT_STRICT=1 "$SCRIPT_DIR/gt-backup.sh" db --prefix predeploy --keep 10; then
    echo "[OK] pre-deploy DB backup complete"
  elif [ "$FORCE" = "1" ]; then
    echo "[WARN] backup failed but --force set; continuing without a fresh restore point." >&2
  else
    echo "ERROR: pre-deploy backup failed — ABORTING deploy. (Override with: gt prod --force)" >&2
    exit 1
  fi

  # 6. reconcile to main (a plain pull keeps failing on any keeper drift)
  run git -C "$REPO_ROOT" reset --hard origin/main

  # 7. deploy
  [ "$PULL" = "1" ] && compose_for prod pull
  compose_for prod up -d --build || { echo "ERROR: compose up failed." >&2; exit 1; }

  # 8-10. health + hygiene (skipped under dry-run)
  if [ "$DRYRUN" != "1" ]; then
    if poll_health app "https://gamertown.solutions/api/health"; then
      echo "[OK] app health OK (game-server readiness NOT checked; CS2 may re-pull ~30GB)"
    else
      echo "[ERROR] health check failed after deploy." >&2
      echo "  rollback: tools/gt.sh prod --rollback" >&2
      [ "$AUTORB" = "1" ] && { echo "[*] --auto-rollback set; rolling back…"; prod_rollback; }
      exit 1
    fi
    docker image prune -f >/dev/null 2>&1 || true   # reclaim orphaned app/gmod layers
  fi
  echo "[OK] gt prod complete."
}

cmd_prod() {
  local rollback=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --force)         FORCE=1 ;;
      --dry-run)       DRYRUN=1 ;;
      --rollback)      rollback=1 ;;
      --pull-images)   PULL=1 ;;
      --auto-rollback) AUTORB=1 ;;
      *) echo "unknown 'gt prod' flag: $1" >&2; usage; exit 1 ;;
    esac
    shift
  done
  assert_keeper
  if [ "$rollback" = "1" ]; then prod_rollback; else prod_deploy; fi
}

# ── usage ────────────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
gt — Gamertown dispatcher (Linux/macOS/keeper)

  gt.sh dev --fresh            blank machine -> working dev stack (deps, secrets, DB, up)
  gt.sh dev --prod-like        existing data, prod-shaped (real cert + gamertown.solutions)
  gt.sh dev --prod-like --app  app only (no game servers)
  gt.sh dev <compose args...>  passthrough: ps | logs -f app | down | up -d minecraft
  gt.sh seed-dev [flags]       restore prod DB + Factorio + Minecraft snapshots into dev
  gt.sh prod                   KEEPER ONLY: backup-first deploy (abort on backup failure)
       --dry-run               print every resolved command and exit (no side effects)
       --force                 deploy even if the pre-deploy backup fails
       --rollback              restore predeploy DB + checkout last SHA + redeploy
       --pull-images           also `docker compose pull` (game-image version bumps)
       --auto-rollback         roll back automatically if the post-deploy health check fails
  gt.sh restore-db [name]      restore the app DB from R2 (newest, or a named snapshot)

seed-dev flags: --db --factorio --minecraft --worlds --all --keep-bluemap
                --db-name NAME --factorio-name NAME --minecraft-name NAME

Mode/env/compose mapping: tools/gt-modes.conf (shared with tools/gt.ps1).
EOF
}

# ── main ─────────────────────────────────────────────────────────────────────────
sub="${1:-}"; [ "$#" -gt 0 ] && shift
case "$sub" in
  dev)         cmd_dev "$@" ;;
  prod)        cmd_prod "$@" ;;
  restore-db)  GT_DATA_VOLUME="$(data_volume)" "$SCRIPT_DIR/db-restore.sh" "$@" ;;
  seed-dev)    bash "$SCRIPT_DIR/dev-restore-data.sh" "$@" ;;
  ""|help|-h|--help) usage ;;
  *) echo "unknown command: $sub" >&2; usage; exit 1 ;;
esac
