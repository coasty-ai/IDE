// What the page takes from its own address. Pure: no DOM, no imports, so node:test can load it.
//
// Debug switches count only when the same address carries the key (t=). Any website can send the person's tab to an
// address here, so an address without the key must not change what the page does. Nothing in the address ever makes
// the page send anything (there is no say=).

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const on = v => v != null && v !== '0' && v !== 'false';

/**
 * @param {string} search  location.search, read once before the key is removed from the address bar
 * @returns {{ static: boolean, still: boolean, pin: string|null, focus: string|null }}
 */
export function debugSwitches(search) {
  const off = { static: false, still: false, pin: null, focus: null };
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch { return off; }
  if (!q.get('t')) return off;
  const id = v => (typeof v === 'string' && ID.test(v) ? v : null);
  return { static: on(q.get('static')), still: on(q.get('still')), pin: id(q.get('pin')), focus: id(q.get('focus')) };
}
