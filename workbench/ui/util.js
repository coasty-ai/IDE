// Small helpers. No DOM is touched when this module loads, so node:test can import it.

const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for use inside HTML. Everything an agent says goes through this. */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => MAP[c]);
}

/**
 * Run `fn` at most once per `ms`, on an animation frame. At most one run is ever queued: in a hidden tab, where
 * frames do not run, updates do not pile up into a backlog, and the one queued run reads the state as it is then.
 * `raf` and `timer` are injectable for tests.
 */
export function coalesce(fn, ms, { raf = globalThis.requestAnimationFrame, timer = globalThis.setTimeout } = {}) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    timer(() => raf(() => { pending = false; fn(); }), ms);
  };
}

/**
 * Make `host`'s children match `html` without rebuilding what did not change: each top-level child whose markup is
 * the same is kept (with its focus, scroll and state); the others are replaced. A replaced child that held the focus
 * hands it to the new element with the same data-key. Returns true when focus was inside and is now lost.
 */
export function patchChildren(host, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const had = host.contains(document.activeElement) ? document.activeElement : null;
  const next = [...t.content.children];
  const prev = [...host.children];
  if (next.length !== prev.length) host.replaceChildren(...next);
  else next.forEach((n, i) => { if (n.outerHTML !== prev[i]._src) prev[i].replaceWith(n); });
  for (const n of host.children) if (n._src == null) n._src = n.outerHTML;
  if (!had || had.isConnected) return false;
  const key = had.dataset && had.dataset.key;
  const again = key && host.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (again && !again.disabled) { again.focus({ preventScroll: true }); return false; }
  return true;
}

/** Set an attribute only when it changes (same-value writes still cost a style recalc on SVG). */
export function setAttr(el, k, v) {
  const s = String(v);
  if (el.getAttribute(k) !== s) el.setAttribute(k, s);
}

/** Set text only when it changes. */
export function setText(el, s) {
  if (el.textContent !== s) el.textContent = s;
}
