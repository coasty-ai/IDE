// The connect service (src/core/connect.mjs): agents, keys, git and GitHub, as the Agents & keys panel sees them.
//
// The key store is an in-memory stand-in with the interface of src/core/keys.mjs, or the real one keeping its values in
// private files in a temporary home folder (never the keychain). Claude Code and Codex are the
// stand-ins in test/helpers (or small shell scripts written here), reached through the real adapters; HOME is a
// temporary folder, so no Claude Code extension on this machine is ever found. GitHub is a `fetchJson` of these tests,
// and git's credential store and global config are stand-ins or files here. Nothing reaches a network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connect, claudeSignIn } from '../src/core/connect.mjs';
import { KeyStore } from '../src/core/keys.mjs';
import * as claudeAdapter from '../src/adapters/claude/runner.mjs';
import * as codexAdapter from '../src/adapters/codex/runner.mjs';
import * as workspace from '../src/core/workspace.mjs';

const CLAUDE_FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const CODEX_FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url));
const SECURITY_FAKE = fileURLToPath(new URL('./helpers/security-fake.mjs', import.meta.url));
const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

// Key-shaped values, built from parts so that no secret scanner takes this file for a leak.
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'NOTREAL', 'workbench', 'test', 'key', '0123456789abcdef'].join('-');
const ANTHROPIC_KEY_2 = ['sk', 'ant', 'api03', 'NOTREAL', 'second', 'key', 'fedcba9876543210'].join('-');
const OPENAI_KEY = ['sk', 'proj', 'NOTREAL', 'workbench', 'test', 'key', '0123456789abcdef'].join('-');
const GH_TOKEN = ['github', 'pat', 'NOTREAL', 'workbench', 'test', '0123456789abcdefghij'].join('_');
const GH_TOKEN_2 = ['github', 'pat', 'NOTREAL', 'second', 'token', 'abcdefghij0123456789'].join('_');
const AWS_ID = ['AKIA', 'NOTREAL', 'TEST', '7QXA'].join('');
const AWS_SECRET = ['notreal', 'workbench', 'aws', 'secret', '9f2b'].join('/');
const SECRETS = [ANTHROPIC_KEY, ANTHROPIC_KEY_2, OPENAI_KEY, GH_TOKEN, GH_TOKEN_2, AWS_ID, AWS_SECRET];
const EMAIL = ['someone', 'example.org'].join('@');

/** Presets in the shape of src/shared/keypresets.mjs, as the spec gives them (only those these tests use). */
const PRESETS = [
  { id: 'anthropic', label: 'Anthropic', fields: [{ name: 'ANTHROPIC_API_KEY', label: 'API key', secret: true }], agents: ['claude'], note: null, link: null },
  { id: 'openai', label: 'OpenAI', fields: [{ name: 'OPENAI_API_KEY', label: 'API key', secret: true, also: ['CODEX_API_KEY'] }], agents: ['codex'], note: null, link: null },
  {
    id: 'aws', label: 'AWS', agents: 'all', note: null, link: null,
    fields: [
      { name: 'AWS_ACCESS_KEY_ID', label: 'Access key ID', secret: true },
      { name: 'AWS_SECRET_ACCESS_KEY', label: 'Secret access key', secret: true },
      { name: 'AWS_SESSION_TOKEN', label: 'Session token', secret: true, optional: true },
      { name: 'AWS_REGION', label: 'Region', secret: false, optional: true },
    ],
  },
  { id: 'github', label: 'GitHub', fields: [{ name: 'GH_TOKEN', label: 'Token', secret: true, also: ['GITHUB_TOKEN'] }], agents: 'all', note: null, link: null },
  { id: 'custom', label: 'Something else', fields: [], agents: 'all', note: null, link: null },
];

let T;
const savedEnv = { ...process.env };

before(() => {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-connect-')));
  for (const dir of ['home', 'xdg', 'tmp', 'repo', 'other-repo']) fs.mkdirSync(path.join(T, dir));
  fs.chmodSync(CLAUDE_FAKE, 0o755);
  Object.assign(process.env, {
    HOME: path.join(T, 'home'), XDG_CONFIG_HOME: path.join(T, 'xdg'), TMPDIR: path.join(T, 'tmp'),
    WORKBENCH_CLAUDE_BIN: CLAUDE_FAKE, WORKBENCH_CODEX_BIN: CODEX_FAKE, FAKE_CLAUDE_VERSION: '2.1.322',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(T, 'gitconfig'),
  });
  fs.writeFileSync(path.join(T, 'gitconfig'), '');
  for (const k of ['FAKE_CLAUDE_AUTH', 'FAKE_CODEX_LOGIN', 'CLAUDECODE', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY',
    'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
});

after(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(T, { recursive: true, force: true });
});

/** Set variables in process.env for one test (undefined takes one away); put back afterwards. */
function setEnv(t, vars) {
  const was = {};
  for (const [k, v] of Object.entries(vars)) {
    was[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(was)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A temporary folder for one test. */
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(T, 'case-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A shell-script program in `dir`, executable. */
function program(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

const shown = (v) => (v.length >= 12 ? `•••• ${v.slice(-4)}` : '••••');

/** An in-memory key store with the interface of src/core/keys.mjs. Values never leave it except through envFor and values. */
class FakeKeys {
  constructor() {
    this.items = [];
    this.adds = [];
    this.n = 0;
  }

  async list() {
    return this.items.map((k) => ({
      id: k.id, preset: k.preset, label: k.label, scope: k.scope, agents: k.agents, created: k.created,
      vars: Object.keys(k.values).map((name) => ({ name, shown: k.secretNames.includes(name) ? shown(k.values[name]) : k.values[name] })),
    }));
  }

  async add({ preset, label, values, secretNames, scope, agents }) {
    for (const [name, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw Object.assign(new Error('That name cannot be used.'), { plain: true, why: 'name' });
      if (typeof value !== 'string' || !value || value.length > 2000 || /[\r\n\u0000]/.test(value)) {
        throw Object.assign(new Error('A value must be 1 to 2000 characters on one line.'), { plain: true, why: 'value' });
      }
    }
    this.adds.push({ preset, label, names: Object.keys(values), secretNames: [...secretNames], scope, agents });
    const id = `key-${++this.n}`;
    this.items.push({ id, preset, label, values: { ...values }, secretNames: [...secretNames], scope, agents, created: 1763000000000 + this.n });
    return { id };
  }

  async remove(id) {
    const i = this.items.findIndex((k) => k.id === id);
    if (i < 0) return { removed: false };
    this.items.splice(i, 1);
    return { removed: true };
  }

  async load() {}

  envFor({ repoRoot, harness }) {
    const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const out = {};
    for (const k of this.items) {
      const scopeOk = k.scope.kind === 'all' || (!!repoRoot && real(k.scope.root) === real(repoRoot));
      const agentsOk = k.agents === 'all' || (Array.isArray(k.agents) && k.agents.includes(harness));
      if (scopeOk && agentsOk) Object.assign(out, k.values);
    }
    return out;
  }

  values() {
    return this.items.flatMap((k) => k.secretNames.map((n) => k.values[n]));
  }

  valuesOf(id) {
    const k = this.items.find((x) => x.id === id);
    return k ? { ...k.values } : null;
  }
}

/** A stand-in for workspace.mjs's git functions, recording each call (the token as TOKEN). */
function fakeWorkspace({ helper = true, approveFails = false, rejectFails = false, fill = null } = {}) {
  const calls = [];
  let identity = { name: '', email: '' };
  return {
    calls,
    async gitConfigIdentity() { return { ...identity }; },
    async setGitIdentity({ name, email }) {
      calls.push(['setGitIdentity', name, email]);
      if (!String(email).includes('@')) throw Object.assign(new Error('That does not look like an email address.'), { plain: true, why: 'email' });
      identity = { name, email };
      return { name, email };
    },
    async gitIdentity() { return null; },
    async approveGitCredential({ host, username, password }) {
      calls.push(['approve', host, username, password === GH_TOKEN ? 'GH_TOKEN' : password === GH_TOKEN_2 ? 'GH_TOKEN_2' : 'something else']);
      if (approveFails) throw Object.assign(new Error('Git could not keep your GitHub sign-in.'), { plain: true, why: 'git', detail: 'fatal: no' });
      return { helper };
    },
    async rejectGitCredential({ host, username }) {
      calls.push(['reject', host, username]);
      if (typeof rejectFails === 'function' ? rejectFails() : rejectFails) {
        throw Object.assign(new Error('Git could not forget your GitHub sign-in.'), { plain: true, why: 'git', detail: 'fatal: no' });
      }
      return { ok: true };
    },
    async fillGitCredential({ host, username }) {
      calls.push(['fill', host, username]);
      return typeof fill === 'function' ? fill({ host, username }) : fill;
    },
  };
}

/** GitHub as a function of these tests: `answer(url, headers)` gives `{ status, json }`, or an Error to throw. */
function fakeGithub(answer) {
  const calls = [];
  const fetchJson = async (url, { headers } = {}) => {
    calls.push({ url, auth: headers && headers.Authorization === `Bearer ${GH_TOKEN}` ? 'GH_TOKEN' : headers && headers.Authorization === `Bearer ${GH_TOKEN_2}` ? 'GH_TOKEN_2' : 'other', headers });
    const r = answer(url, headers || {});
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, fetchJson };
}

const githubUser = (login = 'octo-cat') => (url, headers) => {
  if (url !== 'https://api.github.com/user') return { status: 404, json: null };
  const auth = headers.Authorization;
  if (auth === `Bearer ${GH_TOKEN}`) return { status: 200, json: { login, id: 1, email: EMAIL } };
  if (auth === `Bearer ${GH_TOKEN_2}`) return { status: 200, json: { login: 'other-cat', id: 2 } };
  return { status: 401, json: { message: 'Bad credentials' } };
};

/** A Connect for one test, with everything it says recorded. */
function makeConnect(t, o = {}) {
  const logs = [];
  const events = [];
  const terminals = [];
  const keys = o.keys || new FakeKeys();
  const ws = o.workspace || fakeWorkspace();
  const gh = o.github || fakeGithub(githubUser());
  const c = new Connect({
    home: o.home || process.env.HOME,
    platform: o.platform || 'darwin',
    env: process.env,
    keys,
    workspace: ws,
    adapters: o.adapters || ADAPTERS,
    flags: o.flags || { claude: null },
    settingsPath: o.settingsPath,
    repoRoot: o.repoRoot,
    openTerminal: o.openTerminal || (async (what) => { terminals.push(what); return { opened: true }; }),
    fetchJson: gh.fetchJson,
    log: Object.assign((line) => logs.push(line), { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), debug: (l) => logs.push(l) }),
    presets: PRESETS,
    probeTimeoutMs: o.probeTimeoutMs || 10_000,
    probe: o.probe === true, // the tests probe when they mean to; one test checks the probe a new Connect starts
  });
  c.on('agents', (map) => events.push(['agents', JSON.parse(JSON.stringify(map))]));
  c.on('changed', () => events.push(['changed']));
  const settingsFile = o.settingsPath || path.join(o.home || process.env.HOME, '.workbench', 'settings.json');
  t.after(() => {
    // Nothing a person or a log could see ever holds a secret.
    const seen = JSON.stringify({ logs, events, settings: fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '' });
    for (const s of SECRETS) assert.ok(!seen.includes(s), `a secret reached a log, an event or settings.json: ${s.slice(0, 6)}…`);
    assert.ok(!seen.includes(EMAIL), 'an email address from a sign-in check reached a log or an event');
    fs.rmSync(path.join(process.env.HOME, '.workbench'), { recursive: true, force: true });
  });
  return { c, logs, events, terminals, keys, workspace: ws, github: gh };
}

const byId = (status, id) => status.agents.find((a) => a.id === id);

// ------------------------------------------------------------------ agents

test('a Claude Code that is signed in and a Codex that is signed in are both ready', async (t) => {
  const { c, events } = makeConnect(t);
  const s = await c.status({ repoRoot: path.join(T, 'repo') });
  assert.deepEqual(byId(s, 'claude'), {
    id: 'claude', name: 'Claude Code', found: true, version: '2.1.322', from: 'WORKBENCH_CLAUDE_BIN', signedIn: 'yes',
    how: 'your Claude subscription', ready: true, isDefault: true,
    sentence: 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.', actions: ['key', 'recheck'],
  });
  assert.deepEqual(byId(s, 'codex'), {
    id: 'codex', name: 'Codex', found: true, version: '0.166.0', from: 'WORKBENCH_CODEX_BIN', signedIn: 'yes',
    how: 'your ChatGPT account', ready: true, isDefault: false,
    sentence: 'Codex 0.166.0 is ready, signed in with your ChatGPT account.', actions: ['key', 'default', 'recheck'],
  });
  assert.equal(s.defaultAgent, 'claude');
  assert.equal(s.ready, true);
  assert.equal(s.platform, 'darwin');
  assert.equal(s.canOpenTerminal, true);
  // 'agents' carries what the adapters' available() said, with the sign-in, and ok meaning ready.
  const [, map] = events.find((e) => e[0] === 'agents');
  assert.equal(map.claude.ok, true);
  assert.equal(map.claude.ready, true);
  assert.equal(map.claude.signedIn, 'yes');
  assert.equal(map.claude.version, '2.1.322');
  assert.equal(map.claude.path, CLAUDE_FAKE);
  assert.equal(map.claude.from, 'env');
  assert.equal(map.claude.reason, undefined);
  assert.equal(map.codex.ok, true);
  assert.equal(map.codex.how, 'your ChatGPT account');
  assert.ok(events.some((e) => e[0] === 'changed'));
});

test('claudeSignIn reads the JSON in Claude Code’s own order: a cloud provider, an API key, then the subscription', () => {
  const cases = [
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, { signedIn: 'yes', how: 'your Claude subscription' }],
    [{ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }, { signedIn: 'yes', how: 'your Claude subscription' }],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }, { signedIn: 'yes', how: 'an API key' }],
    [{ loggedIn: false, authMethod: 'api_key', apiProvider: 'firstParty' }, { signedIn: 'yes', how: 'an API key' }],
    [{ loggedIn: false, authMethod: 'api_key_helper' }, { signedIn: 'yes', how: 'an API key' }],
    [{ loggedIn: false, apiProvider: 'bedrock' }, { signedIn: 'yes', how: 'a cloud provider' }],
    [{ loggedIn: true, apiProvider: 'vertex', apiKeySource: 'ANTHROPIC_API_KEY' }, { signedIn: 'yes', how: 'a cloud provider' }],
    [{ loggedIn: false, authMethod: 'third_party' }, { signedIn: 'yes', how: 'a cloud provider' }],
    [{ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', apiKeySource: 'none' }, { signedIn: 'no', how: null }],
    [{ loggedIn: false }, { signedIn: 'no', how: null }],
    [{}, { signedIn: 'unknown', how: null }],
    [{ loggedIn: 'yes' }, { signedIn: 'unknown', how: null }],
    [null, { signedIn: 'unknown', how: null }],
    [[], { signedIn: 'unknown', how: null }],
  ];
  for (const [json, want] of cases) assert.deepEqual(claudeSignIn(json), want, JSON.stringify(json));
});

test('Claude Code signed out, on an API key, on a cloud provider, or giving an answer Workbench cannot read', async (t) => {
  const cases = [
    ['{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', 'no', null, false,
      'Claude Code 2.1.322 is installed but not signed in.', ['signin', 'key', 'recheck']],
    ['{"loggedIn":false,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}', 'yes', 'an API key', true,
      'Claude Code 2.1.322 is ready, signed in with an API key.', ['key', 'recheck']],
    ['{"loggedIn":false,"authMethod":"third_party","apiProvider":"bedrock"}', 'yes', 'a cloud provider', true,
      'Claude Code 2.1.322 is ready, signed in with a cloud provider.', ['key', 'recheck']],
    [`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"${EMAIL}","orgName":"Example Org Name","orgId":"org-123","subscriptionType":"max"}`,
      'yes', 'your Claude subscription', true, 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.', ['key', 'recheck']],
    ['this is not JSON', 'unknown', null, true,
      'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.', ['signin', 'key', 'recheck']],
    ['{"something":"else"}', 'unknown', null, true,
      'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.', ['signin', 'key', 'recheck']],
  ];
  for (const [auth, signedIn, how, ready, sentence, actions] of cases) {
    process.env.FAKE_CLAUDE_AUTH = auth;
    try {
      const { c } = makeConnect(t);
      const s = await c.status();
      const a = byId(s, 'claude');
      assert.equal(a.signedIn, signedIn, auth);
      assert.equal(a.how, how, auth);
      assert.equal(a.ready, ready, auth);
      assert.equal(a.sentence, sentence, auth);
      assert.deepEqual(a.actions, actions, auth);
      assert.ok(!JSON.stringify(s).includes(EMAIL) && !JSON.stringify(s).includes('Example Org Name'), 'no email or organisation in the status');
    } finally {
      delete process.env.FAKE_CLAUDE_AUTH;
    }
  }
});

test('a sign-in check that takes too long counts as unknown, and the agent can still be used', async (t) => {
  const bin = path.join(scratch(t), 'bin');
  const claude = program(bin, 'claude', 'case "$1" in\n  --version) echo "2.1.322 (Claude Code)" ;;\n  auth) exec sleep 30 ;;\nesac');
  setEnv(t, { WORKBENCH_CLAUDE_BIN: claude });
  const { c, logs } = makeConnect(t, { probeTimeoutMs: 400 });
  const started = Date.now();
  const s = await c.status();
  assert.ok(Date.now() - started < 8000);
  const a = byId(s, 'claude');
  assert.equal(a.signedIn, 'unknown');
  assert.equal(a.ready, true);
  assert.equal(a.sentence, 'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.');
  assert.ok(logs.some((l) => /took too long to say whether it is signed in/.test(l)));
});

test('the sign-in check runs with what an agent would get: the scrubbed environment and the keys for Claude Code', async (t) => {
  const bin = path.join(scratch(t), 'bin');
  program(bin, 'claude', [
    'case "$1" in',
    '  --version) echo "2.1.322 (Claude Code)"; exit 0 ;;',
    '  auth)',
    '    if [ -n "$CLAUDECODE" ]; then echo "a session marker reached the check"; exit 1; fi',
    '    if [ -n "$ANTHROPIC_API_KEY" ]; then echo \'{"loggedIn":false,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}\'; exit 1; fi',
    '    echo \'{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\'; exit 1 ;;',
    'esac',
  ].join('\n'));
  setEnv(t, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WORKBENCH_CLAUDE_BIN: undefined, CLAUDECODE: '1' });
  const { c, keys } = makeConnect(t);
  let a = byId(await c.status(), 'claude');
  assert.equal(a.signedIn, 'no');
  assert.equal(a.from, 'your PATH');
  // A key for Codex only, or for another repository, does not reach Claude Code's check.
  await keys.add({ preset: 'anthropic', label: 'Anthropic', values: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, secretNames: ['ANTHROPIC_API_KEY'], scope: { kind: 'all' }, agents: ['codex'] });
  await keys.add({ preset: 'anthropic', label: 'Anthropic', values: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, secretNames: ['ANTHROPIC_API_KEY'], scope: { kind: 'repo', root: path.join(T, 'other-repo') }, agents: 'all' });
  await c.recheck({ repoRoot: path.join(T, 'repo') });
  assert.equal(byId(await c.status(), 'claude').signedIn, 'no');
  // "Use an API key" does.
  const r = await c.setAgentKey('claude', `  ${ANTHROPIC_KEY}\n`);
  assert.deepEqual(r, { ok: true, sentence: 'Claude Code will use this API key from now on, and each request is billed to it.' });
  a = byId(await c.status(), 'claude');
  assert.equal(a.signedIn, 'yes');
  assert.equal(a.how, 'an API key');
  assert.equal(a.sentence, 'Claude Code 2.1.322 is ready, signed in with an API key.');
});

test('Codex signed out, then signed in with a key saved here; an API-key login reads as such', async (t) => {
  setEnv(t, { FAKE_CODEX_LOGIN: 'out' });
  const { c, keys } = makeConnect(t);
  let a = byId(await c.status(), 'codex');
  assert.equal(a.signedIn, 'no');
  assert.equal(a.ready, false);
  assert.equal(a.sentence, 'Codex 0.166.0 is installed but not signed in.');
  assert.deepEqual(a.actions, ['signin', 'key', 'recheck']);
  await c.setAgentKey('codex', OPENAI_KEY);
  assert.deepEqual(keys.adds.at(-1), {
    preset: 'openai', label: 'OpenAI', names: ['OPENAI_API_KEY', 'CODEX_API_KEY'], secretNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    scope: { kind: 'all' }, agents: ['codex'],
  });
  a = byId(await c.status(), 'codex');
  assert.equal(a.signedIn, 'yes');
  assert.equal(a.how, 'an API key');
  assert.equal(a.ready, true);
  process.env.FAKE_CODEX_LOGIN = 'apikey';
  await keys.remove(keys.items[0].id);
  await c.recheck();
  a = byId(await c.status(), 'codex');
  assert.equal(a.how, 'an API key');
  assert.equal(a.sentence, 'Codex 0.166.0 is ready, signed in with an API key.');
});

test('agents that are not installed: the panel offers to install them, and nothing is ready', async (t) => {
  const empty = path.join(scratch(t), 'bin');
  program(empty, 'node', 'exit 0'); // so no other node folder is added to this PATH
  setEnv(t, { PATH: empty, WORKBENCH_CLAUDE_BIN: undefined, WORKBENCH_CODEX_BIN: undefined });
  const { c, events } = makeConnect(t);
  const s = await c.status();
  for (const [id, sentence] of [['claude', 'Claude Code is not installed.'], ['codex', 'Codex is not installed.']]) {
    const a = byId(s, id);
    assert.equal(a.found, false);
    assert.equal(a.ready, false);
    assert.equal(a.from, null);
    assert.equal(a.sentence, sentence);
    assert.deepEqual(a.actions, ['install', 'recheck']);
  }
  assert.equal(s.ready, false);
  assert.equal(s.defaultAgent, null);
  assert.equal(c.defaultAgent(), null);
  const [, map] = events.find((e) => e[0] === 'agents');
  assert.deepEqual([map.claude.ok, map.claude.reason, map.codex.ok, map.codex.reason], [false, 'Claude Code is not installed.', false, 'Codex is not installed.']);
});

test('a program Workbench was pointed at that is not there, or that will not start, is said plainly', async (t) => {
  const dir = scratch(t);
  const broken = program(dir, 'claude', 'echo "boom: vendor words that must not be shown" >&2\nexit 3');
  setEnv(t, { WORKBENCH_CLAUDE_BIN: path.join(dir, 'nowhere', 'claude'), WORKBENCH_CODEX_BIN: path.join(dir, 'nowhere', 'codex') });
  const one = makeConnect(t);
  let s = await one.c.status();
  assert.equal(byId(s, 'claude').sentence, `Claude Code is not at ${path.join(dir, 'nowhere', 'claude')}, the path in WORKBENCH_CLAUDE_BIN.`);
  assert.equal(byId(s, 'codex').sentence, `Codex is not at ${path.join(dir, 'nowhere', 'codex')}, the path in WORKBENCH_CODEX_BIN.`);
  process.env.WORKBENCH_CLAUDE_BIN = broken;
  const two = makeConnect(t);
  s = await two.c.status();
  const a = byId(s, 'claude');
  assert.equal(a.found, true);
  assert.equal(a.ready, false);
  assert.equal(a.sentence, `Claude Code is at ${broken}, but it could not be started.`);
  assert.deepEqual(a.actions, ['install', 'recheck']);
  const [, map] = two.events.find((e) => e[0] === 'agents');
  assert.equal(map.claude.reason, a.sentence);
  assert.ok(!JSON.stringify([s, two.events]).includes('vendor words'));
});

test('a new Connect probes the agents by itself, so the default agent is known before anyone opens the panel', async (t) => {
  let n = 0;
  const claude = { available: async (o) => { n++; return claudeAdapter.available(o); } };
  const { c, events } = makeConnect(t, { probe: true, adapters: { claude, codex: codexAdapter } });
  assert.equal(c.defaultAgent(), undefined, 'nothing is known before the first probe ends: the engine uses its own check');
  // Listeners put on right after making it hear the first probe.
  await new Promise((resolve) => c.once('agents', resolve));
  assert.equal(c.defaultAgent(), 'claude');
  assert.ok(events.some((e) => e[0] === 'agents'));
  await c.status();
  assert.equal(n, 1, 'status() uses that probe');
  // status() called while the first probe runs waits for it, and does not start another.
  const second = makeConnect(t, { probe: true, adapters: { claude, codex: codexAdapter } });
  await second.c.status();
  assert.equal(n, 2);
  // A listener put on after the probe ended (the engine, wired late) hears the last map at once; a once listener once.
  const heard = [];
  c.on('agents', (map) => heard.push(['on', map.claude.ok, map.codex.ok]));
  c.once('agents', (map) => heard.push(['once', map.claude.ok]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard, [['on', true, true], ['once', true]]);
  await c.recheck();
  assert.deepEqual(heard.map((h) => h[0]), ['on', 'once', 'on']);
  assert.equal(n, 3);
});

test('a new Connect given the repository probes with the keys kept for it', async (t) => {
  const repo = path.join(T, 'repo');
  const keys = new FakeKeys();
  // The only sign-in is an OpenAI key kept for this repository, for Codex.
  await keys.add({ preset: 'openai', label: 'OpenAI', values: { OPENAI_API_KEY: OPENAI_KEY, CODEX_API_KEY: OPENAI_KEY },
    secretNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'], scope: { kind: 'repo', root: repo }, agents: ['codex'] });
  setEnv(t, { FAKE_CODEX_LOGIN: 'out' });
  const missing = { available: async () => ({ ok: false, reason: 'Claude Code is not installed.' }) };
  const adapters = { claude: missing, codex: codexAdapter };
  const { c } = makeConnect(t, { probe: true, repoRoot: repo, keys, adapters });
  assert.equal(c.defaultAgent(), undefined);
  await new Promise((resolve) => c.once('agents', resolve));
  assert.equal(c.defaultAgent(), 'codex', 'the first probe counted the key for this repository');
  const codex = byId(await c.status(), 'codex');
  assert.deepEqual([codex.signedIn, codex.how, codex.ready], ['yes', 'an API key', true]);
  // Without the repository, that key is not given, and no agent is ready.
  const elsewhere = makeConnect(t, { probe: true, keys, adapters });
  await new Promise((resolve) => elsewhere.c.once('agents', resolve));
  assert.equal(elsewhere.c.defaultAgent(), null);
});

test('recheck shares one probe among calls made while one runs, and each new key or removal probes again', async (t) => {
  let n = 0;
  const slow = { available: async () => { n++; await new Promise((r) => setTimeout(r, 60)); return { ok: false, reason: 'not here' }; } };
  const { c } = makeConnect(t, { adapters: { claude: slow, codex: slow } });
  await Promise.all([c.recheck(), c.recheck(), c.recheck(), c.recheck()]);
  assert.equal(n, 4, 'one probe running and one queued behind it, for two agents');
  await c.recheck();
  assert.equal(n, 6);
  await c.addKey({ preset: 'custom', label: 'Stripe', values: { STRIPE_SECRET_KEY: AWS_SECRET }, scope: 'all', agents: 'all' });
  assert.equal(n, 8);
});

// ------------------------------------------------------------------ the default agent

test('the default agent: the person’s choice when it is ready, else the first ready one, Claude Code first', async (t) => {
  const { c, events } = makeConnect(t);
  await c.recheck();
  assert.equal(c.defaultAgent(), 'claude');
  events.length = 0;
  assert.deepEqual(await c.setDefaultAgent('codex'), { ok: true, sentence: 'New work will go to Codex.' });
  assert.equal(c.defaultAgent(), 'codex');
  assert.ok(events.some((e) => e[0] === 'agents'), 'the engine hears of it');
  const file = path.join(process.env.HOME, '.workbench', 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { defaultAgent: 'codex' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let s = await c.status();
  assert.deepEqual([byId(s, 'claude').isDefault, byId(s, 'codex').isDefault, s.defaultAgent], [false, true, 'codex']);
  assert.deepEqual(byId(s, 'claude').actions, ['key', 'default', 'recheck']);
  // Another run reads the choice.
  const again = makeConnect(t);
  await again.c.recheck();
  assert.equal(again.c.defaultAgent(), 'codex');
  // When Codex is not ready, new work goes to the first ready agent.
  process.env.FAKE_CODEX_LOGIN = 'out';
  try {
    await c.recheck();
    assert.equal(c.defaultAgent(), 'claude');
    s = await c.status();
    assert.equal(s.defaultAgent, 'claude');
    assert.deepEqual(await c.setDefaultAgent('codex'), { ok: true, sentence: 'New work will go to Codex once it is ready.' });
  } finally {
    delete process.env.FAKE_CODEX_LOGIN;
  }
  await assert.rejects(c.setDefaultAgent('gemini'), { why: 'agent', status: 404, message: 'Workbench does not know that agent.' });
  await assert.rejects(c.setDefaultAgent('constructor'), { why: 'agent' });
  // Before the first probe, choosing tells the engine nothing about which agents can start.
  const early = makeConnect(t);
  await early.c.setDefaultAgent('codex');
  assert.deepEqual(early.events.map((e) => e[0]), ['changed']);
  assert.equal(early.c.defaultAgent(), undefined);
});

// ------------------------------------------------------------------ install and sign in

test('on macOS, Install and Sign in open Terminal with the vendor’s own installer or sign-in', async (t) => {
  const bin = path.join(scratch(t), 'bin');
  const claude = program(bin, 'claude', 'case "$1" in --version) echo "2.1.322 (Claude Code)" ;; auth) echo \'{"loggedIn":false}\' ;; esac');
  setEnv(t, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WORKBENCH_CLAUDE_BIN: undefined });
  const { c, terminals } = makeConnect(t, { platform: 'darwin' });
  assert.deepEqual(await c.agentAction('claude', 'install'), { ok: true, opened: true, sentence: 'Terminal is installing Claude Code. When it finishes, come back here.' });
  assert.deepEqual(terminals.at(-1), { title: 'Installing Claude Code', program: '/bin/sh', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] });
  await c.agentAction('codex', 'install');
  assert.deepEqual(terminals.at(-1), { title: 'Installing Codex', program: '/bin/sh', args: ['-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'] });
  // Terminal's shell has the person's own PATH: it gets the full path of the program Workbench found.
  assert.deepEqual(await c.agentAction('claude', 'signin'), { ok: true, opened: true, sentence: 'Terminal is open for you to sign in to Claude Code. When you are done, come back here.' });
  assert.deepEqual(terminals.at(-1), { title: 'Signing in to Claude Code', program: claude, args: ['auth', 'login'] });
  await c.agentAction('codex', 'signin');
  assert.deepEqual(terminals.at(-1), { title: 'Signing in to Codex', program: process.execPath, args: [CODEX_FAKE, 'login'] });
});

test('when Terminal cannot be opened, or elsewhere than macOS, the person gets the command to run', async (t) => {
  const bin = path.join(scratch(t), 'bin');
  program(bin, 'claude', 'case "$1" in --version) echo "2.1.322 (Claude Code)" ;; auth) echo \'{"loggedIn":false}\' ;; esac');
  setEnv(t, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, WORKBENCH_CLAUDE_BIN: undefined });
  const failing = makeConnect(t, { platform: 'darwin', openTerminal: async () => ({ opened: false }) });
  assert.deepEqual(await failing.c.agentAction('claude', 'signin'), {
    ok: true, opened: false, command: 'claude auth login', sentence: 'Workbench could not open Terminal. Run this command in a terminal, then check again.',
  });
  const throwing = makeConnect(t, { platform: 'darwin', openTerminal: async () => { throw new Error('no Terminal here'); } });
  assert.equal((await throwing.c.agentAction('claude', 'install')).command, 'curl -fsSL https://claude.ai/install.sh | bash');

  const linux = makeConnect(t, { platform: 'linux' });
  assert.deepEqual(await linux.c.agentAction('claude', 'install'), {
    ok: true, opened: false, command: 'curl -fsSL https://claude.ai/install.sh | bash', sentence: 'Run this command in a terminal to install Claude Code, then check again.',
  });
  assert.deepEqual(await linux.c.agentAction('claude', 'signin'), {
    ok: true, opened: false, command: 'claude auth login', sentence: 'Run this command in a terminal to sign in to Claude Code, then check again.',
  });
  assert.equal((await linux.c.agentAction('codex', 'install')).command, 'curl -fsSL https://chatgpt.com/codex/install.sh | sh');
  // A program found elsewhere is shown by its full path, quoted for the shell when it needs it.
  assert.equal((await linux.c.agentAction('codex', 'signin')).command, `${process.execPath.includes(' ') ? `'${process.execPath}'` : process.execPath} ${CODEX_FAKE.includes(' ') ? `'${CODEX_FAKE}'` : CODEX_FAKE} login`);
  assert.equal(linux.terminals.length, 0);
  const s = await linux.c.status();
  assert.equal(s.canOpenTerminal, false);
});

test('agent actions refuse unknown agents and actions, and signing in to an agent that is not installed', async (t) => {
  const empty = path.join(scratch(t), 'bin');
  program(empty, 'node', 'exit 0');
  setEnv(t, { PATH: empty, WORKBENCH_CLAUDE_BIN: undefined });
  const { c, terminals } = makeConnect(t);
  await assert.rejects(c.agentAction('gemini', 'install'), { plain: true, why: 'agent', status: 404 });
  await assert.rejects(c.agentAction('claude', 'uninstall'), { plain: true, why: 'action', status: 400 });
  await assert.rejects(c.agentAction('claude', 'signin'), { plain: true, why: 'not-installed', status: 409, message: 'Claude Code is not installed yet, so there is nothing to sign in to.' });
  await assert.rejects(c.setAgentKey('claude', '   '), { plain: true, why: 'value', message: 'Paste the key first.' });
  await assert.rejects(c.setAgentKey('codex', null), { why: 'value' });
  await assert.rejects(c.setAgentKey('__proto__', ANTHROPIC_KEY), { why: 'agent' });
  assert.equal(terminals.length, 0);
});

test('"Use an API key" replaces the key it saved before, and leaves other keys alone', async (t) => {
  const { c, keys } = makeConnect(t);
  await c.addKey({ preset: 'anthropic', values: { ANTHROPIC_API_KEY: ANTHROPIC_KEY_2 }, scope: 'all', agents: 'all' });
  await c.setAgentKey('claude', ANTHROPIC_KEY);
  await c.setAgentKey('claude', ANTHROPIC_KEY_2);
  const list = await keys.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((k) => [k.preset, k.agents]), [['anthropic', 'all'], ['anthropic', ['claude']]]);
  assert.equal(keys.envFor({ repoRoot: null, harness: 'claude' }).ANTHROPIC_API_KEY, ANTHROPIC_KEY_2);
  // A value the store refuses comes back as its plain error.
  await assert.rejects(c.setAgentKey('claude', `${ANTHROPIC_KEY}\nsecond line`), { plain: true, why: 'value' });
});

// ------------------------------------------------------------------ git

test('git: the name and email git has, saved with Save, and a repository’s own', async (t) => {
  const real = makeConnect(t, { workspace });
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  let s = await real.c.status();
  assert.deepEqual(s.git, { name: '', email: '', sentence: 'Git does not know your name and email yet.' });
  assert.deepEqual(await real.c.setGitIdentity({ name: 'Ada Lovelace', email: 'ada@example.org' }), { ok: true, sentence: 'Git will make your merges as Ada Lovelace, ada@example.org.' });
  s = await real.c.status();
  assert.deepEqual(s.git, { name: 'Ada Lovelace', email: 'ada@example.org', sentence: 'Git knows you as Ada Lovelace, ada@example.org.' });
  await assert.rejects(real.c.setGitIdentity({ name: 'Ada', email: 'not an address' }), { plain: true, why: 'email' });
  assert.ok(real.events.some((e) => e[0] === 'changed'));
  // No global name or email, but the repository has its own.
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Only A Name\n');
  const repo = path.join(scratch(t), 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  s = await real.c.status({ repoRoot: repo });
  assert.equal(s.git.sentence, 'Git knows your name but not your email yet.');
  execFileSync('git', ['config', 'user.name', 'Repo Name'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'repo@example.org'], { cwd: repo });
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  s = await real.c.status({ repoRoot: repo });
  assert.equal(s.git.sentence, 'This repository has its own name and email for git. Save yours here to use them everywhere.');
  // git that cannot be read is said plainly.
  const broken = makeConnect(t, { workspace: { ...fakeWorkspace(), gitConfigIdentity: async () => { throw Object.assign(new Error('Git could not read'), { plain: true, detail: 'fatal: bad config line 1' }); } } });
  assert.deepEqual((await broken.c.status()).git, { name: '', email: '', sentence: 'Workbench could not read git’s settings.' });
});

// ------------------------------------------------------------------ GitHub

test('connectGithub keeps a token GitHub accepts: for git, and for agents only when asked', async (t) => {
  const { c, keys, workspace: ws, github } = makeConnect(t);
  const r = await c.connectGithub(` ${GH_TOKEN}\n`);
  assert.deepEqual(r, { ok: true, login: 'octo-cat', sentence: 'Connected to GitHub as octo-cat.' });
  assert.deepEqual(github.calls.map((x) => [x.url, x.auth]), [['https://api.github.com/user', 'GH_TOKEN']]);
  assert.equal(github.calls[0].headers.Accept, 'application/vnd.github+json');
  assert.deepEqual(keys.adds.at(-1), {
    preset: 'github', label: 'GitHub', names: ['GH_TOKEN', 'GITHUB_TOKEN'], secretNames: ['GH_TOKEN', 'GITHUB_TOKEN'], scope: { kind: 'all' }, agents: [],
  });
  assert.deepEqual(ws.calls.filter((x) => x[0] === 'approve'), [['approve', 'github.com', 'octo-cat', 'GH_TOKEN']]);
  // No agent gets it, and the panel lists it under GitHub, not under keys.
  assert.equal(c.envFor({ repoRoot: null, harness: 'claude' }).GH_TOKEN, undefined);
  let s = await c.status();
  assert.deepEqual(s.github, { connected: true, login: 'octo-cat', agentsUseIt: false, sentence: 'Connected to GitHub as octo-cat.' });
  assert.deepEqual(s.keys, []);
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.workbench', 'settings.json'), 'utf8'));
  assert.deepEqual(settings, { github: { login: 'octo-cat', keyId: keys.items[0].id } });
  // Connecting again, letting agents use it, replaces the earlier key.
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  assert.equal(keys.items.length, 1);
  assert.equal(keys.items[0].agents, 'all');
  assert.equal(c.envFor({ repoRoot: null, harness: 'codex' }).GH_TOKEN, GH_TOKEN);
  assert.equal(c.envFor({ repoRoot: null, harness: 'claude' }).GITHUB_TOKEN, GH_TOKEN);
  s = await c.status();
  assert.equal(s.github.agentsUseIt, true);
  // Another account: git forgets the first one.
  const other = await c.connectGithub(GH_TOKEN_2);
  assert.equal(other.login, 'other-cat');
  assert.equal(keys.items.length, 1);
  assert.deepEqual(ws.calls.filter((x) => x[0] === 'reject'), [['reject', 'github.com', 'octo-cat']]);
});

test('connectGithub keeps nothing when GitHub refuses the token, or cannot be reached', async (t) => {
  const answers = [
    [{ status: 401, json: { message: 'Bad credentials' } }, 'token', 'GitHub did not accept that token. Check that you copied all of it, then try again.'],
    [{ status: 403, json: { message: 'API rate limit exceeded' } }, 'github', 'GitHub refused the request for now. Try again in a few minutes.'],
    [{ status: 200, json: { login: 'not a login\nhost=evil' } }, 'github', 'GitHub gave an answer Workbench did not expect, so the token was not kept.'],
    [{ status: 200, json: null }, 'github', 'GitHub gave an answer Workbench did not expect, so the token was not kept.'],
    [{ status: 500, json: null }, 'github', 'GitHub gave an answer Workbench did not expect, so the token was not kept.'],
    [Object.assign(new Error(`getaddrinfo ENOTFOUND api.github.com ${GH_TOKEN}`), { code: 'ENOTFOUND' }), 'network',
      'Workbench could not reach GitHub. Check the internet connection, then try again.'],
  ];
  for (const [answer, why, sentence] of answers) {
    const { c, keys, workspace: ws } = makeConnect(t, { github: fakeGithub(() => answer) });
    assert.deepEqual(await c.connectGithub(GH_TOKEN), { ok: false, why, sentence });
    assert.equal(keys.items.length, 0);
    assert.equal(ws.calls.length, 0);
    assert.equal(fs.existsSync(path.join(process.env.HOME, '.workbench', 'settings.json')), false);
    assert.equal((await c.status()).github.connected, false);
  }
  const { c, github } = makeConnect(t);
  for (const bad of ['', '   ', 'two words', `${GH_TOKEN}\u0000`, 'x'.repeat(256), null, 42]) {
    await assert.rejects(c.connectGithub(bad), { plain: true, why: 'value', message: 'That does not look like a GitHub token.' });
  }
  assert.equal(github.calls.length, 0);
});

test('connectGithub says when git could not keep the token', async (t) => {
  const none = makeConnect(t, { workspace: fakeWorkspace({ helper: false }) });
  assert.equal((await none.c.connectGithub(GH_TOKEN)).sentence,
    'Connected to GitHub as octo-cat. Git on this computer has nowhere to keep sign-ins, so it cannot use the token to clone private repositories.');
  const failing = makeConnect(t, { workspace: fakeWorkspace({ approveFails: true }) });
  const r = await failing.c.connectGithub(GH_TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.sentence, 'Connected to GitHub as octo-cat. Git could not keep the token, so cloning private repositories may not work.');
  assert.ok(failing.logs.some((l) => l.includes('git could not keep the GitHub sign-in')));
});

test('disconnecting GitHub removes the key and git’s sign-in; removing its key does the same', async (t) => {
  const { c, keys, workspace: ws } = makeConnect(t);
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  assert.deepEqual(await c.disconnectGithub(), { ok: true, sentence: 'GitHub is disconnected. The token itself still works until you delete it on GitHub.' });
  assert.equal(keys.items.length, 0);
  assert.deepEqual(ws.calls.filter((x) => x[0] === 'reject'), [['reject', 'github.com', 'octo-cat']]);
  assert.equal(c.envFor({ repoRoot: null, harness: 'claude' }).GH_TOKEN, undefined);
  let s = await c.status();
  assert.deepEqual(s.github, { connected: false, login: null, agentsUseIt: false, sentence: 'Not connected.' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.workbench', 'settings.json'), 'utf8')), {});
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual(await c.removeKey(keys.items[0].id), { removed: true });
  s = await c.status();
  assert.equal(s.github.connected, false);
  assert.equal(ws.calls.filter((x) => x[0] === 'reject').length, 2);
});

test('disconnecting GitHub while the keychain stays locked keeps the connection, and says agents still get the token', async (t) => {
  // The real key store on the `security` stand-in, as on a Mac.
  const home = scratch(t);
  const env = { ...process.env, FAKE_SECURITY_DB: path.join(home, 'fake-keychain.json'), FAKE_SECURITY_MODE: '' };
  const keys = new KeyStore({ home, platform: 'darwin', securityBin: SECURITY_FAKE, env });
  const { c, workspace: ws } = makeConnect(t, { home, keys });
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  const settingsFile = path.join(home, '.workbench', 'settings.json');
  const connected = { connected: true, login: 'octo-cat', agentsUseIt: true, sentence: 'Connected to GitHub as octo-cat.' };
  // The keychain is locked, and the person cancels the dialog that asks to unlock it (or there is no window).
  env.FAKE_SECURITY_MODE = 'canceled';
  assert.deepEqual(await c.disconnectGithub(), {
    ok: false, why: 'store',
    sentence: 'Workbench could not remove the key from your keychain, because your keychain was not unlocked. GitHub is still connected, and agents still get your GitHub token until it is removed. Try again.',
  });
  // Nothing says otherwise: the panel shows GitHub connected (with Disconnect, to try again), and agents do get it.
  assert.deepEqual((await c.status()).github, connected);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).github.login, 'octo-cat');
  assert.equal(c.envFor({ repoRoot: null, harness: 'claude' }).GH_TOKEN, GH_TOKEN);
  assert.deepEqual(ws.calls.filter((x) => x[0] === 'reject'), [['reject', 'github.com', 'octo-cat']], 'git was asked to forget it first');
  // Removing the connection's key says the same, and does not call it removed.
  const id = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).github.keyId;
  const r = await c.removeKey(id);
  assert.equal(r.removed, false);
  assert.equal(r.ok, false);
  assert.match(r.sentence, /^Workbench could not remove the key from your keychain, .* GitHub is still connected/);
  // Unlocked, Disconnect works.
  env.FAKE_SECURITY_MODE = '';
  assert.deepEqual(await c.disconnectGithub(), { ok: true, sentence: 'GitHub is disconnected. The token itself still works until you delete it on GitHub.' });
  assert.equal((await c.status()).github.connected, false);
  assert.deepEqual(c.envFor({ repoRoot: null, harness: 'claude' }), {});
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {});
});

test('disconnecting GitHub when git cannot forget the sign-in keeps the connection and its key, to try again', async (t) => {
  let gitFails = true;
  const { c, keys, workspace: ws } = makeConnect(t, { workspace: fakeWorkspace({ rejectFails: () => gitFails }) });
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual(await c.disconnectGithub(), {
    ok: false, why: 'git',
    sentence: 'Git could not forget your GitHub sign-in. GitHub is still connected, and Workbench still keeps your GitHub token. Try again.',
  });
  assert.equal(keys.items.length, 1, 'the key is kept');
  assert.deepEqual((await c.status()).github, { connected: true, login: 'octo-cat', agentsUseIt: false, sentence: 'Connected to GitHub as octo-cat.' });
  await c.setGithubAgentsUseIt(true);
  assert.equal((await c.disconnectGithub()).sentence,
    'Git could not forget your GitHub sign-in. GitHub is still connected, and agents still get your GitHub token until it is removed. Try again.');
  assert.equal(c.envFor({ repoRoot: null, harness: 'codex' }).GH_TOKEN, GH_TOKEN);
  gitFails = false;
  assert.equal((await c.disconnectGithub()).ok, true);
  assert.deepEqual(keys.items, []);
  assert.equal(ws.calls.filter((x) => x[0] === 'reject').length, 3);
});

test('connectGithub keeps nothing when settings.json cannot say which key is the connection’s', async (t) => {
  const dir = scratch(t);
  fs.writeFileSync(path.join(dir, 'not-a-folder'), '');
  const { c, keys, workspace: ws } = makeConnect(t, { settingsPath: path.join(dir, 'not-a-folder', 'settings.json') });
  await assert.rejects(c.connectGithub(GH_TOKEN, { agentsUseIt: true }), { plain: true, why: 'store', status: 500, message: 'Workbench could not save its settings.' });
  assert.deepEqual(keys.items, [], 'the key just kept went again, so no agent gets a token the panel would not show');
  assert.deepEqual(c.envFor({ repoRoot: null, harness: 'claude' }), {});
  assert.deepEqual(ws.calls, [], 'and git was not given it');
});

test('connectGithub says when the earlier connection’s key or git sign-in could not be removed', async (t) => {
  const { c, keys, workspace: ws } = makeConnect(t, { workspace: fakeWorkspace({ rejectFails: true }) });
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  const earlier = keys.items[0].id;
  const remove = keys.remove;
  keys.remove = async () => { throw Object.assign(new Error('Workbench could not remove the key from your keychain, because your keychain is locked.'), { plain: true, why: 'store' }); };
  const r = await c.connectGithub(GH_TOKEN_2, { agentsUseIt: false });
  assert.deepEqual(r, {
    ok: true, login: 'other-cat',
    sentence: 'Connected to GitHub as other-cat. Workbench could not remove the token it kept before, so agents still get it: it is listed under Keys for your agents, where you can remove it. Git could not forget your sign-in as octo-cat, so it may still use that account’s token.',
  });
  const s = await c.status();
  assert.deepEqual(s.github, { connected: true, login: 'other-cat', agentsUseIt: false, sentence: 'Connected to GitHub as other-cat.' });
  assert.deepEqual(s.keys.map((k) => [k.id, k.agents]), [[earlier, 'all']], 'the earlier key is listed, with Remove');
  assert.deepEqual(ws.calls.filter((x) => x[0] === 'reject'), [['reject', 'github.com', 'octo-cat']]);
  // An earlier key no agent got is still listed, so the person can remove it; the sentence says no more than that.
  keys.remove = remove;
  await c.removeKey(earlier);
  keys.remove = async () => { throw Object.assign(new Error('The key store refused.'), { plain: true, why: 'store' }); };
  const again = await c.connectGithub(GH_TOKEN_2);
  assert.equal(again.sentence, 'Connected to GitHub as other-cat. Workbench could not remove the token it kept before: it is listed under Keys for your agents, where you can remove it.');
});

test('connectGithub without agentsUseIt keeps the choice the connection has; a first connection is for git only', async (t) => {
  const { c, keys } = makeConnect(t);
  const agents = () => keys.items.map((k) => k.agents);
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual(agents(), [[]]);
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  assert.deepEqual(agents(), ['all']);
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual(agents(), ['all'], 'left out: agents still get it');
  await c.connectGithub(GH_TOKEN_2, {});
  assert.deepEqual(agents(), ['all'], 'also for another account');
  await c.connectGithub(GH_TOKEN, { agentsUseIt: false });
  assert.deepEqual(agents(), [[]]);
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual(agents(), [[]], 'left out: still git only');
  // A later run (another Connect on the same settings and store) keeps it too.
  await c.connectGithub(GH_TOKEN, { agentsUseIt: true });
  const later = makeConnect(t, { keys });
  await later.c.connectGithub(GH_TOKEN);
  assert.deepEqual(agents(), ['all']);
});

test('"Let agents use this token" changes without the token: it is read back from the key store, also in a later run', async (t) => {
  const { c, keys, workspace: ws } = makeConnect(t);
  await assert.rejects(c.setGithubAgentsUseIt(true), { plain: true, why: 'github', status: 409, message: 'GitHub is not connected.' });
  await c.connectGithub(GH_TOKEN);
  const first = keys.items[0].id;
  assert.deepEqual(await c.setGithubAgentsUseIt(true), { ok: true, sentence: 'Agents can use your GitHub token now, as GH_TOKEN.' });
  assert.equal(keys.items.length, 1);
  assert.notEqual(keys.items[0].id, first);
  assert.equal(keys.items[0].agents, 'all');
  assert.equal(c.envFor({ repoRoot: null, harness: 'codex' }).GH_TOKEN, GH_TOKEN);
  let s = await c.status();
  assert.deepEqual(s.github, { connected: true, login: 'octo-cat', agentsUseIt: true, sentence: 'Connected to GitHub as octo-cat.' });
  assert.deepEqual(s.keys, []);
  // The same choice again changes nothing.
  const same = keys.items[0].id;
  assert.equal((await c.setGithubAgentsUseIt(true)).ok, true);
  assert.equal(keys.items[0].id, same);
  // A later run (another Connect on the same store) changes it back with the token the store keeps.
  const later = makeConnect(t, { keys });
  assert.deepEqual(await later.c.setGithubAgentsUseIt(false), { ok: true, sentence: 'Agents no longer get your GitHub token. Git still uses it.' });
  assert.deepEqual(keys.items.map((k) => [k.preset, k.agents]), [['github', []]]);
  assert.equal(later.c.envFor({ repoRoot: null, harness: 'codex' }).GH_TOKEN, undefined);
  s = await later.c.status();
  assert.equal(s.github.agentsUseIt, false);
  assert.equal(s.github.connected, true);
  // Git's credential helper is never asked for it.
  assert.deepEqual([...ws.calls, ...later.workspace.calls].filter((x) => x[0] === 'fill'), []);
  // When the store could not read the token back (a locked keychain, a missing file), it says what to do instead, and
  // changes nothing.
  keys.valuesOf = () => ({});
  const blind = makeConnect(t, { keys });
  assert.deepEqual(await blind.c.setGithubAgentsUseIt(true), {
    ok: false, why: 'token', sentence: 'Workbench could not read the GitHub token it keeps, so this cannot change. Disconnect GitHub, then connect it again.',
  });
  assert.deepEqual(keys.items.map((k) => k.agents), [[]]);
});

test('githubRepos lists the person’s repositories with the token the key store keeps, also in a later run', async (t) => {
  const listing = [
    { full_name: 'octo-cat/app', clone_url: 'https://github.com/octo-cat/app.git', private: true, pushed_at: '2026-11-10T09:00:00Z' },
    { full_name: 'octo-cat/site', clone_url: 'https://github.com/octo-cat/site.git', private: false, pushed_at: '2026-11-01T09:00:00Z' },
    { full_name: 'evil/repo', clone_url: 'ext::sh -c touch% /tmp/pwned', private: false },
    { full_name: '../../etc', clone_url: 'https://github.com/../../etc.git' },
    null,
  ];
  const answer = (url, headers) => {
    if (url === 'https://api.github.com/user') return githubUser()(url, headers);
    if (url === 'https://api.github.com/user/repos?per_page=100&sort=pushed' && headers.Authorization === `Bearer ${GH_TOKEN}`) return { status: 200, json: listing };
    return { status: 401, json: null };
  };
  const want = [
    { fullName: 'octo-cat/app', cloneUrl: 'https://github.com/octo-cat/app.git', private: true, pushedAt: '2026-11-10T09:00:00Z' },
    { fullName: 'octo-cat/site', cloneUrl: 'https://github.com/octo-cat/site.git', private: false, pushedAt: '2026-11-01T09:00:00Z' },
  ];
  // Not connected: nothing, and GitHub is not asked.
  const first = makeConnect(t, { github: fakeGithub(answer) });
  assert.deepEqual(await first.c.githubRepos(), []);
  assert.equal(first.github.calls.length, 0);
  await first.c.connectGithub(GH_TOKEN);
  assert.deepEqual(await first.c.githubRepos(), want);
  assert.deepEqual(first.github.calls.at(-1).url, 'https://api.github.com/user/repos?per_page=100&sort=pushed');
  assert.equal(first.github.calls.at(-1).auth, 'GH_TOKEN');
  // A later run (the Mac app's --github-repos) has only what was stored: the token comes from the key store, also a
  // token for git only; git's credential helper is never asked.
  const later = makeConnect(t, { keys: first.keys, github: fakeGithub(answer) });
  assert.deepEqual(await later.c.githubRepos(), want);
  assert.equal(later.github.calls.at(-1).auth, 'GH_TOKEN');
  assert.deepEqual([...first.workspace.calls, ...later.workspace.calls].filter((x) => x[0] === 'fill'), []);
  // GitHub refuses, or cannot be reached: nothing.
  const refused = makeConnect(t, { keys: first.keys, github: fakeGithub(() => ({ status: 401, json: null })) });
  assert.deepEqual(await refused.c.githubRepos(), []);
  const offline = makeConnect(t, { keys: first.keys, github: fakeGithub(() => new Error('offline')) });
  assert.deepEqual(await offline.c.githubRepos(), []);
  // The store could not read the token: nothing, and GitHub is not asked.
  first.keys.valuesOf = () => null;
  const nothing = makeConnect(t, { keys: first.keys, github: fakeGithub(answer) });
  assert.deepEqual(await nothing.c.githubRepos(), []);
  assert.equal(nothing.github.calls.length, 0);
  assert.ok(nothing.logs.some((l) => l.includes('there is no GitHub token to list repositories with')));
});

test('a later run with a key store of its own (the Mac app’s --github-repos) reads the GitHub token from that store', async (t) => {
  const home = scratch(t);
  // The real key store, its values in private files in this home folder.
  const store = () => new KeyStore({ home, platform: 'linux', backend: 'file' });
  const listing = [{ full_name: 'octo-cat/app', clone_url: 'https://github.com/octo-cat/app.git', private: true, pushed_at: '2026-11-10T09:00:00Z' }];
  const answer = (url, headers) => {
    if (url === 'https://api.github.com/user') return githubUser()(url, headers);
    if (url === 'https://api.github.com/user/repos?per_page=100&sort=pushed' && headers.Authorization === `Bearer ${GH_TOKEN}`) return { status: 200, json: listing };
    return { status: 401, json: null };
  };
  const first = makeConnect(t, { home, keys: store(), github: fakeGithub(answer) });
  assert.equal((await first.c.connectGithub(GH_TOKEN)).ok, true);
  // Another Workbench, as the Mac app starts one for the list: its own key store, loaded from the same home folder.
  const keys = store();
  await keys.load();
  const later = makeConnect(t, { home, keys, github: fakeGithub(answer) });
  assert.deepEqual(await later.c.githubRepos(), [{ fullName: 'octo-cat/app', cloneUrl: 'https://github.com/octo-cat/app.git', private: true, pushedAt: '2026-11-10T09:00:00Z' }]);
  assert.equal(later.github.calls.at(-1).auth, 'GH_TOKEN');
  // It also gives the token to agents without asking for it again.
  assert.deepEqual(await later.c.setGithubAgentsUseIt(true), { ok: true, sentence: 'Agents can use your GitHub token now, as GH_TOKEN.' });
  assert.equal(later.c.envFor({ repoRoot: null, harness: 'claude' }).GH_TOKEN, GH_TOKEN);
  // A run whose store cannot read the value (its file has gone): no list, GitHub is not asked, and the panel says what
  // to do instead.
  fs.rmSync(path.join(home, '.workbench', 'keys'), { recursive: true, force: true });
  const unreadable = store();
  await unreadable.load();
  const blind = makeConnect(t, { home, keys: unreadable, github: fakeGithub(answer) });
  assert.equal((await blind.c.status()).github.connected, true);
  assert.deepEqual(await blind.c.githubRepos(), []);
  assert.equal(blind.github.calls.length, 0);
  assert.deepEqual(await blind.c.setGithubAgentsUseIt(false), {
    ok: false, why: 'token', sentence: 'Workbench could not read the GitHub token it keeps, so this cannot change. Disconnect GitHub, then connect it again.',
  });
  for (const run of [first, later, blind]) assert.deepEqual(run.workspace.calls.filter((x) => x[0] === 'fill'), []);
});

// ------------------------------------------------------------------ keys

test('addKey: the preset says which values are secret, also-names get the value, and keys can be for this repository', async (t) => {
  const repo = path.join(T, 'repo');
  const { c, keys } = makeConnect(t);
  await c.status({ repoRoot: repo });
  const { id } = await c.addKey({
    preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: '', AWS_REGION: 'eu-west-1' },
    scope: 'repo', agents: 'all',
  });
  assert.equal(typeof id, 'string');
  assert.deepEqual(keys.adds.at(-1), {
    preset: 'aws', label: 'AWS', names: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    secretNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], scope: { kind: 'repo', root: repo }, agents: 'all',
  });
  let s = await c.status({ repoRoot: repo });
  assert.equal(s.keys.length, 1);
  assert.equal(s.keys[0].sentence, `AWS for this repository, given to all agents: AWS_ACCESS_KEY_ID ${shown(AWS_ID)}, AWS_SECRET_ACCESS_KEY ${shown(AWS_SECRET)}, AWS_REGION eu-west-1`);
  assert.equal(s.keys[0].sentence, 'AWS for this repository, given to all agents: AWS_ACCESS_KEY_ID •••• 7QXA, AWS_SECRET_ACCESS_KEY •••• 9f2b, AWS_REGION eu-west-1');
  s = await c.status({ repoRoot: path.join(T, 'other-repo') });
  assert.match(s.keys[0].sentence, new RegExp(`^AWS for the repository at ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, given to all agents`));
  // OpenAI's key is also Codex's; a key for one agent says so.
  await c.addKey({ preset: 'openai', label: 'OpenAI for work', values: { OPENAI_API_KEY: OPENAI_KEY }, scope: 'all', agents: ['codex', 'claude'] });
  assert.deepEqual(keys.adds.at(-1).names, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  assert.deepEqual(keys.adds.at(-1).secretNames, ['OPENAI_API_KEY', 'CODEX_API_KEY']);
  s = await c.status({ repoRoot: repo });
  assert.equal(s.keys[1].sentence, `OpenAI for work for all repositories, given to Codex and Claude Code: OPENAI_API_KEY ${shown(OPENAI_KEY)}, CODEX_API_KEY ${shown(OPENAI_KEY)}`);
  // Something else: every value is secret.
  await c.addKey({ preset: 'custom', label: 'Stripe', values: { STRIPE_SECRET_KEY: AWS_SECRET, STRIPE_ACCOUNT: 'acct_123' }, scope: 'all', agents: [] });
  assert.deepEqual(keys.adds.at(-1).secretNames, ['STRIPE_SECRET_KEY', 'STRIPE_ACCOUNT']);
  assert.match((await c.status()).keys[2].sentence, /^Stripe for all repositories, given to no agent: STRIPE_SECRET_KEY •••• 9f2b, STRIPE_ACCOUNT ••••$/);
  // Refusals: a value missing from the preset, nothing at all, a scope it cannot place, and the store's own.
  await assert.rejects(c.addKey({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID }, scope: 'all' }), { plain: true, why: 'value', message: 'AWS_SECRET_ACCESS_KEY is needed.' });
  await assert.rejects(c.addKey({ preset: 'custom', values: { A: '  ' } }), { why: 'value', message: 'There is nothing to save.' });
  await assert.rejects(c.addKey({ preset: 'custom', values: 'A=b' }), { why: 'value' });
  await assert.rejects(c.addKey({ preset: 'custom', values: { A: 5 } }), { why: 'value' });
  await assert.rejects(c.addKey({ preset: 'custom', values: { A: 'b' }, scope: 'elsewhere' }), { why: 'scope' });
  const fresh = makeConnect(t);
  await assert.rejects(fresh.c.addKey({ preset: 'custom', values: { A: 'b' }, scope: 'repo' }), { why: 'scope' });
  // ... unless the key itself names the repository (the routes do), before the panel was ever asked about one.
  await fresh.c.addKey({ preset: 'custom', values: { A_B: 'b' }, scope: 'repo', repoRoot: repo });
  assert.deepEqual(fresh.keys.adds.at(-1).scope, { kind: 'repo', root: repo });
  assert.match((await fresh.c.status()).keys[0].sentence, / for this repository, given to all agents: A_B ••••$/);
  // A kind of key Workbench does not know is refused, as the key store refuses it; no preset given is a key of one's own.
  const before = keys.adds.length;
  await assert.rejects(c.addKey({ preset: 'nope', values: { A_B: AWS_SECRET } }), { plain: true, why: 'name', status: 400, message: 'Workbench does not know that kind of key.' });
  await assert.rejects(c.addKey({ preset: 7, values: { A_B: AWS_SECRET } }), { why: 'name', status: 400 });
  assert.equal(keys.adds.length, before);
  await c.addKey({ label: 'Mine', values: { A_B: AWS_SECRET } });
  assert.deepEqual((({ preset, secretNames }) => ({ preset, secretNames }))(keys.adds.at(-1)), { preset: 'custom', secretNames: ['A_B'] });
  await c.removeKey(keys.items.at(-1).id);
  await assert.rejects(c.addKey({ preset: 'custom', values: { 'BAD NAME': 'b' } }), { why: 'name' });
  // Removing passes through.
  assert.deepEqual(await c.removeKey(id), { removed: true });
  assert.deepEqual(await c.removeKey('no-such-key'), { removed: false });
  assert.equal((await c.status()).keys.length, 2);
});

test('status says whether a key kept for one repository is this one, by its real path, never by its folder’s name', async (t) => {
  // The same project cloned twice: both folders are called shop.
  const base = scratch(t);
  const here = path.join(base, 'Projects', 'shop');
  const there = path.join(base, 'Developer', 'shop');
  for (const d of [here, there]) fs.mkdirSync(d, { recursive: true });
  const link = path.join(base, 'shop-link');
  fs.symlinkSync(here, link);
  const { c, keys } = makeConnect(t);
  await c.addKey({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET }, scope: { kind: 'repo', root: there }, agents: 'all' });
  await c.addKey({ preset: 'custom', label: 'Mine', values: { MY_KEY: AWS_SECRET }, scope: { kind: 'repo', root: here } });
  await c.addKey({ preset: 'custom', label: 'Everywhere', values: { ANY_KEY: AWS_SECRET } });
  let s = await c.status({ repoRoot: here });
  assert.deepEqual(s.keys.map((k) => k.scope), [{ kind: 'repo', root: there, here: false }, { kind: 'repo', root: here, here: true }, { kind: 'all' }]);
  assert.equal(s.keys[0].sentence, `AWS for the repository at ${there}, given to all agents: AWS_ACCESS_KEY_ID •••• 7QXA, AWS_SECRET_ACCESS_KEY •••• 9f2b`);
  assert.match(s.keys[1].sentence, /^Mine for this repository, /);
  assert.deepEqual(c.envFor({ repoRoot: here, harness: 'claude' }), { MY_KEY: AWS_SECRET, ANY_KEY: AWS_SECRET }, 'as agents get them');
  // The same repository by another path is still this one; the store's own entries are never changed.
  s = await c.status({ repoRoot: link });
  assert.deepEqual(s.keys.map((k) => k.scope.here), [false, true, undefined]);
  assert.ok(keys.items.every((k) => !('here' in k.scope)));
});

test('envFor gives the store’s keys for a repository and an agent, and mask hides every stored secret', async (t) => {
  const { c } = makeConnect(t);
  const repo = path.join(T, 'repo');
  await c.addKey({ preset: 'aws', values: { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'eu-west-1' }, scope: { kind: 'repo', root: repo }, agents: 'all' });
  await c.setAgentKey('claude', ANTHROPIC_KEY);
  assert.deepEqual(c.envFor({ repoRoot: repo, harness: 'codex' }), { AWS_ACCESS_KEY_ID: AWS_ID, AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_REGION: 'eu-west-1' });
  assert.deepEqual(c.envFor({ repoRoot: path.join(T, 'other-repo'), harness: 'claude' }), { ANTHROPIC_API_KEY: ANTHROPIC_KEY });
  const text = `export AWS_SECRET_ACCESS_KEY=${AWS_SECRET} && curl -H "x-api-key: ${ANTHROPIC_KEY}" in eu-west-1`;
  const masked = c.mask(text);
  assert.equal(masked, `export AWS_SECRET_ACCESS_KEY=•••• 9f2b && curl -H "x-api-key: •••• ${ANTHROPIC_KEY.slice(-4)}" in eu-west-1`);
  for (const s of SECRETS) assert.ok(!masked.includes(s));
  // Short values: 8 to 11 characters are hidden whole; shorter ones are left (they would hide ordinary words).
  const keys = { values: () => ['abcdefgh', 'abc', 'abcdefghijklmnop'], list: async () => [], add: async () => ({ id: 'x' }), envFor: () => ({}) };
  const plain = new Connect({ home: process.env.HOME, env: process.env, keys, adapters: {}, presets: PRESETS });
  assert.equal(plain.mask('x abcdefgh y abc z abcdefghijklmnop'), 'x •••• y abc z •••• mnop');
  const none = new Connect({ home: process.env.HOME, env: process.env, keys: { ...keys, values: () => [] }, adapters: {} });
  assert.equal(none.mask('nothing to hide abcdefgh'), 'nothing to hide abcdefgh');
  // A store that cannot be read gives no keys, and says so in the log.
  const broken = makeConnect(t, { keys: Object.assign(new FakeKeys(), { envFor: () => { throw new Error('locked'); } }) });
  assert.deepEqual(broken.c.envFor({ repoRoot: repo, harness: 'claude' }), {});
  assert.ok(broken.logs.some((l) => l.includes('the keys could not be read')));
});

test('the key store’s refusals carry the status of their kind: what cannot be kept is a 400, a store that failed a 500', async (t) => {
  // The real key store, its values in private files in a home folder of this test.
  const home = scratch(t);
  const keys = new KeyStore({ home, platform: 'linux', backend: 'file' });
  const { c } = makeConnect(t, { home, keys });
  await assert.rejects(c.addKey({ preset: 'custom', values: { PATH: '/tmp/elsewhere' } }), { plain: true, why: 'forbidden', status: 400 });
  await assert.rejects(c.addKey({ preset: 'custom', values: { '1ABC': 'b' } }), { why: 'name', status: 400 });
  await assert.rejects(c.addKey({ preset: 'custom', label: 'x'.repeat(81), values: { A_B: 'b' } }), { why: 'name', status: 400 });
  await assert.rejects(c.setAgentKey('claude', 'x'.repeat(2001)), { why: 'value', status: 400 });
  await assert.rejects(c.addKey({ preset: 'custom', values: { A_B: 'b' }, scope: { kind: 'repo', root: 'relative/folder' } }), { why: 'name', status: 400 });
  // The place values are kept fails: a file stands where their folder goes.
  fs.mkdirSync(path.join(home, '.workbench'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.workbench', 'keys'), 'not a folder\n');
  await assert.rejects(c.addKey({ preset: 'custom', values: { A_B: 'b' } }), (e) => e.why === 'store' && e.status === 500 && e.plain === true && /^Workbench /.test(e.message));
  await assert.rejects(c.connectGithub(GH_TOKEN), { why: 'store', status: 500 });
  assert.equal((await c.status()).github.connected, false);
  // The same for a stand-in's refusals: too many keys; a store that cannot remove one; and a status already there, or a
  // kind the store does not use, is left as it is.
  const refusing = new FakeKeys();
  const refusal = (why, extra = {}) => Object.assign(new Error('The key store refused.'), { plain: true, why, ...extra });
  const s = makeConnect(t, { keys: refusing });
  refusing.add = async () => { throw refusal('too-many'); };
  await assert.rejects(s.c.addKey({ preset: 'custom', values: { A_B: 'b' } }), { why: 'too-many', status: 400 });
  refusing.add = async () => { throw refusal('store', { status: 503 }); };
  await assert.rejects(s.c.setAgentKey('codex', OPENAI_KEY), { why: 'store', status: 503 });
  refusing.add = async () => { throw refusal('elsewhere'); };
  await assert.rejects(s.c.addKey({ preset: 'custom', values: { A_B: 'b' } }), (e) => e.why === 'elsewhere' && e.status === undefined);
  refusing.remove = async () => { throw refusal('store'); };
  await assert.rejects(s.c.removeKey('key-1'), { why: 'store', status: 500 });
});

test('the connect service needs a key store', () => {
  assert.throws(() => new Connect({ home: process.env.HOME }), /needs the key store/);
});
