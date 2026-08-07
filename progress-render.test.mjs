#!/usr/bin/env node
// Tests for progress-render.mjs — the progress-bubble rendering layer.
//
// SHARED TEST — byte-identical in the public and private bridge repos, like the
// module it covers. Fixtures use a synthetic home directory rather than the
// real one, so nothing here depends on whose machine it runs on. Assertions
// about a repo's OWN thinking-word list live in that repo's test.mjs, because
// the list is deliberately not shared.
//
//   node progress-render.test.mjs

import {
  clip,
  oneLine,
  prettyPath,
  summarizeToolInput,
  toolEntry,
  renderEntry,
  renderTail,
  quoteBlock,
  thinkingWord,
  fmtElapsed,
  fmtAge,
  TOOL_EMOJI,
  DEFAULT_THINKING_WORDS,
} from './progress-render.mjs';

const M = {
  clip, oneLine, prettyPath, summarizeToolInput, toolEntry, renderEntry,
  renderTail, quoteBlock, thinkingWord, fmtElapsed, fmtAge, TOOL_EMOJI,
  DEFAULT_THINKING_WORDS,
};

// A stand-in home. The daemon passes its own; nothing in the module may assume
// this shape, which is exactly what these fixtures prove.
const HOME = '/home/testuser';

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

// ---------- summarizeToolInput: description beats raw payload ----------
t('Bash prefers description over the raw command', () => {
  const out = M.summarizeToolInput({
    command: 'echo "=== BANNER ===" && npm run build 2>&1 | tail -40',
    description: 'Build the app',
  }, HOME);
  eq(out, 'Build the app');
});

t('Bash without a description falls back to the command', () => {
  eq(M.summarizeToolInput({ command: 'npm test' }, HOME), 'npm test');
});

t('Agent prompt never leaks (description wins)', () => {
  const out = M.summarizeToolInput({ prompt: 'x'.repeat(5000), description: 'Audit the checkout flow' }, HOME);
  eq(out, 'Audit the checkout flow');
});

t('paths outside $HOME are left intact', () => {
  eq(M.summarizeToolInput({ file_path: '/tmp/x.log' }, HOME), '/tmp/x.log');
});

t('every summary respects the 70-char budget', () => {
  const long = M.summarizeToolInput({ command: 'a'.repeat(500) }, HOME);
  ok(long.length <= 70, `got ${long.length} chars`);
  ok(long.endsWith('…'), 'long values should be visibly truncated');
});

// ---------- prettyPath: the home directory is injected, never read ----------
t('prettyPath collapses the injected home to ~', () => {
  eq(M.prettyPath(`${HOME}/src/x.ts`, HOME), '~/src/x.ts');
});

t('prettyPath keeps the identifying tail of a deep path', () => {
  eq(M.prettyPath(`${HOME}/src/proj/inbox/photo.jpg`, HOME), '…/inbox/photo.jpg');
});

t('prettyPath honours a DIFFERENT home — the value is not baked in', () => {
  eq(M.prettyPath('/opt/alice/notes.md', '/opt/alice'), '~/notes.md');
  eq(M.prettyPath('/opt/alice/notes.md', '/opt/bob'), '/opt/alice/notes.md');
});

t('prettyPath with no home does not treat every path as home-relative', () => {
  // ''.startsWith('') is true, so a naive guard would prefix EVERY path with ~.
  eq(M.prettyPath('/tmp/x.log'), '/tmp/x.log');
});

// ---------- clip / oneLine ----------
t('clip marks every cut with an ellipsis', () => {
  ok(M.clip('a'.repeat(100), 20).endsWith('…'), 'a clipped string with no marker reads as lost in transit');
  ok(M.clip('a'.repeat(100), 20).length <= 20);
});

t('clip leaves a short string completely alone', () => {
  eq(M.clip('short', 20), 'short');
});

t('clip prefers a word boundary when one is close to the limit', () => {
  eq(M.clip('hello beautiful world', 18), 'hello beautiful…');
});

t('oneLine collapses newlines and runs of spaces', () => {
  eq(M.oneLine('a\n\n  b\tc   d '), 'a b c d');
});

// ---------- toolEntry ----------
t('toolEntry gives an agent its own shape and the subagent type as the name', () => {
  const e = M.toolEntry({ name: 'Task', input: { subagent_type: 'qa-agent', description: 'audit' } }, false, HOME);
  eq(e, { kind: 'tool', sub: false, emoji: '🤖', name: 'qa-agent', arg: 'audit' });
});

t('toolEntry falls back to a generic emoji for an unknown tool', () => {
  eq(M.toolEntry({ name: 'Frobnicate', input: {} }, false, HOME).emoji, '🔧');
});

t('toolEntry threads the home through to the path summary', () => {
  eq(M.toolEntry({ name: 'Read', input: { file_path: `${HOME}/src/x.ts` } }, false, HOME).arg, '~/src/x.ts');
});

t('every known tool has an emoji', () => {
  for (const [name, emoji] of Object.entries(M.TOOL_EMOJI)) ok(emoji.length > 0, `${name} has no emoji`);
});

// ---------- renderEntry / renderTail ----------
t('tool args are not wrapped in <code> (illegal inside blockquote)', () => {
  const line = M.renderEntry({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: 'do a thing' }, true);
  ok(!line.includes('<code>'), 'code entities may not nest inside blockquote');
  ok(line.includes('<b>Bash</b>'), 'tool name should be bold');
});

t('narration is clipped and italicised', () => {
  const line = M.renderEntry({ kind: 'text', text: 'w '.repeat(400) }, true);
  ok(line.startsWith('<i>') && line.endsWith('</i>'));
  ok(line.length < 200, `narration not clipped: ${line.length} chars`);
});

t('narration with HTML metacharacters is escaped', () => {
  const line = M.renderEntry({ kind: 'text', text: 'a < b & c' }, true);
  ok(line.includes('&lt;') && line.includes('&amp;'), `unescaped: ${line}`);
});

t('a tool name and arg are escaped in the HTML branch', () => {
  const line = M.renderEntry({ kind: 'tool', sub: false, emoji: '🔧', name: 'X<y>', arg: 'a&b' }, true);
  ok(!/[<>]/.test(line.replace(/<\/?[bi]>/g, '')), `raw markup would break the parse: ${line}`);
});

t('subagent steps are indented', () => {
  const line = M.renderEntry({ kind: 'tool', sub: true, emoji: '💻', name: 'Bash', arg: 'x' }, false);
  ok(line.startsWith('  ↳ '), `got ${JSON.stringify(line)}`);
});

t('the plain branch emits no markup at all', () => {
  const line = M.renderEntry({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: 'a&b' }, false);
  ok(!line.includes('<') && !line.includes('&amp;'), `plain fallback must stay plain: ${line}`);
});

t('quoteBlock wraps in an expandable blockquote', () => {
  eq(M.quoteBlock('x'), '\n<blockquote expandable>x</blockquote>');
});

t('quoteBlock stays empty for empty input (no stray tags)', () => {
  eq(M.quoteBlock(''), '');
});

t('renderTail honours its character budget', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: `step ${i}` }));
  ok(M.renderTail(entries, true, 500).length <= 500);
});

t('renderTail keeps the NEWEST entries', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: `step${i}` }));
  ok(M.renderTail(entries, false, 300).includes('step49'), 'the most recent step must survive');
});

t('renderTail never emits a partial line to fill its budget', () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: `step${i}` }));
  const lines = M.renderTail(entries, false, 120).split('\n').filter(Boolean);
  for (const l of lines) ok(/step\d+$/.test(l), `line was cut mid-entry: ${JSON.stringify(l)}`);
});

// ---------- thinking words ----------
t('thinking words cycle without going out of bounds', () => {
  for (const i of [0, 5, 17, 18, 999]) ok(typeof M.thinkingWord(i) === 'string' && M.thinkingWord(i).length > 0);
});

t('thinkingWord cycles over a CALLER-supplied list, not a baked-in one', () => {
  const words = ['Alpha', 'Beta', 'Gamma'];
  eq([0, 1, 2, 3, 4].map((i) => M.thinkingWord(i, words)), ['Alpha', 'Beta', 'Gamma', 'Alpha', 'Beta']);
});

t('the default pool is usable on its own', () => {
  ok(M.DEFAULT_THINKING_WORDS.length >= 8, `only ${M.DEFAULT_THINKING_WORDS.length} words`);
  eq(new Set(M.DEFAULT_THINKING_WORDS).size, M.DEFAULT_THINKING_WORDS.length, 'duplicate words in the default pool');
});

t('an empty word list degrades to no word instead of crashing the ticker', () => {
  eq(M.thinkingWord(3, []), '');
});

// ---------- elapsed / age ----------
t('fmtElapsed shows h/m/s at the right scales', () => {
  eq(M.fmtElapsed(45), '45s');
  eq(M.fmtElapsed(379), '6m 19s');
  eq(M.fmtElapsed(360), '6m');
  eq(M.fmtElapsed(4320), '1h 12m');
  eq(M.fmtElapsed(7200), '2h');
});

t('fmtAge picks sensible units', () => {
  eq(M.fmtAge(5 * 60000), '5m');
  eq(M.fmtAge(3 * 3600000), '3h');
  eq(M.fmtAge(5 * 86400000), '5d');
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('✅ progress-render tests pass');
