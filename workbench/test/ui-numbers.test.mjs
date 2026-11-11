import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTokens, allTokens, stepsInWindow, windowMinutes, costWords } from '../ui/numbers.js';
import { money, tokens } from '../src/shared/format.mjs';
import { SPARK_BUCKET_MS, SPARK_BUCKETS } from '../src/shared/events.mjs';

test('the card counts new tokens; re-reads from memory are left for the tooltip', () => {
  // Checkout fix in the demo: 761k of its 789k tokens are re-reads
  const u = { inputTokens: 258, outputTokens: 6850, cacheReadTokens: 760862, cacheWriteTokens: 21391 };
  assert.equal(newTokens(u), 28499);
  assert.equal(tokens(newTokens(u)), '28.5k');
  assert.equal(allTokens(u), 789361);
  assert.equal(newTokens(null), 0);
  assert.equal(newTokens({}), 0);
});

test('the activity count is the steps in the bars’ own window', () => {
  assert.equal(stepsInWindow([0, 1, 2, 0, 3]), 6);
  assert.equal(stepsInWindow(new Array(20).fill(0)), 0);
  assert.equal(stepsInWindow(null), 0);
  assert.equal(stepsInWindow([1, NaN, -2, 2]), 3);
  assert.equal(windowMinutes(SPARK_BUCKET_MS, SPARK_BUCKETS), 10);
});

test('a cost that has not been reported reads "not reported yet"', () => {
  assert.equal(costWords(null, money), 'not reported yet');
  assert.equal(costWords(undefined, money), 'not reported yet');
  assert.equal(costWords(0.62, money), '$0.62');
  assert.equal(costWords(0, money), '$0');
});
