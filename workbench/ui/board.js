// The board: draws a layout (layout.js) as an SVG circuit board with HTML chips over it, and moves things only when
// something changes. Chips and helpers are buttons kept by id; wires are SVG kept by key. Nothing is rebuilt
// wholesale, so focus, hover and a slide in progress survive every update.
//
// Motion (none at all with still=1; no travel with reduced motion, which is watched live):
//   a chip slides along its own lane (900 ms) and its copper follows; a line that lights charges from the chip into
//   the core (600 ms) and its pad pops in; a line that goes out drains back (500 ms); pads renumber; the brackets move
//   to what the core shows; a finished chip powers down after its slide (800 ms); one pulse runs along the copper per
//   real step, at most every 1.1 s per agent. A new ask breathes three times, then the board rests.
import { pathD, plen, laneTo, placeCard, sideRoom } from './layout.js';
import { esc, setAttr, setText } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(.2,.7,.2,1)';
const r1 = n => Math.round(n * 10) / 10;
const glyph = (shape, tone, cls = 't') => `<svg class="g ${cls}-${tone}" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-${shape}"/></svg>`;

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

export class Board {
  /**
   * @param {object} o  { boardSvg, wires, parts, core, dram, machines, tray, said, card, hooks, still, reduced }
   *   hooks: { enter(id), leave(id), pick(id), more(rootId), machine(id, el), tray(el) }
   */
  constructor(o) {
    Object.assign(this, o);
    this.nodes = new Map();      // root id -> { el, chip, svg, kids, sig, kidSig, slide }
    this.wiresMap = new Map();   // key -> svg element
    this.prev = null;            // last layout, for motion
    this.boardSig = '';
    this.lastStep = new Map();   // root id -> { calls, at }
    this.roving = null;          // id of the part that holds the board's one tab stop
    this.card = { id: null, sig: '' };
    this.bindEvents();
  }

  get calm() { return !!this.still() || this.reduced() || document.hidden; }

  // ------------------------------------------------------------------ sizes
  setVars(P) {
    const L = P.lid, v = {
      '--l-pt': L.padT + 'px', '--l-px': L.padX + 'px', '--l-pb': L.padB + 'px', '--l-count': L.count + 'px', '--l-h1': L.h1 + 'px', '--l-h1m': L.h1m + 'px',
      '--l-h1l': L.h1l + 'px', '--l-h1xl': L.h1xl + 'px', '--l-meta': L.meta + 'px', '--l-small': L.small + 'px', '--l-btn': L.btn + 'px', '--l-btnh': L.btnh + 'px',
      '--l-btnmin': L.btnmin + 'px', '--l-quiet': L.quiet + 'px', '--l-input': L.input + 'px', '--l-inh': L.inh + 'px', '--l-gap1': L.gap1 + 'px',
      '--l-gap2': L.gap2 + 'px', '--l-gap3': L.gap3 + 'px',
      '--chip-pad': P.chipPad + 'px', '--chip-pad-c': P.chipPadC + 'px', '--nm': P.nm + 'px', '--st': P.st + 'px', '--nm-line': P.nmLine + 'px', '--st-line': P.stLine + 'px',
      '--lead': P.lead + 'px', '--h-name': P.hName + 'px', '--h-sub': P.hSub + 'px', '--hl-line': P.hLine + 'px', '--card-r': P.cardR + 'px',
      '--m-name': P.mName + 'px', '--m-note': P.mNote + 'px', '--finger-h': P.fingerH + 'px', '--silk-sub': P.silkSub + 'px', '--title': P.title + 'px',
    };
    const s = document.documentElement.style;
    for (const k in v) if (s.getPropertyValue(k) !== v[k]) s.setProperty(k, v[k]);
  }

  // ------------------------------------------------------------------ the static board
  paintBoard(G) {
    const P = G.P, b = G.board, c = G.core, W = G.W, H = G.H;
    const dr = G.dram;
    const sig = [W, H, P.name, c.x, c.y, c.h, G.dense, G.nodes.map(n => `${n.id}${n.side}${n.rowIdx}`).join(','), dr ? [dr.x, dr.y, dr.w, dr.wire.x, !!dr.label].join(',') : ''].join('|');
    if (sig === this.boardSig) return;
    this.boardSig = sig;
    let s = `<defs>
      <radialGradient id="goldR" cx="40%" cy="35%" r="70%"><stop class="b-gold-1" offset="0"/><stop class="b-gold-2" offset=".6"/><stop class="b-gold-3" offset="1"/></radialGradient>
      <linearGradient id="sub" x1="0" y1="0" x2="0" y2="1"><stop class="b-sub-1" offset="0"/><stop class="b-sub-2" offset="1"/></linearGradient>
      <radialGradient id="mask" gradientUnits="userSpaceOnUse" cx="${G.cx}" cy="${G.cy}" r="${r1(Math.hypot(W, H) * 0.55)}"><stop class="b-mask-1" offset="0"/><stop class="b-mask-2" offset=".6"/><stop class="b-mask-3" offset="1"/></radialGradient>
      <pattern id="balls" width="8" height="8" patternUnits="userSpaceOnUse" x="${r1(c.x + 4)}" y="${r1(c.y + 4)}"><circle class="ball" cx="4" cy="4" r="1.5"/></pattern>
      <pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle class="b-dot" cx="8" cy="8" r=".85"/></pattern>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter>
      <filter id="blur6"><feGaussianBlur stdDeviation="7"/></filter>
      <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="11" stitchTiles="stitch"/>
        <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  .10 0 0 0 -.02"/></filter>
      <pattern id="grainTile" width="96" height="96" patternUnits="userSpaceOnUse"><rect width="96" height="96" fill="#fff" filter="url(#grain)"/></pattern>
      <linearGradient id="dramBody" x1="0" y1="0" x2="0" y2="1"><stop class="b-chip-1" offset="0"/><stop class="b-chip-2" offset=".55"/></linearGradient>
    </defs>`;
    s += `<rect class="b-bench" width="${W}" height="${H}"/>`;
    s += `<rect class="b-shadow" x="${b.x}" y="${b.y + 4}" width="${b.w}" height="${b.h}" rx="${P.boardR}" fill="#000" filter="url(#blur6)"/>`;
    s += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${P.boardR}" fill="url(#mask)"/>`;
    // a seamless grain tile, not a board-sized noise: the same texture, a fraction of the paint (and of a screenshot's size)
    s += `<rect class="b-grain" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${P.boardR}" fill="url(#grainTile)"/>`;
    s += `<rect class="b-dots" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${P.boardR}" fill="url(#dots)"/>`;
    s += `<rect class="b-edge" x="${b.x + 0.5}" y="${b.y + 0.5}" width="${b.w - 1}" height="${b.h - 1}" rx="${P.boardR}"/>`;
    // each lane's rail: copper under the mask, from its pin on the core out to a via by the board's edge
    for (const n of G.nodes) {
      s += `<path class="rail" d="${pathD(n.lane.pts)}"/>`;
      const v = n.lane.pts[n.lane.pts.length - 1];
      s += `<circle cx="${v[0]}" cy="${v[1]}" r="3.6" fill="url(#goldR)"/><circle class="via-hole" cx="${v[0]}" cy="${v[1]}" r="1.5"/>`;
    }
    if (dr) s += this.dramSvg(G);
    // the core: a package with balls (or leads) on all four sides, pin 1, its courtyard and the designator YOU
    s += `<rect class="b-shadow" x="${c.x}" y="${c.y + 3}" width="${c.w}" height="${c.h}" rx="9" fill="#000" filter="url(#blur6)" opacity=".5"/>`;
    s += `<rect class="pkg" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="8"/>`;
    s += `<rect class="pkg-balls" x="${c.x + 4}" y="${c.y + 4}" width="${c.w - 8}" height="${c.h - 8}" rx="5"/>`;
    // leads (black and gold, ivory): one straight row per side, each centred and stopping short of the corners, so no
    // lead bends round a corner or crosses pin 1
    {
      const inset = P.ring / 2, pitch = 9, lead = 2.4, clear = P.ring + 3;
      const row = (a, b) => { const len = b - a - 2 * clear, n = Math.max(1, Math.floor((len - lead) / pitch) + 1), used = (n - 1) * pitch + lead, s0 = a + clear + (len - used) / 2; return [r1(s0), r1(s0 + used)]; };
      const [hx0, hx1] = row(c.x, c.r), [vy0, vy1] = row(c.y, c.b);
      const y0 = r1(c.y + inset), y1 = r1(c.b - inset), x0 = r1(c.x + inset), x1 = r1(c.r - inset);
      s += `<path class="pkg-leads" d="M${hx0} ${y0}H${hx1}M${hx0} ${y1}H${hx1}M${x0} ${vy0}V${vy1}M${x1} ${vy0}V${vy1}" fill="none" stroke-width="${r1(P.ring * 0.5)}" stroke-dasharray="${lead} ${pitch - lead}" style="stroke: var(--ball)"/>`;
    }
    s += `<path class="pkg-shine" d="M${c.x + 1.5} ${c.y + 9}A7.5 7.5 0 0 1 ${c.x + 9} ${c.y + 1.5}H${c.r - 9}"/>`;
    s += `<path d="M${c.x + 6} ${c.y + 6}h${P.ring - 9}l-${P.ring - 9} ${P.ring - 9}z" fill="url(#goldR)"/>`;
    const m = 9, k = 16, X = c.x - m, Y = c.y - m, X2 = c.r + m, Y2 = c.b + m;
    s += `<path class="court" d="M${X} ${Y + k}V${Y}H${X + k}M${X2 - k} ${Y}H${X2}V${Y + k}M${X2} ${Y2 - k}V${Y2}H${X2 - k}M${X + k} ${Y2}H${X}V${Y2 - k}"/>`;
    for (const [x, y] of G.holes) s += `<circle class="hole-ring" cx="${x}" cy="${y}" r="16.5"/><circle cx="${x}" cy="${y}" r="12" fill="url(#goldR)"/><circle class="hole-in" cx="${x}" cy="${y}" r="6.8"/>`;
    for (const [x, y] of G.fiducials) s += `<circle class="fid" cx="${r1(x)}" cy="${r1(y)}" r="7"/><circle cx="${r1(x)}" cy="${r1(y)}" r="2.6" fill="url(#goldR)"/>`;
    for (const e of [this.boardSvg, this.wires]) { setAttr(e, 'width', W); setAttr(e, 'height', H); setAttr(e, 'viewBox', `0 0 ${W} ${H}`); }
    this.boardSvg.innerHTML = s;
  }

  /**
   * The DRAM (git) under the core: its copper (a bus of thin traces up to the core's bottom edge, and the one wire down
   * to the board's bottom edge, where a lone gold finger takes it off the board to the git screen), the package with
   * its notch, pin 1 and a fine row of pins along each long edge, and the designator U2. The #dram button lies over
   * the package and carries the word git; hovering or focusing it warms this copper (app.css).
   */
  dramSvg(G) {
    const d = G.dram, P = G.P, b = G.board;
    const top = r1(d.y - d.pin), bot = r1(d.y + d.h), cy = r1(d.y + d.h / 2), n = Math.min(5, d.h * 0.18);
    let s = '<g class="dram-cu">';
    for (const x of d.bus) s += `<path class="dram-bus" d="M${x} ${d.busTop}V${top}"/>`;
    s += `<path class="dram-wire" d="M${d.wire.x} ${d.wire.y0}V${d.wire.y1}"/></g>`;
    const fw = 6, fh = P.fingerH;
    s += `<rect class="dram-finger" x="${r1(d.wire.x - fw / 2)}" y="${r1(b.b - fh)}" width="${fw}" height="${fh}" rx="1"/>`;
    s += `<rect class="b-shadow" x="${d.x}" y="${r1(d.y + 2)}" width="${d.w}" height="${d.h}" rx="3" fill="#000" filter="url(#blur6)" opacity=".45"/>`;
    s += '<g class="dram-pins">';
    for (const x of d.pins) s += `<rect x="${r1(x - 0.9)}" y="${top}" width="1.8" height="${d.pin}"/><rect x="${r1(x - 0.9)}" y="${bot}" width="1.8" height="${d.pin}"/>`;
    s += '</g>';
    // the package: a long rectangle with a half-round notch in its left end (pin 1's end)
    const x0 = d.x, x1 = r1(d.x + d.w), y0 = d.y;
    s += `<path class="dram-body" d="M${x0} ${y0}H${x1}V${bot}H${x0}V${r1(cy + n)}A${r1(n)} ${r1(n)} 0 0 0 ${x0} ${r1(cy - n)}Z"/>`;
    s += `<path class="dram-shine" d="M${r1(x0 + 1.5)} ${r1(y0 + 1)}H${r1(x1 - 1.5)}"/>`;
    s += `<circle class="dram-dot" cx="${r1(x0 + 6)}" cy="${r1(bot - 5.5)}" r="1.9"/>`;
    if (d.label) s += `<text class="dram-u2" x="${d.label.x}" y="${r1(d.label.y + d.label.size * 0.36)}" font-size="${d.label.size}" text-anchor="end">U2</text>`;
    return s;
  }

  /** The #dram button over the package (the word git, hover, focus and the click that opens the git screen). */
  placeDram(G) {
    const e = this.dram, d = G.dram;
    if (!e || !d) return;
    Object.assign(e.style, { left: d.x + 'px', top: d.y + 'px', width: d.w + 'px', height: d.h + 'px', fontSize: d.git + 'px' });
  }

  // ------------------------------------------------------------------ chips and helpers
  ensureNode(n) {
    let rec = this.nodes.get(n.id);
    if (rec) return rec;
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = n.id;
    el.innerHTML = `<button class="chip" type="button" tabindex="-1" data-id="${esc(n.id)}" data-kind="chip" aria-expanded="false" aria-controls="card"><span class="nm"></span><span class="st"></span><i class="end l"></i><i class="end r"></i><i class="dot"></i></button>
      <svg class="layer twigs" aria-hidden="true" width="1" height="1"></svg><div class="kids"></div>`;
    this.parts.appendChild(el);
    rec = { el, chip: el.querySelector('.chip'), svg: el.querySelector('.twigs'), kids: el.querySelector('.kids'), sig: '', kidSig: '', pos: '' };
    this.nodes.set(n.id, rec);
    return rec;
  }

  paintNode(G, n, animateGhost) {
    const rec = this.ensureNode(n), { chip } = rec, r = n.r, sh = n.shape;
    const sideL = n.side === 'L';
    const sig = [r.name, sh.lines.join('/'), sh.status, r.mark, r.tone, n.w, n.h, n.lit, !!r.askerId && r.askerId !== r.id, n.ghost, n.side, n.qno, sh.compact, sh.more, r.label, r.machineName].join('|');
    if (sig !== rec.sig) {
      rec.sig = sig;
      chip.classList.toggle('compact', sh.compact);
      const markHtml = glyph(r.mark, r.tone);
      const lines = `<span class="tx">${sh.lines.map(l => `<span>${esc(l)}</span>`).join('')}</span>`;
      chip.querySelector('.nm').innerHTML = sh.more ? lines : markHtml + lines;
      const st = chip.querySelector('.st');
      st.hidden = !sh.more;
      if (sh.more) { st.className = `st t-${r.tone}`; st.innerHTML = `${markHtml}<span>${esc(sh.status)}</span>`; }
      chip.style.width = n.w + 'px'; chip.style.height = n.h + 'px';
      chip.classList.toggle('lit', !!n.lit); chip.classList.toggle('stuck', n.lit === 'stuck');
      chip.classList.toggle('asking', !!r.askerId && r.askerId !== r.id);
      if (chip.classList.contains('ghost') !== n.ghost && animateGhost && n.ghost) {
        // power down after the slide to the edge, then answer hover at once again
        chip.style.transitionDelay = '1100ms';
        clearTimeout(rec.ghostTimer);
        rec.ghostTimer = setTimeout(() => { chip.style.transitionDelay = ''; }, 2200);
      }
      chip.classList.toggle('ghost', n.ghost);
      chip.querySelector('.dot').className = 'dot ' + (sideL ? 'l' : 'r');
      const order = n.qno ? ` Number ${n.qno} of ${G.queueLength} that need you.` : '';
      const status = r.askerId && r.askerId !== r.id ? 'a helper needs you' : r.label;
      chip.setAttribute('aria-label', `${r.name}, ${status}, on ${r.machineName}.${order}`);
    }
    if (n.current) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    // the end leads light where the interrupt runs: towards you, and towards a helper that asks
    const asking = !!r.askerId && r.askerId !== r.id;
    chip.querySelector('.end.l').classList.toggle('hot', (!!n.lit && !sideL) || (asking && sideL && n.freeDir < 0));
    chip.querySelector('.end.r').classList.toggle('hot', (!!n.lit && sideL) || (asking && !sideL && n.freeDir > 0));
    this.paintKids(G, n, rec);
    return rec;
  }

  paintKids(G, n, rec) {
    const P = G.P, list = n.helpers;
    const more = list.more;
    const kidSig = list.map(p => [p.id, p.k.mark, p.k.tone, p.needs, p.ended, p.t, p.i, r1(p.cx), r1(p.cy), p.label ? p.label.l1 + '/' + p.label.l2 + '/' + p.label.anchor : ''].join(':')).join('|')
      + '|' + n.freeDir + '|' + n.w + '|' + n.ghost + (more ? `+${more.n}@${r1(more.x)},${r1(more.y)}` : '');
    if (kidSig === rec.kidSig) return;
    rec.kidSig = kidSig;
    let s = '';
    for (const p of list) if (p.branch) {
      if (p.needs) s += `<path class="tw-glow" d="${pathD(p.branch)}" filter="url(#glow)"/><path class="tw lit" d="${pathD(p.branch)}"/>`;
      else s += `<path class="tw${n.ghost || p.ended ? ' dim' : ''}" d="${pathD(p.branch)}"/>`;
    }
    rec.svg.innerHTML = s;
    const have = new Map([...rec.kids.querySelectorAll('.part')].map(e => [e.dataset.id, e]));
    const labels = new Map([...rec.kids.querySelectorAll('.hl')].map(e => [e.dataset.for, e]));
    for (const p of list) {
      let btn = have.get(p.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'part'; btn.tabIndex = -1;
        btn.dataset.id = p.id; btn.dataset.kind = 'part'; btn.dataset.parent = n.id;
        btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'card');
        rec.kids.appendChild(btn);
      }
      have.delete(p.id);
      btn.className = `part${p.needs ? ' lit' : ''}${p.ended ? ' ended' : ''}`;
      btn.style.width = p.w + 'px'; btn.style.height = p.h + 'px';
      btn.style.left = r1(p.cx - p.w / 2) + 'px'; btn.style.top = r1(p.cy - p.h / 2) + 'px';
      const g = glyph(p.k.mark, p.k.tone);
      if (btn.dataset.g !== g) { btn.innerHTML = g; btn.dataset.g = g; }
      btn.setAttribute('aria-label', `${p.k.name}, helper of ${n.r.name}, ${p.k.label}.`);
      let hl = labels.get(p.id);
      labels.delete(p.id);
      if (p.label) {
        if (!hl) { hl = document.createElement('span'); hl.className = 'hl'; hl.setAttribute('aria-hidden', 'true'); hl.dataset.for = p.id; hl.dataset.box = 'hlabel'; hl.innerHTML = '<b></b><i></i>'; rec.kids.appendChild(hl); }
        hl.className = 'hl' + (p.label.anchor === 'end' ? ' r' : '');
        hl.style.top = r1(p.label.top) + 'px';
        hl.style.left = r1(p.label.x) + 'px';
        hl.style.transform = p.label.anchor === 'end' ? 'translateX(-100%)' : '';
        setText(hl.querySelector('b'), p.label.l1);
        const i = hl.querySelector('i'); setText(i, p.label.l2); i.className = p.needs ? 't-' + p.k.tone : '';
      } else if (hl) hl.remove();
    }
    for (const [, e] of have) e.remove();
    for (const [, e] of labels) e.remove();
    let mb = rec.kids.querySelector('.more');
    if (more) {
      if (!mb) { mb = document.createElement('button'); mb.type = 'button'; mb.className = 'more'; mb.tabIndex = -1; mb.dataset.kind = 'more'; mb.dataset.parent = n.id; mb.dataset.id = n.id + ':more'; rec.kids.appendChild(mb); }
      mb.classList.toggle('small', !!more.small);
      setText(mb, `+${more.n}`);
      mb.setAttribute('aria-label', `${more.n} more helper${more.n === 1 ? '' : 's'} of ${n.r.name}`);
      const h = more.small ? 12 : 16;
      mb.style.top = r1(more.y - h / 2) + 'px';
      if (more.anchor === 'start') { mb.style.left = r1(more.x) + 'px'; mb.style.transform = ''; }
      else { mb.style.left = r1(more.x) + 'px'; mb.style.transform = 'translateX(-100%)'; }
    } else mb?.remove();
  }

  // ------------------------------------------------------------------ wires
  wire(key, tag, attrs, cls) {
    let e = this.wiresMap.get(key);
    if (!e) { e = svgEl(tag, {}, this.wires); e.dataset.key = key; this.wiresMap.set(key, e); }
    for (const k in attrs) setAttr(e, k, attrs[k]);
    if (cls != null) setAttr(e, 'class', cls);
    return e;
  }

  paintWires(G, hoverRoot) {
    const P = G.P, keep = new Set();
    const full = 4000;
    for (const n of G.nodes) {
      const id = n.id;
      keep.add('conn:' + id);
      const conn = this.wire('conn:' + id, 'path', { d: pathD(n.lane.pts) }, 'conn' + (n.lit ? ' under' : '') + (hoverRoot === id && !n.lit ? ' warm' : ''));
      if (!conn.dataset.anim) conn.style.strokeDasharray = `${r1(n.conn)} ${full}`;
      if (n.lit) {
        const pts = laneTo(n.lane, n.near).reverse();   // from the chip into the core: the interrupt runs towards you
        const dl = pathD(pts), stuck = n.lit === 'stuck', cur = n.qno === 1;
        keep.add('glow:' + id); keep.add('lit:' + id); keep.add('pin:' + id);
        this.wire('glow:' + id, 'path', { d: dl, 'stroke-width': cur ? 11 : 8, opacity: cur ? 0.42 : 0.28, filter: 'url(#glow)' }, 'glow' + (stuck ? ' stuck' : ''));
        const lit = this.wire('lit:' + id, 'path', { d: dl, 'stroke-width': cur ? 2.8 : 2.3 }, 'lit' + (stuck ? ' stuck' : ''));
        lit.dataset.len = r1(plen(pts));
        const p0 = n.lane.pts[0];
        this.wire('pin:' + id, 'circle', { cx: p0[0], cy: p0[1], r: 3.2 }, 'pin' + (stuck ? ' stuck' : ''));
      }
      if (n.qno) {
        keep.add('pad:' + id); keep.add('padn:' + id);
        const [x, y] = n.lane.pad, one = n.qno === 1, stuck = n.lit === 'stuck';
        this.wire('pad:' + id, 'circle', { cx: x, cy: y, r: P.padR }, `pad${one ? ' one' : ''}${stuck ? ' stuck' : ''}`);
        const t = this.wire('padn:' + id, 'text', { x, y: r1(y + 4.4), 'text-anchor': 'middle', 'font-size': 12.5 }, `padn${one ? ' one' : ''}`);
        setText(t, String(n.qno));
      }
      if (n.failed) {   // a failed agent's line is cut, like a blown fuse
        const nx = n.lane.mx(n.near + 10), x2 = n.lane.mx(n.near + 26), y = n.lane.y;
        keep.add('fuse:' + id); keep.add('fusem:' + id);
        this.wire('fuse:' + id, 'path', { d: `M${Math.min(nx, x2) - 1} ${y}H${Math.max(nx, x2) + 1}`, 'stroke-width': 5 }, 'fuse-gap');
        this.wire('fusem:' + id, 'path', { d: `M${nx} ${y - 6}v12M${x2} ${y - 6}v12` }, 'fuse-mark');
      }
    }
    // the designator YOU at the courtyard's top-left corner, or its top-right one while a numbered pad sits by the left
    {
      const c = G.core, near = x => G.nodes.some(n => n.qno && n.lane.kind === 'up' && Math.abs(n.lane.pad[0] - x) < 52);
      const right = near(c.x) && !near(c.r), away = near(c.x) && near(c.r) ? 10 : 0;   // both busy: keep clear of the pad
      const y = r1(c.y - 15), tx = right ? r1(c.r - 1) : r1(c.x + 1 - away), dx = right ? r1(c.r + 9 - 2.5) : r1(c.x - 9 + 2.5 - away);
      keep.add('you'); keep.add('youdot');
      this.wire('youdot', 'circle', { cx: dx, cy: r1(c.y - 19), r: 2.6 }, 'you-dot');
      const t = this.wire('you', 'text', { x: tx, y, 'font-size': 11, 'text-anchor': right ? 'end' : 'start' }, 'you');
      setText(t, 'YOU');
    }
    // white corner brackets round the agent the core is showing (a helper's ask brackets its agent)
    const cur = G.nodes.find(n => n.current);
    if (cur) {
      keep.add('brackets');
      const L = P.lead, m = G.dense ? 6 : 9, k = G.dense ? 7 : 10;
      const X = cur.chip.x - L - m, Y = cur.chip.y - L - m, X2 = cur.chip.x + cur.w + L + m, Y2 = cur.chip.y + cur.h + L + m;
      const br = this.wire('brackets', 'path', { d: `M${r1(X)} ${r1(Y + k)}V${r1(Y)}H${r1(X + k)}M${r1(X2 - k)} ${r1(Y)}H${r1(X2)}V${r1(Y + k)}M${r1(X2)} ${r1(Y2 - k)}V${r1(Y2)}H${r1(X2 - k)}M${r1(X + k)} ${r1(Y2)}H${r1(X)}V${r1(Y2 - k)}` }, 'brackets');
      br.dataset.for = cur.id;
    }
    for (const [k] of this.wiresMap) if (k.startsWith('leader') || k.startsWith('pulse') || k.startsWith('out:')) keep.add(k);
    for (const [k, e] of this.wiresMap) if (!keep.has(k)) { e.remove(); this.wiresMap.delete(k); }
    // draw order: connections, fuses, glows, lit lines, pins, pads, brackets, the card's leader
    const rank = k => (k.startsWith('conn') ? 0 : k.startsWith('fuse') ? 1 : k.startsWith('pulse') ? 2 : k.startsWith('glow') ? 3 : k.startsWith('lit') ? 4 : k.startsWith('pin') ? 5 : k.startsWith('pad:') ? 6 : k.startsWith('padn') ? 7 : k.startsWith('out:') ? 2 : k.startsWith('leader') ? 9 : 8);
    const order = [...this.wiresMap.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
    let i = 0;
    for (const [, e] of order) { if (this.wires.children[i] !== e) this.wires.insertBefore(e, this.wires.children[i] || null); i++; }
  }

  // ------------------------------------------------------------------ machines, the tray, words on the board
  paintMachines(G, machines, litId) {
    const have = new Map([...this.machines.children].map(e => [e.dataset.id, e]));
    G.machines.forEach((box, i) => {
      const m = machines[i];
      let el = have.get(m.id);
      if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = 'mach'; el.dataset.id = m.id; el.setAttribute('aria-haspopup', 'dialog'); el.setAttribute('aria-controls', 'pop'); this.machines.appendChild(el); }
      have.delete(m.id);
      const icon = m.awake ? '' : glyph('sleep', 'sleep');
      const note = box.note && m.noteText ? `<small>${esc(m.noteText)}</small>` : '';
      const html = `<span class="lb"><b><i class="led" aria-hidden="true"></i>${icon}<span>${esc(m.name)}</span></b>${note}</span><span class="fingers" aria-hidden="true"></span>`;
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
      el.classList.toggle('off', !m.awake);
      el.classList.toggle('lit', litId === m.id);
      el.setAttribute('aria-label', `${m.name}, ${m.noteText || (m.awake ? 'awake' : 'asleep')}. Open machines.`);
      el.dataset.box = 'machine';
      Object.assign(el.style, { left: r1(box.x) + 'px', top: r1(box.y) + 'px', width: r1(box.w) + 'px', height: r1(box.h) + 'px' });
      if (this.machines.children[i] !== el) this.machines.insertBefore(el, this.machines.children[i] || null);
    });
    for (const [, e] of have) e.remove();
  }

  lightMachine(id) { for (const el of this.machines.children) el.classList.toggle('lit', el.dataset.id === id); }

  paintTray(G, tray) {
    const t = this.tray;
    if (!G.tray || !tray || !tray.count) { t.hidden = true; delete t.dataset.box; return; }
    t.hidden = false;
    const html = `<span class="bank" aria-hidden="true">${tray.marks.slice(0, 8).map(m => `<i>${glyph(m.shape, m.tone)}</i>`).join('')}</span><span><b>${esc(tray.lead)}</b>${esc(tray.rest)}</span>`;
    if (t.dataset.html !== html) { t.innerHTML = html; t.dataset.html = html; }
    t.setAttribute('aria-label', tray.aria);
    Object.assign(t.style, { left: G.tray.x + 'px', top: G.tray.y + 'px', maxWidth: G.tray.w + 40 + 'px' });
    t.dataset.box = 'tray';
  }

  placeTop(G, els) {
    const P = G.P;
    const y = G.brand.y;
    els.brand.style.fontSize = P.title + 'px';
    els.brand.style.left = Math.round(G.brand.x) + 'px'; els.brand.style.top = Math.round(y - P.title * 0.68 - 3) + 'px';
    let x = G.brand.x + els.brand.offsetWidth - 16 + 14;
    for (const e of [els.mode, els.repo, els.conn]) {
      if (e.hidden) continue;
      e.style.fontSize = (e === els.mode ? 10.5 : P.silkSub) + 'px';
      e.style.left = Math.round(x) + 'px'; e.style.top = Math.round(y - (e === els.mode ? 9 : P.silkSub * 0.68)) + 'px';
      x += e.offsetWidth + 12;
    }
    els.spend.style.fontSize = (P.title - 0.5) + 'px';
    els.spend.style.right = Math.round(G.spend.right) + 'px'; els.spend.style.left = 'auto';
    els.spend.style.top = Math.round(y - P.title * 0.68) + 'px';
  }

  placeCore(G) {
    const L = G.lid;
    Object.assign(this.core.style, { left: L.x + 'px', top: L.y + 'px', width: L.w + 'px', height: L.h + 'px' });
  }

  placeSaid(G) {
    const s = this.said, P = G.P;
    Object.assign(s.style, { left: r1(G.said.x) + 'px', top: r1(G.said.y) + 'px', width: r1(G.said.w) + 'px', fontSize: P.silkSub + 'px' });
  }

  // ------------------------------------------------------------------ one render, with motion from the last one
  /**
   * @param {object} G     the layout
   * @param {object} o     { machines, tray, hoverRoot, litMachine, first }
   */
  render(G, o = {}) {
    const prev = this.prev;
    const animate = !!prev && !o.first && !this.calm;
    this.paintBoard(G);
    // a line that goes out drains back into its chip: take it out of the map before the wires repaint drops it
    const draining = [];
    if (prev) for (const pn of prev.nodes) {
      if (!pn.lit) continue;
      const n = G.byId.get(pn.id);
      if (n && n.lit) continue;
      const els = ['glow', 'lit', 'pin'].map(k => { const e = this.wiresMap.get(k + ':' + pn.id); this.wiresMap.delete(k + ':' + pn.id); return e; });
      if (animate) draining.push(els); else for (const e of els) e?.remove();
    }
    const oldPads = new Map();
    if (prev) for (const pn of prev.nodes) if (pn.qno) {
      const n = G.byId.get(pn.id);
      if (n && n.qno === pn.qno) continue;
      const els = ['pad', 'padn'].map(k => { const e = this.wiresMap.get(k + ':' + pn.id); this.wiresMap.delete(k + ':' + pn.id); return e; });
      if (animate) oldPads.set(pn.id, els); else for (const e of els) e?.remove();
    }
    const oldBrackets = this.wiresMap.get('brackets');
    const curNow = G.nodes.find(n => n.current)?.id || null;
    const curWas = prev ? prev.nodes.find(n => n.current)?.id || null : null;
    if (oldBrackets && curNow !== curWas) { this.wiresMap.delete('brackets'); if (!animate) oldBrackets.remove(); }

    for (const n of G.nodes) this.paintNode(G, n, animate);
    for (const [id, rec] of this.nodes) if (!G.byId.has(id)) { rec.el.remove(); this.nodes.delete(id); }
    this.paintWires(G, o.hoverRoot);
    this.placeCore(G);
    this.placeDram(G);
    this.placeSaid(G);
    this.paintMachines(G, o.machines || [], o.litMachine);
    this.paintTray(G, o.tray);

    // chips: place, or slide from where they are now
    for (const n of G.nodes) {
      const rec = this.nodes.get(n.id);
      const to = `translate(${r1(n.chip.x)}px, ${r1(n.chip.y)}px)`;
      const pn = prev && prev.byId.get(n.id);
      if (!animate || !pn) {
        rec.slide?.cancel(); rec.slide = null;
        rec.el.style.transform = to;
        if (animate && !pn) this.arrive(n, rec);
        continue;
      }
      const moved = Math.abs(pn.chip.x - n.chip.x) > 0.5 || Math.abs(pn.chip.y - n.chip.y) > 0.5;
      const startsLit = !!n.lit && !pn.lit;
      const delay = startsLit ? 0 : 420;
      if (moved) {
        let from = `translate(${r1(pn.chip.x)}px, ${r1(pn.chip.y)}px)`;
        if (rec.slide && rec.slide.playState === 'running') { from = getComputedStyle(rec.el).transform; rec.slide.cancel(); }
        rec.el.style.transform = to;
        rec.slide = rec.el.animate([{ transform: from }, { transform: to }], { duration: 900, delay: rec.slide ? 0 : delay, easing: EASE, fill: 'backwards' });
      } else if (rec.el.style.transform !== to && !(rec.slide && rec.slide.playState === 'running')) rec.el.style.transform = to;
      const conn = this.wiresMap.get('conn:' + n.id);
      if (conn && Math.abs(n.conn - pn.conn) > 0.5) {
        conn.dataset.anim = '1';
        conn.style.strokeDasharray = `${r1(n.conn)} 4000`;
        const a = conn.animate([{ strokeDasharray: `${r1(pn.conn)} 4000` }, { strokeDasharray: `${r1(n.conn)} 4000` }], { duration: 900, delay: moved ? delay : 0, easing: EASE, fill: 'backwards' });
        a.finished.then(() => { delete conn.dataset.anim; }, () => { delete conn.dataset.anim; });
      }
      if (pn.kidSig !== rec.kidSig || pn.freeDir !== n.freeDir) {
        rec.kids.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: moved ? delay + 700 : 0, fill: 'backwards' });
        rec.svg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: moved ? delay + 700 : 0, fill: 'backwards' });
      }
      if (startsLit || (n.lit && n.r.askId && pn.askId && n.r.askId !== pn.askId)) this.charge(n, moved ? 950 : 0);
    }
    if (animate) {
      for (const els of draining) {
        const [glow, lit, pin] = els;
        for (const e of [glow, lit]) {
          if (!e) continue;
          this.wires.appendChild(e);
          const L = +(lit?.dataset.len || 300), op = +(e.getAttribute('opacity') || 1);
          e.animate([{ strokeDasharray: `${L} 4000`, opacity: op }, { opacity: op, offset: 0.75 }, { strokeDasharray: `0 4000`, opacity: 0 }], { duration: 500, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' })
            .finished.then(() => e.remove(), () => e.remove());
        }
        if (pin) { this.wires.appendChild(pin); pin.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.then(() => pin.remove(), () => pin.remove()); }
      }
      for (const [, [c, t]] of oldPads) {
        if (c) { this.wires.appendChild(c); c.style.transformBox = 'fill-box'; c.style.transformOrigin = 'center'; c.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 220, delay: 120, fill: 'forwards' }).finished.then(() => c.remove(), () => c.remove()); }
        if (t) { this.wires.appendChild(t); t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 120, fill: 'forwards' }).finished.then(() => t.remove(), () => t.remove()); }
      }
      for (const n of G.nodes) if (n.qno) {
        const pn = prev.byId.get(n.id);
        if (pn && pn.qno === n.qno) continue;
        const c = this.wiresMap.get('pad:' + n.id), t = this.wiresMap.get('padn:' + n.id);
        const at = pn && pn.qno ? 300 : (n.lit && !(pn && pn.lit) ? (pn && Math.abs(pn.chip.x - n.chip.x) > 0.5 ? 1550 : 600) : 300);
        if (c) { c.style.transformBox = 'fill-box'; c.style.transformOrigin = 'center'; c.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 260, delay: at, easing: EASE, fill: 'backwards' }); }
        if (t) t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: at + 60, fill: 'backwards' });
      }
      if (curNow !== curWas) {
        if (oldBrackets) { this.wires.appendChild(oldBrackets); oldBrackets.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished.then(() => oldBrackets.remove(), () => oldBrackets.remove()); }
        const nb = this.wiresMap.get('brackets');
        if (nb) nb.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 420, fill: 'backwards' });
      }
    }
    this.prev = { nodes: G.nodes.map(n => ({ id: n.id, chip: { ...n.chip }, conn: n.conn, lit: n.lit, qno: n.qno, current: n.current, freeDir: n.freeDir, askId: n.r.askId })), byId: null };
    this.prev.byId = new Map(this.prev.nodes.map(x => [x.id, { ...x, kidSig: this.nodes.get(x.id)?.kidSig }]));
    this.G = G;
    this.refreshRoving(G);
  }

  /** A chip seen for the first time after the board was drawn: it fades in where it belongs, and its copper draws out. */
  arrive(n, rec) {
    rec.el.animate([{ opacity: 0, transform: `translate(${r1(n.chip.x)}px, ${r1(n.chip.y + 6)}px)` }, { opacity: 1, transform: `translate(${r1(n.chip.x)}px, ${r1(n.chip.y)}px)` }], { duration: 420, easing: EASE });
    const conn = this.wiresMap.get('conn:' + n.id);
    if (conn && n.conn > 1) {
      conn.dataset.anim = '1';
      conn.animate([{ strokeDasharray: `0 4000` }, { strokeDasharray: `${r1(n.conn)} 4000` }], { duration: 600, delay: 120, easing: EASE, fill: 'backwards' })
        .finished.then(() => { delete conn.dataset.anim; }, () => { delete conn.dataset.anim; });
    }
    if (n.lit) this.charge(n, 300);
  }

  /** A line lights: it charges from the chip into the core, then breathes three times and rests. */
  charge(n, delay) {
    const lit = this.wiresMap.get('lit:' + n.id), glow = this.wiresMap.get('glow:' + n.id), pin = this.wiresMap.get('pin:' + n.id);
    if (!lit) return;
    const L = +lit.dataset.len || 300;
    for (const e of [glow, lit]) {
      if (!e) continue;
      const op = +(e.getAttribute('opacity') || 1);
      e.animate([{ strokeDasharray: `0 4000`, opacity: 0 }, { opacity: op, offset: 0.1 }, { strokeDasharray: `${L} 4000`, opacity: op }], { duration: 600, delay, easing: 'cubic-bezier(.3,.6,.2,1)', fill: 'backwards' });
    }
    pin?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: delay + 570, fill: 'backwards' });
    if (glow) {
      const op = +(glow.getAttribute('opacity') || 0.3);
      glow.animate([{ opacity: op }, { opacity: Math.min(0.85, op * 2.1) }, { opacity: op }], { duration: 1400, delay: delay + 700, iterations: 3, easing: 'ease-in-out' });
    }
  }

  /** One pulse along the copper towards you, for a real step. At most one per agent every 1.1 s. */
  step(id) {
    const n = this.G?.byId.get(id);
    if (!n || !n.connected || this.calm) return;
    const now = performance.now();
    if (now - (this.lastStep.get(id) || -1e9) < 1100) return;
    this.lastStep.set(id, now);
    const pts = laneTo(n.lane, n.near).reverse(), L = plen(pts);
    if (L < 8) return;
    const key = 'pulse:' + id + ':' + Math.round(now);
    const p = this.wire(key, 'path', { d: pathD(pts), 'stroke-width': 2.6, opacity: 0 }, 'pulse');
    const dash = Math.min(16, L * 0.2);
    p.animate([{ strokeDasharray: `${dash} ${L + 40}`, strokeDashoffset: 0, opacity: 0 }, { opacity: 0.95, offset: 0.12 }, { opacity: 0.95, offset: 0.8 }, { strokeDasharray: `${dash} ${L + 40}`, strokeDashoffset: -(L - dash), opacity: 0 }],
      { duration: Math.min(1400, 500 + L * 2.2), easing: 'cubic-bezier(.45,.05,.35,1)' })
      .finished.then(() => { p.remove(); this.wiresMap.delete(key); }, () => { p.remove(); this.wiresMap.delete(key); });
  }

  /**
   * The way to the git screen: one pulse along the DRAM's wire, down to the board's bottom edge (or back up to the DRAM).
   * Resolves when it has run; at once when nothing moves (still, reduced motion, a hidden tab).
   */
  dramPulse(down = true, ms = 320) {
    const d = this.G && this.G.dram;
    if (!d || this.calm) return Promise.resolve();
    const L = d.wire.y1 - d.wire.y0, dash = Math.min(46, Math.max(14, L * 0.3));
    const p = svgEl('path', { d: `M${d.wire.x} ${down ? d.wire.y0 : d.wire.y1}V${down ? d.wire.y1 : d.wire.y0}`, class: 'pulse dram-pulse', 'stroke-width': 3 }, this.wires);
    const a = p.animate([{ strokeDasharray: `${dash} ${L + 80}`, strokeDashoffset: dash, opacity: 0 }, { opacity: 1, offset: 0.12 },
      { strokeDasharray: `${dash} ${L + 80}`, strokeDashoffset: -L, opacity: 0.9 }], { duration: ms, easing: 'cubic-bezier(.45,.05,.55,.95)' });
    return a.finished.then(() => p.remove(), () => p.remove());
  }

  /** Stop every animation of the board at its end (reduced motion switched on, or the tab hidden). */
  settle() {
    for (const a of document.getAnimations()) if (a instanceof Animation && !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)) { try { a.finish(); } catch { a.cancel(); } }
    for (const [k, e] of this.wiresMap) if (k.startsWith('pulse')) { e.remove(); this.wiresMap.delete(k); }
  }

  // ------------------------------------------------------------------ the card beside a chip
  /** Where the thing with this id is drawn: its chip, its part, or the "+N" or tray that holds it. */
  targetOf(id, parentId) {
    const G = this.G;
    if (!G) return null;
    const P = G.P;
    const n = G.byId.get(id);
    if (n) return { n, box: { x: n.chip.x - P.lead, y: n.chip.y - P.lead, w: n.w + 2 * P.lead, h: n.h + 2 * P.lead }, kind: 'chip' };
    const owner = parentId && G.byId.get(parentId);
    if (owner) {
      const p = owner.helpers.find(q => q.id === id);
      if (p) return { n: owner, box: { x: owner.chip.x + p.cx - p.w / 2, y: owner.chip.y + p.cy - p.h / 2, w: p.w, h: p.h }, kind: 'part' };
      if (owner.helpers.more) { const mo = owner.helpers.more; const w = 24, h = 16; return { n: owner, box: { x: owner.chip.x + mo.x - (mo.anchor === 'end' ? w : 0), y: owner.chip.y + mo.y - h / 2, w, h }, kind: 'more' }; }
      return { n: owner, box: { x: owner.chip.x - P.lead, y: owner.chip.y - P.lead, w: owner.w + 2 * P.lead, h: owner.h + 2 * P.lead }, kind: 'chip' };
    }
    if (G.tray) return { n: null, box: { x: G.tray.x, y: G.tray.y, w: G.tray.w, h: G.tray.h }, kind: 'tray' };
    return null;
  }

  /**
   * Show the card for `id` (an agent or helper) with this markup. The markup is only replaced when it changed.
   * @param {{ quiet?: boolean, parentId?: string|null, one?: boolean, width: number }} o
   */
  showCard(id, html, o) {
    const t = this.targetOf(id, o.parentId);
    if (!t) { this.hideCard(); return false; }
    const card = this.cardEl;
    const wasHidden = card.hidden;
    card.style.width = o.width + 'px';
    card.classList.toggle('one', !!o.one);
    card.classList.toggle('calm', !!o.calm);
    if (card.dataset.sig !== id + '\n' + html) { card.innerHTML = html; card.dataset.sig = id + '\n' + html; }
    card.hidden = false;
    // the card goes beside its chip and never on the core: if it cannot, it gets narrower (its words wrap)
    let w = card.offsetWidth, h = card.offsetHeight, p = placeCard(this.G, t.n, t.box, w, h);
    for (const narrower of [sideRoom(this.G), 300, 260, 230]) {
      if (p || narrower >= w) continue;
      card.style.width = Math.max(220, narrower) + 'px';
      w = card.offsetWidth; h = card.offsetHeight;
      p = placeCard(this.G, t.n, t.box, w, h);
    }
    if (!p) {
      const G = this.G, room = sideRoom(G), left = G.core.x - 12 - (G.board.x + 10) >= room;
      card.style.width = Math.max(200, room) + 'px';
      w = card.offsetWidth; h = card.offsetHeight;
      p = { x: left ? G.board.x + 10 : G.core.r + 12, y: Math.max(G.board.y + G.P.topBand - 4, Math.min(t.box.y - h / 2, G.board.b - 10 - h)), side: left ? 'left' : 'right', band: true };
    }
    card.style.left = Math.round(p.x) + 'px'; card.style.top = Math.round(p.y) + 'px';
    this.card = { id, rootId: t.n ? t.n.id : null };
    // hover feedback: the chip lifts, its copper warms, its machine lights, a silkscreen leader draws to the card
    for (const [rid, rec] of this.nodes) {
      rec.chip.classList.toggle('hov', !!t.n && rid === t.n.id && t.kind === 'chip');
      for (const pt of rec.kids.querySelectorAll('.part')) pt.classList.toggle('hov', pt.dataset.id === id);
      const conn = this.wiresMap.get('conn:' + rid);
      if (conn) conn.classList.toggle('warm', !!t.n && rid === t.n.id && !this.G.byId.get(rid)?.lit);
    }
    const tb = t.box;
    let a1, z;
    if (p.side === 'above') { a1 = [tb.x + tb.w / 2, tb.y - 2]; z = [tb.x + tb.w / 2, p.y + h]; }
    else if (p.side === 'below') { a1 = [tb.x + tb.w / 2, tb.y + tb.h + 2]; z = [tb.x + tb.w / 2, p.y]; }
    else if (p.side === 'left') { a1 = [tb.x - 2, tb.y + tb.h / 2]; z = [p.x + w, tb.y + tb.h / 2]; }
    else { a1 = [tb.x + tb.w + 2, tb.y + tb.h / 2]; z = [p.x, tb.y + tb.h / 2]; }
    if (p.band) z = [Math.max(p.x + 20, Math.min(a1[0], p.x + w - 20)), p.side === 'below' ? p.y : p.y + h];
    const ld = this.wire('leader', 'path', { d: `M${r1(a1[0])} ${r1(a1[1])}L${r1(z[0])} ${r1(z[1])}` }, 'leader');
    const dot = this.wire('leaderdot', 'circle', { cx: r1(a1[0]), cy: r1(a1[1]), r: 2.2 }, 'leader-dot');
    // on top of the copper; moved only when it is not already there (a move is a repaint, and this runs every second)
    if (dot.nextSibling || ld.nextSibling !== dot) { this.wires.appendChild(ld); this.wires.appendChild(dot); }
    if (wasHidden && !o.quiet && !this.calm) {
      card.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
      const L = Math.hypot(z[0] - a1[0], z[1] - a1[1]);
      ld.animate([{ strokeDashoffset: L, strokeDasharray: `${L} ${L}` }, { strokeDashoffset: 0, strokeDasharray: `${L} ${L}` }], { duration: 260, easing: 'ease-out' });
    }
    return true;
  }

  hideCard() {
    this.cardEl.hidden = true;
    this.card = { id: null };
    for (const k of ['leader', 'leaderdot']) { this.wiresMap.get(k)?.remove(); this.wiresMap.delete(k); }
    for (const [rid, rec] of this.nodes) {
      rec.chip.classList.remove('hov');
      for (const pt of rec.kids.querySelectorAll('.part')) pt.classList.remove('hov');
      this.wiresMap.get('conn:' + rid)?.classList.remove('warm');
    }
  }

  // ------------------------------------------------------------------ keyboard: one tab stop, arrow keys inside
  order() {
    const G = this.G;
    if (!G) return [];
    const nodes = [...G.nodes].sort((a, b) => (a.side === b.side ? a.chip.y - b.chip.y : a.side === 'L' ? -1 : 1));
    const out = [];
    for (const n of nodes) {
      const rec = this.nodes.get(n.id);
      if (!rec) continue;
      out.push(rec.chip);
      for (const p of n.helpers) { const b = rec.kids.querySelector(`.part[data-id="${CSS.escape(p.id)}"]`); if (b) out.push(b); }
      const mb = rec.kids.querySelector('.more'); if (mb) out.push(mb);
    }
    return out;
  }

  refreshRoving(G) {
    const list = this.order();
    if (!list.length) return;
    const ids = list.map(e => e.dataset.id);
    if (!ids.includes(this.roving)) {
      const cur = G.nodes.find(n => n.current);
      this.roving = cur ? cur.id : ids[0];
    }
    for (const e of list) { const t = e.dataset.id === this.roving ? 0 : -1; if (e.tabIndex !== t) e.tabIndex = t; }
  }

  bindEvents() {
    const kind = e => e.target.closest?.('[data-kind]');
    this.parts.addEventListener('pointerover', e => { const k = kind(e); if (k && k.dataset.kind !== 'more') this.hooks.enter(k.dataset.id, k.dataset.parent || null); });
    this.parts.addEventListener('pointerout', e => {
      const k = kind(e);
      if (!k || k.contains(e.relatedTarget)) return;
      this.hooks.leave(k.dataset.id);
    });
    this.parts.addEventListener('focusin', e => {
      const k = kind(e);
      if (!k) return;
      this.roving = k.dataset.id;
      for (const x of this.order()) x.tabIndex = x === k ? 0 : -1;
      if (k.dataset.kind !== 'more') this.hooks.enter(k.dataset.id, k.dataset.parent || null, true);
    });
    this.parts.addEventListener('focusout', e => {
      const k = kind(e);
      if (k && !this.parts.contains(e.relatedTarget)) this.hooks.leave(k.dataset.id, true);
    });
    this.parts.addEventListener('click', e => {
      const k = kind(e);
      if (!k) return;
      if (k.dataset.kind === 'more') this.hooks.more(k.dataset.parent);
      else this.hooks.pick(k.dataset.id, k.dataset.parent || null);
    });
    this.parts.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = this.order();
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      let j = i;
      if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = list.length - 1;
      else if (e.key === 'ArrowDown') j = (i + 1) % list.length;
      else if (e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
      else {
        // left and right cross to the nearest chip on the other side of the core
        const here = this.G.byId.get(list[i].dataset.parent || list[i].dataset.id);
        const want = e.key === 'ArrowLeft' ? 'L' : 'R';
        if (here && here.side !== want) {
          const other = this.G.nodes.filter(n => n.side === want).sort((a, b) => Math.abs(a.lane.y - here.lane.y) - Math.abs(b.lane.y - here.lane.y))[0];
          if (other) j = list.indexOf(this.nodes.get(other.id).chip);
        } else j = e.key === 'ArrowRight' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      }
      list[j].focus();
    });
    this.machines.addEventListener('click', e => { const m = e.target.closest('.mach'); if (m) this.hooks.machine(m.dataset.id, m); });
    this.machines.addEventListener('pointerover', e => { const m = e.target.closest('.mach'); if (m) m.classList.add('lit'); });
    this.machines.addEventListener('pointerout', e => { const m = e.target.closest('.mach'); if (m && !m.contains(e.relatedTarget)) m.classList.remove('lit'); });
    this.tray.addEventListener('click', () => this.hooks.tray(this.tray));
  }

  /** The part, chip or "+N" that holds keyboard focus on the board, by id. */
  focusPart(id) {
    const e = this.order().find(x => x.dataset.id === id);
    if (e) e.focus({ preventScroll: true });
  }
}
