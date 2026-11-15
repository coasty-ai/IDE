// The line under the core (#said), and its copy on the git screen, show what Workbench just said: replies and notices.
// Those can name an agent's branch or its paths (a throw-away refused because its folder is on another branch now, a
// merge blocked by a file of yours), and an agent chooses those names. So characters that hide text or change the
// order it reads in must show by their code there (⟦U+202E⟧), as they do in the lid and the diff view.
// app.js runs only in the page, so its section "notices and the hint under the core" is run here on its own (node:vm),
// with the page's real text helpers and stand-ins for the board around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { visibleControls } from '../ui/words.js';
import { clipToLines } from '../ui/layout.js';
import { esc } from '../ui/util.js';
import { hasHidden } from '../ui/diffview.js';

const APP = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const RULE = '// ----------------------------------------------------------------';
const U = code => String.fromCharCode(code); // no hidden character is ever in this file raw

/** One section of app.js, from its heading to the next one. */
function section(title) {
  const start = APP.indexOf(`${RULE} ${title}\n`);
  assert.ok(start >= 0, `app.js has the section "${title}"`);
  const end = APP.indexOf(RULE, start + RULE.length);
  return APP.slice(start, end < 0 ? undefined : end);
}

/**
 * The notices section in a page of its own. `width` is the room the layout gives #said in pixels (every character is
 * 10 px wide here) and `lines` the lines it may take. say() returns what it stored, the line's HTML, and what the git
 * screen was given.
 */
function page({ width = 2000, lines = 3 } = {}) {
  const said = { dataset: {}, innerHTML: '' };
  const git = [];
  const sandbox = {
    visibleControls, clipToLines, esc,
    gitSay: text => git.push(text),
    G: { P: { silkSub: 12 }, said: { x: 0, y: 0, w: width, maxY: 400, lines } },
    measure: () => 10,
    el: { said },
    // the person's choices as Workbench put them on <html>: the hint under the core is not answered yet
    prefs: { theme: 'green', detail: 'calm', answered: false },
    needsQueue: () => [], linkNow: () => 'live',
    setTimeout: () => 0, clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(section('notices and the hint under the core'), sandbox);
  return {
    say(text) {
      sandbox.say(text);
      return { notice: vm.runInContext('notice', sandbox), html: said.innerHTML, git: git.at(-1) };
    },
  };
}

// Replies the real engine gave over HTTP and as an SSE notice (the review's runs against real git): the agent had moved
// its folder onto a branch named with a right-to-left override, or added notes<U+200B>.md where the person has one too.
const THROWN = `Fix cart total’s folder is on the branch workbench/fix-${U(0x202e)}txt.exe now, not on workbench/fix-cart-total-cb1b30.`;
const BLOCKED = `Your own changes are in the way: notes${U(0x200b)}.md. Commit or put them aside, then merge again.`;
const THROWN_SHOWN = 'Fix cart total’s folder is on the branch workbench/fix-⟦U+202E⟧txt.exe now, not on workbench/fix-cart-total-cb1b30.';
const BLOCKED_SHOWN = 'Your own changes are in the way: notes⟦U+200B⟧.md. Commit or put them aside, then merge again.';

test('a reply naming an agent’s branch or path shows its hidden and direction-changing characters by their code, on the board and on the git screen', () => {
  for (const [text, shown] of [[THROWN, THROWN_SHOWN], [BLOCKED, BLOCKED_SHOWN]]) {
    const r = page().say(text);
    assert.equal(r.notice, shown);
    assert.ok(r.html.includes(esc(shown)), r.html);
    assert.equal(hasHidden(r.html), false, 'nothing hidden is left raw on the board');
    assert.equal(r.git, shown, 'the git screen gets the same words');
  }
});

test('a notice cut to fit keeps the characters visible in what it shows and in all of it for screen readers', () => {
  const r = page({ width: 300, lines: 1 }).say(`${THROWN} ${BLOCKED}`);
  const all = `${THROWN_SHOWN} ${BLOCKED_SHOWN}`;
  assert.match(r.html, /^<span aria-hidden="true">[^<]+…<\/span><span class="sr">/, 'it was cut');
  assert.ok(r.html.includes(`<span class="sr">${esc(all)}</span>`), r.html);
  assert.ok(r.html.includes('⟦U+202E⟧'), 'the cut part still shows the override');
  assert.equal(hasHidden(r.html), false);
  assert.equal(r.git, all);
});

test('line breaks and runs of spaces become one space; every other hidden character is shown, even at either end', () => {
  const p = page();
  assert.equal(p.say('Merged into main.\n\tYour folder  is as it was.\r\n').notice, 'Merged into main. Your folder is as it was.');
  // JavaScript's \s and trim() would take these for spaces: here they are shown, as the spec asks for U+FEFF
  const r = p.say(`${U(0xfeff)}notes${U(0x2028)}a ${U(0x2066)}b${U(0x2029)}c\x1bd${U(0xfeff)}`);
  assert.equal(r.notice, '⟦U+FEFF⟧notes⟦U+2028⟧a ⟦U+2066⟧b⟦U+2029⟧c␛d⟦U+FEFF⟧');
  assert.equal(hasHidden(r.html), false);
  assert.equal(r.git, r.notice);
  // nothing but spaces says nothing
  for (const empty of [' \n\t ', '', null, undefined]) {
    const e = p.say(empty);
    assert.equal(e.notice, null, JSON.stringify(empty));
    assert.equal(e.git, null);
    assert.equal(e.html, '');
  }
});

test('every reply and notice reaches the line under the core and the git screen only through say()', () => {
  // the page itself must have it: here it is handed in, which would hide a missing import
  assert.ok(/^import \{[^}]*\bvisibleControls\b[^}]*\} from '\.\/words\.js';/m.test(APP), 'app.js imports visibleControls');
  // a second writer of either line would bring raw text back: both are written from `notice`, in this section only
  assert.deepEqual([...APP.matchAll(/\bgitSay\(([^)]*)\)/g)].map(m => m[1]), ['notice'], 'the git screen is given only what say() kept');
  assert.equal(APP.split('el.said.innerHTML =').length - 1, 1, 'one writer of the line under the core');
  assert.equal(section('notices and the hint under the core').split('el.said.innerHTML =').length - 1, 1, 'and it is paintSaid');
});
