// What the page does, checked in headless Chrome against the mock API (scripts/ui-mock.mjs): answers bound to what was
// drawn, the half-second guard after the core changes, holding the core while the person is busy with it, focus never
// landing on an answer, failed answers that can be retried, "Look later", stepping with "next", typed words bound to the
// ask on screen, every prompt going to an agent at once (no card; a card on screen stays), cards answered by id and
// withdrawn when dropped, the look and detail words, the stale key,
// rest (no motion while waiting), reduced motion, space to talk, the keyboard rules, merging, the spending limit, the git
// screen, Agents & keys, Full permissions (the band's button, its card, work typed while they are on, the typed words), and
// the setup card launches wait on (it comes by itself after a prompt; Run it, Not now, typed words, a page opened meanwhile).
// Prints PASS or FAIL per point, then every request the page sent, with its body (a key's values shown as "••••").
// Not part of npm test (it needs Chrome). No dependencies.
//   node scripts/ui-behaviour-check.mjs [--only name] [--log]
import { startMock } from './ui-mock.mjs';
import { launch, sleep, errorsOf } from './ui-cdp.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split('|') : null;   // one or more name parts, split by |
const mock = await startMock({ quiet: true });
const base = `http://127.0.0.1:${mock.port}`;
const ctl = (p, b) => fetch(base + '/ctl/' + p, { method: p === 'log' || p === 'state' ? 'GET' : 'POST', body: p === 'log' || p === 'state' ? undefined : JSON.stringify(b || {}) }).then(r => r.json());
const results = [];
const allPosts = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const b = await launch({ width: 1440, height: 900 });
// the failures this script causes on purpose (a refused key, a 500, a dropped connection, a dropped stream) are expected
// (and the file view's: a save over a file that changed on disk is a 409, on purpose)
const errors = errorsOf(b, /status of 401|status of 500|ERR_EMPTY_RESPONSE|favicon|ERR_INCOMPLETE_CHUNKED|api\/stream|status of 409 \(Conflict\) \S+\/api\/file\b/);
// A stand-in for the browser's speech recognition: records what the page asks of it.
await b.beforeLoad(`(() => {
  window.__sr = { starts: 0, stops: 0, aborts: 0, last: null };
  class FakeSR { constructor() { window.__sr.last = this; } start() { window.__sr.starts++; } stop() { window.__sr.stops++; this.onend && this.onend(); }
    abort() { window.__sr.aborts++; this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend(); }
    hear(text) { this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); } }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
  try { sessionStorage.setItem('wb-voice-told', '1'); } catch (e) {}
})()`);
// A gate on animation frames, shut only by the checks that need it: while it is shut, the page's renders wait (they run
// on a frame) but the stream still updates the page's data. So a button drawn before a change can be clicked after the
// change has arrived and before the page draws it again, every time, without racing the 90 ms render.
await b.beforeLoad(`(() => {
  const raf = window.requestAnimationFrame.bind(window), held = [];
  window.__frames = { hold: false, release() { this.hold = false; for (const cb of held.splice(0)) raf(cb); } };
  window.requestAnimationFrame = cb => { if (window.__frames.hold) { held.push(cb); return 0; } return raf(cb); };
})()`);

const page = () => `document.querySelector('#pages .page:not(.old)')`;
const h1 = () => b.ev(`${page()}?.querySelector('h1')?.textContent || ''`);
const posts = async () => { const l = await ctl('log'); return l; };
const clearLog = async () => { allPosts.push(...(await posts())); await ctl('clear'); };
async function open(scenario, { still = false, theme = 'green', detail = 'calm', mode = {} } = {}) {
  await clearLog();
  await ctl('mode', { answer: 'ok', auth: 'ok', holdMs: 0, down: false, steps: false, merge: 'ok', delay: null, connect: null, ...mode });
  await ctl('scenario', { name: scenario, push: false });
  // the look and detail as Workbench keeps them (the page arrives with them on <html>), and the hint already seen
  await ctl('prefs', { theme, detail, answered: true });
  await b.ev(`(() => { try { sessionStorage.removeItem('wb-later'); sessionStorage.removeItem('wb-reviewed'); } catch (e) {} return 1; })()`).catch(() => {});
  await b.goto(`${base}/?t=k${still ? '&still=1' : ''}`, 1600);
}
const click = sel => b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const clickIn = sel => click(`#pages .page:not(.old) ${sel}`);
const push = (event, data) => ctl('push', { event, data });
const agentOf = async (id) => (await ctl('state')).agents.find(a => a.id === id);
const run = async (name, fn) => { if (only && !only.some(o => name.includes(o))) return; try { await fn(); } catch (e) { check(name, false, 'threw ' + e.message.slice(0, 200)); } };
// Real input, as a person gives it: the pointer stays where it clicked, and keys go where the focus is.
const centre = sel => b.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
const realClick = async sel => { const p = await centre(sel); if (!p) return false; await b.mouse(p[0], p[1], true); return true; };
const realClickIn = sel => realClick(`#pages .page:not(.old) ${sel}`);
// what the line under the board says, whole: a long notice shows cut to its lines, with the whole of it for screen readers
const saidAll = () => b.ev(`(() => { const s = document.getElementById('said'); return s.querySelector('.sr')?.textContent || s.textContent; })()`);
const lidNow = async () => `${await b.ev(`${page()}?.querySelector('.count')?.textContent || ''`)} / ${await h1()}${(await b.ev(`!!${page()}?.querySelector('.also')`)) ? ' +also' : ''}`;
const focusNow = () => b.ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; return (a.closest('#core') ? 'core:' : a.closest('#parts') ? 'board:' : '') + a.tagName + (a.dataset.act ? ':' + a.dataset.act : '') + (a.id ? '#' + a.id : ''); })()`);
const tabTo = async (pred, max = 16) => { for (let i = 0; i < max; i++) { await b.key('Tab'); await sleep(40); if (await b.ev(`(() => { const a = document.activeElement; return !!a && (${pred}); })()`)) return true; } return false; };
const askOf = (id, who, cmd) => ({ id, type: 'permission', sentence: `${who} wants to run a command`, detail: cmd, options: ['Allow', 'Deny'], createdAt: Date.now() });

try {
  await b.goto(`${base}/?t=k`, 800);

  await run('answers carry the drawn agent and ask', async () => {
    await open('race2');
    await sleep(700);
    await clickIn('[data-act="answer"][data-answer="Allow"]');
    await sleep(500);
    const p = (await posts()).filter(x => x.path.includes('/answer'));
    check('answers carry the drawn agent and ask', p.length === 1 && p[0].path === '/api/agents/A/answer' && p[0].body.askId === 'pa' && p[0].body.answer === 'Allow', JSON.stringify(p.map(x => [x.path, x.body])));
  });

  await run('a click right after the core changes is ignored', async () => {
    await open('race');
    await sleep(700);
    const B = await (await fetch(`${base}/ctl/state`)).json();
    void B;
    const newAsk = { ...(await agentOf('A')), id: 'B', name: 'Release prep', state: 'needs_ok', ask: { id: 'pb', type: 'permission', sentence: 'Release prep wants to push its changes', detail: 'git push --force origin main', options: ['Allow', 'Deny'], createdAt: Date.now() } };
    await push('agents', [newAsk]);
    await sleep(260);
    const shown = await h1();
    await clickIn('[data-act="answer"]');
    await sleep(300);
    const early = (await posts()).filter(x => x.path.includes('/answer'));
    await sleep(700);
    await clickIn('[data-act="answer"][data-answer="Deny"]');
    await sleep(400);
    const later = (await posts()).filter(x => x.path.includes('/answer'));
    check('a click right after the core changes is ignored', /Release prep/.test(shown) && early.length === 0 && later.length === 1 && later[0].path === '/api/agents/B/answer' && later[0].body.askId === 'pb',
      `shown "${shown}", early ${early.length}, later ${JSON.stringify(later.map(x => x.body))}`);
  });

  await run('the core holds while the pointer is on it', async () => {
    await open('race');
    await sleep(700);
    const r = await b.ev(`(() => { const c = document.getElementById('core').getBoundingClientRect(); return [c.left + c.width / 2, c.top + 30]; })()`);
    await b.mouse(r[0], r[1]);
    await sleep(150);
    await push('agents', [{ ...(await agentOf('A')), id: 'B', name: 'Release prep', state: 'needs_ok', ask: { id: 'pb', type: 'permission', sentence: 'Release prep wants to push its changes', detail: 'git push', options: ['Allow', 'Deny'], createdAt: Date.now() } }]);
    await sleep(500);
    const held = await h1();
    const also = await b.ev(`!!${page()}?.querySelector('.also')`);
    await b.mouse(5, 5);
    await sleep(900);
    const after = await h1();
    check('the core holds while the pointer is on it', /old search address/.test(held) && also && /Release prep/.test(after), `held "${held}", also ${also}, after "${after}"`);
  });

  // The hold resists changes that arrive on the stream, never the person's own moves (real mouse, pointer left on the core).
  for (const [scen, sel, label, pick] of [['demo', '[data-act="next"]', '"next"'], ['setaside', '[data-act="later"]', '"Look later"'], ['alldone', '[data-act="looksgood"]', '"Looks good"'], ['race', '[data-act="unpick"]', '"Back to what needs me"', 'C']]) {
    await run(`own moves take effect at once with the pointer on the core: ${label}`, async () => {
      await open(scen);
      await sleep(800);
      if (pick) { await realClick(`.chip[data-id="${pick}"]`); await sleep(1100); }
      const before = await lidNow();
      const ok = await realClickIn(sel);
      await sleep(1300);
      const during = await lidNow();
      check(`own moves take effect at once with the pointer on the core: ${label}`, ok && during !== before && !/\+also/.test(during), `"${before}" -> "${during}"`);
    });
  }
  for (const [scen, act, label] of [['demo', 'next', '"next"'], ['setaside', 'later', '"Look later"'], ['alldone', 'looksgood', '"Looks good"']]) {
    await run(`own moves take effect at once by keyboard, and focus stays in the core: ${label}`, async () => {
      await open(scen);
      await sleep(800);
      await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
      const before = await lidNow();
      const ok = await tabTo(`a.dataset.act === '${act}'`);
      await b.key('Enter');
      await sleep(1500);
      const during = await lidNow(), f = await focusNow();
      check(`own moves take effect at once by keyboard, and focus stays in the core: ${label}`, ok && during !== before && !/\+also/.test(during) && f.startsWith('core:'), `"${before}" -> "${during}", focus ${f}`);
    });
  }
  await run('→ steps the queue with focus on the sentence', async () => {
    await open('demo');
    await sleep(800);
    await b.ev(`${page()}.querySelector('h1').focus(), 1`);
    const before = await lidNow();
    await b.key('ArrowRight'); await sleep(1300);
    const after = await lidNow();
    check('→ steps the queue with focus on the sentence', after !== before && /2 of 3/.test(after), `"${before}" -> "${after}"`);
  });
  // Every prompt goes to an agent: typed words that are no command start one at once, with no card, and the line under
  // the board says so; the centre stays as it was.
  await run('typed text starts an agent at once, with no card, and the line under the board says so', async () => {
    await open('prompt');
    await sleep(800);
    const before = await lidNow();
    await realClick('#say'); await sleep(150);
    await b.type('fix the login page'); await b.key('Enter');
    await sleep(1100);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll(), after = await lidNow();
    const chip = await b.ev(`[...document.querySelectorAll('.chip')].some(c => /Fix login page/.test(c.textContent))`);
    check('typed text starts an agent at once, with no card, and the line under the board says so',
      p.length === 1 && p[0].body.text === 'fix the login page' && p[0].body.confirmId === null && words === 'Started a simulated Claude on “fix the login page”.'
        && !/^You said/.test(after) && chip,
      JSON.stringify({ sent: p.map(x => x.body), words, before, after, chip }));
  });
  await run('"thanks" starts an agent, as any prompt does', async () => {
    await open('prompt');
    await sleep(800);
    await realClick('#say'); await sleep(150);
    await b.type('thanks'); await b.key('Enter');
    await sleep(900);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll();
    check('"thanks" starts an agent, as any prompt does', p.length === 1 && p[0].body.text === 'thanks' && words === 'Started a simulated Claude on “thanks”.', JSON.stringify({ sent: p.map(x => x.body), words }));
  });
  await run('pasted code arrives intact: its first and last lines, its indentation and its braces', async () => {
    await open('prompt');
    await sleep(700);
    await b.ev(`document.getElementById('say').focus(), 1`);
    const code = 'function total(cart) {\n  return cart.reduce((a, b) => a + b, 0);\n}';
    await b.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await b.ev(`navigator.clipboard.writeText(${JSON.stringify(code)})`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 });
    await sleep(200);
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await b.key('Enter'); await sleep(900);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll();
    check('pasted code arrives intact: its first and last lines, its indentation and its braces',
      p.length === 1 && p[0].body.text === code && words === 'Started a simulated Claude on “function total(cart) { return cart.reduce((a, b) => a + b, 0); }”.',
      JSON.stringify({ sent: p.map(x => x.body.text), words }));
  });
  await run('"what needs me now" shows what needs you', async () => {
    await open('demo');
    await sleep(800);
    const agents = (await ctl('state')).agents.length;
    await realClick('#say'); await sleep(150);
    await b.type('what needs me now'); await b.key('Enter');
    await sleep(900);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll(), lid = await lidNow();
    check('"what needs me now" shows what needs you', p.length === 1 && words === '3 things need you.' && /Checkout fix/.test(lid) && (await ctl('state')).agents.length === agents,
      JSON.stringify({ sent: p.map(x => x.body), words, lid }));
  });
  await run('a card on screen stays where it is when a prompt starts an agent, and still takes its own words', async () => {
    await open('demo');
    await sleep(800);
    await realClick('#say'); await sleep(150);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(900);
    const card = await h1();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('fix the docs'); await b.key('Enter');
    await sleep(900);
    const kept = await h1(), words = await saidAll();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('cancel'); await b.key('Enter');
    await sleep(700);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const after = await h1();
    check('a card on screen stays where it is when a prompt starts an agent, and still takes its own words',
      card === 'Stop Onboarding?' && kept === card && words === 'Started a simulated Claude on “fix the docs”.' && p.length === 3
        && p[1].body.text === 'fix the docs' && /^c/.test(p[1].body.confirmId || '') && p[2].body.confirmId === p[1].body.confirmId && after !== card,
      JSON.stringify({ card, kept, words, after, sent: p.map(x => x.body) }));
  });
  // A stop word and its target first stop that target, whatever follows: nothing starts, and a card on screen stays.
  await run('a stop with its reason after it stops what it names and starts nothing; on a card it still stops, and the card stays', async () => {
    await open('demo');
    await sleep(800);
    const agents = (await ctl('state')).agents.length;
    await realClick('#say'); await sleep(150);
    await b.type('stop it, it is deleting the wrong files'); await b.key('Enter');
    await sleep(900);
    const words1 = await saidAll();
    const first = (await posts()).filter(x => x.path === '/api/command')[0]?.body;
    const stopped = first?.focusId ? (await agentOf(first.focusId))?.state : null;
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(900);
    const card = await h1();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop everything, the build is broken'); await b.key('Enter');
    await sleep(900);
    const kept = await h1(), words2 = await saidAll(), st = await ctl('state');
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('a stop with its reason after it stops what it names and starts nothing; on a card it still stops, and the card stays',
      /^Stopped .+\.$/.test(words1) && stopped === 'stopped' && card === 'Stop Onboarding?' && kept === card && /^Stopped (all \d+ agents|.+)\.$/.test(words2)
        && st.agents.length === agents && st.agents.every(a => a.parentId || !['starting', 'working'].includes(a.state))
        && p.length === 3 && /^c/.test(p[2].body.confirmId || '') && p[2].body.focusId === null,
      JSON.stringify({ words1, stopped, card, kept, words2, sent: p.map(x => x.body) }));
  });
  // A card's yes or no first answers it, whatever follows, and what follows starts nothing.
  await run('words that begin with a card\'s yes or no answer it, whatever follows, and start nothing', async () => {
    await open('demo');
    await sleep(800);
    const agents = (await ctl('state')).agents.length;
    const ask = async text => { await b.ev(`document.getElementById('say').focus(), 1`); await b.type(text); await b.key('Enter'); await sleep(900); };
    await ask('stop the sign-up one');
    const card1 = await h1();
    await ask('no, because the tests are red');
    const no = await saidAll(), after1 = await h1();
    await ask('stop the sign-up one');
    const card2 = await h1();
    await ask('yes, and then tell me what it did');
    const yes = await saidAll(), after2 = await h1();
    const st = await ctl('state');
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('words that begin with a card\'s yes or no answer it, whatever follows, and start nothing',
      card1 === 'Stop Onboarding?' && no === 'OK, I won’t stop it.' && after1 !== card1 && card2 === card1 && yes === 'Stopped Onboarding.' && after2 !== card2
        && st.agents.length === agents && p.length === 4 && /^c/.test(p[1].body.confirmId || '') && /^c/.test(p[3].body.confirmId || ''),
      JSON.stringify({ card1, no, after1, card2, yes, after2, agents: [agents, st.agents.length], sent: p.map(x => x.body) }));
  });
  // More than one agent from one sentence multiplies what is spent: a card asks first, and its yes starts them all.
  await run('starting more than one agent from one sentence asks first, with a card; its yes starts them all', async () => {
    await open('prompt');
    await sleep(800);
    const agents = (await ctl('state')).agents.length;
    await realClick('#say'); await sleep(150);
    await b.type('start three agents on the login page'); await b.key('Enter');
    await sleep(900);
    const card = await h1(), mid = (await ctl('state')).agents.length;
    const buttons = await b.ev(`[...(${page()}?.querySelectorAll('[data-act="confirm"]') || [])].map(x => x.textContent).join(',')`);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('do it'); await b.key('Enter');
    await sleep(1300);
    const words = await saidAll(), after = (await ctl('state')).agents.length;
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('starting more than one agent from one sentence asks first, with a card; its yes starts them all',
      card === 'Start three simulated Claude agents on “the login page”?' && buttons === 'Start them,Cancel' && mid === agents
        && words === 'Started three simulated Claude agents on “the login page”.' && after === agents + 3 && p.length === 2 && /^c/.test(p[1].body.confirmId || ''),
      JSON.stringify({ card, buttons, agents: [agents, mid, after], words, sent: p.map(x => x.body) }));
  });
  // A program named alone keeps a card on screen: it asks what that program should work on, and its next words start it.
  await run('a program named alone keeps a card on screen, asks what it should work on, and its next words start it', async () => {
    await open('demo');
    await sleep(800);
    const ask = async text => { await b.ev(`document.getElementById('say').focus(), 1`); await b.type(text); await b.key('Enter'); await sleep(900); };
    await ask('stop the sign-up one');
    const card = await h1();
    await ask('codex');
    const kept1 = await h1(), q = await saidAll();
    await ask('fix the login page');
    const kept2 = await h1(), words = await saidAll();
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('a program named alone keeps a card on screen, asks what it should work on, and its next words start it',
      card === 'Stop Onboarding?' && kept1 === card && q === 'What should Codex work on?' && kept2 === card && words === 'Started a simulated Codex on “fix the login page”.'
        && p.length === 3 && p.slice(1).every(x => /^c/.test(x.body.confirmId || '')),
      JSON.stringify({ card, kept1, q, kept2, words, sent: p.map(x => x.body) }));
  });
  await run('words too long to send in one go stay in the box, and nothing is sent', async () => {
    await open('prompt');
    await sleep(700);
    await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = 'x'.repeat(70 * 1024); i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await b.key('Enter'); await sleep(700);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const kept = await b.ev(`document.getElementById('say').value.length`), words = await saidAll();
    check('words too long to send in one go stay in the box, and nothing is sent',
      p.length === 0 && kept === 70 * 1024 && words === 'That is too long to send in one go. The limit is 64 KB.', JSON.stringify({ sent: p.length, kept, words }));
    await b.ev(`(() => { const i = document.getElementById('say'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  });
  await run('spoken words that are only "um" or "uh" send nothing, and the page says nothing was heard', async () => {
    await open('prompt');
    await sleep(800);
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await b.key(' ', { phase: 'down' }); await sleep(300);
    await b.ev(`window.__sr.last && window.__sr.last.hear('um, uh'), 1`);
    await b.key(' ', { phase: 'up' }); await sleep(500);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll();
    check('spoken words that are only "um" or "uh" send nothing, and the page says nothing was heard', p.length === 0 && words === 'Nothing heard.', JSON.stringify({ sent: p.map(x => x.body), words }));
  });
  await run('the ivory look shows the input bar\'s focus ring, at rest and with something in the core', async () => {
    const seen = [];
    for (const sc of ['prompt', 'demo']) {
      await open(sc, { theme: 'ivory' });
      await sleep(700);
      await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`); await sleep(200);
      const idle = await b.ev(`document.getElementById('core').classList.contains('idle')`);
      const rest = await b.ev(`getComputedStyle(document.getElementById('bar')).boxShadow`);
      await b.ev(`document.getElementById('say').focus(), 1`); await sleep(300);
      const focused = await b.ev(`getComputedStyle(document.getElementById('bar')).boxShadow`);
      seen.push({ sc, idle, rest, focused });
    }
    check('the ivory look shows the input bar\'s focus ring, at rest and with something in the core',
      seen.every(x => /\b2px\b/.test(x.focused) && x.focused !== x.rest) && seen.some(x => x.idle) && seen.some(x => !x.idle), JSON.stringify(seen));
  });
  await run('the input grows with its text: Enter sends, Shift+Enter adds a line, a paste keeps its lines', async () => {
    await open('prompt');
    await sleep(700);
    await b.ev(`document.getElementById('say').focus(), 1`);
    const line = await b.ev(`parseFloat(getComputedStyle(document.getElementById('say')).lineHeight)`);
    const lines = () => b.ev(`Math.round(document.getElementById('say').clientHeight / ${line})`);
    const value = () => b.ev(`document.getElementById('say').value`);
    await b.type('fix the login'); await b.key('Enter', { shift: true }); await b.type('it fails on Safari'); await sleep(150);
    const typed = await value(), two = await lines();
    const early = (await posts()).filter(x => x.path === '/api/command').length;
    // a real paste, through the clipboard: the page is given focus and the clipboard, as a person's window has them
    await b.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await b.ev(`navigator.clipboard.writeText('\\nTypeError: total is undefined\\n  at render (cart.js:12)')`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 });
    await sleep(200);
    const pasted = await value(), four = await lines();
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await b.key('Enter'); await sleep(900);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const words = await saidAll(), after = [await value(), await lines()];
    const want = 'fix the login\nit fails on Safari\nTypeError: total is undefined\n  at render (cart.js:12)';
    check('the input grows with its text: Enter sends, Shift+Enter adds a line, a paste keeps its lines',
      typed === 'fix the login\nit fails on Safari' && two === 2 && early === 0 && pasted === want && four === 4 && p.length === 1 && p[0].body.text === want
        && /^Started a simulated Claude on “fix the login it fails on Safari TypeError: total is undefined[^\n”]*”\.$/.test(words) && after[0] === '' && after[1] === 1,
      JSON.stringify({ typed, two, early, pasted, four, sent: p.map(x => x.body.text), words, after }));
  });
  await run('a failed answer keeps the core held on what the person answered, and its button can be tried again', async () => {
    await open('race', { mode: { answer: '500' } });
    await sleep(800);
    const p0 = await centre('#pages .page:not(.old) [data-act="answer"][data-answer="Yes"]');
    await b.mouse(p0[0], p0[1]); await sleep(150);
    await push('agents', [{ ...(await agentOf('A')), id: 'B', name: 'Release prep', state: 'needs_ok', ask: askOf('pb', 'Release prep', 'git push --force origin main') }]);
    await sleep(900);
    const held = await lidNow();
    await realClickIn('[data-act="answer"][data-answer="Yes"]');
    await sleep(1000);
    const after = await lidNow();
    const enabled = await b.ev(`!${page()}?.querySelector('[data-act="answer"][data-answer="Yes"]')?.disabled`);
    check('a failed answer keeps the core held on what the person answered, and its button can be tried again', /old search address/.test(held) && /\+also/.test(held) && /old search address/.test(after) && /\+also/.test(after) && enabled === true,
      `held "${held}", after the failed answer "${after}", Yes enabled ${enabled}`);
    await b.mouse(5, 5);
  });
  await run('an agent that typed work starts takes no one\'s place in the core: its chip comes on the board (pointer on the core)', async () => {
    await open('demo');
    await sleep(800);
    const before = await lidNow();
    await realClick('#say'); await sleep(150);
    await b.type('start an agent to tidy the export'); await b.key('Enter');
    await sleep(1800);
    const shown = await lidNow(), words = await saidAll();
    const chip = await b.ev(`[...document.querySelectorAll('.chip')].some(c => /Tidy export/.test(c.textContent))`);
    check('an agent that typed work starts takes no one\'s place in the core: its chip comes on the board (pointer on the core)',
      shown === before && words === 'Started a simulated Claude on “tidy the export”.' && chip, `"${before}" → "${shown}"; said "${words}"; chip ${chip}`);
  });
  await run('a typed "next" and a reply\'s focusId move the core at once (pointer on the core)', async () => {
    await open('demo');
    await sleep(800);
    await realClick('#say'); await sleep(150);
    await b.type('next'); await b.key('Enter'); await sleep(1300);
    const stepped = await lidNow();
    await realClick('.chip[data-id="902d13"]'); await sleep(1100);
    await realClick('#say'); await sleep(150);
    await b.type('what needs me'); await b.key('Enter'); await sleep(1300);
    const back = await lidNow();
    check('a typed "next" and a reply\'s focusId move the core at once (pointer on the core)', /2 of 3/.test(stepped) && /Checkout fix wants/.test(back) && !/\+also/.test(back), `"${stepped}" then "${back}"`);
  });
  // Typed and spoken words are bound to nothing while the core swaps: the item on screen then is not the one coming in.
  for (const d of [60, 140, 240, 360]) {
    await run(`typed words during a swap are bound to nothing (first key at +${d} ms)`, async () => {
      await open('race2');
      await sleep(900);
      await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
      const A = await agentOf('A');
      await push('agents', [{ ...A, state: 'working', ask: null }, { ...A, id: 'B', name: 'Release prep', ask: askOf('pb', 'Release prep', 'git push --force origin main') }]);
      await sleep(d);
      await b.key('y'); await sleep(200);
      await b.type('es'); await b.key('Enter');
      await sleep(600);
      const p = (await posts()).filter(x => x.path === '/api/command');
      check(`typed words during a swap are bound to nothing (first key at +${d} ms)`, p.length === 1 && p[0].body.askId !== 'pb' && p[0].body.focusId !== 'B', JSON.stringify(p.map(x => x.body)));
    });
  }
  for (const d of [80, 240]) {
    await run(`voice started during a swap is bound to nothing (+${d} ms)`, async () => {
      await open('race2');
      await sleep(900);
      await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
      const A = await agentOf('A');
      await push('agents', [{ ...A, state: 'working', ask: null }, { ...A, id: 'B', name: 'Release prep', ask: askOf('pb', 'Release prep', 'git push --force origin main') }]);
      await sleep(d);
      await b.key(' ', { phase: 'down' }); await sleep(300);
      await b.ev(`window.__sr.last && window.__sr.last.hear('yes'), 1`);
      await b.key(' ', { phase: 'up' }); await sleep(600);
      const p = (await posts()).filter(x => x.path === '/api/command');
      check(`voice started during a swap is bound to nothing (+${d} ms)`, p.length === 1 && p[0].body.askId !== 'pb' && p[0].body.focusId !== 'B', JSON.stringify(p.map(x => x.body)));
    });
  }
  await run('words typed before the person moves the core are not sent to an ask that has left it', async () => {
    await open('race2');
    await sleep(900);
    const A = await agentOf('A');
    await push('agents', [{ ...A, id: 'B', name: 'Release prep', ask: { ...askOf('pb', 'Release prep', 'git push --force origin main'), createdAt: Date.now() + 60000 } }]);
    await sleep(900);
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await b.type('ye'); await sleep(150);
    await realClickIn('[data-act="next"]'); await sleep(1300);
    const shown = await lidNow();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('s'); await b.key('Enter'); await sleep(600);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const sentTo = p[0]?.body.askId;
    const onScreenAtEnter = /Release prep/.test(shown) ? 'pb' : 'pa';
    check('words typed before the person moves the core are not sent to an ask that has left it', p.length === 1 && (sentTo === null || sentTo === onScreenAtEnter) && !(sentTo === 'pa' && onScreenAtEnter === 'pb'), `shown "${shown}", sent ${JSON.stringify(p.map(x => x.body))}`);
  });
  await run('keyboard focus is kept: after an answer, a machine switch, the done tray', async () => {
    await open('race2');
    await sleep(900);
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await tabTo(`a.dataset.answer === 'Deny'`);
    await b.key('Enter'); await sleep(900);
    const afterAnswer = await focusNow();
    await open('demo');
    await sleep(800);
    await b.ev(`document.querySelector('.mach[data-id="cloud-2"]').focus(), 1`);
    await b.key('Enter'); await sleep(300);
    await b.ev(`document.querySelector('#pop [data-machine="cloud-2"]').focus(), 1`);
    await b.key(' '); await sleep(500);
    const afterSwitch = await focusNow();
    await b.key('Escape'); await sleep(200);
    const afterPopEsc = await focusNow();
    await open('many');
    await sleep(900);
    await b.ev(`document.getElementById('tray').focus(), 1`);
    await b.key('Enter'); await sleep(300);
    const inList = await focusNow();
    await b.key('Escape'); await sleep(200);
    const afterTrayEsc = await focusNow();
    await b.key('Enter'); await sleep(300);
    await b.key('Enter'); await sleep(1100);
    const afterRow = await focusNow();
    check('keyboard focus is kept: after an answer, a machine switch, the done tray',
      afterAnswer.startsWith('core:') && afterSwitch === 'BUTTON' && afterPopEsc === 'BUTTON' && /^BUTTON/.test(inList) && afterTrayEsc === 'BUTTON#tray' && afterRow.startsWith('core:'),
      `answer ${afterAnswer}, switch ${afterSwitch}, Esc ${afterPopEsc}, list ${inList}, tray Esc ${afterTrayEsc}, row ${afterRow}`);
  });

  await run('focus never moves to an answer when the core changes', async () => {
    await open('race');
    await sleep(700);
    for (let i = 0; i < 6; i++) { await b.key('Tab'); if (await b.ev(`document.activeElement?.classList.contains('big')`)) break; }
    const onAnswer = await b.ev(`document.activeElement?.dataset.act === 'answer'`);
    // A's question is answered elsewhere and B's permission arrives: the core must change, focus must not land on Allow
    await push('agents', [{ ...(await agentOf('A')), state: 'working', ask: null }, { ...(await agentOf('A')), id: 'B', name: 'Release prep', state: 'needs_ok', ask: { id: 'pb', type: 'permission', sentence: 'Release prep wants to push its changes', detail: 'git push', options: ['Allow', 'Deny'], createdAt: Date.now() } }]);
    await sleep(900);
    const where = await b.ev(`(() => { const a = document.activeElement; return a ? a.tagName + (a.dataset.act ? ':' + a.dataset.act : '') : 'none'; })()`);
    const shown = await h1();
    await b.key(' ', { phase: 'down' }); await sleep(120); await b.key(' ', { phase: 'up' }); await sleep(300);
    const p = (await posts()).filter(x => x.path.includes('/answer'));
    check('focus never moves to an answer when the core changes', onAnswer && /Release prep/.test(shown) && where === 'H1' && p.length === 0, `focus ${where}, posts ${p.length}`);
  });

  for (const how of ['refuse', '500', 'drop']) {
    await run(`a failed answer can be tried again (${how})`, async () => {
      await open('race2', { mode: { answer: how } });
      await sleep(700);
      await clickIn('[data-act="answer"][data-answer="Deny"]');
      await sleep(900);
      const enabled = await b.ev(`!${page()}?.querySelector('[data-act="answer"][data-answer="Deny"]')?.disabled`);
      const said = await saidAll();
      const stillShown = await h1();
      check(`a failed answer can be tried again (${how})`, enabled && said.length > 0 && /Checkout fix/.test(stillShown) && !/token|fetch/i.test(said), `enabled ${enabled}, said "${said}"`);
    });
  }

  await run('"Look later" really defers a failed check', async () => {
    await open('setaside');
    await sleep(800);
    const first = await h1();
    await clickIn('[data-act="later"]');
    await sleep(900);
    const next = await h1();
    const stop = await b.ev(`(() => { const c = document.querySelector('.chip[data-id="X"]'); return c ? c.classList.contains('ghost') : null; })()`);
    const x = await agentOf('X');
    await push('agents', [{ ...x, endedAt: Date.now() + 5, stateSince: Date.now() + 5 }]);
    await sleep(900);
    const back = await h1();
    check('"Look later" really defers a failed check', /check failed/.test(first) && /Help pages/.test(next) && stop === true && /check failed/.test(back), `"${first}" → "${next}" → "${back}"`);
  });

  await run('"next" steps through the queue without sending anything', async () => {
    await open('demo');
    await sleep(800);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('next'); await b.key('Enter');
    await sleep(900);
    const count2 = await b.ev(`${page()}?.querySelector('.count')?.textContent || ''`);
    await b.ev(`document.activeElement.blur(), 1`);
    await b.key('ArrowRight'); await sleep(900);
    const count3 = await b.ev(`${page()}?.querySelector('.count')?.textContent || ''`);
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('"next" steps through the queue without sending anything', /2 of 3/.test(count2) && /3 of 3/.test(count3) && p.length === 0, `"${count2}" → "${count3}", commands ${p.length}`);
  });

  await run('typed words go to the ask that was on screen', async () => {
    await open('demo');
    await sleep(800);
    await b.key('y');
    await sleep(100);
    await b.type('es'); await b.key('Enter');
    await sleep(600);
    const p = (await posts()).filter(x => x.path === '/api/command');
    check('typed words go to the ask that was on screen', p.length === 1 && p[0].body.text === 'yes' && p[0].body.focusId === '399e17' && p[0].body.askId === 'sim-1-12a274' && p[0].body.confirmId === null, JSON.stringify(p.map(x => x.body)));
  });

  await run('a card is answered by its id, and withdrawn when the page drops it', async () => {
    await open('demo');
    await sleep(800);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(900);
    const card1 = await h1();
    await b.key('Escape'); await sleep(200);
    if (await b.ev(`document.activeElement === document.getElementById('say')`)) { await b.key('Escape'); await sleep(200); }
    await b.key('Escape'); await sleep(600);
    let p = await posts();
    const dropped = p.find(x => x.path.startsWith('/api/confirm/'));
    await clearLog();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(1100);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('yes'); await b.key('Enter');
    await sleep(700);
    p = await posts();
    const yes = p.filter(x => x.path === '/api/command').pop();
    await clearLog();
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(1100);
    await clickIn('[data-act="confirm"][data-go="1"]');
    await sleep(600);
    p = await posts();
    const doIt = p.find(x => x.path.startsWith('/api/confirm/'));
    check('a card is answered by its id, and withdrawn when the page drops it',
      /^Stop Onboarding\?/.test(card1) && dropped && dropped.body.go === false && yes && yes.body.text === 'yes' && yes.body.focusId === null && /^c/.test(yes.body.confirmId || '') && doIt && doIt.body.go === true,
      JSON.stringify({ dropped: dropped && [dropped.path, dropped.body], yes: yes && yes.body, doIt: doIt && [doIt.path, doIt.body] }));
  });

  await run('the look and detail words change the page and never reach the engine', async () => {
    await open('demo');
    await sleep(800);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('black and gold'); await b.key('Enter'); await sleep(700);
    const t1 = await b.ev(`document.documentElement.dataset.theme`);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('more detail'); await b.key('Enter'); await sleep(700);
    const d1 = await b.ev(`document.documentElement.dataset.detail`);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('ivory'); await b.key('Enter'); await sleep(700);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('less detail'); await b.key('Enter'); await sleep(700);
    // what the page shows, and what Workbench keeps for its next start (the page keeps nothing itself)
    const held = await ctl('prefs', {});
    const kept = [await b.ev(`document.documentElement.dataset.theme + ',' + document.documentElement.dataset.detail`), held.theme, held.detail,
      await b.ev(`String(localStorage.getItem('wb-theme'))`)].join(',');
    await b.goto(`${base}/?t=k`, 1400);
    const afterReload = await b.ev(`document.documentElement.dataset.theme + ',' + document.documentElement.dataset.detail`);
    const p = (await posts()).filter(x => x.path === '/api/command');
    const saved = (await posts()).filter(x => x.path === '/api/prefs').map(x => JSON.stringify(x.body)).join(' ');
    check('the look and detail words change the page and never reach the engine', t1 === 'black-gold' && d1 === 'more' && kept === 'ivory,calm,ivory,calm,null' && afterReload === 'ivory,calm' && p.length === 0
      && saved === '{"theme":"black-gold"} {"detail":"more"} {"theme":"ivory"} {"detail":"calm"}', `${t1} ${d1} ${kept} ${afterReload}, commands ${p.length}, kept by Workbench: ${saved}`);
    await ctl('prefs', { theme: 'green' });
  });

  await run('the menu under the workbench mark changes the look', async () => {
    await open('demo');
    await sleep(700);
    await click('#brand'); await sleep(300);
    const openNow = await b.ev(`!document.getElementById('look').hidden && document.getElementById('brand').getAttribute('aria-expanded')`);
    await click('#look input[value="black-gold"]'); await sleep(700);
    await click('#look input[value="more"]'); await sleep(700);
    const state = await b.ev(`document.documentElement.dataset.theme + ',' + document.documentElement.dataset.detail`);
    await b.key('Escape'); await sleep(200);
    const closed = await b.ev(`document.getElementById('look').hidden`);
    check('the menu under the workbench mark changes the look', openNow === 'true' && state === 'black-gold,more' && closed, `${openNow} ${state} ${closed}`);
    await ctl('prefs', { theme: 'green', detail: 'calm' });
  });

  await run('a refused key shows the stale-key state and stops typing', async () => {
    await open('race2');
    await sleep(700);
    await ctl('mode', { auth: 'bad' });
    await clickIn('[data-act="answer"][data-answer="Deny"]');
    await sleep(900);
    const link = await b.ev(`document.documentElement.dataset.link`);
    const words = await h1();
    const barHidden = await b.ev(`getComputedStyle(document.getElementById('bar')).visibility === 'hidden'`);
    await b.key('x'); await sleep(100);
    const typed = await b.ev(`document.getElementById('say').value`);
    check('a refused key shows the stale-key state and stops typing', link === 'stale' && /key no longer works/.test(words) && barHidden && typed === '', `${link} "${words}" bar hidden ${barHidden} typed "${typed}"`);
    await ctl('mode', { auth: 'ok' });
  });

  await run('nothing moves at rest, even while something waits', async () => {
    await open('demo');
    await sleep(9000);
    const running = await b.ev(`document.getAnimations().filter(a => a.playState === 'running').map(a => (a.effect?.target?.getAttribute?.('class') || a.effect?.target?.tagName || '') + ':' + (a.animationName || a.constructor.name))`);
    check('nothing moves at rest, even while something waits', running.length === 0, running.join(', '));
  });

  await run('a new ask lights its line once, then rests', async () => {
    await open('race');
    await sleep(1500);
    await push('agents', [{ ...(await agentOf('C')), state: 'needs_ok', ask: { id: 'pc', type: 'permission', sentence: 'Docs site wants to run a command', detail: 'npm run build', options: ['Allow', 'Deny'], createdAt: Date.now() } }]);
    await sleep(700);
    const during = await b.ev(`document.getAnimations().filter(a => a.playState === 'running').length`);
    await sleep(8000);
    const after = await b.ev(`document.getAnimations().filter(a => a.playState === 'running').length`);
    check('a new ask lights its line once, then rests', during > 0 && after === 0, `running during ${during}, after ${after}`);
  });

  await run('with reduced motion, chips jump instead of sliding (watched live)', async () => {
    await open('race');
    await sleep(1200);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    await push('agents', [{ ...(await agentOf('C')), state: 'needs_ok', ask: { id: 'pc2', type: 'permission', sentence: 'Docs site wants to run a command', detail: 'npm run build', options: ['Allow', 'Deny'], createdAt: Date.now() } }]);
    await sleep(400);
    const slides = await b.ev(`[...document.querySelectorAll('.node')].flatMap(n => n.getAnimations()).length`);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    check('with reduced motion, chips jump instead of sliding (watched live)', slides === 0, `node animations ${slides}`);
  });

  await run('steps pulse along the copper, at most one per agent every 1.1 s', async () => {
    await open('demo', { mode: { steps: true } });
    let seen = 0, max = 0;
    for (let i = 0; i < 20; i++) { await sleep(150); const n = await b.ev(`document.querySelectorAll('#wires .pulse').length`); seen += n ? 1 : 0; max = Math.max(max, n); }
    await ctl('mode', { steps: false });
    check('steps pulse along the copper, at most one per agent every 1.1 s', seen > 0 && max <= 3, `seen in ${seen} of 20 samples, at most ${max} at once`);
  });

  await run('hold space to talk; letting go sends; leaving the window throws it away', async () => {
    await open('race');
    await sleep(800);
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await b.key(' ', { phase: 'down' }); await sleep(150);
    const listening = await b.ev(`document.getElementById('bar').classList.contains('listening') && window.__sr.starts`);
    await b.ev(`window.__sr.last.hear('keep it working'), 1`);
    await b.key(' ', { phase: 'up' }); await sleep(600);
    let p = (await posts()).filter(x => x.path === '/api/command');
    const sent = p.length === 1 && p[0].body.text === 'keep it working' && p[0].body.askId === 'qa';
    await clearLog();
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last.hear('this should not go'), window.dispatchEvent(new Event('blur')), 1`);
    await sleep(300);
    await b.key(' ', { phase: 'up' }); await sleep(400);
    p = (await posts()).filter(x => x.path === '/api/command');
    const aborted = await b.ev(`window.__sr.aborts`);
    check('hold space to talk; letting go sends; leaving the window throws it away', listening >= 1 && sent && p.length === 0 && aborted >= 1, `listening ${listening}, sent ${sent}, after blur ${p.length}, aborts ${aborted}`);
  });

  await run('the core lets go by itself after 20 s without input', async () => {
    await open('race');
    await sleep(700);
    const r = await b.ev(`(() => { const c = document.getElementById('core').getBoundingClientRect(); return [c.left + c.width / 2, c.top + 30]; })()`);
    await b.mouse(r[0], r[1]);
    await sleep(150);
    await push('agents', [{ ...(await agentOf('A')), id: 'B', name: 'Release prep', state: 'needs_ok', ask: { id: 'pb', type: 'permission', sentence: 'Release prep wants to push its changes', detail: 'git push', options: ['Allow', 'Deny'], createdAt: Date.now() } }]);
    await sleep(1500);
    const held = await h1();
    await sleep(21500);
    const after = await h1();
    check('the core lets go by itself after 20 s without input', /old search address/.test(held) && /Release prep/.test(after), `held "${held}", after 21 s "${after}"`);
    await b.mouse(5, 5);
  });

  await run('roles: chips, helpers and machines are buttons; the board is a toolbar', async () => {
    await open('demo', { still: true });
    await sleep(600);
    const r = await b.ev(`JSON.stringify({ parts: document.getElementById('parts').getAttribute('role'), machines: document.getElementById('machines').getAttribute('role'),
      odd: [...document.querySelectorAll('.chip, .part, .mach, .more')].filter(e => e.tagName !== 'BUTTON' || e.hasAttribute('role')).length,
      named: [...document.querySelectorAll('.chip, .part, .mach')].every(e => (e.getAttribute('aria-label') || '').length > 3) })`);
    const v = JSON.parse(r);
    check('roles: chips, helpers and machines are buttons; the board is a toolbar', v.parts === 'toolbar' && v.machines === 'group' && v.odd === 0 && v.named, r);
  });

  await run('keyboard: the core comes first, the board is one stop, arrows move inside it', async () => {
    await open('demo', { still: true });
    await sleep(600);
    await b.ev(`document.activeElement.blur(), 1`);
    const stops = [];
    for (let i = 0; i < 14; i++) { await b.key('Tab'); stops.push(await b.ev(`(() => { const a = document.activeElement; return a.closest('#core') ? 'core' : a.closest('#parts') ? 'board' : a.closest('#machines') ? 'machine' : a.id || a.tagName; })()`)); }
    const firstBoard = stops.indexOf('board');
    const boardStops = stops.filter(s => s === 'board').length;
    const firstIsCore = stops[0] === 'core';
    // arrows inside the board
    for (let i = 0; i < 14 && (await b.ev(`!document.activeElement.closest('#parts')`)); i++) await b.key('Tab');
    const before = await b.ev(`document.activeElement.dataset.id`);
    await b.key('ArrowDown'); await sleep(100);
    const after = await b.ev(`document.activeElement.dataset.id`);
    const card = await b.ev(`!document.getElementById('card').hidden && document.activeElement.getAttribute('aria-describedby')`);
    check('keyboard: the core comes first, the board is one stop, arrows move inside it', firstIsCore && firstBoard > 0 && boardStops === 1 && before !== after && card === 'cardSum',
      `stops ${stops.join(' ')}, ${before} → ${after}, describedby ${card}`);
  });

  await run('after clicking a chip, typing still goes to the input', async () => {
    await open('demo', { still: true });
    await sleep(600);
    const r = await b.ev(`(() => { const c = document.querySelector('.chip').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
    await b.mouse(r[0], r[1], true); await sleep(300);
    const active = await b.ev(`document.activeElement === document.body`);
    await b.type('st'); await sleep(100);
    const typed = await b.ev(`document.getElementById('say').value`);
    const pinned = await b.ev(`!document.getElementById('card').hidden`);
    check('after clicking a chip, typing still goes to the input', active && typed === 'st' && pinned, `focus stays ${active}, typed "${typed}", card ${pinned}`);
  });

  await run('"Looks good" answers finished work without an ask id, and it leaves the core', async () => {
    await open('alldone', { still: true });
    await sleep(700);
    const first = await h1();
    await clickIn('[data-act="looksgood"]');
    await sleep(800);
    const p = (await posts()).filter(x => x.path.includes('/answer'));
    const next = await h1();
    check('"Looks good" answers finished work without an ask id, and it leaves the core', p.length === 1 && p[0].body.answer === 'Looks good' && !('askId' in p[0].body) && next !== first,
      `${JSON.stringify(p.map(x => [x.path, x.body]))} "${first}" → "${next}"`);
  });

  await run('a picked chip dropping a card withdraws it', async () => {
    await open('demo', { still: true });
    await sleep(600);
    await b.ev(`document.getElementById('say').focus(), 1`);
    await b.type('stop the sign-up one'); await b.key('Enter');
    await sleep(800);
    const r = await b.ev(`(() => { const c = document.querySelector('.chip').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
    await b.mouse(r[0], r[1], true); await sleep(600);
    const p = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    check('a picked chip dropping a card withdraws it', p.length === 1 && p[0].body.go === false, JSON.stringify(p.map(x => [x.path, x.body])));
  });

  await run('a picked agent: "Tell it something" sends a message, "Stop it" stops it', async () => {
    await open('demo', { still: true });
    await sleep(600);
    const r = await b.ev(`(() => { const c = document.querySelector('.chip[data-id="902d13"]').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
    await b.mouse(r[0], r[1], true); await sleep(900);
    const shown = await h1();
    await clickIn('[data-act="reply"]'); await sleep(200);
    const chip = await b.ev(`document.getElementById('toText').textContent`);
    await b.type('use the staging database'); await b.key('Enter'); await sleep(600);
    await b.mouse(r[0], r[1], true); await sleep(200); await b.mouse(r[0], r[1], true); await sleep(900);
    await clickIn('[data-act="stop"]'); await sleep(600);
    const p = (await posts()).filter(x => /\/(say|stop)$/.test(x.path));
    check('a picked agent: "Tell it something" sends a message, "Stop it" stops it', /Onboarding is working/.test(shown) && /tell Onboarding/.test(chip) && p.length === 2 &&
      p[0].path === '/api/agents/902d13/say' && p[0].body.text === 'use the staging database' && p[1].path === '/api/agents/902d13/stop', `"${shown}" "${chip}" ${JSON.stringify(p.map(x => [x.path, x.body]))}`);
  });

  await run('a message is not sent once its agent has changed', async () => {
    await open('race', { still: true });
    await sleep(600);
    const r = await b.ev(`(() => { const c = document.querySelector('.chip[data-id="C"]').getBoundingClientRect(); return [c.left + c.width / 2, c.top + c.height / 2]; })()`);
    await b.mouse(r[0], r[1], true); await sleep(900);
    await clickIn('[data-act="reply"]'); await sleep(200);
    await b.type('please also update the changelog');
    await push('agents', [{ ...(await agentOf('C')), state: 'question', ask: { id: 'qc', type: 'question', sentence: 'Which changelog?', options: [], createdAt: Date.now() } }]);
    await sleep(500);
    await b.key('Enter'); await sleep(600);
    const p = (await posts()).filter(x => /\/(say|answer)$/.test(x.path) || x.path === '/api/command');
    const said = await saidAll();
    const kept = await b.ev(`document.getElementById('say').value`);
    check('a message is not sent once its agent has changed', p.length === 0 && /That changed/.test(said) && kept === 'please also update the changelog', `posts ${p.length}, said "${said}", kept "${kept}"`);
  });

  await run('machines: a section of the connector opens the menu; the switch posts awake', async () => {
    await open('demo', { still: true });
    await sleep(600);
    await click('.mach[data-id="cloud-2"]'); await sleep(300);
    const shown = await b.ev(`!document.getElementById('pop').hidden`);
    await click('#pop [data-machine="cloud-2"]'); await sleep(500);
    const p = (await posts()).filter(x => x.path.includes('/awake'));
    check('machines: a section of the connector opens the menu; the switch posts awake', shown && p.length === 1 && p[0].body.awake === true, JSON.stringify(p.map(x => [x.path, x.body])));
  });

  await run('reply chip: an answer in your own words goes to that ask', async () => {
    await open('longcmd', { still: true });
    await sleep(600);
    await clickIn('[data-act="next"]'); await sleep(700);
    await clickIn('[data-act="reply"]'); await sleep(300);
    await b.type('keep it for a month'); await b.key('Enter'); await sleep(600);
    const p = (await posts()).filter(x => x.path.includes('/answer'));
    check('reply chip: an answer in your own words goes to that ask', p.length === 1 && p[0].path === '/api/agents/r1/answer' && p[0].body.askId === 'k1' && p[0].body.answer === 'keep it for a month', JSON.stringify(p.map(x => [x.path, x.body])));
  });

  await run('earlier agents: in the tray, never in the queue; Continue picks one up; Forget asks first', async () => {
    await open('earlier');
    await sleep(900);
    const first = await h1();
    // the board's own ask comes first; the earlier agents wait in the tray with their own words
    const trayText = await b.ev(`document.getElementById('tray').textContent`);
    const chips = await b.ev(`[...document.querySelectorAll('#parts .chip')].map(c => c.dataset.id).join(',')`);
    check('earlier agents sit in the tray, not on a lane, and the queue is only what needs you now',
      /^5 from earlier/.test(trayText) && chips === 'e-live1,e-live2' && /Checkout fix wants/.test(first), `tray "${trayText}", chips ${chips}, lid "${first}"`);
    // pick one from the tray's list
    await click('#tray'); await sleep(300);
    const rows = await b.ev(`[...document.querySelectorAll('#trayList .row')].map(r => r.textContent.trim() + (r.classList.contains('earlier') ? ' [earlier]' : '')).join(' | ')`);
    await b.ev(`document.querySelector('#trayList .row[data-agent="e-old0"]').click(), 1`); await sleep(900);
    const lid = `${await b.ev(`${page()}?.querySelector('.count')?.textContent || ''`)} / ${await h1()}`;
    check('picking an earlier agent from the tray puts it in the core with Continue and Forget',
      /From an earlier run/.test(lid) && /Invoice export was done and checked/.test(lid) && /\[earlier\]/.test(rows)
      && (await b.ev(`!!${page()}?.querySelector('[data-act="fix"]') && !!${page()}?.querySelector('[data-act="forget"]')`)), `${lid}; rows ${rows.slice(0, 120)}`);
    // Forget: asks first, with the engine's card
    await clearLog();
    await clickIn('[data-act="forget"]'); await sleep(900);
    const asked = await h1();
    const cmd = (await posts()).filter(x => x.path === '/api/command');
    check('Forget sends "forget it" for that agent and shows the engine’s question; nothing is forgotten yet',
      cmd.length === 1 && cmd[0].body.text === 'forget it' && cmd[0].body.focusId === 'e-old0' && /^Forget Invoice export\?/.test(asked) && !!(await agentOf('e-old0')), `${JSON.stringify(cmd.map(x => x.body))} / ${asked}`);
    await clickIn('[data-act="confirm"][data-go="0"]'); await sleep(600);
    check('Cancel keeps it', !!(await agentOf('e-old0')) && (await posts()).some(x => /\/api\/confirm\//.test(x.path) && x.body.go === false));
    // Forget, yes: gone from the page after the fresh snapshot
    await open('earlier'); await sleep(700);
    await click('#tray'); await sleep(250);
    await b.ev(`document.querySelector('#trayList .row[data-agent="e-old3"]').click(), 1`); await sleep(900);
    await clickIn('[data-act="forget"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1000);
    const left = await b.ev(`document.getElementById('tray').textContent`);
    check('Forget, yes: the agent leaves the tray and the state', !(await agentOf('e-old3')) && /^4 from earlier/.test(left), `tray "${left}"`);
    // Continue: a message, in the same folder; the agent is an ordinary one again, on a lane
    await open('earlier'); await sleep(700);
    await click('#tray'); await sleep(250);
    await b.ev(`document.querySelector('#trayList .row[data-agent="e-old1"]').click(), 1`); await sleep(900);
    await clearLog();
    await clickIn('[data-act="fix"]'); await sleep(1200);
    const say = (await posts()).filter(x => x.path.includes('/say'));
    const chips2 = await b.ev(`[...document.querySelectorAll('#parts .chip')].map(c => c.dataset.id).join(',')`);
    check('Continue sends the message to that agent, which then has a lane and leaves the tray',
      say.length === 1 && say[0].path === '/api/agents/e-old1/say' && say[0].body.text === 'Please continue where you left off.' && /e-old1/.test(chips2) && !(await agentOf('e-old1')).earlier,
      `${JSON.stringify(say.map(x => [x.path, x.body]))}; chips ${chips2}`);
  });

  await run('an earlier agent that cannot continue offers only Forget', async () => {
    await open('earlier'); await sleep(700);
    await click('#tray'); await sleep(250);
    await b.ev(`document.querySelector('#trayList .row[data-agent="e-old2"]').click(), 1`); await sleep(900);
    const txt = await b.ev(`${page()}?.textContent || ''`);
    const acts = await b.ev(`[...${page()}.querySelectorAll('[data-act]')].map(x => x.dataset.act).join(',')`);
    check('an earlier agent whose folder is gone says so and has no Continue', /Its folder is gone, so it cannot continue\./.test(txt) && !/fix/.test(acts) && /forget/.test(acts), `${acts} / ${txt.slice(0, 160)}`);
  });

  // ---------------------------------------------------------------- the done tray: agents the person is finished with
  // A root leaves the board for the done tray once its run has ended and the person is finished with it: merged with
  // nothing new, thrown away, or let go with "Looks good", "Not now" (on work that can merge) or "Dismiss". Set aside
  // stays. Each of these is named "Done tray: …" (`--only 'Done tray'` runs just these).
  const DT = 'Done tray: ';
  const chipsNow = () => b.ev(`[...document.querySelectorAll('#parts .node:not(.leaving) .chip')].map(c => c.dataset.id + (c.classList.contains('ghost') ? '~' : '')).join(',')`);
  const trayNow = () => b.ev(`(() => { const t = document.getElementById('tray'); return t.hidden ? '' : t.textContent.trim(); })()`);
  const lidActs = () => b.ev(`[...(${page()}?.querySelectorAll('button[data-act]') || [])].map(x => x.dataset.act).join(',')`);
  const laneY = t => Number((/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(t || '') || [])[1]);
  const placesNow = () => b.ev(`Object.fromEntries([...document.querySelectorAll('#parts .node:not(.leaving)')].map(n => [n.dataset.id, n.style.transform]))`);
  const mergedNow = a => ({ ...a, work: { ...a.work, merged: { into: 'main', merge: 'f'.repeat(40), at: Date.now(), files: 3, adds: 40, dels: 2 }, problem: null }, files: { changed: 0, adds: 0, dels: 0, list: [] } });

  await run(DT + 'merged and thrown-away work waits in the tray, the one at work keeps the board, and both say how many are done', async () => {
    await open('done-tray');
    await sleep(900);
    const chips = await chipsNow(), tray = await trayNow();
    const names = await b.ev(`[document.getElementById('tray').getAttribute('aria-label'), document.getElementById('parts').getAttribute('aria-label')]`);
    await click('#tray'); await sleep(300);
    const rows = await b.ev(`[...document.querySelectorAll('#trayList h2, #trayList .row')].map(r => (r.dataset.agent ? r.dataset.agent + ':' : '') + r.textContent.trim()).join(' | ')`);
    check(DT + 'merged and thrown-away work waits in the tray, the one at work keeps the board, and both say how many are done',
      chips === 't1,t4~' && tray === '2 done' && names[0] === '2 done. Show them.' && names[1] === 'Your agents and their helpers. 2 done.'
      && rows === 'Done | t2:Help pages · merged | t3:Dark mode · thrown away',
      `chips ${chips}, tray "${tray}", names ${JSON.stringify(names)}, list "${rows}"`);
  });

  await run(DT + 'finished work not looked at yet stays on the board, at its edge, and asks to be looked at', async () => {
    await open('done-waits');
    await sleep(900);
    const chips = await chipsNow(), tray = await trayNow(), lid = await lidNow();
    check(DT + 'finished work not looked at yet stays on the board, at its edge, and asks to be looked at',
      chips === 'w1~' && tray === '' && /^Ready for you to look at \/ Invoice export is done and checked\./.test(lid), `chips ${chips}, tray "${tray}", lid "${lid}"`);
  });

  await run(DT + '"Not now" lets it go: it fades off the board into the tray, a reload keeps it there, and a message brings it back', async () => {
    await open('done-waits');
    await sleep(900);
    const before = await chipsNow();
    await clickIn('[data-act="looksgood"]');
    await sleep(200);
    const fading = await b.ev(`(() => { const n = document.querySelector('#parts .node.leaving'); return n ? { inert: n.inert, moving: n.getAnimations().length, rails: document.querySelectorAll('#wires [data-key^="out:w1:rail"]').length } : null; })()`);
    await sleep(1100);
    const after = await chipsNow(), tray = await trayNow(), nodes = await b.ev(`document.querySelectorAll('#parts .node').length`);
    const rails = await b.ev(`document.querySelectorAll('#board .rails [data-for]').length`), sent = (await posts()).filter(x => x.path === '/api/agents/w1/answer');
    check(DT + '"Not now" lets the chip go: it fades off the board, its lane\'s copper with it, and the tray says its work is not merged',
      before === 'w1~' && !!fading && fading.inert && fading.moving > 0 && fading.rails === 3 && after === '' && nodes === 0 && rails === 0 && tray === '1 not merged'
      && sent.length === 1 && sent[0].body.answer === 'Not now', `${before} → fading ${JSON.stringify(fading)} → chips "${after}", nodes ${nodes}, rails ${rails}, tray "${tray}", ${JSON.stringify(sent.map(x => x.body))}`);
    // a reload in the same tab: the board comes back without it
    await b.goto(`${base}/?t=k`, 1600);
    const reChips = await chipsNow(), reTray = await trayNow(), reLid = await lidNow();
    check(DT + 'a reload keeps it in the tray, and it is not asked about again', reChips === '' && reTray === '1 not merged' && /^All clear/.test(reLid), `chips "${reChips}", tray "${reTray}", lid "${reLid}"`);
    // picked from the tray: in the core, with what can still be done with it; its row says its work is not merged
    await click('#tray'); await sleep(300);
    const row = await b.ev(`document.querySelector('#trayList .row[data-agent="w1"]')?.textContent.trim() || ''`);
    check(DT + 'its row in the tray says its work is not merged', row === 'Invoice export · not merged', `"${row}"`);
    await b.ev(`document.querySelector('#trayList .row[data-agent="w1"]').click(), 1`); await sleep(900);
    const lid = await lidNow(), acts = await lidActs();
    check(DT + 'picked from the tray, it shows in the core with what can still be done with it',
      /Invoice export is done and checked\./.test(lid) && /merge/.test(acts) && /reply/.test(acts) && /review/.test(acts) && (await chipsNow()) === '', `lid "${lid}" [${acts}]`);
    // asked for a change: it works again, back on the board
    await clearLog();
    await clickIn('[data-act="reply"]'); await sleep(300);
    await b.type('please add a test for one invoice'); await b.key('Enter');
    await sleep(1300);
    const say = (await posts()).filter(x => /\/say$/.test(x.path)), back = await chipsNow(), trayBack = await trayNow();
    check(DT + 'a message brings it back to the board, on a lane, at work', say.length === 1 && say[0].path === '/api/agents/w1/say' && back === 'w1' && trayBack === '',
      `${JSON.stringify(say.map(x => [x.path, x.body]))}; chips "${back}", tray "${trayBack}"`);
  });

  await run(DT + 'a stopped agent let go with "Dismiss", picked in the tray, continues: back on the board, at work', async () => {
    // done-tray's t4: stopped with its work kept, and a long name
    await open('done-tray');
    await b.goto(`${base}/?t=k&focus=t4`, 1600);
    const shown = await lidNow();
    await clickIn('[data-act="reviewed"]'); await sleep(1300);
    const chips = await chipsNow(), tray = await trayNow();
    await click('#tray'); await sleep(300);
    const row = await b.ev(`document.querySelector('#trayList .row[data-agent="t4"]')?.textContent.trim() || ''`);
    await b.ev(`document.querySelector('#trayList .row[data-agent="t4"]')?.click(), 1`); await sleep(1000);
    const picked = await lidNow(), acts = await lidActs();
    await clearLog();
    await clickIn('[data-act="fix"]'); await sleep(1300);
    const say = (await posts()).filter(x => /\/say$/.test(x.path)), back = await chipsNow(), trayBack = await trayNow();
    check(DT + 'a stopped agent let go with "Dismiss", picked in the tray, continues: back on the board, at work',
      /was stopped\.$/.test(shown) && chips === 't1' && tray === '3 done' && row === 'Move invoices older than seven years to the cold archive · stopped'
      && /was stopped\.$/.test(picked) && /fix/.test(acts) && /reviewed/.test(acts)
      && say.length === 1 && say[0].path === '/api/agents/t4/say' && say[0].body.text === 'Please continue where you left off.' && back === 't1,t4' && trayBack === '2 done',
      `"${shown}" → chips ${chips}, tray "${tray}", row "${row}"; picked "${picked}" [${acts}]; ${JSON.stringify(say.map(x => [x.path, x.body]))}; chips "${back}", tray "${trayBack}"`);
  });

  await run(DT + 'a lane\'s copper fades with its chip, also while the core changes size for what comes next', async () => {
    // the demo, with Invoice export (done and checked) in the lid: "Looks good" brings Checkout fix's question in, and the
    // core takes its size once the old page has faded, about 200 ms in, while the chip and its copper are still fading
    await open('demo');
    await b.goto(`${base}/?t=k&focus=228202`, 1600);
    const sizeOf = () => b.ev(`document.getElementById('core').style.height`);
    const before = await sizeOf(), lid = await h1();
    await clickIn('[data-act="looksgood"]');
    await sleep(400);
    const mid = await b.ev(`(() => { const op = e => +getComputedStyle(e).opacity; const cu = [...document.querySelectorAll('#wires [data-key^="out:228202:rail"]')];
      const n = document.querySelector('#parts .node.leaving[data-id="228202"]');
      return { copper: cu.length, opacity: cu.map(e => Math.round(op(e) * 100) / 100), chip: n ? Math.round(op(n) * 100) / 100 : null, size: document.getElementById('core').style.height }; })()`);
    await sleep(900);
    const after = await sizeOf(), left = await b.ev(`document.querySelectorAll('#wires [data-key^="out:228202:"], #parts .node[data-id="228202"], #board [data-for="228202"]').length`);
    check(DT + 'a lane\'s copper fades with its chip, also while the core changes size for what comes next',
      /Invoice export is done and checked\./.test(lid) && before !== after && mid.size === after && mid.copper === 3 && mid.opacity.every(x => x > 0.03 && x < 0.97)
      && mid.chip != null && mid.chip > 0.03 && mid.chip < 0.97 && left === 0 && (await trayNow()) === '1 done',
      `core ${before} → ${mid.size} → ${after}; at 400 ms ${JSON.stringify(mid)}; left after ${left}`);
  });

  await run(DT + 'a merge sends it to the tray; the others keep their lanes, and a newcomer takes the freed one', async () => {
    await open('done-waits');
    await sleep(900);
    const w1 = await agentOf('w1');
    const other = (id, name, at) => ({ ...w1, id, rootId: id, name, state: 'working', endedAt: null, stateSince: at, startedAt: at, now: 'Reading the code', says: null, checks: null, files: null, work: null });
    await push('agents', [other('w2', 'Docs site', Date.now())]);
    await sleep(900);
    const p0 = await placesNow();
    await clickIn('[data-act="merge"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1500);
    const p1 = await placesNow(), lid = await lidNow(), tray = await trayNow();
    await push('agents', [other('w3', 'Login page', Date.now() + 1000)]);
    await sleep(1200);
    const p2 = await placesNow();
    // a lane is a row: the core grows and shrinks with the lid's words, which may move a chip along its lane, never off it
    check(DT + 'a merge sends it to the tray; the others keep their lanes, and a newcomer takes the freed one',
      !!p0.w1 && !!p0.w2 && !p1.w1 && laneY(p1.w2) === laneY(p0.w2) && /^merged \/ Invoice export’s work is in main\./.test(lid) && tray === '1 done'
      && laneY(p2.w3) === laneY(p0.w1) && laneY(p2.w2) === laneY(p0.w2) && laneY(p0.w1) !== laneY(p0.w2),
      `before ${JSON.stringify(p0)}, after ${JSON.stringify(p1)}, lid "${lid}", tray "${tray}", newcomer ${JSON.stringify(p2)}`);
  });

  await run(DT + 'when the tray empties, its open list closes and the keyboard goes to the core\'s sentence', async () => {
    const where = () => b.ev(`(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.closest('#trayList') ? 'list' : a.id === 'tray' ? 'tray' : a.closest('#core') ? 'core:' + a.tagName : a.tagName; })()`);
    const shownNow = () => b.ev(`[document.getElementById('tray').hidden, document.getElementById('trayList').hidden, document.getElementById('tray').getAttribute('aria-expanded'), document.getElementById('trayList').textContent.trim()]`);
    const back = async () => { const w1 = await agentOf('w1'); await push('agents', [{ ...w1, state: 'working', endedAt: null, stateSince: Date.now(), now: 'Working on your message', files: null, checks: null }]); };
    // its list open, the keyboard on its only row; then Invoice export works again (told something elsewhere)
    await open('done-waits');
    await sleep(900);
    await clickIn('[data-act="looksgood"]'); await sleep(1300);
    await click('#tray'); await sleep(300);
    const inList = await where();
    await back(); await sleep(1300);
    const [trayHidden, listHidden, expanded, words] = await shownNow(), f = await where();
    check(DT + 'when the tray empties, its open list closes and the keyboard goes to the core\'s sentence',
      inList === 'list' && trayHidden && listHidden && expanded === 'false' && f === 'core:H1' && (await chipsNow()) === 'w1',
      `keyboard ${inList} → ${f}; tray hidden ${trayHidden}, list hidden ${listHidden} ("${words}"), expanded ${expanded}`);
    // the keyboard on the tray itself, its list closed
    await open('done-waits');
    await sleep(900);
    await clickIn('[data-act="looksgood"]'); await sleep(1300);
    await b.ev(`document.getElementById('tray').focus(), 1`); await sleep(100);
    const onTray = await where();
    await back(); await sleep(1300);
    const f2 = await where();
    check(DT + 'when the tray empties with the keyboard on it, the keyboard goes to the core\'s sentence', onTray === 'tray' && f2 === 'core:H1', `${onTray} → ${f2}`);
  });

  await run(DT + 'on a dense board, an agent that leaves moves no other chip', async () => {
    // 'many': 25 agents, so the board is dense; r0, at work on a lane of its own, is stopped and its work thrown away
    await open('many');
    await sleep(900);
    const before = await placesNow(), r0 = await agentOf('r0'), at = Date.now();
    await push('agents', [{ ...r0, state: 'stopped', endedAt: at, stateSince: at, now: 'Stopped',
      work: { branch: null, from: 'main', folder: false, merged: null, problem: null, thrownAway: { at: at + 1, saved: 'refs/workbench/discarded/r0' } } }]);
    await sleep(1300);
    const after = await placesNow();
    const moved = Object.keys(before).filter(id => id !== 'r0' && after[id] !== before[id]);
    check(DT + 'on a dense board, an agent that leaves moves no other chip',
      !!before.r0 && !after.r0 && Object.keys(before).length > 13 && Object.keys(after).length === Object.keys(before).length - 1 && moved.length === 0,
      `${Object.keys(before).length} chips, then ${Object.keys(after).length}; moved ${JSON.stringify(moved.map(id => [id, before[id], after[id]]))}`);
  });

  await run(DT + 'on a dense board whose side is full, a newcomer with no room waits in the tray, which shows for it alone and names it', async () => {
    // 23 at work, laptop and cloud by turns: the left holds twelve, as many as a side holds at this height, the right eleven
    await open('done-waits');
    await sleep(700);
    const st = await ctl('state'), w1 = st.agents.find(a => a.id === 'w1'), at = Date.now();
    const one = (i, machineId, o = {}) => ({ ...w1, id: 'z' + i, rootId: 'z' + i, name: `Crowd ${i}`, machineId, state: 'working', endedAt: null, stateSince: at,
      startedAt: at - (90 - i) * 60000, now: 'Reading the code', says: null, checks: null, files: null, work: null, ...o });
    await push('snapshot', { ...st, agents: Array.from({ length: 23 }, (_, i) => one(i, i % 2 ? 'cloud-1' : 'laptop')) });
    await sleep(1300);
    const sides = () => b.ev(`(() => { const c = document.getElementById('core').getBoundingClientRect(), mid = c.left + c.width / 2, out = { L: 0, R: 0 };
      for (const e of document.querySelectorAll('#parts .node:not(.leaving) .chip')) { const r = e.getBoundingClientRect(); out[r.left + r.width / 2 < mid ? 'L' : 'R']++; } return out; })()`);
    const listed = async () => { await click('#tray'); await sleep(300); const r = await b.ev(`[...document.querySelectorAll('#trayList h2, #trayList .row, #trayList .note')].map(r => (r.dataset.agent ? r.dataset.agent + ':' : '') + r.textContent.trim()).join(' | ')`); await b.key('Escape'); await sleep(250); return r; };
    const s0 = await sides(), t0 = await trayNow(), p0 = await placesNow();
    // one more laptop agent: the left is full, and it never takes the free row on the right
    await push('agents', [one(40, 'laptop', { startedAt: Date.now() })]);
    await sleep(1300);
    const chips1 = await chipsNow(), s1 = await sides(), t1 = await trayNow(), p1 = await placesNow();
    const names = await b.ev(`[document.getElementById('tray').getAttribute('aria-label'), document.getElementById('parts').getAttribute('aria-label')]`);
    const rows1 = await listed();
    // it asks: it takes the row of the newest one at work on its side, which waits in the tray in its place
    await push('agents', [one(40, 'laptop', { startedAt: Date.now(), state: 'needs_ok', ask: { id: 'kz', type: 'permission', sentence: 'Crowd 40 wants to run a command', detail: 'npm test', options: ['Allow', 'Deny'], createdAt: Date.now() } })]);
    await sleep(1300);
    const chips2 = await chipsNow(), t2 = await trayNow(), rows2 = await listed();
    const moved = Object.keys(p0).filter(id => p1[id] !== p0[id]);
    check(DT + 'on a dense board whose side is full, a newcomer with no room waits in the tray, which shows for it alone and names it',
      s0.L === 12 && s0.R === 11 && t0 === '' && !/z40/.test(chips1) && s1.L === 12 && s1.R === 11 && moved.length === 0 && t1 === '1 more working'
      && names[0] === '1 more working with no room on the board. Show them.' && names[1] === 'Your agents and their helpers. 1 more working with no room on the board.'
      && rows1 === 'Working, with no room on the board | z40:Crowd 40 · working'
      && /z40/.test(chips2) && !/z22\b/.test(chips2) && t2 === '1 more working' && rows2 === 'Working, with no room on the board | z22:Crowd 22 · working',
      `sides ${JSON.stringify(s0)}, tray "${t0}" → chips ${chips1.split(',').length} (z40 ${/z40/.test(chips1)}), sides ${JSON.stringify(s1)}, moved ${JSON.stringify(moved)}, tray "${t1}", names ${JSON.stringify(names)}, list "${rows1}"; asking: z40 ${/z40/.test(chips2)}, z22 ${/z22\b/.test(chips2)}, tray "${t2}", list "${rows2}"`);
  });

  await run(DT + 'the keyboard on a chip that leaves goes to the core\'s sentence, and a card pinned to it goes too', async () => {
    await open('done-waits');
    await sleep(900);
    await realClick('.chip[data-id="w1"]'); await sleep(600);
    const pinned = await b.ev(`!document.getElementById('card').hidden`);
    await b.ev(`document.querySelector('.chip[data-id="w1"]').focus(), 1`); await sleep(200);
    const onChip = await focusNow();
    // its work is merged some other way (typed words, the git screen): the stream says so
    await push('agents', [mergedNow(await agentOf('w1'))]);
    await sleep(1300);
    const f = await focusNow(), card = await b.ev(`!document.getElementById('card').hidden`), chips = await chipsNow();
    await b.mouse(5, 5);
    check(DT + 'the keyboard on a chip that leaves goes to the core\'s sentence, and a card pinned to it goes too',
      pinned && onChip === 'board:BUTTON' && f === 'core:H1' && !card && chips === '', `pinned ${pinned}, focus ${onChip} → ${f}, card ${card}, chips "${chips}"`);
  });

  await run(DT + 'with reduced motion a chip leaves at once, and nothing moves', async () => {
    await open('done-waits');
    await sleep(900);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const w1 = await agentOf('w1');
    await push('agents', [{ ...w1, work: { ...w1.work, branch: null, folder: false, thrownAway: { at: Date.now(), saved: 'refs/workbench/discarded/w1' } } }]);
    await sleep(400);
    const nodes = await b.ev(`document.querySelectorAll('#parts .node').length`);
    const moving = await b.ev(`document.getAnimations().filter(a => a.playState === 'running' && a.effect?.target?.closest?.('#parts, #wires, #board')).length`);
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    check(DT + 'with reduced motion a chip leaves at once, and nothing moves', nodes === 0 && moving === 0 && (await trayNow()) === '1 done', `nodes ${nodes}, moving ${moving}`);
  });

  await run(DT + '"Dismiss" lets a failed agent go; "Look later" keeps a failed check on the board', async () => {
    await open('merge-more');
    await b.goto(`${base}/?t=k&focus=n3`, 1600);
    const shown = await lidNow();
    await clickIn('[data-act="reviewed"]'); await sleep(1300);
    const chips = await chipsNow(), tray = await trayNow();
    // a failed check set aside stays on the board (and the existing "Look later" check holds it to its edge)
    await b.goto(`${base}/?t=k&focus=n1`, 1600);
    await clickIn('[data-act="later"]'); await sleep(1300);
    const chips2 = await chipsNow(), tray2 = await trayNow();
    check(DT + '"Dismiss" lets a failed agent go; "Look later" keeps a failed check on the board',
      /Order history stopped with an error\./.test(shown) && !/n3/.test(chips) && tray === '1 done' && /n1~/.test(chips2) && !/n3/.test(chips2) && tray2 === '1 done',
      `"${shown}" → chips ${chips}, tray "${tray}"; after Look later: chips ${chips2}, tray "${tray2}"`);
  });

  await run(DT + 'a merge that did not go through keeps its agent on the board, set aside or not, until "Dismiss" lets it go: the tray says "not merged"', async () => {
    // Invoice export, let go with "Not now", is picked in the tray and merged; the merge conflicts
    await open('done-waits', { mode: { merge: 'conflict' } });
    await sleep(900);
    await clickIn('[data-act="looksgood"]'); await sleep(1300);
    const tray0 = await trayNow();
    await click('#tray'); await sleep(300);
    await b.ev(`document.querySelector('#trayList .row[data-agent="w1"]').click(), 1`); await sleep(900);
    await clickIn('[data-act="merge"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1500);
    const chips1 = await chipsNow(), lid1 = await lidNow(), quiet = await b.ev(`[...(${page()}?.querySelectorAll('.links button') || [])].map(x => x.textContent).join(',')`);
    // "Look later": set aside, it stays at the board's edge
    await clickIn('[data-act="later"]'); await sleep(1300);
    const chips2 = await chipsNow(), lid2 = await lidNow();
    // picked on the board, "Dismiss": off the board, into the tray, and its row says its work is not merged
    await click('.chip[data-id="w1"]'); await sleep(900);
    const lid3 = await lidNow();
    await clickIn('[data-act="reviewed"]'); await sleep(1300);
    const chips4 = await chipsNow(), tray4 = await trayNow(), lid4 = await lidNow();
    await click('#tray'); await sleep(300);
    const row = await b.ev(`document.querySelector('#trayList .row[data-agent="w1"]')?.textContent.trim() || ''`);
    // a reload keeps it there, and it is neither asked about again nor offered as set aside
    await b.goto(`${base}/?t=k`, 1600);
    const reChips = await chipsNow(), reTray = await trayNow(), reLid = await lidNow();
    check(DT + 'a merge that did not go through keeps its agent on the board, set aside or not, until "Dismiss" lets it go: the tray says "not merged"',
      tray0 === '1 not merged' && chips1 === 'w1~' && /Invoice export’s work does not merge cleanly into main\./.test(lid1) && quiet === 'Review the changes,Dismiss'
      && chips2 === 'w1~' && /^1 set aside/.test(lid2) && /does not merge cleanly/.test(lid3)
      && chips4 === '' && tray4 === '1 not merged' && /^All clear/.test(lid4) && row === 'Invoice export · not merged'
      && reChips === '' && reTray === '1 not merged' && /^All clear/.test(reLid),
      `tray "${tray0}"; merged from the tray: chips ${chips1}, lid "${lid1}" [${quiet}]; Look later: chips ${chips2}, lid "${lid2}"; picked "${lid3}"; Dismiss: chips "${chips4}", tray "${tray4}", lid "${lid4}", row "${row}"; reload: chips "${reChips}", tray "${reTray}", lid "${reLid}"`);
  });

  await run(DT + 'a "Not now" drawn before a merge went wrong does not dismiss what went wrong: its agent stays on the board', async () => {
    // done-waits' Invoice export, its lid drawn with "Not now"; a merge of it conflicts (from elsewhere) before the lid is
    // drawn again, and the old "Not now" is clicked
    await open('done-waits');
    await sleep(900);
    const w1 = await agentOf('w1');
    await b.ev(`window.__frames.hold = true, 1`);
    await push('agents', [{ ...w1, work: { ...w1.work, problem: { why: 'conflict', sentence: 'Invoice export’s work does not merge cleanly into main.', paths: ['src/invoices/batch.ts'], into: 'main', at: Date.now() } } }]);
    await sleep(500);   // the stream has brought it; the lid has not been drawn again
    const drawn = await b.ev(`${page()}?.querySelector('[data-act="looksgood"]')?.textContent || ''`);
    await clickIn('[data-act="looksgood"]');
    await sleep(300);
    await b.ev(`window.__frames.release(), 1`);
    await sleep(1300);
    const chips = await chipsNow(), tray = await trayNow(), lid = await lidNow();
    check(DT + 'a "Not now" drawn before a merge went wrong does not dismiss what went wrong: its agent stays on the board',
      drawn === 'Not now' && chips === 'w1~' && tray === '' && /does not merge cleanly into main\./.test(lid), `clicked "${drawn}" → chips "${chips}", tray "${tray}", lid "${lid}"`);
  });

  await run(DT + 'typed or said, "not now" and "looks good" at a finished agent\'s lid do what its button does, and no command is sent', async () => {
    const typeIt = async text => { await b.ev(`document.getElementById('say').focus(), 1`); await b.type(text); await b.key('Enter'); };
    const sent = async () => (await posts()).filter(x => x.path === '/api/command' || /\/answer$/.test(x.path)).map(x => [x.path, x.body]);
    // typed "not now" at done-waits' Invoice export: what its "Not now" posts, and it goes to the tray, not merged
    await open('done-waits');
    await sleep(900);
    await typeIt('not now'); await sleep(1300);
    const p1 = await sent(), chips1 = await chipsNow(), tray1 = await trayNow();
    // said aloud, "Looks good." at the demo's Invoice export (the demo merges nothing, so its lid has "Looks good")
    await open('demo');
    await b.goto(`${base}/?t=k&focus=228202`, 1600);
    await clearLog();
    const lid = await h1();
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last.hear('Looks good.'), 1`);
    await b.key(' ', { phase: 'up' }); await sleep(1300);
    const p2 = await sent(), tray2 = await trayNow();
    // anything more than those words goes on as before: to the engine, as a command
    await open('done-waits');
    await sleep(900);
    await typeIt('looks good, merge it'); await sleep(1000);
    const p3 = await sent();
    // "looks good" where no button stands for it: work that can merge offers Merge and "Not now", and words that sound
    // like approval neither merge it nor press "Not now" (which would send work not merged yet to the tray). Nothing is
    // sent, and the page says which answers the lid has
    const saidNow = () => b.ev(`document.getElementById('said').textContent`);
    await open('done-waits');
    await sleep(900);
    await typeIt('looks good'); await sleep(1000);
    const p4 = await sent(), chips4 = await chipsNow(), said4 = await saidNow();
    // "not now" sets aside what its lid sets aside, whatever that button says: "Look later" at a merge that conflicts,
    // and at a failed check
    const notNowAt = async (sc, id) => {
      await open(sc); await b.goto(`${base}/?t=k&focus=${id}`, 1600); await clearLog();
      await typeIt('not now'); await sleep(1000);
      return { p: await sent(), said: await saidNow(), later: await b.ev(`sessionStorage.getItem('wb-later') || ''`) };
    };
    const conflict = await notNowAt('merge', 'm7e8f9'), failedCheck = await notNowAt('merge-more', 'n1');
    // "ok" at a stopped agent's lid could as well mean Continue: nothing is pressed or sent, and the lid's answers are
    // named; "not now" there is its Dismiss, and it goes to the tray. "ok" beside "Give it $2.00 more" sends nothing either
    await open('done-tray'); await b.goto(`${base}/?t=k&focus=t4`, 1600); await clearLog();
    await typeIt('ok'); await sleep(1000);
    const p6 = (await posts()).map(x => [x.path, x.body]), chips6 = await chipsNow(), said6 = await saidNow();
    await typeIt('not now'); await sleep(1300);
    const p7 = (await posts()).map(x => [x.path, x.body]), chips7 = await chipsNow(), tray7 = await trayNow();
    await open('limit'); await sleep(900); await clearLog();
    const limitLid = await h1();
    await typeIt('ok'); await sleep(1000);
    const pLimit = (await posts()).map(x => [x.path, x.body]), saidLimit = await saidNow();
    // "not now" where "Looks good" answers both (the demo merges nothing): that button, with "Not now" for its answer
    await open('demo'); await b.goto(`${base}/?t=k&focus=228202`, 1600); await clearLog();
    await typeIt('not now'); await sleep(1300);
    const p8 = await sent();
    check(DT + 'typed or said, "not now" and "looks good" at a finished agent\'s lid do what its button does, and no command is sent',
      p1.length === 1 && p1[0][0] === '/api/agents/w1/answer' && p1[0][1].answer === 'Not now' && !('askId' in p1[0][1]) && chips1 === '' && tray1 === '1 not merged'
      && /Invoice export is done and checked\./.test(lid) && p2.length === 1 && p2[0][0] === '/api/agents/228202/answer' && p2[0][1].answer === 'Looks good' && tray2 === '1 done'
      && p3.length === 1 && p3[0][0] === '/api/command' && p3[0][1].text === 'looks good, merge it'
      && p4.length === 0 && chips4 === 'w1~' && said4 === 'Choose “Merge into main” or “Not now”.'
      && conflict.p.length === 0 && conflict.said === 'OK, Search cleanup can wait.' && /"m7e8f9@/.test(conflict.later)
      && failedCheck.p.length === 0 && /^OK, .+ can wait\.$/.test(failedCheck.said) && /"n1@/.test(failedCheck.later)
      && p6.length === 0 && chips6 === 't1,t4~' && said6 === 'Choose “Continue” or “Dismiss”.' && p7.length === 0 && chips7 === 't1' && tray7 === '3 done'
      && /stopped with an error\.$/.test(limitLid) && pLimit.length === 0 && saidLimit === 'Choose “Give it $2.00 more” or “Dismiss”.'
      && p8.length === 1 && p8[0][0] === '/api/agents/228202/answer' && p8[0][1].answer === 'Not now',
      `typed: ${JSON.stringify(p1)} → chips "${chips1}", tray "${tray1}"; said at "${lid}": ${JSON.stringify(p2)} → tray "${tray2}"; more: ${JSON.stringify(p3)}; "looks good" with no such button: ${JSON.stringify(p4)}, chips "${chips4}", said "${said4}"; "not now" at a conflict: ${JSON.stringify(conflict)}; at a failed check: ${JSON.stringify(failedCheck)}; "ok" at a stopped agent: ${JSON.stringify(p6)}, chips "${chips6}", said "${said6}"; then "not now": ${JSON.stringify(p7)}, chips "${chips7}", tray "${tray7}"; "ok" at "${limitLid}": ${JSON.stringify(pLimit)}, said "${saidLimit}"; "not now" in the demo: ${JSON.stringify(p8)}`);
  });

  // ---------------------------------------------------------------- D2: merge, review and throw away (the 'merge' scenarios)
  // In 'merge', the lid shows Invoice export (m1a2b3, done and checked, work not merged yet) first, of three to look at;
  // Search cleanup (m7e8f9) has a merge that conflicts, Price rounding (mab0c1) one your own changes blocked.
  const acts = () => b.ev(`[...(${page()}?.querySelectorAll('.acts button') || [])].map(x => x.textContent + (x.classList.contains('pri') ? '*' : '')).join(',')`);
  const links = () => b.ev(`[...(${page()}?.querySelectorAll('.links button') || [])].map(x => x.textContent).join(',')`);
  const said = () => saidAll();
  const typeIn = async text => { await b.ev(`document.getElementById('say').focus(), 1`); await b.type(text); await b.key('Enter'); };
  const workPosts = async () => (await posts()).filter(x => /\/(merge|discard|say|answer)$/.test(x.path) || x.path.startsWith('/api/confirm/') || x.path === '/api/command');
  // the git screen is builder D1's (#gitScreen in ui/index.html, ui/gitscreen.js): checks that need it say so when it is not here
  const gitHere = async () => { const r = await fetch(`${base}/ui/gitscreen.js`); await r.arrayBuffer().catch(() => {}); return r.ok && (await b.ev(`!!document.getElementById('gitScreen')`)); };
  const NEEDS_D1 = 'needs builder D1\'s git screen: #gitScreen in ui/index.html and ui/gitscreen.js are not in this page yet';
  const screen = () => b.ev(`(() => { const g = document.getElementById('gitScreen'), s = document.getElementById('boardScreen'); if (!g || !s) return 'none'; return s.inert && !g.inert ? 'git' : !s.inert && g.inert ? 'board' : 'moving'; })()`);

  await run('Merge asks first: it posts the agent and the state it was drawn for, and the engine’s card shows its own words', async () => {
    await open('merge');
    await sleep(900);
    const before = await lidNow(), row = await acts(), quiet = await links();
    await clickIn('[data-act="merge"]');
    await sleep(900);
    const p = await workPosts(), card = await lidNow(), cardActs = await acts();
    check('Merge asks first: it posts the agent and the state it was drawn for, and the engine’s card shows its own words',
      /Invoice export is done and checked/.test(before) && row === 'Merge into main*,Ask for a change' && quiet === 'Review the changes,Not now'
      && p.length === 1 && p[0].path === '/api/agents/m1a2b3/merge' && p[0].body.state === 'done_checked'
      && /^Before it merges \/ Merge Invoice export into main\?/.test(card) && cardActs === 'Merge*,Cancel',
      `"${before}" [${row}] [${quiet}] → ${JSON.stringify(p.map(x => [x.path, x.body]))} → "${card}" [${cardActs}]`);
  });

  await run('the merge card’s yes and no post /api/confirm/<id>; yes shows the outcome on that agent', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="merge"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="0"]'); await sleep(900);
    const no = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    const afterNo = await lidNow(), saidNo = await said();
    await clickIn('[data-act="merge"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1300);
    const yes = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    const afterYes = await lidNow(), saidYes = await said(), quiet = await acts();
    check('the merge card’s yes and no post /api/confirm/<id>; yes shows the outcome on that agent',
      no.length === 1 && no[0].body.go === false && /OK, I won’t merge it\./.test(saidNo) && /Invoice export is done and checked/.test(afterNo)
      && yes.length === 2 && yes[1].body.go === true && yes[1].path !== yes[0].path && /Merged Invoice export into main\./.test(saidYes)
      && /^merged \/ Invoice export’s work is in main\./.test(afterYes) && quiet === 'See it in git*,Ask for a change',
      `no ${JSON.stringify(no.map(x => [x.path, x.body]))} "${afterNo}" "${saidNo}"; yes ${JSON.stringify(yes.map(x => [x.path, x.body]))} "${afterYes}" "${saidYes}" [${quiet}]`);
  });

  await run('a Merge click right after the core changes is ignored', async () => {
    await open('merge');
    await sleep(900);
    // Search cleanup's conflict clears and it finishes again, newest: it comes to the core with its own Merge
    const s = await agentOf('m7e8f9');
    await push('agents', [{ ...s, endedAt: Date.now(), stateSince: Date.now(), work: { ...s.work, problem: null } }]);
    await sleep(260);
    const shown = await h1();
    await clickIn('[data-act="merge"]');
    await sleep(300);
    const early = (await posts()).filter(x => /\/merge$/.test(x.path));
    await sleep(700);
    await clickIn('[data-act="merge"]');
    await sleep(500);
    const later = (await posts()).filter(x => /\/merge$/.test(x.path));
    check('a Merge click right after the core changes is ignored', /Search cleanup is done and checked/.test(shown) && early.length === 0 && later.length === 1 && later[0].path === '/api/agents/m7e8f9/merge',
      `shown "${shown}", early ${early.length}, later ${JSON.stringify(later.map(x => x.path))}`);
  });

  // A button drawn before a change acts on nothing after it: the agent's state, where its work went, or your branch.
  for (const [what, change] of [
    ['its state', a => push('agents', [{ ...a, state: 'working', endedAt: null, now: 'Working on your message' }])],
    ['where its work went', a => push('agents', [{ ...a, work: { ...a.work, merged: { into: 'main', merge: 'f'.repeat(40), at: Date.now(), files: 3, adds: 40, dels: 2 } }, files: { changed: 0, adds: 0, dels: 0, list: [] } }])],
    ['your branch', () => push('repo', { name: 'invoices-api', head: 'abc1234', branch: 'release', dirty: 2, identity: true })],
  ]) {
    await run(`a Merge drawn before a change in ${what} says "That changed" and posts nothing`, async () => {
      await open('merge');
      await sleep(900);
      const a = await agentOf('m1a2b3');
      await b.ev(`window.__frames.hold = true, 1`);
      await change(a);
      await sleep(500);   // the stream has brought it; the lid has not been drawn again
      const drawn = await b.ev(`${page()}?.querySelector('[data-act="merge"]')?.dataset.state || ''`);
      await clickIn('[data-act="merge"]');
      await sleep(150);
      const words = await said();
      await b.ev(`window.__frames.release(), 1`);
      await sleep(800);
      const p = (await posts()).filter(x => /\/merge$/.test(x.path));
      check(`a Merge drawn before a change in ${what} says "That changed" and posts nothing`, drawn === 'done_checked' && p.length === 0 && /That changed\. Have another look\./.test(words),
        `drawn for ${drawn}, posts ${p.length}, said "${words}"`);
    });
  }

  await run('Throw it away always asks: no default answer, a bare "yes" is not enough, and Keep it keeps it', async () => {
    await open('merge');
    await sleep(900);
    await typeIn('throw it away'); await sleep(1000);
    const card = await lidNow(), row = await acts();
    const discards = (await posts()).filter(x => /\/discard$/.test(x.path));
    await typeIn('yes'); await sleep(800);
    const afterYes = await lidNow(), saidYes = await said();
    await clickIn('[data-act="confirm"][data-go="0"]'); await sleep(900);
    const kept = (await agentOf('m1a2b3')).work;
    await typeIn('throw it away'); await sleep(1000);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1300);
    const gone = (await agentOf('m1a2b3')).work, after = await lidNow();
    const p = (await posts()).filter(x => x.path === '/api/command' || x.path.startsWith('/api/confirm/'));
    check('Throw it away always asks: no default answer, a bare "yes" is not enough, and Keep it keeps it',
      /^Before it is thrown away \/ Throw away Invoice export’s work\?/.test(card) && row === 'Throw it away,Keep it' && discards.length === 0
      && afterYes === card && /^Say “do it” to throw it away, or “cancel”\./.test(saidYes)
      && !kept.thrownAway && gone.thrownAway && /^thrown away \/ Invoice export’s work was thrown away\./.test(after)
      && p[0].body.text === 'throw it away' && p[0].body.focusId === 'm1a2b3' && p[1].body.text === 'yes' && /^c/.test(p[1].body.confirmId || '')
      && p.some(x => x.path.startsWith('/api/confirm/') && x.body.go === false) && p.some(x => x.path.startsWith('/api/confirm/') && x.body.go === true),
      `"${card}" [${row}]; yes → "${afterYes}" "${saidYes}"; kept ${!kept.thrownAway}; then "${after}"; ${JSON.stringify(p.map(x => [x.path, x.body]))}`);
  });

  await run('"Not now" does what "Looks good" did: an answer without an ask id, and the core moves on', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="looksgood"]'); await sleep(1100);
    const p = (await posts()).filter(x => x.path.includes('/answer'));
    const next = await lidNow();
    check('"Not now" does what "Looks good" did: an answer without an ask id, and the core moves on',
      p.length === 1 && p[0].path === '/api/agents/m1a2b3/answer' && p[0].body.answer === 'Not now' && !('askId' in p[0].body) && /Search cleanup’s work does not merge cleanly into main/.test(next),
      `${JSON.stringify(p.map(x => [x.path, x.body]))} → "${next}"`);
  });

  await run('a merge that conflicts: "Ask it to bring in main" sends its exact message; "Look later" sets it aside', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="next"]'); await sleep(1100);
    const shown = await lidNow(), row = await acts(), meta = await b.ev(`${page()}?.querySelector('.meta')?.textContent || ''`);
    await clickIn('[data-act="fix"]'); await sleep(900);
    const p = (await posts()).filter(x => x.path.includes('/say'));
    check('a merge that conflicts: "Ask it to bring in main" sends its exact message',
      /Search cleanup’s work does not merge cleanly into main\./.test(shown) && row === 'Ask it to bring in main*,Look later' && meta === 'Both changed: src/search/index.ts, src/search/redirects.ts'
      && p.length === 1 && p[0].path === '/api/agents/m7e8f9/say'
      && p[0].body.text === 'Your work conflicts with the latest main in: src/search/index.ts, src/search/redirects.ts. Please merge main into your branch, resolve the conflicts, and finish.',
      `"${shown}" [${row}] "${meta}" ${JSON.stringify(p.map(x => [x.path, x.body]))}`);
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="next"]'); await sleep(1100);
    await clickIn('[data-act="later"]'); await sleep(1100);
    const after = await lidNow();
    check('"Look later" on a merge that conflicts sets it aside', /Price rounding|Invoice export/.test(after) && !/Search cleanup/.test(after), `"${after}"`);
  });

  await run('your own changes in the way: "Try again" asks for the merge again', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="next"]'); await sleep(1100);
    await clickIn('[data-act="next"]'); await sleep(1100);
    const shown = await lidNow(), row = await acts();
    await clickIn('[data-act="merge"]'); await sleep(900);
    const p = (await posts()).filter(x => /\/merge$/.test(x.path));
    const card = await h1();
    check('your own changes in the way: "Try again" asks for the merge again', /Your own changes are in the way\./.test(shown) && row === 'Try again*,Not now'
      && p.length === 1 && p[0].path === '/api/agents/mab0c1/merge' && p[0].body.state === 'done_claimed' && /^Merge Price rounding into main\?/.test(card),
      `"${shown}" [${row}] ${JSON.stringify(p.map(x => [x.path, x.body]))} "${card}"`);
  });

  await run('a merge git refuses after yes: its reason stays on the agent, in the engine’s words', async () => {
    await open('merge', { mode: { merge: 'conflict' } });
    await sleep(900);
    await clickIn('[data-act="merge"]'); await sleep(900);
    await clickIn('[data-act="confirm"][data-go="1"]'); await sleep(1300);
    const shown = await lidNow(), row = await acts(), words = await said();
    check('a merge git refuses after yes: its reason stays on the agent, in the engine’s words',
      / \/ Invoice export’s work does not merge cleanly into main\./.test(shown) && row === 'Ask it to bring in main*,Look later' && /does not merge cleanly into main/.test(words),
      `"${shown}" [${row}] "${words}"`);
  });

  await run('a refused Merge changes nothing: the reply shows and the button can be tried again', async () => {
    await open('merge', { mode: { merge: 'refuse' } });
    await sleep(900);
    await clickIn('[data-act="merge"]'); await sleep(900);
    const shown = await lidNow(), words = await said();
    const enabled = await b.ev(`!${page()}?.querySelector('[data-act="merge"]')?.disabled`);
    check('a refused Merge changes nothing: the reply shows and the button can be tried again',
      /Invoice export is done and checked/.test(shown) && enabled && /Invoice export is being merged now\./.test(words) && !/token|fetch/i.test(words), `"${shown}" enabled ${enabled} "${words}"`);
  });

  await run('Esc withdraws a merge card', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="merge"]'); await sleep(900);
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    await b.key('Escape'); await sleep(700);
    const p = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    const after = await lidNow();
    check('Esc withdraws a merge card', p.length === 1 && p[0].body.go === false && /Invoice export is done and checked/.test(after), `${JSON.stringify(p.map(x => [x.path, x.body]))} "${after}"`);
  });

  await run('no Merge where git cannot: the lid says why, and "Looks good" stays', async () => {
    await open('merge-detached');
    await sleep(900);
    const row = await acts(), why = await b.ev(`${page()}?.querySelector('.meta.git')?.textContent || ''`);
    check('no Merge where git cannot: the lid says why, and "Looks good" stays', row === 'Looks good*,Ask for a change' && why === 'Your folder is not on a branch, so there is nowhere to merge it.', `[${row}] "${why}"`);
  });

  await run('Review the changes posts nothing', async () => {
    await open('merge');
    await sleep(900);
    await clickIn('[data-act="review"]'); await sleep(900);
    const p = (await posts()).filter(x => x.path !== '/api/state');
    check('Review the changes posts nothing', p.length === 0, JSON.stringify(p.map(x => [x.path, x.body])));
  });

  await run('Review opens the git screen on that agent, and Esc comes back to the lid with focus on the link', async () => {
    await open('merge');
    await sleep(900);
    if (!(await gitHere())) { check('Review opens the git screen on that agent, and Esc comes back to the lid with focus on the link', false, NEEDS_D1); return; }
    await b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
    const reached = await tabTo(`a.dataset.act === 'review'`);
    await b.key('Enter'); await sleep(1400);
    const there = await screen();
    const detail = await b.ev(`(() => { const d = document.getElementById('gitDetail'); return d && !d.hidden ? d.textContent : ''; })()`);
    for (let i = 0; i < 3 && (await screen()) !== 'board'; i++) { await b.key('Escape'); await sleep(1300); }
    const back = await screen(), f = await b.ev(`document.activeElement?.dataset.act || document.activeElement?.id || ''`);
    const p = (await posts()).filter(x => x.path !== '/api/state');
    check('Review opens the git screen on that agent, and Esc comes back to the lid with focus on the link',
      reached && there === 'git' && /Invoice export/.test(detail) && back === 'board' && f === 'review' && p.length === 0, `reached ${reached}, ${there}, detail "${detail.slice(0, 60)}", back ${back}, focus ${f}, posts ${p.length}`);
  });

  await run('the DRAM opens the git screen and "Back to the board" returns', async () => {
    await open('merge');
    await sleep(900);
    if (!(await gitHere()) || !(await b.ev(`!!document.getElementById('dram')`))) { check('the DRAM opens the git screen and "Back to the board" returns', false, NEEDS_D1); return; }
    await click('#dram'); await sleep(1400);
    const there = await screen();
    await b.ev(`[...document.querySelectorAll('#gitScreen button')].find(x => /Back to the board/.test(x.textContent))?.click(), 1`); await sleep(1400);
    const back = await screen(), f = await b.ev(`document.activeElement?.id || ''`);
    check('the DRAM opens the git screen and "Back to the board" returns', there === 'git' && back === 'board' && f === 'dram', `${there} → ${back}, focus ${f}`);
  });

  await run('while the git screen shows, something new needing you lights the top band’s button', async () => {
    await open('merge');
    await sleep(900);
    if (!(await gitHere()) || !(await b.ev(`!!document.getElementById('dram')`))) { check('while the git screen shows, something new needing you lights the top band’s button', false, NEEDS_D1); return; }
    await click('#dram'); await sleep(1400);
    const a = await agentOf('m1a2b3');
    await push('agents', [{ ...a, id: 'mq', name: 'Release prep', state: 'needs_ok', ask: askOf('pq', 'Release prep', 'git push --force origin main'), work: null }]);
    await sleep(900);
    const lit = await b.ev(`[...document.querySelectorAll('#gitScreen button')].filter(x => x.offsetParent !== null).map(x => x.textContent).find(t => /needs you/.test(t)) || ''`);
    check('while the git screen shows, something new needing you lights the top band’s button', /Release prep needs you/.test(lit), `"${lit}"`);
  });

  // ---------------------------------------------------------------- the spending limit (the 'limit' scenario)
  // Checkout fix (l1), a Claude Code agent, stopped at its spending limit: the lid offers one more limit in place of "Try
  // again". Every name starts "Spending limit: ", so --only 'Spending limit' runs just these.
  const raisePosts = async () => (await posts()).filter(x => /\/raise-limit$/.test(x.path));
  await run('Spending limit: "Give it $2.00 more" posts the agent and the state it was drawn for, and the agent works again', async () => {
    await open('limit');
    await sleep(900);
    const before = await lidNow(), row = await acts(), quiet = await links();
    await clickIn('[data-act="raise"]');
    await sleep(900);
    const p = await raisePosts(), a = await agentOf('l1'), words = await said();
    check('Spending limit: "Give it $2.00 more" posts the agent and the state it was drawn for, and the agent works again',
      /Checkout fix stopped with an error\./.test(before) && row === 'Give it $2.00 more*,Dismiss' && quiet === 'Review the changes'
      && p.length === 1 && p[0].path === '/api/agents/l1/raise-limit' && p[0].body.state === 'failed'
      && a.state === 'working' && a.budgetUsd === 4 && /Checkout fix can spend \$4\.00 in all now, and it is continuing\./.test(words),
      `"${before}" [${row}] [${quiet}] → ${JSON.stringify(p.map(x => [x.path, x.body]))} → ${a.state} $${a.budgetUsd} "${words}"`);
  });

  await run('Spending limit: a button drawn before the agent changed says "That changed" and posts nothing', async () => {
    await open('limit');
    await sleep(900);
    const a = await agentOf('l1');
    await b.ev(`window.__frames.hold = true, 1`);
    await push('agents', [{ ...a, state: 'working', atLimit: false, stateReason: null, endedAt: null, now: 'Working on your message' }]);
    await sleep(500);   // the stream has brought it; the lid has not been drawn again
    const drawn = await b.ev(`${page()}?.querySelector('[data-act="raise"]')?.dataset.state || ''`);
    await clickIn('[data-act="raise"]');
    await sleep(150);
    const words = await said();
    await b.ev(`window.__frames.release(), 1`);
    await sleep(800);
    const p = await raisePosts();
    check('Spending limit: a button drawn before the agent changed says "That changed" and posts nothing', drawn === 'failed' && p.length === 0 && /That changed\. Have another look\./.test(words),
      `drawn for ${drawn}, posts ${p.length}, said "${words}"`);
  });

  await run('Spending limit: a refused raise changes nothing, and its button can be tried again', async () => {
    await open('limit', { mode: { answer: 'refuse' } });
    await sleep(900);
    await clickIn('[data-act="raise"]');
    await sleep(900);
    const shown = await lidNow(), words = await said(), a = await agentOf('l1');
    const enabled = await b.ev(`!${page()}?.querySelector('[data-act="raise"]')?.disabled`);
    check('Spending limit: a refused raise changes nothing, and its button can be tried again',
      /Checkout fix stopped with an error\./.test(shown) && enabled && /I could not reach Checkout fix\./.test(words) && a.state === 'failed' && a.budgetUsd === 2,
      `"${shown}" enabled ${enabled} "${words}" ${a.state} $${a.budgetUsd}`);
  });

  // ---------------------------------------------------------------- the git screen, held to the lid's rules
  // The detail's Merge and Throw it away, and the engine's card in their place, answer only what was drawn and seen: the
  // half-second guard after a change, words bound when they began, focus never dropped and never on an answer, Esc while
  // listening throws away what was heard, hidden characters shown, what needs you said on this screen, reduced motion,
  // HEAD's label, times that move on. Every name starts "Git screen: ", so --only 'Git screen' runs just these.
  const GS = 'Git screen: ';
  const gitFocus = () => b.ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body';
    return (a.closest('#gitDetail') ? 'detail:' : a.closest('#gitGraph') ? 'graph:' : a.closest('#gitTop') ? 'top:' : a.closest('#core') ? 'core:' : '') + a.tagName + (a.dataset.act ? ':' + a.dataset.act : '') + (a.id ? '#' + a.id : ''); })()`);
  const until = async (expr, ms = 3000, step = 15) => { const t0 = Date.now(); for (;;) { if (await b.ev(expr)) return true; if (Date.now() - t0 > ms) return false; await sleep(step); } };
  const cardThere = `!!document.querySelector('#gitDetail .dcard [data-go="1"]')`;
  // the live regions a screen reader hears on the git screen (none inside something aria-hidden)
  const liveOnGit = () => b.ev(`[...document.querySelectorAll('#gitScreen [aria-live]')].filter(e => !e.closest('[aria-hidden="true"]')).map(e => e.textContent).join(' | ')`);
  const releasePrep = async () => { const a = await agentOf('m1a2b3'); await push('agents', [{ ...a, id: 'mq', name: 'Release prep', state: 'needs_ok', ask: askOf('pq', 'Release prep', 'git push --force origin main'), work: null }]); };
  const reviewIt = async () => { await clickIn('[data-act="review"]'); await sleep(900); };
  const blur = () => b.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur(), 1`);
  // the characters that hide text or change the order it reads in, as words.js lists them (by number: never raw here)
  const HIDDEN_RAW = new RegExp('[' + [[0x80, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]].map(([x, z]) => String.fromCharCode(x) + (z > x ? '-' + String.fromCharCode(z) : '')).join('') + ']');

  await run(GS + 'the card that comes in place of the detail’s actions ignores a click for a moment, as the lid’s does', async () => {
    const out = [];
    for (const [act, still] of [['merge', true], ['discard', false]]) {
      await open('merge', { still, mode: { delay: { [act]: 600 } } });
      await sleep(900);
      await reviewIt(); if (!still) await sleep(900);
      await sleep(700);   // past the guard that opening the detail arms
      await realClick(`#gitDetail [data-act="${act}"]`);
      const came = await until(cardThere, 3000, 5);
      await realClick('#gitDetail .dcard [data-go="1"]');   // a few milliseconds after it painted: a click aimed at what was there
      await sleep(250);
      const early = (await posts()).filter(x => x.path.startsWith('/api/confirm/')).length;
      await sleep(900);
      await realClick('#gitDetail .dcard [data-go="1"]');
      await sleep(700);
      const later = (await posts()).filter(x => x.path.startsWith('/api/confirm/')).map(x => x.body.go);
      out.push({ act, still, came, early, later });
    }
    check(GS + 'the card that comes in place of the detail’s actions ignores a click for a moment, as the lid’s does',
      out.every(o => o.came && o.early === 0 && o.later.length === 1 && o.later[0] === true), JSON.stringify(out));
  });

  await run(GS + 'Esc while listening in the detail throws away what was heard, and the screen and its card stay', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await reviewIt();
    const onHeading = await gitFocus();
    await sleep(300);
    await realClick('#gitDetail [data-act="merge"]');
    await until(cardThere); await sleep(900);
    await clearLog();
    const a0 = await b.ev('window.__sr.aborts');
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last && window.__sr.last.hear('yes'), 1`);
    await b.key('Escape'); await sleep(300);
    const aborts = (await b.ev('window.__sr.aborts')) - a0, there = await screen(), card = await b.ev(cardThere);
    await b.key(' ', { phase: 'up' }); await sleep(800);
    const p1 = await workPosts(), merged = !!(await agentOf('m1a2b3')).work.merged;
    // a detail the person opened from the graph: Esc while listening keeps it open, and sends nothing
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(700);
    await click('#gitGraph .gr[data-id="work:m1a2b3"]'); await sleep(700);
    await clearLog();
    const a1 = await b.ev('window.__sr.aborts');
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last && window.__sr.last.hear('merge it'), 1`);
    await b.key('Escape'); await sleep(300);
    const aborts2 = (await b.ev('window.__sr.aborts')) - a1, open2 = await b.ev(`!document.getElementById('gitDetail').hidden`), there2 = await screen();
    await b.key(' ', { phase: 'up' }); await sleep(800);
    const p2 = await workPosts();
    check(GS + 'Esc while listening in the detail throws away what was heard, and the screen and its card stay',
      /^detail:H2/.test(onHeading) && aborts >= 1 && there === 'git' && card && p1.length === 0 && !merged && aborts2 >= 1 && open2 && there2 === 'git' && p2.length === 0,
      `focus ${onHeading}; aborts ${aborts}, ${there}, card ${card}, posts ${JSON.stringify(p1.map(x => [x.path, x.body]))}, merged ${merged}; from the graph: aborts ${aborts2}, detail open ${open2}, ${there2}, posts ${JSON.stringify(p2.map(x => [x.path, x.body]))}`);
  });

  await run(GS + 'with reduced motion, every move between the screens keeps the keyboard: the DRAM, Review, back, and "needs you"', async () => {
    const steps = [];
    try {
      await open('merge');
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(900);
      await b.ev(`document.getElementById('dram').focus(), 1`);
      await b.key('Enter'); await sleep(500); steps.push(await gitFocus());
      await b.key('Escape'); await sleep(500); steps.push(await gitFocus());
      await blur();
      const reached = await tabTo(`a.dataset.act === 'review'`);
      await b.key('Enter'); await sleep(500); steps.push(await gitFocus());
      await b.key('Escape'); await sleep(500); steps.push(await gitFocus());
      await b.ev(`document.getElementById('dram').focus(), 1`);
      await b.key('Enter'); await sleep(500);
      await releasePrep(); await sleep(900);
      await b.ev(`document.getElementById('gitNeeds').focus(), 1`);
      await b.key('Enter'); await sleep(700); steps.push(await gitFocus());
      check(GS + 'with reduced motion, every move between the screens keeps the keyboard: the DRAM, Review, back, and "needs you"',
        reached && steps[0] === 'top:H1#gitTitle' && steps[1] === 'BUTTON#dram' && /^detail:H2/.test(steps[2]) && /^core:BUTTON:review/.test(steps[3]) && /^core:H1/.test(steps[4]), `review reached ${reached}: ${steps.join(' → ')}`);
    } finally {
      await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    }
  });

  await run(GS + 'keyboard: Merge in the detail, its card and the card’s answer keep the keyboard, and the card is said on the git screen', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await reviewIt(); await sleep(300);
    const reached = await tabTo(`!!a.closest('#gitDetail') && a.dataset.act === 'merge'`, 6);
    await b.key('Enter'); await sleep(50);
    const waiting = await gitFocus();
    await until(cardThere); await sleep(200);
    const withCard = await gitFocus(), told = await liveOnGit();
    await sleep(900);   // past the guard
    const reachedYes = await tabTo(`!!a.closest('#gitDetail .dcard') && a.dataset.go === '1'`, 4);
    await b.key('Enter'); await sleep(50);
    const answering = await gitFocus();
    await sleep(1300);
    const after = await gitFocus(), words = await b.ev(`document.getElementById('gitSaid').textContent`);
    check(GS + 'keyboard: Merge in the detail, its card and the card’s answer keep the keyboard, and the card is said on the git screen',
      reached && /^detail:/.test(waiting) && /^detail:P#gitCard/.test(withCard) && /Merge Invoice export into main\?/.test(told) && reachedYes && /^detail:/.test(answering) && /^detail:H2/.test(after) && /Merged Invoice export into main\./.test(words),
      `reached ${reached}, waiting ${waiting}, with the card ${withCard}, said "${told.slice(0, 90)}", yes reached ${reachedYes}, answering ${answering}, after ${after}, "${words}"`);
  });

  await run(GS + 'the engine’s card in the detail shows hidden and direction-changing characters, as the lid does', async () => {
    await open('merge', { still: true });
    await sleep(900);
    // a check, a branch or a task can carry a right-to-left override into the engine's words for the card
    await b.ev(`(() => { const f = window.fetch, R = String.fromCharCode(0x202e), P = String.fromCharCode(0x202c), Z = String.fromCharCode(0x200b);
      window.fetch = async (u, o) => { const r = await f(u, o); if (!/\\/merge$/.test(String(u))) return r; const j = await r.clone().json();
        if (j.confirm) { j.confirm.sentence = 'Merge Invoice export into rel' + R + 'niam' + P + '?'; j.confirm.detail = 'A check failed: Unit tests' + R + '.degrem eb nac ti os ,dessap skcehc llA' + P + Z; }
        return new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } }); }; return 1; })()`);
    await reviewIt(); await sleep(300);
    await realClick('#gitDetail [data-act="merge"]');
    await until(cardThere); await sleep(200);
    const txt = await b.ev(`document.querySelector('#gitDetail .dcard')?.textContent || ''`);
    check(GS + 'the engine’s card in the detail shows hidden and direction-changing characters, as the lid does',
      !!txt && !HIDDEN_RAW.test(txt) && /rel⟦U\+202E⟧niam⟦U\+202C⟧/.test(txt) && /Unit tests⟦U\+202E⟧/.test(txt) && /⟦U\+200B⟧/.test(txt), JSON.stringify(txt.slice(0, 220)));
  });

  await run(GS + 'words typed or spoken on the git screen are bound when they begin: a card that comes meanwhile gets nothing', async () => {
    // typed: "merge it" begun while Merge's card was on its way, sent once the card is in the detail
    await open('merge', { still: true, mode: { delay: { merge: 700 } } });
    await sleep(900);
    await reviewIt(); await sleep(300);
    await realClick('#gitDetail [data-act="merge"]'); await sleep(80);
    await b.ev(`document.getElementById('gitSay').focus(), 1`);
    await b.type('merge it');
    const came = await until(cardThere); await sleep(150);
    await clearLog();
    await b.key('Enter'); await sleep(800);
    const typed = (await posts()).filter(x => x.path === '/api/command' || x.path.startsWith('/api/confirm/'));
    const merged1 = !!(await agentOf('m1a2b3')).work.merged;
    // spoken: the microphone turned on before the card came, "yes" heard after it
    await open('merge', { still: true, mode: { delay: { merge: 700 } } });
    await sleep(900);
    await reviewIt(); await sleep(300);
    await realClick('#gitDetail [data-act="merge"]'); await sleep(80);
    await b.key(' ', { phase: 'down' }); await sleep(100);
    const came2 = await until(cardThere); await sleep(150);
    await clearLog();
    await b.ev(`window.__sr.last && window.__sr.last.hear('yes'), 1`);
    await b.key(' ', { phase: 'up' }); await sleep(800);
    const spoken = (await posts()).filter(x => x.path === '/api/command' || x.path.startsWith('/api/confirm/'));
    const merged2 = !!(await agentOf('m1a2b3')).work.merged;
    check(GS + 'words typed or spoken on the git screen are bound when they begin: a card that comes meanwhile gets nothing',
      came && came2 && typed.length === 1 && typed[0].body.confirmId === null && !merged1 && spoken.length === 1 && spoken[0].body.confirmId === null && !merged2,
      `typed ${JSON.stringify(typed.map(x => [x.path, x.body]))}, merged ${merged1}; spoken ${JSON.stringify(spoken.map(x => [x.path, x.body]))}, merged ${merged2}`);
  });

  await run(GS + 'talking on the git screen shows that it listens and what it heard, on its own band', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await reviewIt();
    await clearLog();
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last && window.__sr.last.hear('what changed'), 1`); await sleep(100);
    const shown = await b.ev(`(() => { const bar = document.getElementById('gitBar'), h = document.getElementById('gitHeard');
      const seen = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      return { listening: bar.classList.contains('listening'), wave: seen(bar.querySelector('.wave')), heard: seen(h) ? h.textContent : '', hint: seen(document.getElementById('gitPh')) }; })()`);
    await b.key(' ', { phase: 'up' }); await sleep(800);
    const after = await b.ev(`document.getElementById('gitBar').classList.contains('listening')`);
    const p = (await posts()).filter(x => x.path === '/api/command');
    check(GS + 'talking on the git screen shows that it listens and what it heard, on its own band',
      shown.listening && shown.wave && shown.heard === 'what changed' && !shown.hint && !after && p.length === 1 && p[0].body.text === 'what changed' && p[0].body.focusId === 'm1a2b3',
      JSON.stringify({ shown, after, sent: p.map(x => x.body) }));
  });

  await run(GS + 'black and gold: the focus rings in the detail and on the git screen’s input stand out from the card (3:1)', async () => {
    await open('merge', { still: true, theme: 'black-gold' });
    await sleep(900);
    await reviewIt(); await sleep(300);
    // the ring's colour on the focused control against the card it sits on (--card-1 and --card-2)
    const ring = what => b.ev(`(() => {
      const rgb = s => { s = String(s || '').trim(); if (s[0] === '#') { let h = s.slice(1); if (h.length === 3) h = [...h].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); } const m = s.match(/[\\d.]+/g); return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null; };
      const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const ratio = (x, y) => { const [p, q] = [lum(x), lum(y)].sort((m, n) => n - m); return (p + 0.05) / (q + 0.05); };
      const root = getComputedStyle(document.documentElement), bgs = ['--card-1', '--card-2'].map(v => rgb(root.getPropertyValue(v)));
      const a = document.activeElement, what = ${JSON.stringify(what)};
      const col = what === 'outline' ? getComputedStyle(a).outlineColor : getComputedStyle(what === 'bar' ? document.getElementById('gitBar') : a).boxShadow;
      const c = rgb(col);
      return { on: a.id || a.dataset.act || a.className, col, min: c ? Math.round(Math.min(...bgs.map(bg => ratio(c, bg))) * 100) / 100 : 0 };
    })()`);
    const out = [];
    if (await tabTo(`!!a.closest('#gitDetail') && a.dataset.act === 'merge'`, 6)) out.push(await ring('outline'));
    if (await tabTo(`!!a.closest('#gitDetail') && a.classList.contains('gdiff')`, 6)) out.push(await ring('shadow'));
    await blur();
    await b.key('x'); await sleep(150);   // letters go to the git screen's own input
    out.push(await ring('bar'));
    check(GS + 'black and gold: the focus rings in the detail and on the git screen’s input stand out from the card (3:1)', out.length === 3 && out.every(o => o.min >= 3), JSON.stringify(out));
  });

  await run(GS + 'something new that needs you is said on the git screen, not only lit', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(900);
    const before = await liveOnGit();
    await releasePrep(); await sleep(900);
    const after = await liveOnGit();
    check(GS + 'something new that needs you is said on the git screen, not only lit', !/Release prep/.test(before) && /Release prep needs you/.test(after), `before "${before}", after "${after}"`);
  });

  await run(GS + 'HEAD’s label is whole inside the graph, and no trace runs through it', async () => {
    const out = [];
    try {
      for (const [sc, w, h] of [['git-empty', 1280, 680], ['live', 1024, 700], ['git-empty', 1440, 900], ['git-bring', 1280, 680], ['git-bring', 1024, 700], ['git-bring', 1440, 900], ['git', 1280, 680], ['git-many', 1440, 900]]) {
        await b.size(w, h);
        await open(sc, { still: true });
        await sleep(700);
        await click('#dram'); await sleep(700);
        out.push({ sc, size: `${w}x${h}`, ...(await b.ev(`(() => {
          const t = document.querySelector('#gitGraph text.ghead'); if (!t) return { none: true };
          const lr = t.getBoundingClientRect(), gr = document.getElementById('gitGraph').getBoundingClientRect();
          let through = 0;
          for (const p of document.querySelectorAll('#gitGraph .gsvg path')) {
            const L = p.getTotalLength(), m = p.getScreenCTM(), sw = (parseFloat(getComputedStyle(p).strokeWidth) || 2) / 2;
            for (let s = 0; s <= L; s += 1) {
              const q = p.getPointAtLength(s), x = m.a * q.x + m.c * q.y + m.e, y = m.b * q.x + m.d * q.y + m.f;
              if (x > lr.left - sw && x < lr.right + sw && y > lr.top - sw && y < lr.bottom + sw) { through++; break; }
            }
          }
          return { cut: Math.round(Math.max(0, gr.left - lr.left, lr.right - gr.right) * 10) / 10, through };
        })()`)) });
      }
    } finally { await b.size(1440, 900); }
    check(GS + 'HEAD’s label is whole inside the graph, and no trace runs through it', out.every(o => !o.none && o.cut === 0 && o.through === 0), JSON.stringify(out));
  });

  await run(GS + 'what Workbench says on the git screen shows hidden and direction-changing characters: notes, refusals, errors, notices', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await b.ev(`(() => { const f = window.fetch, R = String.fromCharCode(0x202e), Z = String.fromCharCode(0x200b);
      const no = reply => new Response(JSON.stringify({ ok: false, reply }), { status: 200, headers: { 'content-type': 'application/json' } });
      window.fetch = async (u, o) => { const s = String(u);
        if (/\\/api\\/agents\\/m1a2b3\\/changes$/.test(s)) return no('Workbench could not read the folder rel' + R + 'niam' + Z + ' of Invoice export.');
        if (/\\/api\\/git$/.test(s)) return no('Workbench could not read the history of rel' + R + 'niam' + Z + '.');
        return f(u, o); }; return 1; })()`);
    await reviewIt(); await sleep(300);
    await push('notice', { text: `The branch rel${String.fromCharCode(0x202e)}niam changed since you looked.` }); await sleep(600);
    const txt = await b.ev(`[document.querySelector('#gitDetail .gdiff')?.textContent || '', document.querySelector('#gitGraph .gnote')?.textContent || '',
      document.getElementById('gitGraph').getAttribute('aria-label') || '', document.getElementById('gitSaid').textContent, document.getElementById('said').textContent].join(' | ')`);
    const marks = (txt.match(/⟦U\+202E⟧/g) || []).length;
    check(GS + 'what Workbench says on the git screen shows hidden and direction-changing characters: notes, refusals, errors, notices', !HIDDEN_RAW.test(txt) && marks >= 5, `${marks} marked: ${JSON.stringify(txt.slice(0, 320))}`);
  });

  await run(GS + 'a word spoken on the git screen leaves the board’s typing alone: a "yes" typed later goes to the ask on screen', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(900);
    await blur();
    await b.key(' ', { phase: 'down' }); await sleep(150);
    await b.ev(`window.__sr.last && window.__sr.last.hear('back'), 1`);
    await b.key(' ', { phase: 'up' }); await sleep(900);
    const back = await screen();
    await releasePrep(); await sleep(2500);
    const shown = await h1();
    await clearLog();
    await blur();
    await b.type('yes'); await b.key('Enter'); await sleep(700);
    const p = (await posts()).filter(x => x.path === '/api/command');
    check(GS + 'a word spoken on the git screen leaves the board’s typing alone: a "yes" typed later goes to the ask on screen',
      back === 'board' && /Release prep/.test(shown) && p.length === 1 && p[0].body.focusId === 'mq' && p[0].body.askId === 'pq', `${back}, lid "${shown}", ${JSON.stringify(p.map(x => x.body))}`);
  });

  await run(GS + 'Merge in the detail first withdraws a card that waits in the lid, so none waits unseen', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await typeIn('stop the rounding one'); await sleep(900);
    const launch = await h1();
    await click('#dram'); await sleep(700);
    await click('#gitGraph .gr[data-id="work:m1a2b3"]'); await sleep(900);
    await clearLog();
    await realClick('#gitDetail [data-act="merge"]'); await sleep(1000);
    const p = await workPosts();
    const w = p.findIndex(x => x.path.startsWith('/api/confirm/') && x.body.go === false), m = p.findIndex(x => x.path === '/api/agents/m1a2b3/merge');
    const card = await b.ev(`document.querySelector('#gitDetail .dcard .dq')?.textContent || ''`);
    check(GS + 'Merge in the detail first withdraws a card that waits in the lid, so none waits unseen',
      /^Stop Price rounding\?/.test(launch) && w >= 0 && m > w && /Merge Invoice export into main\?/.test(card), `"${launch}" ${JSON.stringify(p.map(x => [x.path, x.body]))} "${card}"`);
  });

  await run(GS + '"<name> needs you" takes that item to the lid even while a card waits, and withdraws the card', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await reviewIt(); await sleep(300);
    await realClick('#gitDetail [data-act="merge"]'); await until(cardThere); await sleep(300);
    await releasePrep(); await sleep(900);
    await clearLog();
    await click('#gitNeeds'); await sleep(1300);
    const there = await screen(), shown = await lidNow();
    const p = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    check(GS + '"<name> needs you" takes that item to the lid even while a card waits, and withdraws the card',
      there === 'board' && /Release prep/.test(shown) && !/Merge Invoice export/.test(shown) && p.length === 1 && p[0].body.go === false, `${there}, lid "${shown}", ${JSON.stringify(p.map(x => [x.path, x.body]))}`);
  });

  await run(GS + 'its input keeps a paste’s lines, and words that could not be sent stay in it: too long, a failed request, no answer', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(900);
    const gitSaid = () => b.ev(`(() => { const s = document.getElementById('gitSaid'); return s.querySelector('.sr')?.textContent || s.textContent; })()`);
    const value = () => b.ev(`document.getElementById('gitSay').value`);
    const setValue = v => b.ev(`(() => { const i = document.getElementById('gitSay'); i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    const shape = await b.ev(`(() => { const i = document.getElementById('gitSay'); return [i.tagName, Math.round(i.clientHeight / parseFloat(getComputedStyle(i).lineHeight))]; })()`);
    // a real paste, through the clipboard, as the board's check makes one
    const paste = 'this fails:\n```js\nfunction total(cart) {\n  return cart.sum();\n}\n```';
    await b.send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await b.ev(`navigator.clipboard.writeText(${JSON.stringify(paste)})`);
    await b.ev(`document.getElementById('gitSay').focus(), 1`);
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, commands: ['paste'] });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4 });
    await sleep(200);
    const pasted = await value();
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await clearLog();
    await b.key('Enter'); await sleep(900);
    const sent = (await posts()).filter(x => x.path === '/api/command').map(x => x.body.text);
    const emptied = await value();
    // too long: nothing is sent, and the words stay
    await clearLog();
    await setValue('x'.repeat(70 * 1024));
    await b.key('Enter'); await sleep(700);
    const long = { sent: (await posts()).filter(x => x.path === '/api/command').length, kept: (await value()).length, said: await gitSaid() };
    await setValue('');
    // a request that fails, and one that gets no answer: the words come back
    const failed = [];
    for (const answer of ['500', 'drop']) {
      await ctl('mode', { answer });
      await setValue('fix the docs');
      await b.key('Enter'); await sleep(900);
      failed.push({ answer, kept: await value(), said: await gitSaid() });
      await ctl('mode', { answer: 'ok' });
      await setValue('');
    }
    check(GS + 'its input keeps a paste’s lines, and words that could not be sent stay in it: too long, a failed request, no answer',
      shape[0] === 'TEXTAREA' && shape[1] === 1 && pasted === paste && sent.length === 1 && sent[0] === paste && emptied === ''
        && long.sent === 0 && long.kept === 70 * 1024 && long.said === 'That is too long to send in one go. The limit is 64 KB.'
        && failed[0].kept === 'fix the docs' && failed[0].said === 'Something went wrong.'
        && failed[1].kept === 'fix the docs' && failed[1].said === 'Workbench isn’t answering. Is it still running?',
      JSON.stringify({ shape, pasted, sent, emptied, long, failed }));
  });

  await run(GS + 'a card from typed words goes in a detail only when it is that agent’s, never by a name inside another', async () => {
    await open('merge', { still: true });
    await sleep(900);
    const pr = await agentOf('mab0c1');
    await push('agents', [{ ...pr, name: 'Search' }]); await sleep(400);
    await click('#dram'); await sleep(700);
    await click('#gitGraph .gr[data-id="work:mab0c1"]'); await sleep(900);
    const title = await b.ev(`document.getElementById('gitDetailTitle')?.textContent || ''`);
    await b.ev(`document.getElementById('gitSay').focus(), 1`);
    await b.type('merge search cleanup'); await b.key('Enter'); await sleep(1300);
    const inDetail = await b.ev(`document.querySelector('#gitDetail:not([hidden]) .dcard')?.textContent || ''`);
    const there = await screen(), shown = await lidNow();
    check(GS + 'a card from typed words goes in a detail only when it is that agent’s, never by a name inside another',
      title === 'Search' && !/Search cleanup/.test(inDetail) && there === 'board' && /Merge Search cleanup into main\?/.test(shown), `detail "${title}", card there "${inDetail.slice(0, 60)}", ${there}, lid "${shown}"`);
  });

  await run(GS + 'focus on a row that goes away moves to a row that is there, and the list keeps one tab stop', async () => {
    await open('git', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(900);
    await b.ev(`document.querySelector('#gitGraph .gr[data-id="work:g3"]').focus(), 1`);
    const before = await gitFocus();
    const g3 = await agentOf('g3');
    await push('agents', [{ ...g3, state: 'done_checked', endedAt: Date.now(), stateSince: Date.now(), files: { changed: 0, adds: 0, dels: 0, list: [] } }]);
    await sleep(1500);
    const gone = await b.ev(`!document.querySelector('#gitGraph .gr[data-id="work:g3"]')`);
    const after = await gitFocus(), stops = await b.ev(`[...document.querySelectorAll('#gitGraph .gr')].filter(r => r.tabIndex === 0).length`);
    check(GS + 'focus on a row that goes away moves to a row that is there, and the list keeps one tab stop',
      /^graph:DIV#gr-work_g3/.test(before) && gone && /^graph:DIV/.test(after) && stops === 1, `${before} → ${after}, row gone ${gone}, tab stops ${stops}`);
  });

  const helpMergeRow = () => b.ev(`[...document.querySelectorAll('#gitGraph .gr')].find(r => /^Merge Help pages/.test(r.querySelector('.sub')?.textContent || ''))?.dataset.id || ''`);
  await run(GS + 'a link to an agent with no work node keeps a row selected, and Esc goes back to a row', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(700);
    const id = await helpMergeRow();
    await click(`#gitGraph .gr[data-id="${id}"]`); await sleep(700);
    await b.ev(`document.querySelector('#gitDetail [data-git-act="agent"][data-key^="a:"]')?.focus(), 1`);
    await b.key('Enter'); await sleep(800);
    const detail = await b.ev(`document.getElementById('gitDetailTitle')?.textContent || ''`);
    const stops = await b.ev(`[...document.querySelectorAll('#gitGraph .gr')].filter(r => r.tabIndex === 0).map(r => r.dataset.id + (r.getAttribute('aria-selected') === 'true' ? '*' : ''))`);
    await b.key('Escape'); await sleep(500);
    const f = await gitFocus();
    check(GS + 'a link to an agent with no work node keeps a row selected, and Esc goes back to a row',
      !!id && detail === 'Help pages' && stops.length === 1 && /\*$/.test(stops[0]) && /^graph:DIV/.test(f), `row ${id}, detail "${detail}", tab stops ${JSON.stringify(stops)}, focus after Esc ${f}`);
  });

  await run(GS + 'times on the git screen move on with the clock', async () => {
    await open('merge', { still: true });
    await sleep(900);
    await click('#dram'); await sleep(700);
    const id = await helpMergeRow();
    await click(`#gitGraph .gr[data-id="${id}"]`); await sleep(700);
    await b.ev(`document.querySelector('#gitDetail [data-git-act="agent"][data-key^="a:"]')?.click(), 1`); await sleep(800);
    const read = () => b.ev(`[document.querySelector('#gitGraph .gr:not(.work) .l2')?.textContent || '', document.querySelector('#gitDetail .dmeta')?.textContent || ''].join(' | ')`);
    const before = await read();
    await b.ev(`(() => { const real = Date.now.bind(Date); window.__ahead = 0; Date.now = () => real() + window.__ahead; return 1; })()`);
    await b.ev(`window.__ahead = 2 * 60000, 1`); await sleep(1600);
    const after = await read();
    check(GS + 'times on the git screen move on with the clock', /· 3 min ago ·/.test(before) && /· 5 min ago ·/.test(after) && /Merged into main 4 min ago/.test(before) && /Merged into main 6 min ago/.test(after), `"${before}" → "${after}"`);
  });

  // ---------------------------------------------------------------- Agents & keys (the connect panel, the 'connect-*' scenarios)
  // In 'connect-claude' Claude Code is ready (so the panel does not open by itself) and Codex is signed out; in
  // 'connect-none' no agent is ready; in 'connect-github' GitHub is connected and git alone uses its token. The panel
  // opens from the top band's button with the keyboard on its title, and Esc gives the keyboard back; a key typed into the
  // board's input is never sent; a preset form saves what it shows; no value stays in the page after Save; GitHub's box
  // acts at once and goes back when refused. Every name starts "Agents & keys: ", so --only 'Agents & keys' runs just
  // these. The fake keys are made from parts here, so nothing in this file looks like a real one; a check's details name
  // what was sent, never a value.
  const AK = 'Agents & keys: ';
  const KEY_REFUSAL = 'That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe.';
  const panelOpen = () => b.ev(`!!document.getElementById('connect')?.open`);
  const panelSaid = () => b.ev(`document.getElementById('connectSaid')?.textContent || ''`);
  const inPanel = sel => `#connectBody ${sel}`;
  const fake = (...parts) => parts.join('');
  const keyRows = () => b.ev(`[...document.querySelectorAll('#connectBody .cn-key .cn-line')].map(e => e.textContent)`);
  const openPanel = async () => { await click('#connectBtn'); await sleep(900); };
  /** Type into a field of the panel, as a person does: focus it, then one key at a time. */
  const typeInto = async (sel, text) => { await b.ev(`document.querySelector(${JSON.stringify(sel)})?.focus(), 1`); await b.type(text); };
  /** The AWS form, filled in: Add a key, AWS, its two keys and its region. */
  const fillAws = async (id, secret) => {
    await click(inPanel('[data-cn="add"]')); await sleep(300);
    await click(inPanel('[data-cn="preset"][data-preset="aws"]')); await sleep(300);
    await typeInto(inPanel('[data-var="AWS_ACCESS_KEY_ID"]'), id);
    await typeInto(inPanel('[data-var="AWS_SECRET_ACCESS_KEY"]'), secret);
    await typeInto(inPanel('[data-var="AWS_REGION"]'), 'eu-west-2');
  };
  /** Where a value could stay on the page: its markup, every field, and the page's storage. [] when it is nowhere. */
  const valueLeft = v => b.ev(`(() => { const v = ${JSON.stringify(v)}, where = [];
    if (document.documentElement.outerHTML.includes(v)) where.push('the markup');
    for (const i of document.querySelectorAll('input, textarea')) if (String(i.value).includes(v)) where.push('the field ' + (i.dataset.var || i.dataset.field || i.id || i.type));
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) if (String(s.getItem(s.key(i))).includes(v)) where.push('the page’s storage');
    return where; })()`);
  const awsId = () => fake('AK', 'IA', 'Q4R7', 'T2W9', 'X5Z8', 'C3V6'), awsSecret = () => fake('wJal', 'rXUtnFEMI', 'K7MDENGbPxRfi', 'CYZQ8EXAMPLE');

  await run(AK + 'the top band’s button opens it over the board, with the keyboard on its title, and it reads what is connected', async () => {
    await open('connect-claude');
    await sleep(900);
    const btn = await b.ev(`(() => { const e = document.getElementById('connectBtn'); return e && !e.hidden ? e.getAttribute('aria-label') || '' : ''; })()`);
    const before = await panelOpen();
    await b.ev(`document.getElementById('connectBtn').focus(), 1`);
    await b.key('Enter'); await sleep(900);
    const opened = await panelOpen(), f = await b.ev(`document.activeElement?.id || ''`);
    const rows = await b.ev(`[...document.querySelectorAll('#connectBody .cn-agent .cn-line')].map(e => e.textContent)`);
    const p = (await posts()).filter(x => x.path.startsWith('/api/connect'));
    check(AK + 'the top band’s button opens it over the board, with the keyboard on its title, and it reads what is connected',
      btn === 'Agents & keys: Claude Code is ready for new work.' && !before && opened && f === 'connectTitle'
      && rows[0] === 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.' && rows[1] === 'Codex 0.166.0 is installed but not signed in.'
      && p.some(x => x.path === '/api/connect/recheck'),
      `button "${btn}", open ${before} → ${opened}, focus ${f}, rows ${JSON.stringify(rows)}, posts ${JSON.stringify(p.map(x => x.path))}`);
  });

  await run(AK + 'Esc closes it, and the keyboard goes back to the button that opened it (by keyboard or pointer)', async () => {
    await open('connect-claude');
    await sleep(900);
    await b.ev(`document.getElementById('connectBtn').focus(), 1`);
    await b.key('Enter'); await sleep(700);
    const opened = await panelOpen();
    await b.ev(`document.querySelector('#connectBody [data-cn="agent"][data-agent="codex"][data-action="recheck"]')?.focus(), 1`);
    const inside = await b.ev(`document.getElementById('connect').contains(document.activeElement) && document.activeElement.id !== 'connectTitle'`);
    await b.key('Escape'); await sleep(500);
    const closed = !(await panelOpen()), f = await b.ev(`document.activeElement?.id || ''`);
    await realClick('#connectBtn'); await sleep(700);
    const again = await panelOpen();
    await b.key('Escape'); await sleep(500);
    const closed2 = !(await panelOpen()), f2 = await b.ev(`document.activeElement?.id || ''`);
    check(AK + 'Esc closes it, and the keyboard goes back to the button that opened it (by keyboard or pointer)',
      opened && inside && closed && f === 'connectBtn' && again && closed2 && f2 === 'connectBtn',
      `opened ${opened}, focus inside ${inside}, closed ${closed} → ${f}; clicked ${again}, closed ${closed2} → ${f2}`);
  });

  await run(AK + 'a key typed into the board’s input is refused: nothing is sent, the input is emptied, and the panel opens to take it', async () => {
    await open('connect-claude');
    await sleep(900);
    await clearLog();
    const key = fake('sk-', 'ant-', 'api03-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz');
    await typeInto('#say', key);
    await b.key('Enter'); await sleep(900);
    const p = await posts();
    const sent = p.filter(x => x.path === '/api/command' || JSON.stringify(x.body || {}).includes(key)).map(x => x.path);
    const input = await b.ev(`document.getElementById('say').value`);
    const opened = await panelOpen(), inPanelWords = await panelSaid(), board = await said(), left = await valueLeft(key);
    check(AK + 'a key typed into the board’s input is refused: nothing is sent, the input is emptied, and the panel opens to take it',
      sent.length === 0 && input === '' && opened && inPanelWords === KEY_REFUSAL && board.includes(KEY_REFUSAL) && left.length === 0,
      `sent ${JSON.stringify(sent)}, input emptied ${input === ''}, panel open ${opened} saying "${inPanelWords}", board "${board}", left in ${JSON.stringify(left)}`);
  });

  await run(AK + 'a preset form saves: AWS sends its preset, its fields (the region as typed), where (this repository, a service key’s default) and who; the key is listed masked', async () => {
    await open('connect-claude');
    await sleep(900);
    await openPanel();
    await clearLog();
    const id = awsId(), secret = awsSecret();
    await fillAws(id, secret);
    const fields = await b.ev(`[...document.querySelectorAll('#connectBody [data-var]')].map(i => i.dataset.var + ':' + i.type).join(',')`);
    const choices = await b.ev(`[...document.querySelectorAll('#connectBody input[type="radio"]:checked')].map(i => i.name + '=' + i.value).join(',')`);
    await click(inPanel('[data-cn="add-save"]')); await sleep(1100);
    const p = (await posts()).filter(x => x.path.startsWith('/api/connect'));
    const save = p.filter(x => x.path === '/api/connect/keys'), body = save[0]?.body || {}, v = body.values || {};
    const sentRight = save.length === 1 && body.preset === 'aws' && body.label === 'AWS' && body.scope === 'repo' && body.agents === 'all'
      && Object.keys(v).sort().join(',') === 'AWS_ACCESS_KEY_ID,AWS_REGION,AWS_SECRET_ACCESS_KEY' && v.AWS_ACCESS_KEY_ID === id && v.AWS_SECRET_ACCESS_KEY === secret && v.AWS_REGION === 'eu-west-2';
    const rows = await keyRows(), words = await panelSaid(), formGone = !(await b.ev(`!!document.querySelector('#connectBody [data-cn="add-save"]')`));
    const listed = `AWS for this repository, given to all agents: AWS_ACCESS_KEY_ID •••• ${id.slice(-4)}, AWS_SECRET_ACCESS_KEY •••• ${secret.slice(-4)}, AWS_REGION eu-west-2`;
    const after = p.map(x => x.path).lastIndexOf('/api/connect/recheck') > p.indexOf(save[0]);
    check(AK + 'a preset form saves: AWS sends its preset, its fields (the region as typed), where (this repository, a service key’s default) and who; the key is listed masked',
      fields === 'AWS_ACCESS_KEY_ID:password,AWS_SECRET_ACCESS_KEY:password,AWS_SESSION_TOKEN:password,AWS_REGION:text' && choices === 'cn-scope=repo,cn-given=all'
      && sentRight && words === 'Saved AWS, for this repository.' && rows.includes(listed) && formGone && after,
      `fields ${fields}; ${choices}; ${save.length} sent: ${JSON.stringify({ ...body, values: Object.keys(v) })}, its values as typed ${sentRight}; said "${words}"; rows ${JSON.stringify(rows)}; form closed ${formGone}; checked again after ${after}`);
  });

  await run(AK + 'no value stays in the page after Save: not in a field, the markup or the page’s storage (a preset form and an agent’s own key)', async () => {
    await open('connect-claude');
    await sleep(900);
    await openPanel();
    const id = awsId(), secret = awsSecret();
    await fillAws(id, secret);
    await click(inPanel('[data-cn="add-save"]')); await sleep(1100);
    const aws = [...(await valueLeft(id)), ...(await valueLeft(secret))];
    // "Use an API key" for Claude Code, then Save key
    const key = fake('sk-', 'ant-', 'api03-', 'Mn7Bv6Cx5Za4Sd3Fg2Hj1Kl0Qw9Er8Ty');
    await click(inPanel('[data-cn="agent"][data-agent="claude"][data-action="key"]')); await sleep(300);
    await typeInto(inPanel('[data-field="agent-key"]'), key);
    await click(inPanel('[data-cn="keysave"][data-agent="claude"]')); await sleep(1100);
    const sent = (await posts()).filter(x => x.path === '/api/connect/agents/claude/key');
    const own = await valueLeft(key);
    const listed = (await keyRows()).find(t => /^Anthropic /.test(t)) || '';
    // and once it is closed, no password field holds anything
    await b.key('Escape'); await sleep(500);
    const filled = await b.ev(`[...document.querySelectorAll('#connect input[type="password"]')].filter(i => i.value).length`);
    check(AK + 'no value stays in the page after Save: not in a field, the markup or the page’s storage (a preset form and an agent’s own key)',
      aws.length === 0 && sent.length === 1 && sent[0].body.value === key && own.length === 0
      && listed === `Anthropic for all repositories, given to Claude Code: ANTHROPIC_API_KEY •••• ${key.slice(-4)}` && filled === 0,
      `AWS left in ${JSON.stringify(aws)}; the agent's key sent ${sent.length}, as typed ${sent[0]?.body.value === key}, left in ${JSON.stringify(own)}; listed "${listed}"; password fields filled after closing ${filled}`);
  });

  await run(AK + 'GitHub’s box acts at once: ticking it sends { agentsUseIt: true }; a refusal is said, and the box goes back as it was', async () => {
    await open('connect-github');
    await sleep(900);
    await openPanel();
    await clearLog();
    const box = inPanel('input[data-field="gh-share"]');
    const before = await b.ev(`document.querySelector(${JSON.stringify(box)})?.checked ?? null`);
    await click(box); await sleep(900);
    const ticked = await b.ev(`document.querySelector(${JSON.stringify(box)})?.checked ?? null`), saidOn = await panelSaid();
    // Workbench cannot read the token back from git: { ok: false, why: 'token', sentence }, with no status
    await ctl('mode', { connect: { githubAgents: 'token' } });
    await click(box); await sleep(900);
    const back = await b.ev(`document.querySelector(${JSON.stringify(box)})?.checked ?? null`), saidNo = await panelSaid();
    await ctl('mode', { connect: null });
    const p = (await posts()).filter(x => x.path === '/api/connect/github/agents');
    check(AK + 'GitHub’s box acts at once: ticking it sends { agentsUseIt: true }; a refusal is said, and the box goes back as it was',
      before === false && ticked === true && saidOn === 'Agents can use your GitHub token now, as GH_TOKEN.'
      && back === true && saidNo === 'Workbench cannot read the GitHub token back from git, so this cannot change. Disconnect GitHub, then connect it again.'
      && p.length === 2 && JSON.stringify(p[0].body) === '{"agentsUseIt":true}' && JSON.stringify(p[1].body) === '{"agentsUseIt":false}',
      `${before} → ${ticked} "${saidOn}" → refused: ${back} "${saidNo}"; sent ${JSON.stringify(p.map(x => x.body))}`);
  });

  await run(AK + 'with no coding agent ready it opens by itself, once, the band’s light is lit, and the lid offers Connect', async () => {
    await open('connect-none');
    await sleep(900);
    const opened = await panelOpen(), lid = await h1(), lidBtn = await b.ev(`${page()}?.querySelector('[data-act="connect"]')?.textContent || ''`);
    const lit = await b.ev(`document.getElementById('connectBtn')?.classList.contains('need') || false`);
    await b.key('Escape'); await sleep(500);
    const closed = !(await panelOpen());
    await push('snapshot', await ctl('state')); await sleep(700);   // a fresh snapshot, still with no agent ready
    const again = await panelOpen();
    await clickIn('[data-act="connect"]'); await sleep(700);
    const byLid = await panelOpen();
    check(AK + 'with no coding agent ready it opens by itself, once, the band’s light is lit, and the lid offers Connect',
      opened && lid === 'Connect a coding agent to start.' && lidBtn === 'Connect' && lit && closed && !again && byLid,
      `opened ${opened}, lid "${lid}" [${lidBtn}], lit ${lit}, closed ${closed}, opened again by a snapshot ${again}, by the lid's Connect ${byLid}`);
  });

  // ---------------------------------------------------------------- full permissions: the band's button, the card, the words
  const FP = 'full permissions: ';
  const permBtn = () => b.ev(`(() => { const e = document.getElementById('permBtn'); if (!e) return null; const r = e.getBoundingClientRect();
    return { hidden: e.hidden, pressed: e.getAttribute('aria-pressed'), on: e.classList.contains('on'), led: !!e.querySelector('.led.on'), state: e.dataset.state || '',
      name: e.getAttribute('aria-label') || '', text: e.textContent, left: r.left, right: r.right, mid: r.top + r.height / 2 }; })()`);
  const permPosts = async () => (await posts()).filter(x => x.path === '/api/permissions');
  const lidDetail = () => b.ev(`${page()}?.querySelector('.meta')?.textContent || ''`);

  await run(FP + 'the band’s button is quiet and not pressed while agents ask; pressed, it asks the engine, and the card comes in the middle with no default answer', async () => {
    await open('demo');
    await sleep(900);
    const off = await permBtn();
    await realClick('#permBtn');
    await sleep(1100);
    const card = await lidNow(), row = await acts(), detail = await lidDetail(), p = await permPosts();
    const yesBtn = await b.ev(`${page()}?.querySelector('[data-act="confirm"][data-go="1"]')?.dataset.confirm || ''`);
    check(FP + 'the band’s button is quiet and not pressed while agents ask; pressed, it asks the engine, and the card comes in the middle with no default answer',
      off && !off.hidden && off.pressed === 'false' && !off.on && !off.led && off.state === 'ask' && off.name === 'Full permissions'
      && card === 'Before agents stop asking / Let agents do anything without asking?' && row === 'Turn on full permissions,Keep asking'
      && /It stays on until you turn it off\. The 1 question waiting now is allowed too\.$/.test(detail) && /^c/.test(yesBtn)
      && p.length === 1 && JSON.stringify(p[0].body) === '{"mode":"full"}',
      `${JSON.stringify(off)}; "${card}" [${row}] "${detail}"; ${JSON.stringify(p.map(x => x.body))}`);
  });

  await run(FP + 'Keep asking changes nothing; Turn on full permissions lights the button, allows the question waiting, and says so', async () => {
    await clickIn('[data-act="confirm"][data-go="0"]');
    await sleep(900);
    const kept = await permBtn(), askBefore = (await agentOf('399e17')).ask;
    await realClick('#permBtn');
    await sleep(1100);
    await clickIn('[data-act="confirm"][data-go="1"]');
    await sleep(1300);
    const on = await permBtn(), words = await said(), a = await agentOf('399e17');
    const confirms = (await posts()).filter(x => x.path.startsWith('/api/confirm/')).map(x => x.body.go);
    check(FP + 'Keep asking changes nothing; Turn on full permissions lights the button, allows the question waiting, and says so',
      kept.pressed === 'false' && !kept.on && !!askBefore && on.pressed === 'true' && on.on && on.led && on.state === 'full'
      && /Full permissions are on\. 1 waiting question was allowed\./.test(words) && a.ask === null && a.state === 'working' && JSON.stringify(confirms) === '[false,true]',
      `kept ${JSON.stringify(kept)}; on ${JSON.stringify(on)}; said "${words}"; ${a.state} ${JSON.stringify(a.ask)}; confirms ${JSON.stringify(confirms)}`);
  });

  await run(FP + 'while they are on, typed work starts at once with no card and nothing about them; pressed when on, the button turns them off at once, with no card', async () => {
    await clearLog();
    await typeIn('start an agent to fix the flaky checkout test');
    await sleep(1100);
    const started = await said(), cards = (await posts()).filter(x => x.path === '/api/command').length, lidThen = await lidNow();
    await clearLog();
    await realClick('#permBtn');
    await sleep(1000);
    const off = await permBtn(), lid = await lidNow(), words = await said(), p = await permPosts();
    check(FP + 'while they are on, typed work starts at once with no card and nothing about them; pressed when on, the button turns them off at once, with no card',
      started === 'Started a simulated Claude on “fix the flaky checkout test”.' && cards === 1 && !/^You said/.test(lidThen)
      && off.pressed === 'false' && !off.on && !/^Before agents stop asking/.test(lid) && /Agents ask again before risky steps\./.test(words)
      && p.length === 1 && JSON.stringify(p[0].body) === '{"mode":"ask"}',
      `started "${started}", lid then "${lidThen}"; ${JSON.stringify(off)}; lid "${lid}"; said "${words}"; ${JSON.stringify(p.map(x => x.body))}`);
  });

  await run(FP + 'the page arrives with the button already right: from <html> before the first snapshot, never drawn the other way', async () => {
    await b.beforeLoad(`(() => { window.__perm = []; document.addEventListener('DOMContentLoaded', () => { const e = document.getElementById('permBtn');
      if (e) new MutationObserver(() => window.__perm.push((e.hidden ? 'hidden' : 'shown') + ':' + e.getAttribute('aria-pressed'))).observe(e, { attributes: true }); }); })()`);
    await open('full', { mode: { holdMs: 700 } });
    await sleep(600);
    const tag = await b.ev(`document.documentElement.dataset.permissions`);
    const btn = await permBtn(), seen = await b.ev(`(window.__perm || []).join(',')`);
    check(FP + 'the page arrives with the button already right: from <html> before the first snapshot, never drawn the other way',
      tag === 'full' && btn.pressed === 'true' && btn.on && !/shown:false/.test(seen) && /shown:true/.test(seen),
      `html ${tag}; ${JSON.stringify(btn)}; seen ${seen}`);
  });

  await run(FP + 'a page that loads with them on has the button lit from its first frame, never fading in from the quiet look', async () => {
    // the button's colours on every frame from the first one it shows, with motion on (the stream's first snapshot held
    // past the page's first 60 ms, when transitions are off anyway)
    await b.beforeLoad(`(() => { window.__permLook = []; const tick = () => { const e = document.getElementById('permBtn');
      if (e && !e.hidden) { const cs = getComputedStyle(e); window.__permLook.push([cs.borderTopColor, cs.backgroundColor, cs.color, cs.boxShadow].join(' | ')); }
      if (window.__permLook.length < 40) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
    await open('full', { mode: { holdMs: 700 } });
    await sleep(700);
    const motion = await b.ev(`!document.body.classList.contains('still') && !matchMedia('(prefers-reduced-motion: reduce)').matches`);
    const frames = await b.ev(`window.__permLook || []`);
    const lit = await b.ev(`(() => { const cs = getComputedStyle(document.getElementById('permBtn')); return [cs.borderTopColor, cs.backgroundColor, cs.color, cs.boxShadow].join(' | '); })()`);
    const other = frames.filter(f => f !== lit);
    check(FP + 'a page that loads with them on has the button lit from its first frame, never fading in from the quiet look',
      motion && frames.length >= 20 && other.length === 0,
      `motion ${motion}; ${frames.length} frames, ${other.length} not lit (first: ${other[0] || 'none'}); lit: ${lit}`);
  });

  await run(FP + 'a button drawn for the other mode says "That changed" and posts nothing', async () => {
    await open('demo');
    await sleep(900);
    await b.ev(`window.__frames.hold = true, 1`);
    await push('snapshot', { ...(await ctl('state')), permissions: 'full' });
    await sleep(500);   // the stream has brought it; the band has not been drawn again
    const drawn = (await permBtn()).state;
    await b.ev(`document.getElementById('permBtn').click(), 1`);
    await sleep(150);
    const words = await said();
    await b.ev(`window.__frames.release(), 1`);
    await sleep(800);
    const p = await permPosts(), now = await permBtn();
    check(FP + 'a button drawn for the other mode says "That changed" and posts nothing',
      drawn === 'ask' && p.length === 0 && /That changed\. Have another look\./.test(words) && now.pressed === 'true',
      `drawn for ${drawn}, posts ${p.length}, said "${words}", now ${now.pressed}`);
  });

  await run(FP + 'pressed again while its own card is up, the card stays as it is, nothing is said, and the focus goes to it', async () => {
    await open('demo');
    await sleep(900);
    await realClick('#permBtn');
    await sleep(1100);
    const yesOf = () => b.ev(`${page()}?.querySelector('[data-act="confirm"][data-go="1"]')?.dataset.confirm || ''`);
    const first = await yesOf(), lid = await lidNow();
    await b.ev(`document.getElementById('say').focus(), 1`); // the focus elsewhere first, so where it goes shows
    await clearLog();
    const before = await said();
    for (const press of [() => realClick('#permBtn'), async () => { await b.ev(`document.getElementById('permBtn').focus(), 1`); await b.key('Enter'); }]) {
      await press();
      await sleep(900);
    }
    const again = await yesOf(), lidAgain = await lidNow(), f = await focusNow(), after = await said();
    const sent = (await posts()).filter(x => x.path.startsWith('/api/confirm/') || x.path === '/api/permissions');
    check(FP + 'pressed again while its own card is up, the card stays as it is, nothing is said, and the focus goes to it',
      lid === 'Before agents stop asking / Let agents do anything without asking?' && lidAgain === lid && !!first && again === first
      && sent.length === 0 && f === 'core:H1' && after === before,
      `"${lid}" ${first} → "${lidAgain}" ${again}; focus ${f}; said "${before}" → "${after}"; sent ${JSON.stringify(sent.map(x => x.path))}`);
  });

  await run(FP + 'their card goes when they are turned on in another tab, and nothing is sent for it', async () => {
    await open('demo');
    await sleep(900);
    await realClick('#permBtn');
    await sleep(1100);
    const card = await lidNow();
    await clearLog();
    // another tab said yes: the stream brings the mode, and this card asks about the mode as it was
    await ctl('prefs', { permissions: 'full' });
    await push('snapshot', { ...(await ctl('state')), permissions: 'full' });
    await sleep(900);
    const after = await lidNow(), on = await permBtn();
    const sent = (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
    check(FP + 'their card goes when they are turned on in another tab, and nothing is sent for it',
      card === 'Before agents stop asking / Let agents do anything without asking?' && !/^Before agents stop asking/.test(after) && on.pressed === 'true' && sent.length === 0,
      `"${card}" → "${after}" (${on.pressed}); confirms sent ${sent.length}`);
  });

  await run(FP + 'a keyboard press takes the keyboard to the card; a card already on screen is withdrawn first', async () => {
    await open('demo');
    await sleep(900);
    await typeIn('stop the sign-up one');
    await sleep(1100);
    await b.ev(`document.getElementById('permBtn').focus(), 1`);
    await b.key('Enter');
    await sleep(1300);
    const lid = await lidNow(), f = await focusNow();
    const p = (await posts()).filter(x => x.path.startsWith('/api/confirm/') || x.path === '/api/permissions').map(x => x.path.startsWith('/api/confirm/') ? `confirm:${x.body.go}` : `permissions:${x.body.mode}`);
    check(FP + 'a keyboard press takes the keyboard to the card; a card already on screen is withdrawn first',
      lid === 'Before agents stop asking / Let agents do anything without asking?' && f === 'core:H1' && JSON.stringify(p) === '["confirm:false","permissions:full"]',
      `"${lid}", focus ${f}, ${JSON.stringify(p)}`);
  });

  await run(FP + 'words: "stop asking" brings the card, a bare "yes" keeps it, "turn it off" keeps asking, "turn it on" turns them on, "ask first" turns them off', async () => {
    await open('demo');
    await sleep(900);
    await typeIn('stop asking'); await sleep(1100);
    const card = await lidNow();
    await typeIn('yes'); await sleep(900);
    const kept = await lidNow(), keptSaid = await said();
    await typeIn('turn it off'); await sleep(1100);
    const no = await lidNow(), noSaid = await said(), still = await permBtn();
    await typeIn('stop asking'); await sleep(1100);
    await typeIn('turn it on'); await sleep(1300);
    const on = await permBtn();
    await typeIn('ask first'); await sleep(1300);
    const off = await permBtn(), offSaid = await said();
    const p = (await posts()).filter(x => x.path === '/api/command').map(x => [x.body.text, !!x.body.confirmId]);
    check(FP + 'words: "stop asking" brings the card, a bare "yes" keeps it, "turn it off" keeps asking, "turn it on" turns them on, "ask first" turns them off',
      card === 'Before agents stop asking / Let agents do anything without asking?' && kept === card
      && /Say “do it” to turn on full permissions, or “cancel”\./.test(keptSaid) && !/^Before agents stop asking/.test(no)
      && /OK, agents still ask before risky steps\./.test(noSaid) && still.pressed === 'false' && on.pressed === 'true' && off.pressed === 'false'
      && /Agents ask again before risky steps\./.test(offSaid)
      && JSON.stringify(p) === JSON.stringify([['stop asking', false], ['yes', true], ['turn it off', true], ['stop asking', false], ['turn it on', true], ['ask first', false]]),
      `"${card}"; yes → "${kept}" "${keptSaid}"; turn it off → "${no}" "${noSaid}" (${still.pressed}); on ${on.pressed}; off ${off.pressed} "${offSaid}"; ${JSON.stringify(p)}`);
  });

  await run(FP + 'the button sits in the top band just left of Agents & keys, lit amber in every look', async () => {
    const out = [];
    let ok = true;
    for (const theme of ['green', 'black-gold', 'ivory']) {
      await open('full-live', { theme });
      await sleep(900);
      const p = await permBtn();
      const c = await b.ev(`(() => { const r = document.getElementById('connectBtn').getBoundingClientRect(); return { left: r.left, mid: r.top + r.height / 2, hidden: document.getElementById('connectBtn').hidden }; })()`);
      const colours = await b.ev(`(() => { const e = document.getElementById('permBtn'), cs = getComputedStyle(e), led = getComputedStyle(e.querySelector('.led'));
        const lit = getComputedStyle(document.documentElement).getPropertyValue('--lit').trim(); return { border: cs.borderTopColor, led: led.backgroundColor, lit }; })()`);
      const rgb = hex => { const n = parseInt(hex.replace('#', ''), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
      const here = p.on && p.pressed === 'true' && !c.hidden && p.right <= c.left - 6 && p.right >= c.left - 14 && Math.abs(p.mid - c.mid) <= 1.5
        && colours.border === rgb(colours.lit) && colours.led === rgb(colours.lit);
      ok = ok && here;
      out.push(`${theme}: ${here} (${Math.round(p.right)}→${Math.round(c.left)}, ${JSON.stringify(colours)})`);
    }
    check(FP + 'the button sits in the top band just left of Agents & keys, lit amber in every look', ok, out.join('; '));
  });

  // ---------------------------------------------------------------- agents' copies: the setup card a launch waits on
  const SC = 'setup card: ';
  const SETUP_LID = 'Before agents start / Run this setup command in each agent’s copy before it starts?';
  const confirmPosts = async () => (await posts()).filter(x => x.path.startsWith('/api/confirm/'));
  const codeNow = () => b.ev(`${page()}?.querySelector('.exact code')?.textContent || ''`);
  const cardIdOf = go => b.ev(`${page()}?.querySelector('[data-act="confirm"][data-go="${go}"]')?.dataset.confirm || ''`);
  const launch = async task => {
    await typeIn(`start an agent to ${task}`);
    await sleep(1100);
    const lid = await lidNow();
    await clickIn('[data-act="confirm"][data-go="1"]');
    await sleep(1500);
    return lid;
  };

  await run(SC + 'Do it on a launch, then the setup card comes in the middle by itself, and Run it runs it in that agent’s copy', async () => {
    await open('setup');
    await sleep(900);
    const asked = await launch('fix the login redirect');
    const card = await lidNow(), row = await acts(), code = await codeNow(), id = await cardIdOf(1);
    // while the card waits, its copy made, the agent says it waits for the answer (not "Copying …")
    const waiting = (await ctl('state')).agents.find(x => x.name === 'Fix the login redirect')?.now;
    await clickIn('[data-act="confirm"][data-go="1"]');
    await sleep(1300);
    const after = await lidNow(), words = await said(), p = await confirmPosts();
    const a = (await ctl('state')).agents.find(x => x.name === 'Fix the login redirect');
    check(SC + 'Do it on a launch, then the setup card comes in the middle by itself, and Run it runs it in that agent’s copy',
      asked === 'You said / Start a simulated Claude on “fix the login redirect”?' && card === SETUP_LID && row === 'Run it*,Not now' && code === 'npm ci'
      && waiting === 'Waiting for your answer about the setup command'
      && /^s/.test(id) && p.length === 2 && p[1].path === `/api/confirm/${id}` && p[1].body.go === true
      && words.includes('OK. Each agent’s copy runs it before the agent starts.') && after !== SETUP_LID && !!a && /The setup command ran in it\.$/.test(a.now),
      `"${asked}" → "${card}" [${row}] "${code}" ${id}, waiting "${waiting}"; then "${after}" said "${words}"; ${JSON.stringify(p.map(x => [x.path, x.body]))}; now "${a?.now}"`);
  });

  await run(SC + 'Not now starts the agent without the command, and the next launch asks again', async () => {
    await open('setup');
    await sleep(900);
    await launch('fix the cart total');
    const first = await cardIdOf(0);
    await clickIn('[data-act="confirm"][data-go="0"]');
    await sleep(1200);
    const words = await said();
    const a = (await ctl('state')).agents.find(x => x.name === 'Fix the cart total');
    await launch('fix the tax rounding');
    const again = await lidNow(), second = await cardIdOf(1);
    const p = (await confirmPosts()).map(x => [x.path.replace(/^\/api\/confirm\//, ''), x.body.go]).filter(x => x[0].startsWith('s'));
    check(SC + 'Not now starts the agent without the command, and the next launch asks again',
      /^s/.test(first) && words.includes('OK. The agent starts without it, and Workbench asks again next time.') && !!a && /It starts without the setup command\.$/.test(a.now)
      && again === SETUP_LID && /^s/.test(second) && second !== first && JSON.stringify(p) === JSON.stringify([[first, false]]),
      `${first} said "${words}"; now "${a?.now}"; again "${again}" ${second}; ${JSON.stringify(p)}`);
  });

  await run(SC + 'a page opened while launches wait shows the card, its whole command, and "run it" typed answers it', async () => {
    await open('setup-card');
    await sleep(1000);
    const card = await lidNow(), code = await codeNow();
    await typeIn('run it');
    await sleep(1100);
    const after = await lidNow(), words = await said();
    const p = (await posts()).filter(x => x.path === '/api/command');
    check(SC + 'a page opened while launches wait shows the card, its whole command, and "run it" typed answers it',
      card === SETUP_LID && /^npm ci && .* node scripts\/seed-test-db\.mjs --quiet --reset$/.test(code)
      && p.length === 1 && p[0].body.text === 'run it' && p[0].body.confirmId === 's00a001'
      && words.includes('OK. Each agent’s copy runs it before the agent starts.') && after !== SETUP_LID,
      `"${card}" "${code}"; then "${after}" said "${words}"; ${JSON.stringify(p.map(x => x.body))}`);
  });

  // ---------------------------------------------------------------- the file view
  // The sheet in the middle, in the 'files' scenario: its ways in (the files chip, ⌘P, ⌘⇧F, a path on the git screen),
  // Esc and the keyboard's way back, a folder from the path, the finder's keys and space, a search to a line, Edit, Save
  // and a conflict, line endings kept, a file read again when it changes, the needs-you pill, and the sheet never waiting
  // for the file. Every name starts "File view: ", so --only 'File view' runs just these.
  const FV = 'File view: ';
  const fv = () => b.ev(`(() => { const d = document.getElementById('fileSheet'), a = document.activeElement;
    return { open: d.open, focus: a ? (a.id || a.className || a.tagName) : 'body', field: document.getElementById('fvFind').value, title: document.getElementById('fvTitle').textContent.replace(/\\s+/g, ' ').trim(),
      whose: document.getElementById('fvWhose').textContent.replace(/\\s+/g, ' ').trim(), acts: document.getElementById('fvActs').textContent.trim(), list: !document.getElementById('fvList').hidden,
      code: !document.getElementById('fvCode').hidden, edit: !document.getElementById('fvEdit').hidden, ph: document.getElementById('fvPh').textContent,
      rows: [...document.querySelectorAll('#fvList [role="option"]')].map(o => o.textContent.replace(/\\s+/g, ' ').trim()), sr: window.__sr ? window.__sr.starts : 0 }; })()`);
  const fileReads = async () => (await (await fetch(base + '/ctl/file-reads')).json());
  const keysIn = async text => { for (const ch of text) { await b.key(ch); await sleep(15); } };
  const pickRow = async text => b.ev(`(() => { const o = [...document.querySelectorAll('#fvList [role="option"]')].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!o) return false; o.click(); return true; })()`);
  const shownRows = () => b.ev(`[...document.querySelectorAll('#fvRows .fv-row')].map(r => r.querySelector('.no').textContent + ':' + r.querySelector('.tx').textContent)`);

  await run(FV + 'the files chip opens it in the middle, the keyboard in its field; Esc closes it and gives the keyboard back to the chip', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.getElementById('filesChip').focus(), 1`);
    await b.key('Enter'); await sleep(700);
    const opened = await fv();
    const reads = (await fileReads()).filter(r => r.path === '/api/files').length;
    await b.key('Escape'); await sleep(500);
    const after = await fv();
    check(FV + 'the files chip opens it in the middle, the keyboard in its field; Esc closes it and gives the keyboard back to the chip',
      opened.open && opened.focus === 'fvFind' && opened.list && /storefront/.test(opened.title) && /Your folder · main/.test(opened.whose) && reads >= 1 && !after.open && after.focus === 'filesChip',
      `${JSON.stringify({ open: opened.open, focus: opened.focus, title: opened.title, whose: opened.whose, reads })} → ${after.open} ${after.focus}`);
  });

  await run(FV + '⌘P opens the finder from anywhere on the board: files agents changed first; Esc gives the keyboard back to the lid', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.querySelector('#pages .page:not(.old) h1').focus(), 1`);
    await b.key('p', { meta: true }); await sleep(700);
    const st = await fv();
    await b.key('Escape'); await sleep(500);
    const back = await b.ev(`document.activeElement === document.querySelector('#pages .page:not(.old) h1')`);
    check(FV + '⌘P opens the finder from anywhere on the board: files agents changed first; Esc gives the keyboard back to the lid',
      st.open && st.focus === 'fvFind' && st.list && st.ph === 'find a file' && /Changed by agents/.test(await b.ev(`document.getElementById('fvList').textContent`)) && st.rows.some(r => /export\.ts/.test(r)) && back,
      `${JSON.stringify(st.rows.slice(0, 4))} back ${back}`);
  });

  await run(FV + '⌘⇧F opens it ready for words in the files; they list as "In files", and Enter opens that file at that line, marked', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('f', { meta: true, shift: true }); await sleep(600);
    const st = await fv();
    await keysIn('oldest first'); await sleep(900);
    const hits = await b.ev(`[...document.querySelectorAll('#fvList .fv-hit')].map(o => o.textContent.replace(/\\s+/g, ' ').trim())`);
    const search = (await fileReads()).filter(r => r.path === '/api/search').map(r => r.q);
    const firstHit = hits[0] || '';
    await b.key('Enter'); await sleep(900);
    const after = await fv();
    const marked = await b.ev(`[...document.querySelectorAll('#fvRows .fv-row.fresh .no')].map(n => n.textContent)`);
    check(FV + '⌘⇧F opens it ready for words in the files; they list as "In files", and Enter opens that file at that line, marked',
      st.open && st.focus === 'fvFind' && st.ph === 'find words in the files' && /^query\.ts:5/.test(firstHit) && search.includes('oldest first') && /query\.ts$/.test(after.title) && after.code && after.focus === 'fvCode' && JSON.stringify(marked) === '["5"]',
      `ph "${st.ph}", hits ${JSON.stringify(hits.slice(0, 2))}, searched ${JSON.stringify(search)}, opened "${after.title}", marked ${JSON.stringify(marked)}`);
  });

  await run(FV + 'the finder\'s keys: letters filter, space types a space and never listens, ↓ and Enter open, Esc empties the field, then closes', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(600);
    await keysIn('exp'); await b.key(' '); await sleep(300);
    const typed = await fv();
    await b.key('Backspace'); await sleep(200);
    await b.key('ArrowDown'); await sleep(150);
    const second = await b.ev(`document.querySelector('#fvList .fv-opt.on')?.textContent || ''`);
    await b.key('ArrowUp'); await b.key('Enter'); await sleep(800);
    const opened = await fv();
    await keysIn('qu'); await sleep(400);
    const typing = await fv();
    await b.key('Escape'); await sleep(300);
    const cleared = await fv();
    await b.key('Escape'); await sleep(400);
    const closed = await fv();
    check(FV + 'the finder\'s keys: letters filter, space types a space and never listens, ↓ and Enter open, Esc empties the field, then closes',
      typed.field === 'exp ' && typed.sr === 0 && /export/.test(typed.rows[0] || '') && second !== '' && /export\.ts$/.test(opened.title) && opened.focus === 'fvCode'
      && typing.field === 'qu' && typing.focus === 'fvFind' && typing.list && cleared.field === '' && cleared.code && cleared.open && !closed.open,
      `typed "${typed.field}" (listening ${typed.sr}), first ${typed.rows[0]}; opened "${opened.title}" ${opened.focus}; typing "${typing.field}" ${typing.focus}; cleared "${cleared.field}" code ${cleared.code}; closed ${!closed.open}`);
  });

  await run(FV + '"40", ":40" and "line 40" jump to a line of the file shown', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.getElementById('filesChip').click(), 1`); await sleep(600);
    await pickRow('src'); await sleep(400);
    await pickRow('generated'); await sleep(400);
    await pickRow('rates.ts'); await sleep(1200);
    const out = [];
    for (const words of ['40', ':12000', 'line 24999']) {
      await b.ev(`document.getElementById('fvFind').focus(), 1`);
      await keysIn(words); await sleep(300);
      const first = await b.ev(`document.querySelector('#fvList [role="option"]')?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
      await b.key('Enter'); await sleep(500);
      const marked = await b.ev(`[...document.querySelectorAll('#fvRows .fv-row.fresh .no')].map(n => n.textContent).join(',')`);
      out.push([words, first, marked]);
    }
    const rows = await b.ev(`document.querySelectorAll('#fvRows .fv-row').length`);
    check(FV + '"40", ":40" and "line 40" jump to a line of the file shown',
      out[0][1].startsWith('Line 40') && out[0][2] === '40' && out[1][2] === '12000' && out[2][2] === '24999' && rows < 200,
      `${JSON.stringify(out)}; ${rows} rows drawn of 25,000`);
  });

  await run(FV + 'a folder in the path shows that folder: one level, folders first, the marks of the agents that changed something; a file there opens', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.getElementById('filesChip').click(), 1`); await sleep(600);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await sleep(300); await b.key('Enter'); await sleep(800);
    const crumbs = await b.ev(`[...document.querySelectorAll('#fvTitle .fv-crumb')].map(c => c.textContent)`);
    await b.ev(`[...document.querySelectorAll('#fvTitle .fv-crumb')].find(c => c.textContent === 'src')?.click(), 1`); await sleep(500);
    const folder = await fv();
    const marks = await b.ev(`[...document.querySelectorAll('#fvList [role="option"]')].filter(o => o.querySelector('.fv-mk svg')).map(o => o.querySelector('.fv-nm').textContent)`);
    await pickRow('cart.ts'); await sleep(700);
    const file = await fv();
    check(FV + 'a folder in the path shows that folder: one level, folders first, the marks of the agents that changed something; a file there opens',
      JSON.stringify(crumbs) === JSON.stringify(['storefront', 'src', 'invoices']) && folder.list && /storefront \/ src$/.test(folder.title)
      && folder.rows.slice(0, 7).every(r => r.includes('/')) && marks.includes('invoices/') && marks.includes('cart.ts') && /cart\.ts$/.test(file.title) && file.code,
      `crumbs ${JSON.stringify(crumbs)}; "${folder.title}" ${JSON.stringify(folder.rows)}; marked ${JSON.stringify(marks)}; opened "${file.title}"`);
  });

  await run(FV + 'on the git screen, a file\'s path in an agent\'s diff opens it in that agent\'s copy, at its first changed line', async () => {
    await open('files', { still: true });
    await sleep(700);
    await click('#dram'); await sleep(700);
    await click('#gitGraph .gr[data-id="work:f1"]'); await sleep(900);
    const btn = await b.ev(`(() => { const b = [...document.querySelectorAll('#gitDetail .dopen')].find(x => x.textContent === 'src/invoices/export.ts'); if (!b) return null; b.click(); return b.dataset.line; })()`);
    await sleep(900);
    const st = await fv();
    const marked = await b.ev(`[...document.querySelectorAll('#fvRows .fv-row.fresh .no')].map(n => n.textContent).join(',')`);
    const reads = (await fileReads()).filter(r => r.path === '/api/file').map(r => `${r.in}:${r.file}`);
    await b.key('Escape'); await sleep(500);
    const back = await b.ev(`(() => { const a = document.activeElement; return !!a && a.classList.contains('dopen') && document.documentElement.dataset.screen === 'git'; })()`);
    check(FV + 'on the git screen, a file\'s path in an agent\'s diff opens it in that agent\'s copy, at its first changed line',
      btn != null && st.open && /In Invoice export’s copy/.test(st.whose) && /export\.ts$/.test(st.title) && marked === String(btn) && reads.includes('f1:src/invoices/export.ts') && back,
      `line ${btn}, "${st.whose}", marked ${marked}, reads ${JSON.stringify(reads)}, back to the path ${back}`);
  });

  await run(FV + 'Edit, then Save: the text as LF with the hash it was read with; "Saved", and the coloured view again', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('query.ts'); await b.key('Enter'); await sleep(800);
    const hash = await b.ev(`fetch('/api/file?in=you&path=src%2Finvoices%2Fquery.ts', { headers: { 'X-Workbench-Token': 'k' } }).then(r => r.json()).then(r => r.hash)`);
    await click('#fvActs [data-fv="edit"]'); await sleep(400);
    const editing = await fv();
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); return 1; })()`);
    await keysIn('// x'); await b.key('Enter'); await sleep(200);
    await click('#fvActs [data-fv="save"]'); await sleep(900);
    const saved = (await posts()).filter(x => x.path === '/api/file');
    const after = await fv();
    const saidSaved = await b.ev(`document.getElementById('fvSaid').textContent`);
    const body = saved[0] && saved[0].body;
    check(FV + 'Edit, then Save: the text as LF with the hash it was read with; "Saved", and the coloured view again',
      editing.edit && editing.focus === 'fvText' && /Save/.test(editing.acts) && saved.length === 1 && body.in === 'you' && body.path === 'src/invoices/query.ts' && body.hash === hash
      && body.text.startsWith('// x\n') && !body.text.includes('\r') && body.text.endsWith('\n') && !('force' in body) && !after.edit && after.code && /Saved/.test(saidSaved),
      `${JSON.stringify(body && { ...body, text: body.text.slice(0, 30) })}; after: edit ${after.edit}, said "${saidSaved}"`);
  });

  await run(FV + 'a file changed on disk while it was edited: nothing is written; Save mine anyway sends force with the hash it is now', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('// mine\\n', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`);
    const written = await (await fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: 'you', path: 'src/invoices/export.ts', text: '// theirs\nexport const x = 1;\n' }) })).json();
    const theirs = written.hash;
    await sleep(2600);   // the 2-second check sees it first
    const seen = await fv();
    await click('#fvWhose [data-fv="keep"]'); await sleep(200);
    await click('#fvActs [data-fv="save"]'); await sleep(800);
    const conflict = await fv();
    await click('#fvWhose [data-fv="mine"]'); await sleep(800);
    const saves = (await posts()).filter(x => x.path === '/api/file').map(x => ({ force: !!x.body.force, hash: x.body.hash.slice(0, 8), mine: x.body.text.startsWith('// mine') }));
    const raw = await (await fetch(base + '/ctl/files?in=you&path=src/invoices/export.ts')).json();
    check(FV + 'a file changed on disk while it was edited: nothing is written; Save mine anyway sends force with the hash it is now',
      /^This file changed on disk\. Your edit is still here\./.test(seen.whose) && /Load theirs/.test(seen.whose) && seen.edit
      && /changed on disk while you were editing\. Your edit is still here\./.test(conflict.whose) && /Save mine anyway/.test(conflict.whose)
      && saves.length === 2 && !saves[0].force && saves[1].force && saves[1].hash === theirs.slice(0, 8) && raw.raw.startsWith('// mine'),
      `seen "${seen.whose}"; conflict "${conflict.whose}"; saves ${JSON.stringify(saves)}; theirs ${theirs.slice(0, 8)}; on disk now ${JSON.stringify(raw.raw.slice(0, 20))}`);
  });

  await run(FV + 'Keep editing is remembered: the line does not come back for the same change, and ⌘S then Esc brings the changed lines anew', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvWhose [data-fv="switch"]'); await sleep(900);
    const before = await fv();
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, '// one line more\\n'); return 1; })()`);
    const now = await b.ev(`fetch('/api/file?in=f1&path=src%2Finvoices%2Fbatch.ts', { headers: { 'X-Workbench-Token': 'k' } }).then(r => r.json()).then(r => r.text)`);
    void now;
    await b.key('s', { meta: true }); await sleep(900);
    await b.key('Escape'); await sleep(1200);
    const after = await fv();
    const gold = await b.ev(`document.querySelectorAll('#fvRows .fv-row.chg').length`);
    // a change on disk while editing, kept: the 2-second check stays quiet about it
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('// mine\\n', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`);
    const disk = await b.ev(`fetch('/api/file?in=f1&path=src%2Finvoices%2Fexport.ts', { headers: { 'X-Workbench-Token': 'k' } }).then(r => r.json()).then(r => r.text)`);
    await fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: 'f1', path: 'src/invoices/export.ts', text: '// theirs\n' + disk }) });
    await sleep(2600);
    const told = await fv();
    await click('#fvWhose [data-fv="keep"]'); await sleep(2700);
    const quiet = await fv();
    check(FV + 'Keep editing is remembered: the line does not come back for the same change, and ⌘S then Esc brings the changed lines anew',
      /6 lines changed/.test(before.whose) && /7 lines changed/.test(after.whose) && gold === 7 && !after.edit
      && /^Invoice export changed this file\. Your edit is still here\./.test(told.whose) && quiet.edit && !/changed this file/.test(quiet.whose),
      `before "${before.whose}", after ⌘S and Esc "${after.whose}" (${gold} gold), told "${told.whose}", after Keep editing "${quiet.whose}"`);
  });

  await run(FV + 'the editor on a file of 25,000 lines: at the same place, its numbers in step, the caret in sight, and quick to type in', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('rates.ts'); await b.key('Enter'); await sleep(1200);
    await b.ev(`document.getElementById('fvFind').focus(), 1`);
    await keysIn('12000'); await b.key('Enter'); await sleep(500);
    const codeTop = await b.ev(`document.getElementById('fvCode').scrollTop`);
    await click('#fvActs [data-fv="edit"]'); await sleep(500);
    const ed = () => b.ev(`(() => { const e = document.getElementById('fvEdit'), t = document.getElementById('fvText'), box = e.getBoundingClientRect();
      const first = [...document.querySelectorAll('#fvEnums span')].find(n => n.getBoundingClientRect().top >= box.top - 1);
      const line = t.value.slice(0, t.selectionEnd).split('\\n').length, lh = parseFloat(getComputedStyle(t).lineHeight);
      const caretY = box.top + (line - 1) * lh + 8 - e.scrollTop;
      return { top: Math.round(e.scrollTop), first: first ? +first.textContent : 0, line, inSight: caretY >= box.top - 1 && caretY + lh <= box.bottom + 1 }; })()`);
    const at = await ed();
    for (let i = 0; i < 45; i++) await b.key('ArrowDown');
    await sleep(300);
    const down = await ed();
    const t0 = Date.now();
    await keysIn('abcdefghij');
    const ms = Date.now() - t0;
    check(FV + 'the editor on a file of 25,000 lines: at the same place, its numbers in step, the caret in sight, and quick to type in',
      Math.abs(at.top - codeTop) < 2 && Math.abs(at.first - (at.line)) <= 1 && at.first > 11900 && at.inSight && down.line === at.line + 45 && down.inSight && down.top > at.top && ms < 2500,
      `code ${Math.round(codeTop)}, editor ${JSON.stringify(at)} → ${JSON.stringify(down)}, ten keys in ${ms} ms`);
  });

  await run(FV + 'a key typed into the finder is never searched for: it stays out of every address', async () => {
    await open('files', { still: true });
    await sleep(700);
    const key = ['ghp', 'Z9xY8wV7uT6sR5qP4oN3mL2kJ1hG0fE9dC8'].join('_');
    await b.key('f', { meta: true, shift: true }); await sleep(300);
    await b.ev(`(() => { const i = document.getElementById('fvFind'); i.value = ${JSON.stringify(key)}; i.dispatchEvent(new Event('input')); return 1; })()`);
    await sleep(900);
    const said = await b.ev(`document.getElementById('fvList').textContent`);
    const field = await b.ev(`document.getElementById('fvFind').value`);
    const anywhere = await b.ev(`document.getElementById('fileSheet').textContent.includes(${JSON.stringify(key.slice(4, 14))})`);
    const reads = (await fileReads()).filter(r => (r.q || '').includes(key.slice(4, 14)) || (r.file || '').includes(key.slice(4, 14)));
    await b.key('Escape'); await sleep(200);
    check(FV + 'a key typed into the finder is never searched for: it stays out of every address', reads.length === 0 && field === '' && !anywhere && /looks like a key, so it was not searched for\. Keys go in Agents & keys/.test(said),
      `${reads.length} reads carried it; field "${field ? '(not empty)' : ''}"; on the page ${anywhere}; "${said.slice(0, 90)}"`);
  });

  await run(FV + 'every hidden character an agent controls shows in the sheet: in the path, its title, the finder and a folder', async () => {
    await open('files', { still: true });
    await sleep(700);
    const SCAN = String.raw`(async () => {
      const { hasHidden } = await import('/ui/diffview.js');
      const out = [], root = document.getElementById('fileSheet');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) if (hasHidden(n.data.replace(/\n/g, ''))) out.push('text of ' + (n.parentElement.id || n.parentElement.className));
      for (const e of root.querySelectorAll('*')) for (const at of ['aria-label', 'title', 'aria-description', 'placeholder', 'alt']) { const v = e.getAttribute(at); if (v && hasHidden(v.replace(/\n/g, ''))) out.push(at + ' of ' + (e.id || e.className)); }
      return [...new Set(out)];
    })()`;
    const found = [];
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('readme'); await sleep(400);
    const row = await b.ev(`[...document.querySelectorAll('#fvList [role="option"]')].map(o => o.textContent).find(t => t.includes('txt.exe')) || ''`);
    found.push(...(await b.ev(SCAN)).map(x => 'finder: ' + x));
    await b.ev(`[...document.querySelectorAll('#fvList [role="option"]')].find(o => o.textContent.includes('txt.exe'))?.click(), 1`); await sleep(900);
    const title = await fv();
    found.push(...(await b.ev(SCAN)).map(x => 'file: ' + x));
    await b.ev(`[...document.querySelectorAll('#fvTitle .fv-crumb')].find(c => c.textContent === 'notes')?.click(), 1`); await sleep(500);
    found.push(...(await b.ev(SCAN)).map(x => 'folder: ' + x));
    const folderRows = (await fv()).rows;
    check(FV + 'every hidden character an agent controls shows in the sheet: in the path, its title, the finder and a folder',
      found.length === 0 && /readme⟦U\+202E⟧txt\.exe/.test(row) && /readme⟦U\+202E⟧txt\.exe$/.test(title.title) && folderRows.some(r => /⟦U\+202E⟧/.test(r)),
      `raw: ${JSON.stringify(found)}; row "${row}"; title "${title.title}"; folder ${JSON.stringify(folderRows)}`);
  });

  await run(FV + 'Load theirs shows the file as it is now, and no edit is left behind', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('README.md'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('mine ', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`);
    await fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: 'you', path: 'README.md', text: '# Theirs\n' }) });
    await click('#fvActs [data-fv="save"]'); await sleep(800);
    await click('#fvWhose [data-fv="theirs"]'); await sleep(800);
    const st = await fv();
    const rows = await shownRows();
    check(FV + 'Load theirs shows the file as it is now, and no edit is left behind',
      !st.edit && st.code && rows[0] === '1:# Theirs' && /Edit/.test(st.acts) && (await posts()).filter(x => x.path === '/api/file').length === 1,
      `edit ${st.edit}, rows ${JSON.stringify(rows.slice(0, 2))}, acts "${st.acts}"`);
  });

  await run(FV + 'a Windows file keeps its CRLF: the page sends LF and the engine writes CRLF back', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('sample.csv'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 1; })()`);
    await keysIn('INV-1004,2026-10-12,9.99'); await b.key('Enter'); await sleep(150);
    await b.key('s', { meta: true }); await sleep(800);
    const body = (await posts()).filter(x => x.path === '/api/file').map(x => x.body)[0];
    const raw = await (await fetch(base + '/ctl/files?in=you&path=src/invoices/sample.csv')).json();
    const stillEditing = await fv();
    check(FV + 'a Windows file keeps its CRLF: the page sends LF and the engine writes CRLF back',
      body && !body.text.includes('\r') && body.text.endsWith('INV-1004,2026-10-12,9.99\n') && raw.raw.includes('INV-1004,2026-10-12,9.99\r\n') && !/[^\r]\n/.test(raw.raw) && stillEditing.edit,
      `sent ${JSON.stringify(body && body.text.slice(-30))}, on disk ${JSON.stringify(raw.raw.slice(-32))}, still editing after ⌘S ${stillEditing.edit}`);
  });

  await run(FV + 'Tab puts in the file\'s own indentation: spaces in a TypeScript file, a tab in Go', async () => {
    await open('files', { still: true });
    await sleep(700);
    const out = [];
    for (const name of ['export.ts', 'main.go']) {
      await b.key('p', { meta: true }); await sleep(300);
      await keysIn(name); await b.key('Enter'); await sleep(800);
      await click('#fvActs [data-fv="edit"]'); await sleep(300);
      await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); return 1; })()`);
      await b.key('Tab'); await sleep(100);
      out.push(await b.ev(`JSON.stringify(document.getElementById('fvText').value.slice(0, 3))`));
      await b.ev(`document.execCommand('undo'), 1`); await sleep(100);
      out.push(await b.ev(`document.activeElement.id`));
      await click('#fvActs [data-fv="cancel"]'); await sleep(300);
      if (await b.ev(`!!document.querySelector('#fvWhose [data-fv="leave"]')`)) await click('#fvWhose [data-fv="leave"]');
    }
    check(FV + 'Tab puts in the file\'s own indentation: spaces in a TypeScript file, a tab in Go', out[0] === JSON.stringify('  i') && out[1] === 'fvText' && out[2] === JSON.stringify('\tpa'), JSON.stringify(out));
  });

  await run(FV + 'Esc in the editor asks first when something changed, and a second Esc keeps editing with the edit intact', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('cart.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); return 1; })()`);
    await keysIn('zz'); await sleep(100);
    await b.key('Escape'); await sleep(300);
    const asked = await fv();
    await b.key('Escape'); await sleep(300);
    const kept = await fv();
    const text = await b.ev(`document.getElementById('fvText').value.slice(0, 4)`);
    await b.key('Escape'); await sleep(300);
    await click('#fvWhose [data-fv="leave"]'); await sleep(300);
    const left = await fv();
    check(FV + 'Esc in the editor asks first when something changed, and a second Esc keeps editing with the edit intact',
      asked.open && /Your changes to cart\.ts are not saved\./.test(asked.whose) && kept.open && kept.edit && kept.focus === 'fvText' && text === 'zz//' && left.open && !left.edit && left.focus === 'fvCode'
      && (await posts()).filter(x => x.path === '/api/file').length === 0,
      `asked "${asked.whose}"; kept ${kept.edit} "${text}" ${kept.focus}; left ${!left.edit} ${left.focus}`);
  });

  await run(FV + 'editing in a working agent\'s copy says it will see the change, and a file with hidden characters says they stay', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('cart.ts'); await b.key('Enter'); await sleep(800);
    const yours = await fv();
    const zw = await b.ev(`[...document.querySelectorAll('#fvRows .vc')].map(v => v.textContent + '|' + v.title)`);
    await click('#fvWhose [data-fv="switch"]'); await sleep(800);
    const theirs = await fv();
    await click('#fvActs [data-fv="edit"]'); await sleep(400);
    const notes = await fv();
    check(FV + 'editing in a working agent\'s copy says it will see the change, and a file with hidden characters says they stay',
      /Price rounding changed it/.test(yours.whose) && zw.includes('⟦U+200B⟧|Hidden here: a zero-width space.') && /In Price rounding’s copy/.test(theirs.whose)
      && notes.whose === 'Price rounding is working in this copy. It will see your change. This file has hidden characters. They stay as they are unless you delete them.',
      `yours "${yours.whose}", marks ${JSON.stringify(zw)}, theirs "${theirs.whose}", editing "${notes.whose}"`);
  });

  await run(FV + 'a file it does not edit says why where Edit would be: an env file shows its values masked, a binary and a link say what they are', async () => {
    await open('files', { still: true });
    await sleep(700);
    const out = [];
    for (const name of ['.env', 'invoice-logo.png', 'keys', 'mixed.txt']) {
      await b.key('p', { meta: true }); await sleep(300);
      await keysIn(name); await b.key('Enter'); await sleep(800);
      const st = await fv();
      out.push({ name, acts: st.acts, note: await b.ev(`document.getElementById('fvNote').hidden ? '' : document.getElementById('fvNote').textContent`), row2: (await shownRows())[1] || '' });
    }
    const [env, png, link, mixed] = out;
    check(FV + 'a file it does not edit says why where Edit would be: an env file shows its values masked, a binary and a link say what they are',
      env.acts === 'This file holds keys, so Workbench shows only their last four characters and does not edit it.' && /^2:STRIPE_SECRET_KEY=•••• [0-9a-f]{4}$/.test(env.row2)
      && png.acts === 'This is a binary file.' && /16 bytes/.test(png.note) && link.acts === 'This is a link to ../../../.ssh/config.' && /→ \.\.\/\.\.\/\.\.\/\.ssh\/config/.test(link.note)
      && mixed.acts === 'This file mixes line endings, so Workbench does not edit it.' && !out.some(o => /^Edit$/.test(o.acts)),
      JSON.stringify(out));
  });

  await run(FV + 'in the demo, a save is kept for this run, and the first one says so', async () => {
    await open('demo', { still: true });
    await sleep(700);
    const said = [];
    for (let i = 0; i < 2; i++) {
      await b.key('p', { meta: true }); await sleep(300);
      await keysIn('README.md'); await b.key('Enter'); await sleep(800);
      await click('#fvActs [data-fv="edit"]'); await sleep(300);
      await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('x', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`);
      await click('#fvActs [data-fv="save"]'); await sleep(900);
      said.push(await b.ev(`document.getElementById('fvWhose').textContent`));
    }
    check(FV + 'in the demo, a save is kept for this run, and the first one says so',
      said[0] === 'This is the demo, so your change is kept only until Workbench closes.' && !/demo/.test(said[1]), JSON.stringify(said));
  });

  await run(FV + 'the view never goes stale: a file that changes on disk is read again near the same line, its new lines marked', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('query.ts'); await b.key('Enter'); await sleep(800);
    const before = await shownRows();
    const now = await b.ev(`fetch('/api/file?in=you&path=src%2Finvoices%2Fquery.ts', { headers: { 'X-Workbench-Token': 'k' } }).then(r => r.json()).then(r => r.text)`);
    await fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: 'you', path: 'src/invoices/query.ts', text: now.replace('// Every invoice', '// A new line from an agent\n// Every invoice') }) });
    // the 2-second check reads it again: watch for it, and read the mark while it lasts (1.7 s)
    let after = before, marked = [];
    for (let i = 0; i < 40 && !after.some(r => /A new line from an agent/.test(r)); i++) {
      await sleep(100);
      after = await shownRows();
      marked = await b.ev(`[...document.querySelectorAll('#fvRows .fv-row.fresh .no')].map(n => n.textContent)`);
    }
    await sleep(2000);
    const gone = await b.ev(`document.querySelectorAll('#fvRows .fv-row.fresh').length`);
    const checks = (await fileReads()).filter(r => r.path === '/api/file' && r.check).length;
    check(FV + 'the view never goes stale: a file that changes on disk is read again near the same line, its new lines marked',
      after.some(r => /A new line from an agent/.test(r)) && !before.some(r => /A new line from an agent/.test(r)) && JSON.stringify(marked) === '["5"]' && gone === 0 && checks >= 1,
      `marked ${JSON.stringify(marked)} (then ${gone}), ${checks} light checks, ${JSON.stringify(after.slice(4, 6))}`);
  });

  await run(FV + 'something that needs you lights a pill at the top; it closes the sheet and shows that in the middle', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.getElementById('filesChip').click(), 1`); await sleep(600);
    const quiet = await b.ev(`document.getElementById('fvNeeds').hidden`);
    await push('agents', [{ ...(await agentOf('f2')), state: 'needs_ok', ask: askOf('fp1', 'Price rounding', 'npm run db:migrate') }]);
    await sleep(600);
    const pill = await b.ev(`(() => { const p = document.getElementById('fvNeeds'); return p.hidden ? null : { text: p.textContent, name: p.getAttribute('aria-label') }; })()`);
    const stillOpen = (await fv()).open;
    await click('#fvNeeds'); await sleep(900);
    const st = await fv();
    check(FV + 'something that needs you lights a pill at the top; it closes the sheet and shows that in the middle',
      quiet && pill && pill.text === 'Price rounding needs you' && /Closes the file view/.test(pill.name) && stillOpen && !st.open && /Price rounding wants to run a command/.test(await h1()),
      `quiet ${quiet}, pill ${JSON.stringify(pill)}, closed ${!st.open}, lid "${await h1()}"`);
  });

  await run(FV + 'the sheet opens at once and never waits for the file: it grows with motion, and the code fades in when it arrives', async () => {
    await open('files', { mode: { delay: { file: 1400 } } });
    await sleep(900);
    await b.key('p', { meta: true });
    await sleep(380);
    const early = await b.ev(`(() => { const d = document.getElementById('fileSheet'); const r = d.getBoundingClientRect(); return { open: d.open, w: Math.round(r.width), clip: getComputedStyle(document.getElementById('fvSheet')).clipPath, dim: document.documentElement.dataset.files || '' }; })()`);
    await sleep(1800);
    const later = await fv();
    check(FV + 'the sheet opens at once and never waits for the file: it grows with motion, and the code fades in when it arrives',
      early.open && early.w > 500 && /^polygon\(16px 0px, 100% 0px/.test(early.clip) && early.dim === 'open' && later.list && later.rows.length > 0,
      `${JSON.stringify(early)}; later ${later.rows.length} rows`);
    await ctl('mode', { delay: null });
  });

  await run(FV + 'with reduced motion it fades in and out briefly, the board dimming and coming back with it, and the keyboard still lands in its field', async () => {
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    try {
      await open('files');
      await sleep(900);
      await b.ev(`document.getElementById('filesChip').click(), 1`);
      const dim = await b.ev(`(() => { const cs = getComputedStyle(document.getElementById('board')); return cs.transitionProperty + ' ' + cs.transitionDuration; })()`);
      await sleep(260);
      const st = await fv();
      await b.key('Escape'); await sleep(40);
      const going = await b.ev(`({ open: document.getElementById('fileSheet').open, fading: document.getElementById('fileSheet').getAnimations().some(a => a.playState === 'running') })`);
      await sleep(260);
      const closed = await fv();
      check(FV + 'with reduced motion it fades in and out briefly, the board dimming and coming back with it, and the keyboard still lands in its field',
        dim === 'opacity 0.14s' && st.open && st.focus === 'fvFind' && going.open && going.fading && !closed.open && closed.focus === 'filesChip',
        `board "${dim}"; ${st.focus}; closing ${JSON.stringify(going)} → ${closed.focus}`);
    } finally { await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); }
  });

  // ---------------------------------------------------------------- the file view, after its review
  const firstShown = () => b.ev(`(() => { const c = document.getElementById('fvCode'), r = c.getBoundingClientRect(); const row = [...document.querySelectorAll('#fvRows .fv-row')].find(x => x.getBoundingClientRect().bottom > r.top + 8 + 1); return { top: c.scrollTop, first: row ? +row.querySelector('.no').textContent : 0 }; })()`);
  const rawOf = async (where, path) => (await (await fetch(`${base}/ctl/files?in=${where}&path=${encodeURIComponent(path)}`)).json()).raw;
  const writeAsAgent = (where, path, text) => fetch(base + '/ctl/files', { method: 'POST', body: JSON.stringify({ in: where, path, text }) });

  await run(FV + 'the finder over the editor: the edit stays unseen under its list, Save and Cancel and the path stay, and Esc gives the keyboard back to the editor', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, '// typed\\n'); return 1; })()`);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('que'); await sleep(400);
    const up = await fv();
    const under = await b.ev(`getComputedStyle(document.getElementById('fvEdit')).visibility + ' ' + getComputedStyle(document.getElementById('fvList')).backgroundColor`);
    await b.key('Escape'); await sleep(300);
    const back = await fv();
    const text = await b.ev(`document.getElementById('fvText').value.slice(0, 9)`);
    check(FV + 'the finder over the editor: the edit stays unseen under its list, Save and Cancel and the path stay, and Esc gives the keyboard back to the editor',
      up.list && up.edit && /^hidden rgb/.test(under) && up.acts === 'SaveCancel' && /export\.ts$/.test(up.title) && up.focus === 'fvFind'
      && !back.list && back.edit && back.focus === 'fvText' && text === '// typed\n' && (await posts()).filter(x => x.path === '/api/file').length === 0,
      `up ${JSON.stringify({ list: up.list, under, acts: up.acts, title: up.title, focus: up.focus })}; back ${JSON.stringify({ list: back.list, edit: back.edit, focus: back.focus, text })}`);
  });

  await run(FV + 'a file read again, and the same file in the other copy, come back to the same place to the pixel, however often', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('rates.ts'); await b.key('Enter'); await sleep(1300);
    await b.ev(`(() => { const c = document.getElementById('fvCode'); const lh = parseFloat(getComputedStyle(document.getElementById('fvRows')).lineHeight); c.scrollTop = 11999 * lh + 8 + 5; return 1; })()`);
    await sleep(300);
    const reads = [await firstShown()];
    for (let k = 0; k < 3; k++) {
      // an agent writes the file's first line: the 2-second check reads it again, far above what shows
      const raw = await rawOf('you', 'src/generated/rates.ts');
      await writeAsAgent('you', 'src/generated/rates.ts', raw.replace(/^\/\/ (Rates|Every rate)/, (m, w) => `// ${w === 'Rates' ? 'Every rate' : 'Rates'}`));
      await sleep(2600);
      reads.push(await firstShown());
    }
    await b.ev(`(document.getElementById('fvCode').scrollTop = 0, 1)`); await sleep(200);
    const top = (await shownRows())[0] || '';   // read again each time: the last of the three writes
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(900);
    await b.ev(`(() => { const c = document.getElementById('fvCode'); c.style.height = '80px'; const lh = parseFloat(getComputedStyle(document.getElementById('fvRows')).lineHeight); c.scrollTop = 5 * lh + 8 + 3; return 1; })()`);
    await sleep(200);
    const sw = [await firstShown()];
    for (let k = 0; k < 4; k++) { await click('#fvWhose [data-fv="switch"]'); await sleep(900); sw.push(await firstShown()); }
    await b.ev(`document.getElementById('fvCode').style.height = '', 1`);
    check(FV + 'a file read again, and the same file in the other copy, come back to the same place to the pixel, however often',
      reads.every(t => t.first === reads[0].first && Math.abs(t.top - reads[0].top) < 1) && reads[0].first === 12000 && /^1:\/\/ Every rate/.test(top)
      && sw.every(t => t.first === sw[0].first && Math.abs(t.top - sw[0].top) < 1),
      `read again ${JSON.stringify(reads)} (line 1 now "${top.slice(0, 24)}"); switched ${JSON.stringify(sw)}`);
  });

  await run(FV + 'the same file from the other copy: what shows stays, Edit waiting, until the answer comes; no blank page, and Edit and the whose line never drop out', async () => {
    await open('files', { mode: { delay: { file: 400 } } });
    await sleep(900);
    await b.key('p', { meta: true }); await sleep(500);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(1300);
    await b.ev(`(window.__sw = [], (() => { const t0 = performance.now(); const step = now => { const c = document.getElementById('fvCode'); window.__sw.push({ t: Math.round(now - t0), op: +getComputedStyle(c).opacity, hidden: c.hidden, rows: document.querySelectorAll('#fvRows .fv-row').length,
      acts: document.getElementById('fvActs').textContent, wait: document.querySelector('#fvActs [data-fv="edit"]')?.getAttribute('aria-disabled') || '', whose: document.getElementById('fvWhose').textContent.slice(0, 26) }); if (now - t0 < 900) requestAnimationFrame(step); }; requestAnimationFrame(step); })(), document.querySelector('#fvWhose [data-fv="switch"]').click(), 1)`);
    await sleep(1100);
    const log = await b.ev('window.__sw');
    const during = log.filter(x => x.t < 380);
    const after = log[log.length - 1];
    check(FV + 'the same file from the other copy: what shows stays, Edit waiting, until the answer comes; no blank page, and Edit and the whose line never drop out',
      during.length > 3 && during.every(x => !x.hidden && x.rows > 0 && x.op >= 0.45 && x.acts === 'Edit' && /^Your folder/.test(x.whose)) && during.some(x => x.wait === 'true')
      && log.every(x => x.op >= 0.45 && x.acts === 'Edit') && /^In Invoice export’s copy/.test(after.whose) && after.wait === '' && after.op === 1,
      `${log.length} frames; during ${JSON.stringify(during.slice(-2))}; after ${JSON.stringify(after)}`);
    await ctl('mode', { delay: null });
  });

  await run(FV + 'a file that comes after the person went to the finder or a folder waits there, and shows when they come back', async () => {
    await open('files', { still: true, mode: { delay: { file: 1400 } } });
    await sleep(900);
    await b.key('p', { meta: true }); await sleep(1700);   // the list comes after 1.4 s
    await keysIn('query.ts'); await sleep(200); await b.key('Enter'); await sleep(250);
    await b.key('p', { meta: true }); await sleep(100);
    await keysIn('car'); await sleep(1700);   // query.ts comes now
    const finder = await fv();
    await b.key('Escape'); await sleep(400);
    const back = await fv();
    const rows = (await shownRows()).length;
    // a folder clicked in the path while a file is on its way
    await b.key('p', { meta: true }); await sleep(200);
    await keysIn('cart.ts'); await sleep(200); await b.key('Enter'); await sleep(200);
    await b.ev(`[...document.querySelectorAll('#fvTitle .fv-crumb')].find(c => c.textContent === 'src')?.click(), 1`); await sleep(1800);
    const folder = await fv();
    await ctl('mode', { delay: null });
    check(FV + 'a file that comes after the person went to the finder or a folder waits there, and shows when they come back',
      finder.list && finder.field === 'car' && finder.focus === 'fvFind' && !finder.code && back.code && /query\.ts$/.test(back.title) && rows > 5
      && folder.list && /storefront \/ src$/.test(folder.title) && !folder.code,
      `finder ${JSON.stringify({ list: finder.list, field: finder.field, focus: finder.focus, code: finder.code })}; back "${back.title}" (${rows} rows); folder "${folder.title}" ${folder.list}`);
  });

  await run(FV + 'the 2-second check that lands while the finder is up leaves the finder alone', async () => {
    await open('files', { still: true, mode: { delay: { file: 1400 } } });
    await sleep(900);
    await b.key('p', { meta: true }); await sleep(1700);
    await keysIn('package.json'); await sleep(200); await b.key('Enter'); await sleep(1800);
    const raw = await rawOf('you', 'package.json');
    const n0 = (await fileReads()).filter(r => r.path === '/api/file' && r.check).length;
    await writeAsAgent('you', 'package.json', raw.replace('"name"', '"description": "x",\n  "name"'));
    // a check is sent (it takes 1.4 s to answer, and finds the change): then the finder, typed into
    let sent = false;
    for (let i = 0; i < 40 && !sent; i++) { await sleep(100); sent = (await fileReads()).filter(r => r.path === '/api/file' && r.check).length > n0; }
    await sleep(150);
    await b.ev(`document.getElementById('fvFind').focus(), 1`);
    await keysIn('rea'); await sleep(1700);
    const st = await fv();
    await ctl('mode', { delay: null });
    check(FV + 'the 2-second check that lands while the finder is up leaves the finder alone', sent && st.list && !st.code && st.field === 'rea' && st.focus === 'fvFind',
      JSON.stringify({ sent, list: st.list, code: st.code, field: st.field, focus: st.focus }));
  });

  await run(FV + 'a key typed into the finder a letter at a time never goes out, nor its start, nor what comes after the field caught it', async () => {
    await open('files', { still: true });
    await sleep(700);
    const key = ['ghp', 'k3mQ9wE5rT3yU1iO9pA8sD6fG4hJ2kL0zX5c'].join('_');
    const r0 = (await fileReads()).length;
    await b.key('f', { meta: true, shift: true }); await sleep(300);
    for (const ch of key) { await b.key(ch); await sleep(200); }   // slower than the search waits for
    await sleep(900);
    const slow = (await fileReads()).slice(r0).filter(r => r.path === '/api/search').map(r => r.q || '');
    const shown = await b.ev(`document.getElementById('fileSheet').textContent.includes(${JSON.stringify(key.slice(4, 12))}) || document.getElementById('fileSheet').textContent.includes(${JSON.stringify(key.slice(-12))})`);
    const field = await b.ev(`document.getElementById('fvFind').value`);
    await sleep(1800);   // the field takes letters again once nothing has come for a moment and a half
    const r1 = (await fileReads()).length;
    await b.ev(`document.getElementById('fvFind').focus(), 1`);
    for (const ch of key) { await b.key(ch); await sleep(12); }   // a password manager's auto-type
    await sleep(900);
    const fast = (await fileReads()).slice(r1).filter(r => r.path === '/api/search').map(r => r.q || '');
    const left = await b.ev(`document.getElementById('fvFind').value`);
    const leak = list => list.filter(q => q.length > 6 && key.includes(q.trim()));
    check(FV + 'a key typed into the finder a letter at a time never goes out, nor its start, nor what comes after the field caught it',
      !leak(slow).length && !leak(fast).length && !shown && field === '' && left === '',
      `slow: ${slow.length} searches, ${leak(slow).length} with a piece of it; fast: ${fast.length}, ${leak(fast).length}; on the page ${shown}; field "${field ? '(not empty)' : ''}", then "${left ? '(not empty)' : ''}"`);
  });

  await run(FV + 'lines found: three a file, the rest of a file in one row that shows them, and nothing from a file too large to show', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('f', { meta: true, shift: true }); await sleep(300);
    await keysIn('invoice'); await sleep(900);
    const rows = () => b.ev(`[...document.querySelectorAll('#fvList .fv-hit, #fvList .fv-more')].map(o => (o.classList.contains('fv-more') ? '+ ' : '') + o.textContent.replace(/\\s+/g, ' ').trim())`);
    const before = await rows();
    const perFile = {};
    for (const r of before.filter(x => !x.startsWith('+ '))) { const p = r.split(':')[0]; perFile[p] = (perFile[p] || 0) + 1; }
    const more = before.find(x => x.startsWith('+ '));
    const at = before.indexOf(more);
    await b.ev(`[...document.querySelectorAll('#fvList .fv-more')][0]?.click(), 1`); await sleep(300);
    const after = await rows();
    const bold = await b.ev(`(() => { const x = document.querySelector('#fvList .fv-hit b'); if (!x) return null; const cs = getComputedStyle(x); return cs.fontWeight + ' ' + cs.textDecorationLine; })()`);
    check(FV + 'lines found: three a file, the rest of a file in one row that shows them, and nothing from a file too large to show',
      !!more && /^\+ and \d+ more in \S+/.test(more) && Object.values(perFile).every(n => n <= 3) && !before.some(x => /large-accounts\.json/.test(x))
      && !after.some(x => x === more) && after.length > before.length - 1 && !after[at].startsWith('+ ') && bold === '700 none',
      `before ${JSON.stringify(before.slice(0, 8))}; after ${JSON.stringify(after.slice(Math.max(0, at - 1), at + 3))}; bold ${bold}`);
  });

  await run(FV + 'while a save meets a change on disk, the question is the one thing: Save and Cancel give way until it is answered', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('query.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvActs [data-fv="edit"]'); await sleep(300);
    await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setRangeText('// mine\\n', 0, 0, 'end'); t.dispatchEvent(new Event('input')); return 1; })()`);
    await writeAsAgent('you', 'src/invoices/query.ts', '// theirs\n');
    await b.key('s', { meta: true }); await sleep(800);
    const asked = await fv();
    const on = await b.ev(`document.activeElement?.dataset?.key || ''`);
    const filled = await b.ev(`[...document.querySelectorAll('#fileSheet .fv-btn.pri')].map(x => x.textContent)`);
    await click('#fvWhose [data-fv="keep"]'); await sleep(300);
    const kept = await fv();
    check(FV + 'while a save meets a change on disk, the question is the one thing: Save and Cancel give way until it is answered',
      /changed on disk while you were editing/.test(asked.whose) && asked.acts === '' && JSON.stringify(filled) === '["Save mine anyway"]' && on === 'ask:mine' && kept.acts === 'SaveCancel' && kept.focus === 'fvText',
      `asked "${asked.acts}" filled ${JSON.stringify(filled)} focus ${on}; kept "${kept.acts}" ${kept.focus}`);
  });

  await run(FV + 'on the git screen, a new file\'s path opens it at line 1, a changed one\'s at its first change, each path once', async () => {
    await open('files', { still: true });
    await sleep(700);
    await click('#dram'); await sleep(700);
    await click('#gitGraph .gr[data-id="work:f1"]'); await sleep(900);
    const lines = await b.ev(`[...document.querySelectorAll('#gitDetail .dopen')].map(x => x.textContent + ' → ' + x.dataset.line)`);
    const btn = await b.ev(`(() => { const b = [...document.querySelectorAll('#gitDetail .dopen')].find(x => x.textContent === 'src/invoices/batch.ts'); if (!b) return null; b.click(); return b.dataset.line; })()`);
    await sleep(900);
    const st = await fv();
    const marked = await b.ev(`[...document.querySelectorAll('#fvRows .fv-row.fresh .no')].map(n => n.textContent).join(',')`);
    const gold = await b.ev(`[document.querySelectorAll('#fvRows .fv-row.chg').length, document.querySelectorAll('#fvRows .fv-row').length]`);
    check(FV + 'on the git screen, a new file\'s path opens it at line 1, a changed one\'s at its first change, each path once',
      JSON.stringify(lines) === JSON.stringify(['src/invoices/export.ts → 2', 'src/invoices/query.ts → 5', 'src/invoices/batch.ts → 1', 'migrations/0042_invoice_lookup_index.sql → 1', 'test/invoices/large-account.test.ts → 1'])
      && btn === '1' && /batch\.ts$/.test(st.title) && marked === '1' && gold[0] === gold[1] && gold[0] > 10,
      `${JSON.stringify(lines)}; opened "${st.title}" marked ${marked}, gold ${gold[0]} of ${gold[1]}`);
    await b.key('Escape'); await sleep(400);
  });

  await run(FV + '⌘P from inside a menu the sheet closes: after Esc the keyboard lands on something that shows', async () => {
    await open('files', { still: true });
    await sleep(700);
    await b.ev(`document.getElementById('brand').click(), 1`); await sleep(300);
    await b.ev(`document.querySelector('#look input[name="theme"]:checked')?.focus(), 1`); await sleep(100);
    const inLook = await b.ev(`!!document.activeElement.closest('#look')`);
    await b.key('p', { meta: true }); await sleep(500);
    await b.key('Escape'); await sleep(500);
    const where = await b.ev(`(() => { const a = document.activeElement; return { id: a ? a.id : '', body: a === document.body, shows: !!a && a.getClientRects().length > 0 && !a.closest('[hidden], [inert]') }; })()`);
    check(FV + '⌘P from inside a menu the sheet closes: after Esc the keyboard lands on something that shows', inLook && !where.body && where.shows, JSON.stringify(where));
  });

  await run(FV + '⌘S outside the editor is kept from the browser, and ⌘P while the sheet closes brings it back', async () => {
    await open('files');
    await sleep(900);
    await b.ev(`document.getElementById('filesChip').click(), 1`); await sleep(700);
    const prevented = await b.ev(`(() => { const e = new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: !navigator.platform.startsWith('Mac'), bubbles: true, cancelable: true }); document.getElementById('fvFind').dispatchEvent(e); return e.defaultPrevented; })()`);
    // the sheet must never have closed in between (a ⌘P that came after the close would open it anew)
    await b.ev(`(window.__closes = 0, document.getElementById('fileSheet').addEventListener('close', () => { window.__closes++; }), 1)`);
    await b.key('Escape'); await sleep(90);
    const going = await b.ev(`document.getElementById('fileSheet').open && !document.documentElement.dataset.files`);
    await b.key('p', { meta: true }); await sleep(700);
    const st = await fv();
    const dim = await b.ev(`document.documentElement.dataset.files || ''`);
    const anims = await b.ev(`document.getAnimations().filter(a => a.playState === 'running').length`);
    const closes = await b.ev(`window.__closes`);
    check(FV + '⌘S outside the editor is kept from the browser, and ⌘P while the sheet closes brings it back',
      prevented && going && closes === 0 && st.open && st.focus === 'fvFind' && st.list && dim === 'open' && anims === 0, JSON.stringify({ prevented, going, closes, open: st.open, focus: st.focus, dim, anims }));
  });

  await run(FV + 'the keyboard\'s gold line on the page is drawn over the rows, and black-gold\'s page has no frame of its own inside the gold one', async () => {
    await open('files', { still: true, theme: 'black-gold' });
    await sleep(700);
    await b.key('p', { meta: true }); await sleep(300);
    await keysIn('export.ts'); await b.key('Enter'); await sleep(800);
    await click('#fvWhose [data-fv="switch"]'); await sleep(800);
    await b.ev(`document.getElementById('fvFind').focus(), 1`);
    await b.key('Tab', { shift: true }); await sleep(100);   // the keyboard to the page, as a person moves it
    const line = await b.ev(`(() => { const body = document.getElementById('fvBody'), cs = getComputedStyle(body, '::after'), x = getComputedStyle(body);
      return { focus: document.activeElement.id, op: cs.opacity, z: cs.zIndex, h: cs.height, sides: x.borderLeftWidth + ' ' + x.borderRightWidth, tops: x.borderTopWidth }; })()`);
    check(FV + 'the keyboard\'s gold line on the page is drawn over the rows, and black-gold\'s page has no frame of its own inside the gold one',
      line.focus === 'fvCode' && line.op === '1' && +line.z > 1 && line.h === '2px' && line.sides === '0px 0px' && line.tops === '1px', JSON.stringify(line));
  });

  if (errors.length) for (const e of [...new Set(errors)]) check('no script errors', false, e);
  else check('no script errors', true);
} finally {
  allPosts.push(...(await posts()));
  await b.close();
  await mock.close();
}

if (args.includes('--log') || !only) {
  console.log('\nEvery request the page sent (method, path, body):');
  const seen = new Set();
  // Agents & keys: a key's values (value, token, and each of values) are never printed, even these fake ones
  const hidden = body => (body && typeof body === 'object' ? { ...body, ...('value' in body ? { value: '••••' } : {}), ...('token' in body ? { token: '••••' } : {}),
    ...(body.values && typeof body.values === 'object' ? { values: Object.fromEntries(Object.keys(body.values).map(k => [k, '••••'])) } : {}) } : body);
  for (const p of allPosts) {
    const shape = `${p.method} ${p.path.replace(/\/api\/agents\/[^/]+\//, '/api/agents/:id/').replace(/\/api\/confirm\/[^/]+/, '/api/confirm/:id').replace(/\/api\/machines\/[^/]+\//, '/api/machines/:id/')} ${JSON.stringify(Object.keys(p.body || {}).sort())} ${p.body && 'go' in p.body ? p.body.go : ''} ${p.body && p.body.confirmId ? 'confirm' : ''}`;
    if (seen.has(shape)) continue;
    seen.add(shape);
    // a file's text is shown by its length: a save can carry a whole file
    const shown = p.path === '/api/file' && p.body && typeof p.body.text === 'string' ? { ...p.body, text: `(${p.body.text.length} characters)` } : p.body;
    console.log(`  ${p.method} ${p.path} ${JSON.stringify(p.path.startsWith('/api/connect') ? hidden(shown) : shown)}`);
  }
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed.`);
process.exit(failed ? 1 : 0);
