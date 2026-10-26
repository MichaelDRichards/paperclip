#!/usr/bin/env bash
# Build deploy-candidate = <upstream tag> + every branch in deploy/branches.txt.
# Usage: scripts/build-deploy.sh <upstream-tag>      e.g. v2026.1012.0
set -euo pipefail

# Checking out Paperclip code removes this file from the work tree, so run from a temp copy.
if [[ -z "${BD_COPY:-}" ]]; then
  tmp=$(mktemp); cp "$0" "$tmp"; BD_COPY=1 exec bash "$tmp" "$@"
fi

BASE="${1:?usage: build-deploy.sh <upstream-tag>}"
git fetch --quiet upstream tag "$BASE"
git fetch --quiet --prune origin

# Always read the list from origin/ops, never from whatever is checked out.
mapfile -t BRANCHES < <(git show origin/ops:deploy/branches.txt \
  | sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d')
[[ ${#BRANCHES[@]} -gt 0 ]] || { echo "no branches listed"; exit 1; }

git checkout --quiet --force -B deploy-candidate "refs/tags/$BASE"
for b in "${BRANCHES[@]}"; do
  echo "== merging $b ($(git rev-parse --short "origin/$b"))"
  if ! git merge --no-ff --no-edit -m "deploy: merge $b" "origin/$b"; then
    if [[ -z "$(git diff --name-only --diff-filter=U)" ]]; then
      git commit --no-edit   # every conflict resolved from the rerere cache
      echo "   conflicts auto-resolved from rerere: review them"
    else
      echo "CONFLICT merging $b:"; git diff --name-only --diff-filter=U
      git merge --abort; exit 2
    fi
  fi
done
echo "candidate: $(git rev-parse HEAD) = $BASE + ${BRANCHES[*]}"
