// From the agents the engine sends to what the board draws: one entry per root agent, with its stop on its lane,
// its lit line, its place in the queue and its helpers in order. Pure: no DOM, no imports; the state sets come in `ctx`.
import { needsPerson, needsQueue, helpersByNeed } from './queue.js';
import { markOfAgent, statusWords } from './look.js';

/**
 * @param {object[]} agents  AgentViews
 * @param {{ LOOK, NEEDS_YOU: Set<string>, DONE: Set<string>, ENDED: Set<string>, PRIORITY, later?: Set<string>, currentId?: string|null,
 *           machineName?: (id: string) => string }} ctx
 * @returns {{ roots: object[], queue: object[], byId: Map<string, object> }}
 */
export function boardModel(agents, ctx) {
  const { LOOK, NEEDS_YOU, DONE, ENDED, later } = ctx;
  const all = [...agents];
  const byId = new Map(all.map(a => [a.id, a]));
  const queue = needsQueue(all, ctx);
  const qIndex = new Map();
  queue.forEach((a, i) => { const root = a.rootId || a.id; if (!qIndex.has(root)) qIndex.set(root, i); });
  const kidsOf = new Map();
  for (const a of all) if (a.parentId) {
    const root = a.rootId && byId.has(a.rootId) ? a.rootId : a.parentId;
    if (!kidsOf.has(root)) kidsOf.set(root, []);
    kidsOf.get(root).push(a);
  }
  const current = ctx.currentId ? byId.get(ctx.currentId) : null;
  const currentRoot = current ? (current.rootId && byId.has(current.rootId) ? current.rootId : current.parentId || current.id) : null;
  const needs = a => needsPerson(a, { NEEDS_YOU, later });
  const roots = all.filter(a => !a.parentId).map(a => {
    const kids = helpersByNeed(kidsOf.get(a.id) || [], { NEEDS_YOU, ENDED });
    const askingKid = kids.find(needs) || null;
    const rootNeeds = needs(a);
    const inner = rootNeeds || !!askingKid;
    const finished = DONE.has(a.state) || ENDED.has(a.state);
    const stop = inner ? 'inner' : finished ? 'edge' : 'mid';
    const asker = rootNeeds ? a : askingKid;
    const look = markOfAgent(askingKid && !rootNeeds ? askingKid : a, LOOK);
    const qi = qIndex.get(a.id);
    return {
      id: a.id, name: a.name || 'Agent', machineId: a.machineId, startedAt: a.startedAt || 0,
      state: a.state, mark: look.shape, tone: look.tone, label: markOfAgent(a, LOOK).label,
      askerId: asker ? asker.id : null, askId: asker?.ask?.id || null,
      machineName: ctx.machineName ? ctx.machineName(a.machineId) : (a.machineId || ''),
      status: askingKid && !rootNeeds ? 'helper needs you' : statusWords(a, LOOK),
      stop, lit: inner ? (markOfAgent(asker, LOOK).tone === 'stuck' ? 'stuck' : 'need') : null,
      qno: qi == null ? null : qi + 1, current: currentRoot === a.id,
      ghost: finished && !inner, failed: a.state === 'failed' && !inner, earlier: !!a.earlier,
      working: (a.state === 'working' || a.state === 'starting') && stop === 'mid',
      kids: kids.map(k => {
        const m = markOfAgent(k, LOOK);
        return { id: k.id, name: k.name || 'Helper', status: k.state === 'working' || k.state === 'starting' ? statusWords(k, LOOK) : m.label,
          mark: m.shape, tone: m.tone, label: m.label, needs: needs(k), ended: ENDED.has(k.state) };
      }),
    };
  });
  return { roots, queue, byId };
}

/**
 * Agents from an earlier run (restored from history) never take a lane: they wait in the done tray, so a fresh start with
 * a long history still leaves the board to the agents that run now. One that is continued stops being `earlier` and gets a lane.
 */
export function splitEarlier(roots) {
  return { current: roots.filter(r => !r.earlier), earlier: roots.filter(r => r.earlier) };
}

/** "just now", "12 min ago", "3 hours ago", "2 days ago": coarse, so it does not change every second. */
export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'a while ago';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * What the done tray says. `done`: finished or stopped agents on the board's own run, `earlier`: agents from earlier runs,
 * `over`: working agents with no room on the board. lead is the bold part; text is all of it, plain (for measuring).
 */
export function trayWords({ done = 0, earlier = 0, over = 0 }) {
  const lead = done ? `${done} done` : `${earlier} from earlier`;
  const rest = [done ? ' or stopped' : '', done && earlier ? `, ${earlier} from earlier` : '', over ? `, ${over} more working` : ''].join('');
  const aria = [done ? `${done} done or stopped` : '', earlier ? `${earlier} from an earlier run` : '', over ? `${over} more working with no room on the board` : '']
    .filter(Boolean).join(', ');
  return { lead, rest, text: lead + rest, aria: `${aria}. Show them.` };
}
