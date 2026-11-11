import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createRunner, createClaudeRunner, available, harness, createLineSplitter, STOP_GRACE_MS, STDERR_TAIL_CHARS,
} from '../src/adapters/claude/runner.mjs';
import {
  buildClaudeLaunch, userMessage, shellQuote, hookCommand, hookSettings, scrubEnv,
  WORKBENCH_PROMPT, DISALLOWED_TOOLS, BRIDGE_PATH, DEFAULT_BUDGET_USD,
} from '../src/adapters/claude/args.mjs';
import { EV } from '../src/shared/events.mjs';

const FAKE = fileURLToPath(new URL('./helpers/claude-fake.mjs', import.meta.url));
const WORKBENCH = fileURLToPath(new URL('..', import.meta.url)); // the agent's folder in these tests
const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', token: 'tok-123' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

before(() => chmodSync(FAKE, 0o755));

// Every runner a test makes is stopped afterwards, even when the test fails, so no fake is left running.
const runners = new Set();
afterEach(async () => {
  for (const r of runners) await r.stop().catch(() => {});
  runners.clear();
});

/** Environment for the fake, with variables a launched agent must not see (the runner must remove them). */
function fakeEnv(extra = {}) {
  return { ...process.env, WORKBENCH_CLAUDE_BIN: FAKE, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '9', ...extra };
}

/** Collects events and waits for conditions on them. */
function collector() {
  const events = [];
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      const hit = w.cond(events);
      if (hit) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(hit); }
    }
  };
  return {
    events,
    emit(e) { events.push(e); check(); },
    until(cond, what = 'a condition', ms = 15000) {
      const hit = cond(events);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { cond, resolve };
        w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${what}`)); }, ms);
        waiters.push(w);
      });
    },
    turnEnds() { return events.filter((e) => e.kind === EV.TURN && e.phase === 'end'); },
  };
}

const replyIs = (re) => (evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end' && re.test(e.finalText));

function makeRunner(c, { env = {}, task = 'Say hello', ...opts } = {}) {
  const r = createRunner({
    agentId: 'abc123', name: 'Test agent', task, cwd: WORKBENCH, budgetUsd: 1,
    emit: c.emit, hook: HOOK, log: () => {}, env: fakeEnv(env), killGraceMs: 500, ...opts,
  });
  runners.add(r);
  return r;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function waitDead(pid, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !processAlive(pid);
}

// ---------- args.mjs ----------

test('buildClaudeLaunch builds the verified command line', () => {
  const sid = '0bdffedf-c0cd-41ae-8bb3-6183f7e1be41';
  const l = buildClaudeLaunch({
    name: 'Fix login', model: 'claude-haiku-4-5', budgetUsd: 2, sessionId: sid, hook: HOOK, agentId: 'abc123',
    bridgePath: '/opt/work bench/hook-bridge.mjs', nodePath: '/usr/local/bin/node', env: { PATH: '/bin', WORKBENCH_CLAUDE_BIN: '/x/fake' },
  });
  assert.equal(l.bin, '/x/fake');
  const settings = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: "'/usr/local/bin/node' '/opt/work bench/hook-bridge.mjs'", timeout: 1800 }] }] },
  });
  assert.deepEqual(l.args, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--forward-subagent-text',
    '--setting-sources', 'project,local', '--strict-mcp-config',
    '--disallowedTools', 'Workflow CronCreate CronDelete ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger',
    '--settings', settings,
    '--append-system-prompt', WORKBENCH_PROMPT,
    '--max-budget-usd', '2', '--session-id', sid, '--name', 'Fix login', '--model', 'claude-haiku-4-5',
  ]);
  assert.equal(l.sessionId, sid);
  assert.equal(l.resume, false);
  assert.equal(WORKBENCH_PROMPT, 'You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did.');
  assert.equal(DISALLOWED_TOOLS.split(' ').length, 9);
});

test('buildClaudeLaunch: resume, defaults and refusals', () => {
  const r = buildClaudeLaunch({ name: '--force push', resumeSessionId: 'sess-9', hook: HOOK, agentId: 'abc123', env: {} });
  assert.equal(r.bin, 'claude');
  assert.ok(r.args.includes('--resume'));
  assert.equal(r.args[r.args.indexOf('--resume') + 1], 'sess-9');
  assert.ok(!r.args.includes('--session-id'), 'no --session-id on resume');
  assert.ok(!r.args.includes('--model'), 'no --model unless given');
  assert.equal(r.args[r.args.indexOf('--max-budget-usd') + 1], String(DEFAULT_BUDGET_USD));
  assert.equal(r.args[r.args.indexOf('--name') + 1], 'force push', 'a name cannot pass for a flag');
  assert.equal(r.resume, true);
  const fresh = buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, budgetUsd: 0.25 });
  assert.match(fresh.sessionId, UUID_RE);
  assert.equal(fresh.args[fresh.args.indexOf('--max-budget-usd') + 1], '0.25');
  assert.throws(() => buildClaudeLaunch({ name: 'A', agentId: 'abc123', env: {} }), /permission check is not set up/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: { url: HOOK.url }, agentId: 'abc123', env: {} }), /permission check/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, budgetUsd: -1 }), /positive number/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, model: '--dangerously-skip-permissions' }), /model name/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, agentId: 'abc123', env: {}, sessionId: 'not-a-uuid' }), /session id/);
  assert.throws(() => buildClaudeLaunch({ name: 'A', hook: HOOK, env: {} }), /agent id/);
});

test('the environment is scrubbed and carries the hook details', () => {
  const l = buildClaudeLaunch({
    name: 'A', hook: HOOK, agentId: 'abc123',
    env: { PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_PID: '5', CLAUDE_EFFORT: 'high', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' },
  });
  assert.deepEqual(l.env, {
    PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k',
    WORKBENCH_HOOK_URL: HOOK.url, WORKBENCH_HOOK_TOKEN: HOOK.token, WORKBENCH_AGENT_ID: 'abc123',
  });
  assert.deepEqual(scrubEnv({ CLAUDECODE: '1', A: 'b', U: undefined }), { A: 'b' });
});

test('the hook command quotes its paths for the shell', () => {
  assert.equal(shellQuote("/tmp/it's here"), `'/tmp/it'\\''s here'`);
  assert.equal(hookCommand({ nodePath: '/n o/node', bridgePath: "/b/x'y.mjs" }), `'/n o/node' '/b/x'\\''y.mjs'`);
  assert.equal(hookCommand(), `${shellQuote(process.execPath)} ${shellQuote(BRIDGE_PATH)}`);
  assert.match(BRIDGE_PATH, /src\/adapters\/claude\/hook-bridge\.mjs$/);
  const s = hookSettings();
  assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 1800);
  assert.equal(s.hooks.PreToolUse[0].matcher, '*');
});

test('userMessage is one stream-json line', () => {
  const line = userMessage('Fix the "login" bug\nplease');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'a single line');
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the "login" bug\nplease' }] } });
});

// ---------- line splitting ----------

test('the line splitter handles partial lines, CRLF, split characters and long lines', () => {
  const lines = [];
  const sp = createLineSplitter((l) => lines.push(l));
  const text = '{"a":1}\r\n{"b":"é✓—"}\n\n   \n' + '{"long":"' + 'y'.repeat(300000) + '"}\n{"tail":true}';
  const bytes = Buffer.from(text, 'utf8');
  // Feed it in awkward pieces, so multi-byte characters are cut apart.
  for (let i = 0, k = 1; i < bytes.length; k = (k * 7) % 13 + 1) { sp.push(bytes.subarray(i, i + k * 97)); i += k * 97; }
  assert.equal(lines.length, 3, 'the last line waits for its newline');
  sp.end();
  assert.deepEqual(lines.map((l) => JSON.parse(l)).map((o) => Object.keys(o)[0]), ['a', 'b', 'long', 'tail']);
  assert.equal(JSON.parse(lines[1]).b, 'é✓—');
  assert.equal(JSON.parse(lines[2]).long.length, 300000);

  const kept = [];
  const tooLong = [];
  const small = createLineSplitter((l) => kept.push(l), { maxLineChars: 10, onTooLong: (n) => tooLong.push(n) });
  small.push('short\n0123456789abcdef');
  small.push('ghij\nok\n');
  assert.deepEqual(kept, ['short', 'ok']);
  assert.deepEqual(tooLong, [20]);
});

// ---------- available() ----------

test('available reports the version, a missing binary, and a binary that hangs', async () => {
  assert.equal(harness, 'claude');
  assert.equal(createClaudeRunner, createRunner);
  assert.equal(STOP_GRACE_MS, 3000);
  assert.deepEqual(await available({ env: fakeEnv() }), { ok: true, version: '2.1.221' });
  const missing = await available({ env: { ...process.env, WORKBENCH_CLAUDE_BIN: '/nonexistent/claude-binary' } });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not installed/);
  const hung = await available({ env: fakeEnv({ FAKE_CLAUDE_VERSION: 'hang' }), timeoutMs: 300 });
  assert.equal(hung.ok, false);
  assert.match(hung.reason, /did not answer/);
});

// ---------- the runner, with the fake binary ----------

test('start launches Claude Code, sends the task and turns its output into events', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl' } });
  assert.deepEqual(r.info(), { pid: null, sessionId: null, alive: false });
  await r.start();
  const info = r.info();
  assert.equal(info.alive, true);
  assert.equal(typeof info.pid, 'number');
  assert.match(info.sessionId, UUID_RE);
  await c.until((evs) => evs.filter((e) => e.kind === EV.TURN && e.phase === 'end').length === 3, 'three turn ends');
  const created = c.events.filter((e) => e.kind === EV.CREATED);
  assert.deepEqual(created.map((e) => [e.agentId, e.parentId, e.name]), [['abc123-a71ea18c', 'abc123', 'List repository files']]);
  assert.deepEqual(c.turnEnds().map((e) => e.backgroundTasks), [1, 1, 0]);
  const costs = c.events.filter((e) => e.kind === EV.USAGE && 'costUsd' in e).map((e) => e.costUsd);
  assert.equal(costs.at(-1), 0.0797947);
  assert.equal(c.events.find((e) => e.kind === EV.SESSION).sessionId, info.sessionId, 'the fake reports our session id');
  assert.ok(c.events.every((e) => typeof e.ts === 'number'));
  await assert.rejects(r.start(), /already started/);
  await r.stop();
  assert.equal(r.info().alive, false);
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.agentId === 'abc123'), 'a stop is reported by the engine, not the runner');
});

test('send writes the next message to the running process', async () => {
  const c = collector();
  const r = makeRunner(c);
  await assert.rejects(r.send('too early'), /not been started/);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the reply to the task');
  const pid = r.info().pid;
  await r.send('Also update the docs');
  await c.until(replyIs(/^You said: Also update the docs$/), 'the reply to the second message');
  assert.equal(r.info().pid, pid, 'same process');
  assert.equal(c.events.filter((e) => e.kind === EV.TURN && e.phase === 'start').length, 2);
  await r.stop();
});

test('stop ends the whole process group', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'spawn a child' });
  await r.start();
  const hit = await c.until(replyIs(/^child \d+$/), 'the grandchild pid');
  const grandchild = Number(/\d+/.exec(hit.finalText)[0]);
  const pid = r.info().pid;
  assert.ok(processAlive(grandchild));
  await r.stop();
  assert.equal(r.info().alive, false);
  assert.ok(await waitDead(pid), 'the claude process is gone');
  assert.ok(await waitDead(grandchild), 'its grandchild is gone too');
  assert.ok(!c.events.some((e) => e.kind === EV.ENDED && e.agentId === 'abc123'));
});

test('stop forces the group with SIGKILL when SIGTERM is ignored', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'spawn a child', env: { FAKE_CLAUDE_STUBBORN: '1' }, killGraceMs: 400 });
  await r.start();
  const hit = await c.until(replyIs(/^child \d+$/), 'the grandchild pid');
  const grandchild = Number(/\d+/.exec(hit.finalText)[0]);
  const pid = r.info().pid;
  const t0 = Date.now();
  await r.stop();
  assert.ok(Date.now() - t0 >= 350, 'it waited for the grace period first');
  assert.ok(await waitDead(pid), 'the claude process is gone');
  assert.ok(await waitDead(grandchild), 'its stubborn grandchild is gone too');
});

test('send relaunches with --resume when the process has gone', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.send('And the docs');
  await c.until(replyIs(/^You said: And the docs$/), 'the second reply');
  const { pid, sessionId } = r.info();
  await r.send('exit 0');
  await c.until((evs) => evs.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123'), 'the clean exit');
  assert.equal(c.events.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123').outcome, 'ok');
  assert.equal(r.info().alive, false);
  assert.equal(r.info().sessionId, sessionId, 'the session is remembered after exit');

  await r.send('Carry on');
  const hit = await c.until(replyIs(/^You said \(resumed /), 'the reply from the resumed session');
  // Same session, no --session-id (the fake refuses both together), and only what is left of the limit.
  assert.equal(hit.finalText, `You said (resumed ${sessionId} with budget 0.98): Carry on`);
  assert.notEqual(r.info().pid, pid);
  assert.equal(r.info().alive, true);
  // The resumed fake counts spend from zero again; the total keeps growing anyway.
  const costs = c.events.filter((e) => e.kind === EV.USAGE && 'costUsd' in e).map((e) => Math.round(e.costUsd * 100) / 100);
  assert.deepEqual(costs, [0.01, 0.02, 0.03]);
  await r.stop();
});

test('a stopped agent can be resumed by sending it a message', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  const { sessionId } = r.info();
  await r.stop();
  assert.equal(r.info().alive, false);
  await r.send('Please continue');
  await c.until(replyIs(/^You said \(resumed /), 'the resumed reply');
  assert.equal(r.info().sessionId, sessionId);
  await r.stop();
  assert.ok(!c.events.some((e) => e.kind === EV.STATE && e.agentId === 'abc123' && e.state === 'failed'));
});

test('a crash reports the stderr tail and fails the agent', async () => {
  const c = collector();
  const r = makeRunner(c);
  await r.start();
  await c.until(replyIs(/^You said: Say hello$/), 'the first reply');
  await r.send('exit 3');
  const failed = await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.state === 'failed'), 'the failed state');
  const ended = c.events.find((e) => e.kind === EV.ENDED && e.agentId === 'abc123');
  assert.equal(ended.outcome, 'error');
  assert.match(ended.error, /fake claude: asked to exit with 3/);
  assert.ok(ended.error.length <= STDERR_TAIL_CHARS);
  assert.ok(c.events.indexOf(ended) < c.events.indexOf(failed), 'ended, then failed');
  assert.equal(failed.reason, 'Claude Code stopped with an error (exit code 3).');
  assert.equal(r.info().alive, false);
});

test('helpers still running when the process dies are ended', async () => {
  const c = collector();
  // Replay the run only up to the first result: the helper is still working in the background.
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-subagent-run.jsonl', FAKE_CLAUDE_FIXTURE_LINES: '259' } });
  await r.start();
  const end = await c.until((evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end'), 'the first turn end');
  assert.equal(end.backgroundTasks, 1);
  await r.send('exit 1');
  await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.agentId === 'abc123' && e.state === 'failed'), 'the failure');
  const helperStates = c.events.filter((e) => e.kind === EV.STATE && e.agentId === 'abc123-a71ea18c');
  assert.deepEqual(helperStates.map((e) => e.state), ['working', 'failed']);
  assert.equal(helperStates[1].reason, 'Claude Code stopped unexpectedly.');
  assert.equal(c.events.filter((e) => e.kind === EV.ENDED && e.agentId === 'abc123-a71ea18c').length, 1);
});

test('a missing binary fails the start in plain language', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { WORKBENCH_CLAUDE_BIN: '/nonexistent/claude-binary' } });
  await assert.rejects(r.start(), /the claude command was not found/);
  const failed = await c.until((evs) => evs.find((e) => e.kind === EV.STATE && e.state === 'failed'), 'the failed state');
  assert.match(failed.reason, /could not be started/);
  assert.equal(r.info().alive, false);
  const r2 = makeRunner(c, { cwd: `${WORKBENCH}/no-such-folder-for-claude-tests` });
  await assert.rejects(r2.start(), /folder does not exist/);
});

test('very long lines written in small pieces arrive whole', async () => {
  const c = collector();
  const r = makeRunner(c, { task: 'long 2000000', env: { FAKE_CLAUDE_CHUNKY: '1' } });
  await r.start();
  const hit = await c.until(replyIs(/✓$/), 'the long reply', 30000);
  assert.equal(hit.finalText.length, 2000000);
  assert.ok(/^x+✓$/.test(hit.finalText));
  await r.send('short one');
  await c.until(replyIs(/^You said: short one$/), 'the next reply');
  await r.stop();
});

test('the fixture replays the same through the runner in small pieces', async () => {
  const c = collector();
  const r = makeRunner(c, { env: { FAKE_CLAUDE_FIXTURE: 'claude-denied-bash.jsonl', FAKE_CLAUDE_CHUNKY: '1' } });
  await r.start();
  const end = await c.until((evs) => evs.find((e) => e.kind === EV.TURN && e.phase === 'end'), 'the turn end');
  assert.match(end.finalText, /Would you like me to proceed/);
  const denied = c.events.find((e) => e.kind === EV.ACTIVITY && e.phase === 'end');
  assert.equal(denied.ok, false);
  await r.stop();
});
