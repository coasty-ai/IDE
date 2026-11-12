// An agent's changes, for people to read: one section per file with a plain header, then its lines with visible + and
// − marks (and words for screen readers), long lines wrapped by the page, never scrolled sideways.
// Everything an agent controls goes through esc(), and characters that could hide or reorder text are shown as visible
// symbols, never raw: control characters, bidirectional overrides and isolates, and zero-width characters.
// Pure: no DOM, no imports (node:test loads it).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

const PICTURES = { '\n': '⏎', '\r': '␍', '\x7f': '␡' };
// Characters that are invisible or change the direction of the text around them. Each is shown as ⟦U+XXXX⟧.
const NAMES = {
  0x200b: 'a zero-width space', 0x200c: 'a zero-width non-joiner', 0x200d: 'a zero-width joiner', 0x200e: 'a left-to-right mark',
  0x200f: 'a right-to-left mark', 0x2028: 'a line separator', 0x2029: 'a paragraph separator', 0x202a: 'a left-to-right embedding',
  0x202b: 'a right-to-left embedding', 0x202c: 'the end of a direction change', 0x202d: 'a left-to-right override',
  0x202e: 'a right-to-left override', 0x2060: 'a word joiner', 0x2066: 'a left-to-right isolate', 0x2067: 'a right-to-left isolate',
  0x2068: 'a first-strong isolate', 0x2069: 'the end of a direction isolate', 0x061c: 'an Arabic letter mark', 0xfeff: 'a zero-width no-break space',
};
const HIDDEN_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f؜​-‏ -‮⁠-⁩﻿]/;
const HIDDEN_ALL = new RegExp(HIDDEN_RE.source, 'g');

/** A hidden character as visible text: ␀…␟ for control characters, ⟦U+202E⟧ for the rest. */
function picture(ch) {
  const code = ch.codePointAt(0);
  if (PICTURES[ch]) return PICTURES[ch];
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  return `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧`;
}
/** What a hidden character is, in words, for a title. */
function nameOf(ch) {
  const code = ch.codePointAt(0);
  if (NAMES[code]) return `Hidden here: ${NAMES[code]}.`;
  if (ch === '\r') return 'Hidden here: a carriage return (Windows line ending).';
  return `Hidden here: a control character (U+${code.toString(16).toUpperCase().padStart(4, '0')}).`;
}

/** Plain text with every hidden character made visible (tabs become ⇥). For text the page sets with textContent. */
export function visibleText(s) {
  return String(s ?? '').replace(/\t/g, '⇥').replace(HIDDEN_ALL, picture);
}

/**
 * HTML for text an agent controls: escaped, with each hidden character a marked, visible symbol and each tab a ⇥ that
 * keeps the indentation (to the next stop of 4).
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
const count = n => n0(n).toLocaleString('en-US');
const plural = (n, one, many = one + 's') => `${count(n)} ${n0(n) === 1 ? one : many}`;

/** The plain words in a file's header: its counts, or what it is instead. */
export function fileWords(f) {
  if (f.binary) return 'binary file';
  if (f.large) return 'too large to show here';
  if (f.status === 'added') return `new file, +${count(f.adds)}`;
  if (f.status === 'deleted') return `deleted, −${count(f.dels)}`;
  return `+${count(f.adds)} −${count(f.dels)}`;
}

/** Why a file stays out of the merge, in words. */
export function leftWords(why) {
  if (why === 'nested-repo') return 'Not merged: it is a separate repository inside its folder';
  return 'Not merged: hidden by a .gitignore it changed';
}

/** The lines of one file's unified diff: its hunks, with the git headers before the first hunk dropped. */
export function patchLines(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const raw = patch.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const out = [];
  let inHunk = false;
  for (const l of raw) {
    if (l.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l.replace(/\r$/, ''));
      out.push({ t: 'hunk', line: m ? Number(m[1]) : null, ctx: m ? m[2] : '' });
      continue;
    }
    if (!inHunk) continue;
    const c = l.charAt(0);
    if (c === '+') out.push({ t: 'add', s: l.slice(1) });
    else if (c === '-') out.push({ t: 'del', s: l.slice(1) });
    else if (c === '\\') out.push({ t: 'note' });
    else out.push({ t: 'ctx', s: l.charAt(0) === ' ' ? l.slice(1) : l });
  }
  return out;
}

const textLines = ls => ls.filter(l => l.t === 'add' || l.t === 'del' || l.t === 'ctx').length;

/**
 * The diff as HTML.
 * @param {{ files?: object[], left?: { path: string, why: string }[], cut?: boolean, omitted?: number }} diff  workDiff's shape
 * @param {{ maxLines?: number }} [o]  past maxLines, the rest is "and 1,240 more lines"
 */
export function diffHtml(diff, { maxLines = 4000 } = {}) {
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const left = Array.isArray(diff?.left) ? diff.left : [];
  const omitted = n0(diff?.omitted);
  let html = '', shown = 0, rest = 0, stopped = false;
  for (const f of files) {
    const lines = f.binary || f.large ? [] : patchLines(f.patch);
    if (stopped) { rest += textLines(lines); continue; }
    html += `<section class="df"><h4 class="dh"><span class="dp">${visibleHtml(f.path)}</span><span class="dn">${esc(fileWords(f))}</span></h4>`;
    if (!f.binary && !f.large && !lines.length) html += '<p class="dq">No lines to show: only its details changed.</p>';
    if (lines.length) {
      html += '<div class="dlines">';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.t !== 'hunk' && l.t !== 'note' && shown >= maxLines) { stopped = true; rest += textLines(lines.slice(i)); break; }
        if (l.t === 'hunk') html += `<div class="dhunk">${l.line ? `line ${count(l.line)}` : 'a change'}${l.ctx ? ` <span class="dctx">${visibleHtml(l.ctx)}</span>` : ''}</div>`;
        else if (l.t === 'note') html += '<div class="dnote">no line break at the end of the file</div>';
        else {
          shown++;
          const g = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
          const word = l.t === 'add' ? '<span class="sr">added: </span>' : l.t === 'del' ? '<span class="sr">removed: </span>' : '';
          html += `<div class="dl ${l.t}"><span class="dg" aria-hidden="true">${g}</span>${word}<span class="dt">${visibleHtml(l.s) || ' '}</span></div>`;
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
    html += `<section class="df dleft"><h4 class="dh"><span class="dp">${esc(plural(left.length, 'file'))} not merged</span></h4><ul>`;
    for (const x of left) html += `<li><span class="dp">${visibleHtml(x.path)}</span> <span class="dw">${esc(leftWords(x.why))}</span></li>`;
    html += '</ul></section>';
  }
  if (!files.length && !left.length && !omitted) html = '<p class="dq">No changes.</p>';
  return html;
}
