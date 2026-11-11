// The fixes from the second review of the board (pure parts only): answer rows that stack instead of wrapping, names cut
// at word boundaries, dense chips that use their lane, spend and cost words with Workbench's estimate, counters that
// change at most once a minute, work left running in the background, and the fit ladder keeping a permission whole.
// focus.js imports /shared/... by URL, so that path is mapped to src/shared/ with module.registerHooks (Node 22.15+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buttonRow, whoAsks } from '../ui/words.js';
import { clipTo, layoutBoard, sizeClass, boardProblems, monoMeasure } from '../ui/layout.js';
import { spentWords, spentAmountWords, spendTodayOf, calmDuration } from '../ui/numbers.js';
import { markOfAgent, statusWords } from '../ui/look.js';

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
const mono = (t, px) => String(t).length * 0.6 * px;
const money = usd => (usd == null ? 'not reported' : usd === 0 ? '$0' : '$' + usd.toFixed(2));
const LOOK = { maybe_stuck: { label: 'might be stuck', shape: 'stuck', tone: 'stuck' }, working: { label: 'working', shape: 'work', tone: 'work' }, waiting_helpers: { label: 'waiting on background work', shape: 'work', tone: 'work' } };

test('two answers sit side by side, then tighter, then one above the other; a label never wraps to squeeze a row', () => {
  const o = { rowW: 292, px: 13, minW: 104, measure: mono };
  assert.equal(buttonRow(['Allow', 'Deny'], o), '');
  assert.equal(buttonRow(['Looks good', 'Ask for a change'], o), '');
  assert.equal(buttonRow(['Ask it to fix that', 'Look later'], o), 'tight');
  assert.equal(buttonRow(['Keep the old address working', 'Remove it and add a notice'], o), 'stack');
  assert.equal(buttonRow(['Reuse the idempotency key across retries', 'Add a database lock around the charge'], o), 'stack');
  assert.equal(buttonRow(['Answer'], o), '');
});

test('who asks: a name is cut at a word boundary, and longer when the lid has room', () => {
  assert.equal(whoAsks('Investigate intermittent payment provider timeouts', 0, 1), 'Investigate… asks');
  assert.equal(whoAsks('Investigate intermittent payment provider timeouts', 0, 1, 40), 'Investigate intermittent payment… asks');
  assert.equal(whoAsks('Search cleanup', 1, 3, 40), 'Search cleanup asks · 2 of 3');
  for (const max of [20, 28, 36, 44]) assert.ok(whoAsks('Investigate intermittent payment provider timeouts', 2, 5, max).length <= max, String(max));
});

test('a cut that ends where a word ends keeps that word', () => {
  assert.equal(clipTo('Feature flags redesign work', 23), 'Feature flags redesign…');
  assert.equal(clipTo('Feature flags redesign work', 19), 'Feature flags…');
  assert.equal(clipTo('Check welcome email copy', 14), 'Check welcome…');
  assert.equal(clipTo('Feature flags redesign work', 40), 'Feature flags redesign work');
});

test('past twelve agents, a chip uses the room on its lane: names are whole where the lane has room, cut to its full width where not', () => {
  for (const [W, H] of [[1280, 680], [1440, 789], [1920, 970]]) {
    const P = sizeClass(W, H);
    const roots = Array.from({ length: 24 }, (_, i) => ({ id: 'r' + i, name: i % 4 === 0 ? 'Feature flags redesign work' : 'Cache fix', stop: i % 3 ? 'mid' : 'inner', lit: i % 3 ? null : 'need', qno: i % 3 ? null : 1 + i / 3, current: i === 0, kids: [] }));
    const lane = new Map(roots.map((r, i) => [r.id, { side: i % 2 ? 'R' : 'L', row: Math.floor(i / 2) }]));
    const G = layoutBoard({ W, H, P, roots, laneOf: id => lane.get(id), nRows: 12, dense: true, lidNeed: 200, measure: monoMeasure });
    for (const n of G.nodes) {
      const text = n.shape.lines.join(' ');
      if (n.shape.clipped) {
        assert.ok(text.endsWith('…'), text);
        assert.ok(text.length >= 'Feature flags redesign'.length, `${W}: "${text}" uses the chip's full width`);
      }
    }
    if (W >= 1440) assert.ok(G.nodes.filter(n => n.r.name === 'Feature flags redesign work').every(n => !n.shape.clipped), `${W}: whole names`);
    assert.deepEqual(boardProblems(G), [], `${W}x${H}`);
  }
});

test('spend and cost words: Workbench\'s estimate says "about", nothing known says "not reported yet", never $0', () => {
  assert.equal(spentWords({ costUsd: 0.42, unreportedUsd: 0 }, money), '$0.42');
  assert.equal(spentWords({ costUsd: null, unreportedUsd: 0.05 }, money), 'about $0.05');
  assert.equal(spentWords({ costUsd: 0.2, unreportedUsd: 0.05 }, money), 'about $0.25');
  assert.equal(spentWords({ costUsd: null }, money), 'not reported yet');
  assert.equal(spentWords(null, money), 'not reported yet');
  // the engine's two more cases: Codex never reports cost (no "yet"), and below a cent is "under $0.01", estimated or not
  assert.equal(spentWords({ costUsd: null }, money, 'codex'), 'not reported');
  assert.equal(spentWords({ costUsd: null }, money, 'claude'), 'not reported yet');
  assert.equal(spentWords({ costUsd: 0.004 }, money), 'under $0.01');
  assert.equal(spentWords({ costUsd: null, unreportedUsd: 0.003 }, money), 'under $0.01');
  assert.equal(spentAmountWords(3.05, true, money), 'about $3.05');
  assert.equal(spentAmountWords(0, false, money), '$0');
  const midnight = 1000;
  const sp = spendTodayOf([
    { id: 'a', parentId: null, startedAt: 2000, usage: { costUsd: 0.5 } },
    { id: 'b', parentId: null, startedAt: 2000, usage: { costUsd: null, unreportedUsd: 0.25 } },
    { id: 'h', parentId: 'a', startedAt: 2000, usage: { costUsd: 9 } },
    { id: 'y', parentId: null, startedAt: 10, usage: { costUsd: 9 } },
  ], midnight);
  assert.deepEqual(sp, { usd: 0.75, estimated: true });
  assert.deepEqual(spendTodayOf([{ id: 'a', parentId: null, startedAt: 2000, usage: { costUsd: 0.5, unreportedUsd: 0 } }], midnight), { usd: 0.5, estimated: false });
});

test('counters change at most once a minute: under a minute they say so in words', () => {
  const duration = ms => (ms < 60000 ? Math.round(ms / 1000) + ' s' : Math.floor(ms / 60000) + ' min');
  assert.equal(calmDuration(13000, duration), 'just now');
  assert.equal(calmDuration(59000, duration, 'under 1 min'), 'under 1 min');
  assert.equal(calmDuration(61000, duration), '1 min');
  assert.equal(calmDuration(NaN, duration), 'just now');
});

test('work left running in the background is not "might be stuck"', () => {
  const bg = { state: 'maybe_stuck', ask: { id: 'k', type: 'stuck', about: 'background' } };
  assert.deepEqual(markOfAgent(bg, LOOK), { label: 'left a command running', shape: 'wait', tone: 'need' });
  assert.equal(markOfAgent({ state: 'maybe_stuck', ask: { type: 'stuck' } }, LOOK).label, 'might be stuck');
  assert.equal(statusWords(bg, LOOK), 'left a command running');
  assert.equal(statusWords({ state: 'waiting_helpers', now: 'Waiting for a background command' }, LOOK), 'waiting');
});

// ---------------------------------------------------------------- the lid (focus.js)
const load = async () => ({ ...(await import('../ui/focus.js')), ...(await import('../ui/model.js')) });
const NOW = Date.now();
const agent = (id, state, o = {}) => ({ id, parentId: null, rootId: id, name: 'Checkout fix', harness: 'claude', machineId: 'laptop', state, stateSince: NOW - 600000,
  startedAt: NOW - 900000, endedAt: null, now: 'Reading checkout.ts', ask: null, usage: { costUsd: 0.4 }, budgetUsd: 2, helpers: { total: 0, working: 0, done: 0 }, ...o });

test('the fit ladder keeps a permission whole until its very last step: about 160 characters and the whole reason', { skip }, async () => {
  const { lidView, fitSteps, S } = await load();
  for (const fit of [0, 3, 4, 5]) { assert.equal(fitSteps(fit).cmd, 160); assert.equal(fitSteps(fit).why, Infinity); }
  const why = 'Part of the command downloads a script from the internet and runs it, and part of it is not on the list of safe commands.';
  const a = agent('A', 'needs_ok', { ask: { id: 'k', type: 'permission', sentence: 'Seed test data wants to run several commands in one go', detail: 'npm run seed '.repeat(30), why, options: ['Allow', 'Deny'], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A', a);
  const v = lidView({ agent: a, index: 0, total: 1 }, { detail: 'calm', fit: 5 });
  assert.ok(v.html.includes(why), 'the reason is whole at step 5');
  assert.match(v.html, /class="exact close"/);
});

test('answers are laid out by the page\'s row rule: long options stack, the first stays primary', { skip }, async () => {
  const { lidView, S } = await load();
  const a = agent('A', 'question', { name: 'Search cleanup', ask: { id: 'q', type: 'question', sentence: 'Keep the old address?', options: ['Keep the old address working', 'Remove it and add a notice'], createdAt: NOW } });
  S.agents.clear(); S.agents.set('A', a);
  const row = labels => buttonRow(labels, { rowW: 292, px: 13, minW: 104, measure: mono });
  const v = lidView({ agent: a, index: 0, total: 1 }, { detail: 'calm', row });
  assert.match(v.html, /class="acts stack"/);
  assert.match(v.html, /class="big pri"[^>]*>Keep the old address working</);
  const asked = lidView({ agent: a, index: 0, total: 1 }, { detail: 'calm', row, fit: 0 });
  assert.match(asked.html, /asked just now/, 'a fresh ask says so, instead of counting seconds');
});

test('the core\'s words for work left running, for a root waiting on a command, and a question with changes', { skip }, async () => {
  const { lidView, S } = await load();
  const bg = agent('B', 'maybe_stuck', { name: 'Dev server', ask: { id: 'bg', type: 'stuck', about: 'background', sentence: 'Dev server has finished, but a command it started is still running.', detail: 'Runs the development server', options: ['It is done', 'Keep waiting'], createdAt: NOW } });
  const w = agent('W', 'waiting_helpers', { name: 'Release notes', now: 'Waiting for a background command' });
  const q = agent('Q', 'question', { name: 'Search cleanup', files: { changed: 2, adds: 3, dels: 4, list: [] }, ask: { id: 'q', type: 'question', sentence: 'Keep it?', options: ['Yes', 'No'], createdAt: NOW - 120000 } });
  S.agents.clear(); for (const x of [bg, w, q]) S.agents.set(x.id, x);
  const vb = lidView({ agent: bg, index: 0, total: 1 }, { detail: 'calm' });
  assert.match(vb.html, /Dev server has finished, but a command it started is still running\./);
  assert.doesNotMatch(vb.html, /might be stuck/);
  assert.match(vb.html, /data-answer="It is done"[^>]*data-ask="bg"|data-ask="bg"[^>]*data-answer="It is done"/);
  assert.match(lidView({ agent: w }, { detail: 'calm' }).html, /Release notes is waiting for a background command\./);
  assert.match(lidView({ agent: q, index: 0, total: 1 }, { detail: 'more' }).html, /What changed\?/);
  assert.doesNotMatch(lidView({ agent: q, index: 0, total: 1 }, { detail: 'calm' }).html, /What changed\?/);
  assert.match(lidView({ agent: q, index: 0, total: 1 }, { detail: 'calm' }).html, /waiting 2 min/);
});
