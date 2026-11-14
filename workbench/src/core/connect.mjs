// The connect service: which coding agents are here and signed in, the keys Workbench gives them, the person's name
// and email for git, and GitHub: through GitHub's command-line tool, gh (src/core/github.mjs: Sign in to GitHub, with
// no token), or through a token (milestone 1's "Use a token instead"). The page's Agents & keys panel shows `status()`,
// and its buttons call the methods below through the routes in src/server/http.mjs. See ARCHITECTURE.md, "Connect".
//
// Nothing here returns, logs or emits a secret value, or a vendor program's own words: sentences are built from facts
// Workbench found itself. Claude Code's sign-in is read from `claude auth status`, never from its keychain item, and the
// email address and organisation in that answer are never kept.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubEnv, withNodeOnPath, onPath, shellQuote } from '../adapters/claude/args.mjs';
import { buildEnv as codexEnv, codexBin } from '../adapters/codex/runner.mjs';
import { KEY_PRESETS } from '../shared/keypresets.mjs';
import { maskSecrets, readPrivateFile } from './keys.mjs';
import { SignIns, SIGNIN_CHECK_MS, SIGNIN_TIMEOUT_MS } from './signin.mjs';
import * as workspaceModule from './workspace.mjs';
import { openTerminal as openTerminalWindow, openTerminalSteps as openTerminalStepsWindow } from './terminal.mjs';
import * as githubModule from './github.mjs';
import { GH_DEVICE_URL, GH_HELPER_KEYS, GH_MIN_VERSION, LOGIN_MAX_MS, versionAtLeast } from './github.mjs';

/**
 * Once gh's sign-in in Terminal is there, how long Workbench waits for the setup-git step after it to make git use gh,
 * before it runs setup-git itself: two at once can leave git's settings doubled.
 */
const GH_SETUP_WAIT_MS = 10_000;
/** How long one sign-in check may take. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long an adapter's own available() may take here, `--version` included (the CLI's check without Agents & keys gives it 15 seconds). */
const AVAILABLE_TIMEOUT_MS = 30_000;
/**
 * How long an agent's `--version` may take inside available(). A program just updated is scanned by macOS the first
 * times it runs, and a busy Mac is slower still: with the adapters' own 5 seconds, one slow check would make the agent
 * "could not be started" and refuse every launch until the next check.
 */
const VERSION_TIMEOUT_MS = 20_000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
/** Where an agent program was found, in words. */
const FROM_WORDS = { flag: 'the path given with --claude', path: 'your PATH', vscode: 'the VS Code extension' };

/**
 * The agents Workbench drives, in the order "the first ready agent" goes through. Each has its vendor's installer (a
 * fixed shell line, run in Terminal as `/bin/sh -c <line>`: the one shell line besides workbench.json's checks), the
 * arguments of its own sign-in in Terminal (`signin`) and in the browser (`browser`, and `console` for Claude Code's
 * Anthropic Console account: src/core/signin.mjs), with the site the person signs in to, the key preset "Use an API key"
 * saves, and how to probe it. Agents spoken to over ACP join this list later.
 */
const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    installer: 'curl -fsSL https://claude.ai/install.sh | bash',
    signin: ['auth', 'login'],
    browser: { args: ['auth', 'login', '--claudeai'], site: 'Claude' },
    console: { args: ['auth', 'login', '--console'], site: 'your Anthropic Console account' },
    key: {
      preset: 'anthropic', label: 'Anthropic', names: ['ANTHROPIC_API_KEY'],
      saved: 'Claude Code will use this API key from now on, and each request is billed to it.',
    },
    probe: (c, repoRoot) => c._probeClaude(repoRoot),
  },
  {
    id: 'codex',
    name: 'Codex',
    installer: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    signin: ['login'],
    browser: { args: ['login'], site: 'ChatGPT' },
    console: null,
    key: {
      preset: 'openai', label: 'OpenAI', names: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
      saved: 'Codex will use this API key from now on, and each request is billed to it.',
    },
    probe: (c, repoRoot) => c._probeCodex(repoRoot),
  },
];
const AGENT_BY_ID = new Map(AGENTS.map((a) => [a.id, a]));

/** A refusal the routes answer with a 4xx: a plain sentence, `.why`, and the HTTP status that fits. */
function refusal(why, sentence, status = 400) {
  return Object.assign(new Error(sentence), { plain: true, why, sentence, status });
}

/**
 * The HTTP status of a key store refusal, by its `.why`: what was asked for cannot be kept (400), or the place keys are
 * kept failed (500). The key store's errors carry `.plain`, `.why` and a plain message, but no status.
 */
const KEY_STORE_STATUS = Object.freeze({ name: 400, value: 400, forbidden: 400, 'too-many': 400, store: 500 });

/** `e` with the status its `.why` calls for, when it is a key store refusal without a status of its own. */
function withStoreStatus(e) {
  if (e && typeof e === 'object' && typeof e.why === 'string' && e.status === undefined && Object.hasOwn(KEY_STORE_STATUS, e.why)) {
    e.status = KEY_STORE_STATUS[e.why];
  }
  return e;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function sameFolder(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const real = (p) => {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
  };
  return real(a) === real(b);
}

/** "A", "A and B", "A, B and C" */
function listWords(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One line of text from somewhere else: control, line-separator and direction-changing characters become spaces. */
function oneLine(text, max = 200) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

const agentName = (id) => AGENT_BY_ID.get(id)?.name || 'another agent';

/** Node scripts (the tests' stand-ins) run with this node, as the Codex adapter runs them. */
function commandFor(program, args) {
  return /\.(mjs|cjs|js)$/i.test(program) ? [process.execPath, [program, ...args]] : [program, args];
}

/** Words for a person to type into a shell: plain words as they are, anything else quoted. */
function commandLine(words) {
  return words.map((w) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(w) ? w : shellQuote(w))).join(' ');
}

/**
 * Run a short program with stdin closed and a time limit. Never rejects: `{ code, stdout, stderr, timedOut, error }`.
 */
function runQuick(program, args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const [file, argv] = commandFor(program, args);
    let child;
    try {
      child = spawn(file, argv, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fields) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error: null, ...fields, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout = (stdout + d).slice(-256 * 1024); });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-16 * 1024); });
    child.on('error', (error) => finish({ error }));
    child.on('close', (code) => finish({ code }));
  });
}

/** `promise`, or `fallback` when it takes longer than `ms` or rejects. */
async function within(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What `claude auth status` says about signing in, read from its JSON (never its exit code, which says only whether
 * there is a claude.ai login). In the order Claude Code uses them: a cloud provider, then an API key (from the
 * environment or an apiKeyHelper), then the Claude subscription. Nothing else in the answer is kept.
 * @returns {{ signedIn: 'yes'|'no'|'unknown', how: string|null }}
 */
export function claudeSignIn(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { signedIn: 'unknown', how: null };
  const provider = typeof j.apiProvider === 'string' ? j.apiProvider : null;
  const keySource = typeof j.apiKeySource === 'string' && j.apiKeySource && j.apiKeySource !== 'none';
  const method = typeof j.authMethod === 'string' ? j.authMethod : null;
  if ((provider && provider !== 'firstParty') || method === 'third_party') return { signedIn: 'yes', how: 'a cloud provider' };
  if (keySource || method === 'api_key' || method === 'api_key_helper') return { signedIn: 'yes', how: 'an API key' };
  if (j.loggedIn === true) return { signedIn: 'yes', how: 'your Claude subscription' };
  if (j.loggedIn === false) return { signedIn: 'no', how: null };
  return { signedIn: 'unknown', how: null };
}

/** The JSON object in a program's output, also when a line of something else comes before it. */
function jsonIn(text) {
  const t = String(text || '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The sentence for one agent, from what Workbench found. */
function agentSentence(a) {
  const v = a.version ? ` ${a.version}` : '';
  if (!a.found && !a.runs) return a.missing || `${a.name} is not installed.`;
  if (!a.runs) return a.path ? `${a.name} is at ${a.path}, but it could not be started.` : `${a.name} is installed, but it could not be started.`;
  if (a.signedIn === 'no') return `${a.name}${v} is installed but not signed in.`;
  if (a.signedIn === 'unknown') return `${a.name}${v} is installed, but Workbench could not check whether it is signed in.`;
  return a.how ? `${a.name}${v} is ready, signed in with ${a.how}.` : `${a.name}${v} is ready.`;
}

/** The buttons that make sense for one agent, in the panel's order. */
function actionsFor(a, isDefault) {
  const list = [];
  if (a.runs && a.signedIn !== 'yes') list.push('signin');
  if (!a.runs) list.push('install');
  if (a.runs) list.push('key');
  if (a.ready && !isDefault) list.push('default');
  list.push('recheck');
  return list;
}

// ---------------------------------------------------------------- the sign-in in the browser, and git itself

/** "The sign-in in the browser did not finish. Sign in in Terminal instead." (outside macOS: "in a terminal"). */
function signInFallback(platform) {
  return `The sign-in in the browser did not finish. Sign in in ${platform === 'darwin' ? 'Terminal' : 'a terminal'} instead.`;
}

/** "Finish signing in to Claude in your browser." (… to your Anthropic Console account …, … to ChatGPT …) */
function waitingSentence(d, mode) {
  const how = mode === 'console' && d.console ? d.console : d.browser;
  return `Finish signing in to ${how.site} in your browser.`;
}

/** How long each of git's checks may take (`xcode-select -p`, `git --version`). */
const GIT_CHECK_MS = 5000;
/** How long `xcode-select --install` may take to open Apple's installer. */
const GIT_INSTALL_MS = 15_000;
/** How long status() trusts a check that found git, before it looks again (one that did not find it, never). */
const GIT_KNOWN_MS = 60_000;
const XCODE_SELECT = '/usr/bin/xcode-select';
/** Apple's stand-in for git: until Apple's developer tools are installed, running it opens Apple's installer. */
const APPLE_GIT = '/usr/bin/git';
const GIT_MISSING_MAC = 'Git is not installed yet. Apple’s developer tools include it.';
const GIT_MISSING_ELSEWHERE = 'Git is not installed yet. Install git with your package manager.';

function isAppleGit(p) {
  if (p === APPLE_GIT) return true;
  try {
    return fs.realpathSync.native(p) === APPLE_GIT;
  } catch {
    return false;
  }
}

/**
 * Whether git can run here, and what to say when it cannot. On a Mac, /usr/bin/git is Apple's stand-in until Apple's
 * developer tools are installed, and running it then opens Apple's installer: so when that is the git on the PATH (or
 * there is none), `xcode-select -p` is asked first, and git runs only when it says the tools are there. Another git
 * first on the PATH (Homebrew's) is asked directly, and so is git elsewhere: `git --version`, through workspace.mjs's
 * git(). Each has 5 seconds. Agents & keys and the CLI's --git-status use this.
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {object} [o.env]        whose PATH is looked in
 * @param {Function} [o.run]      runs xcode-select: (program, args, { env, cwd, timeoutMs }) => Promise<{ code, stdout,
 *   stderr, timedOut, error }>
 * @param {Function|null} [o.runGit] workspace.mjs's git(); null for a stand-in workspace without one: git then counts as
 *   installed, and nothing runs
 * @param {string} [o.cwd]        where the programs run
 * @param {Function} [o.log]      (level, line)
 * @returns {Promise<{ installed: boolean, canInstall: boolean, version: string|null, sentence: string }>} canInstall:
 *   Workbench can start git's installer (Apple's, on a Mac)
 */
export async function gitPresence({ platform = process.platform, env = process.env, run = runQuick, runGit = workspaceModule.git, cwd = os.tmpdir(), log = null } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const mac = platform === 'darwin';
  const missing = { installed: false, canInstall: mac, version: null, sentence: mac ? GIT_MISSING_MAC : GIT_MISSING_ELSEWHERE };
  if (typeof runGit !== 'function') return { installed: true, canInstall: false, version: null, sentence: 'Git is installed.' };
  if (mac) {
    const first = onPath('git', env && env.PATH);
    if (!first || isAppleGit(first)) {
      let r;
      try {
        r = await run(XCODE_SELECT, ['-p'], { env, cwd, timeoutMs: GIT_CHECK_MS });
      } catch (error) {
        r = { code: null, error };
      }
      const noXcodeSelect = !!(r && r.error && r.error.code === 'ENOENT'); // not a Mac after all: git is asked directly
      if (!noXcodeSelect && (!r || r.timedOut || r.error || r.code !== 0)) {
        say('info', 'git cannot run yet: Apple’s developer tools are not installed (xcode-select -p did not find them).');
        return missing;
      }
    }
  }
  let r;
  try {
    r = await runGit(['--version'], { cwd, timeout: GIT_CHECK_MS });
  } catch (e) {
    say('info', `git could not be run (${(e && (e.code || e.signal)) || 'it failed'}).`);
    return missing;
  }
  const m = /git version (\d{1,4}\.\d{1,4}(?:\.\d{1,6})?)/.exec(String((r && r.stdout) || ''));
  return { installed: true, canInstall: false, version: m ? m[1] : null, sentence: m ? `Git ${m[1]} is installed.` : 'Git is installed.' };
}

/**
 * "AWS for all repositories, given to all agents: AWS_ACCESS_KEY_ID •••• 7QXA, AWS_SECRET_ACCESS_KEY •••• 9f2b". A key for
 * one repository reads "this repository" when its scope says `here` (status() compares real paths).
 */
function keySentence(k) {
  const label = oneLine(k.label, 80) || 'A key';
  const scope = k.scope && k.scope.kind === 'repo'
    ? (k.scope.here === true ? 'this repository' : `the repository at ${oneLine(k.scope.root, 300)}`)
    : 'all repositories';
  const agents = k.agents === 'all' ? 'all agents'
    : Array.isArray(k.agents) && k.agents.length ? listWords(k.agents.map(agentName)) : 'no agent';
  const vars = Array.isArray(k.vars) ? k.vars.map((v) => `${oneLine(v.name, 128)} ${oneLine(v.shown, 120)}`).join(', ') : '';
  return `${label} for ${scope}, given to ${agents}${vars ? `: ${vars}` : ''}`;
}

/** A repository from GitHub's list, or null when it is not in the shape Workbench expects. */
function repoOf(r) {
  if (!r || typeof r !== 'object') return null;
  const fullName = typeof r.full_name === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r.full_name) ? r.full_name : null;
  if (!fullName || r.clone_url !== `https://github.com/${fullName}.git`) return null;
  return { fullName, cloneUrl: r.clone_url, private: r.private === true, pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at.slice(0, 40) : null };
}

function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Workbench' };
}

/** GET a URL and read its JSON, with fetch (built into node). No redirects: the token goes to that address only. */
async function fetchJsonWithNode(url, { headers } = {}) {
  const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** What the panel says once gh is signed in and git uses it. */
function ghSignedIn(login) {
  return `Signed in to GitHub as ${login}. Git in Terminal, Workbench and your agents use this sign-in.`;
}

/** Call a listener; one that throws never breaks a sign-in. */
function callQuietly(fn, arg) {
  try { fn(arg); } catch { /* the listener's trouble */ }
}

/** The fields of `o` named in `keys` that are not undefined. */
function pickDefined(o, keys) {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
}

function makeLog(log) {
  return (level, msg) => {
    const line = `connect: ${msg}`;
    try {
      if (log && typeof log[level] === 'function') log[level](line);
      else if (typeof log === 'function') log(line);
      else if (log && typeof log.log === 'function') log.log(line);
    } catch { /* logging must never break the panel */ }
  };
}

/**
 * The connect service. Emits 'agents' with `{ claude: info, codex: info }` whenever what it knows about the agents
 * changes (each info: the adapter's own available() answer, plus `found`, `signedIn`, `how` and `ready`, with `ok`
 * meaning ready: the program runs and is not known to be signed out; `reason` says why not), and 'changed' when
 * anything the panel shows may have changed.
 */
export class Connect extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.home]        the home folder (settings.json lives in <home>/.workbench)
   * @param {string} [o.platform]    process.platform; only 'darwin' opens Terminal
   * @param {object} [o.env]         the environment agents are made from (process.env)
   * @param {object} o.keys          the KeyStore (src/core/keys.mjs), loaded: list, add, remove, envFor, values and
   *   valuesOf (the GitHub connection's token is read back with it)
   * @param {object} [o.workspace]   src/core/workspace.mjs, or a stand-in
   * @param {object} [o.adapters]    { claude, codex }: the adapter modules, as the CLI loads them
   * @param {object} [o.flags]       { claude: the --claude path or null }
   * @param {string} [o.settingsPath] default <home>/.workbench/settings.json
   * @param {Function} [o.openTerminal] ({ title, program, args }) => Promise<{ opened }>, default from terminal.mjs
   * @param {Function} [o.fetchJson] (url, { headers }) => Promise<{ status, json }>, default fetch
   * @param {object|Function} [o.log]
   * @param {string} [o.repoRoot]   the repository Workbench works on: the first probe gives the agents its keys too
   * @param {boolean} [o.probe]      probe the agents at once (true): defaultAgent() cannot tell until a probe ends.
   *   Pass false where no agent will be started (the CLI's GitHub helpers, such as --connect-github and --github-repos).
   *   Also accepted, mainly for tests: presets (the KEY_PRESETS list), probeTimeoutMs (10 000).
   * @param {Function} [o.openTerminalSteps] ({ title, steps }) => Promise<{ opened }>, default from terminal.mjs (GitHub's
   *   sign-in in Terminal: gh's login, then setup-git)
   * @param {object} [o.ghModule]    src/core/github.mjs, or a stand-in for some of its functions
   * @param {object} [o.ghOptions]   for GitHub through gh, mainly for tests: { fetchImpl, verify, osRelease, arch, tmpDir,
   *   dirs, codeWaitMs (15 s), loginMs (14.5 min), terminalMs (15 min), pollMs (3 s), setupWaitMs (10 s) }
   * @param {Function} [o.runProgram] runs xcode-select (git's checks and Install): (program, args, { env, cwd, timeoutMs })
   *   => Promise<{ code, stdout, stderr, timedOut, error }>; tests give a stand-in, never the real `xcode-select --install`
   * @param {number} [o.signInTimeoutMs] how long a sign-in in the browser may wait (10 minutes); for tests
   * @param {number} [o.signInCheckMs]   how often the agent is asked whether it is signed in meanwhile (2 seconds)
   */
  constructor({
    home = os.homedir(), platform = process.platform, env = process.env, keys, workspace = workspaceModule, adapters = {},
    flags = {}, settingsPath, openTerminal = openTerminalWindow, fetchJson = fetchJsonWithNode, log = null, repoRoot = null,
    probe = true, presets = KEY_PRESETS, probeTimeoutMs = PROBE_TIMEOUT_MS, versionTimeoutMs = VERSION_TIMEOUT_MS,
    openTerminalSteps = openTerminalStepsWindow, ghModule = null, ghOptions = {},
    runProgram = runQuick, signInTimeoutMs = SIGNIN_TIMEOUT_MS, signInCheckMs = SIGNIN_CHECK_MS,
  } = {}) {
    super();
    if (!keys || typeof keys.list !== 'function' || typeof keys.add !== 'function') throw new Error('The connect service needs the key store.');
    this.home = home;
    this.platform = platform;
    this.env = env || {};
    this.keys = keys;
    this.workspace = workspace;
    this.adapters = adapters || {};
    this.flags = flags || {};
    this.settingsPath = settingsPath || path.join(home, '.workbench', 'settings.json');
    this.openTerminal = openTerminal;
    this.fetchJson = fetchJson;
    this.presets = Array.isArray(presets) ? presets : [];
    this.probeTimeoutMs = probeTimeoutMs;
    this.versionTimeoutMs = versionTimeoutMs;
    this._log = makeLog(log);
    this._agents = null; // id -> what the last probe found
    // Signing in in the browser (src/core/signin.mjs): its state lives there, not in what a probe found, which each
    // probe replaces. Starts under way (one at a time per agent), and the agents whose browser sign-in that did not
    // finish the person took to Terminal since. Git's own presence: the last check that found it, trusted a minute.
    this._runProgram = typeof runProgram === 'function' ? runProgram : runQuick;
    this._signIns = new SignIns({ timeoutMs: signInTimeoutMs, checkEveryMs: signInCheckMs, log: this._log });
    this._signIns.on('change', () => this.emit('changed'));
    this._signInStarts = new Map();
    this._signInTerminal = new Set();
    this._gitKnown = null;
    this._repoRoot = null;
    this._noteRepo(repoRoot); // before the first probe, so it counts the keys kept for this repository
    this._current = null; // the probe under way
    this._next = null; // one more probe, queued behind it
    this._settings = this._readSettings();
    // GitHub through gh: the sign-in under way, how the last one ended when it did not sign in, and what each gh says
    // its version is (asked again when the file changes).
    this.openTerminalSteps = openTerminalSteps;
    this.gh = { ...githubModule, ...(ghModule || {}) };
    this.ghOptions = ghOptions && typeof ghOptions === 'object' ? ghOptions : {};
    this._ghFlow = null;
    this._ghNote = null;
    this._ghTerminalSignOut = null; // a sign-out left to Terminal: { login }, until a status read finds gh signed out
    this._ghVersions = new Map();
    // An 'agents' listener added after a probe ended hears the last map at once (once), so the engine never misses the
    // first probe, however late it is wired.
    this.on('newListener', (event, listener) => {
      if (event !== 'agents' || !this._agents) return;
      setImmediate(() => {
        if (!this.listeners('agents').includes(listener)) return; // gone, or a once listener that heard a newer map
        if (this.rawListeners('agents').some((l) => l.listener === listener)) this.removeListener('agents', listener);
        try {
          listener.call(this, this._agentsMap());
        } catch (e) {
          this._log('warn', `an 'agents' listener failed: ${e && e.message}`);
        }
      });
    });
    // The first probe starts now.
    if (probe) this.recheck().catch((e) => this._log('warn', `the agents could not be checked: ${e && e.message}`));
  }

  /** The agents as the last probe found them: waits for the probe under way, or starts one, when none has ended. */
  async _known() {
    if (!this._agents) await (this._current || this.recheck());
    return this._agents;
  }

  // ---------------------------------------------------------------- status

  /**
   * Everything the panel shows. Agents come from the last probe (the first call probes); keys, git and GitHub are read
   * afresh. Never holds a secret value.
   * @param {{ repoRoot?: string }} [o] the repository Workbench works on: keys for it read "this repository"
   */
  async status({ repoRoot } = {}) {
    this._noteRepo(repoRoot);
    await this._known();
    this._settings = this._readSettings();
    const keys = await this._listKeys();
    const def = this.defaultAgent();
    const agents = AGENTS.map((d) => {
      const a = this._agents[d.id];
      const isDefault = def === d.id;
      return this._withSignIn(d, a, {
        id: d.id, name: d.name, found: a.found, version: a.version, from: a.runs || a.found ? FROM_WORDS[a.from] || a.fromWords || null : null,
        signedIn: a.signedIn, how: a.how, ready: a.ready, isDefault, sentence: a.sentence, actions: actionsFor(a, isDefault),
      });
    });
    const github = this._github(keys);
    const root = repoRoot || this._repoRoot;
    return {
      agents,
      defaultAgent: def,
      platform: this.platform,
      canOpenTerminal: this.platform === 'darwin',
      git: await this._gitStatus(root),
      github: await this._githubStatus(github),
      // A key for one repository says whether it is this one (`here`), by real paths, as envFor gives keys: the page
      // words "this repository" from that, never from folder names.
      keys: keys.filter((k) => k.id !== github.keyId).map((k) => {
        const scope = k.scope && k.scope.kind === 'repo' ? { ...k.scope, here: sameFolder(k.scope.root, root) } : k.scope;
        return { ...k, scope, sentence: keySentence({ ...k, scope }) };
      }),
      ready: agents.some((a) => a.ready),
    };
  }

  /**
   * Probe every agent again: whether its program runs (the adapter's available()) and whether it is signed in. Calls
   * made while one runs share one more probe after it. Emits 'agents' and 'changed'.
   * @returns {Promise<Record<string, object>>} the map 'agents' carries
   */
  async recheck({ repoRoot } = {}) {
    this._noteRepo(repoRoot);
    if (this._next) return this._next;
    if (this._current) {
      this._next = this._current.catch(() => {}).then(() => {
        this._next = null;
        return this._probeAll();
      });
      return this._next;
    }
    return this._probeAll();
  }

  _probeAll() {
    const run = (async () => {
      const root = this._repoRoot;
      const found = await Promise.all(AGENTS.map((d) => d.probe(this, root).catch((e) => {
        this._log('warn', `checking ${d.name} failed: ${e && e.message}`);
        return this._finish({ id: d.id, name: d.name, found: false, runs: false, info: { ok: false }, missing: `Workbench could not check ${d.name}.` });
      })));
      // A program that ran at the last check, is still a file, and now did not answer in time (it was slow, or the Mac
      // busy: a program just updated is scanned by macOS the first times it runs) keeps that last check, so one slow
      // answer does not refuse every launch. Only a timeout: a program that failed, or is gone, is what this check says.
      const before = this._agents || {};
      const kept = found.map((a) => {
        const was = before[a.id];
        const where = a.path || (was && was.path);
        if (a.runs || !was || !was.runs || !(a.info && a.info.timedOut === true) || !where || !isFile(where)) return a;
        this._log('warn', `${a.name} did not answer in time; Workbench keeps its last check (${was.sentence})`);
        return { ...was, stale: true };
      });
      // When an agent stops being ready, or is ready again, the log says so and why: launches follow it.
      for (const a of kept) {
        const was = before[a.id];
        if (was && was.ready && !a.ready) this._log('warn', `${a.name} was ready and is not now: ${a.sentence}`);
        else if (was && !was.ready && a.ready) this._log('warn', `${a.name} is ready again: ${a.sentence}`);
      }
      this._agents = Object.fromEntries(kept.map((a) => [a.id, a]));
      const map = this._agentsMap();
      this.emit('agents', map);
      this.emit('changed');
      return map;
    })();
    this._current = run;
    run.then(() => { if (this._current === run) this._current = null; }, () => { if (this._current === run) this._current = null; });
    return run;
  }

  /** `{ claude: info, codex: info }` for 'agents' (see the class comment). */
  _agentsMap() {
    const out = {};
    for (const d of AGENTS) {
      const a = this._agents && this._agents[d.id];
      if (!a) continue;
      const info = { ...(a.info || {}), ok: a.ready, ready: a.ready, found: a.found, signedIn: a.signedIn, how: a.how };
      if (a.version) info.version = a.version;
      if (a.ready) delete info.reason;
      else info.reason = a.sentence;
      out[d.id] = info;
    }
    return out;
  }

  /**
   * The agent new work goes to: the person's choice when it is ready, else the first ready one, else null. Undefined
   * until the first probe has ended: Connect cannot tell yet, and the engine then uses its own check.
   */
  defaultAgent() {
    if (!this._agents) return undefined;
    const ready = (id) => !!(this._agents[id] && this._agents[id].ready);
    const chosen = this._settings && this._settings.defaultAgent;
    if (typeof chosen === 'string' && AGENT_BY_ID.has(chosen) && ready(chosen)) return chosen;
    for (const d of AGENTS) if (ready(d.id)) return d.id;
    return null;
  }

  // ---------------------------------------------------------------- probes

  /** Claude Code: the adapter's available(), then `claude auth status` with the environment an agent would get. */
  async _probeClaude(repoRoot) {
    const d = AGENT_BY_ID.get('claude');
    const mod = this.adapters.claude;
    const info = mod && typeof mod.available === 'function'
      ? await within(mod.available({ env: this.env, claudePath: this.flags.claude || undefined, timeoutMs: this.versionTimeoutMs }), AVAILABLE_TIMEOUT_MS,
        { ok: false, timedOut: true, reason: 'Claude Code did not answer in time.' })
      : { ok: false, reason: 'Claude Code support could not be loaded.' };
    const safe = info && typeof info === 'object' ? info : { ok: !!info };
    const p = typeof safe.path === 'string' && safe.path ? safe.path : null;
    const a = {
      id: d.id, name: d.name, info: safe, path: p, from: safe.from || null, found: !!p && isFile(p), runs: safe.ok === true,
      version: safe.ok === true && VERSION_RE.test(String(safe.version || '')) ? safe.version : null, signedIn: 'unknown', how: null,
    };
    // A path given with --claude or WORKBENCH_CLAUDE_BIN that is not there: Workbench's own sentence about it.
    if (!a.found && (a.from === 'flag' || a.from === 'env') && typeof safe.reason === 'string') a.missing = oneLine(safe.reason.replace(/\s*It said:[\s\S]*$/, ''), 300);
    if (a.from === 'env') a.fromWords = 'WORKBENCH_CLAUDE_BIN';
    if (!a.runs || !p) return this._finish(a);
    const env = this._agentEnv('claude', repoRoot);
    const r = await runQuick(p, ['auth', 'status'], { env, cwd: this._probeFolder(), timeoutMs: this.probeTimeoutMs });
    if (r.timedOut) this._log('warn', 'Claude Code took too long to say whether it is signed in.');
    else if (r.error) this._log('warn', `Claude Code could not be asked whether it is signed in (${r.error.code || 'error'}).`);
    const read = r.timedOut || r.error ? { signedIn: 'unknown', how: null } : claudeSignIn(jsonIn(r.stdout));
    if (!r.timedOut && !r.error && read.signedIn === 'unknown') this._log('warn', 'Claude Code’s sign-in answer was not in a shape Workbench reads.');
    return this._finish({ ...a, ...read });
  }

  /**
   * Codex: the adapter's available(), then `codex login status` (exit 0: signed in) with the environment an agent would
   * get. A CODEX_API_KEY in that environment (a key saved here, or the person's own) also counts: `codex exec` uses it,
   * and `codex login status` may not report it.
   */
  async _probeCodex(repoRoot) {
    const d = AGENT_BY_ID.get('codex');
    const mod = this.adapters.codex;
    const info = mod && typeof mod.available === 'function'
      ? await within(mod.available({ env: this.env, timeoutMs: this.versionTimeoutMs }), AVAILABLE_TIMEOUT_MS, { ok: false, timedOut: true, reason: 'Codex did not answer in time.' })
      : { ok: false, reason: 'Codex support could not be loaded.' };
    const safe = info && typeof info === 'object' ? info : { ok: !!info };
    const env = this._agentEnv('codex', repoRoot);
    const bin = codexBin(this.env);
    const given = typeof this.env.WORKBENCH_CODEX_BIN === 'string' && this.env.WORKBENCH_CODEX_BIN !== '';
    const p = bin.includes('/') ? (isFile(path.resolve(bin)) ? path.resolve(bin) : null) : onPath(bin, env.PATH);
    const a = {
      id: d.id, name: d.name, info: safe, path: p, from: given ? 'env' : p ? 'path' : null, found: !!p, runs: safe.ok === true,
      version: safe.ok === true && VERSION_RE.test(String(safe.version || '')) ? safe.version : null, signedIn: 'unknown', how: null,
    };
    if (given) a.fromWords = 'WORKBENCH_CODEX_BIN';
    if (given && !p) a.missing = `Codex is not at ${oneLine(path.resolve(bin), 300)}, the path in WORKBENCH_CODEX_BIN.`;
    if (!a.runs) return this._finish(a);
    const r = await runQuick(p || bin, ['login', 'status'], { env, cwd: this._probeFolder(), timeoutMs: this.probeTimeoutMs });
    if (r.timedOut) this._log('warn', 'Codex took too long to say whether it is signed in.');
    if (!r.timedOut && !r.error && r.code === 0) {
      const said = `${r.stdout}\n${r.stderr}`; // read for these two facts only; never passed on
      a.signedIn = 'yes';
      a.how = /api key/i.test(said) ? 'an API key' : /chatgpt/i.test(said) ? 'your ChatGPT account' : null;
    } else if (!r.timedOut && !r.error && r.code === 1) {
      a.signedIn = 'no';
    }
    if (typeof env.CODEX_API_KEY === 'string' && env.CODEX_API_KEY.trim()) {
      a.signedIn = 'yes';
      a.how = 'an API key';
    }
    return this._finish(a);
  }

  /**
   * Where sign-in checks run: the home folder, never a repository's (a repository's own .claude settings could name a
   * program for Claude Code to run), or the temporary folder when there is no home folder.
   */
  _probeFolder() {
    try {
      if (fs.statSync(this.home).isDirectory()) return this.home;
    } catch { /* no home folder */ }
    return os.tmpdir();
  }

  /**
   * The environment an agent of this kind gets, for its sign-in checks and its login program: Claude Code's scrubbed
   * one with node on the PATH, or Codex's own (buildEnv), plus the keys the key store gives that agent in `repoRoot`.
   */
  _agentEnv(id, repoRoot = this._repoRoot) {
    if (id === 'codex') return { ...codexEnv(this.env), ...this._keyEnv(repoRoot, 'codex') };
    return { ...withNodeOnPath(scrubEnv(this.env)), ...this._keyEnv(repoRoot, 'claude') };
  }

  _finish(a) {
    const out = { signedIn: 'unknown', how: null, version: null, path: null, from: null, ...a };
    out.ready = !!out.runs && out.signedIn !== 'no';
    out.sentence = agentSentence(out);
    return out;
  }

  // ---------------------------------------------------------------- agent actions

  _agent(id) {
    const d = typeof id === 'string' ? AGENT_BY_ID.get(id) : null;
    if (!d) throw refusal('agent', 'Workbench does not know that agent.', 404);
    return d;
  }

  /**
   * Install an agent, or sign in to it, in Terminal: the vendor's own installer or sign-in, which the person answers
   * there. On macOS → `{ ok, opened: true, sentence }`; elsewhere, or when Terminal could not be opened →
   * `{ ok, opened: false, command, sentence }`, the command for the person to run. Refuses an unknown agent or action,
   * and signing in to an agent that is not installed.
   *
   * Signing in in Terminal is also the way on when a sign-in in the browser did not finish ("Sign in in Terminal"): a
   * browser sign-in still waiting for this agent stops first (Codex's login listens on one fixed port). With
   * `console: true` Claude Code signs in with an Anthropic Console account (`claude auth login --console`); left out, as
   * the last browser sign-in that did not finish did.
   * @param {string} id
   * @param {'install'|'signin'} action
   * @param {{ console?: boolean }} [o]
   */
  async agentAction(id, action, { console: useConsole } = {}) {
    const d = this._agent(id);
    if (action !== 'install' && action !== 'signin') throw refusal('action', 'Workbench does not know that action.', 400);
    let program;
    let args;
    let title;
    let command;
    if (action === 'install') {
      program = '/bin/sh';
      args = ['-c', d.installer];
      title = `Installing ${d.name}`;
      command = d.installer;
    } else {
      const a = (await this._known())[d.id];
      if (!a || !a.runs || !a.path) throw refusal('not-installed', `${d.name} is not installed yet, so there is nothing to sign in to.`, 409);
      await this._signInStarts.get(d.id)?.catch(() => {});
      this._signIns.cancel(d.id);
      const last = this._signIns.state(d.id);
      const inConsole = !!d.console && (useConsole === true || (useConsole === undefined && !!last && last.mode === 'console' && last.phase !== 'done'));
      const words = inConsole ? d.console.args : d.signin;
      [program, args] = commandFor(a.path, words);
      title = `Signing in to ${d.name}`;
      // Terminal's shell has the person's own PATH, so it is given the program's full path; the command shown uses the
      // bare name when that is how Workbench found it too.
      command = commandLine(a.from === 'path' ? [path.basename(a.path), ...words] : [program, ...args]);
      this._signInTerminal.add(d.id);
    }
    if (this.platform === 'darwin') {
      let res = null;
      try {
        res = await this.openTerminal({ title, program, args });
      } catch (e) {
        this._log('warn', `Terminal could not be opened: ${e && e.message}`);
      }
      if (res && res.opened) {
        return {
          ok: true, opened: true,
          sentence: action === 'install'
            ? `Terminal is installing ${d.name}. When it finishes, come back here.`
            : `Terminal is open for you to sign in to ${d.name}. When you are done, come back here.`,
        };
      }
      return { ok: true, opened: false, command, sentence: 'Workbench could not open Terminal. Run this command in a terminal, then check again.' };
    }
    return {
      ok: true, opened: false, command,
      sentence: action === 'install'
        ? `Run this command in a terminal to install ${d.name}, then check again.`
        : `Run this command in a terminal to sign in to ${d.name}, then check again.`,
    };
  }

  /**
   * "Use an API key": save it for all repositories, for this agent only (Claude Code: ANTHROPIC_API_KEY; Codex:
   * OPENAI_API_KEY and CODEX_API_KEY), in place of the key this button saved before. Then probe again.
   * @returns {Promise<{ ok: true, sentence: string }>}
   */
  async setAgentKey(id, value) {
    const d = this._agent(id);
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) throw refusal('value', 'Paste the key first.', 400);
    const { preset, label, names } = d.key;
    const before = await this._listKeys();
    const old = before.filter((k) => k.preset === preset && k.scope && k.scope.kind === 'all'
      && Array.isArray(k.agents) && k.agents.length === 1 && k.agents[0] === d.id);
    await this._storeAdd({ preset, label, values: Object.fromEntries(names.map((n) => [n, v])), secretNames: [...names], scope: { kind: 'all' }, agents: [d.id] });
    for (const k of old) await this._removeQuietly(k.id);
    await this.recheck();
    return { ok: true, sentence: d.key.saved };
  }

  /** "Use for new work": the person's choice, kept in settings.json. */
  async setDefaultAgent(id) {
    const d = this._agent(id);
    this._updateSettings((s) => ({ ...s, defaultAgent: d.id }));
    if (this._agents) this.emit('agents', this._agentsMap()); // never an empty map: the engine would take it as "nothing can start"
    this.emit('changed');
    const ready = !!(this._agents && this._agents[d.id] && this._agents[d.id].ready);
    return { ok: true, sentence: ready ? `New work will go to ${d.name}.` : `New work will go to ${d.name} once it is ready.` };
  }

  // ---------------------------------------------------------------- signing in in the browser

  /**
   * Sign in to an agent in the browser, with no Terminal and no key: its vendor's own login program runs in the
   * background (src/core/signin.mjs): Claude Code's `claude auth login --claudeai`, or with `console: true`
   * `claude auth login --console` (an Anthropic Console account, billed per request); Codex's `codex login`. It runs
   * as the sign-in check does: the program the probe found, the environment an agent of that kind gets, from the home
   * folder. It opens the person's browser, and keeps what it receives itself.
   *
   * Answers at once: `{ ok: true, waiting: true, since, sentence }` ("Finish signing in to Claude in your browser.").
   * Only one runs per agent: a second press answers the one under way. A program that could not start answers
   * `{ ok: false, waiting: false, why: 'start', sentence }`. Refused: an unknown agent (404), `console` for an agent
   * without an Anthropic Console sign-in (400), an agent that is not installed (409).
   * @param {string} id
   * @param {{ console?: boolean }} [o]
   */
  async agentSignIn(id, { console: useConsole = false } = {}) {
    const d = this._agent(id);
    if (useConsole === true && !d.console) throw refusal('action', `${d.name} has no Anthropic Console sign-in.`, 400);
    const waiting = this._signInWaiting(d);
    if (waiting) return waiting;
    // Registered before the first await, so two quick presses start one program.
    let starting = this._signInStarts.get(d.id);
    if (!starting) {
      starting = this._startSignIn(d, useConsole === true).finally(() => this._signInStarts.delete(d.id));
      this._signInStarts.set(d.id, starting);
    }
    return starting;
  }

  async _startSignIn(d, inConsole) {
    const a = (await this._known())[d.id];
    if (!a || !a.runs || !a.path) throw refusal('not-installed', `${d.name} is not installed yet, so there is nothing to sign in to.`, 409);
    const how = inConsole ? d.console : d.browser;
    const [file, args] = commandFor(a.path, how.args);
    this._signInTerminal.delete(d.id);
    this._log('info', `${d.name} is signing in in the browser: ${commandLine([path.basename(a.path), ...how.args])}`);
    const { state } = this._signIns.start(d.id, {
      file, args, env: this._agentEnv(d.id), cwd: this._probeFolder(), mode: inConsole ? 'console' : 'browser', label: d.name,
      signedInBefore: a.signedIn === 'yes',
      check: () => this._signedInNow(d, a.path),
      whenSignedIn: () => this.recheck(),
    });
    if (state.phase === 'waiting') return this._signInWaiting(d);
    return { ok: false, waiting: false, why: state.why, sentence: signInFallback(this.platform) };
  }

  /** The answer for a sign-in that waits, or null. */
  _signInWaiting(d) {
    const s = this._signIns.state(d.id);
    if (!s || s.phase !== 'waiting') return null;
    return { ok: true, waiting: true, since: s.since, sentence: waitingSentence(d, s.mode) };
  }

  /**
   * Whether the agent says it is signed in now: `claude auth status` (its JSON, as the probe reads it) or
   * `codex login status` (exit 0), with the agent's environment, from the home folder. 'unknown' when it cannot tell.
   */
  async _signedInNow(d, program) {
    const r = await runQuick(program, d.id === 'claude' ? ['auth', 'status'] : ['login', 'status'], {
      env: this._agentEnv(d.id), cwd: this._probeFolder(), timeoutMs: this.probeTimeoutMs,
    });
    if (r.timedOut || r.error) return 'unknown';
    if (d.id === 'claude') return claudeSignIn(jsonIn(r.stdout)).signedIn;
    return r.code === 0 ? 'yes' : r.code === 1 ? 'no' : 'unknown';
  }

  /**
   * The sign-in in the browser for this agent: null when none ran since Workbench started, else `{ phase, waiting,
   * console, since, endedAt, why, sentence }`. phase is 'waiting', 'done', 'failed' or 'cancelled' (signin.mjs says
   * why one failed: 'exit', 'input', 'timeout' or 'start').
   */
  agentSignInState(id) {
    const d = this._agent(id);
    const s = this._signIns.state(d.id);
    if (!s) return null;
    const sentence = {
      waiting: waitingSentence(d, s.mode),
      done: `${d.name} is signed in.`,
      failed: signInFallback(this.platform),
      cancelled: `Workbench stopped the sign-in to ${d.name}.`,
    }[s.phase];
    return { phase: s.phase, waiting: s.phase === 'waiting', console: s.mode === 'console', since: s.since, endedAt: s.endedAt, why: s.why, sentence };
  }

  /**
   * Cancel: stop the sign-in in the browser that waits for this agent (its program is stopped). Answers `{ ok: true,
   * stopped, sentence }`, also when none was waiting.
   */
  async cancelAgentSignIn(id) {
    const d = this._agent(id);
    await this._signInStarts.get(d.id)?.catch(() => {}); // one being started is stopped once it has started
    const stopped = this._signIns.cancel(d.id);
    return {
      ok: true, stopped,
      sentence: stopped ? `Workbench stopped the sign-in to ${d.name}.` : `No sign-in to ${d.name} is under way.`,
    };
  }

  /**
   * An agent's row with its sign-in in the browser: `signingIn` while one waits (and no Sign in button then); after
   * one that did not finish, while the agent is not signed in, "Sign in in Terminal" (`signin-terminal`) and, for a
   * failure the person has not taken to Terminal yet, the fallback sentence. Claude Code's row offers its Anthropic
   * Console sign-in (`signin-console`) wherever it offers Sign in.
   */
  _withSignIn(d, a, row) {
    const s = this._signIns.state(d.id);
    const waiting = !!s && s.phase === 'waiting';
    const unfinished = !waiting && !!s && (s.phase === 'failed' || s.phase === 'cancelled') && a.signedIn !== 'yes';
    let { actions, sentence } = row;
    if (waiting) actions = actions.filter((x) => x !== 'signin');
    else {
      const more = [...(d.console ? ['signin-console'] : []), ...(unfinished ? ['signin-terminal'] : [])];
      actions = actions.flatMap((x) => (x === 'signin' ? ['signin', ...more] : [x]));
      if (unfinished && s.phase === 'failed' && actions.includes('signin') && !this._signInTerminal.has(d.id)) sentence = signInFallback(this.platform);
    }
    return { ...row, sentence, actions, signingIn: waiting ? { since: s.since, browser: true, sentence: waitingSentence(d, s.mode) } : null };
  }

  // ---------------------------------------------------------------- git and GitHub

  /** Save the person's name and email in git's global config. Refused (409) while git is not installed. */
  async setGitIdentity({ name, email } = {}) {
    const tools = await this._gitTools();
    if (!tools.installed) throw refusal('git-missing', tools.sentence, 409);
    const saved = await this.workspace.setGitIdentity({ name, email });
    this.emit('changed');
    return { ok: true, sentence: `Git will make your merges as ${saved.name}, ${saved.email}.` };
  }

  /**
   * Git as the panel shows it: `{ name, email, installed, canInstall, sentence }`. While git cannot run (gitPresence),
   * its sentence says so ("Git is not installed yet. Apple’s developer tools include it.", or outside macOS "… Install
   * git with your package manager."), `canInstall` is true on a Mac (Install: installGitTools), and git is not asked
   * for a name and email: on a Mac that would open Apple's installer each time the panel looks.
   */
  async _gitStatus(repoRoot) {
    const tools = await this._gitTools();
    if (!tools.installed) return { name: '', email: '', installed: false, canInstall: tools.canInstall, sentence: tools.sentence };
    return { ...(await this._gitIdentityStatus(repoRoot)), installed: true, canInstall: false };
  }

  /** Whether git can run here (gitPresence), with this Connect's platform, environment and programs. */
  async _gitTools({ fresh = false } = {}) {
    const known = this._gitKnown;
    if (!fresh && known && known.installed && Date.now() - known.at < GIT_KNOWN_MS) return known.found;
    const found = await gitPresence({
      platform: this.platform, env: this.env, run: this._runProgram, cwd: this._probeFolder(), log: this._log,
      runGit: typeof this.workspace?.git === 'function' ? this.workspace.git : null,
    });
    this._gitKnown = { installed: found.installed, at: Date.now(), found };
    return found;
  }

  /**
   * Install git: on a Mac, Apple's developer tools, which include it. `xcode-select --install` (an argument array)
   * opens Apple's own installer, which the person answers; the panel checks again when it gets focus. Answers `{ ok,
   * sentence }`: "Git is installed already." when it is (nothing runs); elsewhere `{ ok: false, why: 'platform',
   * sentence: 'Git is not installed yet. Install git with your package manager.' }`; and when Apple's installer could
   * not be opened, `{ ok: false, why: 'install', sentence }` (xcode-select's own words go to the log).
   */
  async installGitTools() {
    const before = await this._gitTools({ fresh: true });
    if (before.installed) return { ok: true, sentence: 'Git is installed already.' };
    if (this.platform !== 'darwin') return { ok: false, why: 'platform', sentence: GIT_MISSING_ELSEWHERE };
    const r = await this._runProgram(XCODE_SELECT, ['--install'], { env: this.env, cwd: this._probeFolder(), timeoutMs: GIT_INSTALL_MS });
    if (r && !r.error && !r.timedOut && r.code === 0) {
      this._log('info', 'Apple’s installer for its developer tools (and git) was opened.');
      this.emit('changed');
      return { ok: true, sentence: 'Apple’s installer is open. Follow its steps; when it has finished, git is ready.' };
    }
    const said = oneLine(`${(r && r.stderr) || ''} ${(r && r.stdout) || ''}`, 300);
    this._log('warn', `Apple’s installer could not be opened (${r && r.timedOut ? 'it took too long' : r && r.error ? r.error.code || 'it failed' : `exit ${r && r.code}`})${said ? `: ${said}` : ''}`);
    const after = await this._gitTools({ fresh: true });
    if (after.installed) return { ok: true, sentence: 'Git is installed already.' };
    return { ok: false, why: 'install', sentence: 'Workbench could not open Apple’s installer. Run xcode-select --install in Terminal, then check again.' };
  }

  async _gitIdentityStatus(repoRoot) {
    let who;
    try {
      who = await this.workspace.gitConfigIdentity();
    } catch (e) {
      this._log('warn', `git's settings could not be read${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
      return { name: '', email: '', sentence: 'Workbench could not read git’s settings.' };
    }
    const name = typeof who?.name === 'string' ? who.name : '';
    const email = typeof who?.email === 'string' ? who.email : '';
    // What a merge in this repository uses: its own config's name and email when it has them, else the global ones.
    let here = null;
    if (repoRoot && typeof this.workspace.gitIdentity === 'function') {
      try { here = await this.workspace.gitIdentity({ repoRoot }); } catch { here = null; }
    }
    const own = here && typeof here.name === 'string' && typeof here.email === 'string' && (here.name !== name || here.email !== email);
    let sentence;
    if (name && email && own) {
      sentence = `In this repository git knows you as ${oneLine(here.name, 100)}, ${oneLine(here.email, 254)}, and merges here use that. Everywhere else: ${oneLine(name, 100)}, ${oneLine(email, 254)}.`;
    } else if (name && email) sentence = `Git knows you as ${oneLine(name, 100)}, ${oneLine(email, 254)}.`;
    else {
      if (here) sentence = 'This repository has its own name and email for git. Save yours here to use them everywhere.';
      else if (name) sentence = 'Git knows your name but not your email yet.';
      else if (email) sentence = 'Git knows your email but not your name yet.';
      else sentence = 'Git does not know your name and email yet.';
    }
    return { name, email, sentence };
  }

  /** The GitHub connection: the key connectGithub saved (its id is in settings.json), and the login GitHub gave. */
  _github(keys) {
    const gh = this._settings && typeof this._settings.github === 'object' && this._settings.github ? this._settings.github : null;
    const key = gh && keys.find((k) => k.id === gh.keyId);
    if (!key) return { connected: false, login: null, agentsUseIt: false, sentence: 'Not connected.', keyId: null };
    const login = typeof gh.login === 'string' && GITHUB_LOGIN.test(gh.login) ? gh.login : null;
    return { connected: true, login, agentsUseIt: key.agents === 'all', sentence: login ? `Connected to GitHub as ${login}.` : 'Connected to GitHub.', keyId: key.id };
  }

  /**
   * Connect GitHub with a token: GitHub says whose it is (GET /user), then it is kept in the key store (GH_TOKEN and
   * GITHUB_TOKEN; for every agent when `agentsUseIt`, else for none: git only; left out, as the connection has it now,
   * and git only for a first connection) and given to git's credential helper for github.com, so git can clone private
   * repositories. A token GitHub does not accept is not kept, nor one settings.json cannot record as the connection's.
   * An earlier connection's key or git sign-in that cannot be removed is said in the sentence.
   * @returns {Promise<{ ok: boolean, login?: string, why?: string, sentence: string }>}
   */
  async connectGithub(token, { agentsUseIt } = {}) {
    const t = typeof token === 'string' ? token.trim() : '';
    if (!t || t.length > 255 || /[\s\u0000-\u001f\u007f]/.test(t)) throw refusal('value', 'That does not look like a GitHub token.', 400);
    let res;
    try {
      res = await this.fetchJson(`${GITHUB_API}/user`, { headers: githubHeaders(t) });
    } catch (e) {
      this._log('warn', `GitHub could not be reached (${(e && (e.code || e.name)) || 'error'}).`);
      return { ok: false, why: 'network', sentence: 'Workbench could not reach GitHub. Check the internet connection, then try again.' };
    }
    const status = res && res.status;
    if (status === 401) return { ok: false, why: 'token', sentence: 'GitHub did not accept that token. Check that you copied all of it, then try again.' };
    if (status === 403 || status === 429) return { ok: false, why: 'github', sentence: 'GitHub refused the request for now. Try again in a few minutes.' };
    const login = res && res.json && res.json.login;
    if (status !== 200 || typeof login !== 'string' || !GITHUB_LOGIN.test(login)) {
      this._log('warn', `GitHub answered ${Number(status) || 'something'} when asked whose the token is.`);
      return { ok: false, why: 'github', sentence: 'GitHub gave an answer Workbench did not expect, so the token was not kept.' };
    }
    this._settings = this._readSettings();
    const keys = await this._listKeys();
    const previous = this._github(keys);
    const share = agentsUseIt === undefined ? previous.agentsUseIt === true : agentsUseIt === true;
    const { id } = await this._storeAdd({
      preset: 'github', label: 'GitHub', values: { GH_TOKEN: t, GITHUB_TOKEN: t }, secretNames: ['GH_TOKEN', 'GITHUB_TOKEN'],
      scope: { kind: 'all' }, agents: share ? 'all' : [],
    });
    try {
      this._updateSettings((s) => ({ ...s, github: { login, keyId: id } }));
    } catch (e) {
      // Nothing would say this key is the connection's: it goes again, rather than reach agents as a key of its own.
      try {
        await this.keys.remove(id);
      } catch (gone) {
        this._log('warn', `the GitHub token just kept could not be removed again: ${gone && gone.message}`);
      }
      throw e;
    }
    const after = [];
    if (previous.keyId && previous.keyId !== id) {
      try {
        await this.keys.remove(previous.keyId);
      } catch (e) {
        this._log('warn', `the GitHub token kept before could not be removed: ${e && e.message}`);
        after.push(`Workbench could not remove the token it kept before${previous.agentsUseIt ? ', so agents still get it' : ''}: it is listed under Keys for your agents, where you can remove it.`);
      }
    }
    if (previous.login && previous.login !== login && !(await this._forgetGitSignIn(previous.login))) {
      after.push(`Git could not forget your sign-in as ${previous.login}, so it may still use that account’s token.`);
    }
    let kept = null;
    try {
      kept = await this.workspace.approveGitCredential({ host: 'github.com', username: login, password: t });
    } catch (e) {
      this._log('warn', `git could not keep the GitHub sign-in${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
    }
    this.emit('changed');
    let sentence = `Connected to GitHub as ${login}.`;
    if (!kept) sentence += ' Git could not keep the token, so cloning private repositories may not work.';
    else if (kept.helper === false) sentence += ' Git on this computer has nowhere to keep sign-ins, so it cannot use the token to clone private repositories.';
    for (const more of after) sentence += ` ${more}`;
    return { ok: true, login, sentence };
  }

  /**
   * Disconnect GitHub: git forgets the sign-in, then the key goes, then settings.json forgets the connection. The token
   * itself still works until it is deleted on GitHub. Git goes first, so whatever fails, the key is still there and the
   * panel shows GitHub connected, with Disconnect to try again: the answer is then `{ ok: false, why: 'git'|'store',
   * sentence }`, saying what is still kept.
   * @returns {Promise<{ ok: boolean, why?: string, sentence: string }>}
   */
  async disconnectGithub() {
    this._settings = this._readSettings();
    const github = this._github(await this._listKeys());
    const gh = this._settings.github && typeof this._settings.github === 'object' ? this._settings.github : null;
    const login = github.login || (gh && typeof gh.login === 'string' && GITHUB_LOGIN.test(gh.login) ? gh.login : null);
    const kept = github.agentsUseIt
      ? 'GitHub is still connected, and agents still get your GitHub token until it is removed.'
      : 'GitHub is still connected, and Workbench still keeps your GitHub token.';
    if (login && !(await this._forgetGitSignIn(login))) {
      return { ok: false, why: 'git', sentence: `Git could not forget your GitHub sign-in. ${kept} Try again.` };
    }
    if (gh && gh.keyId) {
      try {
        await this.keys.remove(gh.keyId);
      } catch (e) {
        this._log('warn', `the GitHub token could not be removed: ${e && e.message}`);
        const why = e && e.plain === true && typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'Workbench could not remove your GitHub token.';
        return { ok: false, why: 'store', sentence: `${why} ${kept} Try again.` };
      }
    }
    this._updateSettings((s) => {
      const { github: _gone, ...rest } = s;
      return rest;
    });
    this.emit('changed');
    return { ok: true, sentence: 'GitHub is disconnected. The token itself still works until you delete it on GitHub.' };
  }

  /**
   * The person's repositories on GitHub, most recently pushed first, at most 100. Through gh when gh is signed in
   * (ghReposOrNull: organisations' repositories too); otherwise, or when gh lists none or fails, with the token
   * connection (_githubReposWithToken). Neither: [].
   * @returns {Promise<{ fullName: string, cloneUrl: string, private: boolean, pushedAt: string|null }[]>}
   */
  async githubRepos() {
    const pick = await this._ghPick();
    const ghPath = pick.path || (pick.old && pick.old.path) || null;
    if (ghPath) {
      const cwd = this._probeFolder();
      const st = await this.gh.ghStatus({ ghPath, env: this.env, version: pick.path ? pick.version : pick.old.version, cwd });
      if (st.signedIn === true) {
        const list = await this.gh.ghReposOrNull({ ghPath, env: this.env, cwd, log: (m) => this._log('warn', m) });
        if (Array.isArray(list) && list.length) return list;
      }
    }
    return this._githubReposWithToken();
  }

  /**
   * The person's repositories on GitHub, most recently pushed first (GET /user/repos?per_page=100&sort=pushed), asked
   * for with the token the key store keeps for the GitHub connection (also a token for git only, which no agent gets).
   * No connection, no token or any failure: [].
   * @returns {Promise<{ fullName: string, cloneUrl: string, private: boolean, pushedAt: string|null }[]>}
   */
  async _githubReposWithToken() {
    this._settings = this._readSettings();
    const github = this._github(await this._listKeys());
    if (!github.connected) return [];
    const token = this._storedGithubToken(github);
    if (!token) {
      this._log('info', 'there is no GitHub token to list repositories with.');
      return [];
    }
    let res;
    try {
      res = await this.fetchJson(`${GITHUB_API}/user/repos?per_page=100&sort=pushed`, { headers: githubHeaders(token) });
    } catch (e) {
      this._log('warn', `GitHub could not be reached (${(e && (e.code || e.name)) || 'error'}).`);
      return [];
    }
    if (!res || res.status !== 200 || !Array.isArray(res.json)) {
      this._log('warn', `GitHub answered ${Number(res && res.status) || 'something'} when asked for the repositories.`);
      return [];
    }
    return res.json.map(repoOf).filter(Boolean).slice(0, 100);
  }

  /**
   * "Let agents use this token": give the GitHub connection's token to every agent, or to none (git only), without
   * asking for it again. It is read back from the key store (as githubRepos does), and kept again with the other choice
   * in place of the earlier key.
   * @returns {Promise<{ ok: boolean, why?: string, sentence: string }>}
   */
  async setGithubAgentsUseIt(on) {
    const want = on === true;
    this._settings = this._readSettings();
    const github = this._github(await this._listKeys());
    if (!github.connected) throw refusal('github', 'GitHub is not connected.', 409);
    const sentence = want ? 'Agents can use your GitHub token now, as GH_TOKEN.' : 'Agents no longer get your GitHub token. Git still uses it.';
    if (github.agentsUseIt === want) return { ok: true, sentence };
    const token = this._storedGithubToken(github);
    if (!token) {
      return { ok: false, why: 'token', sentence: 'Workbench could not read the GitHub token it keeps, so this cannot change. Disconnect GitHub, then connect it again.' };
    }
    const { id } = await this._storeAdd({
      preset: 'github', label: 'GitHub', values: { GH_TOKEN: token, GITHUB_TOKEN: token }, secretNames: ['GH_TOKEN', 'GITHUB_TOKEN'],
      scope: { kind: 'all' }, agents: want ? 'all' : [],
    });
    this._updateSettings((s) => ({ ...s, github: { ...(s.github || {}), login: github.login, keyId: id } }));
    await this._removeQuietly(github.keyId);
    this.emit('changed');
    return { ok: true, sentence };
  }

  /**
   * The GitHub connection's token, as the key store holds it in memory (`keys.valuesOf`): GH_TOKEN, else GITHUB_TOKEN.
   * Null when the store could not read it (a locked keychain, a missing file) or has no such key.
   */
  _storedGithubToken(github) {
    if (!github.keyId || typeof this.keys.valuesOf !== 'function') return null;
    let values = null;
    try {
      values = this.keys.valuesOf(github.keyId);
    } catch (e) {
      this._log('warn', `the GitHub token could not be read back: ${e && e.message}`);
      return null;
    }
    const token = values && typeof values === 'object' ? values.GH_TOKEN || values.GITHUB_TOKEN : null;
    return typeof token === 'string' && token ? token : null;
  }

  /** Git forgets the sign-in for this login: true when it did, false (and a line in the log) when it could not. */
  async _forgetGitSignIn(login) {
    try {
      await this.workspace.rejectGitCredential({ host: 'github.com', username: login });
      return true;
    } catch (e) {
      this._log('warn', `git could not forget the GitHub sign-in${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
      return false;
    }
  }

  // ---------------------------------------------------------------- GitHub through gh

  /**
   * ConnectStatus's `github`, on its own (the Mac app's --github-status, which it may ask every few seconds): no agent
   * is probed, nothing reaches the network, and the key store is asked (which reads the keys' values, from the keychain
   * on a Mac) only when settings.json names a token connection. See _githubStatus.
   */
  async githubStatus() {
    return this._githubStatus(await this._githubToken());
  }

  /** The token connection (_github), with settings.json read afresh; the key store is asked only when it names one. */
  async _githubToken() {
    this._settings = this._readSettings();
    const gh = this._settings && typeof this._settings.github === 'object' && this._settings.github ? this._settings.github : null;
    return this._github(gh && gh.keyId ? await this._listKeys() : []);
  }

  /**
   * GitHub as the panel shows it: through gh when gh is signed in to github.com (read from gh's own settings, no network
   * call), else through the token connection (`token`: what _github found), else neither. Never a token. After a
   * sign-out left to Terminal, the first read that finds gh signed out sets git back (_ghForgetGit).
   * @returns {Promise<{ connected: boolean, via: 'gh'|'token'|null, login: string|null, ghInstalled: boolean,
   *   ghVersion: string|null, ghPath: string|null, agentsUseIt: boolean, sentence: string, signingIn: object|null }>}
   */
  async _githubStatus(token) {
    const pick = await this._ghPick();
    const runPath = pick.path || (pick.old && pick.old.path) || null;
    const st = runPath
      ? await this.gh.ghStatus({ ghPath: runPath, env: this.env, version: pick.path ? pick.version : pick.old.version, cwd: this._probeFolder() })
      : { signedIn: false, login: null };
    const signedOut = this._ghTerminalSignOut;
    if (signedOut && st.signedIn === false) {
      this._ghTerminalSignOut = null;
      await this._ghForgetGit(signedOut.login, token);
    }
    const viaGh = st.signedIn === true && typeof st.login === 'string' && GITHUB_LOGIN.test(st.login);
    let gitUsesIt = false;
    if (viaGh) {
      this._ghNote = null;
      gitUsesIt = await this._gitUsesGh();
    }
    const via = viaGh ? 'gh' : token.connected ? 'token' : null;
    let sentence;
    if (viaGh) sentence = gitUsesIt ? ghSignedIn(st.login) : `Signed in to GitHub as ${st.login}, but git does not use this sign-in yet. Sign in to GitHub again to set that up.`;
    else if (token.connected) sentence = token.sentence;
    else if (this._ghNote) sentence = this._ghNote;
    else sentence = token.sentence;
    return {
      connected: via !== null,
      via,
      login: viaGh ? st.login : token.login,
      ghInstalled: !!pick.path,
      ghVersion: pick.path ? pick.version : null,
      ghPath: pick.path || null,
      agentsUseIt: viaGh ? gitUsesIt : token.agentsUseIt,
      sentence,
      signingIn: this.githubSignInState(),
    };
  }

  /** Whether git asks gh for github.com's sign-in (false, and a line in the log, when git's settings cannot be read). */
  async _gitUsesGh() {
    try {
      return (await this.gh.gitUsesGh()) === true;
    } catch (e) {
      this._log('warn', `git's settings could not be read${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
      return false;
    }
  }

  /**
   * The gh Workbench uses: `{ path, version }` of a gh that runs and is GH_MIN_VERSION or later; `old: { path, version }`
   * when the one found first is older (or does not run): Workbench then uses its own copy in ~/.local/bin by its full
   * path when that one will do, else none (`path: null`), and a sign-in installs it. With WORKBENCH_GH_BIN, only that
   * program counts (`given`; `missing` when it is not there), and nothing is installed in its place.
   */
  async _ghPick() {
    const env = this.env;
    const given = typeof env.WORKBENCH_GH_BIN === 'string' && env.WORKBENCH_GH_BIN !== '' ? path.resolve(env.WORKBENCH_GH_BIN) : null;
    const found = this.gh.ghFind(env, { home: this.home, ...(Array.isArray(this.ghOptions.dirs) ? { dirs: this.ghOptions.dirs } : {}) });
    if (!found) return { path: null, version: null, old: null, given, missing: !!given };
    const version = await this._ghVersionOf(found);
    if (version && versionAtLeast(version, GH_MIN_VERSION)) return { path: found, version, old: null, given };
    const old = { path: found, version };
    if (given) return { path: null, version: null, old, given };
    const own = this.gh.ghOwnPath(this.home);
    if (own !== found && isFile(own)) {
      const v = await this._ghVersionOf(own);
      if (v && versionAtLeast(v, GH_MIN_VERSION)) return { path: own, version: v, old, given: null };
    }
    return { path: null, version: null, old, given: null };
  }

  /** What a gh program says its version is, kept until the file changes (a failure is asked again next time). */
  async _ghVersionOf(p) {
    let stamp;
    try {
      const st = fs.statSync(p);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
    const known = this._ghVersions.get(p);
    if (known && known.stamp === stamp) return known.version;
    const version = await this.gh.ghVersion({ ghPath: p, env: this.env, cwd: this._probeFolder() });
    if (version) this._ghVersions.set(p, { stamp, version });
    return version;
  }

  /**
   * The sign-in under way, as ConnectStatus shows it: `{ phase: 'installing'|'code'|'terminal', code, url, since,
   * sentence }`, with `opened: false` and `command` when Terminal could not be opened. `code` and `url` are set only
   * once gh has printed the code (the code is not a secret: GitHub shows it too). Null when none is under way.
   */
  githubSignInState() {
    const f = this._ghFlow;
    if (!f || f.ended) return null;
    const waiting = f.phase === 'code' && !!f.code;
    const view = { phase: f.phase, code: waiting ? f.code : null, url: waiting ? f.url : null, since: f.since, sentence: f.sentence };
    if (f.phase === 'terminal' && f.opened === false) Object.assign(view, { opened: false, command: f.command });
    return view;
  }

  /**
   * Sign in to GitHub with gh, one sign-in at a time (a second call joins the one under way):
   * 1. gh is installed first when it is missing or older than Workbench needs (`installing`: ghInstall);
   * 2. when gh is signed in already, git is made to use it (setup-git), and that is all;
   * 3. gh's login runs with no terminal (`code`: the one-time code and github.com's device page, for the person to open);
   *    when it exits 0, setup-git runs, then gh's sign-in is read again;
   * 4. when no code comes within 15 seconds, gh asks a question, or it fails, Terminal opens on the two steps instead
   *    (`terminal`), and Workbench reads gh's sign-in every few seconds until it is there, for 15 minutes at most.
   * `onProgress` hears `{ phase: 'installing'|'code'|'terminal', … }` as each begins (a call that joins hears the phase
   * under way at once), then `{ phase: 'done', login, sentence }` or `{ phase: 'error', why, sentence }`.
   * Without `wait` the answer comes as soon as the first phase is known: `{ ok, sentence }` (the route's answer, with
   * status.github.signingIn). With `wait` it comes when the sign-in has ended: `{ ok: true, phase: 'done', login,
   * sentence }`, or `{ ok: false, phase: 'error', why, sentence }`, why being `cancelled`, `expired`, `terminal`, `gh`,
   * or an install refusal's (see ghInstall).
   */
  async githubSignIn({ onProgress, wait = false } = {}) {
    const flow = this._ghFlow || this._startGhFlow();
    const listener = typeof onProgress === 'function' ? onProgress : null;
    if (listener) {
      flow.listeners.add(listener);
      if (flow.phase !== 'code' || flow.code) callQuietly(listener, this._ghProgress(flow));
    }
    if (wait) {
      try {
        return await flow.promise;
      } finally {
        if (listener) flow.listeners.delete(listener);
      }
    }
    await flow.started;
    if (flow.outcome) {
      const o = flow.outcome;
      return o.ok ? { ok: true, sentence: o.sentence } : { ok: false, why: o.why, sentence: o.sentence };
    }
    return { ok: true, sentence: flow.sentence };
  }

  /** Stop the sign-in under way: the download, gh's login, or the wait for Terminal. */
  async cancelGithubSignIn() {
    const flow = this._ghFlow;
    if (!flow || flow.ended) return { ok: true, sentence: 'No sign-in to GitHub was under way.' };
    flow.cancelled = true;
    try { flow.abort.abort(); } catch { /* already */ }
    flow.stopLogin?.();
    flow.wake?.();
    await flow.promise;
    return { ok: true, sentence: 'Stopped signing in to GitHub.' };
  }

  /**
   * Sign out of GitHub: gh forgets its sign-in (`gh auth logout --hostname github.com --user <login>`, with no terminal;
   * Terminal on gh's sign-out when that fails, on macOS). Once gh is signed out, and only then, git is set back
   * (_ghForgetGit): its settings lose what setup-git wrote, and it forgets the sign-in it keeps for that account. When gh
   * signs out in Terminal, that comes at the first status read that finds gh signed out; when gh is still signed in
   * after its logout (another account of the person's, which gh then makes the active one), git goes on asking gh.
   * GitHub itself still lists the sign-in until the person revokes it there, and the sentence says so. A sign-in under
   * way is stopped first.
   * @returns {Promise<{ ok: boolean, why?: string, opened?: boolean, command?: string, sentence: string }>}
   */
  async githubSignOut() {
    if (this._ghFlow) await this.cancelGithubSignIn();
    this._ghNote = null;
    const earlier = this._ghTerminalSignOut;
    this._ghTerminalSignOut = null;
    const pick = await this._ghPick();
    const ghPath = pick.path || (pick.old && pick.old.path) || null;
    const version = pick.path ? pick.version : pick.old && pick.old.version;
    const cwd = this._probeFolder();
    const st = ghPath ? await this.gh.ghStatus({ ghPath, env: this.env, version, cwd }) : { signedIn: false, login: null };
    const revoke = 'GitHub still lists this sign-in under Settings → Applications until you revoke it there.';
    if (ghPath && st.signedIn !== false) {
      const out = await this.gh.ghLogout({ ghPath, env: this.env, login: st.login, cwd });
      if (!out.ok) {
        this._log('warn', `GitHub’s command-line tool could not sign out without Terminal: ${oneLine(out.detail, 500)}`);
        let res = null;
        if (this.platform === 'darwin') {
          try {
            res = await this.openTerminal({ title: 'Signing out of GitHub', ...this.gh.ghSignOutProgram(ghPath) });
          } catch (e) {
            this._log('warn', `Terminal could not be opened: ${e && e.message}`);
          }
        }
        if (!(res && res.opened)) {
          this.emit('changed');
          return { ok: false, why: 'gh', opened: false, command: this.gh.ghSignOutCommand(ghPath), sentence: 'Workbench could not sign out of GitHub. Run this command in a terminal, then check again.' };
        }
        // gh is still signed in until the person signs out there: git is set back once a status read finds it signed out.
        this._ghTerminalSignOut = { login: st.login || null };
        this.emit('changed');
        return { ok: true, opened: true, sentence: `Terminal is open to sign you out of GitHub. When it is done, come back here. ${revoke}` };
      }
      const now = await this.gh.ghStatus({ ghPath, env: this.env, version, cwd });
      if (now.signedIn === true) {
        this.emit('changed');
        const was = st.login ? `Signed out of GitHub as ${st.login}.` : 'Signed out of GitHub.';
        return { ok: true, sentence: `${was} GitHub’s command-line tool is still signed in as ${now.login}, and git goes on using that sign-in. ${revoke}` };
      }
    }
    const { forgot, after } = await this._ghForgetGit(st.login || (earlier && earlier.login) || null, await this._githubToken());
    this.emit('changed');
    if (!ghPath || st.signedIn === false) return { ok: true, sentence: `GitHub’s command-line tool was not signed in.${forgot}${after}` };
    return { ok: true, sentence: `Signed out of GitHub.${forgot} ${revoke}${after}` };
  }

  /**
   * gh is signed out: git's settings lose what setup-git wrote (forgetGhGitHelper), then git forgets the sign-in it
   * keeps for `login` (`git credential reject`), now asking the helpers it had before, such as Apple's osxkeychain. That
   * is the copy gh's own login in Terminal gave git, or one the person saved: the words say so. Git forgets nothing
   * while gh's lines for github.com stay, nor when the token connection (`token`) is for the same account, since git
   * keeps that token's sign-in. Failures go to the log.
   * @returns {Promise<{ forgot: string, after: string }>} words for the answer: what git forgot, then what did not work
   */
  async _ghForgetGit(login, token) {
    let kept;
    try {
      ({ kept } = await this.gh.forgetGhGitHelper());
    } catch (e) {
      this._log('warn', `git's settings could not be changed back${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
      return { forgot: '', after: ' Git still asks GitHub’s command-line tool for your GitHub sign-in, so git cannot reach github.com until you sign in again.' };
    }
    if (kept && kept.length) this._log('info', `git's settings for ${kept.join(' and ')} hold helpers of the person's own, so they stay.`);
    if (!login || (kept && kept.includes(GH_HELPER_KEYS[0])) || (token && token.connected && token.login === login)) return { forgot: '', after: '' };
    if (await this._forgetGitSignIn(login)) return { forgot: ` Git also forgot any GitHub sign-in it kept for ${login}, even one you saved yourself.`, after: '' };
    return { forgot: '', after: ` Git could not forget your GitHub sign-in as ${login}, so it may still use that account’s token.` };
  }

  /** A new sign-in: its state, its listeners, and its promise, which never rejects. */
  _startGhFlow() {
    const flow = {
      phase: 'code', code: null, url: null, opened: undefined, command: null, since: Date.now(), sentence: 'Getting ready to sign in to GitHub…',
      listeners: new Set(), abort: new AbortController(), cancelled: false, ended: false, outcome: null, stopLogin: null, wake: null,
    };
    let markStarted;
    flow.started = new Promise((resolve) => { markStarted = resolve; });
    flow.markStarted = () => markStarted();
    this._ghFlow = flow;
    this._ghNote = null;
    this._ghTerminalSignOut = null; // a sign-in now: a sign-out left to Terminal earlier no longer sets git back
    flow.promise = this._runGhFlow(flow)
      .catch((e) => {
        this._log('error', `signing in to GitHub failed: ${e && (e.stack || e.message)}`);
        return { ok: false, phase: 'error', why: 'error', sentence: 'Workbench could not sign in to GitHub. The details are in its log.' };
      })
      .then((outcome) => {
        flow.ended = true;
        flow.outcome = outcome;
        flow.stopLogin = null;
        flow.wake = null;
        if (this._ghFlow === flow) this._ghFlow = null;
        this._ghNote = outcome.ok || outcome.why === 'cancelled' ? null : outcome.sentence;
        const end = outcome.ok ? { phase: 'done', login: outcome.login, sentence: outcome.sentence } : { phase: 'error', why: outcome.why, sentence: outcome.sentence };
        for (const l of [...flow.listeners]) callQuietly(l, end);
        flow.listeners.clear();
        flow.markStarted();
        this.emit('changed');
        return outcome;
      });
    return flow;
  }

  /** A phase begins: the flow says so, its listeners hear it, and the panel may change. */
  _ghPhase(flow, phase, fields = {}) {
    if (flow.ended) return;
    Object.assign(flow, { phase, ...fields });
    const now = this._ghProgress(flow);
    for (const l of [...flow.listeners]) callQuietly(l, now);
    this.emit('changed');
  }

  /** What a listener hears of the phase under way. */
  _ghProgress(flow) {
    if (flow.phase === 'installing') return { phase: 'installing', sentence: flow.sentence };
    if (flow.phase === 'terminal') {
      return flow.opened === false
        ? { phase: 'terminal', opened: false, command: flow.command, sentence: flow.sentence }
        : { phase: 'terminal', opened: true, sentence: flow.sentence };
    }
    return { phase: 'code', code: flow.code || null, url: flow.code ? flow.url : null, sentence: flow.sentence };
  }

  async _runGhFlow(flow) {
    const o = this.ghOptions;
    const cwd = this._probeFolder();
    const fail = (why, sentence) => ({ ok: false, phase: 'error', why, sentence });
    const cancelled = () => fail('cancelled', 'Stopped signing in to GitHub.');
    const pick = await this._ghPick();
    if (flow.cancelled) return cancelled();
    if (pick.given && !pick.path) {
      const given = oneLine(pick.given, 300);
      return fail('gh', pick.missing
        ? `GitHub’s command-line tool is not at ${given}, the path in WORKBENCH_GH_BIN.`
        : `GitHub’s command-line tool at ${given}, the path in WORKBENCH_GH_BIN, ${pick.old && pick.old.version ? `is version ${pick.old.version}, older than Workbench needs (${GH_MIN_VERSION} or later)` : 'could not be started'}.`);
    }
    let ghPath = pick.path;
    flow.ghVersion = pick.version; // known: gh's later checks need not ask it again
    if (!ghPath) {
      // Missing, or older than Workbench needs: Workbench gets its own copy, in ~/.local/bin, and says why.
      const old = pick.old
        ? ` The one at ${oneLine(pick.old.path, 300)} ${pick.old.version ? `is version ${pick.old.version}, older than Workbench needs` : 'could not be started'}, so Workbench gets its own.`
        : '';
      this._ghPhase(flow, 'installing', { sentence: `Getting GitHub’s command-line tool…${old}` });
      flow.markStarted();
      try {
        const got = await this.gh.ghInstall({
          home: this.home, platform: this.platform, env: this.env, signal: flow.abort.signal,
          ...pickDefined(o, ['fetchImpl', 'verify', 'osRelease', 'arch', 'tmpDir']),
        });
        ghPath = got.path;
        flow.ghVersion = got.version;
        this._log('info', `GitHub’s command-line tool ${got.version} is now at ${got.path}.`);
      } catch (e) {
        if (flow.cancelled) return cancelled();
        this._log('warn', `GitHub’s command-line tool could not be installed: ${e && e.plain ? `${e.message}${e.detail ? ` (${oneLine(e.detail, 500)})` : ''}` : (e && (e.stack || e.message))}`);
        return fail(e && typeof e.why === 'string' ? e.why : 'install', e && e.plain === true ? e.message : 'Workbench could not get GitHub’s command-line tool. The details are in its log.');
      }
      if (flow.cancelled) return cancelled();
    }
    // Signed in already (in a terminal of the person's own, say): git is made to use it (also a gh just installed in
    // place of another), and that is all.
    const before = await this.gh.ghStatus({ ghPath, env: this.env, version: flow.ghVersion, cwd });
    if (flow.cancelled) return cancelled();
    if (before.signedIn === true) return this._ghFinish(flow, ghPath);
    // gh's own login, with no terminal: the code shows in Workbench, and the person approves it on github.com.
    this._ghPhase(flow, 'code', { code: null, url: null, sentence: 'Asking GitHub for a one-time code…' });
    flow.markStarted();
    const login = this.gh.startGhLogin({
      ghPath, env: this.env, cwd, ...pickDefined({ codeWaitMs: o.codeWaitMs, maxMs: o.loginMs }, ['codeWaitMs', 'maxMs']),
      onCode: ({ code }) => this._ghPhase(flow, 'code', {
        code, url: GH_DEVICE_URL, sentence: `Your code: ${code}. Open GitHub, enter the code there, and approve the sign-in.`,
      }),
    });
    flow.stopLogin = login.cancel;
    if (flow.cancelled) login.cancel();
    const r = await login.done;
    flow.stopLogin = null;
    if (flow.cancelled || r.outcome === 'cancelled') return cancelled();
    if (r.outcome === 'done') return this._ghFinish(flow, ghPath);
    if (r.outcome === 'expired') return fail('expired', 'The one-time code ran out before the sign-in was approved on GitHub. Sign in to GitHub again for a new code.');
    this._log('warn', `GitHub’s command-line tool could not sign in without Terminal (${r.outcome}${r.exitCode != null ? `, exit ${r.exitCode}` : ''}): ${oneLine(r.detail, 500)}`);
    return this._ghTerminal(flow, ghPath);
  }

  /**
   * The fallback: Terminal on gh's login and setup-git; then gh's sign-in is read every few seconds until it is there.
   * Then Workbench waits for the steps' setup-git to make git use gh, rather than run its own at the same moment (two at
   * once can leave git's settings doubled), and runs setup-git itself only when git does not use gh within 10 seconds
   * (`setupWaitMs`): Terminal was closed before it, say.
   */
  async _ghTerminal(flow, ghPath) {
    const o = this.ghOptions;
    let res = null;
    if (this.platform === 'darwin') {
      try {
        res = await this.openTerminalSteps({ title: 'Signing in to GitHub', steps: this.gh.ghSignInSteps(ghPath) });
      } catch (e) {
        this._log('warn', `Terminal could not be opened: ${e && e.message}`);
      }
    }
    if (flow.cancelled) return { ok: false, phase: 'error', why: 'cancelled', sentence: 'Stopped signing in to GitHub.' };
    if (res && res.opened) {
      this._ghPhase(flow, 'terminal', { opened: true, command: null, code: null, url: null, sentence: 'Terminal is open: follow the steps there, then come back.' });
    } else {
      this._ghPhase(flow, 'terminal', {
        opened: false, command: this.gh.ghSignInCommand(ghPath), code: null, url: null,
        sentence: this.platform === 'darwin' ? 'Workbench could not open Terminal. Run this command in a terminal, then come back here.' : 'Run this command in a terminal, then come back here.',
      });
    }
    const until = Date.now() + (Number.isFinite(o.terminalMs) ? o.terminalMs : LOGIN_MAX_MS);
    const every = Number.isFinite(o.pollMs) ? o.pollMs : 3000;
    while (!flow.cancelled && Date.now() < until) {
      await this._ghSleep(flow, Math.min(every, until - Date.now()));
      if (flow.cancelled) break;
      const st = await this.gh.ghStatus({ ghPath, env: this.env, version: flow.ghVersion, cwd: this._probeFolder() });
      if (st.signedIn === true) {
        const setUp = await this._ghGitSetUp(flow, Number.isFinite(o.setupWaitMs) ? o.setupWaitMs : GH_SETUP_WAIT_MS, every);
        if (flow.cancelled) break;
        return this._ghFinish(flow, ghPath, { setup: !setUp });
      }
    }
    if (flow.cancelled) return { ok: false, phase: 'error', why: 'cancelled', sentence: 'Stopped signing in to GitHub.' };
    return { ok: false, phase: 'error', why: 'terminal', sentence: 'The sign-in in Terminal did not finish. Sign in to GitHub again to try once more.' };
  }

  /** Wait up to `ms`, looking every `every`, for git to ask gh for github.com's sign-in: true once it does. */
  async _ghGitSetUp(flow, ms, every) {
    const end = Date.now() + ms;
    for (;;) {
      if (await this._gitUsesGh()) return true;
      if (flow.cancelled || Date.now() >= end) return false;
      await this._ghSleep(flow, Math.min(every, end - Date.now()));
    }
  }

  /** Wait `ms`, or until the sign-in is cancelled (cancelGithubSignIn wakes it). */
  async _ghSleep(flow, ms) {
    await new Promise((resolve) => {
      const timer = setTimeout(wake, Math.max(0, ms));
      function wake() {
        clearTimeout(timer);
        resolve();
      }
      flow.wake = wake;
    });
    flow.wake = null;
  }

  /**
   * gh is signed in: setup-git (every time, unless Terminal's has just run it: it is safe to repeat, and gh may have
   * moved), then the login, verified.
   */
  async _ghFinish(flow, ghPath, { setup = true } = {}) {
    const cwd = this._probeFolder();
    if (setup) {
      const r = await this.gh.ghSetupGit({ ghPath, env: this.env, cwd });
      if (!r.ok) this._log('warn', `git could not be set up to use GitHub’s command-line tool: ${oneLine(r.detail, 500)}`);
    }
    const st = await this.gh.ghStatus({ ghPath, env: this.env, version: flow.ghVersion, cwd, verify: true });
    if (st.signedIn !== true || !st.login) {
      return { ok: false, phase: 'error', why: 'gh', sentence: 'GitHub’s command-line tool finished, but Workbench could not find the sign-in. Sign in to GitHub again.' };
    }
    const uses = await this._gitUsesGh();
    return {
      ok: true, phase: 'done', login: st.login,
      sentence: uses ? ghSignedIn(st.login) : `Signed in to GitHub as ${st.login}, but Workbench could not make git use this sign-in. Sign in to GitHub again to try once more.`,
    };
  }

  // ---------------------------------------------------------------- keys

  /**
   * Add a key (Add a key in the panel): passed to the key store. `preset` is one of KEY_PRESETS (src/shared/
   * keypresets.mjs; none given: 'custom'); any other is refused, as the store refuses it. `scope` is 'all', 'repo'
   * (this repository: `repoRoot`, else the one status() was last asked about) or the store's own `{ kind, root }`.
   * Values left empty are dropped. When `secretNames` is not given it comes from the preset (fields marked not secret,
   * such as AWS_REGION, are shown); a field's `also` names get the same value, and names the preset does not list (a
   * custom key's, which has no fields) are secret. Then agents are probed again, since a key can change how an agent
   * signs in.
   * @returns {Promise<{ id: string }>}
   */
  async addKey({ preset, label, values, secretNames, scope, agents, repoRoot } = {}) {
    this._noteRepo(repoRoot);
    const presetId = preset == null ? 'custom' : preset;
    const p = typeof presetId === 'string' ? this.presets.find((x) => x && x.id === presetId) : null;
    if (!p) throw refusal('name', 'Workbench does not know that kind of key.', 400);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw refusal('value', 'There is nothing to save.', 400);
    const vals = {};
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== 'string') throw refusal('value', `The value for ${oneLine(k, 128)} is not text.`, 400);
      if (v.trim() !== '') vals[k] = v;
    }
    const secret = new Set(Array.isArray(secretNames) ? secretNames : []);
    const fields = Array.isArray(p.fields) ? p.fields : [];
    for (const f of fields) {
      if (!f || typeof f.name !== 'string') continue;
      if (!(f.name in vals)) {
        if (!f.optional) throw refusal('value', `${f.name} is needed.`, 400);
        continue;
      }
      if (!Array.isArray(secretNames) && f.secret !== false) secret.add(f.name);
      for (const also of Array.isArray(f.also) ? f.also : []) {
        if (typeof also !== 'string' || also in vals) continue;
        vals[also] = vals[f.name];
        if (secret.has(f.name)) secret.add(also);
      }
    }
    if (!Array.isArray(secretNames)) {
      // The key store is always told which names are secret, so a name the preset does not list is secret here.
      const listed = new Set(fields.flatMap((f) => [f && f.name, ...(f && Array.isArray(f.also) ? f.also : [])]));
      for (const name of Object.keys(vals)) if (!listed.has(name)) secret.add(name);
    }
    if (!Object.keys(vals).length) throw refusal('value', 'There is nothing to save.', 400);
    const result = await this._storeAdd({
      preset: p.id,
      label: typeof label === 'string' && label.trim() ? label.trim() : p.label || 'Key',
      values: vals,
      secretNames: Object.keys(vals).filter((n) => secret.has(n)),
      scope: this._scope(scope, repoRoot),
      agents: agents === undefined ? 'all' : agents,
    });
    await this.recheck();
    return result;
  }

  /**
   * Remove a key. The GitHub connection's key disconnects GitHub; when that fails, the answer is disconnectGithub's
   * refusal with `removed: false`.
   */
  async removeKey(id) {
    const gh = this._readSettings().github;
    if (gh && gh.keyId === id) {
      const r = await this.disconnectGithub();
      return r && r.ok === false ? { removed: false, ...r } : { removed: true };
    }
    let result;
    try {
      result = await this.keys.remove(id);
    } catch (e) {
      throw withStoreStatus(e);
    }
    await this.recheck();
    return result;
  }

  /** KeyStore.add, with the status of a refusal set by its `.why` (withStoreStatus). */
  async _storeAdd(spec) {
    try {
      return await this.keys.add(spec);
    } catch (e) {
      throw withStoreStatus(e);
    }
  }

  _scope(scope, repoRoot) {
    if (scope === undefined || scope === 'all' || (scope && scope.kind === 'all')) return { kind: 'all' };
    if (scope === 'repo') {
      const root = repoRoot || this._repoRoot;
      if (!root) throw refusal('scope', 'Workbench does not know which repository this is, so the key can only be for all repositories.', 400);
      return { kind: 'repo', root };
    }
    if (scope && scope.kind === 'repo' && typeof scope.root === 'string' && scope.root) return { kind: 'repo', root: scope.root };
    throw refusal('scope', 'A key is for this repository or for all repositories.', 400);
  }

  /** The keys an agent of this harness gets in this repository: the key store's envFor, from its cache (synchronous). */
  envFor({ repoRoot, harness } = {}) {
    try {
      const env = this.keys.envFor({ repoRoot: repoRoot ?? null, harness });
      return env && typeof env === 'object' ? env : {};
    } catch (e) {
      this._log('warn', `the keys could not be read: ${e && e.message}`);
      return {};
    }
  }

  /** `text` with every stored secret value hidden (maskSecrets). */
  mask(text) {
    let values = [];
    try {
      values = this.keys.values();
    } catch {
      values = [];
    }
    return maskSecrets(text, Array.isArray(values) ? values : []);
  }

  _keyEnv(repoRoot, harness) {
    return this.envFor({ repoRoot, harness });
  }

  async _listKeys() {
    try {
      const list = await this.keys.list();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      this._log('warn', `the keys could not be listed: ${e && e.message}`);
      return [];
    }
  }

  async _removeQuietly(id) {
    try {
      await this.keys.remove(id);
    } catch (e) {
      this._log('warn', `a key could not be removed: ${e && e.message}`);
    }
  }

  _noteRepo(repoRoot) {
    if (typeof repoRoot === 'string' && repoRoot.trim()) this._repoRoot = repoRoot;
  }

  // ---------------------------------------------------------------- settings.json

  _readSettings() {
    try {
      // read like the key store's own files: never blocks on a FIFO, refuses a link or another person's file
      const text = readPrivateFile(this.settingsPath);
      if (text == null) return {};
      const j = JSON.parse(text);
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  }

  /** Read, change and write settings.json: mode 0600, written to a temporary file first, then renamed. */
  _updateSettings(change) {
    const next = change({ ...this._readSettings() });
    const dir = path.dirname(this.settingsPath);
    const tmp = `${this.settingsPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.settingsPath);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* not there */ }
      this._log('error', `settings.json could not be written: ${e && e.message}`);
      throw refusal('store', 'Workbench could not save its settings.', 500);
    }
    this._settings = next;
    return next;
  }
}
