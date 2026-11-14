// The engine: launches agents, turns their events into state, holds risky actions for the person,
// notices agents that might be stuck, and answers the UI. Everything a person reads is plain language.
//
// Dependencies are injected so the engine can be tested with fakes:
//   adapters: { claude?, codex?, sim? }   claude/codex are runner modules, sim is a Simulator instance
//   deps:     { policy, commands, workspace, receipt, history? }
//   connect:  optional, the Connect service (src/core/connect.mjs): the person's keys for agents and checks
//             (envFor), hiding those keys (mask), and the default agent (defaultAgent). Absent: no keys, nothing
//             hidden, and new work goes to the first agent that is ready.
// This file must not import those modules directly. Each git function it uses (snapshotWork, workDiff, mergeWork,
// discardWork, gitGraph, gitIdentity, ...) is checked with typeof first, so an older workspace module gives a plain
// refusal instead of a crash.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EV } from '../shared/events.mjs';
import { STATE, ENDED, ACTIVE, DONE, NEEDS_YOU } from '../shared/states.mjs';
import { nameFromTask, firstSentence, extractQuestion, plain, describeRequest, quotable } from '../shared/narrate.mjs';
import { money, spentAmount, duration, clip } from '../shared/format.mjs';
import { looksLikeSecret } from '../shared/secretshape.mjs';
import { StuckDetector } from './stuck.mjs';

const MIN = 60_000;
const DEFAULTS = Object.freeze({
  permissionTimeoutMs: 25 * MIN, // a held permission request counts as "no" after this
  stuckSilenceMs: 4 * MIN,       // stuck rule 3
  tickMs: 1000,
  simTickMs: 250,
  machinesEveryMs: 5000,
  repoEveryMs: 15_000,
  confirmTtlMs: 10 * MIN,        // how long a "Start …?" question stays answerable
  stopTimeoutMs: 8000,           // give up waiting for a runner to stop after this
  tidyTimeoutMs: 3000,           // at shutdown, give up removing unchanged agent folders after this
  helperWaitMs: 1500,            // wait this long for a helper the hook names but the parser has not shown yet
  exitGraceMs: 1000,             // after a process exits, wait this long for its last lines
  availableTimeoutMs: 15_000,
});
const DEFAULT_CONFIG = Object.freeze({ checks: [], rules: [], allow: [] });
const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex', sim: 'A simulated agent' };
// The real coding agents, in the order a default is picked when the person has chosen none: every harness but the
// simulator. A new kind of agent joins by its name in HARNESS_NAMES.
const AGENT_HARNESSES = Object.freeze(Object.keys(HARNESS_NAMES).filter(h => h !== 'sim'));
// What is kept of an adapter's available() answer, or of Connect's: no other field (an account's email, say) reaches
// the snapshot.
const INFO_FIELDS = ['ok', 'version', 'reason', 'path', 'from', 'loggedIn', 'signedIn', 'how', 'ready', 'simulated'];
const NO_AGENT = 'No coding agent is ready yet. Connect one in Agents & keys.';
const SECRET_REFUSED = 'That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe.';
const CONNECT_REPLY = 'Opening Agents & keys.';
// A variable name a key may use, and the names the engine never passes on as a key, whatever the key store allowed:
// Workbench's own, and those that decide which programs run, as whom, and where Claude Code keeps its sessions (the
// permission check reads those folders).
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KEY_REFUSED_RE = /^(WORKBENCH_.*|PATH|HOME|USER|LOGNAME|SHELL|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|CLAUDE_CONFIG_DIR|CLAUDE_CODE_TMPDIR)$/;
// Fields of an event that the engine and the page read back as names of things (ids, folders, branches, kinds): never
// masked, so a key that happens to match one cannot change what it points at.
const MASK_SKIP = new Set(['kind', 'agentId', 'parentId', 'rootId', 'id', 'askId', 'toolUseId', 'taskId', 'sessionId',
  'harness', 'model', 'machineId', 'workspace', 'branch', 'from', 'base', 'since', 'head', 'path', 'state', 'type',
  'phase', 'toolKind', 'outcome', 'mode', 'ts']);
// After the person stops an agent, these late events from its process are still useful.
const AFTER_STOP_OK = new Set([EV.USAGE, EV.ENDED, EV.SESSION, EV.MODEL]);
// States after which an agent cannot use the answer to a held request: they go through at once.
const FINAL = new Set([STATE.FINISHED, STATE.FAILED, STATE.STOPPED]);
// What the history file follows: a change to one of these is worth writing (debounced).
const HISTORY_KINDS = new Set([EV.CREATED, EV.STATE, EV.SAYS, EV.FILES, EV.CHECKS, EV.RULES, EV.MODEL, EV.SESSION,
  EV.APPROVAL, EV.USAGE, EV.ENDED, EV.RESUMED, EV.WORK]);
const CONTINUE_TEXT = 'Please continue where you left off.';
// Why a turn failed when it reached the spending limit (Claude Code's error_max_budget_usd, in the parser's words too).
const LIMIT_REASON = 'It reached its spending limit.';
// From this version on, Claude Code restores a resumed session's totals itself (see _withEarlierSpend).
const RESTORES_SPEND_FROM = Object.freeze([2, 1, 277]);
// What a merged agent has left to merge: nothing.
const NO_FILES = Object.freeze({ changed: 0, adds: 0, dels: 0, list: [] });
// Every reason mergeWork gives for not merging. Any other is read as 'git'.
const MERGE_WHYS = new Set(['detached', 'busy', 'identity', 'git-old', 'changed', 'moved', 'nothing', 'ancestry', 'conflict', 'blocked', 'gone', 'git']);
// Why a merge did not go through, when it is worth keeping on the agent (work.problem) until it clears.
const PROBLEM_WHYS = new Set(['conflict', 'blocked', 'ancestry', 'moved', 'identity', 'detached', 'busy', 'git']);
// The demo has no real git: without the simulator's git methods it says so; with them, its replies say nothing real happened.
const DEMO_NO_MERGE = 'This is the demo, so nothing is really merged.';
const DEMO_NO_DISCARD = 'This is the demo, so nothing is really thrown away.';
const DEMO_MERGED = 'This is the demo: nothing was really merged.';
const DEMO_THROWN = 'This is the demo: nothing was really thrown away.';
const THROWN_REASON = 'Its work was thrown away, so it cannot continue.';
const NOT_KEPT_REASON = 'Its folder was not kept, so it cannot continue.';
const WHICH_ONE = 'Which one do you mean? Pick it on the board, then ask again.';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/;
// A permission's buttons say exactly these. Typed or spoken words reach a permission only through command().
const ALLOW_LABEL_RE = /^allow$/i;
const DENY_LABEL_RE = /^deny$/i;
const LOOKS_GOOD_RE = /^(looks good|look good|lgtm|great|thanks|thank you|good|fine|ok|okay|all good)[.!]*$/i;
// The lid's "Not now" on work that can be merged: the agent stays as it is, and the reply does not sound like approval.
const NOT_NOW_RE = /^not now[.!]*$/i;
const HELP = 'I did not catch that. Say what to work on, like “the login page is broken”, or ask “what needs me”.';
// The answer to "help", "hi" or "what can you do": short enough for three lines under the DRAM on the narrowest board.
const HELP_REPLY = 'Say what to work on, like “fix the login bug”. Or ask “what needs me”, or “stop everything”. Agents & keys sets up agents.';
const GONE = 'That request is no longer waiting. Ask again if you still want it.';

/** How a state reads after an agent's name: "Checkout fix needs your OK". */
const PHRASE = Object.freeze({
  starting: 'is starting',
  working: 'is working',
  waiting_helpers: 'is waiting', // _describe says what for, from its `now`
  needs_ok: 'needs your OK',
  question: 'has a question',
  maybe_stuck: 'might be stuck',
  done_checked: 'is done and checked',
  done_claimed: 'says it is done',
  checks_failed: 'is done, but a check failed',
  finished: 'finished its part',
  failed: 'failed',
  stopped: 'was stopped',
});

// ------------------------------------------------------------------ small helpers

function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** An error whose message is meant for the person. */
function plainError(message) {
  const e = new Error(message);
  e.plain = true;
  return e;
}

function plainReason(err) {
  if (!err) return 'something went wrong';
  if (err.plain) return err.message;
  const m = err.message || String(err);
  return clip(m, 160) || 'something went wrong';
}

function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function joinAnd(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

function joinOr(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`;
}

function harnessName(h) {
  return HARNESS_NAMES[h] || 'That kind of agent';
}

/**
 * Text an agent or Claude Code wrote, fit for one log line: line breaks and tabs become spaces, any other control,
 * hidden or direction-changing character shows as "?" (so it cannot start a line of its own, such as a WORKBENCH_APP
 * line the Mac app reads), and at most 300 characters. Stored keys are already hidden in the events it comes from.
 */
function logText(s) {
  const t = typeof s === 'string' ? s.replace(/\r\n|[\r\n\t]/g, ' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?').replace(/ {2,}/g, ' ').trim() : '';
  return clip(t, 300);
}

/**
 * `s` when it is one plain line fit to stand in a reply as it is: a sentence of at most 300 characters that starts
 * with a capital or a digit, ends with a full stop, and holds no control, hidden or direction-changing character.
 */
function plainLine(s) {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length <= 300 && /^[A-Z0-9][^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*\.$/u.test(t) ? t : null;
}

/**
 * What the engine keeps of a harness's availability (an adapter's available(), or Connect's word for it): the fields
 * in INFO_FIELDS. Nothing at all reads as not found; true or false as { ok }.
 */
function harnessInfoOf(res, h) {
  if (res == null) return { ok: false, reason: `${harnessName(h)} was not found on this computer.` };
  if (typeof res !== 'object') return { ok: !!res };
  const out = {};
  for (const f of INFO_FIELDS) if (res[f] !== undefined) out[f] = res[f];
  return out;
}

/**
 * `value` with every string of 8 or more characters (no stored key is shorter) passed through `mask`, at any depth,
 * except fields named in `skip`. Copies only what changes: the value itself comes back when nothing did.
 */
function maskValue(value, mask, skip = null, depth = 0) {
  if (typeof value === 'string') return value.length >= 8 ? mask(value) : value;
  if (!value || typeof value !== 'object' || depth > 12) return value;
  let out = value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const m = maskValue(value[i], mask, skip, depth + 1);
      if (m !== value[i]) {
        if (out === value) out = value.slice();
        out[i] = m;
      }
    }
    return out;
  }
  for (const k of Object.keys(value)) {
    if (skip && skip.has(k)) continue;
    const m = maskValue(value[k], mask, skip, depth + 1);
    if (m !== value[k]) {
      if (out === value) out = { ...value };
      out[k] = m;
    }
  }
  return out;
}

/** What "do it" does to a confirm card: "start it", "stop them", "send it", "merge it", "throw it away". */
function confirmVerb(c) {
  switch (c.kind) {
    case 'say': return 'send it';
    case 'forget': return 'forget it';
    case 'merge': return 'merge it';
    case 'discard': return 'throw it away';
    case 'stop': return `stop ${c.agentIds?.length > 1 ? 'them' : 'it'}`;
    case 'start': return `start ${c.tasks?.length > 1 ? 'them' : 'it'}`;
    default: return 'go ahead';
  }
}

/** "2.1.322" -> [2, 1, 322]; null when it does not start like a version. */
function versionParts(v) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Is version v at least min ([major, minor, patch])? null when v is not a version. */
function versionAtLeast(v, min) {
  const p = versionParts(v);
  if (!p) return null;
  for (let i = 0; i < 3; i++) if (p[i] !== min[i]) return p[i] > min[i];
  return true;
}

const count = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);

/** "3 files, +40 −2" */
function countsText(files, adds, dels) {
  return `${files} file${files === 1 ? '' : 's'}, +${adds} −${dels}`;
}

/** The counts of a list of changed files: { files, adds, dels }. */
function countFiles(list) {
  const a = Array.isArray(list) ? list : [];
  let adds = 0;
  let dels = 0;
  for (const f of a) { adds += count(f?.adds); dels += count(f?.dels); }
  return { files: a.length, adds, dels };
}

/** Where an agent's unmerged work starts: its last merged work commit, else the commit it started from. */
function sinceOf(ws) {
  return (ws && (ws.since || ws.base)) || null;
}

/**
 * Work in a root's folder that is not merged yet, read as the page reads it (ui/queue.js unmergedWork): files changed
 * since its last merge (or since it started), or, when the files are not known, a stopped, failed or earlier agent,
 * which may hold some.
 */
function unmergedWork(v) {
  const w = v && v.work;
  if (!w || w.thrownAway || !w.folder) return false;
  if (v.files) return count(v.files.changed) > 0;
  return v.state === STATE.STOPPED || v.state === STATE.FAILED || !!v.earlier;
}

/** A root's work is settled: thrown away, or merged with nothing new since (ui/queue.js workSettled). */
function workSettled(v) {
  const w = v && !v.parentId ? v.work : null;
  if (!w) return false;
  return !!w.thrownAway || (!!w.merged && !unmergedWork(v));
}

/** "a.js, b.js and c.js", or "a.js, b.js, c.js and 2 more": paths as words fit for a sentence. */
function pathWords(paths, max = 3) {
  const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p).map(p => quotable(p, 80));
  if (list.length <= max) return joinAnd(list);
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/**
 * A commit subject made from the task: the first sentence of its first line, its first letter capitalised, cut at a
 * word boundary to at most 72 characters. Hidden characters become spaces; a single full stop at the end goes, as git
 * subjects have none.
 */
function commitSubject(task, fallback) {
  const line = String(task ?? '').split(/\r\n|[\r\n\u2028\u2029]/).find(l => l.trim()) || '';
  let t = quotable(line.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ''), 100_000);
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9“"'(]|$)/.exec(t); // a sentence ends before a capital, not at "e.g. the" or "U.S. date"
  if (m) t = m[1];
  t = t.replace(/(?<!\.)\.$/, '').trim();
  if (t.length > 72) {
    const cut = t.slice(0, 73);
    const sp = cut.lastIndexOf(' ');
    t = (sp >= 24 ? cut.slice(0, sp) : t.slice(0, 72)).replace(/[\s,;:–—-]+$/, '');
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t || fallback;
}

/** The agent's own summary for a commit's body: one plain paragraph, or '' when it could pass for a git trailer. */
function commitBody(text) {
  const t = quotable(String(text ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, ''), 2000);
  return /^[A-Za-z0-9-]+\s*:/.test(t) ? '' : t;
}

/** A merge that did not go through, in plain words, from mergeWork's `why`. */
function mergeSentence(why, { name, into, paths } = {}) {
  const branch = into || 'your branch';
  switch (why) {
    case 'detached': return 'Your folder is not on a branch, so there is nowhere to merge it.';
    case 'busy': return 'Your folder is in the middle of a merge or rebase. Finish that first.';
    case 'identity': return 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.';
    case 'git-old': return 'Workbench needs git 2.38 or newer to merge.';
    case 'changed': return `${name}’s work changed since you looked. Have another look.`;
    case 'moved': return `${branch} changed since you looked. Have another look.`;
    case 'nothing': return `${name}’s work is already in ${branch}.`;
    case 'ancestry': return `${name} started from a commit that is no longer in ${branch}, so merging it would bring in other work.`;
    case 'conflict': return `${name}’s work does not merge cleanly into ${branch}.`;
    case 'blocked': {
      const words = pathWords(paths);
      return words
        ? `Your own changes are in the way: ${words}. Commit or put them aside, then merge again.`
        : 'Your own changes are in the way. Commit or put them aside, then merge again.';
    }
    case 'gone': return 'Its folder is gone, so there is nothing to merge.';
    default: return 'Git could not finish the merge. Nothing in your folder changed.';
  }
}

/** What Workbench cannot do with an agent's work, for "…so it cannot <verb>." */
const WORK_VERB = Object.freeze({ show: 'show its changes', merge: 'merge its work', 'throw away': 'throw its work away' });

/**
 * A sentence of the git functions, which say "its" for the agent, made to name it: "Its work changed since you looked."
 * becomes "Fix login’s work changed since you looked.", and "It started from …" becomes "Fix login started from …".
 */
function aboutAgent(name, sentence) {
  const s = String(sentence ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (/^Its\s/.test(s)) return `${name}’s ${s.slice(4)}`;
  if (/^It\s/.test(s)) return `${name} ${s.slice(3)}`;
  return s;
}

/**
 * What a git function's thrown error means for agent `v`: { gone: true } when its folder is gone (`why: 'gone'`), else
 * { reply }: the error's own plain sentence (git functions throw plain errors), or `fallback` for anything else.
 */
function gitRefusal(v, err, fallback) {
  if (err && err.why === 'gone') return { gone: true, reply: null };
  if (err && err.plain && typeof err.message === 'string' && err.message.trim()) return { gone: false, reply: aboutAgent(v.name, err.message) };
  return { gone: false, reply: fallback };
}

/** What a throw-away's hidden copy leaves out: files a .gitignore hides, folders that are git repositories of their own. */
function leftOutWords(left) {
  const list = Array.isArray(left) ? left : [];
  const ignored = list.filter(l => l?.why === 'ignored').length;
  const nested = list.filter(l => l?.why === 'nested-repo').length;
  const parts = [];
  if (ignored) parts.push(`${ignored} file${ignored === 1 ? ' that a .gitignore hides' : 's that a .gitignore hides'}`);
  if (nested) parts.push(`${nested} folder${nested === 1 ? ' that is a git repository of its own' : 's that are git repositories of their own'}`);
  return parts.length ? `The hidden copy leaves out ${joinAnd(parts)}.` : '';
}

/** A folder Workbench made for an agent, still there: a directory with a .git entry. */
function folderThere(p) {
  try {
    return typeof p === 'string' && fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, '.git'));
  } catch {
    return false;
  }
}

/** Strip a sentence's own end mark, so it can go inside another sentence. */
function unend(s) {
  return String(s ?? '').trim().replace(/[.!?]+$/, '');
}

function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'task';
}

function hookResponse(decision, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(plainError('It took too long.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Why a turn ended in error, in a few plain words. */
function errorReason(e) {
  const sub = String(e.subtype || '');
  const text = String(e.finalText || '');
  if (e.reason) return clip(plain(e.reason), 160);
  if (/budget/i.test(sub) || /budget/i.test(text)) return LIMIT_REASON;
  if (/max_turns/i.test(sub)) return 'It reached the limit on how many steps it may take.';
  return firstSentence(text, 160) || 'It stopped because of an error.';
}

/** Check results without anything unexpected; tails stay short. */
function cleanResults(results) {
  return (Array.isArray(results) ? results : []).map(r => {
    const out = { name: String(r?.name ?? 'Check'), ok: !!r?.ok, ms: Number(r?.ms) || 0 };
    if (r?.tail) out.tail = String(r.tail).slice(-2000);
    return out;
  });
}

function makeLog(log) {
  const call = (level) => (...args) => {
    try {
      if (log && typeof log[level] === 'function') log[level](...args);
      else if (typeof log === 'function') log(level, ...args);
    } catch { /* logging never breaks the engine */ }
  };
  const f = call('info');
  f.info = call('info');
  f.warn = call('warn');
  f.error = call('error');
  f.debug = call('debug');
  return f;
}

// ------------------------------------------------------------------ the engine

export class Engine extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./store.mjs').Store} o.store
   * @param {'demo'|'live'} o.mode
   * @param {object|string|null} o.repo   live mode: prepareRepo() result, or a path to prepare in start()
   * @param {{ url: string|null, tokenFor: (agentId: string) => string }} o.hook  where Claude Code's PreToolUse hook
   *        posts, and each agent's own hook token; the object is read at each launch, so the URL can be filled in
   *        after the server listens
   * @param {object|null} [o.connect]  the Connect service, or null: envFor({ repoRoot, harness }) gives the keys an
   *        agent (and the checks of its work) get, mask(text) hides the stored keys in everything the engine applies,
   *        and defaultAgent() says where new work goes.
   */
  constructor({ store, mode = 'demo', repo = null, hook = null, defaultBudgetUsd = 2, defaultModel = null, adapters = {}, machines = null, deps = {}, connect = null, log = null, options = {} } = {}) {
    super();
    if (!store) throw new Error('The engine needs a store.');
    this.store = store;
    this.mode = mode === 'live' ? 'live' : 'demo';
    this.repo = repo;
    this.repoInfo = repo && typeof repo === 'object' ? repo : null;
    this.hook = hook || { url: null, tokenFor: null };
    this.defaultBudgetUsd = Number.isFinite(+defaultBudgetUsd) && +defaultBudgetUsd > 0 ? +defaultBudgetUsd : 2;
    this.defaultModel = defaultModel || null;
    this.adapters = adapters || {};
    this.machines = machines;
    this.deps = deps || {};
    this.connect = connect && typeof connect === 'object' ? connect : null;
    // Hides the person's stored keys in text: for the runners, the checks and every event applied. Null without one.
    this._mask = typeof this.connect?.mask === 'function' ? (s) => this._maskText(s) : null;
    this.log = makeLog(log);
    this.options = { ...DEFAULTS, ...options };
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.stuck = new StuckDetector({ silenceMs: this.options.stuckSilenceMs });

    this.history = null;        // live mode: the open history of this repository (deps.history.open), or null
    this.earlierRecs = new Map(); // rootId -> history record, for the agents restored from it that nobody has continued
    this._resuming = new Set(); // earlier agents being continued now
    this.runs = new Map();      // rootId -> run record for agents this engine launched
    this.held = new Map();      // askId -> a held permission request
    this.later = new Map();     // agentId -> { ask?, state? }: decisions that wait until its held requests are answered
    this._checkingHeld = false;
    this.asks = new Map();      // askId -> { agentId, type } for asks the engine created
    this.confirms = new Map();  // confirmId -> a launch, stop or message waiting for "yes"
    this.stopped = new Set();   // agents the person stopped; late events from them are filtered
    this.stopAsked = new Set(); // live helpers whose root was asked to stop them: no more tools, but their events count
    this.harnessInfo = Object.fromEntries([...AGENT_HARNESSES, 'sim'].map(h => [h, null]));
    this._told = new Set();      // harnesses Connect has said can or cannot start (setHarnesses): its word stands
    this._timers = [];
    this._started = false;
    this._shuttingDown = false;
    this._shutdownPromise = null;
    this._launching = new Set(); // launches under way (_startAgent): shutdown lets them finish first
    // Merging and throwing away. Every job touches the same repository (the person's own folder, for a merge), so
    // they run one at a time, engine-wide (_gitJob). While an agent's job waits or runs, the agent is busy: nothing
    // else may wake, stop, continue or forget it. Shutdown waits for the jobs under way.
    this._busy = new Map();      // rootId -> 'merge' | 'discard'
    this._gitChain = Promise.resolve();
    this._gitWork = new Set();   // git jobs under way
    this._mergedEarlier = new Set(); // earlier agents merged in this run: the shutdown tidy looks at their folders too
    this.repoIdentity = null;    // live mode: does git know the person's name and email (true/false); null: not known
    this._repoKey = null;        // the repository as the page last heard of it (see _setRepo)
    this._repoReading = null;    // a periodic refresh of the repository under way
    this._repoSeq = 0;           // reads of the repository begun (_freshRepo)...
    this._repoKept = 0;          // ...and the latest one kept
    this._machineKeys = new Map();
    this._lastMachinesAt = 0;
    this._lastRepoAt = 0;
    // Machines change on their own too (a cloud machine finishes waking up).
    this._onMachinesUpdate = () => this._syncMachines();
    if (typeof machines?.on === 'function') machines.on('update', this._onMachinesUpdate);
  }

  // ================================================================ lifecycle

  /** Demo: seed the simulator. Live: prepare the repo and check the adapters. Then tick every second. */
  async start() {
    if (this._started) return;
    if (this.mode === 'live') {
      await this._loadRepo();
      this.repoIdentity = await this._readIdentity(this.repoInfo.root);
      this._repoKey = JSON.stringify(this._repoView());
      await this._checkHarnesses();
      this._openHistory();
    } else {
      const ok = !!this.adapters.sim;
      this.harnessInfo = { ...Object.fromEntries(AGENT_HARNESSES.map(h => [h, { ok, simulated: true }])), sim: { ok } };
    }
    this._started = true;
    if (this.mode === 'demo') {
      try { await this.adapters.sim?.seedWorld?.(); } catch (err) { this.log.error('The simulator could not seed the demo:', err); }
    }
    await this._refreshMachines(); // after seeding, so the seeded agents are counted
    this._lastMachinesAt = this.now();
    this._lastRepoAt = this.now();
    const tick = setInterval(() => this.tick(), this.options.tickMs);
    tick.unref?.();
    this._timers.push(tick);
    if (this.mode === 'demo' && typeof this.adapters.sim?.tick === 'function') {
      const simTick = setInterval(() => {
        try { this.adapters.sim.tick(this.now()); } catch (err) { this.log.error('The simulator tick failed:', err); }
      }, this.options.simTickMs);
      simTick.unref?.();
      this._timers.push(simTick);
    }
  }

  /**
   * Stop every runner and every running check, and wait for them; answer every held permission request with "no";
   * remove the agent folders that hold nothing. Resolves to `{ kept }`: the folders that hold an agent's work, which
   * stay after Workbench stops ([{ id, name, path, branch }], as keptFolders() gives them).
   */
  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shuttingDown = true;
    this._shutdownPromise = (async () => {
      for (const t of this._timers) clearInterval(t);
      this._timers = [];
      try { this.machines?.off?.('update', this._onMachinesUpdate); this.machines?.dispose?.(); } catch { /* ignore */ }
      for (const id of [...this.later.keys()]) this._dropLater(id);
      for (const held of [...this.held.values()]) {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason: 'Workbench is shutting down.', silent: true });
      }
      // A launch under way (git still making its folder, a process starting) finishes first, so no agent starts unseen
      // after this: one whose folder was made too late starts nothing and gives the folder back (_launch), and one
      // already starting is stopped below with the others.
      if (this._launching.size) {
        await withTimeout(Promise.allSettled([...this._launching]), this.options.stopTimeoutMs)
          .catch(() => this.log.warn('A launch did not finish in time.'));
      }
      // A merge or a throw-away under way finishes first: it may be moving the person's own branch, and stopping it
      // half-way helps nobody. Each git call it makes has its own time limit, and no new one starts from now on.
      if (this._gitWork.size) await Promise.allSettled([...this._gitWork]);
      const runs = [...this.runs.values()].filter(r => r.runner);
      for (const r of runs) {
        r.stopped = true;
        this.stopped.add(r.id);
      }
      // Checks end alongside the agents (SIGTERM now, SIGKILL 2 s later in receipt.mjs): wait for them too.
      const checks = [];
      for (const r of this.runs.values()) {
        this._cancelReceipt(r);
        if (r.checksDone) checks.push(r.checksDone);
      }
      const checksEnded = withTimeout(Promise.all(checks), this.options.stopTimeoutMs)
        .catch(() => this.log.warn('Some checks did not end in time.'));
      const results = await Promise.allSettled(runs.map(r => withTimeout(Promise.resolve().then(() => r.runner.stop()), this.options.stopTimeoutMs)));
      results.forEach((res, i) => { if (res.status === 'rejected') this.log.warn(`Could not stop ${runs[i].id}:`, res.reason); });
      await checksEnded;
      const batch = [];
      for (const r of runs) {
        const v = this.store.get(r.id);
        if (!v || !ACTIVE.has(v.state)) continue;
        for (const d of this.store.descendants(v.id)) {
          if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Workbench was closed' });
        }
        batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason: 'Workbench was closed' });
      }
      if (batch.length) this._apply(batch);
      // Folders where nothing changed go; the others stay, so the person can look at the work afterwards.
      // A runner that would not stop may still be writing in its folder: that one stays.
      const tidy = [...this.runs.values()].filter(r => r.workspace && !r.folderRemoved && !this._busy.has(r.id)
        && this._runnerInfo(r)?.alive !== true);
      tidy.push(...this._earlierToTidy());
      if (tidy.length) {
        await withTimeout(Promise.all(tidy.map(r => this._removeUnchanged(r))), this.options.tidyTimeoutMs)
          .catch(() => this.log.warn('Some agent folders were not tidied up in time.'));
      }
      // Last, so what the tidying did (a removed folder) and the final states are in it.
      try { this.history?.close(); } catch (err) { this.log.warn('Could not save the history:', err); }
      return { kept: this.keptFolders() };
    })();
    return this._shutdownPromise;
  }

  /**
   * The agent folders still on this computer, with their branches: [{ id, name, path, branch }]. Synchronous, so a
   * forced exit can say where they are too. After shutdown() these hold work; before it, or when the exit was forced
   * before the tidying, they may include folders where nothing changed.
   */
  keptFolders() {
    return [...this.runs.values()].filter(r => r.workspace && !r.folderRemoved).map(r => ({
      id: r.id, name: this.store.get(r.id)?.name || r.name || r.id, path: r.workspace.path, branch: r.workspace.branch ?? null,
    }));
  }

  /** Last resort on process exit: signal every live agent process group and end every check, synchronously. */
  killAllSync() {
    try { this.deps.receipt?.killChecksSync?.(); } catch { /* ignore */ }
    try { this.history?.save(); } catch { /* ignore */ }
    for (const r of this.runs.values()) {
      try { r.receipt?.ctl.abort(); } catch { /* ignore */ }
      let info = null;
      try { info = r.runner?.info?.(); } catch { info = null; }
      if (!info || !info.alive || !info.pid) continue;
      try { process.kill(-info.pid, 'SIGTERM'); } catch {
        try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
  }

  /** Called every second: sparklines, stuck checks, confirm expiry, machines, repo status. */
  tick(now = this.now()) {
    try { this.store.tick(now); } catch (err) { this.log.error('Store tick failed:', err); }
    try { this._checkStuck(now); } catch (err) { this.log.error('Stuck check failed:', err); }
    try { this._checkWaiting(now); } catch (err) { this.log.error('Background check failed:', err); }
    for (const [id, c] of this.confirms) if (now - c.createdAt > this.options.confirmTtlMs) this.confirms.delete(id);
    if (now - this._lastMachinesAt >= this.options.machinesEveryMs) {
      this._lastMachinesAt = now;
      this._refreshMachines();
    }
    if (this.mode === 'live' && now - this._lastRepoAt >= this.options.repoEveryMs) {
      this._lastRepoAt = now;
      this._refreshRepo();
    }
  }

  // ================================================================ events

  /**
   * Take one normalized event from a runner or the simulator. Applies it to the store and
   * reacts: decides a root's state at the end of its turn, finishes helpers, clears stuck agents.
   */
  ingest(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') return;
    // The person's stored keys are hidden first, so nothing below (the store, the receipt, listeners) sees them.
    let e = this._maskEvent({ ...ev, ts: Number.isFinite(ev.ts) ? ev.ts : this.now() });
    if (e.kind === EV.SAYS && e.text != null) e.text = plain(e.text);
    if (e.kind === EV.SESSION) this._noteVersion(e);
    if (e.kind === EV.USAGE && e.mode === 'set') e = this._withEarlierSpend(e);
    if (this._isStopped(e)) {
      if (!AFTER_STOP_OK.has(e.kind)) return;
      if (e.kind === EV.ENDED) e = { ...e, outcome: 'stopped', error: null };
    }
    this._apply([e], { masked: true });
    try {
      this._react(e);
    } catch (err) {
      this.log.error('The engine could not handle an event:', err);
    }
    this.emit('event', e);
  }

  _isStopped(e) {
    if (!this.stopped.size) return false;
    if (e.kind === EV.CREATED) {
      const parent = e.parentId ? this.store.get(e.parentId) : null;
      return !!e.parentId && (this.stopped.has(e.parentId) || (parent && this.stopped.has(parent.rootId)));
    }
    if (!e.agentId) return false;
    if (this.stopped.has(e.agentId)) return true;
    const v = this.store.get(e.agentId);
    return !!v && this.stopped.has(v.rootId);
  }

  /**
   * Apply events to the store and feed them to the stuck detector. No held permission request may leave the view:
   * see _waitForHeld and _keepHeldVisible. Every text field is masked first (the person's stored keys), so the store,
   * the event log, history and the page never hold a key.
   * @param {{ held?: boolean, masked?: boolean }} [opts]  held: the batch shows or settles held requests itself
   *   (_hold, _resolveHeld); masked: ingest() has masked it already
   */
  _apply(events, { held = false, masked = false } = {}) {
    let list = (Array.isArray(events) ? events : [events])
      .filter(Boolean)
      .map(e => (Number.isFinite(e.ts) ? e : { ...e, ts: this.now() }));
    if (!masked && this._mask) list = list.map(e => this._maskEvent(e));
    if (!held && this.held.size) list = this._waitForHeld(list);
    if (!list.length) return;
    const failing = this.mode === 'live' ? this._newlyFailed(list) : [];
    this.store.apply(list);
    // A yes to a launch is logged when Claude Code or Codex is spawned ("1 of 1 started"). What goes wrong after that
    // (it exits, or its first turn ends in an error) is logged here, with the reason the page gives.
    for (const id of failing) {
      const v = this.store.get(id);
      if (v) this.log.warn(`${logText(v.name) || 'An agent'} failed: ${logText(v.stateReason) || 'it gave no reason.'}`);
    }
    if (this.history && list.some(e => HISTORY_KINDS.has(e.kind))) this.history.schedule();
    const progressed = new Set();
    for (const e of list) {
      if (e.kind === EV.NOTICE || e.kind === EV.MACHINE) continue;
      const sig = this.stuck.observe(e);
      if (sig && sig.progress) progressed.add(sig.agentId);
    }
    for (const id of progressed) this._clearStuck(id);
    if (this.held.size) this._keepHeldVisible();
  }

  /** The agents (not helpers) that this batch turns to failed from another state, each once. */
  _newlyFailed(list) {
    const now = new Map();
    const out = [];
    for (const e of list) {
      if (e.kind !== EV.STATE || !e.agentId) continue;
      const v = this.store.get(e.agentId);
      if (!v || v.parentId) continue;
      const was = now.has(e.agentId) ? now.get(e.agentId) : v.state;
      if (e.state === STATE.FAILED && was !== STATE.FAILED && !out.includes(e.agentId)) out.push(e.agentId);
      now.set(e.agentId, e.state);
    }
    return out;
  }

  /** The held request an agent is showing, if any. */
  _heldShowing(agentId) {
    const a = agentId ? this.store.get(agentId)?.ask : null;
    const h = a ? this.held.get(a.id) : null;
    return h && h.agentId === agentId ? h : null;
  }

  /**
   * While an agent shows a held request, the engine's other decisions about it (the end of a turn: waiting on
   * helpers, a question, the receipt's done state) wait until the person has answered, so the request never leaves
   * the view. Ending states (finished, failed, stopped) go through; _keepHeldVisible then answers the requests no.
   */
  _waitForHeld(list) {
    const out = [];
    for (const e of list) {
      const waits = e.kind === EV.ASK || (e.kind === EV.STATE && !FINAL.has(e.state));
      if (waits && this._heldShowing(e.agentId)) {
        const later = this.later.get(e.agentId) || {};
        if (e.kind === EV.ASK) later.ask = e;
        else later.state = e;
        this.later.set(e.agentId, later);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  /** Forget decisions that waited for an agent's held requests: a new turn or a stop makes them out of date. */
  _dropLater(agentId) {
    const later = this.later.get(agentId);
    if (!later) return;
    this.later.delete(agentId);
    const id = later.ask?.ask?.id;
    if (id && !this.held.has(id)) this.asks.delete(id);
  }

  /**
   * The invariant, checked after every batch: each held request shows on its agent, which is in needs_ok, or waits
   * behind another held request of the same agent that shows. An agent that has gone or ended cannot use an answer,
   * so its requests are answered no. Anything else that slipped past _waitForHeld is shown again.
   */
  _keepHeldVisible() {
    if (this._checkingHeld) return;
    this._checkingHeld = true;
    try {
      const first = new Map();
      for (const h of this.held.values()) if (!h.done && !first.has(h.agentId)) first.set(h.agentId, h);
      for (const [agentId, h] of first) {
        const v = this.store.get(agentId);
        if (v && v.state === STATE.NEEDS_OK && this._heldShowing(agentId)) continue;
        if (!v || ENDED.has(v.state)) {
          this._denyHeldFor(agentId, v?.parentId ? 'The helper is no longer running.' : 'The agent is no longer running.');
          continue;
        }
        this.log.warn(`A held request of ${agentId} was not showing, so it is shown again.`);
        const later = this.later.get(agentId) || {};
        // Keep a question or a stuck ask for afterwards; a permission ask that is not held can no longer be answered.
        if (v.ask && !this.held.has(v.ask.id) && v.ask.type !== 'permission') later.ask = { kind: EV.ASK, agentId, ask: v.ask };
        later.state = { kind: EV.STATE, agentId, state: v.state, reason: v.stateReason ?? null };
        this.later.set(agentId, later);
        this._apply([
          { kind: EV.ASK, agentId, ask: h.ask },
          { kind: EV.STATE, agentId, state: STATE.NEEDS_OK, reason: null },
        ], { held: true });
      }
    } finally {
      this._checkingHeld = false;
    }
  }

  _notice(text, agentId = null) {
    if (!text) return;
    this._apply([{ kind: EV.NOTICE, text, ...(agentId ? { agentId } : {}) }]);
  }

  // ================================================================ keys

  /** Text with the person's stored keys hidden (Connect's mask), or as it is when there is nothing to hide. */
  _maskText(s) {
    if (typeof s !== 'string' || s.length < 8 || !this._mask) return s;
    try {
      const out = this.connect.mask(s);
      return typeof out === 'string' ? out : s;
    } catch {
      // Never the text, nor what the mask said about it; and once, not for every text.
      if (!this._maskFailed) this.log.warn('Could not hide the stored keys in a text, so it is shown as it is.');
      this._maskFailed = true;
      return s;
    }
  }

  /** An event with the person's stored keys hidden in its text fields (not in ids, folders or branches: MASK_SKIP). */
  _maskEvent(e) {
    return this._mask ? maskValue(e, this._mask, MASK_SKIP) : e;
  }

  /**
   * The person's keys for an agent of this harness working on this repository ({ NAME: value }, from Connect's key
   * store), or null: none without Connect, and none in the demo. A name the engine never passes on (KEY_REFUSED_RE),
   * and a value that is not a string, are left out. The same keys go to the checks of that agent's work.
   */
  _keysFor(harness) {
    const c = this.connect;
    if (this.mode !== 'live' || typeof c?.envFor !== 'function') return null;
    let env = null;
    try {
      env = c.envFor({ repoRoot: this.repoInfo?.root ?? null, harness });
    } catch (err) {
      this.log.warn('Could not read the keys for an agent, so it gets none:', err?.message ?? 'unknown error');
      return null;
    }
    if (!env || typeof env !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(env)) {
      if (KEY_NAME_RE.test(k) && !KEY_REFUSED_RE.test(k) && typeof v === 'string' && !v.includes('\0')) out[k] = v;
    }
    return out;
  }

  /**
   * The options a live runner gets for the person's keys, when there are any: `keysEnv`, its keys (see _keysFor), and
   * `mask`, which hides every stored key in its output before that output is read.
   */
  _runnerKeys(harness) {
    if (this.mode !== 'live') return {};
    const out = {};
    const keys = this._keysFor(harness);
    if (keys) out.keysEnv = keys;
    if (this._mask) out.mask = this._mask;
    return out;
  }

  /**
   * Does typed text look like a key (src/shared/secretshape.mjs), or hold the value of one the person stored (Connect's
   * mask changes it, whatever its shape: a password of words and digits)? Such text is refused before it is read or kept.
   */
  _looksLikeKey(text) {
    const t = String(text ?? '');
    try {
      if (looksLikeSecret(t)?.secret === true) return true;
    } catch { /* the mask may still know it */ }
    return !!this._mask && this._mask(t) !== t;
  }

  _react(e) {
    switch (e.kind) {
      case EV.TURN:
        if (e.phase === 'start') {
          const run = this.runs.get(e.agentId);
          if (run) {
            run.turnSeq += 1;
            run.inTurn = true;
            run.waiting = null;
            this._cancelReceipt(run); // the last turn's receipt no longer describes the folder
          }
          this._dropLater(e.agentId); // what the last turn decided while a request was held is out of date
          this._clearBackgroundAsk(e.agentId, null); // it works again, so "is it done?" is moot
          this._clearProblem(e.agentId); // and a merge that did not go through no longer describes its work
        } else if (e.phase === 'end') {
          this._onTurnEnd(e);
        }
        break;
      case EV.ENDED:
        this._onEnded(e);
        break;
      case EV.BACKGROUND: {
        const run = this.runs.get(e.agentId);
        if (run) {
          run.backgroundAt = e.ts;
          run.background = { helpers: e.helpers || 0, commands: e.commands || 0, others: e.others || 0, work: Array.isArray(e.work) ? e.work : [], ids: Array.isArray(e.ids) ? e.ids : [] };
        }
        break;
      }
      default:
        break;
    }
  }

  // ================================================================ end of a turn

  _onTurnEnd(e) {
    const v = this.store.get(e.agentId);
    if (!v || v.parentId) return; // a helper's final state comes from its task completing
    const run = this.runs.get(v.id);
    if (run) {
      run.inTurn = false;
      run.lastText = String(e.finalText ?? '');
    }
    if ((run && run.stopped) || !ACTIVE.has(v.state)) return;
    const seq = run ? run.turnSeq : 0;
    this._decide(v.id, run, e, seq).catch(err => this.log.error('Could not finish a turn:', err));
  }

  /**
   * The contract's order: helpers still running, error, then what changed so far (files and rules, whether or not a
   * question follows), then the closing question, else the declared checks and a done state.
   */
  async _decide(agentId, run, e, seq) {
    const finalText = String(e.finalText ?? '');
    let receipt = null; // this turn's receipt once it starts; a new turn, a message, a stop or shutdown cancels it
    const stale = () => this._shuttingDown || !this.store.get(agentId)
      || (run && (run.stopped || run.turnSeq !== seq)) || !!receipt?.ctl.signal.aborted;
    this._dropEngineAsk(agentId);

    let background = Number(e.backgroundTasks) || 0;
    const bg = e.background && typeof e.background === 'object' ? e.background : null;
    // Commands the person already called done ("It is done") are not waited for again while they run.
    if (background > 0 && bg && !bg.helpers && run?.accepted && Array.isArray(bg.ids) && bg.ids.length
      && bg.ids.every(id => run.accepted.has(id))) background = 0;
    if (background > 0) {
      // Claude Code starts a new turn when background work ends. Work that may never end (a dev server) gets one
      // question once things have been quiet: see _checkWaiting.
      if (run) run.waiting = { e, seq, asked: false };
      const st = { kind: EV.STATE, agentId, state: STATE.WAITING_HELPERS, reason: null, backgroundTasks: background };
      if (bg) st.background = bg;
      this._apply([st]);
      return;
    }
    if (e.isError) {
      const reason = errorReason(e);
      // A Claude Code agent stopped by its spending limit can be given more for this run (raiseLimit).
      const atLimit = reason === LIMIT_REASON && this.store.get(agentId)?.harness === 'claude';
      this._apply([{ kind: EV.STATE, agentId, state: STATE.FAILED, reason, ...(atLimit ? { atLimit: true } : {}) }]);
      return;
    }

    // One receipt at a time per agent, the record made before a question included.
    if (run) {
      this._cancelReceipt(run);
      receipt = { ctl: new AbortController() };
      run.receipt = receipt;
      run.deciding = true; // a clean exit while this runs is not a failure (Codex exits after every turn)
    }
    // The checks judge finished work: a turn that ends with a question runs none, but what it changed is recorded.
    const question = extractQuestion(finalText);
    let checksState = 'none';
    let reason = null;
    try {
      const ws = run && run.workspace;
      if (ws && typeof this.deps.workspace?.diffStats === 'function') {
        // What is not merged yet: since its last merge, else since the commit it started from.
        const files = await this.deps.workspace.diffStats({ path: ws.path, base: sinceOf(ws) });
        if (stale()) return;
        if (files) this._apply([{ kind: EV.FILES, agentId, files }]);
        const config = (await run.config) || DEFAULT_CONFIG;
        if (stale()) return;
        const changedPaths = (files?.list || []).map(f => f.path);
        if (Array.isArray(config.rules) && config.rules.length && typeof this.deps.receipt?.checkRules === 'function') {
          const rules = await this.deps.receipt.checkRules(config.rules, changedPaths);
          if (stale()) return;
          if (rules) this._apply([{ kind: EV.RULES, agentId, rules }]);
        }
        if (!question && Array.isArray(config.checks) && config.checks.length && typeof this.deps.receipt?.runChecks === 'function') {
          const partial = [];
          // Checks of a receipt that was cancelled can take a moment to end: never run two sets in one folder.
          if (run.checksDone) await run.checksDone;
          if (stale()) return;
          this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'running', results: [] } }]);
          const onProgress = (p) => {
            if (!p || typeof p !== 'object' || stale()) return;
            if (Array.isArray(p.results)) partial.splice(0, partial.length, ...p.results);
            else if (p.name != null && typeof p.ok === 'boolean') {
              const i = partial.findIndex(r => r.name === p.name);
              if (i >= 0) partial[i] = p; else partial.push(p);
            } else return;
            this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'running', results: cleanResults(partial) } }]);
          };
          let res;
          try {
            // The checks run the agent's own code (its package.json, its tests), so they carry its marker as its shell
            // does: a Workbench or an acceptance run started from a check then refuses, as it would in the agent.
            // They get the keys that agent gets (added after the scrub), and their output is masked before it is cut.
            const env = { ...process.env, WORKBENCH_AGENT_ID: agentId };
            const keys = this._keysFor(run.harness);
            const more = { ...(keys ? { keysEnv: keys } : {}), ...(this._mask ? { mask: this._mask } : {}) };
            const running = Promise.resolve().then(() => this.deps.receipt.runChecks({ cwd: ws.path, checks: config.checks, onProgress, signal: receipt.ctl.signal, env, ...more }));
            const done = running.then(() => {}, () => {});
            run.checksDone = done;
            done.then(() => { if (run.checksDone === done) run.checksDone = null; });
            res = await running;
          } catch (err) {
            if (stale()) return;
            this.log.warn('The checks could not run:', err);
            this._apply([{ kind: EV.CHECKS, agentId, checks: { state: 'none', results: [] } }]);
            throw plainError('Workbench could not run the checks.');
          }
          if (stale()) return;
          checksState = res?.state === 'passed' || res?.state === 'failed' ? res.state : 'none';
          const results = cleanResults(res?.results);
          this._apply([{ kind: EV.CHECKS, agentId, checks: { state: checksState, results } }]);
          if (checksState === 'failed') {
            const failed = results.filter(r => !r.ok).map(r => `“${r.name}”`);
            reason = failed.length ? `The ${failed.length === 1 ? 'check' : 'checks'} ${joinAnd(failed)} did not pass.` : null;
          }
        }
      } else if (!question) {
        // No workspace (the demo): use whatever checks the simulator reported.
        const cur = this.store.get(agentId)?.checks?.state;
        if (cur === 'passed' || cur === 'failed') checksState = cur;
      }
    } catch (err) {
      this.log.warn('Could not build the receipt:', err);
      // A question is still asked: the person can answer it without the record of what changed.
      if (!question) reason = err?.plain ? err.message : 'Workbench could not check its work.';
    } finally {
      if (run && run.receipt === receipt) { // a newer receipt keeps its own
        run.receipt = null;
        run.deciding = false;
      }
    }
    if (stale()) return;
    if (question) {
      const ask = this._newAsk(agentId, 'question', { sentence: question, options: [] });
      const batch = [];
      const intro = firstSentence(finalText);
      if (intro && intro !== question) batch.push({ kind: EV.SAYS, agentId, text: intro });
      // Results of earlier checks would sit beside newer files.
      if (this.store.get(agentId)?.checks) batch.push({ kind: EV.CHECKS, agentId, checks: null });
      batch.push({ kind: EV.ASK, agentId, ask }, { kind: EV.STATE, agentId, state: STATE.QUESTION, reason: null });
      this._apply(batch);
      return;
    }
    const state = checksState === 'passed' ? STATE.DONE_CHECKED
      : checksState === 'failed' ? STATE.CHECKS_FAILED
      : STATE.DONE_CLAIMED;
    const batch = [];
    const says = firstSentence(finalText);
    if (says) batch.push({ kind: EV.SAYS, agentId, text: says });
    batch.push({ kind: EV.STATE, agentId, state, reason });
    this._apply(batch);
  }

  /** End a receipt still being built: its checks stop, nothing from it is applied, "checks running" goes away. */
  _cancelReceipt(run) {
    const r = run && run.receipt;
    if (!r) return;
    run.receipt = null;
    run.deciding = false;
    try { r.ctl.abort(); } catch (err) { this.log.warn('Could not stop the checks:', err); }
    if (this.store.get(run.id)?.checks?.state === 'running') {
      this._apply([{ kind: EV.CHECKS, agentId: run.id, checks: { state: 'none', results: [] } }]);
    }
  }

  /** A process ended. Helpers get their final state; a root's helpers and held requests are closed. */
  _onEnded(e) {
    const v = this.store.get(e.agentId);
    if (!v) return;
    if (v.parentId) {
      if (ACTIVE.has(v.state)) {
        const state = e.outcome === 'error' ? STATE.FAILED : e.outcome === 'stopped' ? STATE.STOPPED : STATE.FINISHED;
        const reason = e.outcome === 'error' && e.error ? clip(plain(e.error), 160) : null;
        this._apply([{ kind: EV.STATE, agentId: v.id, state, reason }]);
      }
      this._denyHeldFor(v.id, 'The helper is no longer running.');
      return;
    }
    const run = this.runs.get(v.id);
    this._denyHeldFor(v.id, 'The agent is no longer running.', true);
    if (run) run.waiting = null; // whatever it left running ended with it
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent is no longer running' });
    }
    if (batch.length) this._apply(batch);
    if (!run || run.stopped || e.outcome !== 'ok') return; // on errors the runner reports 'failed' itself

    // A clean exit in the middle of a turn: wait briefly for its last lines, then call it failed.
    const seq = run.turnSeq;
    const timer = setTimeout(() => {
      const cur = this.store.get(v.id);
      if (!cur || run.stopped || run.deciding || run.turnSeq !== seq || this._shuttingDown) return;
      if (run.runner?.info?.()?.alive) return;
      // An unresolved stuck ask of any kind (background, silence, repeats): the process is gone, so it cannot be answered.
      const stuckAsk = cur.state === STATE.MAYBE_STUCK && cur.ask;
      const unfinished = cur.state === STATE.STARTING || cur.state === STATE.WAITING_HELPERS || cur.state === STATE.MAYBE_STUCK
        || (cur.state === STATE.WORKING && run.inTurn);
      if (!unfinished) return;
      run.inTurn = false;
      if (stuckAsk) this.asks.delete(stuckAsk.id);
      this._apply([{ kind: EV.STATE, agentId: v.id, state: STATE.FAILED, reason: 'It stopped before finishing its work.' }]);
    }, this.options.exitGraceMs);
    timer.unref?.();
  }

  // ================================================================ background work that may never end

  /**
   * A root that waits only for background commands (no helper working) gets one question once nothing has happened
   * for stuckSilenceMs: is it done? A dev server never ends; a build does, and then Claude Code starts a new turn by
   * itself, which takes the question back.
   */
  _checkWaiting(now) {
    for (const [id, run] of this.runs) {
      const w = run.waiting;
      if (!w || w.asked || run.stopped || run.inTurn || run.deciding || run.turnSeq !== w.seq) continue;
      const v = this.store.get(id);
      if (!v || v.state !== STATE.WAITING_HELPERS || this.stopped.has(id)) continue;
      const bg = this._backgroundOf(run);
      if (!bg || bg.helpers > 0 || (v.helpers?.working || 0) > 0) continue; // helpers have their own stuck checks
      const helperEnds = this.store.descendants(id).map(d => d.endedAt || 0);
      const quietSince = Math.max(v.lastEventAt || 0, v.stateSince || 0, run.backgroundAt || 0, ...helperEnds);
      if (now - quietSince < this.options.stuckSilenceMs) continue;
      w.asked = true;
      if (!(bg.commands + bg.others > 0)) {
        // Everything it waited for has ended, yet no new turn came: finish the turn it had.
        run.waiting = null;
        this._decide(id, run, { ...w.e, backgroundTasks: 0, background: null }, w.seq).catch(err => this.log.error('Could not finish a turn:', err));
        continue;
      }
      const ask = this._newAsk(id, 'stuck', {
        about: 'background',
        sentence: `${v.name} has finished, but ${bg.commands > 0 ? 'a command it started' : 'something it started'} is still running.`,
        ...(bg.work?.length ? { detail: bg.work.join('\n') } : {}),
        options: ['It is done', 'Keep waiting'],
      });
      this._dropEngineAsk(id);
      this._apply([
        { kind: EV.ASK, agentId: id, ask },
        { kind: EV.STATE, agentId: id, state: STATE.MAYBE_STUCK, reason: 'It left something running' },
      ]);
    }
  }

  /** The latest background split of a run: from the parser's live updates, else from the turn end. */
  _backgroundOf(run) {
    const latest = run.background || run.waiting?.e?.background;
    return latest && typeof latest === 'object' ? latest : null;
  }

  /** Take back the "is it done?" question about background work, if it shows. Returns true if it did. */
  _clearBackgroundAsk(agentId, answer, state = STATE.WORKING) {
    const v = this.store.get(agentId);
    const ask = v?.ask;
    if (!ask || ask.type !== 'stuck' || ask.about !== 'background' || !this.asks.has(ask.id)) return false;
    this.asks.delete(ask.id);
    const batch = [{ kind: EV.ASK_CLEARED, agentId, askId: ask.id, answer }];
    if (v.state === STATE.MAYBE_STUCK) {
      // Through waiting_helpers, so a root that works again says what it is reading (the store words it).
      batch.push({ kind: EV.STATE, agentId, state: STATE.WAITING_HELPERS, reason: null });
      if (state !== STATE.WAITING_HELPERS) batch.push({ kind: EV.STATE, agentId, state, reason: null });
    }
    this._apply(batch);
    return true;
  }

  // ================================================================ stuck agents

  _checkStuck(now) {
    const views = this.store.list().filter(v => (v.state === STATE.WORKING || v.state === STATE.STARTING)
      && !this.stopped.has(v.id) && !this.stopped.has(v.rootId)
      && !this.runs.get(v.id)?.deciding);
    for (const f of this.stuck.check(now, views)) {
      const ask = this._newAsk(f.agentId, 'stuck', {
        sentence: f.sentence,
        ...(f.detail ? { detail: f.detail } : {}),
        options: ['Stop it', 'Let it keep trying'],
      });
      this._dropEngineAsk(f.agentId);
      this._apply([
        { kind: EV.ASK, agentId: f.agentId, ask },
        { kind: EV.STATE, agentId: f.agentId, state: STATE.MAYBE_STUCK, reason: f.reason },
      ]);
    }
  }

  /** A flagged agent made progress: back to working, unless the simulator owns the stuck ask. */
  _clearStuck(agentId) {
    const v = this.store.get(agentId);
    if (!v || v.state !== STATE.MAYBE_STUCK) {
      this.stuck.reset(agentId);
      return;
    }
    const ask = v.ask;
    if (ask && !this.asks.has(ask.id)) return;
    const batch = [];
    if (ask) {
      this.asks.delete(ask.id);
      batch.push({ kind: EV.ASK_CLEARED, agentId, askId: ask.id, answer: null });
    }
    batch.push({ kind: EV.STATE, agentId, state: STATE.WORKING, reason: 'It is making progress again' });
    this._apply(batch);
  }

  // ================================================================ asks

  _newAsk(agentId, type, fields) {
    const ask = { id: `${type}-${hex(4)}`, type, ...fields };
    this.asks.set(ask.id, { agentId, type });
    return ask;
  }

  /** Forget the engine's record of an agent's current ask when it is being replaced. */
  _dropEngineAsk(agentId) {
    const cur = this.store.get(agentId)?.ask;
    if (cur && this.asks.has(cur.id) && !this.held.has(cur.id)) this.asks.delete(cur.id);
  }

  // ================================================================ permission requests

  /**
   * Claude Code's PreToolUse hook, forwarded by the bridge. Allowed and denied requests are
   * answered at once; the rest wait for the person (or the timeout, or shutdown: both say no).
   * @param {{ signal?: AbortSignal }} [opts]  aborted when the bridge goes away
   */
  async hookPreToolUse(agentId, payload, { signal } = {}) {
    if (this._shuttingDown) return hookResponse('deny', 'Workbench is shutting down.');
    const root = this.store.get(String(agentId || ''));
    const run = root && !root.parentId ? this.runs.get(root.id) : null;
    // Only real Claude Code agents ask through the hook: Codex works in its own sandbox and never asks, and the
    // demo's agents are simulated. A request in any other agent's name is refused and shows nothing.
    if (!root || !run || this.mode !== 'live' || run.harness !== 'claude') return hookResponse('deny', 'Workbench does not know this agent, so it said no.');
    if (run.stopped) return hookResponse('deny', 'This agent was stopped.');
    // A hook left running after its Claude Code process has gone must not ask (or bring a failed agent back).
    if (this._runnerInfo(run)?.alive === false) return hookResponse('deny', 'This agent is no longer running.');
    const p = payload && typeof payload === 'object' ? payload : {};
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
    if (!tool) return hookResponse('deny', 'The request did not say which tool it wants to use.');

    const asker = await this._findAsker(root, p);
    // A helper the person stopped gets no tools at all, not even the ones the rules allow. That includes a live helper
    // whose root was asked to stop it: it runs on until it ends.
    const stoppedHelper = () => !!asker.parentId && (this.stopped.has(asker.id) || this.stopAsked.has(asker.id));
    if (stoppedHelper()) return hookResponse('deny', 'The person stopped this helper.');
    let config = DEFAULT_CONFIG;
    try { config = (await run.config) || DEFAULT_CONFIG; } catch { config = DEFAULT_CONFIG; }
    let d;
    try {
      if (typeof this.deps.policy?.decide !== 'function') throw new Error('No permission policy is loaded.');
      d = await this.deps.policy.decide({
        tool,
        input,
        cwd: run.workspace?.path ?? null, // the engine's workspace, never the payload's cwd
        extraAllow: Array.isArray(config.allow) ? config.allow : [],
        // Claude Code's own folders for this agent's session, from its runner: never the payload's session id.
        readAlso: this._readAlso(run),
        // Who SendMessage may reach without asking: the main agent and this agent's own helpers, as its output named them.
        recipients: this._recipients(root, run),
      });
    } catch (err) {
      this.log.error('The permission policy failed:', err);
      return hookResponse('deny', 'Workbench could not check this request, so it said no.');
    }
    if (stoppedHelper()) return hookResponse('deny', 'The person stopped this helper.'); // stopped while it was checked
    // The policy judged the request as it is. What the person is shown is described from it with the stored keys
    // hidden first, since a description cuts long inputs short and a key cut in two can no longer be found.
    const shownInput = this._mask ? maskValue(input, this._mask) : input;
    const described = describeRequest(tool, shownInput);
    const sentence = `${asker.name} ${d?.sentence || described.sentence}`;
    if (d?.decision === 'allow') {
      this._apply([{ kind: EV.APPROVAL, agentId: asker.id, how: 'auto', decision: 'allow', sentence }]);
      return hookResponse('allow', d.reason || 'Allowed by the workbench rules.');
    }
    if (d?.decision !== 'ask') { // 'deny', or anything unexpected: fail closed
      this._apply([{ kind: EV.APPROVAL, agentId: asker.id, how: 'auto', decision: 'deny', sentence }]);
      return hookResponse('deny', d?.reason || 'Not allowed by the workbench rules.');
    }
    if (this._shuttingDown || run.stopped) return hookResponse('deny', 'This agent was stopped.');
    if (signal?.aborted) return hookResponse('deny', 'The request was cancelled.');
    // A late request must not bring back a helper that has ended: asking would leave it "working" for good.
    // Checked after the waits above, since the helper can end while its request is being checked.
    const askerNow = this.store.get(asker.id);
    if (asker.parentId && (!askerNow || ENDED.has(askerNow.state))) return hookResponse('deny', 'The helper is no longer running.');
    const why = typeof d.reason === 'string' && d.reason.trim() ? clip(d.reason, 300) : null;
    const detail = shownInput !== input ? described.detail : (d.detail ?? described.detail);
    return this._hold({ asker, root, sentence, detail, why, signal });
  }

  /** The runner's info(), or null when it has none or it fails. */
  _runnerInfo(run) {
    try { return run.runner?.info?.() ?? null; } catch { return null; }
  }

  /** The agent's own scratch folders, as its runner names them for its own session. */
  _readAlso(run) {
    try {
      const list = run.runner?.readAlso?.();
      return Array.isArray(list) ? list : [];
    } catch (err) {
      this.log.warn('Could not list the agent’s own folders:', err);
      return [];
    }
  }

  /** "main", and this root's helpers: their workbench ids, and the task ids and names its output gave them. */
  _recipients(root, run) {
    const names = new Set(['main']);
    for (const h of this.store.descendants(root.id)) names.add(h.id);
    try {
      const more = run.runner?.recipients?.();
      for (const n of Array.isArray(more) ? more : []) if (typeof n === 'string' && n) names.add(n);
    } catch (err) {
      this.log.warn('Could not list the agent’s helpers:', err);
    }
    return [...names];
  }

  /**
   * The agent behind a hook call: the root, unless payload.agent_id names a helper. The runner says which agent
   * issued the call (payload.tool_use_id) or runs that task (payload.agent_id), from Claude Code's own output; a
   * runner that cannot say gets the helper id rule. The hook can arrive before the parser has shown the helper: wait
   * a moment, then ask in the root's place.
   */
  async _findAsker(root, p) {
    const taskId = p.agent_id ? String(p.agent_id) : '';
    if (!taskId) return root;
    const toolUseId = p.tool_use_id ? String(p.tool_use_id) : '';
    const runner = this.runs.get(root.id)?.runner;
    const find = () => {
      let id = null;
      try { id = runner?.agentFor?.({ toolUseId, taskId }) || null; } catch { id = null; }
      const v = (id && this.store.get(id)) || this.store.get(`${root.id}-${taskId.slice(0, 8)}`);
      return v && v.rootId === root.id ? v : null;
    };
    const deadline = Date.now() + this.options.helperWaitMs;
    for (;;) {
      const v = find();
      if (v) return v;
      if (Date.now() >= deadline) return root;
      await sleep(25);
    }
  }

  _hold({ asker, root, sentence, detail, why = null, signal }) {
    // `why` is the permission check's own reason, so the page can say why it asks.
    const ask = { id: `ok-${hex(4)}`, type: 'permission', sentence, detail: String(detail ?? ''), ...(why ? { why } : {}), options: ['Allow', 'Deny'], primary: 'Allow' };
    return new Promise((resolve) => {
      // Remember the state to go back to: a root asked on behalf of an unknown helper may be waiting on helpers.
      const cur0 = this.store.get(asker.id);
      const showing = cur0?.ask ? this.held.get(cur0.ask.id) : null;
      const prevState = showing ? showing.prevState : cur0?.state;
      const held = { askId: ask.id, agentId: asker.id, rootId: root.id, ask, resolve, timer: null, done: false, prevState };
      this.held.set(ask.id, held);
      this.asks.set(ask.id, { agentId: asker.id, type: 'permission' });
      const ms = this.options.permissionTimeoutMs;
      held.timer = setTimeout(() => this._resolveHeld(held, {
        decision: 'deny',
        how: 'timeout',
        reason: 'No answer from the person in time',
        notice: `${asker.name} waited ${duration(ms)} for your OK, so I said no.`,
      }), ms);
      signal?.addEventListener?.('abort', () => {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason: 'The request was cancelled.', silent: true });
      }, { once: true });
      // One ask shows at a time; further requests from the same agent wait their turn.
      const cur = this.store.get(asker.id)?.ask;
      if (!(cur && cur.id !== ask.id && this.held.has(cur.id))) {
        this._dropEngineAsk(asker.id);
        this._apply([
          { kind: EV.ASK, agentId: asker.id, ask },
          { kind: EV.STATE, agentId: asker.id, state: STATE.NEEDS_OK, reason: null },
        ], { held: true });
      }
    });
  }

  _resolveHeld(held, { decision, how, reason, silent = false, notice = null }) {
    if (held.done) return false;
    held.done = true;
    clearTimeout(held.timer);
    this.held.delete(held.askId);
    this.asks.delete(held.askId);
    try { held.resolve(hookResponse(decision, reason)); } catch { /* ignore */ }
    const batch = [];
    if (!silent) batch.push({ kind: EV.APPROVAL, agentId: held.agentId, how, decision, sentence: held.ask.sentence });
    const v = this.store.get(held.agentId);
    const next = [...this.held.values()].find(h => h.agentId === held.agentId && !h.done);
    if (v && v.ask && v.ask.id === held.askId) {
      batch.push({ kind: EV.ASK_CLEARED, agentId: held.agentId, askId: held.askId, answer: decision === 'allow' ? 'Allow' : 'Deny' });
      if (next) batch.push({ kind: EV.ASK, agentId: held.agentId, ask: next.ask });
      else if (v.state === STATE.NEEDS_OK) {
        // Go on to what the engine decided while the request waited, or else back to what the agent was doing.
        const later = this.later.get(held.agentId);
        this.later.delete(held.agentId);
        const ts = this.now();
        if (later?.ask) batch.push({ ...later.ask, ts });
        batch.push(later?.state ? { ...later.state, ts } : { kind: EV.STATE, agentId: held.agentId, state: this._stateAfterHeld(held), reason: null });
      }
    }
    if (!next) this._dropLater(held.agentId);
    if (notice) batch.push({ kind: EV.NOTICE, text: notice, agentId: held.agentId });
    if (batch.length) this._apply(batch, { held: true });
    return true;
  }

  /** After its last held request: working while its turn runs, else back to waiting on helpers, or working. */
  _stateAfterHeld(held) {
    if (this.runs.get(held.agentId)?.inTurn) return STATE.WORKING;
    return held.prevState === STATE.WAITING_HELPERS ? STATE.WAITING_HELPERS : STATE.WORKING;
  }

  /** Say no to every held request from an agent (and, for a root, from its helpers). */
  _denyHeldFor(agentId, reason, includeHelpers = false) {
    for (const held of [...this.held.values()]) {
      if (held.agentId === agentId || (includeHelpers && held.rootId === agentId)) {
        this._resolveHeld(held, { decision: 'deny', how: 'auto', reason, silent: true });
      }
    }
  }

  // ================================================================ answers

  /**
   * Answer from a button or the reply box (POST /api/agents/:id/answer). `askId` names the ask the page showed: an
   * ask is answered only by its own id, never as "whatever is showing now". A permission takes only its buttons'
   * words, Allow or Deny; typed or spoken words reach it through command(), bound to the ask on screen. With no ask,
   * a finished agent takes "Looks good" or a follow-up, and any other agent a message.
   */
  async answer(agentId, { askId = null, answer } = {}) {
    // Typed in the reply box: a key goes nowhere, as in command().
    const out = answer != null && this._looksLikeKey(String(answer).trim())
      ? { ok: false, reply: SECRET_REFUSED, openConnect: true }
      : await this._answer(agentId, askId, answer);
    this._notice(out.reply, agentId);
    return out;
  }

  async _answer(agentId, askId, answer) {
    const v = this.store.get(agentId);
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    const text = answer == null ? '' : String(answer).trim();
    const named = this._askFor(v, askId);
    if (named.reply) return { ok: false, reply: named.reply };
    const ask = named.ask;
    if (!ask) {
      if (DONE.has(v.state) && !v.parentId) return this._answerDone(v, text);
      if (!text) return { ok: false, reply: `${v.name} is not waiting for an answer.` };
      return this._say(v, text);
    }
    if (ask.type === 'permission') {
      const allow = ALLOW_LABEL_RE.test(text) ? true : DENY_LABEL_RE.test(text) ? false : null;
      if (allow === null) return { ok: false, reply: 'Choose Allow or Deny.' };
      return this._answerPermission(v, ask, { allow });
    }
    return this._answerAsk(v, ask, text);
  }

  /**
   * The ask an answer names by its id: the agent's ask on screen, or one of its held permission requests (one shows
   * at a time). With no id, an agent that has an ask is not answered: "yes" must never reach an ask nobody saw.
   * @returns {{ ask?: object, reply?: string }}  no ask and no reply: the agent has no ask, and none was named
   */
  _askFor(v, askId) {
    const id = typeof askId === 'string' && askId ? askId : null;
    const held = id ? this.held.get(id) : null;
    if (held && held.agentId === v.id) return { ask: held.ask };
    if (id && v.ask && v.ask.id === id) return { ask: v.ask };
    if (!id) return v.ask ? { reply: `Have a look at what ${v.name} is asking first.` } : {};
    return { reply: v.ask ? `${v.name} is asking something else now. Have a look, then answer again.` : `${v.name} is not waiting for that any more.` };
  }

  /** A question or a stuck agent: the text is the answer, or a hint. Asks the simulator made go back to it. */
  async _answerAsk(v, ask, text) {
    if (!this.asks.has(ask.id) && this.mode === 'demo' && this.adapters.sim) return this._answerSim(v, ask, text);
    if (ask.type === 'stuck') return this._answerStuck(v, ask, text);
    if (ask.type === 'permission') return this._answerPermission(v, ask, { allow: false, words: text }); // free text never allows
    return this._answerQuestion(v, ask, text);
  }

  /**
   * Settle a permission ask with the person's decision, the same way in live mode and in the demo. An allow never
   * carries words. A no can: the person's words after "no", or the whole of a yes that came with conditions
   * (`conditional`), which is a no because an allow cannot carry the condition: the step would run exactly as asked.
   */
  async _answerPermission(v, ask, { allow, words = '', conditional = false }) {
    const said = clip(String(words ?? '').trim(), 300);
    let reason;
    let reply;
    if (allow) {
      reason = 'The person allowed it.';
      reply = `OK, ${v.name} can go ahead.`;
    } else if (said && conditional) {
      reason = `The person did not allow this step as asked. They said: “${said}”`;
      reply = `OK, ${v.name} will not do it as asked. I passed on your words.`;
    } else if (said) {
      reason = `The person said no, and added: ${said}`;
      reply = `OK, ${v.name} will not do that. I passed on your words.`;
    } else {
      reason = 'The person said no.';
      reply = `OK, ${v.name} will not do that.`;
    }
    const held = this.held.get(ask.id);
    if (held && held.agentId === v.id) {
      this._resolveHeld(held, { decision: allow ? 'allow' : 'deny', how: 'person', reason });
      return { ok: true, reply };
    }
    // Asks the simulator made itself go back to it, already decided: it hears "Allow", or the words of a no. The
    // person hears the same words as in live mode.
    if (!this.asks.has(ask.id) && this.mode === 'demo' && this.adapters.sim) {
      const res = await this._answerSim(v, ask, allow ? 'Allow' : (said || 'Deny'));
      return res.ok === false ? res : { ok: true, reply };
    }
    // Nothing is held for it any more (it timed out or was cancelled): just clear it.
    if (v.ask && v.ask.id === ask.id) {
      this.asks.delete(ask.id);
      const batch = [{ kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: allow ? 'Allow' : 'Deny' }];
      if (v.state === STATE.NEEDS_OK) batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null });
      this._apply(batch);
    }
    return { ok: false, reply: `${v.name} is no longer waiting for that.` };
  }

  async _answerQuestion(v, ask, text) {
    if (!text) return { ok: false, reply: 'Type an answer first.' };
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    this.asks.delete(ask.id);
    this._apply([
      { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
      { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
    ]);
    return { ok: true, reply: `Sent your answer to ${v.name}.` };
  }

  async _answerStuck(v, ask, text) {
    const n = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (ask.about === 'background' && n !== 'stop it' && n !== 'stop') return this._answerBackground(v, ask, text, n);
    if (n === 'stop it' || n === 'stop') {
      this.asks.delete(ask.id);
      return this._stop(v); // leaving maybe_stuck clears the ask
    }
    const clear = () => {
      this.asks.delete(ask.id);
      this._apply([
        { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
        { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
      ]);
      this.stuck.reset(v.id);
    };
    if (n === 'let it keep trying' || n === 'keep trying' || n === 'keep going') {
      clear();
      return { ok: true, reply: `OK, ${v.name} will keep trying.` };
    }
    if (!text) return { ok: false, reply: 'Choose “Stop it” or “Let it keep trying”, or type a hint.' };
    const sent = await this._sendTo(v, text); // anything else is a hint
    if (!sent.ok) return sent;
    clear();
    return { ok: true, reply: `Passed your hint to ${v.name}.` };
  }

  /**
   * The question about background work: "It is done" builds the receipt (what it left running keeps running), "Keep
   * waiting" goes back to waiting and is not asked again for that turn, and anything else is a message for the agent.
   * Once its process has ended, neither button applies: the exit makes it failed (see _onEnded).
   */
  async _answerBackground(v, ask, text, n) {
    const run = this.runs.get(v.id);
    const w = run && run.waiting;
    const done = /^(it is done|it’s done|it's done|done|it is finished|finished)$/.test(n);
    const wait = /^(keep waiting|wait|let it keep trying|keep trying|let it keep waiting)$/.test(n);
    if ((done || wait) && run && !run.inTurn && this._runnerInfo(run)?.alive === false) {
      // What it left running ended with it; the exit timer marks it failed and takes the question back.
      return { ok: false, reply: `${v.name} stopped running before your answer reached it.` };
    }
    if (done) {
      if (!w || run.inTurn || run.turnSeq !== w.seq) {
        this._clearBackgroundAsk(v.id, text);
        return { ok: true, reply: `${v.name} is working again, so I will wait for it.` };
      }
      const bg = this._backgroundOf(run);
      run.accepted = new Set([...(run.accepted || []), ...(bg && Array.isArray(bg.ids) ? bg.ids : [])]);
      run.waiting = null;
      this.asks.delete(ask.id);
      // Out of maybe_stuck at once: the receipt is built while it is working, as after any turn (run.deciding keeps the
      // stuck checks off meanwhile), and a turn that starts during its checks is working, not "might be stuck".
      this._apply([
        { kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: text },
        { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
      ]);
      this._decide(v.id, run, { ...w.e, backgroundTasks: 0, background: null }, w.seq).catch(err => this.log.error('Could not finish a turn:', err));
      return { ok: true, reply: `OK, ${v.name} is done. What it left running keeps running until you stop ${v.name} or close Workbench.` };
    }
    if (wait) {
      this._clearBackgroundAsk(v.id, text, STATE.WAITING_HELPERS);
      return { ok: true, reply: `OK, ${v.name} keeps waiting.` };
    }
    if (!text) return { ok: false, reply: 'Choose “It is done” or “Keep waiting”, or type a message for it.' };
    const sent = await this._sendTo(v, text); // anything else is a message for the agent
    if (!sent.ok) return sent;
    this._clearBackgroundAsk(v.id, text);
    return { ok: true, reply: `Passed your message to ${v.name}.` };
  }

  async _answerDone(v, text) {
    if (!text || LOOKS_GOOD_RE.test(text)) return { ok: true, reply: `Good. ${v.name} stays as it is.` };
    if (NOT_NOW_RE.test(text)) return { ok: true, reply: v.work?.branch ? `OK. ${v.name}’s work stays on its branch for now.` : `OK. ${v.name} stays as it is.` };
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    return { ok: true, reply: sent.reply || `Sent your follow-up to ${v.name}.` };
  }

  async _answerSim(v, ask, text) {
    const sim = this.adapters.sim;
    if (typeof sim.onAnswer !== 'function') return { ok: false, reply: 'The demo cannot take that answer.' };
    let res;
    try {
      res = await sim.onAnswer(v.id, ask, text);
    } catch (err) {
      this.log.warn('The simulator could not take an answer:', err);
      return { ok: false, reply: 'The demo could not take that answer.' };
    }
    // The simulator words its own replies; otherwise use ours.
    if (res && typeof res.reply === 'string' && res.reply) return { ok: res.ok !== false, reply: res.reply };
    const n = text.toLowerCase().replace(/[.!]+$/, '').trim();
    if (ask.type === 'permission') return { ok: true, reply: ALLOW_LABEL_RE.test(text) ? `OK, ${v.name} can go ahead.` : `OK, ${v.name} will not do that.` };
    if (ask.type === 'stuck') {
      if (n === 'stop it' || n === 'stop') return { ok: true, reply: `Stopped ${v.name}.` };
      if (n === 'let it keep trying' || n === 'keep trying') return { ok: true, reply: `OK, ${v.name} will keep trying.` };
      return { ok: true, reply: `Passed your hint to ${v.name}.` };
    }
    return { ok: true, reply: `Sent your answer to ${v.name}.` };
  }

  // ================================================================ history

  /** Live mode: open this repository's history and show what it holds as earlier agents. Never stops Workbench. */
  _openHistory() {
    if (this.mode !== 'live' || !this.repoInfo || typeof this.deps.history?.open !== 'function') return;
    try {
      const h = this.deps.history.open({
        repoRoot: this.repoInfo.root, dir: this.options.historyDir || null, debounceMs: this.options.historyDebounceMs, log: this.log,
      });
      let masked = false;
      for (const saved of h.load()) {
        // Text kept before a key was stored (or by a Workbench that hid nothing) is hidden with the keys stored now, as
        // _apply hides an event's; ids, folders and branches stay as they are. The masked copy is the one kept, so it
        // is the one written back.
        const rec = this._mask ? maskValue(saved, this._mask, MASK_SKIP) : saved;
        if (this.store.restore({ ...rec, work: this._restoredWork(rec) }, this._canContinue(rec))) {
          this.earlierRecs.set(rec.id, rec);
          if (rec !== saved) masked = true;
        }
      }
      h.source(() => this._historyRecords());
      this.history = h;
      if (masked) h.schedule(); // the file holds the keys until it is written again
    } catch (err) {
      this.log.warn('Workbench could not open its history:', err);
      this.history = null;
    }
  }

  /** What the history file should hold now: the earlier agents nobody picked up, and this run's roots. */
  _historyRecords() {
    const out = [];
    const at = this.now();
    for (const v of this.store.list()) {
      if (v.parentId) continue;
      if (v.earlier) {
        const rec = this.earlierRecs.get(v.id);
        if (rec) out.push(rec);
        continue;
      }
      const run = this.runs.get(v.id);
      if (!run) continue;
      const rec = this.history.recordOf(v, run.folderRemoved ? null : (run.workspace || null), at);
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * An earlier agent's work as its view shows it: the saved one, with `folder` as it is on disk now. A record from
   * before Workbench kept `work` gets one made from its workspace, so its branch can still be shown, merged or thrown
   * away. None when it never had a branch to speak of.
   */
  _restoredWork(rec) {
    const ws = rec.workspace;
    const there = !!ws && folderThere(ws.path);
    const w = rec.work && typeof rec.work === 'object' ? rec.work : null;
    if (w) return { ...w, folder: there && !w.thrownAway };
    if (ws && ws.branch) return { branch: ws.branch, from: ws.from ?? null, folder: there, merged: null, problem: null, thrownAway: null };
    return null;
  }

  /**
   * The saved record of an earlier agent is written back unchanged unless it is replaced: after a merge or a
   * throw-away, rebuild it field by field from its view as it is now (`workspace`: its places now, or null).
   */
  _replaceEarlier(id, workspace) {
    const rec = this.earlierRecs.get(id);
    const v = this.store.get(id);
    if (!rec || !v || typeof this.history?.recordOf !== 'function') return;
    const next = this.history.recordOf(v, workspace, this.now());
    if (next) this.earlierRecs.set(id, next);
  }

  /** Can an earlier agent be picked up: its program is here, and its folder and conversation are still there? */
  _canContinue(rec) {
    if (rec.work?.thrownAway) return { ok: false, reason: THROWN_REASON };
    const mod = this.adapters[rec.harness];
    if (typeof mod?.createRunner !== 'function' || this.harnessInfo[rec.harness]?.ok === false) {
      return { ok: false, reason: `${harnessName(rec.harness)} is not available on this computer.` };
    }
    if (!rec.sessionId) return { ok: false, reason: 'It never saved its conversation, so there is nothing to pick up.' };
    if (!rec.workspace) return { ok: false, reason: NOT_KEPT_REASON };
    let there = false;
    try { there = fs.statSync(rec.workspace.path).isDirectory() && fs.existsSync(path.join(rec.workspace.path, '.git')); } catch { /* gone */ }
    if (!there) return { ok: false, reason: 'Its folder is gone, so it cannot continue.' };
    let known = null;
    try { known = typeof mod.sessionExists === 'function' ? mod.sessionExists({ sessionId: rec.sessionId }) : null; } catch { /* cannot tell */ }
    if (known === false) return { ok: false, reason: `${harnessName(rec.harness)} no longer has its conversation, so it cannot continue.` };
    return { ok: true };
  }

  /**
   * Pick an earlier agent up again in its own folder: a new runner on its saved session, which resumes it with the
   * message. The agent gets a fresh spending limit for this run (the new process has spent nothing).
   * @returns {Promise<{ ok: boolean, reply: string }>}
   */
  async _continueEarlier(v, text) {
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (this._busy.has(v.id)) return { ok: false, reply: this._busyReply(v) };
    const rec = this.earlierRecs.get(v.id);
    if (!rec) return { ok: false, reply: `${v.name} cannot continue. Its notes from the earlier run are gone.` };
    if (this._resuming.has(v.id)) return { ok: false, reply: `${v.name} is already being picked up.` };
    const can = this._canContinue(rec);
    if (!can.ok) {
      this.store.markContinue(v.id, can);
      return { ok: false, reply: `${v.name} cannot continue. ${can.reason}` };
    }
    this._resuming.add(v.id);
    const budget = this.defaultBudgetUsd;
    const w = rec.workspace;
    // A record from before Workbench kept `since` starts its unmerged work where the agent started.
    const workspace = { path: w.path, branch: w.branch ?? null, base: w.base ?? null, since: w.since ?? w.base ?? null, from: w.from ?? null };
    const run = {
      id: v.id, harness: rec.harness, runner: null, workspace,
      config: this._loadConfig(workspace),
      turnSeq: 0, inTurn: false, deciding: false, stopped: false, lastText: '',
      receipt: null, checksDone: null,
      waiting: null, background: null, backgroundAt: 0, accepted: null,
      // The earlier run's spend: the new process counts from zero (see _withEarlierSpend).
      earlierSpend: { ...rec.usage },
    };
    try {
      run.runner = this.adapters[rec.harness].createRunner({
        agentId: v.id, name: v.name, task: rec.task, cwd: workspace.path, model: v.model, budgetUsd: budget,
        sessionId: rec.sessionId,
        emit: (ev) => this.ingest(ev),
        hook: this.mode === 'live' && rec.harness === 'claude' ? { url: this.hook?.url ?? null, token: this._hookToken(v.id) } : null,
        log: this.log, harness: rec.harness, machineId: v.machineId,
        ...this._runnerKeys(rec.harness),
      });
      this.runs.set(v.id, run);
      this.stopped.delete(v.id);
      await run.runner.send(text);
    } catch (err) {
      this.runs.delete(v.id);
      this._resuming.delete(v.id);
      try { await run.runner?.stop?.(); } catch { /* it never started */ }
      this.log.warn(`Could not continue ${v.id}:`, err);
      return { ok: false, reply: err?.plain ? err.message : `I could not continue ${v.name}: ${plainReason(err)}` };
    }
    this._resuming.delete(v.id);
    this.earlierRecs.delete(v.id);
    this._apply([
      { kind: EV.RESUMED, agentId: v.id, budgetUsd: budget },
      { kind: EV.STATE, agentId: v.id, state: STATE.WORKING, reason: null },
    ]);
    this._clearProblem(v.id); // it took a message
    this._refreshMachines();
    return { ok: true, reply: `${v.name} is continuing in its own folder. It has a new spending limit of ${money(budget)} for this run.` };
  }

  /**
   * A continued agent's new process counts its spend from zero, so its totals (`set`, at the end of a turn) start
   * again. Add what the earlier run spent, so the card does not forget it. Claude Code 2.1.277 and newer restore a
   * resumed session's totals themselves (its own session line says which version runs): then nothing is added, or the
   * earlier spend would count twice. When the version is not known, it is added, as before.
   */
  _withEarlierSpend(e) {
    const run = this.runs.get(e.agentId);
    const base = run?.earlierSpend;
    if (!base) return e;
    if (run.harness === 'claude' && versionAtLeast(run.harnessVersion, RESTORES_SPEND_FROM) === true) return e;
    const out = { ...e };
    for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      if (Number.isFinite(out[f])) out[f] += base[f] || 0;
    }
    if (Number.isFinite(out.costUsd)) out.costUsd += (base.costUsd || 0) + (base.unreportedUsd || 0);
    return out;
  }

  /** A root's session line says which version of its harness runs (Claude Code's claude_code_version): keep it. */
  _noteVersion(e) {
    const run = this.runs.get(e.agentId);
    const version = typeof e.version === 'string' && versionParts(e.version) ? e.version.trim().slice(0, 40) : null;
    if (!run || !version) return;
    run.harnessVersion = version;
    const info = this.harnessInfo[run.harness];
    if (this.mode === 'live' && info && typeof info === 'object') this.harnessInfo[run.harness] = { ...info, version };
  }

  /** Does an agent's folder stay on this computer: kept when it was saved (earlier agents) or not removed (this run)? */
  _folderKept(v) {
    if (v.work?.thrownAway) return false;
    const run = this.runs.get(v.id);
    if (run) return !!run.workspace && !run.folderRemoved;
    const rec = this.earlierRecs.get(v.id);
    return !!rec?.workspace;
  }

  _proposeForget(views) {
    const names = joinAnd(views.map(v => v.name));
    const sentence = `Forget ${names}?`;
    const kept = views.filter(v => this._folderKept(v)).length;
    let detail;
    if (views.length === 1) detail = kept ? 'It will not show here again. Its folder and branch stay on this computer.' : 'It will not show here again.';
    else if (kept === views.length) detail = 'They will not show here again. Their folders and branches stay on this computer.';
    else detail = kept ? 'They will not show here again. The folders still on this computer stay there.' : 'They will not show here again.';
    return this._newConfirm({ kind: 'forget', agentIds: views.map(v => v.id), sentence, detail });
  }

  /** Take earlier agents out of history, and off the board. Their folders and branches are not touched. */
  _forgetEarlier(ids) {
    const gone = [];
    const refused = [];
    let kept = 0;
    for (const id of ids) {
      const v = this.store.get(id);
      if (!v) continue;
      if (this._busy.has(id)) {
        refused.push(this._busyReply(v));
        continue;
      }
      if (!v.earlier || !this.earlierRecs.has(id)) {
        refused.push(`${v.name} is from this run, so it stays. It is kept for next time.`);
        continue;
      }
      if (this._folderKept(v)) kept += 1;
      this.earlierRecs.delete(id);
      this.history?.forget(id);
      this.store.remove(id);
      gone.push(v.name);
    }
    if (gone.length) { try { this.history?.save(); } catch { /* logged by history */ } }
    const parts = [];
    if (gone.length) {
      // Only what is true: a folder thrown away, or not kept, is not "still on this computer".
      let tail = '';
      if (kept === gone.length) tail = ` ${gone.length === 1 ? 'Its folder and branch are' : 'Their folders and branches are'} still on this computer.`;
      else if (kept) tail = ' The folders still on this computer stay there.';
      parts.push(`Forgot ${joinAnd(gone)}.${tail}`);
    }
    parts.push(...refused);
    return { reply: parts.join(' ') || 'There was nothing to forget.', agentIds: [] };
  }

  // ================================================================ messages

  /** Send an agent a message: a hint while it works, or a follow-up once it is done. */
  async say(agentId, text) {
    const v = this.store.get(agentId);
    const words = String(text ?? '').trim();
    // Typed in the reply box: a key goes nowhere (it would reach the agent's input, its arguments and the history).
    const out = this._looksLikeKey(words) ? { ok: false, reply: SECRET_REFUSED, openConnect: true }
      : v ? await this._say(v, words) : { ok: false, reply: 'I can’t find that agent.' };
    this._notice(out.reply, agentId);
    return out;
  }

  async _say(v, text) {
    if (!text) return { ok: false, reply: 'There is nothing to send.' };
    if (v.ask && v.ask.type === 'question') return this._answer(v.id, v.ask.id, text); // it is the answer
    const sent = await this._sendTo(v, text);
    if (!sent.ok) return sent;
    if (sent.reply) return sent; // an earlier agent picked up again says so itself
    if (v.parentId) {
      const root = this.store.get(v.rootId);
      return { ok: true, reply: `Passed that to ${root ? root.name : 'its agent'} for its helper ${v.name}.` };
    }
    return { ok: true, reply: `Sent to ${v.name}.` };
  }

  /** Deliver text to the root that runs an agent. Helpers are reached through their root. */
  async _sendTo(v, text) {
    const root = v.parentId ? this.store.get(v.rootId) : v;
    if (!root) return { ok: false, reply: `I can’t reach ${v.name}.` };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    // Its work is being merged or thrown away: nothing may wake it until that is done.
    if (this._busy.has(root.id)) return { ok: false, reply: this._busyReply(root) };
    // Its folder was thrown away, or removed: a message would wake it where nothing is left.
    if (root.work?.thrownAway) return { ok: false, reply: `${root.name} cannot continue. ${THROWN_REASON}` };
    const message = v.parentId ? `About your helper “${v.name}”: ${text}` : text;
    if (root.earlier && !v.parentId) return this._continueEarlier(root, message);
    const run = this.runs.get(root.id);
    if (run && run.folderRemoved) return { ok: false, reply: `${root.name} cannot continue. Its folder is gone, so it cannot continue.` };
    if (!run || !run.runner) {
      // An agent the simulator seeded: let the simulator take the message. A message answers a question, but never
      // settles a permission or a stuck ask: as in live mode, where a held request stays held.
      const sim = this.mode === 'demo' ? this.adapters.sim : null;
      if (sim && (typeof sim.say === 'function' || typeof sim.onAnswer === 'function')) {
        try {
          const question = v.ask && v.ask.type === 'question';
          const res = question && typeof sim.onAnswer === 'function'
            ? await sim.onAnswer(v.id, v.ask, text)
            : typeof sim.say === 'function' ? await sim.say(v.id, text) : await sim.onAnswer(v.id, null, text);
          if (res && res.ok === false) return { ok: false, reply: res.reply || `${v.name} could not take that.` };
          return { ok: true };
        } catch (err) {
          this.log.warn('The simulator could not take a message:', err);
        }
      }
      return { ok: false, reply: `${root.name} is not running, so I can’t pass that on.` };
    }
    const wasStopped = run.stopped;
    run.stopped = false; // a new message brings a stopped agent back
    this.stopped.delete(root.id);
    try {
      await run.runner.send(message);
    } catch (err) {
      if (wasStopped) {
        run.stopped = true;
        this.stopped.add(root.id);
      }
      this.log.warn('Could not send a message:', err);
      // A runner's own plain sentence says it all ("Fix cart total has used its whole spending limit, so it can’t
      // continue."); anything else was a failure to reach it.
      return { ok: false, reply: err?.plain ? err.message : `I could not reach ${root.name}: ${plainReason(err)}` };
    }
    this._cancelReceipt(run); // it works on again: checks of the folder as it was would mislead
    const cur = this.store.get(root.id);
    // A turn start resumes done and failed roots by itself, but not stopped ones, and it may come much later (a
    // relaunch): do it now for all.
    if (cur && ENDED.has(cur.state)) this._apply([{ kind: EV.STATE, agentId: root.id, state: STATE.WORKING, reason: null }]);
    this._clearProblem(root.id); // a merge that did not go through no longer describes work it changes again
    return { ok: true };
  }

  // ================================================================ the spending limit

  /**
   * One more spending limit for this run (POST /api/agents/:id/raise-limit, the lid's "Give it $2.00 more"): a Claude Code
   * root that failed because it reached its limit may spend the run's default limit more, and continues where it left
   * off. `state`: the state the page drew its button for (null: not checked).
   * @returns {Promise<{ ok: boolean, reply: string }>}
   */
  async raiseLimit(agentId, { state = null } = {}) {
    const out = await this._raiseLimit(this.store.get(String(agentId ?? '')), { state });
    this._notice(out.reply, typeof agentId === 'string' ? agentId : null);
    return out;
  }

  async _raiseLimit(v, { state = null } = {}) {
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (this.mode === 'demo') return { ok: false, reply: 'This is the demo, so nothing is really spent.' };
    if (v.parentId) return { ok: false, reply: 'Helpers share their agent’s spending limit. Give the agent more instead.' };
    if (v.earlier) return { ok: false, reply: `${v.name} is from an earlier run. Continue gives it a new spending limit for this run.` };
    if (v.harness !== 'claude') return { ok: false, reply: `${harnessName(v.harness)} reports no cost, so ${v.name} has no spending limit to raise.` };
    if (this._busy.has(v.id)) return { ok: false, reply: this._busyReply(v) };
    if (this._resuming.has(v.id)) return { ok: false, reply: `${v.name} is already being picked up.` };
    if (state && state !== v.state) return { ok: false, reply: 'That changed. Have another look.' };
    if (v.state !== STATE.FAILED || !v.atLimit) return { ok: false, reply: `${v.name} has not reached its spending limit.` };
    const run = this.runs.get(v.id);
    if (typeof run?.runner?.setLimit !== 'function') return { ok: false, reply: `Workbench cannot raise ${v.name}’s spending limit.` };
    const was = Number.isFinite(v.budgetUsd) && v.budgetUsd > 0 ? v.budgetUsd : this.defaultBudgetUsd;
    const limit = was + this.defaultBudgetUsd;
    this._resuming.add(v.id); // being picked up: nothing may merge it, and a second press hears that this one is under way
    try {
      // A process still running keeps the limit it was started with, so the message must start a new one.
      await this._closeIdle(v);
      run.runner.setLimit(limit);
      const sent = await this._sendTo(v, CONTINUE_TEXT);
      if (!sent.ok) {
        // Nothing started, so nothing changes: the runner gets its limit back. A turn that went past the limit by more
        // than a whole limit more still leaves under a cent, and the runner says so in its own words.
        try { run.runner.setLimit(was); } catch (err) { this.log.warn(`Could not put back the spending limit of ${v.id}:`, err); }
        return sent;
      }
    } finally {
      this._resuming.delete(v.id);
    }
    this._apply([{ kind: EV.RESUMED, agentId: v.id, budgetUsd: limit }]);
    return { ok: true, reply: `${v.name} can spend ${money(limit)} in all now, and it is continuing.` };
  }

  // ================================================================ stopping

  async stop(agentId) {
    const v = this.store.get(agentId);
    const out = v ? await this._stop(v) : { ok: false, reply: 'I can’t find that agent.' };
    this._notice(out.reply, agentId);
    return out;
  }

  async _stop(v) {
    // Its work is being merged or thrown away: that job decides what runs (a throw-away stops it first).
    const root = v.parentId ? this.store.get(v.rootId) : v;
    if (root && this._busy.has(root.id)) return { ok: false, reply: this._busyReply(root) };
    if (v.parentId) return this._stopHelper(v);
    if (v.earlier) return { ok: true, reply: `${v.name} is from an earlier run, so nothing is running.` };
    if (!ACTIVE.has(v.state)) {
      if (DONE.has(v.state)) {
        await this._closeIdle(v);
        return { ok: true, reply: `${v.name} had already finished.` };
      }
      return { ok: true, reply: `${v.name} is not running.` };
    }
    await this._stopRoot(v, 'Stopped by you');
    return { ok: true, reply: `Stopped ${v.name}.` };
  }

  async _stopRoot(v, reason) {
    const run = this.runs.get(v.id);
    this.stopped.add(v.id);
    if (run) run.stopped = true;
    this._cancelReceipt(run); // stopping an agent stops the checks it is running
    // What a turn decided while a request was held would otherwise show for a moment before "stopped".
    for (const a of [v, ...this.store.descendants(v.id)]) this._dropLater(a.id);
    this._denyHeldFor(v.id, 'The agent was stopped.', true);
    if (run && run.runner) {
      try {
        await withTimeout(Promise.resolve().then(() => run.runner.stop()), this.options.stopTimeoutMs);
      } catch (err) {
        this.log.warn(`Could not stop ${v.id} cleanly:`, err);
      }
    } else {
      await this._simStop(v.id); // an agent the simulator seeded
    }
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent was stopped' });
    }
    batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason });
    this._apply(batch);
    for (const a of [...this.asks.keys()]) {
      const rec = this.asks.get(a);
      const owner = rec && this.store.get(rec.agentId);
      if (owner && owner.rootId === v.id) this.asks.delete(a);
    }
    this._refreshMachines();
  }

  /** Tell the simulator to stop one of its own agents (it has stopAgent; stop is accepted too). */
  async _simStop(agentId) {
    const sim = this.mode === 'demo' ? this.adapters.sim : null;
    const fn = sim && (typeof sim.stopAgent === 'function' ? sim.stopAgent : typeof sim.stop === 'function' ? sim.stop : null);
    if (!fn) return;
    try { await fn.call(sim, agentId); } catch (err) { this.log.warn('The simulator could not stop an agent:', err); }
  }

  /** A finished root may still have an idle process waiting for a follow-up: close it quietly. */
  async _closeIdle(v) {
    const run = this.runs.get(v.id);
    if (!run || !run.runner || !run.runner.info?.()?.alive) return;
    run.stopped = true;
    this.stopped.add(v.id);
    try {
      await withTimeout(Promise.resolve().then(() => run.runner.stop()), this.options.stopTimeoutMs);
    } catch (err) {
      this.log.warn(`Could not close ${v.id}:`, err);
    }
  }

  async _stopHelper(v) {
    if (!ACTIVE.has(v.state)) return { ok: true, reply: `${v.name} is not running.` };
    const root = this.store.get(v.rootId);
    const run = root ? this.runs.get(root.id) : null;
    // A real helper lives inside its root's process: ask the root to stop it.
    if (this.mode === 'live' && run && run.runner && !run.stopped) {
      const sent = await this._sendTo(root, `Please stop your helper “${v.name}” now, because it may be stuck, and carry on without it.`);
      if (sent.ok) {
        // Its root can act on that only once the helper moves on, and a held request would keep it waiting: say no to
        // its held requests now, and to every tool it asks for from now on (it keeps running until it ends).
        this.stopAsked.add(v.id);
        this._dropLater(v.id);
        this._denyHeldFor(v.id, 'The person stopped this helper.');
        const ask = this.store.get(v.id)?.ask;
        if (ask && this.asks.has(ask.id) && !this.held.has(ask.id)) {
          this.asks.delete(ask.id);
          this._apply([{ kind: EV.ASK_CLEARED, agentId: v.id, askId: ask.id, answer: 'Stop it' }]);
        }
        return { ok: true, reply: `I asked ${root.name} to stop its helper ${v.name}.` };
      }
    }
    // Simulated (or unreachable) helpers are stopped right here.
    this.stopped.add(v.id);
    this._dropLater(v.id);
    this._denyHeldFor(v.id, 'The helper was stopped.');
    if (this.mode === 'demo') await this._simStop(v.id);
    const batch = [];
    for (const d of this.store.descendants(v.id)) {
      if (ACTIVE.has(d.state)) batch.push({ kind: EV.STATE, agentId: d.id, state: STATE.STOPPED, reason: 'Its agent was stopped' });
    }
    batch.push({ kind: EV.STATE, agentId: v.id, state: STATE.STOPPED, reason: 'Stopped by you' });
    this._apply(batch);
    return { ok: true, reply: `Stopped ${v.name}.` };
  }

  // ================================================================ launching

  /** Launch a root agent. Does not ask first: command() and the UI confirm before calling this. */
  async startAgent(opts = {}) {
    const v = await this._startAgent(opts);
    this._notice(v.state === STATE.FAILED ? `${v.name} could not start. ${v.stateReason || ''}`.trim() : `Started ${v.name}.`, v.id);
    return v;
  }

  /** A launch, tracked while it is under way so that shutdown can wait for it (see shutdown). */
  _startAgent(opts) {
    const p = this._launch(opts);
    this._launching.add(p);
    const done = () => this._launching.delete(p);
    p.then(done, done);
    return p;
  }

  async _launch({ task, harness, model, machineId, budgetUsd, name } = {}) {
    if (this._shuttingDown) throw plainError('Workbench is shutting down.');
    const text = String(task ?? '').trim();
    if (!text) throw plainError('Tell me what the agent should work on.');
    // A key typed as a task or a name (its shape, or a stored key's value) would end up in a folder and branch name,
    // the agent's arguments and the history. As in command(), Agents & keys opens.
    if (this._looksLikeKey(text) || (name != null && this._looksLikeKey(name))) {
      throw Object.assign(plainError(SECRET_REFUSED), { openConnect: true });
    }
    // Named in the words, or the default agent (the person's choice when it is ready, else the first ready one).
    // Refusals for want of an agent carry openConnect, so a reply made from them opens Agents & keys.
    const h = harness || this._defaultHarness();
    if (!h) throw Object.assign(plainError(NO_AGENT), { openConnect: true });
    if (!HARNESS_NAMES[h]) throw plainError(`I don’t know that kind of agent. Choose ${joinOr(AGENT_HARNESSES.map(harnessName))}.`);
    // --model (defaultModel) names a Claude model, so only Claude Code agents get it: Codex given `-m haiku` cannot
    // start. A model named for this launch goes to whichever agent it was named for.
    const mdl = model ? String(model).trim() : (h === 'claude' ? this.defaultModel || null : null);
    if (mdl && !MODEL_RE.test(mdl)) throw plainError('That model name does not look right.');
    const budget = Number.isFinite(+budgetUsd) && +budgetUsd > 0 ? +budgetUsd : this.defaultBudgetUsd;
    const agentName = clip(String(name || '').replace(/^[-\s]+/, '').trim(), 40) || nameFromTask(text).replace(/^[-\s]+/, '') || 'New task';
    const id = this._newRootId();

    let factory;
    let workspace = null;
    let mach = 'laptop';
    if (this.mode === 'demo') {
      const sim = this.adapters.sim;
      if (typeof sim?.createRunner !== 'function') throw plainError('The simulator is not available.');
      factory = (o) => sim.createRunner(o);
      const known = this.store.machines();
      if (machineId && (known.some(m => m.id === machineId) || !known.length)) mach = machineId;
    } else {
      if (h === 'sim') throw plainError('Simulated agents run only in the demo.');
      const mod = this.adapters[h];
      if (typeof mod?.createRunner !== 'function' || this.harnessInfo[h]?.ok === false) {
        throw Object.assign(plainError(this._cannotRunSentence(h)), { openConnect: true });
      }
      factory = (o) => mod.createRunner(o);
      const repo = await this._loadRepo();
      if (typeof this.deps.workspace?.createWorkspace !== 'function') throw plainError('Workbench cannot make workspaces right now.');
      // The person's branch now: the agent starts from it (null when the folder is not on a branch).
      let from = repo.branch ?? null;
      try {
        from = (await this._freshRepo())?.branch ?? null;
      } catch (err) {
        this.log.debug('Could not read the repository before a launch:', err);
      }
      const made = await this.deps.workspace.createWorkspace({ repoRoot: repo.root, agentId: id, slug: slugify(agentName) });
      // `since`: where its unmerged work starts. It is the commit it started from until its first merge.
      workspace = { path: made.path, branch: made.branch ?? null, base: made.base ?? null, since: made.base ?? null, from };
      if (this._shuttingDown) {
        // Workbench began to close while git made the folder: nothing starts in it, so it goes again. One that cannot
        // go is listed with the other folders that stay (keptFolders), never left unmentioned.
        const late = { id, name: agentName, workspace };
        if (!(await this._removeUnchanged(late))) this.runs.set(id, late);
        throw plainError('Workbench is shutting down.');
      }
    }

    const run = {
      id, harness: h, runner: null, workspace,
      config: this._loadConfig(workspace),
      turnSeq: 0, inTurn: false, deciding: false, stopped: false, lastText: '',
      receipt: null, checksDone: null, // the receipt being built (cancellable) and when its checks have ended
      waiting: null, background: null, backgroundAt: 0, accepted: null, // background work left running
    };
    this.runs.set(id, run);
    this._apply([
      { kind: EV.CREATED, agentId: id, parentId: null, name: agentName, task: text, harness: h, model: mdl, machineId: mach, budgetUsd: budget, workspace: workspace?.path ?? null },
      ...(workspace ? [{ kind: EV.WORK, agentId: id, work: { branch: workspace.branch, from: workspace.from, folder: true, merged: null, problem: null, thrownAway: null } }] : []),
      { kind: EV.STATE, agentId: id, state: STATE.STARTING, reason: null },
    ]);
    try {
      run.runner = factory({
        agentId: id,
        name: agentName,
        task: text,
        cwd: workspace?.path ?? null,
        model: mdl,
        budgetUsd: budget,
        emit: (ev) => this.ingest(ev),
        // Only a real Claude Code agent has the hook, with its own token. Codex and the simulator get none.
        hook: this.mode === 'live' && h === 'claude' ? { url: this.hook?.url ?? null, token: this._hookToken(id) } : null,
        log: this.log,
        harness: h,
        machineId: mach,
        ...this._runnerKeys(h), // live only: the person's keys for this agent, and the mask that hides them
      });
      await run.runner.start();
    } catch (err) {
      this.log.error(`Agent ${id} could not start:`, err);
      const why = plainReason(err);
      this._apply([
        { kind: EV.ENDED, agentId: id, outcome: 'error', error: why },
        { kind: EV.STATE, agentId: id, state: STATE.FAILED, reason: `It could not start: ${why}` },
      ]);
      if (this._runnerInfo(run)?.alive !== true) await this._removeUnchanged(run); // nothing ran in its folder
    }
    this._refreshMachines();
    return this.store.get(id);
  }

  /**
   * Remove an agent's folder and branch when they hold nothing: never while it might hold work (see removeWorkspace's
   * onlyIfUnchanged). Used when an agent could not start, and at shutdown (this run's agents, and the earlier agents
   * merged in this run: `run.earlier`). Never during the session otherwise: stopped, failed and done agents all take
   * follow-ups in the same folder.
   */
  async _removeUnchanged(run) {
    const ws = run && run.workspace;
    if (!ws || run.folderRemoved || !this.repoInfo || typeof this.deps.workspace?.removeWorkspace !== 'function') return false;
    try {
      // Unchanged since its last merge (or since it started): a merged agent that did nothing more goes too. git hears
      // where it started (base) and, once it was merged, where its unmerged work starts (since, its merged work
      // commit): then the folder goes only while that commit is still in another branch, so a merge the person undid
      // never takes the only copy of the work with it.
      const args = { repoRoot: this.repoInfo.root, path: ws.path, base: ws.base ?? null, onlyIfUnchanged: true, deleteBranch: true };
      if (ws.since && ws.since !== ws.base) args.since = ws.since;
      const out = await withTimeout(Promise.resolve().then(() => this.deps.workspace.removeWorkspace(args)), this.options.stopTimeoutMs);
      if (out?.removed) {
        run.folderRemoved = true;
        // Its folder and branch went with nothing in them: the view says so too.
        const w = this.store.get(run.id)?.work;
        if (w) this._apply([{ kind: EV.WORK, agentId: run.id, work: { ...w, folder: false, branch: null } }]);
        if (run.earlier) {
          // An earlier agent's record keeps no folder from now on, so next time it says it cannot continue.
          this._replaceEarlier(run.id, null);
          this.store.markContinue(run.id, { ok: false, reason: NOT_KEPT_REASON });
        }
      }
      return !!out?.removed;
    } catch (err) {
      this.log.warn(`Could not tidy up the folder of ${run.id}:`, err);
      return false;
    }
  }

  /**
   * For the shutdown tidy: the earlier agents merged in this run whose record still keeps a folder, as run-like
   * { id, earlier, workspace } for _removeUnchanged. Not one that is busy, being picked up, or was picked up (it is
   * one of this run's then), and not one this run never merged: another Workbench may be running that one.
   */
  _earlierToTidy() {
    const out = [];
    for (const id of this._mergedEarlier) {
      const rec = this.earlierRecs.get(id);
      const v = this.store.get(id);
      const ws = rec?.workspace;
      if (!ws || !v?.earlier || v.work?.thrownAway || this.runs.has(id) || this._busy.has(id) || this._resuming.has(id)) continue;
      if (!folderThere(ws.path)) continue;
      out.push({ id, earlier: true, workspace: { ...ws } });
    }
    return out;
  }

  /** This agent's own hook token, or null (Claude Code then refuses to start: fail closed). */
  _hookToken(agentId) {
    try {
      const t = typeof this.hook?.tokenFor === 'function' ? this.hook.tokenFor(agentId) : null;
      return typeof t === 'string' && t ? t : null;
    } catch {
      return null;
    }
  }

  _newRootId() {
    for (;;) {
      const id = hex(3);
      if (!this.store.get(id) && !this.runs.has(id)) return id;
    }
  }

  _loadConfig(workspace) {
    if (!workspace || typeof this.deps.workspace?.readRepoConfig !== 'function' || !this.repoInfo) {
      return Promise.resolve(DEFAULT_CONFIG);
    }
    // Read from the commit the workspace came from, never from the agent's working copy.
    return Promise.resolve()
      .then(() => this.deps.workspace.readRepoConfig({ repoRoot: this.repoInfo.root, ref: workspace.base }))
      .then(c => ({ ...DEFAULT_CONFIG, ...(c || {}) }))
      .catch((err) => {
        this.log.warn('Could not read workbench.json:', err);
        return DEFAULT_CONFIG;
      });
  }

  async _loadRepo() {
    if (this.repoInfo) return this.repoInfo;
    if (!this.repo) throw plainError('Workbench needs a git repository to run real agents. Start it with --repo and the path to one.');
    if (typeof this.deps.workspace?.prepareRepo !== 'function') throw plainError('Workbench cannot read git repositories right now.');
    this.repoInfo = await this.deps.workspace.prepareRepo(String(this.repo));
    return this.repoInfo;
  }

  /**
   * Read the person's repository again now, whether git knows their name and email included, and tell the page when
   * what it shows changed (the store's 'repo', which the server sends as `event: repo`). For bin to call when Agents &
   * keys saves the name and email, so Merge shows at once, not at the next 15 s refresh. A read already under way does not
   * hold it back: of two reads, the one begun later is kept (_freshRepo). Live mode only, and it never rejects.
   * @returns {Promise<object|null>} the repository as the page sees it now (_repoView), or null (the demo, or before start)
   */
  async refreshRepo() {
    if (this.mode === 'live' && this.repoInfo?.root) {
      try {
        await this._freshRepo();
      } catch (err) {
        this.log.debug('Could not refresh the repo status:', err);
      }
    }
    return this._repoView();
  }

  /** Every 15 s: the repository as it is now (fire and forget, one at a time). */
  _refreshRepo() {
    if (!this.repoInfo?.root || typeof this.deps.workspace?.prepareRepo !== 'function' || this._repoReading) return;
    const reading = this._freshRepo()
      .catch(err => this.log.debug('Could not refresh the repo status:', err))
      .finally(() => { if (this._repoReading === reading) this._repoReading = null; });
    this._repoReading = reading;
  }

  /**
   * Read the repository as it is now (its branch, head and uncommitted changes, and whether git knows the person's
   * name and email), keep it, and tell the page when that changed. Rejects when git cannot read it.
   */
  async _freshRepo() {
    const root = this.repoInfo?.root;
    if (!root || typeof this.deps.workspace?.prepareRepo !== 'function') return this.repoInfo;
    // Reads can overlap (the 15 s refresh, a card, a merge): one that began before the last one kept is older than
    // what is known, and is dropped, so the page never steps back to a head the person's branch has left.
    const seq = ++this._repoSeq;
    const info = await this.deps.workspace.prepareRepo(root);
    if (!info || !info.root) return this.repoInfo;
    const identity = await this._readIdentity(info.root);
    if (seq < this._repoKept) return this.repoInfo;
    this._repoKept = seq;
    this._setRepo(info, identity);
    return this.repoInfo;
  }

  /** Does git know the person's name and email (gitIdentity)? null when this cannot be told. */
  async _readIdentity(root) {
    if (typeof this.deps.workspace?.gitIdentity !== 'function') return null;
    try {
      const id = await this.deps.workspace.gitIdentity({ repoRoot: root });
      return !!(id && typeof id === 'object' && id.name && id.email);
    } catch (err) {
      this.log.debug('Could not read the git identity:', err);
      return this.repoIdentity; // keep what was known
    }
  }

  /** Keep the repository's facts; the store tells the page ('repo') when what it shows has changed. */
  _setRepo(info, identity = this.repoIdentity) {
    this.repoInfo = info;
    this.repoIdentity = identity ?? null;
    const view = this._repoView();
    const key = JSON.stringify(view);
    if (key === this._repoKey) return;
    this._repoKey = key;
    try { this.store.repoChanged?.(view); } catch (err) { this.log.warn('Could not pass on the repository:', err); }
  }

  /**
   * The repository as the page sees it: { name, head, branch, dirty, identity }. identity: git knows the person's name
   * and email (true), or not (false); null only while Workbench cannot tell (not read yet, or no gitIdentity).
   */
  _repoView() {
    const r = this.repoInfo;
    if (!r) return null;
    const identity = typeof this.repoIdentity === 'boolean' ? this.repoIdentity : null;
    return { name: r.name ?? null, head: r.head ?? null, branch: r.branch ?? null, dirty: r.dirty ?? 0, identity };
  }

  /**
   * At start in live mode: ask each agent's adapter whether it can run here, so no adapter is taken as ready untested.
   * An agent Connect has already said something of (setHarnesses), before or while this runs, keeps Connect's word:
   * it is newer, and knows about signing in.
   */
  async _checkHarnesses() {
    this.harnessInfo.sim = { ok: false, reason: 'Simulated agents run only in the demo.' };
    for (const h of AGENT_HARNESSES) {
      if (this._told.has(h)) continue;
      const mod = this.adapters[h];
      let info;
      if (!mod) {
        info = { ok: false, reason: `${harnessName(h)} was not found on this computer.` };
      } else {
        try {
          const res = typeof mod.available === 'function' ? await withTimeout(mod.available(), this.options.availableTimeoutMs) : { ok: true };
          info = harnessInfoOf(res, h);
        } catch (err) {
          info = { ok: false, reason: plainReason(err) };
        }
      }
      if (!this._told.has(h)) this.harnessInfo[h] = info;
    }
  }

  /**
   * Which agent programs can start now, as Connect found them: { claude: info, codex: info } (its 'agents' event), each
   * as the adapter's available() gives it ({ ok, version?, reason?, ... }, Codex's with loggedIn). Live mode only.
   * New work and continued earlier agents go by it from now on, and so does the snapshot's `connect`; agents already
   * running are untouched. An agent missing from the map keeps what was known of it. Earlier agents of an agent whose
   * availability changed are told again whether they can continue. The engine can start only an agent whose adapter
   * it was given (`adapters`), whatever the map says.
   * @returns {boolean} whether the map was taken
   */
  setHarnesses(map) {
    if (this.mode !== 'live' || !map || typeof map !== 'object') return false;
    const changed = [];
    for (const h of AGENT_HARNESSES) {
      if (!Object.prototype.hasOwnProperty.call(map, h)) continue;
      const before = this.harnessInfo[h];
      const info = harnessInfoOf(map[h], h);
      this.harnessInfo[h] = info;
      this._told.add(h);
      if ((before?.ok !== false) !== (info.ok !== false)) changed.push(h);
    }
    if (changed.length) this._recheckEarlier(changed);
    return true;
  }

  /** Earlier agents of these harnesses: can they continue now? (Their program may have come, or gone.) */
  _recheckEarlier(harnesses) {
    for (const [id, rec] of this.earlierRecs) {
      if (!harnesses.includes(rec.harness) || this._resuming.has(id) || !this.store.get(id)?.earlier) continue;
      try {
        this.store.markContinue(id, this._canContinue(rec));
      } catch (err) {
        this.log.warn(`Could not check whether ${id} can continue:`, err);
      }
    }
  }

  /** Can new work start on this harness, and is its program not known to be signed out? */
  _ready(h) {
    if (!this._canRun(h)) return false;
    if (this.mode === 'demo') return true;
    const info = this.harnessInfo[h];
    return !(info && (info.ready === false || info.loggedIn === false || info.signedIn === 'no'));
  }

  /**
   * Where new work goes when the words name no agent, or null when no agent is ready. With Connect: its default agent
   * (the person's choice when that one is ready, else the first ready one), when this engine can start it; if Connect
   * says none is ready, none is. Without Connect, or when Connect names an agent this engine has no adapter for: the
   * first ready agent, Claude Code first. The demo's agents are simulated: the first harness it can run.
   */
  _defaultHarness() {
    if (this.mode !== 'demo' && typeof this.connect?.defaultAgent === 'function') {
      let d;
      try {
        d = this.connect.defaultAgent();
      } catch (err) {
        this.log.warn('Could not tell which agent is the default:', err?.message ?? 'unknown error');
      }
      if (d === null) return null;
      if (typeof d === 'string' && AGENT_HARNESSES.includes(d) && this._canRun(d)) return d;
    }
    return AGENT_HARNESSES.find(h => this._ready(h)) || null;
  }

  /**
   * The snapshot's `connect`: { ready, defaultAgent, agents: [{ id, name, ready }] }. `ready`: new work that names no
   * agent would start (on `defaultAgent`); each agent's `ready`: work can start on it. Worked out by the same rule that
   * picks the agent for new work, so the page's light and a start never disagree.
   */
  _connectMeta() {
    const def = this._defaultHarness();
    return {
      ready: def !== null,
      defaultAgent: def,
      agents: AGENT_HARNESSES.map(h => ({ id: h, name: harnessName(h), ready: def !== null && (h === def || this._ready(h)) })),
    };
  }

  _harnessFlags() {
    if (this.mode === 'demo') {
      const ok = !!this.adapters.sim;
      return { ...Object.fromEntries(AGENT_HARNESSES.map(h => [h, ok])), sim: ok };
    }
    const ok = (h) => !!this.adapters[h] && this.harnessInfo[h]?.ok !== false;
    return { ...Object.fromEntries(AGENT_HARNESSES.map(h => [h, ok(h)])), sim: false };
  }

  // ================================================================ source control: changes, the graph, merge, throw away

  /** A root, from its own id or a helper's (a helper works in its agent's folder). */
  _rootOf(agentId) {
    const v = typeof agentId === 'string' && agentId ? this.store.get(agentId) : null;
    if (!v) return null;
    return v.parentId ? this.store.get(v.rootId) : v;
  }

  /**
   * Where a root's work is: this run's run.workspace ({ path, branch, base, since, from }), or an earlier agent's saved
   * one. `removed`: Workbench removed its folder (thrown away, or tidied with nothing in it). null when it has none
   * (the demo, a launch that never got a folder).
   */
  _workspaceOf(v) {
    const run = this.runs.get(v.id);
    if (run && run.workspace) return { ws: run.workspace, run, rec: null, removed: !!run.folderRemoved };
    const rec = v.earlier ? this.earlierRecs.get(v.id) : null;
    if (rec) return { ws: rec.workspace || null, run: null, rec, removed: !rec.workspace };
    return null;
  }

  /**
   * At work now: an active state, its receipt being built (it stays working meanwhile), or being picked up again.
   * A stopped or finished root is not, even if its last turn never reported its end.
   */
  _isWorking(v) {
    if (ACTIVE.has(v.state) || this._resuming.has(v.id)) return true;
    const run = this.runs.get(v.id);
    return !!(run && (run.deciding || run.receipt));
  }

  /** Why nothing else can happen to a root while its work is merged or thrown away. */
  _busyReply(v) {
    return this._busy.get(v.id) === 'discard' ? `${v.name}’s work is being thrown away now.` : `${v.name} is being merged now.`;
  }

  /** The view's work, or a blank one to build on. */
  _workNow(v) {
    const w = v?.work && typeof v.work === 'object' ? v.work : null;
    return w || { branch: null, from: null, folder: false, merged: null, problem: null, thrownAway: null };
  }

  /**
   * A merge that did not go through no longer describes the work (a turn starts, a message is taken, nothing is left to
   * merge): it goes. An earlier agent's saved record is written back as it was unless it is replaced, so it is, or the
   * reason would come back at the next start.
   */
  _clearProblem(agentId) {
    const v = this.store.get(agentId);
    if (!v || v.parentId || !v.work?.problem) return;
    this._apply([{ kind: EV.WORK, agentId, work: { ...v.work, problem: null } }]);
    const rec = v.earlier ? this.earlierRecs.get(agentId) : null;
    if (rec) this._replaceEarlier(agentId, rec.workspace ?? null);
  }

  /** Its folder turned out to be gone: its view says so. */
  _markFolderGone(v) {
    const w = v ? this.store.get(v.id)?.work : null;
    if (w && w.folder) this._apply([{ kind: EV.WORK, agentId: v.id, work: { ...w, folder: false } }]);
  }

  /**
   * Git says its folder and its branch are both gone: nothing of its work is left here. Its view says so, this run's
   * agent leaves the folders kept and the tidy, and an earlier agent's record keeps no folder from now on.
   */
  _markWorkGone(v, where) {
    if (where?.run) where.run.folderRemoved = true;
    const w = this.store.get(v.id)?.work;
    if (w && (w.folder || w.branch)) this._apply([{ kind: EV.WORK, agentId: v.id, work: { ...w, folder: false, branch: null } }]);
    if (where?.rec) {
      this._replaceEarlier(v.id, null);
      this.store.markContinue(v.id, { ok: false, reason: 'Its folder is gone, so it cannot continue.' });
    }
    try { this.history?.save(); } catch (err) { this.log.warn('Could not save the history:', err); }
  }

  /**
   * Why a root has no work here to show or merge, in plain words; null when it has. `verb`: 'show' or 'merge'.
   */
  _noWorkReply(v, verb) {
    if (v.work?.thrownAway) return `${v.name}’s work was thrown away, so there is nothing to ${verb}.`;
    const where = this._workspaceOf(v);
    if (!where?.ws || where.removed || !folderThere(where.ws.path)) {
      if (where?.ws && !where.removed) this._markFolderGone(v);
      return `Its folder is gone, so there is nothing to ${verb}.`;
    }
    if (!sinceOf(where.ws)) return `Workbench does not know which commit ${v.name} started from, so it cannot ${WORK_VERB[verb]}.`;
    return null;
  }

  /**
   * One git job at a time, engine-wide, whatever became of the one before: every merge touches the person's own folder,
   * and two at once would race for it. Shutdown waits for the jobs under way (_gitWork).
   */
  _gitJob(fn) {
    const job = this._gitChain.then(() => fn());
    this._gitChain = job.then(() => {}, () => {});
    this._gitWork.add(job);
    const done = () => this._gitWork.delete(job);
    job.then(done, done);
    return job;
  }

  /** The simulator, when it has this optional method (demo mode only). */
  _simWith(name) {
    const sim = this.mode === 'demo' ? this.adapters.sim : null;
    return sim && typeof sim[name] === 'function' ? sim : null;
  }

  // ---------------------------------------------------------------- what an agent changed

  /**
   * What a root changed that is not merged yet, as a diff for people to read (GET /api/agents/:id/changes). Read-only:
   * it takes no lock, posts no notice and works in any state. `live`: the agent is at work, so its work may still
   * change. A helper's id gives its agent's changes.
   * @returns {Promise<{ ok: true, agentId: string, name: string, branch: string|null, into: string|null, live: boolean, diff: object } | { ok: false, reply: string }>}
   */
  async changes(agentId) {
    const v = this._rootOf(String(agentId ?? ''));
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (this.mode === 'demo') return this._simChanges(v);
    const gone = this._noWorkReply(v, 'show');
    if (gone) return { ok: false, reply: gone };
    if (typeof this.deps.workspace?.workDiff !== 'function' || !this.repoInfo) return { ok: false, reply: 'Workbench cannot show changes right now.' };
    const ws = this._workspaceOf(v).ws;
    let diff;
    try {
      diff = await this.deps.workspace.workDiff({ repoRoot: this.repoInfo.root, path: ws.path, since: sinceOf(ws) });
    } catch (err) {
      this.log.warn(`Could not read the changes of ${v.id}:`, err);
      const t = gitRefusal(v, err, `Workbench could not read ${v.name}’s changes.`);
      if (t.gone) {
        this._markFolderGone(v);
        return { ok: false, reply: 'Its folder is gone, so there is nothing to show.' };
      }
      return { ok: false, reply: t.reply };
    }
    if (!diff || diff.ok === false || !Array.isArray(diff.files)) return { ok: false, reply: `Workbench could not read ${v.name}’s changes.` };
    const cur = this.store.get(v.id) || v;
    return { ok: true, agentId: v.id, name: cur.name, branch: ws.branch ?? null, into: this.repoInfo.branch ?? null, live: this._isWorking(cur), diff };
  }

  /** "what did search cleanup change": the page opens the git screen on that agent (`review`). */
  _reviewReply(v) {
    if (this.mode === 'demo') {
      if (!this._simWith('changes')) return { reply: 'This is the demo, so there are no real changes to show.', focusId: v.id };
    } else {
      const gone = this._noWorkReply(v, 'show');
      if (gone) return { reply: gone, focusId: v.id };
    }
    return { reply: `Here is what ${v.name} changed.`, review: v.id, focusId: v.id };
  }

  // ---------------------------------------------------------------- the git screen

  /**
   * The git screen's data (GET /api/git): the repository as it is now, its commits newest first (workspace.gitGraph),
   * and every root with a branch, this run's and earlier ones. Read-only. The demo shows the simulator's graph.
   * @returns {Promise<{ ok: true, repo: object, commits: object[], more: boolean, agents: object[] } | { ok: false, reply: string }>}
   */
  async gitGraph() {
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (this.mode === 'demo') return this._simGraph();
    if (typeof this.deps.workspace?.gitGraph !== 'function' || !this.repoInfo) return { ok: false, reply: 'Workbench cannot show the git history right now.' };
    try {
      await this._freshRepo(); // the uncommitted changes and the identity, as they are now
    } catch (err) {
      this.log.debug('Could not refresh the repo status:', err);
    }
    let g;
    try {
      g = await this.deps.workspace.gitGraph({ repoRoot: this.repoInfo.root });
    } catch (err) {
      this.log.warn('Could not read the git history:', err);
      g = null;
    }
    if (!g || g.ok === false || !Array.isArray(g.commits)) {
      // The git module words its own refusals plainly ("The repository at … has no commits yet."); anything else is ours.
      const said = g && g.ok === false && typeof g.sentence === 'string' && g.sentence.trim() ? g.sentence.trim() : null;
      return { ok: false, reply: said || 'Workbench could not read the git history.' };
    }
    const repo = this._repoView();
    // The head and branch the graph was read at, so the commits and the top band agree.
    if (typeof g.head === 'string' && g.head) repo.head = g.head;
    if (Object.hasOwn(g, 'branch')) repo.branch = typeof g.branch === 'string' && g.branch ? g.branch : null;
    return { ok: true, repo, commits: g.commits, more: !!g.more, agents: this._graphAgents() };
  }

  /** Every root with a branch, this run's and earlier ones: { id, name, state, earlier, harness, branch, from, base, since, files, work }. */
  _graphAgents() {
    const out = [];
    for (const v of this.store.list()) {
      if (v.parentId || v.work?.thrownAway) continue;
      const ws = this._workspaceOf(v)?.ws;
      const branch = v.work ? v.work.branch : ws?.branch;
      if (!ws || !branch) continue;
      out.push({
        id: v.id, name: v.name, state: v.state, earlier: !!v.earlier, harness: v.harness, branch,
        from: ws.from ?? v.work?.from ?? null, base: ws.base ?? null, since: sinceOf(ws), files: v.files ?? null, work: v.work ?? null,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- merge

  /**
   * Ask before merging a root's work into the person's branch (POST /api/agents/:id/merge): a confirm card, never a
   * merge by itself. `state`: the state the page drew the button for (null: not checked).
   * @returns {Promise<{ reply: string, confirm: object } | { ok: false, reply: string }>}
   */
  async proposeMerge(agentId, { state = null } = {}) {
    const out = await this._proposeMerge(this.store.get(String(agentId ?? '')), { state });
    if (!out.confirm) this._notice(out.reply, typeof agentId === 'string' ? agentId : null);
    return out;
  }

  /**
   * Why a root cannot be merged right now, as a refusal; null when it can, as far as Workbench knows before asking git.
   * `state`: the state the button or card was drawn for. `ownJob`: asked by the merge job itself, which holds the busy flag.
   */
  _mergeRefusal(v, { state = null, ownJob = false } = {}) {
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (v.parentId) return { ok: false, reply: 'Helpers work in their agent’s folder. Merge the agent instead.' };
    if (!ownJob && this._busy.has(v.id)) return { ok: false, reply: this._busyReply(v) };
    if (this._isWorking(v)) return { ok: false, reply: `${v.name} is still working. Merge it when it is done.` };
    if (state && state !== v.state) return { ok: false, reply: 'That changed. Have another look.' };
    if (this.mode === 'demo') return v.work?.thrownAway ? { ok: false, reply: `${v.name}’s work was thrown away, so there is nothing to merge.` } : null;
    const gone = this._noWorkReply(v, 'merge');
    return gone ? { ok: false, reply: gone } : null;
  }

  async _proposeMerge(v, { state = null, into = null } = {}) {
    // The demo merges only what its simulator can pretend to merge: before anything else, it says so.
    if (this.mode === 'demo' && !this._simWith('merge')) return { ok: false, reply: DEMO_NO_MERGE };
    const pre = this._mergeRefusal(v, { state });
    if (pre) return pre;
    if (this.mode === 'demo') return this._simProposeMerge(v, { state });
    const W = this.deps.workspace;
    if (typeof W?.snapshotWork !== 'function' || typeof W?.mergeWork !== 'function' || !this.repoInfo) {
      return { ok: false, reply: 'Workbench cannot merge work right now.' };
    }
    const where = this._workspaceOf(v);
    const ws = where.ws;
    let repo;
    try {
      repo = await this._freshRepo(); // the branch, head and uncommitted changes as they are now, never 15 s old
    } catch (err) {
      this.log.warn('Could not read the repository:', err);
      return { ok: false, reply: 'Workbench could not read your folder, so it cannot merge right now.' };
    }
    if (!repo?.branch) return { ok: false, reply: mergeSentence('detached') };
    if (into && into !== repo.branch) {
      return { ok: false, reply: `Workbench merges into the branch your folder is on, which is ${repo.branch}. Switch to ${quotable(into, 60)} first to merge there.` };
    }
    if (this.repoIdentity === false) return { ok: false, reply: mergeSentence('identity') };
    let snap = null;
    let trouble = null;
    try {
      snap = await W.snapshotWork({ repoRoot: repo.root, path: ws.path, since: sinceOf(ws) });
    } catch (err) {
      this.log.warn(`Could not read the work of ${v.id}:`, err);
      trouble = gitRefusal(v, err, `Workbench could not read ${v.name}’s work, so it cannot be merged right now.`);
    }
    // It may have moved on while git read it.
    const cur = this.store.get(v.id);
    const again = this._mergeRefusal(cur, { state });
    if (again) return again;
    if (trouble?.gone) {
      this._markFolderGone(cur);
      return { ok: false, reply: mergeSentence('gone') };
    }
    if (trouble) return { ok: false, reply: trouble.reply };
    if (!snap || snap.ok === false || typeof snap.workId !== 'string' || !snap.workId) {
      return { ok: false, reply: `Workbench could not read ${v.name}’s work, so it cannot be merged right now.` };
    }
    if (!snap.changed) {
      // Nothing to merge, so a reason a merge did not go through no longer says anything true ("Try again" settles it).
      this._clearProblem(v.id);
      // Nothing since its last merge is "already in"; an agent never merged that changed nothing changed nothing.
      return { ok: false, reply: cur.work?.merged ? mergeSentence('nothing', { name: v.name, into: repo.branch }) : `${v.name} changed nothing, so there is nothing to merge.` };
    }
    const files = Array.isArray(snap.files) ? snap.files : [];
    if (!files.length) {
      // Its work differs from where it started, but merging it would bring in nothing new: it is in the branch already
      // (merged by hand, or brought in some other way). Say so now, rather than ask about a merge of no files.
      this._clearProblem(v.id);
      return { ok: false, reply: mergeSentence('nothing', { name: v.name, into: repo.branch }) };
    }
    const broken = await this._brokenRules(cur, where, files);
    const detail = this._mergeDetail(cur, { files, left: snap.left, broken, into: repo.branch, dirty: repo.dirty });
    return this._newConfirm({
      kind: 'merge', agentId: v.id, state: cur.state,
      expect: { workId: snap.workId, into: repo.branch, intoHead: repo.head },
      sentence: `Merge ${v.name} into ${repo.branch}?`, detail, yes: 'Merge', no: 'Cancel', danger: false,
    });
  }

  /** The rules its work breaks now: workbench.json from the commit it started from, against the files it would merge. */
  async _brokenRules(v, where, files) {
    const paths = files.map(f => f?.path).filter(p => typeof p === 'string');
    try {
      const config = (where.run ? await where.run.config : await this._loadConfig(where.ws)) || DEFAULT_CONFIG;
      if (!Array.isArray(config.rules) || !config.rules.length) return [];
      if (typeof this.deps.receipt?.checkRules === 'function') {
        const r = await this.deps.receipt.checkRules(config.rules, paths);
        return Array.isArray(r?.broken) ? r.broken : [];
      }
    } catch (err) {
      this.log.warn('Could not check the rules:', err);
    }
    return Array.isArray(v.rules?.broken) ? v.rules.broken : [];
  }

  /** The merge card's detail: the counts first, then what the person should know before it merges. */
  _mergeDetail(v, { files, left, broken, into, dirty }) {
    const n = countFiles(files);
    const parts = [`${countsText(n.files, n.adds, n.dels)}. Its work becomes a commit on its branch, joined into ${into} by a merge commit.`];
    const checks = v.checks;
    if (checks?.state === 'failed') {
      const failed = (Array.isArray(checks.results) ? checks.results : []).filter(r => r && !r.ok).map(r => String(r.name));
      parts.push(failed.length > 1 ? `${failed.length} checks failed: ${joinAnd(failed)}.` : `A check failed: ${failed[0] || 'one of its checks'}.`);
    } else if (checks?.state !== 'passed') {
      parts.push('Nothing checked its work.');
    }
    const says = (Array.isArray(broken) ? broken : []).map(b => unend(b?.say)).filter(Boolean);
    if (says.length === 1) parts.push(`It broke a rule you set: ${says[0]}.`);
    else if (says.length > 1) parts.push(`It broke ${says.length} rules you set: ${joinAnd(says)}.`);
    // Files that change what later agents and Claude Code itself may do, once they are in the person's branch.
    const paths = files.map(f => String(f?.path ?? ''));
    if (paths.includes('workbench.json')) parts.push('It changes workbench.json, which sets the checks for later agents.');
    if (paths.some(p => /(^|\/)\.claude(\/|$)/i.test(p))) parts.push('It changes .claude/, which holds Claude Code’s settings for this repository.');
    if (paths.some(p => /(^|\/)\.mcp\.json$/i.test(p))) parts.push('It changes .mcp.json, which can give Claude Code new tools here.');
    const list = Array.isArray(left) ? left : [];
    const ignored = list.filter(l => l?.why === 'ignored').length;
    const nested = list.filter(l => l?.why === 'nested-repo').length;
    if (ignored) parts.push(`${ignored} file${ignored === 1 ? ' stays' : 's stay'} out: hidden by a .gitignore.`);
    if (nested) parts.push(nested === 1 ? '1 folder stays out: it is a git repository of its own.' : `${nested} folders stay out: each is a git repository of its own.`);
    const d = count(dirty);
    if (d) parts.push(`Your ${d} uncommitted change${d === 1 ? ' stays as it is' : 's stay as they are'}.`);
    return parts.join(' ');
  }

  /** Yes to a merge card: everything is checked again, then the merge runs as one git job, the agent busy throughout. */
  async _mergeConfirmed(c) {
    const v = this.store.get(c.agentId);
    if (c.demo) return this._simMerge(v, c);
    const pre = this._mergeRefusal(v, { state: c.state });
    if (pre) return { reply: pre.reply, ...(v ? { focusId: v.id } : {}) };
    if (typeof this.deps.workspace?.mergeWork !== 'function' || !this.repoInfo) return { reply: 'Workbench cannot merge work right now.', focusId: v.id };
    this._busy.set(v.id, 'merge');
    try {
      return await this._gitJob(() => this._runMerge(v.id, c));
    } finally {
      this._busy.delete(v.id);
    }
  }

  async _runMerge(id, c) {
    let v = this.store.get(id);
    const pre = this._mergeRefusal(v, { state: c.state, ownJob: true }); // again: it waited for the jobs before it
    if (pre) return { reply: pre.reply, focusId: id };
    const where = this._workspaceOf(v);
    const ws = where.ws;
    const run = where.run;
    // Nothing may write in its folder while git takes its work: close its idle process (and what it left running), and
    // let stopped checks end. It cannot start a turn by itself after this: _closeIdle marks it stopped first.
    await this._closeIdle(v);
    if (run?.checksDone) await run.checksDone;
    if (run && this._runnerInfo(run)?.alive === true) return { reply: `Workbench could not pause ${v.name}, so nothing was merged.`, focusId: id };
    v = this.store.get(id);
    const again = this._mergeRefusal(v, { state: c.state, ownJob: true });
    if (again) return { reply: again.reply, focusId: id };
    // The commit outlives the page: its words go through the mask too, for text kept from before a key was stored.
    // Masked before they are cut (a key the cut splits no longer matches), and again after.
    const m = this._mask || ((s) => s);
    let res;
    try {
      res = await this.deps.workspace.mergeWork({
        repoRoot: this.repoInfo.root, path: ws.path, branch: ws.branch, since: sinceOf(ws),
        expect: { workId: c.expect.workId, into: c.expect.into, intoHead: c.expect.intoHead },
        message: { subject: m(commitSubject(m(v.task), `Work by ${m(v.name)}`)), body: m(commitBody(m(v.says))), name: m(v.name) },
        agentId: v.id, harness: v.harness,
      });
    } catch (err) {
      this.log.error(`The merge of ${id} failed:`, err);
      res = { ok: false, why: 'git', unexpected: true };
    }
    // Whatever happened, read the person's folder again: its branch may have moved, and the page should hear of it.
    try {
      await this._freshRepo();
    } catch (err) {
      this.log.debug('Could not refresh the repo status:', err);
    }
    v = this.store.get(id) || v;
    return res?.ok === true ? this._merged(v, where, res, c) : this._mergeFailed(v, res, c);
  }

  /** The merge went through: record it, and count its work from the merged work commit (W) from now on. */
  _merged(v, where, res, c) {
    const into = (typeof res.into === 'string' && res.into) || c.expect.into;
    const W = typeof res.work === 'string' && res.work ? res.work : null;
    const files = Array.isArray(res.files) ? res.files.length : count(res.files);
    const merged = { into, merge: typeof res.merge === 'string' ? res.merge : null, at: this.now(), files, adds: count(res.adds), dels: count(res.dels) };
    if (W && where.run) where.run.workspace.since = W;
    if (!W) this.log.warn(`The merge of ${v.id} did not say which work commit it merged; its changes are still counted from before.`);
    this._apply([
      { kind: EV.WORK, agentId: v.id, work: { ...this._workNow(v), merged, problem: null } },
      { kind: EV.FILES, agentId: v.id, files: { ...NO_FILES, list: [] } }, // nothing is left unmerged
    ]);
    this._dropWorkCards(v.id);
    if (where.rec) {
      this._replaceEarlier(v.id, { ...where.rec.workspace, ...(W ? { since: W } : {}) });
      this._mergedEarlier.add(v.id);
    }
    try { this.history?.save(); } catch (err) { this.log.warn('Could not save the history:', err); }
    return { reply: `Merged ${v.name} into ${into}.`, focusId: v.id };
  }

  /**
   * Its work was just merged or thrown away: any other merge or throw-away card still out for it (another page's, say)
   * was drawn for work that is not there to merge or throw away any more. Withdraw them, so a yes to one hears that it
   * is no longer waiting, instead of being refused by git and leaving a reason on work that is fine.
   */
  _dropWorkCards(agentId) {
    for (const [id, c] of this.confirms) {
      if (c.agentId === agentId && (c.kind === 'merge' || c.kind === 'discard')) this.confirms.delete(id);
    }
  }

  /** The merge did not go through: say why, and keep the reason on the agent when it is worth acting on. */
  _mergeFailed(v, res, c) {
    const why = MERGE_WHYS.has(res?.why) ? res.why : 'git';
    // Its branch moved because this agent's own work went in after the card was drawn (from a look git took just
    // before that merge, say): what the card showed is in already, and nothing new is left to merge. Nothing went wrong.
    // Only when its files are known: when they could not be read, it may hold new work, and the reason stands.
    if (why === 'moved' && v.work?.merged && v.files && !unmergedWork(v)) {
      this._clearProblem(v.id);
      return { reply: mergeSentence('nothing', { name: v.name, into: v.work.merged.into || c.expect.into }), focusId: v.id };
    }
    const paths = (Array.isArray(res?.paths) ? res.paths : []).filter(p => typeof p === 'string' && p);
    const own = typeof res?.sentence === 'string' && res.sentence.trim() ? aboutAgent(v.name, res.sentence) : null;
    let sentence;
    if (res?.unexpected) sentence = 'Something went wrong during the merge. Have a look at your folder before you try again.';
    // For these the git module's own words say what really happened (a lock held by another git command; a merge git
    // reported done that the branch does not hold; what merging would bring in is no longer what the card showed; its
    // folder moved to another branch), where the general sentence would not be true.
    else if ((why === 'git' || why === 'busy' || why === 'changed') && own) sentence = own;
    else sentence = mergeSentence(why, { name: v.name, into: c.expect.into, paths });
    if (why === 'gone') {
      this._markFolderGone(v);
    } else if (why === 'nothing') {
      this._clearProblem(v.id); // already in (merged by hand, say): a reason from before no longer holds
    } else if (PROBLEM_WHYS.has(why)) {
      this._apply([{ kind: EV.WORK, agentId: v.id, work: { ...this._workNow(v), problem: { why, sentence, paths: paths.slice(0, 50), into: c.expect.into || null, at: this.now() } } }]);
    }
    return { reply: sentence, focusId: v.id };
  }

  // ---------------------------------------------------------------- throw away

  /**
   * Ask before throwing a root's work away (POST /api/agents/:id/discard): a confirm card. An agent at work is stopped
   * first, and the card says so. `state`: the state the page drew the button for (null: not checked).
   * @returns {Promise<{ reply: string, confirm: object } | { ok: false, reply: string }>}
   */
  async proposeDiscard(agentId, { state = null } = {}) {
    const out = await this._proposeDiscard(this.store.get(String(agentId ?? '')), { state });
    if (!out.confirm) this._notice(out.reply, typeof agentId === 'string' ? agentId : null);
    return out;
  }

  /**
   * Why a root's work cannot be thrown away right now; null when it can. A root whose folder is gone can still have its
   * branch thrown away.
   */
  _discardRefusal(v, { state = null, ownJob = false } = {}) {
    if (!v) return { ok: false, reply: 'I can’t find that agent.' };
    if (this._shuttingDown) return { ok: false, reply: 'Workbench is shutting down.' };
    if (v.parentId) return { ok: false, reply: 'Helpers work in their agent’s folder. Throw away the agent’s work instead.' };
    if (!ownJob && this._busy.has(v.id)) return { ok: false, reply: this._busyReply(v) };
    if (this._resuming.has(v.id)) return { ok: false, reply: `${v.name} is already being picked up.` };
    if (state && state !== v.state) return { ok: false, reply: 'That changed. Have another look.' };
    if (v.work?.thrownAway) return { ok: false, reply: `${v.name}’s work was already thrown away.` };
    if (this.mode === 'demo') return null;
    const where = this._workspaceOf(v);
    if (!where?.ws || where.removed) return { ok: false, reply: 'Its folder is gone, so there is nothing to throw away.' };
    const there = folderThere(where.ws.path);
    if (!there) this._markFolderGone(v);
    if (!where.ws.branch) {
      return { ok: false, reply: there ? `Workbench does not know ${v.name}’s branch, so it cannot throw its work away.` : 'Its folder is gone, so there is nothing to throw away.' };
    }
    if (there && !sinceOf(where.ws)) return { ok: false, reply: `Workbench does not know which commit ${v.name} started from, so it cannot ${WORK_VERB['throw away']}.` };
    return null;
  }

  async _proposeDiscard(v, { state = null } = {}) {
    if (this.mode === 'demo' && !this._simWith('discard')) return { ok: false, reply: DEMO_NO_DISCARD };
    const pre = this._discardRefusal(v, { state });
    if (pre) return pre;
    if (this.mode === 'demo') return this._simProposeDiscard(v, { state });
    const W = this.deps.workspace;
    if (typeof W?.snapshotWork !== 'function' || typeof W?.discardWork !== 'function' || !this.repoInfo) {
      return { ok: false, reply: 'Workbench cannot throw away work right now.' };
    }
    const ws = this._workspaceOf(v).ws;
    const card = { kind: 'discard', agentId: v.id, sentence: `Throw away ${v.name}’s work?`, yes: 'Throw it away', no: 'Keep it', danger: true };
    if (!folderThere(ws.path)) {
      // Its folder is gone, but its branch may still hold work: the throw-away deletes the branch, keeping a copy.
      const active = this._isWorking(v);
      const parts = [`Its folder is already gone. Its branch ${ws.branch} is deleted. Workbench keeps a hidden copy in git.`];
      if (active) parts.push('It is still working: it will be stopped first.');
      return this._newConfirm({ ...card, state: v.state, active, folderGone: true, expect: { workId: null }, detail: parts.join(' ') });
    }
    let snap = null;
    let trouble = null;
    try {
      snap = await W.snapshotWork({ repoRoot: this.repoInfo.root, path: ws.path, since: sinceOf(ws) });
    } catch (err) {
      this.log.warn(`Could not read the work of ${v.id}:`, err);
      trouble = gitRefusal(v, err, `Workbench could not read ${v.name}’s work, so nothing was thrown away.`);
    }
    const cur = this.store.get(v.id);
    const again = this._discardRefusal(cur, { state });
    if (again) return again;
    if (trouble?.gone) return { ok: false, reply: 'Its folder is gone, so there is nothing to throw away.' };
    if (trouble) return { ok: false, reply: trouble.reply };
    if (!snap || snap.ok === false || typeof snap.workId !== 'string' || !snap.workId) {
      return { ok: false, reply: `Workbench could not read ${v.name}’s work, so nothing was thrown away.` };
    }
    const n = Array.isArray(snap.files) ? snap.files.length : 0;
    const active = this._isWorking(cur);
    const parts = [`Its folder and its branch ${ws.branch} are deleted, with ${n ? `${n} changed file${n === 1 ? '' : 's'}` : 'no changed files'}. Workbench keeps a hidden copy in git.`];
    const left = leftOutWords(snap.left);
    if (left) parts.push(left);
    if (active) parts.push('It is still working: it will be stopped first.');
    return this._newConfirm({ ...card, state: cur.state, active, expect: { workId: snap.workId }, detail: parts.join(' ') });
  }

  /** Yes to a throw-away card: everything is checked again; it runs as one git job, the agent busy throughout. */
  async _discardConfirmed(c) {
    const v = this.store.get(c.agentId);
    if (c.demo) return this._simDiscard(v, c);
    // A card made while it worked said it would be stopped first: its state then is no promise. Otherwise it is.
    const pre = this._discardRefusal(v, { state: c.active ? null : c.state });
    if (pre) return { reply: pre.reply, ...(v ? { focusId: v.id } : {}) };
    // The card said whether it was working. One that went back to work since was not described: look again.
    if (!c.active && this._isWorking(v)) return { reply: 'That changed. Have another look.', focusId: v.id };
    if (typeof this.deps.workspace?.discardWork !== 'function' || !this.repoInfo) return { reply: 'Workbench cannot throw away work right now.', focusId: v.id };
    this._busy.set(v.id, 'discard');
    try {
      return await this._gitJob(() => this._runDiscard(v.id, c));
    } finally {
      this._busy.delete(v.id);
    }
  }

  async _runDiscard(id, c) {
    let v = this.store.get(id);
    const pre = this._discardRefusal(v, { state: c.active ? null : c.state, ownJob: true });
    if (pre) return { reply: pre.reply, focusId: id };
    const where = this._workspaceOf(v);
    const ws = where.ws;
    const run = where.run;
    // Nothing may write in its folder while it goes: stop it (as the card said) or close its idle process, and let
    // stopped checks end. Stopping it says no to its held requests, its helpers' too.
    if (this._isWorking(v)) {
      if (!c.active) return { reply: 'That changed. Have another look.', focusId: id };
      await this._stopRoot(v, 'Stopped by you');
    } else {
      await this._closeIdle(v);
    }
    if (run?.checksDone) await run.checksDone;
    // A process that will not stop may still be writing there: its folder stays.
    if (run && this._runnerInfo(run)?.alive === true) return { reply: `Workbench could not stop ${v.name}, so its work was not thrown away.`, focusId: id };
    v = this.store.get(id) || v;
    const again = this._discardRefusal(v, { ownJob: true });
    if (again) return { reply: again.reply, focusId: id };
    // The card said whether its folder was there; what goes is what it said.
    const there = folderThere(ws.path);
    if (!!c.folderGone === there) return { reply: 'That changed. Have another look.', focusId: id };
    const W = this.deps.workspace;
    let expect = { workId: c.expect.workId ?? null };
    if (c.active && there) {
      // The card was made while it worked and said it would be stopped first: what it holds once stopped is what goes
      // (into the hidden copy).
      let snap = null;
      try {
        snap = await W.snapshotWork({ repoRoot: this.repoInfo.root, path: ws.path, since: sinceOf(ws) });
      } catch (err) {
        this.log.warn(`Could not read the work of ${id}:`, err);
      }
      if (!snap || snap.ok === false || typeof snap.workId !== 'string' || !snap.workId) {
        return { reply: `Workbench could not read ${v.name}’s work, so nothing was thrown away.`, focusId: id };
      }
      expect = { workId: snap.workId };
    }
    let res;
    try {
      res = await W.discardWork({ repoRoot: this.repoInfo.root, path: ws.path, branch: ws.branch, since: sinceOf(ws), expect, agentId: id });
    } catch (err) {
      this.log.error(`Throwing away the work of ${id} failed:`, err);
      res = { ok: false, why: 'git', unexpected: true };
    }
    v = this.store.get(id) || v;
    if (res?.ok === true) return this._thrownAway(v, where, res);
    const own = typeof res?.sentence === 'string' && res.sentence.trim() ? aboutAgent(v.name, res.sentence) : null;
    let reply;
    if (res?.unexpected) reply = `Something went wrong while throwing away ${v.name}’s work. The details are in the log.`;
    else if (own) reply = own; // the git module's own plain words
    else if (res?.why === 'changed') reply = `${v.name}’s work changed since you looked. Have another look.`;
    else if (res?.why === 'gone') reply = 'Its folder and its branch are already gone.';
    else reply = `Git could not throw away ${v.name}’s work. Nothing was deleted.`;
    if (res?.why === 'gone') this._markWorkGone(v, where); // nothing of it is left to throw away
    else if (!folderThere(ws.path)) this._markFolderGone(v); // a failure part-way may have taken the folder already
    return { reply, focusId: id };
  }

  /** Its work is thrown away: its folder and branch are gone, and a hidden ref keeps a copy. */
  _thrownAway(v, where, res) {
    const saved = typeof res.saved === 'string' && res.saved ? res.saved : null;
    if (where.run) where.run.folderRemoved = true; // out of keptFolders and the tidy; follow-ups are refused
    this._apply([{ kind: EV.WORK, agentId: v.id, work: { ...this._workNow(v), branch: null, folder: false, problem: null, thrownAway: { at: this.now(), saved } } }]);
    this._dropWorkCards(v.id);
    if (where.rec) {
      this._replaceEarlier(v.id, null); // its record keeps no folder from now on
      this.store.markContinue(v.id, { ok: false, reason: THROWN_REASON });
    }
    try { this.history?.save(); } catch (err) { this.log.warn('Could not save the history:', err); }
    return { reply: `Threw away ${v.name}’s work. Its folder and branch are gone.`, focusId: v.id };
  }

  // ---------------------------------------------------------------- the demo (the simulator's optional methods)
  // The simulator answers in its own words and sends the same events as a real merge or throw-away (agent.work,
  // agent.files). Events for an agent the engine stopped are filtered, so whatever it did not record, the engine does.

  /** The demo's branch for an agent's work: where it was merged, where it started, else main. */
  _demoInto(v) {
    return v.work?.merged?.into || v.work?.from || 'main';
  }

  /** A demo agent's work, or one to build on (a seeded agent the simulator gave none). */
  _demoWork(v, into) {
    return v.work && typeof v.work === 'object' ? v.work : { branch: null, from: into, folder: true, merged: null, problem: null, thrownAway: null };
  }

  /** The counts a demo card shows: from the simulator's answer, else from the agent's own card. */
  _demoCounts(res, v) {
    const f = res?.files;
    if (Array.isArray(f)) return countFiles(f);
    if (f && typeof f === 'object') return { files: count(f.changed ?? f.files), adds: count(f.adds), dels: count(f.dels) };
    if (f != null && Number.isFinite(Number(f))) return { files: count(f), adds: count(res.adds), dels: count(res.dels) };
    const vf = v.files;
    return vf ? { files: count(vf.changed), adds: count(vf.adds), dels: count(vf.dels) } : { files: 0, adds: 0, dels: 0 };
  }

  /** A sentence the simulator gave (reply or sentence), else null. */
  _simSaid(res) {
    if (typeof res?.reply === 'string' && res.reply.trim()) return res.reply.trim();
    if (typeof res?.sentence === 'string' && res.sentence.trim()) return res.sentence.trim();
    return null;
  }

  async _simChanges(v) {
    const sim = this._simWith('changes');
    if (!sim) return { ok: false, reply: 'This is the demo, so there are no real changes to show.' };
    let res;
    try {
      res = await sim.changes(v.id);
    } catch (err) {
      this.log.warn('The simulator could not show changes:', err);
      res = null;
    }
    // The simulator answers with a diff (workDiff's shape), or with { diff, branch?, into? }.
    const diff = res && Array.isArray(res.files) ? res : (res?.diff && Array.isArray(res.diff.files) ? res.diff : null);
    if (!diff) return { ok: false, reply: this._simSaid(res) || `The demo has no changes to show for ${v.name}.` };
    const cur = this.store.get(v.id) || v;
    return { ok: true, agentId: v.id, name: cur.name, branch: res.branch ?? cur.work?.branch ?? null, into: res.into ?? this._demoInto(cur), live: this._isWorking(cur), diff };
  }

  async _simGraph() {
    const sim = this._simWith('gitGraph');
    if (!sim) return { ok: false, reply: 'This is the demo, so there is no git history to show.' };
    let g;
    try {
      // The views give the state, name and work the person sees.
      g = await sim.gitGraph({ views: (id) => this.store.get(id) });
    } catch (err) {
      this.log.warn('The simulator could not draw its git history:', err);
      g = null;
    }
    if (!g || g.ok === false || !Array.isArray(g.commits)) return { ok: false, reply: this._simSaid(g) || 'The demo could not show its git history.' };
    // The simulator answers in the engine's shape ({ repo, commits, more, agents }) or in workspace.gitGraph's
    // ({ head, branch, commits, more }).
    const r = g.repo && typeof g.repo === 'object' ? g.repo : {};
    const repo = {
      name: r.name ?? g.name ?? 'demo',
      branch: r.branch !== undefined ? r.branch : (g.branch !== undefined ? g.branch : 'main'),
      head: r.head ?? g.head ?? g.commits[0]?.id ?? null,
      dirty: count(r.dirty),
      identity: r.identity !== false,
    };
    const agents = Array.isArray(g.agents) ? g.agents : this.store.list()
      .filter(v => !v.parentId && v.work?.branch && !v.work.thrownAway)
      .map(v => ({ id: v.id, name: v.name, state: v.state, earlier: !!v.earlier, harness: v.harness, branch: v.work.branch, from: v.work.from ?? null, base: null, since: null, files: v.files ?? null, work: v.work }));
    return { ok: true, repo, commits: g.commits, more: !!g.more, agents };
  }

  async _simProposeMerge(v, { state = null } = {}) {
    const sim = this._simWith('merge');
    if (!sim) return { ok: false, reply: DEMO_NO_MERGE };
    let res = null;
    if (typeof sim.proposeMerge === 'function') {
      try {
        res = await sim.proposeMerge(v.id, { state, view: this.store.get(v.id) });
      } catch (err) {
        this.log.warn('The simulator could not propose a merge:', err);
        return { ok: false, reply: `The demo could not merge ${v.name}.` };
      }
      if (res && res.ok === false) return { ok: false, reply: this._simSaid(res) || DEMO_NO_MERGE };
      const again = this._mergeRefusal(this.store.get(v.id), { state });
      if (again) return again;
    }
    const cur = this.store.get(v.id) || v;
    const shown = res?.confirm && typeof res.confirm === 'object' ? res.confirm : {};
    const bound = res?.expect && typeof res.expect === 'object' ? res.expect : null;
    const into = (typeof bound?.into === 'string' && bound.into) || (typeof res?.into === 'string' && res.into) || this._demoInto(cur);
    const n = this._demoCounts(res, cur);
    const detail = (typeof shown.detail === 'string' && shown.detail) || (typeof res?.detail === 'string' && res.detail)
      || `${countsText(n.files, n.adds, n.dels)}. Its work becomes a commit on its branch, joined into ${into} by a merge commit. This is the demo, so nothing is really merged.`;
    return this._newConfirm({
      kind: 'merge', demo: true, agentId: v.id, state: cur.state, expect: bound ? { ...bound, into } : { into },
      sentence: `Merge ${cur.name} into ${into}?`, detail, yes: 'Merge', no: 'Cancel', danger: false,
    });
  }

  async _simMerge(v, c) {
    const pre = this._mergeRefusal(v, { state: c.state });
    if (pre) return { reply: pre.reply, ...(v ? { focusId: v.id } : {}) };
    const sim = this._simWith('merge');
    if (!sim) return { reply: DEMO_NO_MERGE, focusId: v.id };
    this._busy.set(v.id, 'merge');
    try {
      const before = { work: v.work, files: v.files };
      const counts = this._demoCounts(null, v);
      let res;
      try {
        res = await sim.merge(v.id, { expect: c.expect || null, view: this.store.get(v.id) });
      } catch (err) {
        this.log.warn('The simulator could not merge:', err);
        return { reply: `The demo could not merge ${v.name}.`, focusId: v.id };
      }
      const cur = this.store.get(v.id) || v;
      // The simulator may record the outcome itself, with the same events: then it is not recorded twice.
      const workRecorded = cur.work !== before.work;
      const into = (typeof res?.into === 'string' && res.into) || c.expect?.into || this._demoInto(cur);
      if (res && res.ok === false) {
        // A refusal with no reason given (it cannot merge that agent) is only passed on; a merge that did not go
        // through is kept on the agent, as in live mode.
        if (!MERGE_WHYS.has(res.why)) return { reply: this._simSaid(res) || `The demo could not merge ${cur.name}.`, focusId: cur.id };
        const paths = (Array.isArray(res.paths) ? res.paths : []).filter(p => typeof p === 'string' && p);
        const sentence = mergeSentence(res.why, { name: cur.name, into, paths });
        if (!workRecorded && PROBLEM_WHYS.has(res.why)) {
          this._apply([{ kind: EV.WORK, agentId: cur.id, work: { ...this._demoWork(cur, into), problem: { why: res.why, sentence, paths, into: into || null, at: this.now() } } }]);
        }
        return { reply: (typeof res.reply === 'string' && res.reply.trim()) || `${sentence} ${DEMO_MERGED}`, focusId: cur.id };
      }
      const n = res && (res.files != null) ? this._demoCounts(res, cur) : counts;
      const batch = [];
      if (!workRecorded) {
        const merged = { into, merge: typeof res?.merge === 'string' ? res.merge : null, at: this.now(), files: n.files, adds: n.adds, dels: n.dels };
        batch.push({ kind: EV.WORK, agentId: cur.id, work: { ...this._demoWork(cur, into), merged, problem: null } });
      }
      if (cur.files === before.files) batch.push({ kind: EV.FILES, agentId: cur.id, files: { ...NO_FILES, list: [] } });
      if (batch.length) this._apply(batch);
      this._dropWorkCards(cur.id);
      return { reply: (typeof res?.reply === 'string' && res.reply.trim()) || `Merged ${cur.name} into ${into}. ${DEMO_MERGED}`, focusId: cur.id };
    } finally {
      this._busy.delete(v.id);
    }
  }

  async _simProposeDiscard(v, { state = null } = {}) {
    const sim = this._simWith('discard');
    if (!sim) return { ok: false, reply: DEMO_NO_DISCARD };
    let res = null;
    if (typeof sim.proposeDiscard === 'function') {
      try {
        res = await sim.proposeDiscard(v.id, { state, view: this.store.get(v.id) });
      } catch (err) {
        this.log.warn('The simulator could not propose a throw-away:', err);
        return { ok: false, reply: `The demo could not throw away ${v.name}’s work.` };
      }
      if (res && res.ok === false) return { ok: false, reply: this._simSaid(res) || DEMO_NO_DISCARD };
      const again = this._discardRefusal(this.store.get(v.id), { state });
      if (again) return again;
    }
    const cur = this.store.get(v.id) || v;
    const active = this._isWorking(cur);
    const shown = res?.confirm && typeof res.confirm === 'object' ? res.confirm : {};
    let detail = typeof shown.detail === 'string' && shown.detail ? shown.detail : null;
    if (!detail) {
      const n = count(cur.files?.changed);
      const branch = cur.work?.branch;
      const parts = [`Its folder and ${branch ? `its branch ${branch}` : 'its branch'} are deleted, with ${n ? `${n} changed file${n === 1 ? '' : 's'}` : 'no changed files'}. Workbench keeps a hidden copy in git. This is the demo, so nothing is really thrown away.`];
      if (active) parts.push('It is still working: it will be stopped first.');
      detail = parts.join(' ');
    }
    return this._newConfirm({
      kind: 'discard', demo: true, agentId: v.id, state: cur.state, active, expect: res?.expect && typeof res.expect === 'object' ? { ...res.expect } : {},
      sentence: `Throw away ${cur.name}’s work?`, detail, yes: 'Throw it away', no: 'Keep it', danger: true,
    });
  }

  async _simDiscard(v, c) {
    const pre = this._discardRefusal(v, { state: c.active ? null : c.state });
    if (pre) return { reply: pre.reply, ...(v ? { focusId: v.id } : {}) };
    if (!c.active && this._isWorking(v)) return { reply: 'That changed. Have another look.', focusId: v.id };
    const sim = this._simWith('discard');
    if (!sim) return { reply: DEMO_NO_DISCARD, focusId: v.id };
    this._busy.set(v.id, 'discard');
    try {
      if (this._isWorking(v)) await this._stopRoot(v, 'Stopped by you');
      const before = this.store.get(v.id)?.work;
      let res;
      try {
        // A card made while it worked binds to nothing: what it holds once stopped is what goes.
        res = await sim.discard(v.id, { expect: c.active ? null : (c.expect || null), view: this.store.get(v.id) });
      } catch (err) {
        this.log.warn('The simulator could not throw work away:', err);
        return { reply: `The demo could not throw away ${v.name}’s work.`, focusId: v.id };
      }
      if (res && res.ok === false) return { reply: this._simSaid(res) || `The demo could not throw away ${v.name}’s work.`, focusId: v.id };
      const cur = this.store.get(v.id) || v;
      if (cur.work === before) {
        const thrownAway = { at: this.now(), saved: typeof res?.saved === 'string' ? res.saved : null };
        this._apply([{ kind: EV.WORK, agentId: cur.id, work: { ...this._demoWork(cur, this._demoInto(cur)), branch: null, folder: false, problem: null, thrownAway } }]);
      }
      this._dropWorkCards(cur.id);
      return { reply: (typeof res?.reply === 'string' && res.reply.trim()) || `Threw away ${cur.name}’s work. ${DEMO_THROWN}`, focusId: cur.id };
    } finally {
      this._busy.delete(v.id);
    }
  }

  // ================================================================ commands and confirms

  /**
   * Plain-language command from the bar at the bottom (typed or spoken). Launches need a confirm, and so do stops and
   * messages whose words found the agent without naming it.
   * The page sends what it showed when the person began: `focusId`, the agent in the centre; `confirmId`, the confirm
   * card on screen; `askId`, the ask on screen. A yes or no settles only that confirm, and an answer (allow, deny,
   * free text) reaches only that ask. Commands (stop, tell, status, start, ...) act on what the words and the focus
   * name, even when the ask on screen has changed since.
   */
  async command(text, { focusId = null, confirmId = null, askId = null } = {}) {
    const t = String(text ?? '').trim();
    let out;
    if (!t) {
      out = { reply: 'Type or say what you would like to do.' };
    } else if (this._looksLikeKey(t)) {
      // A key typed into the board goes nowhere: it is not read, kept, logged or quoted back, and the page opens Agents
      // & keys. A card on screen stays, as for words not caught.
      const shown = this._shownConfirm(confirmId);
      out = { reply: SECRET_REFUSED, openConnect: true, ...(shown && !shown.gone ? { confirm: this._card(shown) } : {}) };
    } else {
      const ctx = this._commandContext(focusId, confirmId);
      const shown = ctx.pendingConfirm;
      let intent = null;
      try {
        if (typeof this.deps.commands?.parseCommand === 'function') intent = await this.deps.commands.parseCommand(t, ctx);
      } catch (err) {
        this.log.warn('Could not understand a command:', err);
      }
      if (!intent || typeof intent !== 'object') intent = { kind: 'unknown', text: t };
      if (shown && intent.kind === 'unknown') {
        // A near miss ("yes start the agent") keeps the card in the centre, so saying "yes" again still answers it,
        // and not whatever would have taken its place.
        out = shown.gone
          ? { reply: GONE }
          : { reply: `I did not catch that. Say “do it” to ${confirmVerb(shown)}, or “cancel”.`, confirm: this._card(shown) };
      } else {
        // Any other command withdraws the card on screen, without a notice: the page lets go of it. A look at an
        // agent's changes does not: it is read-only, so the card keeps waiting, and the reply carries it, as for words
        // not caught, so the page keeps it too ("show me the changes" before saying yes to a merge).
        const keep = intent.kind === 'changes' && shown && !shown.gone;
        if (shown && !shown.gone && intent.kind !== 'confirm' && !keep) this.confirms.delete(shown.id);
        try {
          // With a card on screen, no ask was: the centre shows one thing at a time.
          out = await this._runIntent(intent, { focusId, askId: shown ? null : askId, shown });
        } catch (err) {
          this.log.error('A command failed:', err);
          out = { reply: err?.plain ? err.message : 'Something went wrong while doing that. The details are in the log.' };
        }
        const kept = keep ? this.confirms.get(shown.id) : null;
        if (kept) out = { ...out, confirm: this._card(kept) };
      }
    }
    if (out.reply && !out.confirm) this._notice(out.reply, out.focusId || null);
    return out;
  }

  _commandContext(focusId, confirmId = null) {
    return {
      agents: this.store.list(),
      focusId: focusId || null,
      machines: this.store.machines(),
      harnesses: this._harnessFlags(),
      pendingConfirm: this._shownConfirm(confirmId),
      // The person's repository as the page shows it ({ name, head, branch, dirty, identity }; null in the demo), so
      // "merge it into main" can be read against the branch a merge goes into.
      repo: this._repoView(),
    };
  }

  /**
   * The confirm the page says it shows. Never "the latest one": a card the person no longer sees must not catch a
   * "yes" or a "stop" meant for an agent. One that has run out still counts as shown, so "yes" to it hears that it
   * is no longer waiting instead of reaching something else.
   */
  _shownConfirm(confirmId) {
    const id = typeof confirmId === 'string' ? confirmId : '';
    if (!id) return null;
    const c = this.confirms.get(id);
    if (!c || this.now() - c.createdAt > this.options.confirmTtlMs) return { id, gone: true };
    const agentIds = c.agentIds ?? c.intent?.agentIds ?? (c.agentId ? [c.agentId] : undefined);
    return {
      id: c.id, kind: c.kind, sentence: c.sentence, detail: c.detail, tasks: c.tasks, agentIds,
      ...(c.agentId ? { agentId: c.agentId } : {}),
      ...(c.yes ? { yes: c.yes } : {}), ...(c.no ? { no: c.no } : {}), ...(typeof c.danger === 'boolean' ? { danger: c.danger } : {}),
    };
  }

  /**
   * The card the page shows: { id, sentence, detail, kind, yes?, no?, danger?, agentId? }. `kind` is always there (start,
   * stop, say, forget, merge or discard); yes and no are the buttons' own words when they are not "Do it" and "Cancel";
   * agentId (merge and discard cards only) is the agent the card is about.
   */
  _card(c) {
    const out = { id: c.id, sentence: c.sentence, detail: c.detail ?? null, kind: c.kind };
    if (c.yes) out.yes = c.yes;
    if (c.no) out.no = c.no;
    if (typeof c.danger === 'boolean') out.danger = c.danger;
    // a merge or throw-away card names the agent it is about, so the git screen can show it in that agent's detail
    if ((c.kind === 'merge' || c.kind === 'discard') && typeof c.agentId === 'string' && c.agentId) out.agentId = c.agentId;
    return out;
  }

  /** Keep a confirm card for its yes or no, and the reply that shows it. */
  _newConfirm(fields) {
    const id = hex(6);
    const c = { ...fields, id, createdAt: this.now() };
    this.confirms.set(id, c);
    return { reply: c.sentence, confirm: this._card(c) };
  }

  async _runIntent(intent, { focusId = null, askId = null, shown = null } = {}) {
    const get = (id) => (id ? this.store.get(id) : null);
    switch (intent.kind) {
      case 'start':
        // "start an agent" with no task comes as { kind: 'start', tasks: [], task: null, harness }: the reply asks what
        // to work on, naming the agent the words named ("start codex"), or says why that one cannot start.
        return this._proposeStart(Array.isArray(intent.tasks) ? intent.tasks
          : intent.task ? [{ task: intent.task, harness: intent.harness, machine: intent.machine }] : [], intent.harness);
      case 'task':
        return this._proposeStart([{ task: intent.task, harness: intent.harness, machine: intent.machine }]);
      case 'help': {
        // The parser's own words for it when it has them (commands.mjs HELP_REPLY), else the same words kept here.
        const words = this.deps.commands?.HELP_REPLY;
        return { reply: typeof words === 'string' && words.trim() ? words.trim() : HELP_REPLY };
      }
      case 'connect':
        // "connect", "add a key", "sign in", "agents": the page opens Agents & keys.
        return { reply: CONNECT_REPLY, openConnect: true };
      case 'answer':
      case 'allow':
      case 'deny': {
        const target = intent.kind === 'answer' ? { v: get(intent.agentId || focusId) } : this._permissionTarget(intent.agentId || focusId);
        const v = target.v;
        if (!v) return { reply: target.reply || 'Which agent is that for?' };
        // Words answer only the ask that was on screen when the person began: its id comes with them, and it must be
        // the ask the words were read against. Otherwise nothing is answered and the request keeps waiting.
        const named = this._askFor(v, askId);
        if (named.reply) return { reply: named.reply, focusId: v.id };
        const ask = named.ask;
        if (!ask) return { reply: `${v.name} is not waiting for an answer.`, focusId: v.id };
        if (intent.askId && intent.askId !== ask.id) return { reply: `${v.name} is asking something else now. Have a look, then answer again.`, focusId: v.id };
        let r;
        if (ask.type === 'permission') {
          // "yes" allows; "no, use the staging database" and "yes but only in the tests folder" say no with the words.
          r = intent.kind === 'allow'
            ? await this._answerPermission(v, ask, { allow: true })
            : await this._answerPermission(v, ask, { allow: false, words: intent.text, conditional: !!intent.conditional });
        } else if (intent.kind === 'answer') {
          r = await this._answerAsk(v, ask, String(intent.text ?? '').trim());
        } else {
          r = { reply: `${v.name} is not asking for your OK.` };
        }
        return { reply: r.reply, focusId: v.id };
      }
      case 'stop': {
        const views = (intent.agentIds || []).map(get).filter(Boolean);
        if (!views.length) return { reply: 'I couldn’t tell which agent to stop.' };
        // Found by its task or state words, or one loose word, not by its name: ask first ("Stop Flaky test?").
        if (intent.sure === false) return this._proposeIntent({ kind: 'stop', agentIds: views.map(v => v.id) });
        const replies = [];
        for (const v of views) replies.push((await this._stop(v)).reply);
        return { reply: replies.join(' '), ...(views.length === 1 ? { focusId: views[0].id } : {}) };
      }
      case 'forget': {
        const views = (intent.agentIds || []).map(get).filter(Boolean);
        if (!views.length) return { reply: 'I couldn’t tell which agent to forget.' };
        return this._proposeForget(views);
      }
      case 'continue': {
        const v = get(intent.agentId || focusId);
        if (!v) return { reply: 'Which agent should I continue?' };
        const r = await this._say(v, CONTINUE_TEXT);
        return { reply: r.reply, focusId: v.id };
      }
      // Merge, throw away and "what changed" act only on the agent the words named (the parser maps a pronoun to the
      // agent in the centre, and a helper to its agent). No agent: two have that name, or none was named. Ask.
      case 'changes': {
        const v = this._rootOf(intent.agentId);
        if (!v) return { reply: WHICH_ONE };
        return this._reviewReply(v);
      }
      case 'merge': {
        const v = this._rootOf(intent.agentId);
        if (!v) return { reply: WHICH_ONE };
        const r = await this._proposeMerge(v, { into: typeof intent.into === 'string' && intent.into.trim() ? intent.into.trim() : null });
        return r.confirm ? r : { reply: r.reply, focusId: v.id };
      }
      case 'discard': {
        const v = this._rootOf(intent.agentId);
        if (!v) return { reply: WHICH_ONE };
        const r = await this._proposeDiscard(v);
        return r.confirm ? r : { reply: r.reply, focusId: v.id };
      }
      case 'stop_all': {
        // An agent whose work is being merged or thrown away is left to that job (a throw-away stops it itself).
        const active = this.store.list().filter(v => !v.parentId && ACTIVE.has(v.state) && !this._busy.has(v.id));
        if (!active.length) return { reply: 'Nothing is running.' };
        await Promise.all(active.map(v => this._stopRoot(v, 'Stopped by you')));
        return { reply: active.length === 1 ? `Stopped ${active[0].name}.` : `Stopped all ${active.length} agents.` };
      }
      case 'say': {
        const v = get(intent.agentId || focusId);
        if (!v) return { reply: 'Which agent should I tell?' };
        const words = String(intent.text ?? '').trim();
        // Found without its name, or with no clear break before the message: ask first ("Tell Flaky test “…”?").
        if (intent.sure === false) return this._proposeIntent({ kind: 'say', agentId: v.id, text: words });
        // The yes to a card made before a key was stored: words that hold it now go nowhere, as in say().
        if (this._looksLikeKey(words)) return { reply: SECRET_REFUSED, openConnect: true };
        const r = await this._say(v, words);
        return { reply: r.reply, focusId: v.id };
      }
      case 'status':
        return this._status(intent.agentId || null);
      case 'spend':
        return { reply: this._spendSentence() };
      case 'sleep':
      case 'wake': {
        const ids = intent.machineIds || [];
        if (!ids.length) return { reply: 'Which machine?' };
        const replies = [];
        for (const id of ids) replies.push((await this._setMachineAwake(id, intent.kind === 'wake')).reply);
        return { reply: replies.join(' ') };
      }
      case 'sleep_idle':
        return this._sleepIdle();
      case 'confirm': {
        // Only the card on screen: never "the latest one".
        if (!shown) return { reply: 'There is nothing waiting for a yes or no.' };
        const r = await this._confirm(shown.id, !!intent.go);
        // A typed or spoken yes that started agents puts the first one in the centre, so a second "yes" said out of
        // habit finds nothing to answer, rather than whatever asks next.
        return r.agentIds?.length && !r.focusId ? { ...r, focusId: r.agentIds[0] } : r;
      }
      default: {
        // With a request for permission in the centre, words that are no answer say so, not the general hint.
        const asking = this._permissionInFocus(focusId);
        return { reply: asking ? `${asking.name} is waiting for your OK. Say “yes” or “no” to it first.` : HELP };
      }
    }
  }

  /** The agent in the centre, or its one helper, when it waits for permission; else null. */
  _permissionInFocus(focusId) {
    const v = focusId ? this.store.get(focusId) : null;
    if (!v) return null;
    if (v.ask?.type === 'permission') return v;
    const helpers = this.store.list().filter(a => (a.parentId === v.id || a.rootId === v.id) && a.ask?.type === 'permission');
    return helpers.length === 1 ? helpers[0] : null;
  }

  _permissionTarget(id) {
    const v = id ? this.store.get(id) : null;
    if (v && v.ask && v.ask.type === 'permission') return { v };
    const waiting = this.store.list().filter(a => a.ask && a.ask.type === 'permission');
    if (waiting.length === 1) return { v: waiting[0] };
    if (!waiting.length) return { v: null, reply: 'Nothing is waiting for your OK right now.' };
    return { v: null, reply: `Which one? ${joinAnd(waiting.map(a => a.name))} are waiting for your OK.` };
  }

  _canRun(h) {
    if (this.mode === 'demo') return !!this.adapters.sim;
    return h !== 'sim' && !!this.adapters[h] && this.harnessInfo[h]?.ok !== false;
  }

  /**
   * Why new work cannot start on agent `h` here. Signed out (Connect ran it, and it says it is not signed in: signedIn
   * 'no'): Connect's own sentence for it when that is one plain line, else "<Name> is installed but not signed in.",
   * then "Sign in in Agents & keys.". Anything else: "<Name> is not available on this computer.", and with `advice`,
   * "Connect it in Agents & keys.".
   */
  _cannotRunSentence(h, { advice = false } = {}) {
    const name = harnessName(h);
    const info = this.mode === 'live' ? this.harnessInfo[h] : null;
    if (info?.signedIn === 'no' && typeof this.adapters[h]?.createRunner === 'function') {
      return `${plainLine(info.reason) || `${name} is installed but not signed in.`} Sign in in Agents & keys.`;
    }
    return `${name} is not available on this computer.${advice ? ' Connect it in Agents & keys.' : ''}`;
  }

  /** The reply to new work that names an agent that cannot start here. In live mode it opens Agents & keys. */
  _cannotRunReply(h) {
    return this.mode === 'live' && AGENT_HARNESSES.includes(h)
      ? { reply: this._cannotRunSentence(h, { advice: true }), openConnect: true }
      : { reply: `${harnessName(h)} is not available on this computer.` };
  }

  /**
   * A launch card for these tasks. A task whose words name no agent goes to the default agent (_defaultHarness). With no
   * agent ready, or one named that cannot run here, the reply says so and carries `openConnect`, so the page opens
   * Agents & keys. With no task, the reply asks what to work on: `named`, the agent the words named ("start codex"),
   * is asked about by name when it can start, and is refused as a task naming it would be when it cannot.
   */
  _proposeStart(tasks, named = null) {
    const list = (Array.isArray(tasks) ? tasks : [])
      .map(t => ({ task: String(t?.task ?? '').trim(), harness: HARNESS_NAMES[t?.harness] ? t.harness : null, machine: t?.machine || null }))
      .filter(t => t.task)
      .slice(0, 8);
    let def; // looked up once, and only when a task names no agent
    const fallback = () => (def === undefined ? (def = this._defaultHarness()) : def);
    if (!list.length) {
      const h = AGENT_HARNESSES.includes(named) ? named : null;
      if (h) return this._canRun(h) ? { reply: `What should ${harnessName(h)} work on?` } : this._cannotRunReply(h);
      // Nothing to work on yet: with no agent ready, that comes first, since nothing could start it.
      return fallback() === null ? { reply: NO_AGENT, openConnect: true } : { reply: 'What should the agent work on?' };
    }
    for (const t of list) {
      if (!t.harness) t.harness = fallback();
      if (!t.harness) return { reply: NO_AGENT, openConnect: true };
    }
    for (const t of list) {
      if (!this._canRun(t.harness)) return this._cannotRunReply(t.harness);
    }
    const detail = this._startDetail(list);
    // Live mode has no cloud machines: launches go to the laptop, and the question should not say otherwise.
    if (this.mode !== 'demo') for (const t of list) t.machine = null;
    let sentence = null;
    if (typeof this.deps.commands?.describeIntent === 'function') {
      try {
        const s = this.deps.commands.describeIntent({ kind: 'start', tasks: list }, this._commandContext(null));
        if (typeof s === 'string' && s.trim()) sentence = s.trim();
      } catch (err) {
        this.log.debug('describeIntent failed:', err);
      }
    }
    if (!sentence) {
      const label = (t) => (this.mode === 'demo' ? `a simulated ${harnessName(t.harness)}` : harnessName(t.harness));
      sentence = list.length === 1
        ? `Start ${label(list[0])} on “${clip(list[0].task, 90)}”${/\?$/.test(clip(list[0].task, 90)) ? '' : '?'}`
        : `Start ${list.length} agents: ${joinAnd(list.map(t => `${label(t)} on “${clip(t.task, 50)}”`))}?`;
    }
    return this._newConfirm({ kind: 'start', tasks: list, sentence, detail });
  }

  _startDetail(list) {
    const many = list.length > 1;
    const cloud = list.some(t => t.machine && t.machine !== 'laptop');
    if (this.mode === 'demo') {
      const where = cloud ? (many ? 'Each one gets its own cloud machine.' : 'It runs on a cloud machine.') : (many ? 'They run on your laptop.' : 'It runs on your laptop.');
      return `This is the demo: the agents are simulated and nothing is spent. ${where}`;
    }
    const parts = [`${many ? 'Each one' : 'It'} can spend up to ${money(this.defaultBudgetUsd)}.`];
    const repo = this.repoInfo;
    if (repo) {
      parts.push(`${many ? 'Each works' : 'It works'} in its own copy of ${repo.name || 'the repository'}, made from the last commit.`);
      const dirty = Number(repo.dirty) || 0;
      if (dirty > 0) parts.push(`Your ${dirty} uncommitted change${dirty === 1 ? ' is' : 's are'} not included.`);
    }
    if (cloud) parts.push('Cloud machines exist only in the demo, so it runs on your laptop.');
    return parts.join(' ');
  }

  /**
   * A stop or a message whose words found the agent without naming it ("stop the stuck one"): ask first, with the
   * same kind of confirm card as a launch.
   */
  _proposeIntent(intent) {
    let sentence = null;
    try {
      const s = this.deps.commands?.describeIntent?.(intent, this._commandContext(null));
      if (typeof s === 'string' && s.trim()) sentence = s.trim();
    } catch (err) {
      this.log.debug('describeIntent failed:', err);
    }
    const views = (intent.kind === 'stop' ? intent.agentIds : [intent.agentId]).map(id => this.store.get(id)).filter(Boolean);
    if (!sentence) {
      const names = joinAnd(views.map(v => v.name)) || 'that agent';
      sentence = intent.kind === 'stop' ? `Stop ${names}?` : `Tell ${names} “${clip(intent.text, 80)}”?`;
    }
    // Which one, in the person's own words: two agents can have the same name.
    const detail = views.length === 1 && views[0].task ? `Its task: “${clip(views[0].task, 90)}”` : null;
    return this._newConfirm({ kind: intent.kind, intent, sentence, detail });
  }

  /** Execute (go = true) or cancel a launch, stop or message proposed by command(). */
  async confirm(confirmId, go) {
    const out = await this._confirm(confirmId, go);
    this._notice(out.reply, out.focusId || null);
    return out;
  }

  async _confirm(confirmId, go) {
    const c = this.confirms.get(String(confirmId ?? ''));
    if (!c || this.now() - c.createdAt > this.options.confirmTtlMs) {
      if (c) this.confirms.delete(c.id);
      // a yes that did nothing is in the log, so "I pressed Do it and nothing happened" can be answered from it
      if (go) this.log.warn('A yes came for a question that was no longer waiting, so nothing was done.');
      return { reply: GONE };
    }
    this.confirms.delete(c.id);
    // Each kind is handled here by name. A kind nobody knows never reaches the launch below.
    switch (c.kind) {
      case 'forget':
        if (!go) return { reply: c.agentIds.length === 1 ? 'OK, I won’t forget it.' : 'OK, I won’t forget them.' };
        return this._forgetEarlier(c.agentIds);
      case 'stop':
      case 'say':
        if (!go) {
          if (c.kind === 'say') return { reply: 'OK, I won’t send it.' };
          return { reply: c.intent.agentIds.length === 1 ? 'OK, I won’t stop it.' : 'OK, I won’t stop them.' };
        }
        return this._runIntent({ ...c.intent, sure: true });
      case 'merge':
        if (!go) return { reply: 'OK, I won’t merge it.' };
        return this._mergeConfirmed(c);
      case 'discard':
        if (!go) return { reply: 'OK, I won’t throw it away.' };
        return this._discardConfirmed(c);
      case 'start':
        if (Array.isArray(c.tasks)) break;
      // falls through: a launch card without its tasks cannot be one
      default:
        this.log.warn(`A confirm card of an unknown kind (${String(c.kind)}) was answered; nothing was done.`);
        return { reply: GONE };
    }
    if (!go) return { reply: c.tasks.length === 1 ? 'OK, I won’t start it.' : 'OK, I won’t start them.' };
    // Every yes to a launch is in the log, when it came and how it ended, so "I pressed Do it and nothing happened" can
    // be read from it: no line, the page never sent it; this line alone, the launch has not ended.
    this.log.warn(`A yes to a launch question came: starting ${c.tasks.length === 1 ? 'one agent' : `${c.tasks.length} agents`}.`);
    const used = new Set();
    const started = [];
    const problems = [];
    let openConnect = false; // an agent was gone by the time of the yes: Agents & keys is where to bring it back
    for (const t of c.tasks) {
      try {
        const machineId = await this._pickMachine(t.machine, used);
        used.add(machineId);
        const v = await this._startAgent({ task: t.task, harness: t.harness, machineId });
        if (v.state === STATE.FAILED) problems.push(`${v.name} could not start. ${v.stateReason || ''}`.trim());
        else started.push(v);
      } catch (err) {
        if (err?.openConnect && this.mode === 'live') openConnect = true;
        // A task refused for holding a key (stored after the card was made) is not quoted: a reply is never masked.
        if (err?.message === SECRET_REFUSED) {
          if (!problems.includes(SECRET_REFUSED)) problems.push(SECRET_REFUSED);
        } else {
          problems.push(`I could not start the agent for “${clip(t.task, 50)}”: ${plainReason(err)}`);
        }
      }
    }
    const parts = [];
    if (started.length) parts.push(`Started ${joinAnd(started.map(v => v.name))}.`);
    parts.push(...problems);
    this.log.warn(`After a yes to a launch question, ${started.length} of ${c.tasks.length} started.${problems.length ? ` ${problems.join(' ')}` : ''}`);
    return { reply: parts.join(' '), agentIds: started.map(v => v.id), ...(openConnect ? { openConnect: true } : {}) };
  }

  /** Demo only: 'cloud' picks a free cloud machine (waking one if needed); live is always the laptop. */
  async _pickMachine(machine, used) {
    if (this.mode !== 'demo' || !machine || machine === 'laptop') return 'laptop';
    const all = this.store.machines();
    const direct = all.find(m => m.id === machine);
    const pool = direct ? [direct] : all.filter(m => m.kind === 'cloud');
    if (!pool.length) return 'laptop';
    const counts = this._agentCountsByMachine();
    const free = pool.filter(m => !used.has(m.id));
    const pick = free.find(m => m.awake && !counts[m.id]) || free.find(m => m.awake) || free.find(m => !m.awake) || pool[0];
    if (!pick.awake && typeof this.machines?.setAwake === 'function') {
      try {
        await this.machines.setAwake(pick.id, true);
        this._syncMachines();
      } catch (err) {
        this.log.warn('Could not wake a machine:', err);
      }
    }
    return pick.id;
  }

  // ================================================================ status words

  _status(agentId) {
    if (agentId) {
      const v = this.store.get(agentId);
      if (!v) return { reply: 'I can’t find that agent.' };
      return { reply: this._describe(v), focusId: v.id };
    }
    const all = this.store.list();
    if (!all.length) return { reply: 'No agents yet. Say what to work on to begin.' };
    // An earlier agent waits on nobody, and neither does a failed check on work that is settled (merged with nothing new
    // since, or thrown away), as the page's needsPerson has it.
    const needs = all.filter(v => !v.earlier && NEEDS_YOU.has(v.state) && !(v.state === STATE.CHECKS_FAILED && workSettled(v)));
    const working = all.filter(v => !v.parentId && (v.state === STATE.WORKING || v.state === STATE.STARTING || v.state === STATE.WAITING_HELPERS));
    const parts = [];
    if (needs.length) {
      const what = needs.slice(0, 4).map(v => `${v.name} ${v.ask?.about === 'background' ? 'left a command running' : PHRASE[v.state]}`);
      if (needs.length > 4) what.push(`${needs.length - 4} more`);
      parts.push(`${needs.length === 1 ? 'One thing needs' : `${needs.length} things need`} you: ${joinAnd(what)}.`);
    } else {
      parts.push('Nothing needs you right now.');
    }
    if (working.length) parts.push(working.length === 1 ? 'One agent is working.' : `${working.length} agents are working.`);
    return { reply: parts.join(' '), ...(needs[0] ? { focusId: needs[0].id } : {}) };
  }

  _describe(v) {
    if (v.earlier) {
      let s = `${v.name} is from an earlier run. ${v.canContinue ? 'Send it a message to continue where it left off.' : v.continueReason || ''}`.trim();
      if (v.says) s += ` Its last message: ${v.says}`;
      return s + this._workWords(v);
    }
    const ask = v.ask;
    if (ask && v.state === STATE.NEEDS_OK) {
      // The exact command, path or address, so a spoken "what is it doing" says what an OK would let through.
      const exact = quotable(ask.detail);
      return `${ask.sentence}${exact ? `: “${exact}”` : ''}. It needs your OK.`;
    }
    if (ask && v.state === STATE.QUESTION) return `${v.name} has a question: ${ask.sentence}`;
    if (ask && v.state === STATE.MAYBE_STUCK && ask.about === 'background') return `${ask.sentence} Is it done, or should it keep waiting?`;
    if (ask && v.state === STATE.MAYBE_STUCK) return `${ask.sentence} Stop it, or let it keep trying?`;
    let s;
    if (v.state === STATE.WORKING && v.now) s = `${v.name} is working: ${lowerFirst(v.now)}.`;
    else if (v.state === STATE.WAITING_HELPERS && v.now) {
      // "… is waiting for a background command."; "… is waiting: its background work is done."
      s = /^Waiting /.test(v.now) ? `${v.name} is ${lowerFirst(v.now)}.` : `${v.name} is waiting: ${lowerFirst(v.now)}.`;
    }
    else s = `${v.name} ${PHRASE[v.state] || 'is working'}.`;
    if (v.stateReason && (v.state === STATE.FAILED || v.state === STATE.CHECKS_FAILED)) s += ` ${v.stateReason}`;
    if (v.says && ENDED.has(v.state)) s += ` It says: ${v.says}`;
    if (ENDED.has(v.state)) s += this._workWords(v);
    const n = v.helpers?.working || 0;
    if (n && ACTIVE.has(v.state)) s += ` ${n === 1 ? 'One helper is' : `${n} helpers are`} working.`;
    return s;
  }

  /**
   * What became of a root's work, for its status: thrown away, a merge that did not go through, or merged. "Merged" only
   * while nothing new is left to merge, as the page's card has it; work changed since its last merge is not merged.
   */
  _workWords(v) {
    const w = v.parentId ? null : v.work;
    if (!w) return '';
    if (w.thrownAway) return ' Its work was thrown away.';
    if (w.problem?.sentence) return ` The last merge did not go through: ${w.problem.sentence}`;
    if (!w.merged) return '';
    const into = w.merged.into;
    if (!unmergedWork(v)) return into ? ` Its work was merged into ${into}.` : ' Its work was merged.';
    const earlier = into ? `Its earlier work was merged into ${into}` : 'Its earlier work was merged';
    const n = v.files ? count(v.files.changed) : 0;
    return n
      ? ` ${earlier}, but ${n} changed file${n === 1 ? ' is' : 's are'} not merged yet.`
      : ` ${earlier}. Anything it changed since is not merged yet.`; // what it changed is not known
  }

  _spendSentence() {
    const spend = this.store.spendTodayUsd(this.now());
    // Claude Code reports cost only when a turn ends: until then part of it is Workbench's estimate ("about").
    const estimated = !!this.store.spendTodayEstimated?.(this.now());
    let s = this.mode === 'demo'
      ? `The demo agents have spent ${spentAmount(spend)} today. It is simulated, so nothing was really spent.`
      : `You have spent ${spentAmount(spend, estimated)} today.`;
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    const codex = this.store.list().some(v => !v.parentId && v.harness === 'codex' && v.startedAt >= d.getTime());
    if (codex) s += ' Codex does not report its cost, so its work is not counted.';
    return s;
  }

  // ================================================================ machines

  async setMachineAwake(machineId, awake) {
    const out = await this._setMachineAwake(machineId, awake === true);
    this._notice(out.reply);
    return out;
  }

  _findMachine(machineId) {
    const key = String(machineId ?? '').trim().toLowerCase();
    if (!key) return null;
    try {
      const m = this.machines?.get?.(machineId); // the machines module also takes loose names ("Cloud 2")
      if (m) return m;
    } catch { /* fall back to the list */ }
    const list = this.store.machines().length ? this.store.machines() : (this.machines?.list?.() || []);
    return list.find(x => x.id === machineId) || list.find(x => String(x.name || '').toLowerCase() === key) || null;
  }

  async _setMachineAwake(machineId, awake) {
    if (typeof this.machines?.setAwake !== 'function') return { ok: false, reply: 'Machines can’t be changed right now.' };
    const m = this._findMachine(machineId);
    if (m && m.kind === 'laptop') {
      return awake ? { ok: true, reply: 'Your laptop is already awake.' } : { ok: false, reply: 'Your laptop runs Workbench itself, so it stays awake.' };
    }
    let res;
    try {
      res = await this.machines.setAwake(m ? m.id : String(machineId ?? ''), awake);
    } catch (err) {
      return m ? { ok: false, reply: `I could not change ${m.name}: ${plainReason(err)}` } : { ok: false, reply: 'I can’t find that machine.' };
    }
    this._syncMachines();
    // The machines module words its own replies ("Cloud 2 is waking up. It takes about 8 seconds.").
    if (res && typeof res.reply === 'string' && res.reply) return { ok: res.ok !== false, reply: res.reply };
    if (!m) return { ok: false, reply: 'I can’t find that machine.' };
    if (!!m.awake === awake) return { ok: true, reply: `${m.name} is already ${awake ? 'awake' : 'asleep'}.` };
    return { ok: true, reply: awake ? `${m.name} is awake.` : `${m.name} is asleep now.` };
  }

  async _sleepIdle() {
    if (typeof this.machines?.sleepIdle === 'function') {
      await this._refreshMachines(); // so "idle" uses today's agent counts
      let res;
      try { res = await this.machines.sleepIdle(); } catch (err) { return { reply: `I could not put the idle machines to sleep: ${plainReason(err)}` }; }
      this._syncMachines();
      if (res && typeof res.reply === 'string' && res.reply) return { reply: res.reply };
    }
    const counts = this._agentCountsByMachine();
    const idle = this.store.machines().filter(m => m.kind === 'cloud' && m.awake && !counts[m.id]);
    if (!idle.length) return { reply: 'No machine is idle right now.' };
    const done = [];
    for (const m of idle) {
      const r = await this._setMachineAwake(m.id, false);
      if (r.ok) done.push(m.name);
    }
    return { reply: done.length ? `Put ${joinAnd(done)} to sleep.` : 'I could not put the idle machines to sleep.' };
  }

  /** Root agents still active on each machine. */
  _agentCountsByMachine() {
    const counts = {};
    for (const v of this.store.list()) {
      if (v.parentId || !ACTIVE.has(v.state)) continue;
      counts[v.machineId] = (counts[v.machineId] || 0) + 1;
    }
    return counts;
  }

  async _refreshMachines() {
    if (!this.machines) return;
    try {
      if (typeof this.machines.refresh === 'function') await this.machines.refresh(this._agentCountsByMachine());
    } catch (err) {
      this.log.warn('Could not refresh the machines:', err);
    }
    this._syncMachines();
  }

  /** Send machine.update for every machine that changed since last time. */
  _syncMachines() {
    let list = [];
    try { list = this.machines?.list?.() || []; } catch (err) { this.log.warn('Could not list the machines:', err); }
    const batch = [];
    for (const m of list) {
      if (!m || m.id == null) continue;
      const key = JSON.stringify(m);
      if (this._machineKeys.get(m.id) === key) continue;
      this._machineKeys.set(m.id, key);
      batch.push({ kind: EV.MACHINE, machine: { ...m } });
    }
    if (batch.length) this._apply(batch);
  }

  // ================================================================ snapshot

  snapshot() {
    const s = this.store.snapshot(this.now());
    return {
      mode: this.mode,
      repo: this._repoView(),
      harnesses: this._harnessFlags(),
      harnessInfo: { ...this.harnessInfo },
      // Live, with Connect: which agents can take new work, and the default one ({ ready, defaultAgent, agents:
      // [{ id, name, ready }] }), for the page's Agents & keys light, its lid and its opening by itself. Without it
      // (the demo, or no Connect) the page shows nothing of Agents & keys.
      ...(this.mode === 'live' && this.connect ? { connect: this._connectMeta() } : {}),
      agents: s.agents,
      machines: s.machines,
      spendTodayUsd: s.spendTodayUsd,
      spendTodayEstimated: !!s.spendTodayEstimated, // part of it is Workbench's estimate: say "about"
      defaultBudgetUsd: this.defaultBudgetUsd,
    };
  }
}
