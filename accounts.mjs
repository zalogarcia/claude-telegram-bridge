// Claude Code ACCOUNT SWITCHER, for an owner who legitimately holds more than
// one Claude subscription (a personal plan and a work plan, say). Each account's
// OAuth credentials are banked in a named slot; a swap makes a different slot
// the live login. The bridge can also rotate to the next enrolled account when
// the active one is rate limited until its reset, so background work continues
// on a subscription that still has headroom. Credentials never leave the
// machine — nothing here talks to any service except Anthropic's own endpoints,
// and only through the injected `identify` dependency.
//
// SHARED MODULE — byte-identical in the public and private bridge repos, and
// listed in scripts/check-shared.sh. It HANDLES credentials but CONTAINS none:
// where they live is behind the injected credential store (credential-store.mjs
// — macOS keychain on darwin, ~/.claude/.credentials.json elsewhere), and
// everything else is injectable too, so tests never touch a real credential
// store and cannot clobber a real accounts.json.
//
// ---------------------------------------------------------------------------
// WHY A SWAP IS NOT A LOGIN
//
// A usage limit does not invalidate credentials. When an account hits its
// session limit its OAuth tokens stay perfectly valid; the account is simply
// rate limited until its reset time. So "switch accounts" is not `/login`, not
// a browser, not a device-code flow. It is writing a different token blob into
// the place Claude Code reads credentials from. That is the whole trick, and it
// is what makes this automatable at all.
//
// ---------------------------------------------------------------------------
// THE BLOB (see credential-store.mjs for where it lives per platform)
//
// JSON with two top-level keys that matter:
//
//   claudeAiOauth: THE ACCOUNT. accessToken, refreshToken, expiresAt,
//                   refreshTokenExpiresAt, scopes, subscriptionType,
//                   rateLimitTier. This is the only thing a swap replaces.
//   mcpOAuth:      THIS MACHINE's MCP server tokens. Per-machine, NOT
//                   per-account.
//
// Swapping the whole blob would clobber the owner's MCP integrations on every
// rotation. mergeBlob() exists so that cannot happen: it replaces exactly one
// key and carries every other key through by reference.
//
// ---------------------------------------------------------------------------
// SNAPSHOT AND RESTORE: THE DESIGN DECISION AND ITS RESIDUAL RACE
//
// A running worker refreshes its own access token and writes the refreshed
// claudeAiOauth straight back to the credential store. Two failure modes
// follow, and the ordering below is chosen to defuse the first and bound the
// second:
//
//   1. A naive swap DISCARDS that refresh. The outgoing account's slot in
//      accounts.json would still hold whatever was captured weeks ago, and its
//      refresh token may since have rotated, so the account becomes unusable on
//      its next turn in the cycle. Fix: swapTo() ALWAYS re-banks the live blob
//      into the OUTGOING account's slot first, then writes the incoming one.
//      Capture-then-swap, never swap-then-hope.
//
//   2. A worker that is still running on the outgoing account may refresh AFTER
//      the swap and write its (old-account) blob over the newly swapped-in one.
//      We accept this rather than kill the worker: killing running workers to
//      rotate an account would destroy exactly the work the rotation exists to
//      protect. Already-running workers keep their in-memory session and keep
//      running; only NEW workers pick up the new account.
//
//      RESIDUAL RACE, stated plainly: between a swap and the next drift check,
//      the credential store can be reverted to the outgoing account by a
//      long-running worker's token refresh. Any worker that starts in that
//      window starts on the limited account and dies immediately.
//
//      Guard: checkDrift() re-reads the live credentials on a slow cadence and
//      compares against the fingerprint swapTo() recorded. If the live blob is
//      identifiable as ANOTHER known slot, that is a clobber: the live blob is
//      banked into that slot (so its refresh is not lost either) and the
//      intended account is re-asserted, with a log line. If the live blob
//      matches no slot by fingerprint, re-asserting could fight the owner (it
//      may be a hand-run /login), so the live credentials are never overridden
//      — but neither is the blob banked on faith. See THE BANKING LADDER.
//
// ---------------------------------------------------------------------------
// THE BANKING LADDER: a blob is banked into a named slot only when its
// IDENTITY is verified. Both banking sites (checkDrift and swapTo's outgoing
// bank) climb the same three rungs:
//
//   1. Fingerprint match against a slot → bank there. No network needed: a
//      matching fingerprint IS that slot's own rotation.
//   2. No fingerprint match → ask the injected `identify` dependency (the
//      profile endpoint) whose account the token is. Identified and a slot's
//      name or email equals that email → bank into THAT slot, even when the
//      guard believed a different slot was active. Identified but no slot
//      matches → park it (below). Never invent a slot.
//   3. identify fails, or was never wired → the blob's owner is unknowable, so
//      it goes into NO named slot. Park it.
//
//   Parking = accounts.unclaimed.json (a SIBLING file, because accounts.json
//   is a bare array and a top-level `unclaimed` key does not fit its format):
//   { claudeAiOauth, email?, seenAt, note }, 0600, replacing any previous
//   parked blob. /account shows one line while something is parked, and a
//   captureCurrent into a slot matching the parked identity consumes it.
//
//   Why: on 2026-08-31 the owner ran a fresh /login into a SECOND account
//   while the guard believed the first was active. The old unidentified-drift
//   path banked whatever it found into whatever slot it believed in, so the
//   second account's tokens landed in the first account's slot — a later swap
//   to that slot would have silently delivered the wrong account. Trusting
//   what you find in a store without verifying whose it is was the root of all
//   three of that night's credential bugs.
//
// ---------------------------------------------------------------------------
// THE ONE-TIME BACKUP: before the FIRST credential write this tool ever
// performs on this machine (a swap or a rollback — not a capture, which only
// writes accounts.json), the live blob is copied to accounts.backup.json
// (0600, atomic, gitignored). It is never overwritten once it exists: it is
// the known-good state from before this tool ever touched the credential
// store, and the recovery path when a write corrupts the store AND the
// rollback fails. Its `blob` key is the exact credential payload.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createCredentialStore } from './credential-store.mjs';

// ---------------------------------------------------------------------------
// PURE HELPERS (unit-tested in accounts.test.mjs; no credential store, no disk)
// ---------------------------------------------------------------------------

// The ONLY representation of a token this codebase is allowed to render. Six
// trailing characters is enough to tell a handful of accounts apart in
// /account and useless to anyone who reads a log. Nothing else may print a
// token, ever.
export function fingerprint(oauth) {
  const tail = (v) => (typeof v === 'string' && v.length >= 6 ? v.slice(-6) : v ? '??????' : 'none');
  if (!oauth || typeof oauth !== 'object') return 'none';
  return `a…${tail(oauth.accessToken)}/r…${tail(oauth.refreshToken)}`;
}

// Replace exactly one key. Every other top-level key (mcpOAuth above all, but
// also anything a future Claude Code version adds) is carried through by
// reference, so it survives a round trip byte for byte.
// A blob only counts as credentials if it actually carries an access token.
// `claudeAiOauth: {}` with no token inside is what Claude Code leaves behind
// when a refresh FAILS, and the old drift guard tested only for the KEY, so it
// sailed straight through and banked that nothing over a slot's real token.
// Not hypothetical: on 2026-08-31 it emptied two enrolled slots in a row,
// logging `DRIFT: … changed to a...none/r...none ... re-banked`, and the
// owner had to run /login. Banking nothing over something is never correct.
export function hasCredentials(blob) {
  return !!blob?.claudeAiOauth?.accessToken;
}

export function mergeBlob(currentBlob, incomingOauth) {
  if (!incomingOauth || typeof incomingOauth !== 'object') {
    throw new Error('mergeBlob: incoming claudeAiOauth is required');
  }
  const base = currentBlob && typeof currentBlob === 'object' ? currentBlob : {};
  return { ...base, claudeAiOauth: incomingOauth };
}

// Phrase-anchored: a bare "limit" is not a signal. Callers must additionally
// restrict this to a worker's FAILURE channel. Worker ANSWERS routinely quote
// these phrases verbatim (a usage-audit worker's report is wall to wall
// "You've hit your session limit"), and treating a quote as a limit would
// rotate accounts for no reason.
const LIMIT_PHRASES = [
  /hit your session limit/i,
  /hit your usage limit/i,
  /session limit reached/i,
  /usage limit reached/i,
  /claude ai usage limit reached/i,
];
export function isLimitSignal(text) {
  const s = String(text || '');
  return LIMIT_PHRASES.some((re) => re.test(s));
}

// Wall-clock time in a named zone to an absolute epoch. Intl is the only
// DST-correct arithmetic available without a dependency: format an instant IN
// the zone, read back the wall clock, and the difference is that zone's offset
// at that instant. Two passes because the offset used to place the guess can
// itself be the wrong side of a DST boundary.
function zoneOffsetMs(timeZone, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)) - utcMs;
}

function zonedWallClockToEpochMs(timeZone, y, mo, d, h, mi) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = naive - zoneOffsetMs(timeZone, naive);
  ts = naive - zoneOffsetMs(timeZone, ts);
  return ts;
}

function zoneToday(timeZone, nowMs) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(nowMs))
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
}

// "You've hit your session limit · resets 6:30pm (America/Caracas)" is the real
// format observed live. Also handles a bare time with no zone, 24h times,
// "reset at", and the older "…|<epoch>" form.
//
// Returns { resetsAt (epoch SECONDS, matching usage-limits.mjs's unit contract),
// guessed, note }. Never throws and never returns null: an unparseable message
// still has to move the rotation forward, so it degrades to now + 1h with
// guessed:true so the caller can say out loud that it guessed.
export function parseResetTime(text, { now = Date.now(), timeZone } = {}) {
  const s = String(text || '');
  const localZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const fallback = () => ({
    resetsAt: Math.floor(now / 1000) + 3600,
    guessed: true,
    note: 'reset time not parseable, guessed one hour out',
  });

  // "…limit reached|1787979122": an absolute epoch needs no zone reasoning.
  const epoch = s.match(/limit reached\s*\|\s*(\d{9,13})/i);
  if (epoch) {
    const raw = Number(epoch[1]);
    const secs = raw > 1e11 ? Math.floor(raw / 1000) : raw; // ms or s, both appear
    if (Number.isFinite(secs) && secs > 0) return { resetsAt: secs, guessed: false, note: 'absolute epoch' };
  }

  // "resets 6:30pm (America/Caracas)" / "resets 1pm" / "reset at 18:30"
  const m = s.match(/reset(?:s|\s+at)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return fallback();
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3] ? m[3].toLowerCase() : null;
  if (mer) {
    if (hour < 1 || hour > 12) return fallback();
    if (mer === 'pm' && hour !== 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return fallback();
  }
  if (minute > 59) return fallback();

  // An explicit zone is only trusted if Intl accepts it, because a typo must not throw
  // inside a worker-death handler.
  let zone = localZone;
  let note = 'no zone in message, read as local time';
  const tz = s.match(/\(([A-Za-z]+\/[A-Za-z_+\-0-9]+)\)/);
  if (tz) {
    try {
      zoneOffsetMs(tz[1], now);
      zone = tz[1];
      note = `zone ${tz[1]} from message`;
    } catch {
      note = `zone "${tz[1]}" not recognised, read as local time`;
    }
  }

  const { y, mo, d } = zoneToday(zone, now);
  let ts = zonedWallClockToEpochMs(zone, y, mo, d, hour, minute);
  // "resets 6:30pm" always means the NEXT 6:30pm. Past means tomorrow.
  if (ts <= now) ts = zonedWallClockToEpochMs(zone, y, mo, d + 1, hour, minute);
  return { resetsAt: Math.floor(ts / 1000), guessed: false, note };
}

export function isLimited(acct, now = Date.now()) {
  const until = Number(acct?.limitedUntil);
  return Number.isFinite(until) && until > 0 && until * 1000 > now;
}

// Pick the next account to run on: available, not the one that just died, and
// least-recently-active so several accounts rotate rather than ping-pong
// between two. A never-used slot (lastActiveAt null) sorts first, because it
// has the freshest window by definition. Ties break on file order, so the
// choice is deterministic and a test can assert it.
export function nextAvailable(accounts, { activeName = null, now = Date.now() } = {}) {
  const usable = (accounts || [])
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a && a.claudeAiOauth && a.name !== activeName && !isLimited(a, now));
  if (!usable.length) return null;
  usable.sort((x, y) => {
    const lx = x.a.lastActiveAt ? Date.parse(x.a.lastActiveAt) : 0;
    const ly = y.a.lastActiveAt ? Date.parse(y.a.lastActiveAt) : 0;
    return lx - ly || x.i - y.i;
  });
  return usable[0].a;
}

// Earliest moment any account frees up, for the "everything is limited" message.
export function earliestReset(accounts, now = Date.now()) {
  const times = (accounts || [])
    .filter((a) => isLimited(a, now))
    .map((a) => Number(a.limitedUntil))
    .filter((n) => Number.isFinite(n));
  return times.length ? Math.min(...times) : null;
}

// Identify which slot the live credential blob belongs to. Exact refreshToken
// first (it outlives access-token refreshes), then exact accessToken, then a
// long prefix of the refresh token: enough that a rotated-but-related token
// still resolves, far too little to reconstruct one.
export function matchAccount(accounts, liveOauth) {
  if (!liveOauth) return null;
  const list = accounts || [];
  const byExact = (key) => list.find((a) => a.claudeAiOauth?.[key] && a.claudeAiOauth[key] === liveOauth[key]);
  const r = byExact('refreshToken');
  if (r) return { account: r, matchedBy: 'refreshToken' };
  const acc = byExact('accessToken');
  if (acc) return { account: acc, matchedBy: 'accessToken' };
  const pre = typeof liveOauth.refreshToken === 'string' ? liveOauth.refreshToken.slice(0, 24) : null;
  if (pre) {
    const p = list.find((a) => a.claudeAiOauth?.refreshToken?.startsWith(pre));
    if (p) return { account: p, matchedBy: 'refreshTokenPrefix' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE STORE: everything that touches the credential store or disk
//
// A factory: the file path, the credential store and the `identify` dependency
// are all injected, so tests never point at a live credential store and cannot
// clobber a real accounts.json. `credentials` defaults to the platform's real
// backend (credential-store.mjs) — macOS keychain on darwin, the plaintext
// credentials file everywhere else.
// ---------------------------------------------------------------------------
export function createAccountStore({
  file,
  // A credential-store.mjs store: { read, write, preflight?, describe, kind }.
  credentials = null,
  // Whose account is a live token? async (accessToken) => email-or-null.
  // bridge.mjs wires this to the profile endpoint; the default null means
  // "cannot verify", which the banking ladder treats as: park, never bank.
  identify = null,
  // Siblings of accounts.json by default; injectable so tests never share one.
  backupFile = null,
  unclaimedFile = null,
  log = (msg) => console.log(`[accounts] ${msg}`),
} = {}) {
  if (!file) throw new Error('createAccountStore: `file` is required');
  credentials = credentials || createCredentialStore();
  backupFile = backupFile || join(dirname(file), 'accounts.backup.json');
  unclaimedFile = unclaimedFile || join(dirname(file), 'accounts.unclaimed.json');

  // What swapTo() last wrote, so checkDrift() has something to compare against.
  // In memory only, so a daemon restart just means the first check re-learns it.
  let intended = null; // { name, fp }

  function read() {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }

  // 0600 before the rename, never after: a world-readable window, however
  // short, is a window in which one of these files is a token dump. Every file
  // this store writes (accounts.json, the parked blob, the one-time backup)
  // goes through here — a second hand-rolled writer is how a half-written
  // credentials file happens.
  function writeFileAtomic0600(target, text) {
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
      chmodSync(target, 0o600);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
  }

  function write(list) {
    writeFileAtomic0600(file, JSON.stringify(list, null, 2) + '\n');
  }

  // ---------------------------------------------------------------------------
  // PARKING. One parked blob at most, latest wins: it exists to preserve a
  // possibly-precious rotated token without overwriting any named slot, not to
  // be an archive.
  // ---------------------------------------------------------------------------
  function readUnclaimed() {
    try {
      const j = JSON.parse(readFileSync(unclaimedFile, 'utf8'));
      return j && typeof j === 'object' && j.claudeAiOauth ? j : null;
    } catch {
      return null;
    }
  }

  function parkUnclaimed(oauth, { email = null, note = '' } = {}) {
    const rec = { claudeAiOauth: oauth, email: email || null, seenAt: new Date().toISOString(), note };
    writeFileAtomic0600(unclaimedFile, JSON.stringify(rec, null, 2) + '\n');
    log(
      `parked unclaimed credentials (${fingerprint(oauth)}${email ? `, ${email}` : ''}) — /account capture <name> to claim`,
    );
    return rec;
  }

  function clearUnclaimed() {
    try {
      unlinkSync(unclaimedFile);
    } catch {
      /* nothing parked */
    }
  }

  // Token-free view of the parked blob, for /account. Same rule as describe():
  // nothing leaves here but a fingerprint.
  function describeUnclaimed() {
    const u = readUnclaimed();
    if (!u) return null;
    return { fingerprint: fingerprint(u.claudeAiOauth), email: u.email || null, seenAt: u.seenAt || null, note: u.note || '' };
  }

  // ---------------------------------------------------------------------------
  // THE BANKING LADDER, rungs 2 and 3 (rung 1 — fingerprint match — is checked
  // by the callers, because they need the match result for their own logic).
  // Called only for a live blob that fingerprint-matches NO slot.
  // ---------------------------------------------------------------------------
  async function identifyEmail(oauth) {
    if (typeof identify !== 'function') return null;
    try {
      const email = await identify(oauth.accessToken);
      return typeof email === 'string' && email.includes('@') ? email : null;
    } catch {
      return null; // an identify failure means "cannot verify", never "trust me"
    }
  }

  function slotByIdentity(list, email) {
    const e = String(email).toLowerCase();
    return list.find((a) => (a.email || '').toLowerCase() === e || (a.name || '').toLowerCase() === e) || null;
  }

  // Returns { action: 'banked', name, email } or { action: 'parked', email }.
  // `believedName` is only for the log line that says what the old behaviour
  // would have done; `markActive` stamps lastActiveAt when the banked blob is
  // the one actually LIVE (a login), not one being swapped away from.
  async function bankUnmatched(live, { believedName = null, markActive = false, site }) {
    const email = await identifyEmail(live.claudeAiOauth);
    if (email) {
      const list = read();
      const slot = slotByIdentity(list, email);
      if (slot) {
        const i = list.findIndex((a) => a.name === slot.name);
        list[i] = {
          ...list[i],
          claudeAiOauth: live.claudeAiOauth,
          capturedAt: new Date().toISOString(),
          ...(markActive ? { lastActiveAt: new Date().toISOString() } : {}),
        };
        write(list);
        log(
          believedName && slot.name !== believedName
            ? `${site}: live blob identified as "${slot.name}" (${fingerprint(live.claudeAiOauth)}) and banked THERE — the old behaviour would have mislabeled it into "${believedName}"`
            : `${site}: live blob identified as "${slot.name}" (${fingerprint(live.claudeAiOauth)}), banked into its own slot`,
        );
        return { action: 'banked', name: slot.name, email };
      }
      parkUnclaimed(live.claudeAiOauth, { email, note: `${site}: identified as ${email}, which matches no slot` });
      return { action: 'parked', email };
    }
    parkUnclaimed(live.claudeAiOauth, { note: `${site}: identity could not be verified` });
    return { action: 'parked', email: null };
  }

  // The live credential blob, or null. A corrupt or unreadable store reads as
  // absent (never echoed); a throwing injected store is a bug worth surfacing,
  // so this does not blanket-catch.
  async function readCredentials() {
    return credentials.read();
  }

  // Returns true only if the blob is now live in the credential store. On ANY
  // failure the previous credentials are put back: a half-written credential
  // store is worse than a refused swap, because Claude Code then has no login
  // at all.
  async function writeCredentials(blob, { previous = undefined } = {}) {
    // A refusal (the payload is larger than any of the backend's write paths
    // can carry; see credential-store.mjs for the measured limits) must land
    // BEFORE any side effect, the one-time backup below included. Nothing is
    // corrupted by a write that never runs, so this path needs no rollback.
    if (typeof credentials.preflight === 'function') {
      try {
        await credentials.preflight(blob);
      } catch (e) {
        log(`refusing to write credentials: ${e.message}`);
        return false;
      }
    }

    // Snapshot for rollback. Read it here rather than trusting a caller.
    const before = previous === undefined ? await readCredentials() : previous;

    // THE ONE-TIME BACKUP (see the header). Written before the first credential
    // write ever performed here, never overwritten after — it is the pre-tool
    // known-good state, not a rolling snapshot. Only a blob that actually
    // carries credentials is worth the once-only slot; a cleared blob is not a
    // state anyone wants to recover to, so the chance stays open for the next
    // healthy write. If the backup cannot be written, the credential write is
    // REFUSED: proceeding uncovered is exactly the hole this file closes.
    if (!existsSync(backupFile) && before?.claudeAiOauth?.accessToken) {
      try {
        writeFileAtomic0600(
          backupFile,
          JSON.stringify(
            {
              savedAt: new Date().toISOString(),
              note: 'pre-first-write credential backup; `blob` is the exact credential-store payload',
              blob: before,
            },
            null,
            2,
          ) + '\n',
        );
        log(`one-time credential backup written to ${backupFile} (${fingerprint(before.claudeAiOauth)})`);
      } catch (e) {
        log(`refusing to write credentials: the one-time credential backup could not be created (${e.message})`);
        return false;
      }
    }

    let landed = false;
    try {
      await credentials.write(blob);
      landed = true;
    } catch (e) {
      if (e?.refused) {
        // The store refused at the last line of defence (a caller skipped the
        // preflight, or the store has no preflight). Nothing was attempted.
        log(`refusing to write credentials: ${e.message}`);
        return false;
      }
      // Attempted and failed; fall through to the rollback below.
    }
    // A clean write call is not proof. Read back and compare fingerprints. Same
    // lesson as ever: a clean-looking write is not a good one.
    const back = landed ? await readCredentials() : null;
    if (back && fingerprint(back.claudeAiOauth) === fingerprint(blob.claudeAiOauth)) return true;

    // The write failed or landed corrupted. Put the old blob back.
    if (before?.claudeAiOauth?.accessToken) {
      try {
        await credentials.write(before);
        const check = await readCredentials();
        if (check && fingerprint(check.claudeAiOauth) === fingerprint(before.claudeAiOauth)) {
          log('write failed; rolled the previous credentials back into place');
          return false;
        }
      } catch {
        /* the rollback write itself failed; report below */
      }
      // Rollback itself failed. This is the one state the owner must hear about
      // in full, because the fix is a manual /login.
      log('WRITE FAILED AND ROLLBACK FAILED — the credential store may hold no usable login; run claude /login');
    }
    return false;
  }

  // Snapshot the LIVE credentials into a named slot. This is both the one-time
  // setup step (/account capture <name>) and the first half of every swap.
  async function captureCurrent(name, { email = null } = {}) {
    if (!name) return { ok: false, error: 'a slot name is required' };
    const live = await readCredentials();
    if (!live?.claudeAiOauth?.accessToken) {
      return { ok: false, error: 'no readable claudeAiOauth in the credential store' };
    }
    const list = read();
    const at = new Date().toISOString();
    const i = list.findIndex((a) => a.name === name);
    const prev = i === -1 ? null : list[i];
    const rec = {
      name,
      email: email ?? prev?.email ?? null,
      claudeAiOauth: live.claudeAiOauth,
      limitedUntil: prev?.limitedUntil ?? null,
      lastActiveAt: prev?.lastActiveAt ?? null,
      capturedAt: at,
    };
    if (i === -1) list.push(rec);
    else list[i] = rec;
    write(list);
    log(`captured live credentials into slot "${name}" (${fingerprint(rec.claudeAiOauth)})`);
    // A capture into a slot matching the parked blob's identity CLAIMS it: the
    // slot now holds that account's current tokens, so the parked rotation is
    // superseded and the /account warning line can go.
    const parked = readUnclaimed();
    if (parked) {
      const e = (parked.email || '').toLowerCase();
      const claimedByEmail = !!e && (e === (rec.email || '').toLowerCase() || e === String(name).toLowerCase());
      const claimedByTokens = !!matchAccount([rec], parked.claudeAiOauth);
      if (claimedByEmail || claimedByTokens) {
        clearUnclaimed();
        log(`unclaimed credentials (${fingerprint(parked.claudeAiOauth)}) claimed by the capture into "${name}"`);
      }
    }
    return { ok: true, account: rec, replaced: !!prev };
  }

  // Which slot is live right now, and how confidently we know it.
  async function activeAccount() {
    const live = await readCredentials();
    if (!live?.claudeAiOauth) return { account: null, matchedBy: null, liveFingerprint: 'none' };
    const list = read();
    const hit = matchAccount(list, live.claudeAiOauth);
    if (hit) return { ...hit, liveFingerprint: fingerprint(live.claudeAiOauth) };
    // No token match. Fall back to the most recently activated slot so the UI
    // and the rotation still have a name to work with, clearly labelled as a
    // guess rather than an identification.
    const recent = list
      .filter((a) => a.lastActiveAt)
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))[0];
    return {
      account: recent || null,
      matchedBy: recent ? 'lastActiveAt' : null,
      liveFingerprint: fingerprint(live.claudeAiOauth),
    };
  }

  // Capture the outgoing account, then write the incoming one, preserving
  // mcpOAuth. See the header for why this ordering and what it does not fix.
  async function swapTo(name) {
    const list = read();
    const target = list.find((a) => a.name === name);
    if (!target) return { ok: false, error: `no account slot named "${name}". Run /account capture ${name} first` };
    if (!target.claudeAiOauth?.accessToken) return { ok: false, error: `slot "${name}" has no captured credentials` };

    const live = await readCredentials();
    if (!live) return { ok: false, error: 'could not read the credential store, so nothing was changed' };

    // 1. Bank whatever the outgoing account refreshed to while it was active —
    //    through the banking ladder. hasCredentials gates everything first:
    //    never bank a blob with no access token.
    const from = matchAccount(list, live.claudeAiOauth);
    if (from && from.account.name !== name && hasCredentials(live)) {
      // Rung 1: a fingerprint match IS that slot's own rotation.
      const i = list.findIndex((a) => a.name === from.account.name);
      list[i] = { ...list[i], claudeAiOauth: live.claudeAiOauth, capturedAt: new Date().toISOString() };
      write(list);
      log(`banked outgoing "${from.account.name}" refresh before swapping (${fingerprint(live.claudeAiOauth)})`);
    } else if (!from && hasCredentials(live)) {
      // Rungs 2-3: unknown fingerprint means unknown owner. Identify it or park
      // it; either way it is preserved and NEVER banked into a slot on faith.
      // The swap itself proceeds regardless — preserving the outgoing blob and
      // installing the requested account are separate obligations.
      await bankUnmatched(live, { site: 'swap' });
    } else if (!from) {
      log(`live credentials carry no token (${fingerprint(live.claudeAiOauth)}), swapping without banking`);
    }

    // 2. Swap in, mcpOAuth untouched. The target is RE-READ after step 1: if
    //    the outgoing blob was identified as the target account itself (the
    //    owner logged into it by hand), its slot now holds those fresher
    //    tokens, and installing the stale pre-bank copy would swap in a token
    //    the login may have rotated to death.
    const freshTarget = read().find((a) => a.name === name) || target;
    const merged = mergeBlob(live, freshTarget.claudeAiOauth);
    if (!(await writeCredentials(merged))) {
      // Do not claim "unchanged" on faith. writeCredentials rolls back on
      // failure, so re-read and say which of the two actually happened. The old
      // wording asserted the store was untouched while it in fact held a
      // truncated blob with no claudeAiOauth, which sent the owner looking in
      // the wrong place.
      const after = await readCredentials();
      const intact = fingerprint(after?.claudeAiOauth) === fingerprint(live.claudeAiOauth);
      return {
        ok: false,
        error: intact
          ? 'credential write failed; the previous account is still active and nothing changed'
          : 'credential write failed AND the rollback did not take. Run: claude /login',
      };
    }

    // 3. Record the new active account and what we expect to see on disk.
    const fresh = read();
    const j = fresh.findIndex((a) => a.name === name);
    fresh[j] = { ...fresh[j], lastActiveAt: new Date().toISOString() };
    write(fresh);
    intended = { name, fp: fingerprint(freshTarget.claudeAiOauth) };
    log(`swapped to "${name}" (${intended.fp}); mcpOAuth preserved`);
    return { ok: true, from: from?.account?.name || null, to: name, fingerprint: intended.fp };
  }

  // Write a refreshed claudeAiOauth into an existing slot, through the SAME
  // atomic writer everything else uses. account-usage.mjs needs this: a refresh
  // rotates the refresh token, so the new blob must land on disk before it is
  // used for anything, and a second hand-rolled writer is exactly how a
  // half-written credentials file happens. Deliberately refuses to create a
  // slot — banking a token into a name nobody enrolled would hide a typo.
  //
  // Returns { ok:false } for a bad slot or a bad blob; lets write() THROW on an
  // I/O failure, because a refreshed-but-unsaved token is the one outcome the
  // caller must not be able to mistake for success.
  function bankOauth(name, oauth) {
    if (!oauth || typeof oauth !== 'object' || !oauth.accessToken) {
      return { ok: false, error: 'bankOauth: a claudeAiOauth blob with an accessToken is required' };
    }
    const list = read();
    const i = list.findIndex((a) => a.name === name);
    if (i === -1) return { ok: false, error: `no account slot named "${name}"` };
    list[i] = { ...list[i], claudeAiOauth: oauth, capturedAt: new Date().toISOString() };
    write(list);
    log(`banked a refreshed token into slot "${name}" (${fingerprint(oauth)})`);
    return { ok: true, account: list[i] };
  }

  function markLimited(name, resetsAt) {
    const list = read();
    const i = list.findIndex((a) => a.name === name);
    if (i === -1) return { ok: false, error: `no account slot named "${name}"` };
    list[i] = { ...list[i], limitedUntil: Number(resetsAt) || null };
    write(list);
    log(`marked "${name}" limited until ${new Date(Number(resetsAt) * 1000).toISOString()}`);
    return { ok: true, account: list[i] };
  }

  function clearLimit(name) {
    const list = read();
    const i = list.findIndex((a) => a.name === name);
    if (i === -1) return { ok: false, error: `no account slot named "${name}"` };
    list[i] = { ...list[i], limitedUntil: null };
    write(list);
    return { ok: true, account: list[i] };
  }

  // The residual-race guard. Cheap enough to run on a slow cadence, and it
  // deliberately re-asserts ONLY when the live blob is identifiably a DIFFERENT
  // known slot. See the header for why anything else is logged, not overridden.
  async function checkDrift() {
    if (!intended) return { checked: false };
    const live = await readCredentials();
    if (!hasCredentials(live)) return { checked: true, drifted: false, note: 'credential store unreadable or cleared' };
    const liveFp = fingerprint(live.claudeAiOauth);
    if (liveFp === intended.fp) return { checked: true, drifted: false };

    const list = read();
    const hit = matchAccount(list, live.claudeAiOauth);
    if (hit && hit.account.name !== intended.name) {
      // A worker on the outgoing account refreshed and wrote back over us.
      const i = list.findIndex((a) => a.name === hit.account.name);
      list[i] = { ...list[i], claudeAiOauth: live.claudeAiOauth, capturedAt: new Date().toISOString() };
      write(list);
      log(`DRIFT: live credentials reverted to "${hit.account.name}" (${liveFp}); banked it and re-asserting "${intended.name}"`);
      const res = await swapTo(intended.name);
      return { checked: true, drifted: true, action: 'reasserted', from: hit.account.name, to: intended.name, ok: res.ok };
    }

    if (hit) {
      // Fingerprint-matched the intended slot itself: its own token rotation.
      // Rung 1 of the ladder — the identity is proven, bank and stand down.
      const j = list.findIndex((a) => a.name === intended.name);
      list[j] = { ...list[j], claudeAiOauth: live.claudeAiOauth, capturedAt: new Date().toISOString() };
      write(list);
      intended = { name: intended.name, fp: liveFp };
      log(`DRIFT: live credentials changed to ${liveFp}, fingerprint-matches "${intended.name}" itself, re-banked`);
      return { checked: true, drifted: true, action: 'rebanked', to: intended.name };
    }

    // No fingerprint match at all: the blob's owner is UNKNOWN, and this is
    // exactly where the 2026-08-31 mislabel happened — the old code banked it
    // into whatever slot it believed was active. Rungs 2-3: identify it (bank
    // into the slot whose identity it proves, wherever that is) or park it.
    // The live credentials are never overridden either way: an unmatched blob
    // is most plausibly a fresh /login, and /login must win.
    const res = await bankUnmatched(live, { believedName: intended.name, markActive: true, site: 'DRIFT' });
    if (res.action === 'banked') {
      // Follow the login: the guard now defends the account that is actually
      // live, instead of re-asserting a stale belief on the next tick.
      intended = { name: res.name, fp: liveFp };
      return { checked: true, drifted: true, action: 'rebanked', to: res.name, identifiedAs: res.email };
    }
    // Parked. Adopt the fingerprint so the same blob is not re-parked every
    // tick, but keep the believed name: there is nothing better to believe.
    intended = { name: intended.name, fp: liveFp };
    log(`DRIFT: live credentials changed to ${liveFp}, matches no slot and could not be claimed — parked, not banked`);
    return { checked: true, drifted: true, action: 'parked', identifiedAs: res.email };
  }

  // Display rows for /account. Tokens never leave this function as anything but
  // a fingerprint. There is no code path here that can print one.
  function describe(now = Date.now()) {
    return read().map((a) => ({
      name: a.name,
      email: a.email || null,
      fingerprint: fingerprint(a.claudeAiOauth),
      captured: !!a.claudeAiOauth?.accessToken,
      capturedAt: a.capturedAt || null,
      lastActiveAt: a.lastActiveAt || null,
      limitedUntil: a.limitedUntil || null,
      limited: isLimited(a, now),
    }));
  }

  return {
    file,
    backupFile,
    unclaimedFile,
    credentialStore: () => credentials.describe(),
    hasBackup: () => existsSync(backupFile),
    listAccounts: read,
    describe,
    describeUnclaimed,
    readUnclaimed,
    clearUnclaimed,
    readCredentials,
    writeCredentials,
    captureCurrent,
    bankOauth,
    activeAccount,
    swapTo,
    markLimited,
    clearLimit,
    checkDrift,
    nextAvailable: (opts) => nextAvailable(read(), opts),
    earliestReset: (now) => earliestReset(read(), now),
    setIntended: (name, fp) => {
      intended = name ? { name, fp } : null;
    },
  };
}
