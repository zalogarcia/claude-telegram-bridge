#!/usr/bin/env node
// Tests for the Codex account view (codex-account.mjs).
//
// Everything /account says about the ChatGPT login lives in that module so it can
// be asserted without a daemon, a Telegram token or a paid API call: the JWT
// decode runs against a synthetic token, the rate-limit read runs against a fake
// app-server, the run tally runs against a fake runs directory, and the rendered
// block is compared character for character.
//
// The security assertions are the point of several of these: the module is handed
// a whole auth blob, and the only thing that may come back out of it is an email,
// a plan name and a login mode.
//
//   node codex-account.test.mjs

import { EventEmitter } from 'node:events';
import {
  CODEX_AUTH_CLAIM,
  codexAccountBlock,
  codexLastRunLine,
  codexSpendLine,
  codexWindowLabel,
  createCodexAccount,
  decodeJwtPayload,
  fetchCodexRateLimits,
  fmtCredits,
  normalizeCodexRateLimits,
  parseCodexMeta,
  planLabel,
  readCodexIdentity,
  readCodexRuns,
  tallyCodexRuns,
  codexSettingsLine,
} from './codex-account.mjs';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => void pass++, (e) => void failures.push(`${name}\n    ${e.message}`));
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
  return null;
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const TZ = 'America/New_York';

// ---------------------------------------------------------------------------
// Fixtures. The token is SYNTHETIC, the same shape as a real id_token, no signature
// that means anything, and nothing in it belongs to a real account.
// ---------------------------------------------------------------------------

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeIdToken = (payload) => `eyJhbGciOiJSUzI1NiJ9.${b64url(payload)}.c2lnbmF0dXJl`;

const CHATGPT_PAYLOAD = {
  email: 'owner@example.com',
  name: 'Test Owner',
  [CODEX_AUTH_CLAIM]: {
    chatgpt_plan_type: 'plus',
    chatgpt_account_id: '00000000-1111-2222-3333-444444444444',
    chatgpt_user_id: 'user-secret',
    organizations: [],
  },
};
const CHATGPT_AUTH = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  last_refresh: '2026-09-03T23:22:18.356905Z',
  tokens: {
    access_token: 'eyJACCESSsecret',
    account_id: '00000000-1111-2222-3333-444444444444',
    id_token: makeIdToken(CHATGPT_PAYLOAD),
    refresh_token: 'rt_secretrefresh',
  },
};

// The real `account/rateLimits/read` result, read live 2026-09-03 with the
// account id replaced. Shape preserved exactly, including resetsAt in SECONDS.
const LIVE_RATE_LIMITS = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1788495765 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1789082565 },
    credits: { hasCredits: true, unlimited: false, balance: '100.0000000000' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: { codex: { limitId: 'codex' } },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: 'REDACTED-ACCOUNT-ID',
  rateLimitUpsell: null,
};

// ---------------------------------------------------------------------------
// 1. The JWT decode
// ---------------------------------------------------------------------------

t('a synthetic id_token payload decodes', () => {
  const p = decodeJwtPayload(makeIdToken({ email: 'a@b.c', n: 1 }));
  eq(p.email, 'a@b.c');
  eq(p.n, 1);
});

t('base64url padding is restored (a payload whose length is not a multiple of 4)', () => {
  // Three different key lengths, so at least one lands on each padding case.
  for (const n of [1, 2, 3, 4, 5]) {
    const p = decodeJwtPayload(makeIdToken({ k: 'x'.repeat(n) }));
    eq(p.k, 'x'.repeat(n), `padding case ${n}`);
  }
});

t('a token with - and _ in the payload decodes (base64url, not base64)', () => {
  // "~~~" encodes to fn5+ in standard base64 and fn5- in base64url... build a
  // payload big enough that the alphabet difference actually shows up.
  const payload = { s: 'ûÿþûÿþ' };
  const p = decodeJwtPayload(makeIdToken(payload));
  eq(p.s, payload.s);
});

t('garbage never throws, it returns null', () => {
  eq(decodeJwtPayload(''), null);
  eq(decodeJwtPayload(null), null);
  eq(decodeJwtPayload('notatoken'), null);
  eq(decodeJwtPayload('a.b.c'), null);
  eq(decodeJwtPayload(`x.${b64url([1, 2, 3])}.y`), null, 'a JSON array is not a claims object');
});

// ---------------------------------------------------------------------------
// 2. Identity
// ---------------------------------------------------------------------------

t('a ChatGPT login yields email, plan and login mode', () => {
  const id = readCodexIdentity(CHATGPT_AUTH);
  eq(id.state, 'chatgpt');
  eq(id.email, 'owner@example.com');
  eq(id.plan, 'plus');
  eq(id.planLabel, 'ChatGPT Plus');
  eq(id.loginMode, 'ChatGPT');
  eq(id.lastRefresh, '2026-09-03T23:22:18.356905Z');
});

t('NO credential of any kind survives readCodexIdentity', () => {
  const id = readCodexIdentity(CHATGPT_AUTH);
  const s = JSON.stringify(id);
  for (const secret of ['eyJACCESS', 'rt_secret', 'user-secret', '00000000-1111', 'id_token', 'refresh']) {
    ok(!s.includes(secret), `identity leaked ${secret}: ${s}`);
  }
});

t('an API-key login is its own state, not a broken chatgpt one', () => {
  const id = readCodexIdentity({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-secret', tokens: null });
  eq(id.state, 'apikey');
  eq(id.loginMode, 'API key');
  ok(!JSON.stringify(id).includes('sk-'), 'the key must not survive');
});

t('a key present with an unexpected auth_mode is still an API-key login', () => {
  eq(readCodexIdentity({ auth_mode: 'weird', OPENAI_API_KEY: 'sk-x' }).state, 'apikey');
});

t('no auth file at all is "none", and an unparseable one is "broken"', () => {
  eq(readCodexIdentity(null).state, 'none');
  eq(readCodexIdentity(undefined).state, 'none');
  eq(readCodexIdentity({}).state, 'none');
  eq(readCodexIdentity('broken').state, 'broken');
});

t('an id_token that will not decode still yields a chatgpt state with nulls', () => {
  const id = readCodexIdentity({ auth_mode: 'chatgpt', tokens: { id_token: 'garbage' } });
  eq(id.state, 'chatgpt');
  eq(id.email, null);
  eq(id.planLabel, null);
});

t('plan labels', () => {
  eq(planLabel('plus'), 'ChatGPT Plus');
  eq(planLabel('PRO'), 'ChatGPT Pro');
  eq(planLabel('team'), 'ChatGPT Team');
  eq(planLabel('quantum'), 'ChatGPT Quantum', 'an unknown tier is title-cased, not dropped');
  eq(planLabel(''), null);
  eq(planLabel(null), null);
});

// ---------------------------------------------------------------------------
// 3. The rate-limit snapshot
// ---------------------------------------------------------------------------

t('window labels come from the duration, not from a hardcoded pair', () => {
  eq(codexWindowLabel(300), '5h');
  eq(codexWindowLabel(10080), 'wk');
  eq(codexWindowLabel(60), '1h');
  eq(codexWindowLabel(1440), '1d');
  eq(codexWindowLabel(90), '90m');
  eq(codexWindowLabel(null), '  ');
});

t('the live sample normalizes, and resetsAt becomes MILLISECONDS', () => {
  const u = normalizeCodexRateLimits(LIVE_RATE_LIMITS);
  eq(u.primary.percent, 0);
  eq(u.primary.windowMins, 300);
  eq(u.primary.label, '5h');
  eq(u.primary.resetsAtMs, 1788495765000, 'seconds must be scaled or the clock reads 1970');
  eq(u.secondary.label, 'wk');
  eq(u.secondary.resetsAtMs, 1789082565000);
  eq(u.planType, 'plus');
  eq(u.credits.balance, '100.0000000000');
  eq(u.reached, null);
});

t('a value already in milliseconds is left alone', () => {
  const u = normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: 5, resetsAt: 1788495765000, windowDurationMins: 300 } } });
  eq(u.primary.resetsAtMs, 1788495765000);
});

t('the account id is dropped at the normalization boundary', () => {
  const u = normalizeCodexRateLimits(LIVE_RATE_LIMITS);
  ok(!JSON.stringify(u).includes('REDACTED-ACCOUNT-ID'), 'the account id must not survive normalization');
});

t('an unrecognised body yields null rather than throwing', () => {
  eq(normalizeCodexRateLimits(null), null);
  eq(normalizeCodexRateLimits({}), null);
  eq(normalizeCodexRateLimits({ rateLimits: null }), null);
  const u = normalizeCodexRateLimits({ rateLimits: {} });
  eq(u.primary, null);
  eq(u.credits, null);
});

t('credits render to two places', () => {
  eq(fmtCredits('100.0000000000'), '100.00');
  eq(fmtCredits('0.5'), '0.50');
  eq(fmtCredits(null), null);
  eq(fmtCredits('nope'), null);
});

// ---------------------------------------------------------------------------
// 4. The app-server round trip, against a fake binary
// ---------------------------------------------------------------------------

// A child that speaks the protocol back. `script` decides what it answers.
function fakeChild({ answer = LIVE_RATE_LIMITS, error = null, silent = false, crash = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  const sent = [];
  child.sent = sent;
  child.stdin = {
    on() {},
    end() {},
    write(line) {
      sent.push(JSON.parse(line));
      if (silent) return true;
      const msg = JSON.parse(line);
      setImmediate(() => {
        if (msg.id === 1) child.stdout.emit('data', JSON.stringify({ id: 1, result: { codexHome: '/x' } }) + '\n');
        if (msg.id === 2) {
          const reply = error ? { id: 2, error: { message: error } } : { id: 2, result: answer };
          // Deliberately delivered in two chunks split mid-line, because a real
          // pipe does that and a parser that assumes whole lines would break.
          const s = JSON.stringify(reply) + '\n';
          const cut = Math.floor(s.length / 2);
          child.stdout.emit('data', s.slice(0, cut));
          child.stdout.emit('data', s.slice(cut));
        }
      });
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
  };
  if (crash) setImmediate(() => child.emit('error', new Error(crash)));
  return child;
}

await t('the real protocol shape: initialize, then account/rateLimits/read', async () => {
  let seen = null;
  const r = await fetchCodexRateLimits({
    spawnImpl: (bin, args) => {
      seen = { bin, args };
      return fakeChild();
    },
  });
  eq(seen.bin, 'codex');
  eq(JSON.stringify(seen.args), JSON.stringify(['app-server']));
  ok(r.ok, JSON.stringify(r));
  eq(r.usage.primary.percent, 0);
  eq(r.usage.planType, 'plus');
});

await t('the request pair is exactly what the CLI protocol documents', async () => {
  let child = null;
  await fetchCodexRateLimits({
    spawnImpl: () => {
      child = fakeChild();
      return child;
    },
  });
  eq(child.sent.length, 2);
  eq(child.sent[0].method, 'initialize');
  eq(child.sent[0].params.clientInfo.name, 'claude-telegram-bridge');
  eq(child.sent[1].method, 'account/rateLimits/read');
  eq(child.sent[1].id, 2);
});

await t('the child is always killed, including on the happy path', async () => {
  let child = null;
  await fetchCodexRateLimits({
    spawnImpl: () => {
      child = fakeChild();
      return child;
    },
  });
  ok(child.killed, 'a live app-server left behind is a process the daemon owns forever');
});

await t('a JSON-RPC error degrades instead of throwing', async () => {
  const r = await fetchCodexRateLimits({ spawnImpl: () => fakeChild({ error: 'not signed in' }) });
  eq(r.ok, false);
  ok(r.error.includes('not signed in'), r.error);
});

await t('a silent app-server is bounded by the timeout, not by hope', async () => {
  const started = Date.now();
  const r = await fetchCodexRateLimits({ spawnImpl: () => fakeChild({ silent: true }), timeoutMs: 60 });
  eq(r.ok, false);
  ok(/timed out/.test(r.error), r.error);
  ok(Date.now() - started < 3000, 'it must not wait for the default');
});

await t('a binary that is not there is an error string, not a rejection', async () => {
  const r = await fetchCodexRateLimits({
    spawnImpl: () => {
      throw new Error('spawn codex ENOENT');
    },
  });
  eq(r.ok, false);
  ok(r.error.includes('ENOENT'), r.error);
});

await t('a child that emits error resolves rather than rejecting', async () => {
  const r = await fetchCodexRateLimits({ spawnImpl: () => fakeChild({ crash: 'boom' }), timeoutMs: 500 });
  eq(r.ok, false);
  ok(r.error.includes('boom'), r.error);
});

await t('no spawn available is a clean miss', async () => {
  const r = await fetchCodexRateLimits({});
  eq(r.ok, false);
});

await t('a body with no windows is reported as such, not as a success with nulls', async () => {
  const r = await fetchCodexRateLimits({ spawnImpl: () => fakeChild({ answer: { nothing: true } }) });
  eq(r.ok, false);
  ok(/no rate-limit windows/.test(r.error), r.error);
});

await t('a log line on stdout does not derail the parser', async () => {
  const child = fakeChild();
  const origWrite = child.stdin.write;
  child.stdin.write = (line) => {
    child.stdout.emit('data', 'INFO starting up\n'); // not JSON
    return origWrite(line);
  };
  const r = await fetchCodexRateLimits({ spawnImpl: () => child });
  ok(r.ok, JSON.stringify(r));
});

// ---------------------------------------------------------------------------
// 5. Our own runs
// ---------------------------------------------------------------------------

const meta = (startedAt, over = {}) =>
  JSON.stringify({ runId: `codex-${startedAt}`, startedAt, endedAt: startedAt + 5000, mode: 'ask', status: 'finished', inputTokens: 1000, outputTokens: 10, ...over });

t('a sidecar parses, and a broken one is skipped rather than fatal', () => {
  const m = parseCodexMeta(meta(5));
  eq(m.startedAt, 5);
  eq(m.mode, 'ask');
  eq(m.inputTokens, 1000);
  eq(parseCodexMeta('{'), null);
  eq(parseCodexMeta('{}'), null, 'no startedAt means no usable row');
  eq(parseCodexMeta(null), null);
});

t('the runs dir is read in start order, and only codex sidecars are read', () => {
  const files = {
    'codex-300.meta.json': meta(300),
    'codex-100.meta.json': meta(100),
    'codex-200.meta.json': meta(200),
    'codex-100.log': 'not a sidecar',
    'codex-100.last.md': 'not a sidecar',
    'bg-999.jsonl': 'a claude worker',
    'codex-bad.meta.json': 'ignored, the name does not match',
  };
  const runs = readCodexRuns({
    runsDir: '/runs',
    readdir: () => Object.keys(files),
    readFile: (p) => {
      const name = p.split('/').pop();
      if (!(name in files)) throw new Error('ENOENT');
      return files[name];
    },
  });
  eq(runs.length, 3);
  eq(JSON.stringify(runs.map((r) => r.startedAt)), JSON.stringify([100, 200, 300]));
});

t('a missing runs dir is a bridge that has not run codex, not an error', () => {
  eq(
    readCodexRuns({
      runsDir: '/runs',
      readdir: () => {
        throw new Error('ENOENT');
      },
      readFile: () => '',
    }).length,
    0,
  );
  eq(readCodexRuns({}).length, 0);
});

t('a half-written sidecar costs one row, not the view', () => {
  const runs = readCodexRuns({
    runsDir: '/runs',
    readdir: () => ['codex-1.meta.json', 'codex-2.meta.json'],
    readFile: (p) => {
      if (p.endsWith('codex-1.meta.json')) throw new Error('EACCES');
      return meta(2);
    },
  });
  eq(runs.length, 1);
  eq(runs[0].startedAt, 2);
});

t('the tally splits today from the rolling week, in the OWNER’s zone', () => {
  // 2026-09-03 20:00 America/New_York = 2026-09-04 00:00 UTC, so local midnight
  // is 20 hours back. A run 21 hours back is yesterday in New York and TODAY in
  // UTC, which is exactly the case a zone-blind boundary gets wrong.
  const now = Date.parse('2026-09-04T00:00:00Z');
  const hour = 3600_000;
  const runs = [
    { startedAt: now - hour, mode: 'ask', status: 'finished', inputTokens: 100, outputTokens: 5 }, // 19:00 local, today
    { startedAt: now - 21 * hour, mode: 'edit', status: 'finished', inputTokens: 200, outputTokens: 7 }, // 23:00 local, yesterday
    { startedAt: now - 8 * 24 * hour, mode: 'ask', status: 'failed', inputTokens: 900, outputTokens: 9 }, // outside the week
  ];
  const tally = tallyCodexRuns(runs, { now, timeZone: TZ });
  eq(tally.today.runs, 1);
  eq(tally.today.input, 100);
  eq(tally.week.runs, 2);
  eq(tally.week.input, 300);
  eq(tally.last.startedAt, now - hour, 'the newest run is the last one, whatever the array order');
});

t('★ the "today" boundary survives both DST transitions', () => {
  // A wall-clock subtraction is right on 363 days a year and an hour out on the
  // other two: a 23-hour day lands before midnight (in yesterday) and a 25-hour
  // day lands after it (inside today). Both directions are asserted here.
  // Each case pins a run that lands in the ONE hour the naive boundary gets
  // wrong; the wall-clock subtraction answers the opposite of every line below.
  const cases = [
    // [label, now (UTC), the run (UTC), is it today in New York?]
    ['a normal day, an hour ago', '2026-09-04T00:00:00Z', '2026-09-03T23:00:00Z', true],
    ['a normal day, yesterday evening', '2026-09-04T00:00:00Z', '2026-09-03T03:00:00Z', false],
    // 2027-03-14 is the US spring forward: 02:00 EST jumps to 03:00 EDT, so the
    // day is 23 hours long. 04:30Z is 23:30 the PREVIOUS evening.
    ['spring forward, late last night', '2027-03-14T20:00:00Z', '2027-03-14T04:30:00Z', false],
    // 2026-11-01 is the US fall back: 02:00 EDT returns to 01:00 EST, so the day
    // is 25 hours long. 04:30Z is 00:30 THIS morning.
    ['fall back, just after midnight', '2026-11-02T00:00:00Z', '2026-11-01T04:30:00Z', true],
  ];
  for (const [label, nowIso, runIso, isToday] of cases) {
    const now = Date.parse(nowIso);
    const tally = tallyCodexRuns([{ startedAt: Date.parse(runIso), mode: 'ask', inputTokens: 1, outputTokens: 0 }], { now, timeZone: TZ });
    eq(tally.today.runs, isToday ? 1 : 0, label);
    eq(tally.week.runs, 1, `${label}: inside the rolling week either way`);
  }
});

t('a run started exactly at local midnight counts as today', () => {
  // en-CA hour12:false renders midnight as hour "24", which would push the
  // boundary a whole day back if it were not taken modulo 24.
  const now = Date.parse('2026-09-04T04:00:00Z'); // 00:00 in New York
  const tally = tallyCodexRuns([{ startedAt: now, mode: 'ask', inputTokens: 1, outputTokens: 0 }], { now, timeZone: TZ });
  eq(tally.today.runs, 1);
});

t('an empty tally is zeros and a null last run, not a crash', () => {
  const tally = tallyCodexRuns([], { now: Date.now(), timeZone: TZ });
  eq(tally.week.runs, 0);
  eq(tally.last, null);
  eq(tallyCodexRuns(null, {}).week.runs, 0);
});

t('the last-run line names the mode, because edit had write access and ask did not', () => {
  const now = Date.parse('2026-09-04T00:00:00Z');
  eq(
    codexLastRunLine({ startedAt: now - 7200_000, mode: 'edit', status: 'finished', inputTokens: 11663, outputTokens: 9 }, { now }),
    'last run · 2h ago · edit · 11,663 in / 9 out · finished',
  );
  eq(codexLastRunLine(null, { now }), null);
});

t('a run with no sidecar end stamp reads as running, not as finished', () => {
  const now = Date.now();
  ok(codexLastRunLine({ startedAt: now, mode: 'review' }, { now }).endsWith('running'));
});

t('the spend line is null until something has run this week', () => {
  eq(codexSpendLine({ today: { runs: 0, input: 0, output: 0 }, week: { runs: 0, input: 0, output: 0 } }), null);
  eq(
    codexSpendLine({ today: { runs: 1, input: 1000, output: 20 }, week: { runs: 4, input: 40000, output: 500 } }),
    'today 1 run · 1,020 tok · 7d 4 runs · 40,500 tok',
  );
});

// ---------------------------------------------------------------------------
// 6. The rendered block, character for character
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-03T23:30:00Z'); // 19:30 in New York

t('the full block renders exactly as it will be read on the phone', () => {
  const usage = normalizeCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: Math.floor(Date.parse('2026-09-04T03:09:00Z') / 1000) },
      secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: Math.floor(Date.parse('2026-09-10T15:42:00Z') / 1000) },
      credits: { hasCredits: true, unlimited: false, balance: '100.0000000000' },
      planType: 'plus',
    },
  });
  const tally = tallyCodexRuns(
    [{ startedAt: NOW - 7200_000, mode: 'ask', status: 'finished', inputTokens: 11663, outputTokens: 9 }],
    { now: NOW, timeZone: TZ },
  );
  const text = codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH), usage, tally, fallbackOn: true }, { now: NOW, timeZone: TZ });
  eq(
    text,
    [
      '🧠 Codex · OpenAI, billed separately',
      '• `owner@example.com` · ChatGPT Plus · signed in with ChatGPT',
      '   `5h ███░░░░░░░  31%` resets 11:09pm · 3h 39m',
      '   `wk █░░░░░░░░░   7%` resets Thu 11:42am · 6d 16h',
      '   credits 100.00',
      '   last run · 2h ago · ask · 11,663 in / 9 out · finished',
      '   today 1 run · 11,672 tok · 7d 1 run · 11,672 tok',
      '   fallback on · /codex <question> · /codex review [repo]',
    ].join('\n'),
  );
});

t('the rendered block never carries a token, a refresh token or an account id', () => {
  const usage = normalizeCodexRateLimits(LIVE_RATE_LIMITS);
  const text = codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH), usage, fallbackOn: true }, { now: NOW, timeZone: TZ });
  for (const secret of ['eyJ', 'rt_', 'sk-', 'access_token', 'REDACTED-ACCOUNT-ID', '00000000-1111']) {
    ok(!text.includes(secret), `the block leaked ${secret}:\n${text}`);
  }
});

t('the email travels in a code span so Telegram cannot linkify it', () => {
  const text = codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH) }, { now: NOW, timeZone: TZ });
  ok(text.includes('`owner@example.com`'), text);
});

t('no auth file: one line saying what to do about it', () => {
  const text = codexAccountBlock({ identity: readCodexIdentity(null), fallbackOn: true }, { now: NOW, timeZone: TZ });
  eq(text, ['🧠 Codex · OpenAI, billed separately', '• not signed in · run `codex login` in a terminal', '   fallback on'].join('\n'));
});

t('an unparseable auth file reads differently from a missing one', () => {
  const text = codexAccountBlock({ identity: readCodexIdentity('broken') }, { now: NOW, timeZone: TZ });
  ok(text.includes('did not parse'), text);
  ok(!text.includes('not signed in'), 'the two states have different fixes and must not collapse');
});

t('an API-key login says so and stops, rather than showing an empty gauge', () => {
  const text = codexAccountBlock({ identity: readCodexIdentity({ OPENAI_API_KEY: 'sk-x' }), fallbackOn: false }, { now: NOW, timeZone: TZ });
  ok(text.includes('API key login · usage not available'), text);
  ok(!text.includes('5h '), 'there are no plan windows for an API key');
  ok(text.includes('fallback off'), text);
});

t('a good login with an unreadable snapshot keeps the identity and says why', () => {
  const text = codexAccountBlock(
    { identity: readCodexIdentity(CHATGPT_AUTH), usage: null, usageError: 'codex app-server timed out', fallbackOn: true },
    { now: NOW, timeZone: TZ },
  );
  ok(text.includes('`owner@example.com`'), text);
  ok(text.includes('⚠️ codex app-server timed out'), text);
});

t('an exhausted window is marked, not silently rendered as a full bar', () => {
  const usage = normalizeCodexRateLimits({
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 600 }, rateLimitReachedType: 'primary' },
  });
  const text = codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH), usage }, { now: NOW, timeZone: TZ });
  ok(text.includes('⛔ rate limit reached (primary)'), text);
  ok(text.includes('██████████ 100%'), text);
});

t('a window with no reset time still renders', () => {
  const usage = normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null } } });
  const text = codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH), usage }, { now: NOW, timeZone: TZ });
  ok(text.includes('no active window'), text);
});

t('unlimited credits say unlimited rather than a number', () => {
  const usage = normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 }, credits: { unlimited: true } } });
  ok(codexAccountBlock({ identity: readCodexIdentity(CHATGPT_AUTH), usage }, { now: NOW, timeZone: TZ }).includes('credits unlimited'));
});

t('the block never throws on an empty argument list', () => {
  ok(codexAccountBlock().startsWith('🧠'));
  ok(codexAccountBlock({}, {}).startsWith('🧠'));
});

// ---------------------------------------------------------------------------
// 7. The cache
// ---------------------------------------------------------------------------

await t('a second read inside the TTL does not spawn again', async () => {
  let fetches = 0;
  let clock = 1_000_000;
  const acct = createCodexAccount({
    readAuth: () => CHATGPT_AUTH,
    fetchLimits: async () => {
      fetches++;
      return { ok: true, usage: normalizeCodexRateLimits(LIVE_RATE_LIMITS) };
    },
    listRuns: () => [],
    ttlMs: 60_000,
    now: () => clock,
  });
  await acct.snapshot();
  await acct.snapshot();
  eq(fetches, 1);
  clock += 61_000;
  await acct.snapshot();
  eq(fetches, 2, 'past the TTL it refreshes');
});

await t('two callers in the same tick share one build', async () => {
  let fetches = 0;
  const acct = createCodexAccount({
    readAuth: () => CHATGPT_AUTH,
    fetchLimits: async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, usage: normalizeCodexRateLimits(LIVE_RATE_LIMITS) };
    },
    listRuns: () => [],
  });
  await Promise.all([acct.snapshot(), acct.snapshot(), acct.snapshot()]);
  eq(fetches, 1, '/account tapped twice in a second must not be two app-server spawns');
});

await t('invalidate forces the next read', async () => {
  let fetches = 0;
  const acct = createCodexAccount({
    readAuth: () => CHATGPT_AUTH,
    fetchLimits: async () => ((fetches++), { ok: true, usage: normalizeCodexRateLimits(LIVE_RATE_LIMITS) }),
    listRuns: () => [],
  });
  await acct.snapshot();
  acct.invalidate();
  await acct.snapshot();
  eq(fetches, 2);
  ok(await acct.snapshot({ force: true }).then(() => fetches === 3), 'force bypasses the TTL too');
});

await t('an API-key login is answered from disk with NO spawn at all', async () => {
  let fetches = 0;
  const acct = createCodexAccount({
    readAuth: () => ({ OPENAI_API_KEY: 'sk-x' }),
    fetchLimits: async () => ((fetches++), { ok: true }),
    listRuns: () => [],
  });
  const snap = await acct.snapshot();
  eq(fetches, 0);
  eq(snap.identity.state, 'apikey');
});

await t('a failed limits read leaves the identity intact and carries the reason', async () => {
  const acct = createCodexAccount({
    readAuth: () => CHATGPT_AUTH,
    fetchLimits: async () => ({ ok: false, error: 'codex app-server timed out' }),
    listRuns: () => [],
  });
  const snap = await acct.snapshot();
  eq(snap.identity.email, 'owner@example.com');
  eq(snap.usage, null);
  eq(snap.usageError, 'codex app-server timed out');
});

await t('a reader that throws degrades the view instead of failing the reply', async () => {
  const acct = createCodexAccount({
    readAuth: () => {
      throw new Error('disk on fire');
    },
    fetchLimits: async () => ({ ok: true }),
    listRuns: () => [],
  });
  const snap = await acct.snapshot();
  eq(snap.identity.state, 'broken');
  ok(codexAccountBlock(snap, { now: NOW, timeZone: TZ }).startsWith('🧠'));
});

// ---------------------------------------------------------------------------
// What the next Codex run will actually use
// ---------------------------------------------------------------------------

t('★ the block says the model and effort a Codex run would start with', () => {
  const line = codexSettingsLine({ model: 'gpt-5.6-sol', effort: 'high' });
  eq(line, 'model gpt-5.6-sol · effort high');
});

t('unset reads as "default", not as a blank or a guessed model name', () => {
  eq(codexSettingsLine({ model: null, effort: null }), 'model default · effort default');
  eq(codexSettingsLine({}), 'model default · effort default');
});

t('no settings at all means no line, rather than a line saying nothing', () => {
  eq(codexSettingsLine(null), null);
  eq(codexSettingsLine(undefined), null);
});

t('★ the settings line appears on EVERY identity state, including the early returns', () => {
  // "why did that answer come back so thin" is a question about the effort
  // setting, and it is invisible anywhere but /engine without this.
  const settings = { model: 'o3', effort: 'low' };
  for (const identity of [
    { state: 'none' },
    { state: 'broken', error: 'unreadable' },
    { state: 'apikey' },
    { state: 'chatgpt', email: 'a@b.c', planLabel: 'ChatGPT Plus', loginMode: 'ChatGPT' },
  ]) {
    const block = codexAccountBlock({ identity, settings }, { now: Date.now(), timeZone: 'UTC' });
    ok(block.includes('model o3 · effort low'), `${identity.state}: ${block}`);
  }
});

t('and a block built without settings is byte-identical to before', () => {
  const identity = { state: 'chatgpt', email: 'a@b.c', planLabel: 'ChatGPT Plus', loginMode: 'ChatGPT' };
  const block = codexAccountBlock({ identity }, { now: Date.now(), timeZone: 'UTC' });
  ok(!block.includes('model '), block);
  ok(block.includes('fallback on'), block);
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all codex-account tests pass');
