// Text fits, always: loads the page against the mock API (scripts/ui-mock.mjs) in headless Chrome and checks, for every
// scenario, window size, detail level and look, that no visible text falls outside its box, no text is clipped, nothing
// is off-screen, and the board's boxes do not overlap. Visually hidden screen-reader text is allowed; so is the one
// marked scroll box that holds a long command or question in full ([data-scroll]), and one-line clips whose full text is
// elsewhere ([data-clip-ok]). Agents & keys is an overlay and a text layer of its own: its button sits in the top band in
// the 'connect-*' scenarios, and its panel (#connect), which opens by itself in 'connect-none', is checked at every size,
// detail level and look there. The Full permissions button sits in the top band on every live page, lit in the 'full'
// scenarios ('full-live' has both buttons, the widest the band gets), and its card is the 'perm-card' view.
// Not part of npm test (it needs Chrome). No dependencies.
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
  'taint',
  // a crowded board with a long done tray: the edge connector's sections keep clear of the DRAM's wire
  'wire',
  // full permissions: the card the band's button brings, and a launch card's added sentence while they are on
  'perm-card', 'perm-launch'];

// D1: the git screen, opened by the DRAM: its graph, an agent's or a commit's detail, a repository with one commit
const GIT_VIEWS = ['git', 'git-detail', 'git-empty', 'git-tangles'];
VIEWS.push(...GIT_VIEWS);
// the file view: the sheet in the middle, in each look and at each size (the 'files' scenario of scripts/ui-mock.mjs)
const FILE_VIEWS = ['files', 'files-edit'];
VIEWS.push(...FILE_VIEWS);
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
    // overlays are text layers of their own: they may cover the board's words, never their own (Agents & keys, #connect,
    // and the file view, #fileSheet, cover the whole board while they are open)
    const layer = p.closest('#card, #pop, #trayList, #look, #gitDetail, #connect, #fileSheet')?.id || 'board';
    for (let r of rects) {
      // in a scroll box only what shows in it counts: above and below, and to either side (a long line of a file
      // scrolls sideways in the file view, and is not cut)
      if (scroll) {
        const s = scroll.getBoundingClientRect();
        if (r.bottom < s.top || r.top > s.bottom || r.right < s.left || r.left > s.right) continue;
        r = { left: Math.max(r.left, s.left), right: Math.min(r.right, s.right), top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      }
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
  // 3. nothing off-screen. Inside a scroll box (Agents & keys' #connectBody, the git screen's diff, the file view's code
  //    and list, which hold buttons) only the part shown in the box counts: what is scrolled out of it is not on screen
  for (const e of document.querySelectorAll('[data-box], button, .chip, .part, .hl, .mach, .more')) {
    if (sr(e) || !vis(e)) continue;
    let r = e.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    const sb = e.parentElement && e.parentElement.closest('[data-scroll]');
    if (sb) {
      const s = sb.getBoundingClientRect();
      r = { left: Math.max(r.left, s.left), top: Math.max(r.top, s.top), right: Math.min(r.right, s.right), bottom: Math.min(r.bottom, s.bottom) };
      if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) continue;
    }
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
  for (const e of document.querySelectorAll('.part, .hl, .more, .mach, #tray, #brand, #mode, #repo, #conn, #spend, #connectBtn, #permBtn, #dram, #filesChip')) if (vis(e)) add(e.className.split(' ')[0] || e.id, e, e.getBoundingClientRect());
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
  // 5. overlays: inside the window, never on the core, and never on the top band (the workbench mark opens the look menu;
  //    Agents & keys has its button there). Agents & keys itself (#connect) is a modal dialog: it covers the board on
  //    purpose, with the board inert behind it, so it has only to be inside the window
  const top = [...document.querySelectorAll('#brand, #mode, #repo, #conn, #spend, #connectBtn, #permBtn')].filter(vis).map(e => [e, e.getBoundingClientRect()]);
  for (const e of document.querySelectorAll('#card, #pop, #trayList, #look, #connect, #fileSheet')) {
    if (!vis(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.left < -tol || r.top < -tol || r.right > vw + tol || r.bottom > vh + tol) out.push('off-screen: ' + label(e));
    if (e.id === 'connect' || e.id === 'fileSheet') continue;
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
  // a 401 (a stale key, on purpose) and a 409 from the file view's save (a file that changed on disk, on purpose) are expected
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/status of 401/.test(m.params.entry.text)
    && !(/status of 409/.test(m.params.entry.text) && /\/api\/file$/.test(m.params.entry.url || ''))) errors.push('log: ' + m.params.entry.text.slice(0, 300) + ' ' + (m.params.entry.url || ''));
});
// The git-tangles view serves its own histories as GET /api/git (Chrome holds the request and answers it); every other
// request goes on to the mock.
let gitServed = null;
b.on(m => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  if (gitServed && new URL(request.url).pathname === '/api/git') {
    b.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }], body: Buffer.from(JSON.stringify(gitServed)).toString('base64') }).catch(() => {});
  } else b.send('Fetch.continueRequest', { requestId }).catch(() => {});
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
  } else if (v === 'git-tangles') {
    // histories from real git that once drew two merges' lines on top of each other, a line across your trunk, or an old
    // agent above HEAD: each must fit, share no stretch of copper, cross your trunk only when nothing else would do,
    // and keep an agent whose branch starts past the commits shown at the end
    await b.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/git*', requestStage: 'Request' }] });
    try {
      for (const [name, data] of Object.entries(TANGLES)) {
        gitServed = data;
        await open('git');
        const t2 = `${tag} (${name})`;
        await check(t2);
        const g = await b.ev(GEOM);
        for (const x of g.shared) failures.push(`${t2}: two lines on top of each other for ${x}`);
        if (/agentFromAgent|twoOnOne/.test(name)) for (const x of g.overTrunk) failures.push(`${t2}: a line runs across your trunk at ${x}`);
        const headCut = await b.ev(`(() => { const t = document.querySelector('#gitGraph text.ghead'), box = document.getElementById('gitGraph'); if (!t) return null; const r = t.getBoundingClientRect(), bx = box.getBoundingClientRect(); return r.left < bx.left - 0.5 ? Math.round(bx.left - r.left) : 0; })()`);
        if (headCut) failures.push(`${t2}: the HEAD silkscreen is cut by ${headCut} px at the graph's left edge`);
        if (name === 'oldAgent') {
          const ids = await b.ev(`[...document.querySelectorAll('#gitGraph .gr')].map(r => r.dataset.id)`);
          if (ids.at(-1) !== 'work:e1') failures.push(`${t2}: the agent whose branch starts further back is not at the end (${ids.slice(0, 3).join(', ')} … ${ids.at(-1)})`);
          if (ids.indexOf('work:e2') !== 0) failures.push(`${t2}: the newest work is not at the top`);
        }
        await scrollEnd('#gitGraph'); await check(`${t2}, scrolled to the end`);
      }
    } finally {
      gitServed = null;
      await b.send('Fetch.disable');
    }
  }
}

/**
 * The file view's views, in the 'files' scenario of scripts/ui-mock.mjs, opened the way a person opens them (the files
 * chip, the field, a crumb, the link to an agent's copy, Edit):
 *   files       the top folder; a file in an agent's copy with its changed lines; the finder with files and lines found;
 *               the env file shown masked, with why it is not edited; a path too long for the head; a binary file; the
 *               file of 25,000 lines scrolled to its middle; and the needs-you pill when something needs you
 *   files-edit  the editor; the question when Esc would leave an edit; the conflict line when the file changed on disk
 */
async function filesView(v, s, d) {
  const t = quick ? 'green' : themes[(sizes.indexOf(s) + details.indexOf(d)) % themes.length];
  const tag = `view ${v} ${s} ${d} ${t}`;
  await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false, delay: null, files: null }); await ctl('scenario', { name: 'files' }); await size(s);
  await b.goto(`${base}/?t=k&still=1`, 1300); await setLook(t, d); await settle(100);
  const shown = () => b.ev(`document.getElementById('fileSheet').open`);
  const click = async (sel, ms = 500) => { const ok = await b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`); await sleep(ms); await settle(80); return ok; };
  const find = async (text, ms = 700) => { await b.ev(`(() => { const i = document.getElementById('fvFind'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); return 1; })()`); await sleep(ms); await settle(60); };
  const choose = async (path, ms = 700) => { await find(path); await b.ev(`(() => { const o = [...document.querySelectorAll('#fvList [role="option"]')].find(x => x.querySelector('.fv-nm')?.textContent === ${JSON.stringify(path.split('/').pop())}); o?.click(); return !!o; })()`); await sleep(ms); await settle(80); };
  const title = () => b.ev(`document.getElementById('fvTitle').textContent`);
  if (!(await click('#filesChip', 700)) || !(await shown())) { failures.push(`${tag}: the files chip did not open the file view`); return; }
  if (v === 'files') {
    await check(`${tag} (the top folder)`);
    await choose('src/invoices/export.ts');
    if (!/export\.ts$/.test(await title())) failures.push(`${tag}: export.ts did not open (${await title()})`);
    await click('#fvWhose [data-fv="switch"]', 800);
    const whose = await b.ev(`document.getElementById('fvWhose').textContent`);
    if (!/In Invoice export’s copy/.test(whose) || !(await b.ev(`document.querySelectorAll('#fvRows .fv-row.chg').length`))) failures.push(`${tag}: Invoice export's copy did not show its changed lines (${whose})`);
    await check(`${tag} (an agent's copy, its changed lines)`);
    await find('inv', 1100);
    if (!(await b.ev(`!!document.querySelector('#fvList .fv-hit')`))) failures.push(`${tag}: the finder found no lines in the files`);
    await check(`${tag} (the finder: files, and lines in files)`);
    await b.ev(`(() => { const i = document.getElementById('fvFind'); i.value = ''; i.dispatchEvent(new Event('input')); return 1; })()`); await sleep(200);
    await click('#fvWhose [data-fv="switch"]', 700);
    await choose('.env');
    if (!/holds keys/.test(await b.ev(`document.getElementById('fvActs').textContent`))) failures.push(`${tag}: the env file did not say why it is not edited`);
    await check(`${tag} (the env file, masked)`);
    await choose('src/very/deeply/nested/folders/for/the/crumbs/to/give/way/invoice-export-batch-sender-for-large-accounts.ts');
    await check(`${tag} (a path too long for the head)`);
    await choose('assets/invoice-logo.png');
    await check(`${tag} (a binary file)`);
    await choose('src/generated/rates.ts', 1200);
    await b.ev(`(() => { const c = document.getElementById('fvCode'); c.scrollTop = c.scrollHeight / 2; return 1; })()`); await sleep(400); await settle(80);
    if (!(await b.ev(`document.querySelectorAll('#fvRows .fv-row').length < 200 && +document.querySelector('#fvRows .fv-row .no').textContent > 10000`))) failures.push(`${tag}: the long file did not draw a window of rows in its middle`);
    await check(`${tag} (25,000 lines, scrolled to the middle)`);
    const st = await (await fetch(base + '/ctl/state')).json();
    const a = st.agents.find(x => x.id === 'f2');
    await ctl('push', { event: 'agents', data: [{ ...a, state: 'needs_ok', ask: { id: 'fp1', type: 'permission', sentence: 'Price rounding wants to run a command', detail: 'npm run db:migrate', options: ['Allow', 'Deny'], createdAt: Date.now() } }] });
    await sleep(500); await settle(80);
    if (await b.ev(`document.getElementById('fvNeeds').hidden`)) failures.push(`${tag}: the needs-you pill did not show`);
    await check(`${tag} (the needs-you pill)`);
  } else if (v === 'files-edit') {
    await choose('src/invoices/export.ts');
    await click('#fvActs [data-fv="edit"]', 500);
    if (await b.ev(`document.getElementById('fvEdit').hidden`)) failures.push(`${tag}: Edit did not open the editor`);
    await check(`${tag} (the editor)`);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('// a change\\n', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`); await sleep(150);
    await b.key('Escape'); await sleep(300); await settle(60);
    if (!/not saved/.test(await b.ev(`document.getElementById('fvWhose').textContent`))) failures.push(`${tag}: Esc did not ask before leaving the edit`);
    await check(`${tag} (leave the edit?)`);
    await click('#fvWhose [data-fv="keep"]', 200);
    await fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: 'you', path: 'src/invoices/export.ts', text: 'export const changedOnDisk = true;\n' }) });
    await click('#fvActs [data-fv="save"]', 700);
    if (!/changed on disk while you were editing/.test(await b.ev(`document.getElementById('fvWhose').textContent`))) failures.push(`${tag}: the conflict line did not show`);
    await check(`${tag} (the conflict line)`);
  }
}

// ---------------------------------------------------------------- D1: histories that once tangled (the git-tangles view)
// From real git: commits as [id, parents, refs, agentId, subject], newest first as git log --topo-order gives them.
const tangle = (rows, agents, { head = 'c0', more = false } = {}) => {
  const hex = c => (c.replace(/\D/g, '').padStart(6, '0') + 'ab'.repeat(20)).slice(0, 40);
  const now = Date.now();
  const commits = rows.map(([c, ps, refs, agentId, subject], i) => ({ id: hex(c), parents: ps.map(hex), refs, agentId, subject, author: 'Sam Lee', at: now - (i + 1) * 9 * 60000, kind: ps.length > 1 ? 'merge' : 'commit' }));
  return { ok: true, repo: { name: 'tangles', branch: 'main', head: hex(head).slice(0, 7), dirty: 0, identity: true }, commits, more,
    agents: agents.map(a => ({ harness: 'claude', earlier: false, from: 'main', ...a, base: a.base && hex(a.base), since: a.since && hex(a.since), work: { branch: a.branch, from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...a.work } })) };
};
const TANGLES = {
  mergedTwice: tangle([
    ['c0', ['c1'], ['main'], null, 'main 4'], ['c1', ['c2', 'c6'], [], 'm1', 'Merge M: m 2'], ['c2', ['c3'], [], null, 'main 3'],
    ['c3', ['c4', 'c7'], [], 'm1', 'Merge M: m 1'], ['c4', ['c8'], [], null, 'main 2'], ['c5', ['c6'], ['workbench/m-m1'], 'm1', 'm 3'],
    ['c6', ['c7'], [], 'm1', 'm 2'], ['c7', ['c8'], [], 'm1', 'm 1'], ['c8', ['c9'], [], null, 'main 1'], ['c9', [], [], null, 'init'],
  ], [{ id: 'm1', name: 'Mail digest', state: 'done_checked', branch: 'workbench/m-m1', base: 'c8', since: 'c6', files: { changed: 2 } }]),
  flowTwice: tangle([
    ['c0', ['c1'], ['main'], null, 'main 6'], ['c1', ['c6', 'c2'], [], 'f1', 'Merge F: second work'], ['c2', ['c3', 'c7'], ['workbench/f-f1'], null, 'Merge main into f again'],
    ['c3', ['c4'], [], 'f1', 'f: more'], ['c4', ['c5', 'c8'], [], null, 'Merge main into f (bring in main)'], ['c5', ['c10'], [], 'f1', 'f: its own commit'],
    ['c6', ['c7'], [], null, 'main 5'], ['c7', ['c8'], [], null, 'main 4'], ['c8', ['c9'], [], null, 'main 3'], ['c9', ['c11', 'c10'], [], 'f1', 'Merge F: first work'],
    ['c10', ['c12'], [], 'f1', 'W1: first work'], ['c11', ['c12'], [], null, 'main 2'], ['c12', ['c13'], [], null, 'main 1'], ['c13', [], [], null, 'init'],
  ], [{ id: 'f1', name: 'Flow', state: 'done_checked', branch: 'workbench/f-f1', base: 'c12', since: 'c12', files: { changed: 0 }, work: { merged: { into: 'main' } } }]),
  crissCross: tangle([
    ['c0', ['c1'], ['workbench/l-l1'], 'l1', 'l 2'], ['c1', ['c3', 'c8'], [], null, 'l merges k 1'], ['c2', ['c4', 'c3'], ['workbench/k-k1'], null, 'k merges l 1'],
    ['c3', ['c10'], [], 'l1', 'l 1'], ['c4', ['c5'], [], 'k1', 'k 2'], ['c5', ['c8', 'c9'], [], null, 'k merges main 1'], ['c6', ['c7'], ['main'], null, 'main 2'],
    ['c7', ['c9', 'c8'], [], null, 'main merges k 1'], ['c8', ['c10'], [], 'k1', 'k 1'], ['c9', ['c10'], [], null, 'main 1'], ['c10', ['c11'], [], null, 'base'], ['c11', [], [], null, 'init'],
  ], [{ id: 'k1', name: 'Keys', state: 'done_checked', branch: 'workbench/k-k1', base: 'c10', since: 'c10', files: { changed: 2 } },
    { id: 'l1', name: 'Logins', state: 'done_checked', branch: 'workbench/l-l1', base: 'c10', since: 'c10', files: { changed: 2 } }], { head: 'c6' }),
  agentFromAgent: tangle([
    ['c0', ['c5'], ['main'], null, 'main 2'], ['c1', ['c3'], ['workbench/a-h1'], 'h1', 'a 3'], ['c2', ['c3'], ['workbench/b-h2'], 'h2', 'b 1'],
    ['c3', ['c4'], [], 'h1', 'a 2'], ['c4', ['c5'], [], 'h1', 'a 1'], ['c5', ['c6'], [], null, 'main 1'], ['c6', [], [], null, 'init'],
  ], [{ id: 'h1', name: 'Audit log', state: 'done_checked', branch: 'workbench/a-h1', base: 'c5', since: 'c5', files: { changed: 2 } },
    { id: 'h2', name: 'Billing', state: 'done_checked', branch: 'workbench/b-h2', base: 'c3', since: 'c3', files: { changed: 2 } }]),
  twoOnOne: tangle([
    ['c0', ['c2'], ['main'], null, 'main 2'], ['c1', ['c2'], ['workbench/p-p1', 'workbench/q-q1'], 'p1', 'p 1'], ['c2', ['c3'], [], null, 'main 1'], ['c3', [], [], null, 'init'],
  ], [{ id: 'p1', name: 'Pricing', state: 'done_checked', branch: 'workbench/p-p1', base: 'c2', since: 'c2', files: { changed: 2 } },
    { id: 'q1', name: 'Quotes', state: 'done_checked', branch: 'workbench/q-q1', base: 'c1', since: 'c1', files: { changed: 2 } }]),
  // 200 commits of yours (the limit), work on your latest, and an earlier agent whose branch starts further back
  oldAgent: tangle([...Array.from({ length: 200 }, (_, i) => [`c${i}`, [`c${i + 1}`], i === 0 ? ['main'] : [], null, `main ${200 - i}`])],
    [{ id: 'e1', name: 'Old export', state: 'done_checked', earlier: true, branch: 'workbench/old-e1', base: 'c400', since: 'c400', files: null },
      { id: 'e2', name: 'New work', state: 'working', branch: 'workbench/new-e2', base: 'c0', since: 'c0', files: null }], { more: true }),
};

// The graph as drawn: copper and trunk paths that share a stretch longer than a bend (other than two lines meeting at one
// commit), and level runs of copper across the trunk above its last commit.
const GEOM = String.raw`(() => {
  const svg = document.querySelector('#gitGraph svg.gsvg');
  if (!svg) return { shared: ['(no graph drawn)'], overTrunk: [] };
  const parse = d => d.slice(1).split('L').map(xy => xy.trim().split(/\s+/).map(Number));
  const nodes = [];
  for (const c of svg.querySelectorAll('circle.gvia, circle.gwork')) nodes.push({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy'), r: +c.getAttribute('r') });
  for (const r of svg.querySelectorAll('rect.gpad, rect.gchip')) { const w = +r.getAttribute('width'), h = +r.getAttribute('height'); nodes.push({ x: +r.getAttribute('x') + w / 2, y: +r.getAttribute('y') + h / 2, r: Math.max(w, h) / 2 }); }
  const nodeAt = p => nodes.findIndex(n => Math.abs(n.x - p[0]) <= n.r + 2.5 && Math.abs(n.y - p[1]) <= n.r + 2.5);
  const lines = [...svg.querySelectorAll('path.gc, path.gt-bus')].map(e => ({ trunk: e.classList.contains('gt-bus'), pts: parse(e.getAttribute('d')) }));
  if (svg.querySelector('.gfold')) return { shared: [], overTrunk: [] };   // lines folded into one lane share it on purpose
  const segs = [];
  lines.forEach((l, k) => { for (let i = 1; i < l.pts.length; i++) segs.push({ k, a: l.pts[i - 1], b: l.pts[i], first: i === 1, last: i === l.pts.length - 1 }); });
  const line = s => {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (Math.abs(dx) < 0.15) return ['v', s.a[0], Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1]), 1];
    if (Math.abs(dy) < 0.15) return ['h', s.a[1], Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0]), 1];
    const down = Math.sign(dx) === Math.sign(dy);
    return [down ? 'd' : 'u', down ? s.a[1] - s.a[0] : s.a[1] + s.a[0], Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0]), Math.SQRT2];
  };
  const ends = s => [s.first ? nodeAt(s.a) : -1, s.last ? nodeAt(s.b) : -1].filter(i => i >= 0);
  const shared = [];
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.k === t.k) continue;
    const ls = line(s), lt = line(t);
    if (ls[0] !== lt[0] || Math.abs(ls[1] - lt[1]) > 0.6) continue;
    const len = (Math.min(ls[3], lt[3]) - Math.max(ls[2], lt[2])) * ls[4];
    if (len > 13 && !ends(s).some(x => ends(t).includes(x))) shared.push(Math.round(len) + ' px at ' + s.a.join(',') + ' and ' + t.a.join(','));
  }
  const trunk = lines.filter(l => l.trunk && !l.pts.some(p => Number.isNaN(p[0])));
  const tx = trunk.length ? trunk[0].pts[0][0] : null, tBottom = Math.max(...trunk.flatMap(l => l.pts.map(p => p[1])));
  const overTrunk = [];
  if (tx != null) for (const l of lines) if (!l.trunk) for (let i = 1; i < l.pts.length; i++) {
    const [a, b] = [l.pts[i - 1], l.pts[i]];
    if (Math.abs(a[1] - b[1]) < 0.2 && Math.min(a[0], b[0]) < tx - 0.5 && Math.max(a[0], b[0]) > tx + 0.5 && a[1] < tBottom) overTrunk.push('y ' + a[1]);
  }
  return { shared, overTrunk };
})()`;

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
      // these two do not depend much on the window: two sizes, unless one is asked for
      if ((v === 'taint' || v === 'git-tangles') && sizes.length > 2 && !['960x900', '1440x789'].includes(s)) continue;
      if (v === 'wire' && sizes.length > 2 && !['960x900', '1024x700', '1280x680'].includes(s)) continue;   // where the room runs out
      if (GIT_VIEWS.includes(v)) { await gitView(v, s, d); continue; }   // D1
      if (FILE_VIEWS.includes(v)) { await filesView(v, s, d); continue; }
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
        // a dense board's tray, and the tray of agents the person is finished with (merged, thrown away); then rows for
        // work the person looked at: "Dismiss" on done-tray's stopped agent with a long name ("· stopped"), and "Not now"
        // on done-waits' work, not merged yet ("Invoice export · not merged")
        const trayReads = () => b.ev(`document.getElementById('tray').hidden ? '' : document.getElementById('tray').textContent.trim()`);
        for (const sc of ['many', 'done-tray', 'done-waits']) {
          // the looks this tab kept from an earlier view must not decide what this one shows
          await b.ev(`(() => { try { sessionStorage.removeItem('wb-reviewed'); sessionStorage.removeItem('wb-later'); } catch (e) {} return 1; })()`).catch(() => {});
          await load(sc, sc === 'done-tray' ? '&focus=t4' : '');
          if (sc === 'done-tray') {
            await clickLid('[data-act="reviewed"]');
            const words = await trayReads();
            if (words !== '3 done') failures.push(`${tag} (${sc}): "Dismiss" did not send the stopped agent to the tray (the tray reads "${words}")`);
          }
          if (sc === 'done-waits') {
            await clickLid('[data-act="looksgood"][data-answer="Not now"]');
            const words = await trayReads();
            if (words !== '1 not merged') failures.push(`${tag} (${sc}): "Not now" did not send its work to the tray as not merged (the tray reads "${words}")`);
          }
          await b.ev(`document.getElementById('tray').click(), true`); await settle(150);
          const shown = await b.ev(`!document.getElementById('trayList').hidden`);
          if (!shown) failures.push(`${tag} (${sc}): the done tray did not open its list`);
          await check(`${tag} (${sc})`);
        }
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
      } else if (v === 'perm-card') {
        // the band's Full permissions button, pressed: the engine's card, with its warning, in the lid
        await load('demo');
        await b.ev(`document.getElementById('permBtn')?.click(), true`);
        await sleep(1100); await settle(100);
        const h1 = await b.ev(`document.querySelector('#pages .page:not(.old) h1')?.textContent || ''`);
        if (h1 !== 'Let agents do anything without asking?') failures.push(`${tag}: the full permissions card did not show (${h1.slice(0, 40)})`);
        await check(tag);
      } else if (v === 'perm-launch') {
        // a launch of eight while full permissions are on: the card says they will not ask, at every fit step
        await load('full');
        await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = 'start eight agents on the backlog'; i.dispatchEvent(new Event('input')); document.getElementById('bar').requestSubmit(); return true; })()`);
        await sleep(900); await settle(100);
        const all = await b.ev(`document.querySelector('#pages .page:not(.old)')?.textContent || ''`);
        const fit = await b.ev(`document.getElementById('core').dataset.fit || '0'`);
        if (!/Start 8 agents/.test(all)) failures.push(`${tag}: the launch question did not show`);
        else if (Number(fit) < 3 && !/so they will not ask before any step/.test(all)) failures.push(`${tag}: the launch card did not say that they will not ask`);
        await check(tag);
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
      } else if (v === 'wire') {
        // A crowded board whose done tray reads "12 done, 6 from earlier, 7 more working" (the reviewer's board
        // at 960×900), with the demo's four machines; then a fuller one whose machines have long names. No section of the
        // edge connector may lie on the DRAM's wire, and every word must fit its box (the fit check above).
        const crowd = async ({ working, done, earlier, rename }) => {
          const st = await (await fetch(base + '/ctl/state')).json();
          const one = st.agents.find(a => !a.parentId && a.state === 'working');
          const at = Date.now(), list = [];
          for (let i = 0; i < working + done + earlier; i++) {
            const kind = i < working ? 'working' : i < working + done ? 'done' : 'earlier';
            list.push({ ...one, id: `x${i}`, rootId: `x${i}`, name: `Crowd ${i} fix`, machineId: ['laptop', 'cloud-1', 'cloud-3'][i % 3], ask: null, helpers: { total: 0, working: 0, done: 0 },
              state: kind === 'working' ? 'working' : i % 2 ? 'done_checked' : 'stopped', startedAt: at - (90 - i) * 60000, stateSince: at - 60000,
              endedAt: kind === 'working' ? null : at - 30000, earlier: kind === 'earlier', canContinue: kind === 'earlier' ? true : null });
          }
          const machines = st.machines.map(mc => (rename ? { ...mc, name: { laptop: 'Your laptop (the one on your desk)', 'cloud-1': 'Cloud workstation in Frankfurt', 'cloud-2': 'Cloud workstation in Oregon', 'cloud-3': 'Cloud workstation in Tokyo' }[mc.id] || mc.name } : mc));
          await ctl('push', { event: 'snapshot', data: { ...st, agents: list, machines } }); await sleep(500); await settle(120);
        };
        const WIRE = String.raw`(() => {
          const w = document.querySelector('#board path.dram-wire');
          if (!w) return { on: ['(no wire drawn)'], tray: '' };
          const r = w.getBoundingClientRect(), x = r.left + r.width / 2, on = [];
          for (const m of document.querySelectorAll('.mach')) { const b = m.getBoundingClientRect(); if (b.left < x + 6 && b.right > x - 6) on.push(m.getAttribute('aria-label')); }
          return { on, tray: document.getElementById('tray').textContent.trim(), names: [...document.querySelectorAll('.mach')].map(m => [m.querySelector('.lb b span')?.textContent || '', m.title || '']) };
        })()`;
        for (const [what, o, tray] of [['12 done, 6 from earlier, more working', { working: 31, done: 12, earlier: 6 }, /^12 done, 6 from earlier, \d+ more working$/],
          ['a fuller board, long machine names', { working: 60, done: 60, earlier: 40, rename: true }, /^60 done, 40 from earlier, \d+ more/]]) {
          await load('many'); await crowd(o);
          const r = await b.ev(WIRE);
          if (!tray.test(r.tray)) failures.push(`${tag} (${what}): the crowded board did not show (its tray reads "${r.tray}")`);
          for (const x of r.on) failures.push(`${tag} (${what}): a machine lies on the DRAM's wire: ${x}`);
          for (const [shown, title] of r.names || []) if (shown.endsWith('…') && !title) failures.push(`${tag} (${what}): "${shown}" is cut with no title holding all of it`);
          if (verbose) console.log(tag, what, JSON.stringify(r));
          await check(`${tag} (${what})`);
        }
      } else if (v === 'taint') {
        // Everything an agent controls, with characters in it that hide text or turn it: its name, what it says, asks and
        // does, the words of its answers, its paths, its checks' and its helpers' names. The board, the lid and what is
        // announced, and the pinned card, must show each one by its code, in text and in names for screen readers.
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
          const out = [], skip = () => false;
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
          await load('demo', `&focus=${id}&pin=${id}`); await taint(); await scan(what + ', its card pinned');
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
