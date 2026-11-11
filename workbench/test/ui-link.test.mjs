import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkState, plainError, cannotSend, DOWN_MS } from '../ui/link.js';

test('linkState: the page tells no key, connecting, live, reconnecting, down and a stale key apart', () => {
  assert.equal(linkState({ hasKey: false, loaded: false, stream: null }), 'no-key');
  assert.equal(linkState({ hasKey: false, loaded: true, stream: 'open' }), 'no-key');
  assert.equal(linkState({ hasKey: true, loaded: false, stream: null }), 'connecting');
  assert.equal(linkState({ hasKey: true, loaded: false, stream: 'connecting' }), 'connecting');
  assert.equal(linkState({ hasKey: true, loaded: false, stream: 'open' }), 'connecting');
  assert.equal(linkState({ hasKey: true, loaded: true, stream: 'open' }), 'live');
  assert.equal(linkState({ hasKey: true, loaded: true, stream: 'connecting' }), 'reconnecting');
  assert.equal(linkState({ hasKey: true, loaded: true, stream: 'closed' }), 'reconnecting');
  assert.equal(linkState({ hasKey: true, loaded: true, stream: 'connecting', downMs: DOWN_MS + 1 }), 'down');
  assert.equal(linkState({ hasKey: true, loaded: false, stream: 'connecting', downMs: DOWN_MS + 1 }), 'down');
  // a refused key wins over everything but a missing one, loaded or not
  assert.equal(linkState({ hasKey: true, loaded: true, stream: 'closed', refused: true }), 'stale');
  assert.equal(linkState({ hasKey: true, loaded: false, stream: 'closed', refused: true }), 'stale');
});

test('nothing can be sent without a working key', () => {
  assert.equal(cannotSend('no-key'), true);
  assert.equal(cannotSend('stale'), true);
  for (const s of ['connecting', 'live', 'reconnecting', 'down']) assert.equal(cannotSend(s), false, s);
});

test('plainError: failures in plain words, never "token" or "fetch"', () => {
  assert.match(plainError(401), /key no longer works/);
  assert.match(plainError(401), /terminal/);
  assert.match(plainError(null), /isn’t answering/);
  assert.match(plainError(0), /isn’t answering/);
  assert.equal(plainError(409, 'Search cleanup is not waiting for that any more.'), 'Search cleanup is not waiting for that any more.');
  assert.match(plainError(500), /went wrong/);
  assert.match(plainError(400), /said no \(400\)/);
  for (const s of [plainError(401, 'Missing or wrong token.'), plainError(null, 'Failed to fetch'), plainError(403, 'Bad token'), plainError(500, 'fetch failed')]) {
    assert.doesNotMatch(s, /token|fetch/i, s);
  }
});
