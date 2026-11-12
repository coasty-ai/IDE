// The board's geometry: where the core, every lane, chip, helper, pad and machine go for a window size.
// Pure: no DOM and no imports, so node:test can check it at every window size. Text widths come from `measure`
// (the page passes a canvas measurer; the default uses JetBrains Mono's fixed advance of 0.6 em).
//
// Everything is laid out in CSS pixels from the window size, so text never shrinks with the window. Three size
// classes (S, M, L) pick the type sizes; positions are then derived from the room there is.

export const MONO = 0.6;
export const monoMeasure = (text, px) => Array.from(String(text ?? '')).length * MONO * px;

const lid = o => o;
// The DRAM under the core (git): its package (w, the narrowest it may get, h), its bus to the core, its pins (length and
// pitch), the gap to #said, the wire's place from its right end and the gap the edge connector leaves for the wire, the
// designator U2 (type size and room) and the type size of "git" on its body.
const dram = o => o;
export const SIZES = Object.freeze({
  L: {
    name: 'L', margin: 12, boardR: 18, topBand: 54, botBand: 80, rowPad: 8, pitchMax: 112,
    coreW: 420, coreH: 376, ring: 22, coreMaxH: 460,
    chipH: 54, chipH1: 40, chipPad: 13, nm: 13.5, st: 12.5, nmLine: 15.6, stLine: 14.4, chipMin: 132, chipMax: 236, lead: 5,
    chipHc: 30, chipPadC: 10, diagDense: 14, gapDense: 70, partWc: 16, partHc: 9,
    gapIn: 22, stub: 30, pinOff: 118, gapCorner: 26, cornerClear: 28, midGap: 240, edgePad: 20, cornerIn: 46, cornerStep: 28, diag: 22,
    partW: 22, partH: 12, hName: 11.5, hSub: 11, slotDy: 19, hLine: 14, branch: 19, hGap: 8,
    padR: 10.5, padOff: 17, cardW: 500, cardWCalm: 340, cardR: 196, minTravel: 40,
    title: 13.5, silkSub: 12, mName: 12, mNote: 11.5, fingerH: 24, machMin: 120, machGap: 26, holeClear: 64, trayX: 58,
    lid: lid({ padT: 22, padX: 22, padB: 18, count: 12.5, h1: 21, h1m: 18, h1l: 16, h1xl: 14.5, meta: 12.5, small: 11.5, btn: 13.5, btnh: 38, btnmin: 112, quiet: 12.5, input: 13, inh: 40, gap1: 11, gap2: 15, gap3: 14 }),
    dram: dram({ w: 188, min: 104, h: 32, bus: 19, pin: 4, pitch: 6, gap: 8, wireIn: 16, wireGap: 12, label: 11, labelW: 24, git: 20, lines: 2 }),
  },
  M: {
    name: 'M', margin: 10, boardR: 16, topBand: 46, botBand: 70, rowPad: 6, pitchMax: 98,
    coreW: 364, coreH: 336, ring: 18, coreMaxH: 420,
    chipH: 48, chipH1: 36, chipPad: 11, nm: 13, st: 12, nmLine: 15, stLine: 13.8, chipMin: 120, chipMax: 216, lead: 4,
    chipHc: 28, chipPadC: 9, diagDense: 14, gapDense: 66, partWc: 16, partHc: 9,
    gapIn: 20, stub: 28, pinOff: 112, gapCorner: 22, cornerClear: 26, midGap: 220, edgePad: 16, cornerIn: 44, cornerStep: 28, diag: 20,
    partW: 20, partH: 11, hName: 11, hSub: 11, slotDy: 18, hLine: 13, branch: 14, hGap: 6,
    padR: 10.5, padOff: 15, cardW: 452, cardWCalm: 320, cardR: 180, minTravel: 34,
    title: 13, silkSub: 11.5, mName: 11.5, mNote: 11, fingerH: 20, machMin: 104, machGap: 20, holeClear: 58, trayX: 52,
    lid: lid({ padT: 18, padX: 18, padB: 14, count: 12, h1: 18, h1m: 16, h1l: 15, h1xl: 13.5, meta: 12, small: 11, btn: 13, btnh: 36, btnmin: 104, quiet: 12, input: 12.5, inh: 36, gap1: 9, gap2: 13, gap3: 12 }),
    dram: dram({ w: 164, min: 96, h: 28, bus: 17, pin: 3.5, pitch: 5, gap: 7, wireIn: 14, wireGap: 12, label: 10.5, labelW: 22, git: 17, lines: 2 }),
  },
  S: {
    name: 'S', margin: 8, boardR: 14, topBand: 44, botBand: 64, rowPad: 6, pitchMax: 96,
    coreW: 320, coreH: 300, ring: 16, coreMaxH: 400,
    chipH: 46, chipH1: 34, chipPad: 10, nm: 12.5, st: 11.5, nmLine: 14.4, stLine: 13.2, chipMin: 104, chipMax: 184, lead: 4,
    chipHc: 26, chipPadC: 8, diagDense: 12, gapDense: 54, partWc: 14, partHc: 8,
    gapIn: 16, stub: 22, pinOff: 96, gapCorner: 18, cornerClear: 22, midGap: 150, edgePad: 12, cornerIn: 38, cornerStep: 24, diag: 16,
    partW: 18, partH: 10, hName: 11, hSub: 10.5, slotDy: 16, hLine: 13, branch: 12, hGap: 5,
    padR: 9.5, padOff: 14, cardW: 330, cardWCalm: 290, cardR: 0, minTravel: 26,
    title: 12.5, silkSub: 11.5, mName: 11, mNote: 10.5, fingerH: 18, machMin: 88, machGap: 14, holeClear: 50, trayX: 46,
    lid: lid({ padT: 16, padX: 16, padB: 12, count: 11.5, h1: 16.5, h1m: 15, h1l: 14, h1xl: 13, meta: 11.5, small: 11, btn: 12.5, btnh: 34, btnmin: 96, quiet: 11.5, input: 12, inh: 34, gap1: 8, gap2: 11, gap3: 10 }),
    dram: dram({ w: 144, min: 92, h: 26, bus: 16, pin: 3, pitch: 5, gap: 6, wireIn: 13, wireGap: 10, label: 10.5, labelW: 22, git: 16, lines: 3 }),
  },
});

/**
 * The line under the DRAM (#said): its line height, and the lines the layout always keeps room for (three in the small
 * size, where it is narrowest: the first-run hint can take three lines there).
 */
export const saidLineH = P => P.silkSub * 1.35;
export const saidMinLines = P => P.dram.lines;
/** The first-run hint #said shows: a lit line (its mark and gap are 27 px), then these words. */
export const SAID_HINT = 'a lit line means it needs you';
/** From the core's bottom edge to the top of #said: the DRAM's bus, the package, its lower pins and a gap. */
const dramStack = P => P.dram.bus + P.dram.h + P.dram.pin + P.dram.gap;

export function sizeClass(W, H) {
  if (W >= 1380 && H >= 840) return SIZES.L;
  if (W >= 1180) return SIZES.M;
  return SIZES.S;
}

const r1 = n => Math.round(n * 10) / 10;

/**
 * Break text into lines of at most `max` characters at spaces; a word longer than a line is split.
 * @returns {string[]}
 */
export function wrapWords(text, max) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  const push = w => {
    while (Array.from(w).length > max) { const c = Array.from(w); if (cur) { lines.push(cur); cur = ''; } lines.push(c.slice(0, max).join('')); w = c.slice(max).join(''); }
    if (!cur) cur = w;
    else if (Array.from(cur).length + 1 + Array.from(w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  };
  for (const w of words) push(w);
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Shorten to n characters with an ellipsis, at a word boundary when one is near. */
export function clipTo(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const c = Array.from(t);
  if (c.length <= n) return t;
  if (n <= 1) return '…';
  const cut = c.slice(0, n - 1).join('');
  // a cut that ends where a word ends keeps that word; otherwise back up to the last space, if one is near
  const sp = c[n - 1] === ' ' ? cut.length : cut.lastIndexOf(' ');
  return (sp > n * 0.55 ? cut.slice(0, sp) : cut).replace(/[,.;:\s]+$/, '') + '…';
}

/**
 * The tallest the core may be, and the half-heights it may take so that every row is either clearly beside it (a side
 * lane) or clearly above or below it (a corner lane with room for its 45° bend). Rows never meet a corner.
 */
function coreHalfHeights(G, wantHalf) {
  const P = G.P;
  const top = G.top;
  // the DRAM keeps its room under the core in every size and in dense mode: the core is never so tall that the DRAM and
  // two lines of #said do not fit between it and the edge connector
  const hMax = Math.min(P.coreMaxH / 2, G.cy - top - 6, G.coreBottomMax - G.cy);
  const hMin = Math.min(P.coreH / 2, hMax);
  const sideClear = 10, cornerNeed = G.diag + 10;
  const offs = [...new Set(G.rows.map(r => Math.round(Math.abs(r - G.cy) * 10) / 10))];
  const ok = h => offs.every(o => o <= h - sideClear || o >= h + cornerNeed);
  // candidate half-heights: the wanted one, the limits, and each row's own edges
  const cands = new Set([wantHalf, hMin, hMax]);
  for (const o of offs) { cands.add(o + sideClear); cands.add(o - cornerNeed); }
  const valid = [...cands].filter(h => h >= hMin - 0.01 && h <= hMax + 0.01 && ok(h)).sort((a, b) => a - b);
  const maxValid = valid.length ? valid[valid.length - 1] : hMin;
  const pick = valid.find(h => h >= wantHalf - 0.01) ?? maxValid;
  return { half: pick, maxHalf: maxValid };
}

/** Rows, pitch and the core's limits for a window, before any chip is placed (the lid fitter asks for this first). */
export function frame(W, H, P, { nRows = 6, dense = false } = {}) {
  const G = { W, H, P, dense, nRows };
  const b = G.board = { x: P.margin, y: P.margin, w: W - 2 * P.margin, h: H - 2 * P.margin };
  b.r = b.x + b.w; b.b = b.y + b.h;
  G.top = b.y + P.topBand; G.bottom = b.b - P.botBand;
  G.cx = Math.round(W / 2); G.cy = Math.round((G.top + G.bottom) / 2);
  // the lowest the core's bottom edge may come: the DRAM, its bus and the lines of #said go between it and the connector
  // (a pixel to spare: the core's height and the DRAM's place are rounded)
  G.coreBottomMax = G.bottom - 4 - Math.ceil(saidMinLines(P) * saidLineH(P)) - dramStack(P) - 1;
  G.diag = dense ? P.diagDense : P.diag;
  G.pitch = Math.max(1, Math.min(P.pitchMax, Math.floor((G.bottom - G.top - 2 * P.rowPad) / nRows)));
  G.rows = Array.from({ length: nRows }, (_, i) => Math.round(G.cy + (i - (nRows - 1) / 2) * G.pitch));
  const lim = coreHalfHeights(G, P.coreH / 2);
  G.lidMaxH = Math.floor(2 * lim.maxHalf - 2 * P.ring);
  G.coreHalfMin = lim.half;
  return G;
}

/** How many corner lanes the core's bottom edge holds on each side, beside the DRAM's column at its narrowest. */
export const bottomRanks = P => 1 + Math.floor((P.coreW / 2 - P.dram.min / 2 - (P.padR + 8) - P.cornerIn) / (2 * P.padR + 3));

/**
 * Most rows a side can hold at this height with one-line chips (dense mode), and no more than the core's bottom edge
 * can take under the smallest core: its middle is the DRAM's. The result is never under 12 (two rows a lane).
 */
export function maxDenseRows(H, P) {
  const avail = H - 2 * P.margin - P.topBand - P.botBand - 2 * P.rowPad;
  const byHeight = Math.max(12, Math.floor(avail / (P.chipHc + 2 * P.lead + 6)));
  let most = 12;
  for (let n = 18; n <= byHeight; n += 6) {
    const f = frame(1000, H, P, { nRows: n, dense: true });
    if (f.rows.filter(y => y > f.cy + f.coreHalfMin).length > bottomRanks(P)) break;
    most = n;
  }
  return Math.min(byHeight, Math.max(most, 12));
}

function laneGeom(G, side, rowIdx) {
  const P = G.P, c = G.core, y = G.rows[rowIdx];
  const inSide = y >= c.y + 10 && y <= c.b - 10;
  const mx = x => (side === 'L' ? x : G.W - x);
  let ptsL, kind = 'side', xp = null, pinY = y;
  const D = G.diag;
  if (inSide) {
    // the pins sit nearer the middle of the core's side than the rows do, so outer lanes fan out with a 45° jog
    const pinOff = Math.min(P.pinOff, c.h / 2 - 22);
    if (!G.dense && Math.abs(y - G.cy) > pinOff) pinY = G.cy + Math.sign(y - G.cy) * pinOff;
    const jog = Math.abs(y - pinY);
    ptsL = jog < 1 ? [[c.x + 6, y], [G.viaX, y]] : [[c.x + 6, pinY], [c.x - P.stub, pinY], [c.x - P.stub - jog, y], [G.viaX, y]];
  } else {
    const up = y < c.y; kind = up ? 'up' : 'down';
    // nested pins: the corner row nearest the core takes the pin nearest the corner, so no two lanes cross
    const rank = G.rows.filter(r => (up ? r < c.y && r > y : r > c.b && r < y)).length;
    // the bottom edge keeps its middle for the DRAM's bus: its pins may sit closer together (see placeDram)
    xp = up ? c.x + P.cornerIn + rank * P.cornerStep : c.x + G.downPins.inset + rank * G.downPins.step;
    const ey = up ? c.y + 6 : c.b - 6, s = up ? 1 : -1;
    ptsL = [[xp, ey], [xp, y + s * D], [xp - D, y], [G.viaX, y]];
  }
  const nearInner = inSide ? (G.dense ? c.x - P.gapDense : G.nearInnerSide) : Math.min(xp - D - P.gapCorner, c.x - P.cornerClear);
  const pad = inSide ? [mx(c.x - P.padOff), pinY] : [mx(xp), kind === 'up' ? c.y - P.padOff : c.b + P.padOff];
  // how far towards the core helpers may reach on this lane, before the core, its pad or the lane's bend
  const coreward = inSide ? c.x - P.padOff - P.padR - 6 : xp - D - 8;
  return { side, rowIdx, y, kind, xp, ptsL, pts: ptsL.map(p => [mx(p[0]), p[1]]), nearInner, pad, mx, jogS: Math.sign(pinY - y), coreward };
}

/** Length along the lane from its pin to the point where it reaches x = near (left-side coordinates). */
export function lenTo(lane, near) {
  const p = lane.ptsL; let L = 0;
  for (let i = 1; i < p.length - 1; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L + Math.max(0, p[p.length - 2][0] - near);
}

/** The lane from its pin out to x = near, as points (window coordinates). */
export function laneTo(lane, near) {
  const p = lane.ptsL.slice(0, -1).map(q => q.slice());
  p.push([near, lane.y]);
  return p.map(q => [lane.mx(q[0]), q[1]]);
}

export const pathD = pts => 'M' + pts.map(p => `${r1(p[0])} ${r1(p[1])}`).join('L');
export const plen = pts => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

/** A chip's size and its name split into lines. */
function chipShape(G, r, maxW) {
  const P = G.P, m = G.measure;
  const compact = G.dense;
  const more = G.detail === 'more' && !compact;
  const nmPx = P.nm, stPx = P.st;
  const pad = compact ? P.chipPadC : P.chipPad;
  const markW = 16;                           // the state mark and its gap
  const charW = m('M', nmPx);
  // the name sits after the mark on the first line in calm and compact chips, on its own line in "more"
  const nameIndent = more ? 0 : markW;
  const statusText = more ? (r.status || '') : '';
  const statusW = more ? markW + m(statusText, stPx) : 0;
  const nameW = m(r.name, nmPx);
  const pitchRoom = G.pitch - 2 * P.lead - 8;
  const fixedH = (compact ? 8 : 2 * 9) + (more ? P.stLine + 3 : 0);
  const maxLines = Math.max(1, Math.min(compact ? 2 : 3, Math.floor((pitchRoom - fixedH) / P.nmLine)));
  let inner = Math.max(nameW + nameIndent, statusW);
  const cap = Math.max(60, maxW - 2 * pad - 2);
  let lines = [r.name], clipped = false;
  if (inner > cap) {
    inner = cap;
    const perLine = Math.max(4, Math.floor((cap - nameIndent) / charW));
    lines = wrapWords(r.name, perLine);
    if (lines.length > maxLines) {
      // the last line that fits takes all the words left, cut to its full width (never just the next wrapped line)
      const keep = lines.slice(0, maxLines - 1), norm = String(r.name).replace(/\s+/g, ' ').trim();
      let pos = 0;
      for (const l of keep) pos = norm.indexOf(l, pos) + l.length;
      lines = [...keep, clipTo(norm.slice(pos), perLine)];
      clipped = true;
    }
    inner = Math.max(...lines.map(l => m(l, nmPx) + nameIndent), Math.min(statusW, cap));
  }
  let status = statusText, statusClipped = false;
  if (more && statusW > inner + 0.5) {
    const per = Math.max(4, Math.floor((inner - markW) / m('M', stPx)));
    status = clipTo(statusText, per); statusClipped = status !== statusText;
  }
  const minW = compact ? 0 : (more ? P.chipMin : P.chipMin - 24);
  const w = Math.ceil(Math.max(minW, inner + 2 * pad + 2));
  const nameH = lines.length * P.nmLine;
  const h = compact ? Math.max(P.chipHc, Math.ceil(nameH + 8 + 4)) : Math.ceil(Math.max(more ? P.chipH : P.chipH1, nameH + fixedH + (more ? 0 : 2)));
  return { w, h, lines, clipped, status, statusClipped, compact, more };
}

/**
 * Lay out the board.
 * @param {object} input
 * @param {number} input.W, input.H
 * @param {'calm'|'more'} input.detail
 * @param {object[]} input.roots   [{ id, name, status, stop: 'inner'|'mid'|'edge', lit: 'need'|'stuck'|null, qno, current, ghost,
 *                                    failed, working, kids: [{ id, name, status, needs, ended }] }]
 * @param {(id: string) => ({ side: 'L'|'R', row: number }|null)} input.laneOf  lanes (or dense lanes) by root id
 * @param {number} input.nRows      6, or the dense row count
 * @param {boolean} input.dense
 * @param {number} input.lidNeed    height the lid's content needs, without the input
 * @param {object[]} input.machines [{ id, name, awake, note }]
 * @param {{ count: number, text: string }|null} input.tray
 * @param {(text: string, px: number) => number} [input.measure]
 */
export function layoutBoard(input) {
  const { W, H, detail = 'calm', roots = [], laneOf, nRows = 6, dense = false, lidNeed = 0, machines = [], tray = null } = input;
  const P = input.P || sizeClass(W, H);
  const G = frame(W, H, P, { nRows, dense });
  G.detail = detail;
  G.measure = input.measure || monoMeasure;
  const b = G.board, L = P.lid;
  // the core: tall enough for the lid's content, within the limits, and with its edges between rows
  const want = Math.max(P.coreH, lidNeed + 2 * P.ring + L.padT + L.padB + L.inh + L.gap3);
  const lim = coreHalfHeights(G, want / 2);
  const ch = Math.round(2 * lim.half);
  const c = G.core = { x: G.cx - P.coreW / 2, y: G.cy - ch / 2, w: P.coreW, h: ch };
  c.r = c.x + c.w; c.b = c.y + c.h;
  G.lid = { x: c.x + P.ring, y: c.y + P.ring, w: c.w - 2 * P.ring, h: c.h - 2 * P.ring };
  G.lidPageH = G.lid.h - L.padT - L.padB - L.inh - L.gap3;
  G.lidFits = lidNeed <= G.lidPageH + 0.5;
  placeDram(G);
  const sideRows = G.rows.filter(y => y >= c.y + 10 && y <= c.b - 10);
  const pinOff = Math.min(P.pinOff, c.h / 2 - 22);
  const maxJog = dense ? 0 : Math.max(0, ...sideRows.map(y => Math.abs(y - G.cy) - pinOff));
  G.nearInnerSide = c.x - (P.stub + maxJog + P.gapIn);
  G.edgeFar = b.x + P.edgePad;
  G.viaX = b.x + 10;
  G.nodes = [];
  for (const r of roots) {
    const l = laneOf(r.id);
    if (!l || l.row == null || l.row >= G.rows.length) continue;
    G.nodes.push(nodeGeom(G, r, l));
  }
  G.byId = new Map(G.nodes.map(n => [n.id, n]));
  placeBands(G, { machines, tray });
  return G;
}

/**
 * The DRAM (git), centred under the core: its package, a bus of thin traces up to the core's bottom edge, a fine row of
 * pins along each long edge, the designator U2 at its left when there is room, and one wire from a pin near the right
 * end of its bottom edge straight down to the board's bottom edge: the way to the git screen.
 * The corner lanes that leave the core's bottom edge keep out of its column. Their pins move closer together when they
 * must (never closer than their pads allow), and the DRAM gets narrower, down to its least width, before they do.
 * Pins sit on a grid of `pitch` centred on the core's middle, so the bus, the pins and the wire line up.
 */
function placeDram(G) {
  const P = G.P, c = G.core, D = P.dram;
  const below = G.rows.filter(y => y > c.b).length;        // rows whose lanes leave the core's bottom edge
  const half0 = c.w / 2;
  const clear = P.padR + 8;                                 // from a corner lane's pin (and its pad) to the DRAM
  const room = (inset, step) => half0 - (inset + Math.max(0, below - 1) * step) - clear;
  const inset = P.cornerIn;
  let step = P.cornerStep;
  if (room(inset, step) < D.min / 2 && below > 1) step = Math.max(2 * P.padR + 3, Math.min(step, (half0 - clear - D.min / 2 - inset) / (below - 1)));
  G.downPins = { inset, step };
  const free = room(inset, step);
  const label = free - D.labelW >= D.w / 2;
  const half = Math.max(D.min / 4, Math.min(D.w / 2, free));
  const p = D.pitch, x = G.cx - half, y = c.b + D.bus, w = 2 * half, h = D.h;
  // pin k sits at cx + (k + 0.5) * pitch: clear of the notch on the left end and of the right end
  const kMin = Math.ceil((8 - half) / p - 0.5), kMax = Math.floor((half - 5) / p - 0.5);
  const pins = [];
  for (let k = kMin; k <= kMax; k++) pins.push(r1(G.cx + (k + 0.5) * p));
  const nBus = half >= 4 * p + 10 ? 8 : 6;
  const bus = Array.from({ length: nBus }, (_, i) => r1(G.cx + (i - (nBus - 1) / 2) * p));
  const kw = Math.max(kMin, Math.floor((half - D.wireIn) / p - 0.5));
  const wire = { x: r1(G.cx + (kw + 0.5) * p), y0: r1(y + h + D.pin), y1: G.board.b };
  const lab = label ? { x: r1(x - 7), y: r1(y + h / 2), size: D.label, box: { x: r1(x - D.labelW), y: r1(y + h / 2 - D.label * 0.75), w: D.labelW - 6, h: r1(D.label * 1.5) } } : null;
  G.dram = { x: r1(x), y: r1(y), w: r1(w), h, cx: G.cx, pin: D.pin, pitch: p, pins, bus, busTop: c.b, wire, label: lab, git: D.git };
}

function nodeGeom(G, r, l) {
  const P = G.P, c = G.core;
  const lane = laneGeom(G, l.side, l.row);
  const kids = r.kids || [];
  // the widest a chip may be on this lane: it must fit between the board's edge and its inner stop, with room for
  // its helpers beside it
  const helperRoom = kids.length ? (G.dense ? P.partWc + 16 : P.branch + P.partW + 8) : 0;
  // dense chips have one line, so they may grow past the usual width into the room on their lane (keeping room to slide);
  // a name is cut only when the lane itself is full
  const roomW = lane.nearInner - (G.board.x + P.edgePad) - helperRoom - P.lead;
  const maxW = G.dense ? Math.min(Math.round(P.chipMax * 1.3), Math.max(P.chipMax - 30, roomW - 2 * P.minTravel), roomW) : Math.min(P.chipMax, roomW);
  const shape = chipShape(G, r, maxW);
  const w = shape.w, h = shape.h;
  const nearEdge = G.edgeFar + w;
  const nearIn = Math.max(lane.nearInner, nearEdge);
  let nearMid = c.x - P.midGap;
  if (nearIn - nearEdge >= 2 * P.minTravel) nearMid = Math.max(nearEdge + P.minTravel, Math.min(nearMid, nearIn - P.minTravel));
  else nearMid = (nearIn + nearEdge) / 2;
  const stop = r.stop || 'mid';
  const near = stop === 'inner' ? nearIn : stop === 'mid' ? nearMid : nearEdge;
  const x = l.side === 'L' ? near - w : G.W - near;
  const n = {
    id: r.id, r, side: l.side, rowIdx: l.row, lane, shape, w, h, near, stop,
    chip: { x, y: lane.y - h / 2, w, h },
    lit: r.lit || null, qno: r.qno || null, current: !!r.current,
    connected: stop !== 'edge', ghost: !!r.ghost, failed: !!r.failed, working: !!r.working,
    dirOut: l.side === 'L' ? -1 : 1, compact: shape.compact,
  };
  n.freeDir = stop === 'inner' ? n.dirOut : -n.dirOut;
  // helpers may reach to the core's edge, except where this lane's queue pad sits by the core
  n.coreward = lane.kind === 'side' && !n.qno ? c.x - 12 : lane.coreward;
  n.conn = n.connected ? lenTo(lane, near) : 0;
  n.helpers = helperLayout(G, n, kids);
  return n;
}

/**
 * Helpers hang on the free side of their chip: away from you while it asks, towards you otherwise. In "more" detail
 * up to two show their name and what they are doing, when there is room; the rest are small parts whose card says more.
 * Parts that do not fit fold into "+N".
 */
function helperLayout(G, n, kids) {
  const P = G.P, f = n.freeDir, h = n.h, cy = h / 2, m = G.measure;
  const out = [];
  out.more = null;
  if (!kids.length) return out;
  const end = f > 0 ? n.w + P.lead : -P.lead;     // chip-local x of the chip's end leads on the free side
  // room on the free side, in px from the chip's end
  const chipNear = n.near, chipFar = n.near - n.w;
  const room = f === n.dirOut
    ? (chipFar - P.lead) - (G.edgeFar - 6)        // outwards, to the board's edge
    : n.coreward - (chipNear + P.lead);           // inwards, to the core (or the lane's bend)
  if (G.dense || room < P.branch + P.partW + 4) {
    const wc = P.partWc, hc = P.partHc;
    const fit = room >= 8 + wc + 4 ? Math.min(2, kids.length) : 0;
    const shown = kids.slice(0, fit);
    shown.forEach((k, t) => {
      const sy = cy + (t === 0 ? -1 : 1) * (hc / 2 + 3), x0 = end + f * 8;
      out.push({ id: k.id, k, t, i: 0, cx: x0 + f * wc / 2, cy: sy, w: wc, h: hc, needs: !!k.needs, ended: !!k.ended, label: null,
        branch: [[end, cy + (t === 0 ? -1 : 1) * 4], [end + f * 3, cy + (t === 0 ? -1 : 1) * 4], [end + f * 3, sy], [x0, sy]] });
    });
    if (kids.length > shown.length) {
      // beside the upper part, clear of the copper that runs along the lane's middle
      const x = shown.length ? end + f * (8 + wc + 5) : end + f * 5;
      out.more = { x, y: cy - (hc / 2 + 3) - 1, n: kids.length - shown.length, anchor: f > 0 ? 'start' : 'end', small: true };
    }
    return out;
  }
  const perTrack = Math.max(1, Math.min(3, Math.floor((room - P.branch + 6) / (P.partW + 6))));
  const more = G.detail === 'more';
  const asking = kids.filter(k => k.needs), active = kids.filter(k => !k.ended && !k.needs), ended = kids.filter(k => k.ended);
  // words for up to two helpers that are working or asking, when the words fit beside the part
  let wordy = more && !n.ghost ? [...asking, ...active].slice(0, 2) : [];
  const labelOf = k => {
    const l2 = k.status || '';
    const wName = m(k.name, P.hName), wSub = m(l2, P.hSub);
    return { l1: k.name, l2, w: Math.max(wName, wSub) };
  };
  const labelRoom = room - (P.branch + P.partW + P.hGap) - 4;
  wordy = wordy.filter(k => {
    const lb = labelOf(k);
    if (lb.w <= labelRoom) return true;
    // a shortened name still fits if the room holds at least 14 characters
    return labelRoom >= m('M', P.hName) * 14;
  });
  // a labelled part keeps its track to itself, so with more helpers than that only the first keeps its words
  if (wordy.length === 2 && kids.length > 2) wordy = wordy.slice(0, 1);
  const quiet = (n.ghost ? [...asking, ...active] : [...asking, ...active].filter(k => !wordy.includes(k))).concat(ended);
  const tracks = [[], []];
  wordy.forEach((k, i) => tracks[i].push({ k, words: true }));
  let qi = 0;
  for (let t = 0; t < 2 && qi < quiet.length; t++) if (!tracks[t].length) tracks[t].push({ k: quiet[qi++], words: false });
  for (let t = 0; qi < quiet.length && t < 2; t++) {
    const cap = tracks[t].some(x => x.words) ? 1 : perTrack;    // a labelled part keeps its track to itself
    while (qi < quiet.length && tracks[t].length < cap) tracks[t].unshift({ k: quiet[qi++], words: false });
  }
  const moreN = quiet.length - qi;
  // On a lane that bends towards the core, words facing the core keep to the side away from the bend.
  const away = n.lane.jogS && f === -n.dirOut ? -n.lane.jogS : 0;
  const slotY = t => (away ? cy + away * (P.slotDy + t * (2 * P.hLine + 2)) : cy + (t === 0 ? -1 : 1) * P.slotDy);
  tracks.forEach((tr, t) => {
    if (!tr.length) return;
    const sy = slotY(t), ay = cy + Math.sign(sy - cy) * Math.min(12, Math.abs(sy - cy));
    const jog = Math.abs(sy - ay);
    const x0 = end + f * P.branch;
    const branch = jog <= P.branch - 8 ? [[end, ay], [end + f * 6, ay], [end + f * (6 + jog), sy], [x0, sy]]
      : [[end, ay], [end + f * 6, ay], [end + f * 6, sy - Math.sign(sy - cy) * 6], [end + f * 12, sy], [x0, sy]];
    tr.forEach((it, i) => {
      const nearX = x0 + f * i * (P.partW + 6);
      const item = { id: it.k.id, k: it.k, t, i, cx: nearX + f * P.partW / 2, cy: sy, w: P.partW, h: P.partH, needs: !!it.k.needs, ended: !!it.k.ended, label: null };
      item.branch = i === 0 ? branch : [[nearX - f * 6, sy], [nearX, sy]];
      if (it.words) {
        const lx = nearX + f * (P.partW + P.hGap);
        const lb = labelOf(it.k);
        const maxChars = Math.max(6, Math.floor(labelRoom / m('M', P.hName)));
        const l1 = clipTo(lb.l1, Math.min(28, maxChars)), l2 = clipTo(lb.l2, Math.max(6, Math.floor(labelRoom / m('M', P.hSub))));
        const lw = Math.max(m(l1, P.hName), m(l2, P.hSub));
        item.label = { x: lx, anchor: f > 0 ? 'start' : 'end', top: sy - P.hLine, l1, l2, w: lw, h: 2 * P.hLine, full: lb.l1 };
      }
      out.push(item);
    });
  });
  if (moreN > 0) {
    const lastTrack = tracks[1].length ? 1 : 0;
    const count = tracks[lastTrack].length;
    out.more = { x: end + f * (P.branch + count * (P.partW + 6) + 2), y: slotY(lastTrack), n: moreN, anchor: f > 0 ? 'start' : 'end' };
  }
  return out;
}

/**
 * Every box the board puts something in, in window coordinates: the core, chips (with their leads), helper parts,
 * helper words, "+N" marks, queue pads, machines and the tray. For checks: no two may overlap, and all stay on the board.
 */
export function boardBoxes(G) {
  const P = G.P, out = [];
  const c = G.core;
  out.push({ k: 'core', id: 'core', x: c.x - 9, y: c.y - 9, w: c.w + 18, h: c.h + 18 });
  for (const n of G.nodes) {
    const ox = n.chip.x, oy = n.chip.y;
    out.push({ k: 'chip', id: n.id, x: ox - P.lead, y: oy - P.lead, w: n.w + 2 * P.lead, h: n.h + 2 * P.lead });
    for (const p of n.helpers) {
      out.push({ k: 'part', id: p.id, owner: n.id, x: ox + p.cx - p.w / 2, y: oy + p.cy - p.h / 2, w: p.w, h: p.h });
      if (p.label) {
        const lx = p.label.anchor === 'start' ? ox + p.label.x : ox + p.label.x - p.label.w;
        out.push({ k: 'label', id: p.id, owner: n.id, x: lx, y: oy + p.label.top, w: p.label.w, h: p.label.h });
      }
    }
    if (n.helpers.more) {
      const mo = n.helpers.more, mh = mo.small ? 12 : 16;
      const mw = G.measure('+' + mo.n, mo.small ? 10.5 : P.hSub) + 6;
      const mx = mo.anchor === 'start' ? ox + mo.x : ox + mo.x - mw;
      out.push({ k: 'more', id: n.id + ':more', owner: n.id, x: mx, y: oy + mo.y - mh / 2, w: mw, h: mh });
    }
    if (n.qno) out.push({ k: 'pad', id: n.id + ':pad', owner: n.id, x: n.lane.pad[0] - P.padR, y: n.lane.pad[1] - P.padR, w: 2 * P.padR, h: 2 * P.padR });
  }
  for (const mc of G.machines || []) out.push({ k: 'machine', id: mc.id, x: mc.x, y: mc.y, w: mc.w, h: mc.h });
  if (G.tray) out.push({ k: 'tray', id: 'tray', ...G.tray });
  if (G.dram) {
    const d = G.dram;
    out.push({ k: 'dram', id: 'dram', x: d.x - 1, y: d.y - d.pin, w: d.w + 2, h: d.h + 2 * d.pin });
    if (d.label) out.push({ k: 'dram-label', id: 'U2', ...d.label.box });
  }
  return out;
}

const overlapArea = (a, r) => Math.max(0, Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x)) * Math.max(0, Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y));
export { overlapArea };

/** Every copper line on the board as segments (window coordinates): connections, rails and twigs. */
export function boardSegments(G) {
  const segs = [];
  const add = (pts, who) => { for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i], who]); };
  for (const n of G.nodes) {
    add(laneTo(n.lane, n.near), n.id);
    const far = n.lane.pts[n.lane.pts.length - 1];
    add([[n.lane.mx(n.near - n.w), n.lane.y], far], n.id + ' rail');
    for (const p of n.helpers) if (p.branch) add(p.branch.map(q => [n.chip.x + q[0], n.chip.y + q[1]]), n.id + ' twig');
  }
  return segs;
}

/** The DRAM's own copper (window coordinates): its bus up to the core, and the wire down to the board's bottom edge. */
export function dramSegments(G) {
  const d = G.dram;
  if (!d) return [];
  const segs = d.bus.map(x => [[x, d.busTop], [x, d.y - d.pin], 'dram bus']);
  segs.push([[d.wire.x, d.wire.y0], [d.wire.x, d.wire.y1], 'dram wire']);
  return segs;
}

/** Do two segments cross or touch (beyond `tol` px from their ends)? */
function segsMeet(a, b, tol = 0.5) {
  const [p, q] = a, [r, s] = b;
  const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (Math.abs(d) < 1e-9) {
    // parallel: they meet only if they lie on one line and overlap
    const cross = (r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0]);
    if (Math.abs(cross) > 1e-6) return false;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
    const t0 = (r[0] - p[0]) * ux + (r[1] - p[1]) * uy, t1 = (s[0] - p[0]) * ux + (s[1] - p[1]) * uy;
    return Math.max(Math.min(t0, t1), 0) < Math.min(Math.max(t0, t1), len) - tol;
  }
  const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  const lt = tol / (Math.hypot(q[0] - p[0], q[1] - p[1]) || 1), lu = tol / (Math.hypot(s[0] - r[0], s[1] - r[1]) || 1);
  return t > -lt && t < 1 + lt && u > -lu && u < 1 + lu;
}

const ptSeg = (pt, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(pt[0] - a[0] - t * dx, pt[1] - a[1] - t * dy);
};
/** The least distance between two segments (0 when they meet). */
function segGap(a, b) {
  if (segsMeet(a, b, 0)) return 0;
  return Math.min(ptSeg(a[0], b[0], b[1]), ptSeg(a[1], b[0], b[1]), ptSeg(b[0], a[0], a[1]), ptSeg(b[1], a[0], a[1]));
}

const segHitsBox = (p, q, t) => {
  const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
  for (let s = 0; s <= steps; s++) {
    const x = p[0] + (q[0] - p[0]) * s / steps, y = p[1] + (q[1] - p[1]) * s / steps;
    if (x > t.x + 0.5 && x < t.x + t.w - 0.5 && y > t.y + 0.5 && y < t.y + t.h - 0.5) return true;
  }
  return false;
};

/** Problems with a laid-out board: overlapping boxes, words on copper, and boxes off the board. Empty when all is well. */
export function boardProblems(G) {
  const boxes = boardBoxes(G), bad = [], bd = G.board;
  for (const x of boxes) {
    if (x.x < bd.x - 0.5 || x.y < bd.y - 0.5 || x.x + x.w > bd.r + 0.5 || x.y + x.h > bd.b + 0.5) bad.push(`${x.k} ${x.id} off the board`);
  }
  const segs = boardSegments(G);
  for (const t of boxes.filter(x => x.k === 'label' || x.k === 'more' || x.k === 'tray' || x.k === 'machine' || x.k === 'dram' || x.k === 'dram-label')) {
    for (const [p, q, who] of segs) if (segHitsBox(p, q, t)) { bad.push(`${t.k} ${t.id} on copper of ${who}`); break; }
  }
  // the DRAM's bus and wire: clear of every box but the DRAM itself (and the core, where the bus starts), and of all
  // other copper by at least 4 px
  const dsegs = dramSegments(G);
  for (const t of boxes) {
    if (t.k === 'dram' || t.k === 'core') continue;
    for (const [p, q, who] of dsegs) if (segHitsBox(p, q, t)) { bad.push(`${who} × ${t.k} ${t.id}`); break; }
  }
  for (const [p, q, who] of dsegs) {
    for (const [a, b2, other] of segs) if (segsMeet([p, q], [a, b2]) || segGap([p, q], [a, b2]) < 4) { bad.push(`${who} near copper of ${other}`); break; }
  }
  if (G.said) {
    const s = { x: G.said.x, y: G.said.y, w: G.said.w, h: Math.min(G.said.lines ? G.said.lines * saidLineH(G.P) : 48, G.said.maxY - G.said.y) };
    for (const [p, q, who] of segs.concat(dsegs)) if (segHitsBox(p, q, s)) { bad.push(`said on copper of ${who}`); break; }
    for (const x of boxes) if (x.k !== 'core' && overlapArea(s, x) > 1) bad.push(`said × ${x.k} ${x.id}`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], q = boxes[j];
    // a chip's own parts sit beside it on twigs, never on it; a pad sits on its own lane by the core
    if (a.k === 'core' && q.k === 'pad' || q.k === 'core' && a.k === 'pad') continue;
    const o = overlapArea(a, q);
    if (o > 1) bad.push(`${a.k} ${a.id} × ${q.k} ${q.id}`);
  }
  return bad;
}

/**
 * Where a card of size w×h goes beside `target` (a box in window coordinates): never on the core, inside the board,
 * off its own chip and helpers, and over as little else as it can (lit lines count most). Returns { x, y, side }.
 * `n` is the node the card belongs to (its own boxes are avoided hardest); `ownerId` names it when n is undrawn.
 */
export function placeCard(G, n, target, w, h) {
  const b = G.board, M = 10, gap = 14, P = G.P;
  const lid = { x: G.core.x - 12, y: G.core.y - 12, w: G.core.w + 24, h: G.core.h + 24 };
  const boxes = boardBoxes(G);
  const mine = x => n && (x.id === n.id || x.owner === n.id);
  const own = boxes.filter(mine);
  const soft = [];
  for (const x of boxes) if (x.k !== 'core' && !mine(x)) soft.push({ r: x, wgt: x.k === 'machine' ? 1 : G.byId.get(x.owner || x.id)?.lit ? 6 : 2 });
  for (const o of G.nodes) if (o.lit && o !== n) {
    const pts = laneTo(o.lane, o.near), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    soft.push({ r: { x: Math.min(...xs) - 6, y: Math.min(...ys) - 6, w: Math.max(...xs) - Math.min(...xs) + 12, h: Math.max(...ys) - Math.min(...ys) + 12 }, wgt: 8 });
  }
  soft.push({ r: { x: b.x, y: b.y, w: b.w, h: P.topBand - 6 }, wgt: 0.5 });
  const xs = [b.x + M, b.r - M - w, lid.x - w - 1, lid.x + lid.w + 1, target.x + target.w / 2 - w / 2];
  for (let x = b.x + M; x <= b.r - M - w; x += 8) xs.push(x);
  const ys = [b.y + M, b.b - M - h, lid.y - h - 1, lid.y + lid.h + 1, target.y + target.h / 2 - h / 2];
  for (let y = b.y + M; y <= b.b - M - h; y += 8) ys.push(y);
  const cands = [];
  for (const x of xs) cands.push({ x, y: target.y - gap - h, side: 'above' }, { x, y: target.y + target.h + gap, side: 'below' });
  for (const y of ys) cands.push({ x: target.x - gap - w, y, side: 'left' }, { x: target.x + target.w + gap, y, side: 'right' });
  let best = null;
  // the top band (the workbench mark, which opens the look menu, the mode, the repository and spend) is never covered
  const topY = b.y + P.topBand - 4;
  for (const c of cands) {
    if (c.x < b.x + M - 0.5 || c.y < topY - 0.5 || c.x + w > b.r - M + 0.5 || c.y + h > b.b - M + 0.5) continue;
    const box = { x: c.x, y: c.y, w, h };
    if (overlapArea(box, lid) > 0) continue;                                       // never on the core
    if (c.side === 'left' || c.side === 'right') { if (c.y > target.y + target.h / 2 - 14 || c.y + h < target.y + target.h / 2 + 14) continue; }
    else if (c.x > target.x + target.w / 2 - 14 || c.x + w < target.x + target.w / 2 + 14) continue;
    let score = own.reduce((s, r) => s + overlapArea(box, r), 0) * 60;
    for (const o of soft) score += overlapArea(box, o.r) * o.wgt;
    score += Math.abs(c.x + w / 2 - (target.x + target.w / 2)) * 0.08 + Math.abs(c.y + h / 2 - (target.y + target.h / 2)) * 0.08 + (c.side === 'left' || c.side === 'right' ? 0 : 6);
    if (!best || score < best.score) best = { score, ...c };
  }
  if (best) return best;
  // nowhere beside it: the open band above or below the core; otherwise the caller tries a narrower card
  const above = { x: Math.max(b.x + M, Math.min(G.cx - w / 2, b.r - M - w)), y: G.core.y - 16 - h, side: 'above', band: true };
  if (above.y >= topY && overlapArea({ x: above.x, y: above.y, w, h }, lid) === 0) return above;
  const below = { ...above, y: G.core.b + 16, side: 'below' };
  if (below.y + h <= b.b - M && overlapArea({ x: below.x, y: below.y, w, h }, lid) === 0) return below;
  return null;
}

/** The widest a card can be beside the core, on its roomier side. */
export const sideRoom = G => Math.max(G.core.x - 12 - (G.board.x + 10), G.board.r - 10 - (G.core.r + 12)) - 2;

/** The top and bottom bands: brand and spend, the machines on the edge connector, the done tray, the line under the core. */
function placeBands(G, { machines, tray }) {
  const P = G.P, bd = G.board, c = G.core, m = G.measure;
  G.brand = { x: bd.x + 44, y: bd.y + P.topBand / 2 };
  G.spend = { right: G.W - bd.r + 44, y: bd.y + P.topBand / 2 };
  G.holes = [[P.margin + 22, P.margin + 22], [G.W - P.margin - 22, P.margin + 22], [P.margin + 22, G.H - P.margin - 22], [G.W - P.margin - 22, G.H - P.margin - 22]];
  G.fiducials = [[G.cx - P.coreW / 2 - 70, bd.y + P.topBand / 2 + 1], [G.cx + P.coreW / 2 + 70, bd.y + P.topBand / 2 + 1]];
  G.you = { x: c.x - 9 + 10, y: c.y - 9 - 6, dotX: c.x - 9 + 2.5, dotY: c.y - 9 - 10 };
  // the done tray sits in the bottom band at the left, beside the mounting hole
  const bandY = bd.b - P.botBand;
  G.tray = null;
  if (tray && tray.count > 0) {
    const tw = Math.max(m(tray.text, P.silkSub), Math.min(tray.count, 8) * 16) + 12;
    G.tray = { x: bd.x + P.trayX, y: bandY + 10, w: Math.ceil(tw), h: P.botBand - 20 };
  }
  // machines: sections of the gold edge connector under the core, with a gap where the DRAM's wire leaves the board.
  // With one machine, its section goes left of the wire; with more, they sit either side of it.
  const more = G.detail === 'more';
  const lo = (G.tray ? G.tray.x + G.tray.w + 18 : bd.x + P.holeClear), hi = bd.r - P.holeClear;
  const wx = G.dram ? G.dram.wire.x : null, wg = P.dram.wireGap;
  const sec = (mc, note) => {
    const nameW = m(mc.name, P.mName) + 8 + 7 + (mc.awake ? 0 : 18);
    return Math.ceil(Math.max(P.machMin, Math.max(nameW, note ? m(mc.note || '', P.mNote) : 0) + 20));
  };
  const span = (ws, gap) => ws.reduce((s, w) => s + w, 0) + gap * Math.max(0, ws.length - 1);
  // left of the wire: the first k sections, packed against its gap; the rest start after it
  const placeAt = (widths, gap, k) => {
    const n = widths.length, xs = [];
    if (wx == null) { let x = Math.max(lo, Math.min(G.cx - span(widths, gap) / 2, hi - span(widths, gap))); for (const w of widths) { xs.push(x); x += w + gap; } }
    else {
      const L = widths.slice(0, k), endL = n === 1 ? Math.min(G.cx + widths[0] / 2, wx - wg) : wx - wg;
      let x = endL - span(L, gap);
      for (const w of L) { xs.push(x); x += w + gap; }
      x = wx + wg;
      for (const w of widths.slice(k)) { xs.push(x); x += w + gap; }
    }
    return n && xs[0] >= lo - 0.5 && xs[n - 1] + widths[n - 1] <= hi + 0.5 ? xs : null;
  };
  const tryAll = (widths, gap) => {
    const n = widths.length, k0 = n === 1 ? 1 : Math.ceil(n / 2);
    // balanced first, then shifted towards the side with room
    for (const k of [k0, ...Array.from({ length: n + 1 }, (_, i) => i).filter(i => i !== k0 && (n !== 1 || i === 1)).sort((a, b) => Math.abs(a - k0) - Math.abs(b - k0))]) {
      const xs = placeAt(widths, gap, k);
      if (xs) return xs;
    }
    return null;
  };
  let notes = more, gap = P.machGap;
  let widths = machines.map(mc => sec(mc, notes));
  let xs = tryAll(widths, gap);
  if (!xs) { gap = Math.min(gap, 12); xs = tryAll(widths, gap); }
  if (!xs && notes) { notes = false; widths = machines.map(mc => sec(mc, false)); xs = tryAll(widths, gap); }
  if (!xs && widths.length) {
    // the last resort: equal sections, as narrow as they must be (never under 64 px)
    const room = hi - lo - (wx == null ? 0 : 2 * wg);
    const each = Math.max(64, Math.floor((room - gap * Math.max(0, widths.length - 1)) / widths.length));
    widths = widths.map(() => each);
    xs = tryAll(widths, gap) || placeAt(widths, gap, Math.ceil(widths.length / 2)) || widths.map((w, i) => lo + i * (w + gap));
  }
  const mh = P.botBand - 8;
  G.machines = machines.map((mc, i) => ({ id: mc.id, x: xs[i], y: bd.b - mh, w: widths[i], h: mh, note: notes }));
  // the one line under the DRAM (the hint, or what Workbench just said): left of the DRAM's wire, and clear of the lanes
  // that leave the core's bottom edge on the left
  const lineH = saidLineH(P);
  if (G.dram) {
    const d = G.dram;
    const leftPins = G.nodes.filter(n => n.lane.kind === 'down' && n.side === 'L').map(n => n.lane.xp - c.x);
    const right = d.wire.x - 12;
    const w = Math.max(48, right - (c.x + (leftPins.length ? Math.max(...leftPins) + P.padR + 12 : 14)));
    const x = right - w;
    const y = r1(d.y + d.h + d.pin + P.dram.gap);
    // a narrow line may take more lines, where the board has the room
    const lines = Math.max(1, Math.min(w < 170 ? 5 : 3, Math.floor((bandY - 4 - y) / lineH + 0.01)));
    G.said = { x: r1(x), y, w: r1(w), maxY: bandY - 4, lines };
  } else {
    const bottomRanks = G.nodes.filter(n => n.lane.kind === 'down').map(n => n.lane.xp - c.x);
    const side = bottomRanks.length ? Math.max(...bottomRanks) + P.padR + 12 : 14;
    G.said = { x: c.x + side, y: c.b + (P.name === 'L' ? 16 : 13), w: Math.max(120, c.w - 2 * side), maxY: bandY - 4, lines: 3 };
  }
}

/**
 * How many lines a text takes in #said at its width (JetBrains Mono, wrapped at spaces); the first-run hint also has its
 * lit line before the words. For checks: what #said shows must fit the room the layout gave it.
 */
export function saidTextLines(G, text, { hint = false } = {}) {
  const P = G.P, m = G.measure || monoMeasure;
  const perLine = Math.max(4, Math.floor((G.said.w - (hint ? 27 : 0)) / m('M', P.silkSub)));
  return wrapWords(text, perLine).length;
}
