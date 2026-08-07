// Plan limits, token counts and context windows — the numbers behind /context.
//
// SHARED MODULE — byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. It hardcodes no binary and no path:
// `execJson` takes the command and its arguments from the caller, and
// `readRateLimits` takes the cache file to read. A deployment that gets its
// usage numbers from somewhere else changes its call sites, not this file.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Run a command that prints JSON and resolve its parsed output, or null.
// Never rejects: every caller here is decorating a status message, and a
// missing usage number must degrade to "unavailable" rather than take down the
// reply that carries it. `cmd`/`args` are the caller's — nothing about which
// tool produces the numbers belongs in this module.
export function execJson(cmd, args, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env } }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

export function fmtTokens(n) {
  if (n == null) return 'n/a';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// Plan-limit % + reset clocks, as shown in the Claude Code terminal footer.
// Claude Code feeds those numbers to the statusline command's stdin and nowhere
// else — no CLI, no state file — and a headless bridge run has no statusline, so
// this can only work if a statusline script caches them somewhere. `cachePath`
// is that somewhere, supplied by the caller.
//
// resets_at is an absolute epoch, so "time left" stays exact however old the
// read is; only the % can be stale, which is why callers surface the age.
export function readRateLimits(cachePath) {
  try {
    const j = JSON.parse(readFileSync(cachePath, 'utf8'));
    return j?.rate_limits ? j : null;
  } catch {
    return null;
  }
}

// Matches the footer's units: hours+minutes under a day, days+hours over.
// `resetsAt` is epoch SECONDS — feeding it milliseconds reads as far-future,
// not as expired, which is the bug this unit contract exists to make loud.
export function fmtLeft(resetsAt) {
  const mins = Math.round((Number(resetsAt) * 1000 - Date.now()) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return 'now';
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// "37% used · 3h49m left" — either half is omitted if the window lacks it.
export function fmtLimit(win) {
  if (!win) return null;
  const bits = [];
  if (typeof win.used_percentage === 'number') bits.push(`${Math.round(win.used_percentage)}% used`);
  if (win.resets_at) bits.push(`${fmtLeft(win.resets_at)} left`);
  return bits.length ? bits.join(' · ') : null;
}

// Context window by model family. Fable/Opus/Sonnet 5 run 1M by default
// (per platform docs, verified 2026-07-24); Haiku and unknowns assume 200k.
export function modelWindow(name) {
  const n = (name || '').toLowerCase();
  if (/fable|mythos|opus|sonnet/.test(n)) return 1_000_000;
  return 200_000;
}
