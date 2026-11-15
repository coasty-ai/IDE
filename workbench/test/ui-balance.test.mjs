// Even heading lines where the engine cannot balance them (ui/balance.js): the width search, and when it stays out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balancedWidth, balancesItself } from '../ui/balance.js';

/** Greedy line breaking of `words` (widths in px, one space of `gap`), as a browser does: lines at `width`. */
const wrapper = (words, gap = 10) => (width) => {
  let lines = 1;
  let used = 0;
  for (const w of words) {
    if (w > width) return Infinity; // a word that cannot fit sticks out: no good
    const need = used === 0 ? w : used + gap + w;
    if (need <= width) used = need;
    else { lines += 1; used = w; }
  }
  return lines;
};

test('a heading that wraps gets the narrowest width that keeps its lines, so the last word is not left alone', () => {
  // "Merge Search cleanup into main?" at 400px: four words on the first line, "main?" alone on the second.
  const words = [80, 90, 100, 60, 70];
  const at = wrapper(words);
  assert.equal(at(400), 2);
  const w = balancedWidth(400, at);
  assert.equal(at(w), 2, 'still two lines');
  assert.ok(at(w - 1) > 2, 'one pixel less would need a third line');
  assert.ok(w < 400 && w >= 200);
});

test('one line, or a heading no narrower width can keep, stays at its full width', () => {
  assert.equal(balancedWidth(400, wrapper([80, 90])), 400);
  assert.equal(balancedWidth(400, () => Infinity), 400);
  assert.equal(balancedWidth(400.7, wrapper([80, 90])), 400, 'whole pixels');
});

test('the search never goes under its floor, and never cuts a word to save a line', () => {
  const at = wrapper([150, 150, 150]);
  assert.equal(at(400), 2);
  const w = balancedWidth(400, at, 300);
  assert.ok(w >= 300);
  const long = wrapper([390, 20]);
  assert.equal(balancedWidth(400, long), 390, 'no narrower than its widest word, which is never cut');
});

test('it stays out where the engine balances by itself, or cannot say', () => {
  assert.equal(balancesItself({ supports: (p, v) => p === 'text-wrap' && v === 'balance' }), true);
  assert.equal(balancesItself({ supports: () => false }), false);
  assert.equal(balancesItself(undefined), false);
  assert.equal(balancesItself({ supports: () => { throw new Error('no'); } }), false);
});

test('balance.js is pure enough for the page: no node: imports', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../ui/balance.js', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(text));
});
