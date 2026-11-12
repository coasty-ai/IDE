// The core's words and buttons (ui/focus.js). The page imports /shared/... by URL, so this maps that path to
// src/shared/ with module.registerHooks (Node 22.15 and later); on older Node the test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SHARED = fileURLToPath(new URL('../src/shared/', import.meta.url));
const canMap = typeof nodeModule.registerHooks === 'function';
if (canMap) {
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith('/shared/')) return { url: pathToFileURL(SHARED + spec.slice('/shared/'.length)).href, shortCircuit: true };
      return next(spec, ctx);
    },
  });
}
const skip = canMap ? false : 'needs module.registerHooks (Node 22.15 or later)';
const load = async () => ({ ...(await import('../ui/focus.js')), ...(await import('../ui/model.js')) });

const NOW = Date.now();
const agent = (id, state, o = {}) => ({ id, parentId: null, rootId: id, name: 'Checkout fix', harness: 'claude', machineId: 'laptop', state, stateSince: NOW - 60000,
  startedAt: NOW - 600000, endedAt: null, now: 'Reading checkout.ts', ask: null, usage: { costUsd: 0.4 }, budgetUsd: 2, helpers: { total: 0, working: 0, done: 0 }, ...o });
/** Every [data-act] button in some markup, with its data attributes. */
const buttons = html => [...html.matchAll(/<button\b([^>]*)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]))).filter(b => b.act);
const STATES_ALL = ['needs_ok', 'question', 'maybe_stuck', 'checks_failed', 'done_checked', 'done_claimed', 'failed', 'stopped', 'waiting_helpers', 'working', 'finished'];

test('every button is bound to what it was drawn for', { skip }, async () => {
  const { lidView, S } = await load();
  for (const st of STATES_ALL) {
    const ask = ['needs_ok', 'question', 'maybe_stuck'].includes(st)
      ? { id: 'ask-' + st, type: st === 'needs_ok' ? 'permission' : st === 'question' ? 'question' : 'stuck', sentence: 'Checkout fix wants to run a command', detail: 'npm test', options: st === 'question' ? [] : undefined, createdAt: NOW }
      : null;
    const a = agent('A1', st, { ask, parentId: st === 'finished' ? 'P' : null, checks: { state: 'failed', results: [{ name: 'tests', ok: false }] } });
    S.agents.clear(); S.agents.set('A1', a); S.agents.set('P', agent('P', 'working', { name: 'Parent' }));
    for (const detail of ['calm', 'more']) {
      const v = lidView({ agent: a, index: 0, total: 2 }, { detail });
      for (const b of buttons(v.html)) {
        if (['next', 'exact', 'changed', 'readall', 'unpick'].includes(b.act)) continue;
        assert.equal(b.agent, 'A1', `${st} ${detail}: ${b.act} carries data-agent`);
        if (b.act === 'answer' || (b.act === 'reply' && ask)) assert.equal(b.ask, ask.id, `${st} ${detail}: ${b.act} carries the drawn ask id`);
      }
      assert.equal(v.bind.agentId, 'A1');
      if (ask) assert.equal(v.bind.askId, ask.id);
    }
  }
  const c = lidView({ confirm: { id: 'c1', sentence: 'Start a simulated Claude on “fix it”?', detail: 'It runs on your laptop.' } }, {});
  const cb = buttons(c.html);
  assert.equal(cb.length, 2);
  for (const b of cb) assert.equal(b.confirm, 'c1');
  assert.deepEqual(c.bind, { confirmId: 'c1' });
});

test('a permission shows the exact command and the reason, in plain sight, with Allow and Deny of equal weight', { skip }, async () => {
  const { lidView, S } = await load();
  const a = agent('A1', 'needs_ok', { ask: { id: 'k', type: 'permission', sentence: 'Checkout fix wants to run a command', detail: 'git push --force origin main', why: 'This git command can change the repository.', options: ['Allow', 'Deny'], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A1', a);
  for (const detail of ['calm', 'more']) {
    const v = lidView({ agent: a, index: 0, total: 1 }, { detail });
    assert.match(v.html, /<code>git push --force origin main<\/code>/);
    assert.doesNotMatch(v.html, /<div class="exact"[^>]*hidden/);
    assert.match(v.html, /This git command can change the repository\./);
    assert.doesNotMatch(v.html, /class="big pri"/, 'no answer is the dark default');
    assert.match(v.say, /git push --force origin main/);
  }
});

test('a long command is cut in the middle with a way to see all of it; control characters show', { skip }, async () => {
  const { lidView, S } = await load();
  const cmd = 'rm -rf build\n' + 'echo hi '.repeat(40) + '| sh';
  const a = agent('A1', 'needs_ok', { ask: { id: 'k', type: 'permission', sentence: 'Checkout fix wants to run several commands', detail: cmd, options: ['Allow', 'Deny'], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A1', a);
  const v = lidView({ agent: a, index: 0, total: 1 }, { detail: 'calm' });
  assert.match(v.html, /See all of it/);
  assert.match(v.html, /⏎/);
  assert.match(v.html, /\| sh<\/code>/);
  const all = lidView({ agent: a, index: 0, total: 1 }, { detail: 'calm', open: { exact: true } });
  assert.match(all.html, /data-scroll="1"/);
  assert.match(all.html, /Show less/);
});

test('a question says who asks; calm keeps one sentence, a short meta line and at most two answers', { skip }, async () => {
  const { lidView, S } = await load();
  const a = agent('A1', 'question', { name: 'Search cleanup', ask: { id: 'q', type: 'question', sentence: 'Should the old search address keep working?', options: ['Keep it working', 'Remove it'], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A1', a);
  const calm = lidView({ agent: a, index: 1, total: 3 }, { detail: 'calm' });
  assert.match(calm.html, /Search cleanup asks · 2 of 3/);
  assert.equal(buttons(calm.html).filter(b => b.act === 'answer').length, 2);
  assert.doesNotMatch(calm.html, /Answer in your own words/);
  assert.doesNotMatch(calm.html, /Claude ·/);
  const more = lidView({ agent: a, index: 1, total: 3 }, { detail: 'more' });
  assert.match(more.html, /Answer in your own words/);
  assert.match(more.html, /Claude · Your laptop|Claude · laptop/);
});

test('the fit steps make room: the meta line goes, a long text is cut with "Read all of it"', { skip }, async () => {
  const { lidView, fitSteps, S } = await load();
  const q = 'Should I '.repeat(40) + 'go?';
  const a = agent('A1', 'question', { ask: { id: 'q', type: 'question', sentence: q, options: [], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A1', a);
  assert.match(lidView({ agent: a, index: 0, total: 1 }, { detail: 'more', fit: 0 }).html, /class="meta"/);
  const tight = lidView({ agent: a, index: 0, total: 1 }, { detail: 'more', fit: 4 });
  assert.doesNotMatch(tight.html, /class="meta"/);
  assert.match(tight.html, /Read all of it/);
  assert.equal(fitSteps(6).cmd, 72);
});

test('nothing waiting: "Nothing needs you", and a set-aside check is one click away', { skip }, async () => {
  const { lidView, S } = await load();
  S.agents.clear();
  const x = agent('X', 'checks_failed', { name: 'Invoice export' });
  S.agents.set('X', x);
  const v = lidView({ empty: true, aside: [x] }, { detail: 'calm' });
  assert.equal(v.idle, true);
  assert.match(v.html, /Nothing needs you\./);
  assert.match(v.html, /1 set aside/);
  assert.match(v.html, /Look at Invoice export now/);
  for (const link of ['no-key', 'stale', 'down']) {
    const l = lidView({ empty: true }, { link });
    assert.equal(l.key, 'link:' + link);
    assert.doesNotMatch(l.html, /data-act="answer"/);
  }
  assert.match(lidView({ empty: true }, { link: 'stale' }).html, /key no longer works/);
});

// ---------------------------------------------------------------- an agent's work: merge, review, throw away
const MIN = 60_000;
const WORK = (o = {}) => ({ branch: 'workbench/invoice-export-a1b2c3', from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
const FILES = n => ({ changed: n, adds: 4 * n, dels: n, list: [] });
const live = (S, repo = {}) => { S.meta = { mode: 'live', repo: { name: 'invoices-api', head: 'abc1234', branch: 'main', dirty: 2, identity: true, ...repo }, harnesses: {}, defaultBudgetUsd: 2, spendTodayUsd: 0 }; };
const demo = S => { S.meta = { mode: 'demo', repo: null, harnesses: {}, defaultBudgetUsd: 2, spendTodayUsd: 0 }; };
const finished = (o = {}) => agent('W1', 'done_checked', { name: 'Invoice export', endedAt: NOW - 2 * MIN, says: 'Invoices now go out in small batches.', work: WORK(), files: FILES(3), ...o });
const problem = (why, sentence, paths = []) => WORK({ problem: { why, sentence, paths, at: NOW - MIN } });
/** Every button, with its class, title, label and data-* attributes. */
const allButtons = html => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
  cls: (m[1].match(/class="([^"]*)"/) || [])[1] || '', title: (m[1].match(/title="([^"]*)"/) || [])[1] ?? null, label: m[2],
  ...Object.fromEntries([...m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]])),
}));
const labelled = (html, label) => allButtons(html).find(b => b.label === label);
const show = (lidView, S, a, o = {}, f = { agent: a, review: true, index: 0, total: 1 }) => { S.agents.clear(); S.agents.set(a.id, a); return lidView(f, o); };

test('finished work that can be merged: Merge into main and Ask for a change; Review the changes and Not now', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  for (const st of ['done_checked', 'done_claimed']) for (const detail of ['calm', 'more']) {
    const v = show(lidView, S, finished({ state: st }), { detail });
    const merge = labelled(v.html, 'Merge into main');
    assert.ok(merge, `${st} ${detail}: Merge into main`);
    assert.equal(merge.cls, 'big pri', 'Merge is the primary answer');
    assert.deepEqual([merge.act, merge.agent, merge.state, merge.into], ['merge', 'W1', st, 'main'], 'it carries what it was drawn for');
    assert.equal(merge.work, 'u', 'and the work it was drawn for');
    assert.equal(labelled(v.html, 'Ask for a change').cls, 'big');
    assert.equal(labelled(v.html, 'Looks good'), undefined, '"Looks good" is "Not now" here');
    const review = labelled(v.html, 'Review the changes'), notNow = labelled(v.html, 'Not now');
    assert.equal(review.cls, 'quiet');
    assert.deepEqual([review.act, review.agent, review.state, review.work], ['review', 'W1', st, 'u']);
    assert.equal(notNow.cls, 'quiet');
    assert.deepEqual([notNow.act, notNow.answer, notNow.agent, notNow.state], ['looksgood', 'Looks good', 'W1', st], '"Not now" does what "Looks good" did');
    assert.equal(allButtons(v.html).filter(b => b.cls.startsWith('big')).length, 2, 'at most two answers');
  }
});

test('"Review the changes" shows in calm too, and at every fit step', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  for (const detail of ['calm', 'more']) for (let fit = 0; fit <= 6; fit++) {
    const v = show(lidView, S, finished(), { detail, fit });
    assert.ok(labelled(v.html, 'Review the changes'), `${detail} fit ${fit}`);
    assert.ok(labelled(v.html, 'Merge into main'), `${detail} fit ${fit}: Merge stays`);
  }
});

test('a long branch is cut in the middle on the button, and the button\'s title holds all of it', { skip }, async () => {
  const { lidView, S } = await load();
  live(S, { branch: 'release/2026-11-payments-and-refunds' });
  const v = show(lidView, S, finished());
  const merge = allButtons(v.html).find(b => b.act === 'merge');
  assert.equal(merge.label, 'Merge into release/…refunds');
  assert.equal(merge.title, 'Merge into release/2026-11-payments-and-refunds');
  assert.equal(merge.into, 'release/2026-11-payments-and-refunds');
  live(S);
  assert.equal(allButtons(show(lidView, S, finished()).html).find(b => b.act === 'merge').title, null, 'no title when nothing is cut');
});

test('where merge does not apply, "Looks good" stays; when git is the reason, the lid says so in the engine\'s words', { skip }, async () => {
  const { lidView, S } = await load();
  // the demo, and agents without git: today's buttons
  demo(S);
  for (const a of [finished(), finished({ work: null })]) {
    const v = show(lidView, S, a);
    assert.equal(labelled(v.html, 'Looks good').cls, 'big pri');
    assert.equal(labelled(v.html, 'Ask for a change').cls, 'big');
    assert.ok(!allButtons(v.html).some(b => b.act === 'merge'), 'no Merge in the demo');
    assert.doesNotMatch(v.html, /class="meta git"/);
  }
  assert.ok(labelled(show(lidView, S, finished()).html, 'Review the changes'), 'the demo\'s agents can still be reviewed');
  assert.equal(labelled(show(lidView, S, finished({ work: null })).html, 'Review the changes'), undefined, 'not without git');
  // not on a branch
  live(S, { branch: null });
  let v = show(lidView, S, finished());
  assert.ok(labelled(v.html, 'Looks good'));
  assert.match(v.html, /<p class="meta git">Your folder is not on a branch, so there is nowhere to merge it\.<\/p>/);
  assert.ok(labelled(v.html, 'Review the changes'));
  // no name and email for git: the whole sentence, and its first sentence at the last fit step
  live(S, { identity: false });
  v = show(lidView, S, finished());
  assert.match(v.html, /<p class="meta git">Git does not know your name and email yet, so Workbench cannot make the merge commit\. Set user\.name and user\.email with git config, then try again\.<\/p>/);
  assert.match(show(lidView, S, finished(), { fit: 6 }).html, /<p class="meta git">Git does not know your name and email yet, so Workbench cannot make the merge commit\.<\/p>/);
  // nothing to merge: no git words, no review; "What changed?" in more, as before
  live(S);
  v = show(lidView, S, finished({ files: FILES(0) }), { detail: 'more' });
  assert.ok(labelled(v.html, 'Looks good'));
  assert.equal(labelled(v.html, 'Review the changes'), undefined);
  assert.ok(labelled(v.html, 'What changed?'));
  assert.doesNotMatch(v.html, /class="meta git"/);
});

test('a failed check: today\'s answers, plus quiet "Review the changes" and "Merge anyway"', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  const a = finished({ state: 'checks_failed', checks: { state: 'failed', results: [{ name: 'unit tests', ok: false }] } });
  for (const detail of ['calm', 'more']) {
    const v = show(lidView, S, a, { detail }, { agent: a, index: 0, total: 1 });
    assert.equal(labelled(v.html, 'Ask it to fix that').cls, 'big pri');
    assert.equal(labelled(v.html, 'Look later').cls, 'big');
    assert.equal(labelled(v.html, 'Review the changes').cls, 'quiet');
    const anyway = labelled(v.html, 'Merge anyway');
    assert.equal(anyway.cls, 'quiet');
    assert.deepEqual([anyway.act, anyway.agent, anyway.state, anyway.into], ['merge', 'W1', 'checks_failed', 'main'], 'the same request as Merge');
  }
});

test('failed and stopped agents with a folder: today\'s answers, plus quiet "Review the changes"', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  for (const [st, first, second] of [['failed', 'Try again', 'Dismiss'], ['stopped', 'Continue', 'Dismiss']]) {
    const v = show(lidView, S, finished({ state: st, files: null, error: 'The tests ran out of memory.' }), {}, { agent: finished({ state: st, files: null }), picked: true, queued: 0 });
    assert.equal(labelled(v.html, first).cls, 'big pri', st);
    assert.equal(labelled(v.html, second).cls, 'big', st);
    assert.equal(labelled(v.html, 'Review the changes').cls, 'quiet', st);
    assert.ok(!allButtons(v.html).some(b => b.act === 'merge' || b.act === 'discard'), `${st}: merge and throw-away are in the git screen`);
  }
});

test('merged, with nothing new: "<Name>’s work is in main.", See it in git and Ask for a change', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  const a = finished({ work: WORK({ merged: { into: 'main', merge: 'e4f1c3a9b8d7e4f1c3a9b8d7e4f1c3a9b8d7e4f1', at: NOW - 2 * MIN, files: 3, adds: 12, dels: 3 } }), files: FILES(0) });
  for (const detail of ['calm', 'more']) {
    const v = show(lidView, S, a, { detail }, { agent: a, picked: true, queued: 0 });
    assert.match(v.html, /<h1[^>]*>Invoice export’s work is in main\.<\/h1>/);
    assert.match(v.html, /Merged 2 min ago<\/span> · 3 files/);
    assert.equal(v.count, 'merged');
    const see = labelled(v.html, 'See it in git');
    assert.equal(see.cls, 'big pri');
    assert.deepEqual([see.act, see.agent], ['review', 'W1'], 'it opens the git screen and posts nothing');
    assert.equal(labelled(v.html, 'Ask for a change').cls, 'big');
    assert.ok(!allButtons(v.html).some(b => b.act === 'merge'));
  }
});

test('a merge that conflicts: the engine\'s sentence, what both changed, and "Ask it to bring in main" with its exact message', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  const a = finished({ work: problem('conflict', 'Invoice export’s work does not merge cleanly into main.', ['src/a.js', 'src/b.js']) });
  for (const detail of ['calm', 'more']) {
    const v = show(lidView, S, a, { detail });
    assert.match(v.html, /<h1[^>]*>Invoice export’s work does not merge cleanly into main\.<\/h1>/);
    assert.match(v.html, /<p class="meta">Both changed: src\/a\.js, src\/b\.js<\/p>/);
    const ask = labelled(v.html, 'Ask it to bring in main');
    assert.equal(ask.cls, 'big pri');
    assert.equal(ask.act, 'fix');
    assert.equal(ask.text, 'Your work conflicts with the latest main in: src/a.js, src/b.js. Please merge main into your branch, resolve the conflicts, and finish.');
    const later = labelled(v.html, 'Look later');
    assert.deepEqual([later.cls, later.act], ['big', 'later']);
    assert.ok(labelled(v.html, 'Review the changes'));
  }
  // many paths: three, then two at the last step, with the rest counted; hidden characters are shown
  const many = finished({ work: problem('conflict', 'x', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']) });
  assert.match(show(lidView, S, many).html, /Both changed: a\.js, b\.js, c\.js and 2 more/);
  assert.match(show(lidView, S, many, { fit: 6 }).html, /Both changed: a\.js, b\.js and 3 more/);
  const odd = finished({ work: problem('conflict', 'x', [`src/${String.fromCharCode(0x202e)}sj.txt`]) });
  assert.match(show(lidView, S, odd).html, /Both changed: src\/⟦U\+202E⟧sj\.txt/);
});

test('your own changes in the way: Try again proposes the merge again, and Not now sets it aside', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  const a = finished({ work: problem('blocked', 'Your own changes are in the way: src/cart/total.ts. Commit or put them aside, then merge again.', ['src/cart/total.ts']) });
  const v = show(lidView, S, a);
  assert.match(v.html, /<h1[^>]*>Your own changes are in the way\.<\/h1>/);
  assert.match(v.html, /In the way: src\/cart\/total\.ts/);
  const again = labelled(v.html, 'Try again'), notNow = labelled(v.html, 'Not now');
  assert.deepEqual([again.cls, again.act, again.agent, again.state, again.into], ['big pri', 'merge', 'W1', 'done_checked', 'main']);
  assert.deepEqual([notNow.cls, notNow.act], ['big', 'later']);
  // any other refusal: the engine's words, its first sentence as the headline and the rest under it, with the same two
  // answers; a screen reader hears all of it
  const moved = show(lidView, S, finished({ work: problem('moved', 'main changed since you looked. Have another look.') }));
  assert.match(moved.html, /<h1[^>]*>main changed since you looked\.<\/h1><p class="meta">Have another look\.<\/p>/);
  assert.equal(moved.say, 'Ready for you to look at. main changed since you looked. Have another look.');
  assert.equal(labelled(moved.html, 'Try again').act, 'merge');
  assert.equal(labelled(moved.html, 'Not now').act, 'later');
  const id = show(lidView, S, finished({ work: problem('identity', 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.') }));
  assert.match(id.html, /<h1[^>]*>Git does not know your name and email yet, so Workbench cannot make the merge commit\.<\/h1><p class="meta">Set user\.name and user\.email with git config, then try again\.<\/p>/);
  const one = show(lidView, S, finished({ work: problem('ancestry', 'Invoice export started from a commit that is no longer in main, so merging it would bring in other work.') }));
  assert.match(one.html, /<h1[^>]*>Invoice export started from a commit that is no longer in main, so merging it would bring in other work\.<\/h1>/);
});

test('thrown away: "<Name>’s work was thrown away." and Dismiss', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  const a = finished({ state: 'stopped', work: WORK({ branch: null, folder: false, thrownAway: { at: NOW - 3 * MIN, saved: 'refs/workbench/discarded/W1' } }) });
  const v = show(lidView, S, a, {}, { agent: a, picked: true, queued: 0 });
  assert.match(v.html, /<h1[^>]*>Invoice export’s work was thrown away\.<\/h1>/);
  assert.match(v.html, /Workbench keeps a hidden copy in git\./);
  const dismiss = labelled(v.html, 'Dismiss');
  assert.deepEqual([dismiss.cls, dismiss.act, dismiss.agent], ['big pri', 'reviewed', 'W1']);
  assert.ok(!allButtons(v.html).some(b => ['merge', 'review', 'discard'].includes(b.act)));
});

test('the lid\'s key carries where the work went, so an outcome swaps the page; buttons carry the same signature', { skip }, async () => {
  const { lidView, focusKey, S } = await load();
  live(S);
  const merged = { into: 'main', merge: 'aaaa', at: NOW - MIN, files: 3, adds: 12, dels: 3 };
  const views = [
    finished(), finished({ work: WORK({ merged }), files: FILES(0) }), finished({ work: problem('conflict', 'x', []) }),
    finished({ work: problem('blocked', 'x', []) }), finished({ work: WORK({ branch: null, folder: false, thrownAway: { at: NOW, saved: 'x' } }) }),
  ];
  const keys = views.map(a => { const f = { agent: a, picked: true, queued: 0 }; const v = show(lidView, S, a, {}, f); assert.equal(v.key, focusKey(f)); return v.key; });
  assert.equal(new Set(keys).size, keys.length, keys.join(' | '));
  assert.equal(focusKey({ agent: agent('X', 'working') }), 'X|working|', 'without work, the key is as before');
  assert.equal(focusKey({ confirm: { id: 'c1' } }), 'confirm:c1');
  assert.equal(focusKey({ empty: true }), 'empty');
});

test('every button about an agent\'s work is bound to the agent, its state and its work', { skip }, async () => {
  const { lidView, S } = await load();
  live(S);
  for (const st of STATES_ALL) {
    const ask = ['needs_ok', 'question', 'maybe_stuck'].includes(st) ? { id: 'ask-' + st, type: st === 'needs_ok' ? 'permission' : st === 'question' ? 'question' : 'stuck', sentence: 'Invoice export wants to run a command', options: st === 'question' ? [] : undefined, createdAt: NOW } : null;
    for (const w of [WORK(), problem('conflict', 'x', ['a.js']), problem('blocked', 'x', ['a.js']), WORK({ merged: { into: 'main', merge: 'aaaa', at: NOW, files: 1, adds: 1, dels: 0 } })]) {
      const a = finished({ state: st, ask, parentId: st === 'finished' ? 'P' : null, work: st === 'finished' ? null : w, checks: { state: 'failed', results: [{ name: 'tests', ok: false }] } });
      S.agents.clear(); S.agents.set('W1', a); S.agents.set('P', agent('P', 'working', { name: 'Parent' }));
      for (const detail of ['calm', 'more']) {
        const v = lidView({ agent: a, index: 0, total: 2 }, { detail });
        for (const b of allButtons(v.html)) {
          if (['next', 'exact', 'changed', 'readall', 'unpick'].includes(b.act)) continue;
          assert.equal(b.agent, 'W1', `${st} ${detail}: ${b.act} carries data-agent`);
          if (['merge', 'review', 'later', 'reviewed'].includes(b.act) && a.work && (b.work != null || b.act === 'merge' || b.act === 'review')) {
            assert.equal(b.state, st, `${st} ${detail}: ${b.act} carries data-state`);
            assert.ok(b.work != null, `${st} ${detail}: ${b.act} carries data-work`);
          }
          if (b.act === 'merge') assert.equal(b.into, 'main', `${st} ${detail}: merge carries the branch it was offered into`);
        }
      }
    }
  }
});

test('engine cards: their own yes and no, a count line that says what they are about', { skip }, async () => {
  const { lidView } = await load();
  const card = o => ({ id: 'c1', sentence: 'Merge Invoice export into main?', detail: '3 files, +12 −3. Its work becomes a commit on its branch, joined into main by a merge commit. Nothing checked its work.', kind: 'merge', yes: 'Merge', no: 'Cancel', danger: false, ...o });
  const m = lidView({ confirm: card() }, {});
  assert.equal(m.count, 'Before it merges');
  assert.deepEqual(allButtons(m.html).map(b => [b.label, b.cls, b.act, b.confirm, b.go]), [['Merge', 'big pri', 'confirm', 'c1', '1'], ['Cancel', 'big', 'confirm', 'c1', '0']]);
  assert.match(m.say, /^Before it merges: Merge Invoice export into main\? 3 files, \+12 −3\./);
  const d = lidView({ confirm: card({ kind: 'discard', sentence: 'Throw away Invoice export’s work?', detail: 'Its folder and its branch workbench/invoice-export-a1b2c3 are deleted, with 3 changed files. Workbench keeps a hidden copy in git.', yes: 'Throw it away', no: 'Keep it', danger: true }) }, {});
  assert.equal(d.count, 'Before it is thrown away');
  assert.deepEqual(allButtons(d.html).map(b => [b.label, b.cls]), [['Throw it away', 'big'], ['Keep it', 'big']], 'a dangerous card has no primary answer');
  const f = lidView({ confirm: { id: 'c2', kind: 'forget', sentence: 'Forget Invoice export?', detail: 'It will not show here again. Its folder and branch stay on this computer.' } }, {});
  assert.equal(f.count, 'Before it is forgotten');
  assert.deepEqual(allButtons(f.html).map(b => [b.label, b.cls]), [['Do it', 'big pri'], ['Cancel', 'big']], 'without their own words: Do it and Cancel');
  for (const kind of ['start', 'stop', 'say', undefined]) assert.equal(lidView({ confirm: { id: 'c3', kind, sentence: 'Start a simulated Claude on “fix it”?', detail: 'It runs on your laptop.' } }, {}).count, 'You said', String(kind));
});

test('a card about an agent\'s work keeps its detail up to fit step 5; at the last step it goes under "See all of it"', { skip }, async () => {
  const { lidView } = await load();
  const detail = 'Its folder and its branch workbench/invoice-export-a1b2c3 are deleted, with 3 changed files. Workbench keeps a hidden copy in git.';
  for (const c of [{ kind: 'discard', danger: true, yes: 'Throw it away', no: 'Keep it' }, { kind: 'merge', danger: false, yes: 'Merge', no: 'Cancel' }]) {
    const card = { id: 'c1', sentence: 'Throw away Invoice export’s work?', detail, ...c };
    for (let fit = 0; fit <= 5; fit++) assert.ok(lidView({ confirm: card }, { fit }).html.includes(`<p class="meta">${detail}</p>`), `${c.kind} fit ${fit}`);
    const last = lidView({ confirm: card }, { fit: 6 });
    assert.ok(!last.html.includes(detail), `${c.kind}: cut at the last step`);
    assert.equal(labelled(last.html, 'See all of it').act, 'exact');
    const open = lidView({ confirm: card }, { fit: 6, open: { exact: true } });
    assert.ok(open.html.includes(`<div class="readall" data-scroll="1" tabindex="0" aria-label="All of it"><p class="meta">${detail}</p></div>`));
    assert.ok(labelled(open.html, 'Show less'));
  }
  // a launch card is as before: its detail goes from fit step 3
  const launch = { id: 'c2', kind: 'start', sentence: 'Start a simulated Claude on “fix it”?', detail: 'It runs on your laptop.' };
  assert.match(lidView({ confirm: launch }, { fit: 2 }).html, /It runs on your laptop\./);
  assert.doesNotMatch(lidView({ confirm: launch }, { fit: 3 }).html, /It runs on your laptop\./);
});

test('a card\'s words show characters that could hide or turn text', { skip }, async () => {
  const { lidView } = await load();
  const rlo = String.fromCharCode(0x202e), zw = String.fromCharCode(0x200b);
  const v = lidView({ confirm: { id: 'c1', kind: 'merge', sentence: `Merge Invoice export into ma${rlo}in?`, detail: `Its work becomes a commit on its branch, joined into ma${rlo}in by a merge commit.${zw}`, yes: 'Merge', no: 'Cancel', danger: false } }, {});
  assert.match(v.html, /Merge Invoice export into ma⟦U\+202E⟧in\?/);
  assert.match(v.html, /joined into ma⟦U\+202E⟧in by a merge commit\.⟦U\+200B⟧/);
  assert.ok(!v.html.includes(rlo) && !v.html.includes(zw) && !v.say.includes(rlo));
});
