// An agent's changes, for people to read: one section per file with a plain header, then its lines with visible + and
// − marks (and words for screen readers), long lines wrapped by the page, never scrolled sideways.
// Everything an agent controls goes through esc(), and characters that could hide or reorder text are shown as visible
// symbols, never raw, by the lid's own rule (hiddenParts in ui/words.js): control characters, every default-ignorable
// character (zero-width characters, soft hyphens, Hangul fillers, tag characters, …), the bidirectional controls, and
// the line and paragraph separators.
// Pure: no DOM is touched when this module loads, and nothing comes from /shared/ (node:test loads it).
import { esc } from './util.js';
import { hiddenParts, visibleControls } from './words.js';

// What some hidden characters are, in words, for a title. The rest are named by their kind.
const NAMES = {
  0x200b: 'a zero-width space', 0x200c: 'a zero-width non-joiner', 0x200d: 'a zero-width joiner', 0x200e: 'a left-to-right mark',
  0x200f: 'a right-to-left mark', 0x2028: 'a line separator', 0x2029: 'a paragraph separator', 0x202a: 'a left-to-right embedding',
  0x202b: 'a right-to-left embedding', 0x202c: 'the end of a direction change', 0x202d: 'a left-to-right override',
  0x202e: 'a right-to-left override', 0x2060: 'a word joiner', 0x2066: 'a left-to-right isolate', 0x2067: 'a right-to-left isolate',
  0x2068: 'a first-strong isolate', 0x2069: 'the end of a direction isolate', 0x061c: 'an Arabic letter mark', 0xfeff: 'a zero-width no-break space',
  0x00ad: 'a soft hyphen', 0x034f: 'a combining grapheme joiner', 0x115f: 'a Hangul filler', 0x1160: 'a Hangul filler', 0x3164: 'a Hangul filler',
  0xffa0: 'a Hangul filler', 0x180e: 'a Mongolian vowel separator', 0x2061: 'an invisible function sign', 0x2062: 'an invisible times sign',
  0x2063: 'an invisible separator', 0x2064: 'an invisible plus sign',
};
const SELECTOR = /\p{Variation_Selector}/u;

const hex = code => code.toString(16).toUpperCase().padStart(4, '0');

/** What a hidden character is, in words, for a title. */
function nameOf(ch) {
  const code = ch.codePointAt(0);
  if (NAMES[code]) return `Hidden here: ${NAMES[code]}.`;
  if (ch === '\r') return 'Hidden here: a carriage return (a Windows line ending).';
  if (ch === '\n') return 'Hidden here: a line break.';
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return `Hidden here: a control character (U+${hex(code)}).`;
  if (code >= 0xe0000 && code <= 0xe007f) return `Hidden here: a tag character (U+${hex(code)}), which can hide text.`;
  if (SELECTOR.test(ch)) return `Hidden here: a variation selector (U+${hex(code)}).`;
  return `Hidden here: an invisible character (U+${hex(code)}).`;
}

/** Does this text hold a character that is shown as a symbol: one that would be hidden, or reorder what is read? */
export const hasHidden = s => hiddenParts(s).some(p => p.hidden);

/** Plain text with every hidden character made visible (tabs become ⇥), exactly as the lid shows it (visibleControls). */
export function visibleText(s) {
  return visibleControls(s);
}

/**
 * HTML for text an agent controls: escaped, with each hidden character a marked, visible symbol (its name in a title)
 * and each tab a ⇥ that keeps the indentation (to the next stop of 4).
 */
export function visibleHtml(s) {
  return visibleHtmlAt(s, 0).html;
}

/**
 * visibleHtml for a piece of a line that starts at column `col` (the file view colours a line in pieces): its tabs stop
 * where the whole line's would. Returns the HTML and the column the piece ends at.
 * @returns {{ html: string, col: number }}
 */
export function visibleHtmlAt(s, col = 0) {
  let out = '';
  for (const p of hiddenParts(s)) {
    if (!p.hidden) { out += esc(p.text); col += Array.from(p.text).length; continue; }
    if (p.text === '\t') {
      const pad = 4 - (col % 4);
      out += `<span class="vc tab" title="A tab">⇥</span>${' '.repeat(pad - 1)}`;
      col += pad;
      continue;
    }
    out += `<span class="vc" title="${esc(nameOf(p.text))}">${esc(p.hidden)}</span>`;
    col += Array.from(p.hidden).length;
  }
  return { html: out, col };
}

/**
 * The first line of the file as it is now that a change added or changed (where a file opens from the git screen): the
 * first added line, else where the first lines were taken away, else line 1.
 */
export function firstChangedLine(patch) {
  let at = null;
  for (const l of patchLines(patch)) {
    if (l.t === 'hunk') { at = l.line || 1; continue; }
    if (at == null) continue;
    if (l.t === 'add' || l.t === 'del') return Math.max(1, at);
    if (l.t === 'ctx') at++;
  }
  return 1;
}

const n0 = n => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
/** 1,240: whole numbers with thousands marked. */
export const count = n => n0(n).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${count(n)} ${n0(n) === 1 ? one : many}`;

/**
 * What git's own lines before the first hunk say about a file: a symbolic link (mode 120000), or a change of whether it
 * can run as a program. Git's headers themselves are never shown.
 */
export function patchFacts(patch) {
  // A type change (a file that became a link, or a link that became a file) comes as two parts, each with its own
  // `diff --git` header: the headers of every part are read, never what is inside a hunk.
  const lines = typeof patch === 'string' ? patch.split('\n') : [];
  const head = [];
  let inHunk = false;
  for (const l of lines) {
    if (l.startsWith('diff --git ')) { inHunk = false; head.push(l); continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) head.push(l);
  }
  const facts = { link: false, exec: null, became: null };
  for (const l of head) {
    if (/^(new file|deleted file|old|new) mode 120000\b/.test(l) || /^index [0-9a-f]+\.\.[0-9a-f]+ 120000\b/.test(l)) facts.link = true;
    if (/^new mode 100755\b/.test(l)) facts.exec = 'on';
    if (/^new mode 100644\b/.test(l) && head.some(x => /^old mode 100755\b/.test(x))) facts.exec = 'off';
  }
  const gone = head.find(l => /^deleted file mode \d+/.test(l)), made = head.find(l => /^new file mode \d+/.test(l));
  if (gone && made) {
    const wasLink = /120000/.test(gone), isLink = /120000/.test(made);
    if (!wasLink && isLink) facts.became = 'link';
    else if (wasLink && !isLink) facts.became = 'file';
  }
  return facts;
}

/** The plain words in a file's header: its counts, or what it is instead. */
export function fileWords(f, facts = patchFacts(f && f.patch)) {
  if (f.binary) return 'binary file';
  if (f.large) return 'too large to show here';
  if (facts.became === 'link') return 'the file became a link';
  if (facts.became === 'file') return `the link became a file, +${count(f.adds)}`;
  if (facts.link) return f.status === 'added' ? 'new link' : f.status === 'deleted' ? 'deleted link' : 'link changed';
  if (f.status === 'added') return `new file, +${count(f.adds)}`;
  if (f.status === 'deleted') return `deleted, −${count(f.dels)}`;
  return `+${count(f.adds)} −${count(f.dels)}`;
}

/** Why a file stays out of the merge, in words. */
export function leftWords(why) {
  if (why === 'nested-repo') return 'Not merged: it is a separate repository inside its folder';
  return 'Not merged: hidden by a .gitignore it changed';
}

/** The lines of one file's unified diff: its hunks, with git's headers before the first hunk dropped. */
export function patchLines(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const raw = patch.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const out = [];
  let inHunk = false;
  for (const l of raw) {
    // a second part (the other half of a type change) starts with its own header: skip it until its hunk
    if (l.startsWith('diff --git ')) { inHunk = false; continue; }
    if (l.startsWith('@@')) {
      inHunk = true;
      // the s flag: git copies the function line as it is, and it may hold a line or paragraph separator or a lone carriage
      // return, which '.' would not match without it (the words then go through visibleHtml, which shows them)
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/s.exec(l.replace(/\r$/, ''));
      const line = m ? (Number(m[2]) || Number(m[1]) || null) : null;
      out.push({ t: 'hunk', line, ctx: m ? m[3] : '' });
      continue;
    }
    if (!inHunk) continue;
    const c = l.charAt(0);
    if (c === '+') out.push({ t: 'add', s: l.slice(1) });
    else if (c === '-') out.push({ t: 'del', s: l.slice(1) });
    else if (c === '\\') out.push({ t: 'note' });
    else out.push({ t: 'ctx', s: c === ' ' ? l.slice(1) : l });
  }
  return out;
}

const textLines = ls => ls.filter(l => l.t === 'add' || l.t === 'del' || l.t === 'ctx').length;

/** Why a file has no lines to show, in words. */
function noLinesWords(f, facts) {
  if (facts.exec === 'on') return 'Only this changed: it can now run as a program.';
  if (facts.exec === 'off') return 'Only this changed: it can no longer run as a program.';
  if (f.status === 'added') return 'An empty file.';
  if (f.status === 'deleted') return 'It was empty.';
  return 'No lines changed.';
}

/**
 * The diff as HTML.
 * @param {{ files?: object[], left?: { path: string, why: string }[], cut?: boolean, omitted?: number }} diff  workDiff's shape
 * @param {{ maxLines?: number, open?: boolean }} [o]  past maxLines, the rest is "and 1,240 more lines"; every file still
 *   gets its header. With `open`, a file still in the copy (not deleted) has its path as a button that carries its place
 *   in `diff.files` and its first changed line (data-file-index, data-line): the git screen opens it in the file view.
 */
export function diffHtml(diff, { maxLines = 4000, open = false } = {}) {
  const files = Array.isArray(diff?.files) ? diff.files.filter(f => f && typeof f === 'object') : [];
  const left = Array.isArray(diff?.left) ? diff.left.filter(x => x && typeof x === 'object') : [];
  const omitted = n0(diff?.omitted);
  let html = '', shown = 0, rest = 0, stopped = false;
  for (const [index, f] of files.entries()) {
    const facts = patchFacts(f.patch);
    const lines = f.binary || f.large ? [] : patchLines(f.patch);
    const words = fileWords(f, facts);
    const line = open && f.status !== 'deleted' && typeof f.path === 'string' && f.path ? firstChangedLine(f.patch) : null;
    const head = line ? `<button type="button" class="dp dopen" data-file-index="${index}" data-line="${line}" data-key="open:${index}" title="${esc(`Open ${visibleText(f.path)} at line ${line}`)}">${visibleHtml(f.path)}</button>`
      : `<span class="dp">${visibleHtml(f.path)}</span>`;
    html += `<section class="df"><h3 class="dh">${head} <span class="dn">${esc(words)}</span></h3>`;
    if (stopped) { rest += textLines(lines); html += '</section>'; continue; }
    if (!f.binary && !f.large && !textLines(lines)) html += `<p class="dq">${esc(noLinesWords(f, facts))}</p>`;
    if (textLines(lines)) {
      html += '<div class="dlines">';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.t !== 'hunk' && l.t !== 'note' && shown >= maxLines) { stopped = true; rest += textLines(lines.slice(i)); break; }
        if (l.t === 'hunk') html += `<div class="dhunk">line ${l.line ? count(l.line) : 1}${l.ctx ? ` <span class="dctx">${visibleHtml(l.ctx)}</span>` : ''}</div>`;
        else if (l.t === 'note') html += '<div class="dnote">no line break at the end of the file</div>';
        else {
          shown++;
          const g = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
          const word = l.t === 'add' ? '<span class="sr">added: </span>' : l.t === 'del' ? '<span class="sr">removed: </span>' : '';
          const text = facts.link && l.t !== 'ctx' ? `→ ${visibleHtml(l.s)}` : visibleHtml(l.s);
          html += `<div class="dl ${l.t}"><span class="dg" aria-hidden="true">${g}</span>${word}<span class="dt">${text || ' '}</span></div>`;
        }
      }
      html += '</div>';
      if (f.cut && !stopped) html += '<p class="dq">The rest of this file is too long to show here.</p>';
    }
    html += '</section>';
  }
  if (rest > 0) html += `<p class="dmore">and ${plural(rest, 'more line')}</p>`;
  if (omitted > 0) html += `<p class="dmore">and ${plural(omitted, 'more file')}, not shown here</p>`;
  if (diff?.cut) html += '<p class="dmore">Some of the changes are too large to show here.</p>';
  if (left.length) {
    html += `<section class="df dleft"><h3 class="dh"><span class="dp">${esc(plural(left.length, 'file'))} not merged</span></h3><ul>`;
    for (const x of left) html += `<li><span class="dp">${visibleHtml(x.path)}</span> <span class="dw">${esc(leftWords(x.why))}</span></li>`;
    html += '</ul></section>';
  }
  if (!files.length && !left.length && !omitted) html = '<p class="dq">No changes.</p>';
  return html;
}
