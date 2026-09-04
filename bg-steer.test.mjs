#!/usr/bin/env node
// Tests for bg-steer.mjs, target resolution, framing, validation, rendering.
//
// These are the parts of mid-run background steering that can be wrong in a way
// no smoke test would catch: a resolver that matches the CHAT lane would write
// the owner's conversation lane full of orchestrator instructions, and one that falls
// back to "the first worker" on an ambiguous target would steer the wrong job.
// bridge.mjs cannot be imported (it boots the daemon on import), so everything
// worth asserting lives in the module and is asserted here.
//
//   node bg-steer.test.mjs

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REASONS,
  STEER_ECHO_MAX,
  STEER_HEADER,
  STEER_RECORD_MAX,
  STEER_SOCK_NAME,
  TARGET_SHAPE,
  decodeLine,
  encodeLine,
  looksLikeTarget,
  psTable,
  resolveSteerTarget,
  steerAckLine,
  steerFailure,
  steerFraming,
  steerResponse,
  steeredInBlock,
  validateRequest,
} from './bg-steer.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

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
  if (!cond) throw new Error(msg || 'expected truthy');
};

// A realistic pool: two live workers plus one that outlived a previous daemon
// (re-attached, so we hold no stdin pipe to it) and the chat lane.
const W1 = {
  runId: 'bg-1788453512237',
  watchdogId: 'bg-1788453512237-83808',
  lane: 'bg',
  pid: 83808,
  startedAt: 1788453512237,
  elapsedSec: 640,
  steps: 41,
  steerable: true,
  steers: 0,
  isBg: true,
  running: true,
  title: 'Mid-run steering for background workers',
};
const W2 = {
  runId: 'bg2-1788453999999',
  watchdogId: 'bg2-1788453999999-90210',
  lane: 'bg2',
  pid: 90210,
  startedAt: 1788453999999,
  elapsedSec: 12,
  steps: 1,
  steerable: true,
  steers: 2,
  isBg: true,
  running: true,
  title: 'Competitor ad intel MVP build',
};
const REATTACHED = {
  runId: 'bg3-1788400000000-70001',
  watchdogId: 'bg3-1788400000000-70001',
  lane: 'bg3',
  pid: 70001,
  startedAt: 1788400000000,
  elapsedSec: 9000,
  steps: 0,
  steerable: false, // re-attached: no stdin handle in THIS daemon
  steers: 0,
  isBg: true,
  running: true,
  title: 'survived a daemon restart',
};
const CHAT = { runId: 'main-1788454111111', lane: 'main', pid: 55555, startedAt: 1788454111111, steerable: true, isBg: false, running: true };
const POOL = [W1, W2, REATTACHED, CHAT];

// ---------------------------------------------------------------------------
console.log('\n1. target resolution');
// ---------------------------------------------------------------------------

t('exact run id resolves', () => {
  const r = resolveSteerTarget('bg-1788453512237', POOL);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.lane, 'bg');
});

t('the watchdog id (<lane>-<startedAt>-<pid>) resolves too', () => {
  const r = resolveSteerTarget('bg2-1788453999999-90210', POOL);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.runId, 'bg2-1788453999999');
});

t('a lane name resolves', () => {
  const r = resolveSteerTarget('bg2', POOL);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.pid, 90210);
});

t('a numeric pid resolves', () => {
  const r = resolveSteerTarget('83808', POOL);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.lane, 'bg');
});

t('latest = the most recently STARTED worker, not the first in the list', () => {
  const r = resolveSteerTarget('latest', POOL);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.runId, 'bg2-1788453999999');
});

t('latest ignores order in the input array', () => {
  const r = resolveSteerTarget('latest', [W2, REATTACHED, W1]);
  eq(r.worker.runId, 'bg2-1788453999999');
});

t('★ the CHAT lane is never a target (its own id)', () => {
  const r = resolveSteerTarget('main-1788454111111', POOL);
  eq(r.ok, false);
  eq(r.reason, REASONS.NO_MATCH);
});

t('★ the CHAT lane is never a target (its lane name, its pid, or latest)', () => {
  eq(resolveSteerTarget('main', POOL).reason, REASONS.NO_MATCH);
  eq(resolveSteerTarget('55555', POOL).reason, REASONS.NO_MATCH);
  // The chat lane started LAST; `latest` must still pick a background worker.
  eq(resolveSteerTarget('latest', POOL).worker.isBg, true);
});

t('a chat-only pool has nothing to steer', () => {
  const r = resolveSteerTarget('latest', [CHAT]);
  eq(r.ok, false);
  eq(r.reason, REASONS.NO_MATCH);
});

t('a finished run is excluded', () => {
  const done = { ...W1, running: false };
  eq(resolveSteerTarget('bg-1788453512237', [done]).reason, REASONS.NO_MATCH);
  eq(resolveSteerTarget('latest', [done]).reason, REASONS.NO_MATCH);
});

t('an empty pool is no_running_worker_matches, never a throw', () => {
  eq(resolveSteerTarget('latest', []).reason, REASONS.NO_MATCH);
  eq(resolveSteerTarget('bg', undefined).reason, REASONS.NO_MATCH);
});

t('an unknown target is no_running_worker_matches', () => {
  eq(resolveSteerTarget('bg9', POOL).reason, REASONS.NO_MATCH);
  eq(resolveSteerTarget('12345', POOL).reason, REASONS.NO_MATCH);
});

t('an empty target is invalid_request, not a match', () => {
  eq(resolveSteerTarget('', POOL).reason, REASONS.INVALID);
  eq(resolveSteerTarget('   ', POOL).reason, REASONS.INVALID);
  eq(resolveSteerTarget(null, POOL).reason, REASONS.INVALID);
});

t('★ a re-attached worker matches but reports not_steerable (not "no such worker")', () => {
  const r = resolveSteerTarget('bg3', POOL);
  eq(r.ok, false);
  eq(r.reason, REASONS.NOT_STEERABLE);
  eq(r.pid, 70001);
  eq(r.runId, 'bg3-1788400000000-70001');
});

t('a worker whose result is already in reports not_steerable', () => {
  const finishing = { ...W1, steerable: false };
  eq(resolveSteerTarget('bg', [finishing]).reason, REASONS.NOT_STEERABLE);
});

t('★ two workers sharing a lane name is refused, never resolved to the first', () => {
  const twin = { ...W2, lane: 'bg', runId: 'bg-1788453999999' };
  const r = resolveSteerTarget('bg', [W1, twin]);
  eq(r.ok, false);
  eq(r.reason, REASONS.AMBIGUOUS);
  eq(r.candidates.length, 2);
  ok(r.candidates.includes('bg-1788453512237'), 'candidates must name the runIds');
});

t('precedence: a run id wins over a lane name that spells the same string', () => {
  // Pathological but decidable: one worker whose LANE is literally another
  // worker's run id. The more specific tier must win.
  const odd = { ...W2, lane: 'bg-1788453512237' };
  const r = resolveSteerTarget('bg-1788453512237', [W1, odd]);
  ok(r.ok, JSON.stringify(r));
  eq(r.worker.pid, 83808);
});

// ---------------------------------------------------------------------------
console.log('\n2. framing, what the worker actually reads');
// ---------------------------------------------------------------------------

t('the framed message names itself a steer and keeps the text verbatim', () => {
  const out = steerFraming('Use the admin account, not a fresh signup.');
  ok(out.startsWith('[STEER from the orchestrator'), out.slice(0, 40));
  ok(out.endsWith('Use the admin account, not a fresh signup.'), 'text must be the last thing it reads');
  ok(out.includes('\n\n'), 'the header must be its own paragraph');
});

t('the framing says it does NOT replace the brief', () => {
  ok(/does not replace your brief/i.test(STEER_HEADER), 'a worker will otherwise abandon its brief');
  ok(/not a new task/i.test(STEER_HEADER));
});

t('the framing demands the steer back in the report', () => {
  ok(/Steered in/.test(STEER_HEADER), 'the report must echo the steer');
});

t('framing trims the payload but never the header', () => {
  const out = steerFraming('   spaced   ');
  ok(out.endsWith('spaced'), out.slice(-20));
  ok(out.startsWith(STEER_HEADER));
});

t('framing survives backticks, quotes and newlines', () => {
  const raw = "run `npm test` on [a, b]\nthen report the owner's numbers";
  ok(steerFraming(raw).endsWith(raw));
});

// ---------------------------------------------------------------------------
console.log('\n3. request validation and wire framing');
// ---------------------------------------------------------------------------

t('a well-formed steer validates and is normalized', () => {
  const v = validateRequest({ op: 'steer', target: ' bg2 ', text: '  do X  ' });
  ok(v.ok);
  eq(v.target, 'bg2');
  eq(v.text, 'do X');
});

t('ps needs nothing else', () => {
  const v = validateRequest({ op: 'ps' });
  ok(v.ok);
  eq(v.op, 'ps');
});

t('missing text is refused (an empty steer costs the worker a whole turn)', () => {
  eq(validateRequest({ op: 'steer', target: 'bg' }).reason, REASONS.INVALID);
  eq(validateRequest({ op: 'steer', target: 'bg', text: '   ' }).reason, REASONS.INVALID);
});

t('missing or empty target is refused', () => {
  eq(validateRequest({ op: 'steer', text: 'hi' }).reason, REASONS.INVALID);
  eq(validateRequest({ op: 'steer', target: '  ', text: 'hi' }).reason, REASONS.INVALID);
});

t('missing op is refused; an unknown op is named as such', () => {
  eq(validateRequest({}).reason, REASONS.INVALID);
  eq(validateRequest({ op: 'kill', target: 'bg' }).reason, REASONS.UNKNOWN_OP);
});

t('a request round-trips through the wire framing', () => {
  const line = encodeLine({ op: 'steer', target: 'latest', text: 'ok' });
  ok(line.endsWith('\n'), 'newline-delimited');
  const d = decodeLine(line.trim());
  ok(d.ok);
  eq(d.value.target, 'latest');
});

t('garbage on the socket is a reason, not a crash', () => {
  eq(decodeLine('{{{').reason, REASONS.INVALID);
  eq(decodeLine('').reason, REASONS.INVALID);
  eq(decodeLine('[1,2]').reason, REASONS.INVALID);
  eq(decodeLine('"a string"').reason, REASONS.INVALID);
});

// ---------------------------------------------------------------------------
console.log('\n4. response shapes and the one-line ack');
// ---------------------------------------------------------------------------

t('a delivered steer answers with runId, lane, pid and deliveredAt', () => {
  const res = steerResponse(W1, '2026-09-03T17:02:11.500Z');
  eq(res.ok, true);
  eq(res.runId, 'bg-1788453512237');
  eq(res.lane, 'bg');
  eq(res.pid, 83808);
  eq(res.deliveredAt, '2026-09-03T17:02:11.500Z');
});

t('the ack is one line naming lane, run id, pid and the second it landed', () => {
  const res = steerResponse(W1, '2026-09-03T17:02:11.500Z');
  eq(res.ack, 'steered into bg (bg-1788453512237, pid 83808) at 17:02:11Z');
  ok(!res.ack.includes('\n'), 'the ack must stay one line');
});

t('a failure answers with the reason and an ack that says NOT delivered', () => {
  const res = steerFailure(REASONS.NOT_STEERABLE, { runId: 'bg3-1', lane: 'bg3', pid: 7 });
  eq(res.ok, false);
  eq(res.reason, 'not_steerable');
  // The worker is named: "not_steerable" with three workers running is a
  // question (which one, and was it the one I meant?), not an answer.
  eq(res.ack, 'NOT delivered: not_steerable (bg3-1, lane bg3, pid 7)');
});

t('a failure the daemon could not pin to a worker names no worker', () => {
  eq(steerFailure(REASONS.NO_MATCH, { detail: 'nothing running matches "bg9"' }).ack,
    'NOT delivered: no_running_worker_matches (nothing running matches "bg9")');
});

t('an ambiguous failure lists its candidates in the ack', () => {
  const res = steerFailure(REASONS.AMBIGUOUS, { candidates: ['bg-1', 'bg-2'] });
  eq(res.ack, 'NOT delivered: ambiguous_target (candidates: bg-1, bg-2)');
});

t('a detail is surfaced when there are no candidates', () => {
  eq(steerAckLine({ ok: false, reason: REASONS.NO_MATCH, detail: 'nothing running matches "bg9"' }),
    'NOT delivered: no_running_worker_matches (nothing running matches "bg9")');
});

t('an ack never throws on a malformed response', () => {
  eq(steerAckLine({}), 'NOT delivered: unknown');
  eq(steerAckLine(null), 'NOT delivered: unknown');
  ok(steerAckLine({ ok: true }).startsWith('steered into ?'));
});

// ---------------------------------------------------------------------------
console.log('\n5. ps table');
// ---------------------------------------------------------------------------

t('the table has a header row and one row per worker', () => {
  const out = psTable([W1, W2, REATTACHED]);
  const lines = out.split('\n');
  eq(lines.length, 4);
  ok(/^RUNID\s+LANE\s+PID/.test(lines[0]), lines[0]);
  ok(lines[1].includes('bg-1788453512237'), lines[1]);
});

t('steerable renders yes/no, and the steer count is shown', () => {
  const out = psTable([W2, REATTACHED]);
  ok(/bg2-1788453999999.*yes\s+2/.test(out), out);
  ok(/bg3-1788400000000-70001.*\bno\b/.test(out), out);
});

t('elapsed is human, not raw seconds', () => {
  ok(psTable([{ ...W1, elapsedSec: 41 }]).includes('41s'));
  ok(psTable([{ ...W1, elapsedSec: 640 }]).includes('10m'));
  ok(psTable([{ ...W1, elapsedSec: 9000 }]).includes('2h30'));
});

t('a long title is clipped to 70 and a newline never breaks the table', () => {
  const out = psTable([{ ...W1, title: `${'x'.repeat(200)}\nsecond line` }]);
  eq(out.split('\n').length, 2, out);
  ok(out.includes('…'), 'a clipped title must say so');
});

t('an empty pool says so instead of printing an empty table', () => {
  eq(psTable([]), 'no background workers running');
  eq(psTable(undefined), 'no background workers running');
});

t('the table names the ENGINE, and a record without one is a Claude worker', () => {
  // Every registry record written before the second engine existed has no
  // engine field. Defaulting to claude keeps those readable rather than blank.
  const out = psTable([W1, { ...W2, runId: 'codex-1788453999999', lane: 'codex', engine: 'codex', steerable: false }]);
  ok(/^RUNID\s+LANE\s+PID.*ENGINE\s+TITLE/.test(out.split('\n')[0]), out.split('\n')[0]);
  ok(/bg-1788453512237.*\bclaude\b/.test(out), out);
  ok(/codex-1788453999999.*\bno\b.*\bcodex\b/.test(out), 'a codex row must read: not steerable, engine codex');
});

t('a codex run is refused as NOT steerable, not as missing', () => {
  // isBg true keeps it in the resolver pool on purpose: "codex-… cannot take a
  // steer" is a better answer than "nothing matches that".
  const codexWorker = { runId: 'codex-1788453999999', watchdogId: 'codex-1788453999999-9', lane: 'codex', pid: 9, startedAt: 1788453999999, isBg: true, running: true, steerable: false, engine: 'codex' };
  const r = resolveSteerTarget('codex-1788453999999', [codexWorker]);
  eq(r.ok, false);
  eq(r.reason, REASONS.NOT_STEERABLE);
});

// ---------------------------------------------------------------------------
console.log('\n6. the STEERED IN block in the worker report');
// ---------------------------------------------------------------------------

t('no steers means no block at all', () => {
  eq(steeredInBlock([]), '');
  eq(steeredInBlock(undefined), '');
  eq(steeredInBlock([{ ts: 'x' }]), ''); // no text = nothing was delivered
});

t('the block counts the steers and echoes each one', () => {
  const out = steeredInBlock([
    { ts: '2026-09-03T17:02:11.000Z', text: 'use the admin account' },
    { ts: '2026-09-03T17:40:02.000Z', text: 'skip the browser step' },
  ]);
  ok(out.startsWith('STEERED IN (2)'), out.split('\n')[0]);
  ok(out.includes('17:02:11Z use the admin account'), out);
  ok(out.includes('17:40:02Z skip the browser step'), out);
});

t('each echoed steer is clipped, so a pasted brief cannot flood the report', () => {
  const out = steeredInBlock([{ ts: '2026-09-03T17:02:11.000Z', text: 'y'.repeat(5000) }]);
  const echoed = out.split('\n').filter((l) => l.trim().startsWith('•')).join('\n');
  ok(echoed.length < 400, `echoed line is ${echoed.length} chars`);
  ok(out.includes('…'));
});

t('★ the block says the bridge vouches for delivery, not for authorship', () => {
  // The socket is local and unauthenticated, so "the bridge wrote this" is a
  // fact and "the orchestrator asked for it" is not. An orchestrator reading its
  // own handback must not take a line it never sent as its own past instruction.
  const out = steeredInBlock([{ ts: '2026-09-03T17:02:11.000Z', text: 'do the thing' }]);
  ok(/unauthenticated/.test(out), out);
  ok(/untrusted input/.test(out), out);
});

t('the record cap is smaller than the socket limit and bigger than the echo', () => {
  // What is stored on the run record is rewritten into bg-inflight.json on every
  // later steer, so it is capped well below the 256 KB the socket will accept.
  ok(STEER_RECORD_MAX > STEER_ECHO_MAX && STEER_RECORD_MAX <= 8000, String(STEER_RECORD_MAX));
});

// ---------------------------------------------------------------------------
console.log('\n7. the target shape (backwards compatibility of `bg.mjs steer`)');
// ---------------------------------------------------------------------------

t('real targets look like targets', () => {
  for (const s of ['latest', 'bg', 'bg2', 'bg17', 'bg-1788453512237', 'bg-1788453512237-83808', '83808'])
    ok(looksLikeTarget(s), `${s} should be a target`);
});

t('★ prose does not look like a target (a brief starting with "steer" still dispatches)', () => {
  for (const s of ['the', 'reels', 'away', 'Use', 'my-notes', '', 'bg 2', 'x-1'])
    ok(!looksLikeTarget(s), `${s} must NOT be read as a target`);
});

t('★ bg.mjs carries the SAME target shape (the two copies must not drift)', () => {
  // bg.mjs is dependency-free by contract (its own test copies it alone into a
  // temp dir), so it cannot import this module and keeps its own copy of the
  // regex. This is the guard that keeps them identical.
  const bg = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  ok(bg.includes(TARGET_SHAPE.source), `bg.mjs does not contain ${TARGET_SHAPE.source}`);
});

t('bg.mjs imports nothing this module owns (still standalone)', () => {
  const bg = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  ok(!/from ['"]\.\/bg-steer\.mjs['"]/.test(bg), 'bg.mjs must not import bg-steer.mjs');
  ok(!/from ['"][^n]/.test(bg.replace(/from 'node:[^']+'/g, "from 'node:x'")), 'bg.mjs may only import node: built-ins');
});

t('the socket name is a plain relative file name (it lives beside the daemon)', () => {
  eq(STEER_SOCK_NAME, 'steer.sock');
  ok(!STEER_SOCK_NAME.includes('/'), 'the path is composed by the caller, never hardcoded here');
});

// ---------------------------------------------------------------------------
console.log('\n8. the bg.mjs CLI against a stub socket (no daemon, no API spend)');
// ---------------------------------------------------------------------------
// The daemon cannot be imported, but the WIRE can be: this stands up a socket
// that answers exactly as bridge.mjs does (same module, same shapes) and drives
// the real CLI at it. What it protects is everything argv parsing can break in
// silence: a brief that begins with the word "steer" must still DISPATCH, and a
// steer must reach the socket with its text byte-identical to the file it came
// from, apostrophes and backticks included.

const TMP = mkdtempSync(path.join(tmpdir(), 'bg-steer-cli-'));
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);
const SOCK = path.join(TMP, STEER_SOCK_NAME);
const QUEUE = path.join(TMP, 'bg-queue.json');

const received = [];
const stub = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    const i = buf.indexOf('\n');
    if (i === -1) return;
    const decoded = decodeLine(buf.slice(0, i));
    received.push(decoded.ok ? decoded.value : { bad: buf.slice(0, i) });
    if (!decoded.ok) return sock.end(encodeLine(steerFailure(decoded.reason, { detail: decoded.detail })));
    const req = validateRequest(decoded.value);
    if (!req.ok) return sock.end(encodeLine(steerFailure(req.reason, { detail: req.detail })));
    if (req.op === 'ps') {
      const workers = [W1, W2, REATTACHED];
      return sock.end(encodeLine({ ok: true, workers, table: psTable(workers) }));
    }
    const found = resolveSteerTarget(req.target, [W1, W2, REATTACHED, CHAT]);
    if (!found.ok) {
      const { ok: _ok, worker, ...rest } = found;
      return sock.end(encodeLine(steerFailure(found.reason, rest)));
    }
    return sock.end(encodeLine(steerResponse(found.worker, '2026-09-03T17:02:11.000Z')));
  });
});
await new Promise((r) => stub.listen(SOCK, r));

const run = (args, cwd = TMP) =>
  new Promise((resolve) => {
    execFile(process.execPath, [BG, ...args], { cwd }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

const at = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
};

await at('ps prints the daemon-rendered table and exits 0', async () => {
  const r = await run(['ps']);
  eq(r.code, 0, r.stderr);
  ok(r.stdout.includes('RUNID') && r.stdout.includes('bg2-1788453999999'), r.stdout);
  eq(received.at(-1).op, 'ps');
});

await at('a delivered steer prints the one-line ack and exits 0', async () => {
  const r = await run(['steer', 'bg2', 'skip', 'the', 'browser', 'step']);
  eq(r.code, 0, r.stderr);
  ok(r.stdout.includes('steered into bg2 (bg2-1788453999999, pid 90210) at 17:02:11Z'), r.stdout);
  eq(received.at(-1).text, 'skip the browser step', 'the CLI mangled the text on the way to the socket');
});

await at('★ --file carries backticks and apostrophes through unchanged', async () => {
  // The whole reason the flag exists: argv goes through a shell, a file does not.
  const body = "Don't rebuild `dist`; run `npm test` first, then report [a, b].";
  const f = path.join(TMP, 'steer-body.md');
  writeFileSync(f, body + '\n');
  const r = await run(['steer', 'latest', '--file', f]);
  eq(r.code, 0, r.stderr);
  eq(received.at(-1).text, body);
  eq(received.at(-1).target, 'latest');
});

await at('a refused steer prints the reason and exits 1', async () => {
  const r = await run(['steer', 'bg3', 'too late']);
  eq(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
  ok(r.stderr.includes(`NOT delivered: ${REASONS.NOT_STEERABLE}`), r.stderr + r.stdout);
});

await at('an unknown target is refused, not silently dispatched', async () => {
  const r = await run(['steer', '99999', 'hello']);
  eq(r.code, 1, r.stdout + r.stderr);
  ok(r.stderr.includes(REASONS.NO_MATCH), r.stderr);
});

await at('a steer with no text is refused before it reaches the socket', async () => {
  const before = received.length;
  const r = await run(['steer', 'bg2']);
  eq(r.code, 1, r.stdout);
  ok(/usage:/.test(r.stderr), r.stderr);
  eq(received.length, before, 'an empty steer must never cost a worker a turn');
});

await at('★ a brief that BEGINS with the word steer still dispatches a job', async () => {
  const before = received.length;
  rmSync(QUEUE, { force: true });
  const r = await run(['steer the reels pipeline away from the old template']);
  eq(r.code, 0, r.stderr);
  const q = JSON.parse(readFileSync(QUEUE, 'utf8'));
  eq(q.length, 1, 'the brief never reached the queue');
  ok(q[0].text.includes('steer the reels pipeline away from the old template'), q[0].text.slice(0, 200));
  eq(received.length, before, 'a prose brief was sent to the steer socket');
});

await at('the plain dispatch form is untouched, lane rules and all', async () => {
  rmSync(QUEUE, { force: true });
  const r = await run(['run the full suite and report what fails']);
  eq(r.code, 0, r.stderr);
  const q = JSON.parse(readFileSync(QUEUE, 'utf8'));
  ok(q[0].text.startsWith('LANE RULES (you are a background worker'), q[0].text.slice(0, 80));
  ok(q[0].text.includes('--- TASK ---'), 'the task anchor is gone');
});

await at('★ with no daemon listening the CLI says so and exits 2', async () => {
  // Exit 2 is the signal to RESTART the daemon, distinct from exit 1 (the daemon
  // answered and refused). Conflating them would send the reader debugging a
  // target that was never the problem.
  const cold = mkdtempSync(path.join(tmpdir(), 'bg-steer-cold-'));
  copyFileSync(path.join(DIR, 'bg.mjs'), path.join(cold, 'bg.mjs'));
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(cold, 'bg.mjs'), 'steer', 'latest', 'anything'], { cwd: cold }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  eq(r.code, 2, r.stdout + r.stderr);
  ok(r.stderr.includes('bridge daemon not reachable'), r.stderr);
  ok(r.stderr.includes('safe-restart.sh'), 'the message must say how to fix it');
  rmSync(cold, { recursive: true, force: true });
});

await at('ps against a cold socket also exits 2, never a fake empty list', async () => {
  const cold = mkdtempSync(path.join(tmpdir(), 'bg-steer-cold-ps-'));
  copyFileSync(path.join(DIR, 'bg.mjs'), path.join(cold, 'bg.mjs'));
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(cold, 'bg.mjs'), 'ps'], { cwd: cold }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  eq(r.code, 2, r.stdout + r.stderr);
  ok(!/no background workers running/.test(r.stdout), 'an unreachable daemon must not read as an idle one');
  rmSync(cold, { recursive: true, force: true });
});

stub.close();
rmSync(TMP, { recursive: true, force: true });

// ---------------------------------------------------------------------------
console.log('\nX. refusing to steer a Codex run');
// ---------------------------------------------------------------------------

t('★ case 29: a Codex run says WHY it cannot be steered, and what to do instead', () => {
  // README.md has promised this wording since the second engine landed; the
  // code answered with the generic `not_steerable`, which reads as "try again
  // in a second" for what is a structural fact: the run is file-backed with no
  // stdin to write into.
  const codexRun = { runId: 'codex-1788000000000', watchdogId: 'codex-1788000000000-42', lane: 'codex', pid: 42, isBg: true, running: true, steerable: false, engine: 'codex', startedAt: 1788000000000 };
  const res = resolveSteerTarget('codex-1788000000000', [codexRun]);
  eq(res.ok, false);
  eq(res.engine, 'codex', 'the engine has to reach the ack or it cannot say anything specific');
  const ack = steerAckLine(res);
  ok(/take no mid-run input/.test(ack), ack);
  ok(/--engine codex --file/.test(ack), `the refusal has no escape hatch: ${ack}`);
  ok(/codex-1788000000000/.test(ack), 'it still names the worker it refused');
});

t('a CLAUDE worker that cannot be steered keeps the short answer', () => {
  // Its reason is timing (the result is in, stdin is closed), not structure, so
  // the Codex paragraph would be wrong advice.
  const claudeRun = { runId: 'bg-1788000000000', lane: 'bg', pid: 43, isBg: true, running: true, steerable: false, startedAt: 1788000000000 };
  const ack = steerAckLine(resolveSteerTarget('bg', [claudeRun]));
  ok(/not_steerable/.test(ack), ack);
  ok(!/mid-run input/.test(ack), ack);
});

// ---------------------------------------------------------------------------
// THE TWO AUDIENCES. steerAckLine is read in a terminal by `bg.mjs steer` and
// on a phone by /steer, and the terminal form is wrong on a phone: a run id, a
// pid, and two continuation lines of 130 and 160 characters.
// ---------------------------------------------------------------------------

t('the CLI line is unchanged, byte for byte', () => {
  const res = steerResponse({ runId: 'bg2-1788453512237', lane: 'bg2', pid: 4123 }, '2026-09-04T17:02:11.500Z');
  eq(res.ack, 'steered into bg2 (bg2-1788453512237, pid 4123) at 17:02:11Z', 'the terminal output must not move');
  eq(steerAckLine(res), res.ack, 'verbose is the default, so every existing caller is untouched');
});

t('the phone line drops what a phone cannot read or type', () => {
  const res = steerResponse({ runId: 'bg2-1788453512237', lane: 'bg2', pid: 4123 }, '2026-09-04T17:02:11.500Z');
  const phone = steerAckLine(res, { verbose: false });
  eq(phone, '➡️ Steered into bg2 · 17:02:11Z', 'with no timezone it stays honestly UTC');
  ok(!phone.includes('1788453512237'), 'an unreadable, untypeable run id');
  ok(!phone.includes('4123'), 'and a pid he would do nothing with');
  for (const line of phone.split('\n')) ok(line.length <= 44, `${line.length} chars: ${line}`);
});

t('★ given a timezone, the phone line is the OWNER\'s clock, not UTC', () => {
  const res = steerResponse({ runId: 'bg2-1', lane: 'bg2', pid: 1 }, '2026-09-04T21:02:11.500Z');
  eq(
    steerAckLine(res, { verbose: false, timeZone: 'Europe/Lisbon' }),
    '➡️ Steered into bg2 · 22:02:11',
    'an unlabelled UTC time on a phone in another zone is simply wrong',
  );
  eq(
    steerAckLine(res, { verbose: false, timeZone: 'Not/AZone' }),
    '➡️ Steered into bg2 · 21:02:11Z',
    'a bad zone degrades to the UTC form rather than throwing inside an ack',
  );
});

t('a Codex refusal says it is structural, and how to redirect anyway', () => {
  const res = steerFailure(REASONS.NOT_STEERABLE, { runId: 'codex-1788', lane: 'codex', pid: 41, engine: 'codex' });
  const phone = steerAckLine(res, { verbose: false });
  const lines = phone.split('\n');
  eq(lines[0], '❌ Not delivered · codex takes no mid-run input');
  ok(phone.includes('Re-fire it'), 'the escape hatch matters more than the refusal');
  for (const line of lines.slice(1)) ok(line.length <= 44, `${line.length} chars: ${line}`);
  ok(res.ack.startsWith('NOT delivered: not_steerable'), 'and the CLI form is untouched');
});

t('an ambiguous target asks the question instead of naming a reason code', () => {
  const res = steerFailure(REASONS.AMBIGUOUS, { candidates: ['bg2', 'bg3'] });
  eq(steerAckLine(res, { verbose: false }), '❌ Not delivered · which worker?\nCandidates: bg2, bg3');
});

t('a Claude worker that cannot take one says which of the two reasons it is', () => {
  const phone = steerAckLine(steerFailure(REASONS.NOT_STEERABLE, { lane: 'bg3', runId: 'bg3-1', pid: 9 }), { verbose: false });
  ok(phone.includes('bg3 cannot take one'), phone);
  ok(/restart|finished/.test(phone), 'a bare refusal reads as "try again in a second"');
});

t('no match, and a write that lost the race, both say what to do next', () => {
  ok(steerAckLine(steerFailure(REASONS.NO_MATCH), { verbose: false }).includes('/status'), 'name the command that lists them');
  ok(steerAckLine(steerFailure(REASONS.WRITE_FAILED, { lane: 'bg2' }), { verbose: false }).includes('exited'), 'the likely cause');
});

t('an unknown reason still renders rather than printing "undefined"', () => {
  const phone = steerAckLine(steerFailure('some_future_reason', { detail: 'x'.repeat(300) }), { verbose: false });
  ok(phone.startsWith('❌ Not delivered · some_future_reason'));
  ok(phone.length < 160, 'and the detail is bounded');
});

t('no phone ack contains an em dash', () => {
  const all = [
    steerResponse({ lane: 'bg2', runId: 'bg2-1', pid: 1 }, '2026-09-04T17:02:11Z'),
    steerFailure(REASONS.AMBIGUOUS, { candidates: ['a', 'b'] }),
    steerFailure(REASONS.NOT_STEERABLE, { lane: 'x', engine: 'codex' }),
    steerFailure(REASONS.NOT_STEERABLE, { lane: 'x' }),
    steerFailure(REASONS.NO_MATCH),
    steerFailure(REASONS.WRITE_FAILED, { lane: 'x' }),
  ];
  for (const r of all) {
    const phone = steerAckLine(r, { verbose: false });
    ok(!/[–—]/.test(phone), phone);
  }
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-steer tests pass');
