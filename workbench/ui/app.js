// Workbench, as a circuit board. You are the core: it shows one thing at a time and holds the one place to type or
// talk. Each agent is a chip on its own lane: beside you when it needs you, mid-board while it works, at the edge once
// it is done, and in the done tray once you are finished with it. This file wires the data, the board (board.js), the
// lid (focus.js), the card and the input together.
import { debugSwitches } from './address.js';
import { money, clip } from '/shared/format.mjs';
import { initToken, hasToken, whenRefused, api, connect } from './api.js';
import { linkState, cannotSend } from './link.js';
import { S, STATES, upsert, currentFocus, needsQueue, markReviewed, setAside, stepQueue, spendToday, machineName, workKey } from './model.js';
import { boardModel, boardAndTray, agoText, doneWords } from './boardmodel.js';
import { Lanes } from './lanes.js';
import { sizeClass, frame, layoutBoard, maxDenseRows } from './layout.js';
import { Board } from './board.js';
import { lidView, tickSince, focusKey } from './focus.js';
import { cardHtml } from './card.js';
import { setupVoice } from './voice.js';
import { THEME_NAMES, DETAIL_NAMES, normalTheme, normalDetail, pagePrefs, pageCommand, lidAnswer } from './prefs.js';
import * as ANSWERS from '/shared/answers.mjs';   // "looks good" and "not now", as the engine reads them
import { markOf } from './look.js';
import { esc, coalesce, patchChildren } from './util.js';
import { balanceHeading } from './balance.js';
import { buttonRow } from './words.js';
import { visibleControls } from './words.js'; // say(): what is said shows hidden characters as the lid does
import { spentAmountWords } from './numbers.js';
// D1: the git screen below the board, reached by the DRAM (gitscreen.js draws it; this file switches screens)
import { setupGitScreen, openGit, closeGit, gitShown, gitRender, gitSay, gitEscape, gitTick, gitHold, gitTake, gitRelease, gitListening, gitHome } from './gitscreen.js';
import { gitScreenWords } from './gitgraph.js';
import { visibleText } from './diffview.js';
import { clipToLines } from './layout.js';
// Agents & keys: the connect panel (connect.js draws it; this file opens it, paints its light in the top band, and keeps
// keys out of the board's input). The shared module is read as a whole: a name it lacks is never a broken page.
import { setupConnect, openConnect, closeConnect, connectShown, connectNeeds } from './connect.js';
import { connectMeta, bandView, keyRefusal } from './connectview.js';
// Full permissions: the top band's button beside Agents & keys (its words and state), sent to the engine when pressed.
import { permButtonView } from './permissions.js';
import * as secretShape from '/shared/secretshape.mjs';
// The file view: the files chip (U3) beside the DRAM opens it, and so do ⌘P, ⌘⇧F and a path on the git screen
// (fileview.js draws the sheet; this file opens it, hands it the keys while it shows, and holds the lid).
import { setupFiles, openFiles, filesShown, filesKey, filesNeeds, filesRender, filesEscape } from './fileview.js';

// The address is read once, before the key is taken out of it. Switches count only with the key (see address.js).
const debug = debugSwitches(location.search);
initToken();

const $ = id => document.getElementById(id);
const el = {
  html: document.documentElement, body: document.body, core: $('core'), pages: $('pages'), probe: $('probe'), bar: $('bar'), say: $('say'), ph: $('ph'),
  heard: $('heard'), mic: $('mic'), to: $('to'), toText: $('toText'), toCancel: $('toCancel'), announce: $('announce'), said: $('said'),
  parts: $('parts'), machines: $('machines'), tray: $('tray'), card: $('card'), pop: $('pop'), trayList: $('trayList'), look: $('look'),
  brand: $('brand'), mode: $('mode'), repo: $('repo'), conn: $('conn'), spend: $('spend'), wires: $('wires'), board: $('board'),
  dram: $('dram'), boardScreen: $('boardScreen'), gitScreen: $('gitScreen'), gitSay: $('gitSay'), connectBtn: $('connectBtn'),
  permBtn: $('permBtn'), files: $('filesChip'),
};
/** ⌘ on a Mac, Ctrl elsewhere: ⌘P (Ctrl+P) finds a file, ⌘⇧F words in the files, ⌘S saves in the file view. */
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
if (debug.still) el.body.classList.add('still');

const RM = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => RM.matches;
// The person's choices, as Workbench put them on <html> before the first paint (it keeps them, not the page).
const prefs = pagePrefs(el.html.dataset);
el.html.dataset.theme = prefs.theme;
el.html.dataset.detail = prefs.detail;
// Whether full permissions are on, as Workbench put it on <html>, so the band's button is right before the first
// snapshot; each snapshot's meta says it after that.
Object.assign(S.meta, { permissions: prefs.permissions });

function safeStorage(name) { try { return window[name]; } catch { return null; } }

// ---------------------------------------------------------------- text widths (JetBrains Mono, measured once loaded)
const cvs = document.createElement('canvas').getContext('2d');
const widths = new Map();
function measure(text, px, weight = 600) {
  const k = weight + '|' + px + '|' + text;
  let w = widths.get(k);
  if (w == null) {
    cvs.font = `${weight} ${px}px "JetBrains Mono", ui-monospace, monospace`;
    w = cvs.measureText(String(text)).width;
    if (widths.size > 4000) widths.clear();
    widths.set(k, w);
  }
  return w;
}

// ---------------------------------------------------------------- the link to Workbench
const link = { stream: null, refused: false, downSince: 0, startedAt: performance.now() };
function linkNow() {
  const downMs = link.downSince ? performance.now() - link.downSince : (!S.loaded ? performance.now() - link.startedAt : 0);
  return linkState({ hasKey: hasToken(), loaded: S.loaded, stream: link.stream, refused: link.refused, downMs });
}
whenRefused(() => { if (!link.refused) { link.refused = true; renderSoon(); } });

// ---------------------------------------------------------------- the board
const lanes = new Lanes(safeStorage('sessionStorage'));
let G = null, lastFirst = true, fontsReady = false;
// The keyboard goes to the lid's sentence when what held it leaves (a chip leaving the board, the done tray emptying),
// as other moves do; a swap that follows carries it to the new sentence.
const lidHome = () => el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
const board = new Board({
  boardSvg: el.board, wires: el.wires, parts: el.parts, core: el.core, dram: el.dram, files: el.files, machines: el.machines, tray: el.tray, said: el.said, cardEl: el.card,
  still: () => debug.still, reduced,
  hooks: {
    enter: (id, parentId) => { clearTimeout(leaveTimer); if (S.hoverId !== id) { S.hoverId = id; renderCard(); } },
    leave: (id, viaFocus) => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (S.hoverId === id) { S.hoverId = null; renderCard(); } }, viaFocus ? 0 : 140); },
    pick: id => pickAgent(id),
    more: rootId => { S.pinId = rootId; S.hoverId = rootId; renderCard(); },
    machine: (id, anchor) => toggleMachines(anchor),
    tray: anchor => toggleTray(anchor),
    // a chip that held the keyboard leaves the board: the keyboard goes to the lid's sentence, as other moves do
    home: () => lidHome(),
  },
});
let leaveTimer = null;

// ---------------------------------------------------------------- notices and the hint under the core
let notice = null, noticeTimer = null;
const hintDone = () => prefs.answered;
/** How long a reply stays: one that refused or could not start work stays 30 s (9 s was easy to miss), the others 9 s. */
const REFUSED_RE = /\b(could not start|cannot start|not available|not ready|not signed in|could not be started|did not answer)\b/i;
function lasting(r) { return r && typeof r.reply === 'string' && (r.openConnect === true || REFUSED_RE.test(r.reply)) ? 30000 : 9000; }
function say(text, ms = 9000) {
  // A reply or notice can name an agent's branch or paths, which the agent chose: characters that hide text or change the
  // order it reads in show by their code (⟦U+202E⟧) here and on the git screen. Line breaks, tabs and runs of spaces
  // become one space first (not by \s or trim(), which would take U+FEFF, U+2028 and U+2029 for spaces too).
  notice = text ? visibleControls(String(text).split(/[\t\n\v\f\r ]+/).filter(Boolean).join(' ')) || null : null;
  clearTimeout(noticeTimer);
  if (notice && ms) noticeTimer = setTimeout(() => { notice = null; paintSaid(); }, ms);
  paintSaid();
}
/** The person answered something: the hint under the core goes, now and in later runs (Workbench keeps that). */
function answeredOnce() {
  if (prefs.answered) return;
  prefs.answered = true;
  el.html.dataset.answered = '1';
  if (hasToken()) api.prefs({ answered: true }).catch(() => { /* not kept: the hint comes back at the next start */ });
}
function paintSaid() {
  gitSay(notice);   // D1: what Workbench said shows on the git screen too
  if (!G) return;
  const P = G.P;
  const perLine = Math.max(10, Math.floor(G.said.w / measure('M', P.silkSub, 400)));
  // under the DRAM (D1): the lines the layout gave it, three at most, more where it is narrow and the board has room
  const maxLines = Math.max(1, G.said.lines || Math.min(3, Math.floor((G.said.maxY - G.said.y) / (P.silkSub * 1.35))));
  let html = '';
  if (notice) {
    // cut by the lines it wraps into, not by a count of characters: under the DRAM the line is narrow (D1)
    const shown = clipToLines(notice, perLine, maxLines);
    html = `<span aria-hidden="${shown !== notice}">${esc(shown)}</span>${shown !== notice ? `<span class="sr">${esc(notice)}</span>` : ''}`;
  } else if (!hintDone() && needsQueue().length && linkNow() === 'live') {
    html = '<i aria-hidden="true"></i><span>a lit line means it needs you</span>';
  }
  if (el.said.dataset.html !== html) { el.said.innerHTML = html; el.said.dataset.html = html; }
}

// ---------------------------------------------------------------- what the core shows
let lidKey = null, lidFocus = null, armedUntil = 0, armTimer = null;
const pointer = { inCore: false };
let lastInputAt = 0;
const open = { key: null, exact: false, changed: false, all: false };
const touch = () => { lastInputAt = performance.now(); };

/** The person is in the middle of something in the core: hold what it shows (for up to 20 s without any input). */
function engaged() {
  if (gitShown()) return true;   // D1: the lid keeps what it shows while the git screen is shown
  if (connectShown()) return true;   // and while Agents & keys covers it
  if (filesShown()) return true;   // and while the file view does
  if (performance.now() - lastInputAt > 20000 && !voice.listening && !el.say.value) return false;
  const ae = document.activeElement;
  return pointer.inCore || (ae && ae !== document.body && el.core.contains(ae) && ae !== el.say) || !!el.say.value || voice.listening || !!S.reply;
}

// the lid's key (focus.js): a confirm card, nothing, or an agent in a state with an ask and, for its work, where that went
const keyOf = f => focusKey(f);

// The hold resists only what arrives on the stream. The person's own moves (a lid button, → and ←, a typed "next", picking
// a chip or a row, the reply to their own command) show what they asked for at once: the next render lets go once.
let letGo = false;
const moved = () => { letGo = true; };

/**
 * What needs the person, as model.js orders it; and when nothing does and no coding agent can start work yet
 * (meta.connect.ready is false, outside the demo), the lid's "Connect a coding agent to start." in place of
 * "Nothing needs you.". Without meta.connect the lid is as it always was.
 */
function focusNow() {
  const f = currentFocus(), c = S.meta.connect;
  return f.empty && c && c.ready === false && S.meta.mode !== 'demo' ? { ...f, connect: c } : f;
}

/** What the core shows now: what needs the person, unless they are busy with what is already showing. */
function shownFocus() {
  const want = focusNow();
  const own = letGo;
  letGo = false;
  if (!lidFocus || own || !engaged() || keyOf(want) === lidKey) return { f: want, also: false };
  const held = lidFocus;
  // something else waits behind what is held: an agent that needs the person, or a launch question
  const also = x => !!(want.confirm || (want.agent && want.agent.id !== x && STATES.NEEDS_YOU.has(want.agent.state)));
  if (held.confirm) return S.confirm && S.confirm.id === held.confirm.id ? { f: { confirm: S.confirm }, also: also(null) } : { f: want, also: false };
  if (held.empty) return { f: want, also: false };
  const a = S.agents.get(held.agent.id);
  // the held item itself changed (its state, its ask, where its work went): show it as it is now
  if (!a || keyOf({ agent: a }) !== keyOf({ agent: held.agent })) return { f: want, also: false };
  const q = needsQueue(), i = q.findIndex(x => x.id === a.id);
  const f = i >= 0 ? { agent: a, index: i, total: q.length, picked: held.picked } : { ...held, agent: a };
  return { f, also: also(a.id) };
}

/**
 * What a typed or spoken line goes to: the item on screen when the person started. While the core swaps (and for the
 * moment after, while its answers are armed) the item coming in is not the one the person has read, so nothing is bound:
 * a "yes" then gets "Have a look at what … is asking first." instead of answering something unseen.
 */
let bound = null;
const bindingNow = () => (performance.now() < armedUntil || !lastView || el.pages.querySelector('.page.old, .page[data-hidden]') ? {} : { ...lastView.bind });
let lastView = null;

function measureLid(html, P) {
  const L = P.lid;
  const w = P.coreW - 2 * P.ring - 2 * L.padX;
  el.probe.style.width = w + 'px';
  el.probe.innerHTML = `<div class="page">${html}</div>`;
  const h = el.probe.firstElementChild.scrollHeight;
  el.probe.innerHTML = '';
  return h;
}

function buildLid(f, also, P, maxPage) {
  const linkS = linkNow();
  const L = P.lid, rowW = P.coreW - 2 * P.ring - 2 * L.padX;
  // two answers sit side by side when they fit on one line each, then with tighter padding, else one above the other
  const row = labels => buttonRow(labels, { rowW, px: L.btn, minW: L.btnmin, measure: (t, px) => measure(t, px, 600) });
  // the count line ("Search cleanup asks · 2 of 3", then "next") in the characters it has room for
  const cw = measure('M', L.count, 600);
  const whoMax = n => Math.max(16, Math.floor((rowW - 17 - (n > 1 ? measure('next', L.count, 600) + 16 : 0)) / cw));
  const base = { detail: prefs.detail, open, row, whoMax, link: ['no-key', 'stale', 'down', 'connecting'].includes(linkS) ? linkS : null, late: performance.now() - link.startedAt > 800 };
  let fit = 0, v, need;
  for (;;) {
    v = lidView(f, { ...base, fit });
    if (also) v.html += `<p class="also">${'<svg class="g k-need" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-need"/></svg>'}<span>Another one needs you</span></p>`;
    need = measureLid(v.html, P);
    if (need <= maxPage || fit >= 6) break;
    fit++;
  }
  v.need = need;
  v.fit = fit;
  return v;
}

// A swap runs in three steps, so no words are ever outside the lid: the old page fades out at the size it was laid out
// for; then, with the lid empty, the core takes the new item's size (one render); then the new page rises in. The core is
// always laid out for the page that can be seen (needForLayout), and its answers stay armed until the new page is in.
const OUT_MS = 200, IN_MS = 360, DRIFT = 6;
const swapCalm = () => debug.still || reduced() || document.hidden;

/** The lid height the board is laid out for: the outgoing page's while it is still on screen, else the item's own. */
function needForLayout(v) {
  if (swapCalm()) return v.need;
  const old = [...el.pages.querySelectorAll('.page.old')];
  if (old.length) return Math.max(...old.map(p => +p.dataset.need || 0));
  const cur = el.pages.querySelector('.page:not(.old)');
  if (cur && cur.dataset.key !== v.key && !cur.dataset.hidden) return +cur.dataset.need || v.need;
  return v.need;
}

function arm(ms) {
  armedUntil = Math.max(armedUntil, performance.now() + ms);
  el.core.classList.add('arming');
  clearTimeout(armTimer);
  armTimer = setTimeout(() => el.core.classList.remove('arming'), armedUntil - performance.now());
}

/** How far a page may drift as it fades: a few pixels, within the room its words leave in the lid (none when they fill it). */
const driftOf = p => Math.max(0, Math.min(DRIFT, Math.floor((p.clientHeight - (+p.dataset.need || 0)) / 2) - 1));

function fadeOut(p) {
  const cs = getComputedStyle(p);
  const from = { opacity: cs.opacity, transform: cs.transform === 'none' ? 'none' : cs.transform };
  for (const a of p.getAnimations()) a.cancel();
  const a = p.animate([from, { opacity: 0, transform: `translateY(-${driftOf(p)}px)` }], { duration: OUT_MS, easing: 'cubic-bezier(.4,0,.8,.6)', fill: 'forwards' });
  const gone = () => {
    p.remove();
    if (el.pages.querySelector('.page.old')) return;
    // the lid is empty: the core takes the new item's size now, then its page rises in
    try { renderNow(); } catch (err) { console.error(err); }
    const cur = el.pages.querySelector('.page:not(.old)');
    if (cur && cur.dataset.hidden) riseIn(cur);
  };
  a.finished.then(gone, gone);
}

function riseIn(p) {
  delete p.dataset.hidden;
  p.style.opacity = '';
  if (swapCalm()) return;
  p.animate([{ opacity: 0, transform: `translateY(${driftOf(p)}px)` }, { opacity: 1, transform: 'none' }], { duration: IN_MS, easing: 'cubic-bezier(.2,.7,.2,1)' });
  if (!p.dataset.key.startsWith('link:') && !(lidKey || '').startsWith('link:')) arm(IN_MS + 160);
}

function paintLid(v, f) {
  el.core.classList.toggle('idle', !!v.idle);
  el.core.classList.toggle('cannot', cannotSend(linkNow()));
  const cur = el.pages.querySelector('.page:not(.old)');
  if (cur && cur.dataset.key === v.key) {
    // the same thing, updated: patch the words, keep focus, an opened detail and a button whose answer is on its way
    if (patchChildren(cur, v.html)) cur.querySelector('h1')?.focus({ preventScroll: true });
    balanceHeading(cur.querySelector('h1')); // even lines where the engine cannot balance them (older WebKit)
    cur.dataset.need = String(v.need);
    if (lastView && lastView.count !== v.count && v.count) setText(el.announce, v.count + '.');
  } else {
    const hadFocus = el.pages.contains(document.activeElement);
    const calm = swapCalm() || !cur;
    if (cur) {
      cur.classList.add('old');
      cur.dataset.key = '';
      // a page nobody has seen yet (still waiting to rise) just goes
      if (calm || cur.dataset.hidden) cur.remove();
      else fadeOut(cur);
    }
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.key = v.key;
    page.dataset.need = String(v.need);
    patchChildren(page, v.html);
    el.pages.appendChild(page);
    balanceHeading(page.querySelector('h1'));
    if (!calm && el.pages.querySelector('.page.old')) { page.dataset.hidden = '1'; page.style.opacity = '0'; }
    else if (!calm) riseIn(page);
    // a new thing in the core: its answers wait until it is in and a moment more, so a click or a key meant for what was
    // there cannot land on it
    if (lidKey !== null && v.key !== lidKey && !v.key.startsWith('link:') && !lidKey.startsWith('link:')) arm(calm ? 500 : OUT_MS + IN_MS + 200);
    // never move focus to an answer: if it was in the core, it goes to the new sentence
    if (hadFocus) page.querySelector('h1')?.focus({ preventScroll: true });
    // words typed or spoken while the old item showed never go to the new one
    if (bound) bound = {};
    if (v.say) setText(el.announce, v.say);
    if (open.key !== v.key) Object.assign(open, { key: v.key, exact: false, changed: false, all: false });
  }
  lidKey = v.key;
  lidFocus = f;
  lastView = v;
  el.core.dataset.fit = String(v.fit || 0);
}
function setText(e, s) { if (e.textContent !== s) e.textContent = s; }

function paintPlaceholder(P) {
  const L = P.lid;
  const field = P.coreW - 2 * P.ring - 2 * L.padX - 18 - 30 - 8;
  const variants = voice.available
    ? [['type, or hold ', 'space', ' to talk'], ['type, or hold ', 'space', ''], ['type or talk', '', '']]
    : [['type what you want', '', ''], ['type here', '', '']];
  const fits = v => measure(v[0] + v[2], L.input, 400) + (v[1] ? measure(v[1], L.input * 0.88, 400) + 12 : 0) <= field;
  const v = variants.find(fits) || variants[variants.length - 1];
  const html = `${esc(v[0])}${v[1] ? `<kbd>${esc(v[1])}</kbd>` : ''}${esc(v[2])}`;
  if (el.ph.dataset.html !== html) { el.ph.innerHTML = html; el.ph.dataset.html = html; }
}

// ---------------------------------------------------------------- one render
const renderSoon = coalesce(() => renderNow(), 90);
let firstSnap = true;
function renderNow(o = {}) {
  if (!fontsReady) return;
  const W = innerWidth, H = innerHeight, P = sizeClass(W, H);
  board.setVars(P);
  const linkS = linkNow();
  el.html.dataset.link = linkS;
  const showData = S.loaded && linkS !== 'no-key';
  const { f, also } = showData ? shownFocus() : { f: { empty: true }, also: false };
  const agents = showData ? [...S.agents.values()] : [];
  const bm = boardModel(agents, { ...STATES, later: S.later, reviewed: S.reviewed, currentId: f.agent ? f.agent.id : null, machineName });
  // Who takes a lane and who waits in the done tray (boardmodel.js): agents from an earlier run never take a lane, nor do
  // agents the person is finished with; past twelve on the board, finished work there waits in the tray too and each
  // lane splits in two. Lanes are freed only while there is data: the first draw after a reload, before the snapshot,
  // and a page with no key have no agents, and must not free anyone's lane.
  const laptop = r => (S.machines.find(m => m.id === r.machineId)?.kind || (r.machineId === 'laptop' ? 'laptop' : 'cloud')) === 'laptop';
  const placed = boardAndTray(bm.roots, lanes, { laptop, maxRows: maxDenseRows(H, P), prune: showData });
  const { roots, laneOf, nRows, dense, tray } = placed;
  trayIds = placed.trayIds;
  // the board's name for a screen reader says how many wait in the done tray
  const boardName = `Your agents and their helpers${tray ? `. ${tray.sum}.` : ''}`;
  if (el.parts.getAttribute('aria-label') !== boardName) el.parts.setAttribute('aria-label', boardName);
  const fr = frame(W, H, P, { nRows, dense });
  const maxPage = fr.lidMaxH - P.lid.padT - P.lid.padB - P.lid.inh - P.lid.gap3;
  const v = buildLid(f, also, P, maxPage);
  const machines = showData ? S.machines.map(m => ({ id: m.id, name: m.name, awake: m.awake !== false, note: machineNote(m), noteText: machineNote(m) })) : [];
  G = layoutBoard({ W, H, P, detail: prefs.detail, roots, laneOf, nRows, dense, lidNeed: needForLayout(v), machines, tray, measure });
  G.queueLength = bm.queue.length;
  // the tray is drawn while it holds anyone (board.js paintTray): this run's agents, an earlier run's, or agents at work
  // with no room on the board; when it empties, its list closes and the keyboard there goes to the lid's sentence before
  // the tray is hidden
  if (!G.tray) trayEmptied();
  const hoverRoot = board.card.rootId || null;
  const left = board.render(G, { machines, tray, hoverRoot, litMachine: hoverMachine(), first: lastFirst || o.snap });
  lastFirst = false;
  // a card pinned to (or shown for) a chip that left the board goes with it, rather than move beside the tray
  if (left.length) {
    const gone = id => { const a = id && S.agents.get(id); return !!id && (left.includes(id) || (!!a && left.includes(a.rootId || a.parentId))); };
    if (gone(S.pinId)) S.pinId = null;
    if (gone(S.hoverId)) S.hoverId = null;
  }
  paintLid(v, f);
  paintTop(P, linkS);
  paintSaid();
  paintPlaceholder(P);
  for (const x of [el.parts, el.wires, el.machines, el.dram, el.files]) x.classList.toggle('dim', linkS === 'stale');
  el.parts.inert = linkS === 'stale' || linkS === 'no-key';
  el.machines.inert = linkS === 'stale' || linkS === 'no-key';
  paintDram(linkS);
  el.files.inert = linkS === 'stale' || linkS === 'no-key';
  renderCard(true);
  if (!el.pop.hidden) renderMachinesPop();
  if (!el.trayList.hidden) renderTrayList();
  if (S.loaded && firstSnap) { firstSnap = false; applyDebug(); }
  gitRender();
  if (connectShown()) connectNeeds(needsInfo());
  if (filesShown()) { filesNeeds(needsInfo()); filesRender(); }
}
const render = () => renderSoon();

function hoverMachine() {
  const id = S.pinId || S.hoverId;
  const a = id && S.agents.get(id);
  if (!a) return null;
  const root = a.rootId && S.agents.get(a.rootId) ? S.agents.get(a.rootId) : a;
  return root.machineId;
}

function machineNote(m) {
  const active = [...S.agents.values()].filter(a => !a.parentId && a.machineId === m.id && STATES.ACTIVE.has(a.state)).length;
  const parts = [m.awake === false ? 'asleep' : active ? `${active} agent${active === 1 ? '' : 's'}` : 'idle'];
  if (m.kind === 'laptop' && m.memPct >= 90) parts.push('memory almost full');
  else if (m.kind === 'cloud' && m.awake !== false && m.costPerHourUsd) parts.push(`${money(m.costPerHourUsd)} an hour`);
  return parts.join(' · ');
}

function paintTop(P, linkS) {
  const live = S.loaded && !cannotSend(linkS) && linkS !== 'connecting';
  el.mode.hidden = !(live && S.meta.mode === 'demo');
  if (!el.mode.hidden) { setText(el.mode, 'DEMO'); el.mode.title = 'Simulated agents and machines. Nothing is spent.'; }
  el.conn.hidden = !(linkS === 'reconnecting' || linkS === 'down');
  if (!el.conn.hidden) setText(el.conn, 'reconnecting…');
  el.spend.hidden = !live;
  if (live) {
    const sp = spendToday();
    const words = spentAmountWords(sp.usd, sp.estimated, money);
    const html = `${words.startsWith('about ') ? `<span>about</span> ${esc(words.slice(6))}` : esc(words)} <span>today</span>`;
    if (el.spend.dataset.html !== html) { el.spend.innerHTML = html; el.spend.dataset.html = html; }
  }
  const repo = S.meta.repo;
  el.repo.hidden = !(live && repo && repo.name);
  if (!el.repo.hidden) {
    // the person's own repository, in full where the top band has room: up to the fiducial left of the core, and clear
    // of spend and of "reconnecting…"
    let n = 24;
    if (G) {
      const left = G.brand.x + el.brand.offsetWidth - 2 + (el.mode.hidden ? 0 : el.mode.offsetWidth + 12);
      const right = Math.min(G.cx - P.coreW / 2 - 70 - 7 - 12, innerWidth - G.spend.right - (el.spend.hidden ? 0 : el.spend.offsetWidth) - 24);
      const conn = el.conn.hidden ? 0 : measure('reconnecting…', P.silkSub, 400) + 12;
      n = Math.max(12, Math.floor((right - left - conn) / measure('M', P.silkSub, 400)));
    }
    const short = clip(repo.name, n);
    const html = short === repo.name ? esc(short) : `<span aria-hidden="true">${esc(short)}</span><span class="sr">${esc(repo.name)}</span>`;
    if (el.repo.dataset.html !== html) { el.repo.innerHTML = html; el.repo.dataset.html = html; }
    el.repo.title = repo.name + (repo.dirty ? `. Agents start from your last commit. ${repo.dirty} uncommitted change${repo.dirty === 1 ? ' is' : 's are'} not in their copies.` : '');
  }
  if (G) board.placeTop(G, el);
  paintConnectBtn(P, live);
  paintPermBtn(P, live);
}

// ---------------------------------------------------------------- the card
function renderCard(quiet = false) {
  const id = S.pinId || S.hoverId;
  const a = id && S.agents.get(id);
  for (const b of el.parts.querySelectorAll('[data-kind="chip"], [data-kind="part"]')) {
    const mine = a && b.dataset.id === id;
    if (mine) b.setAttribute('aria-describedby', 'cardSum'); else b.removeAttribute('aria-describedby');
    b.setAttribute('aria-expanded', String(!!(S.pinId && b.dataset.id === S.pinId)));
  }
  if (!a || !G || !S.loaded) { board.hideCard(); return; }
  const P = G.P, more = prefs.detail === 'more';
  const one = !more || P.name === 'S';
  const width = more ? P.cardW : P.cardWCalm;
  const html = cardHtml(a, { detail: prefs.detail, now: Date.now(), one, pinned: S.pinId === id });
  const parentId = a.parentId ? (a.rootId && S.agents.has(a.rootId) ? a.rootId : a.parentId) : null;
  if (!board.showCard(id, html, { parentId, one, calm: !more, width: Math.min(width, innerWidth - 40), quiet })) return;
  board.lightMachine(hoverMachine());
}

// ---------------------------------------------------------------- answering what the core shows
const changed = () => { say('That changed. Have another look.', 5000); render(); };
const GUARDED = new Set(['answer', 'looksgood', 'fix', 'raise', 'stop', 'reviewed', 'later', 'confirm', 'reply', 'parent', 'pick', 'forget', 'merge', 'discard', 'review']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * The engine says where to look next (the asker after a refused answer, a stopped agent, a new one): follow it. An agent
 * the reply names before the stream has brought it (a launch just confirmed) comes to the core as soon as it arrives:
 * it is still the person's own move, so the hold does not keep it out.
 */
let lookPending = null;
const lookAt = id => { if (typeof id === 'string' && ID_RE.test(id)) { S.focusId = id; lookPending = S.agents.has(id) ? null : id; } };
const lookArrived = () => { if (lookPending && S.focusId === lookPending && S.agents.has(lookPending)) { lookPending = null; moved(); } };

// A button about to wait for its answer is disabled, and a disabled button drops the keyboard focus: hand it to the
// lid's sentence first (on the git screen, the detail's: its card's sentence or its heading), so the person keeps their
// place.
const gaveFocus = new WeakSet();
function busy(b) {
  if (document.activeElement === b) { gaveFocus.add(b); (b.closest('.page')?.querySelector('h1') || gitHome(b))?.focus({ preventScroll: true }); }
  b.disabled = true;
}
/** A failed answer: its button can be tried again, and gets the keyboard back if it had it. */
function retry(b) {
  b.disabled = false;
  if (gaveFocus.has(b)) { gaveFocus.delete(b); if (b.isConnected) b.focus({ preventScroll: true }); }
}

el.pages.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.closest('.page.old, .page[data-hidden]')) return;
  // clicks are ignored while the core swaps and for a moment after, so they cannot land on something new
  if (GUARDED.has(b.dataset.act) && performance.now() < armedUntil) return;
  actOn(b);
});

/**
 * What a lid button does. It acts only on what it was drawn for: the agent (data-agent), its ask (data-ask), the state it
 * was in (data-state), where its work was (data-work) and the branch a merge was offered into (data-into); anything
 * else says "That changed. Have another look." and sends nothing. Buttons outside the lid that carry the same data-*
 * (the git screen's detail: Merge, Throw it away, a card's yes and no) can be handed to this too; the swap guard stays
 * with the caller. `o.answer`: the words typed or said for it ("Not now" at a lid whose "Looks good" answers both).
 */
async function actOn(b, o = {}) {
  const act = b.dataset.act;
  touch();
  if (act === 'next') { stepQueue(1); moved(); render(); return; }
  if (act === 'exact' || act === 'changed' || act === 'all' || act === 'readall') {
    const k = act === 'readall' ? 'all' : act;
    open[k] = !open[k];
    renderNow();
    el.pages.querySelector(`.page:not(.old) [data-act="${act}"]`)?.focus({ preventScroll: true });
    return;
  }
  if (act === 'unpick') { S.focusId = null; S.pinId = null; moved(); render(); return; }
  if (act === 'pick') { S.focusId = b.dataset.agent; moved(); render(); return; }
  // "Connect a coding agent to start.": Connect opens Agents & keys, and sends nothing
  if (act === 'connect') { showConnect(b); return; }
  if (act === 'confirm') {
    const id = b.dataset.confirm;
    const c = cardShown(id);
    if (!c) { changed(); return; }
    const go = b.dataset.go === '1';
    busy(b);
    // the outcome of a merge or a throw-away shows on that agent: the engine's reply names it (focusId), or the page
    // remembers which agent's button asked for the card
    const after = r => { lookAt(r && r.focusId); if (go && !(r && r.focusId) && (c.kind === 'merge' || c.kind === 'discard')) lookAt(c.agentId); };
    try {
      const r = await api.confirm(id, go);
      if (S.confirm && S.confirm.id === id) S.confirm = null;
      // the setup card goes at once (the stream's snapshot says so too)
      if (S.setup && S.setup.id === id) S.setup = null;
      // the yes to full permissions: the band's button lights at once (the stream's snapshot says so too)
      if (r) modeIs(r.permissions);
      say(r.reply || '', lasting(r));
      after(r);
      moved();
      // a start with no agent ready: "No coding agent is ready yet. Connect one in Agents & keys."
      if (r && r.openConnect === true) showConnect(null, r.reply);
    } catch (err) {
      if (err.refused && (c.kind === 'merge' || c.kind === 'discard')) {
        // the engine took the card and said no (a merge git refused: the reason stays on the agent until it clears)
        if (S.confirm && S.confirm.id === id) S.confirm = null;
        say(err.message);
        after(null);
        moved();
      } else { retry(b); say(err.message); }
    }
    render();
    return;
  }
  const a = S.agents.get(b.dataset.agent);
  if (!a) { changed(); return; }
  if (b.dataset.ask && (!a.ask || a.ask.id !== b.dataset.ask)) { changed(); return; }
  if (b.dataset.state && a.state !== b.dataset.state) { changed(); return; }
  if (b.dataset.work != null && workKey(a) !== b.dataset.work) { changed(); return; }
  if (b.dataset.into != null && (S.meta.repo?.branch || '') !== b.dataset.into) { changed(); return; }
  if (act === 'review') {
    // read-only: the git screen, on this agent's branch, with its diff. Nothing is sent.
    openGitOn(a.id, b);
    return;
  }
  try {
    if (act === 'answer') {
      busy(b);
      const r = await api.answer(a.id, b.dataset.ask, b.dataset.answer);
      answeredOnce();
      say(r.reply || `Told ${a.name}: ${b.dataset.answer}.`);
      if (S.focusId === a.id) S.focusId = null;
    } else if (act === 'reply') {
      startReply(a, b.dataset.mode || 'say', b.dataset.ask || null, b.dataset.state || a.state);
      render();
      return;
    } else if (act === 'fix') {
      busy(b);
      const r = await api.say(a.id, b.dataset.text);
      say(r.reply || `Sent to ${a.name}.`);
      if (S.focusId === a.id) S.focusId = null;
      // "Continue" or "Try again" with no agent ready to run it
      if (r.openConnect === true) showConnect(null, r.reply);
    } else if (act === 'raise') {
      // "Give it $2.00 more": one more spending limit for this run, and it continues; the engine checks it all again
      busy(b);
      const r = await api.raiseLimit(a.id, { state: b.dataset.state });
      say(r.reply || '');
      if (S.focusId === a.id) S.focusId = null;
    } else if (act === 'forget') {
      // an agent from an earlier run: the engine asks first, with a card like a launch's
      busy(b);
      const r = await api.command('forget it', { focusId: a.id });
      if (r.confirm) S.confirm = r.confirm; else say(r.reply || '');
    } else if (act === 'merge' || act === 'discard') {
      // Merge (also "Merge anyway" and "Try again") and Throw it away never act by themselves: the engine answers with a
      // card in its own words, bound by id, and the person answers that. Its outcome then shows on this agent.
      busy(b);
      // A card already on screen (a launch question in the lid while the git screen's detail is used, another agent's
      // card) is withdrawn first, as picking a chip does, so none waits unseen. If that does not go through, it stays,
      // nothing is asked, and this button can be tried again.
      const old = S.confirm;
      if (old) {
        const w = await api.confirm(old.id, false);
        if (S.confirm === old) S.confirm = null;
        say(w.reply || '');
      }
      const r = await (act === 'merge' ? api.merge(a.id, { state: b.dataset.state }) : api.discard(a.id, { state: b.dataset.state }));
      S.focusId = a.id;
      if (r.confirm) S.confirm = { ...r.confirm, agentId: a.id }; else say(r.reply || '');
    } else if (act === 'looksgood') {
      // finished work has no ask, so this answer goes without an askId; the engine leaves the agent as it is ("Not now"
      // says so in its own words, so it never sounds like approval)
      busy(b);
      // its own answer, or the words typed or said for it ("not now" at a lid whose "Looks good" answers both)
      const r = await api.answer(a.id, null, (o.answer || b.dataset.answer) === 'Not now' ? 'Not now' : 'Looks good');
      markReviewed(a);
      answeredOnce();
      say(r.reply || '', 4000);
      if (S.focusId === a.id) S.focusId = null;
      if (S.pinId === a.id) S.pinId = null;
    } else if (act === 'reviewed') {
      // a Dismiss drawn for the work as it is now (its data-work, checked above) also lets a merge that did not go
      // through go; one drawn before that problem came (a stopped or failed agent's) marks only the finish
      markReviewed(a, { problem: b.dataset.work != null });
      if (S.focusId === a.id) S.focusId = null;
      if (S.pinId === a.id) S.pinId = null;
    } else if (act === 'later') {
      setAside(a);
      if (S.focusId === a.id) S.focusId = null;
      say(`OK, ${a.name} can wait.`);
    } else if (act === 'stop') {
      busy(b);
      const r = await api.stop(a.id);
      say(r.reply || `Stopped ${a.name}.`);
    } else if (act === 'parent') {
      S.focusId = a.parentId;
    }
    // the person's own move: what it leads to shows at once, even with the pointer or the keyboard still in the core
    moved();
  } catch (err) {
    // a failed answer changes nothing: the core keeps what the person answered (still held), and its button can be
    // tried again
    retry(b);
    say(err.message);
  }
  render();
}

/**
 * The git screen, opened on one agent's branch and its diff: "Review the changes", "See it in git", or a reply that
 * carries `review`. `opener` (the lid's link) gets the keyboard back when the person comes back to the board.
 */
function openGitOn(agentId, opener) {
  openGit({ agentId, opener: opener || null });
}

el.core.addEventListener('pointerenter', () => { pointer.inCore = true; touch(); });
el.core.addEventListener('pointermove', touch);
el.core.addEventListener('pointerleave', () => { pointer.inCore = false; render(); });
el.core.addEventListener('focusout', e => { if (!el.core.contains(e.relatedTarget)) render(); });

// ---------------------------------------------------------------- typing and talking
function startReply(a, mode, askId, state) {
  // the reply keeps the agent, the ask, and the state it was opened in: a message is sent only while that still holds
  S.reply = { agentId: a.id, mode, askId: mode === 'answer' ? askId : null, state: state || a.state };
  // the chip takes at most half the input row: "to Search cleanup:" with the name cut to fit
  const P = G ? G.P : null, barW = P ? P.coreW - 2 * P.ring - 2 * P.lid.padX - 18 : 260;
  const verb = mode === 'answer' ? (a.state === 'maybe_stuck' ? 'hint to' : 'to') : 'tell';
  const chars = Math.floor((barW * 0.5 - 34) / measure('M', P ? P.lid.meta : 12, 600));
  el.toText.textContent = `${verb} ${visibleControls(clip(a.name, Math.max(6, chars - verb.length - 2)))}:`;
  el.to.title = `${mode === 'answer' ? 'Your answer goes to' : 'This goes to'} ${visibleControls(a.name)}`;
  el.bar.classList.add('replying');
  el.say.setAttribute('aria-label', mode === 'answer' ? `Your answer to ${visibleControls(a.name)}` : `What to tell ${visibleControls(a.name)}`);
  el.say.focus();
}
function endReply() {
  S.reply = null;
  el.bar.classList.remove('replying');
  el.say.setAttribute('aria-label', 'Type what you want, or hold the space bar to talk');
}
el.toCancel.addEventListener('click', () => { endReply(); el.say.focus(); render(); });

el.say.addEventListener('input', () => {
  touch();
  el.bar.classList.toggle('typed', !!el.say.value);
  if (el.say.value && !bound) bound = bindingNow();
  if (!el.say.value) bound = null;
});

function applyPref(kind, value, { quietly = false } = {}) {
  const v = kind === 'theme' ? normalTheme(value) : normalDetail(value);
  const change = () => { prefs[kind] = v; el.html.dataset[kind] = v; syncMenu(); renderNow({ snap: true }); };
  if (prefs[kind] === v) { syncMenu(); return; }
  if (document.startViewTransition && !reduced() && !debug.still && !document.hidden) {
    // a cross-fade; a second change during it skips the first fade (the change itself still happens)
    const vt = document.startViewTransition(change);
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p?.catch(() => {});
  } else change();
  if (!quietly) say(kind === 'theme' ? `Look: ${THEME_NAMES[v]}.` : `Detail: ${DETAIL_NAMES[v]}.`, 4000);
  // Workbench keeps it for its next start. When it cannot, it says so, and the choice still lasts for this run; a page
  // Workbench no longer answers already says that in its own way.
  if (hasToken()) api.prefs({ [kind]: v }).catch(e => { if (e?.refused) say(e.message); });
}

/** The data-words (focus.js) of what lidAnswer names: the lid's buttons say which of these words they answer. */
const LID_WORDS = { 'Looks good': 'looks-good', 'Not now': 'not-now' };

/**
 * The lid's own button that "looks good" or "not now", typed or spoken (lidAnswer), stand for at a finished agent's lid:
 * the one that carries those words in data-words, on the page shown now (not one fading out, nor one still to rise),
 * drawn for the agent the words were bound to when they began. null when the lid has none for them.
 */
function lidButton(label, b) {
  const words = LID_WORDS[label];
  if (!words || !b || !b.agentId) return null;
  const page = el.pages.querySelector('.page:not(.old):not([data-hidden])');
  return [...(page ? page.querySelectorAll('button[data-words]') : [])].find(x => x.dataset.agent === b.agentId && x.dataset.words.split(' ').includes(words)) || null;
}

async function submit(text) {
  text = String(text || '').trim();
  if (!text) return;
  // A key typed or pasted here is never sent, to the engine or to an agent: the input is emptied and Agents & keys opens
  if (refuseKey(text, true)) return;
  const b = bound || bindingNow();
  bound = null;
  el.say.value = '';
  el.bar.classList.remove('typed');
  // D1: "git", "show git", "open git", "source control", "show the graph" open the git screen (never sent to the engine)
  if (!S.reply && gitScreenWords(text) === 'open') { openGit({ opener: el.dram }); return; }
  // the page's own words: the look, the detail, and stepping through the queue. They never reach the engine.
  const pc = S.reply ? null : pageCommand(text);
  if (pc) {
    if (pc.kind === 'theme' || pc.kind === 'detail') applyPref(pc.kind, pc[pc.kind]);
    else if (!stepQueue(1)) say('That is the only thing that needs you.', 4000);
    else moved();
    render();
    return;
  }
  if (cannotSend(linkNow())) return;
  // "looks good" or "not now" (the engine's own words for them) at a finished agent's lid never go to the engine: the
  // page presses the button that stands for them there (its data-words, drawn for the agent the words were begun for),
  // so they do exactly what it does. Where none stands for "looks good" (work that can merge, a failed check, a merge
  // that did not go through, a stopped or failed agent, one from an earlier run), it says which answers the lid has, and
  // does nothing more: words that sound like approval never merge work, continue or retry an agent, nor let it go where
  // the lid has no "Looks good". Anything else, or words bound to nothing (begun before the lid changed), goes on as before.
  const said = !S.reply && !S.confirm && b.finished ? lidAnswer(text, ANSWERS) : null;
  if (said) {
    const press = lidButton(said, b);
    if (!press) say(b.hint, 6000);
    else if (!press.disabled) await actOn(press, { answer: said });
    return;
  }
  try {
    if (S.reply) {
      const r = S.reply;
      endReply();
      const a = S.agents.get(r.agentId);
      let res;
      if (r.mode === 'answer' && r.askId) {
        if (!a || !a.ask || a.ask.id !== r.askId) { el.say.value = text; say(`${a ? a.name : 'That agent'} asked something new. Have a look first.`); render(); return; }
        res = await api.answer(r.agentId, r.askId, text);
      } else {
        // a message carries no ask id, so it goes only while the agent is as it was when the reply opened
        if (!a || a.state !== r.state) { el.say.value = text; el.bar.classList.add('typed'); say('That changed. Have another look.', 5000); render(); return; }
        res = await api.say(r.agentId, text);
      }
      answeredOnce();
      say(res.reply || 'Sent.');
      if (S.focusId === r.agentId) S.focusId = null;
      if (res.openConnect === true) showConnect(null, res.reply);
    } else {
      const shown = cardShown(b.confirmId);
      const res = await api.command(text, { focusId: shown ? null : (b.agentId || null), confirmId: shown ? shown.id : (b.confirmId || null), askId: shown ? null : (b.askId || null) });
      // the card shown, back again (words not understood, or a look at the work it is about): it stays, still bound to
      // the agent it was drawn for. The setup card stays where it is (S.setup, from the stream) until it is answered.
      if (res.confirm && res.confirm.kind !== 'setup') S.confirm = shown && res.confirm.id === shown.id ? { ...res.confirm, agentId: shown.agentId } : res.confirm;
      else if (!res.confirm && shown && S.confirm === shown) S.confirm = null;
      lookAt(res.focusId);
      // the reply to the person's own words: a new launch question, or the agent it names, shows at once
      if (res.confirm || res.focusId || shown) moved();
      if (b.askId && !res.confirm) answeredOnce();
      // a new launch question in the core already says it; anything else is said under the core
      say(res.confirm && (!shown || res.confirm.id !== shown.id) ? '' : (res.reply || ''), lasting(res));
      // "what did search cleanup change": the git screen opens on that agent's branch and its diff
      // also with a merge or throw-away card still shown: the person looks at the work first, then answers the card
      if (typeof res.review === 'string' && ID_RE.test(res.review) && (!res.confirm || (shown && res.confirm.id === shown.id))) openGitOn(res.review, null);
      // "connect", "add a key", "sign in", or work asked for with no agent ready: Agents & keys opens
      if (res.openConnect === true) showConnect(null, res.reply);
    }
  } catch (err) { say(err.message); }
  render();
}
el.bar.addEventListener('submit', e => { e.preventDefault(); submit(el.say.value); });

// Voice is bound to what the screen the microphone turned on over showed (the lid, or the git screen's detail), and what
// it heard goes to that screen's words: a session begun on the git screen never takes the core's binding, and one that
// heard nothing leaves no binding behind.
let voiceOver = null;   // 'board' | 'git' while listening, and until what was heard is sent
const voice = setupVoice({
  mic: el.mic, heard: [el.heard, $('gitHeard')],
  onFinal: t => { const over = voiceOver; voiceOver = null; if (over === 'git') gitCommand(t, gitTake()); else submit(t); },
  onNotice: t => say(t),
  onListening: (on, words) => {
    el.bar.classList.toggle('listening', on);
    gitListening(on);
    if (on) {
      touch();
      voiceOver = gitShown() ? 'git' : 'board';
      if (voiceOver === 'git') gitHold(); else if (!bound) bound = bindingNow();
      return;
    }
    if (!words) {
      if (voiceOver === 'git') gitRelease(); else if (!el.say.value) bound = null;
      voiceOver = null;
    }
    render();
  },
});

/** The card with this id the core may show: the card on screen, or the setup card launches wait on; else null. */
function cardShown(id) {
  return [S.confirm, S.setup].find(c => c && typeof id === 'string' && c.id === id) || null;
}

/**
 * The setup card a snapshot carries (launches wait on it), with only the fields the core draws; null when there is none.
 * It is not dropped like a launch question (Esc, picking a chip): it stays until it is answered.
 */
function setupCardOf(c) {
  if (!c || typeof c !== 'object' || c.kind !== 'setup' || typeof c.id !== 'string' || !ID_RE.test(c.id) || typeof c.sentence !== 'string' || typeof c.command !== 'string') return null;
  return { id: c.id, kind: 'setup', sentence: c.sentence, command: c.command, detail: typeof c.detail === 'string' ? c.detail : null,
    yes: typeof c.yes === 'string' && c.yes ? c.yes : 'Run it', no: typeof c.no === 'string' && c.no ? c.no : 'Not now' };
}

// A launch question the page drops on its own (Esc, or picking a chip) is withdrawn, so a later "yes" cannot start it.
function dropConfirm() {
  const c = S.confirm;
  if (!c) return;
  S.confirm = null;
  // if the withdrawal does not go through, the card stays: no launch question waits unseen
  api.confirm(c.id, false).then(r => say(r.reply || ''), err => { if (!S.confirm) S.confirm = c; say(err.message); render(); });
}

function pickAgent(id) {
  if (!S.agents.has(id)) return;
  if (S.confirm) dropConfirm();
  if (S.pinId === id) { S.pinId = null; if (S.focusId === id) S.focusId = null; }
  else { S.pinId = id; S.hoverId = id; S.focusId = id; }
  moved();
  render();
}

// Keys. Type anywhere: letters go to the input unless a text field has the keyboard. Hold space to talk unless a
// control reached by the keyboard has it (then space presses it, as everywhere else). Clicks never move the keyboard.
let holding = false;
document.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
const isTextField = e => !!e && e.matches('input:not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable="true"], [contenteditable=""]');
const isControl = e => !!e && e !== document.body && e.matches('button, a[href], input, select, textarea, [role="switch"], [tabindex="0"]');
document.addEventListener('keydown', e => {
  touch();
  // While Agents & keys is open the board takes no keys at all: no typing into the board's input (a key typed with a
  // button focused must not land there), no talking, no arrows. Esc closes the panel and does nothing else.
  if (connectShown()) { if (e.key === 'Escape') { e.preventDefault(); closeConnect(); } return; }
  // While the file view shows, it takes the keys (Esc, ⌘P, ⌘⇧F, ⌘S, letters to its field), and the board takes none:
  // space types a space in its field and its editor, and never starts listening.
  if (filesShown()) { filesKey(e); return; }
  // ⌘P (Ctrl+P off a Mac) finds a file, ⌘⇧F words in the files: the file view, its field focused
  if ((isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !cannotSend(linkNow())) {
    const k = String(e.key).toLowerCase();
    if (k === 'p' && !e.shiftKey) { e.preventDefault(); showFiles({ mode: 'find' }); return; }
    if (k === 'f' && e.shiftKey) { e.preventDefault(); showFiles({ mode: 'search' }); return; }
  }
  if (e.key === 'Escape') { escape(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement;
  if (isTextField(ae)) return;
  if (cannotSend(linkNow())) return;
  if (e.key === ' ' || e.code === 'Space') {
    if (isControl(ae)) return;
    e.preventDefault();
    if (!e.repeat && !holding && voice.available) { holding = true; voice.start({ hold: true }); }
    return;
  }
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !isControl(ae) && !el.look.contains(ae) && !gitShown()) {
    if (stepQueue(e.key === 'ArrowRight' ? 1 : -1)) { e.preventDefault(); moved(); render(); }
    return;
  }
  if (e.key.length === 1 && !el.look.contains(ae)) {
    // D1: on the git screen, letters go to its own input on its top band
    const input = gitShown() ? el.gitSay : el.say;
    e.preventDefault();
    input.focus();
    input.value += e.key;
    input.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keyup', e => { if ((e.key === ' ' || e.code === 'Space') && holding) { holding = false; voice.stop(); } });
// The mic stops (and throws away what it heard) when the window loses focus or the tab is hidden.
const lostFocus = () => { if (voice.listening) { voice.cancel(); say('Stopped listening.', 4000); } holding = false; };
addEventListener('blur', lostFocus);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { lostFocus(); return; }
  document.title = 'Workbench';
  renderNow({ snap: true });
});

function escape() {
  if (connectShown()) { closeConnect(); return; }   // Agents & keys first: it covers everything else
  if (filesShown()) { filesEscape(); return; }   // then the file view, over either screen
  if (gitShown() && !voice.listening && gitEscape()) return;   // D1: the detail closes, then back to the board
  if (!el.look.hidden) { closeLook(true); return; }
  if (!el.pop.hidden) { closePop(); return; }
  if (!el.trayList.hidden) { closeTray(); return; }
  if (voice.listening) { voice.cancel(); say('Stopped listening.', 4000); return; }
  if (S.reply) { endReply(); render(); return; }
  if (document.activeElement === el.say) { el.say.blur(); return; }
  if (S.pinId) { S.pinId = null; render(); return; }
  if (S.confirm) { dropConfirm(); render(); return; }
  if (isControl(document.activeElement)) el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
}

// A click on the bare board unpins the card.
el.board.addEventListener('click', () => { if (S.pinId) { S.pinId = null; render(); } });
document.addEventListener('click', e => {
  if (!el.pop.hidden && !el.pop.contains(e.target) && !e.target.closest('.mach')) closePop();
  if (!el.trayList.hidden && !el.trayList.contains(e.target) && !el.tray.contains(e.target)) closeTray();
  if (!el.look.hidden && !el.look.contains(e.target) && !el.brand.contains(e.target)) closeLook(false);
  if (S.pinId && !e.target.closest('#parts, #card, #core, .pop, .mach, #tray, #brand, #connect, #connectBtn, #permBtn')) { S.pinId = null; render(); }
});

// ---------------------------------------------------------------- the look menu (the workbench mark)
function syncMenu() {
  for (const r of el.look.querySelectorAll('input[name="theme"]')) r.checked = r.value === prefs.theme;
  for (const r of el.look.querySelectorAll('input[name="detail"]')) r.checked = r.value === prefs.detail;
}
function openLook() {
  syncMenu();
  el.look.hidden = false;
  el.brand.setAttribute('aria-expanded', 'true');
  const r = el.brand.getBoundingClientRect();
  el.look.style.left = Math.round(Math.max(8, r.left - 4)) + 'px';
  el.look.style.top = Math.round(r.bottom + 10) + 'px';
  el.look.querySelector('input:checked')?.focus({ preventScroll: true });
}
function closeLook(refocus) {
  el.look.hidden = true;
  el.brand.setAttribute('aria-expanded', 'false');
  if (refocus) el.brand.focus({ preventScroll: true });
}
el.brand.addEventListener('click', () => (el.look.hidden ? openLook() : closeLook(false)));
el.look.addEventListener('change', e => {
  const r = e.target;
  if (r.name === 'theme' || r.name === 'detail') applyPref(r.name, r.value, { quietly: true });
});

// ---------------------------------------------------------------- the machines menu (any section of the connector)
let popAnchor = null;
function toggleMachines(anchor) {
  if (!el.pop.hidden && popAnchor === anchor) { closePop(); return; }
  popAnchor = anchor;
  el.pop.hidden = false;
  for (const m of el.machines.querySelectorAll('.mach')) m.setAttribute('aria-expanded', String(m === anchor));
  renderMachinesPop();
  el.pop.querySelector('button')?.focus({ preventScroll: true });
}
function closePop() {
  el.pop.hidden = true;
  for (const m of el.machines.querySelectorAll('.mach')) m.setAttribute('aria-expanded', 'false');
  if (popAnchor && el.pop.contains(document.activeElement)) popAnchor.focus({ preventScroll: true });
  popAnchor = null;
}
function renderMachinesPop() {
  const rows = S.machines.map(m => {
    const icon = m.kind === 'laptop' ? 'laptop' : m.awake !== false ? 'cloud' : 'sleep';
    const stats = m.kind === 'laptop' && m.cpuPct != null ? `CPU ${Math.round(m.cpuPct)}% · memory ${Math.round(m.memPct)}%` : '';
    const small = [machineNote(m), stats].filter(Boolean).join(' · ');
    const sw = m.kind === 'cloud' ? `<button class="sw" type="button" role="switch" aria-checked="${m.awake !== false}" aria-label="${esc(m.name)} awake" data-machine="${esc(m.id)}" data-key="m:${esc(m.id)}"></button>` : '';
    return `<div class="m" data-key="row:${esc(m.id)}"><svg class="g c-${m.awake !== false ? 'ok' : 'sleep'}" viewBox="0 0 24 24" aria-hidden="true"><use href="#g-${icon}"/></svg><span class="mn">${esc(m.name)}<small>${esc(small)}</small></span>${sw}</div>`;
  }).join('');
  const idle = S.machines.find(m => m.kind === 'cloud' && m.awake !== false && !m.agents);
  const hint = idle ? `<div class="hint" data-key="hint"><span>${esc(idle.name)} is idle. Sleep it?</span><button type="button" data-sleep="${esc(idle.id)}" data-key="sleep:${esc(idle.id)}">Sleep</button></div>` : '';
  const sim = S.machines.some(m => m.simulated) ? '<p class="note">Cloud machines here are simulated.</p>' : '';
  if (patchChildren(el.pop, rows + hint + sim)) popAnchor?.focus({ preventScroll: true });
  // just above the connector, beside the core (never on it)
  const r = (popAnchor || el.machines.firstElementChild)?.getBoundingClientRect();
  if (!r || !G) return;
  const w = el.pop.offsetWidth, h = el.pop.offsetHeight;
  let x = Math.min(innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2)), y = Math.round(r.top - h - 10);
  const c = G.core;
  if (x < c.r + 12 && x + w > c.x - 12 && y < c.b + 12) x = r.left + r.width / 2 >= G.cx ? Math.min(innerWidth - w - 12, c.r + 16) : Math.max(12, c.x - 16 - w);
  el.pop.style.left = Math.round(x) + 'px'; el.pop.style.top = Math.max(8, y) + 'px';
}
el.pop.addEventListener('click', async e => {
  const sw = e.target.closest('[data-machine]'), sl = e.target.closest('[data-sleep]');
  // while its request is on the way a switch says so with aria-disabled, which (unlike disabled) keeps the keyboard on it
  const btn = sw || sl;
  if (!btn || btn.getAttribute('aria-disabled') === 'true') return;
  btn.setAttribute('aria-disabled', 'true');
  try {
    const r = sw ? await api.awake(sw.dataset.machine, sw.getAttribute('aria-checked') !== 'true') : await api.awake(sl.dataset.sleep, false);
    say(r.reply);
  } catch (err) { say(err.message); }
  btn.removeAttribute('aria-disabled');
});

// ---------------------------------------------------------------- the done tray (agents you are finished with, earlier
// runs' agents, and finished or waiting work with no room on a dense board)
function toggleTray(anchor) {
  if (!el.trayList.hidden) { closeTray(); return; }
  el.trayList.hidden = false;
  el.tray.setAttribute('aria-expanded', 'true');
  renderTrayList();
  el.trayList.querySelector('button')?.focus({ preventScroll: true });
  void anchor;
}
function closeTray() {
  const inside = el.trayList.contains(document.activeElement);
  el.trayList.hidden = true;
  el.tray.setAttribute('aria-expanded', 'false');
  if (inside) el.tray.focus({ preventScroll: true });
}
/**
 * The tray is about to be hidden: it holds nothing any more (its last agent is back on the board, or no data is shown).
 * An open list closes, and the keyboard on the tray or in its list goes to the lid's sentence first, so it is never
 * dropped (closeTray would hand it to the tray, which is going).
 */
function trayEmptied() {
  const had = el.tray.contains(document.activeElement) || el.trayList.contains(document.activeElement);
  if (!el.trayList.hidden) { el.trayList.hidden = true; el.tray.setAttribute('aria-expanded', 'false'); }
  if (had) lidHome();
}
let trayIds = { done: [], earlier: [], over: [] };
function renderTrayList() {
  // each row: its mark, its name, and a few words: where its work went or how it ended ("merged", "thrown away", "not
  // merged", "checks failed", "stopped"), how long ago for an earlier run's agent, or its state for one at work with no room
  const row = (id, words) => {
    const a = S.agents.get(id);
    if (!a) return '';
    const m = markOf(a.state, STATES.LOOK);
    return `<button type="button" class="row${a.earlier ? ' earlier' : ''}" data-agent="${esc(a.id)}" data-key="t:${esc(a.id)}"><svg class="g c-${m.tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${m.shape}"/></svg><span>${esc(visibleControls(a.name))} <em>· ${esc(words(a, m))}</em></span></button>`;
  };
  const done = trayIds.done.map(id => row(id, a => doneWords(a, STATES.LOOK))).join('');
  const early = (trayIds.earlier || []).map(id => row(id, a => agoText(Date.now() - (a.endedAt || a.stateSince)))).join('');
  const over = trayIds.over.map(id => row(id, (a, m) => m.label)).join('');
  // "Done" heads the list when it holds this run's agents, and stands alone ("Nothing yet.") only when it holds no one
  const lone = !done && !early && !over;
  // a row that held the keyboard and went (its agent back on the board) hands it to the list's first row, else the tray
  const lost = patchChildren(el.trayList, `${done || lone ? `<h2>Done</h2>${done || '<p class="note">Nothing yet.</p>'}` : ''}${early ? `<h2>From earlier runs</h2>${early}` : ''}${over ? `<h2>Working, with no room on the board</h2>${over}` : ''}`);
  if (lost) (el.trayList.querySelector('button') || el.tray).focus({ preventScroll: true });
  const r = el.tray.getBoundingClientRect();
  // above the tray, inside the board and beside the core (never on it, never on the top band)
  const top = G ? G.board.y + G.P.topBand : 8;
  el.trayList.style.width = '';
  el.trayList.style.maxHeight = Math.max(120, r.top - 10 - top) + 'px';
  el.trayList.style.overflow = 'auto';
  let w = el.trayList.offsetWidth;
  if (G) { const room = G.core.x - 12 - (G.board.x + 8); if (w > room && room >= 200) { el.trayList.style.width = room + 'px'; w = room; } }
  const h = el.trayList.offsetHeight;
  el.trayList.style.left = Math.round(Math.max(8, Math.min(r.left, (G ? G.core.x - 12 : innerWidth - 8) - w))) + 'px';
  el.trayList.style.top = Math.round(Math.max(top, r.top - h - 10)) + 'px';
}
el.trayList.addEventListener('click', e => {
  const b = e.target.closest('[data-agent]');
  if (!b) return;
  S.focusId = b.dataset.agent;
  const kb = el.trayList.contains(document.activeElement);
  closeTray();
  // the agent goes to the core; a keyboard user follows it there (its sentence), a mouse user's focus stays put
  if (kb) lidHome();
  moved();
  render();
});

// ---------------------------------------------------------------- live data
function applyDebug() {
  const all = [...S.agents.values()];
  if (debug.pin) {
    const pick = debug.pin === 'first-helper' ? all.find(a => a.parentId && a.state === 'working') || all.find(a => a.parentId)
      : debug.pin === 'first-root' ? all.find(a => !a.parentId) : S.agents.get(debug.pin);
    if (pick) { S.pinId = pick.id; S.hoverId = pick.id; }
  }
  if (debug.focus && S.agents.has(debug.focus)) S.focusId = debug.focus;
  renderSoon();
}

/** The permission mode a snapshot gives ('full' or 'ask'); an engine that says neither keeps what the page had. */
const snapMode = (snap, was) => (snap.permissions === 'full' || snap.permissions === 'ask' ? snap.permissions : was);

/**
 * The permission mode as the engine says it now. When it changes, a card that would turn full permissions on goes: the
 * engine withdrew it (they were turned off) or would refuse it (it asks about the mode as it was), here or in another tab.
 */
function modeIs(mode) {
  if (mode !== 'full' && mode !== 'ask') return;
  if (mode !== S.meta.permissions && S.confirm?.kind === 'permissions') S.confirm = null;
  S.meta.permissions = mode;
}

function onSnapshot(snap) {
  // meta.connect (which agents can start work), when this engine has Agents & keys; null keeps today's board.
  // meta.permissions: whether full permissions are on, for the band's button and the launch card.
  const was = S.meta.permissions;
  S.meta = { mode: snap.mode, repo: snap.repo, harnesses: snap.harnesses || {}, defaultBudgetUsd: snap.defaultBudgetUsd, spendTodayUsd: snap.spendTodayUsd, connect: connectMeta(snap),
    permissions: was };
  modeIs(snapMode(snap, was));
  // the setup card launches wait on, here or answered in another tab
  S.setup = setupCardOf(snap.setup);
  const fresh = new Map((snap.agents || []).map(a => [a.id, a]));
  for (const id of [...S.agents.keys()]) if (!fresh.has(id)) S.agents.delete(id);
  upsert(snap.agents || []);
  lookArrived();
  // lanes of agents that are gone, or not on the board any more, are freed as the board is drawn (boardAndTray)
  S.machines = snap.machines || [];
  const wasLoaded = S.loaded;
  S.loaded = true;
  for (const a of S.agents.values()) seenSteps.set(a.id, a.toolCalls || 0);
  if (!wasLoaded && snap.mode === 'live' && snap.repo && snap.repo.dirty) say(`Agents start from your last commit. ${snap.repo.dirty} uncommitted change${snap.repo.dirty === 1 ? ' is' : 's are'} not in their copies.`, 15000);
  render();
  autoOpenConnect();
}

const seenSteps = new Map();
function onAgents(list) {
  for (const a of list) {
    const prev = S.agents.get(a.id);
    if (document.hidden && (!prev || !STATES.NEEDS_YOU.has(prev.state)) && STATES.NEEDS_YOU.has(a.state)) document.title = '• Workbench';
    const was = seenSteps.get(a.id);
    seenSteps.set(a.id, a.toolCalls || 0);
    if (was != null && (a.toolCalls || 0) > was && (a.state === 'working' || a.state === 'starting')) stepsDue.add(a.rootId && a.rootId !== a.id ? a.rootId : a.id);
  }
  upsert(list);
  lookArrived();
  render();
  // one frame for every step pulse due, however many updates arrive; none at all while the tab is hidden
  if (document.hidden) stepsDue.clear();
  else if (stepsDue.size && !stepFrame) stepFrame = requestAnimationFrame(() => { stepFrame = 0; for (const id of stepsDue) board.step(id); stepsDue.clear(); });
}
const stepsDue = new Set();
let stepFrame = 0;

function startLive() {
  if (!hasToken()) { renderSoon(); return; }
  if (debug.static) {
    // Debug: load the state once without a stream, so headless screenshots can finish.
    link.stream = 'open';
    api.state().then(onSnapshot).catch(err => { if (err.status !== 401) say(err.message); renderSoon(); });
    return;
  }
  connect({
    snapshot: onSnapshot, agents: onAgents,
    machines: list => { const byId = new Map(S.machines.map(m => [m.id, m])); for (const m of list) byId.set(m.id, m); S.machines = [...byId.values()]; render(); },
    notice: text => say(text),
    // the person's repository changed (a merge, a branch switch seen on a refresh): "Merge into <branch>" follows it
    repo: r => { S.meta.repo = r; render(); },
    state: s => { link.stream = s; if (s === 'open') link.downSince = 0; else if (!link.downSince) link.downSince = performance.now(); render(); },
    refused: () => { link.refused = true; render(); },
  });
}

// Every second: the counters in the core and the card, and the slow link states. Nothing repaints at rest.
setInterval(() => {
  if (document.hidden) return;
  const ls = linkNow();
  if (ls !== el.html.dataset.link) renderSoon();
  else if (ls === 'connecting' && !lastView?.html) renderSoon();
  const cur = el.pages.querySelector('.page:not(.old)');
  if (cur) tickSince(cur);
  if (!el.card.hidden) renderCard(true);
  gitTick();   // the git screen's times, a word at a time
  // a held core lets go by itself once the person has been still for 20 s
  if (S.loaded && lidKey && !lidKey.startsWith('link:') && keyOf(focusNow()) !== lidKey && !engaged()) renderSoon();
}, 1000);

// ---------------------------------------------------------------- Agents & keys: the panel, its light, and the key guard
/**
 * Text that looks like a key (the shared check, src/shared/secretshape.mjs) is never sent from the board's input or the
 * git screen's: it is emptied, the board says why, and Agents & keys opens to take the key where it is kept safe. The
 * text itself is not kept, said or logged. The engine checks again. True when it refused. `board` is true for the
 * board's input (the git screen empties its own before its words arrive here).
 */
function refuseKey(text, board) {
  const said = keyRefusal(text, secretShape.looksLikeSecret);
  if (!said) return false;
  if (board) { el.say.value = ''; el.bar.classList.remove('typed'); bound = null; }
  say(said);
  showConnect(null, said);
  return true;
}

/**
 * Open Agents & keys over whatever shows. The board's menus and card close, and voice stops: while it is open the
 * board takes no keys and no talking. `said` is said in the panel too (the board's own line is behind it).
 */
function showConnect(opener = null, said = '') {
  closePop(); closeTray(); closeLook(false);
  if (S.pinId || S.hoverId) { S.pinId = null; S.hoverId = null; board.hideCard(); }
  if (voice.listening) voice.cancel();
  holding = false;
  openConnect({ opener, said });
  connectNeeds(needsInfo());
}

/** Once per page load, when no coding agent can start work: Agents & keys opens by itself. */
let connectAutoOpened = false;
function autoOpenConnect() {
  const c = S.meta.connect;
  if (connectAutoOpened || !c || c.ready !== false || S.meta.mode === 'demo' || linkNow() !== 'live' || connectShown() || filesShown()) return;
  connectAutoOpened = true;
  showConnect(null);
}

/** What needs the person, for the lit button at the top of the panel ("Checkout fix needs you"), or null. */
function needsInfo() {
  const q = needsQueue();
  return q.length ? { id: q[0].id, name: q[0].name, more: q.length - 1 } : null;
}

/**
 * The top band's "Agents & keys": a light (calm when an agent is ready for new work, lit when none is) and its words,
 * ending just short of the fiducial right of the core (spend sits past it). Only with meta.connect, on a live link.
 */
function paintConnectBtn(P, live) {
  const b = el.connectBtn;
  const v = live && S.meta.mode !== 'demo' ? bandView(S.meta.connect) : null;
  b.hidden = !v;
  if (!v || !G) return;
  b.style.fontSize = P.silkSub + 'px';
  const right = G.fiducials[1][0] - 7 - 14, left = G.fiducials[0][0] + 7 + 14;
  const draw = label => {
    const html = `<span class="led ${v.light}" aria-hidden="true"></span><span class="lbl">${esc(label)}</span>`;
    if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
  };
  draw(v.label);
  if (b.offsetWidth > right - left) draw(v.short);
  b.classList.toggle('need', v.light === 'need');
  if (b.getAttribute('aria-label') !== v.aria) b.setAttribute('aria-label', v.aria);
  if (b.title !== v.said) b.title = v.said;
  b.style.left = Math.round(Math.max(left, right - b.offsetWidth)) + 'px';
  b.style.top = Math.round(G.brand.y - b.offsetHeight / 2) + 'px';
}
el.connectBtn.addEventListener('click', () => showConnect(el.connectBtn));

/**
 * The top band's Full permissions button, just left of Agents & keys (or where it would be, in the demo): quiet while
 * agents ask before risky steps, lit while full permissions are on, with aria-pressed saying which. It carries the mode it
 * was drawn for (data-state). Where the band has no room for both buttons' words, Agents & keys takes its short word
 * first, then this one. On a live link only.
 */
function paintPermBtn(P, live) {
  const b = el.permBtn;
  const v = permButtonView(S.meta.permissions);
  // Its look before it shows, and before anything below measures it: on a page that loads with full permissions on (from
  // <html> at first), it is lit from its first frame, rather than drawn quiet and faded to lit by its transition.
  b.classList.toggle('on', v.on);
  b.hidden = !live;
  if (!live || !G) return;
  b.style.fontSize = P.silkSub + 'px';
  const draw = label => {
    const html = `<span class="led${v.on ? ' on' : ''}" aria-hidden="true"></span><span class="lbl">${esc(label)}</span>`;
    if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
  };
  const c = el.connectBtn, left = G.fiducials[0][0] + 7 + 14;
  const rightOf = () => (c.hidden ? G.fiducials[1][0] - 7 - 14 : c.offsetLeft - 10);
  draw(v.label);
  if (b.offsetWidth > rightOf() - left && !c.hidden) {
    // Agents & keys takes its short word, staying where it ends
    const cv = bandView(S.meta.connect), end = c.offsetLeft + c.offsetWidth;
    if (cv) {
      const html = `<span class="led ${cv.light}" aria-hidden="true"></span><span class="lbl">${esc(cv.short)}</span>`;
      if (c.dataset.html !== html) { c.innerHTML = html; c.dataset.html = html; }
      c.style.left = Math.round(end - c.offsetWidth) + 'px';
    }
  }
  if (b.offsetWidth > rightOf() - left) draw(v.short);
  b.dataset.state = v.state;
  if (b.getAttribute('aria-pressed') !== v.pressed) b.setAttribute('aria-pressed', v.pressed);
  if (b.getAttribute('aria-label') !== v.name) b.setAttribute('aria-label', v.name);
  if (b.title !== v.title) b.title = v.title;
  b.style.left = Math.round(Math.max(left, rightOf() - b.offsetWidth)) + 'px';
  b.style.top = Math.round(G.brand.y - b.offsetHeight / 2) + 'px';
}

/**
 * Pressed when off, it asks the engine, whose card ("Let agents do anything without asking?") comes in the middle; only
 * that card's yes turns them on. Pressed when on, it turns them off at once. A button drawn for the other mode sends
 * nothing ("That changed. Have another look."). Another card already on screen is withdrawn first, as for Merge, so none
 * waits unseen; its own card stays as it is, with nothing said, and the focus goes to it. A keyboard press takes the
 * keyboard to the card.
 */
el.permBtn.addEventListener('click', async () => {
  const b = el.permBtn;
  if (b.getAttribute('aria-disabled') === 'true') return;
  touch();
  if (b.dataset.state !== S.meta.permissions) { changed(); return; }
  if (b.dataset.state !== 'full' && S.confirm?.kind === 'permissions') {
    el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
    return;
  }
  if (cannotSend(linkNow())) return;
  const drawn = b.dataset.state;
  const keyboard = document.activeElement === b;
  b.setAttribute('aria-disabled', 'true');
  try {
    if (drawn !== 'full' && S.confirm) {
      const old = S.confirm;
      const w = await api.confirm(old.id, false);
      if (S.confirm === old) S.confirm = null;
      say(w.reply || '');
    }
    const r = await api.permissions(drawn === 'full' ? 'ask' : 'full');
    if (r.confirm) {
      S.confirm = r.confirm;
      S.focusId = null;
      moved();
      renderNow();
      if (keyboard) el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
    } else {
      modeIs(r.permissions);
      say(r.reply || '');
    }
  } catch (err) { say(err.message); }
  b.removeAttribute('aria-disabled');
  render();
});

setupConnect({
  looksLikeSecret: t => secretShape.looksLikeSecret?.(t),
  // every answer the panel gets carries a fresh status: the light and the lid follow it at once
  onStatus: m => { if (m && S.meta.mode !== 'demo') { S.meta.connect = m; render(); } },
  repoName: () => (S.meta.repo && S.meta.repo.name) || null,
  canRepo: () => S.meta.mode === 'live' && !!S.meta.repo,
  home: () => el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true }),
  // "<Name> needs you" in the panel: that item in the lid, as picking its chip does (a card on screen is withdrawn)
  toLid: id => {
    if (id && S.agents.has(id)) { if (S.confirm) dropConfirm(); S.focusId = id; moved(); }
    renderNow();
    el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
  },
});

// ---------------------------------------------------------------- D1: the DRAM and the git screen (screen switching)
/** The DRAM's name for screen readers (your branch, as the snapshot tells it), and whether it can open anything now. */
function paintDram(linkS) {
  const repo = S.meta.repo;
  const yours = repo ? (repo.branch ? `your branch ${visibleText(repo.branch)}` : 'your folder (not on a branch)') : 'your branch';
  const label = `Git: ${yours} and your agents’ branches. Opens the git screen.`;
  if (el.dram.getAttribute('aria-label') !== label) el.dram.setAttribute('aria-label', label);
  el.dram.inert = linkS === 'stale' || linkS === 'no-key';
}
el.dram.addEventListener('click', () => openGit({ opener: el.dram }));

// The git screen's Merge, Throw it away and a card's answers carry the lid's data-* and go through the lid's own handler
// (builder D2's act()), which checks them against what is current before anything is sent.
// The git screen's own buttons (Merge into <branch>, Throw it away, and an engine card's answers in its detail) go through
// the lid's handler, with the same binding checks: what they were drawn for is what is sent.
const gitAct = b => actOn(b);

/**
 * Words typed or spoken on the git screen. The page's own words first ("back", "board", the looks, the detail); the rest
 * goes to POST /api/command as the core's input sends it, with what the screen showed when the person began (`b`, from
 * gitscreen.js): the card in the detail by its id, or the agent whose detail is open, or nothing. A card the reply brings
 * shows in that agent's detail only when the card itself names that agent (its agentId); any other card is shown where it
 * can be answered: in the lid, back on the board. A card that was on screen and that the words were not sent to is
 * still waiting in the engine: it is withdrawn, so none waits unseen.
 */
async function gitCommand(text, b = {}) {
  text = String(text || '').trim();
  if (!text) return;
  // as on the board: a key is never sent (the git screen's input is already empty)
  if (refuseKey(text, false)) return;
  touch();
  const words = gitScreenWords(text);
  if (words === 'back') { closeGit(); return; }
  if (words === 'open') return;
  const pc = pageCommand(text);
  if (pc && (pc.kind === 'theme' || pc.kind === 'detail')) { applyPref(pc.kind, pc[pc.kind]); return; }
  if (pc && pc.kind === 'next') { say('“Next” steps through what needs you, on the board. Say “back” to go there.', 6000); return; }
  if (cannotSend(linkNow())) { say('Workbench is not answering, so that was not sent.'); return; }
  // as submit() does: a card is answered only by the id it had when the person began
  const shown = S.confirm && b.confirmId && b.confirmId === S.confirm.id ? S.confirm : null;
  const focusId = shown ? null : (b.agentId || null);
  try {
    const res = await api.command(text, { focusId, confirmId: shown ? shown.id : (b.confirmId || null), askId: null });
    // the card shown, back again: the words were not understood (or are not enough for it), so it stays where it is
    const same = !!(res.confirm && shown && res.confirm.id === shown.id);
    if (res.confirm) {
      const old = S.confirm;
      if (!same && old && old !== shown && old.id !== res.confirm.id) api.confirm(old.id, false).catch(() => {});
      const mine = same || (!!focusId && res.confirm.agentId === focusId && (res.confirm.kind === 'merge' || res.confirm.kind === 'discard'));
      S.confirm = same ? { ...res.confirm, agentId: shown.agentId } : mine ? { ...res.confirm, agentId: focusId } : res.confirm;
      if (!mine) closeGit({ toLid: true });
    } else if (shown && S.confirm === shown) S.confirm = null;
    lookAt(res.focusId);
    // as the core's input does: a new card says itself; anything else is said
    say(res.confirm && !same ? '' : (res.reply || ''));
    if (typeof res.review === 'string' && ID_RE.test(res.review) && (!res.confirm || same)) openGit({ agentId: res.review });
    moved();
    // Agents & keys opens over the git screen too
    if (res.openConnect === true) showConnect(null, res.reply);
  } catch (err) { say(err.message); }
  render();
}

setupGitScreen({
  boardScreen: el.boardScreen, board, getG: () => G, measure, still: () => debug.still, reduced,
  say: t => say(t), act: b => gitAct(b), moved, render: () => renderNow(), command: (t, b) => gitCommand(t, b),
  listening: () => voice.listening,
  // "<Name> needs you" on the git screen: that agent in the lid, as picking its chip does (a card on screen is withdrawn)
  pick: id => { if (S.confirm) dropConfirm(); S.focusId = id; moved(); },
  // going down: the board's menus and card close (they belong to the board); either way the board renders afresh
  onShow: shown => { if (shown) { closePop(); closeTray(); closeLook(false); S.pinId = null; S.hoverId = null; board.hideCard(); } renderSoon(); },
  // a file's path in an agent's diff: that file in the agent's copy, at its first changed line, growing out of the path
  openFile: o => showFiles({ where: o.agentId, path: o.path, line: o.line, opener: o.opener, origin: o.opener ? o.opener.getBoundingClientRect() : null }),
});

// ---------------------------------------------------------------- the file view: the files chip, ⌘P and ⌘⇧F, and the git screen's paths
/**
 * Open the file view over whichever screen shows. The board's menus and card close and voice stops (onShow), as for
 * Agents & keys. `mode` 'find' (⌘P), 'search' (⌘⇧F) or 'browse' (the files chip); with `path`, that file in `where`'s copy.
 */
function showFiles(o = {}) {
  if (cannotSend(linkNow())) return;
  openFiles(o);
}
el.files.addEventListener('click', () => showFiles({ opener: el.files, mode: 'browse' }));
el.files.setAttribute('aria-keyshortcuts', isMac ? 'Meta+P' : 'Control+P');

setupFiles({
  getG: () => G, measure, still: () => debug.still, reduced, isMac,
  looksLikeSecret: t => secretShape.looksLikeSecret?.(t)?.secret === true,
  startsLikeSecret: t => secretShape.startsLikeSecret?.(t) === true,
  onShow: shown => {
    if (shown) {
      closePop(); closeTray(); closeLook(false);
      if (S.pinId || S.hoverId) { S.pinId = null; S.hoverId = null; board.hideCard(); }
      if (voice.listening) voice.cancel();
      holding = false;
      filesNeeds(needsInfo());
    }
    renderSoon();
  },
  // "<Name> needs you" at the top of the sheet: that item in the lid, as picking its chip does (a card on screen is
  // withdrawn), back on the board when the git screen shows
  toLid: id => {
    if (id && S.agents.has(id)) { if (S.confirm) dropConfirm(); S.focusId = id; moved(); }
    if (gitShown()) { closeGit({ toLid: true }); return; }
    renderNow();
    el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
  },
  // where the keyboard goes when what opened the sheet is gone: the git screen's heading, else the files chip, else the lid
  home: () => (gitShown() ? (document.querySelector('#gitDetail h2') || document.getElementById('gitTitle'))
    : (!el.files.hidden && !el.files.inert ? el.files : el.pages.querySelector('.page:not(.old) h1'))),
});

RM.addEventListener('change', () => { if (RM.matches) board.settle(); renderNow({ snap: true }); });
addEventListener('resize', () => { closePop(); closeTray(); renderNow({ snap: true }); });
document.fonts?.addEventListener?.('loadingdone', () => { widths.clear(); if (fontsReady) renderNow({ snap: true }); });

// Boot: wait for the four weights of JetBrains Mono (the board is measured in it), then draw.
const faces = ['400', '500', '600', '700'].map(w => document.fonts.load(`${w} 12px "JetBrains Mono"`).catch(() => null));
Promise.race([Promise.all(faces).then(() => document.fonts.ready), new Promise(r => setTimeout(r, 2500))]).then(() => {
  fontsReady = true;
  widths.clear();
  syncMenu();
  renderNow({ snap: true });
  startLive();
  setTimeout(() => el.html.classList.remove('boot'), 60);
});
