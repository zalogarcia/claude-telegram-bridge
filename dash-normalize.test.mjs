#!/usr/bin/env node
// Unit tests for the outbound dash normalizer.
//
// The dangerous half of this feature is not the prose: it is everything the
// normalizer must NOT touch. A rewritten dash inside a code span turns a
// command the owner is about to paste into one that fails, and a rewritten dash in a
// URL 404s. Those cases carry the stars.
//
// The literal characters live in fixtures/dashes.json, not in this file, so the
// repo-wide "no em or en dashes in anything we write" check stays a clean grep.
//
//   node dash-normalize.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countDashes, EM_DASH, EN_DASH, normalizeDashes } from './dash-normalize.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(path.join(DIR, 'scripts', 'probes', 'fixtures', 'dashes.json'), 'utf8'));

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---------------------------------------------------------------------------
console.log('\n1. the two characters, and the fixtures that carry them');
// ---------------------------------------------------------------------------

t('the escapes in the module really are the em and en dash', () => {
  eq(EM_DASH.charCodeAt(0), 0x2014);
  eq(EN_DASH.charCodeAt(0), 0x2013);
});

t('the fixture file carries the literals so this test file does not have to', () => {
  ok(countDashes(FIX.spaced.in) > 0, 'the fixture has no dash in it, so it proves nothing');
});

// ---------------------------------------------------------------------------
console.log('\n2. prose');
// ---------------------------------------------------------------------------

t('a spaced em dash becomes a comma and a space', () => {
  eq(normalizeDashes(FIX.spaced.in), FIX.spaced.out);
});

t('an unspaced em dash becomes a comma and a space too', () => {
  eq(normalizeDashes(FIX.unspaced.in), FIX.unspaced.out);
});

t('an em dash that ends the line becomes a full stop', () => {
  eq(normalizeDashes(FIX.trailing.in), FIX.trailing.out);
});

t('two em dashes in one sentence both go', () => {
  const out = normalizeDashes(FIX.two.in);
  eq(out, FIX.two.out);
  eq(countDashes(out), 0);
});

t('a digit range on an en dash reads "to"', () => {
  eq(normalizeDashes(FIX.range.in), FIX.range.out);
});

t('any other en dash is a hyphen, and the spacing survives', () => {
  eq(normalizeDashes(FIX.enSpaced.in), FIX.enSpaced.out);
  eq(normalizeDashes(FIX.enTight.in), FIX.enTight.out);
});

t('a dash already next to punctuation does not leave a double comma', () => {
  eq(normalizeDashes(FIX.punct.in), FIX.punct.out);
});

t('★ a dash at the end of a line does not eat the line break', () => {
  // The QA pass found this: \s crosses newlines, so two lines became one and
  // two paragraphs became one. Model prose does this constantly.
  eq(normalizeDashes(FIX.multiline.in), FIX.multiline.out);
  eq(normalizeDashes(FIX.paragraphs.in), FIX.paragraphs.out);
});

t('★ a dash that OPENS a line is dropped, not turned into a leading comma', () => {
  eq(normalizeDashes(FIX.leading.in), FIX.leading.out);
});

t('text with no dash at all comes back byte for byte', () => {
  const s = 'nothing to do here, `npm ci`, https://x.test/a-b';
  ok(normalizeDashes(s) === s, 'a clean string was rewritten');
});

// ---------------------------------------------------------------------------
console.log('\n3. ★ what it must never touch');
// ---------------------------------------------------------------------------

t('★ an inline code span keeps its dashes', () => {
  const out = normalizeDashes(FIX.codeSpan.in);
  eq(out, FIX.codeSpan.out);
  ok(out.includes(FIX.codeSpan.mustKeep), `the code span was rewritten: ${out}`);
});

t('★ a fenced block keeps every dash, on every line', () => {
  const out = normalizeDashes(FIX.fence.in);
  eq(out, FIX.fence.out);
  ok(out.includes(FIX.fence.mustKeep), `the fence was rewritten: ${out}`);
});

t('★ a URL keeps its dashes even when the prose around it does not', () => {
  const out = normalizeDashes(FIX.url.in);
  eq(out, FIX.url.out);
  ok(out.includes(FIX.url.mustKeep), `the URL was rewritten: ${out}`);
});

t('★ the handoff markers are left alone', () => {
  const out = normalizeDashes(FIX.markers.in);
  ok(out.includes('<<<HANDOFF_START>>>') && out.includes('<<<HANDOFF_END>>>'), out);
});

t('★ an HTML tag survives (this runs before the Telegram render, and must stay safe if it moves)', () => {
  const out = normalizeDashes(FIX.html.in);
  ok(out.includes('<b>'), out);
  ok(out.includes('</b>'), out);
});

t('★ a dash at the end of a line followed by a code span is NOT read as end of line', () => {
  // The bug the placeholder design exists to prevent: with slice-based
  // protection, the run before the code span ENDS there, so the trailing rule
  // fires mid-sentence and puts a full stop in the middle of it.
  const out = normalizeDashes(FIX.dashBeforeCode.in);
  eq(out, FIX.dashBeforeCode.out);
});

t('a NUL sentinel in the input cannot smuggle a protected region out', () => {
  // The placeholder is NUL-delimited; text that already contains the sentinel
  // must not be able to point at held[0] and steal a code span.
  const out = normalizeDashes(`\u00000\u0000 ${FIX.spaced.in} \`keep --this\``);
  ok(out.includes('keep --this'), out);
  eq(countDashes(out), 0);
});

// ---------------------------------------------------------------------------
console.log('\n4. the config flag');
// ---------------------------------------------------------------------------

t('enabled:false returns the input unchanged, dashes and all', () => {
  const out = normalizeDashes(FIX.spaced.in, { enabled: false });
  eq(out, FIX.spaced.in);
  ok(countDashes(out) > 0, 'the flag did not actually leave the dashes in');
});

t('enabled defaults to true', () => {
  eq(countDashes(normalizeDashes(FIX.spaced.in)), 0);
});

// ---------------------------------------------------------------------------
console.log('\n5. the odd inputs a chat reply can actually be');
// ---------------------------------------------------------------------------

t('null and undefined come back as an empty string, never a throw', () => {
  eq(normalizeDashes(null), '');
  eq(normalizeDashes(undefined), '');
});

t('a number is stringified rather than thrown at', () => {
  eq(normalizeDashes(42), '42');
});

t('an unterminated fence does not hang or eat the rest of the message', () => {
  const out = normalizeDashes(FIX.brokenFence.in);
  ok(typeof out === 'string' && out.length > 0, 'the broken fence produced nothing');
  ok(out.includes('after'), out);
});

t('a long reply is normalized in full, not just the first line', () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${FIX.spaced.in}`).join('\n');
  eq(countDashes(normalizeDashes(body)), 0);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
