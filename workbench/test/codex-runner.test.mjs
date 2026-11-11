import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, available, createRunner, buildEnv, startArgs, resumeArgs } from '../src/adapters/codex/runner.mjs';
import { EV } from '../src/shared/events.mjs';

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
  assert.deepEqual(startArgs({ cwd: '/w', task: '-v fix it', model: 'm' }), ['exec', '--json', '-C', '/w', '--sandbox', 'workspace-write', '-m', 'm', '--', '-v fix it']);
  assert.deepEqual(resumeArgs({ threadId: 'T', text: 'hi' }), ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '--', 'T', 'hi']);

  const env = buildEnv({
    PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '1',
    CODEX_THREAD_ID: 'parent', CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_EXEC_SERVER_URL: 'http://x',
    CODEX_NETWORK_PROXY_ACTIVE: '1', CODEX_SHELL_SNAPSHOT_STATE_1: 'x', WORKBENCH_HOOK_URL: 'http://127.0.0.1:1/hook/pretool', WORKBENCH_HOOK_TOKEN: 'secret',
    CODEX_HOME: '/h/.codex', CODEX_API_KEY: 'k', OPENAI_API_KEY: 'k2', WORKBENCH_AGENT_ID: 'old',
  }, 'a1b2c3');
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CODEX_HOME: '/h/.codex', CODEX_API_KEY: 'k', OPENAI_API_KEY: 'k2', WORKBENCH_AGENT_ID: 'a1b2c3' });
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

test('start() runs codex exec in the workspace with the checked flags, stdin ignored and a clean environment', async t => {
  const codexHome = path.join(os.tmpdir(), 'wb-fake-codex-home');
  const s = setup(t, {
    FAKE_CODEX_DELAY_MS: '15', CODEX_HOME: codexHome,
    CLAUDECODE: '1', CODEX_THREAD_ID: 'parent-thread', CODEX_SANDBOX: 'seatbelt', WORKBENCH_HOOK_URL: 'http://127.0.0.1:9/hook/pretool', WORKBENCH_HOOK_TOKEN: 'secret',
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
  assert.deepEqual(call.argv, ['exec', '--json', '-C', s.ws, '--sandbox', 'workspace-write', '-m', 'gpt-test', '--', 'Explain this repo']);
  assert.equal(realpath(call.cwd), realpath(s.ws));
  assert.equal(call.stdin, 'ignored');
  assert.deepEqual(
    [call.env.CLAUDECODE, call.env.CODEX_THREAD_ID, call.env.CODEX_SANDBOX, call.env.WORKBENCH_HOOK_URL, call.env.WORKBENCH_HOOK_TOKEN],
    [false, false, false, false, false],
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
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '-m', 'gpt-test', '--', RUN_THREAD, '-v is wrong, use --verbose']);
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
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '--', RUN_THREAD, 'also check the README\n\nand keep it short']);
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
  assert.deepEqual(resume.argv, ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '--', RUN_THREAD, 'also keep the old API']);
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
  assert.deepEqual(again.argv, ['exec', '--json', '-C', s.ws, '--sandbox', 'workspace-write', '--', 'Fix the bug\n\ntry again']);
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
