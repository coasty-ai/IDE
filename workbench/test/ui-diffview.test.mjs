import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffHtml, visibleHtml, visibleText, fileWords, leftWords, patchLines } from '../ui/diffview.js';

const patch = (path, body) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${body}`;

test('every file gets a plain header: its counts, or new file, deleted, binary file, too large to show here', () => {
  assert.equal(fileWords({ status: 'modified', adds: 40, dels: 2 }), '+40 −2');
  assert.equal(fileWords({ status: 'added', adds: 12, dels: 0 }), 'new file, +12');
  assert.equal(fileWords({ status: 'deleted', adds: 0, dels: 30 }), 'deleted, −30');
  assert.equal(fileWords({ status: 'modified', binary: true }), 'binary file');
  assert.equal(fileWords({ status: 'added', large: true }), 'too large to show here');
  const html = diffHtml({ files: [
    { path: 'logo.png', status: 'added', adds: 0, dels: 0, binary: true, patch: null },
    { path: 'data.json', status: 'modified', adds: 9000, dels: 1, large: true, patch: null },
  ], left: [] });
  assert.match(html, /binary file/);
  assert.match(html, /too large to show here/);
});

test('lines carry visible + and − marks, and words for screen readers; colour never carries it alone', () => {
  const html = diffHtml({ files: [{ path: 'a.js', status: 'modified', adds: 1, dels: 1, patch: patch('a.js', '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n') }] });
  assert.match(html, /<div class="dl del"><span class="dg" aria-hidden="true">−<\/span><span class="sr">removed: <\/span><span class="dt">old<\/span><\/div>/);
  assert.match(html, /<div class="dl add"><span class="dg" aria-hidden="true">\+<\/span><span class="sr">added: <\/span><span class="dt">new<\/span><\/div>/);
  assert.match(html, /<div class="dl ctx">/);
  assert.match(html, /line 1/, 'a hunk says where it is, in plain words');
  assert.doesNotMatch(html, /index 1111111|diff --git|\+\+\+ b\//, "git's own headers are not shown");
});

test('everything is escaped, and hidden characters are shown as visible symbols', () => {
  const evil = '<script>alert("x")</script> & \'q\'';
  const html = diffHtml({ files: [{ path: 'x<y>.js', status: 'modified', adds: 1, dels: 0, patch: patch('x.js', `@@ -0,0 +1 @@\n+${evil}\n`) }] });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;q&#39;/);
  assert.match(html, /x&lt;y&gt;\.js/);
  // bidirectional overrides and isolates, zero-width characters, a byte-order mark, control characters
  for (const [ch, shown] of [['‮', '⟦U+202E⟧'], ['‪', '⟦U+202A⟧'], ['⁦', '⟦U+2066⟧'], ['⁩', '⟦U+2069⟧'], ['​', '⟦U+200B⟧'],
    ['‏', '⟦U+200F⟧'], ['﻿', '⟦U+FEFF⟧'], ['\x00', '␀'], ['\x1b', '␛'], ['\x7f', '␡'], ['\r', '␍'], ['\u0085', '⟦U+0085⟧']]) {
    const out = visibleHtml(`a${ch}b`);
    assert.ok(!out.includes(ch), `U+${ch.codePointAt(0).toString(16)} is never raw`);
    assert.ok(out.includes(shown), `${JSON.stringify(ch)} shows as ${shown}: ${out}`);
    assert.ok(!visibleText(`a${ch}b`).includes(ch));
  }
  assert.match(visibleHtml('‮'), /title="Hidden here: a right-to-left override\."/);
  // a commit subject or file name with a reversed run cannot reorder what the person reads
  const html2 = diffHtml({ files: [{ path: 'evil‮txt.exe', status: 'added', adds: 1, dels: 0, patch: patch('e', '@@ -0,0 +1 @@\n+ok\n') }] });
  assert.ok(!html2.includes('‮'));
  assert.match(html2, /evil<span class="vc"[^>]*>⟦U\+202E⟧<\/span>txt\.exe/);
});

test('tabs stay visible and keep the indentation; Windows line endings show their ␍', () => {
  assert.equal(visibleText('\tx'), '⇥x');
  const out = visibleHtml('\tif (a) {\r');
  assert.match(out, /^<span class="vc tab" title="A tab">⇥<\/span> {3}if \(a\) \{<span class="vc"[^>]*>␍<\/span>$/);
  assert.equal(visibleHtml('ab\tc').replace(/<[^>]+>/g, ''), 'ab⇥ c', 'a tab after two characters takes them to the next stop of 4');
  const lines = patchLines(patch('w.txt', '@@ -1 +1 @@\n-one\r\n+two\r\n\\ No newline at end of file\n'));
  assert.deepEqual(lines.map(l => l.t), ['hunk', 'del', 'add', 'note']);
  assert.equal(lines[1].s, 'one\r');
  const html = diffHtml({ files: [{ path: 'w.txt', status: 'modified', adds: 1, dels: 1, patch: patch('w.txt', '@@ -1 +1 @@\n-one\r\n+two\r\n\\ No newline at end of file\n') }] });
  assert.match(html, /two<span class="vc"[^>]*>␍<\/span>/);
  assert.match(html, /no line break at the end of the file/);
});

test('past maxLines the rest is counted: "and 1,240 more lines"', () => {
  const body = '@@ -0,0 +1,1250 @@\n' + Array.from({ length: 1250 }, (_, i) => `+line ${i}`).join('\n') + '\n';
  const html = diffHtml({ files: [{ path: 'big.txt', status: 'added', adds: 1250, dels: 0, patch: patch('big.txt', body) }] }, { maxLines: 10 });
  assert.match(html, /and 1,240 more lines/);
  assert.equal((html.match(/class="dl add"/g) || []).length, 10);
  const two = diffHtml({ files: [
    { path: 'a.txt', status: 'added', adds: 3, dels: 0, patch: patch('a.txt', '@@ -0,0 +1,3 @@\n+1\n+2\n+3\n') },
    { path: 'b.txt', status: 'added', adds: 2, dels: 0, patch: patch('b.txt', '@@ -0,0 +1,2 @@\n+1\n+2\n') },
  ] }, { maxLines: 2 });
  assert.match(two, /and 3 more lines/);
  assert.doesNotMatch(two, /b\.txt/, 'a file wholly past the cap is counted, not shown');
  assert.match(diffHtml({ files: [{ path: 'a', status: 'added', adds: 2, dels: 0, patch: patch('a', '@@ -0,0 +1,2 @@\n+1\n+2\n') }] }, { maxLines: 1 }), /and 1 more line</);
});

test('files left out are listed as not merged, and cut or omitted files are said plainly', () => {
  assert.equal(leftWords('ignored'), 'Not merged: hidden by a .gitignore it changed');
  assert.equal(leftWords('nested-repo'), 'Not merged: it is a separate repository inside its folder');
  const html = diffHtml({ files: [{ path: 'a.js', status: 'modified', adds: 1, dels: 0, cut: true, patch: patch('a.js', '@@ -1 +1,2 @@\n x\n+y\n') }],
    left: [{ path: '.env', why: 'ignored' }, { path: 'vendor/lib', why: 'nested-repo' }], cut: true, omitted: 3 });
  assert.match(html, /\.env<\/span> <span class="dw">Not merged: hidden by a \.gitignore it changed/);
  assert.match(html, /vendor\/lib<\/span> <span class="dw">Not merged: it is a separate repository inside its folder/);
  assert.match(html, /2 files not merged/);
  assert.match(html, /The rest of this file is too long to show here\./);
  assert.match(html, /and 3 more files, not shown here/);
  assert.match(html, /Some of the changes are too large to show here\./);
  assert.equal(diffHtml({ files: [], left: [] }), '<p class="dq">No changes.</p>');
  assert.equal(diffHtml(null), '<p class="dq">No changes.</p>');
});

test('a 400-character line and a long path stay whole: the page wraps them, nothing is cut', () => {
  const long = 'x'.repeat(400);
  const path = 'src/' + 'deeply/nested/'.repeat(12) + 'file.ts';
  const html = diffHtml({ files: [{ path, status: 'modified', adds: 1, dels: 0, patch: patch(path, `@@ -1 +1 @@\n+${long}\n`) }] });
  assert.ok(html.includes(long));
  assert.ok(html.includes(path));
});
