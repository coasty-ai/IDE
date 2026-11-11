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
