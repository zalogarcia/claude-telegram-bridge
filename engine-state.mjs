// ---------------------------------------------------------------------------
// WHICH ENGINE, PER LANE, AND WHAT CODEX RUNS WITH
//
// The bridge was built on Claude with Codex bolted on as a fallback. That is
// backwards for anyone whose primary engine IS Codex, and Leash will have those
// users: some with a ChatGPT subscription and no Claude account at all. So the
// engine is a per-lane SETTING here, not a rescue path:
//
//   config.json  engine: { chat, bg }   the install-wide default, set once
//   /engine codex | claude              this chat's chat-lane engine
//   /engine bg codex | claude           this chat's background default
//   codex: / claude: prefix,            per job, beats everything above
//   --engine codex|claude
//
// Resolution order, highest first: an explicit per-job engine, then the chat's
// stored setting, then the config default, then claude. Availability can veto
// any of them (a missing binary is not a preference), and the rate-limit
// fallback can promote claude to codex, but ONLY for a lane that expressed no
// preference and only while every Claude account is walled.
//
// THE LOOP GUARD is structural rather than a check: nothing in this module can
// see whether a previous run FAILED. A Codex failure therefore cannot make the
// next decision come out claude, and a Claude failure cannot make it come out
// codex except through rotationPausedUntil, which only a real account wall
// sets. There is no input here to ping-pong on.
//
// Pure: no filesystem, no process, no clock of its own. bridge.mjs passes the
// state and the availability in, which is what makes engine-state.test.mjs able
// to prove a Codex-first boot with no `claude` binary anywhere.
// ---------------------------------------------------------------------------

import { handoffLine, handoffBits } from './engine-handoff.mjs';

export const ENGINES = ['claude', 'codex'];
// The ChatGPT window is only worth a line when it is close enough to matter.
// Below this it is noise on a view that answers a different question.
export const CODEX_USAGE_WARN_PCT = 80;
export const DEFAULT_ENGINES = Object.freeze({ chat: 'claude', bg: 'claude' });

/**
 * The reasoning-effort values the model actually accepts.
 *
 * NOT guessed and not a subset chosen for taste: measured 2026-09-03 by sending
 * a one-token prompt with each value and reading the API's own error. The enum
 * the endpoint publishes is none/minimal/low/medium/high/xhigh/max, and
 * `minimal` comes back "not supported with the 'gpt-5.6-sol' model", so it is
 * left out. The CLI validates none of this locally: an unknown value is a
 * billed round trip that ends in a 400, which is exactly why the check lives
 * here instead.
 */
export const CODEX_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// `codex: do the thing` / `claude: do the thing`. The engine sibling of `bg:`.
// bg.mjs carries its own copy because it imports nothing; the tests assert the
// two behave identically.
export const ENGINE_PREFIX_RE = /^\s*(codex|claude):\s*/i;

export function normalizeEngine(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ENGINES.includes(v) ? v : null;
}

/**
 * The install-wide defaults out of config.json.
 *
 * Shape: `engine: { chat: "codex", bg: "codex" }`. A Codex-first user sets that
 * once and never types /engine. Anything unrecognised falls back to claude
 * rather than throwing: a typo in a config file must not stop the daemon
 * booting, it must just not change anything.
 */
export function engineDefaults(config = {}) {
  const raw = config?.engine;
  if (typeof raw === 'string') {
    // `engine: "codex"` is the obvious thing to write, so accept it as "both".
    const both = normalizeEngine(raw);
    return both ? { chat: both, bg: both } : { ...DEFAULT_ENGINES };
  }
  return {
    chat: normalizeEngine(raw?.chat) || DEFAULT_ENGINES.chat,
    bg: normalizeEngine(raw?.bg) || DEFAULT_ENGINES.bg,
  };
}

// The chat's own setting when it has one, the config default otherwise. Kept as
// two one-liners rather than one function with a lane argument because every
// call site knows statically which lane it is asking about.
export function chatEngine({ chat = {}, config = {} } = {}) {
  return normalizeEngine(chat.engineChat) || engineDefaults(config).chat;
}
export function bgEngine({ chat = {}, config = {} } = {}) {
  return normalizeEngine(chat.engineBg) || engineDefaults(config).bg;
}

/**
 * WHICH ENGINE RUNS THIS. The one decision every entry point shares.
 *
 * `lane`: 'chat' | 'bg'.
 * `forcedEngine`: from a `codex:`/`claude:` prefix or `--engine`. Beats
 *   everything, including a wall and including the config.
 * `claudeAvailable` / `codexAvailable`: is the binary on PATH. A preference for
 *   an engine that is not installed is not a preference, it is a crash waiting
 *   to happen, so availability vetoes last and says so.
 *
 * Returns { engine, reason, pausedUntil, error }:
 *   reason 'explicit'       asked for by name
 *          'setting'        this chat's /engine choice
 *          'config'         the install default
 *          'claude_limited' the rate-limit fallback promoted it
 *          'claude_missing' there is no claude binary to run
 *          null             plain claude, nothing to explain
 *   error  'codex_missing' | 'claude_missing' when NOTHING can run it.
 *
 * A CODEX LANE NEVER READS THE WALL. rotationPausedUntil is an Anthropic
 * account limit; it has no bearing on a lane that is not going to touch an
 * Anthropic account. That is what makes "a Claude limit must never block a
 * Codex chat lane" true by construction rather than by a check somewhere else.
 */
export function resolveEngine({
  lane = 'chat',
  forcedEngine = null,
  chat = {},
  config = {},
  claudeAvailable = true,
  codexAvailable = true,
  rotationPausedUntil = 0,
  now = Date.now(),
  codexFallback = true,
} = {}) {
  const forced = normalizeEngine(forcedEngine);
  const settled = lane === 'bg' ? bgEngine({ chat, config }) : chatEngine({ chat, config });
  const explicitlySet = Boolean(forced) || Boolean(normalizeEngine(lane === 'bg' ? chat.engineBg : chat.engineChat));
  const wanted = forced || settled;

  if (wanted === 'codex') {
    if (!codexAvailable) return { engine: null, reason: null, pausedUntil: null, error: 'codex_missing' };
    const reason = forced ? 'explicit' : explicitlySet ? 'setting' : 'config';
    return { engine: 'codex', reason, pausedUntil: null, error: null };
  }

  // Wanted claude from here down.
  const paused = Number(rotationPausedUntil) > Number(now) ? Number(rotationPausedUntil) : 0;

  if (!claudeAvailable) {
    // No binary at all. Codex is not a "fallback" in this case, it is the only
    // engine this machine has, so it runs whatever the caller's preference was.
    if (!codexAvailable) return { engine: null, reason: null, pausedUntil: null, error: 'claude_missing' };
    return { engine: 'codex', reason: 'claude_missing', pausedUntil: null, error: null };
  }

  // The rate-limit fallback. Only for a lane that expressed NO preference: a
  // job pinned to claude by name waits for the reset exactly as it used to.
  if (!forced && paused && codexFallback && codexAvailable) {
    return { engine: 'codex', reason: 'claude_limited', pausedUntil: paused, error: null };
  }
  return {
    engine: 'claude',
    reason: forced ? 'explicit' : explicitlySet ? 'setting' : null,
    pausedUntil: paused || null,
    error: null,
  };
}

/**
 * `/engine`, `/engine codex`, `/engine bg claude`, `/engine codex fresh`.
 *
 * Returns { show } for the bare command, { scope, engine, fresh } for a set, or
 * { error } with the one line to send back. Never throws.
 *
 * `fresh` is the opt-out from the context handoff: switch, but hand the
 * incoming engine nothing. It is a trailing token rather than a flag because
 * this is typed on a phone, and it is only ever legal AFTER an engine name:
 * `/engine fresh` is a request to switch to an engine called "fresh".
 */
export function parseEngineCommand(arg) {
  const parts = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { show: true };
  const usage = 'Usage: /engine [bg] claude|codex [fresh], or /engine alone to see both lanes.';
  let scope = 'chat';
  let i = 0;
  const head = parts[0].toLowerCase();
  if (head === 'bg' || head === 'background') {
    scope = 'bg';
    i = 1;
  } else if (head === 'chat') {
    i = 1;
  }
  if (i >= parts.length) return { error: `Which engine? ${usage}` };
  const engine = normalizeEngine(parts[i]);
  if (!engine) return { error: `"${parts[i]}" is not an engine. ${usage}` };
  let fresh = false;
  if (parts.length > i + 1) {
    if (parts.length === i + 2 && parts[i + 1].toLowerCase() === 'fresh') fresh = true;
    else return { error: `Too many arguments. ${usage}` };
  }
  return { scope, engine, fresh };
}

/**
 * CAN THE OUTGOING ENGINE WRITE ITS OWN HANDOFF (rung 2), or does the switch
 * take the deterministic one (rung 3)?
 *
 * One tested function rather than an if-chain in the /engine arm, because every
 * branch here is a way the switch could have hung: the whole point of the
 * ladder is that a handoff never waits on a wall and never spawns into one. The
 * owner is usually switching BECAUSE something is wrong with the engine he is
 * leaving, which is exactly when asking it for a favour fails.
 *
 * Returns { rung, skip: [reasons] }. rung 2 only when every condition is clear.
 */
export function canProduceHandoff({
  engine = 'claude',
  available = true,
  pausedUntil = 0,
  authState = null,
  laneBusy = false,
  captureTurn = true,
  hasContext = true,
  now = Date.now(),
} = {}) {
  const skip = [];
  if (!captureTurn) skip.push('the capture turn is off (handoffCaptureTurn)');
  if (!available) skip.push(`there is no \`${engine}\` binary`);
  // No session and no thread means nothing to summarise. Asking anyway spawns a
  // COLD run: a model with no context at all, told to describe work it has
  // never seen, billed, and (under an output schema) answering in shape rather
  // than admitting it cannot. The gate decides this, not the spawner, or
  // /engine promises a capture turn that silently never runs.
  if (!hasContext) skip.push(`there is no ${engine} conversation to summarise`);
  if (Number(pausedUntil) > Number(now)) skip.push(`${engine} is walled`);
  // 'none' and 'broken' are readCodexIdentity's own states; 'auth' is what
  // classifyCodexFailure returns after a run failed on credentials.
  if (['none', 'broken', 'auth'].includes(String(authState || ''))) skip.push(`${engine} auth is broken`);
  if (laneBusy) skip.push('the lane is busy with a turn that will not settle in time');
  return skip.length ? { rung: 3, skip } : { rung: 2, skip: [] };
}

// `/codex model <name>`: any string, because the CLI has no way to list the
// models an account can reach and a local allowlist would go stale the week
// OpenAI ships one. An unknown name comes back as Codex's own error text on the
// first run, which is more accurate than anything this file could say.
export function parseCodexModelArg(arg) {
  const v = String(arg ?? '').trim();
  if (!v) return { show: true };
  if (/^(default|reset|clear)$/i.test(v)) return { clear: true };
  if (/\s/.test(v)) return { error: 'A model name has no spaces. Usage: /codex model <name> | default' };
  if (v.startsWith('-')) return { error: 'A model name cannot start with "-". Usage: /codex model <name> | default' };
  return { model: v };
}

// `/codex effort <value>`: allowlisted, unlike the model. The values are the
// model's own published enum (see CODEX_EFFORTS), so a bad one can be refused
// here for free instead of costing a billed round trip that ends in a 400.
/**
 * `/codex network on|off`.
 *
 * Its own command rather than a second meaning for /yolo: "may it write" and
 * "may it reach the internet" are different questions, and the second one is
 * the one that turns a prompt-injection into an exfiltration.
 */
export function parseCodexNetworkArg(arg) {
  const v = String(arg ?? '').trim().toLowerCase();
  if (!v) return { show: true };
  if (['on', 'true', 'yes', 'enable', 'enabled'].includes(v)) return { network: true };
  if (['off', 'false', 'no', 'disable', 'disabled'].includes(v)) return { network: false };
  return { error: `"${v}" is not on or off. Usage: /codex network on|off` };
}

export function parseCodexEffortArg(arg) {
  const v = String(arg ?? '').trim().toLowerCase();
  if (!v) return { show: true };
  if (/^(default|reset|clear)$/i.test(v)) return { clear: true };
  if (!CODEX_EFFORTS.includes(v)) {
    return { error: `"${v}" is not a reasoning effort. Accepted: ${CODEX_EFFORTS.join(', ')} (or "default").` };
  }
  return { effort: v };
}

// The Codex model and effort in force for this chat, with the config default
// underneath. `null` means "whatever the CLI picks", which is what "default"
// prints as everywhere it is shown.
export function codexSettings({ chat = {}, config = {} } = {}) {
  const model = (typeof chat.codexModel === 'string' && chat.codexModel.trim()) || config.codexModel || null;
  const effortRaw = (typeof chat.codexEffort === 'string' && chat.codexEffort.trim()) || config.codexEffort || null;
  const effort = effortRaw && CODEX_EFFORTS.includes(String(effortRaw).toLowerCase()) ? String(effortRaw).toLowerCase() : null;
  return { model: model || null, effort };
}

/**
 * THE CHAT LANE'S SANDBOX, from the same /yolo switch Claude's runs use.
 *
 * yolo on  -> workspace-write, network on. The Codex equivalent of Claude's
 *             --dangerously-skip-permissions, and NARROWER than it: Claude's
 *             chat lane can write anywhere on this Mac, Codex can write only
 *             inside the chat cwd (measured: a write to $HOME from a run rooted
 *             at /tmp was refused by the sandbox).
 * yolo off -> read-only. Nothing is written at all.
 *
 * `--approve-for-me` is deliberately NOT used, and this is the one place it
 * would have gone. Two measured reasons, both 2026-09-03: `codex exec` refuses
 * `--sandbox` and `--approve-for-me` together (instant exit 2), and on its own
 * it auto-approves the model's OWN escalation requests, which let a run rooted
 * at /tmp write a file into $HOME. It is a soft bypass flag; the confinement
 * this lane advertises would be a lie with it on.
 */
export function codexChatSandbox({ yolo = true, network = true } = {}) {
  // `network` defaults ON so nothing changes for an existing install, and it is
  // a SEPARATE switch from /yolo for one reason: workspace-write plus network
  // is the exfiltration surface, and the engine handoff is the first thing this
  // bridge injects into that run which a model wrote. /codex network off, and
  // the automatic off for the first handoff-carrying turn, are the two ways to
  // narrow it without giving up write access.
  return yolo ? { sandbox: 'workspace-write', network: network !== false } : { sandbox: 'read-only', network: false };
}

// ---------------------------------------------------------------------------
// CLAUDE-ONLY COMMANDS
//
// With engine.chat = codex and no `claude` binary on the machine, the daemon
// still has to boot and still has to answer. These commands are the ones whose
// whole subject is a Claude session or a Claude account: answering them with a
// session that cannot start is worse than saying so in one line.
// ---------------------------------------------------------------------------
export const CLAUDE_ONLY_COMMANDS = Object.freeze([
  '/compact', // summarises a Claude session
  '/context', // a Claude context window
  '/usage', // Anthropic plan windows, per account
]);
// NOT on the list, deliberately: `/account` and `/accounts`. They render the
// CODEX account block too, and on a Codex-first install that block is the whole
// point of the command: it is where a ChatGPT plan's 5-hour and weekly windows
// live. renderAccountView shows the Codex half even with zero Claude accounts
// captured, which is exactly the state that install is in.

export function isClaudeOnlyCommand(cmd) {
  return CLAUDE_ONLY_COMMANDS.includes(String(cmd || '').toLowerCase());
}

/**
 * A voice note arrived and there is no way to transcribe it.
 *
 * `transcribeVoice` returns null with no OpenAI API key, and the null path fell
 * through with NO message at all: the run just got a prompt naming an .ogg on
 * disk. Neither engine can hear one (isCodexImage rejects .ogg, so Codex is not
 * even handed the file), and a ChatGPT-subscription Codex install has no OpenAI
 * API key by definition, so this is the DEFAULT state for a Codex-first Leash
 * user and "just talk to it" is a headline feature.
 *
 * Both fixes, because they are genuinely different trades: the key is the real
 * one, and /engine claude is the one that helps for the next thirty seconds.
 */
export function voiceUntranscribedLine(engine = 'claude', { reason = 'no_key' } = {}) {
  // One fact per line, none of them 95 characters wide. The cause, then what
  // the engine is actually holding, then the two fixes: the key is the real
  // one, and typing it is the one that helps in the next thirty seconds.
  const lines = ['🎙️ I cannot hear that voice note'];
  if (reason === 'no_key') {
    lines.push('No OPENAI_API_KEY on this machine, and');
    lines.push('whisper is what turns audio into words.');
  } else {
    lines.push('The transcription failed.');
  }
  lines.push(`${engine === 'codex' ? '🧠 Codex' : '🤖 Claude'} only has the file path.`);
  // The key is named on BOTH paths: a failed whisper call and a missing key
  // leave him in the same place, and a wrong key is the most common cause of
  // the first. Only the no_key line claims it is absent.
  lines.push(reason === 'no_key' ? 'Set the key, or type the message instead.' : 'Check OPENAI_API_KEY, or type it instead.');
  return lines.join('\n');
}

export function claudeMissingLine(cmd) {
  // Three lines rather than two: `cmd` is variable-length, and folded into the
  // first line a long one (/autopilot-merge) pushes it past the wrap.
  return [`${cmd} needs Claude`, 'No claude binary on this machine.', 'This install is Codex-first (/engine).'].join('\n');
}

/**
 * What a lane WILL run on, availability included.
 *
 * `chatEngine`/`bgEngine` answer "what is this lane set to"; this answers "what
 * will actually happen". They differ on exactly one machine, and it is the one
 * this whole file exists for: with no `claude` binary and no config key, the
 * setting reads claude and every message runs on Codex. Every VIEW has to show
 * the second answer, or /model quietly sets a Claude model nothing will use and
 * /status shows no thread age for a lane that has a thread.
 *
 * The rate-limit wall is deliberately NOT an input: it is a transient condition,
 * not a change of engine, and a lane whose name flipped for an hour would make
 * /model mean two different things depending on the time of day.
 */
export function effectiveEngine({ lane = 'chat', chat = {}, config = {}, claudeAvailable = true, codexAvailable = true } = {}) {
  const d = resolveEngine({ lane, chat, config, claudeAvailable, codexAvailable, rotationPausedUntil: 0 });
  // A refused decision (the wanted engine is not installed) still has a name to
  // print: what the lane is SET to, even though nothing can run it.
  return d.engine || (lane === 'bg' ? bgEngine({ chat, config }) : chatEngine({ chat, config }));
}

// ---------------------------------------------------------------------------
// THE /engine VIEW
// ---------------------------------------------------------------------------

const engineGlyph = (e) => (e === 'codex' ? '🧠' : '🤖');
const engineName = (e) => (e === 'codex' ? 'Codex' : 'Claude');
const orDefault = (v) => v || 'default';

/**
 * ONE LINE SHAPE FOR BOTH ENGINE MESSAGES: icon, label, value.
 *
 * `/engine` and the switch confirmation answer the same question a second
 * apart, and they used to look like two different products: one a table of
 * lowercase key/value pairs, the other a paragraph. Same glyph vocabulary in
 * both, so a phone reads either one by scanning the left column.
 *
 *   🧠 🤖  which engine        📎 handoff      🧵 Codex thread
 *   💬 Claude session          🔒 sandbox      ⚙️ model and effort
 *   📊 usage window            ⚠️ a caveat     ⏳ waiting     ↪️ ✅ resolved
 */
function threadLine(engine, { continuing = false, ageSec = null, freshNote = '' } = {}) {
  const label = engine === 'codex' ? '🧵 Thread' : '💬 Session';
  if (!continuing) return `${label}: fresh${freshNote ? ` ${freshNote}` : ''}`;
  // The age is a Codex thread's own; a Claude session carries no start stamp,
  // so claiming one would be inventing it.
  const age = engine === 'codex' && Number(ageSec) > 0 ? ` (${fmtAge(ageSec)})` : '';
  return `${label}: continuing${age} · /new for a fresh one`;
}

// Under ten seconds the switch IS the moment the handoff was recorded, and
// "0s ago" reads like a bug. Past that, say the number.
const handoffAgo = (ageSec) => (Number(ageSec) < 10 ? 'just now' : `${fmtAge(ageSec)} ago`);

/**
 * THE EXTRA LINES, and each one is on the message only when it is TRUE.
 *
 * Not a debug block: every one of these changes what the owner should do next.
 * An unreachable path means the incoming engine will fail on that file; a
 * missing tool means it will answer without one; a window at 82% means the
 * engine he just switched to may stop mid-afternoon.
 */
function switchWarningLines(engine, warnings = {}) {
  const out = [];
  const un = warnings?.unreachable;
  if (Number(un?.count) > 0) {
    const n = Number(un.count);
    out.push(
      `⚠️ ${n} file${n === 1 ? '' : 's'} outside ${un.root}, ${engineName(engine)} cannot reach ${n === 1 ? 'it' : 'them'} (named in the handoff)`,
    );
  }
  if (warnings?.missingTools?.length) {
    out.push(`⚠️ Not on ${engineName(engine)}: ${warnings.missingTools.join(', ')} (named in the handoff)`);
  }
  const pct = Number(warnings?.usage?.percent);
  if (Number.isFinite(pct) && pct >= CODEX_USAGE_WARN_PCT) {
    const u = warnings.usage;
    out.push(
      `📊 ${engineName(engine)} ${u.label || '5h'} window ${Math.round(pct)}%${u.resetsAt ? `, resets ${u.resetsAt}` : ''}`,
    );
  }
  return out;
}

/**
 * THE /engine SWITCH CONFIRMATION. Pure, so the shape is provable without a
 * daemon, a Telegram token or a model call.
 *
 * It replaced a five-line paragraph that said "recorded, 0 tokens", named a
 * rung, and then sent a SECOND message up to 25 seconds later when the capture
 * turn landed. The owner's words on the screenshot of it: "this msg is too big of a
 * block with no feedback". Both halves are addressed here:
 *
 *   COMPACT   one short phrase per line, each with its own icon, nothing that
 *             is not true right now. Token counts live in /usage; the rung is a
 *             mechanism and is said once, in the line that resolves.
 *   LIVE      `pendingLine` is the ⏳ line, and it is the LAST line on purpose:
 *             the caller keeps the message id and edits that one line in place
 *             when the capture settles (resolveCaptureLine), so the feedback
 *             lands on the message he is already looking at. No second message.
 *
 * When the ladder skips the capture turn, `capture` is null, there is no ⏳
 * line, and nothing will ever edit the message: what it says at send time is
 * final. That is why the skip REASON is not on it. It goes to the daemon log.
 *
 * Returns { text, pendingLine }. pendingLine is null when nothing is pending.
 */
export function switchView({
  engine = 'claude',
  scope = 'chat',
  already = false,
  fresh = false,
  handoff = null, // { bits, from, ageSec, stale }
  thread = null, // { continuing, ageSec }
  sandbox = null, // { sandbox, cwd }: Codex only, Claude's chat lane has no box
  capture = null, // { engine }: the engine being asked for its own notes
  warnings = {},
} = {}) {
  const glyph = engineGlyph(engine);
  const name = engineName(engine);

  if (scope === 'bg') {
    const other = engine === 'codex' ? 'claude' : 'codex';
    const lines = [`${glyph} Background jobs ${already ? 'already run' : 'now run'} on ${name}.`];
    if (!already) lines.push(`💡 A \`${other}:\` prefix or --engine ${other} still pins one job back.`);
    return { text: lines.join('\n'), pendingLine: null };
  }

  // Nothing changed, so there is nothing to say beyond that. The old message
  // printed the whole block here, which read as a switch that had happened.
  if (already) return { text: `${glyph} ${name} is already on.`, pendingLine: null };

  const head = fresh
    ? `${glyph} ${name} is on. Fresh start, no handoff.`
    : handoff
      ? `${glyph} ${name} is on.`
      : `${glyph} ${name} is on. No handoff yet, nothing recorded on this chat.`;
  const lines = [head];
  if (handoff && !fresh) {
    lines.push(
      `📎 Handoff: ${handoff.bits || 'the working directory only'} · from ${engineName(handoff.from)}, ${handoffAgo(handoff.ageSec)}${handoff.stale ? ' (stale)' : ''}`,
    );
  }
  if (thread) lines.push(threadLine(engine, thread));
  if (sandbox?.sandbox) lines.push(`🔒 Sandbox: ${sandbox.sandbox}${sandbox.cwd ? ` in ${sandbox.cwd}` : ''}`);
  lines.push(...switchWarningLines(engine, warnings));

  const pendingLine = capture ? `⏳ Asking ${engineName(capture.engine)} for its own notes…` : null;
  if (pendingLine) lines.push(pendingLine);
  return { text: lines.join('\n'), pendingLine };
}

/**
 * WHAT THE ⏳ LINE BECOMES. Exactly one of these, always, and never a second
 * message: the capture turn either improved the handoff or it did not, and the
 * owner needs to know which before he types his next message.
 *
 * `reason` is the failure class, and each one is a different fact:
 *   timeout     it is still running and the deadline passed
 *   walled      it died on a usage limit, with the reset time when we know it
 *   superseded  he already sent the next message, which consumed the recorded
 *               handoff; a better one now would be context for a turn that has
 *               already happened
 *   failed      anything else (auth, a dead thread, a crash)
 */
export function resolveCaptureLine({ ok = false, engine = 'claude', reason = 'failed', until = null } = {}) {
  const name = engineName(engine);
  if (ok) return `✅ ${name}'s notes added to the handoff`;
  const why =
    reason === 'timeout'
      ? `${name} did not answer in time`
      : reason === 'walled'
        ? `${name} is walled${until ? ` until ${until}` : ''}`
        : reason === 'superseded'
          ? 'the next message already carried it'
          : `${name} could not write one`;
  return `↪️ Using the recorded handoff (${why})`;
}

/**
 * The edited text: the same message with its pending line replaced.
 *
 * Returns null when there is nothing to edit, so the caller can skip the API
 * call rather than send Telegram an identical body (which is a 400 it would
 * then have to swallow).
 */
export function settleSwitchText(text, pendingLine, resolvedLine) {
  const src = String(text ?? '');
  if (!pendingLine || !resolvedLine || !src.includes(pendingLine)) return null;
  return src.replace(pendingLine, resolvedLine);
}

/**
 * What `/engine` prints: both lanes, where each value came from, and everything
 * a Codex run would be started with right now. One view, because "which engine
 * am I talking to and what is it set to" is one question.
 */
export function engineView({
  chat = {},
  config = {},
  claudeAvailable = true,
  codexAvailable = true,
  threadAgeSec = null,
  cwd = null,
  handoff = null,
  codexUsage = null,
  now = Date.now(),
} = {}) {
  const defaults = engineDefaults(config);
  const chatEng = effectiveEngine({ lane: 'chat', chat, config, claudeAvailable, codexAvailable });
  const bgEng = effectiveEngine({ lane: 'bg', chat, config, claudeAvailable, codexAvailable });
  const src = (stored, dflt, effective, wanted) =>
    effective !== wanted
      ? `no ${wanted} binary, so everything runs here`
      : normalizeEngine(stored)
        ? '/engine'
        : `config default (${dflt})`;
  const { model, effort } = codexSettings({ chat, config });
  const box = codexChatSandbox({ yolo: chat.yolo !== false });
  // SAME LINE STYLE AS THE SWITCH CONFIRMATION: icon, label, value. The two
  // messages answer the same question a second apart and used to look like two
  // different products.
  const lines = [
    `${engineGlyph(chatEng)} Chat lane: ${engineName(chatEng)} · ${src(chat.engineChat, defaults.chat, chatEng, chatEngine({ chat, config }))}`,
    `${engineGlyph(bgEng)} Background: ${engineName(bgEng)} · ${src(chat.engineBg, defaults.bg, bgEng, bgEngine({ chat, config }))}`,
    `⚙️ Codex model: ${orDefault(model)} · effort: ${orDefault(effort)}`,
    `🔒 Sandbox: ${box.sandbox}${box.network ? ' + network' : ''}${cwd ? ` in ${cwd}` : ''} · /yolo ${chat.yolo !== false ? 'on' : 'off'}`,
  ];
  if (chatEng === 'codex') {
    lines.push(
      threadLine('codex', {
        continuing: threadAgeSec != null,
        ageSec: threadAgeSec,
        freshNote: '(the next message starts one)',
      }),
    );
  }
  // THE CHATGPT WINDOW, but only when it is worth an interruption. The snapshot
  // is already cached for 60s so reading it is free, and printing "12%" on every
  // /engine is noise; at 80 and above it is the number that decides whether a
  // switch TO Codex is a good idea in the next hour.
  lines.push(...switchWarningLines('codex', { usage: codexUsage }));
  lines.push(handoffLine(handoff, { toEngine: chatEng, now }));
  if (!claudeAvailable) lines.push('⚠️ No `claude` binary on this machine: Claude-only commands will say so.');
  if (!codexAvailable) lines.push('⚠️ No `codex` binary on this machine: every Codex path will say so.');
  lines.push(
    '',
    'Set: /engine claude|codex (this chat) · /engine bg claude|codex (handed-off jobs)',
    `     /engine ${chatEng === 'codex' ? 'claude' : 'codex'} fresh skips the handoff · /new clears everything`,
    'Per job: a `codex:` or `claude:` prefix, or bg.mjs --engine <name>, beats both.',
  );
  return lines.join('\n');
}

// "12m" / "3h 5m" / "45s". Small enough to inline, and it has to match nothing
// else, so it does not import the daemon's formatter.
export function fmtAge(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * The one line each lane contributes to /status.
 *
 * Only shown when something is NOT the boring default: a Claude-on-both install
 * gets nothing new in its status view, and a Codex-first one gets both lanes
 * named. The Codex model and effort ride along whenever a lane is on Codex,
 * because "why is it answering like that" is otherwise unanswerable.
 */
export function engineStatusLine({ chat = {}, config = {}, claudeAvailable = true, codexAvailable = true } = {}) {
  const chatEng = effectiveEngine({ lane: 'chat', chat, config, claudeAvailable, codexAvailable });
  const bgEng = effectiveEngine({ lane: 'bg', chat, config, claudeAvailable, codexAvailable });
  if (chatEng === 'claude' && bgEng === 'claude') return null;
  const { model, effort } = codexSettings({ chat, config });
  return `⚙️ engine: chat ${chatEng} · bg ${bgEng} · codex ${orDefault(model)}/${orDefault(effort)}`;
}
