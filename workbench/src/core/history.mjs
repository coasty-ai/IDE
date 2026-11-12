// History: what Workbench remembers about root agents after it stops, so the next run can show them again and
// pick them up. One small JSON file per repository: ~/.workbench/history/<repo key>.json, where the key is the same
// <name>-<hash> that names the repository's worktree folder (workspacesFolder in workspace.mjs).
//
// A record is built field by field from an AgentView (recordOf), so nothing else can get into the file: no hook
// token, no page token, no environment, no check output. Writes are atomic (a temp file, then a rename), and the
// file keeps the last MAX_ROOTS roots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ACTIVE, STATE } from '../shared/states.mjs';
import { clip } from '../shared/format.mjs';
import { workspacesFolder } from './workspace.mjs';

export const MAX_ROOTS = 50;
export const VERSION = 1;
const FILES_MAX = 200;
const TEXT_MAX = 2000;
const HARNESSES = new Set(['claude', 'codex']);
const STATES = new Set(Object.values(STATE));
const CLOSED_WHILE_ACTIVE = 'Workbench was closed while it was working.';

/** Where one repository's history lives: <home>/.workbench/history/<repo key>.json (`dir` replaces the folder). */
export function historyFile(repoRoot, { dir = null } = {}) {
  const key = path.basename(workspacesFolder(repoRoot));
  const folder = dir ? path.resolve(dir) : path.join(os.homedir(), '.workbench', 'history');
  return path.join(folder, `${key}.json`);
}

const num = (x, d = 0) => (Number.isFinite(x) ? x : d);
const numOrNull = (x) => (Number.isFinite(x) ? x : null);
const str = (x, max = 200) => (typeof x === 'string' && x ? x.slice(0, max) : null);

/** A commit id: 40 hex characters (SHA-1) or 64 (SHA-256), else null. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha = (x) => (typeof x === 'string' && SHA_RE.test(x) ? x : null);

/**
 * A branch name git takes as it is, else null. It keeps to the rule of workspace.mjs's validRef (letters, digits and
 * ._/@^~{}+-, no leading "-", no "..") and to git's own rules for branch names: parts joined by single "/", none empty
 * or starting with ".", none ending in ".lock", nothing ending in "." or "/", no "@{", "^", "~", "{" or "}".
 */
export function branchName(x) {
  if (typeof x !== 'string' || !x || x.length > 200) return null;
  if (x.startsWith('-') || x.includes('..') || x.endsWith('.')) return null;
  if (!/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(x)) return null;
  if (x.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) return null;
  return x;
}

/** An agent's own branch: a branch name that starts with "workbench/", else null. */
export function agentBranch(x) {
  const b = branchName(x);
  return b && b.startsWith('workbench/') ? b : null;
}

/** Where a throw-away keeps its hidden copy: refs/workbench/discarded/<agent id>. */
const SAVED_RE = /^refs\/workbench\/discarded\/[A-Za-z0-9_-]{1,80}$/;
/** Why a merge did not go through, as AgentView.work.problem keeps it. */
const PROBLEM_WHYS = new Set(['conflict', 'blocked', 'ancestry', 'moved', 'identity', 'detached', 'busy', 'git']);
const PATHS_MAX = 20;

function cleanFiles(f) {
  if (!f || typeof f !== 'object') return null;
  const list = (Array.isArray(f.list) ? f.list : []).slice(0, FILES_MAX).map((x) => {
    const o = { path: String(x?.path ?? '').slice(0, 500), adds: num(x?.adds), dels: num(x?.dels) };
    for (const k of ['binary', 'large', 'untracked', 'ignored']) if (x?.[k]) o[k] = true;
    return o;
  });
  return { changed: num(f.changed), adds: num(f.adds), dels: num(f.dels), list };
}

function cleanChecks(c) {
  if (!c || typeof c !== 'object') return null;
  // A check that was running when Workbench closed did not finish: show it as not checked.
  if (c.state === 'running') return { state: 'none', results: [] };
  const state = ['none', 'passed', 'failed'].includes(c.state) ? c.state : 'none';
  const results = (Array.isArray(c.results) ? c.results : []).slice(0, 20)
    .map(r => ({ name: String(r?.name ?? 'Check').slice(0, 80), ok: !!r?.ok, ms: num(r?.ms) })); // never the output's tail
  return { state, results };
}

function cleanRules(r) {
  if (!r || typeof r !== 'object') return null;
  const say = (x) => String(x?.say ?? '').slice(0, 300);
  return {
    kept: (Array.isArray(r.kept) ? r.kept : []).slice(0, 20).map(x => ({ say: say(x) })),
    broken: (Array.isArray(r.broken) ? r.broken : []).slice(0, 20).map(x => ({
      say: say(x), paths: (Array.isArray(x?.paths) ? x.paths : []).slice(0, 20).map(p => String(p).slice(0, 500)),
    })),
  };
}

function cleanUsage(u) {
  const o = u && typeof u === 'object' ? u : {};
  return {
    inputTokens: num(o.inputTokens), outputTokens: num(o.outputTokens),
    cacheReadTokens: num(o.cacheReadTokens), cacheWriteTokens: num(o.cacheWriteTokens),
    costUsd: numOrNull(o.costUsd), unreportedUsd: num(o.unreportedUsd),
    contextTokens: numOrNull(o.contextTokens), contextWindow: numOrNull(o.contextWindow), contextPct: numOrNull(o.contextPct),
  };
}

/**
 * An agent's folder and git places, field by field: { path, branch, base, since, from }. base and since are commit ids
 * (since: where its unmerged work starts, its last merged work commit once it has been merged); branch is its own
 * workbench/ branch; from is the person's branch when it started.
 */
function cleanWorkspace(w) {
  if (!w || typeof w !== 'object' || typeof w.path !== 'string' || !path.isAbsolute(w.path)) return null;
  if (w.path.length > 4096 || w.path.includes('\0')) return null;
  return { path: w.path, branch: agentBranch(w.branch), base: sha(w.base), since: sha(w.since), from: branchName(w.from) };
}

/** What became of an agent's work in git (AgentView.work), field by field. */
function cleanWork(w) {
  if (!w || typeof w !== 'object') return null;
  const m = w.merged && typeof w.merged === 'object' ? w.merged : null;
  const p = w.problem && typeof w.problem === 'object' ? w.problem : null;
  const t = w.thrownAway && typeof w.thrownAway === 'object' ? w.thrownAway : null;
  const merged = m && sha(m.merge)
    ? { into: branchName(m.into), merge: m.merge, at: num(m.at), files: num(m.files), adds: num(m.adds), dels: num(m.dels) }
    : null;
  const problem = p && PROBLEM_WHYS.has(p.why)
    ? {
      why: p.why,
      sentence: str(p.sentence, 600) || '',
      paths: (Array.isArray(p.paths) ? p.paths : []).filter(x => typeof x === 'string' && x).slice(0, PATHS_MAX).map(x => x.slice(0, 500)),
      into: branchName(p.into),
      at: num(p.at),
    }
    : null;
  const thrownAway = t ? { at: num(t.at), saved: typeof t.saved === 'string' && SAVED_RE.test(t.saved) ? t.saved : null } : null;
  return {
    branch: thrownAway ? null : agentBranch(w.branch),
    from: branchName(w.from),
    folder: !thrownAway && w.folder === true,
    merged,
    problem,
    thrownAway,
  };
}

/**
 * The record of one root agent, from its view and its workspace ({ path, branch, base, since, from }; null: its folder
 * is gone; left out: only the view's folder path is known). Returns null for anything
 * that is not a root Claude Code or Codex agent worth remembering.
 */
export function recordOf(view, workspace = undefined, savedAt = Date.now()) {
  if (!view || view.parentId || !HARNESSES.has(view.harness) || typeof view.id !== 'string') return null;
  // A launch that never got going left nothing to come back to.
  if (view.state === STATE.FAILED && !view.sessionId && !view.turns) return null;
  const a = view.approvals || {};
  return {
    id: view.id,
    name: str(view.name, 80) || 'Agent',
    task: clip(String(view.task ?? ''), TEXT_MAX),
    harness: view.harness,
    model: str(view.model),
    machineId: str(view.machineId) || 'laptop',
    startedAt: num(view.startedAt, savedAt),
    endedAt: numOrNull(view.endedAt),
    state: STATES.has(view.state) ? view.state : STATE.STOPPED,
    stateReason: str(view.stateReason, 300),
    says: view.says ? clip(String(view.says), TEXT_MAX) : null,
    files: cleanFiles(view.files),
    checks: cleanChecks(view.checks),
    rules: cleanRules(view.rules),
    approvals: { auto: num(a.auto), byYou: num(a.byYou), denied: num(a.denied) },
    usage: cleanUsage(view.usage),
    sessionId: str(view.sessionId),
    // `workspace` null means its folder was removed; undefined means ask the view
    workspace: workspace === undefined ? (view.workspace ? cleanWorkspace({ path: view.workspace }) : null) : cleanWorkspace(workspace),
    work: cleanWork(view.work),
    budgetUsd: numOrNull(view.budgetUsd),
    turns: num(view.turns),
    toolCalls: num(view.toolCalls),
    savedAt,
  };
}

/** A record read from the file, made safe: unknown fields dropped, odd values replaced. Null when it is no record. */
export function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id)) return null;
  if (!HARNESSES.has(raw.harness)) return null;
  const savedAt = num(raw.savedAt, Date.now());
  const rec = recordOf({
    id: raw.id, parentId: null, name: raw.name, task: raw.task, harness: raw.harness, model: raw.model, machineId: raw.machineId,
    startedAt: raw.startedAt, endedAt: raw.endedAt, state: raw.state, stateReason: raw.stateReason, says: raw.says,
    files: raw.files, checks: raw.checks, rules: raw.rules, approvals: raw.approvals, usage: raw.usage,
    sessionId: raw.sessionId, budgetUsd: raw.budgetUsd, turns: raw.turns || 1, toolCalls: raw.toolCalls, work: raw.work,
  }, raw.workspace, savedAt);
  if (!rec) return null;
  // Whatever was still going when the file was written is not going now.
  if (ACTIVE.has(rec.state)) {
    rec.state = STATE.STOPPED;
    rec.stateReason = CLOSED_WHILE_ACTIVE;
  }
  if (rec.endedAt == null) rec.endedAt = savedAt;
  return rec;
}

/** The newest `max` records by start time. */
export function prune(records, max = MAX_ROOTS) {
  return [...records].sort((a, b) => a.startedAt - b.startedAt).slice(-max);
}

/** Write a file so a reader never sees half of it: a temp file in the same folder, then a rename. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], corrupt: false };
    throw err;
  }
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data?.agents) ? data.agents : [];
    return { records: list.map(cleanRecord).filter(Boolean), corrupt: false };
  } catch {
    return { records: [], corrupt: true };
  }
}

export class History {
  /**
   * @param {object} o
   * @param {string} o.file        the history file
   * @param {number} [o.max]       roots kept
   * @param {number} [o.debounceMs]  how long a change waits for more before it is written
   * @param {string} [o.repoRoot]  written into the file, for a person who opens it
   */
  constructor({ file, max = MAX_ROOTS, debounceMs = 1500, repoRoot = null, log = null } = {}) {
    this.file = file;
    this.max = max;
    this.debounceMs = debounceMs;
    this.repoRoot = repoRoot;
    this.log = log;
    this._timer = null;
    this._source = null;       // () => records: what to write, read when the write happens
    this._forgotten = new Set();
    this._dirty = false;
  }

  /** The earlier agents: the newest `max` records. A file that cannot be read is set aside and treated as empty. */
  load() {
    let res;
    try {
      res = readRecords(this.file);
    } catch (err) {
      this._warn('Workbench could not read its history:', err);
      return [];
    }
    if (res.corrupt) {
      this._warn('Workbench’s history file was damaged, so it was set aside and a new one will be started.');
      try { fs.renameSync(this.file, `${this.file}.damaged`); } catch { /* ignore */ }
    }
    return prune(res.records, this.max);
  }

  /** Take this id out of the file, and keep it out. */
  forget(id) {
    this._forgotten.add(id);
    this.schedule();
  }

  /** What to write: called when a write happens, so it is always the latest. */
  source(fn) {
    this._source = fn;
  }

  /** Something changed: write soon, once for a run of changes. */
  schedule() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  /** The record of a root agent (see recordOf). */
  recordOf(view, workspace, savedAt) {
    return recordOf(view, workspace, savedAt);
  }

  /** Write now whether or not anything changed since the last write (shutdown, forget). */
  save() {
    this._dirty = true;
    return this.flush();
  }

  /** Write now (and at shutdown). Never throws: a history that cannot be written must not stop the agents. */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty || !this._source) return false;
    try {
      const mine = (this._source() || []).filter(r => r && !this._forgotten.has(r.id));
      const ids = new Set(mine.map(r => r.id));
      // Another Workbench on the same repository may have written agents of its own meanwhile: keep them.
      let others = [];
      try { others = readRecords(this.file).records.filter(r => !ids.has(r.id) && !this._forgotten.has(r.id)); } catch { /* start afresh */ }
      const agents = prune([...others, ...mine], this.max);
      writeAtomic(this.file, JSON.stringify({ version: VERSION, repo: this.repoRoot, agents }, null, 1) + '\n');
      this._dirty = false;
      return true;
    } catch (err) {
      this._warn('Workbench could not save its history:', err);
      return false;
    }
  }

  close() {
    this.save();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _warn(...args) {
    try { this.log?.warn?.(...args); } catch { /* logging never breaks history */ }
  }
}

/** The injected dependency the engine uses: `deps.history.open({ repoRoot, ... })`. */
export function open({ repoRoot, dir = null, ...rest } = {}) {
  return new History({ file: historyFile(repoRoot, { dir }), repoRoot, ...rest });
}
