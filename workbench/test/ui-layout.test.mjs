import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBoard, sizeClass, frame, boardProblems, boardBoxes, placeCard, maxDenseRows, wrapWords, clipTo, overlapArea, SIZES,
  dramSegments, saidLineH, saidTextLines, SAID_HINT, saidMinLines, bottomRanks } from '../ui/layout.js';
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

// ------------------------------------------------------------------ the DRAM (git) under the core

const DETAILS = ['calm', 'more'];
const each = fn => { for (const name of SCENARIOS) for (const [W, H] of WINDOWS) for (const detail of DETAILS) for (const lidNeed of [120, 220, 900]) fn(name, W, H, detail, lidNeed); };

test('the DRAM sits centred under the core, joined to its bottom edge by a bus of 6 to 8 traces, its wire running to the board\'s bottom edge', () => {
  each((name, W, H, detail, lidNeed) => {
    const { G } = board(name, W, H, detail, { lidNeed });
    const d = G.dram, c = G.core, tag = `${name} ${W}x${H} ${detail} ${lidNeed}`;
    assert.ok(d, tag);
    assert.ok(Math.abs(d.x + d.w / 2 - G.cx) < 0.6, `${tag}: centred under the core`);
    assert.ok(d.y - d.pin > c.b + 9, `${tag}: below the core's courtyard`);
    assert.ok(d.bus.length >= 6 && d.bus.length <= 8, `${tag}: a bus of 6 to 8 traces`);
    for (const [p, q] of dramSegments(G).filter(s => s[2] === 'dram bus')) {
      assert.equal(p[1], c.b, `${tag}: each trace starts at the core's bottom edge`);
      assert.equal(q[1], d.y - d.pin, `${tag}: and ends at a pin on the DRAM's top edge`);
      assert.ok(d.pins.includes(p[0]), `${tag}: on a pin`);
    }
    const wire = dramSegments(G).find(s => s[2] === 'dram wire');
    assert.equal(wire[0][0], wire[1][0], `${tag}: the wire runs straight down`);
    assert.equal(wire[0][1], d.y + d.h + d.pin, `${tag}: from the DRAM's bottom edge`);
    assert.equal(wire[1][1], G.board.b, `${tag}: to the board's bottom edge`);
    assert.ok(d.pins.includes(d.wire.x) && d.wire.x > G.cx && d.wire.x < d.x + d.w, `${tag}: from a pin near its right end`);
  });
});

test('the core\'s tallest shrinks by the DRAM\'s room: the DRAM and two lines under it always fit above the edge connector', () => {
  each((name, W, H, detail, lidNeed) => {
    const { G } = board(name, W, H, detail, { lidNeed });
    const tag = `${name} ${W}x${H} ${detail} ${lidNeed}`;
    assert.ok(G.said.y + saidMinLines(G.P) * saidLineH(G.P) <= G.said.maxY + 0.01, `${tag}: its lines for #said (${G.said.y} to ${G.said.maxY})`);
    assert.ok(G.said.lines >= saidMinLines(G.P), `${tag}: #said may use the lines kept for it`);
  });
  // and the frame the lid fitter reads knows it, at every size
  for (const [W, H] of WINDOWS) {
    const P = sizeClass(W, H), f = frame(W, H, P);
    const tallest = layoutBoard({ W, H, P, roots: [], laneOf: () => null, lidNeed: 2000 });
    assert.ok(tallest.lidPageH <= f.lidMaxH - P.lid.padT - P.lid.padB - P.lid.inh - P.lid.gap3 + 0.5, `${W}x${H}`);
    assert.ok(tallest.core.b <= f.coreBottomMax + 0.5, `${W}x${H}: the core stops short of the DRAM's room`);
  }
});

test('the edge connector leaves a gap for the wire; with one machine, its section goes left of the wire', () => {
  each((name, W, H, detail, lidNeed) => {
    const { G } = board(name, W, H, detail, { lidNeed });
    const wx = G.dram.wire.x, tag = `${name} ${W}x${H} ${detail}`;
    for (const m of G.machines) assert.ok(m.x + m.w <= wx - 8 || m.x >= wx + 8, `${tag}: ${m.id} keeps clear of the wire`);
    if (G.machines.length === 1) assert.ok(G.machines[0].x + G.machines[0].w <= wx - 8, `${tag}: one machine goes left of the wire`);
    if (G.machines.length > 1) {
      assert.ok(G.machines.some(m => m.x < wx) && G.machines.some(m => m.x > wx), `${tag}: machines sit either side of the wire`);
      for (let i = 1; i < G.machines.length; i++) assert.ok(G.machines[i].x >= G.machines[i - 1].x + G.machines[i - 1].w, `${tag}: in order, never on each other`);
    }
  });
  // one machine stays centred under the core when that leaves the wire's gap, and otherwise ends just left of it
  for (const [W, H] of WINDOWS) {
    const { G } = board('live', W, H, 'calm');
    const m = G.machines[0], wx = G.dram.wire.x, gap = G.P.dram.wireGap;
    assert.equal(G.machines.length, 1);
    if (G.cx + m.w / 2 <= wx - gap) assert.ok(Math.abs(m.x + m.w / 2 - G.cx) < 1, `${W}x${H}: centred`);
    else assert.ok(Math.abs(m.x + m.w - (wx - gap)) < 1, `${W}x${H}: just left of the wire`);
  }
});

test('dense rows stop where the core\'s bottom edge could not hold their lanes beside the DRAM', () => {
  for (const [W, H] of WINDOWS) {
    const P = sizeClass(W, H), n = maxDenseRows(H, P);
    assert.ok(n >= 12, `${W}x${H}: at least two rows a lane`);
    for (let k = 2; 6 * k <= n; k++) {
      const f = frame(W, H, P, { nRows: 6 * k, dense: true });
      assert.ok(6 * k === 12 || f.rows.filter(y => y > f.cy + f.coreHalfMin).length <= bottomRanks(P), `${W}x${H}: ${6 * k} rows`);
    }
  }
  assert.deepEqual(Object.values(SIZES).map(P => [P.name, bottomRanks(P)]), [['L', 4], ['M', 3], ['S', 3]]);
});

test('#said moves under the DRAM, left of its wire, and the first-run hint always fits the room it has', () => {
  each((name, W, H, detail, lidNeed) => {
    const { G } = board(name, W, H, detail, { lidNeed });
    const s = G.said, d = G.dram, tag = `${name} ${W}x${H} ${detail} ${lidNeed}`;
    assert.ok(s.y >= d.y + d.h + d.pin, `${tag}: under the DRAM`);
    assert.ok(s.x + s.w <= d.wire.x - 8, `${tag}: left of the wire`);
    const lines = saidTextLines(G, SAID_HINT, { hint: true });
    assert.ok(lines <= s.lines && s.y + lines * saidLineH(G.P) <= s.maxY + 0.01, `${tag}: the hint takes ${lines} lines of ${s.lines}`);
  });
});

test('dense boards with every row taken, at every size the window allows: the DRAM keeps its column and nothing touches it', () => {
  const bad = [];
  for (const [W, H] of WINDOWS) {
    const P = sizeClass(W, H);
    for (let k = 2; 6 * k <= Math.max(12, maxDenseRows(H, P)); k++) {
      const n = 6 * k, roots = [], at = new Map();
      for (const side of ['L', 'R']) for (let row = 0; row < n; row++) {
        const id = `${side}${row}`;
        roots.push({ id, name: `Agent ${id}`, status: 'working', stop: 'mid', lit: null, qno: null, kids: [] });
        at.set(id, { side, row });
      }
      for (const lidNeed of [0, 900]) {
        // every lane that leaves the core's bottom edge needs the person, so all their pads are drawn
        const probe = layoutBoard({ W, H, P, roots, laneOf: id => at.get(id), nRows: n, dense: true, lidNeed });
        let q = 0;
        for (const nd of probe.nodes) if (nd.lane.kind === 'down') Object.assign(roots.find(r => r.id === nd.id), { lit: 'need', qno: ++q, stop: 'inner' });
        const G = layoutBoard({ W, H, P, roots, laneOf: id => at.get(id), nRows: n, dense: true, lidNeed, machines: [{ id: 'laptop', name: 'Your laptop', awake: true }] });
        for (const p of boardProblems(G)) if (/dram|U2|said/.test(p)) bad.push(`${W}x${H} ${n} rows ${lidNeed}: ${p}`);
        for (const r of roots) Object.assign(r, { lit: null, qno: null, stop: 'mid' });
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('the checks catch a DRAM that is in the way: a machine on its wire, a chip on its package', () => {
  const { G } = board('demo', 1440, 900, 'calm');
  assert.deepEqual(boardProblems(G), []);
  const m = G.machines[0], was = m.x;
  m.x = G.dram.wire.x - 10;
  assert.ok(boardProblems(G).some(p => /dram wire × machine/.test(p)), boardProblems(G).join('; '));
  m.x = was;
  const chip = G.nodes[0];
  const box = boardBoxes(G).find(b => b.k === 'dram');
  chip.chip.x = box.x + 4; chip.chip.y = box.y + 2;
  assert.ok(boardProblems(G).some(p => /dram/.test(p)), boardProblems(G).join('; '));
});
