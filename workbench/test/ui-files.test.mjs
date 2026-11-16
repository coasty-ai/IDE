// The file view's pure parts (ui/files.js): finding a file by a few letters, a folder's one level, a line to jump to,
// the file's own indentation, which rows to draw for a scroll, which lines changed when a file is read again, the words
// for whose copy it is, the path's crumbs in the room there is, and lines and paths as HTML with every hidden character
// shown. node:test loads the module as it is: it touches no DOM and imports nothing from /shared/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../ui/files.js';
import { hiddenParts } from '../ui/words.js';

const U = n => String.fromCodePoint(n);
const RLO = U(0x202e), ZWSP = U(0x200b);
const FILES = [
  'README.md', 'package.json', '.env', 'src/cart.ts', 'src/index.ts', 'src/invoices/export.ts', 'src/invoices/query.ts', 'src/invoices/batch.ts',
  'src/invoices/sample.csv', 'src/experiments/notes.md', 'src/components/SearchBox.tsx', 'src/components/Header.tsx', 'docs/export-guide.md',
  'test/invoices/large-account.test.ts', 'migrations/0042_invoice_lookup_index.sql',
];
const list = FILES.map(path => ({ path }));
const top = (q, files = list) => F.findFiles(files, q).map(r => r.path);

test('a few letters find a file: in order, anywhere in its path, its own name first', () => {
  assert.equal(top('export')[0], 'src/invoices/export.ts', 'its name starts with them, and it is the shorter name');
  assert.equal(top('export')[1], 'docs/export-guide.md');
  assert.equal(top('cart')[0], 'src/cart.ts');
  assert.equal(top('readme')[0], 'README.md', 'in any case');
  assert.equal(top('inv/exp')[0], 'src/invoices/export.ts', 'a slash matches a slash');
  assert.equal(top('invex')[0], 'src/invoices/export.ts', 'letters that start words count most');
  assert.equal(top('sb')[0], 'src/components/SearchBox.tsx', 'capitals inside a name start words too');
  assert.equal(top('qry')[0], 'src/invoices/query.ts');
  assert.equal(top('0042')[0], 'migrations/0042_invoice_lookup_index.sql');
  assert.deepEqual(top('zzz'), [], 'nothing when the letters are not there in order');
  assert.deepEqual(top(''), [], 'nothing for no letters');
  assert.deepEqual(top('   '), []);
  assert.equal(top('export ts')[0], 'src/invoices/export.ts', 'spaces between letters are left out');
});

test('matched letters are the ones that read best: the start of a word, letters side by side', () => {
  const m = F.fuzzyMatch('exp', 'src/invoices/export.ts');
  assert.deepEqual(m.hits, [13, 14, 15], 'export’s own e, x and p, not the e of invoices');
  assert.deepEqual(F.fuzzyMatch('sb', 'src/components/SearchBox.tsx').hits, [15, 21]);
  assert.equal(F.fuzzyMatch('xyz', 'src/a.ts'), null);
  const a = F.fuzzyMatch('ab', 'xa/b'), b = F.fuzzyMatch('ab', 'ab');
  assert.ok(b.score > a.score, 'letters side by side beat letters apart');
});

test('at most 12 matches, and a long list is still quick', () => {
  const many = Array.from({ length: 50000 }, (_, i) => ({ path: `src/module-${i % 97}/part-${i}/file-${i}.ts` }));
  const t0 = performance.now();
  const r = F.findFiles(many, 'mod5part');
  assert.ok(r.length <= 12);
  assert.ok(performance.now() - t0 < 1500, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(F.findFiles(many, 'file-49999')[0].path, 'src/module-44/part-49999/file-49999.ts');
});

test('with the field empty: files agents changed first, then the files opened lately', () => {
  const files = [{ path: 'a.ts' }, { path: 'b.ts', changedBy: [{ agentId: 'x', name: 'Invoice export', state: 'done_checked' }] }, { path: 'c.ts' }, { path: 'd.ts' }];
  const e = F.emptyFinder(files, ['c.ts', 'b.ts', 'gone.ts', 'a.ts']);
  assert.deepEqual(e.changed.map(f => f.path), ['b.ts']);
  assert.deepEqual(e.recent.map(f => f.path), ['c.ts', 'a.ts'], 'not twice, and only files that are there');
  assert.equal(F.emptyFinder(files, []).recent.length, 0);
  const lots = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, changedBy: [{ agentId: 'x', name: 'A', state: 'working' }] }));
  const l = F.emptyFinder(lots, ['f1']);
  assert.ok(l.changed.length + l.recent.length <= 12);
  assert.deepEqual(F.remember(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.equal(F.remember(Array.from({ length: 20 }, (_, i) => String(i)), 'x').length, 8);
});

test('"40", ":40" and "line 40" jump to a line; anything else is a file to find', () => {
  assert.equal(F.lineJump('40'), 40);
  assert.equal(F.lineJump(':40'), 40);
  assert.equal(F.lineJump(': 40'), 40);
  assert.equal(F.lineJump('line 40'), 40);
  assert.equal(F.lineJump('Line 40'), 40);
  assert.equal(F.lineJump('  line40 '), 40);
  for (const t of ['0', ':0', 'line', '40a', 'a40', '4.5', '1e3', 'l 40', '-3', '', '99999999']) assert.equal(F.lineJump(t), null, t);
});

test('a folder shows one level, folders first, with the marks of the agents that changed something inside', () => {
  const by = (name, state = 'done_checked') => [{ agentId: name.toLowerCase(), name, state }];
  const files = [
    { path: 'src/invoices/export.ts', changedBy: by('Invoice export') }, { path: 'src/invoices/query.ts' }, { path: 'src/cart.ts' },
    { path: 'src/Zeta.ts' }, { path: 'src/alpha.ts' }, { path: 'src/file10.ts' }, { path: 'src/file9.ts' }, { path: 'src/components/Header.tsx', changedBy: by('Search cleanup', 'question') },
    { path: 'README.md' }, { path: '.env', ignored: true }, { path: 'docs/a.md' },
  ];
  const root = F.folderListing(files, '');
  assert.deepEqual(root.folders.map(f => f.name), ['docs', 'src']);
  assert.deepEqual(root.files.map(f => f.name), ['.env', 'README.md']);
  assert.deepEqual(root.folders.find(f => f.name === 'src').marks.map(m => m.name), ['Invoice export', 'Search cleanup']);
  const src = F.folderListing(files, 'src');
  assert.deepEqual(src.folders.map(f => [f.name, f.path]), [['components', 'src/components'], ['invoices', 'src/invoices']]);
  assert.deepEqual(src.files.map(f => f.name), ['alpha.ts', 'cart.ts', 'file9.ts', 'file10.ts', 'Zeta.ts'], 'by name, numbers in order, in any case');
  const inv = F.folderListing(files, 'src/invoices');
  assert.deepEqual(inv.files.map(f => [f.name, f.changedBy ? f.changedBy[0].name : null]), [['export.ts', 'Invoice export'], ['query.ts', null]]);
  assert.deepEqual(F.folderListing(files, 'nowhere'), { folders: [], files: [] });
  assert.deepEqual(F.folderListing(files, 'src/').folders.length, 2, 'a trailing slash is the same folder');
});

test('the path’s crumbs: the repository, each folder you can open, and the file', () => {
  assert.deepEqual(F.crumbsOf('storefront', 'src/invoices/export.ts'), [
    { label: 'storefront', dir: '' }, { label: 'src', dir: 'src' }, { label: 'invoices', dir: 'src/invoices' }, { label: 'export.ts', file: true },
  ]);
  assert.deepEqual(F.crumbsOf('storefront', 'src/invoices', { folder: true }), [
    { label: 'storefront', dir: '' }, { label: 'src', dir: 'src' }, { label: 'invoices', dir: 'src/invoices', here: true },
  ]);
  assert.deepEqual(F.crumbsOf('storefront', '', { folder: true }), [{ label: 'storefront', dir: '', here: true }]);
  assert.deepEqual(F.crumbsOf(null, 'a.ts'), [{ label: 'files', dir: '' }, { label: 'a.ts', file: true }]);
  // in the room there is: the folders in the middle give way first, then the file's own name is cut in its middle
  const crumbs = F.crumbsOf('storefront', 'src/very/deeply/nested/folders/invoices/export.ts');
  const w = (t, bold) => Array.from(t).length * (bold ? 8 : 7);
  const all = F.fitCrumbs(crumbs, { widthOf: w, sep: 14, maxW: 2000 });
  assert.equal(all.length, crumbs.length, 'whole when it fits');
  const fit = F.fitCrumbs(crumbs, { widthOf: w, sep: 14, maxW: 300 });
  const width = fit.reduce((s, c) => s + w(c.label, !!c.file), 0) + 14 * (fit.length - 1);
  assert.ok(width <= 300, `${width}`);
  assert.equal(fit[0].label, 'storefront');
  assert.ok(fit.some(c => c.gap), 'a gap where folders were left out');
  assert.equal(fit[fit.length - 1].label, 'export.ts');
  assert.equal(fit[fit.length - 2].label, 'invoices', 'the file’s own folder stays as long as it can');
  const tiny = F.fitCrumbs(F.crumbsOf('storefront', `src/${'a-very-long-file-name-'.repeat(6)}.ts`), { widthOf: w, sep: 14, maxW: 200 });
  const last = tiny[tiny.length - 1];
  assert.ok(last.file && last.label.includes('…') && last.label.endsWith('.ts'), last.label);
  assert.ok(tiny.reduce((s, c) => s + w(c.label, !!c.file), 0) + 14 * (tiny.length - 1) <= 200);
});

test('Tab inserts the file’s own indentation: a tab, or its usual number of spaces', () => {
  assert.equal(F.guessIndent('a\n\tb\n\t\tc\n\td\n'), '\t');
  assert.equal(F.guessIndent('function a() {\n  if (x) {\n    y();\n  }\n}\n'), '  ');
  assert.equal(F.guessIndent('def a():\n    if x:\n        y()\n    return 1\n'), '    ');
  assert.equal(F.guessIndent('a:\n  b: 1\n  c:\n    d: 2\n'), '  ');
  assert.equal(F.guessIndent('no indentation\nat all\n'), '  ', 'two spaces when the file does not say');
  assert.equal(F.guessIndent(''), '  ');
  assert.equal(F.guessIndent('x\n    a\n    b\n        c\n  odd\n    d\n'), '    ', 'the usual step wins over one odd line');
  assert.equal(F.guessIndent(' * a comment\n * goes on\nfoo\n'), '  ', 'the space before a comment’s star is not indentation');
  assert.equal(F.guessIndent('\ta\n    b\n\tc\n'), '\t', 'mostly tabs');
});

test('rows are drawn in chunks around what shows, so a small scroll draws nothing new', () => {
  const at = top => F.rowWindow({ top, height: 600, lineH: 20, total: 25000 });
  assert.deepEqual(at(0), { first: 0, last: 60 });
  const deep = at(400000);
  assert.ok(deep.first <= 20000 - 10 && deep.last >= 20030 + 10, JSON.stringify(deep));
  assert.equal(deep.first % 20, 0);
  assert.equal(deep.last % 20, 0);
  assert.deepEqual(F.rowWindow({ top: 0, height: 600, lineH: 20, total: 7 }), { first: 0, last: 7 });
  assert.deepEqual(F.rowWindow({ top: 499000, height: 600, lineH: 20, total: 25000 }).last, 25000, 'never past the end');
  // the window drawn still covers the rows shown after a small scroll: nothing to draw again
  const w = at(4000);
  assert.ok(F.windowCovers(w, { top: 4100, height: 600, lineH: 20, total: 25000 }));
  assert.ok(!F.windowCovers(w, { top: 9000, height: 600, lineH: 20, total: 25000 }));
  assert.ok(F.windowCovers({ first: 0, last: 7 }, { top: 0, height: 600, lineH: 20, total: 7 }), 'a short file is always covered');
  // a file of 25,000 rows draws a few dozen at a time, wherever it is scrolled to
  for (const t of [0, 123456, 499400]) { const x = at(t); assert.ok(x.last - x.first <= 140, `${t}: ${x.last - x.first}`); }
});

test('a file read again: the lines that changed are marked, the rest are not', () => {
  assert.deepEqual(F.freshLines('a\nb\nc\n', 'a\nB\nc\n'), [2]);
  assert.deepEqual(F.freshLines('a\nb\nc\n', 'a\nb\nnew\nc\n'), [3]);
  assert.deepEqual(F.freshLines('a\nb\nc\n', 'a\nb\nc\n'), []);
  assert.deepEqual(F.freshLines(null, 'a\nb\n'), [], 'nothing on the first read');
  assert.deepEqual(F.freshLines('a\nb\nc\nd\n', 'a\nd\n'), [], 'lines taken away leave nothing to mark');
  assert.deepEqual(F.freshLines('x\na\nb\ny\n', 'x\nb\na\nnew\ny\n'), [4], 'lines that only moved are not new');
  assert.ok(F.freshLines('', 'x\n'.repeat(9000)).length <= 4000, 'a few thousand at most');
});

test('whose copy it is, in plain words', () => {
  assert.deepEqual(F.whoseLine({ where: 'a1', agent: { id: 'a1', name: 'Invoice export' }, changed: 7 }),
    { lead: 'In Invoice export’s copy', rest: ['7 lines changed'], link: { label: 'show yours', to: 'you' } });
  assert.deepEqual(F.whoseLine({ where: 'a1', agent: { id: 'a1', name: 'Invoice export' }, changed: 1 }).rest, ['1 line changed']);
  assert.deepEqual(F.whoseLine({ where: 'a1', agent: { id: 'a1', name: 'Invoice export' }, changed: 0 }).rest, []);
  assert.deepEqual(F.whoseLine({ where: 'you', branch: 'main' }), { lead: 'Your folder', rest: ['main'], link: null });
  assert.deepEqual(F.whoseLine({ where: 'you', branch: null }).rest, ['not on a branch']);
  const one = [{ agentId: 'a1', name: 'Invoice export', state: 'done_checked' }];
  assert.deepEqual(F.whoseLine({ where: 'you', branch: 'main', changedBy: one }),
    { lead: 'Your folder', rest: ['main'], agent: one[0], changedIt: 'Invoice export changed it', link: { label: 'show its copy', to: 'a1' } });
  const two = [...one, { agentId: 'b2', name: 'Help pages', state: 'working' }];
  assert.equal(F.whoseLine({ where: 'you', branch: 'main', changedBy: two }).changedIt, 'Invoice export and Help pages changed it');
  const three = [...two, { agentId: 'c3', name: 'Docs', state: 'working' }];
  assert.equal(F.whoseLine({ where: 'you', branch: 'main', changedBy: three }).changedIt, 'Invoice export and 2 more changed it');
});

test('search results: the open file’s first, at most 30, and the words found in bold, with hidden characters shown', () => {
  const r = [{ path: 'a.ts', line: 1, text: 'x' }, { path: 'b.ts', line: 4, text: 'x' }, { path: 'b.ts', line: 2, text: 'x' }, { path: 'c.ts', line: 9, text: 'x' }];
  assert.deepEqual(F.orderSearch(r, 'b.ts').map(x => `${x.path}:${x.line}`), ['b.ts:2', 'b.ts:4', 'a.ts:1', 'c.ts:9']);
  assert.equal(F.orderSearch(Array.from({ length: 200 }, (_, i) => ({ path: 'z', line: i + 1, text: '' })), null).length, 30);
  assert.deepEqual(F.matchRanges('Batch the batches', 'batch'), [[0, 5], [10, 15]], 'any case when the words have no capital');
  assert.deepEqual(F.matchRanges('Batch the batches', 'Batch'), [[0, 5]], 'that case when they have one');
  assert.deepEqual(F.matchRanges('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(F.matchRanges('abc', ''), []);
  const cut = F.cutAround('x'.repeat(100) + 'needle' + 'y'.repeat(100), [[100, 106]], 40);
  assert.ok(Array.from(cut.text).length <= 40, cut.text);
  assert.ok(cut.text.startsWith('…') && cut.text.endsWith('…'));
  assert.equal(cut.text.slice(cut.ranges[0][0], cut.ranges[0][1]), 'needle');
  assert.deepEqual(F.cutAround('short', [[0, 2]], 40), { text: 'short', ranges: [[0, 2]] });
  assert.equal(F.markedHtml(`a<b>${RLO}c`, [[1, 4]]), 'a<b>&lt;b&gt;</b><span class="vc" title="Hidden here: a right-to-left override.">⟦U+202E⟧</span>c');
  assert.equal(F.hitRanges([1, 2, 3, 7, 9, 10]).join(';'), '1,4;7,8;9,11');
});

test('a line of code as HTML: its colours, its tabs at their stops, and hidden characters shown', () => {
  assert.equal(F.lineHtml([['k', 'const'], ['', ' a = '], ['n', '1'], ['', ';']]), '<span class="hk">const</span> a = <span class="hn">1</span>;');
  // a tab after "ab" in another part still stops at column 4
  assert.equal(F.lineHtml([['s', '"ab'], ['', '\tc"']]).replace(/<[^>]+>/g, ''), '&quot;ab⇥c&quot;', 'one column left to the stop: the tab is its mark alone');
  assert.equal(F.lineHtml([['', 'ab'], ['c', '\t// x']]).replace(/<[^>]+>/g, ''), 'ab⇥ // x');
  assert.match(F.lineHtml([['', `a${ZWSP}b`]]), /a<span class="vc" title="Hidden here: a zero-width space\.">⟦U\+200B⟧<\/span>b/);
  assert.equal(F.lineHtml([['', '<script>']]), '&lt;script&gt;');
  assert.equal(F.lineHtml([]), '');
  assert.equal(F.visibleCols('abc'), 3);
  assert.equal(F.visibleCols('\tx'), 5);
  assert.equal(F.visibleCols(`a${ZWSP}`), 1 + '⟦U+200B⟧'.length);
  assert.deepEqual(F.splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(F.splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(F.splitLines(''), ['']);
  assert.deepEqual(F.splitLines('\n'), ['']);
  assert.deepEqual(F.splitLines('a\n\n'), ['a', '']);
});

test('the file view’s pure parts hold no raw hidden characters', () => {
  for (const f of ['../ui/files.js', './ui-files.test.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/[\n\t]/g, ' ');
    assert.deepEqual(hiddenParts(src).filter(p => p.hidden).map(p => p.text.codePointAt(0).toString(16)), [], f);
  }
});
