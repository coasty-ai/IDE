import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareRepo, createWorkspace, removeWorkspace, diffStats, readRepoConfig, normalizeConfig, slugify, workspacesFolder,
  snapshotWork, workDiff, mergeWork, discardWork, gitGraph, gitIdentity,
} from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';

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

/** The person's identity, in each test repository's own config. The environment says someone else, on purpose. */
const PERSON = { name: 'Pat Person', email: 'pat@example.invalid' };
const STARTING_FILES = { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n', 'c.txt': 'c\n', '.gitignore': '.env\nnode_modules/\n' };

/** git that may fail: { code, out, err }. */
const gitTry = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
/** git status as it is, without git writing its index on the way (GIT_OPTIONAL_LOCKS=0). */
const statusOf = cwd => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'],
  { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
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
function indexState(ws) {
  return {
    bytes: sha(fs.readFileSync(path.resolve(ws, git(ws, 'rev-parse', '--git-path', 'index')))),
    entries: git(ws, 'ls-files', '-s'),
    status: statusOf(ws),
    head: headOf(ws),
  };
}

/** A repository on main with `files`, the person's identity in its own config (unless `identity: false`), and one agent's folder. */
let sourceRepos = 0;
async function agentRepo(files = STARTING_FILES, { identity = true, slug = 'Search cleanup' } = {}) {
  const n = ++sourceRepos;
  const r = path.join(T, `source-${n}`);
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  if (identity) {
    git(r, 'config', 'user.name', PERSON.name);
    git(r, 'config', 'user.email', PERSON.email);
  }
  for (const [f, text] of Object.entries(files)) write(path.join(r, f), text);
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'first');
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
function everything(t) {
  return {
    person: folderPrint(t.root), head: headOf(t.root), on: gitTry(t.root, 'symbolic-ref', '-q', 'HEAD').out,
    personStatus: statusOf(t.root), refs: git(t.root, 'for-each-ref'), stash: git(t.root, 'stash', 'list'),
    agent: fs.existsSync(t.ws.path) ? indexState(t.ws.path) : null, agentFiles: fs.existsSync(t.ws.path) ? folderPrint(t.ws.path) : null,
  };
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
const ranHooks = log => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

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
  const before = indexState(t.ws.path);

  const s = await snapshotWork({ repoRoot: t.root, path: t.ws.path, since: t.ws.base });
  assert.deepEqual(indexState(t.ws.path), before, 'the agent’s index, status and HEAD are as they were');
  assert.equal(s.head, head);
  assert.equal(s.since, t.ws.base);
  assert.match(s.tree, /^[0-9a-f]{40}$/);
  assert.equal(s.workId, `${head}:${s.tree}`);
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
  assert.deepEqual(indexState(t.ws.path), before);
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

  // The tidy at shutdown gets `since`: the folder holds nothing beyond W, so it goes, with its branch.
  assert.deepEqual(await removeWorkspace({ repoRoot: t.root, path: t.ws.path, base: second.work, onlyIfUnchanged: true, deleteBranch: true }),
    { removed: true, branch: t.ws.branch });
  assert.equal(fs.existsSync(t.ws.path), false);
  assert.equal(git(t.root, 'branch', '--list', t.ws.branch), '');
  assert.equal(git(t.root, 'show', `${second.merge}:d.txt`), 'd');
});

test('mergeWork refuses, changing nothing at all, before it makes the work commit', async () => {
  const refused = async (setup, why, sentence, { since, opts } = {}) => {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    const { expect } = await proposal(t);
    const o = await setup(t, expect);
    const was = everything(t);
    const r = await mergeWork({ ...mergeOpts(t, o?.expect || expect, since || t.ws.base), ...(opts || {}), ...(o?.opts || {}) });
    assert.deepEqual(r, { ok: false, why, sentence }, `${why}: ${JSON.stringify(r)}`);
    assert.deepEqual(everything(t), was, `${why}: nothing changed`);
    return t;
  };

  // Not on a branch. (Plain git "succeeds" there, moving only the detached HEAD; no branch gets the work.)
  const demo = cloneOf((await agentRepo()).root);
  git(demo, 'checkout', '-q', '-b', 'side');
  write(path.join(demo, 'side.txt'), 's\n');
  git(demo, 'add', 'side.txt');
  git(demo, 'commit', '-q', '-m', 'side');
  git(demo, 'checkout', '-q', '--detach', 'main');
  assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', 'side').code, 0);
  assert.equal(headOf(demo), git(demo, 'rev-parse', 'side'));
  assert.notEqual(git(demo, 'rev-parse', 'main'), headOf(demo));
  await refused(t => { git(t.root, 'checkout', '-q', '--detach'); }, 'detached', 'Your folder is not on a branch, so there is nowhere to merge it.');

  // A merge, rebase, cherry-pick, revert or bisect under way.
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-apply']) {
    await refused(t => {
      const f = path.join(t.root, '.git', marker);
      if (marker.startsWith('rebase')) fs.mkdirSync(f);
      else write(f, `${t.ws.base}\n`);
    }, 'busy', 'Your folder is in the middle of a merge or rebase. Finish that first.');
  }

  // Branch or HEAD changed since the card was drawn.
  await refused(t => {
    write(t.p('c.txt'), 'c2\n');
    git(t.root, 'commit', '-q', '-am', 'person again');
  }, 'moved', 'main changed since you looked. Have another look.');
  await refused((t, expect) => ({ expect: { ...expect, into: 'release' } }), 'moved', 'release changed since you looked. Have another look.');
  await refused((t, expect) => {
    git(t.root, 'checkout', '-q', '-b', 'release');
    return { expect: { ...expect, into: 'main' } };
  }, 'moved', 'main changed since you looked. Have another look.');

  // The work changed since: one more edit, or a commit by the agent.
  await refused(t => { write(t.w('late.txt'), 'late\n'); }, 'changed', 'Its work changed since you looked. Have another look.');
  await refused(t => { git(t.ws.path, 'commit', '-q', '-am', 'agent'); }, 'changed', 'Its work changed since you looked. Have another look.');
  await refused(() => ({ expect: { workId: 'nonsense', into: 'main' } }), 'moved', 'main changed since you looked. Have another look.');

  // The person's branch no longer holds the commit the agent started from.
  await refused(t => {
    git(t.root, 'checkout', '-q', '--orphan', 'fresh');
    git(t.root, 'commit', '-q', '-m', 'a fresh start');
    return { expect: { workId: undefined, into: 'fresh', intoHead: headOf(t.root) } };
  }, 'changed', 'Its work changed since you looked. Have another look.');
  {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.root, 'checkout', '-q', '--orphan', 'fresh');
    git(t.root, 'commit', '-q', '-m', 'a fresh start');
    const { expect } = await proposal(t);
    const was = everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)),
      { ok: false, why: 'ancestry', sentence: 'It started from a commit that is no longer in fresh, so merging it would bring in other work.' });
    assert.deepEqual(everything(t), was);
  }

  // Nothing to merge: no change at all, or work already merged by hand.
  {
    const t = await agentRepo();
    const { expect } = await proposal(t);
    const was = everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'nothing', sentence: 'Its work is already in main.' });
    assert.deepEqual(everything(t), was);
  }
  {
    const t = await agentRepo();
    write(t.w('a.txt'), 'one\nAGENT\nthree\n');
    git(t.ws.path, 'commit', '-q', '-am', 'agent');
    git(t.root, 'merge', '-q', '--no-ff', '--no-edit', t.ws.branch);
    const { s, expect } = await proposal(t);
    assert.equal(s.changed, true);
    const was = everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'nothing', sentence: 'Its work is already in main.' });
    assert.deepEqual(everything(t), was);
  }

  // The agent's folder is mid-merge itself, or is not on its branch.
  await refused(t => { write(path.resolve(t.ws.path, git(t.ws.path, 'rev-parse', '--git-path', 'MERGE_HEAD')), `${t.ws.base}\n`); },
    'git', 'Its folder is in the middle of a merge or rebase, so its work cannot be merged yet.');
  await refused(() => ({ opts: { branch: 'workbench/someone-else-a1a1a1' } }), 'changed', 'Its folder is on the branch workbench/search-cleanup-sc0026 now, not on workbench/someone-else-a1a1a1.'.replace(/sc\d{4}/, `sc${String(sourceRepos + 1).padStart(4, '0')}`));
});

test('mergeWork says when git does not know the person’s name and email, whatever the environment says', async () => {
  const t = await agentRepo(STARTING_FILES, { identity: false });
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_GLOBAL; // an empty HOME and no config files at all
  try {
    assert.equal(fs.readdirSync(process.env.HOME).length, 0);
    assert.equal(process.env.GIT_AUTHOR_NAME, 'Workbench Test'); // plain git would use this, or guess one
    assert.equal(await gitIdentity({ repoRoot: t.root }), null);
    const { expect } = await proposal(t);
    const was = everything(t);
    assert.deepEqual(await mergeWork(mergeOpts(t, expect)), {
      ok: false, why: 'identity',
      sentence: 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.',
    });
    assert.deepEqual(everything(t), was);
    git(t.root, 'config', 'user.name', PERSON.name);
    assert.equal(await gitIdentity({ repoRoot: t.root }), null, 'both are needed');
    git(t.root, 'config', 'user.email', PERSON.email);
    assert.deepEqual(await gitIdentity({ repoRoot: t.root }), PERSON);
    const ok = await mergeWork(mergeOpts(t, expect));
    assert.equal(ok.ok, true);
    assert.equal(git(t.root, 'log', '-1', '--format=%an <%ae>', ok.merge), 'Pat Person <pat@example.invalid>');
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
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
  const was = everything(t);
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
  assert.deepEqual(everything(t), was);
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

test('the repository’s hooks never run: not for the snapshot, the diff, the merge, the throw-away or the graph', async () => {
  const t = await agentRepo();
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  git(t.ws.path, 'commit', '-q', '-am', 'agent'); // committed before the hooks are planted (pre-commit says no)
  write(t.w('new.txt'), 'new\n'); // and something uncommitted, so the merge makes a commit of its own
  const other = await createWorkspace({ repoRoot: t.root, agentId: 'hk0002', slug: 'Throw me', baseDir });
  write(path.join(other.path, 'x.txt'), 'x\n');
  const log = path.join(T, `hooks-${t.id}.log`);
  plantHooks(path.join(t.root, '.git'), log);

  // The danger is real: plain git runs them.
  const demo = cloneOf(t.root);
  plantHooks(path.join(demo, '.git'), log);
  assert.equal(gitTry(demo, 'merge', '--ff-only', '-q', `origin/${t.ws.branch}`).code, 0);
  assert.ok(ranHooks(log).includes('post-merge'));
  assert.ok(ranHooks(log).includes('reference-transaction'));
  assert.notEqual(gitTry(demo, 'commit', '-q', '--allow-empty', '-m', 'x').code, 0, 'pre-commit said no');
  assert.ok(ranHooks(log).includes('pre-commit'));
  fs.rmSync(log);

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
});

test('mergeWork waits a little for another git command in the person’s folder, then says so', async () => {
  const t = await agentRepo();
  write(t.w('a.txt'), 'one\nAGENT\nthree\n');
  const lock = path.join(t.root, '.git', 'index.lock');
  write(lock, '');
  let { expect } = await proposal(t);
  const person = folderPrint(t.root);
  assert.deepEqual(await mergeWork(mergeOpts(t, expect)), { ok: false, why: 'busy', sentence: 'Another git command is busy in your folder. Try again in a moment.' });
  assert.deepEqual(folderPrint(t.root), person);
  assert.equal(headOf(t.root), t.ws.base);
  // Let go while it waits: it goes through.
  ({ expect } = await proposal(t));
  setTimeout(() => fs.rmSync(lock), 150);
  const ok = await mergeWork(mergeOpts(t, expect));
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(t.p('a.txt'), 'utf8'), 'one\nAGENT\nthree\n');
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
  const was = everything(t);
  assert.deepEqual(await discardWork(opts), { ok: false, why: 'changed', sentence: 'Its work changed since you looked. Have another look.' });
  assert.deepEqual(everything(t), was);
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

test('nothing is left behind in the temporary folder', () => {
  assert.deepEqual(fs.readdirSync(tmp).filter(f => f.startsWith('workbench-')), []);
});

test('nothing was written to the real home folder', () => {
  if (!homeWorkbenchExisted) assert.equal(fs.existsSync(homeWorkbench), false);
});
