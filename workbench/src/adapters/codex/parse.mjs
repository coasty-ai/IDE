// Codex adapter, part 1: turns the JSON lines printed by `codex exec --json` into normalized workbench events.
//
// Pure: it keeps a little state between lines but does no I/O, and the clock is injected as `now`.
// The event shapes are in src/shared/events.mjs; the mapping is the "Codex adapter" table in ARCHITECTURE.md.
// Real samples: test/fixtures/codex-run.jsonl and codex-resume.jsonl (codex-cli 0.166.0).
import { EV } from '../../shared/events.mjs';
import { narrate, firstSentence, KIND } from '../../shared/narrate.mjs';
import { clip } from '../../shared/format.mjs';

/** Reason given when a Codex process ends in the middle of a turn without saying why. */
export const STOPPED_EARLY = 'Codex stopped before it finished.';

/**
 * Create a parser for one Codex agent. One parser can follow several processes (the first run and each
 * `resume`): per-turn state resets on `turn.started`.
 *
 * @param {{ rootId: string, now?: (() => number) | number }} opts
 * @returns {{
 *   push(obj: object): object[],   // one parsed JSON line in, normalized events out
 *   finish(): object[],            // the process ended: close what is still open; an unfinished turn ends as an error
 *   abort(): object[],             // the person stopped it: close open steps, but do not end the turn
 *   readonly threadId: string|null,
 *   readonly lastError: string|null,
 *   readonly turnOpen: boolean,
 * }}
 */
export function createCodexParser({ rootId, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => now;

  let threadId = null;
  let turnNo = 0;          // turns seen by this parser; keeps tool ids unique, since Codex restarts at item_0 every process
  let turnOpen = false;
  let turnEnded = false;   // guards against a second end for the same turn
  let finalText = null;    // the latest agent_message of the current turn
  let thinking = false;
  let lastError = null;    // the latest error text Codex reported (raw)
  let lastPlan = null;     // JSON of the last plan sent, to skip repeats
  let anon = 0;
  const open = new Map();      // item id -> { toolUseId, sentence, toolKind } for steps that started but did not end
  const finished = new Set();  // item ids already ended in this turn

  const event = (kind, fields) => ({ kind, ts: clock(), agentId: rootId, ...fields });

  function thinkingOn() {
    if (thinking) return [];
    thinking = true;
    return [event(EV.THINKING, { on: true })];
  }

  function thinkingOff() {
    if (!thinking) return [];
    thinking = false;
    return [event(EV.THINKING, { on: false })];
  }

  /** End every step that is still open. `ok: null` means we never learned how it went. */
  function closeOpen() {
    const out = [];
    for (const rec of open.values()) {
      out.push(event(EV.ACTIVITY, { phase: 'end', sentence: rec.sentence, toolKind: rec.toolKind, toolUseId: rec.toolUseId, ok: null }));
    }
    open.clear();
    return out;
  }

  /** Items that are tool calls: how they read, their input, and (once completed) whether they worked. */
  function describeTool(item) {
    switch (item.type) {
      case 'command_execution': {
        const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '');
        const n = command ? narrate('command_execution', { command }) : { sentence: 'Running a command', kind: KIND.RUN };
        // No exit code: failed or declined counts as not ok; "completed" without a code (Codex closes commands
        // still running when a turn ends that way) is unknown.
        const ok = typeof item.exit_code === 'number' ? item.exit_code === 0 : statusOk(item.status, null) === false ? false : null;
        return { ...n, input: { command }, ok, error: ok === false ? tail(item.aggregated_output) : null };
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return { ...narrate('file_change', { changes }), input: { changes }, ok: statusOk(item.status, null), error: null };
      }
      case 'mcp_tool_call': {
        const failure = item.error ? String(item.error.message ?? item.error) : null;
        const ok = failure ? false : statusOk(item.status, null);
        return { ...narrate('mcp_tool_call', { server: item.server, tool: item.tool }), input: { server: item.server, tool: item.tool }, ok, error: ok === false ? failure : null };
      }
      case 'web_search': {
        const query = String(item.query ?? item.action?.query ?? '').trim();
        const n = query ? narrate('web_search', { query }) : { sentence: 'Searching the web', kind: KIND.WEB };
        return { ...n, input: { query }, ok: statusOk(item.status, true), error: null };
      }
      default:
        return null;
    }
  }

  /** started/updated: make sure the step is open. completed: open it if needed, then end it. */
  function onTool(item, stage, tool) {
    const key = String(item.id ?? `anon-${++anon}`);
    if (finished.has(key)) return [];
    const out = [];
    let rec = open.get(key);
    if (!rec) {
      rec = { toolUseId: `t${turnNo}-${key}`, sentence: tool.sentence, toolKind: tool.kind };
      open.set(key, rec);
      thinking = false; // the store turns thinking off when a step starts
      out.push(event(EV.ACTIVITY, { phase: 'start', sentence: rec.sentence, toolKind: rec.toolKind, toolUseId: rec.toolUseId, input: tool.input }));
    }
    if (stage === 'completed') {
      open.delete(key);
      finished.add(key);
      // The completed item can read better than the started one (a web search learns its query).
      const end = { phase: 'end', sentence: tool.sentence || rec.sentence, toolKind: rec.toolKind, toolUseId: rec.toolUseId, ok: tool.ok };
      if (tool.ok === false && tool.error) end.error = tool.error;
      out.push(event(EV.ACTIVITY, end));
    }
    return out;
  }

  function onMessage(item) {
    const text = String(item.text ?? '');
    if (!text.trim()) return [];
    finalText = text;
    const out = thinkingOff();
    const said = firstSentence(text);
    if (said) out.push(event(EV.SAYS, { text: said }));
    return out;
  }

  function onPlan(list) {
    const items = (Array.isArray(list) ? list : [])
      .map(t => ({ text: String(t?.text ?? '').trim(), done: Boolean(t?.completed) }))
      .filter(t => t.text)
      .map((t, i) => ({ id: String(i + 1), text: t.text, status: t.done ? 'completed' : 'pending' }));
    const key = JSON.stringify(items);
    if (key === lastPlan) return [];
    lastPlan = key;
    return [event(EV.PLAN, { items })];
  }

  function onItem(item, stage) {
    if (!item || typeof item !== 'object') return [];
    const tool = describeTool(item);
    if (tool) return onTool(item, stage, tool);
    switch (item.type) {
      case 'reasoning': return thinkingOn();
      case 'agent_message': return stage === 'completed' ? onMessage(item) : [];
      case 'todo_list': return onPlan(item.items);
      default: return []; // unknown item types are ignored
    }
  }

  /** Close the turn. A failed turn carries a plain reason as its final text, since the engine shows it as the state reason. */
  function endTurn(before, isError, reason) {
    if (turnEnded) return [];
    const out = [...closeOpen(), ...thinkingOff(), ...before];
    const fields = { phase: 'end', finalText: isError ? reason : finalText, isError, backgroundTasks: 0 };
    if (isError) fields.error = reason;
    out.push(event(EV.TURN, fields));
    turnOpen = false;
    turnEnded = true;
    return out;
  }

  return {
    push(obj) {
      if (!obj || typeof obj !== 'object') return [];
      switch (obj.type) {
        case 'thread.started': {
          if (!obj.thread_id) return [];
          threadId = String(obj.thread_id);
          return [event(EV.SESSION, { sessionId: threadId })];
        }
        case 'turn.started': {
          const out = closeOpen(); // leftovers from a turn that never ended
          turnNo += 1;
          turnOpen = true;
          turnEnded = false;
          finalText = null;
          lastError = null;
          finished.clear();
          out.push(event(EV.TURN, { phase: 'start' }));
          return out;
        }
        case 'item.started':
          return onItem(obj.item, 'started');
        case 'item.updated':
          return onItem(obj.item, 'updated');
        case 'item.completed':
          return onItem(obj.item, 'completed');
        case 'turn.completed': {
          const usage = obj.usage && typeof obj.usage === 'object' ? [event(EV.USAGE, usageFields(obj.usage))] : [];
          return endTurn(usage, false, null);
        }
        case 'turn.failed': {
          const message = obj.error?.message ?? obj.message;
          if (message) lastError = String(message);
          return endTurn([], true, plainError(lastError) || STOPPED_EARLY);
        }
        case 'error': {
          // Not always fatal: Codex also reports reconnects and start-up warnings this way and carries on.
          // A fatal error is followed by `turn.failed`, or the process ends and `finish()` reports it.
          if (obj.message) lastError = String(obj.message);
          return [];
        }
        default:
          return []; // unknown events are ignored
      }
    },

    finish() {
      if (turnOpen) return endTurn([], true, plainError(lastError) || STOPPED_EARLY);
      return [...closeOpen(), ...thinkingOff()];
    },

    abort() {
      turnOpen = false;
      turnEnded = true;
      return [...closeOpen(), ...thinkingOff()];
    },

    get threadId() { return threadId; },
    get lastError() { return lastError; },
    get turnOpen() { return turnOpen; },
  };
}

/**
 * Token counts for one `turn.completed`. Codex's `input_tokens` is the whole prompt, cached part included, so
 * `inputTokens` keeps only the uncached part: the four counts then add up to what was processed, as for Claude.
 * Codex reports no cost.
 */
function usageFields(u) {
  const input = count(u.input_tokens);
  const cached = count(u.cached_input_tokens);
  const written = count(u.cache_write_input_tokens);
  return {
    mode: 'add',
    inputTokens: Math.max(0, input - cached - written),
    outputTokens: count(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    costUsd: null,
    contextTokens: u.input_tokens == null ? null : input,
  };
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function statusOk(status, otherwise) {
  if (status === 'completed') return true;
  if (status === 'failed' || status === 'declined' || status === 'error') return false;
  return otherwise;
}

/** The end of a command's output, where errors usually are. */
function tail(text, n = 300) {
  const s = String(text ?? '').trim();
  return s.length > n ? '…' + s.slice(-n) : s;
}

/**
 * Turn a Codex error message into one plain sentence for the person. Returns null for empty input.
 * Exported so the runner can explain a failed process the same way.
 */
export function plainError(message) {
  const raw = String(message ?? '').trim();
  if (!raw) return null;
  // API errors often embed JSON such as {"error":{"message":"..."}}; the inner message reads better.
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const text = inner ? inner[1].replace(/\\(["\\])/g, '$1') : raw;
  const all = raw + ' ' + text;
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(all)) return 'Codex has reached its usage limit for now.';
  if (/\b401\b|unauthori[sz]ed|not logged in|not signed in|log ?in again|invalid api key|missing api key|authenticat/i.test(all)) return 'Codex is not signed in, or its sign-in has expired.';
  if (/context (window|length)|maximum context|too many tokens|prompt is too long/i.test(all)) return 'The conversation grew too long for the model.';
  if (/(model|deployment).{0,40}(not found|does not exist|not supported|unsupported|unavailable)|unknown model|invalid model/i.test(all)) return 'Codex could not use the chosen model.';
  if (/(session|thread|conversation|rollout).{0,40}(not found|no such|does not exist)|no saved session/i.test(all)) return 'Codex could not find the earlier conversation to continue.';
  if (/trusted directory|skip-git-repo-check|not a git repo/i.test(all)) return 'Codex only works inside a git repository.';
  if (/stream disconnected|reconnecting|connection (reset|refused|closed)|network error|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|\b50[234]\b/i.test(all)) return 'Codex lost its connection to the model.';
  const first = text.split('\n').map(s => s.trim()).find(Boolean) || text;
  return 'Codex stopped with an error: ' + clip(first.replace(/^(error|fatal)\s*:\s*/i, '').replace(/[:\s]+$/, ''), 140);
}
