// What the connect panel ("Agents & keys") shows, from a ConnectStatus: its rows, words and buttons, as markup. Also the
// snapshot's meta.connect, the top band's light, how a key's values read (masked), what a new key sends, and the words
// the board says when a key is typed into it.
// Pure: no DOM, and nothing from /shared/. The key presets and the secret check are passed in, so node:test loads this.
//
// Everything the server or a person wrote (names, versions, sentences, labels, variable names, logins, commands) goes
// through visibleControls() and esc() before it is markup. A secret value never is: the panel shows only what the key
// store gave it ("•••• 7QXA"), a value the preset says is not secret, or "••••". Buttons carry what they were drawn for
// (data-agent, data-action, data-key-id, data-state); data-key is the focus key, as everywhere on the page.
import { esc } from './util.js';
import { visibleControls } from './words.js';

export const KEY_REFUSAL = 'That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe.';
export const KEYS_WARNING = 'Agents can read the keys you give them, and so can anything they run. Give them keys that can do only what their work needs.';
export const CHECKS_NOTE = 'Checks that Workbench runs on an agent’s work get the same keys as that agent.';
export const GITHUB_TOKEN_PAGE = 'https://github.com/settings/tokens/new?description=Workbench&scopes=repo';
export const MASK = '••••';
/** The most a key may hold: 20 names, and values of 2,000 characters. */
export const MAX_NAMES = 20, MAX_VALUE = 2000;

const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const ACTIONS = ['signin', 'install', 'key', 'default', 'recheck'];
export const ACTION_LABEL = { signin: 'Sign in', install: 'Install', key: 'Use an API key', default: 'Use for new work', recheck: 'Check again' };

const str = x => (typeof x === 'string' ? x : '');
/** Outside words as prose: line breaks, tabs and runs of spaces made one space, then every hidden character shown. */
const prose = s => visibleControls(str(s).split(/[\t\n\v\f\r ]+/).filter(Boolean).join(' '));
/** Outside words, shown and escaped for markup. */
const t = s => esc(prose(s));
const cut = (s, n) => { const a = Array.from(s); return a.length <= n ? s : a.slice(0, n - 1).join('') + '…'; };
const listOf = (items, last) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${last} ${items.at(-1)}`);
/** "Claude Code and Codex"; "A, B and C". */
export const listAnd = items => listOf(items, 'and');
/** "Claude Code or Codex". */
export const listOr = items => listOf(items, 'or');
const mark = (shape, tone) => `<svg class="g k-${tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${shape}"/></svg>`;
const attrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
/** A button in the panel: `d` becomes data-* (cn: what it does, agent, action, key-id, …); busy ones say so and wait. */
function btn(label, d, { pri = false, busy = false, extra = '' } = {}) {
  return `<button type="button" class="cn-btn${pri ? ' pri' : ''}"${attrs({ ...d, key: d.key || `${d.cn}:${d.agent || d['key-id'] || ''}:${d.action || label}` })}${busy ? ' aria-disabled="true"' : ''}${extra}>${esc(label)}</button>`;
}
/** Text fields never carry a name (nothing is ever sent by a form) and are never filled in by the browser. */
const FIELD = 'autocomplete="off" spellcheck="false" autocapitalize="off"';

// ---------------------------------------------------------------- the snapshot's meta.connect and the top band's light
/**
 * meta.connect from a snapshot: { ready, defaultAgent, agents: [{ id, name, ready }] }, or null when the snapshot has
 * none (the demo, an engine without Agents & keys). `ready` must be a boolean: nothing is guessed.
 */
export function connectMeta(snap) {
  const x = snap && typeof snap === 'object' ? (snap.connect ?? snap.meta?.connect) : null;
  return metaOf(x);
}
function metaOf(x) {
  if (!x || typeof x !== 'object' || typeof x.ready !== 'boolean') return null;
  const agents = (Array.isArray(x.agents) ? x.agents : []).filter(a => a && typeof a === 'object' && typeof a.id === 'string' && AGENT_ID.test(a.id))
    .map(a => ({ id: a.id, name: str(a.name) || a.id, ready: a.ready === true }));
  return { ready: x.ready, defaultAgent: typeof x.defaultAgent === 'string' && AGENT_ID.test(x.defaultAgent) ? x.defaultAgent : null, agents };
}
/** meta.connect as a fresh ConnectStatus tells it, so the light and the lid follow every answer the panel gets. */
export function metaFromStatus(status) {
  if (!status || !Array.isArray(status.agents)) return null;
  const agents = agentsOf(status);
  return metaOf({ ready: typeof status.ready === 'boolean' ? status.ready : agents.some(a => a.ready), defaultAgent: status.defaultAgent, agents });
}

/**
 * The "Agents & keys" button in the top band: lit and calm when an agent is ready for new work, lit "needs you" when
 * none is. Null when there is no meta.connect (then the band has no such button).
 */
export function bandView(m) {
  if (!m) return null;
  const def = m.agents.find(a => a.id === m.defaultAgent && a.ready) || m.agents.find(a => a.ready) || null;
  const said = m.ready
    ? (def ? `${prose(def.name)} is ready for new work.` : 'A coding agent is ready for new work.')
    : 'No coding agent is ready yet. Connect one here.';
  return { light: m.ready ? 'ok' : 'need', label: 'Agents & keys', short: 'Agents', said, aria: `Agents & keys: ${said}` };
}

/** The lid when no agent is ready (focus.js draws it): what to do, naming the agents Workbench drives. */
export function lidConnectWords(m) {
  const names = (m && Array.isArray(m.agents) ? m.agents : []).map(a => prose(a.name)).filter(Boolean);
  return {
    count: 'Before you start', sentence: 'Connect a coding agent to start.',
    sub: names.length ? `Sign in to ${listOr(names)}, or give one an API key.` : 'Sign in to a coding agent, or give one an API key.',
  };
}

// ---------------------------------------------------------------- the board's guard: keys never go through its input
/** The board's words when `text` looks like a key (it is not sent), else null. `looksLikeSecret` is the shared check. */
export function keyRefusal(text, looksLikeSecret) {
  if (typeof looksLikeSecret !== 'function') return null;
  try { return looksLikeSecret(String(text ?? ''))?.secret === true ? KEY_REFUSAL : null; } catch { return null; }
}

// ---------------------------------------------------------------- a ConnectStatus, cleaned field by field
/** The ConnectStatus in an answer ({ ok, sentence, status }, or the status itself), or null. */
export function statusOf(r) {
  const s = r && typeof r === 'object' && r.status && typeof r.status === 'object' ? r.status : r;
  return s && typeof s === 'object' && Array.isArray(s.agents) ? s : null;
}

/** The agents, as the panel draws them; rows whose id does not fit are dropped, and only known actions are kept. */
export function agentsOf(status) {
  const list = status && Array.isArray(status.agents) ? status.agents : [];
  return list.filter(a => a && typeof a === 'object' && typeof a.id === 'string' && AGENT_ID.test(a.id)).map(a => ({
    id: a.id, name: str(a.name) || a.id, found: a.found === true, version: str(a.version), from: str(a.from),
    signedIn: ['yes', 'no', 'unknown'].includes(a.signedIn) ? a.signedIn : 'unknown', how: str(a.how), ready: a.ready === true,
    isDefault: a.isDefault === true, sentence: str(a.sentence),
    actions: Array.isArray(a.actions) ? ACTIONS.filter(x => a.actions.includes(x)) : [],
  }));
}

/** One sentence for an agent: Workbench's own (the status's), else made from the facts. */
export function agentSentence(a) {
  if (a.sentence.trim()) return prose(a.sentence);
  const nm = prose(a.name), ver = a.version ? ` ${prose(a.version)}` : '';
  if (!a.found) return `${nm} is not installed.`;
  if (a.ready) return a.how ? `${nm}${ver} is ready, signed in with ${prose(a.how)}.` : `${nm}${ver} is ready.`;
  if (a.signedIn === 'no') return `${nm} is installed but not signed in.`;
  if (a.signedIn === 'unknown') return `${nm}${ver} is installed, but Workbench could not tell whether it is signed in.`;
  return `${nm}${ver} is installed, but it cannot start work yet.`;
}

/** Its light: ready (calm), installed but needing the person, or not installed. */
export function agentLight(a) {
  if (a.ready) return { tone: 'ok', shape: 'ok', words: 'ready' };
  if (a.found) return { tone: 'need', shape: 'need', words: 'needs you' };
  return { tone: 'word', shape: 'off', words: 'not installed' };
}

/** What "Use an API key" says about billing, for this agent. */
export function agentKeyNote(a) {
  const nm = prose(a.name);
  if (a.id === 'claude') return `${nm} will use this key instead of your Claude subscription, and each request is billed to the key.`;
  return `${nm} will use this key, and each request is billed to it.`;
}

/** A stamp of what an agent's buttons were drawn for: the page checks it before it sends, and the engine checks again. */
export const agentStamp = a => `${a.found ? 'found' : 'missing'}-${a.signedIn}-${a.ready ? 'ready' : 'waiting'}${a.isDefault ? '-default' : ''}`;

// ---------------------------------------------------------------- keys: masked as the store gave them
/** "•••• " and the last 4 characters of a value of 12 or more; "••••" for a shorter one. */
export function maskTail(value) {
  const a = Array.from(String(value ?? ''));
  return a.length >= 12 ? `${MASK} ${a.slice(-4).join('')}` : MASK;
}
/** True for "••••" and "•••• " followed by at most 4 characters: the only shape a secret may take on the page. */
export function isMasked(shown) {
  if (typeof shown !== 'string' || !shown.startsWith(MASK)) return false;
  const rest = shown.slice(MASK.length);
  if (rest === '') return true;
  const tail = Array.from(rest.slice(1));
  return rest[0] === ' ' && tail.length >= 1 && tail.length <= 4 && !tail.includes(' ');
}
/**
 * How one variable's value reads: masked as the store gave it; as it is, when the preset says it is not secret and it
 * does not look like a key; otherwise "••••". Nothing else is ever shown.
 */
export function shownValue(shown, secret, looksLikeSecret) {
  if (isMasked(shown)) return shown;
  const looks = typeof looksLikeSecret === 'function' ? (() => { try { return looksLikeSecret(shown)?.secret === true; } catch { return true; } })() : false;
  if (secret === false && typeof shown === 'string' && shown.trim() && !looks) return cut(prose(shown), 64);
  return MASK;
}

/** Whether a preset marks a variable secret (an `also` name follows its field); unknown names count as secret. */
function secretIn(preset, name) {
  for (const f of preset && Array.isArray(preset.fields) ? preset.fields : []) {
    if (f.name === name || (Array.isArray(f.also) && f.also.includes(name))) return f.secret !== false;
  }
  return true;
}
const presetOf = (presets, id) => (Array.isArray(presets) ? presets.find(p => p && p.id === id) : null) || null;

/** "for all repositories", "for this repository", "for the repository shop". */
export function scopeWords(scope, repoName) {
  if (scope && scope.kind === 'repo') {
    const base = str(scope.root).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (!base) return 'for one repository';
    return repoName && base === repoName ? 'for this repository' : `for the repository ${prose(base)}`;
  }
  if (scope && scope.kind === 'all') return 'for all repositories';
  return '';
}
/** "given to all agents", "given to Claude Code", "given to no agent" (a GitHub token git alone uses). */
export function givenWords(agents, names = new Map()) {
  if (agents === 'all') return 'given to all agents';
  if (!Array.isArray(agents)) return '';
  const ids = agents.filter(x => typeof x === 'string');
  return ids.length ? `given to ${listAnd(ids.map(id => prose(names.get(id) || id)))}` : 'given to no agent';
}

/** The keys in a status (an array, or an object holding one), as the panel lists them. */
export function keysOf(status, { presets = [], repoName = null, looksLikeSecret = null } = {}) {
  const k = status ? status.keys : null;
  const list = Array.isArray(k) ? k : k && typeof k === 'object' ? (k.list || k.entries || k.items || k.keys || []) : [];
  const names = new Map(agentsOf(status).map(a => [a.id, a.name]));
  return (Array.isArray(list) ? list : []).filter(x => x && typeof x === 'object').map(x => {
    const preset = presetOf(presets, x.preset);
    const vars = (Array.isArray(x.vars) ? x.vars : []).filter(v => v && typeof v.name === 'string' && VAR_NAME.test(v.name))
      .map(v => ({ name: v.name, shown: shownValue(v.shown, secretIn(preset, v.name), looksLikeSecret) }));
    const label = prose(x.label) || prose(preset && preset.label) || 'A key';
    const head = [label, scopeWords(x.scope, repoName)].filter(Boolean).join(' ');
    const given = givenWords(x.agents, names);
    const sentence = `${head}${given ? `, ${given}` : ''}${vars.length ? `: ${vars.map(v => `${v.name} ${v.shown}`).join(', ')}` : '.'}`;
    return { id: typeof x.id === 'string' && KEY_ID.test(x.id) ? x.id : null, label, vars, sentence };
  });
}

// ---------------------------------------------------------------- signing in with a key meant for work
/** signInVariables as a Map from a variable's name to its sentence (or null), whatever shape the shared module gives. */
export function signInNotes(x) {
  const out = new Map();
  const say = v => (typeof v === 'string' ? v : v && typeof v === 'object' ? str(v.sentence || v.note || v.why || v.say || v.what) : '') || null;
  const add = (name, v) => { if (typeof name === 'string' && VAR_NAME.test(name) && !out.get(name)) out.set(name, say(v)); };
  const each = list => { for (const v of list) { if (typeof v === 'string') add(v, null); else if (v && typeof v === 'object') add(v.name, v); } };
  if (x instanceof Map) for (const [k, v] of x) { if (Array.isArray(v)) each(v); else add(k, v); }
  else if (x instanceof Set || Array.isArray(x)) each(x);
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (Array.isArray(v)) each(v); else add(k, v); }
  return out;
}
/** What the panel says about a name an agent's own sign-in reads. */
export function signInWarning(name, notes) {
  if (!notes || !notes.has(name)) return null;
  return notes.get(name) || `Some agents sign in with ${name}, so an agent given it may use it instead of its own sign-in, and bill it.`;
}

// ---------------------------------------------------------------- what the panel sends (values only ever pass through)
const plainValue = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_VALUE && !/[\0\r\n]/.test(v);
const valueProblem = (v, what) => (typeof v !== 'string' || !v ? `Fill in ${what}.` : v.length > MAX_VALUE ? `${what[0].toUpperCase() + what.slice(1)} is longer than 2,000 characters, so Workbench cannot keep it.` : /[\0\r\n]/.test(v) ? `${what[0].toUpperCase() + what.slice(1)} has a line break in it. Paste it again as one line.` : null);

/** An agent's API key: { value } to send, or { error } in plain words. */
export function agentKeyRequest(value) {
  const v = String(value ?? '').trim();
  const problem = valueProblem(v, 'the key');
  return problem ? { error: problem } : { value: v };
}
/** Git's name and email: { name, email }, or { error }. Git and the engine check them again. */
export function gitRequest(name, email) {
  const n = String(name ?? '').trim(), e = String(email ?? '').trim();
  if (!n) return { error: 'Fill in your name.' };
  if (Array.from(n).length > 100 || /[\p{Cc}]/u.test(n)) return { error: 'That name is too long, or has characters git cannot keep. Use up to 100 ordinary characters.' };
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(e) || e.length > 254) return { error: 'That email address does not look right. It should be like you@example.com.' };
  return { name: n, email: e };
}
/** A GitHub token: { token }, or { error }. */
export function githubRequest(token) {
  const v = String(token ?? '').trim();
  const problem = valueProblem(v, 'the token');
  return problem ? { error: problem } : { token: v };
}

/**
 * A new key from the add form: { body } for POST /api/connect/keys ({ preset, label, values, scope, agents }), or
 * { error } in plain words. `entries` are [{ name, value }] as typed (a preset's fields, or the person's own names);
 * empty optional fields are left out; a field's `also` names get the same value.
 */
export function newKeyRequest({ preset, label, entries, scope, given }, presets = []) {
  const p = presetOf(presets, preset);
  if (!p) return { error: 'Choose what the key is for.' };
  const values = {};
  const custom = !Array.isArray(p.fields) || !p.fields.length;
  if (custom) {
    for (const e of entries || []) {
      const name = String(e?.name ?? '').trim(), value = String(e?.value ?? '').trim();
      if (!name && !value) continue;
      if (!name) return { error: 'Give each value a variable name.' };
      if (!VAR_NAME.test(name)) return { error: `${cut(prose(name), 40)} cannot be a variable name. Use letters, digits and _, and start with a letter or _.` };
      const problem = valueProblem(value, `the value of ${name}`);
      if (problem) return { error: problem };
      values[name] = value;
    }
    if (!Object.keys(values).length) return { error: 'Add at least one variable name and its value.' };
  } else {
    const typed = new Map((entries || []).map(e => [String(e?.name ?? ''), String(e?.value ?? '').trim()]));
    for (const f of p.fields) {
      const v = typed.get(f.name) || '';
      const what = prose(f.label || f.name);
      if (!v) { if (f.optional) continue; return { error: `Fill in ${what}.` }; }
      if (!plainValue(v)) return { error: valueProblem(v, what) };
      values[f.name] = v;
      for (const also of Array.isArray(f.also) ? f.also : []) if (VAR_NAME.test(also)) values[also] = v;
    }
  }
  if (Object.keys(values).length > MAX_NAMES) return { error: `A key holds at most ${MAX_NAMES} names.` };
  const name = String(label ?? '').trim() || (custom ? '' : str(p.label));
  if (!name) return { error: 'Name this key, so you know it in the list.' };
  if (Array.from(name).length > 80 || /[\p{Cc}]/u.test(name)) return { error: 'Use a shorter name for this key: up to 80 ordinary characters.' };
  const agents = given === 'all' || given == null ? 'all' : AGENT_ID.test(String(given)) ? [String(given)] : 'all';
  return { body: { preset: p.id, label: name, values, scope: scope === 'repo' ? 'repo' : 'all', agents } };
}

// ---------------------------------------------------------------- the panel's markup: one keyed child per part
/**
 * The panel's parts, in order, as [{ k, html }]: each html is one element carrying data-k="<k>", so the panel can keep
 * a part that did not change (and the field someone is typing in) and replace only the others.
 * @param {object|null} status  a ConnectStatus, or null while the first one is on its way
 * @param {object} v  { open: { keyFor, cmd: { [agentId]: command }, add: { preset, rows } | null, removing }, busy: Set,
 *   presets, signIn (Map from signInNotes), looksLikeSecret, repoName, error (a sentence), canRepo }
 */
export function panelParts(status, v = {}) {
  const open = v.open || {}, busy = v.busy || new Set();
  if (!status) {
    return v.error
      ? [{ k: 'error', html: `<div class="cn-part cn-err" data-k="error"><p class="cn-line">${t(v.error)}</p>${btn('Try again', { cn: 'retry' }, { pri: true, busy: busy.has('retry') })}</div>` }]
      : [{ k: 'loading', html: '<div class="cn-part" data-k="loading"><p class="cn-note">Looking for your coding agents…</p></div>' }];
  }
  const parts = [];
  const push = (k, html) => parts.push({ k, html });

  // Agents
  push('agents-h', '<h3 class="cn-h" data-k="agents-h">Agents</h3>');
  const agents = agentsOf(status);
  if (!agents.length) push('agents-none', '<div class="cn-part" data-k="agents-none"><p class="cn-note">Workbench did not report any coding agents.</p></div>');
  for (const a of agents) {
    const light = agentLight(a);
    const stamp = agentStamp(a);
    const firstWay = a.actions.find(x => x === 'signin' || x === 'install');
    const buttons = a.actions.map(x => {
      const extra = x === 'key' ? ` aria-expanded="${open.keyFor === a.id}"` : x === 'signin' || x === 'install'
        ? ` title="${esc(status.canOpenTerminal === false ? 'Shows the command to run in a terminal.' : 'Opens Terminal, where it runs.')}"` : '';
      return btn(ACTION_LABEL[x], { cn: 'agent', agent: a.id, action: x, state: stamp }, { pri: x === firstWay && !a.ready, busy: busy.has(`agent:${a.id}:${x}`), extra });
    }).join('');
    const sub = [a.found && a.from ? `Found in ${prose(a.from)}.` : ''].filter(Boolean).map(esc).join(' ');
    const def = a.isDefault ? `<span class="cn-def">${mark('work', 'work')}<span>Used for new work.</span></span>` : '';
    push(`agent:${a.id}`, `<div class="cn-part cn-agent" data-k="agent:${esc(a.id)}">`
      + `<span class="cn-light" role="img" aria-label="${esc(light.words)}">${mark(light.shape, light.tone)}</span>`
      + `<div class="cn-txt"><p class="cn-line">${esc(agentSentence(a))}</p>${sub || def ? `<p class="cn-sub">${sub}${sub && def ? ' ' : ''}${def}</p>` : ''}</div>`
      + `${buttons ? `<div class="cn-acts">${buttons}</div>` : ''}</div>`);
    if (open.keyFor === a.id && a.actions.includes('key')) {
      push(`agentkey:${a.id}`, `<div class="cn-part cn-form" data-k="agentkey:${esc(a.id)}" data-enter="keysave" data-agent="${esc(a.id)}" role="group" aria-label="${esc(`An API key for ${prose(a.name)}`)}">`
        + `<p class="cn-note">${esc(agentKeyNote(a))}</p><div class="cn-inrow">`
        + `<input type="password" class="cn-in" ${FIELD} data-field="agent-key" data-key="agentkey-in:${esc(a.id)}" aria-label="${esc(`API key for ${prose(a.name)}`)}" placeholder="Paste the key here">`
        + btn('Save key', { cn: 'keysave', agent: a.id }, { pri: true, busy: busy.has(`keysave:${a.id}`) }) + btn('Cancel', { cn: 'keycancel', agent: a.id })
        + '</div></div>');
    }
    const cmd = open.cmd && typeof open.cmd[a.id] === 'string' ? open.cmd[a.id] : '';
    if (cmd) {
      push(`agentcmd:${a.id}`, `<div class="cn-part cn-form" data-k="agentcmd:${esc(a.id)}">`
        + '<p class="cn-note">Run this in a terminal, then come back and press Check again.</p>'
        + `<div class="cn-inrow"><code class="cn-cmd" tabindex="0" data-scroll="1">${esc(visibleControls(cmd))}</code>${btn('Copy', { cn: 'copy', agent: a.id })}</div></div>`);
    }
  }

  // Git and GitHub
  push('git-h', '<h3 class="cn-h" data-k="git-h">Git and GitHub</h3>');
  const g = status.git && typeof status.git === 'object' ? status.git : {};
  const gName = str(g.name), gEmail = str(g.email);
  const gSaid = str(g.sentence).trim() ? prose(g.sentence) : gName && gEmail ? `Git knows you as ${prose(gName)}, ${prose(gEmail)}.` : 'Git does not know your name and email yet.';
  // what the person typed stays while it is being saved (or was refused); otherwise what git has
  const typed = open.git && typeof open.git === 'object' ? open.git : null;
  push('git', `<div class="cn-part cn-form" data-k="git" data-enter="git" role="group" aria-label="Your name and email for git">`
    + `<p class="cn-line">${esc(gSaid)} Merging needs these.</p><div class="cn-inrow cn-wrap">`
    + `<label class="cn-f"><span>Name</span><input type="text" class="cn-in" ${FIELD} data-field="git-name" data-key="git-name" value="${esc(typed ? str(typed.name) : gName)}"></label>`
    + `<label class="cn-f"><span>Email</span><input type="email" class="cn-in" ${FIELD} data-field="git-email" data-key="git-email" value="${esc(typed ? str(typed.email) : gEmail)}"></label>`
    + btn('Save', { cn: 'git', key: 'git-save' }, { busy: busy.has('git') }) + '</div></div>');
  const gh = status.github && typeof status.github === 'object' ? status.github : {};
  if (gh.connected === true) {
    const login = prose(gh.login);
    const said = str(gh.sentence).trim() ? prose(gh.sentence) : login ? `Connected to GitHub as ${login}.` : 'Connected to GitHub.';
    const who = gh.agentsUseIt === true
      ? 'Agents get this token as GH_TOKEN. Copilot may sign in with it.'
      : 'Only git uses this token: agents do not get it. To give it to them, disconnect, then connect again with “Let agents use this token” ticked.';
    push('gh-on', `<div class="cn-part cn-gh" data-k="gh-on"><h4 class="cn-h4">GitHub</h4><p class="cn-line">${esc(said)}</p><p class="cn-sub">${esc(who)}</p>`
      + `<div class="cn-acts">${btn('Disconnect', { cn: 'gh-disconnect', key: 'gh-disconnect' }, { busy: busy.has('gh-disconnect') })}</div></div>`);
  } else {
    const said = str(gh.sentence).trim() && gh.connected === false ? prose(gh.sentence) : 'Not connected.';
    push('gh-off', `<div class="cn-part cn-gh cn-form" data-k="gh-off" data-enter="gh-connect" role="group" aria-label="Connect GitHub">`
      + `<h4 class="cn-h4">GitHub</h4><p class="cn-line">${esc(said)}</p><div class="cn-inrow">`
      + `<input type="password" class="cn-in" ${FIELD} data-field="gh-token" data-key="gh-token" aria-label="GitHub token" placeholder="Paste a GitHub token here">`
      + btn('Connect', { cn: 'gh-connect', key: 'gh-connect' }, { pri: true, busy: busy.has('gh-connect') }) + '</div>'
      + `<label class="cn-check"><input type="checkbox" data-field="gh-agents" data-key="gh-agents"${open.ghAgents === true ? ' checked' : ''}><span>Let agents use this token (as GH_TOKEN)</span></label>`
      + '<p class="cn-sub cn-under">Copilot may sign in with it.</p>'
      + `<p class="cn-sub"><a class="cn-link" href="${esc(GITHUB_TOKEN_PAGE)}" target="_blank" rel="noopener noreferrer">Create a token</a> on GitHub, then paste it here. Git uses it to clone and fetch your repositories.</p></div>`);
  }

  // Keys for your agents
  push('keys-h', '<h3 class="cn-h" data-k="keys-h">Keys for your agents</h3>');
  push('keys-warn', `<div class="cn-part" data-k="keys-warn"><p class="cn-warn">${mark('need', 'need')}<span>${esc(KEYS_WARNING)}</span></p><p class="cn-sub">${esc(CHECKS_NOTE)}</p></div>`);
  const keys = keysOf(status, { presets: v.presets, repoName: v.repoName, looksLikeSecret: v.looksLikeSecret });
  if (!keys.length) push('keys-none', '<div class="cn-part" data-k="keys-none"><p class="cn-note">No keys yet.</p></div>');
  keys.forEach((k, i) => {
    const kk = `key:${k.id || 'n' + i}`;
    if (k.id && open.removing === k.id) {
      push(kk, `<div class="cn-part cn-key" data-k="${esc(kk)}"><p class="cn-line">${esc(`Remove ${k.label}? Agents started from now on will not get it.`)}</p><div class="cn-acts">`
        + btn('Remove it', { cn: 'key-remove-yes', 'key-id': k.id }, { busy: busy.has(`remove:${k.id}`) }) + btn('Keep it', { cn: 'key-remove-no', 'key-id': k.id }) + '</div></div>');
    } else {
      push(kk, `<div class="cn-part cn-key" data-k="${esc(kk)}"><p class="cn-line">${esc(k.sentence)}</p>`
        + (k.id ? `<div class="cn-acts">${btn('Remove', { cn: 'key-remove', 'key-id': k.id }, { extra: ` aria-label="${esc(`Remove ${k.label}`)}"` })}</div>` : '') + '</div>');
    }
  });
  if (open.add) push('add', addForm(status, open.add, v, busy));
  else push('add', `<div class="cn-part" data-k="add">${btn('Add a key', { cn: 'add', key: 'add' }, { extra: ' aria-expanded="false"' })}</div>`);
  return parts;
}

/** One row of the person's own names and values (the "Something else" preset); a name typed before is kept, never a value. */
export function customRow(i, name = '') {
  return `<div class="cn-crow" data-row="${i}"><input type="text" class="cn-in cn-name" ${FIELD} data-key="cname:${i}" aria-label="Variable name ${i + 1}" placeholder="VARIABLE_NAME" value="${esc(str(name))}">`
    + `<input type="password" class="cn-in cn-value" ${FIELD} data-key="cvalue:${i}" aria-label="Value ${i + 1}" placeholder="its value"></div>`;
}

/**
 * The add form: presets first, then that preset's fields, its name, where it applies and who gets it. `add` is
 * { preset, rows, label?, scope?, given?, names? }: the choices the person made (kept while a save is on its way or
 * was refused), never a value.
 */
export function addForm(status, add, v = {}, busy = new Set()) {
  const presets = (Array.isArray(v.presets) ? v.presets : []).filter(p => p && typeof p.id === 'string' && AGENT_ID.test(p.id));
  const p = presets.find(x => x.id === add.preset) || null;
  const pills = presets.map(x => `<button type="button" class="cn-pill" data-cn="preset" data-preset="${esc(x.id)}" data-key="preset:${esc(x.id)}" aria-pressed="${x === p}">${t(x.label || x.id)}</button>`).join('');
  let body = '';
  if (p) {
    const custom = !Array.isArray(p.fields) || !p.fields.length;
    const notes = v.signIn instanceof Map ? v.signIn : new Map();
    const warn = [];
    if (custom) {
      const rows = Math.max(1, Math.min(MAX_NAMES, Number(add.rows) || 1));
      const names = Array.isArray(add.names) ? add.names : [];
      body += `<div class="cn-rows">${Array.from({ length: rows }, (_, i) => customRow(i, names[i])).join('')}</div>`;
      body += `<div class="cn-acts">${btn('Add another', { cn: 'add-row', key: 'add-row' }, { busy: rows >= MAX_NAMES })}</div>`;
    } else {
      body += '<div class="cn-fields">' + p.fields.filter(f => f && typeof f.name === 'string' && VAR_NAME.test(f.name)).map(f => {
        const also = (Array.isArray(f.also) ? f.also : []).filter(n => VAR_NAME.test(n));
        for (const n of [f.name, ...also]) { const w = signInWarning(n, notes); if (w && !warn.includes(w)) warn.push(w); }
        const what = prose(f.label || f.name);
        return `<label class="cn-f"><span>${esc(what)}${f.optional ? ' <em>(optional)</em>' : ''} <code>${esc(f.name)}</code>${also.length ? ` <em>${esc(`also as ${also.join(', ')}`)}</em>` : ''}</span>`
          + `<input type="${f.secret === false ? 'text' : 'password'}" class="cn-in" ${FIELD} data-var="${esc(f.name)}" data-key="var:${esc(f.name)}" aria-label="${esc(`${what}, ${f.name}${f.optional ? ', optional' : ''}`)}"></label>`;
      }).join('') + '</div>';
    }
    const agents = agentsOf(status);
    const suits = typeof add.given === 'string' && (add.given === 'all' || agents.some(a => a.id === add.given)) ? add.given
      : Array.isArray(p.agents) && p.agents.length === 1 && agents.some(a => a.id === p.agents[0]) ? p.agents[0] : 'all';
    const repo = v.canRepo && add.scope === 'repo';
    const label = typeof add.label === 'string' ? add.label : custom ? '' : prose(p.label);
    const radio = (group, value, text, on) => `<label class="cn-radio"><input type="radio" name="cn-${group}" value="${esc(value)}" data-${group}="${esc(value)}" data-key="${group}:${esc(value)}"${on ? ' checked' : ''}><span>${esc(text)}</span></label>`;
    body += `<label class="cn-f cn-label"><span>Name it</span><input type="text" class="cn-in" ${FIELD} data-field="key-label" data-key="key-label" value="${esc(label)}" placeholder="${custom ? 'for example Sentry' : ''}"></label>`;
    body += `<fieldset class="cn-radios"><legend>For</legend>${v.canRepo ? radio('scope', 'repo', 'this repository', repo) : ''}${radio('scope', 'all', 'all repositories', !repo)}</fieldset>`;
    body += `<fieldset class="cn-radios"><legend>Given to</legend>${radio('given', 'all', 'all agents', suits === 'all')}${agents.map(a => radio('given', a.id, prose(a.name), suits === a.id)).join('')}</fieldset>`;
    const notes2 = [str(p.note).trim() ? prose(p.note) : '', ...warn.map(prose)].filter(Boolean);
    body += notes2.map(n => `<p class="cn-sub">${esc(n)}</p>`).join('');
    if (/^https:\/\/[^\s"<>]+$/.test(str(p.link))) body += `<p class="cn-sub"><a class="cn-link" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">${esc(`Where to make a ${prose(p.label)} key`)}</a></p>`;
    body += `<div class="cn-acts">${btn('Save', { cn: 'add-save', key: 'add-save' }, { pri: true, busy: busy.has('add-save') })}${btn('Cancel', { cn: 'add-cancel', key: 'add-cancel' })}</div>`;
  } else {
    body += `<div class="cn-acts">${btn('Cancel', { cn: 'add-cancel', key: 'add-cancel' })}</div>`;
  }
  return `<div class="cn-part cn-form cn-add" data-k="add" data-enter="add-save" role="group" aria-label="Add a key">`
    + `<p class="cn-line">What is the key for?</p><div class="cn-presets">${pills}</div>${body}</div>`;
}
