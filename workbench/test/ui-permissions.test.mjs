// The top band's Full permissions button (ui/permissions.js), and how the page wires it: the mode from the snapshot and
// from <html>, the press sent to the engine, and the button carrying the mode it was drawn for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { permButtonView, permissionMode } from '../ui/permissions.js';
import * as permissions from '../ui/permissions.js';

const read = (f) => readFileSync(new URL(`../ui/${f}`, import.meta.url), 'utf8');

test('the button is quiet while agents ask, and lit and pressed while full permissions are on', () => {
  assert.deepEqual(permButtonView('ask'), {
    state: 'ask', on: false, pressed: 'false', label: 'Full permissions', short: 'Full', name: 'Full permissions',
    title: 'Agents ask before risky steps. Press to let them run every step without asking.',
  });
  assert.deepEqual(permButtonView('full'), {
    state: 'full', on: true, pressed: 'true', label: 'Full permissions', short: 'Full', name: 'Full permissions',
    title: 'Full permissions are on: agents run every step without asking. Press to turn them off.',
  });
  // anything but full is ask: an unknown or missing mode never lights it
  for (const v of [undefined, null, '', 'FULL', 'on', true, 1, {}]) {
    assert.equal(permissionMode(v), 'ask', String(v));
    assert.equal(permButtonView(v).on, false, String(v));
  }
});

test('work starts with no card, so nothing is added to one while full permissions are on: the button shows the mode', () => {
  assert.equal(permissions.launchNote, undefined);
  assert.doesNotMatch(read('focus.js'), /permissions\.js|will not ask before any step/);
});

test('the band holds the button beside Agents & keys, with aria-pressed, hidden until the page is live', () => {
  const html = read('index.html');
  const btn = (/<button id="permBtn"[^>]*>/.exec(html) || [''])[0];
  assert.ok(btn, 'there is a Full permissions button');
  assert.match(btn, /type="button"/);
  assert.match(btn, / hidden/);
  assert.match(btn, /aria-pressed="false"/);
  assert.match(btn, /data-box="permbtn"/);
  assert.ok(html.indexOf('id="permBtn"') < html.indexOf('id="connectBtn"'), 'before Agents & keys, in the top band');
  assert.ok(html.indexOf('id="permBtn"') > html.indexOf('<header id="top">'));
  assert.match(html, /<html [^>]*data-permissions="ask"/);
});

test('the page learns the mode from <html> and from the snapshot, and a press goes to the engine, checked against what was drawn', () => {
  const app = read('app.js');
  const api = read('api.js');
  assert.match(api, /permissions: mode => call\('POST', '\/api\/permissions', \{ mode \}\)/);
  // from <html> before the first snapshot, then from each snapshot's meta and from answers that carry it
  assert.match(app, /permissions: prefs\.permissions/);
  assert.match(app, /modeIs\(snapMode\(snap, was\)\)/);
  assert.match(app, /if \(r\) modeIs\(r\.permissions\)/);
  // once the mode changes, a card that would turn them on goes: the engine withdrew it, or would refuse it
  assert.match(app, /if \(mode !== S\.meta\.permissions && S\.confirm\?\.kind === 'permissions'\) S\.confirm = null;/);
  // the button carries the mode it was drawn for, and a press for another mode sends nothing
  assert.match(app, /b\.dataset\.state = v\.state/);
  assert.match(app, /if \(b\.dataset\.state !== S\.meta\.permissions\) \{ changed\(\); return; \}/);
  assert.match(app, /api\.permissions\(drawn === 'full' \? 'ask' : 'full'\)/);
  assert.match(app, /setAttribute\('aria-pressed', v\.pressed\)/);
});

test('the button has its look before it shows, and a press while its own card is up keeps that card', () => {
  const app = read('app.js');
  const paint = app.slice(app.indexOf('function paintPermBtn('), app.indexOf('el.permBtn.addEventListener('));
  // lit or quiet before it is shown and measured, so a page that loads with full permissions on never fades it in
  const look = paint.indexOf("b.classList.toggle('on', v.on);");
  assert.ok(look > 0 && look < paint.indexOf('b.hidden = !live;') && look < paint.indexOf('offsetWidth'), 'the look comes first');
  assert.equal(paint.split("b.classList.toggle('on', v.on);").length, 2, 'set once');
  // its own card on screen: nothing is withdrawn or sent, nothing said, and the focus goes to the card
  const press = app.slice(app.indexOf('el.permBtn.addEventListener('), app.indexOf('setupConnect('));
  const own = press.indexOf("if (b.dataset.state !== 'full' && S.confirm?.kind === 'permissions') {");
  assert.ok(own > 0 && own < press.indexOf('api.confirm(') && own < press.indexOf('api.permissions('), 'kept before anything is sent');
  assert.match(press.slice(own, own + 200), /h1'\)\?\.focus\(\{ preventScroll: true \}\);\s*return;/);
});
