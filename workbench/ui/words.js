// Shaping text for small spaces. Pure: no DOM, no imports (node:test loads it).

const PICTURES = { '\n': '⏎', '\t': '⇥', '\r': '␍', '\x7f': '␡' };

/** Control characters shown as visible symbols, so a command can never hide a line break or a tab. */
export function visibleControls(s) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f]/g, c => PICTURES[c] || String.fromCharCode(0x2400 + c.charCodeAt(0)));
}

/**
 * A long command or path, shortened in the middle: the start, a visible " … ", and the end (where "| sh" would be).
 * @returns {{ text: string, clipped: boolean }}
 */
export function clipMiddle(s, max = 160) {
  const t = Array.from(String(s ?? ''));
  if (t.length <= max) return { text: t.join(''), clipped: false };
  const head = Math.ceil(max * 0.62), tail = Math.max(12, max - head - 3);
  return { text: t.slice(0, head).join('').trimEnd() + ' … ' + t.slice(-tail).join('').trimStart(), clipped: true };
}

/** "Search cleanup asks · 2 of 3" in at most `max` characters: the counter goes first, then the name is shortened. */
export function whoAsks(name, index, total, max = 28) {
  const n = String(name ?? '').trim();
  const counter = total > 1 ? ` · ${index + 1} of ${total}` : '';
  if ((n + ' asks' + counter).length <= max) return n + ' asks' + counter;
  if ((n + ' asks').length <= max) return n + ' asks';
  const room = Math.max(4, max - ' asks'.length - 1);
  // a name is cut at a word boundary whenever one is in reach, so "Investigate intermitte…" never happens with room to spare
  const cut = n.slice(0, room), sp = n.charAt(room) === ' ' ? room : cut.lastIndexOf(' ');
  return (sp > room * 0.3 ? cut.slice(0, sp) : cut).replace(/[,.;:\s]+$/, '') + '… asks';
}

/**
 * How a row of answer buttons sits in the lid: side by side ('') while every label fits on one line; with tighter padding
 * and type ('tight') when that is what it takes; otherwise one above the other ('stack'), each the lid's full width.
 * A label never wraps just to squeeze a row.
 * @param {string[]} labels
 * @param {{ rowW: number, px: number, minW: number, measure: (text: string, px: number) => number }} o
 *   rowW: the lid's inner width; px: the buttons' type size; minW: their least width
 * @returns {'' | 'tight' | 'stack'}
 */
export function buttonRow(labels, { rowW, px, minW, measure }) {
  if (!Array.isArray(labels) || labels.length < 2) return '';
  const total = (pad, gap, size) => labels.reduce((s, l) => s + Math.max(minW, measure(String(l), size) + 2 * pad + 2), 0) + gap * (labels.length - 1);
  if (total(18, 10, px) <= rowW) return '';
  if (total(12, 8, px - 1) <= rowW) return 'tight';
  return 'stack';
}

/** The headline's size step for its length; `down` steps it smaller to fit. */
export function headlineClass(text, down = 0) {
  const n = String(text ?? '').length;
  const i = (n <= 50 ? 0 : n <= 92 ? 1 : n <= 150 ? 2 : 3) + down;
  return ['', 'len-m', 'len-l', 'len-xl'][Math.max(0, Math.min(3, i))];
}
