#!/usr/bin/env node
// Tests for engine-handoff.mjs: the exchange ring, the paths a turn touched,
// and (from the next commit) the handoff itself.
//
// Everything here is pure, which is the point: a handoff must be producible
// with ZERO model calls, so the thing that produces it has to be assertable
// with no daemon, no binary and no spend.
//
//   node engine-handoff.test.mjs

import {
  HANDOFF_CAPS,
  HANDOFF_END,
  HANDOFF_START,
  HANDOFF_STALE_MS,
  RING_MAX,
  RING_TEXT_MAX,
  buildHandoff,
  capHandoff,
  capRing,
  handoffAge,
  filterProsePaths,
  handoffBits,
  handoffLine,
  isStaleHandoff,
  parseHandoffJson,
  redactHandoff,
  renderHandoffBlock,
  resolveHandoffSource,
  unavailableTools,
  unreachablePaths,
  pathsFromCodexLog,
  pathsFromText,
  pathsFromToolInput,
  unavailableToolLabels,
  ringEntry,
  ringForChat,
} from './engine-handoff.mjs';

let pass = 0;
const failures = [];
const t = (name, fn) => {
  try {
    fn();
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

// ---------------------------------------------------------------------------
console.log('\n1. the exchange ring');
// ---------------------------------------------------------------------------

t('a row has a fixed shape, whatever it is handed', () => {
  const e = ringEntry({ engine: 'codex', role: 'assistant', text: '  hello\n  there ', chat: 42, ts: 1788000000000 });
  eq(e.engine, 'codex');
  eq(e.role, 'assistant');
  eq(e.text, 'hello there', 'newlines in a ring row make the file unparseable line by line');
  eq(e.chat, '42');
  eq(e.ts, 1788000000000);
  ok(Array.isArray(e.paths));
});

t('an unknown engine or role falls back rather than being written through', () => {
  const e = ringEntry({ engine: 'gpt', role: 'system', text: 'x' });
  eq(e.engine, 'claude');
  eq(e.role, 'user');
});

t(`text is clipped to ${RING_TEXT_MAX}: a ring is not a transcript`, () => {
  const e = ringEntry({ text: 'x'.repeat(5000) });
  ok(e.text.length <= RING_TEXT_MAX + 1, `${e.text.length} chars`);
  ok(e.text.endsWith('…'), e.text.slice(-5));
});

t('★ a credential SHAPE in a chat turn is redacted before the ring is written', () => {
  // The ring is a new on-disk record of the conversation. A live proof run put
  // two credential-shaped strings into it: the handoff scrubbed them on the way
  // to state.json while chat-ring.jsonl kept them raw.
  const secret = ['eyJ', 'hbGciOiJIUzI1NiJ9.body.sig'].join('');
  const e = ringEntry({ text: `the key is ${secret} and that is that` });
  ok(!e.text.includes(secret), e.text);
  ok(e.text.includes('[redacted]'), e.text);
  ok(e.text.includes('the key is'), 'the surrounding words are the value of the row');
});

t('paths are deduped, absolute-only, and bounded', () => {
  const e = ringEntry({ paths: ['/a/b.ts', '/a/b.ts', 'relative/x.ts', '', null, ...Array.from({ length: 20 }, (_, i) => `/p/${i}`)] });
  eq(e.paths[0], '/a/b.ts');
  ok(!e.paths.includes('relative/x.ts'), 'a relative path means nothing without the cwd it was relative to');
  ok(e.paths.length <= 10, `${e.paths.length} paths`);
  eq(new Set(e.paths).size, e.paths.length, 'duplicates');
});

t(`★ the cap is PER CHAT: ${RING_MAX} rows each, and one chat never evicts another`, () => {
  // This is the whole reason the ring is its own file. bg-results.jsonl keeps
  // the last 50 rows across EVERY producer, so a busy Codex chat evicted the
  // background job history the owner asks about later.
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ringEntry({ chat: 'A', text: `a${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ringEntry({ chat: 'B', text: `b${i}` })),
  ];
  const kept = capRing(rows);
  eq(ringForChat(kept, 'A').length, RING_MAX);
  eq(ringForChat(kept, 'B').length, 3, 'a quiet chat was evicted by a loud one');
  eq(ringForChat(kept, 'A')[RING_MAX - 1].text, 'a29', 'the ring kept the OLDEST rows');
});

t('ringForChat returns oldest first, and an unknown chat is empty rather than an error', () => {
  const rows = [ringEntry({ chat: '1', text: 'first' }), ringEntry({ chat: '1', text: 'second' })];
  eq(ringForChat(rows, '1')[0].text, 'first');
  eq(ringForChat(rows, 'nope').length, 0);
  eq(ringForChat(null, '1').length, 0);
  eq(capRing(null).length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n2. which files a turn touched');
// ---------------------------------------------------------------------------

t('a tool block names its file through the schema field', () => {
  eq(pathsFromToolInput({ file_path: '/Users/z/dev/x/foo.ts' })[0], '/Users/z/dev/x/foo.ts');
  eq(pathsFromToolInput({ notebook_path: '/Users/z/n.ipynb' })[0], '/Users/z/n.ipynb');
  eq(pathsFromToolInput({ file_path: 'src/relative.ts' }).length, 0, 'relative is not resolvable here');
  eq(pathsFromToolInput(null).length, 0);
  eq(pathsFromToolInput('nope').length, 0);
});

t('a Bash cwd is a structured field too: the tool stated it', () => {
  eq(pathsFromToolInput({ command: 'ls', cwd: '/Users/z/dev/x' })[0], '/Users/z/dev/x');
});

t('★ a Bash command is scanned, because that is where the real file activity is', () => {
  const real = new Set(['/Users/z/dev/bridge/bg-codex.test.mjs', '/tmp/out.log']);
  const got = pathsFromToolInput(
    { command: 'node /Users/z/dev/bridge/bg-codex.test.mjs && cat /tmp/out.log' },
    { exists: (p) => real.has(p) },
  );
  ok(got.includes('/Users/z/dev/bridge/bg-codex.test.mjs'), JSON.stringify(got));
  ok(got.includes('/tmp/out.log'), JSON.stringify(got));
});

t('★ but a path SCANNED out of a command must exist: a grep pattern is not a file', () => {
  // The exact command that put eight slash commands on a switch confirmation.
  const got = pathsFromToolInput(
    { command: 'grep -n "/usage|/account|/status|/stop|/compact|/review" bridge.mjs' },
    { exists: () => true, commands: ['usage', 'account', 'status', 'stop', 'compact', 'review'] },
  );
  eq(got.length, 0, JSON.stringify(got));
});

t('★ the structured field is kept even when the file is gone; only text needs proof', () => {
  // An Edit whose file was later deleted still happened, and the handoff saying
  // so is right. A string that merely looks like a path never did.
  const got = pathsFromToolInput({ file_path: '/Users/z/deleted.ts', command: 'cat /Users/z/also-gone.ts' }, { exists: () => false });
  eq(got.length, 1, JSON.stringify(got));
  eq(got[0], '/Users/z/deleted.ts');
});

t('★ with no way to check the disk, a scanned path is dropped rather than guessed', () => {
  eq(pathsFromToolInput({ command: 'cat /Users/z/real.ts' }).length, 0, 'the safe direction is out');
});

t('trailing punctuation is not part of a filename', () => {
  const got = pathsFromText('open /a/b/c.ts; then /d/e.ts, then (/f/g.ts)');
  ok(got.includes('/a/b/c.ts'), JSON.stringify(got));
  ok(got.includes('/d/e.ts'), JSON.stringify(got));
  ok(got.includes('/f/g.ts'), JSON.stringify(got));
});

t('a bare slash and a two-character root are never files anyone edited', () => {
  eq(pathsFromText('cd / && ls /x').length, 0);
  eq(pathsFromText('').length, 0);
  eq(pathsFromText(null).length, 0);
});

t('★ a Codex run log gives up its paths from its own command_execution events', () => {
  const log = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"command_execution","command":"sed -n 1,40p /Users/z/dev/x/engine-state.mjs"}}',
    '{"type":"item.completed","item":{"type":"file_change","changes":{"/Users/z/dev/x/bridge.mjs":{"kind":"edit"}}}}',
    'not json at all, this is stderr',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');
  const got = pathsFromCodexLog(log, { exists: (p) => p.endsWith('engine-state.mjs') });
  ok(got.includes('/Users/z/dev/x/engine-state.mjs'), JSON.stringify(got));
  // The file_change item names its own file: no existence proof needed.
  ok(got.includes('/Users/z/dev/x/bridge.mjs'), JSON.stringify(got));
});

t('★ a Codex command that merely MENTIONS a path does not add one', () => {
  const log = '{"type":"item.completed","item":{"type":"command_execution","command":"grep -rn \'/usage\' ."}}';
  eq(pathsFromCodexLog(log, { exists: () => true, commands: ['usage'] }).length, 0);
});

t('a log that is garbage yields nothing and throws nothing: best effort, never wrong', () => {
  eq(pathsFromCodexLog('').length, 0);
  eq(pathsFromCodexLog(null).length, 0);
  eq(pathsFromCodexLog('{{{{').length, 0);
  eq(pathsFromCodexLog('{"type":"item.completed"}').length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n3. the caps, and the order they bite in');
// ---------------------------------------------------------------------------

const bigHandoff = () => ({
  from: 'claude',
  at: Date.now(),
  cwd: '/Users/z/dev/x',
  sandbox: 'workspace-write + network',
  goal: 'g'.repeat(1000),
  open: 'o'.repeat(1000),
  decisions: Array.from({ length: 12 }, (_, i) => `d${i} ` + 'x'.repeat(400)),
  paths: Array.from({ length: 25 }, (_, i) => `/Users/z/dev/x/file-${i}-` + 'y'.repeat(400) + '.ts'),
  tools: Array.from({ length: 20 }, (_, i) => `tool-${i}-` + 'z'.repeat(100)),
});

t('★ every field cap is enforced', () => {
  const h = capHandoff(bigHandoff());
  ok(h.goal.length <= HANDOFF_CAPS.goal + 1, `goal ${h.goal.length}`);
  ok(h.open.length <= HANDOFF_CAPS.open + 1, `open ${h.open.length}`);
  ok(h.decisions.length <= HANDOFF_CAPS.decisions.items, `${h.decisions.length} decisions`);
  for (const d of h.decisions) ok(d.length <= HANDOFF_CAPS.decisions.chars + 1, `decision ${d.length}`);
  ok(h.paths.length <= HANDOFF_CAPS.paths.items, `${h.paths.length} paths`);
  ok(h.tools.length <= HANDOFF_CAPS.tools.items, `${h.tools.length} tools`);
  for (const tl of h.tools) ok(tl.length <= HANDOFF_CAPS.tools.chars + 1, `tool ${tl.length}`);
});

t('★ the truncation ORDER is paths, then decisions, then tools, then goal and open', () => {
  const h = capHandoff(bigHandoff());
  // Everything is individually legal above and STILL over 4000 serialized, so
  // something had to go. Paths are the longest and the most reconstructible
  // (the incoming engine can look); the goal is the one thing without which the
  // rest means nothing.
  ok(h.paths.length < HANDOFF_CAPS.paths.items, `paths were not the first to go: ${h.paths.length}`);
  eq(h.decisions.length, HANDOFF_CAPS.decisions.items, 'decisions were dropped before paths ran out');
  ok(h.goal.length > 100, `the goal was cut while paths were still there: ${h.goal.length}`);
});

t('★ the 4000-char serialized cap holds even when every field is individually legal', () => {
  const legal = {
    from: 'claude',
    at: Date.now(),
    cwd: '/Users/z/dev/x',
    sandbox: 'workspace-write + network',
    goal: 'g'.repeat(HANDOFF_CAPS.goal),
    open: 'o'.repeat(HANDOFF_CAPS.open),
    decisions: Array.from({ length: HANDOFF_CAPS.decisions.items }, (_, i) => `${i}` + 'd'.repeat(HANDOFF_CAPS.decisions.chars - 1)),
    paths: Array.from({ length: HANDOFF_CAPS.paths.items }, (_, i) => `/p/${i}/` + 'x'.repeat(HANDOFF_CAPS.paths.chars - 8)),
    tools: Array.from({ length: HANDOFF_CAPS.tools.items }, (_, i) => `${i}` + 't'.repeat(HANDOFF_CAPS.tools.chars - 1)),
  };
  // 300 + 300 + 5x200 + 10x200 + 8x40 is already over 4000 before the keys.
  ok(JSON.stringify(legal).length > HANDOFF_CAPS.serialized, 'the fixture is not actually over the cap');
  const h = capHandoff(legal);
  ok(JSON.stringify(h).length <= HANDOFF_CAPS.serialized, `${JSON.stringify(h).length} chars serialized`);
});

t('a pathological cwd still leaves a serialized object under the cap', () => {
  const h = capHandoff({ cwd: '/' + 'x'.repeat(9000), goal: 'g'.repeat(400), open: 'o'.repeat(400) });
  ok(JSON.stringify(h).length <= HANDOFF_CAPS.serialized, `${JSON.stringify(h).length} chars`);
});

// ---------------------------------------------------------------------------
console.log('\n4. redaction, and the slash that could have been a command');
// ---------------------------------------------------------------------------

// SHAPES, assembled at runtime from parts. Each one matches a TOKEN_SHAPES
// entry; none is a credential, and none is written into this file as a literal,
// because a repo full of key-shaped strings is a repo whose secret scanners
// stop being believed.
const shape = (...parts) => parts.join('');
const SECRETS = {
  jwt: shape('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'),
  'sk-': shape('sk', '-', 'proj-AbCdEfGhIjKlMnOpQrSt'),
  'sk_': shape('sk', '_', 'AbCdEfGhIjKlMnOpQrSt'),
  'rt_': shape('rt', '_', 'AbCdEfGhIjKlMnOpQrSt'),
  'ghp_': shape('ghp', '_', 'AbCdEfGhIjKlMnOpQrSt'),
};

t('★ a credential in ANY of the fields is redacted, in what is STORED and in what is rendered', () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    const h = capHandoff(
      redactHandoff({
        from: 'claude',
        at: Date.now(),
        cwd: `/Users/z/dev/${secret}`,
        sandbox: `workspace-write ${secret}`,
        goal: `wire ${secret} into the client`,
        open: `does ${secret} still work`,
        decisions: [`we used ${secret}`],
        paths: [`/Users/z/dev/x/${secret}.ts`],
        tools: [secret],
      }),
    );
    const stored = JSON.stringify(h);
    ok(!stored.includes(secret), `${name} survived into what gets written to state.json: ${stored.slice(0, 200)}`);
    const rendered = renderHandoffBlock(h, { toEngine: 'codex', cwd: '/Users/z/dev' });
    ok(!rendered.includes(secret), `${name} survived into the injected block`);
    ok(stored.includes('[redacted]'), `${name} was dropped rather than redacted: ${stored.slice(0, 200)}`);
  }
});

t('★ a leading slash is stripped from goal and from every decision', () => {
  // Otherwise a handoff prepended to a message could carry a slash command into
  // dispatchPrompt, which routes on exactly that.
  const h = capHandoff({ goal: '/autopilot ship the payments refactor', decisions: ['/goal do it all', '//new'] });
  ok(!h.goal.startsWith('/'), h.goal);
  for (const d of h.decisions) ok(!d.startsWith('/'), d);
  eq(h.goal, 'autopilot ship the payments refactor');
});

t('but an absolute PATH keeps its slash: mangling it would make it a lie', () => {
  const h = capHandoff({ paths: ['/Users/z/dev/x/foo.ts', 'relative/bar.ts'] });
  eq(h.paths[0], '/Users/z/dev/x/foo.ts');
  eq(h.paths.length, 1, 'a relative path means nothing without the cwd it was relative to');
});

// ---------------------------------------------------------------------------
console.log('\n5. the injected block');
// ---------------------------------------------------------------------------

const sample = () =>
  capHandoff({
    from: 'claude',
    at: Date.now() - 120_000,
    cwd: '/Users/z/dev/x',
    sandbox: 'workspace-write + network',
    goal: 'fix the retry loop in foo.ts',
    decisions: ['no queue: the retry is in-process'],
    paths: ['/Users/z/dev/x/foo.ts', '/Users/z/dev/y/z.ts'],
    open: 'what timeout',
    tools: ['Read', 'Edit', 'supabase-mcp'],
  });

t('★ both markers are emitted, and the raw JSON never is', () => {
  const block = renderHandoffBlock(sample(), { toEngine: 'codex', cwd: '/Users/z/dev/x' });
  ok(block.includes(HANDOFF_START), block);
  ok(block.includes(HANDOFF_END), block);
  ok(!block.includes('"goal"'), `the JSON was pasted in: ${block}`);
  ok(!block.includes('{"'), block);
  ok(block.includes('fix the retry loop'), block);
  ok(/VOID/.test(block), 'the untrusted-input framing is what makes this safe to inject');
});

t('★ the tools the incoming engine does not have are named, from a constant map', () => {
  const said = unavailableTools('codex', ['Agent', 'skills', 'the memory dir', 'supabase-mcp']);
  ok(said.some((x) => /subagents/.test(x)), JSON.stringify(said));
  ok(said.some((x) => /skills/.test(x)), JSON.stringify(said));
  ok(said.some((x) => /memory dir/.test(x)), JSON.stringify(said));
  ok(said.some((x) => /MCP server is configured/.test(x)), JSON.stringify(said));
  // Nothing in the Claude set is unavailable ON Claude.
  eq(unavailableTools('claude', ['Agent', 'skills', 'the memory dir', 'supabase-mcp']).length, 0);
  eq(unavailableTools('codex', []).length, 0);
});

t('★ paths outside the cwd are named, because Codex genuinely cannot reach them', () => {
  // Structural: workspace-write is rooted at ONE directory and `codex exec
  // resume` takes no --add-dir (measured).
  const out = unreachablePaths('/Users/z/dev/x', ['/Users/z/dev/x/foo.ts', '/Users/z/dev/y/z.ts', '/Users/z/dev/y/z.ts']);
  eq(out.length, 1, JSON.stringify(out));
  eq(out[0], '/Users/z/dev/y/z.ts');
  eq(unreachablePaths('/Users/z/dev/x', ['/Users/z/dev/x/a', '/Users/z/dev/x']).length, 0, 'cwd is a prefix of itself');
  // A sibling whose name STARTS with the cwd is not inside it.
  eq(unreachablePaths('/Users/z/dev/x', ['/Users/z/dev/xyz/a.ts']).length, 1);
  eq(unreachablePaths('', ['/a']).length, 0);
  eq(unreachablePaths('/Users/z/dev/x', null).length, 0);
});

t('the unreachable line is only for Codex: Claude reads anywhere on this Mac', () => {
  const block = renderHandoffBlock(sample(), { toEngine: 'claude', cwd: '/Users/z/dev/x' });
  ok(!/Cannot be reached/.test(block), block);
});

// ---------------------------------------------------------------------------
console.log('\n6. age, staleness, and the five rungs');
// ---------------------------------------------------------------------------

t('age renders in s, m and h', () => {
  const now = Date.now();
  eq(handoffAge({ at: now - 45_000 }, { now }), '45s');
  eq(handoffAge({ at: now - 12 * 60_000 }, { now }), '12m');
  eq(handoffAge({ at: now - (3 * 60 + 5) * 60_000 }, { now }), '3h 5m');
  eq(handoffAge({ at: now + 60_000 }, { now }), '0s', 'a clock that went backwards is not a negative age');
});

t('★ source flips to stale past six hours', () => {
  const now = Date.now();
  const fresh = { at: now - 60_000, source: 'recorded' };
  const old = { at: now - 7 * 3600_000, source: 'recorded' };
  eq(HANDOFF_STALE_MS, 6 * 3600_000);
  eq(isStaleHandoff(fresh, { now }), false);
  eq(isStaleHandoff(old, { now }), true);
  eq(resolveHandoffSource({ stored: old, now }).handoff.source, 'stale');
  eq(resolveHandoffSource({ stored: fresh, now }).handoff.source, 'recorded');
});

t('★ the ladder picks the highest rung available, and rung 1 injects nothing', () => {
  const model = { at: Date.now(), goal: 'm' };
  const recorded = { at: Date.now(), goal: 'r' };
  const stored = { at: Date.now(), goal: 's' };
  eq(resolveHandoffSource({ fresh: true, model, recorded, stored }).rung, 1);
  eq(resolveHandoffSource({ fresh: true, model, recorded, stored }).handoff, null);
  eq(resolveHandoffSource({ model, recorded, stored }).rung, 2);
  eq(resolveHandoffSource({ model, recorded, stored }).handoff.source, 'model');
  eq(resolveHandoffSource({ recorded, stored }).rung, 3);
  eq(resolveHandoffSource({ stored }).rung, 4);
  eq(resolveHandoffSource({}).rung, 5);
  eq(resolveHandoffSource({}).handoff, null);
});

t('the /engine line reads in all three states', () => {
  const now = Date.now();
  ok(handoffLine(null).includes('none'), handoffLine(null));
  const line = handoffLine({ at: now - 12 * 60_000, from: 'claude', source: 'recorded' }, { toEngine: 'codex', now });
  ok(line.startsWith('📎 Handoff:'), line);
  ok(line.includes('12m'), line);
  ok(line.includes('from Claude'), line);
  ok(line.includes('recorded'), line);
  ok(line.includes('next Codex message'), line);
  ok(handoffLine({ at: now - 9 * 3600_000, from: 'codex' }, { now }).includes('stale'), 'an old handoff must say so');
});

t('the switch confirmation counts what it actually carried', () => {
  const said = handoffBits(sample());
  ok(said.includes('goal'), said);
  ok(said.includes('1 decision'), said);
  ok(said.includes('2 paths'), said);
  ok(said.includes('1 open question'), said);
  // The token count is gone: it was always 0 on rungs 3 and 4, and the real
  // numbers live in /usage.
  ok(!/token/.test(said), said);
  eq(handoffBits(null), null);
});

t('a handoff carrying nothing but the cwd says so rather than printing a blank', () => {
  eq(handoffBits({ goal: '', decisions: [], paths: [], tools: [] }), 'the working directory only');
});

t('★ the switch line names the missing tools in one word each', () => {
  eq(unavailableToolLabels('codex', ['Task', 'Skill', 'mcp__supabase__execute_sql']).join(', '), 'subagents, skills, MCP');
  eq(unavailableToolLabels('claude', ['Task']).length, 0, 'Claude has all of them');
});

t('★ a slash command is never a path, however it arrives', () => {
  const typed = ['/review', '/compact', '/usage', '/account', '/status', '/stop', '/ecs/delta-agents', '/tmp/brief-x.md'];
  // Every one of these was counted as a path Codex could not reach, on a real
  // switch confirmation, in the owner's screenshot.
  const kept = filterProsePaths(typed, {
    exists: (p) => p === '/tmp/brief-x.md',
    commands: ['review', 'compact', 'usage', 'account', 'status', 'stop'],
  });
  eq(kept.join(','), '/tmp/brief-x.md', JSON.stringify(kept));
});

t('a single-segment token is out even when it is not a command and does exist', () => {
  eq(filterProsePaths(['/opt'], { exists: () => true }).length, 0);
  eq(filterProsePaths(['/opt/homebrew/bin/node'], { exists: () => true }).length, 1);
});

t('a command name with a second segment would still be caught by name', () => {
  // /qa-loop and /go-live are one segment today; the list is there for the day
  // one is not.
  eq(filterProsePaths(['/go/live'], { exists: () => true, commands: ['go/live'] }).length, 0);
  eq(filterProsePaths(['/go/live'], { exists: () => true, commands: [] }).length, 1);
});

t('★ a file the command is about to CREATE survives: the scan runs before it does', () => {
  // pathsFromToolInput is called as the tool_use block STREAMS, so a heredoc
  // writing a new file names a path that does not exist yet, and it is the most
  // interesting path in the whole turn. The parent directory is what vouches
  // for it. Found by the QA pass on this change.
  const onDisk = new Set(['/Users/z/dev/x']);
  const got = pathsFromToolInput(
    { command: "cat > /Users/z/dev/x/report.md <<'EOF'" },
    { exists: (p) => onDisk.has(p) },
  );
  eq(got.join(','), '/Users/z/dev/x/report.md', JSON.stringify(got));
});

t('and the parent rule does NOT let the original junk back in', () => {
  // /ecs/delta-agents is a log group: there is no /ecs either.
  eq(filterProsePaths(['/ecs/delta-agents'], { exists: () => false }).length, 0);
  eq(filterProsePaths(['/usage'], { exists: () => true, commands: ['usage'] }).length, 0);
  // A directory that exists vouches for one level, not two.
  eq(filterProsePaths(['/Users/z/dev/x/deep/report.md'], { exists: (p) => p === '/Users/z/dev/x' }).length, 0);
});

t('filterProsePaths is total: junk in, empty out, never a throw', () => {
  eq(filterProsePaths(null).length, 0);
  eq(filterProsePaths(['relative/x.ts'], { exists: () => true }).length, 0);
  eq(filterProsePaths(['/a/b'], { exists: null }).length, 0);
});

// ---------------------------------------------------------------------------
console.log('\n7. rung 3 from the ring, and reading a capture turn');
// ---------------------------------------------------------------------------

t('★ a handoff is built from the ring with no model call at all', () => {
  const ring = [
    ringEntry({ chat: '1', role: 'user', text: 'we are fixing the retry loop in foo.ts' }),
    ringEntry({ chat: '1', role: 'assistant', text: 'decided: no queue', paths: ['/x/foo.ts'], tools: ['Edit'] }),
    ringEntry({ chat: '1', role: 'user', text: 'what about the timeout' }),
  ];
  const h = buildHandoff({ from: 'claude', ring, cwd: '/x', sandbox: 'full access' });
  eq(h.goal, 'what about the timeout', 'the goal is his own last message');
  ok(h.decisions.some((d) => d.includes('no queue')), JSON.stringify(h.decisions));
  ok(h.paths.includes('/x/foo.ts'), JSON.stringify(h.paths));
  ok(h.tools.includes('Edit'), JSON.stringify(h.tools));
  eq(h.open, '', 'a deterministic build does not know what is open, and must not invent it');
  eq(h.source, 'recorded');
});

t('an empty ring produces nothing rather than an empty-shaped handoff', () => {
  eq(buildHandoff({ ring: [] }).goal, '');
});

t('★ a capture answer survives prose, fences, a trailing comma, and garbage', () => {
  const body = '{"goal":"fix the loop","decisions":["no queue"],"paths":["/x/a.ts"],"open":"what timeout","tools":["Edit"]}';
  eq(parseHandoffJson(body).goal, 'fix the loop');
  eq(parseHandoffJson(`Sure, here you go:\n${body}\nLet me know if you need more.`).goal, 'fix the loop');
  eq(parseHandoffJson('```json\n' + body + '\n```').goal, 'fix the loop');
  eq(parseHandoffJson('{"goal":"fix the loop","open":"x",}').goal, 'fix the loop');
  eq(parseHandoffJson('I would rather not.'), null);
  eq(parseHandoffJson(''), null);
  eq(parseHandoffJson(null), null);
  eq(parseHandoffJson('[1,2,3]'), null, 'an array is not a handoff');
  eq(parseHandoffJson('{{{{{'), null);
});

// ---------------------------------------------------------------------------
console.log('\n8. what the QA pass found');
// ---------------------------------------------------------------------------
// Each of these failed before its fix. Three of the four share one root cause:
// the ring is the thing a handoff is REBUILT from, so anything that forgets the
// conversation has to forget the ring too, and anything that ages the handoff
// has to age it from the ring's own clock.

t('★ the handoff is stamped with the last TURN\'s clock, not with the switch', () => {
  // Stamped Date.now(), every handoff was "0s ago" forever: a week-old
  // conversation was injected as current and the stale label could never fire
  // on anything, because rung 3 always wins once a ring exists.
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const ring = [
    ringEntry({ chat: '1', role: 'user', text: 'what were we doing', ts: weekAgo }),
    ringEntry({ chat: '1', role: 'assistant', text: 'the retry loop', ts: weekAgo }),
  ];
  const h = buildHandoff({ from: 'claude', ring, cwd: '/x', at: Number(ring[ring.length - 1].ts) });
  eq(h.at, weekAgo, 'the switch time tells the incoming engine nothing about the conversation');
  eq(isStaleHandoff(h), true);
  const block = renderHandoffBlock({ ...h, source: 'stale' }, { toEngine: 'codex', cwd: '/x' });
  ok(/STALE/.test(block), `a week-old context was injected as current: ${block.split('\n')[0]}`);
});

t('★ resolveHandoffSource is the ladder the daemon actually runs', () => {
  // switchHandoff used to re-implement rungs 1, 3 and 4 inline, so the tested
  // ladder and the shipped ladder agreed only by inspection. This asserts the
  // shape switchHandoff now consumes.
  const recorded = { at: Date.now(), goal: 'r' };
  const stored = { at: Date.now() - 9 * 3600_000, goal: 's', source: 'recorded' };
  eq(resolveHandoffSource({ recorded, stored }).rung, 3);
  const only = resolveHandoffSource({ recorded: null, stored });
  eq(only.rung, 4);
  eq(only.source, 'stale', 'a nine-hour-old stored handoff must be labelled');
  eq(resolveHandoffSource({ recorded: null, stored: null }).handoff, null);
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all engine-handoff tests pass');
