// Builds the command line and environment for launching Claude Code as a workbench agent, and finds Claude Code.
// The flags below match what was verified with Claude Code 2.1.221 in real runs; Claude Code 2.1.322 still lists
// every one of them in --help and parses the whole launch (see ARCHITECTURE.md, "Claude Code adapter").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Appended to Claude Code's system prompt for every workbench agent. */
export const WORKBENCH_PROMPT = 'You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did. When you use git, run one git command at a time, with no && or ; and no heredoc. Give a commit message as plain text after -m, with one -m for each paragraph, and keep backticks and the characters ( ) $ < > | & ; { } \\ out of it, since they make the command wait for the person to allow it.';

/**
 * Tools a workbench agent may not use: they schedule work outside the workbench's view, wait for a terminal,
 * need the person to sign in to another service (DesignSync, which cannot finish in a headless run), or reach past
 * this agent. CronList goes with CronCreate and CronDelete. New in Claude Code 2.1.322: SendFile sends files to
 * another Claude Code session, on this machine or another one; SendToProject sends the session's work to a Claude
 * Project on claude.ai; PublishPlugin publishes a folder to the organisation's plugin library; ListAgents lists the
 * person's other sessions; WrapUp draws a next-step box in the app and is told to run in every turn.
 */
export const DISALLOWED_TOOLS = 'Workflow CronCreate CronDelete CronList ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger DesignSync SendFile SendToProject PublishPlugin ListAgents WrapUp';

/** How long Claude Code waits for the PreToolUse hook, in seconds. The engine may hold a request for 25 minutes. */
export const HOOK_TIMEOUT_SEC = 1800;

/** Spending limit per agent when none is given, in US dollars. */
export const DEFAULT_BUDGET_USD = 2;

/**
 * Environment keys removed before launch:
 * - the markers a Claude Code session, or an editor or SDK hosting one, sets for the programs it runs. Passed on,
 *   they would tie the agent to that session (its id, its messaging socket). Claude Code's docs list the session
 *   markers (code.claude.com/docs/en/env-vars); the host ones were seen in an editor session;
 * - the editor's own (VSCODE_*, ELECTRON_RUN_AS_NODE, GIT_EDITOR), present when Workbench was started from VS Code
 *   or from Claude Code inside it: they are a handle on the editor's connection, and change how programs start;
 * - Workbench's own choice of programs (WORKBENCH_CLAUDE_BIN, WORKBENCH_CODEX_BIN), so a Workbench an agent starts
 *   does not inherit them.
 * Everything else is kept, including the person's own settings and credentials (CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CODE_USE_BEDROCK, ...): on a cloud machine the token may be the only login.
 */
export const SCRUB_ENV_RE = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_JOB_DIR|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_(CHILD_SESSION|SESSION_.*|BRIDGE_SESSION_ID|MESSAGING_.*|REMOTE|REMOTE_.*|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|ENABLE_SDK_FILE_CHECKPOINTING|ENABLE_TASKS|QUESTION_PREVIEW_FORMAT|STARTUP_FAILURE_RESULTS)|VSCODE_.*|ELECTRON_RUN_AS_NODE|GIT_EDITOR|WORKBENCH_CLAUDE_BIN|WORKBENCH_CODEX_BIN)$/;

/** The hook bridge script that Claude Code runs before each tool call. */
export const BRIDGE_PATH = fileURLToPath(new URL('./hook-bridge.mjs', import.meta.url));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;

/** Where VS Code, VS Code Insiders and Cursor keep their extensions, inside the home folder. */
export const EXTENSION_FOLDERS = ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions'];
/** The Claude Code extension's folder: anthropic.claude-code-<version>[-<platform>-<arch>]. */
const EXTENSION_RE = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(?:-([a-z0-9]+)-([a-z0-9]+))?$/;
/** The Claude Code program inside that folder. */
const EXTENSION_BINARY = path.join('resources', 'native-binary', 'claude');
/** The PATH a shell uses when none is set. */
const DEFAULT_PATH = '/usr/bin:/bin';

/** Said when no Claude Code was found anywhere Workbench looks. */
export const CLAUDE_NOT_FOUND = 'Claude Code was not found: there is no claude command on the PATH, and no Claude Code extension in VS Code or Cursor. Tell Workbench where it is with --claude <path>, or with WORKBENCH_CLAUDE_BIN.';

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `name` that is a program in one of the PATH's folders, as an absolute path, or null. Folders written as
 * relative paths are skipped: a program started in an agent's folder would look for them there.
 */
export function onPath(name, pathValue) {
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * The environment with the folder of the node running Workbench at the front of PATH when PATH has no node, so
 * agents find `node` and `npm` for their tests (the permission check approves `npm test` and `node --test` by those
 * words). Returned unchanged when a node is on PATH already.
 * @param {Record<string,string>} env
 */
export function withNodeOnPath(env, execPath = process.execPath) {
  const current = typeof env.PATH === 'string' ? env.PATH : '';
  if (onPath('node', current)) return env;
  return { ...env, PATH: `${path.dirname(execPath)}${path.delimiter}${current || DEFAULT_PATH}` };
}

const newerThan = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The newest Claude Code that the VS Code extension installed, in VS Code, VS Code Insiders or Cursor: its program
 * and version, or null. Folders VS Code has marked to delete (listed in .obsolete) and builds for another operating
 * system are skipped. On the same version, a build for this processor wins, then (on Linux) a build for the usual
 * Linux over one for Alpine's.
 */
export function newestExtensionClaude(home) {
  if (!home || !path.isAbsolute(home)) return null;
  let best = null;
  for (const folder of EXTENSION_FOLDERS) {
    const dir = path.join(home, folder);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    let obsolete = {};
    try { obsolete = JSON.parse(fs.readFileSync(path.join(dir, '.obsolete'), 'utf8')) || {}; } catch { /* none */ }
    for (const name of names) {
      const m = EXTENSION_RE.exec(name);
      if (!m || obsolete[name] === true) continue;
      const system = m[4] === 'alpine' ? 'linux' : m[4];
      if (system && system !== process.platform) continue;
      const bin = path.join(dir, name, EXTENSION_BINARY);
      if (!isExecutableFile(bin)) continue;
      const version = [Number(m[1]), Number(m[2]), Number(m[3])];
      const fit = (!m[5] || m[5] === process.arch ? 2 : 0) + (m[4] === 'alpine' ? 0 : 1);
      const order = best ? newerThan(version, best.version) || fit - best.fit : 1;
      if (order > 0) best = { path: bin, version, fit };
    }
  }
  return best && { path: best.path, version: best.version.join('.') };
}

/**
 * Where Claude Code is, looked up afresh on every call (the VS Code extension moves to a new folder with each
 * update). In this order: the --claude path (`flag`), WORKBENCH_CLAUDE_BIN (`env`), `claude` on the PATH (`path`),
 * then the newest Claude Code extension in VS Code, VS Code Insiders or Cursor (`vscode`). A path that was given but
 * is not there is reported as it is, never swapped for another Claude Code. A bare name is looked up on the PATH. A
 * relative path is read from `cwd`, the folder Workbench was started in, which every caller passes: never from the
 * working folder of the moment, which the file view changes for a moment (src/core/files.mjs). Without an absolute
 * `cwd`, a relative path is refused in plain words.
 * @param {{ flag?: string|null, env?: Record<string,string|undefined>, cwd?: string|null }} [o]
 * @returns {{ path: string|null, from: 'flag'|'env'|'path'|'vscode'|null, reason?: string }}
 *   `reason`, a plain sentence, is there when no usable Claude Code was found; `path` then says what was tried
 */
export function findClaude({ flag, env = process.env, cwd = null } = {}) {
  const e = env || {};
  const home = e.HOME || (env === process.env ? os.homedir() : '');
  const given = (value, from) => {
    const where = from === 'flag' ? 'given with --claude' : 'in WORKBENCH_CLAUDE_BIN';
    let v = value.trim();
    if (!v.includes('/')) {
      const found = onPath(v, e.PATH);
      return found ? { path: found, from } : { path: null, from, reason: `There is no ${v} command on the PATH (the name ${where}).` };
    }
    if ((v === '~' || v.startsWith('~/')) && home) v = path.join(home, v.slice(1));
    if (!path.isAbsolute(v) && !(typeof cwd === 'string' && path.isAbsolute(cwd))) {
      return { path: null, from, reason: `Workbench cannot tell where ${v} is: the path ${where} must start with / or ~.` };
    }
    const p = path.resolve(path.isAbsolute(v) ? '/' : cwd, v);
    let st = null;
    try { st = fs.statSync(p); } catch { /* not there */ }
    if (!st) return { path: p, from, reason: `Claude Code is not at ${p}, the path ${where}.` };
    if (st.isDirectory()) return { path: p, from, reason: `The path ${where}, ${p}, is a folder, not the Claude Code program.` };
    return { path: p, from };
  };
  if (typeof flag === 'string' && flag.trim()) return given(flag, 'flag');
  if (typeof e.WORKBENCH_CLAUDE_BIN === 'string' && e.WORKBENCH_CLAUDE_BIN.trim()) return given(e.WORKBENCH_CLAUDE_BIN, 'env');
  const found = onPath('claude', e.PATH);
  if (found) return { path: found, from: 'path' };
  const ext = newestExtensionClaude(home);
  if (ext) return { path: ext.path, from: 'vscode' };
  return { path: null, from: null, reason: CLAUDE_NOT_FOUND };
}

/** The Claude Code program to start: what findClaude finds (a relative path read from `cwd`), or `claude` when it finds nothing. */
export function claudeBin(env = process.env, { flag, cwd = null } = {}) {
  return findClaude({ flag, env, cwd }).path || 'claude';
}

/** Quote one word for a POSIX shell. Claude Code runs hook commands through a shell. */
export function shellQuote(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook command line: node running the bridge, every word quoted. It starts through `env -u NODE_OPTIONS`:
 * Claude Code takes the hook's environment from settings files, and a NODE_OPTIONS planted there (or by code the
 * agent ran) could load a script into node that answers "allow" without asking the engine.
 */
export function hookCommand({ nodePath = process.execPath, bridgePath = BRIDGE_PATH } = {}) {
  return ['/usr/bin/env', '-u', 'NODE_OPTIONS', nodePath, bridgePath].map(shellQuote).join(' ');
}

/**
 * The --settings JSON: one PreToolUse hook for every tool. disableAllHooks is pinned to false: settings given on the
 * command line outrank the repository's own, so no settings file can switch the workbench's check off. The same goes
 * for the bridge's address and agent id: they are also in `env` here, so an `env` block in a committed
 * .claude/settings.json cannot point the bridge elsewhere. The hook key is not (argv is public): it stays in the
 * process environment only.
 */
export function hookSettings({ nodePath, bridgePath, url, agentId } = {}) {
  const env = {};
  if (url) env.WORKBENCH_HOOK_URL = String(url);
  if (agentId) env.WORKBENCH_AGENT_ID = String(agentId);
  return {
    disableAllHooks: false,
    ...(Object.keys(env).length ? { env } : {}),
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: hookCommand({ nodePath, bridgePath }), timeout: HOOK_TIMEOUT_SEC }],
        },
      ],
    },
  };
}

/** A copy of `base` without the keys matching SCRUB_ENV_RE (and without unset values). */
export function scrubEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined || SCRUB_ENV_RE.test(k)) continue;
    env[k] = String(v);
  }
  return env;
}

/** A variable name a key may use: letters, digits and _, not starting with a digit. */
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * A copy of `env` with the person's keys for this agent added (`keysEnv`: { NAME: value }, from the key store). Every
 * adapter adds them after its scrub and before the WORKBENCH_* variables, so no key can replace the hook's address,
 * its key or the agent's id. A key is left out when its name is not a variable name, is one of Workbench's own
 * (WORKBENCH_*), or is one the scrub removes (`refused(name)`), or when its value is not a string or holds a NUL.
 * Returned unchanged when there are no keys.
 * @param {Record<string,string>} env
 * @param {Record<string,string>|null|undefined} keysEnv
 * @param {(name: string) => boolean} [refused]
 */
export function withKeys(env, keysEnv, refused = (k) => SCRUB_ENV_RE.test(k)) {
  if (!keysEnv || typeof keysEnv !== 'object') return env;
  let out = env;
  for (const [k, v] of Object.entries(keysEnv)) {
    if (!KEY_NAME_RE.test(k) || k.startsWith('WORKBENCH_') || refused(k) || typeof v !== 'string' || v.includes('\0')) continue;
    if (out === env) out = { ...env };
    out[k] = v;
  }
  return out;
}

/** How far before a kept tail of output a key may begin: keys are at most 2000 characters. */
export const MASK_MARGIN = 2048;

/** A mask (text -> text) that never throws and always gives a string; the identity when none is given. */
export function safeMask(mask) {
  if (typeof mask !== 'function') return (s) => s;
  return (s) => {
    const text = typeof s === 'string' ? s : String(s ?? '');
    try {
      const out = mask(text);
      return typeof out === 'string' ? out : text;
    } catch {
      return text;
    }
  };
}

/**
 * Where an agent's output names things rather than says them: the fields that the parser reads back as kinds and ids
 * (`keep`), at each level of a line it walks into (`inside`, by field; `each`: every item of a list there), and
 * `toolName`: a tool call's name, on a block whose type ends in tool_use. See maskParsed.
 * @typedef {{ keep?: Set<string>, inside?: Record<string, OutputFormat>, each?: boolean, toolName?: boolean }} OutputFormat
 */

/**
 * Claude Code's stream-json format: a line's own fields (its type and subtype, the session's and the task's ids, a
 * task's status, the model of system/init), its message's (id, type, role, model, stop_reason), and each block of that
 * message's content (type, id, tool_use_id, and a tool call's name). Nothing below a tool's input, a tool result's
 * content or tool_use_result: those hold what the agent and its tools wrote, whatever their fields are called.
 * @type {OutputFormat}
 */
export const CLAUDE_FORMAT = Object.freeze({
  keep: new Set(['type', 'subtype', 'uuid', 'session_id', 'parent_tool_use_id', 'tool_use_id', 'task_id', 'task_type', 'status', 'last_tool_name', 'model']),
  inside: {
    message: {
      keep: new Set(['id', 'type', 'role', 'model', 'stop_reason']),
      inside: { content: { each: true, keep: new Set(['id', 'type', 'tool_use_id']), toolName: true } },
    },
  },
});

/**
 * Hide the person's keys in output read as JSON, in place: every string of 8 or more characters (no key is shorter)
 * goes through `mask`. Done before the parser reads the output, so a key the parser or narrate() later cuts short is
 * never shown in part. With `format`, the format's own words are left as they are (see OutputFormat), so a hidden
 * value that happens to be one of them (a copied .env's CHAT_ROLE=assistant, a model's name) cannot change how a line
 * reads: `{"type":"assistant"}` stays a message of the agent's. Those fields are written by the agent's program, not by
 * the agent or its tools, so no key reaches them.
 * @param {unknown} value  freshly parsed JSON
 * @param {(s: string) => string} mask
 * @param {OutputFormat|null} [format]
 * @returns {unknown} the value, with its strings masked (a string is returned masked)
 */
export function maskParsed(value, mask, format = null, depth = 0) {
  if (typeof value === 'string') return value.length >= 8 ? mask(value) : value;
  if (!value || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) {
    const each = format?.each ? format : null;
    for (let i = 0; i < value.length; i++) value[i] = maskParsed(value[i], mask, each, depth + 1);
    return value;
  }
  for (const k of Object.keys(value)) {
    if (format && typeof value[k] === 'string' && (format.keep?.has(k)
      || (k === 'name' && format.toolName && typeof value.type === 'string' && value.type.endsWith('tool_use')))) continue;
    const inner = format?.inside && Object.hasOwn(format.inside, k) ? format.inside[k] : null;
    value[k] = maskParsed(value[k], mask, inner, depth + 1);
  }
  return value;
}

/**
 * `raw`, the kept end of some output, with the person's keys hidden. When earlier output was dropped (`truncated`),
 * `raw` may begin inside a key that was cut, which no mask can find, so its start is left out: up to its first line
 * break (a key holds none), or MASK_MARGIN characters when there is none that near (a cut key is shorter), but never
 * past where the mask first hid something, since a whole key began there. receipt.mjs keeps a copy for the checks.
 */
export function maskCut(raw, mask, truncated) {
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
 * The last `limit` characters of output with the person's keys hidden. `raw` is the end of the output, kept with
 * MASK_MARGIN characters to spare, so a key that reaches into what is shown is whole when it is masked; `truncated`:
 * earlier output was dropped (see maskCut).
 */
export function maskedTail(raw, { truncated = false, limit, mask }) {
  const text = maskCut(String(raw ?? ''), mask, truncated);
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * Claude Code's own folders for one session, which its agent may read without asking (the policy's readAlso):
 * long tool results under <config dir>/projects/<key>/<session id>/, and background task output under
 * <temp dir>/claude-<uid>/<key>/<session id>/. Each entry is { root, session }, so only this session's folder counts:
 * the key folder is shared with the person's other sessions. Nothing when the session id is not a UUID.
 * @param {{ sessionId: string|null, env?: Record<string,string|undefined>, uid?: number }} o
 *   env is the environment Claude Code was started with (CLAUDE_CONFIG_DIR, CLAUDE_CODE_TMPDIR, HOME)
 * @returns {{ root: string, session: string }[]}
 */
export function sessionFolders({ sessionId, env = process.env, uid = process.getuid?.() } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return [];
  const e = env || {};
  const out = [];
  const config = e.CLAUDE_CONFIG_DIR || path.join(e.HOME || os.homedir(), '.claude');
  if (path.isAbsolute(config)) out.push({ root: path.join(config, 'projects'), session: sessionId });
  if (Number.isInteger(uid)) {
    let tmp = e.CLAUDE_CODE_TMPDIR || '/tmp';
    try { tmp = fs.realpathSync.native(tmp); } catch { /* not there yet: the policy resolves it when it is */ }
    if (path.isAbsolute(tmp)) out.push({ root: path.join(tmp, `claude-${uid}`), session: sessionId });
  }
  return out;
}

/**
 * Does Claude Code still have this session's conversation? It keeps one <session id>.jsonl under
 * <config dir>/projects/<key>/. Returns true or false; null when it cannot tell (no projects folder, an id that is no UUID),
 * so a layout Workbench does not know never blocks a resume.
 * @param {{ sessionId: string|null, env?: Record<string,string|undefined> }} o
 */
export function sessionExists({ sessionId, env = process.env } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;
  const e = env || {};
  const config = e.CLAUDE_CONFIG_DIR || path.join(e.HOME || os.homedir(), '.claude');
  if (!path.isAbsolute(config)) return null;
  const projects = path.join(config, 'projects');
  let keys;
  try { keys = fs.readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  for (const k of keys) {
    if (k.isDirectory() && fs.existsSync(path.join(projects, k.name, `${sessionId}.jsonl`))) return true;
  }
  return false;
}

/** A session name Claude Code cannot mistake for a flag: no leading dashes, no control characters. */
function safeName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s-]+/, '').trim();
  return (n || 'Workbench agent').slice(0, 80);
}

/** Dollars as a short decimal string ("2", "0.5"); at least a hundredth of a cent. */
function budgetArg(usd) {
  const rounded = Math.max(0.0001, Math.round(usd * 10000) / 10000);
  return String(rounded);
}

/**
 * Build the launch for one Claude Code process.
 * @param {object} o
 * @param {string} o.name            agent name, shown by Claude Code as the session name
 * @param {string} [o.model]
 * @param {number} [o.budgetUsd]     spending limit for this process (default 2)
 * @param {string} [o.sessionId]     new session id (a UUID); made up when neither id is given
 * @param {string} [o.resumeSessionId] resume this session instead: `--resume <id>` and no `--session-id`
 * @param {{ url: string, token: string }} o.hook  where the hook bridge sends permission requests
 * @param {string} o.agentId         workbench id of the root agent
 * @param {string} [o.bridgePath]    hook bridge script (default: hook-bridge.mjs next to this file)
 * @param {string} [o.nodePath]      node binary for the hook (default: the running node)
 * @param {object} [o.env]           base environment (default: process.env)
 * @param {object} [o.keysEnv]       the person's keys for this agent ({ NAME: value }): added after the scrub and before
 *                                   the WORKBENCH_* variables (see withKeys). Never in argv or --settings.
 * @param {string} [o.bin]           the Claude Code program (default: what findClaude finds in `env`, else `claude`)
 * @returns {{ bin: string, args: string[], env: Record<string,string>, sessionId: string, resume: boolean }}
 */
export function buildClaudeLaunch(o = {}) {
  const { name, model, budgetUsd, sessionId, resumeSessionId, hook, agentId, bridgePath, nodePath } = o;
  const base = o.env || process.env;

  if (!hook || typeof hook.url !== 'string' || !hook.url || typeof hook.token !== 'string' || !hook.token) {
    throw new Error('The workbench permission check is not set up, so Claude Code cannot be started safely.');
  }
  if (!agentId) throw new Error('Claude Code cannot be started without an agent id.');

  const budget = budgetUsd == null ? DEFAULT_BUDGET_USD : Number(budgetUsd);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('The spending limit must be a positive number of dollars.');
  }
  if (model != null && model !== '' && !MODEL_RE.test(String(model))) {
    throw new Error('That model name does not look right.');
  }

  const resume = !!resumeSessionId;
  const session = resume ? String(resumeSessionId) : String(sessionId || randomUUID());
  if (resume ? !SESSION_RE.test(session) : !UUID_RE.test(session)) {
    throw new Error('The Claude Code session id does not look right.');
  }

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--forward-subagent-text',
    // The repository's committed .claude settings only: not .claude/settings.local.json, which is the person's own
    // (and, in a worktree, is read from the person's main checkout).
    '--setting-sources', 'project',
    // A defaultMode in a settings file cannot turn off Claude Code's own refusal to change protected files.
    // The --help of 2.1.221 and of 2.1.323 lists "manual" for it; both still accept "default", the name "manual"
    // stands for (checked against both programs' option parsers).
    '--permission-mode', 'default',
    '--strict-mcp-config',
    '--disallowedTools', DISALLOWED_TOOLS,
    '--settings', JSON.stringify(hookSettings({ nodePath, bridgePath, url: hook.url, agentId })),
    '--append-system-prompt', WORKBENCH_PROMPT,
    '--max-budget-usd', budgetArg(budget),
    ...(resume ? ['--resume', session] : ['--session-id', session]),
    '--name', safeName(name),
  ];
  if (model) args.push('--model', String(model));

  // The person's keys after the scrub, and Workbench's own variables last: no key can replace them.
  const env = withKeys(withNodeOnPath(scrubEnv(base)), o.keysEnv);
  env.WORKBENCH_HOOK_URL = hook.url;
  env.WORKBENCH_HOOK_TOKEN = hook.token;
  env.WORKBENCH_AGENT_ID = String(agentId);

  return { bin: o.bin || claudeBin(base), args, env, sessionId: session, resume };
}

/** One message for Claude Code's stdin (stream-json input), including the trailing newline. */
export function userMessage(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] } }) + '\n';
}
