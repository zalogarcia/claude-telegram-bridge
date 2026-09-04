#!/bin/bash
# Restart the Leash service WITHOUT killing an in-flight run.
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
# Usage: safe-restart.sh [--allow-bg] [timeout-minutes]   (default 15; on
# timeout it restarts anyway — same behavior as a fixed delay, but only as a
# last resort, and it logs that it did.)
#
# --allow-bg: restart as soon as the CHAT lane is idle, without waiting for
# background workers. Background workers are detached and survive a restart
# (see README, "Background workers outlive the daemon"), so waiting hours for a
# long job to end is a cost with no matching risk.
#
# What the flag DOES cost: a worker in flight loses its steerability. The daemon
# holds its stdin, so when the daemon goes the worker reads EOF, finishes, and is
# re-attached on the next boot exactly as before, but `bg.mjs steer` can no
# longer reach it and `bg.mjs ps` will show it as `steerable: no`. Without the
# flag, behaviour is unchanged: the restart waits for every child.

ALLOW_BG=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --allow-bg) ALLOW_BG=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
TIMEOUT_MIN=${ARGS[0]:-15}
LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFLIGHT="${BRIDGE_INFLIGHT_FILE:-$SCRIPT_DIR/bg-inflight.json}"
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))

# Are ALL of the daemon's live children registered background workers?
# (Codex runs count too: they are written to the same registry with
# engine: "codex", and this only ever asks whether a pid is registered.)
# The registry is authoritative for the same reason it is below: the chat lane's
# command line is identical to a worker's, so `ps` pattern matching cannot tell
# them apart. Prints 1 only when there is at least one child and every one of
# them is a registered bg pid; 0 otherwise, including on any error.
only_bg_children() {
  python3 - "$INFLIGHT" $1 <<'PY' 2>/dev/null || echo 0
import json, sys
try:
    recs = json.load(open(sys.argv[1]))
except Exception:
    print(0); raise SystemExit
bg = {r.get("pid") for r in (recs or {}).values() if r.get("pid")}
kids = [int(a) for a in sys.argv[2:] if a.isdigit()]
print(1 if kids and all(k in bg for k in kids) else 0)
PY
}

while :; do
  # ps, not pgrep, for BOTH probes: pgrep -f can miss node scripts on macOS,
  # and BSD pgrep -P without a pattern silently matches nothing — a false
  # "idle" that would restart over a live run.
  DPID=$(ps aux | grep '[b]ridge\.mjs' | awk '{print $2}' | head -1)
  [ -z "$DPID" ] && break                     # daemon down — restart boots it
  # The Codex app-server is a PERSISTENT child of the daemon (one per boot,
  # respawned by the next boot; it reads JSON-RPC on stdin and exits on EOF).
  # It is never work in flight, so it is excluded from both probes. Without
  # this the chat lane never reads as idle once the app-server lane is up: a
  # restart waits on it forever instead of finding the lane idle.
  child_pids=$(ps -axo ppid=,pid=,command= | awk -v p="$DPID" '$1 == p && $0 !~ /codex app-server/ {print $2}')
  kids=$(printf '%s\n' "$child_pids" | grep -c .)
  [ "$kids" = "0" ] && break                  # idle — safe to restart
  if [ "$ALLOW_BG" = "1" ]; then
    # Every live child is a detached background worker: the chat lane is idle,
    # and the workers outlive us. Restart now rather than in four hours.
    if [ "$(only_bg_children "$child_pids")" = "1" ]; then
      echo "[safe-restart] --allow-bg: chat lane idle, $kids detached worker(s) running, restarting over them (they survive; they lose steerability)" >&2
      break
    fi
  fi
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
