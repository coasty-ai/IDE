// Builds the command line and environment for launching Claude Code as a workbench agent.
// The flags below match what was verified with Claude Code 2.1.221 (see ARCHITECTURE.md, "Claude Code adapter").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Appended to Claude Code's system prompt for every workbench agent. */
export const WORKBENCH_PROMPT = 'You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did.';

/**
 * Tools a workbench agent may not use: they schedule work outside the workbench's view, wait for a terminal,
 * or need the person to sign in to another service (DesignSync, which cannot finish in a headless run).
 * CronList goes with CronCreate and CronDelete.
 */
export const DISALLOWED_TOOLS = 'Workflow CronCreate CronDelete CronList ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger DesignSync';

/** How long Claude Code waits for the PreToolUse hook, in seconds. The engine may hold a request for 25 minutes. */
export const HOOK_TIMEOUT_SEC = 1800;

/** Spending limit per agent when none is given, in US dollars. */
export const DEFAULT_BUDGET_USD = 2;

/**
 * Environment keys removed before launch: the markers a Claude Code session, or an editor or SDK hosting one, sets
 * for the programs it runs. Passed on, they would tie the agent to that session (its id, its messaging socket, the
 * editor connection). Claude Code's docs list the session markers (code.claude.com/docs/en/env-vars); the host ones
 * were seen in an editor session. Everything else is kept, including the person's own settings and credentials
 * (CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_USE_BEDROCK, ...): on a cloud machine the token may be the only login.
 */
export const SCRUB_ENV_RE = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_JOB_DIR|CLAUDE_AGENT_SDK_.*|CLAUDE_CODE_(CHILD_SESSION|SESSION_.*|BRIDGE_SESSION_ID|MESSAGING_.*|REMOTE|REMOTE_.*|ENTRYPOINT|EXECPATH|SSE_PORT|EMIT_STARTUP_TIMING|ENABLE_SDK_FILE_CHECKPOINTING|ENABLE_TASKS|QUESTION_PREVIEW_FORMAT|STARTUP_FAILURE_RESULTS))$/;

/** The hook bridge script that Claude Code runs before each tool call. */
export const BRIDGE_PATH = fileURLToPath(new URL('./hook-bridge.mjs', import.meta.url));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;

/** The Claude Code binary: WORKBENCH_CLAUDE_BIN when set (tests point it at a fake), otherwise `claude`. */
export function claudeBin(env = process.env) {
  return (env && env.WORKBENCH_CLAUDE_BIN) || 'claude';
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

  const env = scrubEnv(base);
  env.WORKBENCH_HOOK_URL = hook.url;
  env.WORKBENCH_HOOK_TOKEN = hook.token;
  env.WORKBENCH_AGENT_ID = String(agentId);

  return { bin: claudeBin(base), args, env, sessionId: session, resume };
}

/** One message for Claude Code's stdin (stream-json input), including the trailing newline. */
export function userMessage(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] } }) + '\n';
}
