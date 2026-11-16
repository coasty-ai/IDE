// The local web server: the UI files, a JSON API, a Server-Sent Events stream, and the
// PreToolUse hook endpoint. It listens on 127.0.0.1 only and checks, on every request it must:
// the Host header, a 32-byte token compared in constant time (on the hook route, also the asking
// agent's own hook token), and for POSTs the Origin, the JSON content type and a 64 KB body limit
// (16 KB on the Agents & keys routes, which carry keys: never echoed, never logged, never in a URL).
// A page address with a query is served only when the query carries the token. No CORS headers are ever sent.
// The page goes out with the person's look, detail and first answer on its <html> tag (src/core/prefs.mjs), and the
// permission mode the engine has on (data-permissions), so the Full permissions button is right from the first paint.
// Unless the person chose a port, each run takes a free one picked at random, so the page's address (its origin) is
// new every time, and only by a rare chance one another program served before: what that program left in the browser
// for its address is almost never there to read this run's key. A port something else answers on is never taken.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE } from '../shared/states.mjs';
import { memoryPrefs, cleanPrefs, prefsChange, pageWithPrefs } from '../core/prefs.mjs';

const MAX_BODY = 64 * 1024;
const MAX_CONNECT_BODY = 16 * 1024; // Agents & keys: a few keys of at most 2000 characters each
const CONNECT_ID_RE = /^[a-z][a-z0-9-]{0,39}$/; // an agent or a key preset, as Workbench names them
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/; // a variable's name (the key store refuses the dangerous ones)
/** What the Agents & keys routes answer when this Workbench has no connect service. */
const NO_CONNECT_DEMO = 'The demo’s agents are simulated, so there is nothing to connect. Run Workbench on a repository to connect your own agents and keys.';
const NO_CONNECT = 'Agents & keys is not available in this Workbench. The details are in its log.';
const DRAIN_LIMIT = 1024 * 1024;   // read and discard at most this much of an oversized body
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
/** Where a free port is picked from (the ports no service is registered for), how many picks, and how long a knock waits. */
const PICK_FROM = 49152;
const PICK_TO = 65535;
const PICK_TRIES = 20;
const KNOCK_MS = 300;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
});

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const STATES = new Set(Object.values(STATE));

/** An error with an HTTP status and a plain message for the person. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/** Constant-time token comparison (hashing first makes the lengths equal). */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function makeLog(log) {
  const noop = () => {};
  if (!log) return { info: noop, warn: noop, error: noop, debug: noop };
  if (typeof log === 'function' && !log.warn) {
    return { info: (...a) => log('info', ...a), warn: (...a) => log('warn', ...a), error: (...a) => log('error', ...a), debug: (...a) => log('debug', ...a) };
  }
  return {
    info: (...a) => log.info?.(...a),
    warn: (...a) => (log.warn || log.info)?.(...a),
    error: (...a) => (log.error || log.warn || log.info)?.(...a),
    debug: (...a) => log.debug?.(...a),
  };
}

/** Every string of 8 or more characters a request carried as a key, so no answer or log line can repeat one. */
function secretsIn(body) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 8) out.push(v, v.trim()); };
  add(body?.value);
  add(body?.token);
  if (body?.values && typeof body.values === 'object') for (const v of Object.values(body.values)) add(v);
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** "A, B and C". */
function joinAnd(parts) {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The text with each of `secrets` replaced by "••••". */
function redact(text, secrets) {
  let s = String(text ?? '');
  for (const v of secrets) s = s.split(v).join('••••');
  return s;
}

/** An error whose message is a plain sentence for the person: ours, or a connect or key-store refusal (`.why`). */
function isPlainError(err) {
  return !!err && typeof err.message === 'string' && err.message.trim() !== ''
    && (err instanceof HttpError || typeof err.why === 'string' || err.plain === true || err.expose === true);
}

/**
 * @param {object} opts
 * @param {object} opts.engine     the Engine (or a fake with the same methods)
 * @param {object} opts.store      the Store, for live updates
 * @param {string} opts.token      32 random bytes as hex; needed by every /api and /hook route
 * @param {(agentId: string) => string} [opts.hookTokenFor] each agent's own hook token (64 hex characters); it opens
 *        /hook/pretool for that one agent only, and never /api
 * @param {object} [opts.connect]  the connect service (src/core/connect.mjs) for the Agents & keys routes; without it
 *        (the demo) they answer 404 with a plain sentence
 * @param {string} [opts.repoRoot] the repository's folder, for keys kept for "this repository" (else the engine's)
 * @param {object} [opts.prefs]    the person's choices for the page, `{ get(), set(change) }` (createPrefs in
 *        src/core/prefs.mjs, which keeps them in ~/.workbench/prefs.json); without it, kept for this run only
 * @param {number} [opts.port]     the port the person chose; without it (or 0), a free one picked at random, new each run
 * @param {string} [opts.host]     always 127.0.0.1
 * @param {string} [opts.rootDir]  folder that holds ui/ and src/shared/
 * @param {object} [opts.log]
 * @param {object} [opts.options]  { coalesceMs = 250, pingMs = 15000, requestTimeoutMs, checkIntervalMs } (tests shorten these),
 *        keyPresets: a stand-in for src/shared/keypresets.mjs ({ presetById }), and pickPort: a stand-in for the random
 *        pick of a port, for tests
 * @returns {{ listen(): Promise<{ url: string }>, close(): Promise<void>, readonly url: string|null, readonly port: number|null }}
 */
export function createServer({ engine, store, token, hookTokenFor = null, connect = null, repoRoot = null, prefs = memoryPrefs(), port = 0, host = '127.0.0.1', rootDir = DEFAULT_ROOT, log, options = {} } = {}) {
  if (!engine) throw new Error('The server needs the engine.');
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error('The server token must be 32 random bytes written as hex.');
  }
  const L = makeLog(log);
  if (host !== '127.0.0.1') L.warn(`Ignoring host ${host}: the workbench only listens on 127.0.0.1.`);
  const coalesceMs = options.coalesceMs ?? 250;
  const pingMs = options.pingMs ?? 15_000;
  const uiDir = path.resolve(rootDir, 'ui');
  const sharedDir = path.resolve(rootDir, 'src', 'shared');
  const realRoots = new Map(); // dir -> Promise<realpath>

  let boundPort = null;
  const clients = new Set();     // SSE responses
  const hookAborts = new Set();  // AbortControllers of held hook requests
  const pendingIds = new Set();  // agent ids changed since the last flush
  let flushTimer = null;
  let pingTimer = null;
  let closed = false;

  // ------------------------------------------------------------ responses

  function sendJson(res, status, body) {
    if (res.headersSent || res.destroyed) return;
    const data = Buffer.from(JSON.stringify(body ?? {}));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function sendError(res, err) {
    const status = err.status || (err.plain || err.expose ? 400 : 500);
    const message = (err.status || err.plain || err.expose) && err.message
      ? err.message
      : 'Something went wrong in the workbench. The details are in its log.';
    if (status >= 500) L.error('Request failed:', err?.stack || err);
    sendJson(res, status, { error: message });
  }

  // ------------------------------------------------------------ request checks

  function hostAllowed(req) {
    const h = String(req.headers.host || '').toLowerCase();
    return boundPort != null && (h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}`);
  }

  /** Read the body as JSON: at most `limit` bytes (64 KB unless the route says less), an object, or empty (treated as {}). */
  function readJson(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const tooLarge = () => new HttpError(413, `The request is too large. The limit is ${Math.round(limit / 1024)} KB.`);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > DRAIN_LIMIT) {
        reject(tooLarge());
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          // Keep reading so the client gets the 413 instead of a reset connection.
          tooBig = true;
          if (size > DRAIN_LIMIT) {
            reject(tooLarge());
            req.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return reject(tooLarge());
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (!text) return resolve({});
        let body;
        try { body = JSON.parse(text); } catch { return reject(new HttpError(400, 'The request body is not valid JSON.')); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'The request body must be a JSON object.'));
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  // ------------------------------------------------------------ static files

  function realRoot(dir) {
    if (!realRoots.has(dir)) realRoots.set(dir, fsp.realpath(dir).catch(() => null));
    return realRoots.get(dir);
  }

  async function serveStatic(req, res, url) {
    const pathname = url.pathname;
    let base;
    let rel;
    if (pathname === '/' || pathname === '/index.html') { base = uiDir; rel = 'index.html'; }
    else if (pathname.startsWith('/ui/')) { base = uiDir; rel = pathname.slice(4); }
    else if (pathname.startsWith('/shared/')) { base = sharedDir; rel = pathname.slice(8); }
    else return sendJson(res, 404, { error: 'Not found.' });

    let decoded;
    try { decoded = decodeURIComponent(rel); } catch { return sendJson(res, 400, { error: 'That address is not valid.' }); }
    const parts = decoded.split(/[\\/]+/);
    // No traversal, no hidden files, no empty names (directories), no NUL bytes.
    if (!decoded || decoded.includes('\0') || parts.some(p => p === '' || p === '..' || p.startsWith('.'))) {
      return sendJson(res, 404, { error: 'Not found.' });
    }
    if (base === sharedDir && !decoded.endsWith('.mjs')) return sendJson(res, 404, { error: 'Not found.' });

    const file = path.resolve(base, decoded);
    if (!isInside(base, file)) return sendJson(res, 404, { error: 'Not found.' });
    const root = await realRoot(base);
    let real;
    try { real = await fsp.realpath(file); } catch { return sendJson(res, 404, { error: 'Not found.' }); }
    if (!root || !isInside(root, real)) return sendJson(res, 404, { error: 'Not found.' }); // symlinks out of the root
    let st;
    try { st = await fsp.stat(real); } catch { return sendJson(res, 404, { error: 'Not found.' }); }
    if (!st.isFile()) return sendJson(res, 404, { error: 'Not found.' }); // no directory listing

    // The page reads its own address (the key and the debug switches). Any website can send the person's tab to an
    // address here, so a page address with a query is served only when the query carries this run's key; anything
    // else goes to the plain page. Checked on the file found, so /index.html, /ui/index.html and encoded forms count.
    if (url.search && path.extname(real).toLowerCase() === '.html' && !tokenMatches(url.searchParams.get('t'), token)) {
      res.writeHead(303, { Location: '/', 'Content-Length': 0, 'Cache-Control': 'no-store' });
      return res.end();
    }

    // The page itself goes out with the person's look, detail and first answer on its <html> tag, so its first paint
    // is already right. Workbench keeps them (prefs), not the page's own storage. The permission mode is the engine's,
    // the one on in this run, never one only the file says (another run may have kept it).
    if (base === uiDir && real === path.join(root, 'index.html')) {
      let text;
      try { text = await fsp.readFile(real, 'utf8'); } catch { return sendJson(res, 404, { error: 'Not found.' }); }
      const page = Buffer.from(pageWithPrefs(text, { ...prefsNow(), permissions: modeNow() }));
      res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Content-Length': page.length, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : page);
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ------------------------------------------------------------ live updates (SSE)

  function frame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function write(res, text) {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > SSE_MAX_BUFFER) { res.destroy(); return; } // a stuck reader
    res.write(text);
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const text = frame(event, data);
    for (const res of clients) write(res, text);
  }

  function flushAgents() {
    flushTimer = null;
    if (!pendingIds.size) return;
    const views = [];
    for (const id of pendingIds) {
      const v = store?.get?.(id);
      if (v) views.push(v);
    }
    pendingIds.clear();
    if (views.length) broadcast('agents', views);
  }

  const onAgents = (ids) => {
    if (!clients.size || !Array.isArray(ids)) return;
    for (const id of ids) pendingIds.add(id);
    if (!flushTimer) flushTimer = setTimeout(flushAgents, coalesceMs);
  };
  // The full machine list, so the UI can either replace or merge by id.
  const onMachines = () => broadcast('machines', store?.machines?.() || []);
  const onNotice = (n) => {
    if (!n || n.text == null) return;
    broadcast('notice', n.agentId ? { text: String(n.text), agentId: n.agentId } : { text: String(n.text) });
  };
  const onRemoved = () => {
    let snap;
    try { snap = engine.snapshot(); } catch (err) { L.error('Snapshot failed:', err); return; }
    broadcast('snapshot', snap);
  };
  // The person's repository changed (a merge moved their branch; a refresh found a new head, branch, number of
  // uncommitted changes or git identity): { name, head, branch, dirty, identity }.
  const onRepo = (repo) => {
    let data = repo;
    if (!data || typeof data !== 'object') {
      try { data = engine.snapshot()?.repo ?? null; } catch (err) { L.error('Snapshot failed:', err); return; }
    }
    broadcast('repo', data);
  };
  if (store?.on) {
    store.on('agents', onAgents);
    store.on('machines', onMachines);
    store.on('notice', onNotice);
    // An earlier agent the person forgot: the stream has no "removed", so every page gets a fresh snapshot.
    store.on('removed', onRemoved);
    store.on('repo', onRepo);
  }
  // Full permissions went on or off: every page gets a fresh snapshot, whose `permissions` lights the band's button.
  const onPermissions = () => onRemoved();
  if (typeof engine.on === 'function') engine.on('permissions', onPermissions);
  // A setup card opened or closed (launches wait on it): every page gets a fresh snapshot, whose `setup` is the card.
  const onSetup = () => onRemoved();
  if (typeof engine.on === 'function') engine.on('setup', onSetup);
  // Agents & keys found an agent, or lost one, or the default changed: the snapshot's harnesses and connect summary say
  // so (the top band's light, the lid). Every page gets a fresh snapshot, once per burst, and only when they changed.
  let connectTimer = null;
  let connectSeen = null; // those parts of the last snapshot a page was sent
  const connectPart = (snap) => {
    try { return JSON.stringify([snap?.harnesses ?? null, snap?.harnessInfo ?? null, snap?.connect ?? null, snap?.meta?.connect ?? null]); } catch { return null; }
  };
  const onConnect = () => {
    if (!clients.size || connectTimer) return;
    connectTimer = setTimeout(() => {
      connectTimer = null;
      let snap;
      try { snap = engine.snapshot(); } catch (err) { L.error('Snapshot failed:', err); return; }
      const seen = connectPart(snap);
      if (seen !== null && seen === connectSeen) return;
      connectSeen = seen;
      broadcast('snapshot', snap);
    }, coalesceMs);
    connectTimer.unref?.();
  };
  if (connect?.on) {
    connect.on('agents', onConnect);
    connect.on('changed', onConnect);
  }

  function openStream(req, res) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let snap;
    try { snap = engine.snapshot(); } catch (err) { L.error('Snapshot failed:', err); snap = {}; }
    res.write('retry: 2000\n\n' + frame('snapshot', snap));
    connectSeen = connectPart(snap);
    clients.add(res);
    if (!pingTimer) {
      pingTimer = setInterval(() => { for (const c of clients) write(c, ': ping\n\n'); }, pingMs);
      pingTimer.unref?.();
    }
    res.on('close', () => {
      clients.delete(res);
      if (!clients.size) {
        clearInterval(pingTimer);
        pingTimer = null;
        clearTimeout(flushTimer);
        flushTimer = null;
        pendingIds.clear();
      }
    });
  }

  // ------------------------------------------------------------ API routes

  const id = (s) => {
    let v;
    try { v = decodeURIComponent(s); } catch { v = ''; }
    if (!ID_RE.test(v)) throw new HttpError(404, 'Not found.');
    return v;
  };
  const str = (v) => (v == null ? '' : String(v));
  // An id from a body, or null: anything that is not an id string is as if nothing was sent.
  const optId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  // A state the page drew a button for (STATE in states.mjs), or null: anything else is as if nothing was sent.
  const optState = (v) => (typeof v === 'string' && STATES.has(v) ? v : null);

  const routes = [
    { method: 'GET', re: /^\/api\/state$/, run: () => engine.snapshot() },
    { method: 'GET', re: /^\/api\/stream$/, stream: true },
    // The git screen and an agent's diff: read-only. Merge and throw away only ever return a confirm card; they act on
    // POST /api/confirm/:id { go: true }.
    { method: 'GET', re: /^\/api\/git$/, run: () => engine.gitGraph() },
    { method: 'GET', re: /^\/api\/agents\/([^/]+)\/changes$/, run: (b, m) => engine.changes(id(m[1])) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/merge$/, run: (b, m) => engine.proposeMerge(id(m[1]), { state: optState(b.state) }) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/discard$/, run: (b, m) => engine.proposeDiscard(id(m[1]), { state: optState(b.state) }) },
    {
      // What the page showed when the person began: the agent, the confirm card and the ask on screen.
      method: 'POST', re: /^\/api\/command$/,
      run: (b) => engine.command(str(b.text), { focusId: optId(b.focusId), confirmId: optId(b.confirmId), askId: optId(b.askId) }),
    },
    { method: 'POST', re: /^\/api\/confirm\/([^/]+)$/, run: (b, m) => engine.confirm(id(m[1]), b.go === true) },
    {
      method: 'POST', re: /^\/api\/agents$/,
      run: (b) => engine.startAgent({ task: str(b.task), harness: b.harness, model: b.model, machineId: b.machineId, budgetUsd: b.budgetUsd, name: b.name }),
    },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/answer$/, run: (b, m) => engine.answer(id(m[1]), { askId: optId(b.askId), answer: b.answer }) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/say$/, run: (b, m) => engine.say(id(m[1]), str(b.text)) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/stop$/, run: (b, m) => engine.stop(id(m[1])) },
    // One more spending limit for this run, for an agent that reached its own; `state`: what the button was drawn for.
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/raise-limit$/, run: (b, m) => engine.raiseLimit(id(m[1]), { state: optState(b.state) }) },
    { method: 'POST', re: /^\/api\/machines\/([^/]+)\/awake$/, run: (b, m) => engine.setMachineAwake(id(m[1]), b.awake === true) },
    // The person's choices for the page: { theme, detail, answered }. A change carries one or more of them (prefsChange).
    { method: 'GET', re: /^\/api\/prefs$/, run: () => pageChoices(prefsNow()) },
    { method: 'POST', re: /^\/api\/prefs$/, run: (b) => keepPrefs(b) },
    // Full permissions: { mode: 'full' } answers the engine's card (only its yes turns them on, through
    // POST /api/confirm/:id); { mode: 'ask' } turns them off at once. Agents never have the page's key.
    { method: 'POST', re: /^\/api\/permissions$/, run: (b) => engine.permissions(modeOf(b.mode)) },
    { method: 'POST', re: /^\/hook\/pretool$/, hook: true },
    // Agents & keys. Each answers { ok, sentence, status } with a fresh ConnectStatus (src/core/connect.mjs), or { error }
    // with a plain sentence and a 4xx code (500 when the place keys are kept failed). Keys come in the body only, and
    // never go out again: not in an answer, not in the log. `status` never holds a key's value.
    { method: 'GET', re: /^\/api\/connect$/, connect: true, run: () => done() },
    { method: 'POST', re: /^\/api\/connect\/recheck$/, connect: true, run: async () => { await connect.recheck(); return done(); } },
    {
      // Terminal, running the vendor's own installer (macOS); elsewhere the command, for the page to show.
      method: 'POST', re: /^\/api\/connect\/agents\/([^/]+)\/install$/, connect: true,
      run: async (b, m) => terminalAnswer(await connect.agentAction(agentId(m[1]), 'install')),
    },
    {
      // Sign in: in the browser, the vendor's own login program run by Workbench (`console: true`: Claude Code's
      // Anthropic Console account), answered at once while it waits; or with `terminal: true` in Terminal, as Install.
      method: 'POST', re: /^\/api\/connect\/agents\/([^/]+)\/signin$/, connect: true,
      run: async (b, m) => {
        const id = agentId(m[1]);
        if (b.terminal === true) return terminalAnswer(await connect.agentAction(id, 'signin', b.console === true ? { console: true } : {}));
        const r = await connect.agentSignIn(id, { console: b.console === true });
        return done(r, null, { waiting: r?.waiting === true, ...(r?.ok === false && typeof r.why === 'string' ? { why: r.why } : {}) });
      },
    },
    { method: 'POST', re: /^\/api\/connect\/agents\/([^/]+)\/signin\/cancel$/, connect: true, run: async (b, m) => done(await connect.cancelAgentSignIn(agentId(m[1]))) },
    {
      method: 'POST', re: /^\/api\/connect\/agents\/([^/]+)\/key$/, connect: true,
      run: async (b, m) => done(await connect.setAgentKey(agentId(m[1]), secret(b.value, 'Paste the key first.'))),
    },
    { method: 'POST', re: /^\/api\/connect\/agents\/([^/]+)\/default$/, connect: true, run: async (b, m) => done(await connect.setDefaultAgent(agentId(m[1]))) },
    {
      // Install git: on a Mac, Apple's own installer for its developer tools; elsewhere the sentence that says how.
      method: 'POST', re: /^\/api\/connect\/git\/install$/, connect: true,
      run: async () => {
        const r = await connect.installGitTools();
        return done(r, null, r?.ok === false && typeof r.why === 'string' ? { why: r.why } : {});
      },
    },
    {
      method: 'POST', re: /^\/api\/connect\/git$/, connect: true,
      run: async (b) => done(await connect.setGitIdentity({ name: text(b.name), email: text(b.email) }), 'Git now has your name and email.'),
    },
    {
      method: 'POST', re: /^\/api\/connect\/github$/, connect: true,
      run: async (b) => {
        const r = await connect.connectGithub(secret(b.token, 'Paste the code GitHub made for you first.'), { agentsUseIt: b.agentsUseIt === true });
        return done(r, null, { login: typeof r?.login === 'string' && r.login ? r.login : null });
      },
    },
    { method: 'POST', re: /^\/api\/connect\/github\/disconnect$/, connect: true, run: async () => done(await connect.disconnectGithub(), 'Workbench is no longer connected to GitHub.') },
    // GitHub through gh, GitHub's command-line tool. Sign in answers at once, with status.github.signingIn (the download,
    // the one-time code, or Terminal), and goes on by itself; the page reads /api/connect again while it is set. Cancel
    // stops it. Sign out answers `opened` (Terminal), and `command` when gh could not sign out and Terminal could not open.
    { method: 'POST', re: /^\/api\/connect\/github\/signin$/, connect: true, run: async () => ghDone(await connect.githubSignIn()) },
    { method: 'POST', re: /^\/api\/connect\/github\/signin\/cancel$/, connect: true, run: async () => ghDone(await connect.cancelGithubSignIn()) },
    { method: 'POST', re: /^\/api\/connect\/github\/signout$/, connect: true, run: async () => ghDone(await connect.githubSignOut(), true) },
    {
      // "Let agents use this token", changed without the token: Connect reads it back from the key store. When it
      // cannot, the answer is { ok: false, why: 'token', sentence, status }; with GitHub not connected, a 409.
      method: 'POST', re: /^\/api\/connect\/github\/agents$/, connect: true,
      run: async (b) => {
        if (typeof b.agentsUseIt !== 'boolean') throw new HttpError(400, 'Choose whether agents may use the GitHub token.');
        const r = await connect.setGithubAgentsUseIt(b.agentsUseIt);
        return done(r, null, r?.ok === false && typeof r.why === 'string' ? { why: r.why } : {});
      },
    },
    { method: 'POST', re: /^\/api\/connect\/keys$/, connect: true, run: (b) => addKey(b) },
    {
      method: 'POST', re: /^\/api\/connect\/keys\/([^/]+)\/remove$/, connect: true,
      run: async (b, m) => {
        const r = await connect.removeKey(id(m[1]));
        return done(r, r?.removed === false ? 'That key was already gone.' : 'Removed the key.');
      },
    },
  ];

  // ------------------------------------------------------------ the person's choices for the page

  /** The page's own choices from what is kept: the look, the detail and the first answer, never the permission mode. */
  const pageChoices = (p) => ({ theme: p.theme, detail: p.detail, answered: p.answered });
  /** The permission mode on in this run, as the engine has it: 'full' or 'ask'. */
  const modeNow = () => (engine.permissionMode === 'full' ? 'full' : 'ask');
  /** A mode a request asks for: 'full' or 'ask', else a 400 with a plain sentence. */
  const modeOf = (v) => {
    if (v !== 'full' && v !== 'ask') throw new HttpError(400, 'Say whether agents should ask first or have full permissions.');
    return v;
  };

  /** What is kept now, each a known value or its default; a store that fails to read gives the defaults. */
  function prefsNow() {
    try {
      return cleanPrefs(prefs.get());
    } catch (err) {
      L.warn('Workbench could not read the page’s choices:', err?.message || err);
      return cleanPrefs(null);
    }
  }

  /**
   * POST /api/prefs: the change, checked (a 400 with a plain sentence for anything the page does not offer), kept by
   * the store. `{ ok: true, theme, detail, answered }`; when the store could not save it, `ok: false` and its sentence
   * as `reply`: the choice still lasts for this run.
   */
  function keepPrefs(b) {
    const r = prefs.set(prefsChange(b));
    const now = pageChoices(r?.prefs ? cleanPrefs(r.prefs) : prefsNow());
    if (r?.ok === false) return { ok: false, reply: typeof r.sentence === 'string' && r.sentence ? r.sentence : 'Workbench could not keep that choice.', ...now };
    return { ok: true, ...now };
  }

  // ------------------------------------------------------------ Agents & keys

  /** The repository whose keys "this repository" means: the one Workbench was started on. Null in the demo. */
  const rootNow = () => (typeof repoRoot === 'string' && repoRoot ? repoRoot : (typeof engine.repoInfo?.root === 'string' ? engine.repoInfo.root : null));
  /** An agent's id from the address: claude, codex, … Connect refuses one it does not know. */
  const agentId = (s) => {
    const v = id(s);
    if (!CONNECT_ID_RE.test(v)) throw new HttpError(404, 'Not found.');
    return v;
  };
  /** Text from a body, or '' for anything else: an object is never turned into "[object Object]". */
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  /** A key from a body, trimmed (a pasted key often brings a line break with it). */
  const secret = (v, missing) => {
    const t = text(v);
    if (!t) throw new HttpError(400, missing);
    return t;
  };
  /** The answer to an Agents & keys request: what Connect said, and what is connected now. */
  async function done(r = null, fallback = null, extra = {}) {
    const said = typeof r?.sentence === 'string' && r.sentence.trim() ? r.sentence.trim() : fallback;
    const status = await connect.status({ repoRoot: rootNow() });
    return { ...extra, ok: r?.ok !== false, sentence: said ?? null, status };
  }
  /** The answer to a GitHub-through-gh request: `why` when Connect said no; for sign-out, `opened` and any `command`. */
  function ghDone(r, terminal = false) {
    const extra = r?.ok === false && typeof r.why === 'string' ? { why: r.why } : {};
    if (terminal) {
      extra.opened = r?.opened === true;
      if (typeof r?.command === 'string' && r.command) extra.command = r.command;
    }
    return done(r, null, extra);
  }
  /** The answer when Connect opened Terminal (`opened`), or gave the command to run in one (`command`). */
  const terminalAnswer = (r) => done(r, null, { opened: r?.opened === true, ...(typeof r?.command === 'string' && r.command ? { command: r.command } : {}) });

  // src/shared/keypresets.mjs, loaded on first use: { presetById } or null. Tests may give their own (options.keyPresets),
  // or null for "it could not be read".
  let presets = options.keyPresets === null ? null
    : (typeof options.keyPresets?.presetById === 'function' ? options.keyPresets : undefined);
  async function keyPresets() {
    if (presets === undefined) {
      presets = await import('../shared/keypresets.mjs').then((mod) => (typeof mod.presetById === 'function' ? mod : null), (err) => {
        L.warn('Workbench could not load its kinds of key, so every value is kept as a secret:', err?.message || err);
        return null;
      });
    }
    return presets;
  }

  /**
   * POST /api/connect/keys { preset, label, values, scope: 'all'|'repo', agents: 'all'|[ids] }. Which values are secret
   * comes from the preset, never from the page: a field the preset marks secret, and every value of a custom key (or of
   * any key, when the presets cannot be read). A preset's `also` names get the same value ("OPENAI_API_KEY, also
   * CODEX_API_KEY"). Values are trimmed, and empty ones are left out. "This repository" is the one Workbench runs on.
   */
  async function addKey(b) {
    const presetId = typeof b.preset === 'string' && CONNECT_ID_RE.test(b.preset) ? b.preset : null;
    if (!presetId) throw new HttpError(400, 'Choose what kind of key this is.');
    if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new HttpError(400, 'Fill in the key first.');
    const values = {};
    for (const [name, v] of Object.entries(b.values)) {
      if (!KEY_NAME_RE.test(name) || name === '__proto__') throw new HttpError(400, 'A name may have only letters, digits and _, and may not start with a digit.');
      if (typeof v !== 'string') throw new HttpError(400, 'Each value must be text.');
      if (v.trim()) values[name] = v.trim();
    }
    const mod = await keyPresets();
    const preset = mod ? mod.presetById(presetId) : null;
    if (mod && !preset) throw new HttpError(400, 'Workbench does not know that kind of key.');
    let secretNames = Object.keys(values);
    const fields = preset && presetId !== 'custom' && Array.isArray(preset.fields) ? preset.fields : null;
    if (fields) {
      const alsoOf = (f) => (Array.isArray(f.also) ? f.also : []);
      const known = new Set(fields.flatMap(f => [f.name, ...alsoOf(f)]));
      if (Object.keys(values).some(n => !known.has(n))) {
        throw new HttpError(400, `${preset.label || 'Those'} keys take only ${joinAnd(fields.map(f => f.name))}.`);
      }
      for (const f of fields) {
        const v = values[f.name];
        if (!v && !f.optional) throw new HttpError(400, `Fill in ${f.name}.`);
        if (v) for (const also of alsoOf(f)) if (!values[also]) values[also] = v;
      }
      secretNames = fields.filter(f => f.secret).flatMap(f => [f.name, ...alsoOf(f)]).filter(n => n in values);
    }
    if (!Object.keys(values).length) throw new HttpError(400, 'Fill in the key first.');
    const scope = b.scope === 'repo' ? 'repo' : (b.scope === 'all' || b.scope == null ? 'all' : null);
    if (!scope) throw new HttpError(400, 'Choose this repository or all repositories.');
    const root = rootNow();
    if (scope === 'repo' && !root) throw new HttpError(400, 'Workbench is not working on a repository, so the key can only be for all repositories.');
    const agents = b.agents === 'all' || b.agents == null ? 'all'
      : (Array.isArray(b.agents) && b.agents.length && b.agents.length <= 20 && b.agents.every(a => typeof a === 'string' && CONNECT_ID_RE.test(a)) ? [...new Set(b.agents)] : null);
    if (!agents) throw new HttpError(400, 'Choose which agents get the key.');
    const label = text(b.label) || (typeof preset?.label === 'string' && preset.label) || 'Key';
    // The key store's own shape for "this repository" ({ kind: 'repo', root }): it refuses the bare word 'repo'.
    const r = await connect.addKey({
      preset: presetId, label, values, secretNames, scope: scope === 'repo' ? { kind: 'repo', root } : { kind: 'all' }, agents, repoRoot: root,
    });
    return done(r, `Saved ${label}, for ${scope === 'repo' ? 'this repository' : 'all repositories'}.`);
  }

  /**
   * Run an Agents & keys route. Without the connect service (the demo), a plain 404. A refusal from Connect or the key
   * store (an error with `.why`) answers its sentence with its status (400 when it has none; 500 when the place keys
   * are kept failed, which the log notes too); anything else is logged, and the person reads only that something went
   * wrong. Whatever the request carried as a key is cut out of all of them.
   */
  async function handleConnect(res, route, body, m) {
    if (!connect) return sendJson(res, 404, { error: engine.mode === 'demo' ? NO_CONNECT_DEMO : NO_CONNECT });
    const secrets = secretsIn(body);
    let out;
    try {
      out = await route.run(body, m);
    } catch (err) {
      if (isPlainError(err)) {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 400;
        const said = redact(err.message, secrets);
        if (status >= 500) L.warn('Agents & keys could not do that:', said);
        return sendJson(res, status, { error: said });
      }
      L.error('Agents & keys could not do that:', redact(err?.stack || String(err), secrets));
      return sendJson(res, 500, { error: 'Something went wrong in the workbench. The details are in its log.' });
    }
    if (out && typeof out.sentence === 'string') out.sentence = redact(out.sentence, secrets);
    return sendJson(res, 200, out ?? {});
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    const isHook = pathname.startsWith('/hook/');
    const header = req.headers['x-workbench-token'];
    const given = typeof header === 'string' ? header : (req.method === 'GET' ? url.searchParams.get('t') : null);
    const pageToken = tokenMatches(given, token);
    // An agent's own hook token is checked against the agent the body names, once the body is read.
    const maybeHook = isHook && typeof hookTokenFor === 'function' && typeof given === 'string' && /^[0-9a-f]{64}$/.test(given);
    if (!pageToken && !maybeHook) return sendJson(res, 401, { error: 'Missing or wrong token.' });

    const matches = routes.filter(r => r.re.test(pathname));
    if (!matches.length) return sendJson(res, 404, { error: 'Not found.' });
    const route = matches.find(r => r.method === req.method);
    if (!route) {
      res.setHeader('Allow', [...new Set(matches.map(r => r.method))].join(', '));
      return sendJson(res, 405, { error: 'That method is not allowed here.' });
    }

    let body = {};
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin !== undefined && String(origin).toLowerCase() !== `http://${String(req.headers.host).toLowerCase()}`) {
        return sendJson(res, 403, { error: 'Requests from other sites are not allowed.' });
      }
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') return sendJson(res, 415, { error: 'Send JSON, with Content-Type: application/json.' });
      try {
        body = await readJson(req, route.connect ? MAX_CONNECT_BODY : MAX_BODY);
      } catch (err) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return sendError(res, err);
      }
    }

    if (route.stream) return openStream(req, res);
    if (route.hook) {
      if (!pageToken && !hookTokenOk(given, body.agentId)) return sendJson(res, 401, { error: 'Missing or wrong token.' });
      return handleHook(req, res, body);
    }
    const m = pathname.match(route.re);
    if (route.connect) return handleConnect(res, route, body, m);
    const result = await route.run(body, m);
    sendJson(res, 200, result ?? {});
  }

  /** Whether `given` is the hook token of exactly this agent (compared in constant time). */
  function hookTokenOk(given, agentId) {
    if (typeof hookTokenFor !== 'function' || typeof agentId !== 'string' || !ID_RE.test(agentId)) return false;
    let expected;
    try { expected = hookTokenFor(agentId); } catch { return false; }
    return typeof expected === 'string' && tokenMatches(given, expected);
  }

  /** POST /hook/pretool may wait many minutes for the person: no timeouts on this request. */
  async function handleHook(req, res, body) {
    req.socket.setTimeout(0);
    res.setTimeout(0);
    const ac = new AbortController();
    hookAborts.add(ac);
    // If the agent goes away (its hook was killed), tell the engine so it can drop the ask.
    res.on('close', () => {
      hookAborts.delete(ac);
      if (!res.writableFinished) ac.abort();
    });
    try {
      const out = await engine.hookPreToolUse(str(body.agentId), body.payload ?? {}, { signal: ac.signal });
      if (!res.destroyed) sendJson(res, 200, out ?? {});
    } finally {
      hookAborts.delete(ac);
    }
  }

  // ------------------------------------------------------------ the server

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req)) return sendJson(res, 403, { error: 'This address is not allowed.' });
    let url;
    try { url = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`); } catch { return sendJson(res, 400, { error: 'That address is not valid.' }); }
    const p = url.pathname;
    if (p === '/api' || p.startsWith('/api/') || p === '/hook' || p.startsWith('/hook/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'That method is not allowed here.' });
    }
    return serveStatic(req, res, url);
  }

  // requestTimeout only limits receiving a request; held hook and SSE responses are not cut by it
  // (the tests check this with short values).
  const server = http.createServer({
    requestTimeout: options.requestTimeoutMs ?? 300_000,
    connectionsCheckingInterval: options.checkIntervalMs ?? 30_000,
  }, (req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  /** Listen on 127.0.0.1 at this port (0: the system picks): resolves the port. */
  function bind(p) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(server.address().port);
      });
    });
  }

  /**
   * Whether anything answers on this port at 127.0.0.1 or [::1]. On a Mac, 127.0.0.1 can be bound beside a listener on
   * 0.0.0.0 or [::], which served http://127.0.0.1:<port>/ until then; one on [::1] gets http://localhost:<port>/. No
   * answer either way within KNOCK_MS counts as taken.
   */
  function answers(p) {
    const knock = (h) => new Promise((resolve) => {
      const s = net.connect({ host: h, port: p, timeout: KNOCK_MS });
      const done = (v) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(true));
      s.once('timeout', () => done(true));
      s.once('error', () => done(false));
    });
    return Promise.all([knock('127.0.0.1'), knock('::1')]).then(([a, b]) => a || b);
  }

  const pickPort = typeof options.pickPort === 'function' ? options.pickPort : () => crypto.randomInt(PICK_FROM, PICK_TO + 1);
  const inUse = (p) => Object.assign(new Error(`Port ${p} is already in use.`), { code: 'EADDRINUSE', port: p });

  /**
   * The port the person chose, when nothing else answers there (else EADDRINUSE, as when it is bound); otherwise a
   * free one picked at random: up to PICK_TRIES picks nothing answers on, then the system picks.
   */
  async function listen() {
    if (port) {
      if (await answers(port)) throw inUse(port);
      boundPort = await bind(port);
    } else {
      for (let i = 0; i < PICK_TRIES && boundPort == null; i++) {
        const p = Number(pickPort());
        if (!Number.isInteger(p) || p < 1 || p > 65535 || await answers(p)) continue;
        try {
          boundPort = await bind(p);
        } catch (err) {
          if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
        }
      }
      if (boundPort == null) boundPort = await bind(0);
    }
    return { url: `http://127.0.0.1:${boundPort}/` };
  }

  async function close() {
    if (closed) return;
    closed = true;
    store?.off?.('agents', onAgents);
    store?.off?.('removed', onRemoved);
    store?.off?.('repo', onRepo);
    store?.off?.('machines', onMachines);
    store?.off?.('notice', onNotice);
    connect?.off?.('agents', onConnect);
    connect?.off?.('changed', onConnect);
    if (typeof engine.off === 'function') engine.off('permissions', onPermissions);
    if (typeof engine.off === 'function') engine.off('setup', onSetup);
    clearTimeout(connectTimer);
    clearTimeout(flushTimer);
    clearInterval(pingTimer);
    for (const ac of hookAborts) ac.abort();
    for (const res of clients) res.end();
    clients.clear();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    listen,
    close,
    get url() { return boundPort == null ? null : `http://127.0.0.1:${boundPort}/`; },
    get port() { return boundPort; },
  };
}
