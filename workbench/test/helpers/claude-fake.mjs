#!/usr/bin/env node
// A stand-in for the `claude` binary, used by test/claude-runner.test.mjs through WORKBENCH_CLAUDE_BIN.
// It never talks to a network and never spends anything.
//
// - With no arguments it exits 0 at once (the test runner may load every file under test/).
// - `--version` prints a version (or hangs, with FAKE_CLAUDE_VERSION=hang).
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
// - It exits 0 when stdin closes, unless FAKE_CLAUDE_STUBBORN is set: then it ignores SIGTERM and stdin
//   closing, and only SIGKILL ends it (its grandchildren ignore SIGTERM too).
// - FAKE_CLAUDE_CHUNKY=1 writes its output in small pieces, cutting lines and characters apart.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const env = process.env;

if (argv.length === 0) {
  // Started with no arguments, as `node --test test/` does with every file under test/: nothing to do.
  process.exit(0);
} else if (argv.includes('--version')) {
  if (env.FAKE_CLAUDE_VERSION === 'hang') setInterval(() => {}, 1000);
  else { process.stdout.write('2.1.221 (Claude Code)\n'); process.exit(0); }
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
  need(value('--setting-sources') === 'project,local', '--setting-sources project,local');
  need(argv.includes('--strict-mcp-config'), '--strict-mcp-config');
  need(String(value('--disallowedTools') || '').split(' ').includes('AskUserQuestion'), '--disallowedTools');
  let hook = null;
  try { hook = JSON.parse(value('--settings')).hooks.PreToolUse[0].hooks[0]; } catch { hook = null; }
  need(hook && hook.type === 'command' && hook.timeout === 1800 && /hook-bridge\.mjs'$/.test(hook.command), 'a PreToolUse hook in --settings');
  need(String(value('--append-system-prompt') || '').startsWith('You are running inside Workbench'), '--append-system-prompt');
  need(Number(value('--max-budget-usd')) > 0, '--max-budget-usd');
  const resume = value('--resume');
  const sessionArg = value('--session-id');
  need(!!resume !== !!sessionArg, 'exactly one of --session-id and --resume');
  need(!!value('--name'), '--name');
  for (const k of ['WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN', 'WORKBENCH_AGENT_ID']) need(!!env[k], k);
  for (const k of Object.keys(env)) need(!/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK)/.test(k), `no ${k} in the environment`);
  if (env.FAKE_CLAUDE_EXPECT_BUDGET) need(value('--max-budget-usd') === env.FAKE_CLAUDE_EXPECT_BUDGET, `--max-budget-usd ${env.FAKE_CLAUDE_EXPECT_BUDGET}`);
  if (problems.length) {
    process.stderr.write(`fake claude: bad launch: ${problems.join(', ')}\n`);
    process.exit(3);
  }

  const session = resume || sessionArg;
  const stubborn = !!env.FAKE_CLAUDE_STUBBORN;
  if (stubborn) process.on('SIGTERM', () => {});

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
    out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-fake-1', cwd: process.cwd() });
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

  let first = true;
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
    if (isFirst && !resume && env.FAKE_CLAUDE_FIXTURE) return replay(env.FAKE_CLAUDE_FIXTURE);

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
  });
  rl.on('close', () => {
    if (stubborn) { setInterval(() => {}, 1000); return; }
    queue.then(() => process.stdout.write('', () => process.exit(0)));
  });
}
