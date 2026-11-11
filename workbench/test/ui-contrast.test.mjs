import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastReport, palettes, THEMES, ratio } from '../scripts/ui-contrast.mjs';

const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');

test('every text colour clears 4.5:1, and every mark and lit line 3:1, on the surface it sits on, in all three looks', () => {
  const bad = contrastReport(css).filter(r => !r.ok).map(r => `${r.theme}: ${r.fg} on ${r.bg} is ${r.ratio} (${r.what}, needs ${r.min})`);
  assert.deepEqual(bad, []);
});

test('each look defines its own palette as custom properties', () => {
  const p = palettes(css);
  for (const t of THEMES) assert.ok(Object.keys(p[t]).length > 100, t);
  assert.notEqual(p.green['mask-2'], p['black-gold']['mask-2']);
  assert.notEqual(p.green['mask-2'], p.ivory['mask-2']);
  assert.notEqual(p.green['lid-1'], p.ivory['lid-1']);
});

test('the contrast arithmetic matches WCAG', () => {
  assert.equal(Math.round(ratio('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(Math.round(ratio('#777777', '#ffffff') * 100) / 100, 4.48);
});
