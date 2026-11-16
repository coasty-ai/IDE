// Does a piece of text look like a key: an API key, a token, a private key? The board's text box asks before it sends
// anything, and the engine asks again before it parses, stores or logs a command. A key typed there would otherwise
// reach an agent's task, its branch name, the event log and history.
//
// Pure: no node: modules. The page loads this file as it is (/shared/secretshape.mjs).
//
// Two kinds of evidence, in this order:
// - Known shapes: a vendor's prefix followed by enough characters of the right alphabet to be a key, so a sentence that
//   only names one ("what is a ghp_ token?", "use sk-learn") is not refused.
// - A long random word: 32 or more characters of base64 or hex. Hex needs digits and letters, and 40 hex characters
//   alone are a commit id. Other words need lower case, upper case and digits, mixed the way random text mixes them:
//   the kind of character changes often, few letters are vowels, and little of it reads as words. Paths and long
//   identifiers (AbstractSingletonProxyFactoryBean2, src/components/v2/LoginForm2) are not refused; about 1 random
//   32-character key in 25 is missed, which the known shapes above make up for.
//
// A refusal cannot be overridden, so the generic rule leans towards letting text through.

/** A prefix only counts at the start of a word: not inside `task-sk-...` or `mask_live_...`. */
const START = '(?<![A-Za-z0-9_-])';

/** Known shapes, most specific first: [kind, pattern]. */
const KNOWN = [
  ['private-key', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY/],
  ['anthropic', new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{16,}`)],
  ['openai', new RegExp(`${START}sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}`)],
  // OpenAI's older keys: sk- and 20 or more characters, at least one of them a digit (a branch called
  // sk-improve-error-handling is not a key).
  ['openai', new RegExp(`${START}sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}`)],
  ['aws', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/],
  ['github', new RegExp(`${START}(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`)],
  ['slack', new RegExp(`${START}(?:xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})`)],
  ['stripe', new RegExp(`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|${START}whsec_[A-Za-z0-9]{16,}`)],
  ['jwt', new RegExp(`${START}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`)],
  ['generic', new RegExp(`${START}(?:glpat-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{36})`)],
  // A password in a link (https://deploy:<password>@git.example.com/…): a key, wherever it is. A word that only holds its
  // place ("user:password@", "user:${PW}@"), a local default ("postgres:postgres@", "root:root@") is not one. The scheme
  // is at most 40 characters: unbounded, every dash in a long run ("a-a-a-…") read on to the end of the text.
  ['generic', /(?<![A-Za-z0-9])[a-z][a-z0-9+.-]{0,39}:\/\/([^\s/@:?#]+):(?!\1@)(?!(?:password|passwd|pass|pwd|pw|secret|token|postgres|root|admin|guest|test|dev|local|example|changeme|x+|\*+|<[^>\s]*>|\$\{[^}\s]*\}|\{[^}\s]*\}|\$[A-Za-z_]+)@)[^\s/@?#]{4,}@/i],
];

/** Words of the base64 and base64url alphabets, 32 characters or more. Anything else ends a word. */
const LONG_WORD = /[A-Za-z0-9+/_-]{32,}/g;
/**
 * Web addresses, with or without https://. Documents, files and pages are named in a link's path by long random ids
 * (Google Docs and Drive, Notion), and people paste such links into tasks, so a link's path is not searched for
 * random words. Its query (?token=…) and anything before the host are; known shapes are found anywhere.
 */
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+|\b(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}\/[^\s<>"'`]*/g;
const LINK_PARTS = /^((?:https?:\/\/)?[^/?#]*)([^?#]*)([^]*)$/;
const withoutLinkPaths = (text) => text.replace(LINK, (link) => {
  const m = LINK_PARTS.exec(link);
  return m ? m[1] + ' '.repeat(m[2].length) + m[3] : link;
});
const HEX_RE = /^[0-9a-fA-F]+$/;
/** A digest that names its own kind is a checksum, not a key: sha256:<hex> (Docker), sha512-<base64> (npm). */
const DIGEST_BEFORE = /(?:sha(?:1|224|256|384|512)|md5)[:=]$/i;
const DIGEST_START = /^(?:sha(?:1|224|256|384|512)|md5)-/i;

const NOT_SECRET = Object.freeze({ secret: false, kind: null });

/**
 * Whether `text` looks like it holds a key, and which kind: 'anthropic', 'openai', 'aws', 'github', 'slack',
 * 'stripe', 'private-key', 'jwt' or 'generic' (a long random word, or a known shape with no kind of its own).
 * @param {string} text
 * @returns {{ secret: boolean, kind: string|null }}
 */
export function looksLikeSecret(text) {
  if (typeof text !== 'string' || text.length < 16) return NOT_SECRET;
  for (const [kind, re] of KNOWN) if (re.test(text)) return { secret: true, kind };
  const words = withoutLinkPaths(text); // the same length, so positions still match `text`
  for (const m of words.matchAll(LONG_WORD)) {
    const word = m[0];
    if (DIGEST_START.test(word) || DIGEST_BEFORE.test(words.slice(Math.max(0, m.index - 7), m.index))) continue;
    if (randomWord(word)) return { secret: true, kind: 'generic' };
  }
  return NOT_SECRET;
}

/**
 * The start of a known shape: its prefix at the start of a word and three characters of the key after it. Where the
 * prefix also begins ordinary names (sk-learn, npm_package_version, ASIAN), a digit or a capital must come after it too.
 */
const KEY_START = new RegExp(`${START}(?:`
  + '(?:sk-(?:ant|proj|svcacct|admin)-|(?:sk|rk)_(?:live|test)_|whsec_|gh[opsur]_|github_pat_|xox[abeoprs]-|xapp-|glpat-|AIza|eyJ)[A-Za-z0-9_-]{3}'
  + '|AKIA[A-Z0-9]{3}'
  + '|(?:sk-|npm_)(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{3}'
  + '|ASIA(?=[A-Z0-9]*[0-9])[A-Z0-9]{3})');

/**
 * Whether `text` holds the start of a key of a known shape, typed a letter at a time: looksLikeSecret knows a key only
 * once enough of it is there, and a field that searches as the person types would send every start of it before then.
 * A prefix alone, or with two characters after it, is not one ("what is a ghp_ token?").
 * @param {string} text
 * @returns {boolean}
 */
export function startsLikeSecret(text) {
  return typeof text === 'string' && text.length >= 6 && KEY_START.test(text);
}

/** A word that reads as random: what a generated key looks like, and what names, paths and commit ids do not. */
function randomWord(word) {
  if (HEX_RE.test(word)) {
    if (word.length === 40) return false; // a commit id
    return /[0-9]/.test(word) && /[a-fA-F]/.test(word) && entropy(word) >= 3;
  }
  if (!/[a-z]/.test(word) || !/[A-Z]/.test(word) || !/[0-9]/.test(word)) return false;
  return entropy(word) >= 3.5 && classChanges(word) - vowelShare(word) >= 0.1 && wordShare(word) < 0.4;
}

/** Bits per character (Shannon entropy over the word's own characters). */
function entropy(word) {
  const counts = new Map();
  for (const c of word) counts.set(c, (counts.get(c) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / word.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * How often the kind of character (lower case, upper case, digit) changes from one letter or digit to the next,
 * between 0 and 1. Random text changes about 6 times in 10; words, names and paths about 2 or 3.
 */
function classChanges(word) {
  const chars = word.replace(/[^A-Za-z0-9]/g, '');
  if (chars.length < 2) return 0;
  const kind = (c) => (c >= 'a' && c <= 'z' ? 1 : c >= 'A' && c <= 'Z' ? 2 : 3);
  let changes = 0;
  for (let i = 1; i < chars.length; i++) if (kind(chars[i]) !== kind(chars[i - 1])) changes++;
  return changes / (chars.length - 1);
}

/** The share of letters that are vowels: about 0.2 in random text, nearer 0.4 in words people write. */
function vowelShare(word) {
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (!letters) return 0;
  return letters.replace(/[^aeiouAEIOU]/g, '').length / letters.length;
}

/**
 * The share of letters and digits that sit in something word-like: an optional capital, then three or more lower-case
 * letters with a vowel among them ("Engine", "render"). About 0.13 in random text, over 0.4 in names people write.
 */
function wordShare(word) {
  const chars = word.replace(/[^A-Za-z0-9]/g, '');
  if (!chars) return 0;
  let n = 0;
  for (const m of chars.matchAll(/[A-Z]?[a-z]{3,}/g)) if (/[aeiouy]/i.test(m[0])) n += m[0].length;
  return n / chars.length;
}
