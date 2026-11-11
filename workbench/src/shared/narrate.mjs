// Turns agent tool calls into short plain-language sentences.
// Shared by the engine and the UI. No Node imports.
import { clip } from './format.mjs';

/** Kinds of activity, used for the hover-card counts. */
export const KIND = Object.freeze({
  READ: 'read', SEARCH: 'search', EDIT: 'edit', RUN: 'run', WEB: 'web',
  HELPER: 'helper', PLAN: 'plan', TALK: 'talk', OTHER: 'other',
});

export function baseName(p) {
  if (!p) return 'a file';
  const parts = String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || String(p);
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function lower1(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
function noDot(s) { return String(s || '').trim().replace(/[.\s]+$/, ''); }
function quoted(s, n = 32) { return '“' + clip(String(s), n) + '”'; }

const TEST_RE = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+(--test\b|\S*test\S*)|\b(pytest|jest|vitest|mocha|rspec|phpunit)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+test\b|\bdeno\s+test\b/;
const INSTALL_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bgo\s+get\b/;
const BUILD_RE = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|^\s*make(\s+(all|build))?\s*$|\bcargo\s+build\b|\bgo\s+build\b|\btsc\b/;
const LINT_RE = /\b(eslint|prettier|ruff|flake8|black|rubocop|golangci-lint)\b|\b(npm|pnpm|yarn)\s+run\s+(lint|format)\b/;

/** Describe a shell command in a few words. */
export function describeCommand(command, description) {
  const c = String(command || '').replace(/^\/bin\/(z|ba)?sh\s+-l?c\s+/, '').replace(/^['"]|['"]$/g, '');
  if (TEST_RE.test(c)) return 'Running the tests';
  if (INSTALL_RE.test(c)) return 'Installing packages';
  if (LINT_RE.test(c)) return 'Checking the code style';
  if (BUILD_RE.test(c)) return 'Building the project';
  if (/^\s*git\s+(status|diff|log|show)\b/.test(c)) return 'Checking what changed';
  if (/^\s*git\s+commit\b/.test(c)) return 'Saving its changes in git';
  if (/^\s*git\s+push\b/.test(c)) return 'Pushing changes';
  if (/^\s*(ls|find|tree|rg\s+--files|fd)\b/.test(c)) return 'Looking at the files';
  if (/^\s*(cat|head|tail|less|sed\s+-n|bat)\b/.test(c)) return 'Reading a file';
  if (/^\s*(rg|grep|ag|ack)\b/.test(c)) return 'Searching the code';
  if (description) return cap(noDot(description));
  return 'Running ' + clip(c, 40);
}

/**
 * Narrate one tool call.
 * @param {string} tool  tool name (Claude Code) or item type (Codex)
 * @param {object} input tool input
 * @returns {{ sentence: string, kind: string }}
 */
export function narrate(tool, input = {}) {
  const i = input || {};
  switch (tool) {
    case 'Read': case 'NotebookRead':
      return { sentence: 'Reading ' + baseName(i.file_path || i.notebook_path), kind: KIND.READ };
    case 'Write':
      return { sentence: 'Writing ' + baseName(i.file_path), kind: KIND.EDIT };
    case 'Edit': case 'MultiEdit':
      return { sentence: 'Editing ' + baseName(i.file_path), kind: KIND.EDIT };
    case 'NotebookEdit':
      return { sentence: 'Editing ' + baseName(i.notebook_path), kind: KIND.EDIT };
    case 'Glob':
      return { sentence: 'Looking for files like ' + clip(i.pattern || '', 28), kind: KIND.SEARCH };
    case 'Grep':
      return { sentence: 'Searching for ' + quoted(i.pattern || ''), kind: KIND.SEARCH };
    case 'LS':
      return { sentence: 'Looking around ' + baseName(i.path), kind: KIND.SEARCH };
    case 'Bash': case 'command_execution':
      return { sentence: describeCommand(i.command, i.description), kind: KIND.RUN };
    case 'Agent': case 'Task':
      return { sentence: 'Asking a helper to ' + lower1(noDot(i.description || 'help')), kind: KIND.HELPER };
    case 'TaskCreate':
      return { sentence: 'Adding a step to its plan', kind: KIND.PLAN };
    case 'TaskUpdate': case 'TodoWrite': case 'todo_list':
      return { sentence: 'Updating its plan', kind: KIND.PLAN };
    case 'TaskList': case 'TaskGet':
      return { sentence: 'Checking its plan', kind: KIND.PLAN };
    case 'TaskOutput':
      return { sentence: 'Checking on a helper', kind: KIND.HELPER };
    case 'TaskStop':
      return { sentence: 'Stopping a helper', kind: KIND.HELPER };
    case 'WebSearch': case 'web_search':
      return { sentence: 'Searching the web for ' + quoted(i.query || ''), kind: KIND.WEB };
    case 'WebFetch': {
      let host = '';
      try { host = new URL(i.url).hostname.replace(/^www\./, ''); } catch {}
      return { sentence: 'Reading a web page' + (host ? ' on ' + host : ''), kind: KIND.WEB };
    }
    case 'file_change': {
      const ch = Array.isArray(i.changes) ? i.changes : [];
      const names = ch.slice(0, 2).map(c => baseName(c.path)).join(', ');
      return { sentence: 'Editing ' + (names || 'files') + (ch.length > 2 ? ` and ${ch.length - 2} more` : ''), kind: KIND.EDIT };
    }
    case 'ToolSearch':
      return { sentence: 'Looking up a tool', kind: KIND.OTHER };
    case 'Skill':
      return { sentence: 'Using the ' + (i.skill || i.name || 'a') + ' skill', kind: KIND.OTHER };
    case 'Monitor':
      return { sentence: 'Watching a background task', kind: KIND.OTHER };
    case 'SendMessage':
      return { sentence: 'Sending a message to a helper', kind: KIND.HELPER };
    case 'reasoning':
      return { sentence: 'Thinking', kind: KIND.TALK };
    case 'agent_message':
      return { sentence: 'Writing a reply', kind: KIND.TALK };
    case 'mcp_tool_call':
      return { sentence: `Using ${i.server || 'a tool'}${i.tool ? ' (' + i.tool + ')' : ''}`, kind: KIND.OTHER };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(tool));
      if (m) return { sentence: `Using ${m[1].replace(/^plugin_[^_]+_/, '')} (${m[2]})`, kind: KIND.OTHER };
      return { sentence: 'Using ' + tool, kind: KIND.OTHER };
    }
  }
}

const PAST = [
  [/^Reading\b/, 'Read'], [/^Writing a reply\b/, 'Wrote a reply'], [/^Writing\b/, 'Wrote'], [/^Editing\b/, 'Edited'],
  [/^Running\b/, 'Ran'], [/^Searching\b/, 'Searched'], [/^Looking\b/, 'Looked'], [/^Asking\b/, 'Asked'],
  [/^Installing\b/, 'Installed'], [/^Checking\b/, 'Checked'], [/^Building\b/, 'Built'], [/^Adding\b/, 'Added'],
  [/^Updating\b/, 'Updated'], [/^Using\b/, 'Used'], [/^Thinking\b/, 'Thought'], [/^Saving\b/, 'Saved'],
  [/^Pushing\b/, 'Pushed'], [/^Stopping\b/, 'Stopped'], [/^Sending\b/, 'Sent'], [/^Watching\b/, 'Watched'],
  [/^Starting\b/, 'Started'], [/^Waiting\b/, 'Waited'],
];

/** "Running the tests" -> "Ran the tests", for steps that are finished. Other text is left alone. */
export function pastTense(sentence) {
  const s = String(sentence || '');
  for (const [re, past] of PAST) if (re.test(s)) return s.replace(re, past);
  return s;
}

/**
 * Describe what an agent is asking permission to do, for the person.
 * @returns {{ sentence: string, detail: string }}
 */
export function describeRequest(tool, input = {}) {
  const i = input || {};
  switch (tool) {
    case 'Bash':
      return { sentence: 'wants to run a command', detail: String(i.command || '') };
    case 'Write':
      return { sentence: 'wants to create ' + baseName(i.file_path), detail: String(i.file_path || '') };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return { sentence: 'wants to change ' + baseName(i.file_path || i.notebook_path), detail: String(i.file_path || i.notebook_path || '') };
    case 'WebFetch':
      return { sentence: 'wants to open a web page', detail: String(i.url || '') };
    case 'WebSearch':
      return { sentence: 'wants to search the web', detail: String(i.query || '') };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(tool));
      if (m) return { sentence: `wants to use ${m[1]} (${m[2]})`, detail: clip(JSON.stringify(i), 300) };
      return { sentence: 'wants to use ' + tool, detail: clip(JSON.stringify(i), 300) };
    }
  }
}

const FILLER = /^(please|pls|can you|could you|would you|i want you to|i need you to|go and|try to|help me|let's|lets)\s+/i;
const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'this', 'that', 'some', 'please', 'just', 'quickly', 'really']);
const TRAILING = new Set(['and', 'or', 'to', 'for', 'of', 'with', 'in', 'on', 'at', 'by', 'from', 'so', 'then', 'that', 'the', 'a', 'an']);

/** A short name for an agent from its task: "Fix the flaky checkout test" -> "Fix flaky checkout test". */
export function nameFromTask(task, maxWords = 4) {
  let t = String(task || '').replace(/[`"“”'’]/g, '').replace(/\s+/g, ' ').trim();
  for (let k = 0; k < 3; k++) t = t.replace(FILLER, '');
  const words = t.split(' ').filter(w => w && !STOP.has(w.toLowerCase()));
  const picked = [];
  for (const w of words) {
    const clean = w.replace(/[.,;:!?()]+$/g, '');
    if (!clean) continue;
    picked.push(clean);
    if (picked.length >= maxWords) break;
    if (/[.;:!?]$/.test(w)) break;
  }
  while (picked.length > 1 && TRAILING.has(picked[picked.length - 1].toLowerCase())) picked.pop();
  const name = picked.join(' ');
  return cap(clip(name || 'New task', 30));
}

/** Strip markdown so text reads as plain prose. */
export function plain(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First sentence of a message, in plain prose. */
export function firstSentence(text, n = 160) {
  const p = plain(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(p);
  return clip(m ? m[1] : p, n);
}

const ASKING = /\b(would you like|should i|shall i|do you want|want me to|do you prefer|which (one|option|approach|would you)|can you confirm|please confirm|let me know (if|whether|which)|is it ok(ay)? (if|to)|may i|ok to proceed)\b/i;

/**
 * If a final message ends by asking the person something, return that question.
 * Looks only at the last paragraph, so a question in the middle of a report does not count.
 */
export function extractQuestion(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const last = plain(paras[paras.length - 1] || raw);
  const sentences = last.match(/[^.!?]+[.!?]*/g) || [last];
  const tail = sentences.map(s => s.trim()).filter(Boolean);
  for (let k = tail.length - 1; k >= Math.max(0, tail.length - 3); k--) {
    const s = tail[k];
    if (/\?\s*$/.test(s) || ASKING.test(s)) return clip(s, 220);
  }
  return null;
}
