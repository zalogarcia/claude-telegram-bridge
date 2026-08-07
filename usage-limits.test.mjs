#!/usr/bin/env node
// Tests for usage-limits.mjs — the /context numbers.
//
// SHARED TEST — byte-identical in the public and private bridge repos, like the
// module it covers. It never reads the real rate-limit cache and never runs the
// real usage CLI: the cache path is a parameter, so fixtures go in a mkdtemp
// directory, and execJson is exercised with `node -e`, which is deterministic
// and needs no network.
//
//   node usage-limits.test.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execJson, fmtTokens, readRateLimits, fmtLeft, fmtLimit, modelWindow } from './usage-limits.mjs';

const M = { execJson, fmtTokens, readRateLimits, fmtLeft, fmtLimit, modelWindow };

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};

const TMP = mkdtempSync(path.join(tmpdir(), 'usage-limits-test-'));

// ---------- plan-limit rendering ----------
// resets_at arrives as absolute epoch SECONDS (that's what a statusline script
// subtracts `date +%s` from); reading it as ms would print "now" forever.
const inSec = (s) => Math.floor(Date.now() / 1000) + s;

await t('fmtLeft matches the footer units: h+m short, d+h long', () => {
  eq(M.fmtLeft(inSec(3 * 3600 + 49 * 60)), '3h 49m');
  eq(M.fmtLeft(inSec(42 * 60)), '42m');
  eq(M.fmtLeft(inSec(2 * 86400 + 4 * 3600)), '2d 4h');
});

await t('fmtLeft never shows a negative clock', () => {
  eq(M.fmtLeft(inSec(-3600)), 'now');
  eq(M.fmtLeft(inSec(0)), 'now');
});

await t('fmtLeft rejects millisecond input instead of silently printing "now"', () => {
  // Guards the units bug directly: ms-valued input is FAR in the future, so a
  // correct reader gives days — "now" would mean the seconds contract broke.
  ok(M.fmtLeft(Date.now() + 3600_000) !== 'now', 'ms input must not read as expired');
});

await t('fmtLeft degrades to "now" for input that is not a number at all', () => {
  for (const v of [NaN, 'abc', null, undefined]) eq(M.fmtLeft(v), 'now', `${v}: `);
});

await t('fmtLimit renders "% used · time left"', () => {
  eq(M.fmtLimit({ used_percentage: 37.4, resets_at: inSec(3 * 3600 + 49 * 60) }), '37% used · 3h 49m left');
  eq(M.fmtLimit({ used_percentage: 61.6, resets_at: inSec(2 * 86400 + 4 * 3600) }), '62% used · 2d 4h left');
});

await t('fmtLimit degrades instead of printing "undefined%"', () => {
  eq(M.fmtLimit(null), null);
  eq(M.fmtLimit(undefined), null);
  eq(M.fmtLimit({}), null);
  eq(M.fmtLimit({ used_percentage: 0, resets_at: inSec(600) }), '0% used · 10m left');
  eq(M.fmtLimit({ resets_at: inSec(600) }), '10m left');
  eq(M.fmtLimit({ used_percentage: 88 }), '88% used');
});

// ---------- fmtTokens ----------
await t('fmtTokens picks a unit per magnitude', () => {
  eq(M.fmtTokens(0), '0');
  eq(M.fmtTokens(999), '999');
  eq(M.fmtTokens(1500), '2k');
  eq(M.fmtTokens(1_500_000), '1.5M');
  eq(M.fmtTokens(2_500_000_000), '2.5B');
});

await t('fmtTokens says n/a rather than printing null into the chat', () => {
  eq(M.fmtTokens(null), 'n/a');
  eq(M.fmtTokens(undefined), 'n/a');
});

// ---------- modelWindow ----------
await t('the 1M families get 1M, everything else assumes 200k', () => {
  for (const n of ['fable', 'Fable', 'claude-opus-5', 'sonnet', 'MYTHOS']) eq(M.modelWindow(n), 1_000_000, `${n}: `);
  for (const n of ['haiku', 'claude-haiku-4-5', 'something-else']) eq(M.modelWindow(n), 200_000, `${n}: `);
});

await t('an unset model name does not crash the context report', () => {
  eq(M.modelWindow(''), 200_000);
  eq(M.modelWindow(null), 200_000);
  eq(M.modelWindow(undefined), 200_000);
});

// ---------- readRateLimits: the cache path is injected ----------
await t('readRateLimits parses a cache at the CALLER-supplied path', () => {
  const f = path.join(TMP, 'rl.json');
  writeFileSync(f, JSON.stringify({ captured_at: 1, rate_limits: { five_hour: { used_percentage: 12 } } }));
  eq(M.readRateLimits(f)?.rate_limits?.five_hour?.used_percentage, 12);
});

await t('a missing cache is null, not a throw', () => {
  eq(M.readRateLimits(path.join(TMP, 'does-not-exist.json')), null);
});

await t('a corrupt cache is null, not a throw', () => {
  const f = path.join(TMP, 'corrupt.json');
  writeFileSync(f, '{not json');
  eq(M.readRateLimits(f), null);
});

await t('a well-formed file WITHOUT rate_limits is rejected, not half-reported', () => {
  const f = path.join(TMP, 'norl.json');
  writeFileSync(f, JSON.stringify({ captured_at: 1 }));
  eq(M.readRateLimits(f), null);
});

// ---------- execJson: the binary and its args are the caller's ----------
await t('execJson parses the JSON a command prints', async () => {
  eq(await M.execJson(process.execPath, ['-e', 'console.log(JSON.stringify({ok:1}))']), { ok: 1 });
});

await t('execJson returns null for non-JSON output instead of throwing', async () => {
  eq(await M.execJson(process.execPath, ['-e', 'console.log("plain text")']), null);
});

await t('execJson returns null when the binary does not exist', async () => {
  eq(await M.execJson('definitely-not-a-real-binary-xyz', []), null);
});

await t('execJson returns null on a non-zero exit', async () => {
  eq(await M.execJson(process.execPath, ['-e', 'process.exit(3)']), null);
});

await t('execJson honours its timeout rather than hanging the reply', async () => {
  const started = Date.now();
  eq(await M.execJson(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 300), null);
  ok(Date.now() - started < 5000, 'timeout was not enforced');
});

// ---------- report ----------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('✅ usage-limits tests pass');
