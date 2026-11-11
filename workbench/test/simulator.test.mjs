import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator, available, harness, topicOf } from '../src/adapters/sim/simulator.mjs';
import { EV, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../src/shared/events.mjs';
import { extractQuestion, nameFromTask } from '../src/shared/narrate.mjs';
import { createFakeStore } from './helpers/simulator-fake-store.mjs';

const T0 = Date.UTC(2026, 10, 10, 17, 0, 0);
const MIN = 60_000;

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
  assert.deepEqual(ok.options, ['Allow', 'Deny']);
  assert.equal(ok.primary, 'Allow');
  assert.equal(T - ok.createdAt, 4 * MIN, 'waiting 4 minutes');
  assert.equal(by['Checkout fix'].now, 'Update the test database', 'the held step shows as what it is doing');

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
  const end = store.eventsFor(cid).find(e => e.kind === EV.ACTIVITY && e.phase === 'end' && e.sentence === 'Update the test database');
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
  assert.equal(end.sentence, 'Update the test database');
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
