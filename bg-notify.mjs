// What the owner actually sees when a background worker starts and finishes.
//
// WHY THIS FILE EXISTS. Every handoff notification used to read:
//
//   🌙 Handed to the background lane: LANE RULES (you are a background worker:
//   headless, no tmux, no terminal). These are runtime facts, not preferences:
//   1. NEVER use run_in_background: not on Bash, not on an Agent/Task dispatch…
//
// — identical for every job, carrying zero information about which job it was.
// Two independent changes combined to guarantee it: bg.mjs prepends ~1,400
// characters of LANE RULES to every brief, and the notice clipped the first 240
// characters of the composed text. The clip window never reached the task.
//
// A previous pass widened that window from 120 to 240 in response to the same
// complaint, which only bought MORE boilerplate. Widening is not the fix: the
// preamble has to come off BEFORE anything is clipped, and what is shown after
// that should be the brief's own title rather than its first 240 characters.
//
// These are pure string functions on purpose — they are the part that was
// wrong, so they are the part that has to be testable without a daemon, a
// Telegram token or a live worker. See bg-notify.test.mjs.

import { clip, oneLine, fmtElapsed } from './progress-render.mjs';

// The brief helpers live in bg-lane-rules.mjs, which is also what bg.mjs builds
// its LANE RULES header from: one definition of the anchor, the prefix, the
// title rule and the repo scan, so an edit to the rules cannot silently
// un-strip every notification. Re-exported because the notice renderers below
// are their main consumer and a caller should not have to know which file they
// came from.
import { LANE_RULES_PREFIX, TASK_ANCHOR, TITLE_MAX, briefRepo, briefTitle, stripLaneRules } from './bg-lane-rules.mjs';
export { LANE_RULES_PREFIX, TASK_ANCHOR, TITLE_MAX, briefRepo, briefTitle, stripLaneRules };

/**
 * Split a background run id back into its lane and start time.
 *
 * Two shapes reach the outcome funnel and both are prefixed the same way:
 *   close handler  <lane>-<startedAt>          (the run log's basename)
 *   re-attach      <lane>-<startedAt>-<pid>    (the inflight registry key)
 * Parsing the id means the completion notice works on BOTH paths without
 * threading extra arguments through the watchdog's callback.
 * Returns nulls for anything unrecognised — callers omit what they can't know.
 */
export function parseRunId(id) {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-(\d{10,})(?:-\d+)?$/.exec(String(id ?? ''));
  if (!m) return { lane: null, startedAt: null };
  return { lane: m[1], startedAt: Number(m[2]) };
}

/**
 * The message sent when a job is handed to a worker. Three short lines, because
 * on a phone with several workers running the questions are always: which
 * worker, what job, where, and how loaded is the machine.
 *
 *   🌙 bg2 · claude-telegram-bridge
 *   Fix: background-lane Telegram notifications show boilerplate
 *   2 workers running · 1 queued
 *   steer: node bg.mjs steer bg2-1788453512237 "..."
 *
 * The last line is the alternative to killing it. A worker used to be
 * unreachable once dispatched, so a correction meant kill + re-dispatch and a
 * thrown-away context; the command that avoids that is worth the one line, at
 * the exact moment the job is still young enough to redirect.
 *
 * Plain text, never markdown: repo names and brief titles routinely contain
 * underscores and asterisks, and one unbalanced entity costs the WHOLE message
 * its formatting.
 */
export function handoffNotice({ lane, runId, repo, brief, running, queued = 0, engine = 'claude', engineNote = null } = {}) {
  // A run on the second engine must be identifiable as one from the first
  // glyph: Codex has none of this bridge's context, is billed separately, and
  // cannot be steered, so reading its notice as a normal worker's would be
  // wrong on all three counts.
  const isCodex = String(engine).toLowerCase() === 'codex';
  const head = `${isCodex ? '🧠' : '🌙'} ${lane || 'background'}${repo ? ` · ${repo}` : ''}`;
  const title = briefTitle(stripLaneRules(brief));
  const lines = [head];
  if (title) lines.push(title);
  // Omitted rather than guessed: a wrong worker count is worse than no count.
  if (Number.isFinite(running) && running > 0) {
    lines.push(`${running} worker${running === 1 ? '' : 's'} running${queued > 0 ? ` · ${queued} queued` : ''}`);
  }
  // The RUN id, not the lane, whenever the caller knows it: lane names are
  // recycled (the pool hands `bg` to whoever is idle next), so a command copied
  // out of an old notice would steer whatever holds that name later, and be
  // acked as delivered. `<lane>-<startedAt>` belongs to one worker forever.
  // A target or nothing: a copy-pasteable command beats a placeholder.
  const target = runId || lane;
  // Codex takes no mid-run input, so offering a steer command would be a lie
  // that gets acked as delivered. Say what it IS running on instead, and why:
  // "why is this on Codex" is the only question a Codex notice raises.
  if (isCodex) lines.push(`engine: codex${engineNote ? ` (${engineNote})` : ''} · not steerable${target ? ` · ${target}` : ''}`);
  else if (target) lines.push(`steer: node bg.mjs steer ${target} "..."`);
  return lines.join('\n');
}

// 'finished' | 'failed' come from bgOutcome; the account-rotation path passes a
// sentence describing a session-limit death. Anything that is not a clean
// finish must NOT read as a tick.
export function outcomeGlyph(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'finished') return '✅';
  if (s === 'failed') return '❌';
  // A job HE stopped is not a warning: 🛑 is the stop glyph everywhere else in
  // this surface, and reading their own /stop as "something went wrong" is the
  // one outcome that should never look like a surprise.
  if (s === 'stopped') return '🛑';
  return '⚠️';
}

/**
 * The one-line completion ping.
 *
 *   ✅ bg2 · Fix: background-lane Telegram notifications · 18m
 *
 * A POINTER, not a summary: the report itself goes to the chat lane, which is
 * what turns it into words. This exists because that relay can be missed — a
 * 40-minute job would then finish with the owner seeing nothing at all.
 */
export function completionNotice({ lane, brief, status, elapsedSec } = {}) {
  const title = briefTitle(stripLaneRules(brief));
  const parts = [`${outcomeGlyph(status)} ${lane || 'background'}`];
  if (title) parts.push(title);
  if (Number.isFinite(elapsedSec) && elapsedSec >= 0) parts.push(fmtElapsed(Math.round(elapsedSec)));
  // 'finished' is already carried by the tick; anything else is news.
  if (String(status || '').toLowerCase() !== 'finished') parts.push(clip(oneLine(status || 'unknown outcome'), 80));
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// THE LIVE WORKER LINE
// ---------------------------------------------------------------------------
//
// One job used to produce FOUR objects in the chat and none of them ever
// changed: the handoff notice, a separate completion ping, an unexplained
// progress bubble while the assistant read the report, and then the assistant speaking. The notice in
// particular was six phone lines at minute 0 and the same six lines at minute
// 39, so "still working" and "died twenty minutes ago" looked identical.
//
// One message now, sent at dispatch and edited through its own life. Four
// phases out of ONE builder, so the head never moves under the reader and only
// the third line changes:
//
//   dispatch  🌙 bg2 · claude-telegram-bridge
//             Fix the engine-switch message
//             ⏳ starting… · 2 workers · 1 queued
//             /steer bg2 <instruction>
//
//   running   ⏳ 4m 12s · 23 steps · 💻 npm test
//
//   done      Done · 18m · 214 steps · report 24,180 chars
//
//   reading   Done · 18m · 214 steps · reading it now…
//
// The steer hint is on the DISPATCH frame only, where the job is still young
// enough to redirect, and it is the phone command (`/steer bg2 …`) rather than
// the terminal one the old notice taught. `bg.mjs ps` keeps the terminal form,
// because it is read in a terminal.

/** Cadence for the worker line. Deliberately NOT the chat bubble's 6s. */
export const WORKER_TICK_MS = 15_000;
/** When nothing changed. An idle worker edits at most once a minute. */
export const WORKER_IDLE_MS = 60_000;

// The head is ONE scannable row and the only line allowed past LINE_MAX, so it
// carries its own ceiling. Past this the repo drops to its own line rather than
// the model: "which engine, which model, at what effort" is the question the
// head was widened to answer, and the repo is already in the brief title under
// it. 60 is where his phone stops showing a third fact on one row.
export const HEAD_MAX = 60;

/**
 * The model and effort slot of the head.
 *
 * Effort rides WITH a model and never alone: `🌙 bg · delta-agents · xhigh`
 * reads as if xhigh were the model. Both are omitted whenever the caller does
 * not know them (a worker re-attached by log after a restart holds no spawn
 * record), because a guessed model on the line whose job is naming the engine
 * is worse than a line that stays quiet. `null`, `undefined` and blanks all
 * take the quiet branch.
 */
function engineBits(model, effort) {
  const m = clip(oneLine(model ?? ''), 24).trim();
  if (!m) return [];
  const e = clip(oneLine(effort ?? ''), 12).trim();
  return e ? [m, e] : [m];
}

/**
 * One line for all four phases of a background job.
 *
 * `lastAct` is ONE step, the most recent, already rendered by renderEntry
 * (`💻 Bash npm test`). Not a step list: the bubble owns that shape, and a
 * worker's is a headline, not a log.
 */
export function workerLine({
  phase = 'running',
  lane = 'background',
  repo = '',
  brief = '',
  title = null,
  elapsedSec = null,
  steps = 0,
  lastAct = null,
  running = 0,
  queued = 0,
  chars = null,
  status = 'finished',
  engine = 'claude',
  engineNote = null,
  model = null,
  effort = null,
  runId = null,
  scheduleId = null,
  scheduleWhen = null,
} = {}) {
  const isCodex = String(engine).toLowerCase() === 'codex';
  const terminal = phase === 'done' || phase === 'reading';
  // A scheduled job keeps ⏰ WHILE IT RUNS so it is identifiable as one, and
  // resolves to the same ✅/❌ head as every other worker: a failed daily job
  // that still reads "⏰ #3 · daily 08:00" carries its outcome nowhere the eye
  // lands.
  //
  // WHICH ENGINE IS DOING THE WORK, model and effort included. Two cards side
  // by side used to read `🌙 bg · delta-agents` and `🧠 bg3 · repo` and answer
  // "Claude or Codex" and nothing else, so "why is this one thinking harder"
  // and "did the bg pool follow /model" were invisible on the surface that
  // exists to say what the job is. It goes on the HEAD, not a new line: the
  // card is three lines on a phone and a fourth for a fact this small is a
  // worse trade than a longer row.
  const glyph = terminal ? outcomeGlyph(status) : scheduleId ? '⏰' : isCodex ? '🧠' : '🌙';
  const label = scheduleId ? `#${scheduleId}${scheduleWhen ? ` · ${scheduleWhen}` : ''}` : `${lane || 'background'}`;
  // A scheduled job's head names the schedule rather than a repo it did not
  // choose, so the repo slot is empty there and the model follows the schedule.
  const headRepo = scheduleId ? '' : repo;
  const tail = engineBits(model, effort);
  const full = [`${glyph} ${label}`, ...(headRepo ? [headRepo] : []), ...tail].join(' · ');
  // Too long for one phone row: the REPO drops to its own line, never the
  // model. A long repo name is recoverable from the title under it; a card that
  // silently stopped naming its engine is the defect this change fixes.
  //
  // MEASURED WITH THE GLYPH NORMALIZED TO TWO UNITS, which is not fussiness:
  // 🌙 and 🧠 are two UTF-16 units and ✅ and ❌ are one, so a head sitting on
  // the boundary while running would UNWRAP when it finished and the message
  // would reflow from four lines to three under the reader. The wrap has to be
  // a property of the job, not of the phase it is in.
  const wrapped = Boolean(headRepo) && full.length - glyph.length + 2 > HEAD_MAX;
  const head = wrapped ? [`${glyph} ${label}`, ...tail].join(' · ') : full;
  const name = title ?? briefTitle(stripLaneRules(brief));
  const lines = [head];
  if (wrapped) lines.push(headRepo);
  if (name) lines.push(name);

  if (phase === 'dispatch') {
    const bits = ['⏳ starting…'];
    // Omitted rather than guessed: a wrong worker count is worse than none.
    if (Number.isFinite(running) && running > 0) bits.push(`${running} worker${running === 1 ? '' : 's'}`);
    if (queued > 0) bits.push(`${queued} queued`);
    lines.push(bits.join(' · '));
    // Codex takes no mid-run input, so offering a steer would be a lie that
    // gets acked as delivered. Say what it is running on instead: "why is this
    // on Codex" is the only question a Codex notice raises.
    if (isCodex) lines.push(`🧠 codex${engineNote ? ` · ${engineNote}` : ''} · not steerable`);
    // The RUN id, not the lane, whenever the caller knows it: lane names are
    // recycled, so a steer copied out of an old notice would land in whatever
    // job holds the name later and be acked as delivered.
    else if (runId || lane) lines.push(`/steer ${runId || lane} <instruction>`);
    return lines.join('\n');
  }

  if (phase === 'running') {
    const bits = ['⏳'];
    bits[0] = `⏳ ${Number.isFinite(elapsedSec) && elapsedSec >= 0 ? fmtElapsed(Math.round(elapsedSec)) : 'running'}`;
    if (steps > 0) bits.push(`${steps} step${steps === 1 ? '' : 's'}`);
    if (lastAct) bits.push(clip(oneLine(lastAct), 24));
    lines.push(bits.join(' · '));
    return lines.join('\n');
  }

  // Terminal. 'Done' is the state word everywhere else in this surface, so a
  // clean finish says Done and the glyph in the head carries the rest.
  const clean = String(status || '').toLowerCase() === 'finished';
  // The state word, capitalized like 'Done' is: it is the one thing this line
  // is about, and 'Done'/'failed'/'stopped' in the same slot read as two
  // different kinds of word.
  const word = clip(oneLine(status || 'unknown outcome'), 40);
  const bits = [clean ? 'Done' : word.charAt(0).toUpperCase() + word.slice(1)];
  if (Number.isFinite(elapsedSec) && elapsedSec >= 0) bits.push(fmtElapsed(Math.round(elapsedSec)));
  if (steps > 0) bits.push(`${steps} step${steps === 1 ? '' : 's'}`);
  // "there is more, one tap away" made true without pasting it. writeFullReport
  // already returns { file, chars }; surfacing chars is what says so.
  if (phase === 'reading') bits.push('reading it now…');
  else if (Number.isFinite(chars) && chars > 0) bits.push(`report ${chars.toLocaleString('en-US')} chars`);
  lines.push(bits.join(' · '));
  return lines.join('\n');
}
