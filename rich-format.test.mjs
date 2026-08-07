// node rich-format.test.mjs
import { mdToRichBlocks, chunkBlocks, shouldUseRich, stripModeMarkers, detailsToHtml } from './rich-format.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n  got  ${a}\n  want ${b}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} ${detail}`);
  }
};

// Stand-in for bridge's mdToTelegramHtml — only bold, enough to prove the
// injection point is used for paragraph text and NOT for headings/cells.
const inline = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

// --- paragraphs -----------------------------------------------------------
eq(
  'plain paragraph',
  mdToRichBlocks('hello world', inline),
  [{ type: 'paragraph', text: 'hello world' }],
);

// Telegram DROPS parse_mode and entities inside blocks, so emitting HTML here
// printed literal "<b>" in the owner's chat. Markers are stripped instead.
eq(
  'paragraph is plain text, never html',
  mdToRichBlocks('a **bold** word', inline),
  [{ type: 'paragraph', text: 'a bold word' }],
);
ok(
  'no block ever carries parse_mode',
  !JSON.stringify(mdToRichBlocks('# H\n\ntext **b**\n\n- i', inline)).includes('parse_mode'),
);

ok(
  'blank line splits paragraphs',
  mdToRichBlocks('one\n\ntwo', inline).length === 2,
);

// --- headings -------------------------------------------------------------
eq(
  'h1 -> size 1',
  mdToRichBlocks('# Title', inline),
  [{ type: 'heading', text: 'Title', size: 1 }],
);
eq(
  'h2 -> size 2',
  mdToRichBlocks('## Title', inline),
  [{ type: 'heading', text: 'Title', size: 2 }],
);
// An unsupported size rejects the entire message, so deep headings clamp.
eq(
  'h6 clamps to 3',
  mdToRichBlocks('###### Deep', inline),
  [{ type: 'heading', text: 'Deep', size: 3 }],
);
// Headings take PLAIN text — HTML would render as literal tags.
eq(
  'heading strips markdown, no html',
  mdToRichBlocks('## A **bold** head', inline),
  [{ type: 'heading', text: 'A bold head', size: 2 }],
);

// --- tables ---------------------------------------------------------------
{
  const b = mdToRichBlocks('| A | B |\n|---|---|\n| 1 | 2 |', inline);
  eq('table is one block', b.length, 1);
  eq('table type', b[0].type, 'table');
  eq('header row flagged', b[0].cells[0], [
    { text: 'A', is_header: true },
    { text: 'B', is_header: true },
  ]);
  eq('body row unflagged', b[0].cells[1], [{ text: '1' }, { text: '2' }]);
}
{
  // Ragged rows must pad, or Telegram gets a jagged grid.
  const b = mdToRichBlocks('| A | B | C |\n|---|---|---|\n| 1 |\n', inline);
  eq('ragged row padded to width', b[0].cells[1].length, 3);
}
{
  // Bold inside a cell is stripped, not converted — cells take plain text.
  const b = mdToRichBlocks('| A |\n|---|\n| **x** |', inline);
  eq('cell strips markdown', b[0].cells[1][0], { text: 'x' });
}

// --- lists ----------------------------------------------------------------
{
  const b = mdToRichBlocks('- one\n- two', inline);
  eq('bullets collapse to one list', b.length, 1);
  eq('list type', b[0].type, 'list');
  eq('two items', b[0].items.length, 2);
  ok('item wraps blocks (not text)', Array.isArray(b[0].items[0].blocks));
  ok('unordered has no ordered flag', b[0].ordered === undefined);
}
{
  const b = mdToRichBlocks('1. one\n2. two', inline);
  eq('numbered list ordered', b[0].ordered, true);
  eq('numbered items', b[0].items.length, 2);
}

// --- details (collapsible) ------------------------------------------------
{
  const b = mdToRichBlocks(':::  details  The evidence\nbody text\n:::', inline);
  eq('details is one block', b.length, 1);
  eq('details type', b[0].type, 'details');
  eq('details uses summary, not title', b[0].summary, 'The evidence');
  eq('details nests blocks', b[0].blocks[0].type, 'paragraph');
}
{
  const b = mdToRichBlocks(':::details\n:::', inline);
  eq('empty details is dropped', b.length, 0);
}
{
  // Content after a details block must not be swallowed.
  const b = mdToRichBlocks(':::  details X\ninner\n:::\nafter', inline);
  eq('text after details survives', b.length, 2);
  eq('…as a paragraph', b[1].text, 'after');
}

// --- code fences ----------------------------------------------------------
{
  const b = mdToRichBlocks('```js\nconst a = 1;\n```', inline);
  eq('fence is one block', b.length, 1);
  ok('fence kept whole', b[0].text.includes('const a = 1;'));
}
{
  // A '#' or '|' inside a fence must not be parsed as heading/table.
  const b = mdToRichBlocks('```\n# not a heading\n| not | a table |\n```', inline);
  eq('fence contents not re-parsed', b.length, 1);
}

// --- chunking -------------------------------------------------------------
{
  const many = Array.from({ length: 50 }, () => ({
    type: 'paragraph',
    text: 'x'.repeat(200),
  }));
  const groups = chunkBlocks(many, 1000);
  ok('splits into several groups', groups.length > 1);
  eq('no block lost', groups.flat().length, 50);
}
{
  const huge = [{ type: 'paragraph', text: 'y'.repeat(9000) }];
  const groups = chunkBlocks(huge, 1000);
  eq('oversized block still ships', groups.flat().length, 1);
}

// --- mixed document -------------------------------------------------------
{
  const doc = [
    '# Report',
    '',
    'Intro line.',
    '',
    '| Metric | Value |',
    '|---|---|',
    '| Plays | 727,873 |',
    '',
    '- first',
    '- second',
    '',
    '::: details Raw numbers',
    'nerd stuff',
    ':::',
  ].join('\n');
  const b = mdToRichBlocks(doc, inline);
  eq(
    'mixed doc block order',
    b.map((x) => x.type),
    ['heading', 'paragraph', 'table', 'list', 'details'],
  );
}

// --- mode selection -------------------------------------------------------
// Rich costs inline bold/code, so it must fire ONLY for what HTML can't do.
ok('plain prose stays HTML', !shouldUseRich('just some **bold** prose'));
ok('headings alone stay HTML', !shouldUseRich('# Title\n\nbody **b**'));
ok('bullets alone stay HTML', !shouldUseRich('- one\n- two'));
ok('a real table goes rich', shouldUseRich('| A | B |\n|---|---|\n| 1 | 2 |'));
// details NO LONGER routes to rich: the HTML path collapses it too, and keeps
// bold/code while doing it. Only a real table is worth leaving HTML for.
ok('a details block stays HTML', !shouldUseRich('::: details X\nbody\n:::'));
// "a | b" in prose is not a table — that false positive would silently strip
// bold from ordinary messages.
ok('pipes in prose are not a table', !shouldUseRich('choose a | b | c'));
ok('header without separator is not a table', !shouldUseRich('| A | B |\n| 1 | 2 |'));
// Explicit override beats the heuristic in both directions.
ok('<!--rich--> forces rich', shouldUseRich('<!--rich-->\nplain prose'));
ok('<!--plain--> forces html', !shouldUseRich('<!--plain-->\n| A |\n|---|\n| 1 |'));
ok('plain marker beats rich marker', !shouldUseRich('<!--rich--><!--plain-->x'));
eq('markers stripped from output', stripModeMarkers('<!--rich-->\nhello'), 'hello');
eq('plain marker stripped too', stripModeMarkers('<!--plain-->\nhello'), 'hello');
ok('stripping leaves normal text alone', stripModeMarkers('hello **x**') === 'hello **x**');

// --- blockquote in rich -------------------------------------------------
{
  const b = mdToRichBlocks('> quoted line\n> second line', inline);
  eq('quote run is one block', b.length, 1);
  eq('quote type', b[0].type, 'blockquote');
  eq('quote nests blocks', b[0].blocks[0].type, 'paragraph');
  eq('marker stripped from quote', b[0].blocks[0].text, 'quoted line\nsecond line');
}
{
  const b = mdToRichBlocks('> quoted\n\nafter', inline);
  eq('text after a quote survives', b.length, 2);
  eq('…as a paragraph', b[1].text, 'after');
}

// --- detailsToHtml (HTML-path collapsible) --------------------------------
const H = (s) => s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');  // stand-in converter
{
  const out = detailsToHtml('::: details My title\nhidden body\n:::', H);
  ok('emits expandable blockquote', out.includes('<blockquote expandable>'));
  ok('title becomes a bold header', out.includes('<b>My title</b>'));
  ok('body is inside', out.includes('hidden body'));
}
{
  // Inline formatting MUST survive inside the collapsed section — that is the
  // entire reason for doing this on the HTML path instead of rich.
  const out = detailsToHtml('::: details T\nkeep **this** bold\n:::', H);
  ok('bold survives inside details', out.includes('<b>this</b>'));
}
{
  // Telegram cannot nest blockquotes; a nested pair rejects the whole message.
  const nested = (s) => `<blockquote>${s}</blockquote>`;
  const out = detailsToHtml('::: details T\nquoted\n:::', nested);
  eq('inner blockquotes flattened', (out.match(/<blockquote/g) || []).length, 1);
}
{
  const out = detailsToHtml('before\n\n::: details T\ninner\n:::\n\nafter', H);
  ok('text before survives', out.includes('before'));
  ok('text after survives', out.includes('after'));
  ok('still exactly one blockquote', (out.match(/<blockquote/g) || []).length === 1);
}
{
  const out = detailsToHtml('just prose, no details', H);
  eq('plain text passes straight through', out, 'just prose, no details');
}
{
  const out = detailsToHtml('::: details Empty\n:::', H);
  eq('empty details produces nothing', out.trim(), '');
}

// ---------- routing must not promise a table the fallback won't draw ----------
// shouldUseRich sends a message down the rich path BECAUSE it found a table,
// paying for it with inline bold and code. If the HTML fallback then disagrees
// about what a table is, a rich failure (or TG_RICH=0) costs the message both.
// Both renderers now share isTableSep, so they agree on the separator rule.
{
  const { renderMdTables } = await import('./md-format.mjs');
  const drawsTable = (src) => renderMdTables(src) !== src;

  const realTable = '| a | b |\n|---|---|\n| 1 | 2 |';
  ok('real table: rich routes it', shouldUseRich(realTable));
  ok('real table: html fallback also draws it', drawsTable(realTable));

  // The regression: TABLE_SEP's pipes are all optional, so a bare `---` matched
  // the regex. rich routed on it; renderMdTables (which required a pipe) did not.
  const thematicBreak = '| a | b |\n---\n| 1 | 2 |';
  ok('bare --- : rich does not route it', !shouldUseRich(thematicBreak));
  ok('bare --- : html does not draw it either', !drawsTable(thematicBreak));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
