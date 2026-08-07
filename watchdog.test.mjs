// Verifies the watchdog registry logic against the SHIPPED module:
// a dead pid must be reaped, a live pid must not.
//
// This used to regex-extract the registry source out of bridge.mjs and rewrite
// the inflight path with a string replacement. Two problems with that, both now
// gone: the test exercised a re-assembled copy rather than the real module (a
// missing `import fs` in the shipped code went undetected for months precisely
// because the harness supplied its own), and the path rewrite was an unasserted
// regex — if it ever stopped matching, the fallback target was the LIVE registry
// in the repo root, which a running background worker depends on.
//
// Now: import the module, hand it a temp file, and ASSERT the live registry was
// never touched (see the final check).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInflightRegistry, pidAlive, createWorkerWatchdog } from './detached-workers.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
const REGISTRY_FILE = path.join(TMP, 'bg-inflight.json');

// The live registry this suite must never write to. Snapshot it up front so the
// last assertion can prove it is byte-identical afterwards.
const LIVE_FILE = new URL('./bg-inflight.json', import.meta.url).pathname;
const liveBefore = fs.existsSync(LIVE_FILE) ? fs.readFileSync(LIVE_FILE) : null;

const { read: inflightRead, add: inflightAdd, clear: inflightClear } = createInflightRegistry({
  file: REGISTRY_FILE,
});

let pass = 0,
  fail = 0;
const ok = (name, cond) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name);
  }
};

// live pid = this process
ok('pidAlive true for self', pidAlive(process.pid) === true);
// a pid that cannot exist
ok('pidAlive false for bogus pid', pidAlive(4000000) === false);
ok('pidAlive false for undefined', pidAlive(undefined) === false);

// registry round-trip
ok('empty registry reads as {}', Object.keys(inflightRead()).length === 0);
inflightAdd('job-a', { pid: process.pid, task: 'live job', startedAt: Date.now() });
inflightAdd('job-b', { pid: 4000000, task: 'dead job', startedAt: Date.now() });
ok('two records persisted', Object.keys(inflightRead()).length === 2);
ok('record survives a fresh read (crash-safe on disk)', inflightRead()['job-b'].task === 'dead job');

// the discriminator the reaper uses
const m = inflightRead();
const dead = Object.entries(m).filter(([, r]) => !pidAlive(r.pid)).map(([id]) => id);
ok('exactly the dead worker is selected', dead.length === 1 && dead[0] === 'job-b');

// ...and the reaper itself, which is what actually ships. It must select the same
// record, hand it to the host's alert callback, and drop it from the registry.
const reaped = [];
const watchdog = createWorkerWatchdog({
  registry: createInflightRegistry({ file: REGISTRY_FILE }),
  runsDir: path.join(TMP, 'runs'),
  onDeadWorkers: (list, reason) => reaped.push({ list, reason }),
  log: () => {},
});
const n = watchdog.reapDeadWorkers('unit test');
ok('reaper reports exactly the dead worker', n === 1 && reaped.length === 1 && reaped[0].list[0].id === 'job-b');
ok('reaper passes the reason through to the host', reaped[0].reason === 'unit test');
ok('reaper hands the host the record, not just the id', reaped[0].list[0].rec.task === 'dead job');
ok('reaped record is removed from the registry', Object.keys(inflightRead()).join() === 'job-a');
ok('a second reap is silent (a death is announced once)', watchdog.reapDeadWorkers('again') === 0);
ok('reaper left the live worker alone', inflightRead()['job-a'].task === 'live job');

inflightClear('job-a');
inflightAdd('job-a', { pid: process.pid, task: 'live job', startedAt: Date.now() });
inflightAdd('job-b', { pid: 4000000, task: 'dead job', startedAt: Date.now() });
inflightClear('job-b');
ok('clearing removes only that record', Object.keys(inflightRead()).join() === 'job-a');
inflightClear('nope'); // must not throw or corrupt
ok('clearing an unknown id is a no-op', Object.keys(inflightRead()).join() === 'job-a');

// corrupt file must not crash the daemon
fs.writeFileSync(REGISTRY_FILE, '{not json');
ok('corrupt registry reads as {} instead of throwing', Object.keys(inflightRead()).length === 0);

// a real child that we kill: registered alive, reaped after death
const child = spawn('sleep', ['30']);
await new Promise((r) => setTimeout(r, 100));
inflightAdd('job-c', { pid: child.pid, task: 'real child', startedAt: Date.now() });
ok('real running child reads alive', pidAlive(child.pid) === true);
child.kill('SIGKILL');
await new Promise((r) => child.on('exit', r));
await new Promise((r) => setTimeout(r, 100));
ok('SIGKILLed child reads dead (the restart-killed-worker case)', pidAlive(child.pid) === false);

// THE containment check. If this fails, the suite has been writing to the
// registry a live background worker depends on — the exact state that makes
// safe-restart.sh see zero live workers and restart over real work.
const liveAfter = fs.existsSync(LIVE_FILE) ? fs.readFileSync(LIVE_FILE) : null;
ok(
  'the LIVE bg-inflight.json was never touched by this suite',
  liveBefore === null ? liveAfter === null : liveAfter !== null && Buffer.compare(liveBefore, liveAfter) === 0,
);

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
