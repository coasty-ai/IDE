// Workbench, as a circuit board. You are the core: it shows one thing at a time and holds the one place to type or
// talk. Each agent is a chip on its own lane: beside you when it needs you, mid-board while it works, at the edge once
// it is done. This file wires the data, the board (board.js), the lid (focus.js), the card and the input together.
import { debugSwitches } from './address.js';
import { money, clip } from '/shared/format.mjs';
import { initToken, hasToken, whenRefused, api, connect } from './api.js';
import { linkState, cannotSend } from './link.js';
import { S, STATES, upsert, currentFocus, needsQueue, markReviewed, setAside, stepQueue, spendToday, machineName } from './model.js';
import { boardModel, splitEarlier, trayWords, agoText } from './boardmodel.js';
import { Lanes, denseLanes } from './lanes.js';
import { sizeClass, frame, layoutBoard, maxDenseRows, clipToLines } from './layout.js';
import { Board } from './board.js';
import { lidView, tickSince } from './focus.js';
import { cardHtml } from './card.js';
import { setupVoice } from './voice.js';
import { THEME_NAMES, DETAIL_NAMES, loadPrefs, savePref, pageCommand } from './prefs.js';
import { markOf } from './look.js';
import { esc, coalesce, patchChildren } from './util.js';
import { buttonRow } from './words.js';
import { spentAmountWords } from './numbers.js';
// D1: the git screen below the board, reached by the DRAM (gitscreen.js draws it; this file switches screens)
import { setupGitScreen, openGit, closeGit, gitShown, gitRender, gitSay, gitEscape, gitFocusId } from './gitscreen.js';
import { gitScreenWords } from './gitgraph.js';
import { visibleText } from './diffview.js';

// The address is read once, before the key is taken out of it. Switches count only with the key (see address.js).
const debug = debugSwitches(location.search);
initToken();

const $ = id => document.getElementById(id);
const el = {
  html: document.documentElement, body: document.body, core: $('core'), pages: $('pages'), probe: $('probe'), bar: $('bar'), say: $('say'), ph: $('ph'),
  heard: $('heard'), mic: $('mic'), to: $('to'), toText: $('toText'), toCancel: $('toCancel'), announce: $('announce'), said: $('said'),
  parts: $('parts'), machines: $('machines'), tray: $('tray'), card: $('card'), pop: $('pop'), trayList: $('trayList'), look: $('look'),
  brand: $('brand'), mode: $('mode'), repo: $('repo'), conn: $('conn'), spend: $('spend'), wires: $('wires'), board: $('board'),
  dram: $('dram'), boardScreen: $('boardScreen'), gitScreen: $('gitScreen'), gitSay: $('gitSay'),
};
if (debug.still) el.body.classList.add('still');

const RM = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => RM.matches;
const prefs = loadPrefs(safeStorage('localStorage'));
el.html.dataset.theme = prefs.theme;
el.html.dataset.detail = prefs.detail;

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
const board = new Board({
  boardSvg: el.board, wires: el.wires, parts: el.parts, core: el.core, dram: el.dram, machines: el.machines, tray: el.tray, said: el.said, cardEl: el.card,
  still: () => debug.still, reduced,
  hooks: {
    enter: (id, parentId) => { clearTimeout(leaveTimer); if (S.hoverId !== id) { S.hoverId = id; renderCard(); } },
    leave: (id, viaFocus) => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { if (S.hoverId === id) { S.hoverId = null; renderCard(); } }, viaFocus ? 0 : 140); },
    pick: id => pickAgent(id),
    more: rootId => { S.pinId = rootId; S.hoverId = rootId; renderCard(); },
    machine: (id, anchor) => toggleMachines(anchor),
    tray: anchor => toggleTray(anchor),
  },
});
let leaveTimer = null;

// ---------------------------------------------------------------- notices and the hint under the core
let notice = null, noticeTimer = null;
const hintDone = () => { try { return localStorage.getItem('wb-answered') === '1'; } catch { return false; } };
function say(text, ms = 9000) {
  notice = text ? String(text) : null;
  clearTimeout(noticeTimer);
  if (notice && ms) noticeTimer = setTimeout(() => { notice = null; paintSaid(); }, ms);
  paintSaid();
}
function answeredOnce() { try { localStorage.setItem('wb-answered', '1'); } catch { /* fine */ } }
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
  if (performance.now() - lastInputAt > 20000 && !voice.listening && !el.say.value) return false;
  const ae = document.activeElement;
  return pointer.inCore || (ae && ae !== document.body && el.core.contains(ae) && ae !== el.say) || !!el.say.value || voice.listening || !!S.reply;
}

const keyOf = f => (f.confirm ? 'confirm:' + f.confirm.id : f.empty ? 'empty' : `${f.agent.id}|${f.agent.state}|${f.agent.ask ? f.agent.ask.id : ''}`);

// The hold resists only what arrives on the stream. The person's own moves (a lid button, → and ←, a typed "next", picking
// a chip or a row, the reply to their own command) show what they asked for at once: the next render lets go once.
let letGo = false;
const moved = () => { letGo = true; };

/** What the core shows now: what needs the person, unless they are busy with what is already showing. */
function shownFocus() {
  const want = currentFocus();
  const own = letGo;
  letGo = false;
  if (!lidFocus || own || !engaged() || keyOf(want) === lidKey) return { f: want, also: false };
  const held = lidFocus;
  // something else waits behind what is held: an agent that needs the person, or a launch question
  const also = x => !!(want.confirm || (want.agent && want.agent.id !== x && STATES.NEEDS_YOU.has(want.agent.state)));
  if (held.confirm) return S.confirm && S.confirm.id === held.confirm.id ? { f: { confirm: S.confirm }, also: also(null) } : { f: want, also: false };
  if (held.empty) return { f: want, also: false };
  const a = S.agents.get(held.agent.id);
  if (!a || a.state !== held.agent.state || (a.ask?.id || '') !== (held.agent.ask?.id || '')) return { f: want, also: false };
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
  const bm = boardModel(agents, { ...STATES, later: S.later, currentId: f.agent ? f.agent.id : null, machineName });
  // agents from an earlier run wait in the done tray: they never take a lane
  const { current, earlier } = splitEarlier(bm.roots);
  if (current.length) lanes.assign(current.map(r => ({ id: r.id, startedAt: r.startedAt, laptop: (S.machines.find(m => m.id === r.machineId)?.kind || (r.machineId === 'laptop' ? 'laptop' : 'cloud')) === 'laptop' })));
  // past twelve agents, finished work moves to the done tray and each lane splits in two
  const dense = current.length > 12;
  let roots = current, laneOf = id => lanes.get(id), nRows = 6, tray = null, overflow = [];
  let done = [];
  if (dense) {
    done = roots.filter(r => r.ghost);
    // newcomers take the free rows in this order: whatever needs the person first, so an asker always has a chip
    const active = roots.filter(r => !r.ghost).sort((a, b) => (b.stop === 'inner') - (a.stop === 'inner'));
    const d = denseLanes(active, id => lanes.get(id), maxDenseRows(H, P));
    overflow = d.overflow;
    roots = active.filter(r => !overflow.includes(r.id));
    laneOf = id => d.at.get(id) || null;
    nRows = d.rows;
  }
  if (done.length || earlier.length || overflow.length) {
    const marks = done.concat(earlier).map(r => markOf(r.state, STATES.LOOK));
    const words = trayWords({ done: done.length, earlier: earlier.length, over: overflow.length });
    tray = { count: done.length + earlier.length, done: done.length, earlier: earlier.length, over: overflow.length, ids: done.map(r => r.id).concat(earlier.map(r => r.id), overflow), marks, ...words };
  }
  trayIds = tray ? { done: tray.ids.slice(0, tray.done), earlier: tray.ids.slice(tray.done, tray.count), over: overflow.slice() } : { done: [], earlier: [], over: [] };
  const fr = frame(W, H, P, { nRows, dense });
  const maxPage = fr.lidMaxH - P.lid.padT - P.lid.padB - P.lid.inh - P.lid.gap3;
  const v = buildLid(f, also, P, maxPage);
  const machines = showData ? S.machines.map(m => ({ id: m.id, name: m.name, awake: m.awake !== false, note: machineNote(m), noteText: machineNote(m) })) : [];
  G = layoutBoard({ W, H, P, detail: prefs.detail, roots, laneOf, nRows, dense, lidNeed: needForLayout(v), machines, tray, measure });
  G.queueLength = bm.queue.length;
  const hoverRoot = board.card.rootId || null;
  board.render(G, { machines, tray, hoverRoot, litMachine: hoverMachine(), first: lastFirst || o.snap });
  lastFirst = false;
  paintLid(v, f);
  paintTop(P, linkS);
  paintSaid();
  paintPlaceholder(P);
  for (const x of [el.parts, el.wires, el.machines, el.dram]) x.classList.toggle('dim', linkS === 'stale');
  el.parts.inert = linkS === 'stale' || linkS === 'no-key';
  el.machines.inert = linkS === 'stale' || linkS === 'no-key';
  paintDram(linkS);
  renderCard(true);
  if (!el.pop.hidden) renderMachinesPop();
  if (!el.trayList.hidden) renderTrayList();
  if (S.loaded && firstSnap) { firstSnap = false; applyDebug(); }
  gitRender();
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
const GUARDED = new Set(['answer', 'looksgood', 'fix', 'stop', 'reviewed', 'later', 'confirm', 'reply', 'parent', 'pick', 'forget']);
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
// lid's sentence first, so the person keeps their place.
const gaveFocus = new WeakSet();
function busy(b) {
  if (document.activeElement === b) { gaveFocus.add(b); b.closest('.page')?.querySelector('h1')?.focus({ preventScroll: true }); }
  b.disabled = true;
}
/** A failed answer: its button can be tried again, and gets the keyboard back if it had it. */
function retry(b) {
  b.disabled = false;
  if (gaveFocus.has(b)) { gaveFocus.delete(b); if (b.isConnected) b.focus({ preventScroll: true }); }
}

el.pages.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled || b.closest('.page.old, .page[data-hidden]')) return;
  const act = b.dataset.act;
  // clicks are ignored while the core swaps and for a moment after, so they cannot land on something new
  if (GUARDED.has(act) && performance.now() < armedUntil) return;
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
  if (act === 'confirm') {
    const id = b.dataset.confirm;
    if (!S.confirm || S.confirm.id !== id) { changed(); return; }
    busy(b);
    try {
      const r = await api.confirm(id, b.dataset.go === '1');
      if (S.confirm && S.confirm.id === id) S.confirm = null;
      say(r.reply || '');
      lookAt(r.focusId);
      moved();
    } catch (err) { retry(b); say(err.message); }
    render();
    return;
  }
  const a = S.agents.get(b.dataset.agent);
  if (!a) { changed(); return; }
  if (b.dataset.ask && (!a.ask || a.ask.id !== b.dataset.ask)) { changed(); return; }
  if (b.dataset.state && a.state !== b.dataset.state) { changed(); return; }
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
    } else if (act === 'forget') {
      // an agent from an earlier run: the engine asks first, with a card like a launch's
      busy(b);
      const r = await api.command('forget it', { focusId: a.id });
      if (r.confirm) S.confirm = r.confirm; else say(r.reply || '');
    } else if (act === 'looksgood') {
      // finished work has no ask, so this answer goes without an askId; the engine leaves the agent as it is
      busy(b);
      const r = await api.answer(a.id, null, 'Looks good');
      markReviewed(a);
      answeredOnce();
      say(r.reply || '', 4000);
      if (S.focusId === a.id) S.focusId = null;
      if (S.pinId === a.id) S.pinId = null;
    } else if (act === 'reviewed') {
      markReviewed(a);
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
});

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
  el.toText.textContent = `${verb} ${clip(a.name, Math.max(6, chars - verb.length - 2))}:`;
  el.to.title = `${mode === 'answer' ? 'Your answer goes to' : 'This goes to'} ${a.name}`;
  el.bar.classList.add('replying');
  el.say.setAttribute('aria-label', mode === 'answer' ? `Your answer to ${a.name}` : `What to tell ${a.name}`);
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
  const v = savePref(safeStorage('localStorage'), kind, value);
  const change = () => { prefs[kind] = v; el.html.dataset[kind] = v; syncMenu(); renderNow({ snap: true }); };
  if (prefs[kind] === v) { syncMenu(); return; }
  if (document.startViewTransition && !reduced() && !debug.still && !document.hidden) {
    // a cross-fade; a second change during it skips the first fade (the change itself still happens)
    const vt = document.startViewTransition(change);
    for (const p of [vt.ready, vt.finished, vt.updateCallbackDone]) p?.catch(() => {});
  } else change();
  if (!quietly) say(kind === 'theme' ? `Look: ${THEME_NAMES[v]}.` : `Detail: ${DETAIL_NAMES[v]}.`, 4000);
}

async function submit(text) {
  text = String(text || '').trim();
  if (!text) return;
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
    } else {
      const shown = S.confirm && b.confirmId === S.confirm.id ? S.confirm : null;
      const res = await api.command(text, { focusId: shown ? null : (b.agentId || null), confirmId: shown ? shown.id : (b.confirmId || null), askId: shown ? null : (b.askId || null) });
      if (res.confirm) S.confirm = res.confirm;
      else if (shown && S.confirm === shown) S.confirm = null;
      lookAt(res.focusId);
      // the reply to the person's own words: a new launch question, or the agent it names, shows at once
      if (res.confirm || res.focusId || shown) moved();
      if (b.askId && !res.confirm) answeredOnce();
      // a new launch question in the core already says it; anything else is said under the core
      say(res.confirm && (!shown || res.confirm.id !== shown.id) ? '' : (res.reply || ''));
    }
  } catch (err) { say(err.message); }
  render();
}
el.bar.addEventListener('submit', e => { e.preventDefault(); submit(el.say.value); });

const voice = setupVoice({
  mic: el.mic, heard: el.heard, onFinal: t => (gitShown() ? gitCommand(t, gitFocusId()) : submit(t)), onNotice: t => say(t),
  onListening: on => { el.bar.classList.toggle('listening', on); if (on) { touch(); if (!bound) bound = bindingNow(); } else render(); },
});

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
  if (S.pinId && !e.target.closest('#parts, #card, #core, .pop, .mach, #tray, #brand')) { S.pinId = null; render(); }
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

// ---------------------------------------------------------------- the done tray (past twelve agents)
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
let trayIds = { done: [], earlier: [], over: [] };
function renderTrayList() {
  const row = id => {
    const a = S.agents.get(id);
    if (!a) return '';
    const m = markOf(a.state, STATES.LOOK);
    const note = a.earlier ? agoText(Date.now() - (a.endedAt || a.stateSince)) : m.label;
    return `<button type="button" class="row${a.earlier ? ' earlier' : ''}" data-agent="${esc(a.id)}" data-key="t:${esc(a.id)}"><svg class="g c-${m.tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${m.shape}"/></svg><span>${esc(a.name)} <em>· ${esc(note)}</em></span></button>`;
  };
  const done = trayIds.done.map(row).join(''), over = trayIds.over.map(row).join(''), early = (trayIds.earlier || []).map(row).join('');
  patchChildren(el.trayList, `${done || !early ? `<h2>Done or stopped</h2>${done || '<p class="note">Nothing yet.</p>'}` : ''}${early ? `<h2>From earlier runs</h2>${early}` : ''}${over ? `<h2>Working, with no room on the board</h2>${over}` : ''}`);
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
  if (kb) el.pages.querySelector('.page:not(.old) h1')?.focus({ preventScroll: true });
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

function onSnapshot(snap) {
  S.meta = { mode: snap.mode, repo: snap.repo, harnesses: snap.harnesses || {}, defaultBudgetUsd: snap.defaultBudgetUsd, spendTodayUsd: snap.spendTodayUsd };
  const fresh = new Map((snap.agents || []).map(a => [a.id, a]));
  for (const id of [...S.agents.keys()]) if (!fresh.has(id)) S.agents.delete(id);
  upsert(snap.agents || []);
  lookArrived();
  // a full list: lanes of agents that no longer exist are forgotten (only here, never on a partial update)
  lanes.prune(new Set([...fresh.values()].filter(a => !a.parentId).map(a => a.id)));
  S.machines = snap.machines || [];
  const wasLoaded = S.loaded;
  S.loaded = true;
  for (const a of S.agents.values()) seenSteps.set(a.id, a.toolCalls || 0);
  if (!wasLoaded && snap.mode === 'live' && snap.repo && snap.repo.dirty) say(`Agents start from your last commit. ${snap.repo.dirty} uncommitted change${snap.repo.dirty === 1 ? ' is' : 's are'} not in their copies.`, 15000);
  render();
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
  // a held core lets go by itself once the person has been still for 20 s
  if (S.loaded && lidKey && !lidKey.startsWith('link:') && keyOf(currentFocus()) !== lidKey && !engaged()) renderSoon();
}, 1000);

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
const gitAct = b => (typeof act === 'function' ? act(b) : say('That cannot be done from here yet.'));

/**
 * Words typed or spoken on the git screen. The page's own words first ("back", "board", the looks, the detail); the rest
 * goes to POST /api/command as the core's input sends it, with focusId the agent whose detail is open. A card the reply
 * brings shows in that agent's detail when it names that agent; any other card is shown where it can be answered: in
 * the lid, back on the board.
 */
async function gitCommand(text, focusId) {
  text = String(text || '').trim();
  if (!text) return;
  touch();
  const words = gitScreenWords(text);
  if (words === 'back') { closeGit(); return; }
  if (words === 'open') return;
  const pc = pageCommand(text);
  if (pc && (pc.kind === 'theme' || pc.kind === 'detail')) { applyPref(pc.kind, pc[pc.kind]); return; }
  if (pc && pc.kind === 'next') { say('“Next” steps through what needs you, on the board. Say “back” to go there.', 6000); return; }
  if (cannotSend(linkNow())) { say('Workbench is not answering, so that was not sent.'); return; }
  const focused = focusId ? S.agents.get(focusId) : null;
  const shown = S.confirm && focusId && S.confirm.agentId === focusId ? S.confirm : null;
  try {
    const res = await api.command(text, { focusId: shown ? null : focusId || null, confirmId: shown ? shown.id : null, askId: null });
    // the card shown, back again: the words were not understood (or are not enough for it), so it stays where it is
    const same = !!(res.confirm && shown && res.confirm.id === shown.id);
    if (res.confirm) {
      const about = same || (focused && (res.confirm.kind === 'merge' || res.confirm.kind === 'discard') && String(res.confirm.sentence || '').includes(focused.name));
      S.confirm = about ? { ...res.confirm, agentId: focusId } : res.confirm;
      if (!about) closeGit({ toLid: true });
    } else if (shown && S.confirm === shown) S.confirm = null;
    lookAt(res.focusId);
    // as the core's input does: a new card says itself; anything else is said
    say(res.confirm && !same ? '' : (res.reply || ''));
    if (typeof res.review === 'string' && ID_RE.test(res.review) && !res.confirm) openGit({ agentId: res.review });
    moved();
  } catch (err) { say(err.message); }
  render();
}

setupGitScreen({
  boardScreen: el.boardScreen, board, getG: () => G, measure, still: () => debug.still, reduced,
  say: t => say(t), act: b => gitAct(b), moved, render: () => renderNow(), command: (t, id) => gitCommand(t, id),
  // going down: the board's menus and card close (they belong to the board); either way the board renders afresh
  onShow: shown => { if (shown) { closePop(); closeTray(); closeLook(false); S.pinId = null; S.hoverId = null; board.hideCard(); } renderSoon(); },
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
