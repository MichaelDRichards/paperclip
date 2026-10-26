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
[[ ${#BRANCHES[@]} -gt 0 ]] || echo "no branches listed: the candidate is $BASE alone"

# Each branch must start from released upstream code. A branch cut from upstream
# master after the release would carry unreleased upstream commits into the deploy.
if git rev-parse --quiet --verify origin/master >/dev/null; then
  for b in "${BRANCHES[@]}"; do
    fork=$(git merge-base "origin/$b" origin/master)
    if ! git merge-base --is-ancestor "$fork" "refs/tags/$BASE"; then
      n=$(git rev-list --count "refs/tags/$BASE..$fork")
      echo "REFUSED: $b is based on upstream master $(git rev-parse --short "$fork"), which has $n commits not in $BASE."
      echo "Rebase it onto a release tag first:  git rebase --onto $BASE $(git rev-parse --short "$fork") $b"
      exit 3
    fi
  done
else
  echo "warning: origin/master not found; cannot check that branches start from released code"
fi

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
