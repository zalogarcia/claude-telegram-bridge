#!/usr/bin/env node
// Tests for account-usage.mjs — live 5h + weekly plan usage per Claude account.
//
// SHARED TEST, byte-identical in both bridge repos (scripts/check-shared.sh).
//
// Nothing here touches the network, the real keychain or the real accounts.json.
// `fetchImpl`, the clock and the account store are all injected, so the fixture
// below is the ONLY thing standing in for the API — and it is the body a live
// probe of api.anthropic.com returned on 2026-08-31 (identifying values
// anonymized, structure untouched), so a change in the wire format shows up
// here as a failing normalization rather than as a blank line in Telegram.
//
//   node account-usage.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountStore } from './accounts.mjs';
import {
  fmtPercent,
  usageBar,
  fmtResetLeft,
  fmtResetClock,
  normalizeUsage,
  fetchUsage,
  fetchProfile,
  refreshAccessToken,
  createAccountUsage,
  invalidateUsageCache,
  usageLine,
  activeLine,
  accountUsageBlock,
  renderAccountList,
  unclaimedLine,
  renderUsageReport,
  usageBrief,
  swapConfirmation,
  swapFailure,
  captureConfirmation,
  captureFailure,
  CLAUDE_CODE_CLIENT_ID,
  OAUTH_BETA,
} from './account-usage.mjs';
import { createKeychainStore } from './credential-store.mjs';

// Every zone-dependent assertion pins this zone explicitly, so the suite is
// deterministic on any machine. (The module's own default is the local zone;
// the bridges inject the owner's zone at the call sites.)
const OWNER_TZ = 'America/New_York';

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
const throws = async (fn, re, msg) => {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg || ''} wrong error: ${e.message}`);
    return e;
  }
  throw new Error(msg || 'expected a throw, got none');
};

const TMP = mkdtempSync(path.join(tmpdir(), 'account-usage-test-'));

// ---------------------------------------------------------------------------
// THE REAL RESPONSE SHAPE, from a live probe of
// GET /api/oauth/usage with a real account's token, 2026-08-31T21:53Z, CC 2.1.252.
// The unused windows (nimbus_quill, tangelo, …) are kept precisely because they
// are unused: a normalizer that trips over an unfamiliar sibling key would fail
// here rather than in production.
// ---------------------------------------------------------------------------
const REAL_USAGE = {
  five_hour: {
    utilization: 32.0,
    resets_at: '2026-08-31T22:10:00.241439+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 24.0,
    resets_at: '2026-09-05T05:00:00.241459+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: { utilization: 0.0, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
  cinder_cove: null,
  amber_ladder: null,
  juniper_tide: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 50000,
    used_credits: 0.0,
    utilization: 0.0,
    currency: 'USD',
    decimal_places: 2,
    disabled_reason: 'out_of_credits',
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: true,
    daily: null,
    weekly: null,
  },
  limits: [
    { kind: 'session', group: 'session', percent: 32, severity: 'normal', resets_at: '2026-08-31T22:10:00.241439+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 24, severity: 'normal', resets_at: '2026-09-05T05:00:00.241459+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 4, severity: 'normal', resets_at: '2026-09-05T05:00:00.241715+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  member_dashboard_available: false,
};

// The live /api/oauth/profile body, same probe.
const REAL_PROFILE = {
  account: {
    uuid: '00000000-1111-2222-3333-444444444444',
    full_name: 'Sam Owner',
    display_name: 'Sam',
    email: 'second@example.com',
    has_claude_max: true,
    has_claude_pro: false,
  },
  organization: { uuid: 'a1b2c3d4', name: "second@example.com's Organization", rate_limit_tier: 'default_claude_max_20x' },
  application: { uuid: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', name: 'Claude Code', slug: 'claude-code' },
};

const NOW = Date.parse('2026-08-31T21:53:00Z'); // pinned: every clock below is a parameter

// ---------------------------------------------------------------------------
// FORMATTERS — pure, no network, no clock of their own
// ---------------------------------------------------------------------------

await t('fmtPercent rounds and clamps, and says n/a rather than NaN', () => {
  eq(fmtPercent(31), '31%');
  eq(fmtPercent(31.4), '31%');
  eq(fmtPercent(31.6), '32%');
  eq(fmtPercent(0), '0%');
  eq(fmtPercent(100), '100%');
  eq(fmtPercent(140), '100%', 'a percent over 100 must clamp, not print 140%');
  eq(fmtPercent(-3), '0%');
  eq(fmtPercent(null), 'n/a');
  eq(fmtPercent(undefined), 'n/a');
  eq(fmtPercent('nonsense'), 'n/a');
});

await t('usageBar fills CONSUMED cells, ten of them, at both edges', () => {
  eq(usageBar(0), '░░░░░░░░░░');
  eq(usageBar(100), '██████████');
  eq(usageBar(31), '███░░░░░░░');
  eq(usageBar(24), '██░░░░░░░░');
  eq(usageBar(95), '██████████', '95% rounds to a full bar');
  eq(usageBar(4), '░░░░░░░░░░', '4% honestly rounds to empty rather than faking a cell');
  eq(usageBar(null).length, 10);
  eq(usageBar('x'), '░░░░░░░░░░');
  for (const p of [0, 1, 7, 33, 50, 99, 100]) eq([...usageBar(p)].length, 10, `bar width drifted at ${p}%`);
});

await t('fmtResetLeft gives h+m under a day', () => {
  eq(fmtResetLeft('2026-08-31T22:10:00Z', Date.parse('2026-08-31T21:53:00Z')), '17m left');
  eq(fmtResetLeft('2026-09-01T00:14:00Z', Date.parse('2026-08-31T21:53:00Z')), '2h 21m left');
  eq(fmtResetLeft('2026-08-31T22:53:00Z', Date.parse('2026-08-31T21:53:00Z')), '1h 0m left');
});

await t('fmtResetLeft names the DAY once the reset is more than a day out', () => {
  // 2026-09-05T05:00Z is 1:00am Saturday in New York; the label must be his day,
  // not UTC's, which is the whole reason the zone is a parameter.
  const s = fmtResetLeft('2026-09-05T05:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: OWNER_TZ });
  eq(s, 'Sat 5 Sep, 4d 5h left');
  // In UTC the same instant is still the 5th, but at 5am, and still Saturday.
  eq(fmtResetLeft('2026-09-05T05:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: 'UTC' }), 'Sat 5 Sep, 4d 5h left');
  // A reset just past midnight UTC on the 5th is the 4th in New York.
  eq(
    fmtResetLeft('2026-09-05T01:00:00Z', Date.parse('2026-09-01T00:00:00Z'), { timeZone: OWNER_TZ }),
    'Fri 4 Sep, 4d 1h left',
    'the day label must be rendered in HIS zone',
  );
});

await t('fmtResetLeft never prints a negative clock and never throws on junk', () => {
  eq(fmtResetLeft('2026-08-31T20:00:00Z', NOW), 'due now');
  eq(fmtResetLeft(NOW, NOW), 'due now');
  eq(fmtResetLeft(null, NOW), 'unknown');
  eq(fmtResetLeft('not a date', NOW), 'unknown');
  eq(fmtResetLeft(undefined, NOW), 'unknown');
});

await t('fmtResetLeft takes ISO strings, epoch MILLISECONDS and Dates — never seconds', () => {
  eq(fmtResetLeft(NOW + 90 * 60_000, NOW), '1h 30m left');
  eq(fmtResetLeft(new Date(NOW + 90 * 60_000), NOW), '1h 30m left');
  // usage-limits.mjs's fmtLeft takes epoch SECONDS. Feeding those here must read
  // as long-past, i.e. "due now", not as a plausible number — the two unit
  // contracts must not silently blend.
  eq(fmtResetLeft(Math.floor((NOW + 90 * 60_000) / 1000), NOW), 'due now');
});

await t('fmtResetClock prints his local clock, and adds the day only when it is not today', () => {
  // 22:10Z on 2026-08-31 is 6:10pm the same day in New York.
  eq(fmtResetClock('2026-08-31T22:10:00Z', { timeZone: OWNER_TZ, now: NOW }), '6:10pm');
  // 05:00Z on 2026-09-05 is 1:00am Saturday the 5th in New York — a different day.
  eq(fmtResetClock('2026-09-05T05:00:00Z', { timeZone: OWNER_TZ, now: NOW }), 'Sat 5 Sep 1:00am');
  // Same instant read in UTC is 5:00am, still the 5th.
  eq(fmtResetClock('2026-09-05T05:00:00Z', { timeZone: 'UTC', now: NOW }), 'Sat 5 Sep 5:00am');
  eq(fmtResetClock(null, { timeZone: OWNER_TZ, now: NOW }), 'unknown');
});

// ---------------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------------

await t('the real response body normalizes to the numbers /usage prints', () => {
  const u = normalizeUsage(REAL_USAGE);
  eq(u.fiveHour.percent, 32);
  eq(u.fiveHour.resetsAt, '2026-08-31T22:10:00.241439+00:00');
  eq(u.fiveHour.severity, 'normal');
  eq(u.fiveHour.locked, null);
  eq(u.sevenDay.percent, 24);
  eq(u.sevenDay.severity, 'normal');
  eq(u.scoped, [{ label: 'Fable', percent: 4, resetsAt: '2026-09-05T05:00:00.241715+00:00' }]);
  eq(u.extraUsage, { enabled: false, percent: 0, usedCredits: 0, monthlyLimit: 50000 });
});

await t('limits[] wins over the flat five_hour/seven_day pair when both are present', () => {
  // Same body, but the two views disagree. limits[] is the richer, newer one, so
  // it must be the one that shows — otherwise a server-side migration would
  // quietly freeze the display on stale numbers.
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  body.five_hour.utilization = 99;
  body.seven_day.utilization = 88;
  const u = normalizeUsage(body);
  eq(u.fiveHour.percent, 32, 'the flat five_hour overrode limits[]');
  eq(u.sevenDay.percent, 24, 'the flat seven_day overrode limits[]');
});

await t('a body with no limits[] falls back to the flat pair rather than blanking', () => {
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  delete body.limits;
  body.seven_day_opus = { utilization: 12.0, resets_at: '2026-09-05T05:00:00Z', locked_reason: null };
  const u = normalizeUsage(body);
  eq(u.fiveHour.percent, 32);
  eq(u.fiveHour.severity, null, 'severity is a limits[]-only field; inventing one would be a made-up threshold');
  eq(u.sevenDay.percent, 24);
  eq(u.scoped, [{ label: 'Opus', percent: 12, resetsAt: '2026-09-05T05:00:00Z' }]);
});

await t('locked_reason is carried through, because an exhausted window must say so', () => {
  const body = JSON.parse(JSON.stringify(REAL_USAGE));
  body.five_hour.locked_reason = 'usage_limit_reached';
  body.limits[0].percent = 100;
  const u = normalizeUsage(body);
  eq(u.fiveHour.locked, 'usage_limit_reached');
  eq(u.fiveHour.percent, 100);
});

await t('an unrecognisable body normalizes to null instead of throwing into a reply', () => {
  eq(normalizeUsage(null), null);
  eq(normalizeUsage(undefined), null);
  eq(normalizeUsage('a string'), null);
  eq(normalizeUsage({}), null);
  eq(normalizeUsage({ limits: 'not an array' }), null);
  eq(normalizeUsage({ limits: [null, { kind: 'session' }] }).fiveHour.percent, null, 'a percent-less window is n/a, not a crash');
});

// ---------------------------------------------------------------------------
// NETWORK — every failure degrades to null, none of them throws
// ---------------------------------------------------------------------------

const res = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (!json) throw new SyntaxError('Unexpected token < in JSON');
    return body;
  },
});

await t('fetchUsage sends the three headers Claude Code sends, and no others that matter', async () => {
  let seen = null;
  const u = await fetchUsage('tok-abc', {
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return res(200, REAL_USAGE);
    },
  });
  eq(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  eq(seen.opts.headers.Authorization, 'Bearer tok-abc');
  eq(seen.opts.headers['anthropic-beta'], OAUTH_BETA);
  ok(/^claude-cli\//.test(seen.opts.headers['User-Agent']), 'the CLI User-Agent is part of the contract');
  ok(seen.opts.signal, 'no AbortController signal, so a hung request would hang a reply');
  eq(u.fiveHour.percent, 32);
});

await t('fetchUsage can ask for the wall-clock-only variant', async () => {
  let seen = null;
  await fetchUsage('tok', { wallClockOnly: true, fetchImpl: async (url) => ((seen = url), res(200, REAL_USAGE)) });
  eq(seen, 'https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1');
});

await t('401, 500, a timeout and malformed JSON all yield null and never throw', async () => {
  eq(await fetchUsage('tok', { fetchImpl: async () => res(401, { error: 'unauthorized' }) }), null, '401');
  eq(await fetchUsage('tok', { fetchImpl: async () => res(500, {}) }), null, '500');
  eq(await fetchUsage('tok', { fetchImpl: async () => res(200, null, { json: false }) }), null, 'malformed JSON');
  eq(
    await fetchUsage('tok', {
      fetchImpl: async () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      },
    }),
    null,
    'abort',
  );
  eq(
    await fetchUsage('tok', {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    }),
    null,
    'DNS failure',
  );
  eq(await fetchUsage('tok', { fetchImpl: async () => undefined }), null, 'a fetch that resolves to nothing');
  eq(await fetchUsage(null, { fetchImpl: async () => res(200, REAL_USAGE) }), null, 'no token means no request');
});

await t('fetchUsage really does abort on a slow server rather than waiting forever', async () => {
  const started = Date.now();
  const out = await fetchUsage('tok', {
    timeoutMs: 40,
    fetchImpl: (url, opts) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(res(200, REAL_USAGE)), 5_000);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  eq(out, null);
  ok(Date.now() - started < 2_000, 'the abort did not fire; a hung usage call would hang the reply carrying it');
});

await t('fetchProfile returns the identity that survives a token rotation', async () => {
  const p = await fetchProfile('tok', { fetchImpl: async () => res(200, REAL_PROFILE) });
  eq(p, { email: 'second@example.com', fullName: 'Sam Owner', tier: 'default_claude_max_20x' });
  eq(await fetchProfile('tok', { fetchImpl: async () => res(200, { nope: 1 }) }), null);
  eq(await fetchProfile('tok', { fetchImpl: async () => res(403, {}) }), null);
});

// ---------------------------------------------------------------------------
// REFRESH — the only call in the module that is allowed to throw
// ---------------------------------------------------------------------------

const PREV = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: NOW - 1000,
  refreshTokenExpiresAt: NOW + 30 * 86400_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
};

await t('refresh posts the documented body and maps the response into a claudeAiOauth blob', async () => {
  let seen = null;
  const blob = await refreshAccessToken({
    refreshToken: 'old-refresh',
    previous: PREV,
    now: NOW,
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return res(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800, scope: 'user:inference user:profile' });
    },
  });
  eq(seen.url, 'https://api.anthropic.com/v1/oauth/token');
  eq(seen.opts.method, 'POST');
  eq(JSON.parse(seen.opts.body), { grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: CLAUDE_CODE_CLIENT_ID });
  eq(blob.accessToken, 'new-access');
  eq(blob.refreshToken, 'new-refresh');
  eq(blob.expiresAt, NOW + 28800_000);
  eq(blob.scopes, ['user:inference', 'user:profile']);
  eq(blob.subscriptionType, 'max', 'the carried-through fields must survive a refresh');
  eq(blob.rateLimitTier, 'default_claude_max_20x');
  eq(blob.refreshTokenExpiresAt, PREV.refreshTokenExpiresAt);
});

await t('a response that does not rotate the refresh token keeps the old one rather than writing undefined', async () => {
  const blob = await refreshAccessToken({
    refreshToken: 'old-refresh',
    previous: PREV,
    now: NOW,
    fetchImpl: async () => res(200, { access_token: 'new-access', expires_in: 3600 }),
  });
  eq(blob.refreshToken, 'old-refresh');
  eq(blob.expiresAt, NOW + 3600_000);
});

await t('refresh THROWS on every failure, and the message never carries the body', async () => {
  const e401 = await throws(
    () => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(400, { error: 'invalid_grant', secret_echo: 'sk-ant-oat01-LEAK' }) }),
    /HTTP 400 \(invalid_grant\)/,
  );
  ok(!e401.message.includes('LEAK'), 'the error message echoed the response body');
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(500, null, { json: false }) }), /HTTP 500/);
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(200, null, { json: false }) }), /not JSON/);
  await throws(() => refreshAccessToken({ refreshToken: 'r', fetchImpl: async () => res(200, { nope: 1 }) }), /no access token/);
  await throws(
    () =>
      refreshAccessToken({
        refreshToken: 'r',
        fetchImpl: async () => {
          throw new Error('socket hang up');
        },
      }),
    /could not be sent \(network error\)/,
  );
  await throws(() => refreshAccessToken({ refreshToken: null }), /refresh token is required/);
});

// ---------------------------------------------------------------------------
// THE READER — a real account store on a mkdtemp file, a fake keychain, a fake
// fetch, a pinned clock. Nothing real is touched.
// ---------------------------------------------------------------------------

// Same wire-format-decoding fake as accounts.test.mjs: it parses the exact
// `security -i` + hex payload the daemon sends, so the write path is real.
function fakeKeychain(blob) {
  const box = { blob: blob ? JSON.parse(JSON.stringify(blob)) : null };
  box.run = async (args, stdin = null) => {
    if (args[0] === 'find-generic-password') {
      return box.blob ? { code: 0, stdout: JSON.stringify(box.blob) } : { code: 44, stdout: '' };
    }
    if (args[0] === '-i' && stdin) {
      const m = stdin.match(/^add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]+)"\n$/);
      if (!m) return { code: 1, stdout: '' };
      box.blob = JSON.parse(Buffer.from(m[3], 'hex').toString('utf8'));
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };
  return box;
}

const oauthFor = (seed, over = {}) => ({
  accessToken: `acc-${seed}`,
  refreshToken: `ref-${seed}`,
  expiresAt: NOW + 4 * 3600_000,
  refreshTokenExpiresAt: NOW + 25 * 86400_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  ...over,
});

let n = 0;
function rig({ seed, liveOauth, fetchImpl, logs = [] } = {}) {
  const file = path.join(TMP, `accounts-${n++}.json`);
  writeFileSync(file, JSON.stringify(seed, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: liveOauth, mcpOAuth: { heygen: { token: 'machine-scoped' } } });
  const store = createAccountStore({
    file,
    credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }),
    log: (m) => logs.push(`[accounts] ${m}`),
  });
  const usage = createAccountUsage({
    store,
    fetchImpl,
    now: () => NOW,
    log: (m) => logs.push(`[usage] ${m}`),
  });
  invalidateUsageCache();
  return { file, store, usage, kc, logs, onDisk: () => JSON.parse(readFileSync(file, 'utf8')) };
}

const SEED = [
  { name: 'second@example.com', email: 'second@example.com', claudeAiOauth: oauthFor('a'), limitedUntil: null, lastActiveAt: null },
  { name: 'first@example.com', email: null, claudeAiOauth: oauthFor('b'), limitedUntil: null, lastActiveAt: null },
  { name: 'third@example.com', email: null, claudeAiOauth: oauthFor('c'), limitedUntil: null, lastActiveAt: null },
];

// A fetch that answers usage for every token and records which tokens asked.
function usageFetch(perToken = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    calls.push({ url, tok });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    if (url.includes('/oauth/usage')) {
      const pct = perToken[tok];
      if (pct === 'fail') return res(500, {});
      const body = JSON.parse(JSON.stringify(REAL_USAGE));
      if (typeof pct === 'number') {
        body.limits[0].percent = pct;
        body.five_hour.utilization = pct;
      }
      return res(200, body);
    }
    return res(404, {});
  };
  return { impl, calls };
}

await t('all() reads every account and marks the live one, matching by fingerprint', async () => {
  const f = usageFetch({ 'acc-a': 32, 'acc-b': 0, 'acc-c': 71 });
  const r = rig({ seed: SEED, liveOauth: oauthFor('b'), fetchImpl: f.impl });
  const { active, rows } = await r.usage.all();
  eq(active.name, 'first@example.com');
  eq(active.matchedBy, 'refreshToken');
  eq(rows.map((x) => x.name), SEED.map((s) => s.name));
  eq(rows.map((x) => x.state), ['ok', 'ok', 'ok']);
  eq(rows.map((x) => x.live), [false, true, false]);
  eq(rows.map((x) => x.usage.fiveHour.percent), [32, 0, 71]);
  eq(f.calls.filter((c) => c.url.includes('/profile')).length, 0, 'a fingerprint match must not cost a profile call');
});

await t('a live account whose tokens have rotated is identified by its profile email, not printed as unknown', async () => {
  // This is the "Active: unknown a…8dkwAA/r…U7DQAA" bug: after the running
  // session refreshes, the keychain blob matches no stored token.
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('rotated-beyond-recognition'), fetchImpl: f.impl });
  const active = await r.usage.resolveActive();
  eq(active.matchedBy, 'profileEmail');
  eq(active.name, 'second@example.com', 'the profile email must resolve the slot');
  eq(active.fullName, 'Sam Owner');
  ok(!active.liveFingerprint.includes('rotated-beyond-recognition'), 'the fingerprint leaked the token');
});

await t('an unreadable keychain leaves the active account unknown without throwing', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: null, fetchImpl: f.impl });
  const active = await r.usage.resolveActive();
  eq(active.name, null);
  eq(active.liveFingerprint, 'none');
});

await t('the live account is read from the KEYCHAIN, never from the stale copy on disk', async () => {
  // Disk holds an EXPIRED token for the live slot; the keychain holds a fresh
  // one. Reading disk would trigger a refresh of the account a live session owns.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[0].claudeAiOauth = oauthFor('a', { expiresAt: NOW - 3600_000 });
  const live = oauthFor('a', { accessToken: 'acc-a-fresh-from-keychain' });
  const f = usageFetch({ 'acc-a-fresh-from-keychain': 32 });
  const r = rig({ seed, liveOauth: live, fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[0].state, 'ok');
  ok(
    f.calls.some((c) => c.tok === 'acc-a-fresh-from-keychain'),
    'the keychain token was not used for the live account',
  );
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'THE LIVE ACCOUNT WAS REFRESHED — that races the running session');
  eq(r.onDisk()[0].claudeAiOauth.accessToken, 'acc-a', 'the live slot on disk must not be rewritten by a usage read');
});

await t('an idle account with a past expiresAt IS refreshed, once, and persisted BEFORE the token is used', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  let diskAtUsageTime = null;
  let refreshes = 0;
  const impl = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      refreshes++;
      return res(200, { access_token: 'acc-c-refreshed', refresh_token: 'ref-c-rotated', expires_in: 28800 });
    }
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    const tok = String(opts.headers.Authorization).replace('Bearer ', '');
    if (tok === 'acc-c-refreshed') {
      // Ordering proof: read the file at the exact moment the new token is used.
      diskAtUsageTime = JSON.parse(readFileSync(r.file, 'utf8'));
    }
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();

  eq(refreshes, 1, 'exactly one refresh attempt, no retry loop');
  eq(rows[2].state, 'ok');
  eq(rows[2].refreshed, true);
  ok(diskAtUsageTime, 'the refreshed token was never used, so the ordering could not be proven');
  eq(diskAtUsageTime[2].claudeAiOauth.accessToken, 'acc-c-refreshed', 'the rotated blob was used BEFORE it was persisted');
  eq(diskAtUsageTime[2].claudeAiOauth.refreshToken, 'ref-c-rotated');
  // ...and it stuck, with everything else in the slot intact.
  const after = r.onDisk();
  eq(after[2].claudeAiOauth.expiresAt, NOW + 28800_000);
  eq(after[2].claudeAiOauth.subscriptionType, 'max', 'the refresh dropped a carried-through field');
  eq(after[2].name, 'third@example.com');
  eq(after[0].claudeAiOauth.accessToken, 'acc-a', 'the refresh rewrote a sibling slot');
  ok(
    r.logs.some((l) => l.includes('refreshed the expired token')),
    'a refresh must be logged',
  );
  ok(!r.logs.some((l) => l.includes('acc-c-refreshed') || l.includes('ref-c-rotated')), 'a log line leaked a token');
});

await t('a still-valid idle token is used as-is, with no refresh at all', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  await r.usage.all();
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0);
});

await t('a token inside the five-minute expiry skew is refreshed rather than sent to die in flight', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW + 60_000 }); // valid, but not for long
  let refreshes = 0;
  const impl = async (url) => {
    if (url.includes('/oauth/token')) {
      refreshes++;
      return res(200, { access_token: 'acc-b-refreshed', refresh_token: 'ref-b2', expires_in: 28800 });
    }
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  await r.usage.all();
  eq(refreshes, 1);
});

await t('a PERSIST FAILURE surfaces as an error, never as a usage number', async () => {
  // The worst outcome in the module: the token in hand works, the one on disk is
  // dead. It must not be papered over with a percentage.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(200, { access_token: 'sk-ant-oat01-refreshed-c-AAAAAA', refresh_token: 'sk-ant-ort01-rotated-c-BBBBBB', expires_in: 28800 });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  r.store.bankOauth = () => {
    throw new Error('EROFS: read-only file system');
  };
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'persist-failed');
  eq(rows[2].usage, null, 'a persist failure was dressed up as a working account');
  ok(/REFRESHED BUT NOT SAVED/.test(rows[2].error), rows[2].error);
  ok(/re-capture this account/.test(rows[2].error), 'the error must say what to do about it');
  ok(!rows[2].error.includes('sk-ant-oat01-refreshed-c-AAAAAA'), 'the error message leaked a token');
  ok(!rows[2].error.includes('sk-ant-ort01-rotated-c-BBBBBB'), 'the error message leaked a refresh token');
  ok(r.logs.some((l) => l.includes('REFRESHED BUT NOT SAVED')), 'this failure must be loud in the log too');
  // ...and the renderer says so rather than showing a bar.
  ok(/⚠️/.test(renderUsageReport({ active: { name: 'second@example.com' }, rows }, { now: NOW })));
});

await t('a store that REFUSES the write (unknown slot) is treated exactly like a throw', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(200, { access_token: 'x', refresh_token: 'y', expires_in: 100 });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  r.store.bankOauth = () => ({ ok: false, error: 'no account slot named "third@example.com"' });
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'persist-failed');
  eq(rows[2].usage, null);
});

await t('a failed refresh degrades that ONE account and leaves the others intact', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const impl = async (url) => {
    if (url.includes('/oauth/token')) return res(400, { error: 'invalid_grant' });
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: impl });
  const { rows } = await r.usage.all();
  eq(rows[2].state, 'refresh-failed');
  ok(/invalid_grant/.test(rows[2].error));
  eq(rows[0].state, 'ok', 'one broken account took the whole reply down');
  eq(rows[1].state, 'ok');
  eq(r.onDisk()[2].claudeAiOauth.accessToken, 'acc-c', 'a failed refresh must not touch disk');
});

await t('a dead refreshTokenExpiresAt short-circuits with the capture-again instruction', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[1].claudeAiOauth = oauthFor('b', { expiresAt: NOW - 60_000, refreshTokenExpiresAt: NOW - 86400_000 });
  const f = usageFetch({});
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'credentials-expired');
  eq(rows[1].usage, null);
  ok(/\/account capture first@example\.com/.test(rows[1].error), rows[1].error);
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'a dead refresh token must not be spent on an attempt');
  eq(f.calls.filter((c) => c.tok === 'acc-b').length, 0, 'an expired account must not be asked for usage either');
});

await t('a slot with no credentials is reported, not skipped', async () => {
  const seed = JSON.parse(JSON.stringify(SEED));
  delete seed[1].claudeAiOauth;
  const f = usageFetch({});
  const r = rig({ seed, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'no-credentials');
});

await t('when the live account cannot be identified, NOTHING is refreshed', async () => {
  // Rule 2: an unidentifiable keychain means any refresh might be racing the
  // live session, so an expired idle token degrades instead of rotating.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed[2].claudeAiOauth = oauthFor('c', { expiresAt: NOW - 60_000 });
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url.includes('/oauth/profile')) return res(403, {}); // profile fallback fails too
    if (url.includes('/oauth/token')) return res(200, { access_token: 'nope', expires_in: 1 });
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed, liveOauth: oauthFor('stranger'), fetchImpl: impl });
  const { active, rows } = await r.usage.all();
  eq(active.name, null);
  eq(calls.filter((u) => u.includes('/oauth/token')).length, 0, 'a refresh ran with the live account unknown');
  eq(rows[2].state, 'unavailable');
  ok(/could not be identified/.test(rows[2].error));
  eq(rows[0].state, 'ok', 'the accounts with valid tokens still report');
});

await t('a usage call that fails degrades to "usage unavailable" and never breaks the reply', async () => {
  const f = usageFetch({ 'acc-b': 'fail' });
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  const { rows } = await r.usage.all();
  eq(rows[1].state, 'unavailable');
  eq(rows[1].usage, null);
  eq(rows[0].state, 'ok');
  eq(usageLine(rows[1]), null, '/status must omit the line, not print an error into a liveness view');
  // Same property as before the /account rewrite: a dead usage call becomes a
  // visible reason on that account's row, never a blank and never an exception.
  eq(accountUsageBlock(rows[1]), ['   ⚠️ usage unavailable']);
});

await t('every account is fetched CONCURRENTLY, so one slow account does not serialise the rest', async () => {
  let inFlight = 0;
  let peak = 0;
  const impl = async (url) => {
    if (url.includes('/oauth/profile')) return res(200, REAL_PROFILE);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r2) => setTimeout(r2, 20));
    inFlight--;
    return res(200, REAL_USAGE);
  };
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: impl });
  await r.usage.all();
  eq(peak, 3, 'the three usage reads ran in series');
});

// ---------------------------------------------------------------------------
// TTL CACHE
// ---------------------------------------------------------------------------

await t('a second read inside the TTL serves the cache and makes no second request', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: oauthFor('a'), fetchImpl: f.impl });
  await r.usage.all();
  const first = f.calls.length;
  const again = await r.usage.all();
  eq(f.calls.length, first, 'the cache was bypassed; /status would hit the API on every call');
  eq(again.rows[0].cached, true);
  eq(again.rows[0].usage.fiveHour.percent, 32, 'a cached row must still carry its numbers');
});

await t('the cache expires, and invalidateUsageCache() drops it immediately', async () => {
  const f = usageFetch({});
  let clock = NOW;
  const file = path.join(TMP, `accounts-ttl.json`);
  writeFileSync(file, JSON.stringify(SEED, null, 2), { mode: 0o600 });
  const kc = fakeKeychain({ claudeAiOauth: oauthFor('a') });
  const store = createAccountStore({ file, credentials: createKeychainStore({ account: 'owner', runSecurity: (...a) => kc.run(...a) }), log: () => {} });
  const usage = createAccountUsage({ store, fetchImpl: f.impl, now: () => clock, ttlMs: 60_000, log: () => {} });
  invalidateUsageCache();

  await usage.all();
  const first = f.calls.length;
  clock = NOW + 59_000;
  await usage.all();
  eq(f.calls.length, first, 'the cache expired early');
  clock = NOW + 61_000;
  await usage.all();
  ok(f.calls.length > first, 'the cache never expired, so /usage would show a stale window forever');

  const second = f.calls.length;
  invalidateUsageCache();
  await usage.all();
  ok(f.calls.length > second, 'invalidateUsageCache() did not force a re-read (post-swap /account would lie)');
});

await t('activeOnly() reads just the live account, for /status', async () => {
  const f = usageFetch({ 'acc-b': 44 });
  const r = rig({ seed: SEED, liveOauth: oauthFor('b'), fetchImpl: f.impl });
  const { active, row } = await r.usage.activeOnly();
  eq(active.name, 'first@example.com');
  eq(row.state, 'ok');
  eq(row.usage.fiveHour.percent, 44);
  eq(f.calls.filter((c) => c.url.includes('/oauth/usage')).length, 1, '/status must not fetch all three accounts');
});

await t('activeOnly() still reports usage for a live login that is not enrolled as a slot', async () => {
  // A login nobody ran /account capture on still has a working keychain token.
  // Reporting "no credentials captured" for the account that is ACTUALLY
  // running would be the most misleading line /status could print.
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, tok: String(opts.headers.Authorization).replace('Bearer ', '') });
    if (url.includes('/oauth/profile')) {
      return res(200, { ...REAL_PROFILE, account: { ...REAL_PROFILE.account, email: 'fourth@example.com' } });
    }
    const body = JSON.parse(JSON.stringify(REAL_USAGE));
    body.limits[0].percent = 61;
    return res(200, body);
  };
  const f = { calls };
  const r = rig({ seed: SEED, liveOauth: oauthFor('stranger'), fetchImpl: impl });
  const { active, row } = await r.usage.activeOnly();
  eq(active.matchedBy, 'profileEmailUnenrolled', 'the profile email matches no enrolled slot');
  eq(active.email, 'fourth@example.com');
  eq(row.state, 'ok');
  eq(row.live, true);
  eq(row.usage.fiveHour.percent, 61);
  eq(f.calls.filter((c) => c.url.includes('/oauth/token')).length, 0, 'the LIVE account must never be refreshed');
  ok(usageLine(row, { now: NOW }).includes('5h 61%'), usageLine(row, { now: NOW }));
});

await t('activeOnly() with an unreadable keychain returns no row rather than throwing', async () => {
  const f = usageFetch({});
  const r = rig({ seed: SEED, liveOauth: null, fetchImpl: f.impl });
  const { row } = await r.usage.activeOnly();
  eq(row, null);
});

// ---------------------------------------------------------------------------
// RENDERERS — the exact strings the owner reads on their phone
// ---------------------------------------------------------------------------

const OK_ROW = {
  name: 'second@example.com',
  email: 'second@example.com',
  live: true,
  state: 'ok',
  usage: normalizeUsage(REAL_USAGE),
};

await t('activeLine names the live account — the "Active: unknown" bug, in one string', () => {
  // The name is in a CODE span, not bold. Telegram auto-linkifies a bare email
  // in message text into a blue mailto link; a code entity claims the range so
  // no email entity is emitted over it. Asserted as an exact string here (and
  // by the no-bare-email test below across every renderer) so a future refactor
  // back to **bold** fails loudly instead of quietly restoring the blue links.
  eq(
    activeLine({ name: 'second@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…8dkwAA/r…U7DQAA' }),
    'Active: `second@example.com` `a…8dkwAA/r…U7DQAA`',
  );
  // The real case on this machine: the running session refreshed its own token,
  // so nothing fingerprint-matches and the profile email is what identifies it.
  eq(
    activeLine({ name: 'second@example.com', matchedBy: 'profileEmail', liveFingerprint: 'a…8dkwAA/r…U7DQAA' }),
    'Active: `second@example.com` `a…8dkwAA/r…U7DQAA` (identified by profile — its tokens have rotated since capture)',
  );
  eq(
    activeLine({ name: null, email: 'fourth@example.com', matchedBy: 'profileEmailUnenrolled', liveFingerprint: 'a…X/r…Y' }),
    'Active: `fourth@example.com` `a…X/r…Y` — signed in but not enrolled, run /account capture <name> to bank it',
  );
  // Only when BOTH the fingerprint and the profile fail is it genuinely unknown.
  eq(activeLine({ name: null, email: null, liveFingerprint: 'a…X/r…Y' }), 'Active: unknown `a…X/r…Y`, run /account capture <name> to bank it');
  eq(activeLine(null), 'Active: unknown `none`, run /account capture <name> to bank it');
  eq(activeLine({}), 'Active: unknown `none`, run /account capture <name> to bank it');
});

await t('usageLine is the one compact /status line, and nothing more', () => {
  const line = usageLine(OK_ROW, { now: NOW });
  ok(line.startsWith('👤 second@example.com'), line);
  ok(/5h 32% · resets .+ · .+ left/.test(line), `5h must carry BOTH the clock and the countdown: ${line}`);
  ok(/wk 24% · resets .+ · .+ left/.test(line), `wk must carry BOTH the clock and the countdown: ${line}`);
  eq(line.split('\n').length, 3, 'one header + one row per window');
  eq(usageLine(null), null);
  eq(usageLine({ state: 'unavailable' }), null);
  eq(usageLine({ name: 'x', state: 'ok', usage: { fiveHour: null, sevenDay: null, scoped: [] } }), null);
});

// REPLACES the old accountUsageSuffix test. That test protected four
// properties of the per-account usage lines on /account: one line per window,
// the reset CLOCK present, the time LEFT present, a locked window flagged, and
// an error row passed through verbatim rather than swallowed. The suffix is now
// a bar block (accountUsageBlock) instead of a bare inline; every one of those
// properties is asserted below on the new shape, plus the bar itself.
await t('accountUsageBlock carries the bar, the reset clock AND the time left, and flags a locked window', () => {
  const b = accountUsageBlock(OK_ROW, { now: NOW });
  eq(b.length, 2, 'one row per window');
  ok(/^   `5h ███░░░░░░░  32%` resets /.test(b[0]), b[0]);
  ok(/^   `wk ██░░░░░░░░  24%` resets /.test(b[1]), b[1]);
  // Both halves, still: the clock says WHEN, the span says HOW LONG. Only the
  // trailing word "left" was dropped, so the span must still be there.
  ok(/resets 6:10pm · 17m$/.test(b[0]), `the 5h row lost its clock or its countdown: ${b[0]}`);
  ok(/resets Sat 1:00am · 4d 7h$/.test(b[1]), `the wk row lost its clock or its countdown: ${b[1]}`);
  // The bar must be usageBar()'s output, not a second renderer's: same account,
  // same percent, the /usage view and this one have to agree cell for cell.
  ok(b[0].includes(usageBar(32)) && b[1].includes(usageBar(24)), 'the bars drifted from usageBar()');

  const locked = JSON.parse(JSON.stringify(OK_ROW));
  locked.usage.fiveHour.percent = 100;
  locked.usage.fiveHour.locked = 'usage_limit_reached';
  ok(accountUsageBlock(locked, { now: NOW })[0].includes('100%` ⛔'), 'a locked window must still be flagged');
  // An error row is passed through verbatim — never swallowed into a blank.
  eq(
    accountUsageBlock({ state: 'refresh-failed', error: 'token refresh rejected: HTTP 400 (invalid_grant)' })[0],
    '   ⚠️ token refresh rejected: HTTP 400 (invalid_grant)',
  );
  eq(accountUsageBlock(null), [], 'no usage row means no lines, not a fabricated one');
});

const ACCT_ROWS = [
  { name: 'second@example.com', fingerprint: 'a…f-rwAA/r…qGHAAA', captured: true, limited: false, limitedUntil: null, lastActiveAt: new Date(NOW - 6 * 60_000).toISOString() },
  { name: 'first@example.com', fingerprint: 'a…QVmgAA/r…f0NAAA', captured: true, limited: false, limitedUntil: null, lastActiveAt: new Date(NOW - 3 * 86_400_000).toISOString() },
  { name: 'third@example.com', fingerprint: 'a…AAAAAA/r…BBBBBB', captured: true, limited: true, limitedUntil: Math.round((NOW + 130 * 60_000) / 1000), lastActiveAt: null },
];
const ACCT_USAGE = [
  { name: 'second@example.com', state: 'ok', usage: normalizeUsage(REAL_USAGE) },
  { name: 'first@example.com', state: 'ok', usage: normalizeUsage(REAL_USAGE) },
];

await t('renderAccountList puts the LIVE account first and marks it', () => {
  // The live one is second in the file. He opens /account to see where he is,
  // so it has to be the first thing on the screen, not found by hunting ▶︎.
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…X/r…Y' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  const names = [...out.matchAll(/^(▶︎|• ) `(.+?)`/gm)].map((m) => [m[1], m[2]]);
  eq(names[0], ['▶︎', 'first@example.com'], `the live account was not first:\n${out}`);
  eq(names.length, 3, 'an account went missing from the list');
  eq(names.filter(([m]) => m === '▶︎').length, 1, 'exactly one row is the live one');
  // ▶︎ already says which one is live, so the Active: header is redundant here.
  ok(!out.includes('Active:'), `the redundant Active: header survived:\n${out}`);
});

await t('renderAccountList keeps the Active: header ONLY when ▶︎ can say nothing', () => {
  // Signed in but not enrolled: no row can carry ▶︎, so the header is the only
  // thing naming the live login — and its fingerprint is the only handle on it.
  const unenrolled = renderAccountList(
    { rows: ACCT_ROWS, live: { name: null, email: 'fourth@example.com', matchedBy: 'profileEmailUnenrolled', liveFingerprint: 'a…X/r…Y' }, usageRows: ACCT_USAGE },
    { now: NOW },
  );
  ok(unenrolled.includes('Active: `fourth@example.com` `a…X/r…Y`'), unenrolled);
  ok(unenrolled.includes('signed in but not enrolled'), unenrolled);
  // Unidentifiable entirely.
  const unknown = renderAccountList({ rows: ACCT_ROWS, live: { liveFingerprint: 'a…X/r…Y' }, usageRows: [] }, { now: NOW });
  ok(unknown.includes('Active: unknown `a…X/r…Y`'), unknown);
  // A live name that DOES match a slot gets no header.
  const matched = renderAccountList({ rows: ACCT_ROWS, live: { name: 'second@example.com' }, usageRows: ACCT_USAGE }, { now: NOW });
  ok(!matched.includes('Active:'), matched);
});

await t('renderAccountList drops the daily noise and keeps the states that are not the default', () => {
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'second@example.com' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  // Fingerprints moved to /usage: three token digests on the daily view were
  // clutter once "Active: unknown" was fixed.
  ok(!out.includes('a…f-rwAA'), `a fingerprint is still on the /account rows:\n${out}`);
  ok(!out.includes('a…QVmgAA') && !out.includes('a…AAAAAA'), 'a fingerprint is still on the /account rows');
  // "✅ available" is the default state; the absence of ⛔ already says it.
  ok(!out.includes('✅'), `the redundant availability tick survived:\n${out}`);
  // ⛔ limited keeps its remaining time.
  ok(/⛔ limited · 2h 10m/.test(out), `the limited row lost its countdown:\n${out}`);
  // "last used 6m ago" on the row you are looking at is noise; three days idle
  // is not, and is the only version of that fact that survives.
  ok(!out.includes('last used'), 'the noisy last-used line survived');
  ok(!/idle 6m/.test(out), 'a six-minute-old account was reported as idle');
  ok(/idle 3d/.test(out), `a three-day-idle account lost its idle marker:\n${out}`);
  // An account with no usage row still appears, with a reason.
  ok(out.includes('third@example.com'), 'an account without usage vanished from the list');
  ok(out.includes('⚠️ usage unavailable'), out);
  // One footer line, and it no longer documents /account capture (that is /help).
  const tail = out.trim().split('\n').slice(-1)[0];
  eq(tail, 'Tap to swap · /usage for detail');
  ok(!out.includes('/account capture'), 'the footer still carries the capture form');
});

await t('renderAccountList still marks an uncaptured slot, and survives an empty list', () => {
  const rows = [{ name: 'empty@slot.app', fingerprint: 'none', captured: false, limited: false }];
  const out = renderAccountList({ rows, live: { name: 'empty@slot.app' }, usageRows: [] }, { now: NOW });
  ok(out.includes('⚠️ no credentials captured'), out);
  const none = renderAccountList({ rows: [], live: null, usageRows: [] }, { now: NOW });
  ok(none.includes('Active: unknown'), 'an empty list must still say what the live login is');
  ok(none.includes('👤'), none);
});

await t('usageBrief is the one-line headroom summary, and never invents one', () => {
  eq(usageBrief({ state: 'ok', usage: normalizeUsage(REAL_USAGE) }), '5h 32% · wk 24%');
  eq(usageBrief(null), null);
  eq(usageBrief({ state: 'unavailable', usage: null }), null, 'a broken row must not render as 0%');
  eq(usageBrief({ state: 'ok', usage: { fiveHour: null, sevenDay: null, scoped: [] } }), null);
  const locked = normalizeUsage(REAL_USAGE);
  locked.fiveHour = { percent: 100, resetsAt: null, severity: null, locked: 'usage_limit_reached' };
  ok(usageBrief({ state: 'ok', usage: locked }).startsWith('5h 100% ⛔'), 'a locked window must be flagged here too');
});

await t('swapConfirmation stands on its own in three lines or fewer', () => {
  const full = swapConfirmation({ to: 'first@example.com', from: 'second@example.com', usage: { state: 'ok', usage: normalizeUsage(REAL_USAGE) } });
  eq(full, ['🔄 Now on `first@example.com`', 'was `second@example.com` · MCP tokens kept', '5h 32% · wk 24%'].join('\n'));
  ok(full.split('\n').length <= 3, 'the confirmation grew past three lines');
  // No cached usage: the third line is OMITTED rather than the confirmation
  // being delayed by a network read for it.
  eq(swapConfirmation({ to: 'a@b.c', from: 'd@e.f', usage: null }).split('\n').length, 2);
  // No previous account (nothing matched a slot) — the line still reads.
  eq(swapConfirmation({ to: 'a@b.c' }), '🔄 Now on `a@b.c`\nMCP tokens kept');
});

await t('swapFailure keeps the routine/urgent distinction accounts.mjs draws', () => {
  // Routine: the keychain write failed but rolled back, so nothing moved.
  const routine = swapFailure({ to: 'first@example.com', error: 'keychain write failed; the previous account is still active and nothing changed' });
  ok(routine.startsWith('❌ Swap to `first@example.com` failed'), routine);
  ok(routine.includes('the previous account is still active'), routine);
  ok(routine.endsWith('The live account is unchanged.'), routine);
  // Urgent: the rollback did NOT take, so no worker can start until he logs in.
  const urgent = swapFailure({ to: 'first@example.com', error: 'keychain write failed AND the rollback did not take. Run: claude /login' });
  ok(urgent.startsWith('🚨'), `the urgent failure reads like the routine one:\n${urgent}`);
  ok(urgent.includes('claude /login'), 'the urgent failure lost the instruction that fixes it');
  ok(urgent.includes('No worker can start'), urgent);
  ok(!routine.startsWith('🚨'), 'the routine failure was escalated to urgent');
  // A missing error string still produces a message rather than "undefined".
  ok(swapFailure({ to: 'a@b.c' }).includes('the swap returned no result'));
  // The names WE write are code-wrapped at the point we write them; the ones
  // inside an error string arrive as prose from accounts.mjs and Telegram
  // linkifies them just the same. `/account bogus@x.com` produces exactly that.
  const typo = swapFailure({ to: 'bogus@x.com', error: 'no account slot named "bogus@x.com". Run /account capture bogus@x.com first' });
  eq(typo.replace(/`[^`\n]*`/g, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), null, typo);
  const conflict = captureFailure('Slot "shared" belongs to someone@else.com, not new@example.com. Use /account capture <name>.');
  eq(conflict.replace(/`[^`\n]*`/g, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), null, conflict);
  // ...and wrapping must not double-wrap or mangle the surrounding prose.
  ok(conflict.includes('belongs to `someone@else.com`, not `new@example.com`.'), conflict);
  ok(!conflict.includes('``'), `an address was double-wrapped:\n${conflict}`);
});

await t('the 🚨 failure names the one-time backup as the recovery path — and ONLY the 🚨 one', () => {
  const urgentMsg = 'keychain write failed AND the rollback did not take. Run: claude /login';
  const routineMsg = 'keychain write failed; the previous account is still active and nothing changed';
  const backupPath = '/some/dir/accounts.backup.json';
  const urgent = swapFailure({ to: 'first@example.com', error: urgentMsg, backupPath });
  ok(urgent.includes('accounts.backup.json'), `the 🚨 case must point at the backup:\n${urgent}`);
  ok(urgent.includes('`blob`'), 'the message must say WHICH key is the keychain payload');
  // Routine failures damaged nothing; naming a recovery file would imply they had.
  const routine = swapFailure({ to: 'first@example.com', error: routineMsg, backupPath });
  ok(!routine.includes('backup'), `a routine failure must not read like a disaster:\n${routine}`);
  // No backup on disk yet → no line, even on the 🚨 case.
  ok(!swapFailure({ to: 'a@b.c', error: urgentMsg }).includes('backup'), 'a backup that does not exist was advertised');
});

await t('a parked blob puts one warning line on /account, and none rides when nothing is parked', () => {
  const unclaimed = { fingerprint: 'a…AAAAAA/r…BBBBBB', email: 'fourth@somewhere.app', seenAt: new Date(NOW).toISOString(), note: '' };
  const out = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE, unclaimed },
    { now: NOW, timeZone: OWNER_TZ },
  );
  ok(out.includes('⚠️ unclaimed credentials parked'), `the parked warning is invisible:\n${out}`);
  ok(out.includes('/account capture <name> to claim'), 'the warning must say how to claim it');
  ok(out.includes('`fourth@somewhere.app`'), 'a known identity should be named (code-wrapped, like every email here)');
  ok(!out.includes(unclaimed.email + ' '), 'the email must be code-wrapped, not bare');
  const clean = renderAccountList(
    { rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE },
    { now: NOW, timeZone: OWNER_TZ },
  );
  ok(!clean.includes('unclaimed'), 'the warning must not ride when nothing is parked');
  // An unidentified parked blob still warns, with the fingerprint as its only handle.
  const anon = unclaimedLine({ fingerprint: 'a…XXXXXX/r…YYYYYY', email: null });
  ok(anon.includes('a…XXXXXX/r…YYYYYY') && !anon.includes('from'), anon);
});

await t('captureConfirmation names the slot and the blob it banked', () => {
  eq(
    captureConfirmation({ slot: 'first@example.com', fingerprint: 'a…QVmgAA/r…f0NAAA', replaced: true }),
    '📸 Captured the current login into `first@example.com`\nReplaced what was there · `a…QVmgAA/r…f0NAAA`',
  );
  ok(captureConfirmation({ slot: 'new@slot.app', fingerprint: 'a…X/r…Y' }).includes('New slot'), 'a fresh slot claimed to replace something');
  eq(captureFailure('no readable claudeAiOauth in the keychain'), '❌ Capture failed\nno readable claudeAiOauth in the keychain');
  ok(captureFailure().includes('the capture returned no result'));
});

await t('NO renderer leaves a bare email for Telegram to turn into a mailto link', () => {
  // The defect: every account name on /account rendered as a blue tappable
  // link, and a mis-tap opened a mail composer. The fix is a code span, whose
  // range Telegram will not emit an overlapping email entity over. This asserts
  // the property across every surface at once, so a new renderer cannot
  // reintroduce it by writing the name a fourth way.
  const surfaces = [
    renderAccountList({ rows: ACCT_ROWS, live: { name: 'first@example.com' }, usageRows: ACCT_USAGE }, { now: NOW }),
    renderAccountList({ rows: ACCT_ROWS, live: { name: null, email: 'fourth@example.com' }, usageRows: [] }, { now: NOW }),
    renderUsageReport(
      { active: { name: 'second@example.com', liveFingerprint: 'a…X/r…Y' }, rows: [{ ...OK_ROW, fingerprint: 'a…X/r…Y' }] },
      { now: NOW },
    ),
    activeLine({ name: 'second@example.com', liveFingerprint: 'a…X/r…Y' }),
    swapConfirmation({ to: 'first@example.com', from: 'second@example.com' }),
    swapFailure({ to: 'first@example.com', error: 'keychain write failed; the previous account is still active and nothing changed' }),
    captureConfirmation({ slot: 'first@example.com', fingerprint: 'a…X/r…Y', replaced: true }),
  ];
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  for (const s of surfaces) {
    // Strip every code span, then look for a surviving email address.
    const outside = s.replace(/`[^`\n]*`/g, '');
    const leaked = outside.match(EMAIL);
    eq(leaked, null, `an email address rendered outside a code span (Telegram will linkify it):\n${outside}`);
  }
});

await t('renderUsageReport prints bars, percents, HIS clock and time left for every account', () => {
  const rows = [
    { ...OK_ROW, live: true, fingerprint: 'a…f-rwAA/r…qGHAAA' },
    { name: 'first@example.com', live: false, state: 'ok', fingerprint: 'a…QVmgAA/r…f0NAAA', usage: normalizeUsage(REAL_USAGE) },
    { name: 'third@example.com', live: false, state: 'unavailable', error: 'usage unavailable', usage: null },
  ];
  const out = renderUsageReport({ active: { name: 'second@example.com', matchedBy: 'refreshToken', liveFingerprint: 'a…X/r…Y' }, rows }, { now: NOW, timeZone: OWNER_TZ });
  // Names are code spans, not bold, on this view too: /usage renders the same
  // email addresses and Telegram linkifies them the same way. The property the
  // old **bold** assertions protected — the report names the live account and
  // marks exactly which row it is — is asserted unchanged, on the new markup.
  ok(out.includes('Active: `second@example.com`'), 'the report must name the live account');
  ok(out.includes('▶︎ `second@example.com`'), 'the active account must be marked');
  ok(out.includes('• `first@example.com`'));
  // The fingerprints that left /account landed HERE — this is the diagnostic
  // view, and telling three accounts apart is exactly what it is for.
  ok(out.includes('▶︎ `second@example.com` `a…f-rwAA/r…qGHAAA`'), `the per-row fingerprint is missing from /usage:\n${out}`);
  ok(out.includes('• `first@example.com` `a…QVmgAA/r…f0NAAA`'), 'the idle rows lost their fingerprint too');
  ok(out.includes('5h `███░░░░░░░` 32%'), `missing the 5h bar:\n${out}`);
  ok(out.includes('wk `██░░░░░░░░` 24%'), 'missing the weekly bar');
  ok(out.includes('resets 6:10pm · 17m left'), `missing his local 5h reset clock:\n${out}`);
  ok(out.includes('Sat 5 Sep 1:00am'), 'missing the weekly reset in his zone');
  ok(out.includes('Fable'), 'the per-model weekly_scoped row was dropped');
  ok(out.includes('⚠️ usage unavailable'), 'a broken account must still appear');
  ok(out.includes('America/New_York'), 'the reply must say which clock it is quoting');
  ok(!out.includes('extra usage'), 'extra_usage is disabled on this account and must not be shown');
});

await t('a 0% window with no resets_at reads as full headroom, not as missing data', () => {
  // Observed live on first@example.com: the API sends resets_at:null for
  // five_hour when no 5-hour block is open. That account is the BEST one to
  // start the next job on, so it must not render as a hole in the report.
  const u = normalizeUsage(REAL_USAGE);
  u.fiveHour = { percent: 0, resetsAt: null, severity: 'normal', locked: null };
  const out = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(out.includes('no active block — full headroom'), out);
  // ...but a window that HAS been used and lacks a reset time must not claim that.
  u.fiveHour = { percent: 44, resetsAt: null, severity: 'normal', locked: null };
  const used = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(used.includes('no reset time'), used);
  ok(!used.includes('full headroom'), 'a 44%-consumed window was reported as full headroom');
});

await t('renderUsageReport shows extra usage only when it is enabled', () => {
  const u = normalizeUsage(REAL_USAGE);
  u.extraUsage = { enabled: true, percent: 12, usedCredits: 6000, monthlyLimit: 50000 };
  const out = renderUsageReport({ active: { name: 'a' }, rows: [{ name: 'a', live: true, state: 'ok', usage: u }] }, { now: NOW });
  ok(out.includes('extra usage 12%'), out);
  ok(out.includes('6000 credits used'));
});

await t('renderUsageReport degrades cleanly with no accounts and with an unknown active login', () => {
  const empty = renderUsageReport({ active: { name: null, liveFingerprint: 'a…8dkwAA/r…U7DQAA' }, rows: [] }, { now: NOW });
  ok(empty.includes('Active: unknown'));
  ok(empty.includes('No accounts captured yet'));
  const unenrolled = renderUsageReport(
    { active: { name: null, email: 'someone@else.com', matchedBy: 'profileEmailUnenrolled' }, rows: [] },
    { now: NOW },
  );
  ok(unenrolled.includes('someone@else.com'), 'a real identity beats printing "unknown"');
  ok(unenrolled.includes('/account capture'));
});

await t('no renderer can emit a token, even when handed one', () => {
  // Belt and braces: the shapes the renderers consume carry no token field, so
  // the only way one could appear is a future refactor passing the raw slot.
  const poisoned = {
    name: 'second@example.com',
    live: true,
    state: 'ok',
    usage: normalizeUsage(REAL_USAGE),
    claudeAiOauth: { accessToken: 'sk-ant-oat01-SHOULD-NEVER-RENDER', refreshToken: 'sk-ant-ort01-ALSO-NEVER' },
  };
  const all = [
    usageLine(poisoned),
    accountUsageBlock(poisoned).join('\n'),
    renderAccountList({ rows: [{ ...poisoned, captured: true }], live: { name: poisoned.name }, usageRows: [poisoned] }, { now: NOW }),
    swapConfirmation({ to: poisoned.name, from: 'x@y.z', usage: poisoned }),
    renderUsageReport({ active: { name: 'second@example.com' }, rows: [poisoned] }, { now: NOW }),
  ].join('\n');
  ok(!all.includes('SHOULD-NEVER-RENDER'), 'a renderer printed an access token');
  ok(!all.includes('ALSO-NEVER'), 'a renderer printed a refresh token');
});

// ---------- report ----------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account-usage tests pass');
