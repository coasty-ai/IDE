// The connect service: which coding agents are here and signed in, the keys Workbench gives them, the person's name
// and email for git, and GitHub. The page's Agents & keys panel shows `status()`, and its buttons call the methods
// below through the routes in src/server/http.mjs. See ARCHITECTURE.md, "Connecting agents, keys and git".
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
import { maskSecrets } from './keys.mjs';
import * as workspaceModule from './workspace.mjs';
import { openTerminal as openTerminalWindow } from './terminal.mjs';

/** How long one sign-in check may take. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long an adapter's own available() may take (the CLI gives it the same). */
const AVAILABLE_TIMEOUT_MS = 15_000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
/** Where an agent program was found, in words. */
const FROM_WORDS = { flag: 'the path given with --claude', path: 'your PATH', vscode: 'the VS Code extension' };

/**
 * The agents Workbench drives, in the order "the first ready agent" goes through. Each has its vendor's installer (a
 * fixed shell line, run in Terminal as `/bin/sh -c <line>`: the one shell line besides workbench.json's checks), the
 * arguments of its own sign-in, the key preset "Use an API key" saves, and how to probe it. Agents spoken to over ACP
 * join this list later.
 */
const AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    installer: 'curl -fsSL https://claude.ai/install.sh | bash',
    signin: ['auth', 'login'],
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
   *   Pass false where no agent will be started (the CLI's --connect-github and --github-repos).
   *   Also accepted, mainly for tests: presets (the KEY_PRESETS list), probeTimeoutMs (10 000).
   */
  constructor({
    home = os.homedir(), platform = process.platform, env = process.env, keys, workspace = workspaceModule, adapters = {},
    flags = {}, settingsPath, openTerminal = openTerminalWindow, fetchJson = fetchJsonWithNode, log = null, repoRoot = null,
    probe = true, presets = KEY_PRESETS, probeTimeoutMs = PROBE_TIMEOUT_MS,
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
    this._log = makeLog(log);
    this._agents = null; // id -> what the last probe found
    this._repoRoot = null;
    this._noteRepo(repoRoot); // before the first probe, so it counts the keys kept for this repository
    this._current = null; // the probe under way
    this._next = null; // one more probe, queued behind it
    this._settings = this._readSettings();
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
      return {
        id: d.id, name: d.name, found: a.found, version: a.version, from: a.runs || a.found ? FROM_WORDS[a.from] || a.fromWords || null : null,
        signedIn: a.signedIn, how: a.how, ready: a.ready, isDefault, sentence: a.sentence, actions: actionsFor(a, isDefault),
      };
    });
    const github = this._github(keys);
    const root = repoRoot || this._repoRoot;
    return {
      agents,
      defaultAgent: def,
      platform: this.platform,
      canOpenTerminal: this.platform === 'darwin',
      git: await this._gitStatus(root),
      github: { connected: github.connected, login: github.login, agentsUseIt: github.agentsUseIt, sentence: github.sentence },
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
      this._agents = Object.fromEntries(found.map((a) => [a.id, a]));
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
      ? await within(mod.available({ env: this.env, claudePath: this.flags.claude || undefined }), AVAILABLE_TIMEOUT_MS,
        { ok: false, reason: 'Claude Code did not answer in time.' })
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
    const env = { ...withNodeOnPath(scrubEnv(this.env)), ...this._keyEnv(repoRoot, 'claude') };
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
      ? await within(mod.available({ env: this.env, timeoutMs: 5000 }), AVAILABLE_TIMEOUT_MS, { ok: false, reason: 'Codex did not answer in time.' })
      : { ok: false, reason: 'Codex support could not be loaded.' };
    const safe = info && typeof info === 'object' ? info : { ok: !!info };
    const env = { ...codexEnv(this.env), ...this._keyEnv(repoRoot, 'codex') };
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
   * @param {string} id
   * @param {'install'|'signin'} action
   */
  async agentAction(id, action) {
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
      [program, args] = commandFor(a.path, d.signin);
      title = `Signing in to ${d.name}`;
      // Terminal's shell has the person's own PATH, so it is given the program's full path; the command shown uses the
      // bare name when that is how Workbench found it too.
      command = commandLine(a.from === 'path' ? [path.basename(a.path), ...d.signin] : [program, ...args]);
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

  // ---------------------------------------------------------------- git and GitHub

  /** Save the person's name and email in git's global config. */
  async setGitIdentity({ name, email } = {}) {
    const saved = await this.workspace.setGitIdentity({ name, email });
    this.emit('changed');
    return { ok: true, sentence: `Git will make your merges as ${saved.name}, ${saved.email}.` };
  }

  async _gitStatus(repoRoot) {
    let who;
    try {
      who = await this.workspace.gitConfigIdentity();
    } catch (e) {
      this._log('warn', `git's settings could not be read${e && e.detail ? `: ${oneLine(e.detail, 300)}` : ''}`);
      return { name: '', email: '', sentence: 'Workbench could not read git’s settings.' };
    }
    const name = typeof who?.name === 'string' ? who.name : '';
    const email = typeof who?.email === 'string' ? who.email : '';
    let sentence;
    if (name && email) sentence = `Git knows you as ${oneLine(name, 100)}, ${oneLine(email, 254)}.`;
    else {
      let here = null;
      if (repoRoot && typeof this.workspace.gitIdentity === 'function') {
        try { here = await this.workspace.gitIdentity({ repoRoot }); } catch { here = null; }
      }
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
   * The person's repositories on GitHub, most recently pushed first (GET /user/repos?per_page=100&sort=pushed), asked
   * for with the token the key store keeps for the GitHub connection (also a token for git only, which no agent gets).
   * No connection, no token or any failure: [].
   * @returns {Promise<{ fullName: string, cloneUrl: string, private: boolean, pushedAt: string|null }[]>}
   */
  async githubRepos() {
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
      const j = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
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
