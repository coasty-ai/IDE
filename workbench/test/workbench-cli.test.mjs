// The CLI: its argument handling (these cases stop before any module is loaded), the refusal inside an agent, and
// what it says when it starts. The starts use a throwaway repository, a temporary HOME, stand-ins for Claude Code and
// Codex, and a PATH without them; Workbench is stopped as soon as it has said where it runs. No agent is started.
// Also the files at the top of this repository that run Workbench on itself (package.json, workbench.json, CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, symlinkSync, statSync, accessSync, existsSync, readdirSync, constants } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as workspace from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';
import { Engine } from '../src/core/engine.mjs';
// Imported, the CLI only exports its parts: it starts only when run as a program.
import { parseArgs, createLogger, displayUrl, cloneFirst, connectGithubMode, githubReposMode, readLine, pathWithLocalBin, agentLines, wireConnect } from '../bin/workbench.mjs';
import { githubSigninMode, githubStatusMode } from '../bin/workbench.mjs';
import { ghWrapper, FAKE_CODE, FAKE_REPOS } from './helpers/gh-fake.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const ACCEPT = fileURLToPath(new URL('../scripts/accept-real.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const CODEX_FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url));
/** What Claude Code signed in with a Claude subscription says first (Agents & keys' own sentence). */
const SUBSCRIPTION = 'is ready, signed in with your Claude subscription.';
const INSIDE_AGENT = 'Workbench is running inside an agent. It will not start real agents from there.';
/** Merge and throw-away are there: the git work (builder A) and the engine's cards (builder B). */
const MERGE_READY = typeof workspace.mergeWork === 'function' && typeof workspace.discardWork === 'function'
  && typeof Engine?.prototype?.proposeMerge === 'function' && typeof Engine?.prototype?.proposeDiscard === 'function';
const NO_IDENTITY = 'Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com';
const NO_AGENT = 'No coding agent is ready yet. Open the page to connect one.';
/** Agents & keys and cloning are there: the key store (U1), the connect service and cloneRepo (U2). */
const CONNECT_READY = existsSync(fileURLToPath(new URL('../src/core/connect.mjs', import.meta.url))) && existsSync(fileURLToPath(new URL('../src/core/keys.mjs', import.meta.url)));
const CLONE_READY = typeof workspace.cloneRepo === 'function';
/** What Workbench says of an address it does not clone from: the Mac app's own words, so the two read alike. */
const ADDRESS_REFUSED = 'Workbench clones addresses like https://github.com/owner/repo or git@github.com:owner/repo.git.';
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
 * A git for the clone tests: every call goes to the real git, except `clone`, which never reaches a network. With
 * FAKE_GIT_CLONE=local it prints two progress lines, then copies the repository FAKE_GIT_CLONE_FROM names, whatever the
 * address says. With half, it makes half a clone (a .git folder and a file), prints a progress line, writes its process
 * id to FAKE_GIT_PIDFILE and waits; stubborn does the same, ignoring SIGTERM, so only SIGKILL ends it.
 */
function fakeGitScript(git) {
  const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    'case " $* " in',
    '  *" clone "*)',
    '    for last; do :; done',
    '    case "$FAKE_GIT_CLONE" in',
    '      local)',
    "        printf 'Receiving objects:  50%% (1/2)\\rReceiving objects: 100%% (2/2), done.\\n' >&2",
    `        exec ${sh(git)} clone -q -- "$FAKE_GIT_CLONE_FROM" "$last" ;;`,
    '      half|stubborn)',
    "        [ \"$FAKE_GIT_CLONE\" = stubborn ] && trap '' TERM",
    '        mkdir -p "$last/.git"; echo half > "$last/half.txt"',
    "        printf 'Receiving objects:  10%% (1/10)\\r' >&2",
    '        echo $$ > "$FAKE_GIT_PIDFILE"',
    '        exec sleep 30 ;;',
    '    esac ;;',
    'esac',
    `exec ${sh(git)} "$@"`,
    '',
  ].join('\n');
}

/**
 * A throwaway repository with one commit of `files` on the branch main, a home folder with no git name or email, and
 * an environment for the CLI: no inherited agent id or program choices, the real Codex never reachable, and a PATH
 * that holds git only (no node: Workbench must put its own in front for the agents and checks that need it). With
 * `fakeGit`, that git is fakeGitScript's.
 */
function setup(t, { files = { 'README.md': '# test\n' }, fakeGit = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(path.join(dir, 'tmp'));
  if (fakeGit) writeFileSync(path.join(bin, 'git'), fakeGitScript(realGit()), { mode: 0o755 });
  else symlinkSync(realGit(), path.join(bin, 'git'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(repo, name), text);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', TMPDIR: path.join(dir, 'tmp'),
    PATH: `${bin}:/usr/bin:/bin`, WORKBENCH_CODEX_BIN: path.join(dir, 'no-codex-here'),
    // GitHub's command-line tool: none, unless a test gives the stand-in. A real gh on this computer is never run.
    WORKBENCH_GH_BIN: path.join(dir, 'no-gh-here'),
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

/** Wait until `ok()` is true, for `ms` at most. */
async function until(ok, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

/** The process id the stand-in git wrote to `file`, once it has (0 when it never did). */
async function pidIn(file, ms = 20_000) {
  let pid = 0;
  await until(() => {
    try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { pid = 0; }
    return pid > 0;
  }, ms);
  return pid;
}

/** Whether the process has gone (and been reaped), waiting up to `ms` for it. */
async function goneSoon(pid, ms = 5000) {
  return until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e.code === 'ESRCH';
    }
  }, ms);
}

/** A VS Code extension folder whose claude program says it is `version`, signed in with a Claude subscription. */
function extension(home, version) {
  const dir = path.join(home, '.vscode', 'extensions', `anthropic.claude-code-${version}-${process.platform}-${process.arch}`, 'resources', 'native-binary');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'claude'), [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi`,
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'; exit 0; fi',
    'exit 3',
    '',
  ].join('\n'), { mode: 0o755 });
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
  assert.equal(found.lines[0], `Claude Code 2.1.322 ${SUBSCRIPTION} Found in the VS Code extension.`);
  assert.equal(found.lines[1], `Codex is not at ${path.join(w.dir, 'no-codex-here')}, the path in WORKBENCH_CODEX_BIN.`);
  assert.ok(!/\.\.(\s|$)/m.test(found.out + found.err), 'no doubled full stop');
  assert.match(found.out, /Workbench is running at http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}/);
  // --claude, then WORKBENCH_CLAUDE_BIN, win over the extension, and say so.
  const flag = await start(t, ['--repo', w.repo, '--no-open', '--port', '0', '--claude', FAKE], { ...w.env, WORKBENCH_CLAUDE_BIN: path.join(w.dir, 'not-this-one'), FAKE_CLAUDE_VERSION: '2.1.400' });
  assert.equal(flag.code, 0, flag.err);
  assert.equal(flag.lines[0], `Claude Code 2.1.400 ${SUBSCRIPTION} Found in the path given with --claude.`);
  const variable = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...w.env, WORKBENCH_CLAUDE_BIN: FAKE });
  assert.equal(variable.code, 0, variable.err);
  assert.equal(variable.lines[0], `Claude Code 2.1.221 ${SUBSCRIPTION} Found in WORKBENCH_CLAUDE_BIN.`);
});

test('with no agent program ready, Workbench starts anyway and says so; a path given that is not there gets its own words', async (t) => {
  const w = setup(t);
  const noCodex = `Codex is not at ${path.join(w.dir, 'no-codex-here')}, the path in WORKBENCH_CODEX_BIN.`;
  const none = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(none.code, 0, none.err);
  assert.deepEqual(none.lines.slice(0, 3), ['Claude Code is not installed.', noCodex, NO_AGENT]);
  assert.match(none.lines[3], /^Workbench is running at http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{64}$/);
  assert.ok(none.lines.includes('Press Ctrl-C to stop.'), none.out);
  assert.doesNotMatch(none.out + none.err, /could not find Claude Code or Codex|nothing to run/, 'the old exit is gone (the Mac app looked for it)');
  // A path that is not there gets its own reason, even with a Claude Code in VS Code; Workbench still starts.
  extension(w.home, '2.1.322');
  const missing = path.join(w.dir, 'nope', 'claude');
  const wrong = await start(t, ['--repo', w.repo, '--no-open', '--port', '0', '--claude', missing], w.env);
  assert.equal(wrong.code, 0, wrong.err);
  assert.deepEqual(wrong.lines.slice(0, 3), [`Claude Code is not at ${missing}, the path given with --claude.`, noCodex, NO_AGENT]);
  const wrongVar = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...w.env, WORKBENCH_CLAUDE_BIN: missing });
  assert.equal(wrongVar.code, 0, wrongVar.err);
  assert.equal(wrongVar.lines[0], `Claude Code is not at ${missing}, the path in WORKBENCH_CLAUDE_BIN.`);
  assert.equal(wrongVar.lines[2], NO_AGENT);
  // With Claude Code found, nothing is said about connecting one.
  const found = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(found.lines[0], `Claude Code 2.1.322 ${SUBSCRIPTION} Found in the VS Code extension.`);
  assert.ok(!found.out.includes(NO_AGENT), found.out);
});

test('the start lines come from Agents & keys’ first check: a program that runs but is signed out is not ready', async (t) => {
  const w = setup(t);
  // Claude Code runs, but is not signed in; Codex runs, and says it is not logged in.
  const env = { ...w.env, WORKBENCH_CLAUDE_BIN: FAKE, FAKE_CLAUDE_AUTH: '{"loggedIn":false}', WORKBENCH_CODEX_BIN: CODEX_FAKE, FAKE_CODEX_LOGIN: 'out' };
  const out = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], env);
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(out.lines.slice(0, 3), [
    'Claude Code 2.1.221 is installed but not signed in. Found in WORKBENCH_CLAUDE_BIN.',
    'Codex 0.166.0 is installed but not signed in. Found in WORKBENCH_CODEX_BIN.',
    NO_AGENT,
  ]);
  // Signed in, it is ready, and nothing is said about connecting one.
  const signedIn = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], { ...env, FAKE_CODEX_LOGIN: 'in' });
  assert.equal(signedIn.code, 0, signedIn.err);
  assert.equal(signedIn.lines[1], 'Codex 0.166.0 is ready, signed in with your ChatGPT account. Found in WORKBENCH_CODEX_BIN.');
  assert.ok(!signedIn.out.includes(NO_AGENT), signedIn.out);
});

test('a key kept for this repository signs an agent in from the first check on: the start, the engine and the page agree at once', { skip: !CONNECT_READY && 'needs Agents & keys (src/core/connect.mjs, src/core/keys.mjs)' }, async (t) => {
  const w = setup(t);
  // An OpenAI key the person kept in Agents & keys "for this repository", given to Codex: in a private file (never the
  // keychain: the record says where its value is). Codex is installed, and not logged in otherwise.
  const id = 'k00000000beef';
  const value = ['not', 'a', 'real', 'key', Date.now().toString(36)].join('-');
  const store = path.join(w.home, '.workbench');
  mkdirSync(path.join(store, 'keys'), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(store, 'keys.json'), JSON.stringify({ version: 1, keys: [{
    id, preset: 'openai', label: 'OpenAI', vars: [{ name: 'OPENAI_API_KEY', secret: true }, { name: 'CODEX_API_KEY', secret: true }],
    scope: { kind: 'repo', root: realpathSync(w.repo) }, agents: ['codex'], kept: 'file', created: 1,
  }] }), { mode: 0o600 });
  writeFileSync(path.join(store, 'keys', `${id}.json`), JSON.stringify({ version: 1, values: { OPENAI_API_KEY: value, CODEX_API_KEY: value } }), { mode: 0o600 });
  const env = { ...w.env, WORKBENCH_CODEX_BIN: CODEX_FAKE, FAKE_CODEX_LOGIN: 'out' };
  const proc = spawn(process.execPath, [BIN, '--repo', w.repo, '--app', '--port', '0'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  let m;
  assert.ok(await until(() => (m = /^WORKBENCH_APP (\{.*\})$/m.exec(out)) || proc.exitCode != null), out);
  assert.ok(m, out);
  const lines = out.split('\n');
  assert.ok(lines.includes('Codex 0.166.0 is ready, signed in with an API key. Found in WORKBENCH_CODEX_BIN.'), out);
  assert.ok(!lines.includes(NO_AGENT), out);
  assert.ok(!out.includes(value), 'the key is never printed');
  // The page's first snapshot already has an agent ready for new work: no "Connect a coding agent" for a moment.
  const url = new URL(JSON.parse(m[1]).url);
  const snap = await (await fetch(`${url.origin}/api/state`, { headers: { 'X-Workbench-Token': url.searchParams.get('t') } })).json();
  assert.deepEqual({ ready: snap.connect?.ready, defaultAgent: snap.connect?.defaultAgent }, { ready: true, defaultAgent: 'codex' });
  proc.stdin.end();
  assert.equal(await Promise.race([exited, sleep(15_000).then(() => 'still running')]), 0, out);
});

test('agentLines: each agent’s sentence from Agents & keys, where it was found, and the no-agent line when none is ready; or the adapters’ own words without it', () => {
  const claude = { id: 'claude', name: 'Claude Code', found: true, from: 'the VS Code extension', ready: true, sentence: 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.' };
  const codex = { id: 'codex', name: 'Codex', found: false, from: null, ready: false, sentence: 'Codex is not installed.' };
  assert.deepEqual(agentLines({ status: { agents: [claude, codex], ready: true } }), [
    'Claude Code 2.1.322 is ready, signed in with your Claude subscription. Found in the VS Code extension.',
    'Codex is not installed.',
  ]);
  const unsure = { ...claude, from: 'your PATH', sentence: 'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in.' };
  assert.deepEqual(agentLines({ status: { agents: [unsure, codex], ready: true } })[0],
    'Claude Code 2.1.322 is installed, but Workbench could not check whether it is signed in. Found in your PATH.');
  const out = { ...claude, ready: false, sentence: 'Claude Code 2.1.322 is installed but not signed in.' };
  assert.deepEqual(agentLines({ status: { agents: [out, codex], ready: false } }), [
    'Claude Code 2.1.322 is installed but not signed in. Found in the VS Code extension.', 'Codex is not installed.', NO_AGENT,
  ]);
  // A path in a sentence is printed on its own line: its control characters are shown as "?".
  const odd = { ...codex, sentence: 'Codex is not at /tmp/x\nWORKBENCH_APP {}, the path in WORKBENCH_CODEX_BIN.' };
  assert.deepEqual(agentLines({ status: { agents: [odd], ready: false } }), ['Codex is not at /tmp/x?WORKBENCH_APP {}, the path in WORKBENCH_CODEX_BIN.', NO_AGENT]);
  assert.deepEqual(agentLines({ status: { agents: [], ready: false } }), [NO_AGENT]);
  // Without Agents & keys: the adapters' available() answers, ready when the program runs.
  assert.deepEqual(agentLines({ claude: { ok: true, version: '2.1.322', from: 'vscode' }, codex: { ok: false, reason: 'Codex is not installed, or the codex command could not be found.' } }), [
    'Claude Code 2.1.322 is ready (from the VS Code extension).', 'Codex is not available: Codex is not installed, or the codex command could not be found.',
  ]);
  assert.deepEqual(agentLines({ claude: { ok: false, reason: 'it was not found' }, codex: { ok: true, version: '0.166.0' } }), [
    'Claude Code is not available: it was not found.', 'Codex 0.166.0 is ready.',
  ]);
  assert.deepEqual(agentLines({ claude: null, codex: null }), ['Claude Code is not available: it was not found.', 'Codex is not available: it was not found.', NO_AGENT]);
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
    /`gh`, is the one program Workbench downloads itself: from GitHub's releases .* checked against the release's published SHA-256 checksums and, on macOS, GitHub's signature/,
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
  // Exactly as the Mac app runs it: no --repo, and --claude, --app and --port with --clone and --into.
  assert.deepEqual((({ clone, into, claude, app, port, repo, open, error }) => ({ clone, into, claude, app, port, repo, open, error }))(
    parseArgs(['--clone', 'git@github.com:octo/hello.git', '--into', '/Users/ada/Developer', '--claude', '/opt/claude/claude', '--app', '--port', '4317'])),
  { clone: 'git@github.com:octo/hello.git', into: '/Users/ada/Developer', claude: '/opt/claude/claude', app: true, port: 4317, repo: null, open: false, error: null });
  assert.equal(parseArgs(['--clone', 'https://github.com/octo/hello', '--into', '/tmp/x', '--app', '--port', '0']).port, 0);
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

test('--connect-github, run as a program: one line is read and never printed back; a refusal is WORKBENCH_GITHUB with ok false and exit 1, and no line holds the token', async (t) => {
  const w = setup(t);
  const token = fakeToken();
  const NOT_A_TOKEN = 'That does not look like a GitHub token.';
  const NONE = 'Paste a token from GitHub first.';
  // Each is refused before GitHub is asked: nothing reaches a network. Only the first line counts, and a second line
  // read by mistake would be refused in other words.
  for (const [input, sentence] of [
    [`${token} ${token.slice(-6)}\n\n`, NOT_A_TOKEN],
    [`${'x'.repeat(300)}\r\n`, NOT_A_TOKEN],
    [`\n${token} two\n`, NONE],
  ]) {
    for (const verbose of [false, true]) {
      const r = await runWithInput(['--connect-github', ...(verbose ? ['--verbose'] : [])], w.env, input);
      assert.equal(r.code, 1, r.stderr);
      assert.equal(r.stdout, `WORKBENCH_GITHUB ${JSON.stringify({ ok: false, login: null, sentence })}\n`);
      const all = r.stdout + r.stderr;
      for (const typed of input.split(/\r?\n/).filter(Boolean)) assert.ok(!all.includes(typed), 'what was typed is never printed or logged');
      assert.ok(!all.includes(token.slice(4, 20)), 'not even part of it');
    }
  }
  assert.equal(existsSync(path.join(w.home, '.workbench', 'settings.json')), false, 'nothing was kept');
});

test('the GitHub helpers, run as programs, check no agent; --github-repos prints [] and exits 0 when the connected account’s token cannot be read', async (t) => {
  const w = setup(t);
  // Claude Code and Codex stand-ins that leave a mark when anything runs them.
  const marks = path.join(w.dir, 'ran.txt');
  const standIn = (name) => {
    const p = path.join(w.dir, name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> '${marks}'\nexit 1\n`, { mode: 0o755 });
    return p;
  };
  const env = { ...w.env, WORKBENCH_CLAUDE_BIN: standIn('claude'), WORKBENCH_CODEX_BIN: standIn('codex') };
  // GitHub was connected in an earlier run, and its token kept in a private file that has gone since (never the
  // keychain: these lines say where it is, so nothing here reads the keychain).
  const id = 'k0123456789ab';
  mkdirSync(path.join(w.home, '.workbench'), { mode: 0o700 });
  writeFileSync(path.join(w.home, '.workbench', 'settings.json'), JSON.stringify({ github: { login: 'octo-cat', keyId: id } }), { mode: 0o600 });
  writeFileSync(path.join(w.home, '.workbench', 'keys.json'), JSON.stringify({ version: 1, keys: [{
    id, preset: 'github', label: 'GitHub', vars: [{ name: 'GH_TOKEN', secret: true }, { name: 'GITHUB_TOKEN', secret: true }],
    scope: { kind: 'all' }, agents: [], kept: 'file', created: 1,
  }] }), { mode: 0o600 });
  const repos = await runWithInput(['--github-repos'], env, '');
  assert.equal(repos.code, 0, repos.stderr);
  assert.equal(repos.stdout, 'WORKBENCH_GITHUB_REPOS []\n');
  const connect = await runWithInput(['--connect-github'], env, '\n');
  assert.equal(connect.code, 1, connect.stderr);
  assert.equal(connect.stdout, `WORKBENCH_GITHUB ${JSON.stringify({ ok: false, login: null, sentence: 'Paste a token from GitHub first.' })}\n`);
  await sleep(200); // a check started in the background would have left its mark by now
  assert.equal(existsSync(marks), false, existsSync(marks) ? readFileSync(marks, 'utf8') : '');
  // A live start does check them.
  await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], env);
  assert.ok(existsSync(marks), 'the stand-ins leave a mark when they run');
});

test('pathWithLocalBin: the agents’ installers’ folder goes at the end of PATH, once, never in front; an empty PATH is left alone', () => {
  assert.equal(pathWithLocalBin('/usr/bin:/bin', '/Users/ada'), '/usr/bin:/bin:/Users/ada/.local/bin');
  assert.equal(pathWithLocalBin('/Users/ada/.local/bin:/usr/bin', '/Users/ada'), '/Users/ada/.local/bin:/usr/bin', 'where the person put it, it stays');
  assert.equal(pathWithLocalBin('/usr/bin:/Users/ada/.local/bin/', '/Users/ada'), '/usr/bin:/Users/ada/.local/bin/');
  assert.equal(pathWithLocalBin('/usr/bin:/Users/ada/./.local/bin', '/Users/ada/'), '/usr/bin:/Users/ada/./.local/bin');
  assert.equal(pathWithLocalBin('/usr/bin:.local/bin', '/Users/ada'), '/usr/bin:.local/bin:/Users/ada/.local/bin', 'a relative folder is another one');
  assert.equal(pathWithLocalBin('/usr/bin:~/.local/bin', '/Users/ada'), '/usr/bin:~/.local/bin:/Users/ada/.local/bin', 'so is ~, which no program expands');
  for (const [value, home] of [['', '/Users/ada'], [undefined, '/Users/ada'], ['/usr/bin', ''], ['/usr/bin', 'relative'], ['/usr/bin', undefined]]) {
    assert.equal(pathWithLocalBin(value, home), value);
  }
});

test('Workbench puts ~/.local/bin at the end of its PATH: a Claude Code installed there is found, and a git there is not used', async (t) => {
  const w = setup(t);
  const local = path.join(w.home, '.local', 'bin');
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.500 (Claude Code)"; exit 0; fi\nexit 3\n', { mode: 0o755 });
  const decoy = path.join(w.dir, 'decoy-git-ran.txt');
  writeFileSync(path.join(local, 'git'), `#!/bin/sh\necho "$*" >> '${decoy}'\nexit 1\n`, { mode: 0o755 });
  const r = await start(t, ['--repo', w.repo, '--no-open', '--port', '0'], w.env);
  assert.equal(r.code, 0, r.err);
  // This one answers nothing when asked whether it is signed in: Workbench cannot tell, and does not count it out.
  assert.equal(r.lines[0], 'Claude Code 2.1.500 is installed, but Workbench could not check whether it is signed in. Found in your PATH.');
  assert.ok(!r.lines.includes(NO_AGENT), r.out);
  assert.match(r.out, /Workbench is running at http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(existsSync(decoy), false, 'git came from the folder before it on the PATH');
});

test('--clone, run as a program: an address Workbench does not clone from is refused in the Mac app’s own words, with the line it reads, and nothing starts',{ skip: !CLONE_READY && 'needs cloneRepo in src/core/workspace.mjs (U2)' }, async (t) => {
  const w = setup(t);
  const into = path.join(w.dir, 'code');
  // Also with a name in the address that is a word of the sentence too ("owner"): the sentence stays whole.
  for (const address of ['ext::sh -c touch% /tmp/x', 'https://owner@github.com/owner/repo', ['https://owner', 'not-a-password@github.com/owner/repo'].join(':')]) {
    for (const app of [false, true]) {
      const r = await runWithInput(['--clone', address, '--into', into, '--port', '0', ...(app ? ['--app'] : [])], w.env, '');
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.doesNotMatch(r.stdout, /Workbench is running/);
      const said = r.stderr.trim().split('\n').filter(l => !l.startsWith('[workbench '));
      assert.deepEqual(said, [ADDRESS_REFUSED], address);
      assert.ok(!(r.stdout + r.stderr).includes('not-a-password'), 'a password in the address is never printed');
      const line = r.stdout.split('\n').find(l => l.startsWith('WORKBENCH_CLONE '));
      if (!app) { assert.equal(line, undefined); continue; }
      assert.deepEqual(JSON.parse(line.slice('WORKBENCH_CLONE '.length)), { error: 'url', sentence: ADDRESS_REFUSED });
    }
  }
  assert.deepEqual(readdirSync(into), [], 'nothing was cloned');
});

test('--clone as the Mac app runs it (--into, --claude, --app, a busy --port, no --repo): progress only as WORKBENCH_CLONE lines, then the new folder, which the board opens', { skip: !CLONE_READY && 'needs cloneRepo in src/core/workspace.mjs (U2)' }, async (t) => {
  const w = setup(t, { fakeGit: true });
  // What the stand-in git copies, whatever the address says: a bare copy of the test repository.
  const bare = path.join(w.dir, 'hello.git');
  execFileSync(realGit(), ['clone', '-q', '--bare', w.repo, bare], { stdio: 'pipe' });
  const into = path.join(w.dir, 'Developer');
  // Port 4317 is taken (here, another one): the page takes a free one rather than throw the clone away.
  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  const taken = busy.address().port;
  const proc = spawn(process.execPath, [BIN, '--clone', 'https://github.com/octo/hello.git', '--into', into, '--claude', FAKE, '--app', '--port', String(taken)],
    { env: { ...w.env, FAKE_GIT_CLONE: 'local', FAKE_GIT_CLONE_FROM: bare }, stdio: ['pipe', 'pipe', 'pipe'] });
  // The app reads standard output and standard error as one stream.
  let both = '';
  proc.stdout.on('data', (d) => { both += d; });
  proc.stderr.on('data', (d) => { both += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  assert.ok(await until(() => /^WORKBENCH_APP /m.test(both) || proc.exitCode != null), both);
  const lines = both.split('\n');
  const json = (prefix) => lines.filter((l) => l.startsWith(prefix)).map((l) => JSON.parse(l.slice(prefix.length)));
  const root = realpathSync(path.join(into, 'hello'));
  // Progress, then the new folder.
  assert.deepEqual(json('WORKBENCH_CLONE '), [{ phase: 'receiving', percent: 50 }, { phase: 'receiving', percent: 100 }, { phase: 'done', percent: 100, root }]);
  const [ready] = json('WORKBENCH_APP ');
  assert.deepEqual({ root: ready.root, repo: ready.repo, demo: ready.demo }, { root, repo: 'hello', demo: false });
  assert.notEqual(new URL(ready.url).port, String(taken));
  const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('WORKBENCH_CLONE {"phase":"done"') < at('WORKBENCH_APP '));
  // Beside those lines, no plain progress line: the app shows progress from WORKBENCH_CLONE lines alone, and takes the
  // clone as done only at phase done (or WORKBENCH_APP).
  const plain = lines.filter((l) => l && !l.startsWith('WORKBENCH_') && !l.startsWith('[workbench '));
  assert.equal(plain[0], `Cloning https://github.com/octo/hello.git into ${into}…`);
  assert.ok(!plain.some((l) => /%|^(Counting what to copy|Packing it up|Copying|Unpacking|Writing the files)\b/.test(l)), plain.join('\n'));
  assert.ok(plain.includes(`Cloned https://github.com/octo/hello.git into ${root}.`), plain.join('\n'));
  assert.ok(plain.includes(`Claude Code 2.1.221 ${SUBSCRIPTION} Found in the path given with --claude.`), plain.join('\n'));
  assert.ok(plain.includes(`Port ${taken} is already in use, so the page took a free one.`), plain.join('\n'));
  // The board is on the copy.
  assert.equal(execFileSync(realGit(), ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), w.git('rev-parse', 'HEAD'));
  proc.stdin.end();
  assert.equal(await Promise.race([exited, sleep(15_000).then(() => 'still running')]), 0, both);
});

test('--clone: SIGTERM, or the app closing standard input, while git copies ends git’s whole group, leaves no half-made folder, and exits at once', { skip: !CLONE_READY && 'needs cloneRepo in src/core/workspace.mjs (U2)' }, async (t) => {
  const w = setup(t, { fakeGit: true });
  const into = path.join(w.dir, 'Developer');
  const STOPPED = 'Stopped copying the repository.';
  const APP_GONE = 'The app closed, so Workbench stopped copying the repository.';
  // The app's Cancel or Quit (SIGTERM); the app gone (its end of standard input closed), with a git that ignores
  // SIGTERM; and the app's own stop, which closes standard input and sends SIGTERM at once.
  for (const [how, mode] of [['term', 'half'], ['stdin', 'stubborn'], ['both', 'half']]) {
    const pidfile = path.join(w.dir, `${how}.pid`);
    const proc = spawn(process.execPath, [BIN, '--clone', `https://github.com/octo/${how}.git`, '--into', into, '--app', '--port', '0'],
      { env: { ...w.env, FAKE_GIT_CLONE: mode, FAKE_GIT_PIDFILE: pidfile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
    // Git has begun (it writes its process id once half the folder is there), and its progress reached the app.
    const pid = await pidIn(pidfile);
    assert.ok(pid > 0, out);
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
    assert.ok(await until(() => /^WORKBENCH_CLONE \{"phase":"receiving","percent":10\}$/m.test(out)), out);
    const dest = path.join(into, how);
    assert.ok(existsSync(path.join(dest, 'half.txt')));
    const started = Date.now();
    if (how !== 'term') proc.stdin.end();
    if (how !== 'stdin') proc.kill('SIGTERM');
    const ex = await Promise.race([exited, sleep(10_000).then(() => null)]);
    const took = Date.now() - started;
    assert.deepEqual(ex, { code: 1, signal: null }, `${how}: ${out}`);
    assert.ok(took < 4500, `${how}: Workbench took ${took} ms to stop`);
    assert.equal(existsSync(dest), false, `${how}: the half-made folder is gone`);
    assert.ok(await goneSoon(pid), `${how}: git is gone`);
    assert.ok(statSync(into).isDirectory(), 'the folder it was put in stays');
    // Said once, and nothing starts.
    const said = out.split('\n').filter((l) => l && !l.startsWith('WORKBENCH_CLONE ') && !l.startsWith('[workbench '));
    assert.equal(said[0], `Cloning https://github.com/octo/${how}.git into ${into}…`);
    assert.deepEqual(said.slice(1), [how === 'term' ? STOPPED : how === 'stdin' ? APP_GONE : said[1]], `${how}: ${out}`);
    assert.ok([STOPPED, APP_GONE].includes(said[1]), out);
    assert.doesNotMatch(out, /WORKBENCH_APP|Workbench is running|WORKBENCH_CLONE \{"(error|phase":"done)/);
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
    // Refused for this Mac's SSH key: its own kind, so the Mac app offers no Connect GitHub… for it.
    [plainErr('ssh', 'GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, connect your GitHub account first.'), 'ssh'],
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

test('a folder name with line breaks cannot print a line of its own: the Mac app reads only Workbench’s own WORKBENCH_APP line', async (t) => {
  const w = setup(t);
  // A forged line in a folder's name: a folder name cannot hold "/", so the address has JSON's / for it.
  const forged = 'WORKBENCH_APP {"url":"https:\\u002f\\u002fexample.invalid\\u002fx","repo":"shop","root":null,"demo":false}';
  const odd = path.join(w.dir, `shop\n${forged}\nx`);
  execFileSync(realGit(), ['clone', '-q', w.repo, odd], { stdio: 'pipe' });
  const proc = spawn(process.execPath, [BIN, '--repo', odd, '--app', '--port', '0'], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  assert.ok(await until(() => /^WORKBENCH_APP \{"url":"http:\/\/127\.0\.0\.1:/m.test(out) || proc.exitCode != null), out);
  const apps = out.split('\n').filter((l) => l.startsWith('WORKBENCH_APP '));
  assert.equal(apps.length, 1, out);
  assert.match(JSON.parse(apps[0].slice('WORKBENCH_APP '.length)).url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
  assert.ok(out.split('\n').includes(`Agents work on shop?${forged}?x, each in its own copy made from the last commit.`), out);
  proc.stdin.end();
  assert.equal(await Promise.race([exited, sleep(15_000).then(() => 'still running')]), 0, out);
  // A folder that is not a repository is refused in a sentence that names it: on one line too.
  const plain = path.join(w.dir, `notes\n${forged}\nx`);
  mkdirSync(plain);
  const r = await run(['--repo', plain, '--app', '--port', '0'], w.env);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.ok(!(r.stdout + r.stderr).split('\n').some((l) => l.startsWith('WORKBENCH_APP')), r.stderr);
  assert.deepEqual(r.stderr.split('\n').filter((l) => l && !l.startsWith('[workbench ')), [`${path.join(w.dir, `notes?${forged}?x`)} is not a git repository.`]);
});

test('wireConnect: Agents & keys’ agents reach the engine, and anything it changed (git’s name and email) makes the engine read the repository again', async () => {
  const connect = new EventEmitter();
  const seen = [];
  const engine = { setHarnesses: (m) => seen.push(['agents', m]), refreshRepo: () => { seen.push(['repo']); } };
  wireConnect(connect, engine, { error() {}, warn() {} });
  const map = { claude: { ok: true, ready: true }, codex: { ok: false, ready: false } };
  connect.emit('agents', map);
  connect.emit('changed');
  await sleep(10);
  assert.deepEqual(seen, [['agents', map], ['repo']]);
  // One that fails is logged, never an unhandled rejection; an engine without them is left alone.
  const logged = [];
  const failing = new EventEmitter();
  wireConnect(failing, { setHarnesses() { throw new Error('agents broke'); }, refreshRepo: async () => { throw new Error('git broke'); } },
    { error: (...a) => logged.push(['error', a[1]?.message]), warn: (...a) => logged.push(['warn', a[1]?.message]) });
  failing.emit('agents', map);
  failing.emit('changed');
  await sleep(10);
  assert.deepEqual(logged.sort(), [['error', 'agents broke'], ['warn', 'git broke']]);
  const bare = new EventEmitter();
  wireConnect(bare, {}, null);
  bare.emit('agents', map);
  bare.emit('changed');
  wireConnect(null, engine, null);
});

test('a name and email saved in Agents & keys reach the board at once, not at its next look at the repository', {
  skip: !(CONNECT_READY && typeof Engine?.prototype?.refreshRepo === 'function') && 'needs engine.refreshRepo() in src/core/engine.mjs',
}, async (t) => {
  const w = setup(t);
  const proc = spawn(process.execPath, [BIN, '--repo', w.repo, '--app', '--port', '0'], { env: w.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  t.after(() => { if (proc.exitCode == null && proc.signalCode == null) proc.kill('SIGKILL'); });
  let m;
  assert.ok(await until(() => (m = /^WORKBENCH_APP (\{.*\})$/m.exec(out)) || proc.exitCode != null), out);
  assert.ok(m, out);
  const url = new URL(JSON.parse(m[1]).url);
  const headers = { 'X-Workbench-Token': url.searchParams.get('t'), 'Content-Type': 'application/json' };
  const identity = async () => (await (await fetch(`${url.origin}/api/state`, { headers })).json()).repo?.identity;
  assert.equal(await identity(), false, 'git knows no name and email yet: the board hides Merge');
  // Saved in the panel (into the temporary home's git config): the board knows within moments, long before the engine's
  // own look every 15 seconds.
  const saved = await fetch(`${url.origin}/api/connect/git`, { method: 'POST', headers, body: JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.invalid' }) });
  assert.equal(saved.status, 200, await saved.clone().text());
  let now = false;
  const deadline = Date.now() + 4000;
  while (!(now = await identity()) && Date.now() < deadline) await sleep(50);
  assert.equal(now, true, out);
  proc.stdin.end();
  assert.equal(await Promise.race([exited, sleep(15_000).then(() => 'still running')]), 0, out);
});

test('displayUrl: no user name or password before the host, and no control characters', () => {
  assert.equal(displayUrl('https://x-access-token:abc123@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(displayUrl('https://abc123@github.com/o/r'), 'https://github.com/o/r');
  assert.equal(displayUrl('ssh://git@github.com/o/r.git'), 'ssh://github.com/o/r.git');
  assert.equal(displayUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
  assert.equal(displayUrl('https://github.com/o/r\u001b[2J\u0007'), 'https://github.com/o/r?[2J?');
});

test('--connect-github: the token is read once, connected with whether agents get it left as it was, and never printed or logged', async () => {
  const token = fakeToken();
  const calls = [];
  const connect = {
    async connectGithub(t, o) { calls.push([t, o]); return { ok: true, login: 'octocat', sentence: 'Connected to GitHub as octocat.' }; },
  };
  const out = [];
  assert.equal(await connectGithubMode({ connect, readToken: async () => `  ${token}  `, say: (s) => out.push(s) }), 0);
  // No choice of its own: "Let agents use this token", turned on in Agents & keys, is not turned off by the Mac app.
  assert.deepEqual(calls, [[token, { agentsUseIt: undefined }]]);
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

// ------------------------------------------------------------------ GitHub through gh: --github-signin and --github-status

const GH_LINE = 'WORKBENCH_GITHUB ';
const ghLines = (out) => out.filter((l) => l.startsWith(GH_LINE)).map((l) => JSON.parse(l.slice(GH_LINE.length)));
const SIGNED_IN = 'Signed in to GitHub as octo-cat. Git in Terminal, Workbench and your agents use this sign-in.';

test('--github-signin and --github-status: what they take, and the helpers still run one at a time, on their own', async () => {
  assert.deepEqual((({ githubSignin, githubStatus, error }) => ({ githubSignin, githubStatus, error }))(parseArgs(['--github-signin'])), { githubSignin: true, githubStatus: false, error: null });
  assert.deepEqual((({ githubSignin, githubStatus, error }) => ({ githubSignin, githubStatus, error }))(parseArgs(['--github-status', '--verbose'])), { githubSignin: false, githubStatus: true, error: null });
  const cases = [
    [['--github-signin', '--github-status'], /^Choose one: --github-signin or --github-status\./],
    [['--connect-github', '--github-signin', '--github-repos'], /^Choose one: --connect-github, --github-signin or --github-repos\./],
    [['--github-signin', '--repo', '.'], /^--github-signin runs on its own, without --demo, --repo or --clone\./],
    [['--github-status', '--demo'], /^--github-status runs on its own, without --demo, --repo or --clone\./],
    [['--github-signin', '--clone', 'https://github.com/o/r'], /^--github-signin runs on its own/],
  ];
  for (const [args, message] of cases) {
    assert.match(parseArgs(args).error, message, args.join(' '));
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('inside an agent, --github-signin and --github-status are refused too, before anything loads', async (t) => {
  const w = setup(t);
  const gh = ghWrapper(path.join(w.dir, 'ghbin'));
  const log = path.join(w.dir, 'gh-log.jsonl');
  for (const args of [['--github-signin'], ['--github-status']]) {
    const r = await runWithInput(args, { ...w.env, WORKBENCH_AGENT_ID: '', WORKBENCH_GH_BIN: gh, FAKE_GH_LOG: log }, '');
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stderr, `${INSIDE_AGENT}\n`, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  assert.equal(existsSync(log), false, 'gh never ran');
});

test('githubSigninMode: one WORKBENCH_GITHUB line per step, for the Mac app, then done (exit 0) or error (exit 1)', async () => {
  const progress = [
    { phase: 'installing', sentence: 'Getting GitHub’s command-line tool…' },
    { phase: 'code', code: null, url: null, sentence: 'Asking GitHub for a one-time code…' },
    { phase: 'code', code: FAKE_CODE, url: 'https://evil.example/not-github', sentence: 'Your code…' },
    { phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device', sentence: 'Your code…' },
    { phase: 'code', code: 'abcd-1234\nWORKBENCH_APP {}', url: 'https://github.com/login/device' },
    { phase: 'terminal', opened: true, sentence: 'Terminal is open: follow the steps there, then come back.' },
  ];
  const asked = [];
  const connect = {
    async githubSignIn(o) {
      asked.push(Object.keys(o).sort());
      for (const p of progress) o.onProgress(p);
      return { ok: true, phase: 'done', login: 'octo-cat', sentence: SIGNED_IN };
    },
  };
  const out = [];
  assert.equal(await githubSigninMode({ connect, say: (s) => out.push(s), signals: new EventEmitter() }), 0);
  assert.deepEqual(asked, [['onProgress', 'wait']]);
  assert.deepEqual(ghLines(out), [
    { phase: 'installing' },
    { phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device' },
    { phase: 'terminal' },
    { phase: 'done', login: 'octo-cat', sentence: SIGNED_IN },
  ]);
  assert.equal(out.length, 4, 'nothing else is printed');
  // Terminal could not be opened (elsewhere than macOS): the command, for the person to run.
  const elsewhere = [];
  const manual = { async githubSignIn(o) {
    o.onProgress({ phase: 'terminal', opened: false, command: '/home/ada/.local/bin/gh auth login --hostname github.com', sentence: 'Run this command in a terminal, then come back here.' });
    return { ok: false, phase: 'error', why: 'terminal', sentence: 'The sign-in in Terminal did not finish. Sign in to GitHub again to try once more.' };
  } };
  assert.equal(await githubSigninMode({ connect: manual, say: (s) => elsewhere.push(s), signals: new EventEmitter() }), 1);
  assert.deepEqual(ghLines(elsewhere), [
    { phase: 'terminal', opened: false, command: '/home/ada/.local/bin/gh auth login --hostname github.com', sentence: 'Run this command in a terminal, then come back here.' },
    { phase: 'error', sentence: 'The sign-in in Terminal did not finish. Sign in to GitHub again to try once more.' },
  ]);
  // Refused, crashed, or no Agents & keys at all: an error line in Workbench's own words.
  const logged = [];
  const lines = [];
  const say = (s) => lines.push(s);
  const log = { error: (...a) => logged.push(a.map(String).join(' ')), warn: () => {} };
  assert.equal(await githubSigninMode({ connect: { async githubSignIn() { return { ok: false, phase: 'error', why: 'checksum', sentence: 'The download did not match.' }; } }, say, log, signals: new EventEmitter() }), 1);
  assert.equal(await githubSigninMode({ connect: { async githubSignIn() { throw new TypeError('boom'); } }, say, log, signals: new EventEmitter() }), 1);
  assert.equal(await githubSigninMode({ connect: null, say, log, signals: new EventEmitter() }), 1);
  assert.equal(await githubSigninMode({ connect: { async githubSignIn() { return { ok: true, login: 'not a login\n' }; } }, say, log, signals: new EventEmitter() }), 1);
  assert.deepEqual(ghLines(lines), [
    { phase: 'error', sentence: 'The download did not match.' },
    { phase: 'error', sentence: 'Workbench could not sign in to GitHub. The details are in its log.' },
    { phase: 'error', sentence: 'Workbench could not sign in to GitHub. The details are in its log.' },
    { phase: 'error', sentence: 'Workbench could not sign in to GitHub.' },
  ]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^Signing in to GitHub failed: TypeError: boom/);
});

test('githubSigninMode: Ctrl-C, SIGTERM or SIGHUP stops the sign-in under way, and says so', async () => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const signals = new EventEmitter();
    let stop;
    const cancelled = [];
    const connect = {
      githubSignIn: (o) => new Promise((resolve) => {
        o.onProgress({ phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device' });
        stop = () => resolve({ ok: false, phase: 'error', why: 'cancelled', sentence: 'Stopped signing in to GitHub.' });
      }),
      async cancelGithubSignIn() { cancelled.push(sig); stop(); return { ok: true, sentence: 'Stopped signing in to GitHub.' }; },
    };
    const out = [];
    const done = githubSigninMode({ connect, say: (s) => out.push(s), signals });
    await sleep(20);
    signals.emit(sig);
    assert.equal(await done, 1, sig);
    assert.deepEqual(cancelled, [sig]);
    assert.deepEqual(ghLines(out), [{ phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device' }, { phase: 'error', sentence: 'Stopped signing in to GitHub.' }]);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(s), 0, 'its listeners go when it ends');
  }
});

test('githubStatusMode: whether GitHub is signed in, through gh or a token, in one WORKBENCH_GITHUB line; anything else is not signed in', async () => {
  const lines = [];
  const say = (s) => lines.push(s);
  const warned = [];
  const log = { warn: (...a) => warned.push(a) };
  const answering = (g) => ({ async githubStatus() { return g; } });
  for (const c of [
    answering({ connected: true, via: 'gh', login: 'octo-cat', sentence: SIGNED_IN }),
    answering({ connected: true, via: 'token', login: 'octo-cat' }),
    answering({ connected: false, via: null, login: null }),
    answering({ connected: true, via: 'gh', login: 'octo\ncat' }),
    answering({ connected: true, via: 'something', login: 'octo-cat' }),
    { async githubStatus() { throw new Error('gh broke'); } },
    null,
  ]) assert.equal(await githubStatusMode({ connect: c, say, log }), 0);
  assert.deepEqual(ghLines(lines), [
    { signedIn: true, login: 'octo-cat', via: 'gh' },
    { signedIn: true, login: 'octo-cat', via: 'token' },
    { signedIn: false, login: null, via: null },
    { signedIn: true, login: null, via: 'gh' },
    { signedIn: false, login: null, via: null },
    { signedIn: false, login: null, via: null },
    { signedIn: false, login: null, via: null },
  ]);
  assert.equal(warned.length, 1);
});

test('the GitHub helpers run as programs with the gh stand-in: status, sign-in (git then uses gh), the repository list, and a stop', async (t) => {
  const w = setup(t);
  const gh = ghWrapper(path.join(w.dir, 'ghbin'));
  const log = path.join(w.dir, 'gh-log.jsonl');
  const env = { ...w.env, WORKBENCH_GH_BIN: gh, FAKE_GH_STATE: path.join(w.dir, 'gh-state.json'), FAKE_GH_LOG: log, GH_TOKEN: 'person-token-not-for-gh' };
  const status = async () => {
    const r = await runWithInput(['--github-status'], env, '');
    assert.equal(r.code, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(await status(), `${GH_LINE}${JSON.stringify({ signedIn: false, login: null, via: null })}\n`);
  assert.equal((await runWithInput(['--github-repos'], env, '')).stdout, 'WORKBENCH_GITHUB_REPOS []\n', 'gh signed out: nothing, and gh api is not asked');
  const signin = await runWithInput(['--github-signin'], env, '');
  assert.equal(signin.code, 0, signin.stderr);
  assert.deepEqual(ghLines(signin.stdout.split('\n')), [
    { phase: 'code', code: FAKE_CODE, url: 'https://github.com/login/device' },
    { phase: 'done', login: 'octo-cat', sentence: SIGNED_IN },
  ]);
  assert.equal(signin.stdout.split('\n').filter(Boolean).length, 2, 'nothing else on standard output');
  // git, with this home folder's settings, asks gh for github.com.
  const helpers = execFileSync('git', ['config', '--global', '-z', '--get-all', 'credential.https://github.com.helper'], { encoding: 'utf8', env: w.env }).split('\0').slice(0, -1);
  assert.deepEqual(helpers, ['', `!${gh} auth git-credential`]);
  assert.equal(await status(), `${GH_LINE}${JSON.stringify({ signedIn: true, login: 'octo-cat', via: 'gh' })}\n`);
  const repos = await runWithInput(['--github-repos'], env, '');
  assert.equal(repos.stdout, `WORKBENCH_GITHUB_REPOS ${JSON.stringify(FAKE_REPOS.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private })))}\n`);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => !c.tokens.GH_TOKEN && !c.tokens.GITHUB_TOKEN), 'no token of the person’s reaches gh');
  assert.equal(calls.filter((c) => c.argv[0] === 'api').length, 1, 'gh api only once signed in');
  // A sign-in stopped while it waits for the person (the Mac app's Cancel sends SIGTERM): gh's login goes too.
  const waiting = spawn(process.execPath, [BIN, '--github-signin'], { env: { ...env, FAKE_GH_STATE: path.join(w.dir, 'other-state.json'), FAKE_GH_LOGIN: 'wait' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (waiting.exitCode == null && waiting.signalCode == null) waiting.kill('SIGKILL'); });
  let out = '';
  waiting.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => waiting.on('exit', (code) => resolve(code)));
  assert.ok(await until(() => out.includes('"phase":"code"')), out);
  waiting.kill('SIGTERM');
  assert.equal(await exited, 1);
  assert.deepEqual(ghLines(out.split('\n')).at(-1), { phase: 'error', sentence: 'Stopped signing in to GitHub.' });
  const login = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.argv[1] === 'login').at(-1);
  assert.ok(await until(() => { try { process.kill(login.pid, 0); return false; } catch { return true; } }), 'gh’s login was stopped');
});

test('--github-status and --github-signin read no key’s value, unless settings.json names a token connection (then its key is looked up)', async (t) => {
  const w = setup(t);
  // A key kept in a private file that has gone since: reading it says so in the log. Never the keychain.
  const id = 'k0123456789ab';
  mkdirSync(path.join(w.home, '.workbench'), { mode: 0o700 });
  writeFileSync(path.join(w.home, '.workbench', 'keys.json'), JSON.stringify({ version: 1, keys: [{
    id, preset: 'github', label: 'GitHub', vars: [{ name: 'GH_TOKEN', secret: true }, { name: 'GITHUB_TOKEN', secret: true }],
    scope: { kind: 'all' }, agents: [], kept: 'file', created: 1,
  }] }), { mode: 0o600 });
  const read = /could not read/;
  const repos = await runWithInput(['--github-repos'], w.env, '');
  assert.match(repos.stderr, read, '--github-repos reads the keys (the token may list the repositories)');
  const status = await runWithInput(['--github-status'], w.env, '');
  assert.equal(status.stdout, `${GH_LINE}${JSON.stringify({ signedIn: false, login: null, via: null })}\n`);
  assert.doesNotMatch(status.stderr, read);
  const signin = await runWithInput(['--github-signin'], w.env, '');
  assert.equal(signin.code, 1);
  assert.doesNotMatch(signin.stderr, read);
  writeFileSync(path.join(w.home, '.workbench', 'settings.json'), JSON.stringify({ github: { login: 'octo-cat', keyId: id } }), { mode: 0o600 });
  const token = await runWithInput(['--github-status'], w.env, '');
  assert.equal(token.stdout, `${GH_LINE}${JSON.stringify({ signedIn: true, login: 'octo-cat', via: 'token' })}\n`);
});

test('--github-signin with no gh where WORKBENCH_GH_BIN says: an error line, nothing downloaded, and no agent checked', async (t) => {
  const w = setup(t);
  const marks = path.join(w.dir, 'ran.txt');
  const standIn = (name) => {
    const p = path.join(w.dir, name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> '${marks}'\nexit 1\n`, { mode: 0o755 });
    return p;
  };
  const env = { ...w.env, WORKBENCH_CLAUDE_BIN: standIn('claude'), WORKBENCH_CODEX_BIN: standIn('codex') };
  const r = await runWithInput(['--github-signin'], env, '');
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, `${GH_LINE}${JSON.stringify({ phase: 'error', sentence: `GitHub’s command-line tool is not at ${path.join(w.dir, 'no-gh-here')}, the path in WORKBENCH_GH_BIN.` })}\n`);
  const st = await runWithInput(['--github-status'], env, '');
  assert.equal(st.stdout, `${GH_LINE}${JSON.stringify({ signedIn: false, login: null, via: null })}\n`);
  await sleep(200);
  assert.equal(existsSync(marks), false, existsSync(marks) ? readFileSync(marks, 'utf8') : '');
  assert.equal(existsSync(path.join(w.home, '.local', 'bin', 'gh')), false);
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
