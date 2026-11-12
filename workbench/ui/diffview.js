// An agent's changes, for people to read: one section per file with a plain header, then its lines with visible + and
// − marks (and words for screen readers), long lines wrapped by the page, never scrolled sideways.
// Everything an agent controls goes through esc(), and characters that could hide or reorder text are shown as visible
// symbols, never raw: control characters, bidirectional embeddings, overrides and isolates, and zero-width characters.
// Pure: no DOM is touched when this module loads, and nothing comes from /shared/ (node:test loads it).
import { esc } from './util.js';

const PICTURES = { '\n': '⏎', '\r': '␍', '\x7f': '␡' };
// Characters that are invisible, or that change the direction of the text around them. Each is shown as ⟦U+XXXX⟧.
const NAMES = {
  0x200b: 'a zero-width space', 0x200c: 'a zero-width non-joiner', 0x200d: 'a zero-width joiner', 0x200e: 'a left-to-right mark',
  0x200f: 'a right-to-left mark', 0x2028: 'a line separator', 0x2029: 'a paragraph separator', 0x202a: 'a left-to-right embedding',
  0x202b: 'a right-to-left embedding', 0x202c: 'the end of a direction change', 0x202d: 'a left-to-right override',
  0x202e: 'a right-to-left override', 0x2060: 'a word joiner', 0x2066: 'a left-to-right isolate', 0x2067: 'a right-to-left isolate',
  0x2068: 'a first-strong isolate', 0x2069: 'the end of a direction isolate', 0x061c: 'an Arabic letter mark', 0xfeff: 'a zero-width no-break space',
};
// C0 controls except the tab (shown as ⇥ on its own), DEL and the C1 controls, the Arabic letter mark, zero-width
// characters and direction marks, line and paragraph separators, embeddings and overrides, word joiners and isolates,
// and the byte-order mark. Written as escapes: raw, these characters would hide in this very file.
const HIDDEN = '\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff';
const HIDDEN_RE = new RegExp(`[${HIDDEN}]`);
const HIDDEN_ALL = new RegExp(`[${HIDDEN}]`, 'g');

const hex = code => code.toString(16).toUpperCase().padStart(4, '0');

/** A hidden character as visible text: ␀…␟ for control characters, ⟦U+202E⟧ for the rest. */
function picture(ch) {
  const code = ch.codePointAt(0);
  if (PICTURES[ch]) return PICTURES[ch];
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  return `⟦U+${hex(code)}⟧`;
}
/** What a hidden character is, in words, for a title. */
function nameOf(ch) {
  const code = ch.codePointAt(0);
  if (NAMES[code]) return `Hidden here: ${NAMES[code]}.`;
  if (ch === '\r') return 'Hidden here: a carriage return (a Windows line ending).';
  if (ch === '\n') return 'Hidden here: a line break.';
  return `Hidden here: a control character (U+${hex(code)}).`;
}

/** Does this text hold a character that would be hidden or reorder what is read? */
export const hasHidden = s => HIDDEN_RE.test(String(s ?? ''));

/** Plain text with every hidden character made visible (tabs become ⇥). For text set with textContent or put in a title. */
export function visibleText(s) {
  return String(s ?? '').replace(/\t/g, '⇥').replace(HIDDEN_ALL, picture);
}

/**
 * HTML for text an agent controls: escaped, with each hidden character a marked, visible symbol (its name in a title)
 * and each tab a ⇥ that keeps the indentation (to the next stop of 4).
 */
export function visibleHtml(s) {
  const t = String(s ?? '');
  let out = '', col = 0, run = '';
  const flush = () => { if (run) { out += esc(run); run = ''; } };
  for (const ch of t) {
    if (ch === '\t') {
      flush();
      const pad = 4 - (col % 4);
      out += `<span class="vc tab" title="A tab">⇥</span>${' '.repeat(pad - 1)}`;
      col += pad;
    } else if (HIDDEN_RE.test(ch)) {
      flush();
      const pic = picture(ch);
      out += `<span class="vc" title="${esc(nameOf(ch))}">${esc(pic)}</span>`;
      col += Array.from(pic).length;
    } else { run += ch; col++; }
  }
  flush();
  return out;
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
  const head = typeof patch === 'string' ? patch.split('\n', 12).filter(l => !l.startsWith('@@')) : [];
  const facts = { link: false, exec: null };
  for (const l of head) {
    if (/^(new file|deleted file|old|new) mode 120000\b/.test(l) || /^index [0-9a-f]+\.\.[0-9a-f]+ 120000\b/.test(l)) facts.link = true;
    if (/^new mode 100755\b/.test(l)) facts.exec = 'on';
    if (/^new mode 100644\b/.test(l) && head.some(x => /^old mode 100755\b/.test(x))) facts.exec = 'off';
  }
  return facts;
}

/** The plain words in a file's header: its counts, or what it is instead. */
export function fileWords(f, facts = patchFacts(f && f.patch)) {
  if (f.binary) return 'binary file';
  if (f.large) return 'too large to show here';
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
    if (l.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l.replace(/\r$/, ''));
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
 * @param {{ maxLines?: number }} [o]  past maxLines, the rest is "and 1,240 more lines"; every file still gets its header
 */
export function diffHtml(diff, { maxLines = 4000 } = {}) {
  const files = Array.isArray(diff?.files) ? diff.files.filter(f => f && typeof f === 'object') : [];
  const left = Array.isArray(diff?.left) ? diff.left.filter(x => x && typeof x === 'object') : [];
  const omitted = n0(diff?.omitted);
  let html = '', shown = 0, rest = 0, stopped = false;
  for (const f of files) {
    const facts = patchFacts(f.patch);
    const lines = f.binary || f.large ? [] : patchLines(f.patch);
    const words = fileWords(f, facts);
    html += `<section class="df"><h3 class="dh"><span class="dp">${visibleHtml(f.path)}</span> <span class="dn">${esc(words)}</span></h3>`;
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
