#!/usr/bin/env bash
#
# Commit everything outstanding and push it to GitHub.
#
#   ./scripts/sync.sh "fix: 修掉抠图的通道步长 bug"
#
# Transport, because it took some digging on this machine:
#   - The remote is SSH (`git@github.com:br0ny4/dsh-live2d-pet.git`), not HTTPS.
#     `github.com:443` resolves to an address that times out here, and
#     `api.github.com` stays reachable, which is exactly the combination that
#     lets `gh` work while `git push` hangs for 75 seconds.
#   - `~/.ssh/config` maps `Host github.com` to `ssh.github.com:443`, and the
#     machine's `id_ed25519` is registered on the account.
#   - This checkout also pins an empty `http.proxy` in its own `.git/config`,
#     because the global git config points at `127.0.0.1:7890`, a proxy that is
#     not always running. Irrelevant for SSH, harmless for HTTPS.
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

# Retry: this network drops connections to GitHub in bursts, and a plain
# `git push` that fails once usually succeeds a few seconds later.
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

