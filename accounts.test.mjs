#!/usr/bin/env node
// Tests for accounts.mjs, the Claude Code account switcher.
//
// SHARED TEST, byte-identical in both bridge repos (scripts/check-shared.sh).
//
// Nothing here touches the real keychain or the real accounts.json. The store
// is a factory, so `file` points into a mkdtemp directory and the injected
// credential store is credential-store.mjs's REAL keychain store over a fake
// `security` held in memory — which also makes the write path testable for
// real, because the fake decodes the same `security -i` + hex payload the
// daemon actually sends. A fake that only recorded the call would prove
// nothing about the encoding. The same account store is then run over the
// FILE backend at the bottom, against a real temp directory, to prove the
// swap logic is backend-agnostic.
//
//   node accounts.test.mjs

import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, renameSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fingerprint,
  mergeBlob,
  isLimitSignal,
  parseResetTime,
  isLimited,
  nextAvailable,
  earliestReset,
  matchAccount,
  createAccountStore,
} from './accounts.mjs';
import { createKeychainStore, createFileStore } from './credential-store.mjs';

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

const TMP = mkdtempSync(path.join(tmpdir(), 'accounts-test-'));

// Token-shaped fixtures. 108 chars is the real length; the point of the length
// is that a fingerprint of one must not resemble the token.
const tok = (seed) => `sk-ant-oat01-${seed}`.padEnd(102, 'x') + seed.slice(-6).padStart(6, 'Z');
const oauth = (seed, over = {}) => ({
  accessToken: tok(`acc-${seed}`),
  refreshToken: tok(`ref-${seed}`),
  expiresAt: 1787979122825,
  refreshTokenExpiresAt: 1790380026825,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  ...over,
});

// ---------- fingerprints: the only rendering of a token this repo allows ----------

await t('a fingerprint reveals six characters and nothing more', () => {
  const o = oauth('one');
  const fp = fingerprint(o);
  ok(!fp.includes(o.accessToken), 'fingerprint leaked the access token');
  ok(!fp.includes(o.refreshToken), 'fingerprint leaked the refresh token');
  ok(fp.includes(o.accessToken.slice(-6)), 'fingerprint must still identify the account');
  ok(fp.length < 30, `fingerprint too long to be a mask: ${fp.length}`);
});

await t('a missing or stub oauth fingerprints without throwing', () => {
  eq(fingerprint(null), 'none');
  eq(fingerprint({}), 'a…none/r…none');
  eq(fingerprint({ accessToken: 'abc' }), 'a…??????/r…none');
});

// ---------- mergeBlob: the mcpOAuth guarantee, proven with a fixture ----------

// This is the single most dangerous operation in the module: mcpOAuth holds this
// machine's GHL / Meta / HeyGen / Vercel tokens, which are per-MACHINE, not
// per-account. Swapping the whole blob would clobber them on every rotation.
const LIVE_BLOB = {
  claudeAiOauth: oauth('live'),
  mcpOAuth: {
    'heygen|1b898ec3d17d86a8': { accessToken: 'hg-tok', expiresAt: 1787000000000, scope: 'read write' },
    'leadconnector|a1e78fb3f3c5876c': { accessToken: 'lc-tok', refreshToken: 'lc-ref', locationId: 'abc123' },
    'meta-ads|2f084c187ed6e150': { accessToken: 'meta-tok' },
    'plugin:vercel:vercel|511b08192b045b3d': { accessToken: 'vc-tok', teamId: 'team_x' },
  },
};

await t('mergeBlob swaps the account and leaves mcpOAuth byte-identical', () => {
  const before = JSON.stringify(LIVE_BLOB.mcpOAuth);
  const incoming = oauth('incoming');
  const out = mergeBlob(LIVE_BLOB, incoming);
  eq(out.claudeAiOauth.accessToken, incoming.accessToken, 'incoming account not installed');
  eq(JSON.stringify(out.mcpOAuth), before, 'mcpOAuth changed: this is the clobber bug');
  eq(JSON.stringify(LIVE_BLOB.mcpOAuth), before, 'mergeBlob mutated its input');
  ok(out.claudeAiOauth !== LIVE_BLOB.claudeAiOauth, 'the old account is still installed');
});

await t('mergeBlob carries through top-level keys it has never heard of', () => {
  const out = mergeBlob({ ...LIVE_BLOB, someFutureKey: { a: 1 } }, oauth('x'));
  eq(out.someFutureKey, { a: 1 }, 'an unknown key was dropped, so a future CC version would lose state');
});

await t('mergeBlob refuses to write a blob with no account in it', () => {
  let threw = false;
  try {
    mergeBlob(LIVE_BLOB, null);
  } catch {
    threw = true;
  }
  ok(threw, 'merging a null account must throw, not produce a credential-less blob');
});

// ---------- reset-time parsing ----------

// The real message on this machine, verified in runs/*.jsonl:
//   "You've hit your session limit · resets 6:30pm (America/Caracas)"
const NOW = Date.UTC(2026, 7, 28, 18, 0, 0); // 2026-08-28 18:00Z = 14:00 in Caracas (UTC-4)
const hoursFromNow = (resetsAt) => (resetsAt * 1000 - NOW) / 3600000;

await t('the real message parses: 6:30pm in an explicit zone', () => {
  const r = parseResetTime("You've hit your session limit · resets 6:30pm (America/Caracas)", { now: NOW });
  eq(r.guessed, false);
  eq(hoursFromNow(r.resetsAt), 4.5, '18:30 Caracas is 22:30Z, 4.5h after 18:00Z');
  ok(r.note.includes('America/Caracas'), 'the zone should be reported');
});

await t('a bare time with no zone reads as local', () => {
  const r = parseResetTime("You've hit your session limit, resets 1pm", { now: NOW, timeZone: 'America/Caracas' });
  eq(r.guessed, false);
  // 13:00 Caracas already passed at 14:00 Caracas, so it means tomorrow.
  eq(hoursFromNow(r.resetsAt), 23, 'a past time must roll to tomorrow, not to the past');
});

await t('a future bare time stays today', () => {
  const r = parseResetTime('resets 5pm', { now: NOW, timeZone: 'America/Caracas' });
  eq(hoursFromNow(r.resetsAt), 3);
});

await t('24-hour times parse', () => {
  const r = parseResetTime('session limit reached · resets 20:15 (America/Caracas)', { now: NOW });
  eq(r.guessed, false);
  eq(hoursFromNow(r.resetsAt), 6.25);
});

await t('"reset at" phrasing parses', () => {
  const r = parseResetTime('Claude usage limit reached. Your limit will reset at 3pm (America/Caracas).', { now: NOW });
  eq(r.guessed, false);
  eq(hoursFromNow(r.resetsAt), 1);
});

await t('the absolute-epoch form needs no zone reasoning', () => {
  const secs = Math.floor(NOW / 1000) + 7200;
  const r = parseResetTime(`Claude AI usage limit reached|${secs}`, { now: NOW });
  eq(r.resetsAt, secs);
  eq(r.guessed, false);
  const ms = NOW + 7200_000;
  eq(parseResetTime(`Claude AI usage limit reached|${ms}`, { now: NOW }).resetsAt, secs, 'ms epochs must normalise');
});

await t('garbage degrades to a stated guess of one hour, never to a throw or a null', () => {
  for (const junk of ['', null, undefined, 'the process exited', 'resets soon', 'resets 99pm', 'resets 7:88pm']) {
    const r = parseResetTime(junk, { now: NOW });
    eq(r.guessed, true, `should have guessed for ${JSON.stringify(junk)}`);
    eq(hoursFromNow(r.resetsAt), 1, `guess should be one hour for ${JSON.stringify(junk)}`);
    ok(r.note.includes('guessed'), 'the caller has to be able to say it guessed');
  }
});

await t('an unrecognised timezone falls back to local instead of throwing', () => {
  const r = parseResetTime('resets 5pm (Middle/Earth)', { now: NOW, timeZone: 'America/Caracas' });
  eq(r.guessed, false, 'a bad zone must not lose the time');
  eq(hoursFromNow(r.resetsAt), 3);
  ok(r.note.includes('not recognised'), 'the fallback should be visible');
});

await t('parsing survives a DST boundary in a zone that has one', () => {
  // 2026-11-01 02:00 local is when US Eastern falls back. Asking for 3am on the
  // day of the shift must still produce a real instant in the future.
  const eve = Date.UTC(2026, 10, 1, 4, 0, 0);
  const r = parseResetTime('resets 3am (America/New_York)', { now: eve });
  ok(r.resetsAt * 1000 > eve, 'a DST-day reset must still be in the future');
  ok(r.resetsAt * 1000 - eve < 30 * 3600 * 1000, 'and within a day, not a year out');
});

// ---------- limit-signal detection ----------

await t('limit phrases are recognised and bare "limit" is not', () => {
  ok(isLimitSignal("You've hit your session limit · resets 6:30pm (America/Caracas)"));
  ok(isLimitSignal('Claude AI usage limit reached|1787979122'));
  ok(isLimitSignal('session limit reached'));
  ok(!isLimitSignal('exit code 1'), 'a plain failure must not rotate accounts');
  ok(!isLimitSignal('the rate limiter returned 429'), 'bare limit words must not trip it');
  ok(!isLimitSignal(''), 'empty text is not a limit');
});

// ---------- selection ----------

const iso = (msFromNow) => new Date(NOW + msFromNow).toISOString();
const secs = (msFromNow) => Math.floor((NOW + msFromNow) / 1000);

await t('isLimited reads limitedUntil as epoch seconds', () => {
  ok(isLimited({ limitedUntil: secs(3600) }, NOW), 'a future reset means limited');
  ok(!isLimited({ limitedUntil: secs(-3600) }, NOW), 'a past reset means available again');
  ok(!isLimited({ limitedUntil: null }, NOW));
  ok(!isLimited({}, NOW));
});

await t('nextAvailable skips the limited, skips the active, prefers the never-used', () => {
  const list = [
    { name: 'main', claudeAiOauth: oauth('m'), limitedUntil: secs(3600), lastActiveAt: iso(-60_000) },
    { name: 'two', claudeAiOauth: oauth('2'), limitedUntil: null, lastActiveAt: iso(-86_400_000) },
    { name: 'three', claudeAiOauth: oauth('3'), limitedUntil: null, lastActiveAt: null },
  ];
  eq(nextAvailable(list, { activeName: 'main', now: NOW }).name, 'three', 'a never-used slot has the freshest window');
});

await t('nextAvailable then falls to least-recently-active', () => {
  const list = [
    { name: 'main', claudeAiOauth: oauth('m'), limitedUntil: secs(3600), lastActiveAt: iso(-60_000) },
    { name: 'two', claudeAiOauth: oauth('2'), limitedUntil: null, lastActiveAt: iso(-3_600_000) },
    { name: 'three', claudeAiOauth: oauth('3'), limitedUntil: null, lastActiveAt: iso(-86_400_000) },
  ];
  eq(nextAvailable(list, { activeName: 'main', now: NOW }).name, 'three');
});

await t('nextAvailable never returns the account that just died', () => {
  const list = [
    { name: 'main', claudeAiOauth: oauth('m'), limitedUntil: null, lastActiveAt: iso(-86_400_000) },
    { name: 'two', claudeAiOauth: oauth('2'), limitedUntil: null, lastActiveAt: iso(-60_000) },
  ];
  eq(nextAvailable(list, { activeName: 'main', now: NOW }).name, 'two', 'the active account must be excluded');
});

await t('nextAvailable ignores slots that were never captured', () => {
  const list = [
    { name: 'main', claudeAiOauth: oauth('m'), limitedUntil: secs(3600), lastActiveAt: iso(-60_000) },
    { name: 'empty', claudeAiOauth: null, limitedUntil: null, lastActiveAt: null },
  ];
  eq(nextAvailable(list, { activeName: 'main', now: NOW }), null, 'an uncaptured slot is not a usable account');
});

await t('nextAvailable returns null when every account is limited, so the caller cannot spin', () => {
  const list = [
    { name: 'main', claudeAiOauth: oauth('m'), limitedUntil: secs(3600) },
    { name: 'two', claudeAiOauth: oauth('2'), limitedUntil: secs(7200) },
    { name: 'three', claudeAiOauth: oauth('3'), limitedUntil: secs(1800) },
  ];
  eq(nextAvailable(list, { activeName: 'main', now: NOW }), null);
  eq(earliestReset(list, NOW), secs(1800), 'the message must quote the EARLIEST reset');
});

await t('earliestReset is null when nothing is limited', () => {
  eq(earliestReset([{ name: 'a', limitedUntil: null }], NOW), null);
});

// ---------- identifying the live account ----------

await t('matchAccount resolves by refresh token, then access token, then prefix', () => {
  const a = { name: 'a', claudeAiOauth: oauth('a') };
  const b = { name: 'b', claudeAiOauth: oauth('b') };
  eq(matchAccount([a, b], a.claudeAiOauth).matchedBy, 'refreshToken');
  const refreshed = { ...a.claudeAiOauth, refreshToken: 'totally-different-and-short' };
  eq(matchAccount([a, b], refreshed).matchedBy, 'accessToken', 'an access-token refresh must still resolve');
  const rotated = { accessToken: 'new', refreshToken: a.claudeAiOauth.refreshToken.slice(0, 30) + 'DIFFERENT' };
  eq(matchAccount([a, b], rotated).matchedBy, 'refreshTokenPrefix');
  eq(matchAccount([a, b], oauth('stranger')), null, 'an unknown blob must not be forced onto a slot');
});

// ---------- the store, against a fake keychain ----------

// Decodes the exact wire format the daemon sends: `security -i` on stdin, the
// payload hex encoded behind -X. If the encoding regresses, this fake stops
// parsing and the tests go red rather than silently accepting anything.
function fakeKeychain(initialBlob) {
  const box = { blob: initialBlob ? JSON.parse(JSON.stringify(initialBlob)) : null, writes: 0, argvPayloads: [] };
  box.run = async (args, stdin = null) => {
    if (args[0] === 'find-generic-password') {
      return box.blob ? { code: 0, stdout: JSON.stringify(box.blob) } : { code: 44, stdout: '' };
    }
    if (args[0] === '-i' && stdin) {
      const m = stdin.match(/^add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]+)"\n$/);
      if (!m) return { code: 1, stdout: '' };
      box.blob = JSON.parse(Buffer.from(m[3], 'hex').toString('utf8'));
      box.writes++;
      return { code: 0, stdout: '' };
    }
    // Anything reaching argv with a payload would be a `ps` leak.
    box.argvPayloads.push(args);
    return { code: 1, stdout: '' };
  };
  return box;
}

let tmpN = 0;
function freshStore(initialBlob, seed = [], { identify } = {}) {
  const n = tmpN++;
  const file = path.join(TMP, `accounts-${n}.json`);
  // Injected per store, NOT left to the dirname default: every test file lives
  // in the one TMP dir, and the backup's never-overwrite rule would otherwise
  // leak state from one test into the next.
  const backupFile = path.join(TMP, `accounts-${n}.backup.json`);
  const unclaimedFile = path.join(TMP, `accounts-${n}.unclaimed.json`);
  if (seed.length) writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
  const kc = fakeKeychain(initialBlob);
  const logs = [];
  const store = createAccountStore({
    file,
    backupFile,
    unclaimedFile,
    identify,
    // The REAL keychain store from credential-store.mjs over the fake
    // `security`, so the exact wire encoding the daemon ships is what runs.
    // The runSecurity arrow is indirected on purpose: a test that swaps kc.run
    // mid-flight (to simulate a keychain that lies) must actually take effect,
    // which passing kc.run by value would silently prevent.
    credentials: createKeychainStore({
      service: 'Claude Code-credentials',
      account: 'owner',
      runSecurity: (...a) => kc.run(...a),
    }),
    log: (m) => logs.push(m),
  });
  return { store, kc, file, backupFile, unclaimedFile, logs };
}

await t('capture banks the live credentials into a named slot at 0600', async () => {
  const { store, file } = freshStore(LIVE_BLOB);
  const r = await store.captureCurrent('main', { email: 'first@example.com' });
  ok(r.ok, r.error);
  eq((statSync(file).mode & 0o777).toString(8), '600', 'accounts.json must not be readable by anyone else');
  const rows = store.describe();
  eq(rows.length, 1);
  eq(rows[0].name, 'main');
  eq(rows[0].captured, true);
  eq(rows[0].fingerprint, fingerprint(LIVE_BLOB.claudeAiOauth));
});

await t('capture never writes a token into anything but the slot itself', async () => {
  const { store, file, logs } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  eq(onDisk[0].claudeAiOauth.accessToken, LIVE_BLOB.claudeAiOauth.accessToken, 'the slot must hold the real token');
  for (const line of logs) {
    ok(!line.includes(LIVE_BLOB.claudeAiOauth.accessToken), `a log line leaked a token: ${line}`);
    ok(!line.includes(LIVE_BLOB.claudeAiOauth.refreshToken), `a log line leaked a token: ${line}`);
  }
});

await t('a swap installs the incoming account and preserves mcpOAuth exactly', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const other = oauth('second');
  await store.captureCurrent('two'); // placeholder, overwritten next line
  const list = store.listAccounts();
  list[1].claudeAiOauth = other;
  writeFileSync(store.file, JSON.stringify(list, null, 2), { mode: 0o600 });

  const mcpBefore = JSON.stringify(LIVE_BLOB.mcpOAuth);
  const r = await store.swapTo('two');
  ok(r.ok, r.error);
  eq(kc.blob.claudeAiOauth.accessToken, other.accessToken, 'the new account is not live');
  eq(JSON.stringify(kc.blob.mcpOAuth), mcpBefore, 'mcpOAuth was clobbered by the swap');
  eq(kc.argvPayloads.length, 0, 'a payload reached argv, where ps can read it');
  eq(r.from, 'main');
});

await t('a swap banks the outgoing refresh first, so the account stays usable', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const other = oauth('second');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = other;
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });

  // While "main" was active, a worker refreshed its access token in place.
  const refreshed = { ...LIVE_BLOB.claudeAiOauth, accessToken: tok('acc-refreshedZZ') };
  kc.blob = { ...LIVE_BLOB, claudeAiOauth: refreshed };

  ok((await store.swapTo('two')).ok);
  const main = store.listAccounts().find((a) => a.name === 'main');
  eq(main.claudeAiOauth.accessToken, refreshed.accessToken, 'the refresh was discarded, so main would be stale');
});

await t('a swap records lastActiveAt so the rotation spreads across three accounts', async () => {
  const { store } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  ok((await store.swapTo('two')).ok);
  const two = store.describe().find((a) => a.name === 'two');
  ok(two.lastActiveAt, 'lastActiveAt was not stamped');
});

await t('a keychain write that does not read back is reported as a failure', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  // A keychain that accepts the write, exits 0, and changes nothing: the exact
  // shape of the corrupted-edge-deploy failure, in a different subsystem.
  kc.run = async (args) =>
    args[0] === 'find-generic-password' ? { code: 0, stdout: JSON.stringify(LIVE_BLOB) } : { code: 0, stdout: '' };
  const r = await store.swapTo('two');
  eq(r.ok, false, 'a zero exit code is not proof the keychain changed');
  // The old assertion matched the phrase "read back". It now checks the thing
  // that actually matters to the owner: the message must say the PREVIOUS
  // account is still live, because in this scenario it genuinely is. The old
  // wording claimed "unchanged" unconditionally, including in the case where
  // the keychain had in fact been left holding a truncated blob.
  ok(/previous account is still active/.test(r.error), r.error);
  ok(!/\/login/.test(r.error), 'must not send the owner to re-login when nothing was damaged');
});

await t('a payload over the security -i line limit is REFUSED before the keychain is touched', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('big');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  // security -i splits any line past ~4096 chars and stores the truncated head,
  // which is how a swap once left the keychain with no claudeAiOauth at all.
  // Bulk lives in mcpOAuth, which grows with every MCP server the owner adds.
  const fat = { ...LIVE_BLOB, mcpOAuth: { pad: 'x'.repeat(4000) } };
  kc.blob = fat;
  let wrote = false;
  const realRun = kc.run;
  kc.run = async (args, stdin) => {
    if (args[0] === '-i') wrote = true;
    return realRun(args, stdin);
  };
  const r = await store.swapTo('big');
  eq(r.ok, false, 'an oversized payload must not be attempted');
  eq(wrote, false, 'the keychain must not be touched at all by a refused write');
  eq(fingerprint(kc.blob.claudeAiOauth), fingerprint(LIVE_BLOB.claudeAiOauth), 'live credentials untouched');
});

await t('a corrupting write is rolled back, not left in place', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  // The observed failure: the write lands, but what gets stored is truncated
  // and carries no claudeAiOauth. Before the rollback existed this left Claude
  // Code with no login and an error message insisting nothing had changed.
  const realRun = kc.run;
  let writes = 0;
  kc.run = async (args, stdin) => {
    if (args[0] === '-i') {
      writes++;
      if (writes === 1) {
        kc.blob = { mcpOAuth: LIVE_BLOB.mcpOAuth }; // truncated: claudeAiOauth gone
        return { code: 0, stdout: '' };
      }
    }
    return realRun(args, stdin);
  };
  const r = await store.swapTo('two');
  eq(r.ok, false, 'a corrupted write is a failed swap');
  eq(
    fingerprint(kc.blob.claudeAiOauth),
    fingerprint(LIVE_BLOB.claudeAiOauth),
    'the PREVIOUS credentials must be back in the keychain',
  );
  ok(kc.blob.mcpOAuth, 'mcpOAuth must survive the rollback too');
});

await t('swapping to an unknown or uncaptured slot changes nothing', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  eq((await store.swapTo('nope')).ok, false);
  const list = store.listAccounts();
  list.push({ name: 'empty', claudeAiOauth: null, limitedUntil: null, lastActiveAt: null, capturedAt: null });
  writeFileSync(store.file, JSON.stringify(list, null, 2), { mode: 0o600 });
  eq((await store.swapTo('empty')).ok, false);
  eq(kc.writes, 0, 'the keychain must not be touched on a rejected swap');
});

await t('markLimited stores epoch seconds and describe() reflects it', async () => {
  const { store } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const until = secs(3600);
  ok(store.markLimited('main', until).ok);
  const row = store.describe(NOW).find((a) => a.name === 'main');
  eq(row.limitedUntil, until);
  eq(row.limited, true);
  eq(store.describe(NOW + 7200_000).find((a) => a.name === 'main').limited, false, 'the limit must expire on its own');
  ok(store.clearLimit('main').ok);
  eq(store.describe(NOW).find((a) => a.name === 'main').limited, false);
});

await t('activeAccount identifies the live slot, and says how it knows', async () => {
  const { store } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const a = await store.activeAccount();
  eq(a.account.name, 'main');
  eq(a.matchedBy, 'refreshToken');
  eq(a.liveFingerprint, fingerprint(LIVE_BLOB.claudeAiOauth));
});

await t('activeAccount degrades to a labelled guess when the live blob matches nothing', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  ok((await store.swapTo('main')).ok || true);
  kc.blob = { ...LIVE_BLOB, claudeAiOauth: oauth('stranger') };
  const a = await store.activeAccount();
  eq(a.matchedBy, 'lastActiveAt', 'an unidentifiable blob must be flagged as a guess, not asserted');
});

// ---------- the residual race ----------

await t('drift caused by an outgoing worker re-asserts the intended account', async () => {
  const { store, kc, logs } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const other = oauth('second');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = other;
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  ok((await store.swapTo('two')).ok);

  // A worker still running on "main" refreshes and writes its blob back over us.
  const mainRefreshed = { ...LIVE_BLOB.claudeAiOauth, accessToken: tok('acc-clobberZZ') };
  kc.blob = { ...kc.blob, claudeAiOauth: mainRefreshed };

  const d = await store.checkDrift();
  eq(d.drifted, true);
  eq(d.action, 'reasserted');
  eq(kc.blob.claudeAiOauth.accessToken, other.accessToken, '"two" was not restored');
  eq(JSON.stringify(kc.blob.mcpOAuth), JSON.stringify(LIVE_BLOB.mcpOAuth), 'the re-assert clobbered mcpOAuth');
  const main = store.listAccounts().find((a) => a.name === 'main');
  eq(main.claudeAiOauth.accessToken, mainRefreshed.accessToken, "the clobberer's own refresh was thrown away");
  ok(
    logs.some((l) => l.startsWith('DRIFT')),
    'drift must be logged, not silently corrected',
  );
});

await t('an unidentifiable change is PARKED, never banked and never overridden, because /login must win', async () => {
  // The 2026-08-31 mislabel, distilled: identity unknown (no identify wired),
  // so the blob must go into NO named slot. The old code banked it into the
  // believed-active slot — which is how a fresh /login into a second account
  // once ended up labelled as the first one.
  const { store, kc, logs, unclaimedFile } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  ok((await store.swapTo('main')).ok);
  const keep = fingerprint(store.listAccounts()[0].claudeAiOauth);

  const manualLogin = oauth('manual-login');
  kc.blob = { ...kc.blob, claudeAiOauth: manualLogin };
  const d = await store.checkDrift();
  eq(d.action, 'parked');
  eq(kc.blob.claudeAiOauth.accessToken, manualLogin.accessToken, 'a manual /login was stomped by the drift guard');
  eq(fingerprint(store.listAccounts()[0].claudeAiOauth), keep, 'an unverified blob was banked into a named slot');
  eq(store.describeUnclaimed().fingerprint, fingerprint(manualLogin), 'the blob must be parked, not dropped');
  eq((statSync(unclaimedFile).mode & 0o777).toString(8), '600', 'the parked blob is a token dump; 0600 or nothing');
  ok(logs.some((l) => l.includes('parked unclaimed credentials')));
  // And the same blob is not re-parked on every tick.
  const again = await store.checkDrift();
  eq(again.drifted, false, 'a parked blob must not re-trigger drift every 60s');
});

await t('a blob with a FOREIGN identity is banked into ITS OWN slot, never the believed-active one', async () => {
  // The 2026-08-31 scenario: guard believes the FIRST account is active; the
  // owner runs a fresh /login into the SECOND. The blob fingerprint-matches
  // nothing; identify says second@example.com. It must land in second's slot.
  // Seeds chosen to differ within the first 24 characters: a fresh /login's
  // tokens are unrelated to the stored ones, and matchAccount's prefix rule
  // must NOT accidentally fire (that would be rung 1, a different test).
  const gj = oauth('freshSecond');
  const identify = async (accessToken) => (accessToken === gj.accessToken ? 'second@example.com' : null);
  const { store, kc, logs } = freshStore(LIVE_BLOB, [], { identify });
  await store.captureCurrent('first@example.com', { email: 'first@example.com' });
  await store.captureCurrent('second@example.com', { email: 'second@example.com' });
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('oldGJ');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  ok((await store.swapTo('first@example.com')).ok);
  const firstKeep = fingerprint(store.listAccounts()[0].claudeAiOauth);

  kc.blob = { ...kc.blob, claudeAiOauth: gj };
  const d = await store.checkDrift();
  eq(d.action, 'rebanked');
  eq(d.to, 'second@example.com', 'must bank into the slot the identity PROVES, not the believed-active one');
  eq(d.identifiedAs, 'second@example.com');
  const rows = store.listAccounts();
  eq(fingerprint(rows[0].claudeAiOauth), firstKeep, "the second account's tokens landed in the first's slot — the 2026-08-31 bug");
  eq(rows[1].claudeAiOauth.accessToken, gj.accessToken, 'the fresh login was not banked into its own slot');
  eq(kc.blob.claudeAiOauth.accessToken, gj.accessToken, 'the live /login must never be overridden');
  ok(
    logs.some((l) => l.includes('banked THERE') && l.includes('mislabeled')),
    'diverging from the old behaviour must be logged',
  );
  // The guard now follows the login instead of re-asserting a stale belief.
  const again = await store.checkDrift();
  eq(again.drifted, false, 'the guard must defend the account that is actually live now');
});

await t('an identified blob matching NO slot is parked with its email, all named slots untouched', async () => {
  const stranger = oauth('unenrolled-login');
  const { store, kc } = freshStore(LIVE_BLOB, [], { identify: async () => 'fourth@somewhere.app' });
  await store.captureCurrent('main', { email: 'first@example.com' });
  ok((await store.swapTo('main')).ok);
  const keep = fingerprint(store.listAccounts()[0].claudeAiOauth);

  kc.blob = { ...kc.blob, claudeAiOauth: stranger };
  const d = await store.checkDrift();
  eq(d.action, 'parked');
  eq(fingerprint(store.listAccounts()[0].claudeAiOauth), keep, 'no slot may change for an unenrolled identity');
  const u = store.describeUnclaimed();
  eq(u.email, 'fourth@somewhere.app', 'the identity travels with the parked blob so a capture can claim it');
  eq(u.fingerprint, fingerprint(stranger));
  eq(store.listAccounts().length, 1, 'a slot was invented for an unenrolled identity');
});

await t('an identify FAILURE parks rather than banks', async () => {
  const { store, kc } = freshStore(LIVE_BLOB, [], {
    identify: async () => {
      throw new Error('profile endpoint down');
    },
  });
  await store.captureCurrent('main');
  ok((await store.swapTo('main')).ok);
  const keep = fingerprint(store.listAccounts()[0].claudeAiOauth);

  const mystery = oauth('mystery');
  kc.blob = { ...kc.blob, claudeAiOauth: mystery };
  const d = await store.checkDrift();
  eq(d.action, 'parked', 'a failed identify means "cannot verify", and unverified blobs are never banked');
  eq(fingerprint(store.listAccounts()[0].claudeAiOauth), keep);
  eq(store.describeUnclaimed().fingerprint, fingerprint(mystery));
});

await t("swapTo's outgoing bank climbs the same ladder: identified → its own slot, unidentified → parked", async () => {
  // Identified case: the live blob is an unknown fingerprint but identify says
  // it is "two" — the outgoing bank must land it in two's slot.
  const twoFresh = oauth('two-fresh');
  const { store, kc } = freshStore(LIVE_BLOB, [], {
    identify: async (accessToken) => (accessToken === twoFresh.accessToken ? 'two@x.app' : null),
  });
  await store.captureCurrent('main', { email: 'main@x.app' });
  await store.captureCurrent('two', { email: 'two@x.app' });
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('two-old');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });

  kc.blob = { ...LIVE_BLOB, claudeAiOauth: twoFresh };
  const r = await store.swapTo('main');
  ok(r.ok, r.error);
  eq(store.listAccounts()[1].claudeAiOauth.accessToken, twoFresh.accessToken, "the outgoing blob was not banked into two's own slot");
  eq(store.describeUnclaimed(), null, 'an identified blob must not also be parked');

  // Unidentified case: same shape, identify answers null → parked, both named
  // slots untouched, and the swap itself still goes through.
  const mystery = oauth('mystery-out');
  kc.blob = { ...kc.blob, claudeAiOauth: mystery };
  const before = store.listAccounts().map((a) => fingerprint(a.claudeAiOauth));
  const r2 = await store.swapTo('two');
  ok(r2.ok, r2.error);
  const after = store.listAccounts().map((a) => fingerprint(a.claudeAiOauth));
  eq(after, before, 'an unverifiable outgoing blob changed a named slot');
  eq(store.describeUnclaimed().fingerprint, fingerprint(mystery), 'the outgoing blob must be parked, not dropped');
});

await t('a capture into the matching slot consumes the parked blob; a foreign capture leaves it', async () => {
  const parkedLogin = oauth('parked-login');
  const { store, kc } = freshStore(LIVE_BLOB, [], {
    identify: async (accessToken) => (accessToken === parkedLogin.accessToken ? 'parked@x.app' : null),
  });
  await store.captureCurrent('main', { email: 'main@x.app' });
  ok((await store.swapTo('main')).ok);
  kc.blob = { ...kc.blob, claudeAiOauth: parkedLogin };
  eq((await store.checkDrift()).action, 'parked');
  ok(store.describeUnclaimed(), 'setup: something must be parked');

  // A capture of a DIFFERENT login into an unrelated slot must not consume it:
  // neither the email nor the tokens match the parked record.
  kc.blob = { ...kc.blob, claudeAiOauth: oauth('someOTHER') };
  await store.captureCurrent('other', { email: 'other@x.app' });
  ok(store.describeUnclaimed(), 'a foreign capture consumed a parked blob it does not match');

  // The owner logs back into the parked account and captures it: claimed.
  kc.blob = { ...kc.blob, claudeAiOauth: parkedLogin };
  await store.captureCurrent('parked@x.app', { email: 'parked@x.app' });
  eq(store.describeUnclaimed(), null, 'the matching capture must consume the parked blob');
});

// ---------- the one-time backup ----------

await t('the first keychain write backs up the live blob exactly once, at 0600, and never overwrites it', async () => {
  const { store, kc, backupFile } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });

  ok(!statSafe(backupFile), 'capture writes only accounts.json and must not create the backup');
  ok((await store.swapTo('two')).ok);
  ok(store.hasBackup(), 'the first swap must create the backup');
  eq((statSync(backupFile).mode & 0o777).toString(8), '600', 'the backup is a token dump; 0600 or nothing');
  const first = JSON.parse(readFileSync(backupFile, 'utf8'));
  eq(
    fingerprint(first.blob.claudeAiOauth),
    fingerprint(LIVE_BLOB.claudeAiOauth),
    'the backup must hold the PRE-swap live blob',
  );
  ok(first.blob.mcpOAuth, 'the backup must carry the whole blob, mcpOAuth included');

  const raw = readFileSync(backupFile, 'utf8');
  ok((await store.swapTo('main')).ok);
  eq(readFileSync(backupFile, 'utf8'), raw, 'a later swap overwrote the one-time backup');
});

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

await t('no drift check runs before the first swap, and a steady keychain reports no drift', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  eq((await store.checkDrift()).checked, false, 'nothing has been asserted yet, so there is nothing to defend');
  await store.captureCurrent('main');
  ok((await store.swapTo('main')).ok);
  eq((await store.checkDrift()).drifted, false);
  eq(kc.writes, 1, 'a no-op drift check must not write the keychain');
});

// ---------- bankOauth: the refreshed-token write path account-usage.mjs uses ----------

await t('bankOauth writes a refreshed blob into an existing slot, at 0600, without touching its siblings', async () => {
  const { store, file } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main', { email: 'first@example.com' });
  await store.captureCurrent('other');
  const rotated = oauth('rotated');
  const r = store.bankOauth('main', rotated);
  ok(r.ok, r.error);
  const list = JSON.parse(readFileSync(file, 'utf8'));
  eq(list[0].claudeAiOauth.accessToken, rotated.accessToken);
  eq(list[0].claudeAiOauth.refreshToken, rotated.refreshToken);
  eq(list[0].email, 'first@example.com', 'banking a token wiped the rest of the slot');
  eq(list[0].name, 'main');
  ok(list[0].capturedAt, 'a bank must restamp capturedAt, or drift reads as fresh');
  eq(list[1].claudeAiOauth.accessToken, LIVE_BLOB.claudeAiOauth.accessToken, 'a sibling slot was rewritten');
  eq(statSync(file).mode & 0o777, 0o600, 'a credentials file must never widen');
});

await t('bankOauth refuses to invent a slot, or to bank a blob with no access token', async () => {
  const { store } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  eq(store.bankOauth('typo', oauth('x')).ok, false, 'a typo must not silently create a slot');
  eq(store.bankOauth('main', null).ok, false);
  eq(store.bankOauth('main', {}).ok, false);
  eq(store.bankOauth('main', { refreshToken: 'r' }).ok, false, 'a blob with no access token is not credentials');
  eq(store.listAccounts().length, 1, 'a refused bank still changed the file');
});

await t('bankOauth logs the fingerprint and never the token', async () => {
  const { store, logs } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  const rotated = oauth('rotated');
  store.bankOauth('main', rotated);
  const banked = logs.filter((l) => l.includes('banked a refreshed token'));
  eq(banked.length, 1);
  ok(!banked[0].includes(rotated.accessToken), 'the log leaked an access token');
  ok(!banked[0].includes(rotated.refreshToken), 'the log leaked a refresh token');
  ok(banked[0].includes(fingerprint(rotated)));
});

// ---------- report ----------
await t('a CLEARED keychain is never banked over a slot that still has a token', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  const before = store.listAccounts().map((a) => fingerprint(a.claudeAiOauth));

  ok((await store.swapTo('two')).ok, 'swap should land so drift has an intended fingerprint');

  // Claude Code CLEARS credentials in place when a refresh fails: the key is
  // still there, the token inside is gone. The old guard tested for the KEY and
  // let this through, banking nothing over a real token and emptying the slot.
  kc.blob = { ...LIVE_BLOB, claudeAiOauth: {} };
  const d = await store.checkDrift();

  eq(d.drifted, false, 'a cleared store is not drift, it is an outage');
  const after = store.listAccounts().map((a) => fingerprint(a.claudeAiOauth));
  for (const fp of after) ok(fp !== 'none', `a slot was emptied: ${after.join(', ')}`);
  eq(after[0], before[0], 'slot 0 token must be untouched');
});

await t('swapTo does not bank an outgoing blob that carries no token', async () => {
  const { store, kc } = freshStore(LIVE_BLOB);
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });
  const keep = fingerprint(store.listAccounts()[0].claudeAiOauth);
  kc.blob = { ...LIVE_BLOB, claudeAiOauth: {} }; // live login is gone
  await store.swapTo('two');
  eq(fingerprint(store.listAccounts()[0].claudeAiOauth), keep, 'the outgoing slot must keep its token');
});

// ---------- the same store over the FILE backend (non-macOS platforms) ----------
//
// Everything above ran over the keychain backend. The store's contract is
// backend-agnostic, and this section is the proof: the same capture-then-swap
// flow against credential-store.mjs's file backend in a real temp directory.
// Honest limit, stated plainly: this proves the WIRING, not the platform — no
// real non-macOS Claude Code install is exercised by these tests.

await t('the file backend runs the same capture-then-swap flow end to end', async () => {
  const n = tmpN++;
  const credsFile = path.join(TMP, `creds-${n}.json`);
  const credentials = createFileStore({ path: credsFile });
  await credentials.write(LIVE_BLOB);
  const store = createAccountStore({
    file: path.join(TMP, `accounts-file-${n}.json`),
    backupFile: path.join(TMP, `accounts-file-${n}.backup.json`),
    unclaimedFile: path.join(TMP, `accounts-file-${n}.unclaimed.json`),
    credentials,
    log: () => {},
  });
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('file-second');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });

  const r = await store.swapTo('two');
  ok(r.ok, r.error);
  const onDisk = JSON.parse(readFileSync(credsFile, 'utf8'));
  eq(onDisk.claudeAiOauth.accessToken, seeded[1].claudeAiOauth.accessToken, 'the incoming account is not live in the file');
  eq(JSON.stringify(onDisk.mcpOAuth), JSON.stringify(LIVE_BLOB.mcpOAuth), 'the file-backend swap clobbered mcpOAuth');
  eq((statSync(credsFile).mode & 0o777).toString(8), '600', 'the credentials file must stay 0600 through a swap');
  // The one-time backup fires on the file backend exactly as on the keychain.
  ok(store.hasBackup(), 'the first file-backend swap must create the one-time backup');
  const backup = JSON.parse(readFileSync(store.backupFile, 'utf8'));
  eq(fingerprint(backup.blob.claudeAiOauth), fingerprint(LIVE_BLOB.claudeAiOauth), 'the backup must hold the pre-swap blob');
  // And the outgoing account's live rotation was banked before the swap.
  eq(store.listAccounts()[0].claudeAiOauth.accessToken, LIVE_BLOB.claudeAiOauth.accessToken);
});

await t('a failed file write cannot corrupt the credentials file, and reports the previous account intact', async () => {
  const n = tmpN++;
  const credsFile = path.join(TMP, `creds-${n}.json`);
  await createFileStore({ path: credsFile }).write(LIVE_BLOB);
  // A filesystem whose next rename fails: the only step that can replace the
  // real file, which is why the file backend cannot leave it half-written.
  let renameFailures = 1;
  const flakyFs = {
    readFileSync,
    writeFileSync,
    statSync,
    chmodSync,
    unlinkSync: (p) => rmSync(p, { force: true }),
    renameSync: (a, b) => {
      if (renameFailures-- > 0) throw new Error('ENOSPC: no space left on device');
      renameSync(a, b);
    },
  };
  const store = createAccountStore({
    file: path.join(TMP, `accounts-file-${n}.json`),
    backupFile: path.join(TMP, `accounts-file-${n}.backup.json`),
    unclaimedFile: path.join(TMP, `accounts-file-${n}.unclaimed.json`),
    credentials: createFileStore({ path: credsFile, fs: flakyFs }),
    log: () => {},
  });
  await store.captureCurrent('main');
  await store.captureCurrent('two');
  const seeded = store.listAccounts();
  seeded[1].claudeAiOauth = oauth('file-flaky');
  writeFileSync(store.file, JSON.stringify(seeded, null, 2), { mode: 0o600 });

  const r = await store.swapTo('two');
  eq(r.ok, false, 'a failed credential write is a failed swap');
  ok(/previous account is still active/.test(r.error), r.error);
  const onDisk = JSON.parse(readFileSync(credsFile, 'utf8'));
  eq(fingerprint(onDisk.claudeAiOauth), fingerprint(LIVE_BLOB.claudeAiOauth), 'the previous credentials must still be live');
  const leftovers = readdirSync(TMP).filter((f) => f.startsWith(`creds-${n}.json.`) && f.endsWith('.tmp'));
  eq(leftovers, [], 'a failed write left its temp file behind');
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account-swapper tests pass');
