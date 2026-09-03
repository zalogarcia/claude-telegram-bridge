# Changelog

All notable changes to Leash. Dates are release dates.

## 1.3.0 (2026-09-03)

**Renamed to Leash.** The project keeps every behaviour it had; only the name changes. "Claude
telegram bridge" described the plumbing rather than the thing you actually use, and it could not be
said out loud without sounding like an internal tool. Leash names what the product does: the agents
run as far as you send them, you keep hold of the end of the line, and off-leash is the autonomous
background mode where a worker goes and finishes a whole job on its own.

- The README, the docs and the bot's own help and log text now say Leash.
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
