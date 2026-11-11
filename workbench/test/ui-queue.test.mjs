import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishKey, needsPerson, needsQueue, reviewQueue, setAsideList, stepFrom, helpersByNeed, helpersAtWork } from '../ui/queue.js';
import { NEEDS_YOU, PRIORITY, ENDED, ACTIVE } from '../src/shared/states.mjs';

const ag = (id, state, o = {}) => ({ id, state, parentId: null, startedAt: 0, stateSince: 100, endedAt: null, ask: null, ...o });

test('a failed check set aside ("Look later") waits until that agent finishes again', () => {
  const x = ag('X', 'checks_failed', { endedAt: 500 });
  const later = new Set([finishKey(x)]);
  assert.equal(needsPerson(x, { NEEDS_YOU, later }), false);
  assert.deepEqual(needsQueue([x], { NEEDS_YOU, PRIORITY, later }), []);
  assert.deepEqual(setAsideList([x], { later }).map(a => a.id), ['X']);
  const again = { ...x, endedAt: 900 };
  assert.equal(needsPerson(again, { NEEDS_YOU, later }), true, 'a new finish brings it back');
  // only a failed check can be set aside: an ask always needs the person
  const ask = ag('Q', 'question', { endedAt: 500 });
  assert.equal(needsPerson(ask, { NEEDS_YOU, later: new Set([finishKey(ask)]) }), true);
});

test('the queue: by priority, then the oldest ask first', () => {
  const list = [
    ag('q', 'question', { ask: { id: 'k1', createdAt: 10 } }),
    ag('p2', 'needs_ok', { ask: { id: 'k2', createdAt: 30 } }),
    ag('p1', 'needs_ok', { ask: { id: 'k3', createdAt: 20 } }),
    ag('w', 'working'), ag('s', 'maybe_stuck', { ask: { id: 'k4', createdAt: 1 } }),
  ];
  assert.deepEqual(needsQueue(list, { NEEDS_YOU, PRIORITY }).map(a => a.id), ['p1', 'p2', 'q', 's']);
});

test('finished work to look at: roots only, newest first, and a look counts for one finish', () => {
  const a = ag('a', 'done_checked', { endedAt: 100 }), b = ag('b', 'done_claimed', { endedAt: 300 }), c = ag('c', 'failed', { endedAt: 200 });
  const h = ag('h', 'done_checked', { parentId: 'a', endedAt: 400 });
  assert.deepEqual(reviewQueue([a, b, c, h], { reviewed: new Set() }).map(x => x.id), ['b', 'c', 'a']);
  const reviewed = new Set([finishKey(b)]);
  assert.deepEqual(reviewQueue([a, b, c], { reviewed }).map(x => x.id), ['c', 'a']);
  assert.deepEqual(reviewQueue([a, { ...b, endedAt: 999 }, c], { reviewed }).map(x => x.id), ['b', 'c', 'a'], 'finishing again brings it back');
});

test('stepping wraps both ways', () => {
  const list = ['a', 'b', 'c'].map(id => ({ id }));
  assert.equal(stepFrom(list, 'a', 1), 'b');
  assert.equal(stepFrom(list, 'c', 1), 'a');
  assert.equal(stepFrom(list, 'a', -1), 'c');
  assert.equal(stepFrom(list, 'zzz', 1), 'a');
  assert.equal(stepFrom([], 'a', 1), null);
});

test('helpers by need: the one asking first, then working, then the latest ended; ties keep their start order', () => {
  const kids = [
    ag('h0', 'working', { startedAt: 1 }), ag('h1', 'finished', { startedAt: 2, endedAt: 50 }), ag('h2', 'working', { startedAt: 3 }),
    ag('h3', 'finished', { startedAt: 4, endedAt: 90 }), ag('h4', 'working', { startedAt: 5 }), ag('h5', 'needs_ok', { startedAt: 6 }),
  ];
  assert.deepEqual(helpersByNeed(kids, { NEEDS_YOU, ENDED }).map(k => k.id), ['h5', 'h0', 'h2', 'h4', 'h3', 'h1']);
});

test('one helper count everywhere: five working and one asking are six at work', () => {
  const kids = [...Array.from({ length: 5 }, (_, i) => ag('w' + i, 'working')), ag('n', 'needs_ok'), ag('f', 'finished')];
  assert.equal(helpersAtWork(kids, ACTIVE), 6);
});
