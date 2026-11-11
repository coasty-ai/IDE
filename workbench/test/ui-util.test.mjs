import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalesce, esc } from '../ui/util.js';

test('coalesce: a hidden tab, where frames never run, queues one render, not a backlog', () => {
  const timers = [], frames = [];
  let runs = 0;
  const render = coalesce(() => runs++, 120, { raf: f => frames.push(f), timer: f => timers.push(f) });
  for (let i = 0; i < 60; i++) { render(); while (timers.length) timers.shift()(); }
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(runs, 1);
});

test('coalesce: a render asked for after a frame has run is not lost', () => {
  const timers = [], frames = [];
  let runs = 0;
  const render = coalesce(() => runs++, 120, { raf: f => frames.push(f), timer: f => timers.push(f) });
  render(); timers.shift()(); frames.shift()();
  render(); timers.shift()(); frames.shift()();
  assert.equal(runs, 2);
});

test('esc: everything an agent writes is escaped before it reaches the page', () => {
  assert.equal(esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
});
