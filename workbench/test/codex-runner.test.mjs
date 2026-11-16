import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, available, createRunner, buildEnv, startArgs, resumeArgs, sandboxArgs, gitFolders, tomlString, findCodex } from '../src/adapters/codex/runner.mjs';
import { EV } from '../src/shared/events.mjs';

// Codex's own sandbox, as every turn widens it: the network on (the git folders follow, when there are any).
const NET = ['-c', 'sandbox_workspace_write.network_access=true'];

// Every Codex process in this file is the fake. The runner reads this variable each time it spawns.
const FAKE = fileURLToPath(new URL('./helpers/codex-fake.mjs', import.meta.url));
process.env.WORKBENCH_CODEX_BIN = FAKE;

const FAKE_VARS = ['FAKE_CODEX_LOG', 'FAKE_CODEX_MODE', 'FAKE_CODEX_DELAY_MS', 'FAKE_CODEX_LOGIN', 'FAKE_CODEX_VERSION'];
const RUN_THREAD = '01a1c80d-4a72-7201-8a09-2038b4caad2a';

/** A workspace, a call log for the fake, environment overrides undone after the test, and an event sink. */
function setup(t, env = {}) {
  assert.equal(process.env.WORKBENCH_CODEX_BIN, FAKE, 'tests must never reach the real codex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codex-'));
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(ws);
  const logFile = path.join(dir, 'calls.jsonl');
  const vars = { ...Object.fromEntries(FAKE_VARS.map(k => [k, undefined])), FAKE_CODEX_LOG: logFile, ...env };
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const events = [];
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { dir, ws, events, calls, emit: e => events.push(e) };
}

async function waitFor(check, ms = 5000, what = 'a condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const turnEnds = events => events.filter(e => e.kind === EV.TURN && e.phase === 'end');
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const realpath = p => fs.realpathSync(p);

test('argument builders and the scrubbed environment', () => {
  assert.equal(harness, 'codex');
  assert.deepEqual(startArgs({ cwd: '/w', task: '-v fix it', model: 'm' }), ['exec', '--json', '-C', '/w', '--sandbox', 'workspace-write', ...NET, '-m', 'm', '--', '-v fix it']);
  assert.deepEqual(resumeArgs({ threadId: 'T', text: 'hi' }), ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...NET, '--', 'T', 'hi']);

  const NODE_DIR = path.dirname(process.execPath);
  const env = buildEnv({
    PATH: NODE_DIR, HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '1',
    CODEX_THREAD_ID: 'parent', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_EXEC_SERVER_URL: 'http://x',
    CODEX_NETWORK_PROXY_ACTIVE: '1', CODEX_SHELL_SNAPSHOT_STATE_1: 'x', WORKBENCH_HOOK_URL: 'http://127.0.0.1:1/hook/pretool', WORKBENCH_HOOK_TOKEN: 'secret',
    CODEX_HOME: '/h/.codex', CODEX_API_KEY: 'k', OPENAI_API_KEY: 'k2', WORKBENCH_AGENT_ID: 'old',
    // The editor Workbench was started from, and Workbench's own choice of programs.
    VSCODE_IPC_HOOK: '/tmp/code.sock', VSCODE_PID: '1', ELECTRON_RUN_AS_NODE: '1', GIT_EDITOR: 'true',
    WORKBENCH_CLAUDE_BIN: '/x/claude', WORKBENCH_CODEX_BIN: '/x/codex',
  }, 'a1b2c3');
  assert.deepEqual(env, { PATH: NODE_DIR, HOME: '/h', CODEX_HOME: '/h/.codex', CODEX_API_KEY: 'k', OPENAI_API_KEY: 'k2', WORKBENCH_AGENT_ID: 'a1b2c3' });
  // No node on the PATH: the folder of the node running Workbench goes first, so the agent's `npm test` works.
  assert.equal(buildEnv({ PATH: '/no/such/folder' }, 'a1b2c3').PATH, `${NODE_DIR}:/no/such/folder`);
  assert.equal(buildEnv({}, 'a1b2c3').PATH, `${NODE_DIR}:/usr/bin:/bin`);
  assert.equal(buildEnv({ PATH: `/no/such/folder:${NODE_DIR}` }, 'a1b2c3').PATH, `/no/such/folder:${NODE_DIR}`);
});

test('available() reports the version and whether Codex is signed in, never what it printed', async t => {
  setup(t);
  assert.deepEqual(await available(), { ok: true, version: '0.166.0', loggedIn: true });

  process.env.FAKE_CODEX_LOGIN = 'apikey';
  const key = await available();
  assert.equal(key.loggedIn, true);
  assert.ok(!JSON.stringify(key).includes('sk-'), 'no part of the key is passed on');

  process.env.FAKE_CODEX_LOGIN = 'out';
  const out = await available();
  assert.equal(out.ok, true, 'the binary runs; other sign-in methods can still work');
  assert.equal(out.loggedIn, false);
  assert.match(out.reason, /not signed in/);
});

test('available() gives a plain reason when Codex does not answer or is missing', async t => {
  const s = setup(t, { FAKE_CODEX_VERSION: 'hang' });
  const t0 = Date.now();
  const slow = await available({ timeoutMs: 300 });
  assert.equal(slow.ok, false);
  assert.equal(slow.reason, 'Codex did not answer when asked for its version.');
  assert.ok(Date.now() - t0 < 3000);

  process.env.WORKBENCH_CODEX_BIN = path.join(s.dir, 'no-such-codex');
  t.after(() => { process.env.WORKBENCH_CODEX_BIN = FAKE; });
  assert.deepEqual(await available(), { ok: false, loggedIn: null, reason: 'Codex is not installed, or the codex command could not be found.' });
});

test('a relative path in WORKBENCH_CODEX_BIN is never read from the agent’s folder, where Codex starts: it is refused in plain words', async t => {
  const s = setup(t);
  // What an agent could write in its own folder at that path, to run outside Codex's sandbox: it must never run.
  const ran = path.join(s.dir, 'impostor-ran');
  fs.mkdirSync(path.join(s.ws, 'tools'));
  fs.writeFileSync(path.join(s.ws, 'tools', 'codex.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ran)}, process.cwd());\n`);
  process.env.WORKBENCH_CODEX_BIN = 'tools/codex.mjs';
  t.after(() => { process.env.WORKBENCH_CODEX_BIN = FAKE; });
  const unknown = v => `Workbench cannot tell where ${v} is: the path in WORKBENCH_CODEX_BIN must start with / or ~.`;
  assert.deepEqual(findCodex(), { path: null, reason: unknown('tools/codex.mjs') });
  assert.deepEqual(await available(), { ok: false, loggedIn: null, reason: unknown('tools/codex.mjs') });
  const runner = createRunner({ agentId: 'a1b2c3', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.STATE && e.state === 'failed'), 5000, 'the refusal');
  assert.equal(s.events.find(e => e.kind === EV.STATE && e.state === 'failed').reason, unknown('tools/codex.mjs'));
  assert.equal(fs.existsSync(ran), false, 'the file in its folder never ran');
  assert.deepEqual(s.calls(), [], 'nothing was started');
  // A bare name is looked up on the PATH; an absolute path is taken as it is, and ~/ is the home folder.
  assert.deepEqual(findCodex({}), { path: 'codex' });
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: '' }), { path: 'codex' });
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: 'codex-beta' }), { path: 'codex-beta' });
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: '/opt/codex/bin/codex' }), { path: '/opt/codex/bin/codex' });
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: '~/bin/codex', HOME: '/home/someone' }), { path: '/home/someone/bin/codex' });
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: '~/bin/codex' }), { path: null, reason: unknown('~/bin/codex') }, 'no home folder to read it from');
  assert.deepEqual(findCodex({ WORKBENCH_CODEX_BIN: './codex' }), { path: null, reason: unknown('./codex') });
});

test('start() runs codex exec in the workspace with the checked flags, stdin ignored and a clean environment', async t => {
  const codexHome = path.join(os.tmpdir(), 'wb-fake-codex-home');
  const s = setup(t, {
    FAKE_CODEX_DELAY_MS: '15', CODEX_HOME: codexHome,
    CLAUDECODE: '1', CODEX_THREAD_ID: 'parent-thread', CODEX_SANDBOX: 'seatbelt', WORKBENCH_HOOK_URL: 'http://127.0.0.1:9/hook/pretool', WORKBENCH_HOOK_TOKEN: 'secret',
    WORKBENCH_CLAUDE_BIN: '/x/claude', VSCODE_IPC_HOOK: '/tmp/code.sock', ELECTRON_RUN_AS_NODE: '1', GIT_EDITOR: 'true',
  });
  const runner = createRunner({ agentId: 'a1b2c3', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, model: 'gpt-test', emit: s.emit, hook: { url: 'http://127.0.0.1:9/hook/pretool', token: 'secret' } });
  assert.deepEqual(runner.info(), { pid: null, sessionId: null, alive: false });

  await runner.start();
  const running = runner.info();
  assert.equal(running.alive, true);
  assert.equal(typeof running.pid, 'number');
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the first turn');

  const [call, extra] = s.calls();
  assert.equal(extra, undefined, 'one process for one turn');
  assert.equal(call.pid, running.pid);
  assert.deepEqual(call.argv, ['exec', '--json', '-C', s.ws, '--sandbox', 'workspace-write', ...NET, '-m', 'gpt-test', '--', 'Explain this repo']);
  assert.equal(realpath(call.cwd), realpath(s.ws));
  assert.equal(call.stdin, 'ignored');
  assert.deepEqual(
    [call.env.CLAUDECODE, call.env.CODEX_THREAD_ID, call.env.CODEX_SANDBOX, call.env.WORKBENCH_HOOK_URL, call.env.WORKBENCH_HOOK_TOKEN],
    [false, false, false, false, false],
  );
  assert.deepEqual(
    [call.env.WORKBENCH_CLAUDE_BIN, call.env.WORKBENCH_CODEX_BIN, call.env.VSCODE_IPC_HOOK, call.env.ELECTRON_RUN_AS_NODE, call.env.GIT_EDITOR],
    [false, false, false, false, false],
    'no handle on the editor, and no program choices for a Workbench the agent might start',
  );
  assert.equal(call.codexHome, codexHome, 'CODEX_HOME survives, so sign-in and resume keep working');
  assert.equal(call.agentId, 'a1b2c3');

  const kinds = s.events.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 3), [EV.MODEL, EV.SESSION, EV.TURN]);
  assert.equal(s.events[1].sessionId, RUN_THREAD);
  assert.equal(s.events.filter(e => e.kind === EV.ACTIVITY).length, 6);
  assert.ok(s.events.every(e => e.agentId === 'a1b2c3' && typeof e.ts === 'number'));
  const usage = s.events.find(e => e.kind === EV.USAGE);
  assert.equal(usage.mode, 'add');
  assert.equal(usage.costUsd, null);
  const [end] = turnEnds(s.events);
  assert.equal(end.isError, false);
  assert.match(end.finalText, /^The repository contains/);
  assert.ok(!kinds.includes(EV.ENDED) && !kinds.includes(EV.STATE), 'a finished turn does not end the agent');
  assert.deepEqual(runner.info(), { pid: null, sessionId: RUN_THREAD, alive: false });
});

test('send() resumes the thread in the workspace, with the sandbox set by -c and the text after --', async t => {
  const s = setup(t);
  const runner = createRunner({ agentId: 'r1', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, model: 'gpt-test', emit: s.emit });
  await runner.start();
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the first turn');
  const before = s.events.length;

  await runner.send('-v is wrong, use --verbose'); // starts with a dash, as typed hints can
  await waitFor(() => turnEnds(s.events).length === 2 && !runner.info().alive, 5000, 'the follow-up turn');

  const [, resume] = s.calls();
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...NET, '-m', 'gpt-test', '--', RUN_THREAD, '-v is wrong, use --verbose']);
  assert.equal(realpath(resume.cwd), realpath(s.ws), 'resume has no -C, so the process runs in the workspace');
  assert.equal(resume.stdin, 'ignored');

  const later = s.events.slice(before);
  assert.deepEqual(later.map(e => e.kind), [EV.SESSION, EV.TURN, EV.SAYS, EV.USAGE, EV.TURN]);
  assert.equal(later[1].phase, 'start');
  assert.equal(later.at(-1).finalText, 'banana');
  assert.equal(runner.info().sessionId, RUN_THREAD);
});

test('a message sent during a turn waits for it to end, then goes out as one follow-up', async t => {
  const s = setup(t, { FAKE_CODEX_DELAY_MS: '30' });
  const runner = createRunner({ agentId: 'q1', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.ACTIVITY), 5000, 'the first step');

  await runner.send('also check the README');
  await runner.send('and keep it short');
  assert.equal(runner.info().alive, true);
  assert.equal(s.calls().length, 1, 'no second process while the first one runs');
  const notices = s.events.filter(e => e.kind === EV.NOTICE);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].text, 'Explain repo will get your message when it finishes what it is doing now.');

  await waitFor(() => turnEnds(s.events).length === 2 && !runner.info().alive, 8000, 'the queued follow-up');
  const [, resume] = s.calls();
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...NET, '--', RUN_THREAD, 'also check the README\n\nand keep it short']);
});

test('a failed turn ends as an error in plain words, and the exit marks the agent failed', async t => {
  const s = setup(t, { FAKE_CODEX_MODE: 'fail' });
  const runner = createRunner({ agentId: 'f1', name: 'Fix bug', task: 'Fix the bug', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.STATE) && !runner.info().alive, 5000, 'the failure');

  const plainReason = 'Codex is not signed in, or its sign-in has expired.';
  const ends = turnEnds(s.events);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].isError, true);
  assert.equal(ends[0].finalText, plainReason);
  const ended = s.events.find(e => e.kind === EV.ENDED);
  assert.equal(ended.outcome, 'error');
  assert.equal(ended.error, `${plainReason}\n\nERROR: unexpected status 401 Unauthorized`, 'plain reason first, stderr tail as detail');
  const state = s.events.find(e => e.kind === EV.STATE);
  assert.deepEqual([state.state, state.reason], ['failed', plainReason]);
  assert.ok(s.events.indexOf(ends[0]) < s.events.indexOf(ended));
  assert.equal(runner.info().sessionId, RUN_THREAD, 'the thread can still be resumed');
});

test('a message sent during a turn that fails still goes out: failed first, then the next turn starts', async t => {
  const s = setup(t, { FAKE_CODEX_MODE: 'fail-first', FAKE_CODEX_DELAY_MS: '150' });
  const runner = createRunner({ agentId: 'ff1', name: 'Fix bug', task: 'Fix the bug', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.TURN && e.phase === 'start'), 5000, 'the first turn');
  await runner.send('also keep the old API');
  await waitFor(() => turnEnds(s.events).length === 2 && !runner.info().alive, 8000, 'the queued turn');
  // The engine relies on this order: the root is marked failed, and only then does the waiting message start a turn.
  const order = s.events
    .filter(e => e.kind === EV.TURN || e.kind === EV.ENDED || e.kind === EV.STATE)
    .map(e => (e.kind === EV.TURN ? `turn.${e.phase}${e.isError ? '(error)' : ''}` : e.kind === EV.ENDED ? `ended.${e.outcome}` : e.state));
  assert.deepEqual(order, ['turn.start', 'turn.end(error)', 'ended.error', 'failed', 'turn.start', 'turn.end']);
  const [, resume] = s.calls();
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...NET, '--', RUN_THREAD, 'also keep the old API']);
});

test('if the first run never started a thread, send() starts over with the task and the message', async t => {
  const s = setup(t, { FAKE_CODEX_MODE: 'crash' });
  const runner = createRunner({ agentId: 'c1', name: 'Fix bug', task: 'Fix the bug', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.STATE) && !runner.info().alive, 5000, 'the crash');

  const reason = "Codex stopped with an error: thread 'main' panicked at src/main.rs:1:1";
  assert.equal(turnEnds(s.events).length, 0);
  const ended = s.events.find(e => e.kind === EV.ENDED);
  assert.equal(ended.outcome, 'error');
  assert.ok(ended.error.startsWith(reason + '\n\n') && ended.error.includes('boom'));
  assert.equal(s.events.find(e => e.kind === EV.STATE).reason, reason);
  assert.equal(runner.info().sessionId, null);

  process.env.FAKE_CODEX_MODE = 'replay';
  await runner.send('try again');
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the new start');
  const [, again] = s.calls();
  assert.deepEqual(again.argv, ['exec', '--json', '-C', s.ws, '--sandbox', 'workspace-write', ...NET, '--', 'Fix the bug\n\ntry again']);
});

test('a missing codex binary is a plain failure, and start() still resolves', async t => {
  const s = setup(t);
  process.env.WORKBENCH_CODEX_BIN = path.join(s.dir, 'no-such-codex');
  t.after(() => { process.env.WORKBENCH_CODEX_BIN = FAKE; });
  const runner = createRunner({ agentId: 'm1', name: 'Fix bug', task: 'Fix the bug', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.STATE), 5000, 'the failure');
  const state = s.events.find(e => e.kind === EV.STATE);
  assert.deepEqual([state.state, state.reason], ['failed', 'Codex is not installed, or the codex command could not be found.']);
  assert.equal(runner.info().alive, false);
});

test('stop() ends Codex and the commands it started; nothing afterwards ends the turn or says failed', async t => {
  const s = setup(t, { FAKE_CODEX_MODE: 'hang' });
  const runner = createRunner({ agentId: 's1', name: 'Run tests', task: 'Run the tests', cwd: s.ws, emit: s.emit });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.ACTIVITY), 5000, 'the running command');
  const [call] = s.calls();
  assert.equal(runner.info().pid, call.pid);
  assert.ok(isAlive(call.grandchild), 'the command Codex started is running');

  await runner.stop();
  assert.equal(runner.info().alive, false);
  await waitFor(() => !isAlive(call.pid) && !isAlive(call.grandchild), 3000, 'the process group to end');
  await new Promise(r => setTimeout(r, 100)); // room for any late output or exit handling

  assert.equal(turnEnds(s.events).length, 0, 'no turn end, so the engine’s "stopped" stands');
  assert.ok(!s.events.some(e => e.kind === EV.STATE), 'no failed state');
  const open = s.events.filter(e => e.kind === EV.ACTIVITY && e.phase === 'end');
  assert.deepEqual(open.map(e => e.ok), [null], 'the step in progress is closed as unknown');
  await runner.stop();
  assert.deepEqual(s.events.filter(e => e.kind === EV.ENDED).map(e => e.outcome), ['stopped'], 'reported once');
});

test('stop() falls back to SIGKILL when Codex ignores SIGTERM', async t => {
  const s = setup(t, { FAKE_CODEX_MODE: 'stubborn' });
  const runner = createRunner({ agentId: 's2', name: 'Run tests', task: 'Run the tests', cwd: s.ws, emit: s.emit, killGraceMs: 200 });
  await runner.start();
  await waitFor(() => s.events.some(e => e.kind === EV.ACTIVITY), 5000, 'the running command');
  const [call] = s.calls();

  const t0 = Date.now();
  await runner.stop();
  assert.ok(Date.now() - t0 >= 150, 'SIGTERM was given its grace period first');
  await waitFor(() => !isAlive(call.pid) && !isAlive(call.grandchild), 3000, 'the process group to end');
  assert.deepEqual(s.events.filter(e => e.kind === EV.ENDED).map(e => e.outcome), ['stopped']);
  assert.ok(!s.events.some(e => e.kind === EV.STATE));
});

test('the person’s keys reach Codex after the scrub and before WORKBENCH_AGENT_ID, which no key replaces', () => {
  const NODE_DIR = path.dirname(process.execPath);
  const env = buildEnv({ PATH: NODE_DIR, HOME: '/h', CLAUDECODE: '1' }, 'a1b2c3', {
    WB_TEST_KEY: 'from-the-key-store', WORKBENCH_AGENT_ID: 'another', WORKBENCH_HOOK_TOKEN: 'x', CODEX_THREAD_ID: 't',
    CLAUDECODE: '1', VSCODE_PID: '1', WORKBENCH_CODEX_BIN: '/x/codex', 'NOT A NAME': 'x', NUMBER: 7,
  });
  assert.deepEqual(env, { PATH: NODE_DIR, HOME: '/h', WB_TEST_KEY: 'from-the-key-store', WORKBENCH_AGENT_ID: 'a1b2c3' });
  assert.deepEqual(buildEnv({ PATH: NODE_DIR }, 'a1', null), { PATH: NODE_DIR, WORKBENCH_AGENT_ID: 'a1' });
});

test('every Codex turn gets the person’s keys, from the same base environment as the other agents (opts.env)', async t => {
  const s = setup(t, { CODEX_API_KEY: undefined, CODEX_HOME: undefined });
  const codexHome = path.join(s.dir, 'codex-home');
  const runner = createRunner({
    agentId: 'k1', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, emit: s.emit,
    env: { ...process.env, CODEX_HOME: codexHome },
    keysEnv: { CODEX_API_KEY: ['made', 'up', 'for', 'this', 'test'].join('-') },
  });
  await runner.start();
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the first turn');
  await runner.send('and the docs');
  await waitFor(() => turnEnds(s.events).length === 2 && !runner.info().alive, 5000, 'the follow-up turn');
  const calls = s.calls();
  assert.deepEqual(calls.map(c => c.env.CODEX_API_KEY), [true, true]);
  assert.deepEqual(calls.map(c => c.codexHome), [codexHome, codexHome]);
  assert.deepEqual(calls.map(c => c.agentId), ['k1', 'k1']);
});

test('a mask hides the person’s keys in Codex’s output before it is read, and in the stderr kept for errors', async t => {
  const s = setup(t);
  const mask = (text) => text.split('repository').join('[hidden]');
  const runner = createRunner({ agentId: 'm2', name: 'Explain repo', task: 'Explain this repo', cwd: s.ws, emit: s.emit, mask });
  await runner.start();
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the first turn');
  assert.match(turnEnds(s.events)[0].finalText, /^The \[hidden\] contains/);
  assert.ok(!JSON.stringify(s.events).includes('repository'), 'in no event');

  const f = setup(t, { FAKE_CODEX_MODE: 'fail' });
  const failing = createRunner({ agentId: 'm3', name: 'Fix bug', task: 'Fix the bug', cwd: f.ws, emit: f.emit, mask: (text) => text.split('Unauthorized').join('[hidden]') });
  await failing.start();
  await waitFor(() => f.events.some(e => e.kind === EV.STATE) && !failing.info().alive, 5000, 'the failure');
  const ended = f.events.find(e => e.kind === EV.ENDED);
  assert.equal(ended.error, 'Codex is not signed in, or its sign-in has expired.\n\nERROR: unexpected status 401 [hidden]');
});

// ---------------------------------------------------------------------------------------------
// git in Codex's sandbox: the network on, and the repository's git folders as writable roots, on every turn

/**
 * A strict reading of the TOML array of basic strings that sandboxArgs writes: no raw control characters, and only the
 * escapes \" \\ and \uXXXX, which mean the same in JSON. Codex reads a -c value as TOML, so anything else would not be
 * the folder it names.
 */
function tomlStrings(value) {
  const STRING = String.raw`"(?:[^"\\\u0000-\u001f\u007f]|\\["\\]|\\u[0-9A-F]{4})*"`;
  assert.match(value, new RegExp(`^\\[${STRING}(,${STRING})*\\]$`), 'a TOML array of basic strings');
  return JSON.parse(value);
}

/** A throwaway repository with one commit and a worktree, made by git with no global config and no machine identity. */
function gitRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-codex-git-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Workbench test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, env, stdio: 'pipe' });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'First commit');
  const ws = path.join(dir, 'worktrees', 'fix-login-a1b2c3');
  git(repo, 'worktree', 'add', '-q', '-b', 'workbench/fix-login-a1b2c3', ws, 'HEAD');
  return { dir, repo, ws, common: path.join(repo, '.git'), own: path.join(repo, '.git', 'worktrees', 'fix-login-a1b2c3') };
}

test('launch arguments: the sandbox network on, and the repository’s git folders as writable roots, first turn and resume', () => {
  const dirs = ['/repo/.git', '/repo/.git/worktrees/fix-login-a1b2c3'];
  const roots = 'sandbox_workspace_write.writable_roots=["/repo/.git","/repo/.git/worktrees/fix-login-a1b2c3"]';
  assert.deepEqual(sandboxArgs(dirs), ['-c', 'sandbox_workspace_write.network_access=true', '-c', roots]);
  assert.deepEqual(startArgs({ cwd: '/w', task: 'Fix the login', model: 'm', gitDirs: dirs }),
    ['exec', '--json', '-C', '/w', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', roots,
      '-m', 'm', '--', 'Fix the login']);
  assert.deepEqual(resumeArgs({ threadId: 'T', text: 'now push it', gitDirs: dirs }),
    ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true', '-c', roots,
      '--', 'T', 'now push it']);
  // Outside a git repository there is no folder to add, and the network is on all the same.
  assert.deepEqual(sandboxArgs([]), NET);
  assert.deepEqual(sandboxArgs(), NET);
});

test('a writable root is written as a TOML string that names the folder exactly, whatever it is called', () => {
  const odd = ['/Users/a b/"quoted"/back\\slash', '/tmp/tab\there', '/tmp/line\nbreak', '/tmp/del\u007f', '/tmp/naïve 📁', '/tmp/=,[]'];
  for (const p of odd) assert.deepEqual(tomlStrings(`[${tomlString(p)}]`), [p], JSON.stringify(p));
  assert.equal(tomlString('a"b\\c\td\u007f'), '"a\\"b\\\\c\\u0009d\\u007F"');
  const [, , , value] = sandboxArgs(odd);
  assert.deepEqual(tomlStrings(value.slice('sandbox_workspace_write.writable_roots='.length)), odd);
});

test('gitFolders reads where a worktree keeps its git data: the common dir, then its own git folder', t => {
  const { dir, repo, ws, common, own } = gitRepo(t);
  assert.deepEqual(gitFolders(ws), [common, own]);
  assert.deepEqual(gitFolders(repo), [common], 'a repository’s own folder: its .git folder');
  fs.symlinkSync(ws, path.join(dir, 'link'));
  assert.deepEqual(gitFolders(path.join(dir, 'link')), [common, own], 'by their real paths');
  // Not a repository, a folder inside one, nothing there, nothing given.
  fs.mkdirSync(path.join(dir, 'plain'));
  fs.mkdirSync(path.join(ws, 'src'));
  for (const p of [path.join(dir, 'plain'), path.join(ws, 'src'), path.join(dir, 'gone'), '', undefined, null]) {
    assert.deepEqual(gitFolders(p), [], String(p));
  }
});

test('a git layout that does not hold together adds no folder to the sandbox', t => {
  const { dir, ws, own } = gitRepo(t);
  // The worktree's commondir now names another folder, which does not hold its git folder under worktrees/.
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.writeFileSync(path.join(own, 'commondir'), path.join(dir, 'elsewhere') + '\n');
  assert.deepEqual(gitFolders(ws), []);
  // A .git file that names nothing there, is not one gitdir line, or a .git that is a link.
  const odd = path.join(dir, 'odd');
  fs.mkdirSync(odd);
  for (const text of ['gitdir: /no/such/folder\n', 'not a gitdir line\n', `gitdir: ${own}\nmore\n`, '']) {
    fs.writeFileSync(path.join(odd, '.git'), text);
    assert.deepEqual(gitFolders(odd), [], JSON.stringify(text));
  }
  fs.rmSync(path.join(odd, '.git'));
  fs.symlinkSync(own, path.join(odd, '.git'));
  assert.deepEqual(gitFolders(odd), []);
});

test('a Codex agent in a worktree gets the network and its git folders on the first turn and on every resume', async t => {
  const s = setup(t);
  const { ws, common, own } = gitRepo(t);
  const roots = `sandbox_workspace_write.writable_roots=["${common}","${own}"]`;
  const runner = createRunner({ agentId: 'g1', name: 'Fix login', task: 'Fix the login and push it', cwd: ws, emit: s.emit });
  await runner.start();
  await waitFor(() => turnEnds(s.events).length === 1 && !runner.info().alive, 5000, 'the first turn');
  await runner.send('now push it');
  await waitFor(() => turnEnds(s.events).length === 2 && !runner.info().alive, 5000, 'the follow-up turn');
  const [first, resume] = s.calls();
  assert.deepEqual(first.argv, ['exec', '--json', '-C', ws, '--sandbox', 'workspace-write', ...NET, '-c', roots, '--', 'Fix the login and push it']);
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', ...NET, '-c', roots, '--', RUN_THREAD, 'now push it']);
  assert.deepEqual(tomlStrings(roots.slice(roots.indexOf('=') + 1)), [common, own]);
});
