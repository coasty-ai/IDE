// Git workspaces. Each agent works in its own git worktree, made from the repository's last commit,
// so agents never touch the person's working folder or each other's files. Also: the numbers for
// the receipt (what changed since the workspace was made) and the repository's workbench.json.
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
 * @param {{ cwd?: string, timeout?: number, input?: string, okCodes?: number[] }} [o]
 *   input goes to git's stdin; okCodes are exit codes that still count as success (check-ignore exits 1 when
 *   nothing matches)
 * @returns {Promise<{ stdout: string, stderr: string }>} rejects with the execFile error (plus .stderr)
 */
export function git(args, { cwd, timeout = GIT_TIMEOUT_MS, input, okCodes = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...GIT_SAFE_CONFIG, ...args], { cwd, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: gitEnv(), windowsHide: true }, (err, stdout, stderr) => {
      if (err && !(typeof err.code === 'number' && okCodes.includes(err.code) && !err.killed)) {
        err.stdout = stdout;
        err.stderr = String(stderr || '');
        reject(err);
      } else {
        resolve({ stdout, stderr });
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
    branch = (await git(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd: root })).stdout.trim() || null;
  } catch {
    branch = null; // detached HEAD
  }
  return { root, name: path.basename(root), head, branch, dirty: await countDirty(root) };
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

/** Worktrees git knows for a repository: [{ path, branch|null }]. */
async function listWorktrees(root) {
  const out = (await git(['worktree', 'list', '--porcelain'], { cwd: root })).stdout;
  const list = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push(cur = { path: line.slice(9), branch: null });
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
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
async function ignoredAt(wsPath, ref, paths) {
  if (!paths.length) return new Set();
  const dirs = new Set(['']);
  for (const p of paths) {
    const parts = p.replace(/\/+$/, '').split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const wanted = [...dirs].map(d => (d ? `${d}/.gitignore` : '.gitignore'));
  const found = new Map(); // path -> blob id
  for (let i = 0; i < wanted.length; i += ARG_BATCH) {
    const out = (await git(['--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...wanted.slice(i, i + ARG_BATCH)], { cwd: wsPath })).stdout;
    for (const rec of nulList(out)) {
      const m = /^100(644|755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(rec); // a plain file: git does not follow linked ones
      if (m) found.set(m[3], m[2]);
    }
  }
  const gitDir = (await git(['rev-parse', '--absolute-git-dir'], { cwd: wsPath })).stdout.trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ignore-'));
  try {
    for (const [file, oid] of found) {
      const parts = safeParts(file);
      if (!parts) continue;
      const text = (await git(['cat-file', 'blob', oid], { cwd: wsPath })).stdout;
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
    const out = (await git([`--git-dir=${gitDir}`, `--work-tree=${scratch}`, 'check-ignore', '--no-index', '-z', '--stdin'],
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
async function hiddenByAgent(wsPath, ref) {
  const list = async (args) => nulList((await git(args, { cwd: wsPath })).stdout);
  // What the ignore rules hide now. A folder git does not look into shows as "folder/" (node_modules/, say). No
  // --no-empty-directory: with it, git leaves out a hidden file in a new folder that also holds a visible file. Without
  // it, git can list a folder and the files inside it too, so the result is a set.
  const now = await list(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  if (!now.length) return [];
  const before = await ignoredAt(wsPath, ref, now);
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
    const hiddenBefore = await ignoredAt(wsPath, ref, inside);
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
