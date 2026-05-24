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

# Pull from remote before pushing
echo "Pulling from remote..."
if ! git pull --no-edit; then
  # Check for merge conflicts
  if git diff --name-only --diff-filter=U | grep -q .; then
    echo "❌ Merge conflict detected!"
    echo "Conflicted files:"
    git diff --name-only --diff-filter=U
    exit 1
  else
    echo "❌ Pull failed for unknown reason."
    exit 1
  fi
fi

git push
