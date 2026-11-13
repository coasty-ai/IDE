// TEMPORARY: a stand-in written by U4 (the page) so the board's key guard and its tests run in this branch. U1 owns the
// real src/shared/secretshape.mjs; when the branches are merged, take U1's file and drop this one. It follows the spec's
// interface only: looksLikeSecret(text) -> { secret, kind }. Pure: no node: imports, the page loads it.

const KNOWN = [
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['openai', /\bsk-proj-[A-Za-z0-9_-]{16,}/],
  ['openai', /\bsk-[A-Za-z0-9]{20,}/],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['github', /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/],
  ['github', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['slack', /\bxox[bpas]-[A-Za-z0-9-]{10,}/],
  ['stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]+-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];

/** A long word of base64 or hex with mixed kinds of characters; a commit hash (40 hex characters) is not one. */
function genericWord(w) {
  if (w.length < 32 || !/^[A-Za-z0-9+/=_-]+$/.test(w)) return false;
  if (/^[0-9a-f]{40}$/i.test(w)) return false;
  if (w.includes('/') && !/[+=]/.test(w)) return false;   // a path, not a key
  const digit = /[0-9]/.test(w), lower = /[a-z]/.test(w), upper = /[A-Z]/.test(w);
  if (/^[0-9a-f]+$/i.test(w)) return digit && (lower || upper);
  return digit && lower && upper;
}

export function looksLikeSecret(text) {
  const t = String(text ?? '');
  for (const [kind, re] of KNOWN) if (re.test(t)) return { secret: true, kind };
  for (const w of t.split(/\s+/)) if (genericWord(w.replace(/^["'“(<]+|[)"'”>.,;:!?]+$/g, ''))) return { secret: true, kind: 'generic' };
  return { secret: false, kind: null };
}
