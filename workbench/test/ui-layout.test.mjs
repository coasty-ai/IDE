import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBoard, sizeClass, frame, boardProblems, boardBoxes, placeCard, maxDenseRows, wrapWords, clipTo, overlapArea, SIZES } from '../ui/layout.js';
import { Lanes, denseLanes } from '../ui/lanes.js';
import { boardModel } from '../ui/boardmodel.js';
import { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY } from '../src/shared/states.mjs';
import { scenario, SCENARIOS } from '../scripts/ui-mock.mjs';

const WINDOWS = [[960, 900], [1024, 700], [1280, 680], [1440, 789], [1512, 862], [1728, 1000], [1920, 970], [2560, 1300]];
const STATES = { LOOK, NEEDS_YOU, DONE, ENDED, PRIORITY };

/** Lay out a scenario the way the page does. */
function board(name, W, H, detail, { lanes = new Lanes(null), lidNeed = 220, currentId = null } = {}) {
  const st = scenario(name, 1_800_000_000_000);
  const bm = boardModel(st.agents, { ...STATES, later: new Set(), currentId });
  lanes.assign(bm.roots.map(r => ({ id: r.id, startedAt: r.startedAt, laptop: (st.machines.find(m => m.id === r.machineId)?.kind || 'laptop') === 'laptop' })));
  const P = sizeClass(W, H);
  const dense = bm.roots.length > 12;
  let roots = bm.roots, laneOf = id => lanes.get(id), nRows = 6, tray = null;
  if (dense) {
    const done = roots.filter(r => r.ghost), active = roots.filter(r => !r.ghost);
    const d = denseLanes(active, id => lanes.get(id), maxDenseRows(H, P));
    roots = active.filter(r => !d.overflow.includes(r.id)); laneOf = id => d.at.get(id) || null; nRows = d.rows;
    tray = { count: done.length, text: `${done.length} done or stopped` };
  }
  const machines = st.machines.map(m => ({ id: m.id, name: m.name, awake: m.awake, note: '2 agents · memory almost full' }));
  return { G: layoutBoard({ W, H, P, detail, roots, laneOf, nRows, dense, lidNeed, machines, tray }), bm, lanes };
}

test('every scenario, at every window size and both detail levels: nothing overlaps, nothing leaves the board, no words on copper', () => {
  const bad = [];
  for (const name of SCENARIOS) for (const [W, H] of WINDOWS) for (const detail of ['calm', 'more']) {
    const { G } = board(name, W, H, detail);
    for (const p of boardProblems(G)) bad.push(`${name} ${W}x${H} ${detail}: ${p}`);
  }
  assert.deepEqual(bad, []);
});

test('the core grows for long content, but its edges never meet a lane', () => {
  for (const [W, H] of WINDOWS) {
    for (const need of [0, 150, 260, 400, 900]) {
      const { G } = board('demo', W, H, 'calm', { lidNeed: need });
      const c = G.core;
      for (const y of G.rows) {
        const off = Math.abs(y - G.cy), half = c.h / 2;
        assert.ok(off <= half - 10 || off >= half + G.diag + 10, `${W}x${H} need ${need}: a row ${off} from the middle meets the core's edge (${half})`);
      }
      assert.ok(c.h <= G.P.coreMaxH + 0.5 && c.y >= G.top - 1, `${W}x${H}: the core stays in the board`);
    }
  }
});

test('the lid can always hold its smallest content: the fitter has a floor to aim at', () => {
  for (const [W, H] of WINDOWS) {
    const P = sizeClass(W, H), f = frame(W, H, P);
    const page = f.lidMaxH - P.lid.padT - P.lid.padB - P.lid.inh - P.lid.gap3;
    assert.ok(page >= 240, `${W}x${H}: only ${page}px for the lid's words`);
  }
});

test('a chip keeps its lane for life: new agents never move the old ones', () => {
  const lanes = new Lanes(null);
  const first = board('demo', 1440, 900, 'calm', { lanes }).G;
  const later = board('busy', 1440, 900, 'calm', { lanes }).G;
  for (const n of first.nodes) {
    const m = later.byId.get(n.id);
    assert.ok(m, n.id);
    assert.equal(m.side, n.side); assert.equal(m.rowIdx, n.rowIdx);
    assert.equal(m.lane.y, n.lane.y);
  }
});

test('stops: beside you when it needs you, mid-board while it works, at the edge when done', () => {
  const { G } = board('demo', 1440, 900, 'calm');
  const by = name => G.nodes.find(n => n.r.name === name);
  const c = G.core;
  const dist = n => (n.side === 'L' ? c.x - (n.chip.x + n.w) : n.chip.x - c.r);
  assert.equal(by('Checkout fix').stop, 'inner');
  assert.equal(by('Onboarding').stop, 'mid');
  assert.equal(by('Invoice export').stop, 'edge');
  assert.ok(dist(by('Checkout fix')) < dist(by('Onboarding')));
  assert.ok(dist(by('Onboarding')) < dist(by('Invoice export')));
  assert.ok(by('Checkout fix').lit && by('Checkout fix').qno === 1);
});

test('the helper that asks is always drawn, even with six helpers', () => {
  for (const [W, H] of WINDOWS) {
    const { G } = board('helpers6', W, H, 'calm');
    const n = G.nodes.find(x => x.r.name === 'Checkout fix');
    assert.ok(n.helpers.some(p => p.id === 'h5'), `${W}x${H}: the asking helper h5 is on the board`);
    const drawn = n.helpers.length + (n.helpers.more ? n.helpers.more.n : 0);
    assert.equal(drawn, 6, 'the rest fold into "+N"');
  }
});

test('long names wrap onto more lines instead of running off the chip', () => {
  const { G } = board('long', 1024, 700, 'calm');
  const n = G.nodes.find(x => x.r.name.startsWith('Investigate'));
  assert.ok(n.shape.lines.length >= 2);
  assert.ok(n.w <= SIZES.S.chipMax + 1);
  assert.deepEqual(wrapWords('Investigate intermittent payment provider timeouts', 20), ['Investigate', 'intermittent payment', 'provider timeouts']);
  assert.deepEqual(wrapWords('Internationalization', 8), ['Internat', 'ionaliza', 'tion']);
  assert.equal(clipTo('Check welcome email copy', 14), 'Check welcome…');
});

test('a card goes beside its chip and never on the core', () => {
  for (const [W, H] of WINDOWS) for (const detail of ['calm', 'more']) {
    const { G } = board('busy', W, H, detail);
    for (const n of G.nodes) {
      const box = { x: n.chip.x - 5, y: n.chip.y - 5, w: n.w + 10, h: n.h + 10 };
      const p = placeCard(G, n, box, 300, 220);
      if (!p) continue;
      const core = { x: G.core.x - 12, y: G.core.y - 12, w: G.core.w + 24, h: G.core.h + 24 };
      assert.equal(overlapArea({ x: p.x, y: p.y, w: 300, h: 220 }, core), 0, `${W}x${H} ${detail} ${n.r.name}`);
      assert.ok(p.x >= G.board.x && p.y >= G.board.y && p.x + 300 <= G.board.r && p.y + 220 <= G.board.b);
    }
  }
});

test('the board model: a helper that asks lights its agent, and the brackets go on that agent', () => {
  const st = scenario('helper', 1_800_000_000_000);
  const bm = boardModel(st.agents, { ...STATES, later: new Set(), currentId: '902d13-58d802d4' });
  const onboarding = bm.roots.find(r => r.name === 'Onboarding');
  assert.equal(onboarding.stop, 'inner');
  assert.equal(onboarding.lit, 'need');
  assert.equal(onboarding.current, true);
  assert.equal(onboarding.askerId, '902d13-58d802d4');
  assert.equal(onboarding.kids[0].id, '902d13-58d802d4', 'the asking helper first');
  const flaky = bm.roots.find(r => r.name === 'Flaky test');
  assert.equal(flaky.lit, 'stuck');
  assert.ok(boardBoxes(board('helper', 1440, 900, 'more').G).length > 10);
});
