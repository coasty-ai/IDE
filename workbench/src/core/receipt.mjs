// The receipt for a finished agent: which of the repository's rules its changes kept or broke, and
// the results of the checks the repository declares in workbench.json.
//
// Checks are the one place the workbench runs shell strings: commands the repository owner wrote.
// Each runs through /bin/sh -c in the agent's folder, in its own process group, with a scrubbed
// environment and a timeout that kills the whole group.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Environment keys Claude Code sets for itself; a check must not look like it runs inside an agent. */
const SCRUB = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK)/;
/** Also removed: the secret that lets a process answer permission requests. */
const SECRETS = ['WORKBENCH_HOOK_TOKEN'];
const TAIL_BYTES = 2048;
const DEFAULT_TIMEOUT_SEC = 300;
const KILL_GRACE_MS = 2000; // SIGTERM first, then SIGKILL this long after
const DRAIN_MS = 250; // after the shell exits, how long its output may keep arriving
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');

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

/** Keeps only the last `limit` bytes of everything pushed into it. */
class Tail {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(b);
    this.size += b.length;
    if (this.size > this.limit * 4) this.compact();
  }

  compact() {
    const all = Buffer.concat(this.chunks);
    const keep = all.subarray(Math.max(0, all.length - this.limit));
    this.chunks = [Buffer.from(keep)];
    this.size = keep.length;
  }

  /** The tail as text, plus an optional closing note on its own line, within the byte limit. */
  text(note = '') {
    let out = Buffer.concat(this.chunks);
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
function runOne(check, name, cwd, env, signal) {
  const sec = Number(check.timeoutSec) > 0 ? Number(check.timeoutSec) : DEFAULT_TIMEOUT_SEC;
  return new Promise(resolve => {
    const started = Date.now();
    const tail = new Tail(TAIL_BYTES);
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
 *   env?: object, signal?: AbortSignal }} opts
 *   env defaults to process.env (it is scrubbed either way); signal stops the running check.
 * @returns {Promise<{ state: 'passed'|'failed'|'none', results: { name: string, ok: boolean, ms: number, tail: string }[] }>}
 */
export async function runChecks({ cwd, checks, onProgress, env, signal } = {}) {
  const list = (Array.isArray(checks) ? checks : []).filter(c => c && typeof c.run === 'string' && c.run.trim());
  if (!list.length) return { state: 'none', results: [] };
  const childEnv = scrubEnv(env || process.env);
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
      : await runOne(list[i], name, cwd, childEnv, signal);
    results.push(result);
    progress({ phase: 'end', index: i, total: list.length, name, result, results: [...results] });
  }
  return { state: results.every(r => r.ok) ? 'passed' : 'failed', results };
}
