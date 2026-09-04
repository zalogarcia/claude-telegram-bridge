// ---------------------------------------------------------------------------
// DASHES OUT OF THE PROSE, ON THE WAY TO THE PHONE
//
// The owner's standing rule for their own copy is no em dashes, anywhere, on any
// channel. Claude has been trained off them by their CLAUDE.md; Codex has not,
// and its replies arrive full of them. That is the whole reason this exists:
// the bridge is now a two-engine product and the second engine writes in a
// register the first one was told not to.
//
// It is a normalizer, not a lint. A lint tells you afterwards. This runs on the
// outbound reply for BOTH engines, so the message they read is already right.
//
// The two characters appear here ONLY as \u2014 and \u2013 escapes, never as
// literals, so this file passes the same no-dash check every other file in the
// repo is held to and a grep for a stray dash finds real ones.
//
// WHAT IT WILL NOT TOUCH, and why each one is load-bearing:
//
//   inline code spans and fenced blocks
//       `foo --bar` and a shell script are CODE. A dash inside them is a flag,
//       an operator or a heredoc marker, and rewriting one turns a copyable
//       command into a broken one. This is the failure mode that makes a
//       normalizer dangerous rather than merely wrong.
//   URLs
//       a hyphen in a path is part of the address. En dashes do not occur in
//       one, but a URL sitting in prose must come out the other side byte for
//       byte or the link 404s.
//   <<<...>>> markers
//       the handoff block's own framing, which the injection path relies on.
//   HTML tags
//       the reply is rendered to Telegram HTML downstream, and this runs BEFORE
//       that, so there is nothing to protect yet. Kept in the contract anyway:
//       if it ever moves, it must not eat a tag.
//
// WHERE IT LIVES. This belongs in md-format.mjs on the merits: it is a pure
// text transform in the same layer as mdToTelegramHtml, and that is where the
// brief asked for it. md-format.mjs is a SHARED module, byte-identical with the
// public repo, and scripts/check-shared.sh fails on any drift. Adding a
// function there without also touching the public repo (which this job may not)
// would break that guard, so it sits here instead, in one file with no other
// job, ready to be pasted into md-format.mjs the day the public port happens.
// ---------------------------------------------------------------------------

export const EM_DASH = '\u2014';
export const EN_DASH = '\u2013';

// A fenced block, an inline code span, a bare URL, the handoff markers, and an
// HTML tag. Order matters: the fence is matched before the inline span, or a
// fence containing a backtick pair would be split at the wrong place.
const PROTECTED = new RegExp(
  [
    '```[\\s\\S]*?```', // fenced code
    '`[^`\\n]*`', // inline code
    '<<<[^>]*>>>', // the handoff markers
    'https?://\\S+', // a URL in prose
    '<[^<>\\n]{1,200}>', // an HTML tag, or an <a@b.c> style autolink
  ].join('|'),
  'g',
);

// [^\S\n] is "whitespace that is not a newline". Plain \s CROSSES line breaks,
// so a dash at the start of a line was eating the newline before it and a dash
// ending a paragraph was eating the blank line after it: two paragraphs became
// one. Found by the QA pass, on prose a model writes routinely.
const RE_DIGIT_RANGE = new RegExp(`(\\d)[^\\S\\n]*${EN_DASH}[^\\S\\n]*(\\d)`, 'g');
const RE_TRAILING_EM = new RegExp(`[^\\S\\n]*${EM_DASH}[^\\S\\n]*$`, 'gm');
// A dash that OPENS a line is an aside marker, not a join: turning it into a
// comma leaves a line starting ", like this", which reads as a typo.
const RE_LEADING_EM = new RegExp(`^[^\\S\\n]*${EM_DASH}[^\\S\\n]*`, 'gm');
const RE_EM = new RegExp(`[^\\S\\n]*${EM_DASH}[^\\S\\n]*`, 'g');
const RE_EN = new RegExp(EN_DASH, 'g');
const RE_ANY = new RegExp(`[${EN_DASH}${EM_DASH}]`, 'g');

/**
 * The prose rules, applied to ONE unprotected run of text.
 *
 *   "a <em> b"  becomes  "a, b"     the parenthetical use, which is nearly all
 *                                   of them in model prose.
 *   "a<em>b"    becomes  "a, b"     the same, unspaced, which is how Codex
 *                                   writes it.
 *   "a <em>"    becomes  "a."       a dash that ENDS a clause is doing a full
 *                                   stop's job, so it becomes one. Detected by
 *                                   the dash being followed by nothing but
 *                                   whitespace to the end of the line.
 *   "3<en>5"    becomes  "3 to 5"   a digit range, where the en dash means "to".
 *   "a <en> b"  becomes  "a - b"    every other en dash is a hyphen.
 */
function normalizeRun(run) {
  let s = run;
  // A digit range first: it must not be caught by the generic en-dash rule
  // below, which would leave a bare hyphen and lose the sense.
  s = s.replace(RE_DIGIT_RANGE, '$1 to $2');
  // An em dash with nothing after it but whitespace to the end of the line was
  // ending a clause. A comma there reads as a dropped word; a period does not.
  s = s.replace(RE_TRAILING_EM, '.');
  // Then the line-opening one, before the generic rule can turn it into a comma.
  s = s.replace(RE_LEADING_EM, '');
  // Everything else: one comma, one space, whatever the spacing around it was.
  s = s.replace(RE_EM, ', ');
  // The leftover en dashes are hyphens. Spacing is preserved, so "a <en> b"
  // stays "a - b" and "a<en>b" stays "a-b".
  s = s.replace(RE_EN, '-');
  // ", ," and ",." come out of a dash that already sat next to punctuation.
  s = s.replace(/,\s*([,.;:!?])/g, '$1');
  return s;
}

/**
 * Normalize the dashes in a markdown reply, leaving code, URLs and markers
 * exactly as they were.
 *
 * `enabled` false returns the input unchanged and untouched (not a round trip
 * through the regex), so an install that wants its models' own voice pays
 * nothing for this being here.
 */
export function normalizeDashes(text, { enabled = true } = {}) {
  if (!enabled) return text;
  const src = String(text ?? '');
  if (!src.includes(EM_DASH) && !src.includes(EN_DASH)) return src;
  // Protected regions are LIFTED OUT and replaced with a placeholder rather
  // than normalized around in slices. Same trick mdToTelegramHtml uses for code
  // spans, and here it is what keeps the end-of-clause rule honest: with slices,
  // a line ending in a dash followed by an inline code span would see the slice
  // boundary as the end of the line and turn the dash into a full stop in the
  // middle of a sentence.
  const held = [];
  // A fresh regex per call: PROTECTED is global and lastIndex is state.
  const masked = src.replace(new RegExp(PROTECTED.source, 'g'), (hit) => {
    held.push(hit);
    // NUL-delimited, so the placeholder cannot collide with a number in the
    // prose and cannot itself be rewritten by any rule below. Same sentinel
    // md-format.mjs uses when it lifts code spans out of a markdown reply.
    return `\u0000${held.length - 1}\u0000`;
  });
  return normalizeRun(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
}

/** Does this text still carry a dash the rule forbids? For tests and audits. */
export const countDashes = (text) => (String(text ?? '').match(new RegExp(RE_ANY.source, 'g')) || []).length;
