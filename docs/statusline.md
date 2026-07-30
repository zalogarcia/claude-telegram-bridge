# Showing your plan limits in `/context`

`/context` reports two kinds of number:

- **Token counts and API-equivalent cost** — read from your local Claude Code transcripts via [ccusage](https://github.com/ryoppippi/ccusage). These work out of the box.
- **Your actual plan limits** — the "5h 37% · 3h49m left" and weekly figures that Claude Code shows in its terminal footer. These need one line of setup.

## Why the setup is needed

Claude Code hands the rate-limit block to your **statusline command's stdin** and nowhere else. There is no CLI for it and no state file on disk. A bridge run is headless — it has no statusline — so it cannot ask for those numbers itself.

The fix is to have your statusline cache what it already receives. The bridge reads the cache.

## Setup

Add this to your statusline script (`statusLine.command` in `~/.claude/settings.json`), near the top where `$input` is still the raw stdin JSON:

```bash
input=$(cat)   # you almost certainly have this line already

# Cache the rate-limit block so headless tools (the Telegram bridge's /context)
# can show the same limits this footer does.
mkdir -p "$HOME/.claude/cache"
printf '%s' "$input" | jq -c --argjson now "$(date +%s)" \
  '{captured_at:$now, rate_limits:.rate_limits}' \
  > "$HOME/.claude/cache/rate-limits.json.tmp" \
  && mv -f "$HOME/.claude/cache/rate-limits.json.tmp" "$HOME/.claude/cache/rate-limits.json"
```

Requires `jq`. Write via a temp file and `mv` so `/context` can never read a half-written cache.

That's it. The next time any interactive Claude Code session renders its footer, the cache appears and `/context` starts reporting limits.

To cache somewhere else, point the bridge at it with `BRIDGE_RATE_LIMIT_CACHE=/path/to/rate-limits.json`.

## How fresh is it?

`resets_at` is an **absolute** timestamp, so **"time left" is always exact** no matter how old the cache is. Only the **percentage** can be stale — it's whatever your last terminal render saw. `/context` always states the age of the read ("Limits read from the terminal footer 12m ago") so a stale percentage can't quietly mislead you.

If you keep an interactive session open, it refreshes constantly. If you haven't opened a terminal in hours, expect the percentage to lag.

## Without the cache

`/context` degrades cleanly. It falls back to ccusage's own 5-hour block clock — which is derived from your transcripts (block start + 5h), **not** your plan's real reset — and labels it `(limit % unavailable)`.

## What it does NOT do

No Anthropic account API is called, nothing is sent anywhere, and no credentials are involved. The cache is a local file holding two percentages and two reset timestamps.
