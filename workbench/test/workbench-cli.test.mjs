// The CLI: its argument handling (these cases stop before any module is loaded), the refusal inside an agent, and
// what it says when it starts. The starts use a throwaway repository, a temporary HOME, stand-ins for Claude Code and
// Codex, and a PATH without them; Workbench is stopped as soon as it has said where it runs. No agent is started.
// Also the files at the top of this repository that run Workbench on itself (package.json, workbench.json, CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync, accessSync, existsSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as workspace from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';
import { Engine } from '../src/core/engine.mjs';
// Imported, the CLI only exports its parts: it starts only when run as a program.
import { parseArgs, createLogger, displayUrl, cloneFirst, connectGithubMode, githubReposMode, readLine } from '../bin/workbench.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const ACCEPT = fileURLToPath(new URL('../scripts/accept-real.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';
/** Merge and throw-away are there: the git work (builder A) and the engine's cards (builder B). */
const MERGE_READY = typeof workspace.mergeWork === 'function' && typeof workspace.discardWork === 'function'
  && typeof Engine?.prototype?.proposeMerge === 'function' && typeof Engine?.prototype?.proposeDiscard === 'function';
const NO_IDENTITY = 'Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com';
const NO_AGENT = 'No coding agent is ready yet. Open the page to connect one.';
/** Agents & keys and cloning are there: the key store (U1), the connect service and cloneRepo (U2). */
const CONNECT_READY = existsSync(fileURLToPath(new URL('../src/core/connect.mjs', import.meta.url))) && existsSync(fileURLToPath(new URL('../src/core/keys.mjs', import.meta.url)));
const CLONE_READY = typeof workspace.cloneRepo === 'function';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 10_000, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

/** The git program on this machine's PATH, so a test PATH can hold git and nothing else of ours. */
function realGit() {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, 'git');
    try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch { /* not here */ }
  }
  return '/usr/bin/git';
}

/**
 * A throwaway repository with one commit of `files` on the branch main, a home folder with no git name or email, and
 * an environment for the CLI: no inherited agent id or program choices, the real Codex never reachable, and a PATH
 * that holds git only (no node: Workbench must put its own in front for the agents and checks that need it).
 */
function setup(t, { files = { 'README.md': '# test\n' } } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(path.join(dir, 'tmp'));
  symlinkSync(realGit(), path.join(bin, 'git'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(repo, name), text);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', TMPDIR: path.join(dir, 'tmp'),
    PATH: `${bin}:/usr/bin:/bin`, WORKBENCH_CODEX_BIN: path.join(dir, 'no-codex-here'),
  };
  for (const k of ['WORKBENCH_AGENT_ID', 'WORKBENCH_CLAUDE_BIN', 'WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'CLAUDE_CONFIG_DIR']) delete env[k];
  return { dir, repo, home, env, git };
}

/**
 * Start the CLI, wait until it is running (or has stopped by itself), then stop it with Ctrl-C.
 * @returns {Promise<{ code: number|null, out: string, err: string, lines: string[] }>}
 */
async function start(t, args, env) {
  const proc = spawn(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  const deadline = Date.now() + 20_000;
  while (!/Press Ctrl-C to stop\./.test(out) && proc.exitCode == null && Date.now() < deadline) await sleep(25);
  if (proc.exitCode == null) proc.kill('SIGINT');
  const code = await Promise.race([exited, sleep(15_000).then(() => 'still running')]);
  return { code, out, err, lines: out.split('\n') };
}

/** A VS Code extension folder whose claude program says it is `version`. */
function extension(home, version) {
  const dir = path.join(home, '.vscode', 'extensions', `anthropic.claude-code-${version}-${process.platform}-${process.arch}`, 'resources', 'native-binary');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexit 3\n`, { mode: 0o755 });
  return path.join(dir, 'claude');
}

test('without --repo or --demo it explains what it needs', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Workbench needs a git repository to work on\. Run it with --repo/);
  assert.match(r.stderr, /--demo/);
});

test('--help prints the usage and exits cleanly', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /node bin\/workbench\.mjs --demo \[--port 4317\] \[--no-open\]/);
  assert.match(r.stdout, /node bin\/workbench\.mjs --repo <path> \[--budget 2\] \[--model <name>\] \[--claude <path>\]/);
  assert.match(r.stdout, /--claude <path> {5}the Claude Code program to run\. Without it: WORKBENCH_CLAUDE_BIN, then claude on the\n {22}PATH, then the newest Claude Code extension in VS Code or Cursor/);
});

test('bad options get plain messages', async () => {
  const cases = [
    [['--demo', '--port', 'abc'], /The port must be a whole number from 0 to 65535/],
    [['--demo', '--port=70000'], /The port must be a whole number/],
    [['--demo', '--repo', '.'], /Choose one: --demo/],
    [['--demo', '--bogus'], /I don't know the option “--bogus”/],
    [['--repo', '.', '--budget', '-1'], /The budget must be a positive number/],
    [['--repo'], /--repo needs a value/],
    [['--repo', '--demo'], /--repo needs a value/],
    [['--repo', '.', '--claude'], /--claude needs a value/],
    [['--repo', '.', '--claude='], /--claude needs the path of the Claude Code program\./],
    [['--repo', '.', '--claude', '  '], /--claude needs the path of the Claude Code program\./],
  ];
  for (const [args, message] of cases) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
});

test('--app: one line the Mac app reads, no browser, and Workbench stops when the app closes its standard input', async (t) => {
  const w = setup(t);
  const proc = spawn(process.execPath, [BIN, '--demo', '--app', '--port', '0'], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  const deadline = Date.now() + 20_000;
  let m;
  while (!(m = /^WORKBENCH_APP (\{.*\})$/m.exec(out)) && proc.exitCode == null && Date.now() < deadline) await sleep(25);
  assert.ok(m, out);
  const ready = JSON.parse(m[1]);
  assert.equal(ready.demo, true);
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
  const url = new URL(ready.url);
  const res = await fetch(`${url.origin}/api/state`, { headers: { 'X-Workbench-Token': url.searchParams.get('t') } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).mode, 'demo');
  // The app quits: its end of the pipe closes, and Workbench stops as on Ctrl-C.
  proc.stdin.end();
  const code = await Promise.race([exited, sleep(15_000).then(() => 'still running')]);
  assert.equal(code, 0, out);
  assert.match(out, /Stopping the agents and closing Workbench/);
});

test('--app: when the app crashes, nothing reads what Workbench prints any more, and it still stops at once', async (t) => {
  const w = setup(t);
  const proc = spawn(process.execPath, [BIN, '--demo', '--app', '--port', '0'], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  const deadline = Date.now() + 20_000;
  while (!/^WORKBENCH_APP /m.test(out) && proc.exitCode == null && Date.now() < deadline) await sleep(25);
  assert.match(out, /^WORKBENCH_APP /m);
  // A crash closes the app's ends of all three pipes: Workbench's input ends, and its writes find no reader (EPIPE).
  // Each failed write must not become an unexpected error whose report is another failed write: that loop kept the
  // shutdown from running until the forced exit, 12 seconds later.
  const started = Date.now();
  proc.stdout.destroy();
  proc.stderr.destroy();
  proc.stdin.end();
  const ex = await Promise.race([exited, sleep(15_000).then(() => null)]);
  assert.ok(ex, 'Workbench did not stop within 15 seconds');
  assert.deepEqual(ex, { code: 0, signal: null });
  assert.ok(Date.now() - started < 5000, `Workbench took ${Date.now() - started} ms to stop`);
});

test('inside an agent, Workbench will not start real agents; the demo still starts', async (t) => {
  const w = setup(t);
  // An agent working on this repository runs `node bin/workbench.mjs --repo .`: it is refused before anything loads.
  for (const args of [['--repo', w.repo, '--no-open', '--port', '0'], ['--repo', w.repo, '--claude', FAKE]]) {
    const r = await run(args, { ...w.env, WORKBENCH_AGENT_ID: 'a1b2c3', WORKBENCH_CLAUDE_BIN: FAKE });
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stderr, `${INSIDE_AGENT}\n`);
    assert.equal(r.stdout, '');
  }
  // Set, even to nothing, counts.
  assert.equal((await run(['--repo', w.repo], { ...w.env, WORKBENCH_AGENT_ID: '' })).stderr, `${INSIDE_AGENT}\n`);
  // Simulated agents spend nothing and reach nobody.
  const demo = await start(t, ['--demo', '--no-open', '--port', '0'], { ...w.env, WORKBENCH_AGENT_ID: 'a1b2c3' });
  assert.equal(demo.code, 0, demo.err);
  assert.match(demo.out, /Workbench is running at http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}/);
  assert.match(demo.out, /This is the demo/);
});

test('scripts/accept-real.mjs will not run inside an agent either', async (t) => {
  const w = setup(t);
  // Doubly safe: the script must refuse before it starts Workbench, and Claude Code could not be found anyway.
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [ACCEPT, w.repo], { timeout: 10_000, env: { ...w.env, WORKBENCH_AGENT_ID: 'a1b2c3', WORKBENCH_CLAUDE_BIN: path.join(w.dir, 'no-claude-here') } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
  assert.equal(r.code, 2);
  assert.equal(r.stderr, `${INSIDE_AGENT}\n`);
  assert.equal(r.stdout, '');
});

test('the start says which Claude Code is ready and where it was found, with one full stop', async (t) => {
  const w = setup(t);
  // The VS Code extension, found by itself: the owner's Mac has no claude on its PATH.
  extension(w.home, '2.1.322');
  const found = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(found.code, 0, found.err);
  assert.equal(found.lines[0], 'Claude Code 2.1.322 is ready (from the VS Code extension).');
  assert.equal(found.lines[1], 'Codex is not available: Codex is not installed, or the codex command could not be found.');
  assert.ok(!/\.\.(\s|$)/m.test(found.out + found.err), 'no doubled full stop');
  assert.match(found.out, /Workbench is running at http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}/);
  // --claude, then WORKBENCH_CLAUDE_BIN, win over the extension, and say so.
  const flag = await start(t, ['--repo', w.repo, '--no-open', '--port', '0', '--claude', FAKE], { ...w.env, WORKBENCH_CLAUDE_BIN: path.join(w.dir, 'not-this-one'), FAKE_CLAUDE_VERSION: '2.1.400' });
  assert.equal(flag.code, 0, flag.err);
  assert.equal(flag.lines[0], 'Claude Code 2.1.400 is ready (from --claude).');
  const variable = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...w.env, WORKBENCH_CLAUDE_BIN: FAKE });
  assert.equal(variable.code, 0, variable.err);
  assert.equal(variable.lines[0], 'Claude Code 2.1.221 is ready (from WORKBENCH_CLAUDE_BIN).');
});

test('with no agent program ready, Workbench starts anyway, says so, and says how to point it at Claude Code', async (t) => {
  const w = setup(t);
  const none = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(none.code, 0, none.err);
  assert.deepEqual(none.lines.slice(0, 3), [
    'Claude Code is not available: Claude Code was not found: there is no claude command on the PATH, and no Claude Code extension in VS Code or Cursor. Tell Workbench where it is with --claude <path>, or with WORKBENCH_CLAUDE_BIN.',
    'Codex is not available: Codex is not installed, or the codex command could not be found.',
    NO_AGENT,
  ]);
  assert.match(none.lines[3], /^Workbench is running at http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
  assert.ok(none.lines.includes('Press Ctrl-C to stop.'), none.out);
  assert.doesNotMatch(none.out + none.err, /could not find Claude Code or Codex|nothing to run/, 'the old exit is gone (the Mac app looked for it)');
  // A path that is not there gets its own reason, even with a Claude Code in VS Code; Workbench still starts.
  extension(w.home, '2.1.322');
  const missing = path.join(w.dir, 'nope', 'claude');
  const wrong = await start(t, ['--repo', w.repo, '--no-open', '--port', '0', '--claude', missing], w.env);
  assert.equal(wrong.code, 0, wrong.err);
  assert.deepEqual(wrong.lines.slice(0, 3), [
    `Claude Code is not available: Claude Code is not at ${missing}, the path given with --claude.`,
    'Codex is not available: Codex is not installed, or the codex command could not be found.',
    NO_AGENT,
  ]);
  const wrongVar = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...w.env, WORKBENCH_CLAUDE_BIN: missing });
  assert.equal(wrongVar.code, 0, wrongVar.err);
  assert.equal(wrongVar.lines[0], `Claude Code is not available: Claude Code is not at ${missing}, the path in WORKBENCH_CLAUDE_BIN.`);
  assert.equal(wrongVar.lines[2], NO_AGENT);
  // With Claude Code found, nothing is said about connecting one.
  const found = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(found.lines[0], 'Claude Code 2.1.322 is ready (from the VS Code extension).');
  assert.ok(!found.out.includes(NO_AGENT), found.out);
});

test('with no agent program ready, the page works: the board answers, and Agents & keys is there to connect one', async (t) => {
  const w = setup(t);
  const proc = spawn(process.execPath, [BIN, '--repo', w.repo, '--app', '--port', '0'], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  const deadline = Date.now() + 20_000;
  let m;
  while (!(m = /^WORKBENCH_APP (\{.*\})$/m.exec(out)) && proc.exitCode == null && Date.now() < deadline) await sleep(25);
  assert.ok(m, out);
  assert.ok(out.split('\n').includes(NO_AGENT), out);
  const url = new URL(JSON.parse(m[1]).url);
  const key = { 'X-Workbench-Token': url.searchParams.get('t') };
  const state = await fetch(`${url.origin}/api/state`, { headers: key });
  assert.equal(state.status, 200);
  const snap = await state.json();
  assert.equal(snap.mode, 'live');
  assert.deepEqual([snap.harnesses?.claude, snap.harnesses?.codex], [false, false]);
  // Agents & keys answers once its service is built (src/core/connect.mjs); until then it says it is not there.
  const panel = await fetch(`${url.origin}/api/connect`, { headers: key });
  const said = await panel.json();
  if (CONNECT_READY) {
    assert.equal(panel.status, 200, JSON.stringify(said));
    assert.equal(said.ok, true);
    assert.equal(said.status.ready, false);
  } else {
    assert.equal(panel.status, 404);
    assert.equal(said.error, 'Agents & keys is not available in this Workbench. The details are in its log.');
  }
  // Words to start work get an answer, not a crash.
  const words = await fetch(`${url.origin}/api/command`, { method: 'POST', headers: { ...key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'start an agent to fix the login' }) });
  assert.equal(words.status, 200);
  assert.equal(typeof (await words.json()).reply, 'string');
  proc.stdin.end();
  assert.equal(await Promise.race([exited, sleep(15_000).then(() => 'still running')]), 0, out);
});

test('without a git name and email, the start says merging must wait for them', { skip: typeof workspace.gitIdentity !== 'function' && 'needs gitIdentity in src/core/workspace.mjs (builder A)' }, async (t) => {
  const w = setup(t);
  const args = ['--repo', w.repo, '--no-open', '--port', '0', '--claude', FAKE];
  const unknown = await start(t, args, w.env);
  assert.equal(unknown.code, 0, unknown.err);
  assert.ok(unknown.lines.includes(NO_IDENTITY), unknown.out);
  // Both set (here in the temporary home's own git config): nothing is said.
  writeFileSync(path.join(w.home, '.gitconfig'), '[user]\n\tname = Ada Lovelace\n\temail = ada@example.invalid\n');
  const known = await start(t, args, w.env);
  assert.equal(known.code, 0, known.err);
  assert.ok(!known.out.includes('Git does not know your name'), known.out);
});

test('scripts/accept-real.mjs, dry-run with the stand-in: every step passes, merge and throw-away included, and it leaves no branch behind', {
  skip: !MERGE_READY && 'needs mergeWork and discardWork in src/core/workspace.mjs (builder A), and proposeMerge and proposeDiscard in src/core/engine.mjs (builder B)',
  timeout: 150_000,
}, async (t) => {
  const w = setup(t, {
    files: {
      'greet.js': 'export const greet = (name) => `Hello, ${name}!`;\n',
      'README.md': '# greet\n',
      'test.mjs': "import { greet } from './greet.js';\nif (greet('Ada') !== 'Hello, Ada!') process.exit(1);\n",
      'workbench.json': JSON.stringify({ checks: [{ name: 'tests', run: 'node test.mjs' }], rules: [{ say: 'Do not change greet.js', paths: ['greet.js'] }] }),
    },
  });
  // The person's own uncommitted file, which the merge leaves as it is, and a git name and email (not by git config).
  writeFileSync(path.join(w.repo, 'notes.txt'), 'My own work, not committed.\n');
  writeFileSync(path.join(w.home, '.gitconfig'), '[user]\n\tname = Ada Lovelace\n\temail = ada@example.invalid\n');
  const first = w.git('rev-parse', 'HEAD');
  // The script's own documented dry run. The stand-in is named twice over, so no real Claude Code can be reached.
  const env = { ...w.env, WORKBENCH_CLAUDE_BIN: FAKE, FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl', FAKE_CLAUDE_HOOKS: '1', FAKE_CLAUDE_ROOT_BASH: '1' };
  const r = await new Promise((resolve) => {
    execFile(process.execPath, [ACCEPT, w.repo, '--claude', FAKE], { timeout: 140_000, env },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
  const out = r.stdout + r.stderr;
  assert.equal(r.code, 0, out);
  assert.doesNotMatch(out, /\bFAIL\b/, out);
  for (const step of [
    'Merge asks first', 'its work was joined into main with a merge commit', 'both commits say which agent made them',
    'nothing else in your folder changed', 'Workbench shows it as merged', 'the git screen has the merge at the top',
    'Throw it away asks first', 'its folder and branch are gone', 'a hidden copy of its work is kept in git',
    'Workbench shows it as thrown away', 'Workbench stopped cleanly', 'no Claude Code process was left running',
  ]) assert.ok(out.includes(`PASS ${step}`), `${step}\n${out}`);
  // What it leaves: the merge commit on main, the person's own file as it was, and nothing of the agent's.
  const parents = w.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
  assert.equal(parents.length, 2, 'a merge commit');
  assert.equal(parents[0], first);
  assert.equal(readFileSync(path.join(w.repo, 'notes.txt'), 'utf8'), 'My own work, not committed.\n');
  assert.equal(w.git('for-each-ref', 'refs/heads/workbench', 'refs/workbench'), '', 'no branch or hidden copy is left');
  assert.equal(w.git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no agent folder is left');
  assert.match(out, /The merge commit [0-9a-f]{7} stays on main in /);
  // For the record: what Claude Code offered the agent (the recorded 2.1.221 run offered tools that are now turned off).
  assert.match(out, /What Claude Code offered the agent: \n.* {2}Claude Code 2\.1\.221 \(permission mode default\) offers 31 tools: Task Bash /);
  assert.match(out, / {2}Claude Code offers tools Workbench turned off for its agents: CronCreate /);
});

test('the repository runs its own tests, demo and dogfood, and checks the work of agents that work on it', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.scripts, {
    test: 'npm --prefix workbench test',
    demo: 'node workbench/bin/workbench.mjs --demo',
    dogfood: 'node workbench/bin/workbench.mjs --repo .',
    app: 'bash workbench/app/mac/build.sh --install',
  });
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
    assert.equal(pkg[k], undefined, `no ${k}`);
  }

  // workbench.json, read the way Workbench reads it: nothing in it is skipped.
  const problems = [];
  const config = workspace.normalizeConfig(JSON.parse(readFileSync(path.join(REPO_ROOT, 'workbench.json'), 'utf8')), (p) => problems.push(p));
  assert.deepEqual(problems, []);
  assert.deepEqual(config, {
    checks: [{ name: 'tests', run: 'npm test', timeoutSec: 600 }],
    rules: [
      { say: 'Do not change the research and mockups in docs/', paths: ['docs/**'] },
      { say: 'Add no packages', paths: ['**/package-lock.json', '**/node_modules/**'] },
    ],
    allow: [],
  });
  // What the rules catch, and what they leave alone: the program's own screenshots are not the research.
  const broken = (paths) => checkRules(config.rules, paths).broken;
  assert.deepEqual(broken(['workbench/src/core/engine.mjs', 'workbench/docs/screens/board-green.png', 'workbench/package.json', 'package.json', 'CLAUDE.md']), []);
  assert.deepEqual(broken(['docs/pcb/board.png', 'package-lock.json', 'workbench/package-lock.json', 'workbench/node_modules/left-pad/index.js', 'node_modules']), [
    { say: 'Do not change the research and mockups in docs/', paths: ['docs/pcb/board.png'] },
    { say: 'Add no packages', paths: ['package-lock.json', 'workbench/package-lock.json', 'workbench/node_modules/left-pad/index.js', 'node_modules'] },
  ]);

  // CLAUDE.md, for agents (and people) working on Workbench itself.
  const guide = readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  for (const words of [
    /`workbench\/ARCHITECTURE\.md` is the contract/, /change it in the same commit as the code/,
    /no third-party packages/, /Plain language in anything a person sees/,
    /Run the tests with `npm test` at the repo root/, /need Chrome/,
    /Never start a live Workbench .* or `workbench\/scripts\/accept-real\.mjs` from inside an agent/,
  ]) assert.match(guide, words);
});

// ------------------------------------------------------------------ cloning, GitHub, and the options for them

/** Run the CLI with `input` on its standard input (then closed). */
function runWithInput(args, env, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { timeout: 15_000, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** A key-shaped value made at run time, so no fixture looks like a real key to a scanner. */
const fakeToken = () => ['gh', 'p_', Buffer.from(String(Math.random())).toString('hex').slice(0, 36)].join('');

test('the options for cloning and for the Mac app’s GitHub helpers: what they take, and plain messages for what they do not', async () => {
  assert.deepEqual((({ clone, into, connectGithub, githubRepos, error }) => ({ clone, into, connectGithub, githubRepos, error }))(
    parseArgs(['--clone', ' https://github.com/octo/hello.git ', '--into', '/tmp/code', '--app'])),
  { clone: 'https://github.com/octo/hello.git', into: '/tmp/code', connectGithub: false, githubRepos: false, error: null });
  assert.equal(parseArgs(['--clone=git@github.com:octo/hello.git']).clone, 'git@github.com:octo/hello.git');
  assert.equal(parseArgs(['--connect-github']).error, null);
  assert.equal(parseArgs(['--github-repos', '--app', '--verbose']).error, null);
  const cases = [
    [['--clone'], /--clone needs a value\./],
    [['--clone', ' '], /--clone needs the address of a repository, like https:\/\/github\.com\/owner\/repo\./],
    [['--clone', 'https://github.com/o/r', '--into'], /--into needs a value\./],
    [['--clone', 'https://github.com/o/r', '--into='], /--into needs the folder to put the copy in\./],
    [['--clone', 'https://github.com/o/r', '--repo', '.'], /Choose one: --repo for a repository on this computer, or --clone to copy one first\./],
    [['--demo', '--clone', 'https://github.com/o/r'], /Choose one: --demo for simulated agents, or --clone to copy a repository and run real agents on it\./],
    [['--repo', '.', '--into', '/tmp'], /--into says where --clone puts the copy, so it needs --clone\./],
    [['--connect-github', '--github-repos'], /Choose one: --connect-github or --github-repos\./],
    [['--connect-github', '--repo', '.'], /--connect-github runs on its own, without --demo, --repo or --clone\./],
    [['--github-repos', '--demo'], /--github-repos runs on its own, without --demo, --repo or --clone\./],
    [[], /Run it with --repo <path to a git repository>, copy one with --clone <address>, or try it with simulated agents using --demo\./],
  ];
  for (const [args, message] of cases) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('inside an agent, cloning and the GitHub helpers are refused too, before anything loads', async (t) => {
  const w = setup(t);
  for (const args of [['--clone', 'https://github.com/octo/hello', '--into', w.dir], ['--clone', 'https://github.com/octo/hello', '--app'], ['--connect-github'], ['--github-repos']]) {
    const r = await runWithInput(args, { ...w.env, WORKBENCH_AGENT_ID: 'a1b2c3' }, `${fakeToken()}\n`);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stderr, `${INSIDE_AGENT}\n`, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  assert.ok(!existsSync(path.join(w.dir, 'hello')), 'nothing was cloned');
});

test('the Mac app’s GitHub helpers, run as programs: no GitHub connected means no repositories, and no token means no connection', async (t) => {
  const w = setup(t);
  // Nothing is connected in this home folder, so nothing reaches the network.
  const repos = await runWithInput(['--github-repos'], w.env, '');
  assert.equal(repos.code, 0, repos.stderr);
  assert.equal(repos.stdout, 'WORKBENCH_GITHUB_REPOS []\n');
  for (const input of ['', '\n', '   \r\n']) {
    const none = await runWithInput(['--connect-github'], w.env, input);
    assert.equal(none.code, 1, none.stderr);
    assert.equal(none.stdout, `WORKBENCH_GITHUB ${JSON.stringify({ ok: false, login: null, sentence: 'Paste a token from GitHub first.' })}\n`);
  }
});

test('--clone, run as a program: an address git must not use is refused in plain words, with the line the Mac app reads, and nothing starts', async (t) => {
  const w = setup(t);
  const into = path.join(w.dir, 'code');
  for (const app of [false, true]) {
    const r = await runWithInput(['--clone', 'ext::sh -c touch% /tmp/x', '--into', into, '--port', '0', ...(app ? ['--app'] : [])], w.env, '');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /Workbench is running/);
    const said = r.stderr.trim().split('\n').filter(l => !l.startsWith('[workbench '));
    assert.equal(said.length, 1, r.stderr);
    if (!CLONE_READY) assert.equal(said[0], 'This Workbench cannot clone a repository. Clone it with git, then open its folder.');
    const line = r.stdout.split('\n').find(l => l.startsWith('WORKBENCH_CLONE '));
    if (!app) { assert.equal(line, undefined); continue; }
    const json = JSON.parse(line.slice('WORKBENCH_CLONE '.length));
    assert.deepEqual(Object.keys(json), ['error', 'sentence']);
    assert.ok(CLONE_READY ? ['url', 'git'].includes(json.error) : json.error === 'git', line);
    assert.equal(json.sentence, said[0]);
  }
});

test('cloneFirst: progress in plain lines, or WORKBENCH_CLONE lines for the app; then the new folder', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-clone-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const fake = {
    async cloneRepo(o) {
      calls.push({ url: o.url, into: o.into, timeoutMs: o.timeoutMs });
      for (const [phase, percent] of [['counting', 10], ['counting', 100], ['receiving', 3], ['receiving', 3], ['receiving', 30], ['receiving', 31], ['receiving', 100],
        ['resolving', 100], ['checkout', 100], ['mystery', 5], [null, 1]]) o.onProgress({ phase, percent });
      return { root: path.join(o.into, 'hello') };
    },
  };
  const into = path.join(dir, 'Developer', 'new');
  const plain = [];
  const r = await cloneFirst({ workspace: fake, url: 'https://x-access-token:secret-value@github.com/octo/hello.git', into, say: (s) => plain.push(s), complain: (s) => plain.push(`ERR ${s}`) });
  assert.deepEqual(r, { root: path.join(into, 'hello') });
  assert.ok(statSync(into).isDirectory(), 'the folder to put it in is made first');
  assert.equal(calls[0].into, into);
  assert.ok(calls[0].timeoutMs >= 60_000);
  assert.deepEqual(plain, [
    `Cloning https://github.com/octo/hello.git into ${into}…`,
    'Counting what to copy: 10%', 'Counting what to copy: 100%', 'Copying: 3%', 'Copying: 30%', 'Copying: 100%',
    'Unpacking: 100%', 'Writing the files: 100%',
    `Cloned https://github.com/octo/hello.git into ${path.join(into, 'hello')}.`,
  ]);
  assert.ok(!plain.join('\n').includes('secret-value'), 'a password in the address is never printed');
  // For the app: every change as a WORKBENCH_CLONE line, and at the end the new folder (phase done), before any plain line.
  const app = [];
  await cloneFirst({ workspace: fake, url: 'git@github.com:octo/hello.git', into, app: true, say: (s) => app.push(s), complain: (s) => app.push(`ERR ${s}`) });
  assert.deepEqual(app.filter(l => l.startsWith('WORKBENCH_CLONE ')).map(l => JSON.parse(l.slice(16))), [
    { phase: 'counting', percent: 10 }, { phase: 'counting', percent: 100 }, { phase: 'receiving', percent: 3 }, { phase: 'receiving', percent: 30 },
    { phase: 'receiving', percent: 31 }, { phase: 'receiving', percent: 100 }, { phase: 'resolving', percent: 100 }, { phase: 'checkout', percent: 100 },
    { phase: 'done', percent: 100, root: path.join(into, 'hello') },
  ]);
  assert.equal(app[0], `Cloning git@github.com:octo/hello.git into ${into}…`);
  assert.deepEqual(app.slice(1).filter(l => !l.startsWith('WORKBENCH_CLONE ')), [`Cloned git@github.com:octo/hello.git into ${path.join(into, 'hello')}.`]);
  assert.ok(app.indexOf(app.find(l => l.includes('"done"'))) < app.length - 1, 'the done line comes before the last plain line');
  // A stop the person asked for (Ctrl-C, the app's Cancel) reaches git as cloneRepo's signal, and fails quietly.
  const stop = new AbortController();
  let seen = null;
  const quiet = [];
  const stopped = await cloneFirst({
    workspace: { async cloneRepo(o) { seen = o.signal; stop.abort(); throw new Error('git was stopped'); } },
    url: 'https://github.com/octo/hello', into, app: true, signal: stop.signal, say: (s) => quiet.push(s), complain: (s) => quiet.push(`ERR ${s}`),
  });
  assert.deepEqual(stopped, { code: 1 });
  assert.equal(seen, stop.signal);
  assert.deepEqual(quiet, [`Cloning https://github.com/octo/hello into ${into}…`]);
  // No --into: the current folder.
  await cloneFirst({ workspace: fake, url: 'https://github.com/octo/hello', say: () => {}, complain: () => {} });
  assert.equal(calls.at(-1).into, process.cwd());
});

test('cloneFirst: each failure is one plain sentence, and for the app also its kind; git’s own words stay in the log', async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-clone-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refusing = (err) => ({ async cloneRepo() { throw err; } });
  const plainErr = (why, message) => Object.assign(new Error(message), { why, detail: 'fatal: Authentication failed for https://github.com/octo/secret.git/' });
  const cases = [
    [plainErr('auth', 'GitHub did not let Workbench read this repository. If it is private, connect your GitHub account, then try again.'), 'auth'],
    [plainErr('network', 'Workbench could not reach github.com.'), 'network'],
    [plainErr('exists', 'There is already a folder called hello in the folder you chose.'), 'exists'],
    [plainErr('url', 'Workbench can clone only https:// and ssh:// addresses, and git@host:path.'), 'url'],
    [plainErr('timeout', 'Copying the repository took too long, so Workbench stopped it.'), 'git'],
  ];
  for (const [err, kind] of cases) {
    const out = [];
    const said = [];
    const log = { debug() {}, error() {}, warn() {} };
    const r = await cloneFirst({ workspace: refusing(err), url: 'https://github.com/octo/secret.git', into: dir, app: true, say: (s) => out.push(s), complain: (s) => said.push(s), log });
    assert.deepEqual(r, { code: 1 });
    assert.deepEqual(said, [err.message]);
    assert.deepEqual(JSON.parse(out.at(-1).slice('WORKBENCH_CLONE '.length)), { error: kind, sentence: err.message });
    assert.ok(!(out.join('\n') + said.join('\n')).includes('fatal:'), 'the words of git itself are not shown');
  }
  // A refusal that repeats an address with a password in it: the address as Workbench prints it, and no password,
  // on the screen, in the line for the app, or in the log.
  const pass = `pw-${Date.now().toString(36)}-secret`;
  const withPass = `https://octo:${pass}@github.com/octo/secret.git`;
  const outs = [];
  const logs = [];
  const quoting = refusing(Object.assign(new Error(`Workbench does not clone ${withPass}: leave the password out.`), { why: 'url', detail: `fatal: could not read ${withPass}` }));
  assert.deepEqual(await cloneFirst({ workspace: quoting, url: withPass, into: dir, app: true, say: (s) => outs.push(s), complain: (s) => outs.push(s),
    log: { debug: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } }), { code: 1 });
  assert.equal(outs.at(-2), 'Workbench does not clone https://github.com/octo/secret.git: leave the password out.');
  assert.equal(JSON.parse(outs.at(-1).slice(16)).sentence, 'Workbench does not clone https://github.com/octo/secret.git: leave the password out.');
  assert.ok(logs.length && !logs.join('\n').includes(pass) && !outs.join('\n').includes(pass));
  // A token put in the address as the user name, quoted on its own: cut out too.
  const tok = fakeToken();
  const said2 = [];
  await cloneFirst({ workspace: refusing(Object.assign(new Error(`GitHub refused ${tok}.`), { why: 'auth' })), url: `https://${tok}@github.com/octo/secret.git`, into: dir,
    say: () => {}, complain: (s) => said2.push(s), log: { debug() {} } });
  assert.deepEqual(said2, ['GitHub refused ••••.']);
  // Anything else: the words of git itself go to the log only.
  const said = [];
  const logged = [];
  const crash = await cloneFirst({ workspace: refusing(new Error('fatal: early EOF')), url: 'https://github.com/octo/big', into: dir, say: () => {}, complain: (s) => said.push(s),
    log: { error: (...a) => logged.push(a.map(x => (x instanceof Error ? x.message : x)).join(' ')) } });
  assert.deepEqual(crash, { code: 1 });
  assert.deepEqual(said, ['Git could not clone https://github.com/octo/big. The details are in Workbench’s log.']);
  assert.match(logged.join('\n'), /fatal: early EOF/);
  // No cloneRepo, a folder that cannot be made, and a clone that names no folder.
  const out = [];
  assert.deepEqual(await cloneFirst({ workspace: {}, url: 'https://github.com/o/r', into: dir, app: true, say: (s) => out.push(s), complain: () => {} }), { code: 1 });
  assert.deepEqual(JSON.parse(out.at(-1).slice(16)), { error: 'git', sentence: 'This Workbench cannot clone a repository. Clone it with git, then open its folder.' });
  writeFileSync(path.join(dir, 'a-file'), 'x');
  const blocked = [];
  const sub = path.join(dir, 'a-file', 'sub');
  assert.deepEqual(await cloneFirst({ workspace: { cloneRepo: async () => ({ root: '/x' }) }, url: 'https://github.com/o/r', into: sub, say: () => {}, complain: (s) => blocked.push(s), log: { warn() {} } }), { code: 1 });
  assert.deepEqual(blocked, [`Workbench could not make the folder ${sub}.`]);
  assert.deepEqual(await cloneFirst({ workspace: { cloneRepo: async () => ({}) }, url: 'https://github.com/o/r', into: dir, say: () => {}, complain: () => {} }), { code: 1 });
});

test('cloneFirst with the real cloneRepo: addresses git must not use are refused before git runs', { skip: !CLONE_READY && 'needs cloneRepo in src/core/workspace.mjs (U2)' }, async (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-clone-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'pwned');
  for (const url of [`ext::sh -c touch% ${marker}`, 'file:///etc', `--upload-pack=touch ${marker}`, `${dir}/some/repo`]) {
    const out = [];
    const said = [];
    const r = await cloneFirst({ workspace, url, into: dir, app: true, say: (s) => out.push(s), complain: (s) => said.push(s), log: { debug() {}, error() {}, warn() {} } });
    assert.deepEqual(r, { code: 1 }, url);
    assert.equal(said.length, 1, url);
    assert.ok(['url', 'git'].includes(JSON.parse(out.at(-1).slice(16)).error), url);
  }
  assert.ok(!existsSync(marker));
});

test('displayUrl: no user name or password before the host, and no control characters', () => {
  assert.equal(displayUrl('https://x-access-token:abc123@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(displayUrl('https://abc123@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(displayUrl('ssh://git@github.com/o/r.git'), 'ssh://github.com/o/r.git');
  assert.equal(displayUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(displayUrl('https://github.com/o/r\u001b[2J\u0007'), 'https://github.com/o/r?[2J?');
});

test('--connect-github: the token is read once, connected for git only, and never printed or logged', async () => {
  const token = fakeToken();
  const calls = [];
  const connect = {
    async connectGithub(t, o) { calls.push([t, o]); return { ok: true, login: 'octocat', sentence: 'Connected to GitHub as octocat.' }; },
  };
  const out = [];
  assert.equal(await connectGithubMode({ connect, readToken: async () => `  ${token}  `, say: (s) => out.push(s) }), 0);
  assert.deepEqual(calls, [[token, { agentsUseIt: false }]]);
  assert.deepEqual(out, [`WORKBENCH_GITHUB ${JSON.stringify({ ok: true, login: 'octocat', sentence: 'Connected to GitHub as octocat.' })}`]);
  // Refused by GitHub (the sentence of Connect itself), refused with the token repeated (cut out), and a crash (logged without it).
  const lines = [];
  const logged = [];
  const log = { error: (...a) => logged.push(a.join(' ')) };
  const say = (s) => lines.push(JSON.parse(s.slice('WORKBENCH_GITHUB '.length)));
  const refusing = (err) => ({ async connectGithub() { throw err; } });
  assert.equal(await connectGithubMode({ connect: refusing(Object.assign(new Error('GitHub did not accept that token. Make a new one, then try again.'), { why: 'github' })), readToken: async () => token, say, log }), 1);
  assert.equal(await connectGithubMode({ connect: refusing(Object.assign(new Error(`GitHub did not accept ${token}.`), { why: 'github' })), readToken: async () => token, say, log }), 1);
  assert.equal(await connectGithubMode({ connect: refusing(new TypeError(`bad header ${token}`)), readToken: async () => token, say, log }), 1);
  assert.equal(await connectGithubMode({ connect: { async connectGithub() { return { ok: false, sentence: 'GitHub said no.' }; } }, readToken: async () => token, say, log }), 1);
  assert.equal(await connectGithubMode({ connect: null, readToken: async () => token, say, log }), 1);
  assert.equal(await connectGithubMode({ connect, readToken: async () => { throw new Error('stdin broke'); }, say, log }), 1);
  assert.deepEqual(lines, [
    { ok: false, login: null, sentence: 'GitHub did not accept that token. Make a new one, then try again.' },
    { ok: false, login: null, sentence: 'GitHub did not accept ••••.' },
    { ok: false, login: null, sentence: 'Workbench could not connect to GitHub. The details are in its log.' },
    { ok: false, login: null, sentence: 'GitHub said no.' },
    { ok: false, login: null, sentence: 'Workbench could not connect to GitHub. The details are in its log.' },
    { ok: false, login: null, sentence: 'Paste a token from GitHub first.' },
  ]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Connecting to GitHub failed: TypeError: bad header ••••/);
  assert.ok(!JSON.stringify(lines).includes(token) && !logged.join('\n').includes(token));
  // Connect logs through the same log. Until the token is kept, the mask of Agents & keys does not know it, so the token
  // is cut out of those lines too; afterwards the log is masked as before.
  const written = [];
  const shared = createLogger(false, (l) => written.push(l));
  shared.setMask((text) => text.replace('stored-value-123', '••••'));
  const chatty = { async connectGithub(t) { shared.warn('GitHub answered 401 for', t, 'and stored-value-123'); return { ok: false, sentence: 'GitHub did not accept that token.' }; } };
  assert.equal(await connectGithubMode({ connect: chatty, readToken: async () => token, say: () => {}, log: shared }), 1);
  shared.warn('later:', token, 'stored-value-123');
  assert.deepEqual(written, ['[workbench warn] GitHub answered 401 for •••• and ••••\n', `[workbench warn] later: ${token} ••••\n`]);
});

test('--github-repos: the connected account’s repositories, in the shape the Mac app reads; none when anything fails', async () => {
  const out = [];
  const connect = {
    async githubRepos() {
      return [
        { fullName: 'octo/hello', cloneUrl: 'https://github.com/octo/hello.git', private: false, pushedAt: '2026-11-01T00:00:00Z' },
        { fullName: 'octo/secret', cloneUrl: 'https://github.com/octo/secret.git', private: true, pushedAt: null },
        { fullName: 7, cloneUrl: 'x' }, null,
      ];
    },
  };
  assert.equal(await githubReposMode({ connect, say: (s) => out.push(s) }), 0);
  assert.deepEqual(out, [`WORKBENCH_GITHUB_REPOS ${JSON.stringify([
    { fullName: 'octo/hello', cloneUrl: 'https://github.com/octo/hello.git', private: false },
    { fullName: 'octo/secret', cloneUrl: 'https://github.com/octo/secret.git', private: true },
  ])}`]);
  const warned = [];
  for (const c of [{ async githubRepos() { throw new Error('getaddrinfo ENOTFOUND api.github.com'); } }, { async githubRepos() { return 'nope'; } }, null]) {
    const lines = [];
    assert.equal(await githubReposMode({ connect: c, say: (s) => lines.push(s), log: { warn: (...a) => warned.push(a) } }), 0);
    assert.deepEqual(lines, ['WORKBENCH_GITHUB_REPOS []']);
  }
  assert.equal(warned.length, 1);
});

test('readLine: one line from the Mac app, without its line break; nothing, or too much, is no token', async () => {
  const feed = async (chunks, opts) => {
    const s = new PassThrough();
    const p = readLine(s, opts);
    for (const c of chunks) s.write(c);
    s.end();
    return p;
  };
  assert.equal(await feed(['tok_abc', 'def\r\n', 'more\n']), 'tok_abcdef');
  assert.equal(await feed(['tok_abcdef']), 'tok_abcdef', 'a last line without a line break');
  assert.equal(await feed([]), null);
  assert.equal(await feed(['x'.repeat(100)], { max: 50 }), null);
  assert.equal(await readLine(new PassThrough(), { timeoutMs: 30 }), null, 'nothing came in time');
});

test('the log hides the person’s keys once Agents & keys gives it the mask, and keeps the levels of --verbose', () => {
  const lines = [];
  const quiet = createLogger(false, (l) => lines.push(l));
  const key = fakeToken();
  quiet.info('not shown');
  quiet.warn('before the mask:', 'plain words');
  quiet.setMask((text) => text.split(key).join('•••• ' + key.slice(-4)));
  quiet.warn('Claude Code said:', `bad key ${key}`);
  quiet.error(new Error(`failed with ${key}`));
  quiet.setMask(() => { throw new Error('mask broke'); });
  quiet.warn('a line still goes out');
  assert.deepEqual(lines, [
    '[workbench warn] before the mask: plain words\n',
    `[workbench warn] Claude Code said: bad key •••• ${key.slice(-4)}\n`,
    `[workbench error] failed with •••• ${key.slice(-4)}\n`,
    '[workbench warn] a line still goes out\n',
  ]);
  const loud = [];
  const verbose = createLogger(true, (l) => loud.push(l));
  verbose.info('shown');
  verbose.debug('also shown');
  verbose('and this');
  assert.deepEqual(loud, ['[workbench info] shown\n', '[workbench debug] also shown\n', '[workbench info] and this\n']);
});
