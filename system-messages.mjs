// The daemon's own voice: every message the bridge writes about itself.
//
// WHY THIS FILE EXISTS. An audit of all 88 texts the daemon sends on its own
// (2026-09-04) found one shape per author rather than one shape per product:
// bold headers on top of emoji, dashes and middle dots as separators in the
// same line, column-aligned key/value blocks that a proportional font ragged
// out, and 17 waits that sent a sentence which was true when it left and stale
// a minute later with no way to tell "still working" from "died".
//
// So the rules live HERE, as functions, rather than in prose beside 88 call
// sites:
//
//   1. Icon first, then label, then value. The icon is the scan target.
//   2. One fact per line. A line answering two questions is two lines.
//   3. The middle dot is the only in-line separator. Never a dash.
//   4. No em or en dashes in a source string. dash-normalize.mjs catches them
//      outbound, but it turns each one into a comma, which is not always the
//      punctuation the sentence wanted, and a public install starts with the
//      normalizer OFF.
//   5. Target 40 characters a line. Telegram's bubble font wraps at 44 and a
//      wrapped line reads as a paragraph.
//   6. Bold marks exactly one thing per message, the state word. Nothing else.
//   7. Reference material goes in an expandable blockquote, never inline.
//   8. A wait is ONE message, edited in place to its terminal state.
//
// Pure string functions, no daemon state, no Telegram, no clock unless it is
// passed in: this is the part that was wrong, so it is the part that has to be
// testable without a token. See system-messages.test.mjs.

import { clip, oneLine, fmtElapsed } from './progress-render.mjs';

// ---------------------------------------------------------------------------
// THE PLAIN-TEXT FALLBACK
// ---------------------------------------------------------------------------

/**
 * What `send()`/`editProgress()` fall back to when Telegram rejects the HTML.
 *
 * THE RULE: the fallback sends the VISIBLE part only, never the blockquote
 * body. Every message that hides reference material behind
 * `<blockquote expandable>` does so because the body was the complaint: /help
 * was 120 phone lines, a failed run was 4,000 characters of raw stderr. A
 * fallback that naively strips tags puts the wall back on exactly the message
 * the wall was removed from.
 *
 * renderProgressInner already got this right by re-rendering from its entry
 * list rather than de-tagging its own HTML; this is the same rule for callers
 * that have no entry list to re-render from.
 */
export function visibleOnly(html) {
  return String(html ?? '')
    // The body goes entirely, opening tag to closing tag, before anything else
    // touches the string. Non-greedy so two blockquotes do not swallow the
    // visible text between them.
    .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<[^>]+>/g, '')
    // Un-escape what escHtml escaped on the way in, ampersand LAST so a literal
    // "&lt;" in the source does not become "<".
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// SMALL SHARED PIECES
// ---------------------------------------------------------------------------

/** "2 workers", "1 worker", null when there are none to report. */
export function workerCount(n) {
  return Number.isFinite(n) && n > 0 ? `${n} worker${n === 1 ? '' : 's'}` : null;
}

/** "6 steps", "1 step", '' when nothing has happened yet. */
export function stepCount(n) {
  return Number.isFinite(n) && n > 0 ? `${n} step${n === 1 ? '' : 's'}` : '';
}

// ---------------------------------------------------------------------------
// /restart, AND THE BOOT THAT ANSWERS IT
// ---------------------------------------------------------------------------

/**
 * `/restart` used to say "back online in a few seconds…" and then, usually,
 * nothing: the boot announce is gated by a 10-minute cooldown stamped on the
 * PREVIOUS boot, so it was suppressed on exactly the restarts that were asked
 * for. The last thing on screen stayed "restarting", forever, and a good
 * restart looked identical to a dead daemon.
 *
 * One message now, and the NEW process edits it (see restartResolvedLine).
 */
export function restartingLine() {
  return '🔄 Restarting…';
}

/**
 * The same message, edited by the process that came back.
 *
 * The worker line is genuinely new information rather than decoration: before
 * this, a restart over two multi-hour jobs reported nothing at all, which is
 * what made /status read as "idle" on 2026-09-03.
 */
export function restartResolvedLine({ elapsedSec = null, workers = 0 } = {}) {
  const el = Number.isFinite(elapsedSec) && elapsedSec >= 0 ? ` · ${fmtElapsed(Math.round(elapsedSec))}` : '';
  const lines = [`✅ Back online${el}`];
  const w = workerCount(workers);
  if (w) lines.push(`🌙 ${w} re-attached`);
  return lines.join('\n');
}

/**
 * WHICH announce a boot owes, decided once instead of at three call sites.
 *
 * Three cases, and the first is the whole point of the rule: an explicitly
 * requested restart is the one announce that must NEVER be suppressed, so it
 * skips the cooldown entirely and edits the message /restart already put on
 * screen. A stale request (a crash hours later, a kickstart nobody asked for)
 * is not what brought this process up, so it falls back to today's behaviour.
 *
 *   { kind: 'edit', id, elapsedSec }  edit the /restart message in place
 *   { kind: 'announce' }              the ordinary 🟢 online line
 *   { kind: 'silent' }                inside the cooldown, say nothing
 *
 * `dropRestart` is separate from `kind` because a stale request has to be
 * cleared from the state file whichever announce follows it, or it sits there
 * forever waiting for a boot inside its window.
 */
export function bootAnnouncePlan({
  restartMsg = null,
  lastAnnounce = 0,
  now = Date.now(),
  maxAgeMs = 5 * 60 * 1000,
  cooldownMs = 10 * 60 * 1000,
} = {}) {
  const id = restartMsg?.id ?? null;
  const at = Number(restartMsg?.at) || 0;
  const age = id && at ? now - at : Infinity;
  if (id && age >= 0 && age < maxAgeMs) {
    return { kind: 'edit', id, elapsedSec: Math.round(age / 1000), dropRestart: true };
  }
  const cooled = now - (Number(lastAnnounce) || 0) > cooldownMs;
  return { kind: cooled ? 'announce' : 'silent', id: null, elapsedSec: null, dropRestart: Boolean(restartMsg) };
}

// ---------------------------------------------------------------------------
// A COMMAND'S OWN FETCH: /usage, /context, and anything else that goes quiet
// ---------------------------------------------------------------------------

/**
 * The line a command puts up INSTANTLY, before the work it has to wait on.
 *
 * `/usage` sent nothing at all and then, up to six seconds later, a 30-line
 * report; six seconds of silence after a command reads as a dropped message.
 * `/context` did the opposite and worse: a "gathering…" message, then the
 * report as a SECOND message, for a wait that is routinely 10 to 20 seconds
 * (two cold npx invocations).
 *
 * One message either way, ticking at 3s, because on a wait this short a stale
 * clock is the entire complaint. It is edited into the report itself, so the
 * answer lands where they are already looking.
 */
export function fetchingLine(label, elapsedSec = 0) {
  const el = Number.isFinite(elapsedSec) && elapsedSec > 0 ? ` · ${fmtElapsed(Math.round(elapsedSec))}` : '';
  return `📊 ${label}…${el}`;
}

/**
 * The other terminal state of that same message.
 *
 * Same shape as every other failure here: what failed, then the detail, clipped
 * so a stack trace cannot become the message. This is also ERR-08's fix, which
 * needed no separate change once the pre-message existed to become it.
 */
export function fetchFailedLine(what, error) {
  const detail = clip(oneLine(error ?? ''), 80);
  return [`❌ Could not read ${what}`, ...(detail ? [detail] : [])].join('\n');
}

// ---------------------------------------------------------------------------
// WHEN THE DAEMON DISPATCHES WORK INTO THE CHAT LANE ON ITS OWN
// ---------------------------------------------------------------------------
//
// onDeadWorkers and handBackToChat write for the assistant, not for the
// owner: a salvage
// procedure, untrusted-output markers, "do not paste this back". That framing
// is correct and load bearing (the bg-salvage instruction exists because ~50
// minutes of finished compute was thrown away twice) and must NOT be trimmed
// for readability. But it means the only thing the owner sees is a progress bubble
// starting with no message of their above it, and on the dead-worker path they see
// it after having heard nothing for 41 minutes.
//
// So the rule is a second message, not a shorter first one: when the daemon
// dispatches work into the chat lane by itself, it also sends the owner one factual
// line saying why. The judgement stays the assistant's; the system message only states what
// happened.

/**
 * A worker died without reporting.
 *
 * Two phases of one message: what happened, then that the assistant has picked it up. The
 * OUTCOME is deliberately not here. It is the assistant's to say in its own words once it
 * has read the salvage, so this line stops after saying who is holding it.
 */
export function deadWorkerLine({ lane = 'a worker', elapsedSec = null, title = '', phase = 'checking', name = 'Leash' } = {}) {
  const el = Number.isFinite(elapsedSec) && elapsedSec > 0 ? ` after ${fmtElapsed(Math.round(elapsedSec))}` : '';
  const lines = [`⚠️ ${lane} died${el}`];
  if (title) lines.push(clip(oneLine(title), 90));
  lines.push(phase === 'salvaging' ? `${name} is going through the salvage now.` : 'Checking what survived…');
  return lines.join('\n');
}

/** The report chain hit its cap. Nothing is lost; the auto-loop just stopped. */
export function chainPausedLine(max) {
  return [`⏸ Worker chain paused · ${max} reports in a row`, 'Nothing is lost. Send anything to resume.'].join('\n');
}

/**
 * Claude is back and is being handed what Codex answered while it was walled.
 *
 * Without this the flush is a bubble with no cause: the assistant starts
 * thinking about nothing, minutes after the last thing either side said.
 */
export function codexCatchUpLine(count, { name = 'Leash' } = {}) {
  const n = Number(count) || 0;
  return [`▶️ Claude is back`, `🧠 Catching ${name} up on ${n} Codex ${n === 1 ? 'answer' : 'answers'}`].join('\n');
}

// ---------------------------------------------------------------------------
// ERRORS: a cause, a remedy, and the rest one tap away
// ---------------------------------------------------------------------------

// How much of a raw tail goes inside the blockquote. The whole message has to
// stay under Telegram's 4,096, and the visible part plus the tags need room.
const ERROR_BODY_MAX = 3200;

/**
 * What actually went wrong, in the four classes that have different answers.
 *
 * The Codex side has had this since the second engine landed
 * (classifyCodexFailure) and it is the good shape: a detail, then a remedy.
 * The Claude side had a raw stderr tail, up to 4,000 characters, sent as the
 * message. This is the same idea on the same failures.
 */
export function classifyClaudeFailure(text) {
  const s = String(text ?? '');
  // Credit BEFORE auth: "credit balance is too low" is a billing state, not a
  // login problem, and telling them to re-authenticate would send them to the
  // wrong screen.
  if (/credit balance|insufficient (?:credit|funds)|billing|payment required|\b402\b/i.test(s)) return 'credit';
  if (/\b401\b|unauthorized|unauthenticated|invalid[ _-]?api[ _-]?key|authentication|not (?:logged|signed) in|oauth|token (?:has )?expired/i.test(s)) {
    return 'auth';
  }
  if (/\b429\b|rate[ _-]?limit|usage limit|quota|too many requests|you've (?:hit|reached) your/i.test(s)) {
    return 'rate_limit';
  }
  if (/ENOENT|command not found|no such file or directory/i.test(s)) return 'missing';
  return 'other';
}

/** The one line that follows a failure: what to actually do next. */
export function claudeFailureRemedy(kind) {
  if (kind === 'credit') return '👤 /account to swap · /usage for limits';
  if (kind === 'auth') return '👤 /account to swap, or claude login';
  if (kind === 'rate_limit') return '📊 /usage for the reset clocks';
  if (kind === 'missing') return '📁 Check claudeBin in config.json';
  return null;
}

/**
 * THE ERROR SHAPE, for every failure that carries a body worth keeping.
 *
 *   ❌ Claude run failed
 *   credit balance is too low
 *   👤 /account to swap · /usage for limits
 *   ▸ tap for the full error
 *
 * Returns { visible, body }. The caller renders `visible` plainly and hangs
 * `body` in an expandable blockquote, and the plain-text fallback sends the
 * visible half alone: putting the 4,000-character tail back would restore the
 * wall on the exact message the wall was removed from.
 *
 * The tail is kept from the END. An error's last lines are the ones that say
 * what happened; its first lines are usually a banner.
 */
export function errorMessage({
  title = 'Something failed',
  detail = '',
  remedy = null,
  full = '',
  hint = 'tap for the full error',
  // ❌ is a failure, ⚠️ is a degradation the daemon recovered from. A corrupt
  // schedules.json is the second: it was quarantined, the daemon carried on,
  // and a red cross would read as "the bridge is down".
  glyph = '❌',
} = {}) {
  const visible = [`${glyph} ${title}`];
  const d = clip(oneLine(detail), 120);
  if (d) visible.push(d);
  if (remedy) visible.push(remedy);
  let body = String(full ?? '').trim();
  // Nothing to expand when the body says no more than the detail already did.
  if (body && oneLine(body).length <= 120 && oneLine(body) === oneLine(detail)) body = '';
  if (body.length > ERROR_BODY_MAX) body = `…${body.slice(-ERROR_BODY_MAX)}`;
  if (body) visible.push(`▸ ${hint}`);
  return { visible: visible.join('\n'), body };
}

/**
 * The first line of a raw failure, which is what a human reads first anyway.
 *
 * Skips banner noise (blank lines, a bare "Error:", a stack frame) so the
 * detail line says something rather than repeating the word "Error".
 */
export function firstMeaningfulLine(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if (/^(?:at\s|\s*[-*]\s*$)/.test(l)) continue; // a stack frame
    if (/^error:?$/i.test(l)) continue;
    return l.replace(/^Error:\s*/i, '');
  }
  return '';
}

// ---------------------------------------------------------------------------
// /help: an index, not a document
// ---------------------------------------------------------------------------

/**
 * The command index, grouped by what they are trying to DO.
 *
 * /help was 4,700 characters, 26 paragraphs, chunked into two Telegram messages
 * and roughly 120 phone lines: a reference document delivered as a wall. This
 * is the index; the document itself goes behind the expandable blockquote, so
 * nothing is lost and it costs zero screen until one tap.
 *
 * Exported as data rather than a string so a test can assert that every command
 * the daemon reserves appears in exactly one group. A command that stops being
 * listed is a command they can no longer discover, and that is the failure mode
 * an index has that a wall does not.
 */
// Telegram's per-message cap is 4,096 and the index plus the tags need room.
export const HELP_BODY_MAX = 3600;

// Telegram's real ceiling (4,096) minus slack. NOT the repo's TG_MSG_LIMIT of
// 4,000: this reference genuinely composes to ~3,980, and budgeting it at 4,000
// would throw away 300 characters of a document that fits. The message that has
// to fit is the COMPOSED HTML: escape(index) + the tags + escape(reference).
export const HELP_COMPOSED_MAX = 4080;
// `\n<blockquote expandable>` (24) + `</blockquote>` (13)
const QUOTE_TAGS_LEN = 37;

export const HELP_GROUPS = [
  { icon: '💬', commands: ['/new', '/chats', '/rename', '/resume', '/compact'] },
  { icon: '🌙', commands: ['/status', '/steer', '/stop'] },
  { icon: '🧠', commands: ['/engine', '/codex', '/model', '/yolo'] },
  { icon: '📊', commands: ['/usage', '/account', '/context'] },
  { icon: '⏰', commands: ['/remind', '/schedules', '/unschedule'] },
  { icon: '📁', commands: ['/cd', '/logs', '/restart', '/help'] },
];

/**
 * Returns { visible, body }: the index, and the full reference to hang behind
 * the blockquote. Same contract as errorMessage, for the same reason, and the
 * plain-text fallback sends the index alone. If it sent the body instead,
 * /help would be the 120-line wall again on exactly the message where the wall
 * was the complaint.
 */
export function helpMessage({
  name = 'Leash',
  host = '',
  reference = '',
  maxBody = HELP_BODY_MAX,
  // What the caller will actually SEND: the composed HTML, not the raw body.
  // Escaping expands every & < > in the reference, so a raw budget that fits
  // can compose to a message Telegram rejects, and a rejected /help falls back
  // to the index with its whole reference silently gone. Defaults to identity
  // so the pure form is still callable with no arguments.
  escape = (t) => t,
  composedMax = HELP_COMPOSED_MAX,
} = {}) {
  const visible = [
    `📖 ${name}${host ? ` on ${host}` : ''}`,
    'Send any text · it runs and replies.',
    '',
    ...HELP_GROUPS.map((g) => `${g.icon} ${g.commands.join(' ')}`),
    '',
    'Any other /command goes to Claude Code.',
  ];
  const TRUNCATED = '\n\n… the rest is in README.md';
  let body = String(reference ?? '').trim();
  // A guard, not a design: the reference is written to fit, and this exists so
  // that a future edit which pushes it over Telegram's 4,096 loses the tail
  // visibly instead of losing the whole message to a rejected send.
  if (body.length > maxBody) body = body.slice(0, maxBody) + TRUNCATED;
  const head = visible.join('\n') + (body ? '\n▸ tap for the full reference' : '');
  // Room left for the escaped body, once the escaped index and the blockquote
  // tags have taken theirs.
  const room = composedMax - escape(head).length - QUOTE_TAGS_LEN;
  if (body && escape(body).length > room) {
    // Only now is the "… the rest is in README.md" tail paid for: reserving it
    // up front would cut a reference that fits.
    const budget = room - TRUNCATED.length;
    // Escaping is not length-preserving, so walk it down rather than compute a
    // ratio: at most a few iterations, and it cannot overshoot.
    let cut = body.length;
    while (cut > 0 && escape(body.slice(0, cut)).length > budget) cut = Math.floor(cut * 0.9);
    body = body.slice(0, cut) + TRUNCATED;
  }
  if (body) visible.push('▸ tap for the full reference');
  return { visible: visible.join('\n'), body };
}

// ---------------------------------------------------------------------------
// A RUNNING WORKER, AS A BLOCK: one renderer, three readers
// ---------------------------------------------------------------------------

/**
 * `/status`, `/steer` with no arguments, and anything else that has to show
 * what is running, all render a worker the same way. They used to render it
 * three ways: /status built its own bold headers inline, /steer printed
 * `psTable`, a nine-column fixed-width table with no chance on a 40-character
 * line, and the two disagreed about which facts mattered.
 *
 *   🌙 bg2 · 🟢 running 18m · 214 steps
 *      "Fix the engine-switch message"
 *      ↳ 💻 npm test
 *      steerable · /steer bg2 <text>
 *
 * The continuation rows are indented by three spaces, which is what the account
 * bars already use, so the whole surface has one indent.
 *
 * NOT bold. The emoji is the marker; bold on top of an emoji is two markers for
 * one job, and `**🤖 Chat**` was the audit's example of it.
 *
 * `psTable` is untouched and still what `bg.mjs ps` prints. It is a terminal
 * table read in a terminal.
 */
export const STATUS_INDENT = '   ';

export function workerStatusBlock(
  {
    icon = '🌙',
    lane = 'worker',
    state = 'running',
    elapsedSec = null,
    steps = 0,
    title = '',
    lastAct = null,
    steerable = false,
    steers = 0,
    note = null,
    queued = 0,
  } = {},
  // The chat lane has no steer line: everything they type goes into it by
  // definition, so "steerable" there is a fact about nothing they can act on.
  { steerHint = false, showSteer = true } = {},
) {
  const glyph = state === 'running' ? '🟢' : state === 'wrapping up' ? '🟡' : '⚪';
  const bits = [`${glyph} ${state}`];
  if (Number.isFinite(elapsedSec) && elapsedSec >= 0) bits[0] += ` ${fmtElapsed(Math.round(elapsedSec))}`;
  const st = stepCount(steps);
  if (st) bits.push(st);
  const out = [`${icon} ${lane} · ${bits.join(' · ')}`];
  if (title) out.push(`${STATUS_INDENT}"${clip(oneLine(title), 90)}"`);
  if (lastAct) out.push(`${STATUS_INDENT}↳ ${clip(oneLine(lastAct), 60)}`);
  const steerBits = showSteer ? [steerable ? 'steerable' : 'not steerable'] : [];
  if (showSteer && steerable && steerHint) steerBits.push(`/steer ${lane} <text>`);
  if (steers > 0) steerBits.push(`${steers} steered in`);
  if (note) steerBits.push(note);
  if (steerBits.length) out.push(`${STATUS_INDENT}${steerBits.join(' · ')}`);
  if (queued > 0) out.push(`${STATUS_INDENT}📥 ${queued} queued`);
  return out.join('\n');
}

/**
 * `/steer` with no arguments.
 *
 * Two lines of usage and then the same worker blocks /status shows, instead of
 * `psTable`. The command they are being taught is the one they can type here.
 */
export function steerUsage(workers = []) {
  const list = Array.isArray(workers) ? workers : [];
  return [
    'Usage: /steer <lane|latest> <instruction>',
    'It keeps the context it has already built.',
    ...(list.length ? list.flatMap((w) => ['', workerStatusBlock(w)]) : ['', '⚪ No background workers running.']),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// THE QUEUE: a position that changes, on a message that used to not
// ---------------------------------------------------------------------------

const engineIcon = (e) => (String(e).toLowerCase() === 'codex' ? '🧠' : '🤖');
const engineLabel = (e) => (String(e).toLowerCase() === 'codex' ? 'Codex' : 'Claude');

/**
 * A message that had to wait, and what it is waiting on.
 *
 *   📥 Queued · #2 in line · 🤖 Claude
 *   Waiting on: "audit the system messages"
 *
 * The old line was "Queued for the main lane (#2), runs on claude when its
 * current task finishes": three phone lines, and static for the whole wait,
 * so a queue that had moved and a queue that was stuck looked the same.
 *
 * `reason` is ACK-04's case: Codex refused the message mid-turn, which is a
 * different fact from "the lane is busy" and needs saying once.
 */
export function queueAck({ position = 1, engine = 'claude', waitingOn = '', reason = null } = {}) {
  const pos = `#${position}${position === 1 ? '' : ' in line'}`;
  const lines = [`📥 Queued · ${pos} · ${engineIcon(engine)} ${engineLabel(engine)}`];
  if (reason) lines.push(clip(oneLine(reason), 120));
  if (waitingOn) lines.push(`Waiting on: "${clip(oneLine(waitingOn), 60)}"`);
  return lines.join('\n');
}

/**
 * The SAME message, when its turn comes. The run's own progress bubble appears
 * below it and takes over, so this only has to close the wait it opened.
 */
export function queueStarted({ waitedSec = null } = {}) {
  const w = Number.isFinite(waitedSec) && waitedSec > 0 ? ` · waited ${fmtElapsed(Math.round(waitedSec))}` : '';
  return `▶️ Started${w}`;
}

/** The other terminal state: /stop cleared the queue this message was in. */
export function queueDropped() {
  return '🛑 Dropped from the queue';
}

/** Codex refused it mid-turn, but the turn had already finished, so it runs now. */
export function queueRunningNow({ engine = 'codex', reason = null } = {}) {
  return [
    `▶️ Running it now · ${engineIcon(engine)} ${engineLabel(engine)}`,
    reason ? clip(oneLine(reason), 120) : 'The turn had already finished.',
  ].join('\n');
}

/** ACK-03. The queue is full; the two things they can do about it. */
export function queueFull({ lane = 'main', max = 5 } = {}) {
  return [`⏳ ${lane} queue is full (${max})`, `Wait, or /stop ${lane} to clear it.`].join('\n');
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

/**
 * The header block: where, what, and which engines, one fact per line.
 *
 * What changed from the old version, all three from the same rule:
 *   • `**📍 Leash on host**` loses the bold. Bold on top of an emoji is two markers
 *     for one job, and the emoji is the one that scans.
 *   • `**🤖 Chat** [dash] 🟢 running · 45s` carried a dash AND a middle dot as
 *     separators in one line. The middle dot is the only one.
 *   • the model line's glyph was 🧠, which is Codex's glyph in every other
 *     message here. 🤖 is Claude's, and this line is about the Claude model.
 *
 * Everything is omitted rather than guessed: a missing session, an unknown
 * context percentage and an unreachable usage row each cost their own line and
 * nothing else. /status is a liveness view, so a line that cannot be true right
 * now does not appear.
 */
export function statusHeader({
  name = 'Leash',
  host = '',
  cwd = '',
  model = '',
  permissions = '',
  fallbackOn = null,
  engineLine = null,
  session = '',
  ctxPct = null,
  threadNote = '',
  usageBlock = null,
} = {}) {
  const lines = [`📍 ${name}${host ? ` on ${host}` : ''}`];
  if (cwd) lines.push(`📁 ${cwd}`);
  const engineBits = [model, permissions, fallbackOn == null ? null : `fallback ${fallbackOn ? 'on' : 'off'}`].filter(Boolean);
  if (engineBits.length) lines.push(`🤖 ${engineBits.join(' · ')}`);
  if (engineLine) lines.push(engineLine);
  const ctx = Number.isFinite(ctxPct) ? ` · ctx ${ctxPct}%` : '';
  lines.push(`💬 chat ${session || 'fresh'}${ctx}${threadNote ? ` · ${threadNote}` : ''}`);
  if (usageBlock) lines.push(usageBlock);
  return lines.join('\n');
}

/** Nothing is running on this lane. One line, and it says which lane. */
export function idleLaneLine({ icon = '🌙', lane = 'Background', queued = 0, finishing = false, note = null } = {}) {
  if (finishing) {
    return `${icon} ${lane} · 🟡 wrapping up${queued > 0 ? ` · ${queued} queued` : ''}`;
  }
  if (queued > 0) return `${icon} ${lane} · 📥 ${queued} queued`;
  return `${icon} ${lane} · ⚪ idle${note ? ` · ${note}` : ''}`;
}

// ---------------------------------------------------------------------------
// LIMIT WALLS: a clock that stays true no matter when they read it
// ---------------------------------------------------------------------------
//
// The old wall notice said "Earliest reset: 3h 12m from now" once and then went
// quiet for hours. The relative number IS the bug: read forty minutes later it
// is wrong by forty minutes, and nothing in the message says when it was sent,
// so there is no way to correct for it.
//
// Every line below leads with the ABSOLUTE clock, which cannot rot, and carries
// the relative one second, where it is a convenience rather than the fact. The
// message then edits itself every five minutes: a three-hour wait does not need
// a live clock, it needs a clock that is not wrong, and 36 edits over three
// hours is nothing against the per-chat bucket.

/** How often a wall re-renders. Not a live clock, just a not-wrong one. */
export const WALL_TICK_MS = 5 * 60 * 1000;

/**
 * Every Claude account is limited (ACC-03).
 *
 * The third line is the difference between "you are blocked" and "you are
 * blocked for background work only", which are very different afternoons. It
 * appears only when Codex is actually reachable and actually taking chat.
 */
export function limitWallLine({ resetClock = null, leftText = null, codexTaking = false } = {}) {
  const lines = ['⛔ Every Claude account is limited'];
  const bits = [resetClock ? `Resets ${resetClock}` : null, leftText ? `in ${leftText}` : null].filter(Boolean);
  lines.push(bits.length ? `⏳ ${bits.join(' · ')}` : '⏳ No reset time is known');
  lines.push(codexTaking ? '🧠 Codex is taking chat messages' : 'Background work is paused until then.');
  return lines.join('\n');
}

/**
 * The same message once the wall lifts.
 *
 * A ⏳ that stops ticking and never resolves is worse than a static line: it
 * teaches the reader that the live lines lie. This is the ✅ it becomes.
 */
export function limitWallResolved({ clock = null, codexAnswered = 0 } = {}) {
  const lines = [`✅ Claude is back${clock ? ` · ${clock}` : ''}`];
  const n = Number(codexAnswered) || 0;
  // Not "while it was out": the line above already said Claude is back, so the
  // clause is the third one of a sentence nobody finishes reading, and it is
  // what pushed this onto a second phone line.
  if (n > 0) lines.push(`🧠 Codex answered ${n} message${n === 1 ? '' : 's'}`);
  return lines.join('\n');
}

/**
 * The swap could not happen (ACC-02).
 *
 * Which account they are still on is the fact the old version left out, and it is
 * the one that decides what they do next.
 */
export function swapFailedLine({ error = '', account = '' } = {}) {
  const lines = ['⚠️ Session limit hit, swap failed'];
  const detail = clip(oneLine(error), 80);
  if (detail) lines.push(detail);
  if (account) lines.push(`👤 Still on ${account}`);
  return lines.join('\n');
}

/**
 * Both engines walled (BG-07), the same object one level up.
 *
 * Two walls is the one state where a single clock actively misleads: told only
 * about Claude they wait for a reset that will not help, and told only about
 * Codex they do the same. Whichever comes back first runs the parked message,
 * so both clocks are what they need, on one line, glyph-labelled.
 */
export function bothWalledLine({ claudeAt = null, codexAt = null, claudeAvailable = true } = {}) {
  const claudeBit = claudeAvailable
    ? `🤖 Claude ${claudeAt ? `resets ${claudeAt}` : 'is limited'}`
    : '🤖 No claude on this machine';
  const codexBit = `🧠 Codex ${codexAt ? codexAt : 'is limited'}`;
  return ['⏸ Both engines are out', `${claudeBit} · ${codexBit}`, 'Your message is parked, it runs by itself.'].join(
    '\n',
  );
}

/**
 * A wall lifted and the parked messages are going through (BG-08).
 *
 * Naming WHICH engine came back matters here: the parked work runs on whichever
 * one is available, so this line is also the answer to "what is about to run
 * this on my behalf".
 */
export function enginesBackLine({ engine = null, count = 0 } = {}) {
  const n = Number(count) || 0;
  const who = engine === 'claude' ? 'Claude' : engine === 'codex' ? 'Codex' : 'An engine';
  // "parked" alone, not "parked messages": the wall notice one message earlier
  // said "Your message is parked", so the noun is already established and the
  // long form pushes the named-engine cases onto a second line.
  return `▶️ ${who} is back · running ${n} parked`;
}

/**
 * THEIR OWN MESSAGE hit the wall, and the bridge rotated under it.
 *
 * The background lane has had this since rotation existed; the chat lane had
 * nothing, so a message the owner was sitting there waiting on came back
 * "❌ Error · 5s" with two other accounts free and they swapped by hand. This
 * is the line that run's own progress message becomes: not a new bubble,
 * because the bubble they are watching is the one that owes them the answer.
 *
 * Three facts, three lines: which account went out, which one is live now, and
 * that they do not have to do anything. Names are clipped to the bubble rather
 * than wrapped, because a wrapped account name reads as two accounts.
 */
export function chatRotatedLine({ from = '', to = '' } = {}) {
  const lines = [];
  // NO NAMES: something else rotated seconds ago (the cooldown), so this run
  // did not make the swap and cannot name its halves. It also cannot know
  // whether the account it died on is still the live one, so it claims neither:
  // what it says instead is only what is certainly true, that the retry runs on
  // whatever is live now.
  if (!from && !to) return ['🔄 Session limit hit', '⏳ Retrying on the live account'].join('\n');
  lines.push(from ? `🔄 Session limit on ${clip(oneLine(from), 23)}` : '🔄 Session limit hit');
  if (to) lines.push(`👤 Swapped to ${clip(oneLine(to), 29)}`);
  lines.push('⏳ Retrying your message');
  return lines.join('\n');
}

/**
 * The same moment with NOTHING to swap to (ACC-03, chat side).
 *
 * The ⛔ wall notice carries the clock and is its own live message; this one is
 * only what the dead run's bubble becomes, so it says what happens to THIS
 * message and nothing else. Which of the two second lines is true is decided by
 * the caller, from the same expression the wall line uses.
 */
export function chatWalledRetryLine({ codexTaking = false } = {}) {
  return [
    '⛔ Session limit, no account free',
    codexTaking ? '🧠 Codex is taking this message' : '⏳ Your message is parked',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /new: one message, one glyph
// ---------------------------------------------------------------------------

/**
 * `/new` sent two messages, both opening with 🆕: the clear, then a separate
 * "Codex thread cleared. The next message starts a fresh one (Codex keeps no
 * memory of the old one either way)." The parenthetical is true and is already
 * in /help; on a confirmation it is the third clause of a sentence nobody
 * finishes reading, and it arrived as its own bubble.
 *
 * One message now, one fact per line. The Codex line stays a LINE rather than
 * a clause, because on a Codex-first install it is the thing that was cleared
 * and must not read as a footnote to a Claude session that may not exist here.
 */
export function newSessionLine({ which = 'chat', archived = null, codexThread = false } = {}) {
  const what = which === 'all' ? 'Both sessions' : which === 'bg' ? 'Background' : 'Chat';
  const lines = [`🆕 ${what} cleared`];
  if (archived) lines.push(`💬 Old chat archived (${archived}) · /resume it`);
  if (codexThread) lines.push('🧵 Codex thread cleared too');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /compact: one message for a whole model turn
// ---------------------------------------------------------------------------
//
// /compact is a wait (a whole model turn) reported by up to four objects: the
// start notice, the run's own bubble, a two-line done notice, and then a fresh
// chat's bubble. The start notice is the one that lives: it goes up instantly
// and is edited into whichever of the three endings actually happens.

/** Sent the moment the command lands. Ticks like any other short wait. */
export function compactingLine(elapsedSec = 0) {
  const el = Number.isFinite(elapsedSec) && elapsedSec > 0 ? ` · ${fmtElapsed(Math.round(elapsedSec))}` : '';
  return `📦 Compacting…${el} · asking for a summary`;
}

/** The queued variant of the same message: still ⏳, still the same object. */
export function compactQueuedLine() {
  return '⏳ Compaction queued behind the current task';
}

/** It worked. Three facts, three lines, on the message that was already there. */
export function compactDoneLine({ elapsedSec = null, archived = null } = {}) {
  const el = Number.isFinite(elapsedSec) && elapsedSec >= 0 ? ` · ${fmtElapsed(Math.round(elapsedSec))}` : '';
  const lines = [`✅ Compacted${el}`];
  if (archived) lines.push(`💬 Old chat archived (${archived}) · /resume it`);
  lines.push('🆕 Fresh chat primed with the summary');
  return lines.join('\n');
}

/** The other ending: /new or /resume landed while the summary was being written. */
export function compactDiscardedLine() {
  return ['⚠️ Compaction discarded', 'The chat was switched while it ran.'].join('\n');
}

// ---------------------------------------------------------------------------
// ATTACHMENTS
// ---------------------------------------------------------------------------
//
// A photo, video or file was downloaded and dispatched with NO message at all.
// For one small photo the run's bubble appears fast enough that this is fine.
// For an album of six, or a 20MB video on a slow connection, there is a
// multi-second gap with nothing on screen, and the group's 2-second settle
// timer adds to it.

/**
 * The noun, pluralised and typed when every file agrees. A mixed album says
 * "files", because "3 photos" over two photos and a video is a small lie in
 * the one message whose whole job is saying what arrived.
 */
export function attachmentNoun(kinds = []) {
  const list = (kinds || []).filter(Boolean);
  const n = list.length;
  const kind = list.every((k) => k === list[0]) ? list[0] : 'file';
  const noun = kind === 'photo' ? 'photo' : kind === 'video' ? 'video' : kind === 'voice message' ? 'voice note' : 'file';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The ack, for an ALBUM only.
 *
 * A single file gets no message: the bubble's first frame carries it instead
 * (see attachmentFrameNote), which costs nothing and adds no object to the
 * chat. Two or more is the case where the settle timer makes the gap visible,
 * and the reader is owed a receipt for files they watched upload.
 */
export function attachmentAck(kinds = []) {
  if (!kinds || kinds.length < 2) return null;
  return `📎 ${attachmentNoun(kinds)} saved · running them`;
}

/** What rides on the run bubble's first frame. Null when there is nothing to say. */
export function attachmentFrameNote(kinds = []) {
  if (!kinds || !kinds.length) return null;
  return `📎 ${attachmentNoun(kinds)}`;
}

// ---------------------------------------------------------------------------
// The /codex sub-views: a value, a set line, and the reasoning one tap away
// ---------------------------------------------------------------------------
//
// `/codex network` was six lines, one of them 150 characters, explaining how it
// differs from /yolo. The distinction is real and worth writing down; it is not
// worth five sixths of a view they open to check one word. Same for model and
// effort: the value line, the set line, and everything explanatory behind the
// blockquote /help already uses.

/**
 * Returns `{ visible, body }` like errorMessage and helpMessage, so the caller
 * composes it the same way and the plain-text fallback drops the body rather
 * than un-hiding it.
 */
export function codexSubView({ icon = '🧠', label = '', value = '', now = null, set = '', detail = '' } = {}) {
  const visible = [`${icon} ${label}: ${value}`];
  // "In force now" is a different fact from the setting: a read-only run has no
  // network either way, and the first turn after an engine handoff runs
  // without it. Only shown when it can disagree with the setting.
  if (now != null && now !== value) visible.push(`🔒 In force now: ${now}`);
  if (set) visible.push(set);
  const body = String(detail || '').trim();
  if (body) visible.push('▸ tap for why');
  return { visible: visible.join('\n'), body };
}

/**
 * The boot announce (SYS-01).
 *
 * Three problems in one line. `.local` is noise. The `/help` hint is redundant,
 * because the command menu is registered on boot and is one tap away. And
 * "Claude bridge" is a name that is about to be wrong: this daemon is named in
 * config.json and says that name in every other string it sends.
 *
 * The worker line is genuinely new information rather than decoration: a
 * restart over two multi-hour jobs reported nothing at all, which is the
 * failure that made /status say "idle" on 2026-09-03.
 */
export function bootAnnounceLine({ name = 'Leash', host = '', workers = 0 } = {}) {
  const lines = [`🟢 ${name} online${host ? ` · ${host}` : ''}`];
  const w = workerCount(workers);
  if (w) lines.push(`🌙 ${w} re-attached`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The account and usage views: three tightenings, applied from OUTSIDE
// ---------------------------------------------------------------------------
//
// account-usage.mjs is a SHARED module: scripts/check-shared.sh requires it to
// be byte-identical with its sibling repo, so these three changes cannot be
// made at source. They are the smallest possible post-pass over its output, and
// deliberately conservative: an anchored pattern per change, so a rewording on
// the other side of the shared boundary makes this a no-op rather than a
// corrupted view.
//
// The BARS are not touched, and must not be. usageBar() is shared by both views
// so they cannot drift, and the code-span wrapping is what makes the rows line
// up in a proportional font.

/**
 * 1. Drop the bold from the header. It sits on top of an emoji, which is two
 *    markers for one job, and the emoji is the one that scans.
 * 2. Drop the em dash subtitle. It cannot be fixed at source and the outbound
 *    normalizer would turn it into a comma.
 * 3. Drop /usage's footer. The timezone is their own, and the swap hint is
 *    already on the other view, one line from the top.
 */
export function tightenAccountView(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    // The footer, and the blank line that was only there to separate it.
    if (/^Times are .+\. \/account <name> to swap\.$/.test(line)) {
      while (out.length && out[out.length - 1] === '') out.pop();
      continue;
    }
    if (/^(👤|📊) \*\*[^*]+\*\*/.test(line)) {
      out.push(line.replace(/\*\*([^*]+)\*\*/, '$1').replace(/\s+[–—]\s+.*$/, ''));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
