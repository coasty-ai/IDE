import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lanes, denseLanes, ROWS } from '../ui/lanes.js';

const memory = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const roots = (n, laptop = i => i % 2 === 0) => Array.from({ length: n }, (_, i) => ({ id: 'a' + i, startedAt: 1000 + i, laptop: laptop(i) }));

test('laptop agents take left lanes and cloud agents right lanes; rows fill top, bottom, then the middle', () => {
  const l = new Lanes(null);
  l.assign([{ id: 'lap1', startedAt: 1, laptop: true }, { id: 'cloud1', startedAt: 2, laptop: false }, { id: 'lap2', startedAt: 3, laptop: true }]);
  assert.deepEqual(l.get('lap1'), { side: 'L', row: 0 });
  assert.deepEqual(l.get('cloud1'), { side: 'R', row: 5 });
  assert.deepEqual(l.get('lap2'), { side: 'L', row: 5 });
});

test('the sides stay balanced: a side two lanes fuller sends the newcomer across', () => {
  const l = new Lanes(null);
  l.assign(roots(4, () => true));
  const sides = ['a0', 'a1', 'a2', 'a3'].map(id => l.get(id).side);
  assert.deepEqual(sides, ['L', 'L', 'R', 'L']);
});

test('a lane is kept while its agent is on the board: later agents never move earlier ones, and no two share a lane', () => {
  const l = new Lanes(null);
  l.assign(roots(5));
  const before = new Map(['a0', 'a1', 'a2', 'a3', 'a4'].map(id => [id, { ...l.get(id) }]));
  l.assign(roots(12));
  for (const [id, lane] of before) assert.deepEqual(l.get(id), lane, id);
  const used = new Set();
  for (let i = 0; i < 12; i++) {
    const x = l.get('a' + i);
    assert.ok(x.row != null && x.row >= 0 && x.row < ROWS);
    const k = x.side + x.row;
    assert.ok(!used.has(k), 'lane used twice: ' + k);
    used.add(k);
  }
  assert.equal(used.size, 12);
});

test('past twelve agents a newcomer gets a side but no row', () => {
  const l = new Lanes(null);
  l.assign(roots(14));
  assert.equal(l.get('a12').row, null);
  assert.equal(l.get('a13').row, null);
  assert.ok(['L', 'R'].includes(l.get('a12').side));
});

test('lanes are kept in session storage and pruned to the agents on the board', () => {
  const s = memory();
  const l = new Lanes(s);
  l.assign(roots(3));
  const again = new Lanes(s);
  for (const id of ['a0', 'a1', 'a2']) assert.deepEqual(again.get(id), l.get(id));
  again.prune(new Set(['a1']));
  assert.equal(again.get('a0'), null);
  assert.ok(again.get('a1'));
  assert.equal(new Lanes(s).get('a0'), null, 'the pruned lane is gone after a reload too');
  // a freed row is handed out again
  again.assign([{ id: 'b', startedAt: 9, laptop: true }]);
  assert.deepEqual(again.get('b'), { side: 'L', row: 0 });
});

test('an agent that leaves the board frees its lane: the others keep theirs, and a newcomer may take it', () => {
  const s = memory();
  const l = new Lanes(s);
  l.assign(roots(5));
  const before = new Map(['a0', 'a1', 'a2', 'a3', 'a4'].map(id => [id, { ...l.get(id) }]));
  // a0 goes to the done tray: only the roots still on the board keep lanes
  l.prune(['a1', 'a2', 'a3', 'a4']);
  assert.equal(l.get('a0'), null);
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.deepEqual(l.get(id), before.get(id), id + ' did not move');
  assert.equal(new Lanes(s).get('a0'), null, 'freed after a reload too');
  // a newcomer on the same side takes the freed lane; nobody else moves
  l.assign([{ id: 'n', startedAt: 99, laptop: true }]);
  assert.deepEqual(l.get('n'), before.get('a0'));
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.deepEqual(l.get(id), before.get(id), id + ' still did not move');
  // one that comes back from the tray is a newcomer: it gets a free lane, not necessarily its old one
  l.assign([{ id: 'a0', startedAt: 1000, laptop: true }]);
  const back = l.get('a0');
  assert.ok(back && back.row != null && !['a1', 'a2', 'a3', 'a4', 'n'].some(id => l.get(id).side === back.side && l.get(id).row === back.row));
});

test('an agent that came while every lane was taken gets a lane once one is free, and nobody else moves', () => {
  const l = new Lanes(null);
  l.assign(roots(14));
  assert.equal(l.get('a12').row, null);
  assert.equal(l.get('a13').row, null);
  const kept = new Map(Array.from({ length: 12 }, (_, i) => ['a' + i, { ...l.get('a' + i) }]));
  // a3 leaves: the oldest one without a row takes a free lane, on its own side when it can
  const on = roots(14).filter(r => r.id !== 'a3');
  l.prune(on.map(r => r.id));
  l.assign(on);
  assert.deepEqual(l.get('a12'), kept.get('a3'), 'the freed lane');
  assert.equal(l.get('a13').row, null, 'one lane, one agent');
  for (const [id, lane] of kept) if (id !== 'a3') assert.deepEqual(l.get(id), lane, id);
  // two more leave, on the other side: a13 crosses over rather than wait without a row
  const fewer = on.filter(r => !['a2', 'a6'].includes(r.id));
  l.prune(fewer.map(r => r.id));
  l.assign(fewer);
  const x = l.get('a13');
  assert.ok(x.row != null, 'a13 has a row now');
  const used = new Set(fewer.map(r => l.get(r.id)).map(v => v.side + v.row));
  assert.equal(used.size, fewer.length, 'no two on one lane');
});

test('a damaged or doubled saved entry never puts two agents on one lane', () => {
  const s = memory();
  s.setItem('wb-lanes', JSON.stringify([['x', 'L', 0], ['y', 'L', 0], ['z', 'Q', 1], 'junk', ['w', 'R', 99]]));
  const l = new Lanes(s);
  assert.deepEqual(l.get('x'), { side: 'L', row: 0 });
  assert.equal(l.get('y'), null);
  assert.equal(l.get('z'), null);
  assert.deepEqual(l.get('w'), { side: 'R', row: null });
  s.setItem('wb-lanes', '{not json');
  assert.equal(new Lanes(s).map.size, 0);
});

test('denseLanes: each lane splits in two, agents stay beside their old place, newcomers fill from the middle', () => {
  const l = new Lanes(null);
  l.assign(roots(18));
  const active = roots(18).map(r => ({ id: r.id }));
  const d = denseLanes(active, id => l.get(id));
  assert.equal(d.rows, 12);
  assert.equal(d.overflow.length, 0);
  for (let i = 0; i < 12; i++) {
    const base = l.get('a' + i), at = d.at.get('a' + i);
    assert.equal(at.side, base.side);
    assert.ok(at.row === 2 * base.row || at.row === 2 * base.row + 1, `a${i} beside its old place`);
  }
  const used = new Set([...d.at.values()].map(x => x.side + x.row));
  assert.equal(used.size, 18);
});

test('denseLanes: rows are capped by what fits, and what does not fit is reported', () => {
  const l = new Lanes(null);
  const many = roots(60, () => true);
  l.assign(many);
  const d = denseLanes(many, id => l.get(id), 14);
  assert.equal(d.rows, 12);
  assert.equal(d.at.size + d.overflow.length, 60);
  assert.equal(d.at.size, 24);
});
