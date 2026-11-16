import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.mjs';
import * as filesMod from '../src/core/files.mjs';
import * as historyMod from '../src/core/history.mjs';
import { Store } from '../src/core/store.mjs';
import { EV } from '../src/shared/events.mjs';
import * as commands from '../src/core/commands.mjs';
import * as receiptMod from '../src/core/receipt.mjs';
import * as workspaceMod from '../src/core/workspace.mjs';
import * as policyMod from '../src/core/policy.mjs';
import { createPrefs, prefsFile, memoryPrefs } from '../src/core/prefs.mjs';
import { Simulator } from '../src/adapters/sim/simulator.mjs';
import { FakeSim, FakeGitSim, FakeMachines, fakeAdapter, fakeDeps, gate, gitError, until, FAKE_BASE, FAKE_MERGE, FAKE_WORK } from './helpers/engine-fakes.mjs';
import { slowFolder, slowLines } from './helpers/slow-lines.mjs';

const REPO = { root: '/repos/shop', name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 2 };
const HOOK = { url: 'http://127.0.0.1:9/hook/pretool', tokenFor: (id) => `tok-${id}` };
const subagentPayload = JSON.parse(fs.readFileSync(new URL('./fixtures/hook-pretool-subagent.json', import.meta.url), 'utf8'));
const rootPayload = JSON.parse(fs.readFileSync(new URL('./fixtures/hook-pretool-root-bash.json', import.meta.url), 'utf8'));

/** A live-mode engine with fake adapters and deps. Remember to call engine.shutdown(). `log` gets what it logs. */
function live({ deps: depOpts = {}, options = {}, adapters = null, defaultBudgetUsd = 2, prefs = null, log = null } = {}) {
  const store = new Store();
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const { deps, calls, git } = fakeDeps(depOpts);
  const machines = new FakeMachines();
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({
    store, mode: 'live', repo: REPO, hook: HOOK, defaultBudgetUsd,
    adapters: adapters || { claude, codex }, machines, deps, prefs, log,
    options: { permissionTimeoutMs: 5000, tickMs: 10_000_000, helperWaitMs: 60, exitGraceMs: 20, ...options },
  });
  return { store, engine, claude, codex, deps, calls, git, machines, notices };
}

/** A live engine whose agents' folders are real (a directory holding a .git file), so the engine finds them on disk. */
function liveFolders(ctx, opts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-engine-')));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const t = live({ ...opts, deps: { ...(opts.deps || {}), folders: dir } });
  t.dir = dir;
  return t;
}

/**
 * A live engine on a real temporary git repository, with the real workspace module: the agents' folders are made under
 * a temporary folder (never ~/.workbench), and the person's name and email come from a temporary global git config,
 * never the machine's own. The runners are fakes: a test writes an agent's work into its folder itself. `git` runs git
 * in the person's folder.
 */
async function realGit(ctx) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-engine-git-')));
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  ctx.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(dir, 'gitconfig'), '[user]\n\tname = Person Testing\n\temail = person@example.invalid\n');
  Object.assign(process.env, {
    HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'home', '.config'), GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'cart.js'), 'export const total = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'First commit');
  const store = new Store();
  const claude = fakeAdapter('claude');
  const codex = fakeAdapter('codex');
  const { deps, calls } = fakeDeps();
  deps.workspace = { ...workspaceMod, createWorkspace: (o) => workspaceMod.createWorkspace({ ...o, baseDir: path.join(dir, 'worktrees') }) };
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({
    store, mode: 'live', repo: await workspaceMod.prepareRepo(repo), hook: HOOK, defaultBudgetUsd: 2,
    adapters: { claude, codex }, machines: new FakeMachines(), deps,
    options: { permissionTimeoutMs: 5000, tickMs: 10_000_000, helperWaitMs: 60, exitGraceMs: 20 },
  });
  return { store, engine, claude, codex, deps, calls, notices, repo, git };
}

/** Start an agent and run its turn to "says it is done" (or the done state its checks give). */
async function doneAgent(t, opts = { task: 'Fix the cart total' }, finalText = 'I fixed the cart total.') {
  const a = await started(t, opts);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText, backgroundTasks: 0, isError: false });
  await until(() => !['working', 'starting'].includes(t.store.get(a.id).state));
  return a;
}

function demo({ options = {}, intent = null, prefs = null } = {}) {
  const store = new Store();
  const sim = new FakeSim();
  const { deps, calls } = fakeDeps({ intent });
  const machines = new FakeMachines({ demo: true });
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim }, machines, deps, prefs, options: { tickMs: 10_000_000, simTickMs: 10_000_000, ...options } });
  return { store, engine, sim, deps, calls, machines, notices };
}

/** Start an agent and return its view and fake runner. */
async function started(t, opts = { task: 'Fix the login redirect' }) {
  const v = await t.engine.startAgent(opts);
  const adapter = opts.harness === 'codex' ? t.codex : t.claude;
  return { v, id: v.id, runner: adapter.runners[adapter.runners.length - 1] };
}

/** Whether a promise has settled yet. */
async function settled(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await new Promise(r => setTimeout(r, 15));
  return done;
}

// ------------------------------------------------------------------ launching

test('startAgent (live) creates a workspace, emits created then starting, and starts the runner there', async () => {
  const t = live();
  let stateAtStart = null;
  t.claude = fakeAdapter('claude', { onStart: (r) => { stateAtStart = t.store.get(r.opts.agentId).state; } });
  t.engine.adapters.claude = t.claude;
  const { v, runner } = await started(t, { task: 'Fix the flaky checkout test' });
  assert.match(v.id, /^[0-9a-f]{6}$/);
  assert.equal(v.parentId, null);
  assert.equal(v.name, 'Fix flaky checkout test');
  assert.equal(v.harness, 'claude');
  assert.equal(v.budgetUsd, 2);
  assert.equal(v.machineId, 'laptop');
  assert.equal(v.workspace, `/wt/shop/fix-flaky-checkout-test-${v.id}`);
  assert.equal(stateAtStart, 'starting', 'created and starting come before the runner starts');
  assert.equal(runner.started, true);
  assert.equal(runner.opts.cwd, v.workspace);
  assert.equal(runner.opts.task, 'Fix the flaky checkout test');
  assert.equal(runner.opts.budgetUsd, 2);
  assert.deepEqual(runner.opts.hook, { url: HOOK.url, token: `tok-${v.id}` }, 'the agent gets its own hook token');
  assert.equal(typeof runner.opts.emit, 'function');
  assert.deepEqual(t.calls.createWorkspace[0], { repoRoot: REPO.root, agentId: v.id, slug: 'fix-flaky-checkout-test' });
  assert.deepEqual(t.calls.readRepoConfig[0], { repoRoot: REPO.root, ref: FAKE_BASE }, 'config comes from the base commit');
  assert.ok(t.notices.includes('Started Fix flaky checkout test.'));
  await t.engine.shutdown();
});

test('startAgent refuses what cannot run, and a runner that fails to start leaves a failed agent', async () => {
  const t = live({ adapters: { claude: fakeAdapter('claude', { failStart: new Error('spawn claude ENOENT') }) } });
  await assert.rejects(t.engine.startAgent({ task: '' }), /Tell me what the agent should work on/);
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'codex' }), /Codex is not available/);
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'sim' }), /only in the demo/);
  await assert.rejects(t.engine.startAgent({ task: 'x', model: '--dangerously-skip-permissions' }), /model name/);
  const v = await t.engine.startAgent({ task: 'Fix the login', budgetUsd: 5 });
  assert.equal(v.state, 'failed');
  assert.match(v.stateReason, /could not start/);
  assert.equal(v.budgetUsd, 5);
  await t.engine.shutdown();
});

test('start() in live mode checks which harnesses are available', async () => {
  const t = live({ adapters: { claude: fakeAdapter('claude'), codex: fakeAdapter('codex', { available: { ok: false, reason: 'Codex is not installed.' } }) } });
  await t.engine.start();
  const snap = t.engine.snapshot();
  assert.deepEqual(snap.harnesses, { claude: true, codex: false, sim: false });
  assert.equal(snap.harnessInfo.codex.reason, 'Codex is not installed.');
  await assert.rejects(t.engine.startAgent({ task: 'x', harness: 'codex' }), /not available/);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ agents' copies: the files they need, and the setup command

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const FILLED = { copied: [{ path: '.env', kind: 'env' }, { path: 'apps/web/.env.local', kind: 'env' }, { path: 'node_modules', kind: 'deps' }], skipped: [] };
const COPIES_NOTICE = 'Agents’ copies now get your .env files, keys included, and node_modules, so they can run the project. A .worktreeinclude file at the top of the repository chooses what is copied.';
const SETUP_ASK = 'Run this setup command in each agent’s copy before it starts?';
const SETUP_RAN = 'OK. Each agent’s copy runs it before the agent starts.';
const SETUP_WAITING = 'Waiting for your answer about the setup command';

/**
 * A live engine whose agents' copies are filled (stand-ins for fillWorkspace and envValues), with workbench.json's setup
 * command `setup` (none when undefined), the person's kept choices in memory unless given, and its log kept. The runner's
 * start is noted in calls.order, after 'fill' and 'setup'.
 */
function copies({ fill = FILLED, setup, env = { values: [], files: 2 }, prefs, options } = {}) {
  const logs = [];
  const t = live({ deps: { fill, setup }, prefs: prefs === undefined ? memoryPrefs() : prefs, options, log: (level, ...a) => logs.push(`${level} ${a.map(String).join(' ')}`) });
  t.git.env = env;
  t.logs = logs;
  t.claude = fakeAdapter('claude', { onStart: () => t.calls.order.push('runner') });
  t.engine.adapters.claude = t.claude;
  return t;
}
/** The setup card the engine waits on, once it shows (the snapshot's `setup`). */
const setupCard = (t) => until(() => t.engine.snapshot().setup);

test('the tidy-up hears what an agent’s copy got, so a folder holding only those copies can go at shutdown', async () => {
  const t = copies();
  const v = await t.engine.startAgent({ task: 'Fix the login redirect' });
  await until(() => t.calls.order.includes('runner'));
  await t.engine.shutdown();
  const call = t.calls.removeWorkspace.find(o => o.path === v.workspace);
  assert.ok(call, 'its folder is offered to the tidy-up');
  assert.deepEqual(call.copied, ['.env', 'apps/web/.env.local', 'node_modules']);
  assert.equal(call.onlyIfUnchanged, true);
});

test('a new agent’s copy is filled first, then its setup command runs, then its runner starts; it says what it copies, and then what came of it', async () => {
  const t = copies({ setup: 'npm ci', prefs: memoryPrefs({ setupOk: { [REPO.root]: sha('npm ci') } }) });
  const g = gate();
  t.git.fillGate = g;
  const launch = t.engine.startAgent({ task: 'Fix the login redirect' });
  await until(() => t.calls.fillWorkspace.length === 1);
  const [v] = t.store.list();
  assert.equal(v.state, 'starting');
  assert.equal(v.now, 'Copying .env, apps/web/.env.local and node_modules into its copy', 'the hover line names what is being copied');
  assert.deepEqual(t.calls.order, ['fill'], 'nothing else runs while it copies');
  g.open();
  const done = await launch;
  assert.deepEqual(t.calls.order, ['fill', 'setup', 'runner']);
  const fill = t.calls.fillWorkspace[0];
  assert.deepEqual({ repoRoot: fill.repoRoot, path: fill.path }, { repoRoot: REPO.root, path: done.workspace });
  assert.equal(typeof fill.onChosen, 'function');
  assert.deepEqual(t.calls.envValues[0].copied.map(e => e.path), ['.env', 'apps/web/.env.local', 'node_modules'], 'the copied files are read for their values');
  const setup = t.calls.runSetup[0];
  assert.equal(setup.cwd, done.workspace);
  assert.equal(setup.run, 'npm ci');
  assert.equal(setup.timeoutSec, 600);
  assert.equal(setup.env.WORKBENCH_ROOT, REPO.root, 'the person’s folder');
  assert.equal(setup.env.WORKBENCH_AGENT_ID, done.id, 'so a Workbench started from it refuses, as one started from a check does');
  assert.ok(setup.signal instanceof AbortSignal);
  assert.equal(done.state, 'starting');
  const detail = 'Its copy has your .env, apps/web/.env.local and node_modules. The setup command ran in it.';
  assert.equal(done.now, detail, 'the start detail: the line its chip shows on hover');
  // Warnings, as the launch's own lines are, so the log has them without --verbose (the Mac app passes none).
  assert.ok(t.logs.includes(`warn Fix login redirect is starting. ${detail}`), t.logs.join('\n'));
  assert.ok(t.logs.includes('warn The setup command ran in the copy of Fix login redirect (under a second). The end of what it printed: added 12 packages'), t.logs.join('\n'));
  assert.ok(t.notices.includes('Started Fix login redirect.'));
  await t.engine.shutdown();
});

test('a copy that fails, or a setup command that fails, never stops the launch: the agent starts, and its start detail says so', async () => {
  const t = copies({ setup: 'npm ci', prefs: memoryPrefs({ setupOk: { [REPO.root]: sha('npm ci') } }) });
  t.git.fillError = new Error('cp: something broke');
  t.git.setupResult = { ok: false, exitCode: 1, timedOut: false, ms: 9, tail: 'npm ERR! missing script: ci\nnpm ERR! see the log' };
  const v = await t.engine.startAgent({ task: 'Fix the login redirect' });
  assert.deepEqual(t.calls.order, ['fill', 'setup', 'runner']);
  assert.equal(t.claude.runners[0].started, true);
  assert.equal(v.now, 'Workbench could not copy your ignored files into its copy. The setup command failed (exit 1), so its copy may not run yet.');
  assert.ok(t.logs.some(l => l.startsWith('warn Workbench could not copy the files Fix login redirect needs into its folder')), t.logs.join('\n'));
  assert.ok(t.logs.some(l => l === 'warn The setup command failed in the copy of Fix login redirect (exit 1). The end of what it printed: npm ERR! missing script: ci | npm ERR! see the log'), t.logs.join('\n'));
  // a limit reached, and a command that could not start
  t.git.fillError = null;
  t.git.setupResult = { ok: false, exitCode: null, timedOut: true, ms: 600_000, tail: 'Stopped after 600 seconds because it took too long.' };
  assert.match((await t.engine.startAgent({ task: 'Fix the cart' })).now, / The setup command took more than 10 minutes, so its copy may not run yet\.$/);
  t.git.setupResult = { ok: false, exitCode: null, timedOut: false, ms: 0, tail: 'Could not start this check: spawn /bin/sh ENOENT' };
  assert.match((await t.engine.startAgent({ task: 'Fix the tax' })).now, / The setup command could not start, so its copy may not run yet\.$/);
  await t.engine.shutdown();
});

test('the start detail says what was not copied, and why, in plain words', async () => {
  const t = copies({ fill: { copied: [{ path: '.env', kind: 'env' }], skipped: [
    { path: 'node_modules', why: 'noclone' }, { path: 'apps/web/node_modules', why: 'noclone' },
    { path: '.env.local', why: 'not-ignored' }, { path: 'vendor/lib', why: 'nested-repo' }, { path: 'node_modules/out', why: 'link-outside' },
    { path: 'data', why: 'failed' }, { path: 'tools/.venv', why: 'venv' }, { path: 'build', why: 'exists' },
  ] } });
  const v = await t.engine.startAgent({ task: 'Fix the login redirect' });
  assert.equal(v.now, ['Its copy has your .env.',
    'node_modules and apps/web/node_modules were not copied: this disk cannot make quick copies.',
    '.env.local was not copied: the rule that hides it from git is not committed.',
    'vendor/lib was not copied: it is a repository of its own.',
    'node_modules/out was left out: it leads outside the repository.',
    'data could not be copied.',
    'tools/.venv still runs the Python in your folder.'].join(' '));
  // nothing could be listed at all, or nothing was there to copy
  t.git.fill = { copied: [], skipped: [{ path: '.', why: 'failed' }] };
  assert.equal((await t.engine.startAgent({ task: 'Fix the cart' })).now, 'Workbench could not list the files to copy into its copy.');
  t.git.fill = { copied: [], skipped: [{ path: '.worktreeinclude', why: 'failed' }] };
  assert.equal((await t.engine.startAgent({ task: 'Fix the tax' })).now, 'Workbench could not read .worktreeinclude, so nothing was copied.');
  t.git.fill = { copied: [], skipped: [] };
  t.git.env = { values: [], files: 0 };
  assert.equal((await t.engine.startAgent({ task: 'Fix the docs' })).now, 'Starting', 'nothing to copy: nothing to say');
  await t.engine.shutdown();
});

test('the notice about agents’ copies is said once per repository, the first time an env file is copied, and kept', async (ctx) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-copies-prefs-')));
  ctx.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prefs = createPrefs({ file: prefsFile(home) });
  // no env file copied (node_modules only): nothing to say yet
  const t = copies({ prefs, env: { values: [], files: 0 }, fill: { copied: [{ path: 'node_modules', kind: 'deps' }], skipped: [] } });
  await t.engine.startAgent({ task: 'Fix the login redirect' });
  assert.ok(!t.notices.includes(COPIES_NOTICE));
  // the first that gets an env file: said once, before "Started"
  t.git.fill = FILLED;
  t.git.env = { values: [], files: 2 };
  await Promise.all([t.engine.startAgent({ task: 'Fix the cart' }), t.engine.startAgent({ task: 'Fix the tax' })]);
  await t.engine.startAgent({ task: 'Fix the docs' });
  assert.equal(t.notices.filter(n => n === COPIES_NOTICE).length, 1, t.notices.join('\n'));
  assert.ok(t.notices.indexOf(COPIES_NOTICE) < t.notices.indexOf('Started Fix cart.'));
  assert.deepEqual(prefs.get().copiesSaid, [REPO.root]);
  await t.engine.shutdown();
  // another run on the same repository does not say it again
  const again = copies({ prefs });
  await again.engine.startAgent({ task: 'Fix the login redirect' });
  assert.ok(!again.notices.includes(COPIES_NOTICE));
  await again.engine.shutdown();
});

test('values in copied env files are hidden in what the agent prints, on the page and in the log, as stored keys are; words that only hold one are not refused', async () => {
  const url = ['postgres://app', 'pw-x81mQ@db.internal/app'].join(':');
  const t = copies({ env: { values: [url, 'production'], files: 1 }, fill: { copied: [{ path: '.env.production', kind: 'env' }], skipped: [] } });
  const v = await t.engine.startAgent({ task: 'Fix the login redirect' });
  // Workbench's own words, made of file names, are not masked: .env.production is not ".env.••••"
  assert.equal(v.now, 'Its copy has your .env.production.');
  assert.ok(t.notices.includes(COPIES_NOTICE));
  const runner = t.claude.runners[0];
  assert.equal(typeof runner.opts.mask, 'function', 'the runner masks its output before it is read');
  assert.equal(runner.opts.mask(`DATABASE_URL=${url}`), 'DATABASE_URL=•••• /app');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.SAYS, text: `The .env has DATABASE_URL=${url} and NODE_ENV=production.` });
  assert.equal(t.store.get(v.id).says, 'The .env has DATABASE_URL=•••• /app and NODE_ENV=••••.');
  runner.emit({ kind: EV.STATE, state: 'failed', reason: `It could not reach ${url}.` });
  assert.ok(t.logs.some(l => l === 'warn Fix login redirect failed: It could not reach •••• /app.'), t.logs.join('\n'));
  assert.ok(!t.logs.some(l => l.includes(url)), 'never the value itself in the log');
  // a value is no key: words that hold one still launch
  const w = await t.engine.startAgent({ task: 'fix the production build' });
  assert.notEqual(w.state, 'failed');
  t.deps.commands.intent = { kind: 'task', task: 'fix the production build' };
  assert.ok((await t.engine.command('fix the production build')).confirm, 'a launch card, not "that looks like a key"');
  await t.engine.shutdown();
});

test('a copied value never hides the person’s own words: the task, the name, the replies and the merge commit keep "production"', async (ctx) => {
  // envValues leaves out a plain word, but hands over one whose name says secret (PASSWORD=production): the fake hands
  // it over, as that one. What agents print hides it; what the person typed, and what is made of it, does not.
  const url = ['postgres://app', 'pw-x81mQ@db.internal/app'].join(':');
  const t = liveFolders(ctx, { deps: { fill: { copied: [{ path: '.env', kind: 'env' }], skipped: [] } } });
  t.git.env = { values: ['production', url], files: 1 };
  // Launched before the value was known (its own copy brings it): its merge comes after.
  const a = await doneAgent(t, { task: 'fix the production build' }, `I fixed the build, which reads ${url} now.`);
  // Launched once the value is known, through the launch card.
  t.deps.commands.intent = { kind: 'task', task: 'deploy to production' };
  const out = await t.engine.command('deploy to production');
  assert.equal(out.confirm.sentence, 'Start Claude Code on “deploy to production”?');
  const yes = await t.engine.confirm(out.confirm.id, true);
  assert.equal(yes.reply, 'Started Deploy to production.');
  const b = t.store.get(yes.agentIds[0]);
  assert.deepEqual([b.name, b.task], ['Deploy to production', 'deploy to production'], 'as the board and the history keep it');
  await until(() => t.claude.runners.length === 2 && t.claude.runners[1].started);
  assert.deepEqual(t.claude.runners[1].opts.task, 'deploy to production', 'the agent gets its task as it was typed');
  assert.equal((await t.engine.say(b.id, 'use the production database')).reply, 'Sent to Deploy to production.');
  // What the agent prints is still hidden.
  t.claude.runners[1].emit({ kind: EV.SAYS, text: `NODE_ENV is production, and the database is ${url}.` });
  assert.equal(t.store.get(b.id).says, 'NODE_ENV is ••••, and the database is •••• /app.');
  // The merge commit: its subject and name are the person's words; its body is the agent's, hidden as it printed it.
  const merge = await t.engine.proposeMerge(a.id);
  assert.equal(merge.confirm.sentence, 'Merge Fix production build into main?');
  assert.equal((await t.engine.confirm(merge.confirm.id, true)).reply, 'Merged Fix production build into main.');
  assert.deepEqual(t.calls.mergeWork.at(-1).message, { subject: 'Fix the production build', body: 'I fixed the build, which reads •••• /app now.', name: 'Fix production build' });
  assert.ok(!JSON.stringify(t.store.list()).includes(url), 'never the value itself');
  await t.engine.shutdown();
});

test('the setup card: asked the first time, Run it is kept for the repository and that command; Not now starts without it and asks again; a changed command asks again', async (ctx) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-setup-prefs-')));
  ctx.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prefs = createPrefs({ file: prefsFile(home) });
  const t = copies({ setup: 'npm ci', prefs });
  let told = 0;
  t.engine.on('setup', () => { told += 1; });
  const first = t.engine.startAgent({ task: 'Fix the login redirect' });
  const card = await setupCard(t);
  assert.deepEqual({ ...card, id: undefined }, {
    id: undefined, kind: 'setup', sentence: SETUP_ASK, command: 'npm ci', yes: 'Run it', no: 'Not now',
    detail: 'It comes from workbench.json, and runs before each new agent starts. Workbench asks again if it changes.',
  });
  assert.match(card.id, /^[0-9a-f]{12}$/);
  assert.equal(told, 1, 'the page hears of it (the server sends a fresh snapshot)');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(t.calls.order, ['fill'], 'it waits for the answer: no setup and no runner yet');
  assert.equal(t.store.list()[0].state, 'starting');
  assert.equal(t.store.list()[0].now, SETUP_WAITING, 'its copy is made: it waits for the person, and says so');
  assert.deepEqual(await t.engine.confirm(card.id, true), { reply: SETUP_RAN });
  const v = await first;
  assert.deepEqual(t.calls.order, ['fill', 'setup', 'runner']);
  assert.equal(t.engine.snapshot().setup, undefined);
  assert.equal(told, 2);
  assert.deepEqual(prefs.get().setupOk, { [REPO.root]: sha('npm ci') }, 'kept by repository and command text');
  assert.match(v.now, /The setup command ran in it\.$/);
  // the same command again: no card
  t.calls.order.length = 0;
  await t.engine.startAgent({ task: 'Fix the cart' });
  assert.deepEqual(t.calls.order, ['fill', 'setup', 'runner']);
  // a changed command asks again; Not now starts it without, keeps nothing, and the next launch asks again
  t.git.setup = 'npm ci && npm run build';
  t.calls.order.length = 0;
  const changed = t.engine.startAgent({ task: 'Fix the tax' });
  const card2 = await setupCard(t);
  assert.equal(card2.command, 'npm ci && npm run build');
  assert.notEqual(card2.id, card.id);
  assert.deepEqual(await t.engine.confirm(card2.id, false), { reply: 'OK. The agent starts without it, and Workbench asks again next time.' });
  const w = await changed;
  assert.deepEqual(t.calls.order, ['fill', 'runner']);
  assert.match(w.now, /It starts without the setup command\.$/);
  assert.deepEqual(prefs.get().setupOk, { [REPO.root]: sha('npm ci') });
  const asked = t.engine.startAgent({ task: 'Fix the docs' });
  const card3 = await setupCard(t);
  assert.equal(card3.command, 'npm ci && npm run build');
  assert.deepEqual(await t.engine.confirm(card3.id, true), { reply: SETUP_RAN });
  await asked;
  assert.deepEqual(prefs.get().setupOk, { [REPO.root]: sha('npm ci && npm run build') });
  // an answer that comes twice finds nothing
  assert.deepEqual(await t.engine.confirm(card3.id, true), { reply: 'That request is no longer waiting. Ask again if you still want it.' });
  await t.engine.shutdown();
});

test('the setup card is asked once for a burst of launches, and its answer goes to every one of them', async () => {
  const t = copies({ setup: 'uv sync' });
  let told = 0;
  t.engine.on('setup', () => { told += 1; });
  // three launches from one launch card: the reply comes while they wait, and one card shows
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the cart' }, { task: 'fix the tax' }, { task: 'fix the docs' }] };
  const out = await t.engine.command('start three agents');
  const yes = await t.engine.confirm(out.confirm.id, true);
  assert.equal(yes.reply, 'Started Fix cart, Fix tax and Fix docs.', 'the launch card’s answer does not wait for the setup card');
  const card = await setupCard(t);
  // one more launched meanwhile joins the same card
  const late = t.engine.startAgent({ task: 'Fix the login' });
  await until(() => t.store.list().length === 4 && t.calls.fillWorkspace.length === 4);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(t.engine.snapshot().setup.id, card.id);
  assert.equal(told, 1, 'one card, never one per agent');
  assert.equal(t.claude.runners.length, 0);
  assert.deepEqual(await t.engine.confirm(card.id, false), { reply: 'OK. The agents start without it, and Workbench asks again next time.' });
  await late;
  await until(() => t.claude.runners.length === 4 && t.claude.runners.every(r => r.started));
  assert.equal(t.calls.runSetup.length, 0);
  assert.equal(told, 2);
  // the next burst asks again, and Run it reaches each of them
  const both = [t.engine.startAgent({ task: 'Fix the search' }), t.engine.startAgent({ task: 'Fix the billing' })];
  const card2 = await setupCard(t);
  assert.notEqual(card2.id, card.id);
  await t.engine.confirm(card2.id, true);
  await Promise.all(both);
  assert.equal(t.calls.runSetup.length, 2);
  assert.equal(told, 4);
  await t.engine.shutdown();
});

test('the setup card: "run it" and "not now" answer it; other words leave it waiting; nobody answering counts as Not now after 10 minutes', async () => {
  const t = copies({ setup: 'npm ci', options: { confirmTtlMs: 60_000 } });
  const a = t.engine.startAgent({ task: 'Fix the login redirect' });
  const card = await setupCard(t);
  // the parser gets it as the card on screen, by its kind
  t.deps.commands.intent = (text, ctx) => (text === 'run it' ? { kind: 'confirm', go: true } : { kind: 'status' });
  await t.engine.command('what needs me', { confirmId: card.id });
  assert.equal(t.calls.parse.at(-1).ctx.pendingConfirm.kind, 'setup');
  assert.equal(t.engine.snapshot().setup.id, card.id, 'another command does not answer it for the person');
  const said = await t.engine.command('run it', { confirmId: card.id });
  assert.equal(said.reply, SETUP_RAN);
  await a;
  assert.equal(t.calls.runSetup.length, 1);
  // kept now: the next launch runs it without a card
  await t.engine.startAgent({ task: 'Fix the cart' });
  // a near miss keeps a card, in its own words
  t.git.setup = 'make setup';
  const c = t.engine.startAgent({ task: 'Fix the tax' });
  const card2 = await setupCard(t);
  t.deps.commands.intent = { kind: 'unknown', text: 'hmm' };
  const miss = await t.engine.command('hmm', { confirmId: card2.id });
  assert.equal(miss.reply, 'I did not catch that. Say “run it” or “not now”.');
  assert.equal(miss.confirm.id, card2.id);
  assert.equal(miss.confirm.command, 'make setup');
  // ten minutes (here one) without an answer: the agent starts without it
  t.engine.tick(Date.now() + 61_000);
  const v = await c;
  assert.equal(t.calls.runSetup.length, 2, 'only the two that were said yes to');
  assert.match(v.now, /It starts without the setup command\.$/);
  assert.equal(t.engine.snapshot().setup, undefined);
  assert.ok(t.logs.some(l => l === 'warn Nobody answered whether to run the setup command, so the agents waiting for it start without it.'), t.logs.join('\n'));
  await t.engine.shutdown();
});

test('an agent whose copy is being made ready is never asked whether it is stuck: it waits for Workbench, or for the person', async () => {
  const t = copies({ setup: 'npm ci', options: { stuckSilenceMs: 1000 } });
  const a = t.engine.startAgent({ task: 'Fix the login redirect' });
  const card = await setupCard(t);
  t.engine.tick(Date.now() + 5000);
  const [v] = t.store.list();
  assert.equal(v.state, 'starting');
  assert.equal(v.ask, null);
  await t.engine.confirm(card.id, true);
  await a;
  await t.engine.shutdown();
});

test('while the setup card waits, a starting agent says so once its copy is made, and at once when there is no copy to make', async () => {
  const t = copies({ setup: 'npm ci' });
  const g = gate();
  t.git.fillGate = g;
  const a = t.engine.startAgent({ task: 'Fix the login redirect' });
  const card = await setupCard(t);
  const [v] = t.store.list();
  assert.equal(t.store.get(v.id).now, 'Copying .env, apps/web/.env.local and node_modules into its copy', 'still copying');
  g.open();
  await until(() => t.store.get(v.id).now === SETUP_WAITING);
  assert.deepEqual(t.calls.order, ['fill']);
  await t.engine.confirm(card.id, false);
  assert.equal((await a).now, 'Its copy has your .env, apps/web/.env.local and node_modules. It starts without the setup command.');
  // Its setup card answered while it copied: it never says it waits.
  t.git.fillGate = gate();
  const b = t.engine.startAgent({ task: 'Fix the cart' });
  const card2 = await setupCard(t);
  await t.engine.confirm(card2.id, true);
  const seen = [];
  t.store.on('agents', ids => { for (const id of ids) if (t.store.get(id)?.name === 'Fix cart') seen.push(t.store.get(id).now); });
  t.git.fillGate.open();
  assert.equal((await b).now, 'Its copy has your .env, apps/web/.env.local and node_modules. The setup command ran in it.');
  assert.ok(!seen.includes(SETUP_WAITING), seen.join(' / '));
  await t.engine.shutdown();
  // No copy to make (a workspace module without fillWorkspace): it waits for the person from the start.
  const u = copies({ setup: 'npm ci', fill: null });
  const c = u.engine.startAgent({ task: 'Fix the tax' });
  const card3 = await setupCard(u);
  await until(() => u.store.list()[0]?.now === SETUP_WAITING);
  await u.engine.confirm(card3.id, true);
  await c;
  await u.engine.shutdown();
});

test('an agent stopped while its copy is made ready never starts; shutdown answers the setup card Not now, and starts nothing', async () => {
  const t = copies({ setup: 'npm ci', prefs: memoryPrefs({ setupOk: { [REPO.root]: sha('npm ci') } }) });
  const g = gate();
  t.git.fillGate = g;
  const a = t.engine.startAgent({ task: 'Fix the login redirect' });
  await until(() => t.calls.fillWorkspace.length === 1);
  const [v] = t.store.list();
  assert.equal((await t.engine.stop(v.id)).ok, true);
  g.open();
  const after = await a;
  assert.equal(after.state, 'stopped');
  assert.deepEqual(t.calls.order, ['fill'], 'neither its setup nor its runner');
  assert.equal(t.claude.runners.length, 0);
  // stopped while its setup command runs: the command is stopped too
  t.git.fillGate = null;
  t.git.setupGate = gate();
  const b = t.engine.startAgent({ task: 'Fix the cart' });
  await until(() => t.calls.runSetup.length === 1);
  const w = t.store.list().find(x => x.name === 'Fix cart');
  await t.engine.stop(w.id);
  assert.equal(t.calls.runSetup[0].signal.aborted, true);
  assert.equal((await b).state, 'stopped');
  assert.equal(t.claude.runners.length, 0);
  // the card is open when Workbench closes: nothing starts
  t.git.setupGate = null;
  t.git.setup = 'make setup';
  const c = t.engine.startAgent({ task: 'Fix the tax' });
  await setupCard(t);
  const kept = await t.engine.shutdown();
  const x = await c;
  assert.equal(x.state, 'stopped');
  assert.equal(x.stateReason, 'Workbench was closed');
  assert.equal(t.claude.runners.length, 0);
  assert.deepEqual(t.notices.filter(n => /^Started /.test(n)), [], 'none of them is said to have started');
  assert.equal(t.engine.snapshot().setup, undefined);
  assert.ok(Array.isArray(kept.kept));
});

test('a launch card is answered as soon as its agents are on the board; one that then cannot start says so', async () => {
  const t = copies();
  const g = gate();
  t.git.fillGate = g;
  t.claude = fakeAdapter('claude', { failStart: new Error('spawn claude ENOENT') });
  t.engine.adapters.claude = t.claude;
  t.deps.commands.intent = { kind: 'task', task: 'fix the login redirect' };
  const out = await t.engine.command('fix the login redirect');
  const yes = await t.engine.confirm(out.confirm.id, true);
  assert.equal(yes.reply, 'Started Fix login redirect.');
  assert.equal(t.calls.fillWorkspace.length, 1);
  assert.equal(t.claude.runners.length, 0, 'still copying');
  g.open();
  await until(() => t.store.get(yes.agentIds[0]).state === 'failed');
  await until(() => t.notices.some(n => n.startsWith('Fix login redirect could not start. It could not start:')));
  await t.engine.shutdown();
});

test('the demo copies nothing and runs no setup command, whatever workbench.json says', async () => {
  const store = new Store();
  const sim = new FakeSim();
  const { deps, calls } = fakeDeps({ fill: FILLED, setup: 'npm ci' });
  const engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim }, machines: new FakeMachines({ demo: true }), deps, prefs: memoryPrefs(), options: { tickMs: 10_000_000, simTickMs: 10_000_000 } });
  await engine.start();
  const v = await engine.startAgent({ task: 'Fix the login redirect' });
  assert.equal(sim.runners.at(-1).started, true);
  assert.deepEqual([calls.fillWorkspace.length, calls.envValues.length, calls.runSetup.length], [0, 0, 0]);
  assert.equal(engine.snapshot().setup, undefined);
  assert.equal(store.get(v.id).now, 'Starting');
  await engine.shutdown();
});

test('the real chain: an ignored .env lands in the agent’s copy with its value hidden, and the committed setup command runs there once said yes to', async (ctx) => {
  const t = await realGit(ctx);
  fs.writeFileSync(path.join(t.repo, '.gitignore'), '.env\n');
  const setup = 'printf "ran in %s\\n" "$(basename "$PWD")" > setup-ran.txt && test -n "$WORKBENCH_AGENT_ID" && test -d "$WORKBENCH_ROOT/.git"';
  fs.writeFileSync(path.join(t.repo, 'workbench.json'), JSON.stringify({ setup }));
  t.git('add', '-A');
  t.git('commit', '-q', '-m', 'Ignore .env, and set up each copy');
  const value = ['db', 'pass', 'Zq81mNw2Lk'].join('-');
  fs.writeFileSync(path.join(t.repo, '.env'), `DATABASE_PASSWORD=${value}\n`);
  t.deps.receipt.runSetup = receiptMod.runSetup; // the real one: sh in the agent's folder
  const launch = t.engine.startAgent({ task: 'Fix the login redirect' });
  const card = await until(() => t.engine.snapshot().setup, { timeout: 10_000 });
  assert.equal(card.command, setup);
  assert.deepEqual(await t.engine.confirm(card.id, true), { reply: SETUP_RAN });
  const v = await launch;
  assert.equal(fs.readFileSync(path.join(v.workspace, '.env'), 'utf8'), `DATABASE_PASSWORD=${value}\n`, 'the ignored .env is in its copy');
  assert.equal(fs.readFileSync(path.join(v.workspace, 'setup-ran.txt'), 'utf8'), `ran in ${path.basename(v.workspace)}\n`, 'the command ran in its copy');
  assert.equal(v.now, 'Its copy has your .env. The setup command ran in it.');
  assert.ok(t.notices.includes(COPIES_NOTICE));
  const runner = t.claude.runners.at(-1);
  assert.equal(runner.started, true);
  runner.emit({ kind: EV.SAYS, text: `The password is ${value}.` });
  assert.equal(t.store.get(v.id).says, 'The password is •••• w2Lk.');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ end of a turn

test('turn end with background tasks waits for helpers; helpers get their final state from their task', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-a71ea18c`;
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude', helperType: 'Explore' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Agent is running in the background.', backgroundTasks: 1, isError: false });
  await until(() => t.store.get(id).state === 'waiting_helpers');
  assert.equal(t.store.get(id).now, 'Waiting for 1 helper');
  runner.emit({ kind: EV.ENDED, agentId: helperId, outcome: 'ok' });
  assert.equal(t.store.get(helperId).state, 'finished', 'the engine finishes a helper whose task completed');
  assert.deepEqual(t.store.get(id).helpers, { total: 1, working: 0, done: 1 });
  await t.engine.shutdown();
});

test('turn end with an error fails the agent with a plain reason', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', isError: true, subtype: 'error_max_budget_usd' });
  await until(() => t.store.get(id).state === 'failed');
  assert.equal(t.store.get(id).stateReason, 'It reached its spending limit.');
  await t.engine.shutdown();
});

test('turn end with a closing question asks it; the answer goes to the runner', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I found two login routes.\n\nShould I remove the old one?', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'question');
  const v = t.store.get(id);
  assert.equal(v.ask.type, 'question');
  assert.equal(v.ask.sentence, 'Should I remove the old one?');
  assert.deepEqual(v.ask.options, []);
  assert.equal(v.says, 'I found two login routes.');
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Yes, remove it' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Sent your answer to Fix login redirect.');
  assert.deepEqual(runner.sent, ['Yes, remove it']);
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).state, 'working');
  assert.ok(t.notices.includes(r.reply), 'replies are also notices');
  await t.engine.shutdown();
});

test('a closing courtesy is not a question: the receipt is built and the agent is done', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }] } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the login redirect and added a test. Let me know if you need anything else.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_checked');
  const v = t.store.get(id);
  assert.equal(v.ask, null);
  assert.equal(v.files.changed, 1);
  assert.equal(v.checks.state, 'passed');
  assert.equal(v.says, 'I fixed the login redirect and added a test.');
  assert.equal(t.calls.diffStats.length, 1);
  assert.equal(t.calls.runChecks.length, 1);
  await t.engine.shutdown();
});

test('a real question records what changed and the rules, runs no checks, and clears checks of an earlier turn', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], rules: [{ say: 'Leave the payments folder alone', paths: ['payments/**'] }] } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_checked');
  await t.engine.answer(id, { answer: 'Please also handle refunds.' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  // The real ending of test/fixtures/claude-denied-bash.jsonl.
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I need your permission to run the Bash command. Would you like me to proceed with running `node test.mjs`?', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'question');
  const v = t.store.get(id);
  assert.equal(v.ask.sentence, 'Would you like me to proceed with running node test.mjs?', 'the whole sentence, not "mjs?"');
  assert.equal(v.files.changed, 1, 'what changed so far is on record');
  assert.equal(v.rules.kept[0].say, 'Leave the payments folder alone');
  assert.equal(v.checks, null, 'the earlier turn’s checks would sit beside newer files');
  assert.equal(t.calls.diffStats.length, 2);
  assert.equal(t.calls.runChecks.length, 1, 'no checks for half-done work');
  assert.equal(v.says, 'I need your permission to run the Bash command.');
  // An offer of more work stays a question, now with what changed beside it.
  await t.engine.answer(id, { askId: v.ask.id, answer: 'Yes' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the signup redirect. Would you like me to also add a test for the logout redirect?', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'question');
  assert.equal(t.store.get(id).ask.sentence, 'Would you like me to also add a test for the logout redirect?');
  assert.equal(t.store.get(id).files.changed, 1);
  assert.equal(t.calls.runChecks.length, 1);
  await t.engine.shutdown();
});

test('a question is asked even when what changed cannot be read', async () => {
  const t = live();
  t.deps.workspace.diffStats = async () => { throw new Error('git broke'); };
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Which database should I use: Postgres or SQLite?', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'question');
  assert.equal(t.store.get(id).ask.sentence, 'Which database should I use: Postgres or SQLite?');
  assert.equal(t.store.get(id).stateReason, null);
  await t.engine.shutdown();
});

test('while the engine records what changed before a question, a clean exit does not fail the agent', async () => {
  const g = gate();
  const t = live({ options: { exitGraceMs: 5 } });
  const diffStats = t.deps.workspace.diffStats;
  t.deps.workspace.diffStats = async (o) => { await g.wait; return diffStats(o); };
  const { id, runner } = await started(t, { task: 'Write tests for the parser', harness: 'codex' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I wrote the tests. Should I also cover the error paths?', backgroundTasks: 0, isError: false });
  runner.alive = false;
  runner.emit({ kind: EV.ENDED, outcome: 'ok' }); // Codex exits after every turn
  await new Promise(r => setTimeout(r, 40));
  assert.notEqual(t.store.get(id).state, 'failed');
  g.open();
  await until(() => t.store.get(id).state === 'question');
  await t.engine.shutdown();
});

test('receipt: all checks passed is done_checked, with files, rules, running checks and says', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], rules: [{ say: 'Leave the payments folder alone', paths: ['payments/**'] }] } });
  const { id, runner } = await started(t);
  const checkStates = [];
  t.store.on('agents', ids => { if (ids.includes(id)) checkStates.push(t.store.get(id).checks?.state ?? null); });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: '**Fixed** the redirect after login. All tests pass.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_checked');
  const v = t.store.get(id);
  assert.equal(v.files.changed, 1);
  assert.equal(v.rules.kept[0].say, 'Leave the payments folder alone');
  assert.equal(v.checks.state, 'passed');
  assert.deepEqual(v.checks.results.map(r => [r.name, r.ok]), [['unit tests', true]]);
  assert.equal(v.says, 'Fixed the redirect after login.');
  assert.ok(checkStates.includes('running'), 'checks show as running first');
  assert.deepEqual(t.calls.diffStats[0], { path: v.workspace, base: FAKE_BASE });
  assert.deepEqual(t.calls.checkRules[0].paths, ['src/cart.js']);
  assert.equal(t.calls.runChecks[0].cwd, v.workspace);
  await t.engine.shutdown();
});

test('receipt: a failed check is checks_failed; no checks is done_claimed', async () => {
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checkState: 'failed' } });
  const a = await started(t);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'checks_failed');
  assert.equal(t.store.get(a.id).stateReason, 'The check “unit tests” did not pass.');
  assert.equal(t.store.get(a.id).checks.results[0].tail, 'expected 3, got 4');
  await t.engine.shutdown();

  const u = live();
  const b = await started(u);
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I updated the README.', backgroundTasks: 0, isError: false });
  await until(() => u.store.get(b.id).state === 'done_claimed');
  assert.equal(u.store.get(b.id).checks, null);
  assert.equal(u.store.get(b.id).says, 'I updated the README.');
  await u.engine.shutdown();
});

test('receipt: the checks run with the agent’s own WORKBENCH_AGENT_ID, as its shell does, so a Workbench started from them refuses', async (ctx) => {
  // What the engine hands the checks: Workbench's own environment, which never has the marker, plus this agent's.
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }] } });
  const a = await doneAgent(t);
  assert.equal(t.calls.runChecks[0].env?.WORKBENCH_AGENT_ID, a.id);
  await t.engine.shutdown();
  // What a check really sees: the real checks, a shell in the agent's folder.
  const u = liveFolders(ctx, { deps: { checks: [{ name: 'marker', run: 'echo "agent id in check: ${WORKBENCH_AGENT_ID-unset}"', timeoutSec: 20 }] } });
  u.engine.deps.receipt = receiptMod;
  const b = await doneAgent(u);
  assert.equal(u.store.get(b.id).state, 'done_checked', u.store.get(b.id).stateReason);
  assert.equal(u.store.get(b.id).checks.results[0].tail, `agent id in check: ${b.id}`);
  await u.engine.shutdown();
});

test('a receipt that is overtaken by a new turn is cancelled and dropped', async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1);
  const { signal } = t.calls.runChecks[0];
  assert.equal(signal.aborted, false);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  assert.equal(signal.aborted, true, 'the old turn’s checks are stopped');
  assert.deepEqual(t.store.get(id).checks, { state: 'none', results: [] }, 'and no longer said to be running');
  checksGate.open();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(t.store.get(id).state, 'working', 'no done state from the old turn');
  assert.deepEqual(t.store.get(id).checks, { state: 'none', results: [] }, 'the old result was not applied');
  await t.engine.shutdown();
});

test('receipt: stopping an agent while its checks run ends them, and the card stops saying "checks running"', async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).checks?.state === 'running');
  const { signal } = t.calls.runChecks[0];
  assert.ok(signal instanceof AbortSignal, 'the checks get a way to be stopped');
  await t.engine.stop(id);
  assert.equal(signal.aborted, true);
  assert.equal(t.store.get(id).state, 'stopped');
  assert.deepEqual(t.store.get(id).checks, { state: 'none', results: [] });
  checksGate.open();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(t.store.get(id).state, 'stopped');
  assert.deepEqual(t.store.get(id).checks, { state: 'none', results: [] });
  await t.engine.shutdown();
});

test('receipt: a message the agent takes while its checks run stops them at once; one it cannot take leaves them be', async () => {
  const gates = [gate(), gate()];
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGates: gates } });
  const finish = async (task) => {
    const a = await started(t, { task });
    a.runner.emit({ kind: EV.TURN, phase: 'start' });
    a.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
    a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
    await until(() => t.store.get(a.id).checks?.state === 'running');
    return a;
  };
  // A message the agent cannot take changes nothing: its checks go on and decide the turn.
  const a = await finish('Fix the cart total');
  a.runner.send = async () => { throw new Error('The pipe is closed.'); };
  assert.equal((await t.engine.say(a.id, 'Also fix the tax.')).ok, false);
  assert.equal(t.calls.runChecks[0].signal.aborted, false);
  gates[0].open();
  await until(() => t.store.get(a.id).state === 'done_checked');
  // One it takes stops them at once, before its next turn has even started.
  const b = await finish('Fix the cart tax');
  assert.equal((await t.engine.say(b.id, 'Also round the tax.')).ok, true);
  assert.equal(t.calls.runChecks[1].signal.aborted, true);
  assert.deepEqual(t.store.get(b.id).checks, { state: 'none', results: [] });
  gates[1].open();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(t.store.get(b.id).state, 'working', 'no done state for the folder as it was');
  await t.engine.shutdown();
});

test("receipt: a follow-up after a stop cannot bring back the stopped turn's receipt", async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  // A runChecks that ignores its signal, as a stubborn check would until its SIGKILL: the result comes in late.
  const run = t.deps.receipt.runChecks;
  t.deps.receipt.runChecks = async (o) => { const r = await run({ ...o, signal: undefined }); return r; };
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).checks?.state === 'running');
  await t.engine.stop(id);
  assert.equal((await t.engine.say(id, 'Please also fix the tax.')).ok, true);
  assert.equal(t.store.get(id).state, 'working');
  checksGate.open();
  await new Promise(r => setTimeout(r, 30));
  const v = t.store.get(id);
  assert.equal(v.state, 'working', 'the old turn does not come back as done');
  assert.notEqual(v.says, 'I fixed the cart.');
  await t.engine.shutdown();
});

test('receipt: one set of checks at a time; a newer receipt keeps the agent out of the stuck check', async () => {
  const gates = [gate(), gate()];
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGates: gates }, options: { stuckSilenceMs: 1000 } });
  let running = 0;
  let most = 0;
  const run = t.deps.receipt.runChecks;
  // Like the real checks, a stopped set takes a moment to end after its signal.
  t.deps.receipt.runChecks = async (o) => {
    running += 1;
    most = Math.max(most, running);
    try { return await run(o); } finally { await new Promise(r => setTimeout(r, 40)); running -= 1; }
  };
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1);
  // A follow-up while the checks run: a new turn in the same folder.
  await t.engine.say(id, 'Please also fix the tax.');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the tax too.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 2, { timeout: 3000 });
  assert.equal(most, 1, 'the second set started only after the first had ended');
  gates[0].open();
  t.engine.tick(Date.now() + 60_000);
  assert.equal(t.store.get(id).state, 'working', 'not flagged as stuck during its own checks');
  assert.equal(t.store.get(id).checks.state, 'running');
  gates[1].open();
  await until(() => t.store.get(id).state === 'done_checked');
  assert.equal(t.store.get(id).says, 'I fixed the tax too.');
  await t.engine.shutdown();
});

test('shutdown ends running checks and waits for them; killAllSync ends them at once', async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  let ended = false;
  const run = t.deps.receipt.runChecks;
  t.deps.receipt.runChecks = async (o) => { try { return await run(o); } finally { await new Promise(r => setTimeout(r, 40)); ended = true; } };
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).checks?.state === 'running');
  const { signal } = t.calls.runChecks[0];
  t.engine.killAllSync();
  assert.equal(t.calls.killChecksSync, 1, 'every check process group is killed, synchronously');
  assert.equal(signal.aborted, true);
  await t.engine.shutdown();
  assert.equal(ended, true, 'shutdown waited for the checks to end');
  assert.deepEqual(t.store.get(id).checks, { state: 'none', results: [] });
  assert.equal(t.store.get(id).state, 'stopped');
});

test('an agent that could not start has its unchanged folder and branch removed', async () => {
  const t = live({ adapters: { claude: fakeAdapter('claude', { failStart: new Error('spawn claude ENOENT') }) } });
  const v = await t.engine.startAgent({ task: 'Fix the login' });
  assert.equal(v.state, 'failed');
  assert.deepEqual(t.calls.removeWorkspace, [{ repoRoot: REPO.root, path: v.workspace, base: FAKE_BASE, onlyIfUnchanged: true, deleteBranch: true, copied: [] }]);
  const { kept } = await t.engine.shutdown();
  assert.equal(t.calls.removeWorkspace.length, 1, 'not asked again at shutdown');
  assert.deepEqual(kept, []);
});

test('shutdown asks to remove each agent folder only if it is unchanged, after its agent has stopped, and says which it kept', async () => {
  const t = live();
  const a = await started(t);
  const b = await started(t, { task: 'Fix the cart total' });
  const stopsAtRemove = [];
  const remove = t.deps.workspace.removeWorkspace;
  t.deps.workspace.removeWorkspace = async (o) => {
    stopsAtRemove.push(a.runner.stopCalls + b.runner.stopCalls);
    const out = await remove(o);
    return o.path === t.store.get(a.id).workspace ? out : { removed: false, kept: true }; // b changed files
  };
  // At any moment (a forced exit cannot wait for shutdown), every folder still on disk.
  assert.deepEqual(t.engine.keptFolders().map(k => k.id).sort(), [a.id, b.id].sort());
  const { kept } = await t.engine.shutdown();
  assert.deepEqual(t.engine.keptFolders(), kept);
  assert.deepEqual(t.calls.removeWorkspace.map(o => [o.path, o.onlyIfUnchanged, o.deleteBranch, o.base]).sort(), [
    [t.store.get(a.id).workspace, true, true, FAKE_BASE],
    [t.store.get(b.id).workspace, true, true, FAKE_BASE],
  ].sort());
  assert.deepEqual(stopsAtRemove, [2, 2], 'only once both agents have stopped');
  assert.deepEqual(kept, [{ id: b.id, name: 'Fix cart total', path: t.store.get(b.id).workspace, branch: `workbench/fix-cart-total-${b.id}` }]);
});

/** A live engine whose createWorkspace waits for `made` to open; `ws` is what it made. */
function slowFolders(opts) {
  const t = live(opts);
  const made = gate();
  const create = t.deps.workspace.createWorkspace;
  t.creating = 0;
  t.deps.workspace.createWorkspace = async (o) => {
    t.creating += 1;
    await made.wait;
    return (t.ws = await create(o));
  };
  t.made = made;
  return t;
}

test('a launch still making its folder when Workbench closes starts no agent, and its folder and branch go again', async () => {
  const t = slowFolders();
  const launch = t.engine.startAgent({ task: 'Fix the thing' });
  const refused = assert.rejects(launch, { message: 'Workbench is shutting down.' });
  await until(() => t.creating === 1);
  const closing = t.engine.shutdown();
  assert.equal(await settled(closing), false, 'shutdown waits for the launch under way');
  t.made.open();
  const { kept } = await closing;
  await refused;
  assert.equal(t.claude.runners.length, 0, 'no agent was started');
  assert.deepEqual(t.store.list(), []);
  assert.deepEqual(t.calls.removeWorkspace, [{ repoRoot: REPO.root, path: t.ws.path, base: FAKE_BASE, onlyIfUnchanged: true, deleteBranch: true, copied: [] }]);
  assert.deepEqual(kept, []);
  assert.deepEqual(t.engine.keptFolders(), []);
});

test('a launch whose process is starting when Workbench closes is stopped with the others', async () => {
  const t = live();
  const go = gate();
  const createRunner = t.claude.createRunner;
  t.claude.createRunner = (o) => {
    const r = createRunner(o);
    const start = r.start.bind(r);
    r.start = async () => { await go.wait; return start(); };
    return r;
  };
  const launch = t.engine.startAgent({ task: 'Fix the thing' });
  await until(() => t.claude.runners.length === 1);
  const closing = t.engine.shutdown();
  assert.equal(await settled(closing), false, 'shutdown waits for the process to start');
  go.open();
  const v = await launch;
  await closing;
  assert.equal(t.claude.runners[0].stopCalls, 1);
  assert.equal(t.store.get(v.id).state, 'stopped');
  assert.equal(t.calls.removeWorkspace.length, 1, 'its unchanged folder goes too');
});

test('a folder made too late that cannot be removed is listed with the folders that stay', async () => {
  const t = slowFolders();
  t.deps.workspace.removeWorkspace = async (o) => { t.calls.removeWorkspace.push(o); return { removed: false, kept: true }; };
  const launch = t.engine.startAgent({ task: 'Fix the thing', name: 'Late one' });
  const refused = assert.rejects(launch, { message: 'Workbench is shutting down.' });
  await until(() => t.creating === 1);
  const closing = t.engine.shutdown();
  t.made.open();
  const { kept } = await closing;
  await refused;
  const id = t.calls.createWorkspace[0].agentId;
  assert.deepEqual(kept, [{ id, name: 'Late one', path: t.ws.path, branch: t.ws.branch }]);
  assert.deepEqual(t.engine.keptFolders(), kept);
});

test('shutdown waits for a launch that never finishes only as long as for a runner to stop', async () => {
  const t = live({ options: { stopTimeoutMs: 60 } });
  t.deps.workspace.createWorkspace = () => new Promise(() => {});
  t.engine.startAgent({ task: 'Fix the thing' }).catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  const at = Date.now();
  const { kept } = await t.engine.shutdown();
  assert.ok(Date.now() - at < 1000, 'shutdown went on without it');
  assert.deepEqual(kept, []);
});

test('a clean exit in the middle of a turn becomes failed; after a finished turn it does not', async () => {
  const t = live();
  const a = await started(t);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Reading a.js', toolKind: 'read', toolUseId: 'x' });
  a.runner.alive = false;
  a.runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(a.id).state === 'failed');
  assert.equal(t.store.get(a.id).stateReason, 'It stopped before finishing its work.');

  const b = await started(t, { task: 'Write tests for the parser', harness: 'codex' });
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I added three tests.', backgroundTasks: 0, isError: false });
  b.runner.alive = false;
  b.runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(b.id).state === 'done_claimed');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(t.store.get(b.id).state, 'done_claimed');
  await t.engine.shutdown();
});

test('a hint sent during a turn that then fails is worked on: the root resumes on its next turn and gets a receipt', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Reading cart.js', toolKind: 'read', toolUseId: 'r1' });
  assert.equal(t.store.get(id).state, 'working');
  const said = await t.engine.say(id, 'Also keep the old API');
  assert.equal(said.ok, true);
  assert.deepEqual(runner.sent, ['Also keep the old API']);
  runner.emit({ kind: EV.ENDED, outcome: 'error', error: 'API Error: 529 overloaded' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'API Error: 529 overloaded', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(id).state === 'failed');
  // The harness now runs the waiting message as its next turn (the Codex runner always does).
  runner.emit({ kind: EV.TURN, phase: 'start' });
  const v = t.store.get(id);
  assert.equal(v.state, 'working');
  assert.equal(v.now, 'Working on your message');
  assert.equal(v.error, null, 'the failed turn’s error is no longer shown');
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart and kept the old API.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_claimed');
  assert.equal(t.calls.diffStats.length, 1, 'the receipt was built');
  assert.equal(t.store.get(id).says, 'I fixed the cart and kept the old API.');
  await t.engine.shutdown();
});

test('a failed root that took up its next turn by itself can be stopped', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Codex lost its connection.', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(id).state === 'failed');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  t.deps.commands.intent = { kind: 'stop_all' };
  assert.equal((await t.engine.command('stop everything')).reply, 'Stopped Fix login redirect.');
  assert.equal(runner.stopCalls, 1);
  assert.equal(t.store.get(id).state, 'stopped');
  await t.engine.shutdown();
});

test('"Try again" on a failed root and "Continue" on a stopped one resume it, and the next turn ends with a receipt', async () => {
  const t = live();
  const a = await started(t);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'API Error: 529 overloaded', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(a.id).state === 'failed');
  assert.equal((await t.engine.say(a.id, 'Please try again.')).ok, true);
  assert.equal(t.store.get(a.id).state, 'working');
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed it.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'done_claimed');

  const b = await started(t, { task: 'Fix the cart total' });
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  await t.engine.stop(b.id);
  assert.equal((await t.engine.say(b.id, 'Please continue where you left off.')).ok, true);
  assert.equal(t.store.get(b.id).state, 'working');
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the total.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(b.id).state === 'done_claimed');
  assert.equal(t.calls.diffStats.length, 2);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ permissions

test('hook: allowed and denied requests are answered at once and counted', async () => {
  const t = live();
  const { id } = await started(t);
  const allow = await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: { file_path: 'src/a.js' } });
  assert.deepEqual(allow, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Reading is fine.' } });
  const deny = await t.engine.hookPreToolUse(id, { tool_name: 'Forbidden', tool_input: {} });
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(t.store.get(id).approvals, { auto: 1, byYou: 0, denied: 1 });
  assert.equal(t.calls.decide[0].cwd, t.store.get(id).workspace, 'policy sees the workspace, not the payload cwd');
  assert.deepEqual(t.calls.decide[0].extraAllow, []);
  const unknown = await t.engine.hookPreToolUse('nobody', { tool_name: 'Read', tool_input: {} });
  assert.equal(unknown.hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.shutdown();
});

test('hook: an ask is held until the person allows it', async () => {
  const t = live({ deps: { allow: ['make deploy'] } });
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(await settled(pending), false, 'the response is held');
  const v = t.store.get(id);
  assert.equal(v.state, 'needs_ok');
  assert.equal(v.ask.type, 'permission');
  assert.equal(v.ask.sentence, 'Fix login redirect wants to run a command');
  assert.equal(v.ask.detail, 'rm -rf build');
  assert.deepEqual(v.ask.options, ['Allow', 'Deny']);
  assert.equal(v.ask.primary, 'Allow');
  assert.deepEqual(t.calls.decide[0].extraAllow, ['make deploy'], 'workbench.json allow list goes to the policy');
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Allow' });
  assert.equal(r.reply, 'OK, Fix login redirect can go ahead.');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  assert.deepEqual(t.store.get(id).approvals, { auto: 0, byYou: 1, denied: 0 });
  await t.engine.shutdown();
});

test('hook: a permission takes only Allow or Deny from its buttons; words reach it through a command', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, rootPayload);
  await until(() => t.store.get(id).ask);
  const askId = t.store.get(id).ask.id;
  // Another ask's buttons ("Keep it working", "Stop it"), a typed "yes", or free text: refused, and the request waits.
  for (const answer of ['no, use the staging folder', 'Yes', 'OK', 'go ahead', 'Keep it working', 'Stop it', '', null]) {
    assert.deepEqual(await t.engine.answer(id, { askId, answer }), { ok: false, reply: 'Choose Allow or Deny.' }, String(answer));
  }
  assert.equal(await settled(pending), false, 'still held');
  assert.equal(t.store.get(id).state, 'needs_ok');
  // Free text never allows: typed for the ask on screen, a no with words denies and passes them on.
  const r = await t.engine.command('no, use the staging folder', { focusId: id, askId });
  assert.equal(r.reply, 'OK, Fix login redirect will not do that. I passed on your words.');
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The person said no, and added: use the staging folder');
  assert.equal(t.store.get(id).approvals.denied, 1);
  await t.engine.shutdown();
});

test('answer: the ask id must be the ask on screen or a held request; there is no "whatever shows now"', async () => {
  const t = live();
  const { id } = await started(t);
  const acA = new AbortController();
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }, { signal: acA.signal });
  await until(() => t.store.get(id).ask);
  const { id: askA, sentence } = t.store.get(id).ask;
  // No id, or one that names nothing: nothing is answered.
  assert.deepEqual(await t.engine.answer(id, { answer: 'Allow' }), { ok: false, reply: 'Have a look at what Fix login redirect is asking first.' });
  assert.deepEqual(await t.engine.answer(id, { askId: 'ok-00000000', answer: 'Allow' }), { ok: false, reply: 'Fix login redirect is asking something else now. Have a look, then answer again.' });
  assert.equal(await settled(a), false);
  // A's bridge goes away and B arrives, with the same sentence. A's Allow, clicked a moment late, is refused.
  acA.abort();
  assert.equal((await a).hookSpecificOutput.permissionDecision, 'deny');
  const b = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  await until(() => t.store.get(id).ask?.detail === 'git push --force origin main');
  const askB = t.store.get(id).ask.id;
  assert.equal(t.store.get(id).ask.sentence, sentence, 'both read the same');
  assert.deepEqual(await t.engine.answer(id, { askId: askA, answer: 'Allow' }), { ok: false, reply: 'Fix login redirect is asking something else now. Have a look, then answer again.' });
  assert.equal(await settled(b), false, 'B was not allowed by a click meant for A');
  assert.deepEqual(await t.engine.answer(id, { askId: askB, answer: 'Allow' }), { ok: true, reply: 'OK, Fix login redirect can go ahead.' });
  assert.equal((await b).hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(await t.engine.answer(id, { askId: askB, answer: 'Allow' }), { ok: false, reply: 'Fix login redirect is not waiting for that any more.' });
  await t.engine.shutdown();
});

test('hook: no answer in time counts as a deny with the contract reason', async () => {
  const t = live({ options: { permissionTimeoutMs: 40 } });
  const { id } = await started(t);
  const out = await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'make deploy' } });
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'No answer from the person in time' });
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).approvals.denied, 1);
  assert.ok(t.notices.some(n => /waited .* for your OK, so I said no/.test(n)));
  await t.engine.shutdown();
});

test('hook: a helper’s request is asked on the helper', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.STATE, state: 'waiting_helpers' });
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).state === 'needs_ok');
  assert.equal(t.store.get(helperId).ask.sentence, 'List repository files wants to run a command');
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'the root is not the one asking');
  await t.engine.answer(helperId, { askId: t.store.get(helperId).ask.id, answer: 'Deny' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(helperId).state, 'working');
  await t.engine.shutdown();
});

test('hook: a request from a helper not shown yet falls back to the root, which goes back to waiting', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Asking a helper to look around', toolKind: 'helper', toolUseId: 'a1' });
  runner.emit({ kind: EV.STATE, state: 'waiting_helpers', backgroundTasks: 1 });
  const pending = t.engine.hookPreToolUse(id, { ...subagentPayload, agent_id: 'ffffffff00000000' });
  await until(() => t.store.get(id).state === 'needs_ok');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'waiting_helpers');
  await t.engine.shutdown();
});

test('hook: several requests from one agent are shown one at a time', async () => {
  const t = live();
  const { id } = await started(t);
  const first = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  await until(() => t.store.get(id).ask);
  const second = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.store.get(id).ask.detail, 'rm a');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' });
  assert.equal((await first).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).ask.detail, 'rm b', 'the next request shows');
  assert.equal(t.store.get(id).state, 'needs_ok');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await second).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(id).state, 'working');
  await t.engine.shutdown();
});

test('hook: an aborted request is dropped; shutdown denies whatever is still held', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const ac = new AbortController();
  const aborted = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } }, { signal: ac.signal });
  await until(() => t.store.get(id).ask);
  ac.abort();
  assert.equal((await aborted).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.store.get(id).ask, null);

  const held = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  await until(() => t.store.get(id).ask);
  await t.engine.shutdown();
  const out = await held;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'Workbench is shutting down.');
  assert.equal(runner.stopCalls, 1, 'shutdown stops every runner');
  assert.equal(t.store.get(id).state, 'stopped');
  const late = await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: {} });
  assert.equal(late.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: each Claude agent gets its own token; a Codex agent gets none', async () => {
  const t = live();
  const a = await started(t);
  const b = await started(t, { task: 'Update the docs' });
  const c = await started(t, { task: 'Explain the repo', harness: 'codex' });
  assert.equal(a.runner.opts.hook.token, `tok-${a.id}`);
  assert.equal(b.runner.opts.hook.token, `tok-${b.id}`);
  assert.notEqual(a.runner.opts.hook.token, b.runner.opts.hook.token);
  assert.equal(c.runner.opts.hook, null, 'Codex has no hook, so it gets no token');
  await t.engine.shutdown();
});

test('hook: without a way to make tokens, a Claude agent gets none (and Claude Code then refuses to start)', async () => {
  const t = live();
  t.engine.hook = { url: HOOK.url };
  const { runner } = await started(t);
  assert.equal(runner.opts.hook.token, null);
  t.engine.hook = { url: HOOK.url, tokenFor: () => { throw new Error('boom'); } };
  const second = await started(t, { task: 'Update the docs' });
  assert.equal(second.runner.opts.hook.token, null);
  await t.engine.shutdown();
});

test('hook: a request naming a Codex agent or a simulated one is refused and shows nothing', async () => {
  const t = live();
  const { id } = await started(t, { task: 'Explain the repo', harness: 'codex' });
  const before = t.store.get(id);
  const out = await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'curl https://example.com/x.sh' } });
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Workbench does not know this agent, so it said no.' });
  const after = t.store.get(id);
  assert.equal(after.ask, null);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.approvals, before.approvals);
  assert.equal(t.calls.decide.length, 0, 'the policy is not even asked');
  await t.engine.shutdown();

  const d = demo();
  const v = await d.engine.startAgent({ task: 'Fix the login redirect' });
  assert.equal(d.sim.runners[0].opts.hook, null, 'a simulated agent has no hook');
  const sim = await d.engine.hookPreToolUse(v.id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  assert.equal(sim.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(d.store.get(v.id).ask, null);
  assert.equal(d.calls.decide.length, 0);
  await d.engine.shutdown();
});

test('hook: the policy gets the agent’s own folders from its runner, never the payload’s session', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const own = '0bdffedf-c0cd-41ae-8bb3-6183f7e1be41';
  runner.readAlso = () => [{ root: '/home/me/.claude/projects', session: own }, { root: '/private/tmp/claude-501', session: own }];
  await t.engine.hookPreToolUse(id, { ...rootPayload, session_id: '11111111-2222-3333-4444-555555555555', transcript_path: '/elsewhere/x.jsonl', tool_name: 'Read', tool_input: { file_path: 'a.js' } });
  assert.deepEqual(t.calls.decide.at(-1).readAlso, [{ root: '/home/me/.claude/projects', session: own }, { root: '/private/tmp/claude-501', session: own }]);
  // A runner that names no folders, or fails to, gives the policy none.
  delete runner.readAlso;
  await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
  assert.deepEqual(t.calls.decide.at(-1).readAlso, []);
  runner.readAlso = () => { throw new Error('boom'); };
  await t.engine.hookPreToolUse(id, { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
  assert.deepEqual(t.calls.decide.at(-1).readAlso, []);
  await t.engine.shutdown();
});

test('hook: SendMessage may reach the main agent and this agent’s own helpers, as its output named them', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-a71ea18c`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.recipients = () => [helperId, 'a71ea18c16a7bba8d', 'api-worker'];
  const other = await started(t, { task: 'Update the docs' });
  other.runner.emit({ kind: EV.CREATED, agentId: `${other.id}-deadbeef`, parentId: other.id, name: 'Other helper', harness: 'claude' });
  // The payload's own idea of helpers never counts: only what the runner read from Claude Code's output.
  await t.engine.hookPreToolUse(id, { ...subagentPayload, tool_name: 'SendMessage', tool_input: { to: 'a71ea18c16a7bba8d', message: 'go on' }, agent_id: undefined });
  const req = t.calls.decide.at(-1);
  assert.equal(req.tool, 'SendMessage');
  assert.deepEqual(req.recipients.sort(), ['a71ea18c16a7bba8d', 'api-worker', helperId, 'main'].sort());
  assert.ok(!req.recipients.includes(`${other.id}-deadbeef`), 'another agent’s helpers are not this agent’s');
  await t.engine.shutdown();
});

test('hook: a held ask carries the policy’s reason, so the page can say why it asks', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);
  assert.equal(t.store.get(id).ask.why, 'Needs a person.');
  assert.equal(t.store.get(id).ask.detail, 'rm -rf build');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  await pending;
  // A policy that gives no reason leaves the field out.
  t.deps.policy.decide = () => ({ decision: 'ask', reason: '', sentence: 'wants to run a command', detail: 'make deploy' });
  const second = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'make deploy' } });
  await until(() => t.store.get(id).ask);
  assert.equal('why' in t.store.get(id).ask, false);
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  await second;
  await t.engine.shutdown();
});

/** A root with one helper, in the given state; returns the helper's id. */
function helperIn(t, id, runner, state) {
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  if (state !== 'working') runner.emit({ kind: EV.STATE, agentId: helperId, state });
  return helperId;
}

test('hook: a request from a helper that has ended is refused and does not bring the helper back', async () => {
  for (const state of ['finished', 'failed', 'stopped']) {
    const t = live();
    const { id, runner } = await started(t);
    const helperId = helperIn(t, id, runner, state);
    const before = t.store.get(id).helpers;
    const out = await t.engine.hookPreToolUse(id, subagentPayload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', state);
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The helper is no longer running.');
    assert.equal(t.store.get(helperId).state, state, 'the helper stays as it was');
    assert.equal(t.store.get(helperId).ask, null);
    assert.equal(t.store.get(helperId).endedAt != null, true);
    assert.deepEqual(t.store.get(id).helpers, before);
    assert.equal(t.engine.held.size, 0);
    // What the rules allow on their own still goes through, and changes nothing either.
    const read = await t.engine.hookPreToolUse(id, { ...subagentPayload, tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    assert.equal(read.hookSpecificOutput.permissionDecision, 'allow');
    assert.equal(t.store.get(helperId).state, state);
    await t.engine.shutdown();
  }
});

test('hook: a helper that ends while its request is being checked is not asked about', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = helperIn(t, id, runner, 'working');
  const g = gate();
  const decide = t.deps.policy.decide;
  let checking = false;
  t.deps.policy.decide = async (req) => { checking = true; await g.wait; return decide(req); };
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => checking); // the helper was found working, and its request is being checked
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'finished' });
  runner.emit({ kind: EV.ENDED, agentId: helperId, outcome: 'ok' });
  g.open();
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The helper is no longer running.');
  assert.equal(t.store.get(helperId).state, 'finished');
  assert.equal(t.store.get(helperId).ask, null);
  await t.engine.shutdown();
});

test('hook: a request that arrives after the agent’s process has gone is refused, and the agent stays failed', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.alive = false;
  runner.emit({ kind: EV.ENDED, outcome: 'error', error: 'exit 1' });
  runner.emit({ kind: EV.STATE, state: 'failed', reason: 'Claude Code stopped with an error (exit code 1).' });
  const out = await t.engine.hookPreToolUse(id, rootPayload);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'This agent is no longer running.');
  assert.equal(t.store.get(id).state, 'failed');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.calls.decide.length, 0);
  await t.engine.shutdown();
});

test('hook: a helper the person stopped gets no tools, not even the ones the rules allow', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = helperIn(t, id, runner, 'working');
  runner.send = async () => { throw new Error('Fix login redirect is not taking messages right now.'); };
  await t.engine.stop(helperId); // the root could not be told, so the engine stops the helper itself
  assert.equal(t.store.get(helperId).state, 'stopped');
  for (const payload of [{ ...subagentPayload, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, subagentPayload]) {
    const out = await t.engine.hookPreToolUse(id, payload);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The person stopped this helper.');
  }
  assert.equal(t.store.get(helperId).state, 'stopped');
  assert.equal(t.store.get(helperId).approvals.auto, 0);
  await t.engine.shutdown();
});

test('stop: a live helper is stopped through its agent; its held request is refused at once, and so is every later tool', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t);
  const helperId = helperIn(t, id, runner, 'working');
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).ask);
  // "stop it" with the helper's request on screen: the page sends the asker as the focus.
  const r = await t.engine.command('stop it', { focusId: helperId, askId: t.store.get(helperId).ask.id });
  assert.deepEqual(r, { reply: 'I asked Fix login redirect to stop its helper List repository files.', focusId: helperId });
  assert.deepEqual(runner.sent, ['Please stop your helper “List repository files” now, because it may be stuck, and carry on without it.']);
  // Its agent can act on that only once the helper moves on, so the held request does not keep them waiting.
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The person stopped this helper.');
  assert.equal(t.store.get(helperId).ask, null);
  assert.equal(t.store.get(helperId).state, 'working', 'it runs on inside its agent until it ends');
  assert.equal(runner.stopCalls, 0);
  // Nothing more is asked for it, and no tool runs, not even one the rules allow: refused at once, unchecked.
  const checked = t.calls.decide.length;
  for (const payload of [{ ...subagentPayload, tool_name: 'Read', tool_input: { file_path: 'a.js' } }, subagentPayload]) {
    const later = await t.engine.hookPreToolUse(id, payload);
    assert.equal(later.hookSpecificOutput.permissionDecision, 'deny', payload.tool_name);
    assert.equal(later.hookSpecificOutput.permissionDecisionReason, 'The person stopped this helper.');
  }
  assert.equal(t.calls.decide.length, checked);
  assert.equal(t.store.get(helperId).ask, null);
  assert.equal(t.engine.held.size, 0);
  // Its events still count, and its agent still asks for its own steps.
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'finished' });
  assert.equal(t.store.get(helperId).state, 'finished');
  const own = t.engine.hookPreToolUse(id, rootPayload);
  await until(() => t.store.get(id).ask);
  assert.equal(t.store.get(id).ask.detail, 'node test.mjs');
  await t.engine.shutdown();
  assert.equal((await own).hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: a helper the person stops while its request is being checked is not asked about', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = helperIn(t, id, runner, 'working');
  const g = gate();
  const decide = t.deps.policy.decide;
  let checking = false;
  t.deps.policy.decide = async (req) => { checking = true; await g.wait; return decide(req); };
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => checking);
  await t.engine.stop(helperId); // its agent is asked to stop it
  g.open();
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The person stopped this helper.');
  assert.equal(t.store.get(helperId).ask, null);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ held requests never leave the view

/** Every held request shows on its agent (in needs_ok), or waits behind one of that agent's that shows. */
function assertHeldVisible(t, step) {
  for (const h of t.engine.held.values()) {
    const v = t.store.get(h.agentId);
    const shown = v?.ask ? t.engine.held.get(v.ask.id) : null;
    assert.ok(v && v.state === 'needs_ok' && shown && shown.agentId === h.agentId,
      `${step}: a held request is not showing (${v?.state}, ${v?.ask?.type ?? 'no ask'})`);
  }
}

/** A root showing, in its own name, the request of a helper the engine cannot name. */
async function rootHoldsForUnknownHelper(t, { inTurn = false } = {}) {
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  if (!inTurn) {
    runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'A helper is looking.', backgroundTasks: 1, isError: false });
    await until(() => t.store.get(id).state === 'waiting_helpers');
  }
  const pending = t.engine.hookPreToolUse(id, { ...subagentPayload, agent_id: 'ffffffff00000000' });
  await until(() => t.store.get(id).state === 'needs_ok');
  return { id, runner, pending, ask: t.store.get(id).ask };
}

test('hook: a request shown on the root stays shown when a turn ends while helpers run', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Still waiting for the helper.', backgroundTasks: 1, isError: false });
  const v = t.store.get(id);
  assert.equal(v.state, 'needs_ok');
  assert.equal(v.ask.id, ask.id);
  assert.equal(v.ask.createdAt, ask.createdAt, 'the same ask, not a new one');
  assert.equal(await settled(pending), false);
  await t.engine.answer(id, { askId: ask.id, answer: 'Allow' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'then it waits on its helpers, as the turn decided');
  assert.equal(t.store.get(id).now, 'Waiting for 1 helper');
  await t.engine.shutdown();
});

test('hook: a turn that ends with a question while a request shows asks it after the answer', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I found two configs. Which one should I change?', backgroundTasks: 0, isError: false });
  await until(() => t.calls.diffStats.length === 1);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(t.store.get(id).state, 'needs_ok');
  assert.equal(t.store.get(id).ask.id, ask.id);
  await t.engine.answer(id, { askId: ask.id, answer: 'Deny' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny');
  const v = t.store.get(id);
  assert.equal(v.state, 'question');
  assert.equal(v.ask.type, 'question');
  assert.equal(v.ask.sentence, 'Which one should I change?');
  assert.equal((await t.engine.answer(id, { askId: v.ask.id, answer: 'the first one' })).ok, true);
  await t.engine.shutdown();
});

test('hook: a turn that ends with its receipt while a request shows is done after the answer', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the redirect.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).says === 'I fixed the redirect.');
  assert.equal(t.store.get(id).state, 'needs_ok', 'the done state waits for the answer');
  assert.equal(t.store.get(id).files.changed, 1, 'what changed shows at once');
  await t.engine.answer(id, { askId: ask.id, answer: 'Allow' });
  await pending;
  assert.equal(t.store.get(id).state, 'done_claimed');
  await t.engine.shutdown();
});

test('hook: a new turn drops what the last turn decided while a request was showing', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the redirect.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).says === 'I fixed the redirect.');
  assert.equal(t.store.get(id).state, 'needs_ok', 'its done state waits for the answer');
  runner.emit({ kind: EV.TURN, phase: 'start' }); // a message reached it, or a helper's result: it works again
  await t.engine.answer(id, { askId: ask.id, answer: 'Allow' });
  await pending;
  assert.equal(t.store.get(id).state, 'working', 'its new turn is running: not the old turn’s done');
  await t.engine.shutdown();
});

test('hook: answered while a later turn runs, the root goes back to working', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  await t.engine.answer(id, { askId: ask.id, answer: 'Allow' });
  await pending;
  assert.equal(t.store.get(id).state, 'working');
  await t.engine.shutdown();
});

test('hook: a turn that fails says no to the request it was showing', async () => {
  const t = live();
  const { id, runner, pending } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, reason: 'It reached its spending limit.' });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The agent is no longer running.');
  assert.equal(t.store.get(id).state, 'failed');
  assert.equal(t.engine.held.size, 0);
  await t.engine.shutdown();
});

test('hook: stopping a root whose decision waits behind a request shows stopped, not the decision first', async () => {
  const t = live();
  const { id, runner, pending } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the redirect.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).says === 'I fixed the redirect.');
  const seen = [];
  t.store.on('agents', ids => { if (ids.includes(id)) seen.push(t.store.get(id).state); });
  await t.engine.stop(id);
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!seen.includes('done_claimed'), `states seen: ${seen.join(', ')}`);
  assert.equal(t.store.get(id).state, 'stopped');
  await t.engine.shutdown();
});

test('hook: the runner names the helper behind a request, whatever id the helper got', async () => {
  const t = live({ options: { helperWaitMs: 5000 } });
  const { id, runner } = await started(t);
  // A helper first seen through its forwarded messages has an id from the Agent call, not from its task id.
  const helperId = `${id}-01Uyrz1p`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.agentFor = ({ toolUseId, taskId }) => (toolUseId === subagentPayload.tool_use_id || taskId === subagentPayload.agent_id ? helperId : null);
  const t0 = Date.now();
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).state === 'needs_ok');
  assert.ok(Date.now() - t0 < 1000, 'no waiting for a helper the runner knows');
  assert.equal(t.store.get(helperId).ask.sentence, 'List repository files wants to run a command');
  assert.equal(t.store.get(id).ask, null, 'not in the root’s name');
  await t.engine.answer(helperId, { askId: t.store.get(helperId).ask.id, answer: 'Allow' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  await t.engine.shutdown();
});

test('hook: held requests always show, or wait behind one that shows', async () => {
  const t = live();
  const { id, runner } = await started(t);
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  const steps = [
    ['a helper asks', () => t.engine.hookPreToolUse(id, subagentPayload)],
    ['an unknown helper asks through the root', () => t.engine.hookPreToolUse(id, { ...subagentPayload, agent_id: 'ffffffff00000000' })],
    ['a second one queues', () => t.engine.hookPreToolUse(id, { ...subagentPayload, agent_id: 'eeeeeeee00000000', tool_input: { command: 'rm b' } })],
    ['the turn ends while helpers run', () => runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Waiting.', backgroundTasks: 1, isError: false })],
    ['a turn starts', () => runner.emit({ kind: EV.TURN, phase: 'start' })],
    ['the turn ends with a question', () => runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Which one should I use?', backgroundTasks: 0, isError: false })],
    ['the stuck check runs', () => t.engine.tick(Date.now() + 60 * 60_000)],
    ['the first request on the root is answered', () => t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' })],
    ['the helper ends', () => {
      runner.emit({ kind: EV.STATE, agentId: helperId, state: 'finished' });
      runner.emit({ kind: EV.ENDED, agentId: helperId, outcome: 'ok' });
    }],
    ['the second request on the root is answered', () => t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' })],
  ];
  for (const [step, act] of steps) {
    act();
    await new Promise(r => setTimeout(r, 120)); // longer than helperWaitMs, so requests have landed
    assertHeldVisible(t, step);
  }
  assert.equal(t.engine.held.size, 0);
  assert.equal(t.store.get(id).state, 'question', 'the question waited its turn');
  await t.engine.shutdown();
});

test('hook: a held request that something else hid is shown again, then the agent goes where it was moved', async () => {
  const t = live();
  const { id, runner, pending, ask } = await rootHoldsForUnknownHelper(t, { inTurn: true });
  // Bypass the engine, as a path nobody foresaw would: leaving needs_ok makes the store drop the ask.
  t.store.apply([{ kind: EV.STATE, agentId: id, state: 'waiting_helpers', reason: null, ts: Date.now() }]);
  assert.equal(t.store.get(id).ask, null);
  runner.emit({ kind: EV.THINKING, on: false }); // any event: the engine checks after every batch
  assert.equal(t.store.get(id).state, 'needs_ok');
  assert.equal(t.store.get(id).ask.id, ask.id, 'the same request shows again');
  await t.engine.answer(id, { askId: ask.id, answer: 'Allow' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'where it was moved, not where it was when it asked');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ stuck

function failThreeTimes(runner) {
  for (let i = 0; i < 3; i++) {
    runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Running the tests', toolKind: 'run', toolUseId: 'u' + i });
    if (i < 2) runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'u' + i, ok: false });
  }
}

test('stuck: the tick flags a repeating agent; "Let it keep trying" clears it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  failThreeTimes(runner);
  t.engine.tick(Date.now());
  const v = t.store.get(id);
  assert.equal(v.state, 'maybe_stuck');
  assert.equal(v.ask.type, 'stuck');
  assert.equal(v.ask.sentence, 'Fix login redirect has tried the same step three times without success.');
  assert.deepEqual(v.ask.options, ['Stop it', 'Let it keep trying']);
  const r = await t.engine.answer(id, { askId: v.ask.id, answer: 'Let it keep trying' });
  assert.equal(r.reply, 'OK, Fix login redirect will keep trying.');
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  t.engine.tick(Date.now());
  assert.equal(t.store.get(id).state, 'working', 'not flagged again straight away');
  await t.engine.shutdown();
});

test('stuck: "Stop it" stops the agent, other text is a hint, progress clears it', async () => {
  const t = live();
  const a = await started(t);
  failThreeTimes(a.runner);
  t.engine.tick(Date.now());
  await t.engine.answer(a.id, { askId: t.store.get(a.id).ask.id, answer: 'Stop it' });
  assert.equal(t.store.get(a.id).state, 'stopped');
  assert.equal(a.runner.stopCalls, 1);
  assert.equal(t.store.get(a.id).ask, null);

  const b = await started(t, { task: 'Fix the cart total' });
  failThreeTimes(b.runner);
  t.engine.tick(Date.now());
  await t.engine.answer(b.id, { askId: t.store.get(b.id).ask.id, answer: 'The fixture file is out of date' });
  assert.deepEqual(b.runner.sent, ['The fixture file is out of date']);
  assert.equal(t.store.get(b.id).state, 'working');

  const c = await started(t, { task: 'Fix the cart tax' });
  failThreeTimes(c.runner);
  t.engine.tick(Date.now());
  assert.equal(t.store.get(c.id).state, 'maybe_stuck');
  c.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit', toolUseId: 'e1' });
  c.runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'e1', ok: true });
  assert.equal(t.store.get(c.id).state, 'working', 'a different step succeeded');
  assert.equal(t.store.get(c.id).ask, null);
  await t.engine.shutdown();
});

test('stuck: the same error close together flags the agent; another step that works clears it; spread out it never flags', async () => {
  const t = live();
  const { id, runner } = await started(t);
  let n = 0;
  const step = (sentence, ok, error) => {
    const toolUseId = `s${n++}`;
    runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence, toolKind: 'run', toolUseId });
    runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId, ok, ...(error ? { error } : {}) });
  };
  for (let i = 0; i < 3; i++) {
    step('Editing cart.js', true);
    step('Running the tests', false, 'TypeError: cart is undefined');
  }
  t.engine.tick(Date.now());
  let v = t.store.get(id);
  assert.equal(v.state, 'maybe_stuck');
  assert.equal(v.ask.sentence, 'Fix login redirect has hit the same error three times.');
  step('Reading cart.js', true);
  v = t.store.get(id);
  assert.equal(v.state, 'working', 'a different step worked');
  assert.equal(v.ask, null);
  assert.equal(v.stateReason, 'It is making progress again');

  // The same error now and then over a long turn is not a loop.
  const b = await started(t, { task: 'Fix the cart tax' });
  for (let i = 0; i < 3; i++) {
    b.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing tax.js', toolKind: 'edit', toolUseId: `m${i}` });
    b.runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: `m${i}`, ok: false, error: 'File has not been read yet. Read it first before writing to it.' });
    for (let k = 0; k < 12; k++) {
      b.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: `Reading part ${k}`, toolKind: 'read', toolUseId: `g${i}-${k}` });
      b.runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: `g${i}-${k}`, ok: true });
    }
    t.engine.tick(Date.now());
    assert.equal(t.store.get(b.id).state, 'working');
  }
  await t.engine.shutdown();
});

test('stuck: a working agent with no events for the silence limit is flagged', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Reading a.js', toolKind: 'read', toolUseId: 'r', ts: Date.now() - 5000 });
  runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'r', ok: true, ts: Date.now() - 5000 });
  t.engine.tick(Date.now() + 2000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  assert.equal(t.store.get(id).ask.sentence, 'Fix login redirect has not done anything for 1 s.');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ done, follow-ups, stop

test('done: "Looks good" leaves it; anything else is a follow-up that resumes it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed it.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_claimed');
  const ok = await t.engine.answer(id, { answer: 'Looks good' });
  assert.equal(ok.ok, true);
  assert.equal(t.store.get(id).state, 'done_claimed');
  assert.deepEqual(runner.sent, []);
  const more = await t.engine.answer(id, { answer: 'Please also add a test' });
  assert.equal(more.reply, 'Sent your follow-up to Fix login redirect.');
  assert.deepEqual(runner.sent, ['Please also add a test']);
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).endedAt, null);
  await t.engine.shutdown();
});

test('stop: the runner stops, the agent and its helpers are stopped, late events cannot undo it', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.CREATED, agentId: `${id}-12345678`, parentId: id, name: 'Helper', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: `${id}-12345678`, state: 'working' });
  const r = await t.engine.stop(id);
  assert.equal(r.reply, 'Stopped Fix login redirect.');
  assert.equal(runner.stopCalls, 1);
  assert.equal(t.store.get(id).state, 'stopped');
  assert.equal(t.store.get(`${id}-12345678`).state, 'stopped');
  runner.emit({ kind: EV.ENDED, outcome: 'error', error: 'killed by SIGTERM' });
  runner.emit({ kind: EV.STATE, state: 'failed' });
  assert.equal(t.store.get(id).state, 'stopped');
  assert.equal(t.store.get(id).error, null);
  const again = await t.engine.stop(id);
  assert.equal(again.reply, 'Fix login redirect is not running.');
  // A new message brings it back.
  const s = await t.engine.say(id, 'Carry on, but skip the slow tests');
  assert.equal(s.ok, true);
  assert.deepEqual(runner.sent, ['Carry on, but skip the slow tests']);
  assert.equal(t.store.get(id).state, 'working');
  await t.engine.shutdown();
});

test('say: to a helper goes through its root', async () => {
  const t = live();
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.CREATED, agentId: `${id}-abcdefab`, parentId: id, name: 'Find tests', harness: 'claude' });
  const r = await t.engine.say(`${id}-abcdefab`, 'look in spec/ too');
  assert.equal(r.reply, 'Passed that to Fix login redirect for its helper Find tests.');
  assert.deepEqual(runner.sent, ['About your helper “Find tests”: look in spec/ too']);
  assert.equal((await t.engine.say('nobody', 'x')).ok, false);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ commands and confirms

test('command: a start intent asks to confirm first; confirm(go) launches, confirm(no) cancels', async () => {
  const t = live();
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'fix the flaky checkout test', harness: 'claude', machine: null }] };
  const out = await t.engine.command('start an agent to fix the flaky checkout test', { focusId: null });
  assert.equal(out.reply, 'Start Claude Code on “fix the flaky checkout test”?');
  assert.ok(out.confirm && /^[0-9a-f]{12}$/.test(out.confirm.id));
  assert.equal(out.confirm.sentence, out.reply);
  assert.match(out.confirm.detail, /\$2\.00/);
  assert.match(out.confirm.detail, /2 uncommitted changes are not included/);
  assert.equal(t.store.list().length, 0, 'nothing starts before the confirm');
  const ctx = t.calls.parse[0].ctx;
  // Pinned on purpose: `repo` was added with source control, so "merge it into main" is read against the branch.
  assert.deepEqual(Object.keys(ctx).sort(), ['agents', 'focusId', 'harnesses', 'machines', 'pendingConfirm', 'repo']);
  assert.deepEqual(ctx.harnesses, { claude: true, codex: true, sim: false });
  // identity: null, as start() has not read it yet (Workbench cannot tell); true or false once it has.
  assert.deepEqual(ctx.repo, { name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 2, identity: null });

  const go = await t.engine.confirm(out.confirm.id, true);
  assert.equal(go.reply, 'Started Fix flaky checkout test.');
  assert.equal(go.agentIds.length, 1);
  assert.equal(t.store.get(go.agentIds[0]).task, 'fix the flaky checkout test');
  const twice = await t.engine.confirm(out.confirm.id, true);
  assert.match(twice.reply, /no longer waiting/);

  t.deps.commands.intent = { kind: 'task', task: 'fix the login redirect' };
  const out2 = await t.engine.command('fix the login redirect');
  assert.ok(out2.confirm);
  const no = await t.engine.confirm(out2.confirm.id, false);
  assert.equal(no.reply, 'OK, I won’t start it.');
  assert.equal(t.store.list().length, 1);
  await t.engine.shutdown();
});

test('command: "yes" confirms the pending launch through the commands module', async () => {
  const t = live();
  t.deps.commands.intent = (text, ctx) => (text !== 'yes'
    ? { kind: 'start', tasks: [{ task: 'write tests for the parser', harness: 'codex' }, { task: 'fix the parser', harness: 'claude' }] }
    : ctx.pendingConfirm ? { kind: 'confirm', go: true } : { kind: 'unknown', text });
  const out = await t.engine.command('have codex write tests for the parser and claude fix it');
  assert.match(out.reply, /^Start 2 agents: Codex on “write tests for the parser” and Claude Code on “fix the parser”\?$/);
  // Without the card's id, nothing is shown, so nothing waits for a yes: the newest confirm is never picked.
  assert.equal((await t.engine.command('yes')).reply, 'I did not catch that. Say what to work on, like “the login page is broken”, or ask “what needs me”.');
  assert.equal(t.calls.parse[1].ctx.pendingConfirm, null);
  const yes = await t.engine.command('yes', { confirmId: out.confirm.id }); // the page sends the card it shows
  assert.equal(t.calls.parse[2].ctx.pendingConfirm.id, out.confirm.id);
  assert.match(yes.reply, /^Started Write tests for parser and Fix parser\.$/);
  assert.equal(t.codex.runners.length, 1);
  assert.equal(t.claude.runners.length, 1);
  assert.equal(yes.focusId, yes.agentIds[0], 'the first agent it started goes in the centre, not whatever asks next');
  await t.engine.shutdown();
});

test('command: with no confirm on screen, "yes" answers the held request on screen, not a hidden launch question', async () => {
  const t = live();
  t.engine.deps.commands = commands; // the real parser: a confirm in the context takes "yes" before a permission does
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);
  const proposed = await t.engine.command('start an agent to fix the login redirect');
  assert.ok(proposed.confirm);
  // The page dropped the card (another command, a pick, a reload, another tab): it sends no confirmId.
  const yes = await t.engine.command('yes', { focusId: id, askId: t.store.get(id).ask.id });
  assert.equal(yes.reply, 'OK, Fix login redirect can go ahead.');
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(t.claude.runners.length, 1, 'the hidden launch question started nothing');
  await t.engine.shutdown();
});

test('command: with no confirm on screen, "stop" stops the focused agent, not a hidden launch question', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  await t.engine.command('start an agent to update the docs');
  const out = await t.engine.command('stop', { focusId: id });
  assert.equal(out.reply, 'Stopped Fix login redirect.');
  assert.equal(t.store.get(id).state, 'stopped');
  await t.engine.shutdown();
});

test('command: "do it" and "cancel" answer the confirm the page shows; any other command withdraws it', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const a = await t.engine.command('start an agent to fix the login redirect');
  const b = await t.engine.command('start an agent to update the docs', { confirmId: a.confirm.id });
  assert.equal((await t.engine.confirm(a.confirm.id, true)).reply, 'That request is no longer waiting. Ask again if you still want it.', 'a new proposal replaces the one on screen');
  const go = await t.engine.command('do it', { confirmId: b.confirm.id });
  assert.match(go.reply, /^Started /);
  assert.deepEqual(t.claude.runners.map(r => r.opts.task), ['update the docs']);

  const c = await t.engine.command('start an agent to tidy the readme');
  assert.equal((await t.engine.command('cancel', { confirmId: c.confirm.id })).reply, 'OK, I won’t start it.');

  const d = await t.engine.command('start an agent to tidy the readme');
  const before = t.notices.length;
  const status = await t.engine.command('what needs me', { confirmId: d.confirm.id });
  assert.equal(status.confirm, undefined);
  assert.deepEqual(t.notices.slice(before), [status.reply], 'withdrawing says nothing over the answer');
  assert.match((await t.engine.confirm(d.confirm.id, true)).reply, /no longer waiting/, 'the page dropped the card, so the engine did too');
  assert.equal(t.claude.runners.length, 1);
  // An id that names nothing (or not an id at all) answers plainly, and starts nothing.
  assert.equal((await t.engine.command('yes', { confirmId: 'feedfacecafe' })).reply, 'That request is no longer waiting. Ask again if you still want it.');
  assert.equal((await t.engine.command('blorp', { confirmId: 'feedfacecafe' })).reply, 'That request is no longer waiting. Ask again if you still want it.');
  assert.equal(t.claude.runners.length, 1);
  await t.engine.shutdown();
});

test('command: with a card on screen no ask was, so words that are no yes or no to the card answer no request', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);
  const askId = t.store.get(id).ask.id;
  const card = await t.engine.command('start an agent to update the docs');
  // A page that sends both: the card wins, the ask id is not used, and the request keeps waiting.
  const r = await t.engine.command('allow it', { focusId: id, confirmId: card.confirm.id, askId });
  assert.deepEqual(r, { reply: 'Have a look at what Fix login redirect is asking first.', focusId: id });
  assert.equal(await settled(pending), false);
  assert.match((await t.engine.confirm(card.confirm.id, true)).reply, /no longer waiting/, 'the card was withdrawn by the other command');
  await t.engine.shutdown();
});

test('command: words not understood keep the confirm on screen, so "yes" again still answers it', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);
  const p = await t.engine.command('start an agent to update the docs');
  const before = t.notices.length;
  const miss = await t.engine.command('yes start the agent', { confirmId: p.confirm.id });
  assert.equal(miss.reply, 'I did not catch that. Say “do it” to start it, or “cancel”.');
  assert.deepEqual(miss.confirm, p.confirm, 'the same card stays in the centre');
  assert.equal(t.notices.length, before, 'a kept card is not announced');
  const yes = await t.engine.command('yes', { confirmId: miss.confirm.id });
  assert.match(yes.reply, /^Started /);
  assert.equal(await settled(pending), false, 'the held request was not answered by a "yes" meant for the launch');
  assert.equal(t.store.get(id).state, 'needs_ok');
  await t.engine.shutdown();
});

test('command: "yes" to a confirm that has run out says so and starts nothing', async () => {
  let now = 1_700_000_000_000;
  const t = live({ options: { now: () => now } });
  t.engine.deps.commands = commands;
  const p = await t.engine.command('start an agent to fix the login redirect');
  now += 10 * 60_000 + 1;
  const yes = await t.engine.command('yes', { confirmId: p.confirm.id });
  assert.equal(yes.reply, 'That request is no longer waiting. Ask again if you still want it.');
  assert.equal(yes.confirm, undefined);
  assert.equal(t.claude.runners.length, 0);
  await t.engine.shutdown();
});

test('command: allow, stop, status, spend and unknown give plain replies', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await until(() => t.store.get(id).ask);

  t.deps.commands.intent = { kind: 'status' };
  const status = await t.engine.command('what needs me');
  assert.equal(status.reply, 'One thing needs you: Fix login redirect needs your OK.');
  assert.equal(status.focusId, id);

  t.deps.commands.intent = { kind: 'status', agentId: id };
  assert.equal((await t.engine.command('what is it doing')).reply, 'Fix login redirect wants to run a command: “rm -rf build”. It needs your OK.');

  // A typed or spoken yes counts only with the id of the request on screen when the person began.
  const askId = t.store.get(id).ask.id;
  t.deps.commands.intent = { kind: 'allow', agentId: id, askId };
  const unseen = await t.engine.command('go ahead', { focusId: id });
  assert.deepEqual(unseen, { reply: 'Have a look at what Fix login redirect is asking first.', focusId: id });
  assert.equal(await settled(pending), false, 'still held');
  const allow = await t.engine.command('go ahead', { focusId: id, askId });
  assert.equal(allow.reply, 'OK, Fix login redirect can go ahead.');
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');

  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'set', costUsd: 0.42 });
  t.deps.commands.intent = { kind: 'spend' };
  assert.equal((await t.engine.command('how much have I spent today')).reply, 'You have spent $0.42 today.');
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'add', unreportedUsd: 0.2 }); // a turn in progress
  assert.equal((await t.engine.command('how much have I spent today')).reply, 'You have spent about $0.62 today.');
  assert.deepEqual([t.engine.snapshot().spendTodayUsd, t.engine.snapshot().spendTodayEstimated], [0.62, true]);

  t.deps.commands.intent = { kind: 'stop_all' };
  assert.equal((await t.engine.command('stop everything')).reply, 'Stopped Fix login redirect.');
  assert.equal((await t.engine.command('stop everything')).reply, 'Nothing is running.');

  t.deps.commands.intent = null;
  const unknown = await t.engine.command('blorp');
  assert.match(unknown.reply, /I did not catch that/);
  assert.ok(t.notices.includes(unknown.reply));
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ demo mode

test('demo: start seeds the simulator and syncs machines; launches use the simulator', async () => {
  const t = demo();
  await t.engine.start();
  assert.equal(t.sim.seeded, true);
  assert.deepEqual(t.store.machines().map(m => m.id), ['laptop', 'cloud-1', 'cloud-2', 'cloud-3']);
  assert.deepEqual(t.engine.snapshot().harnesses, { claude: true, codex: true, sim: true });
  const v = await t.engine.startAgent({ task: 'Fix the onboarding copy', harness: 'codex' });
  assert.equal(t.sim.runners.length, 1);
  assert.equal(t.sim.runners[0].opts.agentId, v.id);
  assert.equal(t.sim.runners[0].opts.cwd, null);
  assert.equal(v.harness, 'codex');
  assert.equal(v.usage.costUsd, null);
  await t.engine.shutdown();
});

test('demo: asks the simulator made go back to the simulator', async () => {
  const t = demo();
  t.engine.ingest({ kind: EV.CREATED, agentId: 'c0ffee', parentId: null, name: 'Search cleanup', task: 'Clean up search', harness: 'claude', machineId: 'cloud-3' });
  t.engine.ingest({ kind: EV.ASK, agentId: 'c0ffee', ask: { id: 'sim-q1', type: 'question', sentence: 'Should I keep the old route?', options: ['Keep it', 'Remove it'] } });
  t.engine.ingest({ kind: EV.STATE, agentId: 'c0ffee', state: 'question' });
  const r = await t.engine.answer('c0ffee', { askId: 'sim-q1', answer: 'Keep it' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'Sent your answer to Search cleanup.');
  assert.equal(t.sim.answers.length, 1);
  assert.equal(t.sim.answers[0].agentId, 'c0ffee');
  assert.equal(t.sim.answers[0].ask.id, 'sim-q1');
  assert.equal(t.sim.answers[0].answer, 'Keep it');
  // Stopping a seeded agent (no runner here) still stops it and keeps it stopped.
  const s = await t.engine.stop('c0ffee');
  assert.equal(s.reply, 'Stopped Search cleanup.');
  assert.deepEqual(t.sim.stops, ['c0ffee']);
  t.engine.ingest({ kind: EV.STATE, agentId: 'c0ffee', state: 'working' });
  assert.equal(t.store.get('c0ffee').state, 'stopped');
  await t.engine.shutdown();
});

test('demo: cloud launches each get their own machine, waking one if needed', async () => {
  const t = demo();
  await t.engine.start();
  t.deps.commands.intent = { kind: 'start', tasks: [
    { task: 'fix the checkout bug', harness: 'claude', machine: 'cloud' },
    { task: 'fix the checkout bug', harness: 'codex', machine: 'cloud' },
    { task: 'write the release notes', harness: 'claude', machine: 'cloud' },
  ] };
  const out = await t.engine.command('start Claude and Codex on the checkout bug, each on its own cloud machine');
  assert.match(out.confirm.detail, /Each one gets its own cloud machine/);
  const go = await t.engine.confirm(out.confirm.id, true);
  const machines = go.agentIds.map(id => t.store.get(id).machineId);
  assert.deepEqual(machines, ['cloud-1', 'cloud-3', 'cloud-2'], 'awake idle machines first, then a sleeping one');
  assert.equal(t.store.machines().find(m => m.id === 'cloud-2').awake, true, 'the sleeping machine was woken');
  await t.engine.shutdown();
});

test('machines: sleep and wake with plain replies; the laptop stays on', async () => {
  const t = demo();
  await t.engine.start();
  assert.equal((await t.engine.setMachineAwake('cloud-2', true)).reply, 'Cloud 2 is awake.');
  assert.equal(t.store.machines().find(m => m.id === 'cloud-2').awake, true);
  assert.equal((await t.engine.setMachineAwake('cloud-2', false)).reply, 'Cloud 2 is asleep now.');
  const laptop = await t.engine.setMachineAwake('laptop', false);
  assert.equal(laptop.ok, false);
  assert.equal(laptop.reply, 'Your laptop runs Workbench itself, so it stays awake.');
  assert.equal(t.store.machines().find(m => m.id === 'laptop').awake, true);
  assert.equal((await t.engine.setMachineAwake('nope', true)).ok, false);
  assert.equal((await t.engine.setMachineAwake('Cloud 1', true)).reply, 'Cloud 1 is already awake.', 'loose names work');
  await t.engine.shutdown();
});

test('machines: a machines module that words its own replies is passed through, and its updates are synced', async () => {
  const t = demo();
  t.machines.setAwake = function (id, awake) {
    const m = this.items.find(x => x.id === id);
    if (!m) return { ok: false, reply: `There is no machine called ${id}.` };
    m.awake = awake;
    return { ok: true, reply: awake ? `${m.name} is waking up. It takes about 8 seconds.` : `${m.name} is asleep. Its work is saved.` };
  };
  t.machines.sleepIdle = function () {
    const idle = this.items.filter(m => m.kind === 'cloud' && m.awake && !m.agents);
    for (const m of idle) m.awake = false;
    return { ok: true, reply: `${idle.map(m => m.name).join(' and ')} are asleep. Their work is saved.`, ids: idle.map(m => m.id) };
  };
  await t.engine.start();
  assert.equal((await t.engine.setMachineAwake('cloud-2', true)).reply, 'Cloud 2 is waking up. It takes about 8 seconds.');
  assert.equal((await t.engine.setMachineAwake('cloud-9', true)).reply, 'There is no machine called cloud-9.');
  t.deps.commands.intent = { kind: 'sleep_idle' };
  const r = await t.engine.command('sleep idle machines');
  assert.equal(r.reply, 'Cloud 1 and Cloud 2 and Cloud 3 are asleep. Their work is saved.');
  assert.ok(t.store.machines().filter(m => m.kind === 'cloud').every(m => !m.awake));
  // A change the machines module makes on its own reaches the store.
  t.machines.items[1].awake = true;
  t.machines.emit('update', [t.machines.items[1]]);
  assert.equal(t.store.machines().find(m => m.id === 'cloud-1').awake, true);
  await t.engine.shutdown();
});

test('command: deny with words passes them on; the commands module can word the confirm', async () => {
  const t = live();
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'psql prod' } });
  await until(() => t.store.get(id).ask);
  const askId = t.store.get(id).ask.id;
  t.deps.commands.intent = { kind: 'deny', agentId: id, askId, text: 'use the staging database' };
  await t.engine.command('no, use the staging database', { focusId: id, askId });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'The person said no, and added: use the staging database');

  t.deps.commands.describeIntent = (intent) => `Start Claude Code on “${intent.tasks[0].task}”${intent.tasks[0].machine ? ' on a cloud machine' : ''}?`;
  t.deps.commands.intent = { kind: 'start', tasks: [{ task: 'tidy the README', harness: 'claude', machine: 'cloud' }] };
  const c = await t.engine.command('start an agent on a cloud machine to tidy the README');
  assert.equal(c.confirm.sentence, 'Start Claude Code on “tidy the README”?', 'live mode has no cloud machines to promise');
  assert.match(c.confirm.detail, /Cloud machines exist only in the demo/);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ typed and spoken answers (the real parser)

test('command (real parser): a yes with conditions says no and passes the words on', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  for (const words of ['yes but only in the tests folder', 'allow it but only once', 'ok but not on main']) {
    const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    await until(() => t.store.get(id).ask);
    const r = await t.engine.command(words, { focusId: id, askId: t.store.get(id).ask.id });
    assert.equal(r.reply, 'OK, Fix login redirect will not do it as asked. I passed on your words.', words);
    const out = await pending;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', words);
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, `The person did not allow this step as asked. They said: “${words}”`);
  }
  assert.deepEqual(t.store.get(id).approvals, { auto: 0, byYou: 0, denied: 3 });
  await t.engine.shutdown();
});

test('command (real parser): a typed answer reaches only the request that was on screen when the person began', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const acA = new AbortController();
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }, { signal: acA.signal });
  await until(() => t.store.get(id).ask);
  const askA = t.store.get(id).ask.id; // the person starts typing "yes" here
  acA.abort(); // A goes away, and B takes its place before Enter, with the same sentence
  await a;
  const b = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  await until(() => t.store.get(id).ask?.detail === 'git push --force origin main');
  assert.deepEqual(await t.engine.command('yes', { focusId: id, askId: askA }),
    { reply: 'Fix login redirect is asking something else now. Have a look, then answer again.', focusId: id });
  assert.equal(await settled(b), false, 'B is still held');
  // With no ask id (nothing was on screen when the person began), a no is refused as well as a yes.
  assert.deepEqual(await t.engine.command('no', { focusId: id }), { reply: 'Have a look at what Fix login redirect is asking first.', focusId: id });
  assert.equal(await settled(b), false);
  // A request held behind the one on screen cannot be answered by naming it: the words were read against the one shown.
  const c = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm c' } });
  await new Promise(r => setTimeout(r, 10));
  const queued = [...t.engine.held.values()].find(h => h.ask.detail === 'rm c').askId;
  assert.match((await t.engine.command('yes', { focusId: id, askId: queued })).reply, /asking something else now/);
  assert.equal(await settled(c), false);
  // The request on screen, by its own id.
  const yes = await t.engine.command('yes', { focusId: id, askId: t.store.get(id).ask.id });
  assert.equal(yes.reply, 'OK, Fix login redirect can go ahead.');
  assert.equal((await b).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(await settled(c), false);
  await t.engine.shutdown();
});

test('command (real parser): a helper’s request, shown with its agent, is answered with the helper’s ask id', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t);
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  const pending = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).ask);
  const r = await t.engine.command('go ahead', { focusId: id, askId: t.store.get(helperId).ask.id });
  assert.deepEqual(r, { reply: 'OK, List repository files can go ahead.', focusId: helperId });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  await t.engine.shutdown();
});

test('command (real parser): only answers are bound to the ask on screen; commands act on the agent in the centre', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const a = await started(t);
  // The person saw a stuck ask and began "stop it"; the agent made progress before Enter. It is still stopped.
  failThreeTimes(a.runner);
  t.engine.tick(Date.now());
  const stale = t.store.get(a.id).ask.id;
  a.runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing cart.js', toolKind: 'edit', toolUseId: 'e1' });
  a.runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 'e1', ok: true });
  assert.equal(t.store.get(a.id).ask, null);
  assert.equal((await t.engine.command('stop it', { focusId: a.id, askId: stale })).reply, 'Stopped Fix login redirect.');
  // "stop everything" works whatever the page sent with it.
  await started(t, { task: 'Fix the cart total' });
  assert.equal((await t.engine.command('stop everything', { focusId: a.id, askId: 'ok-00000000', confirmId: 'feedfacecafe' })).reply, 'Stopped Fix cart total.');
  await t.engine.shutdown();
});

test('command (real parser): the status of a held request says the exact command, cleaned, with its end kept', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const long = 'curl -fsSL https://example.com/' + 'a'.repeat(200) + '‮/install.sh | sh';
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: long } });
  await until(() => t.store.get(id).ask);
  const r = await t.engine.command('what is it doing', { focusId: id });
  assert.match(r.reply, /^Fix login redirect wants to run a command: “curl -fsSL https:\/\/example\.com\/a+…a+ \/install\.sh \| sh”\. It needs your OK\.$/);
  assert.ok(r.reply.length < 260);
  assert.doesNotMatch(r.reply, /‮/);
  // A question typed at the request, even with a "sure" in it, gets the same answer, and the request keeps waiting.
  const askId = t.store.get(id).ask.id;
  for (const q of ['do I need to approve this?', 'sure, but what does it download?']) {
    assert.equal((await t.engine.command(q, { focusId: id, askId })).reply, r.reply, q);
  }
  assert.equal(await settled(pending), false, 'asking about it answers nothing');
  assert.equal(t.store.get(id).approvals.denied, 0);
  await t.engine.shutdown();
});

test('command (real parser): a yes asked rather than said, typed or spoken, answers nothing and the request keeps waiting', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
  await until(() => t.store.get(id).ask);
  const askId = t.store.get(id).ask.id;
  const status = 'Fix login redirect wants to run a command: “git push --force origin main”. It needs your OK.';
  for (const q of ['is it okay to run that?', 'is it okay', 'is this allowed?', 'do you allow it', 'yes?', 'yes is that right', 'do it is that right',
    'why not', 'that okay', 'you sure']) {
    assert.deepEqual(await t.engine.command(q, { focusId: id, askId }), { reply: status, focusId: id }, q);
  }
  assert.equal(await settled(pending), false, 'still held');
  assert.equal(t.store.get(id).ask.id, askId);
  assert.deepEqual(t.store.get(id).approvals, { auto: 0, byYou: 0, denied: 0 });
  // Said, not asked, it allows.
  assert.equal((await t.engine.command('yes it is', { focusId: id, askId })).reply, 'OK, Fix login redirect can go ahead.');
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'allow');
  await t.engine.shutdown();
});

test('command (real parser): "is that right?" at a card settles nothing: the card stays, and nothing stops or starts', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t, { task: 'Fix the flaky checkout test so it stops timing out' });
  const stopCard = await t.engine.command('stop the one timing out');
  assert.equal(stopCard.reply, 'Stop Fix flaky checkout test?');
  for (const q of ['is that the right one?', 'is that right', 'right?', 'yeah is that the right one', 'that the right one']) {
    const r = await t.engine.command(q, { confirmId: stopCard.confirm.id });
    assert.equal(r.reply, 'I did not catch that. Say “do it” to stop it, or “cancel”.', q);
    assert.deepEqual(r.confirm, stopCard.confirm, q);
  }
  assert.equal(runner.stopCalls, 0);
  assert.notEqual(t.store.get(id).state, 'stopped');
  // "start it" is no yes to a stop card either.
  assert.deepEqual((await t.engine.command('start it', { confirmId: stopCard.confirm.id })).confirm, stopCard.confirm);
  assert.equal(runner.stopCalls, 0);
  assert.equal((await t.engine.confirm(stopCard.confirm.id, false)).reply, 'OK, I won’t stop it.');
  // A launch card, likewise: no agent starts.
  const launch = await t.engine.command('start two agents to tidy the docs');
  assert.ok(launch.confirm);
  const runners = t.claude.runners.length;
  for (const q of ['is that right?', 'is that okay', 'yes?']) {
    assert.deepEqual((await t.engine.command(q, { confirmId: launch.confirm.id })).confirm, launch.confirm, q);
  }
  assert.equal(t.claude.runners.length, runners);
  assert.match((await t.engine.command('yes', { confirmId: launch.confirm.id })).reply, /^Started /);
  assert.equal(t.claude.runners.length, runners + 2);
  await t.engine.shutdown();
});

// A stop or a message acts at once only when the words name the agent (the real parser).

test('command (real parser): a work request that starts with a stop verb is offered as work and stops nothing', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t, { task: 'Fix the flaky checkout test' });
  for (const words of ['stop the flaky test from timing out', 'end the flaky test run with a summary', 'kill the flaky test popup on mobile']) {
    const out = await t.engine.command(words);
    assert.equal(out.reply, `Start Claude on “${words}”?`);
    assert.ok(out.confirm);
    assert.equal((await t.engine.confirm(out.confirm.id, false)).reply, 'OK, I won’t start it.');
  }
  assert.equal(runner.stopCalls, 0);
  assert.notEqual(t.store.get(id).state, 'stopped');
  // Its name still stops it in one step, and so does "it" with the agent in the centre.
  const stop = await t.engine.command('stop the flaky test immediately');
  assert.equal(stop.reply, 'Stopped Fix flaky checkout test.');
  assert.equal(stop.confirm, undefined);
  assert.equal(runner.stopCalls, 1);
  await t.engine.shutdown();
});

test('command (real parser): a stop found by task words asks first; Cancel leaves it, "stop it" on the card stops it', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t, { task: 'Fix the flaky checkout test so it stops timing out' });
  const ask = await t.engine.command('stop the one timing out');
  assert.equal(ask.reply, 'Stop Fix flaky checkout test?');
  assert.equal(ask.confirm.detail, 'Its task: “Fix the flaky checkout test so it stops timing out”');
  assert.equal(runner.stopCalls, 0);
  assert.equal((await t.engine.confirm(ask.confirm.id, false)).reply, 'OK, I won’t stop it.');
  assert.equal(runner.stopCalls, 0);
  // Words not understood keep the card, with a hint for this kind of card.
  const again = await t.engine.command('stop the one timing out');
  const miss = await t.engine.command('blorp', { confirmId: again.confirm.id });
  assert.equal(miss.reply, 'I did not catch that. Say “do it” to stop it, or “cancel”.');
  assert.deepEqual(miss.confirm, again.confirm);
  const yes = await t.engine.command('stop it', { confirmId: again.confirm.id }); // while "Stop …?" shows, "stop it" means yes
  assert.equal(yes.reply, 'Stopped Fix flaky checkout test.');
  assert.equal(runner.stopCalls, 1);
  assert.equal(t.store.get(id).state, 'stopped');
  await t.engine.shutdown();
});

test('command (real parser): a "Stop …?" card is withdrawn by the next command, so a later "yes" stops nothing', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { runner } = await started(t, { task: 'Fix the flaky checkout test so it stops timing out' });
  const card = await t.engine.command('stop the one timing out');
  assert.ok(card.confirm);
  await t.engine.command('what needs me', { confirmId: card.confirm.id });
  assert.equal((await t.engine.command('yes', { confirmId: card.confirm.id })).reply, 'That request is no longer waiting. Ask again if you still want it.');
  assert.equal((await t.engine.command('yes')).confirm, undefined);
  assert.equal(runner.stopCalls, 0);
  await t.engine.shutdown();
});

test('command (real parser): a message with no break after the name asks first', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  const { id, runner } = await started(t, { task: 'Fix the flaky checkout test' });
  const ask = await t.engine.command('tell the flaky test keep going');
  assert.equal(ask.reply, 'Tell Fix flaky checkout test “keep going”?');
  // Which one, in the person's own words, as on a stop card: two agents can have the same name.
  assert.equal(ask.confirm.detail, 'Its task: “Fix the flaky checkout test”');
  assert.deepEqual(runner.sent, []);
  assert.equal((await t.engine.command('hmm what', { confirmId: ask.confirm.id })).reply, 'I did not catch that. Say “do it” to send it, or “cancel”.');
  assert.equal((await t.engine.confirm(ask.confirm.id, true)).reply, 'Sent to Fix flaky checkout test.');
  assert.deepEqual(runner.sent, ['keep going']);
  const direct = await t.engine.command('tell the flaky test to use a longer timeout');
  assert.equal(direct.confirm, undefined);
  assert.deepEqual(runner.sent, ['keep going', 'use a longer timeout']);
  const no = await t.engine.command('tell the flaky test keep going');
  assert.equal((await t.engine.confirm(no.confirm.id, false)).reply, 'OK, I won’t send it.');
  assert.deepEqual(runner.sent, ['keep going', 'use a longer timeout']);
  // "send it", typed or said for the card on screen, sends it.
  const card = await t.engine.command('tell the flaky test try the fixture');
  assert.deepEqual(await t.engine.command('send it', { confirmId: card.confirm.id }), { reply: 'Sent to Fix flaky checkout test.', focusId: id });
  assert.deepEqual(runner.sent, ['keep going', 'use a longer timeout', 'try the fixture']);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ the demo, with the real simulator

/** A demo engine wired like bin/workbench.mjs --demo: the real Simulator, parser and Store. Time does not move. */
async function realDemo() {
  const store = new Store();
  let engine = null;
  const early = [];
  const sim = new Simulator({ emit: (ev) => (engine ? engine.ingest(ev) : early.push(ev)), now: () => Date.now(), speed: 1, seed: 1 });
  const { deps } = fakeDeps();
  deps.commands = commands;
  engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim }, machines: new FakeMachines({ demo: true }), deps, options: { tickMs: 10_000_000, simTickMs: 10_000_000 } });
  for (const ev of early.splice(0)) engine.ingest(ev);
  await engine.start();
  return { store, engine, sim, byName: (name) => store.list().find(a => a.name === name && !a.parentId) };
}

test('demo (real simulator): a message or a loose word never settles a permission, and a yes with conditions is a no', async () => {
  const t = await realDemo();
  const v = t.byName('Checkout fix');
  assert.equal(v.state, 'needs_ok');
  const askId = v.ask.id;
  const counted = { ...v.approvals }; // the view is live: keep the counts as they were
  // A message is only a message, even one that sounds like a yes; as in live mode, the request keeps waiting.
  assert.equal((await t.engine.say(v.id, 'go ahead and finish it')).ok, true);
  // Another ask's button, a typed "Yes", or no ask id at all: refused, and it keeps waiting.
  for (const [answer, id] of [['Yes', askId], ['Keep it working', askId], ['Stop it', askId], ['Allow', null]]) {
    assert.equal((await t.engine.answer(v.id, { askId: id, answer })).ok, false, `${answer} / ${id}`);
  }
  assert.equal(await t.engine.command('yes', { focusId: v.id }).then(r => r.reply), 'Have a look at what Checkout fix is asking first.');
  assert.equal(t.byName('Checkout fix').state, 'needs_ok');
  assert.equal(t.byName('Checkout fix').ask.id, askId);
  assert.deepEqual(t.byName('Checkout fix').approvals, counted);
  // A yes with conditions, typed for the request on screen: a no.
  const r = await t.engine.command('yes but only in the tests folder', { focusId: v.id, askId });
  assert.equal(r.reply, 'OK, Checkout fix will not do it as asked. I passed on your words.');
  const after = t.byName('Checkout fix');
  assert.equal(after.approvals.denied, counted.denied + 1);
  assert.equal(after.approvals.byYou, counted.byYou);
  assert.equal(after.state, 'working');
  // A stuck demo agent stops only on "Stop it": other words are a hint, by message or by answer.
  const f = t.byName('Flaky test');
  assert.equal(f.state, 'maybe_stuck');
  await t.engine.say(f.id, 'stop using the old fixture');
  assert.equal(t.byName('Flaky test').state, 'maybe_stuck', 'a message does not settle it');
  assert.equal((await t.engine.answer(f.id, { askId: f.ask.id, answer: 'stop using the old fixture' })).reply, 'Flaky test will try your hint.');
  assert.equal(t.byName('Flaky test').state, 'working');
  await t.engine.shutdown();
});

test('demo (real simulator): a plain yes for the request on screen allows it, in the same words as live mode', async () => {
  const t = await realDemo();
  const v = t.byName('Checkout fix');
  const byYou = v.approvals.byYou;
  // A question made of yes words first: it answers nothing.
  assert.match((await t.engine.command('is it okay', { focusId: v.id, askId: v.ask.id })).reply, /It needs your OK\.$/);
  assert.equal(t.byName('Checkout fix').state, 'needs_ok');
  const r = await t.engine.command('yes', { focusId: v.id, askId: v.ask.id });
  assert.equal(r.reply, 'OK, Checkout fix can go ahead.');
  assert.equal(t.byName('Checkout fix').approvals.byYou, byYou + 1);
  assert.equal(t.byName('Checkout fix').state, 'working');
  await t.engine.shutdown();
});

test('demo (real simulator): "Continue" on an agent launched in the demo and stopped says it cannot, instead of "Sent"', async () => {
  const t = await realDemo();
  const v = await t.engine.startAgent({ task: 'Fix the onboarding copy' });
  await t.engine.stop(v.id);
  assert.equal(t.store.get(v.id).state, 'stopped');
  const r = await t.engine.say(v.id, 'Please continue where you left off.');
  assert.deepEqual(r, { ok: false, reply: `${v.name} has stopped, so it cannot take messages.` });
  assert.equal(t.store.get(v.id).state, 'stopped', 'not "working" with nothing behind it');
  await t.engine.shutdown();
});

test('demo (real simulator): the Allow and Deny buttons reply in the same words as live mode', async () => {
  for (const [answer, reply] of [['Allow', 'OK, Checkout fix can go ahead.'], ['Deny', 'OK, Checkout fix will not do that.']]) {
    const t = await realDemo();
    const v = t.byName('Checkout fix');
    assert.deepEqual(await t.engine.answer(v.id, { askId: v.ask.id, answer }), { ok: true, reply });
    assert.equal(t.byName('Checkout fix').state, 'working');
    await t.engine.shutdown();
  }
});

// ------------------------------------------------------------------ spend

test('spend: a new agent has reported nothing yet, and a relaunch its limit would not cover is refused in plain words', async () => {
  const t = live();
  const { id, runner } = await started(t);
  assert.equal(t.store.get(id).usage.costUsd, null, 'not "$0": nothing has been reported');
  assert.equal(t.engine.snapshot().spendTodayEstimated, false);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  await t.engine.stop(id);
  runner.send = async () => { throw Object.assign(new Error('Fix login redirect has used its whole spending limit, so it can’t continue.'), { plain: true }); };
  const r = await t.engine.say(id, 'Please continue where you left off.');
  assert.deepEqual(r, { ok: false, reply: 'Fix login redirect has used its whole spending limit, so it can’t continue.' });
  assert.equal(t.store.get(id).state, 'stopped', 'it stays stopped');
  await t.engine.shutdown();
});

test('spend: under a cent reads "under $0.01", never "<$0.01" or "about <$0.01"', async () => {
  const t = live();
  const { id } = await started(t);
  t.deps.commands.intent = { kind: 'spend' };
  const spent = async () => (await t.engine.command('how much have I spent today')).reply;
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'add', unreportedUsd: 0.004 }); // the first seconds of a turn
  assert.equal(await spent(), 'You have spent under $0.01 today.');
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'set', costUsd: 0.003, unreportedUsd: 0 });
  assert.equal(await spent(), 'You have spent under $0.01 today.');
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'add', unreportedUsd: 0.009 });
  assert.equal(await spent(), 'You have spent about $0.01 today.');
  await t.engine.shutdown();

  const d = demo();
  await d.engine.start();
  d.engine.ingest({ kind: EV.CREATED, agentId: 'sim1', name: 'Docs', harness: 'claude', startedAt: Date.now() });
  d.engine.ingest({ kind: EV.USAGE, agentId: 'sim1', mode: 'set', costUsd: 0.002 });
  d.deps.commands.intent = { kind: 'spend' };
  assert.equal((await d.engine.command('how much have I spent today')).reply, 'The demo agents have spent under $0.01 today. It is simulated, so nothing was really spent.');
  await d.engine.shutdown();
});

// ------------------------------------------------------------------ the spending limit: one more for this run

const LIMIT_REASON = 'It reached its spending limit.';
const CONTINUE = 'Please continue where you left off.';
/** A root whose turn ended at its spending limit, as Claude Code's parser says it (a reason, no subtype). */
async function atLimit(t, opts = { task: 'Fix the cart total' }) {
  const a = await started(t, opts);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, reason: LIMIT_REASON });
  await until(() => t.store.get(a.id).state === 'failed');
  return a;
}

test('spending limit: a root at its limit is given one more, the default, for this run, and continues where it left off', async () => {
  const t = live();
  const a = await atLimit(t);
  assert.deepEqual([t.store.get(a.id).stateReason, t.store.get(a.id).atLimit, t.store.get(a.id).budgetUsd], [LIMIT_REASON, true, 2]);
  // What happened to the runner, in order: its process still waits for a message, and would keep the limit it was started
  // with, so it is closed first; the message then starts a new one, which gets the raised limit.
  const order = [];
  const { stop, send } = a.runner;
  a.runner.stop = async () => { order.push('stop'); return stop.call(a.runner); };
  a.runner.send = async (text) => { order.push(['send', text, a.runner.limit]); return send.call(a.runner, text); };
  const r = await t.engine.raiseLimit(a.id, { state: 'failed' });
  assert.deepEqual(r, { ok: true, reply: 'Fix cart total can spend $4.00 in all now, and it is continuing.' });
  assert.deepEqual(order, ['stop', ['send', CONTINUE, 4]]);
  const v = t.store.get(a.id);
  assert.deepEqual([v.state, v.budgetUsd, v.atLimit, v.now], ['working', 4, false, 'Picking up where it left off']);
  assert.ok(t.notices.includes(r.reply), 'the reply is also a notice');
  // It works on as any root does; at its new limit it can be given more again.
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, reason: LIMIT_REASON });
  await until(() => t.store.get(a.id).state === 'failed');
  assert.equal(t.store.get(a.id).atLimit, true);
  assert.equal((await t.engine.raiseLimit(a.id, { state: 'failed' })).reply, 'Fix cart total can spend $6.00 in all now, and it is continuing.');
  assert.equal(a.runner.limit, 6);
  // A launch's own limit is where its raises start; each raise is the run's default limit (--budget).
  const b = await atLimit(t, { task: 'Fix the tax rounding', budgetUsd: 0.5 });
  assert.equal((await t.engine.raiseLimit(b.id, { state: 'failed' })).reply, 'Fix tax rounding can spend $2.50 in all now, and it is continuing.');
  assert.deepEqual([b.runner.limit, t.store.get(b.id).budgetUsd], [2.5, 2.5]);
  await t.engine.shutdown();
});

test('spending limit: raised limits are whole cents, so three raises of $0.05 make $0.15, not 0.15000000000000002', async () => {
  const t = live({ defaultBudgetUsd: 0.05 });
  const a = await atLimit(t);
  for (let i = 0; i < 2; i++) {
    assert.equal((await t.engine.raiseLimit(a.id, { state: 'failed' })).ok, true);
    a.runner.emit({ kind: EV.TURN, phase: 'start' });
    a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, reason: LIMIT_REASON });
    await until(() => t.store.get(a.id).state === 'failed');
  }
  assert.deepEqual([a.runner.limit, t.store.get(a.id).budgetUsd], [0.15, 0.15]);
  await t.engine.shutdown();
});

test('spending limit: the turn may also say so with Claude Code’s own subtype, and its process may then exit, cleanly or with an error', async () => {
  for (const exit of ['ok', 'error']) {
    const t = live();
    const a = await started(t, { task: 'Fix the cart total' });
    a.runner.emit({ kind: EV.TURN, phase: 'start' });
    a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, subtype: 'error_max_budget_usd' });
    await until(() => t.store.get(a.id).state === 'failed');
    a.runner.alive = false;
    if (exit === 'ok') {
      a.runner.emit({ kind: EV.ENDED, outcome: 'ok' });
    } else {
      // as the runner reports a process that exits with an error: the tail of its stderr, then failed
      a.runner.emit({ kind: EV.ENDED, outcome: 'error', error: 'Error: the spending limit was reached' });
      a.runner.emit({ kind: EV.STATE, state: 'failed', reason: 'Claude Code stopped with an error (exit code 1).' });
    }
    await new Promise(r => setTimeout(r, 40)); // past exitGraceMs: a clean exit after a failed turn changes nothing
    const v = t.store.get(a.id);
    assert.deepEqual([v.state, v.atLimit], ['failed', true], `exit ${exit}: still at its limit`);
    assert.equal(v.stateReason, exit === 'ok' ? LIMIT_REASON : 'Claude Code stopped with an error (exit code 1).');
    assert.equal((await t.engine.raiseLimit(a.id, { state: 'failed' })).ok, true, exit);
    assert.equal(a.runner.stopCalls, 0, `exit ${exit}: no process was left to close`);
    assert.deepEqual([a.runner.sent, a.runner.limit], [[CONTINUE], 4], exit);
    await t.engine.shutdown();
  }
});

test('spending limit: refused, changing nothing, for an unknown or stale agent, one not at its limit, a helper, Codex and an earlier agent', async () => {
  const t = live();
  const a = await atLimit(t);
  const no = async (id, state, reply) => assert.deepEqual(await t.engine.raiseLimit(id, { state }), { ok: false, reply });
  await no('f00f00', 'failed', 'I can’t find that agent.');
  await no(a.id, 'working', 'That changed. Have another look.');
  // A helper spends from its agent's limit.
  t.engine.ingest({ kind: EV.CREATED, agentId: `${a.id}-h1`, parentId: a.id, name: 'Find tests', task: 'find', harness: 'claude' });
  t.engine.ingest({ kind: EV.STATE, agentId: `${a.id}-h1`, state: 'failed', reason: LIMIT_REASON });
  await no(`${a.id}-h1`, 'failed', 'Helpers share their agent’s spending limit. Give the agent more instead.');
  // Not at its limit: a failure for another reason, or no failure at all.
  const b = await started(t, { task: 'Fix the login redirect' });
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: '', backgroundTasks: 0, isError: true, reason: 'Claude Code reported a problem: API Error: 529 Overloaded' });
  await until(() => t.store.get(b.id).state === 'failed');
  await no(b.id, 'failed', 'Fix login redirect has not reached its spending limit.');
  await no(b.id, null, 'Fix login redirect has not reached its spending limit.');
  const c = await started(t, { task: 'Fix the tax rounding' });
  await no(c.id, null, 'Fix tax rounding has not reached its spending limit.');
  // Codex reports no cost, so it has no limit to raise, whatever words its failure used.
  const x = await started(t, { task: 'Write the parser tests', harness: 'codex' });
  x.runner.emit({ kind: EV.TURN, phase: 'start' });
  x.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'The budget for this account is used up.', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(x.id).state === 'failed');
  assert.equal(t.store.get(x.id).atLimit, false);
  await no(x.id, 'failed', `Codex reports no cost, so ${t.store.get(x.id).name} has no spending limit to raise.`);
  // An agent from an earlier run gets a new spending limit when it is continued.
  t.store.restore({ id: 'e1e1e1', name: 'Invoice export', task: 'Export invoices', harness: 'claude', state: 'failed', stateReason: LIMIT_REASON, budgetUsd: 2 }, { ok: true });
  await no('e1e1e1', 'failed', 'Invoice export is from an earlier run. Continue gives it a new spending limit for this run.');
  // An adapter whose runner cannot take a raised limit.
  const setLimit = a.runner.setLimit;
  a.runner.setLimit = undefined;
  await no(a.id, 'failed', 'Workbench cannot raise Fix cart total’s spending limit.');
  a.runner.setLimit = setLimit;
  // Nothing was raised, closed or sent.
  assert.deepEqual([a.runner.limit, a.runner.stopCalls, a.runner.sent, t.store.get(a.id).budgetUsd, t.store.get(a.id).state], [2, 0, [], 2, 'failed']);
  assert.ok(t.notices.includes('Fix login redirect has not reached its spending limit.'), 'a refusal is a notice too');
  await t.engine.shutdown();
});

test('spending limit: refused in the demo, where nothing is spent', async () => {
  const t = demo();
  await t.engine.start();
  const v = await t.engine.startAgent({ task: 'Fix the cart total' });
  const runner = t.sim.runners.at(-1);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'It stopped because it reached its budget of $2.00.', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(v.id).state === 'failed');
  assert.equal(t.store.get(v.id).stateReason, LIMIT_REASON);
  assert.deepEqual(await t.engine.raiseLimit(v.id, { state: 'failed' }), { ok: false, reply: 'This is the demo, so nothing is really spent.' });
  assert.deepEqual([runner.sent, runner.limit], [[], 2]);
  await t.engine.shutdown();
});

test('spending limit: a raise that starts nothing leaves every limit as it was; a second press waits for the first', async () => {
  const t = live();
  const a = await atLimit(t);
  const unchanged = () => {
    const v = t.store.get(a.id);
    assert.deepEqual([a.runner.limit, v.budgetUsd, v.state, v.atLimit], [2, 2, 'failed', true]);
  };
  a.runner.send = async () => { throw Object.assign(new Error('Claude Code was not found on this computer.'), { plain: true }); };
  assert.deepEqual(await t.engine.raiseLimit(a.id, { state: 'failed' }), { ok: false, reply: 'Claude Code was not found on this computer.' });
  unchanged();
  // One turn that went past its limit by more than a whole limit more (only with a small --budget): the runner still
  // finds less than a cent left, and says so in its own words. Nothing is raised, so pressing again does the same.
  a.runner.send = async () => { throw Object.assign(new Error('Fix cart total has used its whole spending limit, so it can’t continue.'), { plain: true }); };
  assert.deepEqual(await t.engine.raiseLimit(a.id, { state: 'failed' }), { ok: false, reply: 'Fix cart total has used its whole spending limit, so it can’t continue.' });
  unchanged();
  // Two presses at once (two tabs): the second hears that the first is under way, and the limit is raised once.
  const g = gate();
  a.runner.send = async (text) => { await g.wait; a.runner.sent.push(text); };
  const first = t.engine.raiseLimit(a.id, { state: 'failed' });
  await until(() => a.runner.limit === 4);
  assert.deepEqual(await t.engine.raiseLimit(a.id, { state: 'failed' }), { ok: false, reply: 'Fix cart total is already being picked up.' });
  g.open();
  assert.equal((await first).ok, true);
  assert.deepEqual([a.runner.limit, t.store.get(a.id).budgetUsd, a.runner.sent], [4, 4, [CONTINUE]]);
  await t.engine.shutdown();
});

test('spending limit: nothing is raised while its work is being merged', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await atLimit(t);
  const g = gate();
  t.git.mergeGate = g;
  const card = await t.engine.proposeMerge(a.id, { state: 'failed' });
  const yes = t.engine.confirm(card.confirm.id, true);
  await until(() => t.calls.mergeWork.length === 1);
  assert.deepEqual(await t.engine.raiseLimit(a.id, { state: 'failed' }), { ok: false, reply: 'Fix cart total is being merged now.' });
  g.open();
  await yes;
  assert.deepEqual([a.runner.limit, a.runner.sent], [2, []]);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ background work that is not a helper

const DEV = { helpers: 0, commands: 1, others: 0, work: ['Running the dev script'], ids: ['bq2k7x1m9'] };
async function leftRunning(t, background = DEV) {
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I started the dev server and the home page loads.', backgroundTasks: background.helpers + background.commands + background.others, background, isError: false });
  await until(() => t.store.get(id).state === 'waiting_helpers');
  return { id, runner, at: t.store.get(id).stateSince };
}

test('background: a root left waiting on a background command says so, and is asked once it has been quiet', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, at } = await leftRunning(t);
  const name = t.store.get(id).name;
  assert.equal(t.store.get(id).now, 'Waiting for a background command');
  assert.equal(t.engine._describe(t.store.get(id)), `${name} is waiting for a background command.`);
  t.engine.tick(at + 999);
  assert.equal(t.store.get(id).state, 'waiting_helpers');
  t.engine.tick(at + 1000);
  const v = t.store.get(id);
  assert.equal(v.state, 'maybe_stuck');
  assert.equal(v.ask.type, 'stuck');
  assert.equal(v.ask.about, 'background');
  assert.equal(v.ask.sentence, `${name} has finished, but a command it started is still running.`);
  assert.deepEqual(v.ask.options, ['It is done', 'Keep waiting']);
  assert.equal(v.ask.detail, 'Running the dev script');
  assert.equal(t.engine._describe(v), `${name} has finished, but a command it started is still running. Is it done, or should it keep waiting?`);
  assert.equal(t.engine._status().reply, `One thing needs you: ${name} left a command running.`);
  await t.engine.shutdown();
});

test('background: "It is done" builds the receipt; later turns do not wait again for that command, but do for a new one', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner, at } = await leftRunning(t);
  t.engine.tick(at + 1000);
  const out = await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'It is done' });
  assert.equal(out.ok, true);
  assert.match(out.reply, /keeps running until you stop/);
  await until(() => t.store.get(id).state === 'done_claimed');
  assert.equal(t.calls.diffStats.length, 1);
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).says, 'I started the dev server and the home page loads.');
  await t.engine.say(id, 'Also update the README.');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I updated the README.', backgroundTasks: 1, background: DEV, isError: false });
  await until(() => t.calls.diffStats.length === 2);
  await until(() => t.store.get(id).state === 'done_claimed');
  await t.engine.say(id, 'Now run the tests in the background.');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  const both = { helpers: 0, commands: 2, others: 0, work: ['Running the dev script', 'Running the tests'], ids: ['bq2k7x1m9', 'b0tests01'] };
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'The tests are running.', backgroundTasks: 2, background: both, isError: false });
  await until(() => t.store.get(id).state === 'waiting_helpers');
  assert.equal(t.store.get(id).now, 'Waiting for 2 background commands');
  await t.engine.shutdown();
});

test('background: "Keep waiting" goes back to waiting and is not asked again for that turn; typed answers work too', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  t.deps.commands.parseCommand = commands.parseCommand; // the real parser
  const { id, at } = await leftRunning(t);
  t.engine.tick(at + 1000);
  const askId = t.store.get(id).ask.id;
  const r = await t.engine.command('keep waiting', { focusId: id, askId });
  assert.equal(r.reply, `OK, ${t.store.get(id).name} keeps waiting.`);
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'not working: its turn is over');
  assert.equal(t.store.get(id).ask, null);
  t.engine.tick(at + 60_000);
  assert.equal(t.store.get(id).state, 'waiting_helpers');

  const b = await leftRunning(t, { ...DEV, ids: ['bother001'] });
  t.engine.tick(b.at + 1000);
  const done = await t.engine.command('it is done', { focusId: b.id, askId: t.store.get(b.id).ask.id });
  assert.match(done.reply, /^OK, .* is done\./);
  await until(() => t.store.get(b.id).state === 'done_claimed');
  await t.engine.shutdown();
});

test('background: a root waiting on a working helper is never asked; the quiet time starts when the last helper ends', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner } = await started(t);
  const helperId = `${id}-a1b2c3d4`;
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'Read docs', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Waiting for the helper.', backgroundTasks: 2, background: { helpers: 1, commands: 1, others: 0, work: ['Running the dev script'], ids: ['bq1'] }, isError: false });
  await until(() => t.store.get(id).state === 'waiting_helpers');
  assert.equal(t.store.get(id).now, 'Waiting for its helper and a background command');
  t.engine.tick(Date.now() + 10_000);
  assert.equal(t.store.get(id).state, 'waiting_helpers', 'never asked while a helper works');
  runner.emit({ kind: EV.BACKGROUND, helpers: 0, commands: 1, others: 0, work: ['Running the dev script'], ids: ['bq1'] });
  runner.emit({ kind: EV.ENDED, agentId: helperId, outcome: 'ok' });
  assert.equal(t.store.get(id).now, 'Waiting for a background command');
  const ended = t.store.get(helperId).endedAt;
  t.engine.tick(ended + 999);
  assert.equal(t.store.get(id).state, 'waiting_helpers');
  t.engine.tick(ended + 1000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  await t.engine.shutdown();
});

test('background: a new turn takes back the question, and a late answer to it is refused', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner, at } = await leftRunning(t);
  t.engine.tick(at + 1000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  const askId = t.store.get(id).ask.id;
  runner.emit({ kind: EV.TURN, phase: 'start' }); // the command ended and Claude Code started a turn by itself
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).now, 'Reading what came back');
  const late = await t.engine.answer(id, { askId, answer: 'It is done' });
  assert.equal(late.ok, false, 'the old question is gone');
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'The dev server stopped; everything else is done.', backgroundTasks: 0, background: { helpers: 0, commands: 0, others: 0, work: [], ids: [] }, isError: false });
  await until(() => t.store.get(id).state === 'done_claimed');
  await t.engine.shutdown();
});

test('background: a root whose background list emptied without a new turn is finished after the quiet time', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner } = await leftRunning(t);
  runner.emit({ kind: EV.BACKGROUND, helpers: 0, commands: 0, others: 0, work: [], ids: [] });
  assert.equal(t.store.get(id).now, 'Its background work is done');
  t.engine.tick(Date.now() + 1000);
  await until(() => t.store.get(id).state === 'done_claimed');
  assert.equal(t.calls.diffStats.length, 1);
  assert.equal(t.store.get(id).ask, null);
  await t.engine.shutdown();
});

test('background: a root asked about background work whose process exits is marked failed and the question goes away', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id, runner, at } = await leftRunning(t);
  t.engine.tick(at + 1000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  runner.alive = false;
  runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(id).state === 'failed');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.engine.asks.size, 0);
  await t.engine.shutdown();
});

test('background: after "It is done" the root is working while its checks run, never "might be stuck"; a turn that starts then is watched as usual', async () => {
  const checksGate = gate();
  const t = live({ deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate }, options: { stuckSilenceMs: 1000 } });
  const { id, runner, at } = await leftRunning(t);
  t.engine.tick(at + 1000);
  const out = await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'It is done' });
  assert.equal(out.ok, true);
  await until(() => t.calls.runChecks.length === 1);
  let v = t.store.get(id);
  assert.equal(v.state, 'working', 'its receipt is built while it is working, as after any turn');
  assert.equal(v.ask, null);
  assert.equal(v.stateReason, null);
  assert.equal(v.checks.state, 'running');
  assert.equal(t.engine._status().reply, 'Nothing needs you right now. One agent is working.');
  t.engine.tick(Math.max(v.lastEventAt, v.stateSince) + 60_000);
  assert.equal(t.store.get(id).state, 'working', 'not flagged while its receipt is built');

  // Claude Code starts a turn during the checks (a follow-up, or by itself when the command ended).
  runner.emit({ kind: EV.TURN, phase: 'start' });
  v = t.store.get(id);
  assert.equal(v.state, 'working');
  assert.deepEqual(v.checks, { state: 'none', results: [] }, 'the old receipt is cancelled');
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Editing README.md', toolKind: 'edit', toolUseId: 't2' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'end', toolUseId: 't2', ok: true });
  v = t.store.get(id);
  t.engine.tick(Math.max(v.lastEventAt, v.stateSince) + 1000);
  v = t.store.get(id);
  assert.equal(v.state, 'maybe_stuck', 'a quiet turn is flagged by the usual silence rule');
  assert.equal(v.ask.about, undefined);
  assert.deepEqual(v.ask.options, ['Stop it', 'Let it keep trying']);
  checksGate.open();
  await t.engine.shutdown();
});

test('background: an answer that comes just after its process ended is refused plainly, and the root is marked failed', async () => {
  for (const answer of ['It is done', 'Keep waiting']) {
    const t = live({ options: { stuckSilenceMs: 1000, exitGraceMs: 300 } });
    const { id, runner, at } = await leftRunning(t);
    const name = t.store.get(id).name;
    t.engine.tick(at + 1000);
    const askId = t.store.get(id).ask.id;
    runner.alive = false;
    runner.emit({ kind: EV.ENDED, outcome: 'ok' }); // whatever it left running ended with it
    const out = await t.engine.answer(id, { askId, answer });
    assert.deepEqual(out, { ok: false, reply: `${name} stopped running before your answer reached it.` }, answer);
    assert.notEqual(t.store.get(id).state, 'working', answer);
    assert.notEqual(t.store.get(id).state, 'waiting_helpers', answer);
    await until(() => t.store.get(id).state === 'failed');
    assert.equal(t.store.get(id).stateReason, 'It stopped before finishing its work.');
    assert.equal(t.store.get(id).ask, null);
    assert.equal(t.engine.asks.size, 0);
    assert.equal(t.calls.diffStats.length, 0, 'no receipt for work that never finished');
    await t.engine.shutdown();
  }
});

test('a root flagged "might be stuck" mid-turn that then exits cleanly becomes failed, and the ask is cleared', async () => {
  const t = live({ options: { stuckSilenceMs: 1000, exitGraceMs: 30 } });
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.ACTIVITY, phase: 'start', sentence: 'Running the tests', toolKind: 'run', toolUseId: 't1' });
  const v0 = t.store.get(id);
  t.engine.tick(Math.max(v0.lastEventAt, v0.stateSince) + 1000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  assert.equal(t.store.get(id).ask.type, 'stuck');
  runner.alive = false;
  runner.emit({ kind: EV.ENDED, outcome: 'ok' });
  await until(() => t.store.get(id).state === 'failed');
  assert.equal(t.store.get(id).stateReason, 'It stopped before finishing its work.');
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.engine.asks.size, 0);
  await t.engine.shutdown();
});

test('a root that stays "starting" and prints nothing is flagged as quiet', async () => {
  const t = live({ options: { stuckSilenceMs: 1000 } });
  const { id } = await started(t);
  const v = t.store.get(id);
  assert.equal(v.state, 'starting');
  t.engine.tick(Math.max(v.lastEventAt, v.stateSince) + 1000);
  assert.equal(t.store.get(id).state, 'maybe_stuck');
  assert.equal(t.store.get(id).ask.type, 'stuck');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ snapshot

test('snapshot has the contract fields, including repo and harness availability', async () => {
  const t = live();
  await t.engine.start();
  const { id } = await started(t);
  t.engine.ingest({ kind: EV.USAGE, agentId: id, mode: 'set', costUsd: 0.1 });
  const s = t.engine.snapshot();
  assert.equal(s.mode, 'live');
  // identity: git knows the person's name and email (read at start and on every refresh), so Workbench can merge.
  assert.deepEqual(s.repo, { name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 2, identity: true });
  assert.deepEqual(s.harnesses, { claude: true, codex: true, sim: false });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].id, id);
  assert.deepEqual(s.machines.map(m => m.id), ['laptop']);
  assert.equal(s.spendTodayUsd, 0.1);
  assert.equal(s.defaultBudgetUsd, 2);
  await t.engine.shutdown();
});

test('live mode without a repo explains itself', async () => {
  const store = new Store();
  const { deps } = fakeDeps();
  const engine = new Engine({ store, mode: 'live', repo: null, adapters: { claude: fakeAdapter('claude') }, deps });
  await assert.rejects(engine.start(), /needs a git repository/);
  await engine.shutdown();
});

// ------------------------------------------------------------------ source control: merge

const GONE_REPLY = 'That request is no longer waiting. Ask again if you still want it.';

test('merge: the card asks first, counts first, and binds itself to the work it showed', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  t.git.work.files = [
    { path: 'src/cart.js', status: 'modified', adds: 30, dels: 2 },
    { path: 'src/total.js', status: 'added', adds: 8, dels: 0 },
    { path: 'README.md', status: 'modified', adds: 2, dels: 0 },
  ];
  const before = t.notices.length;
  const out = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  assert.equal(out.reply, 'Merge Fix cart total into main?');
  assert.match(out.confirm.id, /^[0-9a-f]{12}$/);
  assert.deepEqual({ ...out.confirm, id: null }, {
    id: null, kind: 'merge', sentence: 'Merge Fix cart total into main?', yes: 'Merge', no: 'Cancel', danger: false, agentId: a.id,
    detail: '3 files, +40 −2. Its work becomes a commit on its branch, joined into main by a merge commit. Nothing checked its work. Your 2 uncommitted changes stay as they are.',
  });
  assert.equal(t.notices.length, before, 'a card is not announced');
  // It read the work as it is now, from where its unmerged work starts.
  assert.deepEqual(t.calls.snapshotWork.at(-1), { repoRoot: REPO.root, path: a.v.workspace, since: FAKE_BASE });
  const stored = t.engine.confirms.get(out.confirm.id);
  assert.equal(stored.agentId, a.id);
  assert.deepEqual(stored.expect, { workId: `${FAKE_BASE}:tree0`, into: 'main', intoHead: FAKE_BASE });
  assert.equal(t.calls.mergeWork.length, 0, 'nothing is merged before the yes');
  await t.engine.shutdown();
});

test('finished work: "Not now" leaves the agent as it is, sends it nothing, and the reply is no approval', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const before = a.runner.sent.length;
  const out = await t.engine.answer(a.id, { answer: 'Not now' });
  assert.equal(out.ok, true);
  assert.equal(out.reply, `OK. ${a.v.name}’s work stays on its branch for now.`);
  assert.equal(a.runner.sent.length, before, '"Not now" is not a message for the agent');
  assert.equal(t.store.get(a.id).state, 'done_claimed');
  const good = await t.engine.answer(a.id, { answer: 'Looks good' });
  assert.equal(good.reply, `Good. ${a.v.name} stays as it is.`);
  await t.engine.shutdown();
});

test('merge: work that would bring in no files is already in the branch, and no card asks about it', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  t.git.work.files = []; // it differs from where it started, but merging it brings in nothing (merged by hand, say)
  const out = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  assert.equal(out.confirm, undefined);
  assert.equal(out.ok, false);
  assert.equal(out.reply, 'Fix cart total’s work is already in main.');
  assert.equal(t.engine.confirms.size, 0);
  assert.equal(t.calls.mergeWork.length, 0);
  await t.engine.shutdown();
});

test('merge: the card names failed checks, broken rules, files that set later agents, files left out and the person’s own changes', async (ctx) => {
  const t = liveFolders(ctx, { deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checkState: 'failed', rules: [{ say: 'Do not touch migrations/', paths: ['migrations/**'] }] } });
  // Rules are checked again against the files it would merge now, not only the last receipt's.
  t.deps.receipt.checkRules = (rs, paths) => ({ kept: [], broken: paths.some(p => p.startsWith('migrations/')) ? rs.map(r => ({ say: r.say, paths: [] })) : [] });
  const a = await doneAgent(t);
  assert.equal(t.store.get(a.id).state, 'checks_failed');
  t.git.dirty = 1;
  t.git.work.files = [
    { path: 'migrations/001.sql', status: 'added', adds: 4, dels: 0 },
    { path: 'workbench.json', status: 'modified', adds: 1, dels: 1 },
    { path: 'app/.claude/settings.json', status: 'added', adds: 3, dels: 0 },
    { path: '.mcp.json', status: 'added', adds: 5, dels: 0 },
  ];
  t.git.work.left = [{ path: '.env', why: 'ignored' }, { path: 'dist/app.js', why: 'ignored' }, { path: 'vendor/lib', why: 'nested-repo' }];
  const out = await t.engine.proposeMerge(a.id, { state: 'checks_failed' });
  assert.equal(out.confirm.detail, [
    '4 files, +13 −1. Its work becomes a commit on its branch, joined into main by a merge commit.',
    'A check failed: unit tests.',
    'It broke a rule you set: Do not touch migrations/.',
    'It changes workbench.json, which sets the checks for later agents.',
    'It changes .claude/, which holds Claude Code’s settings for this repository.',
    'It changes .mcp.json, which can give Claude Code new tools here.',
    '2 files stay out: hidden by a .gitignore.',
    '1 folder stays out: it is a git repository of its own.',
    'Your 1 uncommitted change stays as it is.',
  ].join(' '));
  await t.engine.shutdown();

  // Checks that passed say nothing, nor does a workbench.json in a subfolder (only the one at the top sets checks).
  const t2 = liveFolders(ctx, { deps: { checks: [{ name: 'unit tests', run: 'npm test' }] } });
  const b = await doneAgent(t2);
  assert.equal(t2.store.get(b.id).state, 'done_checked');
  t2.git.dirty = 0;
  t2.git.work.files = [{ path: 'docs/workbench.json', status: 'added', adds: 2, dels: 0 }, { path: 'a.claude.txt', status: 'added', adds: 1, dels: 0 }];
  const out2 = await t2.engine.proposeMerge(b.id);
  assert.equal(out2.confirm.detail, '2 files, +3 −0. Its work becomes a commit on its branch, joined into main by a merge commit.');
  await t2.engine.shutdown();
});

test('merge: refusals come in plain words, are announced, and leave nothing behind', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const refused = async (id, opts, reply) => {
    const before = t.notices.length;
    const out = await t.engine.proposeMerge(id, opts);
    assert.deepEqual(out, { ok: false, reply }, reply);
    assert.deepEqual(t.notices.slice(before), [reply], 'a refusal from a button is announced');
  };
  await refused('nobody', {}, 'I can’t find that agent.');
  // A helper works in its agent's folder.
  t.engine.ingest({ kind: EV.CREATED, agentId: `${a.id}-h1`, parentId: a.id, name: 'Find tests', task: 'find', harness: 'claude' });
  await refused(`${a.id}-h1`, {}, 'Helpers work in their agent’s folder. Merge the agent instead.');
  // The page drew its button for another state.
  await refused(a.id, { state: 'done_checked' }, 'That changed. Have another look.');
  // Nothing to merge: it never changed anything (after a merge, the words are "already in": see below).
  t.git.work.changed = false;
  await refused(a.id, {}, 'Fix cart total changed nothing, so there is nothing to merge.');
  t.git.work.changed = true;
  // The person's folder is not on a branch; git does not know who they are.
  t.git.branch = null;
  await refused(a.id, {}, 'Your folder is not on a branch, so there is nowhere to merge it.');
  t.git.branch = 'main';
  t.git.identity = null;
  await refused(a.id, {}, 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.');
  assert.equal(t.engine.snapshot().repo.identity, false, 'the page hears it too');
  t.git.identity = { name: 'Test Person', email: 'test@example.com' };
  // An older workspace module that cannot merge gives a plain refusal, never a crash.
  const mergeWork = t.deps.workspace.mergeWork;
  delete t.deps.workspace.mergeWork;
  await refused(a.id, {}, 'Workbench cannot merge work right now.');
  t.deps.workspace.mergeWork = mergeWork;
  // Its folder is gone.
  fs.rmSync(a.v.workspace, { recursive: true, force: true });
  await refused(a.id, {}, 'Its folder is gone, so there is nothing to merge.');
  assert.equal(t.store.get(a.id).work.folder, false, 'its view says so');
  assert.equal(t.calls.mergeWork.length, 0);
  assert.equal(t.engine.confirms.size, 0, 'no card was kept');
  await t.engine.shutdown();
});

test('merge: an agent at work, or whose receipt is being built, is not merged until it is done', async (ctx) => {
  const checksGate = gate();
  const t = liveFolders(ctx, { deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checksGate } });
  const { id, runner } = await started(t);
  assert.deepEqual(await t.engine.proposeMerge(id), { ok: false, reply: 'Fix login redirect is still working. Merge it when it is done.' });
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).checks?.state === 'running');
  assert.deepEqual(await t.engine.proposeMerge(id), { ok: false, reply: 'Fix login redirect is still working. Merge it when it is done.' });
  checksGate.open();
  await until(() => t.store.get(id).state === 'done_checked');
  assert.ok((await t.engine.proposeMerge(id)).confirm);
  await t.engine.shutdown();
});

test('merge: yes merges once, records it, counts its work from the merged commit and tells the page', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const repoEvents = [];
  t.store.on('repo', r => repoEvents.push(r));
  const out = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  const yes = await t.engine.confirm(out.confirm.id, true);
  assert.deepEqual(yes, { reply: 'Merged Fix cart total into main.', focusId: a.id });
  assert.equal(t.notices.at(-1), 'Merged Fix cart total into main.');
  assert.deepEqual(t.calls.mergeWork, [{
    repoRoot: REPO.root, path: a.v.workspace, branch: `workbench/fix-cart-total-${a.id}`, since: FAKE_BASE,
    expect: { workId: `${FAKE_BASE}:tree0`, into: 'main', intoHead: FAKE_BASE },
    message: { subject: 'Fix the cart total', body: 'I fixed the cart total.', name: 'Fix cart total' },
    agentId: a.id, harness: 'claude',
  }]);
  const v = t.store.get(a.id);
  assert.ok(Number.isFinite(v.work.merged.at));
  assert.deepEqual(v.work, {
    branch: `workbench/fix-cart-total-${a.id}`, from: 'main', folder: true,
    merged: { into: 'main', merge: FAKE_MERGE, at: v.work.merged.at, files: 1, adds: 3, dels: 1 }, problem: null, thrownAway: null,
  });
  assert.deepEqual(v.files, { changed: 0, adds: 0, dels: 0, list: [] }, 'nothing is left unmerged');
  assert.equal(v.state, 'done_claimed', 'it stays as it was');
  assert.equal(t.engine.runs.get(a.id).workspace.since, FAKE_WORK, 'its unmerged work now starts at the merged work commit');
  assert.deepEqual(repoEvents, [{ name: 'shop', head: FAKE_MERGE, branch: 'main', dirty: 2, identity: true }]);
  assert.equal(t.engine.snapshot().repo.head, FAKE_MERGE);
  // A second yes to the same card finds nothing.
  assert.equal((await t.engine.confirm(out.confirm.id, true)).reply, GONE_REPLY);
  assert.equal(t.calls.mergeWork.length, 1);
  // It can take a follow-up in the same folder; its next receipt counts from the merged commit, and so does the tidy.
  const sent = await t.engine.say(a.id, 'Also round the tax');
  assert.equal(sent.ok, true, sent.reply);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Rounded.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'done_claimed');
  assert.equal(t.calls.diffStats.at(-1).base, FAKE_WORK);
  assert.equal(t.store.get(a.id).work.merged.merge, FAKE_MERGE, 'the last merge is still known');
  await t.engine.shutdown();
  // The tidy tells git where it started (base) and where its unmerged work starts (since: the merged work commit).
  const tidy = t.calls.removeWorkspace.at(-1);
  assert.deepEqual([tidy.path, tidy.base, tidy.since, tidy.onlyIfUnchanged, tidy.deleteBranch], [a.v.workspace, FAKE_BASE, FAKE_WORK, true, true]);
});

test('merge: when what merging would bring in changed since the card, the git module\'s own words say so', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  t.git.mergeResult = { ok: false, why: 'changed', sentence: 'What merging it would change in main is no longer what you saw. Have another look.' };
  const card = await t.engine.proposeMerge(a.id);
  const out = await t.engine.confirm(card.confirm.id, true);
  assert.equal(out.reply, 'What merging it would change in main is no longer what you saw. Have another look.');
  // its own folder on another branch: "Its" is the agent's name
  t.git.mergeResult = { ok: false, why: 'changed', sentence: 'Its folder is on the branch other now, not on workbench/fix-cart-total.' };
  const card2 = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.confirm(card2.confirm.id, true)).reply, 'Fix cart total’s folder is on the branch other now, not on workbench/fix-cart-total.');
  await t.engine.shutdown();
});

test('merge: a merge that does not go through says why in plain words, and keeps the reason on the agent while it applies', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const attempt = async (result) => {
    t.git.mergeResult = result;
    const card = await t.engine.proposeMerge(a.id);
    assert.ok(card.confirm, card.reply);
    return t.engine.confirm(card.confirm.id, true);
  };
  const work = () => t.store.get(a.id).work;
  // Every reason the git module gives, in the engine's words: the agent's name and the branch, never git's own text.
  const cases = [
    ['conflict', ['src/cart.js', 'src/total.js'], 'Fix cart total’s work does not merge cleanly into main.', true],
    ['blocked', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'], 'Your own changes are in the way: a.js, b.js, c.js and 2 more. Commit or put them aside, then merge again.', true],
    ['blocked', ['notes.txt'], 'Your own changes are in the way: notes.txt. Commit or put them aside, then merge again.', true],
    ['ancestry', [], 'Fix cart total started from a commit that is no longer in main, so merging it would bring in other work.', true],
    ['moved', [], 'main changed since you looked. Have another look.', true],
    ['identity', [], 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.', true],
    ['detached', [], 'Your folder is not on a branch, so there is nowhere to merge it.', true],
    ['busy', [], 'Your folder is in the middle of a merge or rebase. Finish that first.', true],
    ['git', [], 'Git could not finish the merge. Nothing in your folder changed.', true],
    ['something new', [], 'Git could not finish the merge. Nothing in your folder changed.', true], // read as 'git'
    ['git-old', [], 'Workbench needs git 2.38 or newer to merge.', false],
    ['changed', [], 'Fix cart total’s work changed since you looked. Have another look.', false],
    // Already in (merged by hand, say): nothing is left to merge, so a reason from before no longer holds.
    ['nothing', [], 'Fix cart total’s work is already in main.', 'cleared'],
  ];
  for (const [why, paths, sentence, kept] of cases) {
    const before = work().problem;
    const out = await attempt({ ok: false, why, ...(paths.length ? { paths } : {}) });
    assert.deepEqual(out, { reply: sentence, focusId: a.id }, why);
    assert.equal(t.notices.at(-1), sentence);
    if (kept === true) {
      const p = work().problem;
      assert.deepEqual({ ...p, at: 0 }, { why: why === 'something new' ? 'git' : why, sentence, paths, into: 'main', at: 0 }, why); // into: the branch it was going into, for the conflict lid
      assert.ok(Number.isFinite(p.at));
    } else if (kept === 'cleared') {
      assert.ok(before, 'there was a reason before');
      assert.equal(work().problem, null, `${why} clears the last reason`);
    } else {
      assert.deepEqual(work().problem, before, `${why} leaves the last reason as it was`);
    }
    assert.equal(work().merged, null);
  }
  // For a busy folder and for git's own trouble, the git module's words say what really happened: they are kept.
  for (const [why, said, sentence] of [
    ['busy', 'Another git command is busy in your folder. Try again in a moment.', 'Another git command is busy in your folder. Try again in a moment.'],
    ['git', 'Git reported the merge as done, but main does not hold it. Have a look at your folder.', 'Git reported the merge as done, but main does not hold it. Have a look at your folder.'],
    ['git', 'Its folder is in the middle of a merge or rebase, so its work cannot be merged yet.', 'Fix cart total’s folder is in the middle of a merge or rebase, so its work cannot be merged yet.'],
  ]) {
    assert.equal((await attempt({ ok: false, why, sentence: said })).reply, sentence);
    assert.equal(work().problem.sentence, sentence);
  }
  // Git trouble the module did not expect: say so, and never claim the folder is untouched.
  t.git.mergeResult = null;
  t.git.mergeError = new Error('spawn git ENOENT');
  const card = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Something went wrong during the merge. Have a look at your folder before you try again.');
  assert.equal(work().problem.why, 'git');
  t.git.mergeError = null;
  // Its folder gone: its view says so, and nothing is kept as a reason.
  const lastProblem = work().problem;
  assert.equal((await attempt({ ok: false, why: 'gone', sentence: 'Its folder is gone, so there is nothing to merge.' })).reply, 'Its folder is gone, so there is nothing to merge.');
  assert.equal(work().folder, false);
  assert.deepEqual(work().problem, lastProblem);
  await t.engine.shutdown();
});

test('merge: the reason a merge did not go through clears on a turn start, a message it takes, the next merge and a throw-away', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const conflict = async () => {
    t.git.mergeResult = { ok: false, why: 'conflict', sentence: 'Its work does not merge cleanly into main.', paths: ['src/cart.js'] };
    const card = await t.engine.proposeMerge(a.id);
    await t.engine.confirm(card.confirm.id, true);
    t.git.mergeResult = null;
    assert.equal(t.store.get(a.id).work.problem.why, 'conflict');
  };
  const finish = async (text) => {
    a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: text, backgroundTasks: 0, isError: false });
    await until(() => t.store.get(a.id).state === 'done_claimed');
  };
  // A turn it starts by itself. (A failed merge closes its process first, so here the reason comes as an event, as
  // the demo's simulator sends it, to an agent whose process is still there.)
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'Done.');
  const problem = { why: 'conflict', sentence: 'Fix tax rounding’s work does not merge cleanly into main.', paths: ['src/tax.js'], at: 1 };
  t.engine.ingest({ kind: EV.WORK, agentId: b.id, work: { ...t.store.get(b.id).work, problem } });
  assert.deepEqual(t.store.get(b.id).work.problem, problem);
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  assert.equal(t.store.get(b.id).work.problem, null);
  // A message it takes.
  await conflict();
  const sent = await t.engine.say(a.id, 'Your work conflicts with the latest main in: src/cart.js. Please merge main into your branch.');
  assert.equal(sent.ok, true, sent.reply);
  assert.equal(t.store.get(a.id).work.problem, null);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  await finish('I brought in main.');
  // The next merge that goes through.
  await conflict();
  const card = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Merged Fix cart total into main.');
  assert.equal(t.store.get(a.id).work.problem, null);
  assert.equal(t.store.get(a.id).work.merged.merge, FAKE_MERGE);
  // A throw-away.
  t.git.work.changed = true;
  await conflict();
  const away = await t.engine.proposeDiscard(a.id);
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away /);
  assert.equal(t.store.get(a.id).work.problem, null);
  await t.engine.shutdown();
});

test('merge: after a merge that made its work commit but did not go through, the next card binds to the work as it is now', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  // A conflict is found after its work became a commit on its branch: its folder's HEAD moved, so its work id did.
  t.git.mergeResult = () => {
    t.git.agentHead = FAKE_WORK;
    return { ok: false, why: 'conflict', sentence: 'Its work does not merge cleanly into main.', paths: ['src/cart.js'] };
  };
  const first = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.confirm(first.confirm.id, true)).reply, 'Fix cart total’s work does not merge cleanly into main.');
  assert.equal(t.engine.runs.get(a.id).workspace.since, FAKE_BASE, 'nothing was merged: its work still starts where it started');
  t.git.mergeResult = null;
  // The old card's work id is gone for good; a new card binds to the new one, and merges.
  const second = await t.engine.proposeMerge(a.id);
  assert.equal(t.engine.confirms.get(second.confirm.id).expect.workId, `${FAKE_WORK}:tree0`);
  assert.equal((await t.engine.confirm(second.confirm.id, true)).reply, 'Merged Fix cart total into main.');
  assert.equal(t.store.get(a.id).work.problem, null);
  await t.engine.shutdown();
});

test('merge: the yes checks everything again: a card answered after the agent worked on, ended otherwise or ran out merges nothing', async (ctx) => {
  let now = 1_700_000_000_000;
  const t = liveFolders(ctx, { options: { now: () => now } });
  const a = await doneAgent(t);
  // Cancel.
  const c0 = await t.engine.proposeMerge(a.id);
  assert.deepEqual(await t.engine.confirm(c0.confirm.id, false), { reply: 'OK, I won’t merge it.' });
  // It went back to work after the card was shown.
  const c1 = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.say(a.id, 'One more thing')).ok, true);
  assert.deepEqual(await t.engine.confirm(c1.confirm.id, true), { reply: 'Fix cart total is still working. Merge it when it is done.', focusId: a.id });
  // It ended otherwise than the card said: the card described something else.
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  const c2 = await t.engine.proposeMerge(a.id);
  assert.equal(c2.reply, 'Fix cart total is still working. Merge it when it is done.');
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Fixed.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'done_claimed');
  const c3 = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'It broke.', backgroundTasks: 0, isError: true });
  await until(() => t.store.get(a.id).state === 'failed');
  assert.deepEqual(await t.engine.confirm(c3.confirm.id, true), { reply: 'That changed. Have another look.', focusId: a.id });
  // Ten minutes on, a card is no longer waiting.
  const c4 = await t.engine.proposeMerge(a.id);
  assert.ok(c4.confirm, c4.reply);
  now += 10 * 60_000 + 1;
  assert.deepEqual(await t.engine.confirm(c4.confirm.id, true), { reply: GONE_REPLY });
  // Its work changed after the card was shown: git refuses, in the engine's words.
  const c5 = await t.engine.proposeMerge(a.id);
  t.git.seq += 1;
  assert.deepEqual(await t.engine.confirm(c5.confirm.id, true), { reply: 'Fix cart total’s work changed since you looked. Have another look.', focusId: a.id });
  assert.equal(t.store.get(a.id).work.merged, null);
  await t.engine.shutdown();
});

test('merge: one git job at a time, engine-wide; while its merge waits or runs an agent is busy, and nothing may wake, stop or merge it', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'I fixed the rounding.');
  const g = gate();
  t.git.mergeGate = g;
  const ca = await t.engine.proposeMerge(a.id);
  const cb = await t.engine.proposeMerge(b.id);
  const ya = t.engine.confirm(ca.confirm.id, true);
  await until(() => t.calls.mergeWork.length === 1);
  const yb = t.engine.confirm(cb.confirm.id, true);
  assert.equal(await settled(yb), false, 'the second merge waits its turn');
  assert.equal(t.calls.mergeWork.length, 1, 'git has not been asked about it yet');
  // Busy, both of them: the one being merged and the one waiting its turn.
  assert.deepEqual(await t.engine.say(a.id, 'Also the docs'), { ok: false, reply: 'Fix cart total is being merged now.' });
  assert.deepEqual(await t.engine.stop(a.id), { ok: false, reply: 'Fix cart total is being merged now.' });
  assert.deepEqual(await t.engine.proposeMerge(a.id), { ok: false, reply: 'Fix cart total is being merged now.' });
  assert.deepEqual(await t.engine.proposeDiscard(b.id), { ok: false, reply: 'Fix tax rounding is being merged now.' });
  assert.deepEqual(await t.engine.answer(b.id, { answer: 'Please also round down' }), { ok: false, reply: 'Fix tax rounding is being merged now.' });
  t.deps.commands.intent = { kind: 'stop_all' };
  assert.equal((await t.engine.command('stop everything')).reply, 'Nothing is running.');
  assert.deepEqual([a.runner.sent, b.runner.sent], [[], []], 'no message reached either');
  g.open();
  assert.deepEqual(await ya, { reply: 'Merged Fix cart total into main.', focusId: a.id });
  // The second ran only once the first was done, so git saw the branch the first one moved.
  assert.deepEqual(await yb, { reply: 'main changed since you looked. Have another look.', focusId: b.id });
  assert.equal(t.calls.mergeWork.length, 2);
  assert.equal(t.store.get(b.id).work.problem.why, 'moved');
  // No longer busy.
  assert.equal((await t.engine.say(b.id, 'Please also round down')).ok, true);
  await t.engine.shutdown();
});

test('merge (real git): two pages hold cards for one agent; once one merges it, the other page’s cards are gone and nothing is kept on merged work', async (ctx) => {
  const t = await realGit(ctx);
  const a = await started(t, { task: 'Fix the cart total' });
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'export const total = 2;\n');
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart total.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'done_claimed', { timeout: 10_000 });
  // Page A and page B each ask to merge it; page B also asks to throw it away.
  const pageA = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  const pageB = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  const away = await t.engine.proposeDiscard(a.id, { state: 'done_claimed' });
  assert.ok(pageA.confirm && pageB.confirm && away.confirm, `${pageA.reply} | ${pageB.reply} | ${away.reply}`);
  assert.deepEqual(await t.engine.confirm(pageA.confirm.id, true), { reply: 'Merged Fix cart total into main.', focusId: a.id });
  const merge = t.git('rev-parse', 'HEAD');
  assert.equal(t.git('show', 'HEAD:cart.js'), 'export const total = 2;');
  // Page B's cards describe work that is merged now: they are no longer waiting, and nothing happens.
  assert.deepEqual(await t.engine.confirm(pageB.confirm.id, true), { reply: GONE_REPLY });
  assert.deepEqual(await t.engine.confirm(away.confirm.id, true), { reply: GONE_REPLY });
  assert.equal(t.git('rev-parse', 'HEAD'), merge);
  assert.equal(fs.existsSync(path.join(a.v.workspace, 'cart.js')), true, 'its folder is still there');
  const w = t.store.get(a.id).work;
  assert.equal(w.problem, null, 'merged work is not marked as not merged');
  assert.equal(w.merged.into, 'main');
  assert.equal(w.thrownAway, null);
  // Asked again, it says plainly that the work is in already.
  assert.deepEqual(await t.engine.proposeMerge(a.id), { ok: false, reply: 'Fix cart total’s work is already in main.' });
  await t.engine.shutdown();
});

test('merge: a card made from a look taken just before the agent was merged says its work is in already, and keeps no reason on it', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const pageA = await t.engine.proposeMerge(a.id);
  // Page B asks while git still reads the work, and page A's yes merges it meanwhile: page B's card is made after
  // the merge, from what git read before it.
  const reading = gate();
  const snapshot = t.deps.workspace.snapshotWork;
  t.deps.workspace.snapshotWork = async (o) => {
    const s = await snapshot(o);
    await reading.wait;
    return s;
  };
  const asking = t.engine.proposeMerge(a.id);
  await until(() => t.calls.snapshotWork.length === 2);
  t.deps.workspace.snapshotWork = snapshot;
  assert.equal((await t.engine.confirm(pageA.confirm.id, true)).reply, 'Merged Fix cart total into main.');
  reading.open();
  const pageB = await asking;
  assert.ok(pageB.confirm, pageB.reply);
  // git refuses it because main moved, which it did: by this agent's own merge. Nothing went wrong.
  assert.deepEqual(await t.engine.confirm(pageB.confirm.id, true), { reply: 'Fix cart total’s work is already in main.', focusId: a.id });
  assert.equal(t.calls.mergeWork.at(-1).expect.intoHead, FAKE_BASE, 'git was asked, and refused it as moved');
  assert.equal(t.store.get(a.id).work.problem, null);
  assert.equal(t.store.get(a.id).work.merged.merge, FAKE_MERGE);
  await t.engine.shutdown();
});

test('merge: on merged work whose newer files Workbench could not read, a yes refused as moved keeps the reason: there may be new work', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  assert.equal((await t.engine.confirm((await t.engine.proposeMerge(a.id)).confirm.id, true)).reply, 'Merged Fix cart total into main.');
  // A follow-up whose receipt cannot read what changed: its files are not known.
  t.deps.workspace.diffStats = async () => { throw new Error('git could not read it'); };
  assert.equal((await t.engine.say(a.id, 'Also round the tax')).ok, true);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I rounded the tax.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'done_claimed');
  assert.equal(t.store.get(a.id).files, null);
  const card = await t.engine.proposeMerge(a.id);
  assert.ok(card.confirm, card.reply);
  t.git.head = '12'.repeat(20); // the person commits in their own folder
  assert.deepEqual(await t.engine.confirm(card.confirm.id, true), { reply: 'main changed since you looked. Have another look.', focusId: a.id });
  assert.equal(t.store.get(a.id).work.problem.why, 'moved');
  await t.engine.shutdown();
});

test('merge: a reason left on work with nothing left to merge goes when the merge is tried again; a throw-away withdraws the merge cards', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  assert.equal((await t.engine.confirm((await t.engine.proposeMerge(a.id)).confirm.id, true)).reply, 'Merged Fix cart total into main.');
  // A reason from before (an older Workbench kept "moved" on merged work, and history brings it back).
  const problem = { why: 'moved', sentence: 'main changed since you looked. Have another look.', paths: [], into: 'main', at: 1 };
  t.store.apply([{ kind: EV.WORK, agentId: a.id, work: { ...t.store.get(a.id).work, problem }, ts: Date.now() }]);
  assert.deepEqual(t.store.get(a.id).work.problem, problem);
  t.git.work.changed = false;
  // "Try again": nothing is left to merge, so the reason no longer says anything true.
  assert.deepEqual(await t.engine.proposeMerge(a.id), { ok: false, reply: 'Fix cart total’s work is already in main.' });
  assert.equal(t.store.get(a.id).work.problem, null);
  assert.equal(t.store.get(a.id).work.merged.merge, FAKE_MERGE);

  // Throwing an agent's work away withdraws its merge cards, as a merge does.
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'I fixed the rounding.');
  t.git.work.changed = true;
  const card = await t.engine.proposeMerge(b.id);
  const away = await t.engine.proposeDiscard(b.id);
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away Fix tax rounding’s work\./);
  assert.deepEqual(await t.engine.confirm(card.confirm.id, true), { reply: GONE_REPLY });
  assert.equal(t.calls.mergeWork.length, 1, 'only the first agent was ever merged');
  await t.engine.shutdown();
});

test('status: work with changes since its merge is not called merged, and a failed check on settled work needs no one, as on the page', async (ctx) => {
  const t = liveFolders(ctx, { deps: { checks: [{ name: 'unit tests', run: 'npm test' }], checkState: 'failed' } });
  t.deps.commands.intent = (text, c) => ({ 'what needs me': { kind: 'status' }, 'what is it doing': { kind: 'status', agentId: c.focusId } })[text] || null;
  const needs = () => t.engine.command('what needs me');
  const doing = async (id) => (await t.engine.command('what is it doing', { focusId: id })).reply;
  const a = await doneAgent(t);
  assert.equal(t.store.get(a.id).state, 'checks_failed');
  assert.deepEqual(await needs(), { reply: 'One thing needs you: Fix cart total is done, but a check failed.', focusId: a.id });
  // Merged anyway: nothing of it is left to merge, so its failed check waits on no one.
  assert.equal((await t.engine.confirm((await t.engine.proposeMerge(a.id)).confirm.id, true)).reply, 'Merged Fix cart total into main.');
  assert.deepEqual(await needs(), { reply: 'Nothing needs you right now.' });
  assert.equal(await doing(a.id), 'Fix cart total is done, but a check failed. The check “unit tests” did not pass. It says: I fixed the cart total. Its work was merged into main.');
  // A follow-up changes a file: that file is not merged, and the failed check needs the person again.
  assert.equal((await t.engine.say(a.id, 'Also round the tax')).ok, true);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I rounded the tax.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(a.id).state === 'checks_failed');
  assert.equal(t.store.get(a.id).files.changed, 1);
  assert.ok(t.store.get(a.id).work.merged, 'the last merge is still known');
  assert.equal(await doing(a.id), 'Fix cart total is done, but a check failed. The check “unit tests” did not pass. It says: I rounded the tax. Its earlier work was merged into main, but 1 changed file is not merged yet.');
  assert.deepEqual(await needs(), { reply: 'One thing needs you: Fix cart total is done, but a check failed.', focusId: a.id });
  // Stopped in the middle of its next turn, it has said nothing yet of what it changed.
  assert.equal((await t.engine.say(a.id, 'And the docs')).ok, true);
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  await t.engine.stop(a.id);
  assert.equal(t.store.get(a.id).files, null);
  assert.equal(await doing(a.id), 'Fix cart total was stopped. Its earlier work was merged into main. Anything it changed since is not merged yet.');
  // Thrown away: settled too.
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'I fixed the rounding.');
  assert.deepEqual(await needs(), { reply: 'One thing needs you: Fix tax rounding is done, but a check failed.', focusId: b.id });
  assert.match((await t.engine.confirm((await t.engine.proposeDiscard(b.id)).confirm.id, true)).reply, /^Threw away /);
  assert.deepEqual(await needs(), { reply: 'Nothing needs you right now.' });
  assert.equal(await doing(b.id), 'Fix tax rounding is done, but a check failed. The check “unit tests” did not pass. It says: I fixed the rounding. Its work was thrown away.');
  await t.engine.shutdown();
});

test('merge: nothing writes in its folder while git takes its work: its idle process is closed, and checks still ending are waited for', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  assert.equal(a.runner.alive, true, 'a done Claude Code agent keeps an idle process for follow-ups');
  let seen = null;
  t.git.mergeResult = (o) => {
    seen = { alive: a.runner.alive, stopCalls: a.runner.stopCalls, stopped: t.engine.stopped.has(a.id) };
    return { ok: true, into: 'main', merge: FAKE_MERGE, work: FAKE_WORK, files: 1, adds: 3, dels: 1 };
  };
  const card = await t.engine.proposeMerge(a.id);
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Merged Fix cart total into main.');
  assert.deepEqual(seen, { alive: false, stopCalls: 1, stopped: true }, 'closed first, and marked so a turn it starts by itself counts for nothing');

  // Checks that take their time to end, even once told to stop (as a long test run can).
  const ending = gate();
  const t2 = liveFolders(ctx, { deps: { checks: [{ name: 'unit tests', run: 'npm test' }] } });
  t2.deps.receipt.runChecks = async (o) => { t2.calls.runChecks.push(o); await ending.wait; return { state: 'passed', results: [] }; };
  const b = await started(t2);
  b.runner.emit({ kind: EV.TURN, phase: 'start' });
  b.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t2.calls.runChecks.length === 1);
  await t2.engine.stop(b.id);
  assert.equal(t2.store.get(b.id).state, 'stopped');
  const card2 = await t2.engine.proposeMerge(b.id);
  assert.ok(card2.confirm, card2.reply);
  const yes = t2.engine.confirm(card2.confirm.id, true);
  assert.equal(await settled(yes), false);
  assert.equal(t2.calls.mergeWork.length, 0, 'git waits until its checks have really ended');
  ending.open();
  assert.equal((await yes).reply, 'Merged Fix login redirect into main.');

  // A process that will not stop may still write there: nothing is merged.
  const c = await doneAgent(t, { task: 'Fix the tax rounding' }, 'Done.');
  c.runner.stop = async () => { c.runner.stopCalls += 1; };
  const card3 = await t.engine.proposeMerge(c.id);
  const before = t.calls.mergeWork.length;
  assert.equal((await t.engine.confirm(card3.confirm.id, true)).reply, 'Workbench could not pause Fix tax rounding, so nothing was merged.');
  assert.equal(t.calls.mergeWork.length, before);
  await t.engine.shutdown();
  await t2.engine.shutdown();
});

test('shutdown waits for a merge under way, and no new git work starts once it has begun', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'I fixed the rounding.');
  const g = gate();
  t.git.mergeGate = g;
  const ca = await t.engine.proposeMerge(a.id);
  const cb = await t.engine.proposeMerge(b.id);
  const ya = t.engine.confirm(ca.confirm.id, true);
  await until(() => t.calls.mergeWork.length === 1);
  const down = t.engine.shutdown();
  assert.equal(await settled(down), false, 'shutdown waits for the merge in the person’s folder');
  assert.deepEqual(await t.engine.confirm(cb.confirm.id, true), { reply: 'Workbench is shutting down.', focusId: b.id });
  assert.deepEqual(await t.engine.proposeDiscard(b.id), { ok: false, reply: 'Workbench is shutting down.' });
  assert.deepEqual(await t.engine.changes(b.id), { ok: false, reply: 'Workbench is shutting down.' });
  g.open();
  assert.equal((await ya).reply, 'Merged Fix cart total into main.');
  await down;
  assert.equal(t.calls.mergeWork.length, 1);
  assert.equal(t.calls.discardWork.length, 0);
  // The tidy counts the merged agent's folder as unchanged from its merged work commit (since); the other, never merged,
  // from where it started, with no since at all.
  const tidyA = t.calls.removeWorkspace.find(c => c.path === a.v.workspace);
  const tidyB = t.calls.removeWorkspace.find(c => c.path === b.v.workspace);
  assert.deepEqual([tidyA.base, tidyA.since], [FAKE_BASE, FAKE_WORK]);
  assert.deepEqual([tidyB.base, 'since' in tidyB], [FAKE_BASE, false]);
});

test('merge and throw away by words: the card is for the agent the words named, and a typed yes answers only the card on screen', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const helper = `${a.id}-h1`;
  t.engine.ingest({ kind: EV.CREATED, agentId: helper, parentId: a.id, name: 'Find tests', task: 'find', harness: 'claude' });
  const intents = {
    'merge it': { kind: 'merge', agentId: a.id },
    'merge its helper': { kind: 'merge', agentId: helper },
    'merge it into master': { kind: 'merge', agentId: a.id, into: 'master' },
    'merge it into main': { kind: 'merge', agentId: a.id, into: 'main' },
    'merge the twins': { kind: 'merge', agentId: null },
    'throw it away': { kind: 'discard', agentId: a.id },
    'throw away the twins': { kind: 'discard', agentId: null },
    'what changed': { kind: 'changes', agentId: a.id },
    'what did the twins change': { kind: 'changes', agentId: null },
    yes: { kind: 'confirm', go: true },
  };
  t.deps.commands.intent = (text) => intents[text] || null;
  const before = t.notices.length;
  const card = await t.engine.command('merge it', { focusId: a.id });
  assert.equal(card.reply, 'Merge Fix cart total into main?');
  assert.deepEqual(Object.keys(card.confirm).sort(), ['agentId', 'danger', 'detail', 'id', 'kind', 'no', 'sentence', 'yes']);
  assert.equal(card.confirm.agentId, a.id, 'a merge card names the agent it is about');
  assert.equal(card.confirm.kind, 'merge');
  assert.equal(t.notices.length, before, 'a card is not announced');
  // The parser sees the card on screen as it is, with its agent.
  await t.engine.command('mumble', { confirmId: card.confirm.id });
  const shown = t.calls.parse.at(-1).ctx.pendingConfirm;
  assert.deepEqual({ kind: shown.kind, agentId: shown.agentId, agentIds: shown.agentIds, yes: shown.yes, no: shown.no, danger: shown.danger },
    { kind: 'merge', agentId: a.id, agentIds: [a.id], yes: 'Merge', no: 'Cancel', danger: false });
  // Words it did not catch keep the card, and name what "do it" does to it.
  const miss = await t.engine.command('mumble', { confirmId: card.confirm.id });
  assert.equal(miss.reply, 'I did not catch that. Say “do it” to merge it, or “cancel”.');
  assert.deepEqual(miss.confirm, card.confirm);
  const yes = await t.engine.command('yes', { confirmId: card.confirm.id });
  assert.deepEqual(yes, { reply: 'Merged Fix cart total into main.', focusId: a.id });
  assert.equal(t.notices.at(-1), 'Merged Fix cart total into main.');
  // A helper's words go to its agent; a branch other than the folder's is refused plainly; no agent named asks which.
  t.git.work.changed = true;
  t.git.seq += 1;
  assert.equal((await t.engine.command('merge its helper')).confirm.sentence, 'Merge Fix cart total into main?');
  assert.equal((await t.engine.command('merge it into main')).confirm.sentence, 'Merge Fix cart total into main?');
  const master = await t.engine.command('merge it into master');
  assert.deepEqual(master, { reply: 'Workbench merges into the branch your folder is on, which is main. Switch to master first to merge there.', focusId: a.id });
  assert.equal(t.notices.at(-1), master.reply);
  for (const words of ['merge the twins', 'throw away the twins', 'what did the twins change']) {
    assert.deepEqual(await t.engine.command(words), { reply: 'Which one do you mean? Pick it on the board, then ask again.' }, words);
  }
  // "what changed" opens the git screen on that agent: the reply carries `review`.
  assert.deepEqual(await t.engine.command('what changed'), { reply: 'Here is what Fix cart total changed.', review: a.id, focusId: a.id });
  // A throw-away card: its own near miss, and its own cancel.
  const away = await t.engine.command('throw it away');
  assert.equal(away.confirm.kind, 'discard');
  assert.equal((await t.engine.command('mumble', { confirmId: away.confirm.id })).reply, 'I did not catch that. Say “do it” to throw it away, or “cancel”.');
  assert.deepEqual(await t.engine.confirm(away.confirm.id, false), { reply: 'OK, I won’t throw it away.' });
  assert.equal(t.calls.discardWork.length, 0);
  await t.engine.shutdown();
});

test('command: a look at an agent’s changes is read-only, so the merge or throw-away card on screen stays, and its yes still answers it', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'I fixed the rounding.');
  t.deps.commands.intent = (text, c) => ({
    'merge it': { kind: 'merge', agentId: c.focusId },
    'throw it away': { kind: 'discard', agentId: c.focusId },
    'show me the changes': { kind: 'changes', agentId: c.pendingConfirm?.agentId ?? c.focusId },
    'what did fix tax rounding change': { kind: 'changes', agentId: b.id },
    'what did the twins change': { kind: 'changes', agentId: null },
    yes: { kind: 'confirm', go: true },
  })[text] || null;
  const card = await t.engine.command('merge it', { focusId: a.id });
  assert.equal(card.confirm.kind, 'merge');
  const before = t.notices.length;
  // The changes of the agent on the card: the page opens them, and the card is still the one on screen.
  assert.deepEqual(await t.engine.command('show me the changes', { confirmId: card.confirm.id }),
    { reply: 'Here is what Fix cart total changed.', review: a.id, focusId: a.id, confirm: card.confirm });
  // Another agent's changes, or words that name no one, leave it too.
  assert.deepEqual(await t.engine.command('what did fix tax rounding change', { confirmId: card.confirm.id }),
    { reply: 'Here is what Fix tax rounding changed.', review: b.id, focusId: b.id, confirm: card.confirm });
  assert.deepEqual(await t.engine.command('what did the twins change', { confirmId: card.confirm.id }),
    { reply: 'Which one do you mean? Pick it on the board, then ask again.', confirm: card.confirm });
  assert.equal(t.notices.length, before, 'a card that stays is not talked over');
  assert.equal(t.calls.mergeWork.length, 0);
  assert.deepEqual(await t.engine.command('yes', { confirmId: card.confirm.id }), { reply: 'Merged Fix cart total into main.', focusId: a.id });
  // A throw-away card stays the same way.
  const away = await t.engine.command('throw it away', { focusId: b.id });
  assert.equal(away.confirm.kind, 'discard');
  const look = await t.engine.command('show me the changes', { confirmId: away.confirm.id });
  assert.deepEqual([look.review, look.confirm], [b.id, away.confirm]);
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away Fix tax rounding’s work\./);
  await t.engine.shutdown();
});

test('command (real parser): asking what an agent changed while its merge card shows keeps the card, and "yes" then merges', async (ctx) => {
  const t = liveFolders(ctx);
  t.engine.deps.commands = commands;
  const a = await doneAgent(t);
  const card = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  assert.deepEqual(await t.engine.command('what did fix cart total change', { confirmId: card.confirm.id }),
    { reply: 'Here is what Fix cart total changed.', review: a.id, focusId: a.id, confirm: card.confirm });
  assert.equal(t.claude.runners.length, 1, 'nothing was launched');
  assert.deepEqual(await t.engine.command('yes', { confirmId: card.confirm.id }), { reply: 'Merged Fix cart total into main.', focusId: a.id });
  await t.engine.shutdown();
});

test('confirm: a card of a kind the engine does not know is never taken for a launch', async () => {
  const t = live();
  const at = Date.now();
  t.engine.confirms.set('0123456789ab', { id: '0123456789ab', kind: 'rebase', agentId: 'abc123', sentence: 'Rebase it?', detail: null, createdAt: at });
  t.engine.confirms.set('ba9876543210', { id: 'ba9876543210', kind: 'start', sentence: 'Start?', detail: null, createdAt: at });
  const miss = await t.engine.command('mumble', { confirmId: '0123456789ab' });
  assert.equal(miss.reply, 'I did not catch that. Say “do it” to go ahead, or “cancel”.');
  assert.deepEqual(await t.engine.confirm('0123456789ab', true), { reply: GONE_REPLY });
  assert.deepEqual(await t.engine.confirm('ba9876543210', true), { reply: GONE_REPLY }, 'a launch card without its tasks is none');
  assert.equal(t.store.list().length, 0, 'nothing started');
  assert.equal(t.claude.runners.length, 0);
  assert.equal(t.engine.confirms.size, 0);
  await t.engine.shutdown();
});

test('cards: every card the page gets says its kind, and merge and throw-away cards bring their own button words', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const card = async (intent) => {
    t.deps.commands.intent = intent;
    const out = await t.engine.command('words');
    assert.ok(out.confirm, out.reply);
    return out.confirm;
  };
  const start = await card({ kind: 'task', task: 'fix the login redirect' });
  assert.deepEqual(Object.keys(start).sort(), ['agents', 'detail', 'id', 'kind', 'sentence']);
  assert.equal(start.kind, 'start');
  assert.equal(start.agents, 1, 'a launch card says how many agents it starts');
  const two = await card({ kind: 'start', tasks: [{ task: 'fix the login redirect', harness: 'claude' }, { task: 'fix the docs', harness: 'claude' }] });
  assert.equal(two.agents, 2);
  // the full permissions card brings its own words, and no default answer
  const perms = (await t.engine.permissions('full')).confirm;
  assert.deepEqual({ ...perms, id: null }, { id: null, kind: 'permissions', sentence: 'Let agents do anything without asking?', detail: perms.detail, yes: 'Turn on full permissions', no: 'Keep asking', danger: true });
  assert.equal((await card({ kind: 'stop', agentIds: [a.id], sure: false })).kind, 'stop');
  assert.equal((await card({ kind: 'say', agentId: a.id, text: 'also the docs', sure: false })).kind, 'say');
  assert.equal((await card({ kind: 'forget', agentIds: [a.id] })).kind, 'forget');
  const merge = await t.engine.proposeMerge(a.id);
  assert.deepEqual({ ...merge.confirm, id: null, detail: null }, { id: null, detail: null, kind: 'merge', sentence: 'Merge Fix cart total into main?', yes: 'Merge', no: 'Cancel', danger: false, agentId: a.id });
  const away = await t.engine.proposeDiscard(a.id);
  assert.deepEqual({ ...away.confirm, id: null, detail: null }, { id: null, detail: null, kind: 'discard', sentence: 'Throw away Fix cart total’s work?', yes: 'Throw it away', no: 'Keep it', danger: true, agentId: a.id });
  await t.engine.shutdown();
});

test('merge: the work commit’s subject is the task’s first sentence, capitalised, at most 72 characters; its body is the agent’s own words', async (ctx) => {
  const t = liveFolders(ctx);
  const subjectOf = async (task, says = 'I did it.') => {
    const a = await doneAgent(t, { task }, says);
    const card = await t.engine.proposeMerge(a.id);
    assert.ok(card.confirm, card.reply);
    assert.match((await t.engine.confirm(card.confirm.id, true)).reply, /^Merged /);
    return t.calls.mergeWork.at(-1).message;
  };
  assert.deepEqual(await subjectOf('fix the login redirect. Then add tests.'), { subject: 'Fix the login redirect', body: 'I did it.', name: 'Fix login redirect' });
  assert.equal((await subjectOf('add a merge command\n\nIt should ask first, then merge.')).subject, 'Add a merge command');
  assert.equal((await subjectOf('make the invoice export work for large accounts by sending invoices in batches of five hundred at most')).subject,
    'Make the invoice export work for large accounts by sending invoices in');
  assert.equal((await subjectOf('use e.g. the cart total. Then the tax.')).subject, 'Use e.g. the cart total');
  assert.equal((await subjectOf('fix\u200B the \u202Elogin\u202C page')).subject, 'Fix the login page', 'hidden and direction-changing characters never reach git');
  // Words that git could read as a trailer are not passed on as the body.
  assert.equal((await subjectOf('tidy the docs', 'Signed-off-by: someone else')).body, '');
  await t.engine.shutdown();
});

test('repository: a slow read that began before a newer one never steps the page back to an older head', async () => {
  const t = live();
  await t.engine.start();
  const slow = gate();
  const read = t.deps.workspace.prepareRepo;
  let n = 0;
  t.deps.workspace.prepareRepo = async (p) => {
    n += 1;
    if (n !== 1) return read(p);
    const old = await read(p);
    await slow.wait;
    return old;
  };
  const heads = [];
  t.store.on('repo', r => heads.push(r.head));
  t.engine.tick(Date.now() + 60_000); // the 15 s refresh begins, and is slow
  await until(() => n === 1);
  t.git.head = '0f'.repeat(20); // the person commits meanwhile
  assert.equal((await t.engine.gitGraph()).repo.head, '0f'.repeat(20));
  slow.open();
  await until(() => !t.engine._repoReading);
  assert.equal(t.engine.snapshot().repo.head, '0f'.repeat(20), 'the older read is dropped');
  assert.deepEqual(heads, ['0f'.repeat(20)]);
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ source control: throw away

test('throw away: the card says what goes; yes deletes its folder and branch, keeps a hidden copy, and the agent stays, thrown away', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  const branch = `workbench/fix-cart-total-${a.id}`;
  t.git.work.files = [
    { path: 'src/cart.js', status: 'modified', adds: 30, dels: 2 },
    { path: 'src/total.js', status: 'added', adds: 8, dels: 0 },
    { path: 'README.md', status: 'modified', adds: 2, dels: 0 },
  ];
  t.git.work.left = [{ path: '.env.local', why: 'ignored' }, { path: 'vendor/lib/', why: 'nested-repo' }];
  const before = t.notices.length;
  const out = await t.engine.proposeDiscard(a.id, { state: 'done_claimed' });
  assert.equal(out.reply, 'Throw away Fix cart total’s work?');
  assert.deepEqual({ ...out.confirm, id: null }, {
    id: null, kind: 'discard', sentence: 'Throw away Fix cart total’s work?', yes: 'Throw it away', no: 'Keep it', danger: true, agentId: a.id,
    detail: `Its folder and its branch ${branch} are deleted, with 3 changed files. Workbench keeps a hidden copy in git. The hidden copy leaves out 1 file that a .gitignore hides and 1 folder that is a git repository of its own.`,
  });
  assert.equal(t.notices.length, before, 'a card is not announced');
  assert.deepEqual(t.engine.confirms.get(out.confirm.id).expect, { workId: `${FAKE_BASE}:tree0` });
  assert.equal(t.calls.discardWork.length, 0, 'nothing goes before the yes');
  assert.deepEqual(await t.engine.confirm(out.confirm.id, false), { reply: 'OK, I won’t throw it away.' });
  assert.ok(fs.existsSync(a.v.workspace));

  const card = await t.engine.proposeDiscard(a.id);
  const yes = await t.engine.confirm(card.confirm.id, true);
  assert.deepEqual(yes, { reply: 'Threw away Fix cart total’s work. Its folder and branch are gone.', focusId: a.id });
  assert.equal(t.notices.at(-1), yes.reply);
  assert.deepEqual(t.calls.discardWork, [{ repoRoot: REPO.root, path: a.v.workspace, branch, since: FAKE_BASE, expect: { workId: `${FAKE_BASE}:tree0` }, agentId: a.id }]);
  assert.equal(fs.existsSync(a.v.workspace), false);
  assert.equal(a.runner.alive, false, 'its idle process was closed first');
  const v = t.store.get(a.id);
  assert.deepEqual(v.work, { branch: null, from: 'main', folder: false, merged: null, problem: null, thrownAway: { at: v.work.thrownAway.at, saved: `refs/workbench/discarded/${a.id}` } });
  assert.equal(v.state, 'done_claimed', 'it stays on the board as it was');
  assert.deepEqual(t.engine.keptFolders(), [], 'no folder is kept for it');
  // Nothing more can be done with its work, and nothing wakes it where nothing is left.
  assert.deepEqual(await t.engine.say(a.id, 'carry on'), { ok: false, reply: 'Fix cart total cannot continue. Its work was thrown away, so it cannot continue.' });
  assert.deepEqual(await t.engine.proposeMerge(a.id), { ok: false, reply: 'Fix cart total’s work was thrown away, so there is nothing to merge.' });
  assert.deepEqual(await t.engine.proposeDiscard(a.id), { ok: false, reply: 'Fix cart total’s work was already thrown away.' });
  assert.deepEqual(await t.engine.changes(a.id), { ok: false, reply: 'Fix cart total’s work was thrown away, so there is nothing to show.' });
  t.deps.commands.intent = { kind: 'status', agentId: a.id };
  assert.equal((await t.engine.command('how is fix cart total')).reply, 'Fix cart total says it is done. It says: I fixed the cart total. Its work was thrown away.');
  await t.engine.shutdown();
  assert.equal(t.calls.removeWorkspace.some(c => c.path === a.v.workspace), false, 'the tidy leaves it alone');
});

test('throw away: an agent at work is stopped first, its held request is refused, and what it holds once stopped is what goes', async (ctx) => {
  const t = liveFolders(ctx);
  const { id, runner } = await started(t);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  const hook = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } });
  await until(() => t.store.get(id).state === 'needs_ok');
  const out = await t.engine.proposeDiscard(id, { state: 'needs_ok' });
  assert.equal(out.confirm.detail, `Its folder and its branch workbench/fix-login-redirect-${id} are deleted, with 1 changed file. Workbench keeps a hidden copy in git. It is still working: it will be stopped first.`);
  assert.equal(await settled(hook), false, 'asking does not touch the request it holds');
  t.git.seq = 1; // it works on meanwhile: what goes is what it holds once stopped
  const yes = await t.engine.confirm(out.confirm.id, true);
  assert.deepEqual(yes, { reply: 'Threw away Fix login redirect’s work. Its folder and branch are gone.', focusId: id });
  assert.equal((await hook).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(t.engine.held.size, 0);
  assert.equal(runner.stopCalls, 1);
  assert.equal(t.store.get(id).state, 'stopped');
  assert.equal(t.store.get(id).stateReason, 'Stopped by you');
  assert.deepEqual(t.calls.discardWork.at(-1).expect, { workId: `${FAKE_BASE}:tree1` });
  // A card for an agent at rest that went back to work is not used.
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'Done.');
  const card = await t.engine.proposeDiscard(b.id);
  assert.equal((await t.engine.say(b.id, 'One more thing')).ok, true);
  assert.deepEqual(await t.engine.confirm(card.confirm.id, true), { reply: 'That changed. Have another look.', focusId: b.id });
  assert.equal(t.calls.discardWork.length, 1);
  assert.ok(fs.existsSync(b.v.workspace));
  await t.engine.shutdown();
});

test('throw away: when its folder is already gone its branch can still go, and when git finds both gone it says so', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  fs.rmSync(a.v.workspace, { recursive: true, force: true });
  const out = await t.engine.proposeDiscard(a.id);
  assert.equal(out.confirm.detail, `Its folder is already gone. Its branch workbench/fix-cart-total-${a.id} is deleted. Workbench keeps a hidden copy in git.`);
  assert.equal(t.store.get(a.id).work.folder, false, 'its view says its folder is gone');
  assert.equal(t.calls.snapshotWork.length, 0, 'there is no folder to read');
  assert.equal((await t.engine.confirm(out.confirm.id, true)).reply, 'Threw away Fix cart total’s work. Its folder and branch are gone.');
  assert.deepEqual(t.calls.discardWork.at(-1).expect, { workId: null });
  assert.equal(t.store.get(a.id).work.thrownAway.saved, `refs/workbench/discarded/${a.id}`);

  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'Done.');
  fs.rmSync(b.v.workspace, { recursive: true, force: true });
  const card = await t.engine.proposeDiscard(b.id);
  t.git.discardResult = { ok: false, why: 'gone', sentence: 'Its folder and its branch are already gone.' };
  assert.deepEqual(await t.engine.confirm(card.confirm.id, true), { reply: 'Fix tax rounding’s folder and its branch are already gone.', focusId: b.id });
  const w = t.store.get(b.id).work;
  assert.deepEqual([w.branch, w.folder, w.thrownAway], [null, false, null]);
  assert.equal(t.engine.runs.get(b.id).folderRemoved, true);
  assert.deepEqual(t.engine.keptFolders(), []);
  assert.deepEqual(await t.engine.proposeDiscard(b.id), { ok: false, reply: 'Its folder is gone, so there is nothing to throw away.' });
  await t.engine.shutdown();
});

test('throw away: what git refuses comes back in plain words, and nothing is thrown away', async (ctx) => {
  const t = liveFolders(ctx);
  const a = await doneAgent(t);
  t.engine.ingest({ kind: EV.CREATED, agentId: `${a.id}-h1`, parentId: a.id, name: 'Find tests', task: 'find', harness: 'claude' });
  const attempt = async (result) => {
    t.git.discardResult = result;
    const card = await t.engine.proposeDiscard(a.id);
    assert.ok(card.confirm, card.reply);
    return (await t.engine.confirm(card.confirm.id, true)).reply;
  };
  assert.equal(await attempt({ ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' }), 'Fix cart total’s work changed since you looked. Have another look.');
  assert.equal(await attempt({ ok: false, why: 'changed', sentence: 'Its folder is on the branch feature/x now, not on workbench/x.' }), 'Fix cart total’s folder is on the branch feature/x now, not on workbench/x.');
  assert.equal(await attempt({ ok: false, why: 'git', sentence: 'Git could not throw its work away. Nothing was deleted.' }), 'Git could not throw its work away. Nothing was deleted.');
  assert.equal(await attempt({ ok: false, why: 'git' }), 'Git could not throw away Fix cart total’s work. Nothing was deleted.');
  t.git.discardResult = null;
  t.git.discardError = new Error('spawn git ENOENT');
  const card = await t.engine.proposeDiscard(a.id);
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Something went wrong while throwing away Fix cart total’s work. The details are in the log.');
  t.git.discardError = null;
  // Reading its work fails before any card: plain words, never git's own text.
  t.git.snapshotError = gitError('Its folder is no longer on a workbench/ branch, so Workbench leaves it alone.', 'changed');
  assert.deepEqual(await t.engine.proposeDiscard(a.id), { ok: false, reply: 'Fix cart total’s folder is no longer on a workbench/ branch, so Workbench leaves it alone.' });
  t.git.snapshotError = new Error('fatal: bad object HEAD');
  assert.deepEqual(await t.engine.proposeDiscard(a.id), { ok: false, reply: 'Workbench could not read Fix cart total’s work, so nothing was thrown away.' });
  t.git.snapshotError = gitError('Its folder is gone.', 'gone');
  assert.deepEqual(await t.engine.proposeDiscard(a.id), { ok: false, reply: 'Its folder is gone, so there is nothing to throw away.' });
  t.git.snapshotError = null;
  // An older workspace module that cannot throw work away: a plain refusal, never a crash.
  const discardWork = t.deps.workspace.discardWork;
  delete t.deps.workspace.discardWork;
  assert.deepEqual(await t.engine.proposeDiscard(a.id), { ok: false, reply: 'Workbench cannot throw away work right now.' });
  t.deps.workspace.discardWork = discardWork;
  // A helper's work is its agent's.
  assert.deepEqual(await t.engine.proposeDiscard(`${a.id}-h1`), { ok: false, reply: 'Helpers work in their agent’s folder. Throw away the agent’s work instead.' });
  assert.equal(t.store.get(a.id).work.thrownAway, null);
  assert.ok(fs.existsSync(a.v.workspace));
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ source control: changes and the git screen

test('changes: the diff of its work not merged yet, read-only and announced nowhere, for a helper too, in any state', async (ctx) => {
  const t = liveFolders(ctx);
  const { id, runner, v } = await started(t);
  const helper = `${id}-h1`;
  t.engine.ingest({ kind: EV.CREATED, agentId: helper, parentId: id, name: 'Find tests', task: 'find', harness: 'claude' });
  const before = t.notices.length;
  const out = await t.engine.changes(id);
  assert.deepEqual({ ...out, diff: null }, { ok: true, agentId: id, name: 'Fix login redirect', branch: `workbench/fix-login-redirect-${id}`, into: 'main', live: true, diff: null });
  assert.equal(out.diff.files[0].path, 'src/cart.js');
  assert.match(out.diff.files[0].patch, /^diff --git /);
  assert.deepEqual(t.calls.workDiff.at(-1), { repoRoot: REPO.root, path: v.workspace, since: FAKE_BASE });
  assert.equal((await t.engine.changes(helper)).agentId, id, 'a helper’s id gives its agent’s changes');
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(id).state === 'done_claimed');
  assert.equal((await t.engine.changes(id)).live, false, 'at rest, its work stays as it is');
  // Refusals, in plain words.
  assert.deepEqual(await t.engine.changes('nobody'), { ok: false, reply: 'I can’t find that agent.' });
  t.git.workDiffError = gitError('Its folder is on the branch feature/x now, not on workbench/x.', 'changed');
  assert.deepEqual(await t.engine.changes(id), { ok: false, reply: 'Fix login redirect’s folder is on the branch feature/x now, not on workbench/x.' });
  t.git.workDiffError = new Error('fatal: something git said');
  assert.deepEqual(await t.engine.changes(id), { ok: false, reply: 'Workbench could not read Fix login redirect’s changes.' });
  t.git.workDiffError = gitError('Its folder is gone.', 'gone');
  assert.deepEqual(await t.engine.changes(id), { ok: false, reply: 'Its folder is gone, so there is nothing to show.' });
  assert.equal(t.store.get(id).work.folder, false);
  t.git.workDiffError = null;
  const workDiff = t.deps.workspace.workDiff;
  delete t.deps.workspace.workDiff;
  assert.deepEqual(await t.engine.changes(id), { ok: false, reply: 'Workbench cannot show changes right now.' });
  t.deps.workspace.workDiff = workDiff;
  fs.rmSync(v.workspace, { recursive: true, force: true });
  assert.deepEqual(await t.engine.changes(id), { ok: false, reply: 'Its folder is gone, so there is nothing to show.' });
  assert.equal(t.notices.length, before, 'reading, and refusing to read, posts no notice');
  await t.engine.shutdown();
});

test('git screen: the graph has the repository as it is now, its commits, and every root with a branch', async (ctx) => {
  const t = liveFolders(ctx);
  await t.engine.start();
  const a = await doneAgent(t);
  const b = await doneAgent(t, { task: 'Fix the tax rounding' }, 'Done.');
  t.engine.ingest({ kind: EV.CREATED, agentId: `${a.id}-h1`, parentId: a.id, name: 'Find tests', task: 'find', harness: 'claude' });
  t.git.dirty = 1;
  const g = await t.engine.gitGraph();
  assert.equal(g.ok, true);
  assert.deepEqual(g.repo, { name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 1, identity: true });
  assert.deepEqual(g.commits.map(c => c.id), ['12'.repeat(20), '34'.repeat(20)]);
  assert.equal(g.more, false);
  assert.deepEqual(t.calls.gitGraph.at(-1), { repoRoot: REPO.root });
  const entry = (x, name) => ({
    id: x.id, name, state: 'done_claimed', earlier: false, harness: 'claude', branch: t.store.get(x.id).work.branch, from: 'main',
    base: FAKE_BASE, since: FAKE_BASE, files: t.store.get(x.id).files, work: t.store.get(x.id).work,
  });
  assert.deepEqual(g.agents.sort((x, y) => x.name.localeCompare(y.name)), [entry(a, 'Fix cart total'), entry(b, 'Fix tax rounding')]);
  // A thrown-away agent has no branch left to show.
  const card = await t.engine.proposeDiscard(b.id);
  await t.engine.confirm(card.confirm.id, true);
  assert.deepEqual((await t.engine.gitGraph()).agents.map(x => x.id), [a.id]);
  // The git module's own plain refusal is passed on; anything else is ours.
  t.git.graphResult = { ok: false, why: 'git', sentence: 'The repository at /repos/shop has no commits yet.' };
  assert.deepEqual(await t.engine.gitGraph(), { ok: false, reply: 'The repository at /repos/shop has no commits yet.' });
  t.git.graphResult = () => { throw new Error('boom'); };
  assert.deepEqual(await t.engine.gitGraph(), { ok: false, reply: 'Workbench could not read the git history.' });
  t.git.graphResult = null;
  const gitGraph = t.deps.workspace.gitGraph;
  delete t.deps.workspace.gitGraph;
  assert.deepEqual(await t.engine.gitGraph(), { ok: false, reply: 'Workbench cannot show the git history right now.' });
  t.deps.workspace.gitGraph = gitGraph;
  await t.engine.shutdown();
});

test('repository: identity is read at start and on every refresh, and the page hears of a change only', async () => {
  const t = live();
  const seen = [];
  t.store.on('repo', r => seen.push(r));
  t.git.identity = null;
  await t.engine.start();
  assert.equal(t.engine.snapshot().repo.identity, false);
  // A refresh that finds nothing new tells nobody.
  t.engine.tick(Date.now() + 60_000);
  await until(() => t.calls.prepareRepo.length >= 1);
  await until(() => !t.engine._repoReading);
  assert.deepEqual(seen, []);
  // The person sets their name and email, and commits: the next refresh tells the page.
  t.git.identity = { name: 'Test Person', email: 'test@example.com' };
  t.git.head = '0f'.repeat(20);
  t.git.dirty = 0;
  t.engine.tick(Date.now() + 120_000);
  await until(() => seen.length === 1);
  assert.deepEqual(seen, [{ name: 'shop', head: '0f'.repeat(20), branch: 'main', dirty: 0, identity: true }]);
  assert.deepEqual(t.engine.snapshot().repo, seen[0]);
  await t.engine.shutdown();
});

test('repository: refreshRepo() reads the identity at once and tells the page, and a read already under way does not hold it back', async () => {
  const t = live();
  const seen = [];
  t.store.on('repo', r => seen.push(r));
  t.git.identity = null;
  await t.engine.start();
  assert.equal(t.engine.snapshot().repo.identity, false);
  // The 15 s refresh begins, and reads who commits just before the person saves their name and email. It is slow.
  const slow = gate();
  const read = t.deps.workspace.gitIdentity;
  let n = 0;
  t.deps.workspace.gitIdentity = async (o) => {
    n += 1;
    const id = await read(o);
    if (n === 1) await slow.wait;
    return id;
  };
  t.engine.tick(Date.now() + 60_000);
  await until(() => n === 1);
  // Agents & keys saves them, and bin asks the engine to read the repository again.
  t.git.identity = { name: 'Test Person', email: 'test@example.com' };
  const now = { name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 2, identity: true };
  assert.deepEqual(await t.engine.refreshRepo(), now);
  assert.deepEqual(seen, [now], 'the page hears of it at once, not 15 s later');
  assert.equal(t.engine.snapshot().repo.identity, true);
  // The older read ends later, and is dropped.
  slow.open();
  await until(() => !t.engine._repoReading);
  assert.equal(t.engine.snapshot().repo.identity, true);
  // Nothing new: nobody is told. A repository git cannot read: what was known stays, and nothing is thrown.
  assert.deepEqual(await t.engine.refreshRepo(), now);
  t.deps.workspace.prepareRepo = async () => { throw new Error('git could not read it'); };
  assert.deepEqual(await t.engine.refreshRepo(), now);
  assert.deepEqual(seen, [now]);
  await t.engine.shutdown();
  // The demo has no repository to read.
  const d = demo();
  await d.engine.start();
  assert.equal(await d.engine.refreshRepo(), null);
  await d.engine.shutdown();
});

test('snapshot: harnessInfo.claude.version follows the version its agents’ session lines report; harnesses stay plain flags', async () => {
  const t = live();
  await t.engine.start();
  assert.deepEqual(t.engine.snapshot().harnessInfo.claude, { ok: true, version: '1.0.0' });
  const { runner } = await started(t);
  runner.emit({ kind: EV.SESSION, sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', version: '2.1.322' });
  const s = t.engine.snapshot();
  assert.deepEqual(s.harnessInfo.claude, { ok: true, version: '2.1.322' });
  assert.deepEqual(s.harnesses, { claude: true, codex: true, sim: false });
  runner.emit({ kind: EV.SESSION, sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e', version: 'banana' });
  assert.equal(t.engine.snapshot().harnessInfo.claude.version, '2.1.322', 'what is no version is not kept');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ source control: the demo

/** A demo engine whose simulator has the optional git methods, shaped like the real simulator's. */
function gitDemo() {
  const store = new Store();
  const sim = new FakeGitSim();
  const { deps, calls } = fakeDeps();
  const notices = [];
  store.on('notice', n => notices.push(n.text));
  const engine = new Engine({ store, mode: 'demo', hook: HOOK, adapters: { sim }, machines: new FakeMachines({ demo: true }), deps, options: { tickMs: 10_000_000, simTickMs: 10_000_000 } });
  return { store, engine, sim, deps, calls, notices };
}

/** A demo agent run to "says it is done". */
async function demoDone(t, task = 'Export the invoices') {
  const v = await t.engine.startAgent({ task });
  const runner = t.sim.runners.at(-1);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(v.id).state === 'done_claimed');
  return { id: v.id, runner };
}

test('demo: without the simulator’s git methods, merge, throw-away, changes and the graph say plainly that this is the demo', async () => {
  const t = demo();
  await t.engine.start();
  const v = await t.engine.startAgent({ task: 'Export the invoices' });
  assert.deepEqual(await t.engine.proposeMerge(v.id), { ok: false, reply: 'This is the demo, so nothing is really merged.' });
  assert.deepEqual(await t.engine.proposeDiscard(v.id), { ok: false, reply: 'This is the demo, so nothing is really thrown away.' });
  assert.deepEqual(await t.engine.changes(v.id), { ok: false, reply: 'This is the demo, so there are no real changes to show.' });
  assert.deepEqual(await t.engine.gitGraph(), { ok: false, reply: 'This is the demo, so there is no git history to show.' });
  assert.equal(t.store.get(v.id).work, null, 'a demo agent without git has no work to speak of');
  await t.engine.shutdown();
});

test('demo: with the simulator’s git methods, cards and outcomes come from it, bound to what was shown, through the same events', async () => {
  const t = gitDemo();
  await t.engine.start();
  const a = await demoDone(t);
  const view = () => t.store.get(a.id);
  assert.equal(view().work.branch, `workbench/export-invoices-${a.id}`);
  // The graph: the simulator's, with the views it was given.
  const g = await t.engine.gitGraph();
  assert.deepEqual(g.repo, { name: 'storefront', branch: 'main', head: 'cd'.repeat(20), dirty: 2, identity: true });
  assert.deepEqual(g.agents.map(x => [x.id, x.state]), [[a.id, 'done_claimed']]);
  assert.equal(typeof t.sim.git.find(c => c[0] === 'gitGraph')[2].views, 'function');
  // Its changes, read-only.
  const ch = await t.engine.changes(a.id);
  assert.deepEqual({ ...ch, diff: null }, { ok: true, agentId: a.id, name: 'Export invoices', branch: view().work.branch, into: 'main', live: false, diff: null });
  // The card: the simulator's words, the engine's id; the yes passes on what the card was bound to.
  const card = await t.engine.proposeMerge(a.id, { state: 'done_claimed' });
  assert.deepEqual({ ...card.confirm, id: null }, {
    id: null, kind: 'merge', sentence: 'Merge Export invoices into main?', yes: 'Merge', no: 'Cancel', danger: false, agentId: a.id,
    detail: '2 files, +5 −1. Its work becomes a commit on its branch, joined into main by a merge commit. Nothing checked its work.',
  });
  const asked = t.sim.git.find(c => c[0] === 'proposeMerge');
  assert.equal(asked[2].state, 'done_claimed');
  assert.equal(asked[2].view.id, a.id);
  const yes = await t.engine.confirm(card.confirm.id, true);
  assert.deepEqual(yes, { reply: 'Merged Export invoices into main. This is the demo: nothing was really merged.', focusId: a.id });
  const merge = t.sim.git.find(c => c[0] === 'merge');
  assert.deepEqual(merge[2].expect, { workId: `w-${a.id}`, into: 'main', intoHead: 'cd'.repeat(20) });
  // Recorded once, by the simulator's own events.
  assert.deepEqual(view().work.merged, { into: 'main', merge: 'ab'.repeat(20), at: 1, files: 2, adds: 5, dels: 1 });
  assert.deepEqual(view().files, { changed: 0, adds: 0, dels: 0, list: [] });

  // A conflict: kept on the agent, in the simulator's words.
  const b = await demoDone(t, 'Write the help pages');
  t.sim.outcomes.set(b.id, 'conflict');
  const c2 = await t.engine.proposeMerge(b.id);
  assert.equal((await t.engine.confirm(c2.confirm.id, true)).reply, 'Write help pages’s work does not merge cleanly into main. This is the demo: nothing was really merged.');
  assert.deepEqual(t.store.get(b.id).work.problem, { why: 'conflict', sentence: 'Write help pages’s work does not merge cleanly into main.', paths: ['help/index.md'], at: 1 });
  // A refusal with no reason is only passed on: nothing is kept.
  t.sim.outcomes.set(b.id, { ok: false, reply: 'That agent is not part of the demo.' });
  const c3 = await t.engine.proposeMerge(b.id);
  assert.deepEqual(await t.engine.confirm(c3.confirm.id, true), { reply: 'That agent is not part of the demo.', focusId: b.id });
  assert.equal(t.store.get(b.id).work.problem.why, 'conflict', 'the conflict is still the last reason');
  // The simulator says no to a card: its words.
  t.sim.proposals.set(b.id, { ok: false, reply: 'Write help pages’s work is already in main.' });
  assert.deepEqual(await t.engine.proposeMerge(b.id), { ok: false, reply: 'Write help pages’s work is already in main.' });
  t.sim.proposals.delete(b.id);

  // Throw away: the simulator's card and outcome.
  const away = await t.engine.proposeDiscard(b.id);
  assert.equal(away.confirm.detail, `Its folder and its branch workbench/write-help-pages-${b.id} are deleted, with 2 changed files. Workbench keeps a hidden copy in git.`);
  assert.equal(away.confirm.danger, true);
  const gone = await t.engine.confirm(away.confirm.id, true);
  assert.equal(gone.reply, 'Threw away Write help pages’s work. Its folder and branch are gone. This is the demo: nothing was really thrown away.');
  assert.deepEqual(t.sim.git.find(c => c[0] === 'discard')[2].expect, { workId: `w-${b.id}` });
  assert.equal(t.store.get(b.id).work.thrownAway.saved, `refs/workbench/discarded/${b.id}`);
  await t.engine.shutdown();
});

test('demo: once an agent is merged or thrown away, its other cards are gone, so a second page’s yes does nothing', async () => {
  const t = gitDemo();
  await t.engine.start();
  const a = await demoDone(t);
  const pageA = await t.engine.proposeMerge(a.id);
  const pageB = await t.engine.proposeMerge(a.id);
  const awayB = await t.engine.proposeDiscard(a.id);
  assert.match((await t.engine.confirm(pageA.confirm.id, true)).reply, /^Merged Export invoices into main\./);
  assert.deepEqual(await t.engine.confirm(pageB.confirm.id, true), { reply: GONE_REPLY });
  assert.deepEqual(await t.engine.confirm(awayB.confirm.id, true), { reply: GONE_REPLY });
  assert.equal(t.sim.git.filter(c => c[0] === 'merge').length, 1);
  assert.equal(t.sim.git.filter(c => c[0] === 'discard').length, 0);
  assert.equal(t.store.get(a.id).work.problem, null);
  // And a throw-away withdraws a merge card.
  const b = await demoDone(t, 'Write the help pages');
  const card = await t.engine.proposeMerge(b.id);
  const away = await t.engine.proposeDiscard(b.id);
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away Write help pages’s work\./);
  assert.deepEqual(await t.engine.confirm(card.confirm.id, true), { reply: GONE_REPLY });
  assert.equal(t.sim.git.filter(c => c[0] === 'merge').length, 1);
  await t.engine.shutdown();
});

test('demo: an agent the engine stopped has the simulator’s events filtered, so the engine records the outcome itself', async () => {
  const t = gitDemo();
  await t.engine.start();
  const v = await t.engine.startAgent({ task: 'Export the invoices' });
  t.sim.runners.at(-1).emit({ kind: EV.TURN, phase: 'start' });
  await t.engine.stop(v.id);
  assert.equal(t.store.get(v.id).state, 'stopped');
  const card = await t.engine.proposeMerge(v.id, { state: 'stopped' });
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Merged Export invoices into main. This is the demo: nothing was really merged.');
  const w = t.store.get(v.id).work;
  assert.equal(w.merged.into, 'main');
  assert.equal(w.merged.files, 2);
  assert.deepEqual(t.store.get(v.id).files, { changed: 0, adds: 0, dels: 0, list: [] });
  // A working agent's throw-away card says it is stopped first; the yes stops it, then the simulator throws away.
  const b = await t.engine.startAgent({ task: 'Write the help pages' });
  t.sim.runners.at(-1).emit({ kind: EV.TURN, phase: 'start' });
  const away = await t.engine.proposeDiscard(b.id);
  assert.equal(away.reply, 'Throw away Write help pages’s work?');
  const yes = await t.engine.confirm(away.confirm.id, true);
  assert.match(yes.reply, /^Threw away Write help pages’s work\./);
  assert.equal(t.store.get(b.id).state, 'stopped');
  assert.equal(t.sim.git.find(c => c[0] === 'discard')[2].expect, null, 'a card made while it worked binds to nothing');
  assert.equal(t.store.get(b.id).work.thrownAway.saved, `refs/workbench/discarded/${b.id}`);
  await t.engine.shutdown();
});

test('demo: a simulator that merges and throws away but makes no cards of its own gets the engine’s cards', async () => {
  const t = gitDemo();
  t.sim.proposeMerge = undefined;
  t.sim.proposeDiscard = undefined;
  await t.engine.start();
  const v = await t.engine.startAgent({ task: 'Export the invoices' });
  const runner = t.sim.runners.at(-1);
  runner.emit({ kind: EV.TURN, phase: 'start' });
  runner.emit({ kind: EV.FILES, files: { changed: 2, adds: 5, dels: 1, list: [{ path: 'a.js', adds: 4, dels: 1 }, { path: 'b.js', adds: 1, dels: 0 }] } });
  runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(v.id).state === 'done_claimed');
  const card = await t.engine.proposeMerge(v.id);
  assert.deepEqual({ ...card.confirm, id: null }, {
    id: null, kind: 'merge', sentence: 'Merge Export invoices into main?', yes: 'Merge', no: 'Cancel', danger: false, agentId: v.id,
    detail: '2 files, +5 −1. Its work becomes a commit on its branch, joined into main by a merge commit. This is the demo, so nothing is really merged.',
  });
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Merged Export invoices into main. This is the demo: nothing was really merged.');
  assert.deepEqual(t.sim.git.find(c => c[0] === 'merge')[2].expect, { into: 'main' });
  const b = await t.engine.startAgent({ task: 'Write the help pages' });
  const rb = t.sim.runners.at(-1);
  rb.emit({ kind: EV.TURN, phase: 'start' });
  rb.emit({ kind: EV.FILES, files: { changed: 1, adds: 3, dels: 0, list: [{ path: 'help.md', adds: 3, dels: 0 }] } });
  rb.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
  await until(() => t.store.get(b.id).state === 'done_claimed');
  const away = await t.engine.proposeDiscard(b.id);
  assert.deepEqual({ ...away.confirm, id: null }, {
    id: null, kind: 'discard', sentence: 'Throw away Write help pages’s work?', yes: 'Throw it away', no: 'Keep it', danger: true, agentId: b.id,
    detail: `Its folder and its branch workbench/write-help-pages-${b.id} are deleted, with 1 changed file. Workbench keeps a hidden copy in git. This is the demo, so nothing is really thrown away.`,
  });
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away Write help pages’s work\./);
  assert.equal(t.store.get(b.id).work.thrownAway.saved, `refs/workbench/discarded/${b.id}`);
  await t.engine.shutdown();
});

test('repository: a workspace module that cannot tell who commits leaves identity unknown, and a merge card is still made', async (ctx) => {
  const t = liveFolders(ctx);
  delete t.deps.workspace.gitIdentity;
  await t.engine.start();
  assert.equal(t.engine.snapshot().repo.identity, null, 'not known: neither yes nor no');
  const a = await doneAgent(t);
  const card = await t.engine.proposeMerge(a.id);
  assert.ok(card.confirm, card.reply);
  // git itself says no at the yes, in the engine's words.
  t.git.mergeResult = { ok: false, why: 'identity', sentence: 'Git does not know your name and email yet.' };
  assert.equal((await t.engine.confirm(card.confirm.id, true)).reply, 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.');
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ end of the source-control tests

test('words not caught say what to type; while a permission waits in the centre, they say so; a no keeps its “don’t”', async () => {
  const t = live();
  t.engine.deps.commands = commands;
  assert.equal((await t.engine.command('ok')).reply, 'I did not catch that. Say what to work on, like “the login page is broken”, or ask “what needs me”.');
  const { id } = await started(t);
  const pending = t.engine.hookPreToolUse(id, rootPayload);
  await until(() => t.store.get(id).ask);
  const askId = t.store.get(id).ask.id;
  const r = await t.engine.command('the login page is broken', { focusId: id, askId });
  assert.equal(r.reply, 'Fix login redirect is waiting for your OK. Say “yes” or “no” to it first.');
  assert.equal(await settled(pending), false, 'still held');
  // The agent hears the no as it was said, "don't" and all.
  await t.engine.command("don't use the production database", { focusId: id, askId });
  const out = await pending;
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, "The person said no, and added: don't use the production database");
  await t.engine.shutdown();
});

// ------------------------------------------------------------------ full permissions

/** The person's choices as createPrefs keeps them (src/core/prefs.mjs), in memory, recording what the engine saves. */
function prefsStore(start = {}) {
  let now = { theme: 'green', detail: 'calm', answered: false, permissions: 'ask', ...start };
  const saved = [];
  return {
    saved,
    get: () => ({ ...now }),
    set(change) { saved.push(change); now = { ...now, ...change }; return { ok: true, prefs: { ...now } }; },
  };
}
const FULL_DETAIL = "Every agent and its helpers can then run any command, change or delete any file your account can, and use your sign-ins, without asking. They still ask before steps that name Claude Code's own settings. It stays on until you turn it off.";
const FULL_ON = "Full permissions are on. Agents ask only before steps that name Claude Code's own settings.";
const FULL_OFF = 'Agents ask again before risky steps.';
const FULL_REASON = 'Full permissions are on.';
const pause = (ms = 10) => new Promise(r => setTimeout(r, ms));

test('full permissions: turning them on always asks first, with a card of its own; Keep asking changes nothing', async () => {
  const prefs = prefsStore();
  const t = live({ prefs });
  assert.equal(t.engine.permissionMode, 'ask');
  assert.equal(t.engine.snapshot().permissions, 'ask');
  const r = await t.engine.permissions('full');
  assert.deepEqual(r, {
    reply: 'Let agents do anything without asking?',
    confirm: { id: r.confirm.id, sentence: 'Let agents do anything without asking?', detail: FULL_DETAIL, kind: 'permissions', yes: 'Turn on full permissions', no: 'Keep asking', danger: true },
  });
  assert.equal(t.engine.permissionMode, 'ask', 'nothing changes before the yes');
  assert.deepEqual(prefs.saved, []);
  assert.deepEqual(t.notices, [], 'the card says itself');
  const no = await t.engine.confirm(r.confirm.id, false);
  assert.equal(no.reply, 'OK, agents still ask before risky steps.');
  assert.equal(t.engine.permissionMode, 'ask');
  assert.deepEqual(prefs.saved, []);
  // a yes to the card once it is gone does nothing
  assert.deepEqual(await t.engine.confirm(r.confirm.id, true), { reply: 'That request is no longer waiting. Ask again if you still want it.' });
  assert.equal(t.engine.permissionMode, 'ask');
  // only the two modes
  for (const mode of ['FULL', 'on', '', null, undefined, 1]) {
    await assert.rejects(t.engine.permissions(mode), { message: 'Say whether agents should ask first or have full permissions.' }, String(mode));
  }
  await t.engine.shutdown();
});

test('full permissions: the yes turns them on, keeps them, says so, and allows every question already waiting, helpers’ too', async () => {
  const prefs = prefsStore();
  const logged = [];
  const t = live({ prefs, log: (level, ...args) => logged.push(`${level}: ${args.join(' ')}`) });
  const { id, runner } = await started(t);
  const helperId = `${id}-${subagentPayload.agent_id.slice(0, 8)}`;
  runner.emit({ kind: EV.CREATED, agentId: helperId, parentId: id, name: 'List repository files', harness: 'claude' });
  runner.emit({ kind: EV.STATE, agentId: helperId, state: 'working' });
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  await until(() => t.store.get(id).ask);
  const b = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } }); // waits behind a, unseen
  const h = t.engine.hookPreToolUse(id, subagentPayload);
  await until(() => t.store.get(helperId).ask);
  await pause();
  const card = (await t.engine.permissions('full')).confirm;
  assert.equal(card.detail, `${FULL_DETAIL} The 3 questions waiting now are allowed too.`);
  assert.equal(await settled(a), false, 'nothing is allowed before the yes');
  const yes = await t.engine.confirm(card.id, true);
  assert.equal(yes.reply, 'Full permissions are on. 3 waiting questions were allowed.', 'it counts what it allowed');
  for (const p of [a, b, h]) {
    assert.deepEqual((await p).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: FULL_REASON });
  }
  assert.equal(t.engine.permissionMode, 'full');
  assert.equal(t.engine.snapshot().permissions, 'full');
  assert.deepEqual(prefs.saved, [{ permissions: 'full' }]);
  assert.equal(t.notices.filter(n => n === yes.reply).length, 1, 'said once');
  // the log says so too, and that agents still ask before steps that name Claude Code's own settings
  assert.deepEqual(logged.filter(l => /Full permissions/.test(l)), ["warn: Full permissions are on: agents ask only before steps that name Claude Code's own settings."]);
  assert.equal(t.store.get(id).ask, null);
  assert.equal(t.store.get(id).state, 'working');
  assert.equal(t.store.get(helperId).ask, null);
  assert.deepEqual(t.store.get(id).approvals, { auto: 2, byYou: 0, denied: 0 }, 'they count as automatic approvals');
  assert.deepEqual(t.store.get(helperId).approvals, { auto: 1, byYou: 0, denied: 0 });
  // an agent already running gets the new mode at its next step: allowed at once, as an automatic approval
  const next = await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm c' } });
  assert.deepEqual(next.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: FULL_REASON });
  assert.equal(t.calls.decide.at(-1).full, true, 'the policy hears that full permissions are on');
  assert.equal(t.store.get(id).approvals.auto, 3);
  // what the policy refuses is still refused
  assert.equal((await t.engine.hookPreToolUse(id, { tool_name: 'Forbidden', tool_input: {} })).hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.shutdown();
});

test('full permissions: one question waiting is said so; one that would change Claude Code’s own settings is not counted, and still waits for the person', async () => {
  const t = live({ prefs: prefsStore() });
  const { id } = await started(t);
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  await until(() => t.store.get(id).ask);
  const s = t.engine.hookPreToolUse(id, { tool_name: 'Settings', tool_input: {} });
  await pause();
  const card = (await t.engine.permissions('full')).confirm;
  assert.equal(card.detail, `${FULL_DETAIL} The 1 question waiting now is allowed too.`);
  await t.engine.confirm(card.id, true);
  assert.equal((await a).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(await settled(s), false, 'the floor is never allowed by the yes: the person still answers it');
  await until(() => t.store.get(id).ask);
  assert.equal(t.store.get(id).ask.sentence, 'Fix login redirect wants to use Settings');
  // a new step like it is refused at once
  const again = await t.engine.hookPreToolUse(id, { tool_name: 'Settings', tool_input: {} });
  assert.equal(again.hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await s).hookSpecificOutput.permissionDecision, 'deny');
  // with nothing waiting, the card says nothing more
  await t.engine.permissions('ask');
  assert.equal((await t.engine.permissions('full')).confirm.detail, FULL_DETAIL);
  await t.engine.shutdown();
});

test('full permissions: turning them off is at once, with no card, and agents ask again at their next step', async () => {
  const prefs = prefsStore({ permissions: 'full' });
  const t = live({ prefs });
  assert.equal(t.engine.permissionMode, 'full', 'read at start');
  const { id } = await started(t);
  assert.equal((await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } })).hookSpecificOutput.permissionDecision, 'allow');
  const off = await t.engine.permissions('ask');
  assert.deepEqual(off, { ok: true, reply: FULL_OFF, permissions: 'ask' });
  assert.equal(t.engine.permissionMode, 'ask');
  assert.equal(t.engine.snapshot().permissions, 'ask');
  assert.deepEqual(prefs.saved, [{ permissions: 'ask' }]);
  assert.ok(t.notices.includes(FULL_OFF));
  const held = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  assert.equal(await settled(held), false, 'it asks again');
  assert.equal(t.calls.decide.find(r => r.input.command === 'rm b').full, false, 'the policy decides it with full permissions off');
  // off when it is off, or on when it is on, says so and changes nothing
  assert.deepEqual(await t.engine.permissions('ask'), { ok: true, reply: 'Agents already ask before risky steps.', permissions: 'ask' });
  assert.deepEqual(prefs.saved, [{ permissions: 'ask' }]);
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  await held;
  await t.engine.shutdown();
});

test('full permissions: read at start in live mode; anything but full is ask; the demo starts asking and keeps its choice to itself', async () => {
  const t = live({ prefs: prefsStore({ permissions: 'full' }) });
  assert.equal(t.engine.permissionMode, 'full');
  assert.equal(t.engine.snapshot().permissions, 'full');
  assert.deepEqual(await t.engine.permissions('full'), { ok: true, reply: 'Full permissions are already on.', permissions: 'full' });
  await t.engine.shutdown();
  for (const prefs of [prefsStore({ permissions: 'FULL' }), prefsStore({ permissions: true }), { get() { throw new Error('unreadable'); }, set() { return { ok: true }; } }, null]) {
    const x = live({ prefs });
    assert.equal(x.engine.permissionMode, 'ask');
    await x.engine.shutdown();
  }
  // the demo neither reads nor keeps it: what is turned on there is for that run only, never for your own agents
  const dprefs = prefsStore({ permissions: 'full' });
  const d = demo({ prefs: dprefs });
  assert.equal(d.engine.permissionMode, 'ask');
  const card = (await d.engine.permissions('full')).confirm;
  assert.equal((await d.engine.confirm(card.id, true)).reply, FULL_ON);
  assert.equal(d.engine.permissionMode, 'full');
  assert.equal((await d.engine.permissions('ask')).reply, FULL_OFF);
  assert.deepEqual(dprefs.saved, []);
  await d.engine.shutdown();
});

test('full permissions: when they cannot be kept for the next start, they still last for this run, and the reply says so', async () => {
  const saved = [];
  const ON_NOT_KEPT = 'Full permissions are on for now, but Workbench could not save that, so agents will ask again the next time it starts.';
  const prefs = { get: () => ({ permissions: 'ask' }), set: (c) => { saved.push(c); return { ok: false, sentence: 'Workbench could not keep that choice.', prefs: {} }; } };
  const t = live({ prefs });
  const card = (await t.engine.permissions('full')).confirm;
  assert.equal((await t.engine.confirm(card.id, true)).reply, ON_NOT_KEPT);
  assert.equal(t.engine.permissionMode, 'full');
  // turning them off again cannot be saved either, but what is kept says off, so the next start asks anyway: nothing more to say
  assert.equal((await t.engine.permissions('ask')).reply, FULL_OFF);
  const throwing = live({ prefs: { get: () => ({}), set: () => { throw new Error('disk full'); } } });
  const c2 = (await throwing.engine.permissions('full')).confirm;
  assert.equal((await throwing.engine.confirm(c2.id, true)).reply, ON_NOT_KEPT);
  assert.equal(throwing.engine.permissionMode, 'full');
  await t.engine.shutdown();
  await throwing.engine.shutdown();
});

test('full permissions with the real policy: what would ask runs as an automatic approval, the floor is still refused, and a step that names Claude Code’s settings asks', async (ctx) => {
  const t = liveFolders(ctx, { prefs: prefsStore({ permissions: 'full' }) });
  const seen = [];
  t.engine.deps.policy = { decide: (req) => { seen.push(req); return policyMod.decide(req); } };
  const { id } = await started(t);
  const hook = async (tool_name, tool_input) => (await t.engine.hookPreToolUse(id, { tool_name, tool_input })).hookSpecificOutput;
  assert.deepEqual(await hook('Bash', { command: 'rm -rf build && npm install' }), { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: FULL_REASON });
  assert.deepEqual(await hook('WebFetch', { url: 'https://example.com' }), { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: FULL_REASON });
  assert.equal((await hook('Read', { file_path: 'README.md' })).permissionDecisionReason, "Looking at files inside the agent's own folder is always allowed.");
  assert.deepEqual(await hook('Write', { file_path: '.claude/settings.json', content: '{}' }), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Files in a .claude folder change how Claude Code itself runs, so agents may not change them.' });
  assert.deepEqual(await hook('Agent', { description: 'x', prompt: 'y', isolation: 'worktree' }), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: "Helpers must work in this agent's own folder, not in a separate copy or on another computer. Start the helper again without isolation." });
  assert.ok(seen.every(r => r.full === true));
  assert.deepEqual(t.store.get(id).approvals, { auto: 3, byYou: 0, denied: 2 });
  assert.equal(t.store.get(id).ask, null, 'nothing asked');
  // a command that names Claude Code's own settings waits for the person, with the reason it asks for without full
  // permissions and why they do not cover it; its question says only that the agent wants to run a command, never what
  // the command does with them
  const name = t.store.get(id).name;
  const named = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm -rf .claude' } });
  await until(() => t.store.get(id).ask);
  assert.equal(t.store.get(id).state, 'needs_ok');
  assert.equal(t.store.get(id).ask.sentence, `${name} wants to run a command`);
  assert.equal(t.store.get(id).ask.why, "This command is not on the list of safe commands. Full permissions do not cover steps that name Claude Code's own settings.");
  assert.equal(t.store.get(id).ask.detail, 'rm -rf .claude');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await named).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(seen.length, 6, 'judged once, as full permissions judge it');
  // one that writes .gitignore, not a file in those settings, is asked about in the same words
  const ignore = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: "echo '.claude/' >> .gitignore" } });
  await until(() => t.store.get(id).ask);
  assert.deepEqual([t.store.get(id).ask.sentence, t.store.get(id).ask.why, t.store.get(id).ask.detail], [`${name} wants to run a command`,
    "The command chains, redirects or substitutes other commands. Full permissions do not cover steps that name Claude Code's own settings.", "echo '.claude/' >> .gitignore"]);
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await ignore).hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.shutdown();
});

test('full permissions: a step they do not cover asks while they are on, and stays waiting at the yes to their card', async () => {
  const t = live({ prefs: prefsStore({ permissions: 'full' }) });
  const { id } = await started(t);
  // the stand-in policy's SettingsCommand names Claude Code's settings: it asks with full permissions on too
  const p = t.engine.hookPreToolUse(id, { tool_name: 'SettingsCommand', tool_input: { command: 'rm -rf .claude' } });
  await until(() => t.store.get(id).ask);
  assert.equal(t.store.get(id).ask.why, "Needs a person. Full permissions do not cover steps that name Claude Code's own settings.");
  assert.equal(await settled(p), false, 'it waits for the person');
  // turned off and on again, their yes leaves it waiting, and counts nothing
  await t.engine.permissions('ask');
  const card = (await t.engine.permissions('full')).confirm;
  assert.equal(card.detail, FULL_DETAIL, 'not counted among the questions they allow');
  assert.equal((await t.engine.confirm(card.id, true)).reply, FULL_ON);
  assert.equal(await settled(p), false);
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Allow' });
  assert.equal((await p).hookSpecificOutput.permissionDecision, 'allow');
  await t.engine.shutdown();
});

test('full permissions off: a long line with many cd steps shows its question at once, checked by one decide for each mode', async (ctx) => {
  const t = liveFolders(ctx, { prefs: prefsStore() });
  const seen = [];
  t.engine.deps.policy = { decide: (req) => { seen.push(req.full); return policyMod.decide(req); } };
  const { id } = await started(t);
  const folder = path.join(t.dir, fs.readdirSync(t.dir)[0]);
  for (let i = 0; i < 200; i++) fs.mkdirSync(path.join(folder, `pkg${i}`));
  const command = Array.from({ length: 200 }, (_, i) => `cd pkg${i} && npm test > out.txt && cd ..`).join(' && ');
  const t0 = performance.now();
  const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command } });
  await until(() => t.store.get(id).ask);
  // the first request of a fresh engine, before its code is compiled: the 250 ms limit is held by the test of the slow lines below
  assert.ok(performance.now() - t0 < 1000, `the question came after ${Math.round(performance.now() - t0)} ms`);
  // asked once as the mode is, and once as full permissions would judge it, for the yes to their card
  assert.deepEqual(seen, [false, true]);
  // too involved for full permissions to check in time: their card does not count it, and it waits for the person
  assert.equal((await t.engine.permissions('full')).confirm.detail, FULL_DETAIL);
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  assert.equal((await pending).hookSpecificOutput.permissionDecision, 'deny');
  await t.engine.shutdown();
});

test('full permissions on and off: each slow line the checkers found is answered or asked within 250 ms, and the engine keeps ticking', async (ctx) => {
  for (const mode of ['ask', 'full']) {
    const t = liveFolders(ctx, { prefs: prefsStore({ permissions: mode }) });
    t.engine.deps.policy = policyMod;
    const { id } = await started(t);
    slowFolder(path.join(t.dir, fs.readdirSync(t.dir)[0]));
    const wrong = [];
    // one request: how long until it is answered or asked about, and the longest a 100 ms timer had to wait meanwhile
    const once = async (command) => {
      let last = performance.now();
      let gap = 0;
      const tick = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 100);
      const t0 = performance.now();
      let out = null;
      const pending = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command } }).then(o => { out = o; });
      await until(() => out || t.store.get(id).ask);
      const ms = performance.now() - t0;
      await pause(10); // a tick held up by the check comes as soon as it ends
      clearInterval(tick);
      if (!out) await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
      await pending;
      return { ms, stood: gap - 100 };
    };
    for (const { label, command } of slowLines()) {
      // the fastest of up to three tries counts, as in policy.test.mjs: other tests running beside this one can slow one down
      let best = await once(command);
      for (let i = 1; i < 3 && best.ms >= 250; i++) { const r = await once(command); if (r.ms < best.ms) best = r; }
      if (best.ms >= 250) wrong.push(`${label}, full permissions ${mode === 'full' ? 'on' : 'off'}: ${Math.round(best.ms)} ms`);
      if (best.stood >= 250) wrong.push(`${label}, full permissions ${mode === 'full' ? 'on' : 'off'}: the engine stood still for ${Math.round(best.stood)} ms`);
    }
    assert.equal(wrong.length, 0, wrong.join('\n'));
    await t.engine.shutdown();
  }
});

test('full permissions in words: the real parser asks first for "stop asking", a bare yes is not enough, and "ask first" turns them off', async () => {
  const t = live({ prefs: prefsStore() });
  t.engine.deps.commands = commands;
  const r = await t.engine.command('stop asking');
  assert.equal(r.reply, 'Let agents do anything without asking?');
  assert.equal(r.confirm.kind, 'permissions');
  const habit = await t.engine.command('yes', { confirmId: r.confirm.id });
  assert.equal(habit.reply, 'I did not catch that. Say “do it” to turn on full permissions, or “cancel”.');
  assert.equal(habit.confirm.id, r.confirm.id, 'the card stays');
  assert.equal(t.engine.permissionMode, 'ask');
  const yes = await t.engine.command('turn it on', { confirmId: r.confirm.id });
  assert.equal(yes.reply, FULL_ON);
  assert.equal(t.engine.permissionMode, 'full');
  assert.deepEqual(await t.engine.command('full permissions'), { reply: 'Full permissions are already on.' });
  assert.equal((await t.engine.command('ask first')).reply, FULL_OFF);
  assert.equal(t.engine.permissionMode, 'ask');
  // "Keep asking", typed, is the card's no
  const again = await t.engine.command('turn on full permissions');
  assert.equal((await t.engine.command('keep asking', { confirmId: again.confirm.id })).reply, 'OK, agents still ask before risky steps.');
  assert.equal(t.engine.permissionMode, 'ask');
  await t.engine.shutdown();
});

test('full permissions in words: a thanks before them still acts, a question never does, and their card takes its own words beside an agent of that name', async () => {
  const t = live({ prefs: prefsStore() });
  t.engine.deps.commands = commands;
  const card = await t.engine.command('thank you, stop asking');
  assert.equal(card.confirm.kind, 'permissions');
  assert.equal((await t.engine.command('thanks, stop asking', { confirmId: card.confirm.id })).reply, FULL_ON);
  assert.equal(t.engine.permissionMode, 'full');
  // asked, the mark typed apart or not, they change nothing
  for (const q of ['ask first ?', 'ask first?']) {
    assert.notEqual((await t.engine.command(q)).reply, FULL_OFF, q);
    assert.equal(t.engine.permissionMode, 'full', q);
  }
  assert.equal((await t.engine.command('thanks, ask first')).reply, FULL_OFF);
  assert.equal(t.engine.permissionMode, 'ask');
  // an agent called Stop asking: the words alone reach it, and at the card they are still the card's yes
  const { id } = await started(t, { task: 'Stop asking' });
  assert.equal(t.store.get(id).name, 'Stop asking');
  assert.equal((await t.engine.command('stop asking')).confirm, undefined);
  assert.equal(t.engine.permissionMode, 'ask');
  const again = await t.engine.command('turn on full permissions');
  assert.equal((await t.engine.command('stop asking', { confirmId: again.confirm.id })).reply, FULL_ON);
  assert.equal(t.engine.permissionMode, 'full');
  await t.engine.shutdown();
});

test('full permissions in words: an agent named like them is reached by its name, a question with "?!" changes nothing, and "turn it off then" answers their card', async () => {
  const t = live({ prefs: prefsStore({ permissions: 'full' }) });
  t.engine.deps.commands = commands;
  const { id } = await started(t, { task: 'Turn off full permissions when the repo is public' });
  assert.equal(t.store.get(id).name, 'Turn off full permissions');
  for (const said of ['turn off full permissions', 'Turn off full permissions.']) {
    const r = await t.engine.command(said);
    assert.equal(r.confirm, undefined, `${said}: no launch card`);
    assert.equal(t.engine.permissionMode, 'full', said);
  }
  for (const q of ['ask first?!', 'ask first? please', 'ask first?.']) {
    assert.notEqual((await t.engine.command(q)).reply, FULL_OFF, q);
    assert.equal(t.engine.permissionMode, 'full', q);
  }
  assert.equal((await t.engine.command('ask first')).reply, FULL_OFF);
  const card = await t.engine.command('stop asking');
  assert.equal((await t.engine.command('turn it off then', { confirmId: card.confirm.id })).reply, 'OK, agents still ask before risky steps.');
  assert.equal(t.engine.permissionMode, 'ask');
  await t.engine.shutdown();
});

test('full permissions: the launch, the spending limit and Codex are as before', async () => {
  const t = live({ prefs: prefsStore({ permissions: 'full' }) });
  t.engine.deps.commands = commands;
  const launch = await t.engine.command('start an agent to fix the login page');
  assert.equal(launch.confirm.kind, 'start');
  // the card is the engine's as before; the page adds, while full permissions are on, that it asks only before steps that
  // name Claude Code's own settings
  assert.equal(launch.confirm.detail, 'It can spend up to $2.00. It works in its own copy of shop, made from the last commit. Your 2 uncommitted changes are not included.');
  assert.equal(launch.confirm.agents, 1, 'how many agents it starts, so the page can say it or they');
  const { id } = await started(t, { task: 'Fix the cart', harness: 'codex' });
  assert.equal((await t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } })).hookSpecificOutput.permissionDecision, 'deny', 'Codex never asks through the hook');
  await t.engine.shutdown();
});

test('full permissions in the demo (real simulator): the yes allows the simulated questions waiting, as automatic approvals', async () => {
  const d = await realDemo();
  const before = structuredClone(d.byName('Checkout fix'));
  assert.equal(before.state, 'needs_ok');
  assert.equal(before.ask.type, 'permission');
  const card = (await d.engine.permissions('full')).confirm;
  assert.equal(card.detail, `${FULL_DETAIL} The 1 question waiting now is allowed too.`);
  assert.equal((await d.engine.confirm(card.id, true)).reply, 'Full permissions are on. 1 waiting question was allowed.');
  await until(() => d.byName('Checkout fix').state !== 'needs_ok');
  const after = d.byName('Checkout fix');
  assert.equal(after.ask, null);
  assert.equal(after.approvals.auto, before.approvals.auto + 1);
  assert.equal(after.approvals.byYou, before.approvals.byYou);
  await d.engine.shutdown();
});

test('full permissions in the demo: a simulated permission ask that comes while they are on is answered Allow at once', async () => {
  const d = demo();
  const card = (await d.engine.permissions('full')).confirm;
  await d.engine.confirm(card.id, true);
  const ask = { id: 'sim-9-abcdef', type: 'permission', sentence: 'Checkout fix wants to run a command', detail: 'npm run db:migrate', options: ['Allow', 'Deny'], primary: 'Allow' };
  d.engine.ingest({ kind: EV.CREATED, agentId: 's1', parentId: null, name: 'Checkout fix', task: 'Fix the checkout', harness: 'claude', machineId: 'laptop' });
  d.engine.ingest({ kind: EV.ASK, agentId: 's1', ask });
  d.engine.ingest({ kind: EV.STATE, agentId: 's1', state: 'needs_ok' });
  assert.deepEqual(d.sim.answers, [], 'not inside the simulator’s own step: once it has said all of it');
  await until(() => d.sim.answers.length === 1);
  assert.equal(d.sim.answers[0].agentId, 's1');
  assert.equal(d.sim.answers[0].ask.id, ask.id);
  assert.equal(d.sim.answers[0].answer, 'Allow');
  assert.deepEqual(d.sim.answers[0].opts, { how: 'auto' });
  // a question is still the person's, and with full permissions off a permission waits again
  d.engine.ingest({ kind: EV.ASK, agentId: 's1', ask: { id: 'sim-10-abcdef', type: 'question', sentence: 'Which database?', options: [] } });
  await d.engine.permissions('ask');
  d.engine.ingest({ kind: EV.ASK, agentId: 's1', ask: { ...ask, id: 'sim-11-abcdef' } });
  await pause(30);
  assert.equal(d.sim.answers.length, 1);
  await d.engine.shutdown();
});

test('full permissions: the notice after the yes counts what it allowed, including a question that came after the card', async () => {
  const t = live({ prefs: prefsStore() });
  const { id } = await started(t);
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  await until(() => t.store.get(id).ask);
  const card = (await t.engine.permissions('full')).confirm;
  assert.equal(card.detail, `${FULL_DETAIL} The 1 question waiting now is allowed too.`, 'the card counts what waits when it is made');
  const b = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  const s = t.engine.hookPreToolUse(id, { tool_name: 'Settings', tool_input: {} }); // full permissions would refuse it: not counted
  await pause();
  const yes = await t.engine.confirm(card.id, true);
  assert.equal(yes.reply, 'Full permissions are on. 2 waiting questions were allowed.');
  assert.ok(t.notices.includes(yes.reply));
  for (const p of [a, b]) assert.equal((await p).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(await settled(s), false, 'the one they would refuse still waits for the person');
  await t.engine.answer(id, { askId: t.store.get(id).ask.id, answer: 'Deny' });
  await s;
  // one question, and none
  await t.engine.permissions('ask');
  const c = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm c' } });
  await until(() => t.store.get(id).ask);
  const one = (await t.engine.permissions('full')).confirm;
  assert.equal((await t.engine.confirm(one.id, true)).reply, 'Full permissions are on. 1 waiting question was allowed.');
  await c;
  await t.engine.permissions('ask');
  const none = (await t.engine.permissions('full')).confirm;
  assert.equal((await t.engine.confirm(none.id, true)).reply, FULL_ON);
  await t.engine.shutdown();
});

test('full permissions: turning them off withdraws a card that would turn them on, and a card from before the last change is refused', async () => {
  const t = live({ prefs: prefsStore() });
  t.engine.deps.commands = commands;
  const CHANGED = 'That changed. Have another look.';
  const NOT_WAITING = 'That request is no longer waiting. Ask again if you still want it.';
  // two cards; the yes to one turns them on, so the other is from before the change: neither its yes nor its no acts
  const first = (await t.engine.permissions('full')).confirm;
  const second = (await t.engine.permissions('full')).confirm;
  await t.engine.confirm(second.id, true);
  assert.equal(t.engine.permissionMode, 'full');
  assert.deepEqual(await t.engine.confirm(first.id, false), { reply: CHANGED });
  assert.equal(t.engine.permissionMode, 'full', 'its "Keep asking" did not turn them off');
  // the same when its yes is said in words
  await t.engine.permissions('ask');
  const third = (await t.engine.permissions('full')).confirm;
  const fourth = (await t.engine.permissions('full')).confirm;
  await t.engine.confirm(fourth.id, true);
  assert.deepEqual(await t.engine.command('turn it on', { confirmId: third.id }), { reply: CHANGED });
  assert.ok(t.notices.includes(CHANGED));
  // turning them off, by the button or by words, withdraws every card that would turn them on: its yes finds nothing waiting
  for (const turnOff of [() => t.engine.permissions('ask'), () => t.engine.command('ask first')]) {
    await t.engine.permissions('ask');
    const old = (await t.engine.permissions('full')).confirm;
    const yes = (await t.engine.permissions('full')).confirm;
    await t.engine.confirm(yes.id, true);
    assert.equal(t.engine.permissionMode, 'full');
    await turnOff();
    assert.equal(t.engine.permissionMode, 'ask');
    assert.deepEqual(await t.engine.confirm(old.id, true), { reply: NOT_WAITING });
    assert.equal(t.engine.permissionMode, 'ask', 'a card from before they were turned off never turns them on');
  }
  // "ask first" while they are already off withdraws one too: the person said to keep asking
  const open = (await t.engine.permissions('full')).confirm;
  assert.deepEqual(await t.engine.permissions('ask'), { ok: true, reply: 'Agents already ask before risky steps.', permissions: 'ask' });
  assert.deepEqual(await t.engine.confirm(open.id, true), { reply: NOT_WAITING });
  assert.equal(t.engine.permissionMode, 'ask');
  await t.engine.shutdown();
});

test('full permissions: a request being checked when they go on or off is judged again as the mode now on judges it', async () => {
  const t = live({ prefs: prefsStore() });
  const { id } = await started(t);
  // a stand-in policy that answers only when the test lets it: what would ask is allowed with full permissions on
  const pending = [];
  t.engine.deps.policy = {
    decide: (req) => new Promise(resolve => pending.push({ req, answer: () => resolve(req.full
      ? { decision: 'allow', reason: FULL_REASON, sentence: 'wants to run a command', detail: req.input.command }
      : { decision: 'ask', reason: 'Needs a person.', sentence: 'wants to run a command', detail: req.input.command }) })),
  };
  const next = async () => { await until(() => pending.length); return pending.shift(); };
  // on while it is checked: allowed, never held
  const a = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm a' } });
  const first = await next();
  assert.equal(first.req.full, false);
  const card = (await t.engine.permissions('full')).confirm;
  await t.engine.confirm(card.id, true);
  first.answer();
  const again = await next();
  assert.equal(again.req.full, true, 'judged again with full permissions on');
  again.answer();
  assert.equal((await a).hookSpecificOutput.permissionDecision, 'allow');
  // off while it is checked: it asks, and is not allowed by the answer given while they were on
  const b = t.engine.hookPreToolUse(id, { tool_name: 'Bash', tool_input: { command: 'rm b' } });
  const second = await next();
  assert.equal(second.req.full, true);
  await t.engine.permissions('ask');
  second.answer();
  const third = await next();
  assert.equal(third.req.full, false, 'judged again with full permissions off');
  third.answer();
  await until(() => t.store.get(id).ask);
  assert.equal(await settled(b), false, 'it waits for the person');
  assert.equal(t.store.get(id).ask.why, 'Needs a person.');
  // and when they go on again, the yes allows it, from what full permissions said while it was checked
  const back = (await t.engine.permissions('full')).confirm;
  assert.equal(back.detail, `${FULL_DETAIL} The 1 question waiting now is allowed too.`);
  await t.engine.confirm(back.id, true);
  assert.equal((await b).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(pending.length, 0, 'each mode was asked about once');
  await t.engine.shutdown();
});

test('full permissions: when turning them off cannot be saved, the reply says they will be on again the next time Workbench starts',
  { skip: process.getuid?.() === 0 ? 'the system administrator can write to a folder that is not writable' : false }, async (ctx) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
    const dir = path.join(home, '.workbench');
    const file = prefsFile(home);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ permissions: 'full' })}\n`, { mode: 0o600 });
    fs.chmodSync(dir, 0o500); // ~/.workbench can be read, but no file in it can be replaced
    ctx.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(home, { recursive: true, force: true }); });
    const log = { warn() {}, info() {}, error() {}, debug() {} };
    const t = live({ prefs: createPrefs({ file, log }) });
    assert.equal(t.engine.permissionMode, 'full', 'read at start');
    const off = await t.engine.permissions('ask');
    assert.deepEqual(off, { ok: true, reply: 'Full permissions are off for now, but Workbench could not save that, so they will be on again the next time it starts.', permissions: 'ask' });
    assert.ok(t.notices.includes(off.reply), 'said as a notice');
    assert.equal(t.engine.permissionMode, 'ask', 'off for this run');
    // as said: the next start reads what is kept, and they are on again
    const nextStart = live({ prefs: createPrefs({ file, log }) });
    assert.equal(nextStart.engine.permissionMode, 'full');
    // turned on again in this run: what is kept says on, so nothing more needs saying
    const card = (await t.engine.permissions('full')).confirm;
    assert.equal((await t.engine.confirm(card.id, true)).reply, FULL_ON);
    await t.engine.shutdown();
    await nextStart.engine.shutdown();
  });

// ------------------------------------------------------------------ the file view

const CHECKS = [{ name: 'unit tests', run: 'npm test', timeoutSec: 60 }];

test('the file view: "you" is your folder and an agent’s id its own copy (a helper’s, its agent’s); anything else is refused in plain words', async (ctx) => {
  const t = await realGit(ctx);
  t.deps.files = filesMod;
  assert.deepEqual(await t.engine.files('you'), { ok: true, in: 'you', name: 'repo', branch: 'main', files: [{ path: 'cart.js' }] });
  const a = await started(t, { task: 'Fix the cart total' });
  fs.writeFileSync(path.join(a.v.workspace, 'tax.js'), 'export const tax = 0.2;\n');
  const theirs = await t.engine.files(a.id);
  assert.equal(theirs.ok, true);
  assert.equal(theirs.in, a.id);
  assert.equal(theirs.name, 'repo');
  assert.equal(theirs.branch, t.store.get(a.id).work.branch);
  assert.deepEqual(theirs.files.map(f => f.path), ['cart.js', 'tax.js']);
  // A helper works in its agent's folder.
  a.runner.emit({ kind: EV.CREATED, agentId: `${a.id}-helper01`, parentId: a.id, name: 'Look for the tax rate' });
  assert.equal((await t.engine.files(`${a.id}-helper01`)).in, a.id);
  // Reading and searching go by the same rule.
  assert.equal((await t.engine.file(a.id, 'tax.js')).text, 'export const tax = 0.2;\n');
  assert.deepEqual(await t.engine.search(a.id, 'tax'), { ok: true, in: a.id, results: [{ path: 'tax.js', line: 1, text: 'export const tax = 0.2;' }] });
  assert.deepEqual(await t.engine.search('you', 'tax'), { ok: true, in: 'you', results: [] });
  assert.deepEqual(await t.engine.search('you', 't'), { ok: false, reply: 'Type at least two characters to search for.', why: 'refused' });
  // Anything else.
  assert.deepEqual(await t.engine.files('nobody'), { ok: false, reply: 'I can’t find that agent.', why: 'gone' });
  for (const where of [42, null, '', undefined, ['you'], { id: a.id }]) {
    assert.deepEqual(await t.engine.files(where), { ok: false, reply: 'Say whose copy to show: yours, or an agent’s.', why: 'refused' }, String(where));
    assert.deepEqual(await t.engine.saveFile(where, 'cart.js', { text: 'x\n', hash: sha('x') }), { ok: false, reply: 'Say whose copy to show: yours, or an agent’s.', why: 'refused' });
  }
  await t.engine.shutdown();
  for (const ask of [t.engine.files('you'), t.engine.file('you', 'cart.js'), t.engine.search('you', 'total'), t.engine.saveFile('you', 'cart.js', { text: 'x\n', hash: sha('x') })]) {
    assert.deepEqual(await ask, { ok: false, reply: 'Workbench is shutting down.', why: 'refused' });
  }
});

test('the file view: a copy whose work was thrown away, or whose folder went, is refused, and the view says so', async (ctx) => {
  const t = await realGit(ctx);
  t.deps.files = filesMod;
  const a = await doneAgent(t);
  const away = await t.engine.proposeDiscard(a.id, { state: 'done_claimed' });
  assert.match((await t.engine.confirm(away.confirm.id, true)).reply, /^Threw away /);
  const name = t.store.get(a.id).name;
  const thrown = { ok: false, reply: `${name}’s work was thrown away, so its copy is gone.`, why: 'gone' };
  assert.deepEqual(await t.engine.files(a.id), thrown);
  assert.deepEqual(await t.engine.file(a.id, 'cart.js'), thrown);
  assert.deepEqual(await t.engine.search(a.id, 'total'), thrown);
  assert.deepEqual(await t.engine.saveFile(a.id, 'cart.js', { text: 'x\n', hash: sha('x') }), thrown);
  const b = await started(t, { task: 'Round the tax down' });
  fs.rmSync(b.v.workspace, { recursive: true, force: true });
  const bName = t.store.get(b.id).name;
  assert.deepEqual(await t.engine.file(b.id, 'cart.js'), { ok: false, reply: `${bName}’s folder is not on this computer any more.`, why: 'gone' });
  assert.equal(t.store.get(b.id).work.folder, false);
  await t.engine.shutdown();
});

test('the file view: your list marks the files agents changed, from what each recorded; an agent’s copy marks its own', async (ctx) => {
  const t = await realGit(ctx);
  t.deps.files = filesMod;
  const run = async (task, write) => {
    const a = await started(t, { task });
    for (const [rel, text] of Object.entries(write)) fs.writeFileSync(path.join(a.v.workspace, rel), text);
    a.runner.emit({ kind: EV.TURN, phase: 'start' });
    a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'Done.', backgroundTasks: 0, isError: false });
    await until(() => t.store.get(a.id).state === 'done_claimed', { timeout: 10_000 });
    return t.store.get(a.id);
  };
  const a = await run('Fix the cart total', { 'cart.js': 'export const total = 2;\n' });
  const b = await run('Add a tax line', { 'cart.js': 'export const total = 1;\nexport const tax = 1;\n', 'tax.js': 'export const rate = 0.2;\n' });
  const mark = v => ({ agentId: v.id, name: v.name, state: 'done_claimed' });
  const byId = (x, y) => (x.agentId < y.agentId ? -1 : 1);
  const you = await t.engine.files('you');
  assert.deepEqual(you.files.map(f => f.path), ['cart.js']);
  assert.deepEqual(you.files[0].changedBy.sort(byId), [mark(a), mark(b)].sort(byId));
  const theirs = await t.engine.files(b.id);
  assert.deepEqual(theirs.files, [{ path: 'cart.js', changedBy: [mark(b)] }, { path: 'tax.js', changedBy: [mark(b)] }]);
  // Work thrown away marks nothing any more.
  await t.engine.confirm((await t.engine.proposeDiscard(a.id, { state: 'done_claimed' })).confirm.id, true);
  assert.deepEqual((await t.engine.files('you')).files, [{ path: 'cart.js', changedBy: [mark(b)] }]);
  await t.engine.shutdown();
});

test('the file view: a file in an agent’s copy says which lines its work changed; a check that finds the same file answers only that', async (ctx) => {
  const t = await realGit(ctx);
  t.deps.files = filesMod;
  const a = await started(t, { task: 'Fix the cart total' });
  const text = 'export const total = 1;\nexport const tax = 2;\n';
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), text);
  const f = await t.engine.file(a.id, 'cart.js');
  assert.deepEqual(f, { ok: true, in: a.id, path: 'cart.js', kind: 'text', text, hash: sha(text), size: Buffer.byteLength(text), lines: 2, eol: 'lf', bom: false, changedLines: [2], editable: true });
  assert.deepEqual(await t.engine.file(a.id, 'cart.js', { check: f.hash }), { ok: true, same: true });
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), `${text}export const fee = 3;\n`);
  const again = await t.engine.file(a.id, 'cart.js', { check: f.hash });
  assert.equal(again.same, undefined);
  assert.deepEqual(again.changedLines, [2, 3]);
  // Your folder has no agent's lines; a check that is not a hash is as if none came.
  const mine = await t.engine.file('you', 'cart.js', { check: 'not a hash' });
  assert.deepEqual([mine.kind, mine.changedLines, mine.editable], ['text', undefined, true]);
  assert.deepEqual(await t.engine.file('you', 'gone.js'), { ok: true, in: 'you', path: 'gone.js', kind: 'missing', hash: null, size: 0, eol: 'none', bom: false, editable: false, why: 'This file is not there any more.' });
  // The path rules, checked again by the engine.
  assert.deepEqual(await t.engine.file('you', '../cart.js'), { ok: false, reply: '“../cart.js” is not the name of a file inside the project.', why: 'refused' });
  assert.deepEqual(await t.engine.file('you', '.git/config'), { ok: false, reply: 'Workbench leaves git’s own folder alone, so it does not open .git/config.', why: 'refused' });
  assert.deepEqual(await t.engine.file('you', 42), { ok: false, reply: 'No file was named.', why: 'refused' });
  await t.engine.shutdown();
});

test('the file view: what Workbench does not edit says why, in one line', async (ctx) => {
  const t = liveFolders(ctx);
  t.deps.files = filesMod;
  const a = await doneAgent(t);
  const w = a.v.workspace;
  const key = ['sk', 'live', crypto.randomBytes(12).toString('hex')].join('_');
  fs.writeFileSync(path.join(w, 'logo.png'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(w, 'big.log'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  fs.writeFileSync(path.join(w, 'latin1.txt'), Buffer.from([0x63, 0xe9, 0x0a]));
  fs.writeFileSync(path.join(w, 'mixed.txt'), 'a\r\nb\n');
  fs.writeFileSync(path.join(w, '.env'), `STRIPE_SECRET_KEY=${key}\n`);
  fs.symlinkSync('/etc/hosts', path.join(w, 'hosts'));
  const why = async (rel) => {
    const f = await t.engine.file(a.id, rel);
    return [f.kind, f.editable, f.why];
  };
  assert.deepEqual(await why('logo.png'), ['binary', false, 'This is a binary file.']);
  assert.deepEqual(await why('big.log'), ['large', false, 'This file is too large to show here.']);
  assert.deepEqual(await why('latin1.txt'), ['notutf8', false, 'This file is not UTF-8 text, so Workbench does not show it.']);
  assert.deepEqual(await why('mixed.txt'), ['text', false, 'This file mixes line endings, so Workbench does not edit it.']);
  assert.deepEqual(await why('.env'), ['secret', false, 'This file holds keys, so Workbench shows only their last four characters and does not edit it.']);
  assert.deepEqual(await why('hosts'), ['link', false, 'This is a link to /etc/hosts.']);
  const env = await t.engine.file(a.id, '.env');
  assert.equal(env.text.includes(key), false);
  assert.equal(env.text, `STRIPE_SECRET_KEY=•••• ${key.slice(-4)}\n`);
  await t.engine.shutdown();
});

test('the file view: a save in your folder is an uncommitted change, and the page hears your folder’s count of them at once', async (ctx) => {
  const t = await realGit(ctx);
  t.deps.files = filesMod;
  await t.engine.start();
  assert.equal(t.engine.snapshot().repo.dirty, 0);
  const heard = [];
  t.store.on('repo', r => heard.push(r));
  const f = await t.engine.file('you', 'cart.js');
  assert.deepEqual(await t.engine.saveFile('you', 'cart.js', { text: 'export const total = 3;\n', hash: f.hash }), { ok: true, hash: sha('export const total = 3;\n'), size: 24 });
  assert.equal(fs.readFileSync(path.join(t.repo, 'cart.js'), 'utf8'), 'export const total = 3;\n');
  await until(() => heard.length > 0, { timeout: 10_000 });
  assert.equal(heard.at(-1).dirty, 1);
  assert.equal(t.engine.snapshot().repo.dirty, 1);
  await t.engine.shutdown();
});

test('the file view: a save over a file that changed is refused with its hash now; Save mine anyway needs that hash; refusals are plain', async (ctx) => {
  const t = liveFolders(ctx);
  t.deps.files = filesMod;
  const a = await doneAgent(t);
  const file = path.join(a.v.workspace, 'cart.js');
  fs.writeFileSync(file, 'one\n');
  const f = await t.engine.file(a.id, 'cart.js');
  fs.writeFileSync(file, 'the agent\n');
  const r = await t.engine.saveFile(a.id, 'cart.js', { text: 'mine\n', hash: f.hash });
  assert.deepEqual(r, { ok: false, reply: 'cart.js changed on disk since it was opened, so nothing was written.', why: 'changed', hash: sha('the agent\n') });
  assert.equal(fs.readFileSync(file, 'utf8'), 'the agent\n');
  assert.deepEqual(await t.engine.saveFile(a.id, 'cart.js', { text: 'mine\n', hash: r.hash, force: true }), { ok: true, hash: sha('mine\n'), size: 5 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n');
  assert.deepEqual(await t.engine.saveFile(a.id, 'cart.js', { text: 'x\n' }), { ok: false, reply: 'Workbench does not know which version of cart.js was edited, so nothing was saved.', why: 'refused' });
  assert.deepEqual(await t.engine.saveFile(a.id, 'cart.js', { text: 'x'.repeat(1024 * 1024 + 1), hash: sha('mine\n') }), { ok: false, reply: 'The text is larger than 1 MB, so Workbench did not save it.', why: 'refused' });
  assert.deepEqual(await t.engine.saveFile(a.id, 'new.js', { text: 'x\n', hash: sha('') }), { ok: false, reply: 'new.js is not there any more, and Workbench does not make new files.', why: 'refused' });
  await t.engine.shutdown();
});

test('the file view: a save into the copy of an agent whose run has ended records its work and runs its checks again; it is done and checked again only once they saw the change', async (ctx) => {
  const second = gate();
  const t = liveFolders(ctx, { deps: { checks: CHECKS, checksGates: [null, second] } });
  t.deps.files = filesMod;
  const a = await doneAgent(t);
  assert.equal(t.store.get(a.id).state, 'done_checked');
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'export const total = 1;\n');
  const f = await t.engine.file(a.id, 'cart.js');
  const before = { diffStats: t.calls.diffStats.length, runChecks: t.calls.runChecks.length };
  assert.equal((await t.engine.saveFile(a.id, 'cart.js', { text: 'export const total = 2;\n', hash: f.hash })).ok, true);
  // Before the answer came back: no "checked" about content its checks have not seen.
  assert.equal(t.store.get(a.id).state, 'done_claimed');
  await until(() => t.calls.runChecks.length === before.runChecks + 1);
  assert.equal(t.calls.diffStats.length, before.diffStats + 1, 'what changed is recorded again first');
  assert.equal(t.calls.runChecks.at(-1).cwd, a.v.workspace);
  assert.equal(t.calls.runChecks.at(-1).env.WORKBENCH_AGENT_ID, a.id);
  assert.deepEqual([t.store.get(a.id).state, t.store.get(a.id).checks.state], ['done_claimed', 'running']);
  // Meanwhile nothing merges it: its checks are running.
  assert.deepEqual(await t.engine.proposeMerge(a.id), { ok: false, reply: 'Fix cart total is still working. Merge it when it is done.' });
  second.open();
  await until(() => t.store.get(a.id).state === 'done_checked');
  assert.equal(t.store.get(a.id).checks.state, 'passed');
  assert.equal(t.store.get(a.id).says, 'I fixed the cart total.', 'its own words stay');
  // A change its checks fail.
  t.deps.receipt.runChecks = async (o) => {
    t.calls.runChecks.push(o);
    return { state: 'failed', results: [{ name: 'unit tests', ok: false, ms: 5, tail: 'expected 2, got 3' }] };
  };
  const g = await t.engine.file(a.id, 'cart.js');
  await t.engine.saveFile(a.id, 'cart.js', { text: 'export const total = 3;\n', hash: g.hash });
  await until(() => t.store.get(a.id).state === 'checks_failed');
  assert.equal(t.store.get(a.id).stateReason, 'The check “unit tests” did not pass.');
  await t.engine.shutdown();
});

test('the file view: a save into the copy of an agent that is done, with no checks to run, gives it a new finish all the same, as the end of a turn would', async (ctx) => {
  const t = liveFolders(ctx); // no checks declared: its recheck records what changed, and it is done again
  t.deps.files = filesMod;
  const a = await doneAgent(t);
  const was = t.store.get(a.id);
  assert.equal(was.state, 'done_claimed');
  const finished = was.endedAt;
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'one\n');
  const f = await t.engine.file(a.id, 'cart.js');
  await pause(5); // so a new finish has a new time
  const diffs = t.calls.diffStats.length;
  assert.equal((await t.engine.saveFile(a.id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
  await until(() => t.calls.diffStats.length === diffs + 1 && t.store.get(a.id).endedAt !== finished);
  const v = t.store.get(a.id);
  assert.equal(v.state, 'done_claimed');
  assert.ok(v.endedAt > finished, 'its finish moved, so a look the person gave the old one does not hide this one');
  assert.equal(v.stateSince, v.endedAt);
  assert.equal(v.says, 'I fixed the cart total.', 'its own words stay');
  assert.equal(t.calls.runChecks.length, 0);
  await t.engine.shutdown();
});

test('the file view: a save while a receipt is being built makes it look again; a save after a merge is checked all the same', async (ctx) => {
  const turnEnd = gate();
  const t = liveFolders(ctx, { deps: { checks: CHECKS, checksGates: [turnEnd] } });
  t.deps.files = filesMod;
  const a = await started(t, { task: 'Fix the cart total' });
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'one\n');
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart total.', backgroundTasks: 0, isError: false });
  await until(() => t.calls.runChecks.length === 1); // the turn's checks are running
  assert.equal(t.store.get(a.id).state, 'working');
  const f = await t.engine.file(a.id, 'cart.js');
  assert.equal((await t.engine.saveFile(a.id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
  // The checks under way had not seen the change: they are stopped, and it looks again before it decides.
  await until(() => t.store.get(a.id).state === 'done_checked');
  assert.equal(t.calls.runChecks[0].signal.aborted, true);
  assert.equal(t.calls.runChecks.length, 2);
  assert.equal(t.calls.diffStats.length, 2);
  assert.deepEqual(t.store.get(a.id).checks, { state: 'passed', results: [{ name: 'unit tests', ok: true, ms: 5 }] });
  // A merge closes its idle process, which marks it stopped; a save into its copy afterwards is checked all the same.
  assert.equal((await t.engine.confirm((await t.engine.proposeMerge(a.id)).confirm.id, true)).reply, 'Merged Fix cart total into main.');
  const g = await t.engine.file(a.id, 'cart.js');
  await t.engine.saveFile(a.id, 'cart.js', { text: 'three\n', hash: g.hash });
  assert.equal(t.store.get(a.id).state, 'done_claimed');
  await until(() => t.calls.runChecks.length === 3 && t.store.get(a.id).state === 'done_checked');
  await t.engine.shutdown();
});

test('the file view: a working agent’s copy is saved and left to it; a copy being merged is refused, and so is your folder while a merge runs', async (ctx) => {
  const t = liveFolders(ctx, { deps: { checks: CHECKS } });
  t.deps.files = filesMod;
  const a = await started(t, { task: 'Fix the cart total' });
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'one\n');
  const f = await t.engine.file(a.id, 'cart.js');
  assert.equal(f.editable, true);
  assert.equal((await t.engine.saveFile(a.id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
  assert.equal(t.store.get(a.id).state, 'working');
  assert.equal(t.calls.runChecks.length, 0, 'the end of its turn records it');
  const b = await doneAgent(t, { task: 'Add a tax line' }, 'I added the tax line.');
  fs.writeFileSync(path.join(b.v.workspace, 'tax.js'), 'one\n');
  const fb = await t.engine.file(b.id, 'tax.js');
  t.git.mergeGate = gate();
  const merging = t.engine.confirm((await t.engine.proposeMerge(b.id)).confirm.id, true);
  await until(() => t.calls.mergeWork.length === 1);
  const busy = `${t.store.get(b.id).name} is being merged now.`;
  assert.deepEqual(await t.engine.saveFile(b.id, 'tax.js', { text: 'two\n', hash: fb.hash }), { ok: false, reply: busy, why: 'refused' });
  assert.deepEqual([(await t.engine.file(b.id, 'tax.js')).editable, (await t.engine.file(b.id, 'tax.js')).why], [false, busy]);
  assert.deepEqual(await t.engine.saveFile('you', 'cart.js', { text: 'x\n', hash: sha('x') }), { ok: false, reply: 'Workbench is merging into your folder now. Save again once it is done.', why: 'refused' });
  t.git.mergeGate.open();
  await merging;
  assert.equal(fs.readFileSync(path.join(b.v.workspace, 'tax.js'), 'utf8'), 'one\n');
  await t.engine.shutdown();
});

/**
 * Live engines over one repository folder, with the real history (under `dir`) and the real file view: what one keeps,
 * the next one started restores, as an earlier agent. Agents' folders are real, and are kept at shutdown. Each engine
 * waits `historyDebounceMs` before it writes the history by itself.
 */
function earlierWorlds(ctx) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-engine-earlier-')));
  ctx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot);
  return ({ historyDebounceMs = 5 } = {}) => {
    const store = new Store();
    const claude = fakeAdapter('claude');
    const { deps, calls } = fakeDeps({ checks: CHECKS, folders: path.join(dir, 'wt') });
    deps.history = historyMod;
    deps.files = filesMod;
    deps.workspace.removeWorkspace = async (o) => { calls.removeWorkspace.push(o); return { removed: false, kept: true }; };
    const engine = new Engine({
      store, mode: 'live', repo: { root: repoRoot, name: 'shop', head: FAKE_BASE, branch: 'main', dirty: 0 }, hook: HOOK, adapters: { claude, codex: fakeAdapter('codex') },
      machines: new FakeMachines(), deps, options: { tickMs: 10_000_000, historyDir: path.join(dir, 'history'), historyDebounceMs, exitGraceMs: 20, stopTimeoutMs: 2000 },
    });
    return { store, engine, claude, deps, calls };
  };
}

/** In a first engine of `world`, an agent done and checked, with a file in its folder; then that engine stops. */
async function checkedEarlier(world) {
  const first = world();
  await first.engine.start();
  const a = await started(first, { task: 'Fix the cart total' });
  a.runner.emit({ kind: EV.SESSION, sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I fixed the cart total.', backgroundTasks: 0, isError: false });
  await until(() => first.store.get(a.id).state === 'done_checked');
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'one\n');
  await first.engine.shutdown();
  return a;
}

test('the file view: a save into an earlier agent’s copy runs its checks again too, and the next start knows what they found', async (ctx) => {
  const world = earlierWorlds(ctx);
  const a = await checkedEarlier(world);
  const next = world();
  await next.engine.start();
  assert.deepEqual([next.store.get(a.id).earlier, next.store.get(a.id).state], [true, 'done_checked']);
  next.deps.receipt.runChecks = async (o) => {
    next.calls.runChecks.push(o);
    return { state: 'failed', results: [{ name: 'unit tests', ok: false, ms: 5, tail: 'expected 1, got 2' }] };
  };
  const f = await next.engine.file(a.id, 'cart.js');
  assert.equal(f.editable, true);
  assert.equal((await next.engine.saveFile(a.id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
  assert.equal(next.store.get(a.id).state, 'done_claimed', 'no longer said to be checked');
  await until(() => next.store.get(a.id).state === 'checks_failed');
  assert.equal(next.calls.runChecks.length, 1);
  assert.equal(next.calls.runChecks[0].cwd, a.v.workspace);
  assert.equal(next.store.get(a.id).earlier, true, 'still an agent of an earlier run');
  assert.deepEqual(next.engine.keptFolders(), [], 'and not one of this run’s');
  await next.engine.shutdown();
  const third = world();
  await third.engine.start();
  assert.deepEqual([third.store.get(a.id).state, third.store.get(a.id).stateReason], ['checks_failed', 'The check “unit tests” did not pass.']);
  await third.engine.shutdown();
});

test('the file view: an earlier agent’s copy saved, then Workbench stopped before its checks ended: the next start does not say checked', async (ctx) => {
  const world = earlierWorlds(ctx);
  const a = await checkedEarlier(world);
  const next = world();
  await next.engine.start();
  // Its checks start and hold, until they are stopped.
  next.deps.receipt.runChecks = (o) => new Promise((resolve) => {
    next.calls.runChecks.push(o);
    o.signal.addEventListener('abort', () => resolve({ state: 'failed', results: [{ name: 'unit tests', ok: false, ms: 0, tail: 'Not run.' }] }), { once: true });
  });
  const f = await next.engine.file(a.id, 'cart.js');
  assert.equal((await next.engine.saveFile(a.id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
  assert.deepEqual([next.store.get(a.id).state, next.store.get(a.id).checks], ['done_claimed', { state: 'none', results: [] }], 'its old results go with its old state');
  await until(() => next.calls.runChecks.length === 1);
  await next.engine.shutdown();
  assert.equal(next.calls.runChecks[0].signal.aborted, true, 'shutdown stopped its checks');
  const third = world();
  await third.engine.start();
  assert.equal(third.store.get(a.id).state, 'done_claimed');
  assert.notEqual(third.store.get(a.id).checks?.state, 'passed');
  await third.engine.shutdown();
});

test('the file view: a save into a checked agent’s copy is in the history before it is answered, so a Workbench stopped hard then never comes back checked', async (ctx) => {
  const world = earlierWorlds(ctx);
  const b = await checkedEarlier(world); // an earlier agent, done and checked
  // An engine that would wait a minute before it writes the history by itself: only a write made at once is there.
  const first = world({ historyDebounceMs: 60_000 });
  await first.engine.start();
  const a = await started(first, { task: 'Round the tax down' });
  a.runner.emit({ kind: EV.SESSION, sessionId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
  a.runner.emit({ kind: EV.TURN, phase: 'start' });
  a.runner.emit({ kind: EV.TURN, phase: 'end', finalText: 'I rounded the tax down.', backgroundTasks: 0, isError: false });
  await until(() => first.store.get(a.id).state === 'done_checked');
  fs.writeFileSync(path.join(a.v.workspace, 'cart.js'), 'one\n');
  const onDisk = (id) => {
    const r = JSON.parse(fs.readFileSync(first.engine.history.file, 'utf8')).agents.find(x => x.id === id);
    return [r?.state, r?.checks?.state];
  };
  first.engine.history.save();
  assert.deepEqual([onDisk(a.id), onDisk(b.id)], [['done_checked', 'passed'], ['done_checked', 'passed']], 'both said checked on disk');
  // Their checks start again and hold, until they are stopped.
  first.deps.receipt.runChecks = (o) => new Promise((resolve) => {
    first.calls.runChecks.push(o);
    o.signal.addEventListener('abort', () => resolve({ state: 'failed', results: [{ name: 'unit tests', ok: false, ms: 0, tail: 'Not run.' }] }), { once: true });
  });
  for (const id of [a.id, b.id]) {
    const f = await first.engine.file(id, 'cart.js');
    assert.equal((await first.engine.saveFile(id, 'cart.js', { text: 'two\n', hash: f.hash })).ok, true);
    assert.deepEqual(onDisk(id), ['done_claimed', 'none'], 'the file says it before the save is answered');
  }
  await until(() => first.calls.runChecks.length === 2);
  // Stopped hard: nothing more is written (no shutdown), and the next start reads the file as it is.
  const next = world();
  await next.engine.start();
  for (const id of [a.id, b.id]) {
    assert.deepEqual([next.store.get(id).earlier, next.store.get(id).state], [true, 'done_claimed']);
    assert.notEqual(next.store.get(id).checks?.state, 'passed');
  }
  await next.engine.shutdown();
  await first.engine.shutdown();
});

test('the file view in the demo: a sample project in memory, the simulated Invoice export’s copy with what it changed, and a save kept for this run, said once', async () => {
  const t = await realDemo();
  t.engine.deps.files = filesMod;
  const inv = t.byName('Invoice export');
  const you = await t.engine.files('you');
  assert.deepEqual([you.ok, you.in, you.name, you.branch], [true, 'you', 'storefront', 'main']);
  assert.deepEqual(you.files.map(f => f.path), ['.env', 'README.md', 'package.json', 'src/cart.ts', 'src/invoices/export.ts', 'src/invoices/query.ts', 'src/invoices/sample.csv']);
  assert.equal(you.files.find(f => f.path === '.env').ignored, true);
  const mark = [{ agentId: inv.id, name: 'Invoice export', state: inv.state }];
  assert.deepEqual(you.files.find(f => f.path === 'src/invoices/export.ts').changedBy, mark);
  const theirs = await t.engine.files(inv.id);
  assert.equal(theirs.branch, inv.work.branch);
  assert.deepEqual(theirs.files.find(f => f.path === 'src/invoices/batch.ts'), { path: 'src/invoices/batch.ts', changedBy: mark });
  const exp = await t.engine.file(inv.id, 'src/invoices/export.ts');
  assert.deepEqual([exp.kind, exp.editable, exp.changedLines], ['text', true, [2, 4, 6, 7, 8, 9]]);
  assert.equal((await t.engine.file(inv.id, 'src/invoices/batch.ts')).changedLines.length, 15);
  // Every file its record names (what the git screen shows of its work) opens in its copy, with the lines it changed.
  const recorded = inv.files.list.map(f => f.path);
  assert.ok(recorded.includes('migrations/0042_invoice_lookup_index.sql') && recorded.length >= 5, recorded.join(', '));
  for (const rel of recorded) {
    const f = await t.engine.file(inv.id, rel);
    assert.deepEqual([f.kind, f.changedLines?.length > 0], ['text', true], rel);
  }
  assert.equal((await t.engine.file('you', 'src/invoices/export.ts')).changedLines, undefined);
  const env = await t.engine.file('you', '.env');
  assert.deepEqual([env.kind, env.editable], ['secret', false]);
  assert.doesNotMatch(env.text, /sk_test_[0-9a-f]{24}/);
  assert.equal((await t.engine.file('you', 'src/invoices/sample.csv')).eol, 'crlf');
  assert.match((await t.engine.file('you', 'src/cart.ts')).text, /​/);
  assert.deepEqual((await t.engine.search(inv.id, 'inBatches')).results.map(r => `${r.path}:${r.line}`),
    ['src/invoices/batch.ts:6', 'src/invoices/export.ts:2', 'src/invoices/export.ts:7', 'test/invoices/large-account.test.ts:3', 'test/invoices/large-account.test.ts:12']);
  // A save is kept for this run, and said so once.
  const readme = await t.engine.file('you', 'README.md');
  const first = await t.engine.saveFile('you', 'README.md', { text: '# Storefront\n\nChanged in the demo.\n', hash: readme.hash });
  assert.deepEqual(first, { ok: true, hash: sha('# Storefront\n\nChanged in the demo.\n'), size: 35, reply: 'This is the demo, so your change is kept only until Workbench closes.' });
  assert.equal((await t.engine.file('you', 'README.md')).text, '# Storefront\n\nChanged in the demo.\n');
  const second = await t.engine.saveFile(inv.id, 'src/invoices/export.ts', { text: `// Exported in batches.\n${exp.text}`, hash: exp.hash });
  assert.deepEqual(Object.keys(second).sort(), ['hash', 'ok', 'size']);
  assert.deepEqual((await t.engine.file(inv.id, 'src/invoices/export.ts')).changedLines, [1, 3, 5, 7, 8, 9, 10]);
  assert.equal(t.store.get(inv.id).state, inv.state, 'the simulated agents’ checks are not run again');
  // Each agent has a copy of its own; the others changed nothing in the sample.
  const other = t.byName('Help pages');
  assert.equal((await t.engine.file(other.id, 'src/invoices/export.ts')).text, (await t.engine.file('you', 'src/invoices/export.ts')).text);
  assert.deepEqual(await t.engine.saveFile('you', '.env', { text: 'x\n', hash: env.hash }), { ok: false, reply: '.env holds keys, so Workbench does not edit it.', why: 'refused' });
  await t.engine.shutdown();
});

test('the file view: without the module that reads files, every request is refused in plain words', async (ctx) => {
  const t = await realGit(ctx);
  const no = { ok: false, reply: 'Workbench cannot show files right now.', why: 'refused' };
  assert.deepEqual(await t.engine.files('you'), no);
  assert.deepEqual(await t.engine.file('you', 'cart.js'), no);
  assert.deepEqual(await t.engine.search('you', 'total'), no);
  assert.deepEqual(await t.engine.saveFile('you', 'cart.js', { text: 'x\n', hash: sha('x') }), no);
  const d = demo();
  assert.deepEqual(await d.engine.files('you'), no);
  await t.engine.shutdown();
  await d.engine.shutdown();
});
