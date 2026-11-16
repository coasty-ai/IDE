// Contrast of every text colour on the surface it sits on, in all three looks (WCAG 2.x): text needs 4.5:1,
// marks and lines 3:1. The colours are read from ui/app.css, so the check follows the palettes as they change.
//   node scripts/ui-contrast.mjs [--all]      prints the failures (or every pair with --all); exits 1 on a failure
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const THEMES = ['green', 'black-gold', 'ivory'];

// [foreground, background, what it is, minimum]
export const PAIRS = [
  // silkscreen on the board's mask (its centre, middle and edge)
  ...['mask-1', 'mask-2', 'mask-3'].flatMap(bg => [
    ['silk', bg, 'silkscreen: brand, spend, machine names, helper names'],
    ['silk-2', bg, 'quiet silkscreen: notes, the hint, YOU, helper doing-words'],
    ['t-need', bg, "a helper's 'needs your OK' beside it"],
    ['t-stuck', bg, "'reconnecting…' and 'might be stuck' words"],
    ['lit', bg, 'a lit line', 3],
  ]),
  ['pad-n-ink', 'pad-n-fill', 'numbers 2 and up on outlined queue pads'],
  ['pad-1-ink', 'pad-1', 'number 1 on its filled pad'],
  // chips
  ...['chip-1', 'chip-2'].flatMap(bg => [
    ['chip-ink', bg, 'chip name'], ['chip-ink-2', bg, 'chip status words'],
    ['t-need', bg, 'needs-you words on a chip'], ['t-stuck', bg, 'might-be-stuck words on a chip'], ['t-fail', bg, 'failed words on a chip'],
    ['t-work', bg, 'working mark', 3], ['t-ok', bg, 'done mark', 3], ['t-word', bg, 'says-done mark', 3], ['t-sleep', bg, 'asleep mark', 3],
  ]),
  ['ghost-ink', 'ghost', 'name on a powered-down chip'], ['ghost-ink-2', 'ghost', 'status on a powered-down chip'],
  ['t-fail', 'ghost', 'failed words on a powered-down chip'], ['t-ok', 'ghost', 'done mark on a powered-down chip', 3],
  // the core's lid
  ...['lid-1', 'lid-2', 'lid-3'].flatMap(bg => [
    ['lid-ink', bg, 'the sentence'], ['lid-ink-2', bg, 'the count line, quiet links'], ['lid-ink-3', bg, 'the meta line, the reason'],
  ]),
  ...['k-need', 'k-stuck', 'k-ok', 'k-work', 'k-word', 'k-fail'].map(k => [k, 'lid-3', `${k} mark on the lid`, 3]),
  ['field-ink', 'field', 'typed text'], ['field-ph', 'field', 'the input hint'],
  ['exact-ink', 'exact', 'the exact command'],
  ['btn-ink', 'btn-1', 'an answer button'], ['btn-ink', 'btn-2', 'an answer button, lower half'], ['btn-pri-ink', 'btn-pri', 'the first answer'],
  ...['idle-1', 'idle-2'].flatMap(bg => [['idle-ink', bg, 'the idle sentence'], ['idle-ink-2', bg, 'the idle count line'], ['idle-ink-3', bg, 'the idle meta line']]),
  ['idle-ph', 'idle-field', 'the idle input hint'], ['idle-ok', 'idle-2', 'the all-clear mark', 3],
  // the card and the menus
  ...['card-1', 'card-2'].flatMap(bg => [
    ['card-ink', bg, 'card text'], ['card-ink-2', bg, 'card labels'], ['card-sub', bg, 'card sub line and notes'], ['c-fail', bg, 'a failed last step'],
    ['c-need', bg, 'needs-you mark', 3], ['c-stuck', bg, 'stuck mark', 3], ['c-ok', bg, 'done mark', 3], ['c-work', bg, 'working mark', 3], ['c-word', bg, 'says-done mark', 3],
  ]),
  // focus rings drawn on card surfaces (the git detail, the menus)
  ...['card-1', 'card-2'].map(bg => ['card-focus', bg, 'a focus ring on a card surface', 3]),
  // the diff in the git screen's detail
  ['card-ink', 'd-add-bg', 'an added line'], ['card-ink', 'd-del-bg', 'a removed line'], ['card-ink', 'd-hunk-bg', 'a hunk line'],
  ['card-sub', 'd-hunk-bg', 'quiet words on a hunk line'],
  ['d-add-mk', 'd-add-bg', 'the + mark of an added line', 3], ['d-del-mk', 'd-del-bg', 'the − mark of a removed line', 3],
  ...['card-1', 'card-2'].map(bg => ['d-del-mk', bg, 'the marks that show hidden characters in the diff and the detail (.vc text)']),
  // the git graph's traces on the board
  ...['mask-1', 'mask-2', 'mask-3'].flatMap(bg => [['g-trunk', bg, 'your branch, the gold trunk', 3], ['g-lane', bg, "an agent's lane", 3]]),
  // Agents & keys: the connect panel, on the lid's surface (the marks on lid-3 are the lid's own pairs above), its fields
  // and the keys warning's well; and its button in the top band, on the board's mask
  ...['k-need', 'k-ok', 'k-work', 'k-word'].flatMap(k => ['lid-1', 'lid-2'].map(bg => [k, bg, `${k} mark on the connect panel`, 3])),
  ...['lid-1', 'lid-2', 'lid-3', 'field'].map(bg => ['lid-focus', bg, 'a focus ring on the connect panel', 3]),
  ['k-need', 'exact', 'the needs-you mark by the keys warning', 3],
  ...['mask-1', 'mask-2', 'mask-3'].map(bg => ['t-ok', bg, 'the Agents & keys light when an agent is ready', 3]),
  ...['mask-1', 'mask-2', 'mask-3'].map(bg => ['focus', bg, 'a focus ring on the board', 3]),
  // the file view: the code and its colours on the page, on a changed line, on a line briefly marked, and selected; the
  // line numbers; a hidden character's mark; the gold bar of a changed line (and the caret, and the page's keyboard line);
  // the finder's rows, the row chosen, and the marks beside them; the lid's focus ring on the page
  ...['fv-page', 'fv-chg', 'fv-fresh'].flatMap(bg => [
    ['lid-ink', bg, `code on the file view (${bg})`], ['fv-no', bg, `line numbers (${bg})`], ['fv-vc', bg, `a hidden character shown in a file (${bg})`],
    ...['fv-k', 'fv-s', 'fv-n', 'fv-c', 'fv-h'].map(k => [k, bg, `${k}: the file view's gentle colours (${bg})`]),
  ]),
  ['lid-ink', 'fv-sel', 'code that is selected'],
  ...['fv-page', 'fv-chg'].map(bg => ['fv-bar', bg, `the gold bar of a changed line, and the caret (${bg})`, 3]),
  ...['fv-page', 'fv-on'].flatMap(bg => [['lid-ink', bg, `a file in the finder (${bg})`], ['lid-ink-2', bg, `a line found, a group's name (${bg})`], ['lid-ink-3', bg, `a folder after a file's name, "and 4 more in export.ts" (${bg})`],
    ...['k-need', 'k-stuck', 'k-ok', 'k-work', 'k-word', 'k-fail'].map(k => [k, bg, `${k} mark beside a file (${bg})`, 3])]),
  ['lid-focus', 'fv-page', 'a focus ring on the file view’s page', 3],
  // "Saved" in the sheet's head, which sits at the top of its surface (lid-1)
  ['fv-ok', 'lid-1', '"Saved" in the file view’s head'],
];

const hex = h => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = h => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** The custom properties of each look, from app.css (green is also the default :root). */
export function palettes(css) {
  const out = {};
  // Every block whose selector is exactly `sel`, merged in order (a later one wins, as in the cascade): a look's
  // colours may be set in more than one block (the git screen adds its own).
  const block = sel => {
    const vars = {};
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of css.matchAll(new RegExp(`(^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g'))) {
      for (const v of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
    }
    return vars;
  };
  const green = block(':root, :root[data-theme="green"]');
  out.green = green;
  out['black-gold'] = { ...green, ...block(':root[data-theme="black-gold"]') };
  out.ivory = { ...green, ...block(':root[data-theme="ivory"]') };
  return out;
}

const resolve = (vars, name, depth = 0) => {
  const v = vars[name];
  if (v == null) return null;
  const m = /^var\(--([\w-]+)\)$/.exec(v);
  return m && depth < 5 ? resolve(vars, m[1], depth + 1) : v;
};

/** Every pair in every look: { theme, fg, bg, what, min, ratio, ok }. A colour that is not a plain hex fails. */
export function contrastReport(css) {
  const pal = palettes(css), rows = [];
  for (const theme of THEMES) {
    for (const [fg, bg, what, min = 4.5] of PAIRS) {
      const f = resolve(pal[theme], fg), b = resolve(pal[theme], bg);
      const plain = c => typeof c === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c);
      const r = plain(f) && plain(b) ? ratio(f, b) : 0;
      rows.push({ theme, fg: `--${fg} ${f}`, bg: `--${bg} ${b}`, what, min, ratio: Math.round(r * 100) / 100, ok: r >= min });
    }
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');
  const rows = contrastReport(css);
  const all = process.argv.includes('--all');
  for (const r of rows) if (all || !r.ok) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.ratio.toFixed(2).padStart(5)}  ${r.theme.padEnd(10)} ${r.fg} on ${r.bg}  (${r.what}, needs ${r.min})`);
  const bad = rows.filter(r => !r.ok).length;
  const low = THEMES.map(t => `${t} ${Math.min(...rows.filter(r => r.theme === t && r.min === 4.5).map(r => r.ratio)).toFixed(2)}`).join(', ');
  console.log(bad ? `${bad} pair(s) below their minimum.` : `All ${rows.length} pairs pass. Lowest text pair per look: ${low}.`);
  process.exit(bad ? 1 : 0);
}
