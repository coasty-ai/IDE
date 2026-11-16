// Usage: node bin/workbench.mjs --demo --no-open --port 0 > demo.log &   then   node scripts/demo-e2e.mjs demo.log
// Walks the demo engine through its HTTP API and prints what came back. Not part of npm test.
import fs from 'node:fs';
const log = fs.readFileSync(process.argv[2], 'utf8');
const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/);
const port = m[1], T = m[2], B = `http://127.0.0.1:${port}`;
const H = { 'X-Workbench-Token': T, 'Content-Type': 'application/json' };
const post = async (p, body, extra = {}) => { const r = await fetch(B + p, { method: 'POST', headers: { ...H, ...extra }, body: JSON.stringify(body ?? {}) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const get = async p => { const r = await fetch(B + p, { headers: H }); return { s: r.status, j: await r.json() }; };
const out = (k, v) => console.log(k.padEnd(34), typeof v === 'string' ? v : JSON.stringify(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// state
const st = (await get('/api/state')).j;
out('state keys', Object.keys(st));
out('agents', st.agents.length + ' (' + st.agents.filter(a => !a.parentId).length + ' roots)');
out('roots', st.agents.filter(a => !a.parentId).map(a => `${a.name}:${a.state}`));
out('machines', st.machines.map(x => `${x.id}:${x.awake ? 'awake' : 'asleep'}`));
out('mode/repo/spend', [st.mode, st.repo, st.spendTodayUsd, st.defaultBudgetUsd, st.harnesses]);

// SSE
const ctrl = new AbortController();
const events = [];
(async () => {
  const r = await fetch(B + '/api/stream?t=' + T, { signal: ctrl.signal });
  out('sse status/type', [r.status, r.headers.get('content-type')]);
  const dec = new TextDecoder(); let buf = '';
  try { for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(blk)?.[1] || (blk.startsWith(':') ? 'comment' : '?'); const data = /^data: (.*)$/m.exec(blk)?.[1]; events.push({ t: Date.now(), ev, data: data ? JSON.parse(data) : null }); } } } catch {}
})();
await sleep(3500);
out('sse first events', events.slice(0, 4).map(e => e.ev));
out('sse counts', events.reduce((a, e) => (a[e.ev] = (a[e.ev] || 0) + 1, a), {}));
const ag = events.filter(e => e.ev === 'agents');
if (ag.length > 1) out('agents gap ms (coalesce)', ag.slice(1, 6).map((e, i) => e.t - ag[i].t));
out('sample agents ev', ag[0] && ag[0].data.length + ' views');

// command -> the agent starts at once (work is never asked first: no card)
let r = await post('/api/command', { text: 'start an agent to fix the login redirect' });
out('command start', [r.s, r.j && r.j.reply, r.j && r.j.confirm, r.j && r.j.agentIds]);
const newIds = r.j.agentIds || [];

// answer each demo ask
await sleep(500);
let cur = (await get('/api/state')).j;
const asks = cur.agents.filter(a => a.ask);
out('asks', asks.map(a => `${a.id} ${a.state} ${a.ask.type}: ${a.ask.sentence.slice(0, 50)} opts=${JSON.stringify(a.ask.options)}`));
for (const a of asks) {
  const ans = a.ask.type === 'permission' ? 'Allow' : a.ask.type === 'stuck' ? 'Let it keep trying' : 'Yes, keep the old route';
  const rr = await post(`/api/agents/${a.id}/answer`, { askId: a.ask.id, answer: ans });
  out('answer ' + a.name, [rr.s, rr.j]);
}
await sleep(1500);
cur = (await get('/api/state')).j;
out('after answers', cur.agents.filter(a => !a.parentId).map(a => `${a.name}:${a.state}`));

// stale askId
const rs = await post(`/api/agents/${asks[0].id}/answer`, { askId: 'nope', answer: 'Allow' });
out('stale ask', [rs.s, rs.j]);
// say / stop
const doneAg = cur.agents.find(a => !a.parentId && a.state.startsWith('done'));
out('say', await post(`/api/agents/${doneAg.id}/say`, { text: 'Looks good' }));
const w = cur.agents.find(a => !a.parentId && a.state === 'working');
out('stop', w && await post(`/api/agents/${w.id}/stop`, {}));

// machines
out('sleep cloud-2?', cur.machines.map(m => `${m.id}:${m.awake}`));
out('wake c2', await post('/api/machines/cloud-2/awake', { awake: true }));
out('sleep c1', await post('/api/machines/cloud-1/awake', { awake: false }));
out('bad machine', await post('/api/machines/nope/awake', { awake: true }));
await sleep(600);
out('machine events', events.filter(e => e.ev === 'machines').slice(-2).map(e => e.data.map(m => `${m.id}:${m.awake}`)));
out('cmd sleep idle', (await post('/api/command', { text: 'sleep idle machines' })).j);
out('cmd status', (await post('/api/command', { text: 'what needs me' })).j);
out('cmd spend', (await post('/api/command', { text: 'how much have I spent today' })).j);
out('cmd prompt (any words)', (await post('/api/command', { text: 'blorp' })).j);
out('cmd thanks', (await post('/api/command', { text: 'thanks' })).j);

// safety
const raw = (path, o = {}) => fetch(B + path, o).then(r => r.status);
out('no token GET', await raw('/api/state'));
out('bad token GET', await raw('/api/state', { headers: { 'X-Workbench-Token': 'x'.repeat(64) } }));
out('query token GET', await raw('/api/state?t=' + T));
out('query token POST', await raw('/api/command?t=' + T, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"status"}' }));
out('POST no token', await raw('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"status"}' }));
// wrong Host needs raw http
import http from 'node:http';
const rawReq = (opts, body) => new Promise(res => { const q = http.request({ host: '127.0.0.1', port, ...opts }, r => { r.resume(); res(r.statusCode); }); q.on('error', e => res('err ' + e.code)); q.end(body); });
out('wrong Host', await rawReq({ path: '/api/state', headers: { Host: 'evil.com', 'X-Workbench-Token': T } }));
out('wrong Host port', await rawReq({ path: '/api/state', headers: { Host: '127.0.0.1:1', 'X-Workbench-Token': T } }));
out('localhost Host ok', await rawReq({ path: '/api/state', headers: { Host: 'localhost:' + port, 'X-Workbench-Token': T } }));
out('foreign Origin', await raw('/api/command', { method: 'POST', headers: { ...H, Origin: 'http://evil.com' }, body: '{"text":"status"}' }));
out('own Origin', await raw('/api/command', { method: 'POST', headers: { ...H, Origin: B }, body: '{"text":"status"}' }));
out('text/plain POST', await raw('/api/command', { method: 'POST', headers: { 'X-Workbench-Token': T, 'Content-Type': 'text/plain' }, body: '{"text":"status"}' }));
out('form POST', await raw('/api/command', { method: 'POST', headers: { 'X-Workbench-Token': T, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'text=status' }));
out('big body', await raw('/api/command', { method: 'POST', headers: H, body: JSON.stringify({ text: 'x'.repeat(70000) }) }));
out('bad json', await raw('/api/command', { method: 'POST', headers: H, body: '{' }));
out('traversal', await rawReq({ path: '/ui/../src/core/engine.mjs', headers: { Host: '127.0.0.1:' + port } }));
out('traversal enc', await raw('/ui/%2e%2e/src/core/engine.mjs'));
out('shared ok', await raw('/shared/states.mjs'));
out('index', await raw('/'));
out('hook no token', await raw('/hook/pretool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
const hr = await raw('/api/state'); 
const rh = await fetch(B + '/'); out('headers', [rh.headers.get('content-security-policy'), rh.headers.get('x-content-type-options'), rh.headers.get('referrer-policy'), rh.headers.get('access-control-allow-origin')]);
ctrl.abort();
process.exit(0);
