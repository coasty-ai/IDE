import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server/http.mjs';
import { Store } from '../src/core/store.mjs';
import { EV } from '../src/shared/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, `.http-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
const TOKEN = crypto.randomBytes(32).toString('hex');
const HOOK_TOKEN = crypto.randomBytes(32).toString('hex');
const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'";

/** An engine stand-in that records calls and lets a test release a held hook. */
class FakeEngine {
  constructor(store) {
    this.store = store;
    this.calls = [];
    this.releaseHook = null;
    this.hookSignal = null;
  }
  snapshot() {
    return { mode: 'demo', repo: null, harnesses: { claude: true, codex: true, sim: true }, agents: this.store.list(), machines: this.store.machines(), spendTodayUsd: 0, defaultBudgetUsd: 2 };
  }
  async command(text, opts) { this.calls.push(['command', text, opts]); return { reply: `You said ${text}` }; }
  async confirm(id, go) { this.calls.push(['confirm', id, go]); return { reply: go ? 'Started it.' : 'Cancelled.' }; }
  async startAgent(o) {
    this.calls.push(['startAgent', o]);
    if (!o.task) { const e = new Error('Tell me what the agent should work on.'); e.plain = true; throw e; }
    if (o.task === 'explode') throw new TypeError('Cannot read properties of undefined');
    return { id: 'abc123', name: 'Fix login' };
  }
  async answer(id, o) { this.calls.push(['answer', id, o]); return { ok: true, reply: 'Answered.' }; }
  async say(id, text) { this.calls.push(['say', id, text]); return { ok: true, reply: 'Sent.' }; }
  async stop(id) { this.calls.push(['stop', id]); return { ok: true, reply: 'Stopped.' }; }
  async setMachineAwake(id, awake) { this.calls.push(['awake', id, awake]); return { ok: true, reply: 'Done.' }; }
  hookPreToolUse(agentId, payload, { signal } = {}) {
    this.calls.push(['hook', agentId, payload]);
    this.hookSignal = signal;
    return new Promise((resolve) => {
      this.releaseHook = (decision) => resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: 'The person decided.' } });
    });
  }
}

let store;
let engine;
let server;
let port;

before(async () => {
  fs.mkdirSync(path.join(ROOT, 'ui', 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'core'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'ui', 'index.html'), '<!doctype html><title>Workbench</title>');
  fs.writeFileSync(path.join(ROOT, 'ui', 'app.js'), 'console.log("app");');
  fs.writeFileSync(path.join(ROOT, 'ui', 'app.css'), 'body { margin: 0 }');
  fs.writeFileSync(path.join(ROOT, 'ui', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(ROOT, 'ui', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(ROOT, 'ui', 'fonts', 'mono.woff2'), Buffer.from('wOF2'));
  fs.writeFileSync(path.join(ROOT, 'ui', '.hidden'), 'HIDDEN');
  fs.writeFileSync(path.join(ROOT, 'src', 'shared', 'states.mjs'), 'export const x = 1;');
  fs.writeFileSync(path.join(ROOT, 'src', 'shared', 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(ROOT, 'src', 'core', 'secret.mjs'), 'SECRET CORE');
  fs.writeFileSync(path.join(ROOT, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(ROOT, 'secret.txt'), path.join(ROOT, 'ui', 'link.txt'));

  store = new Store();
  engine = new FakeEngine(store);
  server = createServer({ engine, store, token: TOKEN, hookToken: HOOK_TOKEN, port: 0, rootDir: ROOT, options: { coalesceMs: 250, pingMs: 150 } });
  const { url } = await server.listen();
  port = Number(new URL(url).port);
  assert.equal(url, `http://127.0.0.1:${port}/`);
});

after(async () => {
  await server?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A raw request: the path and headers go out exactly as given. */
function request({ method = 'GET', path: p = '/', headers = {}, body = null, host = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    let data = body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) data = JSON.stringify(body);
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const auth = (extra = {}) => ({ 'X-Workbench-Token': TOKEN, ...extra });
const post = (p, body, headers = {}) => request({ method: 'POST', path: p, body, headers: auth({ 'Content-Type': 'application/json', ...headers }) });

// ------------------------------------------------------------------ static files

test('static files are served with the right content types', async () => {
  const cases = [
    ['/', 'text/html; charset=utf-8', 'Workbench'],
    ['/ui/app.js', 'text/javascript; charset=utf-8', 'console.log'],
    ['/shared/states.mjs', 'text/javascript; charset=utf-8', 'export const x'],
    ['/ui/app.css', 'text/css; charset=utf-8', 'margin'],
    ['/ui/logo.svg', 'image/svg+xml', '<svg'],
    ['/ui/pic.png', 'image/png', null],
    ['/ui/fonts/mono.woff2', 'font/woff2', 'wOF2'],
    ['/?t=whatever', 'text/html; charset=utf-8', 'Workbench'],
  ];
  for (const [p, type, contains] of cases) {
    const r = await request({ path: p });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    if (contains) assert.ok(r.text.includes(contains), p);
  }
  const head = await request({ method: 'HEAD', path: '/ui/app.js' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('no directory listing, no hidden files, only .mjs from shared', async () => {
  for (const p of ['/ui/', '/ui/fonts', '/ui/fonts/', '/ui/.hidden', '/shared/notes.txt', '/shared/', '/nothing', '/ui/missing.js']) {
    const r = await request({ path: p });
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('HIDDEN'), p);
  }
  const bad = await request({ path: '/ui/%E0%A4%A' });
  assert.equal(bad.status, 400);
});

test('path traversal never escapes the folders', async () => {
  const attempts = [
    '/ui/../secret.txt',
    '/ui/../../secret.txt',
    '/ui/..%2fsecret.txt',
    '/ui/..%2F..%2Fsecret.txt',
    '/ui/%2e%2e/secret.txt',
    '/ui/%2e%2e%2fsecret.txt',
    '/ui/..%5csecret.txt',
    '/ui/fonts/..%2f..%2fsecret.txt',
    '/shared/..%2f..%2fsecret.txt',
    '/shared/../core/secret.mjs',
    '/shared/..%2fcore%2fsecret.mjs',
    '/ui/%00index.html',
    '/ui//etc/passwd',
    '/ui/link.txt',
  ];
  for (const p of attempts) {
    const r = await request({ path: p });
    assert.notEqual(r.status, 200, p);
    assert.ok(!r.text.includes('TOP SECRET') && !r.text.includes('SECRET CORE') && !r.text.includes('root:'), p);
  }
});

test('every response has the security headers and no CORS headers', async () => {
  for (const r of [await request({ path: '/' }), await request({ path: '/nothing' }), await request({ path: '/api/state', headers: auth() }), await request({ path: '/api/state' })]) {
    assert.equal(r.headers['content-security-policy'], CSP);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  }
  const pre = await request({ method: 'OPTIONS', path: '/api/command', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.notEqual(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
});

// ------------------------------------------------------------------ checks

test('the Host header must be this server', async () => {
  assert.equal((await request({ path: '/', host: 'evil.example' })).status, 403);
  assert.equal((await request({ path: '/api/state', headers: auth(), host: `evil.example:${port}` })).status, 403);
  assert.equal((await request({ path: '/', host: `127.0.0.1:${port + 1}` })).status, 403);
  assert.equal((await request({ path: '/api/state', headers: auth(), host: `localhost:${port}` })).status, 200);
});

test('API routes need the token, in the header or (GET only) in ?t=', async () => {
  assert.equal((await request({ path: '/api/state' })).status, 401);
  assert.equal((await request({ path: '/api/state', headers: { 'X-Workbench-Token': 'a'.repeat(64) } })).status, 401);
  assert.equal((await request({ path: '/api/state', headers: { 'X-Workbench-Token': TOKEN.slice(0, 10) } })).status, 401);
  const ok = await request({ path: '/api/state', headers: auth() });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.mode, 'demo');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal((await request({ path: `/api/state?t=${TOKEN}` })).status, 200);
  const postWithQuery = await request({ method: 'POST', path: `/api/command?t=${TOKEN}`, body: { text: 'hi' }, headers: { 'Content-Type': 'application/json' } });
  assert.equal(postWithQuery.status, 401, 'the query token is for GET routes only');
  assert.equal((await post('/hook/pretool', { agentId: 'x', payload: {} }, { 'X-Workbench-Token': 'b'.repeat(64) })).status, 401);
});

test('the hook token works for /hook only', async () => {
  assert.equal((await request({ path: '/api/state', headers: { 'X-Workbench-Token': HOOK_TOKEN } })).status, 401);
  const held = post('/hook/pretool', { agentId: 'abc123', payload: { tool_name: 'Read' } }, { 'X-Workbench-Token': HOOK_TOKEN });
  await waitFor(() => engine.releaseHook);
  engine.releaseHook('allow');
  const r = await held;
  assert.equal(r.status, 200);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'allow');
  engine.releaseHook = null;
});

test('POSTs need JSON, a body of at most 64 KB, and no foreign Origin', async () => {
  const typeless = await request({ method: 'POST', path: '/api/command', body: '{"text":"hi"}', headers: auth({ 'Content-Type': 'text/plain' }) });
  assert.equal(typeless.status, 415);
  const noType = await request({ method: 'POST', path: '/api/command', body: '{"text":"hi"}', headers: auth() });
  assert.equal(noType.status, 415);
  assert.equal((await post('/api/command', { text: 'hi' }, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);

  assert.equal((await post('/api/command', { text: 'hi' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/command', { text: 'hi' }, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/command', { text: 'hi' }, { Origin: `http://localhost:${port}` })).status, 403, 'a different origin than the Host');
  assert.equal((await post('/api/command', { text: 'hi' }, { Origin: `http://127.0.0.1:${port}` })).status, 200);

  const big = await post('/api/command', { text: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /64 KB/);
  const justUnder = await post('/api/command', { text: 'x'.repeat(60 * 1024) });
  assert.equal(justUnder.status, 200);

  assert.equal((await post('/api/command', '{not json')).status, 400);
  assert.equal((await post('/api/command', '[1,2]')).status, 400);
  const empty = await request({ method: 'POST', path: '/api/agents/abc123/stop', headers: auth({ 'Content-Type': 'application/json' }) });
  assert.equal(empty.status, 200, 'an empty body counts as {}');
});

// ------------------------------------------------------------------ routes

test('API routes call the engine with the right arguments', async () => {
  engine.calls.length = 0;
  assert.equal((await post('/api/command', { text: 'what needs me', focusId: 'abc123' })).json.reply, 'You said what needs me');
  assert.equal((await post('/api/confirm/0a1b2c3d4e5f', { go: true })).json.reply, 'Started it.');
  await post('/api/confirm/0a1b2c3d4e5f', { go: 'yes' });
  assert.equal((await post('/api/agents', { task: 'Fix login', harness: 'codex', model: null, machineId: 'laptop', budgetUsd: 3 })).json.id, 'abc123');
  await post('/api/agents/abc123/answer', { askId: 'ok-1', answer: 'Allow' });
  await post('/api/agents/abc123/say', { text: 'hello' });
  await post('/api/agents/abc123-a71ea18c/stop', {});
  await post('/api/machines/cloud-2/awake', { awake: true });
  assert.deepEqual(engine.calls, [
    ['command', 'what needs me', { focusId: 'abc123' }],
    ['confirm', '0a1b2c3d4e5f', true],
    ['confirm', '0a1b2c3d4e5f', false],
    ['startAgent', { task: 'Fix login', harness: 'codex', model: null, machineId: 'laptop', budgetUsd: 3, name: undefined }],
    ['answer', 'abc123', { askId: 'ok-1', answer: 'Allow' }],
    ['say', 'abc123', 'hello'],
    ['stop', 'abc123-a71ea18c'],
    ['awake', 'cloud-2', true],
  ]);
});

test('unknown routes, wrong methods, bad ids and engine errors get plain JSON errors', async () => {
  assert.equal((await request({ path: '/api/nothing', headers: auth() })).status, 404);
  assert.equal((await request({ path: '/api/command', headers: auth() })).status, 405);
  assert.equal((await post('/api/state', {})).status, 405);
  assert.equal((await post('/api/agents/a%2Fb/stop', {})).status, 404);
  assert.equal((await post('/api/agents/a:b/stop', {})).status, 404);
  const plainErr = await post('/api/agents', { task: '' });
  assert.equal(plainErr.status, 400);
  assert.equal(plainErr.json.error, 'Tell me what the agent should work on.');
  const crash = await post('/api/agents', { task: 'explode' });
  assert.equal(crash.status, 500);
  assert.equal(crash.json.error, 'Something went wrong in the workbench. The details are in its log.');
});

// ------------------------------------------------------------------ the held hook

test('a held /hook/pretool response waits for the engine, then answers', async () => {
  engine.releaseHook = null;
  let answered = false;
  const pending = post('/hook/pretool', { agentId: 'abc123', payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } })
    .then((r) => { answered = true; return r; });
  await waitFor(() => engine.releaseHook);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(answered, false, 'still waiting for the person');
  const call = engine.calls.findLast(c => c[0] === 'hook');
  assert.deepEqual(call.slice(1), ['abc123', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }]);
  engine.releaseHook('deny');
  const r = await pending;
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The person decided.' } });
  engine.releaseHook = null;
});

test('if the hook client goes away, the engine is told through the abort signal', async () => {
  engine.releaseHook = null;
  const body = JSON.stringify({ agentId: 'abc123', payload: { tool_name: 'Bash' } });
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook/pretool', agent: false, headers: { Host: `127.0.0.1:${port}`, 'X-Workbench-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.on('error', () => {});
  req.end(body);
  await waitFor(() => engine.releaseHook);
  assert.equal(engine.hookSignal.aborted, false);
  req.destroy();
  await waitFor(() => engine.hookSignal.aborted);
  engine.releaseHook('deny'); // the server must not crash writing to a closed socket
  engine.releaseHook = null;
  assert.equal((await request({ path: '/api/state', headers: auth() })).status, 200);
});

// ------------------------------------------------------------------ live updates

test('SSE: snapshot on connect, coalesced agents, machines, notices, pings', async () => {
  const sse = await openSse(`/api/stream?t=${TOKEN}`);
  try {
    assert.equal(sse.status, 200);
    assert.equal(sse.headers['content-type'], 'text/event-stream; charset=utf-8');
    const snap = await sse.next('snapshot');
    assert.equal(snap.data.mode, 'demo');

    const t0 = Date.now();
    // Three separate applies (three 'agents' emissions) inside one window.
    store.apply({ kind: EV.CREATED, ts: t0, agentId: 'aaa111', parentId: null, name: 'Fix login', task: 'Fix login', harness: 'claude' });
    store.apply({ kind: EV.CREATED, ts: t0, agentId: 'bbb222', parentId: null, name: 'Write docs', task: 'Write docs', harness: 'codex' });
    store.apply({ kind: EV.ACTIVITY, ts: t0, agentId: 'aaa111', phase: 'start', sentence: 'Reading a.js', toolKind: 'read' });
    const agents = await sse.next('agents');
    assert.ok(Date.now() - t0 >= 200, 'changes are coalesced for about 250 ms');
    assert.deepEqual(agents.data.map(v => v.id).sort(), ['aaa111', 'bbb222']);
    assert.equal(agents.data.find(v => v.id === 'aaa111').now, 'Reading a.js');
    await new Promise(r => setTimeout(r, 350));
    assert.equal(sse.pending.filter(e => e.event === 'agents').length, 0, 'one coalesced event, not several');

    store.apply({ kind: EV.MACHINE, ts: Date.now(), machine: { id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true } });
    const machines = await sse.next('machines');
    assert.deepEqual(machines.data.map(m => m.id), ['laptop']);

    store.apply({ kind: EV.NOTICE, ts: Date.now(), text: 'Started Fix login.' });
    const notice = await sse.next('notice');
    assert.deepEqual(notice.data, { text: 'Started Fix login.' });

    await sse.nextComment('ping');
  } finally {
    sse.close();
  }
  // After the client leaves, changes are not queued for anyone and nothing breaks.
  await new Promise(r => setTimeout(r, 30));
  store.apply({ kind: EV.STATE, ts: Date.now(), agentId: 'aaa111', state: 'working' });
  assert.equal((await request({ path: '/api/state', headers: auth() })).status, 200);
});

test('a short request timeout does not cut a held hook or an open stream', async () => {
  const s = new Store();
  const e = new FakeEngine(s);
  const srv = createServer({ engine: e, store: s, token: TOKEN, port: 0, rootDir: ROOT, options: { requestTimeoutMs: 200, checkIntervalMs: 50, pingMs: 60_000 } });
  const { url } = await srv.listen();
  const p = Number(new URL(url).port);
  try {
    const body = JSON.stringify({ agentId: 'abc123', payload: { tool_name: 'Bash' } });
    const held = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: p, method: 'POST', path: '/hook/pretool', agent: false, headers: { Host: `127.0.0.1:${p}`, 'X-Workbench-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    let streamClosed = false;
    const stream = http.request({ host: '127.0.0.1', port: p, path: `/api/stream?t=${TOKEN}`, agent: false, headers: { Host: `127.0.0.1:${p}` } }, (res) => {
      res.resume();
      res.on('close', () => { streamClosed = true; });
    });
    stream.on('error', () => {});
    stream.end();
    await waitFor(() => e.releaseHook);
    await new Promise(r => setTimeout(r, 700)); // well past the 200 ms request timeout
    assert.equal(streamClosed, false, 'the stream is still open');
    e.releaseHook('allow');
    const r = await held;
    assert.equal(r.status, 200);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'allow');
    stream.destroy();
  } finally {
    await srv.close();
  }
});

test('SSE needs the token too', async () => {
  const r = await request({ path: '/api/stream' });
  assert.equal(r.status, 401);
});

test('close() removes the store listeners', async () => {
  const s = new Store();
  const srv = createServer({ engine: new FakeEngine(s), store: s, token: TOKEN, port: 0, rootDir: ROOT });
  await srv.listen();
  assert.equal(s.listenerCount('agents'), 1);
  await srv.close();
  assert.equal(s.listenerCount('agents'), 0);
  assert.throws(() => createServer({ engine: new FakeEngine(s), store: s, token: 'short' }), /32 random bytes/);
});

// ------------------------------------------------------------------ helpers

async function waitFor(fn, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/** A tiny SSE client that records events and comments. */
function openSse(p) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = block.split('\n');
          if (lines.every(l => l.startsWith(':'))) { events.push({ comment: lines.join('\n').slice(1).trim() }); continue; }
          const ev = { event: 'message', data: null };
          for (const l of lines) {
            if (l.startsWith('event: ')) ev.event = l.slice(7);
            else if (l.startsWith('data: ')) ev.data = JSON.parse(l.slice(6));
          }
          if (ev.data !== null) events.push(ev);
        }
      });
      const waitUntil = async (match) => {
        const start = Date.now();
        for (;;) {
          const found = events.find(match);
          if (found) { events.splice(events.indexOf(found), 1); return found; }
          if (Date.now() - start > 3000) throw new Error('No matching SSE event');
          await new Promise(r => setTimeout(r, 5));
        }
      };
      resolve({
        status: res.statusCode,
        headers: res.headers,
        pending: events, // received but not yet taken by next()
        next: (name) => waitUntil(x => x.event === name),
        nextComment: (text) => waitUntil(x => x.comment === text),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}
