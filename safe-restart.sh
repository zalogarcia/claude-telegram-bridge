#!/bin/bash
# Restart the bridge service WITHOUT killing an in-flight run.
#
# Polls until the daemon has no claude child processes (no run in progress),
# then restarts the service. Prefer this over a fixed-delay restart
# (`sleep 45 && restart`): mid-task steering lets a run extend past any
# guessed delay, and a timer that fires mid-run kills the daemon's own child —
# the reply being composed dies undelivered.
#
# Invoke detached from inside a bridge-driven Claude run:
#   nohup ./safe-restart.sh >/dev/null 2>&1 &
# The invoking run is itself a child of the daemon, so the script naturally
# waits for the current reply to land before restarting.
#
# Usage: safe-restart.sh [timeout-minutes]   (default 15; on timeout it
# restarts anyway — same behavior as a fixed delay, but only as a last
# resort, and it logs that it did.)

TIMEOUT_MIN=${1:-15}
LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))

while :; do
  # ps, not pgrep, for BOTH probes: pgrep -f can miss node scripts on macOS,
  # and BSD pgrep -P without a pattern silently matches nothing — a false
  # "idle" that would restart over a live run.
  DPID=$(ps aux | grep '[b]ridge\.mjs' | awk '{print $2}' | head -1)
  [ -z "$DPID" ] && break                     # daemon down — restart boots it
  kids=$(ps -axo ppid= | awk -v p="$DPID" '$1 == p' | wc -l | tr -d ' ')
  [ "$kids" = "0" ] && break                  # idle — safe to restart
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[safe-restart] timeout after ${TIMEOUT_MIN}m — restarting over $kids live child(ren)" >&2
    break
  fi
  sleep 5
done

if [ "$(uname -s)" = "Darwin" ]; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  systemctl --user restart "$LABEL"
fi
