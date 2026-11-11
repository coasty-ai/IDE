// The orbit: agents placed around the centre (you) by how much they need you.
// Inner ring: needs you. Middle ring: working. Outer ring: done or stopped.
// Each agent keeps one fixed direction from the centre and only moves in or out along it, so places stay
// memorable and hover targets stay still. Helpers sit as moons on the outward side of their agent.
// Motion budget: things move when their state changes or when they take a step; at rest the screen is still.
import { lookOf, NEEDS_YOU, DONE } from '/shared/states.mjs';
import { KIND } from '/shared/narrate.mjs';
import { esc } from './util.js';

const GOLDEN = 137.508 * Math.PI / 180;
const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_MOONS = 4;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Which ring a root belongs on: 0 needs you, 1 working, 2 done or stopped. */
export function ringOf(root, agents) {
  if (NEEDS_YOU.has(root.state)) return 0;
  for (const a of agents.values()) if (a.rootId === root.id && a.id !== root.id && NEEDS_YOU.has(a.state)) return 0;
  if (DONE.has(root.state) || ['finished', 'failed', 'stopped'].includes(root.state)) return 2;
  return 1;
}

/** A few words for under a name. */
export function shortStatus(a) {
  switch (a.state) {
    case 'working': case 'starting': {
      if (a.thinking && (!a.now || a.now === 'Thinking')) return 'thinking';
      const n = (a.now && a.now !== 'Starting' ? a.now : a.state).replace(/^Asking a helper to /, 'asking a helper');
      // Up to three words; a long one is cut with an ellipsis rather than dropped, so the status stays meaningful.
      const words = n.replace(/[“”"]/g, '').split(' ').slice(0, 3).join(' ').replace(/[.,:;]+$/, '');
      const lower = words.charAt(0).toLowerCase() + words.slice(1);
      return lower.length > 26 ? lower.slice(0, 25) + '…' : lower;
    }
    case 'waiting_helpers': return 'waiting on helpers';
    case 'needs_ok': return 'needs your OK';
    case 'question': return 'has a question';
    case 'maybe_stuck': return 'might be stuck';
    case 'checks_failed': return 'a check failed';
    case 'done_checked': return 'done and checked';
    case 'done_claimed': return "says it's done";
    default: return lookOf(a.state).label;
  }
}

const KIND_TONE = { [KIND.READ]: 'work', [KIND.SEARCH]: 'work', [KIND.EDIT]: 'ok', [KIND.RUN]: 'need', [KIND.WEB]: 'sleep', [KIND.HELPER]: 'ink', [KIND.PLAN]: 'faint', [KIND.TALK]: 'faint', [KIND.OTHER]: 'faint' };

export class Orbit {
  /**
   * @param {{ stage: HTMLElement, sky: SVGSVGElement, nodes: HTMLElement, ripples: HTMLElement, core: HTMLElement,
   *           onEnter: (id: string, el: HTMLElement) => void, onLeave: (id: string) => void, onPick: (id: string) => void, still?: boolean }} opts
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.items = new Map();      // id -> { el, x, y, vx, vy, tx, ty, s, angle, kind: 'root'|'moon', parentId, born }
    this.angles = new Map();     // root id -> fixed angle
    this.loadAngles();
    this.lines = new Map();      // moon id -> SVG line
    this.frozen = new Set();     // ids that must not move while the pointer is on them
    this.lastSteps = new Map();  // id -> { calls, kinds, at }
    this.primed = false;         // ripples only after the first data set
    this.running = false;
    this.focusId = null;
    this.askNodeId = null;
    this.geom = null;
    this.buildSky();
    addEventListener('resize', () => { this.layout(); this.kick(); });
    this.layout();
    this.bindPointer();
  }

  // ---------- fixed angles, kept for this tab so places survive reloads ----------
  loadAngles() {
    try { for (const [k, v] of JSON.parse(sessionStorage.getItem('wb-angles') || '[]')) this.angles.set(k, v); } catch {}
  }
  saveAngles() {
    try { sessionStorage.setItem('wb-angles', JSON.stringify([...this.angles].slice(-200))); } catch {}
  }
  angleFor(id) {
    if (this.angles.has(id)) return this.angles.get(id);
    // Golden-angle spacing, eased away from the top and bottom where the rings are closest together;
    // then nudge away from any agent that is too close.
    const phi = -Math.PI / 2 + 0.35 + this.angles.size * GOLDEN;
    let a = phi - 0.3 * Math.sin(2 * phi);
    const taken = [...this.angles.values()];
    for (let tries = 0; tries < 24; tries++) {
      const clash = taken.some(t => Math.abs(Math.atan2(Math.sin(a - t), Math.cos(a - t))) < 0.33);
      if (!clash) break;
      a += 0.17;
    }
    this.angles.set(id, a);
    this.saveAngles();
    return a;
  }

  // ---------- geometry ----------
  layout() {
    const r = this.stage.getBoundingClientRect();
    const W = r.width, H = r.height;
    const s = Math.max(0.68, Math.min(1.25, Math.min(W / 1440, H / 860)));
    const coreR = 205 * s;
    const cx = W / 2, cy = H / 2 + 6 * s;
    const rings = [
      { rx: coreR + 140 * s, ry: coreR + 88 * s },
      { rx: coreR + 280 * s, ry: coreR + 150 * s },
      { rx: coreR + 410 * s, ry: coreR + 198 * s },
    ];
    // Keep the outer ring inside the window.
    const maxRx = W / 2 - 70 * s, maxRy = H / 2 - 52 * s;
    for (const ring of rings) { ring.rx = Math.min(ring.rx, maxRx); ring.ry = Math.min(ring.ry, maxRy); }
    this.geom = { W, H, s, coreR, cx, cy, rings };
    this.core.style.setProperty('--core', (coreR * 2).toFixed(0) + 'px');
    this.core.style.left = cx + 'px';
    this.core.style.top = cy + 'px';
    this.drawRings();
  }

  buildSky() {
    this.sky.innerHTML = '';
    this.ringEls = [0, 1, 2].map(i => {
      const e = document.createElementNS(SVGNS, 'ellipse');
      e.setAttribute('class', 'ring r' + i);
      this.sky.appendChild(e);
      return e;
    });
    this.linkLayer = document.createElementNS(SVGNS, 'g');
    this.sky.appendChild(this.linkLayer);
    this.tether = document.createElementNS(SVGNS, 'path');
    this.tether.setAttribute('class', 'tether');
    this.sky.appendChild(this.tether);
  }

  drawRings() {
    const { W, H, cx, cy, rings } = this.geom;
    this.sky.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.sky.setAttribute('width', W);
    this.sky.setAttribute('height', H);
    rings.forEach((r, i) => {
      const e = this.ringEls[i];
      e.setAttribute('cx', cx); e.setAttribute('cy', cy); e.setAttribute('rx', r.rx); e.setAttribute('ry', r.ry);
    });
  }

  // ---------- data ----------
  /** Recompute targets and node contents. Cheap enough to call on every data update. */
  setData(agents, { focusId, askNodeId, labelRootId }) {
    this.focusId = focusId;
    this.askNodeId = askNodeId;
    const { cx, cy, rings, s } = this.geom;
    const seen = new Set();
    const roots = [...agents.values()].filter(a => !a.parentId).sort((a, b) => a.startedAt - b.startedAt);

    for (const root of roots) {
      const angle = this.angleFor(root.id);
      const ring = ringOf(root, agents);
      const R = rings[ring];
      const tx = cx + Math.cos(angle) * R.rx;
      const ty = cy + Math.sin(angle) * R.ry;
      const it = this.ensure(root, 'root', null, cx, cy);
      it.angle = angle; it.ring = ring;
      if (!this.frozen.has(root.id)) { it.tx = tx; it.ty = ty; }
      it.s = 0.94 + 0.08 * (Math.sin(angle) + 1) / 2;   // a little larger towards the bottom, like a tilted plane
      this.paint(it, root, { labelSide: this.labelSide(angle, ty), showLabel: true });
      seen.add(root.id);

      // Moons: helpers on the outward side, at fixed slots.
      const kids = [...agents.values()].filter(a => a.parentId === root.id).sort((a, b) => a.startedAt - b.startedAt);
      const active = kids.filter(k => !['finished', 'failed', 'stopped'].includes(k.state));
      const ended = kids.filter(k => ['finished', 'failed', 'stopped'].includes(k.state));
      const shown = [...active, ...ended.slice(-Math.max(0, MAX_MOONS - active.length))].slice(0, MAX_MOONS)
        .sort((a, b) => a.startedAt - b.startedAt);
      const hiddenCount = kids.length - shown.length;
      const showMoonLabels = labelRootId === root.id;
      const rm = 64 * s;
      shown.forEach((k, i) => {
        // Alternate right and left of the agent along the ring, turned a little inward so the agent's
        // own label (on the outward side) stays clear; the third and fourth sit further round.
        const side = i % 2 === 0 ? 1 : -1;
        const turn = i < 2 ? 0.42 : 1.02;
        let ma = angle + side * (Math.PI / 2 + turn);
        // An agent near the top or bottom edge has its name on the inner side; keep moons off the name.
        const ls = this.labelSide(angle, ty);
        const mdx = Math.cos(ma), mdy = Math.sin(ma);
        if (Math.abs(mdx) * rm < 60 && ((ls === 'below' && mdy > 0.1) || (ls === 'above' && mdy < -0.1))) ma = -ma;
        const mt = this.ensure(k, 'moon', root.id, it.x, it.y);
        mt.parentId = root.id;
        mt.offA = ma; mt.offR = rm;
        mt.s = 1;
        const dx = Math.cos(ma), dy = Math.sin(ma);
        const moonSide = Math.abs(dx) >= 0.35 ? (dx > 0 ? 'right' : 'left') : (dy < 0 ? 'above' : 'below');
        this.paint(mt, k, { labelSide: moonSide, showLabel: showMoonLabels });
        seen.add(k.id);
      });
      // "+N" marker for helpers that did not fit.
      const moreId = 'more:' + root.id;
      if (hiddenCount > 0) {
        const mt = this.ensureMore(moreId, root.id, it.x, it.y, hiddenCount);
        mt.offA = angle + Math.PI; mt.offR = 30 * s;
        seen.add(moreId);
      }
    }
    // Remove nodes that are gone (rare: the engine keeps agents for the session).
    for (const [id, it] of this.items) {
      if (seen.has(id)) continue;
      it.el.remove();
      this.lines.get(id)?.remove();
      this.lines.delete(id);
      this.items.delete(id);
    }
    this.primed = true;
    this.kick();
  }

  /** Labels go on the outward side of an agent, beside it at the far left and right, and never off the window. */
  labelSide(angle, y) {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    if (y < 120) return 'below';
    if (y > this.geom.H - 90) return 'above';
    if (Math.abs(uy) >= 0.5) return uy < 0 ? 'above' : 'below';
    return ux > 0 ? 'right' : 'left';
  }

  ensure(a, kind, parentId, x0, y0) {
    let it = this.items.get(a.id);
    if (it) return it;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'node ' + kind + (this.primed && !this.still ? ' born' : '');
    el.dataset.id = a.id;
    el.setAttribute('role', 'listitem');
    el.innerHTML = '<span class="glyph"><span class="halo"></span><span class="shp"></span></span><span class="lbl"><b></b><i></i></span>';
    this.nodes.appendChild(el);
    it = { el, x: x0, y: y0, vx: 0, vy: 0, tx: x0, ty: y0, s: 1, kind, parentId, sig: '' };
    if (kind === 'moon') {
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('class', 'link');
      this.linkLayer.appendChild(line);
      this.lines.set(a.id, line);
    }
    this.items.set(a.id, it);
    if (this.primed && !this.still) requestAnimationFrame(() => el.classList.remove('born'));
    return it;
  }

  ensureMore(id, parentId, x0, y0, count) {
    let it = this.items.get(id);
    if (!it) {
      const el = document.createElement('span');
      el.className = 'node more';
      el.setAttribute('aria-hidden', 'true');
      this.nodes.appendChild(el);
      it = { el, x: x0, y: y0, vx: 0, vy: 0, tx: x0, ty: y0, s: 1, kind: 'moon', parentId, sig: '' };
      this.items.set(id, it);
    }
    const text = '+' + count;
    if (it.el.textContent !== text) it.el.textContent = text;
    return it;
  }

  /** Update a node's look; only touches the DOM when something visible changed. */
  paint(it, a, { labelSide, showLabel }) {
    const look = lookOf(a.state);
    const status = shortStatus(a);
    const cls = [
      'node', it.kind, 't-' + look.tone, 'st-' + a.state, 'lbl-' + labelSide,
      showLabel ? 'show-lbl' : '', a.id === this.focusId ? 'focused' : '', a.id === this.askNodeId ? 'asking' : '',
    ].filter(Boolean).join(' ');
    const sig = `${cls}|${a.name}|${status}|${look.shape}`;
    if (sig !== it.sig) {
      it.el.className = cls + (it.el.classList.contains('born') ? ' born' : '') + (it.el.classList.contains('cheer') ? ' cheer' : '');
      it.el.querySelector('.shp').innerHTML = `<svg class="sh" aria-hidden="true"><use href="#s-${look.shape}"/></svg>`;
      it.el.querySelector('b').textContent = a.name;
      it.el.querySelector('i').textContent = status;
      it.el.setAttribute('aria-label', `${a.name}, ${look.label}${a.parentId ? ', helper' : ''}`);
      // A one-off bloom when checks pass. Nothing for claims.
      if (it.sig && a.state === 'done_checked' && !it.sig.includes('st-done_checked')) this.cheer(it);
      it.sig = sig;
    }
    this.steps(it, a);
  }

  /** A ripple for each new step, coloured by what kind of step it was. Capped, and never for finished agents. */
  steps(it, a) {
    const prev = this.lastSteps.get(a.id);
    this.lastSteps.set(a.id, { calls: a.toolCalls, kinds: { ...(a.toolKinds || {}) }, at: prev?.at || 0 });
    if (!prev || !this.primed || this.still || REDUCED) return;
    if (a.toolCalls <= prev.calls) return;
    if (!['working', 'starting', 'waiting_helpers'].includes(a.state)) return;
    const now = performance.now();
    if (now - prev.at < 1100) return;
    this.lastSteps.get(a.id).at = now;
    let kind = KIND.OTHER, best = 0;
    for (const [k, v] of Object.entries(a.toolKinds || {})) {
      const d = v - ((prev.kinds || {})[k] || 0);
      if (d > best) { best = d; kind = k; }
    }
    const r = document.createElement('span');
    r.className = 'ripple t-' + (KIND_TONE[kind] || 'faint') + (it.kind === 'moon' ? ' small' : '');
    r.style.transform = `translate3d(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px, 0)`;
    r.addEventListener('animationend', () => r.remove());
    this.ripples.appendChild(r);
  }

  cheer(it) {
    if (this.still || REDUCED) return;
    it.el.classList.remove('cheer');
    void it.el.offsetWidth;
    it.el.classList.add('cheer');
    setTimeout(() => it.el.classList.remove('cheer'), 900);
  }

  // ---------- motion ----------
  kick() {
    if (this.still || REDUCED) { this.settleAll(); return; }
    if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame(t => this.frame(t)); }
  }

  settleAll() {
    for (const it of this.items.values()) {
      this.target(it);
      it.x = it.tx; it.y = it.ty; it.vx = it.vy = 0;
    }
    this.write();
  }

  /** Moons follow their parent's current position. */
  target(it) {
    if (it.kind === 'moon' && it.parentId) {
      const p = this.items.get(it.parentId);
      if (p && !this.frozen.has(it.el.dataset?.id) && !this.frozen.has(it.parentId)) {
        it.tx = p.x + Math.cos(it.offA) * it.offR;
        it.ty = p.y + Math.sin(it.offA) * it.offR * 0.92;
      }
    }
  }

  frame(t) {
    const dt = Math.min(0.033, (t - this.last) / 1000);
    this.last = t;
    const k = 150, c = 2 * Math.sqrt(k) * 0.86;   // a soft spring, just under critical damping
    let moving = false;
    for (const it of this.items.values()) {
      this.target(it);
      const ax = k * (it.tx - it.x) - c * it.vx;
      const ay = k * (it.ty - it.y) - c * it.vy;
      it.vx += ax * dt; it.vy += ay * dt;
      it.x += it.vx * dt; it.y += it.vy * dt;
      if (Math.abs(it.tx - it.x) > 0.25 || Math.abs(it.ty - it.y) > 0.25 || Math.abs(it.vx) > 0.25 || Math.abs(it.vy) > 0.25) moving = true;
      else { it.x = it.tx; it.y = it.ty; it.vx = it.vy = 0; }
    }
    this.write();
    if (moving) requestAnimationFrame(tt => this.frame(tt));
    else this.running = false;
  }

  /** Writes only: transforms, link lines and the tether. Nothing here reads layout. */
  write() {
    for (const [id, it] of this.items) {
      it.el.style.transform = `translate3d(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px, 0) scale(${it.s.toFixed(3)})`;
      it.el.style.zIndex = String(100 + Math.round(it.y / 4));
      const line = this.lines.get(id);
      if (line && it.parentId) {
        const p = this.items.get(it.parentId);
        if (p) {
          line.setAttribute('x1', p.x.toFixed(1)); line.setAttribute('y1', p.y.toFixed(1));
          line.setAttribute('x2', it.x.toFixed(1)); line.setAttribute('y2', it.y.toFixed(1));
        }
      }
    }
    this.drawTether();
  }

  /** A thread from the centre to whichever agent or helper the centre is asking about. */
  drawTether() {
    const it = this.askNodeId && this.items.get(this.askNodeId);
    if (!it) { this.tether.setAttribute('d', ''); this.tether.classList.remove('on'); return; }
    const { cx, cy, coreR } = this.geom;
    const a = Math.atan2(it.y - cy, it.x - cx);
    const sx = cx + Math.cos(a) * (coreR + 4), sy = cy + Math.sin(a) * (coreR + 4);
    const ex = it.x - Math.cos(a) * 22, ey = it.y - Math.sin(a) * 22;
    const mx = (sx + ex) / 2 + Math.cos(a + Math.PI / 2) * 18, my = (sy + ey) / 2 + Math.sin(a + Math.PI / 2) * 18;
    this.tether.setAttribute('d', `M${sx.toFixed(1)},${sy.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`);
    this.tether.classList.add('on');
  }

  // ---------- pointer ----------
  bindPointer() {
    let leaveTimer = null;
    this.nodes.addEventListener('pointerover', e => {
      const n = e.target.closest('.node[data-id]');
      if (!n) return;
      clearTimeout(leaveTimer);
      const id = n.dataset.id;
      this.freeze(id);
      this.onEnter(id, n);
    });
    this.nodes.addEventListener('pointerout', e => {
      const n = e.target.closest('.node[data-id]');
      if (!n || n.contains(e.relatedTarget)) return;
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => { this.unfreeze(); this.onLeave(n.dataset.id); }, 160);
    });
    this.nodes.addEventListener('focusin', e => {
      const n = e.target.closest('.node[data-id]');
      if (n) { this.freeze(n.dataset.id); this.onEnter(n.dataset.id, n); }
    });
    this.nodes.addEventListener('focusout', e => {
      const n = e.target.closest('.node[data-id]');
      if (n) { this.unfreeze(); this.onLeave(n.dataset.id); }
    });
    this.nodes.addEventListener('click', e => {
      const n = e.target.closest('.node[data-id]');
      if (n) this.onPick(n.dataset.id);
    });
  }

  /** Hold a node, its parent and its moons still while the pointer is on them. */
  freeze(id) {
    this.frozen.clear();
    const it = this.items.get(id);
    if (!it) return;
    const rootId = it.kind === 'moon' ? it.parentId : id;
    this.frozen.add(rootId);
    for (const [mid, m] of this.items) if (m.parentId === rootId) this.frozen.add(mid);
  }
  unfreeze() { this.frozen.clear(); }

  /** Where a node is on screen, for placing the hover card. */
  pos(id) {
    const it = this.items.get(id);
    if (!it) return null;
    return { x: it.x, y: it.y, kind: it.kind, cx: this.geom.cx, cy: this.geom.cy, coreR: this.geom.coreR };
  }
}
