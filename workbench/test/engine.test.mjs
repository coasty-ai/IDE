import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Engine } from '../src/core/engine.mjs';
import { Store } from '../src/core/store.mjs';
import { EV } from '../src/shared/events.mjs';
import { FakeSim, FakeMachines, fakeAdapter, fakeDeps, gate, until } from './helpers/engine-fakes.mjs';

const REPO = { root: '/repos/shop', name: 'shop', head: 'abc1234', branch: 'main', dirty: 2 };
const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', token: 'hook-token' };
const subagentPayload = JSON.parse(fs.readFileSync(new URL('./fixtures/hook-pretool-subagent.json', import.meta.url), 'utf8'));
const rootPayload = JSON.parse(fs.readFileSync(new URL('./fixtures/hook-pretool-root-bash.json', import.meta.url), 'utf8'));

/** A live-mode engine with fake adapters and deps. Remember to call engine.shutdown(). */
function live({ deps: depOpts = {}, options = {}, adapters = null } = {}) {
  const store = new Store();
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const { deps, calls } = fakeDeps(depOpts);
  const machines = new FakeMachines();
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({
    store, mode: 'live', repo: REPO, hook: HOOK, defaultBudgetUsd: 2,
    adapters: adapters || { claude, codex }, machines, deps,
    options: { permissionTimeoutMs: 5000, tickMs: 10_000_000, helperWaitMs: 60, exitGraceMs: 20, ...options },
  });
  return { store, engine, claude, codex, deps, calls, machines, notices };
}

function demo({ options = {}, intent = null } = {}) {
  const store = new Store();
  const sim = new FakeSim();
  const { deps, calls } = fakeDeps({ intent });
  const machines = new FakeMachines({ demo: true });
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim }, machines, deps, options: { tickMs: 10_000_000, simTickMs: 10_000_000, ...options } });
  return { store, engine, sim, deps, calls, machines, notices };
}

/** Start an agent and return its view and fake runner. */
async function started(t, opts = { task: 'Fix the login redirect' }) {
  const v = await t.engine.startAgent(opts);
  const adapter = opts.harness === 'codex' ? t.codex : t.claude;
  return { v, id: v.id, runner: adapter.runners[adapter.runners.length - 1] };
}

/** Whether a promise has settled yet. */
async function settled(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await new Promise(r => setTimeout(r, 15));
  return done;
}

// ------------------------------------------------------------------ launching

test('startAgent (live) creates a workspace, emits created then starting, and starts the runner there', async () => {
  const t = live();
  let stateAtStart = null;
  t.claude = fakeAdapter('claude', { onStart: (r) => { stateAtStart = t.store.get(r.opts.agentId).state; } });
  t.engine.adapters.claude = t.claude;
  const { v, runner } = await started(t, { task: 'Fix the flaky checkout test' });
  assert.match(v.id, /^[0-9a-f]{6}$/);
  assert.equal(v.parentId, null);
  assert.equal(v.name, 'Fix flaky checkout test');
  assert.equal(v.harness, 'claude');
  assert.equal(v.budgetUsd, 2);
  assert.equal(v.machineId, 'laptop');
  assert.equal(v.workspace, `/wt/shop/fix-flaky-checkout-test-${v.id}`);
  assert.equal(stateAtStart, 'starting', 'created and starting come before the runner starts');
  assert.equal(runner.started, true);
  assert.equal(runner.opts.cwd, v.workspace);
  assert.equal(runner.opts.task, 'Fix the flaky checkout test');
  assert.equal(runner.opts.budgetUsd, 2);
  assert.deepEqual(runner.opts.hook, HOOK);
  assert.equal(typeof runner.opts.emit, 'function');
  assert.deepEqual(t.calls.createWorkspace[0], { repoRoot: REPO.root, agentId: v.id, slug: 'fix-flaky-checkout-test' });
  assert.deepEqual(t.calls.readRepoConfig[0], { repoRoot: REPO.root, ref: 'abc1234' }, 'config comes from the base commit');
  assert.ok(t.notices.includes('Started Fix flaky checkout test.'));
  await t.engine.shutdown();
});

test('startAgent refuses what cannot run, and a runner that fails to start leaves a failed agent', async () => {
  const t = live({ adapters: { claude: fakeAdapter('claude', { failStart: new Error('spawn claude ENOENT') }) } });
  await assert.rejects(t.engine.startAgent({ task: '' }), /Tell me what the agent should work on/);
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'codex' }), /Codex is not available/);
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'sim' }), /only in the demo/);
  await assert.rejects(t.engine.startAgent({ task: 'x', model: '--dangerously-skip-permissions' }), /model name/);
  const v = await t.engine.startAgent({ task: 'Fix the login', budgetUsd: 5 });
  assert.equal(v.state, 'failed');
  assert.match(v.stateReason, /could not start/);
  assert.equal(v.budgetUsd, 5);
  await t.engine.shutdown();
});

test('start() in live mode checks which harnesses are available', async () => {
  const t = live({ adapters: { claude: fakeAdapter('claude'), codex: fakeAdapter('codex', { available: { ok: false, reason: 'Codex is not installed.' } }) } });
  await t.engine.start();
  const snap = t.engine.snapshot();
  assert.deepEqual(snap.harnesses, { claude: true, codex: false, sim: false });
  assert.equal(snap.harnessInfo.codex.reason, 'Codex is not installed.');
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'codex' }), /not available/);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ end of a turn

test('turn end with background tasks waits for helpers; helpers get their final state from their task', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-a71ea18c`;
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude', helperType: 'Explore' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Agent is running in the background.', backgroundTasks: 1, isError: false });
  await until(() => t.store.get(id).state === 'waiting_helpers');
  assert.equal(t.store.get(id).now, 'Waiting for 1 helper');
  runner.emit({ kind: EV.ENDED, agentId: helperId, outcome: 'ok' });
  assert.equal(t.store.get(helperId).state, 'finished', 'the engine finishes a helper whose task completed');
  assert.deepEqual(t.store.get(id).helpers, { total: 1, working: 0, done: 1 });
  await t.engine.shutdown();
});

test('turn end with an error fails the agent with a plain reason', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', isError: true, subtype: 'error_max_budget_usd' });
  await until(() => t.store.get(id).state === 'failed');
  assert.equal(t.store.get(id).stateReason, 'It reached its spending limit.');
  await t.engine.shutdown();
});

test('turn end with a closing question asks it; the answer goes to the runner', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I found two login routes.\n\nShould I remove the old one?', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'question');
  const v = t.store.get(id);
  assert.equal(v.ask.type, 'question');
  assert.equal(v.ask.sentence, 'Should I remove the old one?');
  assert.deepEqual(v.ask.options, []);
  assert.equal(v.says, 'I found two login routes.');
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Yes, remove it' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Sent your answer to Fix login redirect.');
  assert.deepEqual(runner.sent, ['Yes, remove it']);
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).state, 'working');
  assert.ok(t.notices.includes(r.reply), 'replies are also notices');
  await t.engine.shutdown();
});

test('receipt: all checks passed is done_checked, with files, rules, running checks and says', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], rules: [{ say: 'Leave the payments folder alone', paths: ['payments/**'] }] } });
  const { id, runner } = await started(t);
  const checkStates = [];
  t.store.on('agents', ids => { if (ids.includes(id)) checkStates.push(t.store.get(id).checks?.state ?? null); });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: '**Fixed** the redirect after login. All tests pass.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_checked');
  const v = t.store.get(id);
  assert.equal(v.files.changed, 1);
  assert.equal(v.rules.kept[0].say, 'Leave the payments folder alone');
  assert.equal(v.checks.state, 'passed');
  assert.deepEqual(v.checks.results.map(r => [r.name, r.ok]), [['unit tests', true]]);
  assert.equal(v.says, 'Fixed the redirect after login.');
  assert.ok(checkStates.includes('running'), 'checks show as running first');
  assert.deepEqual(t.calls.diffStats[0], { path: v.workspace, base: 'abc1234' });
  assert.deepEqual(t.calls.checkRules[0].paths, ['src/cart.js']);
  assert.equal(t.calls.runChecks[0].cwd, v.workspace);
  await t.engine.shutdown();
});

test('receipt: a failed check is checks_failed; no checks is done_claimed', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checkState: 'failed' } });
  const a = await started(t);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'checks_failed');
  assert.equal(t.store.get(a.id).stateReason, 'The check “unit tests” did not pass.');
  assert.equal(t.store.get(a.id).checks.results[0].tail, 'expected 3, got 4');
  await t.engine.shutdown();

  const u = live();
  const b = await started(u);
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I updated the README.', backgroundTasks: 0, isError: false });
  await until(() => u.store.get(b.id).state === 'done_claimed');
  assert.equal(u.store.get(b.id).checks, null);
  assert.equal(u.store.get(b.id).says, 'I updated the README.');
  await u.engine.shutdown();
});

test('a receipt that is overtaken by a new turn is dropped', async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  checksGate.open();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(t.store.get(id).state, 'working', 'no done state from the old turn');
  assert.equal(t.store.get(id).checks.state, 'running', 'the old result was not applied');
  await t.engine.shutdown();
});

test('a clean exit in the middle of a turn becomes failed; after a finished turn it does not', async () => {
  const t = live();
  const a = await started(t);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Reading a.js', toolKind: 'read', toolUseId: 'x' });
  a.runner.alive = false;
  a.runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(a.id).state === 'failed');
  assert.equal(t.store.get(a.id).stateReason, 'It stopped before finishing its work.');

  const b = await started(t, { task: 'Write tests for the parser', harness: 'codex' });
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I added three tests.', backgroundTasks: 0, isError: false });
  b.runner.alive = false;
  b.runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(b.id).state === 'done_claimed');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(t.store.get(b.id).state, 'done_claimed');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ permissions

test('hook: allowed and denied requests are answered at once and counted', async () => {
  const t = live();
  const { id } = await started(t);
  const allow = await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: { file_path: 'src/a.js' } });
  assert.deepEqual(allow, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Reading is fine.' } });
  const deny = await t.engine.hookPreToolUse(id, { tool_name: 'Forbidden', tool_input: {} });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(t.store.get(id).approvals, { auto: 1, byYou: 0, denied: 1 });
  assert.equal(t.calls.decide[0].cwd, t.store.get(id).workspace, 'policy sees the workspace, not the payload cwd');
  assert.deepEqual(t.calls.decide[0].extraAllow, []);
  const unknown = await t.engine.hookPreToolUse('nobody', { tool_name: 'Read', tool_input: {} });
  assert.equal(unknown.hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.shutdown();
});

test('hook: an ask is held until the person allows it', async () => {
  const t = live({ deps: { allow: ['make deploy'] } });
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(await settled(pending), false, 'the response is held');
  const v = t.store.get(id);
  assert.equal(v.state, 'needs_ok');
  assert.equal(v.ask.type, 'permission');
  assert.equal(v.ask.sentence, 'Fix login redirect wants to run a command');
  assert.equal(v.ask.detail, 'rm -rf build');
  assert.deepEqual(v.ask.options, ['Allow', 'Deny']);
  assert.equal(v.ask.primary, 'Allow');
  assert.deepEqual(t.calls.decide[0].extraAllow, ['make deploy'], 'workbench.json allow list goes to the policy');
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Allow' });
  assert.equal(r.reply, 'OK, Fix login redirect can go ahead.');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  assert.deepEqual(t.store.get(id).approvals, { auto: 0, byYou: 1, denied: 0 });
  await t.engine.shutdown();
});

test('hook: free text never allows; it denies and passes the words on', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, rootPayload);
  await until(() => t.store.get(id).ask);
  const r = await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'no, use the staging folder' });
  assert.equal(r.reply, 'OK, Fix login redirect will not do that.');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /use the staging folder/);
  assert.equal(t.store.get(id).approvals.denied, 1);
  await t.engine.shutdown();
});

test('hook: no answer in time counts as a deny with the contract reason', async () => {
  const t = live({ options: { permissionTimeoutMs: 40 } });
  const { id } = await started(t);
  const out = await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'make deploy' } });
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No answer from the person in time' });
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).approvals.denied, 1);
  assert.ok(t.notices.some(n => /waited .* for your OK, so I said no/.test(n)));
  await t.engine.shutdown();
});

test('hook: a helper’s request is asked on the helper', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.STATE, state: 'waiting_helpers' });
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).state === 'needs_ok');
  assert.equal(t.store.get(helperId).ask.sentence, 'List repository files wants to run a command');
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'the root is not the one asking');
  await t.engine.answer(helperId, { askId: t.store.get(helperId).ask.id, answer: 'Deny' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(helperId).state, 'working');
  await t.engine.shutdown();
});

test('hook: a request from a helper not shown yet falls back to the root, which goes back to waiting', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Asking a helper to look around', toolKind: 'helper', toolUseId: 'a1' });
  runner.emit({ kind: EV.STATE, state: 'waiting_helpers', backgroundTasks: 1 });
  const pending = t.engine.hookPreToolUse(id, { ...subagentPayload, agent_id: 'ffffffff00000000' });
  await until(() => t.store.get(id).state === 'needs_ok');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'waiting_helpers');
  await t.engine.shutdown();
});

test('hook: several requests from one agent are shown one at a time', async () => {
  const t = live();
  const { id } = await started(t);
  const first = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  await until(() => t.store.get(id).ask);
  const second = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.store.get(id).ask.detail, 'rm a');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' });
  assert.equal((await first).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).ask.detail, 'rm b', 'the next request shows');
  assert.equal(t.store.get(id).state, 'needs_ok');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await second).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(id).state, 'working');
  await t.engine.shutdown();
});

test('hook: an aborted request is dropped; shutdown denies whatever is still held', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const ac = new AbortController();
  const aborted = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } }, { signal: ac.signal });
  await until(() => t.store.get(id).ask);
  ac.abort();
  assert.equal((await aborted).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(id).ask, null);

  const held = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  await until(() => t.store.get(id).ask);
  await t.engine.shutdown();
  const out = await held;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'Workbench is shutting down.');
  assert.equal(runner.stopCalls, 1, 'shutdown stops every runner');
  assert.equal(t.store.get(id).state, 'stopped');
  const late = await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: {} });
  assert.equal(late.hookSpecificOutput.permissionDecision, 'deny');
});

// ------------------------------------------------------------------ stuck

function failThreeTimes(runner) {
  for (let i = 0; i < 3; i++) {
    runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Running the tests', toolKind: 'run', toolUseId: 'u' + i });
    if (i < 2) runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'u' + i, ok: false });
  }
}

test('stuck: the tick flags a repeating agent; "Let it keep trying" clears it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  failThreeTimes(runner);
  t.engine.tick(Date.now());
  const v = t.store.get(id);
  assert.equal(v.state, 'maybe_stuck');
  assert.equal(v.ask.type, 'stuck');
  assert.equal(v.ask.sentence, 'Fix login redirect has tried the same step three times without success.');
  assert.deepEqual(v.ask.options, ['Stop it', 'Let it keep trying']);
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Let it keep trying' });
  assert.equal(r.reply, 'OK, Fix login redirect will keep trying.');
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  t.engine.tick(Date.now());
  assert.equal(t.store.get(id).state, 'working', 'not flagged again straight away');
  await t.engine.shutdown();
});

test('stuck: "Stop it" stops the agent, other text is a hint, progress clears it', async () => {
  const t = live();
  const a = await started(t);
  failThreeTimes(a.runner);
  t.engine.tick(Date.now());
  await t.engine.answer(a.id, { askId: t.store.get(a.id).ask.id, answer: 'Stop it' });
  assert.equal(t.store.get(a.id).state, 'stopped');
  assert.equal(a.runner.stopCalls, 1);
  assert.equal(t.store.get(a.id).ask, null);

  const b = await started(t, { task: 'Fix the cart total' });
  failThreeTimes(b.runner);
  t.engine.tick(Date.now());
  await t.engine.answer(b.id, { askId: t.store.get(b.id).ask.id, answer: 'The fixture file is out of date' });
  assert.deepEqual(b.runner.sent, ['The fixture file is out of date']);
  assert.equal(t.store.get(b.id).state, 'working');

  const c = await started(t, { task: 'Fix the cart tax' });
  failThreeTimes(c.runner);
  t.engine.tick(Date.now());
  assert.equal(t.store.get(c.id).state, 'maybe_stuck');
  c.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit', toolUseId: 'e1' });
  c.runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'e1', ok: true });
  assert.equal(t.store.get(c.id).state, 'working', 'a different step succeeded');
  assert.equal(t.store.get(c.id).ask, null);
  await t.engine.shutdown();
});

test('stuck: a working agent with no events for the silence limit is flagged', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Reading a.js', toolKind: 'read', toolUseId: 'r', ts: Date.now() - 5000 });
  runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'r', ok: true, ts: Date.now() - 5000 });
  t.engine.tick(Date.now() + 2000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  assert.equal(t.store.get(id).ask.sentence, 'Fix login redirect has not done anything for 1 s.');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ done, follow-ups, stop

test('done: "Looks good" leaves it; anything else is a follow-up that resumes it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed it.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_claimed');
  const ok = await t.engine.answer(id, { answer: 'Looks good' });
  assert.equal(ok.ok, true);
  assert.equal(t.store.get(id).state, 'done_claimed');
  assert.deepEqual(runner.sent, []);
  const more = await t.engine.answer(id, { answer: 'Please also add a test' });
  assert.equal(more.reply, 'Sent your follow-up to Fix login redirect.');
  assert.deepEqual(runner.sent, ['Please also add a test']);
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).endedAt, null);
  await t.engine.shutdown();
});

test('stop: the runner stops, the agent and its helpers are stopped, late events cannot undo it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.CREATED, agentId: `${id}-12345678`, parentId: id, name: 'Helper', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: `${id}-12345678`, state: 'working' });
  const r = await t.engine.stop(id);
  assert.equal(r.reply, 'Stopped Fix login redirect.');
  assert.equal(runner.stopCalls, 1);
  assert.equal(t.store.get(id).state, 'stopped');
  assert.equal(t.store.get(`${id}-12345678`).state, 'stopped');
  runner.emit({ kind: EV.ENDED, outcome: 'error', error: 'killed by SIGTERM' });
  runner.emit({ kind: EV.STATE, state: 'failed' });
  assert.equal(t.store.get(id).state, 'stopped');
  assert.equal(t.store.get(id).error, null);
  const again = await t.engine.stop(id);
  assert.equal(again.reply, 'Fix login redirect is not running.');
  // A new message brings it back.
  const s = await t.engine.say(id, 'Carry on, but skip the slow tests');
  assert.equal(s.ok, true);
  assert.deepEqual(runner.sent, ['Carry on, but skip the slow tests']);
  assert.equal(t.store.get(id).state, 'working');
  await t.engine.shutdown();
});

test('say: to a helper goes through its root', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.CREATED, agentId: `${id}-abcdefab`, parentId: id, name: 'Find tests', harness: 'claude' });
  const r = await t.engine.say(`${id}-abcdefab`, 'look in spec/ too');
  assert.equal(r.reply, 'Passed that to Fix login redirect for its helper Find tests.');
  assert.deepEqual(runner.sent, ['About your helper “Find tests”: look in spec/ too']);
  assert.equal((await t.engine.say('nobody', 'x')).ok, false);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ commands and confirms

test('command: a start intent asks to confirm first; confirm(go) launches, confirm(no) cancels', async () => {
  const t = live();
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the flaky checkout test', harness: 'claude', machine: null }] };
  const out = await t.engine.command('start an agent to fix the flaky checkout test', { focusId: null });
  assert.equal(out.reply, 'Start Claude Code on “fix the flaky checkout test”?');
  assert.ok(out.confirm && /^[0-9a-f]{12}$/.test(out.confirm.id));
  assert.equal(out.confirm.sentence, out.reply);
  assert.match(out.confirm.detail, /\$2\.00/);
  assert.match(out.confirm.detail, /2 uncommitted changes are not included/);
  assert.equal(t.store.list().length, 0, 'nothing starts before the confirm');
  const ctx = t.calls.parse[0].ctx;
  assert.deepEqual(Object.keys(ctx).sort(), ['agents', 'focusId', 'harnesses', 'machines', 'pendingConfirm']);
  assert.deepEqual(ctx.harnesses, { claude: true, codex: true, sim: false });

  const go = await t.engine.confirm(out.confirm.id, true);
  assert.equal(go.reply, 'Started Fix flaky checkout test.');
  assert.equal(go.agentIds.length, 1);
  assert.equal(t.store.get(go.agentIds[0]).task, 'fix the flaky checkout test');
  const twice = await t.engine.confirm(out.confirm.id, true);
  assert.match(twice.reply, /no longer waiting/);

  t.deps.commands.intent = { kind: 'task', task: 'fix the login redirect' };
  const out2 = await t.engine.command('fix the login redirect');
  assert.ok(out2.confirm);
  const no = await t.engine.confirm(out2.confirm.id, false);
  assert.equal(no.reply, 'OK, I won’t start it.');
  assert.equal(t.store.list().length, 1);
  await t.engine.shutdown();
});

test('command: "yes" confirms the pending launch through the commands module', async () => {
  const t = live();
  t.deps.commands.intent = (text, ctx) => (text === 'yes' && ctx.pendingConfirm
    ? { kind: 'confirm', go: true }
    : { kind: 'start', tasks: [{ task: 'write tests for the parser', harness: 'codex' }, { task: 'fix the parser', harness: 'claude' }] });
  const out = await t.engine.command('have codex write tests for the parser and claude fix it');
  assert.match(out.reply, /^Start 2 agents: Codex on “write tests for the parser” and Claude Code on “fix the parser”\?$/);
  const yes = await t.engine.command('yes');
  assert.equal(t.calls.parse[1].ctx.pendingConfirm.id, out.confirm.id);
  assert.match(yes.reply, /^Started Write tests for parser and Fix parser\.$/);
  assert.equal(t.codex.runners.length, 1);
  assert.equal(t.claude.runners.length, 1);
  await t.engine.shutdown();
});

test('command: allow, stop, status, spend and unknown give plain replies', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);

  t.deps.commands.intent = { kind: 'status' };
  const status = await t.engine.command('what needs me');
  assert.equal(status.reply, 'One thing needs you: Fix login redirect needs your OK.');
  assert.equal(status.focusId, id);

  t.deps.commands.intent = { kind: 'status', agentId: id };
  assert.equal((await t.engine.command('what is it doing')).reply, 'Fix login redirect wants to run a command. It needs your OK.');

  t.deps.commands.intent = { kind: 'allow', agentId: id };
  const allow = await t.engine.command('go ahead', { focusId: id });
  assert.equal(allow.reply, 'OK, Fix login redirect can go ahead.');
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');

  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'set', costUsd: 0.42 });
  t.deps.commands.intent = { kind: 'spend' };
  assert.equal((await t.engine.command('how much have I spent today')).reply, 'You have spent $0.42 today.');

  t.deps.commands.intent = { kind: 'stop_all' };
  assert.equal((await t.engine.command('stop everything')).reply, 'Stopped Fix login redirect.');
  assert.equal((await t.engine.command('stop everything')).reply, 'Nothing is running.');

  t.deps.commands.intent = null;
  const unknown = await t.engine.command('blorp');
  assert.match(unknown.reply, /I did not catch that/);
  assert.ok(t.notices.includes(unknown.reply));
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ demo mode

test('demo: start seeds the simulator and syncs machines; launches use the simulator', async () => {
  const t = demo();
  await t.engine.start();
  assert.equal(t.sim.seeded, true);
  assert.deepEqual(t.store.machines().map(m => m.id), ['laptop', 'cloud-1', 'cloud-2', 'cloud-3']);
  assert.deepEqual(t.engine.snapshot().harnesses, { claude: true, codex: true, sim: true });
  const v = await t.engine.startAgent({ task: 'Fix the onboarding copy', harness: 'codex' });
  assert.equal(t.sim.runners.length, 1);
  assert.equal(t.sim.runners[0].opts.agentId, v.id);
  assert.equal(t.sim.runners[0].opts.cwd, null);
  assert.equal(v.harness, 'codex');
  assert.equal(v.usage.costUsd, null);
  await t.engine.shutdown();
});

test('demo: asks the simulator made go back to the simulator', async () => {
  const t = demo();
  t.engine.ingest({ kind: EV.CREATED, agentId: 'c0ffee', parentId: null, name: 'Search cleanup', task: 'Clean up search', harness: 'claude', machineId: 'cloud-3' });
  t.engine.ingest({ kind: EV.ASK, agentId: 'c0ffee', ask: { id: 'sim-q1', type: 'question', sentence: 'Should I keep the old route?', options: ['Keep it', 'Remove it'] } });
  t.engine.ingest({ kind: EV.STATE, agentId: 'c0ffee', state: 'question' });
  const r = await t.engine.answer('c0ffee', { askId: 'sim-q1', answer: 'Keep it' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Sent your answer to Search cleanup.');
  assert.equal(t.sim.answers.length, 1);
  assert.equal(t.sim.answers[0].agentId, 'c0ffee');
  assert.equal(t.sim.answers[0].ask.id, 'sim-q1');
  assert.equal(t.sim.answers[0].answer, 'Keep it');
  // Stopping a seeded agent (no runner here) still stops it and keeps it stopped.
  const s = await t.engine.stop('c0ffee');
  assert.equal(s.reply, 'Stopped Search cleanup.');
  assert.deepEqual(t.sim.stops, ['c0ffee']);
  t.engine.ingest({ kind: EV.STATE, agentId: 'c0ffee', state: 'working' });
  assert.equal(t.store.get('c0ffee').state, 'stopped');
  await t.engine.shutdown();
});

test('demo: cloud launches each get their own machine, waking one if needed', async () => {
  const t = demo();
  await t.engine.start();
  t.deps.commands.intent = { kind: 'start', tasks: [
    { task: 'fix the checkout bug', harness: 'claude', machine: 'cloud' },
    { task: 'fix the checkout bug', harness: 'codex', machine: 'cloud' },
    { task: 'write the release notes', harness: 'claude', machine: 'cloud' },
  ] };
  const out = await t.engine.command('start Claude and Codex on the checkout bug, each on its own cloud machine');
  assert.match(out.confirm.detail, /Each one gets its own cloud machine/);
  const go = await t.engine.confirm(out.confirm.id, true);
  const machines = go.agentIds.map(id => t.store.get(id).machineId);
  assert.deepEqual(machines, ['cloud-1', 'cloud-3', 'cloud-2'], 'awake idle machines first, then a sleeping one');
  assert.equal(t.store.machines().find(m => m.id === 'cloud-2').awake, true, 'the sleeping machine was woken');
  await t.engine.shutdown();
});

test('machines: sleep and wake with plain replies; the laptop stays on', async () => {
  const t = demo();
  await t.engine.start();
  assert.equal((await t.engine.setMachineAwake('cloud-2', true)).reply, 'Cloud 2 is awake.');
  assert.equal(t.store.machines().find(m => m.id === 'cloud-2').awake, true);
  assert.equal((await t.engine.setMachineAwake('cloud-2', false)).reply, 'Cloud 2 is asleep now.');
  const laptop = await t.engine.setMachineAwake('laptop', false);
  assert.equal(laptop.ok, false);
  assert.equal(laptop.reply, 'Your laptop runs Workbench itself, so it stays awake.');
  assert.equal(t.store.machines().find(m => m.id === 'laptop').awake, true);
  assert.equal((await t.engine.setMachineAwake('nope', true)).ok, false);
  assert.equal((await t.engine.setMachineAwake('Cloud 1', true)).reply, 'Cloud 1 is already awake.', 'loose names work');
  await t.engine.shutdown();
});

test('machines: a machines module that words its own replies is passed through, and its updates are synced', async () => {
  const t = demo();
  t.machines.setAwake = function (id, awake) {
    const m = this.items.find(x => x.id === id);
    if (!m) return { ok: false, reply: `There is no machine called ${id}.` };
    m.awake = awake;
    return { ok: true, reply: awake ? `${m.name} is waking up. It takes about 8 seconds.` : `${m.name} is asleep. Its work is saved.` };
  };
  t.machines.sleepIdle = function () {
    const idle = this.items.filter(m => m.kind === 'cloud' && m.awake && !m.agents);
    for (const m of idle) m.awake = false;
    return { ok: true, reply: `${idle.map(m => m.name).join(' and ')} are asleep. Their work is saved.`, ids: idle.map(m => m.id) };
  };
  await t.engine.start();
  assert.equal((await t.engine.setMachineAwake('cloud-2', true)).reply, 'Cloud 2 is waking up. It takes about 8 seconds.');
  assert.equal((await t.engine.setMachineAwake('cloud-9', true)).reply, 'There is no machine called cloud-9.');
  t.deps.commands.intent = { kind: 'sleep_idle' };
  const r = await t.engine.command('sleep idle machines');
  assert.equal(r.reply, 'Cloud 1 and Cloud 2 and Cloud 3 are asleep. Their work is saved.');
  assert.ok(t.store.machines().filter(m => m.kind === 'cloud').every(m => !m.awake));
  // A change the machines module makes on its own reaches the store.
  t.machines.items[1].awake = true;
  t.machines.emit('update', [t.machines.items[1]]);
  assert.equal(t.store.machines().find(m => m.id === 'cloud-1').awake, true);
  await t.engine.shutdown();
});

test('command: deny with words passes them on; the commands module can word the confirm', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'psql prod' } });
  await until(() => t.store.get(id).ask);
  t.deps.commands.intent = { kind: 'deny', agentId: id, askId: t.store.get(id).ask.id, text: 'no, use the staging database' };
  await t.engine.command('no, use the staging database', { focusId: id });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /use the staging database/);

  t.deps.commands.describeIntent = (intent) => `Start Claude Code on “${intent.tasks[0].task}”${intent.tasks[0].machine ? ' on a cloud machine' : ''}?`;
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'tidy the README', harness: 'claude', machine: 'cloud' }] };
  const c = await t.engine.command('start an agent on a cloud machine to tidy the README');
  assert.equal(c.confirm.sentence, 'Start Claude Code on “tidy the README”?', 'live mode has no cloud machines to promise');
  assert.match(c.confirm.detail, /Cloud machines exist only in the demo/);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ snapshot

test('snapshot has the contract fields, including repo and harness availability', async () => {
  const t = live();
  await t.engine.start();
  const { id } = await started(t);
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'set', costUsd: 0.1 });
  const s = t.engine.snapshot();
  assert.equal(s.mode, 'live');
  assert.deepEqual(s.repo, { name: 'shop', head: 'abc1234', branch: 'main', dirty: 2 });
  assert.deepEqual(s.harnesses, { claude: true, codex: true, sim: false });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].id, id);
  assert.deepEqual(s.machines.map(m => m.id), ['laptop']);
  assert.equal(s.spendTodayUsd, 0.1);
  assert.equal(s.defaultBudgetUsd, 2);
  await t.engine.shutdown();
});

test('live mode without a repo explains itself', async () => {
  const store = new Store();
  const { deps } = fakeDeps();
  const engine = new Engine({ store, mode: 'live', repo: null, adapters: { claude: fakeAdapter('claude') }, deps });
  await assert.rejects(engine.start(), /needs a git repository/);
  await engine.shutdown();
});
