import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageCommand, plainWords, loadPrefs, savePref, THEMES, DETAILS, DEFAULT_PREFS, PREF_KEYS } from '../ui/prefs.js';

test('the look and detail words the owner asked for change the page', () => {
  assert.deepEqual(pageCommand('black and gold'), { kind: 'theme', theme: 'black-gold' });
  assert.deepEqual(pageCommand('Black & gold.'), { kind: 'theme', theme: 'black-gold' });
  assert.deepEqual(pageCommand('ivory'), { kind: 'theme', theme: 'ivory' });
  assert.deepEqual(pageCommand('Ivory!'), { kind: 'theme', theme: 'ivory' });
  assert.deepEqual(pageCommand('green board'), { kind: 'theme', theme: 'green' });
  assert.deepEqual(pageCommand('switch to the green board please'), { kind: 'theme', theme: 'green' });
  assert.deepEqual(pageCommand('use ivory'), { kind: 'theme', theme: 'ivory' });
  assert.deepEqual(pageCommand('more detail'), { kind: 'detail', detail: 'more' });
  assert.deepEqual(pageCommand('More details'), { kind: 'detail', detail: 'more' });
  assert.deepEqual(pageCommand('less detail'), { kind: 'detail', detail: 'calm' });
  assert.deepEqual(pageCommand('fewer details please'), { kind: 'detail', detail: 'calm' });
});

test('stepping words are caught before they could become an answer', () => {
  for (const s of ['next', 'Next.', 'next one', 'show me the next one', 'skip this one']) assert.deepEqual(pageCommand(s), { kind: 'next' }, s);
  // "skip", "later" and "not now" can be real answers, so they still go to the engine
  for (const s of ['skip', 'later', 'not now', 'look later']) assert.equal(pageCommand(s), null, s);
});

test('anything else, including sentences that mention a colour, goes to the agents', () => {
  for (const s of ['make the login button green', 'green', 'start an agent to add an ivory theme', 'black', 'gold',
    'I want more detail in the error messages', 'more', 'details', 'yes', 'start an agent to fix the flaky checkout test', '', '   ']) {
    assert.equal(pageCommand(s), null, s);
  }
  assert.equal(pageCommand('ivory '.repeat(20)), null);
});

test('plainWords drops punctuation, filler and the switch-to wording', () => {
  assert.equal(plainWords('  Please, switch to Black-and-Gold!  '), 'black and gold');
  assert.equal(plainWords('OK show me the next one'), 'the next one');
});

test('the choice is kept in storage, and anything unknown falls back to the defaults', () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  assert.equal(savePref(storage, 'theme', 'ivory'), 'ivory');
  assert.equal(savePref(storage, 'detail', 'more'), 'more');
  assert.deepEqual(loadPrefs(storage), { theme: 'ivory', detail: 'more' });
  assert.equal(store.get(PREF_KEYS.theme), 'ivory');
  store.set(PREF_KEYS.theme, 'neon');
  assert.equal(loadPrefs(storage).theme, 'green');
  assert.equal(savePref(storage, 'theme', 'neon'), 'green');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadPrefs(broken), DEFAULT_PREFS);
  assert.equal(savePref(broken, 'detail', 'more'), 'more');
  assert.deepEqual(THEMES, ['green', 'black-gold', 'ivory']);
  assert.deepEqual(DETAILS, ['calm', 'more']);
});

test('boot.js accepts exactly the same looks and detail levels', async () => {
  const { readFileSync } = await import('node:fs');
  const boot = readFileSync(new URL('../ui/boot.js', import.meta.url), 'utf8');
  for (const t of THEMES) assert.match(boot, new RegExp(`'${t}'`));
  for (const d of DETAILS) assert.match(boot, new RegExp(`'${d}'`));
  assert.match(boot, new RegExp(PREF_KEYS.theme)); assert.match(boot, new RegExp(PREF_KEYS.detail));
});
