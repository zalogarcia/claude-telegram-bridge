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
// against stubs, the same trick test.mjs uses. No network,
// no Telegram, no OpenAI spend: the fake binary is a shell script.
//
//   node bg-codex-wiring.test.mjs

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { codexReviewScope, codexReviewTask, isCodexImage } from './bg-codex.mjs';
import { execFallbackLine } from './codex-appserver.mjs';

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
export const WALL = [];
const noteCodexWall = () => { WALL.push('set'); return Date.now() + 3600000; };
const clearCodexWall = () => { WALL.push('clear'); };
export let RUNS_DIR = '';
export let CODEX_BIN = '';
export let CODEX_TIMEOUT_MS = 30000;
export const configure = (o) => {
  if (o.runsDir !== undefined) RUNS_DIR = o.runsDir;
  if (o.bin !== undefined) CODEX_BIN = o.bin;
  if (o.timeoutMs !== undefined) CODEX_TIMEOUT_MS = o.timeoutMs;
};
const CODEX_MODEL = null;
export let CODEX_SETTINGS = { model: null, effort: null };
export const setCodexSettings = (v) => { CODEX_SETTINGS = v; };
const codexSettingsNow = () => CODEX_SETTINGS;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
export const reset = () => { SENT.length = 0; REPORTED.length = 0; codexRuns.clear(); registry.clear(); CODEX_SETTINGS = { model: null, effort: null }; };
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
// The REAL normalizer, not a stub: whether a dash survives the direct-delivery
// path is exactly what one of the tests below asserts.
import { normalizeDashes } from ${url('dash-normalize.mjs')};
export let NO_DASHES = false;
export const setNoDashes = (v) => { NO_DASHES = v; };
export const SENT = [];
export const HANDBACKS = [];
export const RECORDED = [];
export const parkedCodexChats = [];
export const PARKED_CODEX_MAX = 10;
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const OWNER_TZ = 'UTC';
export let rotationPausedUntil = 0;
export const setWall = (v) => { rotationPausedUntil = v; };
export const reset = () => { SENT.length = 0; HANDBACKS.length = 0; RECORDED.length = 0; parkedCodexChats.length = 0; NO_DASHES = false; };
const bgReportId = (id) => String(id);
const bgReportPath = (id) => '/tmp/report-' + id + '.md';
const notifyOwnerBgFinished = (task, status, runId) => { SENT.push('PING ' + status + ' ' + runId); };
const recordBgResult = (task, record, p) => { RECORDED.push({ task, record, p }); };
const writeFullReport = (id, task, out, status) => ({ file: bgReportPath(id), chars: String(out).length });
const handBackToChat = (task, output, status, id, steers, opts) => { HANDBACKS.push({ task, output, status, id, opts }); };
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
  ok(bubble.startsWith('🧠 Codex fallback · '), bubble.slice(0, 60));
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

await t('a long answer is bounded in the bubble and points at the file', () => {
  const bubble = D.SENT.find((t) => t.startsWith('🧠 Codex fallback · '));
  ok(bubble.length < 5000, `a wall of text landed on the phone: ${bubble.length} chars`);
  ok(bubble.includes('/tmp/report-codex-2.md'), bubble.slice(-200));
});

// ---------------------------------------------------------------------------
console.log('\n8. dispatchPrompt: what the wall diverts, and what it must not');
// ---------------------------------------------------------------------------

const P = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import { codexCwdForBrief, fmtUntil, parseEnginePrefix, shouldRouteToCodex } from ${url('bg-codex.mjs')};
import { briefRepo, briefTitle, stripLaneRules } from ${url('bg-notify.mjs')};
import { queueAck, queueStarted, queueDropped, queueRunningNow, queueFull, WALL_TICK_MS, bothWalledLine, enginesBackLine } from ${url('system-messages.mjs')};
import { workerLine, WORKER_TICK_MS, WORKER_IDLE_MS } from ${url('bg-notify.mjs')};
import { claudeMissingLine, resolveEngine } from ${url('engine-state.mjs')};
import fs from 'node:fs';
const { existsSync } = fs;
export const CODEX_CHAT = [];
const runCodexChat = (text, opts) => { CODEX_CHAT.push({ text, ...opts }); return { runId: 'codex-chat-1' }; };
const runClaudeOpts = [];
const CODEX_MISSING_LINE = 'Codex is not installed';
// The REAL resolution, with this harness's state: a mirror of engineFor would
// keep agreeing with itself after engine-state.mjs changed.
export let ENGINE_CFG = {};
export let CHAT_ENGINE_STATE = {};
export let CLAUDE_AVAILABLE = true;
export let CODEX_AVAILABLE = true;
export const setEngines = (o) => {
  if (o.config !== undefined) ENGINE_CFG = o.config;
  if (o.chat !== undefined) CHAT_ENGINE_STATE = o.chat;
  if (o.claudeAvailable !== undefined) CLAUDE_AVAILABLE = o.claudeAvailable;
  if (o.codexAvailable !== undefined) CODEX_AVAILABLE = o.codexAvailable;
};
const engineFor = (lane, forcedEngine = null, { ignoreWall = false } = {}) =>
  resolveEngine({
    lane,
    forcedEngine,
    chat: CHAT_ENGINE_STATE,
    config: ENGINE_CFG,
    claudeAvailable: CLAUDE_AVAILABLE,
    codexAvailable: CODEX_AVAILABLE,
    rotationPausedUntil: ignoreWall ? 0 : rotationPausedUntil,
    now: Date.now(),
    codexFallback: codexFallbackValue,
  });
export const SENT = [];
export const CLAUDE = [];
export const CHAT_FALLBACK = [];
export const CODEX = [];
// The queue ack now edits itself, so this half of the harness has to model a
// message id and an edit channel. Real builders, stubbed transport: the SHAPES
// are asserted in system-messages.test.mjs, and what matters here is that the
// dispatch and the drain move the ack through its states.
export const EDITS = [];
let sentSeq = 0;
const send = (t) => { SENT.push(t); return Promise.resolve({ message_id: ++sentSeq }); };
const editProgress = (id, html) => { EDITS.push({ id, html }); return Promise.resolve(); };
const escHtml = (t) => String(t);
export const LIVE = new Set();
const registerLive = (e) => { LIVE.add(e); return e; };
const BG_PROGRESS_ON = true;
const WORKER_ORPHAN_MS = 120000;
const WORKER_KEEPALIVE_MAX_MS = 1800000;
let editCooldownUntil = 0;
export const setCooldown = (v) => { editCooldownUntil = v; };
const deliverWithoutClaude = (t) => { SENT.push('NO CLAUDE: ' + t); };
// The handoff, as bridge.mjs stores it: per chat, injected on the FIRST message
// only. The harness keeps the same shape so the "first message only" rule is
// asserted against the real dispatch rather than a mirror of it.
export const HANDOFF = { pending: false, block: '' };
const takeHandoffPrefix = () => {
  if (!HANDOFF.pending) return '';
  HANDOFF.pending = false;
  return HANDOFF.block;
};
export const LANES = { main: { name: 'main', current: null, queue: [] } };
export const bgLanes = [];
let bgSeq = 0;
const BG_TASK_TIMEOUT_MS = 1;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
export let CHAT_CWD = ${JSON.stringify(TMP)};
export const setChatCwd = (p) => { CHAT_CWD = p; };
const chatState = () => ({ cwd: CHAT_CWD });
const runClaude = (text, lane, opts = {}) => { CLAUDE.push({ text, lane: lane.name, ...opts }); return Promise.resolve(); };
const runCodexChatFallback = (text, decision) => { CHAT_FALLBACK.push({ text, decision }); };
const runCodex = (text, opts) => { CODEX.push({ text, ...opts }); return { runId: 'codex-1' }; };
export let rotationPausedUntil = 0;
let codexFallbackValue = true;
export const setWall = (until, fallback = true) => { rotationPausedUntil = until; codexFallbackValue = fallback; };
const codexFallbackOn = () => codexFallbackValue;
export let codexPausedUntil = 0;
export const setCodexWall = (until) => { codexPausedUntil = until; };
const OWNER_TZ = 'UTC';
const CLAUDE_AVAILABLE_FN = () => CLAUDE_AVAILABLE;
export const parkedWalledChats = [];
export const reset = () => { SENT.length = 0; EDITS.length = 0; LIVE.clear(); wallNotices.clear(); workerNotices.clear(); sentSeq = 0; CLAUDE.length = 0; CHAT_FALLBACK.length = 0; CODEX.length = 0; CODEX_CHAT.length = 0; bgLanes.length = 0; bgSeq = 0; rotationPausedUntil = 0; codexPausedUntil = 0; parkedWalledChats.length = 0; codexFallbackValue = true; CHAT_CWD = ${JSON.stringify(TMP)}; ENGINE_CFG = {}; CHAT_ENGINE_STATE = {}; CLAUDE_AVAILABLE = true; CODEX_AVAILABLE = true; LANES.main.current = null; LANES.main.queue.length = 0; HANDOFF.pending = false; HANDOFF.block = ''; };
`,
        grab('BG_COMMAND_RE', 'const'),
        grab('unchosenCodex', 'const'),
        grab('QUEUE_MAX', 'const'),
        grab('PARKED_WALLED_MAX', 'const'),
        grab('makeBgLane'),
        grab('getBgLane'),
        grab('pickLane'),
        grab('codexWalled', 'const'),
        grab('claudeWalled', 'const'),
        grab('wallNotices', 'const'),
        grab('raiseWall'),
        grab('settleWall'),
        grab('pendWallResolution'),
        grab('workerNotices', 'const'),
        grab('startWorkerNotice'),
        grab('editWorkerNotice'),
        grab('bothEnginesWalledLine'),
        grab('flushParkedWalledChats'),
        grab('queueItem'),
        grab('asQueueItem', 'const'),
        grab('QUEUE_ACK_MIN_EDIT_MS', 'const'),
        grab('trackQueueAck'),
        grab('resolveQueueAck'),
        grab('engineForItem'),
        grab('startResolvedRun'),
        grab('dispatchPrompt'),
        grab('drainQueue'),
        'export { dispatchPrompt, drainQueue, startResolvedRun, flushParkedWalledChats, bothEnginesWalledLine, trackQueueAck, resolveQueueAck, QUEUE_MAX, PARKED_WALLED_MAX, raiseWall, settleWall, wallNotices };',
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
console.log('\n9. a bg: job runs where its BRIEF points, not where the chat is');
// ---------------------------------------------------------------------------
// `--sandbox workspace-write` is rooted at exactly ONE directory. A job about
// repo X diverted to Codex while the chat happens to be pointed at repo Y
// either cannot do its work at all, or edits same-named files in the wrong tree
// and reports success. Ported from the public sibling's QA pass.

const REPO_A = path.join(TMP, 'media-tools');
const REPO_B = path.join(TMP, 'other-repo');
mkdirSync(REPO_A, { recursive: true });
mkdirSync(REPO_B, { recursive: true });

P.reset();
P.setWall(WALL);
P.setChatCwd(REPO_B); // the chat is pointed somewhere else entirely
P.dispatchPrompt('bg: # TASK: fix the encoder\nRepo: media-tools\n', undefined, { allowCodexFallback: true });

await t('★ a diverted bg: job runs in the repo its brief names, not the chat cwd', () => {
  eq(P.CODEX.length, 1);
  eq(P.CODEX[0].cwd, REPO_A, 'workspace-write was rooted at the wrong tree');
});

P.reset();
P.setWall(WALL);
P.setChatCwd(REPO_B);
P.dispatchPrompt('bg: # TASK: fix the encoder\nRepo: not-checked-out-here\n', undefined, { allowCodexFallback: true });

await t('a repo that is not checked out here falls back to the chat cwd', () => {
  eq(P.CODEX.length, 1);
  eq(P.CODEX[0].cwd, REPO_B, 'a guess at a directory that does not exist is worse than the cwd');
});

// ---------------------------------------------------------------------------
console.log('\n10. adopting a Codex run that outlived the daemon');
// ---------------------------------------------------------------------------
// The re-armed deadline is a SIGTERM scheduled up to CODEX_TIMEOUT_MS out, at a
// pid this daemon never spawned. A pid is a reusable number, and the registry
// outlives the daemon, so "the entry is stale and that pid is now something
// else" is the ordinary case after a machine sleeps. Every signal has to be
// gated on the run still being live, at fire time and not only at adoption.

const A = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
export let CODEX_TIMEOUT_MS = 60_000;
export const setTimeoutMs = (n) => { CODEX_TIMEOUT_MS = n; };
export const codexBeforeRestart = new Map();
export const registry = new Map();
export let ALIVE = new Set();
export const setAlive = (pids) => { ALIVE = new Set(pids); };
const pidAlive = (pid) => ALIVE.has(pid);
const inflight = { read: () => Object.fromEntries(registry) };
`,
        grab('adoptCodexSurvivor'),
        grab('releaseCodexSurvivor'),
        grab('codexSurvivorTimers', 'const'),
        'export { adoptCodexSurvivor, releaseCodexSurvivor, codexSurvivorTimers };',
      ].join('\n'),
    )
);

// process.kill is the global the extracted source reaches for, so the spy goes
// on the global and comes straight back off.
const realKill = process.kill.bind(process);
const SIGNALS = [];
const spyKill = () => {
  SIGNALS.length = 0;
  process.kill = (pid, sig) => SIGNALS.push([pid, sig]);
};
const unspyKill = () => {
  process.kill = realKill;
};

await t('★ a stale registry entry whose pid is gone is never signalled', () => {
  spyKill();
  try {
    A.registry.clear();
    A.setAlive([]); // the pid died while the daemon was down; the number may be reused
    A.registry.set('codex-1', { pid: 424242, startedAt: Date.now() - 3 * 60 * 60_000, mode: 'edit' });
    A.adoptCodexSurvivor('codex-1', A.registry.get('codex-1'));
    eq(SIGNALS.length, 0, `signalled a dead pid: ${JSON.stringify(SIGNALS)}`);
    eq(A.codexSurvivorTimers.size, 0, 'a dead survivor must not arm a deadline either');
  } finally {
    unspyKill();
  }
});

await t('a live survivor past its deadline IS terminated', () => {
  spyKill();
  try {
    A.registry.clear();
    A.setAlive([515151]);
    A.registry.set('codex-2', { pid: 515151, startedAt: Date.now() - 3 * 60 * 60_000, mode: 'edit' });
    A.adoptCodexSurvivor('codex-2', A.registry.get('codex-2'));
    eq(SIGNALS.length, 1);
    eq(SIGNALS[0][0], 515151);
    eq(SIGNALS[0][1], 'SIGTERM');
  } finally {
    unspyKill();
  }
});

await t('the mode and cwd a survivor will be REPORTED with are snapshotted either way', () => {
  A.codexBeforeRestart.clear();
  A.setAlive([]);
  A.adoptCodexSurvivor('codex-x', { pid: 1, startedAt: Date.now(), mode: 'edit', cwd: '/tmp/x' });
  eq(A.codexBeforeRestart.get('codex-x').mode, 'edit', 'an edit run reported as ask loses its write warning');
  eq(A.codexBeforeRestart.get('codex-x').cwd, '/tmp/x');
});

await t('★ a survivor that reports first disarms its deadline', async () => {
  spyKill();
  try {
    A.registry.clear();
    A.setTimeoutMs(120); // the production deadline is 30 min; this is the same shape
    A.registry.set('codex-3', { pid: 626262, startedAt: Date.now(), mode: 'edit' });
    A.setAlive([626262]);
    A.adoptCodexSurvivor('codex-3', A.registry.get('codex-3'));
    eq(A.codexSurvivorTimers.size, 1, 'a live survivor must be bounded');
    A.registry.delete('codex-3');
    A.releaseCodexSurvivor('codex-3');
    eq(A.codexSurvivorTimers.size, 0);
    await new Promise((r) => setTimeout(r, 250)); // well past when it would have fired
    eq(SIGNALS.length, 0, `signalled after the run was already over: ${JSON.stringify(SIGNALS)}`);
  } finally {
    A.setTimeoutMs(60_000);
    unspyKill();
  }
});

await t('★ an undisarmed timer still refuses to fire once the run is off the registry', async () => {
  // Belt and braces: the reaper clears a registry entry without going through
  // onOutcome, so the fire-time check has to stand on its own.
  spyKill();
  try {
    A.registry.clear();
    A.setTimeoutMs(120);
    A.registry.set('codex-4', { pid: 737373, startedAt: Date.now(), mode: 'edit' });
    A.setAlive([737373]);
    A.adoptCodexSurvivor('codex-4', A.registry.get('codex-4'));
    A.registry.delete('codex-4'); // reaped, no release call
    await new Promise((r) => setTimeout(r, 250));
    eq(SIGNALS.length, 0, `signalled a pid the daemon no longer owns: ${JSON.stringify(SIGNALS)}`);
    eq(A.codexSurvivorTimers.size, 0, 'the fired timer must forget itself');
  } finally {
    A.setTimeoutMs(60_000);
    unspyKill();
  }
});

await t('the deadline is wired into the boot loop, and released when a survivor reports', () => {
  const src = SRC.join('\n');
  ok(/if \(rec\?\.engine === 'codex'\) adoptCodexSurvivor\(id, rec\)/.test(src), 'survivors are not adopted at boot');
  ok(/releaseCodexSurvivor\(runId\)/.test(src), "a survivor's report does not disarm its deadline");
});

// ---------------------------------------------------------------------------
console.log('\n11. drainBgHandoff: what the wall diverts on the bg.mjs path');
// ---------------------------------------------------------------------------
// The `bg.mjs` drop-box is the PRIMARY way a job arrives, and it is a separate
// code path from dispatchPrompt with its own routing decision. Section 8 proves
// the phone path; this proves the terminal one, which is the one the docs make
// promises about.

const QUEUE = path.join(TMP, 'bg-queue.json');
const DRAIN = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import { codexCwdForBrief, codexReasonText, lintCodexBrief, parseEnginePrefix, shouldRouteToCodex, CODEX_LANE } from ${url('bg-codex.mjs')};
import { briefRepo, briefTitle, handoffNotice, stripLaneRules, workerLine, WORKER_TICK_MS, WORKER_IDLE_MS } from ${url('bg-notify.mjs')};
import { claudeMissingLine, resolveEngine } from ${url('engine-state.mjs')};
const { existsSync, readFileSync, writeFileSync, renameSync } = fs;
// The live worker line. Real builder, recorded transport: this file is about
// WHICH ENGINE the drain picks, and the notice rides along so a shape change
// cannot silently stop the drain from putting one up at all.
export const EDITS = [];
let msgSeq = 0;
const editProgress = (id, html) => { EDITS.push({ id, html }); return Promise.resolve(); };
const escHtml = (t) => String(t);
export const LIVE = new Set();
const registerLive = (e) => { LIVE.add(e); return e; };
const BG_PROGRESS_ON = true;
const WORKER_ORPHAN_MS = 120000;
const BG_QUEUE_FILE = ${JSON.stringify(QUEUE)};
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
export const SENT = [];
export const CODEX = [];
export const CLAUDE = [];
const send = (t) => { SENT.push(t); return Promise.resolve({ message_id: ++msgSeq }); };
const runCodex = (text, opts) => { CODEX.push({ text, ...opts }); return { runId: 'codex-1' }; };
const dispatchPrompt = (text, lane) => { CLAUDE.push({ text, lane: lane?.name }); };
export const RECORDED = [];
const recordBgResult = (task, record) => { RECORDED.push({ task, record }); };
const getBgLane = () => ({ name: 'bg', current: null, queue: [] });
export const bgLanes = [];
export let CHAT_CWD = ${JSON.stringify(TMP)};
export const setChatCwd = (p) => { CHAT_CWD = p; };
const chatState = () => ({ cwd: CHAT_CWD });
export const codexRuns = new Map();
export let rotationPausedUntil = 0;
let installed = true;
let fallback = true;
export const setWall = (until, opts = {}) => {
  rotationPausedUntil = until;
  if (opts.installed !== undefined) installed = opts.installed;
  if (opts.fallback !== undefined) fallback = opts.fallback;
};
const codexInstalled = () => installed;
const codexFallbackOn = () => fallback;
const CODEX_MISSING_LINE = 'Codex is not installed';
// The REAL resolver over this harness's state: a mirror of engineFor would keep
// agreeing with itself after engine-state.mjs changed.
export let ENGINE_CFG = {};
export let CHAT_ENGINE_STATE = {};
export const setEngines = (o = {}) => {
  if (o.config !== undefined) ENGINE_CFG = o.config;
  if (o.chat !== undefined) CHAT_ENGINE_STATE = o.chat;
};
const engineFor = (lane, forcedEngine = null) =>
  resolveEngine({
    lane,
    forcedEngine,
    chat: CHAT_ENGINE_STATE,
    config: ENGINE_CFG,
    claudeAvailable: true,
    codexAvailable: installed,
    rotationPausedUntil,
    now: Date.now(),
    codexFallback: fallback,
  });
export const reset = () => {
  SENT.length = 0; CODEX.length = 0; CLAUDE.length = 0; RECORDED.length = 0;
  EDITS.length = 0; LIVE.clear(); workerNotices.clear(); msgSeq = 0;
  rotationPausedUntil = 0; installed = true; fallback = true;
  ENGINE_CFG = {}; CHAT_ENGINE_STATE = {};
  CHAT_CWD = ${JSON.stringify(TMP)};
};
`,
        grab('BG_COMMAND_RE', 'const'),
        grab('unchosenCodex', 'const'),
        grab('workerNotices', 'const'),
        grab('startWorkerNotice'),
        grab('editWorkerNotice'),
        grab('drainBgHandoff'),
        'export { drainBgHandoff, workerNotices };',
      ].join('\n'),
    )
);

// bg.mjs prepends this preamble to every brief, so the guard has to see PAST it.
const laneRules = (job) =>
  `LANE RULES (you are a background worker: headless, no tmux, no terminal).\n1. NEVER use run_in_background.\n\n--- TASK ---\n${job}`;
const queueItems = (...items) => writeFileSync(QUEUE, JSON.stringify(items));

DRAIN.reset();
DRAIN.setWall(WALL);
queueItems({ text: laneRules('/autopilot ship the checkout fix') });
DRAIN.drainBgHandoff();

await t('★ a Claude slash command handed over during the wall does NOT reach Codex', () => {
  // Without this, `codex exec --sandbox workspace-write` is handed the literal
  // text "/autopilot ship the checkout fix" with write access to a repo, by a
  // model that has never heard of the command.
  eq(DRAIN.CODEX.length, 0, 'Codex cannot run a Claude slash command');
  eq(DRAIN.CLAUDE.length, 1, 'it waits on the Claude lane instead');
});

await t('and the notice says WHY it is sitting still', () => {
  // A job on a walled lane does nothing for hours; silence reads as "dropped".
  ok(/waits for the reset/.test(DRAIN.SENT.join('\n')), DRAIN.SENT.join('\n'));
});

DRAIN.reset();
DRAIN.setWall(WALL);
queueItems({ text: laneRules('/autopilot ship the checkout fix'), engine: 'codex' });
DRAIN.drainBgHandoff();

await t('but --engine codex on a slash command is honoured: that is asking for it by name', () => {
  eq(DRAIN.CODEX.length, 1, 'an explicit engine choice is the caller’s to make');
  eq(DRAIN.CLAUDE.length, 0);
});

DRAIN.reset();
DRAIN.setWall(WALL);
DRAIN.setChatCwd(REPO_B);
queueItems({ text: laneRules('# TASK: fix the encoder\nRepo: media-tools\n') });
DRAIN.drainBgHandoff();

await t('a diverted drop-box job runs in the repo its brief names', () => {
  eq(DRAIN.CODEX.length, 1);
  eq(DRAIN.CODEX[0].cwd, REPO_A, 'workspace-write was rooted at the wrong tree');
  eq(DRAIN.CODEX[0].mode, 'edit');
});

DRAIN.reset();
queueItems({ text: laneRules('# TASK: dispatch a qa-agent with model: "opus" over the diff\n'), engine: 'codex' });
DRAIN.drainBgHandoff();

await t('★ case 26: a Claude-shaped brief handed to Codex is RUN, and the warnings ride on the notice', () => {
  // It was asked for by name, so it runs: refusing an explicit --engine choice
  // is not this daemon's call. But bg.mjs strips the LANE RULES header and
  // nothing else, so what reaches Codex still names a subagent and an Anthropic
  // model, billed by the token and then improvised around.
  eq(DRAIN.CODEX.length, 1, 'an explicit engine choice must still be honoured');
  const said = DRAIN.SENT.join('\n');
  ok(/does not have/.test(said), said);
  ok(/qa-agent/.test(said), said);
  ok(/opus/.test(said), said);
});

DRAIN.reset();
queueItems({ text: laneRules('# TASK: fix the retry loop in src/encoder.ts and run npm test\n'), engine: 'codex' });
DRAIN.drainBgHandoff();

await t('and a clean brief gets no warning at all', () => {
  eq(DRAIN.CODEX.length, 1);
  ok(!/does not have/.test(DRAIN.SENT.join('\n')), DRAIN.SENT.join('\n'));
});

DRAIN.reset();
queueItems({ text: laneRules('# TASK: fix the encoder\n') });
DRAIN.drainBgHandoff();

await t('with Claude healthy the drop-box path still goes to Claude', () => {
  eq(DRAIN.CODEX.length, 0);
  eq(DRAIN.CLAUDE.length, 1);
  ok(!/waits for the reset/.test(DRAIN.SENT.join('\n')), 'nothing is waiting for anything');
});

// ---------------------------------------------------------------------------
console.log('\n12. the Codex CHAT lane: the thread, the lane, and where the answer goes');
// ---------------------------------------------------------------------------
// The chat lane is not a background job. It occupies LANES.main so the queue,
// /stop and /status work, it CONTINUES a thread so a follow-up is a follow-up,
// and its answer goes back through sendResult rather than through the worker
// handback path. Run against the fake binary, which echoes its argv and its
// thread id back, so all four are assertable with no OpenAI spend.

const CHAT_RUNS = path.join(TMP, 'chat-runs');
const CHAT_ARGV = path.join(TMP, 'chat-argv.txt');
const CHAT_FAKE = path.join(TMP, 'fake-codex-chat');
writeFileSync(
  CHAT_FAKE,
  `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(CHAT_ARGV)}
last=""
prev=""
is_resume=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then last="$a"; fi
  if [ "$a" = "resume" ]; then is_resume=1; fi
  prev="$a"
done
prompt=$(cat)
# The MEASURED dead-thread failure, reproduced exactly: exit 1, the error on
# stderr, and no thread.started event at all.
if [ -n "\${CODEX_FAKE_DEAD_THREAD:-}" ] && [ -n "$is_resume" ]; then
  echo 'Error: thread/resume: thread/resume failed: no rollout found for thread id th-abc-123 (code -32600)' >&2
  exit 1
fi
echo '{"type":"thread.started","thread_id":"th-abc-123"}'
echo "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":\\"FAKE:\${prompt}\\"}}"
echo '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}'
[ -n "$last" ] && printf 'FAKE:%s' "$prompt" > "$last"
exit 0
`,
);
chmodSync(CHAT_FAKE, 0o755);

const C = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import { spawnWorker } from ${url('detached-workers.mjs')};
import {
  CODEX_LANE, buildCodexArgs, codexChatError, codexOutcome, codexPaths, codexRunId, codexStartNotice,
  codexThinkingLine, freeCodexStart, fmtCodexTokens, isCodexImage,
} from ${url('bg-codex.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-notify.mjs')};
import { codexChatSandbox } from ${url('engine-state.mjs')};
import { execFallbackLine } from ${url('codex-appserver.mjs')};
const { existsSync, mkdirSync, writeFileSync, readFileSync } = fs;
export const SENT = [];
export const RESULTS = [];
export const HANDBACKS = [];
export const PROGRESS = [];
export const RECORDED = [];
export const STATE = { cwd: ${JSON.stringify(TMP)}, yolo: true };
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const sendResult = (t) => { RESULTS.push(t); return Promise.resolve(); };
// Present ONLY so a test can prove it is never called: a chat answer routed
// through the worker handback would reach the owner as somebody else's report.
const handBackToChat = (t) => { HANDBACKS.push(t); };
const recordBgResult = (task, record) => { RECORDED.push({ task, record }); };
export const RING = [];
const recordChatTurn = (e) => { RING.push(e); };
const pathsFromCodexLog = () => [];
const COMMAND_NAMES = [];
const chatState = () => STATE;
export let SAVED = 0;
const saveState = () => { SAVED++; };
export const LANES = { main: { name: 'main', current: null, queue: [], finishing: 0 } };
export const DRAINED = [];
// The Codex chat lane now settles the worker lines waiting on "reading it
// now…" when M's turn ends, so this harness has to provide it: without it the
// finally threw and the lane was never given back.
export const READING_SETTLED = [];
const settleReadingNotices = () => { READING_SETTLED.push(Date.now()); };
const drainQueue = (l) => { DRAINED.push(l.name); };
const CHAT_ID = '1';
const EDIT_INTERVAL_MS = 50;
const TYPING_INTERVAL_MS = 50;
const escHtml = (s) => String(s);
const fmtElapsed = (s) => s + 's';
let msgId = 0;
export const TG = [];
const tg = (method, payload) => { TG.push({ method, payload }); if (method === 'sendMessage') return Promise.resolve({ message_id: ++msgId }); return Promise.resolve({}); };
const editProgress = (id, html, plain) => { PROGRESS.push(plain()); return Promise.resolve(); };
export const codexRuns = new Map();
export const registry = new Map();
const inflight = { add: (id, rec) => registry.set(id, rec), clear: (id) => registry.delete(id), read: () => Object.fromEntries(registry) };
const closeStdin = (c) => { try { c?.stdin?.destroy(); } catch {} };
const reportCodexOutcome = (task, outcome, runId, meta) => { HANDBACKS.push({ task, outcome, runId, meta }); };
export const WALL = [];
const noteCodexWall = () => { WALL.push('set'); return Date.now() + 3600000; };
const clearCodexWall = () => { WALL.push('clear'); };
export let codexPausedUntil = 0;
export let RUNS_DIR = ${JSON.stringify(CHAT_RUNS)};
export let CODEX_BIN = ${JSON.stringify(CHAT_FAKE)};
export let CODEX_TIMEOUT_MS = 30000;
const CODEX_MODEL = null;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
export let CODEX_SETTINGS = { model: null, effort: null };
export const setCodexSettings = (v) => { CODEX_SETTINGS = v; };
const codexSettingsNow = () => CODEX_SETTINGS;
const conf = (key, fallback) => (key in CONF ? CONF[key] : fallback);
// conf() can hand back a string (the environment layer), so the real code reads
// its booleans through confBool. Same coercion here, or an extracted function
// would call an undefined name.
const confBool = (k, f) => {
  const v = conf(k, f);
  if (typeof v !== 'string') return Boolean(v);
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return Boolean(f);
};
export const CONF = {};
const codexChatBox = ({ network = null } = {}) =>
  codexChatSandbox({ yolo: STATE.yolo !== false, network: network === false ? false : STATE.codexNetwork !== false });
export const reset = () => {
  SENT.length = 0; RESULTS.length = 0; HANDBACKS.length = 0; PROGRESS.length = 0;
  RECORDED.length = 0; DRAINED.length = 0; TG.length = 0; RING.length = 0; codexRuns.clear(); registry.clear();
  SAVED = 0; CODEX_SETTINGS = { model: null, effort: null };
  LANES.main.current = null; LANES.main.queue.length = 0; LANES.main.finishing = 0;
  delete STATE.codexThreadId; delete STATE.codexThreadAt; STATE.yolo = true; delete STATE.codexNetwork;
  for (const k of Object.keys(CONF)) delete CONF[k];
};
`,
        grab('readTextIf', 'const'),
        grab('writeCodexMeta'),
        grab('finalizeCodexMeta'),
        grab('rememberCodexThread'),
        grab('clearCodexThread'),
        grab('runCodex'),
        // The EXEC chat path, which is now the fallback rather than the only
        // rail. Section 19 covers the app-server one against its own fake
        // server; everything asserted below is still exactly what happens on a
        // machine whose `codex` has no app-server, so it is grabbed under its
        // new name and tested unchanged.
        grab('runCodexChatExec'),
        'const runCodexChat = runCodexChatExec;',
        'export { runCodex, runCodexChat, runCodexChatExec, rememberCodexThread, clearCodexThread };',
      ].join('\n'),
    )
);

const chatSettled = (ms = 15000) =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      if (C.RESULTS.length || C.SENT.some((x) => String(x).startsWith('❌ Codex'))) return resolve();
      if (Date.now() - at > ms) return reject(new Error('the codex chat turn never reported'));
      setTimeout(tick, 25);
    };
    tick();
  });

C.reset();
writeFileSync(CHAT_ARGV, '');
const chatRun = C.runCodexChat('what is in this repo');

await t('★ the chat turn claims LANES.main, so a message sent mid-turn QUEUES', () => {
  // Codex takes no mid-run input. The run carries no `steer`, which is what
  // makes dispatchPrompt fall through to the queue instead of pretending.
  ok(C.LANES.main.current, 'the lane was not claimed');
  eq(C.LANES.main.current.engine, 'codex');
  eq(typeof C.LANES.main.current.steer, 'undefined', 'a steerable Codex run would ack a lie');
  ok(typeof C.LANES.main.current.terminate === 'function', '/stop has to be able to reach it');
});

await chatSettled();

await t('★ no token count on the EXEC chat bubble either', () => {
  // This is the bubble the owner was actually looking at when he said the in
  // and out tokens should not be there, so the fallback path has to be clean
  // too, not just the app-server one.
  const said = [...C.PROGRESS, ...C.SENT, ...C.RESULTS].join('\n');
  ok(!/\bin \/|out tokens\b/.test(said), `a token count reached the bubble: ${said}`);
});

await t('★ the answer goes back as a CHAT reply, not as a worker handback', () => {
  eq(C.RESULTS.length, 1, 'the owner gets his answer through sendResult');
  ok(C.RESULTS[0].includes('what is in this repo'), C.RESULTS[0]);
  eq(C.HANDBACKS.length, 0, 'a chat answer routed through the handback arrives as somebody else’s report');
});

await t('★ the thread id is captured and stored, and never rendered', () => {
  eq(C.STATE.codexThreadId, 'th-abc-123');
  ok(C.STATE.codexThreadAt > 0, 'the age shown in /status comes from this');
  const everythingSaid = [...C.SENT, ...C.RESULTS, ...C.PROGRESS].join('\n');
  ok(!everythingSaid.includes('th-abc-123'), `the thread id reached a chat bubble: ${everythingSaid}`);
});

await t('the first turn starts a thread rather than resuming one', () => {
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(!/\bresume\b/.test(argv), argv);
  ok(/--sandbox workspace-write/.test(argv), argv);
  ok(/sandbox_workspace_write.network_access=true/.test(argv), 'yolo on means network on');
  ok(!/dangerously/.test(argv), 'the bypass flag must never be emitted');
  ok(!/approve-for-me/.test(argv), 'the soft bypass flag must never be emitted either');
  ok(!/--ephemeral/.test(argv), 'an ephemeral run leaves no thread to resume');
});

await t('the lane is given back and the queue drained', () => {
  eq(C.LANES.main.current, null);
  ok(C.DRAINED.includes('main'), 'a queued message would sit forever');
});

await t('★ case 52: a chat turn lands in the CHAT RING, not in the background results log', () => {
  // bg-results.jsonl keeps the last 50 rows across every producer, so a busy
  // Codex chat evicted the background job history the owner asks about later,
  // one row per turn.
  eq(C.RECORDED.length, 0, 'a chat turn is still evicting background job history');
  eq(C.RING.length, 2, 'the turn left no durable record at all');
  eq(C.RING[0].role, 'user');
  eq(C.RING[0].engine, 'codex');
  ok(C.RING[0].text.includes('what is in this repo'), C.RING[0].text);
  eq(C.RING[1].role, 'assistant');
  ok(C.RING[1].text.includes('what is in this repo'), C.RING[1].text);
});

// --- turn two: the same thread ---
writeFileSync(CHAT_ARGV, '');
C.SENT.length = 0;
C.RESULTS.length = 0;
C.PROGRESS.length = 0;
C.runCodexChat('and what about the other one');
await chatSettled();

await t('★ the SECOND turn resumes that thread instead of meeting the repo cold', () => {
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(/\bresume th-abc-123\b/.test(argv), argv);
  // `codex exec resume` has no --sandbox and no -C: both are instant exit-2
  // runs. The sandbox goes through the config layer, the cwd through the child.
  ok(!/--sandbox/.test(argv), 'exec resume refuses --sandbox');
  ok(!/ -C /.test(argv), 'exec resume refuses -C');
  ok(!/--color/.test(argv), 'exec resume refuses --color');
  ok(/sandbox_mode=workspace-write/.test(argv), 'the sandbox still has to be applied, via config');
});

await t('the resumed turn still answers into the chat', () => {
  eq(C.RESULTS.length, 1);
  ok(C.RESULTS[0].includes('and what about the other one'), C.RESULTS[0]);
});

// --- /new clears it ---
await t('★ /new clears the thread, and the next turn starts cold', async () => {
  const had = C.clearCodexThread();
  eq(had, true);
  eq(C.STATE.codexThreadId, undefined);
  eq(C.STATE.codexThreadAt, undefined);
  writeFileSync(CHAT_ARGV, '');
  C.RESULTS.length = 0;
  C.runCodexChat('starting over');
  await chatSettled();
  ok(!/\bresume\b/.test(readFileSync(CHAT_ARGV, 'utf8')), 'the thread survived a /new');
});

await t('clearing a thread that is not there reports honestly', () => {
  C.reset();
  eq(C.clearCodexThread(), false, 'saying "cleared" over nothing is a small lie');
});

// --- yolo off ---
await t('★ /yolo off makes the chat lane read-only', async () => {
  C.reset();
  C.STATE.yolo = false;
  writeFileSync(CHAT_ARGV, '');
  C.runCodexChat('just look, do not touch');
  await chatSettled(); // the child writes its own argv, so read it after it ran
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(/--sandbox read-only/.test(argv), argv);
  ok(!/network_access/.test(argv), 'read-only must not advertise network access');
});

// --- images ---
await t('★ only IMAGE files reach -i; a pdf is named in the prompt as before', async () => {
  C.reset();
  writeFileSync(CHAT_ARGV, '');
  const png = path.join(TMP, 'shot.png');
  const pdf = path.join(TMP, 'contract.pdf');
  writeFileSync(png, 'x');
  writeFileSync(pdf, 'x');
  C.runCodexChat('what is this', { images: [png, pdf] });
  await chatSettled();
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(argv.includes(`-i ${png}`), argv);
  ok(!argv.includes(pdf), 'a pdf handed to -i is an error the CLI reports as a bad image');
});

await t('the image mime test is by extension, and it is not fooled by a name', () => {
  ok(isCodexImage('/inbox/photo_1.jpg'));
  ok(isCodexImage('/inbox/A.PNG'));
  ok(isCodexImage('/inbox/x.webp'));
  ok(!isCodexImage('/inbox/png'), 'no extension is not an extension');
  ok(!isCodexImage('/inbox/report.pdf'));
  ok(!isCodexImage('/inbox/clip.mp4'));
  ok(!isCodexImage('/inbox/notes.png.txt'), 'the extension is the LAST one');
  ok(!isCodexImage(null));
});

// --- the model and effort settings reach every run ---
await t('★ /codex model and /codex effort reach the argv of a chat turn', async () => {
  C.reset();
  C.setCodexSettings({ model: 'gpt-5.6-sol', effort: 'xhigh' });
  writeFileSync(CHAT_ARGV, '');
  C.runCodexChat('think hard');
  await chatSettled();
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(/-m gpt-5.6-sol/.test(argv), argv);
  ok(/model_reasoning_effort=xhigh/.test(argv), argv);
});

await t('★ a resume onto a DEAD thread clears the id and retries cold in the same turn', async () => {
  // Measured: `codex exec resume <an id OpenAI no longer has>` exits 1 with
  // "no rollout found for thread id" and emits no thread.started, so the dead
  // id was never replaced and EVERY later message failed identically, with
  // nothing saying that /new was the cure.
  C.reset();
  C.STATE.codexThreadId = 'th-abc-123';
  C.STATE.codexThreadAt = Date.now() - 60_000;
  writeFileSync(CHAT_ARGV, '');
  process.env.CODEX_FAKE_DEAD_THREAD = '1';
  try {
    C.runCodexChat('what is the open question', { prompt: 'HANDOFF-BLOCK\n\nwhat is the open question' });
    await chatSettled();
  } finally {
    delete process.env.CODEX_FAKE_DEAD_THREAD;
  }
  const runs = readFileSync(CHAT_ARGV, 'utf8').trim().split('\n');
  eq(runs.length, 2, `expected a failed resume and one cold retry, got ${runs.length}: ${runs.join(' | ')}`);
  ok(/\bresume th-abc-123\b/.test(runs[0]), runs[0]);
  ok(!/\bresume\b/.test(runs[1]), `the retry resumed the dead thread again: ${runs[1]}`);
  ok(C.SENT.join('\n').includes('thread is gone'), `nothing told the owner: ${C.SENT.join('\n')}`);
  eq(C.RESULTS.length, 1, 'the retry has to ANSWER, not just restart');
  ok(C.RESULTS[0].includes('HANDOFF-BLOCK'), `the cold turn dropped the handoff: ${C.RESULTS[0]}`);
  ok(C.RESULTS[0].includes('what is the open question'), C.RESULTS[0]);
  eq(C.STATE.codexThreadId, 'th-abc-123', 'the cold run\'s own thread id must be stored');
});

await t('and the retry is bounded: a cold run that fails is reported, not retried again', async () => {
  C.reset();
  C.STATE.codexThreadId = 'th-abc-123';
  writeFileSync(CHAT_ARGV, '');
  process.env.CODEX_FAKE_DEAD_THREAD = '1';
  try {
    // retriedCold: the caller has already spent its one retry.
    C.runCodexChat('again', { retriedCold: true });
    await chatSettled();
  } finally {
    delete process.env.CODEX_FAKE_DEAD_THREAD;
  }
  eq(readFileSync(CHAT_ARGV, 'utf8').trim().split('\n').length, 1, 'it retried past its bound');
  const said = C.SENT.join('\n');
  ok(said.includes('❌ Codex'), said);
  ok(said.includes('/new'), `the remedy line is what makes this recoverable by hand: ${said}`);
});

await t('★ case 48: the first Codex turn carrying a handoff runs with NO network access', async () => {
  // This is the one new exfiltration surface the handoff creates: model-written
  // text entering a workspace-write run that can also reach the internet. One
  // turn, announced, and `codexHandoffNetwork: true` turns the narrowing off.
  C.reset();
  writeFileSync(CHAT_ARGV, '');
  C.runCodexChat('continue where we left off', { prompt: 'HANDOFF\n\ncontinue', carriesHandoff: true });
  await chatSettled();
  const first = readFileSync(CHAT_ARGV, 'utf8');
  ok(/--sandbox workspace-write/.test(first), `it must still be able to WRITE: ${first}`);
  ok(!/network_access=true/.test(first), `the handoff turn kept network access: ${first}`);

  writeFileSync(CHAT_ARGV, '');
  C.RESULTS.length = 0;
  C.runCodexChat('and the next one');
  await chatSettled();
  const second = readFileSync(CHAT_ARGV, 'utf8');
  ok(/network_access=true/.test(second), `the narrowing outlived its one turn: ${second}`);
});

await t('and codexHandoffNetwork: true opts back out of the narrowing', async () => {
  C.reset();
  C.CONF.codexHandoffNetwork = true;
  writeFileSync(CHAT_ARGV, '');
  C.runCodexChat('continue', { prompt: 'HANDOFF\n\ncontinue', carriesHandoff: true });
  await chatSettled();
  ok(/network_access=true/.test(readFileSync(CHAT_ARGV, 'utf8')), 'the config opt-out did nothing');
});

await t('/codex network off narrows every workspace-write turn, handoff or not', async () => {
  C.reset();
  C.STATE.codexNetwork = false;
  writeFileSync(CHAT_ARGV, '');
  C.runCodexChat('just this');
  await chatSettled();
  const argv = readFileSync(CHAT_ARGV, 'utf8');
  ok(/--sandbox workspace-write/.test(argv), argv);
  ok(!/network_access=true/.test(argv), argv);
});

// ---------------------------------------------------------------------------
console.log('\n13. /engine survives a restart (the state.json round trip)');
// ---------------------------------------------------------------------------
// /engine writes to the same per-chat state every other setting uses, so the
// thing worth proving is that what is written is what comes back: a Codex-first
// chat must still be Codex-first after a `safe-restart.sh`.

const STATE_FILE = path.join(TMP, 'state.json');

await t('★ engine, model, effort and the thread all survive a save/load cycle', async () => {
  const { chatEngine: ce, bgEngine: be, codexSettings: cs } = await import('./engine-state.mjs');
  const before = {
    chats: { '1': { cwd: '/x', engineChat: 'codex', engineBg: 'codex', codexModel: 'o3', codexEffort: 'high', codexThreadId: 'th-9', codexThreadAt: 1788000000000 } },
  };
  writeFileSync(STATE_FILE, JSON.stringify(before));
  const after = JSON.parse(readFileSync(STATE_FILE, 'utf8')).chats['1'];
  eq(ce({ chat: after, config: {} }), 'codex', 'the chat lane forgot its engine across a restart');
  eq(be({ chat: after, config: {} }), 'codex');
  eq(cs({ chat: after, config: {} }).model, 'o3');
  eq(cs({ chat: after, config: {} }).effort, 'high');
  eq(after.codexThreadId, 'th-9', 'the conversation would restart cold after every daemon restart');
});

await t('a chat with nothing stored falls back to the CONFIG after a restart', async () => {
  const { chatEngine: ce } = await import('./engine-state.mjs');
  writeFileSync(STATE_FILE, JSON.stringify({ chats: { '1': { cwd: '/x' } } }));
  const after = JSON.parse(readFileSync(STATE_FILE, 'utf8')).chats['1'];
  eq(ce({ chat: after, config: { engine: { chat: 'codex' } } }), 'codex');
  eq(ce({ chat: after, config: {} }), 'claude');
});

// ---------------------------------------------------------------------------
console.log('\n14. Codex-first boot: no `claude` binary anywhere');
// ---------------------------------------------------------------------------
// A Leash user whose primary engine is Codex may have no Claude at all. The
// daemon has to BOOT on that machine, not crash at the first lane resolution,
// and the routing has to keep working. bridge.mjs cannot be imported (it runs
// main() and would attach a second daemon to the live bot), so this proves the
// two halves separately: the boot-time detection against a fake empty PATH, and
// the routing decisions it feeds.

const B14 = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import path from 'node:path';
const { existsSync } = fs;
`,
        grab('onPath'),
        'export { onPath };',
      ].join('\n'),
    )
);

const realPath = process.env.PATH;

await t('★ with an EMPTY PATH, neither binary is found and nothing throws', () => {
  process.env.PATH = '';
  try {
    eq(B14.onPath('claude'), false);
    eq(B14.onPath('codex'), false);
  } finally {
    process.env.PATH = realPath;
  }
});

await t('a fake PATH holding only codex finds codex and not claude', () => {
  const fakeBin = path.join(TMP, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, 'codex'), '#!/bin/bash\nexit 0\n');
  chmodSync(path.join(fakeBin, 'codex'), 0o755);
  process.env.PATH = fakeBin;
  try {
    eq(B14.onPath('codex'), true);
    eq(B14.onPath('claude'), false, 'this is the whole Codex-first configuration');
  } finally {
    process.env.PATH = realPath;
  }
});

await t('an absolute path is checked as a file, not searched for on PATH', () => {
  // CLAUDE_BIN resolves to an absolute path on a normal install, so the two
  // shapes have to behave differently and both have to work.
  eq(B14.onPath(CHAT_FAKE), true);
  eq(B14.onPath('/nope/not/here'), false);
});

await t('★ with no claude, every routing decision still resolves', async () => {
  const { resolveEngine: re } = await import('./engine-state.mjs');
  const noClaude = { claudeAvailable: false, codexAvailable: true };
  // The chat lane, the bg lane, and both under a wall that is now meaningless.
  eq(re({ lane: 'chat', config: { engine: { chat: 'codex', bg: 'codex' } }, ...noClaude }).engine, 'codex');
  eq(re({ lane: 'bg', config: { engine: { chat: 'codex', bg: 'codex' } }, ...noClaude }).engine, 'codex');
  eq(re({ lane: 'chat', rotationPausedUntil: WALL, ...noClaude }).engine, 'codex');
  eq(re({ lane: 'chat', forcedEngine: 'claude', ...noClaude }).reason, 'claude_missing');
  for (const d of [
    re({ lane: 'chat', ...noClaude }),
    re({ lane: 'bg', ...noClaude }),
    re({ lane: 'chat', forcedEngine: 'codex', ...noClaude }),
  ]) {
    eq(d.error, null, 'a Codex-first machine must never produce a routing error');
    ok(d.engine, 'every lane must resolve to something runnable');
  }
});

await t('★ bridge.mjs still parses, and the boot path consults the detection', () => {
  // `node --check`, since the module cannot be imported.
  execFileSync(process.execPath, ['--check', path.join(DIR, 'bridge.mjs')]);
  const src = SRC.join('\n');
  ok(/const CLAUDE_AVAILABLE = onPath\(CLAUDE_BIN\)/.test(src), 'the daemon does not detect claude at boot');
  ok(/const CODEX_AVAILABLE = onPath\(CODEX_BIN\)/.test(src), 'the daemon does not detect codex at boot');
  ok(/if \(!CLAUDE_AVAILABLE && isClaudeOnlyCommand\(cmd\)\)/.test(src), 'claude-only commands are not gated');
  ok(/if \(!CLAUDE_AVAILABLE\) \{\n\s*console\.log\('\[bridge\] limit death on a machine with no claude/.test(src), 'rotation is not skipped');
});

await t('★ with no codex, a codex lane refuses cleanly rather than running on Claude', async () => {
  const { resolveEngine: re } = await import('./engine-state.mjs');
  const d = re({ lane: 'chat', chat: { engineChat: 'codex' }, claudeAvailable: true, codexAvailable: false });
  eq(d.engine, null);
  eq(d.error, 'codex_missing');
  // And every entry point has a line to send back rather than a stack trace.
  const src = SRC.join('\n');
  const missingChecks = (src.match(/decision\.error === 'codex_missing'/g) || []).length;
  ok(missingChecks >= 2, `only ${missingChecks} dispatch paths handle a missing codex`);
  ok(/const CODEX_MISSING_LINE = /.test(src), 'there is no line to send');
});

// ---------------------------------------------------------------------------
console.log('\n15. what the QA pass found: busy lanes, unchosen engines, dropped briefs');
// ---------------------------------------------------------------------------
// Every assertion here failed before its fix. They share one shape: three
// places treated "the decision said codex" as one thing regardless of WHY, and
// one skipped the resolution entirely.

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.LANES.main.current = { prompt: 'the turn already running', startedAt: Date.now(), engine: 'codex' };
P.dispatchPrompt('a second message while it is thinking', undefined, { allowCodexFallback: true });

await t('★ a message sent mid-Codex-turn QUEUES; it does not start a second run', () => {
  // Without the busy check this claimed lane.current out from under the first
  // turn and BOTH kept running: two `codex exec resume` on the same thread,
  // both billed, both writing, and /stop reaching only the second.
  eq(P.CODEX_CHAT.length, 0, 'a second concurrent Codex turn was started');
  eq(P.LANES.main.queue.length, 1, 'the message was neither run nor queued');
  ok(P.SENT.join('\n').includes('Queued'), P.SENT.join('\n'));
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.dispatchPrompt('what is in this repo', undefined, { allowCodexFallback: true });

await t('and on an idle lane it runs, claiming nothing twice', () => {
  eq(P.CODEX_CHAT.length, 1);
  eq(P.LANES.main.queue.length, 0);
});

P.reset();
P.LANES.main.current = { prompt: 'a claude turn', startedAt: Date.now(), steer: () => true };
P.dispatchPrompt('codex: what do you make of this', undefined, { allowCodexFallback: true });

await t('★ an engine-pinned message is never STEERED into a run on the other engine', () => {
  // Steering it would honour the lane and silently lose the engine choice,
  // while the reply still said "sent into the running task".
  eq(P.LANES.main.queue.length, 1, 'it must wait for its own engine');
  ok(!P.SENT.join('\n').includes('Sent into the running task'), P.SENT.join('\n'));
});

P.reset();
P.setEngines({ claudeAvailable: false });
P.dispatchPrompt('/autopilot ship the payments refactor', undefined, { allowCodexFallback: true });

await t('★ a Claude slash command is refused on a Codex-first machine, not run in EDIT mode', () => {
  // The guard used to key off `claude_limited` alone, so on a machine with no
  // claude the reason was `claude_missing` and the literal text
  // "/autopilot ship the payments refactor" was spawned as a workspace-write
  // Codex run rooted at the workspace.
  eq(P.CODEX.length, 0, 'Codex was handed a command it has never heard of, with write access');
  ok(P.SENT.join('\n').includes('needs Claude'), P.SENT.join('\n'));
});

P.reset();
P.setWall(WALL);
P.dispatchPrompt('bg: /autopilot ship it', undefined, { allowCodexFallback: true });

await t('and during a WALL the same command waits, as it always did', () => {
  eq(P.CODEX.length, 0);
  eq(P.CLAUDE.length, 1, 'it waits on the Claude lane');
});

P.reset();
P.dispatchPrompt('bg: codex: /autopilot ship it', undefined, { allowCodexFallback: true });

await t('but naming the engine explicitly is honoured: that is someone choosing', () => {
  eq(P.CODEX.length, 1, 'an explicit --engine/prefix on a slash command is the caller’s call');
});

P.reset();
P.dispatchPrompt('codex: bg: run the full suite', undefined, { allowCodexFallback: true });

await t('★ `codex: bg: …` lands on the BG lane, and the prompt carries no "bg: "', () => {
  // The engine prefix used to be stripped after `bg:`, so this stayed on the
  // chat lane AND lost the engine choice AND leaked "bg: " into the prompt.
  eq(P.CODEX.length, 1, `wrong lane: ${JSON.stringify({ codex: P.CODEX, chat: P.CODEX_CHAT, claude: P.CLAUDE })}`);
  eq(P.CODEX[0].mode, 'edit');
  ok(!P.CODEX[0].text.startsWith('bg:'), P.CODEX[0].text);
  eq(P.CODEX[0].text, 'run the full suite');
});

P.reset();
P.dispatchPrompt('bg: codex: run the full suite', undefined, { allowCodexFallback: true });

await t('and the other order works identically', () => {
  eq(P.CODEX.length, 1);
  eq(P.CODEX[0].text, 'run the full suite');
});

P.reset();
P.setEngines({ codexAvailable: false, chat: { engineChat: 'codex' } });
P.dispatchPrompt('what is in this repo', undefined, { allowCodexFallback: true });

await t('a chat lane set to a codex that is not installed says so, and runs nothing', () => {
  eq(P.CODEX_CHAT.length, 0);
  eq(P.CLAUDE.length, 0, 'silently answering from the same family is worse than an error');
  ok(P.SENT.join('\n').includes('not installed'), P.SENT.join('\n'));
});

// --- the drop-box must never destroy a claimed brief ----------------------
DRAIN.reset();
DRAIN.setWall(0, { installed: false });
queueItems({ text: laneRules('# TASK: rebuild the index\n'), engine: 'codex' });
DRAIN.drainBgHandoff();

await t('★ a brief no engine can run is REFUSED BY NAME and still recorded', () => {
  // The queue file is claimed before the loop, so a bare `continue` destroyed
  // the brief with no dispatch, no row and no report.
  eq(DRAIN.CODEX.length, 0);
  eq(DRAIN.CLAUDE.length, 0);
  const said = DRAIN.SENT.join('\n');
  ok(said.includes('not installed'), said);
  ok(said.includes('rebuild the index'), `the refusal did not name the job: ${said}`);
  eq(DRAIN.RECORDED.length, 1, 'nothing was left in bg-results.jsonl');
  ok(/no engine available/.test(DRAIN.RECORDED[0].record), JSON.stringify(DRAIN.RECORDED[0]));
});

await t('the wiring for a Codex-first machine keeps every internal turn deliverable', () => {
  const src = SRC.join('\n');
  // A handback, a scheduled run: task and the parked-Codex note are all
  // priority dispatches that used to spawn `claude` unconditionally, which on a
  // Codex-first machine answered with "spawn claude ENOENT" and lost the
  // payload. Both runClaude call sites are gated now.
  const gated = (src.match(/if \(!CLAUDE_AVAILABLE\) \{\n\s*deliverWithoutClaude\(/g) || []).length;
  eq(gated, 2, `only ${gated} of the 2 runClaude call sites check for the binary`);
  ok(/function deliverWithoutClaude\(text\)/.test(src), 'there is nowhere for an unsummarised note to go');
});

await t('a voice note takes the engine like every other thing he sends', () => {
  const src = SRC.join('\n');
  ok(
    /dispatchPrompt\(caption \? `\$\{caption\}\\n\\n\$\{heard\}` : heard, undefined, \{ allowCodexFallback: true \}\)/.test(src),
    'the transcribed voice note still hard-routes to Claude',
  );
});

await t('★ case 33: a voice note that cannot be transcribed SAYS so, and names the engine', () => {
  // transcribeVoice returns null with no OpenAI key and that null fell through
  // silently, so the run was handed a prompt naming an .ogg neither engine can
  // hear. A ChatGPT-subscription Codex install has no OpenAI key by definition,
  // which makes this the default state for a Codex-first user.
  const src = SRC.join('\n');
  const media = src.slice(src.indexOf('async function handleMedia'), src.indexOf('async function handleUpdate'));
  ok(/voiceUntranscribedLine\(chatLaneEngine\(\)\)/.test(media), 'the no-key path still says nothing at all');
  ok(!/handing the audio file to Claude/.test(src), 'the warning still names an engine the dispatch may not use');
});

await t('/cd clears the Codex thread: the cwd IS the sandbox root', () => {
  const src = SRC.join('\n');
  const cd = src.slice(src.indexOf("case '/cd': {"), src.indexOf("case '/status': {"));
  ok(/clearCodexThread\(\)/.test(cd), 'a resumed thread would run with write access to a different repo');
});

await t('★ case 9: /resume clears the Codex thread whenever it MOVES the cwd', () => {
  // This arm set st.cwd from the archive entry with no clearCodexThread() at
  // all, so resuming a chat recorded in repo A while the Codex thread's whole
  // context is repo B is the same wrong-tree-edit hazard /cd guards, reached
  // by a different command.
  const src = SRC.join('\n');
  const resume = src.slice(src.indexOf("case '/resume': {"), src.indexOf("case '/compact': {"));
  ok(/const movesCwd = /.test(resume), 'the cwd move is not even detected');
  ok(/clearCodexThread\(\)/.test(resume), 'the thread survives a cwd move');
  ok(/dropHandoff\(st\)/.test(resume), 'a handoff full of stale paths survives a cwd move');
  ok(/Codex thread cleared/.test(resume), '/cd says it and /resume must too');
  // And only when it MOVES: resuming a chat in the same directory must not
  // throw away a live thread for nothing.
  ok(/movesCwd \? clearCodexThread\(\) : false/.test(resume), resume.slice(0, 400));
});

await t('/new and /cd drop the stored handoff as well as the thread', () => {
  const src = SRC.join('\n');
  const nw = src.slice(src.indexOf("case '/new': {"), src.indexOf("case '/rename': {"));
  const cd = src.slice(src.indexOf("case '/cd': {"), src.indexOf("case '/status': {"));
  ok(/dropHandoff\(st\)/.test(nw), '/new leaves a handoff to be injected into the fresh chat');
  ok(/dropHandoff\(st\)/.test(cd), '/cd leaves a handoff whose paths are now stale');
});

// ---------------------------------------------------------------------------
console.log('\n15b. both engines walled at once');
// ---------------------------------------------------------------------------
// There was no Codex wall at all: codex-account.mjs has normalized the two
// ChatGPT windows since the second engine landed and the only consumers were
// the two /account renders, so a run that hit the window failed with raw text
// and the next message retried straight into it.

P.reset();
P.setWall(WALL);
P.setCodexWall(WALL);
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });

await t('★ with BOTH engines out the message is parked, not spun against two walls', () => {
  eq(P.CLAUDE.length, 0);
  eq(P.CODEX.length, 0);
  eq(P.CHAT_FALLBACK.length, 0, 'the Codex fallback IS the wall he just hit');
  eq(P.parkedWalledChats.length, 1, 'the message was dropped, which is worse than either failure');
});

await t('and ONE line names both reset clocks', () => {
  // Told only about Claude he waits for a reset that will not help, and told
  // only about Codex he does the same.
  const said = P.SENT.join('\n');
  ok(/Both engines are out/.test(said), said);
  ok(/Claude/.test(said) && /Codex/.test(said), said);
  ok(/parked/.test(said), said);
});

P.reset();
P.setWall(WALL);
P.setCodexWall(WALL);
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });
// The notice is sent on a microtask (raiseWall is async and the dispatch does
// not await it, so a failed send can never block the parking). In production
// the flush runs from the poll loop, minutes to hours later; here it has to be
// let through by hand or the flush finds no notice to edit.
await new Promise((r) => setTimeout(r, 0));
P.setCodexWall(0); // the ChatGPT window came back first
P.flushParkedWalledChats();

await t('★ whichever engine returns first runs the parked message, by itself', () => {
  eq(P.parkedWalledChats.length, 0, 'it stayed parked after a wall lifted');
  eq(P.CHAT_FALLBACK.length, 1, 'Claude is still walled, so this is the degraded Codex answer');
});

await t('★ the wall notice BECOMES the back line rather than being followed by one', () => {
  // One message per event. A second "an engine is back" under a notice still
  // saying "both engines are out" is two objects for one wait, and the stale
  // one is the one he scrolls to first.
  eq(P.SENT.length, 1, `a second message was sent:\n${P.SENT.join('\n---\n')}`);
  const last = P.EDITS[P.EDITS.length - 1];
  ok(last, 'the notice was never resolved at all');
  ok(/Codex is back/.test(last.html), `the engine that returned is named: ${last.html}`);
  ok(/running 1 parked/.test(last.html), last.html);
});

await t('★ and it never edits again after that terminal state', () => {
  const before = P.EDITS.length;
  P.flushParkedWalledChats();
  eq(P.wallNotices.size, 0, 'the notice is not leaked back into the sweep');
  eq(P.EDITS.length, before, 'a second ending was written over the first');
});

P.reset();
P.setWall(WALL);
P.setCodexWall(WALL);
P.dispatchPrompt('[Report from your own background worker: it finished.]', P.LANES.main, { priority: true });

await t('internal traffic is never parked by the walls: it ignores them by construction', () => {
  eq(P.parkedWalledChats.length, 0, 'a worker report parked behind two walls is a report nobody reads');
  eq(P.CLAUDE.length, 1);
});

P.reset();
P.setCodexWall(WALL);
P.dispatchPrompt('is the deploy green', undefined, { allowCodexFallback: true });

await t('a Codex wall ALONE never blocks a healthy Claude lane', () => {
  eq(P.parkedWalledChats.length, 0);
  eq(P.CLAUDE.length, 1);
});

// ---------------------------------------------------------------------------
console.log('\n16. the engine is resolved on EVERY route in, not just the first one');
// ---------------------------------------------------------------------------
// The three blockers the two-engine audit called the same bug at three call
// sites: the decision was made in exactly ONE place (dispatchPrompt's
// allowCodexFallback && !priority branch) and every other route into a run
// bypassed it. Each assertion here fails when its fix is reverted.

P.reset();
P.setWall(WALL);
P.setCodexWall(WALL);
for (let i = 0; i < 12; i++) P.dispatchPrompt(`message ${i}`, undefined, { allowCodexFallback: true });

await t('★ nothing is parked that the queue cannot take when it flushes', () => {
  // PARKED_WALLED_MAX was 10 while QUEUE_MAX is 5, and the flush re-dispatches
  // in ONE synchronous loop: the first claims the lane, the next five queue,
  // and the rest hit "queue full" and were dropped, having been told in
  // writing that they were parked and not dropped. Measured before the fix:
  // 10 parked, 1 started, 5 queued, 4 lost.
  ok(P.parkedWalledChats.length <= P.QUEUE_MAX, `${P.parkedWalledChats.length} parked, queue holds ${P.QUEUE_MAX}`);
});

P.setWall(0);
P.setCodexWall(0);
const parkedCount = P.parkedWalledChats.length;
P.flushParkedWalledChats();
let drained = 0;
while (P.LANES.main.queue.length) {
  P.LANES.main.current = null;
  P.drainQueue(P.LANES.main);
  drained++;
  if (drained > 20) break;
}

await t('and every parked message actually runs when a wall lifts', () => {
  const ran = P.CLAUDE.length + P.CODEX_CHAT.length + P.CHAT_FALLBACK.length;
  eq(ran, parkedCount, `${parkedCount} were parked but ${ran} ran`);
  ok(!P.SENT.join('\n').includes('queue full'), 'a parked message was refused by the queue it was promised');
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.LANES.main.current = { prompt: 'a codex turn', startedAt: Date.now(), engine: 'codex' };
P.dispatchPrompt('and what about the encoder', undefined, { allowCodexFallback: true, images: ['/inbox/shot.png'] });
P.LANES.main.current = null;
P.drainQueue(P.LANES.main);

await t('★ case 1: a message queued behind a Codex turn drains onto CODEX, with its images', () => {
  // drainQueue called runClaude unconditionally, so this ran on the engine the
  // owner had just switched away from; with no `claude` on the machine it was
  // never run at all, only echoed back unsummarised. And the queue held bare
  // strings, so the photo was dropped at the busy check.
  eq(P.CLAUDE.length, 0, `the queued message ran on Claude: ${JSON.stringify(P.CLAUDE)}`);
  eq(P.CODEX_CHAT.length, 1, 'the queued message never ran at all');
  eq(P.CODEX_CHAT[0].text, 'and what about the encoder');
  eq(P.CODEX_CHAT[0].images?.[0], '/inbox/shot.png', 'a photo sent mid-turn lost its file in the queue');
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
let spliced = null;
P.LANES.main.current = {
  prompt: 'a claude turn still finishing',
  startedAt: Date.now(),
  engine: 'claude',
  steer: (txt) => {
    spliced = txt;
    return true;
  },
};
P.dispatchPrompt('so what do you think', undefined, { allowCodexFallback: true });

await t('★ case 2: after /engine codex, the next message QUEUES instead of being spliced into Claude', () => {
  // The guard was `!forcedEngine`, which only covered a `codex:` prefix, so a
  // SETTLED switch still wrote the next message into the running Claude
  // child's stdin and acked "sent into the running task".
  eq(spliced, null, `the message was spliced into the Claude turn: ${spliced}`);
  eq(P.LANES.main.queue.length, 1, 'it was neither steered nor queued');
  ok(P.SENT.join('\n').includes('🧠 Codex'), `the ack does not name the engine: ${P.SENT.join('\n')}`);
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.dispatchPrompt('[Report from your own background worker: it finished.]', P.LANES.main, { priority: true });

await t('★ case 27: a priority handback on a Codex chat lane reaches the Codex thread', () => {
  // `priority` meant two things at once: "never dropped, jumps the queue" AND
  // "skip the engine decision". Every worker handback, watchdog alert,
  // scheduled task and compaction answered into a chat the owner had switched
  // away from.
  eq(P.CLAUDE.length, 0, 'the report went to Claude on a Codex chat lane');
  eq(P.CODEX_CHAT.length, 1, 'the report reached neither engine');
  ok(P.CODEX_CHAT[0].text.startsWith('[Report from your own background worker'), P.CODEX_CHAT[0].text);
});

P.reset();
P.setWall(WALL);
P.dispatchPrompt('[Report from your own background worker: it finished.]', P.LANES.main, { priority: true });

await t('but a WALL still never diverts internal traffic: priority ignores it by construction', () => {
  // The rate-limit fallback is a degraded answer for a message he is waiting
  // on. A report diverted there would be handed to a thread-less Codex run
  // that has never heard of this bridge, and parked for an M who already has it.
  eq(P.CHAT_FALLBACK.length, 0);
  eq(P.CODEX_CHAT.length, 0);
  eq(P.CLAUDE.length, 1);
});

P.reset();
P.setEngines({ chat: { engineBg: 'codex' } });
P.dispatchPrompt('# TASK: summarise yesterday\'s commits', { name: 'bg', isBg: true, current: null, queue: [] }, { priority: true });

await t('case 28: a scheduled --run task goes to the BG engine instead of hard-routing to Claude', () => {
  eq(P.CLAUDE.length, 0, 'a Codex-first install could not schedule work at all');
  eq(P.CODEX.length, 1);
  eq(P.CODEX[0].mode, 'edit');
});

// ---------------------------------------------------------------------------
console.log('\n17. the handoff: injected once, and only on the first message');
// ---------------------------------------------------------------------------
// The rendering and the caps are engine-handoff.test.mjs's job. What is
// asserted here is the WIRING: that the block reaches the engine's argv, that
// it reaches it exactly once, and that a Codex turn carrying one runs without
// network access.

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.HANDOFF.pending = true;
P.HANDOFF.block = '<<<HANDOFF_START>>>\nGoal: fix the retry loop\n<<<HANDOFF_END>>>';
P.dispatchPrompt('what is the open question', undefined, { allowCodexFallback: true });
P.dispatchPrompt('and now the second one', undefined, { allowCodexFallback: true });

await t('★ the handoff is prepended to the FIRST message and to nothing after it', () => {
  eq(P.CODEX_CHAT.length, 2);
  ok(P.CODEX_CHAT[0].prompt?.includes('HANDOFF_START'), `the first turn carried no handoff: ${P.CODEX_CHAT[0].prompt}`);
  ok(P.CODEX_CHAT[0].prompt.includes('what is the open question'), P.CODEX_CHAT[0].prompt);
  eq(P.CODEX_CHAT[0].carriesHandoff, true);
  eq(P.CODEX_CHAT[1].prompt, null, `the second turn paid for the same context again: ${P.CODEX_CHAT[1].prompt}`);
  eq(P.CODEX_CHAT[1].carriesHandoff, false);
});

await t('and what he TYPED is still what the turn is described by', () => {
  // /status, the chat ring and the archive all read the raw text: a turn
  // labelled with a page of injected context is unreadable in every one of them.
  eq(P.CODEX_CHAT[0].text, 'what is the open question');
});

P.reset();
P.HANDOFF.pending = true;
P.HANDOFF.block = '<<<HANDOFF_START>>>\nGoal: fix the retry loop\n<<<HANDOFF_END>>>';
P.dispatchPrompt('what were we doing', undefined, { allowCodexFallback: true });

await t('★ the reverse direction too: a Claude turn gets it prepended', () => {
  eq(P.CLAUDE.length, 1);
  ok(P.CLAUDE[0].prepend?.includes('HANDOFF_START'), `the Claude turn carried no handoff: ${JSON.stringify(P.CLAUDE[0])}`);
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.HANDOFF.pending = true;
P.HANDOFF.block = 'BLOCK';
P.dispatchPrompt('[Report from your own background worker: it finished.]', P.LANES.main, { priority: true });

await t('internal traffic never consumes the handoff: it is for HIS next message', () => {
  eq(P.CODEX_CHAT.length, 1);
  eq(P.CODEX_CHAT[0].prompt, null, 'a worker report ate the context meant for the owner');
  eq(P.HANDOFF.pending, true, 'and it must still be waiting');
});

P.reset();
P.setEngines({ chat: { engineChat: 'codex' } });
P.HANDOFF.pending = true;
P.HANDOFF.block = 'BLOCK';
P.LANES.main.current = { prompt: 'a codex turn', startedAt: Date.now(), engine: 'codex' };
P.dispatchPrompt('the first message after the switch', undefined, { allowCodexFallback: true });
P.LANES.main.current = null;
P.drainQueue(P.LANES.main);

await t('★ a handoff survives the QUEUE: the first message still carries it after draining', () => {
  // The injection happens where the run actually starts, not at dispatch, so a
  // message that had to wait for a busy lane does not lose it.
  eq(P.CODEX_CHAT.length, 1);
  ok(P.CODEX_CHAT[0].prompt?.includes('BLOCK'), `the queued first message lost the handoff: ${P.CODEX_CHAT[0].prompt}`);
});

// ---------------------------------------------------------------------------
console.log('\n18. the bridge-side handoff wiring, executed');
// ---------------------------------------------------------------------------
// Section 17 proves the INJECTION against a stubbed takeHandoffPrefix. This
// runs the real thing: switchHandoff, recordedHandoff, storeHandoff,
// takeHandoffPrefix, dropHandoff and the ring IO, extracted from bridge.mjs and
// pointed at a scratch state file.
//
// It exists because a QA pass found this whole half untested, and the very next
// edit proved the point: switchHandoff called resolveHandoffSource without
// importing it, `node --check` passed, all 20 suites passed, and the daemon
// died with a ReferenceError on the first /engine. An undefined identifier in a
// function nothing calls is invisible until someone calls it.

const SWITCH_TMP = path.join(TMP, 'switch');
mkdirSync(SWITCH_TMP, { recursive: true });

const S = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import {
  buildHandoff, capHandoff, capRing, filterProsePaths, handoffBits, handoffCapturePrompt,
  HANDOFF_SCHEMA, parseHandoffJson, redactHandoff, renderHandoffBlock, resolveHandoffSource,
  ringEntry, ringForChat, unavailableToolLabels, unreachablePaths,
} from ${url('engine-handoff.mjs')};
import { fmtUntil } from ${url('bg-codex.mjs')};
// The REAL normalizer, not a stub: what the ring stores has to be the same
// bytes the phone got, and a stub could not prove that.
import { normalizeDashes } from ${url('dash-normalize.mjs')};
import {
  bgEngine, canProduceHandoff, chatEngine, claudeMissingLine, engineView,
  parseEngineCommand, resolveCaptureLine, settleSwitchText, switchView,
} from ${url('engine-state.mjs')};
const { existsSync, readFileSync, writeFileSync } = fs;
const NO_DASHES = true;
// The real deadline is 25s. captureHandoff reads this as a free variable, so
// the fallback-timer test can assert the same code path in a fifth of a second.
export let HANDOFF_CAPTURE_MS = 150;
const CLAUDE_BIN = '/fake/claude';
const OWNER_TZ = 'UTC';
const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_CWD = '/Users/z/dev/x';
const COMMAND_NAMES = ['usage', 'status', 'compact'];
// The two spawners captureHandoff can reach, each replaced by a recorder. The
// test then plays the callback by hand, which is what lets all eleven exits be
// driven without a binary.
export const EXECS = [];
const execFile = (bin, args, opts, cb) => {
  const child = { kill: () => { child.killed = true; }, killed: false };
  EXECS.push({ bin, args, opts, cb, child });
  return child;
};
export const CODEX_ASKS = [];
export let RUN_CODEX_RESULT = { child: { kill: () => {} } };
export const setRunCodexResult = (v) => { RUN_CODEX_RESULT = v; };
const runCodex = (prompt, opts) => {
  CODEX_ASKS.push({ prompt, opts });
  return RUN_CODEX_RESULT;
};
export let USAGE_WINDOW = null;
const codexUsageWindow = () => USAGE_WINDOW;
export const setUsageWindow = (w) => { USAGE_WINDOW = w; };
const chatLaneEngine = () => chatEngine({ chat: STATE, config: {} });
const bgLaneEngine = () => bgEngine({ chat: STATE, config: {} });
const engineViewArgs = () => ({ chat: STATE, config: {}, claudeAvailable: CLAUDE_AVAILABLE, codexAvailable: CODEX_AVAILABLE });
const CODEX_MISSING_LINE = 'no codex binary';
const escHtml = (t) => t;
// THE TRANSCRIPT. One ordered list for both verbs, because the whole claim
// being tested is about their ORDER and their count: one send, then edits of
// that same id, and never a second send.
export const EVENTS = [];
let nextMsgId = 100;
const editProgress = (id, html, plain) => {
  EVENTS.push({ kind: 'edit', id, text: plain(), at: Date.now() });
  return Promise.resolve();
};
const CHAT_ID = '1';
export const CHAT_RING_FILE = ${JSON.stringify(path.join(SWITCH_TMP, 'chat-ring.jsonl'))};
export const STATE = { cwd: '/Users/z/dev/x', yolo: true };
const chatState = () => STATE;
export let SAVED = 0;
const saveState = () => { SAVED++; };
export const SENT = [];
// Returns a message id, like the real one: it is what the /engine arm keeps so
// it can edit the message instead of sending a second. capturesAtSend is the
// race proof: a capture registered before this returns would show up here.
const send = (t) => {
  SENT.push(t);
  const id = nextMsgId++;
  EVENTS.push({ kind: 'send', id, text: t, at: Date.now(), capturesAtSend: CAPTURES.length });
  return Promise.resolve({ message_id: id });
};
export const CAPTURES = [];
// switchHandoff's view of the capture: a recorder that hands the settle
// callback back, so a test can resolve it and watch the confirmation get
// edited. The REAL captureHandoff is extracted too, under its own name, and
// section 18d drives all eleven of its exits.
const captureHandoff = (from, to, onSettle) => { CAPTURES.push({ from, to, onSettle }); };
const OWNER_NAME = 'the owner';
const HOME = '/Users/z';
export const LANES = { main: { name: 'main', current: null, queue: [] } };
export let CLAUDE_AVAILABLE = true;
export let CODEX_AVAILABLE = true;
export let rotationPausedUntil = 0;
export let codexPausedUntil = 0;
export const setAvail = (o = {}) => {
  if (o.claude !== undefined) CLAUDE_AVAILABLE = o.claude;
  if (o.codex !== undefined) CODEX_AVAILABLE = o.codex;
  if (o.claudeWall !== undefined) rotationPausedUntil = o.claudeWall;
  if (o.codexWall !== undefined) codexPausedUntil = o.codexWall;
};
export let CONF = {};
const conf = (k, f) => (k in CONF ? CONF[k] : f);
// conf() can hand back a string (the environment layer), so the real code reads
// its booleans through confBool. Same coercion here, or the extracted
// switchHandoff would call an undefined function.
const confBool = (k, f) => {
  const v = conf(k, f);
  if (typeof v !== 'string') return Boolean(v);
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return Boolean(f);
};
const codexAccount = { peek: () => ({ identity: { state: 'chatgpt' } }) };
const codexChatBox = () => ({ sandbox: 'workspace-write', network: true });
export const reset = () => {
  SENT.length = 0; CAPTURES.length = 0; EVENTS.length = 0; EXECS.length = 0; CODEX_ASKS.length = 0;
  SAVED = 0; CONF = {}; USAGE_WINDOW = null; RUN_CODEX_RESULT = { child: { kill: () => {} } };
  CLAUDE_AVAILABLE = true; CODEX_AVAILABLE = true; rotationPausedUntil = 0; codexPausedUntil = 0;
  LANES.main.current = null;
  for (const k of Object.keys(STATE)) if (!['cwd', 'yolo'].includes(k)) delete STATE[k];
  STATE.cwd = '/Users/z/dev/x';
  writeFileSync(CHAT_RING_FILE, '');
};
`,
        grab('readRingRows'),
        grab('recordChatTurn'),
        grab('readChatRing'),
        grab('clearChatRing'),
        grab('dropHandoff'),
        grab('storeHandoff'),
        grab('recordedHandoff'),
        grab('switchHandoff'),
        grab('engineCommand'),
        grab('captureHandoff').replace(/^function captureHandoff\(/, 'function realCaptureHandoff('),
        grab('boundCapture'),
        grab('takeHandoffPrefix'),
        'export { recordChatTurn, readChatRing, dropHandoff, storeHandoff, recordedHandoff, switchHandoff, engineCommand, takeHandoffPrefix, clearChatRing, switchView, realCaptureHandoff, resolveCaptureLine };',
      ].join('\n'),
    )
);

S.reset();
S.recordChatTurn({ engine: 'claude', role: 'user', text: 'we are fixing the retry loop in foo.ts' });
S.recordChatTurn({ engine: 'claude', role: 'assistant', text: 'decided: no queue', paths: ['/Users/z/dev/x/foo.ts', '/Users/z/dev/y/z.ts'], tools: ['Edit'] });
const sw = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });

await t('★ switchHandoff RUNS: it stores a handoff and reports what it carried', () => {
  // The bug this section exists for: an undefined identifier here passed
  // `node --check` and all 20 suites, and only died on a real /engine.
  ok(S.STATE.handoff, 'nothing was stored');
  eq(S.STATE.handoffPending, true);
  eq(S.STATE.handoff.goal, 'we are fixing the retry loop in foo.ts');
  ok(/goal/.test(sw.view.handoff.bits), JSON.stringify(sw.view.handoff));
  ok(/1 decision/.test(sw.view.handoff.bits), JSON.stringify(sw.view.handoff));
  eq(sw.view.handoff.from, 'claude');
});

await t('and it names the paths the incoming Codex sandbox cannot reach', () => {
  // Structural: workspace-write is rooted at one directory and `codex exec
  // resume` takes no --add-dir.
  eq(sw.view.warnings.unreachable.count, 1, JSON.stringify(sw.view.warnings));
  eq(sw.view.warnings.unreachable.root, '~/dev/x');
  ok(/1 file outside ~\/dev\/x, Codex cannot reach it/.test(S.switchView(sw.view).text), S.switchView(sw.view).text);
});

await t('★ a tool the incoming engine does not have is named in one word', () => {
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'run the audit' });
  S.recordChatTurn({ engine: 'claude', role: 'assistant', text: 'dispatched', tools: ['Task', 'Skill'] });
  const v = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false }).view;
  eq(v.warnings.missingTools.join(', '), 'subagents, skills', JSON.stringify(v.warnings));
});

await t('★ the capture turn is offered only when the gate allows it', () => {
  S.reset();
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'something' });
  // No session to resume: no capture is offered, and the reason is NOT on the
  // message (it goes to the daemon log). A message with no pending line is
  // final the moment it is sent.
  const n1 = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  eq(n1.view.capture, null);
  eq(n1.startCapture, null);
  eq(S.switchView(n1.view).pendingLine, null, 'it promised feedback nothing would ever deliver');
  eq(S.CAPTURES.length, 0, 'it asked a session that does not exist for a handoff');
  // With a session to resume, it is offered.
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'something' });
  const n2 = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  eq(n2.view.capture.engine, 'claude');
  ok(typeof n2.startCapture === 'function', 'the capture must be startable by the caller, not started here');
  eq(S.CAPTURES.length, 0, 'switchHandoff must not spawn: the caller starts it after the send');
  // And never into a wall.
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.setAvail({ claudeWall: Date.now() + 3600_000 });
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'something' });
  const n3 = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  eq(n3.view.capture, null, 'it spawned into a wall');
  eq(n3.startCapture, null);
});

await t('★ the block is injected on the FIRST message and on nothing after it', () => {
  S.reset();
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  const first = S.takeHandoffPrefix('codex');
  ok(first.includes('<<<HANDOFF_START>>>'), first);
  ok(first.includes('the retry loop'), first);
  eq(S.takeHandoffPrefix('codex'), '', 'the second message paid for the same context again');
});

await t('★ `fresh` injects nothing and LEAVES the stored handoff alone', () => {
  S.reset();
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  const stored = JSON.stringify(S.STATE.handoff);
  const n = S.switchHandoff({ leaving: 'codex', arriving: 'claude', fresh: true });
  eq(n.view.fresh, true);
  eq(n.view.handoff, null);
  ok(/Fresh start, no handoff/.test(S.switchView(n.view).text), S.switchView(n.view).text);
  eq(S.takeHandoffPrefix('claude'), '', 'fresh still injected something');
  eq(JSON.stringify(S.STATE.handoff), stored, '"skip it this once" is not "forget it"');
});

await t('★ /new forgets the RING too, so the switch after it carries nothing', () => {
  // Dropping only the stored object forgot nothing: the very next /engine
  // rebuilt an equivalent handoff from the same rows.
  S.reset();
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the SECRET project' });
  S.recordChatTurn({ engine: 'claude', role: 'assistant', text: 'decided: ship it' });
  S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  ok(JSON.stringify(S.STATE.handoff).includes('SECRET'), 'setup failed');
  S.dropHandoff(S.STATE); // what /new, /cd and /resume call
  eq(S.readChatRing().length, 0, 'the ring survived the command that was supposed to forget it');
  const n = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  eq(n.view.handoff, null);
  ok(/No handoff yet, nothing recorded on this chat/.test(S.switchView(n.view).text), S.switchView(n.view).text);
  eq(S.STATE.handoff, undefined, 'the forgotten conversation came back');
  eq(S.takeHandoffPrefix('codex'), '');
});

await t('a stored handoff older than six hours is still offered, and labelled', () => {
  S.reset();
  S.storeHandoff({ from: 'claude', at: Date.now() - 9 * 3600_000, goal: 'the old thing', decisions: [], paths: [], tools: [] });
  const n = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  eq(n.view.handoff.stale, true);
  ok(/9h 0m ago \(stale\)/.test(S.switchView(n.view).text), S.switchView(n.view).text);
  ok(S.takeHandoffPrefix('codex').includes('STALE'), 'the injected block must say so too');
});

await t('and a chat with nothing at all says so in one line', () => {
  S.reset();
  const n = S.switchHandoff({ leaving: 'claude', arriving: 'codex', fresh: false });
  const { text, pendingLine } = S.switchView(n.view);
  eq(pendingLine, null);
  ok(/No handoff yet, nothing recorded on this chat/.test(text), text);
});

// ---------------------------------------------------------------------------
console.log('\n18b. /engine: ONE message, edited in place when the capture settles');
// ---------------------------------------------------------------------------
// The owner, on a screenshot of the old five-line block plus its
// 25-seconds-later follow-up: "this msg is too big of a block with no feedback. Can it be
// prettier?" The shape is proved in engine-state.test.mjs; what is proved HERE
// is the sequence, because that is the half a pure function cannot own:
//
//   ★ exactly one sendMessage, ever, on every path
//   ★ the capture is registered AFTER that send returns, never before
//   ★ the resolution is an EDIT of that same message id
//
// The old build fired the capture from inside switchHandoff, before the reply
// went out, which is precisely why it could only report back as a new message.

S.reset();
S.STATE.sessionId = 'a-real-session';
S.recordChatTurn({ engine: 'claude', role: 'user', text: 'we are fixing the retry loop' });
S.recordChatTurn({ engine: 'claude', role: 'assistant', text: 'decided: no queue', paths: ['/Users/z/dev/x/foo.ts'], tools: ['Edit'] });
await S.engineCommand('codex');

await t('★ one message goes out, and it is the compact shape', () => {
  eq(S.SENT.length, 1, S.SENT.join('\n---\n'));
  const text = S.SENT[0];
  const lines = text.split('\n');
  eq(lines[0], '🧠 Codex is on.', text);
  eq(lines[1], '📎 Handoff: goal, 1 decision, 1 path, 1 tool · from Claude, just now', text);
  ok(lines.some((l) => l.startsWith('🧵 Thread:')), text);
  ok(lines.some((l) => l === '🔒 Sandbox: workspace-write in ~/dev/x'), text);
  eq(lines[lines.length - 1], '⏳ Asking Claude for its own notes…', text);
});

await t('★ the capture was started AFTER the send, so it cannot settle into nothing', () => {
  eq(S.CAPTURES.length, 1, 'the capture never ran');
  const sent = S.EVENTS.filter((e) => e.kind === 'send');
  eq(sent.length, 1);
  eq(sent[0].capturesAtSend, 0, 'the capture was already running when the message was sent: it could resolve first');
});

await t('★ when it lands, the SAME message is edited: there is no second message', () => {
  const sentId = S.EVENTS.find((e) => e.kind === 'send').id;
  S.CAPTURES[0].onSettle({ ok: true, engine: 'claude' });
  eq(S.SENT.length, 1, 'a second message went out: that is the bug being fixed');
  const edits = S.EVENTS.filter((e) => e.kind === 'edit');
  eq(edits.length, 1, JSON.stringify(S.EVENTS));
  eq(edits[0].id, sentId, 'the edit landed on a different message');
  const before = S.SENT[0].split('\n');
  const after = edits[0].text.split('\n');
  eq(after.length, before.length, 'the message grew or shrank instead of resolving one line');
  eq(after[after.length - 1], "✅ Claude's notes added to the handoff", edits[0].text);
  eq(after.slice(0, -1).join('\n'), before.slice(0, -1).join('\n'), 'only the pending line may change');
});

await t('a capture that never answers resolves the same line, honestly', async () => {
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.STATE.engineChat = 'claude';
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  S.CAPTURES[0].onSettle({ ok: false, engine: 'claude', reason: 'timeout' });
  const edits = S.EVENTS.filter((e) => e.kind === 'edit');
  eq(edits.length, 1);
  ok(edits[0].text.endsWith('↪️ Using the recorded handoff (Claude did not answer in time)'), edits[0].text);
  eq(S.SENT.length, 1);
});

await t('and a capture that died on a wall names the reset time', async () => {
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.STATE.engineChat = 'claude';
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  S.CAPTURES[0].onSettle({ ok: false, engine: 'claude', reason: 'walled', until: '12:22' });
  const edits = S.EVENTS.filter((e) => e.kind === 'edit');
  ok(edits[0].text.endsWith('↪️ Using the recorded handoff (Claude is walled until 12:22)'), edits[0].text);
});

await t('★ no capture means no ⏳ line, and nothing will ever edit the message', async () => {
  S.reset();
  // No sessionId: the ladder skips rung 2.
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  eq(S.SENT.length, 1);
  ok(!S.SENT[0].includes('⏳'), S.SENT[0]);
  eq(S.SENT[0].split('\n').length, 4, S.SENT[0]);
  eq(S.CAPTURES.length, 0);
  eq(S.EVENTS.filter((e) => e.kind === 'edit').length, 0);
});

await t('★ `fresh` is three lines, no handoff, no pending line', async () => {
  S.reset();
  S.STATE.codexThreadId = 't1';
  S.STATE.codexThreadAt = Date.now() - (107 * 60_000);
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex fresh');
  eq(S.SENT.length, 1);
  eq(
    S.SENT[0],
    ['🧠 Codex is on. Fresh start, no handoff.', '🧵 Thread: continuing (1h 47m) · /new for a fresh one', '🔒 Sandbox: workspace-write in ~/dev/x'].join('\n'),
    S.SENT[0],
  );
});

await t('★ already on it: one line, no handoff, no capture, no spend', async () => {
  S.reset();
  S.STATE.engineChat = 'codex';
  S.recordChatTurn({ engine: 'codex', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  eq(S.SENT.length, 1);
  eq(S.SENT[0], '🧠 Codex is already on.');
  eq(S.CAPTURES.length, 0);
  eq(S.STATE.handoff, undefined, 'a switch that did not happen must not build a handoff');
  // It is still PINNED, so a config default changing underneath cannot move it.
  eq(S.STATE.engineChat, 'codex');
});

await t('the background lane switch is one line plus how to override one job', async () => {
  S.reset();
  await S.engineCommand('bg codex');
  eq(S.SENT.length, 1);
  eq(S.SENT[0].split('\n')[0], '🧠 Background jobs now run on Codex.');
  ok(/claude:/.test(S.SENT[0]), S.SENT[0]);
  eq(S.STATE.engineBg, 'codex');
  eq(S.STATE.handoff, undefined, 'the bg lane has no chat context to hand over');
});

await t('bare /engine renders the view and sends nothing else', async () => {
  S.reset();
  await S.engineCommand('');
  eq(S.SENT.length, 1);
  ok(S.SENT[0].includes('Chat lane:'), S.SENT[0]);
  ok(S.SENT[0].includes('Set: /engine claude|codex'), S.SENT[0]);
  eq(S.CAPTURES.length, 0);
});

await t('★ the ChatGPT window rides the switch only when it is close to the limit', async () => {
  S.reset();
  S.setUsageWindow({ percent: 82, label: '5h', resetsAt: '03:15' });
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  ok(S.SENT[0].includes('📊 Codex 5h window 82%, resets 03:15'), S.SENT[0]);
  S.reset();
  S.setUsageWindow({ percent: 12, label: '5h', resetsAt: '03:15' });
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  ok(!S.SENT[0].includes('window'), S.SENT[0]);
});

await t('★ no message this command sends carries an em or en dash', async () => {
  const dashes = /[\u2013\u2014]/;
  S.reset();
  S.STATE.sessionId = 'a-real-session';
  S.recordChatTurn({ engine: 'claude', role: 'user', text: 'the retry loop' });
  await S.engineCommand('codex');
  S.CAPTURES[0]?.onSettle({ ok: true, engine: 'claude' });
  await S.engineCommand('');
  await S.engineCommand('bg codex');
  await S.engineCommand('nonsense');
  for (const e of S.EVENTS) ok(!dashes.test(e.text), `dash in: ${e.text}`);
  ok(S.SENT.some((t) => t.startsWith('❌')), 'the junk argument still had to be refused');
});


// ---------------------------------------------------------------------------
console.log('\n18c. the ring stores what the phone got, dashes included');
// ---------------------------------------------------------------------------
// The ring kept Codex's raw text while the phone got the normalized version,
// and the ring is what the handoff is built from: a dash the owner never saw was
// handed to the other engine as context, and came back written in that
// register. The fixture holds the literal characters so this file stays clean
// for the repo-wide no-dash grep.

const DASHFIX = JSON.parse(readFileSync(path.join(DIR, 'scripts', 'probes', 'fixtures', 'dashes.json'), 'utf8'));

await t('★ an em dash in a reply is a comma in the ring row, not a dash', () => {
  S.reset();
  S.recordChatTurn({ engine: 'codex', role: 'assistant', text: DASHFIX.unspaced.in });
  const row = S.readChatRing().at(-1);
  eq(row.text, DASHFIX.unspaced.out, JSON.stringify(row));
  eq(/[\u2013\u2014]/.test(row.text), false, 'the dash survived into the file the handoff is built from');
});

await t('★ and it reaches the handoff, which is the whole reason it matters', () => {
  S.reset();
  S.recordChatTurn({ engine: 'codex', role: 'user', text: DASHFIX.spaced.in });
  S.STATE.codexThreadId = 't1';
  const { view } = S.switchHandoff({ leaving: 'codex', arriving: 'claude', fresh: false });
  eq(/[\u2013\u2014]/.test(JSON.stringify(S.STATE.handoff)), false, JSON.stringify(S.STATE.handoff));
  eq(S.STATE.handoff.goal, DASHFIX.spaced.out);
  ok(view.handoff, 'setup failed');
});

await t('★ a dash inside a code span is left alone: it is a flag, not prose', () => {
  S.reset();
  S.recordChatTurn({ engine: 'codex', role: 'assistant', text: DASHFIX.codeSpan.in });
  eq(S.readChatRing().at(-1).text, DASHFIX.codeSpan.out, 'a copyable command was rewritten');
});

await t('the user half goes through the same rule, so his own words match too', () => {
  S.reset();
  S.recordChatTurn({ engine: 'claude', role: 'user', text: DASHFIX.range.in });
  eq(S.readChatRing().at(-1).text, DASHFIX.range.out);
});


// ---------------------------------------------------------------------------
console.log('\n18d. captureHandoff: every exit resolves the ⏳ line exactly once');
// ---------------------------------------------------------------------------
// The confirmation now PROMISES a resolution: its last line says "Asking claude
// for its own notes…" and gets edited in place when this lands. That promise is
// only worth anything if every way this function can end reaches onSettle, once.
// Nothing here spawns: execFile and runCodex are recorders and the test plays
// their callbacks, which is what lets all of it be driven without a binary.

const settlesOf = () => {
  const out = [];
  return { out, cb: (o) => out.push(o) };
};

await t('★ the Claude arm: a readable answer stores the model handoff and says so', () => {
  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.STATE.handoffPending = true;
  S.STATE.handoff = { from: 'claude', at: Date.now(), goal: 'old', decisions: [], paths: [], tools: [] };
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  eq(S.EXECS.length, 1, 'it never spawned');
  S.EXECS[0].cb(null, '{"goal":"the real goal","decisions":["a"],"paths":[],"open":"","tools":[]}');
  eq(s.out.length, 1, JSON.stringify(s.out));
  eq(s.out[0].ok, true);
  eq(S.STATE.handoff.source, 'model');
  eq(S.STATE.handoff.goal, 'the real goal');
});

await t('★ an answer it cannot READ is not a timeout: it answered', () => {
  // Reporting "did not answer in time" for a prompt refusal would be the one
  // line on this message that is not true. Found by the QA pass.
  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.STATE.handoffPending = true;
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  S.EXECS[0].cb(null, 'I am sorry, I cannot do that.');
  eq(s.out.length, 1);
  eq(s.out[0].reason, 'failed');
  eq(S.resolveCaptureLine(s.out[0]), '↪️ Using the recorded handoff (Claude could not write one)');
});

await t('a killed run IS a timeout, and a usage limit is a wall with its clock', () => {
  S.reset();
  S.STATE.sessionId = 'sess-1';
  const a = settlesOf();
  S.realCaptureHandoff('claude', 'codex', a.cb);
  const killed = new Error('Command failed: timeout');
  killed.killed = true;
  S.EXECS[0].cb(killed, '');
  eq(a.out[0].reason, 'timeout');

  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.setAvail({ claudeWall: Date.parse('2026-09-04T16:22:00Z') });
  const b = settlesOf();
  S.realCaptureHandoff('claude', 'codex', b.cb);
  S.EXECS[0].cb(new Error('Claude usage limit reached'), '');
  eq(b.out[0].reason, 'walled');
  ok(b.out[0].until, 'a wall with a known reset must print it');
});

await t('no session to resume settles at once and spawns nothing', () => {
  S.reset();
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  eq(S.EXECS.length, 0, 'it resumed a session that does not exist');
  eq(s.out.length, 1);
  eq(s.out[0].reason, 'failed');
});

await t('★ the Codex arm: finished, rate limited, otherwise failed, and never spawned', () => {
  S.reset();
  S.STATE.codexThreadId = 't1';
  S.STATE.handoffPending = true;
  const ok1 = settlesOf();
  S.realCaptureHandoff('codex', 'claude', ok1.cb);
  eq(S.CODEX_ASKS.length, 1);
  eq(S.CODEX_ASKS[0].opts.sandbox, 'read-only', 'a capture must never be able to write');
  eq(S.CODEX_ASKS[0].opts.announce, false, 'an announced capture is the second message all over again');
  S.CODEX_ASKS[0].opts.onAnswer({ status: 'finished', answer: '{"goal":"g","decisions":[],"paths":[],"open":"","tools":[]}' });
  eq(ok1.out[0].ok, true);

  S.reset();
  S.STATE.codexThreadId = 't1';
  S.setAvail({ codexWall: Date.parse('2026-09-04T16:22:00Z') });
  const wall = settlesOf();
  S.realCaptureHandoff('codex', 'claude', wall.cb);
  S.CODEX_ASKS[0].opts.onAnswer({ status: 'failed', failure: 'rate_limit' });
  eq(wall.out[0].reason, 'walled');

  S.reset();
  S.STATE.codexThreadId = 't1';
  const other = settlesOf();
  S.realCaptureHandoff('codex', 'claude', other.cb);
  S.CODEX_ASKS[0].opts.onAnswer({ status: 'failed', failure: 'auth' });
  eq(other.out[0].reason, 'failed');

  // runCodex refused to start at all.
  S.reset();
  S.STATE.codexThreadId = 't1';
  S.setRunCodexResult(null);
  const none = settlesOf();
  S.realCaptureHandoff('codex', 'claude', none.cb);
  eq(none.out.length, 1, 'a run that never started left the ⏳ line up forever');
  eq(none.out[0].reason, 'failed');
});

await t('★ two answers, one resolution: the message is never edited twice', () => {
  S.reset();
  S.STATE.codexThreadId = 't1';
  S.STATE.handoffPending = true;
  const s = settlesOf();
  S.realCaptureHandoff('codex', 'claude', s.cb);
  const answer = { status: 'finished', answer: '{"goal":"g","decisions":[],"paths":[],"open":"","tools":[]}' };
  S.CODEX_ASKS[0].opts.onAnswer(answer);
  S.CODEX_ASKS[0].opts.onAnswer(answer);
  eq(s.out.length, 1, JSON.stringify(s.out));
});

await t('a handoff the next message already consumed says exactly that', () => {
  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.STATE.handoffPending = false; // takeHandoffPrefix already ran
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  S.EXECS[0].cb(null, '{"goal":"too late","decisions":[],"paths":[],"open":"","tools":[]}');
  eq(s.out[0].reason, 'superseded');
  eq(S.STATE.handoff, undefined, 'it overwrote a handoff a turn had already used');
});

await t('★ a settle callback that throws does not take the daemon with it', () => {
  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.STATE.handoffPending = true;
  S.realCaptureHandoff('claude', 'codex', () => {
    throw new Error('telegram exploded');
  });
  S.EXECS[0].cb(null, '{"goal":"g","decisions":[],"paths":[],"open":"","tools":[]}');
  ok(true, 'it threw out of the execFile callback');
});

await t('★ the model claiming a slash command is a path does not get one counted', () => {
  S.reset();
  S.STATE.sessionId = 'sess-1';
  S.STATE.handoffPending = true;
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  S.EXECS[0].cb(
    null,
    JSON.stringify({ goal: 'g', decisions: [], paths: ['/usage', '/status', '/ecs/delta-agents'], open: '', tools: [] }),
  );
  eq(s.out[0].ok, true);
  eq(S.STATE.handoff.paths.length, 0, JSON.stringify(S.STATE.handoff.paths));
});

await t('★ nothing calls back at all: the fallback timer resolves it anyway', async () => {
  // Without this the ⏳ line would sit on the message forever, which is the
  // "no feedback" complaint with extra steps.
  S.reset();
  S.STATE.sessionId = 'sess-1';
  const s = settlesOf();
  S.realCaptureHandoff('claude', 'codex', s.cb);
  await new Promise((r) => setTimeout(r, S.HANDOFF_CAPTURE_MS + 2_200));
  eq(s.out.length, 1, JSON.stringify(s.out));
  eq(s.out[0].reason, 'timeout');
});

await t('★ and a child that answers AFTER that must not swap the handoff underneath', () => {
  // boundCapture only sends SIGTERM. A child that ignores it can still answer,
  // and storing its handoff then would leave the message describing a handoff
  // that is no longer the one on disk. Found by the QA pass.
  const stored = JSON.stringify(S.STATE.handoff ?? null);
  S.EXECS[0].cb(null, '{"goal":"far too late","decisions":[],"paths":[],"open":"","tools":[]}');
  eq(JSON.stringify(S.STATE.handoff ?? null), stored, 'a late answer rewrote the handoff the message described');
});

await t('★ every module function bridge.mjs CALLS is one it actually imports', async () => {
  // The extraction harnesses above cannot catch this: they supply the
  // identifiers themselves, so a name missing from bridge.mjs's own import list
  // resolves fine under test and throws ReferenceError in the daemon. That is
  // not hypothetical. `switchHandoff` called resolveHandoffSource without
  // importing it; `node --check` passed, all twenty suites passed, and the
  // first real /engine died with:
  //   [bridge] fatal: ReferenceError: resolveHandoffSource is not defined
  // A function nothing calls is a function whose free variables nobody checks,
  // so this checks them statically instead.
  const src = SRC.join('\n');
  const failures = [];
  for (const mod of ['engine-handoff.mjs', 'engine-state.mjs', 'bg-codex.mjs', 'bg-steer.mjs', 'codex-appserver.mjs', 'dash-normalize.mjs']) {
    const exported = [...readFileSync(path.join(DIR, mod), 'utf8').matchAll(/^export (?:function|const) (\w+)/gm)].map(
      (m) => m[1],
    );
    const block = src.match(new RegExp(`import \\{[\\s\\S]*?\\} from '\\./${mod.replace('.', '\\.')}';`));
    const imported = block ? block[0] : '';
    for (const name of exported) {
      // Called somewhere in bridge.mjs...
      if (!new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(src)) continue;
      // ...and not defined there under the same name.
      if (new RegExp(`^(?:async )?(?:function|const) ${name}\\b`, 'm').test(src)) continue;
      if (!new RegExp(`\\b${name}\\b`).test(imported)) failures.push(`${name} (from ${mod})`);
    }
  }
  eq(failures.length, 0, `bridge.mjs calls these without importing them: ${failures.join(', ')}`);
});

await t('★ the changed functions NO harness executes reference only names bridge.mjs has', () => {
  // The harnesses above execute runCodexChatTurn, the app-server manager and
  // both chat paths, so a missing name there fails loudly. These four are
  // changed by the same work and are executed by NOTHING: a free variable in
  // one of them is a ReferenceError the first time the owner types /status,
  // /usage or /stop, exactly the class that shipped once already
  // (switchHandoff calling resolveHandoffSource without importing it).
  const src = SRC.join('\n');
  const declared = new Set([
    ...[...src.matchAll(/^(?:export )?(?:async )?function ([\w$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^(?:const|let|var) ([\w$]+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/^import ([\w$]+) from/gm)].map((m) => m[1]),
    ...[...src.matchAll(/import \{([\s\S]*?)\} from/g)].flatMap((m) =>
      m[1].replace(/\n/g, ' ').split(',').map((n) => n.trim().split(' as ').pop().trim()),
    ),
  ]);
  // Each entry: the function, and the names this change made it depend on.
  const deps = {
    bgWorkerDescriptors: ['lastActFromExecLog', 'readTailIf', 'renderEntry', 'HOME'],
    stopCodexRuns: ['LANES', 'codexRuns'],
    gatherUsage: [
      'renderUsageReport', 'accountUsage', 'codexAccount', 'codexAccountBlock', 'codexFallbackOn',
      'codexSettingsNow', 'withDeadline', 'chatLaneEngine', 'bgLaneEngine', 'CODEX_AVAILABLE', 'OWNER_TZ',
    ],
    runCodexChatFallback: ['normalizeDashes', 'NO_DASHES'],
    handBackToChat: ['normalizeDashes', 'NO_DASHES'],
    deliverCodexDirect: ['normalizeDashes', 'NO_DASHES'],
    sendResult: ['normalizeDashes', 'NO_DASHES'],
  };
  const bad = [];
  for (const [fn, names] of Object.entries(deps)) {
    const body = grab(fn);
    for (const n of names) {
      if (!new RegExp(`\\b${n}\\b`).test(body)) bad.push(`${fn} no longer uses ${n} (stale expectation)`);
      else if (!declared.has(n)) bad.push(`${fn} uses ${n}, which bridge.mjs never declares or imports`);
    }
  }
  eq(bad.length, 0, bad.join('\n    '));
});

await t('★ killCodexAppServer is reached on every path that ends the daemon', () => {
  // One child per daemon means one LEAK per restart if an exit path forgets it.
  const src = SRC.join('\n');
  // Sliced to the handler's own `process.exit`, not to a guessed character
  // count: these blocks carry long comments and a window that is too short
  // fails on prose rather than on behaviour.
  const upToExit = (from) => {
    const rest = src.slice(src.indexOf(from));
    const end = rest.indexOf('process.exit(0)');
    return end === -1 ? rest : rest.slice(0, end);
  };
  ok(/killCodexAppServer\(\)/.test(upToExit("process.on('SIGTERM'")), 'SIGTERM does not kill the app-server');
  ok(/killCodexAppServer\(\)/.test(upToExit("case '/restart':")), '/restart does not kill the app-server');
});


// ---------------------------------------------------------------------------
console.log('\n19. the Codex CHAT lane on `codex app-server`: steering, steps, interrupt');
// ---------------------------------------------------------------------------
// `codex exec` is one-shot, which is why a message typed mid-turn used to queue
// and the bubble could only show a clock. The app-server has turn/steer, the
// item notifications that ARE the tool steps, and turn/interrupt. This section
// runs the REAL runCodexChatTurn out of bridge.mjs against a FAKE app-server
// (a node script speaking the measured protocol), so every claim below is about
// the code that ships, at zero OpenAI spend.

const AS_RUNS = path.join(TMP, 'as-runs');
const AS_FAKE = path.join(TMP, 'fake-app-server');
// The fake's behaviour knobs live in a FILE, not in the environment: the whole
// point of this section is that ONE app-server child serves every turn, and a
// child's env is fixed at spawn, so an env knob set by a later test would never
// reach it.
const AS_KNOBS = path.join(TMP, 'as-knobs.json');
const knobs = (o = {}) => writeFileSync(AS_KNOBS, JSON.stringify(o));
knobs();
writeFileSync(
  AS_FAKE,
  `#!/usr/bin/env node
// A fake \`codex app-server\`. Speaks the shapes captured in
// scripts/probes/fixtures/app-server-capture.json. Knobs come from the env so
// one script covers every branch.
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const note = (method, params) => out({ jsonrpc: '2.0', method, params });
let threadId = null;
let turnId = null;
let steered = [];
const KNOBS = ${JSON.stringify(AS_KNOBS)};
const knob = (k) => { try { return JSON.parse(require('fs').readFileSync(KNOBS, 'utf8'))[k]; } catch { return undefined; } };
process.stdin.on('data', (d) => {
  buf += String(d);
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let m;
    try { m = JSON.parse(s); } catch { continue; }
    if (m.method === 'initialize') {
      if (knob('noInit')) return; // an older CLI: never answers
      out({ jsonrpc: '2.0', id: m.id, result: { userAgent: 'fake', codexHome: '/tmp' } });
      if (knob('dieAfterInit')) setTimeout(() => process.exit(4), 30);
    } else if (m.method === 'thread/start') {
      threadId = 'th-app-1';
      out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: threadId }, cwd: m.params.cwd, model: 'fake' } });
      note('thread/started', { thread: { id: threadId } });
    } else if (m.method === 'thread/resume') {
      if (knob('deadThread')) {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'no rollout found for thread id ' + m.params.threadId } });
        return;
      }
      threadId = m.params.threadId;
      out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: threadId }, cwd: m.params.cwd } });
    } else if (m.method === 'turn/start') {
      turnId = 'tu-' + Date.now();
      steered = [];
      process.stderr.write('TURNSTART ' + JSON.stringify(m.params) + '\\n');
      out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } });
      note('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } });
      const text = (m.params.input || []).filter((i) => i.type === 'text').map((i) => i.text).join(' ');
      setTimeout(() => {
        note('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { type: 'commandExecution', id: 'e1', command: "/bin/zsh -lc 'npm run build'", cwd: '/tmp', status: 'inProgress' } });
        note('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { type: 'commandExecution', id: 'e1', command: "/bin/zsh -lc 'npm run build'", status: 'completed', exitCode: 0 } });
        note('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/tmp/repo/src/a.ts' }] } });
        note('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/tmp/repo/src/a.ts' }] } });
        note('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { type: 'mcpToolCall', id: 'm1', tool: 'execute_sql', server: 'supabase', status: 'inProgress' } });
        note('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { type: 'mcpToolCall', id: 'm1', tool: 'execute_sql', server: 'supabase', status: 'completed' } });
      }, 20);
      const hold = Number(knob('holdMs') || 60);
      setTimeout(() => {
        if (turnId === null) return; // interrupted
        const answer = 'FAKE:' + text + (steered.length ? ' | STEERED:' + steered.join(',') : '');
        note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 41, outputTokens: 7 }, total: { inputTokens: 41, outputTokens: 7 }, modelContextWindow: 258400 } });
        note('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'a1', text: answer } });
        note('turn/completed', { threadId, turn: { id: turnId, items: [{ type: 'agentMessage', id: 'a1', text: answer, phase: 'final_answer' }], status: 'completed' } });
        turnId = null;
      }, hold);
    } else if (m.method === 'turn/steer') {
      if (knob('notSteerable')) {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'refused', data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } } } });
        return;
      }
      if (m.params.expectedTurnId !== turnId) {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'expected active turn id \\\`' + m.params.expectedTurnId + '\\\` but found \\\`' + turnId + '\\\`' } });
        return;
      }
      steered.push((m.params.input || []).map((i) => i.text).join(' '));
      out({ jsonrpc: '2.0', id: m.id, result: { turnId } });
    } else if (m.method === 'turn/interrupt') {
      out({ jsonrpc: '2.0', id: m.id, result: {} });
      note('turn/completed', { threadId, turn: { id: m.params.turnId, items: [], status: 'interrupted' } });
      turnId = null;
    }
  }
});
`,
);
chmodSync(AS_FAKE, 0o755);

const AS = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        `
import fs from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import {
  APP_SERVER_ARGS, APP_SERVER_INIT_TIMEOUT_MS, answerFromTurn, classifyAppServerError, createJsonLineReader,
  execFallbackLine, frameMessage, initializeRequest, initializedNotification, mapNotification,
  shouldFallBackToExec, steerRefusalNote, threadResumeRequest, threadStartRequest, turnInterruptRequest,
  turnStartRequest, turnSteerRequest,
} from ${url('codex-appserver.mjs')};
import { codexChatError, codexPaths, codexRunId, freeCodexStart, isCodexImage } from ${url('bg-codex.mjs')};
import { codexChatSandbox } from ${url('engine-state.mjs')};
import { briefTitle, stripLaneRules } from ${url('bg-notify.mjs')};
import { queueAck, queueRunningNow } from ${url('system-messages.mjs')};
import { clip, oneLine, renderEntry, renderTail, quoteBlock, thinkingWord, fmtElapsed } from ${url('progress-render.mjs')};
const { existsSync, mkdirSync, writeFileSync, readFileSync } = fs;
export const SENT = [];
export const RESULTS = [];
export const PROGRESS = [];
export const RING = [];
export const FELLBACK = [];
export const TG = [];
export const DRAINED = [];
// The Codex chat lane now settles the worker lines waiting on "reading it
// now…" when M's turn ends, so this harness has to provide it: without it the
// finally threw and the lane was never given back.
export const READING_SETTLED = [];
const settleReadingNotices = () => { READING_SETTLED.push(Date.now()); };
export const WALL = [];
export const STATE = { cwd: ${JSON.stringify(TMP)}, yolo: true };
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const sendResult = (t) => { RESULTS.push(t); return Promise.resolve(); };
const recordChatTurn = (e) => { RING.push(e); };
const chatState = () => STATE;
export let SAVED = 0;
const saveState = () => { SAVED++; };
export const LANES = { main: { name: 'main', current: null, queue: [], finishing: 0 } };
const drainQueue = (l) => { DRAINED.push(l.name); };
const CHAT_ID = '1';
const EDIT_INTERVAL_MS = 20;
const TYPING_INTERVAL_MS = 50;
const IDLE_EDIT_MS = 20;
const PROGRESS_TAIL = 3400;
const TG_MSG_LIMIT = 4000;
const QUEUE_MAX = 5;
const STEER_RECORD_MAX = 400;
const WORD_HOLD_SEC = 12;
const THINKING_WORDS = ['Thinking', 'Digging', 'Cooking'];
const HOME = ${JSON.stringify(TMP)};
const OWNER_TZ = 'UTC';
const escHtml = (s) => String(s);
let editCooldownUntil = 0;
let msgId = 0;
const tg = (method, payload) => { TG.push({ method, payload }); if (method === 'sendMessage') return Promise.resolve({ message_id: ++msgId }); return Promise.resolve({}); };
const editProgress = (id, html, plain) => { PROGRESS.push({ id, html, plain: plain() }); return Promise.resolve(); };
export const codexRuns = new Map();
const noteCodexWall = () => { WALL.push('set'); return Date.now() + 3600000; };
const clearCodexWall = () => { WALL.push('clear'); };
export let codexPausedUntil = 0;
export let RUNS_DIR = ${JSON.stringify(AS_RUNS)};
export let CODEX_BIN = ${JSON.stringify(AS_FAKE)};
export let CODEX_TIMEOUT_MS = 0;
export const setTimeoutMs = (v) => { CODEX_TIMEOUT_MS = v; };
export let CODEX_APP_SERVER = true;
export const setAppServerEnabled = (v) => { CODEX_APP_SERVER = v; };
const CODEX_MODEL = null;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const CONF = {};
const conf = (key, fallback) => (key in CONF ? CONF[key] : fallback);
// conf() can hand back a string (the environment layer), so the real code reads
// its booleans through confBool. Same coercion here, or an extracted function
// would call an undefined name.
const confBool = (k, f) => {
  const v = conf(k, f);
  if (typeof v !== 'string') return Boolean(v);
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return Boolean(f);
};
export const setConf = (k, v) => { CONF[k] = v; };
const codexSettingsNow = () => ({ model: null, effort: null });
const codexChatBox = ({ network = null } = {}) =>
  codexChatSandbox({ yolo: STATE.yolo !== false, network: network === false ? false : STATE.codexNetwork !== false });
// The exec path is a recorder here: what matters is WHETHER the lane falls back
// and with which reason, not what the one-shot rail then does (section 12).
const runCodexChatExec = (rawText, opts) => { FELLBACK.push({ rawText, opts }); return null; };
export const queueItem = (text, o = {}) => ({ text, images: o.images || [], forcedEngine: o.forcedEngine || null, priority: false, allowCodexFallback: false });
// The ack LIFECYCLE is asserted where the queue lives (section 15 and
// system-wiring.test.mjs). Here the question is the refusal's routing, so this
// only has to record that the ack was tracked against the pushed item.
export const TRACKED = [];
const trackQueueAck = (item, lane, id, body) => { TRACKED.push({ item, lane: lane.name, id, body }); };
export const reset = () => {
  SENT.length = 0; RESULTS.length = 0; PROGRESS.length = 0; RING.length = 0; FELLBACK.length = 0;
  TG.length = 0; DRAINED.length = 0; WALL.length = 0; codexRuns.clear(); SAVED = 0;
  LANES.main.current = null; LANES.main.queue.length = 0; LANES.main.finishing = 0;
  delete STATE.codexThreadId; delete STATE.codexThreadAt; delete STATE.codexTurnInFlight;
  STATE.yolo = true; delete STATE.codexNetwork; delete STATE.gen_main;
  codexAppServerDeaths.length = 0; codexAppServerInitFailed = false; CODEX_APP_SERVER = true; CODEX_TIMEOUT_MS = 0;
  for (const k of Object.keys(CONF)) delete CONF[k];
};
// The module state runCodexChatTurn closes over. Declared here rather than
// grabbed, because grab() only understands function and const heads: a rename
// in bridge.mjs therefore fails LOUDLY (the grabbed functions reference the old
// name and nothing declares it) rather than silently diverging.
let codexAppServerClient = null;
let codexAppServerReady = null;
const codexAppServerDeaths = [];
let codexAppServerInitFailed = false;
let codexAppServerTurn = null;
const CODEX_AVAILABLE = true;
export const deaths = () => codexAppServerDeaths;
export const client = () => codexAppServerClient;
export const initFailed = () => codexAppServerInitFailed;
`,
        // Grabbed, not re-declared: a bridge.mjs constant the extracted functions
        // close over. The first version of this harness omitted it and every
        // request died with "APP_SERVER_CALL_TIMEOUT_MS is not defined", which
        // t() swallowed into a red bubble the asserts then read as a settled
        // turn. Section 19z below is the guard for that whole class.
        grab('APP_SERVER_CALL_TIMEOUT_MS', 'const'),
        grab('codexAppServerState', 'const'),
        grab('codexAppServerUsable', 'const'),
        grab('noteCodexAppServerDeath'),
        grab('startCodexAppServer'),
        grab('getCodexAppServer'),
        grab('killCodexAppServer'),
        grab('rememberCodexThread'),
        grab('clearCodexThread'),
        grab('writeCodexMeta'),
        grab('finalizeCodexMeta'),
        grab('runCodexChatTurn'),
        grab('runCodexChat'),
        grab('codexFallbackToldAbout', 'const'),
        'export { runCodexChat, runCodexChatTurn, getCodexAppServer, killCodexAppServer, codexAppServerUsable, codexAppServerState };',
      ].join('\n'),
    )
);

const asSettled = (ms = 15000) =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      if (AS.LANES.main.current === null && (AS.RESULTS.length || AS.SENT.length || AS.FELLBACK.length)) return resolve();
      if (Date.now() - at > ms) return reject(new Error('the app-server chat turn never settled'));
      setTimeout(tick, 20);
    };
    tick();
  });
const waitFor = (fn, ms = 8000, what = 'condition') =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - at > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });

AS.reset();
const asRun = AS.runCodexChat('what is in this repo');

await t('★ the turn claims LANES.main synchronously, and it IS steerable', () => {
  ok(AS.LANES.main.current, 'the lane was not claimed');
  eq(AS.LANES.main.current.engine, 'codex');
  eq(AS.LANES.main.current.transport, 'appserver');
  eq(typeof AS.LANES.main.current.steer, 'function', 'no steer means dispatchPrompt queues, which is the old behaviour');
  eq(typeof AS.LANES.main.current.terminate, 'function', '/stop has to reach it');
});

await t('a turn in flight is recorded, so a restart can say what was lost', () => {
  ok(AS.STATE.codexTurnInFlight, 'nothing marked in state');
  ok(AS.STATE.codexTurnInFlight.prompt.includes('what is in this repo'), JSON.stringify(AS.STATE.codexTurnInFlight));
});

await asSettled();

await t('★ the answer comes back as a chat reply', () => {
  eq(AS.RESULTS.length, 1, JSON.stringify(AS.RESULTS));
  ok(AS.RESULTS[0].includes('what is in this repo'), AS.RESULTS[0]);
});

await t('★ the tool steps were STREAMED into the bubble, not invented at the end', () => {
  const all = AS.PROGRESS.map((p) => p.plain).join('\n');
  ok(/Bash npm run build/.test(all), `no Bash step: ${all}`);
  ok(/Edit .*a\.ts/.test(all), `no Edit step: ${all}`);
  ok(/execute_sql/.test(all), `no MCP step: ${all}`);
});

await t('★ the final bubble is the Claude footer exactly: ✅ Done · Ns · N steps', () => {
  const last = AS.PROGRESS[AS.PROGRESS.length - 1].plain;
  ok(last.startsWith('✅ Done'), last);
  ok(/✅ Done \(\d+s · 3 steps\)/.test(last), last);
});

await t('★ NO TOKEN COUNT appears in ANY bubble string', () => {
  // The one cosmetic thing the owner named. The numbers still exist; they live in
  // the meta sidecar, /account and /usage.
  const everything = [...AS.PROGRESS.map((p) => `${p.html}\n${p.plain}`), ...AS.TG.map((x) => JSON.stringify(x.payload))].join('\n');
  ok(!/\bin \/|tokens\b|\d+ in \//.test(everything), `a token count reached the bubble: ${everything}`);
  ok(!/\b41\b|\b7 out\b/.test(everything), `the fake's token numbers reached the bubble: ${everything}`);
});

await t('the running header carries the brain emoji and a cycling word, like the Claude one', () => {
  const first = AS.PROGRESS.find((p) => p.plain.startsWith('🧠'));
  ok(first, `no 🧠 header: ${AS.PROGRESS.map((p) => p.plain).join(' | ')}`);
  ok(/🧠 Codex · \w+…/.test(first.plain), first.plain);
});

await t('the tokens DO reach the meta sidecar, which is what /account and /usage tally', () => {
  const metas = readdirSync(AS_RUNS).filter((f) => f.endsWith('.meta.json'));
  ok(metas.length >= 1, `no sidecar written: ${metas.join(',')}`);
  const m = JSON.parse(readFileSync(path.join(AS_RUNS, metas[metas.length - 1]), 'utf8'));
  eq(m.mode, 'chat');
  eq(m.inputTokens, 41);
  eq(m.outputTokens, 7);
  eq(m.status, 'finished');
});

await t('the thread id is stored, never rendered, and the in-flight marker is cleared', () => {
  eq(AS.STATE.codexThreadId, 'th-app-1');
  eq(AS.STATE.codexTurnInFlight, undefined, 'a finished turn left a restart marker behind');
  const everythingSaid = [...AS.SENT, ...AS.RESULTS, ...AS.PROGRESS.map((p) => p.plain)].join('\n');
  ok(!everythingSaid.includes('th-app-1'), `the thread id reached a bubble: ${everythingSaid}`);
});

await t('the lane is given back and the queue drained', () => {
  eq(AS.LANES.main.current, null);
  ok(AS.DRAINED.includes('main'));
});

await t('the chat ring got both halves of the turn, with the paths it touched', () => {
  eq(AS.RING.length, 2);
  eq(AS.RING[0].role, 'user');
  eq(AS.RING[1].role, 'assistant');
  eq(JSON.stringify(AS.RING[1].paths), JSON.stringify(['/tmp/repo/src/a.ts']));
});

await t('★ 19z: nothing in this section died on a missing identifier', () => {
  // A grabbed function's free variables are supplied by the harness, so one it
  // forgets becomes a ReferenceError INSIDE the run, which the lane reports as
  // an ordinary red bubble and every assertion below then reads as a settled
  // turn. That is exactly how the first version of this section passed while
  // doing nothing. Cheap, and it catches the whole class.
  const said = [...AS.SENT, ...AS.RESULTS, ...AS.PROGRESS.map((p) => p.plain)].join('\n');
  ok(!/is not defined|is not a function/.test(said), `a missing identifier reached the owner: ${said}`);
});

// ---------------------------------------------------------------------------
console.log('\n19b. the second turn resumes the thread, and one server serves both');
// ---------------------------------------------------------------------------

const pidAfterFirst = AS.client()?.child?.pid;
AS.SENT.length = 0;
AS.RESULTS.length = 0;
AS.PROGRESS.length = 0;
AS.LANES.main.current = null;
AS.runCodexChat('and now the second question');
await asSettled();

await t('★ ONE app-server child serves both turns (not one per turn)', () => {
  eq(AS.client()?.child?.pid, pidAfterFirst, 'a second child was spawned for the second turn');
  eq(AS.deaths().length, 0, 'the first child died');
});

await t('the second turn RESUMED rather than starting a new thread', () => {
  eq(AS.STATE.codexThreadId, 'th-app-1');
  eq(AS.RESULTS.length, 1);
  ok(AS.RESULTS[0].includes('second question'), AS.RESULTS[0]);
});

// ---------------------------------------------------------------------------
console.log('\n19c. ★ a message typed mid-turn is STEERED, with the Claude ack');
// ---------------------------------------------------------------------------

AS.reset();
knobs({ holdMs: 900 });
AS.runCodexChat('count slowly to ten');
const live = await waitFor(() => (AS.LANES.main.current?.canSteer?.() ? AS.LANES.main.current : null), 8000, 'a steerable turn');
const acked = live.steer('stop after five and say STEERED');

await t('★ steer() returns true, which is what makes dispatchPrompt send the SAME ack as Claude', () => {
  // dispatchPrompt does: if (lane.current.steer && lane.current.steer(text)) send('➡️ Sent into the running task.')
  // so the ack wording is identical by construction rather than by copying it.
  eq(acked, true, 'the mid-turn message was refused, so it would have been queued instead');
});

await t('★ the steer is recorded on the run, the way the Claude lane records it', () => {
  // run.steers is what /status, `bg.mjs ps` and the STEERED IN block all read.
  const note = live.steers[live.steers.length - 1];
  ok(note && note.text.includes('stop after five'), JSON.stringify(live.steers));
  ok(note.ts, 'a steer with no timestamp cannot be ordered against the others');
});

await asSettled(20000);
knobs();

await t('★ the model actually SAW the mid-turn message: the answer reflects it', () => {
  ok(AS.RESULTS[0].includes('STEERED:stop after five'), AS.RESULTS[0]);
});

await t('the steered note is in the final bubble, so the record survives the run', () => {
  const last = AS.PROGRESS[AS.PROGRESS.length - 1].plain;
  ok(/steered in: stop after five/.test(last), last);
});

// ---------------------------------------------------------------------------
console.log('\n19d. a turn that cannot take a mid-turn message falls back to the queue');
// ---------------------------------------------------------------------------

AS.reset();
knobs({ holdMs: 900, notSteerable: true });
AS.runCodexChat('a review-shaped turn');
const live2 = await waitFor(() => (AS.LANES.main.current?.canSteer?.() ? AS.LANES.main.current : null), 8000, 'a steerable turn');
eq(live2.steer('this will be refused'), true, 'the refusal must still ack optimistically, the way the Claude splice does');
await waitFor(() => AS.SENT.some((s) => s.includes('could not take it mid-turn')), 8000, 'the correction line');

await t('★ ActiveTurnNotSteerable corrects the ack and QUEUES the message, naming why', () => {
  const line = AS.SENT.find((s) => s.includes('could not take it mid-turn'));
  ok(line, AS.SENT.join(' | '));
  ok(line.includes('review or a compaction'), `the actual cause must survive the clip: ${line}`);
  ok(line.startsWith('📥 Queued · #1 · 🧠 Codex'), `the house-style ack: ${line}`);
  eq(AS.LANES.main.queue.length, 1, 'the refused message was dropped instead of queued');
  eq(AS.LANES.main.queue[0].forcedEngine, 'codex', 'the queued message must not silently run on the other engine');
});

await t('the ack is tracked against the item that was PUSHED, never the queue tail', () => {
  const tracked = AS.TRACKED[AS.TRACKED.length - 1];
  ok(tracked, 'the refusal ack was not registered for its position edits');
  eq(tracked.item, AS.LANES.main.queue[0], 'a full queue pushes nothing, and the tail would be someone else\'s message');
  eq(tracked.item.ackReason.includes('review or a compaction'), true);
});

await asSettled(20000);
knobs();

await t('and the FINAL step list says what happened, rather than claiming it landed', () => {
  // Asserted on the final bubble, not on a mid-run render: the correction
  // replaces the optimistic note in place, and the edit carrying it is the next
  // one on the cadence. It leads with what DID happen (it queued), not with
  // what did not: "not steered in, queued instead" said the same thing twice.
  const last = AS.PROGRESS[AS.PROGRESS.length - 1].plain;
  ok(/📨 Queued instead \(that Codex turn cannot take a mid-turn message/.test(last), last);
  ok(!/📨 steered in: this will be refused/.test(last), `the bubble still claims it landed: ${last}`);
});

// ---------------------------------------------------------------------------
console.log('\n19e. /stop is an interrupt, not a SIGTERM at a shared server');
// ---------------------------------------------------------------------------

AS.reset();
knobs({ holdMs: 4000 });
AS.runCodexChat('a turn we will stop');
const live3 = await waitFor(() => (AS.LANES.main.current?.canSteer?.() ? AS.LANES.main.current : null), 8000, 'a live turn');
const serverPid = AS.client()?.child?.pid;
live3.stopped = true;
live3.terminate();
await asSettled(20000);
knobs();

await t('★ the turn stops and says so', () => {
  ok(AS.SENT.some((s) => s.includes('Task stopped')), AS.SENT.join(' | '));
  const last = AS.PROGRESS[AS.PROGRESS.length - 1].plain;
  ok(last.startsWith('🛑 Stopped'), last);
});

await t('★ the shared app-server SURVIVES the stop (killing it would end every chat)', () => {
  eq(AS.client()?.child?.pid, serverPid, 'the app-server was killed to stop one turn');
  eq(AS.deaths().length, 0);
});

await t('★ a stopped turn is recorded as STOPPED, not as a clean answer', () => {
  // Found by the live probe: an interrupted turn wrote status "finished" with
  // zero tokens, so /account's last-run line reported a turn the owner killed
  // as a finished one.
  const metas = readdirSync(AS_RUNS).filter((f) => f.endsWith('.meta.json')).sort();
  const m = JSON.parse(readFileSync(path.join(AS_RUNS, metas[metas.length - 1]), 'utf8'));
  eq(m.status, 'stopped', JSON.stringify(m));
});

// ---------------------------------------------------------------------------
console.log('\n19f. a dead thread starts a fresh one in the same turn');
// ---------------------------------------------------------------------------

AS.reset();
AS.STATE.codexThreadId = 'th-long-gone';
knobs({ deadThread: true });
AS.runCodexChat('does this still work');
await asSettled(20000);
knobs();

await t('★ "no rollout found" clears the thread and starts a fresh one WITHOUT losing the message', () => {
  ok(AS.SENT.some((s) => s.includes('old Codex thread is gone')), AS.SENT.join(' | '));
  eq(AS.STATE.codexThreadId, 'th-app-1', 'a fresh thread was not started');
  eq(AS.RESULTS.length, 1, 'the message was lost');
  ok(AS.RESULTS[0].includes('does this still work'), AS.RESULTS[0]);
});

// ---------------------------------------------------------------------------
console.log('\n19g. the app-server dies, and the chat lane survives it');
// ---------------------------------------------------------------------------

AS.reset();
AS.STATE.codexThreadId = 'th-app-1';
AS.killCodexAppServer();
AS.runCodexChat('after the server was killed');
await asSettled(20000);

await t('★ a fresh child resumes the SAME thread after the old one is gone', () => {
  eq(AS.RESULTS.length, 1, AS.SENT.join(' | '));
  eq(AS.STATE.codexThreadId, 'th-app-1');
  ok(AS.client()?.alive, 'no live client after the respawn');
});

// ---------------------------------------------------------------------------
console.log('\n19h. ★ the fallback to `codex exec` is reachable, and says so');
// ---------------------------------------------------------------------------

AS.reset();
AS.setAppServerEnabled(false);

await t('config can switch the app-server off, and then the dispatcher picks exec', () => {
  eq(AS.codexAppServerUsable(), false);
  AS.runCodexChat('one shot please');
  eq(AS.FELLBACK.length, 1, 'the exec path was not reached');
  eq(AS.FELLBACK[0].opts.fellBack, 'disabled', 'the exec path must know WHY it was chosen, to say so once');
  eq(AS.LANES.main.current, null, 'the app-server path claimed a lane it then did not use');
});

AS.reset();
AS.killCodexAppServer(); // otherwise the LIVE child from 19g answers and nothing falls back
knobs({ noInit: true });
AS.runCodexChatTurn('a binary with no app-server');
await waitFor(() => AS.FELLBACK.length > 0, 20000, 'the fallback to exec');
knobs();

await t('★ a `codex` that never answers initialize falls back to exec, once, permanently', () => {
  eq(AS.FELLBACK.length, 1, 'the turn did not fall back');
  eq(AS.FELLBACK[0].opts.fellBack, 'init_failed');
  eq(AS.LANES.main.current, null, 'the lane was not given back before the fallback');
  eq(AS.initFailed(), true);
  eq(AS.codexAppServerUsable(), false, 'it would keep paying the 5s deadline on every later turn');
});

await t('the fallback line names the reason and promises no steering', () => {
  const line = execFallbackLine('init_failed');
  ok(line.includes('steering unavailable on this Codex run'), line);
  ok(line.includes('no app-server'), line);
});

AS.reset();
AS.killCodexAppServer();

// ---------------------------------------------------------------------------
console.log('\n20. the queue ack, kept alive');
// ---------------------------------------------------------------------------
//
// "Queued for the main lane (#2), runs on claude when its current task
// finishes" was true when it left and static for the whole wait, so a queue
// that had moved and a queue that was stuck looked identical. These drive the
// REAL dispatchPrompt/drainQueue against the fake transport.

P.reset();
P.LANES.main.current = { engine: 'claude', prompt: 'audit the system messages', steer: () => false };
P.dispatchPrompt('first in line', undefined, { allowCodexFallback: true });
P.dispatchPrompt('second in line', undefined, { allowCodexFallback: true });
await new Promise((r) => setTimeout(r, 20)); // the acks are sent asynchronously

await t('each queued message is acked with its own position and what it waits on', () => {
  const acks = P.SENT.filter((t) => t.startsWith('📥 Queued'));
  eq(acks.length, 2);
  ok(acks[0].startsWith('📥 Queued · #1 · 🤖 Claude'), acks[0]);
  ok(acks[1].startsWith('📥 Queued · #2 in line · 🤖 Claude'), acks[1]);
  ok(acks[0].includes('Waiting on: "audit the system messages"'), acks[0]);
});

await t('and each ack is registered live so its position can change', () => {
  eq(P.LIVE.size, 2, 'a static ack is the whole defect this fixes');
  ok(P.LANES.main.queue.every((q) => q.ackMsgId), 'no message id kept means no edit is possible');
});

const firstItem = P.LANES.main.queue[0];
const secondItem = P.LANES.main.queue[1];
P.LANES.main.current = null;
P.drainQueue(P.LANES.main);
await new Promise((r) => setTimeout(r, 10));

await t('★ when its turn comes the SAME message becomes ▶️ Started, not a new one', () => {
  const edit = P.EDITS.find((e) => e.id === firstItem.ackMsgId || e.html.startsWith('▶️ Started'));
  ok(edit, `no terminal edit: ${JSON.stringify(P.EDITS)}`);
  ok(edit.html.startsWith('▶️ Started'), edit.html);
  ok(!P.SENT.some((t) => t.startsWith('▶️ Started')), 'a second message would be the duplication this removes');
});

await t('and the started ack retires from the live set', () => {
  ok([...P.LIVE].every((e) => !e.done || true), 'sanity');
  ok(firstItem.ackLive.done, 'a resolved ack that keeps ticking can edit past its terminal state');
});

// The one ahead of it is gone, so #2 is now #1. The tick is what says so.
await new Promise((r) => setTimeout(r, 10));
for (const e of P.LIVE) if (!e.done) e.tick(Date.now() + 60_000);

await t('★ a message that moves up the queue is told so, on the same message', () => {
  const moved = P.EDITS.filter((e) => e.id === secondItem.ackMsgId && e.html.startsWith('📥 Queued · #1'));
  ok(moved.length >= 1, `position never updated: ${JSON.stringify(P.EDITS)}`);
});

P.reset();
P.LANES.main.current = { engine: 'claude', prompt: 'something long', steer: () => false };
P.dispatchPrompt('will be stopped', undefined, { allowCodexFallback: true });
await new Promise((r) => setTimeout(r, 20));
const doomed = P.LANES.main.queue[0];
for (const q of P.LANES.main.queue) P.resolveQueueAck(q, 'dropped');
P.LANES.main.queue.length = 0;
await new Promise((r) => setTimeout(r, 10));

await t('★ /stop clearing the queue resolves every ack it strands', () => {
  const edit = P.EDITS[P.EDITS.length - 1];
  eq(edit.html, '🛑 Dropped from the queue', 'otherwise the last word on screen is a position that no longer exists');
  eq(doomed.ackLive.done, true);
});

P.reset();
P.LANES.main.current = { engine: 'claude', prompt: 'x', steer: () => false };
P.dispatchPrompt('races its own ack', undefined, { allowCodexFallback: true });
// The lane frees up and drains BEFORE the ack's round trip lands. This is the
// race that used to leave the last word on screen as "📥 Queued · #1".
const racer = P.LANES.main.queue[0];
P.LANES.main.current = null;
P.drainQueue(P.LANES.main);
await new Promise((r) => setTimeout(r, 20));

await t('★ a lane that drains before the ack lands still resolves it', () => {
  ok(racer.ackMsgId === null, 'the ack must be resolved, not left pending forever');
  const edit = P.EDITS.find((e) => e.html.startsWith('▶️ Started'));
  ok(edit, `the ack was stranded at "Queued": ${JSON.stringify(P.EDITS)}`);
});

await t('a full queue says so, and offers the two things he can do', () => {
  P.reset();
  P.LANES.main.current = { engine: 'claude', prompt: 'x', steer: () => false };
  for (let i = 0; i < P.QUEUE_MAX + 1; i++) P.dispatchPrompt(`msg ${i}`, undefined, { allowCodexFallback: true });
  const full = P.SENT.find((t) => t.startsWith('⏳'));
  eq(full, '⏳ main queue is full (5)\nWait, or /stop main to clear it.');
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-codex wiring tests pass');
