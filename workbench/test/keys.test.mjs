// The key store (src/core/keys.mjs): its checks, the keychain through the `security` stand-in, the Secret Service
// through the `secret-tool` stand-in, private files, keys.json, envFor and masking.
//
// Every test has a temporary HOME, and every store names its program or its backend: nothing here can reach the real
// keychain, and nothing needs /usr/bin/security, so the tests run on macOS and Linux alike. Every key-shaped value is
// built from parts at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyStore, maskSecrets, shownValue, FORBIDDEN_NAMES, forbiddenName, runProgram, securityLine, NAME_RE, SERVICE, MAX_KEYS }
  from '../src/core/keys.mjs';

const SECURITY = fileURLToPath(new URL('./helpers/security-fake.mjs', import.meta.url));
const SECRET_TOOL = fileURLToPath(new URL('./helpers/secret-tool-fake.mjs', import.meta.url));
const KEYS_MODULE = new URL('../src/core/keys.mjs', import.meta.url).href;

const join = (...parts) => parts.join('');
const API_KEY = join('sk-', 'test-', 'NOT-A-REAL-', 'KEY-0123456789');
const AWS_ID = join('AK', 'IA', 'TESTONLY', 'NOTREAL7');
const AWS_SECRET = join('Zq8v', 'Lr2/', 'Tn5w', 'Kx9+', 'Bm3y', 'Hp6s', 'Dj1u', 'Fc4o', 'Wg7e', 'Qa0i');
const ODD_VALUE = join('pässwörd ', 'with "quotes" ', 'and \\ back', 'slash 12');
const STRIPE = join('sk', '_test_', 'NOTREAL', 'xYz0123456789abcdEF');

function tmpHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-keys-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readLog = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const mode = (p) => fs.statSync(p).mode & 0o777;

/** Every form a value could leak in: as it is, as hex, as base64, and as the armoured form the keychain keeps. */
function forms(value) {
  const b64 = Buffer.from(value).toString('base64');
  return [value, Buffer.from(value).toString('hex'), b64, Buffer.from(`wb1:${b64}`).toString('hex')];
}
function assertNoValue(text, values, where) {
  for (const v of values) for (const f of forms(v)) assert.ok(!String(text).includes(f), `${where} holds a value (or its hex or base64)`);
}
function errorText(err) {
  return [err?.message, err?.detail, err?.stack, err?.cause && String(err.cause.message || err.cause), JSON.stringify(err)].join('\n');
}

function logger() {
  const lines = [];
  const log = { warn: (s) => lines.push(`warn ${s}`), info: (s) => lines.push(`info ${s}`) };
  return { log, lines };
}

/**
 * A store on the `security` stand-in, as on a Mac. It runs through the real runProgram, with a spy that counts every
 * program started and what it was given.
 */
function keychainStore(home, { securityMode = '', env: extra = {} } = {}) {
  const env = { ...process.env, FAKE_SECURITY_DB: path.join(home, 'fake-keychain.json'), FAKE_SECURITY_LOG: path.join(home, 'fake-security.log'),
    FAKE_SECURITY_MODE: securityMode, ...extra };
  const runs = [];
  const runner = (bin, args, o) => {
    runs.push({ bin, args, input: o.input });
    return runProgram(bin, args, { ...o, env });
  };
  const { log, lines } = logger();
  const store = new KeyStore({ home, platform: 'darwin', securityBin: SECURITY, runner, log });
  return { store, env, runs, lines, items: () => readJson(env.FAKE_SECURITY_DB, { items: [] }).items, seen: () => readLog(env.FAKE_SECURITY_LOG) };
}

/** A store on the `secret-tool` stand-in, as on Linux with a Secret Service. */
function keyringStore(home, { secretToolMode = '', backend = 'secret-tool', secretToolBin = SECRET_TOOL, path: pathValue } = {}) {
  const env = { ...process.env, FAKE_SECRET_TOOL_DB: path.join(home, 'fake-keyring.json'), FAKE_SECRET_TOOL_LOG: path.join(home, 'fake-secret-tool.log'),
    FAKE_SECRET_TOOL_MODE: secretToolMode, ...(pathValue != null ? { PATH: pathValue } : {}) };
  const { log, lines } = logger();
  const store = new KeyStore({ home, platform: 'linux', backend, secretToolBin, log, env });
  return { store, env, lines, items: () => readJson(env.FAKE_SECRET_TOOL_DB, { items: [] }).items, seen: () => readLog(env.FAKE_SECRET_TOOL_LOG) };
}

/** A store on private files, which starts no program at all: the runner fails the test if it is called. */
function fileStore(home, extra = {}) {
  const { log, lines } = logger();
  const runner = () => { throw new Error('the file store started a program'); };
  return { store: new KeyStore({ home, platform: 'linux', backend: 'file', runner, log, ...extra }), lines };
}

async function refused(promise, why) {
  const err = await promise.then(() => null, e => e);
  assert.ok(err, `refused (${why})`);
  assert.equal(err.why, why, err.message);
  assert.ok(err.plain && typeof err.message === 'string' && /^[A-Z].*[.]$/.test(err.message), `a plain sentence: ${err.message}`);
  return err;
}

// ------------------------------------------------------------------ showing and masking

test('a secret is shown as "•••• " and its last 4 characters at 12 or more, else "••••"', () => {
  assert.equal(shownValue(API_KEY), `•••• ${API_KEY.slice(-4)}`);
  assert.equal(shownValue('abcdefghijk'), '••••');
  assert.equal(shownValue('abcdefghijkl'), '•••• ijkl');
  assert.equal(shownValue('short'), '••••');
  assert.equal(shownValue(''), '••••');
  assert.equal(shownValue('a long value ending "q\\'), '••••', 'a tail that is not plain is not shown');
  assert.equal(shownValue('a long value ending in ünïc'), '••••');
});

test('maskSecrets hides every value of 8 or more characters, longest first, and leaves the rest', () => {
  const text = `key ${API_KEY}, id ${AWS_ID}, pin 12345678, short abc, again ${API_KEY}.`;
  assert.equal(maskSecrets(text, [API_KEY, AWS_ID, '12345678', 'abc']),
    `key •••• ${API_KEY.slice(-4)}, id •••• ${AWS_ID.slice(-4)}, pin ••••, short abc, again •••• ${API_KEY.slice(-4)}.`);
  assert.equal(maskSecrets(text, []), text);
  assert.equal(maskSecrets(text, null), text);
  assert.equal(maskSecrets('', [API_KEY]), '');
  assert.equal(maskSecrets(undefined, [API_KEY]), undefined);
  assert.equal(maskSecrets(text, 'not a list'), text);
  // A value that holds another is hidden whole.
  const inner = join('INNER', 'abcdefgh');
  const outer = join('prefix-', inner, '-suffix99');
  assert.equal(maskSecrets(`x ${outer} y ${inner}`, [inner, outer]), `x •••• ix99 y •••• efgh`);
});

test('maskSecrets also hides a value inside a raw line of JSON, and the line stays JSON', () => {
  const line = JSON.stringify({ type: 'tool_result', content: `printed ${ODD_VALUE} and ${API_KEY}` });
  const masked = maskSecrets(line, [ODD_VALUE, API_KEY]);
  assertNoValue(masked, [ODD_VALUE, API_KEY], 'the masked line');
  assert.equal(JSON.parse(masked).content, `printed •••• and •••• ${API_KEY.slice(-4)}`);
  const quoteTail = join('ends with a quote and backslash "\\', '"');
  const m2 = maskSecrets(JSON.stringify({ t: quoteTail }), [quoteTail]);
  assert.equal(JSON.parse(m2).t, '••••');
});

test('maskSecrets compiles a frozen list of values once', () => {
  const values = Object.freeze([API_KEY, AWS_ID]);
  const started = Date.now();
  for (let i = 0; i < 20000; i++) maskSecrets(`line ${i} with ${API_KEY}`, values);
  assert.ok(Date.now() - started < 3000);
});

// ------------------------------------------------------------------ names refused

test('FORBIDDEN_NAMES lists each refused name with why, and covers the spec’s list', () => {
  for (const f of FORBIDDEN_NAMES) {
    assert.deepEqual(Object.keys(f).sort(), ['name', 'why']);
    assert.match(f.name, /^[A-Z_][A-Z0-9_]*\*?$/);
    assert.match(f.why, /^[a-zA-Z].*[^.]$/, `${f.name}: why finishes a sentence`);
  }
  assert.equal(new Set(FORBIDDEN_NAMES.map(f => f.name)).size, FORBIDDEN_NAMES.length, 'each once');
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CODEX_ACCESS_TOKEN', 'PATH', 'HOME', 'USER', 'SHELL',
    'NODE_OPTIONS', 'NODE_PATH', 'WORKBENCH_HOOK_TOKEN', 'WORKBENCH_AGENT_ID', 'WORKBENCH_CLAUDE_BIN', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'GIT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'CLAUDE_CONFIG_DIR', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_SHELL_PREFIX',
    'CODEX_HOME', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'VSCODE_IPC_HOOK', 'BASH_ENV', 'HTTPS_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'path', 'Home', 'ld_preload']) {
    assert.ok(forbiddenName(name), `${name} is refused`);
  }
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'AWS_SECRET_ACCESS_KEY', 'NODE_ENV', 'DATABASE_URL', 'NPM_TOKEN', 'PATHWAY_KEY', 'USERNAME_FOR_API']) {
    assert.equal(forbiddenName(name), null, `${name} is allowed`);
  }
});

test('a refused name is refused in plain words that say why', async (t) => {
  const { store } = fileStore(tmpHome(t));
  for (const name of ['PATH', 'LD_PRELOAD', 'GIT_DIR', 'WORKBENCH_HOOK_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const err = await refused(store.add({ preset: 'custom', label: 'X', values: { [name]: API_KEY } }), 'forbidden');
    assert.ok(err.message.startsWith(`Workbench does not keep ${name} as a key, because `), err.message);
    assertNoValue(errorText(err), [API_KEY], 'the error');
  }
});

// ------------------------------------------------------------------ checks

test('names: letters, digits and _, not starting with a digit, at most 128, never repeated back', async (t) => {
  const { store } = fileStore(tmpHome(t));
  for (const name of ['1ABC', 'MY-KEY', 'MY KEY', 'KEY=', 'É', 'A'.repeat(129), '', join('AK', 'IA', 'TESTONLY', 'NOTREAL7')]) {
    const err = await refused(store.add({ preset: 'custom', label: 'X', values: { [name]: 'value-1234' } }), 'name');
    if (name) assert.ok(!err.message.includes(name), 'the name is not repeated');
  }
  assert.ok(NAME_RE.test('A'.repeat(128)) && NAME_RE.test('_x') && NAME_RE.test('lower_case'));
});

test('values: 1 to 2,000 characters, one line, no NUL, trimmed; never repeated back', async (t) => {
  const { store } = fileStore(tmpHome(t));
  const add = (value) => store.add({ preset: 'custom', label: 'X', values: { SOME_KEY: value } });
  let err = await refused(add('x'.repeat(2001)), 'value');
  assert.equal(err.message, 'The value of SOME_KEY is 2,001 characters long. A key can be at most 2,000.');
  err = await refused(add(join(API_KEY, '\nsecond line')), 'value');
  assert.match(err.message, /line break/);
  assertNoValue(errorText(err), [API_KEY], 'the error');
  await refused(add(join(API_KEY, String.fromCharCode(0x2028), 'more')), 'value');
  await refused(add(join(API_KEY, '\0')), 'value');
  await refused(add(''), 'value');
  await refused(add('   '), 'value');
  await refused(add(42), 'value');
  const { id } = await add(`  ${API_KEY}\n`);
  assert.deepEqual(store.envFor({}), { SOME_KEY: API_KEY }, 'a pasted key loses its spaces and its newline');
  await store.remove(id);
  await add('x'.repeat(2000));
});

test('labels: 1 to 80 printable characters; a preset’s name when none is given', async (t) => {
  const { store } = fileStore(tmpHome(t));
  const add = (label, preset = 'custom') => store.add({ preset, label, values: preset === 'stripe' ? { STRIPE_SECRET_KEY: STRIPE } : { SOME_KEY: 'value-1234' } });
  await refused(add('x'.repeat(81)), 'name');
  await refused(add('two\nlines'), 'name');
  await refused(add('tab\there'), 'name');
  await refused(add(`hidden${String.fromCharCode(0x202e)}mark`), 'name');
  await refused(add(`zero${String.fromCharCode(0x200b)}width`), 'name');
  await refused(add(API_KEY), 'name');
  await add('x'.repeat(80));
  await add('AWS for the shop – staging ✓');
  await add(null, 'stripe');
  await add(undefined, 'custom');
  const labels = (await store.list()).map(k => k.label);
  assert.deepEqual(labels, ['x'.repeat(80), 'AWS for the shop – staging ✓', 'Stripe', 'SOME_KEY']);
});

test('limits: 20 variables in a key, 50 keys', async (t) => {
  const { store } = fileStore(tmpHome(t));
  const many = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`NAME_${i}`, `value-${i}-abcdef`]));
  await refused(store.add({ preset: 'custom', label: 'Many', values: many(21) }), 'too-many');
  await store.add({ preset: 'custom', label: 'Twenty', values: many(20) });
  for (let i = 1; i < MAX_KEYS; i++) await store.add({ preset: 'custom', label: `Key ${i}`, values: { [`K_${i}`]: `value-${i}-abcdef` } });
  const err = await refused(store.add({ preset: 'custom', label: 'One more', values: { LAST: 'value-abcdef' } }), 'too-many');
  assert.equal(err.message, 'Workbench keeps at most 50 keys. Remove one you no longer use, then add this one.');
  assert.equal((await store.list()).length, 50);
});

test('presets: required fields, optional ones, names given the same value, and which are secret', async (t) => {
  const { store } = fileStore(tmpHome(t));
  const err = await refused(store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID } }), 'value');
  assert.equal(err.message, 'Type a value for AWS_SECRET_ACCESS_KEY.');
  await refused(store.add({ preset: 'nope', values: { A_KEY: 'value-1234' } }), 'name');
  // Empty optional fields are left out; the region is not secret, and is shown as it is.
  const aws = await store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: '', AWS_REGION: 'eu-west-1' } });
  // OpenAI's key is also CODEX_API_KEY; the caller need not say so, nor which names are secret.
  const openai = await store.add({ preset: 'openai', values: { OPENAI_API_KEY: API_KEY } });
  const github = await store.add({ preset: 'github', label: 'GitHub', values: { GITHUB_TOKEN: API_KEY }, agents: [] });
  // A preset's secret field stays secret whatever the caller says; a custom name is secret unless told otherwise.
  const custom = await store.add({ preset: 'custom', label: 'Mine', values: { REGION_NAME: 'eu-west-1', TOKEN: 'abc-12345-xyz', ODD: 'plain words here' }, secretNames: ['TOKEN'] });
  const sneaky = await store.add({ preset: 'anthropic', values: { ANTHROPIC_API_KEY: API_KEY }, secretNames: [] });
  const guessed = await store.add({ preset: 'custom', label: 'Guess', values: { A_SETTING: API_KEY }, secretNames: [] });
  const list = Object.fromEntries((await store.list()).map(k => [k.id, k]));
  assert.deepEqual(list[aws.id].vars, [
    { name: 'AWS_ACCESS_KEY_ID', shown: `•••• ${AWS_ID.slice(-4)}`, secret: true },
    { name: 'AWS_SECRET_ACCESS_KEY', shown: `•••• ${AWS_SECRET.slice(-4)}`, secret: true },
    { name: 'AWS_REGION', shown: 'eu-west-1', secret: false },
  ]);
  assert.equal(list[aws.id].label, 'AWS');
  assert.deepEqual(list[openai.id].vars.map(v => [v.name, v.secret]), [['OPENAI_API_KEY', true], ['CODEX_API_KEY', true]]);
  assert.deepEqual(list[openai.id].agents, ['codex']);
  assert.deepEqual(list[github.id].vars.map(v => v.name), ['GH_TOKEN', 'GITHUB_TOKEN']);
  assert.deepEqual(list[github.id].agents, []);
  assert.deepEqual(list[custom.id].vars.map(v => [v.name, v.secret, v.shown]),
    [['REGION_NAME', false, 'eu-west-1'], ['TOKEN', true, '•••• -xyz'], ['ODD', false, 'plain words here']]);
  assert.equal(list[sneaky.id].vars[0].secret, true);
  assert.equal(list[guessed.id].vars[0].secret, true, 'a value that looks like a key is kept secret');
  assert.deepEqual(store.valuesOf(github.id), { GH_TOKEN: API_KEY, GITHUB_TOKEN: API_KEY });
  assert.equal(store.valuesOf('k000000000000'), null);
});

test('scope and agents are checked', async (t) => {
  const home = tmpHome(t);
  const { store } = fileStore(home);
  const add = (o) => store.add({ preset: 'custom', label: 'X', values: { SOME_KEY: 'value-1234' }, ...o });
  await refused(add({ scope: { kind: 'repo' } }), 'name');
  await refused(add({ scope: { kind: 'repo', root: 'relative/path' } }), 'name');
  await refused(add({ scope: 'repo' }), 'name');
  await refused(add({ scope: { kind: 'everywhere' } }), 'name');
  await refused(add({ agents: 'claude' }), 'name');
  await refused(add({ agents: ['Claude Code'] }), 'name');
  await refused(add({ agents: ['../x'] }), 'name');
  await add({ scope: 'all', agents: ['claude', 'claude', 'gemini'] });
  await add({ scope: { kind: 'repo', root: home }, agents: ['all'] });
  const [a, b] = await store.list();
  assert.deepEqual([a.scope, a.agents], [{ kind: 'all' }, ['claude', 'gemini']]);
  assert.deepEqual([b.scope, b.agents], [{ kind: 'repo', root: home }, 'all']);
});

// ------------------------------------------------------------------ the keychain (security stand-in)

test('keychain: a key round-trips, one command per process, and no value reaches argv, env, keys.json or a log', async (t) => {
  const home = tmpHome(t);
  const { log, lines } = logger();
  const env = { ...process.env, FAKE_SECURITY_DB: path.join(home, 'fake-keychain.json'), FAKE_SECURITY_LOG: path.join(home, 'fake-security.log') };
  const before = JSON.stringify(env);
  // The real runner, as Workbench uses it: only the environment points it at the stand-in's files.
  const store = new KeyStore({ home, platform: 'darwin', securityBin: SECURITY, log, env });
  const secrets = [AWS_ID, AWS_SECRET, ODD_VALUE];
  const { id } = await store.add({ preset: 'aws', label: 'AWS', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'eu-west-2' } });
  const odd = await store.add({ preset: 'custom', label: 'Database', values: { DB_PASSWORD: ODD_VALUE } });
  assert.equal(JSON.stringify(env), before, 'nothing was added to the environment');

  // The items: service "Workbench key", account <id>/<NAME>, the region kept there too.
  const items = readJson(env.FAKE_SECURITY_DB).items;
  assert.deepEqual(items.map(it => [it.service, it.account]), [
    [SERVICE, `${id}/AWS_ACCESS_KEY_ID`], [SERVICE, `${id}/AWS_SECRET_ACCESS_KEY`], [SERVICE, `${id}/AWS_REGION`], [SERVICE, `${odd.id}/DB_PASSWORD`]]);

  // A new store reads them back.
  const again = new KeyStore({ home, platform: 'darwin', securityBin: SECURITY, log, env });
  assert.deepEqual(await again.load(), { keys: 2, missing: 0 });
  assert.deepEqual(again.envFor({ repoRoot: home, harness: 'claude' }),
    { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'eu-west-2', DB_PASSWORD: ODD_VALUE });
  assert.deepEqual([...again.values()].sort(), [...secrets].sort(), 'the region is not a secret');
  const listed = JSON.stringify(await again.list());
  assert.ok(listed.includes('eu-west-2'));
  assertNoValue(listed, secrets, 'list()');

  // What the stand-in saw: always `security -i`, one command per process, every process on stdin alone.
  const seen = readLog(env.FAKE_SECURITY_LOG);
  assert.equal(seen.length, 8);
  for (const s of seen) {
    assert.deepEqual(s.argv, ['-i']);
    assert.equal(s.lines, 1);
    assert.equal(s.commands.length, 1);
    assert.ok(s.bytes < 4000);
  }
  assert.deepEqual(seen.map(s => s.commands[0]), [...Array(4).fill('add-generic-password'), ...Array(4).fill('find-generic-password')]);
  assertNoValue(JSON.stringify(seen), secrets, 'what the stand-in recorded');
  assertNoValue(fs.readFileSync(path.join(home, '.workbench', 'keys.json'), 'utf8'), [...secrets, 'eu-west-2'], 'keys.json');
  assertNoValue(lines.join('\n'), secrets, 'the log');
  assert.ok(lines.some(l => l === 'info Workbench kept a new key that sets AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION.'));

  // Removing it deletes its items, and again finds nothing to remove.
  assert.deepEqual(await again.remove(id), { removed: true });
  assert.deepEqual(await again.remove(id), { removed: false });
  assert.deepEqual(readJson(env.FAKE_SECURITY_DB).items.map(it => it.account), [`${odd.id}/DB_PASSWORD`]);
  assert.deepEqual(again.envFor({}), { DB_PASSWORD: ODD_VALUE });
  assert.ok(again.values().includes(AWS_SECRET), 'a removed key stays masked for the rest of the run: agents may still hold it');
});

test('keychain: values are hex on the command line, and odd values come back as they went in', async (t) => {
  const home = tmpHome(t);
  const w = keychainStore(home);
  const values = { PLAIN: AWS_SECRET, SPACES_AND_QUOTES: ODD_VALUE, LOOKS_LIKE_ARMOUR: 'wb1:not-really-armour', UNICODE: 'ключ-🔑-键-1234' };
  await w.store.add({ preset: 'custom', label: 'Odd', values });
  for (const run of w.runs) {
    assert.equal(run.bin, SECURITY);
    assert.deepEqual(run.args, ['-i']);
    assert.match(run.input, /^add-generic-password -U -s "Workbench key" -a k[0-9a-f]{12}\/[A-Z_]+ -X [0-9a-f]+\n$/);
  }
  const fresh = keychainStore(home);
  await fresh.store.load();
  assert.deepEqual(fresh.store.envFor({}), values);
});

test('keychain: a line of 4000 bytes or more is refused before anything starts', async (t) => {
  const home = tmpHome(t);
  const w = keychainStore(home);
  // About 1,950 plain characters fit; non-ASCII text is armoured, so fewer of it fit.
  const err = await refused(w.store.add({ preset: 'custom', label: 'Long', values: { FIRST: 'value-1234', LONG_VALUE: 'x'.repeat(1990) } }), 'value');
  assert.match(err.message, /^The value of LONG_VALUE is too long for your keychain, which can keep about 1,9\d\d characters in one key\.$/);
  assert.equal(w.runs.length, 0, 'not even the first value was sent');
  await refused(w.store.add({ preset: 'custom', label: 'Long', values: { LONG_TEXT: 'é'.repeat(1500) } }), 'value');
  assert.equal(w.runs.length, 0);
  await w.store.add({ preset: 'custom', label: 'Fits', values: { LONG_VALUE: 'x'.repeat(1900) } });
  assert.equal(w.runs.length, 1);
  assert.ok(Buffer.byteLength(w.runs[0].input) < 4000);
});

test('keychain: a locked keychain, a canceled dialog or any failure is a plain sentence; stderr never gets out', async (t) => {
  for (const [securityMode, sentence] of [
    ['canceled', 'Workbench could not save the key in your keychain, because your keychain was not unlocked.'],
    ['no-window', 'Workbench could not save the key in your keychain, because your keychain is locked, and there is no window to unlock it in.'],
    ['echo', 'Workbench could not save the key in your keychain, because your keychain refused.'],
  ]) {
    const home = tmpHome(t);
    const w = keychainStore(home, { securityMode });
    const err = await refused(w.store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET } }), 'store');
    assert.equal(err.message, sentence);
    assert.match(err.detail, /^security save: [a-z-]+, exit 1$/);
    assertNoValue(errorText(err), [AWS_ID, AWS_SECRET], `the error (${securityMode})`);
    assert.ok(!errorText(err).includes('add-generic-password'), 'nothing of what security said');
    assertNoValue(w.lines.join('\n'), [AWS_ID, AWS_SECRET], 'the log');
    assert.equal(fs.existsSync(path.join(home, '.workbench', 'keys.json')), false, 'nothing recorded');
    assert.deepEqual(await w.store.list(), []);
  }
});

test('keychain: a key whose second value fails is taken back whole', async (t) => {
  const home = tmpHome(t);
  const w = keychainStore(home);
  let calls = 0;
  const failing = (bin, args, o) => (++calls === 2 ? Promise.resolve({ code: 1, stdout: '', stderr: 'security: User canceled the operation.\nadd-generic-password: returned 128\n' })
    : runProgram(bin, args, { ...o, env: w.env }));
  const store = new KeyStore({ home, platform: 'darwin', securityBin: SECURITY, runner: failing });
  await refused(store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET } }), 'store');
  assert.deepEqual(w.items(), [], 'the first value was deleted again');
  assert.equal(fs.existsSync(path.join(home, '.workbench', 'keys.json')), false);
});

test('keychain: a value gone from the keychain is missing, said by name, and agents do not get it', async (t) => {
  const home = tmpHome(t);
  const w = keychainStore(home);
  const { id } = await w.store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET } });
  const db = readJson(w.env.FAKE_SECURITY_DB);
  db.items = db.items.filter(it => it.account !== `${id}/AWS_SECRET_ACCESS_KEY`);
  fs.writeFileSync(w.env.FAKE_SECURITY_DB, JSON.stringify(db));
  const fresh = keychainStore(home);
  assert.deepEqual(await fresh.store.load(), { keys: 1, missing: 1 });
  assert.deepEqual(fresh.store.envFor({}), { AWS_ACCESS_KEY_ID: AWS_ID });
  assert.deepEqual(fresh.lines, ['warn Workbench could not read AWS_SECRET_ACCESS_KEY from your keychain, because the value is not in your keychain any more, so agents will not get it.']);
  const [key] = await fresh.store.list();
  assert.deepEqual(key.vars[1], { name: 'AWS_SECRET_ACCESS_KEY', shown: '••••', secret: true, missing: true });
  // Removing it still works: a value that is already gone is gone.
  assert.deepEqual(await fresh.store.remove(id), { removed: true });
  assert.deepEqual(fresh.items(), []);
});

test('keychain: a locked keychain is asked once, not once for every value', async (t) => {
  const home = tmpHome(t);
  const w = keychainStore(home);
  await w.store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET } });
  await w.store.add({ preset: 'custom', label: 'Two', values: { ONE_KEY: API_KEY, TWO_KEY: STRIPE } });
  const locked = keychainStore(home, { securityMode: 'no-window' });
  assert.deepEqual(await locked.store.load(), { keys: 2, missing: 4 });
  assert.equal(locked.runs.length, 1, 'the first read failed, so no other was tried');
  assert.deepEqual(locked.store.envFor({}), {});
  assert.deepEqual(locked.lines, ['warn Workbench could not read AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ONE_KEY and TWO_KEY from your keychain, because your keychain is locked, and there is no window to unlock it in, so agents will not get them.']);
  // A removal it cannot carry out leaves the key in the list, so it can be tried again.
  const [first] = await locked.store.list();
  await refused(locked.store.remove(first.id), 'store');
  assert.equal((await locked.store.list()).length, 2);
});

test('keychain: with no keys, loading and listing start no program at all', async (t) => {
  const home = tmpHome(t);
  const runner = () => { throw new Error('a program was started'); };
  // The real default program, which the runner never lets start.
  const store = new KeyStore({ home, platform: 'darwin', runner });
  assert.deepEqual(await store.load(), { keys: 0, missing: 0 });
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(store.envFor({ repoRoot: home, harness: 'claude' }), {});
  assert.deepEqual(store.values(), []);
  assert.equal(fs.existsSync(path.join(home, '.workbench')), false, 'nothing written either');
});

// ------------------------------------------------------------------ the stand-in itself

/** Run the stand-in with this text on stdin. */
const security = (input, env = {}) => runProgram(SECURITY, ['-i'], { input, env: { ...process.env, ...env } });

test('the security stand-in splits words as security -i does', async () => {
  const cases = [[`help 'a\\b'`, 'ab'], [`help "a\\"b"`, 'a"b'], ['help a\\ b', 'a b'], [`help "a'b"`, "a'b"],
    ['help $HOME', '$HOME'], ['help ~', '~'], ['help #x', '#x'], ['help "unbalanced', 'unbalanced'], ['help trailing\\', 'trailing']];
  for (const [line, word] of cases) {
    const res = await security(`${line}\n`);
    assert.equal(res.stderr, `security: help: no such command: ${word}\nhelp: returned 1\n`, line);
    assert.equal(res.code, 1);
  }
  const res = await security('help "a b"c" d"\n');
  assert.ok(res.stderr.startsWith('security: help: no such command: a b\n'), 'a quoted part is a whole word');
  assert.equal((await security('help\r\n')).code, 0, 'a CR before the LF is dropped');
});

test('the security stand-in reads 4095 bytes at a time, matches by prefix, and exits with the last command’s status', async () => {
  // What env-secrets.md saw: the bytes after 4095 ran as another command.
  const res = await security(`help ${'a'.repeat(4090)}XYZ help add-generic-password\n`);
  assert.match(res.stderr, /security: unknown command "XYZ"\n$/);
  assert.equal(res.code, 1);
  // A lone leftover "a" runs add-generic-password (and fails for want of its options).
  const a = await security('a\n');
  assert.match(a.stderr, /^Usage: add-generic-password/m);
  assert.match(a.stderr, /add-generic-password: returned 2\n$/);
  assert.equal((await security('hel\n')).code, 0);
  assert.equal((await security('nope\nhelp\n')).code, 0, 'fail, then succeed: 0');
  assert.equal((await security('help\nnope\n')).code, 1, 'succeed, then fail: 1');
  const other = await security('-q help\n');
  assert.equal(other.code, 1);
  assert.equal((await runProgram(SECURITY, ['help'], {})).code, 2, 'nothing but -i');
});

test('the security stand-in keeps items, and prints data that is not printable as hex', async (t) => {
  const home = tmpHome(t);
  const env = { FAKE_SECURITY_DB: path.join(home, 'db.json') };
  const hex = Buffer.from('café').toString('hex');
  assert.equal((await security(`add-generic-password -s S -a A -X ${hex}\n`, env)).code, 0);
  assert.equal((await security(`add-generic-password -s S -a A -X ${hex}\n`, env)).code, 1, 'no -U: it exists');
  assert.equal((await security('find-generic-password -s S -a A -w\n', env)).stdout, `${hex}\n`);
  assert.equal((await security('add-generic-password -U -s S -a A -w plain\n', env)).code, 0);
  assert.equal((await security('find-generic-password -s S -a A -w\n', env)).stdout, 'plain\n');
  assert.equal((await security('delete-generic-password -s S -a A\n', env)).code, 0);
  const gone = await security('find-generic-password -s S -a A -w\n', env);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /could not be found in the keychain\.\nfind-generic-password: returned 44\n$/);
});

test('securityLine quotes what is not plain, and refuses a line break', () => {
  assert.equal(securityLine(['find-generic-password', '-s', SERVICE, '-a', 'k0123456789ab/NAME', '-w']),
    'find-generic-password -s "Workbench key" -a k0123456789ab/NAME -w\n');
  assert.equal(securityLine(['help', 'a "b" \\c', '']), 'help "a \\"b\\" \\\\c" ""\n');
  assert.throws(() => securityLine(['help', 'a\nb']), /line break/);
});

// ------------------------------------------------------------------ the Secret Service (secret-tool stand-in)

test('keyring: values go on stdin, argv holds names only, and they come back', async (t) => {
  const home = tmpHome(t);
  const w = keyringStore(home);
  const { id } = await w.store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET } });
  const seen = w.seen();
  assert.deepEqual(seen.map(s => s.argv), [
    ['store', `--label=${SERVICE} ${id}/AWS_ACCESS_KEY_ID`, 'service', SERVICE, 'account', `${id}/AWS_ACCESS_KEY_ID`],
    ['store', `--label=${SERVICE} ${id}/AWS_SECRET_ACCESS_KEY`, 'service', SERVICE, 'account', `${id}/AWS_SECRET_ACCESS_KEY`]]);
  assert.deepEqual(seen.map(s => s.stdinBytes), [AWS_ID.length, AWS_SECRET.length], 'the value and no newline');
  assertNoValue(JSON.stringify(seen), [AWS_ID, AWS_SECRET], 'what secret-tool saw');
  assertNoValue(fs.readFileSync(path.join(home, '.workbench', 'keys.json'), 'utf8'), [AWS_ID, AWS_SECRET], 'keys.json');
  const fresh = keyringStore(home);
  assert.deepEqual(await fresh.store.load(), { keys: 1, missing: 0 });
  assert.deepEqual(fresh.store.envFor({ harness: 'codex' }), { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET });
  assert.deepEqual(await fresh.store.remove(id), { removed: true });
  assert.deepEqual(fresh.items(), []);
});

test('keyring: "auto" uses the Secret Service when one answers, and private files when none does', async (t) => {
  const home = tmpHome(t);
  const answers = keyringStore(home, { backend: 'auto' });
  await answers.store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  assert.equal((await answers.store.list())[0].kept, 'secret-tool');
  assert.deepEqual(answers.seen()[0].argv, ['lookup', 'service', SERVICE, 'account', 'probe'], 'it asked first');

  const noBus = keyringStore(tmpHome(t), { backend: 'auto', secretToolMode: 'no-bus' });
  await noBus.store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  assert.equal((await noBus.store.list())[0].kept, 'file');
  assert.ok(noBus.lines.some(l => /^info No keyring answered, so Workbench keeps keys in private files in /.test(l)));

  // No secret-tool on PATH at all (PATH holds an empty folder, and a relative one that is never searched).
  const empty = fs.mkdtempSync(path.join(home, 'bin-'));
  const missing = keyringStore(tmpHome(t), { backend: 'auto', secretToolBin: null, path: `${empty}${path.delimiter}relative/bin` });
  await missing.store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  assert.equal((await missing.store.list())[0].kept, 'file');
  assert.deepEqual(missing.seen(), []);
});

test('keyring: a locked keyring is a plain sentence, and a key keeps reading from where it was kept', async (t) => {
  const home = tmpHome(t);
  const locked = keyringStore(home, { secretToolMode: 'locked' });
  const err = await refused(locked.store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } }), 'store');
  assert.equal(err.message, 'Workbench could not save the key in your keyring, because your keyring is locked.');
  assertNoValue(errorText(err), [STRIPE], 'the error');
  // A key kept in the keyring is read from there even when new keys now go to files.
  const w = keyringStore(home);
  await w.store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  const later = keyringStore(home, { backend: 'file' });
  await later.store.load();
  assert.deepEqual(later.store.envFor({}), { STRIPE_SECRET_KEY: STRIPE });
});

// ------------------------------------------------------------------ private files

test('files: a 0600 file per key in a 0700 folder, read back, and removed', async (t) => {
  const home = tmpHome(t);
  const { store } = fileStore(home);
  const { id } = await store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'us-east-1' } });
  const dir = path.join(home, '.workbench', 'keys');
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, `${id}.json`)), 0o600);
  assert.deepEqual(fs.readdirSync(dir), [`${id}.json`], 'no temporary file left');
  const fresh = fileStore(home).store;
  await fresh.load();
  assert.deepEqual(fresh.envFor({}), { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'us-east-1' });
  await fresh.remove(id);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('files: a value file others could read, or a link, is not read', async (t) => {
  const home = tmpHome(t);
  const { store } = fileStore(home);
  const { id } = await store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  const file = path.join(home, '.workbench', 'keys', `${id}.json`);
  fs.chmodSync(file, 0o640);
  let fresh = fileStore(home);
  assert.deepEqual(await fresh.store.load(), { keys: 1, missing: 1 });
  assert.deepEqual(fresh.store.envFor({}), {});
  assert.match(fresh.lines[0], /because other people on this computer could read it, so agents will not get it\.$/);
  // A link to a private copy elsewhere is refused all the same.
  fs.chmodSync(file, 0o600);
  const elsewhere = path.join(home, 'elsewhere.json');
  fs.renameSync(file, elsewhere);
  fs.symlinkSync(elsewhere, file);
  fresh = fileStore(home);
  await fresh.store.load();
  assert.deepEqual(fresh.store.envFor({}), {});
  assert.match(fresh.lines[0], /because it is a link to another place/);
  // And a keys folder that is a link is not used for new keys.
  const other = tmpHome(t);
  fs.mkdirSync(path.join(other, '.workbench'), { mode: 0o700 });
  fs.mkdirSync(path.join(other, 'real-keys'), { mode: 0o700 });
  fs.symlinkSync(path.join(other, 'real-keys'), path.join(other, '.workbench', 'keys'));
  const err = await refused(fileStore(other).store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } }), 'store');
  assert.match(err.message, /because it is a link to another place\.$/);
});

test('files: the modes hold under a permissive umask, and nothing reaches stdout or stderr', (t) => {
  const home = tmpHome(t);
  const script = `
    import { KeyStore } from ${JSON.stringify(KEYS_MODULE)};
    process.umask(0);
    const log = { warn: (s) => console.error(s), info: (s) => console.log(s) };
    const store = new KeyStore({ home: ${JSON.stringify(home)}, platform: 'linux', backend: 'file', log });
    const { id } = await store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: process.env.THE_VALUE } });
    // A second key whose file others can read, so loading has something to say on stderr.
    const other = await store.add({ preset: 'anthropic', values: { ANTHROPIC_API_KEY: process.env.THE_OTHER } });
    (await import('node:fs')).chmodSync(${JSON.stringify(path.join(home, '.workbench', 'keys'))} + '/' + other.id + '.json', 0o644);
    await new KeyStore({ home: ${JSON.stringify(home)}, platform: 'linux', backend: 'file', log }).load();
    console.log(JSON.stringify({ id }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, THE_VALUE: STRIPE, THE_OTHER: API_KEY }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { id } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.match(run.stderr, /could not read ANTHROPIC_API_KEY .* because other people on this computer could read it/);
  assertNoValue(run.stdout, [STRIPE, API_KEY], 'stdout');
  assertNoValue(run.stderr, [STRIPE, API_KEY], 'stderr');
  assert.equal(mode(path.join(home, '.workbench')), 0o700);
  assert.equal(mode(path.join(home, '.workbench', 'keys')), 0o700);
  assert.equal(mode(path.join(home, '.workbench', 'keys', `${id}.json`)), 0o600);
  assert.equal(mode(path.join(home, '.workbench', 'keys.json')), 0o600);
});

// ------------------------------------------------------------------ keys.json

test('keys.json: 0600 in a 0700 ~/.workbench (made private if it was not), never a value, written whole', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, '.workbench', 'worktrees'), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.join(home, '.workbench'), 0o755);
  const { store } = fileStore(home);
  await store.add({ preset: 'google-cloud', values: { GOOGLE_CLOUD_PROJECT: 'my-project-123456', GOOGLE_API_KEY: API_KEY } });
  const file = path.join(home, '.workbench', 'keys.json');
  assert.equal(mode(path.join(home, '.workbench')), 0o700);
  assert.equal(mode(file), 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assertNoValue(text, [API_KEY, 'my-project-123456'], 'keys.json (a value that is not secret is not there either)');
  const data = JSON.parse(text);
  assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.keys[0]).sort(), ['agents', 'created', 'id', 'kept', 'label', 'preset', 'scope', 'vars']);
  assert.deepEqual(data.keys[0].vars, [{ name: 'GOOGLE_CLOUD_PROJECT', secret: false }, { name: 'GOOGLE_API_KEY', secret: true }]);
  assert.deepEqual(fs.readdirSync(path.join(home, '.workbench')).sort(), ['keys', 'keys.json', 'worktrees'], 'no temporary file left');
});

test('keys.json: a damaged file is set aside, and entries that cannot be trusted are left out', async (t) => {
  const home = tmpHome(t);
  const file = path.join(home, '.workbench', 'keys.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const w = fileStore(home);
  assert.deepEqual(await w.store.list(), []);
  assert.ok(fs.existsSync(`${file}.damaged`));
  assert.match(w.lines[0], /was damaged, so it was set aside as keys\.json\.damaged/);

  const good = { id: 'k0123456789ab', preset: 'custom', label: 'Fine', vars: [{ name: 'SOME_KEY', secret: true }], scope: { kind: 'all' }, agents: 'all', kept: 'file', created: 1 };
  const bad = [
    { ...good, id: 'k0000000000aa', vars: [{ name: 'PATH' }] },
    { ...good, id: '../../etc/passwd' },
    { ...good, id: 'k0000000000ab', scope: { kind: 'repo' } },
    { ...good, id: 'k0000000000ac', scope: { kind: 'somewhere' } },
    { ...good, id: 'k0000000000ad', agents: 'claude' },
    { ...good, id: 'k0000000000ae', kept: 'cloud' },
    { ...good, id: 'k0000000000af', vars: [{ name: 'A B' }] },
    { ...good }, // a second entry with the same id
  ];
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys: [good, ...bad, { ...good, id: 'k0000000000b0', label: 'x\ny', vars: [{ name: 'OTHER' }] }] }));
  const again = fileStore(home);
  const list = await again.store.list();
  assert.deepEqual(list.map(k => [k.id, k.label, k.vars.map(v => [v.name, v.secret])]),
    [['k0123456789ab', 'Fine', [['SOME_KEY', true]]], ['k0000000000b0', 'Other', [['OTHER', true]]]]);
  assert.ok(again.lines.some(l => /left out 8 damaged entries/.test(l)));
});

test('keys.json: two Workbenches on one home keep each other’s keys', async (t) => {
  const home = tmpHome(t);
  const a = fileStore(home).store;
  const b = fileStore(home).store;
  await a.load();
  await b.load();
  const ka = await a.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  const kb = await b.add({ preset: 'anthropic', values: { ANTHROPIC_API_KEY: API_KEY } });
  assert.deepEqual((await a.list()).map(k => k.id), [ka.id, kb.id], 'b kept a’s key, and a now sees b’s');
  assert.deepEqual(a.envFor({ harness: 'claude' }), { STRIPE_SECRET_KEY: STRIPE, ANTHROPIC_API_KEY: API_KEY });
  await b.remove(ka.id);
  assert.deepEqual((await a.list()).map(k => k.id), [kb.id]);
  assert.deepEqual(a.envFor({ harness: 'claude' }), { ANTHROPIC_API_KEY: API_KEY });
  assert.ok(a.values().includes(STRIPE), 'still masked here');
});

// ------------------------------------------------------------------ envFor and values

test('envFor: this repository’s keys and every repository’s, for this agent; the most specific wins, then the later', async (t) => {
  const home = tmpHome(t);
  const repo = path.join(home, 'shop');
  const other = path.join(home, 'blog');
  fs.mkdirSync(repo);
  fs.mkdirSync(other);
  fs.symlinkSync(repo, path.join(home, 'shop-link'));
  const { store } = fileStore(home);
  const add = (values, o = {}) => store.add({ preset: 'custom', label: 'K', values, secretNames: [], ...o });
  await add({ WHO: 'all-repos-all-agents', ONLY_ALL: 'yes' });
  await add({ WHO: 'this-repo-all-agents' }, { scope: { kind: 'repo', root: path.join(home, 'shop-link') } });
  await add({ WHO: 'all-repos-codex' }, { agents: ['codex'] });
  await add({ WHO: 'this-repo-claude', CLAUDE_ONLY: 'c' }, { scope: { kind: 'repo', root: repo }, agents: ['claude'] });
  await add({ WHO: 'later-all-repos-all-agents' });
  await add({ NOBODY_GETS_IT: 'nobody' }, { agents: [] });
  assert.deepEqual(store.envFor({ repoRoot: repo, harness: 'claude' }), { WHO: 'this-repo-claude', ONLY_ALL: 'yes', CLAUDE_ONLY: 'c' });
  assert.deepEqual(store.envFor({ repoRoot: path.join(home, 'shop-link'), harness: 'codex' }), { WHO: 'this-repo-all-agents', ONLY_ALL: 'yes' });
  assert.deepEqual(store.envFor({ repoRoot: other, harness: 'codex' }), { WHO: 'all-repos-codex', ONLY_ALL: 'yes' });
  assert.deepEqual(store.envFor({ repoRoot: other, harness: 'gemini' }), { WHO: 'later-all-repos-all-agents', ONLY_ALL: 'yes' });
  assert.deepEqual(store.envFor({}), { WHO: 'later-all-repos-all-agents', ONLY_ALL: 'yes' }, 'no repository, no agent: only keys for all');
  for (const odd of [undefined, null, { repoRoot: 42 }, { harness: {} }, { repoRoot: '' }, { repoRoot: path.join(home, 'gone') }]) {
    assert.doesNotThrow(() => store.envFor(odd));
  }
  const env = store.envFor({ repoRoot: repo, harness: 'claude' });
  env.WHO = 'changed';
  assert.equal(store.envFor({ repoRoot: repo, harness: 'claude' }).WHO, 'this-repo-claude', 'a fresh object every time');
});

test('values(): the secret values only, the same frozen list until something changes', async (t) => {
  const { store } = fileStore(tmpHome(t));
  await store.add({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'ap-southeast-2' } });
  const v1 = store.values();
  assert.deepEqual([...v1].sort(), [AWS_ID, AWS_SECRET].sort());
  assert.ok(Object.isFrozen(v1));
  assert.equal(store.values(), v1);
  await store.add({ preset: 'stripe', values: { STRIPE_SECRET_KEY: STRIPE } });
  assert.notEqual(store.values(), v1);
  assert.ok(store.values().includes(STRIPE));
  assert.equal(maskSecrets(`the region is ap-southeast-2 and the key ${STRIPE}`, store.values()), `the region is ap-southeast-2 and the key •••• ${STRIPE.slice(-4)}`);
});

test('a store refuses a place to keep keys it does not know', () => {
  assert.throws(() => new KeyStore({ backend: 'cloud' }), TypeError);
});
