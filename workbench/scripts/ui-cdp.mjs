// A minimal Chrome DevTools driver for the UI scripts (ui-fit-check, ui-behaviour-check, ui-shots). No dependencies:
// it starts headless Chrome with its own empty profile, talks to it over the DevTools WebSocket, and stops only the
// Chrome it started. CHROME_BIN overrides the Chrome path.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ width = 1440, height = 900, dpr = 1 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-ui-'));
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${dir}`, `--window-size=${width},${height}`,
    `--force-device-scale-factor=${dpr}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let port = null;
  for (let i = 0; i < 150 && !port; i++) { await sleep(100); const f = path.join(dir, 'DevToolsActivePort'); if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0].trim(); }
  if (!port) { proc.kill('SIGTERM'); throw new Error('Chrome did not start (set CHROME_BIN?)'); }
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map(), listeners = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
    else if (d.method) for (const l of listeners) l(d);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  // Windows key codes for punctuation, as Chrome expects them: a character's own code would name another key ('.' is
  // 46, which is Delete, so a typed "a.b" became "ab"). Anything else typed as text gets 0, which only inserts it.
  const PUNCT = { '.': [190, 'Period'], ',': [188, 'Comma'], '-': [189, 'Minus'], '=': [187, 'Equal'], '/': [191, 'Slash'], ';': [186, 'Semicolon'],
    "'": [222, 'Quote'], '`': [192, 'Backquote'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'], '\\': [220, 'Backslash'] };
  const keyCode = k => (k === ' ' ? 32 : k === 'Tab' ? 9 : k === 'Enter' ? 13 : k === 'Escape' ? 27 : k === 'ArrowRight' ? 39 : k === 'ArrowLeft' ? 37 : k === 'ArrowDown' ? 40 : k === 'ArrowUp' ? 38
    : PUNCT[k] ? PUNCT[k][0] : k.length === 1 && /[a-z0-9]/i.test(k) ? k.toUpperCase().charCodeAt(0) : 0);
  const code = k => (k === ' ' ? 'Space' : PUNCT[k] ? PUNCT[k][1] : k.length === 1 ? (/[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /[0-9]/.test(k) ? 'Digit' + k : '') : k);
  const b = {
    send, ev, pid: proc.pid,
    on: fn => listeners.push(fn),
    size: (w, h, scale = dpr) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false }),
    goto: async (url, ms = 1200) => { await send('Page.navigate', { url }); await sleep(ms); },
    beforeLoad: source => send('Page.addScriptToEvaluateOnNewDocument', { source }),
    mouse: async (x, y, click = false) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (click) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
    },
    /** Press a key; `phase` 'down' or 'up' sends only that half (holding space). */
    key: async (k, { phase = 'both', shift = false } = {}) => {
      const base = { key: k, code: code(k), windowsVirtualKeyCode: keyCode(k), modifiers: shift ? 8 : 0 };
      if (phase !== 'up') await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: k.length === 1 ? k : k === 'Enter' ? '\r' : undefined });
      if (phase !== 'down') await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    type: async text => { for (const ch of text) await b.key(ch); },
    shot: async (file, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); writeFileSync(file, Buffer.from(r.data, 'base64')); return file; },
    close: async () => { try { ws.close(); } catch { /* gone */ } proc.kill('SIGTERM'); await sleep(400); rmSync(dir, { recursive: true, force: true }); },
  };
  return b;
}

/** Collect script errors, failed loads and console errors from a page. `skip` filters messages that are expected. */
export function errorsOf(b, skip = /status of 401|favicon/) {
  const errors = [];
  b.on(m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 300));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') { const t = m.params.entry.text + ' ' + (m.params.entry.url || ''); if (!skip.test(t)) errors.push('log: ' + t.slice(0, 300)); }
  });
  return errors;
}
