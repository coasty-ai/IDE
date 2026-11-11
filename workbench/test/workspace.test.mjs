import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRepo, createWorkspace, removeWorkspace, diffStats, readRepoConfig, normalizeConfig, slugify, workspacesFolder } from '../src/core/workspace.mjs';

// Keep the person's own git settings (signing, hooks, default branch) out of these repositories.
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const homeWorkbench = path.join(os.homedir(), '.workbench');
const homeWorkbenchExisted = fs.existsSync(homeWorkbench);

let T, repo, baseDir, c1, c2;

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
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Workbench Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-workspace-'));
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
  fs.rmSync(T, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

test('nothing was written to the real home folder', () => {
  if (!homeWorkbenchExisted) assert.equal(fs.existsSync(homeWorkbench), false);
});
