// Even lines in the middle's heading where the page's engine cannot balance them itself. text-wrap: balance came in
// Safari 17.5, and the Mac app's web view is the system's own, which can be older: there a heading such as "Merge
// Search cleanup into main?" left "main?" alone on its last line. balancedWidth is pure; balanceHeading measures the
// page, and does nothing where the engine balances by itself.

/**
 * The narrowest width, in whole pixels from `min` to `full`, at which the text takes no more lines than at `full`, so
 * its lines come out as even as its words allow. `linesAt(width)` measures (Infinity: it does not fit at that width).
 * `full` itself when the text is one line, or when no narrower width keeps its lines.
 */
export function balancedWidth(full, linesAt, min = Math.floor(full / 2)) {
  const top = Math.floor(full);
  const want = linesAt(top);
  if (!(want > 1) || !Number.isFinite(want)) return top;
  let lo = Math.max(1, Math.min(Math.floor(min), top));
  let hi = top;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (linesAt(mid) <= want) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}

/** Whether the page's engine balances headings itself. */
export function balancesItself(css = globalThis.CSS) {
  try {
    return !!(css && typeof css.supports === 'function' && css.supports('text-wrap', 'balance'));
  } catch {
    return false;
  }
}

/**
 * Give a centred heading the width at which its lines are even (an inline max-width), after undoing an earlier one.
 * Words are never cut to save a line: while measuring, a width at which a word would stick out does not fit.
 */
export function balanceHeading(el, { css = globalThis.CSS } = {}) {
  if (!el || !el.style || balancesItself(css)) return;
  el.style.maxWidth = '';
  const full = el.getBoundingClientRect().width;
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
  if (!(full > 0) || !(lineHeight > 0)) return;
  const wrap = el.style.overflowWrap;
  el.style.overflowWrap = 'normal';
  const linesAt = (w) => {
    el.style.maxWidth = `${w}px`;
    if (el.scrollWidth > el.clientWidth + 1) return Infinity;
    return Math.round(el.getBoundingClientRect().height / lineHeight);
  };
  try {
    const w = balancedWidth(full, linesAt);
    el.style.maxWidth = w < Math.floor(full) ? `${w}px` : '';
  } finally {
    el.style.overflowWrap = wrap;
  }
}
