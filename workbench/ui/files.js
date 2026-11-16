// The file view's pure parts: finding a file by a few letters, a folder's one level, a line to jump to, a file's own
// indentation, which rows to draw for a scroll, which lines changed when a file is read again, the words for whose copy
// it is, the path's crumbs in the room there is, and lines and paths as HTML with every hidden character shown.
// Pure: no DOM when it loads, and nothing from /shared/ (node:test loads it). fileview.js draws with these.
import { esc } from './util.js';
import { visibleHtmlAt, visibleText } from './diffview.js';
import { hiddenParts, cutMiddle } from './words.js';

// ------------------------------------------------------------------ finding a file

const CONSEC = 5, GAP_START = 3, GAP_EXT = 0.6;
const PATH_START = 8, SEGMENT = 8, WORD = 6, CAMEL = 6, IN_NAME = 2, SAME_CASE = 0.5;

/** How much a match at `j` is worth by where it falls: a path's or folder's start, a word's, a capital inside a name. */
function placeBonus(p, j, nameAt) {
  let b = j >= nameAt ? IN_NAME : 0;
  if (j === 0) return b + PATH_START;
  const before = p[j - 1], ch = p[j];
  if (before === '/') return b + SEGMENT;
  if (before === '.' || before === '_' || before === '-' || before === ' ') return b + WORD;
  if (before >= 'a' && before <= 'z' && ch >= 'A' && ch <= 'Z') return b + CAMEL;
  if (/[A-Za-z]/.test(before) && /[0-9]/.test(ch)) return b + 2;
  return b;
}

/**
 * Do the letters of `query` appear in order in `path`, and how well? Letters side by side, at the start of a folder,
 * a word or a capital, and in the file's own name count most; a shorter name wins a tie. Spaces in the query are left
 * out; case does not matter (a letter in the same case counts a little more).
 * @returns {{ score: number, hits: number[] } | null}  hits: the places in `path` of the letters matched
 */
export function fuzzyMatch(query, path, { hits: wantHits = true } = {}) {
  const q = String(query ?? '').replace(/\s+/g, '');
  const p = String(path ?? '');
  if (!q || !p) return null;
  const ql = q.toLowerCase(), pl = p.toLowerCase();
  if (pl.length !== p.length) return null;   // a lower case that changes length: no reliable places
  // quick: are the letters there in order at all?
  for (let i = 0, j = 0; i < ql.length; i++, j++) { j = pl.indexOf(ql[i], j); if (j < 0) return null; }
  const m = ql.length, n = pl.length, nameAt = p.lastIndexOf('/') + 1;
  const NEG = -1e9;
  let prev = new Float64Array(n).fill(NEG);
  const back = wantHits ? Array.from({ length: m }, () => new Int32Array(n).fill(-1)) : null;
  for (let j = 0; j < n; j++) if (pl[j] === ql[0]) prev[j] = placeBonus(p, j, nameAt) + (p[j] === q[0] ? SAME_CASE : 0);
  for (let i = 1; i < m; i++) {
    const cur = new Float64Array(n).fill(NEG);
    let run = NEG, runAt = -1;
    for (let j = 1; j < n; j++) {
      // the best earlier match with at least one letter between, less the gap
      if (j >= 2) {
        const opened = prev[j - 2] - GAP_START;
        if (run - GAP_EXT >= opened) run -= GAP_EXT; else { run = opened; runAt = j - 2; }
      }
      if (pl[j] !== ql[i]) continue;
      const side = prev[j - 1] > NEG / 2 ? prev[j - 1] + CONSEC : NEG;
      const best = Math.max(side, run);
      if (best <= NEG / 2) continue;
      cur[j] = best + placeBonus(p, j, nameAt) + (p[j] === q[i] ? SAME_CASE : 0);
      if (back) back[i][j] = side >= run ? j - 1 : runAt;
    }
    prev = cur;
  }
  let end = -1, score = NEG;
  for (let j = 0; j < n; j++) if (prev[j] > score) { score = prev[j]; end = j; }
  if (end < 0 || score <= NEG / 2) return null;
  const name = pl.slice(nameAt);
  if (name === ql) score += 20;
  else if (name.startsWith(ql)) score += 10;
  score -= 0.05 * (n - nameAt) + 0.01 * n;
  if (!back) return { score, hits: [] };
  const hits = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) { hits[i] = j; j = i > 0 ? back[i][j] : -1; }
  return { score, hits };
}

/**
 * The files whose paths hold the query's letters in order, best first, at most `max`.
 * @param {{ path: string }[]} files
 * @returns {{ path: string, hits: number[], score: number, file: object }[]}
 */
export function findFiles(files, query, { max = 12 } = {}) {
  const q = String(query ?? '').replace(/\s+/g, '');
  if (!q) return [];
  const scored = [];
  for (const f of files || []) {
    const r = f && typeof f.path === 'string' ? fuzzyMatch(q, f.path, { hits: false }) : null;
    if (r) scored.push({ f, score: r.score });
  }
  scored.sort((a, b) => b.score - a.score || (a.f.path < b.f.path ? -1 : a.f.path > b.f.path ? 1 : 0));
  return scored.slice(0, max).map(({ f }) => { const r = fuzzyMatch(q, f.path); return { path: f.path, hits: r.hits, score: r.score, file: f }; });
}

/**
 * With the field empty: the files agents changed first, then the files opened lately (that are still there and not
 * listed already), twelve in all at most.
 */
export function emptyFinder(files, recent = [], { max = 12 } = {}) {
  const byPath = new Map((files || []).map(f => [f.path, f]));
  const changed = (files || []).filter(f => Array.isArray(f.changedBy) && f.changedBy.length).slice(0, max);
  const seen = new Set(changed.map(f => f.path));
  const lately = [];
  for (const p of recent || []) {
    if (changed.length + lately.length >= max) break;
    if (seen.has(p) || !byPath.has(p)) continue;
    seen.add(p);
    lately.push(byPath.get(p));
  }
  return { changed, recent: lately };
}

/** The files opened lately, newest first: `path` goes to the front, once, and the list keeps `max`. */
export function remember(list, path, max = 8) {
  return [path, ...(list || []).filter(p => p !== path)].slice(0, max);
}

/** "40", ":40" or "line 40": the line to jump to (1 or more), else null. */
export function lineJump(text) {
  const m = /^(?::\s*|line\s*)?(\d{1,7})$/i.exec(String(text ?? '').trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
}

// ------------------------------------------------------------------ folders and the path

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const nameOrder = (a, b) => byName.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * One level of a folder, from the list of files: its folders first, then its files, each by name. A folder carries the
 * agents that changed something inside it (`marks`), a file the agents that changed it (`changedBy`).
 * @param {{ path: string, changedBy?: object[], ignored?: boolean }[]} files
 * @param {string} dir  '' for the top of the copy
 */
export function folderListing(files, dir = '') {
  const d = String(dir ?? '').replace(/\/+$/, '');
  const pre = d ? d + '/' : '';
  const folders = new Map(), out = [];
  for (const f of files || []) {
    if (!f || typeof f.path !== 'string' || !f.path.startsWith(pre)) continue;
    const rest = f.path.slice(pre.length);
    const slash = rest.indexOf('/');
    if (slash < 0) { out.push({ name: rest, path: f.path, changedBy: f.changedBy || null, ignored: !!f.ignored }); continue; }
    const name = rest.slice(0, slash);
    let k = folders.get(name);
    if (!k) { k = { name, path: pre + name, marks: [] }; folders.set(name, k); }
    for (const a of f.changedBy || []) if (!k.marks.some(x => x.agentId === a.agentId)) k.marks.push(a);
  }
  return { folders: [...folders.values()].sort(nameOrder), files: out.sort(nameOrder) };
}

/** A path's name and its folder ('' at the top). */
export function nameAndDir(path) {
  const p = String(path ?? '');
  const i = p.lastIndexOf('/');
  return { name: p.slice(i + 1), dir: i < 0 ? '' : p.slice(0, i) };
}

/**
 * The crumbs of a path: the copy's name (the top folder), each folder (each one opens), and the file; for a folder
 * shown, its own name last (`here`).
 */
export function crumbsOf(name, path, { folder = false } = {}) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  const out = [{ label: name || 'files', dir: '' }];
  let at = '';
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    at = at ? at + '/' + seg : seg;
    if (last && !folder) out.push({ label: seg, file: true });
    else out.push(last ? { label: seg, dir: at, here: true } : { label: seg, dir: at });
  });
  if (!parts.length && folder) out[0].here = true;
  return out;
}

/**
 * The crumbs in the room there is: whole when they fit; else the folders in the middle give way (one gap, "…") from the
 * top down, keeping the copy's name, the file's own folder and the file; then the file's own name is cut in its middle.
 * @param {{ label: string }[]} crumbs  from crumbsOf
 * @param {{ widthOf: (text: string, bold: boolean) => number, sep: number, maxW: number }} o
 */
export function fitCrumbs(crumbs, { widthOf, sep, maxW }) {
  const bold = c => !!(c.file || c.here);
  const width = list => list.reduce((s, c) => s + widthOf(c.label, bold(c)), 0) + sep * Math.max(0, list.length - 1);
  if (width(crumbs) <= maxW) return crumbs;
  const gap = { gap: true, label: '…' };
  const first = crumbs[0], last = crumbs[crumbs.length - 1];
  let middle = crumbs.slice(1, -1);
  while (middle.length > 1) {
    middle = middle.slice(1);
    const tryList = [first, gap, ...middle, last];
    if (width(tryList) <= maxW) return tryList;
  }
  let shown = crumbs.length > 2 ? [first, gap, last] : [first, last];
  if (middle.length === 1 && crumbs.length > 2 && width([first, gap, middle[0], last]) <= maxW) return [first, gap, middle[0], last];
  if (width(shown) <= maxW) return shown;
  // the file's own name, cut in its middle to the room left
  const room = maxW - width(shown.slice(0, -1)) - sep;
  const per = Math.max(1, widthOf('M', bold(last)));
  const label = cutMiddle(last.label, Math.max(5, Math.floor(room / per)));
  shown = [...shown.slice(0, -1), { ...last, label, cut: true }];
  return shown;
}

// ------------------------------------------------------------------ editing

/**
 * The file's own indentation, for Tab: a tab when most indented lines start with one, else the usual step of spaces
 * between lines (2 when the file does not say). A comment's " * " is not indentation.
 */
export function guessIndent(text) {
  const lines = String(text ?? '').split('\n', 4000);
  let tabs = 0, spaces = 0, prev = 0;
  const steps = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const lead = /^[\t ]*/.exec(line)[0];
    if (lead.startsWith('\t')) { tabs++; continue; }
    const n = lead.length;
    if (/^ +\*/.test(line)) continue;
    if (n) spaces++;
    const d = Math.abs(n - prev);
    if (d >= 2 && d <= 8) steps.set(d, (steps.get(d) || 0) + 1);
    prev = n;
  }
  if (tabs > spaces) return '\t';
  let best = 0, count = 0;
  for (const [d, c] of steps) if (c > count || (c === count && d < best)) { best = d; count = c; }
  return ' '.repeat(best || 2);
}

// ------------------------------------------------------------------ drawing rows

/**
 * Which rows to draw for a scroll: the rows that show, and some more either side, in chunks, so a small scroll draws
 * nothing new. [first, last).
 */
export function rowWindow({ top, height, lineH, total, overscan = 30, chunk = 20 }) {
  const visFirst = Math.max(0, Math.floor(top / lineH)), visLast = Math.ceil((top + height) / lineH);
  const first = Math.max(0, Math.floor((visFirst - overscan) / chunk) * chunk);
  const last = Math.min(total, Math.ceil((visLast + overscan) / chunk) * chunk);
  return { first, last: Math.max(first, last) };
}

/** Does the window drawn still cover the rows that show, with a few to spare? Then nothing needs drawing again. */
export function windowCovers(win, { top, height, lineH, total, margin = 10 }) {
  const visFirst = Math.max(0, Math.floor(top / lineH)), visLast = Math.min(total, Math.ceil((top + height) / lineH));
  return (win.first === 0 || win.first <= visFirst - margin) && (win.last >= total || win.last >= visLast + margin);
}

/** A file's text as rows: split at line breaks, a last line break making no row of its own; an empty file one row. */
export function splitLines(text) {
  const rows = String(text ?? '').split('\n');
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * The lines of `after` that are new since `before` (a file read again, 1-based): the stretch between what both share at
 * the top and the bottom, less the lines that were there before and only moved. Nothing on a first read.
 */
export function freshLines(before, after, { max = 4000 } = {}) {
  if (before == null) return [];
  const a = splitLines(before), b = splitLines(after);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const was = new Map();
  for (const l of a.slice(s, a.length - e)) was.set(l, (was.get(l) || 0) + 1);
  const out = [];
  for (let j = s; j < b.length - e && out.length < max; j++) {
    const l = b[j], k = was.get(l) || 0;
    if (k) { was.set(l, k - 1); continue; }
    out.push(j + 1);
  }
  return out;
}

// ------------------------------------------------------------------ words

const lines = n => `${n} line${n === 1 ? '' : 's'} changed`;

/**
 * Whose copy it is, in plain words: "In Invoice export’s copy · 7 lines changed · show yours", or "Your folder · main",
 * with "· Invoice export changed it · show its copy" when agents changed the file.
 * @param {{ where: string, agent?: { id: string, name: string }, changed?: number, branch?: string|null,
 *   changedBy?: { agentId: string, name: string, state: string }[] }} o
 */
export function whoseLine({ where, agent = null, changed = 0, branch = null, changedBy = [] }) {
  if (where !== 'you') {
    const name = agent && agent.name ? agent.name : 'the agent';
    return { lead: `In ${name}’s copy`, rest: changed > 0 ? [lines(changed)] : [], link: { label: 'show yours', to: 'you' } };
  }
  const out = { lead: 'Your folder', rest: [branch || 'not on a branch'], link: null };
  const by = (changedBy || []).filter(a => a && typeof a.agentId === 'string');
  if (!by.length) return out;
  const first = by[0];
  out.agent = first;
  out.changedIt = by.length === 1 ? `${first.name} changed it` : by.length === 2 ? `${first.name} and ${by[1].name} changed it` : `${first.name} and ${by.length - 1} more changed it`;
  out.link = { label: by.length === 1 ? 'show its copy' : `show ${first.name}’s copy`, to: first.agentId };
  return out;
}

// ------------------------------------------------------------------ search results

/** Results of a search: the open file's first (by line), then the rest as they came; at most `max`. */
export function orderSearch(results, openPath, max = 30) {
  const all = (results || []).filter(r => r && typeof r.path === 'string');
  const mine = all.filter(r => r.path === openPath).sort((x, y) => x.line - y.line);
  return [...mine, ...all.filter(r => r.path !== openPath)].slice(0, max);
}

/** Where `query` is in `text`: [start, end) pairs, side by side, in any case unless the query has a capital. */
export function matchRanges(text, query) {
  const t = String(text ?? ''), q = String(query ?? '');
  if (!q) return [];
  const icase = !/\p{Lu}/u.test(q);
  const ql = icase ? q.toLowerCase() : q;
  const out = [];
  for (let i = 0; i + q.length <= t.length;) {
    const piece = t.slice(i, i + q.length);
    if ((icase ? piece.toLowerCase() : piece) === ql) { out.push([i, i + q.length]); i += q.length; } else i++;
  }
  return out;
}

/** Text cut to `max` characters around its first match, with "…" where it was cut; the ranges moved with it. */
export function cutAround(text, ranges, max) {
  const t = String(text ?? '');
  if (t.length <= max) return { text: t, ranges: (ranges || []).map(r => [...r]) };
  const r0 = (ranges && ranges[0]) || [0, 0];
  const room = Math.max(4, max - 2);
  let start = Math.max(0, r0[0] - Math.floor(Math.max(0, room - (r0[1] - r0[0])) / 3));
  let end = Math.min(t.length, start + room);
  if (end - start < room) start = Math.max(0, end - room);
  // never through a character past U+FFFF
  if (start > 0 && /[\uDC00-\uDFFF]/.test(t[start])) start++;
  if (end < t.length && /[\uD800-\uDBFF]/.test(t[end - 1])) end--;
  const lead = start > 0 ? '…' : '', tail = end < t.length ? '…' : '';
  const shift = lead.length - start;
  const moved = (ranges || []).map(([s, e]) => [Math.max(s, start) + shift, Math.min(e, end) + shift]).filter(([s, e]) => e > s);
  return { text: lead + t.slice(start, end) + tail, ranges: moved };
}

/** Places matched one by one (a file's letters) as runs: [start, end) pairs. */
export function hitRanges(hits) {
  const out = [];
  for (const h of [...(hits || [])].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[1] = h + 1; else out.push([h, h + 1]);
  }
  return out;
}

/** Text an agent controls as HTML, its matched runs in bold, every hidden character shown (tab stops kept). */
export function markedHtml(text, ranges, col = 0) {
  const t = String(text ?? '');
  let html = '', at = 0;
  for (const [s, e] of ranges || []) {
    if (s > at) { const r = visibleHtmlAt(t.slice(at, s), col); html += r.html; col = r.col; }
    const r = visibleHtmlAt(t.slice(s, e), col);
    html += `<b>${r.html}</b>`;
    col = r.col;
    at = e;
  }
  if (at < t.length) html += visibleHtmlAt(t.slice(at), col).html;
  return html;
}

// ------------------------------------------------------------------ a line of code

/**
 * A row's HTML from its coloured parts ([kind, text], as highlight.js gives them): each kind a span, every hidden
 * character a visible symbol, and tabs stopping where the whole line's would.
 */
export function lineHtml(parts) {
  let html = '', col = 0;
  for (const [kind, text] of parts || []) {
    const r = visibleHtmlAt(text, col);
    col = r.col;
    html += kind ? `<span class="h${kind}">${r.html}</span>` : r.html;
  }
  return html;
}

/** How many columns a line takes as the view shows it: tabs to their stops of 4, hidden characters as their symbols. */
export function visibleCols(line) {
  const s = String(line ?? '');
  const ps = hiddenParts(s);
  if (ps.length <= 1 && !(ps[0] && ps[0].hidden)) return s.length;
  return visibleHtmlAt(s, 0).col;
}

/** A path as plain words with its hidden characters shown, for a title or a name read aloud. */
export const shownPath = p => visibleText(String(p ?? ''));
/** A path as HTML, every hidden character shown. */
export const pathHtml = p => visibleHtmlAt(String(p ?? ''), 0).html;
export { esc };
