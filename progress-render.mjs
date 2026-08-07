// The progress bubble — turning a stream of Claude Code steps into one
// scannable Telegram message.
//
// SHARED MODULE — byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. Nothing here reads a global: the home
// directory used to shorten paths arrives as an argument, and the "thinking"
// word list is a parameter with a neutral default, because that list is
// presentation and each deployment is entitled to its own voice.
//
// Everything renders twice — once as HTML, once as plain text — because the
// caller falls back to plain when Telegram rejects an entity parse. Keep both
// branches of every function in step, or the fallback silently loses content.

import { escHtml } from './md-format.mjs';

// Truncate for display. ALWAYS marks the cut with an ellipsis — a clipped
// string with no marker reads on the phone as a message that got lost in
// transit rather than one deliberately previewed. Cuts on a word boundary when
// one sits reasonably close to the limit (past 60% of the window), else hard.
// Every user-visible truncation goes through here; never raw .slice() into a
// send() — that is what made the background-handoff ack look broken.
export const clip = (s, n) => {
  const str = String(s);
  if (str.length <= n) return str;
  const head = str.slice(0, n - 1);
  const sp = head.lastIndexOf(' ');
  return (sp > n * 0.6 ? head.slice(0, sp) : head).trimEnd() + '…';
};

// Collapse newlines/runs of spaces so a multi-line agent prompt previews as one
// readable line instead of dumping its raw formatting into the chat.
export const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// Absolute paths eat a whole phone line and the identifying part is the tail.
//   <home>/src/my-project/inbox/photo.jpg -> …/inbox/photo.jpg
// `home` is passed in rather than read from the environment: this module has no
// business knowing whose machine it runs on, and the tests need to vary it.
export function prettyPath(p, home = '') {
  const str = String(p);
  const s = home && str.startsWith(home) ? `~${str.slice(home.length)}` : str;
  const parts = s.split('/');
  return parts.length > 4 ? `…/${parts.slice(-2).join('/')}` : s;
}

export function summarizeToolInput(input, home = '') {
  if (!input || typeof input !== 'object') return '';
  // `description` is written FOR a human — prefer it over every raw payload.
  // A Bash `command` is shell scaffolding (echo banners, absolute paths, 2>&1)
  // that reads as noise on a phone; an Agent `prompt` is enormous. Both carry a
  // tidy description, so this one reorder is most of the readability win.
  if (input.description) return clip(String(input.description).replace(/\s+/g, ' '), 70);
  const file = input.file_path ?? input.notebook_path;
  if (file) return clip(prettyPath(file, home), 70);
  const pick = input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
  if (pick == null) return '';
  return clip(String(pick).replace(/\s+/g, ' '), 70);
}

export const TOOL_EMOJI = {
  Bash: '💻',
  Read: '📖',
  Write: '✏️',
  Edit: '✏️',
  MultiEdit: '✏️',
  NotebookEdit: '📓',
  Grep: '🔍',
  Glob: '🔍',
  WebSearch: '🌐',
  WebFetch: '🌐',
  TodoWrite: '📋',
};

export function toolEntry(block, isSubagent, home = '') {
  if (block.name === 'Task' || block.name === 'Agent') {
    return {
      kind: 'tool',
      sub: isSubagent,
      emoji: '🤖',
      name: block.input?.subagent_type || 'agent',
      arg: block.input?.description || '',
    };
  }
  return {
    kind: 'tool',
    sub: isSubagent,
    emoji: TOOL_EMOJI[block.name] || '🔧',
    name: block.name,
    arg: summarizeToolInput(block.input, home),
  };
}

export function renderEntry(e, html) {
  // Narration between tool calls is written for the final answer, not for a
  // progress ticker — a full paragraph per step is what turns this into a wall.
  if (e.kind === 'text') {
    const t = clip(e.text.replace(/\s+/g, ' '), 140);
    return html ? `<i>${escHtml(t)}</i>` : t;
  }
  const indent = e.sub ? '  ↳ ' : '';
  // No <code> around the arg: these lines live inside a blockquote, and code/pre
  // entities may not nest there — Telegram rejects the whole message.
  if (html) return `${indent}${e.emoji} <b>${escHtml(e.name)}</b>${e.arg ? ` ${escHtml(e.arg)}` : ''}`;
  return `${indent}${e.emoji} ${e.name}${e.arg ? ` ${e.arg}` : ''}`;
}

// The step log is reference material, not the message — collapse it behind
// Telegram's expandable blockquote so the bubble stays one scannable header.
// Only <b>/<i> go inside: the spec lets those nest in any entity, while <code>
// and <pre> may not, and blockquotes can never nest.
export const quoteBlock = (body) => (body ? `\n<blockquote expandable>${body}</blockquote>` : '');

// Newest-first fill so the tail always fits without slicing mid-HTML-tag.
export function renderTail(entries, html, maxChars) {
  const out = [];
  let len = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = renderEntry(entries[i], html);
    if (len + line.length + 1 > maxChars) break;
    out.unshift(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

// A static "Working in <dir>" header looked identical on every run and on every
// refresh, so a live run was indistinguishable from a frozen one. These cycle as
// the run progresses — motion is the signal that something is alive.
//
// Deliberately neutral: the daemon passes its own list, and this default only
// has to be inoffensive, not characterful.
export const DEFAULT_THINKING_WORDS = [
  'Thinking', 'Working', 'Reading', 'Searching', 'Planning', 'Checking',
  'Building', 'Testing', 'Reviewing', 'Writing', 'Tracing', 'Finishing',
];

// Callers seed `i` randomly so back-to-back runs don't open on the same word,
// then step it sequentially so a single run never repeats until it has used
// them all. Guards an empty list: '' beats a crash in the progress path.
export const thinkingWord = (i, words = DEFAULT_THINKING_WORDS) =>
  words.length ? words[((i % words.length) + words.length) % words.length] : '';

// Elapsed run time for humans: 45s · 6m 19s · 1h 12m.
export function fmtElapsed(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

export function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
