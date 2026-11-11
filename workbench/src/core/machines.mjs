// The machines agents run on.
// "Your laptop" is always present and real: its CPU and memory come from node:os.
// Demo mode adds three simulated cloud machines that can be put to sleep and woken up.
// Nothing here starts or stops agents; the engine reads list() and listens for 'update'.
import { EventEmitter } from 'node:events';
import nodeOs from 'node:os';

const CLOUD_RATE_USD = 0.40;   // per hour while awake
const WAKE_MS = 10_000;        // how long a sleeping cloud machine takes to wake

// The demo's cloud machines and how they start out.
const DEMO_CLOUDS = [
  { id: 'cloud-1', name: 'Cloud 1', awake: true,  agents: 0 },
  { id: 'cloud-2', name: 'Cloud 2', awake: false, agents: 0 },
  { id: 'cloud-3', name: 'Cloud 3', awake: true,  agents: 1 },
];

/** Count agents on a machine as a few words: "idle", "1 agent", "3 agents". */
function agentsNote(n) {
  if (!n) return 'idle';
  return n === 1 ? '1 agent' : `${n} agents`;
}

/** "about 10 seconds" */
function aboutSeconds(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s === 1 ? 'about a second' : `about ${s} seconds`;
}

/** Accept "cloud-2", "Cloud 2", "cloud2" or "laptop" and return the canonical id. */
function normalizeId(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (s === 'your laptop' || s === 'my laptop' || s === 'laptop') return 'laptop';
  const m = /^cloud[\s_-]*(\d+)$/.exec(s);
  return m ? `cloud-${Number(m[1])}` : s;
}

function countFrom(counts, id) {
  const v = counts instanceof Map ? counts.get(id) : counts[id];
  const n = typeof v === 'number' ? v : (v && typeof v.agents === 'number' ? v.agents : 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export class Machines extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.demo]        add the simulated cloud machines
   * @param {object}  [opts.os]          stand-in for node:os (tests)
   * @param {number}  [opts.wakeMs]      how long a cloud machine takes to wake
   * @param {Function} [opts.setTimer]   stand-in for setTimeout (tests)
   * @param {Function} [opts.clearTimer] stand-in for clearTimeout (tests)
   */
  constructor({ demo = false, os = nodeOs, wakeMs = WAKE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    super();
    this.demo = !!demo;
    this._os = os;
    this._wakeMs = wakeMs;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._machines = new Map();   // id -> internal record (a Machine plus waking/timer)

    const laptop = {
      id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true, simulated: false,
      cpuPct: null, memPct: null, costPerHourUsd: null, agents: 0, note: 'idle',
      waking: false, timer: null,
    };
    this._sampleLaptop(laptop);
    this._machines.set(laptop.id, laptop);

    if (this.demo) {
      for (const c of DEMO_CLOUDS) {
        const m = {
          id: c.id, name: c.name, kind: 'cloud', awake: c.awake, simulated: true,
          cpuPct: null, memPct: null, costPerHourUsd: CLOUD_RATE_USD, agents: c.agents, note: '',
          waking: false, timer: null,
        };
        this._settle(m);
        this._machines.set(m.id, m);
      }
    }
  }

  /** Every machine, laptop first. Copies: changing them does not change the machines. */
  list() {
    return [...this._machines.values()].map(publicView);
  }

  /** One machine by id (or a loose name such as "Cloud 2"), or null. */
  get(id) {
    const m = this._machines.get(normalizeId(id));
    return m ? publicView(m) : null;
  }

  /**
   * Wake a sleeping cloud machine or put one to sleep.
   * @returns {{ ok: boolean, reply: string }} reply is a plain sentence for the person
   */
  setAwake(id, awake) {
    const key = normalizeId(id);
    const m = this._machines.get(key);
    if (!m) {
      if (!this.demo && key.startsWith('cloud')) {
        return { ok: false, reply: 'Cloud machines are only available in demo mode. Agents run on your laptop.' };
      }
      return { ok: false, reply: `There is no machine called ${String(id ?? '').trim() || 'that'}.` };
    }
    if (m.kind === 'laptop') {
      return awake
        ? { ok: true, reply: 'Your laptop is already awake.' }
        : { ok: false, reply: 'Your laptop runs Workbench itself, so it stays awake.' };
    }

    if (awake) {
      if (m.awake) return { ok: true, reply: `${m.name} is already awake.` };
      if (m.waking) return { ok: true, reply: `${m.name} is already waking up. It takes ${aboutSeconds(this._wakeMs)}.` };
      m.waking = true;
      m.timer = this._setTimer(() => this._finishWake(m), this._wakeMs);
      m.timer?.unref?.();       // never keep the process alive just to finish waking
      this._settle(m);
      this._emitChanged([m]);
      return { ok: true, reply: `${m.name} is waking up. It takes ${aboutSeconds(this._wakeMs)}.` };
    }

    if (!m.awake && !m.waking) return { ok: true, reply: `${m.name} is already asleep.` };
    this._cancelWake(m);
    m.awake = false;
    this._settle(m);
    this._emitChanged([m]);
    const n = m.agents;
    const after = n ? ` ${n === 1 ? 'Its agent' : `Its ${n} agents`} will pick up again when it wakes.` : '';
    return { ok: true, reply: `${m.name} is asleep. Its work is saved.${after}` };
  }

  /** Put every awake cloud machine with no agents to sleep. */
  sleepIdle() {
    const idle = [...this._machines.values()].filter(m => m.kind === 'cloud' && m.awake && !m.agents);
    if (!idle.length) return { ok: true, reply: 'No machine is idle right now.', ids: [] };
    for (const m of idle) { m.awake = false; this._settle(m); }
    this._emitChanged(idle);
    const names = idle.map(m => m.name);
    const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    const reply = idle.length === 1 ? `${list} is asleep. Its work is saved.` : `${list} are asleep. Their work is saved.`;
    return { ok: true, reply, ids: idle.map(m => m.id) };
  }

  /**
   * Update agent counts and notes, and re-read the laptop's CPU and memory.
   * @param {Record<string, number>|Map<string, number>} [countsByMachine] root agents per machine id;
   *        machines left out count as 0. Leave it out entirely to keep the current counts.
   * @returns {object[]} the machines that changed (also emitted as 'update')
   */
  refresh(countsByMachine) {
    const changed = [];
    for (const m of this._machines.values()) {
      const before = fingerprint(m);
      if (countsByMachine != null) m.agents = countFrom(countsByMachine, m.id);
      if (m.kind === 'laptop') this._sampleLaptop(m);
      this._settle(m);
      if (fingerprint(m) !== before) changed.push(m);
    }
    return this._emitChanged(changed);
  }

  /** Stop any pending wake-up timers. A machine that was waking stays asleep. */
  dispose() {
    for (const m of this._machines.values()) {
      if (!m.waking) continue;
      this._cancelWake(m);
      this._settle(m);
    }
  }

  // ---- internals ----

  _finishWake(m) {
    m.timer = null;
    if (!m.waking) return;
    m.waking = false;
    m.awake = true;
    this._settle(m);
    this._emitChanged([m]);
  }

  _cancelWake(m) {
    if (m.timer != null) this._clearTimer(m.timer);
    m.timer = null;
    m.waking = false;
  }

  /** Recompute the derived fields of a machine: note, and simulated load for cloud machines. */
  _settle(m) {
    if (m.kind === 'cloud') {
      if (m.awake) {
        // Simulated load: light when idle, busier with each agent.
        m.cpuPct = m.agents ? Math.min(90, 20 + 25 * m.agents) : 3;
        m.memPct = m.agents ? Math.min(85, 32 + 14 * m.agents) : 18;
      } else {
        m.cpuPct = null;
        m.memPct = null;
      }
    }
    m.note = m.waking ? 'waking up' : !m.awake ? 'asleep' : agentsNote(m.agents);
  }

  _sampleLaptop(m) {
    try {
      const cpus = this._os.cpus();
      const load = this._os.loadavg()[0];
      m.cpuPct = cpus && cpus.length ? clampPct(load / cpus.length * 100) : null;
    } catch { m.cpuPct = null; }
    try {
      const total = this._os.totalmem();
      const free = this._os.freemem();
      m.memPct = total > 0 ? clampPct((total - free) / total * 100) : null;
    } catch { m.memPct = null; }
  }

  _emitChanged(list) {
    const out = list.map(publicView);
    if (out.length) this.emit('update', out);
    return out;
  }
}

function clampPct(x) {
  return Number.isFinite(x) ? Math.round(Math.max(0, Math.min(100, x))) : null;
}

/** The Machine shape from events.mjs, without internal fields. */
function publicView(m) {
  return {
    id: m.id, name: m.name, kind: m.kind, awake: m.awake, simulated: m.simulated,
    cpuPct: m.cpuPct, memPct: m.memPct, costPerHourUsd: m.costPerHourUsd,
    agents: m.agents, note: m.note,
  };
}

function fingerprint(m) {
  return [m.awake, m.waking, m.cpuPct, m.memPct, m.agents, m.note].join('|');
}
