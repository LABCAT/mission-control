#!/usr/bin/env bash
# Deletes one preview: its Worker Preview, then its Neon branch preview/<name>.
#   delete-preview.sh <name>
# Env: WRANGLER, NEONCTL, WORKER_NAME, PROJECT, NEON_API_KEY (and the Cloudflare vars wrangler needs).
# Only a confirmed "not found" is tolerated. Any other failure stops the script, and the Neon
# branch is only deleted after the Worker Preview delete succeeded or was confirmed absent.
set -euo pipefail
NAME=$1
BRANCH=preview/$NAME
"$(dirname "$0")/preview-neon.mjs" valid "$BRANCH"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

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
