// ONE-TAP ACCOUNT BUTTONS. The inline keyboard under the /account reply, and
// everything that happens when the owner taps one of its buttons.
//
// SHARED MODULE — byte-identical in the public and private bridge repos, and
// listed in scripts/check-shared.sh. A tap here swaps the credentials every
// future worker runs under, so the guards below are deny-by-default and every
// dependency is injected: nothing in this file touches Telegram, the network
// or a credential store directly.
//
// ---------------------------------------------------------------------------
// WHY BUTTONS AND NOT MENU COMMANDS
//
// A Telegram bot command name is [a-z0-9_]{1,32}: it can carry neither a space
// nor an argument. `/account capture second@example.com` can therefore never be
// a tappable menu entry, and even a hypothetical /swap would still mean
// typing an email address on a phone. An inline keyboard attached to the
// /account reply is the only surface that reaches these sub-commands with zero
// typing.
//
// ---------------------------------------------------------------------------
// WHY THE PAYLOAD CARRIES A DIGEST AND NOT A NAME
//
// callback_data is capped at 64 BYTES and the account names here are email
// addresses, so the name cannot travel in it. The index into store.describe()
// can — but an index alone is a promise about a list that may have changed
// between rendering the keyboard and the tap (a capture adds a slot, a hand edit
// reorders the file). Acting on a stale index would swap to a DIFFERENT account
// than the button named, which is the one outcome that must be impossible.
//
// So the payload is `acct:swap:<index>:<tag>`, where tag is the first 8 hex
// characters of sha256(name). At tap time the index is re-resolved against a
// FRESH read of the store and the tag is recomputed from whatever name now sits
// there; a mismatch refuses the tap instead of swapping. The tag is a digest of
// a string already printed in the message body, so it leaks nothing, and at 19
// bytes the whole payload is a third of the cap.
//
// The button's own label (Telegram echoes the message's reply_markup back with
// the tap) is cross-checked too when it is available. It is a second opinion,
// not the authority: making identity depend on a field we cannot exercise
// without a live Telegram round trip would mean a silent Telegram-side change
// turns every tap into a refusal. Both checks must pass; either one failing
// refuses.
//
// ---------------------------------------------------------------------------
// WHY CAPTURE NEVER ASKS FOR A NAME
//
// Every enrolled slot is named by the account's email — the convention
// this store establishes at capture time. So "capture the current login" has
// exactly one correct slot name and it can be resolved rather than typed:
// resolveActive() identifies the live blob by token fingerprint (free) or by the
// profile endpoint's email (authoritative across token rotation). If neither
// answers, the tap refuses and points at the typed form. Inventing a slot name
// would bank real credentials somewhere nobody can find them again.
//
// ---------------------------------------------------------------------------
// THE SPINNER RULE
//
// Telegram spins a loading indicator on a tapped button until the bot calls
// answerCallbackQuery. Every path through this module — success, refusal,
// unauthorized, thrown exception — answers exactly once, latched, in a finally.
// A missed answer is a button that looks permanently stuck.
//
// ---------------------------------------------------------------------------
// WHY A TAP SENDS A NEW MESSAGE AS WELL AS EDITING THE OLD ONE
//
// A successful swap used to report itself twice, and on a phone both are
// invisible. The answerCallbackQuery toast is gone in five seconds. The refresh
// EDITS the /account message that was tapped, which is right for the button
// rows — the account just moved to has to lose its swap button — but an edit
// to a message that has scrolled off screen is an edit nobody sees. Net effect:
// tap, nothing appears, did it work?
//
// So every terminal outcome ALSO sends a short standalone message through the
// injected `notify`: swapped, swap failed, captured, capture failed. The refresh
// stays exactly as it was; this is in addition to it, never instead of it.
// The strings themselves live in account-usage.mjs beside the other renderers,
// so a unit test asserts what the owner actually reads.

import { createHash } from 'node:crypto';
import { fingerprint } from './accounts.mjs';
import { captureConfirmation, captureFailure, swapConfirmation, swapFailure } from './account-usage.mjs';

// ---------------------------------------------------------------------------
// PURE HELPERS (unit-tested in account-buttons.test.mjs; no network, no disk)
// ---------------------------------------------------------------------------

export const CALLBACK_NS = 'acct';
export const CAPTURE_DATA = `${CALLBACK_NS}:capture`;
export const CAPTURE_LABEL = '📸 Capture current login';
// Telegram's documented hard cap on callback_data, in BYTES not characters.
export const CALLBACK_DATA_MAX = 64;

// A stable, short, non-reversible handle for a slot name. Truncated to 8 hex
// characters: 4 bytes is a 1-in-4-billion collision against the two or three
// names that ever exist here, and the whole point is to stay tiny.
export function accountTag(name) {
  return createHash('sha256').update(String(name ?? ''), 'utf8').digest('hex').slice(0, 8);
}

// THROWS on a payload it cannot make legal, rather than returning something
// Telegram will reject at send time: a keyboard that fails to render is a
// feature that silently does not exist.
export function encodeSwap(index, name) {
  if (!Number.isInteger(index) || index < 0 || index > 999_999) {
    throw new Error(`encodeSwap: index must be an integer in 0..999999, got ${JSON.stringify(index)}`);
  }
  const data = `${CALLBACK_NS}:swap:${index}:${accountTag(name)}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX) {
    throw new Error(`encodeSwap: ${Buffer.byteLength(data, 'utf8')} bytes exceeds the ${CALLBACK_DATA_MAX}-byte cap`);
  }
  return data;
}

// null for anything this module did not produce. Callback data is attacker-
// reachable in principle (it is whatever the client sends back), so every field
// is shape-checked before it becomes a number.
export function decodeAccountCallback(data) {
  if (typeof data !== 'string' || !data) return null;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX) return null;
  const parts = data.split(':');
  if (parts[0] !== CALLBACK_NS) return null;
  if (parts.length === 2 && parts[1] === 'capture') return { verb: 'capture' };
  if (parts.length === 4 && parts[1] === 'swap') {
    // Bounded digits only: rejects '', '-1', '1.5', '1e3', ' 1', 'abc', and
    // keeps Number() away from anything that is not a safe integer.
    if (!/^\d{1,6}$/.test(parts[2])) return null;
    if (!/^[0-9a-f]{8}$/.test(parts[3])) return null;
    return { verb: 'swap', index: Number(parts[2]), tag: parts[3] };
  }
  return null;
}

// The button caption. A slot that cannot be swapped into still gets a row —
// Telegram has no "disabled" button, and hiding it would leave the owner wondering
// where the account went — but it is marked, and tapping it explains itself
// instead of swapping.
export function labelForSwap(row) {
  const name = row?.name ?? '';
  if (row?.limited) return `⛔ ${name} (limited)`;
  if (!row?.captured) return `⚠️ ${name} (no credentials)`;
  return `Swap to ${name}`;
}

const LABEL_PREFIXES = ['Swap to ', '⛔ ', '⚠️ '];
const LABEL_SUFFIXES = [' (limited)', ' (no credentials)'];

// The inverse of labelForSwap, for cross-checking a tap against the caption the
// button actually carried.
export function nameFromLabel(label) {
  let s = String(label ?? '').trim();
  for (const p of LABEL_PREFIXES) {
    if (s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  for (const suf of LABEL_SUFFIXES) {
    if (s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.trim();
}

// Telegram echoes the tapped message back with its reply_markup, so the caption
// the button was rendered with is recoverable. Returns null when it is not —
// an old message, a schema change — and the caller falls back to the digest.
export function labelForCallbackData(replyMarkup, data) {
  const keyboard = replyMarkup?.inline_keyboard;
  if (!Array.isArray(keyboard) || typeof data !== 'string') return null;
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (btn && btn.callback_data === data) return typeof btn.text === 'string' ? btn.text : null;
    }
  }
  return null;
}

// One row per account that is not the live one (there is nothing to swap to),
// plus the capture row. The index encoded is the index into the FULL describe()
// list, not into the filtered keyboard, so it survives the filtering.
export function buildAccountKeyboard(rows, { activeName = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const inline_keyboard = [];
  list.forEach((row, index) => {
    if (!row || !row.name) return;
    if (activeName && row.name === activeName) return;
    inline_keyboard.push([{ text: labelForSwap(row), callback_data: encodeSwap(index, row.name) }]);
  });
  inline_keyboard.push([{ text: CAPTURE_LABEL, callback_data: CAPTURE_DATA }]);
  return { inline_keyboard };
}

// Re-resolve a decoded tap against a fresh store read. Never returns a row whose
// identity does not match what the button promised.
export function resolveSwapTarget(rows, decoded, expectedName = null) {
  const list = Array.isArray(rows) ? rows : [];
  const moved = {
    ok: false,
    reason: 'moved',
    error: 'That account list moved — run /account again.',
  };
  if (!decoded || decoded.verb !== 'swap') {
    return { ok: false, reason: 'unknown', error: 'Unrecognised button — run /account again.' };
  }
  const { index, tag } = decoded;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return moved;
  const row = list[index];
  if (!row || !row.name) return moved;
  if (accountTag(row.name) !== tag) return moved; // a different account sits at that index now
  if (expectedName && expectedName !== row.name) return moved; // the button's own caption disagrees
  if (!row.captured) {
    return {
      ok: false,
      reason: 'no-credentials',
      error: `"${row.name}" has no captured credentials. Log into it, then /account capture ${row.name}.`,
    };
  }
  if (row.limited) {
    return {
      ok: false,
      reason: 'limited',
      error: `"${row.name}" is still rate limited. Type /account ${row.name} if you want to force it.`,
    };
  }
  return { ok: true, row };
}

// THE AUTHORIZATION GATE. A tap swaps the credentials every subsequent worker
// runs under, so this is credential-affecting and deny-by-default: an absent
// from.id, a foreign from.id, or an unconfigured owner id all refuse. Pure and
// exported so a test can prove a foreign tap never reaches the swap path.
export function authorizeCallback(cq, chatId) {
  const owner = String(chatId ?? '');
  const fromId = cq?.from?.id;
  if (!owner || fromId === undefined || fromId === null) return { ok: false, from: fromId == null ? null : String(fromId) };
  if (String(fromId) !== owner) return { ok: false, from: String(fromId) };
  return { ok: true, from: owner };
}

// The whole decision layer, with no I/O: what should this tap DO? Returning a
// plan rather than performing one is what makes "a foreign tap cannot swap"
// assertable in a unit test instead of merely argued.
export function routeCallback(cq, { chatId, rows = [] } = {}) {
  const callbackId = typeof cq?.id === 'string' && cq.id ? cq.id : null;
  const messageId = Number.isInteger(cq?.message?.message_id) ? cq.message.message_id : null;

  const auth = authorizeCallback(cq, chatId);
  if (!auth.ok) {
    return { action: 'unauthorized', callbackId, messageId, from: auth.from, answer: 'This bot only answers its owner.' };
  }

  const decoded = decodeAccountCallback(cq?.data);
  if (!decoded) {
    return { action: 'unknown', callbackId, messageId, answer: 'Unrecognised button — run /account again.' };
  }
  if (decoded.verb === 'capture') return { action: 'capture', callbackId, messageId };

  const label = labelForCallbackData(cq?.message?.reply_markup, cq.data);
  const expectedName = label ? nameFromLabel(label) : null;
  const res = resolveSwapTarget(rows, decoded, expectedName);
  if (!res.ok) return { action: 'refuse', reason: res.reason, callbackId, messageId, answer: res.error };
  return { action: 'swap', name: res.row.name, index: decoded.index, callbackId, messageId };
}

// ---------------------------------------------------------------------------
// THE EXECUTOR
//
// A factory in the shape of createAccountStore/createAccountUsage: the store,
// the usage reader, the Telegram answer call and the view refresh are all
// injected, so the tests exercise the SHIPPED code path with fakes rather than a
// re-implementation of it that can drift away from bridge.mjs.
// ---------------------------------------------------------------------------
export function createAccountCallbacks({
  chatId,
  store,
  usage = null,
  answer,
  refreshView = null,
  notify = null,
  onSwapped = null,
  onCaptured = null,
  log = (msg) => console.log(`[account-buttons] ${msg}`),
} = {}) {
  if (!store) throw new Error('createAccountCallbacks: an account `store` is required');
  if (typeof answer !== 'function') throw new Error('createAccountCallbacks: an `answer` function is required');

  return async function handleAccountCallback(cq) {
    let rows = [];
    try {
      rows = store.describe();
    } catch (e) {
      log(`could not read the account list: ${e.message}`);
    }
    const route = routeCallback(cq, { chatId, rows });

    // Answer once, whatever happens. The latch matters as much as the call: two
    // answers for one query is an API error, none is a stuck spinner.
    let answered = false;
    const reply = async (text, alert = false) => {
      if (answered) return;
      answered = true;
      try {
        await answer(route.callbackId, text, { alert });
      } catch (e) {
        log(`answerCallbackQuery failed: ${e.message}`);
      }
    };

    const refresh = async (status) => {
      if (typeof refreshView !== 'function') return;
      try {
        await refreshView({ messageId: route.messageId, status });
      } catch (e) {
        log(`refreshing the /account view failed: ${e.message}`);
      }
    };

    // The standalone message. Non-throwing on purpose: a swap that landed must
    // not be reported as failed because a notification could not be delivered.
    const say = async (text) => {
      if (typeof notify !== 'function') return;
      try {
        await notify(text);
      } catch (e) {
        log(`the swap confirmation could not be sent: ${e.message}`);
      }
    };

    // The usage already in the reader's TTL cache for a slot, or null. Never
    // goes to the network: the confirmation carries a headroom line when one is
    // free and omits it when it is not, rather than making the reader wait for it.
    // Read BEFORE the onSwapped hook, which invalidates the whole cache.
    const cachedUsage = (name) => {
      try {
        return usage?.peek?.(name) ?? null;
      } catch {
        return null;
      }
    };

    async function doSwap() {
      const res = await store.swapTo(route.name);
      if (!res?.ok) {
        const error = res?.error || 'the swap returned no result';
        // Optional-chained: fake stores in tests predate hasBackup. When the
        // rollback failed AND the one-time backup exists, the failure message
        // names it as the recovery path.
        const backupPath = store.hasBackup?.() ? store.backupFile : null;
        const text = swapFailure({ to: route.name, error, backupPath });
        await reply(`Swap failed: ${error}`, true);
        // A failed swap gets its own message too, and for a sharper reason than
        // a successful one: swapFailure() keeps accounts.mjs's distinction
        // between "nothing moved" (routine) and "the rollback did not take, run
        // claude /login" (nothing will run until that is done). Burying the second
        // one in a five-second toast is how that goes unnoticed for hours.
        await say(text);
        await refresh(text);
        return { ok: false, error };
      }
      // Read the cached headroom for the account we just moved to BEFORE the
      // onSwapped hook clears the cache. The numbers are per-account and do not
      // change with which one is live, so a row fetched moments ago (the render
      // of the very view that was tapped) is still true of it.
      const brief = cachedUsage(route.name);
      // A tap changes which account is live exactly as much as a typed
      // /account <name> does, so it takes the same side effects: the cached
      // "which account is active" answer and every cached usage row are stale
      // the moment it lands, and choosing an account by hand overrides the
      // everything-is-limited stand-down.
      try {
        onSwapped?.(res);
      } catch (e) {
        log(`onSwapped hook failed: ${e.message}`);
      }
      const confirmation = swapConfirmation({ to: route.name, from: res.from ?? null, usage: brief });
      await reply(`Swapped to ${route.name}${res.from ? ` (was ${res.from})` : ''}`);
      await say(confirmation);
      // The refresh stays: it is what re-renders the button rows so the account
      // just moved to loses its swap button. It carries the same
      // confirmation plus the caveat, which is worth a line on a view that is
      // already long and not worth one on a three-line notification.
      await refresh(`${confirmation}\nWorkers already running keep their old session; only new ones pick this up.`);
      return { ok: true, swapped: route.name, from: res.from ?? null };
    }

    async function doCapture() {
      let live = null;
      try {
        live = usage ? await usage.resolveActive() : null;
      } catch (e) {
        log(`could not resolve the live account: ${e.message}`);
      }
      // Prefer the slot the live blob was IDENTIFIED as: banking into it is
      // "replace what is there", which is right. The profile email is the
      // fallback for a login that matches no slot yet — that is the "create it"
      // case. Both are the account's own email; neither is invented.
      const slot = live?.name || live?.email || null;
      if (!slot) {
        const error = 'Could not identify the current login. Use /account capture <name>.';
        await reply(error, true);
        await say(captureFailure(error));
        await refresh(captureFailure(error));
        return { ok: false, error };
      }
      const email = live?.email || null;
      const existing = rows.find((r) => r.name === slot);
      if (existing?.email && email && existing.email.toLowerCase() !== email.toLowerCase()) {
        // Belt and braces: never bank one login's credentials into a slot that
        // records a different identity.
        const error = `Slot "${slot}" belongs to ${existing.email}, not ${email}. Use /account capture <name>.`;
        await reply(error, true);
        await say(captureFailure(error));
        await refresh(captureFailure(error));
        return { ok: false, error };
      }

      const res = await store.captureCurrent(slot, email ? { email } : {});
      if (!res?.ok) {
        const error = res?.error || 'the capture returned no result';
        await reply(`Capture failed: ${error}`, true);
        await say(captureFailure(error));
        await refresh(captureFailure(error));
        return { ok: false, error };
      }
      try {
        onCaptured?.(res);
      } catch (e) {
        log(`onCaptured hook failed: ${e.message}`);
      }
      const confirmation = captureConfirmation({
        slot,
        fingerprint: fingerprint(res.account?.claudeAiOauth),
        replaced: !!res.replaced,
      });
      await reply(`Captured the current login into "${slot}"`);
      await say(confirmation);
      await refresh(confirmation);
      return { ok: true, captured: slot, replaced: !!res.replaced };
    }

    try {
      switch (route.action) {
        case 'unauthorized':
          log(`ignoring a button tap from unauthorized user ${route.from}`);
          await reply(route.answer, true);
          return route;
        case 'unknown':
        case 'refuse':
          await reply(route.answer, true);
          return route;
        case 'swap':
          return { ...route, ...(await doSwap()) };
        case 'capture':
          return { ...route, ...(await doCapture()) };
        default:
          await reply('Nothing to do.', true);
          return route;
      }
    } catch (e) {
      log(`callback handling failed: ${e.message}`);
      await reply(`That did not go through: ${e.message}`, true);
      return { ...route, ok: false, error: e.message };
    } finally {
      // Last line of defence against a permanently spinning button.
      await reply('Done.');
    }
  };
}
