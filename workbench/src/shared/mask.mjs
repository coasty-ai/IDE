// How a secret value shows, and text with secret values hidden: one rule for the key store (src/core/keys.mjs, which
// gives these as its own), Agents & keys and the engine, which also hides the values of the env files copied into
// agents' copies. No node: modules: the page may load this file as it is.

/** Printable ASCII that is safe inside a JSON string and a sentence: no space, no " and no \. */
const SAFE_TAIL = /^[\x21\x23-\x5b\x5d-\x7e]{4}$/;

/**
 * How a secret value is shown: "•••• " and its last 4 characters for values of 12 characters or more, "••••" for
 * shorter ones (and when the last 4 are not plain printable characters).
 */
export function shownValue(value) {
  const s = String(value ?? '');
  if (s.length < 12) return '••••';
  const tail = s.slice(-4);
  return SAFE_TAIL.test(tail) ? `•••• ${tail}` : '••••';
}

const MASKS = new WeakMap();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function maskPlan(values) {
  if (!values || typeof values[Symbol.iterator] !== 'function' || typeof values === 'string') return null;
  if (MASKS.has(values)) return MASKS.get(values);
  const masks = new Map();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 8) continue;
    const shown = shownValue(v);
    masks.set(v, shown);
    // In a line of JSON (an agent's raw output) the value appears escaped.
    const escaped = JSON.stringify(v).slice(1, -1);
    if (escaped !== v) masks.set(escaped, shown);
  }
  const forms = [...masks.keys()].sort((a, b) => b.length - a.length);
  const plan = forms.length ? { re: new RegExp(forms.map(escapeRe).join('|'), 'g'), masks } : null;
  if (Object.isFrozen(values)) MASKS.set(values, plan);
  return plan;
}

/**
 * `text` with every value of 8 or more characters replaced by how it is shown (shownValue), longest first, in one pass.
 * A value's JSON-escaped form is replaced too, so a raw line of JSON stays JSON. Returns `text` as it is when there is
 * nothing to mask. A frozen list keeps its plan (the expression built from its values) for the next call.
 * @param {string} text
 * @param {Iterable<string>} values
 */
export function maskSecrets(text, values) {
  if (typeof text !== 'string' || !text) return text;
  const plan = maskPlan(values);
  if (!plan) return text;
  return text.replace(plan.re, (m) => plan.masks.get(m));
}
