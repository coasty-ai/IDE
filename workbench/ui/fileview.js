// The file view: the core's lid grown into a wide sheet in the middle, one file at a time. Its head is the path you can
// click (each folder opens), Edit, and ✕; under it, whose copy it is; then the code, with line numbers, gentle colours,
// an agent's changed lines marked with a gold bar, every hidden character shown; at the bottom, the field that finds a
// file, jumps to a line, or finds words in the files. Edit swaps the code for a plain text box at the same place.
//
// The sheet opens at once and grows out of the lid (or out of the path clicked on the git screen); the file fades in
// when it arrives, and is read again every 2 seconds while it shows, so it never goes stale. Rows are drawn in a window
// that follows the scroll, and coloured as states are read down the file in idle slices, so a file of 25,000 lines
// never stutters. app.js sets it up once (setupFiles) and hands it the keys while it shows (filesKey).
import { api } from './api.js';
import * as F from './files.js';
import { tokenizeLine, langOf } from './highlight.js';
import { visibleControls, hiddenParts } from './words.js';
import { esc } from './util.js';
import { markOfAgent } from './look.js';
import { S, STATES } from './model.js';
import { sizeClass } from './layout.js';

const $ = id => document.getElementById(id);
const POLL_MS = 2000;
const GROW_MS = 300, SHRINK_MS = 250;
const EASE_OUT = 'cubic-bezier(.2,.7,.2,1)', EASE_IN_OUT = 'cubic-bezier(.4,0,.2,1)';
// type and spacing for each size class: the code's size and line height, the sheet's padding
const SHEET = {
  S: { code: 12, lh: 19, padX: 20, padT: 16, padB: 14, path: 12.5, name: 14.5, whose: 11.5 },
  M: { code: 12.5, lh: 20, padX: 24, padT: 19, padB: 16, path: 13, name: 15, whose: 12 },
  L: { code: 13, lh: 21, padX: 30, padT: 22, padB: 18, path: 13.5, name: 16, whose: 12.5 },
};
const CODE_PAD = { top: 8, bottom: 18, left: 14, right: 28 };
const KINDS_WITHOUT_TEXT = new Set(['binary', 'large', 'notutf8', 'link', 'missing']);
/** What leaving the editor asks first for, when the person only leaves the editor (and stays on the file). */
const STAY = () => {};

let ctx = null, el = null;
const st = {
  open: false, moving: null, anims: [], opener: null, openerKey: null, origin: null, restore: null,
  where: 'you',
  list: { where: null, files: null, name: null, branch: null, truncated: false, seq: 0, error: null },
  view: 'folder', dir: '', back: null,
  file: null, seq: 0, loadingPath: null, note: null,
  edit: null, ask: null, saving: false,
  recent: [],
  find: { q: '', active: 0, items: [], mode: 'find', search: { q: '', seq: 0, results: null, error: null, truncated: false, timer: 0 } },
  poll: 0, polling: false,
  fresh: { lines: new Set(), until: 0 },
  win: { first: -1, last: -1, key: '' },
  geo: null, scan: 0, saidTimer: 0, noteTimer: 0,
};

/** Is the sheet shown (or on its way)? The lid holds while it is, and the board takes no keys. */
export const filesShown = () => st.open;

/**
 * @param {object} c { getG, measure, still, reduced, onShow(shown), toLid(id), looksLikeSecret(text), home(), isMac }
 *   onShow(true) closes the board's menus and card and stops voice; toLid(id) puts that agent in the lid (from the
 *   needs-you pill); home() is where the keyboard goes when what opened the sheet is gone.
 */
export function setupFiles(c) {
  ctx = c;
  el = {
    html: document.documentElement, dialog: $('fileSheet'), sheet: $('fvSheet'), shade: document.querySelector('#fileSheet .fv-shade'),
    title: $('fvTitle'), needs: $('fvNeeds'), acts: $('fvActs'), close: $('fvClose'), whose: $('fvWhose'), body: $('fvBody'),
    code: $('fvCode'), sizer: $('fvSizer'), rows: $('fvRows'), edit: $('fvEdit'), esizer: $('fvEsizer'), enums: $('fvEnums'), text: $('fvText'),
    list: $('fvList'), note: $('fvNote'), bar: $('fvBar'), find: $('fvFind'), ph: $('fvPh'), key: $('fvKey'), said: $('fvSaid'),
  };
  try { st.recent = JSON.parse(sessionStorage.getItem('wb-files-recent') || '[]').filter(p => typeof p === 'string').slice(0, 8); } catch { st.recent = []; }
  el.key.textContent = c.isMac ? '⌘P' : 'Ctrl P';
  el.close.addEventListener('click', () => closeFiles());
  el.needs.addEventListener('click', () => {
    const id = el.needs.dataset.agent;
    guard(() => closeFiles({ toLid: true, id, force: true }));
  });
  el.title.addEventListener('click', e => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    const dir = b.dataset.dir;
    guard(() => showFolder(dir, { focusField: true }));
  });
  el.acts.addEventListener('click', e => {
    const b = e.target.closest('button[data-fv]');
    if (b) act(b.dataset.fv, b);
  });
  el.whose.addEventListener('click', e => {
    const b = e.target.closest('button[data-fv]');
    if (b) act(b.dataset.fv, b);
  });
  el.list.addEventListener('mousemove', e => {
    const o = e.target.closest('[role="option"]');
    if (o && +o.dataset.i !== st.find.active) { st.find.active = +o.dataset.i; markActive(); }
  });
  el.list.addEventListener('click', e => {
    const o = e.target.closest('[role="option"]');
    if (o) choose(+o.dataset.i);
  });
  el.bar.addEventListener('submit', e => { e.preventDefault(); choose(st.find.active); });
  el.find.addEventListener('input', onFindInput);
  el.find.addEventListener('keydown', onFindKey);
  el.code.addEventListener('scroll', () => drawRows());
  el.edit.addEventListener('scroll', () => drawEditNums());
  el.text.addEventListener('input', onTextInput);
  el.text.addEventListener('keydown', onTextKey);
  // a click outside the sheet (one that also began there, so a selection dragged past its edge does not) closes it
  let downOutside = false;
  const outside = e => { const r = el.dialog.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  el.dialog.addEventListener('pointerdown', e => { downOutside = outside(e); });
  el.dialog.addEventListener('click', e => { if (downOutside && outside(e)) closeFiles(); downOutside = false; });
  // Esc is the page's (app.js hands it to filesEscape); any other way the dialog is asked to close comes here
  el.dialog.addEventListener('cancel', e => { e.preventDefault(); filesEscape(); });
  el.dialog.addEventListener('close', () => { if (st.open && st.moving !== 'out') finishClose(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && st.open) pollSoon(0); });
}

// ---------------------------------------------------------------- opening and closing

/**
 * Open the sheet (or, when it shows, go where asked). `mode`: 'find' (⌘P: the finder focused, with files agents changed
 * and files opened lately), 'search' (⌘⇧F: the same field, for words in the files), or 'browse' (the files chip: the
 * file shown last, else the top folder). With `path`, that file opens in `where`'s copy, at `line`. `origin` is the
 * rectangle the sheet grows from (the lid's, or the path clicked); `opener` gets the keyboard back when it closes.
 */
export function openFiles({ opener = null, where = null, path = null, line = null, mode = 'browse', origin = null } = {}) {
  if (!ctx) return;
  const first = !st.open;
  if (first) {
    const ae = document.activeElement;
    st.opener = opener && opener.isConnected ? opener : (ae && ae !== document.body && !el.dialog.contains(ae) ? ae : null);
    st.openerKey = st.opener && st.opener.dataset ? st.opener.dataset.key || null : null;
    st.open = true;
    ctx.onShow(true);
    el.html.dataset.files = 'open';
    try { el.dialog.showModal(); } catch { try { el.dialog.show(); } catch { st.open = false; return; } }
    layout();
    grow(origin);
    startPoll();
  }
  if (where && where !== st.where) { st.where = where; st.list.where = null; }
  loadList();
  if (path) { openFile(path, { line, focus: 'code' }); return; }
  if (mode === 'find' || mode === 'search') {
    if (st.edit && !first) { focusField(true); return; }
    st.find.mode = mode;
    if (st.view !== 'find') st.back = backOf();
    st.view = 'find';
    st.find.q = '';
    el.find.value = '';
    st.find.active = 0;
    paint();
    focusField(true);
    return;
  }
  if (first) {
    if (st.file && st.file.in === st.where && st.file.rows) { st.view = 'file'; paint(); drawRows(true); focusCode(); pollSoon(); }
    else if (st.file) openFile(st.file.path, { focus: 'code' });
    else { showFolder(st.dir || '', { focusField: true }); }
  }
}

/** Close the sheet: it shrinks back into what it grew from, and the keyboard goes back to what opened it. */
export function closeFiles({ toLid = false, id = null, force = false } = {}) {
  if (!st.open || st.moving === 'out') return;
  if (!force && editChanged()) { askLeave(() => closeFiles({ toLid, id, force: true })); return; }
  st.edit = null; st.ask = null;
  stopPoll();
  delete el.html.dataset.files;
  st.restore = { toLid, id };
  shrink();
}

function finishClose() {
  for (const a of st.anims) a.cancel();
  st.anims = [];
  st.moving = null;
  st.open = false;
  stopPoll();
  delete el.html.dataset.files;
  if (el.dialog.open) el.dialog.close();
  const { toLid = false, id = null } = st.restore || {};
  st.restore = null;
  ctx.onShow(false);
  if (toLid) { ctx.toLid(id); return; }
  let to = st.opener && st.opener.isConnected && !st.opener.closest('[inert]') ? st.opener : null;
  if (!to && st.openerKey) to = document.querySelector(`[data-key="${CSS.escape(st.openerKey)}"]`);
  focusOn(to && !to.closest('[inert]') ? to : ctx.home());
  st.opener = null; st.openerKey = null;
}

/** The sheet's place: about three quarters of the board's width, from under the top band to just above its bottom edge. */
function layout() {
  const W = innerWidth, H = innerHeight, G = ctx.getG();
  const P = G ? G.P : sizeClass(W, H);
  const bd = G ? G.board : { x: 8, y: 8, w: W - 16, h: H - 16, r: W - 8, b: H - 8 };
  const z = SHEET[P.name] || SHEET.M;
  const w = Math.min(Math.round(bd.w * 0.76), 1640);
  const x = Math.round((W - w) / 2);
  const y = Math.round(bd.y + P.topBand - 6);
  const h = Math.round(bd.b - (P.name === 'L' ? 24 : 16) - y);
  Object.assign(el.dialog.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const s = el.dialog.style;
  const vars = { '--fv-code': z.code + 'px', '--fv-lh': z.lh + 'px', '--fv-px': z.padX + 'px', '--fv-pt': z.padT + 'px', '--fv-pb': z.padB + 'px',
    '--fv-path': z.path + 'px', '--fv-name': z.name + 'px', '--fv-whose': z.whose + 'px' };
  for (const k in vars) if (s.getPropertyValue(k) !== vars[k]) s.setProperty(k, vars[k]);
  const charW = ctx.measure('M', z.code, 400);
  const key = [w, h, z.code, z.lh, charW].join('|');
  const changed = !st.geo || st.geo.key !== key;
  st.geo = { key, x, y, w, h, z, P, charW, lh: z.lh };
  return changed;
}

/** The window changed size, or the look did: the sheet keeps its place in proportion, and its rows are drawn again. */
export function filesRender() {
  if (!st.open || !el) return;
  if (layout()) { st.win.key = ''; paint(); drawRows(true); }
}

/** The clip that shows `r` (a rectangle on screen) of the sheet, whose box is `box`: the lid's cut corner, or its rounding. */
function clipFor(r, box) {
  const cs = getComputedStyle(el.sheet);
  const cut = parseFloat(cs.getPropertyValue('--lid-cut')) || 0, round = parseFloat(cs.getPropertyValue('--lid-radius')) || 0;
  const l = r.left - box.left, t = r.top - box.top, rr = r.right - box.left, b = r.bottom - box.top;
  if (cut > 0) { const k = Math.min(cut, (rr - l) / 3, (b - t) / 3); return `polygon(${l + k}px ${t}px, ${rr}px ${t}px, ${rr}px ${b}px, ${l}px ${b}px, ${l}px ${t + k}px)`; }
  return `inset(${t}px ${box.width - rr}px ${box.height - b}px ${l}px round ${round}px)`;
}

/** Where the sheet grows from: the rectangle asked for, else the lid's, else a small one in the middle. */
function originRect(origin) {
  const ok = r => r && r.width > 4 && r.height > 4;
  if (ok(origin)) return origin;
  const core = $('core');
  const board = $('boardScreen');
  if (core && board && !board.inert && el.html.dataset.screen !== 'git') { const r = core.getBoundingClientRect(); if (ok(r)) return r; }
  const box = el.dialog.getBoundingClientRect();
  const w = box.width * 0.36, h = box.height * 0.36;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, right: box.left + (box.width + w) / 2, bottom: box.top + (box.height + h) / 2, width: w, height: h };
}

/**
 * The sheet grows out of `origin` in 300 ms, easing out: the lid's own surface widens into the sheet, its words fade in
 * as it lands, and its shadow settles under it. Under reduced motion it fades in briefly; with still=1 or a hidden tab
 * it is simply there. Its rest is its own style, never an animation's last frame.
 */
function grow(origin) {
  for (const a of st.anims) a.cancel();
  st.anims = [];
  st.origin = origin && origin.width ? origin : null;
  if (ctx.still() || document.hidden) return;
  if (ctx.reduced()) { st.anims.push(el.dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' })); return; }
  st.moving = 'in';
  const box = el.dialog.getBoundingClientRect(), from = originRect(origin);
  const a = el.sheet.animate([{ clipPath: clipFor(from, box), opacity: 0.35 }, { opacity: 1, offset: 0.3 }, { clipPath: clipFor(box, box), opacity: 1 }], { duration: GROW_MS, easing: EASE_OUT });
  st.anims.push(a);
  for (const k of el.sheet.children) st.anims.push(k.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: 130, easing: EASE_OUT, fill: 'backwards' }));
  st.anims.push(el.shade.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 170, delay: GROW_MS - 120, easing: 'ease-out', fill: 'backwards' }));
  const done = () => { if (st.moving === 'in') st.moving = null; };
  a.finished.then(done, done);
}

/** Back into what it grew from: its words go first, then it narrows into the lid (or the path) and is gone. */
function shrink() {
  for (const a of st.anims) a.cancel();
  st.anims = [];
  if (ctx.still() || ctx.reduced() || document.hidden) { finishClose(); return; }
  st.moving = 'out';
  const box = el.dialog.getBoundingClientRect(), to = originRect(st.origin);
  for (const k of el.sheet.children) st.anims.push(k.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-in', fill: 'forwards' }));
  st.anims.push(el.shade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' }));
  const a = el.sheet.animate([{ clipPath: clipFor(box, box), opacity: 1 }, { opacity: 1, offset: 0.7 }, { clipPath: clipFor(to, box), opacity: 0 }], { duration: SHRINK_MS, delay: 60, easing: EASE_IN_OUT, fill: 'forwards' });
  st.anims.push(a);
  const done = () => { if (st.moving === 'out') finishClose(); };
  a.finished.then(done, done);
}

// ---------------------------------------------------------------- focus

function focusOn(e) {
  if (!e) return;
  e.focus({ preventScroll: true });
  if (document.activeElement === e) return;
  requestAnimationFrame(() => { const ae = document.activeElement; if (e.isConnected && (!ae || ae === document.body)) e.focus({ preventScroll: true }); });
}
function focusField(select = false) { focusOn(el.find); if (select) el.find.select(); }
function focusCode() { if (!el.code.hidden) focusOn(el.code); else focusField(); }

// ---------------------------------------------------------------- the files of a copy

/** The list of files of the copy shown (GET /api/files), for the finder and the folders: read each time the sheet opens. */
function loadList() {
  const where = st.where, seq = ++st.list.seq;
  if (st.list.where !== where) Object.assign(st.list, { where, files: null, name: null, branch: null, truncated: false, error: null });
  api.files(where).then(r => {
    if (seq !== st.list.seq || st.where !== where) return;
    if (!r.ok) { st.list.error = visibleControls(r.reply); st.list.files = st.list.files || []; }
    else Object.assign(st.list, { files: Array.isArray(r.files) ? r.files.filter(f => f && typeof f.path === 'string') : [], name: typeof r.name === 'string' ? r.name : null,
      branch: typeof r.branch === 'string' ? r.branch : null, truncated: !!r.truncated, error: null });
    paint();
  }, err => {
    if (seq !== st.list.seq) return;
    st.list.error = visibleControls(err.message);
    st.list.files = st.list.files || [];
    paint();
  });
}

const repoName = () => st.list.name || (S.meta && S.meta.repo && S.meta.repo.name) || null;
const agentOf = id => (id && id !== 'you' ? S.agents.get(id) || null : null);
const markHtml = (a, cls = 'k') => { if (!a) return ''; const m = markOfAgent(a, STATES.LOOK); return `<svg class="g ${cls}-${m.tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${m.shape}"/></svg>`; };
const changedOf = path => (st.list.files || []).find(f => f.path === path)?.changedBy || null;

// ---------------------------------------------------------------- a file

/**
 * Open a file of the copy shown. The sheet shows it at once (the code fades in when it arrives); `line` is shown a third
 * of the way down and briefly marked; `keep` keeps the line at the top where it was (switching copies, reading again).
 */
function openFile(path, { line = null, keep = null, focus = null } = {}) {
  const where = st.where, seq = ++st.seq;
  st.view = 'file';
  st.loadingPath = path;
  st.edit = null; st.ask = null; st.note = null;
  if (!st.file || st.file.path !== path || st.file.in !== where) {
    st.file = { in: where, path, kind: null, loading: true };
    el.code.classList.add('fv-wait');
  }
  remember(path);
  paint();
  if (focus === 'code') focusCode();
  const slow = setTimeout(() => { if (seq === st.seq && st.file && st.file.loading) { st.note = { text: `Reading ${F.nameAndDir(path).name}…`, quiet: true }; paint(); } }, 450);
  api.file(where, path).then(r => {
    clearTimeout(slow);
    if (seq !== st.seq) return;
    st.loadingPath = null;
    if (!r.ok) { st.file = { in: where, path, kind: 'refused', reply: visibleControls(r.reply), why: r.why }; st.note = null; paint(); return; }
    show(r, { line, keep });
    if (focus === 'code') focusCode();
    say(`${F.shownPath(F.nameAndDir(path).name)}${r.lines ? `, ${r.lines} line${r.lines === 1 ? '' : 's'}` : ''}.`);
  }, err => {
    clearTimeout(slow);
    if (seq !== st.seq) return;
    st.loadingPath = null;
    st.file = { in: where, path, kind: 'refused', reply: visibleControls(err.message) };
    paint();
  });
}

/** An answer of GET /api/file, shown: its rows, colours read in idle slices, its changed lines, at the place asked for. */
function show(r, { line = null, keep = null, fresh = null } = {}) {
  const text = typeof r.text === 'string' ? r.text : null;
  const rows = text != null ? F.splitLines(text) : [];
  let maxCols = 0;
  for (const row of rows) if (row.length > maxCols) maxCols = row.length;
  st.file = {
    in: r.in || st.where, path: r.path, kind: r.kind, text, hash: typeof r.hash === 'string' ? r.hash : null, size: r.size || 0, lines: r.lines || rows.length, link: r.link || null,
    eol: r.eol, bom: !!r.bom, editable: r.editable === true, why: typeof r.why === 'string' ? r.why : null,
    changed: new Set(Array.isArray(r.changedLines) ? r.changedLines.filter(n => Number.isInteger(n)) : []),
    rows, lang: langOf(r.path), states: [''], scanned: 0, maxCols: Math.max(maxCols, 20), html: new Map(), loading: false,
  };
  // "Reading export.ts…" goes; a note said in the line under the path (a save's, the demo's) stays its time
  if (st.note && st.note.quiet) st.note = null;
  st.view = 'file';
  st.fresh = fresh ? { lines: new Set(fresh), until: performance.now() + 1700 } : { lines: new Set(line ? [line] : []), until: line ? performance.now() + 1700 : 0 };
  st.win.key = '';
  paint();
  // the place: a line asked for (a third of the way down), the line that was at the top, or the top
  const lh = st.geo.lh;
  if (line) el.code.scrollTop = Math.max(0, (line - 1) * lh + CODE_PAD.top - el.code.clientHeight / 3);
  else if (keep != null) el.code.scrollTop = Math.max(0, (keep - 1) * lh);
  else el.code.scrollTop = 0;
  if (!line && keep == null) el.code.scrollLeft = 0;
  drawRows(true);
  scanSoon();
  arrive();
}

/** The code fades in as it arrives (at once with still=1). */
function arrive() {
  if (!el.code.classList.contains('fv-wait')) return;
  el.code.classList.remove('fv-wait');
  if (ctx.still() || ctx.reduced() || document.hidden) return;
  el.code.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
}

/** The line at the top of the code now (1-based), to keep the place when the file is read again or the copy changes. */
function topLine() {
  if (!st.geo) return 1;
  const box = st.edit ? el.edit : el.code;
  return Math.max(1, Math.floor(Math.max(0, box.scrollTop - CODE_PAD.top) / st.geo.lh) + 1);
}

// ---------------------------------------------------------------- drawing rows

/** Draw the rows the scroll shows, and some either side, in chunks: a small scroll draws nothing new. */
function drawRows(force = false) {
  const f = st.file;
  if (!f || !f.rows || !st.geo || st.view !== 'file' || KINDS_WITHOUT_TEXT.has(f.kind) || f.kind === 'refused') return;
  const { lh, charW } = st.geo, total = f.rows.length;
  const top = Math.max(0, el.code.scrollTop - CODE_PAD.top), height = el.code.clientHeight || 600;
  const digits = String(Math.max(total, 9)).length;
  const gut = Math.ceil(st.geo.z.padX + digits * charW + 14);
  const width = Math.ceil(gut + CODE_PAD.left + f.maxCols * charW + CODE_PAD.right);
  const key = `${f.path}|${f.hash}|${total}|${gut}|${width}|${lh}`;
  if (key !== st.win.key) {
    el.sizer.style.height = (total * lh + CODE_PAD.top + CODE_PAD.bottom) + 'px';
    el.sizer.style.width = width + 'px';
    el.code.style.setProperty('--fv-gut', gut + 'px');
    el.edit.style.setProperty('--fv-gut', gut + 'px');
    st.win = { first: -1, last: -1, key };
    force = true;
  }
  if (!force && st.win.first >= 0 && F.windowCovers(st.win, { top, height, lineH: lh, total })) { freshEnded(); return; }
  const win = F.rowWindow({ top, height, lineH: lh, total });
  st.win.first = win.first; st.win.last = win.last;
  const now = performance.now(), freshOn = now < st.fresh.until;
  let html = '';
  for (let i = win.first; i < win.last; i++) {
    const n = i + 1, cls = ['fv-row'];
    if (f.changed.has(n)) cls.push('chg');
    if (freshOn && st.fresh.lines.has(n)) cls.push('fresh');
    html += `<div class="${cls.join(' ')}"><span class="no">${n}</span><span class="tx">${rowHtml(f, i) || ' '}</span></div>`;
  }
  el.rows.style.top = (win.first * lh + CODE_PAD.top) + 'px';
  el.rows.innerHTML = html;
  freshEnded();
}

/** A row's HTML: coloured once its state is known (read down the file in idle slices), plain until then. */
function rowHtml(f, i) {
  const known = i <= f.scanned;
  const hit = f.html.get(i);
  if (hit && (hit.known || !known)) return hit.html;
  const parts = known && f.lang ? tokenizeLine(f.rows[i], f.lang, f.states[i] || '').parts : [['', f.rows[i]]];
  const html = F.lineHtml(parts);
  if (f.html.size > 3000) f.html.clear();
  f.html.set(i, { html, known: known || !f.lang });
  return html;
}

function freshEnded() {
  if (st.fresh.until && performance.now() > st.fresh.until) st.fresh = { lines: new Set(), until: 0 };
}

const idle = typeof requestIdleCallback === 'function'
  ? fn => requestIdleCallback(fn, { timeout: 150 })
  : fn => setTimeout(() => { const t0 = performance.now(); fn({ timeRemaining: () => Math.max(0, 8 - (performance.now() - t0)) }); }, 16);

/** Read the states down the file in idle slices; rows drawn plain before their state was known are drawn again. */
function scanSoon() {
  const f = st.file;
  if (!f || !f.lang || f.scanned >= f.rows.length - 1) return;
  const run = ++st.scan;
  const step = deadline => {
    if (run !== st.scan || st.file !== f) return;
    const until = performance.now() + Math.min(10, Math.max(4, deadline.timeRemaining()));
    let i = f.scanned;
    const end = f.rows.length - 1;
    let cols = f.maxCols;
    while (i < end && performance.now() < until) {
      for (let k = 0; k < 200 && i < end; k++, i++) {
        f.states[i + 1] = tokenizeLine(f.rows[i], f.lang, f.states[i] || '').state;
        const w = f.rows[i].length > cols * 0.8 ? F.visibleCols(f.rows[i]) : 0;
        if (w > cols) cols = w;
      }
    }
    const before = f.scanned;
    f.scanned = i;
    const grew = cols > f.maxCols;
    f.maxCols = cols;
    // rows drawn before their state was known: draw them again, coloured
    if (st.view === 'file' && !st.edit && (grew || (before < st.win.last && i > st.win.first))) { if (grew) st.win.key = ''; drawRows(true); }
    if (i < end) idle(step);
  };
  idle(step);
}

// ---------------------------------------------------------------- folders and the finder

function backOf() {
  if (st.view === 'file' && st.file) return { view: 'file' };
  if (st.view === 'folder') return { view: 'folder', dir: st.dir };
  return null;
}

/** One level of a folder, in place of the code: folders first, then files, each with the marks of the agents that changed it. */
function showFolder(dir, { focusField: toField = false } = {}) {
  st.view = 'folder';
  st.dir = dir || '';
  st.edit = null; st.ask = null;
  st.find.active = 0;
  el.find.value = ''; st.find.q = '';
  paint();
  el.list.scrollTop = 0;
  if (toField) focusField();
}

function onFindInput() {
  const q = el.find.value;
  st.find.q = q;
  if (q && st.view !== 'find') { st.back = backOf(); st.view = 'find'; }
  st.find.active = 0;
  searchSoon(q);
  paint();
}

function onFindKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!st.find.items.length) return;
    e.preventDefault();
    const n = st.find.items.length;
    st.find.active = (st.find.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    markActive(true);
  } else if (e.key === 'PageDown' || e.key === 'PageUp') {
    if (st.view === 'file') { e.preventDefault(); el.code.scrollTop += (e.key === 'PageDown' ? 1 : -1) * el.code.clientHeight * 0.9; }
  }
}

/** Words to find in the files, after two characters, a moment after the last key; never something that looks like a key. */
function searchSoon(q) {
  const s = st.find.search;
  clearTimeout(s.timer);
  const words = q.trim().length >= 2 && !F.lineJump(q) ? q : '';
  if (!words) { Object.assign(s, { q: '', results: null, error: null, truncated: false }); return; }
  if (ctx.looksLikeSecret && ctx.looksLikeSecret(words)) { Object.assign(s, { q: words, results: [], error: 'That looks like a key, so Workbench did not search for it.', truncated: false }); return; }
  s.timer = setTimeout(() => {
    const seq = ++s.seq, where = st.where;
    api.search(where, words).then(r => {
      if (seq !== s.seq || st.where !== where) return;
      if (!r.ok) Object.assign(s, { q: words, results: [], error: visibleControls(r.reply), truncated: false });
      else Object.assign(s, { q: words, results: Array.isArray(r.results) ? r.results.filter(x => x && typeof x.path === 'string' && Number.isInteger(x.line)) : [], error: null, truncated: !!r.truncated });
      if (st.view === 'find' && st.find.q === q) paint();
    }, err => {
      if (seq !== s.seq) return;
      Object.assign(s, { q: words, results: [], error: visibleControls(err.message), truncated: false });
      if (st.view === 'find') paint();
    });
  }, 180);
}

/** What the list holds now, in order: the finder's items, or the folder's. */
function listItems() {
  const files = st.list.files || [];
  if (st.view === 'folder') {
    const lst = F.folderListing(files, st.dir);
    return [...lst.folders.map(f => ({ kind: 'folder', ...f })), ...lst.files.map(f => ({ kind: 'file', ...f }))];
  }
  const q = st.find.q.trim();
  const items = [];
  if (!q) {
    const e = F.emptyFinder(files, st.recent);
    for (const f of e.changed) items.push({ kind: 'file', path: f.path, changedBy: f.changedBy, group: 'Changed by agents' });
    for (const f of e.recent) items.push({ kind: 'file', path: f.path, changedBy: f.changedBy, group: 'Opened lately' });
    return items;
  }
  const jump = F.lineJump(q);
  if (jump && st.file && st.file.rows && st.file.rows.length) items.push({ kind: 'line', line: Math.min(jump, st.file.rows.length), path: st.file.path });
  const found = F.findFiles(files, q, { max: 12 }).map(r => ({ kind: 'file', path: r.path, hits: r.hits, changedBy: r.file.changedBy, group: 'Files' }));
  const s = st.find.search, hits = s.q && s.results ? F.orderSearch(s.results, st.file ? st.file.path : null, 30).map(r => ({ kind: 'hit', ...r, group: 'In files' })) : [];
  if (st.find.mode === 'search') items.push(...hits, ...found); else items.push(...found, ...hits);
  return items;
}

function choose(i) {
  const it = st.find.items[i];
  if (!it) return;
  if (it.kind === 'folder') { showFolder(it.path, { focusField: true }); return; }
  if (it.kind === 'line') { jumpTo(it.line); return; }
  const line = it.kind === 'hit' ? it.line : null;
  el.find.value = ''; st.find.q = ''; st.find.mode = 'find';
  if (st.file && st.file.path === it.path && st.file.in === st.where && st.file.rows) {
    st.view = 'file'; paint(); drawRows(true);
    if (line) jumpTo(line); else focusCode();
    return;
  }
  openFile(it.path, { line, focus: 'code' });
}

/** Show `line` of the open file a third of the way down, briefly marked. */
function jumpTo(line) {
  el.find.value = ''; st.find.q = '';
  st.view = 'file';
  st.fresh = { lines: new Set([line]), until: performance.now() + 1700 };
  paint();
  const box = st.edit ? el.edit : el.code;
  box.scrollTop = Math.max(0, (line - 1) * st.geo.lh + CODE_PAD.top - box.clientHeight / 3);
  if (st.edit) { caretToLine(line); focusOn(el.text); return; }
  drawRows(true);
  focusCode();
}

function remember(path) {
  st.recent = F.remember(st.recent, path);
  try { sessionStorage.setItem('wb-files-recent', JSON.stringify(st.recent)); } catch { /* this load only */ }
}

// ---------------------------------------------------------------- painting

function paint() {
  if (!el || !st.open) return;
  paintActs();
  paintWhose();
  paintTitle();
  paintBody();
  paintBar();
}

function paintTitle() {
  const f = st.file;
  const crumbs = st.view === 'file' && f ? F.crumbsOf(repoName(), f.path) : F.crumbsOf(repoName(), st.view === 'folder' ? st.dir : (st.back && st.back.view === 'folder' ? st.back.dir : (f ? F.nameAndDir(f.path).dir : '')), { folder: true });
  const z = st.geo.z;
  const room = Math.max(120, el.title.parentElement.clientWidth - el.acts.offsetWidth - (el.needs.hidden ? 0 : el.needs.offsetWidth + 14) - el.close.offsetWidth - 34);
  const widthOf = (t, bold) => ctx.measure(visibleControls(t), bold ? z.name : z.path, bold ? 700 : 400);
  const fit = F.fitCrumbs(crumbs, { widthOf, sep: ctx.measure(' / ', z.path, 400), maxW: room });
  const editing = !!st.edit;
  const html = fit.map(c => {
    if (c.gap) return '<span class="fv-gap" aria-hidden="true">…</span>';
    const label = F.pathHtml(c.label);
    if (c.file || c.here) return `<b${c.cut ? ` title="${esc(F.shownPath(c.label))}"` : ''}>${label}</b>`;
    return `<button type="button" class="fv-crumb" data-dir="${esc(c.dir)}" data-key="crumb:${esc(c.dir)}"${editing ? ' aria-disabled="true"' : ''}>${label}</button>`;
  }).join(' <span class="fv-sep">/</span> ');
  const full = crumbs.map(c => F.shownPath(c.label)).join(' / ');
  const all = fit.length !== crumbs.length || fit.some(c => c.cut) ? `<span class="sr">${esc(full)}</span>` : '';
  if (el.title.dataset.html !== html + all) { el.title.innerHTML = `<span class="fv-crumbs"${all ? ' aria-hidden="true"' : ''}>${html}</span>${all}`; el.title.dataset.html = html + all; }
  el.title.title = full;
}

function paintActs() {
  const f = st.file;
  let html = '';
  if (st.view === 'file' && f && !f.loading) {
    if (st.edit) {
      html = `<button type="button" class="fv-btn pri" data-fv="save" data-key="save"${st.saving ? ' aria-disabled="true"' : ''}>Save</button><button type="button" class="fv-btn" data-fv="cancel" data-key="cancel">Cancel</button>`;
    } else if (f.editable && f.kind === 'text') {
      html = `<button type="button" class="fv-btn" data-fv="edit" data-key="edit">Edit</button>`;
    } else if (f.why) {
      html = `<span class="fv-why">${esc(visibleControls(f.why))}</span>`;
    }
  }
  const saved = st.savedAt && performance.now() - st.savedAt < 2600 ? `<span class="fv-saved" aria-hidden="true">${esc(st.savedWord || 'Saved')}</span>` : '';
  const out = saved + html;
  if (el.acts.dataset.html !== out) { const had = el.acts.contains(document.activeElement) ? document.activeElement.dataset.key : null; el.acts.innerHTML = out; el.acts.dataset.html = out; if (had) el.acts.querySelector(`[data-key="${had}"]`)?.focus({ preventScroll: true }); }
}

/** The quiet line under the path: whose copy it is, or what asks first (a change on disk, an edit not saved), or a note. */
function paintWhose() {
  const f = st.file;
  let html = '';
  if (st.ask) {
    html = `<span class="fv-ask" role="group" aria-label="${esc(st.ask.text)}">${markHtml({ state: 'needs_ok' })}<span>${esc(st.ask.text)}</span>${st.ask.buttons.map(([label, key, pri]) => `<button type="button" class="fv-btn small${pri ? ' pri' : ''}" data-fv="${key}" data-key="ask:${key}">${esc(label)}</button>`).join('')}</span>`;
  } else if (st.note && !st.note.quiet && st.note.where === 'whose') {
    html = `<span class="fv-said">${esc(st.note.text)}</span>`;
  } else if (st.edit) {
    const words = editNotes();
    html = words ? `<span class="fv-said">${esc(words)}</span>` : whoseHtml(f);
  } else {
    html = whoseHtml(f);
  }
  if (el.whose.dataset.html !== html) {
    const had = el.whose.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    el.whose.innerHTML = html; el.whose.dataset.html = html;
    if (had) (el.whose.querySelector(`[data-key="${had}"]`) || (st.edit ? el.text : el.find)).focus({ preventScroll: true });
  }
}

function whoseHtml(f) {
  const where = st.where;
  const agent = agentOf(where);
  const changed = f && f.changed ? f.changed.size : 0;
  const w = F.whoseLine({ where, agent: agent ? { id: agent.id, name: agent.name } : (where !== 'you' ? { id: where, name: 'the agent' } : null), changed: st.view === 'file' ? changed : 0,
    branch: st.list.branch ?? (S.meta && S.meta.repo ? S.meta.repo.branch : null), changedBy: st.view === 'file' && f ? (changedOf(f.path) || []).filter(a => a.agentId !== where) : [] });
  const sep = ' <span class="fv-dot">·</span> ';
  let html = where !== 'you' ? markHtml(agent || { state: 'done_claimed' }) : '';
  html += `<span>${esc(visibleControls(w.lead))}</span>`;
  for (const r of w.rest) html += `${sep}<span>${esc(visibleControls(r))}</span>`;
  if (w.changedIt) html += `${sep}${markHtml(agentOf(w.agent.agentId) || w.agent)}<span>${esc(visibleControls(w.changedIt))}</span>`;
  if (w.link && (st.view !== 'file' || (f && f.kind !== null))) html += `${sep}<button type="button" class="fv-link" data-fv="switch" data-to="${esc(w.link.to)}" data-key="switch:${esc(w.link.to)}">${esc(visibleControls(w.link.label))}</button>`;
  return html;
}

/** While editing: who else works in this copy, and what happens to the hidden characters. */
function editNotes() {
  const out = [];
  const agent = agentOf(st.where);
  if (agent && STATES.ACTIVE.has(agent.state)) out.push(`${visibleControls(agent.name)} is working in this copy. It will see your change.`);
  if (st.file && st.file.text && hiddenParts(st.file.text.replace(/[\t\n]/g, '')).some(p => p.hidden)) out.push('This file has hidden characters. They stay as they are unless you delete them.');
  return out.join(' ');
}

function paintBody() {
  const f = st.file;
  const showList = st.view === 'folder' || st.view === 'find';
  const showText = st.view === 'file' && f && f.rows && !KINDS_WITHOUT_TEXT.has(f.kind) && f.kind !== 'refused' && !f.loading;
  el.list.hidden = !showList;
  el.code.hidden = !(st.view === 'file' && !st.edit && (showText || (f && f.loading)));
  el.edit.hidden = !st.edit;
  let note = '';
  if (st.view === 'file' && f) {
    if (f.kind === 'refused') note = esc(f.reply || 'Workbench could not read that file.');
    else if (KINDS_WITHOUT_TEXT.has(f.kind)) note = kindNote(f);
    else if (st.note && st.note.quiet && f.loading) note = esc(st.note.text);
  }
  el.note.hidden = !note;
  if (el.note.dataset.html !== note) { el.note.innerHTML = note; el.note.dataset.html = note; }
  if (el.code.hidden) el.code.classList.toggle('fv-wait', !!(f && f.loading));
  el.code.setAttribute('aria-label', f && f.path ? `${F.shownPath(f.path)}${f.lines ? `, ${f.lines} line${f.lines === 1 ? '' : 's'}` : ''}` : 'The file');
  if (showList) paintList();
  el.find.setAttribute('aria-expanded', String(showList && st.view === 'find'));
}

/** In the body, for a file with no text to show: what it is, in plain words. */
function kindNote(f) {
  const size = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} byte${n === 1 ? '' : 's'}`);
  if (f.kind === 'link') return `<span class="fv-big">→ ${F.pathHtml(f.link || '')}</span><span>A link, not a file. Workbench does not follow it.</span>`;
  if (f.kind === 'binary') return `<span class="fv-big">${esc(size(f.size))}</span><span>A binary file: not text, so there is nothing to read here.</span>`;
  if (f.kind === 'large') return `<span class="fv-big">${esc(size(f.size))}</span><span>Workbench shows files up to 1 MB.</span>`;
  if (f.kind === 'notutf8') return `<span class="fv-big">${esc(size(f.size))}</span><span>Its text is in another encoding.</span>`;
  if (f.kind === 'missing') {
    const agent = agentOf(st.where);
    return `<span>${esc(st.where === 'you' ? 'This file is not in your folder.' : `This file is not in ${visibleControls(agent ? agent.name : 'the agent')}’s copy.`)}</span>`;
  }
  return '';
}

function paintList() {
  const items = listItems();
  st.find.items = items;
  if (st.find.active >= items.length) st.find.active = Math.max(0, items.length - 1);
  const files = st.list.files;
  let html = '', group = null;
  const optId = i => `fvo-${i}`;
  items.forEach((it, i) => {
    if (it.group && it.group !== group && (st.view === 'find')) {
      group = it.group;
      const show = !(group === 'Files' && !items.some(x => x.group === 'In files'));
      if (show) html += `<p class="fv-group" role="presentation">${esc(group)}</p>`;
    }
    html += `<div role="option" id="${optId(i)}" class="fv-opt${i === st.find.active ? ' on' : ''} fv-${it.kind}" data-i="${i}" aria-selected="${i === st.find.active}">${optionHtml(it)}</div>`;
  });
  if (!items.length) {
    const q = st.find.q.trim();
    const words = files == null ? 'Reading the files…' : st.list.error ? st.list.error
      : st.view === 'folder' ? 'This folder is empty.' : q ? `No file matches “${visibleControls(q)}”.` : 'Type to find a file, or a line: “40” jumps to line 40.';
    html += `<p class="fv-empty">${esc(words)}</p>`;
  }
  const s = st.find.search;
  if (st.view === 'find' && s.q && s.error) html += `<p class="fv-empty">${esc(s.error)}</p>`;
  if (st.view === 'find' && s.q && s.results && !s.results.length && !s.error && st.find.q.trim() === s.q) html += `<p class="fv-empty">No line in the files holds “${esc(visibleControls(s.q))}”.</p>`;
  if (st.list.truncated) html += '<p class="fv-empty">Workbench lists the first 50,000 files.</p>';
  if (el.list.dataset.html !== html) { el.list.innerHTML = html; el.list.dataset.html = html; }
  markActive();
}

/** One row of the list: a folder, a file (its matched letters in bold), a line to jump to, or a line found in the files. */
function optionHtml(it) {
  // one mark: the first agent that changed it (its name, and the others', are in the row's name for screen readers)
  const marks = list => (list && list[0] ? markHtml(agentOf(list[0].agentId) || list[0]) : '');
  const who = (list, words) => (list && list.length ? `<span class="sr">, ${esc(words)} ${esc(list.map(a => visibleControls(a.name)).join(', '))}</span>` : '');
  if (it.kind === 'folder') return `<span class="fv-mk">${marks(it.marks)}</span><span class="fv-nm">${F.pathHtml(it.name)}<span class="fv-slash">/</span></span>${who(it.marks, 'a folder with changes by')}`;
  if (it.kind === 'line') return `<span class="fv-mk"></span><span class="fv-nm">Line ${it.line}</span><span class="fv-dir">${F.pathHtml(F.nameAndDir(it.path).name)}</span>`;
  if (it.kind === 'hit') {
    const { name, dir } = F.nameAndDir(it.path);
    const z = st.geo.z, room = Math.max(24, Math.floor((el.list.clientWidth - 60) / ctx.measure('M', z.code, 400)) - Array.from(name).length - 10);
    const cut = F.cutAround(String(it.text || ''), F.matchRanges(it.text, st.find.search.q), Math.max(20, room));
    return `<span class="fv-mk"></span><span class="fv-loc">${F.pathHtml(name)}<i>:${it.line}</i></span><span class="fv-line">${F.markedHtml(cut.text, cut.ranges)}</span><span class="sr"> in ${esc(F.shownPath(dir || 'the top folder'))}</span>`;
  }
  const { name, dir } = F.nameAndDir(it.path);
  const at = it.path.length - name.length;
  const hits = it.hits || [];
  const nameRanges = F.hitRanges(hits.filter(h => h >= at).map(h => h - at)), dirRanges = F.hitRanges(hits.filter(h => h < at));
  const ignored = st.view === 'folder' && it.ignored ? '<span class="fv-dir">hidden by .gitignore</span>' : '';
  return `<span class="fv-mk">${marks(it.changedBy)}</span><span class="fv-nm">${F.markedHtml(name, nameRanges)}</span>${st.view === 'find' && dir ? `<span class="fv-dir">${F.markedHtml(dir, dirRanges)}</span>` : ''}${ignored}${who(it.changedBy, 'changed by')}`;
}

function markActive(scroll = false) {
  const opts = el.list.querySelectorAll('[role="option"]');
  let on = null;
  for (const o of opts) { const yes = +o.dataset.i === st.find.active; o.classList.toggle('on', yes); o.setAttribute('aria-selected', String(yes)); if (yes) on = o; }
  if (on) { el.find.setAttribute('aria-activedescendant', on.id); if (scroll) on.scrollIntoView({ block: 'nearest' }); } else el.find.removeAttribute('aria-activedescendant');
}

function paintBar() {
  el.bar.classList.toggle('typed', !!el.find.value);
  const ph = st.find.mode === 'search' ? 'find words in the files' : 'find a file';
  if (el.ph.textContent !== ph) el.ph.textContent = ph;
}

// ---------------------------------------------------------------- the needs-you pill

/** What needs the person, as the board sees it: "■ Checkout fix needs you" at the top of the sheet; null hides it. */
export function filesNeeds(info) {
  if (!el) return;
  const a = info && S.agents.get(info.id);
  if (!a) { if (!el.needs.hidden) { el.needs.hidden = true; el.needs.innerHTML = ''; paintTitle2(); } return; }
  const name = visibleControls(a.name);
  const short = Array.from(name).length > 24 ? Array.from(name).slice(0, 23).join('').replace(/\s+\S*$/, '') + '…' : name;
  const html = `${markHtml(a)}<span>${esc(short)} needs you</span>`;
  const label = `${name} needs you${info.more ? `, and ${info.more} more` : ''}. Closes the file view and shows it in the middle.`;
  el.needs.dataset.agent = a.id;
  if (el.needs.dataset.html !== html) { el.needs.innerHTML = html; el.needs.dataset.html = html; }
  el.needs.setAttribute('aria-label', label);
  el.needs.title = `${name} needs you`;
  if (el.needs.hidden) { el.needs.hidden = false; paintTitle2(); if (!ctx.still() && !ctx.reduced()) el.needs.animate([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE_OUT }); }
}
function paintTitle2() { if (st.open && st.geo) paintTitle(); }

// ---------------------------------------------------------------- what the buttons do

function act(what, b) {
  switch (what) {
    case 'edit': enterEdit(); return;
    case 'save': save({ stay: false }); return;
    case 'cancel': leaveEdit(); return;
    case 'switch': {
      const to = b.dataset.to;
      guard(() => switchTo(to));
      return;
    }
    case 'keep': st.ask = null; paint(); focusOn(st.edit ? el.text : el.find); return;
    case 'leave': { const go = st.ask && st.ask.go; st.ask = null; leaveEdit({ ask: false, focus: !go || go === STAY }); if (go && go !== STAY) go(); return; }
    case 'theirs': {
      const r = st.ask && st.ask.theirs, keep = topLine();
      st.ask = null;
      leaveEdit({ ask: false, focus: false });
      if (r && r.ok && !r.same) show(r, { keep }); else reread();
      focusCode();
      return;
    }
    case 'mine': { const hash = st.ask && st.ask.hash, stay = !!(st.ask && st.ask.stay); st.ask = null; save({ stay, force: true, hash }); return; }
    default:
  }
}

/** Switch to the same file in the other copy, near the same line. */
function switchTo(to) {
  const path = st.view === 'file' && st.file ? st.file.path : null;
  const keep = topLine();
  st.where = to;
  st.list.where = null;
  loadList();
  if (path) openFile(path, { keep, focus: 'code' }); else showFolder(st.dir, { focusField: true });
}

/** Anything that would leave an edit with changes asks first; otherwise it goes ahead. */
function guard(go) {
  if (editChanged()) { askLeave(go); return; }
  if (st.edit) leaveEdit({ ask: false, focus: false });
  go();
}

const editChanged = () => !!(st.edit && el.text.value !== st.edit.text0);

function askLeave(go) {
  const name = st.file ? F.shownPath(F.nameAndDir(st.file.path).name) : 'this file';
  st.ask = { kind: 'leave', text: `Your changes to ${name} are not saved.`, go, buttons: [['Keep editing', 'keep', true], ['Leave without saving', 'leave', false]] };
  paint();
  say(st.ask.text);
  el.whose.querySelector('[data-fv="keep"]')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- editing

function enterEdit() {
  const f = st.file;
  if (!f || !f.editable || f.kind !== 'text' || st.edit) return;
  st.edit = { text0: f.text, indent: F.guessIndent(f.text), hash: f.hash };
  st.ask = null;
  st.note = null;   // what the last save said is over: this is a new edit
  const top = el.code.scrollTop, left = el.code.scrollLeft, line = topLine();
  el.text.value = f.text;
  el.text.setAttribute('aria-label', `${F.shownPath(f.path)}, as text you can change`);
  sizeEditor();
  paint();
  el.edit.scrollTop = top;
  el.text.scrollLeft = left;
  drawEditNums(true);
  crossfade(true);
  caretToLine(line);
  focusOn(el.text);
}

/** Leave the editor: back to the coloured view at the same place (asking first when something changed). */
function leaveEdit({ ask = true, focus = true } = {}) {
  if (!st.edit) return;
  if (ask && editChanged()) { askLeave(STAY); return; }
  const top = el.edit.scrollTop, left = el.text.scrollLeft;
  st.edit = null;
  st.ask = null;
  paint();
  el.code.scrollTop = top;
  el.code.scrollLeft = left;
  st.win.key = '';
  drawRows(true);
  crossfade(false);
  if (focus) focusCode();
}

/** The text box and the coloured view swap places at the same scroll, crossfading (at once with still=1). */
function crossfade(toEdit) {
  if (ctx.still() || ctx.reduced() || document.hidden) return;
  const inEl = toEdit ? el.edit : el.code;
  inEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 170, easing: 'ease-out' });
}

/** The editor's box: as tall as its lines, so the gutter and the text scroll as one. */
function sizeEditor() {
  const lines = countLines(el.text.value);
  const h = lines * st.geo.lh + CODE_PAD.top + CODE_PAD.bottom + 16;
  el.esizer.style.height = h + 'px';
  st.edit && (st.edit.lines = lines);
}
function countLines(t) { let n = 1; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++; return t.endsWith('\n') && n > 1 ? n - 1 : n; }

/** The line numbers beside the editor, for the lines that show. */
function drawEditNums(force = false) {
  if (!st.edit) return;
  const lh = st.geo.lh, total = st.edit.lines || 1;
  const top = Math.max(0, el.edit.scrollTop - CODE_PAD.top), height = el.edit.clientHeight || 600;
  if (!force && st.edit.win && F.windowCovers(st.edit.win, { top, height, lineH: lh, total })) return;
  const win = F.rowWindow({ top, height, lineH: lh, total });
  st.edit.win = win;
  let html = '';
  for (let i = win.first; i < win.last; i++) html += `<span>${i + 1}</span>`;
  el.enums.style.top = (win.first * lh + CODE_PAD.top) + 'px';
  el.enums.innerHTML = html;
}

function caretToLine(line) {
  const t = el.text.value;
  let at = 0;
  for (let n = 1; n < line && at >= 0; n++) { at = t.indexOf('\n', at); if (at >= 0) at++; }
  at = Math.max(0, at);
  try { el.text.setSelectionRange(at, at); } catch { /* not focusable yet */ }
}

let typedFrame = 0;
function onTextInput() {
  if (!st.edit) return;
  cancelAnimationFrame(typedFrame);
  typedFrame = requestAnimationFrame(() => { const was = st.edit && st.edit.lines; sizeEditor(); if (st.edit && st.edit.lines !== was) drawEditNums(true); });
}

/** Tab puts in the file's own indentation (or indents the lines chosen); Shift+Tab takes one step out; ⌘S saves. */
function onTextKey(e) {
  if (!st.edit) return;
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    const t = el.text, ind = st.edit.indent, v = t.value, s = t.selectionStart, end = t.selectionEnd;
    const multi = v.slice(s, end).includes('\n');
    if (!multi && !e.shiftKey) { insertText(ind); return; }
    const from = v.lastIndexOf('\n', s - 1) + 1, to = end;
    const block = v.slice(from, to);
    const lines = block.split('\n');
    const out = e.shiftKey ? lines.map(l => (l.startsWith(ind) ? l.slice(ind.length) : l.replace(/^[\t ]{1,4}/, m => (ind === '\t' ? m.slice(1) : m.slice(Math.min(m.length, ind.length)))))) : lines.map(l => (l ? ind + l : l));
    t.setSelectionRange(from, to);
    insertText(out.join('\n'));
    t.setSelectionRange(from, from + out.join('\n').length);
  }
}

/** Put text in at the caret so the browser's own undo keeps it. */
function insertText(s) {
  const t = el.text;
  let done = false;
  try { done = document.execCommand('insertText', false, s); } catch { done = false; }
  if (!done) { const a = t.selectionStart, b = t.selectionEnd; t.setRangeText(s, a, b, 'end'); t.dispatchEvent(new Event('input')); }
}

/**
 * Save: the text as the person left it (line breaks as LF, the last one as it is: the engine keeps the file's own line
 * endings and its BOM), with the hash the file was read with. The Save button returns to the coloured view; ⌘S stays in
 * the editor. A file that changed on disk since is not written: the line under the path says so, with Load theirs,
 * Save mine anyway and Keep editing.
 */
async function save({ stay = false, force = false, hash = null } = {}) {
  const f = st.file;
  if (!st.edit || !f || st.saving) return;
  const text = el.text.value;
  st.saving = true;
  paintActs();
  const seq = ++st.seq;
  let r;
  try { r = await api.saveFile(f.in, f.path, { text, hash: force && hash ? hash : st.edit.hash, force }); }
  catch (err) { st.saving = false; note(err.message); paintActs(); return; }
  st.saving = false;
  if (seq !== st.seq && !st.edit) { paint(); return; }
  if (!r.ok) {
    if (r.why === 'changed') {
      const who = agentOf(f.in);
      const theirs = who ? `${visibleControls(who.name)} changed this file while you were editing.` : 'This file changed on disk while you were editing.';
      st.ask = { kind: 'conflict', text: `${theirs} Your edit is still here.`, hash: r.hash, stay, buttons: [['Load theirs', 'theirs', false], ['Save mine anyway', 'mine', true], ['Keep editing', 'keep', false]] };
      paint();
      say(st.ask.text);
      el.whose.querySelector('[data-fv="mine"]')?.focus({ preventScroll: true });
      return;
    }
    note(visibleControls(r.reply));
    paintActs();
    return;
  }
  st.edit.text0 = text;
  st.edit.hash = r.hash;
  // the view shows what was saved at once; reading it again brings the engine's own count of changed lines
  Object.assign(f, { text, hash: r.hash, rows: F.splitLines(text), html: new Map(), states: [''], scanned: 0 });
  f.lines = f.rows.length;
  scanSoon();
  st.savedAt = performance.now();
  st.savedWord = 'Saved';
  if (r.reply) note(visibleControls(r.reply), 9000);
  say(r.reply ? `Saved. ${r.reply}` : 'Saved.');
  setTimeout(() => paintActs(), 2700);
  if (!stay) { leaveEdit({ ask: false }); reread(); }
  else paint();
}

/** A note in the line under the path for a while: a refusal, or the demo's first save. */
function note(text, ms = 7000) {
  st.note = { text, where: 'whose' };
  clearTimeout(st.noteTimer);
  st.noteTimer = setTimeout(() => { if (st.note && st.note.text === text) { st.note = null; paint(); } }, ms);
  paint();
  say(text);
}

function say(text) {
  if (!el) return;
  el.said.textContent = '';
  clearTimeout(st.saidTimer);
  st.saidTimer = setTimeout(() => { el.said.textContent = text; }, 30);
}

// ---------------------------------------------------------------- never stale

function startPoll() { stopPoll(); st.poll = setInterval(() => pollSoon(0), POLL_MS); }
function stopPoll() { clearInterval(st.poll); st.poll = 0; }
function pollSoon() { if (!st.polling) poll(); }

/**
 * Every 2 seconds while a file shows (and the tab is visible): is it still the file shown? A light read compares its
 * hash; when it changed, the view reads it again, near the same line, and marks the lines that changed. While editing,
 * the change is said at once instead ("… changed this file. Your edit is still here."), with Load theirs and Keep editing.
 */
async function poll() {
  const f = st.file;
  if (!st.open || document.hidden || st.moving || st.view !== 'file' || !f || f.loading || f.kind === 'refused' || st.saving || (st.ask && st.ask.kind !== 'leave')) return;
  const seq = st.seq;
  st.polling = true;
  let r;
  try { r = await api.file(f.in, f.path, f.hash ? { check: f.hash } : {}); }
  catch { st.polling = false; return; }
  st.polling = false;
  if (seq !== st.seq || f !== st.file || !st.open) return;
  if (!r.ok) {
    if (r.why === 'gone') { st.file = { in: f.in, path: f.path, kind: 'refused', reply: visibleControls(r.reply), why: r.why }; paint(); }
    return;
  }
  if (r.same) return;
  if (!f.hash && r.kind === f.kind && (r.size || 0) === f.size && !r.hash) return;
  if (st.edit) {
    if (st.ask && st.ask.kind === 'changed') return;
    const who = agentOf(f.in);
    st.ask = { kind: 'changed', text: `${who ? `${visibleControls(who.name)} changed this file.` : 'This file changed on disk.'} Your edit is still here.`, theirs: r, buttons: [['Load theirs', 'theirs', false], ['Keep editing', 'keep', true]] };
    paint();
    say(st.ask.text);
    return;
  }
  const keep = topLine();
  show(r, { keep, fresh: F.freshLines(f.text, typeof r.text === 'string' ? r.text : '') });
}

/** Read the file shown again, near the same line (after a save, for its changed lines as the engine sees them now). */
function reread() {
  const f = st.file;
  if (!f || !f.path) return;
  const seq = ++st.seq, keep = topLine();
  api.file(f.in, f.path).then(r => { if (seq === st.seq && r.ok && !r.same && !st.edit) show(r, { keep }); }, () => {});
}

// ---------------------------------------------------------------- keys

/**
 * The page's keys while the sheet shows (app.js calls this first, and the board takes none): Esc, ⌘P and ⌘⇧F, ⌘S in the
 * editor, and letters typed outside a text field, which go to the field. Space types a space in the field and the
 * editor and presses a button; it never starts listening. Returns true when it used the key.
 */
export function filesKey(e) {
  if (!st.open) return false;
  const mod = ctx.isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); filesEscape(); return true; }
  if (mod && !e.altKey && (e.key === 's' || e.key === 'S') && st.edit) { e.preventDefault(); save({ stay: true }); return true; }
  if (mod && !e.altKey && (e.key === 'p' || e.key === 'P') && !e.shiftKey) { e.preventDefault(); openFiles({ mode: 'find' }); return true; }
  if (mod && !e.altKey && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFiles({ mode: 'search' }); return true; }
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const ae = document.activeElement;
  const textField = ae && ae.matches && ae.matches('input, textarea');
  if (!textField && e.key.length === 1 && e.key !== ' ' && st.moving !== 'out') {
    e.preventDefault();
    if (st.edit) return true;
    focusField();
    el.find.value += e.key;
    el.find.dispatchEvent(new Event('input'));
    return true;
  }
  return false;
}

/**
 * Esc, in order: the line that asks first goes (keeping the edit); typed words in the field go (and what they covered
 * comes back); the editor is left (asking first when something changed); then the sheet closes.
 */
export function filesEscape() {
  if (!st.open) return;
  if (st.ask) { act('keep'); return; }
  if (document.activeElement === el.find && el.find.value) {
    el.find.value = ''; st.find.q = ''; st.find.mode = 'find';
    searchSoon('');
    const back = st.back;
    st.back = null;
    if (back && back.view === 'file' && st.file) { st.view = 'file'; paint(); drawRows(true); }
    else if (back && back.view === 'folder') { st.view = 'folder'; st.dir = back.dir; paint(); }
    else paint();
    return;
  }
  if (st.edit) { leaveEdit(); return; }
  closeFiles();
}
