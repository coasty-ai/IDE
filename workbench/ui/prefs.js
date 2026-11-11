// How the person has set the page up: the look (theme) and how much detail it shows, plus the few words the page
// answers itself instead of sending them to the engine. Pure: no DOM, no imports (node:test loads it).

export const THEMES = ['green', 'black-gold', 'ivory'];
export const THEME_NAMES = { green: 'Green', 'black-gold': 'Black and gold', ivory: 'Ivory' };
export const DETAILS = ['calm', 'more'];
export const DETAIL_NAMES = { calm: 'Calm', more: 'More' };
export const DEFAULT_PREFS = Object.freeze({ theme: 'green', detail: 'calm' });
export const PREF_KEYS = Object.freeze({ theme: 'wb-theme', detail: 'wb-detail' });

export const normalTheme = v => (THEMES.includes(v) ? v : DEFAULT_PREFS.theme);
export const normalDetail = v => (DETAILS.includes(v) ? v : DEFAULT_PREFS.detail);

/** Read the saved choices. `storage` is localStorage, or anything with getItem; failures fall back to the defaults. */
export function loadPrefs(storage) {
  const get = k => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
  return { theme: normalTheme(get(PREF_KEYS.theme)), detail: normalDetail(get(PREF_KEYS.detail)) };
}

/** Save one choice; returns the value actually kept. */
export function savePref(storage, key, value) {
  const v = key === 'theme' ? normalTheme(value) : normalDetail(value);
  try { storage?.setItem(PREF_KEYS[key], v); } catch { /* private mode: the choice lasts until reload */ }
  return v;
}

// The words, matched against the whole utterance only, so "make the login button green" still reaches the agents.
const THEME_WORDS = new Map([
  ['green board', 'green'], ['green look', 'green'], ['green theme', 'green'], ['the green board', 'green'], ['green circuit board', 'green'],
  ['black and gold', 'black-gold'], ['black and gold board', 'black-gold'], ['black and gold look', 'black-gold'], ['black and gold theme', 'black-gold'], ['black gold', 'black-gold'],
  ['ivory', 'ivory'], ['ivory board', 'ivory'], ['ivory look', 'ivory'], ['ivory theme', 'ivory'],
]);
const DETAIL_WORDS = new Map([
  ['more detail', 'more'], ['more details', 'more'], ['show more detail', 'more'], ['show more details', 'more'],
  ['less detail', 'calm'], ['less details', 'calm'], ['fewer details', 'calm'], ['show less detail', 'calm'], ['calm', 'calm'], ['calm detail', 'calm'],
]);
// Stepping through what needs the person. Deliberately narrow: "skip", "later" and "not now" can be real answers.
const NEXT_WORDS = new Set(['next', 'next one', 'the next one', 'show me the next one', 'show the next one', 'skip this one']);

/** Lower case, punctuation dropped, polite and leading words trimmed. */
export function plainWords(text) {
  let t = String(text ?? '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[-_/]/g, ' ')
    .replace(/[“”"'’‘.!?,;:()]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = t.replace(/^(please|ok|okay) /, '').replace(/ please$/, '');
  t = t.replace(/^(switch|change|go|turn) (back )?(it |the board |the look |the page )?(back )?to /, '')
    .replace(/^(use|show me) /, '');
  return t.trim();
}

/**
 * Words the page answers itself. Never sent to the engine.
 * @returns {{ kind: 'theme', theme: string } | { kind: 'detail', detail: string } | { kind: 'next' } | null}
 */
export function pageCommand(text) {
  const t = plainWords(text);
  if (!t || t.length > 40) return null;
  if (THEME_WORDS.has(t)) return { kind: 'theme', theme: THEME_WORDS.get(t) };
  if (DETAIL_WORDS.has(t)) return { kind: 'detail', detail: DETAIL_WORDS.get(t) };
  if (NEXT_WORDS.has(t)) return { kind: 'next' };
  return null;
}
