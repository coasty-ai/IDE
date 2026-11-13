// Signing in to Claude Code and Codex in the browser (src/core/signin.mjs, and Connect's agentSignIn, agentSignInState
// and cancelAgentSignIn), its routes, and git itself: whether it can run (gitPresence and status().git), Install
// (installGitTools, POST /api/connect/git/install) and the CLI's --git-status.
//
// Claude Code and Codex are the stand-ins in test/helpers. Their `auth login` and `login` succeed, fail, wait, or ask for
// something to be typed, as FAKE_CLAUDE_LOGIN and FAKE_CODEX_SIGNIN say, and keep their sign-in in a file of this test,
// which their `auth status` and `login status` read. HOME is a temporary folder. xcode-select is a stand-in: no test
// opens Apple's installer, and nothing reaches a network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Connect, gitPresence } from '../src/core/connect.mjs';
import { SignIns, waitsForInput, WAITS_FOR_INPUT } from '../src/core/signin.mjs';
import { createServer } from '../src/server/http.mjs';
import { Store } from '../src/core/store.mjs';
import * as claudeAdapter from '../src/adapters/claude/runner.mjs';
import * as codexAdapter from '../src/adapters/codex/runner.mjs';
import { parseArgs, gitStatusMode } from '../bin/workbench.mjs';

const CLAUDE_FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const CODEX_FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };
const SIGNED_OUT = '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}';
const FALLBACK = 'The sign-in in the browser did not finish. Sign in in Terminal instead.';
const NOT_SIGNED_IN = 'Claude Code 2.1.322 is installed but not signed in.';
const GIT_MISSING_MAC = 'Git is not installed yet. Apple’s developer tools include it.';
const GIT_MISSING_ELSEWHERE = 'Git is not installed yet. Install git with your package manager.';
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';

let T;
const savedEnv = { ...process.env };

before(() => {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-signin-')));
  for (const dir of ['home', 'xdg', 'tmp']) fs.mkdirSync(path.join(T, dir));
  fs.writeFileSync(path.join(T, 'gitconfig'), '');
  Object.assign(process.env, {
    HOME: path.join(T, 'home'), XDG_CONFIG_HOME: path.join(T, 'xdg'), TMPDIR: path.join(T, 'tmp'),
    WORKBENCH_CLAUDE_BIN: CLAUDE_FAKE, WORKBENCH_CODEX_BIN: CODEX_FAKE, FAKE_CLAUDE_VERSION: '2.1.322',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(T, 'gitconfig'),
    CLAUDECODE: '1', // a surrounding Claude Code session's marker, which no login program may get
  });
  for (const k of ['FAKE_CLAUDE_AUTH', 'FAKE_CLAUDE_AUTH_FILE', 'FAKE_CLAUDE_LOGIN', 'FAKE_CLAUDE_LOGIN_DELAY_MS', 'FAKE_CLAUDE_LOGIN_LOG',
    'FAKE_CODEX_LOGIN', 'FAKE_CODEX_LOGIN_FILE', 'FAKE_CODEX_SIGNIN', 'FAKE_CODEX_SIGNIN_DELAY_MS', 'FAKE_CODEX_LOG',
    'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'WORKBENCH_AGENT_ID', 'GH_TOKEN', 'GITHUB_TOKEN']) delete process.env[k];
});

after(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(T, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `ok()` (which may be async) is true, for `ms` at most. */
async function until(ok, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ok()) return true;
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
}

/** Whether the process has gone, waiting up to `ms`. */
function gone(pid, ms = 8000) {
  return until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code === 'ESRCH';
    }
  }, ms);
}

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

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(T, 'case-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The JSON lines a stand-in wrote to its log. */
function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Claude Code installed and signed out; what `auth login` keeps goes to a file of this test. */
function claudeSignedOut(t, vars = {}) {
  const dir = scratch(t);
  const auth = path.join(dir, 'claude-auth.json');
  const log = path.join(dir, 'claude-login.jsonl');
  setEnv(t, { FAKE_CLAUDE_AUTH: SIGNED_OUT, FAKE_CLAUDE_AUTH_FILE: auth, FAKE_CLAUDE_LOGIN_LOG: log, ...vars });
  return { auth, log };
}

/** Codex installed and signed out; what `codex login` keeps goes to a file of this test. */
function codexSignedOut(t, vars = {}) {
  const dir = scratch(t);
  const kept = path.join(dir, 'codex-login');
  const log = path.join(dir, 'codex.jsonl');
  setEnv(t, { FAKE_CODEX_LOGIN: 'out', FAKE_CODEX_LOGIN_FILE: kept, FAKE_CODEX_LOG: log, ...vars });
  return { kept, log };
}

/** A key store with no keys, in the shape of src/core/keys.mjs. */
const NO_KEYS = {
  async list() { return []; },
  async add() { throw new Error('No key is added in these tests.'); },
  async remove() { return { removed: false }; },
  async load() {},
  envFor() { return {}; },
  values() { return []; },
  valuesOf() { return null; },
};

/**
 * A Connect for one test, probing the stand-ins. Its workspace stand-in has no git(), so git counts as installed and
 * nothing runs for it, unless `workspace` says otherwise. `runProgram` (xcode-select) refuses anything the test did not
 * plan for; every program it is asked to run is in `programs`.
 */
function makeConnect(t, o = {}) {
  const logs = [];
  const terminals = [];
  const programs = [];
  const events = [];
  const c = new Connect({
    home: process.env.HOME, platform: o.platform || 'darwin', env: process.env, keys: NO_KEYS,
    workspace: o.workspace || { async gitConfigIdentity() { return { name: 'Ada Lovelace', email: 'ada@example.org' }; } },
    adapters: ADAPTERS, flags: { claude: null },
    openTerminal: async (what) => { terminals.push(what); return { opened: true }; },
    fetchJson: async () => { throw new Error('These tests reach no network.'); },
    log: Object.assign((l) => logs.push(l), { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l), debug: (l) => logs.push(l) }),
    presets: [], probe: false, signInCheckMs: o.checkMs ?? 50, signInTimeoutMs: o.timeoutMs ?? 30_000,
    runProgram: async (program, args, opts) => {
      programs.push([program, ...args]);
      if (o.runProgram) return o.runProgram(program, args, opts);
      throw new Error(`No program may run here: ${program} ${args.join(' ')}`);
    },
  });
  c.on('agents', (map) => events.push(['agents', JSON.parse(JSON.stringify(map))]));
  c.on('changed', () => events.push(['changed']));
  t.after(async () => {
    for (const id of ['claude', 'codex']) await c.cancelAgentSignIn(id);
  });
  return { c, logs, terminals, programs, events };
}

const byId = (status, id) => status.agents.find((a) => a.id === id);
const row = (a) => ({ signedIn: a.signedIn, ready: a.ready, signingIn: a.signingIn, actions: a.actions, sentence: a.sentence });

// ------------------------------------------------------------------ what counts as waiting for input

test('waitsForInput: Claude Code’s ordinary wait is not a question; a prompt for a code, a key or a yes is', () => {
  const link = 'https://claude.ai/oauth/authorize?code=true&state=x';
  const ordinary = `Opening browser to sign in…\nIf the browser didn't open, visit: \u001b]8;;${link}\u0007${link}\u001b]8;;\u0007\nPaste code here if prompted > `;
  assert.equal(waitsForInput(ordinary), false, 'printed every time, while Claude Code waits for the browser');
  assert.equal(waitsForInput('Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?x=1\n'), false);
  for (const asks of [
    "The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\nSign in at: https://claude.ai/x\nPaste code here > ",
    'Paste code here > ',
    '\u001b[1mPaste code here\u001b[0m > ',
    'Press Enter to open github.com in your browser...',
    'Continue? (y/N) ',
    'Overwrite it? [Y/n] ',
    'Enter the code shown in your browser: ',
    '! Enter this one-time code: ABCD-1234',
  ]) assert.equal(waitsForInput(asks), true, asks);
  assert.equal(waitsForInput(''), false);
  assert.ok(Object.isFrozen(WAITS_FOR_INPUT));
});

// ------------------------------------------------------------------ signing in

test('Sign in to Claude Code: its own login runs in the background, the panel waits, then the row turns ready', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'ok', FAKE_CLAUDE_LOGIN_DELAY_MS: '400' });
  const { c, logs, events } = makeConnect(t);
  let a = byId(await c.status(), 'claude');
  assert.deepEqual(row(a), { signedIn: 'no', ready: false, signingIn: null, actions: ['signin', 'signin-console', 'key', 'recheck'], sentence: NOT_SIGNED_IN });
  assert.equal(c.agentSignInState('claude'), null, 'none has run yet');
  const r = await c.agentSignIn('claude');
  assert.deepEqual({ ...r, since: typeof r.since }, { ok: true, waiting: true, since: 'number', sentence: 'Finish signing in to Claude in your browser.' });
  a = byId(await c.status(), 'claude');
  assert.deepEqual(a.signingIn, { since: r.since, browser: true, sentence: 'Finish signing in to Claude in your browser.' });
  assert.deepEqual(a.actions, ['key', 'recheck'], 'no Sign in while one waits: the panel shows Cancel');
  assert.deepEqual(c.agentSignInState('claude'), {
    phase: 'waiting', waiting: true, console: false, since: r.since, endedAt: null, why: null, sentence: 'Finish signing in to Claude in your browser.',
  });
  // Until the row is ready the panel always has the wait to show, never "not signed in" in between: the page stops
  // looking every 2 seconds once nothing waits.
  const seen = [];
  assert.ok(await until(async () => {
    const now = byId(await c.status(), 'claude');
    seen.push([now.signedIn, !!now.signingIn]);
    return now.ready;
  }));
  assert.ok(seen.every(([signedIn, waiting]) => waiting || signedIn === 'yes'), JSON.stringify(seen));
  a = byId(await c.status(), 'claude');
  assert.deepEqual(row(a), { signedIn: 'yes', ready: true, signingIn: null, actions: ['key', 'recheck'], sentence: 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.' });
  assert.equal(a.how, 'your Claude subscription');
  assert.deepEqual([c.agentSignInState('claude').phase, c.agentSignInState('claude').sentence], ['done', 'Claude Code is signed in.']);
  assert.equal(c.defaultAgent(), 'claude', 'new work can go to it at once');
  assert.ok(events.some((e) => e[0] === 'agents' && e[1].claude.ready === true), 'the engine heard that it is ready');
  assert.ok(logs.some((l) => /Claude Code is signing in in the browser: claude-fake\.mjs auth login --claudeai/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /Claude Code signed in, in the browser\./.test(l)), logs.join('\n'));
  // It ran as an agent's own program would, from the home folder, with nothing to read and no terminal to ask in.
  const calls = lines(log);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['auth', 'login', '--claudeai']);
  assert.equal(calls[0].stdin, 'null');
  assert.equal(calls[0].terminal, false);
  assert.equal(calls[0].cwd, process.env.HOME);
  assert.deepEqual(calls[0].env, { CLAUDECODE: false, WORKBENCH_CLAUDE_BIN: false, WORKBENCH_AGENT_ID: false, ANTHROPIC_API_KEY: false });
});

test('"Use your Anthropic Console account": claude auth login --console, and Claude Code is then on its Console key', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'ok', FAKE_CLAUDE_LOGIN_DELAY_MS: '200' });
  const { c } = makeConnect(t);
  const r = await c.agentSignIn('claude', { console: true });
  assert.equal(r.sentence, 'Finish signing in to your Anthropic Console account in your browser.');
  assert.equal(byId(await c.status(), 'claude').signingIn.sentence, 'Finish signing in to your Anthropic Console account in your browser.');
  assert.equal(c.agentSignInState('claude').console, true);
  assert.ok(await until(async () => byId(await c.status(), 'claude').ready));
  const a = byId(await c.status(), 'claude');
  assert.deepEqual([a.signedIn, a.how, a.sentence], ['yes', 'an API key', 'Claude Code 2.1.322 is ready, signed in with an API key.']);
  assert.deepEqual(lines(log).map((l) => l.argv), [['auth', 'login', '--console']]);
  // Codex has no Console account.
  await assert.rejects(c.agentSignIn('codex', { console: true }), { plain: true, why: 'action', status: 400, message: 'Codex has no Anthropic Console sign-in.' });
});

test('Sign in to Codex: codex login in the background, then ready with the ChatGPT account', async (t) => {
  const { log } = codexSignedOut(t, { FAKE_CODEX_SIGNIN: 'ok', FAKE_CODEX_SIGNIN_DELAY_MS: '300' });
  const { c } = makeConnect(t);
  let a = byId(await c.status(), 'codex');
  assert.deepEqual([a.signedIn, a.actions], ['no', ['signin', 'key', 'recheck']], 'no Console sign-in for Codex');
  const r = await c.agentSignIn('codex');
  assert.deepEqual([r.ok, r.waiting, r.sentence], [true, true, 'Finish signing in to ChatGPT in your browser.']);
  assert.equal(byId(await c.status(), 'codex').signingIn.sentence, 'Finish signing in to ChatGPT in your browser.');
  assert.ok(await until(async () => byId(await c.status(), 'codex').ready));
  a = byId(await c.status(), 'codex');
  assert.deepEqual([a.signedIn, a.how, a.signingIn], ['yes', 'your ChatGPT account', null]);
  const calls = lines(log).filter((l) => l.argv.length === 1 && l.argv[0] === 'login');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, 'ignored', 'standard input is /dev/null');
  assert.equal(calls[0].terminal, false);
  assert.equal(calls[0].cwd, process.env.HOME);
  assert.equal(calls[0].env.CLAUDECODE, false, 'Codex’s own environment, made as for an agent');
  assert.equal(calls[0].agentId, null, 'no agent id: this is not an agent');
});

test('the check notices the sign-in while the program still runs; the program then has a while to end, and is stopped', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'signed-in-stay', FAKE_CLAUDE_LOGIN_DELAY_MS: '150' });
  const { c } = makeConnect(t, { checkMs: 40 });
  await c.agentSignIn('claude');
  assert.ok(await until(async () => byId(await c.status(), 'claude').ready));
  assert.equal(c.agentSignInState('claude').phase, 'done');
  const [{ pid }] = lines(log);
  assert.ok(await gone(pid), 'stopped after 15 checks’ time');
  assert.equal(c.agentSignInState('claude').phase, 'done', 'stopping it changes nothing');
});

test('a sign-in that fails offers Terminal in the same status that ends the wait; Terminal then signs in, and the words come back', async (t) => {
  claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'fail', FAKE_CLAUDE_LOGIN_DELAY_MS: '100' });
  const { c, logs, terminals } = makeConnect(t);
  await c.agentSignIn('claude');
  let a;
  assert.ok(await until(async () => {
    a = byId(await c.status(), 'claude');
    return !a.signingIn;
  }));
  assert.deepEqual(row(a), { signedIn: 'no', ready: false, signingIn: null, actions: ['signin', 'signin-console', 'signin-terminal', 'key', 'recheck'], sentence: FALLBACK });
  const s = c.agentSignInState('claude');
  assert.deepEqual([s.phase, s.why, s.waiting, s.sentence, typeof s.endedAt], ['failed', 'exit', false, FALLBACK, 'number']);
  assert.ok(logs.some((l) => l.includes('the sign-in in the browser for Claude Code did not finish: its program exited with code 1. Its last words: Login failed: the sign-in was refused.')), logs.join('\n'));
  // "Sign in in Terminal": milestone 1's sign-in, the program's full path.
  assert.deepEqual(await c.agentAction('claude', 'signin'), { ok: true, opened: true, sentence: 'Terminal is open for you to sign in to Claude Code. When you are done, come back here.' });
  assert.deepEqual(terminals.at(-1), { title: 'Signing in to Claude Code', program: process.execPath, args: [CLAUDE_FAKE, 'auth', 'login'] });
  a = byId(await c.status(), 'claude');
  assert.equal(a.sentence, NOT_SIGNED_IN, 'the person took it to Terminal');
  assert.ok(a.actions.includes('signin-terminal'), 'to open Terminal again');
  // A new browser sign-in starts afresh.
  process.env.FAKE_CLAUDE_LOGIN = 'wait';
  await c.agentSignIn('claude');
  assert.deepEqual(byId(await c.status(), 'claude').actions, ['key', 'recheck']);
});

test('outside macOS the fallback says "a terminal", and Sign in in Terminal gives the command', async (t) => {
  claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'fail' });
  const { c, terminals } = makeConnect(t, { platform: 'linux' });
  await c.agentSignIn('claude');
  assert.ok(await until(() => c.agentSignInState('claude').phase === 'failed'));
  assert.equal(byId(await c.status(), 'claude').sentence, 'The sign-in in the browser did not finish. Sign in in a terminal instead.');
  const r = await c.agentAction('claude', 'signin');
  assert.equal(r.opened, false);
  assert.match(r.command, /claude-fake\.mjs'? auth login$/);
  assert.equal(terminals.length, 0);
});

test('a program that exits 0 while the agent still says it is signed out did not sign in', async (t) => {
  claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'ok-unsaved' });
  const { c, logs } = makeConnect(t);
  await c.agentSignIn('claude');
  assert.ok(await until(() => c.agentSignInState('claude').phase !== 'waiting'));
  assert.deepEqual([c.agentSignInState('claude').phase, c.agentSignInState('claude').why], ['failed', 'exit']);
  assert.equal(byId(await c.status(), 'claude').sentence, FALLBACK);
  assert.ok(logs.some((l) => l.includes('its program ended, but the agent still says it is not signed in')), logs.join('\n'));
});

test('a login that asks for something to be typed is stopped at once: Workbench never types or relays a code', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'paste' });
  const { c, logs } = makeConnect(t);
  const started = Date.now();
  await c.agentSignIn('claude');
  assert.ok(await until(() => c.agentSignInState('claude').phase !== 'waiting', 10_000));
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual([c.agentSignInState('claude').phase, c.agentSignInState('claude').why], ['failed', 'input']);
  const [{ pid }] = lines(log);
  assert.ok(await gone(pid));
  assert.equal(byId(await c.status(), 'claude').sentence, FALLBACK);
  // Stopped at the first line that asks: the prompt itself, or the line before it when the output came in pieces.
  assert.ok(logs.some((l) => /did not finish: its program asked for something to be typed\. Its last words: (?:Paste code here >|.*paste the code shown\.)$/.test(l)), logs.join('\n'));
  // Codex too.
  codexSignedOut(t, { FAKE_CODEX_SIGNIN: 'input' });
  await c.agentSignIn('codex');
  assert.ok(await until(() => c.agentSignInState('codex').phase !== 'waiting', 10_000));
  assert.deepEqual([c.agentSignInState('codex').phase, c.agentSignInState('codex').why], ['failed', 'input']);
});

test('a sign-in nobody finishes stops when its time is up', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'wait' });
  const { c, logs } = makeConnect(t, { timeoutMs: 1500 });
  await c.agentSignIn('claude');
  assert.ok(await until(() => c.agentSignInState('claude').phase !== 'waiting', 10_000));
  assert.deepEqual([c.agentSignInState('claude').phase, c.agentSignInState('claude').why], ['failed', 'timeout']);
  for (const { pid } of lines(log)) assert.ok(await gone(pid));
  assert.equal(byId(await c.status(), 'claude').sentence, FALLBACK);
  assert.ok(logs.some((l) => l.includes('did not finish: nobody finished it within 2 seconds')), logs.join('\n'));
});

test('Cancel stops the program; Terminal is offered, without the failure’s words; a second Cancel has nothing to stop', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'wait' });
  const { c } = makeConnect(t);
  await c.agentSignIn('claude');
  assert.ok(await until(() => lines(log).length === 1));
  assert.deepEqual(await c.cancelAgentSignIn('claude'), { ok: true, stopped: true, sentence: 'Workbench stopped the sign-in to Claude Code.' });
  assert.ok(await gone(lines(log)[0].pid));
  const a = byId(await c.status(), 'claude');
  assert.deepEqual(row(a), { signedIn: 'no', ready: false, signingIn: null, actions: ['signin', 'signin-console', 'signin-terminal', 'key', 'recheck'], sentence: NOT_SIGNED_IN });
  assert.deepEqual([c.agentSignInState('claude').phase, c.agentSignInState('claude').sentence], ['cancelled', 'Workbench stopped the sign-in to Claude Code.']);
  assert.deepEqual(await c.cancelAgentSignIn('claude'), { ok: true, stopped: false, sentence: 'No sign-in to Claude Code is under way.' });
  assert.deepEqual(await c.cancelAgentSignIn('codex'), { ok: true, stopped: false, sentence: 'No sign-in to Codex is under way.' });
  await assert.rejects(c.cancelAgentSignIn('gemini'), { why: 'agent', status: 404 });
});

test('a login program that ignores SIGTERM is killed after 2 seconds', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'stubborn' });
  const { c } = makeConnect(t);
  await c.agentSignIn('claude');
  assert.ok(await until(() => lines(log).length === 1)); // written once its SIGTERM handler is in place
  await c.cancelAgentSignIn('claude');
  const { pid } = lines(log)[0];
  await sleep(500);
  assert.equal(await gone(pid, 50), false, 'still there after SIGTERM');
  assert.ok(await gone(pid, 6000), 'gone after SIGKILL');
});

test('one at a time: quick presses start one program, and a press while one waits answers that one', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'wait' });
  const { c } = makeConnect(t);
  const [one, two] = await Promise.all([c.agentSignIn('claude'), c.agentSignIn('claude', { console: true })]);
  assert.deepEqual(one, two);
  const three = await c.agentSignIn('claude', { console: true });
  assert.deepEqual(three, one, 'the one under way, not a Console sign-in');
  assert.ok(await until(() => lines(log).length >= 1));
  await sleep(300);
  assert.equal(lines(log).length, 1);
});

test('Sign in in Terminal while a browser sign-in waits stops it first; it signs in the way the last browser sign-in did', async (t) => {
  const { log } = codexSignedOut(t, { FAKE_CODEX_SIGNIN: 'wait' });
  claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'fail' });
  const { c, terminals } = makeConnect(t);
  await c.agentSignIn('codex');
  assert.ok(await until(() => lines(log).some((l) => l.argv.length === 1)));
  await c.agentAction('codex', 'signin');
  assert.equal(c.agentSignInState('codex').phase, 'cancelled', 'Codex’s login listens on one port: one at a time');
  assert.ok(await gone(lines(log).find((l) => l.argv.length === 1).pid));
  assert.deepEqual(terminals.at(-1), { title: 'Signing in to Codex', program: process.execPath, args: [CODEX_FAKE, 'login'] });
  // A Console sign-in that did not finish goes on in Terminal as a Console sign-in, unless the page says otherwise.
  await c.agentSignIn('claude', { console: true });
  assert.ok(await until(() => c.agentSignInState('claude').phase === 'failed'));
  await c.agentAction('claude', 'signin');
  assert.deepEqual(terminals.at(-1).args, [CLAUDE_FAKE, 'auth', 'login', '--console']);
  await c.agentAction('claude', 'signin', { console: false });
  assert.deepEqual(terminals.at(-1).args, [CLAUDE_FAKE, 'auth', 'login']);
  await c.agentAction('claude', 'signin', { console: true });
  assert.deepEqual(terminals.at(-1).args, [CLAUDE_FAKE, 'auth', 'login', '--console']);
});

test('refused: an agent Workbench does not know, and one that is not installed; an agent already signed in may sign in again', async (t) => {
  const { c } = makeConnect(t);
  await assert.rejects(c.agentSignIn('gemini'), { plain: true, why: 'agent', status: 404 });
  await assert.rejects(c.agentSignIn('__proto__'), { why: 'agent' });
  assert.throws(() => c.agentSignInState('nobody'), { why: 'agent' });
  const empty = path.join(scratch(t), 'bin');
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  setEnv(t, { PATH: empty, WORKBENCH_CLAUDE_BIN: undefined, WORKBENCH_CODEX_BIN: undefined });
  const none = makeConnect(t);
  await assert.rejects(none.c.agentSignIn('claude'), { plain: true, why: 'not-installed', status: 409, message: 'Claude Code is not installed yet, so there is nothing to sign in to.' });
  await assert.rejects(none.c.agentSignIn('codex'), { why: 'not-installed', status: 409 });
});

test('an agent signed in already (another account): the checks do not count, only the program’s own exit', async (t) => {
  const { log } = claudeSignedOut(t, { FAKE_CLAUDE_AUTH: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}', FAKE_CLAUDE_LOGIN: 'wait' });
  const { c } = makeConnect(t, { checkMs: 30 });
  assert.equal(byId(await c.status(), 'claude').signedIn, 'yes');
  await c.agentSignIn('claude');
  assert.ok(await until(() => lines(log).length >= 1));
  await sleep(300);
  assert.equal(c.agentSignInState('claude').phase, 'waiting', 'signed in all along, so the check says nothing new');
  assert.equal(lines(log).length, 1);
});

// ------------------------------------------------------------------ the runner itself

test('SignIns: a program that cannot start fails at once, and a late exit or check changes nothing', async (t) => {
  const changes = [];
  const s = new SignIns({ checkEveryMs: 30 });
  s.on('change', (id, st) => changes.push([id, st.phase, st.why]));
  t.after(() => s.stopAll());
  const missing = path.join(scratch(t), 'no-such-program');
  s.start('x', { file: missing, args: [], env: process.env, cwd: process.env.HOME, label: 'X' });
  assert.ok(await until(() => s.state('x').phase !== 'waiting'));
  assert.deepEqual([s.state('x').phase, s.state('x').why], ['failed', 'start']);
  assert.deepEqual(changes, [['x', 'waiting', null], ['x', 'failed', 'start']]);
  // A check that throws is "cannot tell"; a cancel ends the sign-in once, however the program then exits.
  let asked = 0;
  s.start('y', {
    file: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 10000)'], env: process.env, cwd: process.env.HOME, label: 'Y',
    check: async () => { asked++; throw new Error('cannot tell'); },
  });
  assert.ok(await until(() => asked >= 2));
  assert.equal(s.state('y').phase, 'waiting');
  assert.equal(s.cancel('y'), true);
  assert.equal(s.cancel('y'), false);
  await sleep(500); // its program ends on SIGTERM meanwhile
  assert.deepEqual([s.state('y').phase, s.state('y').why], ['cancelled', 'cancel']);
});

test('SignIns: the sign-in ends when the program exits, even while something it started still holds its output', async (t) => {
  const s = new SignIns({ checkEveryMs: 1000 });
  t.after(() => s.stopAll());
  const pidFile = path.join(scratch(t), 'grandchild.pid');
  const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });"
    + " require('node:fs').writeFileSync(process.argv[1], String(c.pid)); process.exit(3);";
  const started = Date.now();
  s.start('z', { file: process.execPath, args: ['-e', script, pidFile], env: process.env, cwd: process.env.HOME, label: 'Z' });
  assert.ok(await until(() => s.state('z').phase !== 'waiting', 10_000));
  assert.ok(Date.now() - started < 10_000);
  assert.deepEqual([s.state('z').phase, s.state('z').why], ['failed', 'exit']);
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ }
});

test('SignIns: a program signed in before counts only by its exit 0, which needs no check', async (t) => {
  let asked = 0;
  const s = new SignIns({ checkEveryMs: 20 });
  t.after(() => s.stopAll());
  let confirmed = 0;
  s.start('w', {
    file: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 300)'], env: process.env, cwd: process.env.HOME, label: 'W',
    signedInBefore: true, check: async () => { asked++; return 'no'; }, whenSignedIn: async () => { confirmed++; },
  });
  assert.ok(await until(() => s.state('w').phase !== 'waiting'));
  assert.deepEqual([s.state('w').phase, asked, confirmed], ['done', 0, 1]);
});

// ------------------------------------------------------------------ the routes

/** A stand-in for src/core/connect.mjs: records calls, and answers as it is told. */
class FakeConnect extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.answers = {};
  }
  async status(o) { this.calls.push(['status', o]); return { agents: [], git: { installed: false, canInstall: true, sentence: GIT_MISSING_MAC }, ready: false }; }
  async agentAction(id, action, o) { this.calls.push(['agentAction', id, action, o]); return this.answers.agentAction || { ok: true, opened: true, sentence: 'Terminal is open for you to sign in to Claude Code. When you are done, come back here.' }; }
  async agentSignIn(id, o) {
    this.calls.push(['agentSignIn', id, o]);
    if (this.answers.refuse) throw this.answers.refuse;
    return this.answers.agentSignIn || { ok: true, waiting: true, since: 1, sentence: 'Finish signing in to Claude in your browser.' };
  }
  async cancelAgentSignIn(id) { this.calls.push(['cancelAgentSignIn', id]); return { ok: true, stopped: true, sentence: 'Workbench stopped the sign-in to Claude Code.' }; }
  async installGitTools() { this.calls.push(['installGitTools']); return this.answers.installGitTools || { ok: true, sentence: 'Apple’s installer is open. Follow its steps; when it has finished, git is ready.' }; }
  envFor() { return {}; }
  mask(t) { return t; }
}

const TOKEN = crypto.randomBytes(32).toString('hex');

/** A Workbench server with this connect service: { send(path, body, headers), get(path), close }. */
async function server(t, connect) {
  const store = new Store();
  const engine = { mode: 'live', repoInfo: { root: process.env.HOME }, snapshot: () => ({ mode: 'live', harnesses: {}, agents: [], machines: [] }) };
  const srv = createServer({ engine, store, token: TOKEN, connect, port: 0, rootDir: path.join(T, 'tmp'), options: { coalesceMs: 40, pingMs: 60_000 } });
  const { url } = await srv.listen();
  t.after(() => srv.close());
  const port = Number(new URL(url).port);
  const request = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Host: `127.0.0.1:${port}`, 'X-Workbench-Token': TOKEN, ...(data != null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
  return { send: (p, body, headers) => request('POST', p, body ?? {}, headers), get: (p, headers) => request('GET', p, null, headers) };
}

test('the routes: Sign in starts the browser sign-in ({ console }), or Terminal ({ terminal }); Cancel; Install git', async (t) => {
  const connect = new FakeConnect();
  const w = await server(t, connect);
  let r = await w.send('/api/connect/agents/claude/signin', {});
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual({ ...r.json, status: !!r.json.status }, { waiting: true, ok: true, sentence: 'Finish signing in to Claude in your browser.', status: true });
  await w.send('/api/connect/agents/claude/signin', { console: true });
  await w.send('/api/connect/agents/claude/signin', { console: 'yes' });
  r = await w.send('/api/connect/agents/claude/signin', { terminal: true });
  assert.deepEqual({ opened: r.json.opened, command: r.json.command, sentence: r.json.sentence }, { opened: true, command: undefined, sentence: 'Terminal is open for you to sign in to Claude Code. When you are done, come back here.' });
  await w.send('/api/connect/agents/claude/signin', { terminal: true, console: true });
  connect.answers.agentAction = { ok: true, opened: false, command: 'claude auth login', sentence: 'Run this command in a terminal to sign in to Claude Code, then check again.' };
  r = await w.send('/api/connect/agents/codex/signin', { terminal: true });
  assert.deepEqual([r.json.opened, r.json.command], [false, 'claude auth login']);
  r = await w.send('/api/connect/agents/claude/signin/cancel', {});
  assert.deepEqual([r.status, r.json.ok, r.json.sentence], [200, true, 'Workbench stopped the sign-in to Claude Code.']);
  r = await w.send('/api/connect/git/install', {});
  assert.deepEqual([r.status, r.json.ok, r.json.sentence, r.json.why], [200, true, 'Apple’s installer is open. Follow its steps; when it has finished, git is ready.', undefined]);
  assert.deepEqual(r.json.status.git, { installed: false, canInstall: true, sentence: GIT_MISSING_MAC });
  connect.answers.installGitTools = { ok: false, why: 'platform', sentence: GIT_MISSING_ELSEWHERE };
  r = await w.send('/api/connect/git/install', {});
  assert.deepEqual([r.status, r.json.ok, r.json.why, r.json.sentence], [200, false, 'platform', GIT_MISSING_ELSEWHERE]);
  connect.answers.agentSignIn = { ok: false, waiting: false, why: 'start', sentence: FALLBACK };
  r = await w.send('/api/connect/agents/claude/signin', {});
  assert.deepEqual([r.status, r.json.ok, r.json.waiting, r.json.why, r.json.sentence], [200, false, false, 'start', FALLBACK]);
  assert.deepEqual(connect.calls.filter((c) => c[0] !== 'status'), [
    ['agentSignIn', 'claude', { console: false }],
    ['agentSignIn', 'claude', { console: true }],
    ['agentSignIn', 'claude', { console: false }],
    ['agentAction', 'claude', 'signin', {}],
    ['agentAction', 'claude', 'signin', { console: true }],
    ['agentAction', 'codex', 'signin', {}],
    ['cancelAgentSignIn', 'claude'],
    ['installGitTools'],
    ['installGitTools'],
    ['agentSignIn', 'claude', { console: false }],
  ]);
  // A refusal is its own sentence and status.
  connect.answers.refuse = Object.assign(new Error('Claude Code is not installed yet, so there is nothing to sign in to.'), { plain: true, why: 'not-installed', status: 409 });
  r = await w.send('/api/connect/agents/claude/signin', {});
  assert.deepEqual([r.status, r.json.error], [409, 'Claude Code is not installed yet, so there is nothing to sign in to.']);
});

test('the new routes check what every Agents & keys route checks: the token, the method, the origin, JSON, 16 KB, the id', async (t) => {
  const connect = new FakeConnect();
  const w = await server(t, connect);
  for (const p of ['/api/connect/agents/claude/signin', '/api/connect/agents/claude/signin/cancel', '/api/connect/git/install']) {
    assert.equal((await w.send(p, {}, { 'X-Workbench-Token': 'wrong' })).status, 401, p);
    assert.equal((await w.send(p, {}, { Origin: 'http://evil.example' })).status, 403, p);
    assert.equal((await w.send(p, '{"a":1}', { 'Content-Type': 'text/plain' })).status, 415, p);
    assert.equal((await w.send(p, { pad: 'x'.repeat(17 * 1024) })).status, 413, p);
    const wrong = await w.get(p);
    assert.deepEqual([wrong.status, wrong.headers.allow], [405, 'POST'], p);
  }
  for (const p of ['/api/connect/agents/Claude/signin', '/api/connect/agents/a%2Fb/signin/cancel', '/api/connect/agents/claude/signin/stop', '/api/connect/git/uninstall']) {
    assert.equal((await w.send(p, {})).status, 404, p);
  }
  assert.deepEqual(connect.calls.filter((c) => c[0] !== 'status'), []);
});

test('through the server with the real connect service: Sign in, the status the page re-reads while it waits, then ready', async (t) => {
  claudeSignedOut(t, { FAKE_CLAUDE_LOGIN: 'ok', FAKE_CLAUDE_LOGIN_DELAY_MS: '300' });
  const { c } = makeConnect(t);
  const w = await server(t, c);
  const r = await w.send('/api/connect/agents/claude/signin', {});
  assert.deepEqual([r.status, r.json.ok, r.json.waiting, r.json.sentence], [200, true, true, 'Finish signing in to Claude in your browser.']);
  assert.equal(byId(r.json.status, 'claude').signingIn.sentence, 'Finish signing in to Claude in your browser.');
  assert.ok(await until(async () => byId((await w.get('/api/connect')).json.status, 'claude').ready));
  const a = byId((await w.get('/api/connect')).json.status, 'claude');
  assert.deepEqual([a.signingIn, a.sentence], [null, 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.']);
});

// ------------------------------------------------------------------ git itself

/** A git() stand-in in workspace.mjs's shape: records each call, answers `version` or fails as git missing would. */
function fakeGit(version = '2.54.0') {
  const calls = [];
  const git = async (args, o) => {
    calls.push([args, o]);
    if (!version) throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
    return { stdout: `git version ${version} (Apple Git-157)\n`, stderr: '', code: 0 };
  };
  return { git, calls };
}

/** xcode-select as a stand-in: `-p` answers `found` (else exit 2, or ENOENT when `found` is null), `--install` exits `install`. */
function xcodeSelect({ found = true, install = 0 } = {}) {
  const calls = [];
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (found === null) return { code: null, stdout: '', stderr: '', timedOut: false, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
    if (args[0] === '-p') return found ? { code: 0, stdout: '/Library/Developer/CommandLineTools\n', stderr: '', timedOut: false, error: null } : { code: 2, stdout: '', stderr: 'xcode-select: error: unable to get active developer directory', timedOut: false, error: null };
    if (args[0] === '--install') return { code: install, stdout: '', stderr: install ? 'xcode-select: error: command line tools are already installed' : 'xcode-select: note: install requested for command line developer tools', timedOut: false, error: null };
    return { code: 1, stdout: '', stderr: '', timedOut: false, error: null };
  };
  return { run, calls };
}

test('gitPresence: on a Mac, Apple’s git runs only once xcode-select finds the developer tools; elsewhere git --version', async (t) => {
  const empty = path.join(scratch(t), 'empty');
  fs.mkdirSync(empty);
  const homebrew = path.join(scratch(t), 'homebrew');
  fs.mkdirSync(homebrew);
  fs.writeFileSync(path.join(homebrew, 'git'), '#!/bin/sh\necho "git version 2.99.0"\n', { mode: 0o755 });
  // Apple's git (or none) on the PATH, and no developer tools: missing, Install offered, and git never runs.
  for (const PATH of ['/usr/bin', empty]) {
    const x = xcodeSelect({ found: false });
    const g = fakeGit();
    assert.deepEqual(await gitPresence({ platform: 'darwin', env: { PATH }, run: x.run, runGit: g.git }),
      { installed: false, canInstall: true, version: null, sentence: GIT_MISSING_MAC }, PATH);
    assert.deepEqual(x.calls, [['/usr/bin/xcode-select', '-p']]);
    assert.equal(g.calls.length, 0, 'Apple’s stand-in git would open its installer');
  }
  // The developer tools are there: git is asked, within 5 seconds.
  let x = xcodeSelect({ found: true });
  let g = fakeGit('2.54.0');
  assert.deepEqual(await gitPresence({ platform: 'darwin', env: { PATH: '/usr/bin' }, run: x.run, runGit: g.git, cwd: T }),
    { installed: true, canInstall: false, version: '2.54.0', sentence: 'Git 2.54.0 is installed.' });
  assert.deepEqual(g.calls, [[['--version'], { cwd: T, timeout: 5000 }]]);
  // Another git first on the PATH (Homebrew's) is asked directly.
  x = xcodeSelect({ found: false });
  g = fakeGit('2.99.0');
  assert.equal((await gitPresence({ platform: 'darwin', env: { PATH: `${homebrew}:/usr/bin` }, run: x.run, runGit: g.git })).installed, true);
  assert.deepEqual(x.calls, []);
  // No xcode-select at all (not a Mac after all): git is asked.
  x = xcodeSelect({ found: null });
  g = fakeGit(null);
  assert.deepEqual(await gitPresence({ platform: 'darwin', env: { PATH: '/usr/bin' }, run: x.run, runGit: g.git }), { installed: false, canInstall: true, version: null, sentence: GIT_MISSING_MAC });
  assert.equal(g.calls.length, 1);
  // Elsewhere: git --version alone, and no Install button.
  x = xcodeSelect();
  g = fakeGit(null);
  assert.deepEqual(await gitPresence({ platform: 'linux', env: { PATH: '/usr/bin' }, run: x.run, runGit: g.git }), { installed: false, canInstall: false, version: null, sentence: GIT_MISSING_ELSEWHERE });
  assert.deepEqual(x.calls, []);
  g = fakeGit('2.43.0');
  assert.deepEqual(await gitPresence({ platform: 'linux', env: { PATH: '/usr/bin' }, run: x.run, runGit: g.git }), { installed: true, canInstall: false, version: '2.43.0', sentence: 'Git 2.43.0 is installed.' });
  // A workspace stand-in without git(): git counts as installed, and nothing runs.
  assert.equal((await gitPresence({ platform: 'darwin', env: { PATH: empty }, run: x.run, runGit: null })).installed, true);
  assert.deepEqual(x.calls, []);
});

test('Agents & keys without git: the panel says so, asks git nothing, refuses a name and email, and Install opens Apple’s installer', async (t) => {
  const asked = [];
  const g = fakeGit(null);
  const workspace = {
    git: g.git,
    async gitConfigIdentity() { asked.push('gitConfigIdentity'); return { name: '', email: '' }; },
    async setGitIdentity() { asked.push('setGitIdentity'); return { name: 'Ada', email: 'ada@example.org' }; },
  };
  const x = xcodeSelect({ found: false, install: 0 });
  setEnv(t, { PATH: `/usr/bin:${process.env.PATH}` });
  const { c, programs, logs } = makeConnect(t, { workspace, runProgram: x.run });
  const s = await c.status();
  assert.deepEqual(s.git, { name: '', email: '', installed: false, canInstall: true, sentence: GIT_MISSING_MAC });
  assert.deepEqual(asked, [], 'git is not asked for a name and email');
  await assert.rejects(c.setGitIdentity({ name: 'Ada', email: 'ada@example.org' }), { plain: true, why: 'git-missing', status: 409, message: GIT_MISSING_MAC });
  // Install: Apple's own installer, an argument array.
  assert.deepEqual(await c.installGitTools(), { ok: true, sentence: 'Apple’s installer is open. Follow its steps; when it has finished, git is ready.' });
  assert.deepEqual(programs.at(-1), ['/usr/bin/xcode-select', '--install']);
  assert.ok(logs.some((l) => /Apple’s installer for its developer tools \(and git\) was opened/.test(l)));
  // When it cannot be opened, and git is still missing: said plainly, xcode-select's words in the log only.
  const failing = xcodeSelect({ found: false, install: 1 });
  const two = makeConnect(t, { workspace, runProgram: failing.run });
  const r = await two.c.installGitTools();
  assert.deepEqual(r, { ok: false, why: 'install', sentence: 'Workbench could not open Apple’s installer. Run xcode-select --install in Terminal, then check again.' });
  assert.ok(two.logs.some((l) => l.includes('Apple’s installer could not be opened (exit 1): xcode-select: error: command line tools are already installed')), two.logs.join('\n'));
  assert.ok(!JSON.stringify(r).includes('xcode-select: error'));
});

test('Agents & keys with git: status reads the name and email, Install has nothing to do, and a found git is trusted a minute', async (t) => {
  const g = fakeGit('2.54.0');
  const workspace = { git: g.git, async gitConfigIdentity() { return { name: 'Ada Lovelace', email: 'ada@example.org' }; } };
  const x = xcodeSelect({ found: true });
  setEnv(t, { PATH: `/usr/bin:${process.env.PATH}` });
  const { c, programs } = makeConnect(t, { workspace, runProgram: x.run });
  assert.deepEqual((await c.status()).git, { name: 'Ada Lovelace', email: 'ada@example.org', installed: true, canInstall: false, sentence: 'Git knows you as Ada Lovelace, ada@example.org.' });
  await c.status();
  await c.status();
  assert.equal(g.calls.length, 1, 'once a minute at most while git is there');
  assert.deepEqual(await c.installGitTools(), { ok: true, sentence: 'Git is installed already.' });
  assert.ok(!programs.some((p) => p.includes('--install')), 'nothing to install');
  // Missing git is looked for again each time, so Install's end shows at once.
  const missing = fakeGit(null);
  const later = makeConnect(t, { workspace: { ...workspace, git: missing.git }, runProgram: xcodeSelect({ found: true }).run });
  await later.c.status();
  await later.c.status();
  assert.equal(missing.calls.length, 2);
  // Elsewhere than macOS: no Install, the sentence that says how.
  const linux = makeConnect(t, { platform: 'linux', workspace: { ...workspace, git: missing.git } });
  assert.deepEqual((await linux.c.status()).git, { name: '', email: '', installed: false, canInstall: false, sentence: GIT_MISSING_ELSEWHERE });
  assert.deepEqual(await linux.c.installGitTools(), { ok: false, why: 'platform', sentence: GIT_MISSING_ELSEWHERE });
  assert.deepEqual(linux.programs, []);
});

// ------------------------------------------------------------------ the CLI's --git-status

test('--git-status: its own way of running, and one WORKBENCH_GIT line from the check', async () => {
  assert.deepEqual((({ gitStatus, error }) => ({ gitStatus, error }))(parseArgs(['--git-status'])), { gitStatus: true, error: null });
  assert.equal(parseArgs(['--git-status', '--verbose']).error, null);
  for (const more of [['--demo'], ['--repo', '/tmp/x'], ['--clone', 'https://github.com/o/r'], ['--connect-github'], ['--github-repos']]) {
    assert.equal(parseArgs(['--git-status', ...more]).error, '--git-status runs on its own, without --demo, --repo, --clone or the GitHub helpers.', more.join(' '));
  }
  assert.equal(parseArgs(['--demo']).gitStatus, undefined);
  const out = [];
  assert.equal(await gitStatusMode({ presence: async () => ({ installed: false, canInstall: true, version: null, sentence: GIT_MISSING_MAC }), say: (l) => out.push(l) }), 0);
  assert.equal(await gitStatusMode({ presence: async () => ({ installed: true, canInstall: false, version: '2.54.0', sentence: 'Git 2.54.0 is installed.' }), say: (l) => out.push(l) }), 0);
  const warned = [];
  assert.equal(await gitStatusMode({ presence: async () => { throw new Error('boom'); }, say: (l) => out.push(l), log: { warn: (...a) => warned.push(a) } }), 0);
  assert.equal(await gitStatusMode({ presence: null, say: (l) => out.push(l) }), 0);
  const cannot = 'WORKBENCH_GIT {"installed":false,"canInstall":false,"sentence":"Workbench could not check whether git is installed. The details are in its log."}';
  assert.deepEqual(out, [
    `WORKBENCH_GIT {"installed":false,"canInstall":true,"sentence":"${GIT_MISSING_MAC}"}`,
    'WORKBENCH_GIT {"installed":true,"canInstall":false,"sentence":"Git 2.54.0 is installed."}',
    cannot,
    cannot,
  ]);
  assert.equal(warned.length, 1);
});

/** Run the CLI as a program. */
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 20_000, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('--git-status, run as a program, asks the git on the PATH and prints one line; inside an agent it is refused', async (t) => {
  const dir = scratch(t);
  const good = path.join(dir, 'good');
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(good);
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(good, 'git'), '#!/bin/sh\necho "git version 2.99.1"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(broken, 'git'), '#!/bin/sh\necho "git: no" >&2\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, HOME: path.join(dir), WORKBENCH_AGENT_ID: undefined };
  delete env.WORKBENCH_AGENT_ID;
  let r = await run(['--git-status'], { ...env, PATH: `${good}:/usr/bin:/bin` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['WORKBENCH_GIT {"installed":true,"canInstall":false,"sentence":"Git 2.99.1 is installed."}']);
  r = await run(['--git-status'], { ...env, PATH: `${broken}:/usr/bin:/bin` });
  assert.equal(r.code, 0, r.stderr);
  const mac = process.platform === 'darwin';
  assert.deepEqual(JSON.parse(r.stdout.trim().replace(/^WORKBENCH_GIT /, '')), { installed: false, canInstall: mac, sentence: mac ? GIT_MISSING_MAC : GIT_MISSING_ELSEWHERE });
  assert.ok(!r.stdout.includes('git: no') && !r.stderr.includes('git: no'), 'git’s own words are not printed');
  r = await run(['--git-status'], { ...env, PATH: `${good}:/usr/bin:/bin`, WORKBENCH_AGENT_ID: 'abc123' });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.trim(), INSIDE_AGENT);
});
