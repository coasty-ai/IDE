// One real acceptance run of Workbench with Claude Code. IT SPENDS REAL MONEY: at most $0.50 (the --budget it
// passes) on the account the `claude` command is logged in to, with the haiku model.
//
//   node scripts/accept-real.mjs <throwaway git repo> [screenshots folder] [--keep]
//
// The repository needs a committed workbench.json with a check and a rule, for example:
//   { "checks": [{ "name": "tests", "run": "node test.mjs" }], "rules": [{ "say": "Do not change greet.js", "paths": ["greet.js"] }]
// It drives the product only through its HTTP API, as the page does, and prints PASS or FAIL for each point:
//   a helper appears -> the agent's `touch agent-was-here.txt` waits for an OK -> Allow releases it ->
//   the agent ends "done and checked" with one new file and the rule kept -> after stopping, nothing is left running.
// Asks are answered one by one: the touch, and read-only listing commands from a helper, are allowed; anything
// else is refused and reported. The agent's worktree is removed at the end unless --keep is given.
// Dry run without spending: WORKBENCH_CLAUDE_BIN=test/helpers/claude-fake.mjs FAKE_CLAUDE_FIXTURE=claude-subagent-run.jsonl
//   FAKE_CLAUDE_HOOKS=1 FAKE_CLAUDE_ROOT_BASH='touch agent-was-here.txt' node scripts/accept-real.mjs <repo>
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, rmdirSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const [repoArg, shotsArg] = argv.filter((a) => a !== '--keep');
if (!repoArg) { console.error('Usage: node scripts/accept-real.mjs <throwaway git repo> [screenshots folder] [--keep]'); process.exit(2); }
const repo = realpathSync(repoArg);
const shots = shotsArg ? path.resolve(shotsArg) : null;
if (shots) mkdirSync(shots, { recursive: true });

const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MARKER = 'agent-was-here.txt';
const BUDGET = 0.5;
const TASK = 'Use the Agent tool to launch one Explore helper that lists the files in this repository and says what greet.js does. '
  + `When it has finished, run the shell command \`touch ${MARKER}\` with Bash. Then finish with one short sentence.`;
const HELPER_READ_ONLY = /^(find|ls|cat|head|tail|tree|wc|grep|rg|file|stat|git (ls-files|status|log|show))\b[^;&`$<>]*$/;

const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); log(ok ? 'PASS' : 'FAIL', name, detail ? `(${detail})` : ''); };
/** Processes whose command line holds this text. No shell: pgrep leaves itself out. */
const processesWith = (text) => { try { return execFileSync('pgrep', ['-f', text]).toString().trim().split('\n').filter(Boolean); } catch { return []; } };

const eng = spawn(process.execPath, [BIN, '--repo', repo, '--no-open', '--port', '0', '--budget', String(BUDGET), '--model', 'haiku'], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let url = null;
eng.stdout.on('data', (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(out); if (m && !url) url = { base: m[1], t: m[2] }; });
eng.stderr.on('data', (d) => { out += d; });
const engExit = new Promise((r) => eng.on('exit', (code, signal) => r({ code, signal })));
for (let i = 0; i < 100 && !url; i++) await sleep(200);
if (!url) { console.error('Workbench did not start:\n' + out); eng.kill('SIGINT'); process.exit(1); }
log('Workbench is running.', out.split('\n').filter((l) => /ready|spend/.test(l)).join(' | '));

const H = { 'Content-Type': 'application/json', 'X-Workbench-Token': url.t };
const post = async (p, b) => { const r = await fetch(url.base + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const agents = async () => (await (await fetch(url.base + '/api/state', { headers: H })).json()).agents;
const userData = mkdtempSync(path.join(tmpdir(), 'wb-chrome-'));
const shot = (name, query) => {
  if (!shots) return;
  try {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${userData}`, '--window-size=1440,900', '--force-device-scale-factor=2', '--virtual-time-budget=3000', `--screenshot=${path.join(shots, name + '.png')}`, `${url.base}/?t=${url.t}&static=1&still=1${query || ''}`], { stdio: 'ignore', timeout: 60_000 });
    log('screenshot', name + '.png');
  } catch (err) { log('screenshot failed:', name, err.message); }
};

const asked = await post('/api/command', { text: 'start an agent to ' + TASK });
if (!asked.body?.confirm) { console.error('No confirm came back:', JSON.stringify(asked.body)); eng.kill('SIGINT'); process.exit(1); }
const go = await post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
const rootId = go.body?.agentIds?.[0];
if (!rootId) { console.error('The agent did not start:', JSON.stringify(go.body)); eng.kill('SIGINT'); process.exit(1); }
log('Started:', go.body.reply);

const answered = new Set();
let sawHelper = false, shotHelper = false, touchHeld = false, touchAbsentWhileHeld = false, refused = 0;
let sessionId = null, workspace = null, last = '', final = null;
while (Date.now() - t0 < 300_000) {
  await sleep(1000);
  const all = await agents();
  const root = all.find((a) => a.id === rootId);
  if (!root) continue;
  sessionId = root.sessionId || sessionId;
  workspace = root.workspace || workspace;
  const line = all.map((a) => `${a.parentId ? '└ ' : ''}${a.name} [${a.state}] ${a.now || ''}`).join(' | ');
  if (line !== last) { log(line); last = line; }
  const helper = all.find((a) => a.parentId === rootId);
  if (helper && !sawHelper) { sawHelper = true; log('A helper appeared:', helper.name, `(${helper.helperType || 'helper'})`); }
  if (helper && helper.state === 'working' && !shotHelper) { shotHelper = true; shot('real-helper-working', '&pin=' + helper.id); }

  for (const a of all) {
    if (!a.ask || answered.has(a.ask.id) || a.rootId !== rootId) continue;
    answered.add(a.ask.id);
    log(`ASK (${a.ask.type}) from ${a.parentId ? 'the helper' : 'the agent'}: ${a.ask.sentence} | ${a.ask.detail || ''}`);
    let answer;
    if (a.ask.type === 'permission') {
      const detail = String(a.ask.detail || '').trim();
      if (!a.parentId && detail === `touch ${MARKER}`) {
        touchHeld = true;
        touchAbsentWhileHeld = !!workspace && !existsSync(path.join(workspace, MARKER));
        shot('real-needs-ok', '&pin=' + a.id);
        answer = 'Allow';
      } else if (a.parentId && HELPER_READ_ONLY.test(detail)) {
        answer = 'Allow';
      } else { answer = 'Deny'; refused++; }
    } else if (a.ask.type === 'question') {
      answer = 'Please carry on with the task as written.';
    } else {
      answer = 'Stop it';
    }
    const r = await post(`/api/agents/${a.id}/answer`, { askId: a.ask.id, answer });
    log(`  answered "${answer}":`, r.status, r.body?.reply || '');
  }

  if (['done_checked', 'done_claimed', 'checks_failed', 'failed', 'stopped'].includes(root.state) && !all.some((a) => a.rootId === rootId && a.ask)) {
    final = root;
    shot('real-done', '&pin=' + root.id);
    break;
  }
}

const running = sessionId ? processesWith(sessionId) : [];
log('Claude Code processes for this agent before stopping:', running.length ? running.join(' ') : 'none');
eng.kill('SIGINT');
const exit = await Promise.race([engExit, sleep(20_000).then(() => null)]);
await sleep(1000);
const left = sessionId ? processesWith(sessionId) : ['(no session id was seen)'];

console.log('');
if (!final) log('The agent did not finish within 5 minutes.');
else log('FINAL', final.state, '| says:', final.says, '| files:', JSON.stringify(final.files && { changed: final.files.changed, list: final.files.list?.map((f) => f.path) }), '| checks:', JSON.stringify(final.checks), '| rules:', JSON.stringify(final.rules), '| approvals:', JSON.stringify(final.approvals), '| cost: $' + final.usage?.costUsd);
check('a helper appeared in the tree', sawHelper);
check(`\`touch ${MARKER}\` waited for an OK`, touchHeld && touchAbsentWhileHeld, touchHeld ? (touchAbsentWhileHeld ? 'and had not run' : 'but the file already existed') : 'never asked');
check('Allow released it', touchHeld && workspace && existsSync(path.join(workspace, MARKER)));
check('the agent ended done and checked', final?.state === 'done_checked', final?.state || 'not finished');
check('the receipt shows exactly that one new file', final?.files?.changed === 1 && final.files.list?.[0]?.path === MARKER, JSON.stringify(final?.files?.list?.map((f) => f.path)));
check('the rule was kept', final?.rules && Array.isArray(final.rules.broken) && final.rules.broken.length === 0, JSON.stringify(final?.rules));
check(`it stayed within the $${BUDGET} limit`, final?.usage?.costUsd != null && final.usage.costUsd <= BUDGET, final?.usage?.costUsd != null ? '$' + final.usage.costUsd.toFixed(4) : 'unknown');
check('nothing else needed an answer', refused === 0, refused ? `${refused} refused` : '');
check('Workbench stopped cleanly', exit && exit.code === 0, JSON.stringify(exit));
check('no Claude Code process was left running', left.length === 0, left.join(' '));

if (!keep && workspace) {
  try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', workspace], { stdio: 'ignore' }); } catch { /* already gone */ }
  try { execFileSync('git', ['-C', repo, 'worktree', 'prune'], { stdio: 'ignore' }); } catch { /* ignore */ }
  // Remove the folders Workbench made for it, only if nothing else is in them.
  for (let d = path.dirname(workspace); d.startsWith(path.join(homedir(), '.workbench')); d = path.dirname(d)) {
    try { rmdirSync(d); } catch { break; }
  }
}
rmSync(userData, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed.`);
process.exit(failed ? 1 : 0);
