#!/usr/bin/env bash
# Interactive installer for Leash.
# Creates config.json, installs the background service, and starts it.
#
#   ./install.sh              interactive
#   ./install.sh --dry-run    show what would happen, change nothing
#
# Non-interactive (CI / scripted):
#   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… ./install.sh --yes

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="${BRIDGE_SERVICE_LABEL:-com.claude-telegram-bridge}"
WATCHDOG_LABEL="$LABEL.watchdog"
CONFIG="$DIR/config.json"
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --help|-h) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

echo
bold "Leash — installer"
echo

# ---------- 1. prerequisites ----------
bold "1. Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node not found. Install Node 18+ (https://nodejs.org)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $(node -v)). fetch/FormData need it."
ok "node $(node -v)"

CLAUDE_BIN="${BRIDGE_CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  for c in "$HOME/.local/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do
    [ -x "$c" ] && CLAUDE_BIN="$c" && break
  done
  [ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$(command -v claude || true)"
fi
[ -n "$CLAUDE_BIN" ] || die "claude CLI not found. Install Claude Code first: https://claude.com/claude-code"
ok "claude at $CLAUDE_BIN"

command -v curl >/dev/null 2>&1 || die "curl not found."
command -v jq   >/dev/null 2>&1 || warn "jq not found — the watchdog can't send Telegram alerts without it (brew install jq)."

OS="$(uname)"
case "$OS" in
  Darwin) ok "macOS — will install a LaunchAgent" ;;
  Linux)  command -v systemctl >/dev/null 2>&1 \
            && ok "Linux — will install a systemd user service" \
            || warn "Linux without systemd — you'll need to run 'node bridge.mjs' yourself" ;;
  *) warn "Unrecognized OS ($OS) — config will be written, service install skipped" ;;
esac
echo

# ---------- 2. credentials ----------
bold "2. Telegram credentials"

EXISTING_TOKEN=""; EXISTING_CHAT=""
if [ -f "$CONFIG" ] && command -v jq >/dev/null 2>&1; then
  EXISTING_TOKEN=$(jq -r '.botToken // empty' "$CONFIG")
  EXISTING_CHAT=$(jq -r '.chatId // empty' "$CONFIG")
fi
# Convenience: reuse creds already kept for other Claude Code tooling.
SETTINGS="$HOME/.claude/settings.local.json"
if [ -z "$EXISTING_TOKEN" ] && [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  EXISTING_TOKEN=$(jq -r '.env.TELEGRAM_BOT_TOKEN // empty' "$SETTINGS")
  EXISTING_CHAT=$(jq -r '.env.TELEGRAM_CHAT_ID // empty' "$SETTINGS")
  [ -n "$EXISTING_TOKEN" ] && ok "found credentials in ~/.claude/settings.local.json"
fi

TOKEN="${TELEGRAM_BOT_TOKEN:-$EXISTING_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID:-$EXISTING_CHAT}"

if [ -z "$TOKEN" ] && [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  cat <<'EOS'
  Create a bot (30 seconds):
    1. Open Telegram and message @BotFather
    2. Send /newbot and follow the prompts
    3. Copy the token it gives you (looks like 123456789:AAF...)

EOS
  printf '  Bot token: '
  read -r TOKEN
fi
[ -n "$TOKEN" ] || die "no bot token given."

if [ -z "$CHAT_ID" ] && [ "$DRY_RUN" = 0 ]; then
  echo
  echo "  Now send your bot ANY message in Telegram (say 'hi'), then press Return."
  [ "$ASSUME_YES" = 0 ] && read -r _
  CHAT_ID=$(curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates" \
    | sed -n 's/.*"chat":{"id":\(-\?[0-9]*\).*/\1/p' | head -1)
  [ -n "$CHAT_ID" ] || die "couldn't detect your chat id — message the bot first, then re-run."
  ok "detected chat id $CHAT_ID"
fi
[ -n "$CHAT_ID" ] || die "no chat id."

# Verify the token actually works before we install anything.
if [ "$DRY_RUN" = 0 ]; then
  BOT_NAME=$(curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
  [ -n "$BOT_NAME" ] || die "Telegram rejected that token."
  ok "authenticated as @${BOT_NAME}"
fi
echo

# ---------- 3. config ----------
bold "3. Writing config"

DEFAULT_CWD="${BRIDGE_DEFAULT_CWD:-$( [ -d "$HOME/dev" ] && echo "$HOME/dev" || echo "$HOME" )}"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] would write $CONFIG"
else
  umask 077   # the token lives here — owner-readable only
  cat > "$CONFIG" <<EOF
{
  "botToken": "$TOKEN",
  "chatId": "$CHAT_ID",
  "defaultCwd": "$DEFAULT_CWD",
  "claudeBin": "$CLAUDE_BIN",
  "model": "",
  "effort": "",
  "yolo": "true",
  "ownerName": "the owner",
  "timeoutMs": 1800000,
  "bgTimeoutMs": 28800000,
  "staleSec": 3600
}
EOF
  chmod 600 "$CONFIG"
  ok "wrote $CONFIG (chmod 600)"
  ok "default working directory: $DEFAULT_CWD"
fi
echo

# ---------- 4. service ----------
bold "4. Installing the background service"

if [ "$OS" = "Darwin" ]; then
  LOG="$HOME/Library/Logs/claude-telegram-bridge.log"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  WPLIST="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"
  NODE_BIN="$(command -v node)"
  PATH_LINE="$(dirname "$CLAUDE_BIN"):$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] would write $PLIST and $WPLIST, then bootstrap both"
  else
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/bridge.mjs</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$PATH_LINE</string>
        <key>HOME</key><string>$HOME</string>
    </dict>
</dict>
</plist>
EOF
    cat > "$WPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$WATCHDOG_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$DIR/watchdog.sh</string>
    </array>
    <key>StartInterval</key><integer>300</integer>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/claude-telegram-bridge-watchdog.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/claude-telegram-bridge-watchdog.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$PATH_LINE</string>
        <key>HOME</key><string>$HOME</string>
        <key>BRIDGE_SERVICE_LABEL</key><string>$LABEL</string>
    </dict>
</dict>
</plist>
EOF
    ok "wrote $PLIST"
    ok "wrote $WPLIST"
    rm -f "$DIR/.bridge-paused"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$WATCHDOG_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$WPLIST"
    sleep 3
    if launchctl list | grep -q "$LABEL$"; then
      ok "service running"
    else
      die "service failed to start — check $LOG"
    fi
  fi

elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] would write $UNIT_DIR/$LABEL.service (+ watchdog timer) and enable them"
  else
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$LABEL.service" <<EOF
[Unit]
Description=Leash (Claude Code on Telegram)
After=network-online.target

[Service]
Type=simple
ExecStart=$(command -v node) $DIR/bridge.mjs
Restart=always
RestartSec=30
Environment=PATH=$(dirname "$CLAUDE_BIN"):/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
    cat > "$UNIT_DIR/$WATCHDOG_LABEL.service" <<EOF
[Unit]
Description=Leash watchdog

[Service]
Type=oneshot
Environment=BRIDGE_SERVICE_LABEL=$LABEL
ExecStart=/bin/bash $DIR/watchdog.sh
EOF
    cat > "$UNIT_DIR/$WATCHDOG_LABEL.timer" <<EOF
[Unit]
Description=Run the Leash watchdog every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$LABEL.service"
    systemctl --user enable --now "$WATCHDOG_LABEL.timer"
    ok "systemd user service enabled and started"
    warn "run 'loginctl enable-linger $USER' so it survives logout"
  fi
else
  warn "no supported service manager — start it manually: node $DIR/bridge.mjs"
fi
echo

# ---------- 5. done ----------
bold "Done."
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry run — nothing was changed)"
else
  echo "  Open Telegram and send your bot /help — it should answer."
  echo
  echo "  Optional next steps:"
  echo "    • Voice notes: export OPENAI_API_KEY=…  (Whisper transcription)"
  echo "    • Teach your Claude sessions to use it: see templates/CLAUDE.md.example"
  echo "    • Logs:  tail -f ~/Library/Logs/claude-telegram-bridge.log"
fi
echo
