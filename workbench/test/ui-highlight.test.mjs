// The file view's gentle colouring (ui/highlight.js): comments, strings, numbers and keywords for the languages people
// keep in a repository, a line at a time, with the one state that carries from line to line (a block comment, a string
// that goes on). Anything else is plain, and nothing is ever lost: the parts of a line always join back into the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { langOf, tokenizeLine, LANGS } from '../ui/highlight.js';
import { hiddenParts } from '../ui/words.js';

/** The line's parts as "kind:text" (plain parts as their text alone), for short assertions. */
const show = (line, lang, state = '') => tokenizeLine(line, lang, state).parts.map(([k, t]) => (k ? `${k}:${t}` : t));
/** The kinds of every part whose text is `word`. */
const kindOf = (line, lang, word, state = '') => tokenizeLine(line, lang, state).parts.filter(([, t]) => t === word).map(([k]) => k);
const U = n => String.fromCodePoint(n);

test('a file’s language comes from its name; anything else is plain', () => {
  const cases = {
    'src/a.js': 'js', 'b.mjs': 'js', 'c.cjs': 'js', 'App.jsx': 'js', 'x.ts': 'js', 'View.tsx': 'js', 'y.mts': 'js',
    'package.json': 'json', '.babelrc.json': 'json', 'tsconfig.jsonc': 'json',
    'app.css': 'css', 'a.scss': 'css', 'b.less': 'css',
    'index.html': 'html', 'icon.svg': 'html', 'feed.xml': 'html',
    'main.py': 'py', 'types.pyi': 'py',
    'main.go': 'go', 'lib.rs': 'rust', 'Rakefile': 'ruby', 'app.rb': 'ruby', 'Gemfile': 'ruby',
    'Main.java': 'java', 'Main.kt': 'java', 'build.gradle.kts': 'java', 'App.scala': 'java',
    'a.c': 'c', 'a.h': 'c', 'b.cpp': 'c', 'c.hpp': 'c', 'Thing.m': 'c', 'Program.cs': 'cs', 'View.swift': 'swift',
    'run.sh': 'sh', 'setup.bash': 'sh', '.zshrc': 'sh', 'deploy.zsh': 'sh',
    'ci.yml': 'yaml', 'compose.yaml': 'yaml', 'Cargo.toml': 'toml', 'README.md': 'md', 'notes.markdown': 'md',
  };
  for (const [path, lang] of Object.entries(cases)) assert.equal(langOf(path), lang, path);
  for (const path of ['LICENSE', 'data.csv', 'image.png', 'Makefile', '.env', 'notes.txt', 'archive.tar.gz', '']) assert.equal(langOf(path), null, path);
  assert.equal(langOf('SRC/APP.JS'), 'js', 'in any case');
  // every language langOf names can be coloured
  for (const lang of new Set(Object.values(cases))) assert.ok(LANGS[lang], lang);
});

test('JavaScript and TypeScript: keywords, strings, numbers and comments', () => {
  assert.deepEqual(show('const total = 0; // the sum', 'js'), ['k:const', ' total = ', 'n:0', '; ', 'c:// the sum']);
  assert.deepEqual(show("import { query } from './query';", 'js'), ['k:import', ' { query } ', 'k:from', ' ', "s:'./query'", ';']);
  assert.deepEqual(kindOf('return "a \\" b";', 'js', '"a \\" b"'), ['s'], 'an escaped quote stays in its string');
  assert.deepEqual(kindOf('x = 0xff + 1_000 + 2.5e3 + 10n;', 'js', '0xff'), ['n']);
  assert.deepEqual(kindOf('x = 0xff + 1_000 + 2.5e3 + 10n;', 'js', '1_000'), ['n']);
  assert.deepEqual(kindOf('x = 0xff + 1_000 + 2.5e3 + 10n;', 'js', '2.5e3'), ['n']);
  assert.deepEqual(kindOf('x = 0xff + 1_000 + 2.5e3 + 10n;', 'js', '10n'), ['n']);
  assert.deepEqual(kindOf('const v2 = a1;', 'js', ' v2 = a1;'), [''], 'a digit inside a name is not a number');
  assert.deepEqual(kindOf('export async function exportInvoices(accountId: string): Promise<string> {', 'js', 'async'), ['k']);
  assert.deepEqual(kindOf('interface Invoice { total: number }', 'js', 'interface'), ['k'], 'TypeScript words too');
  assert.deepEqual(kindOf('const re = /a"b/g;', 'js', '/a"b/g'), ['s'], 'a regular expression, with a quote in it, is one part');
  assert.ok(!tokenizeLine('const half = a / 2 / b;', 'js').parts.some(([k]) => k === 's'), 'a division is not a regular expression');
  assert.deepEqual(kindOf('const empty = null, gone = undefined;', 'js', 'null'), ['n'], 'constants read as values');
});

test('a block comment and a template string carry on to the next line, and end where they end', () => {
  const a = tokenizeLine('/** Every invoice,', 'js');
  assert.deepEqual(a.parts, [['c', '/** Every invoice,']]);
  assert.ok(a.state, 'the comment goes on');
  const b = tokenizeLine(' * a batch at a time.', 'js', a.state);
  assert.deepEqual(b.parts, [['c', ' * a batch at a time.']]);
  assert.equal(b.state, a.state);
  const c = tokenizeLine(' */ const x = 1;', 'js', b.state);
  assert.deepEqual(c.parts.map(([k, t]) => k ? `${k}:${t}` : t), ['c: */', ' ', 'k:const', ' x = ', 'n:1', ';']);
  assert.equal(c.state, '', 'back to code');
  const t1 = tokenizeLine('const s = `first ${a}', 'js');
  assert.ok(t1.state, 'a template string goes on');
  const t2 = tokenizeLine('second` + 2;', 'js', t1.state);
  assert.deepEqual(t2.parts.map(([k, t]) => k ? `${k}:${t}` : t), ['s:second`', ' + ', 'n:2', ';']);
  assert.equal(t2.state, '');
  assert.equal(tokenizeLine('', 'js', a.state).state, a.state, 'an empty line keeps the state');
});

test('JSON: keys and values read apart; comments in JSON with comments', () => {
  assert.deepEqual(show('  "name": "storefront",', 'json'), ['  ', 'k:"name"', ': ', 's:"storefront"', ',']);
  assert.deepEqual(show('  "private": true, "n": -1.5', 'json'), ['  ', 'k:"private"', ': ', 'n:true', ', ', 'k:"n"', ': ', 'n:-1.5']);
  assert.deepEqual(show('  // a note', 'json'), ['  ', 'c:// a note']);
});

test('CSS: at-rules, numbers with their units, colours, strings and comments', () => {
  assert.deepEqual(kindOf('@media (max-width: 520px) {', 'css', '@media'), ['k']);
  assert.deepEqual(kindOf('@media (max-width: 520px) {', 'css', '520px'), ['n']);
  assert.deepEqual(kindOf('  color: #d2a650; content: "x";', 'css', '#d2a650'), ['n']);
  assert.deepEqual(kindOf('  color: #d2a650; content: "x";', 'css', '"x"'), ['s']);
  const c = tokenizeLine('/* the green board', 'css');
  assert.ok(c.state);
  assert.deepEqual(tokenizeLine('   (default) */ a {', 'css', c.state).parts[0], ['c', '   (default) */']);
});

test('HTML and XML: tag names, attribute values and comments, and quotes in text are text', () => {
  assert.deepEqual(show('<a href="/x" class=\'y\'>He said "hi"</a>', 'html'),
    ['<', 'k:a', ' href=', 's:"/x"', ' class=', "s:'y'", '>He said "hi"</', 'k:a', '>']);
  const c = tokenizeLine('<!-- the board,', 'html');
  assert.ok(c.state);
  assert.deepEqual(show(' drawn once --> <p>', 'html', c.state), ['c: drawn once -->', ' <', 'k:p', '>']);
  // a tag whose attributes go on to the next line
  const t = tokenizeLine('<button type="button"', 'html');
  assert.ok(t.state, 'still inside the tag');
  assert.deepEqual(show('  aria-label="Close">x</button>', 'html', t.state), ['  aria-label=', 's:"Close"', '>x</', 'k:button', '>']);
  assert.deepEqual(kindOf('<!doctype html>', 'html', '!doctype'), ['k']);
});

test('Python: keywords, comments, prefixed strings and triple-quoted strings over lines', () => {
  assert.deepEqual(show('def total(items):  # in cents', 'py'), ['k:def', ' total(items):  ', 'c:# in cents']);
  assert.deepEqual(kindOf('x = f"{a}" + rb\'raw\'', 'py', 'f"{a}"'), ['s']);
  assert.deepEqual(kindOf('x = f"{a}" + rb\'raw\'', 'py', "rb'raw'"), ['s']);
  assert.deepEqual(kindOf('if x is None and not y:', 'py', 'None'), ['n']);
  assert.deepEqual(kindOf('if x is None and not y:', 'py', 'not'), ['k']);
  const a = tokenizeLine('    """Every invoice,', 'py');
  assert.ok(a.state);
  const b = tokenizeLine('    oldest first."""  # done', 'py', a.state);
  assert.deepEqual(b.parts.map(([k, t]) => k ? `${k}:${t}` : t), ['s:    oldest first."""', '  ', 'c:# done']);
  assert.equal(b.state, '');
});

test('Go, Rust and Ruby: raw strings over lines, lifetimes that are not characters, symbols', () => {
  assert.deepEqual(kindOf('func main() { fmt.Println("hi") }', 'go', 'func'), ['k']);
  const g = tokenizeLine('var q = `select *', 'go');
  assert.ok(g.state, 'a raw string goes on');
  assert.deepEqual(show('from invoices` // q', 'go', g.state), ['s:from invoices`', ' ', 'c:// q']);
  assert.deepEqual(kindOf("fn first<'a>(s: &'a str) -> char { 'x' }", 'rust', "'x'"), ['s']);
  assert.deepEqual(kindOf("fn first<'a>(s: &'a str) -> char { 'x' }", 'rust', 'fn'), ['k']);
  assert.ok(!tokenizeLine("fn first<'a>(s: &'a str) -> char { 'x' }", 'rust').parts.some(([k, t]) => k === 's' && t.includes('a>')), "a lifetime ('a) is not a string");
  const r = tokenizeLine('let s = r#"a "quoted"', 'rust');
  assert.ok(r.state);
  assert.deepEqual(show('word"#;', 'rust', r.state), ['s:word"#', ';']);
  assert.deepEqual(kindOf('def total; end # sum', 'ruby', 'def'), ['k']);
  assert.deepEqual(kindOf('def total; end # sum', 'ruby', '# sum'), ['c']);
  assert.deepEqual(kindOf('attr :name, "x"', 'ruby', ':name'), ['n']);
});

test('Java, Kotlin, C, C# and Swift: their words, preprocessor lines, and multi-line strings', () => {
  assert.deepEqual(kindOf('public static void main(String[] args) {', 'java', 'public'), ['k']);
  assert.deepEqual(kindOf('val name: String = "x"', 'java', 'val'), ['k'], 'Kotlin');
  const k = tokenizeLine('val s = """first', 'java');
  assert.ok(k.state);
  assert.deepEqual(show('last""".trim()', 'java', k.state), ['s:last"""', '.trim()']);
  assert.deepEqual(show('#include <stdio.h>', 'c'), ['k:#include', ' ', 's:<stdio.h>']);
  assert.deepEqual(kindOf("char c = 'a'; int n = 42;", 'c', "'a'"), ['s']);
  assert.deepEqual(kindOf('namespace Shop { class Cart { } }', 'cs', 'namespace'), ['k']);
  assert.deepEqual(kindOf('guard let x = y else { return }', 'swift', 'guard'), ['k']);
});

test('shell: comments that start a word, never inside one or after a $', () => {
  assert.deepEqual(show('echo "$#" ${#list} a#b # count', 'sh'), ['echo ', 's:"$#"', ' ${#list} a#b ', 'c:# count']);
  assert.deepEqual(kindOf('if [ -f x ]; then exit 1; fi', 'sh', 'then'), ['k']);
  assert.deepEqual(kindOf("cp 'a b' c", 'sh', "'a b'"), ['s']);
});

test('YAML and TOML: keys, tables, comments, strings and values', () => {
  assert.deepEqual(show('  name: "ci" # the pipeline', 'yaml'), ['  ', 'k:name', ': ', 's:"ci"', ' ', 'c:# the pipeline']);
  assert.deepEqual(show('- run: npm test', 'yaml'), ['- ', 'k:run', ': npm test']);
  assert.deepEqual(kindOf('  enabled: true', 'yaml', 'true'), ['n']);
  assert.ok(!tokenizeLine('url: http://x#y', 'yaml').parts.some(([k]) => k === 'c'), 'a # inside a word is not a comment');
  assert.deepEqual(show('[package]', 'toml'), ['k:[package]']);
  assert.deepEqual(show('version = "0.2.0" # ours', 'toml'), ['k:version', ' = ', 's:"0.2.0"', ' ', 'c:# ours']);
  const t = tokenizeLine('notes = """first', 'toml');
  assert.ok(t.state);
  assert.deepEqual(show('last"""', 'toml', t.state), ['s:last"""']);
});

test('Markdown: headings stand out, the rest is plain', () => {
  assert.deepEqual(show('# Storefront', 'md'), ['h:# Storefront']);
  assert.deepEqual(show('### Run it', 'md'), ['h:### Run it']);
  assert.deepEqual(show('Run `npm test` before you merge.', 'md'), ['Run `npm test` before you merge.']);
  assert.deepEqual(show('#hashtag is not a heading', 'md'), ['#hashtag is not a heading']);
});

test('nothing is ever lost: a line’s parts join back into it, in every language, whatever the state', () => {
  const lines = [
    '', '   ', 'const s = `a${b}c` + "d\\"e" + \'f\' // g', '/* a */ b /* c', '*/ "unterminated', "x = 'it''s'", 'a\\', '#!/bin/sh', '<<<>>>',
    'let r = /[a-z/]+/i.test(x) / 2;', '"""', "'''", '`', '-->', '<!--', 'r#"', '=begin', '=end', '@media screen', '[[bin]]', 'key = 1979-05-27',
    `tab\there${U(0x200b)}zero${U(0x202e)}rlo`, '😀 emoji 🇬🇧 flag', '\\', '"\\', "'", '\'\\\'', '#', '//', '/*', '*/', '0x', '1e', '.5', '-', 'a-b-c',
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const alphabet = ['a', ' ', '\t', '"', "'", '`', '/', '*', '#', '<', '>', '!', '-', '=', '0', '9', '.', 'x', '\\', '$', '{', '}', '(', ')', ':', 'r', 'def', 'const', '"""', '<!--', '-->', '*/', '/*'];
  for (let i = 0; i < 400; i++) lines.push(Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
  for (const lang of [...Object.keys(LANGS), 'nope']) {
    let state = '';
    for (const line of lines) {
      const r = tokenizeLine(line, lang, state);
      assert.equal(r.parts.map(p => p[1]).join(''), line, `${lang}: ${JSON.stringify(line)} from ${JSON.stringify(state)}`);
      for (const [k, t] of r.parts) {
        assert.ok(['', 'k', 's', 'n', 'c', 'h'].includes(k), `${lang}: a known kind (${k})`);
        assert.ok(t.length > 0, `${lang}: no empty part`);
      }
      assert.equal(typeof r.state, 'string');
      state = r.state;
    }
  }
});

test('plain for a language it does not know, and fast enough for a file of 25,000 lines', () => {
  assert.deepEqual(tokenizeLine('anything at all', null).parts, [['', 'anything at all']]);
  assert.deepEqual(tokenizeLine('anything at all', 'nope').parts, [['', 'anything at all']]);
  const line = "  const invoices = await query(accountId, { order: 'date' }); // " + 'x'.repeat(40);
  const t0 = performance.now();
  let state = '';
  for (let i = 0; i < 25000; i++) state = tokenizeLine(line, 'js', state).state;
  assert.ok(performance.now() - t0 < 2500, 'well under the time a person waits');
});

test('the highlighter’s source holds no raw hidden characters', () => {
  for (const f of ['../ui/highlight.js', './ui-highlight.test.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/[\n\t]/g, ' ');
    assert.deepEqual(hiddenParts(src).filter(p => p.hidden).map(p => p.text.codePointAt(0).toString(16)), [], f);
  }
});
