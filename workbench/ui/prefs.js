// How the person has set the page up: the look (theme) and how much detail it shows, plus the few words the page
// answers itself instead of sending them to the engine. Pure: no DOM, no imports (node:test loads it).
//
// Workbench keeps the choices, not the page (src/core/prefs.mjs, in ~/.workbench/prefs.json): the server puts them on
// <html> as it sends the page (data-theme, data-detail, data-answered), and the page saves a change through
// POST /api/prefs. The lists match the server's.

export const THEMES = ['green', 'black-gold', 'ivory'];
export const THEME_NAMES = { green: 'Green', 'black-gold': 'Black and gold', ivory: 'Ivory' };
export const DETAILS = ['calm', 'more'];
export const DETAIL_NAMES = { calm: 'Calm', more: 'More' };
export const DEFAULT_PREFS = Object.freeze({ theme: 'green', detail: 'calm' });

export const normalTheme = v => (THEMES.includes(v) ? v : DEFAULT_PREFS.theme);
export const normalDetail = v => (DETAILS.includes(v) ? v : DEFAULT_PREFS.detail);

/**
 * The choices Workbench put on <html>: `dataset` is document.documentElement.dataset, or anything with the same
 * fields. Anything unknown is the default; `answered` (the person has answered something once) only when it is "1".
 * @returns {{ theme: string, detail: string, answered: boolean }}
 */
export function pagePrefs(dataset) {
  const d = dataset && typeof dataset === 'object' ? dataset : {};
  return { theme: normalTheme(d.theme), detail: normalDetail(d.detail), answered: d.answered === '1' };
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
 * "looks good" or "not now", typed or said: which of the two answers these words are ("Looks good", "Not now"), so at a
 * finished agent's lid the page presses the button that stands for them (its data-words, focus.js) or says which answers
 * the lid has, and never sends the words to the engine as a command (app.js). The phrases are the engine's own
 * (LOOKS_GOOD_RE and NOT_NOW_RE in /shared/answers.mjs), passed in, so the two never disagree. null for anything else.
 * @returns {'Looks good'|'Not now'|null}
 */
export function lidAnswer(text, { LOOKS_GOOD_RE, NOT_NOW_RE }) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (NOT_NOW_RE.test(t)) return 'Not now';
  if (LOOKS_GOOD_RE.test(t)) return 'Looks good';
  return null;
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
