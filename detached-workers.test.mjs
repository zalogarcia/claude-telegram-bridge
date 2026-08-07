// Proves the ONE property that matters: a background worker survives the death
// of the daemon that spawned it.
//
// This is not a "does it parse" test. It builds a mock claude binary, spawns it
// through the SHIPPED detached-worker code extracted verbatim from
// bridge.mjs, kills the spawning process's entire process group with
// SIGKILL — the safe-restart / launchctl-kickstart scenario that killed a
// 5-piece video job on 2026-08-02 — and asserts the worker is still running,
// still writing, and still reports the same outcome afterwards.
//
// Two CONTROL cases run alongside it, so a green result can never be vacuous:
//   • a NON-detached worker must DIE on that same group kill
//   • a detached-but-PIPED worker must DIE too (its next write hits a broken
//     pipe). This is what proves the file-backed stdio is load-bearing and not
//     decoration on top of `detached: true`.
//
// Run: node detached-workers.test.mjs      (no API tokens — the mock is /bin/sh)

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// Read the bridge that actually RUNS. This used to point at bridge.detached.mjs,
// a 2618-line frozen copy that nothing else loaded — so the suite could stay
// green while the shipped daemon drifted away from it (it was already 33 lines
// behind, missing the whole rich-formatting rail). Path is resolved from this
// file so a clone works anywhere, not just on the author's machine.
const SRC_FILE = new URL('./bridge.mjs', import.meta.url).pathname;
const SRC = fs.readFileSync(SRC_FILE, 'utf8');
const DIR = '/tmp/detached-workers-test';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

let pass = 0,
  fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Load the shipped detached-worker core DIRECTLY.
//
// This used to slice the code out of bridge.mjs between two comment markers and
// re-assemble it into a temp module with hand-written imports. That was strictly
// worse than importing it: the harness supplied bindings the real code was
// missing (which is how a watchdog with no `fs` in scope stayed green for
// months), and any refactor of the surrounding file could silently change what
// "verbatim" meant. The core now lives in its own module, so the test imports
// exactly what the daemon imports.
// ---------------------------------------------------------------------------
const MODULE_PATH = new URL('./detached-workers.mjs', import.meta.url).pathname;
const MODULE_SRC = fs.readFileSync(MODULE_PATH, 'utf8');
const { spawnWorker, tailLines, bgOutcome, bgOutcomeFromLines } = await import(MODULE_PATH);
for (const needed of ['spawnWorker', 'tailLines', 'bgOutcome', 'bgOutcomeFromLines', 'detached: true']) {
  if (!MODULE_SRC.includes(needed)) throw new Error(`shipped module is missing ${needed}`);
}

// ---------------------------------------------------------------------------
// Regression guard for the bug this suite was written around: the watchdog code
// called `fs.readFileSync` inside a try/catch with NO `fs` import, so it
// silently no-op'd forever while watchdog.test.mjs passed 12/12 (that suite
// prepended its own import). Any file that uses `fs.` must import it. Checked on
// BOTH the module and the daemon, since either could regrow the bug.
// ---------------------------------------------------------------------------
// Comments are stripped first: prose ABOUT the bug (the history note in
// bridge.mjs is one) must not read as the bug. `//` preceded by `:` is left
// alone so a URL never truncates a line of real code.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
for (const [label, src] of [
  ['module', MODULE_SRC],
  ['bridge.mjs', SRC],
]) {
  const code = stripComments(src);
  const usesFsNamespace = /(^|[^.\w])fs\.\w/.test(code);
  const importsFsNamespace = /import\s+fs\s+from\s+['"]node:fs['"]/.test(code);
  ok(`${label} imports \`fs\` if it uses \`fs.\` (the silent-watchdog bug)`, !usesFsNamespace || importsFsNamespace);
}

// The module is shared verbatim with the public repo, so it must carry no
// absolute paths and no owner-specific identifiers. scripts/check-shared.sh
// enforces the byte-identity; this enforces the property that makes it possible.
ok('shared module hardcodes no home-directory path', !/\/Users\/|\/home\//.test(MODULE_SRC));
ok(
  'shared module reads no repo-level global (paths are injected)',
  !/\bSCRIPT_DIR\b/.test(MODULE_SRC) && !/\bINFLIGHT_FILE\b/.test(MODULE_SRC),
);

// ---------------------------------------------------------------------------
// The mock claude: emits stream-json lines, keeps writing for several seconds,
// then emits a final result line and exits 0. /bin/sh on purpose — a shell dies
// on SIGPIPE, which is exactly the pipe-death the control case must observe.
// ---------------------------------------------------------------------------
const MOCK = path.join(DIR, 'mock-claude.sh');
fs.writeFileSync(
  MOCK,
  `#!/bin/sh
i=0
while [ $i -lt 6 ]; do
  printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"step '"$i"'"}]}}'
  i=$((i+1))
  sleep 1
done
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"MOCK WORKER FINISHED","session_id":"mock-1"}'
exit 0
`,
);
fs.chmodSync(MOCK, 0o755);

// A parent process that spawns one worker the given way, writes the worker pid
// to a file, then sits still until it is killed. Spawned `detached` itself so it
// leads its own process group and the test can kill that whole group — the real
// shape of `launchctl kickstart -k` / safe-restart hitting the daemon.
const PARENT = path.join(DIR, 'parent.mjs');
fs.writeFileSync(
  PARENT,
  `import fs from 'node:fs';
import { spawnWorker } from ${JSON.stringify(MODULE_PATH)};
const [mode, mock, logPath, pidFile] = process.argv.slice(2);
// mode: 'detached-file' = the shipped bg path | 'piped' = chat-lane shape |
//       'detached-pipe' = detached but stdout still a pipe (the control that
//       proves the file, not the detaching, is what survives)
let child;
if (mode === 'detached-file') {
  ({ child } = spawnWorker(mock, [], { cwd: process.cwd(), env: process.env, logPath }));
} else if (mode === 'piped') {
  ({ child } = spawnWorker(mock, [], { cwd: process.cwd(), env: process.env, logPath: null }));
  child.stdout.on('data', () => {});
} else {
  const { spawn } = await import('node:child_process');
  child = spawn(mock, [], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  child.unref();
  child.stdout.on('data', () => {});
}
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000); // stay alive until killed
`,
);

async function launchParent(mode, tag) {
  const logPath = path.join(DIR, 'runs', `${tag}.jsonl`);
  const pidFile = path.join(DIR, `${tag}.pid`);
  const parent = spawn(process.execPath, [PARENT, mode, MOCK, logPath, pidFile], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true, // parent leads its own group, so we can kill the GROUP
  });
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
  if (!fs.existsSync(pidFile)) throw new Error(`${tag}: parent never reported a worker pid`);
  return { parent, workerPid: Number(fs.readFileSync(pidFile, 'utf8')), logPath };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const pgidOf = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch {
    return null;
  }
};

// ===========================================================================
console.log('\n1. stdio wiring — background lane vs chat lane');
// ===========================================================================
{
  const logPath = path.join(DIR, 'runs', 'wiring-bg.jsonl');
  const { child, logPath: returned } = spawnWorker(MOCK, [], { cwd: DIR, env: process.env, logPath });
  ok('bg: returns the log path', returned === logPath);
  ok('bg: log file created at spawn', fs.existsSync(logPath));
  ok('bg: stdout is NOT a pipe (file-backed)', child.stdout === null, `got ${child.stdout}`);
  ok('bg: stderr is NOT a pipe (file-backed)', child.stderr === null);
  ok('bg: stdin is still a writable pipe (the prompt goes in)', Boolean(child.stdin?.writable));
  ok('bg: worker leads its OWN process group', pgidOf(child.pid) === child.pid, `pgid=${pgidOf(child.pid)} pid=${child.pid}`);
  child.kill('SIGKILL');

  // Chat lane must be untouched by all of this.
  const { child: chat, logPath: chatLog } = spawnWorker(MOCK, [], { cwd: DIR, env: process.env, logPath: null });
  ok('chat: no log path', chatLog === null);
  ok('chat: stdout IS a pipe', Boolean(chat.stdout) && typeof chat.stdout.on === 'function');
  ok('chat: stderr IS a pipe', Boolean(chat.stderr) && typeof chat.stderr.on === 'function');
  chat.stdout.on('data', () => {});
  chat.stdin.write('{"type":"user"}\n');
  ok('chat: stdin stays OPEN after writing (steering still possible)', chat.stdin.writable === true);
  ok('chat: stays in the daemon process group', pgidOf(chat.pid) === pgidOf(process.pid));
  chat.kill('SIGKILL');
}

// ===========================================================================
console.log('\n2. THE POINT — worker survives its parent being SIGKILLed');
// ===========================================================================
const survivor = await launchParent('detached-file', 'survivor');
const controlPiped = await launchParent('piped', 'control-piped');
const controlDetachedPipe = await launchParent('detached-pipe', 'control-detached-pipe');

await sleep(1200); // let all three write at least one line
const sizeBeforeKill = fs.statSync(survivor.logPath).size;
ok('worker is writing before the kill', sizeBeforeKill > 0);

// Kill the ENTIRE parent process group with SIGKILL — no cleanup, no handlers.
// This is what a daemon dying actually looks like.
for (const { parent } of [survivor, controlPiped, controlDetachedPipe]) {
  try {
    process.kill(-parent.pid, 'SIGKILL');
  } catch (e) {
    console.log('  (group kill note)', e.message);
  }
}
await sleep(400);
ok('parent really is dead', !alive(survivor.parent.pid));

ok('★ DETACHED WORKER IS STILL ALIVE AFTER ITS PARENT DIED', alive(survivor.workerPid), `pid ${survivor.workerPid}`);

await sleep(2000); // give the controls a write cycle to hit their dead pipes
ok('control: NON-detached worker died with the group (test can detect failure)', !alive(controlPiped.workerPid));
ok(
  'control: detached-but-PIPED worker died too (file stdio is load-bearing)',
  !alive(controlDetachedPipe.workerPid),
  `pid ${controlDetachedPipe.workerPid} still alive`,
);

// ===========================================================================
console.log('\n3. the orphaned worker keeps working and finishes its log');
// ===========================================================================
const sizeAfterKill = fs.statSync(survivor.logPath).size;
ok('log kept GROWING after the parent died', sizeAfterKill > sizeBeforeKill, `${sizeBeforeKill} -> ${sizeAfterKill}`);

for (let i = 0; i < 120 && alive(survivor.workerPid); i++) await sleep(250);
ok('orphaned worker exited on its own', !alive(survivor.workerPid));

const logLines = fs.readFileSync(survivor.logPath, 'utf8').split('\n').filter(Boolean);
const resultLine = logLines.find((l) => l.includes('"type":"result"'));
ok('final result line landed in the log', Boolean(resultLine));
ok('log holds the whole run, not just the tail', logLines.length >= 7, `${logLines.length} lines`);

// ===========================================================================
console.log('\n4. re-attach derives the SAME outcome the close handler would');
// ===========================================================================
{
  // What the close handler would have produced, had the daemon lived: it
  // accumulates resultTexts/resultEvent off the same lines and exits 0.
  const ev = JSON.parse(resultLine);
  const fromCloseHandler = bgOutcome([ev.result], ev, 0, '');
  const fromReattach = bgOutcomeFromLines(logLines);
  ok(
    '★ re-attach outcome === close-handler outcome',
    JSON.stringify(fromReattach) === JSON.stringify(fromCloseHandler),
    `${JSON.stringify(fromReattach)} vs ${JSON.stringify(fromCloseHandler)}`,
  );
  ok('outcome carries the worker answer', fromReattach.answer === 'MOCK WORKER FINISHED');
  ok('outcome status is finished', fromReattach.status === 'finished');
  ok('outcome is recorded to bg-results', fromReattach.record === 'MOCK WORKER FINISHED');
}

// ===========================================================================
console.log('\n5. outcome derivation edge cases');
// ===========================================================================
{
  const errEv = { type: 'result', is_error: true, subtype: 'error_max_turns' };
  ok('is_error result → failed', bgOutcome([], errEv, 0, '').status === 'failed');
  ok('stderr wins over subtype as the detail', bgOutcome([], errEv, 0, ' boom \n').answer.includes('boom'));
  ok('nonzero exit with nothing → failed with exit code', bgOutcome([], null, 3, '').answer.includes('exit code 3'));
  const silent = bgOutcome([], null, 0, '');
  ok('silent clean exit → "ended with no output"', silent.answer === 'The worker ended with no output.');
  ok('silent clean exit writes NO bg-results row (unchanged behaviour)', silent.record === null);
  ok('two turns are joined, both preserved', bgOutcome(['a', 'b'], null, 0, '').answer === 'a\n\nb');

  // Re-attach has no exit code and must infer one.
  ok(
    'inferred: stderr with no result → failed',
    bgOutcomeFromLines(['zsh: command not found: claude']).status === 'failed',
  );
  ok(
    'inferred: clean result event → finished',
    bgOutcomeFromLines(['{"type":"result","is_error":false,"result":"hi"}']).answer === 'hi',
  );
  ok(
    'inferred: errored result event → failed',
    bgOutcomeFromLines(['{"type":"result","is_error":true,"subtype":"x"}']).status === 'failed',
  );
  ok('non-JSON garbage never throws', bgOutcomeFromLines(['{{{', 'not json', '']).status === 'failed');
}

// ===========================================================================
console.log('\n6. tailLines — the pipe replacement');
// ===========================================================================
{
  const p = path.join(DIR, 'tail.jsonl');
  fs.writeFileSync(p, '');
  const seen = [];
  const t = tailLines(p, (l) => seen.push(l), { intervalMs: 50 });

  fs.appendFileSync(p, '{"a":1}\n{"b":2}\n');
  await sleep(200);
  ok('emits complete lines from the offset', seen.length === 2 && seen[1] === '{"b":2}');

  fs.appendFileSync(p, '{"c":3}'); // no newline yet — a half-written event
  await sleep(200);
  ok('a partial trailing line is NOT emitted', seen.length === 2, `saw ${seen.length}`);

  fs.appendFileSync(p, '\n{"d":4}\n');
  await sleep(200);
  ok('the partial line completes and both arrive', seen.length === 4 && seen[2] === '{"c":3}');

  const before = seen.length;
  fs.appendFileSync(p, '{"e":5}\n');
  t.stop(); // stop() must pump first — this is what saves the result event
  ok('stop() flushes the final write before clearing the timer', seen.length === before + 1);

  ok('offset advanced to the file size', t.offset() === fs.statSync(p).size);

  // A multi-byte char split across a read boundary must not corrupt.
  const p2 = path.join(DIR, 'tail-utf8.jsonl');
  fs.writeFileSync(p2, '');
  const seen2 = [];
  const t2 = tailLines(p2, (l) => seen2.push(l), { intervalMs: 30 });
  const buf = Buffer.from('{"t":"héllo ✅"}\n', 'utf8');
  fs.appendFileSync(p2, buf.subarray(0, 12));
  await sleep(120);
  fs.appendFileSync(p2, buf.subarray(12));
  await sleep(120);
  t2.stop();
  ok('utf-8 split across reads is reassembled', seen2.length === 1 && JSON.parse(seen2[0]).t === 'héllo ✅', seen2[0]);

  // A log that does not exist yet must be tolerated, not thrown on.
  const t3 = tailLines(path.join(DIR, 'nope.jsonl'), () => {}, { intervalMs: 30 });
  await sleep(100);
  t3.stop();
  ok('missing log file is tolerated', true);
}

// ===========================================================================
console.log('\n7. the daemon does not hold the log fd open');
// ===========================================================================
{
  const logPath = path.join(DIR, 'runs', 'fdcheck.jsonl');
  const { child } = spawnWorker(MOCK, [], { cwd: DIR, env: process.env, logPath });
  let held = 0;
  try {
    held = execFileSync('/bin/sh', ['-c', `lsof -p ${process.pid} 2>/dev/null | grep -c fdcheck.jsonl || true`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    held = '0';
  }
  ok('daemon closed its copy of the log fd after spawn', Number(held) === 0, `lsof count ${held}`);
  child.kill('SIGKILL');
}

// ===========================================================================
console.log('\n8. shipped wiring — the parts that are ordering, not logic');
// ===========================================================================
// These four are load-bearing and invisible to a unit test: each one, if
// reverted, re-couples a worker's life to the daemon's while every test above
// still passes. Assert them against the source directly.
{
  const mainBody = SRC.slice(SRC.indexOf('async function main()'));
  const iReattach = mainBody.indexOf('reattachLiveWorkers()');
  const iReap = mainBody.indexOf('reapDeadWorkers(');
  ok('main() calls reattachLiveWorkers()', iReattach > -1);
  ok('★ re-attach runs BEFORE reap (a live worker is never announced dead)', iReattach > -1 && iReattach < iReap);

  ok('bg spawn goes through spawnWorker with a logPath', /spawnWorker\(CLAUDE_BIN, args, \{.*\blogPath \}\)/.test(SRC));
  ok('the raw spawn() of CLAUDE_BIN is gone from runClaude', !/spawn\(CLAUDE_BIN,/.test(SRC));
  ok('inflight record carries the log path for re-attach', /inflight\.add\([\s\S]{0,400}?log: logPath,/.test(SRC));
  ok('bg stdin is closed at spawn (no live parent needed)', /if \(isBgLane\) child\.stdin\.end\(\);/.test(SRC));

  const sigterm = SRC.slice(SRC.indexOf("process.on('SIGTERM'"));
  ok('★ SIGTERM no longer kills every lane', !/for \(const l of allLanes\(\)\) l\.current\?\.child\?\.kill/.test(sigterm));
  ok('SIGTERM still stops the chat lane', /LANES\.main\.current\?\.child\?\.kill\('SIGTERM'\)/.test(sigterm));

  ok('chat lane still reads its stdout pipe via readline', /readline\.createInterface\(\{ input: child\.stdout \}\)/.test(SRC));
  ok('bg lane tails the log with the same handler', /tailLines\(logPath, onLine, \{ intervalMs: BG_TAIL_MS \}\)/.test(SRC));

  const closeBody = SRC.slice(SRC.indexOf("child.on('close'"));
  const iFlush = closeBody.indexOf('tail?.stop()');
  const iReport = closeBody.indexOf('reportBgOutcome(');
  ok('★ close handler flushes the tail BEFORE reading the outcome', iFlush > -1 && iFlush < iReport);
  ok('close handler reports through the shared outcome path', iReport > -1);

  // Lives in the shared module now, so assert it there.
  ok('reaper skips ids a re-attach poll already owns', /reattachedIds\.has\(id\)/.test(MODULE_SRC));

  // The daemon must wire the module up, not just import it: a registry pointed at
  // its own directory, and the reaper's alert delegated back to the host.
  ok('daemon builds the registry from its own INFLIGHT_FILE', /createInflightRegistry\(\{ file: INFLIGHT_FILE \}\)/.test(SRC));
  ok('daemon injects the runs dir and the dead-worker alert', /createWorkerWatchdog\(\{[\s\S]{0,400}?runsDir: RUNS_DIR,[\s\S]{0,400}?onDeadWorkers,/.test(SRC));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
