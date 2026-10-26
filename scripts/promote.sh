#!/usr/bin/env bash
# Promote origin/deploy-candidate to deploy and push a signed deploy-* tag.
set -euo pipefail
git fetch --quiet --prune --tags origin
git fetch --quiet --tags upstream

CAND=$(git rev-parse origin/deploy-candidate)
BASE=$(git describe --tags --abbrev=0 --first-parent --match 'v*' "$CAND")
BRANCHES=$(git show origin/ops:deploy/branches.txt \
  | sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' | paste -sd ' ')
PREV=$(git describe --tags --abbrev=0 --match 'deploy-*' origin/deploy 2>/dev/null || echo none)
TAG="deploy-${BASE#v}-$(date +%Y%m%d)"
n=2; while git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; do
  TAG="deploy-${BASE#v}-$(date +%Y%m%d)-$n"; n=$((n+1)); done

printf 'Candidate : %s\nBase      : %s\nBranches  : %s\nPrevious  : %s\nNew tag   : %s\n' \
  "$CAND" "$BASE" "$BRANCHES" "$PREV" "$TAG"
echo "Check the SHA matches the build-candidate issue you reviewed."
read -rp "Promote? Type the first 7 characters of the SHA: " ans
[[ "$ans" == "${CAND:0:7}" ]] || { echo "aborted"; exit 1; }

git tag -s "$TAG" -m "Deploy $TAG" -m "Base: $BASE" -m "Branches: $BRANCHES" "$CAND"
git push --force origin "$CAND:refs/heads/deploy"
git push origin "refs/tags/$TAG"
echo; echo "Install on the VM: tag $TAG, SHA $CAND"
