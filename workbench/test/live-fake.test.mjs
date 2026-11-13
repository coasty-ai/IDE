// The whole chain, with a stand-in for Claude Code, driven through the product's own HTTP API:
//   CLI -> engine -> Claude runner -> fake claude (replays a recorded real run) -> the real hook bridge
//   -> POST /hook/pretool -> engine -> the person's answer -> the bridge -> the fake.
// The recorded run: an agent starts an Explore helper, the helper lists files (`find … | sort`, which the policy
// holds) and reads two, then the agent runs one shell command of its own, replaced here by
// `touch agent-was-here.txt` (also held). Nothing is spent and nothing leaves this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const CODEX_FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url)); // never the real codex
const MARKER = 'agent-was-here.txt';
const FINAL_SENTENCE = 'The greet.js module is functioning correctly—the test passed successfully.';

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
async function setup(t, extraEnv = {}, { config = null, claudeSettings = null, app = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-live-')));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(path.join(repo, 'greet.js'), 'export const greet = (name) => `Hello, ${name}!`;\n');
  writeFileSync(path.join(repo, 'README.md'), '# greet\n');
  writeFileSync(path.join(repo, 'test.mjs'), "import { greet } from './greet.js';\nif (greet('Ada') !== 'Hello, Ada!') process.exit(1);\n");
  if (config) writeFileSync(path.join(repo, 'workbench.json'), JSON.stringify(typeof config === 'function' ? config(dir) : config));
  if (claudeSettings) {
    mkdirSync(path.join(repo, '.claude'));
    writeFileSync(path.join(repo, '.claude', 'settings.json'), JSON.stringify(claudeSettings));
  }
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Workbench test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');

  const pidfile = path.join(dir, 'fake.pid');
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
    FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl',
    FAKE_CLAUDE_HOOKS: '1',
    FAKE_CLAUDE_ROOT_BASH: `touch ${MARKER}`,
    FAKE_CLAUDE_PIDFILE: pidfile,
    FAKE_CLAUDE_ENVDIR: envDir,
    CLAUDE_CONFIG_DIR: '', // Claude Code's own folders are then under this home, for the engine and the fake alike
    ...extraEnv,
  };
  // Run by an agent (npm test while it works on Workbench itself), this process has the variables every agent gets.
  // Workbench refuses to start real agents with them, so the CLI started here must not inherit them.
  for (const k of ['WORKBENCH_AGENT_ID', 'WORKBENCH_HOOK_URL', 'WORKBENCH_HOOK_TOKEN']) if (!(k in extraEnv)) delete env[k];
  // `app`: started as the Mac app starts it, with --app and a pipe for its standard input.
  const args = [BIN, '--repo', repo, '--no-open', '--port', '0', '--budget', '0.5', ...(app ? ['--app'] : [])];
  const proc = spawn(process.execPath, args, { env, stdio: [app ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));

  t.after(async () => {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGINT');
      const gone = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!gone) { proc.kill('SIGKILL'); await exited; }
    }
    // If the engine could not stop its agent, end the fake's whole process group here.
    try { const pid = Number(readFileSync(pidfile, 'utf8')); if (pid && alive(pid)) process.kill(-pid, 'SIGKILL'); } catch { /* never started */ }
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

  return { dir, repo, env, proc, exited, pidfile, envDir, home, post, agents, log: () => log.replace(/t=[0-9a-f]+/g, 't=<token>') };
}

async function startAgent(w) {
  const asked = await w.post('/api/command', { text: 'start an agent to look at greet.js and leave a marker file' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.ok(asked.body.confirm?.id, `a confirm was expected, got ${JSON.stringify(asked.body)}`);
  assert.match(asked.body.confirm.detail, /\$0\.50/); // the --budget reaches the agent
  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.equal(go.body.agentIds?.length, 1);
  return go.body.agentIds[0];
}

/** Wait for the helper's held `find … | sort`. Returns the root and the helper at that moment. */
async function helperAsks(w) {
  return until('the helper to ask for an OK', async () => {
    const all = await w.agents();
    const helper = all.find((a) => a.parentId && a.state === 'needs_ok' && a.ask);
    return helper ? { root: all.find((a) => a.id === helper.parentId), helper } : null;
  });
}

async function stopEngine(w) {
  const fakePid = Number(readFileSync(w.pidfile, 'utf8'));
  w.proc.kill('SIGINT');
  const ex = await Promise.race([w.exited, sleep(15_000).then(() => null)]);
  assert.ok(ex, `Workbench did not stop within 15 s.\n${w.log()}`);
  assert.equal(ex.code, 0, w.log());
  await until('the fake agent to be gone', () => !alive(fakePid), { timeoutMs: 5000 });
  return fakePid;
}

test('a recorded run, live: helper, two held commands, Allow, receipt, clean stop', async (t) => {
  const w = await setup(t);
  const id = await startAgent(w);

  // 1. The helper's `find … | sort` is held. The helper needs an OK; its agent is waiting for it.
  const { root, helper } = await helperAsks(w);
  assert.equal(root.id, id);
  assert.equal(root.state, 'waiting_helpers');
  assert.equal(helper.ask.type, 'permission');
  assert.deepEqual(helper.ask.options, ['Allow', 'Deny']);
  assert.match(helper.ask.sentence, new RegExp(`^${helper.name} `));
  assert.match(helper.ask.detail, /^find .* \| sort$/);
  assert.equal(helper.helperType, 'Explore');
  const workspace = root.workspace;
  assert.ok(workspace && existsSync(path.join(workspace, 'greet.js')), 'the agent works in its own copy of the repository');

  const a1 = await w.post(`/api/agents/${helper.id}/answer`, { askId: helper.ask.id, answer: 'Allow' });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.ok, true);

  // 2. The agent's own `touch` is held: it has not run yet.
  const asking = await until('the agent to ask for an OK', async () => (await w.agents()).find((a) => a.id === id && a.state === 'needs_ok' && a.ask));
  assert.equal(asking.ask.detail, `touch ${MARKER}`);
  assert.match(asking.ask.sentence, new RegExp(`^${asking.name} `));
  assert.equal(existsSync(path.join(workspace, MARKER)), false, 'a held command must not run');
  const helperNow = (await w.agents()).find((a) => a.id === helper.id);
  assert.equal(helperNow.state, 'finished');
  assert.equal(helperNow.approvals.byYou, 1);

  // 3. Allow releases it; the run ends with a receipt that shows the new file.
  const a2 = await w.post(`/api/agents/${id}/answer`, { askId: asking.ask.id, answer: 'Allow' });
  assert.equal(a2.status, 200);
  const done = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  assert.equal(existsSync(path.join(workspace, MARKER)), true, 'Allow must let the command run');
  assert.equal(done.says, FINAL_SENTENCE);
  assert.equal(done.files.changed, 1);
  assert.deepEqual(done.files.list.map((f) => [f.path, f.untracked]), [[MARKER, true]]);
  assert.equal(done.checks, null); // the repository declares no checks: "done", not "done and checked"
  assert.deepEqual(done.approvals, { auto: 3, byYou: 1, denied: 0 }); // ToolSearch, TaskCreate, Agent; then touch
  assert.equal(done.helpers.total, 1);
  assert.equal(done.ask, null);

  // 4. Stopping Workbench ends the agent's process. Its work stays, in its own folder, and Workbench says where.
  await stopEngine(w);
  assert.equal(existsSync(path.join(workspace, MARKER)), true, 'the agent’s work is kept after Workbench stops');
  assert.match(w.log(), new RegExp(`What the agent did stays on this computer, in its own folder:\\n  ${done.name}: ${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(branch workbench/`));
});

/**
 * Checks that write "<their shell's pid> <their sleep's pid>" to a file. The shell leads the check's own process group,
 * so cleanup ends the whole group even when the test fails (the setup removes the file first, so remember what was read).
 */
function checkProcesses(t, file) {
  const groups = new Set();
  const read = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').map(Number)) : []);
  t.after(() => { for (const g of groups) { try { process.kill(-g, 'SIGKILL'); } catch { /* already gone */ } } });
  return () => { const all = read(); for (const [g] of all) groups.add(g); return all.map(([, child]) => child); };
}

test('a running check ends when its agent is stopped, and when Workbench stops; folders with no changes go', async (t) => {
  const pids = (dir) => path.join(dir, 'checks.pids');
  // A check that stays quiet for a minute, with a child of its own: the kind that outlived Workbench before.
  const w = await setup(t, { FAKE_CLAUDE_FIXTURE: '' }, { config: (dir) => ({ checks: [{ name: 'slow check', run: `sleep 60 & echo $$ $! >> '${pids(dir)}'; wait` }] }) });
  const checkPids = checkProcesses(t, pids(w.dir));
  const running = async (id) => until('its check to run', async () => {
    const a = (await w.agents()).find((x) => x.id === id);
    return a?.checks?.state === 'running' && checkPids().length ? a : null;
  });

  const a = await startAgent(w);
  const first = await running(a);
  const [aPid] = checkPids();
  assert.ok(alive(aPid));
  const stop = await w.post(`/api/agents/${a}/stop`);
  assert.equal(stop.status, 200);
  await until('the stopped agent’s check to end', () => !alive(aPid), { timeoutMs: 3000 });
  const after = (await w.agents()).find((x) => x.id === a);
  assert.equal(after.state, 'stopped');
  assert.notEqual(after.checks?.state, 'running', 'the card no longer says the checks are running');

  const b = await startAgent(w);
  await until('the second check', () => checkPids().length === 2);
  await running(b);
  const bPid = checkPids()[1];
  await stopEngine(w);
  await until('the check to end with Workbench', () => !alive(bPid), { timeoutMs: 3000 });
  // Neither agent changed anything, so neither folder is kept.
  assert.equal(existsSync(first.workspace), false);
  assert.doesNotMatch(w.log(), /stays on this computer/);
});

test('a check that ignores SIGTERM still ends when Workbench is stopped twice in a row', async (t) => {
  const pids = (dir) => path.join(dir, 'stubborn.pids');
  const w = await setup(t, { FAKE_CLAUDE_FIXTURE: '' }, { config: (dir) => ({ checks: [{ name: 'stubborn check', run: `trap '' TERM; sleep 60 & echo $$ $! >> '${pids(dir)}'; wait` }] }) });
  const checkPids = checkProcesses(t, pids(w.dir));
  const checkPid = () => checkPids()[0] || 0;
  const id = await startAgent(w);
  const agent = await until('its check to run', async () => { const a = (await w.agents()).find((x) => x.id === id); return a?.checks?.state === 'running' && checkPid() ? a : null; });
  const pid = checkPid();
  // The first Ctrl-C asks everything to stop; the second does not wait (the check would get SIGKILL only 2 s later).
  w.proc.kill('SIGINT');
  await sleep(300);
  w.proc.kill('SIGINT');
  const ex = await Promise.race([w.exited, sleep(10_000).then(() => null)]);
  assert.ok(ex, `Workbench did not stop.\n${w.log()}`);
  assert.equal(ex.code, 130);
  await until('the stubborn check to be gone', () => !alive(pid), { timeoutMs: 1000 });
  // A forced exit skips the tidying, so the folder stays; the terminal still says where it is, without claiming work.
  assert.equal(existsSync(agent.workspace), true);
  const at = agent.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(w.log(), new RegExp(`The agent’s folder is still on this computer:\\n  ${agent.name}: ${at} \\(branch workbench/`));
  assert.doesNotMatch(w.log(), /What the agent did stays/);
});

test('saying no to a held command keeps it from running, and the agent hears why', async (t) => {
  const w = await setup(t);
  const id = await startAgent(w);
  const { helper } = await helperAsks(w);
  await w.post(`/api/agents/${helper.id}/answer`, { askId: helper.ask.id, answer: 'Allow' });
  const asking = await until('the agent to ask for an OK', async () => (await w.agents()).find((a) => a.id === id && a.state === 'needs_ok' && a.ask));

  const no = await w.post(`/api/agents/${id}/answer`, { askId: asking.ask.id, answer: 'Deny' });
  assert.equal(no.status, 200);
  assert.equal(no.body.ok, true);
  const done = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  assert.equal(existsSync(path.join(done.workspace, MARKER)), false, 'Deny must keep the command from running');
  assert.equal(done.files.changed, 0);
  assert.deepEqual(done.approvals, { auto: 3, byYou: 0, denied: 1 });
  // The fake turns a refusal into a failed step, as Claude Code does: the agent saw the person's answer.
  assert.equal(done.recent.at(-1).ok, false);
  await stopEngine(w);
});

test('stopping Workbench while a command is held ends the agent and its hook', async (t) => {
  const w = await setup(t);
  await startAgent(w);
  await helperAsks(w);
  const hookPid = Number(readFileSync(w.pidfile + '.hook', 'utf8'));
  assert.ok(alive(hookPid), 'the hook is waiting for the answer');

  const started = Date.now();
  await stopEngine(w);
  assert.ok(Date.now() - started < 10_000, 'a held request must not delay the stop');
  await until('the hook to be gone', () => !alive(hookPid), { timeoutMs: 5000 });
});

test('the Mac app going away without a word (it crashed) ends the agent and its hook as quickly as Ctrl-C', async (t) => {
  const w = await setup(t, {}, { app: true });
  await startAgent(w);
  await helperAsks(w);
  const fakePid = Number(readFileSync(w.pidfile, 'utf8'));
  const hookPid = Number(readFileSync(w.pidfile + '.hook', 'utf8'));
  assert.ok(alive(fakePid) && alive(hookPid), 'the agent works, and its hook waits for the answer');
  // A crash closes the app's ends of all three pipes: Workbench's input ends, and its writes find no reader.
  const started = Date.now();
  w.proc.stdout.destroy();
  w.proc.stderr.destroy();
  w.proc.stdin.end();
  const ex = await Promise.race([w.exited, sleep(15_000).then(() => null)]);
  assert.ok(ex, 'Workbench did not stop within 15 s of the app going away');
  assert.ok(Date.now() - started < 10_000, `Workbench took ${Date.now() - started} ms: the stop must not wait for the forced exit`);
  await until('the fake agent to be gone', () => !alive(fakePid), { timeoutMs: 5000 });
  await until('the hook to be gone', () => !alive(hookPid), { timeoutMs: 5000 });
});

test('one agent cannot ask in another agent’s name, and a stopped agent’s token shows nothing', async (t) => {
  // No recorded run: each fake answers its task with one line and waits, so nothing else asks.
  const w = await setup(t, { FAKE_CLAUDE_FIXTURE: '', FAKE_CLAUDE_ROOT_BASH: '' });
  const a = await startAgent(w);
  const b = await startAgent(w);
  const envOf = (id) => until(`the environment of ${id}`, () => { try { return JSON.parse(readFileSync(path.join(w.envDir, `${id}.json`), 'utf8')); } catch { return null; } });
  const ea = await envOf(a);
  const eb = await envOf(b);
  assert.notEqual(ea.token, eb.token, 'each agent has its own hook token');
  const call = async (tok, agentId, tool_name, tool_input) => {
    const res = await fetch(ea.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': tok },
      body: JSON.stringify({ agentId, payload: { hook_event_name: 'PreToolUse', tool_name, tool_input } }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const hook = (tok, agentId, command) => call(tok, agentId, 'Bash', { command });
  const decided = (r) => r.body?.hookSpecificOutput?.permissionDecision;
  const view = async (id) => (await w.agents()).find((x) => x.id === id);
  await until('both agents to settle', async () => (await view(a))?.state === 'done_claimed' && (await view(b))?.state === 'done_claimed');
  const before = await view(b);

  const cross = await hook(ea.token, b, 'git push --force origin main');
  assert.equal(cross.status, 401);
  const after = await view(b);
  assert.equal(after.ask, null, 'nothing shows on the other agent');
  assert.equal(after.state, before.state);
  assert.deepEqual(after.approvals, before.approvals);

  // The real permission check hears from the engine who this agent's own helpers are, and where its own session's
  // folders are (from its runner, keyed by its own session id).
  assert.equal(decided(await call(ea.token, a, 'SendMessage', { to: 'main', message: 'Done here.' })), 'allow');
  const sid = (await view(a)).sessionId;
  assert.match(sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const projects = path.join(w.home, '.claude', 'projects', 'some-key');
  const mine = path.join(projects, sid, 'tool-results', 'out.txt');
  const theirs = path.join(projects, '11111111-2222-4333-8444-555555555555', 'tool-results', 'out.txt');
  for (const f of [mine, theirs]) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, 'long output\n'); }
  assert.equal(decided(await call(ea.token, a, 'Read', { file_path: mine })), 'allow');
  const readOther = call(ea.token, a, 'Read', { file_path: theirs });
  const askedRead = await until('A to ask about another session\'s file', async () => { const v = await view(a); return v?.ask?.detail === theirs ? v : null; });
  assert.equal(askedRead.ask.why, "It wants to look at something outside the agent's own folder.");
  await w.post(`/api/agents/${a}/answer`, { askId: askedRead.ask.id, answer: 'Deny' });
  assert.equal(decided(await readOther), 'deny');
  const message = call(ea.token, a, 'SendMessage', { to: 'someone-else', message: 'hello' });
  const askedMessage = await until('A to ask about the message', async () => { const v = await view(a); return v?.ask?.detail?.startsWith('To someone-else') ? v : null; });
  assert.match(askedMessage.ask.sentence, /wants to send a message to someone other than its helpers$/);
  await w.post(`/api/agents/${a}/answer`, { askId: askedMessage.ask.id, answer: 'Deny' });
  assert.equal(decided(await message), 'deny');

  // Its own token still works for itself, and the ask says why it waits.
  const own = hook(ea.token, a, 'touch a.txt');
  const asked = await until('A to ask', async () => { const v = await view(a); return v?.ask?.detail === 'touch a.txt' ? v : null; });
  assert.equal(asked.ask.why, 'This command is not on the list of safe commands.');
  await w.post(`/api/agents/${a}/answer`, { askId: asked.ask.id, answer: 'Deny' });
  assert.equal((await own).body.hookSpecificOutput.permissionDecision, 'deny');

  // Once A is stopped, its token gets a plain no and nothing shows.
  assert.equal((await w.post(`/api/agents/${a}/stop`, {})).status, 200);
  const late = await hook(ea.token, a, 'touch b.txt');
  assert.equal(late.status, 200);
  assert.equal(late.body.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(late.body.hookSpecificOutput.permissionDecisionReason, 'This agent was stopped.');
  assert.equal((await view(a)).ask, null);
  await stopEngine(w);
});

test('a work request that starts with "stop" is offered as new work; only the agent’s name stops it', async (t) => {
  const w = await setup(t);
  const asked = await w.post('/api/command', { text: 'start an agent to fix the flaky checkout test' });
  // The launch question's own "yes", typed: it carries the id of the card on screen.
  const go = await w.post('/api/command', { text: 'yes', confirmId: asked.body.confirm.id });
  assert.equal(go.body.reply, 'Started Fix flaky checkout test.');
  const id = go.body.focusId;
  const { root, helper } = await helperAsks(w);
  assert.equal(root.id, id);
  const fakePid = Number(readFileSync(w.pidfile, 'utf8'));

  const work = await w.post('/api/command', { text: 'stop the flaky checkout test from timing out' });
  assert.equal(work.status, 200, JSON.stringify(work.body));
  assert.equal(work.body.confirm?.sentence, 'Start Claude on “stop the flaky checkout test from timing out”?');
  await sleep(300);
  assert.ok(alive(fakePid), 'the running agent was not stopped');
  const now = await w.agents();
  assert.equal(now.find((a) => a.id === id).state, 'waiting_helpers');
  assert.equal(now.find((a) => a.id === helper.id).state, 'needs_ok', 'its held request still waits for the person');
  // The page let go of the card without a command (the person picked an agent): it withdraws it.
  assert.equal((await w.post(`/api/confirm/${encodeURIComponent(work.body.confirm.id)}`, { go: false })).body.reply, 'OK, I won’t start it.');

  // Its name alone still stops it in one step.
  const stop = await w.post('/api/command', { text: 'stop the flaky checkout test' });
  assert.equal(stop.body.reply, 'Stopped Fix flaky checkout test.');
  await until('the fake agent to be gone', () => !alive(fakePid), { timeoutMs: 5000 });
  await stopEngine(w);
});

test('a typed "yes" counts only for the request on screen, and a yes with conditions is a no', async (t) => {
  const w = await setup(t);
  const id = await startAgent(w);
  const { helper } = await helperAsks(w);

  // Sent without the ask that was on screen (the page showed something else when the person began): nothing happens.
  const unseen = await w.post('/api/command', { text: 'yes', focusId: helper.id });
  assert.equal(unseen.body.reply, `Have a look at what ${helper.name} is asking first.`);
  await sleep(200);
  assert.equal((await w.agents()).find((a) => a.id === helper.id).state, 'needs_ok');
  // Another ask's button, or a typed yes, sent to the answer route: refused too.
  const loose = await w.post(`/api/agents/${helper.id}/answer`, { askId: helper.ask.id, answer: 'Yes' });
  assert.deepEqual(loose.body, { ok: false, reply: 'Choose Allow or Deny.' });
  // A yes asked rather than said, with the ask on screen: it answers nothing, and says exactly what is asked for.
  const asked = await w.post('/api/command', { text: 'is it okay to run that', focusId: helper.id, askId: helper.ask.id });
  assert.ok(asked.body.reply.startsWith(`${helper.ask.sentence}: “`) && asked.body.reply.endsWith('”. It needs your OK.'), asked.body.reply);
  assert.equal((await w.agents()).find((a) => a.id === helper.id).ask?.id, helper.ask.id);

  // With the ask on screen, a plain yes allows it.
  const yes = await w.post('/api/command', { text: 'yes', focusId: helper.id, askId: helper.ask.id });
  assert.equal(yes.body.reply, `OK, ${helper.name} can go ahead.`);

  // The agent's own `touch`: "yes but only in the tests folder" is a no, so the command does not run.
  const asking = await until('the agent to ask for an OK', async () => (await w.agents()).find((a) => a.id === id && a.state === 'needs_ok' && a.ask));
  const cond = await w.post('/api/command', { text: 'yes but only in the tests folder', focusId: id, askId: asking.ask.id });
  assert.equal(cond.body.reply, `OK, ${asking.name} will not do it as asked. I passed on your words.`);
  const done = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  assert.equal(existsSync(path.join(done.workspace, MARKER)), false, 'a yes with conditions must not let the command run');
  assert.deepEqual(done.approvals, { auto: 3, byYou: 0, denied: 1 });
  assert.equal(done.recent.at(-1).ok, false, 'the agent saw the refusal');
  await stopEngine(w);
});

test('a committed .claude/settings.json cannot redirect the hook bridge or change its agent id', async (t) => {
  const hits = [];
  const decoy = createServer((req, res) => { hits.push(req.url); res.statusCode = 200; res.end('{"decision":"allow"}'); });
  await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
  t.after(() => decoy.close());
  const url = `http://127.0.0.1:${decoy.address().port}`;
  const w = await setup(t, {}, { claudeSettings: { env: { WORKBENCH_HOOK_URL: url, WORKBENCH_AGENT_ID: 'someone-else' } } });
  await startAgent(w);
  // The request reaches the real engine and is held there for the person: it did not go to the decoy.
  const { root, helper } = await helperAsks(w);
  assert.equal(helper.state, 'needs_ok');
  assert.equal(hits.length, 0, 'nothing went to the address the repository named');
  await stopEngine(w);
});

/** Another Workbench on the same repository and home folder as `w` (which has stopped), as after a restart. */
async function relaunch(t, w) {
  const proc = spawn(process.execPath, [BIN, '--repo', w.repo, '--no-open', '--port', '0', '--budget', '0.5'], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.kill('SIGINT');
      const gone = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
      if (!gone) { proc.kill('SIGKILL'); await exited; }
    }
  });
  const m = await until('the engine to print its address', () => /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(log), { timeoutMs: 20_000 });
  const [, base, token] = m;
  const headers = { 'Content-Type': 'application/json', 'X-Workbench-Token': token };
  const get = async (p) => (await fetch(base + p, { headers })).json();
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const stop = async () => {
    proc.kill('SIGINT');
    const ex = await Promise.race([exited, sleep(15_000).then(() => null)]);
    assert.ok(ex, `Workbench did not stop within 15 s.\n${log}`);
    assert.equal(ex.code, 0, log);
  };
  return { post, agents: async () => (await get('/api/state')).agents, stop, log: () => log };
}

test('history: stop Workbench, start it again, and the agent is there to continue in the same folder', async (t) => {
  // No recorded run: the stand-in answers each message with one line, so a turn ends at once.
  const w = await setup(t, { FAKE_CLAUDE_FIXTURE: '' });
  const asked = await w.post('/api/command', { text: 'start an agent to say hello in the greeting file' });
  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  const id = go.body.agentIds[0];
  const first = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  assert.match(first.says, /^You said: /);
  assert.ok(first.sessionId, 'the session id is known');
  writeFileSync(path.join(first.workspace, 'notes.txt'), 'work the agent left\n'); // a folder with changes is kept
  await stopEngine(w);

  // What was written: one file under the home folder, with the agent and no key.
  const dir = path.join(w.home, '.workbench', 'history');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, files.join(', '));
  assert.match(files[0], /^repo-[0-9a-f]{8}\.json$/);
  const text = readFileSync(path.join(dir, files[0]), 'utf8');
  const rec = JSON.parse(text).agents[0];
  assert.equal(rec.id, id);
  assert.equal(rec.sessionId, first.sessionId);
  assert.equal(rec.workspace.path, first.workspace);
  assert.match(rec.workspace.branch, /^workbench\//);
  assert.equal(/[0-9a-f]{64}/.test(text), false, 'no page token or hook token');

  // A second Workbench: the agent is back, earlier, finished, and can continue.
  const w2 = await relaunch(t, w);
  const back = (await w2.agents()).find((a) => a.id === id);
  assert.ok(back, 'the earlier agent is in the snapshot');
  assert.equal(back.earlier, true);
  assert.equal(back.state, 'done_claimed');
  assert.ok(back.endedAt > 0);
  assert.equal(back.canContinue, true);
  assert.equal(back.workspace, first.workspace);

  const said = await w2.post(`/api/agents/${id}/say`, { text: 'now say goodbye' });
  assert.equal(said.status, 200);
  assert.equal(said.body.ok, true, JSON.stringify(said.body));
  assert.match(said.body.reply, /is continuing in its own folder\. It has a new spending limit of \$0\.50 for this run\./);
  const again = await until('the agent to finish its second run', async () => {
    const a = (await w2.agents()).find((x) => x.id === id);
    return a && a.earlier === false && a.state === 'done_claimed' && /goodbye/.test(a.says || '') ? a : null;
  });
  // The stand-in says which session it resumed and with what budget.
  assert.equal(again.says, `You said (resumed ${first.sessionId} with budget 0.5): now say goodbye`);
  assert.equal(again.workspace, first.workspace);
  assert.equal(again.budgetUsd, 0.5);
  await w2.stop();

  // A third: forget it. It asks first; yes removes it from the board and the file, and the folder stays.
  const w3 = await relaunch(t, w);
  assert.equal((await w3.agents()).find((a) => a.id === id)?.earlier, true);
  const ask = await w3.post('/api/command', { text: 'forget it', focusId: id });
  assert.ok(ask.body.confirm?.id, JSON.stringify(ask.body));
  assert.equal((await w3.agents()).length, 1, 'nothing is forgotten before the yes');
  const yes = await w3.post(`/api/confirm/${encodeURIComponent(ask.body.confirm.id)}`, { go: true });
  assert.match(yes.body.reply, /^Forgot /);
  assert.equal((await w3.agents()).length, 0);
  await w3.stop();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8')).agents, []);
  assert.equal(existsSync(path.join(first.workspace, 'notes.txt')), true, 'forgetting does not delete the folder');
});

test('history: an earlier agent whose folder was removed is shown, and refuses to continue in plain words', async (t) => {
  const w = await setup(t, { FAKE_CLAUDE_FIXTURE: '' });
  const asked = await w.post('/api/command', { text: 'start an agent to say hello in the greeting file' });
  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  const id = go.body.agentIds[0];
  const first = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  writeFileSync(path.join(first.workspace, 'notes.txt'), 'x\n');
  await stopEngine(w);
  execFileSync('git', ['-C', w.repo, 'worktree', 'remove', '--force', first.workspace], { stdio: 'pipe' });

  const w2 = await relaunch(t, w);
  const back = (await w2.agents()).find((a) => a.id === id);
  assert.equal(back.earlier, true);
  assert.equal(back.canContinue, false);
  assert.equal(back.continueReason, 'Its folder is gone, so it cannot continue.');
  const said = await w2.post(`/api/agents/${id}/say`, { text: 'carry on' });
  assert.equal(said.body.ok, false);
  assert.match(said.body.reply, /cannot continue\. Its folder is gone/);
  await w2.stop();
});

// ---- Source control, live: merge an agent's work into the person's branch, and throw an agent's work away ----

/** A person's git identity for the engine (it never uses git's guessed one): a global config file of its own. */
function withIdentity(t) {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-gitid-')));
  const file = path.join(d, 'gitconfig');
  writeFileSync(file, '[user]\n\tname = Person Testing\n\temail = person@example.invalid\n');
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return { GIT_CONFIG_GLOBAL: file };
}

/** The recorded run, start to finish: the helper's and the agent's commands allowed; it ends "done" with one new file. */
async function runToDone(w) {
  const id = await startAgent(w);
  const { helper } = await helperAsks(w);
  assert.equal((await w.post(`/api/agents/${helper.id}/answer`, { askId: helper.ask.id, answer: 'Allow' })).status, 200);
  const asking = await until('the agent to ask for an OK', async () => (await w.agents()).find((a) => a.id === id && a.state === 'needs_ok' && a.ask));
  assert.equal((await w.post(`/api/agents/${id}/answer`, { askId: asking.ask.id, answer: 'Allow' })).status, 200);
  const done = await until('the agent to finish', async () => (await w.agents()).find((a) => a.id === id && a.state === 'done_claimed'));
  return { id, done, workspace: done.workspace };
}

const gitOut = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

test('merge, live: a finished agent’s work joins the person’s branch with a merge commit; their own changes stay', async (t) => {
  const w = await setup(t, withIdentity(t));
  const { id, done, workspace } = await runToDone(w);
  const branch = gitOut(w.repo, 'symbolic-ref', '--short', 'HEAD');
  const before = gitOut(w.repo, 'rev-parse', 'HEAD');
  // The person's own work in progress: an edit to a tracked file and a file git does not know yet.
  writeFileSync(path.join(w.repo, 'README.md'), '# greet\n\nNotes the person is writing.\n');
  writeFileSync(path.join(w.repo, 'my-notes.txt'), 'mine, not committed\n');
  assert.equal(done.work?.branch?.startsWith('workbench/'), true, JSON.stringify(done.work));

  // 1. Merge asks first, with the branch it would go into.
  const asked = await w.post(`/api/agents/${id}/merge`, { state: done.state });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.confirm?.kind, 'merge', JSON.stringify(asked.body));
  assert.equal(asked.body.confirm.yes, 'Merge');
  assert.equal(asked.body.confirm.sentence, `Merge ${done.name} into ${branch}?`);
  assert.equal(gitOut(w.repo, 'rev-parse', 'HEAD'), before, 'nothing is merged before the yes');

  // 2. Yes merges it.
  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.match(go.body.reply, new RegExp(`^Merged ${done.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} into ${branch}\\.`));

  // The person's HEAD is a merge commit: first parent their old HEAD, second the agent's work commit.
  const parents = gitOut(w.repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1);
  assert.equal(parents.length, 2, 'a merge commit has two parents');
  assert.equal(parents[0], before);
  assert.match(gitOut(w.repo, 'log', '-1', '--format=%B', parents[1]), new RegExp(`Workbench-Agent: ${id}`));
  assert.match(gitOut(w.repo, 'log', '-1', '--format=%B', 'HEAD'), /Workbench-Kind: merge/);
  assert.equal(gitOut(w.repo, 'log', '-1', '--format=%an <%ae>', 'HEAD'), 'Person Testing <person@example.invalid>');
  assert.equal(readFileSync(path.join(w.repo, MARKER), 'utf8'), '', 'the agent’s new file is in the person’s folder');
  // Their own changes are exactly as they were.
  assert.equal(readFileSync(path.join(w.repo, 'README.md'), 'utf8'), '# greet\n\nNotes the person is writing.\n');
  assert.equal(readFileSync(path.join(w.repo, 'my-notes.txt'), 'utf8'), 'mine, not committed\n');
  assert.equal(gitOut(w.repo, 'diff', '--name-only'), 'README.md', 'their edit is still an uncommitted change');

  const after = await until('the view to say it is merged', async () => (await w.agents()).find((a) => a.id === id && a.work?.merged));
  assert.equal(after.work.merged.into, branch);
  assert.equal(after.work.problem, null);
  assert.equal(after.files?.changed, 0, 'nothing is left unmerged');

  // 3. A second merge has nothing new to take.
  const again = await w.post(`/api/agents/${id}/merge`, { state: after.state });
  assert.equal(again.body.confirm, undefined, JSON.stringify(again.body));
  assert.equal(again.body.ok, false);

  // 4. At shutdown the folder holds nothing that is not merged, so it goes, with its branch.
  await stopEngine(w);
  assert.equal(existsSync(workspace), false, `the merged agent’s folder is tidied away\n${w.log()}`);
  assert.equal(gitOut(w.repo, 'branch', '--list', done.work.branch), '', 'and its branch');
});

test('throw away, live: the agent’s folder and branch go, a hidden copy stays, the person’s branch is untouched', async (t) => {
  const w = await setup(t, withIdentity(t));
  const { id, done, workspace } = await runToDone(w);
  const before = gitOut(w.repo, 'rev-parse', 'HEAD');
  const agentBranch = done.work.branch;
  assert.equal(gitOut(w.repo, 'branch', '--list', agentBranch).replace(/^[*+ ]+/, ''), agentBranch);

  const asked = await w.post(`/api/agents/${id}/discard`, { state: done.state });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.confirm?.kind, 'discard', JSON.stringify(asked.body));
  assert.equal(asked.body.confirm.danger, true);
  assert.equal(asked.body.confirm.yes, 'Throw it away');
  assert.equal(existsSync(workspace), true, 'nothing goes before the yes');

  const go = await w.post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  assert.equal(go.status, 200, JSON.stringify(go.body));
  assert.match(go.body.reply, /Its folder and branch are gone\./);
  assert.equal(existsSync(workspace), false, 'the folder is gone');
  assert.equal(gitOut(w.repo, 'branch', '--list', agentBranch), '', 'the branch is gone');
  assert.equal(gitOut(w.repo, 'rev-parse', 'HEAD'), before, 'the person’s branch is untouched');
  assert.equal(existsSync(path.join(w.repo, MARKER)), false);
  // The hidden copy keeps what the agent made.
  assert.match(gitOut(w.repo, 'ls-tree', '--name-only', `refs/workbench/discarded/${id}`), new RegExp(`^${MARKER.replace('.', '\\.')}$`, 'm'));

  const view = await until('the view to say it was thrown away', async () => (await w.agents()).find((a) => a.id === id && a.work?.thrownAway));
  assert.equal(view.work.folder, false);
  const follow = await w.post(`/api/agents/${id}/say`, { text: 'one more thing' });
  assert.equal(follow.body.ok, false, 'a thrown-away agent takes no more messages');
  await stopEngine(w);
});
