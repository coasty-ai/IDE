// The store: reduces normalized events (src/shared/events.mjs) into AgentViews and Machines.
// It holds state and reports changes; it never talks to agents itself.
//
// Emits:
//   'agents'   (ids: string[])     views that changed, deduped per apply() or tick()
//   'machines' (machines: Machine[]) machines that changed in one apply()
//   'notice'   ({ text })          a short reply from the workbench to the person
//   'removed'  (ids: string[])     roots taken out of the store (an earlier agent the person forgot)
//   'repo'     (repo)              the person's repository changed: { name, head, branch, dirty, identity } (repoChanged)
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { EV, newAgentView, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../shared/events.mjs';
import { STATE, ENDED, ACTIVE, PRIORITY, DONE } from '../shared/states.mjs';
import { waitingFor } from '../shared/narrate.mjs';

const RECENT_MAX = 8;
const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** States that carry an ask, and the ask type that belongs to each. */
const ASK_TYPE_OF_STATE = Object.freeze({
  [STATE.NEEDS_OK]: 'permission',
  [STATE.QUESTION]: 'question',
  [STATE.MAYBE_STUCK]: 'stuck',
});

/**
 * A root in one of these states goes back to working when a new turn starts: a new turn means it works again. That
 * includes `failed`: a message that waited while the failed turn ran starts the next one. `stopped` comes back only
 * through the person's own message, and `needs_ok` and `maybe_stuck` keep their ask.
 */
const RESUMES_ON_TURN = new Set([
  STATE.QUESTION, STATE.DONE_CHECKED, STATE.DONE_CLAIMED, STATE.CHECKS_FAILED, STATE.WAITING_HELPERS, STATE.FAILED,
]);

/** What a root is doing right after it leaves a resting state. */
const RESUME_NOW = Object.freeze({
  [STATE.QUESTION]: 'Reading your answer',
  [STATE.WAITING_HELPERS]: 'Reading what its helpers found',
  [STATE.DONE_CHECKED]: 'Working on your follow-up',
  [STATE.DONE_CLAIMED]: 'Working on your follow-up',
  [STATE.CHECKS_FAILED]: 'Working on your follow-up',
  [STATE.FAILED]: 'Working on your message',
});

/** The counts of an agent.background split (or of a turn end's `background`). */
function splitOf(b) {
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  return { helpers: n(b.helpers), commands: n(b.commands), others: n(b.others) };
}

function copy(value) {
  if (value == null || typeof value !== 'object') return value ?? null;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * An agent.work payload as AgentView.work keeps it: its known fields only, copied. agent.work replaces the whole of it,
 * so a payload that leaves a field out has none: { branch, from, folder, merged, problem, thrownAway }.
 */
function workOf(w) {
  if (!w || typeof w !== 'object') return null;
  const part = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? copy(x) : null);
  return {
    branch: typeof w.branch === 'string' && w.branch ? w.branch : null,
    from: typeof w.from === 'string' && w.from ? w.from : null,
    folder: w.folder === true,
    merged: part(w.merged),
    problem: part(w.problem),
    thrownAway: part(w.thrownAway),
  };
}

/** End of the 30 s grid bucket that contains ts, so every agent's sparkline lines up. */
function bucketEnd(ts) {
  return (Math.floor(ts / SPARK_BUCKET_MS) + 1) * SPARK_BUCKET_MS;
}

export class Store extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.logPath]  append every applied event to this JSONL file
   * @param {Function|object|null} [opts.log]  optional logger for warnings
   */
  constructor({ logPath = null, log = null } = {}) {
    super();
    this._views = new Map();     // id -> AgentView, in creation order
    this._meta = new Map();      // id -> { seq, openTools: Map<toolUseId, sentence>, backgroundTasks, background, waitedForHelpers }
    this._children = new Map();  // parentId -> child ids, in creation order
    this._machines = new Map();  // id -> Machine
    this._seq = 0;
    this._log = log;
    this._logStream = null;
    if (logPath) this._openLog(logPath);
  }

  // ---------------------------------------------------------------- reading

  get(id) {
    return this._views.get(id) || null;
  }

  /** Direct helpers of an agent, in creation order. */
  children(id) {
    const ids = this._children.get(id) || [];
    return ids.map(c => this._views.get(c)).filter(Boolean);
  }

  /** Every helper below an agent, depth first, in creation order. */
  descendants(id) {
    const out = [];
    const seen = new Set([id]);
    const visit = (pid) => {
      for (const c of this.children(pid)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        visit(c.id);
      }
    };
    visit(id);
    return out;
  }

  /**
   * Roots by PRIORITY[state], then newest first; each root is followed by its helpers
   * (depth first, each level in creation order, so the tree can be drawn from the list).
   */
  list() {
    const roots = [];
    for (const v of this._views.values()) {
      // A helper whose parent is unknown is listed on its own rather than lost.
      if (!v.parentId || !this._views.has(v.parentId)) roots.push(v);
    }
    const prio = (v) => PRIORITY[v.state] ?? 99;
    const seq = (v) => this._meta.get(v.id)?.seq ?? 0;
    roots.sort((a, b) => (prio(a) - prio(b)) || (b.startedAt - a.startedAt) || (seq(b) - seq(a)));
    const out = [];
    const seen = new Set();
    const visit = (v) => {
      if (seen.has(v.id)) return;
      seen.add(v.id);
      out.push(v);
      for (const c of this.children(v.id)) visit(c);
    };
    for (const r of roots) visit(r);
    return out;
  }

  machines() {
    return [...this._machines.values()];
  }

  /** Sum of root costs, reported and estimated (not reported yet), for roots started since local midnight. */
  spendTodayUsd(now = Date.now()) {
    return this._spendToday(now).usd;
  }

  /** Is part of today's spend Workbench's own estimate of cost not reported yet? */
  spendTodayEstimated(now = Date.now()) {
    return this._spendToday(now).estimated;
  }

  _spendToday(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const midnight = d.getTime();
    let sum = 0;
    let estimated = false;
    for (const v of this._views.values()) {
      if (v.parentId || v.startedAt < midnight) continue;
      const c = v.usage.costUsd;
      if (typeof c === 'number' && Number.isFinite(c)) sum += c;
      if (v.usage.unreportedUsd > 0) { sum += v.usage.unreportedUsd; estimated = true; }
    }
    return { usd: Math.round(sum * 1e6) / 1e6, estimated };
  }

  /** The store's part of the engine snapshot. */
  snapshot(now = Date.now()) {
    const spend = this._spendToday(now);
    return { agents: this.list(), machines: this.machines(), spendTodayUsd: spend.usd, spendTodayEstimated: spend.estimated };
  }

  // ---------------------------------------------------------------- writing

  /**
   * Apply one event or a batch of events. A batch matters for one rule: leaving an ask state
   * keeps the ask when an agent.ask for the same agent follows in the same batch.
   */
  apply(input) {
    const list = Array.isArray(input) ? input : [input];
    const changed = new Set();
    const machines = new Map();
    const batch = list.map(ev => (ev && typeof ev === 'object' && typeof ev.kind === 'string')
      ? { ...ev, ts: Number.isFinite(ev.ts) ? ev.ts : Date.now() }
      : null);
    for (let i = 0; i < batch.length; i++) {
      const ev = batch[i];
      if (!ev) continue;
      this._writeLog(ev);
      try {
        this._reduce(ev, batch, i, changed, machines);
      } catch (err) {
        this._warn('The store could not apply an event', err, ev);
      }
    }
    if (changed.size) this.emit('agents', [...changed]);
    if (machines.size) this.emit('machines', [...machines.values()]);
  }

  /** Roll every sparkline forward to `now`. Reports only views whose spark values moved. */
  tick(now = Date.now()) {
    const changed = [];
    for (const v of this._views.values()) {
      if (now < v.sparkEndsAt) continue;
      const hadActivity = v.spark.some(n => n > 0);
      this._roll(v, now);
      if (hadActivity) changed.push(v.id);
    }
    if (changed.length) this.emit('agents', changed);
  }

  /** Flush and close the event log. */
  close() {
    const s = this._logStream;
    this._logStream = null;
    if (s) {
      try { s.end(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- reducer

  _reduce(ev, batch, index, changed, machines) {
    switch (ev.kind) {
      case EV.CREATED:
        this._created(ev, changed);
        return;
      case EV.MACHINE: {
        const m = ev.machine;
        if (!m || m.id == null) return;
        const stored = copy(m);
        this._machines.set(stored.id, stored);
        machines.set(stored.id, stored);
        return;
      }
      case EV.NOTICE: {
        if (ev.text == null || ev.text === '') return;
        const notice = { text: String(ev.text) };
        if (ev.agentId) notice.agentId = ev.agentId;
        this.emit('notice', notice);
        return;
      }
      default:
        break;
    }

    const v = this._views.get(ev.agentId);
    if (!v) return; // events for unknown agents are dropped
    const meta = this._meta.get(v.id);

    switch (ev.kind) {
      case EV.STATE: {
        if (!Object.hasOwn(PRIORITY, ev.state)) return; // unknown state: ignore
        if (Number.isFinite(ev.backgroundTasks)) {
          meta.backgroundTasks = ev.backgroundTasks;
          meta.background = ev.background && typeof ev.background === 'object' ? splitOf(ev.background) : null;
        }
        this._setState(v, ev.state, ev.reason ?? null, ev.ts, batch, index, changed);
        // The turn that reached the limit says so; a process that then exits with an error leaves it so (see _setState).
        if (ev.state === STATE.FAILED && ev.atLimit === true) v.atLimit = true;
        // It ended again (the engine's recheck after a save): a new finish, though its state may be the same, so a look
        // the person gave the last one does not hide this one. Nothing else of a change of state happens.
        if (ev.again === true && ENDED.has(v.state)) {
          v.endedAt = ev.ts;
          v.stateSince = ev.ts;
        }
        break;
      }

      case EV.ACTIVITY: {
        const sentence = ev.sentence == null ? '' : String(ev.sentence);
        if (ev.phase === 'end') {
          let s = sentence;
          if (ev.toolUseId != null && meta.openTools.has(ev.toolUseId)) {
            s = s || meta.openTools.get(ev.toolUseId);
            meta.openTools.delete(ev.toolUseId);
          }
          v.recent.push({ ts: ev.ts, sentence: s || 'A step', ok: typeof ev.ok === 'boolean' ? ev.ok : null });
          if (v.recent.length > RECENT_MAX) v.recent.splice(0, v.recent.length - RECENT_MAX);
        } else {
          if (sentence) v.now = sentence;
          v.toolCalls += 1;
          const kind = ev.toolKind || 'other';
          v.toolKinds[kind] = (v.toolKinds[kind] || 0) + 1;
          this._bump(v, ev.ts);
          v.thinking = false;
          if (ev.toolUseId != null) meta.openTools.set(ev.toolUseId, sentence);
        }
        v.lastEventAt = Math.max(v.lastEventAt || 0, ev.ts);
        if (v.state === STATE.STARTING) this._setState(v, STATE.WORKING, null, ev.ts, batch, index, changed);
        break;
      }

      case EV.THINKING: {
        v.thinking = !!ev.on;
        if (v.thinking) this._started(v, ev.ts, batch, index, changed);
        if (v.thinking && meta.openTools.size === 0) v.now = 'Thinking';
        break;
      }

      case EV.USAGE: {
        const u = v.usage;
        const add = ev.mode === 'add'; // 'set' unless told to add
        for (const f of TOKEN_FIELDS) {
          const n = ev[f];
          if (typeof n === 'number' && Number.isFinite(n)) u[f] = add ? (u[f] || 0) + n : n;
        }
        if (Object.hasOwn(ev, 'costUsd')) {
          const c = ev.costUsd;
          u.costUsd = (c == null || !Number.isFinite(Number(c))) ? null : Number(c);
        }
        if (Object.hasOwn(ev, 'unreportedUsd')) u.unreportedUsd = Number(ev.unreportedUsd) > 0 ? Number(ev.unreportedUsd) : 0;
        if (Object.hasOwn(ev, 'contextTokens')) u.contextTokens = Number.isFinite(ev.contextTokens) ? ev.contextTokens : null;
        if (Object.hasOwn(ev, 'contextWindow')) u.contextWindow = Number.isFinite(ev.contextWindow) ? ev.contextWindow : null;
        u.contextPct = (u.contextTokens != null && u.contextWindow) ? u.contextTokens / u.contextWindow : null;
        break;
      }

      case EV.TURN: {
        if (ev.phase === 'start') {
          v.turns += 1;
          this._started(v, ev.ts, batch, index, changed);
          if (!v.parentId) this._clearReceipt(v);
          if (!v.parentId && RESUMES_ON_TURN.has(v.state)) {
            const prev = v.state;
            this._setState(v, STATE.WORKING, null, ev.ts, batch, index, changed);
            // No message from the person started this turn (that one sets working first): Claude Code did, for
            // example when a command it left running ended.
            if (DONE.has(prev)) v.now = 'Picking up where it left off';
          }
        } else if (ev.phase === 'end') {
          // Nothing runs once a turn is over; the engine decides the state.
          meta.openTools.clear();
          v.thinking = false;
        }
        break;
      }

      case EV.PLAN: {
        const items = Array.isArray(ev.items) ? ev.items.map(it => ({ ...it })) : [];
        v.plan = { items, done: items.filter(it => it && it.status === 'completed').length, total: items.length };
        break;
      }

      case EV.SAYS:
        v.says = ev.text == null ? null : String(ev.text);
        if (v.says) this._started(v, ev.ts, batch, index, changed);
        break;

      case EV.BACKGROUND:
        meta.background = splitOf(ev);
        if (!v.parentId && v.state === STATE.WAITING_HELPERS) v.now = this._waitingText(v);
        break;

      case EV.ASK:
        v.ask = ev.ask ? { ...copy(ev.ask), createdAt: ev.ts } : null;
        break;

      case EV.ASK_CLEARED:
        if (!v.ask || v.ask.id !== ev.askId) return;
        v.ask = null;
        break;

      case EV.FILES: v.files = copy(ev.files); break;
      case EV.CHECKS: v.checks = copy(ev.checks); break;
      case EV.RULES: v.rules = copy(ev.rules); break;
      case EV.MODEL: v.model = ev.model ?? null; break;
      case EV.SESSION:
        v.sessionId = ev.sessionId ?? null;
        this._started(v, ev.ts, batch, index, changed);
        break;
      case EV.WORK:
        // A helper works in its agent's folder: what becomes of the work is the agent's.
        if (v.parentId) return;
        v.work = workOf(ev.work);
        break;
      case EV.RESUMED:
        v.earlier = false;
        v.canContinue = null;
        v.continueReason = null;
        v.now = 'Picking up where it left off';
        if (Number.isFinite(ev.budgetUsd) && ev.budgetUsd > 0) v.budgetUsd = ev.budgetUsd; // a fresh limit for this run
        break;

      case EV.APPROVAL:
        if (ev.decision === 'deny') v.approvals.denied += 1;
        else if (ev.how === 'auto') v.approvals.auto += 1;
        else v.approvals.byYou += 1;
        break;

      case EV.ENDED:
        // The first finish of a run stands: a process that ends after its agent finished (Claude Code exits a little after
        // its last turn; a stopped one after the stop) leaves endedAt as it was, so a look the page keyed on that finish
        // still holds. While the agent still works, its process ending sets it, and the state that follows sets its own.
        if (!(ENDED.has(v.state) && v.endedAt != null)) v.endedAt = ev.ts;
        v.error = ev.error ? String(ev.error) : null;
        meta.openTools.clear();
        v.thinking = false;
        break;

      default:
        return; // unknown kinds are ignored
    }
    changed.add(v.id);
  }

  /** Any output (init, a turn, thinking, text) means a starting agent is working, not only a tool call. */
  _started(v, ts, batch, index, changed) {
    if (v.state === STATE.STARTING) this._setState(v, STATE.WORKING, null, ts, batch, index, changed);
  }

  /** A new turn starts: the last turn's result (files, checks, rules, what it said) must not read as current. */
  _clearReceipt(v) {
    if (v.checks) v.checks = { state: 'none', results: [] }; // as the engine cancels a receipt
    v.rules = null;
    v.says = null;
    v.files = null;
  }

  /**
   * Put a root back from history: a view that shows how it ended, marked `earlier`. `rec` is a record of history.mjs;
   * `can` is { ok, reason } (can it be continued). Not an event: it happens once, before anything runs, and is not logged.
   */
  restore(rec, can) {
    if (!rec || this._views.has(rec.id)) return null;
    const ts = rec.endedAt ?? rec.savedAt ?? Date.now();
    const v = newAgentView({
      agentId: rec.id, name: rec.name, task: rec.task, harness: rec.harness, model: rec.model, machineId: rec.machineId,
      budgetUsd: rec.budgetUsd, workspace: rec.workspace?.path ?? null, startedAt: rec.startedAt,
    }, ts);
    v.state = rec.state;
    v.stateReason = rec.stateReason;
    v.stateSince = ts;
    v.endedAt = rec.endedAt ?? ts;
    v.lastEventAt = ts;
    v.sparkEndsAt = bucketEnd(ts);
    v.now = rec.state === STATE.STOPPED ? 'Stopped' : 'Done';
    v.says = rec.says;
    v.files = copy(rec.files);
    v.checks = copy(rec.checks);
    v.rules = copy(rec.rules);
    v.approvals = { ...rec.approvals };
    v.usage = { ...rec.usage };
    v.sessionId = rec.sessionId;
    v.turns = rec.turns || 0;
    v.toolCalls = rec.toolCalls || 0;
    v.earlier = true;
    v.canContinue = !!can?.ok;
    v.continueReason = can?.ok ? null : (can?.reason || null);
    v.work = workOf(rec.work);
    this._views.set(v.id, v);
    this._meta.set(v.id, { seq: ++this._seq, openTools: new Map(), backgroundTasks: 0, background: null, waitedForHelpers: false });
    this.emit('agents', [v.id]);
    return v;
  }

  /** An earlier agent can no longer (or again) be continued: say why. */
  markContinue(id, can) {
    const v = this._views.get(id);
    if (!v || !v.earlier) return;
    v.canContinue = !!can?.ok;
    v.continueReason = can?.ok ? null : (can?.reason || null);
    this.emit('agents', [id]);
  }

  /**
   * The person's repository changed (a merge moved their branch, or a refresh found a new head, branch, number of
   * uncommitted changes or git identity): tell listeners. The server sends it to every page as `event: repo`.
   */
  repoChanged(repo) {
    this.emit('repo', repo && typeof repo === 'object' ? copy(repo) : null);
  }

  /** Take a root, and any helpers, out of the store (an earlier agent the person forgot). */
  remove(id) {
    const v = this._views.get(id);
    if (!v) return false;
    for (const d of [id, ...this.descendants(id).map(x => x.id)]) {
      this._views.delete(d);
      this._meta.delete(d);
      this._children.delete(d);
    }
    this.emit('removed', [id]);
    return true;
  }

  _created(ev, changed) {
    const id = ev.agentId;
    if (!id || this._views.has(id)) return; // ignore a duplicate agentId
    const parentId = ev.parentId || null;
    const parent = parentId ? this._views.get(parentId) : null;
    // Built field by field: the event's own `kind` is 'agent.created', not the view kind.
    const init = {
      agentId: id,
      parentId,
      rootId: parentId ? (parent ? parent.rootId : (ev.rootId || parentId)) : id,
      depth: parentId ? (parent ? parent.depth + 1 : 1) : 0,
      kind: parentId ? 'helper' : 'agent',
      name: ev.name,
      fullName: ev.fullName,
      task: ev.task,
      harness: ev.harness || parent?.harness,
      helperType: ev.helperType,
      model: ev.model,
      machineId: ev.machineId || parent?.machineId,
      budgetUsd: ev.budgetUsd,
      workspace: ev.workspace || parent?.workspace,
      startedAt: ev.startedAt,
    };
    const v = newAgentView(init, ev.ts);
    v.sparkEndsAt = bucketEnd(ev.ts);
    this._views.set(id, v);
    this._meta.set(id, { seq: ++this._seq, openTools: new Map(), backgroundTasks: 0, background: null, waitedForHelpers: false });
    if (parentId) {
      if (!this._children.has(parentId)) this._children.set(parentId, []);
      this._children.get(parentId).push(id);
      this._recomputeHelpers(parentId, changed);
    }
    changed.add(id);
  }

  _setState(v, next, reason, ts, batch, index, changed) {
    const prev = v.state;
    v.state = next;
    v.stateReason = reason == null ? null : String(reason);
    if (next !== STATE.FAILED) v.atLimit = false; // at its spending limit only while it stays failed
    if (next !== prev) {
      v.stateSince = ts;
      if (ENDED.has(next)) v.endedAt = ts;
      else if (ENDED.has(prev)) {
        // Picked up again after a follow-up: the earlier run's error no longer describes it.
        v.endedAt = null;
        v.error = null;
        if (!v.parentId) this._clearReceipt(v);
      }
      if (ASK_TYPE_OF_STATE[prev] && v.ask && !this._askSurvives(v, next, batch, index)) v.ask = null;
      if (ENDED.has(next)) {
        this._meta.get(v.id)?.openTools.clear();
        v.thinking = false;
      }
      if (!v.parentId && next === STATE.WORKING && RESUME_NOW[prev]) {
        // After a wait for commands only, there were no helpers to read from.
        v.now = prev === STATE.WAITING_HELPERS && !this._meta.get(v.id)?.waitedForHelpers ? 'Reading what came back' : RESUME_NOW[prev];
      }
      if (!v.parentId && next === STATE.WAITING_HELPERS) this._meta.get(v.id).waitedForHelpers = false;
    }
    if (!v.parentId && next === STATE.WAITING_HELPERS) v.now = this._waitingText(v);
    changed.add(v.id);
    if (v.parentId) this._recomputeHelpers(v.parentId, changed);
  }

  /**
   * Leaving an ask state normally clears the ask. It stays when it already belongs to the new
   * state (the engine emits agent.ask just before agent.state), or when an agent.ask for the
   * same agent follows in the same batch.
   */
  _askSurvives(v, next, batch, index) {
    if (ASK_TYPE_OF_STATE[next] && v.ask.type === ASK_TYPE_OF_STATE[next]) return true;
    for (let j = index + 1; j < batch.length; j++) {
      const e = batch[j];
      if (e && e.kind === EV.ASK && e.agentId === v.id) return true;
    }
    return false;
  }

  _recomputeHelpers(parentId, changed) {
    const p = this._views.get(parentId);
    if (!p) return;
    const kids = this.children(parentId);
    let working = 0;
    let done = 0;
    for (const c of kids) {
      if (ACTIVE.has(c.state)) working++;
      else done++;
    }
    const h = p.helpers;
    if (h.total !== kids.length || h.working !== working || h.done !== done) {
      p.helpers = { total: kids.length, working, done };
      changed.add(p.id);
    }
    if (!p.parentId && p.state === STATE.WAITING_HELPERS) {
      const text = this._waitingText(p);
      if (text !== p.now) {
        p.now = text;
        changed.add(p.id);
      }
    }
  }

  /**
   * "Waiting for 2 helpers", "Waiting for a background command", "Waiting for its helper and a background command".
   * Helpers are the working helper views, else the ones in the latest split; without a split (Codex, the simulator)
   * the background task count is of helpers.
   */
  _waitingText(v) {
    const meta = this._meta.get(v.id);
    const bg = meta?.background;
    const helpers = v.helpers.working || (bg ? bg.helpers : meta?.backgroundTasks) || 0;
    if (meta && helpers) meta.waitedForHelpers = true;
    if (!bg) return helpers ? `Waiting for ${helpers} helper${helpers === 1 ? '' : 's'}` : 'Waiting for its helpers';
    if (!helpers && !bg.commands && !bg.others) return 'Its background work is done'; // a new turn follows
    const words = waitingFor({ helpers, commands: bg.commands, others: bg.others });
    return `Waiting for ${words === 'its helper' ? '1 helper' : words}`;
  }

  // ---------------------------------------------------------------- sparkline

  /** Shift buckets so the newest one contains ts. */
  _roll(v, ts) {
    if (ts < v.sparkEndsAt) return;
    const k = Math.floor((ts - v.sparkEndsAt) / SPARK_BUCKET_MS) + 1;
    if (k >= SPARK_BUCKETS) v.spark = new Array(SPARK_BUCKETS).fill(0);
    else v.spark = v.spark.slice(k).concat(new Array(k).fill(0));
    v.sparkEndsAt += k * SPARK_BUCKET_MS;
  }

  /** Count one tool start in the bucket that contains ts. */
  _bump(v, ts) {
    this._roll(v, ts);
    const age = Math.floor((v.sparkEndsAt - 1 - ts) / SPARK_BUCKET_MS);
    const idx = SPARK_BUCKETS - 1 - age;
    if (idx >= 0 && idx < SPARK_BUCKETS) v.spark[idx] += 1;
  }

  // ---------------------------------------------------------------- event log

  _openLog(logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const s = fs.createWriteStream(logPath, { flags: 'a' });
      s.on('error', (err) => {
        if (this._logStream === s) this._logStream = null;
        this._warn('The event log could not be written, so it is turned off', err);
      });
      this._logStream = s;
    } catch (err) {
      this._logStream = null;
      this._warn('The event log could not be opened', err);
    }
  }

  _writeLog(ev) {
    const s = this._logStream;
    if (!s) return;
    try {
      s.write(JSON.stringify(ev) + '\n');
    } catch (err) {
      this._warn('An event could not be logged', err);
    }
  }

  _warn(msg, err, extra) {
    const l = this._log;
    try {
      if (typeof l?.warn === 'function') l.warn(msg, err?.message || err, extra);
      else if (typeof l === 'function') l('warn', msg, err?.message || err);
    } catch { /* logging must never break the store */ }
  }
}
