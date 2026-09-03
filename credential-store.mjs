// WHERE CLAUDE CODE KEEPS ITS CREDENTIALS, behind one small interface, so the
// account switcher works on every platform Claude Code runs on instead of only
// on macOS.
//
// SHARED MODULE — byte-identical in the public and private bridge repos, and
// listed in scripts/check-shared.sh. It HANDLES credentials but CONTAINS none:
// no paths beyond Claude Code's own documented ones, no secrets, no
// owner-specific behaviour. Everything is injectable, so tests never touch a
// real keychain or a real home directory.
//
// ---------------------------------------------------------------------------
// THE INTERFACE
//
//   read()           -> the parsed credential blob, or null
//   write(blob)      -> persists it; THROWS on failure (see the error contract)
//   preflight(blob)  -> optional; THROWS `refused` if write(blob) would be
//                       refused, without touching anything. accounts.mjs calls
//                       it BEFORE its one-time pre-write backup, so a doomed
//                       write leaves no side effects at all.
//   describe()       -> a short human string for logs and replies
//   kind             -> 'keychain' | 'file', for logs and tests
//
// Two implementations satisfy it, and `createCredentialStore()` picks the one
// that matches the platform. Reading the Claude Code binary shows its own
// credential store is composed as `keychain-with-plaintext-file-fallback`:
//
//   macOS       Keychain generic password, service "Claude Code-credentials",
//               account = the unix username.
//   otherwise   ~/.claude/.credentials.json, the same JSON shape, 0600.
//
// The blob has two top-level keys that matter, whichever backend holds it:
//
//   claudeAiOauth: THE ACCOUNT. accessToken, refreshToken, expiresAt,
//                  refreshTokenExpiresAt, scopes, subscriptionType,
//                  rateLimitTier. This is the only thing a swap replaces.
//   mcpOAuth:      THIS MACHINE's MCP server tokens. Per-machine, NOT
//                  per-account, so they have to survive every swap. That is
//                  what accounts.mjs's mergeBlob() is for.
//
// ---------------------------------------------------------------------------
// THE ERROR CONTRACT: why write() THROWS instead of returning false
//
// A backend knows two different things went wrong and the caller must be able
// to tell them apart:
//
//   REFUSED   nothing was attempted, so nothing can be damaged (the payload is
//             too large for EVERY write path the backend has). The error
//             carries `refused: true`.
//   FAILED    a write was attempted and did not land, or may have landed
//             corrupted. The caller must read back, verify, and roll back.
//
// A boolean cannot carry that distinction, and rolling back a write that never
// happened is itself a write — which is exactly what a refusal exists to avoid.
// accounts.mjs owns the snapshot/verify/rollback loop, once, for both backends;
// this module owns only "put these bytes there, or say why not".
//
// NOTHING here prints a token. A credential blob is returned to the caller and
// never logged; on the keychain path stderr is dropped entirely, because a
// `security` error message can quote what it was given.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
export const SECURITY_TIMEOUT_MS = 15_000;

// `security -i` reads commands LINE BY LINE with a ~4096 character buffer. Past
// that the line is SPLIT: the tail is parsed as a second command ("security:
// unknown command \"b2261636365...\"") and the item is left holding TRUNCATED
// data. Measured on a real macOS install, 2026-08-31: a 4040-character command
// round-tripped, a 4140-character one did not and the stored value was cut at
// 4030.
//
// The whole blob rides on that one line as hex, and mcpOAuth is the bulk of it
// (1434 of 1955 bytes on the machine this was measured on) and GROWS with every
// MCP server added — the real margin there was about 117 characters. This is
// not theoretical: a swap corrupted a live keychain this way, leaving a blob
// with no claudeAiOauth in it at all.
export const SECURITY_LINE_LIMIT = 4000; // under the observed 4096 cliff, deliberately

// AND THE ESCAPE HATCH, because "refuse everything past the line buffer" is a
// deadlock once mcpOAuth outgrows it. That is exactly what happened: a single
// leadconnector MCP OAuth entry of 4347 characters took the blob to 5782 bytes,
// 11633 characters encoded, and every swap was refused with the store intact
// and the switcher useless.
//
// `security add-generic-password -U -a <acct> -s <svc> -X <hex>` sends the same
// payload through argv, which has no line buffer. Measured on the same machine,
// 2026-09-01, with a 6131-character payload: the argv form wrote it and read it
// back byte for byte, where the `-i` form truncated the stored value at 4030.
// macOS ARG_MAX is about 1MB, so the ceiling below is a conservative fence
// rather than a cliff. (Piping the password to stdin with -w is NOT a third
// option: it goes through getpass and caps at 128 characters.)
export const ARGV_LIMIT = 200000;

// The non-macOS location, and Claude Code's own fallback everywhere.
export function defaultCredentialsPath(home = homedir()) {
  return path.join(home, '.claude', '.credentials.json');
}

function refuse(message) {
  const e = new Error(message);
  e.refused = true; // nothing was attempted; the caller must NOT roll back
  return e;
}

// ---------------------------------------------------------------------------
// macOS KEYCHAIN
// ---------------------------------------------------------------------------

// `security -i` reads the command from stdin, so the hex payload never enters
// argv (and therefore never enters `ps`). -X takes the password as hex, which
// sidesteps every quoting question about embedded JSON. This is the exact shape
// Claude Code's own keychain writer uses; both properties are load-bearing, and
// the accounts tests decode this exact payload. Past the line buffer the same
// command goes through argv instead, because a blob that fits nowhere is a
// switcher that cannot switch: see planWrite() for the tradeoff.
export function createKeychainStore({
  service = KEYCHAIN_SERVICE,
  account = userInfo().username,
  runSecurity = defaultRunSecurity,
} = {}) {
  if (/["\n]/.test(service) || /["\n]/.test(account)) {
    throw new Error('createKeychainStore: service/account must not contain quotes or newlines');
  }

  async function read() {
    const { code, stdout } = await runSecurity(['find-generic-password', '-a', account, '-s', service, '-w']);
    if (code !== 0 || !stdout.trim()) return null;
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return null; // never echo the payload; a corrupt blob is reported as absent
    }
  }

  // THE ONE decision point: which write path carries this payload, or neither.
  // preflight() and write() both come through here, so a refusal and an
  // accepted write can never disagree about what fits.
  function planWrite(blob) {
    const hex = Buffer.from(JSON.stringify(blob), 'utf8').toString('hex');
    const cmd = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    if (cmd.length <= SECURITY_LINE_LIMIT) return { via: 'stdin', cmd, chars: cmd.length };

    // THE FALLBACK, and what it costs, honestly: this hex IS visible in `ps`
    // for the duration of the one `security` call. That is why the stdin form
    // above stays the preferred path and keeps its own test. The exposure is
    // accepted only here, only past the line buffer, for two reasons: the same
    // credentials already sit in plaintext in accounts.json at 0600 for the
    // same user, so this is not a new class of exposure, and the alternative is
    // that account rotation stops working entirely the moment mcpOAuth grows
    // past ~2KB, which is what it did.
    const args = ['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex];
    const chars = args.reduce((n, a) => n + a.length + 1, 0);
    if (chars <= ARGV_LIMIT) return { via: 'argv', args, chars };

    throw refuse(
      `the credential payload is ${chars} chars encoded, over the ${ARGV_LIMIT} limit of both security write paths; nothing was written`,
    );
  }

  // Throws `refused` when write(blob) would be refused, and touches nothing.
  // Called by accounts.mjs before any side effect of a swap (its one-time
  // backup included), so an unwritable payload leaves the world exactly as it
  // found it. It may only refuse what BOTH paths refuse: refusing everything
  // the stdin path could not carry is what stopped every swap on this machine.
  async function preflight(blob) {
    planWrite(blob);
  }

  async function write(blob) {
    // Belt and braces: the same decision as preflight, because this store must
    // never truncate a keychain item regardless of caller discipline.
    const plan = planWrite(blob);
    const { code } = plan.via === 'stdin' ? await runSecurity(['-i'], plan.cmd) : await runSecurity(plan.args);
    if (code !== 0) throw new Error(`security exited ${code}`);
    // A zero exit is NOT proof the item holds what was sent (the truncation
    // failure above exits 0). The caller owns read-back verification, because
    // the caller owns the rollback that a failed verification demands.
  }

  return { kind: 'keychain', read, write, preflight, describe: () => `macOS keychain (${service})` };
}

// stdout is a credential blob on the read path. It is returned to the caller and
// never logged; stderr is dropped entirely for the same reason.
function defaultRunSecurity(args, stdin = null) {
  return new Promise((resolve) => {
    const child = execFile(
      'security',
      args,
      { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '' }),
    );
    if (stdin != null) {
      child.stdin.end(stdin);
    }
  });
}

// ---------------------------------------------------------------------------
// PLAINTEXT FILE (Linux, Windows, WSL, and anywhere else Claude Code runs)
//
// The file IS the credential store on those platforms — this module did not
// choose plaintext, Claude Code did. What it can control is that Leash
// never makes the exposure worse: the write goes to a sibling temp file at
// 0600 and is renamed into place — rename(2) within a directory is atomic, so
// a reader never sees a half-written file and a failure mid-write cannot
// damage the credentials already there — and an existing file's permissions
// are only ever narrowed, never widened.
// ---------------------------------------------------------------------------
export function createFileStore({ path: file = defaultCredentialsPath(), fs = nodeFs } = {}) {
  if (!file) throw new Error('createFileStore: `path` is required');

  function read() {
    try {
      const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
      return blob && typeof blob === 'object' && !Array.isArray(blob) ? blob : null;
    } catch {
      return null; // absent, unreadable or corrupt all mean "no credentials here"
    }
  }

  // 0600 for a new file. For an existing one, keep only the bits it already
  // has: 0644 tightens to 0600, 0400 stays 0400. There is no input that widens.
  function targetMode() {
    try {
      return fs.statSync(file).mode & 0o600;
    } catch {
      return 0o600;
    }
  }

  function write(blob) {
    const mode = targetMode();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(blob), { mode });
    try {
      fs.chmodSync(tmp, mode); // writeFileSync's mode is masked by umask; chmod is not
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
  }

  return {
    kind: 'file',
    read,
    write,
    describe: () => file.replace(homedir(), '~'),
  };
}

// ---------------------------------------------------------------------------
// THE PICKER
//
// Every dependency is injectable so a test can prove the platform switch, and
// the file backend, without touching a real keychain or a real home directory.
// ---------------------------------------------------------------------------
export function createCredentialStore({
  platform = process.platform,
  service = KEYCHAIN_SERVICE,
  account = undefined,
  runSecurity = undefined,
  path: file = undefined,
  fs = undefined,
} = {}) {
  if (platform === 'darwin') {
    return createKeychainStore({
      service,
      ...(account === undefined ? {} : { account }),
      ...(runSecurity === undefined ? {} : { runSecurity }),
    });
  }
  return createFileStore({
    ...(file === undefined ? {} : { path: file }),
    ...(fs === undefined ? {} : { fs }),
  });
}
