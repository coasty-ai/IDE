import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StuckDetector } from '../src/core/stuck.mjs';
import { EV } from '../src/shared/events.mjs';

const T0 = 1_800_000_000_000;
const view = (extra = {}) => ({ id: 'r1', name: 'Fix login', state: 'working', lastEventAt: T0, stateSince: T0, helpers: { total: 0, working: 0, done: 0 }, ...extra });
const start = (sentence, id, extra = {}) => ({ kind: EV.ACTIVITY, agentId: 'r1', ts: T0, phase: 'start', sentence, toolKind: 'run', toolUseId: id, ...extra });
const end = (id, ok, extra = {}) => ({ kind: EV.ACTIVITY, agentId: 'r1', ts: T0, phase: 'end', toolUseId: id, ok, ...extra });

/** Feed a list of events; return the progress signals. */
function feed(d, events) {
  return events.map(e => d.observe(e)).filter(Boolean);
}

test('rule 1: the same step retried three times after failures flags the agent once', () => {
  const d = new StuckDetector();
  feed(d, [start('Running the tests', 't1'), end('t1', false), start('Running the tests', 't2'), end('t2', false)]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), [], 'two tries are not enough');
  feed(d, [start('Running the tests', 't3')]);
  const flags = d.check(T0 + 1000, [view()]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].agentId, 'r1');
  assert.equal(flags[0].rule, 'repeat');
  assert.equal(flags[0].sentence, 'Fix login has tried the same step three times without success.');
  assert.equal(flags[0].detail, 'Running the tests');
  assert.ok(d.isFlagged('r1'));
  feed(d, [end('t3', false), start('Running the tests', 't4'), end('t4', false), start('Running the tests', 't5')]);
  assert.deepEqual(d.check(T0 + 2000, [view()]), [], 'not flagged twice');
});

test('rule 1: a success in between or a different step resets the count', () => {
  const d = new StuckDetector();
  feed(d, [
    start('Running the tests', 't1'), end('t1', false),
    start('Running the tests', 't2'), end('t2', true),
    start('Running the tests', 't3'), end('t3', false),
    start('Reading a.js', 't4'), end('t4', false),
    start('Running the tests', 't5'),
  ]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), []);
});

test('rule 1: different input for the same sentence is a different step', () => {
  const d = new StuckDetector();
  feed(d, [
    start('Running a command', 't1', { input: { command: 'a' } }), end('t1', false),
    start('Running a command', 't2', { input: { command: 'b' } }), end('t2', false),
    start('Running a command', 't3', { input: { command: 'c' } }),
  ]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), []);
});

test('rule 1: parallel calls that narrate the same way do not count', () => {
  const d = new StuckDetector();
  feed(d, [
    start('Checking what changed', 'g1'), start('Checking what changed', 'g2'), start('Checking what changed', 'g3'),
    end('g1', false), end('g2', false), end('g3', false),
  ]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), []);
  // Starts that never end (progress snapshots) do not count either.
  feed(d, [start('Searching the code'), start('Searching the code'), start('Searching the code')]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), []);
});

test('rule 2: the same error text three times close together flags, even with successful steps between', () => {
  const d = new StuckDetector();
  const err = (i) => 'TypeError: cart is undefined at line ' + (10 + i);
  for (let i = 0; i < 3; i++) {
    feed(d, [start('Running the tests', 'r' + i), end('r' + i, false, { error: err(i) }), start('Editing cart.js', 'e' + i), end('e' + i, true)]);
  }
  const flags = d.check(T0 + 1000, [view()]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule, 'error');
  assert.equal(flags[0].sentence, 'Fix login has hit the same error three times.');
  assert.match(flags[0].detail, /cart is undefined/);
});

test('rule 2: failures without error text are not counted as the same error', () => {
  const d = new StuckDetector();
  for (let i = 0; i < 4; i++) feed(d, [start('Running the tests', 'r' + i), end('r' + i, false), start('Editing cart.js', 'e' + i), end('e' + i, true)]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), []);
});

test('rule 3: working and silent for the limit with no helpers working', () => {
  const d = new StuckDetector({ silenceMs: 4 * 60_000 });
  feed(d, [start('Reading a.js', 't1'), end('t1', true)]);
  assert.deepEqual(d.check(T0 + 3 * 60_000, [view()]), []);
  assert.deepEqual(d.check(T0 + 5 * 60_000, [view({ helpers: { total: 1, working: 1, done: 0 } })]), [], 'a helper is working');
  assert.deepEqual(d.check(T0 + 5 * 60_000, [view({ state: 'waiting_helpers' })]), [], 'only working agents');
  assert.deepEqual(d.check(T0 + 5 * 60_000, [view({ state: 'needs_ok' })]), []);
  const flags = d.check(T0 + 5 * 60_000, [view()]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].rule, 'silence');
  assert.equal(flags[0].sentence, 'Fix login has not done anything for 4 min.');
});

test('rule 3: a step still running gets a sentence about that step', () => {
  const d = new StuckDetector({ silenceMs: 60_000 });
  feed(d, [start('Running the tests', 't1')]);
  const [f] = d.check(T0 + 61_000, [view()]);
  assert.equal(f.sentence, 'Fix login has been on the same step for 1 min with no news.');
  assert.equal(f.detail, 'Running the tests');
});

test('a flagged agent reports progress when a different step succeeds, or any step after silence', () => {
  const d = new StuckDetector();
  feed(d, [start('Running the tests', 't1'), end('t1', false), start('Running the tests', 't2'), end('t2', false), start('Running the tests', 't3')]);
  assert.equal(d.check(T0, [view()]).length, 1);
  assert.deepEqual(feed(d, [end('t3', false)]), []);
  assert.deepEqual(feed(d, [start('Editing cart.js', 'e1'), end('e1', true)]), [{ agentId: 'r1', progress: true }]);

  const quiet = new StuckDetector({ silenceMs: 1000 });
  assert.equal(quiet.check(T0 + 5000, [view()]).length, 1);
  assert.deepEqual(feed(quiet, [start('Reading a.js', 'x')]), [{ agentId: 'r1', progress: true }]);
});

test('for the error rule too, any step that works counts as progress', () => {
  const d = new StuckDetector();
  for (let i = 0; i < 3; i++) feed(d, [start('Running the tests', 'r' + i), end('r' + i, false, { error: 'boom' }), start('Editing cart.js', 'e' + i), end('e' + i, true)]);
  assert.equal(d.check(T0, [view()]).length, 1);
  assert.deepEqual(feed(d, [start('Running the tests', 'r8'), end('r8', false, { error: 'boom' })]), [], 'failing again is no progress');
  assert.deepEqual(feed(d, [start('Editing cart.js', 'e9'), end('e9', true)]), [{ agentId: 'r1', progress: true }], 'a different step that works is');
  const same = new StuckDetector();
  for (let i = 0; i < 3; i++) feed(same, [start('Running the tests', 'r' + i), end('r' + i, false, { error: 'boom' }), start('Editing cart.js', 'e' + i), end('e' + i, true)]);
  assert.equal(same.check(T0, [view()]).length, 1);
  assert.deepEqual(feed(same, [start('Running the tests', 'r9'), end('r9', true)]), [{ agentId: 'r1', progress: true }], 'so is the failing step working at last');
});

/** Successful steps, each started and ended on its own. */
const goods = (d, n, tag) => { for (let i = 0; i < n; i++) feed(d, [start(`Reading ${tag}${i}.js`, `${tag}${i}`), end(`${tag}${i}`, true)]); };
/** One failing step with this error text. */
const miss = (d, id, error = 'File has not been read yet. Read it first before writing to it.') => feed(d, [start(`Editing ${id}.js`, id), end(id, false, { error })]);

test('rule 2: the same error spread out over a long turn does not flag', () => {
  const d = new StuckDetector();
  for (let k = 0; k < 3; k++) {
    miss(d, `m${k}`);
    goods(d, 13, `g${k}-`);
    assert.deepEqual(d.check(T0 + 1000, [view()]), [], `after miss ${k + 1}`);
  }
});

test('rule 2: an error counts again only if it comes back within ten steps', () => {
  const near = new StuckDetector();
  for (let k = 0; k < 3; k++) { miss(near, `m${k}`); if (k < 2) goods(near, 9, `g${k}-`); }
  assert.equal(near.check(T0 + 1000, [view()]).length, 1, 'each time 10 steps after the one before');
  const far = new StuckDetector();
  for (let k = 0; k < 3; k++) { miss(far, `m${k}`); if (k < 2) goods(far, 10, `g${k}-`); }
  assert.deepEqual(far.check(T0 + 1000, [view()]), [], 'each time 11 steps after the one before');
});

test('rule 2: calls that fail together with the same error count once', () => {
  const d = new StuckDetector();
  const error = 'String to replace not found in file.';
  feed(d, [start('Editing a.js', 'a'), start('Editing b.js', 'b'), start('Editing c.js', 'c'), end('a', false, { error }), end('b', false, { error }), end('c', false, { error })]);
  assert.deepEqual(d.check(T0 + 1000, [view()]), [], 'one batch is one try');
  miss(d, 'r1', error);
  assert.deepEqual(d.check(T0 + 1000, [view()]), [], 'a retry is the second');
  miss(d, 'r2', error);
  assert.equal(d.check(T0 + 1000, [view()]).length, 1, 'and another one the third');
});

test('rule 2: calls made together count as one step towards the ten', () => {
  const d = new StuckDetector();
  const batch = (tag) => {
    const ids = [1, 2, 3, 4, 5].map(i => `${tag}${i}`);
    feed(d, [...ids.map(id => start(`Reading ${id}.js`, id)), ...ids.map(id => end(id, true))]);
  };
  for (let k = 0; k < 3; k++) {
    miss(d, `m${k}`);
    // Ten reads, sent five at a time, and one edit: three steps, so the error is still recent.
    if (k < 2) { batch(`a${k}-`); batch(`b${k}-`); goods(d, 1, `e${k}-`); }
  }
  assert.equal(d.check(T0 + 1000, [view()]).length, 1);
});

test('leaving maybe_stuck or reset() starts the counts afresh; ended agents are forgotten', () => {
  const d = new StuckDetector();
  const loop = () => feed(d, [start('Running the tests', 'a'), end('a', false), start('Running the tests', 'b'), end('b', false), start('Running the tests', 'c')]);
  loop();
  assert.equal(d.check(T0, [view()]).length, 1);
  d.observe({ kind: EV.STATE, agentId: 'r1', ts: T0, state: 'maybe_stuck' });
  assert.ok(d.isFlagged('r1'), 'entering maybe_stuck keeps the flag');
  d.observe({ kind: EV.STATE, agentId: 'r1', ts: T0, state: 'working' });
  assert.equal(d.isFlagged('r1'), false);
  assert.deepEqual(d.check(T0, [view()]), [], 'counts were reset');
  loop();
  assert.equal(d.check(T0, [view()]).length, 1, 'three more tries flag it again');
  d.reset('r1');
  assert.equal(d.isFlagged('r1'), false);
  d.observe({ kind: EV.STATE, agentId: 'r1', ts: T0, state: 'stopped' });
  assert.equal(d.isFlagged('r1'), false);
});

test('a permission ask or a new turn drops a rule that fired but was not raised yet', () => {
  const d = new StuckDetector();
  feed(d, [start('Running the tests', 'a'), end('a', false), start('Running the tests', 'b'), end('b', false), start('Running the tests', 'c')]);
  d.observe({ kind: EV.STATE, agentId: 'r1', ts: T0, state: 'needs_ok' });
  assert.deepEqual(d.check(T0, [view()]), []);
  feed(d, [end('c', false), start('Running the tests', 'd'), end('d', false)]);
  d.observe({ kind: EV.TURN, agentId: 'r1', ts: T0, phase: 'start' });
  feed(d, [start('Running the tests', 'e')]);
  assert.deepEqual(d.check(T0, [view()]), []);
});
