// ---------------------------------------------------------------------------
// THE LANE-RULES PREAMBLE, from the daemon's side.
//
// bg.mjs prepends a fixed block of runtime facts to every Claude brief (see the
// LANE_RULES constant there and bg-lane-rules.test.mjs). That block is written
// for the WORKER. It is noise to everyone else: the handoff notice, /status and
// `bg.mjs ps` all describe a running job by its prompt, and a prompt that opens
// with a kilobyte of identical boilerplate makes every worker look the same.
//
// So the daemon strips it back off before it shows a brief to a human, and this
// module owns that operation. It is pure and has no imports on purpose, so the
// anchor it splits on is asserted in a test rather than trusted (bridge.mjs
// cannot be imported by a test: it boots the daemon on import).
//
// The two halves are deliberately NOT one module: bg.mjs imports nothing at all
// (it is copied around and run from anywhere), so it carries the text and this
// carries the anchor. bg-lane-rules.test.mjs round-trips a real brief through
// the real CLI and back through stripLaneRules to prove they still agree.
// ---------------------------------------------------------------------------

// The last line of the preamble, and the first thing that is not part of it.
// Load-bearing: renaming it in bg.mjs without renaming it here puts every
// notification back to boilerplate, silently, with nothing failing.
export const TASK_ANCHOR = '--- TASK ---';

// How a brief announces itself as already carrying the rules. bg.mjs uses the
// same prefix to stay idempotent when a brief is re-queued.
export const LANE_RULES_PREFIX = 'LANE RULES';

/**
 * The JOB, without the preamble bg.mjs prepended to it.
 *
 * Only strips when the text actually opens with the header: a brief that merely
 * quotes the anchor somewhere in its middle keeps every byte. Anything that is
 * not a string comes back as an empty string rather than throwing inside a
 * status view.
 */
export function stripLaneRules(text) {
  const s = String(text ?? '');
  if (!s.startsWith(LANE_RULES_PREFIX)) return s;
  const i = s.indexOf(TASK_ANCHOR);
  if (i === -1) return s; // a header with no anchor: show it rather than eat the job
  return s.slice(i + TASK_ANCHOR.length).replace(/^\s+/, '');
}

/**
 * One line naming the job, for a status row or a worker table.
 *
 * The first non-empty line of the stripped brief, whitespace collapsed and
 * clipped. A brief's first line is its subject far more often than its first N
 * characters are, which is what makes this better than clipping the raw prompt:
 * a markdown brief opens with `# TASK: port the thing`, and that IS the title.
 */
export function briefTitle(text, max = 70) {
  const body = stripLaneRules(text)
    .split('\n')
    .map((l) => l.replace(/^\s*#+\s*/, '').trim())
    .find((l) => l.length > 0);
  const one = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return '(no description)';
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`;
}
