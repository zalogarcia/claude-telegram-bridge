#!/usr/bin/env node
// Tests for credential-store.mjs — where Claude Code keeps its credentials,
// behind one interface, on every platform.
//
// SHARED TEST, byte-identical in both bridge repos (scripts/check-shared.sh).
//
// Nothing here touches the real keychain or the real home directory. The
// keychain is a fake that decodes the exact `security -i` + hex wire format
// the store sends — a fake that only recorded the call would prove nothing
// about the encoding — and the file backend runs for real against a mkdtemp
// directory, because a real filesystem is the only honest test of modes and
// atomic renames.
//
//   node credential-store.test.mjs

import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KEYCHAIN_SERVICE,
  SECURITY_LINE_LIMIT,
  ARGV_LIMIT,
  defaultCredentialsPath,
  createKeychainStore,
  createFileStore,
  createCredentialStore,
} from './credential-store.mjs';
import { mergeBlob } from './accounts.mjs';

let pass = 0;
const failures = [];
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
};
const eq = (got, want, msg = '') => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg || 'assertion failed');
};
const throwsAsync = async (fn, re, msg) => {
  try {
    await fn();
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`${msg || ''} wrong error: ${e.message}`);
    return e;
  }
  throw new Error(msg || 'expected a throw, got none');
};

const TMP = mkdtempSync(path.join(tmpdir(), 'credential-store-test-'));

// A realistic blob: the account under claudeAiOauth, this machine's MCP tokens
// beside it. mcpOAuth surviving byte for byte is the property every consumer
// of this module depends on.
const BLOB = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-access-AAAAAA',
    refreshToken: 'sk-ant-ort01-refresh-BBBBBB',
    expiresAt: 1787979122825,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
  mcpOAuth: {
    'someserver|1b898ec3d17d86a8': { accessToken: 'mcp-tok-1', expiresAt: 1787000000000, scope: 'read write' },
    'another|a1e78fb3f3c5876c': { accessToken: 'mcp-tok-2', refreshToken: 'mcp-ref-2' },
  },
};

// Decodes the exact wire format the store sends: `security -i` on stdin, the
// payload hex encoded behind -X. If the encoding regresses, this fake stops
// parsing and the tests go red rather than silently accepting anything.
function fakeKeychain(initialBlob) {
  const box = {
    blob: initialBlob ? JSON.parse(JSON.stringify(initialBlob)) : null,
    writes: 0,
    stdinWrites: 0,
    argvWrites: 0,
    argvPayloads: [],
  };
  box.run = async (args, stdin = null) => {
    if (args[0] === 'find-generic-password') {
      return box.blob ? { code: 0, stdout: JSON.stringify(box.blob) } : { code: 44, stdout: '' };
    }
    if (args[0] === '-i' && stdin) {
      const m = stdin.match(/^add-generic-password -U -a "([^"]+)" -s "([^"]+)" -X "([0-9a-f]+)"\n$/);
      if (!m) return { code: 1, stdout: '' };
      box.blob = JSON.parse(Buffer.from(m[3], 'hex').toString('utf8'));
      box.writes++;
      box.stdinWrites++;
      box.lastAccount = m[1];
      box.lastService = m[2];
      return { code: 0, stdout: '' };
    }
    // The argv fallback, for payloads past the `security -i` line buffer. It is
    // decoded here too, so these tests prove the encoding rather than merely
    // recording that a call happened. Landing here is also what the "a small
    // blob never reaches argv" assertions are counting: argvPayloads is the
    // `ps` exposure ledger.
    if (args[0] === 'add-generic-password') {
      box.argvPayloads.push(args);
      const hex = args[args.indexOf('-X') + 1];
      if (!/^[0-9a-f]+$/.test(hex || '')) return { code: 1, stdout: '' };
      box.blob = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
      box.writes++;
      box.argvWrites++;
      box.lastAccount = args[args.indexOf('-a') + 1];
      box.lastService = args[args.indexOf('-s') + 1];
      return { code: 0, stdout: '' };
    }
    box.argvPayloads.push(args);
    return { code: 1, stdout: '' };
  };
  return box;
}

// ---------- the platform switch ----------

await t('darwin gets the keychain store, everything else gets the file store', () => {
  const kc = fakeKeychain(null);
  const mac = createCredentialStore({ platform: 'darwin', account: 'someone', runSecurity: kc.run });
  eq(mac.kind, 'keychain', 'darwin must target the keychain');

  for (const platform of ['linux', 'win32', 'freebsd']) {
    const store = createCredentialStore({ platform, path: path.join(TMP, `switch-${platform}.json`) });
    eq(store.kind, 'file', `${platform} must target the credentials file`);
  }
});

await t('a round trip through the DARWIN store preserves mcpOAuth byte for byte', async () => {
  const kc = fakeKeychain(null);
  const store = createCredentialStore({ platform: 'darwin', account: 'someone', runSecurity: kc.run });
  await store.write(BLOB);
  const back = await store.read();
  eq(JSON.stringify(back.mcpOAuth), JSON.stringify(BLOB.mcpOAuth), 'mcpOAuth changed in the keychain round trip');
  eq(JSON.stringify(back), JSON.stringify(BLOB), 'the whole blob must round-trip');
  eq(kc.argvPayloads.length, 0, 'a payload reached argv, where ps can read it');
});

await t('a round trip through the LINUX store preserves mcpOAuth byte for byte', async () => {
  const file = path.join(TMP, 'linux-roundtrip.json');
  const store = createCredentialStore({ platform: 'linux', path: file });
  await store.write(BLOB);
  const back = await store.read();
  eq(JSON.stringify(back.mcpOAuth), JSON.stringify(BLOB.mcpOAuth), 'mcpOAuth changed in the file round trip');
  eq(JSON.stringify(back), JSON.stringify(BLOB), 'the whole blob must round-trip');
});

await t('the default non-macOS path is ~/.claude/.credentials.json', () => {
  eq(defaultCredentialsPath('/home/someone'), path.join('/home/someone', '.claude', '.credentials.json'));
});

// ---------- the keychain store ----------

await t('the keychain store reads the item and reports corrupt or missing as null', async () => {
  const kc = fakeKeychain(BLOB);
  const store = createKeychainStore({ account: 'someone', runSecurity: kc.run });
  eq(JSON.stringify(await store.read()), JSON.stringify(BLOB));

  kc.blob = null;
  eq(await store.read(), null, 'a missing item is null, not a throw');

  kc.run = async () => ({ code: 0, stdout: 'not json at all' });
  eq(await store.read(), null, 'a corrupt item is reported as absent, never echoed');
});

await t('the keychain write sends the exact security -i + hex shape, addressed correctly', async () => {
  const kc = fakeKeychain(null);
  const store = createKeychainStore({ service: 'Claude Code-credentials', account: 'someone', runSecurity: kc.run });
  await store.write(BLOB);
  eq(kc.writes, 1);
  eq(kc.lastAccount, 'someone');
  eq(kc.lastService, 'Claude Code-credentials');
});

// A blob past the `security -i` line buffer. This is not a hypothetical size:
// one leadconnector MCP OAuth entry alone measured 4347 characters, and the
// whole blob 5782, which is what made every swap refuse.
const OVER_LINE_LIMIT = { ...BLOB, mcpOAuth: { ...BLOB.mcpOAuth, pad: 'x'.repeat(SECURITY_LINE_LIMIT) } };

await t('a payload past the line buffer is WRITTEN through argv, not refused', async () => {
  const kc = fakeKeychain(BLOB);
  const store = createKeychainStore({ account: 'someone', runSecurity: kc.run });
  ok(JSON.stringify(OVER_LINE_LIMIT).length * 2 > SECURITY_LINE_LIMIT, 'this fixture must not fit the -i line');

  await store.preflight(OVER_LINE_LIMIT); // must NOT throw: the argv path can carry it
  await store.write(OVER_LINE_LIMIT);

  eq(kc.argvWrites, 1, 'the oversized write must take the argv path');
  eq(kc.stdinWrites, 0, 'the oversized write must not have been attempted on the -i line');
  eq(kc.lastAccount, 'someone', 'the argv form must address the same account');
  eq(kc.lastService, KEYCHAIN_SERVICE, 'the argv form must address the same service');
  const back = await store.read();
  eq(JSON.stringify(back), JSON.stringify(OVER_LINE_LIMIT), 'the whole oversized blob must round-trip');
  eq(JSON.stringify(back.mcpOAuth), JSON.stringify(OVER_LINE_LIMIT.mcpOAuth), 'mcpOAuth is the reason this path exists');
});

await t('a payload that FITS the line buffer still rides stdin, never argv', async () => {
  const kc = fakeKeychain(null);
  const store = createKeychainStore({ account: 'someone', runSecurity: kc.run });
  await store.write(BLOB);
  eq(kc.stdinWrites, 1, 'a payload that fits must use the -i path');
  eq(kc.argvWrites, 0, 'a payload that fits must NEVER reach argv, where ps can read it');
  eq(kc.argvPayloads.length, 0, 'nothing at all may reach argv for a small payload');
});

await t('a payload past BOTH paths is REFUSED, marked refused, and the keychain is never touched', async () => {
  const kc = fakeKeychain(BLOB);
  let touched = false;
  const realRun = kc.run;
  kc.run = async (args, stdin) => {
    if (args[0] === '-i' || args[0] === 'add-generic-password') touched = true;
    return realRun(args, stdin);
  };
  const store = createKeychainStore({ account: 'someone', runSecurity: kc.run });
  const fat = { ...BLOB, mcpOAuth: { pad: 'x'.repeat(ARGV_LIMIT) } };

  const e1 = await throwsAsync(() => store.preflight(fat), /over the 200000 limit/);
  ok(e1.refused === true, 'preflight must mark the refusal so the caller knows nothing was attempted');
  const e2 = await throwsAsync(() => store.write(fat), /over the 200000 limit/);
  ok(e2.refused === true, 'write must carry the same refused mark');
  eq(touched, false, 'a refused write must not reach the keychain at all');
  eq(JSON.stringify(kc.blob), JSON.stringify(BLOB), 'the stored credentials must be untouched');
});

await t('preflight passes both writable sizes, and writes nothing either time', async () => {
  const kc = fakeKeychain(null);
  const store = createKeychainStore({ account: 'someone', runSecurity: kc.run });
  await store.preflight(BLOB);
  await store.preflight(OVER_LINE_LIMIT); // between the two limits: the argv path's job
  eq(kc.writes, 0, 'preflight must never write');
  eq(kc.argvPayloads.length, 0, 'preflight must not even build an argv call');
});

await t('a non-zero security exit becomes a throw WITHOUT the refused mark', async () => {
  const store = createKeychainStore({ account: 'someone', runSecurity: async () => ({ code: 51, stdout: '' }) });
  const e = await throwsAsync(() => store.write(BLOB), /security exited 51/);
  ok(!e.refused, 'an attempted-and-failed write must not claim nothing was attempted');
});

await t('quotes or newlines in the service/account are rejected at construction', () => {
  for (const bad of ['with"quote', 'with\nnewline']) {
    let threw = false;
    try {
      createKeychainStore({ account: bad, runSecurity: async () => ({ code: 0, stdout: '' }) });
    } catch {
      threw = true;
    }
    ok(threw, `"${bad}" must be rejected — it would break out of the security command`);
  }
});

// ---------- the file store, against a real temp directory ----------

await t('the file store writes at 0600 and reads back identical', async () => {
  const file = path.join(TMP, 'e2e.json');
  const store = createFileStore({ path: file });
  await store.write(BLOB);
  eq((statSync(file).mode & 0o777).toString(8), '600', 'a credentials file must not be readable by anyone else');
  eq(JSON.stringify(await store.read()), JSON.stringify(BLOB));
});

await t('a swap-shaped write through the file store replaces claudeAiOauth and nothing else', async () => {
  const file = path.join(TMP, 'swap.json');
  const store = createFileStore({ path: file });
  await store.write(BLOB);
  const incoming = { accessToken: 'sk-ant-oat01-second-CCCCCC', refreshToken: 'sk-ant-ort01-second-DDDDDD' };
  await store.write(mergeBlob(await store.read(), incoming));
  const back = await store.read();
  eq(back.claudeAiOauth.accessToken, incoming.accessToken, 'the incoming account is not installed');
  eq(JSON.stringify(back.mcpOAuth), JSON.stringify(BLOB.mcpOAuth), 'mcpOAuth was clobbered by the swap');
});

await t('an existing file NEVER widens: 0644 narrows to 0600, 0400 stays 0400', async () => {
  const loose = path.join(TMP, 'loose.json');
  writeFileSync(loose, JSON.stringify(BLOB), { mode: 0o644 });
  chmodSync(loose, 0o644);
  const store = createFileStore({ path: loose });
  await store.write(BLOB);
  eq((statSync(loose).mode & 0o777).toString(8), '600', 'a loose file must be tightened by the rewrite');

  const tight = path.join(TMP, 'tight.json');
  writeFileSync(tight, JSON.stringify(BLOB), { mode: 0o600 });
  chmodSync(tight, 0o400);
  await createFileStore({ path: tight }).write(BLOB);
  eq((statSync(tight).mode & 0o777).toString(8), '400', 'a tighter-than-0600 file must stay tight');
});

await t('absent, corrupt, or wrong-shaped files all read as null', async () => {
  eq(createFileStore({ path: path.join(TMP, 'nope.json') }).read(), null);
  const corrupt = path.join(TMP, 'corrupt.json');
  writeFileSync(corrupt, '{not json', { mode: 0o600 });
  eq(createFileStore({ path: corrupt }).read(), null);
  const arr = path.join(TMP, 'array.json');
  writeFileSync(arr, '[1,2,3]', { mode: 0o600 });
  eq(createFileStore({ path: arr }).read(), null, 'an array is not a credential blob');
});

await t('a failed write leaves the previous credentials intact and no temp file behind', async () => {
  const file = path.join(TMP, 'atomic.json');
  const store = createFileStore({ path: file });
  await store.write(BLOB);

  // A filesystem whose rename fails: the one step that could replace the real
  // file. The original must be untouched and the temp file cleaned up — this
  // is what "the file store cannot leave a half-written credential store"
  // rests on: the content only ever becomes visible via an atomic rename.
  const failing = {
    readFileSync,
    writeFileSync,
    statSync,
    chmodSync,
    unlinkSync: (p) => rmSync(p, { force: true }),
    renameSync: () => {
      throw new Error('EXDEV: cross-device link not permitted');
    },
  };
  const broken = createFileStore({ path: file, fs: failing });
  await throwsAsync(() => broken.write({ claudeAiOauth: { accessToken: 'other' } }), /EXDEV/);
  eq(JSON.stringify(createFileStore({ path: file }).read()), JSON.stringify(BLOB), 'the original file was damaged');
  const leftovers = readdirSync(TMP).filter((f) => f.startsWith('atomic.json.') && f.endsWith('.tmp'));
  eq(leftovers, [], 'a failed write left its temp file behind');
});

await t('describe() names the backend without naming a token', () => {
  const kc = createKeychainStore({ account: 'someone', runSecurity: async () => ({ code: 1, stdout: '' }) });
  ok(kc.describe().includes('keychain'));
  const fs1 = createFileStore({ path: '/somewhere/.claude/.credentials.json' });
  ok(fs1.describe().includes('.credentials.json'));
});

// ---------- report ----------

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log('✅ all credential-store tests pass');
