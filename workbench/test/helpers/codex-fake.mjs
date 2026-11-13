#!/usr/bin/env node
// A stand-in for the `codex` binary in the runner tests. It never contacts anything.
//
// It parses the arguments the runner uses the way codex-cli 0.166.0 does (see `codex exec --help` and
// `codex exec resume --help`): unknown options exit 2 as clap would, and `resume` rejects -C and --sandbox
// because the real one does. It records each call, then replays a fixture.
//
// Environment:
//   FAKE_CODEX_LOG       file that gets one JSON line per call: { argv, cwd, stdin, env, pid, grandchild? }
//   FAKE_CODEX_MODE      replay (default) | hang | stubborn | fail | crash | fail-first
//                        fail-first: the first `exec` starts its turn, waits FAKE_CODEX_DELAY_MS, then fails as
//                        `fail` does; `exec resume` replays normally (FAKE_CODEX_MODE applies to every call)
//   FAKE_CODEX_DELAY_MS  pause between replayed lines (default 0)
//   FAKE_CODEX_LOGIN     in (default) | out | apikey, for `login status`; FAKE_CODEX_LOGIN_FILE, when that file exists,
//                        holds the mode instead (the sign-in `login` keeps)
//   FAKE_CODEX_SIGNIN    `codex login`, with no terminal: it says it started its local login server and the address to
//                        open, then after FAKE_CODEX_SIGNIN_DELAY_MS (default 0): ok (default: keeps "in" in
//                        FAKE_CODEX_LOGIN_FILE, "Successfully logged in", exit 0) | fail (exit 1) | ok-unsaved (exit 0,
//                        keeps nothing) | signed-in-stay (keeps it, goes on running) | wait (waits for a browser
//                        nobody answers) | input (asks for a code to be typed, and waits). It records the call in
//                        FAKE_CODEX_LOG, with `terminal`: whether it could open /dev/tty
//   FAKE_CODEX_VERSION   hang: `--version` never answers
//   FAKE_CODEX_WRITE     replay: before the turn's last line, write this file (relative, in the working folder)
//                        with the text "written by the fake codex\n"; on `exec resume` too
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const env = process.env;
const FIXTURES = new URL('../fixtures/', import.meta.url);
const SELF_DESTRUCT_MS = 20_000; // a hanging fake never outlives a broken test run for long

// Options that take a value, and plain flags, per subcommand (only the ones the runner might pass).
const EXEC = { values: new Set(['-c', '--config', '-m', '--model', '-C', '--cd', '-s', '--sandbox']), flags: new Set(['--json', '--skip-git-repo-check', '--ephemeral']) };
const RESUME = { values: new Set(['-c', '--config', '-m', '--model']), flags: new Set(['--json', '--skip-git-repo-check', '--ephemeral', '--last', '--all']) };

// Variables the tests look for. Only presence is recorded, apart from two harmless values.
const WATCHED = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_EXEC_SERVER_URL',
  'WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN', 'CODEX_HOME', 'CODEX_API_KEY', 'WORKBENCH_AGENT_ID',
  'WORKBENCH_CLAUDE_BIN', 'WORKBENCH_CODEX_BIN', 'VSCODE_IPC_HOOK', 'ELECTRON_RUN_AS_NODE', 'GIT_EDITOR'];

function usageError(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
}

function stdinKind() {
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO() || st.isSocket()) return 'pipe';
    if (st.isCharacterDevice()) return 'ignored';
    return 'other';
  } catch {
    return 'closed';
  }
}

function parseOptions(list, spec) {
  const out = { flags: new Set(), values: new Map(), positionals: [] };
  let escaped = false;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!escaped && a === '--') { escaped = true; continue; }
    if (!escaped && a.startsWith('-') && a !== '-') {
      if (spec.flags.has(a)) { out.flags.add(a); continue; }
      if (spec.values.has(a)) {
        if (i + 1 >= list.length) return { error: `a value is required for '${a}'` };
        const name = { '--config': '-c', '--model': '-m', '--cd': '-C', '-s': '--sandbox' }[a] || a;
        out.values.set(name, [...(out.values.get(name) || []), list[++i]]);
        continue;
      }
      return { error: `unexpected argument '${a}' found` };
    }
    out.positionals.push(a);
  }
  return out;
}

const one = (parsed, name) => (parsed.values.get(name) || [])[0];
const write = (stream, text) => new Promise(resolve => stream.write(text, resolve));

function record(extra = {}) {
  if (!env.FAKE_CODEX_LOG) return;
  const seen = Object.fromEntries(WATCHED.map(k => [k, k in env]));
  const line = { argv: args, cwd: process.cwd(), stdin: stdinKind(), env: seen, agentId: env.WORKBENCH_AGENT_ID ?? null, codexHome: env.CODEX_HOME ?? null, pid: process.pid, ...extra };
  fs.appendFileSync(env.FAKE_CODEX_LOG, JSON.stringify(line) + '\n');
}

function fixtureLines(name, threadId) {
  return fs.readFileSync(new URL(name, FIXTURES), 'utf8').split('\n').filter(l => l.trim()).map(line => {
    const obj = JSON.parse(line);
    if (obj.type === 'thread.started' && threadId) obj.thread_id = threadId; // a resume reports the thread it continues
    return JSON.stringify(obj);
  });
}

function stayAlive() {
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(0), SELF_DESTRUCT_MS).unref();
}

/** Whether this process has a terminal of its own to ask in (/dev/tty opens). */
function hasTerminal() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'r'));
    return true;
  } catch {
    return false;
  }
}

/** `codex login`, as FAKE_CODEX_SIGNIN says (see the top of this file). A waiting one ends by itself (exit 9). */
async function login() {
  record({ terminal: hasTerminal() });
  const mode = env.FAKE_CODEX_SIGNIN || 'ok';
  const wait = () => {
    setInterval(() => {}, 1000);
    setTimeout(() => process.exit(9), SELF_DESTRUCT_MS).unref();
  };
  if (mode === 'input') {
    await write(process.stdout, 'Enter the code shown in your browser: ');
    return wait();
  }
  await write(process.stderr, 'Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n'
    + 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake-client&state=fake-state-not-a-secret\n');
  if (mode === 'wait') return wait();
  await sleep(Number(env.FAKE_CODEX_SIGNIN_DELAY_MS) || 0);
  if (mode === 'fail') {
    await write(process.stderr, 'Error logging in: the sign-in was refused\n');
    process.exitCode = 1;
    return;
  }
  if (mode !== 'ok-unsaved' && env.FAKE_CODEX_LOGIN_FILE) fs.writeFileSync(env.FAKE_CODEX_LOGIN_FILE, 'in\n');
  if (mode === 'signed-in-stay') return wait();
  await write(process.stderr, 'Successfully logged in\n');
}

async function run({ resume, parsed }) {
  const mode = env.FAKE_CODEX_MODE || 'replay';
  const threadId = resume ? parsed.positionals[0] : null;
  const delay = Number(env.FAKE_CODEX_DELAY_MS) || 0;

  if (mode === 'hang' || mode === 'stubborn') {
    // Stubborn from the start: a stop that follows the first line at once must still find SIGTERM ignored.
    if (mode === 'stubborn') process.on('SIGTERM', () => {});
    // A command that keeps running, in Codex's process group, holding the same stdout. It says on fd 3 when it is
    // ready (its own SIGTERM handler in place), and only then does the turn begin: on a busy machine a node process
    // takes a while to start, and a SIGTERM that came first would end it.
    const keep = `${mode === 'stubborn' ? "process.on('SIGTERM', () => {});" : ''} require('node:fs').writeSync(3, 'ready'); require('node:fs').closeSync(3); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), ${SELF_DESTRUCT_MS});`;
    const grandchild = spawn(process.execPath, ['-e', keep], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
    record({ grandchild: grandchild.pid });
    await new Promise((resolve) => {
      grandchild.stdio[3].once('data', resolve);
      grandchild.stdio[3].once('close', resolve);
      grandchild.once('error', resolve);
    });
    const [started] = fixtureLines('codex-run.jsonl', threadId);
    await write(process.stdout, `${started}\n{"type":"turn.started"}\n`);
    await write(process.stdout, JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/zsh -lc 'npm test -- --watch'", aggregated_output: '', exit_code: null, status: 'in_progress' } }) + '\n');
    return stayAlive();
  }

  record();
  if (mode === 'crash') {
    await write(process.stderr, "thread 'main' panicked at src/main.rs:1:1:\nboom\n");
    process.exitCode = 101;
    return;
  }
  if (mode === 'fail' || (mode === 'fail-first' && !resume)) {
    const message = 'unexpected status 401 Unauthorized: {"error":{"message":"Missing bearer authentication"}}';
    const [started] = fixtureLines('codex-run.jsonl', threadId);
    await write(process.stdout, [started, '{"type":"turn.started"}'].join('\n') + '\n');
    if (mode === 'fail-first' && delay) await sleep(delay); // a message can arrive while this turn runs
    await write(process.stdout, [JSON.stringify({ type: 'error', message }), JSON.stringify({ type: 'turn.failed', error: { message } })].join('\n') + '\n');
    await write(process.stderr, 'ERROR: unexpected status 401 Unauthorized\n');
    process.exitCode = 1;
    return;
  }
  const lines = fixtureLines(resume ? 'codex-resume.jsonl' : 'codex-run.jsonl', threadId);
  for (const [i, line] of lines.entries()) {
    if (env.FAKE_CODEX_WRITE && i === lines.length - 1) fs.writeFileSync(env.FAKE_CODEX_WRITE, 'written by the fake codex\n');
    await write(process.stdout, line + '\n');
    if (delay) await sleep(delay);
  }
}

async function main() {
  // No arguments: a bare `node --test` runs every file under test/, this one included. Do nothing.
  if (args.length === 0) return;
  if (args[0] === '--version' || args[0] === '-V') {
    if (env.FAKE_CODEX_VERSION === 'hang') return stayAlive();
    return write(process.stdout, 'codex-cli 0.166.0\n');
  }
  if (args[0] === 'login' && args[1] === 'status') {
    const kept = env.FAKE_CODEX_LOGIN_FILE && fs.existsSync(env.FAKE_CODEX_LOGIN_FILE) ? fs.readFileSync(env.FAKE_CODEX_LOGIN_FILE, 'utf8').trim() : '';
    const mode = kept || env.FAKE_CODEX_LOGIN || 'in';
    if (mode === 'out') { process.exitCode = 1; return write(process.stderr, 'Not logged in\n'); }
    return write(process.stderr, mode === 'apikey' ? 'Logged in using an API key - sk-proj-***ABCDE\n' : 'Logged in using ChatGPT\n');
  }
  if (args[0] === 'login' && args.length === 1) return login();
  if (args[0] !== 'exec') return usageError(`unrecognized subcommand '${args[0] ?? ''}'`);

  const resume = args[1] === 'resume';
  const parsed = parseOptions(args.slice(resume ? 2 : 1), resume ? RESUME : EXEC);
  if (parsed.error) return usageError(parsed.error);
  if (!parsed.flags.has('--json')) return usageError('expected --json');
  if (stdinKind() === 'pipe') return usageError('stdin is open; with a prompt given, codex would wait for it to close');

  if (resume) {
    if (!(parsed.values.get('-c') || []).includes('sandbox_mode="workspace-write"')) return usageError('expected -c sandbox_mode="workspace-write"');
    if (parsed.positionals.length !== 2 || !parsed.positionals[0] || !parsed.positionals[1]) return usageError('expected <SESSION_ID> <PROMPT>');
  } else {
    const dir = one(parsed, '-C');
    if (!dir || !fs.existsSync(dir)) return usageError('expected -C <existing folder>');
    if (one(parsed, '--sandbox') !== 'workspace-write') return usageError('expected --sandbox workspace-write');
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) return usageError('expected exactly one prompt');
  }
  return run({ resume, parsed });
}

await main();
