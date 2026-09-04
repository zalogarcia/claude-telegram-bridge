#!/usr/bin/env node
// Tests for the LANE RULES header bg.mjs prepends to every brief.
//
// The rules are runtime facts about a headless worker (no run_in_background,
// 600s Bash ceiling, the report is delivered whole, a steer can arrive mid-run).
// Without them, each worker discovers them by being BLOCKED on its first action:
// a baseline check dispatched with run_in_background comes back empty, and an
// Agent call dispatched that way dies at turn end with no verdict at all. A
// brief that carries the rules cannot pay that tax.
//
// The daemon half of the same contract lives in bg-lane-rules.mjs: it strips
// this preamble back off before a human is shown a brief. Both halves are
// exercised here, because a rename on either side is silent otherwise.
//
//   node bg-lane-rules.test.mjs
//
// bg.mjs writes to a queue file resolved from its OWN directory, so it is copied
// into a temp dir and run there. The live bg-queue.json is never touched.

import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_ANCHOR, briefTitle, stripLaneRules } from './bg-lane-rules.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), 'bg-lane-rules-'));
const BG = path.join(TMP, 'bg.mjs');
copyFileSync(path.join(DIR, 'bg.mjs'), BG);
const QUEUE = path.join(TMP, 'bg-queue.json');

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

function queue(args) {
  rmSync(QUEUE, { force: true });
  execFileSync(process.execPath, [BG, ...args], { stdio: 'pipe' });
  return JSON.parse(readFileSync(QUEUE, 'utf8'));
}
function brief(text) {
  const p = path.join(TMP, `brief-${Math.abs(text.length)}-${text.slice(0, 4).replace(/\W/g, '')}.md`);
  writeFileSync(p, text);
  return p;
}

const HEADER = 'LANE RULES (you are a background worker';

t('every brief arrives carrying the lane rules', () => {
  const [item] = queue(['--file', brief('do the thing')]);
  ok(item.text.startsWith(HEADER), 'brief does not start with the lane rules');
  ok(item.text.includes('NEVER use run_in_background'), 'rule 1 missing');
  ok(item.text.includes('Bash caps at 600s'), 'rule 2 missing');
  ok(item.text.includes('Your final message IS your report'), 'rule 3 missing');
  ok(item.text.includes('[STEER from the orchestrator]'), 'rule 4 missing');
  ok(item.text.endsWith('do the thing'), 'the task must be the last thing the worker reads');
});

t('the rules cover Agent dispatches, not just Bash', () => {
  // The guard that blocks backgrounding only sees Bash. The audit's worst case
  // was a QA audit dispatched as a backgrounded AGENT call, which nothing
  // blocked and which died at turn end with no verdict at all.
  const [item] = queue(['--file', brief('x')]);
  ok(/not on Bash, not on an Agent\/Task dispatch/.test(item.text), 'the Agent case is not spelled out');
});

t('rule 2 offers chunking rather than only banning long loops', () => {
  const [item] = queue(['--file', brief('x')]);
  ok(/CHUNKED into bounded foreground runs/.test(item.text), 'no alternative offered for a long watch');
});

t('rule 1 names a real escape hatch for a genuinely long job', () => {
  // The path is resolved from bg.mjs's OWN directory, so a worker can copy the
  // line verbatim wherever the bridge happens to be installed. realpath, because
  // on macOS the temp dir is reached through a symlink and the child resolves it.
  const [item] = queue(['--file', brief('x')]);
  ok(item.text.includes(`${realpathSync(TMP)}/bg.mjs --file <brief>`), item.text.slice(0, 600));
});

t('a brief that already carries the rules is not re-headered', () => {
  // A re-queued job, or a worker handing its own brief on, must not accumulate
  // copies of the header.
  const first = queue(['--file', brief('original task')])[0].text;
  const second = queue(['--file', brief(first)])[0].text;
  eq(second.split(HEADER).length - 1, 1, 'the header was prepended twice');
  ok(second.endsWith('original task'), 'the task survived the round trip');
});

t('a --file brief keeps backticks and brackets the shell would have eaten', () => {
  // The reason --file exists: through argv, `CompName` becomes command
  // substitution and reaches the worker as an empty string.
  const raw = 'run `npm run build` over [a, b] and report';
  const [item] = queue(['--file', brief(raw)]);
  ok(item.text.endsWith(raw), 'brief text was mangled');
});

t('the argv form gets the rules too', () => {
  const [item] = queue(['a short task']);
  ok(item.text.startsWith(HEADER), 'argv briefs bypass the lane rules');
  ok(item.text.endsWith('a short task'), 'argv task lost');
});

t('an empty brief is still refused', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [BG, ''], { stdio: 'pipe' });
  } catch (e) {
    code = e.status;
  }
  eq(code, 1, 'an empty brief must not be queued with only a header');
});

// ---------------------------------------------------------------------------
// The Codex engine. A brief routed to OpenAI Codex must NOT carry the lane
// rules: every one of them is a fact about a headless Claude worker (the Agent
// tool, the Bash ceiling, steering), and Codex has none of those. Prepending
// them would be a page of wrong instructions, billed per token.
// ---------------------------------------------------------------------------

t('--engine codex marks the item and drops the Claude lane rules', () => {
  const [item] = queue(['--engine', 'codex', '--file', brief('review the last commit')]);
  eq(item.engine, 'codex', 'the daemon reads the engine off the item, not out of the prose');
  ok(!item.text.startsWith(HEADER), 'a Codex brief must not carry Claude lane rules');
  eq(item.text, 'review the last commit');
});

t('the codex: prefix routes and is stripped', () => {
  const [item] = queue(['codex: what does bg.mjs do']);
  eq(item.engine, 'codex');
  eq(item.text, 'what does bg.mjs do');
});

t('a brief that merely mentions codex is a normal Claude job', () => {
  const [item] = queue(['--file', brief('compare our output with codex: is it better?')]);
  eq(item.engine, undefined, 'no engine field on an ordinary job');
  ok(item.text.startsWith(HEADER), 'a Claude job still gets the rules');
});

t('--engine claude is explicit and keeps the rules', () => {
  const [item] = queue(['--engine', 'claude', '--file', brief('run the suite')]);
  eq(item.engine, 'claude');
  ok(item.text.startsWith(HEADER));
});

t('an unknown engine is refused rather than silently defaulted', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [BG, '--engine', 'gpt9', 'do a thing'], { stdio: 'pipe' });
  } catch (e) {
    code = e.status;
  }
  eq(code, 1, 'a typo in the engine name must not run the job on the wrong model');
});

// ---------------------------------------------------------------------------
// THE DAEMON HALF. bg.mjs writes the preamble; bg-lane-rules.mjs takes it back
// off before a human sees the brief. A rename on either side is silent, so the
// round trip goes through the REAL CLI output rather than a hand-written string.
// ---------------------------------------------------------------------------

t('★ stripLaneRules removes exactly what bg.mjs prepended', () => {
  const [item] = queue(['--file', brief('rebuild the index and report the row count')]);
  eq(stripLaneRules(item.text), 'rebuild the index and report the row count');
});

t('the anchor the two halves agree on is present in both', () => {
  const [item] = queue(['--file', brief('x')]);
  ok(item.text.includes(TASK_ANCHOR), 'bg.mjs stopped emitting the anchor');
});

t('a brief that never carried the rules is returned untouched', () => {
  const raw = 'a plain brief that mentions --- TASK --- in passing';
  eq(stripLaneRules(raw), raw, 'a mid-text anchor must not eat the opening');
});

t('a header with no anchor is shown rather than swallowed', () => {
  // Better a status row full of boilerplate than a status row that lost the job.
  const broken = 'LANE RULES (you are a background worker)\nsomething went wrong';
  eq(stripLaneRules(broken), broken);
});

t('non-strings degrade to an empty string instead of throwing in a status view', () => {
  eq(stripLaneRules(null), '');
  eq(stripLaneRules(undefined), '');
});

t('★ briefTitle names the job, not the preamble', () => {
  const [item] = queue(['--file', brief('# TASK: port the second engine\n\nlots of detail follows')]);
  eq(briefTitle(item.text), 'TASK: port the second engine');
});

t('briefTitle skips blank lines and collapses whitespace', () => {
  eq(briefTitle('\n\n   do    the   thing   \nmore'), 'do the thing');
});

t('briefTitle clips long titles with an ellipsis', () => {
  const title = briefTitle('x'.repeat(200));
  eq(title.length, 70);
  ok(title.endsWith('…'));
});

t('briefTitle says something rather than nothing for an empty brief', () => {
  eq(briefTitle(''), '(no description)');
});

rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all bg lane-rule tests pass');
