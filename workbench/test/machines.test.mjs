import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machines } from '../src/core/machines.mjs';

// A stand-in for node:os: 8 CPUs with a load of 2 (25%), 16 GB with 4 GB free (75% used).
function fakeOs({ load = 2, cpus = 8, total = 16e9, free = 4e9 } = {}) {
  const state = { load, cpus, total, free };
  return {
    state,
    loadavg: () => [state.load, 1, 1],
    cpus: () => new Array(state.cpus).fill({ model: 'fake' }),
    totalmem: () => state.total,
    freemem: () => state.free,
  };
}

// A timer stand-in that runs callbacks only when the test says so.
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer: id => { pending.delete(id); },
    runAll() { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } },
  };
}

function collect(machines) {
  const updates = [];
  machines.on('update', list => updates.push(list));
  return updates;
}

test('live mode has only the real laptop, read from os', () => {
  const m = new Machines({ demo: false, os: fakeOs() });
  const list = m.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true, simulated: false,
    cpuPct: 25, memPct: 75, costPerHourUsd: null, agents: 0, note: 'idle',
  });
});

test('the laptop works with the real node:os too', () => {
  const [laptop] = new Machines().list();
  assert.equal(laptop.id, 'laptop');
  assert.ok(laptop.cpuPct === null || (laptop.cpuPct >= 0 && laptop.cpuPct <= 100));
  assert.ok(laptop.memPct >= 0 && laptop.memPct <= 100);
  assert.ok(Number.isInteger(laptop.memPct));
});

test('demo mode adds three simulated cloud machines in the stated states', () => {
  const m = new Machines({ demo: true, os: fakeOs() });
  const list = m.list();
  assert.deepEqual(list.map(x => x.id), ['laptop', 'cloud-1', 'cloud-2', 'cloud-3']);
  const [, c1, c2, c3] = list;
  assert.equal(c1.name, 'Cloud 1');
  assert.equal(c1.awake, true);
  assert.equal(c1.note, 'idle');
  assert.equal(c1.agents, 0);
  assert.equal(c2.awake, false);
  assert.equal(c2.note, 'asleep');
  assert.equal(c2.cpuPct, null);
  assert.equal(c3.awake, true);
  assert.equal(c3.agents, 1);
  assert.equal(c3.note, '1 agent');
  for (const c of [c1, c2, c3]) {
    assert.equal(c.kind, 'cloud');
    assert.equal(c.simulated, true);
    assert.equal(c.costPerHourUsd, 0.40);
  }
});

test('list() returns copies', () => {
  const m = new Machines({ demo: true, os: fakeOs() });
  const list = m.list();
  list[1].awake = false;
  list[1].note = 'changed';
  assert.equal(m.list()[1].awake, true);
  assert.equal(m.get('cloud-1').note, 'idle');
});

test('waking a sleeping machine takes about 10 seconds and reports each change', () => {
  const timers = fakeTimers();
  const m = new Machines({ demo: true, os: fakeOs(), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const updates = collect(m);

  const r = m.setAwake('cloud-2', true);
  assert.deepEqual(r, { ok: true, reply: 'Cloud 2 is waking up. It takes about 10 seconds.' });
  assert.equal(m.get('cloud-2').note, 'waking up');
  assert.equal(m.get('cloud-2').awake, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0].id, 'cloud-2');
  assert.equal([...timers.pending.values()][0].ms, 10_000);

  // Asking again while it wakes does not start a second timer.
  assert.equal(m.setAwake('cloud-2', true).reply, 'Cloud 2 is already waking up. It takes about 10 seconds.');
  assert.equal(timers.pending.size, 1);

  timers.runAll();
  const c2 = m.get('cloud-2');
  assert.equal(c2.awake, true);
  assert.equal(c2.note, 'idle');
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1], [c2]);
  assert.equal(m.setAwake('cloud-2', true).reply, 'Cloud 2 is already awake.');
});

test('putting a machine to sleep is immediate and keeps its work', () => {
  const timers = fakeTimers();
  const m = new Machines({ demo: true, os: fakeOs(), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const updates = collect(m);
  assert.deepEqual(m.setAwake('cloud-1', false), { ok: true, reply: 'Cloud 1 is asleep. Its work is saved.' });
  const c1 = m.get('cloud-1');
  assert.equal(c1.awake, false);
  assert.equal(c1.note, 'asleep');
  assert.equal(c1.cpuPct, null);
  assert.deepEqual(updates, [[c1]]);
  assert.equal(m.setAwake('cloud-1', false).reply, 'Cloud 1 is already asleep.');
  assert.equal(updates.length, 1, 'no update when nothing changed');

  // A machine with an agent on it says so.
  assert.match(m.setAwake('Cloud 3', false).reply, /^Cloud 3 is asleep\. Its work is saved\. Its agent will pick up again when it wakes\.$/);

  // Sleeping a machine that is waking cancels the wake-up.
  m.setAwake('cloud-2', true);
  assert.equal(timers.pending.size, 1);
  assert.equal(m.setAwake('cloud-2', false).reply, 'Cloud 2 is asleep. Its work is saved.');
  assert.equal(timers.pending.size, 0);
  assert.equal(m.get('cloud-2').note, 'asleep');
});

test('the real wake timer does not keep the process alive', () => {
  const handles = [];
  const m = new Machines({
    demo: true, os: fakeOs(), wakeMs: 60_000,
    setTimer: (fn, ms) => { const h = setTimeout(fn, ms); handles.push(h); return h; },
  });
  m.setAwake('cloud-2', true);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].hasRef(), false, 'the wake timer is unref\'d');
  m.dispose();
  assert.equal(m.get('cloud-2').awake, false);
  assert.equal(m.get('cloud-2').note, 'asleep');
});

test('plain replies for things that cannot be done', () => {
  const live = new Machines({ demo: false, os: fakeOs() });
  assert.deepEqual(live.setAwake('cloud-2', true), { ok: false, reply: 'Cloud machines are only available in demo mode. Agents run on your laptop.' });
  const demo = new Machines({ demo: true, os: fakeOs() });
  assert.deepEqual(demo.setAwake('laptop', false), { ok: false, reply: 'Your laptop runs Workbench itself, so it stays awake.' });
  assert.equal(demo.setAwake('laptop', true).ok, true);
  assert.deepEqual(demo.setAwake('cloud-9', true), { ok: false, reply: 'There is no machine called cloud-9.' });
  for (const r of [live.setAwake('x', true), demo.setAwake('Cloud 9', false)]) {
    assert.match(r.reply, /^[A-Z].*\.$/, 'a full sentence');
  }
});

test('refresh updates agent counts and notes and reports only what changed', () => {
  const os = fakeOs();
  const m = new Machines({ demo: true, os });
  const updates = collect(m);

  const changed = m.refresh({ laptop: 3, 'cloud-1': 0, 'cloud-3': 1 });
  assert.deepEqual(changed.map(x => x.id), ['laptop']);
  assert.deepEqual(updates, [changed]);
  const byId = Object.fromEntries(m.list().map(x => [x.id, x]));
  assert.equal(byId.laptop.agents, 3);
  assert.equal(byId.laptop.note, '3 agents');
  assert.equal(byId['cloud-1'].note, 'idle');
  assert.equal(byId['cloud-2'].note, 'asleep');
  assert.equal(byId['cloud-3'].note, '1 agent');

  // Same counts and same load: nothing to report.
  assert.deepEqual(m.refresh({ laptop: 3, 'cloud-3': 1 }), []);
  assert.equal(updates.length, 1);

  // Machines left out count as zero; a Map works too.
  const c = m.refresh(new Map([['laptop', 1]]));
  assert.deepEqual(c.map(x => x.id), ['laptop', 'cloud-3']);
  assert.equal(m.get('laptop').note, '1 agent');
  assert.equal(m.get('cloud-3').note, 'idle');

  // A sleeping machine stays "asleep" whatever its count.
  m.refresh({ 'cloud-2': 2 });
  assert.equal(m.get('cloud-2').note, 'asleep');
  assert.equal(m.get('cloud-2').agents, 2);

  // The laptop's load is read again on each refresh.
  os.state.load = 6;
  const c2 = m.refresh();
  assert.deepEqual(c2.map(x => x.id), ['laptop']);
  assert.equal(m.get('laptop').cpuPct, 75);
  assert.equal(m.get('cloud-2').agents, 2, 'no argument keeps the counts');
});

test('busy cloud machines show simulated load', () => {
  const m = new Machines({ demo: true, os: fakeOs() });
  const idle = m.get('cloud-1');
  m.refresh({ 'cloud-1': 2 });
  const busy = m.get('cloud-1');
  assert.ok(busy.cpuPct > idle.cpuPct);
  assert.ok(busy.memPct > idle.memPct);
  assert.ok(busy.cpuPct <= 100 && busy.memPct <= 100);
  assert.equal(busy.note, '2 agents');
});

test('sleepIdle puts only idle awake clouds to sleep', () => {
  const m = new Machines({ demo: true, os: fakeOs() });
  const r = m.sleepIdle();
  assert.deepEqual(r, { ok: true, reply: 'Cloud 1 is asleep. Its work is saved.', ids: ['cloud-1'] });
  assert.equal(m.get('cloud-3').awake, true, 'cloud 3 has an agent');
  assert.deepEqual(m.sleepIdle(), { ok: true, reply: 'No machine is idle right now.', ids: [] });
  m.refresh({});
  assert.equal(m.sleepIdle().reply, 'Cloud 3 is asleep. Its work is saved.');
});
