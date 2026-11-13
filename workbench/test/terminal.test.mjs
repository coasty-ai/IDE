// Opening a terminal window for a vendor's sign-in or installer (src/core/terminal.mjs). Terminal itself is never
// opened: the tests pass their own `open` and temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTerminal, terminalScript, KEEP_MS, openTerminalSteps, terminalStepsScript } from '../src/core/terminal.mjs';

const MODULE = new URL('../src/core/terminal.mjs', import.meta.url);

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-terminal-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An `open` that records what it was asked, and fails when told to. */
function recorder({ fail = false } = {}) {
  const calls = [];
  const open = async (argv) => {
    calls.push(argv);
    if (fail) throw new Error('Terminal could not be opened');
  };
  return { calls, open };
}

const mode = (p) => fs.statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('on macOS it writes a private script and asks Terminal to open it', async (t) => {
  const tmp = scratch(t);
  const { calls, open } = recorder();
  const res = await openTerminal({ title: 'Signing in to Claude Code', program: '/Users/someone/.local/bin/claude', args: ['auth', 'login'] }, { platform: 'darwin', tmpDir: tmp, open, keepMs: 60_000 });
  assert.deepEqual(res, { opened: true });
  assert.equal(calls.length, 1);
  const [argv] = calls;
  assert.deepEqual(argv.slice(0, 2), ['-a', 'Terminal']);
  const file = argv[2];
  assert.equal(argv.length, 3);
  assert.equal(path.basename(file), 'Signing in to Claude Code.command');
  const folder = path.dirname(file);
  assert.equal(path.dirname(folder), tmp);
  assert.match(path.basename(folder), /^workbench-terminal-/);
  assert.equal(mode(folder), 0o700);
  assert.equal(mode(file), 0o700);
  assert.equal(fs.readFileSync(file, 'utf8'), [
    '#!/bin/sh',
    'clear',
    "printf '%s\\n\\n' 'Signing in to Claude Code'",
    "'/Users/someone/.local/bin/claude' 'auth' 'login'",
    "printf '\\n%s\\n' 'You can close this window.'",
    '',
  ].join('\n'));
  assert.equal(KEEP_MS, 10 * 60_000);
});

test('every word reaches the program exactly as it was given, and the title is printed as it is', async (t) => {
  const tmp = scratch(t);
  const out = path.join(tmp, 'argv.json');
  const echo = path.join(tmp, 'echo args.mjs');
  fs.writeFileSync(echo, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  const words = ["it's", 'a "quoted" word', '$HOME', '`date`', '$(echo hi)', 'semi;colon && more', 'new\nline', 'back\\slash', '*', ' spaced ', '', '--flag=1'];
  const title = 'Installing "Codex" for $USER, it\'s `now`';
  const { calls, open } = recorder();
  assert.deepEqual(await openTerminal({ title, program: process.execPath, args: [echo, out, ...words] }, { platform: 'darwin', tmpDir: tmp, open }), { opened: true });
  const file = calls[0][2];
  const printed = execFileSync('/bin/sh', [file], { encoding: 'utf8', env: { PATH: process.env.PATH, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), words);
  assert.ok(printed.includes(`${title}\n\n`), printed);
  assert.ok(printed.trimEnd().endsWith('You can close this window.'));
  // The file name keeps only plain characters.
  assert.equal(path.basename(file), 'Installing Codex for USER its now.command');
});

test('a title with control characters is one plain line', () => {
  const script = terminalScript({ title: `Sign in\u0007\nnow${String.fromCharCode(0x202e)}!`, program: '/bin/echo', args: [] });
  assert.match(script, /^printf '%s\\n\\n' 'Sign in now !'$/m);
  assert.match(terminalScript({ title: '', program: '/bin/echo' }), /'Workbench'/);
});

test('the folder goes after its time, and at once when Terminal cannot be opened', async (t) => {
  const tmp = scratch(t);
  const ok = recorder();
  await openTerminal({ title: 'Soon gone', program: '/bin/echo', args: ['hi'] }, { platform: 'darwin', tmpDir: tmp, open: ok.open, keepMs: 30 });
  assert.equal(fs.existsSync(ok.calls[0][2]), true);
  await sleep(300);
  assert.equal(fs.existsSync(path.dirname(ok.calls[0][2])), false);

  const bad = recorder({ fail: true });
  assert.deepEqual(await openTerminal({ title: 'No Terminal', program: '/bin/echo', args: [] }, { platform: 'darwin', tmpDir: tmp, open: bad.open }), { opened: false });
  assert.equal(bad.calls.length, 1);
  assert.equal(fs.existsSync(path.dirname(bad.calls[0][2])), false);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('elsewhere nothing is written or opened', async (t) => {
  const tmp = scratch(t);
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const { calls, open } = recorder();
    assert.deepEqual(await openTerminal({ title: 'Sign in', program: '/usr/bin/codex', args: ['login'] }, { platform, tmpDir: tmp, open }), { opened: false });
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('a program or word that cannot be passed on is refused, before anything is written', async (t) => {
  const tmp = scratch(t);
  const { calls, open } = recorder();
  const o = { platform: 'darwin', tmpDir: tmp, open };
  await assert.rejects(openTerminal({ title: 'x', program: '', args: [] }, o), { message: 'Workbench was not told which program to run.' });
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo\u0000', args: [] }, o), /not told which program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: ['a\u0000b'] }, o), /cannot pass to a program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: 'login' }, o), /cannot pass to a program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: [42] }, o), /cannot pass to a program/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('its folders are removed when Workbench exits', (t) => {
  const tmp = scratch(t);
  const child = path.join(tmp, 'child.mjs');
  fs.writeFileSync(child, [
    `import { openTerminal } from ${JSON.stringify(MODULE.href)};`,
    "const dir = process.argv[2];",
    "const r = await openTerminal({ title: 'Kept until exit', program: '/bin/echo', args: [] }, { platform: 'darwin', tmpDir: dir, open: async () => {} });",
    "console.log(JSON.stringify({ r, during: (await import('node:fs')).readdirSync(dir).filter((n) => n.startsWith('workbench-terminal-')).length }));",
    '',
  ].join('\n'));
  const scripts = path.join(tmp, 'scripts');
  fs.mkdirSync(scripts);
  const said = JSON.parse(execFileSync(process.execPath, [child, scripts], { encoding: 'utf8' }));
  assert.deepEqual(said, { r: { opened: true }, during: 1 });
  assert.deepEqual(fs.readdirSync(scripts), []);
});

// ------------------------------------------------------------------ a few steps in a row (GitHub's sign-in: gh's login, then setup-git)

test('a few steps in a row: each word quoted, each step only when the one before it ended well, then the closing line', async (t) => {
  const tmp = scratch(t);
  const { calls, open } = recorder();
  const gh = '/Users/someone/.local/bin/gh';
  const steps = [
    { program: '/usr/bin/env', args: ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', gh, 'auth', 'login', '--hostname', 'github.com'] },
    { program: '/usr/bin/env', args: ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', gh, 'auth', 'setup-git', '--hostname', 'github.com'] },
  ];
  assert.deepEqual(await openTerminalSteps({ title: 'Signing in to GitHub', steps }, { platform: 'darwin', tmpDir: tmp, open, keepMs: 60_000 }), { opened: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['-a', 'Terminal']);
  const file = calls[0][2];
  assert.equal(path.basename(file), 'Signing in to GitHub.command');
  assert.equal(mode(path.dirname(file)), 0o700);
  assert.equal(mode(file), 0o700);
  assert.equal(fs.readFileSync(file, 'utf8'), [
    '#!/bin/sh',
    'clear',
    "printf '%s\\n\\n' 'Signing in to GitHub'",
    `'/usr/bin/env' '-u' 'GH_TOKEN' '-u' 'GITHUB_TOKEN' '${gh}' 'auth' 'login' '--hostname' 'github.com' &&`,
    `'/usr/bin/env' '-u' 'GH_TOKEN' '-u' 'GITHUB_TOKEN' '${gh}' 'auth' 'setup-git' '--hostname' 'github.com'`,
    "printf '\\n%s\\n' 'You can close this window.'",
    '',
  ].join('\n'));
  assert.equal(terminalStepsScript({ title: 'Signing in to GitHub', steps }), fs.readFileSync(file, 'utf8'));
});

test('run as Terminal runs it: the second step only after the first ended well, every word exactly as given', async (t) => {
  const tmp = scratch(t);
  const ran = path.join(tmp, 'ran.jsonl');
  const step = path.join(tmp, 'step one.mjs');
  fs.writeFileSync(step, "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');\nprocess.exit(process.argv[3] === 'fail' ? 1 : 0);\n");
  const words = ["it's", '$HOME', '`date`', 'a && b', 'new\nline'];
  const run = async (first) => {
    fs.rmSync(ran, { force: true });
    const { calls, open } = recorder();
    await openTerminalSteps({ title: 'Two steps', steps: [
      { program: process.execPath, args: [step, ran, first, ...words] },
      { program: process.execPath, args: [step, ran, 'second'] },
    ] }, { platform: 'darwin', tmpDir: tmp, open });
    const printed = execFileSync('/bin/sh', [calls[0][2]], { encoding: 'utf8', env: { PATH: process.env.PATH, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.ok(printed.trimEnd().endsWith('You can close this window.'), 'the closing line comes either way');
    return fs.readFileSync(ran, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  };
  assert.deepEqual(await run('ok'), [['ok', ...words], ['second']]);
  assert.deepEqual(await run('fail'), [['fail', ...words]], 'the second step does not run');
});

test('steps elsewhere than macOS: nothing written or opened; steps that cannot be passed on are refused first', async (t) => {
  const tmp = scratch(t);
  const { calls, open } = recorder();
  const one = [{ program: '/usr/bin/gh', args: ['auth', 'login'] }];
  assert.deepEqual(await openTerminalSteps({ title: 'Sign in', steps: one }, { platform: 'linux', tmpDir: tmp, open }), { opened: false });
  const o = { platform: 'darwin', tmpDir: tmp, open };
  for (const steps of [[], null, 'gh auth login', [{ program: '', args: [] }], [{ program: '/bin/echo', args: ['a\u0000b'] }], [{ program: '/bin/echo', args: 'x' }], Array(11).fill(one[0])]) {
    await assert.rejects(openTerminalSteps({ title: 'x', steps }, o), { plain: true }, JSON.stringify(steps));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(tmp), []);
});
