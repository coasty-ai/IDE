// The engine: launches agents, turns their events into state, holds risky actions for the person,
// notices agents that might be stuck, and answers the UI. Everything a person reads is plain language.
//
// Dependencies are injected so the engine can be tested with fakes:
//   adapters: { claude?, codex?, sim? }   claude/codex are runner modules, sim is a Simulator instance
//   deps:     { policy, commands, workspace, receipt }
// This file must not import those modules directly.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { EV } from '../shared/events.mjs';
import { STATE, ENDED, ACTIVE, DONE, NEEDS_YOU } from '../shared/states.mjs';
import { nameFromTask, firstSentence, extractQuestion, plain, describeRequest, quotable } from '../shared/narrate.mjs';
import { money, spentAmount, duration, clip } from '../shared/format.mjs';
import { StuckDetector } from './stuck.mjs';

const MIN = 60_000;
const DEFAULTS = Object.freeze({
  permissionTimeoutMs: 25 * MIN, // a held permission request counts as "no" after this
  stuckSilenceMs: 4 * MIN,       // stuck rule 3
  tickMs: 1000,
  simTickMs: 250,
  machinesEveryMs: 5000,
  repoEveryMs: 15_000,
  confirmTtlMs: 10 * MIN,        // how long a "Start …?" question stays answerable
  stopTimeoutMs: 8000,           // give up waiting for a runner to stop after this
  tidyTimeoutMs: 3000,           // at shutdown, give up removing unchanged agent folders after this
  helperWaitMs: 1500,            // wait this long for a helper the hook names but the parser has not shown yet
  exitGraceMs: 1000,             // after a process exits, wait this long for its last lines
  availableTimeoutMs: 15_000,
});
const DEFAULT_CONFIG = Object.freeze({ checks: [], rules: [], allow: [] });
const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex', sim: 'A simulated agent' };
// After the person stops an agent, these late events from its process are still useful.
const AFTER_STOP_OK = new Set([EV.USAGE, EV.ENDED, EV.SESSION, EV.MODEL]);
// States after which an agent cannot use the answer to a held request: they go through at once.
const FINAL = new Set([STATE.FINISHED, STATE.FAILED, STATE.STOPPED]);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
// A permission's buttons say exactly these. Typed or spoken words reach a permission only through command().
const ALLOW_LABEL_RE = /^allow$/i;
const DENY_LABEL_RE = /^deny$/i;
const LOOKS_GOOD_RE = /^(looks good|look good|lgtm|great|thanks|thank you|good|fine|ok|okay|all good)[.!]*$/i;
const HELP = 'I did not catch that. Try “start an agent to fix the login bug”, “what needs me”, or “stop everything”.';
const GONE = 'That request is no longer waiting. Ask again if you still want it.';

/** How a state reads after an agent's name: "Checkout fix needs your OK". */
const PHRASE = Object.freeze({
  starting: 'is starting',
  working: 'is working',
  waiting_helpers: 'is waiting', // _describe says what for, from its `now`
  needs_ok: 'needs your OK',
  question: 'has a question',
  maybe_stuck: 'might be stuck',
  done_checked: 'is done and checked',
  done_claimed: 'says it is done',
  checks_failed: 'is done, but a check failed',
  finished: 'finished its part',
  failed: 'failed',
  stopped: 'was stopped',
});

// ------------------------------------------------------------------ small helpers

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** An error whose message is meant for the person. */
function plainError(message) {
  const e = new Error(message);
  e.plain = true;
  return e;
}

function plainReason(err) {
  if (!err) return 'something went wrong';
  if (err.plain) return err.message;
  const m = err.message || String(err);
  return clip(m, 160) || 'something went wrong';
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function joinAnd(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

function harnessName(h) {
  return HARNESS_NAMES[h] || 'That kind of agent';
}

/** What "do it" does to a confirm card: "start it", "stop them", "send it". */
function confirmVerb(c) {
  if (c.kind === 'say') return 'send it';
  const many = (c.kind === 'stop' ? c.agentIds?.length : c.tasks?.length) > 1;
  return `${c.kind === 'stop' ? 'stop' : 'start'} ${many ? 'them' : 'it'}`;
}

function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'task';
}

function hookResponse(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(plainError('It took too long.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Why a turn ended in error, in a few plain words. */
function errorReason(e) {
  const sub = String(e.subtype || '');
  const text = String(e.finalText || '');
  if (e.reason) return clip(plain(e.reason), 160);
  if (/budget/i.test(sub) || /budget/i.test(text)) return 'It reached its spending limit.';
  if (/max_turns/i.test(sub)) return 'It reached the limit on how many steps it may take.';
  return firstSentence(text, 160) || 'It stopped because of an error.';
}

/** Check results without anything unexpected; tails stay short. */
function cleanResults(results) {
  return (Array.isArray(results) ? results : []).map(r => {
    const out = { name: String(r?.name ?? 'Check'), ok: !!r?.ok, ms: Number(r?.ms) || 0 };
    if (r?.tail) out.tail = String(r.tail).slice(-2000);
    return out;
  });
}

function makeLog(log) {
  const call = (level) => (...args) => {
    try {
      if (log && typeof log[level] === 'function') log[level](...args);
      else if (typeof log === 'function') log(level, ...args);
    } catch { /* logging never breaks the engine */ }
  };
  const f = call('info');
  f.info = call('info');
  f.warn = call('warn');
  f.error = call('error');
  f.debug = call('debug');
  return f;
}

// ------------------------------------------------------------------ the engine

export class Engine extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store.mjs').Store} o.store
   * @param {'demo'|'live'} o.mode
   * @param {object|string|null} o.repo   live mode: prepareRepo() result, or a path to prepare in start()
   * @param {{ url: string|null, tokenFor: (agentId: string) => string }} o.hook  where Claude Code's PreToolUse hook
   *        posts, and each agent's own hook token; the object is read at each launch, so the URL can be filled in
   *        after the server listens
   */
  constructor({ store, mode = 'demo', repo = null, hook = null, defaultBudgetUsd = 2, defaultModel = null, adapters = {}, machines = null, deps = {}, log = null, options = {} } = {}) {
    super();
    if (!store) throw new Error('The engine needs a store.');
    this.store = store;
    this.mode = mode === 'live' ? 'live' : 'demo';
    this.repo = repo;
    this.repoInfo = repo && typeof repo === 'object' ? repo : null;
    this.hook = hook || { url: null, tokenFor: null };
    this.defaultBudgetUsd = Number.isFinite(+defaultBudgetUsd) && +defaultBudgetUsd > 0 ? +defaultBudgetUsd : 2;
    this.defaultModel = defaultModel || null;
    this.adapters = adapters || {};
    this.machines = machines;
    this.deps = deps || {};
    this.log = makeLog(log);
    this.options = { ...DEFAULTS, ...options };
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.stuck = new StuckDetector({ silenceMs: this.options.stuckSilenceMs });

    this.runs = new Map();      // rootId -> run record for agents this engine launched
    this.held = new Map();      // askId -> a held permission request
    this.later = new Map();     // agentId -> { ask?, state? }: decisions that wait until its held requests are answered
    this._checkingHeld = false;
    this.asks = new Map();      // askId -> { agentId, type } for asks the engine created
    this.confirms = new Map();  // confirmId -> a launch, stop or message waiting for "yes"
    this.stopped = new Set();   // agents the person stopped; late events from them are filtered
    this.stopAsked = new Set(); // live helpers whose root was asked to stop them: no more tools, but their events count
    this.harnessInfo = { claude: null, codex: null, sim: null };
    this._timers = [];
    this._started = false;
    this._shuttingDown = false;
    this._shutdownPromise = null;
    this._launching = new Set(); // launches under way (_startAgent): shutdown lets them finish first
    this._machineKeys = new Map();
    this._lastMachinesAt = 0;
    this._lastRepoAt = 0;
    // Machines change on their own too (a cloud machine finishes waking up).
    this._onMachinesUpdate = () => this._syncMachines();
    if (typeof machines?.on === 'function') machines.on('update', this._onMachinesUpdate);
  }

  // ================================================================ lifecycle

  /** Demo: seed the simulator. Live: prepare the repo and check the adapters. Then tick every second. */
  async start() {
    if (this._started) return;
    if (this.mode === 'live') {
      await this._loadRepo();
      await this._checkHarnesses();
    } else {
      const ok = !!this.adapters.sim;
      this.harnessInfo = { claude: { ok, simulated: true }, codex: { ok, simulated: true }, sim: { ok } };
    }
    this._started = true;
    if (this.mode === 'demo') {
      try { await this.adapters.sim?.seedWorld?.(); } catch (err) { this.log.error('The simulator could not seed the demo:', err); }
    }
    await this._refreshMachines(); // after seeding, so the seeded agents are counted
    this._lastMachinesAt = this.now();
    this._lastRepoAt = this.now();
    const tick = setInterval(() => this.tick(), this.options.tickMs);
    tick.unref?.();
    this._timers.push(tick);
    if (this.mode === 'demo' && typeof this.adapters.sim?.tick === 'function') {
      const simTick = setInterval(() => {
        try { this.adapters.sim.tick(this.now()); } catch (err) { this.log.error('The simulator tick failed:', err); }
      }, this.options.simTickMs);
      simTick.unref?.();
      this._timers.push(simTick);
    }
  }

  /**
   * Stop every runner and every running check, and wait for them; answer every held permission request with "no";
   * remove the agent folders that hold nothing. Resolves to `{ kept }`: the folders that hold an agent's work, which
   * stay after Workbench stops ([{ id, name, path, branch }], as keptFolders() gives them).
   */
  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shuttingDown = true;
    this._shutdownPromise = (async () => {
      for (const t of this._timers) clearInterval(t);
      this._timers = [];
      try { this.machines?.off?.('update', this._onMachinesUpdate); this.machines?.dispose?.(); } catch { /* ignore */ }
      for (const id of [...this.later.keys()]) this._dropLater(id);
      for (const held of [...this.held.values()]) {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason: 'Workbench is shutting down.', silent: true });
      }
      // A launch under way (git still making its folder, a process starting) finishes first, so no agent starts unseen
      // after this: one whose folder was made too late starts nothing and gives the folder back (_launch), and one
      // already starting is stopped below with the others.
      if (this._launching.size) {
        await withTimeout(Promise.allSettled([...this._launching]), this.options.stopTimeoutMs)
          .catch(() => this.log.warn('A launch did not finish in time.'));
      }
      const runs = [...this.runs.values()].filter(r => r.runner);
      for (const r of runs) {
        r.stopped = true;
        this.stopped.add(r.id);
      }
      // Checks end alongside the agents (SIGTERM now, SIGKILL 2 s later in receipt.mjs): wait for them too.
      const checks = [];
      for (const r of this.runs.values()) {
        this._cancelReceipt(r);
        if (r.checksDone) checks.push(r.checksDone);
      }
      const checksEnded = withTimeout(Promise.all(checks), this.options.stopTimeoutMs)
        .catch(() => this.log.warn('Some checks did not end in time.'));
      const results = await Promise.allSettled(runs.map(r => withTimeout(Promise.resolve().then(() => r.runner.stop()), this.options.stopTimeoutMs)));
      results.forEach((res, i) => { if (res.status === 'rejected') this.log.warn(`Could not stop ${runs[i].id}:`, res.reason); });
      await checksEnded;
      const batch = [];
      for (const r of runs) {
        const v = this.store.get(r.id);
        if (!v || !ACTIVE.has(v.state)) continue;
        for (const d of this.store.descendants(v.id)) {
          if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Workbench was closed' });
        }
        batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason: 'Workbench was closed' });
      }
      if (batch.length) this._apply(batch);
      // Folders where nothing changed go; the others stay, so the person can look at the work afterwards.
      // A runner that would not stop may still be writing in its folder: that one stays.
      const tidy = [...this.runs.values()].filter(r => r.workspace && !r.folderRemoved && this._runnerInfo(r)?.alive !== true);
      if (tidy.length) {
        await withTimeout(Promise.all(tidy.map(r => this._removeUnchanged(r))), this.options.tidyTimeoutMs)
          .catch(() => this.log.warn('Some agent folders were not tidied up in time.'));
      }
      return { kept: this.keptFolders() };
    })();
    return this._shutdownPromise;
  }

  /**
   * The agent folders still on this computer, with their branches: [{ id, name, path, branch }]. Synchronous, so a
   * forced exit can say where they are too. After shutdown() these hold work; before it, or when the exit was forced
   * before the tidying, they may include folders where nothing changed.
   */
  keptFolders() {
    return [...this.runs.values()].filter(r => r.workspace && !r.folderRemoved).map(r => ({
      id: r.id, name: this.store.get(r.id)?.name || r.name || r.id, path: r.workspace.path, branch: r.workspace.branch ?? null,
    }));
  }

  /** Last resort on process exit: signal every live agent process group and end every check, synchronously. */
  killAllSync() {
    try { this.deps.receipt?.killChecksSync?.(); } catch { /* ignore */ }
    for (const r of this.runs.values()) {
      try { r.receipt?.ctl.abort(); } catch { /* ignore */ }
      let info = null;
      try { info = r.runner?.info?.(); } catch { info = null; }
      if (!info || !info.alive || !info.pid) continue;
      try { process.kill(-info.pid, 'SIGTERM'); } catch {
        try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
  }

  /** Called every second: sparklines, stuck checks, confirm expiry, machines, repo status. */
  tick(now = this.now()) {
    try { this.store.tick(now); } catch (err) { this.log.error('Store tick failed:', err); }
    try { this._checkStuck(now); } catch (err) { this.log.error('Stuck check failed:', err); }
    try { this._checkWaiting(now); } catch (err) { this.log.error('Background check failed:', err); }
    for (const [id, c] of this.confirms) if (now - c.createdAt > this.options.confirmTtlMs) this.confirms.delete(id);
    if (now - this._lastMachinesAt >= this.options.machinesEveryMs) {
      this._lastMachinesAt = now;
      this._refreshMachines();
    }
    if (this.mode === 'live' && now - this._lastRepoAt >= this.options.repoEveryMs) {
      this._lastRepoAt = now;
      this._refreshRepo();
    }
  }

  // ================================================================ events

  /**
   * Take one normalized event from a runner or the simulator. Applies it to the store and
   * reacts: decides a root's state at the end of its turn, finishes helpers, clears stuck agents.
   */
  ingest(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') return;
    let e = { ...ev, ts: Number.isFinite(ev.ts) ? ev.ts : this.now() };
    if (e.kind === EV.SAYS && e.text != null) e.text = plain(e.text);
    if (this._isStopped(e)) {
      if (!AFTER_STOP_OK.has(e.kind)) return;
      if (e.kind === EV.ENDED) e = { ...e, outcome: 'stopped', error: null };
    }
    this._apply([e]);
    try {
      this._react(e);
    } catch (err) {
      this.log.error('The engine could not handle an event:', err);
    }
    this.emit('event', e);
  }

  _isStopped(e) {
    if (!this.stopped.size) return false;
    if (e.kind === EV.CREATED) {
      const parent = e.parentId ? this.store.get(e.parentId) : null;
      return !!e.parentId && (this.stopped.has(e.parentId) || (parent && this.stopped.has(parent.rootId)));
    }
    if (!e.agentId) return false;
    if (this.stopped.has(e.agentId)) return true;
    const v = this.store.get(e.agentId);
    return !!v && this.stopped.has(v.rootId);
  }

  /**
   * Apply events to the store and feed them to the stuck detector. No held permission request may leave the view:
   * see _waitForHeld and _keepHeldVisible.
   * @param {{ held?: boolean }} [opts]  held: the batch shows or settles held requests itself (_hold, _resolveHeld)
   */
  _apply(events, { held = false } = {}) {
    let list = (Array.isArray(events) ? events : [events])
      .filter(Boolean)
      .map(e => (Number.isFinite(e.ts) ? e : { ...e, ts: this.now() }));
    if (!held && this.held.size) list = this._waitForHeld(list);
    if (!list.length) return;
    this.store.apply(list);
    const progressed = new Set();
    for (const e of list) {
      if (e.kind === EV.NOTICE || e.kind === EV.MACHINE) continue;
      const sig = this.stuck.observe(e);
      if (sig && sig.progress) progressed.add(sig.agentId);
    }
    for (const id of progressed) this._clearStuck(id);
    if (this.held.size) this._keepHeldVisible();
  }

  /** The held request an agent is showing, if any. */
  _heldShowing(agentId) {
    const a = agentId ? this.store.get(agentId)?.ask : null;
    const h = a ? this.held.get(a.id) : null;
    return h && h.agentId === agentId ? h : null;
  }

  /**
   * While an agent shows a held request, the engine's other decisions about it (the end of a turn: waiting on
   * helpers, a question, the receipt's done state) wait until the person has answered, so the request never leaves
   * the view. Ending states (finished, failed, stopped) go through; _keepHeldVisible then answers the requests no.
   */
  _waitForHeld(list) {
    const out = [];
    for (const e of list) {
      const waits = e.kind === EV.ASK || (e.kind === EV.STATE && !FINAL.has(e.state));
      if (waits && this._heldShowing(e.agentId)) {
        const later = this.later.get(e.agentId) || {};
        if (e.kind === EV.ASK) later.ask = e;
        else later.state = e;
        this.later.set(e.agentId, later);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  /** Forget decisions that waited for an agent's held requests: a new turn or a stop makes them out of date. */
  _dropLater(agentId) {
    const later = this.later.get(agentId);
    if (!later) return;
    this.later.delete(agentId);
    const id = later.ask?.ask?.id;
    if (id && !this.held.has(id)) this.asks.delete(id);
  }

  /**
   * The invariant, checked after every batch: each held request shows on its agent, which is in needs_ok, or waits
   * behind another held request of the same agent that shows. An agent that has gone or ended cannot use an answer,
   * so its requests are answered no. Anything else that slipped past _waitForHeld is shown again.
   */
  _keepHeldVisible() {
    if (this._checkingHeld) return;
    this._checkingHeld = true;
    try {
      const first = new Map();
      for (const h of this.held.values()) if (!h.done && !first.has(h.agentId)) first.set(h.agentId, h);
      for (const [agentId, h] of first) {
        const v = this.store.get(agentId);
        if (v && v.state === STATE.NEEDS_OK && this._heldShowing(agentId)) continue;
        if (!v || ENDED.has(v.state)) {
          this._denyHeldFor(agentId, v?.parentId ? 'The helper is no longer running.' : 'The agent is no longer running.');
          continue;
        }
        this.log.warn(`A held request of ${agentId} was not showing, so it is shown again.`);
        const later = this.later.get(agentId) || {};
        // Keep a question or a stuck ask for afterwards; a permission ask that is not held can no longer be answered.
        if (v.ask && !this.held.has(v.ask.id) && v.ask.type !== 'permission') later.ask = { kind: EV.ASK, agentId, ask: v.ask };
        later.state = { kind: EV.STATE, agentId, state: v.state, reason: v.stateReason ?? null };
        this.later.set(agentId, later);
        this._apply([
          { kind: EV.ASK, agentId, ask: h.ask },
          { kind: EV.STATE, agentId, state: STATE.NEEDS_OK, reason: null },
        ], { held: true });
      }
    } finally {
      this._checkingHeld = false;
    }
  }

  _notice(text, agentId = null) {
    if (!text) return;
    this._apply([{ kind: EV.NOTICE, text, ...(agentId ? { agentId } : {}) }]);
  }

  _react(e) {
    switch (e.kind) {
      case EV.TURN:
        if (e.phase === 'start') {
          const run = this.runs.get(e.agentId);
          if (run) {
            run.turnSeq += 1;
            run.inTurn = true;
            run.waiting = null;
            this._cancelReceipt(run); // the last turn's receipt no longer describes the folder
          }
          this._dropLater(e.agentId); // what the last turn decided while a request was held is out of date
          this._clearBackgroundAsk(e.agentId, null); // it works again, so "is it done?" is moot
        } else if (e.phase === 'end') {
          this._onTurnEnd(e);
        }
        break;
      case EV.ENDED:
        this._onEnded(e);
        break;
      case EV.BACKGROUND: {
        const run = this.runs.get(e.agentId);
        if (run) {
          run.backgroundAt = e.ts;
          run.background = { helpers: e.helpers || 0, commands: e.commands || 0, others: e.others || 0, work: Array.isArray(e.work) ? e.work : [], ids: Array.isArray(e.ids) ? e.ids : [] };
        }
        break;
      }
      default:
        break;
    }
  }

  // ================================================================ end of a turn

  _onTurnEnd(e) {
    const v = this.store.get(e.agentId);
    if (!v || v.parentId) return; // a helper's final state comes from its task completing
    const run = this.runs.get(v.id);
    if (run) {
      run.inTurn = false;
      run.lastText = String(e.finalText ?? '');
    }
    if ((run && run.stopped) || !ACTIVE.has(v.state)) return;
    const seq = run ? run.turnSeq : 0;
    this._decide(v.id, run, e, seq).catch(err => this.log.error('Could not finish a turn:', err));
  }

  /**
   * The contract's order: helpers still running, error, then what changed so far (files and rules, whether or not a
   * question follows), then the closing question, else the declared checks and a done state.
   */
  async _decide(agentId, run, e, seq) {
    const finalText = String(e.finalText ?? '');
    let receipt = null; // this turn's receipt once it starts; a new turn, a message, a stop or shutdown cancels it
    const stale = () => this._shuttingDown || !this.store.get(agentId)
      || (run && (run.stopped || run.turnSeq !== seq)) || !!receipt?.ctl.signal.aborted;
    this._dropEngineAsk(agentId);

    let background = Number(e.backgroundTasks) || 0;
    const bg = e.background && typeof e.background === 'object' ? e.background : null;
    // Commands the person already called done ("It is done") are not waited for again while they run.
    if (background > 0 && bg && !bg.helpers && run?.accepted && Array.isArray(bg.ids) && bg.ids.length
      && bg.ids.every(id => run.accepted.has(id))) background = 0;
    if (background > 0) {
      // Claude Code starts a new turn when background work ends. Work that may never end (a dev server) gets one
      // question once things have been quiet: see _checkWaiting.
      if (run) run.waiting = { e, seq, asked: false };
      const st = { kind: EV.STATE, agentId, state: STATE.WAITING_HELPERS, reason: null, backgroundTasks: background };
      if (bg) st.background = bg;
      this._apply([st]);
      return;
    }
    if (e.isError) {
      this._apply([{ kind: EV.STATE, agentId, state: STATE.FAILED, reason: errorReason(e) }]);
      return;
    }

    // One receipt at a time per agent, the record made before a question included.
    if (run) {
      this._cancelReceipt(run);
      receipt = { ctl: new AbortController() };
      run.receipt = receipt;
      run.deciding = true; // a clean exit while this runs is not a failure (Codex exits after every turn)
    }
    // The checks judge finished work: a turn that ends with a question runs none, but what it changed is recorded.
    const question = extractQuestion(finalText);
    let checksState = 'none';
    let reason = null;
    try {
      const ws = run && run.workspace;
      if (ws && typeof this.deps.workspace?.diffStats === 'function') {
        const files = await this.deps.workspace.diffStats({ path: ws.path, base: ws.base });
        if (stale()) return;
        if (files) this._apply([{ kind: EV.FILES, agentId, files }]);
        const config = (await run.config) || DEFAULT_CONFIG;
        if (stale()) return;
        const changedPaths = (files?.list || []).map(f => f.path);
        if (Array.isArray(config.rules) && config.rules.length && typeof this.deps.receipt?.checkRules === 'function') {
          const rules = await this.deps.receipt.checkRules(config.rules, changedPaths);
          if (stale()) return;
          if (rules) this._apply([{ kind: EV.RULES, agentId, rules }]);
        }
        if (!question && Array.isArray(config.checks) && config.checks.length && typeof this.deps.receipt?.runChecks === 'function') {
          const partial = [];
          // Checks of a receipt that was cancelled can take a moment to end: never run two sets in one folder.
          if (run.checksDone) await run.checksDone;
          if (stale()) return;
          this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'running', results: [] } }]);
          const onProgress = (p) => {
            if (!p || typeof p !== 'object' || stale()) return;
            if (Array.isArray(p.results)) partial.splice(0, partial.length, ...p.results);
            else if (p.name != null && typeof p.ok === 'boolean') {
              const i = partial.findIndex(r => r.name === p.name);
              if (i >= 0) partial[i] = p; else partial.push(p);
            } else return;
            this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'running', results: cleanResults(partial) } }]);
          };
          let res;
          try {
            const running = Promise.resolve().then(() => this.deps.receipt.runChecks({ cwd: ws.path, checks: config.checks, onProgress, signal: receipt.ctl.signal }));
            const done = running.then(() => {}, () => {});
            run.checksDone = done;
            done.then(() => { if (run.checksDone === done) run.checksDone = null; });
            res = await running;
          } catch (err) {
            if (stale()) return;
            this.log.warn('The checks could not run:', err);
            this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'none', results: [] } }]);
            throw plainError('Workbench could not run the checks.');
          }
          if (stale()) return;
          checksState = res?.state === 'passed' || res?.state === 'failed' ? res.state : 'none';
          const results = cleanResults(res?.results);
          this._apply([{ kind: EV.CHECKS, agentId, checks: { state: checksState, results } }]);
          if (checksState === 'failed') {
            const failed = results.filter(r => !r.ok).map(r => `“${r.name}”`);
            reason = failed.length ? `The ${failed.length === 1 ? 'check' : 'checks'} ${joinAnd(failed)} did not pass.` : null;
          }
        }
      } else if (!question) {
        // No workspace (the demo): use whatever checks the simulator reported.
        const cur = this.store.get(agentId)?.checks?.state;
        if (cur === 'passed' || cur === 'failed') checksState = cur;
      }
    } catch (err) {
      this.log.warn('Could not build the receipt:', err);
      // A question is still asked: the person can answer it without the record of what changed.
      if (!question) reason = err?.plain ? err.message : 'Workbench could not check its work.';
    } finally {
      if (run && run.receipt === receipt) { // a newer receipt keeps its own
        run.receipt = null;
        run.deciding = false;
      }
    }
    if (stale()) return;
    if (question) {
      const ask = this._newAsk(agentId, 'question', { sentence: question, options: [] });
      const batch = [];
      const intro = firstSentence(finalText);
      if (intro && intro !== question) batch.push({ kind: EV.SAYS, agentId, text: intro });
      // Results of earlier checks would sit beside newer files.
      if (this.store.get(agentId)?.checks) batch.push({ kind: EV.CHECKS, agentId, checks: null });
      batch.push({ kind: EV.ASK, agentId, ask }, { kind: EV.STATE, agentId, state: STATE.QUESTION, reason: null });
      this._apply(batch);
      return;
    }
    const state = checksState === 'passed' ? STATE.DONE_CHECKED
      : checksState === 'failed' ? STATE.CHECKS_FAILED
      : STATE.DONE_CLAIMED;
    const batch = [];
    const says = firstSentence(finalText);
    if (says) batch.push({ kind: EV.SAYS, agentId, text: says });
    batch.push({ kind: EV.STATE, agentId, state, reason });
    this._apply(batch);
  }

  /** End a receipt still being built: its checks stop, nothing from it is applied, "checks running" goes away. */
  _cancelReceipt(run) {
    const r = run && run.receipt;
    if (!r) return;
    run.receipt = null;
    run.deciding = false;
    try { r.ctl.abort(); } catch (err) { this.log.warn('Could not stop the checks:', err); }
    if (this.store.get(run.id)?.checks?.state === 'running') {
      this._apply([{ kind: EV.CHECKS, agentId: run.id, checks: { state: 'none', results: [] } }]);
    }
  }

  /** A process ended. Helpers get their final state; a root's helpers and held requests are closed. */
  _onEnded(e) {
    const v = this.store.get(e.agentId);
    if (!v) return;
    if (v.parentId) {
      if (ACTIVE.has(v.state)) {
        const state = e.outcome === 'error' ? STATE.FAILED : e.outcome === 'stopped' ? STATE.STOPPED : STATE.FINISHED;
        const reason = e.outcome === 'error' && e.error ? clip(plain(e.error), 160) : null;
        this._apply([{ kind: EV.STATE, agentId: v.id, state, reason }]);
      }
      this._denyHeldFor(v.id, 'The helper is no longer running.');
      return;
    }
    const run = this.runs.get(v.id);
    this._denyHeldFor(v.id, 'The agent is no longer running.', true);
    if (run) run.waiting = null; // whatever it left running ended with it
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent is no longer running' });
    }
    if (batch.length) this._apply(batch);
    if (!run || run.stopped || e.outcome !== 'ok') return; // on errors the runner reports 'failed' itself

    // A clean exit in the middle of a turn: wait briefly for its last lines, then call it failed.
    const seq = run.turnSeq;
    const timer = setTimeout(() => {
      const cur = this.store.get(v.id);
      if (!cur || run.stopped || run.deciding || run.turnSeq !== seq || this._shuttingDown) return;
      if (run.runner?.info?.()?.alive) return;
      // An unresolved stuck ask of any kind (background, silence, repeats): the process is gone, so it cannot be answered.
      const stuckAsk = cur.state === STATE.MAYBE_STUCK && cur.ask;
      const unfinished = cur.state === STATE.STARTING || cur.state === STATE.WAITING_HELPERS || cur.state === STATE.MAYBE_STUCK
        || (cur.state === STATE.WORKING && run.inTurn);
      if (!unfinished) return;
      run.inTurn = false;
      if (stuckAsk) this.asks.delete(stuckAsk.id);
      this._apply([{ kind: EV.STATE, agentId: v.id, state: STATE.FAILED, reason: 'It stopped before finishing its work.' }]);
    }, this.options.exitGraceMs);
    timer.unref?.();
  }

  // ================================================================ background work that may never end

  /**
   * A root that waits only for background commands (no helper working) gets one question once nothing has happened
   * for stuckSilenceMs: is it done? A dev server never ends; a build does, and then Claude Code starts a new turn by
   * itself, which takes the question back.
   */
  _checkWaiting(now) {
    for (const [id, run] of this.runs) {
      const w = run.waiting;
      if (!w || w.asked || run.stopped || run.inTurn || run.deciding || run.turnSeq !== w.seq) continue;
      const v = this.store.get(id);
      if (!v || v.state !== STATE.WAITING_HELPERS || this.stopped.has(id)) continue;
      const bg = this._backgroundOf(run);
      if (!bg || bg.helpers > 0 || (v.helpers?.working || 0) > 0) continue; // helpers have their own stuck checks
      const helperEnds = this.store.descendants(id).map(d => d.endedAt || 0);
      const quietSince = Math.max(v.lastEventAt || 0, v.stateSince || 0, run.backgroundAt || 0, ...helperEnds);
      if (now - quietSince < this.options.stuckSilenceMs) continue;
      w.asked = true;
      if (!(bg.commands + bg.others > 0)) {
        // Everything it waited for has ended, yet no new turn came: finish the turn it had.
        run.waiting = null;
        this._decide(id, run, { ...w.e, backgroundTasks: 0, background: null }, w.seq).catch(err => this.log.error('Could not finish a turn:', err));
        continue;
      }
      const ask = this._newAsk(id, 'stuck', {
        about: 'background',
        sentence: `${v.name} has finished, but ${bg.commands > 0 ? 'a command it started' : 'something it started'} is still running.`,
        ...(bg.work?.length ? { detail: bg.work.join('\n') } : {}),
        options: ['It is done', 'Keep waiting'],
      });
      this._dropEngineAsk(id);
      this._apply([
        { kind: EV.ASK, agentId: id, ask },
        { kind: EV.STATE, agentId: id, state: STATE.MAYBE_STUCK, reason: 'It left something running' },
      ]);
    }
  }

  /** The latest background split of a run: from the parser's live updates, else from the turn end. */
  _backgroundOf(run) {
    const latest = run.background || run.waiting?.e?.background;
    return latest && typeof latest === 'object' ? latest : null;
  }

  /** Take back the "is it done?" question about background work, if it shows. Returns true if it did. */
  _clearBackgroundAsk(agentId, answer, state = STATE.WORKING) {
    const v = this.store.get(agentId);
    const ask = v?.ask;
    if (!ask || ask.type !== 'stuck' || ask.about !== 'background' || !this.asks.has(ask.id)) return false;
    this.asks.delete(ask.id);
    const batch = [{ kind: EV.ASK_CLEARED, agentId, askId: ask.id, answer }];
    if (v.state === STATE.MAYBE_STUCK) {
      // Through waiting_helpers, so a root that works again says what it is reading (the store words it).
      batch.push({ kind: EV.STATE, agentId, state: STATE.WAITING_HELPERS, reason: null });
      if (state !== STATE.WAITING_HELPERS) batch.push({ kind: EV.STATE, agentId, state, reason: null });
    }
    this._apply(batch);
    return true;
  }

  // ================================================================ stuck agents

  _checkStuck(now) {
    const views = this.store.list().filter(v => v.state === STATE.WORKING
      && !this.stopped.has(v.id) && !this.stopped.has(v.rootId)
      && !this.runs.get(v.id)?.deciding);
    for (const f of this.stuck.check(now, views)) {
      const ask = this._newAsk(f.agentId, 'stuck', {
        sentence: f.sentence,
        ...(f.detail ? { detail: f.detail } : {}),
        options: ['Stop it', 'Let it keep trying'],
      });
      this._dropEngineAsk(f.agentId);
      this._apply([
        { kind: EV.ASK, agentId: f.agentId, ask },
        { kind: EV.STATE, agentId: f.agentId, state: STATE.MAYBE_STUCK, reason: f.reason },
      ]);
    }
  }

  /** A flagged agent made progress: back to working, unless the simulator owns the stuck ask. */
  _clearStuck(agentId) {
    const v = this.store.get(agentId);
    if (!v || v.state !== STATE.MAYBE_STUCK) {
      this.stuck.reset(agentId);
      return;
    }
    const ask = v.ask;
    if (ask && !this.asks.has(ask.id)) return;
    const batch = [];
    if (ask) {
      this.asks.delete(ask.id);
      batch.push({ kind: EV.ASK_CLEARED, agentId, askId: ask.id, answer: null });
    }
    batch.push({ kind: EV.STATE, agentId, state: STATE.WORKING, reason: 'It is making progress again' });
    this._apply(batch);
  }

  // ================================================================ asks

  _newAsk(agentId, type, fields) {
    const ask = { id: `${type}-${hex(4)}`, type, ...fields };
    this.asks.set(ask.id, { agentId, type });
    return ask;
  }

  /** Forget the engine's record of an agent's current ask when it is being replaced. */
  _dropEngineAsk(agentId) {
    const cur = this.store.get(agentId)?.ask;
    if (cur && this.asks.has(cur.id) && !this.held.has(cur.id)) this.asks.delete(cur.id);
  }

  // ================================================================ permission requests

  /**
   * Claude Code's PreToolUse hook, forwarded by the bridge. Allowed and denied requests are
   * answered at once; the rest wait for the person (or the timeout, or shutdown: both say no).
   * @param {{ signal?: AbortSignal }} [opts]  aborted when the bridge goes away
   */
  async hookPreToolUse(agentId, payload, { signal } = {}) {
    if (this._shuttingDown) return hookResponse('deny', 'Workbench is shutting down.');
    const root = this.store.get(String(agentId || ''));
    const run = root && !root.parentId ? this.runs.get(root.id) : null;
    // Only real Claude Code agents ask through the hook: Codex works in its own sandbox and never asks, and the
    // demo's agents are simulated. A request in any other agent's name is refused and shows nothing.
    if (!root || !run || this.mode !== 'live' || run.harness !== 'claude') return hookResponse('deny', 'Workbench does not know this agent, so it said no.');
    if (run.stopped) return hookResponse('deny', 'This agent was stopped.');
    // A hook left running after its Claude Code process has gone must not ask (or bring a failed agent back).
    if (this._runnerInfo(run)?.alive === false) return hookResponse('deny', 'This agent is no longer running.');
    const p = payload && typeof payload === 'object' ? payload : {};
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    if (!tool) return hookResponse('deny', 'The request did not say which tool it wants to use.');

    const asker = await this._findAsker(root, p);
    // A helper the person stopped gets no tools at all, not even the ones the rules allow. That includes a live helper
    // whose root was asked to stop it: it runs on until it ends.
    const stoppedHelper = () => !!asker.parentId && (this.stopped.has(asker.id) || this.stopAsked.has(asker.id));
    if (stoppedHelper()) return hookResponse('deny', 'The person stopped this helper.');
    let config = DEFAULT_CONFIG;
    try { config = (await run.config) || DEFAULT_CONFIG; } catch { config = DEFAULT_CONFIG; }
    let d;
    try {
      if (typeof this.deps.policy?.decide !== 'function') throw new Error('No permission policy is loaded.');
      d = await this.deps.policy.decide({
        tool,
        input,
        cwd: run.workspace?.path ?? null, // the engine's workspace, never the payload's cwd
        extraAllow: Array.isArray(config.allow) ? config.allow : [],
        // Claude Code's own folders for this agent's session, from its runner: never the payload's session id.
        readAlso: this._readAlso(run),
        // Who SendMessage may reach without asking: the main agent and this agent's own helpers, as its output named them.
        recipients: this._recipients(root, run),
      });
    } catch (err) {
      this.log.error('The permission policy failed:', err);
      return hookResponse('deny', 'Workbench could not check this request, so it said no.');
    }
    if (stoppedHelper()) return hookResponse('deny', 'The person stopped this helper.'); // stopped while it was checked
    const described = describeRequest(tool, input);
    const sentence = `${asker.name} ${d?.sentence || described.sentence}`;
    if (d?.decision === 'allow') {
      this._apply([{ kind: EV.APPROVAL, agentId: asker.id, how: 'auto', decision: 'allow', sentence }]);
      return hookResponse('allow', d.reason || 'Allowed by the workbench rules.');
    }
    if (d?.decision !== 'ask') { // 'deny', or anything unexpected: fail closed
      this._apply([{ kind: EV.APPROVAL, agentId: asker.id, how: 'auto', decision: 'deny', sentence }]);
      return hookResponse('deny', d?.reason || 'Not allowed by the workbench rules.');
    }
    if (this._shuttingDown || run.stopped) return hookResponse('deny', 'This agent was stopped.');
    if (signal?.aborted) return hookResponse('deny', 'The request was cancelled.');
    // A late request must not bring back a helper that has ended: asking would leave it "working" for good.
    // Checked after the waits above, since the helper can end while its request is being checked.
    const askerNow = this.store.get(asker.id);
    if (asker.parentId && (!askerNow || ENDED.has(askerNow.state))) return hookResponse('deny', 'The helper is no longer running.');
    const why = typeof d.reason === 'string' && d.reason.trim() ? clip(d.reason, 300) : null;
    return this._hold({ asker, root, sentence, detail: d.detail ?? described.detail, why, signal });
  }

  /** The runner's info(), or null when it has none or it fails. */
  _runnerInfo(run) {
    try { return run.runner?.info?.() ?? null; } catch { return null; }
  }

  /** The agent's own scratch folders, as its runner names them for its own session. */
  _readAlso(run) {
    try {
      const list = run.runner?.readAlso?.();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      this.log.warn('Could not list the agent’s own folders:', err);
      return [];
    }
  }

  /** "main", and this root's helpers: their workbench ids, and the task ids and names its output gave them. */
  _recipients(root, run) {
    const names = new Set(['main']);
    for (const h of this.store.descendants(root.id)) names.add(h.id);
    try {
      const more = run.runner?.recipients?.();
      for (const n of Array.isArray(more) ? more : []) if (typeof n === 'string' && n) names.add(n);
    } catch (err) {
      this.log.warn('Could not list the agent’s helpers:', err);
    }
    return [...names];
  }

  /**
   * The agent behind a hook call: the root, unless payload.agent_id names a helper. The runner says which agent
   * issued the call (payload.tool_use_id) or runs that task (payload.agent_id), from Claude Code's own output; a
   * runner that cannot say gets the helper id rule. The hook can arrive before the parser has shown the helper: wait
   * a moment, then ask in the root's place.
   */
  async _findAsker(root, p) {
    const taskId = p.agent_id ? String(p.agent_id) : '';
    if (!taskId) return root;
    const toolUseId = p.tool_use_id ? String(p.tool_use_id) : '';
    const runner = this.runs.get(root.id)?.runner;
    const find = () => {
      let id = null;
      try { id = runner?.agentFor?.({ toolUseId, taskId }) || null; } catch { id = null; }
      const v = (id && this.store.get(id)) || this.store.get(`${root.id}-${taskId.slice(0, 8)}`);
      return v && v.rootId === root.id ? v : null;
    };
    const deadline = Date.now() + this.options.helperWaitMs;
    for (;;) {
      const v = find();
      if (v) return v;
      if (Date.now() >= deadline) return root;
      await sleep(25);
    }
  }

  _hold({ asker, root, sentence, detail, why = null, signal }) {
    // `why` is the permission check's own reason, so the page can say why it asks.
    const ask = { id: `ok-${hex(4)}`, type: 'permission', sentence, detail: String(detail ?? ''), ...(why ? { why } : {}), options: ['Allow', 'Deny'], primary: 'Allow' };
    return new Promise((resolve) => {
      // Remember the state to go back to: a root asked on behalf of an unknown helper may be waiting on helpers.
      const cur0 = this.store.get(asker.id);
      const showing = cur0?.ask ? this.held.get(cur0.ask.id) : null;
      const prevState = showing ? showing.prevState : cur0?.state;
      const held = { askId: ask.id, agentId: asker.id, rootId: root.id, ask, resolve, timer: null, done: false, prevState };
      this.held.set(ask.id, held);
      this.asks.set(ask.id, { agentId: asker.id, type: 'permission' });
      const ms = this.options.permissionTimeoutMs;
      held.timer = setTimeout(() => this._resolveHeld(held, {
        decision: 'deny',
        how: 'timeout',
        reason: 'No answer from the person in time',
        notice: `${asker.name} waited ${duration(ms)} for your OK, so I said no.`,
      }), ms);
      signal?.addEventListener?.('abort', () => {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason: 'The request was cancelled.', silent: true });
      }, { once: true });
      // One ask shows at a time; further requests from the same agent wait their turn.
      const cur = this.store.get(asker.id)?.ask;
      if (!(cur && cur.id !== ask.id && this.held.has(cur.id))) {
        this._dropEngineAsk(asker.id);
        this._apply([
          { kind: EV.ASK, agentId: asker.id, ask },
          { kind: EV.STATE, agentId: asker.id, state: STATE.NEEDS_OK, reason: null },
        ], { held: true });
      }
    });
  }

  _resolveHeld(held, { decision, how, reason, silent = false, notice = null }) {
    if (held.done) return false;
    held.done = true;
    clearTimeout(held.timer);
    this.held.delete(held.askId);
    this.asks.delete(held.askId);
    try { held.resolve(hookResponse(decision, reason)); } catch { /* ignore */ }
    const batch = [];
    if (!silent) batch.push({ kind: EV.APPROVAL, agentId: held.agentId, how, decision, sentence: held.ask.sentence });
    const v = this.store.get(held.agentId);
    const next = [...this.held.values()].find(h => h.agentId === held.agentId && !h.done);
    if (v && v.ask && v.ask.id === held.askId) {
      batch.push({ kind: EV.ASK_CLEARED, agentId: held.agentId, askId: held.askId, answer: decision === 'allow' ? 'Allow' : 'Deny' });
      if (next) batch.push({ kind: EV.ASK, agentId: held.agentId, ask: next.ask });
      else if (v.state === STATE.NEEDS_OK) {
        // Go on to what the engine decided while the request waited, or else back to what the agent was doing.
        const later = this.later.get(held.agentId);
        this.later.delete(held.agentId);
        const ts = this.now();
        if (later?.ask) batch.push({ ...later.ask, ts });
        batch.push(later?.state ? { ...later.state, ts } : { kind: EV.STATE, agentId: held.agentId, state: this._stateAfterHeld(held), reason: null });
      }
    }
    if (!next) this._dropLater(held.agentId);
    if (notice) batch.push({ kind: EV.NOTICE, text: notice, agentId: held.agentId });
    if (batch.length) this._apply(batch, { held: true });
    return true;
  }

  /** After its last held request: working while its turn runs, else back to waiting on helpers, or working. */
  _stateAfterHeld(held) {
    if (this.runs.get(held.agentId)?.inTurn) return STATE.WORKING;
    return held.prevState === STATE.WAITING_HELPERS ? STATE.WAITING_HELPERS : STATE.WORKING;
  }

  /** Say no to every held request from an agent (and, for a root, from its helpers). */
  _denyHeldFor(agentId, reason, includeHelpers = false) {
    for (const held of [...this.held.values()]) {
      if (held.agentId === agentId || (includeHelpers && held.rootId === agentId)) {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason, silent: true });
      }
    }
  }

  // ================================================================ answers

  /**
   * Answer from a button or the reply box (POST /api/agents/:id/answer). `askId` names the ask the page showed: an
   * ask is answered only by its own id, never as "whatever is showing now". A permission takes only its buttons'
   * words, Allow or Deny; typed or spoken words reach it through command(), bound to the ask on screen. With no ask,
   * a finished agent takes "Looks good" or a follow-up, and any other agent a message.
   */
  async answer(agentId, { askId = null, answer } = {}) {
    const out = await this._answer(agentId, askId, answer);
    this._notice(out.reply, agentId);
    return out;
  }

  async _answer(agentId, askId, answer) {
    const v = this.store.get(agentId);
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    const text = answer == null ? '' : String(answer).trim();
    const named = this._askFor(v, askId);
    if (named.reply) return { ok: false, reply: named.reply };
    const ask = named.ask;
    if (!ask) {
      if (DONE.has(v.state) && !v.parentId) return this._answerDone(v, text);
      if (!text) return { ok: false, reply: `${v.name} is not waiting for an answer.` };
      return this._say(v, text);
    }
    if (ask.type === 'permission') {
      const allow = ALLOW_LABEL_RE.test(text) ? true : DENY_LABEL_RE.test(text) ? false : null;
      if (allow === null) return { ok: false, reply: 'Choose Allow or Deny.' };
      return this._answerPermission(v, ask, { allow });
    }
    return this._answerAsk(v, ask, text);
  }

  /**
   * The ask an answer names by its id: the agent's ask on screen, or one of its held permission requests (one shows
   * at a time). With no id, an agent that has an ask is not answered: "yes" must never reach an ask nobody saw.
   * @returns {{ ask?: object, reply?: string }}  no ask and no reply: the agent has no ask, and none was named
   */
  _askFor(v, askId) {
    const id = typeof askId === 'string' && askId ? askId : null;
    const held = id ? this.held.get(id) : null;
    if (held && held.agentId === v.id) return { ask: held.ask };
    if (id && v.ask && v.ask.id === id) return { ask: v.ask };
    if (!id) return v.ask ? { reply: `Have a look at what ${v.name} is asking first.` } : {};
    return { reply: v.ask ? `${v.name} is asking something else now. Have a look, then answer again.` : `${v.name} is not waiting for that any more.` };
  }

  /** A question or a stuck agent: the text is the answer, or a hint. Asks the simulator made go back to it. */
  async _answerAsk(v, ask, text) {
    if (!this.asks.has(ask.id) && this.mode === 'demo' && this.adapters.sim) return this._answerSim(v, ask, text);
    if (ask.type === 'stuck') return this._answerStuck(v, ask, text);
    if (ask.type === 'permission') return this._answerPermission(v, ask, { allow: false, words: text }); // free text never allows
    return this._answerQuestion(v, ask, text);
  }

  /**
   * Settle a permission ask with the person's decision, the same way in live mode and in the demo. An allow never
   * carries words. A no can: the person's words after "no", or the whole of a yes that came with conditions
   * (`conditional`), which is a no because an allow cannot carry the condition: the step would run exactly as asked.
   */
  async _answerPermission(v, ask, { allow, words = '', conditional = false }) {
    const said = clip(String(words ?? '').trim(), 300);
    let reason;
    let reply;
    if (allow) {
      reason = 'The person allowed it.';
      reply = `OK, ${v.name} can go ahead.`;
    } else if (said && conditional) {
      reason = `The person did not allow this step as asked. They said: “${said}”`;
      reply = `OK, ${v.name} will not do it as asked. I passed on your words.`;
    } else if (said) {
      reason = `The person said no, and added: ${said}`;
      reply = `OK, ${v.name} will not do that. I passed on your words.`;
    } else {
      reason = 'The person said no.';
      reply = `OK, ${v.name} will not do that.`;
    }
    const held = this.held.get(ask.id);
    if (held && held.agentId === v.id) {
      this._resolveHeld(held, { decision: allow ? 'allow' : 'deny', how: 'person', reason });
      return { ok: true, reply };
    }
    // Asks the simulator made itself go back to it, already decided: it hears "Allow", or the words of a no. The
    // person hears the same words as in live mode.
    if (!this.asks.has(ask.id) && this.mode === 'demo' && this.adapters.sim) {
      const res = await this._answerSim(v, ask, allow ? 'Allow' : (said || 'Deny'));
      return res.ok === false ? res : { ok: true, reply };
    }
    // Nothing is held for it any more (it timed out or was cancelled): just clear it.
    if (v.ask && v.ask.id === ask.id) {
      this.asks.delete(ask.id);
      const batch = [{ kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: allow ? 'Allow' : 'Deny' }];
      if (v.state === STATE.NEEDS_OK) batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null });
      this._apply(batch);
    }
    return { ok: false, reply: `${v.name} is no longer waiting for that.` };
  }

  async _answerQuestion(v, ask, text) {
    if (!text) return { ok: false, reply: 'Type an answer first.' };
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    this.asks.delete(ask.id);
    this._apply([
      { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
      { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
    ]);
    return { ok: true, reply: `Sent your answer to ${v.name}.` };
  }

  async _answerStuck(v, ask, text) {
    const n = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (ask.about === 'background' && n !== 'stop it' && n !== 'stop') return this._answerBackground(v, ask, text, n);
    if (n === 'stop it' || n === 'stop') {
      this.asks.delete(ask.id);
      return this._stop(v); // leaving maybe_stuck clears the ask
    }
    const clear = () => {
      this.asks.delete(ask.id);
      this._apply([
        { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
        { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
      ]);
      this.stuck.reset(v.id);
    };
    if (n === 'let it keep trying' || n === 'keep trying' || n === 'keep going') {
      clear();
      return { ok: true, reply: `OK, ${v.name} will keep trying.` };
    }
    if (!text) return { ok: false, reply: 'Choose “Stop it” or “Let it keep trying”, or type a hint.' };
    const sent = await this._sendTo(v, text); // anything else is a hint
    if (!sent.ok) return sent;
    clear();
    return { ok: true, reply: `Passed your hint to ${v.name}.` };
  }

  /**
   * The question about background work: "It is done" builds the receipt (what it left running keeps running), "Keep
   * waiting" goes back to waiting and is not asked again for that turn, and anything else is a message for the agent.
   * Once its process has ended, neither button applies: the exit makes it failed (see _onEnded).
   */
  async _answerBackground(v, ask, text, n) {
    const run = this.runs.get(v.id);
    const w = run && run.waiting;
    const done = /^(it is done|it’s done|it's done|done|it is finished|finished)$/.test(n);
    const wait = /^(keep waiting|wait|let it keep trying|keep trying|let it keep waiting)$/.test(n);
    if ((done || wait) && run && !run.inTurn && this._runnerInfo(run)?.alive === false) {
      // What it left running ended with it; the exit timer marks it failed and takes the question back.
      return { ok: false, reply: `${v.name} stopped running before your answer reached it.` };
    }
    if (done) {
      if (!w || run.inTurn || run.turnSeq !== w.seq) {
        this._clearBackgroundAsk(v.id, text);
        return { ok: true, reply: `${v.name} is working again, so I will wait for it.` };
      }
      const bg = this._backgroundOf(run);
      run.accepted = new Set([...(run.accepted || []), ...(bg && Array.isArray(bg.ids) ? bg.ids : [])]);
      run.waiting = null;
      this.asks.delete(ask.id);
      // Out of maybe_stuck at once: the receipt is built while it is working, as after any turn (run.deciding keeps the
      // stuck checks off meanwhile), and a turn that starts during its checks is working, not "might be stuck".
      this._apply([
        { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
        { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
      ]);
      this._decide(v.id, run, { ...w.e, backgroundTasks: 0, background: null }, w.seq).catch(err => this.log.error('Could not finish a turn:', err));
      return { ok: true, reply: `OK, ${v.name} is done. What it left running keeps running until you stop ${v.name} or close Workbench.` };
    }
    if (wait) {
      this._clearBackgroundAsk(v.id, text, STATE.WAITING_HELPERS);
      return { ok: true, reply: `OK, ${v.name} keeps waiting.` };
    }
    if (!text) return { ok: false, reply: 'Choose “It is done” or “Keep waiting”, or type a message for it.' };
    const sent = await this._sendTo(v, text); // anything else is a message for the agent
    if (!sent.ok) return sent;
    this._clearBackgroundAsk(v.id, text);
    return { ok: true, reply: `Passed your message to ${v.name}.` };
  }

  async _answerDone(v, text) {
    if (!text || LOOKS_GOOD_RE.test(text)) return { ok: true, reply: `Good. ${v.name} stays as it is.` };
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    return { ok: true, reply: `Sent your follow-up to ${v.name}.` };
  }

  async _answerSim(v, ask, text) {
    const sim = this.adapters.sim;
    if (typeof sim.onAnswer !== 'function') return { ok: false, reply: 'The demo cannot take that answer.' };
    let res;
    try {
      res = await sim.onAnswer(v.id, ask, text);
    } catch (err) {
      this.log.warn('The simulator could not take an answer:', err);
      return { ok: false, reply: 'The demo could not take that answer.' };
    }
    // The simulator words its own replies; otherwise use ours.
    if (res && typeof res.reply === 'string' && res.reply) return { ok: res.ok !== false, reply: res.reply };
    const n = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (ask.type === 'permission') return { ok: true, reply: ALLOW_LABEL_RE.test(text) ? `OK, ${v.name} can go ahead.` : `OK, ${v.name} will not do that.` };
    if (ask.type === 'stuck') {
      if (n === 'stop it' || n === 'stop') return { ok: true, reply: `Stopped ${v.name}.` };
      if (n === 'let it keep trying' || n === 'keep trying') return { ok: true, reply: `OK, ${v.name} will keep trying.` };
      return { ok: true, reply: `Passed your hint to ${v.name}.` };
    }
    return { ok: true, reply: `Sent your answer to ${v.name}.` };
  }

  // ================================================================ messages

  /** Send an agent a message: a hint while it works, or a follow-up once it is done. */
  async say(agentId, text) {
    const v = this.store.get(agentId);
    const out = v ? await this._say(v, String(text ?? '').trim()) : { ok: false, reply: 'I can’t find that agent.' };
    this._notice(out.reply, agentId);
    return out;
  }

  async _say(v, text) {
    if (!text) return { ok: false, reply: 'There is nothing to send.' };
    if (v.ask && v.ask.type === 'question') return this._answer(v.id, v.ask.id, text); // it is the answer
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    if (v.parentId) {
      const root = this.store.get(v.rootId);
      return { ok: true, reply: `Passed that to ${root ? root.name : 'its agent'} for its helper ${v.name}.` };
    }
    return { ok: true, reply: `Sent to ${v.name}.` };
  }

  /** Deliver text to the root that runs an agent. Helpers are reached through their root. */
  async _sendTo(v, text) {
    const root = v.parentId ? this.store.get(v.rootId) : v;
    if (!root) return { ok: false, reply: `I can’t reach ${v.name}.` };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    const message = v.parentId ? `About your helper “${v.name}”: ${text}` : text;
    const run = this.runs.get(root.id);
    if (!run || !run.runner) {
      // An agent the simulator seeded: let the simulator take the message. A message answers a question, but never
      // settles a permission or a stuck ask: as in live mode, where a held request stays held.
      const sim = this.mode === 'demo' ? this.adapters.sim : null;
      if (sim && (typeof sim.say === 'function' || typeof sim.onAnswer === 'function')) {
        try {
          const question = v.ask && v.ask.type === 'question';
          const res = question && typeof sim.onAnswer === 'function'
            ? await sim.onAnswer(v.id, v.ask, text)
            : typeof sim.say === 'function' ? await sim.say(v.id, text) : await sim.onAnswer(v.id, null, text);
          if (res && res.ok === false) return { ok: false, reply: res.reply || `${v.name} could not take that.` };
          return { ok: true };
        } catch (err) {
          this.log.warn('The simulator could not take a message:', err);
        }
      }
      return { ok: false, reply: `${root.name} is not running, so I can’t pass that on.` };
    }
    const wasStopped = run.stopped;
    run.stopped = false; // a new message brings a stopped agent back
    this.stopped.delete(root.id);
    try {
      await run.runner.send(message);
    } catch (err) {
      if (wasStopped) {
        run.stopped = true;
        this.stopped.add(root.id);
      }
      this.log.warn('Could not send a message:', err);
      // A runner's own plain sentence says it all ("Fix cart total has used its whole spending limit, so it can’t
      // continue."); anything else was a failure to reach it.
      return { ok: false, reply: err?.plain ? err.message : `I could not reach ${root.name}: ${plainReason(err)}` };
    }
    this._cancelReceipt(run); // it works on again: checks of the folder as it was would mislead
    const cur = this.store.get(root.id);
    // A turn start resumes done and failed roots by itself, but not stopped ones, and it may come much later (a
    // relaunch): do it now for all.
    if (cur && ENDED.has(cur.state)) this._apply([{ kind: EV.STATE, agentId: root.id, state: STATE.WORKING, reason: null }]);
    return { ok: true };
  }

  // ================================================================ stopping

  async stop(agentId) {
    const v = this.store.get(agentId);
    const out = v ? await this._stop(v) : { ok: false, reply: 'I can’t find that agent.' };
    this._notice(out.reply, agentId);
    return out;
  }

  async _stop(v) {
    if (v.parentId) return this._stopHelper(v);
    if (!ACTIVE.has(v.state)) {
      if (DONE.has(v.state)) {
        await this._closeIdle(v);
        return { ok: true, reply: `${v.name} had already finished.` };
      }
      return { ok: true, reply: `${v.name} is not running.` };
    }
    await this._stopRoot(v, 'Stopped by you');
    return { ok: true, reply: `Stopped ${v.name}.` };
  }

  async _stopRoot(v, reason) {
    const run = this.runs.get(v.id);
    this.stopped.add(v.id);
    if (run) run.stopped = true;
    this._cancelReceipt(run); // stopping an agent stops the checks it is running
    // What a turn decided while a request was held would otherwise show for a moment before "stopped".
    for (const a of [v, ...this.store.descendants(v.id)]) this._dropLater(a.id);
    this._denyHeldFor(v.id, 'The agent was stopped.', true);
    if (run && run.runner) {
      try {
        await withTimeout(Promise.resolve().then(() => run.runner.stop()), this.options.stopTimeoutMs);
      } catch (err) {
        this.log.warn(`Could not stop ${v.id} cleanly:`, err);
      }
    } else {
      await this._simStop(v.id); // an agent the simulator seeded
    }
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent was stopped' });
    }
    batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason });
    this._apply(batch);
    for (const a of [...this.asks.keys()]) {
      const rec = this.asks.get(a);
      const owner = rec && this.store.get(rec.agentId);
      if (owner && owner.rootId === v.id) this.asks.delete(a);
    }
    this._refreshMachines();
  }

  /** Tell the simulator to stop one of its own agents (it has stopAgent; stop is accepted too). */
  async _simStop(agentId) {
    const sim = this.mode === 'demo' ? this.adapters.sim : null;
    const fn = sim && (typeof sim.stopAgent === 'function' ? sim.stopAgent : typeof sim.stop === 'function' ? sim.stop : null);
    if (!fn) return;
    try { await fn.call(sim, agentId); } catch (err) { this.log.warn('The simulator could not stop an agent:', err); }
  }

  /** A finished root may still have an idle process waiting for a follow-up: close it quietly. */
  async _closeIdle(v) {
    const run = this.runs.get(v.id);
    if (!run || !run.runner || !run.runner.info?.()?.alive) return;
    run.stopped = true;
    this.stopped.add(v.id);
    try {
      await withTimeout(Promise.resolve().then(() => run.runner.stop()), this.options.stopTimeoutMs);
    } catch (err) {
      this.log.warn(`Could not close ${v.id}:`, err);
    }
  }

  async _stopHelper(v) {
    if (!ACTIVE.has(v.state)) return { ok: true, reply: `${v.name} is not running.` };
    const root = this.store.get(v.rootId);
    const run = root ? this.runs.get(root.id) : null;
    // A real helper lives inside its root's process: ask the root to stop it.
    if (this.mode === 'live' && run && run.runner && !run.stopped) {
      const sent = await this._sendTo(root, `Please stop your helper “${v.name}” now, because it may be stuck, and carry on without it.`);
      if (sent.ok) {
        // Its root can act on that only once the helper moves on, and a held request would keep it waiting: say no to
        // its held requests now, and to every tool it asks for from now on (it keeps running until it ends).
        this.stopAsked.add(v.id);
        this._dropLater(v.id);
        this._denyHeldFor(v.id, 'The person stopped this helper.');
        const ask = this.store.get(v.id)?.ask;
        if (ask && this.asks.has(ask.id) && !this.held.has(ask.id)) {
          this.asks.delete(ask.id);
          this._apply([{ kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: 'Stop it' }]);
        }
        return { ok: true, reply: `I asked ${root.name} to stop its helper ${v.name}.` };
      }
    }
    // Simulated (or unreachable) helpers are stopped right here.
    this.stopped.add(v.id);
    this._dropLater(v.id);
    this._denyHeldFor(v.id, 'The helper was stopped.');
    if (this.mode === 'demo') await this._simStop(v.id);
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent was stopped' });
    }
    batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason: 'Stopped by you' });
    this._apply(batch);
    return { ok: true, reply: `Stopped ${v.name}.` };
  }

  // ================================================================ launching

  /** Launch a root agent. Does not ask first: command() and the UI confirm before calling this. */
  async startAgent(opts = {}) {
    const v = await this._startAgent(opts);
    this._notice(v.state === STATE.FAILED ? `${v.name} could not start. ${v.stateReason || ''}`.trim() : `Started ${v.name}.`, v.id);
    return v;
  }

  /** A launch, tracked while it is under way so that shutdown can wait for it (see shutdown). */
  _startAgent(opts) {
    const p = this._launch(opts);
    this._launching.add(p);
    const done = () => this._launching.delete(p);
    p.then(done, done);
    return p;
  }

  async _launch({ task, harness, model, machineId, budgetUsd, name } = {}) {
    if (this._shuttingDown) throw plainError('Workbench is shutting down.');
    const text = String(task ?? '').trim();
    if (!text) throw plainError('Tell me what the agent should work on.');
    const h = harness || 'claude';
    if (!HARNESS_NAMES[h]) throw plainError('I don’t know that kind of agent. Choose Claude Code or Codex.');
    const mdl = model ? String(model).trim() : (this.defaultModel || null);
    if (mdl && !MODEL_RE.test(mdl)) throw plainError('That model name does not look right.');
    const budget = Number.isFinite(+budgetUsd) && +budgetUsd > 0 ? +budgetUsd : this.defaultBudgetUsd;
    const agentName = clip(String(name || '').replace(/^[-\s]+/, '').trim(), 40) || nameFromTask(text).replace(/^[-\s]+/, '') || 'New task';
    const id = this._newRootId();

    let factory;
    let workspace = null;
    let mach = 'laptop';
    if (this.mode === 'demo') {
      const sim = this.adapters.sim;
      if (typeof sim?.createRunner !== 'function') throw plainError('The simulator is not available.');
      factory = (o) => sim.createRunner(o);
      const known = this.store.machines();
      if (machineId && (known.some(m => m.id === machineId) || !known.length)) mach = machineId;
    } else {
      if (h === 'sim') throw plainError('Simulated agents run only in the demo.');
      const mod = this.adapters[h];
      if (typeof mod?.createRunner !== 'function' || this.harnessInfo[h]?.ok === false) {
        throw plainError(`${harnessName(h)} is not available on this computer.`);
      }
      factory = (o) => mod.createRunner(o);
      const repo = await this._loadRepo();
      if (typeof this.deps.workspace?.createWorkspace !== 'function') throw plainError('Workbench cannot make workspaces right now.');
      workspace = await this.deps.workspace.createWorkspace({ repoRoot: repo.root, agentId: id, slug: slugify(agentName) });
      if (this._shuttingDown) {
        // Workbench began to close while git made the folder: nothing starts in it, so it goes again. One that cannot
        // go is listed with the other folders that stay (keptFolders), never left unmentioned.
        const late = { id, name: agentName, workspace };
        if (!(await this._removeUnchanged(late))) this.runs.set(id, late);
        throw plainError('Workbench is shutting down.');
      }
    }

    const run = {
      id, harness: h, runner: null, workspace,
      config: this._loadConfig(workspace),
      turnSeq: 0, inTurn: false, deciding: false, stopped: false, lastText: '',
      receipt: null, checksDone: null, // the receipt being built (cancellable) and when its checks have ended
      waiting: null, background: null, backgroundAt: 0, accepted: null, // background work left running
    };
    this.runs.set(id, run);
    this._apply([
      { kind: EV.CREATED, agentId: id, parentId: null, name: agentName, task: text, harness: h, model: mdl, machineId: mach, budgetUsd: budget, workspace: workspace?.path ?? null },
      { kind: EV.STATE, agentId: id, state: STATE.STARTING, reason: null },
    ]);
    try {
      run.runner = factory({
        agentId: id,
        name: agentName,
        task: text,
        cwd: workspace?.path ?? null,
        model: mdl,
        budgetUsd: budget,
        emit: (ev) => this.ingest(ev),
        // Only a real Claude Code agent has the hook, with its own token. Codex and the simulator get none.
        hook: this.mode === 'live' && h === 'claude' ? { url: this.hook?.url ?? null, token: this._hookToken(id) } : null,
        log: this.log,
        harness: h,
        machineId: mach,
      });
      await run.runner.start();
    } catch (err) {
      this.log.error(`Agent ${id} could not start:`, err);
      const why = plainReason(err);
      this._apply([
        { kind: EV.ENDED, agentId: id, outcome: 'error', error: why },
        { kind: EV.STATE, agentId: id, state: STATE.FAILED, reason: `It could not start: ${why}` },
      ]);
      if (this._runnerInfo(run)?.alive !== true) await this._removeUnchanged(run); // nothing ran in its folder
    }
    this._refreshMachines();
    return this.store.get(id);
  }

  /**
   * Remove an agent's folder and branch when they hold nothing: never while it might hold work (see removeWorkspace's
   * onlyIfUnchanged). Used when an agent could not start, and at shutdown. Never during the session otherwise:
   * stopped, failed and done agents all take follow-ups in the same folder.
   */
  async _removeUnchanged(run) {
    const ws = run && run.workspace;
    if (!ws || run.folderRemoved || !this.repoInfo || typeof this.deps.workspace?.removeWorkspace !== 'function') return false;
    try {
      const out = await withTimeout(Promise.resolve().then(() => this.deps.workspace.removeWorkspace({
        repoRoot: this.repoInfo.root, path: ws.path, base: ws.base, onlyIfUnchanged: true, deleteBranch: true,
      })), this.options.stopTimeoutMs);
      if (out?.removed) run.folderRemoved = true;
      return !!out?.removed;
    } catch (err) {
      this.log.warn(`Could not tidy up the folder of ${run.id}:`, err);
      return false;
    }
  }

  /** This agent's own hook token, or null (Claude Code then refuses to start: fail closed). */
  _hookToken(agentId) {
    try {
      const t = typeof this.hook?.tokenFor === 'function' ? this.hook.tokenFor(agentId) : null;
      return typeof t === 'string' && t ? t : null;
    } catch {
      return null;
    }
  }

  _newRootId() {
    for (;;) {
      const id = hex(3);
      if (!this.store.get(id) && !this.runs.has(id)) return id;
    }
  }

  _loadConfig(workspace) {
    if (!workspace || typeof this.deps.workspace?.readRepoConfig !== 'function' || !this.repoInfo) {
      return Promise.resolve(DEFAULT_CONFIG);
    }
    // Read from the commit the workspace came from, never from the agent's working copy.
    return Promise.resolve()
      .then(() => this.deps.workspace.readRepoConfig({ repoRoot: this.repoInfo.root, ref: workspace.base }))
      .then(c => ({ ...DEFAULT_CONFIG, ...(c || {}) }))
      .catch((err) => {
        this.log.warn('Could not read workbench.json:', err);
        return DEFAULT_CONFIG;
      });
  }

  async _loadRepo() {
    if (this.repoInfo) return this.repoInfo;
    if (!this.repo) throw plainError('Workbench needs a git repository to run real agents. Start it with --repo and the path to one.');
    if (typeof this.deps.workspace?.prepareRepo !== 'function') throw plainError('Workbench cannot read git repositories right now.');
    this.repoInfo = await this.deps.workspace.prepareRepo(String(this.repo));
    return this.repoInfo;
  }

  _refreshRepo() {
    const root = this.repoInfo?.root;
    if (!root || typeof this.deps.workspace?.prepareRepo !== 'function') return;
    Promise.resolve()
      .then(() => this.deps.workspace.prepareRepo(root))
      .then((info) => { if (info && info.root) this.repoInfo = info; })
      .catch(err => this.log.debug('Could not refresh the repo status:', err));
  }

  async _checkHarnesses() {
    for (const h of ['claude', 'codex']) {
      const mod = this.adapters[h];
      if (!mod) {
        this.harnessInfo[h] = { ok: false, reason: `${harnessName(h)} was not found on this computer.` };
        continue;
      }
      try {
        const res = typeof mod.available === 'function' ? await withTimeout(mod.available(), this.options.availableTimeoutMs) : { ok: true };
        this.harnessInfo[h] = res && typeof res === 'object' ? res : { ok: !!res };
      } catch (err) {
        this.harnessInfo[h] = { ok: false, reason: plainReason(err) };
      }
    }
    this.harnessInfo.sim = { ok: false, reason: 'Simulated agents run only in the demo.' };
  }

  _harnessFlags() {
    if (this.mode === 'demo') {
      const ok = !!this.adapters.sim;
      return { claude: ok, codex: ok, sim: ok };
    }
    const ok = (h) => !!this.adapters[h] && this.harnessInfo[h]?.ok !== false;
    return { claude: ok('claude'), codex: ok('codex'), sim: false };
  }

  // ================================================================ commands and confirms

  /**
   * Plain-language command from the bar at the bottom (typed or spoken). Launches need a confirm, and so do stops and
   * messages whose words found the agent without naming it.
   * The page sends what it showed when the person began: `focusId`, the agent in the centre; `confirmId`, the confirm
   * card on screen; `askId`, the ask on screen. A yes or no settles only that confirm, and an answer (allow, deny,
   * free text) reaches only that ask. Commands (stop, tell, status, start, ...) act on what the words and the focus
   * name, even when the ask on screen has changed since.
   */
  async command(text, { focusId = null, confirmId = null, askId = null } = {}) {
    const t = String(text ?? '').trim();
    let out;
    if (!t) {
      out = { reply: 'Type or say what you would like to do.' };
    } else {
      const ctx = this._commandContext(focusId, confirmId);
      const shown = ctx.pendingConfirm;
      let intent = null;
      try {
        if (typeof this.deps.commands?.parseCommand === 'function') intent = await this.deps.commands.parseCommand(t, ctx);
      } catch (err) {
        this.log.warn('Could not understand a command:', err);
      }
      if (!intent || typeof intent !== 'object') intent = { kind: 'unknown', text: t };
      if (shown && intent.kind === 'unknown') {
        // A near miss ("yes start the agent") keeps the card in the centre, so saying "yes" again still answers it,
        // and not whatever would have taken its place.
        out = shown.gone
          ? { reply: GONE }
          : { reply: `I did not catch that. Say “do it” to ${confirmVerb(shown)}, or “cancel”.`, confirm: { id: shown.id, sentence: shown.sentence, detail: shown.detail } };
      } else {
        // Any other command withdraws the card on screen, without a notice: the page lets go of it.
        if (shown && !shown.gone && intent.kind !== 'confirm') this.confirms.delete(shown.id);
        try {
          // With a card on screen, no ask was: the centre shows one thing at a time.
          out = await this._runIntent(intent, { focusId, askId: shown ? null : askId, shown });
        } catch (err) {
          this.log.error('A command failed:', err);
          out = { reply: err?.plain ? err.message : 'Something went wrong while doing that. The details are in the log.' };
        }
      }
    }
    if (out.reply && !out.confirm) this._notice(out.reply, out.focusId || null);
    return out;
  }

  _commandContext(focusId, confirmId = null) {
    return {
      agents: this.store.list(),
      focusId: focusId || null,
      machines: this.store.machines(),
      harnesses: this._harnessFlags(),
      pendingConfirm: this._shownConfirm(confirmId),
    };
  }

  /**
   * The confirm the page says it shows. Never "the latest one": a card the person no longer sees must not catch a
   * "yes" or a "stop" meant for an agent. One that has run out still counts as shown, so "yes" to it hears that it
   * is no longer waiting instead of reaching something else.
   */
  _shownConfirm(confirmId) {
    const id = typeof confirmId === 'string' ? confirmId : '';
    if (!id) return null;
    const c = this.confirms.get(id);
    if (!c || this.now() - c.createdAt > this.options.confirmTtlMs) return { id, gone: true };
    return { id: c.id, kind: c.kind, sentence: c.sentence, detail: c.detail, tasks: c.tasks, agentIds: c.intent?.agentIds };
  }

  async _runIntent(intent, { focusId = null, askId = null, shown = null } = {}) {
    const get = (id) => (id ? this.store.get(id) : null);
    switch (intent.kind) {
      case 'start':
        return this._proposeStart(intent.tasks);
      case 'task':
        return this._proposeStart([{ task: intent.task, harness: intent.harness, machine: intent.machine }]);
      case 'answer':
      case 'allow':
      case 'deny': {
        const target = intent.kind === 'answer' ? { v: get(intent.agentId || focusId) } : this._permissionTarget(intent.agentId || focusId);
        const v = target.v;
        if (!v) return { reply: target.reply || 'Which agent is that for?' };
        // Words answer only the ask that was on screen when the person began: its id comes with them, and it must be
        // the ask the words were read against. Otherwise nothing is answered and the request keeps waiting.
        const named = this._askFor(v, askId);
        if (named.reply) return { reply: named.reply, focusId: v.id };
        const ask = named.ask;
        if (!ask) return { reply: `${v.name} is not waiting for an answer.`, focusId: v.id };
        if (intent.askId && intent.askId !== ask.id) return { reply: `${v.name} is asking something else now. Have a look, then answer again.`, focusId: v.id };
        let r;
        if (ask.type === 'permission') {
          // "yes" allows; "no, use the staging database" and "yes but only in the tests folder" say no with the words.
          r = intent.kind === 'allow'
            ? await this._answerPermission(v, ask, { allow: true })
            : await this._answerPermission(v, ask, { allow: false, words: intent.text, conditional: !!intent.conditional });
        } else if (intent.kind === 'answer') {
          r = await this._answerAsk(v, ask, String(intent.text ?? '').trim());
        } else {
          r = { reply: `${v.name} is not asking for your OK.` };
        }
        return { reply: r.reply, focusId: v.id };
      }
      case 'stop': {
        const views = (intent.agentIds || []).map(get).filter(Boolean);
        if (!views.length) return { reply: 'I couldn’t tell which agent to stop.' };
        // Found by its task or state words, or one loose word, not by its name: ask first ("Stop Flaky test?").
        if (intent.sure === false) return this._proposeIntent({ kind: 'stop', agentIds: views.map(v => v.id) });
        const replies = [];
        for (const v of views) replies.push((await this._stop(v)).reply);
        return { reply: replies.join(' '), ...(views.length === 1 ? { focusId: views[0].id } : {}) };
      }
      case 'stop_all': {
        const active = this.store.list().filter(v => !v.parentId && ACTIVE.has(v.state));
        if (!active.length) return { reply: 'Nothing is running.' };
        await Promise.all(active.map(v => this._stopRoot(v, 'Stopped by you')));
        return { reply: active.length === 1 ? `Stopped ${active[0].name}.` : `Stopped all ${active.length} agents.` };
      }
      case 'say': {
        const v = get(intent.agentId || focusId);
        if (!v) return { reply: 'Which agent should I tell?' };
        const words = String(intent.text ?? '').trim();
        // Found without its name, or with no clear break before the message: ask first ("Tell Flaky test “…”?").
        if (intent.sure === false) return this._proposeIntent({ kind: 'say', agentId: v.id, text: words });
        const r = await this._say(v, words);
        return { reply: r.reply, focusId: v.id };
      }
      case 'status':
        return this._status(intent.agentId || null);
      case 'spend':
        return { reply: this._spendSentence() };
      case 'sleep':
      case 'wake': {
        const ids = intent.machineIds || [];
        if (!ids.length) return { reply: 'Which machine?' };
        const replies = [];
        for (const id of ids) replies.push((await this._setMachineAwake(id, intent.kind === 'wake')).reply);
        return { reply: replies.join(' ') };
      }
      case 'sleep_idle':
        return this._sleepIdle();
      case 'confirm': {
        // Only the card on screen: never "the latest one".
        if (!shown) return { reply: 'There is nothing waiting for a yes or no.' };
        const r = await this._confirm(shown.id, !!intent.go);
        // A typed or spoken yes that started agents puts the first one in the centre, so a second "yes" said out of
        // habit finds nothing to answer, rather than whatever asks next.
        return r.agentIds?.length && !r.focusId ? { ...r, focusId: r.agentIds[0] } : r;
      }
      default:
        return { reply: HELP };
    }
  }

  _permissionTarget(id) {
    const v = id ? this.store.get(id) : null;
    if (v && v.ask && v.ask.type === 'permission') return { v };
    const waiting = this.store.list().filter(a => a.ask && a.ask.type === 'permission');
    if (waiting.length === 1) return { v: waiting[0] };
    if (!waiting.length) return { v: null, reply: 'Nothing is waiting for your OK right now.' };
    return { v: null, reply: `Which one? ${joinAnd(waiting.map(a => a.name))} are waiting for your OK.` };
  }

  _canRun(h) {
    if (this.mode === 'demo') return !!this.adapters.sim;
    return h !== 'sim' && !!this.adapters[h] && this.harnessInfo[h]?.ok !== false;
  }

  _proposeStart(tasks) {
    const list = (Array.isArray(tasks) ? tasks : [])
      .map(t => ({ task: String(t?.task ?? '').trim(), harness: HARNESS_NAMES[t?.harness] ? t.harness : 'claude', machine: t?.machine || null }))
      .filter(t => t.task)
      .slice(0, 8);
    if (!list.length) return { reply: 'What should the agent work on?' };
    for (const t of list) {
      if (!this._canRun(t.harness)) return { reply: `${harnessName(t.harness)} is not available on this computer.` };
    }
    const detail = this._startDetail(list);
    // Live mode has no cloud machines: launches go to the laptop, and the question should not say otherwise.
    if (this.mode !== 'demo') for (const t of list) t.machine = null;
    let sentence = null;
    if (typeof this.deps.commands?.describeIntent === 'function') {
      try {
        const s = this.deps.commands.describeIntent({ kind: 'start', tasks: list }, this._commandContext(null));
        if (typeof s === 'string' && s.trim()) sentence = s.trim();
      } catch (err) {
        this.log.debug('describeIntent failed:', err);
      }
    }
    if (!sentence) {
      const label = (t) => (this.mode === 'demo' ? `a simulated ${harnessName(t.harness)}` : harnessName(t.harness));
      sentence = list.length === 1
        ? `Start ${label(list[0])} on “${clip(list[0].task, 90)}”?`
        : `Start ${list.length} agents: ${joinAnd(list.map(t => `${label(t)} on “${clip(t.task, 50)}”`))}?`;
    }
    const id = hex(6);
    this.confirms.set(id, { id, kind: 'start', tasks: list, sentence, detail, createdAt: this.now() });
    return { reply: sentence, confirm: { id, sentence, detail } };
  }

  _startDetail(list) {
    const many = list.length > 1;
    const cloud = list.some(t => t.machine && t.machine !== 'laptop');
    if (this.mode === 'demo') {
      const where = cloud ? (many ? 'Each one gets its own cloud machine.' : 'It runs on a cloud machine.') : (many ? 'They run on your laptop.' : 'It runs on your laptop.');
      return `This is the demo: the agents are simulated and nothing is spent. ${where}`;
    }
    const parts = [`${many ? 'Each one' : 'It'} can spend up to ${money(this.defaultBudgetUsd)}.`];
    const repo = this.repoInfo;
    if (repo) {
      parts.push(`${many ? 'Each works' : 'It works'} in its own copy of ${repo.name || 'the repository'}, made from the last commit.`);
      const dirty = Number(repo.dirty) || 0;
      if (dirty > 0) parts.push(`Your ${dirty} uncommitted change${dirty === 1 ? ' is' : 's are'} not included.`);
    }
    if (cloud) parts.push('Cloud machines exist only in the demo, so it runs on your laptop.');
    return parts.join(' ');
  }

  /**
   * A stop or a message whose words found the agent without naming it ("stop the stuck one"): ask first, with the
   * same kind of confirm card as a launch.
   */
  _proposeIntent(intent) {
    let sentence = null;
    try {
      const s = this.deps.commands?.describeIntent?.(intent, this._commandContext(null));
      if (typeof s === 'string' && s.trim()) sentence = s.trim();
    } catch (err) {
      this.log.debug('describeIntent failed:', err);
    }
    const views = (intent.kind === 'stop' ? intent.agentIds : [intent.agentId]).map(id => this.store.get(id)).filter(Boolean);
    if (!sentence) {
      const names = joinAnd(views.map(v => v.name)) || 'that agent';
      sentence = intent.kind === 'stop' ? `Stop ${names}?` : `Tell ${names} “${clip(intent.text, 80)}”?`;
    }
    // Which one, in the person's own words: two agents can have the same name.
    const detail = views.length === 1 && views[0].task ? `Its task: “${clip(views[0].task, 90)}”` : null;
    const id = hex(6);
    this.confirms.set(id, { id, kind: intent.kind, intent, sentence, detail, createdAt: this.now() });
    return { reply: sentence, confirm: { id, sentence, detail } };
  }

  /** Execute (go = true) or cancel a launch, stop or message proposed by command(). */
  async confirm(confirmId, go) {
    const out = await this._confirm(confirmId, go);
    this._notice(out.reply, out.focusId || null);
    return out;
  }

  async _confirm(confirmId, go) {
    const c = this.confirms.get(String(confirmId ?? ''));
    if (!c || this.now() - c.createdAt > this.options.confirmTtlMs) {
      if (c) this.confirms.delete(c.id);
      return { reply: GONE };
    }
    this.confirms.delete(c.id);
    if (c.kind === 'stop' || c.kind === 'say') {
      if (!go) {
        if (c.kind === 'say') return { reply: 'OK, I won’t send it.' };
        return { reply: c.intent.agentIds.length === 1 ? 'OK, I won’t stop it.' : 'OK, I won’t stop them.' };
      }
      return this._runIntent({ ...c.intent, sure: true });
    }
    if (!go) return { reply: c.tasks.length === 1 ? 'OK, I won’t start it.' : 'OK, I won’t start them.' };
    const used = new Set();
    const started = [];
    const problems = [];
    for (const t of c.tasks) {
      try {
        const machineId = await this._pickMachine(t.machine, used);
        used.add(machineId);
        const v = await this._startAgent({ task: t.task, harness: t.harness, machineId });
        if (v.state === STATE.FAILED) problems.push(`${v.name} could not start. ${v.stateReason || ''}`.trim());
        else started.push(v);
      } catch (err) {
        problems.push(`I could not start the agent for “${clip(t.task, 50)}”: ${plainReason(err)}`);
      }
    }
    const parts = [];
    if (started.length) parts.push(`Started ${joinAnd(started.map(v => v.name))}.`);
    parts.push(...problems);
    return { reply: parts.join(' '), agentIds: started.map(v => v.id) };
  }

  /** Demo only: 'cloud' picks a free cloud machine (waking one if needed); live is always the laptop. */
  async _pickMachine(machine, used) {
    if (this.mode !== 'demo' || !machine || machine === 'laptop') return 'laptop';
    const all = this.store.machines();
    const direct = all.find(m => m.id === machine);
    const pool = direct ? [direct] : all.filter(m => m.kind === 'cloud');
    if (!pool.length) return 'laptop';
    const counts = this._agentCountsByMachine();
    const free = pool.filter(m => !used.has(m.id));
    const pick = free.find(m => m.awake && !counts[m.id]) || free.find(m => m.awake) || free.find(m => !m.awake) || pool[0];
    if (!pick.awake && typeof this.machines?.setAwake === 'function') {
      try {
        await this.machines.setAwake(pick.id, true);
        this._syncMachines();
      } catch (err) {
        this.log.warn('Could not wake a machine:', err);
      }
    }
    return pick.id;
  }

  // ================================================================ status words

  _status(agentId) {
    if (agentId) {
      const v = this.store.get(agentId);
      if (!v) return { reply: 'I can’t find that agent.' };
      return { reply: this._describe(v), focusId: v.id };
    }
    const all = this.store.list();
    if (!all.length) return { reply: 'No agents yet. Say “start an agent to …” to begin.' };
    const needs = all.filter(v => NEEDS_YOU.has(v.state));
    const working = all.filter(v => !v.parentId && (v.state === STATE.WORKING || v.state === STATE.STARTING || v.state === STATE.WAITING_HELPERS));
    const parts = [];
    if (needs.length) {
      const what = needs.slice(0, 4).map(v => `${v.name} ${v.ask?.about === 'background' ? 'left a command running' : PHRASE[v.state]}`);
      if (needs.length > 4) what.push(`${needs.length - 4} more`);
      parts.push(`${needs.length === 1 ? 'One thing needs' : `${needs.length} things need`} you: ${joinAnd(what)}.`);
    } else {
      parts.push('Nothing needs you right now.');
    }
    if (working.length) parts.push(working.length === 1 ? 'One agent is working.' : `${working.length} agents are working.`);
    return { reply: parts.join(' '), ...(needs[0] ? { focusId: needs[0].id } : {}) };
  }

  _describe(v) {
    const ask = v.ask;
    if (ask && v.state === STATE.NEEDS_OK) {
      // The exact command, path or address, so a spoken "what is it doing" says what an OK would let through.
      const exact = quotable(ask.detail);
      return `${ask.sentence}${exact ? `: “${exact}”` : ''}. It needs your OK.`;
    }
    if (ask && v.state === STATE.QUESTION) return `${v.name} has a question: ${ask.sentence}`;
    if (ask && v.state === STATE.MAYBE_STUCK && ask.about === 'background') return `${ask.sentence} Is it done, or should it keep waiting?`;
    if (ask && v.state === STATE.MAYBE_STUCK) return `${ask.sentence} Stop it, or let it keep trying?`;
    let s;
    if (v.state === STATE.WORKING && v.now) s = `${v.name} is working: ${lowerFirst(v.now)}.`;
    else if (v.state === STATE.WAITING_HELPERS && v.now) {
      // "… is waiting for a background command."; "… is waiting: its background work is done."
      s = /^Waiting /.test(v.now) ? `${v.name} is ${lowerFirst(v.now)}.` : `${v.name} is waiting: ${lowerFirst(v.now)}.`;
    }
    else s = `${v.name} ${PHRASE[v.state] || 'is working'}.`;
    if (v.stateReason && (v.state === STATE.FAILED || v.state === STATE.CHECKS_FAILED)) s += ` ${v.stateReason}`;
    if (v.says && ENDED.has(v.state)) s += ` It says: ${v.says}`;
    const n = v.helpers?.working || 0;
    if (n && ACTIVE.has(v.state)) s += ` ${n === 1 ? 'One helper is' : `${n} helpers are`} working.`;
    return s;
  }

  _spendSentence() {
    const spend = this.store.spendTodayUsd(this.now());
    // Claude Code reports cost only when a turn ends: until then part of it is Workbench's estimate ("about").
    const estimated = !!this.store.spendTodayEstimated?.(this.now());
    let s = this.mode === 'demo'
      ? `The demo agents have spent ${spentAmount(spend)} today. It is simulated, so nothing was really spent.`
      : `You have spent ${spentAmount(spend, estimated)} today.`;
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    const codex = this.store.list().some(v => !v.parentId && v.harness === 'codex' && v.startedAt >= d.getTime());
    if (codex) s += ' Codex does not report its cost, so its work is not counted.';
    return s;
  }

  // ================================================================ machines

  async setMachineAwake(machineId, awake) {
    const out = await this._setMachineAwake(machineId, awake === true);
    this._notice(out.reply);
    return out;
  }

  _findMachine(machineId) {
    const key = String(machineId ?? '').trim().toLowerCase();
    if (!key) return null;
    try {
      const m = this.machines?.get?.(machineId); // the machines module also takes loose names ("Cloud 2")
      if (m) return m;
    } catch { /* fall back to the list */ }
    const list = this.store.machines().length ? this.store.machines() : (this.machines?.list?.() || []);
    return list.find(x => x.id === machineId) || list.find(x => String(x.name || '').toLowerCase() === key) || null;
  }

  async _setMachineAwake(machineId, awake) {
    if (typeof this.machines?.setAwake !== 'function') return { ok: false, reply: 'Machines can’t be changed right now.' };
    const m = this._findMachine(machineId);
    if (m && m.kind === 'laptop') {
      return awake ? { ok: true, reply: 'Your laptop is already awake.' } : { ok: false, reply: 'Your laptop runs Workbench itself, so it stays awake.' };
    }
    let res;
    try {
      res = await this.machines.setAwake(m ? m.id : String(machineId ?? ''), awake);
    } catch (err) {
      return m ? { ok: false, reply: `I could not change ${m.name}: ${plainReason(err)}` } : { ok: false, reply: 'I can’t find that machine.' };
    }
    this._syncMachines();
    // The machines module words its own replies ("Cloud 2 is waking up. It takes about 8 seconds.").
    if (res && typeof res.reply === 'string' && res.reply) return { ok: res.ok !== false, reply: res.reply };
    if (!m) return { ok: false, reply: 'I can’t find that machine.' };
    if (!!m.awake === awake) return { ok: true, reply: `${m.name} is already ${awake ? 'awake' : 'asleep'}.` };
    return { ok: true, reply: awake ? `${m.name} is awake.` : `${m.name} is asleep now.` };
  }

  async _sleepIdle() {
    if (typeof this.machines?.sleepIdle === 'function') {
      await this._refreshMachines(); // so "idle" uses today's agent counts
      let res;
      try { res = await this.machines.sleepIdle(); } catch (err) { return { reply: `I could not put the idle machines to sleep: ${plainReason(err)}` }; }
      this._syncMachines();
      if (res && typeof res.reply === 'string' && res.reply) return { reply: res.reply };
    }
    const counts = this._agentCountsByMachine();
    const idle = this.store.machines().filter(m => m.kind === 'cloud' && m.awake && !counts[m.id]);
    if (!idle.length) return { reply: 'No machine is idle right now.' };
    const done = [];
    for (const m of idle) {
      const r = await this._setMachineAwake(m.id, false);
      if (r.ok) done.push(m.name);
    }
    return { reply: done.length ? `Put ${joinAnd(done)} to sleep.` : 'I could not put the idle machines to sleep.' };
  }

  /** Root agents still active on each machine. */
  _agentCountsByMachine() {
    const counts = {};
    for (const v of this.store.list()) {
      if (v.parentId || !ACTIVE.has(v.state)) continue;
      counts[v.machineId] = (counts[v.machineId] || 0) + 1;
    }
    return counts;
  }

  async _refreshMachines() {
    if (!this.machines) return;
    try {
      if (typeof this.machines.refresh === 'function') await this.machines.refresh(this._agentCountsByMachine());
    } catch (err) {
      this.log.warn('Could not refresh the machines:', err);
    }
    this._syncMachines();
  }

  /** Send machine.update for every machine that changed since last time. */
  _syncMachines() {
    let list = [];
    try { list = this.machines?.list?.() || []; } catch (err) { this.log.warn('Could not list the machines:', err); }
    const batch = [];
    for (const m of list) {
      if (!m || m.id == null) continue;
      const key = JSON.stringify(m);
      if (this._machineKeys.get(m.id) === key) continue;
      this._machineKeys.set(m.id, key);
      batch.push({ kind: EV.MACHINE, machine: { ...m } });
    }
    if (batch.length) this._apply(batch);
  }

  // ================================================================ snapshot

  snapshot() {
    const s = this.store.snapshot(this.now());
    const r = this.repoInfo;
    return {
      mode: this.mode,
      repo: r ? { name: r.name ?? null, head: r.head ?? null, branch: r.branch ?? null, dirty: r.dirty ?? 0 } : null,
      harnesses: this._harnessFlags(),
      harnessInfo: { ...this.harnessInfo },
      agents: s.agents,
      machines: s.machines,
      spendTodayUsd: s.spendTodayUsd,
      spendTodayEstimated: !!s.spendTodayEstimated, // part of it is Workbench's estimate: say "about"
      defaultBudgetUsd: this.defaultBudgetUsd,
    };
  }
}
