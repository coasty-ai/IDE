// The normalized event stream and the agent view model.
// Adapters (Claude Code, Codex, simulator) emit EVENTS; the engine's store reduces them into AgentViews;
// the server sends AgentViews to the UI. No Node imports: the UI loads this file too.

/** Event kinds. Every event is { kind, agentId?, ts, ...fields }. */
export const EV = Object.freeze({
  CREATED: 'agent.created',       // { agentId, parentId|null, name, fullName?, task, harness, kind, helperType?, model?, machineId, budgetUsd?, workspace? }
  STATE: 'agent.state',           // { agentId, state, reason? }
  ACTIVITY: 'agent.activity',     // { agentId, sentence, toolKind, toolUseId?, phase: 'start'|'end', ok? }
  THINKING: 'agent.thinking',     // { agentId, on: boolean }
  USAGE: 'agent.usage',           // { agentId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd?, unreportedUsd?, contextTokens?, contextWindow?, mode: 'set'|'add' }
  TURN: 'agent.turn',             // { agentId, phase: 'start'|'end', finalText?, backgroundTasks?, background?, isError? }
  BACKGROUND: 'agent.background', // { agentId, helpers, commands, others, work: string[], ids: string[] }  what a root's process runs in the background now
  PLAN: 'agent.plan',             // { agentId, items: [{ id?, text, status: 'pending'|'in_progress'|'completed' }] }
  SAYS: 'agent.says',             // { agentId, text }
  ASK: 'agent.ask',               // { agentId, ask: { id, type: 'permission'|'question'|'stuck', about?: 'background', sentence, detail?, why?, options: string[], primary? } }  why: the permission check's own reason
  ASK_CLEARED: 'agent.askCleared',// { agentId, askId, answer }
  FILES: 'agent.files',           // { agentId, files: { changed, adds, dels, list: [{ path, adds, dels, binary?, large?, untracked?, ignored? }] } }
  CHECKS: 'agent.checks',         // { agentId, checks: { state: 'none'|'running'|'passed'|'failed', results: [{ name, ok, ms }] } }
  RULES: 'agent.rules',           // { agentId, rules: { kept: [{ say }], broken: [{ say, paths: string[] }] } }
  MODEL: 'agent.model',           // { agentId, model }
  SESSION: 'agent.session',       // { agentId, sessionId, version? }  harness session or thread id, for resume; version: the harness's own
                                  //   version when it says (Claude Code's claude_code_version from system/init)
  APPROVAL: 'agent.approval',     // { agentId, how: 'auto'|'person'|'timeout', decision: 'allow'|'deny', sentence }
  RESUMED: 'agent.resumed',       // { agentId }  an earlier agent (from history) is being picked up: it is no longer "earlier"
  WORK: 'agent.work',             // { agentId, work }  what became of a root's work in git (AgentView.work); replaces work as a whole
  ENDED: 'agent.ended',           // { agentId, outcome: 'ok'|'error'|'stopped', error? }
  MACHINE: 'machine.update',      // { machine: Machine }
  NOTICE: 'notice',               // { text }  a short reply from the workbench to the person
});

/** Width of one activity bucket in the hover-card sparkline, and how many buckets. */
export const SPARK_BUCKET_MS = 30_000;
export const SPARK_BUCKETS = 20;

/**
 * The view of one agent or helper, as sent to the UI.
 * @typedef {object} AgentView
 * @property {string} id
 * @property {string|null} parentId     null for a root agent
 * @property {string} rootId
 * @property {number} depth             0 for a root agent
 * @property {string} name              short plain-language name
 * @property {string} fullName          the whole description the name was made from ("Repository exploration and architecture mapping"); the name itself when there is none
 * @property {'claude'|'codex'|'sim'} harness
 * @property {'agent'|'helper'} kind
 * @property {string|null} helperType   e.g. "Explore" for a Claude Code sub-agent
 * @property {string|null} model
 * @property {string} machineId
 * @property {string} state             one of STATE in states.mjs
 * @property {string|null} stateReason
 * @property {number} stateSince        ms epoch
 * @property {string} now               what it is doing right now, a few words
 * @property {boolean} thinking
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {number} lastEventAt
 * @property {number} turns
 * @property {number} toolCalls
 * @property {Record<string, number>} toolKinds   counts by KIND in narrate.mjs
 * @property {{ ts: number, sentence: string, ok: boolean|null }[]} recent   last 8 finished steps, newest last
 * @property {number[]} spark           activity per SPARK_BUCKET_MS, oldest first, length SPARK_BUCKETS
 * @property {number} sparkEndsAt       ms epoch of the end of the newest bucket
 * @property {{ total: number, working: number, done: number }} helpers
 * @property {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number|null, unreportedUsd: number, contextTokens: number|null, contextWindow: number|null, contextPct: number|null }} usage
 *           costUsd: what the harness reported, null until it reports any ("not reported yet"); unreportedUsd: Workbench's
 *           estimate of what it has spent but not reported yet (0 when none). spentText() in format.mjs words both.
 * @property {number|null} budgetUsd
 * @property {{ items: { id?: string, text: string, status: string }[], done: number, total: number }|null} plan
 * @property {{ changed: number, adds: number, dels: number, list: { path: string, adds: number, dels: number, binary?: true, large?: true, untracked?: true, ignored?: true }[] }|null} files
 *           ignored: a new file hidden by a .gitignore the agent added or changed
 * @property {{ state: string, results: { name: string, ok: boolean, ms: number }[] }|null} checks
 * @property {{ kept: { say: string }[], broken: { say: string, paths: string[] }[] }|null} rules
 * @property {{ id: string, type: string, sentence: string, detail?: string, why?: string, options: string[], primary?: string, createdAt: number }|null} ask
 *           why (permission asks): the permission check's reason, in plain words ("The file is outside the agent's own folder.")
 * @property {{ auto: number, byYou: number, denied: number }} approvals   permission decisions so far
 * @property {string|null} says         its latest message to the person, plain prose
 * @property {string|null} error
 * @property {string|null} sessionId
 * @property {string|null} workspace    folder it works in (shown on request only)
 * @property {boolean} earlier          true for a root restored from history: it ran in an earlier Workbench run and has no
 *           process now. Cleared by `agent.resumed` when the person continues it
 * @property {boolean|null} canContinue earlier agents only (else null): its folder and session are still there
 * @property {string|null} continueReason  when canContinue is false, why, in plain words
 * @property {AgentWork|null} work      a root's work in git; null for helpers, for demo agents without git, and before a
 *           root has a folder
 */

/**
 * What became of a root's work in git. Set by `agent.work`, which replaces it as a whole.
 * @typedef {object} AgentWork
 * @property {string|null} branch       its branch ("workbench/search-cleanup-a1b2c3"); null once thrown away
 * @property {string|null} from         the person's branch when it started (null if detached or unknown)
 * @property {boolean} folder           its folder is still there
 * @property {{ into: string|null, merge: string|null, at: number, files: number, adds: number, dels: number }|null} merged
 *           the last successful merge (merge: the merge commit's id)
 * @property {{ why: 'conflict'|'blocked'|'ancestry'|'moved'|'identity'|'detached'|'busy'|'git', sentence: string, paths: string[], at: number }|null} problem
 *           set by a failed merge; cleared by the next merge, any turn start, a message it takes, and a throw-away
 * @property {{ at: number, saved: string|null }|null} thrownAway  saved: the hidden ref that keeps a copy of the work
 */

/** A machine that agents run on. */
/**
 * @typedef {object} Machine
 * @property {string} id
 * @property {string} name          "Your laptop", "Cloud 1"
 * @property {'laptop'|'cloud'} kind
 * @property {boolean} awake
 * @property {boolean} simulated    true for demo cloud machines
 * @property {number|null} cpuPct
 * @property {number|null} memPct
 * @property {number|null} costPerHourUsd
 * @property {number} agents        root agents running on it
 * @property {string} note          a few words: "idle", "3 agents", "asleep"
 */

/** A fresh AgentView with every field present. */
export function newAgentView(ev, now = Date.now()) {
  return {
    id: ev.agentId,
    parentId: ev.parentId || null,
    rootId: ev.rootId || ev.agentId,
    depth: ev.depth || 0,
    name: ev.name || 'Agent',
    fullName: ev.fullName || ev.name || 'Agent',
    task: ev.task || '',
    harness: ev.harness || 'sim',
    kind: ev.kind || (ev.parentId ? 'helper' : 'agent'),
    helperType: ev.helperType || null,
    model: ev.model || null,
    machineId: ev.machineId || 'laptop',
    state: 'starting',
    stateReason: null,
    stateSince: now,
    now: 'Starting',
    thinking: false,
    startedAt: ev.startedAt || now,
    endedAt: null,
    lastEventAt: now,
    turns: 0,
    toolCalls: 0,
    toolKinds: {},
    recent: [],
    spark: new Array(SPARK_BUCKETS).fill(0),
    sparkEndsAt: now,
    helpers: { total: 0, working: 0, done: 0 },
    // costUsd: what the harness reported, null until it reports any (Claude Code reports it when a turn ends; Codex
    // never does). unreportedUsd: Workbench's estimate of what it has spent but not reported yet.
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, unreportedUsd: 0, contextTokens: null, contextWindow: null, contextPct: null },
    budgetUsd: ev.budgetUsd ?? null,
    plan: null,
    files: null,
    checks: null,
    rules: null,
    ask: null,
    approvals: { auto: 0, byYou: 0, denied: 0 },
    says: null,
    error: null,
    sessionId: null,
    workspace: ev.workspace || null,
    earlier: false,
    canContinue: null,
    continueReason: null,
    work: null,
  };
}
