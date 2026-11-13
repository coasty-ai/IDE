// The connect panel, "Agents & keys": a modal dialog over the board (and over the git screen, when words typed there
// open it). It shows which coding agents can start work and how they sign in, git's name and email, GitHub, and the keys
// agents get, and it acts only through the /api/connect routes. Its words, rows and buttons come from connectview.js
// (pure); this module draws them, keeps the part someone is typing in, checks a button against what is current before
// it sends, and sends.
//
// Values a person types here (API keys, tokens) are read from their field when sent, and the field is cleared at once:
// they are never kept in a variable that outlives the request, never said, never logged and never written into markup.
// Nothing here touches the page when the module loads.
import { connectApi } from './api.js';
import * as presetModule from '/shared/keypresets.mjs';
import { panelParts, customRow, addForm, statusOf, metaFromStatus, agentsOf, agentStamp, keysOf, signInNotes, agentKeyRequest,
  gitRequest, githubRequest, githubShareRequest, githubBoxOn, newKeyRequest, MAX_NAMES } from './connectview.js';
import { visibleControls } from './words.js';
import { esc } from './util.js';

let ctx = null, el = null;
// Which forms are open, and the choices made in them (git's name and email as typed, the GitHub box, a new key's preset,
// name, place and agents, and what GitHub's box asked for while that is on its way): never a key or a token.
const closedForms = () => ({ keyFor: null, cmd: {}, add: null, removing: null, git: null, ghAgents: false, ghShare: null });
const st = {
  status: null,        // the last ConnectStatus shown
  error: null,         // why there is none yet, in plain words
  seq: 0, shownSeq: 0, // requests are numbered: an answer older than the one shown is not drawn
  opener: null,        // where the keyboard goes back to
  open: closedForms(), // which forms are open (never anything typed in them)
  busy: new Set(),     // buttons whose request is on its way
  checking: false, again: null, lastCheck: 0, wasReady: null, isOpen: false,
  downOutside: false,  // the pointer went down outside the panel's box (only then does a click there close it)
};
// The presets and the names agents sign in with come from the shared module, whatever it holds (it is U1's).
const presets = () => (Array.isArray(presetModule.KEY_PRESETS) ? presetModule.KEY_PRESETS : []);
const signIn = () => signInNotes(presetModule.signInVariables);

/** Is the panel open? While it is, the board takes no typing, no talking and no Esc of its own. */
export const connectShown = () => !!(el && el.dialog.open);

/**
 * @param {object} c  { onStatus(meta) (meta.connect as the latest answer tells it), looksLikeSecret (the shared check),
 *   repoName() (the person's repository, for "this repository"), canRepo() (a key can be for this repository),
 *   home() (focus the lid's sentence), toLid(id) ("<Name> needs you": that agent in the lid) }
 */
export function setupConnect(c) {
  ctx = c;
  const $ = id => document.getElementById(id);
  el = { dialog: $('connect'), title: $('connectTitle'), said: $('connectSaid'), body: $('connectBody'), close: $('connectClose'), needs: $('connectNeeds'), band: $('connectBtn') };
  el.dialog.addEventListener('pointerdown', e => { st.downOutside = outside(e); });
  el.dialog.addEventListener('click', onClick);
  el.dialog.addEventListener('change', onChange);
  el.dialog.addEventListener('keydown', onKey);
  // Esc reaches the page's own handler first (app.js closes the panel there); this is for any other way it is cancelled
  el.dialog.addEventListener('cancel', e => { e.preventDefault(); closeConnect(); });
  el.dialog.addEventListener('close', () => { if (st.isOpen) finish({}); });
  // Terminal windows report nothing back: when the person comes back to the page, look again
  addEventListener('focus', recheckSoon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recheckSoon(); });
}

/**
 * Open the panel (or, when it is open, just say `said` there). `opener` gets the keyboard back when it closes.
 * It shows what it knew, then reads the status again and checks the agents again.
 */
export function openConnect({ opener = null, said = '' } = {}) {
  if (!el) return;
  if (!el.dialog.open) {
    const ae = document.activeElement;
    st.opener = opener || (ae && ae !== document.body && !el.dialog.contains(ae) ? ae : null);
    st.open = closedForms();
    st.error = null;
    try { el.dialog.showModal(); } catch { try { el.dialog.show(); } catch { return; } }
    st.isOpen = true;
    paint();
    el.title.focus({ preventScroll: true });
    if (!st.status) request(() => connectApi.status(), { quiet: true });
    recheck();
  }
  setSaid(said || '');
}

/** Close it. The keyboard goes back to what opened it, else the top band's button, else the lid's sentence. */
export function closeConnect({ toLid = false } = {}) {
  if (!el || !el.dialog.open) return;
  el.dialog.close();
  finish({ toLid });
}
function finish({ toLid = false }) {
  if (!st.isOpen) return;
  st.isOpen = false;
  // nothing typed here stays on the page once it closes
  for (const i of el.body.querySelectorAll('input[type="password"]')) i.value = '';
  st.open = closedForms();
  setSaid('');
  const back = toLid ? null : [st.opener, el.band].find(x => x && x.isConnected && !x.hidden && !x.closest('[inert]') && x.getClientRects().length);
  st.opener = null;
  if (back) back.focus({ preventScroll: true }); else ctx.home?.();
}

/** The lit "<Name> needs you" at the top of the panel, so nothing waits unseen behind it (app.js keeps it current). */
export function connectNeeds(info) {
  if (!el) return;
  const name = info ? visibleControls(info.name) : '';
  const html = info ? `<svg class="g k-need" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-need"/></svg><span>${esc(shortName(name))} needs you</span>` : '';
  el.needs.hidden = !info;
  if (el.needs.dataset.html !== html) { el.needs.innerHTML = html; el.needs.dataset.html = html; }
  if (info) {
    el.needs.dataset.agent = info.id;
    const all = `${name} needs you${info.more ? `, and ${info.more} more` : ''}. This closes Agents & keys.`;
    if (el.needs.getAttribute('aria-label') !== all) { el.needs.setAttribute('aria-label', all); el.needs.title = all; }
  }
}
/** A name cut at a word to 24 characters ("…"), never through a hidden character's code; all of it is in the title. */
function shortName(name) {
  const a = Array.from(name);
  if (a.length <= 24) return name;
  let s = a.slice(0, 24).join('');
  const sp = s.lastIndexOf(' '), open = s.lastIndexOf('⟦');
  if (open >= 0 && open > s.lastIndexOf('⟧')) s = s.slice(0, open);
  else if (sp > 10) s = s.slice(0, sp);
  return s.replace(/[,.;:\s]+$/, '') + '…';
}

// ---------------------------------------------------------------- talking to Workbench
function setSaid(text) {
  const s = text ? visibleControls(String(text).split(/[\t\n\v\f\r ]+/).filter(Boolean).join(' ')) : '';
  if (el.said.textContent !== s) el.said.textContent = s;
}

/**
 * Send one request. Its sentence is said in the panel; its status is drawn unless a newer one already was. A refusal
 * ({ ok: false, sentence }) is said the same way, and its status drawn too. Returns the answer, or null when it failed.
 */
async function request(fn, { busyKey = null, quiet = false } = {}) {
  const seq = ++st.seq;
  if (busyKey) { st.busy.add(busyKey); paint(); }
  try {
    const r = await fn();
    const s = statusOf(r);
    let said = !quiet && r && typeof r.sentence === 'string' ? r.sentence : '';
    if (s && seq > st.shownSeq) {
      st.shownSeq = seq; st.status = s; st.error = null;
      const meta = metaFromStatus(s);
      if (meta) {
        // the moment an agent becomes ready, say so: the person came here to get one ready
        if (st.wasReady === false && meta.ready && connectShown()) {
          const a = meta.agents.find(x => x.id === meta.defaultAgent && x.ready) || meta.agents.find(x => x.ready);
          said = [said, `${a ? a.name : 'A coding agent'} is ready. Close this, then say what to work on.`].filter(Boolean).join(' ');
        }
        st.wasReady = meta.ready;
        ctx.onStatus?.(meta);
      }
    }
    if (said) setSaid(said);
    return r && typeof r === 'object' ? r : {};
  } catch (err) {
    if (!st.status) st.error = err.message;
    setSaid(err.message);
    return null;
  } finally {
    if (busyKey) st.busy.delete(busyKey);
    paint();
  }
}
const okAnswer = r => !!r && r.ok !== false;

/**
 * Check the agents again (their programs and how they are signed in). One at a time: one asked for while another is on
 * its way (a key saved during the check made on opening, say) runs as soon as that one ends, so what it changed shows.
 */
async function recheck({ said = false } = {}) {
  const asked = 'Checking your agents again…';
  if (said) setSaid(asked);
  if (st.checking) { st.again = st.again || { said: false }; st.again.said = st.again.said || said; return; }
  st.checking = true;
  st.lastCheck = Date.now();
  try {
    await request(() => connectApi.recheck(), { quiet: !said });
    // an answer with no sentence of its own: the rows say what was found
    if (said && el.said.textContent === asked && !st.again) setSaid('Checked again.');
  } finally {
    st.checking = false;
    paint();
    const again = st.again;
    st.again = null;
    if (again && connectShown()) recheck(again);
  }
}
function recheckSoon() { if (connectShown() && !st.checking && Date.now() - st.lastCheck > 3000) recheck(); }

// ---------------------------------------------------------------- drawing
function view() {
  const busy = new Set(st.busy);
  if (st.checking && st.status) for (const a of agentsOf(st.status)) busy.add(`agent:${a.id}:recheck`);
  if (st.checking && !st.status && st.error) busy.add('retry');
  return { open: st.open, busy, presets: presets(), signIn: signIn(), looksLikeSecret: ctx.looksLikeSecret, repoName: ctx.repoName?.() || null,
    canRepo: !!ctx.canRepo?.(), error: st.error };
}
function paint() {
  if (!el || !el.dialog.open) return;
  patchKeyed(el.body, panelParts(st.status, view()));
}

/**
 * Make `host`'s children the parts given ([{ k, html }], each one element with data-k): a part whose markup did not
 * change is kept where it is (with what is typed in it, and the keyboard); the others are replaced in place. Focus in a
 * part that was replaced goes to the element with the same data-key, else to the panel's title, never to nothing.
 */
function patchKeyed(host, parts) {
  const had = host.contains(document.activeElement) ? document.activeElement : null;
  const old = new Map([...host.children].map(c => [c.dataset.k, c]));
  const keep = new Set();
  let cursor = host.firstElementChild;
  for (const p of parts) {
    let node = old.get(p.k);
    if (!node || node._src !== p.html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = p.html;
      const fresh = tpl.content.firstElementChild;
      if (!fresh) continue;
      fresh._src = p.html;
      if (node && node === cursor) node.replaceWith(fresh); else host.insertBefore(fresh, cursor);
      node = fresh;
    } else if (node !== cursor) host.insertBefore(node, cursor);
    keep.add(node);
    cursor = node.nextElementSibling;
  }
  for (const c of [...host.children]) if (!keep.has(c)) c.remove();
  if (!had || had.isConnected) return;
  const key = had.dataset && had.dataset.key;
  const again = key && host.querySelector(`[data-key="${CSS.escape(key)}"]`);
  (again || el.title).focus({ preventScroll: true });
}
const focusKey = k => { const e = el.body.querySelector(`[data-key="${CSS.escape(k)}"]`); if (e) e.focus({ preventScroll: true }); return !!e; };
const partOf = k => el.body.querySelector(`[data-k="${CSS.escape(k)}"]`);
const changed = () => { setSaid('That changed. Have another look.'); paint(); };

// ---------------------------------------------------------------- what the buttons do
function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConnect(); return; }
  // Enter in a field sends its form, as its first button would (there is no form element: nothing is ever submitted)
  if (e.key !== 'Enter' || e.isComposing) return;
  const f = e.target;
  if (!(f instanceof HTMLInputElement) || f.type === 'checkbox' || f.type === 'radio') return;
  const form = f.closest('[data-enter]');
  const b = form && form.querySelector(`button[data-cn="${CSS.escape(form.dataset.enter)}"]`);
  if (!b) return;
  e.preventDefault();
  act(b);
}

/** Is this pointer event on the dimmed board around the panel (the dialog's backdrop), not on the panel itself? */
function outside(e) {
  if (e.target !== el.dialog) return false;
  const r = el.dialog.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

function onClick(e) {
  // a click outside the panel's box closes it, when it also began there (selecting text in a field and letting go
  // past the panel's edge does not)
  const down = st.downOutside;
  st.downOutside = false;
  if (outside(e)) { if (down) closeConnect(); return; }
  // a box whose change is on its way waits: the click (or the space bar) is undone before it changes anything
  const t = e.target;
  if (t instanceof HTMLInputElement && t.type === 'checkbox' && t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
  const b = t.closest('button');
  if (b && el.dialog.contains(b)) act(b);
}

/** A box that acts the moment it changes: GitHub's "Let agents use this token". */
function onChange(e) {
  const box = e.target;
  if (box instanceof HTMLInputElement && box.dataset.field === 'gh-share' && el.dialog.contains(box)) shareGithub(box);
}

async function act(b) {
  if (b.getAttribute('aria-disabled') === 'true') return;
  if (b === el.close) { closeConnect(); return; }
  if (b === el.needs) { const id = b.dataset.agent; closeConnect({ toLid: true }); ctx.toLid?.(id); return; }
  const cn = b.dataset.cn;
  const agentId = b.dataset.agent || null, keyId = b.dataset.keyId || null;
  const s = st.status;
  switch (cn) {
    case 'retry': st.error = null; paint(); request(() => connectApi.status(), { quiet: true }); recheck(); return;
    case 'agent': {
      // the agent, the action and the facts the button was drawn for must still be what the panel knows
      const a = agentsOf(s).find(x => x.id === agentId);
      const action = b.dataset.action;
      if (!a || !a.actions.includes(action) || agentStamp(a) !== b.dataset.state) { changed(); return; }
      if (action === 'key') {
        st.open.keyFor = st.open.keyFor === a.id ? null : a.id;
        paint();
        if (st.open.keyFor) focusKey(`agentkey-in:${a.id}`);
        return;
      }
      if (action === 'recheck') { recheck({ said: true }); return; }
      if (action === 'default') { const r = await request(() => connectApi.setDefault(a.id), { busyKey: `agent:${a.id}:default` }); if (okAnswer(r)) recheck(); return; }
      // Sign in and Install open Terminal (macOS); elsewhere the answer carries the command to run
      const r = await request(() => (action === 'signin' ? connectApi.signin(a.id) : connectApi.install(a.id)), { busyKey: `agent:${a.id}:${action}` });
      if (r && typeof r.command === 'string' && r.command.trim()) { st.open.cmd = { ...st.open.cmd, [a.id]: r.command.trim() }; paint(); }
      return;
    }
    case 'keycancel': st.open.keyFor = null; paint(); focusKey(`agent:${agentId}:key`); return;
    case 'keysave': {
      const a = agentsOf(s).find(x => x.id === agentId);
      const input = partOf(`agentkey:${agentId}`)?.querySelector('[data-field="agent-key"]');
      if (!a || !a.actions.includes('key') || !input) { changed(); return; }
      const q = agentKeyRequest(input.value);
      if (q.error) { setSaid(q.error); input.focus({ preventScroll: true }); return; }
      input.value = '';   // sent: the field holds it no longer
      const r = await request(() => connectApi.key(a.id, q.value), { busyKey: `keysave:${a.id}` });
      if (okAnswer(r)) { if (st.open.keyFor === a.id) st.open.keyFor = null; paint(); focusKey(`agent:${a.id}:key`); recheck(); }
      return;
    }
    case 'copy': copyCommand(agentId); return;
    case 'git': {
      const part = partOf('git');
      const name = part?.querySelector('[data-field="git-name"]')?.value, email = part?.querySelector('[data-field="git-email"]')?.value;
      const q = gitRequest(name, email);
      if (q.error) { setSaid(q.error); return; }
      st.open.git = { name, email };   // as typed, until git has it
      const r = await request(() => connectApi.git(q.name, q.email), { busyKey: 'git' });
      if (okAnswer(r)) { st.open.git = null; paint(); }
      return;
    }
    case 'gh-connect': {
      const part = partOf('gh-off');
      const input = part?.querySelector('[data-field="gh-token"]');
      if (!input) { changed(); return; }
      const q = githubRequest(input.value);
      if (q.error) { setSaid(q.error); input.focus({ preventScroll: true }); return; }
      const agentsUseIt = part.querySelector('[data-field="gh-agents"]')?.checked === true;
      st.open.ghAgents = agentsUseIt;
      input.value = '';
      const r = await request(() => connectApi.github(q.token, agentsUseIt), { busyKey: 'gh-connect' });
      if (okAnswer(r)) { st.open.ghAgents = false; paint(); focusKey('gh-disconnect'); recheck(); }
      return;
    }
    case 'gh-disconnect': {
      if (!(s && s.github && s.github.connected === true)) { changed(); return; }
      const r = await request(() => connectApi.githubDisconnect(), { busyKey: 'gh-disconnect' });
      if (okAnswer(r)) recheck();
      return;
    }
    case 'key-remove': case 'key-remove-yes': case 'key-remove-no': {
      if (!keysOf(s).some(k => k.id === keyId)) { st.open.removing = null; changed(); return; }
      if (cn === 'key-remove') { st.open.removing = keyId; paint(); focusKey(`key-remove-no:${keyId}:Keep it`); return; }
      if (cn === 'key-remove-no') { st.open.removing = null; paint(); focusKey(`key-remove:${keyId}:Remove`); return; }
      const r = await request(() => connectApi.removeKey(keyId), { busyKey: `remove:${keyId}` });
      if (okAnswer(r)) { st.open.removing = null; paint(); if (!focusKey('add')) el.title.focus({ preventScroll: true }); recheck(); }
      return;
    }
    case 'add': st.open.add = { preset: null, rows: 1 }; paint(); focusKey(`preset:${presets()[0]?.id}`); return;
    case 'add-cancel': st.open.add = null; paint(); focusKey('add'); return;
    case 'preset': {
      if (!presets().some(p => p.id === b.dataset.preset)) { changed(); return; }
      st.open.add = { preset: b.dataset.preset, rows: 1 };
      paint();
      partOf('add')?.querySelector('.cn-fields input, .cn-rows input')?.focus({ preventScroll: true });
      return;
    }
    case 'add-row': addRow(); return;
    case 'add-save': saveKey(); return;
    default:
  }
}

/**
 * GitHub's "Let agents use this token (as GH_TOKEN)": sent the moment the box changes, checked first against what it was
 * drawn for. While it is on its way the box shows what was asked, and waits. When Workbench refuses (it cannot read the
 * token back from git) its sentence is said, and when the request fails its error is; either way the box goes back as
 * it was, and after a failure the panel reads what is connected again.
 */
async function shareGithub(box) {
  if (st.busy.has('gh-share')) { box.checked = !box.checked; return; }   // one change at a time
  const q = githubShareRequest(st.status, box.dataset.state, box.checked);
  if (!q) { box.checked = !box.checked; changed(); return; }
  st.open.ghShare = q.agentsUseIt;
  const r = await request(() => connectApi.githubAgents(q.agentsUseIt), { busyKey: 'gh-share' });
  st.open.ghShare = null;
  paint();
  // the part is drawn from what Workbench says now; the box itself says it too, whichever node the keyboard is on
  const now = partOf('gh-on')?.querySelector('[data-field="gh-share"]');
  if (now) now.checked = githubBoxOn(st.status && st.status.github);
  if (okAnswer(r)) recheck();
  else if (!r) request(() => connectApi.status(), { quiet: true });
}

/** One more name and value for "Something else", added in place so what is typed in the others stays. */
function addRow() {
  const add = st.open.add, part = partOf('add'), rows = part?.querySelector('.cn-rows');
  if (!add || !rows) return;
  const n = Math.min(MAX_NAMES, (add.rows || 1) + 1);
  if (n === add.rows) return;
  rows.insertAdjacentHTML('beforeend', customRow(n - 1));
  add.rows = n;
  // the part on the page is now the part drawn with one more row: keep it on the next paint
  const v = view();
  part._src = addForm(st.status, add, v, v.busy);
  if (n >= MAX_NAMES) part.querySelector('[data-cn="add-row"]')?.setAttribute('aria-disabled', 'true');
  rows.lastElementChild?.querySelector('input')?.focus({ preventScroll: true });
}

/** Save the key in the add form: its values are read, checked, cleared from their fields, and sent once. */
async function saveKey() {
  const part = partOf('add'), add = st.open.add;
  if (!part || !add || !add.preset) return;
  const fields = [...part.querySelectorAll('[data-var]')];
  const rows = [...part.querySelectorAll('.cn-crow')];
  const entries = fields.length
    ? fields.map(i => ({ name: i.dataset.var, value: i.value }))
    : rows.map(r => ({ name: r.querySelector('.cn-name')?.value, value: r.querySelector('.cn-value')?.value }));
  // the choices stay with the form while it saves (or if it is refused); the values do not
  Object.assign(add, {
    label: part.querySelector('[data-field="key-label"]')?.value ?? add.label,
    scope: part.querySelector('input[name="cn-scope"]:checked')?.value || 'all',
    given: part.querySelector('input[name="cn-given"]:checked')?.value || 'all',
    names: rows.map(r => r.querySelector('.cn-name')?.value || ''),
  });
  // the part on the page already shows these choices: keep it (and what is typed in it) on the next paint
  const v = view();
  part._src = addForm(st.status, add, v, v.busy);
  const q = newKeyRequest({ preset: add.preset, label: add.label, entries, scope: add.scope, given: add.given }, presets());
  entries.length = 0;
  if (q.error) { setSaid(q.error); return; }
  // sent: no field holds a value any more
  for (const i of part.querySelectorAll('[data-var], .cn-value')) i.value = '';
  const r = await request(() => connectApi.addKey(q.body), { busyKey: 'add-save' });
  if (okAnswer(r)) { st.open.add = null; paint(); focusKey('add'); recheck(); }
}

/** The command to run in a terminal (when Workbench cannot open Terminal): to the clipboard, else selected. */
async function copyCommand(agentId) {
  const cmd = st.open.cmd[agentId];
  if (!cmd) return;
  try {
    await navigator.clipboard.writeText(cmd);
    setSaid('Copied. Paste it in a terminal.');
  } catch {
    const code = partOf(`agentcmd:${agentId}`)?.querySelector('code');
    if (code) { const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    setSaid('The command is selected. Copy it, then paste it in a terminal.');
  }
}
