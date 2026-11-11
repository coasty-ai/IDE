import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { debugSwitches } from '../ui/address.js';

const OFF = { static: false, still: false, pin: null, focus: null };

test('debugSwitches: switches count only when the same address carries the key', () => {
  for (const s of ['', '?', '?say=yes', '?static=1', '?still=1&pin=first-root&focus=abc', '?t=&static=1', '?T=abc&static=1', '?static=1&t', undefined, null, 42]) {
    assert.deepEqual(debugSwitches(s), OFF, String(s));
  }
  assert.deepEqual(debugSwitches('?t=k&static=1&still=1&pin=first-root'), { static: true, still: true, pin: 'first-root', focus: null });
  assert.deepEqual(debugSwitches('?t=k&focus=abc123'), { static: false, still: false, pin: null, focus: 'abc123' });
  assert.deepEqual(debugSwitches('?static=1&t=k&pin=399e17-7a7143c0'), { static: true, still: false, pin: '399e17-7a7143c0', focus: null });
});

test('debugSwitches: never a command, and ids are plain', () => {
  assert.deepEqual(Object.keys(debugSwitches('?t=k&say=yes&static=1')).sort(), ['focus', 'pin', 'static', 'still']);
  assert.equal(debugSwitches('?t=k&pin=<img>').pin, null);
  assert.equal(debugSwitches('?t=k&focus=' + 'a'.repeat(200)).focus, null);
  assert.equal(debugSwitches('?t=k&static=0').static, false);
});

test('the page reads its address only through debugSwitches and the key, and nothing sends on load', () => {
  const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.equal(app.split('debugSwitches(location.search)').length - 1, 1, 'app.js calls debugSwitches(location.search) once');
  const rest = app.replace('debugSwitches(location.search)', '');
  assert.doesNotMatch(rest, /URLSearchParams|searchParams|location\.(search|href|hash)/);
  assert.doesNotMatch(app, /get\(\s*['"]say['"]\s*\)|debug\.say/, 'no say= parameter');
  // the switches are read before the key leaves the address bar
  assert.ok(app.indexOf('debugSwitches(location.search)') < app.indexOf('initToken()'));
  const api = readFileSync(new URL('../ui/api.js', import.meta.url), 'utf8');
  for (const m of api.matchAll(/searchParams\.(\w+)\(([^)]*)\)/g)) assert.equal(m[2], "'t'", `api.js reads only t= (${m[0]})`);
});
