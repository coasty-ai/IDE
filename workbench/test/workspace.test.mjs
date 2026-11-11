import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareRepo, createWorkspace, removeWorkspace, diffStats, readRepoConfig, normalizeConfig, slugify, workspacesFolder } from '../src/core/workspace.mjs';
import { checkRules } from '../src/core/receipt.mjs';

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

test('nothing was written to the real home folder', () => {
  if (!homeWorkbenchExisted) assert.equal(fs.existsSync(homeWorkbench), false);
});
