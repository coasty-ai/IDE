// Lanes. Each root agent on the board gets one lane, a side and a row, when it comes onto the board, and keeps it for as
// long as it stays there, so an agent is always found where it was. One that leaves the board (to the done tray, or
// gone) frees its lane for a newcomer; the others never move, and no agent ever changes sides. Pure: no DOM, no imports
// (node:test loads it).
//
// Twelve lanes, six a side. Laptop agents prefer the left and cloud agents the right, unless that side is full or two
// lanes fuller than the other. Rows fill top, bottom, then the middle, mirrored on the two sides. Past twelve agents
// a newcomer gets a side but no row (`row: null`): the dense layout gives it part of a split lane (see denseLanes), and
// it takes a lane of its own once one is free on its side. The dense layout's places are kept here too, in memory only
// (`dense`), so an agent that leaves a dense board moves no one, and a reload lays the board out afresh.

export const ROWS = 6;
const SIDE_ROWS = { L: [0, 5, 2, 3, 1, 4], R: [5, 0, 3, 2, 4, 1] };
export const LANE_KEY = 'wb-lanes';

export class Lanes {
  /** @param {{ getItem(k: string): string|null, setItem(k: string, v: string): void }|null} storage  sessionStorage */
  constructor(storage = null, key = LANE_KEY) {
    this.storage = storage;
    this.key = key;
    /** @type {Map<string, { side: 'L'|'R', row: number|null }>} */
    this.map = new Map();
    /**
     * While the board is dense, what denseLanes returned last ({ k, want, at }), so who stays keeps their place; null on
     * whole lanes. Kept in memory only: a reload lays the board out afresh.
     */
    this.dense = null;
    try {
      const saved = JSON.parse(storage?.getItem(key) || '[]');
      if (Array.isArray(saved)) {
        for (const e of saved) {
          if (!Array.isArray(e) || typeof e[0] !== 'string' || (e[1] !== 'L' && e[1] !== 'R')) continue;
          const row = Number.isInteger(e[2]) && e[2] >= 0 && e[2] < ROWS ? e[2] : null;
          if (row != null && [...this.map.values()].some(l => l.side === e[1] && l.row === row)) continue;   // never two on one lane
          this.map.set(e[0], { side: e[1], row });
        }
      }
    } catch { /* a damaged entry starts the board afresh */ }
  }

  get(id) { return this.map.get(id) || null; }

  count(side) { let n = 0; for (const l of this.map.values()) if (l.side === side) n++; return n; }

  /**
   * Give every root that has no lane yet a lane, in the order they started. Existing lanes never change, except that a
   * root with a side but no row (it came while every lane was taken) takes a free row on its own side, oldest first.
   * It never takes one on the other side: that would carry it across the core.
   * @param {{ id: string, startedAt?: number, laptop?: boolean }[]} roots   the roots on the board
   * @returns {boolean} whether anything was added
   */
  assign(roots) {
    let added = false;
    const byStart = (a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id));
    const rowsOf = s => new Set([...this.map.values()].filter(l => l.side === s && l.row != null).map(l => l.row));
    const freeRow = s => { const taken = rowsOf(s); const row = SIDE_ROWS[s].find(x => !taken.has(x)); return row == null ? null : row; };
    const fresh = roots.filter(r => r && r.id && !this.map.has(r.id)).sort(byStart);
    for (const r of fresh) {
      const pref = r.laptop ? 'L' : 'R', other = pref === 'L' ? 'R' : 'L';
      let side = pref;
      const full = s => rowsOf(s).size >= ROWS;
      if ((full(pref) && !full(other)) || this.count(pref) - this.count(other) >= 2) side = other;
      this.map.set(r.id, { side, row: freeRow(side) });
      added = true;
    }
    for (const r of roots.filter(x => x && x.id && this.map.get(x.id)?.row === null).sort(byStart)) {
      const { side } = this.map.get(r.id), row = freeRow(side);
      if (row != null) { this.map.set(r.id, { side, row }); added = true; }
    }
    if (added) this.save();
    return added;
  }

  /**
   * Forget the lanes of roots that are not on the board any more (in the done tray, or gone): those lanes are free for
   * newcomers. Call it only with the full list of roots on the board, made from every agent there is (a snapshot and
   * the updates since), never from a partial update, and never before the first snapshot.
   */
  prune(liveIds) {
    const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
    let gone = false;
    for (const id of [...this.map.keys()]) if (!live.has(id)) { this.map.delete(id); gone = true; }
    if (gone) this.save();
    return gone;
  }

  save() {
    try { this.storage?.setItem(this.key, JSON.stringify([...this.map].slice(-400).map(([id, l]) => [id, l.side, l.row]))); } catch { /* full or private */ }
  }
}

/**
 * The dense board, past twelve agents: each of the six lanes a side splits into k rows (k >= 2), so an agent keeps to
 * its old place (on the half nearer the middle) and newcomers take free rows from the middle outwards, on their own side
 * only: no chip ever crosses the core, and one whose side is full waits in the tray. Given what it returned last time
 * (`prev`), it moves no one who stays: they keep their rows, a row that is freed is only taken by a newcomer, and the
 * split never shrinks because some left. It grows when more come than the rows hold, and follows the window's height;
 * then every row is laid out afresh, as the board's size changes anyway. One that needs the person always gets a row:
 * when its side is full it takes the row of the newest one there that does not need them, which waits in the tray.
 * @param {{ id: string, stop?: string, startedAt?: number }[]} active  roots shown on lanes, whatever needs the person first
 *   (finished ones are in the tray)
 * @param {(id: string) => ({ side: 'L'|'R', row: number|null }|null)} laneOf
 * @param {number} [maxRows]           most rows a side can hold at this window height
 * @param {{ k: number, want: number, at: Map<string, { side: 'L'|'R', row: number }> }|null} [prev]  what it returned last time
 * @returns {{ rows: number, k: number, want: number, at: Map<string, { side: 'L'|'R', row: number }>, overflow: string[] }}
 *   want: the split the agents asked for, which the window may cap (k)
 */
export function denseLanes(active, laneOf, maxRows = Infinity, prev = null) {
  const sideOf = id => laneOf(id)?.side || 'L';
  const perSide = { L: 0, R: 0 };
  for (const a of active) perSide[sideOf(a.id)]++;
  // enough rows for the fuller side, and never fewer than last time
  const want = Math.max(2, Math.ceil(Math.max(perSide.L, perSide.R) / ROWS), prev?.want || 0);
  let k = want;
  while (k > 2 && ROWS * k > maxRows) k--;
  const n = ROWS * k;
  const used = { L: new Set(), R: new Set() };
  const at = new Map();
  const take = (id, side, row) => { used[side].add(row); at.set(id, { side, row }); };
  // 1. whoever the board drew as it is now keeps their row
  const kept = prev && prev.k === k && prev.at instanceof Map ? prev.at : null;
  const fresh = [];
  for (const a of active) {
    const p = kept && kept.get(a.id);
    if (p && p.side === sideOf(a.id) && Number.isInteger(p.row) && p.row >= 0 && p.row < n && !used[p.side].has(p.row)) take(a.id, p.side, p.row);
    else fresh.push(a);
  }
  // 2. a newcomer with a lane of its own: beside its old place, on the half nearer the middle
  for (const a of fresh) {
    const l = laneOf(a.id);
    if (!l || l.row == null) continue;
    const pref = l.row < ROWS / 2 ? k * l.row + k - 1 : k * l.row;
    const cands = Array.from({ length: k }, (_, i) => k * l.row + i).sort((x, y) => Math.abs(x - pref) - Math.abs(y - pref));
    const row = cands.find(r => !used[l.side].has(r));
    if (row != null) take(a.id, l.side, row);
  }
  // 3. the others: free rows on their own side, from the middle outwards
  const middleOut = Array.from({ length: n }, (_, i) => i).sort((x, y) => Math.abs(x - (n - 1) / 2) - Math.abs(y - (n - 1) / 2) || x - y);
  const byId = new Map(active.map(a => [a.id, a]));
  const overflow = [];
  for (const a of fresh) {
    if (at.has(a.id)) continue;
    const side = sideOf(a.id);
    let row = middleOut.find(r => !used[side].has(r));
    if (row == null && a.stop === 'inner') {
      // it needs the person: it takes the row of the newest one on its side that does not, which waits in the tray
      const [bumped] = [...at].filter(([id, p]) => p.side === side && byId.get(id)?.stop !== 'inner')
        .sort(([x], [y]) => (byId.get(y).startedAt || 0) - (byId.get(x).startedAt || 0) || String(y).localeCompare(String(x)));
      if (bumped) { at.delete(bumped[0]); overflow.push(bumped[0]); row = bumped[1].row; }
    }
    if (row == null) { overflow.push(a.id); continue; }
    take(a.id, side, row);
  }
  return { rows: n, k, want, at, overflow };
}
