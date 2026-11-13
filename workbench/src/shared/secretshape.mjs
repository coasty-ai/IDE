// TEMPORARY: a minimal stand-in, written by the engine's builder (unit U3a of milestone 1) so that the engine can refuse
// typed keys before the real module exists. Unit U1 owns src/shared/secretshape.mjs and test/secretshape.test.mjs;
// their file replaces this one as it is. It has the same interface:
//   looksLikeSecret(text) -> { secret: boolean, kind: 'anthropic'|'openai'|'aws'|'github'|'slack'|'stripe'|'private-key'|'jwt'|'generic'|null }
// Pure, with no imports: the page loads the files in src/shared/ as they are.

/** Known shapes, tried in this order on each word (sk-ant- before sk-). */
const KNOWN = [
  ['anthropic', /^sk-ant-[A-Za-z0-9_-]{16,}$/],
  ['openai', /^sk-(?:proj-)?[A-Za-z0-9_-]{16,}$/],
  ['aws', /^(?:AKIA|ASIA)[A-Z0-9]{16}$/],
  ['github', /^(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/],
  ['slack', /^xox[bpas]-[A-Za-z0-9-]{10,}$/],
  ['stripe', /^(?:sk|rk)_live_[A-Za-z0-9]{10,}$/],
  ['jwt', /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/],
];

const NONE = Object.freeze({ secret: false, kind: null });

/**
 * A long word with no spaces that looks random: 32 or more characters of hex or base64, with digits and letters mixed
 * (base64 also needs both cases). A 40-character hex word alone is a commit hash, and a word that starts like a path is
 * a path.
 */
function generic(word) {
  if (word.length < 32 || !/^[A-Za-z0-9+/=_-]+$/.test(word)) return false;
  const digits = (word.match(/[0-9]/g) || []).length;
  if (/^[0-9a-f]+$/i.test(word)) return word.length !== 40 && digits >= 3 && word.length - digits >= 3;
  if (word.startsWith('/') || word.includes('//')) return false;
  return digits >= 3 && /[a-z]/.test(word) && /[A-Z]/.test(word);
}

/** The words of a text, without the quotes and punctuation around them, and the value after NAME= or NAME:. */
function words(text) {
  const out = [];
  for (const raw of String(text).split(/\s+/)) {
    const w = raw.replace(/^[("'`[{<]+/, '').replace(/[)"'`\]}>.,;:!?]+$/, '');
    if (!w) continue;
    out.push(w);
    const m = /^[A-Za-z_][A-Za-z0-9_]*[=:](.+)$/.exec(w);
    if (m) out.push(m[1].replace(/^["'`]+|["'`]+$/g, ''));
  }
  return out;
}

/**
 * Does this text look like it holds a key, a token or a private key?
 * @param {string} text
 * @returns {{ secret: boolean, kind: string|null }}
 */
export function looksLikeSecret(text) {
  const t = typeof text === 'string' ? text : String(text ?? '');
  if (!t.trim()) return NONE;
  if (/-----BEGIN[A-Z0-9 ]*-----/.test(t)) return { secret: true, kind: 'private-key' };
  for (const w of words(t)) {
    for (const [kind, re] of KNOWN) if (re.test(w)) return { secret: true, kind };
  }
  for (const w of words(t)) if (generic(w)) return { secret: true, kind: 'generic' };
  return NONE;
}
