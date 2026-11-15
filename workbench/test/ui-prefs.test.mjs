import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageCommand, plainWords, pagePrefs, THEMES, DETAILS, PERMISSIONS, DEFAULT_PREFS } from '../ui/prefs.js';

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

test('the page reads its choices from what Workbench put on <html>, and anything unknown is the default', () => {
  assert.deepEqual(pagePrefs({ theme: 'ivory', detail: 'more', answered: '1', permissions: 'full' }), { theme: 'ivory', detail: 'more', answered: true, permissions: 'full' });
  assert.deepEqual(pagePrefs({ theme: 'black-gold', detail: 'calm', answered: '0', permissions: 'ask' }), { theme: 'black-gold', detail: 'calm', answered: false, permissions: 'ask' });
  assert.deepEqual(pagePrefs({ theme: 'neon', detail: 'everything', answered: 'yes', permissions: 'FULL' }), { ...DEFAULT_PREFS, answered: false, permissions: 'ask' });
  assert.deepEqual(pagePrefs({}), { ...DEFAULT_PREFS, answered: false, permissions: 'ask' });
  assert.deepEqual(pagePrefs(null), { ...DEFAULT_PREFS, answered: false, permissions: 'ask' });
  assert.deepEqual(THEMES, ['green', 'black-gold', 'ivory']);
  assert.deepEqual(DETAILS, ['calm', 'more']);
  assert.deepEqual(PERMISSIONS, ['ask', 'full']);
});

test('the page keeps no choice in its own storage: it reads them from <html> and saves a change through Workbench', () => {
  // The page's own storage belongs to its address, which changes from run to run and which another program may have
  // served before. test/prefs.test.mjs checks the server's side.
  const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /localStorage/);
  assert.match(app, /pagePrefs\(el\.html\.dataset\)/);
  assert.match(app, /api\.prefs\(\{ \[kind\]: v \}\)/);
  assert.match(app, /api\.prefs\(\{ answered: true \}\)/);
  const api = readFileSync(new URL('../ui/api.js', import.meta.url), 'utf8');
  assert.match(api, /prefs: change => call\('POST', '\/api\/prefs', change\)/);
});
