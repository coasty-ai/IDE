// The engine with Connect (milestone 1): the person's keys for agents and checks, hiding them in everything the engine
// keeps or shows, agents found later (setHarnesses), the default agent, typed keys refused, and the snapshot's
// `connect`. Connect itself is a stand-in here; src/core/connect.mjs has its own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.mjs';
import { Store } from '../src/core/store.mjs';
import * as historyMod from '../src/core/history.mjs';
import { EV } from '../src/shared/events.mjs';
import { describeRequest } from '../src/shared/narrate.mjs';
import { looksLikeSecret } from '../src/shared/secretshape.mjs';
import { FakeMachines, FakeSim, fakeAdapter, fakeDeps, gate, until, FAKE_BASE } from './helpers/engine-fakes.mjs';

const REPO = { root: '/repos/shop', name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 0 };
const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', tokenFor: (id) => `tok-${id}` };
const NO_AGENT = 'No coding agent is ready yet. Connect one in Agents & keys.';
const SECRET = 'That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe.';
const HELP = 'Say what to work on, like “fix the login bug”. Or ask “what needs me”, or “stop everything”. Agents & keys sets up agents.';

/** A made-up key in a shape the secret check knows (sk-ant-…), built from parts so no scanner takes it for a real one. */
const typedKey = () => ['sk', 'ant', 'api03', `${'x'.repeat(24)}Q7Zd`].join('-');
/** A made-up stored value an agent might print: not shaped like any key, so only the mask can find it. */
const storedValue = () => ['stored', 'v'.repeat(20), 'K9Q2'].join('-');
/** A made-up stored password the person might type: words and digits joined by dashes, which no key's shape matches. */
const passphrase = () => ['maple', 'river', 'stone', 'cloud', '4817'].join('-');
/** Codex as Connect's 'agents' event gives it when it runs but says it is not signed in. */
const CODEX_SIGNED_OUT = Object.freeze({
  ok: false, ready: false, found: true, signedIn: 'no', how: null, version: '0.166.0', loggedIn: false,
  reason: 'Codex 0.166.0 is installed but not signed in.',
});

/** Connect, as the engine sees it: envFor, mask, defaultAgent, and its 'changed' event. */
class FakeConnect extends EventEmitter {
  constructor({ env = {}, values = [], def = undefined } = {}) {
    super();
    this.env = env;
    this.values = values;
    this.def = def;
    this.envCalls = [];
  }
  envFor(o) {
    this.envCalls.push(o);
    return typeof this.env === 'function' ? this.env(o) : { ...this.env };
  }
  mask(text) {
    let out = String(text);
    for (const v of this.values) out = out.split(v).join(`•••• ${v.slice(-4)}`);
    return out;
  }
  defaultAgent() {
    return this.def;
  }
}

/** A live engine with stand-in adapters and deps. Call engine.shutdown() at the end. */
function live({ connect = null, adapters = null, deps: depOpts = {}, logPath = null, log = null, history = null, options = {}, repo = REPO } = {}) {
  const store = new Store(logPath ? { logPath } : {});
  const claude = adapters ? adapters.claude : fakeAdapter('claude');
  const codex = adapters ? adapters.codex : fakeAdapter('codex');
  const { deps, calls } = fakeDeps(depOpts);
  if (history) deps.history = history;
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({
    store, mode: 'live', repo, hook: HOOK, defaultBudgetUsd: 2,
    adapters: adapters || { claude, codex }, machines: new FakeMachines(), deps, connect, log,
    options: { permissionTimeoutMs: 5000, tickMs: 10_000_000, helperWaitMs: 60, exitGraceMs: 20, ...options },
  });
  return { store, engine, claude, codex, deps, calls, notices, connect };
}

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-engine-connect-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The meta the snapshot carries, as { ready, defaultAgent, agents } with each agent's readiness. */
const meta = (engine) => engine.snapshot().connect;

// ------------------------------------------------------------------ the default agent

test('without Connect, new work goes to the first agent that is ready, Claude Code first: on a Codex-only computer, Codex', async () => {
  const codex = fakeAdapter('codex');
  const t = live({ adapters: { codex } });
  await t.engine.start();
  t.deps.commands.intent = { kind: 'task', task: 'fix the login bug' };
  const card = await t.engine.command('fix the login bug');
  assert.equal(card.reply, 'Start Codex on “fix the login bug”?');
  assert.equal(card.openConnect, undefined);
  const v = await t.engine.startAgent({ task: 'Fix the cart total' });
  assert.equal(v.harness, 'codex');
  assert.equal(codex.runners.length, 1);
  assert.equal(meta(t.engine), undefined, 'no Agents & keys without Connect: the page shows the board as before');
  await t.engine.shutdown();

  const both = live();
  await both.engine.start();
  assert.equal((await both.engine.startAgent({ task: 'Fix the cart total' })).harness, 'claude');
  await both.engine.shutdown();
});

test('with no agent ready, a start says so and opens Agents & keys', async () => {
  const claude = fakeAdapter('claude', { available: { ok: false, reason: 'Claude Code was not found.' } });
  const codex = fakeAdapter('codex', { available: { ok: true, version: '0.166.0', loggedIn: false, reason: 'Codex says it is not signed in.' } });
  const t = live({ adapters: { claude, codex } });
  await t.engine.start();
  t.deps.commands.intent = { kind: 'task', task: 'fix the login bug' };
  assert.deepEqual(await t.engine.command('fix the login bug'), { reply: NO_AGENT, openConnect: true });
  t.deps.commands.intent = { kind: 'start', task: null };
  assert.deepEqual(await t.engine.command('start an agent'), { reply: NO_AGENT, openConnect: true });
  assert.ok(t.notices.includes(NO_AGENT));
  await assert.rejects(t.engine.startAgent({ task: 'Fix the cart total' }), { message: NO_AGENT });
  assert.equal(t.store.list().length, 0, 'nothing was made');
  // Naming an agent still wins: Codex runs, though it says it is not signed in (it may have another way in).
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'codex' }] };
  assert.equal((await t.engine.command('codex fix the docs')).reply, 'Start Codex on “fix the docs”?');
  // One that cannot run here says so, and opens Agents & keys too.
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'claude' }] };
  assert.deepEqual(await t.engine.command('claude fix the docs'), {
    reply: 'Claude Code is not available on this computer. Connect it in Agents & keys.', openConnect: true,
  });
  // An agent that went away between the card and the yes: the yes says so, and opens Agents & keys.
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'codex' }] };
  const card = await t.engine.command('codex fix the docs');
  t.engine.setHarnesses({ codex: { ok: false, reason: 'Codex is not installed.' } });
  const yes = await t.engine.confirm(card.confirm.id, true);
  assert.equal(yes.reply, 'I could not start the agent for “fix the docs”: Codex is not available on this computer.');
  assert.equal(yes.openConnect, true);
  await t.engine.shutdown();
});

test('with Connect, new work goes to its default agent; naming one still wins; when Connect says none is ready, none is', async () => {
  const connect = new FakeConnect({ def: 'codex' });
  const t = live({ connect });
  await t.engine.start();
  t.deps.commands.intent = { kind: 'task', task: 'fix the login bug' };
  assert.equal((await t.engine.command('fix the login bug')).reply, 'Start Codex on “fix the login bug”?');
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the login bug', harness: 'claude' }] };
  assert.equal((await t.engine.command('claude fix the login bug')).reply, 'Start Claude Code on “fix the login bug”?');
  assert.equal((await t.engine.startAgent({ task: 'Fix the cart total' })).harness, 'codex');
  assert.deepEqual(meta(t.engine).agents.map(a => [a.id, a.ready]), [['claude', true], ['codex', true]]);

  connect.def = null;
  t.deps.commands.intent = { kind: 'task', task: 'fix the login bug' };
  assert.deepEqual(await t.engine.command('fix the login bug'), { reply: NO_AGENT, openConnect: true });
  assert.deepEqual(meta(t.engine), {
    ready: false, defaultAgent: null,
    agents: [{ id: 'claude', name: 'Claude Code', ready: false }, { id: 'codex', name: 'Codex', ready: false }],
  });
  // An agent this engine has no adapter for, or one it does not know: the first one it can start.
  connect.def = 'gemini';
  assert.equal(meta(t.engine).defaultAgent, 'claude');
  await t.engine.shutdown();

  const only = live({ connect: new FakeConnect({ def: 'codex' }), adapters: { claude: fakeAdapter('claude') } });
  await only.engine.start();
  assert.equal(meta(only.engine).defaultAgent, 'claude');
  await only.engine.shutdown();
});

test('the demo’s agents are simulated: Connect is not asked, and the snapshot has no Agents & keys', async () => {
  const connect = new FakeConnect({ def: null });
  const store = new Store();
  const engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim: new FakeSim() }, machines: new FakeMachines({ demo: true }), deps: fakeDeps().deps, connect, options: { tickMs: 10_000_000, simTickMs: 10_000_000 } });
  await engine.start();
  assert.equal(engine.snapshot().connect, undefined);
  assert.equal(engine.setHarnesses({ claude: { ok: false } }), false, 'nothing to set in the demo');
  assert.equal((await engine.startAgent({ task: 'Fix the onboarding copy' })).harness, 'claude');
  await engine.shutdown();
});

// ------------------------------------------------------------------ agents found later

test('setHarnesses: an agent connected later can start, running agents are untouched, and the snapshot follows', async () => {
  const claude = fakeAdapter('claude', { available: { ok: false, reason: 'Claude Code was not found.' } });
  const codex = fakeAdapter('codex');
  // Connect cannot say which is the default here, so the engine's own rule picks: the first ready agent.
  const t = live({ adapters: { claude, codex }, connect: new FakeConnect() });
  await t.engine.start();
  assert.deepEqual(meta(t.engine), {
    ready: true, defaultAgent: 'codex',
    agents: [{ id: 'claude', name: 'Claude Code', ready: false }, { id: 'codex', name: 'Codex', ready: true }],
  });
  const running = await t.engine.startAgent({ task: 'Fix the docs' });
  assert.equal(running.harness, 'codex');

  // Claude Code is installed and signed in; Codex is gone. What else Connect knows (an account) is not kept.
  assert.equal(t.engine.setHarnesses({
    claude: { ok: true, version: '2.1.322', path: '/opt/claude', from: 'path', email: 'someone@example.invalid', organization: 'Org' },
    codex: { ok: false, reason: 'Codex is not installed.' },
  }), true);
  assert.deepEqual(t.engine.snapshot().harnessInfo.claude, { ok: true, version: '2.1.322', path: '/opt/claude', from: 'path' });
  assert.deepEqual(meta(t.engine), {
    ready: true, defaultAgent: 'claude',
    agents: [{ id: 'claude', name: 'Claude Code', ready: true }, { id: 'codex', name: 'Codex', ready: false }],
  });
  assert.deepEqual(t.engine.snapshot().harnesses, { claude: true, codex: false, sim: false });
  assert.equal((await t.engine.startAgent({ task: 'Fix the cart total' })).harness, 'claude');
  await assert.rejects(t.engine.startAgent({ task: 'Fix the tests', harness: 'codex' }), { message: 'Codex is not available on this computer.' });
  // The Codex agent that was running goes on as it was.
  assert.equal(codex.runners[0].stopCalls, 0);
  assert.equal(t.store.get(running.id).state, 'starting');
  // Signed out: still installed, but not ready for new work.
  t.engine.setHarnesses({ claude: { ok: true, version: '2.1.322', signedIn: 'no' } });
  assert.deepEqual(meta(t.engine), {
    ready: false, defaultAgent: null,
    agents: [{ id: 'claude', name: 'Claude Code', ready: false }, { id: 'codex', name: 'Codex', ready: false }],
  });
  await t.engine.shutdown();

  // With Connect's own default: the snapshot follows the person's choice as soon as Connect has it.
  const connect = new FakeConnect({ def: 'claude' });
  const c = live({ connect });
  await c.engine.start();
  assert.equal(meta(c.engine).defaultAgent, 'claude');
  connect.def = 'codex';
  assert.equal(meta(c.engine).defaultAgent, 'codex');
  await c.engine.shutdown();
});

test('what Connect said before or while the engine starts stands: the adapters’ older answer does not replace it', async () => {
  let asked = 0;
  const claude = fakeAdapter('claude');
  claude.available = async () => { asked += 1; return { ok: true, version: '1.0.0' }; };
  const t = live({ adapters: { claude, codex: fakeAdapter('codex') } });
  t.engine.setHarnesses({ claude: { ok: false, reason: 'Claude Code is not signed in.' }, codex: { ok: true } });
  await t.engine.start();
  assert.equal(asked, 0, 'not asked again');
  assert.equal(t.engine.snapshot().harnessInfo.claude.ok, false);
  t.deps.commands.intent = { kind: 'task', task: 'fix the login bug' };
  assert.equal((await t.engine.command('fix the login bug')).reply, 'Start Codex on “fix the login bug”?');
  await t.engine.shutdown();

  // An agent Connect said nothing of is still asked: no adapter is taken as ready untested.
  let askedClaude = 0;
  const partial = fakeAdapter('claude');
  partial.available = async () => { askedClaude += 1; return { ok: false, reason: 'Claude Code was not found.' }; };
  const p = live({ adapters: { claude: partial, codex: fakeAdapter('codex') } });
  p.engine.setHarnesses({ codex: { ok: true } });
  await p.engine.start();
  assert.equal(askedClaude, 1);
  assert.equal(p.engine.snapshot().harnessInfo.claude.ok, false);
  await p.engine.shutdown();

  const slow = gate();
  const late = fakeAdapter('claude');
  let asking = false;
  late.available = () => { asking = true; return slow.wait.then(() => ({ ok: true, version: '1.0.0' })); };
  const u = live({ adapters: { claude: late, codex: fakeAdapter('codex') } });
  const starting = u.engine.start();
  await until(() => asking);
  u.engine.setHarnesses({ claude: { ok: false, reason: 'Claude Code is not signed in.' } });
  slow.open();
  await starting;
  assert.equal(u.engine.snapshot().harnessInfo.claude.ok, false);
  await u.engine.shutdown();
});

test('an earlier agent can continue once its agent is connected, and the continued agent gets its keys', async (t) => {
  const dir = scratch(t);
  const folder = path.join(dir, 'fix-login-e1e1e1');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '.git'), 'gitdir: elsewhere\n');
  const rec = {
    id: 'e1e1e1', name: 'Fix login', task: 'fix the login', harness: 'claude', model: null, machineId: 'laptop',
    startedAt: 1000, endedAt: 2000, state: 'done_claimed', stateReason: null, says: 'Done.', files: null, checks: null,
    rules: null, approvals: {}, usage: {}, sessionId: 'session-1', budgetUsd: 2, turns: 1, toolCalls: 3, savedAt: 2000,
    workspace: { path: folder, branch: 'workbench/fix-login-e1e1e1', base: FAKE_BASE, since: FAKE_BASE, from: 'main' }, work: null,
  };
  const history = { open: () => ({ load: () => [{ ...rec }], source() {}, schedule() {}, close() {}, save() {}, recordOf: () => null }) };
  const connect = new FakeConnect({ env: { WB_TEST_SETTING: 'for-the-agent' } });
  const claude = fakeAdapter('claude', { available: { ok: false, reason: 'Claude Code was not found.' } });
  const e = live({ adapters: { claude, codex: fakeAdapter('codex') }, history, connect });
  await e.engine.start();
  assert.deepEqual([e.store.get('e1e1e1').canContinue, e.store.get('e1e1e1').continueReason], [false, 'Claude Code is not available on this computer.']);
  e.engine.setHarnesses({ claude: { ok: true, version: '2.1.322' } });
  assert.deepEqual([e.store.get('e1e1e1').canContinue, e.store.get('e1e1e1').continueReason], [true, null]);
  const out = await e.engine.say('e1e1e1', 'please go on');
  assert.equal(out.ok, true, out.reply);
  assert.deepEqual(claude.runners[0].opts.keysEnv, { WB_TEST_SETTING: 'for-the-agent' });
  assert.deepEqual(connect.envCalls.at(-1), { repoRoot: REPO.root, harness: 'claude' });
  await e.engine.shutdown();
});

// ------------------------------------------------------------------ words

test('“help” is answered with what to say, “connect” opens Agents & keys, and a start with no task asks what to work on', async () => {
  const t = live();
  t.deps.commands.intent = { kind: 'help' };
  assert.deepEqual(await t.engine.command('what can you do'), { reply: HELP });
  t.deps.commands.HELP_REPLY = 'The parser’s own words for help.'; // commands.mjs exports them: they win
  assert.deepEqual(await t.engine.command('help'), { reply: 'The parser’s own words for help.' });
  delete t.deps.commands.HELP_REPLY;
  t.deps.commands.intent = { kind: 'connect' };
  assert.deepEqual(await t.engine.command('add a key'), { reply: 'Opening Agents & keys.', openConnect: true });
  t.deps.commands.intent = { kind: 'start', task: null };
  assert.deepEqual(await t.engine.command('start an agent'), { reply: 'What should the agent work on?' });
  t.deps.commands.intent = { kind: 'start', task: 'fix the cart total' };
  assert.equal((await t.engine.command('start an agent on the cart total')).reply, 'Start Claude Code on “fix the cart total”?');
  t.deps.commands.intent = null;
  assert.match((await t.engine.command('blorp')).reply, /^I did not catch that\./, 'words not caught are still said so');
  await t.engine.shutdown();
});

test('“start codex” with no task keeps the agent it names: it asks what Codex should work on, or says why Codex cannot start', async () => {
  const codex = fakeAdapter('codex', { available: { ok: false, reason: 'Codex was not found.' } });
  const t = live({ adapters: { claude: fakeAdapter('claude'), codex } });
  await t.engine.start();
  const noTask = (harness) => ({ kind: 'start', tasks: [], task: null, harness });
  // Codex cannot run here: the same reply as work that names it, and Agents & keys opens. The follow-up never reaches
  // another agent, because nothing asked for one.
  t.deps.commands.intent = noTask('codex');
  assert.deepEqual(await t.engine.command('start codex'), { reply: 'Codex is not available on this computer. Connect it in Agents & keys.', openConnect: true });
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'codex' }] };
  assert.deepEqual(await t.engine.command('fix the docs with codex'), { reply: 'Codex is not available on this computer. Connect it in Agents & keys.', openConnect: true });
  // One that can run is asked about by name; no agent named, as before.
  t.deps.commands.intent = noTask('claude');
  assert.deepEqual(await t.engine.command('start claude'), { reply: 'What should Claude Code work on?' });
  t.deps.commands.intent = noTask(null);
  assert.deepEqual(await t.engine.command('start an agent'), { reply: 'What should the agent work on?' });
  // Signed out, as Connect says it: the same words as work that names it.
  t.engine.setHarnesses({ codex: CODEX_SIGNED_OUT });
  t.deps.commands.intent = noTask('codex');
  assert.deepEqual(await t.engine.command('use codex'), { reply: 'Codex 0.166.0 is installed but not signed in. Sign in in Agents & keys.', openConnect: true });
  // Signed in: asked about by name, even when Claude Code, the default, is gone meanwhile.
  t.engine.setHarnesses({ claude: { ok: false, reason: 'Claude Code is not installed.' }, codex: { ok: true, ready: true, found: true, signedIn: 'yes', how: 'your ChatGPT account', version: '0.166.0' } });
  assert.deepEqual(await t.engine.command('start codex'), { reply: 'What should Codex work on?' });
  t.deps.commands.intent = noTask('claude');
  assert.deepEqual(await t.engine.command('start claude'), { reply: 'Claude Code is not available on this computer. Connect it in Agents & keys.', openConnect: true });
  await t.engine.shutdown();
});

test('naming an agent that is installed but signed out says so, and where to sign in, instead of “not available”', async () => {
  const connect = new FakeConnect({ def: 'claude' });
  const t = live({ connect });
  await t.engine.start();
  t.engine.setHarnesses({ codex: CODEX_SIGNED_OUT });
  const SIGNED_OUT = 'Codex 0.166.0 is installed but not signed in. Sign in in Agents & keys.';
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'codex' }] };
  assert.deepEqual(await t.engine.command('fix the docs with codex'), { reply: SIGNED_OUT, openConnect: true });
  await assert.rejects(t.engine.startAgent({ task: 'Fix the docs', harness: 'codex' }), { message: SIGNED_OUT, openConnect: true });
  // Signed out between the card and the yes.
  t.engine.setHarnesses({ codex: { ok: true, ready: true, found: true, signedIn: 'yes', version: '0.166.0' } });
  const card = await t.engine.command('fix the docs with codex');
  assert.ok(card.confirm, card.reply);
  t.engine.setHarnesses({ codex: CODEX_SIGNED_OUT });
  const yes = await t.engine.confirm(card.confirm.id, true);
  assert.equal(yes.reply, `I could not start the agent for “fix the docs”: ${SIGNED_OUT}`);
  assert.equal(yes.openConnect, true);
  // Without a plain sentence of Connect's own about it, Workbench words it itself.
  t.engine.setHarnesses({ codex: { ...CODEX_SIGNED_OUT, reason: 'not signed in\nrun codex login' } });
  assert.equal((await t.engine.command('fix the docs with codex')).reply, 'Codex is installed but not signed in. Sign in in Agents & keys.');
  t.engine.setHarnesses({ codex: { ...CODEX_SIGNED_OUT, reason: undefined } });
  assert.equal((await t.engine.command('fix the docs with codex')).reply, 'Codex is installed but not signed in. Sign in in Agents & keys.');
  // A program that is not there, or does not run, is still not available on this computer.
  t.engine.setHarnesses({ codex: { ok: false, ready: false, found: false, signedIn: 'unknown', how: null, reason: 'Codex is not installed.' } });
  assert.deepEqual(await t.engine.command('fix the docs with codex'), { reply: 'Codex is not available on this computer. Connect it in Agents & keys.', openConnect: true });
  await assert.rejects(t.engine.startAgent({ task: 'Fix the docs', harness: 'codex' }), { message: 'Codex is not available on this computer.' });
  assert.equal(t.codex.runners.length, 0, 'Codex never started');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ typed keys

test('a key typed into the board is never sent, parsed, kept or logged, and Agents & keys opens', async (t) => {
  const dir = scratch(t);
  const logPath = path.join(dir, 'events.jsonl');
  const logs = [];
  const k = live({ logPath, log: (level, ...args) => logs.push([level, ...args.map(a => (a instanceof Error ? a.stack : String(a)))].join(' ')) });
  const key = typedKey();

  assert.deepEqual(await k.engine.command(`use ${key} for the api`), { reply: SECRET, openConnect: true });
  assert.equal(k.calls.parse.length, 0, 'not even read as words');
  assert.ok(k.notices.includes(SECRET));

  // A card on screen stays, and still takes its yes.
  k.deps.commands.intent = { kind: 'task', task: 'fix the cart total' };
  const card = await k.engine.command('fix the cart total');
  const again = await k.engine.command(key, { confirmId: card.confirm.id });
  assert.equal(again.reply, SECRET);
  assert.equal(again.openConnect, true);
  assert.equal(again.confirm.id, card.confirm.id);
  const yes = await k.engine.confirm(card.confirm.id, true);
  assert.match(yes.reply, /^Started /);

  // In the reply box: as a message, or as an answer.
  const [v] = k.store.list();
  const runner = k.claude.runners[0];
  assert.deepEqual(await k.engine.say(v.id, `here it is: ${key}`), { ok: false, reply: SECRET, openConnect: true });
  assert.deepEqual(await k.engine.answer(v.id, { answer: key }), { ok: false, reply: SECRET, openConnect: true });
  assert.deepEqual(runner.sent, [], 'nothing reached the agent');
  // As a task given straight to the launch.
  await assert.rejects(k.engine.startAgent({ task: `deploy with ${key}` }), { message: SECRET });
  assert.equal(k.store.list().length, 1, 'no agent was made for it');

  await k.engine.shutdown();
  k.store.close();
  await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(SECRET));
  const everything = [JSON.stringify(k.store.list()), fs.readFileSync(logPath, 'utf8'), logs.join('\n'), k.notices.join('\n')].join('\n');
  assert.ok(!everything.includes(key), 'the key is nowhere');
  assert.ok(!everything.includes(key.slice(-12)), 'not even in part');
});

test('text that holds a stored key’s value is refused like a key, though it has no key’s shape: no card, runner, branch or folder', async (t) => {
  const dir = scratch(t);
  const logPath = path.join(dir, 'events.jsonl');
  const logs = [];
  const value = passphrase();
  const words = `use ${value} to fix the staging login`;
  assert.equal(looksLikeSecret(words).secret, false, 'only the mask can find it');
  const connect = new FakeConnect({ def: 'claude' });
  const k = live({ connect, logPath, log: (level, ...args) => logs.push([level, ...args.map(a => (a instanceof Error ? a.stack : String(a)))].join(' ')) });
  await k.engine.start();
  const v = await k.engine.startAgent({ task: 'Fix the staging login' });
  const runner = k.claude.runners[0];

  // Before it is stored, the same words are work, or a message, and their cards quote them.
  k.deps.commands.intent = { kind: 'task', task: words };
  const before = await k.engine.command(words);
  assert.ok(before.confirm, before.reply);
  k.deps.commands.intent = { kind: 'say', agentId: v.id, text: `the password is ${value}`, sure: false };
  const tell = await k.engine.command(`tell it the password is ${value}`);
  assert.equal(tell.confirm?.kind, 'say', tell.reply);

  connect.values.push(value); // the person saves it in Agents & keys
  const parsed = k.calls.parse.length;
  assert.deepEqual(await k.engine.command(words), { reply: SECRET, openConnect: true });
  assert.equal(k.calls.parse.length, parsed, 'not even read as words');

  // The cards from before: their yes starts nothing and sends nothing, and the reply does not quote the words.
  const yes = await k.engine.confirm(before.confirm.id, true);
  assert.equal(yes.reply, SECRET);
  assert.equal(yes.openConnect, true);
  assert.deepEqual(await k.engine.confirm(tell.confirm.id, true), { reply: SECRET, openConnect: true });
  // Given straight to the launch, as the task or as the agent's name.
  await assert.rejects(k.engine.startAgent({ task: words }), { message: SECRET, openConnect: true });
  await assert.rejects(k.engine.startAgent({ task: 'Fix the staging login', name: value }), { message: SECRET, openConnect: true });
  assert.equal(k.claude.runners.length, 1, 'no runner got it');
  assert.equal(k.calls.createWorkspace.length, 1, 'no branch or folder was named after it');

  // In the reply box: as a message, or as an answer.
  assert.deepEqual(await k.engine.say(v.id, `the password is ${value}`), { ok: false, reply: SECRET, openConnect: true });
  assert.deepEqual(await k.engine.answer(v.id, { answer: value }), { ok: false, reply: SECRET, openConnect: true });
  assert.deepEqual(runner.sent, [], 'nothing reached the agent');

  await k.engine.shutdown();
  k.store.close();
  await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(SECRET));
  const everything = [JSON.stringify(k.store.list()), fs.readFileSync(logPath, 'utf8'), logs.join('\n'), k.notices.join('\n')].join('\n');
  assert.ok(!everything.includes(value), 'the value is nowhere');
});

// ------------------------------------------------------------------ text kept from before a key was stored

/** An earlier agent's history record whose words hold `value`, kept before it was stored as a key. */
const earlierRecord = (value) => ({
  id: 'e2e2e2', name: `Use ${value}`, task: `use ${value} to fix the staging login`, harness: 'claude', model: null, machineId: 'laptop',
  startedAt: 1000, endedAt: 2000, state: 'checks_failed', stateReason: `It printed ${value}`, says: `I signed in with ${value}.`,
  files: { changed: 1, adds: 1, dels: 0, list: [{ path: 'src/login.js', adds: 1, dels: 0 }] },
  checks: { state: 'failed', results: [{ name: `sign in with ${value}`, ok: false, ms: 5 }] },
  rules: { kept: [{ say: `Never print ${value}` }], broken: [{ say: `Keep ${value} out of the logs`, paths: [`notes/${value}.txt`] }] },
  approvals: { auto: 0, byYou: 1, denied: 0 }, usage: {}, sessionId: 'session-2', budgetUsd: 2, turns: 1, toolCalls: 3, savedAt: 2000,
  workspace: { path: '/wt/shop/use-e2e2e2', branch: 'workbench/use-e2e2e2', base: FAKE_BASE, since: FAKE_BASE, from: 'main' },
  work: {
    branch: 'workbench/use-e2e2e2', from: 'main', folder: true, merged: null, thrownAway: null,
    problem: { why: 'conflict', sentence: `It does not merge cleanly: ${value}`, paths: [`notes/${value}.txt`], into: 'main', at: 1500 },
  },
});

test('history restored at start is masked with the keys stored now, and goes back to the history file masked', async () => {
  const value = passphrase();
  const rec = earlierRecord(value);
  let source = null;
  let scheduled = 0;
  const history = {
    open: () => ({ load: () => [structuredClone(rec)], source(fn) { source = fn; }, schedule() { scheduled += 1; }, close() {}, save() {}, recordOf: () => null }),
  };
  const t = live({ connect: new FakeConnect({ values: [value], def: 'claude' }), history });
  await t.engine.start();
  const v = t.store.get('e2e2e2');
  assert.equal(v.earlier, true);
  assert.equal(v.name, 'Use •••• 4817');
  assert.equal(v.task, 'use •••• 4817 to fix the staging login');
  assert.equal(v.says, 'I signed in with •••• 4817.');
  assert.equal(v.stateReason, 'It printed •••• 4817');
  assert.deepEqual(v.checks.results.map(r => r.name), ['sign in with •••• 4817']);
  assert.deepEqual(v.rules, { kept: [{ say: 'Never print •••• 4817' }], broken: [{ say: 'Keep •••• 4817 out of the logs', paths: ['notes/•••• 4817.txt'] }] });
  assert.equal(v.work.problem.sentence, 'It does not merge cleanly: •••• 4817');
  assert.deepEqual(v.work.problem.paths, ['notes/•••• 4817.txt']);
  // Names of things stay as they are: its folder, its branch and its conversation.
  assert.equal(v.workspace, '/wt/shop/use-e2e2e2');
  assert.equal(v.work.branch, 'workbench/use-e2e2e2');
  assert.equal(v.sessionId, 'session-2');
  assert.ok(!JSON.stringify(t.engine.snapshot()).includes(value), 'the page never gets it');
  // What goes back to the history file is the masked record, and it is written again soon.
  const written = JSON.stringify(source());
  assert.ok(!written.includes(value), written);
  assert.ok(written.includes('•••• 4817'));
  assert.equal(JSON.parse(written)[0].workspace.branch, 'workbench/use-e2e2e2');
  assert.ok(scheduled >= 1, 'a write is scheduled');
  await t.engine.shutdown();

  // With nothing to hide, a record is restored as it was, and no write is scheduled for it.
  let plainScheduled = 0;
  const plain = { open: () => ({ load: () => [structuredClone(rec)], source() {}, schedule() { plainScheduled += 1; }, close() {}, save() {}, recordOf: () => null }) };
  const p = live({ connect: new FakeConnect({ def: 'claude' }), history: plain });
  await p.engine.start();
  assert.equal(p.store.get('e2e2e2').says, rec.says);
  assert.equal(plainScheduled, 0);
  await p.engine.shutdown();
});

test('the history file itself loses a key stored after it was written, at the next write', async (t) => {
  const dir = scratch(t);
  const value = passphrase();
  const repo = { ...REPO, root: path.join(dir, 'shop') }; // the history file is named after the real folder
  fs.mkdirSync(repo.root);
  const file = historyMod.historyFile(repo.root, { dir: path.join(dir, 'history') });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: historyMod.VERSION, repo: repo.root, agents: [earlierRecord(value)] }));
  const h = live({
    connect: new FakeConnect({ values: [value], def: 'claude' }), history: historyMod, repo,
    options: { historyDir: path.join(dir, 'history'), historyDebounceMs: 10_000 },
  });
  await h.engine.start();
  assert.equal(h.store.get('e2e2e2').says, 'I signed in with •••• 4817.');
  await h.engine.shutdown();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(value), 'no longer in the file');
  assert.equal(JSON.parse(text).agents[0].says, 'I signed in with •••• 4817.');
  assert.equal(JSON.parse(text).agents[0].workspace.branch, 'workbench/use-e2e2e2');
});

test('a merge’s commit message hides the stored keys, even in words the agent said before the key was saved', async (t) => {
  const dir = scratch(t);
  const value = passphrase();
  const connect = new FakeConnect({ def: 'claude' });
  const m = live({ connect, deps: { folders: dir } });
  await m.engine.start();
  const v = await m.engine.startAgent({ task: `rotate ${value} in the config. Then tell me.`, name: `Rotate ${value}` });
  const r = m.claude.runners[0];
  r.emit({ kind: EV.TURN, phase: 'start' });
  r.emit({ kind: EV.TURN, phase: 'end', finalText: `I rotated ${value} in the config.`, backgroundTasks: 0, isError: false });
  await until(() => !['working', 'starting'].includes(m.store.get(v.id).state));
  assert.ok(m.store.get(v.id).says.includes(value), 'said before the key was saved, so kept as it was said');
  connect.values.push(value); // the person saves it as a key now
  const card = await m.engine.proposeMerge(v.id);
  assert.ok(card.confirm, card.reply);
  await m.engine.confirm(card.confirm.id, true);
  const msg = m.calls.mergeWork.at(-1).message;
  assert.deepEqual(msg, { subject: 'Rotate •••• 4817 in the config', body: 'I rotated •••• 4817 in the config.', name: 'Rotate •••• 4817' });
  await m.engine.shutdown();
});

// ------------------------------------------------------------------ keys for agents and checks

test('the person’s keys reach each agent and the checks of its work; Workbench’s own variables are never among them', async () => {
  const value = storedValue();
  const connect = new FakeConnect({
    env: ({ harness }) => ({
      WB_TEST_KEY: value, AWS_REGION: 'eu-west-1', FOR: harness,
      WORKBENCH_AGENT_ID: 'another', WORKBENCH_HOOK_TOKEN: 'x', PATH: '/elsewhere', HOME: '/elsewhere', CLAUDE_CONFIG_DIR: '/c',
      'NOT A NAME': 'x', NUMBER: 5,
    }),
    values: [value],
    def: 'claude',
  });
  const t = live({ connect, deps: { checks: [{ name: 'Tests', run: 'npm test' }] } });
  const a = await t.engine.startAgent({ task: 'Fix the cart total' });
  const r = t.claude.runners[0];
  assert.deepEqual(r.opts.keysEnv, { WB_TEST_KEY: value, AWS_REGION: 'eu-west-1', FOR: 'claude' });
  assert.equal(r.opts.mask(`it is ${value}`), 'it is •••• K9Q2', 'the runner hides the stored keys in what it reads');
  assert.deepEqual(connect.envCalls[0], { repoRoot: REPO.root, harness: 'claude' });
  await t.engine.startAgent({ task: 'Fix the docs', harness: 'codex' });
  assert.equal(t.codex.runners[0].opts.keysEnv.FOR, 'codex', 'each agent gets the keys given to it');

  r.emit({ kind: EV.TURN, phase: 'start' });
  r.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart total.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1);
  const run = t.calls.runChecks[0];
  assert.deepEqual(run.keysEnv, { WB_TEST_KEY: value, AWS_REGION: 'eu-west-1', FOR: 'claude' });
  assert.equal(run.env.WORKBENCH_AGENT_ID, a.id);
  assert.equal(run.mask(value), '•••• K9Q2');
  await t.engine.shutdown();
});

test('without Connect, agents and checks get nothing new: no keys and no mask', async () => {
  const t = live({ deps: { checks: [{ name: 'Tests', run: 'npm test' }] } });
  await t.engine.startAgent({ task: 'Fix the cart total' });
  const r = t.claude.runners[0];
  assert.ok(!('keysEnv' in r.opts) && !('mask' in r.opts));
  r.emit({ kind: EV.TURN, phase: 'start' });
  r.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1);
  assert.ok(!('keysEnv' in t.calls.runChecks[0]) && !('mask' in t.calls.runChecks[0]));
  await t.engine.shutdown();
});

test('the stored keys are hidden in every event before the store: the page, the event log and listeners never see one', async (t) => {
  const dir = scratch(t);
  const logPath = path.join(dir, 'events.jsonl');
  const value = storedValue();
  // '/wt/shop' stands for a key that happens to be part of a folder's name: names of things are never masked.
  const connect = new FakeConnect({ values: [value, '/wt/shop'], def: 'claude' });
  const m = live({ connect, logPath });
  const heard = [];
  m.engine.on('event', e => heard.push(e));
  const v = await m.engine.startAgent({ task: 'Fix the cart total' });
  assert.match(v.workspace, /^\/wt\/shop\/fix-cart-total-/);
  const r = m.claude.runners[0];
  r.emit({ kind: EV.TURN, phase: 'start' });
  r.emit({ kind: EV.ACTIVITY, phase: 'start', toolUseId: 'tu1', toolKind: 'run', sentence: `Running export KEY=${value}`, input: `{"command":"export KEY=${value}"}` });
  r.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'tu1', ok: false, error: `bad key ${value}` });
  r.emit({ kind: EV.SAYS, text: `I used ${value} to sign in.` });

  // A permission: the policy judges the command as it is; the person sees it with the key hidden.
  const answer = m.engine.hookPreToolUse(v.id, { tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${value}" https://api.example.invalid` } });
  await until(() => m.store.get(v.id).ask?.type === 'permission');
  assert.ok(m.calls.decide.at(-1).input.command.includes(value), 'the policy saw the real command');
  const ask = m.store.get(v.id).ask;
  assert.equal(ask.detail, 'curl -H "Authorization: Bearer •••• K9Q2" https://api.example.invalid');
  await m.engine.answer(v.id, { askId: ask.id, answer: 'Deny' });
  await answer;

  r.emit({ kind: EV.TURN, phase: 'end', finalText: `Done with ${value}.`, backgroundTasks: 0, isError: false });
  await until(() => !['working', 'starting'].includes(m.store.get(v.id).state));
  const view = m.store.get(v.id);
  assert.match(view.workspace, /^\/wt\/shop\//, 'a folder is never masked');
  assert.match(view.work.branch, /^workbench\/fix-cart-total-/);
  assert.match(view.says, /•••• K9Q2/);
  await m.engine.shutdown();
  m.store.close();
  await until(() => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes('"done_claimed"'));
  for (const [what, text] of [['the store', JSON.stringify(m.store.list())], ['the listeners', JSON.stringify(heard)], ['the event log', fs.readFileSync(logPath, 'utf8')]]) {
    assert.ok(!text.includes(value), `no key in ${what}`);
    assert.ok(text.includes('•••• K9Q2'), `${what} shows where it was`);
  }
});

test('a permission’s detail is described with the keys hidden first, so a key the description cuts short never shows in part', async () => {
  const value = storedValue();
  const connect = new FakeConnect({ values: [value], def: 'claude' });
  const t = live({ connect });
  // As the real policy does: the detail of a tool it does not know is its input as JSON, cut at 300 characters.
  t.deps.policy.decide = (req) => {
    t.calls.decide.push(req);
    return { decision: 'ask', reason: 'Unknown tool.', sentence: 'wants to use db (query)', detail: describeRequest(req.tool, req.input).detail };
  };
  const v = await t.engine.startAgent({ task: 'Fix the cart total' });
  // The value starts at character 280 of the JSON, so the cut at 299 falls inside it.
  const input = { query: `${'x'.repeat(270)}${value}` };
  assert.ok(describeRequest('mcp__db__query', input).detail.includes(value.slice(0, 12)), 'the raw description holds part of it');
  const answer = t.engine.hookPreToolUse(v.id, { tool_name: 'mcp__db__query', tool_input: input });
  await until(() => t.store.get(v.id).ask?.type === 'permission');
  assert.equal(t.calls.decide.at(-1).input.query, input.query, 'the policy judged the input as it is');
  const ask = t.store.get(v.id).ask;
  assert.ok(ask.detail.endsWith('•••• K9Q2"}'), ask.detail.slice(-40));
  assert.ok(!ask.detail.includes(value.slice(0, 8)), 'no part of the value');
  await t.engine.answer(v.id, { askId: ask.id, answer: 'Deny' });
  await answer;
  await t.engine.shutdown();
});

test('a mask that fails hides nothing and stops nothing, and the warning never quotes the text', async () => {
  const connect = new FakeConnect({ def: 'claude' });
  connect.mask = () => { throw new Error('the mask broke on this text'); };
  const logs = [];
  const t = live({ connect, log: (level, ...args) => logs.push(`${level} ${args.join(' ')}`) });
  const v = await t.engine.startAgent({ task: 'Fix the cart total' });
  t.claude.runners[0].emit({ kind: EV.SAYS, text: 'Working on the cart total now.' });
  assert.equal(t.store.get(v.id).says, 'Working on the cart total now.');
  assert.ok(logs.some(l => /Could not hide the stored keys/.test(l)));
  assert.ok(!logs.some(l => /cart total now|mask broke/.test(l)));
  await t.engine.shutdown();
});

test('a yes that starts nothing goes to the log, with the reason the person was given, and so does a yes for a question that has gone', async () => {
  const logs = [];
  const t = live({ log: (level, ...args) => logs.push([level, ...args.map(String)].join(' ')) });
  await t.engine.start();
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the docs', harness: 'codex' }] };
  const card = await t.engine.command('codex fix the docs');
  t.engine.setHarnesses({ codex: { ok: false, reason: 'Codex is not installed.' } });
  const yes = await t.engine.confirm(card.confirm.id, true);
  assert.equal(yes.reply, 'I could not start the agent for “fix the docs”: Codex is not available on this computer.');
  assert.ok(logs.includes(`warn After a yes to a launch question, 0 of 1 started. ${yes.reply}`), logs.join('\n'));
  // the same card again, and one that never was: nothing is done, and the log says so
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'That request is no longer waiting. Ask again if you still want it.');
  assert.ok(logs.includes('warn A yes came for a question that was no longer waiting, so nothing was done.'));
  // a no for a question that has gone is not a launch that failed: nothing more is logged
  const before = logs.length;
  await t.engine.confirm('no-such-card', false);
  assert.equal(logs.length, before);
  await t.engine.shutdown();
});
