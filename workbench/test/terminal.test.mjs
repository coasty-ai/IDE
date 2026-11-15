// Opening a terminal window for a vendor's sign-in or installer (src/core/terminal.mjs). Terminal itself is never
// opened: the tests pass their own `open` and home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTerminal, terminalScript, KEEP_MS, openTerminalSteps, terminalStepsScript } from '../src/core/terminal.mjs';

const MODULE = new URL('../src/core/terminal.mjs', import.meta.url);

/** A new folder for one test, removed afterwards: the tests use it as the home folder. */
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-terminal-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Workbench's own private folder for temporary files in the home folder `home`, and what is in it. */
const own = (home) => path.join(home, '.workbench', 'tmp');
const leftIn = (home) => (fs.existsSync(own(home)) ? fs.readdirSync(own(home)) : []);

/** Every file under `dir`. */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
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

test('on macOS it writes a private script in a folder of Workbench’s own under ~/.workbench, and asks Terminal to open it', async (t) => {
  const home = scratch(t);
  const { calls, open } = recorder();
  const res = await openTerminal({ title: 'Signing in to Claude Code', program: '/Users/someone/.local/bin/claude', args: ['auth', 'login'] }, { platform: 'darwin', home, open, keepMs: 60_000 });
  assert.deepEqual(res, { opened: true });
  assert.equal(calls.length, 1);
  const [argv] = calls;
  assert.deepEqual(argv.slice(0, 2), ['-a', 'Terminal']);
  const file = argv[2];
  assert.equal(argv.length, 3);
  assert.equal(path.basename(file), 'Signing in to Claude Code.command');
  const folder = path.dirname(file);
  assert.equal(path.dirname(folder), own(home));
  assert.match(path.basename(folder), /^workbench-terminal-/);
  assert.equal(mode(own(home)), 0o700);
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

test('the script never waits in the temporary folder, where another process could rewrite it before Terminal runs it', async (t) => {
  const home = scratch(t);
  const tmp = scratch(t);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; });
  // Terminal takes a moment to start. Meanwhile a process that can write the temporary folder (a Codex agent's, in its
  // sandbox) rewrites every .command file it finds there. Then Terminal runs the file it was given.
  let printed = null;
  const open = async (argv) => {
    for (const f of filesUnder(tmp)) if (f.endsWith('.command')) fs.writeFileSync(f, '#!/bin/sh\necho "someone else’s script"\n');
    printed = execFileSync('/bin/sh', [argv[2]], { encoding: 'utf8', env: { PATH: process.env.PATH, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'ignore'] });
  };
  for (const run of [
    () => openTerminal({ title: 'Signing in to Claude Code', program: '/bin/echo', args: ['the sign-in Workbench meant to run'] }, { platform: 'darwin', home, open }),
    () => openTerminalSteps({ title: 'Signing in to GitHub', steps: [{ program: '/bin/echo', args: ['the sign-in Workbench meant to run'] }] }, { platform: 'darwin', home, open }),
  ]) {
    printed = null;
    assert.deepEqual(await run(), { opened: true });
    assert.match(printed, /the sign-in Workbench meant to run/);
    assert.doesNotMatch(printed, /someone else/);
  }
  assert.deepEqual(fs.readdirSync(tmp), [], 'nothing was written in the temporary folder');
});

test('every word reaches the program exactly as it was given, and the title is printed as it is', async (t) => {
  const home = scratch(t);
  const out = path.join(home, 'argv.json');
  const echo = path.join(home, 'echo args.mjs');
  fs.writeFileSync(echo, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n");
  const words = ["it's", 'a "quoted" word', '$HOME', '`date`', '$(echo hi)', 'semi;colon && more', 'new\nline', 'back\\slash', '*', ' spaced ', '', '--flag=1'];
  const title = 'Installing "Codex" for $USER, it\'s `now`';
  const { calls, open } = recorder();
  assert.deepEqual(await openTerminal({ title, program: process.execPath, args: [echo, out, ...words] }, { platform: 'darwin', home, open }), { opened: true });
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
  const home = scratch(t);
  const ok = recorder();
  await openTerminal({ title: 'Soon gone', program: '/bin/echo', args: ['hi'] }, { platform: 'darwin', home, open: ok.open, keepMs: 30 });
  assert.equal(fs.existsSync(ok.calls[0][2]), true);
  await sleep(300);
  assert.equal(fs.existsSync(path.dirname(ok.calls[0][2])), false);

  const bad = recorder({ fail: true });
  assert.deepEqual(await openTerminal({ title: 'No Terminal', program: '/bin/echo', args: [] }, { platform: 'darwin', home, open: bad.open }), { opened: false });
  assert.equal(bad.calls.length, 1);
  assert.equal(fs.existsSync(path.dirname(bad.calls[0][2])), false);
  assert.deepEqual(leftIn(home), []);
});

test('when Workbench cannot make its private folder, nothing is written or opened', async (t) => {
  const home = scratch(t);
  fs.mkdirSync(path.join(home, '.workbench'));
  fs.writeFileSync(own(home), ''); // a file where its folder would be
  const { calls, open } = recorder();
  assert.deepEqual(await openTerminal({ title: 'Sign in', program: '/bin/echo', args: [] }, { platform: 'darwin', home, open }), { opened: false });
  assert.equal(calls.length, 0);
});

test('elsewhere nothing is written or opened', async (t) => {
  const home = scratch(t);
  for (const platform of ['linux', 'win32', 'freebsd']) {
    const { calls, open } = recorder();
    assert.deepEqual(await openTerminal({ title: 'Sign in', program: '/usr/bin/codex', args: ['login'] }, { platform, home, open }), { opened: false });
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(fs.readdirSync(home), []);
});

test('a program or word that cannot be passed on is refused, before anything is written', async (t) => {
  const home = scratch(t);
  const { calls, open } = recorder();
  const o = { platform: 'darwin', home, open };
  await assert.rejects(openTerminal({ title: 'x', program: '', args: [] }, o), { message: 'Workbench was not told which program to run.' });
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo\u0000', args: [] }, o), /not told which program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: ['a\u0000b'] }, o), /cannot pass to a program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: 'login' }, o), /cannot pass to a program/);
  await assert.rejects(openTerminal({ title: 'x', program: '/bin/echo', args: [42] }, o), /cannot pass to a program/);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('its folders are removed when Workbench exits', (t) => {
  const dir = scratch(t);
  const child = path.join(dir, 'child.mjs');
  fs.writeFileSync(child, [
    `import { openTerminal } from ${JSON.stringify(MODULE.href)};`,
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const home = process.argv[2];",
    "const r = await openTerminal({ title: 'Kept until exit', program: '/bin/echo', args: [] }, { platform: 'darwin', home, open: async () => {} });",
    "console.log(JSON.stringify({ r, during: fs.readdirSync(path.join(home, '.workbench', 'tmp')).filter((n) => n.startsWith('workbench-terminal-')).length }));",
    '',
  ].join('\n'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const said = JSON.parse(execFileSync(process.execPath, [child, home], { encoding: 'utf8' }));
  assert.deepEqual(said, { r: { opened: true }, during: 1 });
  assert.deepEqual(leftIn(home), []);
});

// ------------------------------------------------------------------ a few steps in a row (GitHub's sign-in: gh's login, then setup-git)

test('a few steps in a row: each word quoted, each step only when the one before it ended well, then the closing line', async (t) => {
  const home = scratch(t);
  const { calls, open } = recorder();
  const gh = '/Users/someone/.local/bin/gh';
  const steps = [
    { program: '/usr/bin/env', args: ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', gh, 'auth', 'login', '--hostname', 'github.com'] },
    { program: '/usr/bin/env', args: ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', gh, 'auth', 'setup-git', '--hostname', 'github.com'] },
  ];
  assert.deepEqual(await openTerminalSteps({ title: 'Signing in to GitHub', steps }, { platform: 'darwin', home, open, keepMs: 60_000 }), { opened: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['-a', 'Terminal']);
  const file = calls[0][2];
  assert.equal(path.basename(file), 'Signing in to GitHub.command');
  assert.equal(path.dirname(path.dirname(file)), own(home));
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
  const home = scratch(t);
  const ran = path.join(home, 'ran.jsonl');
  const step = path.join(home, 'step one.mjs');
  fs.writeFileSync(step, "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');\nprocess.exit(process.argv[3] === 'fail' ? 1 : 0);\n");
  const words = ["it's", '$HOME', '`date`', 'a && b', 'new\nline'];
  const run = async (first) => {
    fs.rmSync(ran, { force: true });
    const { calls, open } = recorder();
    await openTerminalSteps({ title: 'Two steps', steps: [
      { program: process.execPath, args: [step, ran, first, ...words] },
      { program: process.execPath, args: [step, ran, 'second'] },
    ] }, { platform: 'darwin', home, open });
    const printed = execFileSync('/bin/sh', [calls[0][2]], { encoding: 'utf8', env: { PATH: process.env.PATH, TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'ignore'] });
    assert.ok(printed.trimEnd().endsWith('You can close this window.'), 'the closing line comes either way');
    return fs.readFileSync(ran, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  };
  assert.deepEqual(await run('ok'), [['ok', ...words], ['second']]);
  assert.deepEqual(await run('fail'), [['fail', ...words]], 'the second step does not run');
});

test('steps elsewhere than macOS: nothing written or opened; steps that cannot be passed on are refused first', async (t) => {
  const home = scratch(t);
  const { calls, open } = recorder();
  const one = [{ program: '/usr/bin/gh', args: ['auth', 'login'] }];
  assert.deepEqual(await openTerminalSteps({ title: 'Sign in', steps: one }, { platform: 'linux', home, open }), { opened: false });
  const o = { platform: 'darwin', home, open };
  for (const steps of [[], null, 'gh auth login', [{ program: '', args: [] }], [{ program: '/bin/echo', args: ['a\u0000b'] }], [{ program: '/bin/echo', args: 'x' }], Array(11).fill(one[0])]) {
    await assert.rejects(openTerminalSteps({ title: 'x', steps }, o), { plain: true }, JSON.stringify(steps));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(home), []);
});
