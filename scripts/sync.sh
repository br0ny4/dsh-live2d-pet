#!/usr/bin/env bash
#
# Commit everything outstanding and push it to GitHub.
#
#   ./scripts/sync.sh "fix: 修掉抠图的通道步长 bug"
#
# Notes:
#   - This repository sets an empty `http.proxy` in its own `.git/config`
#     because the machine's global git config points at a proxy
#     (127.0.0.1:7890) that is not always running. The global config is left
#     alone; only this checkout overrides it.
#   - Never force-pushes.
set -euo pipefail

cd "$(dirname "$0")/.."

message="${1:-}"
if [ -z "$message" ]; then
  echo "usage: $0 \"<commit message>\"" >&2
  exit 1
fi

if [ -z "$(git status --porcelain)" ]; then
  echo "nothing to commit"
else
  git add -A
  git commit -m "$message"
fi

# Push even when the commit was already made, so a failed earlier push recovers.
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  git push
else
  git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
fi

echo "synced: $(git remote get-url origin) $(git rev-parse --short HEAD)"
