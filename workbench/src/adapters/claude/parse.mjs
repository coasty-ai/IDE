// Claude Code stream-json parser.
// Turns the objects Claude Code prints on stdout (one JSON object per line) into normalized workbench
// events (EV in src/shared/events.mjs). Pure: no I/O and no Node imports. Keep one parser per root agent
// for its whole life, including relaunches with --resume, so helpers, the plan and spend carry over.
import { EV } from '../../shared/events.mjs';
import { narrate, nameFromTask, firstSentence, plain } from '../../shared/narrate.mjs';
import { clip } from '../../shared/format.mjs';

/** Tools that launch a sub-agent (a helper). */
const HELPER_TOOLS = new Set(['Agent', 'Task']);

/** Tools that run a shell command, which can go on in the background (run_in_background, a timeout, a Monitor). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

/**
 * Tools whose task_progress words Claude Code builds from the call's own input ("Reading greet.js", "Searching for
 * x"). For other tools they are the agent's own words: "Running <the Bash call's description>", "Monitoring:
 * <description>", an Agent call's description, or the helper's task. Those progress lines are not shown; the
 * forwarded call names the step by what it really does.
 */
const PROGRESS_FROM_INPUT = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

/** Task statuses that end a helper, and the helper state each one leads to. */
const END_STATE = Object.freeze({ completed: 'finished', failed: 'failed', killed: 'stopped', stopped: 'stopped' });

/** How many message ids to remember for usage dedupe. Old ids never come back, so a cap is safe. */
const MAX_SEEN_IDS = 5000;

/** Longest tool input kept on activity events, so repeated identical calls can be spotted. */
const INPUT_KEY_CHARS = 300;

/** A Claude Code version as system/init reports it ("2.1.322"). Anything else is not passed on. */
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;

/** Plain reasons for Claude Code's error results, keyed by result subtype. */
const ERROR_REASONS = Object.freeze({
  error_max_budget_usd: 'It reached its spending limit.',
  error_max_turns: 'It reached the limit on how many steps it may take.',
  error_during_execution: 'Claude Code ran into an error while working.',
});

/**
 * Helper ids are `<rootId>-<first 8 chars of the harness task id>`.
 * Only letters, digits, `_` and `-` are kept, so ids never contain `/` or `:`.
 */
export function helperIdFor(rootId, taskId, length = 8) {
  const clean = String(taskId || '').replace(/^toolu_/, '').replace(/[^A-Za-z0-9_-]/g, '');
  return `${rootId}-${(clean || 'helper').slice(0, length)}`;
}

/**
 * Prices in US dollars per million tokens: new input, output, cache read, and cache write for 5 minutes (1 hour costs
 * twice the input price). Used only to estimate what Claude Code has spent but not reported yet: it reports cost only
 * when a turn ends. Where they come from: the Haiku row reproduces the recorded runs' totals exactly; the 5/25 and
 * 10/50 tiers are constants in Claude Code 2.1.221; the Opus 4/4.1 and Sonnet rows are Anthropic's list prices
 * (assumed). A row that is too low would let a relaunch spend too much, so a model not listed is priced as the most
 * expensive one, and newer, cheaper models in a family are priced high rather than low.
 */
const PRICES = [
  [/opus-4-(?:0|1)\b|opus-4-20/, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/opus/, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/fable|mythos/, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/sonnet/, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/haiku/, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];
const PRICIEST = PRICES[0][1];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Estimated cost of one API message from its usage. Input-side tokens are exact; output_tokens in the stream is only
 * what the API had counted when the message began, so the estimate is a little low (the result's real total came out
 * 6 to 14 percent higher in the recorded runs).
 */
export function estimateUsd(model, u) {
  const m = String(model || '').toLowerCase();
  const p = (m && PRICES.find(([re]) => re.test(m))?.[1]) || PRICIEST;
  const write = num(u.cache_creation_input_tokens);
  const write1h = u.cache_creation && typeof u.cache_creation === 'object' ? Math.min(write, num(u.cache_creation.ephemeral_1h_input_tokens)) : 0;
  const usd = num(u.input_tokens) * p.input + num(u.output_tokens) * p.output + num(u.cache_read_input_tokens) * p.cacheRead
    + (write - write1h) * p.cacheWrite + write1h * p.input * 2;
  return (usd / 1e6) * (u.speed === 'fast' ? 6 : 1) * (u.inference_geo === 'us' ? 1.1 : 1);
}

const ZERO = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const addSpend = (a, b) => ({
  inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: (a.costUsd || 0) + (b.costUsd || 0),
});
const inSide = (t) => t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;

function normStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'completed' || v === 'done' || v === 'complete') return 'completed';
  if (v === 'in_progress' || v === 'active' || v === 'running') return 'in_progress';
  if (v === 'pending' || v === 'todo' || v === 'open') return 'pending';
  return null;
}

/** The text inside a tool_result's content (a string, or an array of blocks). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function inputKey(input) {
  let j = '';
  try { j = JSON.stringify(input) || ''; } catch { j = ''; }
  return j.length > INPUT_KEY_CHARS ? j.slice(0, INPUT_KEY_CHARS) : j;
}

function rememberId(set, id) {
  set.add(id);
  if (set.size > MAX_SEEN_IDS) set.delete(set.values().next().value);
}

/**
 * Create a parser for one root agent.
 * @param {{ rootId: string, now?: () => number, machineId?: string, workspace?: string, onError?: (err: Error) => void }} opts
 * @returns {{ push(obj: object): object[], endOpenHelpers(state?: string, reason?: string): object[],
 *            processRestarted(): void, info(): object, recipients(): string[] }}
 */
export function createClaudeParser({ rootId, now = Date.now, machineId, workspace, onError } = {}) {
  if (!rootId) throw new Error('createClaudeParser needs the id of the root agent.');

  const s = {
    model: null,              // root model, from system/init
    sessionId: null,          // from system/init
    version: null,            // the Claude Code version, from system/init (claude_code_version)
    inTurn: false,            // between system/init and result
    rootText: '',             // latest root text block, a fallback for the final text
    rootContext: null,        // context tokens of the latest root message
    windows: new Map(),       // model -> context window, learned from result.modelUsage
    thinking: new Map(),      // agentId -> boolean
    seenIds: new Set(),       // assistant message ids whose usage was already counted
    tools: new Map(),         // tool_use id -> { agentId, sentence, toolKind, name } until its result
    pending: new Map(),       // Agent/Task tool_use id -> launch details, until the helper appears
    helpers: new Map(),       // helper id -> helper record
    byTask: new Map(),        // harness task id -> helper
    byToolUse: new Map(),     // Agent/Task tool_use id -> helper
    plans: new Map(),         // agentId -> plan items
    taskCreates: new Map(),   // TaskCreate tool_use id -> plan item, until its result gives the real id
    bg: new Map(),            // running background task id -> { type, description }, from background_tasks_changed
    bgSeen: false,
    bgSent: '',               // the last background split sent, so it is sent again only when it changes
    commands: new Map(),      // shell tool_use id -> what the command does, in Workbench's own words (never the agent's)
    bgWords: new Map(),       // background task id -> what its command does, from the call that started it
    // Spend: Claude Code reports totals for the whole process, at the end of each turn. `base` carries totals
    // across a relaunch. `rootInSince` sums the input-side tokens of root messages since the last relaunch.
    // `tail` is what this process's messages since its last result used (tokens, and an estimated cost); `carry`
    // is the tail of a process that ended before reporting it (a stopped turn), until the next result shows
    // whether the new process counted it; `lostUsd` is the estimated cost that will never be reported.
    spend: { base: null, lastRaw: null, last: null, restartPending: false, rootInSince: 0, tail: { ...ZERO }, carry: null, lostUsd: 0 },
  };

  let out = [];
  // `kind` and `agentId` always win over same-named fields, so a field can never change the event type.
  const ev = (kind, agentId, fields = {}) => { out.push(Object.assign({ kind, ts: now(), agentId }, fields, { kind, agentId })); };

  // ---- small state helpers ----

  function setThinking(agentId, on, { silent = false } = {}) {
    if ((s.thinking.get(agentId) || false) === on) return;
    s.thinking.set(agentId, on);
    if (!silent) ev(EV.THINKING, agentId, { on });
  }

  function planOf(agentId) {
    if (!s.plans.has(agentId)) s.plans.set(agentId, []);
    return s.plans.get(agentId);
  }

  function emitPlan(agentId) {
    ev(EV.PLAN, agentId, { items: planOf(agentId).map(x => ({ id: x.id, text: x.text, status: x.status })) });
  }

  function openHelpers() {
    return [...s.helpers.values()].filter(h => !h.ended);
  }

  function contextWindowFor(model) {
    if (model && s.windows.has(model)) return s.windows.get(model);
    let best = null;
    for (const w of s.windows.values()) if (best == null || w > best) best = w;
    return best;
  }

  // ---- helpers (sub-agents) ----

  function uniqueHelperId(key) {
    for (let n = 8; n <= 32; n += 4) {
      const id = helperIdFor(rootId, key, n);
      if (!s.helpers.has(id)) return id;
    }
    let k = 2;
    const base = helperIdFor(rootId, key, 32);
    while (s.helpers.has(`${base}-${k}`)) k++;
    return `${base}-${k}`;
  }

  function createHelper({ taskId, toolUseId, parentId, description, subagentType, prompt, callName }) {
    const id = uniqueHelperId(taskId || toolUseId);
    const h = {
      id, taskId: taskId || null, toolUseId: toolUseId || null, parentId: parentId || rootId,
      callName: typeof callName === 'string' && callName ? callName : null, // the Agent call's own `name`, for SendMessage
      ended: false, said: false, model: null, lastSentence: null,
      fwdTools: 0,    // tool_use blocks seen in its forwarded messages
      shownTools: 0,  // highest tool number already shown as an activity start (from either source)
    };
    s.helpers.set(id, h);
    if (h.taskId) s.byTask.set(h.taskId, h);
    if (h.toolUseId) { s.byToolUse.set(h.toolUseId, h); s.pending.delete(h.toolUseId); }
    const desc = String(description || '').trim();
    // No `kind: 'helper'` field here: it would clash with the event's own `kind`. The store makes any
    // view with a parentId a helper.
    const created = {
      parentId: h.parentId,
      name: desc ? nameFromTask(desc) : 'Helper',
      fullName: desc ? clip(plain(desc), 200) || 'Helper' : 'Helper',
      task: String(prompt || desc || ''),
      harness: 'claude',
      helperType: subagentType || null,
    };
    if (machineId) created.machineId = machineId;
    if (workspace) created.workspace = workspace;
    ev(EV.CREATED, id, created);
    ev(EV.STATE, id, { state: 'working' });
    return h;
  }

  /** The helper a task event is about, by task id or by the tool_use id that launched it. */
  function findHelper(o) {
    const taskId = o.task_id ? String(o.task_id) : null;
    const toolUseId = o.tool_use_id ? String(o.tool_use_id) : null;
    const h = (taskId && s.byTask.get(taskId)) || (toolUseId && s.byToolUse.get(toolUseId)) || null;
    if (h && taskId && !h.taskId) { h.taskId = taskId; s.byTask.set(taskId, h); }
    return h;
  }

  /** The helper that forwarded messages with this parent_tool_use_id belong to. */
  function helperForToolUse(toolUseId) {
    const h = s.byToolUse.get(toolUseId);
    if (h) return h;
    // Messages arrived before task_started (or without one): create the helper from the Agent call.
    const p = s.pending.get(toolUseId);
    return p ? createHelper({ toolUseId, ...p }) : null;
  }

  function endHelper(h, state, { reason, summary } = {}) {
    if (h.ended) return;
    if (summary && String(summary).trim() && !h.said) {
      h.said = true;
      ev(EV.SAYS, h.id, { text: firstSentence(summary) });
    }
    h.ended = true;
    if (h.taskId) s.bg.delete(h.taskId);
    setThinking(h.id, false);
    let why = null;
    const given = reason && String(reason).trim() ? firstSentence(reason, 200) : '';
    if (state === 'failed') why = given || 'The helper ran into a problem and stopped.';
    else if (state === 'stopped') why = given || 'The helper was stopped.';
    ev(EV.STATE, h.id, why ? { state, reason: why } : { state });
    const outcome = state === 'finished' ? 'ok' : state === 'failed' ? 'error' : 'stopped';
    ev(EV.ENDED, h.id, outcome === 'error' ? { outcome, error: why } : { outcome });
  }

  // ---- plans ----

  // Claude Code's Task tools keep one task list for the whole session, so it is the root's plan,
  // whichever agent changes it. TodoWrite lists belong to the agent that wrote them.

  function planTaskCreate(toolUseId, input) {
    const text = String(input.subject || input.description || '').trim();
    if (!text) return;
    const items = planOf(rootId);
    // Provisional id: its position. The tool result ("Task #N created") gives the real one.
    const item = { id: String(items.length + 1), text, status: 'pending' };
    items.push(item);
    if (toolUseId) s.taskCreates.set(toolUseId, item);
    emitPlan(rootId);
  }

  function settleTaskCreate(toolUseId, block, toolUseResult) {
    const item = s.taskCreates.get(toolUseId);
    if (!item) return;
    s.taskCreates.delete(toolUseId);
    const items = planOf(rootId);
    if (block.is_error) {
      const i = items.indexOf(item);
      if (i >= 0) { items.splice(i, 1); emitPlan(rootId); }
      return;
    }
    let realId = toolUseResult && toolUseResult.task && toolUseResult.task.id != null ? String(toolUseResult.task.id) : null;
    if (!realId) {
      const m = /Task #([A-Za-z0-9_-]+)/.exec(resultText(block.content));
      if (m) realId = m[1];
    }
    if (realId && realId !== item.id) { item.id = realId; emitPlan(rootId); }
  }

  function planTaskUpdate(input) {
    const items = planOf(rootId);
    const id = String(input.taskId ?? input.id ?? '');
    const i = items.findIndex(x => x.id === id);
    if (i < 0) return;
    let changed = false;
    if (String(input.status || '').toLowerCase() === 'deleted') {
      items.splice(i, 1);
      changed = true;
    } else {
      const st = normStatus(input.status);
      if (st && st !== items[i].status) { items[i].status = st; changed = true; }
      const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
      if (subject && subject !== items[i].text) { items[i].text = subject; changed = true; }
    }
    if (changed) emitPlan(rootId);
  }

  function planTodoWrite(agentId, input) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const items = todos
      .map((t, i) => ({
        id: String(t && t.id != null ? t.id : i + 1),
        text: String((t && (t.content ?? t.subject)) || '').trim(),
        status: normStatus(t && t.status) || 'pending',
      }))
      .filter(x => x.text);
    s.plans.set(agentId, items);
    emitPlan(agentId);
  }

  // ---- assistant messages ----

  function countUsage(agentId, msg, isHelper) {
    const u = msg.usage;
    // One API message is split over several stream objects that repeat the same usage: count it once.
    if (!u || typeof u !== 'object' || !msg.id || s.seenIds.has(msg.id)) return;
    rememberId(s.seenIds, msg.id);
    const input = num(u.input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const contextTokens = input + cacheRead + cacheWrite;
    if (!isHelper) { s.rootContext = contextTokens; s.spend.rootInSince += contextTokens; }
    const e = {
      mode: 'add', inputTokens: input, outputTokens: num(u.output_tokens),
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, contextTokens,
    };
    // Helpers' spend counts toward the root's: Claude Code's totals include its sub-agents.
    s.spend.tail = addSpend(s.spend.tail, { ...e, costUsd: estimateUsd(msg.model || (isHelper ? null : s.model), u) });
    if (!isHelper) e.unreportedUsd = unreportedUsd();
    const win = contextWindowFor(msg.model);
    if (win) e.contextWindow = win;
    ev(EV.USAGE, agentId, e);
  }

  /** Estimated cost that Claude Code has not reported (yet, or ever, for a stopped turn). */
  function unreportedUsd() {
    const sp = s.spend;
    return sp.tail.costUsd + (sp.carry ? sp.carry.costUsd : 0) + sp.lostUsd;
  }

  function onToolUse(agentId, helper, b) {
    const name = String(b.name || 'tool');
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const id = b.id ? String(b.id) : null;
    if (id && s.tools.has(id)) { setThinking(agentId, false); return; } // the same block seen twice
    const { sentence, kind } = narrate(name, input);
    if (id) s.tools.set(id, { agentId, sentence, toolKind: kind, name });
    // A shell command can go on in the background; the task that tracks it then needs these words.
    if (id && SHELL_TOOLS.has(name)) {
      s.commands.set(id, sentence);
      if (s.commands.size > MAX_SEEN_IDS) s.commands.delete(s.commands.keys().next().value);
    }

    let show = true;
    if (helper) {
      // task_progress may already have announced this step (it can arrive before the forwarded message). Only a
      // step it described from the call's input is left out here; any other step is shown with what it really does.
      helper.fwdTools += 1;
      if (PROGRESS_FROM_INPUT.has(name) && helper.fwdTools <= helper.shownTools) show = false;
      else helper.shownTools = Math.max(helper.shownTools, helper.fwdTools);
    }
    if (show) {
      setThinking(agentId, false, { silent: true }); // an activity start turns thinking off in the store
      ev(EV.ACTIVITY, agentId, { phase: 'start', sentence, toolKind: kind, toolUseId: id, tool: name, input: inputKey(input) });
      if (helper) helper.lastSentence = sentence;
    } else {
      setThinking(agentId, false);
    }

    if (HELPER_TOOLS.has(name) && id) {
      s.pending.set(id, {
        parentId: agentId,
        description: input.description,
        subagentType: input.subagent_type,
        prompt: input.prompt,
        callName: input.name, // SendMessage can reach the helper by this name
      });
    }
    if (name === 'TaskCreate') planTaskCreate(id, input);
    else if (name === 'TaskUpdate') planTaskUpdate(input);
    else if (name === 'TodoWrite') planTodoWrite(agentId, input);
  }

  function onAssistant(o) {
    const msg = o.message && typeof o.message === 'object' ? o.message : {};
    let agentId = rootId;
    let helper = null;
    if (o.parent_tool_use_id) {
      helper = helperForToolUse(String(o.parent_tool_use_id));
      if (!helper) return; // from a helper we know nothing about: drop it rather than blame the root
      agentId = helper.id;
      if (msg.model && helper.model !== msg.model) {
        helper.model = msg.model;
        ev(EV.MODEL, agentId, { model: msg.model });
      }
    }
    countUsage(agentId, msg, !!helper);
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        setThinking(agentId, true);
      } else if (b.type === 'text') {
        if (!helper && typeof b.text === 'string' && b.text.trim()) s.rootText = b.text;
        setThinking(agentId, false);
      } else if (b.type === 'tool_use') {
        onToolUse(agentId, helper, b);
      }
    }
  }

  // ---- tool results ----

  function settleHelperCall(toolUseId, block, toolUseResult) {
    const helper = s.byToolUse.get(toolUseId);
    if (block.is_error) {
      // The launch itself failed or was refused.
      s.pending.delete(toolUseId);
      if (helper) endHelper(helper, 'failed', { reason: resultText(block.content) });
      return;
    }
    // A background launch only returns metadata ("Async agent launched"): the helper keeps working.
    // Only a foreground helper that reports it completed is ended here.
    const r = toolUseResult && typeof toolUseResult === 'object' ? toolUseResult : null;
    if (helper && r && r.status === 'completed' && r.isAsync !== true) {
      s.pending.delete(toolUseId);
      endHelper(helper, 'finished', { summary: resultText(block.content) });
    }
  }

  function onUser(o) {
    const msg = o.message && typeof o.message === 'object' ? o.message : {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
      const id = String(b.tool_use_id);
      const tool = s.tools.get(id);
      if (!tool) continue;
      s.tools.delete(id);
      const ok = !b.is_error;
      const e = { phase: 'end', sentence: tool.sentence, toolKind: tool.toolKind, toolUseId: id, tool: tool.name, ok };
      if (!ok) e.error = clip(resultText(b.content), 300) || 'That step did not work.';
      ev(EV.ACTIVITY, tool.agentId, e);
      if (tool.name === 'TaskCreate') settleTaskCreate(id, b, o.tool_use_result);
      if (HELPER_TOOLS.has(tool.name)) settleHelperCall(id, b, o.tool_use_result);
    }
  }

  // ---- system messages ----

  function onInit(o) {
    if (o.model) { s.model = String(o.model); ev(EV.MODEL, rootId, { model: s.model }); }
    // The version of the process that is running now: a relaunch may start a newer Claude Code.
    const version = typeof o.claude_code_version === 'string' && VERSION_RE.test(o.claude_code_version) ? o.claude_code_version : null;
    if (version) s.version = version;
    if (o.session_id) {
      s.sessionId = String(o.session_id);
      ev(EV.SESSION, rootId, version ? { sessionId: s.sessionId, version } : { sessionId: s.sessionId });
    }
    s.inTurn = true;
    s.rootText = '';
    ev(EV.TURN, rootId, { phase: 'start' });
  }

  function onTaskStarted(o) {
    const taskId = o.task_id ? String(o.task_id) : null;
    const toolUseId = o.tool_use_id ? String(o.tool_use_id) : null;
    if (!taskId && !toolUseId) return;
    if (taskId && toolUseId && s.commands.has(toolUseId)) s.bgWords.set(taskId, s.commands.get(toolUseId));
    if (findHelper(o)) return; // a duplicate, or created early from its messages
    const pending = toolUseId ? s.pending.get(toolUseId) : null;
    // Only sub-agents become helpers. Other background work (a long shell command, say) does not.
    const isAgent = !!pending || !!o.subagent_type || /agent/i.test(String(o.task_type || ''));
    if (!isAgent) return;
    const issuer = (toolUseId && s.tools.get(toolUseId)) || null;
    createHelper({
      taskId, toolUseId,
      parentId: (pending && pending.parentId) || (issuer && issuer.agentId) || rootId,
      description: o.description ?? (pending && pending.description),
      subagentType: o.subagent_type ?? (pending && pending.subagentType),
      prompt: o.prompt ?? (pending && pending.prompt),
      callName: pending && pending.callName,
    });
  }

  function onTaskProgress(o) {
    let h = findHelper(o);
    if (!h) { onTaskStarted(o); h = findHelper(o); }
    if (!h || h.ended) return;
    // Only words Claude Code built from the call's input are shown. For any other tool, or none named, they are the
    // helper's own words: the forwarded call shows that step instead, with what it really does, and counts it once.
    const tool = o.last_tool_name ? String(o.last_tool_name) : '';
    const sentence = PROGRESS_FROM_INPUT.has(tool) && typeof o.description === 'string' ? o.description.trim() : '';
    if (!sentence) return;
    // Do not count a step twice: the forwarded tool_use may already have shown it.
    const count = o.usage && typeof o.usage.tool_uses === 'number' ? o.usage.tool_uses : null;
    if (count != null) {
      if (count <= h.shownTools) return;
      h.shownTools = count;
    } else if (sentence === h.lastSentence) {
      return;
    }
    setThinking(h.id, false, { silent: true });
    ev(EV.ACTIVITY, h.id, { phase: 'start', sentence, toolKind: narrate(tool, {}).kind, tool });
    h.lastSentence = sentence;
  }

  function onTaskUpdated(o) {
    const status = o.patch && typeof o.patch === 'object' ? String(o.patch.status || '') : '';
    const state = END_STATE[status];
    if (!state) return;
    if (o.task_id) s.bg.delete(String(o.task_id));
    const h = findHelper(o);
    if (h) endHelper(h, state, { reason: o.patch.error });
  }

  function onTaskNotification(o) {
    if (o.task_id) s.bg.delete(String(o.task_id));
    const h = findHelper(o);
    if (!h) return;
    // task_updated usually ends the helper first, without a summary; still say the summary once.
    const summary = typeof o.summary === 'string' ? o.summary : '';
    if (summary.trim() && !h.said) {
      h.said = true;
      ev(EV.SAYS, h.id, { text: firstSentence(summary) });
    }
    endHelper(h, END_STATE[String(o.status || '')] || 'finished', { reason: summary });
  }

  function onBackgroundTasks(o) {
    s.bgSeen = true;
    s.bg = new Map((Array.isArray(o.tasks) ? o.tasks : []).map((t, i) => [
      String((t && t.task_id) || `task-${i}`),
      { type: String((t && t.task_type) || ''), description: t && typeof t.description === 'string' ? t.description.trim() : '' },
    ]));
  }

  /**
   * What runs in the background now. A task is a helper when this parser shows a live helper for it; otherwise it is a
   * command (Claude Code's task type `local_bash`: Bash run_in_background, a command moved to the background at its
   * timeout, a Monitor watch) or some other background task. Unknown kinds are never taken for helpers.
   */
  function backgroundSplit() {
    if (!s.bgSeen) return { helpers: openHelpers().length, commands: 0, others: 0, work: [], ids: [] };
    let helpers = 0;
    let commands = 0;
    let others = 0;
    const work = [];
    const ids = [];
    for (const [id, t] of s.bg) {
      const h = s.byTask.get(id);
      if (h && !h.ended) { helpers++; continue; }
      if (t.type === 'local_bash') commands++; else others++;
      ids.push(id);
      // In Workbench's own words for the command that started it; the task's description is the agent's.
      if (work.length < 3) work.push(s.bgWords.get(id) || (t.type === 'local_bash' ? 'Running a command' : 'A background task'));
    }
    return { helpers, commands, others, work, ids };
  }

  /** Send the background split when it changed, so the waiting line stays true between turns. */
  function sendBackground() {
    if (!s.bgSeen) return;
    const split = backgroundSplit();
    const key = JSON.stringify(split);
    if (key === s.bgSent) return;
    s.bgSent = key;
    ev(EV.BACKGROUND, rootId, split);
  }

  function onThinkingTokens(o) {
    if (o.parent_tool_use_id) {
      const h = s.byToolUse.get(String(o.parent_tool_use_id));
      if (h && !h.ended) setThinking(h.id, true);
      return;
    }
    // Between turns the root is not thinking; do not cover "Waiting for helpers".
    if (s.inTurn) setThinking(rootId, true);
  }

  function onSystem(o) {
    switch (o.subtype) {
      case 'init': return onInit(o);
      case 'task_started': return onTaskStarted(o);
      case 'task_progress': return onTaskProgress(o);
      case 'task_updated': return onTaskUpdated(o);
      case 'task_notification': return onTaskNotification(o);
      case 'background_tasks_changed': return onBackgroundTasks(o);
      case 'thinking_tokens': return onThinkingTokens(o);
      default: return undefined; // other system messages carry nothing the person needs
    }
  }

  // ---- result: the end of a root turn ----

  /**
   * Carry totals across a relaunch if the new process counts from zero again.
   * Input-side tokens (input + cache read + cache write) of each message are exact, and the totals are their
   * sums. A process that kept the old totals reports at least the old total plus this process's root
   * messages; anything less means it started from zero.
   */
  function continueSpend(raw) {
    const sp = s.spend;
    const before = sp.last || ZERO; // the totals before this result
    let folded = ZERO;
    if (sp.restartPending) {
      sp.restartPending = false;
      const prev = sp.lastRaw;
      let reset = false;
      if (prev && (inSide(raw) > 0 || inSide(prev) > 0)) reset = inSide(raw) < inSide(prev) + sp.rootInSince;
      else if (prev && raw.costUsd != null && prev.costUsd != null) reset = raw.costUsd <= prev.costUsd;
      if (reset) sp.base = { ...sp.last };
      // What the stopped process used after its last result. If the new totals do not include it (the same test),
      // its tokens stay in the totals and its estimated cost counts as never reported; if they do, it is covered.
      const carry = sp.carry;
      sp.carry = null;
      if (carry && (reset || inSide(raw) < (prev ? inSide(prev) : 0) + inSide(carry) + sp.rootInSince)) {
        folded = { ...carry, costUsd: 0 };
        sp.base = addSpend(sp.base || ZERO, folded);
        sp.lostUsd += carry.costUsd;
      } else if (carry) {
        sp.tail = addSpend(sp.tail, carry);
      }
    }
    sp.lastRaw = raw;
    const b = sp.base;
    const shown = b ? {
      inputTokens: b.inputTokens + raw.inputTokens,
      outputTokens: b.outputTokens + raw.outputTokens,
      cacheReadTokens: b.cacheReadTokens + raw.cacheReadTokens,
      cacheWriteTokens: b.cacheWriteTokens + raw.cacheWriteTokens,
      costUsd: raw.costUsd == null ? null : (b.costUsd || 0) + raw.costUsd,
    } : { ...raw };
    sp.last = shown;
    // The result covers what the totals grew by. A message can be billed later than it streams (a helper's message
    // shows before a result but is counted in the next one), so keep what they used beyond that.
    const grew = (k) => Math.max(0, (shown[k] || 0) - (before[k] || 0) - (folded[k] || 0));
    const t = sp.tail;
    sp.tail = {
      inputTokens: Math.max(0, t.inputTokens - grew('inputTokens')),
      outputTokens: Math.max(0, t.outputTokens - grew('outputTokens')),
      cacheReadTokens: Math.max(0, t.cacheReadTokens - grew('cacheReadTokens')),
      cacheWriteTokens: Math.max(0, t.cacheWriteTokens - grew('cacheWriteTokens')),
      costUsd: Math.max(0, t.costUsd - grew('costUsd')),
    };
    return shown;
  }

  function errorReason(o) {
    if (ERROR_REASONS[o.subtype]) return ERROR_REASONS[o.subtype];
    const text = typeof o.result === 'string' ? plain(o.result) : '';
    if (text) return 'Claude Code reported a problem: ' + clip(text, 160);
    if (o.api_error_status) return 'The model service returned an error.';
    return 'Claude Code reported a problem.';
  }

  function onResult(o) {
    const usage = o.modelUsage && typeof o.modelUsage === 'object' ? Object.entries(o.modelUsage) : [];
    for (const [model, m] of usage) {
      if (m && num(m.contextWindow) > 0) s.windows.set(model, m.contextWindow);
    }
    const cost = typeof o.total_cost_usd === 'number' && Number.isFinite(o.total_cost_usd) ? o.total_cost_usd : null;
    let e;
    if (usage.length) {
      // modelUsage and total_cost_usd are totals for the session: set them, never add them up.
      const raw = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost };
      for (const [, m] of usage) {
        if (!m) continue;
        raw.inputTokens += num(m.inputTokens);
        raw.outputTokens += num(m.outputTokens);
        raw.cacheReadTokens += num(m.cacheReadInputTokens);
        raw.cacheWriteTokens += num(m.cacheCreationInputTokens);
      }
      const shown = continueSpend(raw);
      e = { mode: 'set', ...shown };
      if (cost == null) delete e.costUsd; // not reported this time: keep what the view has
    } else {
      // No totals to set: keep the per-message counts and only update cost.
      e = { mode: 'add', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      if (cost != null) {
        e.costUsd = continueSpend({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost }).costUsd;
      }
    }
    e.unreportedUsd = unreportedUsd();
    if (s.rootContext != null) e.contextTokens = s.rootContext;
    const win = contextWindowFor(s.model);
    if (win) e.contextWindow = win;
    ev(EV.USAGE, rootId, e);

    setThinking(rootId, false);
    s.inTurn = false;
    const isError = !!o.is_error || o.subtype !== 'success';
    const finalText = typeof o.result === 'string' && o.result.trim() ? o.result : s.rootText;
    const backgroundTasks = s.bgSeen ? s.bg.size : openHelpers().length;
    const turn = { phase: 'end', finalText, backgroundTasks, background: backgroundSplit(), isError };
    if (isError) turn.reason = errorReason(o);
    ev(EV.TURN, rootId, turn);
  }

  // ---- public ----

  function push(obj) {
    out = [];
    if (!obj || typeof obj !== 'object') return out;
    try {
      switch (obj.type) {
        case 'system': onSystem(obj); break;
        case 'assistant': onAssistant(obj); break;
        case 'user': onUser(obj); break;
        case 'result': onResult(obj); break;
        default: break; // unknown message types are ignored
      }
      sendBackground();
    } catch (err) {
      // A malformed object must not stop the stream. Keep what was produced and report the problem.
      if (onError) onError(err);
    }
    return out;
  }

  /** End every helper still running, for example when the Claude Code process has gone. */
  function endOpenHelpers(state = 'stopped', reason) {
    out = [];
    for (const h of openHelpers()) endHelper(h, state, { reason });
    s.bg.clear();
    return out;
  }

  /** Call before a relaunch: the new process may count spend from zero again. */
  function processRestarted() {
    const sp = s.spend;
    // What the old process used after its last result: no result of that process will report it now.
    if (inSide(sp.tail) > 0 || sp.tail.outputTokens > 0) sp.carry = addSpend(sp.carry || ZERO, sp.tail);
    sp.tail = { ...ZERO };
    sp.restartPending = true;
    sp.rootInSince = 0;
    s.inTurn = false;
    s.tools.clear();   // tool calls of the old process will never report back
    s.pending.clear();
    s.bg.clear();
  }

  function info() {
    return {
      sessionId: s.sessionId,
      model: s.model,
      version: s.version, // the Claude Code version the last system/init reported
      inTurn: s.inTurn,
      backgroundTasks: s.bgSeen ? s.bg.size : openHelpers().length,
      background: backgroundSplit(),
      openHelpers: openHelpers().map(h => h.id),
      costUsd: s.spend.last ? s.spend.last.costUsd : null, // as Claude Code reported it
      unreportedUsd: unreportedUsd(),                     // Workbench's estimate of what it has not reported
    };
  }

  /**
   * What SendMessage may call this root's own helpers, from Claude Code's own output: each helper's workbench id,
   * its full task id (Claude Code tells the agent to continue a helper with `to: '<task id>'`) and the `name` its
   * Agent call gave it. Helpers that have ended count too: a message can continue them.
   */
  function recipients() {
    const out = new Set();
    for (const h of s.helpers.values()) {
      out.add(h.id);
      if (h.taskId) out.add(h.taskId);
      if (h.callName) out.add(h.callName);
    }
    return [...out];
  }

  /**
   * The agent behind a PreToolUse hook call: the one that issued the tool call (`tool_use_id`, while the call is
   * open), else the helper running that task (`agent_id`). Null when neither is known yet. It works whether the
   * helper was made from task_started or, before it, from its forwarded messages (then its id comes from the Agent
   * call, not from its task id).
   */
  function agentFor({ toolUseId, taskId } = {}) {
    const t = toolUseId ? s.tools.get(String(toolUseId)) : null;
    if (t) return t.agentId;
    const h = taskId ? s.byTask.get(String(taskId)) : null;
    return h ? h.id : null;
  }

  return { push, endOpenHelpers, processRestarted, info, recipients, agentFor };
}
