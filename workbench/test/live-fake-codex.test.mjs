// The whole chain for Codex, with stand-ins for the binaries: CLI -> engine -> Codex runner -> codex-fake.mjs
// (replaying test/fixtures/codex-run.jsonl and codex-resume.jsonl) -> HTTP API. Nothing is spent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spentText } from '../src/shared/format.mjs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const CODEX_FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url)); // never the real codex
const MARKER = 'codex-was-here.txt';
const FINAL_SENTENCE = 'The repository contains README.md, greet.js, and test.mjs; greet.js returns a personalized greeting, and node test.mjs passes with ok.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

async function until(what, fn, { timeoutMs = 15_000, every = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(every);
  }
}

/**
 * A throwaway repository with one commit, a home folder for the engine (so its worktrees stay out of the real
 * ~/.workbench), and an engine running the fake. Everything is removed afterwards, even when the test fails.
 * `config` is committed as the repository's workbench.json.
 */
async function setup(t, extraEnv = {}, { config = null } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-live-')));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(path.join(repo, 'greet.js'), 'export const greet = (name) => `Hello, ${name}!`;\n');
  writeFileSync(path.join(repo, 'README.md'), '# greet\n');
  writeFileSync(path.join(repo, 'test.mjs'), "import { greet } from './greet.js';\nif (greet('Ada') !== 'Hello, Ada!') process.exit(1);\n");
  if (config) writeFileSync(path.join(repo, 'workbench.json'), JSON.stringify(typeof config === 'function' ? config(dir) : config));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');

  const pidfile = path.join(dir, 'fake.pid');
  const codexLog = path.join(dir, 'codex.log');
  const envDir = path.join(dir, 'agent-env');
  mkdirSync(envDir);
  mkdirSync(path.join(dir, 'tmp'));
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: path.join(dir, 'tmp'),
    WORKBENCH_CLAUDE_BIN: FAKE,
    WORKBENCH_CODEX_BIN: CODEX_FAKE,
    WORKBENCH_GH_BIN: path.join(dir, 'no-gh-here'), // never the machine's own gh, even read-only
    FAKE_CLAUDE_FIXTURE: '',
    FAKE_CODEX_LOG: codexLog,
    FAKE_CODEX_WRITE: MARKER,
    FAKE_CLAUDE_PIDFILE: pidfile,
    FAKE_CLAUDE_ENVDIR: envDir,
    CLAUDE_CONFIG_DIR: '', // Claude Code's own folders are then under this home, for the engine and the fake alike
    ...extraEnv,
  };
  // Run by an agent (npm test while it works on Workbench itself), this process has the variables every agent gets.
  // Workbench refuses to start real agents with them, so the CLI started here must not inherit them.
  for (const k of ['WORKBENCH_AGENT_ID', 'WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN']) if (!(k in extraEnv)) delete env[k];
  const proc = spawn(process.execPath, [BIN, '--repo', repo, '--no-open', '--port', '0', '--budget', '0.5'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const calls = () => (existsSync(codexLog) ? readFileSync(codexLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));

  t.after(async () => {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGINT');
      const gone = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!gone) { proc.kill('SIGKILL'); await exited; }
    }
    // If the engine could not stop its agent, end the fake's whole process group here.
    try { const pid = Number(readFileSync(pidfile, 'utf8')); if (pid && alive(pid)) process.kill(-pid, 'SIGKILL'); } catch { /* never started */ }
    for (const c of calls()) for (const pid of [c.pid, c.grandchild]) { if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } } }
    rmSync(dir, { recursive: true, force: true });
  });

  const m = await until('the engine to print its address', () => /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(log), { timeoutMs: 20_000 });
  const [, base, token] = m;
  const headers = { 'Content-Type': 'application/json', 'X-Workbench-Token': token };
  const get = async (p) => (await fetch(base + p, { headers })).json();
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const agents = async () => (await get('/api/state')).agents;

  return { dir, proc, exited, calls, pidfile, envDir, home, post, agents, log: () => log.replace(/t=[0-9a-f]+/g, 't=<token>') };
}


const CONFIG = {
  checks: [{ name: 'greeting test', run: 'node test.mjs' }],
  rules: [
    { say: 'Do not touch README.md', paths: ['README.md'] },
    { say: 'Leave the greet module alone', paths: ['greet.js'] },
    { say: 'Keep out of the notes folder', paths: ['notes/**'] },
  ],
};

async function launch(w, text) {
  const asked = await w.post('/api/command', { text });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.ok(asked.body.confirm?.id, `a confirm was expected, got ${JSON.stringify(asked.body)}`);
  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  return { asked: asked.body.confirm, ids: go.body.agentIds };
}

async function stopEngine(w) {
  w.proc.kill('SIGINT');
  const ex = await Promise.race([w.exited, sleep(15_000).then(() => null)]);
  assert.ok(ex, `Workbench did not stop within 15 s.\n${w.log()}`);
  assert.equal(ex.code, 0, w.log());
  for (const c of w.calls()) await until('the Codex process to be gone', () => !alive(c.pid), { timeoutMs: 5000 });
}

const view = async (w, id) => (await w.agents()).find((a) => a.id === id);
const lastCall = (w) => w.calls().at(-1);

test('Codex, live: start, plain steps, receipt, "not reported", resume in its sandbox, clean stop', async (t) => {
  // Markers a surrounding Claude Code or Codex session would leave in the environment.
  const w = await setup(t, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: 'old', CODEX_SANDBOX: 'seatbelt', CODEX_HOME: path.join(tmpdir(), 'wb-codex-home-not-used') }, { config: CONFIG });
  const { asked, ids } = await launch(w, 'start Codex on looking at greet.js and leaving a marker file');
  assert.match(asked.sentence, /^Start Codex on /);
  assert.equal(ids.length, 1);
  const id = ids[0];

  const done = await until('the agent to finish', async () => { const a = await view(w, id); return a?.state === 'done_checked' ? a : null; });
  assert.equal(done.harness, 'codex');
  assert.equal(done.says, FINAL_SENTENCE);
  // Steps read in plain words: no shell wrappers, no raw command lines of the `/bin/zsh -lc` kind.
  assert.ok(done.recent.length >= 3, JSON.stringify(done.recent));
  for (const r of done.recent) {
    assert.doesNotMatch(r.sentence, /zsh|-lc|\/bin\//, r.sentence);
    assert.equal(r.ok, true);
  }
  // The receipt: the new file, the check, the rules.
  assert.deepEqual(done.files.list.map((f) => [f.path, f.untracked]), [[MARKER, true]]);
  assert.equal(done.checks.state, 'passed');
  assert.equal(done.checks.results.length, 1);
  assert.equal(done.checks.results[0].name, 'greeting test');
  assert.deepEqual(done.rules.kept.map((r) => r.say).sort(), ['Do not touch README.md', 'Keep out of the notes folder', 'Leave the greet module alone']);
  assert.deepEqual(done.rules.broken, []);
  // Codex reports no cost.
  assert.equal(done.usage.costUsd, null);
  assert.equal(spentText(done.usage, done.harness), 'not reported');
  assert.equal(done.ask, null);
  const first = w.calls()[0];
  assert.deepEqual(first.argv.slice(0, 2), ['exec', '--json']);
  assert.equal(first.cwd, done.workspace);
  assert.equal(first.argv[first.argv.indexOf('-C') + 1], done.workspace);
  assert.equal(first.argv[first.argv.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(first.argv.at(-2), '--');
  assert.equal(first.agentId, id);
  assert.equal(first.stdin, 'ignored');
  assert.equal(first.env.WORKBENCH_HOOK_TOKEN, false);
  assert.equal(first.env.WORKBENCH_HOOK_URL, false);
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID', 'CODEX_SANDBOX']) assert.equal(first.env[k], false, `${k} must not reach Codex`);
  assert.equal(first.env.CODEX_HOME, true, 'the person’s Codex home stays: sign-in and resume need it');

  // A follow-up resumes the same thread, inside the sandbox.
  const sent = await w.post('/api/command', { text: 'tell it to add a note about it', focusId: id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const second = await until('the resume call', () => w.calls()[1]);
  assert.deepEqual(second.argv.slice(0, 3), ['exec', 'resume', '--json']);
  assert.ok(second.argv.includes('sandbox_mode="workspace-write"'));
  assert.equal(second.argv[second.argv.indexOf('--') + 1], done.sessionId);
  assert.match(second.argv.at(-1), /add a note/);
  assert.equal(second.argv.includes('-C'), false);
  assert.equal(second.cwd, done.workspace);
  // Both turns: the sandbox's network on, and the repository's git folders writable, so Codex can commit and push. The
  // worktree's own git folder is the one its .git file names, inside the repository's .git.
  const own = realpathSync(readFileSync(path.join(done.workspace, '.git'), 'utf8').trim().replace(/^gitdir: /, ''));
  const common = realpathSync(path.join(w.dir, 'repo', '.git'));
  assert.equal(path.dirname(own), path.join(common, 'worktrees'));
  for (const call of [first, second]) {
    assert.ok(call.argv.includes('sandbox_workspace_write.network_access=true'), JSON.stringify(call.argv));
    assert.ok(call.argv.includes(`sandbox_workspace_write.writable_roots=["${common}","${own}"]`), JSON.stringify(call.argv));
  }
  await until('the resumed turn to finish', async () => { const a = await view(w, id); return a?.state === 'done_checked' && a.says === 'banana' && w.calls().length === 2 ? a : null; });
  assert.equal((await view(w, id)).usage.costUsd, null);

  // Stopping Workbench leaves no Codex process; the work stays.
  await stopEngine(w);
  for (const c of w.calls()) assert.equal(alive(c.pid), false);
  assert.equal(existsSync(path.join(done.workspace, MARKER)), true);
});

test('stopping Codex, or Workbench, mid-turn ends its process and the commands it started', async (t) => {
  const w = await setup(t, { FAKE_CODEX_MODE: 'hang' });
  const { ids } = await launch(w, 'start Codex on running the tests in watch mode');
  const id = ids[0];
  const c1 = await until('codex to start its command', () => { const c = w.calls()[0]; return c?.grandchild ? c : null; });
  await until('a working step', async () => (await view(w, id))?.state === 'working');
  assert.ok(alive(c1.pid) && alive(c1.grandchild));

  assert.equal((await w.post(`/api/agents/${id}/stop`, {})).status, 200);
  await until('codex and its command to be gone', () => !alive(c1.pid) && !alive(c1.grandchild), { timeoutMs: 8000 });
  assert.equal((await view(w, id)).state, 'stopped');

  // A second agent, stopped by the engine's own shutdown.
  const two = await launch(w, 'start Codex on running the tests in watch mode');
  const c2 = await until('the second codex', () => { const c = w.calls()[1]; return c?.grandchild ? c : null; });
  await until('it to work', async () => (await view(w, two.ids[0]))?.state === 'working');
  w.proc.kill('SIGINT');
  const ex = await Promise.race([w.exited, sleep(15_000).then(() => null)]);
  assert.ok(ex, `Workbench did not stop.\n${w.log()}`);
  assert.equal(ex.code, 0, w.log());
  await until('everything to be gone', () => !alive(c2.pid) && !alive(c2.grandchild), { timeoutMs: 3000 });
});

test('"start Claude and Codex on …" gives two agents, one of each', async (t) => {
  const w = await setup(t);
  const { asked, ids } = await launch(w, 'start Claude and Codex on the checkout bug');
  assert.equal(ids.length, 2);
  assert.equal(asked.sentence, 'Start Claude and Codex on “the checkout bug”?');
  const all = await until('both agents', async () => { const a = await w.agents(); return a.length === 2 && a.every((x) => x.state.startsWith('done')) ? a : null; });
  assert.deepEqual(all.map((a) => a.harness).sort(), ['claude', 'codex']);
  assert.notEqual(all[0].workspace, all[1].workspace);
  assert.equal(w.calls().length, 1, 'one Codex process');
  await stopEngine(w);
});

test('a Codex that fails to sign in shows a plain error', async (t) => {
  const w = await setup(t, { FAKE_CODEX_MODE: 'fail-first' });
  const { ids } = await launch(w, 'start Codex on the checkout bug');
  const failed = await until('the agent to fail', async () => { const a = await view(w, ids[0]); return a?.state === 'failed' && a.error ? a : null; }); // the error comes with agent.ended, a moment after the state
  assert.ok(failed.error && failed.error.length < 400, failed.error);
  assert.doesNotMatch(String(failed.stateReason || failed.error), /\{"error"|bearer/i);
  await stopEngine(w);
});
