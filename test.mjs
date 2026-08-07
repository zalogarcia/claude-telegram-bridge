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
import { fileURLToPath, pathToFileURL } from 'node:url';
// The markdown/HTML layer is a real module now — imported, not sliced. Its own
// assertions live in md-format.test.mjs; what stays here is what still needs
// bridge.mjs source (renderEntry, the lane and edit-rate constants).
import * as MD from './md-format.mjs';
import * as PR from './progress-render.mjs';
import * as UL from './usage-limits.mjs';

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
];
// THINKING_WORDS is an array literal, not a function or single-line const.
const words = src.match(/\nconst THINKING_WORDS = \[[\s\S]*?\];/)[0];

const BRIDGE = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      `const HOME=${JSON.stringify(HOME)};${words}\n${PURE.join('\n')}\n` +
        `export {THINKING_WORDS,archiveUpsert,matchArchive};`,
    )
);
const M = { ...BRIDGE, ...MD, ...PR, ...UL };

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
t('file paths collapse $HOME to ~', () => {
  // <=4 segments stays fully readable — this is the common case and the tail
  // alone ("bridge.mjs") would be ambiguous across repos.
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/my-project/bridge.mjs` }, HOME), '~/src/my-project/bridge.mjs');
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/x.ts` }, HOME), '~/src/x.ts');
});

t('deep paths collapse to the identifying tail', () => {
  eq(M.summarizeToolInput({ file_path: `${HOME}/src/my-project/inbox/photo_301.jpg` }, HOME), '…/inbox/photo_301.jpg');
});

// ---------- markdown -> Telegram HTML ----------
// The shared render/chunk assertions moved to md-format.test.mjs with the
// module. What stays here are the cases the private sibling does not carry.

t('a fence with no language stays a bare <pre>', () => {
  const html = M.mdToTelegramHtml('```\nplain\n```');
  ok(html.includes('<pre>plain</pre>'), `got ${html}`);
});

t('a quote in a link URL cannot break out of href', () => {
  const html = M.mdToTelegramHtml('[l](https://e.com/?q="x)');
  ok(!/href="[^"]*"[^>]*"/.test(html), `href attribute broken out of: ${html}`);
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

// ---------- thinking words (this repo's own list) ----------
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
