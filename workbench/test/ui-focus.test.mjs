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
