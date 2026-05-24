#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit."
else
  MSG="${1:-chore: save work $(date '+%Y-%m-%d %H:%M')}"
  git add -A
  git commit -m "$MSG"
fi

git push
