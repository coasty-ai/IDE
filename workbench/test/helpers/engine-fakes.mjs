// Fakes for the engine tests: runners, adapters, the simulator, machines and the injected deps.
// They follow the contract's shapes without importing any other module.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** Commit ids the fake git hands out: the merge commit M (the person's new HEAD) and the agent's work commit W. */
/** The commit agents start from, and the person's HEAD until a merge: a full commit id, as git gives it. */
export const FAKE_BASE = 'abc1234'.padEnd(40, '0');
export const FAKE_MERGE = 'aa'.repeat(20);
export const FAKE_WORK = 'bb'.repeat(20);

export class FakeRunner {
  constructor(opts) {
    this.opts = opts;
    this.sent = [];
    this.started = false;
    this.stopCalls = 0;
    this.alive = false;
  }
  async start() { this.started = true; this.alive = true; }
  async send(text) { this.sent.push(text); this.alive = true; }
  async stop() { this.stopCalls += 1; this.alive = false; }
  info() { return { pid: null, sessionId: null, alive: this.alive }; }
  /** Emit an event as this runner's adapter would. */
  emit(ev) { this.opts.emit({ agentId: this.opts.agentId, ts: Date.now(), ...ev }); }
}

export function fakeAdapter(harness, { available = { ok: true, version: '1.0.0' }, failStart = null, onStart = null } = {}) {
  const runners = [];
  return {
    harness,
    runners,
    available: async () => available,
    createRunner(opts) {
      const r = new FakeRunner(opts);
      if (failStart) r.start = async () => { throw failStart; };
      if (onStart) {
        const start = r.start.bind(r);
        r.start = async () => { onStart(r); return start(); };
      }
      runners.push(r);
      return r;
    },
  };
}

export class FakeSim {
  constructor() {
    this.runners = [];
    this.answers = [];
    this.stops = [];
    this.seeded = false;
    this.ticks = 0;
  }
  seedWorld() { this.seeded = true; }
  createRunner(opts) {
    const r = new FakeRunner(opts);
    this.runners.push(r);
    return r;
  }
  onAnswer(agentId, ask, answer) { this.answers.push({ agentId, ask, answer }); }
  stop(agentId) { this.stops.push(agentId); }
  tick() { this.ticks += 1; }
}

export class FakeMachines extends EventEmitter {
  constructor({ demo = false } = {}) {
    super();
    this.items = [{ id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true, simulated: false, cpuPct: 10, memPct: 40, costPerHourUsd: null, agents: 0, note: 'idle' }];
    if (demo) {
      this.items.push(
        { id: 'cloud-1', name: 'Cloud 1', kind: 'cloud', awake: true, simulated: true, cpuPct: 2, memPct: 10, costPerHourUsd: 0.4, agents: 0, note: 'idle' },
        { id: 'cloud-2', name: 'Cloud 2', kind: 'cloud', awake: false, simulated: true, cpuPct: null, memPct: null, costPerHourUsd: 0.4, agents: 0, note: 'asleep' },
        { id: 'cloud-3', name: 'Cloud 3', kind: 'cloud', awake: true, simulated: true, cpuPct: 30, memPct: 50, costPerHourUsd: 0.4, agents: 1, note: '1 agent' },
      );
    }
    this.refreshes = [];
  }
  list() { return this.items.map(m => ({ ...m })); }
  setAwake(id, awake) {
    const m = this.items.find(x => x.id === id);
    if (!m) throw new Error('no such machine');
    m.awake = awake;
    m.note = awake ? 'idle' : 'asleep';
  }
  refresh(counts) {
    this.refreshes.push(counts);
    for (const m of this.items) m.agents = counts[m.id] || 0;
  }
}

/** A gate a test opens later: `await gate.wait`, then `gate.open()`. */
export function gate() {
  let open;
  const wait = new Promise(r => { open = r; });
  return { wait, open };
}

/**
 * The engine's injected deps, with every call recorded.
 * checksGate holds every runChecks call until it opens; checksGates holds call i on gate i. An aborted signal ends a
 * held call at once with its checks stopped, as the real runChecks does.
 * folders: a folder to make each agent's workspace in for real (a directory with a .git file), so the engine finds it
 * there; without it workspaces are made-up paths under /wt.
 * The returned `git` is the fake repository's state, which a test may change: the person's branch, head, uncommitted
 * changes and identity; the agent's work (files, left-out files, `seq`, bumped to change its workId); and what
 * mergeWork and discardWork answer (`mergeResult`, `discardResult`: an object, or a function of the call; `mergeGate`,
 * `discardGate`: hold the call until the gate opens; `mergeError`, `discardError`: throw).
 */
export function fakeDeps({ checks = [], rules = [], allow = [], checkState = 'passed', checksGate = null, checksGates = null, intent = null, folders = null } = {}) {
  const calls = {
    decide: [], parse: [], createWorkspace: [], diffStats: [], readRepoConfig: [], checkRules: [], runChecks: [], removeWorkspace: [], killChecksSync: 0,
    prepareRepo: [], snapshotWork: [], workDiff: [], mergeWork: [], discardWork: [], gitGraph: [], gitIdentity: [],
  };
  const git = {
    branch: 'main', head: FAKE_BASE, dirty: 2,
    identity: { name: 'Test Person', email: 'test@example.com' },
    agentHead: FAKE_BASE,
    work: { changed: true, files: [{ path: 'src/cart.js', status: 'modified', adds: 3, dels: 1 }], left: [] },
    seq: 0,
    commits: [
      { id: '12'.repeat(20), parents: ['34'.repeat(20)], subject: 'Make the cart total right', author: 'Test Person', at: 1_700_000_000_000, refs: ['main'], agentId: null, kind: 'commit' },
      { id: '34'.repeat(20), parents: [], subject: 'First commit', author: 'Test Person', at: 1_699_000_000_000, refs: [], agentId: null, kind: 'commit' },
    ],
    mergeResult: null, mergeGate: null, mergeError: null,
    discardResult: null, discardGate: null, discardError: null,
  };
  const workId = () => `${git.agentHead}:tree${git.seq}`;
  const policy = {
    decide(req) {
      calls.decide.push(req);
      const { tool, input } = req;
      if (tool === 'Read' || tool === 'Grep') return { decision: 'allow', reason: 'Reading is fine.', sentence: 'wants to read a file', detail: input.file_path || '' };
      if (tool === 'Forbidden') return { decision: 'deny', reason: 'Never.', sentence: 'wants to do something forbidden', detail: '' };
      if (tool === 'Bash') return { decision: 'ask', reason: 'Needs a person.', sentence: 'wants to run a command', detail: String(input.command || '') };
      return { decision: 'ask', reason: 'Unknown tool.', sentence: `wants to use ${tool}`, detail: '' };
    },
  };
  const commands = {
    intent,
    parseCommand(text, ctx) {
      calls.parse.push({ text, ctx });
      const i = typeof commands.intent === 'function' ? commands.intent(text, ctx) : commands.intent;
      return i || { kind: 'unknown', text };
    },
  };
  const workspace = {
    async prepareRepo(p) {
      calls.prepareRepo.push(p);
      return { root: p, name: 'shop', head: git.head, branch: git.branch, dirty: git.dirty };
    },
    async createWorkspace(o) {
      calls.createWorkspace.push(o);
      let p = `/wt/shop/${o.slug}-${o.agentId}`;
      if (folders) {
        p = path.join(folders, `${o.slug}-${o.agentId}`);
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, '.git'), 'gitdir: elsewhere\n');
      }
      return { path: p, branch: `workbench/${o.slug}-${o.agentId}`, base: FAKE_BASE };
    },
    async gitIdentity(o) {
      calls.gitIdentity.push(o);
      return git.identity;
    },
    async snapshotWork(o) {
      calls.snapshotWork.push(o);
      return {
        head: git.agentHead, tree: `tree${git.seq}`, since: o.since, workId: workId(), changed: git.work.changed,
        files: git.work.files.map(f => ({ ...f })), left: git.work.left.map(l => ({ ...l })),
      };
    },
    async workDiff(o) {
      calls.workDiff.push(o);
      return {
        workId: workId(), since: o.since, head: git.agentHead,
        files: git.work.files.map(f => ({ ...f, patch: `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1 +1 @@\n-old\n+new\n` })),
        left: git.work.left.map(l => ({ ...l })), omitted: 0,
      };
    },
    async mergeWork(o) {
      calls.mergeWork.push(o);
      if (git.mergeGate) await git.mergeGate.wait;
      if (git.mergeError) throw git.mergeError;
      if (git.mergeResult) return typeof git.mergeResult === 'function' ? git.mergeResult(o) : git.mergeResult;
      git.head = FAKE_MERGE; // the person's branch moved to the merge commit
      const adds = git.work.files.reduce((s, f) => s + f.adds, 0);
      const dels = git.work.files.reduce((s, f) => s + f.dels, 0);
      return { ok: true, into: git.branch, merge: FAKE_MERGE, work: FAKE_WORK, files: git.work.files.length, adds, dels };
    },
    async discardWork(o) {
      calls.discardWork.push(o);
      if (git.discardGate) await git.discardGate.wait;
      if (git.discardError) throw git.discardError;
      if (git.discardResult) return typeof git.discardResult === 'function' ? git.discardResult(o) : git.discardResult;
      if (folders && o.path.startsWith(folders)) fs.rmSync(o.path, { recursive: true, force: true });
      return { ok: true, saved: `refs/workbench/discarded/${o.agentId}` };
    },
    async gitGraph(o) {
      calls.gitGraph.push(o);
      return { ok: true, head: git.head, branch: git.branch, commits: git.commits.map(c => ({ ...c })), more: false };
    },
    async diffStats(o) {
      calls.diffStats.push(o);
      return { changed: 1, adds: 3, dels: 1, list: [{ path: 'src/cart.js', adds: 3, dels: 1 }] };
    },
    async readRepoConfig(o) {
      calls.readRepoConfig.push(o);
      return { checks, rules, allow };
    },
    async removeWorkspace(o) {
      calls.removeWorkspace.push(o);
      return { removed: true, branch: null };
    },
  };
  const receipt = {
    checkRules(rs, paths) {
      calls.checkRules.push({ rules: rs, paths });
      return { kept: rs.map(r => ({ say: r.say })), broken: [] };
    },
    async runChecks(o) {
      const n = calls.runChecks.push(o) - 1;
      const ok = checkState === 'passed';
      for (const c of o.checks) o.onProgress?.({ name: c.name, ok, ms: 5, tail: ok ? '' : 'expected 3, got 4' });
      const g = checksGates ? checksGates[n] : checksGate;
      if (g) {
        const aborted = new Promise(r => {
          if (o.signal?.aborted) r(); else o.signal?.addEventListener('abort', r, { once: true });
        });
        if (await Promise.race([g.wait.then(() => false), aborted.then(() => true)])) {
          return { state: 'failed', results: o.checks.map(c => ({ name: c.name, ok: false, ms: 0, tail: 'Stopped because the agent was stopped.' })) };
        }
      }
      return { state: checkState, results: o.checks.map(c => ({ name: c.name, ok, ms: 5, tail: ok ? '' : 'expected 3, got 4' })) };
    },
    killChecksSync() { calls.killChecksSync += 1; },
  };
  return { deps: { policy, commands, workspace, receipt }, calls, git };
}

/** Poll until fn() is truthy. */
export async function until(fn, { timeout = 2000, every = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for a condition');
    await new Promise(r => setTimeout(r, every));
  }
}
