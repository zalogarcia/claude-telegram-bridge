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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFLIGHT="${BRIDGE_INFLIGHT_FILE:-$SCRIPT_DIR/bg-inflight.json}"
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
    # TIMEOUT. The old behaviour was "restart anyway", which on 2026-08-02 killed
    # a live 5-piece video job mid-composite: four outputs left unverified, one a
    # truncated mp4, one piece never started, no report. A delayed restart costs
    # nothing (the new code just goes live later); a killed worker costs the job.
    #
    # So: only force a restart over the CHAT lane, never over background work.
    # Background jobs are the long ones and the ones with real work to lose.
    # Which children are BACKGROUND workers? Don't guess from `ps` — the chat
    # lane has an identical command line, so a pattern match counts the very run
    # that armed this restart and would wait forever. The watchdog registry is
    # authoritative: bridge.mjs writes each bg worker's pid there at spawn and
    # clears it on genuine completion.
    bg=$(python3 - "$INFLIGHT" <<'PY' 2>/dev/null || echo 0
import json, os, sys
try:
    recs = json.load(open(sys.argv[1]))
except Exception:
    print(0); raise SystemExit
alive = 0
for r in (recs or {}).values():
    pid = r.get("pid")
    if not pid:
        continue
    try:
        os.kill(pid, 0)
        alive += 1
    except OSError as e:
        import errno
        if e.errno == errno.EPERM:
            alive += 1
print(alive)
PY
)
    if [ "$bg" -gt 0 ]; then
      echo "[safe-restart] timeout after ${TIMEOUT_MIN}m but $bg live worker(s) — NOT restarting; work outranks a restart" >&2
      echo "[safe-restart] extending: will keep waiting and restart once they finish" >&2
      deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))   # re-arm, keep waiting
      sleep 30
      continue
    fi
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
