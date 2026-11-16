// Codex adapter, part 2: runs Codex for one agent and feeds its output to the parser.
//
// Codex runs one process per turn; the conversation (a "thread") lives on disk under CODEX_HOME.
// Checked against `codex exec --help` and `codex exec resume --help` of codex-cli 0.166.0:
//
//   first turn:  codex exec --json -C <workspace> --sandbox workspace-write <git> [-m <model>] -- <task>
//   follow-up:   codex exec resume --json -c sandbox_mode="workspace-write" <git> [-m <model>] -- <threadId> <text>
//   <git>:       -c sandbox_workspace_write.network_access=true
//                -c sandbox_workspace_write.writable_roots=["<git common dir>","<worktree's git dir>"]
//
// - `resume` accepts neither -C nor --sandbox. So every process is spawned with its cwd set to the workspace
//   (that is the folder a resumed turn works in), and the sandbox is set by a config override.
// - `--` ends the options, so a task or message that begins with "-", or is a bare subcommand name such as
//   "review", is passed as text instead of being parsed as an option.
// - stdin is ignored: with stdin open, Codex waits for it to close before it starts.
// - There are no permission asks: Codex works inside its own workspace-write sandbox. That sandbox has no network
//   and lets Codex write only its own folder, while a worktree's git data lives in the repository's .git, outside
//   it. So both turns turn the network on and add the repository's git folders as writable roots (see sandboxArgs),
//   for Codex to commit, fetch, pull and push. The network is then open for anything, not only git.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EV } from '../../shared/events.mjs';
import { STATE } from '../../shared/states.mjs';
import { withNodeOnPath, withKeys, safeMask, maskParsed, maskedTail, MASK_MARGIN } from '../claude/args.mjs';
import { createCodexParser, plainError, STOPPED_EARLY } from './parse.mjs';

export const harness = 'codex';

const KILL_GRACE_MS = 3000;       // SIGTERM first, SIGKILL after this
const CLOSE_GRACE_MS = 2000;      // after exit, how long to wait for the output pipes to close
const STDERR_KEEP = 4096;         // bytes of stderr kept for error reports
const MAX_LINE = 16 * 1024 * 1024;

// Session variables a running Claude Code sets; the Claude adapter removes the same ones.
const CLAUDE_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK)/;
// Variables a running Codex sets for the commands it runs: its thread, tool call and sandbox, and its helper
// services. If Workbench was started from inside Codex they would describe that session, not the new agent.
// CODEX_HOME, CODEX_API_KEY and the other sign-in and config variables are kept: auth and resume need them.
const CODEX_SESSION_VARS = /^CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|SANDBOX|SANDBOX_NETWORK_DISABLED|PERMISSION_PROFILE)$|^CODEX_(EXEC_SERVER|NETWORK_PROXY|SNAPSHOT|SHELL_SNAPSHOT)_/;
// Workbench's hook credentials. Codex has no hook, and its commands must not be able to call the engine.
const WORKBENCH_SECRETS = new Set(['WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN']);
// The editor Workbench was started from (VS Code, or Claude Code inside it), and Workbench's own choice of programs:
// an agent gets no handle on the editor's connection, and a Workbench an agent starts does not inherit the programs.
// The Claude adapter removes the same ones.
const HOST_VARS = /^(VSCODE_.*|ELECTRON_RUN_AS_NODE|GIT_EDITOR|WORKBENCH_CLAUDE_BIN|WORKBENCH_CODEX_BIN)$/;
/**
 * Where `codex exec --json` names things rather than says them, never masked (see maskParsed's OutputFormat): an
 * event's type and thread id, and its item's id, type and status. A command, its output, a message or a tool's
 * arguments and result are masked whatever their fields are called.
 */
export const CODEX_FORMAT = Object.freeze({
  keep: new Set(['type', 'thread_id']),
  inside: { item: { keep: new Set(['id', 'type', 'status']) } },
});

/** The Codex binary: `WORKBENCH_CODEX_BIN` (read at call time, so tests can point it at a fake) or `codex`. */
export function codexBin(env = process.env) {
  return env.WORKBENCH_CODEX_BIN || 'codex';
}

/** Variables buildEnv removes: a key by one of these names is not given to Codex either. */
function scrubbed(key) {
  return CLAUDE_SESSION_VARS.test(key) || CODEX_SESSION_VARS.test(key) || WORKBENCH_SECRETS.has(key) || HOST_VARS.test(key);
}

/**
 * A copy of `base` without other sessions' variables, then the person's keys for this agent (`keysEnv`, see withKeys
 * in ../claude/args.mjs), then WORKBENCH_AGENT_ID, which no key can replace. When PATH has no node, the folder of the
 * node running Workbench goes first, so the agent's `npm test` and `node --test` work.
 */
export function buildEnv(base = process.env, agentId, keysEnv = null) {
  let env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (value === undefined) continue;
    if (scrubbed(key)) continue;
    env[key] = value;
  }
  env = withKeys(env, keysEnv, scrubbed);
  if (agentId) env.WORKBENCH_AGENT_ID = agentId;
  return withNodeOnPath(env);
}

/** A folder's real path, or null when it is not a folder that is there. */
function realFolder(p) {
  try {
    const real = fs.realpathSync.native(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The git folders an agent's folder needs to write, as real paths, read from git's own layout (gitrepository-layout(5),
 * git-worktree(1)) without running git:
 * - a repository's own folder: its .git folder;
 * - a worktree, as Workbench makes them: its .git is a file "gitdir: <path>", naming its own git folder
 *   <common dir>/worktrees/<name> (its index, HEAD and the like), whose file "commondir" names the repository's
 *   shared git folder, the common dir (commits, branches, tags, remotes). Both are returned, the common dir first.
 * Anything else, or a layout that does not hold together (a worktree's git folder that is not in <common dir>/worktrees),
 * gives [], and Codex then writes only its own folder, as before. The runner reads this once, when it is made.
 * @returns {string[]}
 */
export function gitFolders(cwd) {
  try {
    const top = realFolder(cwd);
    if (!top) return [];
    const dotGit = path.join(top, '.git');
    const st = fs.lstatSync(dotGit);
    if (st.isDirectory()) return [dotGit];
    if (!st.isFile()) return [];
    // git strips the line ending, and reads a relative path from the folder the .git file is in.
    const text = fs.readFileSync(dotGit, 'utf8').replace(/[\r\n]+$/, '');
    if (!text.startsWith('gitdir: ') || /[\r\n]/.test(text)) return [];
    const own = realFolder(path.resolve(top, text.slice('gitdir: '.length)));
    if (!own) return [];
    // "commondir" names the common dir, relative to the worktree's own git folder.
    const named = fs.readFileSync(path.join(own, 'commondir'), 'utf8').replace(/[\r\n]+$/, '');
    const common = named && !/[\r\n]/.test(named) ? realFolder(path.resolve(own, named)) : null;
    if (!common || path.dirname(own) !== path.join(common, 'worktrees')) return [];
    return [common, own];
  } catch {
    return [];
  }
}

/** A TOML basic string: quotes and backslashes escaped, and every control character as \uXXXX (TOML allows none raw). */
export function tomlString(text) {
  return '"' + String(text).replace(/["\\\u0000-\u001f\u007f]/g, ch => (ch === '"' || ch === '\\'
    ? '\\' + ch
    : '\\u' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))) + '"';
}

/**
 * Config overrides that let Codex do git in its workspace-write sandbox, on every turn: the network on, and the
 * repository's git folders (gitFolders) added to the folders it may write. The keys are those of Codex's configuration
 * reference: sandbox_workspace_write.network_access (a boolean, "Allow outbound network access inside the
 * workspace-write sandbox") and sandbox_workspace_write.writable_roots (an array of strings, "Additional writable roots
 * when sandbox_mode = "workspace-write""). A -c value is read as TOML, and it replaces the whole array, so writable
 * folders from the person's own Codex config do not apply to Workbench's agents.
 */
export function sandboxArgs(gitDirs = []) {
  const out = ['-c', 'sandbox_workspace_write.network_access=true'];
  if (Array.isArray(gitDirs) && gitDirs.length) {
    out.push('-c', `sandbox_workspace_write.writable_roots=[${gitDirs.map(tomlString).join(',')}]`);
  }
  return out;
}

/** Arguments for the first turn. `gitDirs`: gitFolders(cwd). */
export function startArgs({ cwd, task, model, gitDirs = [] }) {
  return ['exec', '--json', '-C', cwd, '--sandbox', 'workspace-write', ...sandboxArgs(gitDirs), ...(model ? ['-m', model] : []), '--', task];
}

/** Arguments for a follow-up turn on an existing thread. `gitDirs`: gitFolders(cwd), as for the first turn. */
export function resumeArgs({ threadId, text, model, gitDirs = [] }) {
  return ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...sandboxArgs(gitDirs), ...(model ? ['-m', model] : []),
    '--', threadId, text];
}

/** Node scripts (test doubles) run with this Node, so they need no exec bit or shebang. */
function commandFor(bin, args) {
  return /\.(mjs|cjs|js)$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

function spawnReason(err) {
  if (!err) return null;
  if (err.code === 'ENOFOLDER') return 'Codex could not start because the agent’s folder is missing.';
  if (err.code === 'ENOENT') return 'Codex is not installed, or the codex command could not be found.';
  if (err.code === 'EACCES') return 'The codex command is not allowed to run on this computer.';
  return 'Codex could not be started.';
}

/** Run a short command with stdin ignored and a time limit. Never rejects. */
function runQuick(bin, args, env, timeoutMs) {
  return new Promise(resolve => {
    const [file, argv] = commandFor(bin, args);
    let child;
    try {
      child = spawn(file, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error: null, ...fields, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', d => { stdout = (stdout + d).slice(-8192); });
    child.stderr.setEncoding('utf8').on('data', d => { stderr = (stderr + d).slice(-8192); });
    child.on('error', error => done({ error }));
    child.on('close', code => done({ code }));
  });
}

/** `codex login status` prints "Logged in using ..." or "Not logged in". The text itself is never passed on. */
function readLogin(res) {
  if (res.error || res.timedOut) return null;
  const text = `${res.stdout}\n${res.stderr}`;
  if (/\bnot\s+logged\s+in\b/i.test(text)) return false; // check this first: it contains "logged in"
  if (/\blogged\s+in\b/i.test(text)) return true;
  return null;
}

/**
 * Is Codex usable here? `ok` means the binary runs. `loggedIn` is what `codex login status` says
 * (true, false, or null when it could not tell). Not being signed in does not make `ok` false, because other
 * sign-in methods and custom model providers can still work; `reason` then explains it in plain words.
 * @returns {Promise<{ ok: boolean, version?: string, loggedIn: boolean|null, reason?: string }>}
 */
export async function available({ timeoutMs = 5000 } = {}) {
  const bin = codexBin();
  const env = buildEnv(process.env);
  const [ver, login] = await Promise.all([
    runQuick(bin, ['--version'], env, timeoutMs),
    runQuick(bin, ['login', 'status'], env, timeoutMs),
  ]);
  if (ver.error) return { ok: false, loggedIn: null, reason: spawnReason(ver.error) };
  if (ver.timedOut) return { ok: false, loggedIn: null, timedOut: true, reason: 'Codex did not answer when asked for its version.' };
  if (ver.code !== 0) return { ok: false, loggedIn: null, reason: 'Codex is installed but did not start properly.' };
  const text = `${ver.stdout}\n${ver.stderr}`.trim();
  const version = (/\d+\.\d+\.\d+[\w.+-]*/.exec(text) || [text.split('\n')[0]])[0] || undefined;
  const loggedIn = readLogin(login);
  const result = { ok: true, version, loggedIn };
  if (loggedIn === false) result.reason = 'Codex says it is not signed in. Run “codex login” in a terminal before starting a Codex agent.';
  return result;
}

function makeLog(log, agentId) {
  const prefix = `codex ${agentId || ''}`.trim() + ': ';
  if (typeof log === 'function') return msg => { try { log(prefix + msg); } catch { /* logging must not break the run */ } };
  if (log && typeof log.info === 'function') return msg => { try { log.info(prefix + msg); } catch { /* same */ } };
  return () => {};
}

function killGroup(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal); // the whole process group: Codex and the commands it started
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/** Resolve when `promise` settles or after `ms`, whichever is first, without leaving a timer behind. */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

/** The stderr line that best says what went wrong: the last one that sounds like an error, else the last one. */
function errorLine(text) {
  const lines = String(text || '').split('\n').map(s => s.trim()).filter(s => s && !/^note:/i.test(s));
  const errors = lines.filter(s => /error|fail|panick|denied|not found|unauthori/i.test(s));
  return errors[errors.length - 1] || lines[lines.length - 1] || '';
}

/**
 * A Runner for one Codex agent (see "Runner interface" in ARCHITECTURE.md).
 * `sessionId` continues an existing Codex thread instead of starting a new one.
 * `env` is the base environment (default process.env), as for the other adapters; `keysEnv` ({ NAME: value }) is the
 * person's keys for this agent, which every turn's process gets (see buildEnv). `mask` (text -> text) hides the
 * person's keys: every output line goes through it before the parser reads it, and so does the stderr kept for
 * error reports.
 * Extra options for tests: `killGraceMs` (default 3000) and `now`.
 */
export function createRunner(opts = {}) {
  const { agentId, name = 'Codex', task = '', cwd, model } = opts;
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const clock = typeof opts.now === 'function' ? opts.now : Date.now;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const log = makeLog(opts.log, agentId);
  const parser = createCodexParser({ rootId: agentId, now: clock });
  const baseEnv = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const keysEnv = opts.keysEnv && typeof opts.keysEnv === 'object' ? opts.keysEnv : null;
  const hide = typeof opts.mask === 'function' ? safeMask(opts.mask) : null; // null: nothing to hide
  const mask = hide || (s => s);
  // Read once, when the runner is made: what its turns write into these folders cannot widen the folders of its next turns.
  const gitDirs = cwd ? gitFolders(cwd) : [];

  let threadId = opts.sessionId || null;
  let current = null;        // the process of the turn in progress, or null between turns
  let started = false;
  let stopped = false;
  let reportedStop = false;
  let stopping = null;       // the promise of a stop() in progress
  const queue = [];          // messages that arrived while a turn was running

  function deliver(ev) {
    const e = { ...ev };
    if (e.ts == null) e.ts = clock();
    if (e.agentId == null) e.agentId = agentId;
    try { emit(e); } catch (err) { log(`emit failed: ${err?.message || err}`); }
  }

  /** Events from the parser: note the thread id and how the turn ended, then pass them on. */
  function forward(p, ev) {
    if (ev.kind === EV.SESSION) threadId = ev.sessionId;
    if (ev.kind === EV.TURN && ev.phase === 'end') {
      p.turnEnded = true;
      p.failReason = ev.isError ? (ev.error || ev.finalText || STOPPED_EARLY) : null;
    }
    deliver(ev);
  }

  function onLine(p, line) {
    const text = line.trim();
    if (!text) return;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      log(`ignored a line that is not JSON: ${mask(text).slice(0, 120)}`);
      return;
    }
    // Keys are hidden before anything is cut short: the log's 120 characters above, the parser's and narrate()'s later.
    if (hide) obj = maskParsed(obj, hide, CODEX_FORMAT); // never the format's own words: a line would no longer read
    for (const ev of parser.push(obj)) forward(p, ev);
  }

  function onStdout(p, chunk) {
    if (p.stopping) return; // after stop(), nothing from the dying process may change the agent
    p.buf += chunk;
    let nl;
    while (!p.stopping && (nl = p.buf.indexOf('\n')) !== -1) {
      const line = p.buf.slice(0, nl);
      p.buf = p.buf.slice(nl + 1);
      onLine(p, line);
    }
    if (p.buf.length > MAX_LINE) {
      log('dropped an overlong line');
      p.buf = '';
    }
  }

  /** The process is gone: report how it went, then send any queued message. Runs once per process. */
  function finalize(p, code, signal) {
    if (p.finalized) return;
    p.finalized = true;
    clearTimeout(p.closeTimer);
    p.exited = true;
    p.markExited();
    if (current === p) current = null;
    if (p.stopping) return; // stop() reports the stop itself

    if (p.buf.trim()) onLine(p, p.buf);
    p.buf = '';
    for (const ev of parser.finish()) forward(p, ev);

    if (p.turnEnded && !p.failReason) {
      // A finished turn is not the end of the agent: the next message resumes the thread.
      if (code !== 0) log(`exited with ${signal || `code ${code}`} after finishing its turn`);
    } else {
      const tail = (hide ? maskedTail(p.stderr, { truncated: p.stderrCut, limit: STDERR_KEEP, mask: hide }) : p.stderr.slice(-STDERR_KEEP)).trim();
      const reason = p.failReason || spawnReason(p.spawnError) || plainError(parser.lastError) || plainError(errorLine(tail)) || STOPPED_EARLY;
      log(`failed (${signal || `code ${code}`}): ${reason}`);
      deliver({ kind: EV.ENDED, outcome: 'error', error: tail ? `${reason}\n\n${tail}` : reason });
      deliver({ kind: EV.STATE, state: STATE.FAILED, reason });
    }
    drain();
  }

  /** Spawn one Codex process. Resolves once it is running, or once a failure to start has been reported. */
  function launch(args, why) {
    const p = { child: null, why, buf: '', stderr: '', stderrCut: false, spawned: false, stopping: false, exited: false, finalized: false, turnEnded: false, failReason: null, spawnError: null, closeTimer: null };
    p.exitedPromise = new Promise(resolve => { p.markExited = resolve; });
    current = p;

    if (!cwd || !fs.existsSync(cwd)) {
      p.spawnError = Object.assign(new Error('missing folder'), { code: 'ENOFOLDER' });
      finalize(p, null, null);
      return Promise.resolve();
    }
    const [file, argv] = commandFor(codexBin(baseEnv), args);
    try {
      p.child = spawn(file, argv, { cwd, env: buildEnv(baseEnv, agentId, keysEnv), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      p.spawnError = err;
      finalize(p, null, null);
      return Promise.resolve();
    }
    p.child.stdout.setEncoding('utf8').on('data', chunk => onStdout(p, chunk));
    p.child.stderr.setEncoding('utf8').on('data', chunk => {
      // Kept with room to spare, so that a key at the start of what is shown can still be hidden (see maskedTail).
      p.stderr += chunk;
      if (p.stderr.length > STDERR_KEEP + MASK_MARGIN) {
        p.stderr = p.stderr.slice(-(STDERR_KEEP + MASK_MARGIN));
        p.stderrCut = true;
      }
    });
    p.child.on('exit', (code, signal) => {
      if (p.finalized) return;
      p.exited = true;
      p.markExited();
      // Normally 'close' follows once the output is read. If something it started holds the pipes open, move on.
      p.closeTimer = setTimeout(() => {
        p.child.stdout.destroy();
        p.child.stderr.destroy();
        finalize(p, code, signal);
      }, CLOSE_GRACE_MS);
    });
    p.child.on('close', (code, signal) => finalize(p, code, signal));

    return new Promise(resolve => {
      p.child.once('spawn', () => {
        p.spawned = true;
        log(`started codex for the ${why} (pid ${p.child.pid}) in ${cwd}`);
        resolve();
      });
      p.child.on('error', err => {
        if (p.spawned) { log(`process error: ${err.message}`); return; }
        p.spawnError = err;
        finalize(p, null, null);
        resolve();
      });
    });
  }

  /** Start the next turn with `text`: resume the thread, or start over if there is no thread yet. */
  function followUp(text) {
    started = true;
    if (threadId) return launch(resumeArgs({ threadId, text, model, gitDirs }), 'follow-up');
    // The first run never got as far as starting a conversation, so begin again with the task and this message.
    return launch(startArgs({ cwd, task: task ? `${task}\n\n${text}` : text, model, gitDirs }), 'new start');
  }

  function drain() {
    if (stopped || current || queue.length === 0) return;
    const text = queue.splice(0).join('\n\n');
    followUp(text).catch(err => log(`could not send a queued message: ${err?.message || err}`));
  }

  async function start() {
    if (started) return;
    started = true;
    stopped = false;
    if (model) deliver({ kind: EV.MODEL, model });
    log(gitDirs.length ? `its sandbox may also write the git folders ${gitDirs.join(' and ')}` : 'no git folders to add to its sandbox');
    await launch(startArgs({ cwd, task, model, gitDirs }), 'first turn');
  }

  async function send(text) {
    const message = String(text ?? '').trim();
    if (!message) return;
    if (stopping) await stopping;
    stopped = false;
    reportedStop = false;
    if (current) {
      // Codex takes no input during a turn, so the message becomes the next turn. If the turn has already
      // ended and only the process is still closing, it goes out in a moment and needs no notice.
      queue.push(message);
      if (!current.turnEnded) deliver({ kind: EV.NOTICE, text: `${name} will get your message when it finishes what it is doing now.` });
      return;
    }
    await followUp(message);
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    queue.length = 0;
    const p = current && !current.finalized ? current : null;
    if (p) {
      p.stopping = true; // before the kill, so the exit handler stays quiet and the engine's "stopped" stands
      killGroup(p.child, 'SIGTERM');
      // Not cleared when the leader exits: it also ends anything left in the group.
      const hard = setTimeout(() => killGroup(p.child, 'SIGKILL'), killGraceMs);
      hard.unref?.();
    }
    stopping = (async () => {
      if (p) {
        await within(p.exitedPromise, killGraceMs + CLOSE_GRACE_MS);
        if (current === p) current = null;
      }
      for (const ev of parser.abort()) deliver(ev);
      if (!reportedStop) {
        reportedStop = true;
        deliver({ kind: EV.ENDED, outcome: 'stopped' });
      }
    })().finally(() => { stopping = null; });
    return stopping;
  }

  function info() {
    const live = current && current.child && !current.exited ? current : null;
    return { pid: live ? live.child.pid ?? null : null, sessionId: threadId, alive: Boolean(live) };
  }

  return { start, send, stop, info };
}
