// Markdown -> Telegram HTML, and safe chunking of the result.
//
// SHARED MODULE — byte-identical in the public and private bridge repos.
// scripts/check-shared.sh fails on drift. It owns no paths, no credentials and
// no owner-specific prose: every limit (Telegram's message size) arrives as a
// parameter, so neither repo has to patch a constant to use it.
//
// Telegram's HTML mode is NOT html. Its entire vocabulary is
// b/i/u/s/a/code/pre/blockquote/span/tg-spoiler/tg-emoji — no tables, no
// headings, no nesting of code inside a blockquote. Everything here exists to
// map markdown onto that small set without emitting a tag Telegram will reject,
// because a rejected entity parse costs the WHOLE message its formatting: the
// sender falls back to plain text and the answer arrives as tag soup.

export const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const stripHtml = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// Telegram's HTML has NO table tag, so a markdown table used to reach the phone
// as raw pipe soup with the |---|---| separator sitting there in plain sight.
//
// Reshaped into a titled block per row instead: first cell becomes the bold
// heading, remaining cells become "column: value" lines. Chosen over rendering
// the grid inside <pre>: a fixed-width grid only holds while every row fits the
// screen, and on a phone a 3-column table almost never does — it wraps and the
// columns scramble, which is worse than no table at all.
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-*:?\s*)*\|?\s*$/;
// The ONE definition of "this line separates a table header from its body",
// shared with rich-format.mjs so both renderers agree. Every pipe in TABLE_SEP
// is optional, so the regex alone also matches a bare `---` — which after a
// table row is a thematic break, not a separator. Requiring a literal pipe is
// what distinguishes them, and it is why this is a function and not the raw
// regex: three call sites previously spelled this rule three different ways,
// and rich-format's looser two routed `| a | b |` + `---` to the rich path
// while the HTML fallback declined to draw it — so a rich failure dropped both
// the table AND the inline bold/code the rich path had already traded away.
export const isTableSep = (l) => typeof l === 'string' && l.includes('|') && TABLE_SEP.test(l);
// Require a LEADING pipe: without it any prose line containing "a | b" would be
// read as a table row.
export const isTableRow = (l) => /^\s*\|/.test(l) && /\|/.test(l);
// Split on unescaped pipes only, so a cell may contain a literal \| .
export const splitCells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

export function renderMdTables(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i + 1];
    // header row, separator row, then one or more body rows
    if (isTableRow(lines[i]) && isTableSep(sep)) {
      const headers = splitCells(lines[i]);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && isTableRow(lines[j])) rows.push(splitCells(lines[j++]));
      if (rows.length) {
        for (const cells of rows) {
          const title = cells[0] || '';
          // Bold markdown inside the cell already produced <b>; don't nest it.
          if (title) out.push(title.includes('<b>') ? title : `<b>${title}</b>`);
          for (let k = 1; k < cells.length; k++) {
            const v = cells[k];
            if (!v) continue; // empty cell — the column doesn't apply to this row
            const h = headers[k];
            out.push(h ? `· <i>${h}</i>: ${v}` : `· ${v}`);
          }
          out.push('');
        }
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// The ONE definition of "this is a fenced code block", shared with the rich
// path so both renderers find the same fences. rich-format read fences with its
// own regex and emitted them as PLAIN PARAGRAPHS — backticks stripped, no <pre>
// — so every message taking the rich path (i.e. any message with a table) also
// reached the owner with no code block in it, and therefore nothing for the
// Telegram clients to offer a copy affordance on.
const FENCE = /```([\w-]*)\n?([\s\S]*?)```/g;

/** Render one code block as Telegram's <pre>. The ONE escaping of a fence. */
export function codeHtml(code, lang) {
  const body = escHtml(String(code).replace(/\n$/, ''));
  // Keep the fence language — Telegram syntax-highlights <pre><code class="language-x">.
  return lang ? `<pre><code class="language-${escHtml(lang)}">${body}</code></pre>` : `<pre>${body}</pre>`;
}

// A fresh clone per call: FENCE is global, and both matchAll and replace read
// and advance its lastIndex — sharing the instance across two consumers is a
// stateful coupling that would silently skip the first fence.
const parseFences = (md) =>
  [...String(md).matchAll(new RegExp(FENCE.source, 'g'))].map(([, lang, code]) => ({
    lang: lang || '',
    code: code.replace(/\n$/, ''),
  }));

// Bot API 8.0's InlineKeyboardButton.copy_text: "The text to be copied to the
// clipboard; 1-256 characters". That cap is shorter than most snippets worth
// pasting, so the button is a bonus for SHORT ones only — the <pre> block is
// what makes a snippet of ANY length copyable in the clients, and it is never
// traded away for the button. Two fences get no button either: one button can't
// say which block it copies, and copying the wrong command beats copying none.
export const COPY_TEXT_LIMIT = 256;

/**
 * The copy button for a message, or null when the message doesn't qualify.
 * @returns {{code: string, markup: object}|null}
 */
export function copyButtonFor(md, limit = COPY_TEXT_LIMIT) {
  const found = parseFences(md);
  if (found.length !== 1) return null;
  const { code } = found[0];
  // Never truncate to fit: a button that copies half a command is worse than no
  // button. Length in UTF-16 units is >= the codepoint count, so this stays
  // conservative whichever unit Telegram counts.
  if (!code.trim() || code.length > limit) return null;
  return { code, markup: { inline_keyboard: [[{ text: 'Copy', copy_text: { text: code } }]] } };
}

// Convert Claude's markdown replies to Telegram-HTML (headers→bold, fences→pre,
// inline code, links, bullets, tables). Code spans are extracted first so no
// transform touches their contents. Sender falls back to plain on a parse reject.
export function mdToTelegramHtml(md) {
  const fences = [];
  let t = md.replace(FENCE, (_, lang, code) => {
    fences.push(codeHtml(code, lang));
    return `\u0000${fences.length - 1}\u0000`;
  });
  const inline = [];
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    inline.push(`<code>${escHtml(code)}</code>`);
    return `\u0001${inline.length - 1}\u0001`;
  });
  t = escHtml(t);
  t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  // Italic runs AFTER bold so ** is already consumed. Only *…* — underscores
  // would eat snake_case identifiers in prose. The delimiters must hug
  // non-space, per CommonMark: without that, prose like "3 * 4 and 2 * 5" pairs
  // two unrelated asterisks and italicises everything between them, and a
  // bullet ending in '*' turns into emphasis instead of a list item.
  t = t.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
  // A " inside the URL would break out of the href attribute; &quot; is one of
  // the four named entities Telegram accepts.
  t = t.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label, href) => `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`,
  );
  // After bold/italic/links so cell contents keep their inline formatting, and
  // before the bullet rule — table rows start with '|', never '-', so neither
  // transform can eat the other's input.
  t = renderMdTables(t);
  t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  // Markdown "> quote" — escHtml already turned the marker into &gt;.
  // Consecutive quoted lines collapse into ONE blockquote (they can't nest).
  t = t.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (blk) => {
    const body = blk
      .replace(/\n$/, '')
      .split('\n')
      .map((l) => l.replace(/^&gt;[ \t]?/, ''))
      .join('\n');
    return `<blockquote>${body}</blockquote>\n`;
  });
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => inline[i]);
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => fences[i]);
  return t;
}

// The opening tag of a <pre> still unclosed at the end of `s`, else null. Only
// the two shapes codeHtml emits are matched, so prose that merely mentions a
// tag can't trip it.
function openPre(s) {
  const o = s.lastIndexOf('<pre>');
  if (o === -1 || s.lastIndexOf('</pre>') > o) return null;
  const m = /^<pre>(?:<code[^>]*>)?/.exec(s.slice(o));
  return m ? m[0] : null;
}
const preCloser = (open) => (open.includes('<code') ? '</code></pre>' : '</pre>');
const PRE_TAIL = '</code></pre>'.length;

// Split rendered HTML into sendable pieces. `size` is the caller's limit —
// Telegram's own ceiling lives in the daemon, not here.
//
// A blind slice every `size` chars could land inside `<blockquote expandable>`
// or between <b> and </b>; Telegram then rejects the chunk and the whole message
// degrades to plain text, silently losing all formatting on long answers.
// Prefer a newline boundary, fall back to a space, and only hard-cut when a
// single line genuinely exceeds the limit (e.g. one enormous <pre> block).
//
// `closePre` is for callers passing RENDERED HTML: a code block longer than one
// message used to be cut in half, leaving one chunk with an unclosed <pre> and
// the next with a stray closer — both rejected, both degraded to plain text, so
// the longest snippets (the ones most worth pasting) were exactly the ones that
// lost their code block. With it on, a split <pre> is closed at the boundary and
// reopened with the same tag, so each message carries a whole, valid block.
// Off by default because the daemon also chunks RAW MARKDOWN before rendering
// it, where an unclosed "<pre" can only be prose about a tag.
export function chunks(text, size, { closePre = false } = {}) {
  const out = [];
  let rest = text;
  let carry = ''; // reopening tag owed to the next chunk by a split <pre>
  while (carry.length + rest.length > size) {
    // Reserve room for the closer, so closing a split block can never push the
    // chunk past the limit it was cut to respect. If the tags cannot fit the
    // budget at all (a tiny `size`), keep the block open rather than emit an
    // oversized message: the size limit is the one Telegram enforces.
    const canClose = closePre && size - carry.length - PRE_TAIL > 0;
    const room = Math.max(1, size - carry.length - (canClose ? PRE_TAIL : 0));
    const window = rest.slice(0, room);
    let cut = window.lastIndexOf('\n');
    if (cut < room * 0.5) cut = window.lastIndexOf(' '); // don't strand a tiny chunk
    if (cut < room * 0.5) cut = room; // one unbroken run — hard-cut is the only option
    // Never cut inside a tag: if the boundary sits after an unclosed '<', back
    // up to it so the tag moves whole into the next chunk.
    const open = window.slice(0, cut).lastIndexOf('<');
    if (open > -1 && window.slice(open, cut).indexOf('>') === -1) cut = open;
    // Backing up to `open` can land on 0 (an unclosed '<' at the very start of
    // the window), which would push an empty chunk and leave `rest` untouched —
    // a synchronous infinite loop that freezes the whole daemon, since this
    // while() blocks the event loop. Never accept a non-advancing cut: take the
    // hard cut instead. A tag split this way just makes Telegram reject that
    // chunk, and the caller already falls back to plain text for it.
    if (cut <= 0) cut = room;
    let chunk = carry + rest.slice(0, cut);
    carry = '';
    if (canClose) {
      const open = openPre(chunk);
      if (open) {
        chunk += preCloser(open);
        carry = open;
      }
    }
    out.push(chunk);
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest || carry) out.push(carry + rest);
  return out.length ? out : [''];
}
