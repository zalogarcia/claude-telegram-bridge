// ---------------------------------------------------------------------------
// DETACHED BACKGROUND WORKERS — so the daemon dying stops being a worker dying.
//
// A background worker used to be an ordinary child of the daemon, and THREE
// separate things tied its life to the daemon's:
//   1. it sat in the daemon's process group, so it took every signal aimed at
//      the daemon (launchctl kickstart -k, safe-restart, a crash-loop kill);
//   2. its stdout was a PIPE to the daemon, so the moment the daemon died the
//      worker's next write hit a broken pipe and killed it — detaching ALONE
//      does not fix this;
//   3. its outcome was only ever recorded by `child.on('close')`, a handler that
//      needs the daemon alive to run at all.
//
// Measured 2026-08-02: a safe-restart timed out over a live child and restarted.
// A 5-piece video job died mid-composite — four outputs left unverified, one a
// truncated mp4 with no moov atom, one piece never started, no report written.
// The owner found it, not the daemon. It had happened repeatedly before.
//
// The watchdog half of this module DETECTS that. The spawn half PREVENTS it:
//   • own process group (detached: true) — daemon signals never reach the worker
//   • stdout/stderr to a FILE, not a pipe — nothing left to break when the
//     daemon dies
//   • stdin written once and then LEFT OPEN, so the daemon can steer the worker
//     mid-run (2026-09-03; it used to be closed at spawn, which made a
//     dispatched worker unreachable and turned every correction into a kill plus
//     a re-dispatch that threw the warm context away). This does not re-couple
//     the worker to the daemon: when the daemon dies the kernel closes its write
//     end, the worker reads EOF, which is exactly what it used to get at spawn,
//     and the CLI exits on that EOF, so a detached worker still finishes alone.
//     The daemon ends stdin itself on the result event. Section 9 of
//     detached-workers.test.mjs proves the orphan case with its control, and
//     scripts/probes/steer-probe-B.mjs proves it against the real binary.
//   • the daemon reads results by TAILING that file, and re-attaches to any
//     still-running worker at startup (see createWorkerWatchdog/reattachLiveWorkers)
//
// Do NOT "simplify" this back to pipes. Pipes are what killed the video job.
// The chat lane deliberately keeps the old shape: it is interactive, the owner
// watches it live, and its output belongs in a Telegram bubble rather than a
// file. Steering is no longer what separates the two lanes; stdio is.
//
// ---------------------------------------------------------------------------
// This module is SHARED VERBATIM between the public and private bridge repos
// (see scripts/check-shared.sh, which fails the build if the two copies drift).
// That is only possible because it owns no paths and no prose: every filesystem
// location arrives as an argument, and every user-visible message is produced by
// an injected callback. Keep it that way — if you find yourself reaching for a
// repo-level global or writing an owner-specific string in here, inject it
// instead.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// The ONE place that decides how a worker's stdio is wired.
//   logPath null → chat lane, unchanged: pipes on all three fds, child stays in
//                  the daemon's group.
// Both lanes leave stdin open for mid-run steering; the difference here is the
// process group and where stdout goes, never the input pipe.
//   logPath set  → background lane: own process group AND stdout/stderr on a
//                  file. Both are load-bearing — a detached child still dies on
//                  its next write if that write goes down a pipe to a dead
//                  parent (EPIPE/SIGPIPE). Proven by the two control cases in
//                  detached-workers.test.mjs.
export function spawnWorker(bin, args, { cwd, env, logPath }) {
  if (!logPath) {
    return { child: spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }), logPath: null };
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  try {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', fd, fd], detached: true });
    child.unref(); // a worker must never hold the daemon's event loop open
    return { child, logPath };
  } finally {
    // The child dup'd the fd at spawn; ours has to go or the daemon pins the
    // file open and leaks one fd per run it has ever started.
    fs.closeSync(fd);
  }
}

// Node has no tail -f. Poll from a saved byte offset and emit only COMPLETE
// lines — a partial trailing line is carried to the next tick, so a half-written
// JSON event is never parsed-and-dropped. Feeds exactly the line handler the
// stdout pipe used to feed.
export function tailLines(logPath, onLine, { intervalMs = 300 } = {}) {
  let offset = 0;
  let carry = '';
  let busy = false;
  const decoder = new StringDecoder('utf8'); // a read can land mid multi-byte char
  const pump = () => {
    if (busy) return; // a slow handler must not let ticks re-enter and double-read
    busy = true;
    try {
      let size;
      try {
        size = fs.statSync(logPath).size;
      } catch {
        return; // not created yet, or already pruned
      }
      if (size <= offset) return;
      let chunk = '';
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(size - offset);
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        chunk = decoder.write(buf.subarray(0, n));
      } finally {
        fs.closeSync(fd);
      }
      const parts = (carry + chunk).split('\n');
      carry = parts.pop(); // incomplete tail — wait for the rest
      for (const line of parts) {
        if (!line.trim()) continue;
        // PER LINE, not per batch. The offset above has already advanced past
        // this whole chunk, so a line that throws is a line nobody will ever
        // read again: with one shared try/catch, a formatter blowing up on some
        // odd tool block also silently swallowed the `result` line sitting
        // behind it in the same poll. That used to cost a progress entry. Since
        // background workers started holding stdin open, the daemon seeing the
        // result line is the ONLY thing that ends their stdin and lets them
        // exit, so the same swallow would strand the worker for good (lane kill
        // timers are disabled by default).
        try {
          onLine(line);
        } catch (e) {
          console.error('[bridge] tail line handler failed:', e.message);
        }
      }
    } catch (e) {
      console.error('[bridge] tail failed:', e.message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(pump, intervalMs);
  return {
    pump,
    // Final pump BEFORE clearing the timer: a worker writes its result line
    // immediately before exiting, so without this the outcome loses a race with
    // the poll interval and every run reports "ended with no output".
    stop: () => {
      pump();
      clearInterval(timer);
    },
    offset: () => offset,
  };
}

// Fatal harness errors that Claude Code delivers AS the result text of the
// final result event, so "there is result text" is not proof of success.
// Phrase-anchored in the same spirit as the limit detection in the private
// repo's accounts.mjs: specific multi-word phrases, each with a reason, never a
// bare /error/i — a worker's ANSWER legitimately contains the word "error"
// all the time (bug reports, audits, test output).
//   Measured 2026-08-31: a worker died with "Failed to authenticate: OAuth
//   session expired and could not be refreshed" as its result text, and the
//   text-wins rule below stamped it `✅ … · 7m 1s`. Nobody looked for hours.
const FATAL_RESULT_PHRASES = [
  /failed to authenticate/i, // the CLI's auth-death preamble (the 2026-08-31 green tick)
  /oauth session expired/i, // the token-death middle of that same message
  /could not be refreshed/i, // its tail — any fragment of it alone still means the run died
  /invalid api key/i, // the CLI's other credential death, emitted the same way
];
export function isFatalResultText(text) {
  const s = String(text || '');
  return FATAL_RESULT_PHRASES.some((re) => re.test(s));
}

// The single place that turns (answers, result event, exit code, stderr) into
// what the chat lane is told. The close handler calls it while the daemon is
// alive; the re-attach path calls it for a worker that outlived the daemon.
// Same inputs, same outcome, by construction — that is the property
// detached-workers.test.mjs asserts.
// `record` is what goes to the durable results log; null means "don't record",
// which preserves the pre-existing behaviour that a silent worker leaves no row.
export function bgOutcome(resultTexts, resultEvent, code, stderrTail) {
  if (resultTexts.length) {
    const answer = resultTexts.join('\n\n');
    // Text is not proof of success. The result EVENT's own error flags win
    // (is_error, or a subtype that is present and not "success" — an absent
    // subtype is an older event shape, not an error), and the known fatal
    // harness phrases above catch the case where the event LOOKS clean but the
    // text is the CLI reporting its own death.
    const eventErrored =
      !!resultEvent && (resultEvent.is_error === true || (resultEvent.subtype != null && resultEvent.subtype !== 'success'));
    if (eventErrored || isFatalResultText(answer)) {
      return { status: 'failed', answer: `The worker FAILED: ${answer}`, record: `FAILED: ${answer}` };
    }
    return { status: 'finished', answer, record: answer };
  }
  if (resultEvent?.is_error || code !== 0) {
    const detail = (stderrTail || '').trim() || resultEvent?.subtype || `exit code ${code}`;
    return { status: 'failed', answer: `The worker FAILED: ${detail}`, record: `FAILED: ${detail}` };
  }
  return { status: 'finished', answer: 'The worker ended with no output.', record: null };
}

// Rebuild a worker's outcome from the raw stream-json lines it wrote to disk.
// Mirrors what the live line handler accumulates: every turn's result event
// (steering can produce more than one) plus any non-JSON line, which on a
// background lane is stderr — stdout and stderr share the one log file.
export function bgOutcomeFromLines(lines, { code = null } = {}) {
  let resultEvent = null;
  const resultTexts = [];
  let stderrTail = '';
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      stderrTail = (stderrTail + line + '\n').slice(-2000);
      continue;
    }
    if (ev.type !== 'result') continue;
    resultEvent = ev;
    if (typeof ev.result === 'string' && ev.result.trim()) resultTexts.push(ev.result);
  }
  // A re-attached worker has no exit code — it died with the handler that would
  // have received it. Infer the only way left: an errored result event, or
  // stderr with no result at all, is a failure; silence is not.
  const eff = code != null ? code : resultEvent ? (resultEvent.is_error ? 1 : 0) : stderrTail.trim() ? 1 : 0;
  return bgOutcome(resultTexts, resultEvent, eff, stderrTail);
}

// pid alive? signal 0 tests existence without touching the process.
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours — still alive
  }
}

// ---------------------------------------------------------------------------
// THE WATCHDOG REGISTRY
//
// `child.on('close')` records every outcome, but it only runs if the DAEMON is
// alive to run it. A worker killed by a restart, a SIGKILL, an OOM or a usage
// wall dies with its handler, so its work is neither reported nor recorded.
//
// The registry is the on-disk answer: every background worker's pid and log are
// written here at spawn and cleared on genuine completion, so anything still
// listed is a worker whose outcome nobody has delivered.
//
// Since workers became DETACHED, a restart no longer kills them, so "still
// inflight at startup" now means one of two things and the two must not be
// confused: pid alive → RE-ATTACH (reattachLiveWorkers), pid dead → reap.
// Startup runs re-attach FIRST for exactly that reason.
//
// The file lives wherever the host says. Tests point it at a temp dir; the
// daemon points it at its own directory. Nothing in here knows the difference —
// which is what stopped the test suite from being able to clobber a live
// registry out from under a running worker.
// ---------------------------------------------------------------------------
export function createInflightRegistry({ file }) {
  if (!file) throw new Error('createInflightRegistry: `file` is required');

  function read() {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function write(map) {
    try {
      fs.writeFileSync(file, JSON.stringify(map, null, 2));
    } catch (e) {
      console.error('[watchdog] write failed:', e.message);
    }
  }
  function add(id, rec) {
    const m = read();
    m[id] = rec;
    write(m);
  }
  function clear(id) {
    const m = read();
    if (!(id in m)) return;
    delete m[id];
    write(m);
  }
  return { file, read, write, add, clear };
}

// Ties the registry to the live daemon: reaping, re-attaching, log pruning.
//
// Every side effect is injected, because every side effect is where the two
// bridge repos legitimately differ:
//   onDeadWorkers(dead, reason)  dead = [{ id, rec, ageMs }] — the host writes
//                               the alert; wording is not this module's business
//   onOutcome(task, outcome, id) deliver a re-attached worker's result the same
//                               way the close handler would have
//   log(msg)                     informational line, defaults to console.log
export function createWorkerWatchdog({
  registry,
  runsDir,
  tailIntervalMs = 300,
  reattachPollMs = 5_000,
  reattachKeepCap = 400, // bound memory: only outcome-bearing lines are kept
  onDeadWorkers,
  onOutcome,
  log = (m) => console.log(m),
  now = () => Date.now(),
}) {
  if (!registry) throw new Error('createWorkerWatchdog: `registry` is required');

  // Ids a re-attach poll is already watching (workers that outlived the previous
  // daemon). Their death is handled and WILL be reported by reattachWorker with
  // the real answer from their log — so the periodic reaper must not also
  // announce them, or the chat lane gets a "worker vanished, go salvage" alarm
  // seconds before the worker's actual result lands.
  const reattachedIds = new Set();

  // Report every worker that died without delivering, then forget it so a single
  // death is announced once and never loops.
  function reapDeadWorkers(reason) {
    const m = registry.read();
    const dead = Object.entries(m).filter(([id, r]) => !reattachedIds.has(id) && !pidAlive(r.pid));
    if (!dead.length) return 0;
    for (const [id] of dead) delete m[id];
    registry.write(m);
    onDeadWorkers?.(
      dead.map(([id, rec]) => ({ id, rec, ageMs: rec.startedAt ? now() - rec.startedAt : null })),
      reason,
    );
    return dead.length;
  }

  // Resume watching a background worker that OUTLIVED the previous daemon. It is
  // still running and still appending to its log, so tail that log and poll its
  // pid; when it finally exits, run the same reporting path the close handler
  // would have run. Without this a survivor finishes into the void — which is the
  // silent death this whole design exists to prevent, just moved one step later.
  function reattachWorker(id, rec) {
    const kept = [];
    const tail = tailLines(
      rec.log,
      (line) => {
        let ev = null;
        try {
          ev = JSON.parse(line);
        } catch {
          /* non-JSON on a bg lane is stderr — keep it, it becomes the failure detail */
        }
        // Assistant/tool events are progress, and a re-attached worker has no
        // progress bubble to render them into. Keep only what the outcome is
        // derived from, so a multi-hour run's log never lands in memory.
        if (ev && ev.type !== 'result') return;
        kept.push(line);
        if (kept.length > reattachKeepCap) kept.splice(0, kept.length - reattachKeepCap);
      },
      { intervalMs: tailIntervalMs },
    );

    reattachedIds.add(id);
    const poll = setInterval(() => {
      if (pidAlive(rec.pid)) return;
      clearInterval(poll);
      tail.stop(); // final pump — the result line is written just before exit
      reattachedIds.delete(id);
      registry.clear(id); // reported right here, so the reaper must never announce it too
      onOutcome?.(
        rec.task || '(unknown task — worker re-attached after a daemon restart)',
        bgOutcomeFromLines(kept),
        id, // the registry key, so a re-attached worker's report files under its own run id
      );
    }, reattachPollMs);
    poll.unref?.(); // a re-attach poll must not hold the process open by itself
    log(`[bridge] re-attached to live worker ${id} (pid ${rec.pid}) — ${rec.log}`);
    return { stop: () => { clearInterval(poll); tail.stop(); reattachedIds.delete(id); } };
  }

  // MUST run BEFORE reapDeadWorkers(). A worker that survived the restart is very
  // much alive; announcing it as dead would send the chat lane off to salvage a
  // running job and quite possibly relaunch a duplicate of it.
  function reattachLiveWorkers() {
    let n = 0;
    for (const [id, rec] of Object.entries(registry.read())) {
      if (!pidAlive(rec.pid)) continue; // dead — the reaper's job, not ours
      // A record written before workers were detached has no log to tail. Leave it
      // registered and untouched: the reaper reports it when its pid goes away.
      if (!rec.log) continue;
      reattachWorker(id, rec);
      n++;
    }
    return n;
  }

  // Run logs are small, but a daemon up for months would keep every one forever.
  // Nothing reads a log after its worker has reported, so drop the old ones at
  // startup — except any log still named by a live registry entry, which is a
  // worker we are actively tailing.
  function pruneRunLogs(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    if (!runsDir) return 0;
    let removed = 0;
    try {
      const live = new Set(
        Object.values(registry.read())
          .map((r) => r.log)
          .filter(Boolean),
      );
      for (const f of fs.readdirSync(runsDir)) {
        const p = path.join(runsDir, f);
        if (live.has(p)) continue;
        if (now() - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.unlinkSync(p);
          removed++;
        }
      }
    } catch {
      /* no runs dir yet, or a racing write — never worth failing startup over */
    }
    return removed;
  }

  return { reapDeadWorkers, reattachWorker, reattachLiveWorkers, pruneRunLogs, reattachedIds };
}
