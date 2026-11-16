// Git workspaces. Each agent works in its own git worktree, made from the repository's last commit,
// so agents never touch the person's working folder or each other's files; fillWorkspace copies into a new one
// the ignored files it needs to run (.env files, node_modules). Also: the numbers for
// the receipt (what changed since the workspace was made), the repository's workbench.json, and source
// control: an agent's work as git objects, its diff, merging it into the person's branch with a merge
// commit, throwing it away, and the commit graph.
//
// Every git call goes through git(): execFile (or spawn, for git in a process group of its own) with an argument array
// and a timeout. So does every cp of fillWorkspace's (runCp). Every temporary folder Workbench makes comes from
// privateTemp(): under ~/.workbench/tmp, never the system's temporary folder, which agents can write.
import { execFile, spawn } from 'node:child_process';
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
 * @param {{ cwd?: string, timeout?: number, input?: string, okCodes?: number[], env?: Record<string, string|undefined>,
 *   encoding?: 'utf8'|'buffer', detached?: boolean }} [o]
 *   input goes to git's stdin; okCodes are exit codes that still count as success (check-ignore exits 1 when
 *   nothing matches); env adds variables after the scrub (a temporary GIT_INDEX_FILE, who a commit is by), and an
 *   undefined value takes one away; encoding 'buffer' gives stdout as bytes; detached starts git in a process group of
 *   its own, so a Ctrl-C in the terminal (which goes to the whole foreground group) reaches Workbench, which waits for
 *   the git work under way, and not git, which would stop part-way (a timeout still stops it)
 * @returns {Promise<{ stdout: string|Buffer, stderr: string, code: number }>} code is 0 or one of okCodes; rejects with
 *   the execFile error (plus .stdout and .stderr)
 */
export function git(args, { cwd, timeout = GIT_TIMEOUT_MS, input, okCodes = [], env, encoding = 'utf8', detached = false } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = gitEnv();
    for (const [k, v] of Object.entries(env || {})) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    const options = { cwd, timeout, maxBuffer: MAX_BUFFER, encoding, env: childEnv, windowsHide: true };
    const child = (detached ? execFileDetached : execFile)('git', [...GIT_SAFE_CONFIG, ...args], options, (err, stdout, stderr) => {
      if (err && !(typeof err.code === 'number' && okCodes.includes(err.code) && !err.killed)) {
        err.stdout = stdout;
        err.stderr = String(stderr || '');
        reject(err);
      } else {
        resolve({ stdout, stderr: String(stderr || ''), code: err ? err.code : 0 });
      }
    });
    if (input != null) {
      child.stdin.on('error', () => {}); // git may finish before reading all of it
      child.stdin.end(input);
    }
  });
}

/**
 * execFile, but with the program as the leader of a process group of its own (execFile takes no `detached`). It ends
 * the same ways: `done(err, stdout, stderr)`, where err carries the exit code as .code (or the signal as .signal, with
 * .killed when the timeout stopped it), or is the spawn error (.code 'ENOENT'), or has .code
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' when the program said more than maxBuffer bytes (it is then stopped).
 */
function execFileDetached(file, args, { cwd, timeout, maxBuffer, encoding, env, windowsHide }, done) {
  const child = spawn(file, args, { cwd, env, windowsHide, detached: true });
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let failure = null;
  let killed = false;
  let ended = false;
  const kill = () => {
    killed = true;
    child.kill(); // SIGTERM, as execFile's timeout sends
  };
  const timer = timeout > 0 ? setTimeout(kill, timeout) : null;
  for (const kind of ['stdout', 'stderr']) {
    child[kind].on('data', chunk => {
      sizes[kind] += chunk.length;
      if (sizes[kind] <= maxBuffer) {
        chunks[kind].push(chunk);
      } else if (!failure) {
        failure = Object.assign(new RangeError(`${kind} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        kill();
      }
    });
  }
  const end = (code, signal) => {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    const out = Buffer.concat(chunks.stdout);
    const stdout = encoding === 'buffer' ? out : out.toString(encoding);
    const stderr = Buffer.concat(chunks.stderr).toString('utf8');
    let err = failure;
    if (!err && (code !== 0 || signal != null)) {
      err = new Error(`Command failed: ${[file, ...args].join(' ')}\n${stderr}`);
      Object.assign(err, { code, killed, signal, cmd: [file, ...args].join(' ') });
    }
    done(err, stdout, stderr);
  };
  child.on('error', e => { // it could not be started (or stopped)
    if (!failure) failure = e;
    end(null, null);
  });
  child.on('close', end);
  return child;
}

/** An error whose message a person can read; git's own words go only in `.detail` (for the log), never in the message. */
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

/** Where Workbench keeps its own temporary files, in the home folder (see privateTemp). */
const PRIVATE_TEMP = ['.workbench', 'tmp'];
/** Leftovers older than this are removed (see privateTemp): nothing of Workbench's lasts a day. */
const LEFTOVER_MS = 24 * 60 * 60_000;
/** The private folders whose leftovers were looked at in this run. */
const sweptFolders = new Set();

/**
 * A new, empty private folder (0700) for Workbench's own temporary files, `<home>/.workbench/tmp/<prefix>XXXXXX`, as a
 * real path: a script for Terminal, gh's download, a scratch git index, the folder git runs in outside every
 * repository. Never in the system's temporary folder: a Codex agent's sandbox may write there (as may any program of
 * the person's), so whatever Workbench left there could be changed before Workbench used it. ~/.workbench/tmp is made
 * 0700 (or made private again) and must be a real folder of this account's, not a link; otherwise this throws a plain
 * error and makes nothing. The first time in a run, folders of Workbench's own there more than a day old (left by a
 * Workbench that was stopped before it could remove them) are removed. The caller removes the folder it was given.
 * @param {string} prefix the start of the folder's name, such as 'workbench-index-'
 * @param {{ home?: string }} [o] the home folder: os.homedir(), read at each call, unless given
 * @returns {string}
 */
export function privateTemp(prefix, { home = os.homedir() } = {}) {
  const root = path.join(path.resolve(String(home)), ...PRIVATE_TEMP);
  const refuse = cause => plainError(`Workbench could not make a private folder for its temporary files in ${root}.`, cause);
  let real;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(root);
    const uid = process.getuid?.();
    if (st.isSymbolicLink() || !st.isDirectory() || (uid != null && st.uid !== uid)) throw refuse();
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700);
    real = fs.realpathSync.native(root);
  } catch (e) {
    throw e && e.plain ? e : refuse(e);
  }
  if (!sweptFolders.has(real)) {
    sweptFolders.add(real);
    const before = Date.now() - LEFTOVER_MS;
    let names = [];
    try { names = fs.readdirSync(real); } catch { /* nothing to look at */ }
    for (const name of names.filter(n => n.startsWith('workbench-'))) {
      const p = path.join(real, name);
      try {
        if (fs.lstatSync(p).mtimeMs < before) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* gone meanwhile */ }
    }
  }
  try {
    const dir = fs.mkdtempSync(path.join(real, prefix));
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch (e) {
    throw refuse(e);
  }
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
  // Agents' copies of a private repository: only this account may open the folders that hold them. Each folder made
  // here (~/.workbench, worktrees/ and the repository's own) is made 0700.
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
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
    throw gitTrouble(e) || plainError('Git could not make a workspace for this agent.', e);
  }
  try {
    const real = fs.realpathSync.native(wsPath);
    const base = (await git(['rev-parse', 'HEAD'], { cwd: real })).stdout.trim();
    return { path: real, branch, base };
  } catch (e) {
    await takeBack(root, wsPath, branch);
    throw gitTrouble(e) || plainError('Git could not make a workspace for this agent.', e);
  }
}

/** Nothing has run in a new workspace yet: take it and its branch away again. */
async function takeBack(root, wsPath, branch) {
  await git(['worktree', 'remove', '--force', wsPath], { cwd: root, timeout: WORKTREE_TIMEOUT_MS }).catch(() => {});
  await git(['branch', '-D', branch], { cwd: root }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Filling a new workspace. A worktree holds only what git tracks, so an agent's copy has no .env and no installed
// packages, and a first task often cannot run the project. fillWorkspace copies chosen ignored files into it from the
// person's folder with cp (an argument array, never a shell), as clones where the disk can make them.

const FILL_TIMEOUT_MS = 10 * 60_000; // the whole fill
const CP_TIMEOUT_MS = 5 * 60_000; // one cp
const CP_START_MS = 1000; // no cp starts with less of the fill's time left than this
const CP_AT_ONCE = 8;
/**
 * The most of what one cp says that is kept. A copy that cannot clone fails once for every file, far more than this
 * for a node_modules: cp is then stopped, and its first lines still say why.
 */
const CP_MAX_BUFFER = 256 * 1024;
/** cp's words when it cannot make a clone: macOS's `cp -c` to another volume, GNU's `--reflink=always` where there are none. */
const NO_CLONE = /clonefile failed|failed to clone/;
const INCLUDE_MAX_BYTES = 256 * 1024;
/** Env files by name: .env, .env.<anything> (.env.local, .env.development.local) and direnv's .envrc. */
const ENV_NAMES = ['.env', '.env.*', '.envrc'];
const isEnvName = n => n === '.env' || n.startsWith('.env.') || n === '.envrc';
/**
 * Folders of installed packages (and pnpm's store of them, Composer's and Bundler's vendor/) and of version control:
 * what is in them is never one of the project's own env files, and is copied only as a clone.
 */
const DEPENDENCY_FOLDERS = new Set(['node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', 'vendor', '.venv', 'venv']);
const VCS_FOLDERS = new Set(['.git', '.hg', '.svn', '.bzr', '.jj', '.sl', '_darcs']);

/**
 * Copy chosen ignored files from the person's folder into a new workspace, so that the agent's copy can run the
 * project: never over anything already there, and never anything tracked, inside .git or outside the person's folder.
 *
 * What: with a .worktreeinclude at the top of the person's folder (a regular file, never followed as a link), exactly the
 * paths git ignores there that match it, in gitignore syntax (kind 'listed'). Without one, every env file git ignores
 * (kind 'env') and every node_modules folder it ignores (kind 'deps'), outside folders of installed packages and of
 * version control, and node_modules only outside a folder git ignores as a whole. Python virtualenvs never by default
 * (they hold absolute paths, and a copy runs the original's code); one that .worktreeinclude names is copied anyway,
 * and also listed in `skipped` with why 'venv'.
 *
 * How: one cp per entry, at most CP_AT_ONCE at once, each within CP_TIMEOUT_MS and the time left of `timeoutMs`, and
 * none started with less than CP_START_MS left. A folder of installed packages (node_modules) or of version control,
 * a virtualenv, or a folder inside one of those, is copied only as a clone, and left out where none can be made;
 * anything else is copied plainly then. On a Mac `/bin/cp -c -R -p` clones (APFS), and cannot to another volume.
 * Elsewhere GNU cp: `-a --reflink=always` for those folders (ext4 makes no clones), `-a --reflink=auto` for the rest.
 * Never with Node: on a Mac, fs.copyFile makes a full copy even when asked to clone, and fs.cp makes relative links
 * absolute unless told not to. A folder made on the way gets the mode of the person's folder it stands for.
 *
 * An entry that fails is left out (its half-made copy removed) and the others go on. Only bad arguments reject: a
 * `repoRoot` that is not the top folder of a checkout, or a `path` that git does not list as one of its worktrees.
 * When git cannot list the folder, nothing is copied and `skipped` is [{ path: '.', why: 'failed' }]; when
 * .worktreeinclude cannot be read, [{ path: '.worktreeinclude', why: 'failed' }]; a folder git ignores as a whole
 * that could not be searched for env files is named with why 'failed', and the rest is copied all the same.
 * @param {{ repoRoot: string, path: string, platform?: string, run?: typeof git,
 *   copy?: (file: string, args: string[], o: { timeout: number }) => Promise<unknown>, timeoutMs?: number }} opts
 *   repoRoot: the top folder of the person's checkout (prepareRepo's root); path: the workspace (createWorkspace's);
 *   platform: 'darwin' for the Mac's cp, anything else for GNU cp; run and copy: stand-ins for git() and cp (tests);
 *   timeoutMs: the whole fill's limit (10 minutes unless given)
 * @returns {Promise<{ copied: { path: string, kind: 'env'|'deps'|'listed', cloned: boolean }[],
 *   skipped: { path: string, why: 'exists'|'link-outside'|'noclone'|'failed'|'venv' }[], ms: number }>}
 *   paths relative to the repository (a folder's without its "/"), each list in path order; cloned: made with clones
 *   (`cp -c` on a Mac, `--reflink=always` elsewhere), which take almost no disk
 */
export async function fillWorkspace({ repoRoot, path: wsPath, platform = process.platform, run = git, copy = runCp, timeoutMs = FILL_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const root = realRoot(repoRoot);
  if (typeof wsPath !== 'string' || !path.isAbsolute(wsPath) || !isFolder(wsPath)) throw plainError('No workspace folder was given.');
  const ws = fs.realpathSync.native(wsPath);
  if (ws === root) throw plainError('That is the main folder of the repository, not a workspace.');
  const deadline = started + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : FILL_TIMEOUT_MS);
  const copied = [];
  const skipped = [];
  const done = () => ({ copied: copied.sort(byPath), skipped: skipped.sort(byPath), ms: Date.now() - started });

  // Only into a worktree of this repository, from the top folder of the person's checkout: git names paths from the
  // folder it runs in, so from a folder inside it app/.env would land at .env.
  let top, worktrees;
  try {
    [top, worktrees] = await Promise.all([
      run(['rev-parse', '--show-toplevel'], { cwd: root }).then(r => String(r.stdout).trim()),
      listWorktrees(root, run),
    ]);
  } catch {
    skipped.push({ path: '.', why: 'failed' });
    return done();
  }
  if (!top || canonical(top) !== root) throw plainError(`The folder ${root} is not the top folder of a git repository.`);
  if (!worktrees.some(w => canonical(w.path) === ws)) throw plainError(`The folder ${ws} is not a workspace of the repository at ${root}.`);

  let chosen;
  try {
    chosen = await chooseFill(run, root, deadline);
  } catch (e) {
    skipped.push({ path: e && e.include ? '.worktreeinclude' : '.', why: 'failed' });
    return done();
  }
  skipped.push(...chosen.skipped);

  const mac = platform === 'darwin';
  const program = mac || fs.existsSync('/bin/cp') ? '/bin/cp' : 'cp';
  const cpWith = typeof copy === 'function' ? copy : runCp;
  const dep = dependencyFolders(root);
  let noClones = false; // a clone failed for want of clones: the two disks are the same for every entry
  const made = new Map(); // folders made on the way in the workspace -> the person's folder each stands for

  /** One cp within the time left: { ok }, or { ok: false, noClone } with its half-made copy removed. */
  const cp = async (args, dst) => {
    const left = deadline - Date.now();
    if (left < CP_START_MS) return { ok: false, noClone: false }; // too late to start one
    try {
      await cpWith(program, args, { timeout: Math.min(CP_TIMEOUT_MS, left) });
      return { ok: true };
    } catch (e) {
      await fs.promises.rm(dst, { recursive: true, force: true }).catch(() => {}); // nothing was there before
      return { ok: false, noClone: NO_CLONE.test(String((e && e.stderr) || '')) };
    }
  };

  /** Copy one entry: the reason it was left out, or null when it was copied. */
  const fillOne = async ({ path: rel, kind, venvs = [] }) => {
    const parts = safeParts(rel);
    if (!parts || parts.some(x => x.toLowerCase() === '.git')) return 'failed';
    const src = path.join(root, ...parts);
    const dst = path.join(ws, ...parts);
    if (within(src, ws) || within(ws, src)) return 'failed'; // the agent's folder is in it, or it is in the agent's folder
    if (!realFolders(root, parts)) return nothingAt(src) ? null : 'link-outside'; // gone, or reached through a link
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      return null; // gone since git listed it: nothing to copy
    }
    if (st.isSymbolicLink() && !linkStaysInside(root, src)) return 'link-outside';
    const inTheWay = foldersFor(ws, parts, made, root);
    if (inTheWay) return inTheWay;
    if (!nothingAt(dst)) return 'exists';
    const folder = st.isDirectory();
    // A folder of installed packages or of version control, or a virtualenv, or one inside them (node_modules/next),
    // only as a clone: a full copy of a node_modules is too slow and too big to make unasked. Anything else is copied
    // plainly where clones cannot be made.
    const cloneOnly = folder && (kind === 'deps' || dep.is(rel) || dep.above(rel));
    let cloned;
    if (mac) {
      // A clone takes almost no disk, and seconds for a node_modules.
      const r = noClones ? { ok: false, noClone: true } : await cp(['-c', '-R', '-p', src, dst], dst);
      if (r.ok) {
        cloned = true;
      } else {
        if (!r.noClone) return 'failed';
        noClones = true;
        if (cloneOnly) return 'noclone';
        if (!(await cp(['-R', '-p', src, dst], dst)).ok) return 'failed';
        cloned = false;
      }
    } else if (!cloneOnly) {
      if (!(await cp(['-a', '--reflink=auto', src, dst], dst)).ok) return 'failed'; // a clone or a copy: cp knows
      cloned = false;
    } else {
      const r = noClones ? { ok: false, noClone: true } : await cp(['-a', '--reflink=always', src, dst], dst);
      if (!r.ok) {
        if (!r.noClone) return 'failed';
        noClones = true;
        return 'noclone';
      }
      cloned = true;
    }
    copied.push({ path: rel, kind, cloned });
    if (folder) for (const v of venvs) skipped.push({ path: v, why: 'venv' }); // copied as asked: say what it is
    return null;
  };

  const order = { env: 0, listed: 1, deps: 2 }; // the small files first
  const queue = chosen.entries.sort((a, b) => order[a.kind] - order[b.kind] || byPath(a, b));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CP_AT_ONCE, queue.length) }, async () => {
    while (next < queue.length) {
      const entry = queue[next++];
      let why;
      try {
        why = await fillOne(entry);
      } catch {
        why = 'failed';
      }
      if (why) skipped.push({ path: entry.path, why });
    }
  }));
  settleFolders(made);
  return done();
}

/**
 * The folders fillWorkspace made on the way (`made`: each -> the person's folder it stands for), once every copy is
 * done: one that nothing went into is taken away again, deepest first; any other gets the mode of the person's folder,
 * so that a 0644 .env the person keeps private with a 0700 folder is private in the agent's folder too. Each stays
 * writable and searchable for its owner (a 0555 folder becomes 0755), or nothing could be put in or taken out of it.
 */
function settleFolders(made) {
  for (const [dir, from] of [...made].sort((a, b) => b[0].length - a[0].length)) {
    try {
      fs.rmdirSync(dir);
      continue;
    } catch { /* something went into it */ }
    try {
      const st = fs.lstatSync(from);
      if (st.isDirectory()) fs.chmodSync(dir, (st.mode & 0o777) | 0o700);
    } catch { /* gone from the person's folder meanwhile: it stays 0700 */ }
  }
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * cp as fillWorkspace runs it: execFile with an argument array and a time limit, never a shell, in English (LC_ALL=C)
 * so that its words can be read. Resolves `{ code: 0, stderr }`; rejects with the execFile error, cp's words in
 * .stderr: its exit code in .code, .killed and .signal when the time limit stopped it, or .code
 * 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' when it said more than CP_MAX_BUFFER (it is stopped then too).
 */
function runCp(file, args, { timeout = CP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const options = { cwd: '/', timeout, maxBuffer: CP_MAX_BUFFER, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, windowsHide: true };
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve({ code: 0, stderr: String(stderr || '') });
    });
  });
}

/**
 * What fillWorkspace copies: { entries: [{ path, kind, venvs? }], skipped: [{ path, why: 'failed' }] }, paths relative
 * to `root` (a folder's without its "/"); `skipped` names the folders that could not be searched for env files. Throws
 * when git cannot list the folder before `deadline`, or (marked .include) when .worktreeinclude cannot be read.
 */
async function chooseFill(run, root, deadline) {
  const include = readInclude(root);
  const ls = async (args, until = deadline) => {
    const left = until - Date.now();
    if (left <= 0) throw new Error('no time left to ask git');
    return nulList((await run(['ls-files', '-z', '--others', '--ignored', ...args], { cwd: root, timeout: Math.min(WORKTREE_TIMEOUT_MS, left) })).stdout);
  };
  // What git ignores, a folder it ignores as a whole as one entry ("node_modules/"), never a tracked file.
  const ignored = await ls(['--exclude-standard', '--directory']);
  if (include === null) return defaultFill(root, ignored, ls, deadline);
  // What .worktreeinclude matches, read by git from a copy of Workbench's own: the bytes checked here, never a link.
  const scratch = privateTemp('workbench-include-');
  try {
    const file = path.join(scratch, 'worktreeinclude');
    fs.writeFileSync(file, include, { flag: 'wx', mode: 0o600 });
    return { entries: listedFill(root, ignored, await ls([`--exclude-from=${file}`, '--directory'])), skipped: [] };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The bytes of the person's .worktreeinclude, or null when there is none to read: missing, a link (never followed) or
 * not a regular file. One that is there but cannot be read, or is bigger than INCLUDE_MAX_BYTES, throws (marked .include).
 */
function readInclude(root) {
  const unreadable = e => Object.assign(e instanceof Error ? e : new Error(String(e)), { include: true });
  let fd;
  try {
    fd = fs.openSync(path.join(root, '.worktreeinclude'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'EMLINK') return null; // none, or a link
    throw unreadable(e);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > INCLUDE_MAX_BYTES) throw new Error('.worktreeinclude is too big');
    return fs.readFileSync(fd);
  } catch (e) {
    throw unreadable(e);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * With a .worktreeinclude: the paths both lists hold, each itself or through a folder above it, and of those only the
 * outermost. The two lists name folders differently (one folder whole in one, file by file in the other: data/ against
 * data/a.json), and git lists a folder that holds only listed files together with those files. `venvs`: the
 * virtualenvs it names, at or inside each entry (envs/py311/ when it is all that envs/ holds, and envs/ is copied).
 */
function listedFill(root, ignored, matching) {
  const a = new Set(ignored);
  const b = new Set(matching);
  const both = new Set([...ignored, ...matching].filter(p => held(a, p) && held(b, p)));
  const venvs = [...both].filter(p => p.endsWith('/') && isVenv(root, p.slice(0, -1)));
  return [...both].filter(p => !heldAbove(both, p)).map(p => ({
    path: p.replace(/\/+$/, ''), kind: 'listed', venvs: p.endsWith('/') ? venvs.filter(v => v.startsWith(p)).map(v => v.slice(0, -1)) : [],
  }));
}

/**
 * Without one: every env file and every node_modules folder git ignores, outside folders of installed packages and of
 * version control (so never one node_modules inside another, nor a virtualenv's files). `ignored` shows a folder git
 * ignores as a whole only as itself, so env files are also looked for inside each such folder (.vercel/, say), but not
 * node_modules: one inside a folder git ignores as a whole is a build's own (build/node_modules). That search takes at
 * most half of the time left, and is only a help: a folder it could not search is named in `skipped`, and the rest
 * is copied all the same.
 */
async function defaultFill(root, ignored, ls, deadline) {
  const dep = dependencyFolders(root);
  const deps = [...new Set(ignored.filter(p => lastPart(p) === 'node_modules' && !dep.above(p)))];
  const folders = ignored.filter(p => p.endsWith('/') && !dep.above(p) && !dep.is(p));
  const all = new Set(folders);
  const tops = folders.filter(f => !heldAbove(all, f));
  const found = [...ignored];
  const skipped = [];
  const until = Date.now() + Math.max(0, deadline - Date.now()) / 2;
  const each = Math.max(1, Math.floor(ARG_BATCH / ENV_NAMES.length));
  for (let i = 0; i < tops.length; i += each) {
    const some = tops.slice(i, i + each);
    try {
      found.push(...await ls(['--exclude-standard', '--', ...some.flatMap(f => ENV_NAMES.map(n => `:(glob)${globEscape(f)}**/${n}`))], until));
    } catch {
      skipped.push(...some.map(f => ({ path: f.replace(/\/+$/, ''), why: 'failed' })));
    }
  }
  // An env file is a file (or a link): a folder named .env is something else (a virtualenv, often), and another
  // repository inside an ignored folder comes back as a folder.
  const envs = [...new Set(found)].filter(p => !p.endsWith('/') && isEnvName(lastPart(p)) && !dep.above(p));
  return { entries: [...envs.map(p => ({ path: p, kind: 'env' })), ...deps.map(p => ({ path: p.replace(/\/+$/, ''), kind: 'deps' }))], skipped };
}

/** Which folders (relative to `root`) hold installed packages, a virtualenv or version control; each looked at once. */
function dependencyFolders(root) {
  const known = new Map();
  const is = p => {
    const rel = p.replace(/\/+$/, '');
    if (!known.has(rel)) {
      const name = lastPart(rel);
      known.set(rel, DEPENDENCY_FOLDERS.has(name) || VCS_FOLDERS.has(name.toLowerCase()) || isVenv(root, rel));
    }
    return known.get(rel);
  };
  return { is, above: p => foldersAbove(p).some(is) };
}

/** Whether the folder `rel` is a Python virtualenv: named .venv or venv, or holding pyvenv.cfg. */
function isVenv(root, rel) {
  const name = lastPart(rel);
  return name === '.venv' || name === 'venv' || !nothingAt(path.join(root, ...rel.split('/'), 'pyvenv.cfg'));
}

const lastPart = p => p.replace(/\/+$/, '').split('/').pop();

/** The folders above a path, each with its "/": "a/b/c" and "a/b/c/" give ["a/", "a/b/"]. */
function foldersAbove(p) {
  const out = [];
  for (let i = p.indexOf('/'); i >= 0 && i < p.length - 1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i + 1));
  return out;
}
const heldAbove = (set, p) => foldersAbove(p).some(f => set.has(f));
const held = (set, p) => set.has(p) || heldAbove(set, p);

/** A folder name as a literal part of a :(glob) pathspec. */
const globEscape = s => s.replace(/[*?[\]\\]/g, '\\$&');

/** Whether `p` is `top` or inside it. */
const within = (top, p) => p === top || p.startsWith(top + path.sep);

/** Whether `p` is a real folder (lstat): not a link to one. */
function isRealFolder(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether each folder on the way from `top` to the path `parts` is a real folder: not a link, not a file. */
function realFolders(top, parts) {
  let dir = top;
  return parts.slice(0, -1).every(part => isRealFolder(dir = path.join(dir, part)));
}

/**
 * Make the folders missing on the way to the path `parts` in `top`, each 0700 while the fill goes on (settleFolders
 * gives it its mode at the end), noting it in `made` with the folder of `from` it stands for. Returns null, or why not:
 * 'exists' when something other than a real folder is in the way, a link or a file (nothing is ever written through a
 * link), 'failed' when a folder cannot be made.
 */
function foldersFor(top, parts, made, from) {
  let dir = top;
  let src = from;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    src = path.join(src, part);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      made.set(dir, src);
    } catch (e) {
      if (e.code !== 'EEXIST') return 'failed';
      if (!isRealFolder(dir)) return 'exists';
    }
  }
  return null;
}

/**
 * Whether the link at `src` points inside the person's folder `root`, so that its copy points inside the agent's: its
 * target is relative and stays inside `root` as written, and still does once the links on the way there are followed
 * (as far as anything is there yet). An absolute target counts as outside: its copy would point at the same place, in
 * the person's folder or beyond, never in the agent's.
 */
function linkStaysInside(root, src) {
  let target;
  try {
    target = fs.readlinkSync(src);
  } catch {
    return false;
  }
  if (path.isAbsolute(target)) return false;
  const to = path.resolve(path.dirname(src), target);
  if (!within(root, to)) return false;
  for (let p = to; within(root, p); p = path.dirname(p)) {
    try {
      return within(root, fs.realpathSync.native(p));
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return false; // a loop, say
    }
  }
  return true;
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
 * as a .env or a build), no file its index marks as not to be looked at differs from `base` (see filesAsCommitted)
 * and `git worktree remove` without --force agrees; then the branch goes only while it still
 * points at `base` (`update-ref -d`). In that order: update-ref would delete the branch of a folder that was kept.
 * `since` (with onlyIfUnchanged): the agent's last merged work commit. When given and not `base`, `since` takes the
 * place of `base` above, and the folder and branch also go only while a branch of the person's holds `since` (any
 * local branch outside workbench/, which this same tidy may take away): once they undid the merge, the agent's branch
 * may be the only copy of its work.
 * @returns {Promise<{ removed: boolean, branch?: string|null, kept?: true }>}
 */
export async function removeWorkspace({ repoRoot, path: wsPath, deleteBranch = false, onlyIfUnchanged = false, base = null, since = null } = {}) {
  const root = realRoot(repoRoot);
  if (typeof wsPath !== 'string' || !path.isAbsolute(wsPath)) throw plainError('No workspace folder was given.');
  const target = canonical(wsPath);
  if (target === root) throw plainError('That is the main folder of the repository, not a workspace.');
  const merged = onlyIfUnchanged && since != null && since !== '' && since !== base;
  const start = onlyIfUnchanged ? validRef(merged ? since : base) : null;
  const entry = (await listWorktrees(root)).find(w => w.path === target || canonical(w.path) === target);
  // Not one git lists: nothing of the agent's to take away. Never `git worktree prune`: it would also take away the
  // records of the person's own worktrees whose folders are away right now (on a disk that is not mounted, say).
  if (!entry || canonical(entry.path) === root) return { removed: false };
  if (onlyIfUnchanged) {
    const head = await git(['rev-parse', 'HEAD'], { cwd: entry.path }).then(r => r.stdout.trim(), () => null);
    if (head !== start) return { removed: false, kept: true }; // the agent made commits, or the folder is unreadable
    const status = await git(['status', '--porcelain', '--ignored', '--untracked-files=all'], { cwd: entry.path }).then(r => r.stdout, () => null);
    if (status !== '') return { removed: false, kept: true };
    if (!(await filesAsCommitted(entry.path, start))) return { removed: false, kept: true }; // an edit git status cannot see
    if (merged && !(await inPersonsBranch(root, start))) return { removed: false, kept: true }; // the merge was undone
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
    if (fs.existsSync(entry.path)) throw gitTrouble(e) || plainError('Git could not remove the workspace.', e);
    // The folder is gone (it may have gone part-way through): once more, for this one record only. Git takes away the
    // record of a worktree whose folder is missing; a locked one it keeps, and so do we.
    await git(['worktree', 'remove', '--force', entry.path], { cwd: root, timeout: WORKTREE_TIMEOUT_MS }).catch(() => {});
  }
  if (deleteBranch && entry.branch && entry.branch.startsWith('workbench/')) {
    await git(['branch', '-D', entry.branch], { cwd: root }).catch(() => {});
  }
  try {
    fs.rmdirSync(path.dirname(entry.path)); // the per-repository folder, only if now empty
  } catch {}
  return { removed: true, branch: entry.branch };
}

/**
 * Whether the tracked files in the folder `cwd` are exactly those of commit `head`, as far as `git status` cannot
 * tell. Its index may mark files as not to be looked at: an assume-unchanged or skip-worktree bit (which an agent can
 * set), or the assume-unchanged bit that the person's core.ignoreStat gives every file git writes. git status, and
 * `git worktree remove` without --force, then miss an edit to such a file. When any file is marked, the files are
 * judged again in a new index that only `read-tree` has written, which marks nothing, so every file is read
 * (`update-index --refresh` exits 1 when one differs or is missing). Writing that index runs no hook (see
 * withoutHooks). Never rejects: false when git cannot say.
 */
async function filesAsCommitted(cwd, head) {
  try {
    const marked = nulList((await git(['ls-files', '-v', '-z'], { cwd })).stdout).some(rec => rec[0] !== 'H');
    if (!marked) return true;
    return await withoutHooks(async run => {
      await run.shield(cwd);
      const scratch = privateTemp('workbench-index-');
      try {
        const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
        await run(['-c', 'core.splitIndex=false', 'read-tree', head], { cwd, env });
        const r = await run(['-c', 'core.splitIndex=false', '-c', 'core.ignoreStat=false', 'update-index', '--refresh'],
          { cwd, env, okCodes: [1], timeout: WORKTREE_TIMEOUT_MS });
        return r.code === 0;
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  } catch {
    return false;
  }
}

/**
 * Whether a local branch outside workbench/ holds `commit` (`for-each-ref --contains`): the branch it was merged into,
 * or any other of the person's. Workbench's own branches do not count: the tidy that asks may take them away too.
 */
async function inPersonsBranch(root, commit) {
  const r = await git(['for-each-ref', '--contains', commit, '--format=%(refname)', 'refs/heads/'], { cwd: root }).catch(() => null);
  return !!r && r.stdout.split('\n').some(ref => ref.startsWith('refs/heads/') && !ref.startsWith('refs/heads/workbench/'));
}

// ---------------------------------------------------------------------------------------------

const nulList = (out) => String(out).split('\0').filter(Boolean);

/** Paths handed to git on its command line, a few hundred at a time, so thousands of them still fit. */
const ARG_BATCH = 500;

/** The bytes of the blobs `ids` (object ids), in that order, read with one `cat-file --batch`. */
async function blobs(run, cwd, ids) {
  if (!ids.length) return [];
  const out = (await run(['cat-file', '--batch'], { cwd, input: ids.join('\n') + '\n', encoding: 'buffer' })).stdout;
  const found = [];
  let at = 0;
  for (let k = 0; k < ids.length; k++) {
    const nl = out.indexOf(10, at);
    const m = nl < 0 ? null : /^([0-9a-f]+) blob (\d+)$/.exec(out.subarray(at, nl).toString('latin1')); // or "<id> missing"
    if (!m || m[1] !== ids[k]) throw plainError('Git could not read a file it was asked for.');
    const end = nl + 1 + Number(m[2]);
    if (end > out.length) throw plainError('Git could not read a file it was asked for.');
    found.push(out.subarray(nl + 1, end));
    at = end + 1; // each one ends with a newline of its own
  }
  return found;
}

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
  const batches = [];
  for (let i = 0; i < wanted.length; i += ARG_BATCH) batches.push(wanted.slice(i, i + ARG_BATCH));
  const [listed, gitDir] = await Promise.all([
    Promise.all(batches.map(b => run(['--literal-pathspecs', 'ls-tree', '-z', ref, '--', ...b], { cwd: wsPath }))),
    run(['rev-parse', '--absolute-git-dir'], { cwd: wsPath }).then(r => r.stdout.trim()),
  ]);
  const found = new Map(); // path -> blob id
  for (const { stdout } of listed) {
    for (const rec of nulList(stdout)) {
      const m = /^100(644|755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(rec); // a plain file: git does not follow linked ones
      if (m && safeParts(m[3])) found.set(m[3], m[2]);
    }
  }
  const texts = await blobs(run, wsPath, [...found.values()]);
  const scratch = privateTemp('workbench-ignore-');
  try {
    [...found.keys()].forEach((file, k) => {
      const dest = path.join(scratch, ...safeParts(file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, texts[k], { flag: 'wx' });
    });
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
    throw gitTrouble(e) || plainError('Git could not compare the workspace with its starting point.', e);
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
    throw gitTrouble(e) || plainError('Git could not list the files hidden by the agent’s own ignore rules.', e);
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
// "The agent's work" is its folder the way `git add -A` sees it: every tracked file (committed, staged or not) and every
// new file no .gitignore hides, as one tree. It is read in a temporary index (a copy of the agent's own), never in the
// agent's index. Links are kept as links. Files that a .gitignore the agent added or changed hides, and repositories
// inside its folder, are left out and named in `left`. A merge commits that tree on its branch (W) and merges W into the
// person's branch; a throw-away keeps it as a hidden commit. `since` is where its unmerged work starts.
//
// The review (the diff, the files and counts on the merge card, the rules it is checked against) is exactly what that
// merge would change in the person's branch: their HEAD against the tree merge-tree makes of HEAD and the work, the
// merge commit's own first-parent diff, which is also what a merge reports. So commits of theirs that the agent brought
// into its branch are not shown as its work, and what its merge would undo of theirs is shown. When the merge would not
// be clean, the review is the work against where its history and the person's branch last met (`git merge-base`); when
// the merge would be refused (their branch does not hold `since`), or git cannot say, the work against `since`. The
// diffs run in the person's folder: the attributes that decide what is binary are theirs, never the agent's.
//
// The person's folder only ever sees `git merge --ff-only` to a merge commit built in the object database (merge-tree
// and commit-tree), with --no-squash, --no-autostash and --no-overwrite-ignore: never a real merge, never conflict markers, never
// update-ref on a checked-out branch. Every git command here runs with core.hooksPath set to /dev/null (never a folder,
// which someone could fill first) and every hook set in git config (hook.<name>.command, git 2.54 and newer) switched
// off, so no hook runs (commit-tree runs none anyway). Clean and smudge filters and merge drivers from git config still
// run, as they would for git itself.

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
// A merge, rebase, cherry-pick or revert (one commit, or a sequence of them waiting between two: `sequencer`) or bisect.
const UNDER_WAY = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'];
const UNDER_WAY_REFS = ['CHERRY_PICK_HEAD', 'REVERT_HEAD']; // asked of the ref store as well (see underWay)
// What git keeps in a folder's git folder for the person's next commit, which a fast-forward deletes as if it had ended
// a merge: the message it prepared (`git cherry-pick --no-commit`, say) and rerere's record of the conflicts they settled.
const KEPT_FOR_NEXT_COMMIT = ['MERGE_MSG', 'MERGE_RR'];
const WORKBENCH_IDENTITY = { name: 'Workbench', email: 'workbench@localhost' }; // the hidden copy of thrown-away work only
const CLAUDE_TRAILER = 'Co-authored-by: Claude <noreply@anthropic.com>';

const SAY = {
  detached: 'Your folder is not on a branch, so there is nowhere to merge it.',
  busy: 'Your folder is in the middle of a merge or rebase. Finish that first.',
  conflicted: paths => `Your folder has unresolved conflicts in ${listOf(paths, 3)}. Finish that first.`,
  locked: 'Another git command is busy in your folder. Try again in a moment.',
  identity: 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.',
  gitOld: 'Workbench needs git 2.38 or newer to merge.',
  changed: 'Its work changed since you looked. Have another look.',
  reviewChanged: into => `What merging it would change in ${into} is no longer what you saw. Have another look.`,
  moved: into => `${into} changed since you looked. Have another look.`,
  nothing: into => `Its work is already in ${into}.`,
  ancestry: into => `It started from a commit that is no longer in ${into}, so merging it would bring in other work.`,
  conflict: into => `Its work does not merge cleanly into ${into}.`,
  blocked: paths => `Your own changes are in the way: ${listOf(paths, 3)}. Commit or put them aside, then merge again.`,
  alreadyThere: paths => (paths.length === 1
    ? `A file in your folder already holds what the merge brings in, and git will not write over it: ${paths[0]}. Undo that change, then merge again.`
    : `Files in your folder already hold what the merge brings in, and git will not write over them: ${listOf(paths, 3)}. Undo those changes, then merge again.`),
  gone: 'Its folder is gone, so there is nothing to merge.',
  agentBusy: 'Its folder is in the middle of a merge or rebase, so its work cannot be merged yet.',
  git: 'Git could not finish the merge. Nothing in your folder changed.',
  unfinished: into => `Git could not finish the merge into ${into}. Have a look at your folder before you try again.`,
};

/** git's words when another git command holds the index: "Unable to create '<git dir>/index.lock': File exists." */
const INDEX_LOCKED = /^(?:fatal|error): Unable to create '[^\n]*index\.lock': File exists/m;

/**
 * git's words when `merge --ff-only` stopped before it changed anything (exit 128): the branch moved before git read it
 * ("Not possible to fast-forward, aborting."), an operation started ("You have not concluded your merge (MERGE_HEAD
 * exists)." or "... your cherry-pick ..."), or conflicts appeared ("Exiting because of an unresolved conflict."). Git
 * also exits 128 after it wrote the files and the index, when it cannot move the branch ("update_ref failed for ref
 * 'HEAD'"): those words are not here.
 */
const STOPPED_BEFORE = /^fatal: (?:Not possible to fast-forward|You have not concluded your |Exiting because of an unresolved conflict)/m;

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

/**
 * The names of the hooks set in git config as seen from `cwd` (`hook.<name>.command` and `hook.<name>.event`, git 2.54
 * and newer). core.hooksPath does not reach these; `hook.<name>.enabled=false` does. Reading them runs nothing.
 */
async function configHooks(cwd, run = git) {
  const r = await run(['config', '--name-only', '-z', '--get-regexp', '^hook\\.'], { cwd, okCodes: [1] });
  const names = new Set();
  for (const key of nulList(r.stdout)) {
    const m = /^hook\.([\s\S]+)\.[A-Za-z0-9-]+$/.exec(key); // hook.<name>.<setting>, where the name may hold dots
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Settings for git in its environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>, GIT_CONFIG_VALUE_<n>), after any that
 * Workbench's own environment already gives. Unlike `-c name=value`, a name holding "=" stays whole.
 */
function configEnv(pairs) {
  if (!pairs.length) return {};
  const had = /^\d+$/.test(process.env.GIT_CONFIG_COUNT || '') ? Number(process.env.GIT_CONFIG_COUNT) : 0;
  const env = { GIT_CONFIG_COUNT: String(had + pairs.length) };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${had + i}`] = key;
    env[`GIT_CONFIG_VALUE_${had + i}`] = value;
  });
  return env;
}

/**
 * Where withoutHooks points core.hooksPath. Git looks for each hook at <hooksPath>/<name>; nothing is under /dev/null,
 * and nothing can be put there. Never a folder: a new empty one in the temporary folder could be filled with hooks by
 * another process (a Codex agent's sandbox can write there) before git looked.
 */
const NO_HOOKS = '/dev/null';

/**
 * `fn(run)`, where `run` is git() that runs no hook: core.hooksPath points at /dev/null (NO_HOOKS), and the hooks set
 * in git config are switched off for every folder handed to `run.shield(folder)` (the person's folder and the agent's,
 * as soon as they are known; before that, only commands that run no hook are used).
 * `detached`: every git command of the job, the config read for the shield too, runs in a process group of its own
 * (see git()). Merges and throw-aways use it: a Ctrl-C must not stop git part-way through the person's folder or the
 * agent's, while Workbench waits for the job to finish.
 */
async function withoutHooks(fn, { detached = false } = {}) {
  const names = new Set();
  let off = {};
  const any = (args, o = {}) => git(args, { ...o, detached });
  const run = (args, o = {}) => any(['-c', `core.hooksPath=${NO_HOOKS}`, ...args], { ...o, env: { ...off, ...o.env } });
  run.shield = async cwd => {
    for (const name of await configHooks(cwd, any)) names.add(name);
    off = configEnv([...names].map(name => [`hook.${name}.enabled`, 'false']));
  };
  return fn(run);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isFolder(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether nothing at all is at `p` (not a folder, a file or a link): lstat says so, and not for any other reason. */
function nothingAt(p) {
  try {
    fs.lstatSync(p);
    return false;
  } catch (e) {
    return e.code === 'ENOENT';
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

/** Whether any of `names` (paths inside this folder's git folder) exists. */
async function gitPathsExist(cwd, names, run = git) {
  const out = (await run(['rev-parse', ...names.flatMap(name => ['--git-path', name])], { cwd })).stdout.split('\n');
  return names.some((name, i) => !!out[i] && fs.existsSync(path.resolve(cwd, out[i])));
}

/**
 * Whether a merge, rebase, cherry-pick, revert or bisect is under way in this folder (its own git folder), found the way
 * git itself finds it: MERGE_HEAD, BISECT_LOG and the rebase and sequencer folders are always files, while
 * CHERRY_PICK_HEAD and REVERT_HEAD are refs, kept as files only with the files ref store (with reftable, git 2.45 and
 * newer, they are in the ref store itself), so those are asked of git too.
 */
async function underWay(cwd, run = git) {
  const found = await Promise.all([gitPathsExist(cwd, UNDER_WAY, run), ...UNDER_WAY_REFS.map(name => pseudoRef(cwd, name, run))]);
  return found.some(Boolean);
}

/**
 * Whether the ref `name` (CHERRY_PICK_HEAD, say) is there, in whichever ref store the repository uses. A branch or
 * tag of that name does not count: rev-parse then names it refs/… (and names nothing when both are there).
 */
async function pseudoRef(cwd, name, run = git) {
  const r = await run(['rev-parse', '-q', '--verify', '--symbolic-full-name', name], { cwd, okCodes: [1] });
  return r.code === 0 && !r.stdout.startsWith('refs/');
}

/**
 * The paths with unresolved conflicts in this folder's index, each once. A `git stash pop` that did not apply cleanly
 * leaves them without any of the UNDER_WAY markers, and git then refuses to merge at all.
 */
async function unresolved(cwd, run = git) {
  const out = (await run(['ls-files', '-u', '-z'], { cwd })).stdout;
  return [...new Set(nulList(out).map(rec => rec.slice(rec.indexOf('\t') + 1)))]; // "<mode> <id> <stage>\t<path>"
}

/**
 * The files of KEPT_FOR_NEXT_COMMIT that are in this folder's git folder now, with their bytes: [{ file, bytes }].
 * One that cannot be read is a plain error: better no merge than a lost message.
 */
async function keptForNextCommit(cwd, run = git) {
  const out = (await run(['rev-parse', ...KEPT_FOR_NEXT_COMMIT.flatMap(name => ['--git-path', name])], { cwd })).stdout.split('\n');
  const kept = [];
  KEPT_FOR_NEXT_COMMIT.forEach((name, i) => {
    if (!out[i]) return;
    const file = path.resolve(cwd, out[i]);
    try {
      kept.push({ file, bytes: fs.readFileSync(file) });
    } catch (e) {
      if (e.code !== 'ENOENT') throw plainError('Workbench could not read what git keeps for your next commit, so nothing was merged.', e);
    }
  });
  return kept;
}

/** Put back each of `kept` that is gone, never over one written meanwhile. */
function putBack(kept) {
  for (const { file, bytes } of kept) {
    try {
      fs.writeFileSync(file, bytes, { flag: 'wx' });
    } catch {} // still there (git stopped before it deleted it), or written anew
  }
}

/**
 * The tracked files missing from this folder that are not marked skip-worktree (`ls-files --deleted`): deleted or
 * renamed without staging it. A sparse checkout's files outside it are not listed. Their names as bytes, one character
 * for each (the `key` of changesBetween).
 */
async function deletedFiles(cwd, run = git) {
  return new Set(nulFields((await run(['ls-files', '--deleted', '-z'], { cwd, encoding: 'buffer' })).stdout).map(b => b.toString('latin1')));
}

/**
 * Whether another git command holds a lock on `branch` (or HEAD). A fast-forward takes that lock only after it has
 * updated the files, so it would stop half-way: check first.
 */
const branchLocked = (cwd, branch, run = git) =>
  gitPathsExist(cwd, [`refs/heads/${branch}.lock`, 'HEAD.lock', 'reftable/tables.list.lock'], run);

/** The real path of a checkout's top folder (the person's main folder), checked with git; its config hooks are shielded. */
async function topFolder(run, repoRoot) {
  const root = realRoot(repoRoot);
  let top;
  try {
    [top] = await Promise.all([run(['rev-parse', '--show-toplevel'], { cwd: root }).then(r => r.stdout.trim()), run.shield(root)]);
  } catch (e) {
    throw gitTrouble(e) || plainError(`The folder ${root} is not a git repository.`, e);
  }
  if (!top || canonical(top) !== root) throw plainError(`The folder ${root} is not the top folder of a git repository.`);
  return root;
}

/**
 * The agent's folder, checked: another worktree that git lists for the checkout at `root`, still on disk, on a
 * workbench/ branch (on `branch` itself, when given). Throws a refusal otherwise. `worktrees`: git's list, if just read.
 * @returns {Promise<{ path: string, branch: string, locked: boolean }>}
 */
async function agentFolder(run, root, wsPath, branch, worktrees = null) {
  if (typeof wsPath !== 'string' || !path.isAbsolute(wsPath)) throw new Refusal('gone', 'No agent folder was given.');
  const target = canonical(wsPath);
  if (target === root) throw new Refusal('gone', 'That is your own folder, not an agent’s folder.');
  const entry = (worktrees || await listWorktrees(root, run)).find(w => canonical(w.path) === target);
  if (!entry || !isFolder(target)) throw new Refusal('gone', 'Its folder is gone.');
  if (!entry.branch || !entry.branch.startsWith('workbench/')) {
    throw new Refusal('changed', 'Its folder is no longer on a workbench/ branch, so Workbench leaves it alone.');
  }
  if (branch != null && entry.branch !== branch) {
    throw new Refusal('changed', `Its folder is on the branch ${entry.branch} now, not on ${branch}.`);
  }
  await run.shield(target); // its own config (config.worktree) may set hooks too
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
 * `root`: the person's folder. The files are compared there, never in the agent's folder: git reads the attributes
 * that decide what is binary from the working folder and the index of the folder it runs in, and the agent's are its own
 * to write (a `*.js -diff` it hid with its .gitignore, or kept only in its index, would hide a change to code).
 * `review` (default true): also the review (see "Source control" above): `files`, and the two trees they are compared
 * between, `fromTree` and `toTree`. A merge and a throw-away need neither.
 * @returns {Promise<{ head, headTree, tree, since, sinceTree, workId, changed, left, files?, fromTree?, toTree? }>}
 */
async function snap(run, root, folder, since, { review = true } = {}) {
  const cwd = folder.path;
  const from = String(since ?? '');
  if (!OID.test(from)) throw new Refusal('git', 'Workbench does not know which commit its work started from.');
  const [start, head, own] = await Promise.all([
    commitOf(cwd, from, run), commitOf(cwd, 'HEAD', run),
    run(['rev-parse', '--git-path', 'index'], { cwd }).then(r => path.resolve(cwd, r.stdout.replace(/\r?\n$/, ''))),
  ]);
  if (!start) throw new Refusal('git', 'The commit its work started from is no longer in this repository.');
  if (!head) throw new Refusal('git', 'Its folder has no commit checked out.');

  // The work as a tree, in a temporary index; meanwhile, what its own ignore rules hide, and the trees it is compared with.
  const work = async () => {
    const scratch = privateTemp('workbench-index-');
    try {
      const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
      if (!copyIndex(own, env.GIT_INDEX_FILE)) await run(['read-tree', head], { cwd, env });
      // A repository inside the folder shows as "name/". `add -A` would fail on one with no commit yet (and then the
      // tree would look unchanged) or record one with commits as a link to that commit: leave them out, and say so.
      const others = nulList((await run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd, env })).stdout);
      const nested = others.filter(p => p.endsWith('/'));
      const add = ['-c', 'core.splitIndex=false', 'add', '-A'];
      if (nested.length) {
        await run([...add, '--pathspec-from-file=-', '--pathspec-file-nul'],
          { cwd, env, timeout: WORKTREE_TIMEOUT_MS, input: ['.', ...nested.map(p => `:(exclude,literal)${p}`)].map(s => `${s}\0`).join('') });
      } else {
        await run(add, { cwd, env, timeout: WORKTREE_TIMEOUT_MS });
      }
      const tree = (await run(['write-tree'], { cwd, env })).stdout.trim();
      if (!OID.test(tree)) throw plainError('Git could not record the agent’s work.');
      return { tree, nested };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
  const [{ tree, nested }, hidden, trees, person] = await Promise.all([
    work(), hiddenByAgent(cwd, from, run), run(['rev-parse', `${head}^{tree}`, `${from}^{tree}`], { cwd }),
    review ? personsHead(run, root, from) : null,
  ]);
  const [headTree, sinceTree] = trees.stdout.split('\n');
  if (!OID.test(headTree || '') || !OID.test(sinceTree || '')) throw plainError('Git could not read a commit it was given.');

  const left = nested.map(p => ({ path: p, why: 'nested-repo' }));
  const named = new Set(nested);
  for (const p of hidden) {
    if (!named.has(p)) { left.push({ path: p, why: p.endsWith('/') ? 'nested-repo' : 'ignored' }); named.add(p); }
  }
  left.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const s = { head, headTree, tree, since: from, sinceTree, workId: `${head}:${tree}`, changed: tree !== sinceTree, left };
  if (!review) return s;
  // Nothing changed since `since`: nothing to merge, and nothing to show.
  const r = s.changed ? await reviewTrees(run, root, s, person.holds ? person.head : null) : { from: sinceTree, to: tree, merged: null };
  [s.fromTree, s.toTree] = [r.from, r.to];
  s.workId = cardId(s, person.head, r.merged);
  s.files = s.fromTree === s.toTree ? [] : await changesBetween(run, root, s.fromTree, s.toTree);
  return s;
}

/**
 * A card's workId: `<head>:<tree>`, the agent folder's HEAD and the tree of its work set, then `:<into>:<merged>`, the
 * review it was shown with: the person's HEAD when the review was made, and the tree that merging the work into it
 * makes (empty when the review was not that merge: a conflict, a HEAD that does not hold `since`, or git could not
 * say). A merge then lands exactly what the card showed, or is refused.
 */
const cardId = ({ head, tree }, into, merged) => `${head}:${tree}:${into || ''}:${merged || ''}`;

/** What a workId says: { work: `<head>:<tree>`, into, merged } (into and merged '' when the review had none), or null. */
function cardOf(workId) {
  const parts = String(workId ?? '').split(':');
  if (parts.length !== 2 && parts.length !== 4) return null;
  if (!OID.test(parts[0]) || !OID.test(parts[1]) || parts.slice(2).some(p => p !== '' && !OID.test(p))) return null;
  return { work: `${parts[0]}:${parts[1]}`, into: parts[2] ?? null, merged: parts[3] ?? null };
}

/**
 * The person's HEAD (null when git cannot say), and whether it holds `since` (so a merge would not be refused for where
 * the work started). Never rejects.
 */
async function personsHead(run, root, since) {
  try {
    const head = await commitOf(root, 'HEAD', run);
    return { head, holds: !!head && (await isAncestor(root, since, head, run)) };
  } catch {
    return { head: null, holds: false };
  }
}

/**
 * The date of the commit merge-tree is given for the work as it is (see reviewTrees): its parent's own (the agent's
 * HEAD's committer date), so the same work on the same HEAD makes the same commit, and it is never older than its
 * parent. git looks for where two histories met newest first: a commit dated before its parent would have it walk all
 * of the person's history first, on every card and diff, where there is no commit-graph. A fixed date when git cannot
 * say.
 */
async function workAsIsDate(run, cwd, head) {
  try {
    const text = (await run(['cat-file', 'commit', head], { cwd })).stdout;
    const m = /^committer [^\n]* (\d+) ([+-]\d{4})$/m.exec(text.slice(0, text.indexOf('\n\n')));
    if (m) return `@${m[1]} ${m[2]}`;
  } catch {}
  return '@1000000000 +0000';
}

/**
 * The two trees the review compares (see "Source control" above), as { from, to }, and `merged`, the tree merge-tree
 * makes, when that is what the review shows (else null): the person's HEAD `into` (null when it does not hold `since`)
 * and that merged tree; on a conflict, where the work's history and HEAD last met and the work; otherwise `since` and
 * the work. merge-tree takes commits, so work not yet committed is given as a commit on top of the agent's HEAD that
 * nothing points at, made by Workbench and dated as that HEAD (see workAsIsDate): the same work makes the same commit
 * each time. Never rejects.
 */
async function reviewTrees(run, root, { head, headTree, tree, sinceTree }, into) {
  if (!into) return { from: sinceTree, to: tree, merged: null };
  try {
    const work = tree === headTree ? head
      : await commitTree(run, root, tree, [head], 'The agent’s work as it is\n', WORKBENCH_IDENTITY, await workAsIsDate(run, root, head));
    const merged = await mergeTrees(run, root, into, work);
    if (merged.tree) return { from: await treeOf(root, into, run), to: merged.tree, merged: merged.tree };
    const met = await run(['merge-base', into, head], { cwd: root, okCodes: [1] });
    const base = met.code === 0 ? met.stdout.trim() : '';
    if (OID.test(base)) return { from: await treeOf(root, base, run), to: tree, merged: null };
  } catch {} // git could not say: the work against `since`, as below
  return { from: sinceTree, to: tree, merged: null };
}

/**
 * merge-tree --write-tree of the commits `into` and `work`, in the person's folder, without --merge-base: git's own
 * merge base, as `git merge` would take (an agent that merged the person's branch into its own would otherwise get
 * false conflicts). It writes objects only, never to a folder.
 * @returns {Promise<{ tree: string } | { conflicts: string[] }>} tree: the merged tree, when it is clean; conflicts:
 *   the paths that are not, from the -z records. Rejects when git fails (exit 1 without a tree is an error, not a conflict).
 */
async function mergeTrees(run, root, into, work) {
  const r = await run(['merge-tree', '--write-tree', '--name-only', '-z', into, work], { cwd: root, okCodes: [1], timeout: WORKTREE_TIMEOUT_MS });
  const fields = r.stdout.split('\0');
  if (!OID.test(fields[0])) throw new Refusal('git', SAY.git);
  if (r.code === 0) return { tree: fields[0] };
  const end = fields.indexOf('', 1);
  return { conflicts: [...new Set(fields.slice(1, end < 0 ? fields.length : end))] };
}

const isBlobMode = mode => mode === '100644' || mode === '100755' || mode === '120000';

/** The fields of `buf` between NUL bytes, as buffers (nothing after a last NUL). */
function nulFields(buf) {
  const out = [];
  let at = 0;
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0, at)) {
    out.push(buf.subarray(at, i));
    at = i + 1;
  }
  if (at < buf.length) out.push(buf.subarray(at));
  return out;
}

/**
 * The files that differ between two trees, in git's order: [{ path, status, adds, dels, binary?, large? }], plus the
 * blob sizes (oldSize, newSize) that workDiff plans its patches with. No rename detection. git's names are read as
 * bytes: `path` is read as UTF-8, `key` is the bytes as they are (one character for each, to compare names exactly),
 * and `lossy` marks a name that is not UTF-8 (two such names can read the same: workDiff gives them no patch).
 */
async function changesBetween(run, cwd, from, to) {
  const common = ['-c', `core.bigFileThreshold=${LARGE_FILE_BYTES}`, 'diff-tree', '-r', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const [rawOut, numstat] = await Promise.all([
    run([...common, '--raw', '--no-abbrev', from, to], { cwd, encoding: 'buffer' }), run([...common, '--numstat', from, to], { cwd, encoding: 'buffer' }),
  ]);
  const raw = nulFields(rawOut.stdout);
  const files = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(raw[i].toString('latin1'));
    if (!m) throw plainError('Git listed the changes in a way Workbench does not understand.');
    const name = raw[i + 1].toString('utf8');
    files.push({
      path: name, key: raw[i + 1].toString('latin1'), lossy: !Buffer.from(name, 'utf8').equals(raw[i + 1]),
      status: m[5] === 'A' ? 'added' : m[5] === 'D' ? 'deleted' : 'modified',
      oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], adds: 0, dels: 0, oldSize: 0, newSize: 0,
    });
  }
  if (!files.length) return files;

  // --numstat lists the same files in the same order, one record each ("<adds>\t<dels>\t<path>"): they are paired by
  // place, and checked by their bytes, never matched by a name read as UTF-8, which two different names can share.
  const records = nulFields(numstat.stdout);
  if (records.length !== files.length) throw plainError('Git listed the changes in a way Workbench does not understand.');
  const counts = files.map((f, k) => {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(records[k].toString('latin1'));
    if (!m || m[3] !== f.key) throw plainError('Git listed the changes in a way Workbench does not understand.');
    return m;
  });
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
  for (const [k, f] of files.entries()) {
    f.oldSize = sizes.get(f.oldId) || 0;
    f.newSize = sizes.get(f.newId) || 0;
    const m = counts[k];
    if (m && m[1] !== '-') {
      f.adds = Number(m[1]);
      f.dels = Number(m[2]);
    }
    if (f.newMode === '120000' && (f.oldMode === '100644' || f.oldMode === '100755')) {
      // A file that became a link always gets its patch, which says where the link points. Git counts the pair as
      // binary when the old file is binary or too large, and then gives that file a single "Binary files" line in the
      // patch: the link's own line is the one counted.
      if (!m || m[1] === '-') f.adds = 1;
    } else if (Math.max(f.oldSize, f.newSize) > LARGE_FILE_BYTES) {
      f.large = true;
    } else if (m && m[1] === '-') {
      f.binary = true;
    }
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
 *   head: its folder's HEAD; tree: the work as a tree; workId: `${head}:${tree}:${into}:${merged}`, the work and the
 *   review it is shown with (see cardId); changed: tree differs from since's.
 *   files: what merging the work into the person's current HEAD would change there, the merge commit's first-parent
 *   diff (see "Source control" above for a conflict, and for a HEAD that does not hold `since`); none when !changed.
 *   Rejects with a plain error (with `.why` when it is a refusal) when the folder is not an agent's or git fails.
 */
export async function snapshotWork({ repoRoot, path: wsPath, since } = {}) {
  try {
    return await withoutHooks(async run => {
      const root = await topFolder(run, repoRoot);
      const s = await snap(run, root, await agentFolder(run, root, wsPath), since);
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

/** `p` in git's C-style quotes: control characters, `"` and `\` escaped, everything else as it is. */
const C_ESCAPES = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };
function cQuoted(p) {
  let out = '';
  for (const ch of p) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || c === 0x7f || c === 34 || c === 92 ? `\\${C_ESCAPES[c] || c.toString(8).padStart(3, '0')}` : ch;
  }
  return `"${out}"`;
}

/** How git writes a path in a patch's header with core.quotePath=false: as it is, or in quotes with C escapes. */
const headerPath = p => (/[\u0000-\u001f\u007f"\\]/.test(p) ? cQuoted(p) : p);

/** The first line of the patch of `path`. */
const patchHeader = p => `diff --git ${headerPath(`a/${p}`)} ${headerPath(`b/${p}`)}\n`;

/**
 * A diff split into one patch per path: [{ head, text }] in git's order. Git prints a path whose type changed (a file
 * that became a link, or the other way) as two parts, the old one deleted and the new one added, one after the other
 * under the same header line: they are one patch.
 */
function patchesByPath(diff) {
  const out = [];
  for (const part of splitPatches(diff)) {
    const head = part.slice(0, part.indexOf('\n') + 1);
    const last = out[out.length - 1];
    if (last && head && last.head === head) last.text += part;
    else out.push({ head, text: part });
  }
  return out;
}

/**
 * The patches of `paths` (in git's order), asked for together, or one by one when the answer does not line up (a path
 * also matches what is inside a folder of that name: a file that became a folder brings in the folder's files).
 */
async function patchesOf(run, cwd, from, to, paths) {
  if (!paths.length) return [];
  const heads = paths.map(patchHeader);
  const together = patchesByPath((await run([...PATCH, from, to, '--', ...paths], { cwd })).stdout);
  if (together.length === paths.length && together.every((x, k) => x.head === heads[k])) return together.map(x => x.text);
  const out = [];
  for (const [k, p] of paths.entries()) {
    const alone = patchesByPath((await run([...PATCH, from, to, '--', p], { cwd })).stdout);
    out.push((alone.find(x => x.head === heads[k]) || alone[0])?.text || '');
  }
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
 * The diff of the agent's work, for people to read: the files of snapshotWork (what its merge would change in the
 * person's branch), with their patches. Never writes the agent's index or files.
 * @param {{ repoRoot: string, path: string, since: string, maxFiles?: number, maxFileBytes?: number, maxTotalBytes?: number }} opts
 * @returns {Promise<{ workId: string, since: string, head: string,
 *   files: { path, status, adds, dels, binary?: true, large?: true, patch: string|null, cut?: true }[],
 *   left: { path: string, why: 'ignored'|'nested-repo' }[], cut?: true, omitted: number }>}
 *   patch: that file's unified diff, `diff --git` header included (for a file that became a link, or a link that became
 *   a file, git's two parts one after the other: the old one deleted, the new one added); null for a binary or large file, and for a file
 *   past maxTotalBytes (then with cut: true). cut on a file: its patch was cut (at a line end) at maxFileBytes or at what
 *   was left of maxTotalBytes; cut on the whole: maxTotalBytes was reached. omitted: files past maxFiles, not listed.
 */
export async function workDiff({ repoRoot, path: wsPath, since, maxFiles = 300, maxFileBytes = 200_000, maxTotalBytes = 2_000_000 } = {}) {
  try {
    return await withoutHooks(async run => {
      const root = await topFolder(run, repoRoot);
      const folder = await agentFolder(run, root, wsPath);
      const s = await snap(run, root, folder, since);
      const limit = Math.max(0, Math.floor(Number(maxFiles)) || 0);
      const shown = s.files.slice(0, limit);
      const files = shown.map(f => ({ ...publicFile(f), patch: null }));
      let budget = Math.max(0, Number(maxTotalBytes) || 0);
      const perFile = Math.max(0, Number(maxFileBytes) || 0);
      let cutAll = false;
      // The files that get a patch. Not one whose name is not UTF-8: asked for by that name read as UTF-8, git would
      // find another file, or none.
      const want = shown.flatMap((f, k) => (f.binary || f.large || f.lossy ? [] : [k]));
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
        const patches = await patchesOf(run, root, s.fromTree, s.toTree, batch.map(k => shown[k].path));
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
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
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

/** commit-tree, as `who`, with a UTF-8 message from stdin, dated `at` (git's form) or now. It runs no hook and signs nothing. */
async function commitTree(run, cwd, tree, parents, message, who, at = undefined) {
  const args = ['-c', 'i18n.commitEncoding=UTF-8', 'commit-tree', '--no-gpg-sign', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-F', '-');
  const env = {
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
    GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at, // without `at`, now, whatever Workbench's own environment says
  };
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
    under = /(?:would be (?:overwritten|removed) by [\w -]+|would lose untracked files in them|are not up to date):$/.test(line);
  }
  return [...new Set(paths)];
}

/**
 * Of `paths` (in the way of the fast-forward, in the person's folder `root`), those that already hold exactly what the
 * merge brings in there: a plain file (not a link or a folder) where M has one (`brought`, M's first-parent diff), whose
 * bytes, cleaned the way git would store them (`hash-object` with their filters), are M's. Anything that cannot be
 * shown to be one counts as the person's own. Never rejects.
 */
async function alreadyThere(run, root, paths, brought) {
  const merged = new Map(brought.filter(f => !f.lossy).map(f => [f.path, f])); // git's words name files as UTF-8
  const asked = paths.filter(p => {
    const f = merged.get(p);
    if (!f || f.status === 'deleted' || !(f.newMode === '100644' || f.newMode === '100755') || !safeParts(p)) return false;
    try {
      return fs.lstatSync(path.join(root, p)).isFile();
    } catch {
      return false;
    }
  });
  if (!asked.length) return new Set();
  try {
    // Each name in quotes: git reads a line that starts with a quote as a quoted name, and drops a carriage return at
    // its end, so a name such as `"x"` would otherwise be read as x.
    const ids = (await run(['hash-object', '--stdin-paths'], { cwd: root, input: asked.map(p => `${cQuoted(p)}\n`).join('') })).stdout.split('\n');
    return new Set(asked.filter((p, i) => ids[i] === merged.get(p).newId));
  } catch {
    return new Set(); // a filter that fails, a file that went meanwhile: theirs, as far as Workbench can tell
  }
}

/**
 * Commit the agent's work on its own branch, then join it into the person's current branch with a merge commit, in
 * the person's folder, by fast-forward only. Every refusal before the work commit changes nothing at all; `conflict`,
 * `blocked` and the later refusals leave the work commit W on the agent's branch (its index reset to match, its files
 * untouched) and change nothing in the person's folder.
 * @param {{ repoRoot: string, path: string, branch: string, since: string,
 *   expect: { workId: string, into: string, intoHead: string }, message: { subject: string, body?: string, name?: string },
 *   agentId: string, harness?: string, name?: string }} opts
 *   expect.workId: snapshotWork's, which names the work and the review the card showed (see cardId);
 *   name: the agent's name for the merge commit's subject ("Merge <name>: <subject>"); its branch when not given
 * @returns {Promise<{ ok: true, into: string, merge: string, work: string, files: number, adds: number, dels: number }
 *   | { ok: false, why: string, sentence: string, paths?: string[] }>}
 *   why: 'detached' | 'busy' | 'identity' | 'git-old' | 'changed' | 'moved' | 'nothing' | 'ancestry' | 'conflict' |
 *   'blocked' | 'gone' | 'git'. Never rejects.
 */
export async function mergeWork(opts = {}) {
  const progress = { into: null, started: false }; // once git began on the person's folder, never say it did not
  try {
    return await withoutHooks(run => merge(run, opts, progress), { detached: true });
  } catch (e) {
    if (progress.started && !(e instanceof Refusal)) return { ok: false, why: 'git', sentence: SAY.unfinished(progress.into) };
    return failure(e, SAY.git);
  }
}

/** A promise's outcome as a value, so it can wait while other checks speak first: { value } or { error }. */
const settle = p => p.then(value => ({ value }), error => ({ error }));
const unwrap = r => {
  if (r.error) throw r.error;
  return r.value;
};

async function merge(run, { repoRoot, path: wsPath, branch, since, expect, message, agentId, harness, name } = {}, progress = {}) {
  const id = String(agentId ?? '');
  if (!AGENT_ID.test(id)) throw new Refusal('git', 'Workbench could not tell which agent this is, so nothing was merged.');
  const exp = expect && typeof expect === 'object' ? expect : {};

  // 1. The person's folder, read afresh. Read together, judged in this order.
  const root = await topFolder(run, repoRoot);
  const [into, inProgress, conflicted, who, version, intoHead, worktrees] = await Promise.all([
    currentBranch(root, run), underWay(root, run), unresolved(root, run), identityAt(run, root), gitVersion(run),
    commitOf(root, 'HEAD', run), listWorktrees(root, run),
  ]);
  if (!into) throw new Refusal('detached', SAY.detached);
  if (inProgress) throw new Refusal('busy', SAY.busy);
  if (conflicted.length) throw new Refusal('busy', SAY.conflicted(conflicted), conflicted);
  if (!who) throw new Refusal('identity', SAY.identity);
  if (!atLeast(version, MIN_GIT)) throw new Refusal('git-old', SAY.gitOld);
  const seen = typeof exp.into === 'string' && exp.into ? exp.into : into;
  if (into !== exp.into || !intoHead || intoHead !== exp.intoHead) throw new Refusal('moved', SAY.moved(seen));
  // The card's review was made against the person's HEAD as it was then (see cardId), read apart from intoHead: a
  // folder that was on another branch then, and is back now, would land what the card did not show.
  const card = cardOf(exp.workId);
  if (card?.into && card.into !== intoHead) throw new Refusal('moved', SAY.moved(into));
  progress.into = into;

  // 2. The agent's work, read afresh (and, meanwhile, step 3's question).
  let folder;
  try {
    folder = await agentFolder(run, root, wsPath, branch, worktrees);
  } catch (e) {
    if (e instanceof Refusal && e.why === 'gone') throw new Refusal('gone', SAY.gone);
    throw e;
  }
  const start = String(since ?? '');
  const [agentBusy, unmerged, snapped, startIn] = await Promise.all([
    underWay(folder.path, run),
    run(['ls-files', '-u', '-z'], { cwd: folder.path }).then(r => r.stdout !== ''),
    settle(snap(run, root, folder, since, { review: false })),
    OID.test(start) ? isAncestor(root, start, intoHead, run).catch(() => false) : false,
  ]);
  if (agentBusy || unmerged) throw new Refusal('git', SAY.agentBusy); // `add -A` would take its conflict markers as work
  const s = unwrap(snapped);
  if (!card || card.into === null || card.work !== s.workId) throw new Refusal('changed', SAY.changed); // no review: none shown
  if (!s.changed) throw new Refusal('nothing', SAY.nothing(into));

  // 3. Its start must be in the person's branch, or the merge would bring in another branch's commits.
  if (!startIn) throw new Refusal('ancestry', SAY.ancestry(into));

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
  // 6. The merge, worked out in the object database (see mergeTrees), the way the review worked it out. Nothing is
  //    written to the person's folder.
  const [already, merged, intoTree] = await Promise.all([
    isAncestor(root, work, intoHead, run), settle(mergeTrees(run, root, intoHead, work)), treeOf(root, intoHead, run),
  ]);
  if (already) throw new Refusal('nothing', SAY.nothing(into));
  const mt = unwrap(merged);
  if (mt.conflicts) throw new Refusal('conflict', SAY.conflict(into), mt.conflicts);
  // The review made this same merge (W has the tree and the parent of the commit the review gave merge-tree), so it
  // made this same tree, unless something it reads changed since: the person's attributes (a merge driver, merge=union)
  // or merge settings. Or the review showed no merge at all (a conflict then, a HEAD that did not hold `since`).
  if (mt.tree !== card.merged) throw new Refusal('changed', SAY.reviewChanged(into));

  // 7. The merge commit M: the person's HEAD first, W second. What it brings in is its first-parent diff, the files
  //    and counts the review showed.
  const mergeMessage = `Merge ${agentName}: ${subject}\n\nWorkbench-Agent: ${id}\nWorkbench-Kind: merge\n`;
  const [mergeCommit, brought] = await Promise.all([
    commitTree(run, root, mt.tree, [intoHead, work], mergeMessage, who),
    mt.tree === intoTree ? [] : changesBetween(run, root, intoTree, mt.tree),
  ]);

  // 8. Check again, then fast-forward the person's folder to M. Git refuses, changing nothing, when their own
  //    changes or files are in the way; ignored files count (--no-overwrite-ignore), and nothing is stashed. Not a
  //    tracked file they deleted (or renamed) without staging it: git takes a missing file for an unchanged one and
  //    writes M's version there, so Workbench looks for those itself first. Only where M changes the file: one that M
  //    deletes too stays deleted, and git writes nothing for one that M does not touch.
  //    No automatic upkeep (gc) is started in their repository either. Git reads branch.<name>.mergeOptions before
  //    these flags, and each flag here outweighs its counterpart there; --no-squash outweighs a --squash, which would
  //    otherwise write and stage M's files while leaving the branch where it was.
  const ff = ['-c', 'submodule.recurse=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'merge', '--ff-only', '--no-squash', '--no-autostash', '--no-overwrite-ignore', '--no-verify-signatures', '-q', mergeCommit];
  const done = {
    ok: true, into, merge: mergeCommit, work,
    files: brought.length, adds: brought.reduce((n, f) => n + f.adds, 0), dels: brought.reduce((n, f) => n + f.dels, 0),
  };
  let r;
  for (let attempt = 1; ; attempt++) {
    const [on, at, busy, conflicts, locked, missing] = await Promise.all([
      currentBranch(root, run), commitOf(root, 'HEAD', run), underWay(root, run), unresolved(root, run), branchLocked(root, into, run),
      deletedFiles(root, run),
    ]);
    if (on !== into || at !== intoHead) throw new Refusal('moved', SAY.moved(into));
    if (busy) throw new Refusal('busy', SAY.busy);
    if (conflicts.length) throw new Refusal('busy', SAY.conflicted(conflicts), conflicts);
    const back = brought.filter(f => f.status === 'modified' && missing.has(f.key)).map(f => f.path);
    if (back.length) throw new Refusal('blocked', SAY.blocked(back), back);
    if (!locked) {
      const kept = await keptForNextCommit(root, run);
      progress.started = true;
      try {
        r = await run(ff, { cwd: root, okCodes: [1, 128], timeout: MERGE_TIMEOUT_MS });
      } finally {
        putBack(kept); // the fast-forward deletes them as if it had ended a merge; this one ended nothing of theirs
      }
      // Another git command holds the index (an editor's git, say): git stopped before it changed anything (exit 1 on
      // newer git, 128 on older).
      if (r.code === 0 || !INDEX_LOCKED.test(r.stderr)) break;
    }
    // Wait a little, then try again.
    if (attempt >= LOCK_TRIES) throw new Refusal('busy', SAY.locked);
    await sleep(200 * attempt);
  }
  const [on, at, busy, conflicts] = await Promise.all([
    currentBranch(root, run), commitOf(root, 'HEAD', run), underWay(root, run), unresolved(root, run).catch(() => []),
  ]);
  if (r.code === 0) {
    if (on !== into || (at !== mergeCommit && !(at && (await isAncestor(root, mergeCommit, at, run))))) {
      throw new Refusal('git', SAY.unfinished(into));
    }
    return done;
  }
  if (on === into && at === mergeCommit) return done; // it moved the branch, then complained about something after
  if (r.code === 1) {
    // Files in the way: git checks every path before it writes any, so nothing changed. Those that already hold what
    // M brings in there are not the person's own changes: a fast-forward that stopped part-way before (a filter that
    // failed, a full disk) leaves the files it wrote, and puts its index back.
    const paths = inTheWay(r.stderr);
    if (paths.length && on === into && at === intoHead) {
      const there = await alreadyThere(run, root, paths, brought);
      const own = paths.filter(p => !there.has(p));
      if (own.length) throw new Refusal('blocked', SAY.blocked(own), own);
      throw new Refusal('git', SAY.alreadyThere(paths), paths);
    }
  } else if (STOPPED_BEFORE.test(r.stderr)) {
    // Exit 128, and git's own words say it stopped before it began: another operation started, conflicts appeared, or
    // the branch moved before git read it. A fast-forward never leaves unresolved conflicts itself: those came from
    // something else, and git refuses to merge over them.
    if (busy) throw new Refusal('busy', SAY.busy);
    if (conflicts.length && on === into && at === intoHead) throw new Refusal('busy', SAY.conflicted(conflicts), conflicts);
    if (on !== into || at !== intoHead) throw new Refusal('moved', SAY.moved(into));
    throw new Refusal('git', SAY.git);
  }
  // Anything else may have stopped part-way through updating their files, so say nothing about them having stayed. Exit
  // 128 is one of these when git wrote the files and the index, then could not move the branch: a command that moves
  // only the branch (`git reset --soft`, say) is not kept out by the index lock git holds while it writes.
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
  const progress = { saved: null }; // once deleting began, never say nothing was deleted
  try {
    return await withoutHooks(run => discard(run, opts, progress), { detached: true });
  } catch (e) {
    if (progress.saved && !(e instanceof Refusal)) {
      return { ok: false, why: 'git', sentence: `Git could not finish throwing its work away. A copy of its work is kept in git as ${progress.saved}.` };
    }
    return failure(e, 'Git could not throw its work away. Nothing was deleted.');
  }
}

async function discard(run, { repoRoot, path: wsPath, branch, since, expect, agentId } = {}, progress = {}) {
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
    const s = await snap(run, root, folder, since, { review: false });
    // The work the card showed. A workId from snapshotWork names the review of a merge too, which is not about what goes.
    if (cardOf(exp.workId)?.work !== s.workId) throw new Refusal('changed', SAY.changed);
    const copy = s.tree === s.headTree ? s.head : await commitTree(run, root, s.tree, [s.head],
      `Thrown away: ${b}\n\nWorkbench-Agent: ${id}\nWorkbench-Kind: discarded\n`, (await identityAt(run, root)) || WORKBENCH_IDENTITY);
    await run(['update-ref', '--create-reflog', '-m', note, saved, copy], { cwd: root });
    progress.saved = saved;
    const remove = ['worktree', 'remove', '--force', ...(folder.locked ? ['--force'] : []), folder.path];
    try {
      await run(remove, { cwd: root, timeout: WORKTREE_TIMEOUT_MS });
    } catch {
      if (fs.existsSync(folder.path)) throw new Refusal('git', `Git could not delete its folder ${folder.path}. A copy of its work is kept in git as ${saved}.`);
      // The folder went, then git stopped: once more, for its record only (never `worktree prune`, see removeWorkspace).
      await run(remove, { cwd: root, timeout: WORKTREE_TIMEOUT_MS }).catch(() => {});
    }
    const gone = await run(['update-ref', '-m', note, '-d', `refs/heads/${b}`, s.head], { cwd: root, okCodes: [1, 128] });
    if (gone.code !== 0) throw new Refusal('git', `Its folder is gone, but its branch ${b} changed meanwhile, so it was kept. A copy of its work is kept in git as ${saved}.`);
    try { fs.rmdirSync(path.dirname(folder.path)); } catch {} // the per-repository folder, only if now empty
    return { ok: true, saved };
  }

  // The folder is already gone: still delete the branch, keeping its last commit. Its worktree record goes by itself
  // (`worktree remove` of a missing folder takes away only that record; never `worktree prune`, which would also take
  // away the records of the person's own worktrees whose folders are away right now). Only when nothing at all is at
  // that path: a folder that is there but could not be read would go with its record, and with the work in it.
  if (entry) {
    if (!nothingAt(entry.path)) throw new Refusal('git', `Workbench cannot read its folder ${entry.path}, so it left the folder and its branch alone.`);
    await run(['worktree', 'remove', '--force', ...(entry.locked ? ['--force'] : []), entry.path], { cwd: root, timeout: WORKTREE_TIMEOUT_MS }).catch(() => {});
  }
  const tip = await commitOf(root, `refs/heads/${b}`, run);
  if (!tip) throw new Refusal('gone', 'Its folder and its branch are already gone.');
  if ((await listWorktrees(root, run)).some(w => w.branch === b)) {
    throw new Refusal('git', `Its branch ${b} is checked out in another folder, so Workbench left it alone.`);
  }
  if (exp.workId != null && cardOf(exp.workId)?.work !== `${tip}:${await treeOf(root, tip, run)}`) throw new Refusal('changed', SAY.changed);
  await run(['update-ref', '--create-reflog', '-m', note, saved, tip], { cwd: root });
  progress.saved = saved;
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
      const [head, branch, refs] = await Promise.all([
        commitOf(root, 'HEAD', run), currentBranch(root, run),
        run(['for-each-ref', '--format=%(objectname)%00%(refname)', 'refs/heads/'], { cwd: root }),
      ]);
      if (!head) throw new Refusal('git', `The repository at ${root} has no commits yet.`);
      const names = new Map(); // commit -> short branch names
      const tips = [head];
      for (const line of refs.stdout.split('\n')) {
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
    throw gitTrouble(e) || plainError('Could not read workbench.json from the commit.', e);
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

// ---------------------------------------------------------------------------------------------
// Connecting: the person's name and email for git, the GitHub sign-in git keeps, and cloning a repository.
//
// These run git from a new empty folder outside every repository, with GIT_CEILING_DIRECTORIES so git looks no
// further up. A repository's own config, which an agent can change, could otherwise name a credential helper (a
// program git runs) or point git elsewhere. Nothing here asks the person anything through git: no terminal prompt
// (GIT_TERMINAL_PROMPT=0, from git()) and no askpass program (an empty GIT_ASKPASS stops git from looking for one,
// SSH_ASKPASS goes, and Git Credential Manager is told never to ask), so a refusal comes back at once as an error.

const CLONE_TIMEOUT_MS = 30 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 15_000;
/** Variables for git commands that reach a server or a credential helper (see above). */
const NO_ASKING = { GIT_ASKPASS: '', SSH_ASKPASS: undefined, SSH_ASKPASS_REQUIRE: undefined, GCM_INTERACTIVE: 'never' };
/** Characters a name or email for git may not hold: control, line-separator and direction-changing ones, and < >. */
const NOT_PRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
/** A GitHub user name: letters, digits and single dashes, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CREDENTIAL_HOSTS = new Set(['github.com']);

/** A plain error from a git command that failed, its words only in `.detail`; `.why` is 'git'. */
function gitFailed(e, sentence, secret = null) {
  const trouble = gitTrouble(e);
  const err = new Error(trouble ? trouble.message : sentence);
  err.plain = true;
  err.why = 'git';
  err.sentence = err.message;
  let detail = String((e && (e.stderr || e.message)) || '').trim();
  if (secret) detail = detail.split(secret).join('••••'); // a credential helper could echo what it was given
  if (detail) err.detail = detail;
  return err;
}

/**
 * `fn(cwd, env)` run from a new empty folder outside every repository (removed afterwards), with git told not to look
 * above it. The folder is Workbench's own (privateTemp), never in the temporary folder: there, another process could put
 * a `.git` in it before git started, and that repository's config could name a credential helper, which git would run
 * and hand the sign-in to.
 */
async function outsideRepos(fn) {
  const dir = privateTemp('workbench-git-');
  try {
    return await fn(dir, { GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The person's own name and email for git, from the global config (the file GIT_CONFIG_GLOBAL names when it is set,
 * else ~/.gitconfig and ~/.config/git/config). Unset ones are ''.
 * @returns {Promise<{ name: string, email: string }>}
 */
export async function gitConfigIdentity() {
  return outsideRepos(async (cwd, env) => {
    const read = async (key) => {
      try {
        const r = await git(['config', '--global', '--get', key], { cwd, env, okCodes: [1] });
        return r.code === 0 ? String(r.stdout).replace(/\r?\n$/, '') : '';
      } catch (e) {
        throw gitFailed(e, 'Git could not read your name and email from its settings.');
      }
    };
    const name = await read('user.name');
    const email = await read('user.email');
    return { name, email };
  });
}

/**
 * Save the person's name and email in git's global config (`git config --global --replace-all user.name|user.email`).
 * The name: 1 to 100 printable characters on one line, without < or >. The email: shaped like an address, at most 254
 * characters. Both are trimmed. Refusals are plain errors with `.why` 'name' or 'email'.
 * @param {{ name: string, email: string }} who
 * @returns {Promise<{ name: string, email: string }>} what was saved
 */
export async function setGitIdentity({ name, email } = {}) {
  const n = typeof name === 'string' ? name.trim() : '';
  const m = typeof email === 'string' ? email.trim() : '';
  if (!n || [...n].length > 100 || NOT_PRINTABLE.test(n)) {
    throw new Refusal('name', 'A name for git must be 1 to 100 characters on one line, without < or >.');
  }
  if (!m || m.length > 254 || NOT_PRINTABLE.test(m) || !EMAIL_RE.test(m)) {
    throw new Refusal('email', 'That does not look like an email address.');
  }
  await outsideRepos(async (cwd, env) => {
    for (const [key, value] of [['user.name', n], ['user.email', m]]) {
      try {
        await git(['config', '--global', '--replace-all', key, value], { cwd, env });
      } catch (e) {
        throw gitFailed(e, 'Git could not save your name and email.');
      }
    }
  });
  return { name: n, email: m };
}

/** The lines `git credential` reads on stdin. Every field is checked: a line break would start another field. */
function credentialInput({ host, username, password }, withPassword) {
  if (!CREDENTIAL_HOSTS.has(host)) throw new Refusal('host', 'Workbench gives git a sign-in for github.com only.');
  if (typeof username !== 'string' || !GITHUB_LOGIN.test(username)) throw new Refusal('username', 'That is not a GitHub user name.');
  let text = `protocol=https\nhost=${host}\nusername=${username}\n`;
  if (withPassword) {
    if (typeof password !== 'string' || !password || password.length > 1000 || /[\r\n\u0000]/.test(password)) {
      throw new Refusal('password', 'That token cannot be given to git.');
    }
    text += `password=${password}\n`;
  }
  return `${text}\n`;
}

/** Whether git has a credential helper for https://github.com: the last value git finds is not the empty reset. */
async function hasCredentialHelper(cwd, env) {
  try {
    const r = await git(['config', '--get-urlmatch', 'credential.helper', 'https://github.com'], { cwd, env, okCodes: [1] });
    return r.code === 0 && String(r.stdout).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Give git a sign-in to keep: `git credential approve`, with the fields on stdin, never in argv. Git hands it to the
 * person's credential helpers (on a Mac usually the login keychain); with no helper set, nothing is kept.
 * @param {{ host: 'github.com', username: string, password: string }} cred
 * @returns {Promise<{ helper: boolean }>} helper: git has a credential helper that keeps it
 */
export async function approveGitCredential({ host, username, password } = {}) {
  const input = credentialInput({ host, username, password }, true);
  return outsideRepos(async (cwd, env) => {
    const quiet = { ...env, ...NO_ASKING };
    try {
      await git(['credential', 'approve'], { cwd, env: quiet, input, timeout: CREDENTIAL_TIMEOUT_MS });
    } catch (e) {
      throw gitFailed(e, 'Git could not keep your GitHub sign-in.', password);
    }
    return { helper: await hasCredentialHelper(cwd, quiet) };
  });
}

/**
 * Make git forget a sign-in: `git credential reject`, with the fields on stdin.
 * @param {{ host: 'github.com', username: string }} cred
 * @returns {Promise<{ ok: true }>}
 */
export async function rejectGitCredential({ host, username } = {}) {
  const input = credentialInput({ host, username }, false);
  await outsideRepos(async (cwd, env) => {
    try {
      await git(['credential', 'reject'], { cwd, env: { ...env, ...NO_ASKING }, input, timeout: CREDENTIAL_TIMEOUT_MS });
    } catch (e) {
      throw gitFailed(e, 'Git could not forget your GitHub sign-in.');
    }
  });
  return { ok: true };
}

/**
 * The sign-in git keeps for this host and user (`git credential fill`, fields on stdin), or null when it keeps none:
 * git then exits 128, since it may not ask. Never rejects. The password is never logged.
 * @param {{ host: 'github.com', username: string }} cred
 * @returns {Promise<{ username: string, password: string } | null>}
 */
export async function fillGitCredential({ host, username } = {}) {
  let input;
  try {
    input = credentialInput({ host, username }, false);
  } catch {
    return null;
  }
  return outsideRepos(async (cwd, env) => {
    let r;
    try {
      r = await git(['credential', 'fill'], { cwd, env: { ...env, ...NO_ASKING }, input, timeout: CREDENTIAL_TIMEOUT_MS });
    } catch {
      return null;
    }
    const fields = {};
    for (const line of String(r.stdout).split('\n')) {
      const i = line.indexOf('=');
      if (i > 0 && !(line.slice(0, i) in fields)) fields[line.slice(0, i)] = line.slice(i + 1);
    }
    if (fields.host !== host || !fields.password || (fields.username && fields.username !== username)) return null;
    return { username, password: fields.password };
  }).catch(() => null); // no folder to run git from
}

// ---- cloning

/** How long git may take to stop by itself when a clone is stopped (SIGTERM, which it tidies up after), before SIGKILL. */
const CLONE_STOP_GRACE_MS = 1000;
/** After that SIGKILL, how long to wait for the last process holding git's output before going on without it. */
const CLONE_STOP_WAIT_MS = 1000;

/**
 * Clones under way: the process id of each git, which leads a process group of its own, and what to remove if
 * Workbench exits while it copies. They run detached from the terminal, so nothing else would end them.
 */
const runningClones = new Map();
let clonesWatched = false;
function watchClones() {
  if (clonesWatched) return;
  clonesWatched = true;
  // An exit cannot wait for git to tidy up after itself: its whole group is killed at once, then what it made goes.
  process.on('exit', () => {
    for (const [pid, tidy] of runningClones) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      try { tidy?.(); } catch { /* what is left stays */ }
    }
  });
}

/**
 * git with an argument array (as git() runs it: core.fsmonitor=false first, the scrubbed environment), its stderr read
 * line by line as it comes (git rewrites a progress line with \r). Git runs in a process group and session of its own:
 * it has no terminal, so ssh cannot stop to ask on one, and the time limit ends the whole group (SIGTERM, then SIGKILL
 * 5 seconds later).
 *
 * `signal` (an AbortSignal) stops it sooner: SIGTERM to the whole group, SIGKILL a second later if anything is left,
 * and the promise settles once git is gone (or a second after that SIGKILL, when a process outside the group still
 * holds git's output). `tidy` is what Workbench's exit removes when git is still running then.
 *
 * Resolves `{ code: 0, stderr }`; rejects with an error carrying .code, .signal, .killed and .stderr (the last 64 KB)
 * and, when it was stopped, .stopped; or with the spawn error (.code 'ENOENT' when git is missing).
 */
function gitStream(args, { cwd, timeout, env, onLine, signal, tidy }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('git was stopped before it started'), { stopped: true, stderr: '' }));
      return;
    }
    const childEnv = gitEnv();
    for (const [k, v] of Object.entries(env || {})) {
      if (v === undefined) delete childEnv[k];
      else childEnv[k] = v;
    }
    let child;
    try {
      child = spawn('git', [...GIT_SAFE_CONFIG, ...args], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let stderr = '';
    let pending = '';
    let killed = false;
    let stopped = false;
    let ended = false;
    const stopTimers = [];
    const group = (sig) => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const timer = timeout > 0 ? setTimeout(() => {
      killed = true;
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), 5000).unref?.();
    }, timeout) : null;
    const stop = () => {
      if (ended || stopped) return;
      stopped = true;
      group('SIGTERM');
      stopTimers.push(setTimeout(() => {
        group('SIGKILL');
        stopTimers.push(setTimeout(() => end(null, null, 'SIGKILL'), CLONE_STOP_WAIT_MS));
      }, CLONE_STOP_GRACE_MS));
    };
    signal?.addEventListener('abort', stop, { once: true });
    const line = (l) => {
      if (!l.trim()) return;
      try { onLine(l); } catch { /* a progress listener must not stop the clone */ }
    };
    child.stdout.on('data', () => {}); // clone writes nothing there; drain it anyway
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
      const parts = (pending + chunk).split(/[\r\n]/);
      pending = parts.pop();
      if (pending.length > 64 * 1024) pending = '';
      for (const l of parts) line(l);
    });
    const end = (err, code, sig) => {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      for (const t of stopTimers) clearTimeout(t);
      signal?.removeEventListener('abort', stop);
      if (child.pid) runningClones.delete(child.pid);
      line(pending);
      pending = '';
      if (stopped) {
        group('SIGKILL'); // anything of git's group still there
        reject(Object.assign(new Error('git was stopped'), { code, signal: sig, killed, stopped: true, stderr }));
      } else if (err) {
        err.stderr = stderr;
        reject(err);
      } else if (code === 0 && !killed) {
        resolve({ code: 0, stderr });
      } else {
        reject(Object.assign(new Error('git clone failed'), { code, signal: sig, killed, stderr }));
      }
    };
    child.on('error', (e) => end(e));
    child.on('close', (code, sig) => end(null, code, sig));
    if (child.pid) {
      runningClones.set(child.pid, typeof tidy === 'function' ? tidy : null);
      watchClones();
    }
  });
}

/** git's progress lines for a clone, and the phase each one is. Lines from the server start with "remote: ". */
const CLONE_PHASES = [
  [/^(?:remote:\s*)?(?:Enumerating|Counting) objects:\s+(?:(\d{1,3})%)?/, 'counting'],
  [/^(?:remote:\s*)?Compressing objects:\s+(\d{1,3})%/, 'compressing'],
  [/^Receiving objects:\s+(\d{1,3})%/, 'receiving'],
  [/^Resolving deltas:\s+(\d{1,3})%/, 'resolving'],
  [/^(?:Updating|Checking out) files:\s+(\d{1,3})%/, 'checkout'],
];

/**
 * One line of git's clone progress as `{ phase, percent }`, or null for any other line. `phase` is 'counting',
 * 'compressing', 'receiving', 'resolving' or 'checkout'; `percent` is 0 to 100, or null when git gave none.
 */
export function cloneProgressOf(line) {
  const l = String(line ?? '').trim();
  for (const [re, phase] of CLONE_PHASES) {
    const m = re.exec(l);
    if (m) return { phase, percent: m[1] == null ? null : Math.min(100, Number(m[1])) };
  }
  return null;
}

/**
 * The refusal of an address Workbench does not clone from. The Mac app's own check of an address says the same words,
 * and neither repeats the address: it may be a key pasted into the wrong field.
 */
const CLONE_ADDRESS_REFUSED = 'Workbench clones addresses like https://github.com/owner/repo or git@github.com:owner/repo.git.';

/**
 * What a clone address is: `{ url, kind: 'https'|'ssh'|'scp'|'local', host, path }`, where `url` is what git is given:
 * the address trimmed, with its scheme in lower case (git looks for a transport named as written, and protocol.HTTPS
 * is not protocol.https). Accepted: https://host/path (no user or password in it, no query), ssh://[user@]host/path,
 * and [user@]host:path (scp-like); a file:// address or an absolute path only with allowLocal (tests). Everything else
 * is refused, as `.why` 'url' with CLONE_ADDRESS_REFUSED: ext::, fd:: and the other transport::address forms, file://,
 * http://, git://, anything starting with "-", anything with a backslash (URL reads one as "/" in https, git and curl
 * do not: https://github.com\@evil.example/… would be checked as github.com and cloned from evil.example), and an
 * https address with an "@" before its path, which only a user name would put there.
 */
function cloneSource(raw, allowLocal) {
  let url = typeof raw === 'string' ? raw.trim() : '';
  const refuse = () => new Refusal('url', CLONE_ADDRESS_REFUSED);
  if (!url || url.length > 2000 || /[\s\u0000-\u001f\u007f-\u009f\\]/.test(url) || url.startsWith('-')) throw refuse();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const kind = scheme[1].toLowerCase();
    url = kind + url.slice(scheme[1].length);
    if (kind === 'https' && url.slice(scheme[0].length).split('/', 1)[0].includes('@')) throw refuse();
    let u;
    try {
      u = new URL(url);
    } catch {
      throw refuse();
    }
    if (kind === 'https' || kind === 'ssh') {
      const host = u.hostname.toLowerCase();
      if (!host || host.startsWith('-') || u.password || (kind === 'https' && u.username) || u.username.startsWith('-')
        || !/[^/]/.test(u.pathname) || u.search || u.hash) throw refuse();
      return { url, kind, host, path: u.pathname };
    }
    if (kind === 'file' && allowLocal && !u.search && !u.hash) return { url, kind: 'local', host: null, path: u.pathname };
    throw refuse();
  }
  if (url.includes('::')) throw refuse();
  const scp = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]*)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(.+)$/.exec(url);
  if (scp && !scp[3].startsWith('-') && /[^/]/.test(scp[3])) return { url, kind: 'scp', host: scp[2].toLowerCase(), path: scp[3] };
  if (allowLocal && path.isAbsolute(url)) return { url, kind: 'local', host: null, path: url };
  throw refuse();
}

/** The folder name git would pick: the last part of the address's path, without a trailing / or .git. */
function cloneFolderName(p) {
  let s = String(p).replace(/\/+$/, '');
  if (/\/\.git$/i.test(s)) s = s.slice(0, -5).replace(/\/+$/, '');
  let base = s.slice(s.lastIndexOf('/') + 1);
  if (/\.git$/i.test(base)) base = base.slice(0, -4);
  return base;
}

function validFolderName(n) {
  return typeof n === 'string' && n !== '' && n !== '.' && n !== '..' && !n.includes('/') && !/[\u0000-\u001f\u007f]/.test(n)
    && Buffer.byteLength(n) <= 255;
}

/** git's words when it was refused a repository (a private one, no sign-in). A key ssh would not use is CLONE_SSH_KEY. */
const CLONE_AUTH =/Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Repository not found|Invalid username or password|HTTP Basic: Access denied|The requested URL returned error: 40[13]|Write access to repository not granted/i;
/** git's words when it could not reach the host. Checked after CLONE_AUTH: ssh says "Could not read from remote repository" for both. */
const CLONE_NETWORK = /Could not resolve host|Could not resolve hostname|nodename nor servname|Name or service not known|Temporary failure in name resolution|Failed to connect|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Couldn't connect to server|Connection reset|Connection closed|SSL|TLS|certificate|unable to access|early EOF|remote end hung up unexpectedly|RPC failed|The requested URL returned error: 5\d\d/i;
/**
 * ssh's words when it would not go on with this Mac's SSH key: the server took no key of this Mac's, or this Mac does
 * not know the server's key yet. Neither is a sign-in a GitHub token mends: that is for https addresses.
 */
const CLONE_SSH_KEY = /Permission denied \(publickey|Host key verification failed/i;
const CLONE_EXISTS = /already exists and is not an empty directory/i;

/**
 * Remove what a stopped clone made: its new folder, or, when the folder was there before (empty, as cloneRepo found
 * it), what is in it now. Never anything else, and never the folder it was put in.
 */
function removeHalfMade(dest, existed) {
  try {
    if (!existed) {
      fs.rmSync(dest, { recursive: true, force: true });
      return;
    }
    if (!fs.lstatSync(dest).isDirectory()) return;
    for (const entry of fs.readdirSync(dest)) fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
  } catch { /* gone already, or it cannot be removed: what is left stays */ }
}

/** The plain error for a clone that failed, with git's own words only in `.detail`. */
function cloneFailure(e, src) {
  const text = String((e && e.stderr) || '');
  const where = src.host || 'that repository';
  const err = (why, sentence) => {
    const out = new Refusal(why, sentence);
    const detail = text.trim() || String((e && e.message) || '').trim();
    if (detail) out.detail = detail;
    return out;
  };
  if (e && (e.code === 'ENOENT' || e.killed)) return err('git', gitTrouble(e).message);
  if (CLONE_EXISTS.test(text)) return err('exists', 'Something is already in the folder it would go into. Choose another folder.');
  if ((src.kind === 'ssh' || src.kind === 'scp') && CLONE_SSH_KEY.test(text)) {
    return err('ssh', src.host === 'github.com'
      ? 'GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, sign in to GitHub first.'
      : `${where} did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository, make sure git can sign in to ${where} first.`);
  }
  if (CLONE_AUTH.test(text)) {
    return err('auth', src.host === 'github.com'
      ? 'GitHub did not let Workbench read this repository. If it is private, sign in to GitHub, then try again.'
      : `${where} did not let Workbench read this repository. If it is private, make sure git can sign in to ${where}, then try again.`);
  }
  if (CLONE_NETWORK.test(text)) return err('network', `Workbench could not reach ${where}.`);
  return err('git', `Git could not clone ${clip(src.url, 120)}.`);
}

/**
 * Clone a repository into a new folder.
 *
 * `url`: see cloneSource. `into`: the folder to put it in, as given, spaces at its ends included (made when missing;
 * ~ is the home folder). `name`: the new
 * folder's name, by default the last part of the address without .git; never empty, ".", ".." or holding "/". The
 * new folder must not exist, or must be an empty folder. Git runs as `git -c protocol.allow=never -c
 * protocol.https.allow=always -c protocol.ssh.allow=always [-c protocol.file.allow=always] clone --progress -- <url>
 * <folder>` (file only with allowLocal, for tests; GIT_ALLOW_PROTOCOL in Workbench's environment is taken away, since
 * it would override those settings), from a folder outside every repository, with no prompts (see above), detached
 * from the terminal, within `timeoutMs` (30 minutes unless given). `onProgress({ phase, percent })` hears each change
 * of git's progress (see cloneProgressOf).
 *
 * `signal` (an AbortSignal) stops the clone: git's whole process group is stopped (gitStream), what the clone made is
 * removed (the new folder, or what it put in a folder that was empty), and cloneRepo rejects with `.why` 'stopped'. A
 * clone that finished just as it was stopped is removed too, so a stop always leaves things as they were. Should
 * Workbench exit while git copies, its exit does the same.
 *
 * Refusals and failures are plain errors with `.why`: 'url' (an address Workbench does not clone from, or no folder
 * name in it), 'exists' (something is already there, or the folder cannot be made), 'ssh' (an ssh or scp-like address
 * ssh would not go on with: the server took no SSH key of this Mac's, or this Mac does not know the server's key; on
 * GitHub "GitHub did not accept this Mac’s SSH key. Use the https:// address instead; for a private repository,
 * sign in to GitHub first."), 'auth' (refused: a private repository, no sign-in; on GitHub "GitHub did not
 * let Workbench read this repository. If it is private, sign in to GitHub, then try again."), 'network'
 * ("Workbench could not reach <host>."), 'stopped' (see `signal`) or 'git' (anything else), with git's own words in
 * `.detail`. A folder the clone made is removed again when it fails.
 * @returns {Promise<{ root: string }>} the new folder's real path
 */
export async function cloneRepo({ url, into, name, onProgress, timeoutMs = CLONE_TIMEOUT_MS, allowLocal = false, signal } = {}) {
  const src = cloneSource(url, allowLocal);
  const folderName = name == null ? cloneFolderName(src.path) : name;
  if (!validFolderName(folderName)) {
    throw new Refusal('url', name == null
      ? `Workbench could not tell what to call the folder for ${clip(src.url, 80)}.`
      : `“${clip(String(folderName), 40)}” cannot be the name of a folder.`);
  }
  if (typeof into !== 'string' || !into.trim() || into.includes('\u0000')) throw new Refusal('exists', 'No folder was given to put the repository in.');
  const stopped = () => new Refusal('stopped', 'Copying the repository was stopped.');
  if (signal?.aborted) throw stopped(); // before any folder is made
  const parent = path.resolve(expandHome(into)); // as given: a folder's name may end in a space
  if (fs.existsSync(parent) && !isFolder(parent)) throw new Refusal('exists', `${parent} is a file, not a folder.`);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch {
    throw new Refusal('exists', `Workbench could not make the folder ${parent}.`);
  }
  if (!isFolder(parent)) throw new Refusal('exists', `Workbench could not make the folder ${parent}.`);
  const dest = path.join(parent, folderName);
  let existed = false;
  try {
    const st = fs.lstatSync(dest);
    existed = true;
    if (!st.isDirectory() || fs.readdirSync(dest).length > 0) {
      throw new Refusal('exists', `There is already something at ${dest}. Choose another folder, or move it away first.`);
    }
  } catch (e) {
    if (e instanceof Refusal) throw e;
    if (e.code !== 'ENOENT') throw new Refusal('exists', `Workbench could not look at ${dest}.`);
  }
  const args = ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    ...(src.kind === 'local' ? ['-c', 'protocol.file.allow=always'] : []), 'clone', '--progress', '--', src.url, dest];
  let last = null;
  const onLine = (l) => {
    const p = cloneProgressOf(l);
    if (!p || typeof onProgress !== 'function' || (last && last.phase === p.phase && last.percent === p.percent)) return;
    last = p;
    onProgress({ ...p });
  };
  const tidy = () => removeHalfMade(dest, existed);
  try {
    await outsideRepos((cwd, env) => gitStream(args, {
      cwd, timeout: timeoutMs, env: { ...env, ...NO_ASKING, GIT_ALLOW_PROTOCOL: undefined }, onLine, signal, tidy,
    }));
    if (signal?.aborted) throw Object.assign(new Error('git finished as it was stopped'), { stopped: true });
  } catch (e) {
    if (e && e.stopped) {
      // Git is gone (its group was ended): what it made goes, unless git found the folder taken by something else.
      if (!CLONE_EXISTS.test(String(e.stderr || ''))) tidy();
      throw stopped();
    }
    const failure = cloneFailure(e, src);
    if (!existed && failure.why !== 'exists') fs.rmSync(dest, { recursive: true, force: true }); // git made it; it normally removes it itself
    throw failure;
  }
  return { root: fs.realpathSync.native(dest) };
}
