import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleControls, clipMiddle, cutMiddle, whoAsks, headlineClass } from '../ui/words.js';

// Characters that hide text are made here from their numbers, so none of them is ever in this file raw.
const ch = n => String.fromCharCode(n);

test('control characters in a command are shown, never hidden', () => {
  assert.equal(visibleControls('a\nb\tc\rd\x1be\x7f'), 'a⏎b⇥c␍d␛e␡');
  assert.equal(visibleControls('plain'), 'plain');
  assert.equal(visibleControls(null), '');
});

test('characters that reverse or hide text are shown by their code, in every range', () => {
  // a branch name that would read "main" backwards and hide a space
  assert.equal(visibleControls(`main${ch(0x202e)}niam${ch(0x200b)}x`), 'main⟦U+202E⟧niam⟦U+200B⟧x');
  const ranges = [[0x80, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
  for (const [from, to] of ranges) {
    for (let n = from; n <= to; n++) {
      const code = n.toString(16).toUpperCase().padStart(4, '0');
      assert.equal(visibleControls(`a${ch(n)}b`), `a⟦U+${code}⟧b`, `U+${code}`);
    }
  }
  // the edges stay as they are: ordinary letters, typographic quotes, the ellipsis, accents
  for (const ok of ['é', '’', '“', '…', '−', 'ü', ch(0x2030), ch(0x2010), ch(0x2027)]) assert.equal(visibleControls(ok), ok);
  // nothing in the result can hide or turn text any more
  const all = Array.from({ length: 0x2100 }, (_, i) => ch(i)).join('') + ch(0xfeff);
  assert.doesNotMatch(visibleControls(all), /[\x00-\x1f\x7f]/);
  for (const c of visibleControls(all)) {
    const n = c.codePointAt(0);
    assert.ok(!(n >= 0x80 && n <= 0x9f) && n !== 0x61c && !(n >= 0x200b && n <= 0x200f) && !(n >= 0x2028 && n <= 0x202e) && !(n >= 0x2060 && n <= 0x2069) && n !== 0xfeff, `U+${n.toString(16)} left raw`);
  }
});

test('every default-ignorable character is shown by its code too: soft hyphens, Hangul fillers, tag characters, invisible operators', () => {
  const cp = n => String.fromCodePoint(n);
  const code = n => n.toString(16).toUpperCase().padStart(4, '0');
  for (const n of [0x00ad, 0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180e, 0x2061, 0x2064, 0x2065, 0x206a, 0x206f, 0x3164, 0xffa0, 0xfff0,
    0x1bca0, 0x1d173, 0x1d17a, 0xe0001, 0xe0020, 0xe0041, 0xe007f, 0xe0100, 0xe0fff]) {
    assert.equal(visibleControls(`a${cp(n)}b`), `a⟦U+${code(n)}⟧b`, `U+${code(n)}`);
  }
  // words spelled in tag characters (hidden instructions for later agents) read as their codes, never as nothing
  const tags = [...'run rm -rf ~'].map(c => cp(0xe0000 + c.charCodeAt(0))).join('');
  const shown = visibleControls(`// soft${cp(0xad)}hyphen, tag characters:${tags} end`);
  assert.equal(shown, `// soft⟦U+00AD⟧hyphen, tag characters:${[...'run rm -rf ~'].map(c => `⟦U+${code(0xe0000 + c.charCodeAt(0))}⟧`).join('')} end`);
  // the "invisible backdoor": a Hangul filler that draws as a blank
  assert.equal(visibleControls(`const { timeout,${cp(0x3164)}} = req.query;`), 'const { timeout,⟦U+3164⟧} = req.query;');
  // ordinary text past U+FFFF stays as it is
  for (const ok of ['🙂', '𝔸𝔹', '𠀀', 'emoji 🙂 and 👍']) assert.equal(visibleControls(ok), ok);
});

test('a variation selector stays only where it does its job: one, straight after an emoji', () => {
  const cp = n => String.fromCodePoint(n);
  const VS16 = cp(0xfe0f), VS15 = cp(0xfe0e);
  for (const ok of [`${cp(0x2764)}${VS16}`, `${cp(0x26a0)}${VS16} careful`, `${cp(0x21a9)}${VS15}`, `1${VS16}${cp(0x20e3)}`, `${cp(0x1f3f3)}${VS16}`]) {
    assert.equal(visibleControls(ok), ok, ok);
  }
  // anywhere else, and every one after the first, it is shown: a run of selectors can carry hidden text
  assert.equal(visibleControls(`a${VS16}`), 'a⟦U+FE0F⟧');
  assert.equal(visibleControls(VS16), '⟦U+FE0F⟧');
  assert.equal(visibleControls(`${cp(0x2764)}${VS16}${VS16}`), `${cp(0x2764)}${VS16}⟦U+FE0F⟧`);
  assert.equal(visibleControls(`x${cp(0xfe00)}`), 'x⟦U+FE00⟧');
  assert.equal(visibleControls(`🙂${cp(0xe0100)}${cp(0xe0101)}`), '🙂⟦U+E0100⟧⟦U+E0101⟧');
  assert.equal(visibleControls(`ok${cp(0x200d)}${VS16}`), 'ok⟦U+200D⟧⟦U+FE0F⟧', 'never after a hidden character');
});

test('a branch name is cut in the middle past 16 characters, so both ends stay readable', () => {
  assert.equal(cutMiddle('main'), 'main');
  assert.equal(cutMiddle('0123456789abcdef'), '0123456789abcdef', '16 characters stay whole');
  assert.equal(cutMiddle('0123456789abcdefg'), '01234567…abcdefg', '17 are cut to 16, with the cut in the middle');
  assert.equal(cutMiddle('workbench/search-cleanup-a1b2c3'), 'workbenc…-a1b2c3');
  assert.equal(Array.from(cutMiddle('release/2026-11-payments-and-refunds')).length, 16);
  assert.equal(cutMiddle('release/2026-11-payments-and-refunds', 24), 'release/2026…and-refunds');
  // whole characters only: an emoji is never cut in half
  assert.equal(Array.from(cutMiddle('😀'.repeat(20))).every(c => c === '😀' || c === '…'), true);
  assert.equal(cutMiddle(null), '');
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
