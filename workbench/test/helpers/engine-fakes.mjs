// Fakes for the engine tests: runners, adapters, the simulator, machines and the injected deps.
// They follow the contract's shapes without importing any other module.
import { EventEmitter } from 'node:events';

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
 */
export function fakeDeps({ checks = [], rules = [], allow = [], checkState = 'passed', checksGate = null, checksGates = null, intent = null } = {}) {
  const calls = { decide: [], parse: [], createWorkspace: [], diffStats: [], readRepoConfig: [], checkRules: [], runChecks: [], removeWorkspace: [], killChecksSync: 0 };
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
    async prepareRepo(p) { return { root: p, name: 'shop', head: 'abc1234', branch: 'main', dirty: 2 }; },
    async createWorkspace(o) {
      calls.createWorkspace.push(o);
      return { path: `/wt/shop/${o.slug}-${o.agentId}`, branch: `workbench/${o.slug}-${o.agentId}`, base: 'abc1234' };
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
  return { deps: { policy, commands, workspace, receipt }, calls };
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
