// Talking to the engine: the access key, JSON requests, and the live event stream.
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
  awake: (machineId, awake) => call('POST', `/api/machines/${encodeURIComponent(machineId)}/awake`, { awake }),
  /**
   * Merge or throw away an agent's work. Neither acts by itself: the engine answers with a card ({ reply, confirm }) the
   * person answers by id. `state` is the state the button was drawn in; the engine refuses when it has changed.
   */
  merge: (agentId, { state = null } = {}) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/merge`, { state: state || null }),
  discard: (agentId, { state = null } = {}) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/discard`, { state: state || null }),
  /** Read-only, for the git screen: the commit graph, and one agent's diff. */
  git: () => call('GET', '/api/git'),
  changes: (agentId) => call('GET', `/api/agents/${encodeURIComponent(agentId)}/changes`),
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
