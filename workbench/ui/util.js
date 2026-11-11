// Small DOM helpers.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use inside HTML. Everything an agent says goes through this. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => MAP[c]);
}

/** Run `fn` at most once per `ms`, at the end of the window. */
export function coalesce(fn, ms) {
  let t = null;
  return () => {
    if (t) return;
    t = setTimeout(() => { t = null; requestAnimationFrame(fn); }, ms);
  };
}
