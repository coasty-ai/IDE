// Talking to the engine: the access key, JSON requests, and the live event stream.

let token = null;

/** Read the access key from ?t= once, then drop it from the address bar. Kept for this tab only. */
export function initToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    token = fromUrl;
    try { sessionStorage.setItem('wb-token', fromUrl); } catch {}
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } else {
    try { token = sessionStorage.getItem('wb-token'); } catch {}
  }
  return token;
}

export function hasToken() { return !!token; }

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || data.reply || `The workbench said no (${res.status}).`);
  return data;
}

export const api = {
  state: () => call('GET', '/api/state'),
  command: (text, focusId) => call('POST', '/api/command', { text, focusId: focusId || null }),
  confirm: (id, go) => call('POST', `/api/confirm/${encodeURIComponent(id)}`, { go }),
  answer: (agentId, askId, answer) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/answer`, { askId, answer }),
  say: (agentId, text) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/say`, { text }),
  stop: (agentId) => call('POST', `/api/agents/${encodeURIComponent(agentId)}/stop`, {}),
  awake: (machineId, awake) => call('POST', `/api/machines/${encodeURIComponent(machineId)}/awake`, { awake }),
};

/** Open the live stream. Handlers: snapshot, agents, machines, notice, open, error. */
export function connect(handlers) {
  const es = new EventSource('/api/stream?t=' + encodeURIComponent(token || ''));
  const on = (name, fn) => es.addEventListener(name, e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    fn(data);
  });
  on('snapshot', d => handlers.snapshot?.(d));
  on('agents', d => handlers.agents?.(Array.isArray(d) ? d : (d.agents || [])));
  on('machines', d => handlers.machines?.(Array.isArray(d) ? d : (d.machines || [])));
  on('notice', d => handlers.notice?.(d && d.text ? d.text : String(d || '')));
  es.onopen = () => handlers.open?.();
  es.onerror = () => handlers.error?.();
  return es;
}
