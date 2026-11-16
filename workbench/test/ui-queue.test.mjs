import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finishKey, needsPerson, needsQueue, reviewQueue, setAsideList, stepFrom, helpersByNeed, helpersAtWork, finishedWith, finishedSinceSettled, readMarks, keepMarks } from '../ui/queue.js';
import { unmergedWork, workSettled, workKey, canReview, mergeApplies, discardApplies, gitReason } from '../ui/queue.js';
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

// ---------------------------------------------------------------- an agent's work: merge, review, throw away
const work = (o = {}) => ({ branch: 'workbench/invoice-export-a1b2c3', from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
const files = n => ({ changed: n, adds: 4 * n, dels: n, list: [] });
const done = (o = {}) => ag('W', 'done_checked', { endedAt: 500, work: work(), files: files(3), ...o });
const live = (repo = {}) => ({ ACTIVE, meta: { mode: 'live', repo: { name: 'invoices-api', head: 'abc1234', branch: 'main', dirty: 0, identity: true, ...repo } } });
// merged and thrown away after `done()` finished (at 500), as the person does: settled since that finish
const MERGED = { into: 'main', merge: 'e4f1c3a9b8d7e4f1c3a9b8d7e4f1c3a9b8d7e4f1', at: 600, files: 3, adds: 12, dels: 3 };
const THROWN = { at: 650, saved: 'refs/workbench/discarded/W' };

test('merge applies: live mode, a root at rest with its folder and branch, your folder on a branch git can commit on, and unmerged work', () => {
  assert.equal(mergeApplies(done(), live()), true);
  assert.equal(mergeApplies(done({ state: 'done_claimed' }), live()), true);
  assert.equal(mergeApplies(done({ state: 'checks_failed' }), live()), true, 'a failed check can be merged anyway');
  assert.equal(mergeApplies(done(), live({ identity: undefined })), true, 'not known yet counts as known: the engine checks again');
  // not here
  assert.equal(mergeApplies(done(), { ACTIVE, meta: { mode: 'demo', repo: null } }), false, 'the demo');
  assert.equal(mergeApplies(done(), { ACTIVE, meta: { mode: 'live', repo: null } }), false, 'no repository');
  assert.equal(mergeApplies(done(), live({ branch: null })), false, 'not on a branch');
  assert.equal(mergeApplies(done(), live({ identity: false })), false, 'no name and email');
  for (const st of ACTIVE) assert.equal(mergeApplies(done({ state: st }), live()), false, st);
  assert.equal(mergeApplies(done({ parentId: 'P' }), live()), false, 'a helper');
  assert.equal(mergeApplies(done({ work: null }), live()), false, 'no git');
  assert.equal(mergeApplies(done({ work: work({ folder: false }) }), live()), false, 'its folder is gone');
  assert.equal(mergeApplies(done({ work: work({ branch: null, folder: false, thrownAway: THROWN }) }), live()), false, 'thrown away');
  assert.equal(mergeApplies(done({ files: files(0) }), live()), false, 'nothing unmerged');
});

test('while an agent that said it is done is checked again (a save into its copy), merge does not apply: the engine refuses it then', () => {
  const again = done({ state: 'done_claimed', checks: { state: 'running', results: [] } });
  assert.equal(mergeApplies(again, live()), false);
  assert.equal(gitReason(again, live({ branch: null })), null, 'and git is not the reason');
  assert.equal(mergeApplies(done({ state: 'done_claimed', checks: { state: 'none', results: [] } }), live()), true, 'no checks to run: it can be merged at once');
  assert.equal(mergeApplies(done({ state: 'done_checked', checks: { state: 'passed', results: [] } }), live()), true);
  assert.equal(discardApplies(again, live()), true, 'its work can still be thrown away');
});

test('unmerged work: files changed since its last merge, or, when nothing counted them, a stopped, failed or earlier agent', () => {
  assert.equal(unmergedWork(done()), true);
  assert.equal(unmergedWork(done({ files: files(0) })), false);
  for (const st of ['stopped', 'failed']) assert.equal(unmergedWork(done({ state: st, files: null })), true, st);
  assert.equal(unmergedWork(done({ files: null, earlier: true })), true, 'an earlier agent');
  for (const st of ['done_checked', 'done_claimed', 'checks_failed']) assert.equal(unmergedWork(done({ state: st, files: null })), false, `${st} without files`);
  assert.equal(unmergedWork(done({ work: work({ folder: false }) })), false, 'nothing to merge from a folder that is gone');
  assert.equal(unmergedWork(done({ work: null })), false);
  assert.equal(mergeApplies(done({ state: 'stopped', files: null }), live()), true);
  assert.equal(mergeApplies(done({ state: 'done_claimed', files: null }), live()), false);
});

test('settled work: thrown away, or merged with nothing new since; it needs no one and is not "to look at"', () => {
  assert.equal(workSettled(done({ work: work({ merged: MERGED }), files: files(0) })), true);
  assert.equal(workSettled(done({ work: work({ merged: MERGED }), files: files(2) })), false, 'new work since the merge');
  assert.equal(workSettled(done({ work: work({ branch: null, folder: false, thrownAway: THROWN }) })), true);
  assert.equal(workSettled(done()), false);
  assert.equal(workSettled(done({ work: null })), false);
  // the queues
  const a = done({ id: 'a', work: work({ merged: MERGED }), files: files(0) }), b = done({ id: 'b', endedAt: 700 });
  const c = done({ id: 'c', state: 'done_claimed', endedAt: 600, work: work({ branch: null, folder: false, thrownAway: THROWN }) });
  assert.deepEqual(reviewQueue([a, b, c], { reviewed: new Set() }).map(x => x.id), ['b'], 'merged and thrown away are out of the review queue');
  const failedCheck = ag('f', 'checks_failed', { endedAt: 500, work: work({ merged: MERGED }), files: files(0) });
  assert.equal(needsPerson(failedCheck, { NEEDS_YOU }), false, 'a failed check merged anyway needs no one');
  assert.equal(needsPerson({ ...failedCheck, files: files(1) }, { NEEDS_YOU }), true, 'until it has new work');
  assert.equal(needsPerson({ ...failedCheck, work: work({ branch: null, folder: false, thrownAway: THROWN }) }, { NEEDS_YOU }), false, 'or once thrown away');
});

test('a merge that did not go through can be set aside like a failed check, for this finish only', () => {
  const p = done({ work: work({ problem: { why: 'blocked', sentence: 'Your own changes are in the way: a.js. Commit or put them aside, then merge again.', paths: ['a.js'], at: 600 } }) });
  assert.deepEqual(reviewQueue([p], { reviewed: new Set() }).map(x => x.id), ['W'], 'a problem stays to look at');
  const later = new Set([finishKey(p)]);
  assert.deepEqual(reviewQueue([p], { reviewed: new Set(), later }), [], '"Not now" or "Look later" sets it aside');
  assert.deepEqual(setAsideList([p], { later }).map(x => x.id), ['W'], 'and it is listed as set aside');
  assert.deepEqual(reviewQueue([{ ...p, endedAt: 900 }], { reviewed: new Set(), later }).map(x => x.id), ['W'], 'a new finish brings it back');
  assert.deepEqual(setAsideList([ag('E', 'done_checked', { endedAt: 500, earlier: true })], { later: new Set(['E@500']) }), [], 'never an earlier agent');
});

test('the work signature changes with each outcome, and not with how many files changed', () => {
  const keys = [
    workKey(done()),
    workKey(done({ work: work({ merged: MERGED }), files: files(0) })),
    workKey(done({ work: work({ merged: { ...MERGED, merge: 'bbbb' } }), files: files(0) })),
    workKey(done({ work: work({ merged: MERGED }), files: files(2) })),
    workKey(done({ work: work({ problem: { why: 'conflict', sentence: 's', paths: [], at: 1 } }) })),
    workKey(done({ work: work({ problem: { why: 'conflict', sentence: 's', paths: [], at: 2 } }) })),
    workKey(done({ work: work({ problem: { why: 'blocked', sentence: 's', paths: [], at: 1 } }) })),
    workKey(done({ work: work({ branch: null, folder: false, thrownAway: THROWN }) })),
    workKey(done({ work: work({ folder: false }) })),
  ];
  assert.equal(new Set(keys).size, keys.length, keys.join(' | '));
  assert.equal(workKey(done({ files: files(7) })), workKey(done()), 'more files is the same work for a button');
  assert.equal(workKey(done({ work: null })), '');
  assert.equal(workKey(done({ parentId: 'P' })), '', 'a helper has no work of its own');
});

test('review needs its branch and folder; throw away needs only one of them', () => {
  assert.equal(canReview(done()), true);
  assert.equal(canReview(done({ work: work({ folder: false }) })), false);
  assert.equal(canReview(done({ work: work({ branch: null }) })), false);
  assert.equal(canReview(done({ parentId: 'P' })), false);
  assert.equal(discardApplies(done(), live()), true);
  assert.equal(discardApplies(done({ state: 'working' }), live()), true, 'an agent at work is stopped first');
  assert.equal(discardApplies(done({ work: work({ folder: false }) }), live()), true, 'its branch is still deleted when its folder is gone');
  assert.equal(discardApplies(done({ work: work({ branch: null, folder: false, thrownAway: THROWN }) }), live()), false, 'already thrown away');
  assert.equal(discardApplies(done({ work: work({ branch: null, folder: false }) }), live()), false, 'nothing left');
  assert.equal(discardApplies(done(), { ACTIVE, meta: { mode: 'demo', repo: null } }), false, 'the demo');
  assert.equal(discardApplies(done({ parentId: 'P' }), live()), false, 'a helper');
});

test('why there is no Merge, when git is the reason: in the engine\'s own words', () => {
  assert.equal(gitReason(done(), live({ branch: null })), 'Your folder is not on a branch, so there is nowhere to merge it.');
  assert.equal(gitReason(done(), live({ identity: false })), 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.');
  assert.equal(gitReason(done(), live()), null, 'merge applies');
  assert.equal(gitReason(done({ files: files(0) }), live({ branch: null })), null, 'nothing to merge: git is not the reason');
  assert.equal(gitReason(done({ state: 'working' }), live({ branch: null })), null, 'still working');
  assert.equal(gitReason(done(), { ACTIVE, meta: { mode: 'demo', repo: { branch: null } } }), null, 'the demo');
});

// ---------------------------------------------------------------- finished with: a root that leaves the board for the done tray
const memory = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const marks = (o = {}) => ({ NEEDS_YOU, reviewed: new Set(), later: new Set(), ...o });

test('finished with: an ended root the person let go, by a look ("Looks good", "Not now" on work that can merge, "Dismiss")', () => {
  const d = done(), k = finishKey(d);
  assert.equal(finishedWith(d, marks()), false, 'finished work not looked at yet stays on the board');
  assert.equal(finishedWith(d, marks({ reviewed: new Set([k]) })), true);
  for (const st of ['done_checked', 'done_claimed', 'failed', 'stopped']) {
    assert.equal(finishedWith(ag('x', st, { endedAt: 5 }), marks({ reviewed: new Set(['x@5']) })), true, st);
  }
  assert.equal(finishedWith({ ...d, endedAt: 900 }, marks({ reviewed: new Set([k]) })), false, 'a look counts for one finish: finishing again brings it back');
  assert.equal(finishedWith(d, marks({ reviewed: new Set([k]), later: new Set([k]) })), false,
    'set aside ("Look later", "Not now" on a merge that did not go through) is not finished, even after a look');
  assert.equal(finishedWith(ag('c', 'checks_failed', { endedAt: 7 }), marks({ reviewed: new Set(['c@7']) })), false, 'a failed check still needs the person');
});

test('finished with: work the engine says is settled (merged with nothing new, or thrown away) needs no look', () => {
  const merged = done({ work: work({ merged: MERGED }), files: files(0) });
  const thrown = done({ state: 'stopped', work: work({ branch: null, folder: false, thrownAway: THROWN }), files: null });
  assert.equal(finishedWith(merged, marks()), true, 'merged');
  assert.equal(finishedWith(thrown, marks()), true, 'thrown away');
  assert.equal(finishedWith({ ...merged, files: files(2) }, marks()), false, 'merged, then work that is not merged yet');
  assert.equal(finishedWith(ag('f', 'checks_failed', { endedAt: 500, work: work({ merged: MERGED }), files: files(0) }), marks()), true, 'a failed check merged anyway');
  assert.equal(finishedWith(thrown, marks({ later: new Set([finishKey(thrown)]) })), true, 'settled wins over set aside: there is nothing left to come back to');
  assert.deepEqual(setAsideList([thrown, merged], { later: new Set([finishKey(thrown), finishKey(merged)]) }), [], 'and settled work is not listed as set aside');
});

test('finished with: never a root at work or waiting on the person, a helper, or an agent from an earlier run', () => {
  const merged = done({ work: work({ merged: MERGED }), files: files(0) });
  // a merged agent asked for a change works again: its files are not counted yet, so its work still reads as settled
  assert.equal(finishedWith({ ...merged, state: 'working', endedAt: null, files: null }, marks()), false, 'at work again');
  for (const st of ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']) {
    assert.equal(finishedWith(ag('w', st, { endedAt: 3 }), marks({ reviewed: new Set(['w@3']) })), false, st);
  }
  assert.equal(finishedWith(ag('h', 'finished', { parentId: 'W', endedAt: 1 }), marks({ reviewed: new Set(['h@1']) })), false, 'a helper goes with its agent');
  assert.equal(finishedWith({ ...merged, earlier: true }, marks()), false, 'an earlier agent waits in the tray by its own rule');
  assert.equal(finishedWith(null, marks()), false);
});

test('finished with: never while its work has a problem (a merge that did not go through), whatever the person said before', () => {
  const p = done({ work: work({ problem: { why: 'conflict', sentence: 'Invoice export’s work does not merge cleanly into main.', paths: ['src/a.js'], at: 600 } }) });
  const k = finishKey(p);
  // "Not now" sent it to the tray, then it was picked there and merged, and the merge did not go through
  assert.equal(finishedWith(p, marks({ reviewed: new Set([k]) })), false, 'the problem brings it back to the board');
  assert.equal(finishedWith(p, marks({ reviewed: new Set([k]), later: new Set([k]) })), false, '"Look later" on the problem keeps it there');
  for (const st of ['done_claimed', 'failed', 'stopped']) assert.equal(finishedWith({ ...p, state: st }, marks({ reviewed: new Set([k]) })), false, st);
  assert.equal(finishedWith({ ...p, work: work() }, marks({ reviewed: new Set([k]) })), true, 'once the problem is gone, the look holds again');
  // and it is to be looked at: a look from before the problem does not count for it, while setting it aside does
  assert.deepEqual(reviewQueue([p], { reviewed: new Set([k]) }).map(x => x.id), ['W']);
  assert.deepEqual(reviewQueue([{ ...p, state: 'stopped', files: null }], { reviewed: new Set([k]) }).map(x => x.id), ['W'], 'a stopped one too');
  assert.deepEqual(reviewQueue([p], { reviewed: new Set([k]), later: new Set([k]) }), []);
  assert.deepEqual(setAsideList([p], { later: new Set([k]) }).map(x => x.id), ['W'], 'set aside, it is listed as such');
  // a failed check whose "Merge anyway" did not go through needs the person already: it is not in the review queue twice
  const cf = { ...p, state: 'checks_failed' };
  assert.equal(needsPerson(cf, { NEEDS_YOU }), true);
  assert.deepEqual(reviewQueue([cf], { reviewed: new Set() }), []);
});

test('finished with: settled work that finished again since waits to be looked at, so what it said is seen', () => {
  const merged = done({ work: work({ merged: MERGED }), files: files(0) });     // finished at 500, merged at 600
  assert.equal(finishedSinceSettled(merged), false);
  assert.equal(finishedWith(merged, marks()), true);
  assert.equal(finishedWith({ ...merged, endedAt: 600 }, marks()), true, 'a merge at the moment it finished counts as after it');
  // asked for a change, it finishes again at 900 with nothing new: all of its work is in still, but this finish is unseen
  const again = { ...merged, endedAt: 900, says: 'Nothing needed changing: the export already batches.' };
  assert.equal(workSettled(again), true);
  assert.equal(finishedSinceSettled(again), true);
  assert.equal(finishedWith(again, marks()), false, 'it stays on the board, at the edge');
  assert.deepEqual(reviewQueue([again], { reviewed: new Set() }).map(x => x.id), ['W'], 'and is to be looked at');
  const seen = new Set([finishKey(again)]);
  assert.equal(finishedSinceSettled(again, { reviewed: seen }), false);
  assert.equal(finishedWith(again, marks({ reviewed: seen })), true, '"Looks good" lets it go');
  assert.deepEqual(reviewQueue([again], { reviewed: seen }), []);
  // work thrown away the same way
  const thrown = done({ state: 'stopped', work: work({ branch: null, folder: false, thrownAway: THROWN }), files: null });
  assert.equal(finishedWith(thrown, marks()), true);
  assert.equal(finishedWith({ ...thrown, endedAt: 900 }, marks()), false);
  // a failed check merged anyway whose check fails again with nothing new needs the person, and can be set aside
  const cf = ag('f', 'checks_failed', { endedAt: 500, work: work({ merged: MERGED }), files: files(0) });
  assert.equal(needsPerson(cf, { NEEDS_YOU }), false);
  const cf2 = { ...cf, endedAt: 900 };
  assert.equal(needsPerson(cf2, { NEEDS_YOU }), true);
  assert.equal(needsPerson(cf2, { NEEDS_YOU, later: new Set([finishKey(cf2)]) }), false);
  assert.deepEqual(setAsideList([cf2], { later: new Set([finishKey(cf2)]) }).map(x => x.id), ['f']);
});

test('the marks the page keeps for its tab ("looked at", "set aside") read back as they were kept', () => {
  const tab = memory();
  keepMarks(tab, 'wb-reviewed', new Set(['a@1', 'b@2']));
  assert.deepEqual([...readMarks(tab, 'wb-reviewed')], ['a@1', 'b@2']);
  assert.deepEqual([...readMarks(tab, 'wb-later')], [], 'nothing kept yet');
  tab.setItem('wb-reviewed', '{not json');
  assert.equal(readMarks(tab, 'wb-reviewed').size, 0, 'a damaged entry reads as none');
  tab.setItem('wb-reviewed', JSON.stringify(['a@1', 3, null, { k: 1 }]));
  assert.deepEqual([...readMarks(tab, 'wb-reviewed')], ['a@1'], 'only strings');
  assert.equal(readMarks(null, 'wb-reviewed').size, 0, 'no storage (a private window)');
  assert.doesNotThrow(() => keepMarks(null, 'wb-reviewed', new Set(['a@1'])));
  assert.doesNotThrow(() => keepMarks({ getItem: () => null, setItem: () => { throw new Error('full'); } }, 'wb-reviewed', new Set(['a@1'])), 'a full storage');
  keepMarks(tab, 'wb-reviewed', new Set(Array.from({ length: 350 }, (_, i) => 'k' + i)));
  const back = readMarks(tab, 'wb-reviewed');
  assert.equal(back.size, 300, 'the newest 300');
  assert.ok(back.has('k349') && !back.has('k49'));
});
