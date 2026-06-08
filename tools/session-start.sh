#!/usr/bin/env bash
# session-start.sh — make a fresh checkout test-ready (Claude Code on the web).
#
# Fired by the SessionStart hook in .claude/settings.json. A web session starts in a
# freshly-cloned container with no backend/node_modules, so `gt test` / the suites can't
# run until deps are installed. This installs them ONCE, idempotently, and NEVER blocks a
# session — it always exits 0 (a failed install just prints a hint).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(dirname "$SCRIPT_DIR")/backend"

if [ -d "$BACKEND/node_modules" ]; then
  echo "[session-start] backend deps already present — nothing to do."
  exit 0
fi

echo "[session-start] installing backend deps (npm ci)…"
if ( cd "$BACKEND" && npm ci --no-audit --no-fund ); then
  echo "[session-start] backend deps ready — run: tools/gt.sh test"
else
  echo "[session-start] npm ci failed — run it manually in backend/ before tests." >&2
fi
exit 0
