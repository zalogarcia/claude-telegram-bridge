// STEER PROBE: the ported daemon-side steering chain, end to end, against a
// FAKE worker. No Claude spend, no Telegram, no daemon.
//
//   node scripts/probes/steer-probe.mjs
//
// What it actually exercises, all of it real code out of this repo:
//   • a worker spawned through spawnWorker the way runClaude spawns one
//     (detached, stdout/stderr on a file, stdin HELD OPEN)
//   • bgWorkerDescriptors / steerInto / handleSteerRequest / startSteerServer,
//     extracted by source from bridge.mjs
//   • the real `bg.mjs steer` and `bg.mjs ps` CLIs over a real unix socket
//   • steerFraming on the way in and steeredInBlock on the way out
//
// PASS = the fake worker's stdin received the FRAMED steer, `bg.mjs ps` showed
// it as steerable, and the text comes back in the STEERED IN block.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnWorker } from '../../detached-workers.mjs';
import { STEER_SOCK_NAME, steerFraming, steeredInBlock, STEER_HEADER } from '../../bg-steer.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'steer-probe-'));
let pass = 0;
const fail = [];
const ok = (name, cond, detail = '') => (cond ? (pass++, console.log(`  ok    ${name}`)) : fail.push(`${name} ${detail}`));

// --- the fake worker: holds stdin open, records every line it is handed ------
const FAKE = path.join(TMP, 'fake-claude.mjs');
const STDIN_LOG = path.join(TMP, 'worker-stdin.txt');
writeFileSync(
  FAKE,
  `import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => { appendFileSync(${JSON.stringify(STDIN_LOG)}, l + '\\n'); });
rl.on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 30000).unref();
`,
);
chmodSync(FAKE, 0o755);

// --- the daemon's steering half, extracted from bridge.mjs ------------------
const SRC = readFileSync(path.join(DIR, 'bridge.mjs'), 'utf8').split('\n');
function grab(name, kind = 'function') {
  const head = kind === 'function' ? new RegExp(`^(?:async )?function ${name}\\b`) : new RegExp(`^const ${name}\\b`);
  const start = SRC.findIndex((l) => head.test(l));
  if (start === -1) throw new Error(`could not extract ${name} from bridge.mjs, did it get renamed?`);
  const out = [SRC[start]];
  for (let i = start + 1; i < SRC.length; i++) {
    const l = SRC[i];
    if (/^\S/.test(l)) { if (l.startsWith('}') || l.startsWith('};')) out.push(l); break; }
    out.push(l);
  }
  return out.join('\n');
}
const url = (f) => JSON.stringify(pathToFileURL(path.join(DIR, f)).href);
const SOCK_DIR = TMP;
const D = await import('data:text/javascript,' + encodeURIComponent([
  `
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { clip, oneLine } from ${url('progress-render.mjs')};
import { briefTitle } from ${url('bg-lane-rules.mjs')};
import {
  STEER_SOCK_NAME, decodeLine, encodeLine, parseRunId, psTable, resolveSteerTarget,
  steerFailure, steerResponse, validateRequest, REASONS as STEER_REASONS,
} from ${url('bg-steer.mjs')};
const { existsSync, unlinkSync } = fs;
const SCRIPT_DIR = ${JSON.stringify(SOCK_DIR)};
const STEER_SOCK = path.join(SCRIPT_DIR, STEER_SOCK_NAME);
const CODEX_LANE = 'codex';
export const bgLanes = [];
export const codexRuns = new Map();
export const REGISTRY = new Map();
const inflight = { read: () => Object.fromEntries(REGISTRY), add: (id, r) => REGISTRY.set(id, r) };
export const watchdog = { reattachedIds: new Set() };
`,
  grab('bgWorkerDescriptors'),
  grab('publicWorker', 'const'),
  grab('steerInto'),
  grab('handleSteerRequest'),
  grab('startSteerServer'),
  'export { bgWorkerDescriptors, steerInto, startSteerServer };',
].join('\n')));

// --- stand up one running worker, exactly as runClaude records one ----------
const startedAt = Date.now();
const logPath = path.join(TMP, `bg-${startedAt}.jsonl`);
const { child } = spawnWorker(process.execPath, [FAKE], { cwd: TMP, env: { ...process.env }, logPath });
const steers = [];
const run = {
  startedAt, child, steps: 3, lastAct: 'Read(bridge.mjs)', watchdogId: `bg-${startedAt}-${child.pid}`,
  prompt: 'LANE RULES (you are a background worker: headless).\n\n--- TASK ---\n\n# Port the second engine',
  steers,
  canSteer: () => child.exitCode === null && child.signalCode === null && Boolean(child.stdin?.writable),
  // the same shape runClaude installs, minus the progress bubble
  steer: (t, { frame = false } = {}) => {
    if (!run.canSteer()) return false;
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: frame ? steerFraming(t) : t }] } }) + '\n';
    child.stdin.write(msg);
    steers.push({ ts: new Date().toISOString(), text: t });
    return true;
  },
};
D.bgLanes.push({ name: 'bg', isBg: true, current: run, queue: [] });
const server = D.startSteerServer();
await new Promise((r) => setTimeout(r, 300));

const cli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(SOCK_DIR, 'bg.mjs'), ...args], { cwd: SOCK_DIR }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});
// bg.mjs resolves the socket from its OWN directory, so run the real CLI there
writeFileSync(path.join(SOCK_DIR, 'bg.mjs'), readFileSync(path.join(DIR, 'bg.mjs'), 'utf8'));

console.log(`\nsocket: ${path.join(SOCK_DIR, STEER_SOCK_NAME)}   worker pid: ${child.pid}\n`);

const ps = await cli(['ps']);
console.log(ps.stdout.trimEnd());
ok('bg.mjs ps lists the running worker as steerable', /\bbg\b/.test(ps.stdout) && /\byes\b/.test(ps.stdout), ps.stdout);
ok('ps shows the JOB, not the LANE RULES preamble', ps.stdout.includes('Port the second engine') && !ps.stdout.includes('LANE RULES'), ps.stdout);
ok('ps names the engine column', ps.stdout.includes('ENGINE') && ps.stdout.includes('claude'), ps.stdout);

const TEXT = "Don't rebuild `dist`; check [a, b] first.";
const bodyFile = path.join(TMP, 'steer.md');
writeFileSync(bodyFile, TEXT + '\n');
const st = await cli(['steer', 'bg', '--file', bodyFile]);
console.log('\n' + st.stdout.trim() + st.stderr.trim());
ok('the CLI reports the steer delivered, exit 0', st.code === 0 && /steered into bg \(bg-/.test(st.stdout), st.stdout + st.stderr);

await new Promise((r) => setTimeout(r, 400));
const seen = existsSync(STDIN_LOG) ? readFileSync(STDIN_LOG, 'utf8') : '';
const line = seen.trim().split('\n').filter(Boolean).pop();
const parsed = line ? JSON.parse(line) : null;
const delivered = parsed?.message?.content?.[0]?.text || '';
console.log('\n--- what the worker actually read on stdin ---\n' + delivered + '\n');
ok('★ the worker received the steer', delivered.includes(TEXT), delivered);
ok('★ it arrived FRAMED as a mid-run instruction, not as a new brief', delivered.startsWith(STEER_HEADER), delivered.slice(0, 80));
ok('backticks and the apostrophe survived the file -> socket -> stdin path', delivered.includes("Don't rebuild `dist`") && delivered.includes('[a, b]'), delivered);

const block = steeredInBlock(steers);
console.log('--- the STEERED IN block the handback carries ---\n' + block + '\n');
ok('★ the steer comes back in the STEERED IN block', block.includes('STEERED IN (1)') && block.includes(TEXT), block);
ok('the block warns the reader the socket is unauthenticated', /local and unauthenticated/.test(block), block);

const bad = await cli(['steer', 'bg99', 'nowhere']);
ok('an unknown target is refused, exit 1', bad.code === 1 && /no_running_worker_matches/.test(bad.stderr), bad.stderr);

child.stdin.end();
await new Promise((r) => setTimeout(r, 300));
const late = await cli(['steer', 'bg', 'too late']);
ok('a worker whose stdin is closed is refused rather than falsely acked', late.code === 1, late.stdout + late.stderr);

server.close();
try { child.kill('SIGTERM'); } catch {}
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail.length} failed\n`);
if (fail.length) { for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log('✅ steer probe passed');
