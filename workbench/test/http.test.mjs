import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server/http.mjs';
import { Store } from '../src/core/store.mjs';
import { Connect } from '../src/core/connect.mjs';
import { KeyStore } from '../src/core/keys.mjs';
import { EV } from '../src/shared/events.mjs';

const ROOT = path.join(os.tmpdir(), `wb-http-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
const TOKEN = crypto.randomBytes(32).toString('hex');
const HOOK_KEY = crypto.randomBytes(32);
/** Each agent's own hook token, made the way bin/workbench.mjs makes it. */
const hookTokenFor = (id) => crypto.createHmac('sha256', HOOK_KEY).update(`workbench-hook:${id}`).digest('hex');
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
  async gitGraph() {
    this.calls.push(['gitGraph']);
    return { ok: true, repo: { name: 'shop', branch: 'main', head: 'ab'.repeat(20), dirty: 0, identity: true }, commits: [], more: false, agents: [] };
  }
  async changes(id) { this.calls.push(['changes', id]); return { ok: true, agentId: id, name: 'Fix login', branch: `workbench/fix-login-${id}`, into: 'main', live: false, diff: { files: [], left: [], omitted: 0 } }; }
  async proposeMerge(id, o) {
    this.calls.push(['proposeMerge', id, o]);
    return { reply: 'Merge Fix login into main?', confirm: { id: '0a1b2c3d4e5f', sentence: 'Merge Fix login into main?', detail: '1 file, +3 −1.', kind: 'merge', yes: 'Merge', no: 'Cancel', danger: false } };
  }
  async proposeDiscard(id, o) {
    this.calls.push(['proposeDiscard', id, o]);
    return { reply: 'Throw away Fix login’s work?', confirm: { id: '0a1b2c3d4e60', sentence: 'Throw away Fix login’s work?', detail: 'Its folder and its branch are deleted.', kind: 'discard', yes: 'Throw it away', no: 'Keep it', danger: true } };
  }
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
  server = createServer({ engine, store, token: TOKEN, hookTokenFor, port: 0, rootDir: ROOT, options: { coalesceMs: 250, pingMs: 150 } });
  const { url } = await server.listen();
  port = Number(new URL(url).port);
  assert.equal(url, `http://127.0.0.1:${port}/`);
});

after(async () => {
  await server?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A raw request: the path and headers go out exactly as given. */
function request({ method = 'GET', path: p = '/', headers = {}, body = null, host = null, at = port } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${at}`, ...headers };
    let data = body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) data = JSON.stringify(body);
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: at, method, path: p, headers: h, agent: false }, (res) => {
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
    [`/?t=${TOKEN}`, 'text/html; charset=utf-8', 'Workbench'],
    [`/?t=${TOKEN}&static=1&still=1&pin=first-root`, 'text/html; charset=utf-8', 'Workbench'],
    ['/ui/app.js?v=2', 'text/javascript; charset=utf-8', 'console.log'],
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

test('the page is served with a query only when the query carries the key; anything else goes to the plain page', async () => {
  // Any website can send the person's tab to an address here, so the address must not change what the page does.
  const wrong = crypto.randomBytes(32).toString('hex');
  for (const p of ['/?say=yes', '/?static=1', '/?still=1&pin=first-root', `/?t=${wrong}`, `/?t=${wrong}&say=yes`, '/?t=&static=1',
    '/index.html?say=yes', '/ui/index.html?say=yes', '/ui/%69ndex.html?say=yes', `/?T=${TOKEN}`, `/?say=yes&t=${wrong}`]) {
    for (const method of ['GET', 'HEAD']) {
      const r = await request({ method, path: p });
      assert.equal(r.status, 303, `${method} ${p}`);
      assert.equal(r.headers.location, '/', `${method} ${p}`);
      assert.equal(r.text, '', `${method} ${p}`);
      assert.equal(r.headers['cache-control'], 'no-store', `${method} ${p}`);
      assert.equal(r.headers['x-frame-options'], 'DENY', `${method} ${p}`);
    }
  }
  // The address the terminal prints, and the screenshot scripts' addresses, still open the page.
  for (const p of ['/', '/?', `/?t=${TOKEN}`, `/?t=${TOKEN}&static=1&still=1&pin=abc`, `/ui/index.html?t=${TOKEN}`]) {
    const r = await request({ path: p });
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes('Workbench'), p);
  }
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

test('an agent’s hook token opens /hook for that agent only, never /api', async () => {
  const mine = hookTokenFor('abc123');
  assert.equal((await request({ path: '/api/state', headers: { 'X-Workbench-Token': mine } })).status, 401);
  assert.equal((await request({ path: `/api/state?t=${mine}` })).status, 401);
  assert.equal((await post('/api/agents/abc123/answer', { answer: 'Allow' }, { 'X-Workbench-Token': mine })).status, 401);
  engine.releaseHook = null;
  const held = post('/hook/pretool', { agentId: 'abc123', payload: { tool_name: 'Read' } }, { 'X-Workbench-Token': mine });
  await waitFor(() => engine.releaseHook);
  assert.deepEqual(engine.calls.findLast(c => c[0] === 'hook').slice(1, 2), ['abc123']);
  engine.releaseHook('allow');
  const r = await held;
  assert.equal(r.status, 200);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'allow');
  engine.releaseHook = null;
});

test('a hook token cannot ask in another agent’s name', async () => {
  engine.calls.length = 0;
  engine.releaseHook = null;
  const mine = hookTokenFor('abc123');
  // Control: the same token does work for its own agent.
  const own = post('/hook/pretool', { agentId: 'abc123', payload: { tool_name: 'Read' } }, { 'X-Workbench-Token': mine });
  await waitFor(() => engine.releaseHook);
  engine.releaseHook('deny');
  assert.equal((await own).status, 200);
  engine.releaseHook = null;
  engine.calls.length = 0;
  const tries = [
    [{ agentId: 'def456', payload: { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } } }, mine],
    [{ agentId: 'abc123', payload: { tool_name: 'Read' } }, crypto.randomBytes(32).toString('hex')],
    [{ agentId: 'abc123', payload: { tool_name: 'Read' } }, hookTokenFor('def456')],
    [{ payload: { tool_name: 'Read' } }, mine],
    [{ agentId: ['abc123'], payload: { tool_name: 'Read' } }, mine],
    [{ agentId: '../abc123', payload: { tool_name: 'Read' } }, hookTokenFor('../abc123')],
    [{ agentId: 'abc123', payload: { tool_name: 'Read' } }, mine.toUpperCase()],
  ];
  for (const [body, tok] of tries) {
    const r = await post('/hook/pretool', body, { 'X-Workbench-Token': tok });
    assert.equal(r.status, 401, JSON.stringify(body));
    assert.equal(r.json.error, 'Missing or wrong token.');
  }
  assert.equal(engine.calls.filter(c => c[0] === 'hook').length, 0, 'the engine never sees these requests');
  // Without a token maker, only the page token opens /hook.
  const s = new Store();
  const e = new FakeEngine(s);
  const srv = createServer({ engine: e, store: s, token: TOKEN, port: 0, rootDir: ROOT });
  const { url } = await srv.listen();
  try {
    const res = await fetch(new URL('hook/pretool', url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': mine }, body: JSON.stringify({ agentId: 'abc123', payload: {} }) });
    assert.equal(res.status, 401);
    assert.equal(e.calls.length, 0);
  } finally {
    await srv.close();
  }
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
  // What the page showed when the person began: the agent, the confirm card and the ask. Anything that is not an id is
  // passed as nothing.
  await post('/api/command', { text: 'yes', focusId: 'abc123', confirmId: '0a1b2c3d4e5f', askId: 'ok-1a2b3c4d' });
  await post('/api/command', { text: 'yes', focusId: 42, confirmId: '../x', askId: ['ok-1a2b3c4d'] });
  await post('/api/command', { text: 'yes', confirmId: 'a:b', askId: { id: 'ok-1' } });
  assert.equal((await post('/api/confirm/0a1b2c3d4e5f', { go: true })).json.reply, 'Started it.');
  await post('/api/confirm/0a1b2c3d4e5f', { go: 'yes' });
  assert.equal((await post('/api/agents', { task: 'Fix login', harness: 'codex', model: null, machineId: 'laptop', budgetUsd: 3 })).json.id, 'abc123');
  await post('/api/agents/abc123/answer', { askId: 'ok-1', answer: 'Allow' });
  await post('/api/agents/abc123/answer', { askId: 7, answer: 'Allow' });
  await post('/api/agents/abc123/say', { text: 'hello' });
  await post('/api/agents/abc123-a71ea18c/stop', {});
  await post('/api/machines/cloud-2/awake', { awake: true });
  // The git screen, an agent's changes, and the merge and throw-away cards. The state the page drew a button for is
  // passed on only when it is a state; anything else is as if nothing was sent.
  await request({ path: '/api/git', headers: auth() });
  await request({ path: '/api/agents/abc123/changes', headers: auth() });
  await post('/api/agents/abc123/merge', { state: 'done_claimed' });
  await post('/api/agents/abc123/merge', { state: 'merged' });
  await post('/api/agents/abc123/merge', {});
  await post('/api/agents/abc123/discard', { state: 'needs_ok' });
  await post('/api/agents/abc123/discard', { state: ['done_claimed'] });
  await post('/api/agents/abc123/discard', { state: 'toString' });
  assert.deepEqual(engine.calls, [
    ['command', 'what needs me', { focusId: 'abc123', confirmId: null, askId: null }],
    ['command', 'yes', { focusId: 'abc123', confirmId: '0a1b2c3d4e5f', askId: 'ok-1a2b3c4d' }],
    ['command', 'yes', { focusId: null, confirmId: null, askId: null }],
    ['command', 'yes', { focusId: null, confirmId: null, askId: null }],
    ['confirm', '0a1b2c3d4e5f', true],
    ['confirm', '0a1b2c3d4e5f', false],
    ['startAgent', { task: 'Fix login', harness: 'codex', model: null, machineId: 'laptop', budgetUsd: 3, name: undefined }],
    ['answer', 'abc123', { askId: 'ok-1', answer: 'Allow' }],
    ['answer', 'abc123', { askId: null, answer: 'Allow' }],
    ['say', 'abc123', 'hello'],
    ['stop', 'abc123-a71ea18c'],
    ['awake', 'cloud-2', true],
    ['gitGraph'],
    ['changes', 'abc123'],
    ['proposeMerge', 'abc123', { state: 'done_claimed' }],
    ['proposeMerge', 'abc123', { state: null }],
    ['proposeMerge', 'abc123', { state: null }],
    ['proposeDiscard', 'abc123', { state: 'needs_ok' }],
    ['proposeDiscard', 'abc123', { state: null }],
    ['proposeDiscard', 'abc123', { state: null }],
  ]);
});

test('the git screen, changes, merge and throw-away routes: the token, the methods, a hook token refused, and a card answered by its id', async () => {
  engine.calls.length = 0;
  // The token: in the header, or in ?t= for the GET routes only.
  assert.equal((await request({ path: '/api/git' })).status, 401);
  assert.equal((await request({ path: '/api/agents/abc123/changes' })).status, 401);
  const git = await request({ path: `/api/git?t=${TOKEN}` });
  assert.equal(git.status, 200);
  assert.equal(git.headers['cache-control'], 'no-store');
  assert.equal(git.json.repo.branch, 'main');
  assert.equal((await request({ path: `/api/agents/abc123/changes?t=${TOKEN}` })).json.agentId, 'abc123');
  for (const p of ['/api/agents/abc123/merge', '/api/agents/abc123/discard']) {
    const r = await request({ method: 'POST', path: `${p}?t=${TOKEN}`, body: {}, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 401, `${p}: the query token is for GET routes only`);
  }
  // An agent's own hook token opens none of them, for that agent or any other.
  const mine = hookTokenFor('abc123');
  assert.equal((await request({ path: '/api/git', headers: { 'X-Workbench-Token': mine } })).status, 401);
  assert.equal((await request({ path: `/api/git?t=${mine}` })).status, 401);
  assert.equal((await request({ path: '/api/agents/abc123/changes', headers: { 'X-Workbench-Token': mine } })).status, 401);
  assert.equal((await post('/api/agents/abc123/merge', { state: 'done_claimed' }, { 'X-Workbench-Token': mine })).status, 401);
  assert.equal((await post('/api/agents/abc123/discard', {}, { 'X-Workbench-Token': mine })).status, 401);
  // Wrong methods, with what is allowed.
  for (const [method, p, allow] of [['POST', '/api/git', 'GET'], ['POST', '/api/agents/abc123/changes', 'GET'], ['GET', '/api/agents/abc123/merge', 'POST'], ['GET', '/api/agents/abc123/discard', 'POST']]) {
    const r = method === 'GET' ? await request({ path: p, headers: auth() }) : await post(p, {});
    assert.equal(r.status, 405, p);
    assert.equal(r.headers.allow, allow, p);
  }
  // Bad ids, and POSTs from another site.
  assert.equal((await request({ path: '/api/agents/a%2Fb/changes', headers: auth() })).status, 404);
  assert.equal((await post('/api/agents/a:b/merge', {})).status, 404);
  assert.equal((await post('/api/agents/abc123/merge', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal(engine.calls.filter(c => c[0] === 'proposeMerge' || c[0] === 'proposeDiscard').length, 0, 'none of these reached the engine');
  // A merge only ever gets a card back; the yes goes to /api/confirm/<its id>.
  const card = await post('/api/agents/abc123/merge', { state: 'done_claimed' });
  assert.equal(card.status, 200);
  assert.deepEqual(card.json, { reply: 'Merge Fix login into main?', confirm: { id: '0a1b2c3d4e5f', sentence: 'Merge Fix login into main?', detail: '1 file, +3 −1.', kind: 'merge', yes: 'Merge', no: 'Cancel', danger: false } });
  await post(`/api/confirm/${card.json.confirm.id}`, { go: true });
  const away = await post('/api/agents/abc123/discard', { state: 'stopped' });
  assert.equal(away.json.confirm.kind, 'discard');
  await post(`/api/confirm/${away.json.confirm.id}`, { go: false });
  assert.deepEqual(engine.calls.filter(c => c[0] !== 'gitGraph' && c[0] !== 'changes'), [
    ['proposeMerge', 'abc123', { state: 'done_claimed' }],
    ['confirm', '0a1b2c3d4e5f', true],
    ['proposeDiscard', 'abc123', { state: 'stopped' }],
    ['confirm', '0a1b2c3d4e60', false],
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

    // The person's repository changed (a merge moved their branch, a refresh found something new): every page hears.
    store.repoChanged({ name: 'shop', head: 'ab'.repeat(20), branch: 'main', dirty: 0, identity: true });
    const repo = await sse.next('repo');
    assert.deepEqual(repo.data, { name: 'shop', head: 'ab'.repeat(20), branch: 'main', dirty: 0, identity: true });

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
  for (const name of ['agents', 'machines', 'notice', 'removed', 'repo']) assert.equal(s.listenerCount(name), 1, name);
  await srv.close();
  for (const name of ['agents', 'machines', 'notice', 'removed', 'repo']) assert.equal(s.listenerCount(name), 0, name);
  assert.throws(() => createServer({ engine: new FakeEngine(s), store: s, token: 'short' }), /32 random bytes/);
});

// ------------------------------------------------------------------ Agents & keys

/** A key-shaped value made at run time, so no fixture looks like a real key to a scanner. */
const fakeKey = (...parts) => [...parts, crypto.randomBytes(16).toString('hex')].join('');

/** A stand-in for src/core/connect.mjs: records calls, never holds a value in what it reports. */
class FakeConnect extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.fail = null; // an error the next action throws
    this.github = { connected: false, login: null, agentsUseIt: false, sentence: 'Not connected.' };
  }
  act(name, ...args) {
    this.calls.push([name, ...args]);
    if (this.fail) { const e = this.fail; this.fail = null; throw e; }
  }
  async status(o) {
    this.calls.push(['status', o]);
    return {
      agents: [
        { id: 'claude', name: 'Claude Code', found: true, version: '2.1.322', from: 'your PATH', signedIn: 'yes', how: 'your Claude subscription', ready: true, isDefault: true,
          sentence: 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.', actions: ['key', 'recheck', 'default'] },
        { id: 'codex', name: 'Codex', found: false, version: null, from: null, signedIn: 'unknown', how: null, ready: false, isDefault: false, sentence: 'Codex is not installed.', actions: ['install', 'recheck'] },
      ],
      defaultAgent: 'claude', platform: 'darwin', canOpenTerminal: true,
      git: { name: 'Ada Lovelace', email: 'ada@example.invalid', sentence: 'Merging needs these.' },
      github: this.github,
      keys: [{ id: 'k1a2b3', preset: 'aws', label: 'AWS', vars: [{ name: 'AWS_ACCESS_KEY_ID', shown: '•••• 7QXA' }], scope: { kind: 'all' }, agents: 'all', created: 1, sentence: 'AWS for all repositories, given to all agents.' }],
      ready: true,
    };
  }
  async recheck() { this.act('recheck'); }
  async agentAction(id, action) {
    this.act('agentAction', id, action);
    return action === 'install' ? { opened: true, sentence: 'Terminal is installing Codex.' } : { command: 'codex login', sentence: 'Run this in a terminal to sign in to Codex.' };
  }
  async setAgentKey(id, value) { this.act('setAgentKey', id, value); return { ok: true, sentence: 'Claude Code will use this key instead of your Claude subscription, and each request is billed to the key.' }; }
  async setDefaultAgent(id) { this.act('setDefaultAgent', id); return { ok: true, sentence: 'New work goes to Claude Code.' }; }
  async setGitIdentity(o) { this.act('setGitIdentity', o); }
  async connectGithub(token, o) {
    this.act('connectGithub', token, o);
    this.github = { connected: true, login: 'octocat', agentsUseIt: !!o?.agentsUseIt, sentence: 'Connected to GitHub as octocat.' };
    return { ok: true, login: 'octocat', sentence: 'Connected to GitHub as octocat.' };
  }
  async disconnectGithub() { this.act('disconnectGithub'); return { ok: true }; }
  async setGithubAgentsUseIt(on) {
    this.act('setGithubAgentsUseIt', on);
    if (this.githubAnswer) return this.githubAnswer;
    this.github = { ...this.github, agentsUseIt: on === true };
    return { ok: true, sentence: on ? 'Agents can use your GitHub token now, as GH_TOKEN.' : 'Agents no longer get your GitHub token. Git still uses it.' };
  }
  async addKey(o) { this.act('addKey', o); return { id: 'k9f8e7' }; }
  async removeKey(id) { this.act('removeKey', id); return { removed: id === 'k1a2b3' }; }
  envFor() { return {}; }
  mask(t) { return t; }
}

/** The presets of src/shared/keypresets.mjs that the route needs, as the spec gives them. */
const FAKE_PRESETS = {
  presetById(id) {
    return {
      aws: { id: 'aws', label: 'AWS', fields: [
        { name: 'AWS_ACCESS_KEY_ID', secret: true }, { name: 'AWS_SECRET_ACCESS_KEY', secret: true },
        { name: 'AWS_SESSION_TOKEN', secret: true, optional: true }, { name: 'AWS_REGION', secret: false, optional: true }] },
      openai: { id: 'openai', label: 'OpenAI', fields: [{ name: 'OPENAI_API_KEY', secret: true, also: ['CODEX_API_KEY'] }] },
      custom: { id: 'custom', label: 'Custom', fields: [] },
    }[id] ?? null;
  },
};

/** A Workbench with Agents & keys: its own server, engine, connect and log. */
async function connectServer(t, { presets = FAKE_PRESETS, mode = 'live', repoRoot = '/work/shop' } = {}) {
  const s = new Store();
  const e = new FakeEngine(s);
  e.mode = mode;
  e.connectSummary = { ready: false, defaultAgent: null };
  const snapshot = e.snapshot.bind(e);
  e.snapshot = () => ({ ...snapshot(), connect: e.connectSummary });
  const connect = new FakeConnect();
  const lines = [];
  const log = { info() {}, debug() {}, warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  // presets: a stand-in for src/shared/keypresets.mjs, or null for "it could not be read".
  const srv = createServer({ engine: e, store: s, token: TOKEN, connect, repoRoot, port: 0, rootDir: ROOT, log,
    options: { coalesceMs: 40, pingMs: 60_000, keyPresets: presets } });
  const { url } = await srv.listen();
  t.after(() => srv.close());
  const at = Number(new URL(url).port);
  const send = (p, body, headers = {}) => request({ at, method: 'POST', path: p, body, headers: auth({ 'Content-Type': 'application/json', ...headers }) });
  const get = (p, headers = auth()) => request({ at, path: p, headers });
  return { srv, engine: e, connect, lines, at, send, get };
}

test('Agents & keys: without the connect service (the demo), every route says so plainly', async () => {
  assert.equal((await request({ path: '/api/connect' })).status, 401, 'the token first');
  const r = await request({ path: '/api/connect', headers: auth() });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'Agents & keys is not available in this Workbench. The details are in its log.');
  engine.mode = 'demo';
  try {
    for (const [method, p] of [['GET', '/api/connect'], ['POST', '/api/connect/recheck'], ['POST', '/api/connect/keys'], ['POST', '/api/connect/agents/claude/key']]) {
      const res = method === 'GET' ? await request({ path: p, headers: auth() }) : await post(p, { value: 'x' });
      assert.equal(res.status, 404, p);
      assert.equal(res.json.error, 'The demo’s agents are simulated, so there is nothing to connect. Run Workbench on a repository to connect your own agents and keys.', p);
    }
  } finally {
    delete engine.mode;
  }
});

test('Agents & keys: the status, a re-check, and the token, method and origin checks every route has', async (t) => {
  const w = await connectServer(t);
  const r = await w.get('/api/connect');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.sentence, null);
  assert.equal(r.json.status.agents[0].sentence, 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.');
  assert.deepEqual(w.connect.calls, [['status', { repoRoot: '/work/shop' }]], 'the status of the repository Workbench runs on');
  assert.equal((await w.get(`/api/connect?t=${TOKEN}`, {})).status, 200, 'a GET may carry the key in the address');
  // A re-check probes again, then answers with what is connected now.
  w.connect.calls.length = 0;
  const again = await w.send('/api/connect/recheck', {});
  assert.equal(again.status, 200);
  assert.deepEqual(w.connect.calls.map(c => c[0]), ['recheck', 'status']);
  assert.equal(again.json.status.ready, true);
  // The same checks as every other route.
  assert.equal((await w.get('/api/connect', {})).status, 401);
  assert.equal((await w.get('/api/connect', { 'X-Workbench-Token': hookTokenFor('abc123') })).status, 401, 'a hook token never opens /api');
  assert.equal((await request({ at: w.at, method: 'POST', path: `/api/connect/recheck?t=${TOKEN}`, body: {}, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await w.send('/api/connect/recheck', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await w.send('/api/connect/recheck', '{"a":1}', { 'Content-Type': 'text/plain' })).status, 415);
  const wrong = await w.get('/api/connect/recheck');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST');
  assert.equal((await w.send('/api/connect', {})).status, 405);
  for (const p of ['/api/connect/agents/claude/uninstall', '/api/connect/agents/Claude/install', '/api/connect/agents/a%2Fb/key', '/api/connect/agents/-x/default',
    '/api/connect/keys/a:b/remove', '/api/connect/nothing']) {
    assert.equal((await w.send(p, {})).status, 404, p);
  }
});

test('Agents & keys: each route calls the connect service with what the page sent, and answers with a fresh status', async (t) => {
  const w = await connectServer(t);
  const key = fakeKey('sk', '-ant-', 'api03-');
  const ghToken = fakeKey('gh', 'p_');
  const install = await w.send('/api/connect/agents/codex/install', {});
  assert.deepEqual({ ok: install.json.ok, opened: install.json.opened, sentence: install.json.sentence, command: install.json.command },
    { ok: true, opened: true, sentence: 'Terminal is installing Codex.', command: undefined });
  const signin = await w.send('/api/connect/agents/codex/signin', {});
  assert.deepEqual({ opened: signin.json.opened, command: signin.json.command, sentence: signin.json.sentence },
    { opened: false, command: 'codex login', sentence: 'Run this in a terminal to sign in to Codex.' });
  const keyed = await w.send('/api/connect/agents/claude/key', { value: `  ${key}\n` });
  assert.equal(keyed.status, 200);
  assert.equal(keyed.json.sentence, 'Claude Code will use this key instead of your Claude subscription, and each request is billed to the key.');
  await w.send('/api/connect/agents/claude/default', { value: 'ignored' });
  const git = await w.send('/api/connect/git', { name: '  Ada Lovelace ', email: 'ada@example.invalid' });
  assert.equal(git.json.sentence, 'Git now has your name and email.', 'a plain sentence when Connect gives none');
  await w.send('/api/connect/git', { name: { toString: 'x' }, email: ['a'] });
  const gh = await w.send('/api/connect/github', { token: ghToken, agentsUseIt: 'yes' });
  assert.deepEqual({ login: gh.json.login, sentence: gh.json.sentence, github: gh.json.status.github },
    { login: 'octocat', sentence: 'Connected to GitHub as octocat.', github: { connected: true, login: 'octocat', agentsUseIt: false, sentence: 'Connected to GitHub as octocat.' } });
  await w.send('/api/connect/github', { token: ghToken, agentsUseIt: true });
  const off = await w.send('/api/connect/github/disconnect', {});
  assert.equal(off.json.sentence, 'Workbench is no longer connected to GitHub.');
  const gone = await w.send('/api/connect/keys/k1a2b3/remove', {});
  assert.equal(gone.json.sentence, 'Removed the key.');
  assert.equal((await w.send('/api/connect/keys/k000000/remove', {})).json.sentence, 'That key was already gone.');
  assert.deepEqual(w.connect.calls.filter(c => c[0] !== 'status'), [
    ['agentAction', 'codex', 'install'],
    ['agentAction', 'codex', 'signin'],
    ['setAgentKey', 'claude', key],
    ['setDefaultAgent', 'claude'],
    ['setGitIdentity', { name: 'Ada Lovelace', email: 'ada@example.invalid' }],
    ['setGitIdentity', { name: '', email: '' }],
    ['connectGithub', ghToken, { agentsUseIt: false }],
    ['connectGithub', ghToken, { agentsUseIt: true }],
    ['disconnectGithub'],
    ['removeKey', 'k1a2b3'],
    ['removeKey', 'k000000'],
  ]);
  // Every action answered with the status as it is after it.
  assert.equal(w.connect.calls.filter(c => c[0] === 'status').length, 11);
  // A key or a token missing: refused before Connect hears of it.
  w.connect.calls.length = 0;
  for (const [p, body, said] of [['/api/connect/agents/claude/key', {}, 'Paste the key first.'], ['/api/connect/agents/claude/key', { value: '   ' }, 'Paste the key first.'],
    ['/api/connect/agents/claude/key', { value: 42 }, 'Paste the key first.'], ['/api/connect/github', { agentsUseIt: true }, 'Paste the code GitHub made for you first.']]) {
    const r = await w.send(p, body);
    assert.equal(r.status, 400, p);
    assert.equal(r.json.error, said, p);
  }
  assert.deepEqual(w.connect.calls, []);
});

test('Agents & keys: a new key gets its secret names from the preset, never from the page, and "this repository" from Workbench', async (t) => {
  const w = await connectServer(t);
  const id = fakeKey('AK', 'IA').slice(0, 20).toUpperCase();
  const secret = fakeKey('wJal', 'rXUtnFEMI/');
  const added = await w.send('/api/connect/keys', {
    preset: 'aws', label: 'AWS', scope: 'repo', root: '/somewhere/else', agents: ['claude', 'codex', 'claude'],
    values: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: ` ${secret}\n`, AWS_SESSION_TOKEN: '', AWS_REGION: 'eu-west-1' },
    secretNames: [],
  });
  assert.equal(added.status, 200);
  assert.equal(added.json.sentence, 'Saved AWS, for this repository.');
  const openai = fakeKey('sk', '-proj-');
  await w.send('/api/connect/keys', { preset: 'openai', values: { OPENAI_API_KEY: openai } });
  await w.send('/api/connect/keys', { preset: 'custom', label: 'Sentry', scope: 'all', agents: 'all', values: { SENTRY_DSN: 'https://sentry.example/1', SENTRY_ENV: 'prod' } });
  // "This repository" goes to Connect in the key store's own shape ({ kind: 'repo', root }; the store refuses the bare
  // word), and Connect is told the repository either way.
  assert.deepEqual(w.connect.calls.filter(c => c[0] === 'addKey').map(c => c[1]), [
    { preset: 'aws', label: 'AWS', values: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'eu-west-1' },
      secretNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], scope: { kind: 'repo', root: '/work/shop' }, agents: ['claude', 'codex'], repoRoot: '/work/shop' },
    { preset: 'openai', label: 'OpenAI', values: { OPENAI_API_KEY: openai, CODEX_API_KEY: openai },
      secretNames: ['OPENAI_API_KEY', 'CODEX_API_KEY'], scope: { kind: 'all' }, agents: 'all', repoRoot: '/work/shop' },
    { preset: 'custom', label: 'Sentry', values: { SENTRY_DSN: 'https://sentry.example/1', SENTRY_ENV: 'prod' },
      secretNames: ['SENTRY_DSN', 'SENTRY_ENV'], scope: { kind: 'all' }, agents: 'all', repoRoot: '/work/shop' },
  ]);
  for (const r of [added]) assert.ok(!r.text.includes(secret) && !r.text.includes(id), 'no value comes back');
  // What a preset does not take, or leaves out, is refused in plain words, before the key store hears of it.
  w.connect.calls.length = 0;
  for (const [body, said] of [
    [{ preset: 'aws', values: { AWS_ACCESS_KEY_ID: id } }, 'Fill in AWS_SECRET_ACCESS_KEY.'],
    [{ preset: 'aws', values: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, PATH: '/tmp' } }, 'AWS keys take only AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN and AWS_REGION.'],
    [{ preset: 'nope', values: { A_B: secret } }, 'Workbench does not know that kind of key.'],
    [{ preset: 'Bad Preset!', values: { A_B: secret } }, 'Choose what kind of key this is.'],
    [{ preset: 'custom', values: [secret] }, 'Fill in the key first.'],
    [{ preset: 'custom', values: { A_B: '  ' } }, 'Fill in the key first.'],
    [{ preset: 'custom', values: { A_B: 7 } }, 'Each value must be text.'],
    [{ preset: 'custom', values: { '1ABC': secret } }, 'A name may have only letters, digits and _, and may not start with a digit.'],
    [{ preset: 'custom', values: { 'A B': secret } }, 'A name may have only letters, digits and _, and may not start with a digit.'],
    [{ preset: 'custom', values: JSON.parse(`{"__proto__": "${secret}"}`) }, 'A name may have only letters, digits and _, and may not start with a digit.'],
    [{ preset: 'custom', values: { A_B: secret }, scope: 'everywhere' }, 'Choose this repository or all repositories.'],
    [{ preset: 'custom', values: { A_B: secret }, agents: [] }, 'Choose which agents get the key.'],
    [{ preset: 'custom', values: { A_B: secret }, agents: ['claude', '../x'] }, 'Choose which agents get the key.'],
    [{ preset: 'custom', values: { A_B: secret }, agents: 'some' }, 'Choose which agents get the key.'],
  ]) {
    const r = await w.send('/api/connect/keys', body);
    assert.equal(r.status, 400, JSON.stringify(body.values));
    assert.equal(r.json.error, said);
    assert.ok(!r.text.includes(secret));
  }
  assert.deepEqual(w.connect.calls, []);
});

test('Agents & keys: when the kinds of key cannot be read, every value is kept as a secret; with no repository, a key is for all of them', async (t) => {
  const id = 'AKIA' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const w = await connectServer(t, { presets: null });
  const r = await w.send('/api/connect/keys', { preset: 'aws', values: { AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: id } });
  assert.equal(r.status, 200);
  assert.deepEqual(w.connect.calls.find(c => c[0] === 'addKey')[1], {
    preset: 'aws', label: 'Key', values: { AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: id }, secretNames: ['AWS_REGION', 'AWS_ACCESS_KEY_ID'], scope: { kind: 'all' }, agents: 'all', repoRoot: '/work/shop',
  });
  // The engine's repository is "this repository" when the server was given none; with neither, there is none.
  const engineRoot = await connectServer(t, { repoRoot: null });
  engineRoot.engine.repoInfo = { root: '/work/from-engine' };
  await engineRoot.send('/api/connect/keys', { preset: 'custom', scope: 'repo', values: { A_B: fakeKey('x') } });
  const fromEngine = engineRoot.connect.calls.find(c => c[0] === 'addKey')[1];
  assert.deepEqual([fromEngine.scope, fromEngine.repoRoot], [{ kind: 'repo', root: '/work/from-engine' }, '/work/from-engine']);
  const none = await connectServer(t, { repoRoot: null });
  const refused = await none.send('/api/connect/keys', { preset: 'custom', scope: 'repo', values: { A_B: fakeKey('x') } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error, 'Workbench is not working on a repository, so the key can only be for all repositories.');
  assert.ok(!none.connect.calls.some(c => c[0] === 'addKey'));
  assert.deepEqual(none.connect.calls.filter(c => c[0] === 'status'), []);
  assert.deepEqual((await none.get('/api/connect')).json.ok, true);
  assert.deepEqual(none.connect.calls.find(c => c[0] === 'status'), ['status', { repoRoot: null }]);
});

test('Agents & keys: refusals come back in plain words; anything else is logged without the key, and the person reads only that it failed', async (t) => {
  const w = await connectServer(t);
  const key = fakeKey('sk', '-ant-', 'api03-');
  // A refusal from Connect or the key store: its sentence, never its detail.
  w.connect.fail = Object.assign(new Error('That key is longer than 2000 characters, so Workbench cannot keep it.'), { why: 'value', detail: 'security: SecKeychainItemCreateFromContent: The specified item already exists.' });
  const refused = await w.send('/api/connect/agents/claude/key', { value: key });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.json, { error: 'That key is longer than 2000 characters, so Workbench cannot keep it.' });
  // A refusal that repeats what was sent: the key is cut out.
  w.connect.fail = Object.assign(new Error(`GitHub did not accept ${key}.`), { why: 'github' });
  const echoed = await w.send('/api/connect/github', { token: key });
  assert.equal(echoed.json.error, 'GitHub did not accept ••••.');
  // A crash: a generic sentence for the person, and a log line without the key.
  w.connect.fail = new TypeError(`Cannot read properties of undefined (reading '${key}')`);
  const crash = await w.send('/api/connect/agents/claude/key', { value: key });
  assert.equal(crash.status, 500);
  assert.equal(crash.json.error, 'Something went wrong in the workbench. The details are in its log.');
  assert.equal(w.lines.length, 1);
  assert.match(w.lines[0], /^Agents & keys could not do that: TypeError: Cannot read properties of undefined \(reading '••••'\)/);
  // The place keys are kept failed (the key store's `store`, given 500 by Connect): its sentence, with that status, and
  // a line in the log; never its detail, nor the key.
  w.connect.fail = Object.assign(new Error(`Workbench could not save the key in your keychain, because your keychain is locked. ${key}`),
    { plain: true, why: 'store', status: 500, detail: 'security save: locked, exit 51' });
  const locked = await w.send('/api/connect/agents/claude/key', { value: key });
  assert.equal(locked.status, 500);
  assert.deepEqual(locked.json, { error: 'Workbench could not save the key in your keychain, because your keychain is locked. ••••' });
  assert.equal(w.lines.length, 2);
  assert.equal(w.lines[1], 'Agents & keys could not do that: Workbench could not save the key in your keychain, because your keychain is locked. ••••');
  // A status that is not an HTTP error's is no status: a refusal with one answers 400.
  w.connect.fail = Object.assign(new Error('That key cannot be used.'), { why: 'value', status: 302 });
  assert.equal((await w.send('/api/connect/agents/claude/key', { value: key })).status, 400);
  for (const r of [refused, echoed, crash, locked]) assert.ok(!r.text.includes(key));
  assert.ok(!w.lines.join('\n').includes(key));
  assert.ok(!w.lines.join('\n').includes('exit 51'), 'the detail stays out of the log');
  // A body over 16 KB is refused before anyone reads it.
  const big = await w.send('/api/connect/agents/claude/key', { value: 'x'.repeat(17 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'The request is too large. The limit is 16 KB.');
  assert.ok(!w.connect.calls.some(c => c[0] === 'setAgentKey' && c[2].length > 16 * 1024));
});

test('Agents & keys: who gets the GitHub token changes without the token; the refusals keep their kind, and the body is checked first', async (t) => {
  const w = await connectServer(t);
  const on = await w.send('/api/connect/github/agents', { agentsUseIt: true });
  assert.equal(on.status, 200);
  assert.equal(on.headers['cache-control'], 'no-store');
  assert.deepEqual({ ok: on.json.ok, sentence: on.json.sentence, why: on.json.why, github: on.json.status.github.agentsUseIt },
    { ok: true, sentence: 'Agents can use your GitHub token now, as GH_TOKEN.', why: undefined, github: true });
  const off = await w.send('/api/connect/github/agents', { agentsUseIt: false });
  assert.equal(off.json.sentence, 'Agents no longer get your GitHub token. Git still uses it.');
  assert.deepEqual(w.connect.calls.filter(c => c[0] === 'setGithubAgentsUseIt'), [['setGithubAgentsUseIt', true], ['setGithubAgentsUseIt', false]]);
  // Connect cannot read the token back: a 200 that says so, with its kind and a fresh status.
  const said = 'Workbench could not read the GitHub token it keeps, so this cannot change. Disconnect GitHub, then connect it again.';
  w.connect.githubAnswer = { ok: false, why: 'token', sentence: said };
  const blind = await w.send('/api/connect/github/agents', { agentsUseIt: true });
  assert.equal(blind.status, 200);
  assert.deepEqual({ ok: blind.json.ok, why: blind.json.why, sentence: blind.json.sentence }, { ok: false, why: 'token', sentence: said });
  assert.equal(typeof blind.json.status, 'object');
  w.connect.githubAnswer = null;
  // GitHub is not connected: Connect's 409, with its sentence.
  w.connect.fail = Object.assign(new Error('GitHub is not connected.'), { plain: true, why: 'github', status: 409 });
  const none = await w.send('/api/connect/github/agents', { agentsUseIt: true });
  assert.equal(none.status, 409);
  assert.deepEqual(none.json, { error: 'GitHub is not connected.' });
  // Only true or false, and the checks of every Agents & keys route, before Connect hears of it.
  w.connect.calls.length = 0;
  for (const body of [{}, { agentsUseIt: 'yes' }, { agentsUseIt: 1 }, { agentsUseIt: null }, { token: fakeKey('gh', 'p_') }]) {
    const r = await w.send('/api/connect/github/agents', body);
    assert.equal(r.status, 400, JSON.stringify(Object.keys(body)));
    assert.deepEqual(r.json, { error: 'Choose whether agents may use the GitHub token.' });
  }
  assert.equal((await w.send('/api/connect/github/agents', { agentsUseIt: true }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await request({ at: w.at, method: 'POST', path: '/api/connect/github/agents', body: { agentsUseIt: true }, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await w.send('/api/connect/github/agents', '{"agentsUseIt":true}', { 'Content-Type': 'text/plain' })).status, 415);
  const big = await w.send('/api/connect/github/agents', { agentsUseIt: true, pad: 'x'.repeat(17 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error, 'The request is too large. The limit is 16 KB.');
  const wrong = await w.get('/api/connect/github/agents');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST');
  assert.deepEqual(w.connect.calls, []);
  // Without the connect service, it is not there, as every Agents & keys route.
  const without = await post('/api/connect/github/agents', { agentsUseIt: true });
  assert.equal(without.status, 404);
  assert.equal(without.json.error, 'Agents & keys is not available in this Workbench. The details are in its log.');
});

test('Agents & keys with the real connect service and key store: a key for this repository is kept for it, and who gets the GitHub token changes without it', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-keys-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repoRoot = path.join(home, 'shop');
  fs.mkdirSync(repoRoot);
  // Values in private files in this home folder: never the keychain. GitHub and git are stand-ins.
  const keys = new KeyStore({ home, platform: 'linux', backend: 'file' });
  const ghToken = fakeKey('gh', 'p_');
  const gitCalls = [];
  const connect = new Connect({
    home, platform: 'linux', env: { PATH: '/usr/bin:/bin', HOME: home }, keys, adapters: {}, probe: false,
    workspace: {
      async gitConfigIdentity() { return { name: '', email: '' }; },
      async approveGitCredential({ username }) { gitCalls.push(['approve', username]); return { helper: true }; },
      async rejectGitCredential({ username }) { gitCalls.push(['reject', username]); return { ok: true }; },
    },
    fetchJson: async (url, { headers } = {}) => (url === 'https://api.github.com/user' && headers.Authorization === `Bearer ${ghToken}`
      ? { status: 200, json: { login: 'octocat' } } : { status: 401, json: null }),
  });
  const s = new Store();
  const e = new FakeEngine(s);
  e.mode = 'live';
  const lines = [];
  const log = { info() {}, debug() {}, warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const srv = createServer({ engine: e, store: s, token: TOKEN, connect, repoRoot, port: 0, rootDir: ROOT, log, options: { coalesceMs: 40, pingMs: 60_000 } });
  const { url } = await srv.listen();
  t.after(() => srv.close());
  const at = Number(new URL(url).port);
  const send = (p, body) => request({ at, method: 'POST', path: p, body, headers: auth({ 'Content-Type': 'application/json' }) });

  // A key for this repository reaches the key store in its own shape, kept for the repository Workbench runs on.
  const id = fakeKey('AK', 'IA').slice(0, 20).toUpperCase();
  const secret = fakeKey('wJal', 'rXUtnFEMI/');
  const added = await send('/api/connect/keys', { preset: 'aws', scope: 'repo', values: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'eu-west-1' } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.sentence, 'Saved AWS, for this repository.');
  const kept = JSON.parse(fs.readFileSync(path.join(home, '.workbench', 'keys.json'), 'utf8')).keys;
  assert.deepEqual(kept.map(k => [k.preset, k.scope, k.agents]), [['aws', { kind: 'repo', root: repoRoot }, 'all']]);
  assert.match(added.json.status.keys[0].sentence, /^AWS for this repository, given to all agents: AWS_ACCESS_KEY_ID •••• [^,]+, AWS_SECRET_ACCESS_KEY •••• [^,]+, AWS_REGION eu-west-1$/);
  assert.deepEqual(connect.envFor({ repoRoot, harness: 'claude' }), { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'eu-west-1' });
  assert.deepEqual(connect.envFor({ repoRoot: home, harness: 'claude' }), {}, 'not for another folder');

  // Who gets the GitHub token: refused while GitHub is not connected, then changed both ways without the token.
  const early = await send('/api/connect/github/agents', { agentsUseIt: true });
  assert.equal(early.status, 409);
  assert.deepEqual(early.json, { error: 'GitHub is not connected.' });
  const gh = await send('/api/connect/github', { token: ghToken });
  assert.deepEqual([gh.status, gh.json.login, gh.json.status.github.agentsUseIt], [200, 'octocat', false]);
  assert.equal(connect.envFor({ repoRoot, harness: 'codex' }).GH_TOKEN, undefined, 'for git only at first');
  const on = await send('/api/connect/github/agents', { agentsUseIt: true });
  assert.deepEqual([on.status, on.json.ok, on.json.sentence, on.json.status.github.agentsUseIt], [200, true, 'Agents can use your GitHub token now, as GH_TOKEN.', true]);
  assert.equal(connect.envFor({ repoRoot, harness: 'codex' }).GH_TOKEN, ghToken);
  const off = await send('/api/connect/github/agents', { agentsUseIt: false });
  assert.deepEqual([off.status, off.json.ok, off.json.status.github.agentsUseIt], [200, true, false]);
  assert.equal(connect.envFor({ repoRoot, harness: 'codex' }).GH_TOKEN, undefined);
  assert.deepEqual(gitCalls, [['approve', 'octocat']]);

  // The place values are kept fails (a file where their folder goes): the key store's sentence, with a 500, and a
  // line in the log.
  fs.rmSync(path.join(home, '.workbench', 'keys'), { recursive: true, force: true });
  fs.writeFileSync(path.join(home, '.workbench', 'keys'), 'not a folder\n');
  const broken = await send('/api/connect/keys', { preset: 'custom', label: 'Sentry', values: { SENTRY_DSN: fakeKey('https://', 'sentry.example/') } });
  assert.equal(broken.status, 500, broken.text);
  assert.match(broken.json.error, /^Workbench (could not save the key in|does not keep keys in) .*keys/);
  assert.deepEqual(lines, [`Agents & keys could not do that: ${broken.json.error}`]);
  for (const r of [added, early, gh, on, off, broken]) {
    for (const v of [id, secret, ghToken]) assert.ok(!r.text.includes(v), 'no value comes back');
  }
});

test('Agents & keys: when what is ready changes, every page gets one fresh snapshot; nothing when nothing changed', async (t) => {
  const w = await connectServer(t);
  const sse = await openSse(`/api/stream?t=${TOKEN}`, w.at);
  try {
    assert.deepEqual((await sse.next('snapshot')).data.connect, { ready: false, defaultAgent: null });
    // A re-check found Claude Code: Connect says so twice in a burst; pages hear once.
    w.engine.connectSummary = { ready: true, defaultAgent: 'claude' };
    w.connect.emit('agents', { claude: { ok: true }, codex: { ok: false } });
    w.connect.emit('changed');
    assert.deepEqual((await sse.next('snapshot')).data.connect, { ready: true, defaultAgent: 'claude' });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sse.pending.filter(e => e.event === 'snapshot').length, 0, 'one snapshot for the burst');
    // A key was added: nothing the board shows changed, so no snapshot.
    w.connect.emit('changed');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sse.pending.filter(e => e.event === 'snapshot').length, 0);
  } finally {
    sse.close();
  }
  await w.srv.close();
  assert.equal(w.connect.listenerCount('agents'), 0);
  assert.equal(w.connect.listenerCount('changed'), 0);
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
function openSse(p, at = port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request({ host: '127.0.0.1', port: at, path: p, agent: false, headers: { Host: `127.0.0.1:${at}`, Accept: 'text/event-stream' } }, (res) => {
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
