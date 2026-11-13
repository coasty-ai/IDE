// The key store: keys a person gives their agents (API keys, cloud keys, tokens), kept out of every file, log and
// page Workbench writes.
//
// - What each key is (its label, its variable names, which repositories and agents get it, where its values are kept)
//   goes in ~/.workbench/keys.json: 0600 in a 0700 folder, written atomically, never holding a value, secret or not.
// - The values go in the login keychain on macOS, through `/usr/bin/security -i`; on Linux in the Secret Service,
//   through `secret-tool`, when one answers; otherwise in a private file per key in ~/.workbench/keys/.
// - load() reads every value once into memory. envFor() gives an agent the values for its repository and harness,
//   synchronously, at launch. values() lists the secret ones, so text can be masked (maskSecrets) before anyone sees it.
//
// `security -i` reads its commands from stdin, and env-secrets.md 5.1 found what it does with them: it splits words
// like a small shell, reads at most 4095 bytes at a time (what follows runs as another command), matches command names
// by prefix, exits with the last command's status, and repeats the words it parsed in its errors. So: one command per
// process; names and ids in a safe alphabet; values hex-encoded with -X; a line of 4000 bytes or more is refused before
// anything starts; and its stderr is never logged, kept or shown, only sorted into a plain reason.
//
// The store keeps keys safe at rest, and out of repositories, logs, history and the page. It cannot keep them from
// agents: an agent runs as the person and can read what the person can (env-secrets.md 5.4). The panel says so.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presetById } from '../shared/keypresets.mjs';
import { looksLikeSecret } from '../shared/secretshape.mjs';

/** A variable name a key may set (and not in FORBIDDEN_NAMES). */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_KEYS = 50;
export const MAX_NAMES = 20;
export const MAX_VALUE = 2000;
export const MAX_LABEL = 80;
/** The keychain item's service, and the Secret Service item's `service` attribute; the account is `<id>/<NAME>`. */
export const SERVICE = 'Workbench key';

const VERSION = 1;
const ID_RE = /^k[0-9a-f]{12}$/;
const AGENT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_AGENTS = 20;
const MAX_ROOT = 4096;
const KEPT = new Set(['keychain', 'secret-tool', 'file']);
const BACKENDS = new Set(['auto', 'keychain', 'secret-tool', 'file']);
/** `security -i` reads 4095 bytes at a time; a line this long or longer is never sent. */
const MAX_LINE_BYTES = 4000;
const SECURITY_TIMEOUT_MS = 120_000; // long enough to answer a dialog that asks to unlock the keychain
const SECRET_TOOL_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const READ_AT_ONCE = 4;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
/** Opening a FIFO with this returns at once, writer or not (it changes nothing for a regular file). */
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

// ------------------------------------------------------------------ names refused

const forbid = (why, names) => names.map(name => Object.freeze({ name, why }));

/**
 * Variable names a key may not set, each with why: `{ name, why }`, where a name ending in `*` stands for every name
 * that starts with what comes before it. Names are compared in upper case. `why` finishes the sentence "Workbench
 * does not keep NAME as a key, because …".
 */
export const FORBIDDEN_NAMES = Object.freeze([
  // Subscription sign-ins stay with the vendors' own logins (Anthropic's terms; env-secrets.md, owner decision 2).
  ...forbid('it is a Claude subscription’s own sign-in, which stays with Claude Code: sign in there instead',
    ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN']),
  ...forbid('it is a ChatGPT sign-in, which stays with Codex: sign in there instead', ['CODEX_ACCESS_TOKEN']),
  // Where programs are found and how they start.
  ...forbid('it decides which programs run', ['PATH']),
  ...forbid('programs keep their settings and sign-ins under it', ['HOME']),
  ...forbid('programs find your account, and Claude Code your sign-in, by it', ['USER', 'LOGNAME']),
  ...forbid('it decides which shell runs commands', ['SHELL']),
  ...forbid('it moves where programs keep temporary files', ['TMPDIR', 'TMP', 'TEMP']),
  ...forbid('it changes how programs read and write text', ['LANG', 'LC_*']),
  ...forbid('the shell sets it itself', ['PWD', 'OLDPWD', 'SHLVL', '_']),
  ...forbid('it makes programs load code they would not otherwise run', ['LD_*', 'DYLD_*', 'NODE_OPTIONS',
    'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB',
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS']),
  ...forbid('it changes where Node finds code', ['NODE_PATH']),
  ...forbid('it runs a file before every shell script', ['BASH_ENV', 'ENV']),
  ...forbid('it moves the files zsh runs when it starts', ['ZDOTDIR']),
  ...forbid('the shell runs it as a command', ['PROMPT_COMMAND', 'PS4']),
  ...forbid('it changes how the shell reads commands', ['IFS', 'SHELLOPTS', 'BASHOPTS']),
  ...forbid('it names a program that other programs start', ['EDITOR', 'VISUAL', 'PAGER', 'BROWSER']),
  // Network and trust (ACP's launch-safety rule; agents-catalog.md 2).
  ...forbid('it changes which servers programs trust', ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']),
  ...forbid('it can turn off the check that a server is who it says it is', ['NODE_TLS_REJECT_UNAUTHORIZED']),
  ...forbid('it changes where network traffic goes, keys included', ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']),
  ...forbid('it changes how SSH signs in', ['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']),
  ...forbid('it changes which repository git works on, or how git runs', ['GIT_*']),
  ...forbid('it moves where programs keep their settings', ['XDG_*']),
  ...forbid('it decides where programs find the keyring', ['DBUS_SESSION_BUS_ADDRESS']),
  // Workbench's own, and the agents'.
  ...forbid('Workbench sets it itself, for its own use', ['WORKBENCH_*']),
  ...forbid('it moves Claude Code’s settings and sign-in', ['CLAUDE_CONFIG_DIR']),
  ...forbid('it moves the folder Claude Code may use without asking', ['CLAUDE_CODE_TMPDIR']),
  ...forbid('Claude Code runs it before each command', ['CLAUDE_ENV_FILE', 'CLAUDE_CODE_SHELL_PREFIX']),
  ...forbid('it would take Workbench’s hook key away from Claude Code’s hooks, and stop every tool call',
    ['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']),
  // The markers a running Claude Code sets (the Claude adapter's SCRUB_ENV_RE): keys are added after that scrub.
  ...forbid('it ties an agent to another Claude Code session', ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
    'CLAUDE_JOB_DIR', 'CLAUDE_AGENT_SDK_*', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_*',
    'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_*', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_*',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_EMIT_STARTUP_TIMING',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
    'CLAUDE_CODE_STARTUP_FAILURE_RESULTS']),
  ...forbid('it moves Codex’s settings and sign-in', ['CODEX_HOME']),
  // The variables a running Codex sets for its commands (the Codex adapter's CODEX_SESSION_VARS).
  ...forbid('it ties an agent to another Codex session', ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_TOOL_CALL_ID',
    'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_PERMISSION_PROFILE', 'CODEX_EXEC_SERVER_*',
    'CODEX_NETWORK_PROXY_*', 'CODEX_SNAPSHOT_*', 'CODEX_SHELL_SNAPSHOT_*']),
  ...forbid('it belongs to the editor Workbench was started from', ['VSCODE_*']),
  ...forbid('it changes how programs start', ['ELECTRON_RUN_AS_NODE']),
]);

/** The FORBIDDEN_NAMES entry that refuses `name`, or null. */
export function forbiddenName(name) {
  const upper = String(name).toUpperCase();
  return FORBIDDEN_NAMES.find(f => (f.name.endsWith('*') ? upper.startsWith(f.name.slice(0, -1)) : upper === f.name)) || null;
}

// ------------------------------------------------------------------ showing and masking values

/** Printable ASCII that is safe inside a JSON string and a sentence: no space, no " and no \. */
const SAFE_TAIL = /^[\x21\x23-\x5b\x5d-\x7e]{4}$/;

/**
 * How a secret value is shown: "•••• " and its last 4 characters for values of 12 characters or more, "••••" for
 * shorter ones (and when the last 4 are not plain printable characters).
 */
export function shownValue(value) {
  const s = String(value ?? '');
  if (s.length < 12) return '••••';
  const tail = s.slice(-4);
  return SAFE_TAIL.test(tail) ? `•••• ${tail}` : '••••';
}

const MASKS = new WeakMap();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function maskPlan(values) {
  if (!values || typeof values[Symbol.iterator] !== 'function' || typeof values === 'string') return null;
  if (MASKS.has(values)) return MASKS.get(values);
  const masks = new Map();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < 8) continue;
    const shown = shownValue(v);
    masks.set(v, shown);
    // In a line of JSON (an agent's raw output) the value appears escaped.
    const escaped = JSON.stringify(v).slice(1, -1);
    if (escaped !== v) masks.set(escaped, shown);
  }
  const forms = [...masks.keys()].sort((a, b) => b.length - a.length);
  const plan = forms.length ? { re: new RegExp(forms.map(escapeRe).join('|'), 'g'), masks } : null;
  if (Object.isFrozen(values)) MASKS.set(values, plan);
  return plan;
}

/**
 * `text` with every value of 8 or more characters replaced by how it is shown (shownValue), longest first, in one pass.
 * A value's JSON-escaped form is replaced too, so a raw line of JSON stays JSON. Returns `text` as it is when there is
 * nothing to mask.
 * @param {string} text
 * @param {Iterable<string>} values
 */
export function maskSecrets(text, values) {
  if (typeof text !== 'string' || !text) return text;
  const plan = maskPlan(values);
  if (!plan) return text;
  return text.replace(plan.re, (m) => plan.masks.get(m));
}

// ------------------------------------------------------------------ checks, in plain words

function keyError(why, message, detail = null) {
  const err = new Error(message);
  err.why = why;
  err.plain = true;
  if (detail) err.detail = detail;
  return err;
}

const count = (n) => n.toLocaleString('en-US');
const listed = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Characters a label may not hold: controls, line and paragraph separators, and invisible ones (soft hyphen,
 * zero-width characters, direction marks and isolates, the byte-order mark). Built from code points, so that this
 * file holds none of them.
 */
const codePoint = (cp) => `\\u${cp.toString(16).padStart(4, '0')}`;
const charClass = (list) => list.map(([a, b]) => (b ? `${codePoint(a)}-${codePoint(b)}` : codePoint(a))).join('');
const UNPRINTABLE = new RegExp(`[\\p{Cc}\\p{Zl}\\p{Zp}${charClass([[0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff]])}]`, 'u');
/** Line breaks a value may not hold: LF, CR, NEL, and the line and paragraph separators. */
const LINE_BREAK = new RegExp(`[\\n\\r${charClass([[0x85], [0x2028, 0x2029]])}]`);

function checkName(name) {
  // A name that fails is never repeated back: it may be a key typed into the wrong field.
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw keyError('name', 'A variable name can use only letters, digits and _, cannot start with a digit, and can be at most 128 characters long.');
  }
  if (looksLikeSecret(name).secret) {
    throw keyError('name', 'That name looks like a key itself. Put the key in its value, and give it a name such as AWS_ACCESS_KEY_ID.');
  }
  const f = forbiddenName(name);
  if (f) throw keyError('forbidden', `Workbench does not keep ${name} as a key, because ${f.why}.`);
}

function checkValue(name, value) {
  const n = [...value].length;
  if (n > MAX_VALUE) throw keyError('value', `The value of ${name} is ${count(n)} characters long. A key can be at most ${count(MAX_VALUE)}.`);
  if (value.includes('\0')) throw keyError('value', `The value of ${name} has a NUL character in it, which a key cannot hold.`);
  if (LINE_BREAK.test(value)) throw keyError('value', `The value of ${name} has a line break in it. A key is one line.`);
}

function checkLabel(label) {
  const ask = 'Give the key a label, such as “AWS for the shop”.';
  if (typeof label !== 'string') throw keyError('name', ask);
  const s = label.trim();
  const n = [...s].length;
  if (!n) throw keyError('name', ask);
  if (n > MAX_LABEL) throw keyError('name', `A label can be at most ${MAX_LABEL} characters long; this one has ${count(n)}.`);
  if (UNPRINTABLE.test(s)) throw keyError('name', 'A label can only hold characters that print: no line breaks, tabs or invisible characters.');
  if (looksLikeSecret(s).secret) throw keyError('name', 'That label looks like a key itself. Put the key in its field, and give it a label you will recognise.');
  return s;
}

/** A label for a key added without one: the preset's, or (for the person's own names) the first name. */
function defaultLabel(preset, vars) {
  if (preset.id !== 'custom') return preset.label;
  const s = vars.length === 1 ? vars[0].name : `${vars[0].name} and ${vars.length - 1} more`;
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s;
}

function realOrResolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function cleanScope(scope) {
  if (scope == null || scope === 'all' || (typeof scope === 'object' && scope.kind === 'all')) return { kind: 'all' };
  if (typeof scope === 'object' && scope.kind === 'repo') {
    const root = scope.root;
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > MAX_ROOT || root.includes('\0')) {
      throw keyError('name', 'A key for one repository needs that repository’s folder.');
    }
    return { kind: 'repo', root: realOrResolved(root) };
  }
  throw keyError('name', 'A key is either for all repositories, or for one.');
}

function cleanAgents(agents) {
  if (agents == null || agents === 'all') return 'all';
  if (!Array.isArray(agents)) throw keyError('name', 'Choose which agents get the key: all of them, or some.');
  if (agents.includes('all')) return 'all';
  const ids = [...new Set(agents)];
  if (ids.length > MAX_AGENTS || ids.some(a => typeof a !== 'string' || !AGENT_RE.test(a))) {
    throw keyError('name', 'Workbench does not know one of the agents chosen for the key.');
  }
  return ids;
}

/**
 * The variables a new key sets, checked: [{ name, value, secret }], the preset's fields first in its order. A field's
 * `also` names get its value when they were not given (and the field gets theirs). Missing optional fields and empty
 * optional values are left out; a missing required one is refused.
 *
 * A name is secret when its preset field is, when `secretNames` lists it (or its field), when it is not a preset field
 * and `secretNames` was not given, or when its value looks like a key: a preset's secret field is never shown, whatever
 * the caller says.
 */
function planVars(preset, values, secretNames) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw keyError('value', 'Type the key’s value.');
  const fields = new Map();
  for (const f of preset.fields) for (const n of [f.name, ...(f.also || [])]) fields.set(n, f);
  const given = new Map();
  for (const [name, raw] of Object.entries(values)) {
    checkName(name);
    if (raw != null && typeof raw !== 'string') throw keyError('value', `The value of ${name} must be text.`);
    const value = (raw ?? '').trim();
    if (!value) {
      if (fields.get(name)?.optional) continue;
      throw keyError('value', `Type a value for ${name}.`);
    }
    checkValue(name, value);
    given.set(name, value);
  }
  for (const f of preset.fields) {
    const names = [f.name, ...(f.also || [])];
    const value = names.map(n => given.get(n)).find(v => v != null);
    if (value == null) {
      if (!f.optional) throw keyError('value', `Type a value for ${f.name}.`);
      continue;
    }
    for (const n of names) if (!given.has(n)) given.set(n, value);
  }
  if (!given.size) throw keyError('value', 'Type at least one name and its value.');
  if (given.size > MAX_NAMES) throw keyError('too-many', `A key can set at most ${MAX_NAMES} variables; this one sets ${given.size}.`);
  const named = Array.isArray(secretNames) ? new Set(secretNames.filter(n => typeof n === 'string')) : null;
  const order = [...preset.fields.flatMap(f => [f.name, ...(f.also || [])]).filter(n => given.has(n)),
    ...[...given.keys()].filter(n => !fields.has(n))];
  return order.map((name) => {
    const value = given.get(name);
    const f = fields.get(name);
    const secret = (f ? f.secret : !named) || (named ? named.has(name) || (f ? named.has(f.name) : false) : false) || looksLikeSecret(value).secret;
    return { name, value, secret };
  });
}

/** A record read back from keys.json, checked field by field; null when it cannot be trusted. */
function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, preset, label, vars, scope, agents, kept, created } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id) || !KEPT.has(kept)) return null;
  if (!Array.isArray(vars) || !vars.length || vars.length > MAX_NAMES) return null;
  const names = new Set();
  const cleanVars = [];
  for (const v of vars) {
    if (!v || typeof v.name !== 'string' || !NAME_RE.test(v.name) || forbiddenName(v.name) || names.has(v.name)) return null;
    names.add(v.name);
    cleanVars.push({ name: v.name, secret: v.secret !== false });
  }
  let cleanScope;
  if (scope && scope.kind === 'all') cleanScope = { kind: 'all' };
  else if (scope && scope.kind === 'repo' && typeof scope.root === 'string' && path.isAbsolute(scope.root)
    && scope.root.length <= MAX_ROOT && !scope.root.includes('\0')) cleanScope = { kind: 'repo', root: scope.root };
  else return null; // never widen a key to every repository
  let cleanAgents;
  if (agents === 'all') cleanAgents = 'all';
  else if (Array.isArray(agents) && agents.length <= MAX_AGENTS && agents.every(a => typeof a === 'string' && AGENT_RE.test(a))) cleanAgents = [...new Set(agents)];
  else return null; // nor to every agent
  const p = presetById(preset) ? preset : 'custom';
  let cleanLabel;
  try { cleanLabel = checkLabel(label); } catch { cleanLabel = presetById(p).label; }
  return { id, preset: p, label: cleanLabel, vars: cleanVars, scope: cleanScope, agents: cleanAgents, kept,
    created: Number.isFinite(created) ? created : 0 };
}

// ------------------------------------------------------------------ files

/** A folder for keys: made 0700 if missing; it must be a folder of this account's, and is made private if it is not. */
function privateDir(dir, { allowLink = false, create = true } = {}) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if (!create && err.code === 'ENOENT') return false;
    throw err;
  }
  const refuse = (code) => Object.assign(keyError('store', `Workbench does not keep keys in ${dir}, because ${fileReason(code)}.`, code), { code });
  if (st.isSymbolicLink()) {
    if (!allowLink) throw refuse('ELOOP');
    st = fs.statSync(dir);
  }
  if (!st.isDirectory()) throw refuse('ENOTDIR');
  const uid = process.getuid?.();
  if (uid != null && st.uid !== uid) throw refuse('EOWNER');
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return true;
}

/** Write a file so a reader never sees half of it: a new temp file (O_EXCL, 0600) in the same folder, then a rename. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

const fileTrouble = (code) => Object.assign(new Error(code), { code });

/**
 * A file's text, or null when it does not exist. A link is never followed (ELOOP); the file must be a regular file of
 * this account's (ENOTFILE: it is opened without waiting, so a FIFO never blocks); with `secret`, nobody else may read
 * it (EMODE).
 */
function readPrivateFile(file, { secret = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fileTrouble('ENOTFILE');
    const uid = process.getuid?.();
    if (uid != null && st.uid !== uid) throw fileTrouble('EOWNER');
    if (secret && (st.mode & 0o077) !== 0) throw fileTrouble('EMODE');
    if (st.size > 4 * 1024 * 1024) throw fileTrouble('ETOOBIG');
    if (!secret && (st.mode & 0o077) !== 0) try { fs.fchmodSync(fd, 0o600); } catch { /* best effort */ }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a private file could not be used, as the end of a sentence. */
function fileReason(code) {
  return {
    ELOOP: 'it is a link to another place', ENOTFILE: 'it is not a plain file', ENOTDIR: 'it is not a folder',
    EOWNER: 'it belongs to another account on this computer', EMODE: 'other people on this computer could read it',
    ETOOBIG: 'it is far too big', EACCES: 'Workbench is not allowed to use it', EPERM: 'Workbench is not allowed to use it',
    damaged: 'it is damaged', 'not-found': 'it is missing',
  }[code] || 'it could not be read';
}

/** The first `name` that is a program in one of PATH's absolute folders, or null. */
function onPath(name, pathValue) {
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}

// ------------------------------------------------------------------ child programs

/**
 * Run a program with an argument array, `input` on its stdin (then closed), and a time limit. Node scripts (the test
 * stand-ins) run with this Node. Never rejects: `{ code, stdout, stderr, timedOut, error }`. The stderr is for sorting
 * a failure into a reason; callers never log, keep or show it.
 */
export function runProgram(bin, args, { input = '', env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const [file, argv] = /\.(mjs|cjs|js)$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
    let child;
    try {
      child = spawn(file, argv, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }
    const out = [];
    let outBytes = 0;
    let err = '';
    let timedOut = false;
    let settled = false;
    const finish = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fields);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on('data', (c) => { if (outBytes < 1024 * 1024) { out.push(c); outBytes += c.length; } });
    child.stderr.on('data', (c) => { if (err.length < 8192) err += c.toString('utf8'); });
    child.on('error', (error) => finish({ code: null, stdout: '', stderr: '', timedOut: false, error }));
    child.on('close', (code) => finish({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr: err, timedOut }));
    child.stdin.on('error', () => {}); // it may finish before reading everything
    child.stdin.end(input ?? '');
  });
}

/** Words `security -i` takes as they are; anything else is quoted. */
const PLAIN_WORD = /^[A-Za-z0-9._:@+/=-]+$/;

/**
 * One `security -i` command line: words joined by spaces, a word outside the plain alphabet in double quotes with
 * `\` and `"` escaped by a backslash, and a newline. A word with a line break or NUL is never sent.
 */
export function securityLine(words) {
  return words.map((w) => {
    if (typeof w !== 'string' || /[\r\n\0]/.test(w)) throw keyError('store', 'Workbench refused to send your keychain a line break.');
    return w && PLAIN_WORD.test(w) ? w : `"${w.replace(/[\\"]/g, c => `\\${c}`)}"`;
  }).join(' ') + '\n';
}

/** The account of one value: `<id>/<NAME>`, both checked again here, since they go on a command line. */
function account(id, name) {
  if (!ID_RE.test(id) || !NAME_RE.test(name)) throw keyError('store', 'Workbench refused a key whose name it could not trust.');
  return `${id}/${name}`;
}

/**
 * What the keychain item holds: the value itself when it is plain (letters, digits and ._~+/=-), else "wb1:" and the
 * base64 of its UTF-8. Either way only printable ASCII, so how `find-generic-password -w` prints other bytes (not
 * confirmed) never matters.
 */
const RAW_VALUE = /^[A-Za-z0-9._~+/=-]+$/;
const keychainData = (value) => (RAW_VALUE.test(value) ? value : `wb1:${Buffer.from(value, 'utf8').toString('base64')}`);

function fromStored(text) {
  if (text.startsWith('wb1:')) {
    const b64 = text.slice(4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
    const value = Buffer.from(b64, 'base64').toString('utf8');
    return Buffer.from(value, 'utf8').toString('base64') === b64 ? value : null;
  }
  return RAW_VALUE.test(text) ? text : null;
}

/** Why `security` failed, from its exit and stderr (read here, never kept). */
function securityTrouble(res) {
  if (res.error) return res.error.code === 'ENOENT' ? 'no-program' : 'no-start';
  if (res.timedOut) return 'timeout';
  const t = String(res.stderr || '');
  if (/could not be found|returned 44\b|-25300\b/i.test(t)) return 'not-found';
  if (/interaction is not allowed|returned 36\b|-25308\b/i.test(t)) return 'no-window';
  if (/cancel|returned 128\b/i.test(t)) return 'canceled';
  if (/locked|passphrase|returned 51\b/i.test(t)) return 'locked';
  return 'other';
}

/** Why `secret-tool` failed. A lookup that finds nothing exits 1 and says nothing. */
function secretToolTrouble(res, { lookup = false } = {}) {
  if (res.error) return res.error.code === 'ENOENT' ? 'no-program' : 'no-start';
  if (res.timedOut) return 'timeout';
  const t = String(res.stderr || '').trim();
  if (!t) return lookup && res.code === 1 ? 'not-found' : 'other';
  if (/locked/i.test(t)) return 'locked';
  return 'no-service';
}

/** Reasons that mean the store cannot be opened at all: the rest of its values are not asked for. */
const STOPPERS = new Set(['no-program', 'no-start', 'timeout', 'no-window', 'canceled', 'locked', 'no-service']);

/** Why a value could not be saved, read or removed, as the end of a sentence. */
function because(where, trouble, bin) {
  const store = where === 'keychain' ? 'your keychain' : 'your keyring';
  return {
    'no-program': `Workbench could not find ${bin}`,
    'no-start': `Workbench could not start ${bin}`,
    timeout: `${store} did not answer in time`,
    'no-window': `${store} is locked, and there is no window to unlock it in`,
    canceled: `${store} was not unlocked`,
    locked: `${store} is locked`,
    'no-service': 'no keyring answered',
    'not-found': `the value is not in ${store} any more`,
    damaged: `what ${store} holds for it is damaged`,
  }[trouble] || `${store} refused`;
}

// ------------------------------------------------------------------ the store

export class KeyStore {
  /**
   * @param {object} [o]
   * @param {string} [o.home]           the home folder; metadata goes in <home>/.workbench/keys.json
   * @param {string} [o.platform]       process.platform: 'darwin' keeps values in the keychain
   * @param {'auto'|'keychain'|'secret-tool'|'file'} [o.backend]  where new values go; 'auto' picks by platform
   * @param {string} [o.securityBin]    the `security` program (a .mjs stand-in in tests)
   * @param {string|null} [o.secretToolBin]  the `secret-tool` program; found on PATH when null
   * @param {object|null} [o.log]       a logger with warn/info; never given a value
   * @param {Function} [o.runner]       (bin, args, { input, timeoutMs }) => Promise<{ code, stdout, stderr }>
   * @param {object} [o.env]            the environment `security` and `secret-tool` run with (default process.env)
   */
  constructor({ home = os.homedir(), platform = process.platform, backend = 'auto', securityBin = '/usr/bin/security',
    secretToolBin = null, log = null, runner = null, env = process.env } = {}) {
    if (!BACKENDS.has(backend)) throw new TypeError(`Unknown place to keep keys: ${backend}`);
    this.home = home;
    this.platform = platform;
    this.backend = backend;
    this.securityBin = securityBin;
    this.secretToolBin = secretToolBin;
    this.log = log;
    this.env = env;
    this.runner = runner || ((bin, args, o) => runProgram(bin, args, { env: this.env, ...o }));
    this.dir = path.join(home, '.workbench');
    this.file = path.join(this.dir, 'keys.json');
    this.valuesDir = path.join(this.dir, 'keys');
    this._meta = [];             // the records, as keys.json has them
    this._cache = new Map();     // id → Map(name → { value } | { missing: reason })
    this._retired = new Set();   // secret values of keys removed in this run: still masked, agents may hold them
    this._secrets = null;        // values(), until something changes
    this._where = null;          // where new values go, once decided
    this._chain = Promise.resolve();
  }

  /** Every key: [{ id, preset, label, vars: [{ name, shown, secret, missing? }], scope, agents, kept, created }]. */
  list() {
    return this._serial(async () => {
      await this._refreshSafely();
      return this._meta.map(r => this._entry(r));
    });
  }

  /**
   * Keep a new key: its values in the keychain (or keyring, or a private file), what it is in keys.json.
   * @param {{ preset?: string, label?: string, values: Record<string,string>, secretNames?: string[],
   *   scope?: 'all'|{ kind: 'all' }|{ kind: 'repo', root: string }, agents?: 'all'|string[] }} spec
   * @returns {Promise<{ id: string }>}
   */
  add(spec) {
    return this._serial(() => this._add(spec || {}));
  }

  /** Forget a key and delete its values. @returns {Promise<{ removed: boolean }>} */
  remove(id) {
    return this._serial(() => this._remove(id));
  }

  /** Read keys.json and every value again. Never throws. @returns {Promise<{ keys: number, missing: number }>} */
  load() {
    return this._serial(async () => {
      for (const id of [...this._cache.keys()]) this._drop(id);
      await this._refreshSafely();
      let missing = 0;
      for (const vals of this._cache.values()) for (const got of vals.values()) if (!('value' in got)) missing++;
      return { keys: this._meta.length, missing };
    });
  }

  /**
   * The variables an agent gets: { NAME: value } from every key for this repository (compared after realpath) or all
   * repositories, given to this harness or all agents. The more specific key wins a clash (one repository over all,
   * one agent over all), then the later one. From memory: never starts anything, never throws.
   */
  envFor(where) {
    const env = {};
    try {
      const { repoRoot = null, harness = null } = where && typeof where === 'object' ? where : {};
      const root = typeof repoRoot === 'string' && repoRoot ? realOrResolved(repoRoot) : null;
      const rank = (r) => (r.scope.kind === 'repo' ? 2 : 0) + (r.agents === 'all' ? 0 : 1);
      const keys = this._meta
        .map((rec, i) => ({ rec, i }))
        .filter(({ rec }) => (rec.scope.kind === 'all' || (root != null && rec.scope.root === root))
          && (rec.agents === 'all' || (harness != null && rec.agents.includes(harness))))
        .sort((a, b) => rank(a.rec) - rank(b.rec) || a.i - b.i);
      for (const { rec } of keys) {
        const vals = this._cache.get(rec.id);
        if (!vals) continue;
        for (const v of rec.vars) {
          const got = vals.get(v.name);
          if (got && 'value' in got && NAME_RE.test(v.name) && !forbiddenName(v.name)) env[v.name] = got.value;
        }
      }
    } catch (err) {
      this._warn(`Workbench could not work out which keys an agent gets (${err.code || err.message}).`);
    }
    return env;
  }

  /** Every secret value in memory, and those of keys removed in this run: what to mask. Frozen, and the same array until something changes. */
  values() {
    if (!this._secrets) {
      const set = new Set(this._retired);
      for (const rec of this._meta) {
        const vals = this._cache.get(rec.id);
        if (!vals) continue;
        for (const v of rec.vars) {
          const got = vals.get(v.name);
          if (v.secret && got && 'value' in got) set.add(got.value);
        }
      }
      this._secrets = Object.freeze([...set]);
    }
    return this._secrets;
  }

  /** One key's values in memory, { NAME: value }, or null (Connect reads its GitHub token this way). */
  valuesOf(id) {
    const rec = this._meta.find(r => r.id === id);
    const vals = rec && this._cache.get(id);
    if (!vals) return null;
    const out = {};
    for (const v of rec.vars) {
      const got = vals.get(v.name);
      if (got && 'value' in got) out[v.name] = got.value;
    }
    return out;
  }

  // ---------------------------------------------------------------- inside

  _serial(fn) {
    const run = this._chain.then(fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  _warn(text) {
    try { this.log?.warn?.(text); } catch { /* logging never breaks the store */ }
  }

  _info(text) {
    try { this.log?.info?.(text); } catch { /* ignore */ }
  }

  _changed() {
    this._secrets = null;
  }

  /** Forget one key's values; the secret ones stay masked for the rest of the run. */
  _drop(id) {
    const vals = this._cache.get(id);
    if (!vals) return;
    const rec = this._meta.find(r => r.id === id);
    for (const [name, got] of vals) {
      const secret = rec ? rec.vars.find(v => v.name === name)?.secret !== false : true;
      if (secret && 'value' in got) this._retired.add(got.value);
    }
    this._cache.delete(id);
    this._changed();
  }

  /** _refresh, for load() and list(), which never throw: trouble is said, and what is in memory stays. */
  async _refreshSafely() {
    try {
      await this._refresh();
    } catch (err) {
      this._warn(`Workbench could not read its keys (${err.code || err.message}).`);
    }
  }

  /** keys.json again, and the values of any key not read yet (another Workbench may have added it). */
  async _refresh() {
    const records = this._readMeta();
    const ids = new Set(records.map(r => r.id));
    for (const id of [...this._cache.keys()]) if (!ids.has(id)) this._drop(id);
    this._meta = records;
    const unread = records.filter(r => !this._cache.has(r.id));
    if (unread.length) await this._readValues(unread);
    this._changed();
  }

  _entry(rec) {
    const vals = this._cache.get(rec.id);
    return {
      id: rec.id,
      preset: rec.preset,
      label: rec.label,
      vars: rec.vars.map((v) => {
        const got = vals?.get(v.name);
        if (!got || !('value' in got)) return { name: v.name, shown: v.secret ? '••••' : '', secret: v.secret, missing: true };
        return { name: v.name, shown: v.secret ? shownValue(got.value) : got.value, secret: v.secret };
      }),
      scope: rec.scope.kind === 'repo' ? { kind: 'repo', root: rec.scope.root } : { kind: 'all' },
      agents: rec.agents === 'all' ? 'all' : [...rec.agents],
      kept: rec.kept,
      created: rec.created,
    };
  }

  /**
   * The records in keys.json. A file that is not JSON, or is a link, is set aside as keys.json.damaged and read as
   * empty. Any other trouble reading it: empty with a warning, or with `strict` (before a write) a plain error, so a
   * list that could not be read is never written over.
   */
  _readMeta({ strict = false } = {}) {
    let text;
    try {
      text = readPrivateFile(this.file);
    } catch (err) {
      if (err.code === 'ELOOP' || err.code === 'ENOTFILE') return this._setAside();
      if (strict) throw keyError('store', `Workbench could not read its list of keys in ${this.file}, because ${fileReason(err.code)}.`, err.code);
      this._warn(`Workbench could not read its list of keys in ${this.file}, because ${fileReason(err.code)}.`);
      return [];
    }
    if (text == null) return [];
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return this._setAside();
    }
    const out = [];
    const seen = new Set();
    let dropped = 0;
    for (const raw of Array.isArray(data?.keys) ? data.keys : []) {
      const rec = cleanRecord(raw);
      if (!rec || seen.has(rec.id) || out.length >= MAX_KEYS) { dropped++; continue; }
      seen.add(rec.id);
      out.push(rec);
    }
    if (dropped) this._warn(`Workbench left out ${dropped} damaged ${dropped === 1 ? 'entry' : 'entries'} in its list of keys, ${this.file}.`);
    return out;
  }

  _setAside() {
    this._warn(`Workbench’s list of keys, ${this.file}, was damaged, so it was set aside as ${path.basename(this.file)}.damaged and a new one will be started.`);
    try { fs.renameSync(this.file, `${this.file}.damaged`); } catch { /* ignore */ }
    return [];
  }

  _writeMeta(records) {
    try {
      privateDir(this.dir, { allowLink: true });
      writeAtomic(this.file, JSON.stringify({ version: VERSION, keys: records }, null, 2) + '\n');
    } catch (err) {
      throw err.why ? err : keyError('store', `Workbench could not save its list of keys in ${this.file}.`, err.code || null);
    }
  }

  async _add(spec) {
    const preset = presetById(spec.preset ?? 'custom');
    if (!preset) throw keyError('name', 'Workbench does not know that kind of key.');
    const vars = planVars(preset, spec.values, spec.secretNames);
    const label = checkLabel(spec.label == null || spec.label === '' ? defaultLabel(preset, vars) : spec.label);
    const scope = cleanScope(spec.scope);
    const agents = cleanAgents(spec.agents === undefined ? preset.agents : spec.agents);
    let records = this._readMeta({ strict: true });
    if (records.length >= MAX_KEYS) throw tooMany();
    const where = await this._whereNew();
    let id;
    do id = `k${crypto.randomBytes(6).toString('hex')}`; while (records.some(r => r.id === id));
    if (where === 'keychain') this._keychainLines(id, vars); // every line measured before anything starts
    await this._put(where, id, vars);
    const record = { id, preset: preset.id, label, vars: vars.map(v => ({ name: v.name, secret: v.secret })), scope, agents, kept: where, created: Date.now() };
    try {
      records = this._readMeta({ strict: true });
      if (records.length >= MAX_KEYS) throw tooMany();
      this._writeMeta([...records, record]);
    } catch (err) {
      await this._del(where, id, vars.map(v => v.name)).catch(() => {
        this._warn(`Workbench could not take back the values it had just saved for ${listed(vars.map(v => v.name))}.`);
      });
      throw err;
    }
    this._meta = [...records, record];
    this._cache.set(id, new Map(vars.map(v => [v.name, { value: v.value }])));
    this._changed();
    this._info(`Workbench kept a new key that sets ${listed(vars.map(v => v.name))}.`);
    return { id };
  }

  async _remove(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { removed: false };
    const records = this._readMeta({ strict: true });
    const rec = records.find(r => r.id === id);
    if (!rec) {
      this._drop(id);
      this._meta = records;
      this._changed();
      return { removed: false };
    }
    await this._del(rec.kept, rec.id, rec.vars.map(v => v.name));
    const rest = this._readMeta({ strict: true }).filter(r => r.id !== id);
    this._writeMeta(rest);
    this._drop(id);
    this._meta = rest;
    this._changed();
    return { removed: true };
  }

  /** Where new values go. 'auto': the keychain on macOS; elsewhere the Secret Service when one answers, else files. */
  async _whereNew() {
    if (this._where) return this._where;
    let where = this.backend;
    if (where === 'auto') {
      if (this.platform === 'darwin') where = 'keychain';
      else if (await this._secretServiceAnswers()) where = 'secret-tool';
      else {
        where = 'file';
        this._info(`No keyring answered, so Workbench keeps keys in private files in ${this.valuesDir}.`);
      }
    }
    this._where = where;
    return where;
  }

  _secretTool() {
    return this.secretToolBin || onPath('secret-tool', this.env?.PATH);
  }

  /** Whether a Secret Service answers: a lookup of an item that does not exist finds nothing, and says nothing. */
  async _secretServiceAnswers() {
    const bin = this._secretTool();
    if (!bin) return false;
    try {
      const res = await this.runner(bin, ['lookup', 'service', SERVICE, 'account', 'probe'], { input: '', timeoutMs: PROBE_TIMEOUT_MS });
      if (res.error || res.timedOut) return false;
      return res.code === 0 || (res.code === 1 && !String(res.stderr || '').trim());
    } catch {
      return false;
    }
  }

  async _put(where, id, vars) {
    if (where === 'file') return this._filePut(id, vars);
    const done = [];
    try {
      for (const v of vars) {
        if (where === 'keychain') await this._keychainPut(id, v.name, v.value);
        else await this._secretToolPut(id, v.name, v.value);
        done.push(v.name);
      }
    } catch (err) {
      if (done.length) {
        await this._del(where, id, done).catch(() => {
          this._warn(`Workbench could not take back the values it had just saved for ${listed(done)}.`);
        });
      }
      throw err;
    }
  }

  async _del(where, id, names) {
    if (where === 'file') return this._fileDel(id);
    for (const name of names) {
      if (where === 'keychain') await this._keychainDel(id, name);
      else await this._secretToolDel(id, name);
    }
  }

  async _run(bin, args, input, timeoutMs) {
    try {
      return await this.runner(bin, args, { input, timeoutMs });
    } catch (error) {
      return { code: null, stdout: '', stderr: '', error };
    }
  }

  // --------------------------------------------------------------- the keychain

  _keychainLine(id, name, value) {
    const hex = Buffer.from(keychainData(value), 'utf8').toString('hex');
    return securityLine(['add-generic-password', '-U', '-s', SERVICE, '-a', account(id, name), '-X', hex]);
  }

  /** Every line this key would send, measured first: nothing starts when one is 4000 bytes or more. */
  _keychainLines(id, vars) {
    for (const v of vars) {
      const bytes = Buffer.byteLength(this._keychainLine(id, v.name, v.value));
      if (bytes >= MAX_LINE_BYTES) {
        const room = Math.floor((MAX_LINE_BYTES - 1 - Buffer.byteLength(this._keychainLine(id, v.name, 'x')) + 2) / 2);
        throw keyError('value', `The value of ${v.name} is too long for your keychain, which can keep about ${count(room)} characters in one key.`);
      }
    }
  }

  async _security(words) {
    return this._run(this.securityBin, ['-i'], securityLine(words), SECURITY_TIMEOUT_MS);
  }

  _keychainError(doing, trouble, res) {
    const sentence = doing === 'save'
      ? `Workbench could not save the key in your keychain, because ${because('keychain', trouble, this.securityBin)}.`
      : `Workbench could not remove the key from your keychain, because ${because('keychain', trouble, this.securityBin)}.`;
    // The detail is for the log: the program, the reason and the exit, never its stderr (it repeats what it was sent).
    return keyError('store', sentence, `security ${doing}: ${trouble}${res.code != null ? `, exit ${res.code}` : ''}`);
  }

  async _keychainPut(id, name, value) {
    const line = this._keychainLine(id, name, value);
    if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw keyError('value', `The value of ${name} is too long for your keychain.`);
    const res = await this._run(this.securityBin, ['-i'], line, SECURITY_TIMEOUT_MS);
    if (res.code !== 0) throw this._keychainError('save', securityTrouble(res), res);
  }

  async _keychainGet(id, name) {
    const res = await this._security(['find-generic-password', '-s', SERVICE, '-a', account(id, name), '-w']);
    if (res.code !== 0) return { missing: securityTrouble(res) };
    const value = fromStored(String(res.stdout || '').replace(/\r?\n$/, ''));
    return value == null ? { missing: 'damaged' } : { value };
  }

  async _keychainDel(id, name) {
    const res = await this._security(['delete-generic-password', '-s', SERVICE, '-a', account(id, name)]);
    if (res.code === 0) return;
    const trouble = securityTrouble(res);
    if (trouble === 'not-found') return;
    // Unsure why: if the item is gone after all, that is enough.
    if ((await this._keychainGet(id, name)).missing === 'not-found') return;
    throw this._keychainError('remove', trouble, res);
  }

  // --------------------------------------------------------------- the Secret Service

  _keyringError(doing, trouble, res, bin) {
    const sentence = doing === 'save'
      ? `Workbench could not save the key in your keyring, because ${because('secret-tool', trouble, bin || 'secret-tool')}.`
      : `Workbench could not remove the key from your keyring, because ${because('secret-tool', trouble, bin || 'secret-tool')}.`;
    return keyError('store', sentence, `secret-tool ${doing}: ${trouble}${res && res.code != null ? `, exit ${res.code}` : ''}`);
  }

  async _secretToolPut(id, name, value) {
    const bin = this._secretTool();
    if (!bin) throw this._keyringError('save', 'no-program', null);
    const acct = account(id, name);
    // The value goes on stdin, with no newline (secret-tool keeps everything up to the end); argv holds names only.
    const res = await this._run(bin, ['store', `--label=${SERVICE} ${acct}`, 'service', SERVICE, 'account', acct], value, SECRET_TOOL_TIMEOUT_MS);
    if (res.code !== 0) throw this._keyringError('save', secretToolTrouble(res), res, bin);
  }

  async _secretToolGet(id, name) {
    const bin = this._secretTool();
    if (!bin) return { missing: 'no-program' };
    const res = await this._run(bin, ['lookup', 'service', SERVICE, 'account', account(id, name)], '', SECRET_TOOL_TIMEOUT_MS);
    if (res.code !== 0) return { missing: secretToolTrouble(res, { lookup: true }) };
    const value = String(res.stdout || '').replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) return { missing: 'damaged' };
    return { value };
  }

  /**
   * `clear` removes only unlocked items, and says nothing when it removed none: the item is locked, or already gone (a
   * lookup cannot tell them apart either, since a dismissed prompt to unlock also finds nothing). So after a failed
   * clear, search says which: an item still listed keeps the key, as a remove refused because the keyring is locked.
   */
  async _secretToolDel(id, name) {
    const bin = this._secretTool();
    if (!bin) throw this._keyringError('remove', 'no-program', null);
    const acct = account(id, name);
    const res = await this._run(bin, ['clear', 'service', SERVICE, 'account', acct], '', SECRET_TOOL_TIMEOUT_MS);
    if (res.code === 0) return;
    const listed = await this._secretToolListed(bin, acct);
    if (listed === false) return;
    const silent = !res.error && !res.timedOut && !String(res.stderr || '').trim();
    throw this._keyringError('remove', listed && silent ? 'locked' : secretToolTrouble(res), res, bin);
  }

  /**
   * Whether the keyring still holds this item, from `secret-tool search --all` (never --unlock: it lists items without
   * unlocking them): true when it lists one, false when it lists none and says nothing, null when it could not tell.
   * It prints an unlocked item's value, so what it says is only looked at here, never kept, logged or shown.
   */
  async _secretToolListed(bin, acct) {
    const res = await this._run(bin, ['search', '--all', 'service', SERVICE, 'account', acct], '', SECRET_TOOL_TIMEOUT_MS);
    if (res.error || res.timedOut) return null;
    if (/^\[[^\]\n]+\]$/m.test(String(res.stdout || ''))) return true;
    return String(res.stderr || '').trim() ? null : false;
  }

  // --------------------------------------------------------------- private files

  _valuesFile(id) {
    if (!ID_RE.test(id)) throw keyError('store', 'Workbench refused a key whose name it could not trust.');
    return path.join(this.valuesDir, `${id}.json`);
  }

  _filePut(id, vars) {
    try {
      privateDir(this.dir, { allowLink: true });
      privateDir(this.valuesDir);
      writeAtomic(this._valuesFile(id), JSON.stringify({ version: VERSION, values: Object.fromEntries(vars.map(v => [v.name, v.value])) }) + '\n');
    } catch (err) {
      throw err.why ? err : keyError('store', `Workbench could not save the key in ${this.valuesDir}.`, err.code || null);
    }
  }

  /** One key's values from its file: Map(name → value), or { missing } with the reason. */
  _fileGet(id) {
    let text;
    try {
      if (!privateDir(this.valuesDir, { create: false })) return { missing: 'not-found' };
      text = readPrivateFile(this._valuesFile(id), { secret: true });
    } catch (err) {
      return { missing: err.code || 'unreadable' };
    }
    if (text == null) return { missing: 'not-found' };
    try {
      const values = JSON.parse(text).values;
      const out = new Map();
      for (const [name, value] of Object.entries(values || {})) if (typeof value === 'string' && value) out.set(name, value);
      return out;
    } catch {
      return { missing: 'damaged' };
    }
  }

  _fileDel(id) {
    try {
      fs.rmSync(this._valuesFile(id), { force: true });
    } catch (err) {
      throw keyError('store', `Workbench could not remove the key from ${this.valuesDir}.`, err.code || null);
    }
  }

  // --------------------------------------------------------------- reading values

  /**
   * Read the values of these records into memory. One value per process for the keychain and the keyring: the first
   * alone (a locked keychain then asks once), the rest a few at a time; a store that cannot be opened is not asked
   * again. What could not be read is said once per store and reason, by name, never by value.
   */
  async _readValues(records) {
    const jobs = new Map(); // where → [{ rec, name, vals }]
    for (const rec of records) {
      const vals = new Map();
      this._cache.set(rec.id, vals);
      if (rec.kept === 'file') {
        const got = this._fileGet(rec.id);
        for (const v of rec.vars) vals.set(v.name, got instanceof Map ? (got.has(v.name) ? { value: got.get(v.name) } : { missing: 'not-found' }) : got);
        continue;
      }
      if (!jobs.has(rec.kept)) jobs.set(rec.kept, []);
      for (const v of rec.vars) jobs.get(rec.kept).push({ rec, name: v.name, vals });
    }
    for (const [where, list] of jobs) {
      let stopped = null;
      const readOne = async (job) => {
        const got = stopped ? { missing: stopped }
          : where === 'keychain' ? await this._keychainGet(job.rec.id, job.name) : await this._secretToolGet(job.rec.id, job.name);
        job.vals.set(job.name, got);
        if (got.missing && STOPPERS.has(got.missing)) stopped = stopped || got.missing;
      };
      await readOne(list[0]);
      let next = 1;
      const worker = async () => { while (next < list.length) await readOne(list[next++]); };
      await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, list.length - 1) }, worker));
    }
    // Say what could not be read.
    const unread = new Map(); // "where\0reason" → names
    for (const rec of records) {
      for (const [name, got] of this._cache.get(rec.id)) {
        if ('value' in got) continue;
        const k = `${rec.kept}\0${got.missing}`;
        if (!unread.has(k)) unread.set(k, []);
        unread.get(k).push(name);
      }
    }
    for (const [k, names] of unread) {
      const [where, reason] = k.split('\0');
      const them = names.length === 1 ? 'it' : 'them';
      if (where === 'file') {
        this._warn(`Workbench could not read ${listed(names)} from its private files in ${this.valuesDir}, because ${fileReason(reason)}, so agents will not get ${them}.`);
      } else {
        const bin = where === 'keychain' ? this.securityBin : this._secretTool() || 'secret-tool';
        const store = where === 'keychain' ? 'your keychain' : 'your keyring';
        this._warn(`Workbench could not read ${listed(names)} from ${store}, because ${because(where, reason, bin)}, so agents will not get ${them}.`);
      }
    }
  }
}

function tooMany() {
  return keyError('too-many', `Workbench keeps at most ${MAX_KEYS} keys. Remove one you no longer use, then add this one.`);
}
