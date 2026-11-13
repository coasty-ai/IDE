#!/usr/bin/env node
// Workbench: launch coding agents and see what each one is doing, in plain language.
//
//   node bin/workbench.mjs --demo [--port 4317] [--no-open]
//   node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--claude <path>] [--port 4317] [--no-open]
//   node bin/workbench.mjs --clone <address> [--into <folder>] [the --repo options]
//   node bin/workbench.mjs --connect-github | --github-repos      (for the Mac app)
//
// Wires the real modules together: store, engine, commands, policy, workspaces, receipt, machines, the key store and
// Agents & keys (connect), the adapters and the local web server. Every agent process is stopped when Workbench exits.
// Run as a program it starts at once; imported (by its tests), it only exports its parts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4317;
const DEFAULT_BUDGET_USD = 2;
/** How long a clone may take before Workbench gives up on it. */
const CLONE_TIMEOUT_MS = 30 * 60_000;
/**
 * How long a clone that was stopped may take to end git and remove what it made (cloneRepo needs about 2 seconds at
 * most) before Workbench leaves anyway. Less than the 5 seconds the Mac app waits before it kills Workbench.
 */
const CLONE_STOP_MS = 4000;
/** What stops a clone, as Ctrl-C does: the Mac app's Cancel and Quit send SIGTERM, a closed terminal SIGHUP. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Said instead of starting, when the variable every agent gets is set: this is an agent's own command. */
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';
/** Said at the start when git has no user.name and user.email for the repository. */
const NO_GIT_IDENTITY = 'Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com';
/** Said at the start when neither Claude Code nor Codex can run here: Workbench starts anyway, and the page connects one. */
const NO_AGENT = 'No coding agent is ready yet. Open the page to connect one.';
/** How the start says where Claude Code was found. */
const CLAUDE_FROM = { flag: ' (from --claude)', env: ' (from WORKBENCH_CLAUDE_BIN)', path: '', vscode: ' (from the VS Code extension)' };
/** What each part of a clone is called, in the plain progress lines. */
const CLONE_PHASE = { counting: 'Counting what to copy', compressing: 'Packing it up', receiving: 'Copying', resolving: 'Unpacking', checkout: 'Writing the files' };
/** The kinds of failed clone the Mac app tells apart (WORKBENCH_CLONE {"error"}). */
const CLONE_ERRORS = new Set(['auth', 'network', 'exists', 'url', 'git']);

export const USAGE = `Workbench launches coding agents and shows what each one is doing, in plain language.

Try it with simulated agents (nothing is spent):
  node bin/workbench.mjs --demo [--port 4317] [--no-open]

Run real agents on a git repository:
  node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--claude <path>] [--port 4317] [--no-open]

Copy a repository from GitHub (or another git host) first, then run agents on it:
  node bin/workbench.mjs --clone <address> [--into <folder>] [the options for --repo]

With no agent program ready, Workbench starts anyway: its page connects Claude Code or Codex (Agents & keys).

Options:
  --demo              simulated agents and machines
  --repo <path>       the git repository the agents work on (each gets its own copy)
  --clone <address>   copy this repository first, like https://github.com/owner/repo or git@github.com:owner/repo.git
  --into <folder>     where --clone puts the copy (default: the current folder)
  --budget <usd>      the most each agent may spend, in US dollars (default 2)
  --model <name>      the model to ask for
  --claude <path>     the Claude Code program to run. Without it: WORKBENCH_CLAUDE_BIN, then claude on the
                      PATH, then the newest Claude Code extension in VS Code or Cursor
  --port <n>          the port for the web page (default 4317; 0 picks a free one)
  --no-open           do not open the browser
  --app               for the Mac app: no browser, one line the app reads (WORKBENCH_APP {...}), and Workbench
                      stops, as on Ctrl-C, when its standard input closes (the app quit or crashed). With --clone,
                      progress comes as WORKBENCH_CLONE {...} lines
  --connect-github    for the Mac app: read a GitHub token on standard input, connect it, and print
                      WORKBENCH_GITHUB {...}
  --github-repos      for the Mac app: print the connected GitHub account's repositories, WORKBENCH_GITHUB_REPOS [...]
  --event-log <file>  also write every event to this file, one JSON object per line
  --verbose           print more about what Workbench is doing
  --help              show this help`;

// ------------------------------------------------------------------ arguments

export function parseArgs(argv) {
  const out = {
    demo: false, repo: null, clone: null, into: null, connectGithub: false, githubRepos: false, budget: null, model: null, claude: null,
    port: DEFAULT_PORT, open: true, app: false, help: false, verbose: false, eventLog: null, error: null,
  };
  for (let i = 0; i < argv.length && !out.error; i++) {
    const raw = argv[i];
    let flag = raw;
    let inline = null;
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 2) {
      flag = raw.slice(0, eq);
      inline = raw.slice(eq + 1);
    }
    const value = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) {
        out.error = `${flag} needs a value.`;
        return null;
      }
      i += 1;
      return v;
    };
    switch (flag) {
      case '--demo': out.demo = true; break;
      case '--repo': out.repo = value(); break;
      case '--clone': {
        const v = value();
        if (v == null) break;
        if (!v.trim()) out.error = '--clone needs the address of a repository, like https://github.com/owner/repo.';
        else out.clone = v.trim();
        break;
      }
      case '--into': {
        const v = value();
        if (v == null) break;
        if (!v.trim()) out.error = '--into needs the folder to put the copy in.';
        else out.into = v;
        break;
      }
      case '--connect-github': out.connectGithub = true; break;
      case '--github-repos': out.githubRepos = true; break;
      case '--model': out.model = value(); break;
      case '--claude': {
        const v = value();
        if (v == null) break;
        if (!v.trim()) out.error = '--claude needs the path of the Claude Code program.';
        else out.claude = v;
        break;
      }
      case '--event-log': out.eventLog = value(); break;
      case '--no-open': out.open = false; break;
      case '--app': out.app = true; out.open = false; break;
      case '--verbose': out.verbose = true; break;
      case '--help': case '-h': out.help = true; break;
      case '--budget': {
        const v = value();
        if (v == null) break;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) out.error = 'The budget must be a positive number of US dollars, like 2 or 0.5.';
        else out.budget = n;
        break;
      }
      case '--port': {
        const v = value();
        if (v == null) break;
        const n = Number(v);
        if (!/^\d+$/.test(String(v)) || n > 65535) out.error = 'The port must be a whole number from 0 to 65535.';
        else out.port = n;
        break;
      }
      default:
        out.error = `I don't know the option “${raw}”. Use --help to see the options.`;
    }
  }
  if (!out.error && !out.help) {
    const helper = out.connectGithub || out.githubRepos;
    if (out.connectGithub && out.githubRepos) out.error = 'Choose one: --connect-github or --github-repos.';
    else if (helper && (out.demo || out.repo || out.clone)) {
      out.error = `${out.connectGithub ? '--connect-github' : '--github-repos'} runs on its own, without --demo, --repo or --clone.`;
    } else if (out.demo && out.repo) out.error = 'Choose one: --demo for simulated agents, or --repo for real ones.';
    else if (out.demo && out.clone) out.error = 'Choose one: --demo for simulated agents, or --clone to copy a repository and run real agents on it.';
    else if (out.repo && out.clone) out.error = 'Choose one: --repo for a repository on this computer, or --clone to copy one first.';
    else if (out.into && !out.clone) out.error = '--into says where --clone puts the copy, so it needs --clone.';
    else if (!helper && !out.demo && !out.repo && !out.clone) {
      out.error = 'Workbench needs a git repository to work on. Run it with --repo <path to a git repository>, copy one with --clone <address>, or try it with simulated agents using --demo.';
    }
  }
  return out;
}

/**
 * PATH with ~/.local/bin at its end when it is not on it yet (even before that folder exists). Both agents' installers
 * put their programs there, so Agents & keys' Check again finds one installed while Workbench runs, and its agents and
 * checks can run it. Added at the end, never in front: a program PATH already finds keeps its place. An empty PATH, or
 * a home folder that is not an absolute path, leaves PATH as it is.
 * @param {string|undefined} pathValue
 * @param {string} home
 * @returns {string|undefined}
 */
export function pathWithLocalBin(pathValue, home) {
  if (typeof pathValue !== 'string' || !pathValue || typeof home !== 'string' || !path.isAbsolute(home)) return pathValue;
  const dir = path.join(home, '.local', 'bin');
  const there = pathValue.split(path.delimiter).some((p) => p && path.isAbsolute(p) && path.resolve(p) === dir);
  return there ? pathValue : `${pathValue}${path.delimiter}${dir}`;
}

// ------------------------------------------------------------------ output

/** Hides the person's keys in what Workbench prints: Agents & keys' mask, once it is there. */
let hide = null;

/** The text with every stored key hidden. A mask that fails leaves the text as it was. */
function masked(text) {
  if (!hide) return text;
  try { return hide(text); } catch { return text; }
}

function say(text) {
  process.stdout.write(masked(text) + '\n');
}

function complain(text) {
  process.stderr.write(masked(text) + '\n');
}

/**
 * The log: warnings and errors always, info and debug with --verbose, all on stderr (the Mac app copies it into its own
 * log). `setMask(fn)` hides the person's keys in every line from then on (connect.mask).
 * @param {boolean} verbose
 * @param {(line: string) => void} [write] where lines go (tests)
 */
export function createLogger(verbose, write = (line) => process.stderr.write(line)) {
  let mask = null;
  const show = (a) => {
    if (a instanceof Error) return verbose ? (a.stack || a.message) : a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const out = (level, args) => {
    let line = `[workbench ${level}] ${args.map(show).join(' ')}`;
    if (mask) { try { line = mask(line); } catch { /* keep the line as it was */ } }
    try { write(`${line}\n`); } catch { /* ignore */ }
  };
  const log = (...args) => { if (verbose) out('info', args); };
  log.info = (...args) => { if (verbose) out('info', args); };
  log.debug = (...args) => { if (verbose) out('debug', args); };
  log.warn = (...args) => out('warn', args);
  log.error = (...args) => out('error', args);
  log.setMask = (fn) => { mask = typeof fn === 'function' ? fn : null; };
  log.getMask = () => mask;
  return log;
}

/** A mask that does what `mask` does (when there is one, and it works), then cuts out `secret` too. */
function alsoHiding(mask, secret) {
  return (text) => {
    let s = text;
    try { if (mask) s = mask(s); } catch { /* the secret is still cut out below */ }
    return redact(s, [secret]);
  };
}

// ------------------------------------------------------------------ modules

async function load(rel) {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (err) {
    const e = new Error(`Workbench could not load ${rel}: ${err.message}`);
    e.cause = err;
    throw e;
  }
}

async function loadOptional(rel, log) {
  try {
    return await load(rel);
  } catch (err) {
    log.warn(err.message);
    return null;
  }
}

async function loadModules(demo, log) {
  const [storeMod, engineMod, httpMod, commands, machinesMod] = await Promise.all([
    load('src/core/store.mjs'),
    load('src/core/engine.mjs'),
    load('src/server/http.mjs'),
    load('src/core/commands.mjs'),
    load('src/core/machines.mjs'),
  ]);
  const base = { Store: storeMod.Store, Engine: engineMod.Engine, createServer: httpMod.createServer, commands, Machines: machinesMod.Machines };
  if (demo) {
    const sim = await load('src/adapters/sim/simulator.mjs');
    // Not needed by the simulator, but passed along when present.
    const [policy, workspace, receipt] = await Promise.all([
      loadOptional('src/core/policy.mjs', log), loadOptional('src/core/workspace.mjs', log), loadOptional('src/core/receipt.mjs', log),
    ]);
    return { ...base, Simulator: sim.Simulator, policy, workspace, receipt };
  }
  const [policy, workspace, receipt, history] = await Promise.all([
    load('src/core/policy.mjs'), load('src/core/workspace.mjs'), load('src/core/receipt.mjs'), loadOptional('src/core/history.mjs', log),
  ]);
  const [claude, codex] = await Promise.all([
    loadOptional('src/adapters/claude/runner.mjs', log), loadOptional('src/adapters/codex/runner.mjs', log),
  ]);
  return { ...base, policy, workspace, receipt, history, claude, codex };
}

/** End a reason with one full stop: reasons are often whole sentences already. */
function sentence(text) {
  const t = String(text || '').trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The Claude Code adapter, told the --claude path when one was given. The engine calls available() and
 * createRunner() itself, and every launch looks Claude Code up again from this path.
 */
function claudeAdapter(mod, claudePath) {
  if (!mod || !claudePath) return mod;
  return {
    ...mod,
    available: (o = {}) => mod.available({ ...o, claudePath }),
    createRunner: (o = {}) => mod.createRunner({ ...o, claudePath }),
  };
}

/** Whether an adapter can run here: { ok, version?, reason? }. */
async function availability(mod, name) {
  if (!mod) return { ok: false, reason: `${name} support could not be loaded.` };
  if (typeof mod.available !== 'function' || typeof mod.createRunner !== 'function') return { ok: false, reason: `${name} support is incomplete.` };
  let timer;
  try {
    const res = await Promise.race([
      Promise.resolve().then(() => mod.available()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`checking for ${name} took too long`)), 15_000); }),
    ]);
    return res && typeof res === 'object' ? res : { ok: !!res };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** An adapter the engine can drive: it says whether its program is here, and it starts runners. */
const complete = (mod) => !!mod && typeof mod.available === 'function' && typeof mod.createRunner === 'function';

// ------------------------------------------------------------------ Agents & keys, GitHub, cloning

/**
 * The key store and Agents & keys (src/core/keys.mjs, src/core/connect.mjs), with the keys read once. Either may be
 * missing or fail: Workbench then runs as before, without them, and says so in its log. From here on the log hides the
 * person's keys (connect.mask).
 * @param {object} mods     the modules loadModules gave (the workspace and the adapters), or {} for the GitHub helpers:
 *   Connect then uses its own workspace module, and has no agents to check
 * @param {{ probe?: boolean }} [o] probe: check the agents at once (live mode); false where no agent will start (the
 *   Mac app's GitHub helpers), so no agent program runs for nothing
 * @returns {Promise<{ keys: object|null, connect: object|null }>}
 */
async function openConnect(mods, args, log, { probe = true } = {}) {
  const [keysMod, connectMod] = await Promise.all([loadOptional('src/core/keys.mjs', log), loadOptional('src/core/connect.mjs', log)]);
  if (typeof keysMod?.KeyStore !== 'function' || typeof connectMod?.Connect !== 'function') return { keys: null, connect: null };
  const home = os.homedir();
  let keys;
  try {
    keys = new keysMod.KeyStore({ home, platform: process.platform, log });
  } catch (err) {
    log.warn('Workbench could not open the keys you saved:', err);
    return { keys: null, connect: null };
  }
  try {
    await keys.load();
  } catch (err) {
    log.warn('Workbench could not read the keys you saved, so agents start without them:', err);
  }
  let connect;
  try {
    connect = new connectMod.Connect({
      home, platform: process.platform, env: process.env, keys, workspace: mods.workspace,
      adapters: { claude: mods.claude, codex: mods.codex }, flags: { claude: args.claude || null }, log, probe,
    });
  } catch (err) {
    log.warn('Workbench could not set up Agents & keys:', err);
    return { keys, connect: null };
  }
  if (typeof connect.mask === 'function') {
    const mask = (text) => connect.mask(text);
    log.setMask?.(mask);
    hide = mask;
  }
  return { keys, connect };
}

/** The text with each of `secrets` (8 or more characters) replaced by "••••". */
function redact(text, secrets) {
  let s = String(text ?? '');
  for (const v of secrets) if (typeof v === 'string' && v.length >= 8) s = s.split(v).join('••••');
  return s;
}

/** An error whose message is a plain sentence for the person: a refusal from Agents & keys, git or the key store. */
const plainError = (err) => !!err && typeof err.message === 'string' && err.message.trim() !== ''
  && (typeof err.why === 'string' || err.plain === true || err.expose === true);

/**
 * A repository's address as Workbench prints it: without a user name or password before the host
 * ("https://<token>@github.com/…"), and with control characters shown as "?".
 */
export function displayUrl(url) {
  return String(url ?? '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/**
 * The text with the address as Workbench prints it, and without the password the address carried: the part after
 * "user:", or a user name alone, which is how a token is often put in an address ("https://<token>@github.com/…").
 * Like every key Workbench hides, only one of 8 characters or more: a shorter user name ("owner", "repo") would cut
 * ordinary words out of Workbench's own sentences, and cloneRepo refuses an address with a password before git runs.
 */
function withoutCredentials(text, url) {
  const raw = String(url ?? '');
  const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^/@\s]*)@/i.exec(raw)?.[1] || '';
  const colon = userinfo.indexOf(':');
  const parts = (colon >= 0 ? [userinfo, userinfo.slice(colon + 1)] : [userinfo]).sort((a, b) => b.length - a.length);
  let s = String(text ?? '');
  if (raw) s = s.split(raw).join(displayUrl(raw));
  return redact(s, parts);
}

/**
 * --clone: copy the repository into a new folder in `into`, through workspace.cloneRepo, saying how it goes: plain
 * lines, or for the Mac app (`app`) `WORKBENCH_CLONE {"phase","percent"}` lines and, once it is there,
 * `WORKBENCH_CLONE {"phase":"done","percent":100,"root"}`. A failure is a plain sentence on stderr and, for the app,
 * `WORKBENCH_CLONE {"error","sentence"}`, with error one of auth, network, exists, url and git. A user name or password
 * in the address is never printed or logged. `signal` (an AbortSignal) is passed on, for stopping git.
 * @returns {Promise<{ root: string } | { code: number }>}
 */
export async function cloneFirst({ workspace, url, into, app = false, signal, say: out = say, complain: err = complain, log }) {
  const folder = typeof into === 'string' && into ? into.replace(/^~(?=$|\/)/, os.homedir()) : process.cwd();
  const where = path.resolve(folder);
  const fail = (kind, said) => {
    const sentence = withoutCredentials(said, url);
    err(sentence);
    if (app) out(`WORKBENCH_CLONE ${JSON.stringify({ error: CLONE_ERRORS.has(kind) ? kind : 'git', sentence })}`);
    return { code: 1 };
  };
  if (typeof workspace?.cloneRepo !== 'function') return fail('git', 'This Workbench cannot clone a repository. Clone it with git, then open its folder.');
  const shownWhere = where.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
  try {
    fs.mkdirSync(where, { recursive: true });
  } catch (e) {
    log?.warn?.('Could not make the folder for the copy:', e);
    return fail('git', `Workbench could not make the folder ${shownWhere}.`);
  }
  out(`Cloning ${displayUrl(url)} into ${shownWhere}…`);
  let last = null;
  const onProgress = (p) => {
    const phase = typeof p?.phase === 'string' && Object.hasOwn(CLONE_PHASE, p.phase) ? p.phase : null;
    if (!phase) return;
    const percent = Number.isFinite(p.percent) ? Math.max(0, Math.min(100, Math.round(p.percent))) : null;
    if (app) {
      if (last && last.phase === phase && last.percent === percent) return;
      last = { phase, percent };
      out(`WORKBENCH_CLONE ${JSON.stringify({ phase, percent })}`);
      return;
    }
    // In a terminal: a line when a part begins, then every quarter of it.
    const step = percent == null ? null : Math.floor(percent / 25);
    if (last && last.phase === phase && last.step === step) return;
    last = { phase, step };
    out(`${CLONE_PHASE[phase]}${percent == null ? '…' : `: ${percent}%`}`);
  };
  let res;
  try {
    res = await workspace.cloneRepo({ url, into: where, onProgress, timeoutMs: CLONE_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (signal?.aborted) return { code: 1 }; // stopped on purpose: whoever stopped it has said so
    // The log gets git's own words, but never a user name or password from the address.
    const detail = withoutCredentials([e?.message, typeof e?.detail === 'string' ? e.detail : ''].filter(Boolean).join(' '), url);
    if (plainError(e)) {
      log?.debug?.('The clone failed:', detail);
      return fail(e.why, e.message.trim());
    }
    log?.error?.('The clone failed:', detail);
    return fail('git', `Git could not clone ${displayUrl(url)}. The details are in Workbench’s log.`);
  }
  const root = typeof res?.root === 'string' && res.root ? res.root : null;
  if (!root) return fail('git', `Git could not clone ${displayUrl(url)}. The details are in Workbench’s log.`);
  if (app) out(`WORKBENCH_CLONE ${JSON.stringify({ phase: 'done', percent: 100, root })}`);
  out(`Cloned ${displayUrl(url)} into ${root.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')}.`);
  return { root };
}

/**
 * One line from a stream (the token the Mac app writes), without its line break: null when nothing came before the
 * stream ended, or when the line is too long to be a token. The stream is let go afterwards.
 */
export function readLine(stream, { max = 8192, timeoutMs = 5 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const end = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onEnd);
      try { stream.pause(); stream.destroy?.(); } catch { /* ignore */ }
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) return end(buf.slice(0, nl).replace(/\r$/, ''));
      if (buf.length > max) end(null);
    };
    const onEnd = () => end(buf ? buf.replace(/\r$/, '') : null);
    const timer = setTimeout(() => end(null), timeoutMs);
    timer.unref?.();
    stream.setEncoding?.('utf8');
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
    stream.resume?.();
  });
}

/**
 * --connect-github: read the token, connect it (for git only: agents get it only when the person says so in Agents &
 * keys), and print `WORKBENCH_GITHUB {"ok","login","sentence"}`. The token is never printed or logged.
 * @returns {Promise<number>} the exit code: 0 when GitHub took the token
 */
export async function connectGithubMode({ connect, readToken, say: out = say, log }) {
  const tell = (ok, login, sentence) => out(`WORKBENCH_GITHUB ${JSON.stringify({ ok, login, sentence })}`);
  let token = null;
  try { token = await readToken(); } catch { token = null; }
  token = typeof token === 'string' ? token.trim() : '';
  if (!token) { tell(false, null, 'Paste a token from GitHub first.'); return 1; }
  if (!connect) { tell(false, null, 'Workbench could not connect to GitHub. The details are in its log.'); return 1; }
  // Until the token is kept, Agents & keys' own mask does not know it: everything printed or logged meanwhile, by
  // Workbench or by Connect (it logs through the same log), has it cut out as well.
  const prior = hide;
  const priorLog = typeof log?.getMask === 'function' ? log.getMask() : null;
  hide = alsoHiding(prior, token);
  log?.setMask?.(alsoHiding(priorLog, token));
  try {
    let r;
    try {
      r = await connect.connectGithub(token, { agentsUseIt: false });
    } catch (e) {
      if (plainError(e)) { tell(false, null, redact(e.message.trim(), [token])); return 1; }
      log?.error?.('Connecting to GitHub failed:', redact(e?.stack || String(e), [token]));
      tell(false, null, 'Workbench could not connect to GitHub. The details are in its log.');
      return 1;
    }
    const login = typeof r?.login === 'string' && r.login ? r.login : null;
    const ok = r?.ok !== false && !!login;
    const said = typeof r?.sentence === 'string' && r.sentence.trim() ? r.sentence.trim()
      : (ok ? `Connected to GitHub as ${login}.` : 'GitHub did not accept that token.');
    tell(ok, ok ? login : null, redact(said, [token]));
    return ok ? 0 : 1;
  } finally {
    hide = prior;
    log?.setMask?.(priorLog);
  }
}

/**
 * --github-repos: print `WORKBENCH_GITHUB_REPOS [{ fullName, cloneUrl, private }]`, the connected account's
 * repositories (none when GitHub is not connected, or could not be reached).
 * @returns {Promise<number>} always 0
 */
export async function githubReposMode({ connect, say: out = say, log }) {
  let repos = [];
  try {
    const list = connect ? await connect.githubRepos() : [];
    repos = (Array.isArray(list) ? list : [])
      .filter(r => r && typeof r.fullName === 'string' && typeof r.cloneUrl === 'string')
      .map(r => ({ fullName: r.fullName, cloneUrl: r.cloneUrl, private: r.private === true }));
  } catch (e) {
    log?.warn?.('Workbench could not list your repositories on GitHub:', e);
  }
  out(`WORKBENCH_GITHUB_REPOS ${JSON.stringify(repos)}`);
  return 0;
}

function openBrowser(address) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? null : 'xdg-open';
  if (!cmd) {
    say('Open the address above in your browser.');
    return;
  }
  try {
    const child = spawn(cmd, [address], { stdio: 'ignore', detached: true });
    child.on('error', () => say('Could not open the browser. Open the address above yourself.'));
    child.unref();
  } catch {
    say('Could not open the browser. Open the address above yourself.');
  }
}

/** Exit with a code once output is flushed; force it if something keeps the process alive. */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

// ------------------------------------------------------------------ main

async function main() {
  // Output nobody reads any more is let go: the Mac app went away (it crashed), or the program reading a pipe ended.
  // Unheard, each failed write (EPIPE) would be an unexpected error whose report is another failed write, a loop that
  // kept the shutdown from running until the forced exit.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.error) {
    complain(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  // Every agent Workbench starts has WORKBENCH_AGENT_ID. An agent working on this repository could otherwise start a
  // second Workbench, whose real agents would run on the person's login without the person seeing them. Cloning and
  // the GitHub helpers reach the person's keys and accounts too.
  if (!args.demo && process.env.WORKBENCH_AGENT_ID !== undefined) {
    complain(INSIDE_AGENT);
    return 2;
  }
  // Where the agents' installers put their programs, at the end of PATH: Workbench, its agents and checks, and
  // Agents & keys' Check again then find a program installed while Workbench runs.
  const withLocalBin = pathWithLocalBin(process.env.PATH, os.homedir());
  if (withLocalBin !== process.env.PATH) process.env.PATH = withLocalBin;
  const log = createLogger(args.verbose);

  // The Mac app's helpers: connect GitHub with a token from standard input, or list its repositories. Then exit. They
  // need only the key store and Agents & keys, which checks no agent for them: no other module has to load. Without
  // them, --connect-github says it could not connect, and --github-repos lists nothing.
  if (args.connectGithub || args.githubRepos) {
    let connect = null;
    try {
      ({ connect } = await openConnect({}, args, log, { probe: false }));
    } catch (err) {
      log.warn('Workbench could not open Agents & keys:', err);
    }
    if (args.connectGithub) return connectGithubMode({ connect, readToken: () => readLine(process.stdin), log });
    return githubReposMode({ connect, log });
  }

  let mods;
  try {
    mods = await loadModules(args.demo, log);
  } catch (err) {
    complain(err.message);
    if (args.verbose && err.cause) complain(err.cause.stack || String(err.cause));
    return 1;
  }

  // --clone: copy the repository first, then go on as --repo <its folder>. For the Mac app, standard input is the
  // lifeline from now on: if it closes after the clone, Workbench stops as soon as it has started (appGone, below).
  let appGone = false;
  if (args.clone) {
    // A stop while git copies (Ctrl-C; the app's Cancel or Quit, which send SIGTERM and may close standard input
    // first; a closed terminal) is said once. Git's whole process group is stopped and what it made so far is removed
    // (cloneRepo, through the signal); then Workbench exits 1, and nothing starts. Should that take longer than
    // CLONE_STOP_MS, Workbench leaves anyway, and its exit kills git and removes the folder (workspace.mjs).
    const stopCopying = new AbortController();
    let copying = true;
    const stop = (said) => {
      if (!copying || stopCopying.signal.aborted) return;
      complain(said);
      stopCopying.abort();
      setTimeout(() => process.exit(1), CLONE_STOP_MS).unref();
    };
    const cancel = () => stop('Stopped copying the repository.');
    for (const sig of STOP_SIGNALS) process.on(sig, cancel);
    if (args.app) {
      const gone = () => {
        appGone = true;
        stop('The app closed, so Workbench stopped copying the repository.');
      };
      for (const ev of ['end', 'close', 'error']) process.stdin.on(ev, gone);
      process.stdin.resume();
    }
    const cloned = await cloneFirst({ workspace: mods.workspace, url: args.clone, into: args.into, app: args.app, signal: stopCopying.signal, log });
    copying = false;
    for (const sig of STOP_SIGNALS) process.off(sig, cancel);
    if (stopCopying.signal.aborted) return 1;
    if (!cloned.root) return cloned.code ?? 1;
    args.repo = cloned.root;
  }

  // Live mode: the repository, the key store and Agents & keys. No agent program has to be ready: Workbench starts
  // anyway, and the page connects one.
  let repo = null;
  let identity; // { name, email } or null from the workspace module; undefined when it could not tell
  let connect = null;
  const adapters = {};
  if (!args.demo) {
    const repoPath = path.resolve(args.repo);
    try {
      repo = await mods.workspace.prepareRepo(repoPath);
    } catch (err) {
      complain(err?.message || `Workbench could not use ${repoPath} as a git repository.`);
      return 1;
    }
    if (typeof mods.workspace.gitIdentity === 'function') {
      try {
        identity = await mods.workspace.gitIdentity({ repoRoot: repo.root });
      } catch (err) {
        log.debug('Could not read git’s name and email:', err);
      }
    }
    ({ connect } = await openConnect(mods, args, log));
    const claude = claudeAdapter(mods.claude, args.claude);
    const claudeInfo = await availability(claude, 'Claude Code');
    const codexInfo = await availability(mods.codex, 'Codex');
    // Every program Workbench can drive goes to the engine, ready or not: the engine checks each one itself, and one
    // installed or signed in later, from the page, can then start without a restart (connect's 'agents' event).
    if (complete(claude)) adapters.claude = claude;
    if (complete(mods.codex)) adapters.codex = mods.codex;
    if (claudeInfo.ok) {
      say(`Claude Code${claudeInfo.version ? ' ' + claudeInfo.version : ''} is ready${CLAUDE_FROM[claudeInfo.from] || ''}.`);
      if (claudeInfo.path) log.info(`Claude Code is ${claudeInfo.path}`);
    } else {
      say(`Claude Code is not available: ${sentence(claudeInfo.reason || 'it was not found')}`);
    }
    say(codexInfo.ok ? `Codex${codexInfo.version ? ' ' + codexInfo.version : ''} is ready.` : `Codex is not available: ${sentence(codexInfo.reason || 'it was not found')}`);
    if (!claudeInfo.ok && !codexInfo.ok) say(NO_AGENT);
  }

  const token = crypto.randomBytes(32).toString('hex');
  // Each Claude Code agent gets its own hook token: an HMAC of its id under a key that never leaves this process.
  // A token opens /hook for that one agent only, and never /api.
  const hookKey = crypto.randomBytes(32);
  const hookTokenFor = (agentId) => crypto.createHmac('sha256', hookKey).update(`workbench-hook:${agentId}`).digest('hex');
  const hook = { url: null, tokenFor: hookTokenFor };
  const store = new mods.Store({ logPath: args.eventLog ? path.resolve(args.eventLog) : null, log });
  const machines = new mods.Machines({ demo: args.demo });

  let engine = null;
  const early = []; // simulator events emitted before the engine exists
  if (args.demo) {
    adapters.sim = new mods.Simulator({
      emit: (ev) => (engine ? engine.ingest(ev) : early.push(ev)),
      now: () => Date.now(),
      speed: 1,
      seed: 1,
    });
  }
  engine = new mods.Engine({
    store,
    mode: args.demo ? 'demo' : 'live',
    repo,
    hook,
    defaultBudgetUsd: args.budget ?? DEFAULT_BUDGET_USD,
    defaultModel: args.model || null,
    adapters,
    machines,
    connect,
    deps: { policy: mods.policy, commands: mods.commands, workspace: mods.workspace, receipt: mods.receipt, history: mods.history },
    log,
  });
  for (const ev of early.splice(0)) engine.ingest(ev);
  // Agents & keys checked the agent programs again (the page asked, or came back from Terminal): which ones can start
  // changes now. Agents already at work are not touched.
  connect?.on?.('agents', (found) => {
    if (typeof engine.setHarnesses !== 'function') return;
    Promise.resolve().then(() => engine.setHarnesses(found)).catch((err) => log.error('Workbench could not take in the agents it found:', err));
  });

  let server = mods.createServer({ engine, store, token, hookTokenFor, connect, repoRoot: repo?.root ?? null, port: args.port, host: '127.0.0.1', rootDir: ROOT, log });

  // From here on, every way out stops the agents first: orphaned agents keep spending.
  // The only copy of an agent's work is its own folder: every way out also says where the folders are.
  let toldKept = false;
  const tellKept = (kept, tidied) => {
    if (toldKept || !kept.length) return;
    toldKept = true;
    const one = kept.length === 1;
    // After a clean shutdown the folders with no changes are gone. A forced exit skips that, so it claims no work.
    if (tidied) say(one ? 'What the agent did stays on this computer, in its own folder:' : 'What the agents did stays on this computer, each in its own folder:');
    else say(one ? 'The agent’s folder is still on this computer:' : 'The agents’ folders are still on this computer:');
    for (const k of kept) say(`  ${k.name}: ${k.path}${k.branch ? ` (branch ${k.branch})` : ''}`);
  };
  /** Exit once what was said has reached the terminal or a pipe, or after half a second. */
  const exitAfterOutput = (code) => {
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  };
  let forcing = false;
  /** Stop waiting (a second Ctrl-C, or 12 seconds): end every agent and check now, say where the folders are, exit. */
  const forceExit = (code) => {
    if (forcing) { process.exit(code); return; } // asked again while the words go out
    forcing = true;
    try { engine.killAllSync(); } catch (err) { log.error('Could not stop everything:', err); }
    let kept = [];
    try { kept = engine.keptFolders(); } catch (err) { log.error('Could not list the agent folders:', err); }
    tellKept(kept, false);
    exitAfterOutput(code);
  };
  let stopping = null;
  const stopAll = (code) => {
    if (stopping) return stopping;
    stopping = (async () => {
      say('Stopping the agents and closing Workbench…');
      const force = setTimeout(() => forceExit(code), 12_000);
      force.unref();
      let kept = [];
      try { kept = (await engine.shutdown())?.kept || []; } catch (err) { log.error('Shutdown failed:', err); }
      try { await server.close(); } catch (err) { log.error('Closing the server failed:', err); }
      try { store.close(); } catch { /* ignore */ }
      if (forcing) return; // a forced exit is already on its way out
      tellKept(kept, true);
      exitAfterOutput(code);
    })();
    return stopping;
  };
  process.on('SIGINT', () => {
    if (stopping) { // a second Ctrl-C: stop waiting
      forceExit(130);
      return;
    }
    stopAll(0);
  });
  process.on('SIGTERM', () => stopAll(0));
  process.on('SIGHUP', () => stopAll(0));
  process.on('exit', () => {
    try { engine.killAllSync(); } catch { /* ignore */ }
  });
  process.on('uncaughtException', (err) => {
    log.error('Unexpected error:', err);
    stopAll(1);
  });
  process.on('unhandledRejection', (err) => {
    log.error('Unexpected error:', err);
  });

  let url;
  try {
    try {
      ({ url } = await server.listen());
    } catch (err) {
      // A fresh clone is not thrown away for a busy port: the page takes a free one (the Mac app reads it from WORKBENCH_APP).
      if (err.code !== 'EADDRINUSE' || !args.clone || args.port === 0) throw err;
      await server.close().catch(() => {});
      server = mods.createServer({ engine, store, token, hookTokenFor, connect, repoRoot: repo?.root ?? null, port: 0, host: '127.0.0.1', rootDir: ROOT, log });
      ({ url } = await server.listen());
      say(`Port ${args.port} is already in use, so the page took a free one.`);
    }
  } catch (err) {
    if (err.code === 'EADDRINUSE') complain(`Port ${args.port} is already in use. Try another one with --port, or --port 0 to pick a free one.`);
    else if (err.code === 'EACCES') complain(`Workbench is not allowed to use port ${args.port}. Try another one with --port, or --port 0.`);
    else complain(`Workbench could not start its web page: ${err.message}`);
    await engine.shutdown().catch(() => {});
    return 1;
  }
  hook.url = new URL('hook/pretool', url).href;

  try {
    await engine.start();
  } catch (err) {
    complain(err?.message || 'Workbench could not start.');
    await engine.shutdown().catch(() => {});
    await server.close().catch(() => {});
    return 1;
  }

  const address = `${url}?t=${token}`;
  say(`Workbench is running at ${address}`);
  if (args.demo) {
    say('This is the demo: the agents and cloud machines are simulated, and nothing is spent.');
  } else {
    say(`Agents work on ${repo.name || 'your repository'}, each in its own copy made from the last commit.`);
    const dirty = Number(repo.dirty) || 0;
    if (dirty) say(`Your ${dirty} uncommitted change${dirty === 1 ? ' is' : 's are'} not included.`);
    say(`Each agent can spend up to $${(args.budget ?? DEFAULT_BUDGET_USD).toFixed(2)}.`);
    if (identity === null) say(NO_GIT_IDENTITY);
  }
  say('Press Ctrl-C to stop.');
  if (args.app) {
    // The Mac app reads this one line to show the page in its own window. Its pipe to our standard input is the
    // lifeline: when the app quits, or crashes, the pipe closes and Workbench stops its agents as on Ctrl-C.
    say(`WORKBENCH_APP ${JSON.stringify({ url: address, repo: args.demo ? null : (repo.name || null), root: args.demo ? null : (repo.root || null), demo: !!args.demo })}`);
    process.stdin.on('end', () => stopAll(0));
    process.stdin.on('close', () => stopAll(0));
    process.stdin.on('error', () => stopAll(0));
    process.stdin.resume();
    if (appGone) stopAll(0); // the app went away while Workbench started, after a clone
  }
  if (args.open) openBrowser(address);
  return null; // keep running
}

/** Run as a program (also through a link to this file), not imported by a test. */
function runAsProgram() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsProgram()) {
  main().then(
    (code) => { if (code != null) finish(code); },
    (err) => {
      complain(`Workbench stopped because of an unexpected error: ${err?.message || err}`);
      finish(1);
    },
  );
}
