#!/usr/bin/env bash
# Deletes one preview: its Worker Preview, then its Neon branch preview/<name>.
#   delete-preview.sh <name>
# Env: WRANGLER, NEONCTL, WORKER_NAME, PROJECT, NEON_API_KEY (and the Cloudflare vars wrangler needs),
#      plus GH_TOKEN and GH_REPO for `gh`.
# Right before deleting, it fetches the open PRs again and skips the delete if an open same-repo PR
# maps to this preview name (feature/foo and feature-foo share one), so a PR opened after the caller
# decided cannot lose its preview. An unreadable PR list fails the script.
# Only a confirmed "not found" is tolerated. Any other failure stops the script, and the Neon
# branch is only deleted after the Worker Preview delete succeeded or was confirmed absent.
set -euo pipefail
NAME=$1
BRANCH=preview/$NAME
# RC previews (preview/rc-*, e.g. from a branch named rc/0.2.0) belong to release.yml: never delete them here.
rc=0
"$(dirname "$0")/preview-neon.mjs" deletable "$BRANCH" || rc=$?
if [ "$rc" = 3 ]; then
  echo "::notice::$BRANCH is reserved for release.yml; not deleting it."
  exit 0
elif [ "$rc" != 0 ]; then
  exit 1
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

gh pr list --state open --limit 1000 --json headRefName,isCrossRepository > "$TMP/prs.json"
[ "$(jq length "$TMP/prs.json")" -lt 1000 ] || { echo "::error::1000+ open PRs; the list may be truncated"; exit 1; }
rc=0
"$(dirname "$0")/preview-neon.mjs" live "$NAME" "$TMP/prs.json" || rc=$?
if [ "$rc" = 0 ]; then
  echo "An open PR now uses preview $NAME; not deleting it."
  exit 0
elif [ "$rc" != 1 ]; then
  echo "::error::Could not decide whether preview $NAME is in use"; exit 1
fi

if ! npx -y "$WRANGLER" preview delete --name "$NAME" --worker-name "$WORKER_NAME" --skip-confirmation </dev/null > "$TMP/wrangler.log" 2>&1; then
  cat "$TMP/wrangler.log"
  grep -qiE 'not found|does not exist|could not find|no preview' "$TMP/wrangler.log" \
    || { echo "::error::Deleting Worker Preview $NAME failed; leaving Neon branch $BRANCH alone"; exit 1; }
  echo "No Worker Preview named $NAME"
fi

neon() { npx -y "$NEONCTL" "$@" --project-id "$PROJECT" --api-key "$NEON_API_KEY" </dev/null; }
# List on its own so a failure stops the job; a branch is absent only if the list parsed.
neon branches list --output json > "$TMP/branches.json"
jq -e 'type == "array"' "$TMP/branches.json" > /dev/null || { echo "::error::Unreadable Neon branch list"; exit 1; }
if jq -e --arg b "$BRANCH" 'any(.[]; .name == $b)' "$TMP/branches.json" > /dev/null; then
  neon branches delete "$BRANCH" > /dev/null
  echo "Deleted $BRANCH"
else
  echo "No Neon branch $BRANCH"
fi
