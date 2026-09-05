#!/usr/bin/env node
// Unit tests for steer socket ownership, plus the one integration test that
// matters most: importing bridge.mjs must do NOTHING.
//
// Both halves exist because of one morning (2026-09-05). A worker syntax
// checked the daemon with `node -e "import('./bridge.mjs')"`. That booted a
// second daemon, which deleted the live daemon's socket on the way in, bound
// its own at the same path, re-attached to a running background worker, and
// exited. The LaunchAgent daemon stayed healthy and unreachable for hours:
// `bg.mjs steer` and `bg.mjs ps` both answered "daemon not reachable".
//
// The tests below are the two things that must never be true again:
//   • importing bridge.mjs starts a daemon (section 6)
//   • a process that does not own the socket deletes it (sections 1 to 5)
//
//   node steer-sock.test.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimDecision,
  claimSteerSock,
  ownerFileFor,
  pidAlive,
  pidRunsScript,
  probeSocketLive,
  readSockOwner,
  recordSockOwner,
  releaseDecision,
  releaseSteerSock,
} from './steer-sock.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(DIR, 'bridge.mjs');

let pass = 0;
const failures = [];
// Queued and run in declaration order, sequentially, including the async ones:
// several tests bind real Unix listeners, and two of those overlapping would be
// a flake nobody could reproduce.
const queue = [];
const t = (name, fn) => {
  queue.push(async () => {
    try {
      await fn();
      pass++;
    } catch (e) {
      failures.push(`${name}\n    ${e.message}`);
    }
  });
};
const eq = (got, want, msg = '') => {
  if (got !== want) throw new Error(`${msg}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// A scratch directory per IO test. Nothing here ever touches the live socket:
// this suite runs on the same machine as the real daemon.
function scratch(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steer-sock-'));
  try {
    return fn(path.join(dir, 'steer.sock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function scratchAsync(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'steer-sock-'));
  try {
    return await fn(path.join(dir, 'steer.sock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// A real Unix listener at a real path, closed on the way out. Nothing in this
// suite ever binds inside the repo directory.
const listening = (sockPath) =>
  new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(sockPath, () => resolve(server));
  });
const closed = (server) => new Promise((resolve) => server.close(resolve));
const touch = (p, body = '') => writeFileSync(p, body);
// The default facts for a pure decision, so each case states only what it is about.
const facts = (over) => ({ sockExists: false, sockLive: false, ownerPid: null, ownerAlive: false, selfPid: 999, ...over });

// ---------------------------------------------------------------------------
console.log('\n1. claimDecision: who is allowed to bind');

t('a live owner that is not us is refused, and named', () => {
  const d = claimDecision(facts({ sockExists: true, ownerPid: 62738, ownerAlive: true }));
  eq(d.action, 'refuse');
  eq(d.ownerPid, 62738);
  ok(d.reason.includes('62738'), `the refusal must name the pid: ${d.reason}`);
});

t('THE INCIDENT: a live owner is refused even when the socket file is already gone', () => {
  // This is the state the incident left behind: daemon alive, socket deleted.
  // A second daemon starting into it is still wrong, so presence of the file
  // must not be what decides.
  eq(claimDecision(facts({ sockExists: false, ownerPid: 62738, ownerAlive: true })).action, 'refuse');
});

t('THE PRE-GUARD DAEMON: a live socket with no owner recorded is refused, not replaced', () => {
  // Every daemon that started before this guard existed is listening with no
  // .pid file. Reading "no record" as "corpse" would delete its socket, which
  // is the original bug wearing a new hat.
  const d = claimDecision(facts({ sockExists: true, sockLive: true, ownerPid: null }));
  eq(d.action, 'refuse');
  ok(/listening/.test(d.reason), d.reason);
});

t('a live socket whose recorded owner is gone is still refused', () => {
  const d = claimDecision(facts({ sockExists: true, sockLive: true, ownerPid: 4242, ownerAlive: false }));
  eq(d.action, 'refuse');
  ok(d.reason.includes('4242'), d.reason);
});

t('a dead owner with nothing listening leaves a corpse, which is replaced', () => {
  const d = claimDecision(facts({ sockExists: true, ownerPid: 4242, ownerAlive: false }));
  eq(d.action, 'replace');
  eq(d.ownerPid, 4242);
  ok(d.reason.includes('4242'), d.reason);
});

t('a dead socket file with no recorded owner is replaced, and says why', () => {
  const d = claimDecision(facts({ sockExists: true }));
  eq(d.action, 'replace');
  eq(d.ownerPid, null);
  ok(/no owner is recorded/.test(d.reason), d.reason);
});

t('our own pid on a live socket is not another daemon', () => {
  eq(claimDecision(facts({ sockExists: true, sockLive: true, ownerPid: 999, ownerAlive: true })).action, 'replace');
});

t('nothing on disk at all: claim', () => {
  eq(claimDecision(facts({})).action, 'claim');
});

t('a dead owner with no socket file: claim, and the record is mentioned', () => {
  const d = claimDecision(facts({ ownerPid: 4242 }));
  eq(d.action, 'claim');
  ok(d.reason.includes('4242'), d.reason);
});

// ---------------------------------------------------------------------------
console.log('\n2. releaseDecision: who is allowed to unlink');

t('the recorded owner cleans up after itself', () => {
  eq(releaseDecision({ ownerPid: 500, selfPid: 500 }).unlink, true);
});

t("a stranger never unlinks somebody else's socket", () => {
  const d = releaseDecision({ ownerPid: 62738, selfPid: 999 });
  eq(d.unlink, false);
  ok(d.reason.includes('62738'), d.reason);
});

t('no record means no proof, so no unlink', () => {
  eq(releaseDecision({ ownerPid: null, selfPid: 999 }).unlink, false);
});

// ---------------------------------------------------------------------------
console.log('\n3. the owner file');

t('the owner file sits beside the socket', () => {
  eq(ownerFileFor('/tmp/x/steer.sock'), '/tmp/x/steer.sock.pid');
});

t('a written pid reads back as a number', () =>
  scratch((sock) => {
    recordSockOwner(sock, 62738);
    eq(readFileSync(ownerFileFor(sock), 'utf8'), '62738\n', 'a bare integer, readable from a shell');
    eq(readSockOwner(sock), 62738);
  }));

t('a missing, empty or junk owner file reads as nothing recorded', () =>
  scratch((sock) => {
    eq(readSockOwner(sock), null, 'missing');
    touch(ownerFileFor(sock), '');
    eq(readSockOwner(sock), null, 'empty');
    touch(ownerFileFor(sock), 'not a pid\n');
    eq(readSockOwner(sock), null, 'junk');
    touch(ownerFileFor(sock), '0\n');
    eq(readSockOwner(sock), null, 'zero');
    touch(ownerFileFor(sock), '-4\n');
    eq(readSockOwner(sock), null, 'negative');
  }));

// ---------------------------------------------------------------------------
console.log('\n4. the two probes, against real processes and real sockets');

t('pidAlive: this process yes, nonsense no', () => {
  eq(pidAlive(process.pid), true);
  eq(pidAlive(0), false);
  eq(pidAlive(-1), false);
  eq(pidAlive(null), false);
  eq(pidAlive(1.5), false);
});

t('pidRunsScript reads the command line, so a recycled pid is not our daemon', () => {
  eq(pidRunsScript(process.pid, 'steer-sock.test.mjs'), true, 'ps did not see this test in its own command line');
  eq(pidRunsScript(process.pid, 'no-such-program-xyz.mjs'), false);
  eq(pidRunsScript(2 ** 30, 'bridge.mjs'), false, 'a pid ps knows nothing about is not a daemon');
});

t('pidRunsScript answers YES whenever ps cannot answer, because refusing is the safe failure', () => {
  // The fail direction is load-bearing: a false NO steals a live daemon's
  // socket in silence. Asserted through the injected runner, so flipping either
  // branch in the module fails here rather than passing quietly.
  const yes = 'ps could not answer, so the pid must be treated as a live daemon';
  eq(pidRunsScript(1, 'bridge.mjs', () => ({ error: new Error('EAGAIN'), status: null })), true, `${yes} (spawn error)`);
  eq(pidRunsScript(1, 'bridge.mjs', () => ({ status: 0, stdout: null })), true, `${yes} (no stdout)`);
  eq(pidRunsScript(1, 'bridge.mjs', () => ({ status: null, stdout: '' })), true, `${yes} (ps killed by a signal)`);
  eq(pidRunsScript(1, 'bridge.mjs', () => null), true, `${yes} (runner returned nothing)`);
  eq(
    pidRunsScript(1, 'bridge.mjs', () => {
      throw new Error('boom');
    }),
    true,
    `${yes} (runner threw)`,
  );
  // And the two answers ps CAN give still decide normally.
  eq(pidRunsScript(1, 'bridge.mjs', () => ({ status: 0, stdout: 'node /x/bridge.mjs\n' })), true);
  eq(pidRunsScript(1, 'bridge.mjs', () => ({ status: 1, stdout: '' })), false);
});

// A GENUINE orphaned socket: a child binds it and is SIGKILLed, which skips
// libuv's unlink, so the file outlives its listener. This is the real shape of
// "stale", and simulating it with a plain file would let a broken probe pass.
const orphanSocket = (sockPath) => {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import net from 'node:net';
       const s = net.createServer(() => {});
       s.listen(${JSON.stringify(sockPath)}, () => process.kill(process.pid, 'SIGKILL'));`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (!existsSync(sockPath)) throw new Error(`the child left no socket behind: ${r.stderr || r.signal}`);
};

t('probeSocketLive: a REAL orphaned socket, its owner SIGKILLed, reads as dead', () =>
  scratchAsync(async (sock) => {
    orphanSocket(sock);
    eq(await probeSocketLive(sock), false, 'an orphaned socket read as live, so no daemon could ever replace it');
  }));

t('a REAL orphaned socket is replaced by the claim, not refused', () =>
  scratchAsync(async (sock) => {
    orphanSocket(sock);
    const d = await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => false });
    eq(d.action, 'replace');
    ok(!existsSync(sock), 'the corpse survived, so listen() would fail with EADDRINUSE forever');
  }));

t('probeSocketLive: a real listener answers, a corpse does not', () =>
  scratchAsync(async (sock) => {
    eq(await probeSocketLive(sock), false, 'nothing is there at all');
    const server = await listening(sock);
    try {
      eq(await probeSocketLive(sock), true, 'a bound listener must read as live');
    } finally {
      await closed(server);
    }
    touch(sock, 'not a socket at all');
    eq(await probeSocketLive(sock), false, 'a plain file at the path is not a listener');
  }));

// ---------------------------------------------------------------------------
console.log('\n5. claimSteerSock / releaseSteerSock against a real directory');

t('THE FIX: a refused claim deletes nothing', () =>
  scratchAsync(async (sock) => {
    touch(sock, 'pretend socket');
    recordSockOwner(sock, 62738);
    const d = await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => true });
    eq(d.action, 'refuse');
    ok(existsSync(sock), 'the live owner lost its socket file, which IS the bug');
    eq(readSockOwner(sock), 62738, 'the owner record was rewritten or deleted');
  }));

t('THE OTHER HALF OF THE FIX: a LIVE listener with no pid record is refused, socket intact', () =>
  scratchAsync(async (sock) => {
    // A daemon from before this guard: it is serving, and it recorded nothing.
    const server = await listening(sock);
    try {
      const d = await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => false });
      eq(d.action, 'refuse');
      ok(existsSync(sock), 'a live listener was unlinked, which IS the original bug');
      ok(!existsSync(ownerFileFor(sock)), 'a refused claim must not stamp its pid on somebody else’s socket');
      // Still reachable afterwards: the proof that "intact" means serving, not
      // just present on disk.
      eq(await probeSocketLive(sock), true, 'the live daemon stopped answering after a refused claim');
    } finally {
      await closed(server);
    }
  }));

t('a stale claim clears the corpse and records us, so the bind can succeed', () =>
  scratchAsync(async (sock) => {
    touch(sock, 'pretend socket');
    recordSockOwner(sock, 4242);
    const d = await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => false });
    eq(d.action, 'replace');
    ok(!existsSync(sock), 'the stale socket survived, so listen() would fail with EADDRINUSE');
    eq(readSockOwner(sock), 999, 'the new owner was not recorded');
  }));

t('a dead socket file with no record is replaced, not refused', () =>
  scratchAsync(async (sock) => {
    touch(sock, 'pretend socket');
    const d = await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => true });
    eq(d.action, 'replace');
    ok(!existsSync(sock), 'an unowned corpse must be cleared');
  }));

t('a clean directory is claimed, and the claim is recorded BEFORE any bind', () =>
  scratchAsync(async (sock) => {
    // The window between the guard and listen() is where a second daemon used
    // to slip through: bridge.mjs makes two Telegram calls in it that can hang
    // for 90s each. The pid record has to exist by the time claim returns.
    eq((await claimSteerSock(sock, { selfPid: 999, isOwnerAlive: () => true })).action, 'claim');
    eq(readSockOwner(sock), 999, 'nothing claimed the name, so a rival would sail through the window');
    ok(!existsSync(sock), 'the claim must not create the socket file itself');
  }));

t('a rival that starts inside the bind window is refused by the record alone', () =>
  scratchAsync(async (sock) => {
    await claimSteerSock(sock, { selfPid: 1001, isOwnerAlive: () => true }); // first daemon, not yet bound
    const rival = await claimSteerSock(sock, { selfPid: 1002, isOwnerAlive: () => true });
    eq(rival.action, 'refuse');
    eq(rival.ownerPid, 1001);
    eq(readSockOwner(sock), 1001, 'the rival overwrote the first daemon’s claim');
  }));

t('the liveness probes are only asked about what is actually there', () =>
  scratchAsync(async (sock) => {
    const askedPid = [];
    const askedSock = [];
    await claimSteerSock(sock, {
      selfPid: 999,
      isOwnerAlive: (pid) => (askedPid.push(pid), true),
      isSockLive: (p) => (askedSock.push(p), true),
    });
    eq(askedPid.length, 0, 'probed a pid that was never recorded');
    eq(askedSock.length, 0, 'connected to a socket that does not exist');
  }));

t('the socket probe is skipped when the pid record already settled it', () =>
  scratchAsync(async (sock) => {
    let probes = 0;
    touch(sock, 'pretend socket');
    recordSockOwner(sock, 62738);
    const d = await claimSteerSock(sock, {
      selfPid: 999,
      isOwnerAlive: () => true,
      isSockLive: () => (probes++, false),
    });
    eq(d.action, 'refuse');
    eq(probes, 0, 'spent a connect deciding something the pid record had already decided');
  }));

t('release unlinks both files when we own them', () =>
  scratch((sock) => {
    touch(sock, 'pretend socket');
    recordSockOwner(sock, 999);
    const r = releaseSteerSock(sock, { selfPid: 999 });
    eq(r.unlinked, true);
    ok(!existsSync(sock), 'socket left behind');
    ok(!existsSync(ownerFileFor(sock)), 'owner record left behind');
  }));

t("release leaves another daemon's socket exactly where it is", () =>
  scratch((sock) => {
    touch(sock, 'pretend socket');
    recordSockOwner(sock, 62738);
    const r = releaseSteerSock(sock, { selfPid: 999 });
    eq(r.unlinked, false);
    ok(existsSync(sock), 'a stranger unlinked a live socket on its way out, which IS the bug');
    ok(existsSync(ownerFileFor(sock)), 'the owner record went with it');
  }));

t('release with no record is a no-op, not a guess', () =>
  scratch((sock) => {
    touch(sock, 'pretend socket');
    eq(releaseSteerSock(sock, { selfPid: 999 }).unlinked, false);
    ok(existsSync(sock), 'unlinked a socket it could not prove was its own');
  }));

// ---------------------------------------------------------------------------
console.log('\n6. importing bridge.mjs must be inert');

t('bridge.mjs calls main() only behind the entry point guard', () => {
  const lines = readFileSync(BRIDGE, 'utf8').split('\n');
  const src = lines.join('\n');
  ok(/const IS_ENTRYPOINT = /.test(src), 'the entry point guard is gone');
  ok(
    !/^\s*if \(existsSync\(STEER_SOCK\)\) unlinkSync\(STEER_SOCK\)/m.test(src),
    'the unconditional steer socket unlink is back',
  );
  ok(/await guardSteerSockOwnership\(\)/.test(src), 'the startup ownership guard is not wired into main()');
  // Indentation, not a spanning regex: a greedy match would be satisfied by the
  // guard that opens the SIGTERM block no matter where main() ended up.
  const calls = lines.filter((l) => l.includes('main().catch('));
  eq(calls.length, 1, `expected exactly one main().catch( call, found ${calls.length}`);
  ok(/^\s+main\(\)\.catch\(/.test(calls[0]), `main() is called at column 0, so an import boots a daemon: ${calls[0]}`);
});

t('importing bridge.mjs exits fast, binds nothing and touches no socket', () => {
  const sock = path.join(DIR, 'steer.sock');
  const before = existsSync(sock) ? statSync(sock) : null;
  const ownerBefore = existsSync(ownerFileFor(sock)) ? readFileSync(ownerFileFor(sock), 'utf8') : null;

  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(BRIDGE)}); console.log('imported')`],
    { cwd: DIR, encoding: 'utf8', timeout: 2000 },
  );
  const elapsed = Date.now() - started;

  eq(r.signal, null, `the import did not finish inside 2s (killed by ${r.signal})`);
  eq(r.status, 0, `import exited ${r.status}\n    stderr: ${String(r.stderr).slice(0, 600)}`);
  ok(String(r.stdout).includes('imported'), `the module never finished loading: ${String(r.stdout).slice(0, 300)}`);
  ok(elapsed < 2000, `import took ${elapsed}ms`);

  // A daemon announces itself on stdout. Silence is the assertion.
  ok(!/steer socket listening/.test(r.stdout), 'the import bound a steer socket');
  ok(!/engines: claude/.test(r.stdout), 'the import ran main()');
  ok(!/re-attached/.test(r.stdout), 'the import re-attached to live background workers');

  const after = existsSync(sock) ? statSync(sock) : null;
  eq(!!after, !!before, 'the import created or removed the live steer socket');
  if (before && after) {
    eq(after.ino, before.ino, 'the steer socket was rebound: a different inode is now at that path');
    eq(after.mtimeMs, before.mtimeMs, 'the steer socket was touched');
  }
  const ownerAfter = existsSync(ownerFileFor(sock)) ? readFileSync(ownerFileFor(sock), 'utf8') : null;
  eq(ownerAfter, ownerBefore, 'the import rewrote the socket owner file');
});

// ---------------------------------------------------------------------------
for (const run of queue) await run();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
