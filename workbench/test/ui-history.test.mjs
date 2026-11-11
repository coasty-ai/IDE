// Agents from an earlier run (restored from history), in the page's pure modules: the queues, the board model, the tray's
// words, the lid and the card. The page imports /shared/... by URL, so this maps that path to src/shared/ with
// module.registerHooks (Node 22.15 and later); on older Node the lid and card tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { needsPerson, needsQueue, reviewQueue } from '../ui/queue.js';
import { boardModel, splitEarlier, agoText, trayWords } from '../ui/boardmodel.js';
import { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY } from '../src/shared/states.mjs';

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

const NOW = Date.now();
const MIN = 60_000;
const agent = (id, state, o = {}) => ({ id, parentId: null, rootId: id, name: 'Invoice export', harness: 'claude', machineId: 'laptop', state, stateSince: NOW - 5 * MIN,
  startedAt: NOW - 70 * MIN, endedAt: null, now: 'Reading checkout.ts', ask: null, usage: { costUsd: 0.4 }, budgetUsd: 2, helpers: { total: 0, working: 0, done: 0 }, earlier: false, canContinue: null, continueReason: null, ...o });
const earlier = (id, state, o = {}) => agent(id, state, { earlier: true, canContinue: true, endedAt: NOW - 2 * 24 * 60 * MIN, says: 'Invoices now go out in small batches.', ...o });
const buttons = html => [...html.matchAll(/<button\b([^>]*)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]]))).filter(b => b.act);

test('an agent from an earlier run never needs the person and is never "ready to look at"', () => {
  const list = [earlier('e1', 'checks_failed'), earlier('e2', 'done_claimed'), earlier('e3', 'failed'), agent('n1', 'done_claimed', { endedAt: NOW - MIN }), agent('n2', 'checks_failed')];
  assert.equal(needsPerson(list[0], { NEEDS_YOU }), false);
  assert.deepEqual(needsQueue(list, { NEEDS_YOU, PRIORITY }).map(a => a.id), ['n2']);
  assert.deepEqual(reviewQueue(list, { reviewed: new Set() }).map(a => a.id), ['n1']);
});

test('the board model marks earlier roots; they go to the tray, not to a lane', () => {
  const list = [earlier('e1', 'done_checked'), earlier('e2', 'stopped', { canContinue: false }), agent('n1', 'working'), agent('n2', 'needs_ok', { ask: { id: 'k', type: 'permission', createdAt: NOW } })];
  const bm = boardModel(list, { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY });
  assert.deepEqual(bm.roots.map(r => [r.id, r.earlier, r.ghost]), [['e1', true, true], ['e2', true, true], ['n1', false, false], ['n2', false, false]]);
  const { current, earlier: old } = splitEarlier(bm.roots);
  assert.deepEqual(current.map(r => r.id), ['n1', 'n2']);
  assert.deepEqual(old.map(r => r.id), ['e1', 'e2']);
  assert.equal(bm.queue.length, 1, 'only the live ask is in the queue');
});

test('the tray says what is in it, plainly', () => {
  assert.deepEqual(trayWords({ done: 3 }), { lead: '3 done', rest: ' or stopped', text: '3 done or stopped', aria: '3 done or stopped. Show them.' });
  assert.equal(trayWords({ earlier: 5 }).text, '5 from earlier');
  assert.equal(trayWords({ done: 2, earlier: 5, over: 1 }).text, '2 done or stopped, 5 from earlier, 1 more working');
  assert.equal(trayWords({ done: 2, earlier: 5 }).aria, '2 done or stopped, 5 from an earlier run. Show them.');
  assert.equal(trayWords({ done: 4, over: 2 }).text, '4 done or stopped, 2 more working', 'as before, without earlier agents');
});

test('"time ago" is coarse, and never a percentage or a finish time', () => {
  assert.equal(agoText(10_000), 'just now');
  assert.equal(agoText(12 * MIN), '12 min ago');
  assert.equal(agoText(60 * MIN), '1 hour ago');
  assert.equal(agoText(3 * 60 * MIN), '3 hours ago');
  assert.equal(agoText(2 * 24 * 60 * MIN), '2 days ago');
  assert.equal(agoText(-5), 'a while ago');
  assert.equal(agoText(NaN), 'a while ago');
});

const load = async () => ({ ...(await import('../ui/focus.js')), ...(await import('../ui/model.js')), ...(await import('../ui/card.js')) });

test('the lid for an earlier agent: "From an earlier run", Continue and Forget, bound to the agent and its state', { skip }, async () => {
  const { lidView, S } = await load();
  S.meta.defaultBudgetUsd = 2;
  for (const detail of ['calm', 'more']) {
    const a = earlier('E1', 'done_checked');
    S.agents.clear(); S.agents.set('E1', a);
    const v = lidView({ agent: a, picked: true, queued: 0 }, { detail });
    assert.match(v.html, /From an earlier run/);
    assert.match(v.html, /Invoice export was done and checked\./);
    assert.match(v.html, /2 days ago/);
    assert.match(v.html, /new spending limit of \$2\.00 for this run/);
    const b = buttons(v.html).filter(x => !['unpick'].includes(x.act));
    assert.deepEqual(b.map(x => x.act), ['fix', 'forget']);
    for (const x of b) { assert.equal(x.agent, 'E1'); assert.equal(x.state, 'done_checked'); }
    assert.equal(b[0].text, 'Please continue where you left off.');
    assert.ok(!/needs you|to look at/.test(v.count));
  }
});

test('an earlier agent that cannot continue says why and offers only Forget', { skip }, async () => {
  const { lidView, S } = await load();
  const a = earlier('E2', 'stopped', { canContinue: false, continueReason: 'Its folder is gone, so it cannot continue.' });
  S.agents.clear(); S.agents.set('E2', a);
  const v = lidView({ agent: a, picked: true, queued: 0 }, { detail: 'calm' });
  assert.match(v.html, /Invoice export was stopped\./);
  assert.match(v.html, /Its folder is gone, so it cannot continue\./);
  assert.deepEqual(buttons(v.html).filter(x => x.act !== 'unpick').map(x => x.act), ['forget']);
  assert.ok(!/Continue/.test(v.html));
});

test('a continued agent is an ordinary one again', { skip }, async () => {
  const { lidView, S } = await load();
  const a = agent('E3', 'working', { earlier: false });
  S.agents.clear(); S.agents.set('E3', a);
  const v = lidView({ agent: a, picked: true, queued: 0 }, { detail: 'calm' });
  assert.ok(!/earlier run/.test(v.html));
});

test('the card says "From an earlier run · time ago"', { skip }, async () => {
  const { cardHtml, S } = await load();
  const a = earlier('E1', 'done_claimed');
  S.agents.clear(); S.agents.set('E1', a);
  for (const detail of ['calm', 'more']) {
    const html = cardHtml(a, { detail, now: NOW, one: false });
    assert.match(html, /From an earlier run<\/span> <em>· 2 days ago<\/em>/);
    assert.match(html, /From an earlier run, 2 days ago\./, 'and for a screen reader');
    assert.ok(!/<em>Now<\/em>/.test(html));
  }
});
