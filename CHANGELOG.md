# Changelog

All notable changes to the Claude Telegram bridge. Dates are release dates.

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
