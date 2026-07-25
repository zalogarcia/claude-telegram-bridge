#!/usr/bin/env bash
# Removes the background service. Leaves config.json, state.json and inbox/
# alone unless you pass --purge.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"
WATCHDOG_LABEL="$LABEL.watchdog"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

touch "$DIR/.bridge-paused"   # stop the watchdog resurrecting it mid-uninstall

if [ "$(uname)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$WATCHDOG_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"
  echo "✓ LaunchAgents removed"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$WATCHDOG_LABEL.timer" 2>/dev/null || true
  systemctl --user disable --now "$LABEL.service" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$LABEL.service" \
        "$HOME/.config/systemd/user/$WATCHDOG_LABEL.service" \
        "$HOME/.config/systemd/user/$WATCHDOG_LABEL.timer"
  systemctl --user daemon-reload
  echo "✓ systemd units removed"
fi

rm -f "$DIR/heartbeat" "$DIR/.watchdog-strike" "$DIR/.watchdog-fails" "$DIR/.bridge-paused"

if [ "$PURGE" = 1 ]; then
  rm -f "$DIR/config.json" "$DIR/state.json" "$DIR/schedules.json" \
        "$DIR/bg-queue.json" "$DIR/bg-results.jsonl"
  rm -rf "$DIR/inbox"
  echo "✓ purged config, state, schedules and inbox"
else
  echo "  (config.json, state.json, schedules and inbox kept — use --purge to delete)"
fi
