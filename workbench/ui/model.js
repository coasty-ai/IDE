// Client-side state and the orderings the page is built from.
import { PRIORITY, NEEDS_YOU, DONE, ACTIVE, ENDED, LOOK } from '/shared/states.mjs';
import * as Q from './queue.js';
import { spendTodayOf } from './numbers.js';

export const STATES = { PRIORITY, NEEDS_YOU, DONE, ACTIVE, ENDED, LOOK };

export const S = {
  agents: new Map(),     // id -> AgentView
  machines: [],
  meta: { mode: null, repo: null, harnesses: {}, defaultBudgetUsd: null, spendTodayUsd: null },
  loaded: false,         // a snapshot has arrived
  focusId: null,         // set when the person picks an agent or steps the queue; null = follow the queue
  // an engine card on screen: { id, sentence, detail, kind: 'start'|'stop'|'say'|'forget'|'merge'|'discard', yes?, no?,
  // danger? }, plus agentId (the page's own note) when a lid button for that agent asked for it
  confirm: null,
  hoverId: null,         // chip or helper under the pointer or keyboard
  pinId: null,           // card pinned by a click
  reply: null,           // { agentId, mode: 'answer'|'say', askId }
  // Both kept in this tab's sessionStorage, as the page's key is, so a reload that brings the board back brings them back.
  reviewed: Q.readMarks(tab(), 'wb-reviewed'),   // finishKeys the person has looked at ("Looks good", "Not now", "Dismiss"), and problemKeys of merges that did not go through they dismissed: such a root leaves the board
  later: Q.readMarks(tab(), 'wb-later'),         // finishKeys set aside: a failed check, or a merge that did not go through ("Look later")
};

function tab() { try { return sessionStorage; } catch { return null; } }

export const finishKey = Q.finishKey;

/**
 * "Looks good" / "Not now" / "Dismiss": this finish has been looked at. `problem`: it was the "Dismiss" of a merge that
 * did not go through, drawn for that very problem (its data-work, checked against the agent before this), so that
 * problem goes too (Q.problemKey): it leaves the board, and stays off it if the problem clears. A look drawn before the
 * problem came never lets the problem go.
 */
export function markReviewed(a, { problem = false } = {}) {
  S.reviewed.add(finishKey(a));
  const pk = problem ? Q.problemKey(a) : null;
  if (pk) S.reviewed.add(pk);
  Q.keepMarks(tab(), 'wb-reviewed', S.reviewed);
}
/** "Look later" on a failed check, or on a merge that did not go through: not now, for this finish. */
export function setAside(a) { S.later.add(finishKey(a)); Q.keepMarks(tab(), 'wb-later', S.later); }

export function upsert(list) {
  for (const a of list) if (a && a.id) S.agents.set(a.id, a);
}

const ctx = () => ({ NEEDS_YOU, PRIORITY, later: S.later });
export const needsPerson = a => Q.needsPerson(a, ctx());
export const needsQueue = () => Q.needsQueue(S.agents.values(), ctx());
export const reviewQueue = () => Q.reviewQueue(S.agents.values(), { reviewed: S.reviewed, later: S.later });
export const setAsideList = () => Q.setAsideList(S.agents.values(), { later: S.later, reviewed: S.reviewed });

// An agent's work (AgentView.work), against the person's repository as the last snapshot or `repo` event told it. The
// git screen's detail (ui/gitscreen.js) uses the same rules for its Merge and Throw it away.
const workCtx = () => ({ ACTIVE, meta: S.meta });
export const { unmergedWork, workSettled, workKey, canReview } = Q;
/** Settled work that finished again since, unseen (a merged agent asked for a change that brought nothing new): see queue.js. */
export const finishedSinceSettled = a => Q.finishedSinceSettled(a, { reviewed: S.reviewed });
/** Merge into the person's branch is offered: live mode, a root at rest, its folder there, a branch and an identity, unmerged work. */
export const mergeApplies = a => Q.mergeApplies(a, workCtx());
/** Throw it away is offered: live mode, a root whose work was not thrown away, with its branch or its folder still there. */
export const discardApplies = a => Q.discardApplies(a, workCtx());
/** The engine's words for why there is no Merge, when it is about git (not on a branch, no name and email); else null. */
export const gitReason = a => Q.gitReason(a, workCtx());

export function childrenOf(id) {
  return [...S.agents.values()].filter(a => a.parentId === id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}
/** Every helper below a root, need first (the order the board and the card use). */
export function helpersOf(root) {
  return Q.helpersByNeed([...S.agents.values()].filter(a => a.id !== root.id && (a.rootId === root.id || a.parentId === root.id)), { NEEDS_YOU, ENDED });
}
export const helpersAtWork = a => Q.helpersAtWork(childrenOf(a.id), ACTIVE);

/**
 * What the core shows, in this order: a launch question on screen; the agent the person picked or stepped to (with its
 * place in a queue, when it is in one); the most urgent thing that needs the person; finished work not yet looked at;
 * otherwise nothing.
 */
export function currentFocus() {
  if (S.confirm) return { confirm: S.confirm };
  const q = needsQueue();
  if (S.focusId && S.agents.has(S.focusId)) {
    const a = S.agents.get(S.focusId);
    const i = q.findIndex(x => x.id === a.id);
    if (i >= 0) return { agent: a, index: i, total: q.length, picked: true };
    const r = reviewQueue(), j = r.findIndex(x => x.id === a.id);
    if (j >= 0 && !q.length) return { agent: a, review: true, index: j, total: r.length, picked: true };
    return { agent: a, picked: true, queued: q.length };
  }
  if (q.length) return { agent: q[0], index: 0, total: q.length };
  const r = reviewQueue();
  if (r.length) return { agent: r[0], review: true, index: 0, total: r.length };
  return { empty: true, aside: setAsideList() };
}

/** Step through what needs the person (or, when nothing does, what is waiting to be looked at). */
export function stepQueue(dir = 1) {
  const q = needsQueue();
  const list = q.length ? q : reviewQueue();
  if (list.length < 2) return false;
  const shown = currentFocus().agent;
  S.focusId = Q.stepFrom(list, shown ? shown.id : null, dir);
  if (S.focusId === list[0].id) S.focusId = null;    // back at the head: follow the queue again
  return true;
}

export function machineName(id) {
  const m = S.machines.find(x => x.id === id);
  return m ? m.name : (id === 'laptop' ? 'Your laptop' : id);
}

/** Spend today: { usd, estimated }. `estimated` while part of it is Workbench's estimate of cost not reported yet ("about"). */
export function spendToday() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return spendTodayOf(S.agents.values(), midnight.getTime());
}

export function harnessLabel(h) {
  return h === 'claude' ? 'Claude' : h === 'codex' ? 'Codex' : h === 'sim' ? 'Simulated' : h || '';
}
