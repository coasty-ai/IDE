// The receipt for a finished agent: which of the repository's rules its changes kept or broke, and
// the results of the checks the repository declares in workbench.json.
//
// Checks are the one place the workbench runs shell strings: commands the repository owner wrote.
// Each runs through /bin/sh -c in the agent's folder, in its own process group, with a scrubbed
// environment and a timeout that kills the whole group.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Environment keys Claude Code sets for itself: a check must not look like it runs inside Claude Code. The engine does
 * give each check its agent's WORKBENCH_AGENT_ID, which is kept, so a Workbench started from a check refuses to run
 * real agents, as it does in the agent's own shell.
 */
const SCRUB = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK)/;
/** Also removed: the secret that lets a process answer permission requests. */
const SECRETS = ['WORKBENCH_HOOK_TOKEN'];
/** A variable name a key may use: letters, digits and _, not starting with a digit. */
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TAIL_BYTES = 2048;
/**
 * With a mask, the output kept has this many bytes to spare before the tail shown, so that a key at the start of the
 * tail is whole when it is masked (a key is at most 2000 characters, of up to 4 bytes each); where a key may have been
 * cut (MASK_MARGIN characters at most) is left out (maskCut).
 */
const MASK_SPARE_BYTES = 8192;
const MASK_MARGIN = 2048;
const DEFAULT_TIMEOUT_SEC = 300;
const KILL_GRACE_MS = 2000; // SIGTERM first, then SIGKILL this long after
const DRAIN_MS = 250; // after the shell exits, how long its output may keep arriving
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
/** Process groups of the checks running now, so a program that is exiting can end them at once. */
const RUNNING = new Set();

/**
 * On process exit: end every running check's process group with SIGKILL, synchronously. A check is spawned in its
 * own group and its timers live in this process, so once this process has gone nothing would ever end it.
 */
export function killChecksSync() {
  for (const pid of RUNNING) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  RUNNING.clear();
}

// ---------------------------------------------------------------------------------------------
// Rules

/** "./src//a.js" -> "src/a.js": relative to the repository root, forward slashes. */
function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** "*" and "?" inside one path segment. Linear time: no backtracking blow-up on long names. */
function matchSegment(pat, s) {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === s[i])) { p++; i++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = i; }
    else if (star !== -1) { p = star + 1; i = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

/**
 * Does a glob match a path? Both are relative to the repository root, with forward slashes.
 * `*` and `?` stay inside one folder name; a `**` segment matches any number of whole folders,
 * including none. A trailing `/` means everything inside: "docs/" is "docs/**".
 */
export function matchGlob(glob, file) {
  if (typeof glob !== 'string' || typeof file !== 'string') return false;
  let g = normPath(glob.trim());
  if (!g) return false;
  if (g.endsWith('/')) g += '**';
  const gs = g.split('/');
  const ps = normPath(file).split('/');
  const memo = new Map();
  const walk = (i, j) => {
    const key = i * (ps.length + 1) + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === gs.length) r = j === ps.length;
    else if (gs[i] === '**') r = walk(i + 1, j) || (j < ps.length && walk(i, j + 1));
    else r = j < ps.length && matchSegment(gs[i], ps[j]) && walk(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return walk(0, 0);
}

/**
 * Which rules the changed paths kept and which they broke.
 * @param {{ say: string, paths: string[] }[]} rules from workbench.json
 * @param {(string|{ path: string })[]} changedPaths paths relative to the repository root
 * @returns {{ kept: { say: string }[], broken: { say: string, paths: string[] }[] }}
 */
export function checkRules(rules, changedPaths) {
  const paths = [...new Set((Array.isArray(changedPaths) ? changedPaths : [])
    .map(p => (typeof p === 'string' ? p : p && typeof p.path === 'string' ? p.path : null))
    .filter(Boolean)
    .map(normPath))];
  const kept = [];
  const broken = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || typeof rule.say !== 'string' || !rule.say.trim()) continue;
    const globs = (Array.isArray(rule.paths) ? rule.paths : [rule.paths]).filter(g => typeof g === 'string' && g.trim());
    const hits = paths.filter(p => globs.some(g => matchGlob(g, p)));
    if (hits.length) broken.push({ say: rule.say, paths: hits });
    else kept.push({ say: rule.say });
  }
  return { kept, broken };
}

// ---------------------------------------------------------------------------------------------
// Checks

/** A copy of the environment without Claude Code's own variables or the workbench's secret. */
export function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (SCRUB.test(k) || SECRETS.includes(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * A copy of the checks' environment with the person's keys for the repository added (`keysEnv`: { NAME: value }),
 * after the scrub. Left out: WORKBENCH_* names (so no key can replace the WORKBENCH_AGENT_ID the engine gives in
 * `env`), names the scrub removes, names that are not variable names, and values that are not strings or hold a NUL.
 * Returned unchanged when there are no keys.
 */
export function withKeys(env, keysEnv) {
  if (!keysEnv || typeof keysEnv !== 'object') return env;
  let out = env;
  for (const [k, v] of Object.entries(keysEnv)) {
    if (!KEY_NAME_RE.test(k) || k.startsWith('WORKBENCH_') || SCRUB.test(k) || SECRETS.includes(k) || typeof v !== 'string' || v.includes('\0')) continue;
    if (out === env) out = { ...env };
    out[k] = v;
  }
  return out;
}

/** A mask (text -> text) that never throws and always gives a string; null when none is given. */
function safeMask(mask) {
  if (typeof mask !== 'function') return null;
  return (s) => {
    try {
      const out = mask(s);
      return typeof out === 'string' ? out : s;
    } catch {
      return s;
    }
  };
}

/** Is there a `node` program in one of these PATH folders? Relative folders do not count. */
function nodeOnPath(pathValue) {
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      const p = path.join(dir, 'node');
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch { /* not here */ }
  }
  return false;
}

/**
 * The checks' PATH: when it has no node, the folder of the node running Workbench goes first, so a check such as
 * `npm test` works for a person whose own PATH lacks node. The same rule as for agents (withNodeOnPath in
 * src/adapters/claude/args.mjs). Returned unchanged when a node is on PATH already.
 */
export function withNodeOnPath(env, execPath = process.execPath) {
  const current = typeof env.PATH === 'string' ? env.PATH : '';
  if (nodeOnPath(current)) return env;
  return { ...env, PATH: `${path.dirname(execPath)}${path.delimiter}${current || '/usr/bin:/bin'}` };
}

/**
 * `raw`, the kept end of a check's output, with the person's keys hidden. When earlier output was dropped
 * (`truncated`), `raw` may begin inside a key that was cut, which no mask can find, so its start is left out: up to its
 * first line break (a key holds none), or MASK_MARGIN characters when there is none that near (a cut key is shorter),
 * but never past where the mask first hid something, since a whole key began there. The same rule as for agents'
 * output (maskCut in src/adapters/claude/args.mjs).
 */
function maskCut(raw, mask, truncated) {
  const masked = mask(raw);
  if (!truncated) return masked;
  const nl = raw.indexOf('\n');
  const unsafe = nl >= 0 && nl < MASK_MARGIN ? nl + 1 : MASK_MARGIN;
  const n = Math.min(unsafe, raw.length, masked.length);
  let same = 0;
  while (same < n && raw.charCodeAt(same) === masked.charCodeAt(same)) same++;
  return masked.slice(Math.min(same, unsafe));
}

/**
 * Keeps only the last `limit` bytes of everything pushed into it, or, with a mask, `limit` plus MASK_SPARE_BYTES, so the
 * person's keys can be hidden before the tail is cut.
 */
class Tail {
  constructor(limit, mask = null) {
    this.limit = limit;
    this.mask = mask;
    this.keep = mask ? limit + MASK_SPARE_BYTES : limit;
    this.chunks = [];
    this.size = 0;
    this.cut = false; // earlier output was dropped
  }

  push(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(b);
    this.size += b.length;
    if (this.size > this.keep * 4) this.compact();
  }

  compact() {
    const all = Buffer.concat(this.chunks);
    const keep = all.subarray(Math.max(0, all.length - this.keep));
    if (keep.length < all.length) this.cut = true;
    this.chunks = [Buffer.from(keep)];
    this.size = keep.length;
  }

  /**
   * The tail as text, plus an optional closing note on its own line, within the byte limit. With a mask, the person's
   * keys are hidden first, and when earlier output was dropped, where a key may have been cut is left out (maskCut).
   */
  text(note = '') {
    let out = Buffer.concat(this.chunks);
    if (this.mask) out = Buffer.from(maskCut(out.toString('utf8'), this.mask, this.cut), 'utf8');
    if (note) {
      let end = out.length;
      while (end > 0 && [10, 13, 32, 9].includes(out[end - 1])) end--; // no blank line before the note
      out = Buffer.concat([out.subarray(0, end), Buffer.from((end ? '\n' : '') + note)]);
    }
    let start = Math.max(0, out.length - this.limit);
    while (start < out.length && (out[start] & 0xc0) === 0x80) start++; // do not begin mid-character
    return out.subarray(start).toString('utf8').replace(ANSI, '');
  }
}

function checkName(check, i) {
  if (typeof check.name === 'string' && check.name.trim()) return check.name.trim();
  return check.run.trim().slice(0, 40) || `Check ${i + 1}`;
}

/**
 * Run one check. Never rejects.
 * @returns {Promise<{ name: string, ok: boolean, ms: number, tail: string, exitCode: number|null, timedOut: boolean }>}
 */
function runOne(check, name, cwd, env, signal, mask) {
  const sec = Number(check.timeoutSec) > 0 ? Number(check.timeoutSec) : DEFAULT_TIMEOUT_SEC;
  return new Promise(resolve => {
    const started = Date.now();
    const tail = new Tail(TAIL_BYTES, mask);
    if (typeof cwd !== 'string' || !fs.existsSync(cwd)) {
      resolve({ name, ok: false, ms: 0, tail: `Could not start this check because the folder ${cwd} does not exist.`, exitCode: null, timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn('/bin/sh', ['-c', check.run], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ name, ok: false, ms: 0, tail: `Could not start this check: ${e.message}`, exitCode: null, timedOut: false });
      return;
    }
    let timedOut = false;
    let stopped = false;
    let exitCode = null;
    let startError = null;
    let done = false;
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    // detached: true made the shell the leader of a new process group; -pid reaches all of it.
    const killGroup = sig => {
      if (!child.pid) return;
      try { process.kill(-child.pid, sig); } catch {}
    };
    if (child.pid) RUNNING.add(child.pid);
    const terminate = () => {
      killGroup('SIGTERM');
      later(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    later(() => { timedOut = true; terminate(); }, sec * 1000);
    const onAbort = () => { stopped = true; terminate(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      killGroup('SIGKILL'); // anything the check left running in the background
      RUNNING.delete(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      let note = '';
      if (startError) note = `Could not start this check: ${startError.message}`;
      else if (timedOut) note = `Stopped after ${sec} second${sec === 1 ? '' : 's'} because it took too long.`;
      else if (stopped) note = 'Stopped because the agent was stopped.';
      resolve({
        name,
        ok: !startError && !timedOut && !stopped && exitCode === 0,
        ms: Date.now() - started,
        tail: tail.text(note).trim(),
        exitCode,
        timedOut,
      });
    };

    child.stdout.on('data', d => tail.push(d));
    child.stderr.on('data', d => tail.push(d));
    child.on('error', e => { startError = e; finish(); });
    child.on('close', finish);
    child.on('exit', code => {
      exitCode = code;
      // A background process can hold the output open after the shell has gone. Give the output a
      // moment, then end the group so 'close' can fire; give up waiting soon after either way.
      later(() => killGroup('SIGKILL'), DRAIN_MS);
      later(finish, DRAIN_MS + 1000);
    });
  });
}

/**
 * Run the repository's declared checks, one after another, in the agent's folder.
 * @param {{ cwd: string, checks: { name?: string, run: string, timeoutSec?: number }[],
 *   onProgress?: (p: { phase: 'start'|'end', index: number, total: number, name: string, result?: object, results: object[] }) => void,
 *   env?: object, keysEnv?: object, mask?: (text: string) => string, signal?: AbortSignal }} opts
 *   env defaults to process.env (it is scrubbed either way, and gets node on its PATH when it has none);
 *   keysEnv ({ NAME: value }) is the person's keys for this repository, added after the scrub (see withKeys);
 *   mask hides those keys in each check's output, before its tail is cut;
 *   signal stops the running check.
 * @returns {Promise<{ state: 'passed'|'failed'|'none', results: { name: string, ok: boolean, ms: number, tail: string }[] }>}
 */
export async function runChecks({ cwd, checks, onProgress, env, keysEnv, mask, signal } = {}) {
  const list = (Array.isArray(checks) ? checks : []).filter(c => c && typeof c.run === 'string' && c.run.trim());
  if (!list.length) return { state: 'none', results: [] };
  const childEnv = withKeys(withNodeOnPath(scrubEnv(env || process.env)), keysEnv);
  const hide = safeMask(mask);
  const progress = p => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(p); } catch {} // a broken listener must not break the checks
  };
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const name = checkName(list[i], i);
    progress({ phase: 'start', index: i, total: list.length, name, results: [...results] });
    const result = signal && signal.aborted
      ? { name, ok: false, ms: 0, tail: 'Not run because the agent was stopped.', exitCode: null, timedOut: false }
      : await runOne(list[i], name, cwd, childEnv, signal, hide);
    results.push(result);
    progress({ phase: 'end', index: i, total: list.length, name, result, results: [...results] });
  }
  return { state: results.every(r => r.ok) ? 'passed' : 'failed', results };
}
