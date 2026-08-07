#!/usr/bin/env node
// Tests for md-format.mjs — the markdown -> Telegram-HTML layer.
//
// SHARED TEST — byte-identical in the public and private bridge repos, like the
// module it covers. Anything repo-specific (a path in a fixture, a divergent
// regression case) belongs in that repo's own test.mjs, not here.
//
// These used to live in test.mjs, where they were run against functions sliced
// out of bridge.mjs by source text. They now import the module directly, so a
// rename or a missing binding is a load error instead of a silently-skipped
// assertion.
//
//   node md-format.test.mjs

import {
  chunks,
  escHtml,
  stripHtml,
  isTableRow,
  splitCells,
  renderMdTables,
  mdToTelegramHtml,
} from './md-format.mjs';

const M = { chunks, escHtml, stripHtml, isTableRow, splitCells, renderMdTables, mdToTelegramHtml };

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
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

// ---------- mdToTelegramHtml: only Telegram-supported tags ----------
const TG_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'span', 'tg-emoji',
]);

t('emits only tags Telegram supports', () => {
  const html = M.mdToTelegramHtml('# H\n**b** *i* `c`\n- x\n> q\n```js\nlet a = 1 < 2;\n```\n[l](https://e.com)');
  for (const tag of html.matchAll(/<\/?([a-z-]+)[\s>]/g)) {
    ok(TG_TAGS.has(tag[1]), `unsupported tag <${tag[1]}> would be rejected by Telegram`);
  }
});

t('fenced code keeps its language', () => {
  ok(M.mdToTelegramHtml('```python\nx=1\n```').includes('<pre><code class="language-python">'), 'missing language class');
});

t('code contents are escaped, not interpreted', () => {
  const html = M.mdToTelegramHtml('```\nif (a < b && c > d) {}\n```');
  ok(html.includes('&lt;') && html.includes('&amp;&amp;') && html.includes('&gt;'), 'raw < > & would break the parse');
});

t('snake_case is NOT italicised', () => {
  const html = M.mdToTelegramHtml('some_var_name here');
  ok(!html.includes('<i>'), 'underscores in identifiers must not become italics');
});

t('single asterisks do become italics', () => {
  ok(M.mdToTelegramHtml('an *emphatic* word').includes('<i>emphatic</i>'));
});

t('bold survives alongside italics', () => {
  const html = M.mdToTelegramHtml('**bold** and *it*');
  ok(html.includes('<b>bold</b>') && html.includes('<i>it</i>'));
});

t('spaced asterisks in prose are not paired into italics', () => {
  const html = M.mdToTelegramHtml('costs 3 * 4 hours and 2 * 5 dollars');
  ok(!html.includes('<i>'), `unrelated asterisks were paired: ${html}`);
});

t('a bullet whose text ends in an asterisk stays a bullet', () => {
  const html = M.mdToTelegramHtml('* buy milk*');
  ok(!html.includes('<i>'), `bullet became emphasis: ${html}`);
  ok(html.includes('•'), `bullet marker lost: ${html}`);
});

t('consecutive quote lines collapse into ONE blockquote', () => {
  const html = M.mdToTelegramHtml('> a\n> b\n> c');
  eq((html.match(/<blockquote>/g) || []).length, 1, 'blockquotes cannot nest or repeat per line');
});

t('ampersands in link URLs are escaped', () => {
  ok(M.mdToTelegramHtml('[l](https://e.com/?a=1&b=2)').includes('a=1&amp;b=2'));
});

// ---------- escHtml / stripHtml ----------
t('escHtml neutralises the three characters that break an entity parse', () => {
  eq(M.escHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
});

t('escHtml escapes & FIRST, so an escape is never double-escaped', () => {
  // '&' last would turn the '&' of '&lt;' into '&amp;lt;' and print the entity.
  eq(M.escHtml('<'), '&lt;');
});

t('stripHtml is the inverse used for the plain-text fallback', () => {
  eq(M.stripHtml('<b>hi</b> &amp; <i>bye</i>'), 'hi & bye');
});

t('stripHtml unwraps a full rendered message without leaving markup', () => {
  const plain = M.stripHtml(M.mdToTelegramHtml('# H\n**b** and `c`\n- x'));
  ok(!/[<>]/.test(plain.replace(/&[a-z]+;/g, '')), `markup survived: ${plain}`);
});

// ---------- tables ----------
t('isTableRow needs a LEADING pipe, so prose with a pipe is not a table', () => {
  ok(M.isTableRow('| a | b |'));
  ok(M.isTableRow('  | a |'));
  ok(!M.isTableRow('costs a | b in prose'));
  ok(!M.isTableRow('no pipes at all'));
});

t('splitCells trims the outer pipes and every cell', () => {
  eq(M.splitCells('| a | b |'), ['a', 'b']);
});

t('splitCells keeps an escaped pipe inside a cell', () => {
  eq(M.splitCells('| a \\| b | c |'), ['a | b', 'c']);
});

t('a table becomes one titled block per row', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| Ada | eng |');
  ok(out.includes('<b>Ada</b>'), `first cell should be the bold title: ${out}`);
  ok(out.includes('· <i>Role</i>: eng'), `remaining cells become header: value: ${out}`);
  ok(!out.includes('|---|'), `separator row leaked: ${out}`);
});

t('an empty cell is omitted rather than printed as a blank row', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| Ada | |');
  ok(!out.includes('Role'), `empty cell should drop its column: ${out}`);
});

t('a bold first cell is not double-wrapped in <b>', () => {
  const out = M.renderMdTables('| Name | Role |\n|---|---|\n| <b>Ada</b> | eng |');
  ok(!out.includes('<b><b>'), `nested bold would be rejected: ${out}`);
});

t('a pipe line with no separator row is left as prose', () => {
  const src = '| not | a table |\nplain line';
  eq(M.renderMdTables(src), src);
});

t('table rendering survives the full markdown pipeline', () => {
  const html = M.mdToTelegramHtml('| Name | Role |\n|---|---|\n| Ada | eng |');
  ok(!html.includes('---'), `separator reached the phone: ${html}`);
  for (const tag of html.matchAll(/<\/?([a-z-]+)[\s>]/g)) {
    ok(TG_TAGS.has(tag[1]), `unsupported tag <${tag[1]}>`);
  }
});

// ---------- chunks: never split through a tag ----------
const tagBalanced = (s) => !/<[a-z-]*$/i.test(s); // no dangling '<...' at the end

t('chunks never end mid-tag', () => {
  const body = Array.from({ length: 400 }, (_, i) => `<b>line ${i}</b> some filler text here`).join('\n');
  for (const c of M.chunks(body, 4000)) ok(tagBalanced(c), `chunk ends mid-tag: ${JSON.stringify(c.slice(-40))}`);
});

t('chunks respect the size limit', () => {
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  for (const c of M.chunks(body, 4000)) ok(c.length <= 4000, `chunk of ${c.length} exceeds limit`);
});

t('chunks lose no content', () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const rejoined = M.chunks(body, 500).join('\n');
  eq(rejoined.replace(/\s+/g, ' ').trim(), body.replace(/\s+/g, ' ').trim());
});

t('an unbroken run longer than the limit still hard-cuts', () => {
  const parts = M.chunks('z'.repeat(9000), 4000);
  ok(parts.length >= 3, `expected >=3 chunks, got ${parts.length}`);
  for (const c of parts) ok(c.length <= 4000);
});

t('short text stays a single chunk', () => {
  eq(M.chunks('hello', 4000).length, 1);
});

t('empty text yields one empty chunk (never zero)', () => {
  eq(M.chunks('', 4000).length, 1);
});

t('the size limit is the callers, not a module constant', () => {
  // The daemon owns Telegram's ceiling; passing a different one must be honoured,
  // or a caller with a smaller budget (rich blocks, a caption) silently overflows.
  for (const c of M.chunks('word '.repeat(500), 120)) ok(c.length <= 120, `chunk of ${c.length} ignored the limit`);
  eq(M.chunks('a'.repeat(10), 5).every((c) => c.length <= 5), true);
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('✅ md-format render tests pass');
