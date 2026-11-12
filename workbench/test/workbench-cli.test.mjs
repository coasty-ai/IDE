// The CLI: its argument handling (these cases stop before any module is loaded), the refusal inside an agent, and
// what it says when it starts. The starts use a throwaway repository, a temporary HOME, stand-ins for Claude Code and
// Codex, and a PATH without them; Workbench is stopped as soon as it has said where it runs. No agent is started.
// Also the files at the top of this repository that run Workbench on itself (package.json, workbench.json, CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as workspace from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';
import { Engine } from '../src/core/engine.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const ACCEPT = fileURLToPath(new URL('../scripts/accept-real.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';
/** Merge and throw-away are there: the git work (builder A) and the engine's cards (builder B). */
const MERGE_READY = typeof workspace.mergeWork === 'function' && typeof workspace.discardWork === 'function'
  && typeof Engine?.prototype?.proposeMerge === 'function' && typeof Engine?.prototype?.proposeDiscard === 'function';
const NO_IDENTITY = 'Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com';
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

test('when Claude Code cannot be found, the start says how to point Workbench at it', async (t) => {
  const w = setup(t);
  const none = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(none.code, 1);
  assert.equal(none.out, '');
  assert.deepEqual(none.err.trim().split('\n'), [
    'Workbench could not find Claude Code or Codex on this computer, so it has nothing to run.',
    '  Claude Code: Claude Code was not found: there is no claude command on the PATH, and no Claude Code extension in VS Code or Cursor. Tell Workbench where it is with --claude <path>, or with WORKBENCH_CLAUDE_BIN.',
    '  Codex: Codex is not installed, or the codex command could not be found.',
    'Install one of them, or try Workbench with simulated agents using --demo.',
  ]);
  // A path that is not there gets its own reason, even with a Claude Code in VS Code.
  extension(w.home, '2.1.322');
  const missing = path.join(w.dir, 'nope', 'claude');
  const wrong = await start(t, ['--repo', w.repo, '--no-open', '--port', '0', '--claude', missing], w.env);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, new RegExp(`\\n  Claude Code: Claude Code is not at ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, the path given with --claude\\.\\n`));
  const wrongVar = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...w.env, WORKBENCH_CLAUDE_BIN: missing });
  assert.equal(wrongVar.code, 1);
  assert.ok(wrongVar.err.includes(`  Claude Code: Claude Code is not at ${missing}, the path in WORKBENCH_CLAUDE_BIN.\n`), wrongVar.err);
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
