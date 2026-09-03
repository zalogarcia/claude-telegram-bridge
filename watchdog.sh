#!/bin/bash
# Watchdog for Leash: if the daemon's heartbeat file goes stale
# (process wedged — a plain crash is already covered by KeepAlive/Restart), the
# service is restarted and you get a Telegram notification.
#
# Two-strike: one stale observation earns a grace tick (wake-from-sleep and slow
# media downloads self-heal); a restart needs two CONSECUTIVE stale checks close
# together in time — a strike older than 2 intervals is itself stale and resets,
# so an isolated blip hours ago can't arm a restart.
#
# Deliberate shutdown: `touch .bridge-paused` BEFORE stopping the service, or
# this script resurrects it within ~5 minutes. Remove the file to re-arm.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HB="$DIR/heartbeat"
STRIKE="$DIR/.watchdog-strike"
PAUSED="$DIR/.bridge-paused"
FAILS="$DIR/.watchdog-fails"
CONFIG="$DIR/config.json"
LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUI="gui/$(id -u)"
MAX_AGE=240      # Leash writes the heartbeat every poll iteration AND per update
STRIKE_TTL=700   # ~2x the 300s check interval
MAX_FAILS=3      # after this many failed restarts, stop paging on every tick

log() { echo "$(date '+%F %T') $*"; }
mtime() {
  if [ "$(uname)" = "Darwin" ]; then stat -f %m "$1" 2>/dev/null || echo 0
  else stat -c %Y "$1" 2>/dev/null || echo 0; fi
}

if [ -f "$PAUSED" ]; then
  rm -f "$STRIKE"   # paused on purpose — never carry a strike across the pause
  exit 0
fi

now=$(date +%s)
mt=$(mtime "$HB")
age=$((now - mt))

if [ "$age" -le "$MAX_AGE" ]; then
  rm -f "$STRIKE" "$FAILS"
  exit 0
fi

# Strike bookkeeping: only a RECENT strike counts as the first of two.
strike_at=$(cat "$STRIKE" 2>/dev/null || echo 0)
case "$strike_at" in ''|*[!0-9]*) strike_at=0 ;; esac
if [ "$strike_at" -eq 0 ] || [ $((now - strike_at)) -gt "$STRIKE_TTL" ]; then
  echo "$now" > "$STRIKE"
  log "heartbeat ${age}s stale — first strike, waiting one tick"
  exit 0
fi
rm -f "$STRIKE"

restarted=0
if [ "$(uname)" = "Darwin" ]; then
  if launchctl kickstart -k "$GUI/$LABEL" 2>/dev/null; then
    restarted=1
  elif [ -f "$PLIST" ] && launchctl bootstrap "$GUI" "$PLIST" 2>/dev/null; then
    restarted=1
  fi
else
  systemctl --user restart "$LABEL" 2>/dev/null && restarted=1
fi

# Confirm recovery instead of assuming it: give the daemon a moment to write.
sleep 15
new_mt=$(mtime "$HB")

if [ "$new_mt" -gt "$mt" ]; then
  rm -f "$FAILS"
  outcome="restarted and recovered (heartbeat was ${age}s stale)"
  emoji="🐶"
else
  fails=$(cat "$FAILS" 2>/dev/null || echo 0)
  case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
  fails=$((fails + 1))
  echo "$fails" > "$FAILS"
  outcome="restart attempt #$fails did NOT recover (service restart ok=$restarted, heartbeat still ${age}s stale) — check the Leash log"
  emoji="🚨"
  if [ "$fails" -gt "$MAX_FAILS" ]; then
    log "$outcome (suppressing further alerts)"
    exit 0
  fi
fi

log "$outcome"

# Notify via Telegram. Credentials come from config.json (or the environment).
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT="${TELEGRAM_CHAT_ID:-}"
if [ -z "$TOKEN" ] && command -v jq >/dev/null 2>&1 && [ -f "$CONFIG" ]; then
  TOKEN=$(jq -r '.botToken // empty' "$CONFIG" 2>/dev/null)
  CHAT=$(jq -r '.chatId // empty' "$CONFIG" 2>/dev/null)
fi
[ -n "$TOKEN" ] && [ -n "$CHAT" ] || exit 0

# The token goes in a config file on stdin, never argv (argv is world-readable).
printf 'url = "https://api.telegram.org/bot%s/sendMessage"\ndata-urlencode = "chat_id=%s"\ndata-urlencode = "text=%s Watchdog: %s"\n' \
  "$TOKEN" "$CHAT" "$emoji" "$outcome" | curl -s --config - >/dev/null
