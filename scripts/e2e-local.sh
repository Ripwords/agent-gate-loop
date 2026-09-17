#!/usr/bin/env bash
# Runs the full loop on a throwaway copy of examples/sample-repo.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
cp -R "$root/examples/sample-repo/." "$work/"
git -C "$work" init -q -b main
git -C "$work" add -A
git -C "$work" -c user.name=e2e -c user.email=e2e@example.com commit -qm "init"

echo "Work dir: $work"
cd "$root"
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
bun src/local.ts --repo "$work" --issue-file "$root/examples/sample-issue.md" --check "bun test" "$@"
