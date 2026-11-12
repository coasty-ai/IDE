import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { graphLayout, GRAPH_SIZES, NEWEST_AT_TOP, bendsOk, rowWords, workNodeOf, workActions, mergeLabel, gitScreenWords, cutMiddle, shortId, slotOf } from '../ui/gitgraph.js';
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
  assert.deepEqual(workActions({ ...done, work: w({ folder: false }) }, live), { merge: false, discard: false });
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
