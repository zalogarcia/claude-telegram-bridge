// LIVE PLAN USAGE per Claude account — the 5-hour block and the weekly window,
// read from Anthropic's own OAuth usage endpoint, for EVERY enrolled account
// rather than just the one that happens to be the live login.
//
// SHARED MODULE — byte-identical in the public and private bridge repos, and
// listed in scripts/check-shared.sh. It handles OAuth credentials but contains
// none, and it touches nothing but `fetch` and the injected account store.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// accounts.mjs can rotate to another account when a worker DIES on a session
// limit. That is reactive: the cost of learning an account is out of headroom is
// one dead worker. These numbers make it predictive — the rotation (and the
// owner, from their phone) can see that an account is at 92% of its 5h block
// and start the next job somewhere else, before anything dies.
//
// usage-limits.mjs is a DIFFERENT, older thing and is left alone: it reads plan
// limits out of a statusline-fed cache file for THIS MACHINE's current login
// only, which is exactly what /context wants and exactly what this needs not to
// be. This module is per-account and goes to the network.
//
// ---------------------------------------------------------------------------
// THE ENDPOINTS (probed live 2026-08-31 against all three accounts, CC 2.1.252)
//
//   GET https://api.anthropic.com/api/oauth/usage     -> the numbers
//   GET https://api.anthropic.com/api/oauth/profile   -> who this token is
//   POST https://api.anthropic.com/v1/oauth/token     -> refresh (see below)
//
// All three want the same three headers: a bearer access token, the
// `anthropic-beta: oauth-2025-04-20` opt-in, and Claude Code's own User-Agent.
//
// The usage body carries the same numbers twice. `five_hour`/`seven_day` are the
// flat legacy view; `limits[]` is the richer one, with a server-provided
// `severity` label and per-model `weekly_scoped` rows. We prefer `limits[]` when
// present and fall back to the flat pair when it is not, so a server-side
// reshuffle of either half degrades instead of blanking the display.
//
// `utilization`/`percent` is PERCENT USED. 31 means 31% consumed, 69% left.
// `locked_reason` non-null means that window is exhausted.
//
// ---------------------------------------------------------------------------
// THE REFRESH RULES — the dangerous part
//
// A refresh ROTATES the refresh token. The old one dies the moment the new one
// is issued, so a refresh whose result is not persisted leaves that account
// unusable until the owner logs into it by hand. Every rule below exists to make that
// outcome unreachable:
//
//   1. NEVER refresh the account that is live in the credential store. The
//      running Claude Code session owns that one and refreshes it itself;
//      racing it would rotate the token out from under a live session. For the
//      live account the token is read from the CREDENTIAL STORE, which is
//      always current, never from accounts.json, which can be hours stale.
//   2. If the live account cannot be IDENTIFIED, refresh nothing at all. An
//      unidentified live login means any refresh might be racing the session,
//      so the conservative move is to show what stored non-expired tokens allow
//      and mark the rest unavailable.
//   3. Refresh an idle account only when its access token has actually expired
//      (five minute skew), and at most ONCE per call. No retry loop: a second
//      attempt would burn a second refresh token on the same failure.
//   4. Persist the rotated blob through accounts.mjs's own atomic writer BEFORE
//      the new token is used for anything. Not a second writer, not a partial
//      update — the same tmp+rename+chmod 0600 path everything else uses.
//   5. If that persist fails, this is the one failure that must NOT degrade
//      quietly. The token in hand works but the one on disk is dead, so the
//      account is reported as broken and loudly, rather than shown a usage
//      number that hides it.
//
// Everything ELSE degrades silently to "usage unavailable" for that account: a
// timeout, a 500, a 401, unparseable JSON. A usage number decorates a reply; it
// may never take one down.
//
// NOTHING here prints a token. Access and refresh tokens appear only as
// arguments and in request headers; every rendering of credentials goes through
// accounts.mjs's fingerprint(). Error strings are built from status codes and
// short server-side error CODES, never from response bodies, because a body is
// the one place a token could come back at us and get logged.
// ---------------------------------------------------------------------------

import { fingerprint, matchAccount } from './accounts.mjs';
import { fmtAge } from './progress-render.mjs';

const API = 'https://api.anthropic.com';
// Claude Code's own OAuth client, read off the verified /api/oauth/profile
// response (application.uuid) rather than guessed from a binary.
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const CLI_USER_AGENT = 'claude-cli/2.1.252 (external, cli)';

// What Claude Code itself allows a usage call. Long enough for a cold TLS
// handshake, short enough that three dead requests still leave /status snappy.
export const REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_TTL_MS = 60_000;
// Refresh only when the token is genuinely done. The skew keeps a token that
// expires mid-flight from being sent.
export const EXPIRY_SKEW_MS = 5 * 60_000;

// The zone reset clocks render in. The owner may not be where the daemon is,
// so every renderer takes `timeZone` as an option — the bridges inject the
// owner's zone (the private one pins it; the public one reads its `ownerTz`
// config) — and this local default only carries a call that injects nothing.
const LOCAL_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

// ---------------------------------------------------------------------------
// PURE FORMATTERS (unit-tested in account-usage.test.mjs; no network, no clock
// of their own — `now` is always a parameter so a test can pin it)
// ---------------------------------------------------------------------------

// Number(null) is 0, not NaN — so a window the server did not send would render
// as a confident "0% used" instead of "n/a". Every percent in this file goes
// through here first.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function fmtPercent(p) {
  const n = num(p);
  if (n === null) return 'n/a';
  return `${Math.round(Math.min(100, Math.max(0, n)))}%`;
}

// A ten-cell bar. Filled cells are CONSUMED, matching the percent beside it, so
// a full bar reads as "no headroom" the way the number does.
export function usageBar(percent) {
  const n = num(percent);
  if (n === null) return '░'.repeat(10);
  const filled = Math.min(10, Math.max(0, Math.round(Math.min(100, Math.max(0, n)) / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// Accepts an ISO string (what the API returns), an epoch-millisecond number, or
// a Date. Epoch SECONDS are deliberately NOT accepted — see fmtResetLeft.
function toMs(resetsAt) {
  if (resetsAt instanceof Date) return resetsAt.getTime();
  if (typeof resetsAt === 'number') return Number.isFinite(resetsAt) ? resetsAt : NaN;
  if (typeof resetsAt === 'string') return Date.parse(resetsAt);
  return NaN;
}

function dayLabel(ms, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month}`;
}

// Just "Sat". The compact half of dayLabel, for the /account rows.
function weekdayLabel(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(ms));
}

// "2h 21m left", and past a day "Fri 5 Sep, 4d 7h left" — because a bare
// "4d 7h" tells the reader how long but not which morning the window is back.
//
// A SIBLING of usage-limits.mjs's fmtLeft rather than a reuse, for two reasons
// that are contract-level, not cosmetic: fmtLeft takes epoch SECONDS (this API
// returns ISO 8601, and feeding one to the other reads as far-future rather than
// as an error), and it reads Date.now() internally, so a "4d 7h" case could only
// be tested by moving the wall clock. Both of those are exactly what the unit
// contract comment on fmtLeft warns about, so this takes ISO/ms and takes `now`.
export function fmtResetLeft(resetsAt, now = Date.now(), { timeZone = LOCAL_TZ, withDay = true, withLeft = true } = {}) {
  const ms = toMs(resetsAt);
  if (!Number.isFinite(ms)) return 'unknown';
  const delta = ms - Number(now);
  if (!Number.isFinite(delta) || delta <= 0) return 'due now';
  const mins = Math.round(delta / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  // withLeft:false for the compact /account rows only, where the span already
  // follows "resets <clock> · " and the word is four characters of a phone line
  // spent saying what the sentence already said. Everywhere else it stays,
  // because "4d 7h" on its own is ambiguous between elapsed and remaining.
  const tail = withLeft ? ' left' : '';
  // withDay:false when the caller already printed the absolute clock beside
  // this, which carries the day itself — "resets Sat 5 Sep 1:00am · Sat 5 Sep,
  // 4d 6h left" says Saturday twice.
  return d > 0 && withDay ? `${dayLabel(ms, timeZone)}, ${span}${tail}` : `${span}${tail}`;
}

// The absolute clock, in the OWNER'S zone: "6:10pm" when it is later today, "Fri 5 Sep
// 1:00am" when it is not, so a reset four days out is never mistaken for tonight.
//
// compact:true drops the date from the day label ("Fri 1:00am"). Only for the
// /account rows, where every window is at most seven days out so a weekday is
// already unambiguous and the two words buy back room on a phone line. /usage
// keeps the date: it is the diagnostic view and a date is never wrong there.
export function fmtResetClock(resetsAt, { timeZone = LOCAL_TZ, now = Date.now(), compact = false } = {}) {
  const ms = toMs(resetsAt);
  if (!Number.isFinite(ms)) return 'unknown';
  const t = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(ms))
    .replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase() + 'm');
  const dayOf = (v) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
  if (dayOf(ms) === dayOf(Number(now))) return t;
  const day = compact ? weekdayLabel(ms, timeZone) : dayLabel(ms, timeZone);
  return `${day} ${t}`;
}

// ---------------------------------------------------------------------------
// NORMALIZATION
// ---------------------------------------------------------------------------

function win(percent, resetsAt, severity, locked) {
  return {
    percent: num(percent),
    resetsAt: resetsAt || null,
    severity: severity || null,
    locked: locked || null, // the server's reason string, or null. Truthy = exhausted.
  };
}

function scopedLabel(scope) {
  if (!scope || typeof scope !== 'object') return 'scoped';
  return scope.model?.display_name || scope.model?.id || scope.surface || 'scoped';
}

// `limits[]` when the server sends it, the flat `five_hour`/`seven_day` pair
// when it does not. Never throws: a body shaped in a way we do not recognise
// yields nulls, which render as "n/a", rather than an exception inside a reply.
export function normalizeUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const byKind = (k) => limits.find((l) => l && l.kind === k);

  const session = byKind('session');
  const weekly = byKind('weekly_all');

  const fiveHour = session
    ? win(session.percent, session.resets_at, session.severity, body.five_hour?.locked_reason)
    : body.five_hour
      ? win(body.five_hour.utilization, body.five_hour.resets_at, null, body.five_hour.locked_reason)
      : null;

  const sevenDay = weekly
    ? win(weekly.percent, weekly.resets_at, weekly.severity, body.seven_day?.locked_reason)
    : body.seven_day
      ? win(body.seven_day.utilization, body.seven_day.resets_at, null, body.seven_day.locked_reason)
      : null;

  const scoped = limits
    .filter((l) => l && l.kind === 'weekly_scoped')
    .map((l) => ({ label: scopedLabel(l.scope), percent: num(l.percent), resetsAt: l.resets_at || null }));

  // Flat per-model windows only matter when limits[] is missing; when it is
  // present the weekly_scoped rows above are the same data, better labelled.
  if (!limits.length) {
    for (const [key, label] of [
      ['seven_day_opus', 'Opus'],
      ['seven_day_sonnet', 'Sonnet'],
    ]) {
      const w = body[key];
      if (w && num(w.utilization) !== null) {
        scoped.push({ label, percent: num(w.utilization), resetsAt: w.resets_at || null });
      }
    }
  }

  const eu = body.extra_usage;
  const extraUsage = eu
    ? {
        enabled: !!eu.is_enabled,
        percent: num(eu.utilization),
        usedCredits: num(eu.used_credits),
        monthlyLimit: num(eu.monthly_limit),
      }
    : null;

  if (!fiveHour && !sevenDay) return null; // nothing recognisable in the body
  return { fiveHour, sevenDay, scoped, extraUsage };
}

// ---------------------------------------------------------------------------
// NETWORK
// ---------------------------------------------------------------------------

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': OAUTH_BETA,
    'User-Agent': CLI_USER_AGENT,
    Accept: 'application/json',
  };
}

// One GET, JSON or null. Never throws and never rejects, for the same reason
// usage-limits.mjs's execJson does not: the caller is decorating a reply.
async function getJson(url, accessToken, fetchImpl, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: authHeaders(accessToken), signal: ctl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null; // timeout, DNS, TLS, non-JSON — all the same to the caller
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchUsage(
  accessToken,
  { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, wallClockOnly = false } = {},
) {
  if (!accessToken) return null;
  // Claude Code uses the query-string variant when it wants only the wall-clock
  // numbers and no spend rollup; kept as an option, off by default because the
  // full body is what /usage renders.
  const url = `${API}/api/oauth/usage${wallClockOnly ? '?at_wall=1&skip_spend=1' : ''}`;
  const body = await getJson(url, accessToken, fetchImpl, timeoutMs);
  return normalizeUsage(body);
}

// Identity for a token, which is how an account is recognised after its tokens
// have rotated and no longer fingerprint-match anything on disk.
export async function fetchProfile(accessToken, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!accessToken) return null;
  const body = await getJson(`${API}/api/oauth/profile`, accessToken, fetchImpl, timeoutMs);
  if (!body || typeof body !== 'object' || !body.account) return null;
  return {
    email: body.account.email || null,
    fullName: body.account.full_name || null,
    tier: body.organization?.rate_limit_tier || null,
  };
}

// THE DANGEROUS CALL. Unlike everything else in this file it THROWS, because
// its failure is not a missing number, it is a possibly-dead account: a caller
// that treated it as "null means no usage" would hide the one outcome that needs
// saying out loud.
//
// The wire format below is the one place in this module that was not probed
// live, deliberately: executing a refresh rotates a real refresh token, and a
// botched one locks the account out until the owner logs in by hand. The parsing is
// therefore written to be tolerant of shape — snake_case or camelCase, a
// rotated refresh token or a preserved one — and `previous` carries through
// every field the response does not restate.
export async function refreshAccessToken({
  refreshToken,
  clientId = CLAUDE_CODE_CLIENT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  previous = null,
  now = Date.now(),
} = {}) {
  if (!refreshToken) throw new Error('refreshAccessToken: a refresh token is required');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${API}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CLI_USER_AGENT, Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(`token refresh could not be sent (${e?.name === 'AbortError' ? 'timed out' : 'network error'})`);
  } finally {
    clearTimeout(timer);
  }

  if (!res || !res.ok) {
    // Only the STATUS and the server's short error CODE. Never the body: an
    // OAuth error body is the one response that could echo a token back, and an
    // error string is exactly what ends up in a log.
    let code = '';
    try {
      const j = await res.json();
      if (typeof j?.error === 'string' && j.error.length <= 80) code = ` (${j.error})`;
      else if (typeof j?.error?.type === 'string' && j.error.type.length <= 80) code = ` (${j.error.type})`;
    } catch {
      /* body unreadable; the status alone is the message */
    }
    throw new Error(`token refresh rejected: HTTP ${res?.status ?? '???'}${code}`);
  }

  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error('token refresh returned a body that is not JSON');
  }

  const accessToken = j.access_token || j.accessToken;
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('token refresh returned no access token');
  }
  const expiresIn = Number(j.expires_in ?? j.expiresIn);
  const expiresAt = Number.isFinite(expiresIn)
    ? Number(now) + expiresIn * 1000
    : Number(j.expires_at ?? j.expiresAt) || null;
  const scopes = typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(Boolean) : previous?.scopes || [];

  return {
    ...(previous || {}),
    accessToken,
    // Anthropic rotates the refresh token; if a future response ever stops
    // doing so, keeping the old one is correct rather than writing undefined.
    refreshToken: j.refresh_token || j.refreshToken || refreshToken,
    expiresAt,
    refreshTokenExpiresAt:
      Number(j.refresh_token_expires_at ?? j.refreshTokenExpiresAt) || previous?.refreshTokenExpiresAt || null,
    scopes,
    subscriptionType: j.subscription_type || previous?.subscriptionType || null,
    rateLimitTier: j.rate_limit_tier || previous?.rateLimitTier || null,
  };
}

// ---------------------------------------------------------------------------
// TTL CACHE
//
// Module-level, so `invalidateUsageCache()` is one call that clears everything
// regardless of how many readers exist, which is what /account's post-swap
// refresh and the tests both want. Keyed by account name (and by fingerprint for
// profile lookups). Failures are cached too, for the same TTL: when the API is
// down, three dead 5s requests per /status is the cost of NOT caching them.
// ---------------------------------------------------------------------------
const cache = new Map();

export function invalidateUsageCache(key = null) {
  if (key) cache.delete(key);
  else cache.clear();
}

function cacheGet(key, nowMs) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.until <= nowMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value, nowMs, ttlMs) {
  cache.set(key, { value, until: nowMs + ttlMs });
  return value;
}

// ---------------------------------------------------------------------------
// THE READER
//
// A factory taking its dependencies, exactly like createAccountStore: the fetch
// implementation, the clock and the account store are all injected, so the tests
// never touch the network, a real credential store or a real accounts.json.
// ---------------------------------------------------------------------------
export function createAccountUsage({
  store,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  clientId = CLAUDE_CODE_CLIENT_ID,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = (msg) => console.log(`[account-usage] ${msg}`),
} = {}) {
  if (!store) throw new Error('createAccountUsage: an account `store` is required');

  // Which slot is live, and therefore which one must never be refreshed.
  //
  // Fingerprint matching stays the fast path because it costs nothing. It stops
  // working the moment the live session refreshes its own token, which is why
  // /account has been printing "Active: unknown" — so the fallback is the
  // profile endpoint, whose email is stable across every rotation.
  async function resolveActive() {
    const live = await store.readCredentials().catch(() => null);
    if (!live?.claudeAiOauth?.accessToken) {
      return { name: null, matchedBy: null, oauth: null, liveFingerprint: 'none', email: null, fullName: null };
    }
    const oauth = live.claudeAiOauth;
    const liveFingerprint = fingerprint(oauth);
    const list = store.listAccounts();
    const hit = matchAccount(list, oauth);
    if (hit) {
      return {
        name: hit.account.name,
        matchedBy: hit.matchedBy,
        oauth,
        liveFingerprint,
        email: hit.account.email || null,
        fullName: null,
      };
    }

    const key = `profile:${liveFingerprint}`;
    const t = now();
    let prof = cacheGet(key, t);
    if (prof === undefined) {
      prof = cacheSet(key, await fetchProfile(oauth.accessToken, { fetchImpl, timeoutMs }), t, ttlMs);
    }
    if (prof?.email) {
      const e = prof.email.toLowerCase();
      const slot = list.find((a) => (a.email || '').toLowerCase() === e || (a.name || '').toLowerCase() === e);
      if (slot) {
        return { name: slot.name, matchedBy: 'profileEmail', oauth, liveFingerprint, email: prof.email, fullName: prof.fullName };
      }
      // A real identity that matches no slot is still worth showing: it names
      // the login instead of printing "unknown" next to a fingerprint.
      return { name: null, matchedBy: 'profileEmailUnenrolled', oauth, liveFingerprint, email: prof.email, fullName: prof.fullName };
    }
    return { name: null, matchedBy: null, oauth, liveFingerprint, email: null, fullName: null };
  }

  // Decide which access token to use for one slot, refreshing only when every
  // rule in the header allows it. Returns { token } or { state, error }.
  async function tokenFor(acct, active) {
    if (active.name && acct.name === active.name) {
      // Rule 1: the live account's token comes from the credential store,
      // never from accounts.json, and is never refreshed here.
      return { token: active.oauth.accessToken, live: true };
    }
    const oauth = acct.claudeAiOauth;
    if (!oauth?.accessToken) return { state: 'no-credentials', error: 'no credentials captured for this slot' };

    const t = now();
    const rtExp = Number(oauth.refreshTokenExpiresAt);
    if (Number.isFinite(rtExp) && rtExp > 0 && rtExp <= t) {
      return {
        state: 'credentials-expired',
        error: `credentials expired, run /account capture ${acct.name} after logging in`,
      };
    }

    const exp = Number(oauth.expiresAt);
    const expired = Number.isFinite(exp) && exp > 0 && exp - EXPIRY_SKEW_MS <= t;
    if (!expired) return { token: oauth.accessToken, live: false };

    // Rule 2: an unidentified live login means we cannot prove this slot is idle.
    if (!active.name) {
      return {
        state: 'unavailable',
        error: 'access token expired and the live account could not be identified, so no refresh was attempted',
      };
    }

    // Rule 3: one attempt, no retry loop.
    let blob;
    try {
      blob = await refreshAccessToken({
        refreshToken: oauth.refreshToken,
        clientId,
        fetchImpl,
        timeoutMs,
        previous: oauth,
        now: t,
      });
    } catch (e) {
      log(`refresh failed for "${acct.name}": ${e.message}`);
      return { state: 'refresh-failed', error: e.message };
    }

    // Rules 4 and 5: persist through accounts.mjs's atomic writer BEFORE use,
    // and shout if that fails, because the token on disk is now dead.
    try {
      const r = store.bankOauth(acct.name, blob);
      if (!r?.ok) throw new Error(r?.error || 'the account store refused the write');
    } catch (e) {
      const msg = `REFRESHED BUT NOT SAVED for "${acct.name}" (${fingerprint(blob)}): ${e.message}. The old refresh token is now dead — re-capture this account.`;
      log(msg);
      return { state: 'persist-failed', error: msg };
    }
    log(`refreshed the expired token for idle account "${acct.name}" (${fingerprint(blob)})`);
    return { token: blob.accessToken, live: false, refreshed: true };
  }

  async function readOne(acct, active) {
    const t = now();
    const cached = cacheGet(acct.name, t);
    if (cached !== undefined) return { ...cached, cached: true };

    // The fingerprint travels on the row so /usage can print it. It moved there
    // out of /account, which is the daily view and did not need three token
    // digests on it; /usage is the diagnostic view, and telling three accounts
    // apart when their identity is in doubt is exactly what it is for.
    const base = {
      name: acct.name,
      email: acct.email || null,
      live: active.name === acct.name,
      fingerprint: fingerprint(acct.claudeAiOauth),
    };
    const tok = await tokenFor(acct, active);
    if (!tok.token) {
      return cacheSet(acct.name, { ...base, state: tok.state, error: tok.error, usage: null }, t, ttlMs);
    }
    const usage = await fetchUsage(tok.token, { fetchImpl, timeoutMs });
    const row = usage
      ? { ...base, state: 'ok', usage, refreshed: !!tok.refreshed }
      : { ...base, state: 'unavailable', error: 'usage unavailable', usage: null };
    return cacheSet(acct.name, row, t, ttlMs);
  }

  return {
    resolveActive,
    invalidate: invalidateUsageCache,

    // Whatever is already in the TTL cache for this slot, or null. Synchronous
    // and network-free BY CONSTRUCTION, which is the whole point: the swap
    // confirmation wants a headroom line but must never wait on the API for
    // one. A cold cache means the confirmation ships without that line, not
    // that the confirmation is late. Callers must read this BEFORE anything
    // that calls invalidate().
    peek(name) {
      if (!name) return null;
      return cacheGet(name, now()) ?? null;
    },

    // Every account, concurrently. One slow account must not serialise the rest.
    async all() {
      const active = await resolveActive();
      const list = store.listAccounts();
      const rows = await Promise.all(list.map((a) => readOne(a, active)));
      return { active, rows };
    },

    // Just the live one, for /status's single compact line.
    async activeOnly() {
      const active = await resolveActive();
      if (!active.oauth) return { active, row: null };
      const list = store.listAccounts();
      const acct = active.name ? list.find((a) => a.name === active.name) : null;
      // An unenrolled or not-yet-identified login still has a working token in
      // the credential store. Naming it locally routes it down the LIVE branch
      // of tokenFor (live token, never refreshed) instead of reporting "no
      // credentials captured" for the account that is actually running.
      const synthetic = acct || { name: active.name || active.email || 'the live login', email: active.email || null };
      const row = await readOne(synthetic, { ...active, name: synthetic.name });
      return { active, row };
    },
  };
}

// ---------------------------------------------------------------------------
// RENDERERS — here rather than in bridge.mjs so the exact strings the owner
// reads on their phone can be asserted by a unit test instead of eyeballed in
// Telegram.
// ---------------------------------------------------------------------------

// The "Active: …" line of /account and /usage. Lives here, not inline in the
// bridge's switch, so the exact string the owner reads can be asserted by a test and
// printed by a live probe instead of eyeballed in Telegram.
//
// This is the line that used to read "Active: unknown a…8dkwAA/r…U7DQAA": the
// fingerprint match against accounts.json stops working the moment the running
// session refreshes its own token, which on this machine is most of the time.
// The profile email survives every rotation, so it is the authority and the
// fingerprint is demoted to a fast path.
//
// The name travels in a CODE SPAN rather than bold, and that is not a style
// choice. Every account name here is an email address, and Telegram's clients
// auto-detect a bare email in message text and render it as a blue mailto link:
// noise on a view that is nothing but email addresses, and a mis-tap opens a
// mail composer instead of doing anything useful. A code entity claims the
// range, so no overlapping email entity is emitted for it, and fixed width is
// what an identifier should look like anyway. Same reason in renderAccountList
// and renderUsageReport — every rendering of a name in this file.
export function activeLine(live) {
  const fp = live?.liveFingerprint || 'none';
  if (live?.name) {
    const via = live.matchedBy === 'profileEmail' ? ' (identified by profile — its tokens have rotated since capture)' : '';
    return `Active: \`${live.name}\` \`${fp}\`${via}`;
  }
  if (live?.email) {
    return `Active: \`${live.email}\` \`${fp}\` — signed in but not enrolled, run /account capture <name> to bank it`;
  }
  return `Active: unknown \`${fp}\`, run /account capture <name> to bank it`;
}

// One window, inline: percent, the absolute reset clock in the owner's zone, and the
// countdown. Both halves are deliberate — a bare "4h 12m left" makes you do the
// arithmetic to know when, and a bare "10:40pm" makes you do it to know how long.
function windowInline(title, w, { now, timeZone }) {
  if (!w) return null;
  const pct = `${title} ${fmtPercent(w.percent)}${w.locked ? ' ⛔' : ''}`;
  // A null reset with nothing consumed is not missing data: it is what the API
  // sends when no 5-hour block is open. Observed on a live account.
  if (!w.resetsAt) return `${pct} · ${w.percent === null || w.percent === 0 ? 'no active block' : 'no reset time'}`;
  return `${pct} · resets ${fmtResetClock(w.resetsAt, { timeZone, now })} · ${fmtResetLeft(w.resetsAt, now, { timeZone, withDay: false })}`;
}

// The /status block. Null when there is nothing to say, so the caller omits it
// rather than printing an error into a liveness view. Multi-line on purpose:
// the reset clock and the time left were both asked for, and neither fits
// beside the other on a phone.
export function usageLine(row, { now = Date.now(), timeZone = LOCAL_TZ } = {}) {
  if (!row || row.state !== 'ok' || !row.usage) return null;
  const bits = [
    windowInline('5h', row.usage.fiveHour, { now, timeZone }),
    windowInline('wk', row.usage.sevenDay, { now, timeZone }),
  ].filter(Boolean);
  if (!bits.length) return null;
  return [`👤 ${row.email || row.name}`, ...bits.map((b) => `   ${b}`)].join('\n');
}

// ---------------------------------------------------------------------------
// THE /account VIEW
//
// The daily view: which account am I on, how much headroom has each one got,
// and tap to move. It used to carry a token fingerprint on every row — worth it
// while "Active: unknown" was live and identity was genuinely in doubt, pure
// clutter now that it is not. The fingerprints moved to /usage (and stay on the
// activeLine above, which is the one place identity can still be ambiguous).
//
// The bars come from usageBar(), the same function /usage renders, so the two
// views cannot drift into two different pictures of the same number.
// ---------------------------------------------------------------------------

// "last used 0m ago" on the row you are looking at is noise — of course it was
// just used, you are looking at it. An account untouched for days is the only
// version of that fact worth a line.
export const IDLE_FLOOR_MS = 60 * 60_000;

// One window as a bar row. The title, bar and percent share ONE code span so the
// 5h and wk rows line up under each other in Telegram's proportional font; the
// prose after it is prose and does not need to.
function accountWindowLine(title, w, { now, timeZone }) {
  if (!w) return null;
  const gauge = `\`${title} ${usageBar(w.percent)} ${fmtPercent(w.percent).padStart(4)}\`${w.locked ? ' ⛔' : ''}`;
  // A null reset with nothing consumed is not missing data: it is what the API
  // sends when no 5-hour block is open, which is the BEST account to start the
  // next job on. Observed on a live account.
  if (!w.resetsAt) return `   ${gauge} ${w.percent === null || w.percent === 0 ? 'no active block' : 'no reset time'}`;
  // Both halves, always: the clock AND the countdown were both asked for, because a
  // bare "3h 45m" makes you work out when and a bare "11:09pm" makes you work
  // out how long. Only the word "left" is dropped — "resets 11:09pm · " has
  // already said which direction the span points.
  const clock = fmtResetClock(w.resetsAt, { timeZone, now, compact: true });
  const left = fmtResetLeft(w.resetsAt, now, { timeZone, withDay: false, withLeft: false });
  return `   ${gauge} resets ${clock} · ${left}`;
}

// The window lines under one /account row, or a single reason there are none.
export function accountUsageBlock(row, { now = Date.now(), timeZone = LOCAL_TZ } = {}) {
  if (!row) return [];
  if (row.state !== 'ok' || !row.usage) return [`   ⚠️ ${row.error || 'usage unavailable'}`];
  const lines = [
    accountWindowLine('5h', row.usage.fiveHour, { now, timeZone }),
    accountWindowLine('wk', row.usage.sevenDay, { now, timeZone }),
  ].filter(Boolean);
  return lines.length ? lines : ['   ⚠️ usage unavailable'];
}

// The name line. `✅ available` is gone: availability is the default state and
// the absence of ⛔ already says it, so printing it on every row spent a line
// per account saying nothing. The two states that are NOT the default stay.
function accountHeadline(r, { liveName, now, timeZone }) {
  const live = !!liveName && r.name === liveName;
  // Two spaces after the bullet so the names line up under the wider ▶︎.
  const bits = [`${live ? '▶︎' : '• '} \`${r.name}\``];
  if (r.limited) {
    // limitedUntil is epoch SECONDS (accounts.mjs's contract); fmtResetLeft
    // takes ms, and handing it seconds would read as 1970 — "due now" — on the
    // one row where being wrong about the clock matters.
    bits.push(`  ⛔ limited · ${fmtResetLeft(Number(r.limitedUntil) * 1000, now, { timeZone, withDay: false, withLeft: false })}`);
  } else if (!r.captured) {
    bits.push('  ⚠️ no credentials captured');
  }
  const age = r.lastActiveAt ? Number(now) - Date.parse(r.lastActiveAt) : NaN;
  if (Number.isFinite(age) && age >= IDLE_FLOOR_MS) bits.push(` · idle ${fmtAge(age)}`);
  return bits.join('');
}

// The live account first. The owner opens /account to see where they are and usually to
// leave; hunting down the list for the ▶︎ is work the reader should not do.
function orderLiveFirst(rows, liveName) {
  const list = [...rows];
  if (!liveName) return list;
  const i = list.findIndex((r) => r?.name === liveName);
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list;
}

// The parked-credentials warning. One line, and it rides every /account render
// while something is parked: a parked blob is a real credential that belongs in
// a slot, and a warning that can scroll away is a warning that never happened.
// Takes the store's describeUnclaimed() shape — fingerprint only, never a token.
export function unclaimedLine(u) {
  if (!u) return null;
  const who = u.email ? ` from \`${u.email}\`` : '';
  return `⚠️ unclaimed credentials parked${who} (\`${u.fingerprint || '?'}\`) — /account capture <name> to claim`;
}

// The whole /account body. Pure: the caller does the fetching, this only decides
// what the strings say, so the exact text the owner reads on their phone is
// assertable in a unit test instead of eyeballed in Telegram.
export function renderAccountList(
  { rows = [], live = null, usageRows = [], unclaimed = null },
  { now = Date.now(), timeZone = LOCAL_TZ } = {},
) {
  const byName = new Map((usageRows || []).map((u) => [u.name, u]));
  const list = (rows || []).filter((r) => r && r.name);
  const liveName = live?.name || null;
  const out = ['👤 **Claude Code accounts**'];
  // The "Active:" header repeats a name that ▶︎ has already marked, so it goes —
  // EXCEPT when ▶︎ can say nothing: a login matching no slot, or one that could
  // not be identified at all. There the line is carrying real information (and
  // the only fingerprint left in this view), so it stays.
  if (!liveName || !list.some((r) => r.name === liveName)) out.push(activeLine(live));
  for (const r of orderLiveFirst(list, liveName)) {
    out.push('', accountHeadline(r, { liveName, now, timeZone }));
    // No row at all means the whole usage snapshot was deadlined out. Say so on
    // the account rather than leaving a bare name: three names with no numbers
    // and no explanation reads as a broken view, not as a slow API.
    out.push(...accountUsageBlock(byName.get(r.name) || { state: 'unavailable', error: 'usage unavailable' }, { now, timeZone }));
  }
  const parked = unclaimedLine(unclaimed);
  if (parked) out.push('', parked);
  // One line. /account capture <name> is in /help; it does not need to ride on
  // every render of a view the owner opens several times a day.
  out.push('', 'Tap to swap · /usage for detail');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// THE STANDALONE CONFIRMATIONS
//
// A swap used to announce itself in two places that both fail on a phone: an
// answerCallbackQuery toast, gone in five seconds, and an EDIT to the /account
// message, invisible the moment that message has scrolled off screen. Between
// them a successful swap could look like the tap did nothing at all. These are
// NEW messages — short enough to read whole in a notification, and they arrive
// wherever the owner is in the chat.
// ---------------------------------------------------------------------------

// "5h 0% · wk 31%", or null. Deliberately takes an already-fetched row and
// never fetches one: a confirmation that waits on a network round trip is a
// confirmation that arrives after the reader has given up on it.
export function usageBrief(row) {
  if (!row || row.state !== 'ok' || !row.usage) return null;
  const one = (title, w) => (w ? `${title} ${fmtPercent(w.percent)}${w.locked ? ' ⛔' : ''}` : null);
  const bits = [one('5h', row.usage.fiveHour), one('wk', row.usage.sevenDay)].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

// The names WE render are code-wrapped at the point we write them. The names
// inside an ERROR STRING are not: `no account slot named "x@y.z"` and `slot "a"
// belongs to b@c.d, not e@f.g` both arrive as prose from accounts.mjs, and
// Telegram linkifies those addresses exactly like any other. So every error
// that reaches a markdown send goes through here first.
//
// Deliberately NOT applied to the answerCallbackQuery toast: that call takes no
// parse mode, so a backtick there renders as a backtick.
const wrapEmails = (s) =>
  String(s).replace(/(^|[^`\w.@+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1`$2`');

export function swapConfirmation({ to, from = null, usage = null }) {
  const lines = [`🔄 Now on \`${to}\``, `${from ? `was \`${from}\` · ` : ''}MCP tokens kept`];
  const brief = usageBrief(usage);
  if (brief) lines.push(brief);
  return lines.join('\n');
}

// The two swap failures are NOT the same event and must not read the same.
// "the previous account is still active" is routine: nothing moved, try again.
// "the rollback did not take" means the credential store now holds a blob with
// no claudeAiOauth in it and every future worker is dead until the owner runs
// `claude /login`. accounts.mjs's swapTo() already distinguishes them in its
// error string; this makes the urgent one LOOK urgent instead of burying it in
// a toast that disappears.
const ROLLBACK_FAILED = /rollback did not take|claude \/login/i;

export function swapFailure({ to, error, backupPath = null }) {
  const msg = String(error || 'the swap returned no result');
  const urgent = ROLLBACK_FAILED.test(msg);
  const lines = [`${urgent ? '🚨' : '❌'} Swap to \`${to}\` failed`, wrapEmails(msg)];
  // The recovery path rides the 🚨 case only: when the rollback failed, the
  // credential store may hold no usable login, and the one-time backup (the pre-tool
  // known-good blob) is the alternative to a manual /login. On the routine
  // failure nothing was damaged and naming a recovery file would read as if
  // something had been.
  if (urgent && backupPath) {
    lines.push(`A pre-swap credential backup exists at \`${backupPath}\` — its \`blob\` key is the credential payload if /login is not possible.`);
  }
  lines.push(urgent ? 'No worker can start until that login is done.' : 'The live account is unchanged.');
  return lines.join('\n');
}

export function captureConfirmation({ slot, fingerprint: fp = null, replaced = false }) {
  // The fingerprint stays HERE (and on activeLine) after leaving the /account
  // rows: "which blob did I just bank into that slot" is the one question this
  // message exists to answer, and the digest is the only handle on it.
  const tail = fp ? ` · \`${fp}\`` : '';
  return [`📸 Captured the current login into \`${slot}\``, `${replaced ? 'Replaced what was there' : 'New slot'}${tail}`].join('\n');
}

export function captureFailure(error) {
  return `❌ Capture failed\n${wrapEmails(error || 'the capture returned no result')}`;
}

function windowBlock(title, w, { now, timeZone }) {
  if (!w) return [`   ${title} n/a`];
  const sev = w.severity && w.severity !== 'normal' ? ` · ${w.severity}` : '';
  const lock = w.locked ? ` · ⛔ ${w.locked}` : '';
  // A null resets_at with nothing consumed is not missing data: it is what the
  // API sends when no 5-hour block is open yet, which is exactly the account the
  // next job should run on. Observed on a live account. Guarded on
  // the percent so a window WITH usage and no reset time still says so honestly.
  const idle = !w.resetsAt && (w.percent === null || w.percent === 0);
  const reset = w.resetsAt
    ? `resets ${fmtResetClock(w.resetsAt, { timeZone, now })} · ${fmtResetLeft(w.resetsAt, now, { timeZone, withDay: false })}`
    : idle
      ? 'no active block — full headroom'
      : 'no reset time';
  return [`   ${title} \`${usageBar(w.percent)}\` ${fmtPercent(w.percent)}${sev}${lock}`, `   ${reset}`];
}

// The full /usage view. Takes the already-fetched rows so it stays pure.
export function renderUsageReport({ active, rows }, { now = Date.now(), timeZone = LOCAL_TZ } = {}) {
  const out = ['📊 **Claude plan usage** — 5h block + weekly window', activeLine(active)];

  if (!rows?.length) {
    out.push('', 'No accounts captured yet — /account capture <name> banks the current login.');
    return out.join('\n');
  }

  for (const r of rows) {
    // The token fingerprint lives HERE now, not on /account. This is the
    // diagnostic view — telling three accounts apart when their identity is in
    // doubt is exactly what it is for — and /account is the daily one.
    const fp = r.fingerprint ? ` \`${r.fingerprint}\`` : '';
    out.push('', `${r.live ? '▶︎' : '•'} \`${r.name}\`${fp}${r.refreshed ? ' _(token refreshed)_' : ''}`);
    if (r.state !== 'ok' || !r.usage) {
      out.push(`   ⚠️ ${r.error || 'usage unavailable'}`);
      continue;
    }
    out.push(...windowBlock('5h', r.usage.fiveHour, { now, timeZone }));
    out.push(...windowBlock('wk', r.usage.sevenDay, { now, timeZone }));
    for (const s of r.usage.scoped || []) {
      out.push(`   ${s.label} \`${usageBar(s.percent)}\` ${fmtPercent(s.percent)}`);
    }
    const eu = r.usage.extraUsage;
    if (eu?.enabled) {
      out.push(`   extra usage ${fmtPercent(eu.percent)}${eu.usedCredits != null ? ` · ${eu.usedCredits} credits used` : ''}`);
    }
  }
  out.push('', `Times are ${timeZone}. /account <name> to swap.`);
  return out.join('\n');
}
