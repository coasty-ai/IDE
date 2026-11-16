// Talking to the engine: the access key, JSON requests (the connect panel's too), and the live event stream.
// Nothing here touches the page when the module loads, so node:test can import it.
import { plainError } from './link.js';

let token = null;
let onRefused = null;

/** Read the access key from ?t= once, then drop it from the address bar. Kept for this tab only. */
export function initToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    token = fromUrl;
    try { sessionStorage.setItem('wb-token', fromUrl); } catch { /* private mode: this load only */ }
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } else {
    try { token = sessionStorage.getItem('wb-token'); } catch { token = null; }
  }
  return token;
}

export function hasToken() { return !!token; }

/** Called once when Workbench refuses this page's key (401) on any request. */
export function whenRefused(fn) { onRefused = fn; }

/** An error with the HTTP status, worded for the person. */
class RequestError extends Error {
  constructor(status, said) { super(plainError(status, said)); this.status = status; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(null);
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401) { onRefused?.(); throw new RequestError(401); }
  if (!res.ok) throw new RequestError(res.status, data.error || data.reply);
  // The engine refuses some answers with 200 and { ok: false }: that is a failure the person must see.
  if (data && data.ok === false) { const e = new Error(data.reply || data.error || 'That did not go through.'); e.refused = true; throw e; }
  return data;
}

export const api = {
  state: () => call('GET', '/api/state'),
  /**
   * What the person typed or said. focusId: what the core showed; confirmId: the launch question on screen, if any;
   * askId: the ask on screen when they started typing or talking, so the engine applies the words only to that ask.
   */
  command: (text, { focusId = null, confirmId = null, askId = null } = {}) =>
    call('POST', '/api/command', { text, focusId: focusId || null, confirmId: confirmId || null, askId: askId || null }),
  confirm: (id, go) => call('POST', `/api/confirm/${encodeURIComponent(id)}`, { go: go === true }),
  /** An answer names the ask it is for; only "Looks good" on finished work goes without one (it has no ask). */
  answer: (agentId, askId, answer) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/answer`, askId ? { askId, answer } : { answer }),
  say: (agentId, text) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/say`, { text }),
  stop: (agentId) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/stop`, {}),
  /** One more spending limit for this run, for an agent at its own; `state` is the state the button was drawn in. */
  raiseLimit: (agentId, { state = null } = {}) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/raise-limit`, { state: state || null }),
  awake: (machineId, awake) => call('POST', `/api/machines/${encodeURIComponent(machineId)}/awake`, { awake }),
  /**
   * Keep a choice for the next time Workbench starts: { theme }, { detail } or { answered: true }. Workbench keeps
   * them, not the page; when it could not save one, the answer is a refusal ({ ok: false, reply }) in plain words.
   */
  prefs: change => call('POST', '/api/prefs', change),
  /**
   * Full permissions: 'full' answers with the engine's card ({ reply, confirm }), which only its yes turns on; 'ask' turns
   * them off at once ({ ok, reply, permissions }).
   */
  permissions: mode => call('POST', '/api/permissions', { mode }),
  /**
   * Merge or throw away an agent's work. Neither acts by itself: the engine answers with a card ({ reply, confirm }) the
   * person answers by id. `state` is the state the button was drawn in; the engine refuses when it has changed.
   */
  merge: (agentId, { state = null } = {}) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/merge`, { state: state || null }),
  discard: (agentId, { state = null } = {}) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/discard`, { state: state || null }),
  /** Read-only, for the git screen: the commit graph, and one agent's diff. */
  git: () => call('GET', '/api/git'),
  changes: (agentId) => call('GET', `/api/agents/${encodeURIComponent(agentId)}/changes`),
  /**
   * The file view. `where` is 'you' (your folder) or an agent's id (its copy). Each answers what the engine says, read by
   * filesCall: the answer itself, or a refusal as data ({ ok: false, reply, why, hash? }), never thrown.
   * - files(where): { ok, in, name, branch, files: [{ path, changedBy?, ignored? }], truncated? }
   * - file(where, path, { check }): the file ({ ok, in, path, kind, text?, hash, size, lines?, link?, eol, bom,
   *   changedLines?, editable, why? }), or { ok: true, same: true } while it still has the hash `check` names
   * - search(where, words): { ok, in, results: [{ path, line, text }], truncated? }
   * - saveFile(where, path, { text, hash, force }): { ok, hash, size, reply? }; a file that changed on disk is
   *   { ok: false, why: 'changed', hash } (its hash now), which a save with force and that hash goes past
   */
  files: where => filesCall('GET', `/api/files?${query({ in: where })}`),
  file: (where, path, { check = null } = {}) => filesCall('GET', `/api/file?${query({ in: where, path, check })}`),
  search: (where, words) => filesCall('GET', `/api/search?${query({ in: where, q: words })}`),
  saveFile: (where, path, { text, hash, force = false }) => filesCall('POST', '/api/file', { in: where, path, text, hash, ...(force === true ? { force: true } : {}) }),
};

/** An address's query from its fields; a field that is null or empty is left out. */
const query = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

/**
 * The file view's requests. The engine refuses with { ok: false, reply, why } and a 4xx code (404 for a copy that is not
 * there, 409 for a file that changed on disk, with its hash now, 400 otherwise, 413 for too much text): that comes back
 * as data, its reply word for word (a path may hold any word, "token" included), so the sheet can say it and act on
 * `why`. A 401 means this page's key no longer works, and no answer at all, or anything else, is an Error in plain words.
 */
async function filesCall(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(null);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) { onRefused?.(); throw new RequestError(401); }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  if (obj && obj.ok === false && typeof obj.reply === 'string') {
    const out = { ok: false, reply: obj.reply, why: obj.why === 'changed' || obj.why === 'gone' ? obj.why : 'refused', status: res.status };
    if (typeof obj.hash === 'string') out.hash = obj.hash;
    return out;
  }
  if (res.ok && obj) return obj;
  throw new RequestError(res.status, obj && typeof obj.error === 'string' ? obj.error : undefined);
}

/**
 * The connect panel's requests ("Agents & keys"). Each answers { ok, sentence, status }: a refusal (ok: false) comes back
 * as it is, so the panel says its sentence and draws its status (when it carries one). A failure is an Error in plain
 * words, with the HTTP status in `.status`: Workbench's own sentence ({ error }) is kept even when it says "token", since
 * a GitHub token is the person's word for it here; a 401 still means this page's key no longer works. Keys and tokens
 * travel only in a POST's body, never in an address, and nothing here keeps or logs them.
 */
async function connectCall(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(null);
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401) { onRefused?.(); throw new RequestError(401); }
  if (!res.ok) {
    const said = data && typeof data.error === 'string' ? data.error.trim() : data && typeof data.sentence === 'string' ? data.sentence.trim() : '';
    const e = new Error(said && !/fetch/i.test(said) ? said
      : res.status === 404 ? 'Agents & keys is not available in this Workbench.'
        : res.status >= 500 ? 'Something went wrong in Workbench. Try again.' : `Workbench said no (${res.status}).`);
    e.status = res.status;
    throw e;
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

const agentPath = (id, what) => `/api/connect/agents/${encodeURIComponent(id)}/${what}`;
export const connectApi = {
  status: () => connectCall('GET', '/api/connect'),
  recheck: () => connectCall('POST', '/api/connect/recheck', {}),
  install: id => connectCall('POST', agentPath(id, 'install'), {}),
  /**
   * An agent's own login. With nothing, it runs in the background and opens the person's browser (the answer's status
   * has that agent's `signingIn`); `{ console: true }` is Claude Code's Anthropic Console account; `{ terminal: true }`
   * opens Terminal on it instead (the answer may carry the `command` to run where Terminal cannot open). Only the flags
   * that are true are sent.
   */
  signin: (id, { console: viaConsole = false, terminal = false } = {}) =>
    connectCall('POST', agentPath(id, 'signin'), { ...(viaConsole === true ? { console: true } : {}), ...(terminal === true ? { terminal: true } : {}) }),
  /** Stop an agent's sign-in in the browser. */
  cancelSignin: id => connectCall('POST', agentPath(id, 'signin/cancel'), {}),
  key: (id, value) => connectCall('POST', agentPath(id, 'key'), { value }),
  setDefault: id => connectCall('POST', agentPath(id, 'default'), {}),
  git: (name, email) => connectCall('POST', '/api/connect/git', { name, email }),
  /** Install git (on a Mac, Apple's own installer for its developer tools opens). */
  gitInstall: () => connectCall('POST', '/api/connect/git/install', {}),
  /**
   * Sign in to GitHub through GitHub's own command-line tool, which Workbench gets first when it is missing. It answers
   * at once; the status's `github.signingIn` then says how far it is (where Terminal could not open, `opened: false` and
   * the `command` to run), and the panel reads it again every 2 seconds until it ends. With gh signed in already but git
   * not using it, Workbench only makes git use it, and answers when that is done.
   */
  githubSignIn: () => connectCall('POST', '/api/connect/github/signin', {}),
  githubSignInCancel: () => connectCall('POST', '/api/connect/github/signin/cancel', {}),
  /** Sign out of GitHub: the answer says whether Terminal opened (`opened`), and gives the `command` to run when gh could not sign out by itself and Terminal could not open. */
  githubSignOut: () => connectCall('POST', '/api/connect/github/signout', {}),
  github: (githubToken, agentsUseIt) => connectCall('POST', '/api/connect/github', { token: githubToken, agentsUseIt: agentsUseIt === true }),
  /**
   * "Let agents use this token (as GH_TOKEN)", once GitHub is connected: Workbench gives the token it keeps to every
   * agent, or to none, without asking for it again. A refusal ({ ok: false, why: 'token', sentence }) comes back as it
   * is; 409 when GitHub is not connected.
   */
  githubAgents: agentsUseIt => connectCall('POST', '/api/connect/github/agents', { agentsUseIt: agentsUseIt === true }),
  githubDisconnect: () => connectCall('POST', '/api/connect/github/disconnect', {}),
  addKey: ({ preset, label, values, scope, agents }) => connectCall('POST', '/api/connect/keys', { preset, label, values, scope, agents }),
  removeKey: id => connectCall('POST', `/api/connect/keys/${encodeURIComponent(id)}/remove`, {}),
};

/**
 * Open the live stream. Handlers: snapshot, agents, machines, notice, repo (the person's repository changed: a merge, a
 * refresh; { name, branch, head, dirty, identity }), state(stream) with stream one of 'open' | 'connecting' | 'closed',
 * and refused() when Workbench turns the key away. After the browser gives up on a stream (closed), the page asks
 * /api/state once: a 401 means the key is stale; anything else, try again in 2 s.
 */
export function connect(handlers) {
  let es = null, retry = null, stopped = false;
  const open = () => {
    if (stopped) return;
    es = new EventSource('/api/stream?t=' + encodeURIComponent(token || ''));
    const on = (name, fn) => es.addEventListener(name, e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      fn(data);
    });
    on('snapshot', d => handlers.snapshot?.(d));
    on('agents', d => handlers.agents?.(Array.isArray(d) ? d : (d.agents || [])));
    on('machines', d => handlers.machines?.(Array.isArray(d) ? d : (d.machines || [])));
    on('notice', d => handlers.notice?.(d && d.text ? d.text : String(d || '')));
    on('repo', d => { const r = d && typeof d === 'object' && d.repo && typeof d.repo === 'object' ? d.repo : d; if (r && typeof r === 'object') handlers.repo?.(r); });
    es.onopen = () => handlers.state?.('open');
    es.onerror = async () => {
      if (es.readyState !== EventSource.CLOSED) { handlers.state?.('connecting'); return; }
      handlers.state?.('closed');
      let status = null;
      try { status = (await fetch('/api/state', { headers: { 'X-Workbench-Token': token || '' } })).status; } catch { status = null; }
      if (status === 401) { handlers.refused?.(); return; }
      clearTimeout(retry);
      retry = setTimeout(open, 2000);
    };
  };
  open();
  // A page kept in the back/forward cache must not keep its stream open: the browser allows only a few connections to
  // one address, and the page's own requests would queue behind streams nobody sees. Close on pagehide; a page that
  // comes back reconnects and gets a fresh snapshot.
  addEventListener('pagehide', () => { clearTimeout(retry); es?.close(); es = null; });
  addEventListener('pageshow', e => { if (e.persisted && !stopped) { handlers.state?.('connecting'); open(); } });
  return { close() { stopped = true; clearTimeout(retry); es?.close(); } };
}
