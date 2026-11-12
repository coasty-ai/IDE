// The git screen, below the board: your branch as a thick gold trunk, each agent's branch a copper trace beside it,
// newest commits at the top, where the wire from the board's DRAM arrives at HEAD. Selecting an agent's branch shows its
// diff and what can be done with its work; any other commit shows what it is. The page reaches it by the DRAM, by the
// words "git", "show git", "open git", "source control" or "show the graph", and by a reply that carries `review`
// (builder D2's lid calls openGit({ agentId, opener }) for "Review the changes" and "See it in git").
//
// app.js sets it up once (setupGitScreen) and hands it what it shares with the board: the layout (for the wire's place),
// the text measurer, say(), the lid's button handler for Merge, Throw it away and a card's answers, and a render.
// Nothing here repaints at rest: every paint is keyed on what it shows.
import { graphLayout, GRAPH_SIZES, rowWords, workActions, mergeLabel, shortId, cutMiddle } from './gitgraph.js';
import { diffHtml, visibleText } from './diffview.js';
import { esc, patchChildren, setText } from './util.js';
import { pathD, sizeClass, clipTo } from './layout.js';
import { markOfAgent } from './look.js';
import * as model from './model.js';
import { api } from './api.js';
import { agoText } from './boardmodel.js';

const { S, STATES } = model;
const $ = id => document.getElementById(id);
const r1 = n => Math.round(n * 10) / 10;
const MOVE = { pulse: 320, slide: 620, overlap: 200, wire: 220 };   // the way down: ~900 ms in all
const EASE = 'cubic-bezier(.65,0,.35,1)';

let ctx = null, el = null;
const st = {
  shown: false,       // the git screen is shown, or on its way
  moving: null,       // 'down' | 'up' while the two screens slide
  runs: [],           // the move's animations
  data: null,         // the last answer of GET /api/git, cleaned
  error: null,        // a plain sentence when it could not be read
  loading: false,
  seq: 0,             // the newest read; an older answer is dropped
  g: null,            // the graph as laid out
  geo: null,          // the screen's geometry: the band, the graph's box, the wire
  sel: null,          // the selected row: a commit id, or 'work:<agentId>'
  detail: null,       // { kind: 'agent', agentId } | { kind: 'commit', id }
  changes: { agentId: null, seq: 0, data: null, error: null, loading: false, key: '' },
  opener: null,       // what gets the keyboard back on the way up
  openedOn: null,     // the agent the screen was opened on: Esc on its detail goes straight back
  readSig: '',        // the repository and the agents' work as the last read saw them
  keys: { band: '', board: '', graph: '', detail: '' },
  armedUntil: 0,      // the detail's buttons wait a moment after they change under the pointer
};

/** Is the git screen shown (or on its way)? The lid keeps holding while it is. */
export const gitShown = () => st.shown;

/** @param {object} c  { boardScreen, board, getG, measure, still, reduced, say, act, moved, render, command, onShow } */
export function setupGitScreen(c) {
  ctx = c;
  el = {
    html: document.documentElement, screen: $('gitScreen'), boardScreen: c.boardScreen, svg: $('gitBoard'), top: $('gitTop'),
    left: $('gitTop').querySelector('.gleft'), right: $('gitTop').querySelector('.gright'), back: $('gitBack'), mode: $('gitMode'),
    title: $('gitTitle'), state: $('gitState'), needs: $('gitNeeds'), bar: $('gitBar'), say: $('gitSay'), ph: $('gitPh'), said: $('gitSaid'),
    graph: $('gitGraph'), detail: $('gitDetail'), wireEnd: $('gitWireEnd'),
  };
  el.back.addEventListener('click', () => closeGit());
  el.wireEnd.addEventListener('click', () => closeGit());
  el.needs.addEventListener('click', () => {
    const id = el.needs.dataset.agent;
    if (!id || !S.agents.has(id)) { paintBand(); return; }
    S.focusId = id;
    closeGit({ toLid: true });
    ctx.moved(); ctx.render();
  });
  el.bar.addEventListener('submit', e => { e.preventDefault(); const t = el.say.value; el.say.value = ''; el.bar.classList.remove('typed'); ctx.command(t, detailAgentId()); });
  el.say.addEventListener('input', () => el.bar.classList.toggle('typed', !!el.say.value));
  el.graph.addEventListener('click', e => {
    const badge = e.target.closest('[data-badge-agent]');
    const row = e.target.closest('.gr');
    if (!row) return;
    if (badge) { select(row.dataset.id, { focus: true }); openDetail({ kind: 'agent', agentId: badge.dataset.badgeAgent }); return; }
    select(row.dataset.id, { focus: true });
    openRow(row.dataset.id);
  });
  el.graph.addEventListener('keydown', onGraphKey);
  el.detail.addEventListener('click', onDetailClick);
  el.detail.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); gitEscape(); } });
}

// ---------------------------------------------------------------- going down and coming back

/**
 * Open the git screen: the view travels down the wire from the DRAM (or swaps at once with reduced motion or still=1).
 * With `agentId`, that agent's branch is selected and its detail (diff and actions) opens. `opener` gets the keyboard
 * back when the person comes back; without one, the DRAM does.
 */
export function openGit({ agentId = null, opener = null } = {}) {
  if (!ctx) return;
  st.opener = opener && opener.isConnected ? opener : null;
  st.openedOn = agentId && typeof agentId === 'string' ? agentId : null;
  if (st.openedOn) { st.sel = 'work:' + st.openedOn; st.detail = { kind: 'agent', agentId: st.openedOn }; st.armedUntil = performance.now() + 600; }
  else if (!st.shown) st.detail = null;   // by the DRAM or the words: the graph, at the row last selected
  if (st.shown && st.moving !== 'up') { paint(); if (st.detail) loadChanges(true); focusAfterOpen(); return; }
  st.shown = true;
  ctx.onShow(true);
  read();
  if (st.detail) loadChanges(true);
  paint();
  move('down');
}

/** Back to the board: up the wire, focus back on what opened the git screen (or the DRAM, or the lid's sentence). */
export function closeGit({ toLid = false } = {}) {
  if (!ctx || !st.shown) return;
  st.shown = false;
  st.toLid = toLid;
  ctx.onShow(false);
  move('up');
}

function move(dir) {
  for (const a of st.runs) a.cancel();
  st.runs = [];
  st.moving = dir;
  const down = dir === 'down';
  const git = el.screen, board = el.boardScreen;
  el.html.dataset.screen = down ? 'to-git' : 'to-board';
  git.inert = true; board.inert = true;
  const calm = ctx.still() || ctx.reduced() || document.hidden;
  if (calm) { settle(dir); return; }
  const H = innerHeight;
  const slide = (e, from, to, delay) => e.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], { duration: MOVE.slide, delay, easing: EASE, fill: 'both' });
  const steps = [];
  if (down) {
    steps.push(ctx.board.dramPulse(true, MOVE.pulse));
    const a = slide(board, 0, -H, MOVE.pulse - MOVE.overlap), b = slide(git, H, 0, MOVE.pulse - MOVE.overlap);
    st.runs.push(a, b);
    steps.push(a.finished, b.finished.then(() => wirePulse(true)));
  } else {
    const p = wirePulse(false);
    const a = slide(board, -H, 0, MOVE.wire - 60), b = slide(git, 0, H, MOVE.wire - 60);
    st.runs.push(a, b);
    steps.push(p, a.finished, b.finished.then(() => ctx.board.dramPulse(false, MOVE.pulse)));
  }
  Promise.all(steps.map(x => Promise.resolve(x).catch(() => null))).then(() => { if (st.moving === dir) settle(dir); });
}

function settle(dir) {
  const down = dir === 'down';
  for (const a of st.runs) a.cancel();
  st.runs = [];
  st.moving = null;
  el.html.dataset.screen = down ? 'git' : 'board';
  const shown = down ? el.screen : el.boardScreen, hidden = down ? el.boardScreen : el.screen;
  shown.inert = false; shown.removeAttribute('aria-hidden');
  hidden.inert = true; hidden.setAttribute('aria-hidden', 'true');
  if (down) { paint(); focusAfterOpen(); return; }
  // on the way up: the person's place on the board
  const lidH1 = () => document.querySelector('#pages .page:not(.old) h1');
  const to = st.toLid ? lidH1() : st.opener && st.opener.isConnected && !st.opener.closest('[inert]') ? st.opener : document.getElementById('dram');
  (to || lidH1())?.focus({ preventScroll: true });
  st.opener = null; st.openedOn = null; st.toLid = false;
  ctx.render();
}

/** On the way down, focus goes to the git screen's heading (or the detail it was opened on). */
function focusAfterOpen() {
  if (st.moving) return;
  const h = st.detail && st.openedOn ? el.detail.querySelector('h2') : el.title;
  (h || el.title).focus({ preventScroll: true });
}

/** A pulse along the git screen's wire: down from the top edge to HEAD, or back up. */
function wirePulse(down) {
  const w = st.geo && st.geo.wire;
  if (!w || ctx.still() || ctx.reduced() || document.hidden) return Promise.resolve();
  const pts = down ? w : w.slice().reverse();
  const L = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const ns = 'http://www.w3.org/2000/svg';
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', pathD(pts)); p.setAttribute('class', 'pulse dram-pulse'); p.setAttribute('stroke-width', '3');
  el.svg.appendChild(p);
  const dash = Math.min(40, Math.max(14, L * 0.25));
  return p.animate([{ strokeDasharray: `${dash} ${L + 80}`, strokeDashoffset: dash, opacity: 0 }, { opacity: 1, offset: 0.15 },
    { strokeDasharray: `${dash} ${L + 80}`, strokeDashoffset: -L, opacity: 0.85 }], { duration: MOVE.wire, easing: 'ease-out' })
    .finished.then(() => p.remove(), () => p.remove());
}

// ---------------------------------------------------------------- the data

/** Read the history (GET /api/git): on opening, and when the repository or an agent's work changed while shown. */
function read() {
  const seq = ++st.seq;
  st.loading = true;
  st.readSig = readSig();
  const ask = typeof api.git === 'function' ? api.git() : Promise.reject(new Error('This page cannot read the history yet. Reload it once Workbench is up to date.'));
  ask.then(r => {
    if (seq !== st.seq) return;
    st.data = clean(r); st.error = null; st.loading = false;
    if (st.sel && !st.data.commits.some(c => c.id === st.sel) && !st.sel.startsWith('work:')) st.sel = null;
    paint();
    if (st.detail && st.detail.kind === 'agent') loadChanges(false);
  }, err => {
    if (seq !== st.seq) return;
    st.loading = false;
    st.error = (err && err.message) || 'Workbench could not read the history.';
    paint();
  });
}

const isId = x => typeof x === 'string' && /^[0-9a-f]{7,64}$/i.test(x);
/** The answer, kept to what the screen uses, with every field checked: what does not fit is dropped, never guessed. */
function clean(r) {
  const repo = r && r.repo && typeof r.repo === 'object' ? r.repo : {};
  const commits = (Array.isArray(r && r.commits) ? r.commits : []).filter(c => c && isId(c.id)).map(c => ({
    id: c.id, parents: Array.isArray(c.parents) ? c.parents.filter(isId) : [], subject: typeof c.subject === 'string' ? c.subject : '',
    author: typeof c.author === 'string' ? c.author : '', at: Number.isFinite(c.at) ? c.at : null, refs: Array.isArray(c.refs) ? c.refs.filter(x => typeof x === 'string') : [],
    agentId: typeof c.agentId === 'string' ? c.agentId : null, kind: ['commit', 'merge', 'work'].includes(c.kind) ? c.kind : 'commit',
  }));
  const agents = (Array.isArray(r && r.agents) ? r.agents : []).filter(a => a && typeof a.id === 'string').map(a => ({
    id: a.id, name: typeof a.name === 'string' ? a.name : 'Agent', state: typeof a.state === 'string' ? a.state : 'stopped', earlier: !!a.earlier, harness: a.harness || null,
    branch: typeof a.branch === 'string' ? a.branch : null, from: typeof a.from === 'string' ? a.from : null, base: isId(a.base) ? a.base : null, since: isId(a.since) ? a.since : null,
    files: a.files && typeof a.files === 'object' ? a.files : null,
    work: a.work && typeof a.work === 'object' ? a.work : (typeof a.branch === 'string' ? { branch: a.branch, from: a.from || null, folder: true, merged: null, problem: null, thrownAway: null } : null),
  }));
  const head = commits.length ? (commits.find(c => c.id.startsWith(String(repo.head || '')) && repo.head) || commits[0]).id : null;
  return {
    repo: { name: typeof repo.name === 'string' ? repo.name : '', branch: typeof repo.branch === 'string' && repo.branch ? repo.branch : null, head, dirty: Number(repo.dirty) || 0, identity: repo.identity !== false },
    commits, agents, more: !!(r && r.more),
  };
}

/** An agent as the screen shows it: what the stream knows now (state, files, work), with its branch from the history. */
function agentOf(id) {
  const fromGit = st.data && st.data.agents.find(a => a.id === id);
  const live = S.agents.get(id);
  if (!fromGit && !live) return null;
  const a = { ...(fromGit || {}), ...(live || {}) };
  a.work = (live && live.work) || (fromGit && fromGit.work) || null;
  a.branch = (a.work && a.work.branch) || (fromGit && fromGit.branch) || null;
  for (const k of ['from', 'base', 'since']) a[k] = fromGit ? fromGit[k] : null;
  return a;
}

/** What the last read was made from: a different one while shown means read again (a merge, a branch switch, new work). */
function readSig() {
  const r = S.meta && S.meta.repo;
  const roots = [...S.agents.values()].filter(a => !a.parentId).map(a => `${a.id}:${a.state}:${workSig(a)}`).sort().join(',');
  return `${r ? [r.branch, r.head, r.dirty, r.identity].join('/') : ''}|${roots}`;
}
const workSig = a => (typeof model.workKey === 'function' ? model.workKey(a) : (a.work ? [a.work.branch, a.work.folder, a.work.merged && a.work.merged.merge, a.work.problem && a.work.problem.at, a.work.thrownAway && a.work.thrownAway.at].join('/') : ''));

/** The changes of the agent whose detail is open (GET /api/agents/:id/changes). */
function loadChanges(force) {
  const d = st.detail;
  if (!d || d.kind !== 'agent') return;
  const a = agentOf(d.agentId);
  // read again when the agent, its work or your branch's tip changes (a merge moves it)
  const key = `${d.agentId}|${a ? a.state + '|' + workSig(a) : ''}|${(S.meta && S.meta.repo && S.meta.repo.head) || ''}`;
  const ch = st.changes;
  if (!force && ch.agentId === d.agentId && ch.key === key && (ch.data || ch.loading)) return;
  const seq = ++ch.seq;
  Object.assign(ch, { agentId: d.agentId, key, loading: true, error: null, data: ch.agentId === d.agentId ? ch.data : null });
  paintDetail();
  const ask = typeof api.changes === 'function' ? api.changes(d.agentId) : Promise.reject(new Error('This page cannot read changes yet. Reload it once Workbench is up to date.'));
  ask.then(r => {
    if (seq !== ch.seq) return;
    Object.assign(ch, { loading: false, data: r && typeof r === 'object' ? r : null, error: null });
    paintDetail();
  }, err => {
    if (seq !== ch.seq) return;
    Object.assign(ch, { loading: false, data: null, error: (err && err.message) || 'Workbench could not read its changes.' });
    paintDetail();
  });
}

// ---------------------------------------------------------------- painting

/** Called by app.js on every render: the band (what needs you), and a new read when what the screen shows changed. */
export function gitRender() {
  if (!ctx || !st.shown) return;
  if (!st.loading && st.readSig !== readSig()) read();
  paint();
}

/**
 * What Workbench just said, also on the git screen (the board's line under the DRAM is out of sight there): two lines
 * at most, cut at a word, with all of it for screen readers.
 */
export function gitSay(text) {
  if (!el) return;
  const full = text ? String(text) : '';
  const shown = full.length > (st.saidChars || 80) ? clipTo(full, st.saidChars || 80) : full;
  const html = shown === full ? esc(full) : `<span aria-hidden="true">${esc(shown)}</span><span class="sr">${esc(full)}</span>`;
  if (el.said.dataset.html !== html) { el.said.innerHTML = html; el.said.dataset.html = html; }
}

function sizes() {
  const W = innerWidth, H = innerHeight, P = sizeClass(W, H);
  const G = ctx.getG();
  const bd = { x: P.margin, y: P.margin, w: W - 2 * P.margin, h: H - 2 * P.margin };
  bd.r = bd.x + bd.w; bd.b = bd.y + bd.h;
  // the wire comes in where it left the board: under the DRAM's wire, at the same x
  const wx = G && G.dram ? G.dram.wire.x : Math.round(W / 2) + 60;
  return { W, H, P, bd, wx, GP: GRAPH_SIZES[P.name] };
}

function paint() {
  if (!ctx || !el) return;
  const z = sizes();
  el.screen.style.setProperty('--g-l1', (z.P.name === 'L' ? 13.5 : z.P.name === 'M' ? 13 : 12.5) + 'px');
  el.screen.style.setProperty('--g-l2', (z.P.name === 'L' ? 12 : 11.5) + 'px');
  paintBand(z);
  paintGraph(z);
  paintBoard(z);
  paintDetail(z);
}

/** The top band: back, the repository and branch, your folder's state, what needs you, the place to type. */
function paintBand(z = sizes()) {
  const { P, bd, wx } = z;
  const d = st.data, repo = d ? d.repo : (S.meta && S.meta.repo) || null;
  const m = (t, px, w = 600) => ctx.measure(t, px, w);
  // either side of the wire, and clear of the mounting holes in the top corners (as the board's own top band is)
  const gap = 18;
  const leftX = bd.x + 48, leftW = Math.max(160, wx - gap - leftX);
  const rightX = wx + gap, rightW = Math.max(180, bd.r - 48 - rightX);
  st.saidChars = Math.max(20, 2 * Math.floor(rightW / m('M', P.silkSub, 400)) - 2);
  Object.assign(el.left.style, { left: leftX + 'px', top: bd.y + 8 + 'px', width: leftW + 'px' });
  Object.assign(el.right.style, { left: rightX + 'px', top: bd.y + 8 + 'px', width: rightW + 'px' });
  el.mode.hidden = !(S.meta && S.meta.mode === 'demo');
  // "<repo> · <branch> · abc1234", cut to fit the room left of the wire
  const name = visibleText(repo && repo.name || 'Your repository');
  const branch = repo ? (repo.branch ? visibleText(repo.branch) : 'not on a branch') : '';
  const head = d && d.repo.head ? shortId(d.repo.head) : repo && repo.head ? shortId(repo.head) : '';
  const titlePx = P.title + 1;
  const backW = m('↑ Back to the board', P.silkSub, 600) + 26 + (el.mode.hidden ? 0 : 58);
  const room = Math.max(10, Math.floor((leftW - backW - 24 - 22) / m('M', titlePx, 700)));
  let parts = [name, branch, head].filter(Boolean);
  const full = parts.join(' · ');
  if (full.length > room) {
    const fixed = (head ? head.length + 3 : 0) + 3;
    const each = Math.max(6, Math.floor((room - fixed) / 2));
    parts = [cutMiddle(name, each), cutMiddle(branch, Math.max(6, room - fixed - Math.min(each, name.length))), head].filter(Boolean);
  }
  const shownTitle = parts.join(' · ');
  const titleKey = `${shownTitle}|${full}`;
  if (el.title.dataset.key !== titleKey) {
    el.title.dataset.key = titleKey;
    el.title.innerHTML = `<span class="sr">Git: </span><span aria-hidden="${shownTitle !== full}">${esc(shownTitle)}</span>${shownTitle !== full ? `<span class="sr">${esc(full)}</span>` : ''}`;
    el.title.title = full;
  }
  el.title.style.fontSize = titlePx + 'px';
  // your folder: uncommitted changes, not on a branch, and git without a name and email
  const bits = [];
  if (repo && !repo.branch && (d || S.meta.repo)) bits.push('Your folder is not on a branch');
  else if (repo && repo.dirty) bits.push(`${repo.dirty} uncommitted change${repo.dirty === 1 ? '' : 's'} in your folder`);
  const warn = repo && repo.identity === false ? 'Git does not know your name and email yet, so Workbench cannot merge.' : '';
  const stateHtml = (bits.length ? `<span>${esc(bits.join('. '))}${warn ? '.' : ''}</span>` : '') + (warn ? `<span class="warn"><svg class="g" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-stuck"/></svg>${esc(warn)}</span>` : '');
  if (el.state.dataset.html !== stateHtml) { el.state.innerHTML = stateHtml; el.state.dataset.html = stateHtml; }
  el.state.hidden = !stateHtml;
  el.state.style.fontSize = P.silkSub + 'px';
  // what needs you: the first in the queue, lit; it takes you back to the board with that item in the lid
  const q = model.needsQueue();
  const first = q[0] || null;
  if (first) {
    const nm = visibleText(first.name || 'An agent');
    const label = `${cutMiddle(nm, 24)} needs you`;
    if (el.needs.dataset.label !== label + q.length) {
      el.needs.dataset.label = label + q.length;
      el.needs.innerHTML = `<svg class="g" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-need"/></svg><span>${esc(label)}</span>`;
      el.needs.setAttribute('aria-label', `${nm} needs you${q.length > 1 ? `, and ${q.length - 1} more` : ''}. Back to the board, to answer it.`);
    }
    el.needs.dataset.agent = first.id;
  }
  el.needs.hidden = !first;
  el.needs.style.fontSize = P.silkSub + 'px';
  el.back.style.fontSize = P.silkSub + 'px';
  el.say.style.fontSize = P.silkSub + 'px';
  el.ph.style.fontSize = P.silkSub + 'px';
  el.said.style.fontSize = P.silkSub + 'px';
  const sayLabel = st.detail && st.detail.kind === 'agent' && agentOf(st.detail.agentId)
    ? `Type what you want. It goes to Workbench, about ${visibleText(agentOf(st.detail.agentId).name)}.` : 'Type what you want. It goes to Workbench.';
  if (el.say.getAttribute('aria-label') !== sayLabel) el.say.setAttribute('aria-label', sayLabel);
}

/** The band's height, as laid out: the graph starts under it (measured from the screen's top, which moves as it slides). */
const bandBottom = z => {
  const top = el.screen.getBoundingClientRect().top;
  return Math.max(z.bd.y + z.P.topBand, el.left.getBoundingClientRect().bottom - top + 10, el.right.getBoundingClientRect().bottom - top + 10);
};

/** The graph: the SVG (traces, vias, pads, chips) under one row per commit, each row a listbox option. */
function paintGraph(z) {
  const { P, bd, GP } = z;
  // under the band: the wire's level run, then the graph
  const band = Math.round(bandBottom(z));
  const top = band + 24, left = bd.x + 14, right = bd.r - 14, bottom = bd.b - 14;
  Object.assign(el.graph.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: Math.max(80, bottom - top) + 'px' });
  const areaW = right - left;
  const minText = P.name === 'S' ? 300 : P.name === 'M' ? 380 : 440;
  const graphW = Math.max(180, Math.min(Math.round(areaW * 0.46), areaW - minText));
  const d = st.data;
  const detailLevel = el.html.dataset.detail || 'calm';
  const key = [st.seq, d ? 1 : 0, st.error || '', st.loading, z.W, z.H, graphW, st.sel, detailLevel, d && JSON.stringify(d.agents.map(a => { const x = agentOf(a.id); return x && [x.state, workSig(x), x.files && x.files.changed]; }))].join('|');
  st.geo = { band, top, left, right, bottom, graphW, textX: 0, wire: st.geo && st.geo.wire };
  if (!d) {
    st.g = null;
    const words = st.error ? esc(st.error) : 'Reading the history…';
    const html = `<p class="gnote" role="presentation">${words}</p>`;
    if (st.keys.graph !== html) { st.keys.graph = html; el.graph.innerHTML = html; }
    return;
  }
  if (!d.commits.length) {
    st.g = null;
    const html = '<p class="gnote" role="presentation">This repository has no commits yet.</p>';
    if (st.keys.graph !== html) { st.keys.graph = html; el.graph.innerHTML = html; }
    return;
  }
  const g = st.g && st.keys.graph === key ? st.g : graphLayout({ commits: d.commits, agents: d.agents.map(a => agentOf(a.id) || a), branch: d.repo.branch, head: d.repo.head, width: graphW, height: bottom - top, ACTIVE: STATES.ACTIVE }, GP);
  st.g = g;
  // opened on an agent with no work node (merged with nothing new: "See it in git"): its branch's tip, or its merge
  if (st.sel && st.sel.startsWith('work:') && !g.rows.some(r => r.item.id === st.sel)) {
    const a = agentOf(st.sel.slice(5)), br = a && a.branch;
    const tip = (br && d.commits.find(c => c.refs.includes(br))) || d.commits.find(c => c.agentId === (a && a.id) && c.kind === 'merge');
    if (tip) st.sel = tip.id;
  }
  st.geo.textX = Math.ceil(g.w + 12);
  if (st.keys.graph === key) return;
  st.keys.graph = key;
  const now = Date.now();
  const textW = areaW - st.geo.textX - 12;
  const l1 = parseFloat(el.screen.style.getPropertyValue('--g-l1')), l2 = parseFloat(el.screen.style.getPropertyValue('--g-l2'));
  const cw1 = ctx.measure('M', l1, 500), cw2 = ctx.measure('M', l2, 400), cwB = ctx.measure('M', l2, 600);
  const agentById = new Map(d.agents.map(a => [a.id, agentOf(a.id) || a]));
  let rows = '';
  for (const r of g.rows) {
    const it = r.item, w = rowWords(it, { agentById, now, branch: d.repo.branch });
    const id = it.id, sel = id === st.sel;
    // badges first (cut to fit, the rest counted), then the subject, cut at a word boundary
    let used = 0, badges = '';
    const shownBadges = [];
    for (const b of w.badges) {
      const t = cutMiddle(b.text, 22), bw = t.length * cwB + 16;
      if (used + bw > textW * 0.55 && shownBadges.length) { shownBadges.push({ more: w.badges.length - shownBadges.length }); break; }
      shownBadges.push({ ...b, t }); used += bw;
    }
    for (const b of shownBadges) {
      if (b.more) { badges += `<span class="ref more" title="${esc(w.badges.slice(-b.more).map(x => x.title).join(', '))}">+${b.more}</span>`; used += 4 * cwB + 16; continue; }
      badges += `<span class="ref ${b.kind}" title="${esc(b.title)}"${b.agentId ? ` data-badge-agent="${esc(b.agentId)}"` : ''}>${esc(b.t)}</span>`;
    }
    const mark = it.kind === 'work' ? markOfAgent(it.agent || {}, STATES.LOOK) : null;
    const lead = mark ? 16 : 0;
    const n1 = Math.max(4, Math.floor((textW - used - lead) / cw1)), n2 = Math.max(4, Math.floor(textW / cw2));
    const t1 = clipTo(w.line1, n1), t2 = clipTo(w.line2, n2);
    const title = [w.line1, w.line2].join('\n');
    const glyph = mark ? `<svg class="g t-${mark.tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${mark.shape}"/></svg>` : '';
    rows += `<div class="gr${it.kind === 'work' ? ' work' : ''}${sel ? ' sel' : ''}" role="option" id="gr-${esc(cssId(id))}" data-id="${esc(id)}" aria-selected="${sel}" tabindex="${sel || (!st.sel && r.row === 0) ? 0 : -1}"`
      + ` aria-label="${esc(w.aria)}" title="${esc(title)}" style="top:${r1(r.y - g.rowH / 2)}px;height:${g.rowH}px;padding-left:${st.geo.textX}px">`
      + `<span class="l1">${glyph}${badges}<span class="sub">${esc(t1)}</span></span><span class="l2">${esc(t2)}</span></div>`;
  }
  const more = d.more ? `<p class="gmore" style="top:${g.h - 8}px;padding-left:${st.geo.textX}px">Older commits are not shown here.</p>` : '';
  const html = `<div class="gin" style="height:${g.h + (d.more ? 22 : 0)}px"><svg class="gsvg" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}" aria-hidden="true">${graphSvg(g)}</svg>${rows}${more}</div>`;
  const hadFocus = el.graph.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  el.graph.innerHTML = html;
  if (hadFocus) el.graph.querySelector(`.gr[data-id="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });
}
const cssId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

/** The drawing: the gold trunk under the copper lanes, then the nodes, the "+N" folds and the selection ring. */
function graphSvg(g) {
  let s = '';
  for (const e of g.edges) {
    if (e.kind === 'trunk') s += `<path class="gt-bus${e.stub ? ' stub' : ''}" d="${pathD(e.pts)}"/><path class="gt-hi${e.stub ? ' stub' : ''}" d="${pathD(e.pts)}"/>`;
  }
  for (const e of g.edges) {
    if (e.kind === 'trunk') continue;
    s += `<path class="${e.kind === 'wire' ? 'gw' : 'gc'}${e.stub ? ' stub' : ''}" d="${pathD(e.pts)}"/>`;
  }
  for (const n of g.nodes) s += nodeSvg(n, g);
  for (const f of g.folds) s += `<text class="gfold" x="${f.x}" y="${f.y}" text-anchor="middle">+${f.n}</text>`;
  return s;
}

function nodeSvg(n, g) {
  const { x, y } = n, sel = n.id === st.sel;
  let s = sel ? `<circle class="gsel" cx="${x}" cy="${y}" r="${r1(n.size + 5)}"/>` : '';
  if (n.kind === 'head') {
    const h = n.size;
    s += `<rect class="gpad gold" x="${r1(x - h)}" y="${r1(y - h)}" width="${2 * h}" height="${2 * h}" rx="2.5"/><circle class="ghole" cx="${x}" cy="${y}" r="${r1(h * 0.32)}"/>`;
    s += `<text class="ghead" x="${r1(x - h - 5)}" y="${r1(y - h - 3)}" text-anchor="end">HEAD</text>`;
  } else if (n.kind === 'merge') {
    const h = n.size;
    s += `<rect class="gpad ${n.trunk ? 'gold' : 'cu'}" x="${r1(x - h)}" y="${r1(y - h)}" width="${2 * h}" height="${2 * h}" rx="1.5"/><circle class="ghole" cx="${x}" cy="${y}" r="${r1(h * 0.3)}"/>`;
  } else if (n.kind === 'chip') {
    const P = GRAPH_SIZES[Object.keys(GRAPH_SIZES).find(k => GRAPH_SIZES[k].rowH === g.rowH) || 'M'];
    const w = P.chipW, h = P.chipH, a = n.item.agent || (st.data && agentOf(n.agentId)) || null;
    const mark = markOfAgent(a || { state: 'done_checked' }, STATES.LOOK);
    s += `<path class="gleads" d="M${r1(x - w / 2 + 3)} ${r1(y - h / 2 - 2.5)}H${r1(x + w / 2 - 3)}M${r1(x - w / 2 + 3)} ${r1(y + h / 2 + 2.5)}H${r1(x + w / 2 - 3)}"/>`;
    s += `<rect class="gchip" x="${r1(x - w / 2)}" y="${r1(y - h / 2)}" width="${w}" height="${h}" rx="1.5"/>`;
    s += `<use href="#g-${mark.shape}" class="t-${mark.tone}" x="${r1(x - 3.5)}" y="${r1(y - 3.5)}" width="7" height="7"/>`;
  } else if (n.kind === 'work') {
    const a = n.item.agent || null, mark = markOfAgent(a || { state: 'working' }, STATES.LOOK);
    s += `<circle class="gwork" cx="${x}" cy="${y}" r="${n.size}"/>`;
    s += `<use href="#g-${mark.shape}" class="t-${mark.tone}" x="${r1(x - 4)}" y="${r1(y - 4)}" width="8" height="8"/>`;
  } else {
    s += `<circle class="gvia ${n.trunk ? 'gold' : 'cu'}" cx="${x}" cy="${y}" r="${n.size}"/><circle class="ghole" cx="${x}" cy="${y}" r="${r1(n.size * 0.38)}"/>`;
  }
  return s;
}

/** The git screen's own board: the surface, its mounting holes, and the wire in from the top edge to the trunk. */
function paintBoard(z) {
  const { W, H, P, bd, wx } = z, geo = st.geo;
  // the wire: down from the top edge at the board wire's x, then with 45° bends to the trunk at the graph's top
  const tx = st.g ? r1(geo.left + st.g.trunkX) : null;
  const y0 = bd.y - P.margin, yTop = geo.top;
  let wire;
  if (tx == null) wire = [[wx, y0], [wx, yTop]];
  else if (Math.abs(tx - wx) < 1) wire = [[wx, y0], [wx, yTop]];
  else {
    // down between the band's two halves, a 45° bend, level just under the band, a 45° bend, down into the trunk
    const D = 14, yRun = geo.band + 2, s = Math.sign(tx - wx);
    wire = [[wx, y0], [wx, yRun - D], [wx + s * D, yRun], [tx - s * D, yRun], [tx, yRun + D], [tx, yTop]];
  }
  geo.wire = wire;
  const key = [W, H, P.name, wx, wire.map(p => p.join(',')).join(' ')].join('|');
  if (st.keys.board === key) return;
  st.keys.board = key;
  const cx = Math.round(W / 2), cy = Math.round(H / 2);
  let s = `<defs>
    <radialGradient id="gGold" cx="40%" cy="35%" r="70%"><stop class="b-gold-1" offset="0"/><stop class="b-gold-2" offset=".6"/><stop class="b-gold-3" offset="1"/></radialGradient>
    <radialGradient id="gMask" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r1(Math.hypot(W, H) * 0.55)}"><stop class="b-mask-1" offset="0"/><stop class="b-mask-2" offset=".6"/><stop class="b-mask-3" offset="1"/></radialGradient>
    <pattern id="gDots" width="16" height="16" patternUnits="userSpaceOnUse"><circle class="b-dot" cx="8" cy="8" r=".85"/></pattern>
    <filter id="gGrainF" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="23" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .10 0 0 0 -.02"/></filter>
    <pattern id="gGrain" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="#fff" filter="url(#gGrainF)"/></pattern>
  </defs>`;
  s += `<rect class="b-bench" width="${W}" height="${H}"/>`;
  s += `<rect x="${bd.x}" y="${bd.y}" width="${bd.w}" height="${bd.h}" rx="${P.boardR}" fill="url(#gMask)"/>`;
  s += `<rect class="b-grain" x="${bd.x}" y="${bd.y}" width="${bd.w}" height="${bd.h}" rx="${P.boardR}" fill="url(#gGrain)"/>`;
  s += `<rect class="b-dots" x="${bd.x}" y="${bd.y}" width="${bd.w}" height="${bd.h}" rx="${P.boardR}" fill="url(#gDots)"/>`;
  s += `<rect class="b-edge" x="${bd.x + 0.5}" y="${bd.y + 0.5}" width="${bd.w - 1}" height="${bd.h - 1}" rx="${P.boardR}"/>`;
  for (const [x, y] of [[P.margin + 22, P.margin + 22], [W - P.margin - 22, P.margin + 22], [P.margin + 22, H - P.margin - 22], [W - P.margin - 22, H - P.margin - 22]])
    s += `<circle class="hole-ring" cx="${x}" cy="${y}" r="16.5"/><circle cx="${x}" cy="${y}" r="12" fill="url(#gGold)"/><circle class="hole-in" cx="${x}" cy="${y}" r="6.8"/>`;
  // the wire from the board above, and the gold finger where it comes in at the top edge
  s += `<path class="dram-wire gwire" d="${pathD(wire)}"/>`;
  s += `<rect class="dram-finger" x="${r1(wx - 3)}" y="${bd.y}" width="6" height="${P.fingerH}" rx="1"/>`;
  el.svg.setAttribute('width', W); el.svg.setAttribute('height', H); el.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.svg.innerHTML = s;
  Object.assign(el.wireEnd.style, { left: r1(wx - 11) + 'px', top: '0px', width: '22px', height: r1(bd.y + P.fingerH + 6) + 'px' });
}

// ---------------------------------------------------------------- selecting rows, the detail

function rowEls() { return [...el.graph.querySelectorAll('.gr')]; }

function select(id, { focus = false } = {}) {
  if (!id) return;
  st.sel = id;
  for (const r of rowEls()) {
    const on = r.dataset.id === id;
    r.classList.toggle('sel', on);
    r.setAttribute('aria-selected', String(on));
    r.tabIndex = on ? 0 : -1;
    if (on && focus) { r.focus({ preventScroll: true }); r.scrollIntoView({ block: 'nearest' }); }
  }
  // the ring on the selected node
  const svg = el.graph.querySelector('.gsvg');
  if (svg && st.g) {
    svg.querySelector('.gsel')?.remove();
    const n = st.g.nodes.find(x => x.id === id);
    if (n) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('class', 'gsel'); c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', r1(n.size + 5));
      svg.insertBefore(c, svg.firstChild);
    }
  }
}

/** What a row opens: an agent's work node or the tip of its branch (an agent's lane), else the commit. */
function openRow(id) {
  if (id.startsWith('work:')) openDetail({ kind: 'agent', agentId: id.slice(5) });
  else openDetail({ kind: 'commit', id });
}

function openDetail(d) {
  st.detail = d;
  st.armedUntil = performance.now() + 500;
  if (d.kind === 'agent') loadChanges(true);
  paintDetail();
  el.detail.querySelector('h2')?.focus({ preventScroll: true });
}

function closeDetail() {
  st.detail = null;
  paintDetail();
  const row = st.sel && el.graph.querySelector(`.gr[data-id="${CSS.escape(st.sel)}"]`);
  (row || el.title).focus({ preventScroll: true });
}

const detailAgentId = () => (st.shown && st.detail && st.detail.kind === 'agent' ? st.detail.agentId : null);
/** The agent whose detail is open, for words typed on the git screen (they go with focusId set to it). */
export const gitFocusId = detailAgentId;

/** Esc on the git screen: the detail closes (back to its node); then back to the board. Opened on an agent, it goes back at once. */
export function gitEscape() {
  if (!st.shown) return false;
  if (document.activeElement === el.say && el.say.value) { el.say.value = ''; el.bar.classList.remove('typed'); return true; }
  if (st.detail && !(st.openedOn && st.detail.kind === 'agent' && st.detail.agentId === st.openedOn)) { closeDetail(); return true; }
  closeGit();
  return true;
}

function onGraphKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const rows = rowEls();
  if (!rows.length) return;
  const i = Math.max(0, rows.findIndex(r => r === document.activeElement));
  let j = null;
  if (e.key === 'ArrowDown') j = Math.min(rows.length - 1, i + 1);
  else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
  else if (e.key === 'Home') j = 0;
  else if (e.key === 'End') j = rows.length - 1;
  else if (e.key === 'PageDown' || e.key === 'PageUp') j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'PageDown' ? 8 : -8)));
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const id = rows[i].dataset.id; select(id); openRow(id); return; }
  if (j == null) return;
  e.preventDefault();
  select(rows[j].dataset.id, { focus: true });
  // with the detail open, it follows the selection
  if (st.detail) { const id = rows[j].dataset.id; st.detail = id.startsWith('work:') ? { kind: 'agent', agentId: id.slice(5) } : { kind: 'commit', id }; st.armedUntil = performance.now() + 500; if (st.detail.kind === 'agent') loadChanges(false); paintDetail(); }
}

function onDetailClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.gitAct === 'close') { closeDetail(); return; }
  if (b.dataset.gitAct === 'agent') { select('work:' + b.dataset.agent); openDetail({ kind: 'agent', agentId: b.dataset.agent }); return; }
  if (b.dataset.gitAct === 'commit') { select(b.dataset.id, { focus: false }); openDetail({ kind: 'commit', id: b.dataset.id }); return; }
  if (b.dataset.act) {
    // Merge, Throw it away and a card's answers: bound like the lid's, and handed to the lid's own handler, which checks
    // them against what is current before it sends anything. A moment after the detail changes, clicks are ignored.
    if (performance.now() < st.armedUntil) return;
    ctx.act(b);
  }
}

/** The panel at the right, over the text column: an agent's branch (its work, its actions, its diff) or a commit. */
function paintDetail(z = sizes()) {
  const d = st.detail, geo = st.geo;
  // the rows' words under the panel are hidden while it is open (the rows keep their names for screen readers)
  el.graph.classList.toggle('covered', !!(d && geo));
  if (!d || !geo) { if (!el.detail.hidden) { el.detail.hidden = true; el.detail.innerHTML = ''; st.keys.detail = ''; } return; }
  // over the whole text column (the graph stays in sight), and clear of the mounting hole in the bottom right corner
  const left = geo.left + Math.max(120, (geo.textX || geo.graphW) - 8);
  const bottom = z.bd.b - 46;
  Object.assign(el.detail.style, { left: r1(left) + 'px', top: geo.top + 'px', width: r1(geo.right - left) + 'px', height: Math.max(120, bottom - geo.top) + 'px' });
  const html = d.kind === 'agent' ? agentDetail(d.agentId, z) : commitDetail(d.id);
  el.detail.hidden = false;
  if (st.keys.detail === html) return;
  st.keys.detail = html;
  const focusKey = el.detail.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const scroll = el.detail.querySelector('.gdiff')?.scrollTop || 0;
  patchChildren(el.detail, html);
  const box = el.detail.querySelector('.gdiff');
  if (box && scroll) box.scrollTop = scroll;
  if (focusKey) el.detail.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// the engine's sentences for why git cannot merge (SPEC section 2), when the lid's gitReason() is not there to ask
const GIT_WORDS = {
  detached: 'Your folder is not on a branch, so there is nowhere to merge it.',
  identity: 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.',
};
const btnAttrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');

function agentDetail(agentId, z) {
  const a = agentOf(agentId);
  const close = '<button type="button" class="gx" data-git-act="close" data-key="close" aria-label="Close the detail">×</button>';
  if (!a) return `<header class="dhd"><h2 id="gitDetailTitle" tabindex="-1">That agent is no longer here.</h2>${close}</header>`;
  const mark = markOfAgent(a, STATES.LOOK), name = visibleText(a.name || 'Agent');
  const w = a.work || {};
  const repo = st.data ? st.data.repo : (S.meta && S.meta.repo) || {};
  const into = repo.branch || null;
  let h = `<header class="dhd"><svg class="g c-${mark.tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${mark.shape}"/></svg><h2 id="gitDetailTitle" tabindex="-1">${esc(name)}</h2><span class="dst">${esc(a.earlier ? `from an earlier run · ${mark.label}` : mark.label)}</span>${close}</header>`;
  // where its work is
  const lines = [];
  if (w.branch) {
    const from = a.from || w.from;
    const at = a.base ? shortId(a.base) : '';
    lines.push(`On its branch <b>${esc(visibleText(w.branch))}</b>${from ? `, from ${esc(visibleText(from))}${at ? ` at ${esc(at)}` : ''}` : at ? `, from ${esc(at)}` : ''}`);
  } else lines.push(w.thrownAway ? 'Its work was thrown away. Workbench keeps a hidden copy in git.' : 'It has no branch of its own.');
  if (w.merged) lines.push(`Merged into ${esc(visibleText(w.merged.into || 'your branch'))} ${esc(agoText(Date.now() - (w.merged.at || Date.now())))} · ${esc(plural(w.merged.files || 0, 'file'))}`);
  // "more" detail: who did the work, as the lid's meta line says it
  if (el.html.dataset.detail === 'more') {
    const who = [a.harness === 'claude' ? 'Claude' : a.harness === 'codex' ? 'Codex' : a.harness === 'sim' ? 'Simulated' : '', a.model || '', a.machineId ? model.machineName(a.machineId) : ''].filter(Boolean);
    if (who.length) lines.push(esc(visibleText(who.join(' · '))));
  }
  // its counts, from the diff once it is here (exactly what a merge would take), else from what the agent reported
  const ch = st.changes.agentId === agentId ? st.changes : null;
  const diff = ch && ch.data && ch.data.ok !== false ? ch.data.diff : null;
  const files = diff ? diff.files || [] : null;
  const counts = files ? { n: files.length + (diff.omitted || 0), adds: files.reduce((s, f) => s + (f.adds || 0), 0), dels: files.reduce((s, f) => s + (f.dels || 0), 0) }
    : a.files ? { n: a.files.changed || 0, adds: a.files.adds || 0, dels: a.files.dels || 0 } : null;
  if (counts && (counts.n || !w.merged)) lines.push(counts.n ? `${plural(counts.n, 'file')}, +${counts.adds} −${counts.dels}${diff && diff.left && diff.left.length ? ` · ${plural(diff.left.length, 'file')} left out` : ''}` : 'Nothing changed since it started.');
  h += `<div class="dmeta">${lines.map(l => `<p>${l}</p>`).join('')}</div>`;
  if (w.problem && w.problem.sentence) {
    const paths = (w.problem.paths || []).slice(0, 6).map(p => esc(visibleText(p))).join(', ');
    h += `<div class="dprob"><svg class="g" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-stuck"/></svg><p>${esc(visibleText(w.problem.sentence))}${paths ? `<br><span class="paths">${paths}</span>` : ''}</p></div>`;
  }
  // the engine's card in place of the actions, or the actions that apply
  const c = S.confirm;
  if (c && c.agentId === agentId && (c.kind === 'merge' || c.kind === 'discard')) {
    const yes = c.yes || 'Do it', no = c.no || 'Cancel';
    h += `<div class="dcard" role="group" aria-labelledby="gitCard"><p class="dq" id="gitCard">${esc(c.sentence || '')}</p>${c.detail ? `<p class="dcd">${esc(c.detail)}</p>` : ''}`
      + `<div class="dacts"><button type="button" class="gbig${c.danger ? '' : ' pri'}" data-act="confirm" data-confirm="${esc(c.id)}" data-go="1" data-key="cyes:${esc(c.id)}">${esc(yes)}</button>`
      + `<button type="button" class="gbig" data-act="confirm" data-confirm="${esc(c.id)}" data-go="0" data-key="cno:${esc(c.id)}">${esc(no)}</button></div></div>`;
  } else {
    const live = !!(S.meta && S.meta.mode === 'live');
    const fallback = workActions(a, { mode: S.meta && S.meta.mode, repo: S.meta && S.meta.repo ? { ...S.meta.repo, identity: S.meta.repo.identity ?? repo.identity } : repo, ACTIVE: STATES.ACTIVE });
    const canMerge = live && (typeof model.mergeApplies === 'function' ? model.mergeApplies(a) : fallback.merge);
    const canDiscard = live && (typeof model.discardApplies === 'function' ? model.discardApplies(a) : fallback.discard);
    const bind = { agent: a.id, state: a.state, work: typeof model.workKey === 'function' ? model.workKey(a) : null };
    let acts = '';
    if (canMerge && into) acts += `<button type="button" class="gbig pri" title="Merge into ${esc(visibleText(into))}"${btnAttrs({ act: 'merge', ...bind, into, key: 'merge' })}>${esc(mergeLabel(into))}</button>`;
    if (canDiscard) acts += `<button type="button" class="gbig"${btnAttrs({ act: 'discard', ...bind, key: 'discard' })}>Throw it away</button>`;
    if (acts) h += `<div class="dacts">${acts}</div>`;
    // no Merge for a reason about git (not on a branch, no name and email): the engine's words, as the lid says them
    const why = typeof model.gitReason === 'function' ? model.gitReason(a)
      : live && fallback.discard && !STATES.ACTIVE.has(a.state) && (a.files ? a.files.changed > 0 : ['stopped', 'failed'].includes(a.state) || a.earlier)
        ? (!into ? GIT_WORDS.detached : repo.identity === false ? GIT_WORDS.identity : null) : null;
    if (why && !canMerge) h += `<p class="dwhy">${esc(why)}</p>`;
  }
  if (ch && ch.data && ch.data.live) h += '<p class="dwhy">It is still working, so its work may still change.</p>';
  // the diff, in one scroll box
  let body;
  if (!ch || (ch.loading && !ch.data)) body = '<p class="dq">Reading its changes…</p>';
  else if (ch.error) body = `<p class="dq">${esc(ch.error)}</p>`;
  else if (ch.data && ch.data.ok === false) body = `<p class="dq">${esc(ch.data.reply || 'Workbench could not read its changes.')}</p>`;
  else {
    // made once per answer: a long diff is not rebuilt on every render
    if (ch.htmlOf !== ch.data) { ch.html = diffHtml(diff || { files: [] }, { maxLines: 4000 }); ch.htmlOf = ch.data; }
    body = ch.html;
  }
  h += `<div class="gdiff" data-scroll="1" tabindex="0" aria-label="${esc(name)}’s changes, in full">${body}</div>`;
  return h;
}

function commitDetail(id) {
  const close = '<button type="button" class="gx" data-git-act="close" data-key="close" aria-label="Close the detail">×</button>';
  const c = st.data && st.data.commits.find(x => x.id === id);
  if (!c) return `<header class="dhd"><h2 id="gitDetailTitle" tabindex="-1">That commit is no longer shown.</h2>${close}</header>`;
  const subject = visibleText(c.subject.trim()) || '(no description)';
  const when = c.at == null ? '' : (() => { const ms = c.at < 1e12 ? c.at * 1000 : c.at; return `${agoText(Date.now() - ms)} (${new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })})`; })();
  const agent = c.agentId ? agentOf(c.agentId) : null;
  const rows = [];
  rows.push(['By', esc(visibleText(c.author || 'someone'))]);
  if (when) rows.push(['When', esc(when)]);
  rows.push(['Id', `<code>${esc(c.id)}</code>`]);
  if (c.parents.length) rows.push([c.parents.length > 1 ? 'Parents' : 'Parent', c.parents.map(p => (st.data.commits.some(x => x.id === p) ? `<button type="button" class="glink" data-git-act="commit" data-id="${esc(p)}" data-key="p:${esc(p)}">${esc(shortId(p))}</button>` : `<code>${esc(shortId(p))}</code>`)).join(' ')]);
  else rows.push(['Parent', 'none: the first commit']);
  if (c.refs.length) {
    // your branch by name; an agent's branch as a way to its detail
    const repoBranch = st.data.repo.branch;
    const refWords = c.refs.map(r => {
      const owner = st.data.agents.find(a => (a.work && a.work.branch) === r || a.branch === r);
      if (r === repoBranch) return `${esc(visibleText(r))} (yours)`;
      if (owner) return `<button type="button" class="glink" data-git-act="agent" data-agent="${esc(owner.id)}" data-key="r:${esc(owner.id)}" title="${esc(visibleText(r))}">${esc(visibleText(owner.name))}’s branch</button>`;
      return esc(visibleText(r));
    });
    rows.push([c.refs.length > 1 ? 'Branches' : 'Branch', refWords.join(', ')]);
  }
  if (c.agentId) rows.push(['Made by', agent ? `<button type="button" class="glink" data-git-act="agent" data-agent="${esc(agent.id)}" data-key="a:${esc(agent.id)}">${esc(visibleText(agent.name))}</button>` : 'an agent that is no longer here']);
  const kind = c.kind === 'merge' || c.parents.length > 1 ? 'A merge commit' : c.kind === 'work' ? 'An agent’s work, as a commit' : '';
  return `<header class="dhd"><svg class="gmark" aria-hidden="true"><use href="#g-git"/></svg><h2 id="gitDetailTitle" tabindex="-1">${esc(subject)}</h2>${close}</header>`
    + (kind ? `<p class="dkind">${esc(kind)}</p>` : '')
    + `<dl class="dl2">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
