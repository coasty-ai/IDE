// Workbench UI: agents orbit the centre, which is you. The centre holds one thing at a time and the one place to type or talk.
import { duration, money, clip } from '/shared/format.mjs';
import { NEEDS_YOU } from '/shared/states.mjs';
import { initToken, hasToken, api, connect } from './api.js';
import { S, upsert, currentFocus, markReviewed, spendToday, needsQueue } from './model.js';
import { Orbit } from './orbit.js';
import { cardHtml, placeCardAt } from './card.js';
import { focusView } from './focus.js';
import { setupVoice } from './voice.js';
import { esc, coalesce } from './util.js';

const $ = id => document.getElementById(id);
const el = {
  stage: $('stage'), sky: $('sky'), nodes: $('nodes'), ripples: $('ripples'), core: $('core'),
  focus: $('focus'), card: $('card'), said: $('said'), bar: $('bar'), say: $('say'), heard: $('heard'), mic: $('mic'),
  toText: $('toText'), toCancel: $('toCancel'),
  repo: $('repo'), mode: $('mode'), conn: $('conn'), spend: $('spend'), mbtn: $('mbtn'), mcount: $('mcount'), pop: $('pop'),
};
const params = new URLSearchParams(location.search);
const still = params.has('still');
if (still) document.body.classList.add('still');

let lastFocusSig = null;
let lastFocusKey = null;
let saidTimer = null;
let swapping = false;

// ---------- the orbit ----------
const orbit = new Orbit({
  stage: el.stage, sky: el.sky, nodes: el.nodes, ripples: el.ripples, core: el.core, still,
  onEnter: id => { S.hoverId = id; renderCard(); },
  onLeave: id => { if (S.hoverId === id && !el.card.matches(':hover')) { S.hoverId = null; renderCard(); } },
  onPick: id => {
    S.confirm = null;
    S.focusId = id;
    S.pinId = S.pinId === id ? null : id;
    render();
  },
});
document.documentElement.style.setProperty('--s', orbit.geom.s.toFixed(3));
addEventListener('resize', () => { document.documentElement.style.setProperty('--s', orbit.geom.s.toFixed(3)); placeSaid(); render(); });

function placeSaid() {
  const g = orbit.geom;
  el.said.style.top = (g.cy + g.coreR + 16) + 'px';
}
placeSaid();

// ---------- notices ----------
function say(text, ms = 9000) {
  el.said.textContent = text || '';
  clearTimeout(saidTimer);
  if (text && ms) saidTimer = setTimeout(() => { el.said.textContent = ''; }, ms);
}

// ---------- rendering ----------
const render = coalesce(renderNow, 120);

function renderNow() {
  const f = currentFocus();
  const asking = f.agent && NEEDS_YOU.has(f.agent.state) ? f.agent.id : null;
  // Moon labels show for the agent that is picked, pinned or being asked about.
  const labelOf = id => { const a = id && S.agents.get(id); return a ? (a.parentId ? a.rootId : a.id) : null; };
  const labelRootId = labelOf(S.pinId) || labelOf(S.focusId) || labelOf(asking);
  orbit.setData(S.agents, { focusId: f.agent ? f.agent.id : null, askNodeId: asking, labelRootId });
  el.core.classList.toggle('wanting', needsQueue().length > 0 && !S.confirm);
  renderTop();
  renderFocus(f);
  renderCard();
  if (!el.pop.hidden) renderMachines();
  tick();
}

function renderTop() {
  const r = S.meta.repo;
  el.repo.textContent = r ? (r.name || '') : '';
  el.repo.title = r && r.dirty ? `Agents start from your last commit. ${r.dirty} uncommitted change${r.dirty === 1 ? ' is' : 's are'} not in their copies.` : '';
  if (S.meta.mode === 'demo') { el.mode.hidden = false; el.mode.textContent = 'demo'; el.mode.title = 'Simulated agents and machines. Nothing is spent.'; }
  else el.mode.hidden = true;
  el.spend.textContent = `${money(spendToday())} today`;
  const ms = S.machines;
  const asleep = ms.filter(m => !m.awake).length;
  el.mcount.textContent = ms.length <= 1 ? (ms[0]?.name || 'Your laptop') : `${ms.length} machines${asleep ? ` · ${asleep} asleep` : ''}`;
}

/** The centre changes content with a quick out-then-in, only when it moves to a different thing. */
function renderFocus(f) {
  let v;
  if (!hasToken()) {
    v = { sig: 'no-token', html: '<div class="count">Not connected</div><h1 class="len-m">Open the link printed in the terminal.</h1><p class="meta">It ends with ?t= and a key, so only you can use this page.</p>' };
  } else v = focusView(f);
  if (v.sig === lastFocusSig || swapping) return;
  const key = !hasToken() ? 'no-token' : f.confirm ? 'c:' + f.confirm.id : f.empty ? 'empty' : `${f.agent.id}|${f.agent.state}|${f.agent.ask ? f.agent.ask.id : ''}`;
  const hadFocus = el.focus.contains(document.activeElement);
  const swap = () => {
    el.focus.innerHTML = v.html;
    lastFocusSig = v.sig;
    tick();
    if (hadFocus) el.focus.querySelector('.big')?.focus();
  };
  if (key === lastFocusKey || still || lastFocusKey === null) {
    lastFocusKey = key;
    swap();
    return;
  }
  lastFocusKey = key;
  swapping = true;
  el.focus.classList.remove('in');
  el.focus.classList.add('out');
  setTimeout(() => {
    el.focus.classList.remove('out');
    swap();
    el.focus.classList.add('in');
    swapping = false;
    setTimeout(() => el.focus.classList.remove('in'), 360);
    render();
  }, 150);
}

function renderCard() {
  const id = S.pinId || S.hoverId;
  const a = id && S.agents.get(id);
  const p = a && orbit.pos(id);
  if (!a || !p) { el.card.classList.remove('show'); return; }
  el.card.innerHTML = cardHtml(a, Date.now(), S.pinId === id);
  placeCardAt(el.card, p);
  el.card.classList.add('show');
}

/** Every second: refresh the parts that count time. */
function tick() {
  const now = Date.now();
  for (const s of el.focus.querySelectorAll('[data-since]')) {
    const t = duration(now - Number(s.dataset.since)) || 'a moment';
    const text = t + (s.dataset.suffix || '');
    if (s.textContent !== text) s.textContent = text;
  }
}
setInterval(() => { tick(); if (el.card.classList.contains('show')) renderCard(); }, 1000);

el.card.addEventListener('pointerleave', () => { if (!S.pinId) { S.hoverId = null; renderCard(); } });
el.card.addEventListener('click', e => { if (e.target.closest('[data-unpin]')) { S.pinId = null; render(); } });

// ---------- machines ----------
function renderMachines() {
  const rows = S.machines.map(m => {
    const icon = m.kind === 'laptop' ? 'i-laptop' : (m.awake ? 'i-cloud' : 'i-moon');
    const stats = m.kind === 'laptop' && m.cpuPct != null ? `CPU ${Math.round(m.cpuPct)}% · memory ${Math.round(m.memPct)}%` : '';
    const small = [m.note, stats, m.kind === 'cloud' && m.awake && m.costPerHourUsd ? `${money(m.costPerHourUsd)} an hour` : ''].filter(Boolean).join(' · ');
    const sw = m.kind === 'cloud' ? `<button class="sw" role="switch" aria-checked="${m.awake}" aria-label="${esc(m.name)} awake" data-machine="${esc(m.id)}"></button>` : '';
    return `<div class="m${m.awake ? '' : ' off'}"><span class="i"><svg class="ic"><use href="#${icon}"/></svg></span><span class="mn">${esc(m.name)}<small>${esc(small)}</small></span>${sw}</div>`;
  }).join('');
  const idle = S.machines.find(m => m.kind === 'cloud' && m.awake && !m.agents);
  const hint = idle ? `<div class="hint">${esc(idle.name)} is idle. Sleep it?<button data-sleep="${esc(idle.id)}">Sleep</button></div>` : '';
  const sim = S.machines.some(m => m.simulated) ? '<p class="note">Cloud machines here are simulated.</p>' : '';
  el.pop.innerHTML = rows + hint + sim;
}
el.mbtn.addEventListener('click', () => {
  el.pop.hidden = !el.pop.hidden;
  el.mbtn.setAttribute('aria-expanded', String(!el.pop.hidden));
  if (!el.pop.hidden) renderMachines();
});
el.pop.addEventListener('click', async e => {
  const sw = e.target.closest('[data-machine]');
  const sl = e.target.closest('[data-sleep]');
  try {
    if (sw) { const r = await api.awake(sw.dataset.machine, sw.getAttribute('aria-checked') !== 'true'); say(r.reply); }
    if (sl) { const r = await api.awake(sl.dataset.sleep, false); say(r.reply); }
  } catch (err) { say(err.message); }
});

// ---------- answers in the centre ----------
el.focus.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const f = currentFocus();
  const a = f.agent;
  const act = b.dataset.act;
  try {
    if (act === 'confirm') {
      const c = S.confirm; S.confirm = null; render();
      const r = await api.confirm(c.id, b.dataset.go === '1');
      say(r.reply);
      S.focusId = null;
    } else if (act === 'answer' && a) {
      b.disabled = true;
      const r = await api.answer(a.id, a.ask && a.ask.id, b.dataset.answer);
      say(r.reply || `Told ${a.name}: ${b.dataset.answer}.`);
      S.focusId = null;
    } else if (act === 'reply' && a) {
      startReply(a, b.dataset.mode || 'say');
    } else if (act === 'fix' && a) {
      const r = await api.say(a.id, b.dataset.text);
      say(r.reply || `Sent to ${a.name}.`);
      S.focusId = null;
    } else if (act === 'reviewed' && a) {
      markReviewed(a.id);
      S.focusId = null; S.pinId = null;
      say(`${a.name} is marked as looked at.`);
    } else if (act === 'stop' && a) {
      const r = await api.stop(a.id);
      say(r.reply || `Stopped ${a.name}.`);
    } else if (act === 'parent' && a) {
      S.focusId = a.parentId;
    } else if (act === 'unpick') {
      S.focusId = null; S.pinId = null;
    } else if (act === 'more') {
      for (const m of el.focus.querySelectorAll('.more-text')) {
        if (m.querySelector('ul, .detail') || m.textContent === 'No files changed.') m.hidden = !m.hidden;
      }
    }
  } catch (err) { say(err.message); }
  render();
});

// ---------- typing and talking ----------
function startReply(a, mode) {
  S.reply = { agentId: a.id, mode, askId: a.ask && a.ask.id };
  el.toText.textContent = mode === 'answer' ? `to ${clip(a.name, 18)}:` : `tell ${clip(a.name, 18)}:`;
  el.bar.classList.add('replying');
  el.say.placeholder = mode === 'answer' ? 'your answer' : 'what to tell it';
  el.say.focus();
}
function endReply() {
  S.reply = null;
  el.bar.classList.remove('replying');
  el.say.placeholder = voice.available ? 'type, or hold space to talk' : 'type what you want';
}
el.toCancel.addEventListener('click', endReply);

async function submit(text) {
  text = text.trim();
  if (!text) return;
  el.say.value = '';
  el.say.blur();
  try {
    if (S.reply) {
      const r = S.reply;
      endReply();
      const res = r.mode === 'answer' && r.askId ? await api.answer(r.agentId, r.askId, text) : await api.say(r.agentId, text);
      say(res.reply || 'Sent.');
      S.focusId = null;
    } else {
      const f = currentFocus();
      const res = await api.command(text, f.agent ? f.agent.id : null);
      // A spoken or typed "do it" / "cancel" settles a pending confirm on the engine side.
      if (S.confirm && !res.confirm) S.confirm = null;
      if (res.confirm) S.confirm = res.confirm;
      if (res.focusId) S.focusId = res.focusId;
      say(res.reply || '', res.confirm ? 0 : 9000);
    }
  } catch (err) { say(err.message); }
  render();
}
el.bar.addEventListener('submit', e => { e.preventDefault(); submit(el.say.value); });

const voice = setupVoice({
  mic: el.mic, host: el.core, heard: el.heard, onFinal: submit, onNotice: t => say(t),
  onLevel: lvl => el.core.style.setProperty('--level', lvl.toFixed(2)),
});
if (!voice.available) el.say.placeholder = 'type what you want';

// Type anywhere, and hold the space bar to talk, but only when nothing else has the keyboard.
// (Space on a focused button would press it, so a held space must never reach "Allow".)
let holding = false;
const pageHasKeyboard = () => { const ae = document.activeElement; return !ae || ae === document.body || ae === el.stage; };
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!el.pop.hidden) { el.pop.hidden = true; el.mbtn.setAttribute('aria-expanded', 'false'); return; }
    if (voice.listening) { voice.stop(); return; }
    if (S.reply) { endReply(); return; }
    if (document.activeElement === el.say) { el.say.blur(); return; }
    if (S.pinId) { S.pinId = null; render(); return; }
    if (S.confirm) { const c = S.confirm; S.confirm = null; api.confirm(c.id, false).catch(() => {}); render(); }
    return;
  }
  if (!pageHasKeyboard()) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat && !holding && voice.available) { holding = true; voice.start({ hold: true }); }
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    el.say.focus();
    el.say.value += e.key;
  }
});
document.addEventListener('keyup', e => {
  if (e.key === ' ' && holding) { holding = false; voice.stop(); }
});
document.addEventListener('click', e => {
  if (!el.pop.hidden && !el.pop.contains(e.target) && !el.mbtn.contains(e.target)) { el.pop.hidden = true; el.mbtn.setAttribute('aria-expanded', 'false'); }
});

// ---------- live data ----------
function applyDebugParams() {
  const pin = params.get('pin');
  if (pin) {
    const all = [...S.agents.values()];
    const pick = pin === 'first-helper' ? all.find(a => a.parentId && a.state === 'working') || all.find(a => a.parentId)
      : pin === 'first-root' ? all.find(a => !a.parentId) : S.agents.get(pin);
    if (pick) { S.pinId = pick.id; S.hoverId = pick.id; }
  }
  const focus = params.get('focus');
  if (focus && S.agents.has(focus)) S.focusId = focus;
  const typed = params.get('say');
  if (typed) submit(typed);
}

let firstSnapshot = true;
function onSnapshot(snap) {
  S.meta = { mode: snap.mode, repo: snap.repo, harnesses: snap.harnesses || {}, defaultBudgetUsd: snap.defaultBudgetUsd };
  // Replace the data but keep nodes in place: the orbit keys everything by id, so a reconnect does not replay births.
  const fresh = new Map((snap.agents || []).map(a => [a.id, a]));
  for (const id of [...S.agents.keys()]) if (!fresh.has(id)) S.agents.delete(id);
  upsert(snap.agents || []);
  S.machines = snap.machines || [];
  if (firstSnapshot) {
    firstSnapshot = false;
    applyDebugParams();
    const r = snap.repo;
    if (snap.mode === 'live' && r && r.dirty) say(`Agents start from your last commit. ${r.dirty} uncommitted change${r.dirty === 1 ? ' is' : 's are'} not in their copies.`, 15000);
  }
  render();
}

function onAgents(list) {
  for (const a of list) {
    const prev = S.agents.get(a.id);
    if (prev && !NEEDS_YOU.has(prev.state) && NEEDS_YOU.has(a.state) && document.hidden) document.title = '• Workbench';
  }
  upsert(list);
  render();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Workbench'; });

initToken();
if (hasToken() && params.has('static')) {
  // Debug: load the state once without a live stream, so headless screenshots can finish.
  api.state().then(onSnapshot).catch(err => say(err.message));
} else if (hasToken()) {
  connect({
    snapshot: onSnapshot,
    agents: onAgents,
    machines: list => {
      // Updates may carry only the machines that changed; merge them by id.
      const byId = new Map(S.machines.map(m => [m.id, m]));
      for (const m of list) byId.set(m.id, m);
      S.machines = [...byId.values()];
      render();
    },
    notice: text => say(text),
    open: () => { S.connected = true; el.conn.hidden = true; },
    error: () => { S.connected = false; el.conn.hidden = false; },
  });
}
render();
