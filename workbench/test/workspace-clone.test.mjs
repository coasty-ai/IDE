// The person's name and email for git, the GitHub sign-in git keeps, and cloning (src/core/workspace.mjs).
//
// Git's system config is never read (GIT_CONFIG_NOSYSTEM): on a Mac it names the login keychain as git's credential
// helper. The global config is a file of these tests, with git's own `store` helper writing to a file here, and HOME,
// XDG_CONFIG_HOME and TMPDIR are folders here too. A `git` first on the PATH records every call (its arguments, a few
// variables and its folder) and runs the real git, or stands in for a clone (FAKE_GIT_CLONE), so nothing reaches a
// network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitConfigIdentity, setGitIdentity, approveGitCredential, rejectGitCredential, fillGitCredential, cloneRepo, cloneProgressOf,
} from '../src/core/workspace.mjs';

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'PATH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_ALLOW_PROTOCOL',
  'FAKE_GIT_LOG', 'FAKE_GIT_CLONE', 'FAKE_GIT_STDERR', 'FAKE_GIT_EXIT'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedCwd = process.cwd();

/** A token-shaped value, built from parts so that no secret scanner takes this file for a leak. */
const TOKEN = ['gho', 'NOTREAL', 'workbench', 'test', 'token', '0123456789'].join('_');
/** What cloneRepo says of an address it does not clone from: the Mac app's own words. */
const ADDRESS_REFUSED = 'Workbench clones addresses like https://github.com/owner/repo or git@github.com:owner/repo.git.';
const WORKSPACE_URL = new URL('../src/core/workspace.mjs', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let T, globalConfig, credsFile, gitLog, realGit;

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
/** Run the real git in a folder, with an identity of these tests. */
const gitIn = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The lines the recording git wrote since the log was last cleared. */
function calls() {
  return read(gitLog).split('\n').filter(Boolean);
}
function clearCalls() {
  fs.writeFileSync(gitLog, '');
}

before(() => {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-clone-')));
  for (const [key, dir] of [['HOME', 'home'], ['XDG_CONFIG_HOME', 'xdg'], ['TMPDIR', 'tmp']]) {
    fs.mkdirSync(path.join(T, dir));
    process.env[key] = path.join(T, dir);
  }
  globalConfig = path.join(T, 'gitconfig');
  credsFile = path.join(T, 'git-credentials');
  gitLog = path.join(T, 'git-calls.log');
  // No upkeep in the background: after a commit of many files, git's automatic maintenance packs the loose objects,
  // and a local copy of that repository made at the same time would find some gone.
  fs.writeFileSync(globalConfig, `[credential]\n\thelper = store --file ${credsFile}\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n`);
  fs.writeFileSync(gitLog, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Workbench Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
  // Variables Workbench must take away from a clone: an askpass program, and a wider list of transports.
  process.env.GIT_ASKPASS = '/bin/false';
  process.env.SSH_ASKPASS = '/bin/false';
  process.env.GIT_ALLOW_PROTOCOL = 'ext:file:https:ssh';
  process.env.FAKE_GIT_LOG = gitLog;

  const own = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git');
  realGit = fs.existsSync(own) ? own : execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(T, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'if [ -n "$FAKE_GIT_LOG" ]; then',
    '  printf \'%s\\n\' "ARGS $*" >> "$FAKE_GIT_LOG"',
    '  printf \'%s\\n\' "ENV askpass=[${GIT_ASKPASS-unset}] ssh_askpass=[${SSH_ASKPASS-unset}] allow=[${GIT_ALLOW_PROTOCOL-unset}] prompt=[${GIT_TERMINAL_PROMPT-unset}] ceiling=[${GIT_CEILING_DIRECTORIES-unset}] cwd=[$(pwd)]" >> "$FAKE_GIT_LOG"',
    'fi',
    'case " $* " in',
    '  *" clone "*)',
    '    for last; do :; done',
    '    case "$FAKE_GIT_CLONE" in',
    '      ok) mkdir -p "$last"; exit 0 ;;',
    '      fail) printf \'%s\' "$FAKE_GIT_STDERR" >&2; exit "${FAKE_GIT_EXIT:-128}" ;;',
    '      made) mkdir -p "$last"; echo half > "$last/half.txt"; printf \'%s\' "$FAKE_GIT_STDERR" >&2; exit 128 ;;',
    '      hang) echo $$ > "$FAKE_GIT_PIDFILE"; exec sleep 30 ;;',
    // Half a clone, then a wait: `stubborn` also ignores SIGTERM, so only SIGKILL ends it.
    '      half|stubborn) [ "$FAKE_GIT_CLONE" = stubborn ] && trap \'\' TERM; mkdir -p "$last/.git"; echo half > "$last/half.txt";'
      + ' printf \'Receiving objects:  10%% (1/10)\\r\' >&2; echo $$ > "$FAKE_GIT_PIDFILE"; exec sleep 30 ;;',
    '    esac ;;',
    'esac',
    `exec ${sh(realGit)} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
});

after(() => {
  process.chdir(savedCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(T, { recursive: true, force: true });
});

/** A plain refusal: `.why`, a sentence without git's words. */
async function refused(promise, why, sentence) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected a refusal');
  assert.equal(err.why, why, err.message);
  assert.equal(err.plain, true);
  if (sentence instanceof RegExp) assert.match(err.message, sentence);
  else if (sentence) assert.equal(err.message, sentence);
  assert.doesNotMatch(err.message, /fatal:|error:|usage:/i);
  return err;
}

// ------------------------------------------------------------------ name and email

test('gitConfigIdentity reads the global config, and setGitIdentity writes it there', async () => {
  assert.deepEqual(await gitConfigIdentity(), { name: '', email: '' });
  assert.deepEqual(await setGitIdentity({ name: '  Ada Lovelace ', email: ' ada@example.org ' }), { name: 'Ada Lovelace', email: 'ada@example.org' });
  assert.deepEqual(await gitConfigIdentity(), { name: 'Ada Lovelace', email: 'ada@example.org' });
  assert.match(read(globalConfig), /name = Ada Lovelace/);
  assert.match(read(globalConfig), /email = ada@example.org/);
  // Saving again replaces both, even when the file holds a second value of one (git config would refuse to set it).
  fs.appendFileSync(globalConfig, '[user]\n\tname = Second Name\n');
  await setGitIdentity({ name: 'Ada King', email: 'ada.king@example.org' });
  assert.deepEqual(await gitConfigIdentity(), { name: 'Ada King', email: 'ada.king@example.org' });
  assert.equal(read(globalConfig).match(/name = /g).length, 1);
  // A name that starts with a dash is a name, not an option.
  await setGitIdentity({ name: '-x', email: 'x@example.org' });
  assert.equal((await gitConfigIdentity()).name, '-x');
  // The person's own repositories keep their own settings: the global file is the only one written.
  assert.ok(calls().some((l) => l.includes('config --global --replace-all user.name')));
});

test('setGitIdentity refuses a name or email that git cannot use, and changes nothing', async () => {
  await setGitIdentity({ name: 'Grace Hopper', email: 'grace@example.org' });
  const before = read(globalConfig);
  const bad = [
    [{ name: '', email: 'a@example.org' }, 'name'],
    [{ name: '   ', email: 'a@example.org' }, 'name'],
    [{ name: 'x'.repeat(101), email: 'a@example.org' }, 'name'],
    [{ name: 'Two\nLines', email: 'a@example.org' }, 'name'],
    [{ name: 'Ada <ada@example.org>', email: 'a@example.org' }, 'name'],
    [{ name: `Ada${String.fromCharCode(0x202e)}`, email: 'a@example.org' }, 'name'],
    [{ name: 42, email: 'a@example.org' }, 'name'],
    [{ name: 'Ada', email: '' }, 'email'],
    [{ name: 'Ada', email: 'ada' }, 'email'],
    [{ name: 'Ada', email: 'ada@localhost' }, 'email'],
    [{ name: 'Ada', email: 'ada @example.org' }, 'email'],
    [{ name: 'Ada', email: 'ada@exa\nmple.org' }, 'email'],
    [{ name: 'Ada', email: `${'a'.repeat(250)}@example.org` }, 'email'],
  ];
  for (const [who, why] of bad) await refused(setGitIdentity(who), why);
  assert.equal(read(globalConfig), before);
  // 100 characters is still a name.
  await setGitIdentity({ name: 'n'.repeat(100), email: 'n@example.org' });
  assert.equal((await gitConfigIdentity()).name, 'n'.repeat(100));
});

// ------------------------------------------------------------------ credentials

test('approve, fill and reject give git the token on stdin, never in its arguments', async () => {
  clearCalls();
  fs.rmSync(credsFile, { force: true });
  assert.deepEqual(await approveGitCredential({ host: 'github.com', username: 'octo-cat', password: TOKEN }), { helper: true });
  assert.equal(read(credsFile).trim(), `https://octo-cat:${TOKEN}@github.com`);
  assert.deepEqual(await fillGitCredential({ host: 'github.com', username: 'octo-cat' }), { username: 'octo-cat', password: TOKEN });
  // Another user name has nothing kept.
  assert.equal(await fillGitCredential({ host: 'github.com', username: 'someone-else' }), null);
  assert.deepEqual(await rejectGitCredential({ host: 'github.com', username: 'octo-cat' }), { ok: true });
  assert.equal(read(credsFile).trim(), '');
  assert.equal(await fillGitCredential({ host: 'github.com', username: 'octo-cat' }), null);
  const log = calls();
  assert.ok(log.some((l) => /ARGS .*credential approve/.test(l)));
  assert.ok(log.some((l) => /ARGS .*credential reject/.test(l)));
  assert.ok(!log.some((l) => l.includes(TOKEN)), 'the token never appears in any git command line');
  // Every one ran outside any repository, with no way to ask the person.
  for (const l of log.filter((x) => x.startsWith('ENV '))) {
    assert.match(l, /prompt=\[0\]/);
    assert.match(l, /cwd=\[[^\]]*workbench-git-[^\]]*\]/);
    assert.doesNotMatch(l, /ceiling=\[unset\]/);
  }
  const quiet = log.filter((x) => x.startsWith('ENV ') && x.includes('askpass=[]'));
  assert.ok(quiet.length >= 3, 'credential commands run with an empty GIT_ASKPASS');
  for (const l of quiet) assert.match(l, /ssh_askpass=\[unset\]/);
  // The empty folders they ran from are gone.
  assert.deepEqual(fs.readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('workbench-git-')), []);
});

test('the credential functions refuse fields that would break git’s input, before running git', async () => {
  clearCalls();
  fs.rmSync(credsFile, { force: true });
  const bad = [
    [{ host: 'gitlab.com', username: 'octo', password: TOKEN }, 'host'],
    [{ host: 'github.com\nhost=evil.example', username: 'octo', password: TOKEN }, 'host'],
    [{ host: 'github.com', username: 'octo\npassword=x', password: TOKEN }, 'username'],
    [{ host: 'github.com', username: '-octo', password: TOKEN }, 'username'],
    [{ host: 'github.com', username: '', password: TOKEN }, 'username'],
    [{ host: 'github.com', username: 'octo', password: `${TOKEN}\nhost=evil.example` }, 'password'],
    [{ host: 'github.com', username: 'octo', password: '' }, 'password'],
    [{ host: 'github.com', username: 'octo', password: 'x'.repeat(1001) }, 'password'],
  ];
  for (const [cred, why] of bad) await refused(approveGitCredential(cred), why);
  await refused(rejectGitCredential({ host: 'example.org', username: 'octo' }), 'host');
  assert.equal(await fillGitCredential({ host: 'github.com', username: 'a\nb' }), null);
  assert.deepEqual(calls(), []);
  assert.equal(read(credsFile), '');
});

test('git never runs an askpass program for Workbench, whatever its config or environment names', async () => {
  const marker = path.join(T, 'askpass-ran');
  const askpass = path.join(T, 'askpass-bin', 'askpass');
  fs.mkdirSync(path.dirname(askpass), { recursive: true });
  fs.writeFileSync(askpass, `#!/bin/sh\necho ran >> ${sh(marker)}\necho from-askpass\n`, { mode: 0o755 });
  const config = path.join(T, 'askpass.gitconfig');
  fs.writeFileSync(config, `[core]\n\taskPass = ${askpass}\n[credential]\n\thelper = store --file ${credsFile}\n`);
  const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_ASKPASS: process.env.GIT_ASKPASS, SSH_ASKPASS: process.env.SSH_ASKPASS };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass });
  try {
    // Git itself, asked the same, would run it: the program is real, and this test can see it.
    const input = 'protocol=https\nhost=github.com\nusername=nobody-here\n\n';
    const said = execFileSync(realGit, ['credential', 'fill'], { input, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.match(said, /password=from-askpass/);
    assert.equal(read(marker).trim(), 'ran');
    fs.rmSync(marker);
    // Workbench's git does not.
    assert.equal(await fillGitCredential({ host: 'github.com', username: 'nobody-here' }), null);
    await refused(rejectGitCredential({ host: 'github.com', username: 'nobody\nhere' }), 'username');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('approve says when git keeps no sign-ins', async () => {
  const bare = path.join(T, 'no-helper.gitconfig');
  fs.writeFileSync(bare, '');
  process.env.GIT_CONFIG_GLOBAL = bare;
  try {
    assert.deepEqual(await approveGitCredential({ host: 'github.com', username: 'octo', password: TOKEN }), { helper: false });
    assert.equal(await fillGitCredential({ host: 'github.com', username: 'octo' }), null);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
  }
});

test('a repository’s own config cannot choose the credential helper, whatever folder Workbench runs in', async () => {
  const repo = path.join(T, 'agent-repo');
  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  const evil = path.join(T, 'evil-credentials');
  gitIn(repo, 'config', 'credential.helper', `store --file ${evil}`);
  gitIn(repo, 'config', 'user.name', 'Repo Name');
  process.chdir(repo);
  try {
    fs.rmSync(credsFile, { force: true });
    await approveGitCredential({ host: 'github.com', username: 'octo', password: TOKEN });
    assert.equal(read(evil), '');
    assert.match(read(credsFile), /octo/);
    // The global identity is read, not the repository's.
    await setGitIdentity({ name: 'Global Name', email: 'global@example.org' });
    assert.equal((await gitConfigIdentity()).name, 'Global Name');
  } finally {
    process.chdir(savedCwd);
    await rejectGitCredential({ host: 'github.com', username: 'octo' });
  }
});

// ------------------------------------------------------------------ cloning: addresses and folders

test('cloneRepo refuses addresses it does not clone from, before git runs', async () => {
  clearCalls();
  const into = path.join(T, 'refused');
  const bad = [
    'ext::sh -c touch% /tmp/pwned',
    'fd::17',
    'file:///tmp/some.git',
    '/tmp/some.git',
    'http://github.com/owner/repo',
    'git://github.com/owner/repo',
    ['https://user', 'not-a-password@github.com/owner/repo'].join(':'),
    'https://user@github.com/owner/repo',
    'https://github.com/',
    'https://github.com/owner/repo?tab=readme',
    'https://github.com/owner/repo#readme',
    'ssh://-oProxyCommand=evil/repo',
    'git@github.com:-upload-pack=evil',
    '--upload-pack=touch /tmp/x',
    '-u',
    'github.com owner/repo',
    '',
    '   ',
    null,
    42,
  ];
  // The words the Mac app's own check says, so the two read alike; the address is never repeated (it may be a key
  // pasted into the wrong field).
  for (const url of bad) await refused(cloneRepo({ url, into }), 'url', ADDRESS_REFUSED);
  assert.equal(calls().filter((l) => l.includes(' clone ')).length, 0);
  assert.equal(fs.existsSync(into), false);
});

test('cloneRepo refuses a backslash anywhere in an address, and an "@" before an https address’s path, before git runs', async () => {
  // Read with URL, https://github.com\@evil.example/… is github.com with no user name, since URL takes "\" for "/" in
  // https; git and curl read the user name "github.com\" at evil.example. A git that would run gets no network here.
  process.env.FAKE_GIT_CLONE = 'fail';
  process.env.FAKE_GIT_STDERR = 'fatal: this git must not have been run\n';
  try {
    clearCalls();
    const into = path.join(T, 'backslash');
    for (const url of [
      'https://github.com\\@evil.example/owner/repo',
      ['https://github.com\\', 'not-a-password@evil.example/owner/repo'].join(':'),
      'https://@github.com/owner/repo',
      'HTTPS://@github.com/owner/repo',
      'https://github.com?@evil.example/owner/repo',
      'ssh://git@github.com\\@evil.example/owner/repo',
      'git@github.com:owner\\repo.git',
      'https://github.com/owner\\repo',
    ]) await refused(cloneRepo({ url, into }), 'url', ADDRESS_REFUSED);
    assert.equal(calls().filter((l) => l.includes(' clone ')).length, 0);
    assert.equal(fs.existsSync(into), false);
    // An "@" in the path is the path's own.
    process.env.FAKE_GIT_CLONE = 'ok';
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/repo@2', into })).root, path.join(into, 'repo@2'));
  } finally {
    delete process.env.FAKE_GIT_CLONE;
    delete process.env.FAKE_GIT_STDERR;
  }
});

test('cloneRepo hands git the address with its scheme in lower case, and the rest as it was', async () => {
  // Git looks for a transport named as written, and protocol.HTTPS.allow is not protocol.https.allow: given HTTPS://…
  // under protocol.allow=never, git refuses ("transport 'HTTPS' not allowed").
  process.env.FAKE_GIT_CLONE = 'ok';
  try {
    const into = path.join(T, 'upper');
    for (const [url, given, name] of [
      ['HTTPS://github.com/Owner/Repo', 'https://github.com/Owner/Repo', 'Repo'],
      ['  Https://GitHub.com/owner/Mixed.git ', 'https://GitHub.com/owner/Mixed.git', 'Mixed'],
      ['SSH://git@example.org/team/Upper.git', 'ssh://git@example.org/team/Upper.git', 'Upper'],
    ]) {
      clearCalls();
      const { root } = await cloneRepo({ url, into });
      assert.equal(root, path.join(into, name), url);
      const args = calls().find((l) => l.startsWith('ARGS ') && l.includes(' clone '));
      assert.ok(args.endsWith(` clone --progress -- ${given} ${path.join(into, name)}`), args);
    }
  } finally {
    delete process.env.FAKE_GIT_CLONE;
  }
});

test('cloneRepo puts the repository in the folder it was given, also one whose name ends in a space', async () => {
  process.env.FAKE_GIT_CLONE = 'ok';
  try {
    const base = path.join(T, 'spaced');
    const into = path.join(base, 'Projects ');
    fs.mkdirSync(into, { recursive: true });
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/repo', into })).root, path.join(into, 'repo'));
    assert.deepEqual(fs.readdirSync(base), ['Projects '], 'no folder without the space was made beside it');
    // Made when missing, as it was given.
    const fresh = path.join(base, ' Fresh ');
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/repo', into: fresh })).root, path.join(fresh, 'repo'));
    assert.deepEqual(fs.readdirSync(base).sort(), [' Fresh ', 'Projects ']);
  } finally {
    delete process.env.FAKE_GIT_CLONE;
  }
});

test('cloneRepo takes https, ssh and scp-like addresses, names the folder after the repository, and runs git safely', async () => {
  process.env.FAKE_GIT_CLONE = 'ok';
  try {
    const into = path.join(T, 'named');
    const cases = [
      ['https://github.com/owner/repo', 'repo'],
      ['https://github.com/owner/repo2.git', 'repo2'],
      ['https://github.com/owner/repo3.git/', 'repo3'],
      ['  https://gitlab.example.org/team/sub/tool  ', 'tool'],
      ['git@github.com:owner/repo4.git', 'repo4'],
      ['github.com:owner/repo5', 'repo5'],
      ['ssh://git@example.org:2222/team/repo6.git', 'repo6'],
      ['ssh://example.org/srv/git/repo7/.git', 'repo7'],
    ];
    for (const [url, name] of cases) {
      clearCalls();
      const { root } = await cloneRepo({ url, into });
      assert.equal(root, path.join(into, name), url);
      const args = calls().find((l) => l.startsWith('ARGS ') && l.includes(' clone '));
      const dest = path.join(into, name);
      assert.equal(args, `ARGS -c core.fsmonitor=false -c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always clone --progress -- ${url.trim()} ${dest}`);
      const env = calls().find((l) => l.startsWith('ENV '));
      assert.match(env, /askpass=\[\] ssh_askpass=\[unset\] allow=\[unset\] prompt=\[0\]/);
      assert.match(env, /cwd=\[[^\]]*workbench-git-[^\]]*\]/);
    }
    // A name of its own.
    const { root } = await cloneRepo({ url: 'https://github.com/owner/repo', into, name: 'my copy' });
    assert.equal(root, path.join(into, 'my copy'));
    for (const name of ['..', '.', 'a/b', '', 'x\ny']) await refused(cloneRepo({ url: 'https://github.com/owner/other', into, name }), 'url', /cannot be the name of a folder/);
    await refused(cloneRepo({ url: 'git@github.com:.git', into }), 'url', /could not tell what to call the folder/);
  } finally {
    delete process.env.FAKE_GIT_CLONE;
  }
});

test('cloneRepo refuses a place that is taken, and makes the folder it needs', async () => {
  process.env.FAKE_GIT_CLONE = 'ok';
  try {
    const into = path.join(T, 'taken');
    fs.mkdirSync(path.join(into, 'repo'), { recursive: true });
    fs.writeFileSync(path.join(into, 'repo', 'mine.txt'), 'the person’s own file\n');
    clearCalls();
    const e = await refused(cloneRepo({ url: 'https://github.com/owner/repo', into }), 'exists');
    assert.equal(e.message, `There is already something at ${path.join(into, 'repo')}. Choose another folder, or move it away first.`);
    fs.writeFileSync(path.join(into, 'afile'), 'x');
    await refused(cloneRepo({ url: 'https://github.com/owner/afile', into }), 'exists');
    fs.symlinkSync(path.join(T, 'home'), path.join(into, 'alink'));
    await refused(cloneRepo({ url: 'https://github.com/owner/alink', into }), 'exists');
    await refused(cloneRepo({ url: 'https://github.com/owner/x', into: path.join(into, 'afile') }), 'exists', /is a file, not a folder/);
    await refused(cloneRepo({ url: 'https://github.com/owner/x', into: '' }), 'exists');
    assert.equal(calls().filter((l) => l.includes(' clone ')).length, 0);
    assert.equal(read(path.join(into, 'repo', 'mine.txt')), 'the person’s own file\n');
    // An empty folder is fine, and a missing parent is made.
    fs.mkdirSync(path.join(into, 'empty'));
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/empty', into })).root, path.join(into, 'empty'));
    const deep = path.join(T, 'deep', 'er', 'Developer');
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/repo', into: deep })).root, path.join(deep, 'repo'));
    // ~ is the home folder.
    assert.equal((await cloneRepo({ url: 'https://github.com/owner/tilde', into: '~/Developer' })).root, path.join(process.env.HOME, 'Developer', 'tilde'));
  } finally {
    delete process.env.FAKE_GIT_CLONE;
  }
});

// ------------------------------------------------------------------ cloning: failures

test('a clone that fails says why in plain words, with git’s own words only in .detail', async () => {
  process.env.FAKE_GIT_CLONE = 'fail';
  const into = path.join(T, 'failing');
  const GITHUB_AUTH = 'GitHub did not let Workbench read this repository. If it is private, sign in to GitHub, then try again.';
  // Refused for this Mac's SSH key: no GitHub sign-in mends that (a token is for https), so it is not 'auth', and the
  // Mac app offers no Connect GitHub… for it.
  const GITHUB_SSH = 'GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, sign in to GitHub first.';
  const NO_KEY = 'Permission denied (publickey).\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';
  const cases = [
    ['https://github.com/owner/private', "remote: Repository not found.\nfatal: repository 'https://github.com/owner/private/' not found\n", 'auth', GITHUB_AUTH],
    ['https://github.com/owner/private', "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n", 'auth', GITHUB_AUTH],
    ['git@github.com:owner/private.git', `git@github.com: ${NO_KEY}`, 'ssh', GITHUB_SSH],
    ['ssh://git@github.com/owner/private.git', `git@github.com: ${NO_KEY}`, 'ssh', GITHUB_SSH],
    ['git@github.com:owner/repo.git', 'Host key verification failed.\r\nfatal: Could not read from remote repository.\n', 'ssh', GITHUB_SSH],
    ['git@gitlab.example.org:team/x.git', `git@gitlab.example.org: ${NO_KEY}`, 'ssh',
      'gitlab.example.org did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, make sure git can sign in to gitlab.example.org first.'],
    // GitHub took the key, but that account cannot see the repository: a sign-in matter, which https and a token can mend.
    ['git@github.com:owner/private.git', 'ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n', 'auth', GITHUB_AUTH],
    ['https://gitlab.example.org/team/x', "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.example.org/team/x/'\n", 'auth',
      'gitlab.example.org did not let Workbench read this repository. If it is private, make sure git can sign in to gitlab.example.org, then try again.'],
    ['https://example.invalid/x/y', "fatal: unable to access 'https://example.invalid/x/y/': Could not resolve host: example.invalid\n", 'network', 'Workbench could not reach example.invalid.'],
    ['git@example.invalid:x/y.git', 'ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known\r\nfatal: Could not read from remote repository.\n', 'network', 'Workbench could not reach example.invalid.'],
    ['https://github.com/owner/odd', 'fatal: something unexpected happened\n', 'git', 'Git could not clone https://github.com/owner/odd.'],
  ];
  try {
    for (const [url, stderr, why, sentence] of cases) {
      process.env.FAKE_GIT_STDERR = stderr;
      const e = await refused(cloneRepo({ url, into }), why, sentence);
      assert.equal(e.detail, stderr.trim());
    }
    assert.deepEqual(fs.readdirSync(into), []);
    // A folder git made before it failed is removed; one that was there before is left.
    process.env.FAKE_GIT_CLONE = 'made';
    process.env.FAKE_GIT_STDERR = 'fatal: the remote end hung up unexpectedly\n';
    await refused(cloneRepo({ url: 'https://github.com/owner/half', into }), 'network');
    assert.equal(fs.existsSync(path.join(into, 'half')), false);
    fs.mkdirSync(path.join(into, 'kept'));
    await refused(cloneRepo({ url: 'https://github.com/owner/kept', into }), 'network');
    assert.equal(fs.existsSync(path.join(into, 'kept')), true);
  } finally {
    delete process.env.FAKE_GIT_CLONE;
    delete process.env.FAKE_GIT_STDERR;
  }
});

test('a clone that takes too long is stopped, with its whole process group', async () => {
  process.env.FAKE_GIT_CLONE = 'hang';
  process.env.FAKE_GIT_PIDFILE = path.join(T, 'hang.pid');
  try {
    const started = Date.now();
    await refused(cloneRepo({ url: 'https://github.com/owner/slow', into: path.join(T, 'slow'), timeoutMs: 300 }), 'git', 'Git took too long and was stopped.');
    assert.ok(Date.now() - started < 8000);
    assert.equal(fs.existsSync(path.join(T, 'slow', 'slow')), false);
    const pid = Number(read(process.env.FAKE_GIT_PIDFILE).trim());
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the stand-in git is gone');
  } finally {
    delete process.env.FAKE_GIT_CLONE;
    delete process.env.FAKE_GIT_PIDFILE;
  }
});

/** The process id the stand-in git wrote to `file`, once it has. */
async function pidIn(file, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const pid = Number(read(file).trim());
    if (pid > 0) return pid;
    if (Date.now() > until) throw new Error(`the stand-in git wrote no process id to ${file}`);
    await sleep(20);
  }
}

/** Whether the process has gone (and been reaped), waiting up to `ms` for it. */
async function goneSoon(pid, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return true;
      throw e;
    }
    if (Date.now() > until) return false;
    await sleep(25);
  }
}

test('a clone that is stopped ends git’s whole process group, then removes what it made', async () => {
  const pidfile = path.join(T, 'stopped.pid');
  const into = path.join(T, 'stopping');
  process.env.FAKE_GIT_PIDFILE = pidfile;
  try {
    // Git stops when asked; git ignores SIGTERM (SIGKILL a second later); a folder that was there, empty, before.
    for (const [mode, existing] of [['half', false], ['stubborn', false], ['half', true]]) {
      fs.rmSync(pidfile, { force: true });
      process.env.FAKE_GIT_CLONE = mode;
      const name = `${mode}-${existing ? 'there' : 'new'}`;
      const dest = path.join(into, name);
      if (existing) fs.mkdirSync(dest, { recursive: true });
      const stop = new AbortController();
      const seen = [];
      const cloning = cloneRepo({ url: `https://github.com/owner/${name}`, into, signal: stop.signal, onProgress: (p) => seen.push(p) });
      const pid = await pidIn(pidfile);
      assert.ok(fs.existsSync(path.join(dest, 'half.txt')), 'git had begun');
      const started = Date.now();
      stop.abort();
      await refused(cloning, 'stopped', 'Copying the repository was stopped.');
      const took = Date.now() - started;
      assert.ok(took < 3000, `${name}: stopping took ${took} ms`);
      if (mode === 'stubborn') assert.ok(took >= 900, `${name}: SIGKILL came after ${took} ms, not after the second git has to stop`);
      assert.ok(await goneSoon(pid, 500), `${name}: git is gone`);
      if (existing) assert.deepEqual(fs.readdirSync(dest), [], 'the folder that was there stays, empty as it was');
      else assert.equal(fs.existsSync(dest), false, `${name}: the half-made folder is gone`);
      assert.ok(fs.statSync(into).isDirectory(), 'the folder it was put in stays');
      assert.deepEqual(seen, [{ phase: 'receiving', percent: 10 }]);
    }
    // Stopped before it began: git never runs, and no folder is made.
    clearCalls();
    const early = new AbortController();
    early.abort();
    await refused(cloneRepo({ url: 'https://github.com/owner/never', into: path.join(T, 'never'), signal: early.signal }), 'stopped');
    assert.equal(calls().filter((l) => l.includes(' clone ')).length, 0);
    assert.equal(fs.existsSync(path.join(T, 'never')), false);
  } finally {
    delete process.env.FAKE_GIT_CLONE;
    delete process.env.FAKE_GIT_PIDFILE;
  }
});

test('when Workbench exits while git copies, its exit kills git’s whole group and removes the half-made folder', async () => {
  const pidfile = path.join(T, 'exiting.pid');
  const into = path.join(T, 'exiting');
  // A Workbench that exits mid-clone (as the CLI does when stopping takes too long). Git ignores SIGTERM, so only
  // SIGKILL ends it.
  const script = [
    "import fs from 'node:fs';",
    `const { cloneRepo } = await import(${JSON.stringify(WORKSPACE_URL)});`,
    `cloneRepo({ url: 'https://github.com/owner/gone', into: ${JSON.stringify(into)} }).catch(() => {});`,
    `const file = ${JSON.stringify(pidfile)};`,
    "while (!(fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim())) await new Promise((r) => setTimeout(r, 20));",
    'process.exit(3);',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, FAKE_GIT_CLONE: 'stubborn', FAKE_GIT_PIDFILE: pidfile }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(r.status, 3, r.stderr);
  const pid = Number(read(pidfile).trim());
  assert.ok(pid > 0);
  assert.ok(await goneSoon(pid), 'git is gone');
  assert.equal(fs.existsSync(path.join(into, 'gone')), false);
  assert.ok(fs.statSync(into).isDirectory(), 'the folder it was put in stays');
});

// ------------------------------------------------------------------ cloning: a real repository

test('cloneRepo copies a local repository and reports git’s progress', async () => {
  const src = path.join(T, 'source');
  fs.mkdirSync(src);
  gitIn(src, 'init', '-q', '-b', 'main');
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(src, `f${i}.txt`), `file ${i}\n`.repeat(20 + i));
  gitIn(src, 'add', '-A');
  gitIn(src, '-c', 'user.name=Workbench Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'first');
  const head = gitIn(src, 'rev-parse', 'HEAD');
  const bare = path.join(T, 'project.git');
  gitIn(T, 'clone', '-q', '--bare', src, bare);

  const into = path.join(T, 'Developer');
  // Without allowLocal, a local address is refused.
  await refused(cloneRepo({ url: `file://${bare}`, into }), 'url');

  const seen = [];
  const { root } = await cloneRepo({ url: `file://${bare}`, into, allowLocal: true, onProgress: (p) => seen.push(p) });
  assert.equal(root, path.join(into, 'project'));
  assert.equal(gitIn(root, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.txt')).length, 300);
  const phases = [...new Set(seen.map((p) => p.phase))];
  for (const phase of ['counting', 'compressing', 'receiving']) assert.ok(phases.includes(phase), `saw ${phase}: ${phases}`);
  for (const p of seen) {
    assert.ok(['counting', 'compressing', 'receiving', 'resolving', 'checkout'].includes(p.phase));
    assert.ok(p.percent === null || (Number.isInteger(p.percent) && p.percent >= 0 && p.percent <= 100));
  }
  assert.ok(seen.some((p) => p.phase === 'receiving' && p.percent === 100));
  // Each change is told once.
  for (let i = 1; i < seen.length; i++) assert.notDeepEqual(seen[i], seen[i - 1]);
  // The protocol settings, with file allowed only for this.
  const args = calls().filter((l) => l.startsWith('ARGS ') && l.includes(' clone ')).pop();
  assert.match(args, /-c protocol\.allow=never -c protocol\.https\.allow=always -c protocol\.ssh\.allow=always -c protocol\.file\.allow=always clone --progress -- file:\/\//);

  // A second clone to the same place is refused; a plain path works with allowLocal; a progress listener that throws
  // does not stop it.
  await refused(cloneRepo({ url: `file://${bare}`, into, allowLocal: true }), 'exists');
  const second = await cloneRepo({ url: bare, into, name: 'again', allowLocal: true, onProgress: () => { throw new Error('listener'); } });
  assert.equal(gitIn(second.root, 'rev-parse', 'HEAD'), head);

  // A repository that is not there: git's own failure, and no folder left behind.
  await refused(cloneRepo({ url: `file://${path.join(T, 'missing.git')}`, into, allowLocal: true }), 'git', /^Git could not clone file:\/\//);
  assert.equal(fs.existsSync(path.join(into, 'missing')), false);
});

test('cloneProgressOf reads each phase of git’s progress', () => {
  const lines = [
    ['remote: Enumerating objects: 302, done.        ', { phase: 'counting', percent: null }],
    ['remote: Counting objects:  45% (136/302)        ', { phase: 'counting', percent: 45 }],
    ['Counting objects: 100% (12/12), done.', { phase: 'counting', percent: 100 }],
    ['remote: Compressing objects:   7% (22/302)', { phase: 'compressing', percent: 7 }],
    ['Receiving objects:  99% (299/302), 1.20 MiB | 2.30 MiB/s', { phase: 'receiving', percent: 99 }],
    ['Resolving deltas:  50% (300/600)', { phase: 'resolving', percent: 50 }],
    ['Updating files: 100% (100/100), done.', { phase: 'checkout', percent: 100 }],
    ['Checking out files:  10% (1/10)', { phase: 'checkout', percent: 10 }],
  ];
  for (const [line, want] of lines) assert.deepEqual(cloneProgressOf(line), want, line);
  for (const line of ["Cloning into 'x'...", 'remote: Total 302 (delta 0), reused 0 (delta 0)', 'done.', '', null, 'fatal: no']) {
    assert.equal(cloneProgressOf(line), null, String(line));
  }
});
