// The board's input: a box that grows with its text, a few lines at most and never over the lid's words, then scrolls
// inside, in the same look as the one-line input it was. Enter sends; Shift+Enter adds a line; pasted text keeps its
// line breaks (a textarea keeps them), and so does what is sent. No DOM lookups and no imports (node:test loads it with
// stand-ins for the textarea and the bar).

/** The most lines the box shows; past them it scrolls inside. */
export const SAY_LINES = 5;

/**
 * What a key does in the box: 'send' for Enter, or null, so the browser does what it does (Shift+Enter adds a line).
 * An Enter that an input method uses to pick a word, while it is still composing, sends nothing.
 */
export function sayKey(e) {
  if (!e || e.key !== 'Enter') return null;
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.isComposing || e.keyCode === 229) return null;
  return 'send';
}

/**
 * How tall the box is for its text. `need`: the height its text needs; `line`: one line's height; `room`: how much
 * taller than one line it may grow before it would cover the lid's words; `lines`: the most lines it shows. It grows by
 * whole lines, so no line shows cut in half.
 * @returns {{ height: number, extra: number, scroll: boolean }} `extra`: how much taller than one line it is
 */
export function boxHeight({ need, line, room = Infinity, lines = SAY_LINES }) {
  const more = Math.min(lines - 1, Math.floor(Math.max(0, room) / line));
  const most = line * (1 + more);
  const height = Math.max(line, Math.min(need, most));
  return { height, extra: height - line, scroll: need > most + 0.5 };
}

/**
 * Wire the box: Enter sends `field.value` through `send`, and every change of its text fits its height. The bar grows
 * with it through `--say-extra` (app.css). `lineHeight()` is one line's height in pixels. `room(px)` sets how far the
 * box may grow (the layout's spare height in the lid) and fits it when that, or the line's height, changed; `fit()` fits
 * it again after its text was set by hand, or its width changed.
 */
export function setupSayBox({ field, bar, send, lineHeight }) {
  let room = Infinity;
  let roomLine = 0; // the line height `room` was last fitted with
  const fit = () => {
    const line = lineHeight();
    field.style.height = `${line}px`; // from one line, so the text's own height shows
    const box = boxHeight({ need: field.scrollHeight, line, room });
    field.style.height = `${box.height}px`;
    field.style.overflowY = box.scroll ? 'auto' : 'hidden';
    bar.style.setProperty('--say-extra', `${box.extra}px`);
    return box;
  };
  field.addEventListener('keydown', e => {
    if (sayKey(e) !== 'send') return;
    e.preventDefault();
    send(field.value);
  });
  field.addEventListener('input', fit);
  return {
    fit,
    room(px) {
      const next = Number.isFinite(px) ? px : Infinity;
      const line = lineHeight();
      if (next === room && line === roomLine) return null; // nothing that sizes the box changed
      room = next;
      roomLine = line;
      return fit();
    },
  };
}
