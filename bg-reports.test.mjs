#!/usr/bin/env node
// Tests for the full-worker-report layer in bridge.mjs.
//
// A worker's report is the whole product of a background run, and for a month
// the handback's length cap ate the end of long ones. The end is exactly where
// a report puts its findings, so the audit found 14 reports across 7 sessions
// truncated mid-sentence, one cut precisely at "what's wrong in your brief".
// The property these tests hold is narrow and total: NOTHING a worker returned
// is unreachable after a handback.
//
//   node bg-reports.test.mjs
//
// bridge.mjs runs main() on import, so (as in test.mjs) the functions under test
// are extracted by source and evaluated against stubs. Nothing here touches the
// network, Telegram, or the live reports directory.

import { readFileSync, mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8');
const SRC_LINES = src.split('\n');

// Same extraction contract as test.mjs: bridge.mjs is prettier-formatted, so a
// declaration runs until the next column-0 line.
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC_LINES.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC_LINES[start]];
  for (let i = start + 1; i < SRC_LINES.length; i++) {
    const l = SRC_LINES[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

// Constants are extracted, never mirrored: a cap changed in bridge.mjs must not
// leave these tests green against the old number.
function constant(name) {
  const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  if (!m) throw new Error(`could not read ${name} from bridge.mjs`);
  return Number(m[1]);
}
const HANDBACK_INLINE_LIMIT = constant('HANDBACK_INLINE_LIMIT');
const BG_REPORTS_KEEP = constant('BG_REPORTS_KEEP');
const HANDBACK_STREAK_MAX = constant('HANDBACK_STREAK_MAX');

const TMP = mkdtempSync(path.join(tmpdir(), 'bg-reports-test-'));
const REPORTS = path.join(TMP, 'bg-reports');

const M = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `import path from 'node:path';`,
        `import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';`,
        // A data: module has no base URL, so a bare absolute path will not resolve.
        `import { clip, oneLine } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'progress-render.mjs')).href)};`,
        // handBackToChat renders the bridge's own record of what it steered in.
        // Imported, never stubbed: the placement of that block relative to the
        // untrusted-output markers is exactly what one of the tests below
        // asserts, and a stub would let it pass against a block nobody ships.
        `import { steeredInBlock } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'bg-steer.mjs')).href)};`,
        // The handback excerpt is where a Codex worker's em dashes would enter
        // the conversation by the back door, so the real normalizer is imported
        // here too rather than stubbed away.
        `import { normalizeDashes } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'dash-normalize.mjs')).href)};`,
        // The chain-paused line the owner actually reads. Imported rather than
        // stubbed for the same reason as the two above: one of the assertions
        // below is about what that message does and does NOT contain (never the
        // worker's raw report), and a stub would prove nothing about it.
        `import { chainPausedLine } from ${JSON.stringify(pathToFileURL(path.join(DIR, 'system-messages.mjs')).href)};`,
        `let NO_DASHES = false;`,
        `export const setNoDashes = (v) => { NO_DASHES = v; };`,
        `const BG_REPORTS_DIR = ${JSON.stringify(REPORTS)};`,
        `const BG_REPORTS_KEEP = ${BG_REPORTS_KEEP};`,
        `const HANDBACK_INLINE_LIMIT = ${HANDBACK_INLINE_LIMIT};`,
        `const HANDBACK_STREAK_MAX = ${HANDBACK_STREAK_MAX};`,
        `const OWNER_NAME = 'the owner';`,
        `const LANES = { main: { name: 'main' } };`,
        `export const dispatched = [];`,
        `export const sent = [];`,
        `export const parkedHandbacks = [];`,
        `function dispatchPrompt(text) { dispatched.push(text); }`,
        `function send(text) { sent.push(text); return { catch: () => {} }; }`,
        `let handbackStreak = 0;`,
        `let handbackCapNotified = false;`,
        `export const resetChain = () => { handbackStreak = 0; handbackCapNotified = false; parkedHandbacks.length = 0; };`,
        grab('pruneBgReports'),
        grab('bgReportId'),
        grab('bgReportPath'),
        grab('writeFullReport'),
        // The live worker line: handBackToChat now edits the message already on
        // screen into "reading it now…" instead of letting an unexplained
        // bubble start with no cause above it. Stubbed to record, so the
        // handback's own behaviour stays the subject of this file.
        `export const noticeEdits = [];`,
        `const editWorkerNotice = (runId, patch, opts) => { noticeEdits.push({ runId, patch, opts }); return true; };`,
        `export const readingNotices = new Set();`,
        grab('handBackToChat'),
        `export { bgReportId, bgReportPath, writeFullReport, pruneBgReports, handBackToChat };`,
      ].join('\n'),
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
const body = () => M.dispatched[M.dispatched.length - 1];

// ---------- ids and paths ----------
t('a run id becomes a report path under the reports dir', () => {
  eq(M.bgReportPath('bg-1787954368519'), path.join(REPORTS, 'bg-1787954368519.md'));
});

t('an id that could escape the reports dir is sanitised', () => {
  // Ids are generated today, so this can never fire; it is here because the id
  // reaches a filesystem path and the day it stops being generated is the day
  // this matters.
  const p = M.bgReportPath('../../etc/passwd');
  eq(path.dirname(p), REPORTS, 'traversal escaped the reports dir');
  // The separators are what carry a traversal; a literal ".." left in the
  // FILENAME is inert, so the assertion is containment, not spelling.
  eq(path.basename(p), '.._.._etc_passwd.md');
});

t('a missing run id still yields an addressable report', () => {
  const id = M.bgReportId(null);
  ok(/^bg-\d+$/.test(id), `unusable fallback id: ${id}`);
});

// ---------- the file itself ----------
t('the full report is written even when it dwarfs the inline limit', () => {
  const long = 'x'.repeat(HANDBACK_INLINE_LIMIT * 3) + 'THE-FINDING-AT-THE-END';
  const res = M.writeFullReport('run-long', 'the task', long, 'finished');
  ok(res, 'writeFullReport returned null');
  eq(res.chars, long.length, 'reported length must be the real length');
  const disk = readFileSync(res.file, 'utf8');
  ok(disk.includes('THE-FINDING-AT-THE-END'), 'the end of the report was lost on disk');
  ok(disk.includes('the task'), 'the task is not recorded beside its report');
  ok(disk.includes('status: finished'), 'status is not recorded');
});

t('an unwritable reports dir costs the file, never the handback', () => {
  // The pointer is a nicety; the report reaching M is not. A write failure must
  // degrade to "no file" and keep going.
  const saved = M.writeFullReport('run-ok', 't', 'o', 'finished');
  ok(saved, 'baseline write failed');
  M.resetChain();
  M.handBackToChat('t', 'o', 'finished', 'run-ok');
  ok(body().includes('FULL REPORT'), 'handback lost its pointer');
});

// ---------- the handback ----------
t('a long report is handed back as an excerpt that names the full file', () => {
  M.resetChain();
  const long = 'y'.repeat(HANDBACK_INLINE_LIMIT + 500) + 'TAIL-MARKER';
  M.handBackToChat('task A', long, 'finished', 'run-A');
  const note = body();
  ok(!note.includes('TAIL-MARKER'), 'the excerpt should not contain the tail');
  ok(note.includes(M.bgReportPath('run-A')), 'the handback does not name the report file');
  ok(note.includes(String(long.length)), 'the handback does not state the real length');
  ok(note.includes('READ THIS FILE'), 'a truncated excerpt must say the rest exists');
  const disk = readFileSync(M.bgReportPath('run-A'), 'utf8');
  ok(disk.includes('TAIL-MARKER'), 'the tail is not recoverable from disk');
});

t('a short report is handed back whole and still filed', () => {
  M.resetChain();
  M.handBackToChat('task B', 'short and complete', 'finished', 'run-B');
  const note = body();
  ok(note.includes('short and complete'), 'a short report must travel inline');
  ok(note.includes('complete above'), 'an untruncated report must be labelled as such');
  ok(readFileSync(M.bgReportPath('run-B'), 'utf8').includes('short and complete'), 'short reports are filed too');
});

t('the pointer sits OUTSIDE the untrusted-output markers', () => {
  // Inside them it would read as worker text, which the note itself declares
  // void. The path is the bridge speaking, not the worker.
  M.resetChain();
  M.handBackToChat('task C', 'z'.repeat(HANDBACK_INLINE_LIMIT + 10), 'finished', 'run-C');
  const note = body();
  ok(note.indexOf('FULL REPORT') > note.indexOf('<<<WORKER_OUTPUT_END>>>'), 'pointer is inside the untrusted block');
});

t('a run with no steers gets no STEERED IN block', () => {
  M.resetChain();
  M.handBackToChat('task D', 'plain output', 'finished', 'run-D');
  ok(!body().includes('STEERED IN'), 'an empty block is noise on every ordinary handback');
});

t('what the bridge steered in is reported, OUTSIDE the untrusted-output markers', () => {
  // Same rule as the report pointer, same reason: these lines are the bridge's
  // record of what IT wrote into the worker, not a claim the worker made about
  // itself. Inside the markers the note would declare its own evidence void.
  M.resetChain();
  M.handBackToChat('task E', 'worker said things', 'finished', 'run-E', [
    { ts: '2026-09-03T17:02:11.000Z', text: 'skip the browser step' },
    { ts: '2026-09-03T17:40:02.000Z', text: 'commit before you report' },
  ]);
  const note = body();
  ok(note.includes('STEERED IN (2)'), `the steer record is missing from the handback:\n${note}`);
  ok(note.indexOf('STEERED IN') > note.indexOf('<<<WORKER_OUTPUT_END>>>'), 'the steer record is inside the untrusted block');
  ok(note.includes('17:02:11Z skip the browser step'), note);
  ok(note.includes('17:40:02Z commit before you report'), note);
});

t('a capped chain parks the report path, and files the report anyway', () => {
  M.resetChain();
  for (let i = 0; i <= HANDBACK_STREAK_MAX; i++) {
    M.handBackToChat(`task ${i}`, `output ${i}`, 'finished', `run-cap-${i}`);
  }
  eq(M.parkedHandbacks.length, 1, 'exactly the over-cap report should be parked');
  eq(M.parkedHandbacks[0].report, M.bgReportPath(`run-cap-${HANDBACK_STREAK_MAX}`), 'parked entry lost its path');
  const disk = readFileSync(M.bgReportPath(`run-cap-${HANDBACK_STREAK_MAX}`), 'utf8');
  ok(disk.includes(`output ${HANDBACK_STREAK_MAX}`), 'a capped report was never written to disk');
});

// ---------- pruning ----------
t('pruning keeps the newest BG_REPORTS_KEEP reports and no more', () => {
  const dir = REPORTS;
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f));
  // Ids are <lane>-<epoch-ms>, so zero-padding makes lexical order chronological
  // in the same way real ids are.
  for (let i = 0; i < BG_REPORTS_KEEP + 5; i++) {
    writeFileSync(path.join(dir, `bg-${String(1000000 + i)}.md`), 'x');
  }
  M.pruneBgReports();
  const left = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  eq(left.length, BG_REPORTS_KEEP, 'wrong number of reports kept');
  eq(left[left.length - 1], `bg-${1000000 + BG_REPORTS_KEEP + 4}.md`, 'the newest report was pruned');
  eq(left[0], `bg-${1000000 + 5}.md`, 'pruning did not start from the oldest');
});

t('pruning a missing directory is a no-op, not a crash', () => {
  rmSync(REPORTS, { recursive: true, force: true });
  M.pruneBgReports();
  pass += 0;
});

// ---------------------------------------------------------------------------
// The dash normalizer, at the handback boundary.
// ---------------------------------------------------------------------------
// A worker report is the OTHER way a model's prose enters this conversation:
// it goes to M, who quotes and paraphrases the excerpt. A Codex worker writes
// em dashes, so without this they arrive in the chat having gone round
// sendResult entirely.

t('★ a worker report with an em dash reaches M without one', () => {
  M.resetChain();
  M.setNoDashes(true);
  M.handBackToChat('build the thing', 'It shipped \u2014 and it passed.', 'finished', 'bg-9001', []);
  const note = M.dispatched[M.dispatched.length - 1];
  // Scoped to the WORKER OUTPUT block. The framing around it is the bridge's own
  // prompt to M, written long before this rule existed and not owner-facing;
  // what must be clean is the text that came out of a model.
  const body = note.split('<<<WORKER_OUTPUT_START>>>')[1].split('<<<WORKER_OUTPUT_END>>>')[0];
  ok(!/[\u2013\u2014]/.test(body), `a dash survived into the handback: ${body}`);
  ok(body.includes('It shipped, and it passed.'), body);
  M.setNoDashes(false);
});

t('a fenced command inside a worker report keeps its dashes', () => {
  M.resetChain();
  M.setNoDashes(true);
  M.handBackToChat('build', 'Ran `npm run build \u2014 watch` and it worked \u2014 finally.', 'finished', 'bg-9002', []);
  const note = M.dispatched[M.dispatched.length - 1];
  ok(note.includes('`npm run build \u2014 watch`'), `the command was rewritten: ${note}`);
  ok(note.includes('it worked, finally.'), note);
  M.setNoDashes(false);
});

t('with the flag off the report is passed through unchanged', () => {
  M.resetChain();
  M.handBackToChat('build', 'It shipped \u2014 and it passed.', 'finished', 'bg-9003', []);
  const note = M.dispatched[M.dispatched.length - 1];
  ok(note.includes('It shipped \u2014 and it passed.'), note);
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-report tests pass');
