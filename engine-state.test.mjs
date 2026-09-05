#!/usr/bin/env node
// Tests for engine-state.mjs: which engine runs what, and what Codex runs with.
//
// This module is where a Codex-first install lives or dies, so the branches
// that matter are the ones nobody exercises by accident: a machine with no
// `claude` binary at all, a chat lane on Codex while every Claude account is
// walled, and a `claude:` prefix on an install where everything defaults to
// Codex. None of them need a daemon, a binary or a paid call to assert.
//
//   node engine-state.test.mjs

import {
  CODEX_EFFORTS,
  CLAUDE_ONLY_COMMANDS,
  DEFAULT_ENGINES,
  ENGINE_PREFIX_RE,
  bgEngine,
  chatEngine,
  claudeMissingLine,
  codexChatSandbox,
  codexSettings,
  codexTomlModel,
  engineDefaults,
  engineStatusLine,
  engineView,
  fmtAge,
  isClaudeOnlyCommand,
  normalizeEngine,
  parseCodexEffortArg,
  parseCodexModelArg,
  parseCodexNetworkArg,
  parseEngineCommand,
  canProduceHandoff,
  resolveCaptureLine,
  resolveEngine,
  settleSwitchText,
  switchView,
  voiceUntranscribedLine,
} from './engine-state.mjs';

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
console.log('\n1. normalization and config defaults');
// ---------------------------------------------------------------------------

t('an engine name is claude, codex, or nothing', () => {
  eq(normalizeEngine('codex'), 'codex');
  eq(normalizeEngine('  CLAUDE '), 'claude');
  eq(normalizeEngine('gpt'), null);
  eq(normalizeEngine(null), null);
  eq(normalizeEngine(''), null);
  eq(normalizeEngine(42), null);
});

t('with no config at all, both lanes are claude', () => {
  eq(engineDefaults({}).chat, 'claude');
  eq(engineDefaults({}).bg, 'claude');
  eq(engineDefaults().chat, DEFAULT_ENGINES.chat);
});

t('★ a Codex-first install sets both lanes once in config.json', () => {
  const cfg = { engine: { chat: 'codex', bg: 'codex' } };
  eq(chatEngine({ chat: {}, config: cfg }), 'codex');
  eq(bgEngine({ chat: {}, config: cfg }), 'codex');
});

t('engine: "codex" as a bare string means both lanes', () => {
  // It is the obvious thing to write in a config file, so writing it works.
  eq(engineDefaults({ engine: 'codex' }).chat, 'codex');
  eq(engineDefaults({ engine: 'codex' }).bg, 'codex');
});

t('a typo in config.json changes nothing rather than stopping the daemon', () => {
  eq(engineDefaults({ engine: { chat: 'gpt5', bg: 'kodex' } }).chat, 'claude');
  eq(engineDefaults({ engine: { chat: 'gpt5', bg: 'kodex' } }).bg, 'claude');
  eq(engineDefaults({ engine: 'nonsense' }).chat, 'claude');
});

t('the lanes are independent: codex chat, claude bg', () => {
  const cfg = { engine: { chat: 'codex', bg: 'claude' } };
  eq(chatEngine({ chat: {}, config: cfg }), 'codex');
  eq(bgEngine({ chat: {}, config: cfg }), 'claude');
});

// ---------------------------------------------------------------------------
console.log('\n2. resolution order: prefix beats chat state beats config');
// ---------------------------------------------------------------------------

const R = (o) => resolveEngine({ lane: 'chat', ...o });

t('nothing set anywhere: claude, with nothing to explain', () => {
  const d = R({});
  eq(d.engine, 'claude');
  eq(d.reason, null);
  eq(d.error, null);
});

t('★ /engine beats the config default', () => {
  const d = R({ chat: { engineChat: 'codex' }, config: { engine: { chat: 'claude' } } });
  eq(d.engine, 'codex');
  eq(d.reason, 'setting');
});

t('★ a per-message prefix beats /engine', () => {
  const d = R({ forcedEngine: 'claude', chat: { engineChat: 'codex' } });
  eq(d.engine, 'claude');
  eq(d.reason, 'explicit');
});

t('★ a codex: prefix beats a claude-everywhere install', () => {
  const d = R({ forcedEngine: 'codex', chat: { engineChat: 'claude' }, config: { engine: { chat: 'claude' } } });
  eq(d.engine, 'codex');
  eq(d.reason, 'explicit');
});

t('the config default is reported as "config", a stored choice as "setting"', () => {
  eq(R({ config: { engine: { chat: 'codex' } } }).reason, 'config');
  eq(R({ chat: { engineChat: 'codex' } }).reason, 'setting');
});

t('the bg lane reads engineBg, not engineChat', () => {
  const chat = { engineChat: 'codex', engineBg: 'claude' };
  eq(resolveEngine({ lane: 'chat', chat }).engine, 'codex');
  eq(resolveEngine({ lane: 'bg', chat }).engine, 'claude');
});

// ---------------------------------------------------------------------------
console.log('\n3. the wall: a codex lane never reads it, a claude lane does');
// ---------------------------------------------------------------------------

const WALL = Date.now() + 3600_000;

t('★ a chat lane set to codex ignores a Claude wall entirely', () => {
  // The whole point of a second engine: an Anthropic account limit has no
  // bearing on a lane that is not going to touch an Anthropic account.
  const d = R({ chat: { engineChat: 'codex' }, rotationPausedUntil: WALL });
  eq(d.engine, 'codex');
  eq(d.reason, 'setting', 'a settled preference must not be reported as a rescue');
  eq(d.pausedUntil, null, 'a codex lane has no reset time to wait for');
});

t('★ and it ignores the wall even with the fallback switched OFF', () => {
  // /codex off disables the FALLBACK. It is not a kill switch for an engine the
  // owner chose on purpose.
  const d = R({ chat: { engineChat: 'codex' }, rotationPausedUntil: WALL, codexFallback: false });
  eq(d.engine, 'codex');
  eq(d.reason, 'setting');
});

t('a claude lane with no preference falls back to codex while walled', () => {
  const d = R({ rotationPausedUntil: WALL });
  eq(d.engine, 'codex');
  eq(d.reason, 'claude_limited');
  eq(d.pausedUntil, WALL);
});

t('★ but only while the fallback is on', () => {
  const d = R({ rotationPausedUntil: WALL, codexFallback: false });
  eq(d.engine, 'claude');
  eq(d.pausedUntil, WALL, 'the caller still needs the reset time to say why it is waiting');
});

t('★ a job PINNED to claude waits for the reset, wall or no wall', () => {
  const d = R({ forcedEngine: 'claude', rotationPausedUntil: WALL });
  eq(d.engine, 'claude');
  eq(d.reason, 'explicit');
});

t('an expired wall is not a wall', () => {
  const d = R({ rotationPausedUntil: Date.now() - 1000 });
  eq(d.engine, 'claude');
  eq(d.pausedUntil, null);
});

t('★ the loop guard: nothing here can see a previous FAILURE', () => {
  // A Codex failure must never make the next decision come out claude, and a
  // Claude failure must never make it come out codex. That is structural: there
  // is no input to ping-pong on. Asserted as a property of the signature so a
  // future "lastFailure" parameter has to break this test to get added.
  const keys = ['lane', 'forcedEngine', 'chat', 'config', 'claudeAvailable', 'codexAvailable', 'rotationPausedUntil', 'now', 'codexFallback'];
  const src = resolveEngine.toString();
  for (const k of keys) ok(src.includes(k), `resolveEngine lost its ${k} input`);
  ok(!/fail|error(?!:)|retry|previous|last(Run|Outcome)/i.test(src.split('\n')[0]), 'no failure input may exist');
  // Same inputs twice, opposite order of calls: identical answers.
  const a = R({ chat: { engineChat: 'codex' } });
  const b = R({});
  const c = R({ chat: { engineChat: 'codex' } });
  eq(a.engine, c.engine);
  eq(b.engine, 'claude');
});

// ---------------------------------------------------------------------------
console.log('\n4. availability: a preference for a binary that is not here');
// ---------------------------------------------------------------------------

t('★ no claude binary + engine codex: it just runs, no wall, no error', () => {
  const d = R({ chat: { engineChat: 'codex' }, claudeAvailable: false });
  eq(d.engine, 'codex');
  eq(d.error, null);
});

t('★ no claude binary + a claude preference: codex runs it and says why', () => {
  const d = R({ chat: { engineChat: 'claude' }, claudeAvailable: false });
  eq(d.engine, 'codex');
  eq(d.reason, 'claude_missing');
});

t('★ no claude and no codex: refused cleanly, not crashed', () => {
  const d = R({ claudeAvailable: false, codexAvailable: false });
  eq(d.engine, null);
  eq(d.error, 'claude_missing');
});

t('★ no codex binary + engine codex: refused cleanly, and NOT silently on claude', () => {
  // Silently running on Claude would be worse than the error: the owner asked
  // for a cross-family answer and would get a same-family one without knowing.
  const d = R({ chat: { engineChat: 'codex' }, codexAvailable: false });
  eq(d.engine, null);
  eq(d.error, 'codex_missing');
});

t('no codex binary + a claude lane + a wall: it waits, it does not error', () => {
  const d = R({ rotationPausedUntil: WALL, codexAvailable: false });
  eq(d.engine, 'claude');
  eq(d.error, null);
  eq(d.pausedUntil, WALL);
});

t('a forced codex on a machine without it is still refused', () => {
  eq(R({ forcedEngine: 'codex', codexAvailable: false }).error, 'codex_missing');
});

// ---------------------------------------------------------------------------
console.log('\n5. /engine grammar');
// ---------------------------------------------------------------------------

t('bare /engine is a read', () => {
  ok(parseEngineCommand('').show);
  ok(parseEngineCommand('   ').show);
  ok(parseEngineCommand(undefined).show);
});

t('/engine codex sets the chat lane', () => {
  const p = parseEngineCommand('codex');
  eq(p.scope, 'chat');
  eq(p.engine, 'codex');
});

t('/engine bg codex sets the background default', () => {
  const p = parseEngineCommand('bg codex');
  eq(p.scope, 'bg');
  eq(p.engine, 'codex');
});

t('"background" and an explicit "chat" both work', () => {
  eq(parseEngineCommand('background claude').scope, 'bg');
  eq(parseEngineCommand('chat codex').scope, 'chat');
  eq(parseEngineCommand('chat codex').engine, 'codex');
});

t('a bad engine name is refused with the usage line', () => {
  const p = parseEngineCommand('gpt5');
  ok(p.error?.includes('not an engine'), p.error);
  ok(p.error?.includes('claude|codex'), p.error);
});

t('/engine bg with no engine is refused, not read as a set', () => {
  ok(parseEngineCommand('bg').error?.includes('Which engine'), parseEngineCommand('bg').error);
});

t('extra words are refused rather than ignored', () => {
  ok(parseEngineCommand('bg codex please').error?.includes('Too many'), 'trailing words must not be silently dropped');
});

t('the grammar never throws, whatever is thrown at it', () => {
  for (const bad of ['../..', '-x', '{}', 'bg bg bg', '\u0000', 'CODEX', 'bg CLAUDE']) {
    const p = parseEngineCommand(bad);
    ok(p && (p.error || p.engine || p.show), `no verdict for ${JSON.stringify(bad)}`);
  }
  eq(parseEngineCommand('CODEX').engine, 'codex');
  eq(parseEngineCommand('bg CLAUDE').engine, 'claude');
});

// ---------------------------------------------------------------------------
console.log('\n6. the codex: / claude: prefix');
// ---------------------------------------------------------------------------

t('both prefixes are recognised, case-insensitively', () => {
  ok(ENGINE_PREFIX_RE.test('codex: do it'));
  ok(ENGINE_PREFIX_RE.test('Claude: do it'));
  ok(ENGINE_PREFIX_RE.test('  CODEX:   do it'));
  ok(!ENGINE_PREFIX_RE.test('the codex: thing'), 'only at the start of the message');
  ok(!ENGINE_PREFIX_RE.test('gpt: do it'));
});

// ---------------------------------------------------------------------------
console.log('\n7. model and effort');
// ---------------------------------------------------------------------------

t('bare /codex model is a read, "default" is a clear', () => {
  ok(parseCodexModelArg('').show);
  ok(parseCodexModelArg(' default ').clear);
  ok(parseCodexModelArg('reset').clear);
});

t('★ any model name is accepted: the CLI has no list command to check against', () => {
  eq(parseCodexModelArg('gpt-5.6-sol').model, 'gpt-5.6-sol');
  eq(parseCodexModelArg('  o3-mini ').model, 'o3-mini');
  eq(parseCodexModelArg('something-that-does-not-exist').model, 'something-that-does-not-exist');
});

t('but a model name that would become a FLAG is refused', () => {
  // It goes into argv beside -m; a leading dash turns the value into an option.
  ok(parseCodexModelArg('--sandbox').error, 'a flag-shaped model must not reach argv');
  ok(parseCodexModelArg('gpt 5').error, 'a name with a space is two argv entries');
});

t('★ the effort allowlist is the model\'s own published enum', () => {
  // Measured 2026-09-03: the API rejects anything outside this set, and rejects
  // "minimal" specifically for gpt-5.6-sol, so it is not offered.
  for (const v of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
    eq(parseCodexEffortArg(v).effort, v);
  }
  ok(!CODEX_EFFORTS.includes('minimal'), 'minimal is in the enum but the model refuses it');
});

t('★ a bad effort is refused LOCALLY, at zero Codex spend, with the list', () => {
  // The CLI validates none of this: an unknown value is a billed round trip
  // that ends in a 400.
  const p = parseCodexEffortArg('turbo');
  ok(p.error?.includes('not a reasoning effort'), p.error);
  ok(p.error?.includes('xhigh'), 'the refusal has to name what IS accepted');
  ok(!p.effort);
});

t('effort is case-insensitive and "default" clears it', () => {
  eq(parseCodexEffortArg('HIGH').effort, 'high');
  ok(parseCodexEffortArg('default').clear);
  ok(parseCodexEffortArg('').show);
});

t('settings read per chat, with the config underneath', () => {
  eq(codexSettings({ chat: {}, config: {} }).model, null);
  eq(codexSettings({ chat: {}, config: { codexModel: 'o3' } }).model, 'o3');
  eq(codexSettings({ chat: { codexModel: 'gpt-5.6' }, config: { codexModel: 'o3' } }).model, 'gpt-5.6');
  eq(codexSettings({ chat: { codexEffort: 'high' } }).effort, 'high');
});

t('a junk effort left in state.json is ignored, not passed to the CLI', () => {
  // state.json is a file on disk; a hand-edit must not turn into a 400 on every
  // run until someone notices.
  eq(codexSettings({ chat: { codexEffort: 'turbo' } }).effort, null);
  eq(codexSettings({ chat: { codexEffort: '' } }).effort, null);
});

// ---------------------------------------------------------------------------
console.log('\n8. the chat lane sandbox');
// ---------------------------------------------------------------------------

t('★ yolo on is workspace-write with network, yolo off is read-only', () => {
  eq(codexChatSandbox({ yolo: true }).sandbox, 'workspace-write');
  eq(codexChatSandbox({ yolo: true }).network, true);
  eq(codexChatSandbox({ yolo: false }).sandbox, 'read-only');
  eq(codexChatSandbox({ yolo: false }).network, false);
});

t('read-only never carries network access', () => {
  // Belt and braces: `-c sandbox_workspace_write.network_access` is meaningless
  // under read-only, and emitting it would suggest otherwise to anyone reading
  // the argv in `ps`.
  eq(codexChatSandbox({ yolo: false }).network, false);
});

t('★ nothing in this module can produce --approve-for-me', () => {
  // Measured 2026-09-03: `codex exec` refuses --approve-for-me together with
  // --sandbox (exit 2), and on its own it auto-approved the model's own
  // escalation and wrote into $HOME from a run rooted at /tmp. It is a soft
  // bypass flag and the confinement this lane advertises would be a lie.
  const src = codexChatSandbox.toString();
  ok(!/approve-for-me|approve_for_me/.test(src), 'the soft bypass flag must be unreachable');
});

// ---------------------------------------------------------------------------
console.log('\n9. claude-only commands, on a machine with no claude');
// ---------------------------------------------------------------------------

t('the claude-only list is the commands whose SUBJECT is a Claude session', () => {
  for (const c of ['/compact', '/context', '/usage']) {
    ok(isClaudeOnlyCommand(c), `${c} should be claude-only`);
  }
});

t('★ the commands a Codex-first user actually needs are NOT claude-only', () => {
  for (const c of ['/engine', '/codex', '/status', '/new', '/cd', '/stop', '/help', '/yolo', '/model', '/steer', '/account', '/accounts']) {
    ok(!isClaudeOnlyCommand(c), `${c} must still work with no claude binary`);
  }
});

t('★ /account stays reachable: it is where a ChatGPT plan\'s windows live', () => {
  // A Codex-first install has zero Claude accounts captured, and that state is
  // exactly when the owner needs the Codex block. Gating the command on Claude
  // would hide the one account the machine actually has.
  ok(!isClaudeOnlyCommand('/account'));
  ok(!isClaudeOnlyCommand('/accounts'));
});

t('the refusal is one line and says what to do', () => {
  const line = claudeMissingLine('/usage');
  ok(line.includes('/usage'), line);
  ok(line.includes('needs Claude'), line);
  ok(line.includes('/engine'), 'it has to point at the thing that explains the install');
});

t('matching is case-insensitive and safe on junk', () => {
  ok(isClaudeOnlyCommand('/USAGE'));
  ok(!isClaudeOnlyCommand(null));
  ok(!isClaudeOnlyCommand(''));
  ok(!isClaudeOnlyCommand(42));
});

// ---------------------------------------------------------------------------
console.log('\n10. the /engine view and the /status line');
// ---------------------------------------------------------------------------

t('the view names both lanes and where each value came from', () => {
  const v = engineView({ chat: { engineChat: 'codex' }, config: { engine: { bg: 'codex' } } });
  ok(/Chat lane: Codex · \/engine/.test(v), v);
  ok(/Background: Codex · config default/.test(v), v);
});

t('★ the view says what a Codex run would start with RIGHT NOW', () => {
  const v = engineView({
    chat: { engineChat: 'codex', codexModel: 'gpt-5.6-sol', codexEffort: 'high', yolo: true },
    cwd: '~/dev/ops-dash',
  });
  ok(v.includes('⚙️ Codex model: gpt-5.6-sol · effort: high'), v);
  ok(v.includes('🔒 Sandbox: workspace-write + network in ~/dev/ops-dash'), v);
});

t('yolo off shows the read-only sandbox', () => {
  const v = engineView({ chat: { engineChat: 'codex', yolo: false } });
  ok(v.includes('🔒 Sandbox: read-only'), v);
  ok(!v.includes('network'), v);
});

t('unset model and effort read as "default", never as a blank', () => {
  const v = engineView({ chat: {} });
  ok(v.includes('⚙️ Codex model: default · effort: default'), v);
});

t('★ the thread age is shown, and the thread ID never is', () => {
  const v = engineView({ chat: { engineChat: 'codex' }, threadAgeSec: 3 * 3600 + 300 });
  ok(v.includes('🧵 Thread: continuing (3h 5m)'), v);
  const fresh = engineView({ chat: { engineChat: 'codex' }, threadAgeSec: null });
  ok(fresh.includes('🧵 Thread: fresh'), fresh);
  // Nothing in the signature can carry an id, so none can be rendered.
  ok(!/threadId|thread_id/.test(engineView.toString()), 'the view must not be able to print an id');
});

t('a claude chat lane shows no thread line at all', () => {
  ok(!engineView({ chat: {} }).includes('🧵 Thread'), 'there is no thread to describe');
});

t('★ the view reports the EFFECTIVE engine when a binary is missing', () => {
  // Reporting "chat lane: claude" on a machine where every message runs on
  // Codex was the bug: /model then silently set a Claude model nothing would
  // ever use, and /status showed no thread age for a lane that had a thread.
  const v = engineView({ chat: {}, config: {}, claudeAvailable: false });
  ok(/Chat lane: Codex/.test(v), v);
  ok(/Background: Codex/.test(v), v);
  ok(/no `claude` binary/i.test(v), v);
});

t('and the /status line appears on that machine too, rather than staying silent', () => {
  const line = engineStatusLine({ chat: {}, config: {}, claudeAvailable: false });
  ok(line && line.includes('chat codex'), JSON.stringify(line));
});

t('a missing binary is called out in the view', () => {
  ok(/no `claude` binary/i.test(engineView({ claudeAvailable: false })), 'the view is where a user would look');
  ok(/no `codex` binary/i.test(engineView({ codexAvailable: false })));
});

t('★ a plain claude-on-both install gets NO extra /status line', () => {
  // The status view is a liveness view. Adding a line that always says the same
  // thing costs the lines that change.
  eq(engineStatusLine({ chat: {}, config: {} }), null);
});

t('a codex lane DOES get one, with the model and effort', () => {
  const line = engineStatusLine({ chat: { engineChat: 'codex', codexEffort: 'xhigh' }, config: {} });
  ok(line.includes('chat codex'), line);
  ok(line.includes('bg claude'), line);
  ok(line.includes('default/xhigh'), line);
});

t('ages read the way a human says them', () => {
  eq(fmtAge(5), '5s');
  eq(fmtAge(90), '1m');
  eq(fmtAge(3600), '1h 0m');
  eq(fmtAge(3660), '1h 1m');
  eq(fmtAge(-5), '0s');
  eq(fmtAge(null), '0s');
});

t('CLAUDE_ONLY_COMMANDS is frozen: it is a policy, not a scratch array', () => {
  let threw = false;
  try {
    CLAUDE_ONLY_COMMANDS.push('/status');
  } catch {
    threw = true;
  }
  ok(threw || !CLAUDE_ONLY_COMMANDS.includes('/status'), 'the list must not be mutable by accident');
});

// ---------------------------------------------------------------------------
console.log('\n9. a voice note nothing can transcribe');
// ---------------------------------------------------------------------------

t('★ it names the engine that IS about to run, and both fixes', () => {
  const codex = voiceUntranscribedLine('codex');
  ok(codex.includes('OPENAI_API_KEY'), codex);
  ok(codex.includes('Codex'), codex);
  ok(!codex.includes('Claude'), `it named the wrong engine: ${codex}`);
  const claude = voiceUntranscribedLine('claude');
  ok(claude.includes('Claude'), claude);
  ok(!claude.includes('Codex'), claude);
});

t('a transcription that ERRORED is not described as a missing key', () => {
  const err = voiceUntranscribedLine('claude', { reason: 'error' });
  ok(!err.includes('no OPENAI_API_KEY'), err);
  ok(err.includes('transcription failed'), err);
  // Both lines still say the fix, because a failed whisper call and a missing
  // key leave him in the same place: the words never arrived.
  ok(err.includes('OPENAI_API_KEY'), err);
});

// ---------------------------------------------------------------------------
console.log('\n10. /engine ... fresh, and the handoff ladder gate');
// ---------------------------------------------------------------------------

t('★ `fresh` is accepted after an engine name, on both scopes', () => {
  eq(parseEngineCommand('codex fresh').engine, 'codex');
  eq(parseEngineCommand('codex fresh').fresh, true);
  eq(parseEngineCommand('codex').fresh, false);
  eq(parseEngineCommand('bg codex fresh').scope, 'bg');
  eq(parseEngineCommand('bg codex fresh').fresh, true);
  eq(parseEngineCommand('  CLAUDE   FRESH ').fresh, true, 'typed on a phone, so case and spacing are not the test');
});

t('and refused everywhere it would mean something else', () => {
  // `/engine fresh` reads as "switch to an engine called fresh", which is not
  // an engine, and silently treating it as a bare /engine would hide a typo.
  ok(parseEngineCommand('fresh').error, JSON.stringify(parseEngineCommand('fresh')));
  ok(parseEngineCommand('codex fresh extra').error, JSON.stringify(parseEngineCommand('codex fresh extra')));
  ok(parseEngineCommand('codex stale').error, JSON.stringify(parseEngineCommand('codex stale')));
  ok(parseEngineCommand('codex fresh').error === undefined);
});

t('★ canProduceHandoff drops to rung 3 for each skip condition on its own', () => {
  // Every one of these is a way the switch could have hung. The owner is
  // usually switching BECAUSE something is wrong with the engine he is leaving,
  // which is exactly when asking it for a favour fails.
  const clear = { engine: 'codex', available: true, pausedUntil: 0, authState: 'chatgpt', laneBusy: false };
  eq(canProduceHandoff(clear).rung, 2, JSON.stringify(canProduceHandoff(clear)));
  eq(canProduceHandoff(clear).skip.length, 0);
  const cases = {
    'no binary': { ...clear, available: false },
    walled: { ...clear, pausedUntil: Date.now() + 3600_000 },
    'auth broken': { ...clear, authState: 'broken' },
    'auth missing': { ...clear, authState: 'none' },
    'auth failed on the last run': { ...clear, authState: 'auth' },
    'lane busy': { ...clear, laneBusy: true },
    'capture turn off': { ...clear, captureTurn: false },
  };
  for (const [name, input] of Object.entries(cases)) {
    const got = canProduceHandoff(input);
    eq(got.rung, 3, `${name} should have skipped the capture turn`);
    ok(got.skip.length >= 1, `${name} skipped silently, so /engine cannot say why`);
  }
});

t('★ the capture gate refuses when there is nothing to summarise', () => {
  // Without this the Codex arm spawned a COLD `codex exec` after a /new or a
  // /cd: a model with no context at all, told to describe work it had never
  // seen, billed against the ChatGPT window this feature exists to conserve,
  // and (under --output-schema) answering in shape rather than saying it
  // could not. Its invented answer then replaced the accurate recorded one.
  const clear = { engine: 'codex', available: true, authState: 'chatgpt', hasContext: true };
  eq(canProduceHandoff(clear).rung, 2);
  const none = canProduceHandoff({ ...clear, hasContext: false });
  eq(none.rung, 3);
  ok(/no codex conversation/.test(none.skip[0]), JSON.stringify(none.skip));
  // And it is the GATE that decides, so /engine cannot promise a capture turn
  // the spawner then silently declines to run.
  eq(canProduceHandoff({ engine: 'claude', hasContext: false }).rung, 3);
});

t('a wall in the PAST is not a wall', () => {
  eq(canProduceHandoff({ engine: 'claude', pausedUntil: Date.now() - 1000 }).rung, 2);
});

// ---------------------------------------------------------------------------
console.log('\n11. the /engine view: the handoff line and the ChatGPT window');
// ---------------------------------------------------------------------------

t('★ the handoff line is printed in all three states', () => {
  const now = Date.now();
  const none = engineView({ chat: { engineChat: 'codex' }, now });
  ok(/📎 Handoff: none, nothing recorded/.test(none), none);

  const fresh = engineView({
    chat: { engineChat: 'codex' },
    handoff: { at: now - 12 * 60_000, from: 'claude', source: 'recorded' },
    now,
  });
  ok(/📎 Handoff: 12m old, from Claude \(recorded\)/.test(fresh), fresh);
  ok(/goes to the next Codex message/.test(fresh), fresh);

  const stale = engineView({
    chat: { engineChat: 'codex' },
    handoff: { at: now - 9 * 3600_000, from: 'claude', source: 'recorded' },
    now,
  });
  ok(/\(stale\)/.test(stale), stale);
});

t('★ the ChatGPT window is printed at 80 and above, and not at 79', () => {
  // The snapshot is already cached for 60s so reading it is free; printing
  // "12%" on every /engine is noise, and at 80 it is the number that decides
  // whether switching TO Codex is a good idea in the next hour.
  const at = (percent) =>
    engineView({ chat: { engineChat: 'codex' }, codexUsage: { percent, label: '5h', resetsAt: '03:15' } });
  ok(/📊 Codex 5h window 82%, resets 03:15/.test(at(82)), at(82));
  ok(/📊 Codex 5h window 80%/.test(at(80)), at(80));
  ok(!/window /.test(at(79)), at(79));
  ok(!/window /.test(engineView({ chat: { engineChat: 'codex' } })), 'no snapshot must not print a blank window');
});

t('the view says how to skip the handoff, naming the OTHER engine', () => {
  ok(/\/engine codex fresh skips the handoff/.test(engineView({})), engineView({}));
  ok(
    /\/engine claude fresh skips the handoff/.test(engineView({ chat: { engineChat: 'codex' } })),
    engineView({ chat: { engineChat: 'codex' } }),
  );
});

t('/codex network parses on, off, and nothing else', () => {
  eq(parseCodexNetworkArg(' on').network, true);
  eq(parseCodexNetworkArg('OFF').network, false);
  eq(parseCodexNetworkArg('').show, true);
  ok(parseCodexNetworkArg('maybe').error, JSON.stringify(parseCodexNetworkArg('maybe')));
});

t('★ network is a SEPARATE switch from /yolo, and read-only never has it', () => {
  eq(codexChatSandbox({ yolo: true }).network, true, 'the default must not change for an existing install');
  eq(codexChatSandbox({ yolo: true, network: false }).network, false);
  eq(codexChatSandbox({ yolo: true, network: false }).sandbox, 'workspace-write', 'it can still write');
  eq(codexChatSandbox({ yolo: false, network: true }).network, false, 'a read-only run has no network either way');
});

// ---------------------------------------------------------------------------
console.log('\n12. the switch confirmation: compact, and live');
// ---------------------------------------------------------------------------
// the owner, on a screenshot of the old one: "When swapping engines with context
// this msg is too big of a block with no feedback. Can it be prettier?" These
// assert the exact bytes of every shape, because the shape IS the fix.

t('★ /engine codex with a handoff is five lines, and the last one is live', () => {
  const v = switchView({
    engine: 'codex',
    handoff: { bits: 'goal, 5 decisions', from: 'claude', ageSec: 2 },
    thread: { continuing: true, ageSec: 107 * 60 },
    sandbox: { sandbox: 'workspace-write', cwd: '~/dev' },
    capture: { engine: 'claude' },
  });
  eq(
    v.text,
    [
      '🧠 Codex is on.',
      '📎 Handoff: goal, 5 decisions · from Claude, just now',
      '🧵 Thread: continuing (1h 47m) · /new for a fresh one',
      '🔒 Sandbox: workspace-write in ~/dev',
      '⏳ Asking Claude for its own notes…',
    ].join('\n'),
    v.text,
  );
  eq(v.pendingLine, '⏳ Asking Claude for its own notes…');
  ok(v.text.endsWith(v.pendingLine), 'the live line must be last, or an edit would reflow the message');
});

t('★ /engine claude has a session line and no sandbox: it can write anywhere', () => {
  const v = switchView({
    engine: 'claude',
    handoff: { bits: 'goal, 2 decisions', from: 'codex', ageSec: 22 },
    thread: { continuing: true },
    capture: { engine: 'codex' },
  });
  eq(
    v.text,
    [
      '🤖 Claude is on.',
      '📎 Handoff: goal, 2 decisions · from Codex, 22s ago',
      '💬 Session: continuing · /new for a fresh one',
      '⏳ Asking Codex for its own notes…',
    ].join('\n'),
    v.text,
  );
});

t('a Claude session never claims an age, because nothing records when it started', () => {
  const v = switchView({ engine: 'claude', thread: { continuing: true, ageSec: 9999 } });
  ok(v.text.includes('💬 Session: continuing · /new for a fresh one'), v.text);
  ok(!/\(/.test(v.text.split('\n')[1] || ''), v.text);
});

t('★ fresh says so on the first line and carries no handoff line at all', () => {
  const v = switchView({
    engine: 'codex',
    fresh: true,
    handoff: { bits: 'goal', from: 'claude', ageSec: 1 },
    thread: { continuing: true, ageSec: 107 * 60 },
    sandbox: { sandbox: 'workspace-write', cwd: '~/dev' },
  });
  eq(
    v.text,
    [
      '🧠 Codex is on. Fresh start, no handoff.',
      '🧵 Thread: continuing (1h 47m) · /new for a fresh one',
      '🔒 Sandbox: workspace-write in ~/dev',
    ].join('\n'),
    v.text,
  );
  eq(v.pendingLine, null);
});

t('★ nothing recorded says which of the two silences this is', () => {
  const v = switchView({
    engine: 'codex',
    thread: { continuing: false },
    sandbox: { sandbox: 'workspace-write', cwd: '~/dev' },
  });
  eq(
    v.text,
    ['🧠 Codex is on. No handoff yet, nothing recorded on this chat.', '🧵 Thread: fresh', '🔒 Sandbox: workspace-write in ~/dev'].join('\n'),
    v.text,
  );
});

t('★ already on it is exactly one line', () => {
  eq(switchView({ engine: 'codex', already: true }).text, '🧠 Codex is already on.');
  eq(switchView({ engine: 'claude', already: true }).text, '🤖 Claude is already on.');
  eq(switchView({ engine: 'codex', already: true }).pendingLine, null);
});

t('the background lane gets its own two lines and never a handoff', () => {
  const v = switchView({ engine: 'codex', scope: 'bg' });
  eq(v.text.split('\n')[0], '🧠 Background jobs now run on Codex.');
  ok(v.text.includes('claude:'), v.text);
  eq(switchView({ engine: 'codex', scope: 'bg', already: true }).text, '🧠 Background jobs already run on Codex.');
});

t('★ the extra lines appear only when they are true, one line each', () => {
  const plain = switchView({ engine: 'codex', thread: { continuing: false } });
  eq(plain.text.split('\n').length, 2, plain.text);
  const loud = switchView({
    engine: 'codex',
    thread: { continuing: false },
    warnings: {
      unreachable: { count: 2, root: '~/dev' },
      missingTools: ['subagents', 'skills', 'MCP'],
      usage: { percent: 82, label: '5h', resetsAt: '03:15' },
    },
  });
  ok(loud.text.includes('⚠️ 2 files outside ~/dev, Codex cannot reach them (named in the handoff)'), loud.text);
  ok(loud.text.includes('⚠️ Not on Codex: subagents, skills, MCP (named in the handoff)'), loud.text);
  ok(loud.text.includes('📊 Codex 5h window 82%, resets 03:15'), loud.text);
});

t('one unreachable file is singular, and the window stays quiet below 80', () => {
  const one = switchView({ engine: 'codex', warnings: { unreachable: { count: 1, root: '~/dev' } } });
  ok(one.text.includes('⚠️ 1 file outside ~/dev, Codex cannot reach it'), one.text);
  const quiet = switchView({ engine: 'codex', warnings: { usage: { percent: 79, label: '5h' } } });
  ok(!quiet.text.includes('window'), quiet.text);
});

t('a stale handoff says so on its own line rather than in a paragraph under it', () => {
  const v = switchView({ engine: 'codex', handoff: { bits: 'goal', from: 'claude', ageSec: 9 * 3600, stale: true } });
  ok(v.text.includes('📎 Handoff: goal · from Claude, 9h 0m ago (stale)'), v.text);
});

t('★ the capture resolves to exactly one line, and every one names the engine', () => {
  eq(resolveCaptureLine({ ok: true, engine: 'claude' }), "✅ Claude's notes added to the handoff");
  eq(resolveCaptureLine({ ok: true, engine: 'codex' }), "✅ Codex's notes added to the handoff");
  eq(
    resolveCaptureLine({ engine: 'claude', reason: 'timeout' }),
    '↪️ Using the recorded handoff (Claude did not answer in time)',
  );
  eq(
    resolveCaptureLine({ engine: 'claude', reason: 'walled', until: '12:22' }),
    '↪️ Using the recorded handoff (Claude is walled until 12:22)',
  );
  // A wall with no known reset still says wall rather than inventing a clock.
  eq(resolveCaptureLine({ engine: 'codex', reason: 'walled' }), '↪️ Using the recorded handoff (Codex is walled)');
  eq(
    resolveCaptureLine({ engine: 'codex', reason: 'superseded' }),
    '↪️ Using the recorded handoff (the next message already carried it)',
  );
  eq(resolveCaptureLine({ engine: 'codex' }), '↪️ Using the recorded handoff (Codex could not write one)');
  eq(resolveCaptureLine({}), '↪️ Using the recorded handoff (Claude could not write one)');
});

t('★ settling replaces ONE line and leaves the rest byte for byte', () => {
  const v = switchView({
    engine: 'codex',
    handoff: { bits: 'goal', from: 'claude', ageSec: 1 },
    thread: { continuing: false },
    capture: { engine: 'claude' },
  });
  const settled = settleSwitchText(v.text, v.pendingLine, resolveCaptureLine({ ok: true, engine: 'claude' }));
  eq(settled.split('\n').length, v.text.split('\n').length);
  eq(settled.split('\n').slice(0, -1).join('\n'), v.text.split('\n').slice(0, -1).join('\n'));
  eq(settled.split('\n').at(-1), "✅ Claude's notes added to the handoff");
});

t('and settling a message that never promised anything is a no-op, not an edit', () => {
  eq(settleSwitchText('🧠 Codex is on.', null, 'anything'), null, 'it would have sent Telegram an identical body');
  eq(settleSwitchText('🧠 Codex is on.', '⏳ nope', 'anything'), null);
});

t('★ no shape this command can produce carries an em or en dash', () => {
  const dashes = /[\u2013\u2014]/;
  const shapes = [
    switchView({ engine: 'codex', handoff: { bits: 'goal, 5 decisions', from: 'claude', ageSec: 2 }, thread: { continuing: true, ageSec: 6420 }, sandbox: { sandbox: 'workspace-write', cwd: '~/dev' }, capture: { engine: 'claude' } }),
    switchView({ engine: 'claude', handoff: { bits: 'goal', from: 'codex', ageSec: 22, stale: true }, thread: { continuing: true }, capture: { engine: 'codex' } }),
    switchView({ engine: 'codex', fresh: true, thread: { continuing: false }, sandbox: { sandbox: 'read-only', cwd: '~/dev' } }),
    switchView({ engine: 'codex', already: true }),
    switchView({ engine: 'claude', scope: 'bg' }),
    switchView({ engine: 'codex', warnings: { unreachable: { count: 2, root: '~/dev' }, missingTools: ['subagents'], usage: { percent: 91, label: 'weekly', resetsAt: '03:15' } } }),
  ];
  for (const s of shapes) ok(!dashes.test(s.text), s.text);
  for (const r of ['ok', 'timeout', 'walled', 'superseded', 'failed']) {
    const line = resolveCaptureLine({ ok: r === 'ok', engine: 'claude', reason: r, until: '12:22' });
    ok(!dashes.test(line), line);
  }
  ok(!dashes.test(engineView({ chat: { engineChat: 'codex' }, codexUsage: { percent: 99, label: '5h', resetsAt: '03:15' } })));
});

// ---------------------------------------------------------------------------
// codexTomlModel: the CLI's own default, for a surface that has to NAME it.
//
// Only consulted when /codex model and config.json both resolve to null. The
// bridge omits --model then, so what the run actually uses is whatever
// ~/.codex/config.toml says, and the worker card would otherwise print
// "default" over a machine that has pinned a model for two months.
// ---------------------------------------------------------------------------

t('codexTomlModel: reads a top-level model, single or double quoted', () => {
  eq(codexTomlModel('model = "gpt-6-astra"'), 'gpt-6-astra');
  eq(codexTomlModel("model = 'gpt-6-astra'"), 'gpt-6-astra');
  eq(codexTomlModel('# a comment\n\nmodel = "gpt-6-astra"  # inline\n'), 'gpt-6-astra');
});

t('★ codexTomlModel stops at the first section header', () => {
  // A `model` under [profiles.x] or [mcp_servers.y] is a DIFFERENT key. Printing
  // it on a card would be a confident wrong answer, which is worse than
  // "default" on the one line whose job is naming the engine.
  eq(codexTomlModel('[profiles.fast]\nmodel = "gpt-5.6-sol"'), null);
  eq(codexTomlModel('model = "top"\n[profiles.fast]\nmodel = "nested"'), 'top', 'the top-level one still wins');
});

t('codexTomlModel: nothing to read is null, never a throw', () => {
  eq(codexTomlModel(''), null);
  eq(codexTomlModel(null), null);
  eq(codexTomlModel(undefined), null);
  eq(codexTomlModel('model = ""'), null, 'an empty value is not a model name');
  eq(codexTomlModel('project_doc_max_bytes = 262144\n[mcp_servers.x]\nurl = "y"'), null, 'the real config on this Mac');
});

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all engine-state tests pass');
