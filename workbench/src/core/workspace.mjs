// Git workspaces. Each agent works in its own git worktree, made from the repository's last commit,
// so agents never touch the person's working folder or each other's files. Also: the numbers for
// the receipt (what changed since the workspace was made), the repository's workbench.json, and source
// control: an agent's work as git objects, its diff, merging it into the person's branch with a merge
// commit, throwing it away, and the commit graph.
//
// Every git call goes through execFile with an argument array and a timeout.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip } from '../shared/format.mjs';

const GIT_TIMEOUT_MS = 30_000;
const WORKTREE_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const COUNT_FILE_MAX_BYTES = 2 * 1024 * 1024; // untracked files bigger than this are listed without a line count
const COUNT_TOTAL_MAX_BYTES = 64 * 1024 * 1024; // stop reading untracked files after this much
const LIMITS = { checks: 20, rules: 100, allow: 100 };
const DEFAULT_CHECK_TIMEOUT_SEC = 300;

// Variables that would point git at a different repository than the folder we ask about.
const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX'];

function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', LANG: 'C' };
  for (const k of GIT_REDIRECTS) delete env[k];
  return env;
}

/**
 * Settings for every git command the engine runs. core.fsmonitor names a program that git status starts; an agent
 * that managed to change the repository's config must not get a program run inside the engine that way.
 */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false'];

/**
 * Run git with an argument array.
 * @param {{ cwd?: string, timeout?: number, input?: string, okCodes?: number[], env?: Record<string, string> }} [o]
 *   input goes to git's stdin; okCodes are exit codes that still count as success (check-ignore exits 1 when
 *   nothing matches); env adds variables after the scrub (a temporary GIT_INDEX_FILE, who a commit is by)
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>} code is 0 or one of okCodes; rejects with the
 *   execFile error (plus .stdout and .stderr)
 */
export function git(args, { cwd, timeout = GIT_TIMEOUT_MS, input, okCodes = [], env } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = env ? { ...gitEnv(), ...env } : gitEnv();
    const child = execFile('git', [...GIT_SAFE_CONFIG, ...args], { cwd, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: childEnv, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !(typeof err.code === 'number' && okCodes.includes(err.code) && !err.killed)) {
        err.stdout = stdout;
        err.stderr = String(stderr || '');
        reject(err);
      } else {
        resolve({ stdout, stderr, code: err ? err.code : 0 });
      }
    });
    if (input != null) {
      child.stdin.on('error', () => {}); // git may finish before reading all of it
      child.stdin.end(input);
    }
  });
}

/** An error whose message a person can read; git's own words go in `.detail`. */
function plainError(message, cause) {
  const e = new Error(message);
  e.plain = true;
  if (cause) {
    e.cause = cause;
    e.detail = String(cause.stderr || cause.message || '').trim();
  }
  return e;
}

/** A plain error for the ways git itself can fail to run, or null. */
function gitTrouble(e) {
  if (e && e.code === 'ENOENT') return plainError('Git is not installed, or it is not on the PATH.', e);
  if (e && e.killed) return plainError('Git took too long and was stopped.', e);
  if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return plainError('Git gave back more than Workbench can read at once.', e);
  return null;
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0].replace(/^(fatal|error): /, '');
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p;
}

/** The real path of a repository root that must exist. */
function realRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) throw plainError('No repository folder was given.');
  try {
    return fs.realpathSync.native(path.resolve(expandHome(repoRoot.trim())));
  } catch {
    throw plainError(`The repository folder ${repoRoot} does not exist.`);
  }
}

/** A revision we pass to git: no options, no ranges, nothing git would read as a path. */
function validRef(ref) {
  const r = String(ref ?? '');
  if (!/^[A-Za-z0-9._/@^~{}+-]{1,200}$/.test(r) || r.startsWith('-') || r.includes('..')) {
    throw plainError(`“${clip(r, 40)}” is not a commit git can look up.`);
  }
  return r;
}

/** "Fix the flaky checkout test!" -> "fix-the-flaky-checkout-test". Safe in a branch and a folder name. */
export function slugify(text, max = 40) {
  let s = String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-[^-]*$/, '') || s.slice(0, max);
  return s.replace(/-+$/g, '') || 'task';
}

/** The folder that holds one repository's workspaces: <base>/<repoName>-<8 hex of sha1(root)>. */
export function workspacesFolder(repoRoot, baseDir) {
  const root = realRoot(repoRoot);
  const base = baseDir ? path.resolve(expandHome(String(baseDir))) : path.join(os.homedir(), '.workbench', 'worktrees');
  const name = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'repo';
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
  return path.join(base, `${name}-${hash}`);
}

// ---------------------------------------------------------------------------------------------

/**
 * Check a repository and describe it.
 * @param {string} p a folder inside the repository
 * @returns {Promise<{ root: string, name: string, head: string, branch: string|null, dirty: number }>}
 *   branch is null when HEAD is detached; dirty counts uncommitted changes (agents will not see them).
 */
export async function prepareRepo(p) {
  if (typeof p !== 'string' || !p.trim()) throw plainError('No repository folder was given.');
  const abs = path.resolve(expandHome(p.trim()));
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw plainError(`The folder ${abs} does not exist.`);
  }
  if (!st.isDirectory()) throw plainError(`${abs} is a file, not a folder.`);

  let top;
  try {
    top = (await git(['rev-parse', '--show-toplevel'], { cwd: abs })).stdout.trim();
  } catch (e) {
    throw gitTrouble(e) || plainError(`${abs} is not a git repository.`, e);
  }
  if (!top) throw plainError(`${abs} is not a git repository with a working folder.`);
  const root = fs.realpathSync.native(top);

  let head;
  try {
    head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root })).stdout.trim();
  } catch (e) {
    throw gitTrouble(e) || plainError(`The repository at ${root} has no commits yet. Make a first commit, then try again.`, e);
  }
  if (!head) throw plainError(`The repository at ${root} has no commits yet. Make a first commit, then try again.`);

  let branch = null;
  try {
    branch = await currentBranch(root);
  } catch {
    branch = null; // detached HEAD
  }
  return { root, name: path.basename(root), head, branch, dirty: await countDirty(root) };
}

/**
 * The branch HEAD is on, as its full name without refs/heads/ ("main"; never git's "heads/main", which
 * `symbolic-ref --short` gives when a tag has the same name), or null when HEAD is detached.
 */
async function currentBranch(cwd, run = git) {
  const r = await run(['symbolic-ref', '--quiet', 'HEAD'], { cwd, okCodes: [1] });
  const ref = r.code === 0 ? r.stdout.trim() : '';
  return ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length ? ref.slice('refs/heads/'.length) : null;
}

async function countDirty(root) {
  const out = (await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: root })).stdout;
  const fields = out.split('\0');
  let n = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    n++;
    if (f[0] === 'R' || f[0] === 'C') i++; // a rename or copy is followed by its original path
  }
  return n;
}

/**
 * Make a worktree for one agent from the repository's HEAD commit.
 * Runs `git worktree add -b workbench/<slug>-<agentId> <path> HEAD`.
 * @param {{ repoRoot: string, agentId: string, slug?: string, baseDir?: string }} opts
 *   baseDir replaces ~/.workbench/worktrees (tests use a temporary folder).
 * @returns {Promise<{ path: string, branch: string, base: string }>} base is the commit it started from
 */
export async function createWorkspace({ repoRoot, agentId, slug, baseDir } = {}) {
  const root = realRoot(repoRoot);
  const id = String(agentId ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id)) throw plainError('The agent id cannot be used to name a workspace.');
  const s = slugify(slug);
  const folder = workspacesFolder(root, baseDir);
  const wsPath = path.join(folder, `${s}-${id}`);
  const branch = `workbench/${s}-${id}`;
  fs.mkdirSync(folder, { recursive: true });
  if (fs.existsSync(wsPath)) throw plainError(`A workspace already exists at ${wsPath}.`);
  // Only a branch that is not there yet may be taken away again below: one that is could hold kept work.
  const fresh = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, okCodes: [1] })
    .then(r => r.stdout.trim() === '', () => false);
  try {
    await git(['worktree', 'add', '-b', branch, wsPath, 'HEAD'], { cwd: root, timeout: WORKTREE_TIMEOUT_MS });
  } catch (e) {
    // Stopped part-way (a Ctrl-C in the terminal reaches git too, or a post-checkout hook failed): git takes a half-made
    // folder away itself, but not the branch it made first, nor a folder it finished.
    if (fresh) await takeBack(root, wsPath, branch);
    throw gitTrouble(e) || plainError(`Git could not make a workspace for this agent: ${firstLine(e.stderr)}`, e);
  }
  try {
    const real = fs.realpathSync.native(wsPath);
    const base = (await git(['rev-parse', 'HEAD'], { cwd: real })).stdout.trim();
    return { path: real, branch, base };
  } catch (e) {
    await takeBack(root, wsPath, branch);
    throw gitTrouble(e) || plainError(`Git could not make a workspace for this agent: ${firstLine(e.stderr || e.message)}`, e);
  }
}

/** Nothing has run in a new workspace yet: take it and its branch away again. */
async function takeBack(root, wsPath, branch) {
  await git(['worktree', 'remove', '--force', wsPath], { cwd: root, timeout: WORKTREE_TIMEOUT_MS }).catch(() => {});
  await git(['branch', '-D', branch], { cwd: root }).catch(() => {});
}

function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Worktrees git knows for a repository: [{ path, branch|null, locked }]. */
async function listWorktrees(root, run = git) {
  const out = (await run(['worktree', 'list', '--porcelain'], { cwd: root })).stdout;
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push(cur = { path: line.slice(9), branch: null, locked: false });
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && (line === 'locked' || line.startsWith('locked '))) cur.locked = true;
  }
  return list;
}

/**
 * Remove an agent's worktree. Only removes folders git lists as worktrees of this repository,
 * never the main folder. The branch is kept unless deleteBranch is set (and it is a workbench/ branch).
 * With onlyIfUnchanged (and the commit it started from, `base`), it removes nothing that might hold work: the folder
 * goes only while its HEAD is still `base`, `git status` lists nothing at all (not even a file .gitignore hides, such
 * as a .env or a build) and `git worktree remove` without --force agrees; then the branch goes only while it still
 * points at `base` (`update-ref -d`). In that order: update-ref would delete the branch of a folder that was kept.
 * @returns {Promise<{ removed: boolean, branch?: string|null, kept?: true }>}
 */
export async function removeWorkspace({ repoRoot, path: wsPath, deleteBranch = false, onlyIfUnchanged = false, base = null } = {}) {
  const root = realRoot(repoRoot);
  if (typeof wsPath !== 'string' || !path.isAbsolute(wsPath)) throw plainError('No workspace folder was given.');
  const target = canonical(wsPath);
  if (target === root) throw plainError('That is the main folder of the repository, not a workspace.');
  const start = onlyIfUnchanged ? validRef(base) : null;
  const entry = (await listWorktrees(root)).find(w => w.path === target || canonical(w.path) === target);
  if (!entry || canonical(entry.path) === root) {
    await git(['worktree', 'prune'], { cwd: root }).catch(() => {});
    return { removed: false };
  }
  if (onlyIfUnchanged) {
    const head = await git(['rev-parse', 'HEAD'], { cwd: entry.path }).then(r => r.stdout.trim(), () => null);
    if (head !== start) return { removed: false, kept: true }; // the agent made commits, or the folder is unreadable
    const status = await git(['status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: entry.path }).then(r => r.stdout, () => null);
    if (status !== '') return { removed: false, kept: true };
    try {
      await git(['worktree', 'remove', entry.path], { cwd: root, timeout: WORKTREE_TIMEOUT_MS });
    } catch {
      return { removed: false, kept: true }; // git found something changed after all: it keeps it, and so do we
    }
    if (deleteBranch && entry.branch && entry.branch.startsWith('workbench/')) {
      await git(['update-ref', '-d', `refs/heads/${entry.branch}`, start], { cwd: root }).catch(() => {});
    }
    try { fs.rmdirSync(path.dirname(entry.path)); } catch {} // the per-repository folder, only if now empty
    return { removed: true, branch: entry.branch };
  }
  try {
    await git(['worktree', 'remove', '--force', entry.path], { cwd: root, timeout: WORKTREE_TIMEOUT_MS });
  } catch (e) {
    if (fs.existsSync(entry.path)) throw gitTrouble(e) || plainError(`Git could not remove the workspace: ${firstLine(e.stderr)}`, e);
    await git(['worktree', 'prune'], { cwd: root }).catch(() => {}); // the folder was already gone
  }
  if (deleteBranch && entry.branch && entry.branch.startsWith('workbench/')) {
    await git(['branch', '-D', entry.branch], { cwd: root }).catch(() => {});
  }
  try {
    fs.rmdirSync(path.dirname(entry.path)); // the per-repository folder, only if now empty
  } catch {}
  return { removed: true, branch: entry.branch };
}

// ---------------------------------------------------------------------------------------------

const nulList = (out) => String(out).split('\0').filter(Boolean);

/** Paths handed to git on its command line, a few hundred at a time, so thousands of them still fit. */
const ARG_BATCH = 500;

/** The parts of a relative path, or null for one that could leave the folder it is relative to. */
function safeParts(rel) {
  const parts = rel.split('/');
  return parts.some(x => x === '' || x === '.' || x === '..') ? null : parts;
}

/**
 * Which of `paths` (relative to the workspace, a folder ending in "/") the ignore rules of commit `ref` would hide.
 * The commit's .gitignore files on the way to each path are written to a scratch folder, and `git check-ignore`
 * reads them there, together with the repository's own info/exclude and the person's global excludes, which are the
 * same now as then. A path inside a hidden folder counts as hidden.
 * - A folder is asked about by its name, made as a real folder in the scratch folder. As "out/", a rule such as
 *   `out/*` would match it (the * matching nothing), although git looks inside out/ and judges each file there.
 *   Made as a folder, rules for folders only (`node_modules/`) still apply to it.
 * - Every path goes to git as "./<path>", and folder names to ls-tree as literal paths, so a name such as ":!x" or
 *   ":/x" is that file, not pathspec magic (which check-ignore refuses, or reads as a different path).
 */
async function ignoredAt(wsPath, ref, paths, run = git) {
  if (!paths.length) return new Set();
  const dirs = new Set(['']);
  for (const p of paths) {
    const parts = p.replace(/\/+$/, '').split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const wanted = [...dirs].map(d => (d ? `${d}/.gitignore` : '.gitignore'));
  const found = new Map(); // path -> blob id
  for (let i = 0; i < wanted.length; i += ARG_BATCH) {
    const out = (await run(['--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...wanted.slice(i, i + ARG_BATCH)], { cwd: wsPath })).stdout;
    for (const rec of nulList(out)) {
      const m = /^100(644|755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(rec); // a plain file: git does not follow linked ones
      if (m) found.set(m[3], m[2]);
    }
  }
  const gitDir = (await run(['rev-parse', '--absolute-git-dir'], { cwd: wsPath })).stdout.trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ignore-'));
  try {
    for (const [file, oid] of found) {
      const parts = safeParts(file);
      if (!parts) continue;
      const text = (await run(['cat-file', 'blob', oid], { cwd: wsPath })).stdout;
      const dest = path.join(scratch, ...parts);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, text, { flag: 'wx' });
    }
    const asked = paths.map(p => p.replace(/\/+$/, ''));
    paths.forEach((p, i) => {
      const parts = p.endsWith('/') && safeParts(asked[i]);
      if (!parts) return;
      try {
        fs.mkdirSync(path.join(scratch, ...parts), { recursive: true });
      } catch {} // a base .gitignore file sits there: judged without folder-only rules, and its files one by one
    });
    const out = (await run([`--git-dir=${gitDir}`, `--work-tree=${scratch}`, 'check-ignore', '--no-index', '-z', '--stdin'],
      { cwd: scratch, input: asked.map(p => './' + p).join('\0') + '\0', okCodes: [1] })).stdout;
    const hit = new Set(nulList(out).map(p => p.replace(/^\.\//, '')));
    return new Set(paths.filter((p, i) => hit.has(asked[i])));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * New files the agent hid with ignore rules of its own: a .gitignore it wrote (one holding `*` hides itself too) or
 * a change to one the repository had. These are the files the ignore rules hide now but the rules at `ref`, the commit
 * the workspace was made from, would not. A hidden folder is listed file by file, leaving out what the rules at `ref`
 * hid inside it (such as a node_modules folder).
 * @returns {Promise<string[]>} paths relative to the workspace root
 */
async function hiddenByAgent(wsPath, ref, run = git) {
  const list = async (args) => nulList((await run(args, { cwd: wsPath })).stdout);
  // What the ignore rules hide now. A folder git does not look into shows as "folder/" (node_modules/, say). No
  // --no-empty-directory: with it, git leaves out a hidden file in a new folder that also holds a visible file. Without
  // it, git can list a folder and the files inside it too, so the result is a set.
  const now = await list(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (!now.length) return [];
  const before = await ignoredAt(wsPath, ref, now, run);
  const hidden = new Set();
  const folders = [];
  for (const p of now) {
    if (before.has(p)) continue;
    if (p.endsWith('/')) folders.push(p);
    else hidden.add(p);
  }
  for (let i = 0; i < folders.length; i += ARG_BATCH) {
    // Everything inside, ignored or not, judged again by the rules at `ref`. A folder git cannot look into (another
    // repository) comes back as itself.
    const inside = await list(['ls-files', '--others', '-z', '--', ...folders.slice(i, i + ARG_BATCH).map(f => `:(literal)${f}`)]);
    const hiddenBefore = await ignoredAt(wsPath, ref, inside, run);
    for (const p of inside) if (!hiddenBefore.has(p)) hidden.add(p);
  }
  return [...hidden];
}

/**
 * What changed in a workspace since `base`: tracked changes (committed or not) plus new files, including new files
 * hidden by a .gitignore the agent added or changed (marked `ignored`), so they reach the receipt and the rules.
 * @param {{ path: string, base?: string }} opts
 * @returns {Promise<{ changed: number, adds: number, dels: number, list: { path: string, adds: number, dels: number, binary?: true, large?: true, untracked?: true, ignored?: true }[] }>}
 *   Paths are relative to the repository root with forward slashes. Renames count as a deletion
 *   and an addition, so rules see both the old and the new path.
 */
export async function diffStats({ path: wsPath, base } = {}) {
  if (typeof wsPath !== 'string' || !wsPath) throw plainError('No workspace folder was given.');
  if (!fs.existsSync(wsPath)) throw plainError(`The workspace ${wsPath} no longer exists.`);
  const ref = validRef(base || 'HEAD');
  const list = [];
  let out;
  try {
    out = (await git(['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', ref, '--'], { cwd: wsPath })).stdout;
  } catch (e) {
    throw gitTrouble(e) || plainError(`Git could not compare the workspace with its starting point: ${firstLine(e.stderr)}`, e);
  }
  for (const rec of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const entry = { path: m[3], adds: m[1] === '-' ? 0 : Number(m[1]), dels: m[2] === '-' ? 0 : Number(m[2]) };
    if (m[1] === '-') entry.binary = true;
    list.push(entry);
  }

  const others = (await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: wsPath })).stdout.split('\0').filter(Boolean);
  const seen = new Set([...list.map(f => f.path), ...others]);
  let hidden;
  try {
    hidden = (await hiddenByAgent(wsPath, ref)).filter(p => !seen.has(p));
  } catch (e) {
    throw gitTrouble(e) || plainError(`Git could not list the files hidden by the agent's own ignore rules: ${firstLine(e.stderr || e.message)}`, e);
  }
  let budget = COUNT_TOTAL_MAX_BYTES;
  for (const [rel, ignored] of [...others.map(p => [p, false]), ...hidden.map(p => [p, true])]) {
    const c = countLines(path.join(wsPath, rel), budget);
    budget -= c.bytes;
    const entry = { path: rel, adds: c.adds, dels: 0, untracked: true };
    if (ignored) entry.ignored = true;
    if (c.binary) entry.binary = true;
    if (c.large) entry.large = true;
    list.push(entry);
  }
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    changed: list.length,
    adds: list.reduce((n, f) => n + f.adds, 0),
    dels: list.reduce((n, f) => n + f.dels, 0),
    list,
  };
}

/** Lines in a new file, counted the way git does. Never follows links; skips binary and huge files. */
function countLines(file, budget) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { adds: 0, bytes: 0 };
  }
  if (st.isSymbolicLink()) return { adds: 1, bytes: 0 }; // git stores a link as one line: where it points
  if (!st.isFile()) return { adds: 0, bytes: 0 };
  if (st.size > COUNT_FILE_MAX_BYTES || st.size > budget) return { adds: 0, bytes: 0, large: true };
  let buf;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { adds: 0, bytes: 0 };
  }
  if (buf.subarray(0, 8000).includes(0)) return { adds: 0, bytes: buf.length, binary: true };
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  if (buf.length && buf[buf.length - 1] !== 10) n++; // a last line without a newline still counts
  return { adds: n, bytes: buf.length };
}

// ---------------------------------------------------------------------------------------------
// Source control.
//
// "The agent's work" is one set of files, used alike by the diff, the counts, a merge and a throw-away: every tracked
// change in its folder since `since` (committed, staged or not) and every new file no .gitignore hides, the way
// `git add -A` sees them. It is read in a temporary index (a copy of the agent's own), never in the agent's index.
// Links are kept as links. Files that a .gitignore the agent added or changed hides, and repositories inside its
// folder, are left out and named in `left`.
//
// The person's folder only ever sees `git merge --ff-only` to a merge commit built in the object database (merge-tree
// and commit-tree), with --no-autostash and --no-overwrite-ignore: never a real merge, never conflict markers, never
// update-ref on a checked-out branch. Every git command here runs with core.hooksPath set to an empty folder, so no
// hook in the repository runs (commit-tree runs none anyway).

const MIN_GIT = [2, 38, 0]; // merge-tree --write-tree
const MERGE_TIMEOUT_MS = 10 * 60_000; // stopping git half-way through updating the person's folder would be worse than waiting
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_OID = /^0+$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const LARGE_FILE_BYTES = COUNT_FILE_MAX_BYTES; // a changed file bigger than this gets no line counts and no patch
const SUBJECT_MAX = 72;
const NAME_MAX = 80;
const BODY_MAX = 4000;
const PATCH_BATCH_FILES = 64; // patches are asked for this many files at a time...
const PATCH_BATCH_BYTES = 8 * 1024 * 1024; // ...as long as their blobs are not too big together
const LOCK_TRIES = 4; // another git command holding your folder's index.lock (an editor's git, say): wait, then try again
const UNDER_WAY = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];
const WORKBENCH_IDENTITY = { name: 'Workbench', email: 'workbench@localhost' }; // the hidden copy of thrown-away work only
const CLAUDE_TRAILER = 'Co-authored-by: Claude <noreply@anthropic.com>';

const SAY = {
  detached: 'Your folder is not on a branch, so there is nowhere to merge it.',
  busy: 'Your folder is in the middle of a merge or rebase. Finish that first.',
  locked: 'Another git command is busy in your folder. Try again in a moment.',
  identity: 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.',
  gitOld: 'Workbench needs git 2.38 or newer to merge.',
  changed: 'Its work changed since you looked. Have another look.',
  moved: into => `${into} changed since you looked. Have another look.`,
  nothing: into => `Its work is already in ${into}.`,
  ancestry: into => `It started from a commit that is no longer in ${into}, so merging it would bring in other work.`,
  conflict: into => `Its work does not merge cleanly into ${into}.`,
  blocked: paths => `Your own changes are in the way: ${listOf(paths, 3)}. Commit or put them aside, then merge again.`,
  gone: 'Its folder is gone, so there is nothing to merge.',
  agentBusy: 'Its folder is in the middle of a merge or rebase, so its work cannot be merged yet.',
  git: 'Git could not finish the merge. Nothing in your folder changed.',
  unfinished: into => `Git could not finish the merge into ${into}. Have a look at your folder before you try again.`,
};

/** git's words when another git command holds the index: "Unable to create '<git dir>/index.lock': File exists." */
const INDEX_LOCKED = /^(?:fatal|error): Unable to create '[^\n]*index\.lock': File exists/m;

/** "a, b, c and 2 more" */
function listOf(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** A refusal: `why` names the reason (mergeWork's list), `sentence` says it in plain words built from facts. */
class Refusal extends Error {
  constructor(why, sentence, paths) {
    super(sentence);
    this.plain = true;
    this.why = why;
    this.sentence = sentence;
    if (paths) this.paths = paths;
  }
}

/** `{ ok: false, why, sentence, paths? }` for anything thrown: a refusal as it is, anything else as `git`. */
function failure(e, fallback) {
  if (e instanceof Refusal) return e.paths ? { ok: false, why: e.why, sentence: e.sentence, paths: e.paths } : { ok: false, why: e.why, sentence: e.sentence };
  const trouble = gitTrouble(e);
  return { ok: false, why: 'git', sentence: trouble ? trouble.message : e && e.plain ? e.message : fallback };
}

/** An error a person can read, for the functions that throw. */
function readable(e, fallback) {
  if (e && e.plain) return e;
  return gitTrouble(e) || plainError(fallback, e);
}

/** `fn(run)`, where `run` is git() with core.hooksPath set to a new empty folder, removed afterwards. */
async function withoutHooks(fn) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-nohooks-'));
  const run = (args, o) => git(['-c', `core.hooksPath=${empty}`, ...args], o);
  try {
    return await fn(run);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The commit `rev` names (HEAD, refs/heads/<name> or an object id), or null when there is none. */
async function commitOf(cwd, rev, run = git) {
  const r = await run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, okCodes: [1] });
  const id = r.code === 0 ? r.stdout.trim() : '';
  return OID.test(id) ? id : null;
}

async function treeOf(cwd, commit, run = git) {
  const id = (await run(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], { cwd })).stdout.trim();
  if (!OID.test(id)) throw plainError('Git could not read a commit it was given.');
  return id;
}

/** Whether `a` is `b` or one of its ancestors. */
async function isAncestor(cwd, a, b, run = git) {
  return (await run(['merge-base', '--is-ancestor', a, b], { cwd, okCodes: [1] })).code === 0;
}

/** git's version as [major, minor, patch], or null when it cannot be read. Read each time: PATH can change. */
async function gitVersion(run = git) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec((await run(['--version'])).stdout);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Whether a merge, rebase, cherry-pick, revert or bisect is under way in this folder (its own git folder). */
async function underWay(cwd, run = git) {
  const found = await Promise.all(UNDER_WAY.map(async name => {
    const p = (await run(['rev-parse', '--git-path', name], { cwd })).stdout.replace(/\r?\n$/, '');
    return !!p && fs.existsSync(path.resolve(cwd, p));
  }));
  return found.includes(true);
}

/** The real path of a checkout's top folder (the person's main folder), checked with git. */
async function topFolder(run, repoRoot) {
  const root = realRoot(repoRoot);
  let top;
  try {
    top = (await run(['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim();
  } catch (e) {
    throw gitTrouble(e) || plainError(`The folder ${root} is not a git repository.`, e);
  }
  if (!top || canonical(top) !== root) throw plainError(`The folder ${root} is not the top folder of a git repository.`);
  return root;
}

/**
 * The agent's folder, checked: another worktree that git lists for the checkout at `root`, still on disk, on a
 * workbench/ branch (on `branch` itself, when given). Throws a refusal otherwise.
 * @returns {Promise<{ path: string, branch: string, locked: boolean }>}
 */
async function agentFolder(run, root, wsPath, branch) {
  if (typeof wsPath !== 'string' || !path.isAbsolute(wsPath)) throw new Refusal('gone', 'No agent folder was given.');
  const target = canonical(wsPath);
  if (target === root) throw new Refusal('gone', 'That is your own folder, not an agent’s folder.');
  const entry = (await listWorktrees(root, run)).find(w => canonical(w.path) === target);
  if (!entry || !isFolder(target)) throw new Refusal('gone', 'Its folder is gone.');
  if (!entry.branch || !entry.branch.startsWith('workbench/')) {
    throw new Refusal('changed', 'Its folder is no longer on a workbench/ branch, so Workbench leaves it alone.');
  }
  if (branch != null && entry.branch !== branch) {
    throw new Refusal('changed', `Its folder is on the branch ${entry.branch} now, not on ${branch}.`);
  }
  return { path: target, branch: entry.branch, locked: entry.locked };
}

/**
 * Copy an index file for git to use in place of the original, or return false when there is none.
 *
 * Git notes each file's size and times in the index, and trusts a file whose notes still match as unchanged, unless the
 * file is not older than the index itself: then it reads the file again ("racily clean"), because a change in the same
 * second as the index was written leaves the notes matching. A copy is a new file, so git would trust every note in
 * it, and miss such a change for good (a same-size edit made in the second the agent's index was written). So the copy
 * gets the original's time, rounded down to the second and one second earlier: git then reads at least every file it
 * would have read with the original. Never 0: git skips the check altogether for an index time of 0.
 */
function copyIndex(from, to) {
  let st;
  try {
    st = fs.statSync(from);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw plainError('Workbench could not read the git index of its folder.', e);
  }
  try {
    fs.copyFileSync(from, to);
    const t = Math.max(1, Math.floor(st.mtimeMs / 1000) - 1);
    fs.utimesSync(to, t, t);
  } catch (e) {
    if (e.code === 'ENOENT') return false; // replaced between the two steps: start from its HEAD instead
    throw plainError('Workbench could not read the git index of its folder.', e);
  }
  return true;
}

/**
 * The work in an agent's folder as a tree, read in a temporary index. The agent's own index is copied, never written:
 * that keeps what it staged (also a file it added with -f) and git's record of unchanged files (see copyIndex).
 * @returns {Promise<{ head, headTree, tree, since, sinceTree, workId, changed, files, left }>}
 */
async function snap(run, folder, since) {
  const cwd = folder.path;
  const from = String(since ?? '');
  if (!OID.test(from)) throw new Refusal('git', 'Workbench does not know which commit its work started from.');
  if (!(await commitOf(cwd, from, run))) throw new Refusal('git', 'The commit its work started from is no longer in this repository.');
  const head = await commitOf(cwd, 'HEAD', run);
  if (!head) throw new Refusal('git', 'Its folder has no commit checked out.');

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-index-'));
  let tree, others;
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    const own = path.resolve(cwd, (await run(['rev-parse', '--git-path', 'index'], { cwd })).stdout.replace(/\r?\n$/, ''));
    if (!copyIndex(own, env.GIT_INDEX_FILE)) await run(['read-tree', head], { cwd, env });
    // A repository inside the folder shows as "name/". `add -A` would fail on one with no commit yet (and then the
    // tree would look unchanged) or record one with commits as a link to that commit: leave them out, and say so.
    others = nulList((await run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd, env })).stdout);
    const nested = others.filter(p => p.endsWith('/'));
    const add = ['-c', 'core.splitIndex=false', 'add', '-A'];
    if (nested.length) {
      await run([...add, '--pathspec-from-file=-', '--pathspec-file-nul'],
        { cwd, env, timeout: WORKTREE_TIMEOUT_MS, input: ['.', ...nested.map(p => `:(exclude,literal)${p}`)].map(s => `${s}\0`).join('') });
    } else {
      await run(add, { cwd, env, timeout: WORKTREE_TIMEOUT_MS });
    }
    tree = (await run(['write-tree'], { cwd, env })).stdout.trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!OID.test(tree)) throw plainError('Git could not record the agent’s work.');

  const left = [];
  const named = new Set();
  for (const p of others) {
    if (p.endsWith('/')) { left.push({ path: p, why: 'nested-repo' }); named.add(p); }
  }
  for (const p of await hiddenByAgent(cwd, from, run)) {
    if (!named.has(p)) { left.push({ path: p, why: p.endsWith('/') ? 'nested-repo' : 'ignored' }); named.add(p); }
  }
  left.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const [headTree, sinceTree] = await Promise.all([treeOf(cwd, head, run), treeOf(cwd, from, run)]);
  const files = tree === sinceTree ? [] : await changesBetween(run, cwd, sinceTree, tree);
  return { head, headTree, tree, since: from, sinceTree, workId: `${head}:${tree}`, changed: tree !== sinceTree, files, left };
}

const isBlobMode = mode => mode === '100644' || mode === '100755' || mode === '120000';

/**
 * The files that differ between two trees, in git's order: [{ path, status, adds, dels, binary?, large? }], plus the
 * blob sizes (oldSize, newSize) that workDiff plans its patches with. No rename detection.
 */
async function changesBetween(run, cwd, from, to) {
  const common = ['-c', `core.bigFileThreshold=${LARGE_FILE_BYTES}`, 'diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const raw = (await run([...common, '--raw', '--no-abbrev', from, to], { cwd })).stdout.split('\0');
  const files = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(raw[i]);
    if (!m) throw plainError('Git listed the changes in a way Workbench does not understand.');
    files.push({
      path: raw[i + 1], status: m[5] === 'A' ? 'added' : m[5] === 'D' ? 'deleted' : 'modified',
      oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], adds: 0, dels: 0, oldSize: 0, newSize: 0,
    });
  }
  if (!files.length) return files;

  const counts = new Map();
  for (const rec of (await run([...common, '--numstat', from, to], { cwd })).stdout.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (m) counts.set(m[3], m);
  }
  const ids = new Set();
  for (const f of files) {
    if (isBlobMode(f.oldMode) && !ZERO_OID.test(f.oldId)) ids.add(f.oldId);
    if (isBlobMode(f.newMode) && !ZERO_OID.test(f.newId)) ids.add(f.newId);
  }
  const sizes = new Map();
  if (ids.size) {
    const out = (await run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { cwd, input: [...ids].join('\n') + '\n' })).stdout;
    for (const line of out.split('\n')) {
      const [id, size] = line.split(' ');
      if (OID.test(id || '') && /^\d+$/.test(size || '')) sizes.set(id, Number(size));
    }
  }
  for (const f of files) {
    f.oldSize = sizes.get(f.oldId) || 0;
    f.newSize = sizes.get(f.newId) || 0;
    const m = counts.get(f.path);
    if (m && m[1] !== '-') {
      f.adds = Number(m[1]);
      f.dels = Number(m[2]);
    }
    if (Math.max(f.oldSize, f.newSize) > LARGE_FILE_BYTES) f.large = true;
    else if (m && m[1] === '-') f.binary = true;
  }
  return files;
}

function publicFile(f) {
  const out = { path: f.path, status: f.status, adds: f.adds, dels: f.dels };
  if (f.binary) out.binary = true;
  if (f.large) out.large = true;
  return out;
}

/**
 * The agent's work as git objects. Never writes the agent's index or files, and runs no hook.
 * @param {{ repoRoot: string, path: string, since: string }} opts repoRoot: the person's checkout (prepareRepo().root);
 *   path: the agent's folder; since: the commit its unmerged work starts from (40 or 64 hex)
 * @returns {Promise<{ head: string, tree: string, since: string, workId: string, changed: boolean,
 *   files: { path: string, status: 'added'|'modified'|'deleted', adds: number, dels: number, binary?: true, large?: true }[],
 *   left: { path: string, why: 'ignored'|'nested-repo' }[] }>}
 *   head: its folder's HEAD; tree: the work as a tree; workId: `${head}:${tree}`; changed: tree differs from since's.
 *   Rejects with a plain error (with `.why` when it is a refusal) when the folder is not an agent's or git fails.
 */
export async function snapshotWork({ repoRoot, path: wsPath, since } = {}) {
  try {
    return await withoutHooks(async run => {
      const s = await snap(run, await agentFolder(run, await topFolder(run, repoRoot), wsPath), since);
      return { head: s.head, tree: s.tree, since: s.since, workId: s.workId, changed: s.changed, files: s.files.map(publicFile), left: s.left };
    });
  } catch (e) {
    throw readable(e, 'Git could not read the agent’s work.');
  }
}

/** Patches of single files, made the way the spec asks (--no-ext-diff --no-textconv --no-color --no-renames, unquoted paths). */
const PATCH = ['-c', 'core.quotePath=false', '-c', `core.bigFileThreshold=${LARGE_FILE_BYTES}`, '--literal-pathspecs',
  'diff-tree', '-r', '-p', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

/** A diff split into its files. A header can only start a line: every line of content starts with " ", "+", "-" or "\". */
function splitPatches(text) {
  const starts = [];
  if (text.startsWith('diff --git ')) starts.push(0);
  for (let k = text.indexOf('\ndiff --git '); k >= 0; k = text.indexOf('\ndiff --git ', k + 1)) starts.push(k + 1);
  return starts.map((s, n) => text.slice(s, n + 1 < starts.length ? starts[n + 1] : text.length));
}

/** The patches of `paths` (in git's order), asked for together, or one by one when the answer does not line up. */
async function patchesOf(run, cwd, from, to, paths) {
  if (!paths.length) return [];
  const parts = splitPatches((await run([...PATCH, from, to, '--', ...paths], { cwd })).stdout);
  const lineUp = parts.length === paths.length &&
    parts.every((p, k) => p.startsWith(`diff --git a/${paths[k]} b/${paths[k]}\n`) || p.startsWith('diff --git "'));
  if (lineUp) return parts;
  const out = [];
  for (const p of paths) out.push(splitPatches((await run([...PATCH, from, to, '--', p], { cwd })).stdout)[0] || '');
  return out;
}

/** `text` cut to at most `maxBytes` bytes at the end of a line, or null when it fits. */
function cutAt(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return null;
  const head = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  const nl = head.lastIndexOf('\n');
  return nl >= 0 ? head.slice(0, nl + 1) : '';
}

/**
 * The diff of the agent's work against `since`, for people to read. Never writes the agent's index or files.
 * @param {{ repoRoot: string, path: string, since: string, maxFiles?: number, maxFileBytes?: number, maxTotalBytes?: number }} opts
 * @returns {Promise<{ workId: string, since: string, head: string,
 *   files: { path, status, adds, dels, binary?: true, large?: true, patch: string|null, cut?: true }[],
 *   left: { path: string, why: 'ignored'|'nested-repo' }[], cut?: true, omitted: number }>}
 *   patch: that file's unified diff, `diff --git` header included; null for a binary or large file, and for a file
 *   past maxTotalBytes (then with cut: true). cut on a file: its patch was cut (at a line end) at maxFileBytes or at what
 *   was left of maxTotalBytes; cut on the whole: maxTotalBytes was reached. omitted: files past maxFiles, not listed.
 */
export async function workDiff({ repoRoot, path: wsPath, since, maxFiles = 300, maxFileBytes = 200_000, maxTotalBytes = 2_000_000 } = {}) {
  try {
    return await withoutHooks(async run => {
      const folder = await agentFolder(run, await topFolder(run, repoRoot), wsPath);
      const s = await snap(run, folder, since);
      const limit = Math.max(0, Math.floor(Number(maxFiles)) || 0);
      const shown = s.files.slice(0, limit);
      const files = shown.map(f => ({ ...publicFile(f), patch: null }));
      let budget = Math.max(0, Number(maxTotalBytes) || 0);
      const perFile = Math.max(0, Number(maxFileBytes) || 0);
      let cutAll = false;
      const want = shown.flatMap((f, k) => (f.binary || f.large ? [] : [k])); // the files that get a patch
      const reached = new Set();
      for (let i = 0; i < want.length && budget > 0;) {
        const batch = [];
        let bytes = 0;
        for (; i < want.length && batch.length < PATCH_BATCH_FILES; i++) {
          const f = shown[want[i]];
          const guess = 2 * (f.oldSize + f.newSize) + 512;
          if (batch.length && bytes + guess > PATCH_BATCH_BYTES) break;
          batch.push(want[i]);
          bytes += guess;
        }
        const patches = await patchesOf(run, folder.path, s.sinceTree, s.tree, batch.map(k => shown[k].path));
        for (const [n, k] of batch.entries()) {
          if (budget <= 0) break;
          reached.add(k);
          let p = patches[n] || '';
          let cut = false;
          const forFile = cutAt(p, perFile);
          if (forFile !== null) { p = forFile; cut = true; }
          const forAll = cutAt(p, budget);
          if (forAll !== null) { p = forAll; cut = true; cutAll = true; }
          budget -= Buffer.byteLength(p);
          files[k].patch = p || null; // cut down to nothing: no patch, but marked cut
          if (cut) files[k].cut = true;
        }
      }
      for (const k of want) {
        if (!reached.has(k)) { files[k].cut = true; cutAll = true; } // no room left within maxTotalBytes
      }
      const out = { workId: s.workId, since: s.since, head: s.head, files, left: s.left, omitted: s.files.length - shown.length };
      if (cutAll) out.cut = true;
      return out;
    });
  } catch (e) {
    throw readable(e, 'Git could not show the agent’s changes.');
  }
}

/** Who commits: user.name and user.email from git config (git's guessed identity never counts), or null. */
async function identityAt(run, cwd) {
  const read = async key => {
    const r = await run(['config', '--get', key], { cwd, okCodes: [1] });
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, '').trim() : '';
  };
  const name = await read('user.name');
  const email = await read('user.email');
  if (!name || !email || /[\u0000-\u001f\u007f<>]/.test(name + email)) return null;
  return { name, email };
}

/**
 * Who commits: the person's configured identity (both user.name and user.email set), or null. Git's guessed identity
 * (user@host) never counts, and neither does GIT_AUTHOR_NAME and the like in Workbench's own environment.
 * @param {{ repoRoot: string }} opts
 * @returns {Promise<{ name: string, email: string } | null>}
 */
export async function gitIdentity({ repoRoot } = {}) {
  try {
    return await identityAt(git, realRoot(repoRoot));
  } catch {
    return null;
  }
}

/** One line for a commit message: no control or direction-changing characters, cut at a word end to `max`. */
function oneLine(text, max) {
  const t = String(text ?? '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const sp = t.slice(0, max + 1).lastIndexOf(' ');
  return (sp > max / 2 ? t.slice(0, sp) : t.slice(0, max)).trim();
}

/** The agent's summary for a commit body: plain lines, no control or direction-changing characters, a sensible size. */
function bodyText(text) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  t = t.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > BODY_MAX) {
    const nl = t.slice(0, BODY_MAX).lastIndexOf('\n');
    t = (nl > BODY_MAX / 2 ? t.slice(0, nl) : t.slice(0, BODY_MAX)).trim();
  }
  return t;
}

/** commit-tree, as `who`, with a UTF-8 message from stdin. It runs no hook and signs nothing. */
async function commitTree(run, cwd, tree, parents, message, who) {
  const args = ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', '--no-gpg-sign', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-F', '-');
  const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  const id = (await run(args, { cwd, input: message, env })).stdout.trim();
  if (!OID.test(id)) throw plainError('Git could not make the commit.');
  return id;
}

/**
 * The paths git lists, one per line after a tab, under its headings for files in the way of a merge: "Your local
 * changes to the following files would be overwritten by merge:", "The following untracked working tree files would
 * be overwritten by merge:" (or "removed by merge"), "Updating the following directories would lose untracked files in
 * them:", and "... are not up to date:" for a sparse checkout. Lines under any other heading are not paths.
 */
function inTheWay(stderr) {
  const paths = [];
  let under = false;
  for (const line of String(stderr || '').split('\n')) {
    if (line.startsWith('\t')) {
      if (under && line.length > 1) paths.push(line.slice(1));
      continue;
    }
    under = /(?:would be (?:overwritten|removed) by|would lose untracked files in them|are not up to date):$/.test(line);
  }
  return [...new Set(paths)];
}

/**
 * Commit the agent's work on its own branch, then join it into the person's current branch with a merge commit, in
 * the person's folder, by fast-forward only. Every refusal before the work commit changes nothing at all; `conflict`,
 * `blocked` and the later refusals leave the work commit W on the agent's branch (its index reset to match, its files
 * untouched) and change nothing in the person's folder.
 * @param {{ repoRoot: string, path: string, branch: string, since: string,
 *   expect: { workId: string, into: string, intoHead: string }, message: { subject: string, body?: string, name?: string },
 *   agentId: string, harness?: string, name?: string }} opts
 *   name: the agent's name for the merge commit's subject ("Merge <name>: <subject>"); its branch when not given
 * @returns {Promise<{ ok: true, into: string, merge: string, work: string, files: number, adds: number, dels: number }
 *   | { ok: false, why: string, sentence: string, paths?: string[] }>}
 *   why: 'detached' | 'busy' | 'identity' | 'git-old' | 'changed' | 'moved' | 'nothing' | 'ancestry' | 'conflict' |
 *   'blocked' | 'gone' | 'git'. Never rejects.
 */
export async function mergeWork(opts = {}) {
  try {
    return await withoutHooks(run => merge(run, opts));
  } catch (e) {
    return failure(e, SAY.git);
  }
}

async function merge(run, { repoRoot, path: wsPath, branch, since, expect, message, agentId, harness, name } = {}) {
  const id = String(agentId ?? '');
  if (!AGENT_ID.test(id)) throw new Refusal('git', 'Workbench could not tell which agent this is, so nothing was merged.');
  const exp = expect && typeof expect === 'object' ? expect : {};

  // 1. The person's folder, read afresh.
  const root = await topFolder(run, repoRoot);
  const into = await currentBranch(root, run);
  if (!into) throw new Refusal('detached', SAY.detached);
  if (await underWay(root, run)) throw new Refusal('busy', SAY.busy);
  const who = await identityAt(run, root);
  if (!who) throw new Refusal('identity', SAY.identity);
  if (!atLeast(await gitVersion(run), MIN_GIT)) throw new Refusal('git-old', SAY.gitOld);
  const intoHead = await commitOf(root, 'HEAD', run);
  const seen = typeof exp.into === 'string' && exp.into ? exp.into : into;
  if (into !== exp.into || !intoHead || intoHead !== exp.intoHead) throw new Refusal('moved', SAY.moved(seen));

  // 2. The agent's work, read afresh.
  let folder;
  try {
    folder = await agentFolder(run, root, wsPath, branch);
  } catch (e) {
    if (e instanceof Refusal && e.why === 'gone') throw new Refusal('gone', SAY.gone);
    throw e;
  }
  if (await underWay(folder.path, run) || (await run(['ls-files', '-u', '-z'], { cwd: folder.path })).stdout) {
    throw new Refusal('git', SAY.agentBusy);
  }
  const s = await snap(run, folder, since);
  if (s.workId !== exp.workId) throw new Refusal('changed', SAY.changed);
  if (!s.changed) throw new Refusal('nothing', SAY.nothing(into));

  // 3. Its start must be in the person's branch, or the merge would bring in another branch's commits.
  if (!(await isAncestor(root, s.since, intoHead, run))) throw new Refusal('ancestry', SAY.ancestry(into));

  // 4. The work commit W, on the agent's branch.
  const agentName = oneLine(name ?? message?.name, NAME_MAX) || folder.branch;
  const subject = oneLine(message?.subject, SUBJECT_MAX) || oneLine(`Work by ${agentName}`, SUBJECT_MAX);
  let work = s.head;
  if (s.tree !== s.headTree) {
    const body = bodyText(message?.body);
    const lines = [subject, ''];
    if (body) lines.push(body, '');
    lines.push(`Workbench-Agent: ${id}`, 'Workbench-Kind: work');
    if (harness === 'claude') lines.push(CLAUDE_TRAILER);
    work = await commitTree(run, root, s.tree, [s.head], lines.join('\n') + '\n', who);
    const ref = `refs/heads/${folder.branch}`;
    const moved = await run(['update-ref', '-m', 'workbench: the agent’s work as a commit', ref, work, s.head], { cwd: root, okCodes: [1, 128] });
    if (moved.code !== 0) throw new Refusal('changed', SAY.changed); // it made a commit meanwhile
    try {
      await run(['reset', '-q'], { cwd: folder.path }); // its index now matches W; its files are untouched
    } catch {
      const back = await run(['update-ref', '-m', 'workbench: put back', ref, s.head, work], { cwd: root, okCodes: [1, 128] }).catch(() => null);
      throw new Refusal('git', back && back.code === 0
        ? 'Git could not update its folder, so nothing was merged. Try again in a moment.'
        : `Git could not update its folder, so nothing was merged. Its work is safe as a commit on its branch ${folder.branch}.`);
    }
  }

  // 5. Already in the person's branch (merged by hand, say).
  if (await isAncestor(root, work, intoHead, run)) throw new Refusal('nothing', SAY.nothing(into));

  // 6. The merge, worked out in the object database. Git's own merge base, not `since`: an agent that merged the
  //    person's branch into its own would otherwise get false conflicts. Nothing is written to the person's folder.
  const mt = await run(['merge-tree', '--write-tree', '--name-only', '-z', intoHead, work], { cwd: root, okCodes: [1], timeout: WORKTREE_TIMEOUT_MS });
  const fields = mt.stdout.split('\0');
  if (!OID.test(fields[0])) throw new Refusal('git', SAY.git); // exit 1 without a tree is an error, not a conflict
  if (mt.code === 1) {
    const end = fields.indexOf('', 1);
    const paths = [...new Set(fields.slice(1, end < 0 ? fields.length : end))];
    throw new Refusal('conflict', SAY.conflict(into), paths);
  }

  // 7. The merge commit M: the person's HEAD first, W second.
  const mergeMessage = `Merge ${agentName}: ${subject}\n\nWorkbench-Agent: ${id}\nWorkbench-Kind: merge\n`;
  const mergeCommit = await commitTree(run, root, fields[0], [intoHead, work], mergeMessage, who);

  // 8. Check again, then fast-forward the person's folder to M. Git refuses, changing nothing, when their own
  //    changes or files are in the way; ignored files count (--no-overwrite-ignore), and nothing is stashed.
  //    No automatic upkeep (gc) is started in their repository either.
  const ff = ['-c', 'submodule.recurse=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-verify-signatures', '-q', mergeCommit];
  const done = {
    ok: true, into, merge: mergeCommit, work,
    files: s.files.length, adds: s.files.reduce((n, f) => n + f.adds, 0), dels: s.files.reduce((n, f) => n + f.dels, 0),
  };
  let r;
  for (let attempt = 1; ; attempt++) {
    const [on, at, busy] = await Promise.all([currentBranch(root, run), commitOf(root, 'HEAD', run), underWay(root, run)]);
    if (on !== into || at !== intoHead) throw new Refusal('moved', SAY.moved(into));
    if (busy) throw new Refusal('busy', SAY.busy);
    r = await run(ff, { cwd: root, okCodes: [1, 128], timeout: MERGE_TIMEOUT_MS });
    // Another git command holds the index (an editor's git, say): git stopped before it changed anything (exit 1 on
    // newer git, 128 on older). Wait a little, then try again.
    if (r.code === 0 || !INDEX_LOCKED.test(r.stderr)) break;
    if (attempt >= LOCK_TRIES) throw new Refusal('busy', SAY.locked);
    await sleep(200 * attempt);
  }
  const [on, at, busy] = await Promise.all([currentBranch(root, run), commitOf(root, 'HEAD', run), underWay(root, run)]);
  if (r.code === 0) {
    if (on !== into || (at !== mergeCommit && !(at && (await isAncestor(root, mergeCommit, at, run))))) {
      throw new Refusal('git', SAY.unfinished(into));
    }
    return done;
  }
  if (on === into && at === mergeCommit) return done; // it moved the branch, then complained about something after
  if (r.code === 1) {
    // Their own changes or files are in the way: git checks every path before it writes any, so nothing changed.
    const paths = inTheWay(r.stderr);
    if (paths.length && on === into && at === intoHead) throw new Refusal('blocked', SAY.blocked(paths), paths);
  } else {
    // Exit 128: git stopped before it began (another operation started, or the branch moved meanwhile).
    if (busy) throw new Refusal('busy', SAY.busy);
    if (on !== into || at !== intoHead) throw new Refusal('moved', SAY.moved(into));
  }
  // Anything else may have stopped part-way through updating their files, so say nothing about them having stayed.
  throw new Refusal('git', SAY.unfinished(into));
}

/**
 * Remove the agent's folder and branch, keeping a hidden copy of its work at refs/workbench/discarded/<agentId> (with a
 * reflog, so an earlier copy under that name is not lost). The copy holds its work set (see snapshotWork); ignored files
 * and repositories inside its folder go with the folder. When the folder is already gone, the branch still goes, and
 * the copy is the branch's last commit.
 * @param {{ repoRoot: string, path: string, branch: string, since: string, expect: { workId: string }, agentId: string }} opts
 *   expect.workId may be null when the folder is already gone
 * @returns {Promise<{ ok: true, saved: string } | { ok: false, why: 'changed'|'gone'|'git', sentence: string }>} never rejects
 */
export async function discardWork(opts = {}) {
  try {
    return await withoutHooks(run => discard(run, opts));
  } catch (e) {
    return failure(e, 'Git could not throw its work away. Nothing was deleted.');
  }
}

async function discard(run, { repoRoot, path: wsPath, branch, since, expect, agentId } = {}) {
  const id = String(agentId ?? '');
  if (!AGENT_ID.test(id)) throw new Refusal('git', 'Workbench could not tell which agent this is, so nothing was thrown away.');
  const b = String(branch ?? '');
  if (!b.startsWith('workbench/') || b.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) {
    throw new Refusal('git', 'That is not a branch Workbench made, so nothing was thrown away.');
  }
  const exp = expect && typeof expect === 'object' ? expect : {};
  const root = await topFolder(run, repoRoot);
  const saved = `refs/workbench/discarded/${id}`;
  const note = `workbench: threw away ${b}`;
  const target = typeof wsPath === 'string' && path.isAbsolute(wsPath) ? canonical(wsPath) : null;
  if (target === root) throw new Refusal('git', 'That is your own folder, not an agent’s folder.');
  const entry = target ? (await listWorktrees(root, run)).find(w => canonical(w.path) === target) : null;

  if (entry && isFolder(target)) {
    const folder = await agentFolder(run, root, wsPath, b);
    const s = await snap(run, folder, since);
    if (s.workId !== exp.workId) throw new Refusal('changed', SAY.changed);
    const copy = s.tree === s.headTree ? s.head : await commitTree(run, root, s.tree, [s.head],
      `Thrown away: ${b}\n\nWorkbench-Agent: ${id}\nWorkbench-Kind: discarded\n`, (await identityAt(run, root)) || WORKBENCH_IDENTITY);
    await run(['update-ref', '--create-reflog', '-m', note, saved, copy], { cwd: root });
    try {
      await run(['worktree', 'remove', '--force', ...(folder.locked ? ['--force'] : []), folder.path], { cwd: root, timeout: WORKTREE_TIMEOUT_MS });
    } catch {
      if (fs.existsSync(folder.path)) throw new Refusal('git', `Git could not delete its folder ${folder.path}. A copy of its work is kept in git as ${saved}.`);
      await run(['worktree', 'prune'], { cwd: root }).catch(() => {});
    }
    const gone = await run(['update-ref', '-m', note, '-d', `refs/heads/${b}`, s.head], { cwd: root, okCodes: [1, 128] });
    if (gone.code !== 0) throw new Refusal('git', `Its folder is gone, but its branch ${b} changed meanwhile, so it was kept. A copy of its work is kept in git as ${saved}.`);
    try { fs.rmdirSync(path.dirname(folder.path)); } catch {} // the per-repository folder, only if now empty
    return { ok: true, saved };
  }

  // The folder is already gone: still delete the branch, keeping its last commit.
  if (entry) {
    if (entry.locked) await run(['worktree', 'unlock', entry.path], { cwd: root }).catch(() => {});
    await run(['worktree', 'prune'], { cwd: root }).catch(() => {});
  }
  const tip = await commitOf(root, `refs/heads/${b}`, run);
  if (!tip) throw new Refusal('gone', 'Its folder and its branch are already gone.');
  if ((await listWorktrees(root, run)).some(w => w.branch === b)) {
    throw new Refusal('git', `Its branch ${b} is checked out in another folder, so Workbench left it alone.`);
  }
  if (exp.workId != null && exp.workId !== `${tip}:${await treeOf(root, tip, run)}`) throw new Refusal('changed', SAY.changed);
  await run(['update-ref', '--create-reflog', '-m', note, saved, tip], { cwd: root });
  const gone = await run(['update-ref', '-m', note, '-d', `refs/heads/${b}`, tip], { cwd: root, okCodes: [1, 128] });
  if (gone.code !== 0) throw new Refusal('changed', SAY.changed);
  return { ok: true, saved };
}

const GRAPH_FORMAT = ['%H', '%P', '%an', '%at', '%s',
  '%(trailers:key=Workbench-Agent,valueonly,unfold,separator=%x2C)', '%(trailers:key=Workbench-Kind,valueonly,unfold,separator=%x2C)',
].join('%x00') + '%x00';

const lastValue = s => String(s || '').split(',').map(v => v.trim()).filter(Boolean).pop() || '';

/**
 * The commit graph for the git screen: HEAD plus every refs/heads/workbench/* branch, newest first in topological order.
 * @param {{ repoRoot: string, limit?: number }} opts
 * @returns {Promise<{ ok: true, head: string, branch: string|null, more: boolean,
 *   commits: { id, parents: string[], subject, author, at: number, refs: string[], agentId: string|null, kind: 'commit'|'merge'|'work' }[] }
 *   | { ok: false, why: 'git', sentence: string }>}
 *   at: author time in ms; refs: the short names of local branches at that commit (the person's branch first);
 *   agentId and kind come from the commit's own Workbench-Agent and Workbench-Kind trailers, never from its subject
 *   ('merge' needs two parents too). Never rejects.
 */
export async function gitGraph({ repoRoot, limit = 200 } = {}) {
  try {
    return await withoutHooks(async run => {
      const root = await topFolder(run, repoRoot);
      const n = Math.max(1, Math.min(5000, Math.floor(Number(limit)) || 200));
      const head = await commitOf(root, 'HEAD', run);
      if (!head) throw new Refusal('git', `The repository at ${root} has no commits yet.`);
      const branch = await currentBranch(root, run);
      const names = new Map(); // commit -> short branch names
      const tips = [head];
      for (const line of (await run(['for-each-ref', '--format=%(objectname)%00%(refname)', 'refs/heads/'], { cwd: root })).stdout.split('\n')) {
        const [oid, ref] = line.split('\0');
        if (!OID.test(oid || '') || !ref || !ref.startsWith('refs/heads/')) continue;
        const short = ref.slice('refs/heads/'.length);
        if (!names.has(oid)) names.set(oid, []);
        names.get(oid).push(short);
        if (short.startsWith('workbench/')) tips.push(oid);
      }
      const out = (await run(['-c', 'trailer.separators=:', 'log', '--topo-order', '--no-show-signature', '--encoding=UTF-8',
        `--format=tformat:${GRAPH_FORMAT}`, '-n', String(n + 1), '--stdin'],
      { cwd: root, input: [...new Set(tips)].join('\n') + '\n', timeout: WORKTREE_TIMEOUT_MS })).stdout;
      const order = (a, c) => (a === branch ? -1 : c === branch ? 1 : a < c ? -1 : a > c ? 1 : 0);
      const fields = out.split('\0');
      const commits = [];
      for (let i = 0; i + 7 <= fields.length; i += 7) {
        const id = fields[i].replace(/^\n/, '');
        if (!OID.test(id)) break;
        const parents = fields[i + 1] ? fields[i + 1].split(' ').filter(p => OID.test(p)) : [];
        const agent = lastValue(fields[i + 5]);
        const word = lastValue(fields[i + 6]);
        commits.push({
          id, parents, subject: clip(fields[i + 4], 1000), author: clip(fields[i + 2], 200), at: (Number(fields[i + 3]) || 0) * 1000,
          refs: (names.get(id) || []).slice().sort(order),
          agentId: AGENT_ID.test(agent) ? agent : null,
          kind: word === 'merge' && parents.length > 1 ? 'merge' : word === 'work' ? 'work' : 'commit',
        });
      }
      const more = commits.length > n;
      return { ok: true, head, branch, commits: more ? commits.slice(0, n) : commits, more };
    });
  } catch (e) {
    return failure(e, 'Git could not read the history of this repository.');
  }
}

// ---------------------------------------------------------------------------------------------

const defaults = () => ({ checks: [], rules: [], allow: [] });

/**
 * Read workbench.json from a commit (`git show <ref>:workbench.json`), never from a working copy an
 * agent could have edited. Missing file: the defaults. Bad entries are skipped and reported.
 * @param {{ repoRoot: string, ref?: string, onProblem?: (sentence: string) => void }} opts
 * @returns {Promise<{ checks: { name: string, run: string, timeoutSec: number }[], rules: { say: string, paths: string[] }[], allow: string[] }>}
 */
export async function readRepoConfig({ repoRoot, ref = 'HEAD', onProblem } = {}) {
  const note = typeof onProblem === 'function' ? onProblem : () => {};
  const root = realRoot(repoRoot);
  const r = validRef(ref || 'HEAD');
  let text;
  try {
    text = (await git(['show', '--no-textconv', `${r}:workbench.json`], { cwd: root })).stdout;
  } catch (e) {
    const missing = /does not exist in|exists on disk, but not in|path '.*' does not exist/i.test(e.stderr || '');
    if (missing) return defaults();
    throw gitTrouble(e) || plainError(`Could not read workbench.json from the commit: ${firstLine(e.stderr)}`, e);
  }
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) {
    note('workbench.json is too large, so it was ignored.');
    return defaults();
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    note('workbench.json is not valid JSON, so no checks, rules or allowed commands were loaded.');
    return defaults();
  }
  return normalizeConfig(raw, note);
}

const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000]/.test(v);

/** Validate and normalize a parsed workbench.json. Exported for tests and the engine. */
export function normalizeConfig(raw, onProblem) {
  const note = typeof onProblem === 'function' ? onProblem : () => {};
  const out = defaults();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    note('workbench.json should hold an object with "checks", "rules" and "allow", so it was ignored.');
    return out;
  }
  const each = (key, label, fn) => {
    const v = raw[key];
    if (v === undefined || v === null) return;
    if (!Array.isArray(v)) { note(`"${key}" in workbench.json should be a list, so it was ignored.`); return; }
    v.forEach((item, i) => {
      if (out[key].length >= LIMITS[key]) {
        if (out[key].length === LIMITS[key] && i === LIMITS[key]) note(`Only the first ${LIMITS[key]} ${label}s in workbench.json are used.`);
        return;
      }
      const n = fn(item);
      if (n) out[key].push(n);
      else note(`${cap(label)} ${i + 1} in workbench.json was skipped because it is not in the expected shape.`);
    });
  };
  each('checks', 'check', normCheck);
  each('rules', 'rule', normRule);
  each('allow', 'allowed command', normAllow);
  return out;
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normCheck(c) {
  if (isText(c, 4000)) return { name: clip(c.trim(), 40), run: c.trim(), timeoutSec: DEFAULT_CHECK_TIMEOUT_SEC };
  if (!c || typeof c !== 'object' || Array.isArray(c) || !isText(c.run, 4000)) return null;
  const run = c.run.trim();
  const name = isText(c.name, 200) ? c.name.trim().replace(/\s+/g, ' ') : clip(run, 40);
  const t = Number(c.timeoutSec);
  const timeoutSec = Number.isFinite(t) && t > 0 ? Math.min(3600, Math.max(1, Math.round(t))) : DEFAULT_CHECK_TIMEOUT_SEC;
  return { name, run, timeoutSec };
}

function normRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !isText(r.say, 500)) return null;
  const globs = (Array.isArray(r.paths) ? r.paths : [r.paths])
    .filter(g => isText(g, 500))
    .map(g => g.trim().replace(/\\/g, '/'));
  if (!globs.length) return null;
  return { say: r.say.trim().replace(/\s+/g, ' '), paths: [...new Set(globs)] };
}

function normAllow(a) {
  if (!isText(a, 500) || /[\u0000-\u001f]/.test(a)) return null;
  return a.trim().replace(/\s+/g, ' ');
}
