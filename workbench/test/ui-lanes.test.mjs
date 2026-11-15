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

test('an agent that came while every lane was taken takes a lane on its own side once one is free there, and never crosses the core', () => {
  const l = new Lanes(null);
  l.assign(roots(14));
  assert.deepEqual([l.get('a12'), l.get('a13')], [{ side: 'L', row: null }, { side: 'R', row: null }]);
  const kept = new Map(Array.from({ length: 12 }, (_, i) => ['a' + i, { ...l.get('a' + i) }]));
  // a3, on the right, leaves: a13, waiting on the right, takes its lane; a12, on the left, waits on rather than cross
  const on = roots(14).filter(r => r.id !== 'a3');
  l.prune(on.map(r => r.id));
  l.assign(on);
  assert.deepEqual(l.get('a13'), kept.get('a3'), 'the freed lane, on its own side');
  assert.deepEqual(l.get('a12'), { side: 'L', row: null }, 'never a lane on the other side');
  for (const [id, lane] of kept) if (id !== 'a3') assert.deepEqual(l.get(id), lane, id + ' did not move');
  // two leave on the left: a12 takes one of their lanes
  const fewer = on.filter(r => !['a2', 'a6'].includes(r.id));
  l.prune(fewer.map(r => r.id));
  l.assign(fewer);
  assert.equal(l.get('a12').side, 'L');
  assert.ok([kept.get('a2').row, kept.get('a6').row].includes(l.get('a12').row), 'a lane freed on its own side');
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

test('denseLanes keeps who stays where they were: one that leaves frees its row, nobody moves, and the split never shrinks', () => {
  const l = new Lanes(null);
  const all = roots(26);   // 13 a side: each lane splits in three
  l.assign(all);
  const d1 = denseLanes(all, id => l.get(id));
  assert.equal(d1.k, 3);
  assert.equal(d1.rows, 18);
  // one leaves: the others keep their rows
  const less = all.filter(r => r.id !== 'a5');
  const d2 = denseLanes(less, id => l.get(id), Infinity, d1);
  for (const r of less) assert.deepEqual(d2.at.get(r.id), d1.at.get(r.id), r.id);
  // a third of them leave: the fuller side holds 9, which two rows a lane would hold, but the split stays at three
  const stay = all.filter((r, i) => i % 3 !== 0);
  const d3 = denseLanes(stay, id => l.get(id), Infinity, d2);
  assert.equal(d3.k, 3);
  for (const r of stay) assert.deepEqual(d3.at.get(r.id), d1.at.get(r.id), r.id + ' never moved');
  assert.equal(denseLanes(stay, id => l.get(id)).k, 2, 'laid out afresh (a reload), it would split in two');
  // a newcomer takes a free row on its own side, and nobody moves for it either
  l.assign([{ id: 'n', startedAt: 9999, laptop: true }]);
  const d4 = denseLanes([...stay, { id: 'n' }], id => l.get(id), Infinity, d3);
  assert.equal(d4.at.get('n').side, l.get('n').side);
  for (const r of stay) assert.deepEqual(d4.at.get(r.id), d1.at.get(r.id), r.id);
  // a window of another height lays it out afresh: that redraw moves everything anyway
  assert.equal(denseLanes(stay, id => l.get(id), 12, d3).k, 2);
});

test('denseLanes: a newcomer never takes a row on the other side; with its own side full it waits in the tray', () => {
  // the left full of agents with no lane of their own (twelve rows a side at this height), one agent on the right
  const lane = id => ({ side: id.startsWith('L') ? 'L' : 'R', row: null });
  const left = Array.from({ length: 13 }, (_, i) => ({ id: 'L' + i, startedAt: i }));
  const d = denseLanes([...left, { id: 'R0', startedAt: 50 }], lane, 12);
  assert.equal(d.rows, 12);
  assert.deepEqual(d.overflow, ['L12']);
  assert.ok([...d.at].every(([id, at]) => at.side === lane(id).side), 'everyone on their own side');
  assert.equal(d.at.get('R0').side, 'R');
});

test('denseLanes: one that needs the person always gets a row: with its side full it takes the newest working one\'s', () => {
  const lane = id => ({ side: 'L', row: null });
  const left = Array.from({ length: 12 }, (_, i) => ({ id: 'L' + i, startedAt: i, stop: 'mid' }));
  const d1 = denseLanes(left, lane, 12);
  assert.equal(d1.overflow.length, 0);
  // a thirteenth on the left, waiting in the tray, starts to ask
  const asker = { id: 'Q', startedAt: 3.5, stop: 'inner' };
  const d2 = denseLanes([asker, ...left], lane, 12, d1);
  assert.deepEqual(d2.at.get('Q'), d1.at.get('L11'), 'the newest working one\'s row');
  assert.deepEqual(d2.overflow, ['L11'], 'which waits in the tray');
  for (const r of left.slice(0, 11)) assert.deepEqual(d2.at.get(r.id), d1.at.get(r.id), r.id + ' did not move');
});
