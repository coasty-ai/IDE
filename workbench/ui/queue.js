// What needs the person, in order, and what is waiting to be looked at. Pure: no DOM and no imports, so node:test can
// load it; the state sets (NEEDS_YOU, PRIORITY, ACTIVE, ENDED from /shared/states.mjs) are passed in.

/** One finish of one agent: a mark ("looked at", "set aside") made on it does not outlive that finish. */
export const finishKey = a => `${a.id}@${a.endedAt ?? a.stateSince ?? 0}`;

/**
 * Is this agent or helper waiting on the person right now? A failed check the person set aside ("Look later") is not,
 * until that agent finishes again.
 * @param {object} a  an AgentView
 * @param {{ NEEDS_YOU: Set<string>, later?: Set<string> }} ctx
 */
export function needsPerson(a, { NEEDS_YOU, later }) {
  if (!a || !NEEDS_YOU.has(a.state)) return false;
  return !(a.state === 'checks_failed' && later && later.has(finishKey(a)));
}

/** Things waiting on the person, most urgent first: by PRIORITY, then the oldest ask first. */
export function needsQueue(agents, { NEEDS_YOU, PRIORITY, later }) {
  const prio = a => PRIORITY[a.state] ?? 9;
  const since = a => a.ask?.createdAt || a.stateSince || 0;
  return [...agents].filter(a => needsPerson(a, { NEEDS_YOU, later }))
    .sort((a, b) => prio(a) - prio(b) || since(a) - since(b) || String(a.id).localeCompare(String(b.id)));
}

/** Finished roots not looked at yet (in this finish), newest first. */
export function reviewQueue(agents, { reviewed }) {
  return [...agents]
    .filter(a => !a.parentId && (a.state === 'done_checked' || a.state === 'done_claimed' || a.state === 'failed') && !(reviewed && reviewed.has(finishKey(a))))
    .sort((a, b) => (b.endedAt || b.stateSince || 0) - (a.endedAt || a.stateSince || 0));
}

/** Failed checks the person set aside, still unchanged. */
export function setAsideList(agents, { later }) {
  return [...agents].filter(a => a.state === 'checks_failed' && later && later.has(finishKey(a)));
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
