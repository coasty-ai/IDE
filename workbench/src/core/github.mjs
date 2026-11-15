// GitHub through GitHub's own command-line tool, `gh`. Workbench finds it, or downloads GitHub's official build into
// ~/.local/bin/gh, checked against the release's published SHA-256 checksums and, on macOS, GitHub's signature. It
// signs the person in with gh's own device-code login (the code shown in Workbench, with Terminal as the fallback),
// makes git use gh for github.com (`gh auth setup-git`), reads who is signed in, lists the person's repositories and
// signs out. gh keeps the token, in the login keychain or its own file: Workbench never reads, keeps or shows it.
// See ARCHITECTURE.md, "GitHub through gh".
//
// Every child process gets an argument array. Network calls happen only when the person acts: the download, and gh's
// own login, logout and repository list. Every git call goes through git() in workspace.mjs.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../adapters/claude/args.mjs';
import { git, privateTemp } from './workspace.mjs';

/** Where gh's releases are: the latest is read from a redirect, never from the API (60 requests an hour per address). */
export const GH_RELEASES = 'https://github.com/cli/cli/releases';
/** GitHub's Apple team: the leaf certificate of a macOS gh must name it. */
export const GH_TEAM_ID = 'VEKTX9H2N7';
/** The oldest gh Workbench runs: `gh auth status --json` came in 2.81.0. */
export const GH_MIN_VERSION = '2.81.0';
/** Where the person enters the one-time code (github.com's device page; Workbench never takes an address from gh). */
export const GH_DEVICE_URL = 'https://github.com/login/device';
/**
 * gh's login. `--scopes workflow` gives the token the scope gh adds itself when a person answers its git question in a
 * terminal, so pushes that change .github/workflows work after a login without one too.
 */
export const GH_LOGIN_ARGS = Object.freeze(['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow']);
/** Makes git ask gh for github.com's sign-in: the only step that always does (a login leaves Apple's osxkeychain). */
export const GH_SETUP_GIT_ARGS = Object.freeze(['auth', 'setup-git', '--hostname', 'github.com']);
export const GH_LOGOUT_ARGS = Object.freeze(['auth', 'logout', '--hostname', 'github.com']);
/** The person's repositories, organisations' and collaborations' too (`gh repo list` lists only their own). */
export const GH_REPOS_PATH = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
/** The folders gh is looked for in after the PATH and ~/.local/bin (Homebrew's, on Apple silicon and Intel). */
export const GH_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin']);
/** How long gh's login may take to print the one-time code before Workbench opens Terminal instead. */
export const CODE_WAIT_MS = 15_000;
/** How long a one-time code lasts on GitHub; also how long Workbench waits for a sign-in in Terminal. */
export const LOGIN_MAX_MS = 15 * 60_000;
/**
 * How long Workbench waits for a code to be approved: half a minute less than it lasts, so Workbench's own limit comes
 * before gh gives up by itself (which would read as a failure, and open Terminal).
 */
export const CODE_MAX_MS = LOGIN_MAX_MS - 30_000;
/** A failure of gh's login this close to the end of the wait (at most: half the wait) is the code running out. */
const EXPIRY_MARGIN_MS = 60_000;
/** The git settings `gh auth setup-git` writes, for github.com and gist.github.com. */
export const GH_HELPER_KEYS = Object.freeze(['credential.https://github.com.helper', 'credential.https://gist.github.com.helper']);

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// gh prints the code two ways: in a terminal "! First copy your one-time code: ABCD-1234", and with no terminal (as
// Workbench runs it) "! One-time code (ABCD-1234) copied to clipboard", as gh 2.104.0 did on the owner's Mac.
const CODE_RE = /one-time code(?::\s*|\s*\(\s*)([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Za-z0-9-])/i;
const TAG_RE = /^https:\/\/github\.com\/cli\/cli\/releases\/tag\/v(\d{1,4}\.\d{1,4}\.\d{1,6})$/;
/** How each of gh's commands is timed. */
const QUICK_MS = 10_000;
const SETUP_MS = 30_000;
const LIST_MS = 30_000;
const EXTRACT_MS = 120_000;
const FIND_MS = 30_000;
const DOWNLOAD_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKSUMS_BYTES = 64 * 1024;
const MAX_LIST_BYTES = 32 * 1024 * 1024;
/** Variables that would make gh use another sign-in, another host, a terminal, or print its HTTP traffic. */
const GH_UNSET = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_DEBUG', 'DEBUG', 'GH_FORCE_TTY'];
/** gh's name for each system and processor, in its release's file names. */
const OS_NAMES = Object.freeze({ darwin: 'macOS', linux: 'linux' });
const ARCH_NAMES = Object.freeze({ arm64: 'arm64', x64: 'amd64' });

/** A refusal: a plain sentence for the person, `.why`, and gh's or git's own words only in `.detail` (the log). */
function refusal(why, sentence, detail) {
  const e = Object.assign(new Error(sentence), { plain: true, why, sentence });
  if (detail) e.detail = oneLine(detail, 2000);
  return e;
}

/** One line of text from somewhere else: control, line-separator and direction-changing characters become spaces. */
function oneLine(text, max = 300) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Node scripts (the tests' stand-in) run with this node, as connect.mjs runs the agents' stand-ins. */
function commandFor(program, args) {
  return /\.(mjs|cjs|js)$/i.test(program) ? [process.execPath, [program, ...args]] : [program, args];
}

function isProgram(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (/\.(mjs|cjs|js)$/i.test(p)) return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where Workbench keeps its own gh, and updates it in place: git's helper names this path, so it never moves. */
export function ghOwnPath(home = os.homedir()) {
  return path.join(home, '.local', 'bin', 'gh');
}

/**
 * The environment gh runs with: the person's, without GH_TOKEN and GITHUB_TOKEN (either makes `gh auth login` and
 * `logout` refuse, and would stand in for gh's own sign-in), GH_HOST, GH_FORCE_TTY and the debug switches; with gh's
 * prompts, update check and telemetry off and no colours, since nobody answers or reads it.
 */
export function ghEnv(env = process.env) {
  const out = { ...(env || {}) };
  for (const k of GH_UNSET) delete out[k];
  return { ...out, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false', NO_COLOR: '1' };
}

/**
 * The gh program: WORKBENCH_GH_BIN when it is set (and nothing else, even when it is not there), else the first `gh`
 * on the PATH, then in ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. Null when there is none.
 * @param {object} [env]
 * @param {{ home?: string, dirs?: string[] }} [o] dirs: the folders after ~/.local/bin (tests give their own)
 * @returns {string|null}
 */
export function ghFind(env = process.env, { home = os.homedir(), dirs = GH_DIRS } = {}) {
  const given = typeof env?.WORKBENCH_GH_BIN === 'string' && env.WORKBENCH_GH_BIN !== '' ? path.resolve(env.WORKBENCH_GH_BIN) : null;
  if (given) return isProgram(given) ? given : null;
  const seen = new Set();
  const fromPath = String(env?.PATH || '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  for (const dir of [...fromPath, path.dirname(ghOwnPath(home)), ...(Array.isArray(dirs) ? dirs : [])]) {
    const p = path.join(dir, 'gh');
    if (seen.has(p)) continue;
    seen.add(p);
    if (isProgram(p)) return p;
  }
  return null;
}

/** "gh version 2.104.0 (2026-11-12)" → '2.104.0'. */
export function versionOf(text) {
  const m = /\bgh version (\d{1,4}\.\d{1,4}\.\d{1,6})\b/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Whether version `v` is `min` or later (both "major.minor.patch"). */
export function versionAtLeast(v, min) {
  const a = String(v || '').split('.').map(Number);
  const b = String(min || '').split('.').map(Number);
  if (a.length !== 3 || a.some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

// ------------------------------------------------------------------ running gh

/** Running gh logins: stopped when Workbench exits, so none keeps polling GitHub for a code nobody will enter. */
const running = new Set();
let watching = false;
function stopAtExit(child) {
  running.add(child);
  if (watching) return;
  watching = true;
  process.on('exit', () => {
    for (const c of running) {
      try { c.kill('SIGKILL'); } catch { /* gone */ }
    }
  });
}

/** SIGTERM, then SIGKILL when it is still there two seconds later. */
function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { /* gone */ }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }, 2000);
  t.unref?.();
}

/**
 * Run gh once with standard input closed, no terminal and a time limit. Never rejects:
 * `{ code, stdout, stderr, timedOut, error }`. stdout beyond `maxBytes` stops it (code null).
 * @param {string} ghPath
 * @param {string[]} args
 * @param {{ env?: object, timeoutMs?: number, maxBytes?: number, cwd?: string }} [o]
 */
export function runGh(ghPath, args, { env = process.env, timeoutMs = QUICK_MS, maxBytes = 1024 * 1024, cwd } = {}) {
  return new Promise((resolve) => {
    const [file, argv] = commandFor(ghPath, args);
    let child;
    try {
      child = spawn(file, argv, { env: ghEnv(env), cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let over = false;
    let done = false;
    const finish = (fields) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, error: null, ...fields, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stop(child);
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => {
      if (over) return;
      if (stdout.length + d.length > maxBytes) {
        over = true;
        stop(child);
        return;
      }
      stdout += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr = (stderr + d).slice(-16 * 1024); });
    child.on('error', (error) => finish({ error }));
    child.on('close', (code) => finish({ code: over ? null : code }));
  });
}

/** What a run of gh said, for the log only: its error, its time limit, or the end of what it printed. */
function said(r) {
  if (!r) return '';
  if (r.error) return `it could not be started (${r.error.code || r.error.message || 'error'})`;
  if (r.timedOut) return 'it took too long';
  return `it ended with ${r.code ?? 'no exit code'}: ${oneLine(r.stderr || r.stdout, 300)}`;
}

/** The version a gh program says it is, or null when it does not run or answer. */
export async function ghVersion({ ghPath, env = process.env, timeoutMs = QUICK_MS, cwd } = {}) {
  if (!ghPath) return null;
  const r = await runGh(ghPath, ['--version'], { env, timeoutMs, cwd });
  return r.code === 0 ? versionOf(r.stdout) : null;
}

/**
 * Whether gh is here and signed in to github.com, and as whom, with no network call: `gh config get user -h
 * github.com` reads gh's own settings (unverified: the token may have been revoked since). With `verify` (only after
 * the person acted, as after a login), an answer that is neither signed in nor signed out falls back to
 * `gh auth status --json hosts --hostname github.com`, which asks GitHub. Time limit 10 seconds each.
 * @param {{ ghPath: string|null, env?: object, version?: string|null, verify?: boolean, timeoutMs?: number, cwd?: string }} o
 *   version: what `gh --version` said, when the caller knows it already
 * @returns {Promise<{ installed: boolean, version: string|null, signedIn: boolean|null, login: string|null }>}
 *   signedIn null: Workbench could not tell
 */
export async function ghStatus({ ghPath, env = process.env, version = null, verify = false, timeoutMs = QUICK_MS, cwd } = {}) {
  const none = { installed: false, version: null, signedIn: false, login: null };
  if (!ghPath) return none;
  const [v, user] = await Promise.all([
    version && VERSION_RE.test(version) ? version : ghVersion({ ghPath, env, timeoutMs, cwd }),
    runGh(ghPath, ['config', 'get', 'user', '-h', 'github.com'], { env, timeoutMs, cwd }),
  ]);
  if (!v) return none;
  const login = String(user.stdout || '').trim();
  if (user.code === 0 && GITHUB_LOGIN.test(login)) return { installed: true, version: v, signedIn: true, login };
  // gh exits 1 when there is no user for github.com, and prints nothing for an empty one: no sign-in there.
  const out = { installed: true, version: v, signedIn: user.code === 1 || (user.code === 0 && login === '') ? false : null, login: null };
  if (!verify || !versionAtLeast(v, GH_MIN_VERSION) || out.signedIn === false) return out;
  const st = await runGh(ghPath, ['auth', 'status', '--json', 'hosts', '--hostname', 'github.com'], { env, timeoutMs, cwd });
  let j = null;
  try { j = st.code === 0 ? JSON.parse(st.stdout) : null; } catch { j = null; }
  if (!j || typeof j !== 'object' || !j.hosts || typeof j.hosts !== 'object') return out;
  const entries = Array.isArray(j.hosts['github.com']) ? j.hosts['github.com'] : [];
  const active = entries.find((e) => e && e.active === true) || entries[0];
  if (active && typeof active.login === 'string' && GITHUB_LOGIN.test(active.login)) return { installed: true, version: v, signedIn: true, login: active.login };
  return { ...out, signedIn: false };
}

/**
 * gh's login, with no terminal: standard input closed, the environment of ghEnv. gh then asks nothing, prints a one-time
 * code (`! First copy your one-time code: ABCD-1234`, on either output) and waits while the person enters it at
 * github.com/login/device and approves. Its outcome:
 * - `done`: it exited 0;
 * - `question`: it asked something (a line beginning "? "), so it was stopped;
 * - `no-code`: no code within `codeWaitMs` (15 s), so it was stopped;
 * - `failed`: it exited with another code, or could not be started;
 * - `expired`: the code was shown `maxMs` ago (14.5 minutes, half a minute less than a code lasts), so it was stopped;
 *   or gh exited with another code by itself in the last minute of that wait (its own end of the code came first);
 * - `cancelled`: `cancel()` stopped it.
 * Only a code shaped XXXX-XXXX reaches `onCode`, with github.com's own device page; nothing else gh prints is passed on.
 * gh runs in a process group of its own, so a Ctrl-C meant for Workbench does not end it first; Workbench stops it
 * (and it is stopped when Workbench exits).
 * @param {{ ghPath: string, env?: object, cwd?: string, codeWaitMs?: number, maxMs?: number,
 *   onCode?: (c: { code: string, url: string }) => void }} o
 * @returns {{ done: Promise<{ outcome: string, code: string|null, exitCode?: number|null, detail: string }>, cancel: () => void }}
 */
export function startGhLogin({ ghPath, env = process.env, cwd, codeWaitMs = CODE_WAIT_MS, maxMs = CODE_MAX_MS, onCode } = {}) {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let child = null;
  let code = null;
  let codeAt = 0;
  let settled = false;
  let text = '';
  let pending = '';
  let codeTimer = null;
  let maxTimer = null;
  const finish = (outcome, extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(codeTimer);
    clearTimeout(maxTimer);
    if (child) {
      running.delete(child);
      if (outcome !== 'done' && outcome !== 'failed') stop(child);
    }
    resolveDone({ outcome, code, ...extra, detail: oneLine(text.slice(-2000), 2000) });
  };
  const look = (line, whole) => {
    if (settled) return;
    // The code is read from whole lines only, so a code cut in two by the pipe is never taken for a shorter one.
    if (!code && whole) {
      const m = CODE_RE.exec(line);
      if (m) {
        code = m[1].toUpperCase();
        codeAt = Date.now();
        clearTimeout(codeTimer);
        maxTimer = setTimeout(() => finish('expired'), maxMs);
        maxTimer.unref?.();
        try { onCode?.({ code, url: GH_DEVICE_URL }); } catch { /* the caller's trouble, not gh's */ }
        return;
      }
    }
    // A question waits for an answer on a line of its own, often with no line break after it yet.
    if (/^\s*\?\s/.test(line) || (!whole && /\((?:Y\/n|y\/N)\)\s*$/.test(line))) finish('question');
  };
  const onData = (d) => {
    text = (text + d).slice(-16 * 1024);
    pending += d;
    const lines = pending.split(/\r?\n|\r/);
    pending = lines.pop();
    for (const line of lines) look(line, true);
    if (pending) look(pending, false);
    if (pending.length > 4096) pending = pending.slice(-4096);
  };
  try {
    const [file, argv] = commandFor(ghPath, GH_LOGIN_ARGS);
    child = spawn(file, argv, { env: ghEnv(env), cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
  } catch (error) {
    finish('failed', { exitCode: null, error: error.code || error.message });
    return { done, cancel() {} };
  }
  stopAtExit(child);
  child.stdout.setEncoding('utf8').on('data', onData);
  child.stderr.setEncoding('utf8').on('data', onData);
  child.on('error', (error) => finish('failed', { exitCode: null, error: error.code || error.message }));
  child.on('close', (exitCode) => {
    if (pending) look(pending, true);
    // gh gives up by itself once GitHub says the code ran out, which can come just before Workbench's own limit.
    const late = code !== null && Date.now() - codeAt >= maxMs - Math.min(EXPIRY_MARGIN_MS, maxMs / 2);
    finish(exitCode === 0 ? 'done' : late ? 'expired' : 'failed', { exitCode });
  });
  codeTimer = setTimeout(() => { if (!code) finish('no-code'); }, codeWaitMs);
  codeTimer.unref?.();
  return { done, cancel: () => finish('cancelled') };
}

/** `gh auth setup-git --hostname github.com`: git asks gh for github.com's (and gist.github.com's) sign-in. */
export async function ghSetupGit({ ghPath, env = process.env, cwd } = {}) {
  const r = await runGh(ghPath, GH_SETUP_GIT_ARGS, { env, timeoutMs: SETUP_MS, cwd });
  return r.code === 0 ? { ok: true } : { ok: false, detail: said(r) };
}

/**
 * `gh auth logout --hostname github.com --user <login>`, with no terminal: with the login named, gh asks nothing. gh
 * forgets the sign-in on this computer; GitHub still lists it until the person revokes it there.
 */
export async function ghLogout({ ghPath, env = process.env, login, cwd } = {}) {
  const args = [...GH_LOGOUT_ARGS, ...(typeof login === 'string' && GITHUB_LOGIN.test(login) ? ['--user', login] : [])];
  const r = await runGh(ghPath, args, { env, timeoutMs: SETUP_MS, cwd });
  return r.code === 0 ? { ok: true } : { ok: false, detail: said(r) };
}

/** A repository from GitHub's list, or null when it is not in the shape Workbench expects. */
function repoOf(r) {
  if (!r || typeof r !== 'object') return null;
  const fullName = typeof r.full_name === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(r.full_name) ? r.full_name : null;
  if (!fullName || r.clone_url !== `https://github.com/${fullName}.git`) return null;
  return { fullName, cloneUrl: r.clone_url, private: r.private === true, pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at.slice(0, 40) : null };
}

/**
 * The person's repositories on GitHub, most recently pushed first, at most 100: `gh api --hostname github.com
 * <GH_REPOS_PATH>`, asked with gh's own sign-in. Entries must have a `full_name` like owner/name and the `clone_url`
 * https://github.com/<full_name>.git; others are left out. Any failure gives null here (and [] from ghRepos), and the
 * log says why.
 */
export async function ghReposOrNull({ ghPath, env = process.env, cwd, log } = {}) {
  const note = (m) => { try { log?.(m); } catch { /* logging never breaks the list */ } };
  if (!ghPath) return null;
  const r = await runGh(ghPath, ['api', '--hostname', 'github.com', GH_REPOS_PATH], { env, timeoutMs: LIST_MS, maxBytes: MAX_LIST_BYTES, cwd });
  if (r.code !== 0) {
    note(`GitHub's command-line tool could not list the repositories: ${said(r)}`);
    return null;
  }
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { json = null; }
  if (!Array.isArray(json)) {
    note('GitHub’s command-line tool gave a list of repositories Workbench could not read.');
    return null;
  }
  return json.map(repoOf).filter(Boolean).slice(0, 100);
}

/** ghReposOrNull, with [] for any failure. */
export async function ghRepos(o = {}) {
  return (await ghReposOrNull(o)) || [];
}

// ------------------------------------------------------------------ Terminal

/**
 * A step for Terminal: gh through `/usr/bin/env -u GH_TOKEN -u GITHUB_TOKEN`, since Terminal's shell runs the person's
 * profile, where either one may be set (gh's login refuses while one is).
 */
function terminalStep(ghPath, args) {
  const [file, argv] = commandFor(ghPath, args);
  return { program: '/usr/bin/env', args: ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', file, ...argv] };
}

/** gh's login in Terminal: `{ program, args }` for openTerminal. */
export function ghSignInProgram(ghPath) {
  return terminalStep(ghPath, GH_LOGIN_ARGS);
}

/** The two steps of the sign-in in Terminal, for openTerminalSteps: the login, then (when it worked) setup-git. */
export function ghSignInSteps(ghPath) {
  return [terminalStep(ghPath, GH_LOGIN_ARGS), terminalStep(ghPath, GH_SETUP_GIT_ARGS)];
}

/** gh's sign-out in Terminal: `{ program, args }` for openTerminal. */
export function ghSignOutProgram(ghPath) {
  return terminalStep(ghPath, GH_LOGOUT_ARGS);
}

/** Words for a person to type into a shell: plain words as they are, anything else quoted. */
function commandLine(words) {
  return words.map((w) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(w) ? w : shellQuote(w))).join(' ');
}

/** The sign-in as one line for a terminal of the person's own (where Terminal cannot be opened). */
export function ghSignInCommand(ghPath) {
  return [GH_LOGIN_ARGS, GH_SETUP_GIT_ARGS].map((args) => commandLine([ghPath, ...args])).join(' && ');
}

/** The sign-out as one line for a terminal of the person's own. */
export function ghSignOutCommand(ghPath) {
  return commandLine([ghPath, ...GH_LOGOUT_ARGS]);
}

// ------------------------------------------------------------------ git's helper for github.com

/**
 * Run `fn(cwd, env)` in a new empty folder that is in no repository, as workspace.mjs reads git's global settings: a
 * private folder of Workbench's own (privateTemp), never in the temporary folder, where another process could put a
 * repository of its own in it first.
 */
async function outsideRepos(fn) {
  const dir = privateTemp('workbench-git-');
  try {
    return await fn(dir, { GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether a helper value is gh's own: `!<path to gh> auth git-credential` (the path in single quotes when it needs them). */
export function isGhHelper(value) {
  const m = /^!(?:'([^']+)'|(\S+)) auth git-credential$/.exec(String(value ?? ''));
  return !!m && path.basename(m[1] ?? m[2]) === 'gh';
}

/** Every value of one key in git's global settings, in order (an empty value too). */
async function globalValues(key, cwd, env) {
  const r = await git(['config', '--global', '-z', '--get-all', key], { cwd, env, okCodes: [1] });
  if (r.code === 1) return [];
  const parts = String(r.stdout).split('\0');
  parts.pop();
  return parts;
}

function gitTrouble(e, sentence) {
  return refusal('git', sentence, e && (e.stderr || e.message));
}

/**
 * Whether git asks gh for github.com's sign-in: the last value of `credential.https://github.com.helper` in git's
 * global settings is gh's (after setup-git's empty value, which drops every helper before it, Apple's osxkeychain too).
 * @returns {Promise<boolean>}
 */
export async function gitUsesGh() {
  return outsideRepos(async (cwd, env) => {
    let values;
    try {
      values = await globalValues(GH_HELPER_KEYS[0], cwd, env);
    } catch (e) {
      throw gitTrouble(e, 'Git could not read its settings.');
    }
    return values.length > 0 && isGhHelper(values[values.length - 1]);
  });
}

/**
 * Take out what `gh auth setup-git` wrote in git's global settings, for github.com and for gist.github.com: each key
 * only when it holds exactly setup-git's values, the empty one and then gh's own (more than once when two setup-gits
 * ran at the same moment). Anything the person wrote there stays. A section left empty goes too. Git then asks the
 * helpers it asked before (on a Mac, the login keychain).
 * @returns {Promise<{ removed: string[], kept: string[] }>} kept: keys that held something else, left as they were
 */
export async function forgetGhGitHelper() {
  return outsideRepos(async (cwd, env) => {
    const removed = [];
    const kept = [];
    for (const key of GH_HELPER_KEYS) {
      let values;
      try {
        values = await globalValues(key, cwd, env);
      } catch (e) {
        throw gitTrouble(e, 'Git could not read its settings.');
      }
      if (!values.length) continue;
      if (!(values.length >= 2 && values[0] === '' && values.slice(1).every(isGhHelper))) {
        kept.push(key);
        continue;
      }
      try {
        await git(['config', '--global', '--unset-all', key], { cwd, env });
      } catch (e) {
        throw gitTrouble(e, 'Git could not change its settings.');
      }
      removed.push(key);
      const section = key.slice(0, -'.helper'.length);
      const rest = await git(['config', '--global', '--get-regexp', `^${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`], { cwd, env, okCodes: [1] }).catch(() => null);
      if (rest && rest.code === 1) await git(['config', '--global', '--remove-section', section], { cwd, env }).catch(() => {});
    }
    return { removed, kept };
  });
}

// ------------------------------------------------------------------ downloading gh

/**
 * The release files for this computer: `gh_<v>_macOS_<arm64|amd64>.zip` or `gh_<v>_linux_<amd64|arm64>.tar.gz`, the
 * program inside it (`gh_<v>_<os>_<arch>/bin/gh`), and the checksums file. Any other system or processor is refused.
 */
export function ghAsset({ version, platform = process.platform, arch = process.arch } = {}) {
  const osName = OS_NAMES[platform];
  const archName = ARCH_NAMES[arch];
  if (!osName || !archName) {
    throw refusal('platform', 'GitHub does not publish its command-line tool for this kind of computer, so Workbench cannot get it. Use a token instead.');
  }
  if (!VERSION_RE.test(String(version ?? ''))) throw refusal('github', 'GitHub did not say which version of its command-line tool is the latest. Try again in a few minutes.');
  const folder = `gh_${version}_${osName}_${archName}`;
  const kind = platform === 'darwin' ? 'zip' : 'tar.gz';
  return { name: `${folder}.${kind}`, kind, member: `${folder}/bin/gh`, checksums: `gh_${version}_checksums.txt` };
}

/** The SHA-256 the checksums file gives for `name` (lines of `<64 hex>  <name>`), or null. */
export function checksumFor(text, name) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
    if (m && m[2].trim() === name) return m[1].toLowerCase();
  }
  return null;
}

/** "macOS 13 or later" in Darwin's numbering (Darwin 22 is macOS 13). Unknown: allowed. */
function darwinTooOld(release) {
  const major = parseInt(String(release || '').split('.')[0], 10);
  return Number.isFinite(major) && major < 22;
}

/** The time limit and the person's stop, as one signal. */
function signalFor(ms, signal) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

function networkTrouble(e, signal) {
  if (signal?.aborted) return refusal('cancelled', 'Stopped getting GitHub’s command-line tool.');
  return refusal('network', 'Workbench could not reach GitHub to get its command-line tool. Check the internet connection, then try again.',
    `${e?.name || 'Error'}: ${e?.cause?.code || e?.code || e?.message || ''}`);
}

function notAsExpected(what, detail) {
  return refusal('github', `GitHub did not give Workbench ${what}. Try again in a few minutes.`, detail);
}

/**
 * The latest gh's version, from the redirect of https://github.com/cli/cli/releases/latest (its Location ends in
 * /tag/v<version>), not from GitHub's API.
 */
export async function ghLatestVersion({ fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await fetchImpl(`${GH_RELEASES}/latest`, { redirect: 'manual', signal: signalFor(FIND_MS, signal), headers: { 'User-Agent': 'Workbench' } });
  } catch (e) {
    throw networkTrouble(e, signal);
  }
  try { await res.body?.cancel?.(); } catch { /* nothing to read */ }
  let where = '';
  try { where = new URL(res.headers.get('location') || '', `${GH_RELEASES}/latest`).href; } catch { where = ''; }
  const m = res.status >= 300 && res.status < 400 ? TAG_RE.exec(where) : null;
  if (!m) throw notAsExpected('the number of its latest command-line tool', `answered ${res.status} with Location ${oneLine(where, 200)}`);
  return m[1];
}

/** GET over https, refusing anything else, also after redirects. */
async function getHttps(url, { fetchImpl, signal, ms }) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: signalFor(ms, signal), headers: { 'User-Agent': 'Workbench' } });
  } catch (e) {
    throw networkTrouble(e, signal);
  }
  if (typeof res.url === 'string' && res.url && !res.url.startsWith('https://')) throw notAsExpected('its command-line tool over a safe connection', `redirected to ${oneLine(res.url, 200)}`);
  return res;
}

/** The checksums file's text (at most 64 KB). */
async function readChecksums(url, o) {
  const res = await getHttps(url, { ...o, ms: FIND_MS });
  if (res.status !== 200 || !res.body) throw notAsExpected('the checksums of its command-line tool', `answered ${res.status} for ${url}`);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_CHECKSUMS_BYTES) throw notAsExpected('the checksums of its command-line tool', 'the checksums file is too large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (e) {
    if (e && e.plain) throw e;
    throw networkTrouble(e, o.signal);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Download `url` into `file` (made new, 0600), hashing it as it comes: → its SHA-256 (hex). */
async function downloadTo(url, file, { fetchImpl, signal, onBytes }) {
  const res = await getHttps(url, { fetchImpl, signal, ms: DOWNLOAD_MS });
  if (res.status !== 200 || !res.body) throw notAsExpected('its command-line tool', `answered ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || null;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_ARCHIVE_BYTES) throw notAsExpected('its command-line tool', 'the download is larger than any gh release');
      hash.update(buf);
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
      onBytes?.(size, total);
    }
  } catch (e) {
    if (e && e.plain) throw e;
    throw networkTrouble(e, signal);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** A program with an argument array and a time limit: resolves `{ code, stderr }`, never rejects. */
function runProgram(file, args, { timeoutMs = EXTRACT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0, error: err && typeof err.code !== 'number' ? err : null, stderr: String(stderr || '') });
    });
  });
}

function tarProgram() {
  for (const p of ['/usr/bin/tar', '/bin/tar']) if (isProgram(p)) return p;
  return 'tar';
}

/**
 * macOS: whether `file` is signed by GitHub, by its Developer ID: `codesign --verify --strict` with a requirement that
 * the leaf certificate's team is GitHub's (GH_TEAM_ID).
 * @returns {Promise<boolean>}
 */
export async function codesignVerify(file) {
  const r = await runProgram('/usr/bin/codesign', ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "${GH_TEAM_ID}"`, file], { timeoutMs: 60_000 });
  return r.code === 0;
}

/**
 * Download GitHub's official gh for this computer and put it in ~/.local/bin/gh. Asked only when the person acts (Sign
 * in to GitHub, when gh is missing or older than Workbench needs).
 *
 * 1. The latest version, from the redirect of /releases/latest (never the API).
 * 2. The release's checksums file, then the archive for this computer, into a new private folder (0700) of Workbench's
 *    own, ~/.workbench/tmp/workbench-gh-XXXXXX (privateTemp in workspace.mjs), never the temporary folder, which an
 *    agent's process may write; the archive's SHA-256 must be the checksums file's, before anything else is done with it.
 * 3. Only the program is taken out (`/usr/bin/unzip` on macOS, tar elsewhere: argument arrays), into that folder: it
 *    must be a plain file. On macOS it must be signed by GitHub (codesignVerify).
 * 4. It is copied beside ~/.local/bin/gh under a temporary name and made 0755. There it must run and say the
 *    release's version (never in a temporary folder, which may not let programs run). Then it is renamed onto
 *    ~/.local/bin/gh: an older one there is updated in place, and nothing half-written is ever at that path.
 * The private folder and the temporary name go in every case. Refusals are plain errors with `.why`: `platform`,
 * `macos`, `network`, `github` (an answer Workbench did not expect), `checksum`, `signature`, `runs`, `disk` (also when
 * the private folder cannot be made) or `cancelled`.
 *
 * @param {{ onProgress?: (p: { phase: 'finding'|'downloading'|'checking'|'installing', percent?: number }) => void,
 *   fetchImpl?: typeof fetch, platform?: string, arch?: string, home?: string, osRelease?: string,
 *   verify?: (file: string) => Promise<boolean>, env?: object, signal?: AbortSignal }} [o]
 *   verify: the signature check on macOS (codesignVerify); tests give their own. home: where ~/.local/bin and
 *   ~/.workbench are (os.homedir())
 * @returns {Promise<{ path: string, version: string }>}
 */
export async function ghInstall({
  onProgress, fetchImpl = fetch, platform = process.platform, arch = process.arch, home = os.homedir(), osRelease = os.release(),
  verify = codesignVerify, env = process.env, signal,
} = {}) {
  const progress = (p) => { try { onProgress?.(p); } catch { /* the caller's trouble */ } };
  ghAsset({ version: '0.0.0', platform, arch }); // refuses a computer GitHub publishes no gh for, before any download
  if (platform === 'darwin' && darwinTooOld(osRelease)) {
    throw refusal('macos', 'GitHub’s command-line tool needs macOS 13 or later, so Workbench cannot use it on this Mac. Use a token instead.');
  }
  progress({ phase: 'finding' });
  const version = await ghLatestVersion({ fetchImpl, signal });
  const asset = ghAsset({ version, platform, arch });
  let work;
  try {
    work = privateTemp('workbench-gh-', { home });
  } catch (e) {
    throw refusal('disk', e.plain ? e.message : 'Workbench could not make a private folder for the download.', e.detail || e.message);
  }
  const dest = ghOwnPath(home);
  let tmp = null;
  try {
    const base = `${GH_RELEASES}/download/v${version}`;
    const want = checksumFor(await readChecksums(`${base}/${asset.checksums}`, { fetchImpl, signal }), asset.name);
    if (!want) throw notAsExpected('a checksum for its command-line tool', `no line for ${asset.name} in ${asset.checksums}`);
    const archive = path.join(work, asset.name);
    let last = -1;
    progress({ phase: 'downloading', percent: 0 });
    const got = await downloadTo(`${base}/${asset.name}`, archive, {
      fetchImpl, signal,
      onBytes: (size, total) => {
        if (!total) return;
        const percent = Math.min(100, Math.floor((size / total) * 100));
        if (percent !== last) {
          last = percent;
          progress({ phase: 'downloading', percent });
        }
      },
    });
    if (got !== want) {
      throw refusal('checksum', 'The download of GitHub’s command-line tool did not match the checksum GitHub published for it, so Workbench did not install it.',
        `${asset.name}: sha256 ${got}, the checksums file says ${want}`);
    }
    progress({ phase: 'checking' });
    const out = path.join(work, 'out');
    fs.mkdirSync(out, { mode: 0o700 });
    const x = asset.kind === 'zip'
      ? await runProgram('/usr/bin/unzip', ['-q', '-o', archive, asset.member, '-d', out])
      : await runProgram(tarProgram(), ['-xzf', archive, '-C', out, asset.member]);
    const bin = path.join(out, ...asset.member.split('/'));
    let st = null;
    try { st = fs.lstatSync(bin); } catch { st = null; }
    if (x.code !== 0 || !st || !st.isFile() || st.size === 0) {
      throw refusal('github', 'The download of GitHub’s command-line tool did not hold the program Workbench expected, so it was not installed.',
        x.code !== 0 ? `extracting ${asset.member}: ${x.error?.code || x.code}: ${x.stderr}` : `${asset.member} is not a plain file`);
    }
    if (platform === 'darwin') {
      let signed = false;
      try { signed = await verify(bin); } catch { signed = false; }
      if (!signed) throw refusal('signature', 'The copy of GitHub’s command-line tool that was downloaded is not signed by GitHub, so Workbench did not install it.');
    }
    // It is tried where it will live, under a temporary name: the temporary folder may not let programs run (noexec).
    const dir = path.dirname(dest);
    const disk = (e) => refusal('disk', `Workbench could not put GitHub’s command-line tool in ${oneLine(dir, 300)}.`, `${e.code || ''} ${e.message || ''}`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      tmp = path.join(dir, `.gh-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
      fs.copyFileSync(bin, tmp, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(tmp, 0o755);
    } catch (e) {
      throw disk(e);
    }
    const ran = await ghVersion({ ghPath: tmp, env, timeoutMs: 30_000, cwd: work });
    if (ran !== version) {
      throw refusal('runs', 'The copy of GitHub’s command-line tool that was downloaded does not run on this computer, so Workbench did not install it.',
        `${asset.member} said version ${ran ?? 'nothing'}, the release is ${version}`);
    }
    progress({ phase: 'installing' });
    try {
      fs.renameSync(tmp, dest);
      tmp = null;
    } catch (e) {
      throw disk(e);
    }
    return { path: dest, version };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* not there */ } }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}
