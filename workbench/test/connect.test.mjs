// The connect service (src/core/connect.mjs): agents, keys, git and GitHub, as the Agents & keys panel sees them.
//
// The key store is an in-memory stand-in with the interface of src/core/keys.mjs, or the real one keeping its values in
// private files in a temporary home folder (never the keychain). Claude Code and Codex are the
// stand-ins in test/helpers (or small shell scripts written here), reached through the real adapters; HOME is a
// temporary folder, so no Claude Code extension on this machine is ever found. GitHub is a `fetchJson` of these tests,
// and git's credential store and global config are stand-ins or files here. Nothing reaches a network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connect, claudeSignIn } from '../src/core/connect.mjs';
import { KeyStore } from '../src/core/keys.mjs';
import * as claudeAdapter from '../src/adapters/claude/runner.mjs';
import * as codexAdapter from '../src/adapters/codex/runner.mjs';
import * as workspace from '../src/core/workspace.mjs';
import { ghSignInSteps, ghSignInCommand, ghSignOutProgram, ghSignOutCommand, GH_LOGIN_ARGS } from '../src/core/github.mjs';
import { ghWrapper, fakeRelease, releaseFetch, FAKE_CODE, FAKE_REPOS } from './helpers/gh-fake.mjs';

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
    // GitHub's command-line tool: none, unless a test gives the stand-in. A real gh on this computer is never run.
    WORKBENCH_GH_BIN: path.join(T, 'no-gh-here'),
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
  const steps = []; // GitHub's sign-in in Terminal: gh's login, then setup-git
  const keys = o.keys || new FakeKeys();
  const ws = o.workspace || fakeWorkspace();
  const gh = o.github || fakeGithub(githubUser());
  const c = new Connect({
    home: o.home || process.env.HOME,
    platform: o.platform || 'darwin',
    env: o.env || process.env,
    openTerminalSteps: o.openTerminalSteps || (async (what) => { steps.push(what); return { opened: true }; }),
    ghOptions: o.ghOptions,
    ghModule: o.ghModule,
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
  return { c, logs, events, terminals, steps, keys, workspace: ws, github: gh };
}

const byId = (status, id) => status.agents.find((a) => a.id === id);

/** ConnectStatus's `github` for the token connection, with no gh on this computer (WORKBENCH_GH_BIN names none). */
const viaToken = (g) => ({
  connected: g.connected, via: g.connected ? 'token' : null, login: g.login, ghInstalled: false, ghVersion: null, ghPath: null,
  agentsUseIt: g.agentsUseIt, sentence: g.sentence, signingIn: null,
});

// ------------------------------------------------------------------ agents

test('a Claude Code that is signed in and a Codex that is signed in are both ready', async (t) => {
  const { c, events } = makeConnect(t);
  const s = await c.status({ repoRoot: path.join(T, 'repo') });
  assert.deepEqual(byId(s, 'claude'), {
    id: 'claude', name: 'Claude Code', found: true, version: '2.1.322', from: 'WORKBENCH_CLAUDE_BIN', signedIn: 'yes',
    how: 'your Claude subscription', ready: true, isDefault: true,
    sentence: 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.', actions: ['key', 'recheck'], signingIn: null,
  });
  assert.deepEqual(byId(s, 'codex'), {
    id: 'codex', name: 'Codex', found: true, version: '0.166.0', from: 'WORKBENCH_CODEX_BIN', signedIn: 'yes',
    how: 'your ChatGPT account', ready: true, isDefault: false,
    sentence: 'Codex 0.166.0 is ready, signed in with your ChatGPT account.', actions: ['key', 'default', 'recheck'], signingIn: null,
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
      'Claude Code 2.1.322 is installed but not signed in.', ['signin', 'signin-console', 'key', 'recheck']],
    ['{"loggedIn":false,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}', 'yes', 'an API key', true,
      'Claude Code 2.1.322 is ready, signed in with an API key.', ['key', 'recheck']],
    ['{"loggedIn":false,"authMethod":"third_party","apiProvider":"bedrock"}', 'yes', 'a cloud provider', true,
      'Claude Code 2.1.322 is ready, signed in with a cloud provider.', ['key', 'recheck']],
    [`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"${EMAIL}","orgName":"Example Org Name","orgId":"org-123","subscriptionType":"max"}`,
      'yes', 'your Claude subscription', true, 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.', ['key', 'recheck']],
    ['this is not JSON', 'unknown', null, true,
      'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.', ['signin', 'signin-console', 'key', 'recheck']],
    ['{"something":"else"}', 'unknown', null, true,
      'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.', ['signin', 'signin-console', 'key', 'recheck']],
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
  assert.deepEqual(s.git, { name: '', email: '', installed: true, canInstall: false, sentence: 'Git does not know your name and email yet.' });
  assert.deepEqual(await real.c.setGitIdentity({ name: 'Ada Lovelace', email: 'ada@example.org' }), { ok: true, sentence: 'Git will make your merges as Ada Lovelace, ada@example.org.' });
  s = await real.c.status();
  assert.deepEqual(s.git, { name: 'Ada Lovelace', email: 'ada@example.org', installed: true, canInstall: false, sentence: 'Git knows you as Ada Lovelace, ada@example.org.' });
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
  // A global name and email, and the repository's own: merges there use the repository's, so the panel says both.
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Ada Lovelace\n\temail = ada@example.org\n');
  s = await real.c.status({ repoRoot: repo });
  assert.equal(s.git.sentence, 'In this repository git knows you as Repo Name, repo@example.org, and merges here use that. Everywhere else: Ada Lovelace, ada@example.org.');
  assert.equal(s.git.name, 'Ada Lovelace', 'the form still holds the global name, which Save changes');
  execFileSync('git', ['config', 'user.name', 'Ada Lovelace'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'ada@example.org'], { cwd: repo });
  assert.equal((await real.c.status({ repoRoot: repo })).git.sentence, 'Git knows you as Ada Lovelace, ada@example.org.', 'the same in both says it once');
  // git that cannot be read is said plainly.
  const broken = makeConnect(t, { workspace: { ...fakeWorkspace(), gitConfigIdentity: async () => { throw Object.assign(new Error('Git could not read'), { plain: true, detail: 'fatal: bad config line 1' }); } } });
  assert.deepEqual((await broken.c.status()).git, { name: '', email: '', installed: true, canInstall: false, sentence: 'Workbench could not read git’s settings.' });
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
  assert.deepEqual(s.github, viaToken({ connected: true, login: 'octo-cat', agentsUseIt: false, sentence: 'Connected to GitHub as octo-cat.' }));
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
  assert.deepEqual(s.github, viaToken({ connected: false, login: null, agentsUseIt: false, sentence: 'Not connected.' }));
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
  assert.deepEqual((await c.status()).github, viaToken(connected));
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
  assert.deepEqual((await c.status()).github, viaToken({ connected: true, login: 'octo-cat', agentsUseIt: false, sentence: 'Connected to GitHub as octo-cat.' }));
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
  assert.deepEqual(s.github, viaToken({ connected: true, login: 'other-cat', agentsUseIt: false, sentence: 'Connected to GitHub as other-cat.' }));
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
  assert.deepEqual(s.github, viaToken({ connected: true, login: 'octo-cat', agentsUseIt: true, sentence: 'Connected to GitHub as octo-cat.' }));
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

// ------------------------------------------------------------------ GitHub through gh

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until `ok()` is true, for `ms` at most. */
async function until(ok, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await sleep(20);
  return ok();
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Short waits for the sign-in, so a test never waits the real 15 seconds or 15 minutes. */
const FAST = { codeWaitMs: 10_000, loginMs: 15_000, terminalMs: 6000, pollMs: 40, setupWaitMs: 300 };
const HAS_UNZIP = fs.existsSync('/usr/bin/unzip');
/** The global git settings of these tests, every value of one key (an empty one too). */
const gitValues = (key) => {
  const r = spawnSync('git', ['config', '--global', '-z', '--get-all', key], { encoding: 'utf8', env: process.env });
  return r.status === 0 ? r.stdout.split('\0').slice(0, -1) : [];
};

/**
 * The gh stand-in for one test, as WORKBENCH_GH_BIN: its program (a `gh` that runs test/helpers/gh-fake.mjs), its
 * sign-in file and its log. The git settings of these tests start empty, and are emptied again afterwards.
 */
function ghStandIn(t, vars = {}) {
  const dir = scratch(t);
  const gh = ghWrapper(path.join(dir, 'bin'));
  const state = path.join(dir, 'gh-state.json');
  const log = path.join(dir, 'gh-log.jsonl');
  setEnv(t, { WORKBENCH_GH_BIN: gh, FAKE_GH_STATE: state, FAKE_GH_LOG: log, FAKE_GH_LOGIN: undefined, FAKE_GH_LOGIN_DELAY_MS: undefined, ...vars });
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  t.after(() => fs.writeFileSync(path.join(T, 'gitconfig'), ''));
  return {
    dir, gh, state,
    signIn: (user = 'octo-cat') => fs.writeFileSync(state, JSON.stringify({ user })),
    signedInAs: () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')).user ?? null; } catch { return null; } },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/**
 * A computer with no gh at all: a home folder and a PATH (git only) of their own, no WORKBENCH_GH_BIN, and a release of
 * the stand-in to download (made here, served by a fetch of this test). On a Mac with /usr/bin/unzip it is the macOS zip
 * (its signature check is the test's own), elsewhere the Linux tar.gz.
 */
function noGhComputer(t, { release: o = {}, fetch: f = {} } = {}) {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const tmp = path.join(dir, 'tmp');
  for (const d of [home, bin, tmp]) fs.mkdirSync(d);
  const git = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
  fs.symlinkSync(git, path.join(bin, 'git'));
  const platform = HAS_UNZIP ? 'darwin' : 'linux';
  const release = fakeRelease({ platform, arch: 'arm64', ...o });
  const served = releaseFetch(release, f);
  const state = path.join(dir, 'gh-state.json');
  const env = { ...process.env, PATH: bin, FAKE_GH_STATE: state };
  delete env.WORKBENCH_GH_BIN;
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  t.after(() => fs.writeFileSync(path.join(T, 'gitconfig'), ''));
  const ghOptions = { ...FAST, fetchImpl: served.fetchImpl, verify: async () => true, osRelease: '27.0.0', arch: 'arm64', tmpDir: tmp, dirs: [] };
  return { dir, home, bin, tmp, env, platform, release, calls: served.calls, ghOptions, own: path.join(home, '.local', 'bin', 'gh'), state };
}

const SIGNED_IN = 'Signed in to GitHub as octo-cat. Git in Terminal, Workbench and your agents use this sign-in.';

test('GitHub through gh: the status reads gh’s own sign-in, with no network call, and says whether git uses it', async (t) => {
  const s = ghStandIn(t);
  const { c, events, github } = makeConnect(t);
  const base = { ghInstalled: true, ghVersion: '2.104.0', ghPath: s.gh, signingIn: null };
  assert.deepEqual((await c.status()).github, { connected: false, via: null, login: null, ...base, agentsUseIt: false, sentence: 'Not connected.' });
  s.signIn('octo-cat');
  assert.deepEqual((await c.status()).github, {
    connected: true, via: 'gh', login: 'octo-cat', ...base, agentsUseIt: false,
    sentence: 'Signed in to GitHub as octo-cat, but git does not use this sign-in yet. Sign in to GitHub again to set that up.',
  });
  // git asks gh for github.com (what setup-git writes): agents' git and Workbench's own clone use the sign-in.
  spawnSync('git', ['config', '--global', '--add', 'credential.https://github.com.helper', ''], { env: process.env });
  spawnSync('git', ['config', '--global', '--add', 'credential.https://github.com.helper', `!${s.gh} auth git-credential`], { env: process.env });
  const want = { connected: true, via: 'gh', login: 'octo-cat', ...base, agentsUseIt: true, sentence: SIGNED_IN };
  assert.deepEqual((await c.status()).github, want);
  // The GitHub part alone (the Mac app's --github-status) probes no agent.
  events.length = 0;
  assert.deepEqual(await c.githubStatus(), want);
  assert.deepEqual(events, []);
  // A token connection as well: gh's sign-in is the one shown.
  await c.connectGithub(GH_TOKEN);
  assert.deepEqual((await c.status()).github, want);
  // Nothing reached a network: gh was asked its version and its settings only, and GitHub only about the token.
  assert.deepEqual([...new Set(s.calls().map((x) => x.argv.join(' ')))].sort(), ['--version', 'config get user -h github.com']);
  assert.deepEqual(github.calls.map((x) => x.url), ['https://api.github.com/user']);
});

test('the GitHub status alone asks the key store only when settings.json names a token connection', async (t) => {
  ghStandIn(t);
  const keys = new FakeKeys();
  let listed = 0;
  const list = keys.list.bind(keys);
  keys.list = async () => { listed += 1; return list(); };
  const { c } = makeConnect(t, { keys });
  assert.equal((await c.githubStatus()).connected, false);
  assert.equal(listed, 0, 'no token connection: no key is read (the Mac app may ask every few seconds)');
  await c.connectGithub(GH_TOKEN);
  listed = 0;
  const g = await c.githubStatus();
  assert.deepEqual([g.connected, g.via, g.login], [true, 'token', 'octo-cat']);
  assert.equal(listed, 1);
});

test('Sign in to GitHub with gh here: the answer comes at once, the one-time code shows, and once gh is done git uses it', async (t) => {
  const s = ghStandIn(t, { FAKE_GH_LOGIN_DELAY_MS: '400', GH_TOKEN: 'person-token-not-for-gh' });
  const { c, terminals, steps } = makeConnect(t, { ghOptions: FAST });
  const heard = [];
  const r = await c.githubSignIn({ onProgress: (p) => heard.push(p) });
  assert.deepEqual(r, { ok: true, sentence: 'Asking GitHub for a one-time code…' });
  assert.ok(await until(() => c.githubSignInState()?.code), 'the code shows');
  const shown = c.githubSignInState();
  assert.deepEqual({ ...shown, since: typeof shown.since }, {
    phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device', since: 'number',
    sentence: `Your code: ${FAKE_CODE}. Open GitHub, enter the code there, and approve the sign-in.`,
  });
  assert.deepEqual((await c.status()).github.signingIn, shown);
  // A second press joins the sign-in under way, and hears where it is.
  const joined = [];
  const end = await c.githubSignIn({ wait: true, onProgress: (p) => joined.push(p) });
  assert.deepEqual(end, { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
  assert.deepEqual(joined.map((p) => p.phase), ['code', 'done']);
  assert.deepEqual(heard, [
    { phase: 'code', code: null, url: null, sentence: 'Asking GitHub for a one-time code…' },
    { phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device', sentence: `Your code: ${FAKE_CODE}. Open GitHub, enter the code there, and approve the sign-in.` },
    { phase: 'done', login: 'octo-cat', sentence: SIGNED_IN },
  ]);
  // One gh login, with no terminal and no token of the person's; then setup-git.
  const calls = s.calls().filter((x) => x.argv[0] === 'auth');
  assert.deepEqual(calls.map((x) => x.argv), [GH_LOGIN_ARGS, ['auth', 'setup-git', '--hostname', 'github.com']]);
  assert.equal(calls[0].stdin, 'ignored');
  for (const x of calls) assert.deepEqual(x.tokens, { GH_TOKEN: false, GITHUB_TOKEN: false });
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${s.gh} auth git-credential`]);
  const g = (await c.status()).github;
  assert.deepEqual([g.via, g.login, g.agentsUseIt, g.sentence, g.signingIn], ['gh', 'octo-cat', true, SIGNED_IN, null]);
  assert.deepEqual([terminals, steps], [[], []], 'no Terminal');
});

test('Sign in to GitHub with gh signed in already: git is made to use it, and that is all', async (t) => {
  const s = ghStandIn(t);
  s.signIn('octo-cat');
  const { c } = makeConnect(t, { ghOptions: FAST });
  assert.deepEqual(await c.githubSignIn({ wait: true }), { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
  assert.deepEqual(s.calls().filter((x) => x.argv[0] === 'auth').map((x) => x.argv[1]), ['setup-git']);
});

test('Sign in to GitHub with no gh: GitHub’s own build is downloaded and checked first, into ~/.local/bin, then the sign-in', async (t) => {
  const w = noGhComputer(t);
  const { c } = makeConnect(t, { home: w.home, env: w.env, platform: w.platform, ghOptions: w.ghOptions });
  const before = (await c.status()).github;
  assert.deepEqual([before.ghInstalled, before.ghPath, before.ghVersion, before.connected], [false, null, null, false]);
  const heard = [];
  const r = await c.githubSignIn({ onProgress: (p) => heard.push(p) });
  assert.deepEqual(r, { ok: true, sentence: 'Getting GitHub’s command-line tool…' });
  const end = await c.githubSignIn({ wait: true });
  assert.deepEqual(end, { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
  assert.deepEqual(heard.map((p) => [p.phase, p.code ?? null]), [['installing', null], ['code', null], ['code', FAKE_CODE], ['done', null]]);
  assert.deepEqual(fs.readdirSync(path.dirname(w.own)), ['gh']);
  assert.deepEqual(fs.readdirSync(w.tmp), [], 'the download’s folder is gone');
  assert.deepEqual(w.calls.map((x) => x.url), [
    'https://github.com/cli/cli/releases/latest',
    `https://github.com/cli/cli/releases/download/v2.104.0/${w.release.checksumsName}`,
    `https://github.com/cli/cli/releases/download/v2.104.0/${w.release.name}`,
  ]);
  // git asks Workbench's own gh, by its full path, which stays where it is.
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${w.own} auth git-credential`]);
  const g = (await c.status()).github;
  assert.deepEqual([g.ghInstalled, g.ghPath, g.ghVersion, g.via, g.login], [true, w.own, '2.104.0', 'gh', 'octo-cat']);
});

test('an older gh on the PATH: Workbench gets its own copy in ~/.local/bin, says why, and uses it by its full path', async (t) => {
  const w = noGhComputer(t);
  const old = ghWrapper(w.bin, { version: '2.40.1' });
  const { c } = makeConnect(t, { home: w.home, env: w.env, platform: w.platform, ghOptions: w.ghOptions });
  const before = (await c.status()).github;
  assert.deepEqual([before.ghInstalled, before.ghPath, before.ghVersion], [false, null, null]);
  const heard = [];
  assert.equal((await c.githubSignIn({ wait: true, onProgress: (p) => heard.push(p) })).ok, true);
  assert.equal(heard[0].sentence, `Getting GitHub’s command-line tool… The one at ${old} is version 2.40.1, older than Workbench needs, so Workbench gets its own.`);
  const g = (await c.status()).github;
  assert.deepEqual([g.ghInstalled, g.ghPath, g.ghVersion], [true, w.own, '2.104.0']);
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${w.own} auth git-credential`]);
});

test('when gh cannot sign in without Terminal (it fails, asks a question, or gives no code), Terminal opens on its two steps, and Workbench waits there', async (t) => {
  for (const mode of ['fail', 'question', 'silent']) {
    await t.test(mode, async (st) => {
      const s = ghStandIn(st, { FAKE_GH_LOGIN: mode });
      // The person signs in in Terminal, and closes it before setup-git: Workbench runs setup-git itself.
      const steps = [];
      const { c, logs } = makeConnect(st, {
        // Only the gh that says nothing waits for the time without a code to pass; the others say why at once.
        ghOptions: { ...FAST, codeWaitMs: mode === 'silent' ? 300 : FAST.codeWaitMs },
        openTerminalSteps: async (what) => { steps.push(what); setTimeout(() => s.signIn('octo-cat'), 150); return { opened: true }; },
      });
      const heard = [];
      const end = await c.githubSignIn({ wait: true, onProgress: (p) => heard.push(p) });
      assert.deepEqual(end, { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
      assert.deepEqual(steps, [{ title: 'Signing in to GitHub', steps: ghSignInSteps(s.gh) }]);
      assert.ok(heard.some((p) => p.phase === 'terminal' && p.opened === true && p.sentence === 'Terminal is open: follow the steps there, then come back.'));
      assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${s.gh} auth git-credential`]);
      assert.ok(logs.some((l) => l.includes(`could not sign in without Terminal (${mode === 'fail' ? 'failed' : mode === 'question' ? 'question' : 'no-code'}`)));
      assert.ok(!JSON.stringify(heard).includes('error connecting'), 'gh’s own words are never passed on');
    });
  }
});

test('where Terminal does not open: the command to run, and Workbench still waits; nobody signs in, and the sign-in ends saying so', async (t) => {
  const s = ghStandIn(t, { FAKE_GH_LOGIN: 'fail' });
  const linux = makeConnect(t, { platform: 'linux', ghOptions: FAST });
  await linux.c.githubSignIn();
  assert.ok(await until(() => linux.c.githubSignInState()?.phase === 'terminal'));
  const shown = linux.c.githubSignInState();
  assert.deepEqual({ ...shown, since: 0 }, {
    phase: 'terminal', code: null, url: null, since: 0, sentence: 'Run this command in a terminal, then come back here.', opened: false, command: ghSignInCommand(s.gh),
  });
  assert.equal(linux.steps.length, 0);
  s.signIn('octo-cat');
  assert.equal((await linux.c.githubSignIn({ wait: true })).ok, true);
  // macOS, Terminal not opening, and nobody signing in before the time is up.
  fs.rmSync(s.state, { force: true });
  const mac = makeConnect(t, { ghOptions: { ...FAST, terminalMs: 300 }, openTerminalSteps: async () => ({ opened: false }) });
  const heard = [];
  const end = await mac.c.githubSignIn({ wait: true, onProgress: (p) => heard.push(p) });
  assert.ok(heard.some((p) => p.phase === 'terminal' && p.opened === false && p.sentence === 'Workbench could not open Terminal. Run this command in a terminal, then come back here.'));
  assert.deepEqual(end, { ok: false, phase: 'error', why: 'terminal', sentence: 'The sign-in in Terminal did not finish. Sign in to GitHub again to try once more.' });
  const g = (await mac.c.status()).github;
  assert.deepEqual([g.connected, g.signingIn, g.sentence], [false, null, 'The sign-in in Terminal did not finish. Sign in to GitHub again to try once more.']);
});

test('Cancel stops gh’s login; one sign-in at a time; a code that runs out says so', async (t) => {
  const s = ghStandIn(t, { FAKE_GH_LOGIN: 'wait' });
  const { c } = makeConnect(t, { ghOptions: FAST });
  await c.githubSignIn();
  assert.ok(await until(() => c.githubSignInState()?.code));
  assert.deepEqual(await c.githubSignIn(), { ok: true, sentence: `Your code: ${FAKE_CODE}. Open GitHub, enter the code there, and approve the sign-in.` });
  const logins = s.calls().filter((x) => x.argv[1] === 'login');
  assert.equal(logins.length, 1, 'one gh login');
  assert.deepEqual(await c.cancelGithubSignIn(), { ok: true, sentence: 'Stopped signing in to GitHub.' });
  assert.ok(await until(() => !alive(logins[0].pid)), 'gh is stopped');
  const g = (await c.status()).github;
  assert.deepEqual([g.signingIn, g.sentence], [null, 'Not connected.'], 'a sign-in the person stopped leaves no words behind');
  assert.deepEqual(await c.cancelGithubSignIn(), { ok: true, sentence: 'No sign-in to GitHub was under way.' });
  // The code runs out.
  const expiring = makeConnect(t, { ghOptions: { ...FAST, loginMs: 300 } });
  const end = await expiring.c.githubSignIn({ wait: true });
  assert.deepEqual(end, { ok: false, phase: 'error', why: 'expired', sentence: 'The one-time code ran out before the sign-in was approved on GitHub. Sign in to GitHub again for a new code.' });
  assert.equal((await expiring.c.status()).github.sentence, end.sentence);
  assert.ok(await until(() => s.calls().filter((x) => x.argv[1] === 'login').every((x) => !alive(x.pid))));
});

test('gh giving up by itself as the code runs out (GitHub’s end of it came first) says the code ran out, and opens no Terminal', async (t) => {
  ghStandIn(t, { FAKE_GH_LOGIN: 'deny', FAKE_GH_LOGIN_DELAY_MS: '2500' });
  const { c, steps } = makeConnect(t, { ghOptions: { ...FAST, loginMs: 4000 } });
  const end = await c.githubSignIn({ wait: true });
  assert.deepEqual(end, { ok: false, phase: 'error', why: 'expired', sentence: 'The one-time code ran out before the sign-in was approved on GitHub. Sign in to GitHub again for a new code.' });
  assert.deepEqual(steps, [], 'no Terminal');
});

test('Terminal’s setup-git and Workbench’s never run at once: Workbench waits for the one in Terminal, and runs none of its own', async (t) => {
  const s = ghStandIn(t, { FAKE_GH_LOGIN: 'fail' });
  let inTerminal = null;
  const { c } = makeConnect(t, {
    ghOptions: { ...FAST, setupWaitMs: 8000 },
    // Terminal, as the person goes through it: gh's login signs in, then its setup-git runs, slowly here (a pause
    // between its writes), while Workbench reads gh's sign-in every 40 ms.
    openTerminalSteps: async ({ steps }) => {
      setTimeout(() => {
        s.signIn('octo-cat');
        const setup = steps[1];
        inTerminal = new Promise((resolve) => {
          spawn(setup.program, setup.args, { env: { ...process.env, FAKE_GH_SETUP_GIT_PAUSE_MS: '500' }, stdio: 'ignore' }).on('exit', resolve);
        });
      }, 100);
      return { opened: true };
    },
  });
  assert.deepEqual(await c.githubSignIn({ wait: true }), { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
  assert.equal(await inTerminal, 0, 'Terminal’s setup-git worked');
  for (const key of ['credential.https://github.com.helper', 'credential.https://gist.github.com.helper']) {
    assert.deepEqual(gitValues(key), ['', `!${s.gh} auth git-credential`], key);
  }
  assert.equal(s.calls().filter((x) => x.argv[1] === 'setup-git').length, 1, 'Terminal’s alone');
});

test('while Workbench waits for Terminal’s setup-git, Cancel stops at once; when Terminal’s time runs out meanwhile, the sign-in still finishes', async (t) => {
  const s = ghStandIn(t, { FAKE_GH_LOGIN: 'fail' });
  // The person signs in in Terminal, and closes it before setup-git.
  const closedEarly = async () => { setTimeout(() => s.signIn('octo-cat'), 50); return { opened: true }; };
  const { c } = makeConnect(t, { ghOptions: { ...FAST, setupWaitMs: 20_000 }, openTerminalSteps: closedEarly });
  await c.githubSignIn();
  assert.ok(await until(() => s.signedInAs() === 'octo-cat'));
  await sleep(300); // Workbench has seen the sign-in, and waits for git to use gh
  const asked = Date.now();
  assert.deepEqual(await c.cancelGithubSignIn(), { ok: true, sentence: 'Stopped signing in to GitHub.' });
  assert.ok(Date.now() - asked < 2000, 'at once');
  assert.equal(s.calls().some((x) => x.argv[1] === 'setup-git'), false);
  assert.deepEqual(gitValues('credential.https://github.com.helper'), []);
  // Terminal's 400 ms run out while Workbench waits 1.2 seconds for git: it then runs setup-git itself, and is done.
  fs.rmSync(s.state, { force: true });
  const late = makeConnect(t, { ghOptions: { ...FAST, terminalMs: 400, setupWaitMs: 1200 }, openTerminalSteps: closedEarly });
  assert.deepEqual(await late.c.githubSignIn({ wait: true }), { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN });
  assert.equal(s.calls().filter((x) => x.argv[1] === 'setup-git').length, 1);
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${s.gh} auth git-credential`]);
});

test('a download that is refused ends the sign-in in plain words, opens nothing, and installs nothing; a download can be stopped', async (t) => {
  const bad = noGhComputer(t, { fetch: { archive: Buffer.from('not the archive') } });
  const { c, steps, terminals } = makeConnect(t, { home: bad.home, env: bad.env, platform: bad.platform, ghOptions: bad.ghOptions });
  const sentence = 'The download of GitHub’s command-line tool did not match the checksum GitHub published for it, so Workbench did not install it.';
  assert.deepEqual(await c.githubSignIn({ wait: true }), { ok: false, phase: 'error', why: 'checksum', sentence });
  const g = (await c.status()).github;
  assert.deepEqual([g.connected, g.ghInstalled, g.signingIn, g.sentence], [false, false, null, sentence]);
  assert.equal(fs.existsSync(bad.own), false);
  assert.deepEqual(fs.readdirSync(bad.tmp), []);
  assert.deepEqual([steps, terminals], [[], []]);
  // A slow download, stopped: no words left behind, nothing installed.
  const slow = noGhComputer(t, { fetch: { hang: true } });
  const s2 = makeConnect(t, { home: slow.home, env: slow.env, platform: slow.platform, ghOptions: slow.ghOptions });
  assert.deepEqual(await s2.c.githubSignIn(), { ok: true, sentence: 'Getting GitHub’s command-line tool…' });
  assert.equal((await s2.c.status()).github.signingIn.phase, 'installing');
  assert.ok(await until(() => slow.calls.length === 3), 'the archive is on its way');
  assert.deepEqual(await s2.c.cancelGithubSignIn(), { ok: true, sentence: 'Stopped signing in to GitHub.' });
  assert.equal((await s2.c.status()).github.sentence, 'Not connected.');
  assert.equal(fs.existsSync(slow.own), false);
  assert.deepEqual(fs.readdirSync(slow.tmp), []);
});

test('a WORKBENCH_GH_BIN that is not there: Sign in says so at once, and nothing is downloaded', async (t) => {
  const missing = path.join(T, 'no-gh-here');
  let fetched = 0;
  const { c } = makeConnect(t, { ghOptions: { ...FAST, fetchImpl: async () => { fetched++; throw new Error('no'); } } });
  const sentence = `GitHub’s command-line tool is not at ${missing}, the path in WORKBENCH_GH_BIN.`;
  assert.deepEqual(await c.githubSignIn(), { ok: false, why: 'gh', sentence });
  assert.deepEqual(await c.githubSignIn({ wait: true }), { ok: false, phase: 'error', why: 'gh', sentence });
  assert.equal(fetched, 0);
});

const REVOKE = 'GitHub still lists this sign-in under Settings → Applications until you revoke it there.';
/** What Sign out adds once git's settings are back as they were: git forgot the sign-in it kept for that account. */
const FORGOT = (login) => `Git also forgot any GitHub sign-in it kept for ${login}, even one you saved yourself.`;

test('Sign out: gh forgets the sign-in, git loses what setup-git wrote (nothing of the person’s) and the sign-in it kept for that account', async (t) => {
  const s = ghStandIn(t, { GITHUB_TOKEN: 'person-token-not-for-gh' });
  s.signIn('octo-cat');
  const { c, terminals, workspace: ws } = makeConnect(t, { ghOptions: FAST });
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  spawnSync('git', ['config', '--global', 'user.name', 'Ada'], { env: process.env });
  assert.deepEqual(await c.githubSignOut(), { ok: true, sentence: `Signed out of GitHub. ${FORGOT('octo-cat')} ${REVOKE}` });
  assert.equal(s.signedInAs(), null);
  const logout = s.calls().find((x) => x.argv[1] === 'logout');
  assert.deepEqual(logout.argv, ['auth', 'logout', '--hostname', 'github.com', '--user', 'octo-cat']);
  assert.deepEqual(logout.tokens, { GH_TOKEN: false, GITHUB_TOKEN: false });
  for (const key of ['credential.https://github.com.helper', 'credential.https://gist.github.com.helper']) assert.deepEqual(gitValues(key), [], key);
  assert.deepEqual(gitValues('user.name'), ['Ada']);
  assert.deepEqual(ws.calls, [['reject', 'github.com', 'octo-cat']]);
  assert.equal((await c.status()).github.connected, false);
  assert.deepEqual(terminals, []);
  assert.deepEqual(await c.githubSignOut(), { ok: true, sentence: 'GitHub’s command-line tool was not signed in.' });
  assert.equal(ws.calls.length, 1, 'no account to forget');
  // gh cannot sign out by itself: Terminal, on macOS; elsewhere, the command.
  s.signIn('octo-cat');
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  setEnv(t, { FAKE_GH_LOGOUT: 'fail' });
  const linux = makeConnect(t, { platform: 'linux', ghOptions: FAST });
  assert.deepEqual(await linux.c.githubSignOut(), {
    ok: false, why: 'gh', opened: false, command: ghSignOutCommand(s.gh), sentence: 'Workbench could not sign out of GitHub. Run this command in a terminal, then check again.',
  });
  const helper = ['', `!${s.gh} auth git-credential`];
  assert.deepEqual(gitValues('credential.https://github.com.helper'), helper, 'still signed in: git keeps using it');
  assert.deepEqual(await c.githubSignOut(), { ok: true, opened: true, sentence: `Terminal is open to sign you out of GitHub. When it is done, come back here. ${REVOKE}` });
  assert.deepEqual(terminals, [{ title: 'Signing out of GitHub', ...ghSignOutProgram(s.gh) }]);
  // Until gh has signed out in Terminal, git goes on asking it and forgets nothing, also when Terminal is closed first.
  assert.deepEqual(gitValues('credential.https://github.com.helper'), helper);
  assert.equal((await c.status()).github.via, 'gh');
  assert.deepEqual(gitValues('credential.https://github.com.helper'), helper);
  assert.equal(ws.calls.length, 1);
  // gh signs out in Terminal: the next look at the status sets git back, and git forgets octo-cat's sign-in, once.
  fs.writeFileSync(s.state, '{}');
  assert.equal((await c.status()).github.connected, false);
  for (const key of ['credential.https://github.com.helper', 'credential.https://gist.github.com.helper']) assert.deepEqual(gitValues(key), [], key);
  assert.deepEqual(ws.calls, [['reject', 'github.com', 'octo-cat'], ['reject', 'github.com', 'octo-cat']]);
  await c.status();
  assert.equal(ws.calls.length, 2);
});

test('Sign out: git forgets the copy of the sign-in it was given for that account, once gh’s lines are out of the way (real git, a file for its helper)', async (t) => {
  const s = ghStandIn(t);
  // git's own helper, in place of Apple's osxkeychain: a file of this test.
  const kept = path.join(scratch(t), 'git-credentials');
  spawnSync('git', ['config', '--global', 'credential.helper', `store --file=${kept}`], { env: process.env });
  // gh's login in Terminal, answered yes to its git question, gives git's helper the token (a made-up one here).
  const who = { host: 'github.com', username: 'octo-cat' };
  await workspace.approveGitCredential({ ...who, password: 'made-up-token-from-gh' });
  assert.equal((await workspace.fillGitCredential(who))?.password, 'made-up-token-from-gh');
  s.signIn('octo-cat');
  const { c } = makeConnect(t, { workspace, ghOptions: FAST });
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${s.gh} auth git-credential`], 'git asks gh, past that copy');
  const out = await c.githubSignOut();
  assert.deepEqual(gitValues('credential.https://github.com.helper'), []);
  assert.equal(await workspace.fillGitCredential(who), null, 'git no longer signs in as octo-cat');
  assert.deepEqual(gitValues('credential.helper'), [`store --file=${kept}`], 'the person’s own helper stays');
  assert.deepEqual(out, { ok: true, sentence: `Signed out of GitHub. ${FORGOT('octo-cat')} ${REVOKE}` });
});

test('Sign out while the token connection is for the same account: git keeps that sign-in, and the answer claims nothing of it', async (t) => {
  const s = ghStandIn(t);
  s.signIn('octo-cat');
  const { c, workspace: ws } = makeConnect(t, { ghOptions: FAST });
  await c.connectGithub(GH_TOKEN);
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  ws.calls.length = 0;
  assert.deepEqual(await c.githubSignOut(), { ok: true, sentence: `Signed out of GitHub. ${REVOKE}` });
  assert.deepEqual(ws.calls, [], 'git keeps the token’s sign-in for octo-cat');
  assert.deepEqual(gitValues('credential.https://github.com.helper'), []);
  assert.equal((await c.status()).github.sentence, 'Connected to GitHub as octo-cat.');
});

test('Sign out when gh’s settings cannot be read: a logout that worked still sets git back (there is no account to forget)', async (t) => {
  const s = ghStandIn(t);
  s.signIn('octo-cat');
  const { c, workspace: ws } = makeConnect(t, { ghOptions: FAST });
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  setEnv(t, { FAKE_GH_CONFIG: 'broken' });
  assert.deepEqual(await c.githubSignOut(), { ok: true, sentence: `Signed out of GitHub. ${REVOKE}` });
  assert.deepEqual(s.calls().find((x) => x.argv[1] === 'logout').argv, ['auth', 'logout', '--hostname', 'github.com']);
  assert.equal(s.signedInAs(), null);
  assert.deepEqual(gitValues('credential.https://github.com.helper'), []);
  assert.deepEqual(ws.calls, []);
});

test('Sign out when gh is still signed in afterwards, with another account it holds: git goes on asking gh, and forgets nothing', async (t) => {
  const s = ghStandIn(t);
  s.signIn('octo-cat');
  // gh holds a second account for github.com, and makes it the active one when the first signs out.
  const ghModule = { ghLogout: async ({ login }) => { assert.equal(login, 'octo-cat'); s.signIn('other-cat'); return { ok: true }; } };
  const { c, workspace: ws } = makeConnect(t, { ghOptions: FAST, ghModule });
  assert.equal((await c.githubSignIn({ wait: true })).ok, true);
  assert.deepEqual(await c.githubSignOut(), {
    ok: true, sentence: `Signed out of GitHub as octo-cat. GitHub’s command-line tool is still signed in as other-cat, and git goes on using that sign-in. ${REVOKE}`,
  });
  assert.deepEqual(gitValues('credential.https://github.com.helper'), ['', `!${s.gh} auth git-credential`]);
  assert.deepEqual(ws.calls, []);
  const g = (await c.status()).github;
  assert.deepEqual([g.via, g.login, g.agentsUseIt], ['gh', 'other-cat', true]);
});

test('the repository list comes through gh when gh is signed in, and from the token connection otherwise', async (t) => {
  const s = ghStandIn(t);
  const listing = [{ full_name: 'octo-cat/by-token', clone_url: 'https://github.com/octo-cat/by-token.git', private: false, pushed_at: '2026-11-02T09:00:00Z' }];
  const answer = (url, headers) => (url === 'https://api.github.com/user/repos?per_page=100&sort=pushed' ? { status: 200, json: listing } : githubUser()(url, headers));
  const { c, github } = makeConnect(t, { github: fakeGithub(answer) });
  assert.deepEqual(await c.githubRepos(), [], 'neither');
  await c.connectGithub(GH_TOKEN);
  const byToken = [{ fullName: 'octo-cat/by-token', cloneUrl: 'https://github.com/octo-cat/by-token.git', private: false, pushedAt: '2026-11-02T09:00:00Z' }];
  assert.deepEqual(await c.githubRepos(), byToken, 'gh not signed in: the token');
  assert.equal(s.calls().some((x) => x.argv[0] === 'api'), false, 'gh is asked for nothing over the network while it is signed out');
  s.signIn();
  github.calls.length = 0;
  assert.deepEqual(await c.githubRepos(), FAKE_REPOS.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private, pushedAt: r.pushed_at })));
  assert.deepEqual(github.calls, [], 'the token is not used');
  setEnv(t, { FAKE_GH_API: 'fail' });
  assert.deepEqual(await c.githubRepos(), byToken, 'gh failed: the token');
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

test('a FIFO in place of settings.json is never waited on: Connect reads it as no settings', () => {
  // Something running as the person (an agent's command, a test it runs) can make a FIFO where Workbench reads its
  // settings. A plain read would wait for a writer forever and freeze Workbench, so the read runs in a child process
  // with a time limit here: a regression fails this test instead of hanging the suite.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-connect-fifo-'));
  try {
    const dir = path.join(home, '.workbench');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'settings.json');
    const made = spawnSync('mkfifo', [file], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const script = `import { Connect } from ${JSON.stringify(new URL('../src/core/connect.mjs', import.meta.url).href)};
      const keys = { load: async () => ({ keys: [], missing: [] }), list: async () => [], add: async () => ({ id: 'k' }), remove: async () => ({ removed: true }), values: () => [], envFor: () => ({}) };
      const c = new Connect({ home: ${JSON.stringify(home)}, env: { HOME: ${JSON.stringify(home)}, PATH: '/usr/bin:/bin' }, keys, adapters: {}, probe: false });
      console.log(JSON.stringify(c._readSettings()));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home } });
    assert.equal(run.signal, null, 'reading settings.json was still waiting on the FIFO after 10 seconds');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim().split('\n').pop(), '{}');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a re-check where the program did not answer in time keeps the last check; one where it failed does not; the log says when readiness changes', async () => {
  // A freshly updated Claude Code, on a busy Mac, can take longer than 5 seconds to print its version: one such re-check
  // would make it "could not be started", and every launch would be refused.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-connect-slow-'));
  try {
    const keys = { load: async () => ({ keys: [], missing: [] }), list: async () => [], add: async () => ({ id: 'k' }), remove: async () => ({ removed: true }), values: () => [], envFor: () => ({}) };
    const env = { HOME: home, PATH: process.env.PATH, WORKBENCH_CLAUDE_BIN: CLAUDE_FAKE, WORKBENCH_CODEX_BIN: path.join(home, 'no-codex'), WORKBENCH_GH_BIN: path.join(home, 'no-gh') };
    const logs = [];
    const log = { info: () => {}, debug: () => {}, warn: (l) => logs.push(l), error: (l) => logs.push(l) };
    // Codex is not installed here (its own adapter reads the test process's environment, which has the Codex stand-in)
    const codex = { available: async () => ({ ok: false, loggedIn: null, reason: 'Codex is not installed.' }) };
    const c = new Connect({ home, env, keys, log, adapters: { claude: claudeAdapter, codex }, probe: false, versionTimeoutMs: 400, fetchJson: async () => ({ status: 599, json: null }) });
    const first = await c.recheck({});
    assert.equal(first.claude.ok, true, 'the first check finds Claude Code ready');

    env.FAKE_CLAUDE_VERSION = 'hang'; // the next one does not answer in time
    const second = await c.recheck({});
    assert.equal(second.claude.ok, true, 'a slow answer keeps the last check');
    assert.equal(c.defaultAgent(), 'claude');
    assert.ok(logs.some((l) => /^connect: Claude Code did not answer in time; Workbench keeps its last check \(Claude Code 2\.1\.221 is ready/.test(l)), logs.join('\n'));
    assert.ok(!logs.some((l) => /was ready and is not now/.test(l)));

    env.FAKE_CLAUDE_VERSION = 'fail'; // one that fails is what the check says, however it was before
    const third = await c.recheck({});
    assert.equal(third.claude.ok, false, 'a program that failed is not kept');
    assert.equal(c.defaultAgent(), null);
    assert.ok(logs.some((l) => /^connect: Claude Code was ready and is not now: Claude Code /.test(l)), logs.join('\n'));

    env.FAKE_CLAUDE_VERSION = 'hang'; // and a slow answer after a failure keeps nothing: there is no good check to keep
    assert.equal((await c.recheck({})).claude.ok, false);

    delete env.FAKE_CLAUDE_VERSION;
    assert.equal((await c.recheck({})).claude.ok, true);
    assert.ok(logs.some((l) => /^connect: Claude Code is ready again: Claude Code 2\.1\.221 is ready/.test(l)), logs.join('\n'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
