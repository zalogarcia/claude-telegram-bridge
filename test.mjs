#!/usr/bin/env node
// Unit tests for bridge.mjs's pure rendering/formatting helpers.
//
// bridge.mjs starts polling on import, so importing it here would boot a SECOND
// daemon against your live bot — two consumers of getUpdates fight over the
// offset, and the duplicate edit traffic is exactly what triggers Telegram's
// per-chat rate limit. Instead we extract the pure functions by source and
// evaluate them in isolation. Nothing here touches the network, the filesystem,
// or Telegram.
//
//   node test.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');

// Extract one top-level declaration by lines, not by regex: bridge.mjs is
// prettier-formatted, so every continuation line of a declaration is indented
// (or blank) and the next column-0 line begins the next declaration. A lazy
// `[\s\S]*?;` stops at the first semicolon INSIDE a multi-line arrow body
// (clip's `const str = String(s);`), which builds unparseable source and kills
// the whole file with a SyntaxError before a single test runs — invisible,
// because a dead harness reports no failures.
const SRC_LINES = src.split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC_LINES.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs — did it get renamed?`);
  const out = [SRC_LINES[start]];
  for (let i = start + 1; i < SRC_LINES.length; i++) {
    const l = SRC_LINES[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}')) out.push(l); // the declaration's own closing brace
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

const PURE = [
  // Dependency of archiveUpsert — extracted, not mirrored, so a cap change in
  // bridge.mjs can't leave these tests green against a stale value.
  src.match(/const ARCHIVE_CAP = \d+;/)[0],
  grab('archiveUpsert'),
  grab('matchArchive'),
  grab('fmtAge'),
  grab('fmtElapsed'),
  grab('fmtLeft'),
  grab('fmtLimit'),
  grab('escHtml', 'const'),
  grab('clip', 'const'),
  grab('quoteBlock', 'const'),
  grab('thinkingWord', 'const'),
  grab('prettyPath'),
  grab('summarizeToolInput'),
  grab('renderEntry'),
  grab('renderTail'),
  // renderMdTables + its own helpers — dependencies of mdToTelegramHtml.
  grab('TABLE_SEP', 'const'),
  grab('isTableRow', 'const'),
  grab('splitCells', 'const'),
  grab('renderMdTables'),
  grab('mdToTelegramHtml'),
  grab('chunks'),
];
// THINKING_WORDS is an array literal, not a function or single-line const.
const words = src.match(/\nconst THINKING_WORDS = \[[\s\S]*?\];/)[0];

const M = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      `const HOME=${JSON.stringify(HOME)};${words}\n${PURE.join('\n')}\n` +
        `export {escHtml,clip,quoteBlock,thinkingWord,prettyPath,summarizeToolInput,renderEntry,renderTail,mdToTelegramHtml,chunks,THINKING_WORDS,archiveUpsert,matchArchive,fmtAge,fmtElapsed,fmtLeft,fmtLimit};`,
    )
);

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

// ---------- summarizeToolInput: description beats raw payload ----------
t('Bash prefers description over the raw command', () => {
  const arg = M.summarizeToolInput({
    command: 'echo "=== branch ==="; git -C $B branch --show-current 2>&1 | head',
    description: 'Check bridge git state',
  });
  eq(arg, 'Check bridge git state');
});

t('Bash without a description falls back to the command', () => {
  eq(M.summarizeToolInput({ command: 'ls -la' }), 'ls -la');
});

t('Agent prompt never leaks (description wins)', () => {
  const arg = M.summarizeToolInput({ prompt: 'x'.repeat(5000), description: 'Audit the repo' });
  eq(arg, 'Audit the repo');
});

t('file paths collapse $HOME to ~', () => {
  // <=4 segments stays fully readable — this is the common case and the tail
  // alone ("bridge.mjs") would be ambiguous across repos.
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/my-project/bridge.mjs` }), '~/src/my-project/bridge.mjs');
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/x.ts` }), '~/src/x.ts');
});

t('deep paths collapse to the identifying tail', () => {
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/my-project/inbox/photo_301.jpg` }), '…/inbox/photo_301.jpg');
});

t('paths outside $HOME are left intact', () => {
  eq(M.summarizeToolInput({ file_path: '/tmp/x.log' }), '/tmp/x.log');
});

t('every summary respects the 70-char budget', () => {
  const long = M.summarizeToolInput({ command: 'a'.repeat(500) });
  ok(long.length <= 70, `got ${long.length} chars`);
  ok(long.endsWith('…'), 'long values should be visibly truncated');
});

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

t('a fence with no language stays a bare <pre>', () => {
  const html = M.mdToTelegramHtml('```\nplain\n```');
  ok(html.includes('<pre>plain</pre>'), `got ${html}`);
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

t('a quote in a link URL cannot break out of href', () => {
  const html = M.mdToTelegramHtml('[l](https://e.com/?q="x)');
  ok(!/href="[^"]*"[^>]*"/.test(html), `href attribute broken out of: ${html}`);
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

t('an unclosed "<" at a window boundary cannot stall the loop', () => {
  // Backing the cut up to an unclosed '<' at index 0 used to yield cut===0:
  // an empty chunk, `rest` unchanged, and a synchronous infinite loop that
  // freezes the daemon. If this test ever hangs instead of failing, that is
  // the regression.
  const body = '<' + ('b'.repeat(100) + '\n').repeat(80);
  const parts = M.chunks(body, 4000);
  ok(parts.length >= 2, `expected a split, got ${parts.length}`);
  for (const c of parts) ok(c.length <= 4000, `chunk of ${c.length} exceeds limit`);
  ok(
    parts.every((c) => c.length > 0),
    'no chunk may be empty — an empty chunk means the loop is not advancing',
  );
});

// ---------- progress rendering ----------
t('tool args are not wrapped in <code> (illegal inside blockquote)', () => {
  const line = M.renderEntry({ kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: 'do a thing' }, true);
  ok(!line.includes('<code>'), 'code entities may not nest inside blockquote');
  ok(line.includes('<b>Bash</b>'), 'tool name should be bold');
});

t('subagent steps are indented', () => {
  const line = M.renderEntry({ kind: 'tool', sub: true, emoji: '💻', name: 'Bash', arg: 'x' }, false);
  ok(line.startsWith('  ↳ '), `got ${JSON.stringify(line)}`);
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

// ---------- thinking words ----------
t('thinking words cycle without going out of bounds', () => {
  for (const i of [0, 5, 17, 18, 999]) ok(typeof M.thinkingWord(i) === 'string' && M.thinkingWord(i).length > 0);
});

t('the word pool is large enough to avoid quick repeats', () => {
  ok(M.THINKING_WORDS.length >= 12, `only ${M.THINKING_WORDS.length} words`);
  eq(new Set(M.THINKING_WORDS).size, M.THINKING_WORDS.length, 'duplicate words in the pool');
});

// ---------- chat registry helpers ----------
t('archiveUpsert creates and merges entries', () => {
  let a = M.archiveUpsert(undefined, 'aaaa', { at: 1, cwd: '/x' });
  a = M.archiveUpsert(a, 'aaaa', { name: 'deals' });
  eq(a.aaaa.name, 'deals');
  eq(a.aaaa.cwd, '/x', 'merge must keep earlier fields');
});

t('archiveUpsert caps at 60, evicting oldest unnamed first', () => {
  let a = {};
  for (let i = 0; i < 60; i++) a = M.archiveUpsert(a, `id${i}`, { at: i });
  a = M.archiveUpsert(a, 'named', { at: 0, name: 'keep-me' }); // oldest but named
  a = M.archiveUpsert(a, 'newest', { at: 999 });
  ok(Object.keys(a).length <= 60, `cap failed: ${Object.keys(a).length}`);
  ok(a.named, 'named entry evicted before unnamed');
  ok(!a.id0 || !a.id1, 'no unnamed entry was evicted');
});

t('matchArchive resolves exact name, name prefix, id prefix', () => {
  const a = {
    'abcd1234-x': { name: 'sales' },
    'efgh5678-x': { name: 'salesfunnel' },
    'zzzz9999-x': {},
  };
  eq(M.matchArchive(a, 'sales').id, 'abcd1234-x', 'exact name beats prefix clash');
  eq(M.matchArchive(a, 'salesf').id, 'efgh5678-x', 'unique name prefix');
  eq(M.matchArchive(a, 'zzzz').id, 'zzzz9999-x', 'id prefix');
  ok(M.matchArchive(a, 'nope').error, 'miss must error');
  ok(M.matchArchive(a, 'zz').error, 'id prefix under 4 chars must not match');
});

t('fmtAge picks sensible units', () => {
  eq(M.fmtAge(5 * 60000), '5m');
  eq(M.fmtAge(3 * 3600000), '3h');
  eq(M.fmtAge(5 * 86400000), '5d');
});

// ---------- plan-limit rendering for /context ----------
// resets_at arrives as absolute epoch SECONDS (that's what a statusline script
// subtracts `date +%s` from); reading it as ms would print "now" forever.
const inSec = (s) => Math.floor(Date.now() / 1000) + s;

t('fmtLeft matches the footer units: h+m short, d+h long', () => {
  eq(M.fmtLeft(inSec(3 * 3600 + 49 * 60)), '3h 49m');
  eq(M.fmtLeft(inSec(42 * 60)), '42m');
  eq(M.fmtLeft(inSec(2 * 86400 + 4 * 3600)), '2d 4h');
});

t('fmtLeft never shows a negative clock', () => {
  eq(M.fmtLeft(inSec(-3600)), 'now');
  eq(M.fmtLeft(inSec(0)), 'now');
});

t('fmtLeft rejects millisecond input instead of silently printing "now"', () => {
  ok(M.fmtLeft(Date.now() + 3600_000) !== 'now', 'ms input must not read as expired');
});

t('fmtLimit renders "% used · time left"', () => {
  eq(M.fmtLimit({ used_percentage: 37.4, resets_at: inSec(3 * 3600 + 49 * 60) }), '37% used · 3h 49m left');
});

t('fmtLimit degrades instead of printing "undefined%"', () => {
  eq(M.fmtLimit(null), null);
  eq(M.fmtLimit({}), null);
  eq(M.fmtLimit({ used_percentage: 0, resets_at: inSec(600) }), '0% used · 10m left');
  eq(M.fmtLimit({ resets_at: inSec(600) }), '10m left');
  eq(M.fmtLimit({ used_percentage: 88 }), '88% used');
});

t('fmtElapsed shows h/m/s at the right scales', () => {
  eq(M.fmtElapsed(45), '45s');
  eq(M.fmtElapsed(379), '6m 19s');
  eq(M.fmtElapsed(360), '6m');
  eq(M.fmtElapsed(4320), '1h 12m');
  eq(M.fmtElapsed(7200), '2h');
});

// ---------- lane timeouts (source-level: the run loop isn't pure) ----------
// A single shared 30m ceiling SIGTERM'd a background video-render job at
// exactly 30:01 with its output already built (2026-07-27). The bg lane exists
// for hour-scale work; these assertions fail if the kill timer ever goes back
// to one constant for every lane.
t('kill timer is per-lane, not the chat constant', () => {
  ok(/const laneTimeoutMs = lane\.timeoutMs \|\| TASK_TIMEOUT_MS/.test(src), 'run loop must read lane.timeoutMs');
  ok(/\}, laneTimeoutMs\);/.test(src), 'setTimeout must fire on the lane timeout');
  ok(!/\}, TASK_TIMEOUT_MS\);/.test(src), 'kill timer must not use the chat constant directly');
});

t('background lanes get an hour-scale ceiling', () => {
  ok(/timeoutMs: BG_TASK_TIMEOUT_MS/.test(src), 'bg lanes must carry the bg timeout');
  ok(/timeoutMs: TASK_TIMEOUT_MS/.test(src), 'main lane must carry the chat timeout');
  // Both ceilings go through conf() like every other tunable, so config.json
  // and BRIDGE_BG_TIMEOUT_MS can override them.
  const m = src.match(/const BG_TASK_TIMEOUT_MS = Number\(conf\('bgTimeoutMs', (\d+) \* 60 \* 60 \* 1000\)\);/);
  ok(m, 'bg timeout must come from conf() and be declared in hours');
  ok(Number(m[1]) >= 4, `bg ceiling must be >= 4h, got ${m?.[1]}h`);
});

// ---------- bg lanes are ephemeral (source-level) ----------
// bg1 used to hold a persistent session; whenever it was idle it took the next
// job and resumed everything it had ever done, reaching 836k tokens / 84% of the
// window in one day. Handoffs are self-contained by contract, so continuity
// bought nothing. These fail if a persistent bg session ever comes back.
t('every bg lane is ephemeral', () => {
  ok(/sessionKey: null, \/\/ null = ephemeral/.test(src), 'bg lanes must declare sessionKey null');
  ok(!/sessionKey: n === 1 \? 'bgSessionId'/.test(src), 'bg1 must not resume a persistent session');
  ok(!/ctxKey: n === 1 \? 'bgContextTokens'/.test(src), 'bg1 must not persist a context gauge');
});

t('stale persistent-bg keys are migrated away', () => {
  ok(/delete st\.bgSessionId;\s*\n\s*delete st\.bgContextTokens;/.test(src), 'chatState must drop legacy bg keys');
});

// ---------- rate-limit budget (the fix this suite exists to protect) ----------
t('the progress tick stays under Telegram’s ~20 edits/min per chat', () => {
  const m = src.match(/const EDIT_INTERVAL_MS = (\d+);/);
  ok(m, 'EDIT_INTERVAL_MS not found');
  const perMin = 60000 / Number(m[1]);
  ok(perMin <= 12, `${perMin} edits/min is too close to the ceiling — raise EDIT_INTERVAL_MS`);
});

t('disposable progress edits never retry into a 429', () => {
  const fn = src.match(/async function editProgress[\s\S]*?\n\}/)[0];
  ok(fn.includes('retry429: false'), 'editProgress must opt out of retries');
  ok(/editCooldownUntil = /.test(fn), 'editProgress must set a cooldown on 429');
});

// ---------- report ----------
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bridge render/format tests pass');
