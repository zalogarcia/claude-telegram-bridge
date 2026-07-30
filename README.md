<div align="center">

# claude-telegram-bridge

**Talk to Claude Code on your own machine, from your phone, over Telegram.**

No tunnel. No webhook. No cloud relay. Your Mac (or Linux box) polls Telegram outbound —
nothing inbound ever reaches it.

[Install](#install) · [How it works](#how-it-works) · [Commands](#commands) · [Security](#security)

</div>

---

You're away from your desk. You remember the deploy is half-finished, or you want to
kick off a test run, or you just thought of something. You open Telegram and type it.
Claude Code runs it **on your machine**, in your repos, with your config and your
sessions — and answers you.

```
you ▸ what's failing in the checkout tests?
bot ▸ 🤖 Thinking… · 34s · 6 steps
      💻 Bash npm test -- checkout
      📖 Read src/checkout/validate.ts
      ✏️ Edit src/checkout/validate.ts
bot ▸ Two tests fail on the same cause: validateCart() returns early when
      items is empty, so the discount branch never runs. Fixed and re-ran —
      all 14 pass now.
```

## Why this exists

Claude Code is the best pair programmer available, and it's stuck on your desk.
Every "remote Claude" option asks you to expose a port, run a tunnel, or ship
your code to someone else's machine. This does none of that: it's ~2,000 lines
of Node that long-polls the Telegram Bot API and pipes messages into
`claude -p`. The only network traffic is your machine calling Telegram.

## Features

| | |
|---|---|
| 🔒 **No inbound network** | Long-polls Telegram. No tunnel, no open ports, no webhook, no third-party relay. |
| 💬 **Persistent sessions** | Ask something today, follow up tomorrow — same conversation. Survives restarts and reboots. |
| 🗂️ **Named, resumable chats** | `/rename` a conversation, `/chats` to list them, `/resume` to switch back. `/compact` summarizes a long one into a fresh chat. |
| 🌙 **Unlimited background workers** | Long jobs (`/goal`, `/autopilot`, test suites) run in *separate* Claude sessions. If a worker is busy, another spawns — parallel, never queued behind each other. |
| ➡️ **Mid-task steering** | Message while a task is running and it goes *into* the running task, exactly like typing mid-turn in Claude Code. |
| 📊 **Live progress** | Watch tool calls stream in as it works — including subagent activity, indented. |
| 🎙️ **Voice notes** | Talk instead of typing. Transcribed with Whisper, run as a prompt. |
| 📎 **Files & photos** | Send a screenshot with "why does this look broken?" — images, PDFs, code, anything ≤20MB. |
| ⏰ **Reminders & cron** | "Remind me at 8" or "every morning summarize yesterday's commits" — the second one actually runs. |
| 🩺 **Self-healing** | KeepAlive restarts crashes; a two-strike watchdog catches wedges and tells you it did. |
| 🎛️ **Full CLI access** | Your custom slash commands work. Switch models mid-conversation. Check usage. |

## Install

**Requirements:** [Claude Code](https://claude.com/claude-code), Node 18+, macOS (launchd)
or Linux (systemd). A Telegram account.

```bash
git clone https://github.com/zalogarcia/claude-telegram-bridge.git ~/claude-telegram-bridge
cd ~/claude-telegram-bridge
./install.sh
```

The installer checks prerequisites, walks you through creating a bot with
[@BotFather](https://t.me/botfather), auto-detects your chat ID, writes a
`config.json` (chmod 600), installs the service, and starts it. Then message your
bot `/help`.

Preview what it would do without touching anything:

```bash
./install.sh --dry-run
```

**Optional — voice notes:** `export OPENAI_API_KEY=…` (the bridge reads your shell
profile, since service managers don't). Without a key, voice notes are handed to
Claude as audio files instead.

**Optional but recommended — teach your sessions to use it:** copy the block in
[`templates/CLAUDE.md.example`](templates/CLAUDE.md.example) into your `CLAUDE.md`.
That's what makes the assistant hand long jobs to the background lane and manage
your reminders in plain English.

## How it works

```
   Telegram app (your phone)
            │  message / photo / voice note
            ▼
   Telegram Bot API  ◄────── long poll (outbound HTTPS from your machine)
            │
            ▼
   bridge.mjs  ── service manager keeps it alive, watchdog catches wedges
    │
    ├── 🤖 chat lane      claude -p --resume <sessionId>     always answerable
    └── 🌙 worker pool    bg1, bg2, bg3, … spawn on demand   long jobs + scheduled tasks
                          every worker: a fresh session      self-contained, then discarded
                                     │
                                     └── on completion → report goes to the CHAT lane,
                                         which summarizes it for you in plain words
```

**The lane split is the important part.** A headless Claude run occupies its
process until it finishes — so a 20-minute `/autopilot` would normally mean 20
minutes of silence. Long commands, anything prefixed `bg:`, scheduled tasks, and
assistant-initiated handoffs run in their own Claude session instead. You keep
chatting while they work.

The background pool is **unbounded**: every job that arrives while the pool is
busy spawns its own worker (`bg2`, `bg3`, …) rather than queueing. Workers are
**ephemeral** — each runs one self-contained task in a fresh session and is
cleaned up when it drains, so a worker never resumes (or pays for) the context of
an earlier job. They also get an hour-scale timeout rather than the chat lane's
30-minute ceiling: the lane exists for work measured in hours.

Jobs can also be handed off from a terminal with `node bg.mjs "<task>"`. For
anything longer than a line, use `node bg.mjs --file ./brief.md` instead — passing
a brief as a shell argument turns backticks inside it into command substitution,
so a brief mentioning `SomeName` or `npm run build` reaches the worker with those
terms silently replaced by empty strings.

When a background job finishes, its output is delivered **to the chat session, not
to you** — framed as untrusted worker data, capped at 6 consecutive reports so a
failing job can't loop forever. The assistant decides whether more work is needed,
then sends you a short human update. You get a colleague, not a log stream.

**Sessions** are per-lane and per-directory, stored in `state.json` and resumed
with `--resume`. `/cd` switches projects (and resets sessions, since Claude Code
sessions are project-scoped). Chat-lane sessions are also kept in a rolling
archive (last 60) so `/chats`, `/rename` and `/resume` can move between them.

**Messages sent mid-task are steered into the running run** over the CLI's
streaming-input mode — the same behavior as typing while Claude Code is working.
It either folds your message into the current turn or answers it right after.
Only when steering isn't possible (nothing running yet, run already finishing)
does the message queue instead.

## Commands

| Command | What it does |
|---|---|
| *any text* | Runs in the chat lane — steered into the running task if one is going, or a background worker if it looks long |
| *any other* `/command` | Passed straight to Claude Code — your custom commands work |
| photo / file | Saved to `inbox/` and handed to Claude; the caption is the instruction |
| voice note | Transcribed (Whisper) and run as a prompt |
| `/new [bg\|all]` | Fresh chat (Claude Code's `/clear`) — the old one is archived, not deleted |
| `/chats` | List recent chats: name, id prefix, age, directory, context size |
| `/rename <name>` | Name the current chat so you can find it again |
| `/resume <name\|id>` | Switch back to any archived chat (by name, name prefix, or id prefix) |
| `/compact` | Summarize this chat, archive it, and start fresh with the summary injected |
| `/cd <path>` | Switch working directory (must be under `$HOME`) |
| `/model [name]` | Show or set the model for future runs |
| `/context` | Session context size, your 5h and weekly plan limits (% used + time left), and token/cost totals ([ccusage](https://github.com/ryoppippi/ccusage)). The limits need [one line in your statusline](docs/statusline.md); everything else works out of the box |
| `/status` | Directory, session, model, and a live block per lane: elapsed, steps, current task, latest action |
| `/stop [bg\|all]` | Kill the running task and clear that lane's queue |
| `/restart` | Restart the daemon remotely |
| `/logs` | Tail the daemon log |
| `/remind …` | `daily HH:MM <text>` · `once [YYYY-MM-DD] HH:MM <text>` · `in 90m <text>` |
| `/schedules` · `/unschedule <id>` | List / remove scheduled entries |
| `/yolo on\|off` | Permission bypass (see [Security](#security)) |
| `/help` | All of the above, in Telegram |

Prefix `run:` on a reminder (or `--run` in the CLI) to make it **execute** as a
Claude task instead of just pinging you. Messages sent while a lane is busy are
steered into the running task; anything that can't be steered queues (max 5) and
runs in order.

`/compact` is the bridge's own implementation, not the interactive built-in: it
asks the current session for a handoff summary, archives that session, and opens
a fresh one primed with the summary. The interactive `/usage` screen has no
headless equivalent — `/context` covers it.

## Security

**Read this before installing.** This gives a Telegram chat the ability to run
code on your machine.

- **Single-owner by construction.** Every incoming update is checked against your
  chat ID before anything else happens — no reply, no download, no execution for
  anyone else. Strangers who find your bot get silence. Chat IDs come from
  Telegram's servers and can't be spoofed by a sender.
- **Your Telegram account is the key.** Anyone with access to your logged-in
  Telegram can run commands on your machine. Turn on two-step verification, review
  **Settings → Devices**, and consider a passcode lock on the app.
- **Permission mode.** The default is `--dangerously-skip-permissions`, because
  headless runs can't answer permission prompts — without it, commands outside
  your allowlist are silently denied and tasks half-fail. `/yolo off` (or
  `"yolo": "false"` in config.json) switches to `acceptEdits` if you'd rather have
  the friction. Understand what you're choosing.
- **The bot token** lives only in `config.json` (chmod 600, gitignored). It can't
  make your machine execute anything — the bridge only acts on messages from your
  chat — but someone holding it could read what you send the bot. Revoke via
  @BotFather if it leaks.
- **Untrusted content is fenced.** Background worker output is delivered inside
  explicit markers with instructions-inside-are-void framing, since a job that
  fetched a web page carries text you didn't write. This is defense in depth, not
  a sandbox — the usual prompt-injection caveats for autonomous agents apply.
- **Nothing leaves your machine** except the Telegram messages themselves (and
  voice-note audio, if you enable Whisper transcription).

## Operations

```bash
# logs
tail -f ~/Library/Logs/claude-telegram-bridge.log     # macOS
journalctl --user -u com.claude-telegram-bridge -f    # Linux

# restart (or just send /restart from Telegram)
launchctl kickstart -k gui/$(id -u)/com.claude-telegram-bridge
systemctl --user restart com.claude-telegram-bridge

# restart without killing an in-flight run — waits for idle first
# (use this after editing bridge.mjs while a task might be running)
./safe-restart.sh

# stop for real — the watchdog revives it otherwise
touch .bridge-paused && launchctl bootout gui/$(id -u)/com.claude-telegram-bridge

# one-shot test through the real message handler
node bridge.mjs --selftest "Reply with exactly: OK"

# unit tests for the render/format helpers (offline — never touches Telegram)
node test.mjs

# uninstall (add --purge to also delete config, state and schedules)
./uninstall.sh
```

**`config.json` options:** `model`, `effort` (empty = your CLI defaults),
`defaultCwd`, `claudeBin`, `yolo`, `ownerName`, `timeoutMs` (chat lane, default
30 min), `bgTimeoutMs` (background workers, default 8h — that lane is for
hour-scale jobs), `staleSec` (skip messages older than this — default 1h, so a
sleeping laptop doesn't wake to a backlog). Every key can be overridden with a
`BRIDGE_<UPPER_SNAKE>` environment variable.

## Caveats

- **Your machine must be awake.** Messages sent while it sleeps queue at Telegram
  and are skipped as stale if older than an hour.
- **20MB file limit** — a Telegram Bot API cap, not ours.
- **One task per lane.** The chat lane runs one at a time (extra messages steer
  into it or queue); background workers are unbounded and run in parallel.
  Internal work never gets dropped.
- **Only one poller per bot token.** Running a second instance causes Telegram 409s
  (the daemon backs off and recovers, but don't do it on purpose).
- Tested on macOS with Claude Code 2.x. The Linux/systemd path is included and
  structurally sound but less battle-tested — issues and PRs welcome.

## License

MIT — see [LICENSE](LICENSE).

*Not affiliated with Anthropic or Telegram. "Claude" and "Claude Code" are
trademarks of Anthropic.*
