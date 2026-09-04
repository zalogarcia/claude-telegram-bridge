#!/usr/bin/env node
// Tests for the Codex engine's pure half (bg-codex.mjs).
//
// Everything that decides WHAT gets run, WHERE, and what the owner and the assistant are told
// about it lives in that module precisely so it can be asserted without a
// daemon, a Telegram token, an OpenAI key or a paid API call. bridge.mjs only
// wires it up.
//
//   node bg-codex.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_BIN,
  CODEX_LANE,
  CODEX_MODES,
  ENGINE_PREFIX_RE,
  PARKED_ANSWER_MAX,
  PARKED_PROMPT_MAX,
  buildCodexArgs,
  codexCwdForBrief,
  codexFallbackPrefix,
  codexHandbackHeader,
  codexOutcome,
  codexParkedNote,
  codexPaths,
  codexReasonText,
  codexReviewScope,
  codexReviewTask,
  codexRunId,
  codexStartNotice,
  parseCodexReview,
  resolveCodexReviewDir,
  fmtCodexTokens,
  freeCodexStart,
  fmtUntil,
  parseCodexEvents,
  parseEnginePrefix,
  shouldRouteToCodex,
} from './bg-codex.mjs';
import { parseRunId } from './bg-steer.mjs';

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
  if (!cond) throw new Error(msg);
};
const has = (arr, ...seq) => {
  const i = arr.indexOf(seq[0]);
  if (i === -1) throw new Error(`missing ${seq[0]} in ${JSON.stringify(arr)}`);
  for (let k = 0; k < seq.length; k++) {
    if (arr[i + k] !== seq[k]) throw new Error(`expected ${JSON.stringify(seq)} at ${i} in ${JSON.stringify(arr)}`);
  }
};

// ---------------------------------------------------------------------------
// 1. Command assembly
// ---------------------------------------------------------------------------

t('ask mode is read-only and runs in the given cwd', () => {
  const a = buildCodexArgs({ mode: 'ask', cwd: '/repo', lastFile: '/out/last.md' });
  eq(a[0], 'exec');
  has(a, '--sandbox', 'read-only');
  has(a, '-C', '/repo');
  has(a, '-o', '/out/last.md');
  ok(a.includes('--skip-git-repo-check'), 'a non-repo cwd must not abort the run');
  ok(a.includes('--json'), 'the event stream is how tokens and failures are read');
  eq(a[a.length - 1], '-', 'the prompt must arrive on stdin, never in argv');
});

t('edit mode is workspace-write and network stays OFF by default', () => {
  const a = buildCodexArgs({ mode: 'edit', cwd: '/repo', lastFile: '/o/l.md' });
  has(a, '--sandbox', 'workspace-write');
  ok(!a.join(' ').includes('network_access'), 'network must be opt-in');
});

t('edit mode opens the network only when asked', () => {
  const a = buildCodexArgs({ mode: 'edit', cwd: '/repo', network: true });
  has(a, '-c', 'sandbox_workspace_write.network_access=true');
});

t('ask mode cannot open the network', () => {
  const a = buildCodexArgs({ mode: 'ask', cwd: '/repo', network: true });
  ok(!a.join(' ').includes('network_access'), 'read-only mode has no writable sandbox to open');
});

t('review takes no -C, no --sandbox and no --color', () => {
  // Measured against codex-cli 0.153.0: `codex exec review` rejects --color
  // outright, and has neither -C nor --sandbox. The caller sets cwd on the
  // child process instead. A regression here is an instant exit-2 run.
  const a = buildCodexArgs({ mode: 'review', cwd: '/repo', lastFile: '/o/l.md', hasPrompt: false });
  ok(!a.includes('-C'), 'review has no -C');
  ok(!a.includes('--sandbox'), 'review has no --sandbox');
  ok(!a.includes('--color'), 'review REJECTS --color');
  has(a, 'exec', 'review');
  ok(a.includes('--uncommitted'), 'default review scope');
});

t('review with custom instructions drops the scope flag', () => {
  // `error: the argument '--uncommitted' cannot be used with '[PROMPT]'`
  const a = buildCodexArgs({ mode: 'review', hasPrompt: true });
  ok(!a.includes('--uncommitted'), 'a prompt and a scope flag cannot coexist');
  eq(a[a.length - 1], '-');
});

t('review scopes: base and commit', () => {
  ok(buildCodexArgs({ mode: 'review', hasPrompt: false, reviewScope: 'base:main' }).join(' ').includes('--base main'));
  ok(buildCodexArgs({ mode: 'review', hasPrompt: false, reviewScope: 'commit:abc123' }).join(' ').includes('--commit abc123'));
});

t('a bad review scope throws rather than silently reviewing the wrong thing', () => {
  let threw = false;
  try {
    buildCodexArgs({ mode: 'review', hasPrompt: false, reviewScope: 'everything' });
  } catch {
    threw = true;
  }
  ok(threw, 'bad scope accepted');
});

t('an unknown mode throws', () => {
  let threw = false;
  try {
    buildCodexArgs({ mode: 'yolo' });
  } catch {
    threw = true;
  }
  ok(threw, 'unknown mode accepted');
});

t('model and ephemeral are passed through', () => {
  const a = buildCodexArgs({ mode: 'ask', model: 'gpt-5.6-sol', ephemeral: true });
  has(a, '-m', 'gpt-5.6-sol');
  ok(a.includes('--ephemeral'));
});

t('NO MODE EVER EMITS THE SANDBOX BYPASS FLAG', () => {
  // The single most dangerous flag in the CLI. `codex exec` already runs with
  // approval policy "never", so the sandbox is the only thing left between the
  // model and the filesystem.
  for (const mode of CODEX_MODES) {
    const a = buildCodexArgs({ mode, cwd: '/repo', network: true, hasPrompt: mode !== 'review' });
    const s = a.join(' ');
    ok(!s.includes('dangerously'), `${mode} emitted a dangerous flag: ${s}`);
    ok(!s.includes('--yolo'), `${mode} emitted --yolo`);
  }
});

t('no argument ever carries a credential', () => {
  // Auth comes from ~/.codex/auth.json via the inherited environment. A key in
  // argv would land in `ps` output and in the inflight registry.
  for (const mode of CODEX_MODES) {
    const s = buildCodexArgs({ mode, cwd: '/repo', model: 'm', hasPrompt: mode !== 'review' }).join(' ');
    ok(!/sk-|api[-_]?key|token/i.test(s), `${mode} argv mentions a credential: ${s}`);
  }
});

eq(CODEX_BIN, 'codex', 'the binary name');
eq(CODEX_LANE, 'codex', 'the lane label');

// ---------------------------------------------------------------------------
// 2. Routing: which engine runs this job
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
const NOW = 1_788_000_000_000;

t('an explicit codex flag always wins', () => {
  const r = shouldRouteToCodex({ engineFlag: 'codex', rotationPausedUntil: 0, now: NOW, codexFallback: false });
  eq(r.engine, 'codex');
  eq(r.reason, 'explicit');
});

t('nothing routes to codex while Claude is healthy', () => {
  const r = shouldRouteToCodex({ rotationPausedUntil: 0, now: NOW, codexFallback: true });
  eq(r.engine, 'claude');
  eq(r.reason, null);
});

t('an expired pause is not a pause', () => {
  const r = shouldRouteToCodex({ rotationPausedUntil: NOW - HOUR, now: NOW, codexFallback: true });
  eq(r.engine, 'claude');
});

t('every account limited routes an unpinned job to codex', () => {
  const r = shouldRouteToCodex({ rotationPausedUntil: NOW + HOUR, now: NOW, codexFallback: true });
  eq(r.engine, 'codex');
  eq(r.reason, 'claude_limited');
  eq(r.pausedUntil, NOW + HOUR, 'the reset time travels with the decision');
});

t('/codex off really disables the fallback', () => {
  const r = shouldRouteToCodex({ rotationPausedUntil: NOW + HOUR, now: NOW, codexFallback: false });
  eq(r.engine, 'claude', 'the setting is the whole point of the setting');
  eq(r.reason, null);
});

t('an explicit claude pin is honoured even while limited', () => {
  const r = shouldRouteToCodex({ engineFlag: 'claude', rotationPausedUntil: NOW + HOUR, now: NOW, codexFallback: true });
  eq(r.engine, 'claude');
});

t('an explicit codex flag does not need the fallback setting', () => {
  eq(shouldRouteToCodex({ engineFlag: 'CODEX', codexFallback: false }).engine, 'codex', 'case insensitive');
});

// ---------------------------------------------------------------------------
// 3. The codex: prefix, and its copy inside bg.mjs
// ---------------------------------------------------------------------------

t('the codex: prefix routes and is stripped', () => {
  const r = parseEnginePrefix('codex: what does this repo do');
  eq(r.engine, 'codex');
  eq(r.text, 'what does this repo do');
});

t('a message merely mentioning codex is not routed', () => {
  const r = parseEnginePrefix('should we use codex: maybe');
  eq(r.engine, null);
  eq(r.text, 'should we use codex: maybe', 'text untouched');
});

t('bg.mjs carries the SAME prefix shape', () => {
  // bg.mjs imports nothing on purpose (it is copied around and run from temp
  // dirs), so its copy is asserted here rather than shared, exactly like
  // TARGET_SHAPE in bg-steer.test.mjs.
  const src = readFileSync(path.join(DIR, 'bg.mjs'), 'utf8');
  ok(src.includes(ENGINE_PREFIX_RE.source), `bg.mjs lost the prefix regex ${ENGINE_PREFIX_RE.source}`);
});

// ---------------------------------------------------------------------------
// 4. Where a codex job runs
// ---------------------------------------------------------------------------

t('a named repo that exists becomes the cwd', () => {
  eq(codexCwdForBrief('web-app', { devDir: '/Users/z/dev', fallbackCwd: '/Users/z/dev', exists: (p) => p === '/Users/z/dev/web-app' }), '/Users/z/dev/web-app');
});

t('a named repo that is not checked out falls back', () => {
  eq(codexCwdForBrief('ghost', { devDir: '/Users/z/dev', fallbackCwd: '/Users/z/other', exists: () => false }), '/Users/z/other');
});

t('no repo name falls back to the chat cwd', () => {
  eq(codexCwdForBrief(null, { devDir: '/Users/z/dev', fallbackCwd: '/Users/z/here', exists: () => true }), '/Users/z/here');
});

// ---------------------------------------------------------------------------
// 5. Ids and paths
// ---------------------------------------------------------------------------

t('a codex run id parses like every other worker id', () => {
  // parseRunId feeds the completion notice and the report filename. If a codex
  // id did not parse, the notice would lose its lane and its elapsed time.
  const id = codexRunId(1788453512237);
  eq(id, 'codex-1788453512237');
  eq(parseRunId(id).lane, 'codex');
  eq(parseRunId(id).startedAt, 1788453512237);
});

t('a re-attached codex id (with the pid tail) still parses', () => {
  eq(parseRunId('codex-1788453512237-4242').lane, 'codex');
  eq(parseRunId('codex-1788453512237-4242').startedAt, 1788453512237);
});

t('paths are derived from the run id, so a restart can find them', () => {
  const p = codexPaths('/runs/', 1788453512237);
  eq(p.log, '/runs/codex-1788453512237.log');
  eq(p.last, '/runs/codex-1788453512237.last.md');
  eq(p.prompt, '/runs/codex-1788453512237.prompt.md');
  eq(p.meta, '/runs/codex-1788453512237.meta.json');
});

// ---------------------------------------------------------------------------
// /codex review
// ---------------------------------------------------------------------------

t('the bare form reviews the uncommitted diff where the chat is pointed', () => {
  const r = parseCodexReview('');
  eq(r.repo, null);
  eq(r.branch, null);
  eq(codexReviewScope(r.branch), 'uncommitted');
});

t('a repo name alone', () => {
  const r = parseCodexReview('  web-app  ');
  eq(r.repo, 'web-app');
  eq(r.branch, null);
});

t('repo vs branch', () => {
  const r = parseCodexReview('claude-telegram-bridge vs main');
  eq(r.repo, 'claude-telegram-bridge');
  eq(r.branch, 'main');
  eq(codexReviewScope('main'), 'base:main');
});

t('"vs <branch>" with no repo reviews the current cwd against that branch', () => {
  const r = parseCodexReview('vs dev');
  eq(r.repo, null);
  eq(r.branch, 'dev');
});

t('a slashed branch survives; a slashed REPO does not', () => {
  eq(parseCodexReview('delta-agents vs feature/voice-fix').branch, 'feature/voice-fix');
  ok(parseCodexReview('a/b').error, 'a repo name is one path segment, never a path');
});

t('★ a traversal can never become a directory we hand to a model', () => {
  for (const bad of ['../etc', '..', '.', '../../.ssh', '/etc/passwd', 'a/../../b']) {
    ok(parseCodexReview(bad).error, `"${bad}" must be refused`);
  }
});

t('★ a branch can never be read as a flag', () => {
  // The value goes into argv beside --base. A leading dash there would turn the
  // branch name into an option, which is how a review becomes something else.
  for (const bad of ['--sandbox', '-m', '--dangerously-bypass-approvals-and-sandbox']) {
    ok(parseCodexReview(`repo vs ${bad}`).error, `"${bad}" must be refused as a branch`);
  }
});

t('the errors name the usage and leak no path', () => {
  const e = parseCodexReview('../../.ssh').error;
  ok(e.includes('Usage: /codex review'), e);
  ok(!e.includes('/Users'), e);
  ok(parseCodexReview('repo vs').error.includes('needs a branch name'), 'a dangling vs is caught');
  ok(parseCodexReview('repo vs main extra').error.includes('Too many'), 'trailing junk is caught');
  ok(parseCodexReview('repo main').error.includes('Unexpected'), 'a missing vs is caught, not silently dropped');
});

t('the scope strings are exactly what buildCodexArgs consumes', () => {
  const uncommitted = buildCodexArgs({ mode: 'review', hasPrompt: false, reviewScope: codexReviewScope(null), lastFile: '/o/last.md' });
  has(uncommitted, 'exec', 'review');
  ok(uncommitted.includes('--uncommitted'), JSON.stringify(uncommitted));
  const based = buildCodexArgs({ mode: 'review', hasPrompt: false, reviewScope: codexReviewScope('main'), lastFile: '/o/last.md' });
  has(based, '--base', 'main');
  ok(!based.includes('--uncommitted'), 'the two scopes are mutually exclusive');
  ok(!based.includes('--color'), 'codex exec review rejects --color (measured, exit 2)');
  ok(!based.includes('-C'), 'codex exec review takes no -C; the caller sets cwd on the process');
  ok(!based.includes('-'), 'a review carries no prompt argument, so nothing is read from stdin');
});

t('a named repo resolves under the workspace root and nowhere else', () => {
  const fs = new Set(['/dev/web-app', '/dev/web-app/.git', '/chat', '/chat/.git']);
  const exists = (p) => fs.has(p);
  eq(resolveCodexReviewDir({ repo: 'web-app', devDir: '/dev', chatCwd: '/chat', exists }).dir, '/dev/web-app');
  eq(resolveCodexReviewDir({ repo: null, devDir: '/dev', chatCwd: '/chat', exists }).dir, '/chat', 'no repo named = the chat cwd');
});

t('an unknown repo gets one line, and that line leaks no path but the workspace root', () => {
  const r = resolveCodexReviewDir({ repo: 'nope', devDir: '/Users/x/dev', chatCwd: '/chat', exists: () => false, pretty: (p) => p.replace('/Users/x', '~') });
  ok(r.error.includes('No repo named "nope"'), r.error);
  ok(r.error.includes('~/dev'), r.error);
  ok(!r.error.includes('/Users/x'), 'the home path is shortened, not printed');
  eq(r.dir, undefined);
});

t('★ a directory that is not a git repo is refused here, not by a confusing Codex error', () => {
  const fs = new Set(['/dev/notarepo']); // exists, but no .git
  const r = resolveCodexReviewDir({ repo: 'notarepo', devDir: '/dev', chatCwd: '/chat', exists: (p) => fs.has(p) });
  ok(r.error.includes('is not a git repo'), r.error);
  eq(r.dir, undefined);
});

t('a chat cwd that has gone away says so rather than reviewing the wrong place', () => {
  const r = resolveCodexReviewDir({ repo: null, devDir: '/dev', chatCwd: '/gone', exists: () => false });
  ok(r.error.includes('/gone does not exist'), r.error);
  ok(resolveCodexReviewDir({ repo: null, devDir: '/dev', chatCwd: null, exists: () => true }).error, 'no cwd at all is an error, not a crash');
});

t('a review task line describes the run everywhere a brief would', () => {
  eq(codexReviewTask({ dir: '/Users/z/dev/web-app' }), 'codex review: web-app (uncommitted changes)');
  eq(codexReviewTask({ dir: '/Users/z/dev/web-app', branch: 'main' }), 'codex review: web-app against main');
  eq(codexReviewTask({}), 'codex review: the current directory (uncommitted changes)');
});

t('★ two runs in the same millisecond get different ids', () => {
  // Claude workers are disambiguated by LANE (bg, bg2, bg3). Every Codex run is
  // lane `codex`, so the timestamp IS the id, and drainBgHandoff dispatches a
  // queued batch in one synchronous loop: measured 2026-09-03, 27 of 40
  // back-to-back pairs shared a millisecond. Two runs sharing an id share their
  // log, their -o file and their report, and one job's answer is handed back
  // under the other job's task.
  const live = new Set(['codex-1788453512237']);
  eq(freeCodexStart(1788453512237, (id) => live.has(id)), 1788453512238);
  live.add('codex-1788453512238');
  eq(freeCodexStart(1788453512237, (id) => live.has(id)), 1788453512239, 'it must step past every taken id');
  eq(freeCodexStart(1788453512300, (id) => live.has(id)), 1788453512300, 'a free slot is left alone');
});

t('a stepped-forward id still parses as a run id', () => {
  eq(parseRunId(codexRunId(freeCodexStart(1788453512237, () => false))).lane, 'codex');
});

// ---------------------------------------------------------------------------
// 6. Reading the event stream
// ---------------------------------------------------------------------------

const OK_LOG = [
  '{"type":"thread.started","thread_id":"abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PROBE ONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":11083,"cached_input_tokens":0,"cache_write_input_tokens":11080,"output_tokens":7,"reasoning_output_tokens":0}}',
].join('\n');

t('usage comes off the last turn.completed', () => {
  const p = parseCodexEvents(OK_LOG);
  eq(p.tokens.input_tokens, 11083);
  eq(p.tokens.output_tokens, 7);
  eq(p.message, 'PROBE ONE');
});

t('a later turn.completed wins', () => {
  const p = parseCodexEvents(`${OK_LOG}\n{"type":"turn.completed","usage":{"input_tokens":20,"output_tokens":5}}`);
  eq(p.tokens.input_tokens, 20);
});

t('an all-zero usage block is NOT reported as a free run', () => {
  // The review flow emits exactly this (measured 2026-09-03).
  const p = parseCodexEvents('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}');
  eq(p.tokens, null);
});

t('a non-JSON line is stderr, not a parse crash', () => {
  const p = parseCodexEvents(`${OK_LOG}\nerror: something went wrong`);
  ok(p.stderr.includes('error: something went wrong'));
  eq(p.message, 'PROBE ONE', 'the good events still parsed');
});

t('a failure event is collected', () => {
  const p = parseCodexEvents('{"type":"turn.failed","error":{"message":"model overloaded"}}');
  ok(p.errors.join(' ').includes('model overloaded'));
});

// ---------------------------------------------------------------------------
// 7. The outcome contract (the same shape bgOutcome returns)
// ---------------------------------------------------------------------------

t('a clean run finishes with the answer from the -o file', () => {
  const o = codexOutcome({ lastText: 'PROBE ONE', logText: OK_LOG, code: 0 });
  eq(o.status, 'finished');
  eq(o.answer, 'PROBE ONE');
  eq(o.record, 'PROBE ONE');
  eq(o.tokens.output_tokens, 7);
});

t('an empty -o file falls back to the agent_message event', () => {
  const o = codexOutcome({ lastText: '', logText: OK_LOG, code: 0 });
  eq(o.answer, 'PROBE ONE');
});

t('a non-zero exit is a failure even with text', () => {
  const o = codexOutcome({ lastText: 'partial', logText: OK_LOG, code: 2 });
  eq(o.status, 'failed');
  ok(o.answer.startsWith('Codex FAILED:'), o.answer);
});

t('a CLI argument error surfaces the stderr, not silence', () => {
  const o = codexOutcome({ lastText: '', logText: "error: unexpected argument '--color' found", code: 2 });
  eq(o.status, 'failed');
  ok(o.answer.includes('--color'), o.answer);
});

t('a killed run says so and keeps any partial answer', () => {
  const o = codexOutcome({ lastText: 'half an answer', logText: OK_LOG, code: 143, killed: true });
  eq(o.status, 'failed');
  ok(o.answer.includes('killed on the bridge timeout'), o.answer);
  ok(o.answer.includes('half an answer'), 'the partial answer is not thrown away');
});

t('a /stop kill is reported as a stop, not as a timeout', () => {
  // Same signal to the process, completely different news to whoever reads it.
  const o = codexOutcome({ lastText: '', logText: '', code: 143, killed: true, killReason: 'a /stop from Telegram' });
  eq(o.status, 'failed');
  ok(o.answer.includes('killed on a /stop from Telegram'), o.answer);
  ok(o.record.includes('a /stop from Telegram'), o.record);
});

t('a silent success leaves no durable row', () => {
  const o = codexOutcome({ lastText: '', logText: '', code: 0 });
  eq(o.status, 'finished');
  eq(o.record, null, 'record null means "do not write a row", same as a silent Claude worker');
});

t('tokens survive a failure, because the money was still spent', () => {
  const o = codexOutcome({ lastText: '', logText: `${OK_LOG}\nerror: died late`, code: 1 });
  eq(o.status, 'failed');
  eq(o.tokens.input_tokens, 11083);
});

// ---------------------------------------------------------------------------
// 8. Wording: every surface must say CODEX
// ---------------------------------------------------------------------------

t('token formatting, or null when there is nothing to report', () => {
  eq(fmtCodexTokens({ input_tokens: 33983, output_tokens: 202 }), '33,983 in / 202 out tokens');
  eq(fmtCodexTokens({ input_tokens: 0, output_tokens: 0 }), null);
  eq(fmtCodexTokens(null), null);
});

t('the reset clock renders in the owner timezone', () => {
  // 2026-09-03T21:40:00Z is 17:40 in Miami.
  eq(fmtUntil(Date.parse('2026-09-03T21:40:00Z'), { timeZone: 'America/New_York' }), '17:40');
  eq(fmtUntil(0), null);
});

t('the reason text names the wall and the clock', () => {
  const s = codexReasonText('claude_limited', Date.parse('2026-09-03T21:40:00Z'), { timeZone: 'America/New_York' });
  ok(s.includes('every Claude account is limited until 17:40'), s);
  eq(codexReasonText(null, 0), null);
});

t('the start notice is recognisably not Claude and says it cannot be steered', () => {
  const s = codexStartNotice({ runId: 'codex-1788453512237', mode: 'ask', cwd: '/Users/z/dev/web-app', title: 'what does bg.mjs do' });
  ok(s.includes('codex'), s);
  ok(s.includes('web-app'), s);
  ok(s.includes('not steerable'), s);
  ok(s.includes('codex-1788453512237'), s);
});

t('the start notice explains a fallback run', () => {
  const s = codexStartNotice({
    runId: 'codex-1',
    reason: 'claude_limited',
    pausedUntil: Date.parse('2026-09-03T21:40:00Z'),
    timeZone: 'America/New_York',
  });
  ok(s.includes('because every Claude account is limited until 17:40'), s);
});

t('the handback header says CODEX, says DATA, and prices the run', () => {
  const h = codexHandbackHeader({ ownerName: 'Sam', status: 'finished', mode: 'ask', cwd: '/repo', tokens: { input_tokens: 100, output_tokens: 5 } });
  ok(/CODEX/.test(h), h);
  ok(/NOT Claude/.test(h), h);
  ok(/DATA for you to verify/.test(h), h);
  ok(h.includes('100 in / 5 out tokens'), h);
  ok(h.includes('no access to this conversation'), h);
});

t('an edit-mode handback warns that it already wrote to disk', () => {
  const h = codexHandbackHeader({ mode: 'edit', cwd: '/repo' });
  ok(/WRITE access/.test(h), h);
  ok(/read the diff/.test(h), h);
});

t('an ask-mode handback does not claim it wrote anything', () => {
  ok(!/WRITE access/.test(codexHandbackHeader({ mode: 'ask' })), 'ask mode is read-only');
});

t('the handback says why it was on Codex when it was a fallback', () => {
  const h = codexHandbackHeader({ reason: 'claude_limited', pausedUntil: Date.parse('2026-09-03T21:40:00Z'), timeZone: 'America/New_York' });
  ok(h.includes('every Claude account is limited until 17:40'), h);
});

t('the degraded chat answer is prefixed with the wall and the clock', () => {
  eq(
    codexFallbackPrefix(Date.parse('2026-09-03T21:40:00Z'), { timeZone: 'America/New_York' }),
    '🧠 Codex fallback · Claude back at 17:40',
  );
  ok(codexFallbackPrefix(0).includes('Codex fallback'), 'still prefixed with no known reset');
});

t('the parked note forbids a second answer', () => {
  // The double-answer failure mode: Codex answers now, the assistant answers
  // the same question again an hour later and it reads as a bug.
  const n = codexParkedNote({ ownerName: 'Sam', items: [{ prompt: 'is the deploy green', answer: 'yes, the cluster is healthy' }] });
  ok(/Do NOT answer them again/.test(n), n);
  ok(n.includes('is the deploy green'), n);
  ok(n.includes('yes, the cluster is healthy'), n);
  ok(/Context, not a task/.test(n), n);
});

t('a parked item whose codex run failed still renders', () => {
  const n = codexParkedNote({ items: [{ prompt: 'x' }] });
  ok(n.includes('the Codex run failed'), n);
});

t('★ both halves of a parked pair are clipped', () => {
  // A wall parks up to ten pairs, and a `--file` handoff is a whole brief while
  // a Codex answer is a whole report. Unclipped, the note is a several-hundred-
  // kilobyte prompt written into the chat lane the moment the wall lifts. Both
  // halves already reached the owner in full; this is context, not delivery.
  const n = codexParkedNote({
    items: [{ prompt: 'B'.repeat(20_000), answer: 'A'.repeat(50_000) }],
  });
  ok(n.length < 3000, `the note is ${n.length} chars, which is not a clip`);
  ok(n.includes('B'.repeat(PARKED_PROMPT_MAX)), 'the head of the brief must survive');
  ok(!n.includes('B'.repeat(PARKED_PROMPT_MAX + 1)), 'the brief was not clipped');
  ok(n.includes('A'.repeat(PARKED_ANSWER_MAX)), 'the head of the answer must survive');
  ok(!n.includes('A'.repeat(PARKED_ANSWER_MAX + 1)), 'the answer was not clipped');
  ok(/full text is in bg-results\.jsonl/.test(n), 'a clip must say where the rest is');
});

t('a short parked pair is untouched, and never says the owner "asked"', () => {
  // A background brief handed over from a terminal is not a question anyone
  // asked, and framing it as one invites an answer to something nobody said.
  const n = codexParkedNote({ ownerName: 'Sam', items: [{ prompt: 'run the suite', answer: '14 pass' }] });
  ok(n.includes('Sam sent: run the suite'), n);
  ok(!/asked:/.test(n), n);
  ok(!/clipped/.test(n), 'a short pair must not be decorated with a clip marker');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg-codex tests pass');
