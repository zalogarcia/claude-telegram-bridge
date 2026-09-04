#!/usr/bin/env node
// Wiring tests for the Codex engine: the REAL runCodex out of bridge.mjs, run
// against a FAKE `codex` binary.
//
// Existence is not implementation. bg-codex.test.mjs proves the pure half is
// right; this proves bridge.mjs actually spawns with it, and spawns it the way
// a background worker is spawned rather than as an ordinary child:
//
//   ★ stdout/stderr on a FILE, not a pipe (child.stdout === null)
//   ★ registered in the inflight registry with engine: codex
//   ★ the prompt delivered on stdin, and stdin then closed
//   ★ the registry entry cleared on completion, exactly once
//   ★ no credential in argv or in the registry record
//   ★ a run past the deadline is killed and REPORTED, not left hanging
//
// bridge.mjs runs main() on import, so it is extracted by source and evaluated
// against stubs, the same trick test.mjs and bg-notify.test.mjs use. No network,
// no Telegram, no OpenAI spend: the fake binary is a shell script.
//
//   node bg-codex-wiring.test.mjs

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codexReviewScope, codexReviewTask } from './bg-codex.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-codex-wiring-'));
const RUNS = path.join(TMP, 'runs');

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
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
// The fake codex. Echoes the stdin prompt back as an agent_message, writes the
// -o file, records its own argv, and reports a token block. CODEX_FAKE_SLEEP
// makes it hang so the deadline path can be tested without a 30 minute wait.
// ---------------------------------------------------------------------------
const FAKE = path.join(TMP, 'fake-codex');
const ARGV_LOG = path.join(TMP, 'argv.txt');
writeFileSync(
  FAKE,
  `#!/bin/bash
printf '%s\\n' "$*" > ${JSON.stringify(ARGV_LOG)}
last=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then last="$a"; fi
  prev="$a"
done
prompt=$(cat)
if [ -n "\${CODEX_FAKE_SLEEP:-}" ]; then sleep "$CODEX_FAKE_SLEEP"; fi
echo '{"type":"thread.started","thread_id":"t1"}'
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"FAKE:\${prompt}\\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}'
[ -n "$last" ] && printf 'FAKE:%s' "$prompt" > "$last"
exit 0
`,
);
chmodSync(FAKE, 0o755);

// ---------------------------------------------------------------------------
// Extract runCodex (and the helpers it closes over) out of bridge.mjs.
// ---------------------------------------------------------------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}') || l.startsWith('};')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);
const HARNESS = `
import fs from 'node:fs';
import { spawnWorker } from ${url('detached-workers.mjs')};
import {
  CODEX_LANE, buildCodexArgs, codexOutcome, codexPaths, codexRunId, codexStartNotice, freeCodexStart,
} from ${url('bg-codex.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-lane-rules.mjs')};
import { parseRunId } from ${url('bg-steer.mjs')};
const { existsSync, mkdirSync, writeFileSync, readFileSync } = fs;
export const SENT = [];
export const REPORTED = [];
const send = (t) => { SENT.push(t); return Promise.resolve(); };
export const codexRuns = new Map();
export const registry = new Map();
const inflight = {
  add: (id, rec) => registry.set(id, rec),
  clear: (id) => registry.delete(id),
  read: () => Object.fromEntries(registry),
};
const closeStdin = (c) => { try { c?.stdin?.destroy(); } catch {} };
const reportCodexOutcome = (task, outcome, runId, meta) => { REPORTED.push({ task, outcome, runId, meta }); };
export let RUNS_DIR = '';
export let CODEX_BIN = '';
export let CODEX_TIMEOUT_MS = 30000;
export const configure = (o) => {
  if (o.runsDir !== undefined) RUNS_DIR = o.runsDir;
  if (o.bin !== undefined) CODEX_BIN = o.bin;
  if (o.timeoutMs !== undefined) CODEX_TIMEOUT_MS = o.timeoutMs;
};
const CODEX_MODEL = null;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
export const reset = () => { SENT.length = 0; REPORTED.length = 0; codexRuns.clear(); registry.clear(); };
`;

const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        grab('readTextIf', 'const'),
        // The run sidecar: runCodex writes it at spawn and stamps it at exit, so
        // the extracted function needs both or it ReferenceErrors on its first call.
        grab('writeCodexMeta'),
        grab('finalizeCodexMeta'),
        grab('runCodex'),
        // runCodex calls this on a spawn 'error' event: without it, the missing
        // binary case ReferenceErrors instead of reporting.
        grab('codexLaunchError'),
        `const CODEX_BIN_NAME = 'codex';`,
        'export { runCodex, readTextIf, writeCodexMeta, finalizeCodexMeta };',
      ].join('\n'),
    )
);
B.configure({ runsDir: RUNS, bin: FAKE, timeoutMs: 30000 });

// Wait for a run to report, in bounded ticks: a hung child must fail the test
// rather than hang it.
const settled = (ms = 15000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (B.REPORTED.length) return resolve(B.REPORTED[B.REPORTED.length - 1]);
      if (Date.now() - started > ms) return reject(new Error('the codex run never reported'));
      setTimeout(tick, 50);
    };
    tick();
  });

// ---------------------------------------------------------------------------
console.log('\n1. a normal ask run');
// ---------------------------------------------------------------------------

B.reset();
const askRun = B.runCodex('what does bg.mjs do', { mode: 'ask', cwd: TMP, reason: 'explicit' });
const askRec = B.registry.get(askRun.watchdogId);

await t('the run is registered as background work, tagged with its engine', () => {
  ok(askRec, 'nothing was written to the inflight registry');
  eq(askRec.engine, 'codex', 'the reaper, ps and the re-attach path all read this');
  eq(askRec.lane, 'codex');
  ok(askRec.pid > 0, 'no pid recorded');
  ok(String(askRec.log).endsWith('.log'), askRec.log);
  eq(askRec.mode, 'ask');
});

await t('★ stdout and stderr are on a FILE, not a pipe', () => {
  // The load-bearing half of worker survival: a detached child still dies on
  // its next write if that write goes down a pipe to a dead parent. With file
  // stdio node reports no stdout stream at all.
  eq(askRun.child.stdout, null, 'a Codex run must not be piped to the daemon');
  eq(askRun.child.stderr, null, 'stderr too: they share the one log file');
});

await t('the run id and log path follow the shared <lane>-<startedAt> shape', () => {
  eq(askRun.runId, `codex-${askRun.startedAt}`);
  eq(path.basename(askRun.logPath), `codex-${askRun.startedAt}.log`);
});

await t('the start notice names Codex and says it cannot be steered', () => {
  ok(B.SENT.length === 1, `expected one notice, got ${B.SENT.length}`);
  ok(B.SENT[0].includes('codex'), B.SENT[0]);
  ok(B.SENT[0].includes('not steerable'), B.SENT[0]);
});

const askOutcome = await settled();
const askArgv = readFileSync(ARGV_LOG, 'utf8'); // written by the child, so read it after it ran

await t('argv carries the read-only sandbox and no credential', () => {
  ok(/--sandbox read-only/.test(askArgv), askArgv);
  ok(!/dangerously/.test(askArgv), 'the bypass flag must never be emitted');
  ok(!/sk-|api[-_]?key/i.test(askArgv), `a credential reached argv: ${askArgv}`);
});

await t('the prompt reached the child on stdin, and its answer came back', () => {
  eq(askOutcome.outcome.status, 'finished');
  ok(askOutcome.outcome.answer.includes('what does bg.mjs do'), askOutcome.outcome.answer);
});

await t('the token usage survives into the report', () => {
  eq(askOutcome.outcome.tokens.input_tokens, 12);
  eq(askOutcome.outcome.tokens.output_tokens, 3);
});

await t('the registry entry is cleared by the run that reported it', () => {
  eq(B.registry.size, 0, 'a reported worker left in the registry gets announced as dead');
  eq(B.codexRuns.size, 0, 'the live map must not leak finished runs');
});

await t('the answer landed in the log file, and the log has no credential in it', () => {
  const log = readFileSync(askRun.logPath, 'utf8');
  ok(log.includes('turn.completed'), 'the event stream is not in the log');
  ok(!/sk-[A-Za-z0-9]/.test(log), 'a credential reached the run log');
  ok(!/sk-[A-Za-z0-9]/.test(JSON.stringify([...B.registry])), 'a credential reached the registry');
});

await t('the brief is written next to the log so a dead run can still be salvaged', () => {
  const prompt = path.join(RUNS, `codex-${askRun.startedAt}.prompt.md`);
  ok(existsSync(prompt), `no prompt file at ${prompt}`);
  eq(readFileSync(prompt, 'utf8'), 'what does bg.mjs do');
});

// ---------------------------------------------------------------------------
console.log('\n2. edit mode, and the lane rules a Codex run must never be sent');
// ---------------------------------------------------------------------------

B.reset();
const LANE_RULES_BRIEF = 'LANE RULES (you are a background worker: headless).\n1. NEVER use run_in_background\n\n--- TASK ---\n\n# Do the real job';
const editRun = B.runCodex(LANE_RULES_BRIEF, { mode: 'edit', cwd: TMP, reason: 'claude_limited', pausedUntil: Date.now() + 3600_000, announce: false });
const editOutcome = await settled();

await t('edit mode asks for the workspace-write sandbox', () => {
  ok(/--sandbox workspace-write/.test(readFileSync(ARGV_LOG, 'utf8')), readFileSync(ARGV_LOG, 'utf8'));
});

await t('★ the Claude lane rules are stripped before the prompt is billed', () => {
  // Every one of them is a fact about a headless CLAUDE worker. Sending them to
  // Codex is a page of wrong instructions, paid for by the token.
  ok(!editOutcome.outcome.answer.includes('run_in_background'), editOutcome.outcome.answer.slice(0, 120));
  ok(editOutcome.outcome.answer.includes('Do the real job'), editOutcome.outcome.answer.slice(0, 120));
});

await t('announce:false sends no start notice (the handoff notice is the announcement)', () => {
  eq(B.SENT.length, 0, `unexpected notice: ${B.SENT[0]}`);
});

await t('the reason travels to the report, so the handback can explain itself', () => {
  eq(editOutcome.meta.reason, 'claude_limited');
  eq(editOutcome.meta.mode, 'edit');
});

// ---------------------------------------------------------------------------
console.log('\n3. the deadline');
// ---------------------------------------------------------------------------

B.reset();
B.configure({ timeoutMs: 400 });
process.env.CODEX_FAKE_SLEEP = '20';
const hung = B.runCodex('a run that hangs', { mode: 'ask', cwd: TMP, announce: false });
const hungOutcome = await settled();
delete process.env.CODEX_FAKE_SLEEP;
B.configure({ timeoutMs: 30000 });

await t('★ a run past its deadline is killed and REPORTED, not left burning tokens', () => {
  eq(hungOutcome.outcome.status, 'failed');
  ok(hungOutcome.outcome.answer.includes('killed on the bridge timeout'), hungOutcome.outcome.answer);
});

await t('a killed run leaves nothing behind in the registry either', () => {
  eq(B.registry.size, 0);
  eq(B.codexRuns.size, 0);
});

// ---------------------------------------------------------------------------
console.log('\n4. a launch that fails');
// ---------------------------------------------------------------------------

B.reset();
B.configure({ bin: path.join(TMP, 'no-such-binary') });
B.runCodex('this cannot start', { mode: 'ask', cwd: TMP, announce: false });
const deadOutcome = await settled();
B.configure({ bin: FAKE });

await t('a missing codex binary is reported as a failure, not swallowed', () => {
  eq(deadOutcome.outcome.status, 'failed');
  ok(/Codex FAILED/.test(deadOutcome.outcome.answer), deadOutcome.outcome.answer);
});

await t('and it leaves no phantom entry in the registry', () => {
  // A spawn failure is an 'error' EVENT on POSIX, not a throw, so the child
  // exists with no pid. Registering that would hand the reaper a corpse to
  // announce as a dead worker seconds before the real failure report lands.
  eq(B.registry.size, 0);
});

// ---------------------------------------------------------------------------
console.log('\n5. onAnswer takes delivery (the chat fallback path)');
// ---------------------------------------------------------------------------

B.reset();
let delivered = null;
B.runCodex('degraded question', { mode: 'ask', cwd: TMP, announce: false, onAnswer: (o) => (delivered = o) });
await new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (delivered) return resolve();
    if (Date.now() - started > 15000) return reject(new Error('onAnswer never fired'));
    setTimeout(tick, 50);
  };
  tick();
});

await t('★ onAnswer replaces the handback, so one answer is delivered ONCE', () => {
  ok(delivered, 'onAnswer never fired');
  eq(delivered.status, 'finished');
  eq(B.REPORTED.length, 0, 'the report ALSO went to the chat lane: that is the double-answer bug');
});

// ---------------------------------------------------------------------------
console.log('\n6. two runs dispatched in the same millisecond');
// ---------------------------------------------------------------------------

B.reset();
const twinA = B.runCodex('JOB-A audit the reels pipeline', { mode: 'ask', cwd: TMP, announce: false });
const twinB = B.runCodex('JOB-B rewrite the invoice script', { mode: 'ask', cwd: TMP, announce: false });

await t('★ a batch drained in one loop never shares an id, a log or a report', () => {
  // drainBgHandoff dispatches queued jobs in one synchronous loop, and every
  // Codex run carries the same lane name, so the timestamp is the whole id.
  // Sharing one means sharing the log, the -o file and the report: one job's
  // answer handed back under the other job's task.
  ok(twinA.runId !== twinB.runId, `both runs got ${twinA.runId}`);
  ok(twinA.logPath !== twinB.logPath, 'both runs share a log file');
  ok(twinA.lastFile !== twinB.lastFile, 'both runs share the -o file');
  eq(B.codexRuns.size, 2, 'one run overwrote the other in the live map');
  eq(B.registry.size, 2, 'one registry entry overwrote the other');
});

await new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (B.REPORTED.length >= 2) return resolve();
    if (Date.now() - started > 15000) return reject(new Error('the twin runs never both reported'));
    setTimeout(tick, 50);
  };
  tick();
});

await t('each twin is reported with its OWN answer', () => {
  for (const r of B.REPORTED) {
    const tag = /JOB-[AB]/.exec(r.task)[0];
    ok(r.outcome.answer.includes(tag), `${tag} was handed back the other job's answer: ${r.outcome.answer}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n6b. a /codex review run');
// ---------------------------------------------------------------------------

B.reset();
const revRun = B.runCodex(codexReviewTask({ dir: '/Users/dev/web-app', branch: 'main' }), {
  mode: 'review',
  cwd: TMP,
  reviewScope: codexReviewScope('main'),
  reason: 'explicit',
});
const revOutcome = await settled();
const revArgv = readFileSync(ARGV_LOG, 'utf8');

await t('★ a review is read-only by construction, with no way to ask for a sandbox', () => {
  // `codex exec review` has no --sandbox option at all, so the ONLY protection
  // is that we never emit one. A regression here would be an instant exit 2 at
  // best and a writable review at worst.
  ok(revArgv.includes('exec review'), revArgv);
  ok(revArgv.includes('--base main'), revArgv);
  ok(!revArgv.includes('--sandbox'), `review must carry no sandbox flag: ${revArgv}`);
  ok(!revArgv.includes('workspace-write'), revArgv);
  ok(!revArgv.includes('dangerously'), revArgv);
  ok(!revArgv.includes('--color'), `codex exec review REJECTS --color (measured, exit 2): ${revArgv}`);
  ok(!revArgv.includes(' -C '), `codex exec review takes no -C; cwd is set on the process: ${revArgv}`);
});

await t('★ a review sends NO bytes on stdin', () => {
  // The fake echoes whatever it read back as `FAKE:<prompt>`. An empty tail is
  // the proof: `--uncommitted` cannot coexist with a prompt argument, and
  // anything written here would reach codex as an unasked <stdin> block.
  eq(revOutcome.outcome.answer, 'FAKE:', `stdin was not empty: ${revOutcome.outcome.answer}`);
});

await t('the review still looks like every other run downstream', () => {
  eq(revOutcome.meta.mode, 'review', 'the handback must say which mode ran');
  eq(revOutcome.outcome.status, 'finished');
  eq(revRun.child.stdout, null, 'file-backed like every other Codex run');
  ok(revOutcome.task.startsWith('codex review:'), revOutcome.task);
});

await t('the sidecar records the mode, so /account can describe a FINISHED review', () => {
  const meta = JSON.parse(readFileSync(path.join(RUNS, `${revRun.runId}.meta.json`), 'utf8'));
  eq(meta.mode, 'review');
  eq(meta.status, 'finished');
  ok(meta.endedAt > 0, 'a finished run must not read as still running');
  ok(!JSON.stringify(meta).includes('eyJ'), 'no credential in the sidecar');
});

// ---------------------------------------------------------------------------
console.log('\n7. delivery while every Claude account is walled');
// ---------------------------------------------------------------------------

// reportCodexOutcome decides WHERE a finished Codex run is delivered, and the
// wall is the case the whole engine exists for: the assistant cannot run, so a
// handback to its chat lane would spawn claude, die on the limit, and leave the
// owner with a red bubble but no answer.
const D = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import { codexFallbackPrefix, fmtCodexTokens } from ${url('bg-codex.mjs')};
export const SENT = [];
export const HANDBACKS = [];
export const RECORDED = [];
export const parkedCodexChats = [];
export const PARKED_CODEX_MAX = 10;
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const OWNER_TZ = 'UTC';
export let rotationPausedUntil = 0;
export const setWall = (v) => { rotationPausedUntil = v; };
export const reset = () => { SENT.length = 0; HANDBACKS.length = 0; RECORDED.length = 0; parkedCodexChats.length = 0; };
const recordBgResult = (task, record) => { RECORDED.push({ task, record }); };
const handBackToChat = (task, output, status, steers, opts) => { HANDBACKS.push({ task, output, status, steers, opts }); };
`,
        grab('reportCodexOutcome'),
        grab('CODEX_DIRECT_LIMIT', 'const'),
        grab('deliverCodexDirect'),
        'export { reportCodexOutcome, deliverCodexDirect };',
      ].join('\n'),
    )
);

const OUTCOME = { status: 'finished', answer: 'the answer that was asked for', record: 'the answer that was asked for', tokens: { input_tokens: 100, output_tokens: 5 } };

D.reset();
D.setWall(0);
D.reportCodexOutcome('what changed today', OUTCOME, 'codex-1788453512237', { mode: 'ask', cwd: '/repo' });

await t('with Claude healthy the answer goes to the chat lane, as every other report does', () => {
  eq(D.HANDBACKS.length, 1);
  eq(D.HANDBACKS[0].opts.engine, 'codex');
  eq(D.HANDBACKS[0].opts.codex.mode, 'ask');
  eq(D.parkedCodexChats.length, 0, 'nothing to park: the assistant will speak for itself');
});

D.reset();
D.setWall(Date.parse('2126-01-01T00:00:00Z'));
D.reportCodexOutcome('what changed today', OUTCOME, 'codex-1788453512237', { mode: 'ask', cwd: '/repo' });

await t('★ while walled, the answer goes STRAIGHT to the owner instead of to a lane that cannot run', () => {
  eq(D.HANDBACKS.length, 0, 'the handback would have died on the limit and taken the answer with it');
  const bubble = D.SENT.find((t) => t.includes('the answer that was asked for'));
  ok(bubble, `the answer never reached the owner: ${JSON.stringify(D.SENT)}`);
  ok(bubble.startsWith('[Codex fallback'), bubble.slice(0, 60));
  ok(bubble.includes('100 in / 5 out tokens'), 'the cost line is the only signal that this was billed');
});

await t('and it is parked ONCE for M, framed as context rather than a question to answer', () => {
  eq(D.parkedCodexChats.length, 1);
  eq(D.parkedCodexChats[0].prompt, 'what changed today');
  eq(D.parkedCodexChats[0].answer, 'the answer that was asked for');
});

await t('a durable row is still written either way', () => {
  eq(D.RECORDED.length, 1, 'a walled answer must not vanish from bg-results.jsonl');
});

D.reset();
D.setWall(Date.parse('2126-01-01T00:00:00Z'));
D.reportCodexOutcome('long one', { ...OUTCOME, answer: 'x'.repeat(9000), record: 'x' }, 'codex-2', {});

await t('a long answer is bounded in the bubble and says it was cut', () => {
  const bubble = D.SENT.find((t) => t.startsWith('[Codex fallback'));
  ok(bubble.length < 5000, `a wall of text landed on the phone: ${bubble.length} chars`);
  ok(bubble.includes('truncated'), bubble.slice(-200));
  ok(bubble.includes('bg-results.jsonl'), 'the cut must name where the rest is');
});

// ---------------------------------------------------------------------------
console.log('\n8. dispatchPrompt: what the wall diverts, and what it must not');
// ---------------------------------------------------------------------------

const P = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import { shouldRouteToCodex } from ${url('bg-codex.mjs')};
import fs from 'node:fs';
const { existsSync } = fs;
export const SENT = [];
export const CLAUDE = [];
export const CHAT_FALLBACK = [];
export const CODEX = [];
const send = (t) => { SENT.push(t); return Promise.resolve(); };
export const LANES = { main: { name: 'main', current: null, queue: [] } };
export const bgLanes = [];
let bgSeq = 0;
const BG_TASK_TIMEOUT_MS = 1;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const chatState = () => ({ cwd: ${JSON.stringify(TMP)} });
const runClaude = (text, lane) => { CLAUDE.push({ text, lane: lane.name }); return Promise.resolve(); };
const runCodexChatFallback = (text, decision) => { CHAT_FALLBACK.push({ text, decision }); };
const runCodex = (text, opts) => { CODEX.push({ text, ...opts }); return { runId: 'codex-1' }; };
export let rotationPausedUntil = 0;
let codexFallbackValue = true;
export const setWall = (until, fallback = true) => { rotationPausedUntil = until; codexFallbackValue = fallback; };
const codexFallbackOn = () => codexFallbackValue;
const codexInstalled = () => true;
export const reset = () => { SENT.length = 0; CLAUDE.length = 0; CHAT_FALLBACK.length = 0; CODEX.length = 0; bgLanes.length = 0; bgSeq = 0; rotationPausedUntil = 0; codexFallbackValue = true; LANES.main.current = null; LANES.main.queue.length = 0; };
`,
        grab('BG_COMMAND_RE', 'const'),
        grab('QUEUE_MAX', 'const'),
        grab('makeBgLane'),
        grab('getBgLane'),
        grab('pickLane'),
        grab('dispatchPrompt'),
        'export { dispatchPrompt };',
      ].join('\n'),
    )
);

const WALL = Date.now() + 3600_000;

P.reset();
P.setWall(WALL);
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });

await t('★ a typed chat message during the wall goes to the Codex chat fallback, not to Claude', () => {
  eq(P.CHAT_FALLBACK.length, 1);
  eq(P.CLAUDE.length, 0, 'dispatching to Claude here is a guaranteed red bubble');
  eq(P.CHAT_FALLBACK[0].decision.reason, 'claude_limited');
});

P.reset();
P.setWall(WALL);
P.dispatchPrompt('bg: run the full test suite', undefined, { allowCodexFallback: true });

await t('a bg: job typed from the phone is routed too, in edit mode', () => {
  eq(P.CODEX.length, 1, 'it would otherwise spawn a worker into the wall and spend 90s on a salvage');
  eq(P.CODEX[0].mode, 'edit');
  eq(P.CODEX[0].text, 'run the full test suite', 'the bg: prefix must not reach the model');
  eq(P.CLAUDE.length, 0);
});

P.reset();
P.setWall(WALL);
P.dispatchPrompt('/autopilot ship the thing', undefined, { allowCodexFallback: true });

await t('★ a Claude SLASH COMMAND is never routed to Codex', () => {
  // /autopilot is a Claude Code command. Codex has no idea what it is, so
  // routing one there buys confident nonsense instead of a wait.
  eq(P.CODEX.length, 0, 'Codex cannot run a Claude slash command');
  eq(P.CLAUDE.length, 1);
});

P.reset();
P.setWall(WALL);
P.dispatchPrompt('[Report from your own background worker]', P.LANES.main, { priority: true });

await t('★ internal priority traffic is never diverted, even mid-wall', () => {
  // Worker handbacks, watchdog alerts, scheduled tasks and compaction all come
  // through here with priority. Sending one of those to Codex would hand a
  // report to a model that has no idea what the bridge is.
  eq(P.CODEX.length, 0);
  eq(P.CHAT_FALLBACK.length, 0);
  eq(P.CLAUDE.length, 1);
});

P.reset();
P.setWall(WALL, false); // /codex off
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });

await t('/codex off leaves every message on Claude', () => {
  eq(P.CHAT_FALLBACK.length, 0);
  eq(P.CODEX.length, 0);
  eq(P.CLAUDE.length, 1);
});

P.reset();
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });

await t('with Claude healthy nothing is diverted', () => {
  eq(P.CHAT_FALLBACK.length, 0);
  eq(P.CLAUDE.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n9. Codex not installed at all (the daemon must not care)');
// ---------------------------------------------------------------------------
// Codex is optional. Every path it touches has to degrade to one clear line
// rather than a spawn that fails a minute later, or a job silently re-routed to
// a different engine than the one that was asked for.

const N = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import path from 'node:path';
const { existsSync } = fs;
export let CODEX_BIN = 'codex';
export const setBin = (b) => { CODEX_BIN = b; };
`,
        grab('codexInstalled'),
        grab('codexLaunchError'),
        'export { codexInstalled, codexLaunchError };',
      ].join('\n'),
    )
);

await t('codexInstalled() is false when the binary is nowhere on PATH', () => {
  const before = process.env.PATH;
  process.env.PATH = path.join(TMP, 'definitely-empty');
  try {
    N.setBin('codex');
    eq(N.codexInstalled(), false);
  } finally {
    process.env.PATH = before;
  }
});

await t('codexInstalled() is true once the binary is on PATH', () => {
  const before = process.env.PATH;
  process.env.PATH = TMP; // the fake codex lives here
  try {
    N.setBin(path.basename(FAKE));
    eq(N.codexInstalled(), true);
  } finally {
    process.env.PATH = before;
    N.setBin('codex');
  }
});

await t('an absolute codexBin is checked as a path, not searched on PATH', () => {
  N.setBin(FAKE);
  eq(N.codexInstalled(), true);
  N.setBin(path.join(TMP, 'no-such-binary'));
  eq(N.codexInstalled(), false);
  N.setBin('codex');
});

await t('★ ENOENT becomes a sentence that says what to do, not "spawn codex ENOENT"', () => {
  const msg = N.codexLaunchError(Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  ok(/not installed/i.test(msg), msg);
  ok(/codex login/.test(msg), 'the fix belongs in the message');
  ok(/everything else works without it/i.test(msg), 'optional must read as optional');
});

await t('any other spawn error is passed through unchanged', () => {
  eq(N.codexLaunchError(new Error('EACCES: permission denied')), 'EACCES: permission denied');
});

await t('★ the guards are actually wired into the command and dispatch paths', () => {
  // Source-level, because handleCommand and drainBgHandoff cannot be extracted
  // (they close over the whole daemon). Each of these, if reverted, turns a
  // missing optional binary into a failed run a minute later.
  const src = SRC.join('\n');
  ok(/if \(!codexInstalled\(\)\) \{\s*\n\s*await send\(CODEX_MISSING_LINE/.test(src), '/codex does not check for the binary');
  ok(/allowCodexFallback && !priority && codexInstalled\(\)/.test(src), 'the chat fallback would spawn a missing binary');
  ok(/wanted === 'codex' && !codexInstalled\(\)/.test(src), 'a --engine codex job would silently run on Claude');
  ok(/codexInstalled\(\) \? ` · codex fallback/.test(src), '/status advertises an engine that is not installed');
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-codex wiring tests pass');
