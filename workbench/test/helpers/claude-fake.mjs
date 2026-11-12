#!/usr/bin/env node
// A stand-in for the `claude` binary, used by test/claude-runner.test.mjs through WORKBENCH_CLAUDE_BIN.
// It never talks to a network and never spends anything.
//
// - With no arguments it exits 0 at once (the test runner may load every file under test/).
// - `--version` prints a version: FAKE_CLAUDE_VERSION when set (it hangs with FAKE_CLAUDE_VERSION=hang), else 2.1.221.
//   Its system/init lines report the same version, with a short list of tools.
// - Otherwise it checks the launch flags and environment the workbench must pass, and exits 3 with a reason
//   on stderr when one is wrong. Then it reads stream-json user messages on stdin, one per line:
//     * the first message replays FAKE_CLAUDE_FIXTURE (a file in test/fixtures/) with its session id,
//       when that is set and this is not a resumed session (only the first FAKE_CLAUDE_FIXTURE_LINES lines,
//       when that is set);
//     * any other message gets a short reply turn: "You said: <text>"
//       (or "You said (resumed <id> with budget <usd>): <text>" in a resumed session);
//     * some messages are commands for the tests:
//         "spawn a child"  starts a grandchild process and replies "child <pid>"
//         "exit <code>"    writes a line to stderr and exits with that code
//         "long <n>"       replies with a text of n characters, ending in "✓"
//   It also checks that --settings carries WORKBENCH_HOOK_URL and WORKBENCH_AGENT_ID in `env`, and that the hook
//   key is not in argv. Hooks run with the environment of the process, then the `env` of the repository's
//   .claude/settings.json, then the `env` of --settings (which wins).
// - It exits 0 when stdin closes, unless FAKE_CLAUDE_STUBBORN is set: then it ignores SIGTERM and stdin
//   closing, and only SIGKILL ends it (its grandchildren ignore SIGTERM too).
// - FAKE_CLAUDE_CHUNKY=1 writes its output in small pieces, cutting lines and characters apart.
// - FAKE_CLAUDE_PIDFILE=<file> writes its process id there (and the id of each hook it runs to <file>.hook).
// - FAKE_CLAUDE_ENVDIR=<dir> writes { url, token } from its WORKBENCH_HOOK_* variables to <dir>/<WORKBENCH_AGENT_ID>.json.
// - FAKE_CLAUDE_HOOKS=1 makes the fixture replay behave like Claude Code with the workbench's hook (used by
//   test/live-fake.test.mjs):
//     * "/workspace/repo" in the fixture becomes the current folder;
//     * after each line with tool calls, it runs the PreToolUse hook command from --settings for each call, as
//       Claude Code does: through /bin/sh, with the payload on stdin, waiting as long as the hook takes. A
//       helper's call carries agent_id and agent_type, taken from the helper's task_started line;
//     * a call the hook does not allow gets an error result with the hook's reason instead of the recorded one;
//     * an allowed Bash call `touch <name>` really creates <name> in the current folder;
//     * FAKE_CLAUDE_ROOT_BASH=<command> replaces the root agent's own Bash calls (with no description, so the
//       workbench describes the command itself), and their recorded output with none;
//     * FAKE_CLAUDE_DELAY_MS=<ms> waits that long after each line;
//     * later messages wait until the replay is over.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION && env.FAKE_CLAUDE_VERSION !== 'hang' ? env.FAKE_CLAUDE_VERSION : '2.1.221';

if (argv.length === 0) {
  // Started with no arguments, as `node --test test/` does with every file under test/: nothing to do.
  process.exit(0);
} else if (argv.includes('--version')) {
  if (env.FAKE_CLAUDE_VERSION === 'hang') setInterval(() => {}, 1000);
  else { process.stdout.write(`${VERSION} (Claude Code)\n`); process.exit(0); }
} else {
  main();
}

function main() {
  const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const problems = [];
  const need = (ok, what) => { if (!ok) problems.push(what); };

  need(argv[0] === '-p', '-p first');
  need(value('--input-format') === 'stream-json', '--input-format stream-json');
  need(value('--output-format') === 'stream-json', '--output-format stream-json');
  need(argv.includes('--verbose'), '--verbose');
  need(argv.includes('--forward-subagent-text'), '--forward-subagent-text');
  need(value('--setting-sources') === 'project', '--setting-sources project');
  need(value('--permission-mode') === 'default', '--permission-mode default');
  need(argv.includes('--strict-mcp-config'), '--strict-mcp-config');
  // A few of the turned-off tools, including the five new in Claude Code 2.1.322.
  const off = ['AskUserQuestion', 'DesignSync', 'CronList', 'SendFile', 'SendToProject', 'PublishPlugin', 'ListAgents', 'WrapUp'];
  need(off.every((t) => String(value('--disallowedTools') || '').split(' ').includes(t)), '--disallowedTools');
  let settings = null;
  try { settings = JSON.parse(value('--settings')); } catch { settings = null; }
  need(settings && settings.disableAllHooks === false, 'disableAllHooks: false in --settings');
  let hook = null;
  try { hook = settings.hooks.PreToolUse[0].hooks[0]; } catch { hook = null; }
  // The bridge's address and agent id are pinned in --settings (flag settings outrank the repository's), the key is not.
  const pinned = (settings && settings.env) || {};
  need(pinned.WORKBENCH_HOOK_URL === env.WORKBENCH_HOOK_URL && !!pinned.WORKBENCH_HOOK_URL, 'WORKBENCH_HOOK_URL in --settings env');
  need(pinned.WORKBENCH_AGENT_ID === env.WORKBENCH_AGENT_ID && !!pinned.WORKBENCH_AGENT_ID, 'WORKBENCH_AGENT_ID in --settings env');
  need(!JSON.stringify(argv).includes(env.WORKBENCH_HOOK_TOKEN || '\u0000none'), 'the hook key is not in argv');
  need(hook && hook.type === 'command' && hook.timeout === 1800 && /^'\/usr\/bin\/env' '-u' 'NODE_OPTIONS' '.+hook-bridge\.mjs'$/.test(hook.command), 'a PreToolUse hook in --settings');
  need(String(value('--append-system-prompt') || '').startsWith('You are running inside Workbench'), '--append-system-prompt');
  need(Number(value('--max-budget-usd')) > 0, '--max-budget-usd');
  const resume = value('--resume');
  const sessionArg = value('--session-id');
  need(!!resume !== !!sessionArg, 'exactly one of --session-id and --resume');
  need(!!value('--name'), '--name');
  for (const k of ['WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN', 'WORKBENCH_AGENT_ID']) need(!!env[k], k);
  // The markers of a surrounding Claude Code session must be gone; the person's own CLAUDE_CODE_* settings may stay.
  // So must the editor's variables and Workbench's own choice of programs.
  for (const k of Object.keys(env)) need(!/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_|MESSAGING_|SSE_PORT))/.test(k), `no ${k} in the environment`);
  for (const k of Object.keys(env)) need(!/^(VSCODE_.*|ELECTRON_RUN_AS_NODE|GIT_EDITOR|WORKBENCH_CLAUDE_BIN|WORKBENCH_CODEX_BIN)$/.test(k), `no ${k} in the environment`);
  if (env.FAKE_CLAUDE_EXPECT_BUDGET) need(value('--max-budget-usd') === env.FAKE_CLAUDE_EXPECT_BUDGET, `--max-budget-usd ${env.FAKE_CLAUDE_EXPECT_BUDGET}`);
  if (problems.length) {
    process.stderr.write(`fake claude: bad launch: ${problems.join(', ')}\n`);
    process.exit(3);
  }

  const session = resume || sessionArg;
  const stubborn = !!env.FAKE_CLAUDE_STUBBORN;
  if (stubborn) process.on('SIGTERM', () => {});
  const hooks = env.FAKE_CLAUDE_HOOKS === '1';
  if (env.FAKE_CLAUDE_PIDFILE) writeFileSync(env.FAKE_CLAUDE_PIDFILE, String(process.pid));
  if (env.FAKE_CLAUDE_ENVDIR) writeFileSync(path.join(env.FAKE_CLAUDE_ENVDIR, `${env.WORKBENCH_AGENT_ID}.json`), JSON.stringify({ url: env.WORKBENCH_HOOK_URL, token: env.WORKBENCH_HOOK_TOKEN }));

  // Output, optionally cut into small pieces written a moment apart.
  let queue = Promise.resolve();
  const write = (text) => {
    if (env.FAKE_CLAUDE_CHUNKY !== '1') { process.stdout.write(text); return; }
    const buf = Buffer.from(text, 'utf8');
    const sizes = [1, 7, 3, 4093, 13, 65536, 2];
    queue = queue.then(async () => {
      for (let i = 0, k = 0; i < buf.length; k++) {
        const n = sizes[k % sizes.length];
        process.stdout.write(buf.subarray(i, i + n));
        i += n;
        if (k % 8 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    });
  };
  const out = (obj) => write(JSON.stringify(obj) + '\n');

  let n = 0;
  let cost = 0;
  function reply(text) {
    n++;
    cost += 0.01;
    out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake-1', cwd: process.cwd(), claude_code_version: VERSION, tools: ['Task', 'Bash', 'Edit', 'Read', 'Write'] });
    out({
      type: 'assistant', parent_tool_use_id: null, session_id: session,
      message: { id: `msg_fake_${n}`, model: 'claude-fake-1', role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    out({
      type: 'result', subtype: 'success', is_error: false, result: text, session_id: session,
      total_cost_usd: Math.round(cost * 100) / 100,
      modelUsage: { 'claude-fake-1': { inputTokens: 5 * n, outputTokens: 2 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } },
    });
  }

  function replay(file) {
    let lines = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
    if (env.FAKE_CLAUDE_FIXTURE_LINES) lines = lines.slice(0, Number(env.FAKE_CLAUDE_FIXTURE_LINES));
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.session_id) obj.session_id = session;
      out(obj);
    }
  }

  // The hook's environment as Claude Code makes it: the process's, then the `env` of the repository's committed
  // .claude/settings.json (--setting-sources project), then the `env` of --settings, which outranks it.
  let repoEnv = {};
  try { repoEnv = JSON.parse(readFileSync(path.join(process.cwd(), '.claude', 'settings.json'), 'utf8')).env || {}; } catch { /* none */ }
  const hookEnv = { ...env, ...repoEnv, ...pinned };

  /** Run the PreToolUse hook as Claude Code does. Resolves to { decision: 'allow'|'deny'|'block'|'error'|'none', reason }. */
  function runHook(payload) {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', hook.command], { env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      if (env.FAKE_CLAUDE_PIDFILE && child.pid) writeFileSync(env.FAKE_CLAUDE_PIDFILE + '.hook', String(child.pid));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdin.on('error', () => {});
      child.on('error', (err) => resolve({ decision: 'error', reason: err.message }));
      child.on('close', (code) => {
        if (code === 2) return resolve({ decision: 'block', reason: stderr.trim() });
        if (code !== 0) return resolve({ decision: 'error', reason: `The hook failed (exit ${code}). ${stderr.trim()}` });
        let o = null;
        try { o = JSON.parse(stdout); } catch { o = null; }
        const h = o && o.hookSpecificOutput;
        const d = h && h.permissionDecision;
        resolve({ decision: d === 'allow' || d === 'deny' ? d : 'none', reason: (h && h.permissionDecisionReason) || '' });
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async function replayWithHooks(file) {
    const cwd = process.cwd();
    const delay = Number(env.FAKE_CLAUDE_DELAY_MS) || 0;
    const rootBash = env.FAKE_CLAUDE_ROOT_BASH || '';
    const lines = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
    const helperOf = new Map(); // the Agent call's tool_use id -> { task, type } from task_started
    const verdicts = new Map(); // tool_use id -> hook result
    const replaced = new Set(); // tool_use ids whose command was replaced
    for (const line of lines) {
      const obj = JSON.parse(line.split('/workspace/repo').join(cwd));
      if (obj.session_id) obj.session_id = session;
      if (obj.type === 'system' && obj.subtype === 'task_started' && obj.tool_use_id) {
        helperOf.set(obj.tool_use_id, { task: obj.task_id, type: obj.subagent_type || null });
      }
      const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
      if (obj.type === 'user') {
        obj.message.content = content.map((b) => {
          if (!b || b.type !== 'tool_result') return b;
          const v = verdicts.get(b.tool_use_id);
          if (v && v.decision !== 'allow') return { type: 'tool_result', content: v.reason || 'A hook blocked this.', is_error: true, tool_use_id: b.tool_use_id };
          if (replaced.has(b.tool_use_id)) return { type: 'tool_result', content: '', is_error: false, tool_use_id: b.tool_use_id };
          return b;
        });
      }
      const calls = obj.type === 'assistant' ? content.filter((b) => b && b.type === 'tool_use') : [];
      for (const c of calls) {
        if (rootBash && c.name === 'Bash' && !obj.parent_tool_use_id) { c.input = { command: rootBash }; replaced.add(c.id); }
      }
      out(obj);
      for (const c of calls) {
        const payload = { session_id: session, cwd, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: c.name, tool_input: c.input, tool_use_id: c.id };
        const helper = obj.parent_tool_use_id ? helperOf.get(obj.parent_tool_use_id) : null;
        if (helper) { payload.agent_id = helper.task; if (helper.type) payload.agent_type = helper.type; }
        const v = await runHook(payload);
        verdicts.set(c.id, v);
        const touch = c.name === 'Bash' && /^touch ([\w.-]+)$/.exec(String(c.input && c.input.command));
        if (v.decision === 'allow' && touch) writeFileSync(path.join(cwd, touch[1]), '');
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
  }

  let first = true;
  let busy = Promise.resolve(); // with FAKE_CLAUDE_HOOKS: later messages wait for the replay
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write('fake claude: stdin line is not JSON\n'); process.exit(4); }
    const block = msg && msg.type === 'user' && msg.message && msg.message.role === 'user' && Array.isArray(msg.message.content) ? msg.message.content[0] : null;
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      process.stderr.write('fake claude: stdin message has the wrong shape\n');
      process.exit(4);
    }
    const text = block.text;
    const isFirst = first;
    first = false;
    if (hooks) {
      const job = isFirst && !resume && env.FAKE_CLAUDE_FIXTURE ? () => replayWithHooks(env.FAKE_CLAUDE_FIXTURE) : () => answer(text);
      busy = busy.then(job).catch((err) => { process.stderr.write(`fake claude: replay failed: ${err.message}\n`); process.exit(5); });
      return;
    }
    if (isFirst && !resume && env.FAKE_CLAUDE_FIXTURE) return replay(env.FAKE_CLAUDE_FIXTURE);
    answer(text);
  });

  function answer(text) {
    let m;
    if (text === 'spawn a child') {
      const code = stubborn ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)';
      const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
      return reply(`child ${child.pid}`);
    }
    if ((m = /^exit (\d+)$/.exec(text))) {
      process.stderr.write(`fake claude: asked to exit with ${m[1]}\n`);
      return queue.then(() => process.exit(Number(m[1])));
    }
    if ((m = /^long (\d+)$/.exec(text))) return reply('x'.repeat(Number(m[1]) - 1) + '✓');
    reply(resume ? `You said (resumed ${resume} with budget ${value('--max-budget-usd')}): ${text}` : `You said: ${text}`);
  }
  rl.on('close', () => {
    if (stubborn) { setInterval(() => {}, 1000); return; }
    if (hooks) { busy.then(() => queue).then(() => process.stdout.write('', () => process.exit(0))); return; }
    queue.then(() => process.stdout.write('', () => process.exit(0)));
  });
}
