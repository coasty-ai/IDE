// From the agents the engine sends to what the board draws: one entry per root agent, with its stop on its lane,
// its lit line, its place in the queue and its helpers in order; then which of them take a lane and which wait in the
// done tray. Pure: no DOM, and it imports only pure modules; the state sets come in `ctx`.
import { needsPerson, needsQueue, helpersByNeed, finishedWith, workSettled, unmergedWork } from './queue.js';
import { markOfAgent, statusWords } from './look.js';
import { denseLanes, ROWS } from './lanes.js';

/**
 * @param {object[]} agents  AgentViews
 * @param {{ LOOK, NEEDS_YOU: Set<string>, DONE: Set<string>, ENDED: Set<string>, PRIORITY, later?: Set<string>, reviewed?: Set<string>,
 *           currentId?: string|null, machineName?: (id: string) => string }} ctx
 * @returns {{ roots: object[], queue: object[], byId: Map<string, object> }}
 */
export function boardModel(agents, ctx) {
  const { LOOK, NEEDS_YOU, DONE, ENDED, later, reviewed } = ctx;
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
      id: a.id, name: a.name || 'Agent', machineId: a.machineId, startedAt: a.startedAt || 0, endedAt: a.endedAt || null, stateSince: a.stateSince || 0,
      state: a.state, mark: look.shape, tone: look.tone, label: markOfAgent(a, LOOK).label,
      askerId: asker ? asker.id : null, askId: asker?.ask?.id || null,
      machineName: ctx.machineName ? ctx.machineName(a.machineId) : (a.machineId || ''),
      status: askingKid && !rootNeeds ? 'helper needs you' : statusWords(a, LOOK),
      stop, lit: inner ? (markOfAgent(asker, LOOK).tone === 'stuck' ? 'stuck' : 'need') : null,
      qno: qi == null ? null : qi + 1, current: currentRoot === a.id,
      ghost: finished && !inner, failed: a.state === 'failed' && !inner, earlier: !!a.earlier,
      // the person is finished with it (queue.js): it leaves the board, with its helpers, for the done tray
      handled: !inner && finishedWith(a, { NEEDS_YOU, reviewed, later }),
      // its work is done and not merged yet: in the tray, its row says so and the tray counts it (doneWords, trayWords)
      notMerged: notMergedYet(a),
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

/** A root that finished its work (done, or a failed check) with work not merged yet: not settled, and changed files. */
const notMergedYet = a => !!a && !a.parentId && !a.earlier && (a.state === 'done_checked' || a.state === 'done_claimed' || a.state === 'checks_failed')
  && !workSettled(a) && unmergedWork(a);

/**
 * What a row in the done tray's "Done" section says after the agent's name: where its work went ("merged", "thrown
 * away"), that it is not merged yet ("not merged", or "checks failed" for a failed check), or how it ended ("stopped",
 * "done and checked"). Unmerged work then reads differently from work that is in, so it is not forgotten.
 * @param {object} a  an AgentView
 */
export function doneWords(a, LOOK) {
  if (a.state === 'checks_failed' && !workSettled(a)) return 'checks failed';
  if (notMergedYet(a)) return 'not merged';
  return statusWords(a, LOOK);
}

/**
 * Who takes a lane and who waits in the done tray. Agents from an earlier run (restored from history) never take a lane,
 * so a fresh start with a long history still leaves the board to the agents that run now; nor does a root the person is
 * finished with (`handled`). One that is continued, told something or asked for a change works again, so it is neither,
 * and takes a lane like any newcomer.
 * @returns {{ on: object[], done: object[], earlier: object[] }}  in the order given
 */
export function splitBoard(roots) {
  const on = [], done = [], earlier = [];
  for (const r of roots) (r.earlier ? earlier : r.handled ? done : on).push(r);
  return { on, done, earlier };
}

/**
 * The board and its done tray, as the page draws them. Roots on the board hold lanes (`lanes`, lanes.js); the lanes of
 * roots that are not on it any more are freed, so a newcomer may take them, while the others keep theirs. Past twelve
 * roots on the board it goes dense: finished work there waits in the tray too (it keeps its lane, for when the board
 * thins out), each lane splits, and working agents with no room are counted in the tray. The tray lists this run's
 * finished agents newest first, then the earlier ones.
 * @param {object[]} roots  boardModel(...).roots
 * @param {import('./lanes.js').Lanes} lanes
 * @param {{ laptop?: (r: object) => boolean, maxRows?: number, prune?: boolean }} [o]
 *   laptop: whether a root runs on the laptop (it prefers the left); maxRows: the most rows a side holds when dense
 *   (layout.js maxDenseRows); prune: free the lanes of roots not on the board. Only with every agent there is: never
 *   before the first snapshot, or while no data is shown.
 * @returns {{ roots: object[], laneOf: (id: string) => object|null, nRows: number, dense: boolean, tray: object|null,
 *             trayIds: { done: string[], earlier: string[], over: string[] } }}
 */
export function boardAndTray(roots, lanes, { laptop = () => true, maxRows = Infinity, prune = true } = {}) {
  const { on, done: finished, earlier } = splitBoard(roots);
  if (prune) lanes.prune(on.map(r => r.id));
  if (on.length) lanes.assign(on.map(r => ({ id: r.id, startedAt: r.startedAt, laptop: !!laptop(r) })));
  const dense = on.length > 12;
  let shown = on, laneOf = id => lanes.get(id), nRows = ROWS, over = [], done = finished;
  if (dense) {
    done = finished.concat(on.filter(r => r.ghost));
    // newcomers take the free rows in this order: whatever needs the person first, so an asker always has a chip
    const active = on.filter(r => !r.ghost).sort((a, b) => (b.stop === 'inner') - (a.stop === 'inner'));
    const d = denseLanes(active, id => lanes.get(id), maxRows);
    over = d.overflow;
    shown = active.filter(r => !over.includes(r.id));
    laneOf = id => d.at.get(id) || null;
    nRows = d.rows;
  }
  const ended = r => r.endedAt || r.stateSince || 0;
  done = [...done].sort((a, b) => ended(b) - ended(a) || String(a.id).localeCompare(String(b.id)));
  const trayIds = { done: done.map(r => r.id), earlier: earlier.map(r => r.id), over: over.slice() };
  let tray = null;
  if (done.length || earlier.length || over.length) {
    const marks = done.concat(earlier).map(r => ({ shape: r.mark, tone: r.tone }));
    // this run's agents in the tray, as its words count them: done, and work not merged yet
    const counts = { done: done.filter(r => !r.notMerged).length, notMerged: done.filter(r => r.notMerged).length, earlier: earlier.length, over: over.length };
    tray = { count: done.length + earlier.length, ...counts, ids: trayIds.done.concat(trayIds.earlier, trayIds.over), marks, ...trayWords(counts) };
  }
  return { roots: shown, laneOf, nRows, dense, tray, trayIds };
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
 * What the done tray says, in a few words: "3 done", then ", 1 not merged", ", 5 from earlier" and ", 1 more working"
 * when there are such. `done`: this run's agents in the tray (finished, failed or stopped, and let go, or waiting there
 * on a dense board) whose work is in, thrown away or not to merge; `notMerged`: those whose work is done and not merged
 * yet (doneWords: "not merged", "checks failed"); `earlier`: agents from earlier runs; `over`: working agents with no
 * room on the board. lead is the bold part; text is all of it, plain (for measuring); sum is all of it for a screen
 * reader (the board's name says it too), and aria the tray's own name; short is lead and rest with "1 more" for "1 more
 * working", which the layout falls back on where the machines need the room (its list and its name keep all of it).
 */
export function trayWords({ done = 0, notMerged = 0, earlier = 0, over = 0 }) {
  const lead = done ? `${done} done` : notMerged ? `${notMerged} not merged` : `${earlier} from earlier`;
  const after = more => [done && notMerged ? `, ${notMerged} not merged` : '', (done || notMerged) && earlier ? `, ${earlier} from earlier` : '',
    over ? `, ${over} ${more}` : ''].join('');
  const rest = after('more working');
  const sum = [done ? `${done} done` : '', notMerged ? `${notMerged} not merged` : '', earlier ? `${earlier} from an earlier run` : '',
    over ? `${over} more working with no room on the board` : ''].filter(Boolean).join(', ');
  return { lead, rest, text: lead + rest, sum, aria: `${sum}. Show them.`, short: { lead, rest: after('more') } };
}
