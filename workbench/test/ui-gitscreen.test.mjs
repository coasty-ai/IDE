// The git screen's pure parts, and the CSS it is drawn with: where HEAD's label goes (whole inside the graph, and clear
// of every trace, also when an agent brought your branch in down the gutter beside HEAD), and focus rings on the card's
// surface (the detail, the git screen's input, the menus) that stand out from it in every look.
// gitscreen.js reaches /shared/... through model.js, so that path is mapped to src/shared/ with module.registerHooks
// (Node 22.15 or later), as test/ui-review-fixes.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as nodeModule from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { graphLayout, GRAPH_SIZES } from '../ui/gitgraph.js';
import { palettes, ratio, THEMES } from '../scripts/ui-contrast.mjs';

const SHARED = fileURLToPath(new URL('../src/shared/', import.meta.url));
const canMap = typeof nodeModule.registerHooks === 'function';
if (canMap) {
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith('/shared/')) return { url: pathToFileURL(SHARED + spec.slice('/shared/'.length)).href, shortCircuit: true };
      return next(spec, ctx);
    },
  });
}
const skip = canMap ? false : 'needs module.registerHooks (Node 22.15 or later)';
const gs = canMap ? await import('../ui/gitscreen.js') : null;

const LABEL_W = 30;   // "HEAD" at 600 10.5px JetBrains Mono (0.6 em a letter) with 1.2px letter-spacing
const MIN = 60000, NOW = Date.UTC(2026, 10, 12, 12);
const hexId = n => n.toString(16).padStart(40, 'a');
const trunkOf = n => Array.from({ length: n }, (_, i) => ({ id: hexId(i + 1), parents: i < n - 1 ? [hexId(i + 2)] : [], subject: `Change ${i + 1}`, author: 'Sam Lee', at: NOW - (i * 170 + 3) * MIN, refs: i === 0 ? ['main'] : [], agentId: null, kind: 'commit' }));
const agent = (id, name, state, branch, files) => ({ id, name, state, earlier: false, branch, from: 'main', base: null, since: null, files,
  work: { branch, from: 'main', folder: true, merged: null, problem: null, thrownAway: null } });

/**
 * Search cleanup started from an older commit of yours and then brought your branch in: its merge commit has HEAD as its
 * second parent. Help pages works from the commit under HEAD, so Search cleanup's longer line takes the left lane, and
 * its line into HEAD runs down the gutter beside it.
 */
function broughtIn() {
  const trunk = trunkOf(9);
  const left = agent('gb1', 'Search cleanup', 'done_checked', 'workbench/search-cleanup-gb1', { changed: 2, adds: 14, dels: 30, list: [] });
  const right = agent('gb2', 'Help pages', 'working', 'workbench/help-pages-gb2', null);
  trunk[1].refs.push(right.branch);
  const own = { id: hexId(100), parents: [trunk[2].id], subject: 'Remove the old search code', author: 'Search cleanup', at: trunk[2].at + 7 * MIN, refs: [], agentId: null, kind: 'commit' };
  const merge = { id: hexId(101), parents: [own.id, trunk[0].id], subject: 'Merge main into its branch', author: 'Search cleanup', at: NOW - MIN, refs: [left.branch], agentId: null, kind: 'merge' };
  return { commits: [merge, trunk[0], trunk[1], own, ...trunk.slice(2)], agents: [left, right], branch: 'main', head: trunk[0].id };
}

/** Points along every segment of every edge, a pixel apart, with the stroke's half width. */
function tracePoints(g) {
  const out = [];
  for (const e of g.edges) {
    const w = e.kind === 'trunk' ? 3 : 1.2;
    for (let i = 1; i < e.pts.length; i++) {
      const [a, b] = [e.pts[i - 1], e.pts[i]], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s <= L; s += 1) out.push({ x: a[0] + (b[0] - a[0]) * (L ? s / L : 0), y: a[1] + (b[1] - a[1]) * (L ? s / L : 0), w });
    }
  }
  return out;
}
const crossing = (g, box) => tracePoints(g).filter(p => p.x > box.l - p.w && p.x < box.r + p.w && p.y > box.t - p.w && p.y < box.b + p.w);

test('HEAD’s label is never cut by the graph’s left edge, also when nothing is drawn left of the trunk', { skip }, () => {
  for (const [size, width] of [['S', 420], ['M', 561], ['L', 640]]) {
    const g = graphLayout({ commits: trunkOf(6), agents: [], branch: 'main', head: hexId(1), width }, GRAPH_SIZES[size]);
    const { dx, label } = gs.headLabelPlace(g, LABEL_W);
    assert.ok(label, `${size}: a label`);
    assert.ok(label.box.l + dx >= 1, `${size}: the label starts inside the graph (${label.box.l} + ${dx})`);
    assert.equal(label.halo, false, `${size}: no copper runs through it`);
    assert.deepEqual(crossing(g, label.box), [], `${size}: nothing crosses it`);
  }
});

test('HEAD’s label moves clear of a left lane’s line that comes down the gutter beside HEAD', { skip }, () => {
  for (const [size, width] of [['S', 420], ['M', 561], ['M', 610], ['L', 640], ['L', 900]]) {
    const g = graphLayout({ ...broughtIn(), width }, GRAPH_SIZES[size]);
    assert.ok(g.edges.some(e => e.kind === 'cross'), `${size} ${width}: the line into HEAD runs down a gutter`);
    const { dx, label } = gs.headLabelPlace(g, LABEL_W);
    assert.ok(label.box.l + dx >= 1, `${size} ${width}: inside the graph`);
    assert.ok(label.box.r <= g.w + 6, `${size} ${width}: clear of the rows' text`);
    assert.equal(label.halo, false, `${size} ${width}: a clear place was found`);
    assert.deepEqual(crossing(g, label.box), [], `${size} ${width}: no trace runs through the label`);
  }
});

test('with copper through every place, the label gets a halo rather than going missing', { skip }, () => {
  const g = graphLayout({ commits: trunkOf(4), agents: [], branch: 'main', head: hexId(1), width: 561 }, GRAPH_SIZES.M);
  const n = g.nodes.find(x => x.kind === 'head');
  // a trace across the whole row band around HEAD, above and below it
  const crowded = { ...g, edges: [...g.edges, { kind: 'lane', pts: [[0, n.y - 40], [g.w + 40, n.y - 40], [g.w + 40, n.y + 40], [0, n.y + 40], [0, n.y - 16], [g.w + 40, n.y - 16], [g.w + 40, n.y + 16], [0, n.y + 16]] }] };
  const { label } = gs.headLabelPlace(crowded, LABEL_W);
  assert.ok(label);
  assert.equal(label.halo, true);
});

// ---------------------------------------------------------------- focus rings on the card's surface
const CSS = readFileSync(new URL('../ui/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Every rule of app.css (outside @media blocks too): { selectors: string[], body: string }. */
function rules(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selectors: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')), body: m[2] });
  return out;
}
const resolve = (vars, name, depth = 0) => { const v = vars[name]; const m = /^var\(--([\w-]+)\)$/.exec(v || ''); return m && depth < 5 ? resolve(vars, m[1], depth + 1) : v; };

test('focus rings on the card’s surface (the git detail, the git screen’s input, the menus) clear 3:1 on it in every look', () => {
  const pal = palettes(CSS);
  const onCard = rules(CSS).filter(r => r.selectors.some(s => /:focus/.test(s) && /#gitDetail|#gitBar|\.pop\b/.test(s)));
  assert.ok(onCard.length >= 4, 'the detail, its diff, the input and the menus each have a focus rule');
  const bad = [];
  for (const r of onCard) {
    for (const [, prop, value] of r.body.matchAll(/(outline(?:-color)?|box-shadow)\s*:\s*([^;]+)/g)) {
      for (const [, name] of value.matchAll(/var\(--([\w-]+)\)/g)) {
        for (const t of THEMES) {
          const c = resolve(pal[t], name);
          for (const bg of ['card-1', 'card-2']) {
            const r2 = ratio(c, resolve(pal[t], bg));
            if (!(r2 >= 3)) bad.push(`${t}: ${r.selectors.join(', ')} ${prop} --${name} ${c} on --${bg} is ${r2.toFixed(2)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('the detail’s buttons take the card’s focus colour, not the board’s', () => {
  const r = rules(CSS).filter(x => x.selectors.includes('#gitDetail button:focus-visible'));
  assert.ok(r.length, 'a focus rule for the buttons in the detail');
  assert.match(r.at(-1).body, /outline(-color)?\s*:[^;]*var\(--card-focus\)/);
});

// ------------------------------------------------------------------ the git screen's input: words that could not be sent

/**
 * app.js's gitCommand on its own (node:vm: app.js runs only in the page), with stand-ins for what it calls. `link`: the
 * page's connection; `command`: the request to POST /api/command. Gives what was sent, what it said under the band, and
 * what it put back in the git screen's input.
 */
function gitCommandIn({ link = 'live', command }) {
  const APP = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  const start = APP.indexOf('async function gitCommand(');
  const end = APP.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'app.js has gitCommand');
  const said = [], back = [], sent = [];
  const sandbox = {
    // the page's key guard, for a stand-in of a key (no key-shaped text is needed here)
    refuseKey: t => t === 'A-KEY-STAND-IN', touch() {}, gitScreenWords: () => null, closeGit() {}, pageCommand: () => null, applyPref() {},
    say: t => said.push(t), cannotSend: s => s === 'stale', linkNow: () => link, S: { confirm: null },
    api: { command: async (t, b) => { sent.push(t); return command(t, b); }, confirm: async () => ({}) },
    lookAt() {}, lookedAt() {}, openGit() {}, moved() {}, showConnect() {}, render() {}, ID_RE: /^[0-9a-f]{6,}$/,
    gitPutBack: t => back.push(t),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${APP.slice(start, end + 2)}\nthis.gitCommand = gitCommand;`, sandbox);
  return { run: (t, b = {}) => sandbox.gitCommand(t, b), said, back, sent };
}

test('words typed on the git screen that could not be sent go back in its input, lines and all, and the line under the band says why', async () => {
  const paste = 'this fails:\n```js\nfunction total(cart) {\n  return cart.sum();\n}\n```';
  for (const why of ['That is too long to send in one go. The limit is 64 KB.', 'Something went wrong.', 'Workbench isn’t answering. Is it still running?']) {
    const g = gitCommandIn({ command: async () => { throw new Error(why); } });
    await g.run(paste);
    assert.deepEqual(g.sent, [paste], 'sent as typed, its lines kept');
    assert.deepEqual(g.back, [paste], why);
    assert.deepEqual(g.said, [why]);
  }
  // a page that cannot send at all: nothing is sent, and the words are put back
  const stale = gitCommandIn({ link: 'stale', command: async () => assert.fail('nothing is sent') });
  await stale.run('fix the docs');
  assert.deepEqual([stale.sent, stale.back, stale.said], [[], ['fix the docs'], ['Workbench is not answering, so that was not sent.']]);
  // sent: nothing comes back, and the reply is said
  const ok = gitCommandIn({ command: async () => ({ reply: 'Started Claude on “fix the docs”.', agentIds: ['abc123'] }) });
  await ok.run('fix the docs');
  assert.deepEqual([ok.back, ok.said], [[], ['Started Claude on “fix the docs”.']]);
  // a key is never sent, and never put back
  const key = gitCommandIn({ command: async () => assert.fail('a key is never sent') });
  await key.run('A-KEY-STAND-IN');
  assert.deepEqual([key.sent, key.back], [[], []]);
});
