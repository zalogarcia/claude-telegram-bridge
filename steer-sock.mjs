// ---------------------------------------------------------------------------
// WHO OWNS THE STEER SOCKET.
//
// The daemon's control socket is a filesystem path, and a filesystem path has
// no idea which process is listening on it. That gap cost a morning
// (2026-09-05): a worker ran `node -e "import('./bridge.mjs')"` as a syntax
// check, which at the time BOOTED a second daemon. The second daemon's socket
// setup began with an unconditional `unlink(steer.sock)` labelled "stale file
// from a daemon that died", bound its own socket at the same path, re-attached
// to a live worker, and then exited. The real daemon (a LaunchAgent, still
// healthy, still running its workers) was left listening on an inode with no
// name: every later `bg.mjs steer` and `bg.mjs ps` answered "daemon not
// reachable" while nothing was actually wrong with it.
//
// Two mechanisms come out of that, and this module is the second one. The first
// is the entry-point guard in bridge.mjs, which is what stops an import from
// booting anything at all. This one is the belt to that pair of braces: the
// socket carries the pid of the process that bound it, so
//
//   • a second daemon REFUSES to start rather than deleting the first one's
//     socket, and says whose pid holds it, and
//   • a shutting-down process unlinks the socket only when the recorded owner
//     is itself, so a stranger's exit can never take the listener down.
//
// TWO INDEPENDENT SOURCES OF TRUTH, because either one alone has a hole. The
// pid record cannot cover a socket bound before this guard existed (there is no
// record to read, and "no record" must not mean "free to delete"), so a socket
// file with nothing accounted for is CONNECTED TO before it is called a corpse.
// A listener answering on it outranks anything the filesystem says.
//
// Everything that decides is a pure function taking facts, so the rules can be
// tested without binding a socket or killing a process; the exported IO
// wrappers are the thin layer that gathers those facts. See
// steer-sock.test.mjs.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';

// The owner file sits beside the socket, named after it, so the two are
// obviously one unit on disk and `ls` shows the pair. A bare integer rather
// than JSON: safe-restart.sh, a shell one-liner, or a human reading a log all
// get it for free.
export function ownerFileFor(sockPath) {
  return `${sockPath}.pid`;
}

/**
 * Should this process bind the socket, and what has to happen first?
 *
 * PURE. Facts in, decision out:
 *   sockExists  is there a socket file at the path right now
 *   sockLive    did something answer a connect on it (see probeSocketLive)
 *   ownerPid    pid recorded beside it, or null when nothing is recorded
 *   ownerAlive  is that pid a live daemon (see isOwnerAlive below)
 *   selfPid     us
 *
 * Returns one of:
 *   { action: 'claim'   }  nothing in the way, bind
 *   { action: 'replace' }  a socket file is there and nothing is behind it, so
 *                          the file is a corpse: unlink it, then bind
 *   { action: 'refuse'  }  somebody else is using it, do not start
 *
 * The live-owner test comes FIRST and does not care whether the socket file is
 * present. A daemon whose socket has already been deleted out from under it is
 * exactly the state this incident produced, and a second daemon starting into
 * that state is still the wrong thing: the machine runs one bridge.
 */
export function claimDecision({ sockExists, sockLive, ownerPid, ownerAlive, selfPid }) {
  if (ownerPid && ownerPid !== selfPid && ownerAlive) {
    return {
      action: 'refuse',
      ownerPid,
      reason: `pid ${ownerPid} is a live bridge daemon and owns this socket`,
    };
  }
  // The pid record said nothing useful, so the socket itself gets asked. A
  // daemon that predates this guard has no record and IS still serving; taking
  // "no record" as "corpse" would re-open the exact bug this file closes.
  if (sockExists && sockLive && ownerPid !== selfPid) {
    return {
      action: 'refuse',
      ownerPid: ownerPid ?? null,
      reason: ownerPid
        ? `something is listening on the socket, though its recorded owner ${ownerPid} is gone`
        : 'something is already listening on the socket and recorded no owner pid (a daemon from before this guard)',
    };
  }
  if (!sockExists) {
    return {
      action: 'claim',
      ownerPid: ownerPid ?? null,
      reason: ownerPid ? `no socket file (recorded owner ${ownerPid} is gone)` : 'no socket file',
    };
  }
  if (ownerPid === selfPid) {
    return { action: 'replace', ownerPid, reason: 'our own socket from an earlier bind in this process' };
  }
  return {
    action: 'replace',
    ownerPid: ownerPid ?? null,
    reason: ownerPid
      ? `recorded owner ${ownerPid} is gone and nothing answers on the socket`
      : 'nothing answers on the socket and no owner is recorded, so the file is a corpse',
  };
}

/**
 * Should this process unlink the socket on the way out?
 *
 * PURE, and deliberately conservative: only the recorded owner cleans up. No
 * record means we cannot prove the socket is ours, so we leave it, and the next
 * boot replaces it as stale. An orphan file that gets replaced in 30 seconds is
 * a much cheaper failure than deleting a listener somebody else is using.
 */
export function releaseDecision({ ownerPid, selfPid }) {
  if (!ownerPid) return { unlink: false, reason: 'no recorded owner, so the socket is not provably ours' };
  if (ownerPid !== selfPid) {
    return { unlink: false, reason: `pid ${ownerPid} owns this socket, not us (${selfPid})` };
  }
  return { unlink: true, reason: 'we bound it' };
}

// ---------------------------------------------------------------------------
// The thin IO layer: gathering the facts the two decisions above run on.
// ---------------------------------------------------------------------------

/** The pid recorded beside the socket, or null when there is no usable record. */
export function readSockOwner(sockPath) {
  try {
    const raw = readFileSync(ownerFileFor(sockPath), 'utf8').trim();
    const pid = Number(raw.split(/\s/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no file, unreadable, or junk: all mean "nothing recorded"
  }
}

/** Record this process as the owner. */
export function recordSockOwner(sockPath, pid) {
  writeFileSync(ownerFileFor(sockPath), `${pid}\n`);
}

/** Is the pid a live process? EPERM counts as alive: it exists, it is not ours. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Is the pid actually running the daemon, rather than whatever the OS handed
 * that number to later? Without this, one recycled pid after a hard kill would
 * make the daemon refuse to boot forever.
 *
 * WHICH WAY TO FAIL matters here. If `ps` cannot answer, this says YES. A false
 * yes refuses to start, which is loud, logged and self healing (launchd retries
 * on its throttle). A false no steals a live daemon's socket in silence, which
 * is the bug this file exists to prevent. `runPs` is injectable so that
 * direction can be tested rather than asserted in a comment.
 */
export function pidRunsScript(pid, marker, runPs = defaultRunPs) {
  try {
    const r = runPs(pid);
    if (!r || r.error || typeof r.stdout !== 'string') return true; // cannot tell
    if (r.status === null || r.status === undefined) return true; // ps died on a signal: also cannot tell
    if (r.status !== 0) return false; // ps ran, knows the pid, and says it is gone
    return r.stdout.includes(marker);
  } catch {
    return true;
  }
}

function defaultRunPs(pid) {
  return spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
}

/**
 * Is anything actually listening on this socket path?
 *
 * The one question the filesystem cannot answer and the pid file may not cover.
 * Three answers mean nothing is listening, and they are the only three:
 * ECONNREFUSED (a leftover socket inode with no server behind it), ENOENT (it
 * went away while we looked) and ENOTSOCK (whatever is at that path is not a
 * socket at all, so it cannot be serving). ANY other outcome, including a
 * timeout or a permission error, resolves true: same fail direction as
 * pidRunsScript, for the same reason.
 */
const DEAD_SOCKET_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

export function probeSocketLive(sockPath, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (live) => {
      if (settled) return;
      settled = true;
      resolve(live);
    };
    let sock;
    try {
      sock = net.connect({ path: sockPath });
    } catch {
      return finish(true); // cannot even try: assume somebody is there
    }
    const timer = setTimeout(() => {
      finish(true);
      sock.destroy();
    }, timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      // Connect and leave. The protocol answers a request; we are not making
      // one, and a bare connect costs the live daemon nothing but a close.
      sock.destroy();
      finish(true);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      sock.destroy();
      finish(!DEAD_SOCKET_CODES.has(e.code));
    });
  });
}

/**
 * Decide whether we may bind sockPath, do the one filesystem act the decision
 * implies (unlinking a corpse), and RECORD US AS THE OWNER when we may.
 *
 * The record is written here rather than in the listen callback on purpose.
 * Between this guard and the bind, bridge.mjs makes two Telegram calls that can
 * hang for 90 seconds each; a second daemon starting inside that window used to
 * see an unclaimed path and sail through, and the loser of the resulting bind
 * race kept running as a full second daemon with no control socket. Claiming
 * the name first closes that window. The cost is a pid file naming a process
 * that has not bound yet, which is exactly what we want a rival to see.
 *
 * The probes are injectable so the unit tests can describe a world without
 * spawning processes in it.
 */
export async function claimSteerSock(sockPath, opts = {}) {
  const selfPid = opts.selfPid ?? process.pid;
  const marker = opts.marker ?? 'bridge.mjs';
  const isOwnerAlive = opts.isOwnerAlive ?? ((pid) => pidAlive(pid) && pidRunsScript(pid, marker));
  const isSockLive = opts.isSockLive ?? ((p) => probeSocketLive(p));
  const ownerPid = opts.ownerPid !== undefined ? opts.ownerPid : readSockOwner(sockPath);
  const sockExists = existsSync(sockPath);
  const ownerAlive = ownerPid ? isOwnerAlive(ownerPid) : false;
  // Skip the connect when the pid record has already settled it: a live owner
  // is a refusal either way, and there is no socket to probe when there is no
  // socket file.
  const settledByPid = !!(ownerPid && ownerPid !== selfPid && ownerAlive);
  const sockLive = sockExists && !settledByPid ? await isSockLive(sockPath) : false;

  const decision = claimDecision({ sockExists, sockLive, ownerPid, ownerAlive, selfPid });
  if (decision.action === 'refuse') return decision;
  if (decision.action === 'replace') {
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch (e) {
      return { action: 'refuse', ownerPid: decision.ownerPid, reason: `could not clear the stale socket: ${e.message}` };
    }
  }
  if (opts.record !== false) {
    try {
      recordSockOwner(sockPath, selfPid);
    } catch (e) {
      return { ...decision, recordError: e.message };
    }
  }
  return decision;
}

/**
 * Give the socket up. Returns the decision, with `unlinked` saying what
 * actually happened, so a caller can log the difference between "cleaned up"
 * and "left it alone on purpose".
 */
export function releaseSteerSock(sockPath, opts = {}) {
  const selfPid = opts.selfPid ?? process.pid;
  const ownerPid = opts.ownerPid !== undefined ? opts.ownerPid : readSockOwner(sockPath);
  const decision = releaseDecision({ ownerPid, selfPid });
  if (!decision.unlink) return { ...decision, unlinked: false };
  let unlinked = false;
  try {
    if (existsSync(sockPath)) {
      unlinkSync(sockPath);
      unlinked = true;
    }
    const owner = ownerFileFor(sockPath);
    if (existsSync(owner)) unlinkSync(owner);
  } catch {
    // Shutdown is not a place to throw. The next boot replaces a leftover file.
  }
  return { ...decision, unlinked };
}
