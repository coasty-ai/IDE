import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Simulator, available, harness, topicOf, subjectOf } from '../src/adapters/sim/simulator.mjs';
import { EV, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../src/shared/events.mjs';
import { extractQuestion, nameFromTask } from '../src/shared/narrate.mjs';
import { createFakeStore as createBaseStore } from './helpers/simulator-fake-store.mjs';

const T0 = Date.UTC(2026, 10, 10, 17, 0, 0);
const MIN = 60_000;

// What became of a root's work in git: `agent.work` { agentId, work }, which replaces the view's `work` as a whole.
const WORK = EV.WORK || 'agent.work';
const WORK_KEYS = ['branch', 'from', 'folder', 'merged', 'problem', 'thrownAway'];

/**
 * The fake store, plus `agent.work`, which it predates. As in store.mjs, the event replaces a root's `work` as a whole
 * (a helper's is ignored). It is recorded, and its time and shape are checked, like any other event.
 */
function createFakeStore(opts) {
  const store = createBaseStore(opts);
  const lastTs = new Map();
  const emit = (ev) => {
    const prev = lastTs.get(ev.agentId);
    if (ev.kind !== WORK) {
      if (prev == null || ev.ts > prev) lastTs.set(ev.agentId, ev.ts);
      store.emit(ev);
      return;
    }
    store.events.push(ev);
    if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts)) store.errors.push(`bad ts on ${ev.kind}`);
    else if (prev != null && ev.ts < prev) store.errors.push(`${ev.kind} for ${ev.agentId} went back in time`);
    else lastTs.set(ev.agentId, ev.ts);
    const v = store.get(ev.agentId);
    if (!v) store.errors.push(`${ev.kind} for unknown agent ${ev.agentId}`);
    else if (!ev.work || JSON.stringify(Object.keys(ev.work)) !== JSON.stringify(WORK_KEYS)) store.errors.push(`${ev.kind} for ${ev.agentId} is not shaped like AgentView.work`);
    else if (!v.parentId) v.work = structuredClone(ev.work);
  };
  return { ...store, emit };
}

/** A simulator wired to a fake store, with a clock the test moves. */
function world({ seed = 7, speed = 1, engine = true } = {}) {
  const store = createFakeStore({ engine });
  const clock = { t: T0 };
  const sim = new Simulator({ emit: store.emit, now: () => clock.t, speed, seed });
  const run = (ms, step = 1000) => {
    const end = clock.t + ms;
    while (clock.t < end) { clock.t = Math.min(end, clock.t + step); sim.tick(clock.t); }
  };
  /** Tick until `done()` holds or `limitMs` of real time passes. Returns the real ms it took. */
  const until = (done, limitMs = 10 * MIN, step = 1000) => {
    const start = clock.t;
    while (!done() && clock.t - start < limitMs) { clock.t += step; sim.tick(clock.t); }
    return clock.t - start;
  };
  return { sim, store, clock, run, until };
}

/** No agent starts the same sentence three times in a row (the engine's stuck detector would fire). */
function assertNoTripleRepeats(store, except = []) {
  const byAgent = new Map();
  for (const e of store.events) {
    if (e.kind !== EV.ACTIVITY || e.phase !== 'start') continue;
    const list = byAgent.get(e.agentId) || [];
    list.push(e.sentence);
    byAgent.set(e.agentId, list);
  }
  for (const [id, list] of byAgent) {
    if (except.includes(id)) continue;
    for (let i = 2; i < list.length; i++) {
      assert.ok(!(list[i] === list[i - 1] && list[i] === list[i - 2]), `${id} repeats "${list[i]}" three times in a row`);
    }
  }
}

test('the module and an instance look like an adapter', async () => {
  assert.equal(harness, 'sim');
  assert.deepEqual(await available(), { ok: true });
  const sim = new Simulator({ emit: () => {}, now: T0, seed: 1 });
  assert.equal(sim.harness, 'sim');
  assert.deepEqual(await sim.available(), { ok: true });
  assert.equal(typeof sim.createRunner, 'function');
  assert.equal(typeof sim.onAnswer, 'function');
  assert.equal(typeof sim.tick, 'function');
});

test('seedWorld builds the six roots in their stated states, with helpers', () => {
  const { sim, store } = world();
  const seeded = sim.seedWorld();
  assert.deepEqual(store.errors, []);
  assert.deepEqual(seeded.map(r => r.name), ['Checkout fix', 'Search cleanup', 'Flaky test', 'Invoice export', 'Help pages', 'Onboarding']);

  const roots = store.roots();
  assert.equal(roots.length, 6);
  const by = Object.fromEntries(roots.map(v => [v.name, v]));
  const expect = {
    'Checkout fix': 'needs_ok', 'Search cleanup': 'question', 'Flaky test': 'maybe_stuck',
    'Invoice export': 'done_checked', 'Help pages': 'done_claimed', Onboarding: 'working',
  };
  for (const [name, state] of Object.entries(expect)) assert.equal(by[name].state, state, name);
  for (const r of seeded) assert.equal(r.state, expect[r.name]);

  // They look like Claude Code agents; Help pages looks like Codex, as in the mockup.
  for (const v of store.list()) assert.equal(v.harness, v.name === 'Help pages' ? 'codex' : 'claude', v.name);

  // Helpers: Checkout fix has 2 finished, Flaky test 1, Onboarding 2 working, the rest none.
  const helpers = name => store.helpersOf(by[name].id);
  assert.deepEqual(helpers('Checkout fix').map(h => h.state), ['finished', 'finished']);
  assert.deepEqual(helpers('Checkout fix').map(h => h.name), ['Find similar bugs', 'Trace checkout flow']);
  assert.equal(helpers('Flaky test').length, 1);
  assert.equal(helpers('Flaky test')[0].state, 'finished');
  assert.deepEqual(helpers('Onboarding').map(h => h.state), ['working', 'working']);
  for (const name of ['Search cleanup', 'Invoice export', 'Help pages']) assert.equal(helpers(name).length, 0, name);
  assert.deepEqual(by['Checkout fix'].helpers, { total: 2, working: 0, done: 2 });
  assert.deepEqual(by.Onboarding.helpers, { total: 2, working: 2, done: 0 });
  for (const h of store.list().filter(v => v.parentId)) {
    assert.equal(h.kind, 'helper');
    assert.equal(h.depth, 1);
    assert.equal(h.machineId, store.get(h.parentId).machineId);
    if (h.state === 'finished') assert.ok(h.says && /[.!]$/.test(h.says), 'a finished helper reports back');
  }

  // Machines: laptop, cloud-1 and cloud-3 only; nothing on the sleeping cloud-2.
  assert.deepEqual([...new Set(roots.map(v => v.machineId))].sort(), ['cloud-1', 'cloud-3', 'laptop']);
  assert.equal(store.events.filter(e => e.machineId === 'cloud-2').length, 0);
  assert.equal(by['Checkout fix'].machineId, 'cloud-1');
  assert.equal(by['Flaky test'].machineId, 'cloud-3');

  // Ids follow the contract.
  for (const v of store.list()) {
    assert.doesNotMatch(v.id, /[/:]/);
    if (v.parentId) assert.match(v.id, new RegExp(`^${v.parentId}-[0-9a-f]{8}$`));
    else assert.match(v.id, /^[0-9a-f]{6}$/);
  }
});

test('the seeded asks match the mockup exactly', () => {
  const { sim, store } = world();
  sim.seedWorld();
  const by = Object.fromEntries(store.roots().map(v => [v.name, v]));
  const T = T0;

  const ok = by['Checkout fix'].ask;
  assert.equal(ok.type, 'permission');
  assert.equal(ok.sentence, 'Checkout fix wants to run a command');
  assert.equal(ok.detail, 'npm run db:migrate -- --env test');
  assert.equal(ok.why, 'This command is not on the list of safe commands.', 'why it asks, in the permission check\'s own words');
  assert.deepEqual(ok.options, ['Allow', 'Deny']);
  assert.equal(ok.primary, 'Allow');
  assert.equal(T - ok.createdAt, 4 * MIN, 'waiting 4 minutes');
  // The held step reads as what it runs, never as the agent's own description of it ("Update the test database").
  assert.equal(by['Checkout fix'].now, 'Running the db:migrate script', 'the held step shows as what it is doing');

  const q = by['Search cleanup'].ask;
  assert.equal(q.type, 'question');
  assert.equal(q.sentence, 'Should the old search address keep working for existing customers, or can I remove it?');
  assert.deepEqual(q.options, ['Keep it working', 'Remove it']);
  assert.equal(T - q.createdAt, 11 * MIN, 'waiting 11 minutes');

  const stuck = by['Flaky test'].ask;
  assert.equal(stuck.type, 'stuck');
  assert.equal(stuck.sentence, 'Flaky test has hit the same error three times.');
  assert.deepEqual(stuck.options, ['Stop it', 'Let it keep trying']);
  const fails = by['Flaky test'].recent.filter(r => r.sentence === 'Running the tests' && r.ok === false);
  assert.equal(fails.length, 3, 'the same failing step three times');

  for (const name of ['Invoice export', 'Help pages', 'Onboarding']) assert.equal(by[name].ask, null, name);
  assert.equal(new Set(store.events.filter(e => e.kind === EV.ASK).map(e => e.ask.id)).size, 3, 'three asks, distinct ids');
});

test('the seeded history is believable', () => {
  const { sim, store } = world();
  sim.seedWorld();
  const by = Object.fromEntries(store.roots().map(v => [v.name, v]));

  for (const v of store.roots()) {
    assert.ok(v.startedAt < T0 - 10 * MIN, `${v.name} started a while ago`);
    assert.equal(v.recent.length, 8, `${v.name} has recent steps`);
    assert.ok(v.toolCalls >= 15, `${v.name} did some work`);
    assert.ok(v.plan && v.plan.total >= 4 && v.plan.done >= 1, `${v.name} has a plan`);
    assert.ok(v.files && v.files.changed >= 1 && v.files.list.length === v.files.changed, `${v.name} changed files`);
    assert.ok(v.usage.contextPct > 0.05 && v.usage.contextPct < 0.8, `${v.name} context`);
    assert.equal(v.turns, 1);
    assert.equal(v.model && typeof v.model, 'string');
    assert.match(v.sessionId, /^[0-9a-f-]{36}$/);
    if (v.harness === 'codex') {
      assert.equal(v.usage.costUsd, null, 'Codex reports no cost');
      assert.equal(v.approvals.auto, 0, 'Codex has no permission hook');
    } else {
      assert.ok(v.usage.costUsd > 0.05 && v.usage.costUsd < 1, `${v.name} cost ${v.usage.costUsd}`);
      assert.ok(v.approvals.auto > 10, `${v.name} had tool calls allowed automatically`);
    }
  }
  const total = store.roots().reduce((s, v) => s + (v.usage.costUsd || 0), 0);
  assert.ok(Math.abs(total - 3.05) < 0.005, `spend today ${total}`);

  // Invoice export: checks passed and one rule broken.
  const inv = by['Invoice export'];
  assert.equal(inv.checks.state, 'passed');
  assert.ok(inv.checks.results.length >= 1 && inv.checks.results.every(r => r.ok));
  assert.deepEqual(inv.rules.broken.map(r => r.say), ['Do not touch migrations/']);
  assert.ok(inv.rules.broken[0].paths.every(p => inv.files.list.some(f => f.path === p)), 'the broken rule names a changed file');
  assert.equal(inv.plan.done, inv.plan.total);
  assert.match(inv.says, /small batches/);
  assert.equal(by['Help pages'].checks.state, 'none');
  assert.ok(by['Help pages'].says);

  // Onboarding is busy right now: its spark has recent activity and a plan in progress.
  const onb = by.Onboarding;
  assert.equal(onb.spark.length, SPARK_BUCKETS);
  assert.ok(onb.spark.slice(-6).reduce((s, n) => s + n, 0) >= 4, 'activity in the last few minutes');
  assert.ok(onb.plan.items.some(i => i.status === 'in_progress'));
  assert.ok(T0 - onb.lastEventAt < 30_000);

  // Every sentence is plain language from narrate(), never a raw tool name.
  const sentences = store.events.filter(e => e.kind === EV.ACTIVITY).map(e => e.sentence);
  for (const s of sentences) {
    assert.match(s, /^[A-Z]/, s);
    assert.doesNotMatch(s, /^Using |^Running (npm|node|git)|Bash|TodoWrite|tool_use/, s);
  }
  for (const want of ['Reading checkout.ts', 'Running the tests', 'Asking a helper to find similar bugs', 'Updating its plan']) {
    assert.ok(sentences.includes(want), want);
  }
  assert.ok(store.events.filter(e => e.kind === EV.THINKING && e.on).length > 10, 'thinking blips');
  assert.ok(store.events.every(e => e.ts <= T0), 'history is in the past');
  assert.deepEqual(store.errors, []);
  assertNoTripleRepeats(store);
});

test('seedWorld only seeds once', () => {
  const { sim, store } = world();
  const a = sim.seedWorld();
  const n = store.events.length;
  assert.deepEqual(sim.seedWorld(), a);
  assert.equal(store.events.length, n);
});

test('the same seed plays out the same way; another seed differs', () => {
  const runOnce = seed => {
    const w = world({ seed });
    w.sim.seedWorld();
    w.run(3 * MIN);
    const id = w.store.byName('Checkout fix').id;
    w.sim.onAnswer(id, w.store.get(id).ask, 'Allow');
    w.run(2 * MIN);
    return w.store.events;
  };
  const a = runOnce(11);
  const b = runOnce(11);
  assert.ok(a.length > 1000);
  assert.deepEqual(a, b);
  const c = runOnce(12);
  assert.notDeepEqual(c.filter(e => e.kind === EV.CREATED).map(e => e.agentId), a.filter(e => e.kind === EV.CREATED).map(e => e.agentId));
});

test('ticking keeps the working agents busy and leaves the waiting ones alone', () => {
  const { sim, store, run } = world();
  sim.seedWorld();
  const by = Object.fromEntries(store.roots().map(v => [v.name, v]));
  const onbIds = new Set([by.Onboarding.id, ...store.helpersOf(by.Onboarding.id).map(h => h.id)]);
  const before = store.events.length;
  const costBefore = by.Onboarding.usage.costUsd;
  run(60_000);
  const fresh = store.events.slice(before);
  assert.ok(fresh.length > 50);
  assert.ok(fresh.every(e => e.ts > T0 && e.ts <= T0 + 60_000), 'real timestamps, in the minute that passed');
  assert.ok(fresh.every(e => onbIds.has(e.agentId) || e.agentId.startsWith(by.Onboarding.id)), 'only Onboarding and its helpers act');
  for (const id of onbIds) {
    const starts = fresh.filter(e => e.agentId === id && e.kind === EV.ACTIVITY && e.phase === 'start');
    assert.ok(starts.length >= 5, `${id} acts every few seconds (${starts.length} in a minute)`);
    const gaps = starts.slice(1).map((e, i) => e.ts - starts[i].ts);
    assert.ok(Math.max(...gaps) < 20_000, 'never quiet for long');
  }
  assert.ok(fresh.some(e => e.kind === EV.THINKING && e.on), 'thinking blips');
  assert.ok(by.Onboarding.usage.costUsd > costBefore, 'cost grows');
  assert.ok(by.Onboarding.usage.costUsd - costBefore < 0.1, 'by cents');
  for (const name of ['Checkout fix', 'Search cleanup', 'Flaky test', 'Invoice export', 'Help pages']) {
    assert.equal(by[name].state === 'working', false, `${name} still waits`);
  }
  assert.deepEqual(store.errors, []);
});

test('speed multiplies simulated time; 0 pauses', () => {
  const count = speed => {
    const w = world({ speed });
    w.sim.seedWorld();
    const n = w.store.events.length;
    w.run(30_000);
    return w.store.events.length - n;
  };
  assert.equal(count(0), 0);
  const slow = count(1);
  const fast = count(5);
  assert.ok(fast > slow * 3, `speed 5 gave ${fast} events, speed 1 gave ${slow}`);
});

test('a long run stays believable: helpers come and go, the plan moves, cost and context stay sane', () => {
  const { sim, store, run } = world({ speed: 10 });
  sim.seedWorld();
  const onb = store.byName('Onboarding');
  const plan0 = onb.plan.done;
  run(4 * MIN);                       // 40 simulated minutes
  const helpers = store.helpersOf(onb.id);
  assert.ok(helpers.length >= 5, `helpers created (${helpers.length})`);
  assert.ok(helpers.filter(h => h.state === 'finished').length >= 3, 'helpers finished');
  assert.ok(helpers.some(h => h.state === 'working'), 'still has helpers at work');
  assert.ok(onb.plan.done > plan0, 'plan progressed');
  assert.equal(onb.state, 'working');
  assert.ok(onb.usage.costUsd < 2, `cost ${onb.usage.costUsd}`);
  assert.ok(onb.usage.contextPct > 0 && onb.usage.contextPct < 0.8, `context ${onb.usage.contextPct}`);
  assert.ok(T0 + 4 * MIN - onb.lastEventAt < 5000, 'still active at the end');
  assert.ok(store.events.every(e => e.machineId !== 'cloud-2'));
  assert.deepEqual(store.errors, []);
  assertNoTripleRepeats(store, [store.byName('Flaky test').id]);
});

test('topicOf finds a specific word to name things after', () => {
  assert.equal(topicOf('fix the flaky checkout test').key, 'checkout');
  assert.equal(topicOf('fix the flaky checkout test').past, 'fixed');
  assert.equal(topicOf('Start an agent to write tests for the parser').key, 'parser');
  assert.equal(topicOf('have codex speed up greet.js').key, 'greet');
  assert.equal(topicOf('').key, 'project');
  assert.equal(topicOf('the login redirect').past, null);
});

// ---- answers ----

function seeded(opts) {
  const w = world(opts);
  w.sim.seedWorld();
  const id = name => w.store.byName(name).id;
  return { ...w, id };
}

test('Allow: Checkout fix runs the command, carries on and finishes', () => {
  const { sim, store, id, until } = seeded();
  const cid = id('Checkout fix');
  const ask = store.get(cid).ask;
  const n = store.events.length;
  const r = sim.onAnswer(cid, ask, 'Allow');
  assert.deepEqual(r, { ok: true, reply: 'Checkout fix will go ahead.' });
  const right = store.events.slice(n).map(e => e.kind);
  assert.deepEqual(right, [EV.ASK_CLEARED, EV.APPROVAL, EV.STATE]);
  const v = store.get(cid);
  assert.equal(v.state, 'working');
  assert.equal(v.ask, null);
  assert.deepEqual(v.approvals.byYou, 1);
  until(() => store.get(cid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_checked', 'the engine decides once the turn ends, from the checks it reported');
  assert.equal(v.checks.state, 'passed');
  assert.deepEqual(v.checks.results.map(r => r.name), ['Unit tests', 'Type check']);
  assert.match(v.says, /^I fixed the checkout bug/);
  assert.equal(v.plan.done, v.plan.total);
  const end = store.eventsFor(cid).find(e => e.kind === EV.ACTIVITY && e.phase === 'end' && e.sentence === 'Running the db:migrate script');
  assert.equal(end.ok, true, 'the held command ran');
  assert.deepEqual(store.errors, []);
});

test('Deny: Checkout fix tries another way and still finishes', () => {
  const { sim, store, id, until } = seeded();
  const cid = id('Checkout fix');
  const r = sim.onAnswer(cid, store.get(cid).ask, 'Deny');
  assert.equal(r.reply, 'Checkout fix will not do that and will try another way.');
  const v = store.get(cid);
  assert.equal(v.approvals.denied, 1);
  const end = store.eventsFor(cid).filter(e => e.kind === EV.ACTIVITY && e.phase === 'end').at(-1);
  assert.equal(end.sentence, 'Running the db:migrate script');
  assert.equal(end.ok, false, 'the denied step failed');
  until(() => store.get(cid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_checked');
  assert.match(v.says, /without changing the shared test database/);
  assert.ok(store.eventsFor(cid).some(e => e.kind === EV.ACTIVITY && e.sentence === 'Editing setup.ts'), 'another way');
});

test('a question answer starts a new turn', () => {
  for (const [answer, expect] of [['Keep it working', /kept the old search address/], ['Remove it', /removed the old search address/], ['Ask the team first', /followed your answer/]]) {
    const { sim, store, id, until } = seeded();
    const sid = id('Search cleanup');
    const r = sim.onAnswer(sid, store.get(sid).ask, answer);
    assert.equal(r.ok, true);
    const v = store.get(sid);
    assert.equal(v.turns, 2);
    assert.equal(v.state, 'working');
    assert.equal(v.ask, null);
    until(() => store.get(sid).state !== 'working', 3 * MIN);
    assert.equal(v.state, 'done_checked', answer);
    assert.match(v.says, expect);
  }
});

test('Stop it stops Flaky test for good', () => {
  const { sim, store, id, run } = seeded();
  const fid = id('Flaky test');
  const r = sim.onAnswer(fid, store.get(fid).ask, 'Stop it');
  assert.deepEqual(r, { ok: true, reply: 'Flaky test is stopped.' });
  const v = store.get(fid);
  assert.equal(v.state, 'stopped');
  assert.equal(v.ask, null);
  assert.ok(v.endedAt);
  const n = store.eventsFor(fid).length;
  run(2 * MIN);
  assert.equal(store.eventsFor(fid).length, n, 'nothing more from it');
  assert.equal(sim.onAnswer(fid, null, 'try again').ok, false);
});

test('Let it keep trying: Flaky test tries something new and gets there', () => {
  const { sim, store, id, until } = seeded();
  const fid = id('Flaky test');
  assert.equal(sim.onAnswer(fid, store.get(fid).ask, 'Let it keep trying').reply, 'Flaky test will keep trying.');
  const v = store.get(fid);
  assert.equal(v.state, 'working');
  assert.equal(v.ask, null);
  const n = store.events.length;
  until(() => store.get(fid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_checked');
  assert.match(v.says, /rounded at different steps/);
  const after = store.events.slice(n).filter(e => e.agentId === fid && e.kind === EV.ACTIVITY && e.phase === 'end');
  assert.ok(after.every(e => e.ok), 'no more failures');
});

test('each ask moves an agent on once, whichever way the answer arrives', () => {
  const { sim, store, id, run } = seeded();
  const cid = id('Checkout fix');
  const ask = store.get(cid).ask;
  sim.onAnswer(cid, ask, 'Allow');
  const n = store.events.length;
  assert.deepEqual(sim.onAnswer(cid, ask, 'Allow'), { ok: true, reply: 'That was already answered.' });
  assert.equal(store.events.length, n);

  const sid = id('Search cleanup');
  const q = store.get(sid).ask;
  sim.onAnswer(sid, q, 'Keep it working');
  sim.runnerFor(sid).send('Keep it working');      // the same answer by the other route
  run(5000);
  assert.equal(store.get(sid).turns, 2, 'one new turn, not two');

  assert.deepEqual(sim.onAnswer('nope00', null, 'Allow'), { ok: false, reply: 'That agent is not part of the demo.' });
});

test('the demo takes answers by the same rules as the engine: only "Allow" allows, and an answer names its ask', () => {
  // Words that sound like a yes, or a yes with conditions, are a no.
  for (const words of ['yes', 'go ahead', 'yes but only in the tests folder', 'OK']) {
    const { sim, store, id } = seeded();
    const cid = id('Checkout fix');
    const r = sim.onAnswer(cid, store.get(cid).ask, words);
    assert.equal(r.reply, 'Checkout fix will not do that and will try another way.', words);
    assert.equal(store.get(cid).approvals.denied, 1, words);
    assert.equal(store.get(cid).approvals.byYou, 0, words);
  }
  // An answer that names no ask is a message: the request keeps waiting.
  const { sim, store, id } = seeded();
  const cid = id('Checkout fix');
  const ask = store.get(cid).ask;
  assert.equal(sim.onAnswer(cid, null, 'Allow').reply, 'Checkout fix got your message and will take it into account.');
  assert.equal(store.get(cid).state, 'needs_ok');
  assert.equal(store.get(cid).ask.id, ask.id);
  assert.equal(sim.say(cid, 'go ahead and finish it').ok, true);
  assert.equal(store.get(cid).state, 'needs_ok');
  // A stuck agent stops only on "Stop it": other words that start with "stop" are a hint.
  const fid = id('Flaky test');
  assert.equal(sim.onAnswer(fid, store.get(fid).ask, 'stop using the old fixture').reply, 'Flaky test will try your hint.');
  assert.equal(store.get(fid).state, 'working');
});

test('finished demo agents take follow-ups', () => {
  const { sim, store, id, until } = seeded();
  const iid = id('Invoice export');
  assert.equal(sim.say(iid, 'Keep it').reply, 'Invoice export is left as it is.');
  assert.equal(store.get(iid).state, 'done_checked');
  const r = sim.onAnswer(iid, null, 'Undo that part');
  assert.equal(r.ok, true);
  const v = store.get(iid);
  assert.equal(v.state, 'working');
  until(() => store.get(iid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_checked');
  assert.match(v.says, /took out the database change/);
  assert.ok(!v.files.list.some(f => f.path.startsWith('migrations/')), 'the migration is gone from the changes');

  // "Nothing was set up to check it" until the person asks for a check.
  const hid = id('Help pages');
  sim.say(hid, 'Get it checked');
  until(() => store.get(hid).state !== 'working', 3 * MIN);
  assert.equal(store.get(hid).state, 'done_checked');
  assert.match(store.get(hid).says, /checked the three help pages/);
});

test('stopping a seeded agent through its runner handle ends its helpers too', () => {
  const { sim, store, id, run } = seeded();
  const oid = id('Onboarding');
  const runner = sim.runnerFor(oid);
  assert.equal(runner.info().alive, true);
  runner.stop();
  for (const h of store.helpersOf(oid)) assert.equal(h.state, 'stopped');
  assert.ok(store.get(oid).endedAt, 'agent.ended for the root');
  assert.notEqual(store.get(oid).state, 'stopped', 'the engine emits the root state after stop()');
  assert.equal(runner.info().alive, false);
  const n = store.events.length;
  run(MIN);
  assert.equal(store.events.length, n, 'everything went quiet');
});

// ---- runners for new tasks ----

/** Start a runner, answer whatever it asks right away, and tick until its final turn ends. */
function playRunner({ seed = 5, task = 'fix the flaky checkout test', agentId = 'a1b2c3', speed = 1, permission = 'Allow', answer = 'Yes please', extra = {} } = {}) {
  const w = world({ seed, speed });
  const mine = createFakeStore();
  const runner = w.sim.createRunner({ agentId, name: nameFromTask(task), task, emit: mine.emit, ...extra });
  // What the engine does before starting a runner.
  mine.emit({ kind: EV.CREATED, ts: w.clock.t, agentId, parentId: null, name: nameFromTask(task), task, harness: 'sim', machineId: 'cloud-1' });
  mine.emit({ kind: EV.STATE, ts: w.clock.t, agentId, state: 'starting' });
  const startedAt = w.clock.t;
  runner.start();
  let waited = 0;
  let questions = 0;
  let permissions = 0;
  const finished = () => ['done_claimed', 'done_checked', 'failed'].includes(mine.get(agentId).state);
  for (let i = 0; i < 2000 && !finished(); i++) {
    const v = mine.get(agentId);
    if (v.state === 'needs_ok' && v.ask) { permissions++; w.sim.onAnswer(agentId, v.ask, permission); }
    else if (v.state === 'question' && v.ask) { questions++; runner.send(answer); }
    else { w.clock.t += 1000; w.sim.tick(w.clock.t); }
    if (v.state === 'needs_ok' || v.state === 'question') waited++;
  }
  return { ...w, mine, runner, agentId, startedAt, questions, permissions, waited };
}

test('a new task gets a scripted tree and finishes', () => {
  const p = playRunner();
  const { mine, agentId, runner, store } = p;
  assert.equal(store.events.length, 0, 'events go to the runner\'s own emit');
  assert.deepEqual(mine.errors, []);
  const v = mine.get(agentId);
  assert.equal(v.state, v.checks && v.checks.state === 'passed' ? 'done_checked' : 'done_claimed');
  assert.ok(v.plan.total >= 3 && v.plan.total <= 5, `plan of ${v.plan.total}`);
  assert.equal(v.plan.done, v.plan.total);
  const helpers = mine.helpersOf(agentId);
  assert.ok(helpers.length >= 1 && helpers.length <= 3, `${helpers.length} helpers`);
  for (const h of helpers) {
    assert.equal(h.state, 'finished');
    assert.match(h.name, /checkout/i, 'helpers are named from the task');
    assert.ok(h.says);
  }
  assert.ok(v.files.changed >= 1);
  assert.ok(v.usage.costUsd > 0.01 && v.usage.costUsd < 1, `cost ${v.usage.costUsd}`);
  assert.match(v.says, /^I fixed the flaky checkout test\./);
  assert.ok(mine.events.some(e => e.kind === EV.ACTIVITY && e.sentence === 'Asking a helper to ' + helpers[0].task.charAt(0).toLowerCase() + helpers[0].task.slice(1)));
  const info = runner.info();
  assert.equal(info.pid, null);
  assert.equal(info.alive, true);
  assert.match(info.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(v.sessionId, info.sessionId);
  assertNoTripleRepeats(mine);
});

test('scripted runs take about 40 to 90 simulated seconds, sometimes ask, sometimes question', () => {
  let asked = 0, questioned = 0, waitedOnHelpers = 0;
  const tasks = ['fix the flaky checkout test', 'write tests for the parser', 'update the billing docs', 'remove the old export code', 'make the search page faster'];
  for (let seed = 1; seed <= 30; seed++) {
    const task = tasks[seed % tasks.length];
    const p = playRunner({ seed, task, agentId: `r${String(seed).padStart(5, '0')}`, permission: seed % 2 ? 'Allow' : 'Deny', answer: seed % 3 ? 'yes' : 'no' });
    const v = p.mine.get(p.agentId);
    assert.equal(v.state, v.checks && v.checks.state === 'passed' ? 'done_checked' : 'done_claimed', `${task} (seed ${seed})`);
    assert.deepEqual(p.mine.errors, []);
    const firstEnd = p.mine.events.find(e => e.kind === EV.TURN && e.phase === 'end' && !(e.backgroundTasks > 0));
    const work = (firstEnd.ts - p.startedAt) / 1000;   // speed 1: real seconds are simulated seconds
    assert.ok(work >= 35 && work <= 100, `${task} (seed ${seed}) took ${work} s`);
    assert.equal(firstEnd.backgroundTasks, 0, 'every helper had finished');
    if (p.permissions) asked++;
    if (p.questions) questioned++;
    if (p.mine.derived.some(e => e.state === 'waiting_helpers')) waitedOnHelpers++;
    assert.ok(extractQuestion(firstEnd.finalText) ? p.questions === 1 : p.questions === 0);
  }
  assert.ok(asked >= 5 && asked <= 25, `${asked} of 30 asked permission`);
  assert.ok(questioned >= 4 && questioned <= 22, `${questioned} of 30 ended with a question`);
  assert.ok(waitedOnHelpers >= 1, 'some waited on their helpers');
});

test('a runner finishes quickly at high speed', () => {
  const p = playRunner({ speed: 50, seed: 9 });
  assert.match(p.mine.get(p.agentId).state, /^done_/);
  assert.ok(p.clock.t - p.startedAt <= 10_000, `took ${p.clock.t - p.startedAt} ms of real time`);
});

test('a runner asks permission the way the engine would, and Deny is respected', () => {
  let found = null;
  for (let seed = 1; seed < 40 && !found; seed++) {
    const p = playRunner({ seed, permission: 'Deny', agentId: 'b00001' });
    if (p.permissions) found = p;
  }
  assert.ok(found, 'some seed asks permission');
  const asks = found.mine.events.filter(e => e.kind === EV.ASK && e.ask.type === 'permission');
  assert.equal(asks.length, 1);
  const ask = asks[0].ask;
  assert.match(ask.sentence, /^Fix flaky checkout test wants to /);
  assert.deepEqual(ask.options, ['Allow', 'Deny']);
  assert.equal(ask.primary, 'Allow');
  assert.ok(ask.detail);
  // Why it asks, in the permission check's own words for that kind of step.
  assert.equal(ask.why, /^https?:/.test(ask.detail) ? 'Opening a web page needs your OK.' : 'This command is not on the list of safe commands.');
  const v = found.mine.get(found.agentId);
  assert.equal(v.approvals.denied, 1);
  assert.match(v.says + ' ' + found.mine.events.filter(e => e.kind === EV.TURN && e.finalText).map(e => e.finalText).join(' '), /I did not /);
});

test('a runner answers its closing question with a new turn', () => {
  let found = null;
  for (let seed = 1; seed < 40 && !found; seed++) {
    const p = playRunner({ seed, agentId: 'c00001', answer: 'yes' });
    if (p.questions) found = p;
  }
  assert.ok(found, 'some seed ends with a question');
  const v = found.mine.get(found.agentId);
  assert.match(v.state, /^done_/);
  const ends = found.mine.events.filter(e => e.kind === EV.TURN && e.phase === 'end' && !(e.backgroundTasks > 0));
  assert.equal(ends.length, 2);
  assert.ok(extractQuestion(ends[0].finalText));
  assert.equal(extractQuestion(ends[1].finalText), null);
});

test('runner.stop() ends the tree and goes quiet', () => {
  const w = world();
  const mine = createFakeStore();
  const runner = w.sim.createRunner({ agentId: 'd00001', name: 'Fix login', task: 'fix the login redirect', emit: mine.emit });
  mine.emit({ kind: EV.CREATED, ts: w.clock.t, agentId: 'd00001', parentId: null, name: 'Fix login', task: 'fix the login redirect', harness: 'sim', machineId: 'laptop' });
  assert.equal(runner.info().alive, false, 'not started yet');
  runner.start();
  runner.start();   // starting twice does nothing
  w.until(() => mine.helpersOf('d00001').some(h => h.state === 'working'), MIN);
  runner.stop();
  assert.ok(mine.helpersOf('d00001').every(h => h.state === 'stopped' || h.state === 'finished'));
  assert.ok(mine.get('d00001').endedAt);
  assert.equal(mine.events.at(-1).kind, EV.ENDED);
  assert.equal(mine.events.at(-1).outcome, 'stopped');
  assert.equal(runner.info().alive, false);
  const n = mine.events.length;
  w.run(2 * MIN);
  assert.equal(mine.events.length, n);
});

test('a runner stops at its budget like Claude Code does', () => {
  const p = playRunner({ seed: 3, agentId: 'e00001', extra: { budgetUsd: 0.05 } });
  const v = p.mine.get(p.agentId);
  assert.equal(v.state, 'failed');
  assert.match(v.stateReason, /reached its budget of \$0\.05/);
  assert.ok(v.usage.costUsd >= 0.05 && v.usage.costUsd < 0.08);
  assert.ok(p.mine.helpersOf(p.agentId).every(h => h.state !== 'working'));
});

test('a Codex task in demo mode looks like Codex: no helpers, no asks, no cost', () => {
  const p = playRunner({ seed: 4, agentId: 'f00001', task: 'have codex write tests for the parser', extra: { harness: 'codex' } });
  const v = p.mine.get(p.agentId);
  assert.equal(v.state, 'done_claimed');
  assert.equal(p.mine.helpersOf(p.agentId).length, 0);
  assert.equal(p.permissions, 0);
  assert.equal(v.usage.costUsd, null);
  assert.equal(v.model, 'gpt-5-codex');
});

test('hints while working are taken into account', () => {
  const w = world();
  const mine = createFakeStore();
  const runner = w.sim.createRunner({ agentId: 'g00001', task: 'fix the login redirect', emit: mine.emit, name: 'Fix login' });
  mine.emit({ kind: EV.CREATED, ts: w.clock.t, agentId: 'g00001', parentId: null, name: 'Fix login', task: 'fix the login redirect', harness: 'sim', machineId: 'laptop' });
  runner.start();
  w.run(5000);
  runner.send('the redirect lives in auth.ts');
  w.until(() => ['done_claimed', 'question', 'needs_ok'].includes(mine.get('g00001').state), 3 * MIN);
  const v = mine.get('g00001');
  if (v.state === 'needs_ok') { w.sim.onAnswer('g00001', v.ask, 'Allow'); w.until(() => mine.get('g00001').state !== 'working', 3 * MIN); }
  const text = mine.events.filter(e => e.kind === EV.TURN && e.finalText).map(e => e.finalText).join(' ');
  assert.match(text, /took your note into account/);
});

// ---- the demo's git repository ----

const HEX40 = /^[0-9a-f]{40}$/;
const SEEDED = ['Checkout fix', 'Search cleanup', 'Flaky test', 'Invoice export', 'Help pages', 'Onboarding'];
const SLUGS = {
  'Checkout fix': 'checkout-fix', 'Search cleanup': 'search-cleanup', 'Flaky test': 'flaky-test',
  'Invoice export': 'invoice-export', 'Help pages': 'help-pages', Onboarding: 'onboarding',
};
const COMMIT_KEYS = ['id', 'parents', 'subject', 'author', 'at', 'refs', 'agentId', 'kind'];
const AGENT_KEYS = ['id', 'name', 'state', 'earlier', 'harness', 'branch', 'from', 'base', 'since', 'files', 'work'];
const NO_FILES = { changed: 0, adds: 0, dels: 0, list: [] };
const MERGED = 'This is the demo: nothing was really merged.';
const THROWN = 'This is the demo: nothing was really thrown away.';
const sec = ms => Math.floor(ms / 1000) * 1000;
const sum = (list, k) => list.reduce((s, f) => s + f[k], 0);

/** Your branch: main's first-parent line from its tip, newest first. */
function trunkOf(g) {
  const byId = new Map(g.commits.map(c => [c.id, c]));
  const out = [];
  for (let c = byId.get(g.head); c; c = byId.get(c.parents[0])) out.push(c);
  return out;
}

/** Git with nothing of this machine's own settings, identity or home folder. */
function gitIn(dir) {
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
  return (args, { input, extra } = {}) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args],
    { cwd: dir, env: { ...env, ...extra }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * The graph as git itself lists it. A real repository gets the same commits (each with an empty tree, the same
 * parents, author and time, and the trailers Workbench writes on work and merge commits) and the same branches; it is
 * then read back the way workspace.mjs's gitGraph reads one: `git log --topo-order` from HEAD and every workbench/*
 * branch, with agentId and kind taken from the trailers.
 */
function asGitListsIt(g) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sim-git-'));
  try {
    const git = gitIn(dir);
    git(['init', '-q', '-b', 'main']);
    // One fast-import stream, oldest first: each commit on a ref of its own, its parents named by their marks.
    const mark = new Map(g.commits.map((c, i) => [c.id, i + 1]));
    let stream = '';
    for (const c of [...g.commits].reverse()) {
      const message = c.kind === 'commit' ? `${c.subject}\n` : `${c.subject}\n\nWorkbench-Agent: ${c.agentId}\nWorkbench-Kind: ${c.kind}\n`;
      const who = `${c.author} <demo@example.invalid> ${c.at / 1000} +0000`;
      stream += `commit refs/sim/${mark.get(c.id)}\nmark :${mark.get(c.id)}\nauthor ${who}\ncommitter ${who}\n`;
      stream += `data ${Buffer.byteLength(message)}\n${message}\n`;
      c.parents.forEach((p, k) => { stream += `${k ? 'merge' : 'from'} :${mark.get(p)}\n`; });
      stream += '\n';
    }
    for (const c of g.commits) for (const ref of c.refs) stream += `reset refs/heads/${ref}\nfrom :${mark.get(c.id)}\n\n`;
    const marks = path.join(dir, 'marks');
    git(['fast-import', '--quiet', `--export-marks=${marks}`], { input: stream });
    const byMark = new Map([...mark].map(([id, m]) => [`:${m}`, id]));
    const ours = new Map(fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')).map(([m, oid]) => [oid, byMark.get(m)]));
    const names = new Map();
    for (const line of git(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/']).split('\n').filter(Boolean)) {
      const [oid, name] = line.split(' ');
      if (!names.has(oid)) names.set(oid, []);
      names.get(oid).push(name);
    }
    const tips = ['HEAD', ...[...names].filter(([, n]) => n.some(x => x.startsWith('workbench/'))).map(([oid]) => oid)];
    const format = ['%H', '%P', '%an', '%at', '%s', '%(trailers:key=Workbench-Agent,valueonly,unfold,separator=%x2C)',
      '%(trailers:key=Workbench-Kind,valueonly,unfold,separator=%x2C)'].join('%x00') + '%x00';
    const out = git(['-c', 'trailer.separators=:', 'log', '--topo-order', `--format=tformat:${format}`, '--stdin'], { input: `${tips.join('\n')}\n` });
    const last = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean).pop() || '';
    const fields = out.split('\0');
    const listed = [];
    for (let i = 0; i + 7 <= fields.length; i += 7) {
      const id = fields[i].replace(/^\n/, '');
      if (!id) break;
      const parents = fields[i + 1] ? fields[i + 1].split(' ') : [];
      const agent = last(fields[i + 5]);
      const word = last(fields[i + 6]);
      listed.push({
        id: ours.get(id), parents: parents.map(p => ours.get(p)), subject: fields[i + 4], author: fields[i + 2], at: Number(fields[i + 3]) * 1000,
        refs: (names.get(id) || []).slice().sort((x, y) => (x === 'main' ? -1 : y === 'main' ? 1 : x < y ? -1 : 1)),
        agentId: /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(agent) ? agent : null,
        kind: word === 'merge' && parents.length > 1 ? 'merge' : word === 'work' ? 'work' : 'commit',
      });
    }
    return listed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One file's patch, read as git prints one: its header lines, then hunks whose counts and line numbers add up to
 * exactly the file's adds and dels.
 */
function checkPatch(f) {
  const p = f.patch;
  assert.equal(typeof p, 'string', f.path);
  assert.ok(p.endsWith('\n'), `${f.path}: ends with a new line`);
  assert.doesNotMatch(p, /\r/);
  const lines = p.slice(0, -1).split('\n');
  assert.equal(lines[0], `diff --git a/${f.path} b/${f.path}`);
  const head = {
    added: ['new file mode 100644', /^index 0000000\.\.[0-9a-f]{7}$/, '--- /dev/null', `+++ b/${f.path}`],
    deleted: ['deleted file mode 100644', /^index [0-9a-f]{7}\.\.0000000$/, `--- a/${f.path}`, '+++ /dev/null'],
    modified: [/^index [0-9a-f]{7}\.\.[0-9a-f]{7} 100644$/, `--- a/${f.path}`, `+++ b/${f.path}`],
  }[f.status];
  assert.ok(head, `${f.path}: status ${f.status}`);
  head.forEach((want, k) => (typeof want === 'string' ? assert.equal(lines[1 + k], want) : assert.match(lines[1 + k], want)));
  let i = 1 + head.length;
  let adds = 0, dels = 0, shift = 0, oldEnd = 0, hunks = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .+)?$/.exec(lines[i]);
    assert.ok(m, `${f.path}: a hunk starts at "${lines[i]}"`);
    hunks++;
    const [oldAt, oldLen, newAt, newLen] = [+m[1], m[2] === undefined ? 1 : +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    let o = 0, n = 0;
    for (i++; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const c = lines[i].charAt(0);
      if (c === '+') { n++; adds++; } else if (c === '-') { o++; dels++; } else if (c === ' ') { o++; n++; } else assert.fail(`${f.path}: a hunk line starts with "${c}"`);
    }
    assert.equal(o, oldLen, `${f.path}: old lines in "${m[0]}"`);
    assert.equal(n, newLen, `${f.path}: new lines in "${m[0]}"`);
    if (f.status === 'added') assert.deepEqual([oldAt, oldLen, newAt], [0, 0, 1]);
    else if (f.status === 'deleted') assert.deepEqual([oldAt, newAt, newLen], [1, 0, 0]);
    else {
      assert.ok(oldAt > oldEnd, `${f.path}: hunks in order, apart`);
      assert.equal(newAt, oldAt + shift, `${f.path}: where "${m[0]}" lands`);
      shift += newLen - oldLen;
      oldEnd = oldAt + oldLen - 1;
    }
  }
  assert.ok(hunks >= 1, `${f.path}: at least one hunk`);
  assert.equal(adds, f.adds, `${f.path}: added lines`);
  assert.equal(dels, f.dels, `${f.path}: removed lines`);
}

/** What `git apply --numstat --summary` reads from the patches: each file's counts, and the files made or deleted. */
function gitReads(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sim-apply-'));
  try {
    fs.writeFileSync(path.join(dir, 'work.patch'), files.map(f => f.patch).join(''));
    return gitIn(dir)(['apply', '--numstat', '--summary', 'work.patch']).split('\n').filter(Boolean);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The lines gitReads() should give for these files. */
const readAs = files => [
  ...files.map(f => `${f.adds}\t${f.dels}\t${f.path}`),
  ...files.filter(f => f.status !== 'modified').map(f => ` ${f.status === 'added' ? 'create' : 'delete'} mode 100644 ${f.path}`),
];

test('git: every seeded root gets its own branch as it starts, recorded with agent.work as the engine records a real one', () => {
  const { sim, store } = world();
  sim.seedWorld();
  assert.deepEqual(store.errors, []);
  for (const v of store.roots()) {
    assert.deepEqual(v.work, { branch: `workbench/${SLUGS[v.name]}-${v.id}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null }, v.name);
    const mine = store.eventsFor(v.id);
    assert.deepEqual(mine.slice(0, 3).map(e => e.kind), [EV.CREATED, EV.STATE, WORK], `${v.name}: its branch is made as it starts`);
    assert.equal(mine[2].ts, mine[0].ts);
    assert.equal(mine.filter(e => e.kind === WORK).length, 1);
  }
  for (const h of store.list().filter(v => v.parentId)) assert.equal(h.work ?? null, null, 'a helper works in its agent’s folder');
});

test('git: the graph is shaped like gitGraph(): about 30 commits by you and by agents, newest first in topological order', () => {
  const { sim, store } = world();
  sim.seedWorld();
  const n = store.events.length;
  const g = sim.gitGraph();
  assert.equal(store.events.length, n, 'looking emits nothing');
  assert.deepEqual(Object.keys(g), ['ok', 'head', 'branch', 'repo', 'commits', 'more', 'agents']);
  assert.equal(g.ok, true);
  assert.equal(g.branch, 'main');
  assert.match(g.head, HEX40);
  assert.deepEqual(g.repo, { name: 'storefront', branch: 'main', head: g.head, dirty: 2, identity: true });
  assert.equal(g.more, false);
  assert.ok(g.commits.length >= 25 && g.commits.length <= 35, `${g.commits.length} commits`);
  const index = new Map(g.commits.map((c, i) => [c.id, i]));
  assert.equal(index.size, g.commits.length, 'each commit once');
  for (const [i, c] of g.commits.entries()) {
    assert.deepEqual(Object.keys(c), COMMIT_KEYS);
    assert.match(c.id, HEX40);
    assert.ok(Number.isInteger(c.at) && c.at % 1000 === 0 && c.at < T0, 'author time in ms, in whole seconds, in the past');
    for (const p of c.parents) {
      assert.ok(index.get(p) > i, 'every parent is listed, after all of its children');
      assert.ok(g.commits[index.get(p)].at < c.at, 'and is older');
    }
    assert.ok(['commit', 'merge', 'work'].includes(c.kind));
    assert.ok(c.subject.length > 0 && !/\n/.test(c.subject));
  }
  assert.equal(g.commits[0].id, g.head, 'the newest commit is main’s tip');
  assert.deepEqual(g.commits.filter(c => !c.parents.length).map(c => c.subject), ['Initial commit']);

  // Your own commits: by "you", no agent, subjects in the style of a real project.
  const yours = g.commits.filter(c => c.kind === 'commit');
  assert.ok(yours.length >= 20);
  for (const c of yours) {
    assert.equal(c.author, 'you');
    assert.equal(c.agentId, null);
    assert.ok(c.parents.length <= 1);
    assert.match(c.subject, /^[A-Z][a-z]+ \S.*[^.\s]$/, 'an imperative sentence without a closing full stop');
    assert.ok(c.subject.length <= 72);
  }
  // Two agents' work merged earlier today: a work commit by the agent on its own branch, joined into main by your merge
  // commit; both carry the agent's id, as their trailers say.
  const trunk = new Set(trunkOf(g).map(c => c.id));
  const merges = g.commits.filter(c => c.kind === 'merge');
  assert.equal(merges.length, 2);
  assert.equal(g.commits.filter(c => c.kind === 'work').length, 2);
  for (const m of merges) {
    assert.ok(trunk.has(m.id), 'on your branch');
    assert.equal(m.parents.length, 2);
    assert.equal(m.author, 'you');
    const w = g.commits[index.get(m.parents[1])];
    assert.equal(w.kind, 'work');
    assert.match(w.agentId, /^[0-9a-f]{6}$/);
    assert.equal(m.agentId, w.agentId);
    assert.equal(m.subject, `Merge ${w.author}: ${w.subject}`);
    assert.ok(!trunk.has(w.id) && trunk.has(w.parents[0]), 'its branch left yours where the agent started');
    assert.equal(store.get(w.agentId), undefined, 'an agent from earlier, no longer on the board');
  }
  assert.deepEqual(merges.map(m => g.commits[index.get(m.parents[1])].author), ['New search page', 'Payment retry']);
  // Branches: main at its tip, each seeded root's where it started, nothing else; main first, then by name.
  const refs = g.commits.flatMap(c => c.refs.map(r => [r, c.id]));
  assert.deepEqual(refs.map(([r]) => r).sort(), ['main', ...store.roots().map(v => v.work.branch)].sort());
  assert.equal(new Map(refs).get('main'), g.head);
  for (const c of g.commits) assert.deepEqual(c.refs, [...c.refs].sort((x, y) => (x === 'main' ? -1 : y === 'main' ? 1 : x < y ? -1 : 1)));
});

test('git: the graph agrees with the seeded agents (names, states, files, work), and each branch leaves main where it started', () => {
  const { sim, store } = world();
  sim.seedWorld();
  const g = sim.gitGraph();
  const byId = new Map(g.commits.map(c => [c.id, c]));
  const trunk = trunkOf(g);
  assert.deepEqual(g.agents.map(a => a.name), SEEDED);
  for (const a of g.agents) {
    const v = store.get(a.id);
    assert.deepEqual(Object.keys(a), AGENT_KEYS);
    assert.equal(a.state, v.state, `${a.name} is ${v.state}`);
    assert.equal(a.harness, v.harness);
    assert.equal(a.earlier, false);
    assert.equal(a.branch, v.work.branch);
    assert.equal(a.from, 'main');
    assert.deepEqual(a.files, v.files, `${a.name}: its unmerged files`);
    assert.deepEqual(a.work, v.work);
    assert.equal(a.since, a.base, 'nothing of it is merged yet');
    // It started from what was newest on main then, and main moved on since.
    const k = trunk.findIndex(c => c.id === a.base);
    assert.ok(k > 0, `${a.name} started from a commit on main`);
    assert.ok(trunk[k].at <= v.startedAt && trunk[k - 1].at > v.startedAt, `${a.name} started from main’s tip at the time`);
    assert.ok(byId.get(a.base).refs.includes(a.branch));
  }
  // You changed the billing help on main after Help pages started: that is what its work clashes with.
  const help = g.agents.find(a => a.name === 'Help pages');
  const k = trunk.findIndex(c => c.id === help.base);
  assert.ok(trunk.slice(0, k).some(c => c.subject === 'Update the billing help for annual plans'));
  assert.ok(store.get(help.id).files.list.some(f => f.path === 'docs/help/billing.md'));
  // The engine's views, when it passes them, say what the page shows.
  const iid = store.byName('Invoice export').id;
  store.get(iid).state = 'stopped';
  assert.equal(sim.gitGraph({ views: id => store.get(id) }).agents.find(a => a.id === iid).state, 'stopped');
  assert.equal(sim.gitGraph({ views: store.list() }).agents.find(a => a.id === iid).state, 'stopped');
  assert.equal(sim.gitGraph().agents.find(a => a.id === iid).state, 'done_checked', 'else its own record');
});

test('git: the graph is what git itself lists for the same commits: order, parents, authors, times, branches and trailers', () => {
  const { sim } = world();
  sim.seedWorld();
  const g = sim.gitGraph();
  assert.deepEqual(asGitListsIt(g), g.commits);
});

test('git: the same seed and clock give the same graph, another seed other ids; looking changes nothing', () => {
  const graphOf = seed => {
    const w = world({ seed });
    w.sim.seedWorld();
    return w.sim.gitGraph();
  };
  const a = graphOf(7);
  assert.deepEqual(graphOf(7), a);
  const c = graphOf(8);
  assert.notDeepEqual(c.commits.map(x => x.id), a.commits.map(x => x.id));
  assert.deepEqual(c.commits.map(x => x.subject), a.commits.map(x => x.subject), 'the same history');
  // At most `limit` commits, and `more` when there are others.
  const some = (() => { const w = world({ seed: 7 }); w.sim.seedWorld(); return w.sim.gitGraph({ limit: 10 }); })();
  assert.deepEqual(some.commits, a.commits.slice(0, 10));
  assert.equal(some.more, true);
  // Looking at the graph, a diff or a card neither emits anything nor changes how the demo plays out.
  const play = look => {
    const w = world({ seed: 11 });
    w.sim.seedWorld();
    const ids = w.store.list().map(v => v.id);
    for (let i = 0; i < 60; i++) {
      w.clock.t += 1000;
      w.sim.tick(w.clock.t);
      if (look) for (const id of ids) { w.sim.gitGraph(); w.sim.changes(id); w.sim.proposeMerge(id); w.sim.proposeDiscard(id); }
    }
    return w.store.events;
  };
  assert.deepEqual(play(true), play(false));
});

test('git: changes() is a unified diff of exactly the files the agent changed, in workDiff’s shape, and git reads it', () => {
  const { sim, store } = world();
  sim.seedWorld();
  const g = sim.gitGraph();
  for (const v of store.roots()) {
    const d = sim.changes(v.id);
    const a = g.agents.find(x => x.id === v.id);
    assert.deepEqual(Object.keys(d), ['workId', 'since', 'head', 'files', 'left', 'omitted']);
    assert.equal(d.since, a.base);
    assert.equal(d.head, a.base, 'nothing of it is committed yet');
    assert.match(d.workId, new RegExp(`^${a.base}:[0-9a-f]{40}$`));
    assert.deepEqual(d.left, []);
    assert.equal(d.omitted, 0);
    assert.deepEqual(d.files.map(f => [f.path, f.adds, f.dels]), v.files.list.map(f => [f.path, f.adds, f.dels]), `${v.name}: the files its card lists`);
    for (const f of d.files) {
      assert.deepEqual(Object.keys(f), ['path', 'status', 'adds', 'dels', 'patch']);
      checkPatch(f);
    }
    assert.deepEqual(gitReads(d.files), readAs(d.files), `${v.name}: as git reads it`);
    assert.deepEqual(sim.changes(v.id), d, 'the same every time');
  }
  // Invoice export added three files and changed two; a new file is all new lines.
  const inv = sim.changes(store.byName('Invoice export').id);
  assert.deepEqual(inv.files.map(f => [f.path, f.status]), [
    ['src/invoices/batch.ts', 'added'], ['src/invoices/export.ts', 'modified'], ['src/invoices/query.ts', 'modified'],
    ['migrations/0042_invoice_lookup_index.sql', 'added'], ['test/invoices/large-account.test.ts', 'added'],
  ]);
  for (const f of inv.files.filter(x => x.status === 'added')) assert.equal(f.dels, 0);
  // A helper's id gives its agent's work, and a shorter list says how many files it left out.
  const cid = store.byName('Checkout fix').id;
  assert.deepEqual(sim.changes(store.helpersOf(cid)[0].id), sim.changes(cid));
  const two = sim.changes(cid, { maxFiles: 2 });
  assert.deepEqual(two.files, sim.changes(cid).files.slice(0, 2));
  assert.equal(two.omitted, store.get(cid).files.changed - 2);
  assert.deepEqual(sim.changes('nope00'), { ok: false, reply: 'That agent is not part of the demo.' });
});

test('git: the diffs of many seeds are all well formed, and git reads every one with the same counts', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { sim, store } = world({ seed });
    sim.seedWorld();
    const files = store.roots().flatMap(v => sim.changes(v.id).files);
    for (const f of files) checkPatch(f);
    assert.deepEqual(gitReads(files), readAs(files), `seed ${seed}`);
  }
});

test('git: Invoice export merges: its work becomes a commit on its branch, and a merge commit joins it into main', () => {
  const { sim, store, id, clock, until } = seeded();
  const iid = id('Invoice export');
  const v = store.get(iid);
  const before = sim.gitGraph();
  const mine = before.agents.find(a => a.id === iid);
  const adds = sum(v.files.list, 'adds');
  const dels = sum(v.files.list, 'dels');
  assert.equal(v.files.changed, 5);
  const merging = sim.changes(iid);
  const n = store.events.length;
  const card = sim.proposeMerge(iid);
  assert.equal(store.events.length, n, 'a card changes nothing');
  assert.deepEqual(card, {
    ok: true, agentId: iid, kind: 'merge', into: 'main', sentence: 'Merge Invoice export into main?',
    detail: `5 files, +${adds} −${dels}. Its work becomes a commit on its branch, joined into main by a merge commit. It broke a rule you set: Do not touch migrations/. Your 2 uncommitted changes stay as they are. This is the demo, so nothing is really merged.`,
    yes: 'Merge', no: 'Cancel', danger: false, reply: 'Merge Invoice export into main?', files: 5, adds, dels,
    expect: { workId: sim.changes(iid).workId, into: 'main', intoHead: before.head },
  });

  clock.t += 30_000;
  const res = sim.merge(iid, { expect: card.expect });
  assert.deepEqual(Object.keys(res), ['ok', 'into', 'merge', 'work', 'files', 'adds', 'dels', 'reply']);
  assert.equal(res.ok, true);
  assert.deepEqual([res.into, res.files, res.adds, res.dels], ['main', 5, adds, dels]);
  assert.match(res.merge, HEX40);
  assert.match(res.work, HEX40);
  assert.equal(res.reply, `Merged Invoice export into main. ${MERGED}`);
  // The same events the engine sends for a real merge: what became of its work, and nothing left unmerged.
  const fresh = store.events.slice(n).filter(e => e.agentId === iid);
  assert.deepEqual(fresh.map(e => [e.kind, e.agentId]), [[WORK, iid], [EV.FILES, iid]]);
  const work = { branch: mine.branch, from: 'main', folder: true, merged: { into: 'main', merge: res.merge, at: clock.t, files: 5, adds, dels }, problem: null, thrownAway: null };
  assert.deepEqual(fresh[0].work, work);
  assert.deepEqual(fresh[1].files, NO_FILES);
  assert.deepEqual(v.work, work);
  assert.deepEqual(v.files, NO_FILES);
  assert.equal(v.state, 'done_checked', 'a merge changes no state');
  assert.deepEqual(store.errors, []);

  // The graph: the merge commit M (your old tip first, then W) is main's tip; W is on its branch, from where it started.
  const g = sim.gitGraph();
  assert.equal(g.head, res.merge);
  assert.equal(g.repo.head, res.merge);
  assert.equal(g.commits.length, before.commits.length + 2);
  const subject = 'Make the invoice export work for large accounts by sending invoices in';   // cut at a word, at most 72
  assert.equal(subjectOf(v.task), subject);
  assert.deepEqual(g.commits[0], { id: res.merge, parents: [before.head, res.work], subject: `Merge Invoice export: ${subject}`, author: 'you', at: sec(clock.t), refs: ['main'], agentId: iid, kind: 'merge' });
  assert.deepEqual(g.commits[1], { id: res.work, parents: [mine.base], subject, author: 'Invoice export', at: sec(clock.t), refs: [mine.branch], agentId: iid, kind: 'work' });
  const after = g.agents.find(a => a.id === iid);
  assert.deepEqual([after.base, after.since], [mine.base, res.work], 'its unmerged work now starts at W');
  assert.deepEqual(after.files, NO_FILES);
  assert.deepEqual(after.work, work);
  assert.deepEqual(asGitListsIt(g), g.commits);

  // Nothing is left to merge.
  assert.deepEqual(sim.changes(iid).files, []);
  assert.deepEqual(sim.proposeMerge(iid), { ok: false, why: 'nothing', reply: 'Invoice export’s work is already in main.' });
  assert.deepEqual(sim.merge(iid), { ok: false, why: 'nothing', sentence: 'Invoice export’s work is already in main.', into: 'main', reply: `Invoice export’s work is already in main. ${MERGED}` });
  assert.equal(sim.gitGraph().head, res.merge);

  // It takes a follow-up: taking the database change out again is new work, and the next merge takes only that.
  sim.say(iid, 'Undo that part');
  until(() => store.get(iid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_checked');
  const final = store.eventsFor(iid).filter(e => e.kind === EV.TURN && e.phase === 'end').at(-1).finalText;
  assert.match(final, /^I took out the database change\. It is already in main, so merging this takes the migration out of main again\./);
  const d = sim.changes(iid);
  assert.equal(d.since, res.work);
  assert.deepEqual(d.files.map(f => [f.path, f.status]), [['src/invoices/query.ts', 'modified'], ['migrations/0042_invoice_lookup_index.sql', 'deleted']]);
  const gone = d.files[1];
  assert.equal(gone.adds, 0);
  assert.equal(gone.dels, before.agents.find(a => a.id === iid).files.list.find(f => f.path === gone.path).adds, 'all of the merged file goes');
  // The lines taken out are the ones that were put in, from the same blob.
  const put = merging.files.find(f => f.path === gone.path).patch.split('\n');
  const out = gone.patch.split('\n');
  assert.equal(out[2], `index ${put[2].slice('index 0000000..'.length)}..0000000`);
  assert.deepEqual(out.slice(6).map(l => l.slice(1)), put.slice(6).map(l => l.slice(1)));
  for (const f of d.files) checkPatch(f);
  assert.deepEqual(gitReads(d.files), readAs(d.files));
  const card2 = sim.proposeMerge(iid);
  assert.equal(card2.detail, `2 files, +${sum(d.files, 'adds')} −${sum(d.files, 'dels')}. Its work becomes a commit on its branch, joined into main by a merge commit. It broke a rule you set: Do not touch migrations/. Your 2 uncommitted changes stay as they are. This is the demo, so nothing is really merged.`);
  clock.t += 60_000;
  const res2 = sim.merge(iid, { expect: card2.expect });
  assert.equal(res2.ok, true);
  const g2 = sim.gitGraph();
  assert.deepEqual(g2.commits[0].parents, [res.merge, res2.work]);
  assert.deepEqual(g2.commits[1].parents, [res.work], 'the second work commit follows the first');
  assert.deepEqual([res2.files, res2.adds, res2.dels], [2, sum(d.files, 'adds'), sum(d.files, 'dels')]);
  assert.deepEqual(v.work.merged, { into: 'main', merge: res2.merge, at: clock.t, files: 2, adds: res2.adds, dels: res2.dels });
  assert.deepEqual(asGitListsIt(g2), g2.commits);
  assert.deepEqual(store.errors, []);
});

test('git: Help pages gives a conflict, keeps it until a turn starts, and merges once it brings in main', () => {
  const { sim, store, id, clock, until } = seeded();
  const hid = id('Help pages');
  const v = store.get(hid);
  const before = sim.gitGraph();
  const mine = before.agents.find(a => a.id === hid);
  const card = sim.proposeMerge(hid);
  assert.equal(card.detail, `3 files, +${sum(v.files.list, 'adds')} −${sum(v.files.list, 'dels')}. Its work becomes a commit on its branch, joined into main by a merge commit. Nothing checked its work. Your 2 uncommitted changes stay as they are. This is the demo, so nothing is really merged.`);

  clock.t += 10_000;
  const n = store.events.length;
  const res = sim.merge(hid, { expect: card.expect });
  const sentence = 'Help pages’s work does not merge cleanly into main.';
  assert.deepEqual(res, { ok: false, why: 'conflict', sentence, paths: ['docs/help/billing.md'], into: 'main', reply: `${sentence} ${MERGED}` });
  const problem = { why: 'conflict', sentence, paths: ['docs/help/billing.md'], at: clock.t };
  assert.deepEqual(store.events.slice(n).filter(e => e.agentId === hid).map(e => e.kind), [WORK]);
  assert.deepEqual(v.work, { branch: mine.branch, from: 'main', folder: true, merged: null, problem, thrownAway: null });
  assert.equal(v.files.changed, 3, 'its work is still unmerged');
  // Nothing changed on main. Its work is a commit on its own branch now (W stays there), as a real merge leaves it.
  const g = sim.gitGraph();
  assert.equal(g.head, before.head);
  const w = g.commits.find(c => c.refs.includes(mine.branch));
  assert.deepEqual([w.kind, w.agentId, w.author, w.parents], ['work', hid, 'Help pages', [mine.base]]);
  assert.equal(w.subject, 'Rewrite the help pages for getting started, billing and exports in plain');
  assert.equal(g.commits.length, before.commits.length + 1);
  // Trying again gives the same conflict, and makes nothing new.
  assert.equal(sim.merge(hid).why, 'conflict');
  assert.equal(sim.gitGraph().commits.length, g.commits.length);

  // The lid's "Ask it to bring in main": its next turn clears the problem, and it settles the clash on its branch.
  const ask = 'Your work conflicts with the latest main in: docs/help/billing.md. Please merge main into your branch, resolve the conflicts, and finish.';
  assert.equal(sim.say(hid, ask).ok, true);
  assert.equal(v.state, 'working');
  assert.equal(v.work.problem, null);
  until(() => store.get(hid).state !== 'working', 3 * MIN);
  assert.equal(v.state, 'done_claimed');
  assert.match(v.says, /^I brought in the latest main and resolved the conflict in billing\.md/);
  const g2 = sim.gitGraph();
  const tip = g2.commits.find(c => c.refs.includes(mine.branch));
  assert.deepEqual(tip.parents, [w.id, before.head], 'main merged into its branch');
  assert.deepEqual([tip.subject, tip.author, tip.agentId, tip.kind], [`Merge branch 'main' into ${mine.branch}`, 'Help pages', null, 'commit'],
    'an agent’s own merge carries no Workbench trailers');

  clock.t += 10_000;
  const card2 = sim.proposeMerge(hid);
  assert.equal(card2.ok, true);
  const ok = sim.merge(hid, { expect: card2.expect });
  assert.equal(ok.ok, true);
  assert.equal(ok.reply, `Merged Help pages into main. ${MERGED}`);
  assert.equal(ok.work, tip.id, 'everything was committed on its branch already: its tip is what merges');
  const g3 = sim.gitGraph();
  assert.deepEqual(g3.commits[0].parents, [before.head, tip.id]);
  assert.deepEqual(v.work.problem, null);
  assert.equal(v.work.merged.merge, ok.merge);
  assert.deepEqual(asGitListsIt(g3), g3.commits);
  assert.deepEqual(store.errors, []);
});

test('git: throwing away a finished agent’s work keeps a hidden copy, deletes its branch and closes it quietly', () => {
  const { sim, store, id, clock } = seeded();
  const hid = id('Help pages');
  const v = store.get(hid);
  const branch = v.work.branch;
  const card = sim.proposeDiscard(hid);
  assert.deepEqual(card, {
    ok: true, agentId: hid, kind: 'discard', sentence: 'Throw away Help pages’s work?',
    detail: `Its folder and its branch ${branch} are deleted, with 3 changed files. Workbench keeps a hidden copy in git. This is the demo, so nothing is really thrown away.`,
    yes: 'Throw it away', no: 'Keep it', danger: true, active: false, reply: 'Throw away Help pages’s work?',
    expect: { workId: sim.changes(hid).workId },
  });
  assert.deepEqual(sim.discard(hid, { expect: { workId: 'stale' } }), {
    ok: false, why: 'changed', sentence: 'Help pages’s work changed since you looked. Have another look.', reply: 'Help pages’s work changed since you looked. Have another look.',
  });

  clock.t += 5000;
  const n = store.events.length;
  const res = sim.discard(hid, { expect: card.expect });
  assert.deepEqual(res, { ok: true, saved: `refs/workbench/discarded/${hid}`, reply: `Threw away Help pages’s work. Its folder and branch are gone. ${THROWN}` });
  assert.deepEqual(store.events.slice(n).filter(e => e.agentId === hid).map(e => e.kind), [EV.ENDED, WORK], 'its idle process is closed, then its work goes');
  assert.deepEqual(v.work, { branch: null, from: 'main', folder: false, merged: null, problem: null, thrownAway: { at: clock.t, saved: res.saved } });
  assert.equal(v.state, 'done_claimed', 'it still shows the state it finished in');
  assert.equal(sim.runnerFor(hid).info().alive, false);
  // Its branch is gone from the graph, and so is the agent.
  const g = sim.gitGraph();
  assert.ok(!g.commits.some(c => c.refs.includes(branch)));
  assert.ok(!g.agents.some(a => a.id === hid));
  // Nothing more can happen to its work, and it cannot continue.
  assert.deepEqual(sim.changes(hid), { ok: false, reply: 'Help pages’s work was thrown away, so there is nothing to show.' });
  assert.deepEqual(sim.proposeMerge(hid), { ok: false, why: 'gone', reply: 'Help pages’s work was thrown away, so there is nothing to merge.' });
  assert.equal(sim.merge(hid).why, 'gone');
  assert.deepEqual(sim.proposeDiscard(hid), { ok: false, reply: 'Help pages’s work was already thrown away.' });
  assert.deepEqual(sim.discard(hid), { ok: false, reply: 'Help pages’s work was already thrown away.' });
  assert.deepEqual(sim.say(hid, 'Get it checked'), { ok: false, reply: 'Help pages’s work was thrown away, so it cannot continue.' });
  assert.deepEqual(store.errors, []);
});

test('git: throwing away a working agent stops it and its helpers first, and the card says so', async () => {
  const { sim, store, id, run } = seeded();
  const oid = id('Onboarding');
  const v = store.get(oid);
  const card = sim.proposeDiscard(oid);
  assert.equal(card.active, true);
  assert.equal(card.detail, `Its folder and its branch ${v.work.branch} are deleted, with ${v.files.changed} changed files. Workbench keeps a hidden copy in git. It is still working: it will be stopped first. This is the demo, so nothing is really thrown away.`);
  // A card drawn for a state it is no longer in is refused.
  assert.deepEqual(sim.proposeDiscard(oid, { state: 'done_checked' }), { ok: false, reply: 'That changed. Have another look.' });
  const res = sim.discard(oid);
  assert.equal(res.ok, true);
  assert.equal(v.state, 'stopped');
  assert.equal(v.stateReason, 'Stopped by you');
  for (const h of store.helpersOf(oid)) assert.equal(h.state, 'stopped');
  assert.equal(v.work.thrownAway.saved, `refs/workbench/discarded/${oid}`);
  const n = store.events.length;
  run(MIN);
  assert.equal(store.events.length, n, 'nothing more from it');
  await assert.rejects(sim.runnerFor(oid).send('carry on'), { message: 'Onboarding’s work was thrown away, so it cannot continue.' });
  assert.deepEqual(store.errors, []);
});

test('git: merges and throw-aways are refused in the engine’s words', () => {
  const { sim, store, id } = seeded();
  const cid = id('Checkout fix');
  const iid = id('Invoice export');
  for (const name of ['Checkout fix', 'Search cleanup', 'Flaky test', 'Onboarding']) {
    const refusal = { ok: false, reply: `${name} is still working. Merge it when it is done.` };
    assert.deepEqual(sim.proposeMerge(id(name)), refusal, name);
    assert.deepEqual(sim.merge(id(name)), refusal, name);
  }
  const helper = store.helpersOf(cid)[0].id;
  assert.deepEqual(sim.proposeMerge(helper), { ok: false, reply: 'Helpers work in their agent’s folder. Merge the agent instead.' });
  assert.deepEqual(sim.merge(helper), { ok: false, reply: 'Helpers work in their agent’s folder. Merge the agent instead.' });
  assert.deepEqual(sim.proposeDiscard(helper), { ok: false, reply: 'Helpers work in their agent’s folder. Throw away the agent’s work instead.' });
  assert.deepEqual(sim.discard(helper), { ok: false, reply: 'Helpers work in their agent’s folder. Throw away the agent’s work instead.' });
  for (const fn of ['proposeMerge', 'merge', 'proposeDiscard', 'discard']) {
    assert.deepEqual(sim[fn]('nope00'), { ok: false, reply: 'That agent is not part of the demo.' }, fn);
  }
  assert.deepEqual(sim.proposeMerge(iid, { state: 'done_claimed' }), { ok: false, reply: 'That changed. Have another look.' });
  assert.equal(sim.proposeMerge(iid, { state: 'done_checked' }).ok, true);
  // A card bound to what it showed: main moved, or the work changed, since.
  const card = sim.proposeMerge(iid);
  const n = store.events.length;
  const moved = sim.merge(iid, { expect: { ...card.expect, intoHead: 'f'.repeat(40) } });
  assert.deepEqual(moved, {
    ok: false, why: 'moved', sentence: 'main changed since you looked. Have another look.', paths: [], into: 'main',
    reply: `main changed since you looked. Have another look. ${MERGED}`,
  });
  assert.deepEqual(store.get(iid).work.problem, { why: 'moved', sentence: moved.sentence, paths: [], at: store.events.at(-1).ts });
  assert.equal(store.events.length, n + 1);
  assert.deepEqual(sim.merge(iid, { expect: { ...card.expect, workId: 'stale' } }), {
    ok: false, why: 'changed', sentence: 'Invoice export’s work changed since you looked. Have another look.', into: 'main',
    reply: `Invoice export’s work changed since you looked. Have another look. ${MERGED}`,
  });
  assert.equal(sim.gitGraph().head, card.expect.intoHead, 'nothing was merged');
  // A later merge goes through, and clears the problem.
  assert.equal(sim.merge(iid).ok, true);
  assert.equal(store.get(iid).work.problem, null);
});

test('git: a task started in the demo works on its own branch from main as it is, and merges once done', () => {
  const p = playRunner({ seed: 5, agentId: 'a1b2c3' });
  const { sim, mine, store } = p;
  const v = mine.get('a1b2c3');
  assert.match(v.state, /^done_/);
  assert.deepEqual(mine.errors, []);
  assert.deepEqual(store.events, [], 'its events go to its own emit');
  const branch = 'workbench/fix-flaky-checkout-test-a1b2c3';
  const starts = mine.events.filter(e => e.kind === WORK);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].work, { branch, from: 'main', folder: true, merged: null, problem: null, thrownAway: null });
  const g = sim.gitGraph();
  const a = g.agents.find(x => x.id === 'a1b2c3');
  assert.deepEqual([a.name, a.branch, a.base, a.since], ['Fix flaky checkout test', branch, g.head, g.head], 'from main’s tip when it started');
  assert.deepEqual(a.files, v.files);
  assert.equal(a.state, v.state);
  assert.deepEqual(g.commits[0].refs, ['main', branch]);
  const card = sim.proposeMerge('a1b2c3');
  assert.equal(card.sentence, 'Merge Fix flaky checkout test into main?');
  assert.match(card.detail, /^\d+ files?, \+\d+ −\d+\. Its work becomes a commit on its branch, joined into main by a merge commit\. (Nothing checked its work\. )?Your 2 uncommitted changes stay as they are\. This is the demo, so nothing is really merged\.$/);
  const res = sim.merge('a1b2c3', { expect: card.expect });
  assert.equal(res.ok, true);
  assert.deepEqual(mine.events.slice(-2).map(e => e.kind), [WORK, EV.FILES]);
  assert.deepEqual(v.files, NO_FILES);
  const g2 = sim.gitGraph();
  assert.deepEqual(g2.commits[1], { id: res.work, parents: [g.head], subject: 'Fix the flaky checkout test', author: 'Fix flaky checkout test', at: g2.commits[1].at, refs: [branch], agentId: 'a1b2c3', kind: 'work' });
  assert.deepEqual(asGitListsIt(g2), g2.commits);
});

test('git: a work commit’s subject is the task’s first sentence, capitalised, cut at a word to at most 72 characters', () => {
  assert.equal(subjectOf('fix the login redirect. Then add tests for it.'), 'Fix the login redirect');
  assert.equal(subjectOf('make the e.g. field optional'), 'Make the e.g. field optional');
  assert.equal(subjectOf('Clean up the old search code now that the new search page is live'), 'Clean up the old search code now that the new search page is live');
  const long = subjectOf('rewrite the help pages for getting started, billing and exports in plain language for everyone');
  assert.equal(long, 'Rewrite the help pages for getting started, billing and exports in plain');
  assert.ok(long.length <= 72);
  assert.equal(subjectOf('   '), 'Work by an agent');
  assert.equal(subjectOf('', 'Fix login'), 'Work by Fix login');
  assert.equal(subjectOf('fix\nthe\tlogin'), 'Fix the login', 'one line');
});
