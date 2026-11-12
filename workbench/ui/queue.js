// What needs the person, in order, and what is waiting to be looked at; and what can be done with an agent's work (merge,
// review, throw away). Pure: no DOM and no imports, so node:test can load it; the state sets (NEEDS_YOU, PRIORITY, ACTIVE,
// ENDED from /shared/states.mjs) and the snapshot's meta are passed in.

/** One finish of one agent: a mark ("looked at", "set aside") made on it does not outlive that finish. */
export const finishKey = a => `${a.id}@${a.endedAt ?? a.stateSince ?? 0}`;

// ---------------------------------------------------------------- an agent's work (AgentView.work)
// work: { branch, from, folder, merged: { into, merge, at, files, adds, dels } | null,
//         problem: { why, sentence, paths, into, at } | null, thrownAway: { at, saved } | null } | null (helpers, no git)

/** Roots that have finished, failed or stopped: nothing runs until the person sends something. */
const AT_REST = new Set(['done_checked', 'done_claimed', 'checks_failed', 'failed', 'stopped']);

/**
 * Work in its folder that is not in the person's branch yet: files changed since its last merge (or since it started),
 * or, when the files are not known, a stopped, failed or earlier agent, which may hold some.
 */
export function unmergedWork(a) {
  const w = a && a.work;
  if (!w || w.thrownAway || !w.folder) return false;
  if (a.files) return (Number(a.files.changed) || 0) > 0;
  return a.state === 'stopped' || a.state === 'failed' || !!a.earlier;
}

/** Its work is settled: thrown away, or merged with nothing new since. Such a root needs no one and is not "to look at". */
export function workSettled(a) {
  const w = a && a.work;
  if (!w || a.parentId) return false;
  return !!w.thrownAway || (!!w.merged && !unmergedWork(a));
}

/**
 * The work's signature: merged, a problem, thrown away, its folder gone, and whether it holds unmerged work. It is part
 * of the lid's key, so an outcome swaps the page (and arms the click guard), and buttons carry it (data-work), so one
 * drawn before an outcome cannot act after it. How many files changed is not part of it: the engine's card says that.
 */
export function workKey(a) {
  const w = a && a.work;
  if (!w || a.parentId) return '';
  const k = [];
  if (w.thrownAway) k.push('t');
  if (w.merged) k.push('m' + (w.merged.merge || w.merged.at || ''));
  if (w.problem) k.push('p' + (w.problem.why || '') + (w.problem.at || ''));
  if (w.folder === false && !w.thrownAway) k.push('g');
  if (unmergedWork(a)) k.push('u');
  return k.join(',');
}

/** Its branch and folder are there to look at (the git screen's diff): a root whose work was not thrown away. */
export function canReview(a) {
  const w = a && a.work;
  return !!(w && !a.parentId && w.branch && w.folder && !w.thrownAway);
}

/**
 * Can the person merge this agent's work into their branch now? Live mode, a root that is not active, its folder still
 * there and not thrown away, the person on a branch with a name and email git knows (unknown counts as known: the engine
 * checks again), and unmerged work.
 * @param {object} a  an AgentView
 * @param {{ ACTIVE: Set<string>, meta: { mode, repo } }} ctx
 */
export function mergeApplies(a, { ACTIVE, meta }) {
  const repo = meta && meta.repo;
  return !!(meta && meta.mode === 'live' && canReview(a) && !ACTIVE.has(a.state) && repo && repo.branch && repo.identity !== false && unmergedWork(a));
}

/**
 * Can its work be thrown away now? Live mode, a root whose work was not thrown away, with its branch or its folder still
 * there (a branch whose folder is gone is still deleted; an active agent is stopped first, and the engine's card says so).
 */
export function discardApplies(a, { meta }) {
  const w = a && a.work;
  return !!(meta && meta.mode === 'live' && w && !a.parentId && !w.thrownAway && (w.branch || w.folder));
}

const DETACHED = 'Your folder is not on a branch, so there is nowhere to merge it.';
const NO_IDENTITY = 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.';

/**
 * Why there is no Merge for work that could otherwise be merged, when the reason is about git: the engine's own words
 * ("Your folder is not on a branch, …", "Git does not know your name and email yet, …"). null otherwise.
 */
export function gitReason(a, { ACTIVE, meta }) {
  const repo = meta && meta.repo;
  if (!meta || meta.mode !== 'live' || !repo || !canReview(a) || ACTIVE.has(a.state) || !unmergedWork(a)) return null;
  if (!repo.branch) return DETACHED;
  if (repo.identity === false) return NO_IDENTITY;
  return null;
}

/**
 * Is this agent or helper waiting on the person right now? A failed check the person set aside ("Look later") is not,
 * until that agent finishes again; nor is one whose work is settled (merged anyway, or thrown away).
 * @param {object} a  an AgentView
 * @param {{ NEEDS_YOU: Set<string>, later?: Set<string> }} ctx
 */
export function needsPerson(a, { NEEDS_YOU, later }) {
  if (!a || a.earlier || !NEEDS_YOU.has(a.state)) return false; // an agent from an earlier run waits on nobody
  if (a.state !== 'checks_failed') return true;
  return !(later && later.has(finishKey(a))) && !workSettled(a);
}

/** Things waiting on the person, most urgent first: by PRIORITY, then the oldest ask first. */
export function needsQueue(agents, { NEEDS_YOU, PRIORITY, later }) {
  const prio = a => PRIORITY[a.state] ?? 9;
  const since = a => a.ask?.createdAt || a.stateSince || 0;
  return [...agents].filter(a => needsPerson(a, { NEEDS_YOU, later }))
    .sort((a, b) => prio(a) - prio(b) || since(a) - since(b) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Finished roots not looked at yet (in this finish), newest first. Not one the person set aside ("Look later", "Not now"
 * on a merge that did not go through), and not one whose work is settled: merged with nothing new, or thrown away.
 */
export function reviewQueue(agents, { reviewed, later }) {
  return [...agents]
    .filter(a => !a.parentId && !a.earlier && (a.state === 'done_checked' || a.state === 'done_claimed' || a.state === 'failed')
      && !(reviewed && reviewed.has(finishKey(a))) && !(later && later.has(finishKey(a))) && !workSettled(a))
    .sort((a, b) => (b.endedAt || b.stateSince || 0) - (a.endedAt || a.stateSince || 0));
}

/** What the person set aside, still unchanged: a failed check, or a finished root whose merge did not go through. */
export function setAsideList(agents, { later }) {
  if (!later) return [];
  return [...agents].filter(a => (a.state === 'checks_failed' || (!a.parentId && !a.earlier && AT_REST.has(a.state))) && later.has(finishKey(a)));
}

/** The id one step from `currentId` in `list`, wrapping round; the first one when `currentId` is not in it. */
export function stepFrom(list, currentId, dir = 1) {
  if (!list.length) return null;
  const i = list.findIndex(a => a.id === currentId);
  if (i < 0) return list[0].id;
  return list[(i + (dir < 0 ? -1 : 1) + list.length) % list.length].id;
}

/**
 * A root's helpers in the order the board draws and the card lists them: whatever needs the person first, then the
 * ones still working, then the most recently ended. Ties keep their start order, so places do not swap.
 */
export function helpersByNeed(kids, { NEEDS_YOU, ENDED }) {
  const rank = k => (NEEDS_YOU.has(k.state) ? 0 : ENDED.has(k.state) ? 2 : 1);
  return [...kids].sort((a, b) => rank(a) - rank(b) ||
    (rank(a) === 2 ? (b.endedAt || b.stateSince || 0) - (a.endedAt || a.stateSince || 0) : (a.startedAt || 0) - (b.startedAt || 0)));
}

/** How many helpers are at work (any active state), the same number everywhere it is shown. */
export function helpersAtWork(kids, ACTIVE) {
  let n = 0;
  for (const k of kids) if (ACTIVE.has(k.state)) n++;
  return n;
}
