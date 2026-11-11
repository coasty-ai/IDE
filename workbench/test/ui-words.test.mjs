import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleControls, clipMiddle, whoAsks, headlineClass } from '../ui/words.js';

test('control characters in a command are shown, never hidden', () => {
  assert.equal(visibleControls('a\nb\tc\rd\x1be\x7f'), 'a⏎b⇥c␍d␛e␡');
  assert.equal(visibleControls('plain'), 'plain');
  assert.equal(visibleControls(null), '');
});

test('a long command is cut in the middle, so the end (where "| sh" would be) stays visible', () => {
  const cmd = 'npm test && ' + 'x'.repeat(300) + ' | sh';
  const c = clipMiddle(cmd, 160);
  assert.equal(c.clipped, true);
  assert.ok(c.text.length <= 163);
  assert.ok(c.text.startsWith('npm test && '));
  assert.ok(c.text.endsWith('| sh'));
  assert.match(c.text, / … /);
  assert.deepEqual(clipMiddle('npm run db:migrate -- --env test', 160), { text: 'npm run db:migrate -- --env test', clipped: false });
});

test('who asks, in at most 28 characters: the counter goes first, then the name is shortened', () => {
  assert.equal(whoAsks('Search cleanup', 0, 3), 'Search cleanup asks · 1 of 3');
  assert.equal(whoAsks('Search cleanup', 0, 1), 'Search cleanup asks');
  assert.equal(whoAsks('Investigate payment timeouts', 1, 4), 'Investigate payment… asks');
  for (const [n, i, t] of [['A very long agent name that goes on', 0, 9], ['Checkout fix', 8, 12], ['x', 0, 2]]) assert.ok(whoAsks(n, i, t).length <= 28, n);
});

test('the headline steps down a size as it gets longer, and further to fit', () => {
  assert.equal(headlineClass('short'), '');
  assert.equal(headlineClass('x'.repeat(60)), 'len-m');
  assert.equal(headlineClass('x'.repeat(120)), 'len-l');
  assert.equal(headlineClass('x'.repeat(200)), 'len-xl');
  assert.equal(headlineClass('short', 2), 'len-l');
  assert.equal(headlineClass('x'.repeat(200), 3), 'len-xl');
});
