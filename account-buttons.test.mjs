#!/usr/bin/env node
// Tests for account-buttons.mjs — the inline keyboard under /account and what a
// tap on it does.
//
// PRIVATE TEST, like the module it covers: not in scripts/check-shared.sh.
//
// Nothing here touches the network, the real keychain, the real accounts.json or
// Telegram. The store, the usage reader, the answerCallbackQuery call and the
// view refresh are all injected fakes — which means the code under test is the
// code bridge.mjs ships, not a re-implementation of it.
//
// The load-bearing assertions, in order of how expensive the bug would be:
//   1. a tap from a foreign from.id NEVER reaches store.swapTo
//   2. a tap never swaps to a different account than the button named
//   3. every path answers the callback exactly once (no stuck spinner)
//   4. no encoded payload can exceed Telegram's 64-byte cap
//   5. no rendered string ever contains a token
//
//   node account-buttons.test.mjs

import {
  CALLBACK_NS,
  CAPTURE_DATA,
  CAPTURE_LABEL,
  CALLBACK_DATA_MAX,
  accountTag,
  encodeSwap,
  decodeAccountCallback,
  labelForSwap,
  nameFromLabel,
  labelForCallbackData,
  buildAccountKeyboard,
  resolveSwapTarget,
  authorizeCallback,
  routeCallback,
  createAccountCallbacks,
} from './account-buttons.mjs';

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
const throws = (fn, re, msg) => {
  try {
    fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg || ''} wrong error: ${e.message}`);
    return;
  }
  throw new Error(msg || 'expected a throw, got none');
};

// The real three-account shape, as store.describe() returns it.
const ROWS = [
  { name: 'second@example.com', email: 'second@example.com', fingerprint: 'a…AAAAAA/r…BBBBBB', captured: true, limited: false, limitedUntil: null, lastActiveAt: null },
  { name: 'first@example.com', email: null, fingerprint: 'a…CCCCCC/r…DDDDDD', captured: true, limited: false, limitedUntil: null, lastActiveAt: null },
  { name: 'third@example.com', email: null, fingerprint: 'a…EEEEEE/r…FFFFFF', captured: true, limited: false, limitedUntil: null, lastActiveAt: null },
];
const OWNER = '123456789';

// ---------- encode ----------

await t('encodeSwap produces the documented shape', () => {
  eq(encodeSwap(0, 'second@example.com'), `${CALLBACK_NS}:swap:0:${accountTag('second@example.com')}`);
});

await t('encodeSwap never exceeds the 64-byte cap, even for absurd names', () => {
  const names = [
    'a',
    'second@example.com',
    'x'.repeat(500),
    '🙂'.repeat(200), // 4 bytes each in UTF-8
    'a name with spaces and : colons : in it',
  ];
  for (const name of names) {
    for (const idx of [0, 1, 9, 42, 999_999]) {
      const data = encodeSwap(idx, name);
      const bytes = Buffer.byteLength(data, 'utf8');
      ok(bytes <= CALLBACK_DATA_MAX, `${bytes} bytes for index ${idx} / name length ${name.length}`);
    }
  }
});

await t('CAPTURE_DATA is within the cap', () => {
  ok(Buffer.byteLength(CAPTURE_DATA, 'utf8') <= CALLBACK_DATA_MAX, 'capture payload too long');
});

await t('encodeSwap refuses an index it cannot encode safely', () => {
  throws(() => encodeSwap(-1, 'a'), /non-negative|0\.\.999999/i, 'negative index');
  throws(() => encodeSwap(1.5, 'a'), /integer/i, 'float index');
  throws(() => encodeSwap('1', 'a'), /integer/i, 'string index');
  throws(() => encodeSwap(1_000_000, 'a'), /0\.\.999999/i, 'index past the encodable range');
});

await t('accountTag is stable and differs per name', () => {
  eq(accountTag('second@example.com'), accountTag('second@example.com'));
  ok(accountTag('a') !== accountTag('b'), 'two names produced the same tag');
  ok(/^[0-9a-f]{8}$/.test(accountTag('anything')), 'tag is not 8 hex chars');
});

// ---------- decode ----------

await t('decode round-trips every encode', () => {
  ROWS.forEach((r, i) => {
    eq(decodeAccountCallback(encodeSwap(i, r.name)), { verb: 'swap', index: i, tag: accountTag(r.name) });
  });
  eq(decodeAccountCallback(CAPTURE_DATA), { verb: 'capture' });
});

await t('decode rejects malformed payloads', () => {
  const tag = accountTag('second@example.com');
  const bad = [
    '', // empty string
    'acct:swap:-1:' + tag, // negative index
    'acct:swap:1.5:' + tag, // non-integer index
    'acct:swap:abc:' + tag, // non-numeric index
    'acct:swap: 1:' + tag, // whitespace-padded index
    'acct:swap:1e3:' + tag, // exponent notation
    'acct:swap:1234567:' + tag, // past the bounded digit count
    'acct:swap:0', // no tag at all
    'acct:swap:0:' + tag + ':extra', // trailing junk
    'acct:swap:0:NOTHEX!!', // tag not hex
    'acct:swap:0:abc', // tag wrong length
    'acct:burn:0:' + tag, // unknown verb
    'acct:capture:extra', // capture with junk
    'other:swap:0:' + tag, // foreign namespace
    'swap:0', // no namespace
    'x'.repeat(65), // over the 64-byte cap
    'acct:swap:0:' + tag + 'x'.repeat(60), // over the cap, otherwise plausible
  ];
  for (const d of bad) eq(decodeAccountCallback(d), null, `accepted ${JSON.stringify(d.slice(0, 40))}:`);
});

await t('decode rejects non-strings', () => {
  for (const d of [null, undefined, 0, 1, {}, [], true, Symbol('x')]) eq(decodeAccountCallback(d), null);
});

await t('decode rejects a payload over 64 bytes even when its ASCII length is not', () => {
  // 30 emoji = 120 UTF-8 bytes but only 60 UTF-16 code units.
  const sneaky = 'acct:swap:0:' + '🙂'.repeat(30);
  ok(sneaky.length < 80, 'fixture is not testing what it claims');
  ok(Buffer.byteLength(sneaky, 'utf8') > CALLBACK_DATA_MAX, 'fixture is not over the byte cap');
  eq(decodeAccountCallback(sneaky), null);
});

// ---------- labels ----------

await t('labelForSwap marks limited and uncaptured slots, and round-trips', () => {
  eq(labelForSwap(ROWS[0]), 'Swap to second@example.com');
  eq(labelForSwap({ name: 'x@y.z', captured: true, limited: true }), '⛔ x@y.z (limited)');
  eq(labelForSwap({ name: 'x@y.z', captured: false, limited: false }), '⚠️ x@y.z (no credentials)');
  for (const row of [
    ROWS[0],
    { name: 'x@y.z', captured: true, limited: true },
    { name: 'x@y.z', captured: false, limited: false },
  ]) {
    eq(nameFromLabel(labelForSwap(row)), row.name, 'label did not round-trip:');
  }
});

await t('nameFromLabel survives junk', () => {
  eq(nameFromLabel(null), '');
  eq(nameFromLabel(undefined), '');
  eq(nameFromLabel(''), '');
  eq(nameFromLabel('  Swap to  a@b.c  '), 'a@b.c');
  eq(nameFromLabel('a@b.c'), 'a@b.c');
});

await t('labelForCallbackData finds the tapped button and nothing else', () => {
  const kb = buildAccountKeyboard(ROWS, { activeName: ROWS[0].name });
  eq(labelForCallbackData(kb, encodeSwap(1, ROWS[1].name)), 'Swap to first@example.com');
  eq(labelForCallbackData(kb, CAPTURE_DATA), CAPTURE_LABEL);
  eq(labelForCallbackData(kb, 'acct:swap:0:deadbeef'), null, 'matched a button that is not there');
  eq(labelForCallbackData(null, CAPTURE_DATA), null);
  eq(labelForCallbackData({ inline_keyboard: 'nope' }, CAPTURE_DATA), null);
  eq(labelForCallbackData({}, CAPTURE_DATA), null);
});

// ---------- keyboard ----------

await t('keyboard skips the active account and always ends with capture', () => {
  const kb = buildAccountKeyboard(ROWS, { activeName: 'first@example.com' });
  eq(
    kb.inline_keyboard.map((r) => r[0].text),
    ['Swap to second@example.com', 'Swap to third@example.com', CAPTURE_LABEL],
  );
  // The encoded index is the index into the FULL list, not the filtered keyboard.
  eq(decodeAccountCallback(kb.inline_keyboard[1][0].callback_data).index, 2);
});

await t('keyboard indices survive filtering — every button decodes back to its own label', () => {
  for (const activeName of [null, ...ROWS.map((r) => r.name)]) {
    const kb = buildAccountKeyboard(ROWS, { activeName });
    for (const [btn] of kb.inline_keyboard) {
      if (btn.callback_data === CAPTURE_DATA) continue;
      const decoded = decodeAccountCallback(btn.callback_data);
      const resolved = resolveSwapTarget(ROWS, decoded, nameFromLabel(btn.text));
      ok(resolved.ok, `button "${btn.text}" did not resolve: ${resolved.error}`);
      eq(resolved.row.name, nameFromLabel(btn.text), 'button resolved to the wrong account:');
    }
  }
});

await t('keyboard tolerates junk rows and an empty list', () => {
  const kb = buildAccountKeyboard([null, { name: '' }, ROWS[0]], {});
  eq(kb.inline_keyboard.map((r) => r[0].text), ['Swap to second@example.com', CAPTURE_LABEL]);
  eq(buildAccountKeyboard([], {}).inline_keyboard.map((r) => r[0].text), [CAPTURE_LABEL]);
  eq(buildAccountKeyboard(null, {}).inline_keyboard.map((r) => r[0].text), [CAPTURE_LABEL]);
});

await t('every callback_data the keyboard builds is within the byte cap', () => {
  for (const [btn] of buildAccountKeyboard(ROWS, {}).inline_keyboard) {
    ok(Buffer.byteLength(btn.callback_data, 'utf8') <= CALLBACK_DATA_MAX, `${btn.callback_data} is too long`);
  }
});

// ---------- resolveSwapTarget ----------

await t('resolve refuses an out-of-range index', () => {
  const d = { verb: 'swap', index: 7, tag: accountTag(ROWS[0].name) };
  const r = resolveSwapTarget(ROWS, d, ROWS[0].name);
  eq(r.ok, false);
  eq(r.reason, 'moved');
});

await t('resolve refuses a negative or non-integer index', () => {
  for (const index of [-1, 1.5, NaN, '0', null, undefined]) {
    const r = resolveSwapTarget(ROWS, { verb: 'swap', index, tag: accountTag(ROWS[0].name) }, null);
    eq(r.ok, false, `index ${JSON.stringify(index)} resolved:`);
    eq(r.reason, 'moved');
  }
});

await t('resolve refuses when the list moved under the button', () => {
  // Same index, but a capture inserted a new slot at position 0 since render.
  const moved = [{ ...ROWS[2] }, ...ROWS];
  const d = decodeAccountCallback(encodeSwap(0, ROWS[0].name)); // tag says second@
  const r = resolveSwapTarget(moved, d, 'second@example.com');
  eq(r.ok, false, 'a moved list still swapped');
  eq(r.reason, 'moved');
});

// The digest and the label are two INDEPENDENT bindings of a tap to an account,
// and each must refuse on its own — the test above is satisfied by the label
// check alone, so this one removes the label entirely and leaves only the digest
// standing between a stale index and the wrong account.
await t('resolve refuses a moved list on the digest alone, with no label to help', () => {
  const moved = [{ ...ROWS[2] }, ...ROWS];
  const d = decodeAccountCallback(encodeSwap(0, ROWS[0].name)); // tag says second@, index 0 is now hello@
  const r = resolveSwapTarget(moved, d, null);
  eq(r.ok, false, 'a stale index swapped with no label check available');
  eq(r.reason, 'moved');
});

await t('resolve refuses a forged index/tag pairing', () => {
  // Valid tag for one account, index pointing at another: the shape a hand-built
  // callback_data would have.
  const forged = `${CALLBACK_NS}:swap:2:${accountTag(ROWS[0].name)}`;
  const r = resolveSwapTarget(ROWS, decodeAccountCallback(forged), null);
  eq(r.ok, false, 'a forged index/tag pair resolved');
  eq(r.reason, 'moved');
});

await t('resolve refuses when the button label disagrees with the store', () => {
  const d = decodeAccountCallback(encodeSwap(0, ROWS[0].name));
  const r = resolveSwapTarget(ROWS, d, 'someone-else@example.com');
  eq(r.ok, false);
  eq(r.reason, 'moved');
});

await t('resolve works on the digest alone when no label is recoverable', () => {
  const d = decodeAccountCallback(encodeSwap(2, ROWS[2].name));
  const r = resolveSwapTarget(ROWS, d, null);
  eq(r.ok, true, `refused without a label: ${r.error}`);
  eq(r.row.name, 'third@example.com');
});

await t('resolve refuses a limited or uncaptured slot with a reason', () => {
  const limited = [{ ...ROWS[0], limited: true, limitedUntil: 9e9 }, ...ROWS.slice(1)];
  const rl = resolveSwapTarget(limited, decodeAccountCallback(encodeSwap(0, ROWS[0].name)), null);
  eq(rl.ok, false);
  eq(rl.reason, 'limited');
  ok(/rate limited/i.test(rl.error), rl.error);

  const bare = [{ ...ROWS[0], captured: false }, ...ROWS.slice(1)];
  const rb = resolveSwapTarget(bare, decodeAccountCallback(encodeSwap(0, ROWS[0].name)), null);
  eq(rb.ok, false);
  eq(rb.reason, 'no-credentials');
});

await t('resolve refuses a decoded capture or garbage', () => {
  eq(resolveSwapTarget(ROWS, { verb: 'capture' }, null).reason, 'unknown');
  eq(resolveSwapTarget(ROWS, null, null).reason, 'unknown');
});

// ---------- authorization ----------

await t('authorizeCallback is deny-by-default', () => {
  eq(authorizeCallback({ from: { id: 123456789 } }, OWNER), { ok: true, from: OWNER });
  eq(authorizeCallback({ from: { id: '123456789' } }, OWNER).ok, true, 'string id rejected');
  eq(authorizeCallback({ from: { id: 999 } }, OWNER).ok, false, 'foreign id accepted');
  eq(authorizeCallback({ from: {} }, OWNER).ok, false, 'missing id accepted');
  eq(authorizeCallback({}, OWNER).ok, false, 'missing from accepted');
  eq(authorizeCallback(null, OWNER).ok, false, 'null callback accepted');
  // An unconfigured owner must not authorize everyone.
  eq(authorizeCallback({ from: { id: '' } }, '').ok, false, 'empty owner authorized an empty id');
  eq(authorizeCallback({ from: { id: 123 } }, '').ok, false, 'empty owner authorized someone');
  eq(authorizeCallback({ from: { id: 123 } }, null).ok, false, 'null owner authorized someone');
});

// ---------- routing ----------

const tapOn = (rows, index, { from = Number(OWNER), activeName = null, id = 'cbq1', messageId = 55 } = {}) => {
  const kb = buildAccountKeyboard(rows, { activeName });
  const btn = kb.inline_keyboard.map((r) => r[0]).find((b) => decodeAccountCallback(b.callback_data)?.index === index);
  return {
    id,
    from: { id: from },
    data: btn.callback_data,
    message: { message_id: messageId, reply_markup: kb },
  };
};

await t('routeCallback plans a swap for the owner', () => {
  const r = routeCallback(tapOn(ROWS, 1), { chatId: OWNER, rows: ROWS });
  eq(r.action, 'swap');
  eq(r.name, 'first@example.com');
  eq(r.index, 1);
  eq(r.messageId, 55);
});

await t('routeCallback refuses a foreign tap BEFORE decoding anything', () => {
  const r = routeCallback(tapOn(ROWS, 1, { from: 42 }), { chatId: OWNER, rows: ROWS });
  eq(r.action, 'unauthorized');
  eq(r.from, '42');
  eq(r.name, undefined, 'an unauthorized route carried an account name');
});

await t('routeCallback plans a capture', () => {
  const cq = { id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 9 } };
  eq(routeCallback(cq, { chatId: OWNER, rows: ROWS }).action, 'capture');
});

await t('routeCallback marks unknown data unknown, not a swap', () => {
  const cq = { id: 'c', from: { id: OWNER }, data: 'acct:swap:0:zzzzzzzz', message: { message_id: 9 } };
  eq(routeCallback(cq, { chatId: OWNER, rows: ROWS }).action, 'unknown');
});

await t('routeCallback tolerates a missing message (no reply_markup to read)', () => {
  const cq = { id: 'c', from: { id: OWNER }, data: encodeSwap(0, ROWS[0].name) };
  const r = routeCallback(cq, { chatId: OWNER, rows: ROWS });
  eq(r.action, 'swap');
  eq(r.name, 'second@example.com');
  eq(r.messageId, null);
});

// ---------- the executor ----------

function harness({ rows = ROWS, swapResult = null, captureResult = null, active = null, throwOnDescribe = false, peeked = null, notifyThrows = false } = {}) {
  const calls = { swapTo: [], captureCurrent: [], answers: [], refreshes: [], logs: [], notes: [], peeks: [] };
  const store = {
    describe: () => {
      if (throwOnDescribe) throw new Error('accounts.json is unreadable');
      return rows.map((r) => ({ ...r }));
    },
    swapTo: async (name) => {
      calls.swapTo.push(name);
      return swapResult ?? { ok: true, from: 'second@example.com', to: name, fingerprint: 'a…XXXXXX/r…YYYYYY' };
    },
    captureCurrent: async (name, opts) => {
      calls.captureCurrent.push({ name, opts });
      return (
        captureResult ?? {
          ok: true,
          replaced: true,
          account: { name, claudeAiOauth: { accessToken: 'sk-ant-oat01-NEVER-RENDER', refreshToken: 'sk-ant-ort01-NEVER' } },
        }
      );
    },
  };
  const usage = {
    resolveActive: async () => active,
    // Records the ORDER of peek vs invalidate: the confirmation's headroom line
    // has to be read before the swap side effects clear the cache.
    peek: (name) => {
      calls.peeks.push(name);
      return peeked;
    },
  };
  const handle = createAccountCallbacks({
    chatId: OWNER,
    store,
    usage,
    answer: async (id, text, opts) => calls.answers.push({ id, text, alert: !!opts?.alert }),
    refreshView: ({ messageId, status }) => calls.refreshes.push({ messageId, status }),
    notify: async (text) => {
      if (notifyThrows) throw new Error('sendMessage: 429 Too Many Requests');
      calls.notes.push(text);
    },
    onSwapped: () => calls.logs.push(`onSwapped:${calls.peeks.length}`),
    onCaptured: () => calls.logs.push('onCaptured'),
    log: (m) => calls.logs.push(m),
  });
  return { handle, calls };
}

await t('THE REJECTED TAP: a foreign from.id never reaches store.swapTo', async () => {
  const { handle, calls } = harness();
  const out = await handle(tapOn(ROWS, 1, { from: 987654321 }));
  eq(out.action, 'unauthorized');
  eq(calls.swapTo, [], 'a foreign tap reached the swap path');
  eq(calls.captureCurrent, [], 'a foreign tap reached the capture path');
  eq(calls.refreshes, [], 'a foreign tap refreshed the owner view');
  eq(calls.answers.length, 1, 'a foreign tap was not answered exactly once');
  eq(calls.answers[0].alert, true);
  ok(calls.logs.some((l) => /unauthorized/i.test(l)), 'the foreign tap was not logged');
});

await t('a foreign CAPTURE tap never reaches store.captureCurrent either', async () => {
  const { handle, calls } = harness({ active: { name: 'second@example.com', email: 'second@example.com' } });
  const out = await handle({ id: 'c', from: { id: 42 }, data: CAPTURE_DATA, message: { message_id: 3 } });
  eq(out.action, 'unauthorized');
  eq(calls.captureCurrent, []);
  eq(calls.swapTo, []);
});

await t('the owner tapping a swap button swaps to exactly that account', async () => {
  const { handle, calls } = harness();
  const out = await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(out.ok, true, out.error);
  eq(calls.swapTo, ['third@example.com']);
  eq(calls.answers.length, 1);
  ok(/Swapped to third@example\.com/.test(calls.answers[0].text), calls.answers[0].text);
  eq(calls.refreshes.length, 1, 'the view was not refreshed');
  eq(calls.refreshes[0].messageId, 55);
  // The refreshed view still leads with the confirmation, and keeps the caveat
  // that does not fit a three-line notification.
  ok(/^🔄 Now on `third@example\.com`/.test(calls.refreshes[0].status), calls.refreshes[0].status);
  ok(/Workers already running keep their old session/.test(calls.refreshes[0].status), calls.refreshes[0].status);
  ok(calls.logs.some((l) => l.startsWith('onSwapped')), 'the swap side effects did not fire');
});

await t('a stale button whose list moved refuses instead of swapping the wrong account', async () => {
  // Rendered against ROWS, tapped after a capture inserted a slot at the front.
  const tap = tapOn(ROWS, 0);
  const { handle, calls } = harness({ rows: [{ ...ROWS[2] }, ...ROWS] });
  const out = await handle(tap);
  eq(out.action, 'refuse');
  eq(out.reason, 'moved');
  eq(calls.swapTo, [], 'a stale index swapped anyway');
  eq(calls.answers[0].alert, true);
  ok(/run \/account again/i.test(calls.answers[0].text), calls.answers[0].text);
});

await t('a stale button with no recoverable label still refuses on the digest', async () => {
  // Same stale tap as above, but Telegram gave us no reply_markup to read, so
  // only the digest carried in the payload can catch it.
  const tap = tapOn(ROWS, 0);
  const { handle, calls } = harness({ rows: [{ ...ROWS[2] }, ...ROWS] });
  const out = await handle({ id: tap.id, from: tap.from, data: tap.data, message: { message_id: 55 } });
  eq(out.action, 'refuse');
  eq(out.reason, 'moved');
  eq(calls.swapTo, [], 'a stale index swapped the wrong account with no label to check');
});

await t('tapping a limited account refuses with why, and does not swap', async () => {
  const rows = [{ ...ROWS[0], limited: true, limitedUntil: 9e9 }, ...ROWS.slice(1)];
  const tap = tapOn(rows, 0);
  const { handle, calls } = harness({ rows });
  const out = await handle(tap);
  eq(out.action, 'refuse');
  eq(out.reason, 'limited');
  eq(calls.swapTo, [], 'swapped into a limited account');
  ok(/rate limited/i.test(calls.answers[0].text), calls.answers[0].text);
});

await t('a failed swap is reported, not silently swallowed', async () => {
  const { handle, calls } = harness({ swapResult: { ok: false, error: 'keychain write failed' } });
  const out = await handle(tapOn(ROWS, 1));
  eq(out.ok, false);
  ok(/keychain write failed/.test(calls.answers[0].text), calls.answers[0].text);
  ok(/unchanged/.test(calls.refreshes[0].status), calls.refreshes[0].status);
  ok(!calls.logs.includes('onSwapped'), 'a failed swap fired the success side effects');
});

await t('capture banks into the slot named by the live profile email', async () => {
  const { handle, calls } = harness({ active: { name: null, email: 'new@example.com', matchedBy: 'profileEmailUnenrolled' } });
  const out = await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(out.ok, true, out.error);
  eq(calls.captureCurrent, [{ name: 'new@example.com', opts: { email: 'new@example.com' } }]);
  ok(calls.logs.includes('onCaptured'), 'capture side effects did not fire');
  eq(calls.refreshes[0].messageId, 7);
});

await t('capture prefers the slot the live blob was identified as', async () => {
  const { handle, calls } = harness({ active: { name: 'first@example.com', email: null, matchedBy: 'refreshToken' } });
  await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(calls.captureCurrent, [{ name: 'first@example.com', opts: {} }]);
});

await t('capture refuses when the live login cannot be identified', async () => {
  const { handle, calls } = harness({ active: { name: null, email: null, liveFingerprint: 'none' } });
  const out = await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(out.ok, false);
  eq(calls.captureCurrent, [], 'captured into an invented slot name');
  ok(/could not identify the current login/i.test(calls.answers[0].text), calls.answers[0].text);
  ok(/\/account capture/.test(calls.answers[0].text), 'the refusal did not name the typed fallback');
});

await t('capture refuses to overwrite a slot that belongs to a different email', async () => {
  const rows = [{ ...ROWS[0], name: 'shared-slot', email: 'someone@else.com' }];
  const { handle, calls } = harness({ rows, active: { name: null, email: 'shared-slot' } });
  const out = await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(out.ok, false);
  eq(calls.captureCurrent, [], 'overwrote another identity’s slot');
  ok(/belongs to someone@else\.com/.test(calls.answers[0].text), calls.answers[0].text);
});

await t('a failed capture is reported', async () => {
  const { handle, calls } = harness({
    active: { name: 'first@example.com' },
    captureResult: { ok: false, error: 'no readable claudeAiOauth in the keychain' },
  });
  const out = await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(out.ok, false);
  ok(/no readable claudeAiOauth/.test(calls.answers[0].text), calls.answers[0].text);
  ok(!calls.logs.includes('onCaptured'), 'a failed capture fired the success side effects');
});

await t('a thrown store still answers the callback exactly once', async () => {
  const calls = { answers: [] };
  const handle = createAccountCallbacks({
    chatId: OWNER,
    store: {
      describe: () => ROWS.map((r) => ({ ...r })),
      swapTo: async () => {
        throw new Error('security(1) timed out');
      },
    },
    answer: async (id, text, opts) => calls.answers.push({ id, text, alert: !!opts?.alert }),
    log: () => {},
  });
  const out = await handle(tapOn(ROWS, 1));
  eq(out.error, 'security(1) timed out');
  eq(calls.answers.length, 1, 'a thrown swap left the button spinning or double-answered');
  eq(calls.answers[0].alert, true);
});

await t('an unreadable account list refuses rather than swapping blind', async () => {
  const { handle, calls } = harness({ throwOnDescribe: true });
  const out = await handle(tapOn(ROWS, 1));
  eq(out.action, 'refuse');
  eq(calls.swapTo, []);
  eq(calls.answers.length, 1);
});

await t('unknown callback data is answered, never executed', async () => {
  const { handle, calls } = harness();
  const out = await handle({ id: 'c', from: { id: OWNER }, data: 'acct:nuke:everything', message: { message_id: 1 } });
  eq(out.action, 'unknown');
  eq(calls.swapTo, []);
  eq(calls.captureCurrent, []);
  eq(calls.answers.length, 1);
});

await t('every action answers exactly once — no path leaves a spinner', async () => {
  const cases = [
    tapOn(ROWS, 1), // swap
    tapOn(ROWS, 1, { from: 42 }), // unauthorized
    { id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 1 } }, // capture
    { id: 'c', from: { id: OWNER }, data: 'garbage', message: { message_id: 1 } }, // unknown
    { id: 'c', from: { id: OWNER }, data: encodeSwap(9, 'nobody'), message: { message_id: 1 } }, // refuse
  ];
  for (const cq of cases) {
    const { handle, calls } = harness({ active: { name: 'first@example.com' } });
    await handle(cq);
    eq(calls.answers.length, 1, `${cq.data} answered ${calls.answers.length} times:`);
  }
});

await t('a missing callback id does not crash the handler', async () => {
  const { handle } = harness();
  const out = await handle({ from: { id: OWNER }, data: CAPTURE_DATA });
  ok(out, 'handler returned nothing');
});

await t('the factory refuses to be built without its dependencies', () => {
  throws(() => createAccountCallbacks({ chatId: OWNER, answer: () => {} }), /store/, 'built without a store');
  throws(() => createAccountCallbacks({ chatId: OWNER, store: {} }), /answer/, 'built without an answer fn');
});

// ---------- the standalone confirmation ----------
//
// THE DEFECT THESE PROTECT: a successful swap reported itself only through an
// answerCallbackQuery toast (gone in five seconds) and an EDIT to the /account
// message (invisible once that message has scrolled). On a phone the tap looked
// like it did nothing. Every terminal outcome now ALSO sends a new message.

await t('a successful swap sends its OWN message, not only a toast and an edit', async () => {
  const { handle, calls } = harness({
    peeked: { name: 'third@example.com', state: 'ok', usage: { fiveHour: { percent: 0, resetsAt: null }, sevenDay: { percent: 31, resetsAt: null }, scoped: [] } },
  });
  await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(calls.notes.length, 1, 'the swap did not send a standalone message');
  eq(
    calls.notes[0],
    ['🔄 Now on `third@example.com`', 'was `second@example.com` · MCP tokens kept', '5h 0% · wk 31%'].join('\n'),
  );
  ok(calls.notes[0].split('\n').length <= 3, 'the confirmation grew past three lines');
  // In ADDITION to, never instead of: the edit is what re-renders the button
  // rows so the account he just moved to loses its swap button.
  eq(calls.refreshes.length, 1, 'the in-place refresh was dropped');
});

await t('the headroom line is read from cache BEFORE the swap invalidates it, and never fetched', async () => {
  const { handle, calls } = harness({ peeked: { name: 'x', state: 'ok', usage: { fiveHour: { percent: 5 }, sevenDay: { percent: 9 }, scoped: [] } } });
  await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(calls.peeks, ['third@example.com'], 'the cache was peeked for the wrong account, or not at all');
  // onSwapped is what clears the cache; the peek must already have happened.
  ok(calls.logs.includes('onSwapped:1'), 'the usage cache was invalidated before the confirmation read it');
  ok(calls.notes[0].endsWith('5h 5% · wk 9%'), calls.notes[0]);
});

await t('a cold usage cache costs the third line, never the confirmation', async () => {
  const { handle, calls } = harness({ peeked: null });
  const out = await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(out.ok, true, out.error);
  eq(calls.notes.length, 1);
  eq(calls.notes[0].split('\n').length, 2, `a cold cache should drop the headroom line, not add a blank one:\n${calls.notes[0]}`);
  ok(calls.notes[0].startsWith('🔄 Now on `third@example.com`'), calls.notes[0]);
});

await t('a usage reader with no peek() at all does not break the swap', async () => {
  // The factory takes `usage` for resolveActive(); an older or partial one
  // without peek() must degrade to "no headroom line", not throw mid-swap.
  const calls = { notes: [], swapTo: [] };
  const handle = createAccountCallbacks({
    chatId: OWNER,
    store: {
      describe: () => ROWS.map((r) => ({ ...r })),
      swapTo: async (name) => {
        calls.swapTo.push(name);
        return { ok: true, from: 'second@example.com', to: name };
      },
    },
    usage: { resolveActive: async () => null },
    answer: async () => {},
    notify: async (t) => calls.notes.push(t),
    log: () => {},
  });
  const out = await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(out.ok, true, out.error);
  eq(calls.swapTo, ['third@example.com']);
  eq(calls.notes[0].split('\n').length, 2);
});

await t('a FAILED swap gets its own message too, and keeps routine apart from urgent', async () => {
  // Routine: the rollback took, nothing moved. He can just try again.
  const routine = harness({ swapResult: { ok: false, error: 'keychain write failed; the previous account is still active and nothing changed' } });
  await routine.handle(tapOn(ROWS, 1));
  eq(routine.calls.notes.length, 1, 'a failed swap sent no standalone message');
  ok(routine.calls.notes[0].startsWith('❌ Swap to `first@example.com` failed'), routine.calls.notes[0]);
  ok(routine.calls.notes[0].includes('The live account is unchanged.'), routine.calls.notes[0]);

  // Urgent: the keychain holds a blob with no claudeAiOauth and NOTHING will
  // run until he logs in. This must not read like the routine one — that is the
  // whole reason it gets a message instead of a five-second toast.
  const urgent = harness({ swapResult: { ok: false, error: 'keychain write failed AND the rollback did not take. Run: claude /login' } });
  await urgent.handle(tapOn(ROWS, 1));
  ok(urgent.calls.notes[0].startsWith('🚨'), `the urgent failure reads like the routine one:\n${urgent.calls.notes[0]}`);
  ok(urgent.calls.notes[0].includes('claude /login'), 'the urgent failure lost the instruction that fixes it');
  ok(!routine.calls.notes[0].startsWith('🚨'), 'the routine failure was escalated');
});

await t('a capture reports itself standalone, on success and on failure', async () => {
  const okc = harness({ active: { name: 'first@example.com', email: null, matchedBy: 'refreshToken' } });
  await okc.handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(okc.calls.notes.length, 1, 'a capture sent no standalone message');
  ok(okc.calls.notes[0].startsWith('📸 Captured the current login into `first@example.com`'), okc.calls.notes[0]);
  ok(/Replaced what was there · `a…/.test(okc.calls.notes[0]), 'the capture lost the fingerprint of the blob it banked');

  const bad = harness({ active: { name: 'first@example.com' }, captureResult: { ok: false, error: 'no readable claudeAiOauth in the keychain' } });
  await bad.handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  eq(bad.calls.notes[0], '❌ Capture failed\nno readable claudeAiOauth in the keychain');

  const unknown = harness({ active: { name: null, email: null, liveFingerprint: 'none' } });
  await unknown.handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  ok(unknown.calls.notes[0].startsWith('❌ Capture failed'), unknown.calls.notes[0]);

  // The slot-conflict refusal is the one message carrying an email WE did not
  // write — it comes out of the comparison. It must be code-wrapped too, or it
  // is the one linkified address left on the whole surface.
  const clash = harness({ rows: [{ ...ROWS[0], name: 'shared-slot', email: 'someone@else.com' }], active: { name: null, email: 'shared-slot' } });
  await clash.handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 7 } });
  ok(clash.calls.notes[0].includes('`someone@else.com`'), clash.calls.notes[0]);
  eq(clash.calls.notes[0].replace(/`[^`\n]*`/g, '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), null, clash.calls.notes[0]);
  // ...while the TOAST keeps the plain string: answerCallbackQuery takes no
  // parse mode, so a backtick there would render as a backtick.
  ok(!clash.calls.answers[0].text.includes('`'), `a backtick reached the toast: ${clash.calls.answers[0].text}`);
});

await t('a swap that LANDED is never reported as failed because the message could not be sent', async () => {
  const { handle, calls } = harness({ notifyThrows: true });
  const out = await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  eq(out.ok, true, 'a dead notification turned a successful swap into a failure');
  eq(calls.swapTo, ['third@example.com']);
  eq(calls.answers.length, 1, 'the button was left spinning');
  ok(calls.logs.some((l) => /confirmation could not be sent/.test(l)), 'the send failure was swallowed silently');
});

await t('a refused tap sends NO standalone message — only the toast', async () => {
  // A refusal changed nothing, so it does not deserve a message in the chat;
  // the toast is where "that button is stale" belongs.
  const rows = [{ ...ROWS[0], limited: true, limitedUntil: 9e9 }, ...ROWS.slice(1)];
  const { handle, calls } = harness({ rows });
  await handle(tapOn(rows, 0));
  eq(calls.notes, [], 'a refusal pushed a message into the chat');
  const foreign = harness();
  await foreign.handle(tapOn(ROWS, 1, { from: 987654321 }));
  eq(foreign.calls.notes, [], 'a foreign tap pushed a message into the owner chat');
});

await t('no confirmation leaves a bare email for Telegram to linkify', async () => {
  const { handle, calls } = harness({ active: { name: 'first@example.com' } });
  await handle(tapOn(ROWS, 2, { activeName: ROWS[0].name }));
  await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 1 } });
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  for (const text of [...calls.notes, ...calls.refreshes.map((r) => r.status)]) {
    const outside = text.replace(/`[^`\n]*`/g, '');
    ok(!EMAIL.test(outside), `an email rendered outside a code span, Telegram will linkify it:\n${outside}`);
  }
});

// ---------- the standing rule: nothing here may print a token ----------

await t('no rendered string can contain a token', async () => {
  const { handle, calls } = harness({
    active: { name: 'first@example.com', oauth: { accessToken: 'sk-ant-oat01-SHOULD-NEVER-RENDER' } },
  });
  await handle(tapOn(ROWS, 1));
  await handle({ id: 'c', from: { id: OWNER }, data: CAPTURE_DATA, message: { message_id: 1 } });
  const rendered = [
    ...calls.answers.map((a) => a.text),
    ...calls.refreshes.map((r) => r.status),
    ...calls.logs,
    JSON.stringify(buildAccountKeyboard(ROWS, {})),
  ].join('\n');
  ok(!/SHOULD-NEVER-RENDER/.test(rendered), 'an access token was rendered');
  ok(!/NEVER-RENDER|sk-ant-oat01-[A-Za-z0-9]/.test(rendered), 'a token-shaped string was rendered');
  ok(!/sk-ant-ort01/.test(rendered), 'a refresh token was rendered');
  // The keyboard carries digests, not names-as-credentials and not tokens.
  ok(!/accessToken|refreshToken/.test(JSON.stringify(buildAccountKeyboard(ROWS, {}))), 'keyboard carried token fields');
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all account-buttons tests pass');
