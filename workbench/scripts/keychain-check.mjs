#!/usr/bin/env node
// Checks Workbench's key store against this computer's real keychain (the login keychain on macOS, the Secret Service
// on Linux), which no test may touch. It saves three made-up values (plain, with non-ASCII letters, and one near the
// length limit), reads them back from a second process, removes them, and checks that they are gone. The values are
// made at run time and never printed or put in a command line; the second process gets only their SHA-256.
// Not part of npm test. Run it yourself, not from an agent:
//
//   node workbench/scripts/keychain-check.mjs              the real keychain: the values sit there for a few seconds,
//                                                          as "Workbench key" items
//   node workbench/scripts/keychain-check.mjs --file-only  the same steps with the 0600-file store (checks this script)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KeyStore, SERVICE } from '../src/core/keys.mjs';

const KEYS = pathToFileURL(fileURLToPath(new URL('../src/core/keys.mjs', import.meta.url))).href;
const say = (s) => process.stdout.write(s + '\n');
const fileOnly = process.argv.includes('--file-only');
const backend = fileOnly ? 'file' : 'auto';

if (process.env.WORKBENCH_AGENT_ID !== undefined && !fileOnly) {
  say('This is running inside an agent, so it will not touch the keychain. Run it yourself.');
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-keychain-check-'));
const values = {
  WB_CHECK_PLAIN: 'wbcheck' + crypto.randomBytes(16).toString('hex'),
  WB_CHECK_TEXT: 'wbcheck-ünïcødé-' + crypto.randomBytes(8).toString('hex'),
  WB_CHECK_LONG: 'wbcheck' + crypto.randomBytes(925).toString('hex').slice(0, 1850),
};
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const expected = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, digest(v)]));

/** What another process finds for this key: { digests } (null when it has none), or { error: true }. */
function readBack(id) {
  const script = `import { KeyStore } from ${JSON.stringify(KEYS)};
    import crypto from 'node:crypto';
    const store = new KeyStore({ home: ${JSON.stringify(home)}, backend: ${JSON.stringify(backend)} });
    await store.load();
    const got = store.valuesOf(${JSON.stringify(id)});
    const d = got ? Object.fromEntries(Object.entries(got).map(([k, v]) => [k, crypto.createHash('sha256').update(String(v)).digest('hex')])) : null;
    process.stdout.write(JSON.stringify(d));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { error: true };
  try { return { digests: JSON.parse(r.stdout) }; } catch { return { error: true }; }
}

/** macOS only: does the login keychain still hold this item? Asked without -w, so the secret is never requested. */
function keychainHas(id, name) {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', `${id}/${name}`], { encoding: 'utf8', timeout: 30_000 });
  return r.status === 0;
}

let id = null;
let ok = true;
try {
  const store = new KeyStore({ home, backend });
  await store.load();
  ({ id } = await store.add({ preset: 'custom', label: 'Workbench keychain check', values, secretNames: Object.keys(values), scope: { kind: 'all' }, agents: 'all' }));
  const kept = (await store.list()).find((k) => k.id === id)?.kept;
  say(`Saved three test values (kept in: ${kept || 'unknown'}).`);

  const back = readBack(id);
  if (back.error || !back.digests) { ok = false; say('Another process could not read them back.'); }
  else {
    const differ = Object.keys(expected).filter((k) => back.digests[k] !== expected[k]);
    if (differ.length) { ok = false; say(`Another process read them back, but these differ: ${differ.join(', ')}.`); }
    else say('Another process read all three back, and they match.');
  }

  await store.remove(id);
  const gone = readBack(id);
  if (gone.error) { ok = false; say('After the removal, another process could not check that they are gone.'); }
  else if (gone.digests) { ok = false; say('After the removal, another process could still read them.'); }
  else say('Removed them: the key store no longer lists them.');
  if (kept === 'keychain') {
    const left = Object.keys(values).filter((name) => keychainHas(id, name));
    if (left.length) { ok = false; say(`The login keychain still holds ${left.length} of them: delete the "${SERVICE}" items whose account starts with ${id}/ in Keychain Access.`); }
    else say('The login keychain no longer holds them either.');
  }
  id = null;
} catch (err) {
  ok = false;
  say(`The key store refused: ${err && err.plain ? err.message : 'an unexpected error.'}`);
  if (!(err && err.plain)) say(String((err && err.message) || err).replace(/wbcheck[^\s'"]*/g, '<test value>'));
} finally {
  if (id) {
    try {
      const s = new KeyStore({ home, backend });
      await s.load();
      await s.remove(id);
    } catch {
      say(`Could not remove the test values: delete the "${SERVICE}" items whose account starts with ${id}/ in Keychain Access.`);
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}
const where = fileOnly ? 'with its file store' : 'with this computer’s keychain';
say(ok ? `The key store works ${where}.` : `The key store did not work as expected ${where}.`);
process.exit(ok ? 0 : 1);
