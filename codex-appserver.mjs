// ---------------------------------------------------------------------------
// THE CODEX CHAT LANE, ON `codex app-server`
//
// `codex exec` is one-shot by design: a prompt goes in on stdin, stdin closes,
// and nothing can reach the run again until it exits. That single fact is why
// the Codex chat lane felt like a different product from the Claude one. A
// message typed mid-turn had nowhere to go but the queue, so it arrived AFTER
// the answer it was meant to change; the bubble could show a clock and nothing
// else, because a file-backed run streams no steps we were listening to; and
// /stop could only kill the process.
//
// `codex app-server` is the same binary speaking JSON-RPC over stdio, and it
// has all three: `turn/steer` puts a message into a RUNNING turn, the
// item/started and item/completed notifications are the tool steps, and
// `turn/interrupt` is a stop that the model acknowledges instead of a SIGTERM.
//
// So the CHAT lane moves here. The BACKGROUND lane stays on `codex exec`: a
// background job is one-shot by nature, its log is its transcript, and it must
// outlive this daemon, which a child on our stdio pipes cannot.
//
// ---------------------------------------------------------------------------
// MEASURED, 2026-09-04, codex-cli 0.153.0, against the real binary. Every claim
// below is a captured request/response pair in
// scripts/probes/fixtures/app-server-capture.json.
//
//   initialize -> { userAgent, codexHome, platformFamily, platformOs }
//     then a bare `initialized` notification, no id, no response.
//
//   thread/start { cwd, sandbox, approvalPolicy } -> { thread: { id, ... } }
//   thread/resume { threadId, cwd, sandbox, approvalPolicy, excludeTurns }
//     RESUMES A THREAD CREATED BY `codex exec`. The ids are the same rollout
//     ids, so every codexThreadId already in state.json keeps working across
//     this change: no migration, no lost conversation. Proven by resuming an
//     exec thread that had been told a word and asking for the word back.
//     It also resumes after the app-server child dies, which is what makes a
//     daemon restart survivable.
//
//   turn/start { threadId, input, sandboxPolicy, model, effort, cwd }
//     RETURNS IMMEDIATELY with { turn: { id, status: 'inProgress' } }. It does
//     not block until the turn finishes. The turn id is therefore in hand
//     before the first token, which is what makes steering possible at all.
//
//   turn/steer { threadId, expectedTurnId, input } -> { turnId }
//     Accepted mid-turn while a shell command was running. The command ran to
//     completion, then the steered message arrived in the SAME turn as another
//     userMessage item and the model answered it. Identical in shape to what
//     the Claude lane gets from a stdin splice at a tool-step boundary.
//
//   turn/interrupt { threadId, turnId } -> {} and turn/completed status
//     'interrupted'.
//
//   sandboxPolicy is PER TURN and it is honoured: a workspaceWrite turn wrote a
//     file in cwd; the next turn on the SAME thread with { type: 'readOnly' }
//     was denied. approvalPolicy 'never' means no approval request is ever
//     raised: the read-only write was refused outright, and the turn finished.
//
//   Images ride the same input array as { type: 'localImage', path }.
//
// ERROR SHAPES, all JSON-RPC errors with code -32600 (measured verbatim):
//   "no active turn to steer"
//   "expected active turn id `X` but found `Y`"
//   "no rollout found for thread id X"   <- the same wording `codex exec`
//                                           prints, so classifyCodexFailure
//                                           already reads it as thread_gone.
//
// ---------------------------------------------------------------------------
// WHAT IS PURE HERE AND WHY
//
// Everything except the spawn. The framing, the request builders, the
// notification-to-bubble mapping and the error classification are functions of
// their arguments, so the exact bytes on the wire and the exact line the owner reads
// are asserted in a unit test against the captured fixtures rather than
// eyeballed in Telegram. bridge.mjs owns the child, the timers and the sockets,
// which is the same split every other module in this repo uses.
// ---------------------------------------------------------------------------

import { clip, oneLine, prettyPath } from './progress-render.mjs';

export const APP_SERVER_ARGS = Object.freeze(['app-server']);
export const APP_SERVER_CLIENT = Object.freeze({ name: 'claude-telegram-bridge', version: '1.0.0' });
// initialize answered in 124 to 351 ms across every probe. Five seconds is the
// same number codex-account.mjs waits for a rate-limit read: generous enough
// that a cold binary is not called dead, short enough that a hung one falls
// back to `codex exec` while the owner is still looking at the screen.
export const APP_SERVER_INIT_TIMEOUT_MS = 5_000;
// Two deaths inside this window mean the app-server is not usable on this
// machine (a bad build, a broken config, a sandbox the OS refuses), and the
// chat lane stops trying and runs on `codex exec` instead.
export const APP_SERVER_DEATH_WINDOW_MS = 60_000;
export const APP_SERVER_MAX_DEATHS = 2;

// ---------------------------------------------------------------------------
// FRAMING. Newline-delimited JSON, one object per line, both directions.
//
// This is the ONE framing in the repo: codex-account.mjs imports it rather than
// keeping the copy it used to have inline, so a protocol that ever grows a
// Content-Length header changes in one place instead of two.
// ---------------------------------------------------------------------------

export const frameMessage = (msg) => JSON.stringify(msg) + '\n';

/**
 * A stateful line reader over a chunked stdio stream.
 *
 * `push` takes whatever arrived and calls `onMessage` once per COMPLETE line
 * that parses as JSON. A partial tail stays in the buffer until its newline
 * turns up, and a line that is not JSON is handed to `onOther` (the app-server
 * prints the occasional plain log line on stdout, and a protocol reader that
 * threw on one would take the daemon down with it).
 */
export function createJsonLineReader(onMessage, onOther = () => {}) {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          onOther(s);
          continue;
        }
        onMessage(msg);
      }
    },
    // Only for tests and for a child that is being replaced: a half line from a
    // dead process must not prefix the first line of its successor.
    reset() {
      buf = '';
    },
    pending: () => buf,
  };
}

// ---------------------------------------------------------------------------
// REQUEST BUILDERS. Pure: (id, options) in, the exact object that goes on the
// wire out. Nothing here spawns, waits or reads a global.
// ---------------------------------------------------------------------------

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

export const initializeRequest = (id, { client = APP_SERVER_CLIENT } = {}) =>
  rpc(id, 'initialize', { clientInfo: { name: client.name, version: client.version } });

// A notification, so it carries no id and expects no answer.
export const initializedNotification = () => ({ jsonrpc: '2.0', method: 'initialized', params: {} });

/**
 * The sandbox for ONE turn.
 *
 * `dangerFullAccess` is deliberately unreachable: the two settings this bridge
 * offers are /yolo on (workspace-write, rooted at the chat cwd) and /yolo off
 * (read-only), exactly as they are on the `codex exec` path, and there is no
 * switch anywhere that should be able to produce an unsandboxed Codex turn.
 */
export function sandboxPolicyFor({ sandbox = 'workspace-write', network = false } = {}) {
  if (sandbox === 'read-only') return { type: 'readOnly' };
  // writableRoots is left empty on purpose: workspace-write already grants the
  // thread's own cwd (measured, a file was written there with an empty list),
  // and every extra root is write access the owner did not ask for.
  return { type: 'workspaceWrite', networkAccess: Boolean(network), writableRoots: [] };
}

export function threadStartRequest(id, { cwd = null, sandbox = 'workspace-write', model = null, effort = null } = {}) {
  const params = { approvalPolicy: 'never' };
  if (cwd) params.cwd = cwd;
  if (sandbox) params.sandbox = sandbox;
  if (model) params.model = model;
  if (effort) params.effort = effort;
  return rpc(id, 'thread/start', params);
}

export function threadResumeRequest(id, { threadId, cwd = null, sandbox = 'workspace-write', model = null } = {}) {
  if (!threadId) throw new Error('threadResumeRequest: a thread id is required');
  const params = { threadId: String(threadId), approvalPolicy: 'never', excludeTurns: true };
  if (cwd) params.cwd = cwd;
  if (sandbox) params.sandbox = sandbox;
  if (model) params.model = model;
  return rpc(id, 'thread/resume', params);
}

/** The input array for a turn: the text, then one entry per image. */
export function turnInput(text, images = []) {
  const input = [{ type: 'text', text: String(text ?? '') }];
  for (const img of images || []) {
    if (img) input.push({ type: 'localImage', path: String(img) });
  }
  return input;
}

export function turnStartRequest(
  id,
  { threadId, text, images = [], model = null, effort = null, sandbox = 'workspace-write', network = false, cwd = null } = {},
) {
  if (!threadId) throw new Error('turnStartRequest: a thread id is required');
  const params = {
    threadId: String(threadId),
    input: turnInput(text, images),
    sandboxPolicy: sandboxPolicyFor({ sandbox, network }),
  };
  if (cwd) params.cwd = cwd;
  if (model) params.model = model;
  if (effort) params.effort = effort;
  return rpc(id, 'turn/start', params);
}

/**
 * A message into a RUNNING turn.
 *
 * `expectedTurnId` is a precondition, not a hint: the server refuses the steer
 * when the turn it names is not the active one, which is what stops a message
 * meant for one turn from landing in the next.
 */
export function turnSteerRequest(id, { threadId, turnId, text } = {}) {
  if (!threadId || !turnId) throw new Error('turnSteerRequest: thread and turn ids are required');
  return rpc(id, 'turn/steer', {
    threadId: String(threadId),
    expectedTurnId: String(turnId),
    input: turnInput(text),
  });
}

export function turnInterruptRequest(id, { threadId, turnId } = {}) {
  if (!threadId || !turnId) throw new Error('turnInterruptRequest: thread and turn ids are required');
  return rpc(id, 'turn/interrupt', { threadId: String(threadId), turnId: String(turnId) });
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS -> THE PROGRESS BUBBLE
//
// The entries produced here are the SAME shape progress-render.mjs already
// renders for a Claude run ({ kind: 'tool', emoji, name, arg } and
// { kind: 'text', text }), so both engines go through one renderer and the two
// bubbles cannot drift apart. What differs per engine is the MAPPING from that
// engine's event stream, which is why this lives beside the protocol and not
// inside the renderer.
// ---------------------------------------------------------------------------

// Codex reports every shell call as one commandExecution item whose `command`
// is the full `/bin/zsh -lc '...'` wrapper. The wrapper is scaffolding; the
// script inside it is what the owner is reading on a phone.
export function unwrapShellCommand(command) {
  const s = String(command ?? '');
  const m = /^\s*\S*\/?(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(s);
  return oneLine(m ? m[2] : s);
}

/** One thread item, as a progress-bubble entry, or null when it is not worth a line. */
export function codexItemEntry(item, home = '') {
  if (!item || typeof item !== 'object') return null;
  switch (item.type) {
    case 'commandExecution':
      return { kind: 'tool', sub: false, emoji: '💻', name: 'Bash', arg: clip(unwrapShellCommand(item.command), 70) };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => c?.path || c?.file || '').filter(Boolean);
      const first = paths[0] ? prettyPath(paths[0], home) : '';
      const more = paths.length > 1 ? ` +${paths.length - 1}` : '';
      return { kind: 'tool', sub: false, emoji: '✏️', name: 'Edit', arg: clip(`${first}${more}`, 70) };
    }
    case 'mcpToolCall':
      return {
        kind: 'tool',
        sub: false,
        emoji: '🔧',
        name: item.tool || 'tool',
        arg: clip(oneLine(item.server || ''), 70),
      };
    case 'dynamicToolCall':
      return { kind: 'tool', sub: false, emoji: '🔧', name: item.tool || 'tool', arg: '' };
    case 'webSearch':
      return { kind: 'tool', sub: false, emoji: '🌐', name: 'WebSearch', arg: clip(oneLine(item.query || ''), 70) };
    case 'imageView':
      return { kind: 'tool', sub: false, emoji: '📖', name: 'Read', arg: clip(prettyPath(item.path || '', home), 70) };
    case 'imageGeneration':
      return { kind: 'tool', sub: false, emoji: '🖼️', name: 'Image', arg: clip(prettyPath(item.savedPath || '', home), 70) };
    case 'subAgentActivity':
      return { kind: 'tool', sub: true, emoji: '🤖', name: 'agent', arg: clip(oneLine(item.kind || ''), 70) };
    case 'plan':
      return { kind: 'tool', sub: false, emoji: '📋', name: 'Plan', arg: clip(oneLine(item.text || ''), 70) };
    case 'contextCompaction':
      return { kind: 'text', text: 'compacting the Codex thread' };
    case 'reasoning': {
      const s = Array.isArray(item.summary) ? item.summary.join(' ') : item.summary || '';
      const body = oneLine(typeof s === 'string' ? s : '');
      return body ? { kind: 'text', text: body } : null;
    }
    // userMessage is the prompt we just sent, and agentMessage is handled by the
    // caller (the LAST one is the answer, the earlier ones are narration).
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// THE SAME STEP LINES, OUT OF A `codex exec` LOG
//
// A BACKGROUND Codex job stays on `codex exec` (it must outlive this daemon,
// which a child on our stdio pipes cannot), and it deliberately has no progress
// bubble: a background worker's activity is read in /status, not in a message
// that spends the chat's rate limit on a conversation nobody is having. But
// /status could only ever say "running", because nothing parsed the log.
//
// It can. The exec stream carries the same items under snake_case names
// (measured 2026-09-04: `item.started` / `item.completed` with
// `command_execution`, `exit_code`, `aggregated_output`), so one rename feeds
// the SAME mapper and /status gets the same step line the chat bubble draws.
// ---------------------------------------------------------------------------

const EXEC_ITEM_TYPES = {
  command_execution: 'commandExecution',
  file_change: 'fileChange',
  mcp_tool_call: 'mcpToolCall',
  dynamic_tool_call: 'dynamicToolCall',
  web_search: 'webSearch',
  image_view: 'imageView',
  image_generation: 'imageGeneration',
  agent_message: 'agentMessage',
  reasoning: 'reasoning',
};

/** One `codex exec` stream item, as a progress entry, or null. */
export function execItemEntry(item, home = '') {
  if (!item || typeof item !== 'object') return null;
  const type = EXEC_ITEM_TYPES[item.type] || item.type;
  if (type === 'agentMessage') return null; // narration, not a step
  return codexItemEntry({ ...item, type, exitCode: item.exit_code, savedPath: item.saved_path }, home);
}

/**
 * The last thing a running `codex exec` job did, from its log. For /status.
 *
 * Walks BACKWARDS and stops at the first line that yields a step, so a 50 MB
 * log costs one read and a handful of JSON.parse calls rather than a full
 * parse. Returns the entry (not a rendered string) so the caller renders it
 * with the one renderer.
 */
export function lastActFromExecLog(text, home = '') {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s || !s.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (ev.type !== 'item.started' && ev.type !== 'item.completed') continue;
    const entry = execItemEntry(ev.item, home);
    if (entry) return entry;
  }
  return null;
}

/** The absolute paths one item touched, for the chat ring. Best effort. */
export function pathsFromCodexItem(item) {
  if (!item || typeof item !== 'object') return [];
  const out = [];
  const add = (p) => {
    const s = String(p || '');
    if (s.startsWith('/') && !out.includes(s)) out.push(s);
  };
  if (item.type === 'fileChange') for (const c of item.changes || []) add(c?.path || c?.file);
  if (item.type === 'imageView') add(item.path);
  if (item.type === 'imageGeneration') add(item.savedPath);
  return out;
}

/**
 * One server message, classified.
 *
 * Returns null for everything the bubble does not care about, which is most of
 * the stream (mcp startup chatter, remote-control status, goal bookkeeping).
 * `threadId` is carried on every result so the caller can ignore a message
 * belonging to some other thread rather than trusting that there is only one.
 */
export function mapNotification(msg, { home = '' } = {}) {
  if (!msg || typeof msg !== 'object' || !msg.method) return null;
  const p = msg.params || {};
  switch (msg.method) {
    case 'thread/started':
      return { kind: 'threadStarted', threadId: p.thread?.id || null };
    case 'turn/started':
      return { kind: 'turnStarted', threadId: p.threadId || null, turnId: p.turn?.id || null };
    case 'turn/completed':
      return {
        kind: 'turnCompleted',
        threadId: p.threadId || null,
        turnId: p.turn?.id || null,
        status: p.turn?.status || 'completed',
        error: p.turn?.error || null,
        items: Array.isArray(p.turn?.items) ? p.turn.items : [],
      };
    case 'item/started': {
      // The step line goes up when the command STARTS, not when it finishes: a
      // 30 second build must be visible while it runs, which is the whole point
      // of a progress bubble.
      const entry = codexItemEntry(p.item, home);
      return entry ? { kind: 'entry', threadId: p.threadId || null, turnId: p.turnId || null, entry, itemId: p.item?.id || null } : null;
    }
    case 'item/completed': {
      if (p.item?.type === 'agentMessage') {
        return { kind: 'message', threadId: p.threadId || null, turnId: p.turnId || null, text: String(p.item.text || ''), itemId: p.item.id || null };
      }
      // Everything else already had its line drawn at item/started. What is new
      // at completion is the paths it touched and, for a shell call, whether it
      // failed: a red exit is worth its own line.
      const failed = p.item?.type === 'commandExecution' && Number(p.item.exitCode) !== 0 && p.item.exitCode != null;
      return {
        kind: 'itemDone',
        threadId: p.threadId || null,
        turnId: p.turnId || null,
        paths: pathsFromCodexItem(p.item),
        entry: failed
          ? { kind: 'text', text: `exit ${p.item.exitCode}: ${clip(unwrapShellCommand(p.item.command), 60)}` }
          : null,
      };
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return { kind: 'thinking', threadId: p.threadId || null, turnId: p.turnId || null, delta: String(p.delta || '') };
    case 'item/agentMessage/delta':
      return { kind: 'answerDelta', threadId: p.threadId || null, turnId: p.turnId || null, delta: String(p.delta || '') };
    case 'thread/tokenUsage/updated':
      return {
        kind: 'usage',
        threadId: p.threadId || null,
        turnId: p.turnId || null,
        // Named the way `codex exec --json` names them, so finalizeCodexMeta,
        // fmtCodexTokens and the /account tally take this without a translation
        // layer that could drift.
        tokens: {
          input_tokens: Number(p.tokenUsage?.last?.inputTokens) || 0,
          output_tokens: Number(p.tokenUsage?.last?.outputTokens) || 0,
        },
        contextWindow: Number(p.tokenUsage?.modelContextWindow) || null,
      };
    case 'error':
      return {
        kind: 'error',
        threadId: p.threadId || null,
        turnId: p.turnId || null,
        message: String(p.error?.message || 'the Codex turn failed'),
        willRetry: Boolean(p.willRetry),
      };
    default:
      return null;
  }
}

/** The final answer out of a completed turn, or '' when it produced none. */
export function answerFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) return it.text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// ERRORS
// ---------------------------------------------------------------------------

export const APP_SERVER_ERROR_CLASSES = Object.freeze([
  'not_steerable',
  'no_active_turn',
  'turn_mismatch',
  'thread_gone',
  'auth',
  'rate_limit',
  'other',
]);

/**
 * A JSON-RPC error object (or a bare string), classified.
 *
 * `not_steerable` is the one that changes behaviour rather than wording: the
 * server is telling us this turn cannot take a mid-turn message at all (it is a
 * /review or a /compact), so the message belongs in the queue and the owner
 * needs to be told it will run next rather than now. The other classes read the
 * same way they do on the exec path.
 */
export function classifyAppServerError(err) {
  const message = typeof err === 'string' ? err : String(err?.message || '');
  const data = err && typeof err === 'object' ? JSON.stringify(err.data ?? '') : '';
  const s = `${message} ${data}`;
  if (/activeTurnNotSteerable|not steerable|cannot accept.*steer/i.test(s)) return 'not_steerable';
  if (/no active turn to steer/i.test(s)) return 'no_active_turn';
  if (/expected active turn id/i.test(s)) return 'turn_mismatch';
  if (/no rollout found|thread\/resume/i.test(s)) return 'thread_gone';
  if (/\b401\b|unauthorized|unauthenticated|not (?:logged|signed) in|invalid[ _-]?api[ _-]?key|authentication|auth (?:error|failed|expired)|codex login|token (?:has )?expired/i.test(s)) {
    return 'auth';
  }
  if (/\b429\b|rate[ _-]?limit|usage limit|quota|too many requests/i.test(s)) return 'rate_limit';
  return 'other';
}

/**
 * Why a steer did not land, in the half-sentence that finishes the queue line.
 *
 * The queue line itself is the one dispatchPrompt already sends for every other
 * queued message ("Queued for the main lane (#1), runs on codex when its
 * current task finishes."); this is appended so the owner knows it was TRIED,
 * which is the difference between a bridge that queued his message and one that
 * ignored a steer.
 */
export function steerRefusalNote(cls) {
  if (cls === 'not_steerable') return 'that Codex turn cannot take a mid-turn message (it is a review or a compaction)';
  if (cls === 'no_active_turn') return 'the Codex turn had already finished';
  if (cls === 'turn_mismatch') return 'the Codex turn moved on before the message landed';
  if (cls === 'thread_gone') return 'the Codex thread is gone on OpenAI\'s side';
  if (cls === 'auth') return 'Codex is not signed in';
  if (cls === 'rate_limit') return 'the ChatGPT window is used up';
  return 'Codex refused the mid-turn message';
}

// ---------------------------------------------------------------------------
// WHEN TO STOP TRYING
// ---------------------------------------------------------------------------

/**
 * Should the chat lane give up on the app-server and run on `codex exec`?
 *
 * Pure so the rule is one tested function rather than an if-chain around a
 * spawn. `deaths` is the list of epoch-ms timestamps at which the child died.
 *
 * Two deaths inside the window is the signal, not one: an app-server killed by
 * a laptop sleeping, or by the OOM killer once, is not a broken install, and
 * making one death permanent would cost steering for the rest of the daemon's
 * life over a hiccup. `initFailed` is separate and immediate: a binary that
 * cannot complete `initialize` is an old CLI, and no number of retries will
 * teach it the protocol.
 */
export function shouldFallBackToExec({ deaths = [], now = Date.now(), windowMs = APP_SERVER_DEATH_WINDOW_MS, maxDeaths = APP_SERVER_MAX_DEATHS, initFailed = false, disabled = false } = {}) {
  if (disabled) return { fallback: true, reason: 'disabled' };
  if (initFailed) return { fallback: true, reason: 'init_failed' };
  const recent = (Array.isArray(deaths) ? deaths : []).filter((t) => Number(now) - Number(t) <= windowMs);
  if (recent.length >= maxDeaths) return { fallback: true, reason: 'child_died_twice' };
  return { fallback: false, reason: null };
}

/** The one line the bubble carries when a Codex chat turn runs on the exec path. */
export const EXEC_FALLBACK_NOTE = 'steering unavailable on this Codex run';

export function execFallbackLine(reason) {
  const why =
    reason === 'init_failed'
      ? 'this `codex` build has no app-server'
      : reason === 'child_died_twice'
        ? 'the Codex app-server keeps dying'
        : reason === 'disabled'
          ? 'the app-server is switched off in config.json'
          : 'the Codex app-server is unavailable';
  return `⚠️ ${EXEC_FALLBACK_NOTE}: ${why}. This turn runs one-shot; a message sent mid-turn queues instead of steering.`;
}
