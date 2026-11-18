#!/usr/bin/env bash
# Validates the git branch given to the manual reset (workflow_dispatch input reset_preview).
#   check-reset-branch.sh <git branch>
# It must be a real branch of this repo, not a preview name: the reset re-runs that branch's
# latest push run, so `feature-foo` for branch `feature/foo` would find nothing to re-run after
# the preview was already deleted. Nothing is deleted before this passes.
# Env: REMOTE (default: origin), the remote to look the branch up on.
set -euo pipefail
BRANCH=${1:-}
REMOTE=${REMOTE:-origin}
fail() { echo "::error::$1"; exit 1; }

[ -n "$BRANCH" ] || fail "reset_preview is empty"
case "$BRANCH" in
  -*|*[[:space:]]*|*..*|refs/*|preview/*) fail "'$BRANCH' is not a git branch name (give the branch, e.g. feature/foo, not a preview name)" ;;
  main) fail "main has no preview" ;;
esac
git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$BRANCH" > /dev/null 2>&1 \
  || fail "No git branch '$BRANCH' in this repo. Give the git branch (e.g. feature/foo), not the preview name (feature-foo). Nothing was deleted."
