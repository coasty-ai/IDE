// The local web server: the UI files, a JSON API, a Server-Sent Events stream, and the
// PreToolUse hook endpoint. It listens on 127.0.0.1 only and checks, on every request it must:
// the Host header, a 32-byte token compared in constant time, and for POSTs the Origin,
// the JSON content type and a 64 KB body limit. No CORS headers are ever sent.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BODY = 64 * 1024;
const DRAIN_LIMIT = 1024 * 1024;   // read and discard at most this much of an oversized body
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
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

/**
 * @param {object} opts
 * @param {object} opts.engine     the Engine (or a fake with the same methods)
 * @param {object} opts.store      the Store, for live updates
 * @param {string} opts.token      32 random bytes as hex; needed by every /api and /hook route
 * @param {string} [opts.hookToken] a second token that works for /hook routes only (given to agents)
 * @param {number} [opts.port]     0 picks a free port
 * @param {string} [opts.host]     always 127.0.0.1
 * @param {string} [opts.rootDir]  folder that holds ui/ and src/shared/
 * @param {object} [opts.log]
 * @param {object} [opts.options]  { coalesceMs = 250, pingMs = 15000, requestTimeoutMs, checkIntervalMs } (tests shorten these)
 * @returns {{ listen(): Promise<{ url: string }>, close(): Promise<void>, readonly url: string|null, readonly port: number|null }}
 */
export function createServer({ engine, store, token, hookToken = null, port = 4317, host = '127.0.0.1', rootDir = DEFAULT_ROOT, log, options = {} } = {}) {
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

  /** Read the body as JSON: at most 64 KB, an object, or empty (treated as {}). */
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > DRAIN_LIMIT) {
        reject(new HttpError(413, 'The request is too large. The limit is 64 KB.'));
        req.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          // Keep reading so the client gets the 413 instead of a reset connection.
          tooBig = true;
          if (size > DRAIN_LIMIT) {
            reject(new HttpError(413, 'The request is too large. The limit is 64 KB.'));
            req.destroy();
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return reject(new HttpError(413, 'The request is too large. The limit is 64 KB.'));
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

  async function serveStatic(req, res, pathname) {
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
  if (store?.on) {
    store.on('agents', onAgents);
    store.on('machines', onMachines);
    store.on('notice', onNotice);
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

  const routes = [
    { method: 'GET', re: /^\/api\/state$/, run: () => engine.snapshot() },
    { method: 'GET', re: /^\/api\/stream$/, stream: true },
    { method: 'POST', re: /^\/api\/command$/, run: (b) => engine.command(str(b.text), { focusId: b.focusId ?? null }) },
    { method: 'POST', re: /^\/api\/confirm\/([^/]+)$/, run: (b, m) => engine.confirm(id(m[1]), b.go === true) },
    {
      method: 'POST', re: /^\/api\/agents$/,
      run: (b) => engine.startAgent({ task: str(b.task), harness: b.harness, model: b.model, machineId: b.machineId, budgetUsd: b.budgetUsd, name: b.name }),
    },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/answer$/, run: (b, m) => engine.answer(id(m[1]), { askId: b.askId ?? null, answer: b.answer }) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/say$/, run: (b, m) => engine.say(id(m[1]), str(b.text)) },
    { method: 'POST', re: /^\/api\/agents\/([^/]+)\/stop$/, run: (b, m) => engine.stop(id(m[1])) },
    { method: 'POST', re: /^\/api\/machines\/([^/]+)\/awake$/, run: (b, m) => engine.setMachineAwake(id(m[1]), b.awake === true) },
    { method: 'POST', re: /^\/hook\/pretool$/, hook: true },
  ];

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    const isHook = pathname.startsWith('/hook/');
    const header = req.headers['x-workbench-token'];
    const given = typeof header === 'string' ? header : (req.method === 'GET' ? url.searchParams.get('t') : null);
    const allowed = isHook
      ? tokenMatches(given, token) || (hookToken ? tokenMatches(given, hookToken) : false)
      : tokenMatches(given, token);
    if (!allowed) return sendJson(res, 401, { error: 'Missing or wrong token.' });

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
        body = await readJson(req);
      } catch (err) {
        if (err.status === 413) res.setHeader('Connection', 'close');
        return sendError(res, err);
      }
    }

    if (route.stream) return openStream(req, res);
    if (route.hook) return handleHook(req, res, body);
    const m = pathname.match(route.re);
    const result = await route.run(body, m);
    sendJson(res, 200, result ?? {});
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
    return serveStatic(req, res, p);
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

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        boundPort = server.address().port;
        resolve({ url: `http://127.0.0.1:${boundPort}/` });
      });
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    store?.off?.('agents', onAgents);
    store?.off?.('machines', onMachines);
    store?.off?.('notice', onNotice);
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
