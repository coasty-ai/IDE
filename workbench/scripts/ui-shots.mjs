// The screenshots in docs/screens/: the board at 1440×900, at 2×, against the mock API (scripts/ui-mock.mjs), with
// motion stopped (still=1). Not part of npm test (it needs Chrome).
//   node scripts/ui-shots.mjs [folder]      (default: docs/screens)
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './ui-mock.mjs';
import { launch, sleep, errorsOf } from './ui-cdp.mjs';

const out = path.resolve(process.argv[2] || fileURLToPath(new URL('../docs/screens', import.meta.url)));
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
  // D1: the git screen, reached by clicking the DRAM (`click`: selectors clicked in turn after the page loads)
  { name: 'git-screen', scenario: 'git', click: ['#dram'] },
  { name: 'git-detail', scenario: 'git', click: ['#dram', '#gitGraph .gr[data-id="work:g1"]'] },
  { name: 'git-black-gold', scenario: 'git-many', theme: 'black-gold', click: ['#dram', '#gitGraph .gr[data-id="work:m5"]'] },
  { name: 'git-ivory', scenario: 'git', theme: 'ivory', detail: 'more', click: ['#dram', '#gitGraph .gr:not(.work)'] },
];

const mock = await startMock({ quiet: true });
const base = `http://127.0.0.1:${mock.port}`;
const b = await launch({ width: 1440, height: 900, dpr: 2 });
const errors = errorsOf(b);
try {
  for (const s of SHOTS) {
    await fetch(`${base}/ctl/scenario`, { method: 'POST', body: JSON.stringify({ name: s.scenario, push: false }) });
    await b.goto(`${base}/?t=k`, 400);
    await b.ev(`(() => { localStorage.setItem('wb-theme', ${JSON.stringify(s.theme || 'green')}); localStorage.setItem('wb-detail', ${JSON.stringify(s.detail || 'calm')}); localStorage.removeItem('wb-answered'); sessionStorage.clear(); return 1; })()`);
    await b.goto(`${base}/?t=k&still=1${s.query || ''}`, 1800);
    if (s.type) {
      await b.ev(`(() => { const i = document.getElementById('say'); i.focus(); i.value = ${JSON.stringify(s.type)}; i.dispatchEvent(new Event('input')); document.getElementById('bar').requestSubmit(); return 1; })()`);
      await sleep(1200);
      await b.ev(`document.activeElement.blur(), 1`);
    }
    for (const sel of s.click || []) { await b.ev(`(document.querySelector(${JSON.stringify(sel)})?.click(), 1)`); await sleep(900); }
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
