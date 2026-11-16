// The board's input (ui/saybox.js): a box that grows with its text, a few lines at most and never over the lid's words,
// then scrolls inside. Enter sends; Shift+Enter adds a line; pasted text keeps its lines, all the way to what is sent.
// With stand-ins for the textarea and the bar: a line is 18 px, and the text needs one line per "\n"-separated line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sayKey, boxHeight, setupSayBox, SAY_LINES } from '../ui/saybox.js';

const LINE = 18;

/** A textarea and its bar, as far as the box uses them; `type` is the browser putting text in, as a key or a paste does. */
function stand() {
  const on = {};
  const props = {};
  const field = {
    value: '',
    style: {},
    get scrollHeight() { return Math.max(parseFloat(this.style.height) || LINE, this.value.split('\n').length * LINE); },
    addEventListener: (type, fn) => { (on[type] ||= []).push(fn); },
  };
  const bar = { style: { setProperty: (k, v) => { props[k] = v; } } };
  const sent = [];
  const box = setupSayBox({ field, bar, send: text => sent.push(text), lineHeight: () => LINE });
  const fire = (type, e = {}) => {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...e };
    for (const fn of on[type] || []) fn(ev);
    return ev;
  };
  const type = text => { field.value += text; fire('input'); };
  const key = (k, mods = {}) => {
    const ev = fire('keydown', { key: k, ...mods });
    // what the browser does with a key nobody stopped: Enter and Shift+Enter put a line break in a textarea
    if (!ev.defaultPrevented && k === 'Enter') type('\n');
    return ev;
  };
  return { field, props, sent, box, type, key };
}

test('Enter sends what is in the box; Shift+Enter adds a line and sends nothing', () => {
  const s = stand();
  s.type('fix the login');
  s.key('Enter', { shiftKey: true });
  s.type('it fails on Safari');
  assert.deepEqual(s.sent, []);
  assert.equal(s.field.value, 'fix the login\nit fails on Safari');
  const enter = s.key('Enter');
  assert.equal(enter.defaultPrevented, true, 'Enter never puts a line break in the box');
  assert.deepEqual(s.sent, ['fix the login\nit fails on Safari']);
});

test('which keys send: Enter alone, and not while an input method is still choosing a word', () => {
  assert.equal(sayKey({ key: 'Enter' }), 'send');
  for (const e of [{ key: 'Enter', shiftKey: true }, { key: 'Enter', altKey: true }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true },
    { key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'a' }, { key: ' ' }, null, undefined]) {
    assert.equal(sayKey(e), null, JSON.stringify(e));
  }
});

test('pasted text keeps its lines: the box grows to show them, and they are sent as they were', () => {
  const s = stand();
  s.type('The checkout page throws this:\nTypeError: total is undefined\n    at render (cart.js:12:5)');
  assert.equal(s.field.style.height, `${3 * LINE}px`);
  assert.equal(s.props['--say-extra'], `${2 * LINE}px`, 'the bar grows by the two more lines');
  assert.equal(s.field.style.overflowY, 'hidden');
  s.key('Enter');
  assert.deepEqual(s.sent, ['The checkout page throws this:\nTypeError: total is undefined\n    at render (cart.js:12:5)']);
});

test('the box grows to a few lines, then scrolls inside; it never grows over the lid\'s words', () => {
  const s = stand();
  s.type('one');
  assert.deepEqual([s.field.style.height, s.props['--say-extra']], [`${LINE}px`, '0px'], 'one line: the box as it always was');
  s.type('\ntwo\nthree\nfour\nfive\nsix\nseven');
  assert.equal(s.field.style.height, `${SAY_LINES * LINE}px`, 'at most a few lines');
  assert.equal(s.field.style.overflowY, 'auto', 'then it scrolls inside');
  // the lid has room for one more line only: the box stops there and scrolls
  s.box.room(LINE + 4);
  assert.equal(s.field.style.height, `${2 * LINE}px`);
  assert.equal(s.props['--say-extra'], `${LINE}px`);
  // no room at all: one line that scrolls; emptied, it is one line again
  s.box.room(0);
  assert.equal(s.field.style.height, `${LINE}px`);
  assert.equal(s.box.room(0), null, 'the same room again fits nothing (the page renders often)');
  s.field.value = '';
  s.box.fit();
  assert.deepEqual([s.field.style.height, s.field.style.overflowY, s.props['--say-extra']], [`${LINE}px`, 'hidden', '0px']);
});

test('boxHeight: at least one line, at most a few and the room the lid leaves', () => {
  assert.deepEqual(boxHeight({ need: 18, line: 18 }), { height: 18, extra: 0, scroll: false });
  assert.deepEqual(boxHeight({ need: 54, line: 18 }), { height: 54, extra: 36, scroll: false });
  assert.deepEqual(boxHeight({ need: 200, line: 18 }), { height: 18 * SAY_LINES, extra: 18 * (SAY_LINES - 1), scroll: true });
  assert.deepEqual(boxHeight({ need: 54, line: 18, room: 20 }), { height: 36, extra: 18, scroll: true }); // whole lines only
  assert.deepEqual(boxHeight({ need: 54, line: 18, room: -5 }), { height: 18, extra: 0, scroll: true });
  assert.deepEqual(boxHeight({ need: 10, line: 18 }), { height: 18, extra: 0, scroll: false });
});

test('the page uses a textarea for the board\'s input, one line to begin with, and for the git screen\'s, one line high, that keeps a paste\'s lines', () => {
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea id="say" rows="1"[^>]*aria-label="Type what you want, or hold the space bar to talk"/);
  assert.match(html, /<textarea id="gitSay" rows="1" wrap="off"[^>]*aria-label="Type what you want\. It goes to Workbench, about the agent shown here\."/);
  assert.doesNotMatch(html, /<input id="gitSay"/, 'an input would make a paste one line');
  const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /setupSayBox\(/, 'app.js wires the box');
  // the git screen's Enter is the board's: it sends, and Shift+Enter or an input method's Enter does not (sayKey)
  const git = readFileSync(new URL('../ui/gitscreen.js', import.meta.url), 'utf8');
  assert.match(git, /import \{ sayKey \} from '\.\/saybox\.js';/);
  assert.match(git, /el\.say\.addEventListener\('keydown', e => \{ if \(sayKey\(e\) === 'send'\) \{ e\.preventDefault\(\); send\(\); \} \}\);/);
  // one line high, never resized by hand, and its lines not wrapped into more
  const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');
  const rule = /#gitSay \{([^}]*)\}/.exec(css)?.[1] || '';
  for (const part of ['height: 1.4em', 'line-height: 1.4', 'resize: none', 'overflow: hidden', 'white-space: pre']) assert.ok(rule.includes(part), part);
});

test('the input bar shows its focus ring in every look: the ivory look\'s own border does not hide it', () => {
  const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');
  assert.match(css, /#bar:focus-within \{[^}]*inset 0 0 0 2px var\(--lid-focus\)/);
  // the ivory look sets the bar's own border with a stronger selector, so its focus ring needs one as strong
  assert.match(css, /:root\[data-theme="ivory"\] #bar \{/);
  assert.match(css, /:root\[data-theme="ivory"\] #bar:focus-within \{[^}]*inset 0 0 0 2px var\(--lid-focus\)/);
  // and so does its quieter border while the board is at rest (#core.idle), as strong again
  assert.match(css, /:root\[data-theme="ivory"\] #core\.idle #bar \{/);
  assert.match(css, /:root\[data-theme="ivory"\] #core\.idle #bar:focus-within \{[^}]*inset 0 0 0 2px var\(--focus\)/);
});
