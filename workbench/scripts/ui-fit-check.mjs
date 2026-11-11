// Text fits, always: loads the page against the mock API (scripts/ui-mock.mjs) in headless Chrome and checks, for every
// scenario, window size, detail level and look, that no visible text falls outside its box, no text is clipped, nothing
// is off-screen, and the board's boxes do not overlap. Visually hidden screen-reader text is allowed; so is the one
// marked scroll box that holds a long command or question in full ([data-scroll]), and one-line clips whose full text is
// elsewhere ([data-clip-ok]). Not part of npm test (it needs Chrome). No dependencies.
//
//   node scripts/ui-fit-check.mjs [--size 1280x680] [--scenario demo] [--theme ivory] [--detail more] [--view card] [--quick] [--verbose]
//
// Exits 1 on any problem, after printing them. CHROME_BIN overrides the Chrome path.
import { startMock, SCENARIOS } from './ui-mock.mjs';
import { launch, sleep } from './ui-cdp.mjs';

const SIZES = ['960x900', '1024x700', '1280x680', '1440x789', '1512x862', '1728x1000', '1920x970', '2560x1300'];
const THEMES = ['green', 'black-gold', 'ivory'];
const DETAILS = ['calm', 'more'];
const VIEWS = ['card-root', 'card-helper', 'card-pinned', 'machines', 'menu', 'tray', 'exact', 'reply', 'notice', 'confirm', 'stale', 'no-key', 'connecting', 'reconnecting', 'motion', 'swap'];

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const only = (list, k) => (opt(k) ? list.filter(x => opt(k).split(',').includes(x)) : list);
const quick = args.includes('--quick'), verbose = args.includes('--verbose');
const sizes = only(SIZES, 'size'), themes = only(quick ? ['green'] : THEMES, 'theme'), details = only(DETAILS, 'detail');
const scenarios = only(SCENARIOS, 'scenario'), views = opt('view') ? only(VIEWS, 'view') : (opt('scenario') ? [] : VIEWS);

// ------------------------------------------------------------------ the browser (scripts/ui-cdp.mjs)
async function launchAt(width, height) {
  const b = await launch({ width, height });
  b.size = (w, h) => b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  return b;
}

// ------------------------------------------------------------------ the check, run in the page
const CHECK = String.raw`(() => {
  const vw = innerWidth, vh = innerHeight, out = [], tol = 0.75;
  const vis = el => {
    if (!el || !el.isConnected || el.closest('[hidden], #probe')) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.02) return false;
    }
    return true;
  };
  const sr = el => !!el.closest('.sr');
  const label = el => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.'); const t = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 34); return s + (t ? ' "' + t + '"' : ''); };
  // text baselines snap to whole pixels, so a line can sit up to a pixel off its box vertically
  const inside = (r, b) => r.left >= b.left - tol && r.top >= b.top - 1.25 && r.right <= b.right + tol && r.bottom <= b.bottom + 1.25;
  const boxy = e => e.matches('[data-box], button, .chip, .part, .hl, .mach, .page, .pop, #card, .exact code, .to, kbd, label, .readall');
  // 1. every piece of visible text: on screen, and inside every box it sits in
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    if (!n.data.trim()) continue;
    const p = n.parentElement;
    if (!p || p.closest('svg') || sr(p) || !vis(p)) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    // a text rectangle is the font's content area (about 1.32 em), which can stand a pixel proud of a tight line box;
    // the line box is what the layout gives the text, so measure that
    const lh = parseFloat(getComputedStyle(p).lineHeight);
    const rects = [...range.getClientRects()].filter(r => r.width > 0.5 && r.height > 0.5).map(r => {
      if (!(lh > 0) || lh >= r.height) return r;
      const mid = (r.top + r.bottom) / 2;
      return { left: r.left, right: r.right, top: mid - lh / 2, bottom: mid + lh / 2, width: r.width, height: lh };
    });
    const scroll = p.closest('[data-scroll]');
    const layer = p.closest('#card, #pop, #trayList, #look')?.id || 'board';
    for (const r of rects) {
      if (scroll) { const s = scroll.getBoundingClientRect(); if (r.bottom < s.top || r.top > s.bottom) continue; }
      texts.push({ r, p, n, layer });
      if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) { out.push('off-screen text: ' + label(p)); break; }
      let bad = null;
      for (let e = p; e && e !== document.body; e = e.parentElement) {
        if (scroll && e === scroll) continue;
        if (!boxy(e)) continue;
        if (scroll && scroll.contains(e)) continue;
        const b = e.getBoundingClientRect();
        const rr = scroll ? { left: r.left, right: r.right, top: Math.max(r.top, scroll.getBoundingClientRect().top), bottom: Math.min(r.bottom, scroll.getBoundingClientRect().bottom) } : r;
        if (!inside(rr, b)) { bad = e; break; }
      }
      if (bad) { out.push('text outside its box: ' + label(p) + ' in ' + label(bad)); break; }
    }
  }
  // 1b. no text lies on other text (an overlay such as the card may cover the board, but not its own words)
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], c = texts[j];
    if (a.n === c.n || a.layer !== c.layer) continue;
    const ox = Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left), oy = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top);
    if (ox > 1 && oy > 1.5) out.push('text on text: ' + label(a.p) + ' × ' + label(c.p));
  }
  // 2. text an element cuts off
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('svg') || sr(e) || e.hasAttribute('data-scroll') || e.hasAttribute('data-clip-ok') || !vis(e)) continue;
    const cs = getComputedStyle(e);
    const cx = cs.overflowX !== 'visible', cy = cs.overflowY !== 'visible', ell = cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp != null && cs.webkitLineClamp !== '';
    if (!cx && !cy && !ell) continue;
    if (!(e.textContent || '').trim()) continue;
    if ((cx || ell) && e.scrollWidth > e.clientWidth + 1) out.push('clipped text: ' + label(e) + ' (' + e.scrollWidth + ' > ' + e.clientWidth + ')');
    else if (cy && e.scrollHeight > e.clientHeight + 1) out.push('clipped text: ' + label(e) + ' (' + e.scrollHeight + ' > ' + e.clientHeight + ' high)');
  }
  // 3. nothing off-screen
  for (const e of document.querySelectorAll('[data-box], button, .chip, .part, .hl, .mach, .more')) {
    if (sr(e) || !vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) out.push('off-screen: ' + label(e));
  }
  for (const t of document.querySelectorAll('#board text, #wires text')) {
    const r = t.getBoundingClientRect();
    if (r.width && (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol)) out.push('off-screen: svg text "' + t.textContent + '"');
  }
  // 4. the board's boxes do not overlap
  const lead = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lead')) || 4;
  const boxes = [];
  const add = (k, e, r) => boxes.push({ k, e, r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  for (const e of document.querySelectorAll('.chip')) if (vis(e)) { const r = e.getBoundingClientRect(); add('chip', e, { left: r.left - lead, top: r.top - lead, right: r.right + lead, bottom: r.bottom + lead }); }
  for (const e of document.querySelectorAll('.part, .hl, .more, .mach, #tray, #brand, #mode, #repo, #conn, #spend')) if (vis(e)) add(e.className.split(' ')[0] || e.id, e, e.getBoundingClientRect());
  for (const e of document.querySelectorAll('#said > span:not(.sr), #said > i')) if (vis(e)) for (const r of e.getClientRects()) add('said', e, r);
  for (const e of document.querySelectorAll('#wires .pad, #wires .you, #board .you')) add(e.classList.contains('pad') ? 'pad' : 'you', e, e.getBoundingClientRect());
  const pkg = document.querySelector('#board .pkg');
  const core = pkg ? pkg.getBoundingClientRect() : document.getElementById('core').getBoundingClientRect();
  add('core', document.getElementById('core'), core);
  const ov = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if ((a.k === 'pad' && b.k === 'core') || (b.k === 'pad' && a.k === 'core')) continue;
    if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
    // a lane's pad renumbering: the old number fades out where the new one pops in
    if (a.k === 'pad' && b.k === 'pad' && a.e.dataset.key && a.e.dataset.key === b.e.dataset.key) continue;
    if (ov(a.r, b.r) > 1.5) out.push('overlap: ' + label(a.e) + ' × ' + label(b.e));
  }
  // 5. overlays: inside the window, never on the core, and never on the top band (the workbench mark opens the look menu)
  const top = [...document.querySelectorAll('#brand, #mode, #repo, #conn, #spend')].filter(vis).map(e => [e, e.getBoundingClientRect()]);
  for (const e of document.querySelectorAll('#card, #pop, #trayList, #look')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) out.push('off-screen: ' + label(e));
    if (ov(r, core) > 1) out.push(e.id + ' covers the core');
    for (const [t, tr] of top) if (ov(r, tr) > 1) out.push(e.id + ' covers ' + label(t));
  }
  return { problems: [...new Set(out)], link: document.documentElement.dataset.link, fonts: [400, 500, 600, 700].every(w => document.fonts.check(w + ' 12px "JetBrains Mono"')) };
})()`;

// ------------------------------------------------------------------ the run
const failures = [];
let checks = 0;
const mock = await startMock({ quiet: true });
const base = `http://127.0.0.1:${mock.port}`;
const ctl = (p, b) => fetch(base + '/ctl/' + p, { method: 'POST', body: JSON.stringify(b || {}) }).then(r => r.json());
const [w0, h0] = sizes[0].split('x').map(Number);
const b = await launchAt(w0, h0);
const errors = [];
b.on(m => {
  if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 300));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/status of 401/.test(m.params.entry.text)) errors.push('log: ' + m.params.entry.text.slice(0, 300) + ' ' + (m.params.entry.url || ''));
});

async function setLook(theme, detail) {
  await b.ev(`(() => { const set = (n, v) => { const r = document.querySelector('#look input[name="' + n + '"][value="' + v + '"]'); if (r && !r.checked) r.click(); };
    document.getElementById('brand').click(); set('theme', ${JSON.stringify(theme)}); set('detail', ${JSON.stringify(detail)}); document.getElementById('brand').click(); return true; })()`);
}
async function settle(ms = 120) {
  await sleep(ms);
  await b.ev(`new Promise(r => { const t0 = performance.now(); const go = () => { const busy = document.getAnimations().some(a => a.playState === 'running'); if (!busy || performance.now() - t0 > 4000) r(true); else setTimeout(go, 60); }; go(); })`);
}
async function check(tag) {
  checks++;
  const r = await b.ev(CHECK);
  if (!r.fonts) failures.push(`${tag}: JetBrains Mono did not load`);
  for (const p of r.problems) failures.push(`${tag}: ${p}`);
  if (verbose) console.log(tag, r.problems.length ? r.problems.length + ' problem(s)' : 'ok', r.link);
  const errs = errors.splice(0);
  for (const e of errs) failures.push(`${tag}: ${e}`);
  return r;
}
const size = async s => { const [w, h] = s.split('x').map(Number); await b.size(w, h); };

try {
  // every scenario, at every size, in both detail levels and all three looks
  for (const sc of scenarios) {
    await ctl('scenario', { name: sc });
    await b.goto(`${base}/?t=k&still=1`, 1500);
    for (const s of sizes) {
      await size(s);
      for (const d of details) for (const t of themes) {
        await setLook(t, d);
        await settle(90);
        await check(`${sc} ${s} ${d} ${t}`);
      }
    }
    process.stdout.write(`${sc} `);
  }
  if (scenarios.length) console.log('');

  // views: hover cards, menus, opened details, the reply chip, notices, launch questions, and the link states
  for (const v of views) {
    for (const s of sizes) for (const d of details) {
      const t = quick ? 'green' : themes[(sizes.indexOf(s) + details.indexOf(d)) % themes.length];
      const tag = `view ${v} ${s} ${d} ${t}`;
      const load = async (sc, q = '') => { await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false }); await ctl('scenario', { name: sc }); await size(s); await b.goto(`${base}/?t=k&still=1${q}`, 1300); await setLook(t, d); await settle(100); };
      if (v === 'card-root' || v === 'card-helper') {
        await load(v === 'card-root' ? 'busy' : 'demo');
        const sel = v === 'card-root' ? '.chip' : '.part';
        const all = await b.ev(`[...document.querySelectorAll('${sel}')].map(e => { const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })`);
        for (const [x, y] of all.slice(0, v === 'card-root' ? 12 : 6)) {
          await b.mouse(2, 2); await sleep(220);
          await b.mouse(x, y);
          await settle(160);
          const shown = await b.ev(`!document.getElementById('card').hidden`);
          if (!shown) failures.push(`${tag}: no card for the thing under the pointer at ${Math.round(x)},${Math.round(y)}`);
          await check(tag);
        }
        await b.mouse(2, 2);
      } else if (v === 'card-pinned') {
        // a card pinned by a click, in each look: it never covers the core or the top band
        await load('demo', '&pin=902d13');
        await check(tag);
        await load('demo', '&pin=2f4ffc');   // the chip by the top-left corner, under the workbench mark
        await check(tag);
        await load('busy', '&pin=first-root');
        await check(tag);
      } else if (v === 'machines') {
        await load('demo');
        await b.ev(`document.querySelector('.mach')?.click(), true`); await settle(150); await check(tag);
        await b.ev(`[...document.querySelectorAll('.mach')].pop()?.click(), true`); await settle(150); await check(tag);
      } else if (v === 'tray') {
        await load('many');
        await b.ev(`document.getElementById('tray').click(), true`); await settle(150);
        const shown = await b.ev(`!document.getElementById('trayList').hidden`);
        if (!shown) failures.push(`${tag}: the done tray did not open its list`);
        await check(tag);
      } else if (v === 'menu') {
        await load('demo');
        await b.ev(`document.getElementById('brand').click(), true`); await settle(150); await check(tag);
      } else if (v === 'exact') {
        await load('longcmd');
        await check(tag + ' (clipped)');
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="exact"]')?.click(), true`); await sleep(700); await settle(100); await check(tag + ' (all of it)');
      } else if (v === 'reply') {
        await load('longcmd');
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="next"]')?.click(), true`); await sleep(900);
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="reply"]')?.click(), true`); await settle(150);
        const on = await b.ev(`document.getElementById('bar').classList.contains('replying')`);
        if (!on) failures.push(`${tag}: the reply chip did not open`);
        await check(tag);
      } else if (v === 'notice') {
        await load('demo');
        await ctl('push', { event: 'notice', data: { text: 'Search cleanup has your answer and is carrying on. It will tell you when the old search address is gone and the redirect to the new search page works for saved links.' } });
        await settle(200); await check(tag);
      } else if (v === 'confirm') {
        await load('demo');
        await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = 'start eight agents on the backlog'; i.dispatchEvent(new Event('input')); document.getElementById('bar').requestSubmit(); return true; })()`);
        await sleep(900); await settle(100);
        const h1 = await b.ev(`document.querySelector('#pages .page:not(.old) h1')?.textContent || ''`);
        if (!/^Start 8 agents/.test(h1)) failures.push(`${tag}: the launch question did not show (${h1.slice(0, 40)})`);
        await check(tag);
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="readall"]')?.click(), true`); await sleep(600); await settle(100); await check(tag + ' (all of it)');
      } else if (v === 'stale') {
        await ctl('scenario', { name: 'demo' }); await size(s); await b.goto(`${base}/?t=bad&still=1`, 1300); await setLook(t, d); await settle(100);
        const l = await check(tag);
        if (l.link !== 'stale') failures.push(`${tag}: expected the stale-key state, got ${l.link}`);
      } else if (v === 'no-key') {
        await size(s); await b.goto(`${base}/?t=k&still=1`, 600); await b.ev(`sessionStorage.clear(), true`); await b.goto(`${base}/`, 1300); await setLook(t, d); await settle(100);
        const l = await check(tag);
        if (l.link !== 'no-key') failures.push(`${tag}: expected the no-key state, got ${l.link}`);
      } else if (v === 'connecting') {
        await ctl('mode', { holdMs: 4000 }); await ctl('scenario', { name: 'demo', push: false }); await size(s); await b.goto(`${base}/?t=k&still=1`, 1500); await setLook(t, d); await settle(80);
        const l = await check(tag);
        if (l.link !== 'connecting') failures.push(`${tag}: expected connecting, got ${l.link}`);
        await ctl('mode', { holdMs: 0 });
      } else if (v === 'reconnecting') {
        await load('demo');
        await ctl('mode', { down: true }); await ctl('drop'); await sleep(900); await settle(80);
        for (let i = errors.length - 1; i >= 0; i--) if (/api\/stream/.test(errors[i])) errors.splice(i, 1);   // the dropped stream itself
        const l = await check(tag);
        if (l.link !== 'reconnecting') failures.push(`${tag}: expected reconnecting, got ${l.link}`);
        await ctl('mode', { down: false });
      } else if (v === 'swap') {
        // with motion on: sample the page while the core swaps between a long item and a short one, both ways, and when a
        // new ask arrives on the stream. Nothing may be outside its box at any moment of the swap.
        await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false }); await ctl('scenario', { name: 'longcmd' }); await size(s); await b.goto(`${base}/?t=k`, 1500); await setLook(t, d); await settle(300);
        await b.mouse(2, 2);
        for (const way of ['long to short', 'short to long']) {
          await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="next"]')?.click(), true`);
          const t0 = Date.now();
          for (const at of [30, 90, 150, 210, 270, 340, 420, 520, 650, 800]) { const wait = at - (Date.now() - t0); if (wait > 0) await sleep(wait); await check(`${tag} (${way}, ${at} ms)`); }
          await settle(200);
        }
        const r1 = (await (await fetch(base + '/ctl/state')).json()).agents.find(a => a.id === 'r1');
        await ctl('push', { event: 'agents', data: [{ ...r1, state: 'needs_ok', ask: { id: 'k9', type: 'permission', sentence: 'Search cleanup wants to delete the old search pages and every redirect that points at them', detail: 'rm -rf src/search/legacy src/search/redirects && git rm -r --cached docs/search-v1 && npm run build -- --clean --report=full --verbose --no-cache', why: 'Deleting files cannot be undone from Workbench.', options: ['Allow', 'Deny'], createdAt: Date.now() - 600000 } }] });
        const t1 = Date.now();
        for (const at of [60, 120, 180, 240, 320, 420, 560, 760]) { const wait = at - (Date.now() - t1); if (wait > 0) await sleep(wait); await check(`${tag} (new ask, ${at} ms)`); }
      } else if (v === 'motion') {
        // with motion on: answer what the core shows, and check the board once everything has come to rest
        await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false }); await ctl('scenario', { name: 'demo' }); await size(s); await b.goto(`${base}/?t=k`, 1500); await setLook(t, d); await settle(300);
        await sleep(800);
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="answer"]')?.click(), true`);
        await sleep(2600); await settle(200);
        await check(tag);
      }
    }
    process.stdout.write(`${v} `);
  }
  if (views.length) console.log('');
} finally {
  await b.close();
  await mock.close();
}

console.log(`${checks} checks.`);
if (failures.length) {
  const uniq = [...new Set(failures)];
  console.log(`${uniq.length} problem(s):`);
  for (const f of uniq.slice(0, 400)) console.log('  ' + f);
  process.exit(1);
}
console.log('Every text fits its box, nothing is clipped or off-screen, and nothing overlaps.');
