// ---------------------------------------------------------------------------
// THE CODEX ACCOUNT ON /account
//
// /account has always been a view of the CLAUDE accounts: one slot per enrolled
// subscription, each with its 5-hour block and its weekly window, so you can see
// from your phone which one still has headroom. Since the second engine landed
// there is another account behind Leash that the view said nothing about: the
// ChatGPT login that `codex` runs on. It has its own two rate-limit windows, its
// own plan, its own reset clocks and its own bill, and every one of those is a
// thing you would otherwise only discover by hitting it.
//
// So this module is the Codex half of that view. It renders in exactly the same
// visual language as the Claude rows (usageBar, fmtPercent, fmtResetClock,
// fmtResetLeft, all imported from account-usage.mjs rather than re-implemented)
// because two gauges of the same shape sitting in one message must not disagree
// about what a bar means.
//
// ---------------------------------------------------------------------------
// WHERE THE NUMBERS COME FROM (probed live 2026-09-03, codex-cli 0.153.0)
//
// Four sources were tried, in this order, and only the first one works:
//
//   a. `codex app-server` over stdio, JSON-RPC. WORKS. `initialize` then
//      `account/rateLimits/read` returns primary (300 min) and secondary
//      (10080 min) windows with usedPercent and resetsAt, plus planType and the
//      credit balance. Round trip measured at ~1.3 s, no daemon left behind.
//      The method name and the response shape are not guesses: they come from
//      `codex app-server generate-json-schema`, which the CLI generates from its
//      own protocol types.
//   b. `codex exec --json` events. NO. The stream carries thread.started,
//      turn.started, item.started/completed and turn.completed { usage }, and
//      nothing else. Token counts, never rate limits.
//   c. A direct authenticated GET at whatever endpoint the CLI uses. Not needed,
//      and deliberately not built: it would mean lifting the ChatGPT access
//      token out of auth.json and putting it in a request WE construct, which is
//      exactly the handling this module exists to avoid.
//   d. A tally of our own runs. Kept anyway, as the "what did this cost" line,
//      because it answers a question the windows do not.
//
// IDENTITY comes from ~/.codex/auth.json. The `id_token` is a JWT and its
// payload carries `email` and the claim object `https://api.openai.com/auth`,
// whose `chatgpt_plan_type` is the plan. The payload is base64url and is decoded
// WITHOUT signature verification, which is correct here and would not be
// anywhere else: we are reading our own local login to print our own email, not
// authenticating anybody.
//
// SECURITY, non-negotiable: nothing in this module returns, renders, logs or
// stores a token, a refresh token, an id_token or an account id. readCodexIdentity
// takes the whole auth blob and gives back four harmless strings; everything else
// is dropped on the floor at that boundary, so no later renderer can leak what it
// was never handed.
// ---------------------------------------------------------------------------

import { fmtPercent, fmtResetClock, fmtResetLeft, usageBar } from './account-usage.mjs';
import { fmtAge } from './progress-render.mjs';

// The claim object OpenAI hangs the ChatGPT subscription facts off. A URL as a
// key is normal for a namespaced JWT claim and is matched literally.
export const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';

// Same TTL as the Claude usage cache (account-usage.mjs DEFAULT_TTL_MS), for the
// same reason: /account is opened several times a minute and a number a minute
// old is still true, but a spawn per open is not free.
export const CODEX_USAGE_TTL_MS = 60_000;

// The app-server round trip measured at 1.3 s cold. Five seconds is the same
// budget account-usage.mjs gives the Anthropic usage call, and it must stay
// UNDER the deadline bridge.mjs puts on the whole snapshot (6 s): a read that
// outlives its caller's deadline never gets to report "timed out" on the row,
// it just makes the whole Codex block vanish from /account with no explanation.
export const CODEX_RATE_LIMIT_TIMEOUT_MS = 5_000;

// How far back the "this week" tally looks. Rolling seven days rather than a
// calendar week, so it lines up with the weekly rate-limit window beside it.
export const CODEX_WEEK_MS = 7 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------

/**
 * The payload half of a JWT, decoded. No signature check, on purpose: this reads
 * a token WE already hold, to print the email inside it. Returns null for
 * anything that is not a three-part token with a base64url JSON payload, so a
 * rotated or truncated file degrades to "unknown" instead of throwing inside a
 * Telegram reply.
 */
export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    // Array.isArray, because typeof [] is 'object': a payload that decoded to a
    // JSON array would otherwise be handed on as a claims object and every claim
    // read off it would be undefined, which reads as "logged in, unknown email".
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// "plus" is what the claim says; "ChatGPT Plus" is what the plan is called. An
// unrecognised value is title-cased rather than dropped: a new tier name is
// still more useful on the row than nothing.
const PLAN_LABELS = {
  free: 'ChatGPT Free',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  team: 'ChatGPT Team',
  business: 'ChatGPT Business',
  enterprise: 'ChatGPT Enterprise',
  edu: 'ChatGPT Edu',
};

export function planLabel(plan) {
  const p = String(plan || '').trim().toLowerCase();
  if (!p) return null;
  if (PLAN_LABELS[p]) return PLAN_LABELS[p];
  return `ChatGPT ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
}

/**
 * Who Codex is logged in as, from the parsed contents of ~/.codex/auth.json.
 *
 * States, and why each is separate:
 *   'chatgpt': a subscription login. The only state with rate-limit windows.
 *   'apikey':  billed per token against an OpenAI API key. The app-server has
 *               no plan windows to report for it, so the view says so and stops
 *               rather than showing an empty gauge that looks like zero usage.
 *   'none':    no auth file at all: `codex` will refuse to run.
 *   'broken':  a file that exists and does not parse. Distinguished from 'none'
 *               because the fix is different (repair or re-login, not log in).
 *
 * `auth` is the already-parsed object, or null when the file is missing, or the
 * string 'broken' when it would not parse. NOTHING token-shaped comes back out.
 */
export function readCodexIdentity(auth) {
  if (auth === 'broken') return { state: 'broken', error: '~/.codex/auth.json did not parse' };
  if (!auth || typeof auth !== 'object') return { state: 'none' };
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  const mode = String(auth.auth_mode || '').toLowerCase();
  // An API key with no tokens is an API-key login however auth_mode is spelled;
  // the presence of the key is the fact that matters, not the label beside it.
  if (!tokens?.id_token) {
    if (auth.OPENAI_API_KEY || mode === 'apikey' || mode === 'api_key') {
      return { state: 'apikey', loginMode: 'API key' };
    }
    return { state: 'none' };
  }
  const claims = decodeJwtPayload(tokens.id_token);
  const authClaim = claims?.[CODEX_AUTH_CLAIM];
  const plan = typeof authClaim?.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : null;
  return {
    state: 'chatgpt',
    loginMode: 'ChatGPT',
    email: typeof claims?.email === 'string' ? claims.email : null,
    plan,
    planLabel: planLabel(plan),
    lastRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null,
  };
}

// ---------------------------------------------------------------------------
// THE RATE-LIMIT SNAPSHOT
// ---------------------------------------------------------------------------

// 300 -> "5h", 10080 -> "wk". Anything else is rendered from the number itself
// rather than mislabelled, because the two window sizes are a backend choice and
// a hardcoded pair of labels would start lying the day they change.
export function codexWindowLabel(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n <= 0) return '  ';
  if (n === 10080) return 'wk';
  if (n % 1440 === 0) return `${n / 1440}d`;
  if (n % 60 === 0) return `${n / 60}h`;
  return `${n}m`;
}

// resetsAt arrives as epoch SECONDS (measured: a 5-hour window read at
// 1788478101s came back as 1788495765). Every formatter in account-usage.mjs
// takes milliseconds, and handing one seconds reads as 1970, i.e. "due now",
// wrong in the one direction that matters. The threshold both converts and
// survives a future version that switches to ms.
function toMs(resetsAt) {
  const n = Number(resetsAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000;
}

function codexWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.usedPercent);
  return {
    percent: Number.isFinite(pct) ? pct : null,
    resetsAtMs: toMs(w.resetsAt),
    windowMins: Number.isFinite(Number(w.windowDurationMins)) ? Number(w.windowDurationMins) : null,
    label: codexWindowLabel(w.windowDurationMins),
  };
}

/**
 * The `account/rateLimits/read` result, reduced to what the row needs.
 *
 * Never throws: a response shaped in a way we do not recognise yields nulls,
 * which render as "n/a", exactly as normalizeUsage does for the Claude side. The
 * accountId the backend also sends is READ AND DROPPED here, deliberately, so no
 * renderer downstream is even able to print it.
 */
export function normalizeCodexRateLimits(result) {
  if (!result || typeof result !== 'object') return null;
  const snap = result.rateLimits && typeof result.rateLimits === 'object' ? result.rateLimits : null;
  if (!snap) return null;
  const credits = snap.credits && typeof snap.credits === 'object' ? snap.credits : null;
  return {
    primary: codexWindow(snap.primary),
    secondary: codexWindow(snap.secondary),
    planType: typeof snap.planType === 'string' ? snap.planType : null,
    reached: typeof snap.rateLimitReachedType === 'string' ? snap.rateLimitReachedType : null,
    credits: credits
      ? {
          has: credits.hasCredits === true,
          unlimited: credits.unlimited === true,
          balance: typeof credits.balance === 'string' || typeof credits.balance === 'number' ? String(credits.balance) : null,
        }
      : null,
  };
}

// "100.00" from "100.0000000000". A balance is money and ten decimal places on a
// phone line is noise, but rounding it away entirely would hide a nearly-empty
// balance, so it keeps two.
export function fmtCredits(balance) {
  // Number(null) and Number('') are both 0, not NaN, so an ABSENT balance would
  // render as a confident "credits 0.00", the one wrong answer here, because it
  // says the account is out of credit when we simply were not told.
  if (balance === null || balance === undefined || balance === '') return null;
  const n = Number(balance);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Ask the app-server for the windows.
 *
 * Impure by necessity and injectable for exactly that reason: `spawnImpl` is
 * node's spawn in the daemon and a fake in the tests, so the whole protocol
 * dance is asserted without a binary or a network.
 *
 * The child is killed on every exit path. An app-server that hangs would
 * otherwise be a process the daemon owns forever, holding a pipe, for a decoration
 * on a status view.
 *
 * Resolves to { ok, usage, error } and NEVER rejects: a usage number decorates a
 * reply, it may not take one down.
 */
export async function fetchCodexRateLimits({ spawnImpl, bin = 'codex', timeoutMs = CODEX_RATE_LIMIT_TIMEOUT_MS } = {}) {
  if (typeof spawnImpl !== 'function') return { ok: false, error: 'no spawn available' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: `codex app-server failed to start: ${e.message}` });
      return;
    }
    let settled = false;
    let buf = '';
    let asked = false;
    const stop = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      resolve(out);
    };
    // NOT unref'd. This timer is the only thing that kills a hung app-server, it
    // is cleared on every settle, and it is bounded by `timeoutMs`
    // (CODEX_RATE_LIMIT_TIMEOUT_MS, 5s), so the worst it can do is hold the
    // process open for that long, which is exactly the interval in which there
    // is a child that still needs killing.
    const timer = setTimeout(() => stop({ ok: false, error: 'codex app-server timed out' }), timeoutMs);
    const write = (msg) => {
      try {
        child.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        stop({ ok: false, error: `codex app-server write failed: ${e.message}` });
      }
    };
    child.stdin?.on('error', () => {}); // EPIPE from a dead child must not crash the daemon
    child.on('error', (e) => stop({ ok: false, error: `codex app-server: ${e.message}` }));
    child.on('close', () => stop({ ok: false, error: 'codex app-server closed without answering' }));
    child.stderr?.on('data', () => {}); // drained so a chatty binary cannot fill its pipe and block
    child.stdout?.on('data', (d) => {
      buf += String(d);
      // Newline-delimited JSON-RPC. The tail after the last newline is a partial
      // line and stays in the buffer.
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          continue; // a log line on stdout is not a protocol error
        }
        if (msg.id === 1 && !asked) {
          asked = true;
          write({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) {
            stop({ ok: false, error: `codex rate limits: ${msg.error.message || 'refused'}` });
            return;
          }
          const usage = normalizeCodexRateLimits(msg.result);
          stop(usage ? { ok: true, usage } : { ok: false, error: 'codex returned no rate-limit windows' });
          return;
        }
      }
    });
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'claude-telegram-bridge', version: '1.0.0' } },
    });
  });
}

// ---------------------------------------------------------------------------
// OUR OWN RUNS: what Codex has actually cost
//
// The windows above are the plan's view. This is ours, and it answers a question
// the windows cannot: which run, when, in what mode, and how many tokens. Each
// run leaves a small meta sidecar beside its log (runs/codex-<startedAt>.meta.json),
// written at spawn and rewritten at exit, so a finished run's mode and cost
// survive the process that produced them.
// ---------------------------------------------------------------------------

export function parseCodexMeta(text) {
  try {
    const o = JSON.parse(String(text));
    if (!o || typeof o !== 'object' || !Number.isFinite(Number(o.startedAt))) return null;
    return {
      runId: typeof o.runId === 'string' ? o.runId : null,
      startedAt: Number(o.startedAt),
      endedAt: Number.isFinite(Number(o.endedAt)) ? Number(o.endedAt) : null,
      mode: typeof o.mode === 'string' ? o.mode : 'ask',
      status: typeof o.status === 'string' ? o.status : null,
      inputTokens: Number(o.inputTokens) || 0,
      outputTokens: Number(o.outputTokens) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Every run sidecar in the runs dir, newest last. fs is injected so this is
 * asserted against a fake directory rather than against whatever happens to be
 * on the machine running the tests.
 *
 * `limit` bounds the read: the tally only ever looks back a week, and a runs dir
 * with a thousand files must not turn /account into a thousand file reads.
 */
export function readCodexRuns({ runsDir, readdir, readFile, limit = 200 } = {}) {
  if (typeof readdir !== 'function' || typeof readFile !== 'function' || !runsDir) return [];
  let names;
  try {
    names = readdir(runsDir);
  } catch {
    return []; // no runs dir yet is not an error, it is a bridge that has not run codex
  }
  const metas = (names || [])
    .filter((n) => typeof n === 'string' && /^codex-\d+\.meta\.json$/.test(n))
    .sort()
    .slice(-limit);
  const out = [];
  for (const name of metas) {
    let text;
    try {
      text = readFile(`${String(runsDir).replace(/\/$/, '')}/${name}`);
    } catch {
      continue; // a half-written sidecar is one missing row, not a broken view
    }
    const rec = parseCodexMeta(text);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Local midnight, in the owner's zone rather than the daemon's. "Today" on a
 * phone five hours west of UTC is not "today" in UTC for five hours of every day.
 *
 * Subtracting the wall-clock time of day gets within an hour of the answer, and
 * is exactly right on 363 days a year. It is wrong on the other two, because it
 * assumes the REAL time elapsed since midnight equals the wall clock reading:
 *   spring forward (a 23-hour day) lands an hour BEFORE midnight, in yesterday;
 *   fall back (a 25-hour day) lands an hour AFTER it, inside today.
 * Both are one hour out in a known direction, so one nudge in each direction
 * fixes them, and the loops are bounded so a zone that behaves in some third way
 * costs an approximation rather than a spin.
 */
function startOfLocalDay(now, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const partsOf = (ms) => Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const dayOf = (ms) => {
      const p = partsOf(ms);
      return `${p.year}-${p.month}-${p.day}`;
    };
    const p = partsOf(Number(now));
    // hour is "24" at midnight under en-CA hour12:false, which would put the
    // boundary a full day early.
    const hour = Number(p.hour) % 24;
    const today = `${p.year}-${p.month}-${p.day}`;
    let t = Number(now) - (hour * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
    for (let i = 0; i < 2 && dayOf(t) !== today; i++) t += 3600_000; // landed in yesterday
    for (let i = 0; i < 2 && dayOf(t - 1) === today; i++) t -= 3600_000; // landed past midnight
    return t;
  } catch {
    return Number(now) - 24 * 60 * 60_000;
  }
}

/**
 * Runs and tokens for today and for the rolling week, plus the most recent run.
 * Pure: `now` and the zone are arguments, so the boundary cases are testable
 * without moving a clock.
 */
export function tallyCodexRuns(records, { now = Date.now(), timeZone = 'UTC' } = {}) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  const dayStart = startOfLocalDay(now, timeZone);
  const weekStart = Number(now) - CODEX_WEEK_MS;
  const blank = () => ({ runs: 0, input: 0, output: 0 });
  const today = blank();
  const week = blank();
  let last = null;
  for (const r of list) {
    const add = (acc) => {
      acc.runs++;
      acc.input += r.inputTokens || 0;
      acc.output += r.outputTokens || 0;
    };
    if (r.startedAt >= weekStart) add(week);
    if (r.startedAt >= dayStart) add(today);
    if (!last || r.startedAt > last.startedAt) last = r;
  }
  return { today, week, last };
}

const thousands = (n) => Number(n || 0).toLocaleString('en-US');

// "last run 2h ago · ask · 11,663 in / 9 out · finished", or null when Codex has
// never run here. The mode is on the line because an `edit` run had write access
// and an `ask` run did not, which is the first thing worth knowing about it.
export function codexLastRunLine(last, { now = Date.now() } = {}) {
  if (!last) return null;
  const age = Number(now) - Number(last.startedAt);
  const when = Number.isFinite(age) && age >= 0 ? `${fmtAge(age)} ago` : 'just now';
  const cost = last.inputTokens || last.outputTokens ? `${thousands(last.inputTokens)} in / ${thousands(last.outputTokens)} out` : null;
  const state = last.status || (last.endedAt ? 'finished' : 'running');
  return ['last run', when, last.mode, cost, state].filter(Boolean).join(' · ');
}

// "today 2 runs · 24,102 tok · 7d 9 runs · 131,884 tok", or null when nothing has
// run in a week. Input and output are summed into one number here on purpose:
// the split is on the last-run line, and this one is about volume over time.
export function codexSpendLine(tally) {
  if (!tally?.week?.runs) return null;
  const part = (label, w) => `${label} ${w.runs} ${w.runs === 1 ? 'run' : 'runs'} · ${thousands(w.input + w.output)} tok`;
  return `${part('today', tally.today)} · ${part('7d', tally.week)}`;
}

// ---------------------------------------------------------------------------
// THE BLOCK
// ---------------------------------------------------------------------------

// The same shape accountWindowLine renders for a Claude account: title, bar and
// percent inside ONE code span so the rows line up under each other in Telegram's
// proportional font, then the reset clock and the countdown as prose. Copied in
// shape rather than imported because accountWindowLine is private to a SHARED
// module (account-usage.mjs) that must stay byte-identical across both repos.
function codexWindowLine(w, { now, timeZone }) {
  if (!w) return null;
  const gauge = `\`${w.label} ${usageBar(w.percent)} ${fmtPercent(w.percent).padStart(4)}\``;
  if (!w.resetsAtMs) return `   ${gauge} ${w.percent ? 'no reset time' : 'no active window'}`;
  const clock = fmtResetClock(w.resetsAtMs, { timeZone, now, compact: true });
  const left = fmtResetLeft(w.resetsAtMs, now, { timeZone, withDay: false, withLeft: false });
  return `   ${gauge} resets ${clock} · ${left}`;
}

/**
 * The Codex section of /account. Pure, so the exact text you read on your phone
 * is asserted in a unit test rather than eyeballed in Telegram.
 *
 * Degrades in four separate ways because they have four different fixes:
 *   no auth file      -> log in
 *   unparseable file  -> repair or log in again
 *   API-key login     -> there are no plan windows to show, and that is not a fault
 *   windows unread    -> the login is fine, the read failed; the identity still shows
 */
export function codexAccountBlock(
  { identity = null, usage = null, usageError = null, fallbackOn = true, tally = null } = {},
  { now = Date.now(), timeZone = 'UTC' } = {},
) {
  const out = ['🧠 **Codex** (OpenAI, billed separately)'];
  const id = identity || { state: 'none' };
  const fallback = `fallback ${fallbackOn ? 'on' : 'off'}`;

  if (id.state === 'none') {
    out.push('• not signed in · run `codex login` in a terminal', `   ${fallback}`);
    return out.join('\n');
  }
  if (id.state === 'broken') {
    out.push(`• ⚠️ ${id.error || 'the codex login could not be read'}`, `   ${fallback}`);
    return out.join('\n');
  }
  if (id.state === 'apikey') {
    out.push('• API key login · usage not available', `   ${fallback}`);
    const spend = codexSpendLine(tally);
    const lastLine = codexLastRunLine(tally?.last, { now });
    if (lastLine) out.push(`   ${lastLine}`);
    if (spend) out.push(`   ${spend}`);
    return out.join('\n');
  }

  // A ChatGPT login. The name travels in a code span for the same reason every
  // name in account-usage.mjs does: Telegram linkifies a bare email into a blue
  // mailto, and a mis-tap on a status view opens a mail composer.
  const who = id.email ? `\`${id.email}\`` : '`unknown account`';
  const plan = id.planLabel || usage?.planType ? ` · ${id.planLabel || planLabel(usage?.planType)}` : '';
  out.push(`• ${who}${plan} · signed in with ${id.loginMode || 'ChatGPT'}`);

  if (!usage) {
    out.push(`   ⚠️ ${usageError || 'usage unavailable'}`);
  } else {
    const rows = [codexWindowLine(usage.primary, { now, timeZone }), codexWindowLine(usage.secondary, { now, timeZone })].filter(Boolean);
    out.push(...(rows.length ? rows : ['   ⚠️ usage unavailable']));
    if (usage.reached) out.push(`   ⛔ rate limit reached (${usage.reached})`);
    const bal = usage.credits?.unlimited ? 'unlimited' : fmtCredits(usage.credits?.balance);
    if (bal) out.push(`   credits ${bal}`);
  }

  const lastLine = codexLastRunLine(tally?.last, { now });
  if (lastLine) out.push(`   ${lastLine}`);
  const spend = codexSpendLine(tally);
  if (spend) out.push(`   ${spend}`);
  out.push(`   ${fallback} · /codex <question> · /codex review [repo]`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// THE CACHED READER
//
// One snapshot per minute, shared by every caller, exactly like the Claude usage
// cache. The three reads (auth file, rate limits, run sidecars) are injected so
// the daemon supplies real ones and a test supplies fakes.
// ---------------------------------------------------------------------------

export function createCodexAccount({ readAuth, fetchLimits, listRuns, ttlMs = CODEX_USAGE_TTL_MS, timeZone = 'UTC', now = () => Date.now() } = {}) {
  let cache = null; // { at, value }
  let inflight = null;

  async function build() {
    const identity = readCodexIdentity(typeof readAuth === 'function' ? readAuth() : null);
    const tally = tallyCodexRuns(typeof listRuns === 'function' ? listRuns() : [], { now: now(), timeZone });
    // Only a subscription login has plan windows. An API-key login and a missing
    // one are both answered from disk, with no spawn and no wait.
    if (identity.state !== 'chatgpt' || typeof fetchLimits !== 'function') {
      return { identity, usage: null, usageError: null, tally };
    }
    const r = await fetchLimits();
    return { identity, usage: r?.ok ? r.usage : null, usageError: r?.ok ? null : r?.error || 'usage unavailable', tally };
  }

  return {
    /**
     * The cached snapshot, refreshed when it is older than the TTL. Concurrent
     * callers share one build: /account can be tapped twice in a second and that
     * must not be two app-server spawns.
     */
    async snapshot({ force = false } = {}) {
      const t = now();
      if (!force && cache && t - cache.at < ttlMs) return cache.value;
      if (inflight) return inflight;
      inflight = build()
        .then((value) => {
          cache = { at: now(), value };
          return value;
        })
        .catch(() => {
          // build() is written not to throw; if it ever does, the view degrades
          // rather than the reply failing.
          const value = { identity: { state: 'broken', error: 'the codex account could not be read' }, usage: null, usageError: null, tally: null };
          cache = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate() {
      cache = null;
    },
    peek() {
      return cache?.value || null;
    },
  };
}
