// Runs Claude Code as a workbench agent: launches it in the agent's workspace, sends it messages on stdin
// and turns its stdout into normalized events with parse.mjs. Implements the Runner interface in ARCHITECTURE.md.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { EV } from '../../shared/events.mjs';
import { STATE } from '../../shared/states.mjs';
import {
  buildClaudeLaunch, findClaude, scrubEnv, withNodeOnPath, userMessage, sessionFolders, sessionExists,
  DEFAULT_BUDGET_USD, DISALLOWED_TOOLS, CLAUDE_NOT_FOUND,
} from './args.mjs';
import { createClaudeParser } from './parse.mjs';

export const harness = 'claude';

/** Does Claude Code still have this session's conversation? true, false, or null when it cannot tell. */
export { sessionExists };

/** After SIGTERM, how long the process group gets before SIGKILL. */
export const STOP_GRACE_MS = 3000;
/** How much of stderr is kept for error reports. */
export const STDERR_TAIL_CHARS = 4096;
/** Output lines longer than this are skipped rather than held in memory. */
export const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** After the process exits, how long to wait for its output pipes to close before finishing anyway. */
const CLOSE_WAIT_MS = 2000;

const firstLine = (s) => String(s || '').trim().split('\n')[0].trim().slice(0, 200);

/** Tools the launch turns off; Claude Code should never offer them to an agent. */
const DISALLOWED = new Set(DISALLOWED_TOOLS.split(' '));

/**
 * Is Claude Code here? Finds it (see findClaude in args.mjs: `claudePath` is the --claude flag), then runs
 * `<path> --version` with a 5 second timeout.
 * @returns {Promise<{ ok: boolean, version?: string, path?: string, from?: 'flag'|'env'|'path'|'vscode', reason?: string }>}
 *   `path` and `from` say which Claude Code it found and how, also when that one cannot be used
 */
export async function available({ env = process.env, timeoutMs = 5000, claudePath } = {}) {
  const where = findClaude({ flag: claudePath, env });
  const found = where.path ? { path: where.path, from: where.from } : {};
  if (!where.path || where.reason) return { ok: false, reason: where.reason || CLAUDE_NOT_FOUND, ...found };
  return new Promise((resolve) => {
    execFile(where.path, ['--version'], { timeout: timeoutMs, env: withNodeOnPath(scrubEnv(env)), maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return resolve({ ok: false, reason: `Claude Code could not be started: ${where.path} was not found.`, ...found });
        if (err.code === 'EACCES') return resolve({ ok: false, reason: 'Claude Code could not be run: permission was refused.', ...found });
        if (err.killed) return resolve({ ok: false, reason: 'Claude Code did not answer when asked for its version.', ...found });
        const said = firstLine(stderr);
        return resolve({ ok: false, reason: 'Claude Code could not be started.' + (said ? ' It said: ' + said : ''), ...found });
      }
      const text = String(stdout || '').trim();
      const m = /\d+\.\d+\.\d+[\w.-]*/.exec(text);
      resolve({ ok: true, version: m ? m[0] : (firstLine(text) || 'unknown'), ...found });
    });
  });
}

/** A word Claude Code printed, safe to log: letters, digits and a few marks only. */
const logWord = (w) => String(w).replace(/[^\w.:@/+-]/g, '?').slice(0, 80);

/**
 * Split a byte or text stream into lines. Handles lines cut across chunks, multi-byte characters cut across
 * chunks, CRLF, and very long lines (kept as a list of pieces, so they are joined once, not copied per chunk).
 * @param {(line: string) => void} onLine  called for each non-empty line, without the newline
 * @returns {{ push(chunk: Buffer|string): void, end(): void }}
 */
export function createLineSplitter(onLine, { maxLineChars = MAX_LINE_CHARS, onTooLong } = {}) {
  const decoder = new StringDecoder('utf8');
  let parts = [];
  let size = 0;
  let dropping = false; // the current line passed the limit: skip it up to the next newline

  const emitLine = (line) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l.trim()) onLine(l);
  };

  function feed(text) {
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) !== -1) {
      const piece = text.slice(start, nl);
      if (dropping || size + piece.length > maxLineChars) {
        if (onTooLong) onTooLong(size + piece.length);
      } else {
        parts.push(piece);
        emitLine(parts.length === 1 ? parts[0] : parts.join(''));
      }
      parts = [];
      size = 0;
      dropping = false;
      start = nl + 1;
    }
    if (start < text.length) {
      const rest = start === 0 ? text : text.slice(start);
      size += rest.length;
      if (dropping) return;
      if (size > maxLineChars) { dropping = true; parts = []; } else parts.push(rest);
    }
  }

  return {
    push(chunk) {
      if (chunk == null) return;
      feed(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    end() {
      feed(decoder.end());
      if (dropping) { if (onTooLong) onTooLong(size); } else if (parts.length) emitLine(parts.join(''));
      parts = [];
      size = 0;
      dropping = false;
    },
  };
}

function makeLog(log, agentId) {
  return (level, msg) => {
    const line = `claude ${agentId}: ${msg}`;
    try {
      if (typeof log === 'function') log(line);
      else if (log && typeof log[level] === 'function') log[level](line);
      else if (log && typeof log.log === 'function') log.log(line);
    } catch { /* logging must never break the runner */ }
  };
}

/** Is any process of this process group still alive? */
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; } catch { return false; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Create a runner for one root agent.
 * @param {object} opts  { agentId, name, task, cwd, model?, budgetUsd?, emit, hook: { url, token }, log }
 *   `sessionId` continues an earlier session (from history) instead of starting one: call send(), not start(); the
 *   first message resumes it with `--resume` and the whole of `budgetUsd` (the new process has spent nothing).
 *   `claudePath` is the --claude flag: Claude Code is looked up again at each launch (findClaude in args.mjs), since
 *   the VS Code extension moves to a new folder with each update.
 *   Also accepted, mainly for tests: env (base environment), killGraceMs, now, bridgePath, nodePath, machineId.
 */
export function createRunner(opts = {}) {
  const { agentId, name, task, cwd, model, hook } = opts;
  const emitFn = typeof opts.emit === 'function' ? opts.emit : () => {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const baseEnv = opts.env || process.env;
  const claudePath = typeof opts.claudePath === 'string' ? opts.claudePath : null;
  const budgetUsd = opts.budgetUsd == null ? DEFAULT_BUDGET_USD : Number(opts.budgetUsd);
  const graceMs = opts.killGraceMs ?? STOP_GRACE_MS;
  const log = makeLog(opts.log, agentId);
  const who = name || 'This agent';

  const parser = createClaudeParser({
    rootId: agentId, now, machineId: opts.machineId, workspace: cwd,
    onError: (err) => log('warn', `could not read part of the Claude Code output: ${err.message}`),
  });

  let proc = null;        // the current Claude Code process
  let alive = false;      // it has spawned and not exited
  let started = !!opts.sessionId; // a runner for an earlier session is started already: its first send resumes it
  let stopRequested = false;
  let sessionId = opts.sessionId ? String(opts.sessionId) : null; // ours at first; then whatever Claude Code reports in system/init
  let launching = null;   // promise of a launch in progress
  let stopping = null;    // promise of a stop in progress
  let closed = null;      // resolves when the current process is fully gone and reported
  let stderrTail = '';
  let bin = null;         // the Claude Code program of the current process
  let toldTools = false;  // its tools were logged (once per process)

  function emit(ev) {
    if (ev.ts == null) ev.ts = now();
    try { emitFn(ev); } catch (err) { log('error', `an event handler failed: ${err.message}`); }
  }

  /** Log, once per process, which Claude Code started and the tools it offers the agent. */
  function tellTools(o) {
    if (toldTools) return;
    toldTools = true;
    const tools = Array.isArray(o.tools) ? o.tools.filter((t) => typeof t === 'string').map(logWord) : [];
    const version = typeof o.claude_code_version === 'string' ? logWord(o.claude_code_version) : 'of an unknown version';
    log('info', `Claude Code ${version} offers ${tools.length} tools: ${tools.join(' ') || 'none'}`);
    const off = tools.filter((t) => DISALLOWED.has(t));
    if (off.length) log('warn', `Claude Code offers tools Workbench turned off for its agents: ${off.join(' ')}`);
  }

  function onLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch { log('debug', `ignored output that is not JSON: ${line.slice(0, 120)}`); return; }
    if (obj && obj.type === 'system' && obj.subtype === 'init') {
      if (obj.session_id) sessionId = String(obj.session_id);
      tellTools(obj);
    }
    for (const ev of parser.push(obj)) emit(ev);
  }

  function write(line) {
    if (!proc || !alive || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    proc.stdin.write(line);
    return true;
  }

  function startFailure(err) {
    if (err && err.code === 'ENOENT') {
      return cwd && !existsSync(cwd)
        ? "Claude Code could not be started: the agent's folder does not exist."
        : `Claude Code could not be started: ${bin || 'the claude command'} was not found.`;
    }
    if (err && err.code === 'EACCES') return 'Claude Code could not be started: permission was refused.';
    return 'Claude Code could not be started' + (err && err.message ? `: ${err.message}` : '.');
  }

  /** The process has exited and its output is read. Report it, unless it was stopped on purpose. */
  function onGone(child, exitInfo, spawnError) {
    if (proc !== child) return;
    const { code = null, signal = null } = exitInfo || {};
    const clean = code === 0 && !spawnError;
    // Helpers cannot outlive the process.
    const helperEnds = stopRequested
      ? parser.endOpenHelpers('stopped', 'It was stopped.')
      : clean
        ? parser.endOpenHelpers('stopped', 'Claude Code closed before this helper finished.')
        : parser.endOpenHelpers('failed', 'Claude Code stopped unexpectedly.');
    for (const ev of helperEnds) emit(ev);
    if (stopRequested) return; // the engine reports the stop itself
    if (clean) { emit({ kind: EV.ENDED, agentId, outcome: 'ok' }); return; }
    const what = spawnError
      ? startFailure(spawnError)
      : signal
        ? `Claude Code was ended unexpectedly (signal ${signal}).`
        : `Claude Code stopped with an error (exit code ${code}).`;
    const tail = stderrTail.trim();
    emit({ kind: EV.ENDED, agentId, outcome: 'error', error: tail || what });
    emit({ kind: EV.STATE, agentId, state: STATE.FAILED, reason: what });
  }

  function launch(resume) {
    const p = (async () => {
      let budget = budgetUsd;
      if (resume) {
        // A relaunch gets what is left of the agent's limit, so a resumed process cannot spend it again. Claude Code
        // counts the limit per process and reports spend only when a turn ends, so a stopped turn's spend is
        // Workbench's own estimate (unreportedUsd).
        const { costUsd, unreportedUsd } = parser.info();
        budget = budgetUsd - (typeof costUsd === 'number' ? costUsd : 0) - (unreportedUsd || 0);
        if (!(budget >= 0.01)) throw Object.assign(new Error(`${who} has used its whole spending limit, so it can’t continue.`), { plain: true });
      }
      // Looked up again for every process: an update of the VS Code extension moves Claude Code to a new folder.
      // Nothing was started when it is not found, so this is said as a plain refusal, like the spending limit: the
      // engine reports it, and an agent from an earlier run stays as it was.
      const where = findClaude({ flag: claudePath, env: baseEnv });
      if (!where.path || where.reason) throw Object.assign(new Error(where.reason || CLAUDE_NOT_FOUND), { plain: true });
      const spec = buildClaudeLaunch({
        name, model, budgetUsd: budget, hook, agentId, env: baseEnv, bin: where.path,
        sessionId: resume ? undefined : sessionId,
        resumeSessionId: resume ? sessionId : undefined,
        bridgePath: opts.bridgePath, nodePath: opts.nodePath,
      });
      if (!resume) sessionId = spec.sessionId;
      else parser.processRestarted();
      bin = spec.bin;
      toldTools = false;
      stderrTail = '';
      stopRequested = false;

      const child = spawn(spec.bin, spec.args, {
        cwd, env: spec.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      proc = child;

      const splitter = createLineSplitter((line) => {
        try { onLine(line); } catch (err) { log('error', `failed to handle output: ${err.message}`); }
      }, { onTooLong: (n) => log('warn', `skipped an output line of ${n} characters`) });
      child.stdout.on('data', (c) => splitter.push(c));
      child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-STDERR_TAIL_CHARS); });
      for (const s of [child.stdin, child.stdout, child.stderr]) {
        s.on('error', (err) => log('warn', `pipe error: ${err.message}`)); // EPIPE after the process has gone
      }

      let spawnError = null;
      let exitInfo = null;
      let finished = false;
      let resolveClosed;
      closed = new Promise((r) => { resolveClosed = r; });
      const finish = () => {
        if (finished) return;
        finished = true;
        if (proc === child) alive = false;
        try { splitter.end(); } catch (err) { log('error', `failed to handle output: ${err.message}`); }
        onGone(child, exitInfo, spawnError);
        resolveClosed();
      };
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        if (proc === child) alive = false;
        // 'close' normally follows at once; do not hang if a leftover process holds the pipes open.
        setTimeout(finish, CLOSE_WAIT_MS).unref();
      });
      child.on('close', (code, signal) => { if (!exitInfo) exitInfo = { code, signal }; finish(); });

      await new Promise((resolve, reject) => {
        child.once('spawn', () => { alive = true; resolve(); });
        child.on('error', (err) => {
          if (!alive && !spawnError && exitInfo == null) { spawnError = err; reject(new Error(startFailure(err))); }
          else log('warn', `process error: ${err.message}`);
        });
      });
      log('info', `started Claude Code from ${bin} (pid ${child.pid}${resume ? ', resuming its session' : ''})`);
    })();
    launching = p;
    p.then(() => { if (launching === p) launching = null; }, () => { if (launching === p) launching = null; });
    return p;
  }

  async function doStop(child) {
    try { child.stdin.end(); } catch { /* already closed */ }
    const pid = child.pid;
    signalGroup(pid, 'SIGTERM');
    // Give the whole group the grace period, then force it.
    const deadline = Date.now() + graceMs;
    while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
    if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    // Wait until the exit is reported, but never hang on it.
    let timer;
    const limit = new Promise((r) => { timer = setTimeout(r, CLOSE_WAIT_MS + 3000); });
    await Promise.race([closed || Promise.resolve(), limit]);
    clearTimeout(timer);
  }

  return {
    /** Launch Claude Code and send the task as the first message. */
    async start() {
      if (started) throw new Error(`${who} was already started.`);
      started = true;
      sessionId = null;
      await launch(false);
      if (!stopRequested) write(userMessage(task));
    },

    /** Send the next message. If the process has gone, resume its session in a new one. */
    async send(text) {
      if (!started) throw new Error(`${who} has not been started yet.`);
      if (launching) await launching.catch(() => {});
      if (stopping) await stopping;
      if (alive) {
        if (write(userMessage(text))) return;
        throw new Error(`${who} is not taking messages right now. Try again in a moment.`);
      }
      if (!sessionId) throw new Error(`${who} cannot continue: its Claude Code session is not known.`);
      if (closed) await closed; // let the old process finish reporting first
      await launch(true);
      write(userMessage(text));
    },

    /** Stop the whole process tree: SIGTERM to the group, SIGKILL after the grace period. */
    async stop() {
      stopRequested = true;
      if (launching) await launching.catch(() => {});
      if (stopping) return stopping;
      if (!proc || !alive) { if (closed) await closed; return; }
      const child = proc;
      stopping = doStop(child).finally(() => { stopping = null; });
      return stopping;
    },

    info() {
      return { pid: proc && alive ? proc.pid ?? null : null, sessionId, alive };
    },

    /** Claude Code's own folders for this agent's session (see sessionFolders), for the permission check. */
    readAlso() {
      return sessionFolders({ sessionId, env: baseEnv });
    },

    /** The names SendMessage may use for this agent's own helpers, from Claude Code's output. */
    recipients() {
      return parser.recipients();
    },

    /** Which agent (the root or a helper) issued a tool call, for the PreToolUse hook. Null when unknown. */
    agentFor(q) {
      return parser.agentFor(q);
    },
  };
}

/** The contract also calls it createClaudeRunner. */
export const createClaudeRunner = createRunner;
