// History across restarts: the module (history.mjs), and the engine's use of it (keep, load, continue, forget).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.mjs';
import { Store } from '../src/core/store.mjs';
import { EV, newAgentView } from '../src/shared/events.mjs';
import * as historyMod from '../src/core/history.mjs';
import * as commands from '../src/core/commands.mjs';
import { FakeMachines, fakeAdapter, fakeDeps, until } from './helpers/engine-fakes.mjs';

const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', tokenFor: (id) => `tok-${id}` };
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
// The commit an agent starts from. A record keeps only real commit ids (40 or 64 hex characters).
const BASE = 'c0ffee'.repeat(6) + 'c0ff';

function tmp(t, label = 'wb-history-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A live engine over a temporary repository folder, with the real history module writing under `dir`. */
function world(t, dir, { adapters = null, options = {}, workspaceKept = true } = {}) {
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const store = new Store();
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const { deps, calls, git } = fakeDeps();
  git.head = BASE;
  git.dirty = 0;
  deps.history = historyMod;
  deps.commands = commands;
  deps.workspace.createWorkspace = async (o) => {
    calls.createWorkspace.push(o);
    const p = path.join(dir, 'wt', `${o.slug}-${o.agentId}`);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, '.git'), 'gitdir: elsewhere\n');
    return { path: p, branch: `workbench/${o.slug}-${o.agentId}`, base: BASE };
  };
  deps.workspace.removeWorkspace = async (o) => { calls.removeWorkspace.push(o); return { removed: !workspaceKept }; };
  deps.workspace.discardWork = async (o) => {
    calls.discardWork.push(o);
    fs.rmSync(o.path, { recursive: true, force: true });
    return { ok: true, saved: `refs/workbench/discarded/${o.agentId}` };
  };
  const engine = new Engine({
    store, mode: 'live', repo: { root: repoRoot, name: 'shop', head: BASE, branch: 'main', dirty: 0 }, hook: HOOK,
    defaultBudgetUsd: 2, adapters: adapters || { claude, codex }, machines: new FakeMachines(), deps,
    options: { tickMs: 10_000_000, permissionTimeoutMs: 5000, historyDir: path.join(dir, 'history'), historyDebounceMs: 15, exitGraceMs: 20, ...options },
  });
  t.after(() => engine.shutdown());
  return { store, engine, claude, codex, calls, deps, git, repoRoot, historyDir: path.join(dir, 'history') };
}

/** Run one agent to "says it is done", with a session id. */
async function finishOne(w, { task = 'Fix the login redirect', harness = 'claude', sessionId = SESSION } = {}) {
  await w.engine.start();
  const v = await w.engine.startAgent({ task, harness });
  const adapter = w[harness];
  const runner = adapter.runners.at(-1);
  runner.emit({ kind: EV.SESSION, sessionId });
  runner.emit({ kind: EV.MODEL, model: 'haiku' });
  runner.emit({ kind: EV.USAGE, mode: 'set', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.31 });
  runner.emit({ kind: EV.SAYS, text: 'I fixed the redirect.' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the redirect.', backgroundTasks: 0, isError: false });
  await until(() => w.store.get(v.id).state === 'done_claimed');
  return { id: v.id, runner };
}

const readFile = (w) => JSON.parse(fs.readFileSync(historyMod.historyFile(w.repoRoot, { dir: w.historyDir }), 'utf8'));

// ------------------------------------------------------------------ the module

test('the history file is named like the worktree folder: <name>-<hash of the real path>.json under ~/.workbench/history', (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'My Repo');
  fs.mkdirSync(repo);
  const file = historyMod.historyFile(repo, { dir: path.join(dir, 'h') });
  assert.match(path.basename(file), /^My-Repo-[0-9a-f]{8}\.json$/);
  const folder = path.basename(path.join(dir, 'x'));
  assert.ok(folder);
  const old = process.env.HOME;
  process.env.HOME = dir;
  try {
    assert.equal(historyMod.historyFile(repo), path.join(dir, '.workbench', 'history', path.basename(file)));
  } finally {
    if (old === undefined) delete process.env.HOME; else process.env.HOME = old;
  }
});

test('a record is built field by field: nothing outside the list gets in, and no secret can', () => {
  const view = {
    ...newAgentView({ agentId: 'abc123', name: 'Fix login', task: 'Fix it', harness: 'claude', workspace: '/w/x' }, 1000),
    state: 'done_claimed', turns: 2, sessionId: SESSION,
    // Things that must never reach the file:
    hookToken: 'SECRET-HOOK', token: 'SECRET-PAGE', env: { WORKBENCH_HOOK_TOKEN: 'SECRET-ENV' },
    checks: { state: 'failed', results: [{ name: 'tests', ok: false, ms: 5, tail: 'SECRET-IN-CHECK-OUTPUT' }] },
  };
  const rec = historyMod.recordOf(view, { path: '/w/x', branch: 'workbench/fix-abc123', base: BASE, since: BASE, from: 'main', token: 'SECRET-WS' }, 5000);
  const text = JSON.stringify(rec);
  assert.ok(!text.includes('SECRET'), text);
  // Pinned on purpose: `work` was added with source control. A new field must be added here, and to cleanRecord.
  assert.deepEqual(Object.keys(rec).sort(), ['approvals', 'budgetUsd', 'checks', 'endedAt', 'files', 'harness', 'id', 'machineId', 'model',
    'name', 'rules', 'savedAt', 'says', 'sessionId', 'startedAt', 'state', 'stateReason', 'task', 'toolCalls', 'turns', 'usage', 'work', 'workspace']);
  assert.deepEqual(rec.workspace, { path: '/w/x', branch: 'workbench/fix-abc123', base: BASE, since: BASE, from: 'main' });
  assert.equal(rec.work, null, 'a view without work keeps none');
  assert.deepEqual(rec.checks.results, [{ name: 'tests', ok: false, ms: 5 }]);
});

test('helpers, simulated agents and launches that never got going are not kept', () => {
  const root = newAgentView({ agentId: 'a1', name: 'A', task: 't', harness: 'claude' });
  assert.ok(historyMod.recordOf({ ...root, state: 'done_claimed', turns: 1 }));
  assert.equal(historyMod.recordOf({ ...root, parentId: 'x' }), null);
  assert.equal(historyMod.recordOf({ ...root, harness: 'sim' }), null);
  assert.equal(historyMod.recordOf({ ...root, state: 'failed', turns: 0, sessionId: null }), null);
  assert.ok(historyMod.recordOf({ ...root, state: 'failed', turns: 0, sessionId: SESSION }));
});

test('the history keeps the last 50 roots, newest by start time', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'h.json');
  const h = new historyMod.History({ file, debounceMs: 5 });
  const recs = [];
  for (let i = 0; i < 60; i++) {
    recs.push(historyMod.recordOf({ ...newAgentView({ agentId: `a${i}`, name: `A${i}`, task: 't', harness: 'claude', startedAt: 1000 + i }), state: 'done_claimed', turns: 1 }, null, 9));
  }
  h.source(() => recs);
  h.save();
  const back = new historyMod.History({ file }).load();
  assert.equal(back.length, 50);
  assert.equal(back[0].id, 'a10');
  assert.equal(back.at(-1).id, 'a59');
});

test('writes are atomic: a temp file in the same folder, renamed; no temp file is left; the file is private', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'sub', 'h.json');
  const renames = [];
  const real = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([a, b]); return real(a, b); };
  try {
    const h = new historyMod.History({ file });
    h.source(() => [historyMod.recordOf({ ...newAgentView({ agentId: 'a1', name: 'A', task: 't', harness: 'codex' }), state: 'done_claimed', turns: 1 })]);
    h.save();
  } finally {
    fs.renameSync = real;
  }
  assert.equal(renames.length, 1);
  assert.equal(renames[0][1], file);
  assert.equal(path.dirname(renames[0][0]), path.dirname(file));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['h.json']);
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'only the person can read it');
});

test('writes are debounced: a run of changes is one write', async (t) => {
  const dir = tmp(t);
  const h = new historyMod.History({ file: path.join(dir, 'h.json'), debounceMs: 30 });
  let reads = 0;
  h.source(() => { reads += 1; return []; });
  for (let i = 0; i < 20; i++) h.schedule();
  assert.equal(reads, 0);
  await until(() => reads > 0);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(reads, 1);
});

test('a record that was still going when the file was written comes back stopped; a damaged file is set aside', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'h.json');
  const rec = historyMod.recordOf({ ...newAgentView({ agentId: 'w1', name: 'W', task: 't', harness: 'claude' }, 1000), state: 'working', sessionId: SESSION, turns: 1 }, { path: '/w', branch: 'b', base: 'c' }, 4000);
  fs.writeFileSync(file, JSON.stringify({ version: 1, agents: [rec, { id: '../evil', harness: 'claude' }, 'junk'] }));
  const [back, ...rest] = new historyMod.History({ file }).load();
  assert.equal(rest.length, 0, 'bad entries are dropped');
  assert.equal(back.state, 'stopped');
  assert.match(back.stateReason, /closed while it was working/);
  assert.equal(back.endedAt, 4000);
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new historyMod.History({ file, log: { warn() {} } }).load(), []);
  assert.ok(fs.existsSync(`${file}.damaged`));
});

test('another Workbench’s agents in the same file are kept, and a forgotten one stays gone', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'h.json');
  const mk = (id, at) => historyMod.recordOf({ ...newAgentView({ agentId: id, name: id, task: 't', harness: 'claude', startedAt: at }), state: 'done_claimed', turns: 1 }, null, 9);
  const a = new historyMod.History({ file });
  a.source(() => [mk('one', 1)]);
  a.save();
  const b = new historyMod.History({ file });
  b.source(() => [mk('two', 2)]);
  b.save();
  assert.deepEqual(new historyMod.History({ file }).load().map(r => r.id), ['one', 'two']);
  b.forget('one');
  b.save();
  assert.deepEqual(new historyMod.History({ file }).load().map(r => r.id), ['two']);
});

// ------------------------------------------------------------------ the engine keeps it, and shows it

test('the engine writes a root’s record on change and at shutdown; the file holds no token', async (t) => {
  const dir = tmp(t);
  const w = world(t, dir);
  const { id } = await finishOne(w);
  await until(() => fs.existsSync(historyMod.historyFile(w.repoRoot, { dir: w.historyDir })), { timeout: 1000 }); // debounced, before shutdown
  await w.engine.shutdown();
  const file = readFile(w);
  assert.equal(file.agents.length, 1);
  const rec = file.agents[0];
  assert.equal(rec.id, id);
  assert.equal(rec.name, 'Fix login redirect');
  assert.equal(rec.task, 'Fix the login redirect');
  assert.equal(rec.harness, 'claude');
  assert.equal(rec.model, 'haiku');
  assert.equal(rec.state, 'done_claimed');
  assert.equal(rec.says, 'I fixed the redirect.');
  assert.equal(rec.sessionId, SESSION);
  assert.equal(rec.usage.costUsd, 0.31);
  assert.deepEqual(rec.files.list, [{ path: 'src/cart.js', adds: 3, dels: 1 }]);
  assert.equal(rec.workspace.branch, `workbench/fix-login-redirect-${id}`);
  assert.ok(rec.workspace.path.endsWith(`fix-login-redirect-${id}`));
  assert.ok(rec.endedAt > 0);
  const text = fs.readFileSync(historyMod.historyFile(w.repoRoot, { dir: w.historyDir }), 'utf8');
  assert.ok(!text.includes(`tok-${id}`), 'no hook token');
  assert.ok(!/tok-/.test(text));
});

test('a later run shows earlier agents in the snapshot, with their final state; nothing is spent or started', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();

  const second = world(t, dir);
  await second.engine.start();
  const snap = second.engine.snapshot();
  assert.equal(snap.agents.length, 1);
  const v = snap.agents[0];
  assert.equal(v.id, id);
  assert.equal(v.earlier, true);
  assert.equal(v.state, 'done_claimed');
  assert.ok(v.endedAt > 0);
  assert.equal(v.says, 'I fixed the redirect.');
  assert.equal(v.canContinue, true);
  assert.equal(v.continueReason, null);
  assert.equal(second.claude.runners.length, 0, 'nothing is started');
  assert.equal(second.engine.runs.size, 0);
  // Not an earlier agent: a new one is a plain live view.
  const fresh = await second.engine.startAgent({ task: 'Another job' });
  assert.equal(second.store.get(fresh.id).earlier, false);
  assert.equal(second.store.get(fresh.id).canContinue, null);
  // The earlier agent stays in the file next to the new one.
  await second.engine.shutdown();
  assert.deepEqual(readFile(second).agents.map(r => r.id).sort(), [id, fresh.id].sort());
});

test('an agent that was working when Workbench was killed comes back stopped, in plain words', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  await first.engine.start();
  const v = await first.engine.startAgent({ task: 'Long job' });
  first.claude.runners.at(-1).emit({ kind: EV.SESSION, sessionId: SESSION });
  first.engine.killAllSync(); // a forced exit: the file is written with the agent still working
  assert.equal(readFile(first).agents[0].state, 'working'); // the session line already moved it on from starting
  const second = world(t, dir);
  await second.engine.start();
  const e = second.store.get(v.id);
  assert.equal(e.state, 'stopped');
  assert.equal(e.stateReason, 'Workbench was closed while it was working.');
  assert.equal(e.earlier, true);
});

test('an earlier agent whose folder is gone is still shown, and says why it cannot continue', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const rec = readFile(first).agents[0];
  fs.rmSync(rec.workspace.path, { recursive: true });

  const second = world(t, dir);
  await second.engine.start();
  const v = second.engine.snapshot().agents[0];
  assert.equal(v.id, id);
  assert.equal(v.earlier, true);
  assert.equal(v.canContinue, false);
  assert.equal(v.continueReason, 'Its folder is gone, so it cannot continue.');
  const out = await second.engine.say(id, 'carry on');
  assert.equal(out.ok, false);
  assert.equal(out.reply, 'Fix login redirect cannot continue. Its folder is gone, so it cannot continue.');
  assert.equal(second.claude.runners.length, 0);
  assert.equal(second.store.get(id).earlier, true, 'it stays as it was');
});

test('an agent whose folder was removed at shutdown (nothing changed) shows that it has no folder', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir, { workspaceKept: false });
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  assert.equal(readFile(first).agents[0].workspace, null);
  const second = world(t, dir);
  await second.engine.start();
  assert.equal(second.store.get(id).canContinue, false);
  assert.equal(second.store.get(id).continueReason, 'Its folder was not kept, so it cannot continue.');
});

test('a Claude session that Claude Code no longer has cannot be continued; a missing id says so too', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  await finishOne(first);
  await first.engine.shutdown();
  const claude = fakeAdapter('claude');
  claude.sessionExists = () => false;
  const second = world(t, dir, { adapters: { claude, codex: fakeAdapter('codex') } });
  await second.engine.start();
  const v = second.engine.snapshot().agents[0];
  assert.equal(v.canContinue, false);
  assert.equal(v.continueReason, 'Claude Code no longer has its conversation, so it cannot continue.');

  const dir3 = tmp(t);
  const third = world(t, dir3);
  await third.engine.start();
  await third.engine.startAgent({ task: 'No session ever came' });
  third.claude.runners.at(-1).emit({ kind: EV.TURN, phase: 'start' });
  third.claude.runners.at(-1).emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0 });
  await until(() => third.store.list()[0].state === 'done_claimed');
  await third.engine.shutdown();
  const fourth = world(t, dir3);
  await fourth.engine.start();
  assert.equal(fourth.store.list()[0].continueReason, 'It never saved its conversation, so there is nothing to pick up.');
});

// ------------------------------------------------------------------ continue

test('a message to an earlier agent resumes its session in the same folder, with a fresh budget, and says so', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const rec = readFile(first).agents[0];

  const second = world(t, dir);
  await second.engine.start();
  const out = await second.engine.say(id, 'Also fix the logout redirect');
  assert.equal(out.ok, true, out.reply);
  assert.match(out.reply, /Fix login redirect is continuing in its own folder\./);
  assert.match(out.reply, /new spending limit of \$2\.00 for this run/);
  const runner = second.claude.runners.at(-1);
  assert.equal(runner.opts.sessionId, SESSION);
  assert.equal(runner.opts.cwd, rec.workspace.path);
  assert.equal(runner.opts.budgetUsd, 2);
  assert.equal(runner.opts.agentId, id);
  assert.deepEqual(runner.opts.hook, { url: HOOK.url, token: `tok-${id}` });
  assert.equal(runner.started, false, 'resumed through send, not started over');
  assert.deepEqual(runner.sent, ['Also fix the logout redirect']);
  const v = second.store.get(id);
  assert.equal(v.earlier, false);
  assert.equal(v.state, 'working');
  assert.equal(v.endedAt, null);
  assert.equal(v.canContinue, null);
  assert.equal(v.budgetUsd, 2);
  assert.equal(v.now, 'Working on your follow-up'); // as for any done agent that takes a message
  // It is an ordinary agent again: its turn ends with a receipt, checked in its own folder.
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Both are fixed.', backgroundTasks: 0 });
  await until(() => second.store.get(id).state === 'done_claimed');
  assert.equal(second.calls.diffStats.at(-1).path, rec.workspace.path);
  assert.equal(second.calls.diffStats.at(-1).base, BASE, 'what is not merged yet: since the commit it started from (it was never merged)');
});

test('the Continue button’s message, and the words "continue <name>", pick it up', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const second = world(t, dir);
  await second.engine.start();
  const out = await second.engine.command('continue fix login redirect', { focusId: null });
  assert.match(out.reply, /is continuing in its own folder/, out.reply);
  assert.equal(out.focusId, id);
  assert.deepEqual(second.claude.runners.at(-1).sent, ['Please continue where you left off.']);
});

test('the earlier run’s spend is not forgotten when the new process starts counting from zero', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const second = world(t, dir);
  await second.engine.start();
  await second.engine.say(id, 'more');
  const runner = second.claude.runners.at(-1);
  runner.emit({ kind: EV.USAGE, mode: 'set', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 });
  const u = second.store.get(id).usage;
  assert.equal(u.inputTokens, 110);
  assert.equal(u.outputTokens, 55);
  assert.ok(Math.abs(u.costUsd - 0.41) < 1e-9, String(u.costUsd));
});

test('a Codex agent is continued on its thread', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first, { harness: 'codex', sessionId: 'thread-123' });
  await first.engine.shutdown();
  const second = world(t, dir);
  await second.engine.start();
  assert.equal(second.store.get(id).canContinue, true);
  const out = await second.engine.say(id, 'and the docs');
  assert.equal(out.ok, true, out.reply);
  const runner = second.codex.runners.at(-1);
  assert.equal(runner.opts.sessionId, 'thread-123');
  assert.equal(runner.opts.hook, null);
  assert.deepEqual(runner.sent, ['and the docs']);
});

test('when the runner refuses (no spending left, cannot start), the agent stays earlier and the reply says why', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const claude = fakeAdapter('claude');
  const make = claude.createRunner.bind(claude);
  claude.createRunner = (opts) => {
    const r = make(opts);
    r.send = async () => { throw Object.assign(new Error('Fix login redirect has used its whole spending limit, so it can’t continue.'), { plain: true }); };
    return r;
  };
  const second = world(t, dir, { adapters: { claude, codex: fakeAdapter('codex') } });
  await second.engine.start();
  const out = await second.engine.say(id, 'again');
  assert.equal(out.ok, false);
  assert.match(out.reply, /whole spending limit/);
  assert.equal(second.store.get(id).earlier, true);
  assert.equal(second.engine.runs.size, 0);
});

test('Claude Code that is no longer installed: continuing is refused in plain words', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const second = world(t, dir, { adapters: { codex: fakeAdapter('codex') } });
  await second.engine.start();
  assert.equal(second.store.get(id).canContinue, false);
  assert.equal(second.store.get(id).continueReason, 'Claude Code is not available on this computer.');
});

test('an earlier agent whose checks had failed does not count as needing the person', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir, {});
  first.deps.receipt.runChecks = async () => ({ state: 'failed', results: [{ name: 'tests', ok: false, ms: 5, tail: 'SECRET-OUTPUT' }] });
  first.deps.workspace.readRepoConfig = async () => ({ checks: [{ name: 'tests', run: 'npm test' }], rules: [], allow: [] });
  await first.engine.start();
  const v = await first.engine.startAgent({ task: 'Break a test' });
  const r = first.claude.runners.at(-1);
  r.emit({ kind: EV.SESSION, sessionId: SESSION });
  r.emit({ kind: EV.TURN, phase: 'start' });
  r.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0 });
  await until(() => first.store.get(v.id).state === 'checks_failed');
  assert.match(first.engine._status().reply, /needs you/, 'in its own run it needs the person');
  await first.engine.shutdown();
  assert.ok(!fs.readFileSync(historyMod.historyFile(first.repoRoot, { dir: first.historyDir }), 'utf8').includes('SECRET-OUTPUT'), 'a check’s output is not kept');
  const second = world(t, dir);
  await second.engine.start();
  assert.equal(second.store.get(v.id).state, 'checks_failed');
  assert.match(second.engine._status().reply, /^Nothing needs you right now\./);
});

// ------------------------------------------------------------------ forget

test('"forget <name>" asks first; yes removes the agent from the board and the file, and keeps its folder', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  const other = await first.engine.startAgent({ task: 'Second job' });
  first.claude.runners.at(-1).emit({ kind: EV.SESSION, sessionId: '1f8fad5b-d9cb-469f-a165-70867728950e' });
  first.claude.runners.at(-1).emit({ kind: EV.TURN, phase: 'start' });
  first.claude.runners.at(-1).emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0 });
  await until(() => first.store.get(other.id).state === 'done_claimed');
  await first.engine.shutdown();
  const folder = readFile(first).agents.find(r => r.id === id).workspace.path;

  const second = world(t, dir);
  await second.engine.start();
  let removed = 0;
  second.store.on('removed', () => { removed += 1; });
  const asked = await second.engine.command('forget fix login redirect');
  assert.ok(asked.confirm, 'it asks first');
  assert.equal(asked.confirm.sentence, 'Forget Fix login redirect?');
  assert.match(asked.confirm.detail, /folder and branch stay on this computer/);
  assert.ok(second.store.get(id), 'nothing happened yet');
  const no = await second.engine.confirm(asked.confirm.id, false);
  assert.equal(no.reply, 'OK, I won’t forget it.');
  assert.ok(second.store.get(id));

  const again = await second.engine.command('forget it', { focusId: id });
  const yes = await second.engine.confirm(again.confirm.id, true);
  assert.match(yes.reply, /^Forgot Fix login redirect\. Its folder and branch are still on this computer\.$/);
  assert.equal(second.store.get(id), null);
  assert.ok(second.store.get(other.id), 'the other one stays');
  assert.equal(removed, 1);
  assert.ok(fs.existsSync(folder), 'its folder is not deleted');
  assert.deepEqual(readFile(second).agents.map(r => r.id), [other.id], 'gone from the file at once');
  await second.engine.shutdown();
  assert.deepEqual(readFile(second).agents.map(r => r.id), [other.id], 'and it stays gone');
  assert.equal(second.calls.removeWorkspace.some(c => c.path === folder), false);
});

test('a typed yes settles the forget card; an agent from this run cannot be forgotten', async (t) => {
  const dir = tmp(t);
  const first = world(t, dir);
  const { id } = await finishOne(first);
  await first.engine.shutdown();
  const second = world(t, dir);
  await second.engine.start();
  const live = await second.engine.startAgent({ task: 'Live job' });
  const asked = await second.engine.command('forget live job');
  const yesNow = await second.engine.command('yes', { confirmId: asked.confirm.id });
  assert.match(yesNow.reply, /is from this run, so it stays/);
  assert.ok(second.store.get(live.id));
  const ask2 = await second.engine.command('forget it', { focusId: id });
  const typed = await second.engine.command('do it', { confirmId: ask2.confirm.id });
  assert.match(typed.reply, /^Forgot /);
  assert.equal(second.store.get(id), null);
});

// ------------------------------------------------------------------ words

test('commands: forget and continue need an agent from an earlier run, and do not take other words', () => {
  const agents = [
    { id: 'aaa111', name: 'Search cleanup', task: 'clean the search code', kind: 'agent', state: 'done_claimed', earlier: true },
    { id: 'bbb222', name: 'Flaky test', task: 'fix the flaky test', kind: 'agent', state: 'stopped' },
  ];
  const ctx = { agents, focusId: null, machines: [], harnesses: { claude: true } };
  assert.deepEqual(commands.parseCommand('forget search cleanup', ctx), { kind: 'forget', agentIds: ['aaa111'] });
  assert.deepEqual(commands.parseCommand('forget about the flaky test', ctx), { kind: 'forget', agentIds: ['bbb222'] });
  assert.deepEqual(commands.parseCommand('forget it', { ...ctx, focusId: 'aaa111' }), { kind: 'forget', agentIds: ['aaa111'] });
  assert.deepEqual(commands.parseCommand('continue search cleanup', ctx), { kind: 'continue', agentId: 'aaa111' });
  assert.deepEqual(commands.parseCommand('pick up search cleanup again', ctx), { kind: 'continue', agentId: 'aaa111' });
  // Not an earlier agent: the old behaviour stays.
  assert.notEqual(commands.parseCommand('continue flaky test', ctx).kind, 'continue');
  assert.notEqual(commands.parseCommand('forget the old plan and use the new one', ctx).kind, 'forget');
  assert.equal(commands.describeIntent({ kind: 'forget', agentIds: ['aaa111'] }, ctx), 'Forget Search cleanup?');
});

// ------------------------------------------------------------------ store, runner, server

test('store: restore puts back a view marked earlier; resumed clears the mark; remove takes it and tells listeners', () => {
  const store = new Store();
  const rec = historyMod.recordOf({ ...newAgentView({ agentId: 'e1', name: 'Old one', task: 'old task', harness: 'claude', startedAt: 1000 }), state: 'done_checked', turns: 2, sessionId: SESSION, endedAt: 2000, says: 'All done.' }, { path: '/w/e1', branch: 'b', base: 'c' }, 3000);
  const seen = [];
  store.on('agents', (ids) => seen.push(...ids));
  const v = store.restore(rec, { ok: false, reason: 'Its folder is gone, so it cannot continue.' });
  assert.equal(v.earlier, true);
  assert.equal(v.state, 'done_checked');
  assert.equal(v.endedAt, 2000);
  assert.equal(v.startedAt, 1000);
  assert.equal(v.canContinue, false);
  assert.equal(v.continueReason, 'Its folder is gone, so it cannot continue.');
  assert.equal(store.restore(rec, { ok: true }), null, 'a second restore of the same id is ignored');
  assert.deepEqual(seen, ['e1']);
  store.markContinue('e1', { ok: true });
  assert.equal(store.get('e1').canContinue, true);
  assert.equal(store.get('e1').continueReason, null);
  store.apply([{ kind: EV.RESUMED, agentId: 'e1', budgetUsd: 3 }, { kind: EV.STATE, agentId: 'e1', state: 'working' }]);
  const r = store.get('e1');
  assert.deepEqual([r.earlier, r.canContinue, r.continueReason, r.endedAt, r.budgetUsd], [false, null, null, null, 3]);
  let removed = null;
  store.on('removed', (ids) => { removed = ids; });
  assert.equal(store.remove('e1'), true);
  assert.deepEqual(removed, ['e1']);
  assert.equal(store.get('e1'), null);
  assert.equal(store.list().length, 0);
  assert.equal(store.remove('e1'), false);
});

test('claude runner: a runner made with a session id resumes it with --resume and the whole budget; sessionExists reads Claude’s folder', async (t) => {
  const { createRunner: createClaude, sessionExists } = await import('../src/adapters/claude/runner.mjs');
  const FAKE = new URL('./helpers/claude-fake.mjs', import.meta.url).pathname;
  fs.chmodSync(FAKE, 0o755);
  const dir = tmp(t);
  const events = [];
  const r = createClaude({
    agentId: 'r1', name: 'Old one', task: 'old task', cwd: dir, budgetUsd: 1.5, sessionId: SESSION, hook: { url: HOOK.url, token: 'tok-r1' },
    emit: (e) => events.push(e), env: { ...process.env, WORKBENCH_CLAUDE_BIN: FAKE, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') },
  });
  t.after(() => r.stop());
  assert.equal(r.info().sessionId, SESSION);
  assert.equal(r.info().alive, false);
  await r.send('hello again');
  await until(() => events.some(e => e.kind === EV.TURN && e.phase === 'end'), { timeout: 10_000 });
  const said = events.find(e => e.kind === EV.TURN && e.phase === 'end').finalText;
  assert.equal(said, `You said (resumed ${SESSION} with budget 1.5): hello again`);
  // Claude's own folder: <config>/projects/<key>/<session>.jsonl
  const config = path.join(dir, 'claude');
  assert.equal(sessionExists({ sessionId: SESSION, env: { CLAUDE_CONFIG_DIR: config } }), null, 'no projects folder: cannot tell');
  fs.mkdirSync(path.join(config, 'projects', '-some-key'), { recursive: true });
  assert.equal(sessionExists({ sessionId: SESSION, env: { CLAUDE_CONFIG_DIR: config } }), false);
  fs.writeFileSync(path.join(config, 'projects', '-some-key', `${SESSION}.jsonl`), '{}\n');
  assert.equal(sessionExists({ sessionId: SESSION, env: { CLAUDE_CONFIG_DIR: config } }), true);
  assert.equal(sessionExists({ sessionId: 'not-a-uuid', env: { CLAUDE_CONFIG_DIR: config } }), null);
});

test('server: forgetting an earlier agent sends every page a fresh snapshot', async (t) => {
  const { createServer } = await import('../src/server/http.mjs');
  const dir = tmp(t);
  const store = new Store();
  const rec = historyMod.recordOf({ ...newAgentView({ agentId: 'e1', name: 'Old one', task: 'x', harness: 'claude' }), state: 'done_claimed', turns: 1 }, null, 1);
  store.restore(rec, { ok: false, reason: 'gone' });
  const engine = {
    snapshot: () => ({ mode: 'live', agents: store.list(), machines: [], spendTodayUsd: 0, defaultBudgetUsd: 2 }),
  };
  const token = 'a'.repeat(64);
  const srv = createServer({ engine, store, token, port: 0, rootDir: dir });
  const { url } = await srv.listen();
  t.after(() => srv.close());
  const res = await fetch(new URL('api/stream', url), { headers: { 'X-Workbench-Token': token } });
  const reader = res.body.getReader();
  let text = '';
  const readUntil = async (re) => {
    const deadline = Date.now() + 3000;
    while (!re.test(text) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
  };
  await readUntil(/event: snapshot[\s\S]*\n\n/);
  assert.match(text, /"earlier":true/);
  text = '';
  store.remove('e1');
  await readUntil(/event: snapshot[\s\S]*\n\n/);
  assert.match(text, /event: snapshot/);
  assert.match(text, /"agents":\[\]/);
  await reader.cancel();
});
