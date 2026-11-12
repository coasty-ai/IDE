// Fakes for the engine tests: runners, adapters, the simulator, machines and the injected deps.
// They follow the contract's shapes without importing any other module.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** The commit agents start from, and the person's HEAD until a merge: a full commit id, as git gives it. */
export const FAKE_BASE = 'abc1234'.padEnd(40, '0');
/** Commit ids the fake git hands out: the merge commit M (the person's new HEAD) and the agent's work commit W. */
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

/** A git error as the workspace module throws it: a plain sentence, with `why` when it is a refusal. */
export function gitError(sentence, why = null) {
  const e = new Error(sentence);
  e.plain = true;
  if (why) e.why = why;
  return e;
}

/**
 * A simulator with the optional git methods of the demo (section 6 of the spec), in the real simulator's shapes. Like
 * the real one, it gives each agent it runs a branch (agent.work) and sends the outcome of a merge or a throw-away as
 * the same events the engine uses (agent.work, agent.files), through the agent's emit. `outcomes` sets what merge()
 * gives an agent: 'merged' (the default), 'conflict', or an object returned as it is (a refusal, say);
 * `proposals` sets what proposeMerge() or proposeDiscard() gives instead of a card. `git` records every call.
 */
export class FakeGitSim extends FakeSim {
  constructor() {
    super();
    this.emits = new Map();
    this.git = [];
    this.outcomes = new Map();
    this.proposals = new Map();
    this.head = 'cd'.repeat(20);
  }
  createRunner(opts) {
    const r = super.createRunner(opts);
    this.emits.set(opts.agentId, opts.emit);
    const slug = String(opts.name || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    opts.emit({ kind: 'agent.work', agentId: opts.agentId, work: { branch: `workbench/${slug}-${opts.agentId}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null } });
    return r;
  }
  gitGraph(o) {
    this.git.push(['gitGraph', null, o]);
    const views = typeof o?.views === 'function' ? o.views : () => null;
    const agents = [...this.emits.keys()].map(id => views(id)).filter(v => v && v.work?.branch && !v.work.thrownAway)
      .map(v => ({ id: v.id, name: v.name, state: v.state, earlier: false, harness: v.harness, branch: v.work.branch, from: 'main', base: 'ef'.repeat(20), since: 'ef'.repeat(20), files: v.files, work: v.work }));
    return {
      ok: true, head: this.head, branch: 'main',
      repo: { name: 'storefront', branch: 'main', head: this.head, dirty: 2, identity: true },
      commits: [{ id: this.head, parents: [], subject: 'Add the cart', author: 'you', at: 1_700_000_000_000, refs: ['main'], agentId: null, kind: 'commit' }],
      more: false, agents,
    };
  }
  changes(agentId) {
    this.git.push(['changes', agentId]);
    return { ok: true, workId: `w-${agentId}`, since: 'ef'.repeat(20), head: 'ef'.repeat(20), files: [{ path: 'src/cart.js', status: 'modified', adds: 5, dels: 1, patch: 'diff --git a/src/cart.js b/src/cart.js\n' }], left: [], omitted: 0 };
  }
  proposeMerge(agentId, o) {
    this.git.push(['proposeMerge', agentId, o]);
    if (this.proposals.has(agentId)) return this.proposals.get(agentId);
    const sentence = `Merge ${o?.view?.name ?? agentId} into main?`;
    return {
      ok: true, agentId, reply: sentence,
      confirm: { kind: 'merge', sentence, detail: '2 files, +5 −1. Its work becomes a commit on its branch, joined into main by a merge commit. Nothing checked its work.', yes: 'Merge', no: 'Cancel', danger: false },
      expect: { workId: `w-${agentId}`, into: 'main', intoHead: this.head },
    };
  }
  merge(agentId, o) {
    this.git.push(['merge', agentId, o]);
    const emit = this.emits.get(agentId);
    const view = o?.view || {};
    const out = this.outcomes.get(agentId) || 'merged';
    if (out === 'conflict') {
      const sentence = `${view.name}’s work does not merge cleanly into main.`;
      emit?.({ kind: 'agent.work', agentId, work: { ...view.work, problem: { why: 'conflict', sentence, paths: ['help/index.md'], at: 1 } } });
      return { ok: false, why: 'conflict', sentence, paths: ['help/index.md'], reply: `${sentence} This is the demo: nothing was really merged.` };
    }
    if (out && typeof out === 'object') return out;
    const merged = { into: 'main', merge: 'ab'.repeat(20), at: 1, files: 2, adds: 5, dels: 1 };
    emit?.({ kind: 'agent.work', agentId, work: { ...view.work, merged, problem: null } });
    emit?.({ kind: 'agent.files', agentId, files: { changed: 0, adds: 0, dels: 0, list: [] } });
    this.head = merged.merge;
    return { ok: true, into: 'main', merge: merged.merge, work: 'ba'.repeat(20), files: 2, adds: 5, dels: 1, reply: `Merged ${view.name} into main. This is the demo: nothing was really merged.` };
  }
  proposeDiscard(agentId, o) {
    this.git.push(['proposeDiscard', agentId, o]);
    if (this.proposals.has(agentId)) return this.proposals.get(agentId);
    const view = o?.view || {};
    const sentence = `Throw away ${view.name}’s work?`;
    return {
      ok: true, agentId, reply: sentence,
      confirm: { kind: 'discard', sentence, detail: `Its folder and its branch ${view.work?.branch} are deleted, with 2 changed files. Workbench keeps a hidden copy in git.`, yes: 'Throw it away', no: 'Keep it', danger: true },
      expect: { workId: `w-${agentId}` },
    };
  }
  discard(agentId, o) {
    this.git.push(['discard', agentId, o]);
    const view = o?.view || {};
    const saved = `refs/workbench/discarded/${agentId}`;
    this.emits.get(agentId)?.({ kind: 'agent.work', agentId, work: { ...view.work, branch: null, folder: false, problem: null, thrownAway: { at: 1, saved } } });
    return { ok: true, saved, reply: `Threw away ${view.name}’s work. Its folder and branch are gone. This is the demo: nothing was really thrown away.` };
  }
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
 * `discardGate`: hold the call until the gate opens; `mergeError`, `discardError`: throw). snapshotWork and workDiff
 * throw `snapshotError` and `workDiffError` when set, as the real ones throw plain errors (with `why` for a refusal);
 * gitGraph answers `graphResult` when set.
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
    snapshotError: null, workDiffError: null, graphResult: null,
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
      if (git.snapshotError) throw git.snapshotError;
      return {
        head: git.agentHead, tree: `tree${git.seq}`, since: o.since, workId: workId(), changed: git.work.changed,
        files: git.work.files.map(f => ({ ...f })), left: git.work.left.map(l => ({ ...l })),
      };
    },
    async workDiff(o) {
      calls.workDiff.push(o);
      if (git.workDiffError) throw git.workDiffError;
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
      // As the real one checks: the person's branch and HEAD as the card showed them, then the work as it showed it.
      if (o.expect?.into !== git.branch || o.expect?.intoHead !== git.head) {
        return { ok: false, why: 'moved', sentence: `${o.expect?.into || git.branch} changed since you looked. Have another look.` };
      }
      if (o.expect?.workId !== workId()) return { ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' };
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
      if (o.expect?.workId != null && o.expect.workId !== workId()) return { ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' };
      if (folders && o.path.startsWith(folders)) fs.rmSync(o.path, { recursive: true, force: true });
      return { ok: true, saved: `refs/workbench/discarded/${o.agentId}` };
    },
    async gitGraph(o) {
      calls.gitGraph.push(o);
      if (git.graphResult) return typeof git.graphResult === 'function' ? git.graphResult(o) : git.graphResult;
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
