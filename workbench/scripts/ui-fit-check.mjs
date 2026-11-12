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
const VIEWS = ['card-root', 'card-helper', 'card-pinned', 'machines', 'menu', 'tray', 'earlier', 'exact', 'reply', 'notice', 'confirm', 'stale', 'no-key', 'connecting', 'reconnecting', 'motion', 'swap',
  // D2: an agent's work in the lid, and the engine's cards for it (the 'merge' scenarios of scripts/ui-mock.mjs)
  'merge-card', 'discard-card', 'merge-conflict', 'merge-blocked', 'merge-lids',
  // what an agent controls, with characters that hide text or turn it: shown by their codes on the board and in the lid
  'taint'];

// D1: the git screen, opened by the DRAM: its graph, an agent's or a commit's detail, a repository with one commit
const GIT_VIEWS = ['git', 'git-detail', 'git-empty'];
VIEWS.push(...GIT_VIEWS);
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
    const layer = p.closest('#card, #pop, #trayList, #look, #gitDetail')?.id || 'board';
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
  for (const t of document.querySelectorAll('#board text, #wires text, #gitBoard text, #gitGraph text')) {
    if (!vis(t)) continue;   // the screen not shown (the board above the git screen, or the git screen below the board)
    const r = t.getBoundingClientRect();
    const sb = t.closest('[data-scroll]')?.getBoundingClientRect();   // scrolled out of its scroll box: not on screen
    if (sb && (r.bottom < sb.top || r.top > sb.bottom)) continue;
    if (r.width && (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol)) out.push('off-screen: svg text "' + t.textContent + '"');
  }
  // 4. the board's boxes do not overlap
  const lead = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lead')) || 4;
  const boxes = [];
  const add = (k, e, r) => boxes.push({ k, e, r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
  for (const e of document.querySelectorAll('.chip')) if (vis(e)) { const r = e.getBoundingClientRect(); add('chip', e, { left: r.left - lead, top: r.top - lead, right: r.right + lead, bottom: r.bottom + lead }); }
  for (const e of document.querySelectorAll('.part, .hl, .more, .mach, #tray, #brand, #mode, #repo, #conn, #spend, #dram')) if (vis(e)) add(e.className.split(' ')[0] || e.id, e, e.getBoundingClientRect());
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

/**
 * D1: the git screen's views. Each opens the git screen the way a person does, by clicking the DRAM, and checks it:
 *   git         the graph of a repository (and of one with 48 commits and six agents, and of one not on a branch),
 *               at its top and scrolled to its end
 *   git-detail  an agent's detail with the stress diff, its diff scrolled to the end, a commit's detail, and the detail of
 *               an agent with a very long branch name
 *   git-empty   a repository with only its first commit
 */
async function gitView(v, s, d) {
  const t = quick ? 'green' : themes[(sizes.indexOf(s) + details.indexOf(d)) % themes.length];
  const tag = `view ${v} ${s} ${d} ${t}`;
  const open = async sc => {
    await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false }); await ctl('scenario', { name: sc }); await size(s);
    await b.goto(`${base}/?t=k&still=1`, 1300); await setLook(t, d); await settle(100);
    await b.ev(`document.getElementById('dram').click(), true`);
    await sleep(500); await settle(100);
    const ok = await b.ev(`document.documentElement.dataset.screen === 'git' && !document.getElementById('gitScreen').inert && document.getElementById('boardScreen').inert`);
    if (!ok) failures.push(`${tag}: the DRAM did not open the git screen (${sc})`);
    const rows = await b.ev(`document.querySelectorAll('#gitGraph .gr').length`);
    if (!rows) failures.push(`${tag}: no rows in the graph (${sc})`);
    return rows;
  };
  const scrollEnd = async sel => { await b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e) e.scrollTop = e.scrollHeight; return true; })()`); await sleep(120); };
  const pick = async sel => { await b.ev(`document.querySelector(${JSON.stringify(sel)})?.click(), true`); await sleep(500); await settle(80); };
  if (v === 'git') {
    for (const sc of ['git', 'git-many', 'git-detached']) {
      await open(sc); await check(`${tag} (${sc})`);
      await scrollEnd('#gitGraph'); await check(`${tag} (${sc}, scrolled to the end)`);
    }
  } else if (v === 'git-detail') {
    await open('git');
    await pick('#gitGraph .gr[data-id="work:g1"]');
    if (await b.ev(`document.getElementById('gitDetail').hidden || !document.querySelector('#gitDetail .gdiff .df')`)) failures.push(`${tag}: the agent's detail did not show its diff`);
    await check(`${tag} (agent, stress diff)`);
    await scrollEnd('#gitDetail .gdiff'); await check(`${tag} (agent, diff scrolled to the end)`);
    await pick('#gitGraph .gr:not(.work)');
    if (!/Id/.test(await b.ev(`document.getElementById('gitDetail').textContent`))) failures.push(`${tag}: the commit's detail did not show`);
    await check(`${tag} (commit)`);
    await open('git-many');
    await pick('#gitGraph .gr[data-id="work:m5"]'); await check(`${tag} (a very long branch name)`);
  } else if (v === 'git-empty') {
    await open('git-empty'); await check(tag);
  }
}

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
      if (GIT_VIEWS.includes(v)) { await gitView(v, s, d); continue; }   // D1
      if (v === 'taint' && sizes.length > 2 && !['960x900', '1440x789'].includes(s)) continue;   // the words do not depend on the size
      const t = quick ? 'green' : themes[(sizes.indexOf(s) + details.indexOf(d)) % themes.length];
      const tag = `view ${v} ${s} ${d} ${t}`;
      const load = async (sc, q = '') => { await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false, merge: 'ok' }); await ctl('scenario', { name: sc }); await size(s); await b.goto(`${base}/?t=k&still=1${q}`, 1300); await setLook(t, d); await settle(100); };
      // D2: the lid's words and buttons, a click on one of them, typed words, and "See all of it" when the lid cut something
      const lidH1 = () => b.ev(`document.querySelector('#pages .page:not(.old) h1')?.textContent || ''`);
      const clickLid = async sel => { await b.ev(`document.querySelector('#pages .page:not(.old) ${sel}')?.click(), true`); await sleep(900); await settle(100); };
      const typeLid = async text => { await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); document.getElementById('bar').requestSubmit(); return true; })()`); await sleep(1000); await settle(100); };
      const expect = async (re, what) => { const h = await lidH1(); if (!re.test(h)) failures.push(`${tag}: ${what} did not show (${h.slice(0, 50)})`); };
      const allOfIt = async label => {
        const sel = '#pages .page:not(.old) [data-act="exact"], #pages .page:not(.old) [data-act="readall"]';
        if (!(await b.ev(`!!document.querySelector(${JSON.stringify(sel)})`))) return;
        await b.ev(`document.querySelector(${JSON.stringify(sel)}).click(), true`); await sleep(500); await settle(100); await check(`${label}, all of it`);
      };
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
      } else if (v === 'earlier') {
        // agents from an earlier run: in the lid (one that can continue, one that cannot), the tray's list, the forget
        // question, and a card pinned on one
        await load('earlier', '&focus=e-old0'); await check(tag + ' (can continue)');
        await load('earlier', '&focus=e-old2'); await check(tag + ' (cannot continue)');
        await load('earlier', '&focus=e-old4'); await check(tag + ' (failed)');
        await load('earlier', '&pin=e-old0'); await check(tag + ' (pinned card)');
        await load('earlier-many');
        await b.ev(`document.getElementById('tray').click(), true`); await settle(150);
        if (!(await b.ev(`!document.getElementById('trayList').hidden`))) failures.push(`${tag}: the tray did not open its list`);
        await check(tag + ' (tray list)');
        await load('earlier', '&focus=e-old1');
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="forget"]')?.click(), true`); await sleep(900); await settle(100);
        const q = await b.ev(`document.querySelector('#pages .page:not(.old) h1')?.textContent || ''`);
        if (!/^Forget /.test(q)) failures.push(`${tag}: the forget question did not show (${q.slice(0, 40)})`);
        await check(tag + ' (forget question)');
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
      } else if (v === 'merge-card') {
        // ---------------------------------------------------------------- D2: an agent's work and its cards
        // Merge on main, then its card (whose detail stays at every fit step but the last, then under "See all of it");
        // a failed check's "Merge anyway" on a long branch, and its card naming the failed check
        await load('merge', '&focus=m1a2b3'); await check(tag + ' (the lid: Merge into main)');
        await clickLid('[data-act="merge"]'); await expect(/^Merge Invoice export into main\?/, 'the merge card');
        await check(tag + ' (merge card)'); await allOfIt(tag + ' (merge card)');
        await load('merge-more', '&focus=n1'); await check(tag + ' (the lid: a failed check, Merge anyway)');
        await clickLid('[data-act="merge"]'); await expect(/^Merge Release notes into release\/2026-11-payments-and-refunds\?/, 'the merge card on a long branch');
        await check(tag + ' (merge card, a failed check, a long branch)'); await allOfIt(tag + ' (merge card, a failed check, a long branch)');
        await load('merge-more', '&focus=n2'); await check(tag + ' (the lid: Merge into a long branch)');
      } else if (v === 'discard-card') {
        // Throw it away, typed: a card with no default answer, whose detail says what is deleted
        await load('merge', '&focus=m1a2b3');
        await typeLid('throw it away'); await expect(/^Throw away Invoice export’s work\?/, 'the throw-away card');
        await check(tag + ' (throw-away card)'); await allOfIt(tag + ' (throw-away card)');
        await load('merge-more', '&focus=n4');
        await typeLid('throw it away'); await expect(/^Throw away Price rounding’s work\?/, 'the throw-away card of a stopped agent');
        await check(tag + ' (throw-away card, a stopped agent)');
      } else if (v === 'merge-conflict') {
        await load('merge', '&focus=m7e8f9'); await expect(/does not merge cleanly into main\.$/, 'the conflict');
        await check(tag + ' (both changed)');
        await load('merge-more', '&focus=n5'); await expect(/^Git does not know your name and email yet/, 'the identity refusal');
        await check(tag + ' (no name and email)'); await allOfIt(tag + ' (no name and email)');
      } else if (v === 'merge-blocked') {
        await load('merge', '&focus=mab0c1'); await expect(/^Your own changes are in the way\.$/, 'blocked');
        await check(tag + ' (your own changes in the way)');
      } else if (v === 'merge-lids') {
        // where the work went, and where merge does not apply: merged, thrown away, an earlier agent, failed and stopped
        // agents with a folder (Review), not on a branch, and no name and email (the lid says why)
        await load('merge', '&focus=m4c5d6'); await expect(/work is in main\.$/, 'merged'); await check(tag + ' (merged)');
        await load('merge', '&focus=md2e3f'); await expect(/work was thrown away\.$/, 'thrown away'); await check(tag + ' (thrown away)');
        await load('merge', '&focus=mf4a5b'); await expect(/^Email digest was done and checked\.$/, 'the earlier agent'); await check(tag + ' (earlier, with Review)');
        await load('merge-more', '&focus=n3'); await check(tag + ' (failed, with Review)');
        await load('merge-more', '&focus=n4'); await check(tag + ' (stopped, with Review)');
        await load('merge-detached', '&focus=d1'); await check(tag + ' (not on a branch)');
        await load('merge-noid', '&focus=d2'); await check(tag + ' (no name and email)');
      } else if (v === 'taint') {
        // Everything an agent controls, with characters in it that hide text or turn it: its name, what it says, asks and
        // does, the words of its answers, its paths, its checks' and its helpers' names. The board, the lid and what is
        // announced must show each one by its code, in text and in names for screen readers (the card is card.js's own,
        // and is left out here).
        const taint = async () => {
          const st = await (await fetch(base + '/ctl/state')).json();
          const U = n => String.fromCodePoint(n), RLO = U(0x202e), ZW = U(0x200b), TAG = U(0xe0041), HF = U(0x3164), LS = U(0x2028), SHY = U(0xad);
          const t = s => (s ? `${s}${RLO}x${TAG}${HF}` : s);
          for (const a of st.agents) {
            const [w0, ...rest] = String(a.name).split(' ');
            a.name = `${w0}${RLO}${rest.join(' ')}${ZW}`;
            a.says = t(a.says); a.now = t(a.now); a.error = t(a.error);
            if (a.files && a.files.list) for (const f of a.files.list) f.path = f.path.replace('/', `/${SHY}`).replace(/\.(\w+)$/, `${RLO}.$1`);
            if (a.checks && a.checks.results) for (const r of a.checks.results) r.name = t(r.name);
            if (a.ask) {
              a.ask.sentence = `${a.ask.sentence}${LS}${TAG}`;
              if (a.ask.detail) a.ask.detail = t(a.ask.detail);
              if (a.ask.type !== 'permission' && Array.isArray(a.ask.options)) a.ask.options = a.ask.options.map(t);
            }
          }
          await ctl('push', { event: 'snapshot', data: st }); await sleep(400); await settle(100);
        };
        const SCAN = String.raw`(async () => {
          const { hasHidden } = await import('/ui/diffview.js');
          const out = [], skip = e => !!e.closest('#card');
          const label = el => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.'); return s; };
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) { const p = n.parentElement; if (p && !skip(p) && hasHidden(n.data.replace(/\n/g, ''))) out.push('raw hidden characters in the text of ' + label(p)); }
          for (const e of document.querySelectorAll('body *')) {
            if (skip(e)) continue;
            for (const at of ['aria-label', 'title', 'aria-description', 'placeholder', 'alt']) { const val = e.getAttribute(at); if (val && hasHidden(val.replace(/\n/g, ''))) out.push('raw hidden characters in the ' + at + ' of ' + label(e)); }
          }
          return [...new Set(out)];
        })()`;
        const scan = async what => { for (const p of await b.ev(SCAN)) failures.push(`${tag} (${what}): ${p}`); };
        await load('demo'); await taint();
        await scan('a permission');
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="next"]')?.click(), true`); await sleep(900); await settle(100);
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="changed"]')?.click(), true`); await sleep(300); await settle(80);
        await scan('a question, and what it changed');
        await b.ev(`document.querySelector('#pages .page:not(.old) [data-act="next"]')?.click(), true`); await sleep(900); await settle(100);
        await scan('might be stuck');
        for (const [id, what] of [['228202', 'done and checked'], ['902d13', 'working, with helpers'], ['399e17-7a7143c0', 'a helper that finished']]) {
          await load('demo', `&focus=${id}`); await taint(); await scan(what);
        }
      } else {
        failures.push(`${tag}: no such view`);
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
