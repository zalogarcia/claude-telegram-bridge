# Multiple Claude accounts

Leash can hold credentials for more than one Claude subscription and switch
which one Claude Code runs as. This page is the full detail behind the
[README section](../README.md#multiple-claude-accounts).

**What this is:** a multi-account *switcher* for people who legitimately hold
more than one Claude subscription — a personal plan and a work plan, a plan per
client, whatever your situation is. Each account keeps exactly the limits its
plan comes with. What the switcher buys you is that when one subscription is
rate limited until its reset, work can continue on another subscription you own
instead of stalling until you notice.

**What this is not:** a way to exceed anyone's plan limits, share accounts, or
use subscriptions you don't hold.

## How a swap works

A usage limit does not invalidate credentials: when an account hits its session
limit, its OAuth tokens stay valid — the account is simply rate limited until
its reset time. So a swap is **not a login**. It is writing a different token
blob into the place Claude Code reads credentials from:

- **macOS** — the Keychain (generic password, service `Claude Code-credentials`).
- **everywhere else** — `~/.claude/.credentials.json` (mode 0600), which is
  Claude Code's own credential file on those platforms.

The blob has two top-level keys that matter:

| key | what it is | what a swap does with it |
|---|---|---|
| `claudeAiOauth` | THE ACCOUNT: access + refresh token, expiry, plan tier | replaced — this *is* the swap |
| `mcpOAuth` | this machine's MCP server tokens (per-machine, **not** per-account) | preserved byte for byte, always |

Swapping the whole blob would wipe your MCP logins on every rotation, so the
swap replaces exactly one key and carries everything else through untouched.
There is a unit test for this property and it is the single most load-bearing
one in the module.

Every swap is **capture-then-swap**: before installing the incoming account, the
outgoing account's *live* tokens are re-banked into its slot in `accounts.json`.
A running session refreshes its own tokens, and a refresh rotates the refresh
token — banking the live blob first is what keeps the outgoing account usable
the next time its turn comes.

## Commands

| command | does |
|---|---|
| `/account` | read-only view: which account is live, each slot's headroom bars, limit state, one-tap swap buttons |
| `/account <name>` | swap to that slot |
| `/account capture <name>` | bank the CURRENT login into a slot (setup, once per account) |
| `/usage` | the full diagnostic view: 5h block + weekly window for every slot, with token fingerprints |

The buttons under `/account` are owner-only (any other Telegram user's tap is
refused), double-checked against both a digest of the slot name and the
button's own caption, and refuse to swap into a slot that is rate limited or
has no captured credentials.

## Automatic rotation

When a run dies with a session-limit message in its failure output, whether it
is a **chat message** or a **background worker**, Leash:

1. marks the active account limited until the reset time parsed from the
   message (or a stated one-hour guess if it can't be parsed),
2. swaps to the least-recently-used enrolled account that isn't limited,
3. tells you in one message, and hands the worker's report to the chat lane
   with the rotation noted.

Two guards keep a limit wall from eating the whole rotation: a 90-second
**cooldown** (several workers dying on the same wall trigger one rotation, not
several), and a **pause** when every account is limited (one message with the
earliest reset, then the rotation stands down instead of thrashing).

Workers that are already running are never killed by a swap — they keep their
in-memory session. Only new workers pick up the new account. The corollary is a
small residual race: a still-running worker on the old account can refresh its
token and write the old account's blob back over the swap. A **drift guard**
re-checks every 60 seconds and re-asserts the intended account when that
happens — and when it finds credentials it cannot identify (say you ran
`claude /login` by hand), it never overwrites them: your login always wins.

### When every account is limited: the Codex fallback

The pause above is the honest end of what a *Claude* multi-account setup can do:
every subscription you own is walled, so there is nothing left to rotate to, and
work waits for the earliest reset.

If you also have OpenAI's Codex CLI installed, Leash has one more move, on
billing that has nothing to do with Anthropic. While the pause is in effect:

- a background job handed over with no engine preference runs on **Codex**
  instead of waiting for the reset (a Claude slash command like `/autopilot` is
  the exception and still waits, because Codex cannot run one);
- a message you type gets a Codex answer prefixed
  `[Codex fallback, Claude limited until HH:MM]`, so a walled account is a
  degraded answer rather than silence;
- when the wall lifts, the assistant is handed those question and answer pairs as
  context, with an explicit instruction not to answer them a second time.

The two engines are deliberately isolated from each other: a Codex failure can
never mark a Claude account limited, swap one, or re-fire anything on Claude.
The Claude rotation above retries a chat message once on the next account;
only when every account is walled does it hand that one message to Codex, and
nothing bounces back. That is what stops a failing job bouncing between them.

`/codex off` disables the automatic half (on-demand `/codex` still works);
`/codex on` re-enables it; `/account` shows the Codex login, its own two
rate-limit windows and what it has cost, below the Claude rows. Codex is
entirely optional: with no binary installed, none of this exists and everything
above is unchanged. Full grammar in the
[README](../README.md#codex-second-engine-and-fallback).

## The sharpest edge: refresh-token rotation

When an access token is refreshed, Anthropic **rotates the refresh token**. The
old refresh token dies the moment the new one is issued. A rotated token that
is not persisted = that account is locked out until you log in by hand.

Everything in the design exists to make that outcome unreachable:

- **Persist before use.** A refreshed token is written to `accounts.json`
  (atomically, 0600) *before* it is used for anything. If the write fails, the
  account is reported broken — loudly — rather than shown a usage number.
- **Never refresh the live account.** The running Claude Code session owns the
  live account's tokens and refreshes them itself; Leash reads the live
  token from the credential store and never races the session.
- **Refresh idle accounts at most once per read**, and only when the access
  token has actually expired. No retry loops — a second attempt would burn a
  second refresh token on the same failure.
- **Capture-then-swap** (above) banks the outgoing account's latest rotation
  before every swap.

If it ever happens anyway (a slot captured weeks ago whose refresh token
expired while Leash was off, for example): log into that account normally,
then `/account capture <name>`. That banks the fresh tokens and the slot is
healthy again.

## Guardrails

- **A write that can't be verified is rolled back.** After every credential
  write Leash reads the store back and compares fingerprints; a write that
  didn't land, or landed corrupted, gets the previous credentials restored, and
  the error message tells you which of the two actually happened — it never
  claims "nothing changed" on faith.
- **One-time backup.** Before the first credential write Leash ever
  performs on a machine, the live blob is copied to `accounts.backup.json`
  (0600, gitignored, never overwritten). If a write corrupts the store AND the
  rollback fails — the worst case — that file's `blob` key is your pre-existing
  login, and the failure message points at it.
- **macOS payload-size handling.** The preferred Keychain write rides one
  `security -i` line with a measured ~4096-character limit; past it the stored
  item is silently truncated. Blobs that fit ride that line, so the token never
  enters `argv`. Blobs that do not (your MCP server tokens share the blob, and
  a few servers are enough to outgrow it) go through
  `security add-generic-password -X`, which has no line limit; the payload is
  visible in `ps` for the length of that one call, which is why it is the
  fallback and not the default. Past what even that can carry, the write is
  refused *before touching anything*. The file backend has no such cliff: its
  writes go to a temp file and land via an atomic rename, so the credentials
  file is never half-written.
- **Unidentified credentials are parked, never guessed at.** A credential blob
  Leash cannot attribute (by token match or by Anthropic's profile
  endpoint) is parked in `accounts.unclaimed.json` rather than banked into a
  named slot — banking someone's fresh login under the wrong name is how a
  later swap delivers the wrong account. `/account` shows a warning line while
  anything is parked; capturing the matching account claims it.
- **Tokens are never printed.** Not in replies, logs, or error text. The only
  rendering anywhere is a 6-character fingerprint (`a…AAAAAA/r…BBBBBB`) —
  enough to tell slots apart, useless to a shoulder-surfer or a log reader.
  On macOS the token payload rides stdin, hex-encoded, so it does not appear in
  `ps` at all, except for the oversized-blob fallback described above, where it
  is in `argv` for the duration of one `security` call.

## Privacy

Credentials never leave your machine. Leash's only network calls for this
feature are to Anthropic's own OAuth endpoints (`/api/oauth/usage`,
`/api/oauth/profile`, and the token refresh endpoint), authenticated with your
own tokens. Nothing is sent to Telegram except the rendered views — which, per
the rule above, contain fingerprints, never tokens.

## Platform support, honestly

The macOS Keychain path is the battle-tested one — it runs in production on the
private sibling of this repo daily. The non-macOS path
(`~/.claude/.credentials.json`) implements exactly the same interface with an
atomic 0600 file write and is covered end to end by the test suite
(`credential-store.test.mjs`, `accounts.test.mjs`), but it has had **less
real-world mileage against an actual Linux/Windows Claude Code install**. It
should work; treat the first swap on such a machine as a test, run it at a
moment where a manual `claude /login` would be an acceptable recovery, and
please file an issue with what you find either way.

## Files

| file | what | committed? |
|---|---|---|
| `accounts.json` | the enrolled slots (real tokens) | **never** — gitignored, 0600 |
| `accounts.backup.json` | one-time pre-existing credential backup | **never** — gitignored, 0600 |
| `accounts.unclaimed.json` | parked unidentified credentials, if any | **never** — gitignored, 0600 |
| `accounts.example.json` | the shape, with fake values | yes |
| `accounts.mjs`, `account-usage.mjs`, `account-buttons.mjs`, `credential-store.mjs` | the logic (no secrets) | yes |
