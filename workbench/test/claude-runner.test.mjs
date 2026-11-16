import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRunner, createClaudeRunner, available, harness, createLineSplitter, STOP_GRACE_MS, STDERR_TAIL_CHARS,
} from '../src/adapters/claude/runner.mjs';
import {
  buildClaudeLaunch, userMessage, shellQuote, hookCommand, hookSettings, scrubEnv, sessionFolders, findClaude, claudeBin,
  newestExtensionClaude, onPath, withNodeOnPath, WORKBENCH_PROMPT, DISALLOWED_TOOLS, BRIDGE_PATH, DEFAULT_BUDGET_USD,
  CLAUDE_NOT_FOUND, EXTENSION_FOLDERS, withKeys, safeMask, maskParsed, maskCut, maskedTail, MASK_MARGIN, CLAUDE_FORMAT,
} from '../src/adapters/claude/args.mjs';
import { EV } from '../src/shared/events.mjs';
import { maskSecrets } from '../src/shared/mask.mjs';

const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const WORKBENCH = fileURLToPath(new URL('..', import.meta.url)); // the agent's folder in these tests
const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', token: 'tok-123' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NODE_DIR = path.dirname(process.execPath);
/** The tools every launch turns off: the eleven verified with 2.1.221, and five new in 2.1.322. */
const OFF = 'Workflow CronCreate CronDelete CronList ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger DesignSync SendFile SendToProject PublishPlugin ListAgents WrapUp';

/** A temporary folder for one test, removed afterwards. */
function scratch(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-claude-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A program file: a shell script, executable unless `exec` is false. */
function program(file, body = 'exit 0', { exec = true } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: exec ? 0o755 : 0o644 });
  return file;
}

/**
 * A Claude Code extension folder under `home`, in VS Code (`.vscode/extensions`) or another editor's folder, whose
 * program answers --version with `version` and otherwise runs the stand-in. `log`: each start writes the version there.
 */
function extension(home, version, { folder = '.vscode/extensions', suffix = `-${process.platform}-${process.arch}`, log = null, exec = true } = {}) {
  const dir = path.join(home, folder, `anthropic.claude-code-${version}${suffix}`);
  const bin = path.join(dir, 'resources', 'native-binary', 'claude');
  const note = log ? `echo ${shellQuote(version)} >> ${shellQuote(log)}\n` : '';
  program(bin, `if [ "$1" = "--version" ]; then echo ${shellQuote(`${version} (Claude Code)`)}; exit 0; fi\n${note}FAKE_CLAUDE_VERSION=${shellQuote(version)}\nexport FAKE_CLAUDE_VERSION\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE)} "$@"`, { exec });
  return { dir, bin };
}

before(() => chmodSync(FAKE, 0o755));

// Every runner a test makes is stopped afterwards, even when the test fails, so no fake is left running.
const runners = new Set();
afterEach(async () => {
  for (const r of runners) await r.stop().catch(() => {});
  runners.clear();
});

/** Environment for the fake, with variables a launched agent must not see (the runner must remove them). */
function fakeEnv(extra = {}) {
  return { ...process.env, WORKBENCH_CLAUDE_BIN: FAKE, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '9', ...extra };
}

/** Collects events and waits for conditions on them. */
function collector() {
  const events = [];
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const hit = w.cond(events);
      if (hit) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(hit); }
    }
  };
  return {
    events,
    emit(e) { events.push(e); check(); },
    until(cond, what = 'a condition', ms = 15000) {
      const hit = cond(events);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { cond, resolve };
        w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${what}`)); }, ms);
        waiters.push(w);
      });
    },
    turnEnds() { return events.filter((e) => e.kind === EV.TURN && e.phase === 'end'); },
  };
}

const replyIs = (re) => (evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end' && re.test(e.finalText));

function makeRunner(c, { env = {}, task = 'Say hello', ...opts } = {}) {
  const r = createRunner({
    agentId: 'abc123', name: 'Test agent', task, cwd: WORKBENCH, budgetUsd: 1,
    emit: c.emit, hook: HOOK, log: () => {}, env: fakeEnv(env), killGraceMs: 500, ...opts,
  });
  runners.add(r);
  return r;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !processAlive(pid);
}

// ---------- args.mjs ----------

test('buildClaudeLaunch builds the verified command line', () => {
  const sid = '0bdffedf-c0cd-41ae-8bb3-6183f7e1be41';
  const l = buildClaudeLaunch({
    name: 'Fix login', model: 'claude-haiku-4-5', budgetUsd: 2, sessionId: sid, hook: HOOK, agentId: 'abc123',
    bridgePath: '/opt/work bench/hook-bridge.mjs', nodePath: '/usr/local/bin/node', env: { PATH: '/bin', WORKBENCH_CLAUDE_BIN: '/x/fake' },
  });
  assert.equal(l.bin, '/x/fake');
  const settings = JSON.stringify({
    disableAllHooks: false,
    env: { WORKBENCH_HOOK_URL: HOOK.url, WORKBENCH_AGENT_ID: 'abc123' },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "'/usr/bin/env' '-u' 'NODE_OPTIONS' '/usr/local/bin/node' '/opt/work bench/hook-bridge.mjs'", timeout: 1800 }] }] },
  });
  assert.deepEqual(l.args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--forward-subagent-text',
    '--setting-sources', 'project', '--permission-mode', 'default', '--strict-mcp-config',
    '--disallowedTools', OFF,
    '--settings', settings,
    '--append-system-prompt', WORKBENCH_PROMPT,
    '--max-budget-usd', '2', '--session-id', sid, '--name', 'Fix login', '--model', 'claude-haiku-4-5',
  ]);
  assert.equal(l.sessionId, sid);
  assert.equal(l.resume, false);
  assert.equal(WORKBENCH_PROMPT, 'You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did. When you use git, run one git command at a time, with no && or ; and no heredoc. Give a commit message as plain text after -m, with one -m for each paragraph, and keep backticks and the characters ( ) $ < > | & ; { } \\ out of it, since they make the command wait for the person to allow it.');
  assert.equal(DISALLOWED_TOOLS, OFF);
  assert.equal(DISALLOWED_TOOLS.split(' ').length, 16);
  // Claude Code 2.1.322's new tools reach past the agent: other sessions, claude.ai, the plugin library, the app.
  for (const tool of ['DesignSync', 'CronList', 'SendFile', 'SendToProject', 'PublishPlugin', 'ListAgents', 'WrapUp']) {
    assert.ok(DISALLOWED_TOOLS.split(' ').includes(tool), tool);
  }
  // The program can be given; then it is used as it is.
  assert.equal(buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, bin: '/opt/claude' }).bin, '/opt/claude');
});

test('repository settings cannot switch the workbench hook off, or loosen Claude Code\'s own checks', () => {
  for (const l of [
    buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {} }),
    buildClaudeLaunch({ name: 'A', resumeSessionId: 'sess-9', hook: HOOK, agentId: 'abc123', env: {} }),
  ]) {
    const at = (flag) => l.args[l.args.indexOf(flag) + 1];
    // Only the repository's committed settings: not the person's own .claude/settings.local.json.
    assert.equal(at('--setting-sources'), 'project');
    assert.ok(!l.args.includes('project,local'));
    // No settings file can pick bypassPermissions as the mode.
    assert.equal(at('--permission-mode'), 'default');
    // Settings on the command line outrank the repository's, so disableAllHooks: true there changes nothing.
    const settings = JSON.parse(at('--settings'));
    assert.equal(settings.disableAllHooks, false);
    assert.deepEqual(Object.keys(settings), ['disableAllHooks', 'env', 'hooks']);
    // The bridge's address and agent id are pinned too: an env block in the repository's settings cannot redirect it.
    assert.deepEqual(settings.env, { WORKBENCH_HOOK_URL: HOOK.url, WORKBENCH_AGENT_ID: 'abc123' });
    // The key is only in the process environment, never in argv.
    assert.ok(!JSON.stringify(l.args).includes(HOOK.token));
    assert.equal(l.env.WORKBENCH_HOOK_TOKEN, HOOK.token);
    assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse'], 'the bridge is registered for tool calls only');
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /^'\/usr\/bin\/env' '-u' 'NODE_OPTIONS' /);
  }
});

test('buildClaudeLaunch: resume, defaults and refusals', () => {
  const r = buildClaudeLaunch({ name: '--force push', resumeSessionId: 'sess-9', hook: HOOK, agentId: 'abc123', env: {} });
  assert.equal(r.bin, 'claude');
  assert.ok(r.args.includes('--resume'));
  assert.equal(r.args[r.args.indexOf('--resume') + 1], 'sess-9');
  assert.ok(!r.args.includes('--session-id'), 'no --session-id on resume');
  assert.ok(!r.args.includes('--model'), 'no --model unless given');
  assert.equal(r.args[r.args.indexOf('--max-budget-usd') + 1], String(DEFAULT_BUDGET_USD));
  assert.equal(r.args[r.args.indexOf('--name') + 1], 'force push', 'a name cannot pass for a flag');
  assert.equal(r.resume, true);
  const fresh = buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, budgetUsd: 0.25 });
  assert.match(fresh.sessionId, UUID_RE);
  assert.equal(fresh.args[fresh.args.indexOf('--max-budget-usd') + 1], '0.25');
  assert.throws(() => buildClaudeLaunch({ name: 'A', agentId: 'abc123', env: {} }), /permission check is not set up/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: { url: HOOK.url }, agentId: 'abc123', env: {} }), /permission check/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, budgetUsd: -1 }), /positive number/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, model: '--dangerously-skip-permissions' }), /model name/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, sessionId: 'not-a-uuid' }), /session id/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, env: {} }), /agent id/);
});

test('the environment is scrubbed and carries the hook details', () => {
  const l = buildClaudeLaunch({
    name: 'A', hook: HOOK, agentId: 'abc123',
    env: { PATH: NODE_DIR, HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_PID: '5', CLAUDE_EFFORT: 'high', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' },
  });
  assert.deepEqual(l.env, {
    PATH: NODE_DIR, HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k',
    WORKBENCH_HOOK_URL: HOOK.url, WORKBENCH_HOOK_TOKEN: HOOK.token, WORKBENCH_AGENT_ID: 'abc123',
  });
  assert.deepEqual(scrubEnv({ CLAUDECODE: '1', A: 'b', U: undefined }), { A: 'b' });
});

test('an agent gets no handle on the editor Workbench was started from, and no say in which programs a Workbench it starts would run', () => {
  // As seen in a Claude Code session inside VS Code, which is where Workbench is often started from.
  const host = {
    VSCODE_IPC_HOOK: '/Users/x/Library/Application Support/Code/1.14-main.sock', VSCODE_PID: '3822', VSCODE_CWD: '/',
    VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git.sock', VSCODE_NLS_CONFIG: '{}', ELECTRON_RUN_AS_NODE: '1', GIT_EDITOR: 'true',
    WORKBENCH_CLAUDE_BIN: '/x/claude', WORKBENCH_CODEX_BIN: '/x/codex',
  };
  const own = { PATH: NODE_DIR, HOME: '/h', EDITOR: 'vim', GIT_AUTHOR_NAME: 'Ada', VSCODE: 'not the editor’s', MY_VSCODE_THING: '1' };
  assert.deepEqual(scrubEnv({ ...host, ...own }), own);
  const l = buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: { ...host, ...own } });
  for (const k of Object.keys(host)) assert.equal(l.env[k], undefined, k);
  assert.equal(l.bin, '/x/claude', 'the program itself is still the one asked for');
});

test('agents find node on their PATH, even when the person’s PATH has none', (t) => {
  const dir = scratch(t);
  const empty = path.join(dir, 'empty');
  mkdirSync(empty);
  const launch = (env) => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env }).env.PATH;
  // No node on it: the folder of the node running Workbench goes first, so `npm test` and `node --test` work.
  assert.equal(launch({ PATH: empty }), `${NODE_DIR}:${empty}`);
  assert.equal(launch({ PATH: '/no/such/folder:relative/bin' }), `${NODE_DIR}:/no/such/folder:relative/bin`);
  assert.equal(launch({}), `${NODE_DIR}:/usr/bin:/bin`, 'no PATH at all: the shell’s own default stays usable');
  // A node already on it: the PATH is left exactly as it was.
  assert.equal(launch({ PATH: `${empty}:${NODE_DIR}:/usr/bin` }), `${empty}:${NODE_DIR}:/usr/bin`);
  // Only a program counts: a folder called node, a file that cannot run, or a relative PATH entry do not.
  mkdirSync(path.join(dir, 'a', 'node'), { recursive: true });
  program(path.join(dir, 'b', 'node'), 'exit 0', { exec: false });
  program(path.join(dir, 'c', 'node'));
  assert.equal(onPath('node', `${path.join(dir, 'a')}:${path.join(dir, 'b')}`), null);
  assert.equal(onPath('node', `${path.join(dir, 'a')}:${path.join(dir, 'b')}:${path.join(dir, 'c')}`), path.join(dir, 'c', 'node'));
  assert.equal(onPath('node', path.relative(process.cwd(), path.join(dir, 'c'))), null, 'relative: it would be looked for in the agent’s folder');
  const env = { PATH: path.join(dir, 'c'), A: '1' };
  assert.equal(withNodeOnPath(env), env, 'unchanged, not copied');
});

test('the person\'s own Claude Code settings and login reach the agent; session markers do not', () => {
  const markers = {
    CLAUDECODE: '1', CLAUDE_PID: '5', CLAUDE_EFFORT: 'high', CLAUDE_JOB_DIR: '/j', CLAUDE_AGENT_SDK_VERSION: '1',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'b', CLAUDE_CODE_MESSAGING_SOCKET: '/sock', CLAUDE_CODE_MESSAGING_TOKEN: 't',
    CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'r', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_CODE_EXECPATH: '/x', CLAUDE_CODE_SSE_PORT: '1234',
  };
  const own = {
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_CLIENT_CERT: '/cert', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k',
  };
  assert.deepEqual(scrubEnv({ ...markers, ...own, PATH: '/bin' }), { ...own, PATH: '/bin' });
  const l = buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: { ...markers, ...own } });
  assert.equal(l.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth');
  for (const k of Object.keys(markers)) assert.equal(l.env[k], undefined, k);
});

test('the person’s keys reach Claude Code after the scrub, never in argv, and never in place of Workbench’s own variables', () => {
  const value = ['fake', 'key', 'value', '0123456789'].join('-'); // made up here
  const l = buildClaudeLaunch({
    name: 'A', hook: HOOK, agentId: 'abc123', env: { PATH: NODE_DIR, HOME: '/h', CLAUDECODE: '1' },
    keysEnv: {
      WB_TEST_KEY: value, AWS_REGION: 'eu-west-1', WORKBENCH_AGENT_ID: 'other', WORKBENCH_HOOK_TOKEN: 'other', WORKBENCH_HOOK_URL: 'http://elsewhere',
      CLAUDECODE: '1', VSCODE_PID: '9', ELECTRON_RUN_AS_NODE: '1', 'NOT A NAME': 'x', '9LIVES': 'x', NUMBER: 7, NUL: 'a\u0000b',
    },
  });
  assert.deepEqual(l.env, {
    PATH: NODE_DIR, HOME: '/h', WB_TEST_KEY: value, AWS_REGION: 'eu-west-1',
    WORKBENCH_HOOK_URL: HOOK.url, WORKBENCH_HOOK_TOKEN: HOOK.token, WORKBENCH_AGENT_ID: 'abc123',
  });
  assert.ok(!JSON.stringify(l.args).includes(value), 'not in argv, nor in --settings');
  // The rule itself: a copy, and only when there is something to add.
  const env = { A: '1' };
  assert.equal(withKeys(env, null), env);
  assert.equal(withKeys(env, { WORKBENCH_X: '1', CLAUDECODE: '1' }), env);
  assert.deepEqual(withKeys(env, { A: '2', B: '3' }), { A: '2', B: '3' });
  assert.deepEqual(env, { A: '1' });
  assert.deepEqual(withKeys(env, { A: '2', B: '3' }, (k) => k === 'B'), { A: '2' }, 'what the adapter’s own scrub removes');
});

test('the masking helpers: every string of parsed output, the kept end of a stream, and a mask that fails', () => {
  const value = ['fake', 'stored', 'value', 'q'.repeat(30)].join('-'); // made up here
  const mask = (s) => s.split(value).join('••••');
  const obj = { a: 'short', b: ['x', `say ${value}`], c: { d: value, e: null }, n: 5 };
  assert.equal(maskParsed(obj, mask), obj, 'in place');
  assert.deepEqual(obj, { a: 'short', b: ['x', 'say ••••'], c: { d: '••••', e: null }, n: 5 });
  assert.equal(maskParsed(value, mask), '••••');
  // Nothing was dropped: masked as it is, then the last characters.
  assert.equal(maskedTail(`a ${value} b`, { limit: 100, mask }), 'a •••• b');
  assert.equal(maskedTail('abcdef', { limit: 3, mask }), 'def');
  // Earlier output was dropped, and the kept part begins inside a key: that part never shows.
  assert.equal(maskCut(`${value.slice(10)} tail\nnext ${value} line`, mask, true), 'next •••• line', 'up to the first line break');
  assert.equal(maskCut(`${value.slice(10)}_${value}_end`, mask, true), '••••_end', 'up to the first key hidden');
  assert.equal(maskCut('x'.repeat(MASK_MARGIN + 10), mask, true), 'x'.repeat(10), 'no line break near, nothing hidden');
  assert.equal(maskCut(`${value.slice(10)} tail`, mask, false), `${value.slice(10)} tail`, 'nothing dropped, nothing cut');
  // A mask that throws, or gives something else than text, hides nothing and breaks nothing.
  assert.equal(safeMask(null)('abc'), 'abc');
  assert.equal(safeMask(() => { throw new Error('no'); })('abcdefghij'), 'abcdefghij');
  assert.equal(safeMask(() => 5)('abcdefghij'), 'abcdefghij');
});

test('maskParsed leaves the words of Claude Code’s own format alone, and hides every word a tool or the agent wrote', () => {
  // A copied .env may hold one of those words ("assistant", a model's name): hidden there, a line no longer reads.
  const value = ['fake', 'copied', 'value', 'q'.repeat(20)].join('-'); // made up here
  const words = ['assistant', 'claude-haiku-4-5', 'toolu_01abcdef', 'msg_01abcdef', 'end_turn', 'TodoWrite', 'tool_result', 'completed', value];
  const mask = (s) => maskSecrets(s, words);
  const hidden = (s) => maskSecrets(s, words);
  const said = {
    type: 'assistant', session_id: 'sess-0001-x', parent_tool_use_id: 'toolu_01abcdef', uuid: 'uuid-0001-x',
    message: {
      id: 'msg_01abcdef', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
      content: [
        { type: 'text', text: `the assistant read ${value}` },
        { type: 'tool_use', id: 'toolu_01abcdef', name: 'TodoWrite', input: { name: 'assistant', model: 'claude-haiku-4-5', id: value, type: 'assistant', todos: [{ content: value, status: 'completed' }] } },
      ],
    },
  };
  maskParsed(said, mask, CLAUDE_FORMAT);
  assert.deepEqual(said, {
    type: 'assistant', session_id: 'sess-0001-x', parent_tool_use_id: 'toolu_01abcdef', uuid: 'uuid-0001-x',
    message: {
      id: 'msg_01abcdef', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn',
      content: [
        { type: 'text', text: `the ${hidden('assistant')} read ${hidden(value)}` },
        // a tool's input is the agent's: a name of the format there is hidden like any other word
        { type: 'tool_use', id: 'toolu_01abcdef', name: 'TodoWrite', input: { name: hidden('assistant'), model: hidden('claude-haiku-4-5'), id: hidden(value), type: hidden('assistant'), todos: [{ content: hidden(value), status: hidden('completed') }] } },
      ],
    },
  });
  // A tool's result, in the message and beside it, is the tool's: hidden whatever its fields are called.
  const result = {
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01abcdef', content: [{ type: 'text', text: value }, { type: 'assistant', id: value }] }] },
    tool_use_result: { status: 'completed', model: 'claude-haiku-4-5', id: value },
  };
  maskParsed(result, mask, CLAUDE_FORMAT);
  assert.deepEqual(result, {
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01abcdef', content: [{ type: 'text', text: hidden(value) }, { type: hidden('assistant'), id: hidden(value) }] }] },
    tool_use_result: { status: hidden('completed'), model: hidden('claude-haiku-4-5'), id: hidden(value) },
  });
  // The name of a block that is not a tool call, and the format's words elsewhere in a line, are hidden.
  const other = { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', status: 'completed', cwd: `/w/${value}`, mcp_servers: [{ name: value, status: 'assistant' }], message: { content: [{ type: 'text', name: value }] } };
  maskParsed(other, mask, CLAUDE_FORMAT);
  assert.deepEqual(other, { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', status: 'completed', cwd: hidden(`/w/${value}`), mcp_servers: [{ name: hidden(value), status: hidden('assistant') }], message: { content: [{ type: 'text', name: hidden(value) }] } });
  // Without a format, every string is hidden, as before.
  assert.deepEqual(maskParsed({ type: 'assistant' }, mask), { type: hidden('assistant') });
});

test('the hook command quotes its paths for the shell', () => {
  assert.equal(shellQuote("/tmp/it's here"), `'/tmp/it'\\''s here'`);
  assert.equal(hookCommand({ nodePath: '/n o/node', bridgePath: "/b/x'y.mjs" }), `'/usr/bin/env' '-u' 'NODE_OPTIONS' '/n o/node' '/b/x'\\''y.mjs'`);
  assert.equal(hookCommand(), `'/usr/bin/env' '-u' 'NODE_OPTIONS' ${shellQuote(process.execPath)} ${shellQuote(BRIDGE_PATH)}`);
  assert.match(BRIDGE_PATH, /src\/adapters\/claude\/hook-bridge\.mjs$/);
  const s = hookSettings();
  assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 1800);
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
});

test('sessionFolders: Claude Code\'s own folders for one session, keyed by its id', () => {
  const sid = '0bdffedf-c0cd-41ae-8bb3-6183f7e1be41';
  const real = (p) => realpathSync.native(p);
  assert.deepEqual(sessionFolders({ sessionId: sid, env: { HOME: '/h' }, uid: 501 }), [
    { root: '/h/.claude/projects', session: sid },
    { root: path.join(real('/tmp'), 'claude-501'), session: sid },
  ]);
  // The person's own CLAUDE_CONFIG_DIR and CLAUDE_CODE_TMPDIR are where Claude Code writes, so they count instead.
  const tmp = mkdtempSync(path.join(tmpdir(), 'wb-cctmp-'));
  try {
    assert.deepEqual(sessionFolders({ sessionId: sid, env: { HOME: '/h', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_TMPDIR: tmp }, uid: 7 }), [
      { root: '/c/projects', session: sid },
      { root: path.join(real(tmp), 'claude-7'), session: sid },
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // No session yet, or one that is not a UUID: nothing. No user id (Windows): no temp folder.
  assert.deepEqual(sessionFolders({ sessionId: null, env: { HOME: '/h' }, uid: 501 }), []);
  assert.deepEqual(sessionFolders({ sessionId: 'sess-9', env: { HOME: '/h' }, uid: 501 }), []);
  assert.deepEqual(sessionFolders({ sessionId: sid, env: { HOME: '/h' }, uid: null }), [{ root: '/h/.claude/projects', session: sid }]);
  assert.deepEqual(sessionFolders({ sessionId: sid, env: { HOME: '/h', CLAUDE_CONFIG_DIR: 'relative' }, uid: null }), []);
});

test('userMessage is one stream-json line', () => {
  const line = userMessage('Fix the "login" bug\nplease');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'a single line');
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the "login" bug\nplease' }] } });
});

// ---------- line splitting ----------

test('the line splitter handles partial lines, CRLF, split characters and long lines', () => {
  const lines = [];
  const sp = createLineSplitter((l) => lines.push(l));
  const text = '{"a":1}\r\n{"b":"é✓—"}\n\n   \n' + '{"long":"' + 'y'.repeat(300000) + '"}\n{"tail":true}';
  const bytes = Buffer.from(text, 'utf8');
  // Feed it in awkward pieces, so multi-byte characters are cut apart.
  for (let i = 0, k = 1; i < bytes.length; k = (k * 7) % 13 + 1) { sp.push(bytes.subarray(i, i + k * 97)); i += k * 97; }
  assert.equal(lines.length, 3, 'the last line waits for its newline');
  sp.end();
  assert.deepEqual(lines.map((l) => JSON.parse(l)).map((o) => Object.keys(o)[0]), ['a', 'b', 'long', 'tail']);
  assert.equal(JSON.parse(lines[1]).b, 'é✓—');
  assert.equal(JSON.parse(lines[2]).long.length, 300000);

  const kept = [];
  const tooLong = [];
  const small = createLineSplitter((l) => kept.push(l), { maxLineChars: 10, onTooLong: (n) => tooLong.push(n) });
  small.push('short\n0123456789abcdef');
  small.push('ghij\nok\n');
  assert.deepEqual(kept, ['short', 'ok']);
  assert.deepEqual(tooLong, [20]);
});

// ---------- available() ----------

test('available reports the version, a missing binary, and a binary that hangs', async () => {
  assert.equal(harness, 'claude');
  assert.equal(createClaudeRunner, createRunner);
  assert.equal(STOP_GRACE_MS, 3000);
  assert.deepEqual(await available({ env: fakeEnv() }), { ok: true, version: '2.1.221', path: FAKE, from: 'env' });
  assert.deepEqual(await available({ env: fakeEnv({ FAKE_CLAUDE_VERSION: '2.1.322' }) }), { ok: true, version: '2.1.322', path: FAKE, from: 'env' });
  // A path that is not there has its own reason, and no other Claude Code is tried instead.
  assert.deepEqual(await available({ env: { ...process.env, WORKBENCH_CLAUDE_BIN: '/nonexistent/claude-binary' } }), {
    ok: false, reason: 'Claude Code is not at /nonexistent/claude-binary, the path in WORKBENCH_CLAUDE_BIN.', path: '/nonexistent/claude-binary', from: 'env',
  });
  const hung = await available({ env: fakeEnv({ FAKE_CLAUDE_VERSION: 'hang' }), timeoutMs: 300 });
  assert.equal(hung.ok, false);
  assert.match(hung.reason, /did not answer/);
});

test('available says where Claude Code was found: --claude, WORKBENCH_CLAUDE_BIN, the PATH or the VS Code extension', async (t) => {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const { bin: ext } = extension(home, '2.1.322');
  program(path.join(bin, 'claude'), 'echo "2.1.310 (Claude Code)"');
  const base = { HOME: home, PATH: path.join(dir, 'empty') };
  assert.deepEqual(await available({ env: base }), { ok: true, version: '2.1.322', path: ext, from: 'vscode' });
  assert.deepEqual(await available({ env: { ...base, PATH: bin } }), { ok: true, version: '2.1.310', path: path.join(bin, 'claude'), from: 'path' });
  assert.deepEqual(await available({ env: { ...base, PATH: bin, WORKBENCH_CLAUDE_BIN: FAKE } }), { ok: true, version: '2.1.221', path: FAKE, from: 'env' });
  assert.deepEqual(await available({ env: { ...base, WORKBENCH_CLAUDE_BIN: FAKE }, claudePath: ext }), { ok: true, version: '2.1.322', path: ext, from: 'flag' });
  // Nothing anywhere: the reason names both ways to say where it is.
  const none = await available({ env: { HOME: path.join(dir, 'nobody'), PATH: path.join(dir, 'empty') } });
  assert.deepEqual(none, { ok: false, reason: CLAUDE_NOT_FOUND });
  assert.equal(CLAUDE_NOT_FOUND, 'Claude Code was not found: there is no claude command on the PATH, and no Claude Code extension in VS Code or Cursor. Tell Workbench where it is with --claude <path>, or with WORKBENCH_CLAUDE_BIN.');
  // A folder given as the program.
  const folder = await available({ env: base, claudePath: dir });
  assert.deepEqual(folder, { ok: false, reason: `The path given with --claude, ${dir}, is a folder, not the Claude Code program.`, path: dir, from: 'flag' });
  // A program that fails says so, and which one it was.
  program(path.join(dir, 'broken', 'claude'), 'echo "it broke" >&2; exit 4');
  assert.deepEqual(await available({ env: base, claudePath: path.join(dir, 'broken', 'claude') }), {
    ok: false, reason: 'Claude Code could not be started. It said: it broke', path: path.join(dir, 'broken', 'claude'), from: 'flag',
  });
});

test('findClaude looks in order, takes the newest extension, and never swaps a given path for another Claude Code', (t) => {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const empty = path.join(dir, 'empty');
  mkdirSync(empty);
  program(path.join(bin, 'claude'));
  program(path.join(bin, 'claude-beta'));
  const plat = `-${process.platform}-${process.arch}`;
  const other = process.platform === 'linux' ? '-darwin-arm64' : '-linux-x64';
  extension(home, '2.1.300');
  const insiders = extension(home, '2.1.322', { folder: '.vscode-insiders/extensions' });
  extension(home, '2.1.310', { folder: '.cursor/extensions' });
  extension(home, '2.1.900', { suffix: other }); // for another system
  extension(home, '2.1.800', { exec: false }); // its program cannot run
  const gone = extension(home, '2.1.700'); // VS Code marked it to be deleted
  writeFileSync(path.join(home, '.vscode/extensions/.obsolete'), JSON.stringify({ [path.basename(gone.dir)]: true }));
  mkdirSync(path.join(home, '.vscode/extensions/anthropic.claude-code-latest/resources/native-binary'), { recursive: true });
  assert.deepEqual(EXTENSION_FOLDERS, ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions']);

  const env = { HOME: home, PATH: `${empty}:${bin}`, WORKBENCH_CLAUDE_BIN: FAKE };
  const extFound = { path: insiders.bin, from: 'vscode' };
  assert.deepEqual(findClaude({ env, flag: path.join(bin, 'claude-beta') }), { path: path.join(bin, 'claude-beta'), from: 'flag' });
  assert.deepEqual(findClaude({ env }), { path: FAKE, from: 'env' });
  assert.deepEqual(findClaude({ env: { ...env, WORKBENCH_CLAUDE_BIN: '' } }), { path: path.join(bin, 'claude'), from: 'path' }, 'an empty variable counts as unset');
  assert.deepEqual(findClaude({ env: { HOME: home, PATH: empty } }), extFound, 'the newest of VS Code, VS Code Insiders and Cursor');
  assert.deepEqual(newestExtensionClaude(home), { path: insiders.bin, version: '2.1.322' });
  assert.deepEqual(findClaude({ env: { HOME: home, PATH: path.relative(process.cwd(), bin) } }), extFound, 'a relative PATH entry is never used');

  // A path read from the folder Workbench runs in, and ~ in the variable.
  assert.deepEqual(findClaude({ env: { HOME: home }, flag: 'bin/claude', cwd: dir }), { path: path.join(bin, 'claude'), from: 'flag' });
  assert.deepEqual(findClaude({ env: { HOME: dir, WORKBENCH_CLAUDE_BIN: '~/bin/claude' } }), { path: path.join(bin, 'claude'), from: 'env' });
  // A bare name is a command on the PATH.
  assert.deepEqual(findClaude({ env: { HOME: home, PATH: bin }, flag: 'claude-beta' }), { path: path.join(bin, 'claude-beta'), from: 'flag' });
  assert.deepEqual(findClaude({ env: { HOME: home, PATH: empty }, flag: 'claude-beta' }), { path: null, from: 'flag', reason: 'There is no claude-beta command on the PATH (the name given with --claude).' });

  // Given but not there: said as it is, even with a Claude Code on the PATH and in VS Code.
  const missing = path.join(dir, 'nope', 'claude');
  assert.deepEqual(findClaude({ env, flag: missing }), { path: missing, from: 'flag', reason: `Claude Code is not at ${missing}, the path given with --claude.` });
  assert.deepEqual(findClaude({ env: { ...env, WORKBENCH_CLAUDE_BIN: missing } }), { path: missing, from: 'env', reason: `Claude Code is not at ${missing}, the path in WORKBENCH_CLAUDE_BIN.` });
  assert.deepEqual(findClaude({ env: { ...env, WORKBENCH_CLAUDE_BIN: home } }), { path: home, from: 'env', reason: `The path in WORKBENCH_CLAUDE_BIN, ${home}, is a folder, not the Claude Code program.` });

  // Nothing: no path, the plain reason. Without HOME in a given environment, no home folder is read at all.
  assert.deepEqual(findClaude({ env: { PATH: empty } }), { path: null, from: null, reason: CLAUDE_NOT_FOUND });
  assert.equal(claudeBin({ PATH: empty }), 'claude');
  assert.equal(claudeBin({ HOME: home, PATH: empty }), insiders.bin);
});

test('a relative path to Claude Code is read from the folder it is given, never from the working folder of the moment', async (t) => {
  const dir = scratch(t);
  const bin = path.join(dir, 'bin');
  program(path.join(bin, 'claude'), 'echo 2.1.400');
  // The same name where Workbench may stand for a moment (the file view steps into a project's folder).
  const elsewhere = scratch(t);
  program(path.join(elsewhere, 'bin', 'claude'), 'echo 9.9.9');
  const env = { HOME: path.join(dir, 'home'), PATH: path.join(dir, 'empty') };
  const was = process.cwd();
  process.chdir(elsewhere);
  t.after(() => process.chdir(was));
  const unknown = (v, where) => `Workbench cannot tell where ${v} is: the path ${where} must start with / or ~.`;
  assert.deepEqual(findClaude({ env, flag: 'bin/claude', cwd: dir }), { path: path.join(bin, 'claude'), from: 'flag' });
  assert.deepEqual(findClaude({ env, flag: 'bin/claude' }), { path: null, from: 'flag', reason: unknown('bin/claude', 'given with --claude') });
  assert.deepEqual(findClaude({ env: { ...env, WORKBENCH_CLAUDE_BIN: './bin/claude' } }), { path: null, from: 'env', reason: unknown('./bin/claude', 'in WORKBENCH_CLAUDE_BIN') });
  assert.deepEqual(findClaude({ env, flag: 'bin/claude', cwd: 'relative/too' }), { path: null, from: 'flag', reason: unknown('bin/claude', 'given with --claude') });
  assert.equal(claudeBin({ ...env, WORKBENCH_CLAUDE_BIN: 'bin/claude' }), 'claude');
  assert.equal(claudeBin({ ...env, WORKBENCH_CLAUDE_BIN: 'bin/claude' }, { cwd: dir }), path.join(bin, 'claude'));
  // available() and each launch are given the folder Workbench started in.
  assert.deepEqual(await available({ env, claudePath: 'bin/claude', startedIn: dir }), { ok: true, version: '2.1.400', path: path.join(bin, 'claude'), from: 'flag' });
  assert.deepEqual(await available({ env, claudePath: 'bin/claude' }), { ok: false, reason: unknown('bin/claude', 'given with --claude') });
  const tests = path.dirname(path.dirname(FAKE));
  const c = collector();
  const r = makeRunner(c, { claudePath: path.relative(tests, FAKE), startedIn: tests });
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the reply to the task');
  await r.stop();
});

test('on the same version, a build for this processor is taken', (t) => {
  const home = path.join(scratch(t), 'home');
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  extension(home, '2.1.322', { suffix: `-${process.platform}-${otherArch}` });
  const mine = extension(home, '2.1.322', { folder: '.cursor/extensions' });
  assert.deepEqual(newestExtensionClaude(home), { path: mine.bin, version: '2.1.322' });
  // The same, found the other way round: the build for this processor comes first and is kept.
  const first = path.join(scratch(t), 'home');
  const mineFirst = extension(first, '2.1.322');
  extension(first, '2.1.322', { folder: '.cursor/extensions', suffix: `-${process.platform}-${otherArch}` });
  assert.deepEqual(newestExtensionClaude(first), { path: mineFirst.bin, version: '2.1.322' });
  // A build for Alpine's Linux is a Linux build, taken only when there is no build for the usual Linux of that
  // version; on any other system it is skipped like every build for another system.
  const alpine = path.join(scratch(t), 'home');
  const musl = extension(alpine, '2.1.322', { suffix: `-alpine-${process.arch}` });
  if (process.platform === 'linux') {
    assert.deepEqual(newestExtensionClaude(alpine), { path: musl.bin, version: '2.1.322' });
    const glibc = extension(alpine, '2.1.322', { folder: '.cursor/extensions' });
    assert.deepEqual(newestExtensionClaude(alpine), { path: glibc.bin, version: '2.1.322' });
  } else {
    assert.equal(newestExtensionClaude(alpine), null);
  }
  const universal = path.join(scratch(t), 'home');
  const plain = extension(universal, '2.1.400', { suffix: '' });
  assert.deepEqual(newestExtensionClaude(universal), { path: plain.bin, version: '2.1.400' });
  assert.equal(newestExtensionClaude(''), null);
  assert.equal(newestExtensionClaude('relative/home'), null);
});

// ---------- the runner, with the fake binary ----------

test('start launches Claude Code, sends the task and turns its output into events', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl' } });
  assert.deepEqual(r.info(), { pid: null, sessionId: null, alive: false });
  await r.start();
  const info = r.info();
  assert.equal(info.alive, true);
  assert.equal(typeof info.pid, 'number');
  assert.match(info.sessionId, UUID_RE);
  await c.until((evs) => evs.filter((e) => e.kind === EV.TURN && e.phase === 'end').length === 3, 'three turn ends');
  const created = c.events.filter((e) => e.kind === EV.CREATED);
  assert.deepEqual(created.map((e) => [e.agentId, e.parentId, e.name]), [['abc123-a71ea18c', 'abc123', 'List repository files']]);
  assert.deepEqual(c.turnEnds().map((e) => e.backgroundTasks), [1, 1, 0]);
  const costs = c.events.filter((e) => e.kind === EV.USAGE && 'costUsd' in e).map((e) => e.costUsd);
  assert.equal(costs.at(-1), 0.0797947);
  assert.equal(c.events.find((e) => e.kind === EV.SESSION).sessionId, info.sessionId, 'the fake reports our session id');
  assert.ok(c.events.every((e) => typeof e.ts === 'number'));
  await assert.rejects(r.start(), /already started/);
  await r.stop();
  assert.equal(r.info().alive, false);
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.agentId === 'abc123'), 'a stop is reported by the engine, not the runner');
});

test('the runner names its own session\'s folders and its helpers, for the permission check', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl', HOME: '/home/someone', CLAUDE_CONFIG_DIR: '' } });
  assert.deepEqual(r.readAlso(), [], 'no session before it starts');
  assert.deepEqual(r.recipients(), []);
  await r.start();
  await c.until((evs) => evs.filter((e) => e.kind === EV.TURN && e.phase === 'end').length === 3, 'three turn ends');
  const { sessionId } = r.info();
  const folders = r.readAlso();
  assert.deepEqual(folders[0], { root: '/home/someone/.claude/projects', session: sessionId }, 'from the environment Claude Code was started with');
  assert.ok(folders.every((f) => f.session === sessionId), 'only its own session');
  // Claude Code tells the root to continue its helper with to: 'a71ea18c16a7bba8d'.
  assert.deepEqual(r.recipients().sort(), ['a71ea18c16a7bba8d', 'abc123-a71ea18c'].sort());
  await r.stop();
});

test('send writes the next message to the running process', async () => {
  const c = collector();
  const r = makeRunner(c);
  await assert.rejects(r.send('too early'), /not been started/);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the reply to the task');
  const pid = r.info().pid;
  await r.send('Also update the docs');
  await c.until(replyIs(/^You said: Also update the docs$/), 'the reply to the second message');
  assert.equal(r.info().pid, pid, 'same process');
  assert.equal(c.events.filter((e) => e.kind === EV.TURN && e.phase === 'start').length, 2);
  await r.stop();
});

test('stop ends the whole process group', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'spawn a child' });
  await r.start();
  const hit = await c.until(replyIs(/^child \d+$/), 'the grandchild pid');
  const grandchild = Number(/\d+/.exec(hit.finalText)[0]);
  const pid = r.info().pid;
  assert.ok(processAlive(grandchild));
  await r.stop();
  assert.equal(r.info().alive, false);
  assert.ok(await waitDead(pid), 'the claude process is gone');
  assert.ok(await waitDead(grandchild), 'its grandchild is gone too');
  assert.ok(!c.events.some((e) => e.kind === EV.ENDED && e.agentId === 'abc123'));
});

test('stop forces the group with SIGKILL when SIGTERM is ignored', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'spawn a child', env: { FAKE_CLAUDE_STUBBORN: '1' }, killGraceMs: 400 });
  await r.start();
  const hit = await c.until(replyIs(/^child \d+$/), 'the grandchild pid');
  const grandchild = Number(/\d+/.exec(hit.finalText)[0]);
  const pid = r.info().pid;
  const t0 = Date.now();
  await r.stop();
  assert.ok(Date.now() - t0 >= 350, 'it waited for the grace period first');
  assert.ok(await waitDead(pid), 'the claude process is gone');
  assert.ok(await waitDead(grandchild), 'its stubborn grandchild is gone too');
});

test('send relaunches with --resume when the process has gone', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.send('And the docs');
  await c.until(replyIs(/^You said: And the docs$/), 'the second reply');
  const { pid, sessionId } = r.info();
  await r.send('exit 0');
  await c.until((evs) => evs.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123'), 'the clean exit');
  assert.equal(c.events.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123').outcome, 'ok');
  assert.equal(r.info().alive, false);
  assert.equal(r.info().sessionId, sessionId, 'the session is remembered after exit');

  await r.send('Carry on');
  const hit = await c.until(replyIs(/^You said \(resumed /), 'the reply from the resumed session');
  // Same session, no --session-id (the fake refuses both together), and only what is left of the limit.
  assert.equal(hit.finalText, `You said (resumed ${sessionId} with budget 0.98): Carry on`);
  assert.notEqual(r.info().pid, pid);
  assert.equal(r.info().alive, true);
  // The resumed fake counts spend from zero again; the total keeps growing anyway.
  const costs = c.events.filter((e) => e.kind === EV.USAGE && 'costUsd' in e).map((e) => Math.round(e.costUsd * 100) / 100);
  assert.deepEqual(costs, [0.01, 0.02, 0.03]);
  await r.stop();
});

test('a stopped agent can be resumed by sending it a message', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  const { sessionId } = r.info();
  await r.stop();
  assert.equal(r.info().alive, false);
  await r.send('Please continue');
  await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  assert.equal(r.info().sessionId, sessionId);
  await r.stop();
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.agentId === 'abc123' && e.state === 'failed'));
});

test('a crash reports the stderr tail and fails the agent', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.send('exit 3');
  const failed = await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.state === 'failed'), 'the failed state');
  const ended = c.events.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123');
  assert.equal(ended.outcome, 'error');
  assert.match(ended.error, /fake claude: asked to exit with 3/);
  assert.ok(ended.error.length <= STDERR_TAIL_CHARS);
  assert.ok(c.events.indexOf(ended) < c.events.indexOf(failed), 'ended, then failed');
  assert.equal(failed.reason, 'Claude Code stopped with an error (exit code 3).');
  assert.equal(r.info().alive, false);
});

test('helpers still running when the process dies are ended', async () => {
  const c = collector();
  // Replay the run only up to the first result: the helper is still working in the background.
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '259' } });
  await r.start();
  const end = await c.until((evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end'), 'the first turn end');
  assert.equal(end.backgroundTasks, 1);
  await r.send('exit 1');
  await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.agentId === 'abc123' && e.state === 'failed'), 'the failure');
  const helperStates = c.events.filter((e) => e.kind === EV.STATE && e.agentId === 'abc123-a71ea18c');
  assert.deepEqual(helperStates.map((e) => e.state), ['working', 'failed']);
  assert.equal(helperStates[1].reason, 'Claude Code stopped unexpectedly.');
  assert.equal(c.events.filter((e) => e.kind === EV.ENDED && e.agentId === 'abc123-a71ea18c').length, 1);
});

test('a missing binary refuses the start in plain language, and starts nothing', async (t) => {
  const c = collector();
  const r = makeRunner(c, { env: { WORKBENCH_CLAUDE_BIN: '/nonexistent/claude-binary' } });
  const err = await r.start().then(() => null, (e) => e);
  assert.equal(err?.message, 'Claude Code is not at /nonexistent/claude-binary, the path in WORKBENCH_CLAUDE_BIN.');
  assert.equal(err.plain, true, 'meant for the person as it is: the engine shows it as why the agent could not start');
  assert.deepEqual(c.events, [], 'nothing ran, so the runner reports nothing itself');
  assert.equal(r.info().alive, false);
  // Nothing found anywhere (no variable, nothing on the PATH, no extension in this home folder).
  const dir = scratch(t);
  const none = makeRunner(c, { env: { WORKBENCH_CLAUDE_BIN: '', HOME: dir, PATH: dir } });
  await assert.rejects(none.start(), (e) => e.message === CLAUDE_NOT_FOUND && e.plain === true);
  // The folder is checked when the program starts.
  const r2 = makeRunner(c, { cwd: `${WORKBENCH}/no-such-folder-for-claude-tests` });
  await assert.rejects(r2.start(), /folder does not exist/);
  const failed = await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.state === 'failed'), 'the failed state');
  assert.equal(failed.reason, "Claude Code could not be started: the agent's folder does not exist.");
});

test('every launch looks Claude Code up again, so an update of the VS Code extension is picked up', async (t) => {
  const dir = scratch(t);
  const home = path.join(dir, 'home');
  const started = path.join(dir, 'started.log');
  const empty = path.join(dir, 'empty');
  mkdirSync(empty);
  const before = extension(home, '2.1.300', { log: started });
  const c = collector();
  // No variable and nothing on the PATH: the extension is the only Claude Code here.
  const r = makeRunner(c, { env: { WORKBENCH_CLAUDE_BIN: '', HOME: home, PATH: empty } });
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.stop();
  // VS Code updates the extension: the old folder goes, a new one comes.
  rmSync(before.dir, { recursive: true, force: true });
  extension(home, '2.1.322', { log: started });
  await r.send('Please continue');
  await c.until(replyIs(/^You said \(resumed /), 'the reply from the updated Claude Code');
  assert.deepEqual(readFileSync(started, 'utf8').trim().split('\n'), ['2.1.300', '2.1.322']);
  // Each process says which version it is.
  assert.deepEqual(c.events.filter((e) => e.kind === EV.SESSION).map((e) => e.version), ['2.1.300', '2.1.322']);
  await r.stop();
  // And when it is gone altogether, the next message is refused in plain words; the agent is not marked failed.
  rmSync(path.join(home, '.vscode'), { recursive: true, force: true });
  await assert.rejects(r.send('One more thing'), (e) => e.message === CLAUDE_NOT_FOUND && e.plain === true);
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.state === 'failed'));
});

test('the version, permission mode and tools Claude Code offers are logged once per process, with warnings for tools that should be off', async () => {
  const c = collector();
  const lines = { info: [], warn: [] };
  // A logger like the CLI's: a function with a method per level. Warnings go to its warn, so they show without --verbose.
  const log = Object.assign((l) => lines.info.push(`(plain) ${l}`), { info: (l) => lines.info.push(l), warn: (l) => lines.warn.push(l), debug() {}, error() {} });
  // Recorded with 2.1.221 before most of today's tools were turned off: it offers several of them.
  const r = makeRunner(c, { log, env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl' } });
  await r.start();
  await c.until((evs) => evs.filter((e) => e.kind === EV.TURN && e.phase === 'end').length === 3, 'three turn ends');
  const offers = () => lines.info.filter((l) => / offers \d+ tools/.test(l));
  assert.equal(offers().length, 1, 'three turns, one process: one line');
  assert.match(offers()[0], /^claude abc123: Claude Code 2\.1\.221 \(permission mode default\) offers 31 tools: Task Bash CronCreate /);
  assert.deepEqual(lines.warn, ['claude abc123: Claude Code offers tools Workbench turned off for its agents: CronCreate CronDelete CronList DesignSync EnterWorktree ExitWorktree PushNotification ScheduleWakeup Workflow']);
  assert.deepEqual([...new Set(c.events.filter((e) => e.kind === EV.SESSION).map((e) => e.version))], ['2.1.221']);
  await r.stop();
  // A new process is logged again.
  await r.send('Carry on');
  await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  assert.equal(offers().length, 2);
  assert.match(offers()[1], /^claude abc123: Claude Code 2\.1\.221 \(permission mode default\) offers 5 tools: Task Bash Edit Read Write$/);
  assert.ok(!lines.info.some((l) => l.startsWith('(plain) ')), 'every line went to the method for its level');
  await r.stop();
});

test('a permission mode other than the one asked for is a warning; "manual" is 2.1.322’s name for the default', async () => {
  const run = async (mode) => {
    const c = collector();
    const warn = [];
    const r = makeRunner(c, { log: { info() {}, warn: (l) => warn.push(l), debug() {}, error() {} }, env: { FAKE_CLAUDE_PERMISSION_MODE: mode } });
    await r.start();
    await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
    await r.stop();
    return warn;
  };
  assert.deepEqual(await run('bypassPermissions'), ['claude abc123: Claude Code runs this agent in permission mode bypassPermissions, not the default mode Workbench asked for.']);
  assert.deepEqual(await run('manual'), []);
});

test('very long lines written in small pieces arrive whole', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'long 2000000', env: { FAKE_CLAUDE_CHUNKY: '1' } });
  await r.start();
  const hit = await c.until(replyIs(/✓$/), 'the long reply', 30000);
  assert.equal(hit.finalText.length, 2000000);
  assert.ok(/^x+✓$/.test(hit.finalText));
  await r.send('short one');
  await c.until(replyIs(/^You said: short one$/), 'the next reply');
  await r.stop();
});

test('the fixture replays the same through the runner in small pieces', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-denied-bash.jsonl', FAKE_CLAUDE_CHUNKY: '1' } });
  await r.start();
  const end = await c.until((evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end'), 'the turn end');
  assert.match(end.finalText, /Would you like me to proceed/);
  const denied = c.events.find((e) => e.kind === EV.ACTIVITY && e.phase === 'end');
  assert.equal(denied.ok, false);
  await r.stop();
});

test('agentFor says which agent issued a tool call, for the hook', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '280' } });
  await r.start();
  await c.until((evs) => evs.find((e) => e.kind === EV.ACTIVITY && e.toolUseId === 'toolu_01S2aSEWS7CLR2yGuSGh7FQM'), 'the helper’s Bash call');
  assert.equal(r.agentFor({ toolUseId: 'toolu_01S2aSEWS7CLR2yGuSGh7FQM', taskId: 'a71ea18c16a7bba8d' }), 'abc123-a71ea18c');
  assert.equal(r.agentFor({ taskId: 'a71ea18c16a7bba8d' }), 'abc123-a71ea18c');
  assert.equal(r.agentFor({ toolUseId: 'toolu_other' }), null);
  await r.stop();
});

/** The recorded held-bash turn has two API messages; both have been read once two root usage events are in. */
const bothMessages = (evs) => evs.filter((e) => e.kind === EV.USAGE && e.agentId === 'abc123' && e.mode === 'add').length >= 2;

test('a relaunch after a stop in the middle of a turn gets the limit minus what that turn spent', async () => {
  const c = collector();
  // The recorded turn without its result: Claude Code reports cost only when a turn ends, so nothing is reported.
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-held-bash.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '32' } });
  await r.start();
  await c.until(bothMessages, 'the turn’s two messages');
  const { sessionId } = r.info();
  await r.stop();
  await r.send('Please continue');
  const hit = await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  // 1 - 0.0231 estimated for the stopped turn (Claude Code later reported 0.0246 for the same recorded turn).
  assert.equal(hit.finalText, `You said (resumed ${sessionId} with budget 0.9769): Please continue`);
  await r.stop();
});

test('a relaunch is refused in plain words when the stopped turn used up the limit', async () => {
  const c = collector();
  const r = makeRunner(c, { budgetUsd: 0.03, env: { FAKE_CLAUDE_FIXTURE: 'claude-held-bash.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '32' } });
  await r.start();
  await c.until(bothMessages, 'the turn’s two messages');
  await r.stop();
  const err = await r.send('Please continue').then(() => null, (e) => e);
  assert.equal(err?.message, 'Test agent has used its whole spending limit, so it can’t continue.');
  assert.equal(err.plain, true, 'meant for the person as it is');
  assert.equal(r.info().alive, false, 'nothing was launched');
});

test('a raised limit is what the next relaunch gets, less what was spent; a running process keeps the limit it started with', async () => {
  const c = collector();
  const r = makeRunner(c, { budgetUsd: 0.03, env: { FAKE_CLAUDE_FIXTURE: 'claude-held-bash.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '32' } });
  await r.start();
  await c.until(bothMessages, 'the turn’s two messages');
  const { sessionId } = r.info();
  await r.stop();
  await assert.rejects(r.send('Please continue'), /has used its whole spending limit/);
  for (const bad of [0, -1, NaN, '2', null]) assert.throws(() => r.setLimit(bad), /positive number of dollars/, String(bad));
  r.setLimit(1.03);
  await r.send('Please continue');
  const hit = await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  // 1.03 - 0.0231 estimated for the stopped turn, as in the test above
  assert.equal(hit.finalText, `You said (resumed ${sessionId} with budget 1.0069): Please continue`);
  // While a process runs, a message goes to it as it is: it keeps the limit it was started with.
  r.setLimit(5);
  await r.send('And the docs');
  await c.until(replyIs(/And the docs$/), 'the reply from the same process');
  assert.equal(c.turnEnds().at(-1).finalText, `You said (resumed ${sessionId} with budget 1.0069): And the docs`);
  await r.stop();
});

test('each Claude Code process gets the person’s keys, which never decide which Claude Code runs', async (t) => {
  const dir = scratch(t);
  const seen = path.join(dir, 'seen.txt');
  // A Claude Code that notes two variables of its environment, then is the stand-in.
  const bin = program(path.join(dir, 'claude'), [
    `if [ "$1" != "--version" ]; then printf '%s|%s\\n' "\${WB_TEST_SETTING-unset}" "\${WORKBENCH_AGENT_ID-unset}" >> ${shellQuote(seen)}; fi`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(FAKE)} "$@"`,
  ].join('\n'));
  const c = collector();
  const r = makeRunner(c, {
    env: { WORKBENCH_CLAUDE_BIN: bin },
    keysEnv: { WB_TEST_SETTING: 'from-the-key-store', WORKBENCH_AGENT_ID: 'another-agent', WORKBENCH_CLAUDE_BIN: path.join(dir, 'elsewhere') },
  });
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the reply to the task');
  await r.stop();
  await r.send('Please continue'); // a relaunch gets them too
  await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  assert.deepEqual(readFileSync(seen, 'utf8').trim().split('\n'), ['from-the-key-store|abc123', 'from-the-key-store|abc123']);
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.state === 'failed'), 'the stand-in found its launch as it should be');
  await r.stop();
});

test('a mask hides the person’s keys in Claude Code’s output before it is read, and in the stderr kept for errors', async () => {
  const value = ['fake', 'stored', 'value', 'q'.repeat(30), 'Z9W8'].join('-'); // made up here
  const mask = (s) => s.split(value).join('•••• Z9W8').split('asked to exit').join('[hidden]');
  const c = collector();
  const r = makeRunner(c, { mask });
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.send(`use ${value} please`);
  const said = await c.until(replyIs(/^You said: use /), 'the reply that repeats it');
  assert.equal(said.finalText, 'You said: use •••• Z9W8 please');
  assert.ok(!JSON.stringify(c.events).includes(value), 'in no event');
  await r.send('exit 3');
  await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.state === 'failed'), 'the failure');
  const ended = c.events.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123');
  assert.match(ended.error, /fake claude: \[hidden\] with 3/);
});

test('a mask that hides a word of Claude Code’s format ("assistant", the model’s name) changes nothing of what the board is told', async () => {
  const replay = async (mask) => {
    const c = collector();
    const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl' }, ...(mask ? { mask } : {}) });
    await r.start();
    await c.until((evs) => evs.filter((e) => e.kind === EV.TURN && e.phase === 'end').length === 3, 'three turn ends');
    await r.stop();
    return c.events;
  };
  const kinds = (evs) => {
    const n = {};
    for (const e of evs) n[e.kind] = (n[e.kind] || 0) + 1;
    return n;
  };
  const plain = await replay(null);
  const masked = await replay((s) => maskSecrets(s, ['assistant', 'claude-haiku-4-5-20251001']));
  assert.ok(kinds(plain)[EV.ACTIVITY] > 2 && kinds(plain)[EV.PLAN] >= 1, 'the run has steps and a plan to lose');
  assert.deepEqual(kinds(masked), kinds(plain), 'every step, plan, cost and thinking event still arrives');
  const models = (evs) => evs.filter((e) => e.kind === EV.MODEL).map((e) => e.model);
  assert.deepEqual(models(masked), models(plain));
  assert.ok(models(masked).includes('claude-haiku-4-5-20251001'), 'the model’s name is shown as it is');
  assert.deepEqual(masked.filter((e) => e.kind === EV.PLAN).map((e) => e.items), plain.filter((e) => e.kind === EV.PLAN).map((e) => e.items));
});
