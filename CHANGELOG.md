# Changelog

All notable changes to Leash. Dates are release dates.

## 1.5.0 (2026-09-04)

**Codex stops being a rescue path and becomes a peer engine, and every message the daemon writes
about itself gets one voice.**

### An engine per lane

- `/engine claude|codex` moves the chat lane; `/engine bg claude|codex` moves handed-off jobs. Bare
  `/engine` prints both lanes, where each value came from, the Codex model and effort in force, and
  the sandbox. `engine` in `config.json` sets the install default (`{"chat":..,"bg":..}`, or a bare
  `"codex"` for both), so a Codex-first user never types the command.
- A `codex:` or `claude:` prefix on any single message pins that one message, and
  `bg.mjs --engine <name>` does the same for one background job. Precedence is resolved in one
  place, so the notice, the handback and the run itself cannot disagree about why a job is where it
  is.
- **The daemon boots and serves with no `claude` binary on the machine.** `/status` says
  `claude NOT INSTALLED`, account rotation never runs, and the handful of commands whose subject IS
  a Claude session answer with one line instead of starting a session that cannot start.
- `/model` on a Codex chat lane sets the CODEX model and says so. `/codex model`, `/codex effort`,
  `/codex network on|off` and `/codex doctor` steer and check that engine directly.
- The chat lane keeps ONE Codex thread per chat, so a follow-up continues the conversation instead
  of paying to re-read the repo. `/new` starts a fresh one.

### Switching engines without losing the conversation

- Switching lanes used to drop the conversation: the incoming engine opened on "hello" while the
  outgoing one held every decision that had been made. A bounded, redacted handoff (goal, decisions,
  files touched, the open question) is now prepended to the incoming engine's first message as
  untrusted DATA, inside explicit markers.
- Five rungs, tried in order, so a switch never waits on an engine that may be walled: the engine
  being left writes it in one short capture turn; failing that the on-disk chat ring (the last ten
  turns of this chat, both engines, written by the daemon with no model call); then the ring without
  tool detail; then the bare goal line; then a labelled "nothing recorded yet".
- Everything stored and everything rendered goes through the same redaction pass `codex doctor`
  output does, twice: once before it is written, once before it is injected.
- The first Codex turn carrying a handoff runs with network access **off** by default
  (`codexHandoffNetwork`). `/engine codex fresh` skips the handoff; `/new` clears it and the ring.

### The Codex chat lane runs on `codex app-server`

- A message typed mid-turn is **steered into the running turn**, with the same ack the Claude lane
  sends. The bubble streams the tool steps, and the footer is `✅ Done · 12s · 3 steps`.
- `/stop` is a `turn/interrupt` the model acknowledges, not a SIGTERM. One child serves the whole
  daemon, so stopping one turn does not kill it.
- Thread ids are unchanged: `thread/resume` takes ids created by `codex exec`, so nothing in
  `state.json` needed migrating.
- The fallback is intact: an older CLI, `codexAppServer: false`, or two child deaths in a minute,
  and the lane runs one-shot on `codex exec` exactly as before, saying so once. Background jobs
  always use `codex exec`, because a background worker must outlive this daemon.

### One voice, and messages that finish what they start

- Every message the daemon writes about itself now comes from one family with one house style:
  icon, then label, then value; one fact per line; reference material behind an expandable
  blockquote. `/help` is an index rather than a wall, and `/status`, `/usage`, `/context`, `/new`,
  `/compact` and `/restart` all follow it.
- **A wait is ONE message that edits itself to a terminal state.** A background job is one message
  from dispatch, through a live line while it runs, to Done. `/restart` resolves the message it put
  up. A limit wall counts itself down every five minutes and resolves the moment it lifts.
  `progress: { background: false }` turns the live worker line off.
- `style: { noDashes: true }` rewrites em and en dashes out of every outbound reply on both engines,
  leaving code spans, fenced blocks and URLs alone. Off by default: the model keeps its own voice.
- A worker's full report is written to disk before anything is capped, and the handback carries an
  excerpt plus a pointer to the file, outside the untrusted-output markers.
- The daemon's own name comes from `name` in `config.json` (default `Leash`).

### Fixes

- A fenced code block longer than one Telegram message no longer loses its formatting: the chunker
  closes and reopens `<pre>` across the split.
- `/account` and `/usage` render the Codex block again (an aliased import had left one call site on
  the old name, which failed at call time and cached the account as unreadable).
- `BRIDGE_<UPPER_SNAKE>` environment overrides now work for the object- and boolean-valued keys,
  not just the scalar ones.

## 1.4.0 (2026-09-03)

**A running background worker can be corrected, and there is a second engine behind it.**

### Steering a running worker

Background workers used to close stdin at spawn, which made a dispatched job unreachable: the only
way to change its instructions was to kill it and re-dispatch, throwing away a context that had
already read the repo. Workers now hold stdin open for their whole run.

- `/steer <lane|runId|pid|latest> <text>` from Telegram, and `node bg.mjs steer <target> "<text>"`
  (or `--file <path>`) from a terminal, write one more instruction into a running worker.
- `node bg.mjs ps` prints what is running: run id, lane, pid, elapsed, steps, whether it can still
  be steered, how many steers it has taken, which engine, and the job title.
- The text arrives framed as a mid-run instruction, so a worker folds it into the job it is doing
  instead of treating it as a replacement brief. Whatever was steered in comes back in the report
  under a `STEERED IN` block, outside the untrusted-output markers, because it is the bridge's own
  record rather than the worker's claim about itself.
- `/status` now names each worker's run id and says whether it is steerable. A worker that survived
  a daemon restart is running but unreachable (the new daemon tails its log and holds no pipe), and
  those now appear in `/status` instead of the lane list reading "idle" over a multi-hour job.
- Briefs handed over through `bg.mjs` now carry a short LANE RULES preamble stating the facts a
  headless worker otherwise learns by being blocked, including that a steer may arrive mid-run. The
  daemon strips it back off before showing a brief in a notice, `ps` or `/status`.
- `safe-restart.sh --allow-bg` restarts as soon as the chat lane is idle rather than waiting hours
  for background work. The workers survive; they lose steerability until they finish.
- The socket is a local, unauthenticated filesystem socket (`steer.sock`) next to `bridge.mjs`,
  carrying two operations, `steer` and `ps`. It cannot start, stop or kill anything.

### Codex: a second engine, and a fallback for a walled account

Optional, and off the shelf: if OpenAI's Codex CLI is installed, Leash can run work on it. Without
the binary every path below answers with one line saying so, and nothing else changes.

- `/codex <question>` asks it read-only in the current directory; `/codex review [<repo>] [vs
  <branch>]` runs its own review harness over a diff; `/codex on|off` toggles the fallback.
- `node bg.mjs --engine codex --file <brief>`, or a `codex:` prefix, sends a whole job to it.
- While **every** enrolled Claude account is rate limited, a background job with no engine
  preference runs on Codex rather than waiting for the reset, and a chat message gets a Codex answer
  prefixed `[Codex fallback, Claude limited until HH:MM]` instead of silence. Claude slash commands
  still wait, because Codex cannot run one. Once the wall lifts those pairs are handed to the
  assistant as context, with an instruction not to answer them again.
- A Codex failure can never mark a Claude account limited, swap one, or re-fire anything on Claude,
  and Claude's limit handling never spawns Codex. The fallback cannot loop.
- Codex runs are registered, detached and file-backed exactly like a worker: they appear in
  `/status` and `bg.mjs ps` with `ENGINE: codex`, survive a daemon restart with their deadline
  re-armed, and `/stop codex` kills one. They are never steerable, because Codex reads its prompt
  once from stdin and never again.
- `/account` (and the new `/accounts` alias) shows the Codex account below the Claude ones: which
  login, the plan, both rate-limit windows with reset clocks, the credit balance, and what Codex has
  cost today and over the last seven days. Nothing in that path reads, prints or forwards a
  credential; `codex` finds its own auth in `~/.codex/auth.json`.
- Billing is your own OpenAI login, a ChatGPT subscription or an API key, and is entirely separate
  from your Anthropic plan.
- New optional config keys: `codexBin`, `codexTimeoutMs` (default 30 minutes, `0` disarms the
  deadline), `codexModel`. `install.sh` checks for the binary and only warns when it is absent.

### Under the hood

- Every run, background included, now gives its stdin pipe back on both terminal handlers, so a
  long-lived daemon cannot leak one file descriptor per run it has ever started.
- New modules, each with its own suite: `bg-steer.mjs`, `bg-lane-rules.mjs`, `bg-codex.mjs`,
  `codex-account.mjs`. Suite total is 484 assertions across 11 files to 763 across 16, plus a probe
  (`scripts/probes/steer-probe.mjs`) that drives a steer end to end into a fake worker with no model
  spend.
- A handed-over job now runs in the repo its BRIEF names rather than wherever the chat happens to be
  pointed. `--sandbox workspace-write` is rooted at one directory, so a job about repo X that ran in
  repo Y either could not do its work or would edit same-named files in the wrong tree.
  `bg-lane-rules.mjs` gained `briefRepo`, which reads the workspace root from config instead of
  assuming one.
- The rate-limit fallback refuses a Claude slash command on the `bg.mjs` path too, not only on the
  `bg:` one. `/autopilot` reached Codex as a literal prompt with write access; it now waits for the
  reset, and the handoff notice says that is why it is sitting still.
- A Codex run adopted from a previous daemon is only ever signalled while it is still alive, checked
  again when its re-armed deadline fires and released when it reports. A pid is a reusable number,
  and a stale registry entry could otherwise SIGTERM whatever inherited it.
- `codexParkedNote` clips both halves of a parked pair. A wall parks up to ten of them, and a
  `--file` brief and a Codex report are each large enough that ten of both went into one prompt the
  moment the wall lifted.

## 1.3.0 (2026-09-03)

**Renamed to Leash.** The project keeps every behaviour it had; only the name changes. "Claude
telegram bridge" described the plumbing rather than the thing you actually use, and it could not be
said out loud without sounding like an internal tool. Leash names what the product does: the agents
run as far as you send them, you keep hold of the end of the line, and off-leash is the autonomous
background mode where a worker goes and finishes a whole job on its own.

- The README, the docs and the bot's own help, status and startup text now say Leash.
- New brand artwork lives in `docs/assets/`, and the README leads with it.
- **Nothing on disk was renamed.** The service label `com.claude-telegram-bridge`, the default
  clone directory `~/claude-telegram-bridge`, the log file, `config.json`, `accounts.json`, the
  `BRIDGE_*` environment variables and `bridge.mjs` itself all keep their existing names. Upgrading
  changes no paths and no configuration: pull, and carry on.
- Those internal names are expected to migrate in a later release, with an upgrade path. Renaming
  them now would break every install that exists.
- Once the GitHub repository is renamed, old clone URLs keep working through GitHub's own redirect,
  so existing checkouts and any script that clones the old path are unaffected.

## 1.2.1 (2026-09-01)

**Account swaps work again once you have a few MCP servers connected.** The credential blob in the
macOS Keychain holds your per-machine MCP server tokens alongside your login, and `security` refuses
to accept more than about 4096 characters through the path the bridge was using. Adding a couple of
MCP servers pushed the blob past that, and from then on every swap was refused with "credential
write failed; the previous account is still active and nothing changed" (correctly: nothing was
damaged, but nothing could be switched either).

- Large credential blobs are now written through a second `security` path that has no such limit,
  so a swap succeeds whatever your MCP servers add up to. Blobs that fit the old path still use it.
- Your MCP server tokens still survive every swap untouched, which is the whole reason the blob is
  that big.
- The refusal that protects you from a truncated write is still there, now at a ceiling about 17x
  larger than the blob that broke it, and it still refuses before touching anything.

## 1.2.0 (2026-09-01)

**Multi-account switcher.** For people who hold more than one Claude subscription (a personal one
and a work one, say), the bridge can now switch which login background workers run as. Credentials
never leave your machine.

- `/account`: every enrolled account with live usage bars, reset clocks and time left, plus
  one-tap inline buttons to swap accounts or capture the current login. The no-argument form is
  strictly read-only.
- `/usage`: the full picture per account: 5-hour and weekly windows, percent used, a usage bar,
  reset time in your local timezone and time remaining, per-model scoped windows where present.
- `/status` now names the active account with its usage on one line.
- Automatic rotation: when a background worker dies on a session limit, the bridge switches new
  workers to the enrolled account with headroom and tells you it did.
- Cross-platform credential store: the macOS Keychain backend is battle-tested; the
  `~/.claude/.credentials.json` backend for Linux and Windows is new and less proven. Treat your
  first swap on a non-Mac as a test.
- Safety was most of the engineering, and every rule below exists because its absence caused a
  real incident during development:
  - a credential write that fails or reads back wrong is rolled back to the previous login, never
    left half-written
  - oversized keychain payloads are refused before anything is touched (macOS `security` silently
    truncates past ~4096 characters)
  - credentials are only ever saved into an account slot whose identity is proven (token
    fingerprint or profile email); anything unidentifiable is parked, shown in `/account`, and
    claimable, never written over another account
  - before the first swap ever writes, your live login is backed up once to
    `accounts.backup.json` (0600, never overwritten)
  - your per-machine MCP server tokens survive every swap untouched
- Setup: log into an account, send `/account capture <name>`, repeat per account. See
  `docs/multi-account.md`.

## 1.1.1 (2026-08-31)

- Long code blocks now split cleanly across Telegram messages. Previously a fence longer than one
  message left unbalanced tags and Telegram degraded exactly the replies most worth reading to
  plain text.
- A background worker that dies on a fatal error (expired login, bad API key) now reports
  ❌ failed with the reason instead of a green check.

## 1.1.0 (2026-08-07)

- Tables, collapsible sections and quotes render properly in Telegram instead of as raw markdown.
- Background workers survive the daemon dying: a restart re-attaches running jobs, and jobs that
  died while the daemon was down are reported instead of vanishing.
- `/context` shows your Claude plan limits (5-hour and weekly windows).
- `bg.mjs --file <brief>`: hand a long task to a background worker from a file, so shell quoting
  cannot mangle it.

## 1.0.0 (2026-07-28)

- Baseline public release: Telegram bridge to Claude Code with background worker lanes, schedules,
  markdown rendering (tables as titled blocks), and clipped messages marked with an ellipsis
  instead of looking broken.
