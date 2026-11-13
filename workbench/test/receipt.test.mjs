import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchGlob, checkRules, runChecks, scrubEnv, killChecksSync, withNodeOnPath, withKeys } from '../src/core/receipt.mjs';

let T;
before(() => { T = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-receipt-')); });
after(() => fs.rmSync(T, { recursive: true, force: true }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function goneWithin(pid, ms) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

// [glob, path, matches?]  Paths are relative to the repository root.
const GLOBS = [
  ['src/**/*.js', 'src/a.js', true], // ** can be no folders at all
  ['src/**/*.js', 'src/x/y/a.js', true],
  ['src/**/*.js', 'src/a.ts', false],
  ['src/**/*.js', 'lib/src/a.js', false], // anchored at the root
  ['*.md', 'README.md', true],
  ['*.md', 'docs/a.md', false], // * stays inside one folder name
  ['**/*.md', 'docs/a.md', true],
  ['**/*.md', 'README.md', true],
  ['docs/**', 'docs/a/b/c.txt', true],
  ['docs/**', 'docsx/a.txt', false],
  ['docs/', 'docs/a.md', true], // a trailing slash means everything inside
  ['db/migrations/**', 'db/migrations/001.sql', true],
  ['db/migrations/**', 'db/seed.sql', false],
  ['a?c.txt', 'abc.txt', true],
  ['a?c.txt', 'ac.txt', false],
  ['a?c.txt', 'a/c.txt', false], // ? never matches a slash
  ['src/*/index.js', 'src/a/index.js', true],
  ['src/*/index.js', 'src/a/b/index.js', false],
  ['src/**/test/**', 'src/a/test/b/c.js', true],
  ['**', 'anything/at/all', true],
  ['./src/*.js', 'src/a.js', true],
  ['/package.json', 'package.json', true],
  ['package.json', 'packages/x/package.json', false],
  ['.env*', '.env.local', true],
  ['*.lock', 'yarn.lock', true],
  ['src/*.js', 'src\\a.js', true], // backslashes count as slashes
  ['src/*.js', './src//a.js', true],
  ['[abc].js', '[abc].js', true], // only **, * and ? are special
  ['[abc].js', 'a.js', false],
  ['', 'a.js', false],
  ['   ', 'a.js', false],
];

test('matchGlob handles **, * and ?', () => {
  const wrong = GLOBS.filter(([g, p, want]) => matchGlob(g, p) !== want).map(([g, p, want]) => `${g} vs ${p}: expected ${want}`);
  assert.deepEqual(wrong, []);
  assert.equal(matchGlob(null, 'a'), false);
  assert.equal(matchGlob('a', undefined), false);
});

test('matchGlob stays fast on hostile patterns', () => {
  const t0 = Date.now();
  assert.equal(matchGlob('a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
  assert.equal(matchGlob('**/**/**/**/**/**/x', 'a/'.repeat(300) + 'y'), false);
  assert.equal(matchGlob('**/**/**/x', 'a/'.repeat(300) + 'x'), true);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('checkRules sorts rules into kept and broken', () => {
  const rules = [
    { say: 'Leave the migrations alone', paths: ['db/migrations/**'] },
    { say: 'Do not touch the lock file', paths: ['package-lock.json'] },
    { say: 'Docs are edited by hand', paths: ['docs/**', '*.md'] },
  ];
  const changed = ['src/a.js', 'db/migrations/002.sql', './README.md', 'docs/guide/intro.md', { path: 'db/migrations/003.sql' }];
  assert.deepEqual(checkRules(rules, changed), {
    kept: [{ say: 'Do not touch the lock file' }],
    broken: [
      { say: 'Leave the migrations alone', paths: ['db/migrations/002.sql', 'db/migrations/003.sql'] },
      { say: 'Docs are edited by hand', paths: ['README.md', 'docs/guide/intro.md'] },
    ],
  });
  assert.deepEqual(checkRules(rules, []), { kept: rules.map(r => ({ say: r.say })), broken: [] });
  assert.deepEqual(checkRules(undefined, ['a']), { kept: [], broken: [] });
  assert.deepEqual(checkRules([null, { say: 'x' }, { paths: ['a'] }, { say: 'A string path', paths: 'a.txt' }], ['a.txt', null, 7]),
    { kept: [{ say: 'x' }], broken: [{ say: 'A string path', paths: ['a.txt'] }] });
});

test('runChecks with nothing declared', async () => {
  assert.deepEqual(await runChecks({ cwd: T, checks: [] }), { state: 'none', results: [] });
  assert.deepEqual(await runChecks({ cwd: T }), { state: 'none', results: [] });
  assert.deepEqual(await runChecks({ cwd: T, checks: [{ name: 'empty', run: '  ' }, null] }), { state: 'none', results: [] });
});

test('runChecks passes and fails, in the folder, with progress', async () => {
  const seen = [];
  const out = await runChecks({
    cwd: T,
    checks: [
      { name: 'Says hello', run: 'echo hello; echo world >&2' },
      { name: 'Where am I', run: 'pwd' },
      { name: 'Breaks', run: 'echo broken; exit 3' },
      { run: 'true' },
    ],
    onProgress: p => seen.push(`${p.phase} ${p.index}/${p.total} ${p.name} ${p.results.length}${p.result ? ' ' + p.result.ok : ''}`),
  });
  assert.equal(out.state, 'failed');
  assert.deepEqual(out.results.map(r => [r.name, r.ok]), [['Says hello', true], ['Where am I', true], ['Breaks', false], ['true', true]]);
  assert.match(out.results[0].tail, /hello/);
  assert.match(out.results[0].tail, /world/); // stdout and stderr together
  assert.equal(out.results[1].tail, fs.realpathSync.native(T));
  assert.equal(out.results[2].exitCode, 3);
  assert.equal(out.results[2].tail, 'broken');
  for (const r of out.results) assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
  assert.deepEqual(seen, [
    'start 0/4 Says hello 0', 'end 0/4 Says hello 1 true',
    'start 1/4 Where am I 1', 'end 1/4 Where am I 2 true',
    'start 2/4 Breaks 2', 'end 2/4 Breaks 3 false',
    'start 3/4 true 3', 'end 3/4 true 4 true',
  ]);
  const good = await runChecks({ cwd: T, checks: [{ name: 'ok', run: 'exit 0' }], onProgress: () => { throw new Error('a broken listener'); } });
  assert.equal(good.state, 'passed');
});

test('runChecks scrubs the environment', async () => {
  const keys = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'WORKBENCH_HOOK_TOKEN', 'KEEP_ME'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_SDK_VERSION: '9', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', WORKBENCH_HOOK_TOKEN: 'secret', KEEP_ME: 'yes' });
  try {
    const run = 'echo "' + keys.map(k => `${k}=\${${k}-unset}`).join(' ') + '"';
    const out = await runChecks({ cwd: T, checks: [{ name: 'env', run }] });
    assert.equal(out.results[0].tail, 'CLAUDECODE=unset CLAUDE_CODE_ENTRYPOINT=unset CLAUDE_AGENT_SDK_VERSION=unset CLAUDE_PID=unset CLAUDE_EFFORT=unset WORKBENCH_HOOK_TOKEN=unset KEEP_ME=yes');
    // An explicit environment is scrubbed the same way.
    const own = await runChecks({ cwd: T, env: { PATH: process.env.PATH, CLAUDECODE: '1', MINE: 'x' }, checks: [{ name: 'env', run: 'echo "${CLAUDECODE-unset} ${MINE-unset} ${KEEP_ME-unset}"' }] });
    assert.equal(own.results[0].tail, 'unset x unset');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.deepEqual(scrubEnv({ CLAUDECODE: '1', CLAUDE_CODE_X: '2', CLAUDE_CONFIG_DIR: 'kept', HOME: '/h' }), { CLAUDE_CONFIG_DIR: 'kept', HOME: '/h' });
});

test('the person’s keys reach the checks after the scrub, and never replace WORKBENCH_AGENT_ID', async () => {
  const keysEnv = { WB_TEST_SETTING: 'from-the-key-store', CLAUDECODE: '1', WORKBENCH_AGENT_ID: 'not-the-agent', NOT_TEXT: 42 };
  const out = await runChecks({
    cwd: T, env: { PATH: process.env.PATH, WORKBENCH_AGENT_ID: 'abc123' }, keysEnv,
    checks: [{ name: 'env', run: 'echo "${WB_TEST_SETTING-unset} ${CLAUDECODE-unset} ${WORKBENCH_AGENT_ID-unset} ${NOT_TEXT-unset}"' }],
  });
  assert.equal(out.results[0].tail, 'from-the-key-store unset abc123 unset');
  // The rule itself: names that are not variable names, Workbench's own, what the scrub removes, and values that are
  // not text or hold a NUL stay out; the environment comes back as it is when there is nothing to add.
  const base = { A: '1' };
  assert.equal(withKeys(base, null), base);
  assert.equal(withKeys(base, {}), base);
  assert.deepEqual(withKeys(base, { A: '2', B: 'x\u0000y', 'C D': 'x', '9E': 'x', WORKBENCH_HOOK_URL: 'u', CLAUDE_CODE_X: 'x', WORKBENCH_HOOK_TOKEN: 't' }), { A: '2' });
  assert.deepEqual(base, { A: '1' }, 'never changed in place');
});

test('with a mask, a key a check prints is hidden in its tail, also where the tail is cut', async () => {
  // A made-up value, built here, long (keys may have up to 2000 characters): only its last four characters may show.
  const value = ['fake', 'stored', 'value', 'q'.repeat(1500), 'Z9W8'].join('-');
  const mask = (s) => s.split(value).join('•••• Z9W8');
  const keysEnv = { WB_TEST_VALUE: value };
  // Filler after the value, so that the last 2048 bytes begin 20 characters before the end of the value.
  const cut = { name: 'cut', run: `printf '%s' "$WB_TEST_VALUE"; i=0; while [ $i -lt 2028 ]; do printf _; i=$((i+1)); done` };
  // Far more output than is kept, the value all through it, on one line: what is kept begins inside a value, and so
  // little is left once the whole ones are masked that the cut one would show.
  const lots = { name: 'lots', run: 'i=0; while [ $i -lt 200 ]; do printf "%s_" "$WB_TEST_VALUE"; i=$((i+1)); done' };
  const plain = { name: 'plain', run: 'echo "the key is $WB_TEST_VALUE."' };

  const without = await runChecks({ cwd: T, keysEnv, checks: [cut] });
  assert.match(without.results[0].tail, /q-Z9W8_/, 'without a mask the cut falls inside the value');

  const out = await runChecks({ cwd: T, keysEnv, mask, checks: [cut, lots, plain] });
  const [c, l, p] = out.results.map(r => r.tail);
  assert.equal(p, 'the key is •••• Z9W8.');
  assert.ok(Buffer.byteLength(c) <= 2048 && Buffer.byteLength(l) <= 2048);
  assert.match(c, /^•••• Z9W8_+$/);
  // Only placeholders and filler: no part of the value but its last four characters.
  assert.doesNotMatch(l, /[^•\sZ9W8_]/);
  assert.match(l, /(•••• Z9W8_){3}$/, 'whole placeholders');
  // A mask that fails hides nothing but breaks nothing.
  const broken = await runChecks({ cwd: T, mask: () => { throw new Error('no'); }, checks: [{ name: 'x', run: 'echo fine' }] });
  assert.equal(broken.results[0].tail, 'fine');
});

test('checks find node even when the PATH has none, and keep a PATH that has one as it is', async () => {
  const nodeDir = path.dirname(process.execPath);
  const empty = fs.mkdtempSync(path.join(T, 'no-node-'));
  // As for a person whose own PATH lacks node: a check such as `npm test` must still find node (and npm beside it).
  const bare = await runChecks({ cwd: T, env: { PATH: empty, HOME: T }, checks: [{ name: 'node', run: 'node -e "process.stdout.write(process.execPath)"' }, { name: 'path', run: 'echo "$PATH"' }] });
  assert.deepEqual(bare.results.map(r => r.ok), [true, true], bare.results.map(r => r.tail).join(' | '));
  assert.equal(bare.results[0].tail, process.execPath);
  assert.equal(bare.results[1].tail, `${nodeDir}:${empty}`);
  // A node already on the PATH: nothing is added.
  const own = `${empty}:${nodeDir}:/usr/bin:/bin`;
  const kept = await runChecks({ cwd: T, env: { PATH: own, HOME: T }, checks: [{ name: 'path', run: 'echo "$PATH"' }] });
  assert.equal(kept.results[0].tail, own);
  // The rule itself.
  assert.deepEqual(withNodeOnPath({ PATH: '/no/such/folder', A: '1' }), { PATH: `${nodeDir}:/no/such/folder`, A: '1' });
  assert.deepEqual(withNodeOnPath({}), { PATH: `${nodeDir}:/usr/bin:/bin` });
  assert.deepEqual(withNodeOnPath({ PATH: 'relative/bin' }, '/opt/node/bin/node'), { PATH: '/opt/node/bin:relative/bin' });
  const has = { PATH: nodeDir };
  assert.equal(withNodeOnPath(has), has);
  // scrubEnv itself does not touch PATH.
  assert.deepEqual(scrubEnv({ PATH: '/x' }), { PATH: '/x' });
});

test('a check that runs too long is stopped, with everything it started', async () => {
  const pidFile = path.join(T, 'timeout-child.pid');
  const t0 = Date.now();
  const out = await runChecks({ cwd: T, checks: [{ name: 'Hangs', run: `sleep 30 & echo $! > ${pidFile}; echo waiting; sleep 30`, timeoutSec: 1 }] });
  const took = Date.now() - t0;
  const r = out.results[0];
  assert.equal(out.state, 'failed');
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.tail, /(^|\n)Stopped after 1 second because it took too long\.$/);
  assert.ok(took >= 900 && took < 5000, `took ${took} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.ok(await goneWithin(pid, 2000), 'the background child was killed with the group');
});

test('a check that exits but leaves a child holding its output still returns, and the child is ended', async () => {
  const pidFile = path.join(T, 'leftover.pid');
  const t0 = Date.now();
  const out = await runChecks({ cwd: T, checks: [{ name: 'Leaves a child', run: `sleep 30 & echo $! > ${pidFile}; echo started` }] });
  const took = Date.now() - t0;
  assert.equal(out.state, 'passed');
  assert.equal(out.results[0].tail, 'started');
  assert.ok(took < 2500, `took ${took} ms`);
  assert.ok(await goneWithin(Number(fs.readFileSync(pidFile, 'utf8')), 2000), 'the leftover child was killed');
});

test('the tail keeps the last 2 KB, cut cleanly', async () => {
  const out = await runChecks({
    cwd: T,
    checks: [
      { name: 'Lots of output', run: 'i=0; while [ $i -lt 300 ]; do echo "line $i padding padding padding"; i=$((i+1)); done; echo LAST' },
      { name: 'Wide characters', run: `awk 'BEGIN { for (i = 0; i < 3000; i++) printf "é"; print "" }'` },
      { name: 'Colours', run: `printf '\\033[31mred\\033[0m\\n'` },
    ],
  });
  const [lots, wide, colours] = out.results;
  assert.ok(Buffer.byteLength(lots.tail) <= 2048);
  assert.ok(Buffer.byteLength(lots.tail) > 1900);
  assert.match(lots.tail, /line 299 padding padding padding\nLAST$/);
  assert.doesNotMatch(lots.tail, /line 0 /);
  assert.ok(Buffer.byteLength(wide.tail) <= 2048);
  assert.match(wide.tail, /^é+$/); // no broken character at the start
  assert.equal(colours.tail, 'red');
});

test('a check in a missing folder, or stopped by the engine, fails plainly', async () => {
  const missing = await runChecks({ cwd: path.join(T, 'nope'), checks: [{ name: 'x', run: 'true' }] });
  assert.equal(missing.state, 'failed');
  assert.match(missing.results[0].tail, /does not exist/);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const stopped = await runChecks({ cwd: T, signal: ac.signal, checks: [{ name: 'Long', run: 'sleep 30' }, { name: 'Next', run: 'true' }] });
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(stopped.results.map(r => [r.name, r.ok]), [['Long', false], ['Next', false]]);
  assert.match(stopped.results[0].tail, /stopped/i);
  assert.match(stopped.results[1].tail, /Not run/);
});

test('stopping checks ends the whole group, including what it started in the background', async () => {
  const pidFile = path.join(T, 'abort-child.pid');
  const ac = new AbortController();
  const out = runChecks({ cwd: T, signal: ac.signal, checks: [{ name: 'Background', run: `sleep 30 & echo $! > ${pidFile}; sleep 30` }] });
  for (const t0 = Date.now(); !(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()) && Date.now() - t0 < 3000;) await sleep(20);
  ac.abort();
  const r = (await out).results[0];
  assert.equal(r.ok, false);
  assert.match(r.tail, /Stopped because the agent was stopped\./);
  assert.ok(await goneWithin(Number(fs.readFileSync(pidFile, 'utf8')), 2000), 'the background child was ended with the group');
});

test('killChecksSync ends every running check at once, even one that ignores SIGTERM', async () => {
  const pidFile = path.join(T, 'stubborn.pid');
  const out = runChecks({ cwd: T, checks: [{ name: 'Stubborn', run: `trap '' TERM; echo $$ > ${pidFile}; sleep 30` }] });
  for (const t0 = Date.now(); !(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()) && Date.now() - t0 < 3000;) await sleep(20);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const t0 = Date.now();
  killChecksSync();
  assert.ok(await goneWithin(pid, 500), 'gone without waiting for a grace period');
  const res = await out;
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(res.results[0].ok, false);
});
