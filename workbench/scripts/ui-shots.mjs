// The screenshots in docs/screens/: the board at 1440×900, at 2×, against the mock API (scripts/ui-mock.mjs), with
// motion stopped (still=1). Not part of npm test (it needs Chrome).
//   node scripts/ui-shots.mjs [folder] [--only <name start>]      (default: docs/screens; --only files takes files-*)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './ui-mock.mjs';
import { launch, sleep, errorsOf } from './ui-cdp.mjs';

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only'), only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const folder = argv.filter((x, i) => !x.startsWith('--') && !(onlyAt >= 0 && i === onlyAt + 1))[0];
const out = path.resolve(folder || fileURLToPath(new URL('../docs/screens', import.meta.url)));
mkdirSync(out, { recursive: true });
const SHOTS = [
  { name: 'board-overview', scenario: 'demo' },
  { name: 'board-helper-asks', scenario: 'helper' },
  { name: 'board-card', scenario: 'demo', query: '&pin=902d13' },
  { name: 'board-busy', scenario: 'busy' },
  { name: 'board-many', scenario: 'many' },
  { name: 'board-idle', scenario: 'idle' },
  { name: 'board-exact-command', scenario: 'longcmd' },
  { name: 'board-long-question', scenario: 'longq' },
  { name: 'board-launch-question', scenario: 'demo', type: 'start an agent to fix the flaky checkout test' },
  { name: 'board-black-gold', scenario: 'demo', theme: 'black-gold' },
  { name: 'board-ivory', scenario: 'demo', theme: 'ivory' },
  { name: 'board-more-detail', scenario: 'demo', detail: 'more' },
  // D2: an agent's work in the lid (merge, review, what became of it), and the engine's cards for it
  { name: 'merge-lid', scenario: 'merge' },
  { name: 'merge-card', scenario: 'merge', query: '&focus=m1a2b3', type: 'merge it' },
  { name: 'merge-throw-away-card', scenario: 'merge', query: '&focus=m1a2b3', type: 'throw it away' },
  { name: 'merge-conflict', scenario: 'merge', query: '&focus=m7e8f9' },
  { name: 'merge-blocked', scenario: 'merge', query: '&focus=mab0c1' },
  { name: 'merge-merged', scenario: 'merge', query: '&focus=m4c5d6', detail: 'more' },
  { name: 'merge-failed-check', scenario: 'merge-more', query: '&focus=n1', theme: 'black-gold' },
  { name: 'merge-long-branch', scenario: 'merge-more', query: '&focus=n2', theme: 'ivory', detail: 'more' },
  { name: 'merge-not-on-a-branch', scenario: 'merge-detached' },
  // a Claude Code agent stopped at its spending limit: one more limit for this run, in place of "Try again"
  { name: 'limit-lid', scenario: 'limit' },
  { name: 'limit-lid-black-gold', scenario: 'limit', theme: 'black-gold', detail: 'more' },
  // D1: the git screen, reached by clicking the DRAM (`click`: selectors clicked in turn after the page loads)
  { name: 'git-screen', scenario: 'git', click: ['#dram'] },
  { name: 'git-detail', scenario: 'git', click: ['#dram', '#gitGraph .gr[data-id="work:g1"]'] },
  { name: 'git-black-gold', scenario: 'git-many', theme: 'black-gold', click: ['#dram', '#gitGraph .gr[data-id="work:m5"]'] },
  { name: 'git-ivory', scenario: 'git', theme: 'ivory', detail: 'more', click: ['#dram', '#gitGraph .gr:not(.work)'] },
  // the file view, reached by the files chip and its field (`steps`: 'chip', 'find:<text>' then 'enter', a selector
  // clicked, 'type:<text>' into the editor, 'disk:<path>' for a change an agent writes, 'needs:<agent id>' for a
  // question from that agent, which lights the sheet's pill, 'wait:<ms>')
  { name: 'files-sheet', scenario: 'files', steps: ['chip', 'find:export.ts', 'enter', '#fvWhose [data-fv="switch"]'] },
  { name: 'files-finder', scenario: 'files', steps: ['chip', 'find:invoice', 'wait:700'] },
  { name: 'files-editor', scenario: 'files', steps: ['chip', 'find:export.ts', 'enter', '#fvWhose [data-fv="switch"]', '#fvActs [data-fv="edit"]', 'type:// read a page at a time\n'] },
  { name: 'files-conflict', scenario: 'files', steps: ['chip', 'find:query.ts', 'enter', '#fvActs [data-fv="edit"]', 'type:// mine\n', 'disk:src/invoices/query.ts', '#fvActs [data-fv="save"]'] },
  { name: 'files-folder', scenario: 'files', detail: 'more', steps: ['chip', 'find:export.ts', 'enter', '#fvTitle [data-dir="src"]'] },
  { name: 'files-black-gold', scenario: 'files', theme: 'black-gold', steps: ['chip', 'find:export.ts', 'enter', '#fvWhose [data-fv="switch"]'] },
  { name: 'files-ivory', scenario: 'files', theme: 'ivory', steps: ['chip', 'find:cart.ts', 'enter'] },
  { name: 'files-needs-you', scenario: 'files', steps: ['chip', 'needs:f2', 'find:.env', 'enter'] },
  { name: 'files-finder-over-editor', scenario: 'files', theme: 'black-gold', steps: ['chip', 'find:export.ts', 'enter', '#fvActs [data-fv="edit"]', 'type:// a note\n', 'find:que', 'wait:400'] },
];

const mock = await startMock({ quiet: true });
const base = `http://127.0.0.1:${mock.port}`;
const b = await launch({ width: 1440, height: 900, dpr: 2 });
const errors = errorsOf(b, /status of 401|favicon|status of 409 \(Conflict\) \S+\/api\/file\b/);   // the conflict shot's save is a 409, on purpose
/** The file view's steps, as a person takes them. */
async function step(x) {
  const [op, ...rest] = x.split(':'), arg = rest.join(':');
  if (x === 'chip') { await b.ev(`(document.getElementById('filesChip').click(), 1)`); await sleep(800); return; }
  if (x === 'enter') { await b.key('Enter'); await sleep(900); return; }
  if (op === 'find') { await b.ev(`(() => { const i = document.getElementById('fvFind'); i.focus(); i.value = ${JSON.stringify(arg)}; i.dispatchEvent(new Event('input')); return 1; })()`); await sleep(500); return; }
  if (op === 'type') { await b.ev(`(() => { const t = document.getElementById('fvText'); t.focus(); t.setSelectionRange(0, 0); document.execCommand('insertText', false, ${JSON.stringify(arg.replace(/\\n/g, '\n'))}); return 1; })()`); await sleep(300); return; }
  if (op === 'disk') {
    const r = await (await fetch(`${base}/api/file?in=you&path=${encodeURIComponent(arg)}`, { headers: { 'X-Workbench-Token': 'k' } })).json();
    await fetch(`${base}/ctl/files`, { method: 'POST', body: JSON.stringify({ in: 'you', path: arg, text: `// a change on disk\n${r.text}` }) });
    await sleep(200); return;
  }
  if (op === 'needs') {
    const st = await (await fetch(`${base}/ctl/state`)).json();
    const a = st.agents.find(x => x.id === arg);
    const ask = { id: `shot-${arg}`, type: 'permission', sentence: `${a.name} wants to run a command`, detail: 'npm run db:migrate', options: ['Allow', 'Deny'], createdAt: Date.now() };
    await fetch(`${base}/ctl/push`, { method: 'POST', body: JSON.stringify({ event: 'agents', data: [{ ...a, state: 'needs_ok', ask }] }) });
    await sleep(600); return;
  }
  if (op === 'wait') { await sleep(Number(arg)); return; }
  await b.ev(`(document.querySelector(${JSON.stringify(x)})?.click(), 1)`); await sleep(900);
}

try {
  for (const s of SHOTS) {
    if (only && !s.name.startsWith(only)) continue;
    await fetch(`${base}/ctl/scenario`, { method: 'POST', body: JSON.stringify({ name: s.scenario, push: false }) });
    await b.goto(`${base}/?t=k`, 400);
    // the look and detail as Workbench keeps them (the page arrives with them on <html>); the hint not seen yet
    await fetch(`${base}/ctl/prefs`, { method: 'POST', body: JSON.stringify({ theme: s.theme || 'green', detail: s.detail || 'calm', answered: false }) });
    await b.ev(`(() => { sessionStorage.clear(); return 1; })()`);
    await b.goto(`${base}/?t=k&still=1${s.query || ''}`, 1800);
    if (s.type) {
      await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = ${JSON.stringify(s.type)}; i.dispatchEvent(new Event('input')); document.getElementById('bar').requestSubmit(); return 1; })()`);
      await sleep(1200);
      await b.ev(`document.activeElement.blur(), 1`);
    }
    for (const sel of s.click || []) { await b.ev(`(document.querySelector(${JSON.stringify(sel)})?.click(), 1)`); await sleep(900); }
    for (const x of s.steps || []) await step(x);
    await sleep(300);
    const file = path.join(out, s.name + '.png');
    await b.shot(file);
    console.log('wrote', path.relative(process.cwd(), file));
  }
} finally {
  await b.close();
  await mock.close();
}
if (errors.length) { console.log('Script errors:\n  ' + [...new Set(errors)].join('\n  ')); process.exit(1); }
