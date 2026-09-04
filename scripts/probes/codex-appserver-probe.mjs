#!/usr/bin/env node
// LIVE PROOF for the Codex chat lane on `codex app-server`.
//
// The wiring suite proves the lane against a FAKE server, which is the right
// place for branch coverage and costs nothing. This proves the same code
// against the REAL `codex` binary and a real ChatGPT turn, which is the only
// thing that can tell us the protocol is what we think it is.
//
// It never touches the daemon: the functions are extracted from bridge.mjs by
// source (importing it would boot a second poller on the real bot token) and
// run against a recorded Telegram transport and a scratch state file, exactly
// the way scripts/probes/codex-chat-probe.mjs does it for the exec path.
//
//   node scripts/probes/codex-appserver-probe.mjs
//
// Four proofs, in order, each printed verbatim:
//   1. a cold turn, and the bubble it drew
//   2. a resumed turn that runs a shell command, and the STREAMED step lines
//   3. a mid-turn steer into a slow turn, and the answer reflecting it
//   4. /stop on a slow turn, and the app-server surviving it
//   5. the app-server child killed, and the SAME thread resumed into a new one

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'codex-appserver-probe-'));
const RUNS = path.join(TMP, 'runs');
mkdirSync(RUNS, { recursive: true });

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

const B = await import(
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
import { clip, oneLine, renderEntry, renderTail, quoteBlock, thinkingWord, fmtElapsed } from ${url('progress-render.mjs')};
const { existsSync, mkdirSync, writeFileSync, readFileSync } = fs;
export const SENT = [];
export const RESULTS = [];
export const PROGRESS = [];
export const RING = [];
export const FELLBACK = [];
export const STATE = { cwd: ${JSON.stringify(TMP)}, yolo: true };
const send = (t) => { SENT.push(t); return Promise.resolve(); };
const sendResult = (t) => { RESULTS.push(t); return Promise.resolve(); };
const recordChatTurn = (e) => { RING.push(e); };
const chatState = () => STATE;
const saveState = () => {};
export const LANES = { main: { name: 'main', current: null, queue: [], finishing: 0 } };
const drainQueue = () => {};
const CHAT_ID = '1';
const EDIT_INTERVAL_MS = 400;
const TYPING_INTERVAL_MS = 3000;
const IDLE_EDIT_MS = 400;
const PROGRESS_TAIL = 3400;
const TG_MSG_LIMIT = 4000;
const QUEUE_MAX = 5;
const STEER_RECORD_MAX = 400;
const WORD_HOLD_SEC = 12;
const THINKING_WORDS = ['Thinking', 'Digging', 'Cooking'];
const HOME = ${JSON.stringify(process.env.HOME || '')};
const OWNER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const escHtml = (s) => String(s);
let editCooldownUntil = 0;
let msgId = 0;
const tg = (method, payload) => { if (method === 'sendMessage') { PROGRESS.push('BUBBLE  ' + payload.text); return Promise.resolve({ message_id: ++msgId }); } return Promise.resolve({}); };
const editProgress = (id, html, plain) => { PROGRESS.push('EDIT    ' + plain()); return Promise.resolve(); };
export const codexRuns = new Map();
const noteCodexWall = () => Date.now() + 3600000;
const clearCodexWall = () => {};
export let codexPausedUntil = 0;
const RUNS_DIR = ${JSON.stringify(RUNS)};
const CODEX_BIN = 'codex';
const CODEX_AVAILABLE = true;
let CODEX_TIMEOUT_MS = 0;
let CODEX_APP_SERVER = true;
const CODEX_MODEL = null;
const DEFAULT_CWD = ${JSON.stringify(TMP)};
const conf = (key, fallback) => fallback;
const codexSettingsNow = () => ({ model: null, effort: null });
const codexChatBox = ({ network = null } = {}) =>
  codexChatSandbox({ yolo: STATE.yolo !== false, network: network === false ? false : STATE.codexNetwork !== false });
const runCodexChatExec = (rawText, opts) => { FELLBACK.push({ rawText, opts }); return null; };
const queueItem = (text, o = {}) => ({ text, forcedEngine: o.forcedEngine || null });
let codexAppServerClient = null;
let codexAppServerReady = null;
const codexAppServerDeaths = [];
let codexAppServerInitFailed = false;
let codexAppServerTurn = null;
const codexFallbackToldAbout = new Set();
export const clientPid = () => codexAppServerClient?.child?.pid ?? null;
export const clearAll = () => { SENT.length = 0; RESULTS.length = 0; PROGRESS.length = 0; RING.length = 0; };
`,
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
        'export { runCodexChat, runCodexChatTurn, killCodexAppServer };',
      ].join('\n'),
    )
);

const settled = (ms = 240000) =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      if (B.LANES.main.current === null && (B.RESULTS.length || B.SENT.length)) return resolve();
      if (Date.now() - at > ms) return reject(new Error('the turn never settled'));
      setTimeout(tick, 100);
    };
    tick();
  });
const waitFor = (fn, ms, what) =>
  new Promise((resolve, reject) => {
    const at = Date.now();
    const tick = () => {
      let v;
      try {
        v = fn();
      } catch {
        v = false;
      }
      if (v) return resolve(v);
      if (Date.now() - at > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
const dump = (label) => {
  console.log(`\n--- ${label} ---`);
  for (const p of B.PROGRESS) console.log('  ' + p.replace(/\n/g, '\n          '));
  for (const s of B.SENT) console.log('  SENT    ' + s);
  for (const r of B.RESULTS) console.log('  ANSWER  ' + JSON.stringify(r));
};
const cost = () => {
  const metas = readdirSync(RUNS).filter((f) => f.endsWith('.meta.json')).sort();
  const last = metas[metas.length - 1];
  return last ? readFileSync(path.join(RUNS, last), 'utf8') : '(no sidecar)';
};

console.log(`workspace: ${TMP}`);

// --------------------------------------------------------------------------
console.log('\n=== 1. a cold turn on the app-server chat lane ===');
// --------------------------------------------------------------------------
B.clearAll();
B.runCodexChat('Reply with exactly the word OK and nothing else. Do not use any tools.');
await settled();
dump('turn 1');
console.log('  thread stored :', B.STATE.codexThreadId ? 'yes' : 'NO');
console.log('  cost sidecar  :', cost());

// --------------------------------------------------------------------------
console.log('\n=== 2. a RESUMED turn that runs a shell command (the streamed steps) ===');
// --------------------------------------------------------------------------
const threadAfter1 = B.STATE.codexThreadId;
B.clearAll();
B.runCodexChat('Run this shell command: echo HELLO-FROM-STEP    Then reply with just the word it printed.');
await settled();
dump('turn 2');
console.log('  same thread   :', B.STATE.codexThreadId === threadAfter1);
console.log('  one server    : pid', B.clientPid());
console.log('  cost sidecar  :', cost());
console.log('  ring paths    :', JSON.stringify(B.RING.map((r) => r.paths || null)));

// --------------------------------------------------------------------------
console.log('\n=== 3. a MID-TURN STEER into a slow turn ===');
// --------------------------------------------------------------------------
B.clearAll();
B.runCodexChat('Run this shell command: for i in 1 2 3 4 5 6 7 8 9 10; do echo $i; sleep 1; done   Then tell me the last number you saw.');
const live = await waitFor(() => (B.LANES.main.current?.canSteer?.() ? B.LANES.main.current : null), 60000, 'a steerable turn');
const acked = live.steer('Change of plan: stop after 5 and reply with exactly the word STEERED');
console.log('  steer() returned:', acked, '(true is what makes dispatchPrompt send the Claude ack verbatim)');
await settled();
dump('turn 3');
console.log('  steers recorded :', JSON.stringify(live.steers));
console.log('  cost sidecar    :', cost());

// --------------------------------------------------------------------------
console.log('\n=== 4. /stop mid-turn is a turn/interrupt, and the server survives ===');
// --------------------------------------------------------------------------
B.clearAll();
const pidBeforeStop = B.clientPid();
B.runCodexChat('Run this shell command: sleep 25; echo done   Then say finished.');
const live2 = await waitFor(() => (B.LANES.main.current?.canSteer?.() ? B.LANES.main.current : null), 60000, 'a live turn');
live2.stopped = true;
live2.terminate();
await settled();
dump('turn 4');
console.log('  server pid before /stop:', pidBeforeStop, ' after:', B.clientPid(), ' same:', pidBeforeStop === B.clientPid());

// --------------------------------------------------------------------------
console.log('\n=== 5. the app-server child is killed; the SAME thread resumes in a new one ===');
// --------------------------------------------------------------------------
const threadBeforeKill = B.STATE.codexThreadId;
const pidBeforeKill = B.clientPid();
B.killCodexAppServer();
B.clearAll();
B.runCodexChat('What word did I ask you to reply with in my very first message? One word.');
await settled();
dump('turn 5');
console.log('  thread before kill:', threadBeforeKill === B.STATE.codexThreadId ? 'same thread resumed' : 'THREAD CHANGED');
console.log('  server pid before :', pidBeforeKill, ' after:', B.clientPid(), ' respawned:', pidBeforeKill !== B.clientPid());
console.log('  cost sidecar      :', cost());

console.log('\n=== every sidecar written by this probe (the /account and /usage tally) ===');
for (const f of readdirSync(RUNS).filter((x) => x.endsWith('.meta.json')).sort()) {
  console.log('  ' + f + '  ' + readFileSync(path.join(RUNS, f), 'utf8'));
}

B.killCodexAppServer();
rmSync(TMP, { recursive: true, force: true });
process.exit(0);
