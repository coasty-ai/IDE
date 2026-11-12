import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffHtml, visibleHtml, visibleText, hasHidden, fileWords, leftWords, patchLines, patchFacts } from '../ui/diffview.js';

// Hidden characters are built from their code points: written raw, they would hide in this very file.
const U = n => String.fromCodePoint(n);
const RLO = U(0x202e);
const patch = (path, body, head = 'index 1111111..2222222 100644') => `diff --git a/${path} b/${path}\n${head}\n--- a/${path}\n+++ b/${path}\n${body}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => U(a + i));
const hex = c => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');

test('every file gets a plain header: its counts, or new file, deleted, binary file, too large to show here', () => {
  assert.equal(fileWords({ status: 'modified', adds: 40, dels: 2 }), '+40 −2');
  assert.equal(fileWords({ status: 'added', adds: 12, dels: 0 }), 'new file, +12');
  assert.equal(fileWords({ status: 'deleted', adds: 0, dels: 30 }), 'deleted, −30');
  assert.equal(fileWords({ status: 'modified', binary: true }), 'binary file');
  assert.equal(fileWords({ status: 'added', large: true }), 'too large to show here');
  assert.equal(fileWords({ status: 'modified', adds: 1240, dels: 3 }), '+1,240 −3');
  const html = diffHtml({ files: [
    { path: 'logo.png', status: 'added', adds: 0, dels: 0, binary: true, patch: null },
    { path: 'data.json', status: 'modified', adds: 9000, dels: 1, large: true, patch: null },
  ], left: [] });
  assert.match(html, /logo\.png<\/span> <span class="dn">binary file</);
  assert.match(html, /data\.json<\/span> <span class="dn">too large to show here</);
});

test('lines carry visible + and − marks, and words for screen readers; colour never carries it alone', () => {
  const html = diffHtml({ files: [{ path: 'a.js', status: 'modified', adds: 1, dels: 1, patch: patch('a.js', '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n') }] });
  assert.match(html, /<div class="dl del"><span class="dg" aria-hidden="true">−<\/span><span class="sr">removed: <\/span><span class="dt">old<\/span><\/div>/);
  assert.match(html, /<div class="dl add"><span class="dg" aria-hidden="true">\+<\/span><span class="sr">added: <\/span><span class="dt">new<\/span><\/div>/);
  assert.match(html, /<div class="dl ctx">/);
  assert.match(html, /line 1/, 'a hunk says where it is, in plain words');
  assert.doesNotMatch(html, /index 1111111|diff --git|\+\+\+ b\/|@@/, "git's own headers are not shown");
  // a deleted file's hunk starts at line 1 of what it was
  assert.equal(patchLines(patch('d', '@@ -1,2 +0,0 @@\n-a\n-b\n'))[0].line, 1);
});

test('everything is escaped, and hidden characters are shown as visible symbols', () => {
  const evil = '<script>alert("x")</script> & \'q\'';
  const html = diffHtml({ files: [{ path: 'x<y>.js', status: 'modified', adds: 1, dels: 0, patch: patch('x.js', `@@ -0,0 +1 @@\n+${evil}\n`) }] });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &#39;q&#39;/);
  assert.match(html, /x&lt;y&gt;\.js/);
  assert.match(visibleHtml(RLO), /title="Hidden here: a right-to-left override\."/);
  // a file name with a reversed run cannot reorder what the person reads
  const html2 = diffHtml({ files: [{ path: `evil${RLO}txt.exe`, status: 'added', adds: 1, dels: 0, patch: patch('e', '@@ -0,0 +1 @@\n+ok\n') }] });
  assert.ok(!html2.includes(RLO));
  assert.match(html2, /evil<span class="vc"[^>]*>⟦U\+202E⟧<\/span>txt\.exe/);
});

test("the spec's whole ranges are never raw: control characters, U+202A to U+202E, U+2066 to U+2069, U+200B to U+200F, U+FEFF", () => {
  const controls = [...range(0x00, 0x08), ...range(0x0a, 0x1f), U(0x7f), ...range(0x80, 0x9f)];
  const bidi = [...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];
  const zeroWidth = [...range(0x200b, 0x200f), U(0xfeff)];
  const more = [U(0x2028), U(0x2029), U(0x2060), U(0x061c)];
  for (const ch of [...controls, ...bidi, ...zeroWidth, ...more]) {
    const html = visibleHtml(`a${ch}b`), text = visibleText(`a${ch}b`);
    assert.ok(!html.includes(ch), `U+${hex(ch)} is never raw in HTML`);
    assert.ok(!text.includes(ch), `U+${hex(ch)} is never raw in plain text`);
    assert.ok(hasHidden(ch), `U+${hex(ch)} counts as hidden`);
    assert.match(html, /^a<span class="vc" title="Hidden here: [^"]+">[^<]+<\/span>b$/, `U+${hex(ch)} is marked`);
  }
  for (const [code, shown] of [[0x202e, '⟦U+202E⟧'], [0x202a, '⟦U+202A⟧'], [0x2066, '⟦U+2066⟧'], [0x2069, '⟦U+2069⟧'], [0x200b, '⟦U+200B⟧'],
    [0x200f, '⟦U+200F⟧'], [0xfeff, '⟦U+FEFF⟧'], [0x00, '␀'], [0x1b, '␛'], [0x7f, '␡'], [0x0d, '␍'], [0x0a, '⏎'], [0x85, '⟦U+0085⟧']]) {
    assert.ok(visibleHtml(`a${U(code)}b`).includes(shown), `U+${hex(U(code))} shows as ${shown}`);
    assert.equal(visibleText(`a${U(code)}b`), `a${shown}b`);
  }
  // ordinary text, accents and other scripts stay as they are
  for (const s of ['naïve café', 'Привет', 'こんにちは', 'emoji 🙂', 'a-b_c.d']) { assert.equal(visibleText(s), s); assert.equal(hasHidden(s), false); }
});

test('this module and its test hold no raw hidden characters themselves', () => {
  for (const f of ['../ui/diffview.js', './ui-diffview.test.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const raw = [...src].filter(ch => ch !== '\n' && hasHidden(ch));
    assert.deepEqual(raw.map(hex), [], f);
  }
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

test('past maxLines the rest is counted: "and 1,240 more lines", and every file still shows its header', () => {
  const body = '@@ -0,0 +1,1250 @@\n' + Array.from({ length: 1250 }, (_, i) => `+line ${i}`).join('\n') + '\n';
  const html = diffHtml({ files: [{ path: 'big.txt', status: 'added', adds: 1250, dels: 0, patch: patch('big.txt', body) }] }, { maxLines: 10 });
  assert.match(html, /and 1,240 more lines/);
  assert.equal((html.match(/class="dl add"/g) || []).length, 10);
  const two = diffHtml({ files: [
    { path: 'a.txt', status: 'added', adds: 3, dels: 0, patch: patch('a.txt', '@@ -0,0 +1,3 @@\n+1\n+2\n+3\n') },
    { path: 'b.txt', status: 'added', adds: 2, dels: 0, patch: patch('b.txt', '@@ -0,0 +1,2 @@\n+1\n+2\n') },
  ] }, { maxLines: 2 });
  assert.match(two, /and 3 more lines/);
  assert.match(two, /b\.txt<\/span> <span class="dn">new file, \+2</, 'a file past the cap keeps its header, so every file can be seen');
  assert.equal((two.match(/class="dl /g) || []).length, 2);
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
  assert.equal(diffHtml({ files: [null, 'x'] }), '<p class="dq">No changes.</p>', 'junk entries are skipped, not drawn');
});

test('a link says where it points, and a file that only became runnable says so', () => {
  const link = patch('docs/keys', '@@ -0,0 +1 @@\n+../../../.ssh/id_ed25519\n\\ No newline at end of file\n', 'new file mode 120000\nindex 0000000..1a2b3c4');
  assert.equal(patchFacts(link).link, true);
  const html = diffHtml({ files: [{ path: 'docs/keys', status: 'added', adds: 1, dels: 0, patch: link }] });
  assert.match(html, /docs\/keys<\/span> <span class="dn">new link</);
  assert.match(html, /<span class="dt">→ \.\.\/\.\.\/\.\.\/\.ssh\/id_ed25519<\/span>/);
  const exec = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
  assert.equal(patchFacts(exec).exec, 'on');
  assert.match(diffHtml({ files: [{ path: 'run.sh', status: 'modified', adds: 0, dels: 0, patch: exec }] }), /Only this changed: it can now run as a program\./);
  assert.match(diffHtml({ files: [{ path: 'empty.txt', status: 'added', adds: 0, dels: 0, patch: 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n' }] }), /An empty file\./);
});

test('a 400-character line and a long path stay whole: the page wraps them, nothing is cut', () => {
  const long = 'x'.repeat(400);
  const path = 'src/' + 'deeply/nested/'.repeat(12) + 'file.ts';
  const html = diffHtml({ files: [{ path, status: 'modified', adds: 1, dels: 0, patch: patch(path, `@@ -1 +1 @@\n+${long}\n`) }] });
  assert.ok(html.includes(long));
  assert.ok(html.includes(path));
});
