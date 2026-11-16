// The person's choices for the page, kept by Workbench across runs in ~/.workbench/prefs.json (src/core/prefs.mjs):
// only the known keys and values, a 0600 file in a 0700 folder, and the page arriving with the look already on <html>.
// Every test works in a temporary folder that stands in for the home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  THEMES, DETAILS, PERMISSIONS, DEFAULT_PREFS, cleanPrefs, prefsChange, createPrefs, memoryPrefs, pageWithPrefs, privateFolder, prefsFile,
} from '../src/core/prefs.mjs';
import * as pagePrefs from '../ui/prefs.js';

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-prefs-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const modeOf = (p) => fs.statSync(p).mode & 0o777;
/** A log that keeps what it was told. */
function recorder() {
  const lines = [];
  const log = (level) => (...a) => lines.push(`${level} ${a.map(String).join(' ')}`);
  return { lines, log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') } };
}

test('the server knows exactly the looks, detail levels and permission modes the page knows', () => {
  assert.deepEqual([...THEMES], pagePrefs.THEMES);
  assert.deepEqual([...DETAILS], pagePrefs.DETAILS);
  assert.deepEqual([...PERMISSIONS], pagePrefs.PERMISSIONS);
  assert.deepEqual([...PERMISSIONS], ['ask', 'full']);
  assert.deepEqual({ theme: DEFAULT_PREFS.theme, detail: DEFAULT_PREFS.detail }, { ...pagePrefs.DEFAULT_PREFS });
  assert.equal(DEFAULT_PREFS.answered, false);
  assert.equal(DEFAULT_PREFS.permissions, 'ask', 'agents ask first unless the person turned full permissions on');
});

test('cleanPrefs keeps only known keys with known values; anything else is the default', () => {
  assert.deepEqual(cleanPrefs(null), { theme: 'green', detail: 'calm', answered: false, permissions: 'ask' });
  assert.deepEqual(cleanPrefs({ theme: 'ivory', detail: 'more', answered: true, permissions: 'full' }), { theme: 'ivory', detail: 'more', answered: true, permissions: 'full' });
  assert.deepEqual(cleanPrefs({ theme: 'neon', detail: 'MORE', answered: 'yes', token: 'x'.repeat(40), __proto__: { theme: 'ivory' } }),
    { theme: 'green', detail: 'calm', answered: false, permissions: 'ask' });
  assert.deepEqual(cleanPrefs(['ivory']), DEFAULT_PREFS);
  assert.deepEqual(Object.keys(cleanPrefs({ extra: 1 })), ['theme', 'detail', 'answered', 'permissions']);
});

test('prefsChange takes a look, a detail level or "answered", and refuses anything else in plain words', () => {
  assert.deepEqual(prefsChange({ theme: 'black-gold' }), { theme: 'black-gold' });
  assert.deepEqual(prefsChange({ detail: 'more', answered: true }), { detail: 'more', answered: true });
  // names it does not know are never kept
  assert.deepEqual(prefsChange({ theme: 'ivory', colour: 'red', path: '/etc/passwd' }), { theme: 'ivory' });
  const refused = (body) => {
    try { prefsChange(body); } catch (e) { return e; }
    return null;
  };
  for (const body of [{}, { colour: 'red' }, null, 'ivory', []]) {
    const e = refused(body);
    assert.ok(e, JSON.stringify(body));
    assert.equal(e.status, 400);
    assert.equal(e.message, 'Say which look or detail level to keep.');
  }
  for (const body of [{ theme: 'neon' }, { theme: '' }, { theme: 3 }, { theme: 'ivory', detail: 'all' }, { answered: false }, { answered: 'true' }]) {
    const e = refused(body);
    assert.ok(e, JSON.stringify(body));
    assert.equal(e.status, 400);
    assert.match(e.message, /^Workbench (has no such look|has no such detail level|keeps only that you have answered once)\.$/, JSON.stringify(body));
  }
});

test('the store starts at the defaults, then keeps each choice in a 0600 file inside a new 0700 folder', (t) => {
  const h = home(t);
  const file = prefsFile(h);
  assert.equal(file, path.join(h, '.workbench', 'prefs.json'));
  const prefs = createPrefs({ file });
  assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  assert.equal(fs.existsSync(path.join(h, '.workbench')), false, 'reading makes nothing');
  assert.deepEqual(prefs.set({ theme: 'ivory' }), { ok: true, prefs: { theme: 'ivory', detail: 'calm', answered: false, permissions: 'ask' } });
  assert.equal(modeOf(path.join(h, '.workbench')), 0o700);
  assert.equal(modeOf(file), 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'ivory', detail: 'calm', answered: false, permissions: 'ask' });
  prefs.set({ detail: 'more' });
  prefs.set({ answered: true });
  assert.deepEqual(prefs.get(), { theme: 'ivory', detail: 'more', answered: true, permissions: 'ask' });
  // a new run reads them back
  assert.deepEqual(createPrefs({ file }).get(), { theme: 'ivory', detail: 'more', answered: true, permissions: 'ask' });
  // no temporary file is left beside it
  assert.deepEqual(fs.readdirSync(path.join(h, '.workbench')), ['prefs.json']);
});

test('a change made by another run is seen, and a save keeps what the other run saved', (t) => {
  const file = prefsFile(home(t));
  const a = createPrefs({ file });
  const b = createPrefs({ file });
  a.set({ theme: 'black-gold' });
  assert.equal(b.get().theme, 'black-gold');
  b.set({ detail: 'more' });
  assert.deepEqual(a.get(), { theme: 'black-gold', detail: 'more', answered: false, permissions: 'ask' });
});

test('an existing folder others could open is made 0700 when a choice is saved', (t) => {
  const h = home(t);
  fs.mkdirSync(path.join(h, '.workbench'), { mode: 0o755 });
  fs.chmodSync(path.join(h, '.workbench'), 0o755);
  createPrefs({ file: prefsFile(h) }).set({ theme: 'ivory' });
  assert.equal(modeOf(path.join(h, '.workbench')), 0o700);
});

test('a damaged, oversized, linked or strange file reads as the defaults, and is never followed or kept', (t) => {
  const h = home(t);
  const dir = path.join(h, '.workbench');
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = prefsFile(h);
  const prefs = createPrefs({ file });
  fs.writeFileSync(file, '{ not json', { mode: 0o600 });
  assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  fs.writeFileSync(file, JSON.stringify({ theme: 'ivory', detail: 'more', answered: true, pad: 'x'.repeat(300 * 1024) }), { mode: 0o600 });
  assert.deepEqual(prefs.get(), DEFAULT_PREFS, 'a file of more than 256 KB is not read');
  fs.writeFileSync(file, JSON.stringify({ theme: 'ivory', detail: 'more', answered: true, pad: 'x'.repeat(8000) }), { mode: 0o600 });
  assert.deepEqual(prefs.get(), { theme: 'ivory', detail: 'more', answered: true, permissions: 'ask' }, 'one of 8 KB is, without what it does not know');
  fs.writeFileSync(file, JSON.stringify({ theme: '<script>', detail: 'more', secret: 'kept?' }), { mode: 0o600 });
  assert.deepEqual(prefs.get(), { theme: 'green', detail: 'more', answered: false, permissions: 'ask' });
  // a link is never followed, for reading or writing: the save replaces the link with a file of its own
  fs.rmSync(file);
  const elsewhere = path.join(h, 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ theme: 'ivory' }));
  fs.symlinkSync(elsewhere, file);
  assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  prefs.set({ detail: 'more' });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(elsewhere, 'utf8')), { theme: 'ivory' }, 'the link’s target is untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'green', detail: 'more', answered: false, permissions: 'ask' });
  // a folder where the file should be
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(prefs.get(), DEFAULT_PREFS);
});

test('a choice that cannot be saved is logged, said plainly, and still lasts for this run', (t) => {
  const h = home(t);
  // ~/.workbench is a file, so nothing can be written under it
  fs.writeFileSync(path.join(h, '.workbench'), 'not a folder');
  const { lines, log } = recorder();
  const prefs = createPrefs({ file: prefsFile(h), log });
  const r = prefs.set({ theme: 'ivory' });
  assert.equal(r.ok, false);
  assert.equal(r.sentence, 'Workbench could not keep that choice for the next time it starts. The details are in its log.');
  assert.deepEqual(r.prefs, { theme: 'ivory', detail: 'calm', answered: false, permissions: 'ask' });
  assert.deepEqual(prefs.get(), { theme: 'ivory', detail: 'calm', answered: false, permissions: 'ask' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warn Workbench could not save the page’s choices/);
});

test('full permissions are one more known key, ask or full (ask by default), kept with the other choices and never changed from the page', (t) => {
  // only the two modes are ever read, written or sent
  for (const [raw, want] of [[{ permissions: 'full' }, 'full'], [{ permissions: 'ask' }, 'ask'], [{ permissions: 'FULL' }, 'ask'], [{ permissions: true }, 'ask'],
    [{ permissions: ' full' }, 'ask'], [{}, 'ask'], [null, 'ask']]) {
    assert.equal(cleanPrefs(raw).permissions, want, JSON.stringify(raw));
  }
  // the page's own route keeps looks and detail levels only: the mode is never turned on through it
  assert.throws(() => prefsChange({ permissions: 'full' }), { message: 'Say which look or detail level to keep.', status: 400 });
  assert.deepEqual(prefsChange({ theme: 'ivory', permissions: 'full' }), { theme: 'ivory' });
  // the engine saves it through the same store: the same file rules, and a look saved later keeps it
  const h = home(t);
  const file = prefsFile(h);
  const prefs = createPrefs({ file });
  assert.deepEqual(prefs.set({ permissions: 'full' }), { ok: true, prefs: { theme: 'green', detail: 'calm', answered: false, permissions: 'full' } });
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.join(h, '.workbench')), 0o700);
  prefs.set(prefsChange({ theme: 'ivory' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'ivory', detail: 'calm', answered: false, permissions: 'full' });
  assert.equal(createPrefs({ file }).get().permissions, 'full', 'a new run reads it back');
  prefs.set({ permissions: 'ask' });
  assert.equal(createPrefs({ file }).get().permissions, 'ask');
  // a value written by hand that is not one of the two is ask
  fs.writeFileSync(file, JSON.stringify({ theme: 'ivory', permissions: 'yes please' }), { mode: 0o600 });
  assert.equal(prefs.get().permissions, 'ask');
  // for one run only, with the same rules
  const m = memoryPrefs({ permissions: 'full' });
  assert.equal(m.get().permissions, 'full');
  assert.equal(m.set({ permissions: 'nope' }).prefs.permissions, 'ask');
});

test('agents’ copies: the repositories told about their env files, and the setup command each one said Run it to, are kept by root, merged with what another run saved', (t) => {
  const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64), H3 = 'c'.repeat(64);
  // only absolute roots and SHA-256 hashes are kept; the keys show only once they hold something
  assert.deepEqual(cleanPrefs({ copiesSaid: ['/r/a', 'relative', '/r/a', 7, '', '/r/\u0007bell', `/${'x'.repeat(1100)}`, '/r/b'] }).copiesSaid, ['/r/a', '/r/b']);
  assert.deepEqual(cleanPrefs({ setupOk: { '/r/a': H1, '/r/b': 'not a hash', relative: H2, '/r/c': H2.toUpperCase(), '/r/d': H3 } }).setupOk, { '/r/a': H1, '/r/d': H3 });
  for (const raw of [{ copiesSaid: 'x' }, { copiesSaid: [] }, { setupOk: [] }, { setupOk: null }, { setupOk: { '/r/a': 5 } }, { setupOk: { __proto__: { '/r/a': H1 } } }]) {
    assert.deepEqual(Object.keys(cleanPrefs(raw)), ['theme', 'detail', 'answered', 'permissions'], JSON.stringify(raw));
  }
  // at most 100 of each, the newest kept
  const many = Array.from({ length: 150 }, (_, i) => `/r/${i}`);
  assert.deepEqual(cleanPrefs({ copiesSaid: many }).copiesSaid, many.slice(50));
  assert.equal(Object.keys(cleanPrefs({ setupOk: Object.fromEntries(many.map(r => [r, H1])) }).setupOk).length, 100);

  const file = prefsFile(home(t));
  const a = createPrefs({ file });
  const b = createPrefs({ file });
  // each run adds to what the file holds when it saves, never over it
  assert.equal(a.set({ copiesSaid: ['/r/a'], setupOk: { '/r/a': H1 } }).ok, true);
  assert.equal(b.set({ copiesSaid: ['/r/b'], setupOk: { '/r/b': H2 } }).ok, true);
  assert.deepEqual(a.get().copiesSaid, ['/r/a', '/r/b']);
  assert.deepEqual(a.get().setupOk, { '/r/a': H1, '/r/b': H2 });
  // a changed command replaces that repository's hash; a root said again moves to the end, so the newest are kept
  a.set({ setupOk: { '/r/a': H3 }, copiesSaid: ['/r/a'] });
  assert.deepEqual(b.get().setupOk, { '/r/b': H2, '/r/a': H3 });
  assert.deepEqual(b.get().copiesSaid, ['/r/b', '/r/a']);
  // a look saved later keeps them, and the page's own choices stay as they were
  b.set(prefsChange({ theme: 'ivory' }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'ivory', detail: 'calm', answered: false, permissions: 'ask', copiesSaid: ['/r/b', '/r/a'], setupOk: { '/r/b': H2, '/r/a': H3 } });
  // the page never sets them, and never gets them
  assert.throws(() => prefsChange({ copiesSaid: ['/r/x'], setupOk: { '/r/x': H1 } }), { status: 400 });
  assert.equal(pageWithPrefs('<html>', a.get()), '<html data-theme="ivory" data-detail="calm" data-answered="0" data-permissions="ask">');
  // for one run only, with the same rules
  const m = memoryPrefs();
  m.set({ copiesSaid: ['/r/a'], setupOk: { '/r/a': H1 } });
  m.set({ copiesSaid: ['/r/b', 'relative'], setupOk: { '/r/b': H2 } });
  assert.deepEqual(m.get().copiesSaid, ['/r/a', '/r/b']);
  assert.deepEqual(m.get().setupOk, { '/r/a': H1, '/r/b': H2 });
});

test('agents’ copies: what could not be saved still counts for this run, merged the same way', (t) => {
  const h = home(t);
  fs.writeFileSync(path.join(h, '.workbench'), 'not a folder');
  const { log } = recorder();
  const prefs = createPrefs({ file: prefsFile(h), log });
  assert.equal(prefs.set({ copiesSaid: ['/r/a'] }).ok, false);
  assert.equal(prefs.set({ copiesSaid: ['/r/b'], setupOk: { '/r/b': 'd'.repeat(64) } }).ok, false);
  assert.deepEqual(prefs.get().copiesSaid, ['/r/a', '/r/b']);
  assert.deepEqual(prefs.get().setupOk, { '/r/b': 'd'.repeat(64) });
});

test('memoryPrefs keeps choices for one run only, with the same rules', () => {
  const m = memoryPrefs();
  assert.deepEqual(m.get(), DEFAULT_PREFS);
  assert.deepEqual(m.set({ theme: 'ivory', answered: true, permissions: 'ask' }), { ok: true, prefs: { theme: 'ivory', detail: 'calm', answered: true, permissions: 'ask' } });
  assert.deepEqual(m.get(), { theme: 'ivory', detail: 'calm', answered: true, permissions: 'ask' });
  assert.deepEqual(memoryPrefs({ detail: 'more', theme: 'neon' }).get(), { theme: 'green', detail: 'more', answered: false, permissions: 'ask' });
});

test('pageWithPrefs puts the look, the detail, "answered" and the permission mode on the <html> tag, and nothing else anywhere', () => {
  const page = '<!doctype html>\n<html lang="en" data-theme="green" data-detail="calm" class="boot">\n<head></head><body><p data-theme="green">x</p></body></html>';
  const out = pageWithPrefs(page, { theme: 'ivory', detail: 'more', answered: true });
  assert.equal(out, '<!doctype html>\n<html lang="en" data-theme="ivory" data-detail="more" class="boot" data-answered="1" data-permissions="ask">\n<head></head><body><p data-theme="green">x</p></body></html>');
  // attributes that are missing are added; the defaults when nothing is kept
  assert.equal(pageWithPrefs('<html><body></body></html>', DEFAULT_PREFS), '<html data-theme="green" data-detail="calm" data-answered="0" data-permissions="ask"><body></body></html>');
  // anything that is not a known value never reaches the page
  assert.equal(pageWithPrefs('<html data-theme="x">', { theme: '"><script>alert(1)</script>', detail: 'more', permissions: '"><b>' }), '<html data-theme="green" data-detail="more" data-answered="0" data-permissions="ask">');
  // a page without an <html> tag goes out as it is
  assert.equal(pageWithPrefs('<!doctype html><title>Workbench</title>', { theme: 'ivory' }), '<!doctype html><title>Workbench</title>');
  // only the first tag, and not a tag that merely starts with "html"
  assert.equal(pageWithPrefs('<htmlx a="1"><html lang="en">', { theme: 'ivory' }), '<htmlx a="1"><html lang="en" data-theme="ivory" data-detail="calm" data-answered="0" data-permissions="ask">');
  // any way of writing a value is replaced, never doubled (the first of two equal attributes is the one that counts)
  assert.equal(pageWithPrefs(`<html data-theme='ivory' data-themes="x" data-detail=more DATA-ANSWERED data-permissions=full>`, { theme: 'black-gold' }),
    '<html data-theme="black-gold" data-themes="x" data-detail="calm" data-answered="0" data-permissions="ask">');
  assert.equal(pageWithPrefs('<html lang="a>b">', { detail: 'more' }), '<html lang="a>b" data-theme="green" data-detail="more" data-answered="0" data-permissions="ask">');
  // full permissions, when the server says they are on
  assert.equal(pageWithPrefs('<html lang="en" data-permissions="ask">', { permissions: 'full' }), '<html lang="en" data-permissions="full" data-theme="green" data-detail="calm" data-answered="0">');
});

test('the real page carries the attributes the server sets, and no longer loads boot.js', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const tag = (s) => (/<html\b[^>]*>/.exec(s) || [''])[0];
  assert.equal(tag(html), '<html lang="en" data-theme="green" data-detail="calm" data-answered="0" data-permissions="ask" class="boot">');
  assert.ok(!html.includes('boot.js'), 'index.html loads no boot.js');
  assert.equal(fs.existsSync(new URL('../ui/boot.js', import.meta.url)), false);
  const served = pageWithPrefs(html, { theme: 'black-gold', detail: 'more', answered: true, permissions: 'full' });
  assert.equal(tag(served), '<html lang="en" data-theme="black-gold" data-detail="more" data-answered="1" data-permissions="full" class="boot">');
  assert.equal(served.replace(tag(served), ''), html.replace(tag(html), ''), 'nothing else in the page changes');
});

test('privateFolder: made 0700 when missing, made 0700 when others could open it, a link to a folder of ours followed', (t) => {
  const h = home(t);
  const dir = path.join(h, '.workbench');
  assert.equal(privateFolder(dir, { create: false }), false, 'missing, and not made');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(privateFolder(dir), true);
  assert.equal(modeOf(dir), 0o700);
  fs.chmodSync(dir, 0o755);
  assert.equal(privateFolder(dir, { create: false }), true);
  assert.equal(modeOf(dir), 0o700);
  // ~/.workbench may be a link to a folder of the person's (kept on another disk, say): its target is made private
  const real = path.join(h, 'real-workbench');
  fs.mkdirSync(real, { mode: 0o755 });
  fs.chmodSync(real, 0o755);
  const link = path.join(h, 'linked');
  fs.symlinkSync(real, link);
  assert.equal(privateFolder(link, { create: false }), true);
  assert.equal(modeOf(real), 0o700);
  // a file is not a folder: nothing is changed
  const file = path.join(h, 'a-file');
  fs.writeFileSync(file, 'x', { mode: 0o644 });
  assert.equal(privateFolder(file, { create: false }), false);
  assert.equal(modeOf(file), 0o644);
});
