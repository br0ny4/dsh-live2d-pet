#!/usr/bin/env bash
#
# Commit everything outstanding and push it to GitHub.
#
#   ./scripts/sync.sh "fix: 修掉抠图的通道步长 bug"
#
# Pushes over SSH. Retries, because connections to GitHub fail in bursts on
# some networks and an attempt that fails usually succeeds seconds later.
# Never force-pushes.
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

push() {
  if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    git push
  else
    git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
  fi
}

for attempt in 1 2 3 4 5; do
  if push; then
    echo "synced: $(git remote get-url origin) $(git rev-parse --short HEAD)"
    exit 0
  fi
  echo "push attempt ${attempt} failed; retrying in 5s" >&2
  sleep 5
done

echo "push failed after 5 attempts; the commit is local and safe" >&2
exit 1
