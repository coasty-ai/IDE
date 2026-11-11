// Client-side state and the orderings the screen is built from.
import { PRIORITY, NEEDS_YOU, DONE, ACTIVE } from '/shared/states.mjs';

export const S = {
  agents: new Map(),     // id -> AgentView
  machines: [],
  meta: { mode: null, repo: null, harnesses: {}, defaultBudgetUsd: null },
  focusId: null,         // set when the person picks an agent; null = follow the queue
  confirm: null,         // a pending "Do it / Cancel" from a typed or spoken command
  hoverId: null,         // tree row under the pointer
  pinId: null,           // card pinned by a click
  collapsed: new Set(),  // roots whose helpers are hidden
  expanded: new Set(),   // roots showing all their finished helpers
  reviewed: new Set(),   // finished roots the person has already looked at
  reply: null,           // { agentId, mode: 'answer'|'say', askId, label }
  connected: false,
};

try { for (const id of JSON.parse(sessionStorage.getItem('wb-reviewed') || '[]')) S.reviewed.add(id); } catch {}
export function markReviewed(id) {
  S.reviewed.add(id);
  try { sessionStorage.setItem('wb-reviewed', JSON.stringify([...S.reviewed].slice(-200))); } catch {}
}

export function upsert(list) {
  for (const a of list) if (a && a.id) S.agents.set(a.id, a);
}

const prio = a => PRIORITY[a.state] ?? 9;

/** Does this root, or any agent below it, need the person? */
export function treeNeedsYou(root) {
  if (NEEDS_YOU.has(root.state)) return true;
  for (const a of S.agents.values()) if (a.rootId === root.id && a.id !== root.id && NEEDS_YOU.has(a.state)) return true;
  return false;
}

export function rootsInGroups() {
  const roots = [...S.agents.values()].filter(a => !a.parentId);
  const effective = r => (treeNeedsYou(r) ? Math.min(prio(r), 0.5) : prio(r));
  roots.sort((a, b) => effective(a) - effective(b) || b.startedAt - a.startedAt);
  const groups = [
    { key: 'needs', label: 'Needs you', items: [] },
    { key: 'working', label: 'Working', items: [] },
    { key: 'done', label: 'Done', items: [] },
    { key: 'ended', label: 'Stopped', items: [] },
  ];
  for (const r of roots) {
    if (treeNeedsYou(r)) groups[0].items.push(r);
    else if (ACTIVE.has(r.state)) groups[1].items.push(r);
    else if (DONE.has(r.state)) groups[2].items.push(r);
    else groups[3].items.push(r);
  }
  return groups.filter(g => g.items.length);
}

export function childrenOf(id) {
  return [...S.agents.values()].filter(a => a.parentId === id).sort((a, b) => a.startedAt - b.startedAt);
}

/** Things waiting on the person, most urgent first: asks and stuck agents, roots or helpers. */
export function needsQueue() {
  return [...S.agents.values()]
    .filter(a => NEEDS_YOU.has(a.state))
    .sort((a, b) => prio(a) - prio(b) || (a.ask?.createdAt || a.stateSince) - (b.ask?.createdAt || b.stateSince));
}

/** Finished roots the person has not looked at yet, newest first. */
export function reviewQueue() {
  return [...S.agents.values()]
    .filter(a => !a.parentId && (a.state === 'done_checked' || a.state === 'done_claimed' || a.state === 'failed') && !S.reviewed.has(a.id))
    .sort((a, b) => (b.endedAt || b.stateSince) - (a.endedAt || a.stateSince));
}

/** What the centre shows: a pending confirm, the picked agent, the next thing that needs you, or nothing. */
export function currentFocus() {
  if (S.confirm) return { confirm: S.confirm };
  if (S.focusId && S.agents.has(S.focusId)) return { agent: S.agents.get(S.focusId), picked: true };
  const q = needsQueue();
  if (q.length) return { agent: q[0], index: 0, total: q.length };
  const r = reviewQueue();
  if (r.length) return { agent: r[0], review: true };
  return { empty: true };
}

export function machineName(id) {
  const m = S.machines.find(x => x.id === id);
  return m ? m.name : (id === 'laptop' ? 'Your laptop' : id);
}

export function spendToday() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let sum = 0, any = false;
  for (const a of S.agents.values()) {
    if (a.parentId || a.startedAt < midnight.getTime()) continue;
    if (a.usage && a.usage.costUsd != null) { sum += a.usage.costUsd; any = true; }
  }
  return any ? sum : 0;
}

export function harnessLabel(h) {
  return h === 'claude' ? 'Claude' : h === 'codex' ? 'Codex' : h === 'sim' ? 'Simulated' : h || '';
}
