// A small stand-in for the store's reducer and the engine's turn-end decision, written from ARCHITECTURE.md,
// so the simulator's tests can check what a person would see. It does not import the real store or engine.
import { EV, newAgentView, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../../src/shared/events.mjs';
import { ENDED, ACTIVE, DONE } from '../../src/shared/states.mjs';
import { extractQuestion, firstSentence } from '../../src/shared/narrate.mjs';

const ASK_STATES = new Set(['needs_ok', 'question', 'maybe_stuck']);
const KINDS = new Set(Object.values(EV));

/**
 * @param {{ engine?: boolean }} [opts]  engine: also decide root states on turn ends, like the engine does
 */
export function createFakeStore({ engine = true } = {}) {
  const views = new Map();
  const order = [];
  const events = [];     // everything the simulator emitted, in order
  const derived = [];    // what the fake engine added on turn ends
  const errors = [];     // contract problems noticed while reducing
  const lastTs = new Map();
  let askSeq = 0;

  function roll(v, ts) {
    if (ts <= v.sparkEndsAt) return;
    const n = Math.ceil((ts - v.sparkEndsAt) / SPARK_BUCKET_MS);
    for (let i = 0; i < Math.min(n, SPARK_BUCKETS); i++) { v.spark.shift(); v.spark.push(0); }
    v.sparkEndsAt += n * SPARK_BUCKET_MS;
  }

  function recount(parent) {
    if (!parent) return;
    const kids = order.map(id => views.get(id)).filter(v => v.parentId === parent.id);
    parent.helpers = {
      total: kids.length,
      working: kids.filter(k => ACTIVE.has(k.state)).length,
      done: kids.filter(k => ENDED.has(k.state)).length,
    };
  }

  function decideTurnEnd(v, ev) {
    const out = [];
    const base = { agentId: v.id, ts: ev.ts };
    if (ev.backgroundTasks > 0) out.push({ ...base, kind: EV.STATE, state: 'waiting_helpers' });
    else if (ev.isError) out.push({ ...base, kind: EV.STATE, state: 'failed', reason: ev.finalText });
    else {
      const q = extractQuestion(ev.finalText);
      if (q) {
        const intro = firstSentence(ev.finalText);
        if (intro && intro !== q) out.push({ ...base, kind: EV.SAYS, text: intro });
        out.push({ ...base, kind: EV.ASK, ask: { id: `engine-ask-${++askSeq}`, type: 'question', sentence: q, options: [] } });
        out.push({ ...base, kind: EV.STATE, state: 'question' });
      } else {
        // In the demo there is no workspace: the engine uses the checks the simulator reported.
        const checks = v.checks ? v.checks.state : 'none';
        const state = checks === 'passed' ? 'done_checked' : checks === 'failed' ? 'checks_failed' : 'done_claimed';
        out.push({ ...base, kind: EV.SAYS, text: firstSentence(ev.finalText) });
        out.push({ ...base, kind: EV.STATE, state });
      }
    }
    for (const d of out) { derived.push(d); reduce(d); }
  }

  function reduce(ev) {
    const v = views.get(ev.agentId);
    switch (ev.kind) {
      case EV.CREATED: {
        if (v) return;
        const parent = ev.parentId ? views.get(ev.parentId) : null;
        if (ev.parentId && !parent) errors.push(`helper ${ev.agentId} created before its parent`);
        const view = newAgentView({
          ...ev, kind: ev.parentId ? 'helper' : 'agent',
          rootId: parent ? parent.rootId : ev.agentId, depth: parent ? parent.depth + 1 : 0,
        }, ev.ts);
        views.set(ev.agentId, view);
        order.push(ev.agentId);
        recount(parent);
        return;
      }
      case EV.MACHINE: case EV.NOTICE: return;
      default: break;
    }
    if (!v) { errors.push(`${ev.kind} for unknown agent ${ev.agentId}`); return; }
    switch (ev.kind) {
      case EV.STATE: {
        const leaving = ASK_STATES.has(v.state) && !ASK_STATES.has(ev.state);
        v.state = ev.state;
        v.stateReason = ev.reason || null;
        v.stateSince = ev.ts;
        if (ENDED.has(ev.state)) v.endedAt = ev.ts;
        if (leaving) v.ask = null;
        recount(views.get(v.parentId));
        if (!v.parentId && ev.state === 'waiting_helpers') v.now = `Waiting for ${v.helpers.working} helpers`;
        break;
      }
      case EV.ACTIVITY:
        roll(v, ev.ts);
        if (ev.phase === 'start') {
          v.now = ev.sentence;
          v.toolCalls += 1;
          v.toolKinds[ev.toolKind] = (v.toolKinds[ev.toolKind] || 0) + 1;
          v.spark[v.spark.length - 1] += 1;
          v.thinking = false;
        } else {
          v.recent.push({ ts: ev.ts, sentence: ev.sentence, ok: ev.ok ?? null });
          if (v.recent.length > 8) v.recent.shift();
        }
        v.lastEventAt = ev.ts;
        if (v.state === 'starting') v.state = 'working';
        break;
      case EV.THINKING:
        v.thinking = !!ev.on;
        if (ev.on) v.now = 'Thinking';
        break;
      case EV.USAGE: {
        const u = v.usage;
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
          u[k] = ev.mode === 'set' ? (ev[k] || 0) : u[k] + (ev[k] || 0);
        }
        if ('costUsd' in ev) u.costUsd = ev.costUsd;
        if (ev.contextTokens != null) u.contextTokens = ev.contextTokens;
        if (ev.contextWindow != null) u.contextWindow = ev.contextWindow;
        u.contextPct = u.contextTokens != null && u.contextWindow ? u.contextTokens / u.contextWindow : null;
        break;
      }
      case EV.TURN:
        if (ev.phase === 'start') {
          v.turns += 1;
          if (!v.parentId && (v.state === 'question' || DONE.has(v.state) || v.state === 'waiting_helpers')) v.state = 'working';
        } else if (engine && !v.parentId) {
          decideTurnEnd(v, ev);
        }
        break;
      case EV.PLAN:
        v.plan = { items: ev.items.map(i => ({ ...i })), done: ev.items.filter(i => i.status === 'completed').length, total: ev.items.length };
        break;
      case EV.SAYS: v.says = ev.text; break;
      case EV.ASK: v.ask = { ...ev.ask, createdAt: ev.ts }; break;
      case EV.ASK_CLEARED: if (v.ask && v.ask.id === ev.askId) v.ask = null; break;
      case EV.FILES: v.files = ev.files; break;
      case EV.CHECKS: v.checks = ev.checks; break;
      case EV.RULES: v.rules = ev.rules; break;
      case EV.MODEL: v.model = ev.model; break;
      case EV.SESSION: v.sessionId = ev.sessionId; break;
      case EV.APPROVAL:
        if (ev.decision === 'deny') v.approvals.denied += 1;
        else if (ev.how === 'auto') v.approvals.auto += 1;
        else v.approvals.byYou += 1;
        break;
      case EV.ENDED: v.endedAt = ev.ts; v.error = ev.error || null; break;
      default: errors.push(`unhandled kind ${ev.kind}`);
    }
  }

  function emit(ev) {
    events.push(ev);
    if (!KINDS.has(ev.kind)) errors.push(`unknown event kind ${ev.kind}`);
    if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts)) errors.push(`bad ts on ${ev.kind}`);
    const prev = lastTs.get(ev.agentId);
    if (prev != null && ev.ts < prev) errors.push(`${ev.kind} for ${ev.agentId} went back in time`);
    lastTs.set(ev.agentId, ev.ts);
    reduce(ev);
  }

  const all = () => order.map(id => views.get(id));
  return {
    emit,
    events,
    derived,
    errors,
    get: id => views.get(id),
    list: all,
    roots: () => all().filter(v => !v.parentId),
    byName: name => all().find(v => !v.parentId && v.name === name),
    helpersOf: id => all().filter(v => v.parentId === id),
    eventsFor: id => events.filter(e => e.agentId === id),
  };
}
