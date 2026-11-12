import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { graphLayout, GRAPH_SIZES, NEWEST_AT_TOP, bendsOk, rowWords, workNodeOf, workActions, mergeLabel, gitScreenWords, cutMiddle, shortId, slotOf, sharedRuns } from '../ui/gitgraph.js';
import { palettes, ratio, THEMES } from '../scripts/ui-contrast.mjs';

const U = n => String.fromCodePoint(n);
const id = n => (n.toString(16).padStart(4, '0') + 'b'.repeat(40)).slice(0, 40);
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ACTIVE = new Set(['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']);

// A history like a real one, newest first: M merged Price rounding's work W; Invoice export has two commits off c5 and
// work not merged yet; Help pages is working from HEAD with nothing committed.
function history() {
  const commits = [
    { id: id(1), parents: [id(2), id(20)], subject: 'Merge Price rounding: Round totals once', author: 'Sam', at: NOW - MIN, refs: ['main', 'workbench/help-pages-c'], agentId: 'B', kind: 'merge' },
    { id: id(20), parents: [id(4)], subject: 'Round totals once, at the end', author: 'Sam', at: NOW - 2 * MIN, refs: ['workbench/price-rounding-b'], agentId: 'B', kind: 'work' },
    { id: id(2), parents: [id(3)], subject: 'Fix the README', author: 'Sam', at: NOW - 60 * MIN, refs: [], agentId: null, kind: 'commit' },
    { id: id(10), parents: [id(11)], subject: 'Batch invoices', author: 'Sam', at: NOW - 120 * MIN, refs: ['workbench/invoice-export-a'], agentId: null, kind: 'commit' },
    { id: id(3), parents: [id(4)], subject: 'Add the export page', author: 'Sam', at: NOW - 130 * MIN, refs: [], agentId: null, kind: 'commit' },
    { id: id(11), parents: [id(5)], subject: 'Find the slow query', author: 'Sam', at: NOW - 150 * MIN, refs: [], agentId: null, kind: 'commit' },
    { id: id(4), parents: [id(5)], subject: 'Tidy the tests', author: 'Sam', at: NOW - 160 * MIN, refs: [], agentId: null, kind: 'commit' },
    { id: id(5), parents: [id(6)], subject: 'Start the invoices service', author: 'Sam', at: NOW - 3000 * MIN, refs: [], agentId: null, kind: 'commit' },
    { id: id(6), parents: [], subject: 'Initial commit', author: 'Sam', at: NOW - 6000 * MIN, refs: [], agentId: null, kind: 'commit' },
  ];
  const work = (branch, o = {}) => ({ branch, from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
  const agents = [
    { id: 'A', name: 'Invoice export', state: 'done_checked', branch: 'workbench/invoice-export-a', base: id(5), since: id(5), files: { changed: 3, adds: 40, dels: 2 }, work: work('workbench/invoice-export-a') },
    { id: 'B', name: 'Price rounding', state: 'done_checked', branch: 'workbench/price-rounding-b', base: id(4), since: id(20), files: { changed: 0, adds: 0, dels: 0 }, work: work('workbench/price-rounding-b', { merged: { into: 'main', merge: id(1), at: NOW - MIN, files: 1, adds: 3, dels: 1 } }) },
    { id: 'C', name: 'Help pages', state: 'working', branch: 'workbench/help-pages-c', base: id(1), since: id(1), files: null, work: work('workbench/help-pages-c') },
  ];
  return { commits, agents, branch: 'main', head: id(1) };
}
const layout = (input, width = 480, P = GRAPH_SIZES.M) => graphLayout({ ...input, width, height: 600, ACTIVE }, P);

test('the direction is one constant: newest commits at the top, where the wire arrives', () => {
  assert.equal(NEWEST_AT_TOP, true);
  const src = readFileSync(new URL('../ui/gitgraph.js', import.meta.url), 'utf8');
  assert.match(src, /export const NEWEST_AT_TOP = true;/);
});

test('graphLayout returns rows, lanes, nodes, edges, the trunk\'s x, the row height and its size, in CSS pixels', () => {
  const g = layout(history());
  for (const k of ['rows', 'lanes', 'nodes', 'edges']) assert.ok(Array.isArray(g[k]), k);
  for (const k of ['trunkX', 'rowH', 'w', 'h']) assert.ok(Number.isFinite(g[k]) && g[k] > 0, k);
  assert.equal(g.rowH, GRAPH_SIZES.M.rowH);
  assert.equal(g.rows.length, g.nodes.length);
  assert.ok(g.h >= g.rows.length * g.rowH);
  for (const n of g.nodes) assert.ok(n.x > 0 && n.x < g.w && n.y > 0 && n.y < g.h, `${n.id} inside the graph`);
});

test('one row per commit, newest at the top, and a work node above the tip of each agent with work not merged yet', () => {
  const g = layout(history());
  const order = g.rows.map(r => (r.item.kind === 'work' ? 'work:' + r.item.agentId : r.item.commit.subject));
  assert.deepEqual(order, ['work:C', 'Merge Price rounding: Round totals once', 'Round totals once, at the end', 'Fix the README', 'work:A', 'Batch invoices',
    'Add the export page', 'Find the slow query', 'Tidy the tests', 'Start the invoices service', 'Initial commit']);
  for (let i = 1; i < g.rows.length; i++) assert.ok(g.rows[i].y > g.rows[i - 1].y, 'newer above older');
  const a = g.rows.find(r => r.item.id === 'work:A');
  assert.equal(a.item.work.label, 'not merged yet · 3 files');
  assert.equal(g.rows.find(r => r.item.id === 'work:C').item.work.label, 'working');
  assert.ok(!g.rows.some(r => r.item.id === 'work:B'), 'merged with nothing new: no work node');
  const work = g.nodes.filter(n => n.kind === 'work');
  assert.equal(work.length, 2);
  assert.ok(work.every(n => !n.trunk), 'a work node sits on its agent\'s lane, off your trunk');
});

test('the words of a work node: working, not merged yet with a count, or nothing to show', () => {
  const w = (o = {}) => ({ branch: 'workbench/x-1', folder: true, merged: null, problem: null, thrownAway: null, ...o });
  assert.deepEqual(workNodeOf({ state: 'working', work: w() }, ACTIVE), { label: 'working', count: null, active: true });
  assert.equal(workNodeOf({ state: 'done_checked', files: { changed: 1 }, work: w() }, ACTIVE).label, 'not merged yet · 1 file');
  assert.equal(workNodeOf({ state: 'done_claimed', files: { changed: 12 }, work: w() }, ACTIVE).label, 'not merged yet · 12 files');
  assert.equal(workNodeOf({ state: 'stopped', files: null, work: w() }, ACTIVE).label, 'not merged yet', 'a stopped agent may hold work no one counted');
  assert.equal(workNodeOf({ state: 'done_checked', earlier: true, files: null, work: w() }, ACTIVE).label, 'not merged yet');
  assert.equal(workNodeOf({ state: 'done_checked', files: { changed: 0 }, work: w({ merged: { into: 'main' } }) }, ACTIVE), null);
  assert.equal(workNodeOf({ state: 'stopped', files: null, work: w({ branch: null, folder: false, thrownAway: { at: 1 } }) }, ACTIVE), null);
  assert.equal(workNodeOf({ state: 'stopped', files: null, work: w({ folder: false }) }, ACTIVE), null, 'its folder is gone');
  assert.equal(workNodeOf({ state: 'done_checked', files: null, work: null }, ACTIVE), null, 'no git: a demo agent or a helper');
});

test('your branch is the trunk: its first-parent chain from HEAD, a gold bus; HEAD is a pad, merges are square pads, agents\' commits are chips', () => {
  const g = layout(history());
  const trunk = g.nodes.filter(n => n.trunk).map(n => n.id);
  assert.deepEqual(trunk, [id(1), id(2), id(3), id(4), id(5), id(6)]);
  assert.ok(g.nodes.filter(n => n.trunk).every(n => n.x === g.trunkX));
  const kind = i => g.nodes.find(n => n.id === i).kind;
  assert.equal(kind(id(1)), 'head', 'HEAD (also a merge) is the HEAD pad');
  assert.equal(kind(id(20)), 'chip', 'an agent\'s work commit, off the trunk');
  assert.equal(kind(id(2)), 'via', 'your commits are vias');
  assert.equal(kind(id(10)), 'via', 'a commit on an agent\'s branch with no agent trailer is a via on its lane');
  assert.ok(g.edges.filter(e => e.kind === 'trunk').length >= 5, 'the trunk is drawn as a bus between its commits');
  const wire = g.edges.find(e => e.kind === 'wire');
  assert.deepEqual(wire.pts[0], [g.trunkX, 0], 'the wire from the board comes in at the top, down the trunk\'s line');
  assert.ok(wire.pts[1][1] < g.nodes.find(n => n.id === id(1)).y, 'and ends at HEAD');
  // a merge commit that is not HEAD is a square pad
  const h = history();
  const g2 = layout({ ...h, head: id(2), commits: h.commits.slice(2), agents: [] });
  assert.equal(g2.nodes.find(n => n.id === id(2)).kind, 'head');
  const merged = layout({ ...h, commits: [{ id: id(30), parents: [id(1)], subject: 'Later', author: 'Sam', at: NOW, refs: ['main'], agentId: null, kind: 'commit' }, ...h.commits.map(c => ({ ...c, refs: c.refs.filter(r => r !== 'main') }))], head: id(30) });
  assert.equal(merged.nodes.find(n => n.id === id(1)).kind, 'merge');
});

test('each agent\'s branch is a copper lane that leaves the trunk where it started and comes back with its merge commit', () => {
  const g = layout(history());
  const lane = agent => g.edges.filter(e => e.agentId === agent);
  // Price rounding: out of the merge commit M to its work commit, down its lane, into the trunk at Tidy the tests
  const out = lane('B').find(e => e.kind === 'out'), join = lane('B').find(e => e.kind === 'join');
  const M = g.nodes.find(n => n.id === id(1)), W = g.nodes.find(n => n.id === id(20)), base = g.nodes.find(n => n.id === id(4));
  assert.equal(out.pts[0][1], M.y); assert.deepEqual(out.pts.at(-1), [W.x, W.y]);
  assert.deepEqual(join.pts[0], [W.x, W.y]); assert.equal(join.pts.at(-1)[1], base.y);
  // Invoice export: from its work node down its lane to Start the invoices service on the trunk
  const aJoin = lane('A').find(e => e.kind === 'join');
  assert.equal(aJoin.pts.at(-1)[1], g.nodes.find(n => n.id === id(5)).y);
  assert.ok(lane('A').every(e => e.kind !== 'trunk'));
});

test('lanes go outward, right then left, and their pitch is 56 to 112 px depending on the width', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(slotOf), [0, 1, -1, 2, -2, 3, -3]);
  const g = layout(history());
  const slots = g.lanes.map(l => l.slot).sort((a, b) => a - b);
  assert.deepEqual(slots, [-1, 0, 1]);
  for (const width of [200, 320, 480, 700, 1000, 1600]) {
    const gw = layout(history(), width);
    assert.ok(gw.pitch >= 56 && gw.pitch <= 112, `${width}: pitch ${gw.pitch}`);
  }
  assert.ok(layout(history(), 1600).pitch > layout(history(), 320).pitch, 'more room, wider lanes');
});

test('every line keeps to the board\'s rule: level, upright or at 45°', () => {
  for (const P of Object.values(GRAPH_SIZES)) for (const width of [220, 480, 900]) assert.ok(bendsOk(layout(history(), width, P)), `${P.name} ${width}`);
  // a 30° line is caught
  assert.equal(bendsOk({ edges: [{ pts: [[0, 0], [30, 17]] }] }), false);
});

test('past what the width allows, extra lanes fold into the outermost lane with a "+N" marker', () => {
  const commits = [], agents = [];
  for (let i = 0; i < 9; i++) {
    commits.push({ id: id(100 + i), parents: [id(200)], subject: `Work ${i}`, author: 'Sam', at: NOW - i * MIN, refs: [`workbench/agent-${i}`], agentId: `a${i}`, kind: 'work' });
    agents.push({ id: `a${i}`, name: `Agent ${i}`, state: 'done_checked', branch: `workbench/agent-${i}`, base: id(200), since: id(200), files: { changed: 2 }, work: { branch: `workbench/agent-${i}`, folder: true } });
  }
  commits.push({ id: id(200), parents: [], subject: 'Initial commit', author: 'Sam', at: NOW - 100 * MIN, refs: ['main'], agentId: null, kind: 'commit' });
  const g = layout({ commits, agents, branch: 'main', head: id(200) }, 240);
  const folded = g.folds.reduce((s, f) => s + f.n, 0);
  assert.ok(folded > 0, 'some lanes fold');
  assert.ok(g.lanes.length - 1 <= 2 * g.perSide, 'no more lanes than the width allows');
  assert.ok(g.w <= 240 + 1, `the graph keeps to its width (${g.w})`);
  for (const f of g.folds) assert.ok(Math.abs(f.slot) === g.perSide && f.n >= 1);
  assert.ok(bendsOk(g));
  const wide = layout({ commits, agents, branch: 'main', head: id(200) }, 1400);
  assert.equal(wide.folds.length, 0, 'with room, nothing folds');
});

test('a row\'s words: the subject, then who · when · short id; an agent\'s commit reads its name; refs are badges', () => {
  const h = history(), g = layout(h);
  const agentById = new Map(h.agents.map(a => [a.id, a]));
  const merge = rowWords(g.rows[1].item, { agentById, now: NOW, branch: 'main' });
  assert.equal(merge.line1, 'Merge Price rounding: Round totals once');
  assert.equal(merge.line2, `Price rounding · 1 min ago · ${id(1).slice(0, 7)}`);
  assert.deepEqual(merge.badges.map(b => [b.kind, b.text]), [['yours', 'main'], ['agent', 'Help pages']]);
  assert.match(merge.aria, /On your branch main and Help pages’s branch\.$/);
  const plain = rowWords(g.rows.find(r => r.item.id === id(2)).item, { agentById, now: NOW, branch: 'main' });
  assert.equal(plain.line2, `Sam · 1 hour ago · ${shortId(id(2))}`);
  const work = rowWords(g.rows[0].item, { agentById, now: NOW });
  assert.deepEqual([work.line1, work.line2], ['Help pages', 'working']);
  // what a repository or an agent controls never reaches the page raw
  const evil = { kind: 'commit', commit: { id: id(9), parents: [], subject: `Fix ${U(0x202e)}gnp.exe`, author: `x${U(0x200b)}y`, at: NOW, refs: [`workbench/a${U(0x2066)}b`] } };
  const r = rowWords(evil, { agentById, now: NOW, branch: 'main' });
  for (const s of [r.line1, r.line2, r.aria, ...r.badges.map(b => b.text + b.title)]) assert.ok(![...s].some(ch => [0x202e, 0x200b, 0x2066].includes(ch.codePointAt(0))), s);
  assert.match(r.line1, /⟦U\+202E⟧/);
  assert.equal(rowWords({ kind: 'commit', commit: { id: id(8), parents: [], subject: '  ', at: null, refs: [] } }, { now: NOW }).line1, '(no description)');
});

test('"Merge into <branch>": a branch past 16 characters is cut in the middle', () => {
  assert.equal(mergeLabel('main'), 'Merge into main');
  assert.equal(mergeLabel('release/2026-11-payments-and-refunds'), `Merge into ${cutMiddle('release/2026-11-payments-and-refunds', 16)}`);
  assert.equal(cutMiddle('release/2026-11-payments-and-refunds', 16).length, 16);
  assert.equal(cutMiddle('release/2026-11-payments-and-refunds', 16), 'release/…refunds', 'both ends stay readable');
  assert.equal(cutMiddle('short', 16), 'short');
});

test('Merge and Throw it away in the detail follow the lid\'s rules', () => {
  const w = (o = {}) => ({ branch: 'workbench/x-1', from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
  const repo = { name: 'r', branch: 'main', head: 'abc', dirty: 0, identity: true };
  const live = { mode: 'live', repo, ACTIVE };
  const done = { id: 'x', state: 'done_checked', files: { changed: 2 }, work: w() };
  assert.deepEqual(workActions(done, live), { merge: true, discard: true });
  assert.deepEqual(workActions({ ...done, state: 'working' }, live), { merge: false, discard: true }, 'a working agent can be thrown away (it is stopped first), not merged');
  assert.deepEqual(workActions(done, { ...live, repo: { ...repo, branch: null } }), { merge: false, discard: true }, 'your folder is not on a branch');
  assert.deepEqual(workActions(done, { ...live, repo: { ...repo, identity: false } }), { merge: false, discard: true }, 'git does not know your name and email');
  assert.deepEqual(workActions(done, { ...live, repo: { ...repo, identity: undefined } }), { merge: true, discard: true }, 'unknown counts as known: the engine checks again');
  assert.deepEqual(workActions({ ...done, files: { changed: 0 } }, live), { merge: false, discard: true }, 'nothing to merge');
  assert.deepEqual(workActions({ ...done, state: 'stopped', files: null }, live), { merge: true, discard: true });
  assert.deepEqual(workActions({ ...done, work: w({ folder: false }) }, live), { merge: false, discard: true }, 'a branch whose folder is gone can still be thrown away, as the lid\'s rule says');
  assert.deepEqual(workActions({ ...done, work: w({ branch: null, folder: false, thrownAway: { at: 1 } }) }, live), { merge: false, discard: false });
  assert.deepEqual(workActions({ ...done, parentId: 'p' }, live), { merge: false, discard: false }, 'a helper: its agent is merged instead');
  assert.deepEqual(workActions(done, { ...live, mode: 'demo' }), { merge: false, discard: false });
});

test('the page\'s own words: "git", "show git", "open git", "source control", "show the graph" open it; "board" and "back" come back', () => {
  for (const t of ['git', 'Git', 'show git', 'open git', 'source control', 'show the graph', 'Show me the graph.', 'please show git']) assert.equal(gitScreenWords(t), 'open', t);
  for (const t of ['board', 'back', 'Back.', 'go back', 'back to the board', 'go back to the board']) assert.equal(gitScreenWords(t), 'back', t);
  for (const t of ['git status', 'merge it', 'show me the changes', 'go back and fix the login', 'make the board green', 'back up the database', '', null])
    assert.equal(gitScreenWords(t), null, String(t));
});

test('the same drawing, newest at the bottom, is the top-to-bottom mirror (the constant is easy to flip)', async () => {
  const src = readFileSync(new URL('../ui/gitgraph.js', import.meta.url), 'utf8').replace('export const NEWEST_AT_TOP = true;', 'export const NEWEST_AT_TOP = false;');
  const dir = new URL('../ui/', import.meta.url);
  const flipped = await import('data:text/javascript;base64,' + Buffer.from(src.replace(/from '\.\/([\w]+\.js)'/g, (m, f) => `from '${new URL(f, dir).href}'`)).toString('base64'));
  const a = layout(history()), b = flipped.graphLayout({ ...history(), width: 480, height: 600, ACTIVE }, GRAPH_SIZES.M);
  assert.equal(flipped.NEWEST_AT_TOP, false);
  for (let i = 0; i < a.nodes.length; i++) {
    assert.equal(b.nodes[i].x, a.nodes[i].x);
    assert.ok(Math.abs(b.nodes[i].y - (a.h - a.nodes[i].y)) < 0.2);
  }
  assert.ok(flipped.bendsOk(b));
});

test('any history lays out: unique rows, every node inside, lines at 45°, nothing thrown for odd input', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 60; trial++) {
    const n = 5 + Math.floor(rnd() * 60), commits = [];
    for (let i = 0; i < n; i++) {
      const parents = [];
      if (i < n - 1) parents.push(id(1000 + i + 1 + Math.floor(rnd() * Math.min(3, n - i - 1))));
      if (rnd() < 0.2 && i < n - 3) parents.push(id(1000 + i + 2 + Math.floor(rnd() * (n - i - 2))));
      commits.push({ id: id(1000 + i), parents: [...new Set(parents)], subject: `c${i}`, author: 'Sam', at: NOW - i * MIN, refs: i === 0 ? ['main'] : rnd() < 0.15 ? [`workbench/w-${i}`] : [], agentId: rnd() < 0.2 ? `ag${i}` : null, kind: 'commit' });
    }
    const agents = commits.filter(c => c.refs[0]?.startsWith('workbench/')).map(c => ({ id: `ag-${c.id}`, name: `Agent ${c.subject}`, state: rnd() < 0.3 ? 'working' : 'done_checked',
      branch: c.refs[0], base: c.parents[0] || c.id, since: c.parents[0] || c.id, files: { changed: 1 + Math.floor(rnd() * 4) }, work: { branch: c.refs[0], folder: true } }));
    for (const width of [180, 400, 900]) {
      const g = graphLayout({ commits, agents, branch: 'main', head: commits[0].id, width, height: 500, ACTIVE }, GRAPH_SIZES.S);
      assert.equal(new Set(g.rows.map(r => r.row)).size, g.rows.length);
      assert.ok(bendsOk(g), `trial ${trial} width ${width}`);
      for (const nd of g.nodes) assert.ok(nd.x >= 0 && nd.x <= g.w && nd.y >= 0 && nd.y <= g.h);
      for (const e of g.edges) for (const [x, y] of e.pts) assert.ok(x >= 0 && x <= g.w + 0.5 && y >= 0 && y <= g.h + 0.5, `trial ${trial}: an edge leaves the graph`);
    }
  }
  for (const odd of [{}, { commits: null }, { commits: [null, 3, { id: '' }, { id: 'x', parents: 'nope' }, { id: 'x' }] }, { commits: [{ id: 'a', parents: ['missing'] }], head: 'a' }]) {
    const g = graphLayout({ ...odd, width: 300 }, GRAPH_SIZES.S);
    assert.ok(Array.isArray(g.rows) && bendsOk(g));
  }
});

// ---------------------------------------------------------------- histories from real git (gitGraph()'s own output)
// Each as git log --topo-order gave it, commits as [id, parents, refs, agentId, subject] and the engine's agents.
const REAL = {
  // an agent merged twice, with a commit of its own after the first merge, and one more not merged yet
  mergedTwice: { head: 'c0', commits: [
    ['c0', ['c1'], ['main'], null, 'main 4'], ['c1', ['c2', 'c6'], [], 'm1', 'Merge M: m 2'], ['c2', ['c3'], [], null, 'main 3'],
    ['c3', ['c4', 'c7'], [], 'm1', 'Merge M: m 1'], ['c4', ['c8'], [], null, 'main 2'], ['c5', ['c6'], ['workbench/m-m1'], 'm1', 'm 3'],
    ['c6', ['c7'], [], 'm1', 'm 2'], ['c7', ['c8'], [], 'm1', 'm 1'], ['c8', ['c9'], [], null, 'main 1'], ['c9', [], [], null, 'init'],
  ], agents: [{ id: 'm1', name: 'm1', state: 'done_checked', branch: 'workbench/m-m1', base: 'c8', since: 'c6', files: { changed: 2 }, work: { branch: 'workbench/m-m1', folder: true } }] },
  // merged once, then asked twice to bring in main (a commit, then main merged into its branch), and merged again
  flowTwice: { head: 'c0', commits: [
    ['c0', ['c1'], ['main'], null, 'main 6'], ['c1', ['c6', 'c2'], [], 'f1', 'Merge F: second work'], ['c2', ['c3', 'c7'], ['workbench/f-f1'], null, 'Merge main into f again'],
    ['c3', ['c4'], [], 'f1', 'f: more'], ['c4', ['c5', 'c8'], [], null, 'Merge main into f (bring in main)'], ['c5', ['c10'], [], 'f1', 'f: its own commit'],
    ['c6', ['c7'], [], null, 'main 5'], ['c7', ['c8'], [], null, 'main 4'], ['c8', ['c9'], [], null, 'main 3'], ['c9', ['c11', 'c10'], [], 'f1', 'Merge F: first work'],
    ['c10', ['c12'], [], 'f1', 'W1: first work'], ['c11', ['c12'], [], null, 'main 2'], ['c12', ['c13'], [], null, 'main 1'], ['c13', [], [], null, 'init'],
  ], agents: [{ id: 'f1', name: 'f1', state: 'done_checked', branch: 'workbench/f-f1', base: 'c12', since: 'c12', files: { changed: 0 }, work: { branch: 'workbench/f-f1', folder: true, merged: { into: 'main' } } }] },
  // no agents at all: a feature branch brought up to date with main twice (GitHub's "Update branch"), then merged
  plainUpdateTwice: { head: 'c0', commits: [
    ['c0', ['c1'], ['main'], null, 'main 9'], ['c1', ['c6', 'c2'], [], null, 'Merge feature 8'], ['c2', ['c3', 'c7'], ['feature'], null, 'Merge main into feature 6'],
    ['c3', ['c4'], [], null, 'feature 5'], ['c4', ['c5', 'c8'], [], null, 'Merge main into feature 3'], ['c5', ['c9'], [], null, 'feature 2'],
    ['c6', ['c7'], [], null, 'main 7'], ['c7', ['c8'], [], null, 'main 4'], ['c8', ['c9'], [], null, 'main 1b'], ['c9', ['c10'], [], null, 'main 1'], ['c10', [], [], null, 'init'],
  ], agents: [] },
  // two agents merging each other's work, and main merged into one of them
  crissCross: { head: 'c6', commits: [
    ['c0', ['c1'], ['workbench/l-l1'], 'l1', 'l 2'], ['c1', ['c3', 'c8'], [], null, 'l merges k 1'], ['c2', ['c4', 'c3'], ['workbench/k-k1'], null, 'k merges l 1'],
    ['c3', ['c10'], [], 'l1', 'l 1'], ['c4', ['c5'], [], 'k1', 'k 2'], ['c5', ['c8', 'c9'], [], null, 'k merges main 1'], ['c6', ['c7'], ['main'], null, 'main 2'],
    ['c7', ['c9', 'c8'], [], null, 'main merges k 1'], ['c8', ['c10'], [], 'k1', 'k 1'], ['c9', ['c10'], [], null, 'main 1'], ['c10', ['c11'], [], null, 'base'], ['c11', [], [], null, 'init'],
  ], agents: [{ id: 'k1', name: 'k1', state: 'done_checked', branch: 'workbench/k-k1', base: 'c10', since: 'c10', files: { changed: 2 }, work: { branch: 'workbench/k-k1', folder: true } },
    { id: 'l1', name: 'l1', state: 'done_checked', branch: 'workbench/l-l1', base: 'c10', since: 'c10', files: { changed: 2 }, work: { branch: 'workbench/l-l1', folder: true } }] },
  // agent b started from agent a's commit (HEAD was detached there)
  agentFromAgent: { head: 'c0', commits: [
    ['c0', ['c5'], ['main'], null, 'main 2'], ['c1', ['c3'], ['workbench/a-h1'], 'h1', 'a 3'], ['c2', ['c3'], ['workbench/b-h2'], 'h2', 'b 1'],
    ['c3', ['c4'], [], 'h1', 'a 2'], ['c4', ['c5'], [], 'h1', 'a 1'], ['c5', ['c6'], [], null, 'main 1'], ['c6', [], [], null, 'init'],
  ], agents: [{ id: 'h1', name: 'h1', state: 'done_checked', branch: 'workbench/a-h1', base: 'c5', since: 'c5', files: { changed: 2 }, work: { branch: 'workbench/a-h1', folder: true } },
    { id: 'h2', name: 'h2', state: 'done_checked', branch: 'workbench/b-h2', base: 'c3', since: 'c3', files: { changed: 2 }, work: { branch: 'workbench/b-h2', folder: true } }] },
  // two agents whose branches start at the same commit, off your trunk
  twoOnOne: { head: 'c0', commits: [
    ['c0', ['c2'], ['main'], null, 'main 2'], ['c1', ['c2'], ['workbench/p-p1', 'workbench/q-q1'], 'p1', 'p 1'], ['c2', ['c3'], [], null, 'main 1'], ['c3', [], [], null, 'init'],
  ], agents: [{ id: 'p1', name: 'p1', state: 'done_checked', branch: 'workbench/p-p1', base: 'c2', since: 'c2', files: { changed: 2 }, work: { branch: 'workbench/p-p1', folder: true } },
    { id: 'q1', name: 'q1', state: 'done_checked', branch: 'workbench/q-q1', base: 'c1', since: 'c1', files: { changed: 2 }, work: { branch: 'workbench/q-q1', folder: true } }] },
  // three agents brought in by one octopus merge: three lines out of one node, three into one node
  octopus: { head: 'c0', commits: [
    ['c0', ['c1'], ['main'], null, 'main top'], ['c1', ['c8', 'c6', 'c4', 'c2'], [], null, 'Octopus merge'], ['c2', ['c3'], ['workbench/o3-o3'], 'o3', 'o3 more'],
    ['c3', ['c9'], [], 'o3', 'o3 work'], ['c4', ['c5'], ['workbench/o2-o2'], 'o2', 'o2 more'], ['c5', ['c9'], [], 'o2', 'o2 work'], ['c6', ['c7'], ['workbench/o1-o1'], 'o1', 'o1 more'],
    ['c7', ['c9'], [], 'o1', 'o1 work'], ['c8', ['c9'], [], null, 'main after'], ['c9', ['c10'], [], null, 'base'], ['c10', [], [], null, 'init'],
  ], agents: ['o1', 'o2', 'o3'].map(o => ({ id: o, name: o, state: 'done_checked', branch: `workbench/${o}-${o}`, base: 'c9', since: 'c9', files: { changed: 0 }, work: { branch: `workbench/${o}-${o}`, folder: true, merged: { into: 'main' } } })) },
};
const realId = c => id(0x5000 + Number(c.slice(1)));
function real(name) {
  const r = REAL[name];
  return {
    branch: 'main', head: realId(r.head),
    commits: r.commits.map(([c, ps, refs, agentId, subject], i) => ({ id: realId(c), parents: ps.map(realId), refs, agentId, subject, author: 'Sam', at: NOW - i * MIN, kind: ps.length > 1 ? 'merge' : 'commit' })),
    agents: r.agents.map(a => ({ ...a, base: a.base && realId(a.base), since: a.since && realId(a.since), work: { from: 'main', merged: null, problem: null, thrownAway: null, ...a.work } })),
  };
}
const WIDTHS = [567, 300];

/**
 * Stretches that two edges draw on top of each other, longer than `min` px: the same line (level, upright or at 45°)
 * and overlapping. Two lines that meet at one node (into it, or out of it, side by side) may share their last stretch.
 */
function sharedStretches(g, min) {
  const segs = [];
  g.edges.forEach((e, k) => { for (let i = 1; i < e.pts.length; i++) segs.push({ k, e, a: e.pts[i - 1], b: e.pts[i], first: i === 1, last: i === e.pts.length - 1 }); });
  const line = s => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (Math.abs(dx) < 0.15) return { dir: 'v', key: s.a[0], lo: Math.min(s.a[1], s.b[1]), hi: Math.max(s.a[1], s.b[1]), f: 1 };
    if (Math.abs(dy) < 0.15) return { dir: 'h', key: s.a[1], lo: Math.min(s.a[0], s.b[0]), hi: Math.max(s.a[0], s.b[0]), f: 1 };
    const down = Math.sign(dx) === Math.sign(dy);
    return { dir: down ? 'd' : 'u', key: down ? s.a[1] - s.a[0] : s.a[1] + s.a[0], lo: Math.min(s.a[0], s.b[0]), hi: Math.max(s.a[0], s.b[0]), f: Math.SQRT2 };
  };
  const nodeAt = p => g.nodes.find(n => Math.abs(n.x - p[0]) <= n.size + 2.5 && Math.abs(n.y - p[1]) <= n.size + 2.5);
  const ends = s => [s.first && nodeAt(s.a), s.last && nodeAt(s.b)].filter(Boolean).map(n => n.id);
  const out = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.k === t.k) continue;
    const ls = line(s), lt = line(t);
    if (ls.dir !== lt.dir || Math.abs(ls.key - lt.key) > 0.6) continue;
    const len = (Math.min(ls.hi, lt.hi) - Math.max(ls.lo, lt.lo)) * ls.f;
    if (len <= min) continue;
    if (ends(s).some(x => ends(t).includes(x))) continue;
    out.push(`${Math.round(len)} px: ${s.e.kind} ${JSON.stringify(s.e.pts[0])}→${JSON.stringify(s.e.pts.at(-1))} and ${t.e.kind} ${JSON.stringify(t.e.pts[0])}→${JSON.stringify(t.e.pts.at(-1))}`);
  }
  return out;
}
/** Level stretches of lines of work that run across your trunk (or the wire above HEAD) between their ends. */
function overTrunk(g) {
  const bottom = Math.max(...g.nodes.filter(n => n.trunk).map(n => n.y));
  const out = [];
  for (const e of g.edges) {
    if (e.kind === 'trunk' || e.kind === 'wire') continue;
    for (let i = 1; i < e.pts.length; i++) {
      const [a, b] = [e.pts[i - 1], e.pts[i]];
      if (Math.abs(a[1] - b[1]) < 0.2 && Math.min(a[0], b[0]) < g.trunkX - 0.5 && Math.max(a[0], b[0]) > g.trunkX + 0.5 && a[1] < bottom) out.push(`${e.kind} at y ${a[1]}`);
    }
  }
  return out;
}

test('two lines never run down one gutter: lines that merge into the same lane each get their own way down', () => {
  const bad = [];
  for (const name of Object.keys(REAL)) for (const P of Object.values(GRAPH_SIZES)) for (const width of WIDTHS) {
    const g = layout(real(name), width, P);
    assert.ok(bendsOk(g), `${name} ${P.name} ${width}: 45° only`);
    if (g.folds.length) continue;   // lines folded into the outermost lane share it on purpose ("+N")
    for (const s of sharedStretches(g, P.bend)) bad.push(`${name} ${P.name} ${width}: ${s}`);
    for (const s of sharedRuns(g, P.bend)) bad.push(`${name} ${P.name} ${width}: sharedRuns ${s.len} px, ${s.a.kind} and ${s.b.kind}`);
  }
  assert.deepEqual(bad, []);
  // and each merge still reaches the commit it took
  const g = layout(real('flowTwice'), 567);
  const node = c => g.nodes.find(n => n.id === realId(c));
  for (const [from, to] of [['c2', 'c7'], ['c4', 'c8']]) {
    const e = g.edges.find(x => x.kind === 'cross' && Math.abs(x.pts[0][1] - node(from).y) < 0.2 && Math.abs(x.pts.at(-1)[1] - node(to).y) < 0.2);
    assert.ok(e, `a line from ${from} to ${to}`);
  }
});

test('a line that leaves or joins another agent\'s line keeps to that line\'s side, never across your trunk when a lane is free', () => {
  for (const name of ['agentFromAgent', 'twoOnOne']) for (const P of Object.values(GRAPH_SIZES)) for (const width of WIDTHS) {
    const g = layout(real(name), width, P);
    assert.deepEqual(overTrunk(g), [], `${name} ${P.name} ${width}`);
    assert.ok(bendsOk(g));
    // both lines of work on one side of the trunk
    const sides = new Set(g.nodes.filter(n => !n.trunk).map(n => Math.sign(n.slot)));
    assert.equal(sides.size, 1, `${name} ${P.name} ${width}: one side`);
  }
});

test('an agent whose branch starts past the commits shown sits at the end, above "Older commits are not shown here", its stub pointing down', () => {
  // 200 commits of yours (the limit), an agent working from your latest, and an earlier agent whose branch and whose
  // base are further back than that (git listed them past the 200th)
  const commits = [];
  for (let i = 0; i < 200; i++) commits.push({ id: id(0x7000 + i), parents: [id(0x7000 + i + 1)], subject: `main ${200 - i}`, author: 'Sam', at: NOW - i * MIN, refs: i === 0 ? ['main'] : [], agentId: null, kind: 'commit' });
  const agents = [
    { id: 'e1', name: 'Old export', state: 'done_checked', earlier: true, branch: 'workbench/old-e1', base: id(0x7400), since: id(0x7400), files: null, work: { branch: 'workbench/old-e1', from: 'main', folder: true } },
    { id: 'e3', name: 'Older still', state: 'stopped', earlier: true, branch: 'workbench/old-e3', base: id(0x7401), since: id(0x7401), files: null, work: { branch: 'workbench/old-e3', from: 'main', folder: true } },
    { id: 'e2', name: 'New work', state: 'working', branch: 'workbench/new-e2', base: id(0x7000), since: id(0x7000), files: null, work: { branch: 'workbench/new-e2', from: 'main', folder: true } },
  ];
  const input = { commits, agents, branch: 'main', head: id(0x7000) };
  const g = layout(input, 567);
  const row = a => g.rows.find(r => r.item.id === 'work:' + a);
  assert.equal(row('e2').row, 0, 'the newest work is at the top');
  assert.equal(g.headRow, 1, 'HEAD right under it');
  assert.deepEqual(g.rows.slice(-2).map(r => r.item.id), ['work:e1', 'work:e3'], 'the old ones at the end, in the order given');
  for (const a of ['e1', 'e3']) {
    const nd = g.nodes.find(n => n.id === 'work:' + a);
    const stub = g.edges.find(e => e.stub && e.kind === 'lane' && e.pts[0][0] === nd.x && e.pts[0][1] === nd.y);
    assert.ok(stub && stub.pts[1][1] > nd.y && stub.pts[1][1] <= g.h, `${a}: its stub points down, inside the graph`);
  }
  // they take no lane ahead of the agent working now: its lane is the one it has without them
  const alone = layout({ ...input, agents: [agents[2]] }, 567);
  assert.equal(g.nodes.find(n => n.id === 'work:e2').slot, alone.nodes.find(n => n.id === 'work:e2').slot);
  // your trunk runs on past them, into the history not shown
  const trunkStub = g.edges.find(e => e.kind === 'trunk' && e.stub);
  assert.ok(trunkStub && trunkStub.pts[1][1] > g.rows.at(-1).y, 'the trunk goes on down past the last row');
  assert.ok(bendsOk(g));
  // newest first by when they started, when the page knows it
  const dated = layout({ ...input, agents: [{ ...agents[0], startedAt: NOW - 9 * 86400000 }, { ...agents[1], startedAt: NOW - 2 * 86400000 }, agents[2]] }, 567);
  assert.deepEqual(dated.rows.slice(-2).map(r => r.item.id), ['work:e3', 'work:e1']);
  // its row says where its branch starts, for a screen reader
  assert.match(rowWords(row('e1').item, { now: NOW }).aria, /starts in older commits/);
});

test('HEAD\'s silkscreen has room beside its pad, also when no lane sits left of your trunk', () => {
  // gitscreen.js sets "HEAD" 5 px left of the pad, in 10.5 px type: 30 px wide (measured in Chrome)
  for (const name of Object.keys(REAL)) for (const P of Object.values(GRAPH_SIZES)) for (const width of [...WIDTHS, 220]) {
    const g = layout(real(name), width, P);
    const head = g.nodes.find(n => n.kind === 'head');
    assert.ok(head.x - head.size - 5 - 30 >= 1, `${name} ${P.name} ${width}: the label starts at ${head.x - head.size - 35}`);
    assert.ok(g.w <= width + 1, `${name} ${P.name} ${width}: the graph keeps to its width (${g.w})`);
  }
  // with lanes on the left, the trunk stands where they leave it, as before
  const g = layout(history(), 480);
  assert.equal(g.trunkX, GRAPH_SIZES.M.margin + GRAPH_SIZES.M.headR + g.pitch);
});

test('any history from real git or made up lays out with no two lines on top of each other', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bad = [];
  for (let trial = 0; trial < 80; trial++) {
    const n = 6 + Math.floor(rnd() * 40), commits = [];
    for (let i = 0; i < n; i++) {
      const parents = [];
      if (i < n - 1) parents.push(id(2000 + i + 1 + Math.floor(rnd() * Math.min(3, n - i - 1))));
      if (rnd() < 0.25 && i < n - 3) parents.push(id(2000 + i + 2 + Math.floor(rnd() * (n - i - 2))));
      commits.push({ id: id(2000 + i), parents: [...new Set(parents)], subject: `c${i}`, author: 'Sam', at: NOW - i * MIN, refs: i === 0 ? ['main'] : rnd() < 0.15 ? [`workbench/w-${i}`] : [], agentId: rnd() < 0.2 ? `ag${i}` : null, kind: 'commit' });
    }
    const agents = commits.filter(c => c.refs[0]?.startsWith('workbench/')).map(c => ({ id: `ag-${c.id}`, name: `Agent ${c.subject}`, state: rnd() < 0.3 ? 'working' : 'done_checked',
      branch: c.refs[0], base: c.parents[0] || c.id, since: c.parents[0] || c.id, files: { changed: 1 + Math.floor(rnd() * 4) }, work: { branch: c.refs[0], folder: true } }));
    for (const width of [400, 900]) {
      const g = graphLayout({ commits, agents, branch: 'main', head: commits[0].id, width, height: 500, ACTIVE }, GRAPH_SIZES.M);
      if (g.folds.length) continue;
      for (const s of sharedStretches(g, GRAPH_SIZES.M.bend)) bad.push(`trial ${trial} width ${width}: ${s}`);
      for (const s of sharedRuns(g, GRAPH_SIZES.M.bend)) bad.push(`trial ${trial} width ${width}: sharedRuns ${s.len} px, ${s.a.kind} and ${s.b.kind}`);
    }
  }
  assert.deepEqual(bad.slice(0, 12), []);
});

test('the git screen\'s colours, in all three looks: text at 4.5:1, traces and marks at 3:1', () => {
  // its own custom properties sit in D1's section of app.css, a second block per look after the looks' first blocks
  const css = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8');
  const base = palettes(css), sec = css.slice(css.indexOf('D1: the DRAM'));
  const block = sel => { const i = sec.indexOf(sel + ' {'); assert.ok(i >= 0, sel); const body = sec.slice(sec.indexOf('{', i) + 1, sec.indexOf('}', i)); return Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])); };
  const mine = { green: block(':root, :root[data-theme="green"]'), 'black-gold': block(':root[data-theme="black-gold"]'), ivory: block(':root[data-theme="ivory"]') };
  const pairs = [
    ['card-ink', 'd-add-bg', 4.5, 'an added line'], ['card-ink', 'd-del-bg', 4.5, 'a removed line'], ['card-ink', 'd-hunk-bg', 4.5, 'a hunk\'s place'], ['card-sub', 'd-hunk-bg', 4.5, 'a hunk\'s words'],
    ['d-add-mk', 'd-add-bg', 3, 'the + mark'], ['d-del-mk', 'd-del-bg', 3, 'the − mark'], ['d-del-mk', 'card-1', 4.5, 'a hidden character, shown'], ['d-del-mk', 'card-2', 4.5, 'a hidden character, shown'],
    ...['mask-1', 'mask-2', 'mask-3'].flatMap(m => [['g-trunk', m, 3, 'your gold trunk'], ['g-lane', m, 3, 'an agent\'s copper lane']]),
  ];
  const low = [];
  for (const t of THEMES) {
    const p = { ...base[t], ...mine[t] };
    const get = k => { let v = p[k]; for (let i = 0; i < 5 && v && v.startsWith('var('); i++) v = p[v.slice(6, -1)]; return v; };
    for (const [fg, bg, min, what] of pairs) {
      const r = ratio(get(fg), get(bg));
      if (!(r >= min)) low.push(`${t}: ${what} (${fg} on ${bg}) ${r.toFixed(2)} < ${min}`);
    }
  }
  assert.deepEqual(low, []);
});
