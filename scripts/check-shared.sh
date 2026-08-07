#!/bin/bash
# Fail if any SHARED module has drifted between the public and private bridge
# repos.
#
# Some modules are deliberately identical in both repos: they own no paths, no
# credentials and no owner-specific prose, so the same bytes ship in both places.
# That property is only worth anything if something checks it — a prose rule
# saying "keep these in sync" decays the first time someone is in a hurry.
#
# The two bridge.mjs files are NOT shared and never will be: the public one
# carries a config layer (conf()/config.json/install.sh) that the private one
# does not. Only the modules listed below are expected to match.
#
# Usage:
#   ./scripts/check-shared.sh                 # compare against the sibling repo
#   BRIDGE_SIBLING_REPO=/path ./scripts/check-shared.sh
#
# Exits 0 when every shared module matches, 1 on any difference, 2 if the
# sibling repo cannot be found.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "$SCRIPT_DIR")"

# The sibling is the other half of the pair. Default is derived from this repo's
# own location, so neither copy of this script hardcodes a personal path.
case "$REPO_NAME" in
  *-public) DEFAULT_SIBLING="${SCRIPT_DIR%-public}" ;;
  *)        DEFAULT_SIBLING="${SCRIPT_DIR}-public" ;;
esac
SIBLING="${BRIDGE_SIBLING_REPO:-$DEFAULT_SIBLING}"

SHARED_MODULES=(
  rich-format.mjs
  schedule.mjs
  detached-workers.mjs
  md-format.mjs
  md-format.test.mjs
  progress-render.mjs
  progress-render.test.mjs
  usage-limits.mjs
  usage-limits.test.mjs
)

if [ ! -d "$SIBLING" ]; then
  echo "check-shared: sibling repo not found at $SIBLING" >&2
  echo "  set BRIDGE_SIBLING_REPO=/path/to/the/other/repo" >&2
  exit 2
fi

fail=0
for f in "${SHARED_MODULES[@]}"; do
  a="$SCRIPT_DIR/$f"
  b="$SIBLING/$f"
  if [ ! -f "$a" ]; then
    echo "DRIFT  $f — missing in $REPO_NAME"
    fail=1
  elif [ ! -f "$b" ]; then
    echo "DRIFT  $f — missing in $(basename "$SIBLING")"
    fail=1
  elif ! diff -q "$a" "$b" >/dev/null; then
    echo "DRIFT  $f — differs from $(basename "$SIBLING")"
    diff -u "$b" "$a" | sed -n '1,40p' | sed 's/^/       /'
    fail=1
  else
    echo "ok     $f"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Shared modules must be byte-identical in both repos."
  echo "If a change genuinely cannot be shared, it does not belong in a shared"
  echo "module — inject the difference instead (see detached-workers.mjs)."
  exit 1
fi

echo ""
echo "All ${#SHARED_MODULES[@]} shared modules match $(basename "$SIBLING")."
