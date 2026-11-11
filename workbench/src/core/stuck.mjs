// Notices when an agent might be stuck. Fed with every event; asked on each engine tick.
//
// An agent that is working (or still starting) is possibly stuck when:
//   1. the same step (sentence and input) started 3 times in a row, each retry coming after the
//      previous try failed, with no successful step in between;
//   2. the same error text came back 3 times, each time within 10 steps of the time before and from
//      a step started after it (only events that carry error text count). Calls made together count
//      as one step, so a batch that fails the same way counts once. Successful steps in between do
//      not reset the count: that is the agent editing and retrying into the same error;
//   3. no event arrived for `silenceMs` (4 minutes by default) and none of its helpers is working.
//
// Once flagged, an agent is not flagged again until it leaves maybe_stuck. observe() reports
// progress for a flagged agent so the engine can clear the state: any successful step, whatever
// the rule (and, after a silence, any new step).
import { EV } from '../shared/events.mjs';
import { STATE, ENDED } from '../shared/states.mjs';
import { duration, clip } from '../shared/format.mjs';

const WORDS = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };
const times = (n) => (WORDS[n] || String(n)) + ' times';

function inputKey(ev) {
  const raw = ev.input ?? ev.detail ?? null;
  if (raw == null) return '';
  try { return typeof raw === 'string' ? raw : JSON.stringify(raw); } catch { return ''; }
}

/** Same sentence and same input make the same step. */
function stepKey(ev) {
  return String(ev.sentence ?? '') + '\u0001' + inputKey(ev);
}

/** The error text an adapter attached to a failed step, if any. */
function errorText(ev) {
  const raw = ev.error ?? ev.errorText ?? null;
  if (raw == null) return '';
  return String(raw).replace(/\s+/g, ' ').trim();
}

export class StuckDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.silenceMs]   quiet time before rule 3 fires
   * @param {number} [opts.repeats]     how many repeats rules 1 and 2 need
   * @param {number} [opts.errorSteps]  rule 2: how many steps an error stays current after it came back
   */
  constructor({ silenceMs = 4 * 60_000, repeats = 3, errorSteps = 10 } = {}) {
    this.silenceMs = silenceMs;
    this.repeats = repeats;
    this.errorSteps = errorSteps;
    this._agents = new Map();
  }

  _track(id) {
    let t = this._agents.get(id);
    if (!t) {
      t = {
        lastEventAt: 0,
        last: null,          // the latest step started: { key, sentence, ended, failed, at }
        open: new Map(),     // toolUseId -> step record, for steps still running
        streak: 0,           // same step started in a row, each after a failed try
        steps: 0,            // steps finished so far, whatever their outcome; calls made together are one step (never reset)
        errors: new Map(),   // normalized error text -> { count, at, key, sentence, text }
        pending: null,       // a rule that fired, waiting for check()
        flag: null,          // the rule that flagged the agent, until it leaves maybe_stuck
      };
      this._agents.set(id, t);
    }
    return t;
  }

  /**
   * Feed one event.
   * @returns {{ agentId: string, progress: true } | null} progress for a flagged agent
   */
  observe(ev) {
    if (!ev || !ev.agentId) return null;
    const t = this._track(ev.agentId);
    if (Number.isFinite(ev.ts)) t.lastEventAt = Math.max(t.lastEventAt, ev.ts);
    switch (ev.kind) {
      case EV.ACTIVITY:
        return ev.phase === 'end' ? this._end(t, ev) : this._start(t, ev);
      case EV.TURN:
        if (ev.phase === 'start') this._resetCounts(t);
        return null;
      case EV.STATE:
        if (ENDED.has(ev.state)) {
          this.forget(ev.agentId);
        } else if (ev.state !== STATE.MAYBE_STUCK && t.flag) {
          this.reset(ev.agentId); // it left maybe_stuck: start counting afresh
        } else if (ev.state === STATE.NEEDS_OK || ev.state === STATE.QUESTION) {
          t.pending = null; // the person is involved now
        }
        return null;
      default:
        return null;
    }
  }

  _start(t, ev) {
    const key = stepKey(ev);
    const prev = t.last;
    // A retry counts only once the previous try of the same step has failed. Parallel calls that
    // narrate the same way ("Checking what changed" three times at once) do not count.
    if (prev && prev.key === key && prev.ended && prev.failed && t.streak > 0) t.streak += 1;
    else t.streak = 1;
    const rec = { key, sentence: String(ev.sentence ?? ''), ended: false, failed: false, at: t.steps };
    t.last = rec;
    if (ev.toolUseId != null) t.open.set(ev.toolUseId, rec);
    if (!t.flag && !t.pending && t.streak >= this.repeats) {
      t.pending = { rule: 'repeat', key, sentence: rec.sentence, detail: rec.sentence };
    }
    if (t.flag && t.flag.rule === 'silence') return { agentId: ev.agentId, progress: true };
    return null;
  }

  _end(t, ev) {
    let rec = null;
    if (ev.toolUseId != null) {
      rec = t.open.get(ev.toolUseId) || null;
      t.open.delete(ev.toolUseId);
    } else if (t.last && !t.last.ended) {
      rec = t.last;
    }
    if (rec) {
      rec.ended = true;
      rec.failed = ev.ok === false;
    }
    const key = rec ? rec.key : stepKey(ev);
    // Calls made together are one step: only the first of them to finish moves the count on.
    if (!rec || rec.at === t.steps) t.steps += 1;

    if (ev.ok === true) {
      t.streak = 0;
      if (t.pending && t.pending.rule === 'repeat') t.pending = null;
      // Any step that works is progress, whichever rule flagged the agent.
      if (t.flag) return { agentId: ev.agentId, progress: true };
      return null;
    }

    if (ev.ok === false) {
      const text = errorText(ev);
      if (text) {
        const norm = text.toLowerCase().replace(/\d+/g, '#').slice(0, 300);
        let e = t.errors.get(norm);
        // Not seen for more than errorSteps steps: it starts counting afresh.
        if (!e || t.steps - e.at > this.errorSteps) e = { count: 0, at: 0 };
        // Calls that were already running when it last came back failed together with it: count once.
        if (!rec || rec.at >= e.at) e.count += 1;
        e.at = t.steps;
        e.key = key;
        e.sentence = rec ? rec.sentence : String(ev.sentence ?? '');
        e.text = text;
        t.errors.set(norm, e);
        if (e.count >= this.repeats && !t.flag && !t.pending) {
          t.pending = { rule: 'error', key: e.key, sentence: e.sentence, detail: clip(text, 300) };
        }
      }
    }
    return null;
  }

  _resetCounts(t) {
    t.streak = 0;
    t.last = null;
    t.errors.clear();
    t.pending = null;
  }

  /**
   * Which working agents look stuck now. Each returned agent is marked as flagged.
   * @param {number} now
   * @param {object[]} views  AgentViews to consider (the engine passes the ones it may flag)
   * @returns {{ agentId, rule: 'repeat'|'error'|'silence', sentence, detail, reason }[]}
   */
  check(now, views) {
    const flags = [];
    for (const v of views || []) {
      if (!v || (v.state !== STATE.WORKING && v.state !== STATE.STARTING)) continue;
      const t = this._track(v.id);
      if (t.flag) continue;
      let f = t.pending;
      if (!f) {
        const quietSince = Math.max(t.lastEventAt || 0, v.lastEventAt || 0, v.stateSince || 0);
        const helpersWorking = (v.helpers && v.helpers.working) || 0;
        if (now - quietSince >= this.silenceMs && helpersWorking === 0) {
          const running = [...t.open.values()].find(r => !r.ended);
          f = { rule: 'silence', key: null, sentence: running ? running.sentence : '', detail: running ? running.sentence : '', running: !!running };
        }
      }
      if (!f) continue;
      t.pending = null;
      t.flag = f;
      flags.push({ agentId: v.id, rule: f.rule, ...this._words(v.name || 'The agent', f) });
    }
    return flags;
  }

  _words(name, f) {
    const n = times(this.repeats);
    if (f.rule === 'repeat') {
      return { sentence: `${name} has tried the same step ${n} without success.`, detail: f.detail || '', reason: `Tried the same step ${n}` };
    }
    if (f.rule === 'error') {
      return { sentence: `${name} has hit the same error ${n}.`, detail: f.detail || '', reason: `Hit the same error ${n}` };
    }
    const quiet = duration(this.silenceMs);
    if (f.running) {
      return { sentence: `${name} has been on the same step for ${quiet} with no news.`, detail: f.detail || '', reason: `No news for ${quiet}` };
    }
    return { sentence: `${name} has not done anything for ${quiet}.`, detail: '', reason: `Quiet for ${quiet}` };
  }

  isFlagged(agentId) {
    return !!this._agents.get(agentId)?.flag;
  }

  /** Start over for an agent: after the person answers, or once it is no longer maybe_stuck. */
  reset(agentId) {
    const t = this._agents.get(agentId);
    if (!t) return;
    this._resetCounts(t);
    t.flag = null;
  }

  /** Drop everything about an agent that has ended. */
  forget(agentId) {
    this._agents.delete(agentId);
  }
}
