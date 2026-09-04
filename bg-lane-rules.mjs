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
  const rest = s.slice(i + TASK_ANCHOR.length).replace(/^\s+/, '');
  return rest || s; // anchor present but nothing after it: same rule
}

// Roughly two phone lines. Long enough for a real headline, short enough that
// the lane name and elapsed time on the same row are never pushed off-screen.
export const TITLE_MAX = 90;

// First ATX heading of the given level, hashes and any closing hashes stripped.
function atxHeading(lines, level) {
  const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
  for (const raw of lines) {
    const m = re.exec(raw.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const clipTo = (s, max) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}\u2026`);

/**
 * One line naming the job, for a status row or a worker table.
 *
 * The preamble comes off first, so this is safe on a raw queued brief. After
 * that, precedence:
 *   1. the first `# ` heading (or `## ` if the brief has no `# `), hashes off.
 *      A brief handed over with --file is markdown and its author wrote that
 *      heading AS the one-line summary, which beats any character clip;
 *   2. otherwise the first non-empty line;
 *   3. otherwise, when that line overflows, its first sentence if it fits.
 *
 * Empty in, empty out: a renderer that wants a placeholder supplies its own,
 * and workerLine deliberately omits a line it cannot fill.
 */
export function briefTitle(text, max = TITLE_MAX) {
  const lines = stripLaneRules(text).split('\n');
  const heading = atxHeading(lines, 1) || atxHeading(lines, 2);
  if (heading) return clipTo(oneLine(heading), max);

  const first = lines.map(oneLine).find((l) => l.length > 0);
  if (!first) return '';
  if (first.length <= max) return first;

  // One long unbroken line (an argv one-liner, a paragraph). A sentence break
  // is a better cut than a word break when one lands inside the budget.
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)?.[1];
  if (sentence && sentence.length <= max) return sentence;
  return clipTo(first, max);
}

// How far into a brief to look for its repo. Far enough to clear a title, a
// blank line and an opening paragraph; not so far that a repo mentioned in
// passing on page two outranks the one the job is about.
export const REPO_LOOKAHEAD_LINES = 12;

/**
 * Which repo a brief is ABOUT, by name, or null.
 *
 * This decides where a Codex job is allowed to write: `--sandbox workspace-write`
 * is rooted at one directory, so a brief about repo X handed over while the chat
 * is pointed at repo Y must run in X or it cannot do the job at all (and may
 * edit same-named files in the wrong tree).
 *
 * Order: an explicit "Repo:" line wins, then a workspace path in the opening
 * block, then the basename of the fallback directory. Returns null rather than
 * a guess, and the caller decides what a null means.
 *
 * `workspaceDir` is the root the daemon keeps checkouts under, injected rather
 * than assumed: this module owns no paths. Its basename is also the one name a
 * path match must NOT return, because "~/work" names the workspace, not a repo
 * inside it.
 */
export function briefRepo(text, { workspaceDir = null, fallbackDir = null } = {}) {
  const head = stripLaneRules(text).split('\n').slice(0, REPO_LOOKAHEAD_LINES).join('\n');
  const root = String(workspaceDir || '').split('/').filter(Boolean).pop() || null;
  const clean = (v) => {
    const base = String(v || '')
      .replace(/[`'"*]/g, '')
      .replace(/[.,;:)\]]+$/, '')
      .split('/')
      .filter(Boolean)
      .pop();
    if (!base || !/^[\w.-]{1,60}$/.test(base)) return null;
    return base === root ? null : base; // the workspace root names no repo
  };
  const declared = head.match(/^[\s>*-]*(?:\*\*)?repo(?:sitory)?(?:\*\*)?\s*:\s*(\S+)/im);
  if (declared) {
    const named = clean(declared[1]);
    if (named) return named;
  }
  // A path UNDER the workspace root, written either absolutely or with ~. Built
  // from workspaceDir so a machine that keeps its checkouts somewhere other than
  // ~/dev is matched too, and escaped so a root with a regex character in it
  // cannot change what this matches.
  if (root) {
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inPath = head.match(new RegExp(`(?:~|/[\\w./-]*?)/${esc}/([\\w.-]+)`));
    if (inPath) {
      const named = clean(inPath[1]);
      if (named) return named;
    }
  }
  return fallbackDir ? clean(fallbackDir) : null;
}
