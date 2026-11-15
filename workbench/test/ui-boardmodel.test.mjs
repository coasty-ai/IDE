// Who is on the board and who waits in the done tray (ui/boardmodel.js): a root the person is finished with leaves the
// board with its helpers, an earlier one never takes a lane, the lanes of those that left are free for newcomers while
// the others keep theirs, the tray's words, a reload that keeps finished agents off the board, and an agent that comes
// back to the board when it is continued. Pure modules only, so no browser and no /shared/ mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardModel, splitBoard, boardAndTray, trayWords } from '../ui/boardmodel.js';
import { Lanes, ROWS } from '../ui/lanes.js';
import { finishKey, readMarks, keepMarks } from '../ui/queue.js';
import { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY } from '../src/shared/states.mjs';

const STATES = { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY };
const T = 1_800_000_000_000, MIN = 60_000;
const memory = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
let seq = 0;
const agent = (id, state, o = {}) => ({ id, parentId: null, rootId: id, name: id, machineId: 'laptop', state, stateSince: T - MIN, startedAt: T - 90 * MIN + (++seq) * 1000,
  endedAt: ENDED.has(state) ? T - MIN : null, ask: null, earlier: false, work: null, files: null, ...o });
const helper = (id, parent, state, o = {}) => agent(id, state, { parentId: parent, rootId: parent, ...o });
const asking = (id, state = 'needs_ok') => ({ id: 'k-' + id, type: state === 'question' ? 'question' : 'permission', sentence: `${id} asks`, options: ['Allow', 'Deny'], createdAt: T - MIN });
const W = (o = {}) => ({ branch: 'workbench/x', from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
// merged and thrown away after the agents finished (at T - MIN), as the person does: settled since that finish
const MERGED = { into: 'main', merge: 'abc1234abc1234abc1234abc1234abc1234abcd', at: T - MIN / 2, files: 3, adds: 12, dels: 3 };
const THROWN = { at: T - MIN / 2, saved: 'refs/workbench/discarded/x' };
const files = n => ({ changed: n, adds: 4 * n, dels: n, list: [] });
const model = (agents, { reviewed = new Set(), later = new Set() } = {}) => boardModel(agents, { ...STATES, reviewed, later });
const ids = list => list.map(r => r.id);
const laptop = () => true;

test('the board keeps what works, waits or needs the person; the tray takes what the person is finished with, its helpers with it', () => {
  const list = [
    agent('W', 'working'), helper('W-h', 'W', 'working'),
    agent('Q', 'question', { ask: asking('Q', 'question') }),
    agent('F', 'done_checked', { work: W(), files: files(3) }), helper('F-h', 'F', 'finished'),     // finished, not looked at
    agent('L', 'checks_failed'),                                                                    // set aside: not finished
    agent('M', 'done_claimed', { work: W({ merged: MERGED }), files: files(0) }), helper('M-h', 'M', 'finished'),
    agent('X', 'stopped', { work: W({ branch: null, folder: false, thrownAway: THROWN }) }),
    agent('R', 'done_checked'),                                                                     // "Looks good"
    agent('S', 'failed'),                                                                           // "Dismiss"
    agent('H', 'done_claimed'), helper('H-h', 'H', 'needs_ok', { ask: asking('H-h') }),            // looked at, but a helper asks
    agent('E', 'done_checked', { earlier: true, canContinue: true }),
  ];
  const reviewed = new Set(['R', 'S', 'H'].map(id => finishKey(list.find(a => a.id === id))));
  const later = new Set([finishKey(list.find(a => a.id === 'L'))]);
  const bm = model(list, { reviewed, later });
  const { on, done, earlier } = splitBoard(bm.roots);
  assert.deepEqual(ids(on), ['W', 'Q', 'F', 'L', 'H']);
  assert.deepEqual(ids(done), ['M', 'X', 'R', 'S']);
  assert.deepEqual(ids(earlier), ['E']);
  assert.deepEqual(bm.roots.filter(r => r.handled).map(r => r.id), ['M', 'X', 'R', 'S'], 'handled: finished with');
  const byId = new Map(bm.roots.map(r => [r.id, r]));
  assert.equal(byId.get('F').stop, 'edge', 'finished work not looked at waits at the edge, as before');
  assert.equal(byId.get('L').stop, 'edge', 'a failed check set aside waits at the edge too');
  assert.equal(byId.get('H').stop, 'inner', 'a helper that asks keeps its agent on the board, lit');
  // a helper never takes a lane or a place in the tray of its own: it goes where its agent goes
  assert.ok(!bm.roots.some(r => r.id.endsWith('-h')));
  assert.deepEqual(byId.get('M').kids.map(k => k.id), ['M-h']);
});

test('lanes: only the roots on the board hold one; the lanes of those that leave are free, the others keep theirs, and a newcomer may take a freed one', () => {
  const lanes = new Lanes(memory());
  const list = [agent('A', 'working'), agent('B', 'working'), agent('C', 'done_checked'), agent('D', 'working')];
  let b = boardAndTray(model(list).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B', 'C', 'D']);
  const was = new Map(ids(b.roots).map(id => [id, { ...lanes.get(id) }]));
  // the person says "Looks good" to C: it leaves the board, and its lane is free
  b = boardAndTray(model(list, { reviewed: new Set([finishKey(list[2])]) }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B', 'D']);
  assert.deepEqual(b.trayIds.done, ['C']);
  assert.equal(lanes.get('C'), null, 'its lane is free');
  for (const id of ['A', 'B', 'D']) assert.deepEqual(b.laneOf(id), was.get(id), id + ' kept its lane');
  // a new agent takes the freed lane; nobody moves
  const more = [...list, agent('N', 'starting')];
  b = boardAndTray(model(more, { reviewed: new Set([finishKey(list[2])]) }).roots, lanes, { laptop });
  assert.deepEqual(b.laneOf('N'), was.get('C'), 'the newcomer takes the freed lane');
  for (const id of ['A', 'B', 'D']) assert.deepEqual(b.laneOf(id), was.get(id), id + ' still on its lane');
});

test('the tray holds this run\'s finished agents, newest first, then the earlier ones, with their marks and short words', () => {
  const list = [
    agent('old', 'done_checked', { endedAt: T - 9 * MIN, work: W({ merged: MERGED }), files: files(0) }),
    agent('new', 'stopped', { endedAt: T - 2 * MIN, work: W({ branch: null, folder: false, thrownAway: THROWN }) }),
    agent('w', 'working'),
    agent('e1', 'done_claimed', { earlier: true, endedAt: T - 3 * 24 * 60 * MIN }), agent('e2', 'failed', { earlier: true, endedAt: T - 2 * 24 * 60 * MIN }),
  ];
  const b = boardAndTray(model(list).roots, new Lanes(null), { laptop });
  assert.deepEqual(ids(b.roots), ['w']);
  assert.deepEqual(b.trayIds, { done: ['new', 'old'], earlier: ['e1', 'e2'], over: [] });
  const t = b.tray;
  assert.equal(t.count, 4);
  assert.equal(t.text, '2 done, 2 from earlier');
  assert.deepEqual([t.lead, t.rest], ['2 done', ', 2 from earlier']);
  assert.equal(t.aria, '2 done, 2 from an earlier run. Show them.');
  assert.equal(t.sum, '2 done, 2 from an earlier run');
  assert.deepEqual(t.marks.map(m => m.shape), ['off', 'ok', 'word', 'fail'], 'each one\'s own mark, in the same order');
  // nothing finished and nothing from earlier: no tray at all
  assert.equal(boardAndTray(model([agent('w2', 'working')]).roots, new Lanes(null), { laptop }).tray, null);
});

test('dense: past twelve on the board, finished work there moves to the tray too and keeps its lane; agents the person is done with do not count', () => {
  // twelve at work and three the person is done with: twelve on the board, so it is not dense
  const twelve = Array.from({ length: 12 }, (_, i) => agent('w' + i, 'working'));
  const gone = Array.from({ length: 3 }, (_, i) => agent('g' + i, 'done_checked'));
  let b = boardAndTray(model([...twelve, ...gone], { reviewed: new Set(gone.map(finishKey)) }).roots, new Lanes(null), { laptop });
  assert.equal(b.dense, false);
  assert.equal(b.nRows, ROWS);
  assert.deepEqual(b.trayIds.done, ['g0', 'g1', 'g2']);
  // thirteen at work and two finished, not looked at: dense; the two wait in the tray, still holding their lanes
  const lanes = new Lanes(null);
  const busy = [...Array.from({ length: 13 }, (_, i) => agent('x' + i, 'working')), agent('f0', 'done_checked'), agent('f1', 'stopped')];
  b = boardAndTray(model(busy).roots, lanes, { laptop, maxRows: 24 });
  assert.equal(b.dense, true);
  assert.deepEqual(new Set(b.trayIds.done), new Set(['f0', 'f1']));
  assert.ok(!ids(b.roots).includes('f0') && !ids(b.roots).includes('f1'));
  assert.ok(lanes.get('f0') && lanes.get('f1'), 'a dense board\'s finished work keeps its lane for when the board thins out');
  assert.equal(b.tray.text, '2 done');
});

test('thirteen on the board, then one is let go: the board is not dense any more, and every agent left has a lane of its own', () => {
  const lanes = new Lanes(memory());
  const first = agent('first', 'done_checked', { work: W(), files: files(1) });
  const rest = Array.from({ length: 12 }, (_, i) => agent('r' + i, 'working'));
  let b = boardAndTray(model([first, ...rest]).roots, lanes, { laptop: r => r.id.endsWith('0') || r.id === 'first', maxRows: 24 });
  assert.equal(b.dense, true);
  assert.equal(lanes.get('r11').row, null, 'the last to come had a side but no row');
  b = boardAndTray(model([first, ...rest], { reviewed: new Set([finishKey(first)]) }).roots, lanes, { laptop: r => r.id.endsWith('0') || r.id === 'first', maxRows: 24 });
  assert.equal(b.dense, false);
  assert.deepEqual(ids(b.roots), ids(rest));
  const used = new Set();
  for (const r of rest) {
    const l = b.laneOf(r.id);
    assert.ok(l && l.row != null, r.id + ' has a row, so it is drawn');
    used.add(l.side + l.row);
  }
  assert.equal(used.size, 12, 'one agent a lane');
  assert.deepEqual(b.trayIds.done, ['first']);
});

test('the tray\'s words: short, "3 done", with earlier agents and working ones with no room counted as before', () => {
  assert.deepEqual(trayWords({ done: 3 }), { lead: '3 done', rest: '', text: '3 done', sum: '3 done', aria: '3 done. Show them.' });
  assert.equal(trayWords({ done: 1 }).text, '1 done');
  assert.equal(trayWords({ earlier: 5 }).text, '5 from earlier');
  assert.equal(trayWords({ earlier: 5 }).aria, '5 from an earlier run. Show them.');
  assert.equal(trayWords({ done: 2, earlier: 5 }).text, '2 done, 5 from earlier');
  assert.equal(trayWords({ done: 2, earlier: 5, over: 1 }).text, '2 done, 5 from earlier, 1 more working');
  assert.equal(trayWords({ done: 4, over: 2 }).aria, '4 done, 2 more working with no room on the board. Show them.');
});

test('a reload keeps finished agents off the board: the tab keeps the looks and the lanes, and a draw before the agents arrive frees nothing', () => {
  const tab = memory();
  const list = [agent('A', 'done_checked', { work: W(), files: files(2) }), agent('B', 'working'), agent('C', 'working'), agent('M', 'done_claimed', { work: W({ merged: MERGED }), files: files(0) })];
  // the page as it loads: the marks and lanes this tab kept (none yet)
  let reviewed = readMarks(tab, 'wb-reviewed'), later = readMarks(tab, 'wb-later'), lanes = new Lanes(tab);
  let b = boardAndTray(model(list, { reviewed, later }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B', 'C'], 'the merged one is in the tray from the start: the engine says so');
  const placeB = { ...lanes.get('B') }, placeC = { ...lanes.get('C') };
  // "Looks good" on A, kept the way model.js keeps it
  reviewed.add(finishKey(list[0])); keepMarks(tab, 'wb-reviewed', reviewed);
  b = boardAndTray(model(list, { reviewed, later }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['B', 'C']);
  // a reload: a new page in the same tab
  reviewed = readMarks(tab, 'wb-reviewed'); later = readMarks(tab, 'wb-later'); lanes = new Lanes(tab);
  // its first draw comes before the snapshot, with no agents: it must free no lane
  b = boardAndTray([], lanes, { laptop, prune: false });
  assert.deepEqual(lanes.get('B'), placeB);
  assert.deepEqual(lanes.get('C'), placeC);
  // the snapshot arrives
  b = boardAndTray(model(list, { reviewed, later }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['B', 'C'], 'A stays in the tray after the reload');
  assert.deepEqual(b.trayIds.done.sort(), ['A', 'M']);
  assert.deepEqual(b.laneOf('B'), placeB, 'and the others are where they were');
  assert.deepEqual(b.laneOf('C'), placeC);
  // a tab that kept nothing (a new window) still keeps what the engine knows off the board: merged, or thrown away
  b = boardAndTray(model(list).roots, new Lanes(memory()), { laptop });
  assert.ok(b.trayIds.done.includes('M') && !ids(b.roots).includes('M'));
});

test('picked from the tray, a merge that does not go through brings it back to the board, and "Look later" keeps it there', () => {
  const lanes = new Lanes(null);
  const a = agent('A', 'done_checked', { work: W(), files: files(3) });
  const reviewed = new Set([finishKey(a)]);     // "Not now"
  let b = boardAndTray(model([a, agent('B', 'working')], { reviewed }).roots, lanes, { laptop });
  assert.deepEqual(b.trayIds.done, ['A']);
  const p = { ...a, work: W({ problem: { why: 'conflict', sentence: 'It does not merge cleanly into main.', paths: ['src/a.js'], at: T } }) };
  b = boardAndTray(model([p, agent('B', 'working')], { reviewed }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B']);
  assert.equal(b.roots.find(r => r.id === 'A').stop, 'edge');
  assert.equal(b.tray, null);
  b = boardAndTray(model([p, agent('B', 'working')], { reviewed, later: new Set([finishKey(p)]) }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B'], 'set aside, it stays');
  // the problem clears (Try again went through): merged with nothing new, it is finished with again
  const merged = { ...p, work: W({ merged: { ...MERGED, at: T + MIN } }), files: files(0) };
  assert.deepEqual(boardAndTray(model([merged, agent('B', 'working')], { reviewed }).roots, lanes, { laptop }).trayIds.done, ['A']);
});

test('an agent in the tray that is continued, told something or asked for a change comes back to the board, on a lane, at work', () => {
  const lanes = new Lanes(null);
  const a = agent('A', 'stopped', { work: W(), files: null });
  const reviewed = new Set([finishKey(a)]);     // "Dismiss"
  let b = boardAndTray(model([a, agent('B', 'working')], { reviewed }).roots, lanes, { laptop });
  assert.deepEqual(b.trayIds.done, ['A']);
  // Continue: the engine has it at work again
  const back = { ...a, state: 'working', endedAt: null, stateSince: T, now: 'Picking up where it left off' };
  b = boardAndTray(model([back, agent('B', 'working')], { reviewed }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B']);
  const r = b.roots.find(x => x.id === 'A');
  assert.ok(b.laneOf('A') && b.laneOf('A').row != null, 'on a lane');
  assert.equal(r.stop, 'mid');
  assert.equal(r.working, true);
  assert.equal(b.tray, null);
  // it finishes again: a new finish, not looked at yet, so it stays at the edge
  const again = { ...back, state: 'done_claimed', endedAt: T + 5 * MIN, files: files(1) };
  b = boardAndTray(model([again, agent('B', 'working')], { reviewed }).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['A', 'B']);
  assert.equal(b.roots.find(x => x.id === 'A').stop, 'edge');
  // a merged one asked for a change works again, and stays once it has new work not merged yet
  const m = agent('M', 'done_claimed', { work: W({ merged: MERGED }), files: files(0) });
  assert.deepEqual(boardAndTray(model([m]).roots, lanes, { laptop }).trayIds.done, ['M']);
  const busy = { ...m, state: 'working', endedAt: null, files: null };
  assert.deepEqual(ids(boardAndTray(model([busy]).roots, lanes, { laptop }).roots), ['M']);
  const changed = { ...m, state: 'done_claimed', endedAt: T + 9 * MIN, files: files(2) };
  assert.deepEqual(ids(boardAndTray(model([changed]).roots, lanes, { laptop }).roots), ['M']);
  // asked for a change that brings nothing new: its work is all in still, but what it said has not been seen, so it
  // stays at the edge until it is looked at
  const same = { ...m, state: 'done_claimed', endedAt: T + 9 * MIN, files: files(0), says: 'Nothing needed changing.' };
  b = boardAndTray(model([same]).roots, lanes, { laptop });
  assert.deepEqual(ids(b.roots), ['M']);
  assert.equal(b.roots[0].stop, 'edge');
  assert.deepEqual(boardAndTray(model([same], { reviewed: new Set([finishKey(same)]) }).roots, lanes, { laptop }).trayIds.done, ['M'], '"Looks good" lets it go');
});
