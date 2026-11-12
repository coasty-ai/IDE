// The git screen's commit graph, laid out like the board: your branch is the trunk, a thick gold bus, and every other
// line of work is a copper trace on its own lane, placed outward and alternating right and left, so the tree branches
// downwards and spreads out. A trace changes lanes with short 45° bends, never at any other angle, and no two traces
// ever run on top of each other, except where they meet at one commit.
// Pure: no DOM is touched when this module loads, and nothing comes from /shared/ (state sets are passed in), so
// node:test checks it. Everything an agent or a repository controls (subjects, authors, branch names) comes out as
// visible text: hidden and direction-changing characters are shown as symbols (diffview.js).
import { agoText } from './boardmodel.js';
import { plainWords } from './prefs.js';
import { visibleText } from './diffview.js';

/** Newest commits at the top, where the wire from the board arrives at your branch's tip. Flip it here. */
export const NEWEST_AT_TOP = true;

// Row heights hold two lines of text (subject, then who · when · short id); lane pitch is 56 to 112 px.
export const GRAPH_SIZES = Object.freeze({
  S: { name: 'S', rowH: 42, padTop: 22, padBottom: 28, margin: 22, bend: 12, pitchMin: 56, pitchMax: 112, r: 5, headR: 8, mergeR: 6.5, workR: 7, chipW: 16, chipH: 11 },
  M: { name: 'M', rowH: 44, padTop: 24, padBottom: 30, margin: 24, bend: 13, pitchMin: 56, pitchMax: 112, r: 5, headR: 8.5, mergeR: 7, workR: 7.5, chipW: 17, chipH: 11.5 },
  L: { name: 'L', rowH: 48, padTop: 26, padBottom: 32, margin: 26, bend: 14, pitchMin: 56, pitchMax: 112, r: 5.5, headR: 9, mergeR: 7.5, workR: 8, chipW: 18, chipH: 12 },
});

// The room the HEAD silkscreen takes left of its pad: gitscreen.js sets it 5 px off the pad in 10.5 px type (app.css),
// 30 px wide in Chrome, and a little more so it never touches the graph's edge.
const HEAD_SILK = 37;

const ACTIVE_DEFAULT = new Set(['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']);
const r1 = n => Math.round(n * 10) / 10;

/** The first 7 characters of a commit id. */
export const shortId = id => (typeof id === 'string' ? id.slice(0, 7) : '');

/**
 * A long name cut in the middle to at most `max` characters ("release/…refunds"), so both ends stay readable; the whole
 * goes in a title. The same cut as the lid's (words.js), so a branch reads the same on both screens.
 */
export function cutMiddle(s, max = 24) {
  const t = Array.from(String(s ?? ''));
  if (t.length <= max) return t.join('');
  const keep = Math.max(1, max - 1), head = Math.ceil(keep / 2);
  return t.slice(0, head).join('') + '…' + t.slice(t.length - (keep - head)).join('');
}

/** A lane's place: 0 is the trunk, then right 1, left 1, right 2, left 2, … */
export const slotOf = i => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -(i / 2));

/**
 * The words the page answers itself on the way to or from the git screen. Whole utterances only, like the looks:
 * "git", "show git", "open git", "source control", "show the graph" open it; "board" and "back" come back (the page
 * acts on those only while the git screen shows). Never sent to the engine.
 * @returns {'open'|'back'|null}
 */
const OPEN_WORDS = new Set(['git', 'show git', 'open git', 'source control', 'show source control', 'open source control', 'show the graph',
  'the graph', 'show git graph', 'show the git graph', 'the git graph', 'show the git screen', 'open the git screen', 'the git screen', 'git screen']);
const BACK_WORDS = new Set(['board', 'back', 'the board', 'go back', 'back to the board', 'show the board', 'go to the board']);
export function gitScreenWords(text) {
  const t = plainWords(text);
  if (!t || t.length > 40) return null;
  if (OPEN_WORDS.has(t)) return 'open';
  if (BACK_WORDS.has(t)) return 'back';
  return null;
}

/**
 * An agent's unmerged work, as its work node says it: "working" while it is active, else "not merged yet · 3 files"
 * (no count when nothing recorded one: a stopped, failed or earlier agent). Null when there is nothing to show: no
 * branch, its folder gone, thrown away, or merged with nothing new.
 */
export function workNodeOf(a, ACTIVE = ACTIVE_DEFAULT) {
  const w = a && a.work;
  if (!w || w.thrownAway || !w.branch || w.folder === false) return null;
  if (ACTIVE.has(a.state)) return { label: 'working', count: null, active: true };
  const n = a.files && Number.isFinite(a.files.changed) ? a.files.changed : null;
  if (n === 0) return null;
  if (n == null && !(a.earlier || a.state === 'stopped' || a.state === 'failed')) return null;
  return { label: n ? `not merged yet · ${n} file${n === 1 ? '' : 's'}` : 'not merged yet', count: n, active: false };
}

/**
 * Which of the detail's two actions apply to an agent now, by the lid's own rules (builder D2's mergeApplies and
 * discardApplies in model.js; the git screen uses those when they are there, and this only when they are not):
 * Merge: live mode, a root at rest with its branch and folder, not thrown away, your folder on a branch with a name and
 * email git knows (unknown counts as known: the engine checks again), and work not merged yet (files changed, or files
 * unknown for a stopped, failed or earlier agent). Throw it away: live mode and a root with its branch and folder (an
 * active one is stopped first; the engine says so in its card).
 */
export function workActions(a, { mode = null, repo = null, ACTIVE = ACTIVE_DEFAULT } = {}) {
  const w = a && a.work;
  const reviewable = !!(w && !a.parentId && w.branch && w.folder && !w.thrownAway);
  if (mode !== 'live' || !reviewable) return { merge: false, discard: false };
  const unmerged = a.files ? (Number(a.files.changed) || 0) > 0 : (a.state === 'stopped' || a.state === 'failed' || !!a.earlier);
  const merge = !ACTIVE.has(a.state) && !!(repo && repo.branch) && repo.identity !== false && unmerged;
  return { merge, discard: true };
}

/** "Merge into main", with a branch past 16 characters cut in the middle, as the lid does (all of it in the title). */
export const mergeLabel = branch => `Merge into ${cutMiddle(visibleText(branch), 16)}`;

const msOf = at => (Number.isFinite(at) ? (at < 1e12 ? at * 1000 : at) : null);

/**
 * The words of one row, before they are fitted to the text column: the subject, then "who · when · short id".
 * @returns {{ line1: string, line2: string, badges: { text: string, kind: 'yours'|'agent'|'other', agentId?: string, title: string }[], aria: string }}
 */
export function rowWords(item, { agentById = new Map(), now = Date.now(), branch = null } = {}) {
  const nameOf = a => visibleText(String(a && a.name || '').trim()) || 'Agent';
  if (item.kind === 'work') {
    const name = nameOf(item.agent);
    return { line1: name, line2: item.work.label, badges: [], aria: `${name}: ${item.work.label}.${item.loose ? ' Its branch starts in older commits, not shown here.' : ''}` };
  }
  const c = item.commit || {};
  const agent = c.agentId ? agentById.get(c.agentId) : null;
  const who = agent ? nameOf(agent) : (visibleText(String(c.author || '').trim()) || 'someone');
  const at = msOf(c.at);
  const when = at == null ? '' : agoText(now - at);
  const subject = visibleText(String(c.subject || '').trim()) || '(no description)';
  const badges = [];
  for (const ref of c.refs || []) {
    const ag = [...agentById.values()].find(x => (x.work?.branch || x.branch) === ref);
    const shown = visibleText(ref);
    if (ref === branch) badges.push({ text: shown, kind: 'yours', title: `Your branch ${shown}` });
    else if (ag) badges.push({ text: nameOf(ag), kind: 'agent', agentId: ag.id, title: `${nameOf(ag)}’s branch ${shown}` });
    else badges.push({ text: shown, kind: 'other', title: `The branch ${shown}` });
  }
  const line2 = [who, when, shortId(c.id)].filter(Boolean).join(' · ');
  const refs = badges.length ? ` On ${badges.map(b => (b.kind === 'yours' ? `your branch ${b.text}` : b.kind === 'agent' ? `${b.text}’s branch` : `the branch ${b.text}`)).join(' and ')}.` : '';
  return { line1: subject, line2, badges, aria: `${subject}. ${[who, when].filter(Boolean).join(', ')}${c.id ? `, ${shortId(c.id)}` : ''}.${refs}` };
}

/**
 * Lay out the graph.
 * @param {object} input
 * @param {object[]} input.commits  newest first, in topological order: { id, parents, subject, author, at, refs, agentId, kind }
 * @param {object[]} input.agents   every root with a branch: { id, name, state, earlier, branch, from, base, since, files, work }
 * @param {string|null} input.branch  your branch (null when your folder is not on one)
 * @param {string|null} input.head    your HEAD commit
 * @param {number} input.width       the most the graph may take (CSS px); the text column starts after `w`
 * @param {Set<string>} [input.ACTIVE]
 * @param {object} [P]               GRAPH_SIZES.S|M|L
 * @returns {{ rows, lanes, nodes, edges, folds, trunkX, rowH, pitch, w, h, headRow }}
 */
export function graphLayout({ commits = [], agents = [], branch = null, head = null, width = 480, height = 600, ACTIVE = ACTIVE_DEFAULT } = {}, P = GRAPH_SIZES.M) {
  void height;
  // 1. the commits, cleaned: every id once, parents and refs as lists of strings
  const list = [], seen = new Set();
  for (const c of Array.isArray(commits) ? commits : []) {
    if (!c || typeof c.id !== 'string' || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    list.push({ ...c, parents: Array.isArray(c.parents) ? c.parents.filter(p => typeof p === 'string' && p) : [], refs: Array.isArray(c.refs) ? c.refs.filter(x => typeof x === 'string' && x) : [] });
  }
  const byId = new Map(list.map(c => [c.id, c]));
  // 2. the trunk: your branch's first-parent chain from HEAD
  const trunk = new Set();
  for (let id = head; typeof id === 'string' && byId.has(id) && !trunk.has(id); id = byId.get(id).parents[0]) trunk.add(id);
  // 3. agents, their branch tips, and a work node above each tip that holds unmerged work
  const roots = (Array.isArray(agents) ? agents : []).filter(a => a && typeof a.id === 'string');
  const agentById = new Map(roots.map(a => [a.id, a]));
  const branchOf = a => a.branch || a.work?.branch || null;
  const byBranch = new Map();
  for (const a of roots) { const b = branchOf(a); if (b && !byBranch.has(b)) byBranch.set(b, a); }
  const tipOf = new Map();
  for (const c of list) for (const ref of c.refs) { const a = byBranch.get(ref); if (a && !tipOf.has(a.id)) tipOf.set(a.id, c.id); }
  const before = new Map(), loose = [];
  for (const a of roots) {
    const wn = workNodeOf(a, ACTIVE);
    if (!wn) continue;
    const tip = tipOf.get(a.id) || [a.since, a.base].find(x => typeof x === 'string' && byId.has(x)) || null;
    const item = { kind: 'work', id: 'work:' + a.id, agentId: a.id, agent: a, work: wn, parents: tip ? [tip] : [] };
    if (tip) { if (!before.has(tip)) before.set(tip, []); before.get(tip).push(item); } else { item.loose = true; loose.push(item); }
  }
  const items = [];
  for (const c of list) {
    items.push(...(before.get(c.id) || []));
    items.push({ kind: 'commit', id: c.id, commit: c, agentId: c.agentId || null, agent: c.agentId ? agentById.get(c.agentId) || null : null, parents: c.parents });
  }
  // A line of work whose branch starts further back than the commits shown (git listed it past the limit) goes at the
  // end, just above "Older commits are not shown here", the newest first, with a stub pointing down into the history not
  // shown. It is never drawn above HEAD as if it were the newest, and takes no lane ahead of the agents working now.
  const startedAt = it => (Number.isFinite(it.agent.startedAt) ? it.agent.startedAt : -Infinity);
  items.push(...loose.map((it, i) => [it, i]).sort((a, b) => startedAt(b[0]) - startedAt(a[0]) || a[1] - b[1]).map(([it]) => it));
  items.forEach((it, i) => { it.row = i; });
  const rowOf = new Map(items.map(it => [it.id, it.row]));

  // 4. chains: the trunk, then each line of work (a branch's run of commits, or a work node and its commits)
  const TRUNK = { trunk: true, items: [], slot: 0 };
  const chains = [];
  const chainOf = new Map();
  const pending = new Map();      // commit id -> the chain that continues through it
  const mergeFrom = new Map();    // commit id -> the merge above that brings it in (its first such merge)
  for (const it of items) {
    let ch;
    if (it.kind === 'commit' && trunk.has(it.id)) ch = TRUNK;
    else {
      ch = it.kind === 'commit' ? pending.get(it.id) : null;
      if (ch) pending.delete(it.id);
      else { ch = { items: [], end: null, topFrom: it.kind === 'commit' ? mergeFrom.get(it.id) || null : null, agentId: null }; chains.push(ch); }
    }
    ch.items.push(it);
    chainOf.set(it.id, ch);
    if (ch !== TRUNK && !ch.agentId && it.agentId) ch.agentId = it.agentId;
    const [fp, ...more] = it.parents;
    if (ch !== TRUNK) {
      const below = fp && rowOf.has(fp) && rowOf.get(fp) > it.row;
      if (below && !trunk.has(fp) && !pending.has(fp) && !chainOf.has(fp)) pending.set(fp, ch);
      else ch.end = { from: it, to: below ? fp : null, dangling: (!!fp && !below) || !!it.loose };
    }
    for (const p of more) if (rowOf.has(p) && rowOf.get(p) > it.row && !mergeFrom.has(p)) mergeFrom.set(p, it);
  }
  for (const ch of chains) {
    ch.top = ch.topFrom ? ch.topFrom.row : ch.items[0].row;
    ch.bottom = ch.end && ch.end.to ? rowOf.get(ch.end.to) : ch.items[ch.items.length - 1].row + (ch.end && ch.end.dangling ? 1 : 0);
  }

  // 5. lanes: shortest lines of work nearest the trunk, so nested ones never cross; right and left in turn. A line that
  // leaves from or joins another line of work is placed after that line, so it knows which side that line is on: it keeps
  // to that side rather than cross your trunk, and of the free lanes it takes the one where it crosses the fewest lines.
  const usable = Math.max(1, Math.floor((width - 2 * P.margin - 2 * P.headR) / P.pitchMin));
  const perSide = Math.max(1, Math.floor(usable / 2));
  const order = [];
  for (let k = 1; k <= perSide; k++) order.push(k, -k);
  const inSlot = new Map(order.map(s => [s, []]));
  const xOfChain = ch => (ch === TRUNK ? 0 : ch.slot);
  const overlaps = (a, b) => a.top <= b.bottom && b.top <= a.bottom;
  // the level runs a chain puts down: out from the merge that brings it in, and in to where it joins
  const runsOf = (ch, s) => {
    const out = [];
    if (ch.topFrom) { const f = chainOf.get(ch.topFrom.id); if (f && (f === TRUNK || f.slot != null)) out.push({ row: ch.topFrom.row, a: xOfChain(f), b: s }); }
    if (ch.end && ch.end.to) { const t = chainOf.get(ch.end.to); if (t && (t === TRUNK || t.slot != null)) out.push({ row: rowOf.get(ch.end.to), a: s, b: xOfChain(t) }); }
    return out;
  };
  // your trunk runs from the top (the wire comes down to HEAD) to its last commit: a level run over it counts double
  const trunkEnd = TRUNK.items.length ? TRUNK.items[TRUNK.items.length - 1].row : -1;
  const crossings = (ch, s) => {
    let n = 0;
    for (const run of runsOf(ch, s)) if (Math.min(run.a, run.b) < 0 && 0 < Math.max(run.a, run.b) && run.row <= trunkEnd) n += 2;
    for (const [t, list2] of inSlot) for (const o of list2) {
      if (o === ch) continue;
      for (const run of runsOf(ch, s)) if (Math.min(run.a, run.b) < t && t < Math.max(run.a, run.b) && o.top < run.row && run.row < o.bottom) n++;
      for (const run of runsOf(o, t)) if (Math.min(run.a, run.b) < s && s < Math.max(run.a, run.b) && ch.top < run.row && run.row < ch.bottom) n++;
    }
    return n;
  };
  const folds = { 1: 0, [-1]: 0 };
  const byLength = [...chains].sort((a, b) => (a.bottom - a.top) - (b.bottom - b.top) || a.top - b.top);
  // the lines a line of work leaves from or joins (not your trunk), placed before it
  const needs = ch => [ch.topFrom && chainOf.get(ch.topFrom.id), ch.end && ch.end.to && chainOf.get(ch.end.to)].filter(o => o && o !== TRUNK && o !== ch);
  const sorted = [], seenCh = new Set();
  const visit = ch => { if (seenCh.has(ch)) return; seenCh.add(ch); for (const o of needs(ch)) visit(o); sorted.push(ch); };
  for (const ch of byLength) visit(ch);
  for (const ch of sorted) {
    const free = order.filter(s => !inSlot.get(s).some(o => overlaps(o, ch)));
    let s = null, best = Infinity;
    for (const x of free) { const c = crossings(ch, x); if (c < best) { best = c; s = x; } if (!c) break; }
    if (s == null) {
      // past what the width allows: onto the outermost lane of the side with fewer folded, with a "+N" marker
      const side = folds[1] <= folds[-1] ? 1 : -1;
      s = side * perSide;
      folds[side]++;
      ch.folded = true;
    }
    ch.slot = s;
    inSlot.get(s).push(ch);
  }

  // 6. geometry: the pitch the width allows, the trunk where the left lanes leave room for it, or, with no lane on its
  // left, where the HEAD silkscreen beside its pad still has room
  const kR = Math.max(0, ...chains.map(c => (c.slot > 0 ? c.slot : 0)));
  const kL = Math.max(0, ...chains.map(c => (c.slot < 0 ? -c.slot : 0)));
  const lead = Math.max(P.margin + P.headR, kL || !rowOf.has(head) ? 0 : P.headR + HEAD_SILK);
  const room = width - lead - P.headR - P.margin;
  const pitch = kR + kL ? Math.max(P.pitchMin, Math.min(P.pitchMax, Math.floor(room / (kR + kL)), Math.round(width / 7))) : P.pitchMax;
  const trunkX = r1(lead + kL * pitch);
  const xOf = slot => r1(trunkX + slot * pitch);
  const n = items.length;
  const rowH = P.rowH;
  const h = Math.ceil(P.padTop + n * rowH + P.padBottom);
  const w = Math.ceil(trunkX + kR * pitch + P.headR + P.margin);
  const yOf = row => r1(P.padTop + row * rowH + rowH / 2);

  // 7. nodes
  const headItem = items.find(it => it.kind === 'commit' && it.id === head) || null;
  const nodes = items.map(it => {
    const ch = chainOf.get(it.id);
    const slot = ch === TRUNK ? 0 : ch.slot;
    const c = it.commit;
    let kind;
    if (it.kind === 'work') kind = 'work';
    else if (it === headItem) kind = 'head';
    else if (c.parents.length > 1) kind = 'merge';
    else if (c.agentId && ch !== TRUNK) kind = 'chip';
    else kind = 'via';
    const size = kind === 'head' ? P.headR : kind === 'merge' ? P.mergeR : kind === 'work' ? P.workR : kind === 'chip' ? P.chipW / 2 : P.r;
    return { id: it.id, row: it.row, kind, slot, x: xOf(slot), y: yOf(it.row), size, agentId: it.agentId || null, trunk: ch === TRUNK, item: it };
  });
  const nodeById = new Map(nodes.map(nd => [nd.id, nd]));
  const half = nd => (nd.kind === 'chip' ? P.chipW / 2 : nd.size) + 1;

  // 8. edges: the trunk's gold bus, each lane's copper, the bends where lines of work leave and join
  const edges = [];
  const B = P.bend;
  const tr = TRUNK.items;
  for (let i = 1; i < tr.length; i++) {
    const a = nodeById.get(tr[i - 1].id), b = nodeById.get(tr[i].id);
    edges.push({ kind: 'trunk', from: a.id, to: b.id, pts: [[a.x, a.y], [b.x, b.y]] });
  }
  if (tr.length) {
    const last = tr[tr.length - 1];
    const fp = last.parents[0];
    if (fp && !rowOf.has(fp)) {
      // on into the history not shown, past any line of work that starts back there
      const a = nodeById.get(last.id), endRow = Math.max(last.row, ...loose.map(it => it.row));
      edges.push({ kind: 'trunk', stub: true, from: a.id, pts: [[a.x, a.y], [a.x, r1(yOf(endRow) + rowH * 0.7)]] });
    }
  }
  // in to a node from a lane: down the lane, a 45° bend, then level into the node's side
  const joinPts = (from, to) => {
    if (from.x === to.x) return [[from.x, from.y], [to.x, to.y]];
    const s = Math.sign(to.x - from.x), d = Math.max(2, Math.min(B, to.y - from.y - from.size - 2));
    return [[from.x, from.y], [from.x, r1(to.y - d)], [r1(from.x + s * d), to.y], [r1(to.x - s * half(to)), to.y]];
  };
  // out of a node to a lane: level out of the node's side, a 45° bend, then down the lane
  const outPts = (from, to) => {
    if (from.x === to.x) return [[from.x, from.y], [to.x, to.y]];
    const s = Math.sign(to.x - from.x), d = Math.max(2, Math.min(B, to.y - from.y - to.size - 2));
    return [[r1(from.x + s * half(from)), from.y], [r1(to.x - s * d), from.y], [to.x, r1(from.y + d)], [to.x, to.y]];
  };
  // Anything else between two lanes (a merge's second parent) runs down the gutter beside the target's lane: in its middle,
  // or a few px to one side where another such line already runs down that gutter at the same height, so two merges'
  // lines never share a stretch and each can be followed to the commit it took. Of the places that are free, the one
  // that crosses the fewest of those lines; the bends get shorter where the gutter is narrow, and stay at 45°.
  // (between two commits on one lane, with others in between, it steps out to the gutter beside it and back)
  const gutterPts = (from, to, xg) => {
    const s = Math.sign(xg - from.x) || 1, back = from.x === to.x ? -1 : 1;
    const room = Math.min(s * (xg - from.x) - half(from), back * s * (to.x - xg) - half(to)) - 1;
    const d = Math.max(2, Math.min(B, Math.abs(to.y - from.y) / 3, room));
    return [[r1(from.x + s * half(from)), from.y], [r1(xg - s * d), from.y], [xg, r1(from.y + d)], [xg, r1(to.y - d)], [r1(xg + back * s * d), to.y], [r1(to.x - back * s * half(to)), to.y]];
  };
  const gutters = [];   // the cross lines placed so far, with their upright stretch in a gutter
  const crossCount = pts => {
    let c = 0;
    for (const g2 of gutters) for (let i = 1; i < pts.length; i++) for (let j = 1; j < g2.pts.length; j++) if (segsCross(pts[i - 1], pts[i], g2.pts[j - 1], g2.pts[j])) c++;
    return c;
  };
  const crossRoute = (from, to) => {
    // towards the target's lane; between two commits on one lane, into the gutter on the trunk's side of it
    const slot = Math.round((to.x - trunkX) / pitch);
    const s = Math.sign(to.x - from.x) || (slot > 0 ? -1 : 1), mid = from.x === to.x ? to.x + s * pitch / 2 : to.x - s * pitch / 2;
    // the gutter's usable width: clear of the target's lane and of the next lane's nodes, with room for a short bend
    const nearT = P.headR + 4, nearF = pitch - P.headR - 4;
    let best = null;
    for (const step of [6, 3]) {
      const offs = [0];
      for (let k = 1; k * step <= pitch / 2; k++) offs.push(k * step, -k * step);
      for (const o of offs) {
        const xg = r1(mid - s * o), fromT = Math.abs(to.x - xg);
        if (fromT < nearT || fromT > nearF || s * (xg - from.x) < half(from) + 3 || xg < 1 || xg > w - 1) continue;
        const pts = gutterPts(from, to, xg), y0 = pts[2][1], y1 = pts[3][1];
        const clash = gutters.some(g2 => Math.abs(g2.x - xg) < 2.5 && Math.min(y1, g2.y1) - Math.max(y0, g2.y0) > 0.5);
        const cost = (clash ? 1e6 : 0) + crossCount(pts) * 100 + Math.abs(o);
        if (!best || cost < best.cost) best = { cost, pts, xg, y0, y1 };
      }
      if (best && best.cost < 1e6) break;
    }
    if (!best) { const pts = gutterPts(from, to, r1(mid)); best = { pts, xg: r1(mid), y0: pts[2][1], y1: pts[3][1] }; }
    gutters.push({ x: best.xg, y0: best.y0, y1: best.y1, pts: best.pts });
    return best.pts;
  };
  for (const ch of chains) {
    const agentId = ch.agentId || null, folded = ch.folded ? { folded: true } : {};
    const its = ch.items.map(it => nodeById.get(it.id));
    if (ch.topFrom) edges.push({ kind: 'out', agentId, from: ch.topFrom.id, to: its[0].id, ...folded, pts: outPts(nodeById.get(ch.topFrom.id), its[0]) });
    for (let i = 1; i < its.length; i++) edges.push({ kind: 'lane', agentId, from: its[i - 1].id, to: its[i].id, ...folded, pts: [[its[i - 1].x, its[i - 1].y], [its[i].x, its[i].y]] });
    const last = its[its.length - 1];
    if (ch.end && ch.end.to) edges.push({ kind: 'join', agentId, from: last.id, to: ch.end.to, ...folded, pts: joinPts(last, nodeById.get(ch.end.to)) });
    else if (ch.end && ch.end.dangling) edges.push({ kind: 'lane', agentId, stub: true, from: last.id, ...folded, pts: [[last.x, last.y], [last.x, r1(last.y + rowH * 0.7)]] });
  }
  for (const it of items) {
    for (const p of it.parents.slice(1)) {
      if (!rowOf.has(p) || rowOf.get(p) <= it.row) continue;
      const ch = chainOf.get(p);
      if (ch !== TRUNK && ch.topFrom === it && ch.items[0].id === p) continue;   // drawn as that chain's way out
      const from = nodeById.get(it.id), to = nodeById.get(p);
      // straight down its own lane only when no other commit sits on that lane in between
      const straight = from.x === to.x && !nodes.some(nd => nd.x === from.x && nd.row > from.row && nd.row < to.row);
      edges.push({ kind: 'cross', agentId: ch === TRUNK ? null : ch.agentId, from: it.id, to: p, ...(ch !== TRUNK && ch.folded ? { folded: true } : {}),
        pts: straight ? [[from.x, from.y], [to.x, to.y]] : crossRoute(from, to) });
    }
  }
  // the wire from the board arrives at HEAD from above, down the trunk's line
  const headNode = headItem ? nodeById.get(headItem.id) : null;
  if (headNode) edges.push({ kind: 'wire', pts: [[headNode.x, 0], [headNode.x, r1(headNode.y - headNode.size - 1)]] });

  // 9. lanes and "+N" markers
  const lanes = [{ slot: 0, x: trunkX, trunk: true, chains: TRUNK.items.length ? 1 : 0 }];
  for (const s of order) {
    const on = inSlot.get(s);
    if (!on.length) continue;
    lanes.push({ slot: s, x: xOf(s), trunk: false, chains: on.length, folded: on.filter(c => c.folded).length });
  }
  const foldMarks = [];
  for (const side of [1, -1]) {
    if (!folds[side]) continue;
    const first = sorted.filter(c => c.folded && Math.sign(c.slot) === side).sort((a, b) => a.top - b.top)[0];
    foldMarks.push({ side, n: folds[side], x: xOf(side * perSide), y: r1(yOf(first.top) - rowH / 2 + 2), slot: side * perSide });
  }
  const rows = items.map(it => ({ row: it.row, y: yOf(it.row), item: it, node: nodeById.get(it.id) }));
  const out = { rows, lanes, nodes, edges, folds: foldMarks, trunkX, rowH, pitch, w, h, headRow: headItem ? headItem.row : -1, perSide, agentById };
  return NEWEST_AT_TOP ? out : flip(out);
}

/** Oldest at the top instead: the same drawing, mirrored top to bottom (bends stay at 45°). */
function flip(g) {
  const fy = y => r1(g.h - y);
  for (const r of g.rows) r.y = fy(r.y);
  for (const nd of g.nodes) nd.y = fy(nd.y);
  for (const e of g.edges) e.pts = e.pts.map(([x, y]) => [x, fy(y)]);
  for (const f of g.folds) f.y = fy(f.y) - 14;
  return g;
}

/** Do two segments cross at a point inside both (not where they meet end to end, and not along a shared stretch)? */
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Stretches two edges draw on top of each other for longer than `min` px (the same level, upright or 45° line), other
 * than two lines meeting at one commit side by side (into it, or out of it), and lines folded into one lane on purpose
 * ("+N"): for checks. Each is { a, b, len } with the two edges.
 */
export function sharedRuns(g, min = 13) {
  const segs = [];
  g.edges.forEach((e, k) => {
    if (e.folded) return;
    for (let i = 1; i < e.pts.length; i++) {
      const [p, q] = [e.pts[i - 1], e.pts[i]], dx = q[0] - p[0], dy = q[1] - p[1];
      const base = { k, e, at: [i === 1 ? e.from : null, i === e.pts.length - 1 ? e.to : null].filter(Boolean) };
      if (Math.abs(dx) < 0.15) segs.push({ ...base, dir: 'v', key: p[0], lo: Math.min(p[1], q[1]), hi: Math.max(p[1], q[1]), f: 1 });
      else if (Math.abs(dy) < 0.15) segs.push({ ...base, dir: 'h', key: p[1], lo: Math.min(p[0], q[0]), hi: Math.max(p[0], q[0]), f: 1 });
      else { const down = Math.sign(dx) === Math.sign(dy); segs.push({ ...base, dir: down ? 'd' : 'u', key: down ? p[1] - p[0] : p[1] + p[0], lo: Math.min(p[0], q[0]), hi: Math.max(p[0], q[0]), f: Math.SQRT2 }); }
    }
  });
  const out = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.k === t.k || s.dir !== t.dir || Math.abs(s.key - t.key) > 0.6) continue;
    const len = (Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo)) * s.f;
    if (len > min && !s.at.some(x => t.at.includes(x))) out.push({ a: s.e, b: t.e, len: Math.round(len) });
  }
  return out;
}

/** Every segment of every edge is level, upright or at 45°: for checks. */
export function bendsOk(g) {
  for (const e of g.edges) for (let i = 1; i < e.pts.length; i++) {
    const dx = Math.abs(e.pts[i][0] - e.pts[i - 1][0]), dy = Math.abs(e.pts[i][1] - e.pts[i - 1][1]);
    if (!(dx < 0.15 || dy < 0.15 || Math.abs(dx - dy) < 0.25)) return false;
  }
  return true;
}
