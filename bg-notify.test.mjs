#!/usr/bin/env node
// Tests for the background-lane Telegram notifications.
//
// The bug these lock down: every handoff notice read "🌙 Handed to the
// background lane: LANE RULES (you are a background worker: headless, no tmux,
// no terminal)…" — identical for every job, because bg.mjs prepends ~1,400
// characters of rules and the notice clipped the first 240 of the result. A
// previous pass widened that clip from 120 to 240 in answer to the same
// complaint and shipped MORE boilerplate. So the interesting assertions here
// are not "the string is short" but "the string names the JOB".
//
//   node bg-notify.test.mjs
//
// The last block runs the REAL bg.mjs (copied into a temp dir, exactly as
// bg-lane-rules.test.mjs does, so the live bg-queue.json is never touched) and
// round-trips a brief through it. That is what stops the separator in bg.mjs
// and the split in bg-notify.mjs drifting apart: the two files carry the
// constant independently on purpose — bg.mjs is a standalone CLI with no
// imports — and a comment saying "keep these in sync" would decay.

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  stripLaneRules,
  briefTitle,
  parseRunId,
  briefRepo,
  handoffNotice,
  completionNotice,
  TASK_ANCHOR as TASK_SEPARATOR,
  TITLE_MAX,
  workerLine,
  HEAD_MAX,
  WORKER_TICK_MS,
  WORKER_IDLE_MS,
} from './bg-notify.mjs';
import { bgOutcome } from './detached-workers.mjs';

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

// A faithful copy of what bg.mjs prepends. Built here rather than imported
// because bg.mjs executes on import (it queues a job); the round-trip block at
// the bottom is what proves this copy still matches the real one.
const RULES = [
  'LANE RULES (you are a background worker: headless, no tmux, no terminal). These are runtime facts, not preferences:',
  '1. NEVER use run_in_background: not on Bash, not on an Agent/Task dispatch. In this lane a backgrounded process is KILLED when your turn ends, the output file stays empty, and no completion notification is ever delivered.',
  '2. Bash caps at 600s. Anything longer must be CHUNKED into bounded foreground runs that each report and can be resumed.',
  '3. Your final message IS your report, and it is written in FULL to bg-reports/<runId>.md.',
  '',
  TASK_SEPARATOR,
  '',
].join('\n');
const queued = (brief) => `${RULES}${brief}`;

// ---------------------------------------------------------------------------
// stripLaneRules
// ---------------------------------------------------------------------------

t('a real queued brief loses the rules and keeps the task', () => {
  const brief = '# Fix the notification\n\nBody text here.';
  eq(stripLaneRules(queued(brief)), brief);
});

t('nothing is stripped from text that does not carry the rules', () => {
  const raw = 'run the full test suite and report what fails';
  eq(stripLaneRules(raw), raw, 'a bare argv one-liner must pass through untouched');
});

t('only the FIRST separator splits — a brief quoting it survives intact', () => {
  // This very brief quotes the separator in its own body while describing the
  // fix. Splitting on the last occurrence would have thrown the job away.
  const brief = ['# Strip the preamble', '', 'LANE_RULES ends with a literal', TASK_SEPARATOR, 'line. Use it as the anchor.'].join(
    '\n',
  );
  eq(stripLaneRules(queued(brief)), brief);
  ok(stripLaneRules(queued(brief)).includes(TASK_SEPARATOR), 'the body kept its own copy of the separator');
});

t('rules with no separator fall back to the original, never to blank', () => {
  // A future edit to LANE_RULES could drop or rename the anchor. A degraded
  // notification beats one with no text in it at all.
  const noSep = 'LANE RULES (you are a background worker). 1. NEVER use run_in_background.\n\ndo the thing';
  eq(stripLaneRules(noSep), noSep);
});

t('a separator with nothing after it falls back too', () => {
  const empty = `LANE RULES blah\n\n${TASK_SEPARATOR}\n\n   \n`;
  eq(stripLaneRules(empty), empty, 'stripping to whitespace must not produce a blank notice');
});

t('empty and nullish input are safe', () => {
  eq(stripLaneRules(''), '');
  eq(stripLaneRules(null), '');
  eq(stripLaneRules(undefined), '');
});

// ---------------------------------------------------------------------------
// briefTitle
// ---------------------------------------------------------------------------

t('the markdown heading wins — it is the human-written summary', () => {
  const brief = '# Fix: background-lane Telegram notifications\n\nRepo: `x`. Branch `main`.';
  eq(briefTitle(brief), 'Fix: background-lane Telegram notifications');
});

t('a later h1 does not beat the first one', () => {
  eq(briefTitle('# First\n\nbody\n\n# Second'), 'First');
});

t('## is accepted only when the brief has no #', () => {
  eq(briefTitle('## Sub heading only\n\nbody'), 'Sub heading only');
  eq(briefTitle('intro line\n\n## Sub\n\n# Real title'), 'Real title', '# must outrank ## wherever it sits');
});

t('closing hashes are stripped from a closed ATX heading', () => {
  eq(briefTitle('# Title #\n\nbody'), 'Title');
});

t('a brief with no heading falls back to its first non-empty line', () => {
  eq(briefTitle('\n\nRun the full test suite and report what fails.\n\nMore detail below.'), 'Run the full test suite and report what fails.');
});

t('a bare argv one-liner titles as itself', () => {
  eq(briefTitle('run the full test suite and report what fails'), 'run the full test suite and report what fails');
});

t('a long first line prefers a sentence break that fits', () => {
  const line =
    'Rebuild the shared package dist. Then run the gateway and worker suites and report every new failure with its file and line number.';
  const got = briefTitle(line);
  eq(got, 'Rebuild the shared package dist.');
  ok(got.length <= TITLE_MAX, 'sentence cut must respect the cap');
});

t('a long heading is clipped with a visible ellipsis', () => {
  const long = `# ${'verify the notification pipeline end to end '.repeat(6).trim()}`;
  const got = briefTitle(long);
  ok(got.length <= TITLE_MAX, `title exceeded the cap: ${got.length}`);
  ok(got.endsWith('…'), 'a clipped title must show that it was clipped');
});

t('a long unbroken line with no sentence break is clipped, not dropped', () => {
  const got = briefTitle('a'.repeat(400));
  ok(got.length <= TITLE_MAX, `title exceeded the cap: ${got.length}`);
  ok(got.endsWith('…'), 'no ellipsis on a hard cut');
});

t('internal whitespace is collapsed onto one line', () => {
  eq(briefTitle('#   Fix   the\tnotifications  \n\nbody'), 'Fix the notifications');
});

t('empty input yields an empty title rather than throwing', () => {
  eq(briefTitle(''), '');
  eq(briefTitle('\n\n   \n'), '');
  eq(briefTitle(null), '');
});

t('briefTitle after stripLaneRules is what the notice actually shows', () => {
  const composed = queued('# Build: live plan-usage per Claude account\n\ndetails…');
  eq(briefTitle(stripLaneRules(composed)), 'Build: live plan-usage per Claude account');
});

t('the strip is what saves a brief with no heading of its own', () => {
  // The regression, stated as a test. A markdown brief survives without the
  // strip by luck — briefTitle scans every line, so it finds the heading buried
  // under the rules. A brief with NO heading (every argv handoff, and any
  // --file brief that opens with prose) has no such luck: its first non-empty
  // line IS the first line of the lane rules, which is exactly the boilerplate
  // the owner saw on every job.
  const composed = queued('rebuild the shared dist then run the gateway suite');
  ok(composed.startsWith('LANE RULES'), 'guard is inverted — check the fixture');
  eq(briefTitle(composed), 'rebuild the shared dist then run the gateway suite');
  eq(briefTitle(stripLaneRules(composed)), 'rebuild the shared dist then run the gateway suite');
});

// ---------------------------------------------------------------------------
// parseRunId
// ---------------------------------------------------------------------------

t('the close-handler run id yields lane and start time', () => {
  const { lane, startedAt } = parseRunId('bg2-1756678000000');
  eq(lane, 'bg2');
  eq(startedAt, 1756678000000);
});

t('the re-attach registry key (with its pid tail) parses the same way', () => {
  const { lane, startedAt } = parseRunId('bg2-1756678000000-84213');
  eq(lane, 'bg2');
  eq(startedAt, 1756678000000);
});

t('the first worker is named bg, not bg1', () => {
  eq(parseRunId('bg-1756678000000').lane, 'bg');
});

t('an unrecognised or missing id yields nulls, never a guess', () => {
  for (const bad of [null, undefined, '', 'nonsense', 'bg-', 'bg-12']) {
    const r = parseRunId(bad);
    eq(r.lane, null, `lane guessed from ${JSON.stringify(bad)}`);
    eq(r.startedAt, null, `startedAt guessed from ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// handoffNotice
// ---------------------------------------------------------------------------

t('the handoff notice answers which worker, what job, where, how loaded', () => {
  const msg = handoffNotice({
    lane: 'bg2',
    repo: 'claude-telegram-bridge',
    brief: queued('# Build: live plan-usage (5h + weekly) per Claude account\n\nbody'),
    running: 2,
  });
  eq(
    msg,
    [
      '🌙 bg2 · claude-telegram-bridge',
      'Build: live plan-usage (5h + weekly) per Claude account',
      '2 workers running',
      'steer: node bg.mjs steer bg2 "..."',
    ].join('\n'),
  );
});

t('the handoff notice never leads with the lane rules', () => {
  const msg = handoffNotice({ lane: 'bg', repo: 'dev', brief: queued('# Do a thing'), running: 1 });
  ok(!msg.includes('LANE RULES'), `boilerplate leaked into the notice:\n${msg}`);
  ok(!msg.includes('run_in_background'), 'rule text leaked into the notice');
  ok(msg.includes('Do a thing'), 'the job is missing from its own notification');
});

// ---------------------------------------------------------------------------
// The second engine. A Codex run is not a background worker: no bridge context,
// separate billing, no steering. The notice has to say so or the owner reads a
// degraded answer as one of M's own.
// ---------------------------------------------------------------------------

t('a codex handoff is glyph-marked and offers no steer command', () => {
  const msg = handoffNotice({ lane: 'codex', runId: 'codex-1788453512237', repo: 'ops-dash', brief: 'review the diff', running: 1, engine: 'codex' });
  ok(msg.startsWith('🧠 codex · ops-dash'), msg);
  ok(!msg.includes('bg.mjs steer'), 'a steer command on a Codex run would be acked and never delivered');
  ok(msg.includes('engine: codex'), msg);
  ok(msg.includes('not steerable'), msg);
  ok(msg.includes('codex-1788453512237'), 'the run id still has to be there for /status and the report');
});

t('a codex handoff says WHY it is on codex when it was a fallback', () => {
  const msg = handoffNotice({
    lane: 'codex',
    runId: 'codex-1',
    brief: 'x',
    engine: 'codex',
    engineNote: 'every Claude account is limited until 17:40',
  });
  ok(msg.includes('engine: codex (every Claude account is limited until 17:40)'), msg);
});

t('the default engine is claude and its notice is byte-identical to before', () => {
  const withDefault = handoffNotice({ lane: 'bg2', repo: 'r', brief: 'x', running: 1 });
  const explicit = handoffNotice({ lane: 'bg2', repo: 'r', brief: 'x', running: 1, engine: 'claude' });
  eq(withDefault, explicit, 'adding the engine field must not change any existing notice');
  ok(withDefault.startsWith('🌙 '), withDefault);
  ok(withDefault.includes('steer: node bg.mjs steer bg2 "..."'), withDefault);
});

const countLine = (msg) => msg.split('\n').find((l) => /worker[s]? running/.test(l));

t('one worker is singular', () => {
  eq(countLine(handoffNotice({ lane: 'bg', repo: 'dev', brief: 'x', running: 1 })), '1 worker running');
});

t('a queued backlog is shown, zero is not', () => {
  eq(countLine(handoffNotice({ lane: 'bg', repo: 'dev', brief: 'x', running: 3, queued: 2 })), '3 workers running · 2 queued');
  eq(countLine(handoffNotice({ lane: 'bg', repo: 'dev', brief: 'x', running: 3, queued: 0 })), '3 workers running');
});

t('an unknown worker count omits the line instead of guessing', () => {
  const msg = handoffNotice({ lane: 'bg', repo: 'dev', brief: 'x' });
  eq(msg.split('\n').length, 3, `expected three lines, got:\n${msg}`);
  ok(!/worker[s]? running/.test(msg), msg);
});

t('★ the notice names the command that steers this worker instead of killing it', () => {
  // A worker is only redirectable while it runs, and this is the moment the
  // reader still has the option. The lane name has to be the REAL one.
  const msg = handoffNotice({ lane: 'bg3', repo: 'dev', brief: 'x', running: 1 });
  ok(msg.endsWith('steer: node bg.mjs steer bg3 "..."'), msg);
});

t('an unnamed lane prints no steer line rather than a placeholder one', () => {
  const msg = handoffNotice({ brief: 'x', running: 1 });
  ok(!msg.includes('steer:'), `a steer command with no target is worse than none:\n${msg}`);
});

t('missing lane or repo degrade rather than print undefined', () => {
  const msg = handoffNotice({ brief: 'x', running: 1 });
  ok(!/undefined|null/.test(msg), `placeholder leaked: ${msg}`);
  ok(msg.startsWith('🌙 background'), msg);
});

t('an argv one-liner handoff reads as the task itself', () => {
  const msg = handoffNotice({
    lane: 'bg3',
    repo: 'delta-agents',
    brief: queued('rebuild the shared dist then run the gateway suite'),
    running: 1,
  });
  eq(
    msg,
    [
      '🌙 bg3 · delta-agents',
      'rebuild the shared dist then run the gateway suite',
      '1 worker running',
      'steer: node bg.mjs steer bg3 "..."',
    ].join('\n'),
  );
});

// ---------------------------------------------------------------------------
// completionNotice
// ---------------------------------------------------------------------------

t('a finished worker reads as a tick with its elapsed time', () => {
  const msg = completionNotice({
    lane: 'bg2',
    brief: queued('# Build: live plan-usage per Claude account'),
    status: 'finished',
    elapsedSec: 18 * 60,
  });
  eq(msg, '✅ bg2 · Build: live plan-usage per Claude account · 18m');
});

t('a failed worker must never read as a tick', () => {
  const msg = completionNotice({ lane: 'bg', brief: queued('# Ship it'), status: 'failed', elapsedSec: 95 });
  ok(msg.startsWith('❌'), msg);
  ok(msg.includes('failed'), 'the outcome word is missing');
  ok(!msg.includes('✅'), 'a failure showed a tick');
  eq(msg, '❌ bg · Ship it · 1m 35s · failed');
});

t("tonight's auth death, run through the REAL classifier, renders ❌ and not a tick", () => {
  // 2026-08-31: a worker died with this exact result text and bgOutcome's
  // any-text-is-success rule produced "✅ … · 7m 1s". End to end: the shared
  // classifier must call it failed, and this renderer must show that.
  const outcome = bgOutcome(
    ['Failed to authenticate: OAuth session expired and could not be refreshed'],
    { type: 'result', subtype: 'success', is_error: false },
    0,
    '',
  );
  eq(outcome.status, 'failed', 'the classifier still trusts result text over the death it describes');
  const msg = completionNotice({ lane: 'bg', brief: queued('# Nightly audit'), status: outcome.status, elapsedSec: 421 });
  ok(msg.startsWith('❌'), `a dead worker still gets a tick:\n${msg}`);
  ok(!msg.includes('✅'), msg);
});

t('a session-limit death reads as a warning and says so', () => {
  const msg = completionNotice({
    lane: 'bg4',
    brief: queued('# Long audit'),
    status: 'died on a session limit; the bridge handled the account rotation and ran the salvage',
    elapsedSec: 3600 + 120,
  });
  ok(msg.startsWith('⚠️'), msg);
  ok(!msg.includes('✅'), 'a death showed a tick');
  ok(msg.includes('1h 2m'), `elapsed missing: ${msg}`);
  ok(msg.includes('session limit'), 'the reason is missing');
});

t('an unknown elapsed time is omitted, not printed as 0s', () => {
  const msg = completionNotice({ lane: 'bg', brief: '# Thing', status: 'finished', elapsedSec: null });
  eq(msg, '✅ bg · Thing');
});

t('handoff and completion name the same job', () => {
  const brief = queued('# Fix: background-lane Telegram notifications show boilerplate');
  const title = 'Fix: background-lane Telegram notifications show boilerplate';
  ok(handoffNotice({ lane: 'bg2', repo: 'r', brief, running: 1 }).includes(title), 'handoff title drifted');
  ok(completionNotice({ lane: 'bg2', brief, status: 'finished', elapsedSec: 60 }).includes(title), 'completion title drifted');
});

// ---------------------------------------------------------------------------
// workerLine: the one builder for all four phases of a job.
//
// The house-style gates are local copies rather than an import: importing
// system-messages.test.mjs would RUN that suite and double-count it here.
// ---------------------------------------------------------------------------

const LINE_MAX = 44;
const noDashes = (str, where) => {
  const hits = String(str).match(/[–—]/g);
  if (hits) throw new Error(`${where}: ${hits.length} em/en dash(es) in\n${str}`);
};
// THE HEAD IS THE ONE EXEMPTION, and it is bounded rather than waived: it is a
// single scannable row carrying lane, repo, model and effort, and the builder
// itself drops the repo to its own line past HEAD_MAX. Every OTHER line of the
// card still has to fit the bubble.
const linesFit = (str, where) => {
  const all = String(str).split('\n');
  for (const [i, line] of all.entries()) {
    const max = i === 0 ? HEAD_MAX : LINE_MAX;
    if (line.length <= max) continue;
    if (/[~/]/.test(line) || /^["“]/.test(line.trim())) continue; // a path or a quoted title
    throw new Error(`${where}: line of ${line.length} chars (max ${max})\n  ${line}`);
  }
};
// Tokens stay banned everywhere. MODEL NAMES are banned everywhere BUT the
// head, where naming the engine's model is now the point (Zalo, 2026-09-05:
// two running cards that said "Claude" and "Codex" and nothing about what
// either was thinking with). Keeping the ban on every other line is what stops
// a model id drifting into the title or the step line, where it would be noise.
const noTokensOrModels = (str, where) => {
  if (/\b\d[\d,.]*\s*(?:tokens?|tok)\b/i.test(str)) throw new Error(`${where}: token count in\n${str}`);
  const belowHead = String(str).split('\n').slice(1).join('\n');
  if (/\b(?:opus|sonnet|haiku|fable|gpt-[\d.]+|claude-(?:opus|sonnet|haiku|fable|\d)[a-z\d-]*)\b/i.test(belowHead)) {
    throw new Error(`${where}: model name below the head in\n${str}`);
  }
};

const JOB = { lane: 'bg2', repo: 'claude-telegram-bridge', title: 'Fix the engine-switch message', runId: 'bg2-1788453512237' };

t('workerLine: the dispatch frame, exactly as the mock sheet shows it', () => {
  eq(
    workerLine({ ...JOB, phase: 'dispatch', running: 2, queued: 1 }),
    [
      '🌙 bg2 · claude-telegram-bridge',
      'Fix the engine-switch message',
      '⏳ starting… · 2 workers · 1 queued',
      '/steer bg2-1788453512237 <instruction>',
    ].join('\n'),
  );
});

t('workerLine: ★ the running line is the one that ticks, and it carries ONE step', () => {
  eq(
    workerLine({ ...JOB, phase: 'running', elapsedSec: 252, steps: 23, lastAct: '💻 Bash npm test' }),
    ['🌙 bg2 · claude-telegram-bridge', 'Fix the engine-switch message', '⏳ 4m 12s · 23 steps · 💻 Bash npm test'].join('\n'),
  );
  // Not a step LIST: the chat bubble owns that shape. A worker's is a headline.
  const many = workerLine({ ...JOB, phase: 'running', elapsedSec: 60, steps: 9, lastAct: 'x'.repeat(200) });
  eq(many.split('\n').length, 3, 'the line grew into a log');
});

t('workerLine: ★ the head never moves under the reader, only the third line', () => {
  const head = (phase, extra = {}) => workerLine({ ...JOB, phase, ...extra }).split('\n').slice(0, 2).join('\n');
  eq(head('dispatch', { running: 1 }).split('\n')[1], 'Fix the engine-switch message');
  eq(head('running', { elapsedSec: 1 }).split('\n')[1], 'Fix the engine-switch message');
  eq(head('done', { elapsedSec: 1 }).split('\n')[1], 'Fix the engine-switch message');
});

t('workerLine: ★ every ⏳ phase has a terminal state this same builder produces', () => {
  ok(workerLine({ ...JOB, phase: 'dispatch' }).includes('⏳'));
  ok(workerLine({ ...JOB, phase: 'running', elapsedSec: 1 }).includes('⏳'));
  ok(workerLine({ ...JOB, phase: 'done', elapsedSec: 1 }).startsWith('✅'), 'a clean finish');
  ok(workerLine({ ...JOB, phase: 'done', status: 'failed', elapsedSec: 1 }).startsWith('❌'), 'a failure');
  ok(workerLine({ ...JOB, phase: 'done', status: 'died on a session limit' }).startsWith('⚠️'), 'anything else');
});

t('workerLine: the terminal line names the report size, which is what makes "more" a number', () => {
  eq(
    workerLine({ ...JOB, phase: 'done', elapsedSec: 1080, steps: 214, chars: 24180 }).split('\n')[2],
    'Done · 18m · 214 steps · report 24,180 chars',
  );
  eq(
    workerLine({ ...JOB, phase: 'reading', elapsedSec: 1080, steps: 214, chars: 24180 }).split('\n')[2],
    'Done · 18m · 214 steps · reading it now…',
    'while M reads it, the size is not the news',
  );
});

t('workerLine: a Codex job says what it is on instead of offering a steer it cannot take', () => {
  const s = workerLine({ ...JOB, phase: 'dispatch', engine: 'codex', engineNote: 'requested', running: 1 });
  ok(s.startsWith('🧠 '), s);
  ok(s.includes('🧠 codex · requested · not steerable'), s);
  ok(!s.includes('/steer'), 'offering a steer would be a lie that gets acked as delivered');
});

t('workerLine: a scheduled job keeps ⏰ and names the schedule, not a repo it did not choose', () => {
  eq(
    workerLine({ scheduleId: 3, scheduleWhen: 'daily 08:00', title: "Summarize yesterday's commits", phase: 'running', elapsedSec: 72, steps: 14, lastAct: '💻 Bash git log' }),
    ['⏰ #3 · daily 08:00', "Summarize yesterday's commits", '⏳ 1m 12s · 14 steps · 💻 Bash git log'].join('\n'),
  );
});

t('workerLine: everything unknown is omitted rather than guessed', () => {
  eq(workerLine({ lane: 'bg', phase: 'dispatch', runId: null }), '🌙 bg\n⏳ starting…\n/steer bg <instruction>');
  ok(!workerLine({ ...JOB, phase: 'running' }).includes('steps'), 'a stepless run prints no count');
  ok(!workerLine({ ...JOB, phase: 'done' }).includes('report'), 'an unwritten report prints no size');
});

// ---------------------------------------------------------------------------
// The head names the ENGINE: lane, repo, model, effort.
//
// Zalo, 2026-09-05, with a screenshot of two running cards: "🌙 bg · delta-agents"
// and "🧠 bg3 · repo" answered "Claude or Codex" and nothing else, so a worker
// on the wrong model, or one thinking at a lower effort than its sibling, was
// invisible on the one surface whose job is saying what the job is.
// ---------------------------------------------------------------------------

t('workerLine: ★ a Claude card names the pool pin and its effort', () => {
  eq(
    workerLine({ lane: 'bg', repo: 'delta-agents', model: 'opus', effort: 'xhigh', title: 'Audit the send gate', phase: 'running', elapsedSec: 252, steps: 23 }).split('\n')[0],
    '🌙 bg · delta-agents · opus · xhigh',
  );
  // The registry sometimes knows the RESOLVED id rather than the alias. Both
  // are shown as given: the card reports, it does not translate.
  eq(
    workerLine({ lane: 'bg', repo: 'delta-agents', model: 'claude-opus-5', effort: 'xhigh', phase: 'running', elapsedSec: 1 }).split('\n')[0],
    '🌙 bg · delta-agents · claude-opus-5 · xhigh',
  );
});

t('workerLine: ★ a Codex card names the Codex model, and keeps its own glyph', () => {
  eq(
    workerLine({ lane: 'bg3', repo: '90-day-cmaa-game-app', engine: 'codex', model: 'gpt-6-astra', effort: 'high', title: 'Port the install script', phase: 'running', elapsedSec: 252, steps: 23 }).split('\n')[0],
    '🧠 bg3 · 90-day-cmaa-game-app · gpt-6-astra · high',
  );
});

t('workerLine: a Codex run on the CLI\'s own settings says "default" rather than guessing', () => {
  // codexSettings resolves to null when neither /codex model nor config.json
  // sets one; the bridge then omits --model and the CLI picks. "default" is
  // what /account and /engine already print for exactly that state.
  eq(
    workerLine({ lane: 'bg3', repo: 'zalo-os', engine: 'codex', model: 'default', effort: 'default', phase: 'running', elapsedSec: 1 }).split('\n')[0],
    '🧠 bg3 · zalo-os · default · default',
  );
});

t('workerLine: ★ a scheduled card carries the model after the schedule label', () => {
  eq(
    workerLine({ scheduleId: 3, scheduleWhen: 'daily 08:00', model: 'opus', effort: 'xhigh', title: "Summarize yesterday's commits", phase: 'running', elapsedSec: 72, steps: 14 }).split('\n')[0],
    '⏰ #3 · daily 08:00 · opus · xhigh',
  );
  // And the outcome still lands in the head when it finishes.
  ok(workerLine({ scheduleId: 3, scheduleWhen: 'daily 08:00', model: 'opus', effort: 'xhigh', phase: 'done', elapsedSec: 72 }).startsWith('✅ #3 · daily 08:00 · opus · xhigh'));
});

t('workerLine: ★ a re-attached worker shows NOTHING rather than a guess', () => {
  // Survived a daemon restart: the pipe is gone, the spawn record may predate
  // the field, and today's pool pin is not necessarily the one it started on.
  // The failure this locks down is the literal strings "null"/"undefined"
  // reaching his phone, which is what an unguarded template does.
  const s = workerLine({ lane: 'bg', repo: 'delta-agents', title: 'A long job', phase: 'running', elapsedSec: 900, steps: 40 });
  eq(s.split('\n')[0], '🌙 bg · delta-agents');
  ok(!/null|undefined/.test(s), s);
  for (const bad of [{ model: null }, { model: undefined }, { model: '' }, { model: '   ' }]) {
    eq(workerLine({ lane: 'bg', repo: 'r', phase: 'running', elapsedSec: 1, effort: 'xhigh', ...bad }).split('\n')[0], '🌙 bg · r');
  }
});

t('workerLine: an effort with no model is dropped, not shown alone', () => {
  // "🌙 bg · delta-agents · xhigh" reads as if xhigh were the model.
  eq(workerLine({ lane: 'bg', repo: 'delta-agents', effort: 'xhigh', phase: 'running', elapsedSec: 1 }).split('\n')[0], '🌙 bg · delta-agents');
  // A model with no effort is fine: it is not ambiguous, only less complete.
  eq(workerLine({ lane: 'bg', repo: 'delta-agents', model: 'opus', phase: 'running', elapsedSec: 1 }).split('\n')[0], '🌙 bg · delta-agents · opus');
});

t('workerLine: ★ past HEAD_MAX the REPO drops to its own line, never the model', () => {
  const s = workerLine({
    lane: 'bg3',
    repo: 'claude-telegram-bridge',
    engine: 'codex',
    model: 'gpt-5.6-sol-preview',
    effort: 'medium',
    title: 'Port the card change',
    phase: 'running',
    elapsedSec: 5,
  });
  const lines = s.split('\n');
  ok(lines[0].length <= HEAD_MAX, `head is ${lines[0].length} chars: ${lines[0]}`);
  eq(lines[0], '🧠 bg3 · gpt-5.6-sol-preview · medium');
  eq(lines[1], 'claude-telegram-bridge', 'the repo is recoverable on its own line');
  eq(lines[2], 'Port the card change');
  eq(lines[3], '⏳ 5s');
  // The whole point of the rule: what got dropped is the fact already carried
  // by the title under it, not the fact the head was widened to show.
  ok(s.split('\n')[0].includes('gpt-5.6-sol-preview'), s);
});

t('workerLine: a head that still fits keeps the repo where it was', () => {
  const s = workerLine({ lane: 'bg', repo: '90-day-cmaa-game-app', model: 'opus', effort: 'xhigh', title: 'T', phase: 'running', elapsedSec: 1 });
  eq(s.split('\n').length, 3, 'the card must not grow a line it did not need');
  eq(s.split('\n')[0], '🌙 bg · 90-day-cmaa-game-app · opus · xhigh');
});

t('workerLine: ★ every phase passes the house-style gates', () => {
  for (const [phase, extra] of [
    ['dispatch', { running: 4, queued: 2 }],
    ['running', { elapsedSec: 252, steps: 23, lastAct: '💻 Bash npm test' }],
    ['done', { elapsedSec: 1080, steps: 214, chars: 24180 }],
    ['reading', { elapsedSec: 1080, steps: 214 }],
    ['done', { elapsedSec: 1080, status: 'failed' }],
    // The model-bearing shapes, through the same gates: the head exemption is
    // bounded by HEAD_MAX and nothing below it may carry a model.
    ['running', { model: 'opus', effort: 'xhigh', elapsedSec: 252, steps: 23, lastAct: '💻 Bash npm test' }],
    ['dispatch', { engine: 'codex', model: 'gpt-6-astra', effort: 'high', running: 2 }],
    ['done', { model: 'claude-opus-5', effort: 'xhigh', elapsedSec: 1080, chars: 24180 }],
    ['running', { repo: 'claude-telegram-bridge', engine: 'codex', model: 'gpt-5.6-sol-preview', effort: 'medium', elapsedSec: 5 }],
  ]) {
    const str = workerLine({ ...JOB, phase, ...extra });
    noDashes(str, `workerLine/${phase}`);
    linesFit(str, `workerLine/${phase}`);
    noTokensOrModels(str, `workerLine/${phase}`);
  }
});

t('workerLine: 15s and 60s, deliberately not the chat bubble\'s 6s', () => {
  // This reverses a decision made on cost grounds, so the new version has to be
  // CHEAPER than the one that was deleted: 15s against 2.5s is 6x fewer, and an
  // idle worker dedupes down to one edit a minute.
  eq(WORKER_TICK_MS, 15_000);
  eq(WORKER_IDLE_MS, 60_000);
  ok(WORKER_TICK_MS > 6000, 'a worker must be cheaper than the chat bubble, not equal to it');
});

// ---------------------------------------------------------------------------
// Round trip through the REAL bg.mjs — the anti-drift check.
// ---------------------------------------------------------------------------

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-notify-'));
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);
const QUEUE = path.join(TMP, 'bg-queue.json');

function queueThroughRealBg(brief) {
  rmSync(QUEUE, { force: true });
  const p = path.join(TMP, 'brief.md');
  writeFileSync(p, brief);
  execFileSync(process.execPath, [BG, '--file', p], { stdio: 'pipe' });
  return JSON.parse(readFileSync(QUEUE, 'utf8'))[0].text;
}

t("bg.mjs's real header is stripped by this module's real splitter", () => {
  // bg.mjs carries the separator literally (it is a standalone CLI and imports
  // nothing). If someone edits LANE_RULES and changes or drops the anchor, this
  // is the test that fails instead of every notification silently regressing.
  const brief = '# Fix: background-lane Telegram notifications show boilerplate instead of the task\n\nRepo: `x`.';
  const composed = queueThroughRealBg(brief);
  ok(composed.startsWith('LANE RULES'), 'bg.mjs no longer prepends the rules — this test needs rewriting');
  eq(stripLaneRules(composed), brief, 'the real header did not strip cleanly');
});

t('the real round trip renders the notice the owner was promised', () => {
  const composed = queueThroughRealBg(
    '# Fix: background-lane Telegram notifications show boilerplate instead of the task\n\nRepo: `x`.',
  );
  eq(
    handoffNotice({ lane: 'bg2', repo: 'claude-telegram-bridge', brief: composed, running: 2 }),
    [
      '🌙 bg2 · claude-telegram-bridge',
      'Fix: background-lane Telegram notifications show boilerplate instead of the task',
      '2 workers running',
      'steer: node bg.mjs steer bg2 "..."',
    ].join('\n'),
  );
});

t('a real argv handoff still names its task', () => {
  rmSync(QUEUE, { force: true });
  execFileSync(process.execPath, [BG, 'run the full suite and report what fails'], { stdio: 'pipe' });
  const composed = JSON.parse(readFileSync(QUEUE, 'utf8'))[0].text;
  eq(briefTitle(stripLaneRules(composed)), 'run the full suite and report what fails');
});

// ---------------------------------------------------------------------------
// WIRING. Existence is not implementation: these functions could be perfect and
// bridge.mjs could still be sending the old clipped string. So the REAL
// drainBgHandoff and notifyOwnerBgFinished are extracted out of bridge.mjs by
// source (the same trick test.mjs uses — importing bridge.mjs would boot a
// second daemon against the live bot) and run against stubs, and what they
// actually pass to send() is asserted.
// ---------------------------------------------------------------------------

const BRIDGE_SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grabFn(name) {
  const head = new RegExp(`^(?:async )?function ${name}\\b`);
  const start = BRIDGE_SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [BRIDGE_SRC[start]];
  for (let i = start + 1; i < BRIDGE_SRC.length; i++) {
    const l = BRIDGE_SRC[i];
    if (/^\S/.test(l)) {
      if (l.startsWith('}')) out.push(l);
      break;
    }
    out.push(l);
  }
  return out.join('\n');
}

// A top-level `const NAME = ...;` from bridge.mjs, for the one-liners the
// extracted functions close over.
function grabConst(name) {
  const line = BRIDGE_SRC.find((l) => new RegExp(`^const ${name}\\b`).test(l));
  if (!line) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  return line;
}

const NOTIFY_URL = pathToFileURL(path.join(DIR, 'bg-notify.mjs')).href;
const CODEX_URL = pathToFileURL(path.join(DIR, 'bg-codex.mjs')).href;
const ENGINE_URL = pathToFileURL(path.join(DIR, 'engine-state.mjs')).href;
// The lane ALLOCATOR is extracted too, not mirrored. The worker count leans on
// an invariant of the real getBgLane — it only ever hands back a lane that is
// idle, so the job being handed off is always the +1 and never a double count —
// and a mirror of it here would keep agreeing with itself after bridge.mjs
// changed. dispatchPrompt's stub claims lane.current synchronously because the
// real runClaude does, which is what makes a two-item drain count correctly.
const HARNESS = `
import path from 'node:path';
import { handoffNotice, completionNotice, parseRunId, briefRepo, briefTitle, stripLaneRules, workerLine, WORKER_TICK_MS, WORKER_IDLE_MS } from ${JSON.stringify(NOTIFY_URL)};
export const SENT = [];
export const DISPATCHED = [];
export const EDITS = [];
let msgSeq = 0;
const send = (t) => { SENT.push(t); return Promise.resolve({ message_id: ++msgSeq }); };
// The live line, stubbed the way system-wiring.test.mjs stubs it: real builder,
// recorded transport. What matters here is that the drain PUTS one up and the
// close handler edits THAT message rather than sending a second one.
const editProgress = (id, html) => { EDITS.push({ id, html }); return Promise.resolve(); };
const escHtml = (t) => String(t);
export const LIVE = new Set();
const registerLive = (e) => { LIVE.add(e); return e; };
export const BG_PROGRESS_ON = true;
const WORKER_ORPHAN_MS = 120000;
const WORKER_KEEPALIVE_MAX_MS = 1800000;
let editCooldownUntil = 0;
export const setCooldown = (v) => { editCooldownUntil = v; };
let clock = 1788453512237;
const dispatchPrompt = (text, lane) => { DISPATCHED.push({ text, lane: lane && lane.name }); if (SCHED_LANDS_ON_CLAUDE) lane.current = { prompt: text, startedAt: ++clock }; };
// chatState(), not a bare st. The harness used to export st, and the extracted
// drain read st.cwd, so this suite went green while the real daemon threw
// ReferenceError on every handoff (st is a local inside other functions, not a
// module binding) and silently ate a queued job. A harness must not hand the
// code under test a binding that production does not have.
export const chatState = () => ({ cwd: '/Users/owner/dev/claude-telegram-bridge' });
export const bgLanes = [];
let bgSeq = 0;
const BG_TASK_TIMEOUT_MS = 1;
export const reset = (ls = []) => { SENT.length = 0; DISPATCHED.length = 0; EDITS.length = 0; LIVE.clear(); workerNotices.clear(); msgSeq = 0; CODEX_STARTED.length = 0; rotationPausedUntil = 0; codexFallbackValue = true; ENGINE_CFG = {}; CHAT_ENGINE_STATE = {}; bgLanes.length = 0; bgSeq = 0; SAVED.length = 0; SCHED_LANDS_ON_CLAUDE = true; SCHEDULES = { nextId: 1, items: [] }; for (const l of ls) { bgSeq++; bgLanes.push({ name: bgSeq === 1 ? 'bg' : 'bg' + bgSeq, isBg: true, n: bgSeq, current: null, queue: [], ...l }); } };
let queueContent = '[]';
export const setQueue = (v) => { queueContent = JSON.stringify(v); };
const readFileSync = () => queueContent;
const writeFileSync = () => {};
const renameSync = () => {};
const BG_QUEUE_FILE = '/tmp/never-written-bg-queue.json';
// The second engine. Same rule as chatState above: the extracted drain reads
// these as MODULE bindings, so the harness has to provide them by the same
// names production does, and the routing decision itself comes from the REAL
// bg-codex.mjs rather than a mirror that would keep agreeing with itself.
import { parseEnginePrefix, shouldRouteToCodex, codexCwdForBrief, codexReasonText, lintCodexBrief, CODEX_LANE } from ${JSON.stringify(CODEX_URL)};
import { claudeMissingLine, resolveEngine } from ${JSON.stringify(ENGINE_URL)};
const CODEX_MISSING_LINE = 'Codex is not installed';
// The REAL resolver against this harness's state, not a mirror of engineFor:
// a mirror would keep agreeing with itself after engine-state.mjs changed.
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
    codexAvailable: true,
    rotationPausedUntil,
    now: Date.now(),
    codexFallback: codexFallbackValue,
  });
export const CODEX_STARTED = [];
export let rotationPausedUntil = 0;
let codexFallbackValue = true;
export const setLimitWall = (until, fallback = true) => { rotationPausedUntil = until; codexFallbackValue = fallback; };
const codexFallbackOn = () => codexFallbackValue;
const codexRuns = new Map();
const runCodex = (text, opts) => { const runId = 'codex-' + (++clock); CODEX_STARTED.push({ text, runId, ...opts }); return { runId }; };
const DEFAULT_CWD = '/Users/owner/dev';
const existsSync = (p) => p === '/Users/owner/dev/ops-dash';
const OWNER_TZ = 'Europe/Berlin';
// THE CARD RESOLVERS, by the same module-binding names production uses, the
// same rule as chatState above. The drain reads them out of scope to put the
// model on the worker card, so a harness missing them makes every notice throw
// ReferenceError and eat the notification, which is exactly how this suite
// caught them being added. Fixed values rather than the real resolvers: this
// file asserts that the drain PASSES a model through to the card, not how the
// two engines each resolve one.
const claudeCardSettings = () => ({ model: 'opus', effort: 'xhigh' });
const codexCardSettings = () => ({ model: 'gpt-6-astra', effort: 'high' });
// The schedule store, in memory. checkSchedules is extracted rather than
// mirrored for the same reason the drain is: it is the SECOND card call site
// and it had no coverage at all, which is how it came to stamp the Claude pool
// pin on a job that dispatchPrompt had routed to Codex.
export let SCHEDULES = { nextId: 1, items: [] };
export const setSchedules = (items) => { SCHEDULES = { nextId: items.length + 1, items }; };
export const SAVED = [];
const loadSchedules = () => JSON.parse(JSON.stringify(SCHEDULES));
const saveSchedules = (v) => { SAVED.push(v); SCHEDULES = v; };
const localToday = () => '2026-09-05';
const localHHMM = () => '08:30';
// The one lever the schedule test needs: dispatchPrompt claims lane.current for
// a Claude route and leaves it null for a Codex one, which is the ONLY signal
// checkSchedules has about which engine took the job.
export let SCHED_LANDS_ON_CLAUDE = true;
export const setSchedRouting = (v) => { SCHED_LANDS_ON_CLAUDE = v; };
`;
const B = await import(
  'data:text/javascript,' +
    encodeURIComponent(
      [
        HARNESS,
        // The fallback refuses a Claude slash command, so the guard's regex has
        // to come along with the function that consults it.
        grabConst('BG_COMMAND_RE'),
        grabConst('unchosenCodex'),
        grabFn('makeBgLane'),
        grabFn('getBgLane'),
        grabConst('workerNotices'),
        grabFn('startWorkerNotice'),
        grabFn('editWorkerNotice'),
        grabFn('drainBgHandoff'),
        grabFn('notifyOwnerBgFinished'),
        grabFn('checkSchedules'),
        'export { drainBgHandoff, notifyOwnerBgFinished, getBgLane, startWorkerNotice, editWorkerNotice, workerNotices, checkSchedules };',
      ].join('\n'),
    )
);

t('bridge.mjs actually sends the new handoff notice, not the old clip', () => {
  B.reset([{ current: {} }, {}]); // bg busy, bg2 idle
  const composed = queueThroughRealBg('# Fix: background-lane Telegram notifications\n\nbody');
  B.setQueue([{ text: composed, queuedAt: new Date().toISOString() }]);

  B.drainBgHandoff();

  eq(B.SENT.length, 1, 'expected exactly one handoff message');
  eq(
    B.SENT[0],
    [
      // The head names the ENGINE'S MODEL AND EFFORT, from the pool pin the
      // spawn a few lines later puts in argv. The card used to read
      // "🌙 bg2 · claude-telegram-bridge" and answer "Claude or Codex" and
      // nothing else.
      '🌙 bg2 · claude-telegram-bridge · opus · xhigh',
      'Fix: background-lane Telegram notifications',
      '⏳ starting… · 2 workers',
      // The PHONE command. The old notice taught the terminal one to a reader
      // who is holding a phone; `bg.mjs ps` keeps that form, where it belongs.
      '/steer bg2-1788453512238 <instruction>',
    ].join('\n'),
  );
  ok(!B.SENT[0].includes('Handed to the background lane:'), 'the old boilerplate line is still being sent');
  ok(!B.SENT[0].includes('LANE RULES'), 'lane rules still leaking into Telegram');
});

t('the worker still receives the FULL brief, rules included', () => {
  // The notice is cosmetic. Stripping must never reach what is DISPATCHED — the
  // rules exist to stop workers paying the run_in_background tax.
  eq(B.DISPATCHED.length, 1, 'the job was not dispatched');
  ok(B.DISPATCHED[0].text.startsWith('LANE RULES'), 'the worker lost its lane rules');
  ok(B.DISPATCHED[0].text.endsWith('body'), 'the worker lost its task');
  eq(B.DISPATCHED[0].lane, 'bg2', 'dispatched to a different lane than the notice named');
});

// ---------------------------------------------------------------------------
// The SECOND card call site: a scheduled `--run` job.
//
// It had no coverage at all, which is how it came to stamp the Claude pool pin
// on the head of a job dispatchPrompt had handed to Codex.
// ---------------------------------------------------------------------------

t('a scheduled run puts up the same card, with the pool pin on it', () => {
  B.reset([{}]);
  B.setSchedules([{ id: 25, kind: 'daily', at: '08:30', run: true, text: "Summarize yesterday's commits" }]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1, 'the job itself must always be dispatched');
  eq(B.SENT.length, 1);
  eq(B.SENT[0].split('\n')[0], '⏰ #25 · daily 08:30 · opus · xhigh');
});

t('★ a scheduled run that did NOT land on the Claude lane names no model at all', () => {
  // dispatchPrompt re-resolves the engine on EVERY route in, so a bg lane
  // settled to Codex sends this job to runCodex and leaves lane.current null.
  // Stamping BG_MODEL regardless printed "opus · xhigh" over a job Codex was
  // running, on the one line whose purpose is naming the engine.
  B.reset([{}]);
  B.setSchedRouting(false); // routed away: nothing claimed the Claude lane
  B.setSchedules([{ id: 25, kind: 'daily', at: '08:30', run: true, text: "Summarize yesterday's commits" }]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 1, 'the job still runs; only the card is quieter');
  eq(B.SENT[0].split('\n')[0], '⏰ #25 · daily 08:30');
  ok(!/opus|xhigh/.test(B.SENT[0]), B.SENT[0]);
});

t('a plain reminder is still a reminder, with no card and no model', () => {
  B.reset([{}]);
  B.setSchedules([{ id: 4, kind: 'daily', at: '08:30', run: false, text: 'call the accountant' }]);
  B.checkSchedules();
  eq(B.DISPATCHED.length, 0);
  eq(B.SENT.length, 1);
  eq(B.SENT[0], '⏰ Reminder: call the accountant');
});



t('the notice names the same lane the job is dispatched to', () => {
  B.reset([{}]);
  B.setQueue([{ text: 'a one-line job' }]);
  B.drainBgHandoff();
  ok(B.SENT[0].startsWith('🌙 bg · '), B.SENT[0]);
  eq(B.DISPATCHED[0].lane, 'bg');
  ok(B.SENT[0].includes('⏳ starting… · 1 worker'), B.SENT[0]);
});

t('a queued backlog on other lanes reaches the notice', () => {
  B.reset([{ current: {}, queue: ['x', 'y'] }, { current: {} }, {}]);
  B.setQueue([{ text: '# Audit the thing' }]);
  B.drainBgHandoff();
  ok(B.SENT[0].includes('⏳ starting… · 3 workers · 2 queued'), B.SENT[0]);
});

t('two jobs drained together get different lanes and an incrementing count', () => {
  // The count is computed BEFORE dispatch, so the previous item's claim has to
  // already be visible — it is, because runClaude claims lane.current
  // synchronously. Off-by-one here would show "1 worker running" twice.
  B.reset([{}]);
  B.setQueue([{ text: '# First job' }, { text: '# Second job' }]);
  B.drainBgHandoff();
  eq(B.SENT.length, 2);
  ok(B.SENT[0].startsWith('🌙 bg ·'), B.SENT[0]);
  ok(B.SENT[0].includes('⏳ starting… · 1 worker'), B.SENT[0]);
  ok(/^\/steer bg-\d{10,} <instruction>$/.test(B.SENT[0].split('\n').pop()), B.SENT[0]);
  ok(B.SENT[1].startsWith('🌙 bg2 ·'), B.SENT[1]);
  ok(B.SENT[1].includes('⏳ starting… · 2 workers'), B.SENT[1]);
  ok(/^\/steer bg2-\d{10,} <instruction>$/.test(B.SENT[1].split('\n').pop()), B.SENT[1]);
  ok(
    B.SENT[0].split('/steer ')[1] !== B.SENT[1].split('/steer ')[1],
    'two jobs were handed the same steer target',
  );
  eq(B.DISPATCHED.map((d) => d.lane).join(','), 'bg,bg2', 'two jobs landed on the same worker');
  ok(B.SENT[0].includes('First job') && B.SENT[1].includes('Second job'), 'the two notices named the wrong jobs');
});

t('★ the notice names the RUN, not the recycled lane name', () => {
  // Lane names come back: getBgLane hands `bg` to whoever is idle, so a
  // `steer bg` copied out of an old notice lands in whatever job holds the name
  // later, and is acked as delivered. Two jobs on the same lane name must never
  // print the same steer command.
  B.reset([{}]);
  B.setQueue([{ text: '# Job one' }]);
  B.drainBgHandoff();
  const first = B.SENT[0].split('\n').pop();
  B.reset([{}]); // job one finished, the lane is free again
  B.setQueue([{ text: '# Job two' }]);
  B.drainBgHandoff();
  const second = B.SENT[0].split('\n').pop();
  ok(first.startsWith('/steer bg-'), first);
  ok(second.startsWith('/steer bg-'), second);
  ok(first !== second, `the same target was advertised for two different jobs: ${first}`);
});

t('★ the job is dispatched even when composing the notice throws', () => {
  // The drain claims the queue file before it does anything else, so a throw
  // between the claim and the dispatch destroys the brief with no record of it
  // anywhere. That happened once (a ReferenceError in the notice). Dispatching
  // first makes it structural rather than a promise.
  B.reset([{}]);
  B.setQueue([{ text: '# Job that must survive a broken notice' }]);
  const realSend = B.SENT.push.bind(B.SENT);
  B.SENT.push = () => {
    throw new Error('telegram formatting blew up');
  };
  try {
    B.drainBgHandoff();
  } finally {
    B.SENT.push = realSend;
  }
  eq(B.DISPATCHED.length, 1, 'the brief was eaten by a broken notice');
  ok(B.DISPATCHED[0].text.includes('must survive'), B.DISPATCHED[0].text.slice(0, 80));
});

// ---------------------------------------------------------------------------
// ENGINE ROUTING, through the REAL drainBgHandoff. The decision matrix itself
// is asserted in bg-codex.test.mjs; what these prove is that the drain actually
// consults it, dispatches to the right engine, and says which one in the notice.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;

t('an --engine codex item goes to Codex and NEVER to a Claude lane', () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Review the auth diff\n\nRepo: ops-dash', engine: 'codex' }]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'a Codex job must not also start a Claude worker');
  eq(B.CODEX_STARTED.length, 1);
  eq(B.CODEX_STARTED[0].mode, 'edit', 'a handed-off job is work, not a question');
  eq(B.CODEX_STARTED[0].reason, 'explicit');
  eq(B.CODEX_STARTED[0].cwd, '/Users/owner/dev/ops-dash', 'the brief names the repo, so the run is confined to it');
  const notice = B.SENT[0];
  ok(notice.startsWith('🧠 codex'), notice);
  ok(notice.includes('🧠 codex · requested · not steerable'), notice);
  ok(notice.includes('Review the auth diff'), notice);
  ok(!notice.includes('bg.mjs steer') && !notice.includes('/steer'), 'a Codex run cannot be steered');
});

t('a codex: prefix routes the same way and is stripped from the brief', () => {
  B.reset([{}]);
  B.setQueue([{ text: 'codex: summarise the last commit' }]);
  B.drainBgHandoff();
  eq(B.CODEX_STARTED.length, 1);
  eq(B.CODEX_STARTED[0].text, 'summarise the last commit', 'the prefix must not reach the model');
  eq(B.DISPATCHED.length, 0);
});

t('★ with every Claude account walled, an ordinary job runs on Codex instead of waiting', () => {
  B.reset([{}]);
  B.setLimitWall(Date.now() + HOUR, true);
  B.setQueue([{ text: '# Build the report' }]);
  B.drainBgHandoff();
  eq(B.DISPATCHED.length, 0, 'dispatching to Claude here produces a limit death, not work');
  eq(B.CODEX_STARTED.length, 1);
  eq(B.CODEX_STARTED[0].reason, 'claude_limited');
  ok(/🧠 codex · every Claude account is limited/.test(B.SENT[0]), B.SENT[0]);
});

t('/codex off means the wall is waited out, exactly as before', () => {
  B.reset([{}]);
  B.setLimitWall(Date.now() + HOUR, false);
  B.setQueue([{ text: '# Build the report' }]);
  B.drainBgHandoff();
  eq(B.CODEX_STARTED.length, 0, 'the setting is the whole point of the setting');
  eq(B.DISPATCHED.length, 1);
  ok(B.SENT[0].startsWith('🌙 '), B.SENT[0]);
});

t('a healthy bridge routes nothing to Codex on its own', () => {
  B.reset([{}]);
  B.setQueue([{ text: '# An ordinary job' }]);
  B.drainBgHandoff();
  eq(B.CODEX_STARTED.length, 0);
  eq(B.DISPATCHED.length, 1);
});

t('a Codex brief that names no repo falls back to the chat cwd', () => {
  B.reset([{}]);
  B.setQueue([{ text: 'codex: what time is it' }]);
  B.drainBgHandoff();
  eq(B.CODEX_STARTED[0].cwd, '/Users/owner/dev/claude-telegram-bridge', 'the chat cwd is the fallback');
});

t('an empty queue sends nothing at all', () => {
  B.reset([{}]);
  B.setQueue([]);
  B.drainBgHandoff();
  eq(B.SENT.length, 0);
});

t('bridge.mjs actually sends a completion ping, with the real run id', () => {
  B.reset();
  const startedAt = Date.now() - 18 * 60 * 1000;
  B.notifyOwnerBgFinished(queued('# Build: live plan-usage per Claude account'), 'finished', `bg2-${startedAt}`);
  eq(B.SENT.length, 1, 'no completion ping was sent');
  ok(B.SENT[0].startsWith('✅ bg2 · Build: live plan-usage per Claude account · 18m'), B.SENT[0]);
});

t('a re-attached worker (id carries a pid tail) pings identically', () => {
  B.reset();
  const startedAt = Date.now() - 5 * 60 * 1000;
  B.notifyOwnerBgFinished(queued('# Long render'), 'finished', `bg3-${startedAt}-84213`);
  eq(B.SENT[0], '✅ bg3 · Long render · 5m');
});

t('a completion ping with no usable run id still names the job', () => {
  B.reset();
  B.notifyOwnerBgFinished(queued('# Orphaned job'), 'failed', null);
  eq(B.SENT[0], '❌ background · Orphaned job · failed', 'a missing id must degrade, not invent a lane or a duration');
});

// ---------------------------------------------------------------------------
// THE LIVE LINE. One message for the whole job, and the completion ping is that
// same message reaching its terminal state rather than a second one arriving.
// ---------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

// The notice registers a microtask after the drain returns, and every test
// above this line is synchronous, so their registrations are still in flight.
// Let them land BEFORE the first reset here or they arrive inside these cases.
await tick();

await t('★ the dispatch puts up ONE line and keeps it alive', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  eq(B.SENT.length, 1, 'one message for the job');
  eq(B.LIVE.size, 1, 'and it is registered to keep ticking');
});

await t('★ it ticks IN PLACE, and only when the step line changed', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const entry = [...B.LIVE][0];
  const lane = B.bgLanes[0];
  lane.current.steps = 3;
  lane.current.lastAct = '💻 Bash npm test';
  // Far enough past the last edit that a changed body is due.
  entry.lastEditAt = Date.now() - 60_000;
  entry.tick(Date.now());
  eq(B.EDITS.length, 1, 'the first real step is news');
  eq(B.EDITS[0].id, 1, 'it edits the message the dispatch sent, never a new one');
  ok(/⏳ .* · 3 steps · 💻 Bash npm test/.test(B.EDITS[0].html), B.EDITS[0].html);

  // Nothing changed: the clock alone is not worth an edit inside the idle tick.
  entry.lastEditAt = Date.now() - 20_000;
  entry.tick(Date.now());
  eq(B.EDITS.length, 1, 'an idle worker spent an edit on a moving clock');

  // Still nothing changed, but a minute has passed, so the clock is refreshed.
  entry.lastEditAt = Date.now() - 61_000;
  entry.tick(Date.now());
  eq(B.EDITS.length, 2, 'an idle worker must still prove it is alive once a minute');
});

await t('★ the completion is an EDIT, not a second message', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const runId = `bg-${B.bgLanes[0].current.startedAt}`;
  const sentBefore = B.SENT.length;
  B.notifyOwnerBgFinished('# Fix the engine-switch message', 'finished', runId);
  eq(B.SENT.length, sentBefore, 'the old ✅ ping is a second object for one job');
  const last = B.EDITS[B.EDITS.length - 1];
  ok(last.html.startsWith('✅ bg · '), last.html);
  ok(/Done · /.test(last.html), last.html);
});

await t('★ a failure reaches a terminal state too, and it does not read as a tick', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const runId = `bg-${B.bgLanes[0].current.startedAt}`;
  B.notifyOwnerBgFinished('# Fix the engine-switch message', 'failed', runId);
  const last = B.EDITS[B.EDITS.length - 1];
  ok(last.html.startsWith('❌ bg · '), last.html);
  ok(!last.html.includes('✅'), 'a failed job showed a tick');
});

await t('★ the line never edits again after its terminal state', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const entry = [...B.LIVE][0];
  const runId = `bg-${B.bgLanes[0].current.startedAt}`;
  // "reading it now…" is not terminal: there is one more state to reach.
  B.editWorkerNotice(runId, { phase: 'reading', chars: 24180 }, { keepAlive: true });
  ok(/reading it now/.test(B.EDITS[B.EDITS.length - 1].html), B.EDITS[B.EDITS.length - 1].html);
  const midway = B.EDITS.length;
  entry.lastEditAt = 0;
  entry.tick(Date.now());
  eq(B.EDITS.length, midway, 'a sweep wrote a "running" line over the ending');

  B.editWorkerNotice(runId, { phase: 'done' });
  const final = B.EDITS[B.EDITS.length - 1].html;
  ok(/report 24,180 chars/.test(final), `the report size is what makes "there is more" a number: ${final}`);
  const after = B.EDITS.length;
  B.editWorkerNotice(runId, { phase: 'done' });
  entry.tick(Date.now());
  eq(B.EDITS.length, after, 'the line was edited after it was finished with');
  eq(B.workerNotices.size, 0, 'and it is not leaked');
});

await t('★ a job with no run id gets a static frame, never a ticker keyed under null', async () => {
  // dispatchPrompt may route a bg job to Codex instead of the Claude lane the
  // drain resolved, leaving lane.current null. A notice keyed under `null`
  // could never be found by the terminal edit, so the job finished with a
  // frozen ⏳ line AND a second ✅ message.
  B.reset([{}]);
  const before = B.SENT.length;
  await B.startWorkerNotice(null, { lane: 'bg', title: 'x', running: 1 }, () => null);
  eq(B.SENT.length, before + 1, 'the reader still gets told the job was handed over');
  eq(B.LIVE.size, 0, 'nothing may tick for a run this notice cannot see');
  eq(B.workerNotices.size, 0, 'and nothing is keyed under null');
});

await t('★ the read() closure survives a null run rather than killing the line', async () => {
  // `lane.current === run` is TRUE when both are null, so the truthy branch
  // used to dereference null, the sweep caught it, and the line froze at
  // "⏳ starting…" for the life of the chat.
  const lane = { name: 'bg', current: null };
  const run = lane.current;
  const read = () =>
    run && lane.current === run ? { elapsedSec: 1, steps: run.steps || 0, lastAct: null } : null;
  eq(read(), null, 'the guard is what stops the null dereference');
});

await t('★ a stopped worker reaches a terminal state, and it reads as stopped', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const runId = `bg-${B.bgLanes[0].current.startedAt}`;
  // What the close handler's wasStopped arm now does.
  eq(B.editWorkerNotice(runId, { phase: 'done', status: 'stopped', elapsedSec: 252 }), true);
  const last = B.EDITS[B.EDITS.length - 1];
  ok(last.html.startsWith('🛑 bg · '), `his own /stop must not read as a warning: ${last.html}`);
  ok(/Stopped · 4m 12s/.test(last.html), last.html);
  eq(B.workerNotices.size, 0, 'the line was left ticking after /stop');
});

await t('★ the elapsed never goes BACKWARDS between Done and "reading it now"', async () => {
  // lastLive is the last reading taken while the run was alive, up to a tick
  // stale. Merged ON TOP of the terminal patch it dragged "Done · 18m" back to
  // whatever the clock said at the final tick, one line later, on the same
  // message: the reader watches a finished job get younger.
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const entry = [...B.LIVE][0];
  const lane = B.bgLanes[0];
  const runId = `bg-${lane.current.startedAt}`;
  lane.current.steps = 23;
  entry.lastEditAt = 0;
  entry.tick(Date.now()); // lastLive now holds a small elapsed and 23 steps
  B.editWorkerNotice(runId, { phase: 'done', status: 'finished', elapsedSec: 1080 }, { keepAlive: true });
  ok(/Done · 18m · 23 steps/.test(B.EDITS[B.EDITS.length - 1].html), B.EDITS[B.EDITS.length - 1].html);
  B.editWorkerNotice(runId, { phase: 'reading', chars: 24180 }, { keepAlive: true });
  ok(/Done · 18m · 23 steps · reading it now/.test(B.EDITS[B.EDITS.length - 1].html), B.EDITS[B.EDITS.length - 1].html);
  B.editWorkerNotice(runId, { phase: 'done' });
  const final = B.EDITS[B.EDITS.length - 1].html;
  ok(/Done · 18m · 23 steps · report 24,180 chars/.test(final), final);
  // The step count DID come from lastLive: the dispatch frame never had one.
  ok(/23 steps/.test(final), 'lastLive must still fill in what the dispatch frame lacked');
});

await t('★ a keepAlive line is not immortal: it retires if the handback never comes', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const entry = [...B.LIVE][0];
  const runId = `bg-${B.bgLanes[0].current.startedAt}`;
  B.editWorkerNotice(runId, { phase: 'done', status: 'finished', elapsedSec: 1 }, { keepAlive: true });
  eq(entry.done, false, 'there is still one more state to reach');
  entry.tick(Date.now());
  eq(entry.done, false, 'it must wait for M, not retire on the next sweep');
  entry.tick(Date.now() + 31 * 60_000);
  eq(entry.done, true, 'a handback that never lands left an immortal entry per job');
  eq(B.workerNotices.size, 0);
});

await t('★ a 429 pauses the worker line\'s EDITS but never its expiry', async () => {
  B.reset([{}]);
  B.setQueue([{ text: '# Fix the engine-switch message' }]);
  B.drainBgHandoff();
  await tick();
  const entry = [...B.LIVE][0];
  ok(entry.ignoreCooldown, 'the sweep must let this entry through so it can expire');
  const lane = B.bgLanes[0];
  lane.current.steps = 3;
  entry.lastEditAt = 0;
  B.setCooldown(Date.now() + 60_000);
  const before = B.EDITS.length;
  entry.tick(Date.now());
  eq(B.EDITS.length, before, 'it spent an edit inside the penalty');
  B.setCooldown(0);
  entry.tick(Date.now());
  eq(B.EDITS.length, before + 1, 'and it resumes when the penalty is over');
});

await t('a worker that outlived the daemon still gets its own ✅ message', async () => {
  // The ONE case where a fresh message is right: the restart took the
  // message_id with it, so there is nothing on screen left to edit.
  B.reset();
  const startedAt = Date.now() - 5 * 60 * 1000;
  B.notifyOwnerBgFinished('# Long render', 'finished', `bg3-${startedAt}-84213`);
  eq(B.SENT.length, 1, 'the re-attach path went silent');
  eq(B.EDITS.length, 0, 'there was no message to edit');
});

// --- briefRepo -------------------------------------------------------------
// The cwd basename alone is "dev" for every job (this bridge runs from ~/dev),
// so these lock in that the brief's own declaration wins.

t('briefRepo: an explicit Repo: line beats the cwd', () => {
  const brief = '# Some job\n\nRepo: `/Users/owner/dev/claude-telegram-bridge` (branch `main`).\n';
  eq(briefRepo(brief, { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), 'claude-telegram-bridge', 'the declared repo must win');
});

t('briefRepo: bold and tilde forms parse', () => {
  eq(briefRepo('**Repo:** ~/dev/ops-dash\n', { workspaceDir: '/Users/owner/dev' }), 'ops-dash', 'bold + tilde');
  eq(briefRepo('Repository: /Users/owner/dev/delta-agents\n', { workspaceDir: '/Users/owner/dev' }), 'delta-agents', 'long spelling');
});

t('briefRepo: falls back to a workspace path when nothing is declared', () => {
  const brief = '# Job\n\nFix the thing in /Users/owner/dev/second-brain please.\n';
  eq(briefRepo(brief, { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), 'second-brain', 'path in the opening block');
});

t('briefRepo: falls back to the cwd basename when the brief names nothing', () => {
  eq(briefRepo('# Job\n\nJust do a thing.\n', { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev/gym-tracker' }), 'gym-tracker', 'cwd basename');
});

t('briefRepo: the workspace root is not a repo name', () => {
  eq(briefRepo('# Job\n\nnothing here\n', { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), null, '"dev" must never be shown as the repo');
  eq(briefRepo('Repo: ~/dev\n', { workspaceDir: '/Users/owner/dev' }), null, 'a bare workspace root declaration is not a repo');
});

t('briefRepo: ignores paths quoted far down the brief', () => {
  const brief = '# Job\n\nDo a thing.\n' + 'filler\n'.repeat(30) + 'see /Users/owner/dev/oc-maya\n';
  eq(briefRepo(brief, { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), null, 'only the opening block counts');
});

t('briefRepo: strips the LANE RULES preamble first', () => {
  const brief = `LANE RULES (blah)\n\n${TASK_SEPARATOR}\n\n# Job\n\nRepo: ~/dev/black-umbrella\n`;
  eq(briefRepo(brief, { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), 'black-umbrella', 'must see past the rules');
});

t('briefRepo: empty and junk inputs degrade to null, never throw', () => {
  eq(briefRepo('', {}), null, 'empty brief');
  eq(briefRepo(null, {}), null, 'null brief');
  eq(briefRepo('Repo: ../../etc/passwd\n', {}), 'passwd', 'basename only, no traversal in the label');
});

t('handoffNotice: renders the repo the brief names', () => {
  const brief = '# Build the thing\n\nRepo: `/Users/owner/dev/ops-dash`\n';
  eq(
    handoffNotice({ lane: 'bg2', repo: briefRepo(brief, { workspaceDir: '/Users/owner/dev', fallbackDir: '/Users/owner/dev' }), brief, running: 2 }),
    '🌙 bg2 · ops-dash\nBuild the thing\n2 workers running\nsteer: node bg.mjs steer bg2 "..."',
    'the whole line 1 must name the repo, not the workspace',
  );
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg notification tests pass');
