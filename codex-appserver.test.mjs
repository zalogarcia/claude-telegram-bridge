#!/usr/bin/env node
// Unit tests for the Codex app-server protocol layer.
//
// Every notification asserted here is REAL: the shapes come from
// scripts/probes/fixtures/app-server-capture.json, captured off the live
// `codex app-server` on 2026-09-04 (codex-cli 0.153.0) and redacted. A mapper
// tested against invented JSON proves the mapper agrees with whoever invented
// the JSON, which is nobody.
//
//   node codex-appserver.test.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_SERVER_ARGS,
  APP_SERVER_DEATH_WINDOW_MS,
  EXEC_FALLBACK_NOTE,
  answerFromTurn,
  classifyAppServerError,
  codexItemEntry,
  createJsonLineReader,
  execFallbackLine,
  execItemEntry,
  lastActFromExecLog,
  frameMessage,
  initializeRequest,
  initializedNotification,
  mapNotification,
  pathsFromCodexItem,
  sandboxPolicyFor,
  shouldFallBackToExec,
  steerRefusalNote,
  threadResumeRequest,
  threadStartRequest,
  turnInput,
  turnInterruptRequest,
  turnStartRequest,
  turnSteerRequest,
  unwrapShellCommand,
} from './codex-appserver.mjs';
import { renderEntry } from './progress-render.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CAP = JSON.parse(readFileSync(path.join(DIR, 'scripts', 'probes', 'fixtures', 'app-server-capture.json'), 'utf8'));

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
const deep = (got, want, msg = '') => eq(JSON.stringify(got), JSON.stringify(want), msg);
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const throws = (fn, msg) => {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
};

// ---------------------------------------------------------------------------
console.log('\n1. framing');
// ---------------------------------------------------------------------------

t('a framed message is one line of JSON with a trailing newline', () => {
  eq(frameMessage({ a: 1 }), '{"a":1}\n');
});

t('the reader emits one object per complete line', () => {
  const seen = [];
  const r = createJsonLineReader((m) => seen.push(m));
  r.push('{"a":1}\n{"b":2}\n');
  deep(seen, [{ a: 1 }, { b: 2 }]);
});

t('★ a message split across two chunks is not lost', () => {
  // This is the whole reason the reader is stateful: stdout arrives in
  // arbitrary chunks and a JSON object routinely straddles two of them.
  const seen = [];
  const r = createJsonLineReader((m) => seen.push(m));
  r.push('{"metho');
  eq(seen.length, 0, 'a partial line was parsed');
  r.push('d":"turn/started"}\n');
  deep(seen, [{ method: 'turn/started' }]);
});

t('a plain log line on stdout goes to onOther and never throws', () => {
  const seen = [];
  const other = [];
  const r = createJsonLineReader((m) => seen.push(m), (s) => other.push(s));
  r.push('starting up...\n{"a":1}\n');
  deep(seen, [{ a: 1 }]);
  deep(other, ['starting up...']);
});

t('reset drops a half line so a dead child cannot prefix its successor', () => {
  const seen = [];
  const r = createJsonLineReader((m) => seen.push(m));
  r.push('{"half":');
  r.reset();
  r.push('{"whole":1}\n');
  deep(seen, [{ whole: 1 }]);
});

// ---------------------------------------------------------------------------
console.log('\n2. request builders');
// ---------------------------------------------------------------------------

t('the app-server is started with exactly one argument', () => {
  deep([...APP_SERVER_ARGS], ['app-server']);
});

t('initialize carries clientInfo and nothing else', () => {
  deep(initializeRequest(1), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'claude-telegram-bridge', version: '1.0.0' } },
  });
});

t('the initialized handshake is a notification, so it carries no id', () => {
  const n = initializedNotification();
  eq(n.method, 'initialized');
  eq('id' in n, false, 'a notification with an id waits forever for an answer');
});

t('thread/start pins approvalPolicy never, so no turn can ever block on a prompt', () => {
  const r = threadStartRequest(2, { cwd: '/tmp/x', sandbox: 'workspace-write' });
  eq(r.method, 'thread/start');
  eq(r.params.approvalPolicy, 'never');
  eq(r.params.cwd, '/tmp/x');
  eq(r.params.sandbox, 'workspace-write');
});

t('thread/resume pins the same policy, names the thread, and skips history hydration', () => {
  const r = threadResumeRequest(3, { threadId: 'th-1', cwd: '/tmp/x' });
  eq(r.method, 'thread/resume');
  eq(r.params.threadId, 'th-1');
  eq(r.params.approvalPolicy, 'never');
  // The server deprecation notice asks for this: we never read the turns back,
  // so hydrating them is a page of JSON per resume for nothing.
  eq(r.params.excludeTurns, true);
});

t('a resume with no thread id throws rather than resuming something arbitrary', () => {
  throws(() => threadResumeRequest(1, {}), 'a thread-less resume was built');
});

t('turn/start carries the text, the sandbox policy and the ids', () => {
  const r = turnStartRequest(4, { threadId: 'th-1', text: 'hello', sandbox: 'workspace-write', network: true, cwd: '/tmp/x' });
  eq(r.method, 'turn/start');
  eq(r.params.threadId, 'th-1');
  deep(r.params.input, [{ type: 'text', text: 'hello' }]);
  deep(r.params.sandboxPolicy, { type: 'workspaceWrite', networkAccess: true, writableRoots: [] });
  eq(r.params.cwd, '/tmp/x');
});

t('★ images ride the input array as localImage entries', () => {
  const r = turnStartRequest(5, { threadId: 'th-1', text: 'what colour', images: ['/tmp/a.png', '/tmp/b.png'] });
  deep(r.params.input, [
    { type: 'text', text: 'what colour' },
    { type: 'localImage', path: '/tmp/a.png' },
    { type: 'localImage', path: '/tmp/b.png' },
  ]);
});

t('a falsy image is dropped rather than sent as an empty path', () => {
  deep(turnInput('x', [null, '', '/tmp/a.png']), [
    { type: 'text', text: 'x' },
    { type: 'localImage', path: '/tmp/a.png' },
  ]);
});

t('★ /yolo off means read-only, and read-only never carries a network flag', () => {
  deep(sandboxPolicyFor({ sandbox: 'read-only', network: true }), { type: 'readOnly' });
});

t('★ danger-full-access is unreachable: there is no switch that can produce it', () => {
  // Any sandbox string other than read-only resolves to workspaceWrite. An
  // unsandboxed Codex turn must not be one typo away.
  eq(sandboxPolicyFor({ sandbox: 'danger-full-access' }).type, 'workspaceWrite');
  eq(sandboxPolicyFor({ sandbox: 'whatever' }).type, 'workspaceWrite');
});

t('workspace-write leaves writableRoots empty (cwd is already granted, measured)', () => {
  deep(sandboxPolicyFor({}).writableRoots, []);
});

t('turn/steer names the turn it expects, which is what stops a cross-turn splice', () => {
  const r = turnSteerRequest(6, { threadId: 'th-1', turnId: 'tu-1', text: 'stop after 5' });
  eq(r.method, 'turn/steer');
  eq(r.params.expectedTurnId, 'tu-1');
  deep(r.params.input, [{ type: 'text', text: 'stop after 5' }]);
});

t('a steer with no turn id throws instead of guessing', () => {
  throws(() => turnSteerRequest(1, { threadId: 'th-1', text: 'x' }), 'a turn-less steer was built');
});

t('turn/interrupt names both ids', () => {
  deep(turnInterruptRequest(7, { threadId: 'th-1', turnId: 'tu-1' }).params, { threadId: 'th-1', turnId: 'tu-1' });
});

t('★ no builder can ever emit a bypass flag', () => {
  const all = JSON.stringify([
    initializeRequest(1),
    threadStartRequest(2, { cwd: '/x' }),
    threadResumeRequest(3, { threadId: 't' }),
    turnStartRequest(4, { threadId: 't', text: 'x' }),
    turnSteerRequest(5, { threadId: 't', turnId: 'u', text: 'x' }),
    turnInterruptRequest(6, { threadId: 't', turnId: 'u' }),
  ]);
  ok(!/dangerously|approve-for-me|dangerFullAccess/.test(all), all);
});

// ---------------------------------------------------------------------------
console.log('\n3. notifications, against the captured shapes');
// ---------------------------------------------------------------------------

t('thread/started yields the thread id', () => {
  const r = mapNotification(CAP['thread/started']);
  eq(r.kind, 'threadStarted');
  ok(r.threadId, 'no thread id came out of the real notification');
});

t('turn/started yields the turn id, which is what makes steering possible', () => {
  const r = mapNotification(CAP['turn/started']);
  eq(r.kind, 'turnStarted');
  ok(r.turnId, 'no turn id');
});

t('turn/completed yields the status and the items', () => {
  const r = mapNotification(CAP['turn/completed']);
  eq(r.kind, 'turnCompleted');
  eq(r.status, 'completed');
  ok(Array.isArray(r.items), 'the final items are how the answer is read');
});

t('★ a commandExecution start is a Bash step line, with the zsh wrapper stripped', () => {
  const r = mapNotification(CAP['item/started:commandExecution']);
  eq(r.kind, 'entry');
  eq(r.entry.kind, 'tool');
  eq(r.entry.name, 'Bash');
  ok(!r.entry.arg.includes('/bin/zsh'), `the wrapper reached the phone: ${r.entry.arg}`);
  ok(r.entry.arg.includes('for i in'), r.entry.arg);
});

t('★ the entry renders through the SAME renderer the Claude bubble uses', () => {
  // One renderer, two mappers. If this ever needs its own render function, the
  // two bubbles have started to drift.
  const r = mapNotification(CAP['item/started:commandExecution']);
  const html = renderEntry(r.entry, true);
  const plain = renderEntry(r.entry, false);
  ok(html.includes('<b>Bash</b>'), html);
  ok(plain.includes('💻 Bash'), plain);
});

t('a completed agentMessage is the answer text, not a step', () => {
  const r = mapNotification(CAP['item/completed:agentMessage']);
  eq(r.kind, 'message');
  ok(typeof r.text === 'string' && r.text.length > 0, r.text);
});

t('a completed userMessage is our own prompt coming back, and draws no line', () => {
  const r = mapNotification(CAP['item/completed:userMessage']);
  eq(r.kind, 'itemDone');
  eq(r.entry, null, 'the prompt was echoed into the bubble');
});

t('★ a shell command that exits non-zero gets its own line', () => {
  const failed = JSON.parse(JSON.stringify(CAP['item/completed:commandExecution']));
  failed.params.item.exitCode = 2;
  const r = mapNotification(failed);
  eq(r.kind, 'itemDone');
  ok(r.entry && r.entry.text.startsWith('exit 2'), JSON.stringify(r.entry));
});

t('a shell command that exits 0 adds no line', () => {
  eq(mapNotification(CAP['item/completed:commandExecution']).entry, null);
});

t('★ token usage comes out named the way codex exec names it', () => {
  // finalizeCodexMeta, fmtCodexTokens and the /account tally all read
  // input_tokens / output_tokens. A second naming here would be a translation
  // layer that drifts.
  const r = mapNotification(CAP['thread/tokenUsage/updated']);
  eq(r.kind, 'usage');
  ok(Number.isFinite(r.tokens.input_tokens), JSON.stringify(r.tokens));
  ok(Number.isFinite(r.tokens.output_tokens), JSON.stringify(r.tokens));
  ok(r.tokens.input_tokens > 0, 'the real capture had a non-zero input count');
});

t('the usage read is the LAST turn, not the thread total', () => {
  const cap = CAP['thread/tokenUsage/updated'];
  eq(mapNotification(cap).tokens.input_tokens, cap.params.tokenUsage.last.inputTokens);
});

t('an agentMessage delta is an answer delta', () => {
  const r = mapNotification(CAP['item/agentMessage/delta']);
  eq(r.kind, 'answerDelta');
  ok(typeof r.delta === 'string', r.delta);
});

t('the chatty notifications map to nothing', () => {
  for (const key of ['mcpServer/startupStatus/updated', 'remoteControl/status/changed', 'thread/goal/cleared', 'deprecationNotice', 'account/rateLimits/updated', 'thread/status/changed']) {
    eq(mapNotification(CAP[key]), null, `${key} reached the bubble`);
  }
});

t('a response (no method) maps to nothing, and garbage does not throw', () => {
  eq(mapNotification(CAP['response:turn']), null);
  eq(mapNotification(null), null);
  eq(mapNotification('nonsense'), null);
  eq(mapNotification({}), null);
});

t('an error notification carries the message and the retry flag', () => {
  const r = mapNotification({ method: 'error', params: { threadId: 't', turnId: 'u', willRetry: true, error: { message: 'upstream is angry' } } });
  eq(r.kind, 'error');
  eq(r.message, 'upstream is angry');
  eq(r.willRetry, true);
});

// ---------------------------------------------------------------------------
console.log('\n4. item entries for the step lines');
// ---------------------------------------------------------------------------

t('a file change names the path, shortened for a phone', () => {
  const e = codexItemEntry({ type: 'fileChange', changes: [{ path: '/Users/o/dev/repo/src/deep/thing.ts' }] }, '/Users/o');
  eq(e.name, 'Edit');
  ok(e.arg.includes('thing.ts'), e.arg);
  ok(!e.arg.includes('/Users/o/dev/repo/src'), `the whole path ate the line: ${e.arg}`);
});

t('several file changes in one item say how many', () => {
  const e = codexItemEntry({ type: 'fileChange', changes: [{ path: '/a/b.ts' }, { path: '/a/c.ts' }, { path: '/a/d.ts' }] });
  ok(e.arg.includes('+2'), e.arg);
});

t('an MCP tool call names the tool', () => {
  const e = codexItemEntry({ type: 'mcpToolCall', tool: 'execute_sql', server: 'supabase' });
  eq(e.name, 'execute_sql');
  eq(e.arg, 'supabase');
});

t('a web search names the query', () => {
  eq(codexItemEntry({ type: 'webSearch', query: 'telegram bot api limits' }).name, 'WebSearch');
});

t('a reasoning summary becomes a thinking line, and an empty one becomes nothing', () => {
  eq(codexItemEntry({ type: 'reasoning', summary: ['Weighing the two paths'] }).kind, 'text');
  eq(codexItemEntry({ type: 'reasoning', summary: [] }), null);
});

t('an unknown item type draws no line rather than an empty one', () => {
  eq(codexItemEntry({ type: 'somethingNew' }), null);
  eq(codexItemEntry(null), null);
});

t('the shell wrapper is unwrapped, and a bare command is left alone', () => {
  eq(unwrapShellCommand(`/bin/zsh -lc 'ls -la'`), 'ls -la');
  eq(unwrapShellCommand(`/bin/bash -c "echo hi"`), 'echo hi');
  eq(unwrapShellCommand('ls -la'), 'ls -la');
  eq(unwrapShellCommand(null), '');
});

t('paths come out of the items that actually have them', () => {
  deep(pathsFromCodexItem({ type: 'fileChange', changes: [{ path: '/a/b.ts' }, { path: '/a/b.ts' }] }), ['/a/b.ts']);
  deep(pathsFromCodexItem({ type: 'imageView', path: '/tmp/x.png' }), ['/tmp/x.png']);
  deep(pathsFromCodexItem({ type: 'commandExecution', command: 'ls' }), []);
  deep(pathsFromCodexItem({ type: 'fileChange', changes: [{ path: 'relative.ts' }] }), [], 'a relative path is not a path we can name');
});

t('the answer is the LAST agent message in the turn, not the first', () => {
  eq(
    answerFromTurn({ items: [{ type: 'agentMessage', text: 'I will run it' }, { type: 'commandExecution' }, { type: 'agentMessage', text: 'STEERED' }] }),
    'STEERED',
  );
  eq(answerFromTurn({ items: [] }), '');
  eq(answerFromTurn(null), '');
});

t('the real captured turn/completed yields its answer', () => {
  ok(answerFromTurn(CAP['turn/completed'].params.turn).length > 0, 'no answer came out of the real payload');
});

// ---------------------------------------------------------------------------
console.log('\n4b. the same step lines out of a `codex exec` log (the background lane)');
// ---------------------------------------------------------------------------
// The fixture is a REAL exec stream, captured 2026-09-04 off a run that shelled
// out. A background Codex job has no progress bubble on purpose, so this is
// what /status reads to say what it is doing.

const EXEC_LOG = readFileSync(path.join(DIR, 'scripts', 'probes', 'fixtures', 'exec-stream-capture.jsonl'), 'utf8');

t('★ the exec stream\'s snake_case items map to the SAME entries as the app-server ones', () => {
  const e = execItemEntry({ type: 'command_execution', command: "/bin/zsh -lc 'npm ci'", status: 'completed', exit_code: 0 });
  eq(e.name, 'Bash');
  eq(e.arg, 'npm ci');
  eq(renderEntry(e, false), '💻 Bash npm ci');
});

t('a file change out of the exec stream names its path', () => {
  eq(execItemEntry({ type: 'file_change', changes: [{ path: '/a/b/c.ts' }] }).name, 'Edit');
});

t('an agent message is narration, not a step', () => {
  eq(execItemEntry({ type: 'agent_message', text: 'I will run it' }), null);
});

t('★ the last act comes out of the real captured log', () => {
  const e = lastActFromExecLog(EXEC_LOG);
  ok(e, 'nothing was found in a log that plainly contains a command');
  eq(e.name, 'Bash');
  eq(e.arg, 'echo STEPPROBE');
});

t('a log with no steps yields null rather than a blank line', () => {
  eq(lastActFromExecLog('{"type":"thread.started","thread_id":"x"}\n{"type":"turn.completed"}'), null);
  eq(lastActFromExecLog(''), null);
  eq(lastActFromExecLog(null), null);
});

t('a half-written last line does not stop the walk finding the step before it', () => {
  // A live log is being appended to while /status reads it, so the tail is
  // routinely a truncated JSON object.
  const e = lastActFromExecLog(EXEC_LOG + '{"type":"item.star');
  ok(e && e.name === 'Bash', JSON.stringify(e));
});

// ---------------------------------------------------------------------------
console.log('\n5. ★ errors, on the strings the server really sends');
// ---------------------------------------------------------------------------

t('★ "no active turn to steer" is its own class', () => {
  eq(classifyAppServerError(CAP['jsonrpc-error:no-active-turn-to-steer'].error), 'no_active_turn');
});

t('★ an expectedTurnId mismatch is its own class', () => {
  eq(classifyAppServerError(CAP['jsonrpc-error:expected-active-turn-id-a-but'].error), 'turn_mismatch');
});

t('★ a dead thread reads the same here as it does on the exec path', () => {
  eq(classifyAppServerError(CAP['jsonrpc-error:no-rollout-found-for-thread-id'].error), 'thread_gone');
});

t('activeTurnNotSteerable is recognised in the message and in the data', () => {
  eq(classifyAppServerError({ code: -32600, message: 'turn is not steerable' }), 'not_steerable');
  eq(
    classifyAppServerError({ code: -32600, message: 'refused', data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } } }),
    'not_steerable',
  );
});

t('auth and rate limits keep their own classes', () => {
  eq(classifyAppServerError({ message: 'unauthorized (401)' }), 'auth');
  eq(classifyAppServerError({ message: 'rate limit exceeded, try later' }), 'rate_limit');
  eq(classifyAppServerError({ message: 'something else entirely' }), 'other');
  eq(classifyAppServerError(''), 'other');
});

t('every class has a refusal note, and none of them is empty', () => {
  for (const c of ['not_steerable', 'no_active_turn', 'turn_mismatch', 'thread_gone', 'auth', 'rate_limit', 'other']) {
    ok(steerRefusalNote(c).length > 5, `${c} has no note`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n6. when to stop trying');
// ---------------------------------------------------------------------------

t('a healthy server does not fall back', () => {
  deep(shouldFallBackToExec({ deaths: [], now: 1000 }), { fallback: false, reason: null });
});

t('★ ONE death is a hiccup, not a broken install', () => {
  eq(shouldFallBackToExec({ deaths: [1000], now: 1500 }).fallback, false);
});

t('★ two deaths inside the window give up and hand the lane to codex exec', () => {
  const r = shouldFallBackToExec({ deaths: [1000, 2000], now: 2500 });
  eq(r.fallback, true);
  eq(r.reason, 'child_died_twice');
});

t('two deaths far apart do not count as two', () => {
  eq(shouldFallBackToExec({ deaths: [1000, 1000 + APP_SERVER_DEATH_WINDOW_MS + 1], now: 1000 + APP_SERVER_DEATH_WINDOW_MS + 2 }).fallback, false);
});

t('an initialize that failed is immediate and permanent: an old CLI will not learn', () => {
  eq(shouldFallBackToExec({ initFailed: true }).reason, 'init_failed');
});

t('config can switch the whole thing off', () => {
  eq(shouldFallBackToExec({ disabled: true }).reason, 'disabled');
});

t('every fallback reason renders a line that says steering is unavailable', () => {
  for (const r of ['init_failed', 'child_died_twice', 'disabled', null]) {
    const line = execFallbackLine(r);
    ok(line.includes(EXEC_FALLBACK_NOTE), line);
    ok(line.length < 220, `too long for a bubble: ${line}`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n7. ★ nothing here leaks a thread id or a credential into prose');
// ---------------------------------------------------------------------------

t('★ no rendered line built by this module contains a thread or turn id', () => {
  const entries = [
    mapNotification(CAP['item/started:commandExecution']).entry,
    codexItemEntry({ type: 'fileChange', changes: [{ path: '/a/b.ts' }] }),
    codexItemEntry({ type: 'mcpToolCall', tool: 'x', server: 'y' }),
  ];
  const rendered = entries.map((e) => renderEntry(e, false)).join('\n');
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(rendered), `a uuid reached a step line: ${rendered}`);
});

t('the fixture file itself carries no credential shape', () => {
  const raw = readFileSync(path.join(DIR, 'scripts', 'probes', 'fixtures', 'app-server-capture.json'), 'utf8');
  ok(!/eyJ[\w-]{6,}/.test(raw), 'a JWT is in the checked-in capture');
  ok(!/\bsk-[A-Za-z0-9_-]{8,}/.test(raw), 'an API key is in the checked-in capture');
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
