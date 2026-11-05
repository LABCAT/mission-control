#!/usr/bin/env bash
# Prints the Worker Preview name, also used for its Neon branch (preview/<name>).
#   preview-name.sh branch <git branch>   ->  feature/Foo_bar  -> feature-foo-bar
#   preview-name.sh rc <version>          ->  0.2.0            -> rc-0-2-0
# Names are DNS labels in <name>-<worker>.<subdomain>.workers.dev, so lowercase,
# hyphens only, capped at 40 characters.
set -euo pipefail
kind=$1 value=$2
case "$kind" in
  branch) name=$value ;;
  rc) name="rc-$value" ;;
  *) echo "usage: $0 branch|rc <value>" >&2; exit 2 ;;
esac
echo "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-40 | sed -E 's/-+$//'
