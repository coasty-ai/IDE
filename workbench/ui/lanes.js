// Lanes for life. Each root agent gets one lane, a side and a row, the first time this tab sees it, and keeps it for
// as long as it exists, so an agent is always found where it was. Pure: no DOM, no imports (node:test loads it).
//
// Twelve lanes, six a side. Laptop agents prefer the left and cloud agents the right, unless that side is full or two
// lanes fuller than the other. Rows fill top, bottom, then the middle, mirrored on the two sides. Past twelve agents
// a newcomer gets a side but no row (`row: null`): the dense layout gives it half of a split lane (see denseLanes).

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
   * Give every root that has no lane yet a lane, in the order they started. Existing lanes never change.
   * @param {{ id: string, startedAt?: number, laptop?: boolean }[]} roots
   * @returns {boolean} whether anything was added
   */
  assign(roots) {
    let added = false;
    const fresh = roots.filter(r => r && r.id && !this.map.has(r.id))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.id).localeCompare(String(b.id)));
    for (const r of fresh) {
      const pref = r.laptop ? 'L' : 'R', other = pref === 'L' ? 'R' : 'L';
      const rowsOf = s => new Set([...this.map.values()].filter(l => l.side === s && l.row != null).map(l => l.row));
      let side = pref;
      const full = s => rowsOf(s).size >= ROWS;
      if ((full(pref) && !full(other)) || this.count(pref) - this.count(other) >= 2) side = other;
      const taken = rowsOf(side);
      const row = SIDE_ROWS[side].find(x => !taken.has(x));
      this.map.set(r.id, { side, row: row == null ? null : row });
      added = true;
    }
    if (added) this.save();
    return added;
  }

  /** Forget lanes of agents that no longer exist. Call it only with a full list (a snapshot), never a partial update. */
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
 * its old place (on the half nearer the middle) and newcomers take free rows from the middle outwards.
 * @param {{ id: string }[]} active    roots shown on lanes (finished ones are in the tray)
 * @param {(id: string) => ({ side: 'L'|'R', row: number|null }|null)} laneOf
 * @param {number} [maxRows]           most rows a side can hold at this window height
 * @returns {{ rows: number, at: Map<string, { side: 'L'|'R', row: number }>, overflow: string[] }}
 */
export function denseLanes(active, laneOf, maxRows = Infinity) {
  const perSide = { L: 0, R: 0 };
  for (const a of active) perSide[laneOf(a.id)?.side || 'L']++;
  let k = Math.max(2, Math.ceil(Math.max(perSide.L, perSide.R) / ROWS));
  while (k > 2 && ROWS * k > maxRows) k--;
  const n = ROWS * k;
  const used = { L: new Set(), R: new Set() };
  const at = new Map();
  for (const a of active) {
    const l = laneOf(a.id);
    if (!l || l.row == null) continue;
    const pref = l.row < ROWS / 2 ? k * l.row + k - 1 : k * l.row;
    const cands = Array.from({ length: k }, (_, i) => k * l.row + i).sort((x, y) => Math.abs(x - pref) - Math.abs(y - pref));
    const row = cands.find(r => !used[l.side].has(r));
    if (row != null) { used[l.side].add(row); at.set(a.id, { side: l.side, row }); }
  }
  const middleOut = Array.from({ length: n }, (_, i) => i).sort((x, y) => Math.abs(x - (n - 1) / 2) - Math.abs(y - (n - 1) / 2) || x - y);
  const overflow = [];
  for (const a of active) {
    if (at.has(a.id)) continue;
    let side = laneOf(a.id)?.side || 'L';
    if (used[side].size >= n) side = side === 'L' ? 'R' : 'L';
    const row = middleOut.find(r => !used[side].has(r));
    if (row == null) { overflow.push(a.id); continue; }
    used[side].add(row);
    at.set(a.id, { side, row });
  }
  return { rows: n, at, overflow };
}
