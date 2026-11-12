// Shaping text for small spaces. Pure: no DOM, no imports (node:test loads it).

// ---------------------------------------------------------------- characters that hide text
// The one rule for characters that hide text or change the order it reads in. Wherever an agent's or a repository's
// words reach the page (the lid, the board, the git screen and its diff), each one is shown, never left raw: control
// characters as pictures (⏎ ⇥ ␍ ␡, and ␀ to ␟), every other one by its code ("⟦U+202E⟧"). The rule covers
//   - the C0 and C1 control characters (Unicode's Cc),
//   - every default-ignorable code point: zero-width spaces and joiners, direction marks, the byte-order mark, soft
//     hyphens, Hangul fillers, invisible operators, and tag characters (which can spell out words no one sees),
//   - the bidirectional controls (embeddings, overrides, isolates and marks), and the line and paragraph separators.
// Variation selectors are default-ignorable too, but an emoji needs one: a single U+FE0E or U+FE0F straight after an
// emoji stays as it is. Any other selector, and every one after the first, is shown, because a run of them can carry
// hidden text. Written with Unicode's properties and the u flag, so characters past U+FFFF count too, and so no such
// character is ever in this file raw. The diff view (ui/diffview.js) reads text with hiddenParts() too.
const HIDDEN = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u{2028}\u{2029}]/u;
const EMOJI = /\p{Emoji}/u;
const SELECTORS = new Set(['\u{FE0E}', '\u{FE0F}']);
const PICTURES = { '\n': '⏎', '\t': '⇥', '\r': '␍', '\x7f': '␡' };

/** How a hidden character is shown: a picture for a control character (⏎, ⇥, ␛, …), else its code ("⟦U+E0041⟧"). */
export function hiddenPicture(ch) {
  const n = String(ch).codePointAt(0) || 0;
  if (PICTURES[ch]) return PICTURES[ch];
  if (n < 0x20) return String.fromCharCode(0x2400 + n);
  return `⟦U+${n.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}

/**
 * A text in pieces, in order: runs of ordinary text ({ text }), and each hidden character on its own ({ text, hidden }:
 * the character itself, and how it is shown). Whole characters only, so nothing past U+FFFF is ever split.
 * @returns {{ text: string, hidden?: string }[]}
 */
export function hiddenParts(s) {
  const t = String(s ?? '');
  if (!HIDDEN.test(t)) return t ? [{ text: t }] : [];
  const out = [];
  let run = '', prev = '';
  for (const ch of t) {
    // an emoji keeps its one selector; a selector anywhere else, or a second one, is shown
    const kept = SELECTORS.has(ch) && prev !== '' && EMOJI.test(prev) && !HIDDEN.test(prev);
    if (!kept && HIDDEN.test(ch)) {
      if (run) { out.push({ text: run }); run = ''; }
      out.push({ text: ch, hidden: hiddenPicture(ch) });
    } else run += ch;
    prev = ch;
  }
  if (run) out.push({ text: run });
  return out;
}

/**
 * Text with every character that hides text or turns it shown (the rule above), so a command, a path, a name or a branch
 * can never hide a line break or a tab (⏎, ⇥, ␍, ␛, …), nor read in an order other than the one it is in ("⟦U+202E⟧").
 */
export function visibleControls(s) {
  const t = String(s ?? '');
  if (!HIDDEN.test(t)) return t;
  return hiddenParts(t).map(p => p.hidden ?? p.text).join('');
}

/**
 * A name cut in the middle to at most `max` characters, with "…" where it was cut, so both ends stay readable
 * ("workbenc…-a1b2c3"). Used for branch names on buttons; the whole name goes in the button's title.
 */
export function cutMiddle(s, max = 16) {
  const t = Array.from(String(s ?? ''));
  if (t.length <= max) return t.join('');
  const keep = Math.max(1, max - 1), head = Math.ceil(keep / 2);
  return t.slice(0, head).join('') + '…' + t.slice(t.length - (keep - head)).join('');
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
