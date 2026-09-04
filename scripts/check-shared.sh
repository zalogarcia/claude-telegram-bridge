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

# A file belongs here the moment both repos carry the same copy — test suites
# included. A shared module whose TESTS are unenforced is only half-protected:
# the tests are what say what the module must do, so letting them drift lets the
# two repos disagree about correctness while the modules still match byte for
# byte. rich-format/detached-workers/watchdog tests were identical but unlisted.
SHARED_MODULES=(
  rich-format.mjs
  rich-format.test.mjs
  schedule.mjs
  detached-workers.mjs
  detached-workers.test.mjs
  watchdog.test.mjs
  md-format.mjs
  md-format.test.mjs
  progress-render.mjs
  progress-render.test.mjs
  usage-limits.mjs
  usage-limits.test.mjs
  accounts.mjs
  accounts.test.mjs
  account-usage.mjs
  account-usage.test.mjs
  account-buttons.mjs
  account-buttons.test.mjs
  credential-store.mjs
  credential-store.test.mjs
)

# NOT LISTED, and why. These modules came from the private sibling and behave
# the same way, but they have DIVERGED and cannot be byte-identical. Two
# separate reasons, kept apart because only the first one is ever going away:
#
# (a) The private copies name the owner and his machine, and a public repo
#     cannot repeat that. Byte-identity waits on the private side being
#     genericized, not on anything here:
#
#       bg-steer.mjs        + its test   (the steer framing names the assistant)
#       codex-account.mjs   + its test   (comments; a city in one of them)
#       bg-codex.mjs        + its test   (comments; a hardcoded default timezone,
#                                        which here means the machine's own)
#
# (b) This repo carries fixes the private one does not, found by the QA pass on
#     the port (2026-09-04). Listing these would make the gate demand that the
#     private repo REGRESS to match:
#
#       bg-codex.mjs        codexParkedNote clips both halves of a parked pair;
#                           unclipped, ten `--file` briefs plus ten Codex answers
#                           go into one prompt when the wall lifts
#       bg-steer.mjs        carries parseRunId, which lives in the private
#                           bg-notify.mjs (a module this repo does not have)
#
#       bg-codex-wiring.test.mjs   harness stubs differ throughout (no full-report
#                                  file here), plus the sections covering the two
#                                  fixes above
#
# bg-lane-rules.mjs and bg.mjs are public-only shapes and are not candidates:
# bg.mjs carries this repo's config layer, and the private repo has no
# bg-lane-rules.mjs at all (its stripLaneRules, briefTitle and briefRepo live in
# bg-notify.mjs alongside owner-specific notice text).

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
