import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClaudeParser, helperIdFor } from '../src/adapters/claude/parse.mjs';
import { EV } from '../src/shared/events.mjs';

const ROOT = 'abc123';
const HELPER = 'abc123-a71ea18c';
const AGENT_CALL = 'toolu_01Uyrz1pPp9aSJfDmFyVShEL';

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function run(objs, opts = {}) {
  const p = createClaudeParser({ rootId: ROOT, now: () => 1234, onError: (e) => { throw e; }, ...opts });
  const events = [];
  for (const o of objs) events.push(...p.push(o));
  return { p, events };
}

const of = (events, kind, agentId) => events.filter((e) => e.kind === kind && (agentId === undefined || e.agentId === agentId));

/** The usage part of the store's reducer, enough to check totals the way the UI will see them. */
function reduceUsage(events, agentId) {
  const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, contextTokens: null, contextWindow: null };
  for (const e of of(events, EV.USAGE, agentId)) {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      u[k] = e.mode === 'set' ? e[k] : u[k] + e[k];
    }
    if ('costUsd' in e) u.costUsd = e.costUsd;
    if (e.contextTokens != null) u.contextTokens = e.contextTokens;
    if (e.contextWindow != null) u.contextWindow = e.contextWindow;
  }
  return u;
}

// Synthetic stream objects for the edge cases the fixtures do not cover.
const init = (sid = 'sess-1') => ({ type: 'system', subtype: 'init', model: 'claude-test', session_id: sid });
const assistant = (id, content, ptu = null, usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) =>
  ({ type: 'assistant', parent_tool_use_id: ptu, message: { id, model: 'claude-test', role: 'assistant', content, usage } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (id, content, isError = false, ptu = null, extra = {}) =>
  ({ type: 'user', parent_tool_use_id: ptu, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...extra });
const result = (fields = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01,
  modelUsage: { 'claude-test': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 100000 } },
  ...fields,
});

// ---------- the sub-agent fixture ----------

test('a sub-agent becomes a helper of the root, with a plain name', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  const created = of(events, EV.CREATED);
  assert.equal(created.length, 1);
  const c = created[0];
  assert.equal(c.kind, 'agent.created');
  assert.equal(c.agentId, HELPER);
  assert.equal(c.parentId, ROOT);
  assert.equal(c.name, 'List repository files');
  assert.equal(c.helperType, 'Explore');
  assert.equal(c.harness, 'claude');
  assert.equal(c.task, 'List all files in this repository and explain what greet.js does and its purpose.');
  // Created, then working at once.
  const i = events.indexOf(c);
  assert.deepEqual({ kind: events[i + 1].kind, agentId: events[i + 1].agentId, state: events[i + 1].state },
    { kind: EV.STATE, agentId: HELPER, state: 'working' });
});

test('the helper finishes exactly once and says its summary', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  assert.deepEqual(of(events, EV.STATE, HELPER).map((e) => e.state), ['working', 'finished']);
  const ended = of(events, EV.ENDED, HELPER);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome, 'ok');
  const says = of(events, EV.SAYS, HELPER);
  assert.equal(says.length, 1, 'task_updated ends it, task_notification still gives the summary');
  assert.match(says[0].text, /^Repository Files This repository contains 3 files/);
  assert.ok(!/[#*`]/.test(says[0].text), 'plain prose, no markdown');
});

test('root turns: three starts and three ends, with background tasks 1, 1, then 0', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  const turns = of(events, EV.TURN, ROOT);
  assert.deepEqual(turns.map((t) => t.phase), ['start', 'end', 'start', 'end', 'start', 'end']);
  const ends = turns.filter((t) => t.phase === 'end');
  assert.deepEqual(ends.map((t) => t.backgroundTasks), [1, 1, 0]);
  assert.deepEqual(ends.map((t) => t.isError), [false, false, false]);
  assert.equal(ends[0].finalText, "Agent is running in the background. I'll wait for it to complete before running the test.");
  assert.equal(ends[2].finalText, 'The greet.js module is functioning correctly—the test passed successfully.');
  assert.equal(of(events, EV.TURN, HELPER).length, 0, 'helpers have no turns');
});

test('cost is set from the cumulative session total, never summed', () => {
  const { events, p } = run(fixture('claude-subagent-run.jsonl'));
  const costs = of(events, EV.USAGE, ROOT).filter((e) => 'costUsd' in e);
  assert.deepEqual(costs.map((e) => e.costUsd), [0.047425100000000005, 0.0508996, 0.0797947]);
  assert.ok(costs.every((e) => e.mode === 'set'));
  const u = reduceUsage(events, ROOT);
  assert.equal(u.costUsd, 0.0797947);
  assert.deepEqual(
    [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens],
    [84, 2194, 166632, 41662],
    'token totals are the sums over modelUsage',
  );
  assert.equal(u.contextWindow, 200000);
  assert.equal(u.contextTokens, 8 + 30499 + 259, 'context of the latest root message');
  assert.equal(p.info().costUsd, 0.0797947);
});

test('usage is counted once per message id, for the root and the helper', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  const rootAdds = of(events, EV.USAGE, ROOT).filter((e) => e.mode === 'add');
  assert.equal(rootAdds.length, 6, 'six distinct root message ids');
  assert.equal(rootAdds.reduce((n, e) => n + e.inputTokens, 0), 58);
  const helperUsage = of(events, EV.USAGE, HELPER);
  assert.equal(helperUsage.length, 3, 'three distinct helper message ids, though one repeats four times');
  assert.ok(helperUsage.every((e) => e.mode === 'add' && !('costUsd' in e)));
  const h = reduceUsage(events, HELPER);
  assert.deepEqual([h.inputTokens, h.cacheReadTokens, h.cacheWriteTokens], [26, 20248, 10904]);
});

test('helper steps come from forwarded messages and progress, without double counting', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  const acts = of(events, EV.ACTIVITY, HELPER);
  const starts = acts.filter((e) => e.phase === 'start');
  assert.deepEqual(starts.map((e) => e.sentence), ['Looking at the files', 'Looking at the files', 'Reading greet.js', 'Reading README.md']);
  const ends = acts.filter((e) => e.phase === 'end');
  assert.equal(ends.length, 4);
  assert.ok(ends.every((e) => e.ok === true));
  // Nothing of the helper's is blamed on the root.
  const rootStarts = of(events, EV.ACTIVITY, ROOT).filter((e) => e.phase === 'start');
  assert.deepEqual(rootStarts.map((e) => e.sentence), [
    'Looking up a tool',
    'Adding a step to its plan',
    'Asking a helper to list repository files and explain greet.js',
    'Running the tests',
  ]);
  assert.equal(of(events, EV.ACTIVITY, ROOT).filter((e) => e.phase === 'end').length, 4);
});

test('the plan item comes from TaskCreate, with the id from its result', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  const plans = of(events, EV.PLAN, ROOT);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].items, [{ id: '1', text: 'Explore repo and test greet.js', status: 'pending' }]);
});

test('model, session and thinking for the root', () => {
  const { events } = run(fixture('claude-subagent-run.jsonl'));
  assert.equal(of(events, EV.MODEL, ROOT)[0].model, 'claude-haiku-4-5-20251001');
  assert.equal(of(events, EV.SESSION, ROOT)[0].sessionId, '2ec20342-9d0d-4021-84b7-56de6b399622');
  assert.equal(of(events, EV.MODEL, HELPER)[0].model, 'claude-haiku-4-5-20251001');
  // As the store sees it: thinking events, and activity starts (which turn thinking off).
  let thinking = false;
  let changes = 0;
  for (const e of events.filter((x) => x.agentId === ROOT)) {
    if (e.kind === EV.ACTIVITY && e.phase === 'start') thinking = false;
    if (e.kind === EV.THINKING) {
      assert.notEqual(e.on, thinking, 'only changes are reported');
      thinking = e.on;
      changes++;
    }
  }
  assert.ok(changes >= 4);
  assert.equal(thinking, false, 'not thinking once the run is over');
  assert.ok(events.every((e) => e.ts === 1234 && typeof e.kind === 'string' && e.kind.includes('.')));
});

// ---------- the permission fixtures ----------

test('a denied Bash call ends its step with ok false and the reason', () => {
  const { events } = run(fixture('claude-denied-bash.jsonl'));
  const acts = of(events, EV.ACTIVITY, ROOT);
  assert.deepEqual(acts.map((e) => [e.phase, e.sentence]), [['start', 'Running the tests'], ['end', 'Running the tests']]);
  assert.equal(acts[1].ok, false);
  assert.equal(acts[1].error, 'The user said no to running this command.');
  assert.equal(acts[1].toolUseId, 'toolu_01RpG1BFE1BuJYUDkbJA7AvK');
  const end = of(events, EV.TURN, ROOT).find((e) => e.phase === 'end');
  assert.equal(end.isError, false);
  assert.equal(end.backgroundTasks, 0);
  assert.match(end.finalText, /Would you like me to proceed/);
  assert.equal(reduceUsage(events, ROOT).costUsd, 0.02468005);
});

test('a held then allowed Bash call starts and ends normally', () => {
  const { events } = run(fixture('claude-held-bash.jsonl'));
  const acts = of(events, EV.ACTIVITY, ROOT);
  assert.deepEqual(acts.map((e) => [e.phase, e.sentence, e.ok]), [['start', 'Running the tests', undefined], ['end', 'Running the tests', true]]);
  assert.equal(acts[0].tool, 'Bash');
  assert.match(acts[0].input, /node test\.mjs/);
  const end = of(events, EV.TURN, ROOT).find((e) => e.phase === 'end');
  assert.equal(end.finalText, 'The test script ran successfully and printed "ok".');
  assert.equal(reduceUsage(events, ROOT).costUsd, 0.0245938);
});

// ---------- edge cases ----------

test('task_progress before the forwarded message is not counted twice', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('call', 'Agent', { description: 'Check the docs', subagent_type: 'Explore', prompt: 'Check the docs' })]),
    { type: 'system', subtype: 'task_started', task_id: 'feedbeef00', tool_use_id: 'call', description: 'Check the docs', subagent_type: 'Explore' },
    { type: 'system', subtype: 'task_progress', task_id: 'feedbeef00', tool_use_id: 'call', description: 'Reading a.md', usage: { tool_uses: 1 }, last_tool_name: 'Read' },
    assistant('h1', [toolUse('r1', 'Read', { file_path: '/x/a.md' })], 'call'),
    toolResult('r1', 'text', false, 'call'),
    assistant('h1', [toolUse('r2', 'Read', { file_path: '/x/b.md' })], 'call'),
    { type: 'system', subtype: 'task_progress', task_id: 'feedbeef00', tool_use_id: 'call', description: 'Reading b.md', usage: { tool_uses: 2 }, last_tool_name: 'Read' },
    { type: 'system', subtype: 'task_progress', task_id: 'feedbeef00', tool_use_id: 'call', description: 'Searching for “x”', usage: { tool_uses: 3 }, last_tool_name: 'Grep' },
  ]);
  const helper = 'abc123-feedbeef';
  const starts = of(events, EV.ACTIVITY, helper).filter((e) => e.phase === 'start');
  assert.deepEqual(starts.map((e) => [e.sentence, e.toolKind]), [['Reading a.md', 'read'], ['Reading b.md', 'read'], ['Searching for “x”', 'search']]);
  const ends = of(events, EV.ACTIVITY, helper).filter((e) => e.phase === 'end');
  assert.equal(ends.length, 1, 'the forwarded result still ends its step');
});

test('task_progress without a tool count falls back to comparing sentences', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('call', 'Task', { description: 'Look around' })]),
    { type: 'system', subtype: 'task_started', task_id: 'aaaabbbbcccc', tool_use_id: 'call', description: 'Look around' },
    { type: 'system', subtype: 'task_progress', task_id: 'aaaabbbbcccc', description: 'Reading a.md' },
    { type: 'system', subtype: 'task_progress', task_id: 'aaaabbbbcccc', description: 'Reading a.md' },
    { type: 'system', subtype: 'task_progress', task_id: 'aaaabbbbcccc', description: 'Reading b.md' },
  ]);
  const starts = of(events, EV.ACTIVITY, 'abc123-aaaabbbb').filter((e) => e.phase === 'start');
  assert.deepEqual(starts.map((e) => e.sentence), ['Reading a.md', 'Reading b.md']);
});

test('helpers are created from forwarded messages when task_started is late, without duplicates', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('toolu_01ABCDEFGHxyz', 'Agent', { description: 'Write the tests', subagent_type: 'general-purpose' })]),
    assistant('h1', [{ type: 'text', text: 'On it.' }], 'toolu_01ABCDEFGHxyz'),
    { type: 'system', subtype: 'task_started', task_id: '0123456789abcdef', tool_use_id: 'toolu_01ABCDEFGHxyz', description: 'Write the tests' },
    { type: 'system', subtype: 'task_notification', task_id: '0123456789abcdef', status: 'failed', summary: 'Could not find the test folder. Gave up.' },
  ]);
  const created = of(events, EV.CREATED);
  assert.equal(created.length, 1);
  assert.equal(created[0].agentId, 'abc123-01ABCDEF');
  assert.equal(created[0].name, 'Write tests');
  const states = of(events, EV.STATE, 'abc123-01ABCDEF');
  assert.deepEqual(states.map((e) => e.state), ['working', 'failed']);
  assert.equal(states[1].reason, 'Could not find the test folder.');
  assert.equal(of(events, EV.ENDED, 'abc123-01ABCDEF')[0].outcome, 'error');
});

test('a helper launched by a helper hangs under it', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('outer', 'Agent', { description: 'Plan the work' })]),
    { type: 'system', subtype: 'task_started', task_id: '11111111aa', tool_use_id: 'outer', description: 'Plan the work', subagent_type: 'Plan' },
    assistant('h1', [toolUse('inner', 'Agent', { description: 'Search the code' })], 'outer'),
    { type: 'system', subtype: 'task_started', task_id: '22222222bb', tool_use_id: 'inner', description: 'Search the code', subagent_type: 'Explore' },
    assistant('h2', [toolUse('g1', 'Grep', { pattern: 'TODO' })], 'inner'),
    toolResult('g1', 'none', false, 'inner'),
  ]);
  const created = of(events, EV.CREATED);
  assert.deepEqual(created.map((c) => [c.agentId, c.parentId]), [['abc123-11111111', ROOT], ['abc123-22222222', 'abc123-11111111']]);
  assert.equal(of(events, EV.ACTIVITY, 'abc123-11111111').filter((e) => e.phase === 'start')[0].sentence, 'Asking a helper to search the code');
  assert.deepEqual(of(events, EV.ACTIVITY, 'abc123-22222222').map((e) => e.phase), ['start', 'end']);
});

test('background work that is not a sub-agent counts as background but is not a helper', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('b1', 'Bash', { command: 'npm run dev', run_in_background: true })]),
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'shell1', task_type: 'local_bash', description: 'Start the dev server' }] },
    { type: 'system', subtype: 'task_started', task_id: 'shell1', tool_use_id: 'b1', description: 'Start the dev server', task_type: 'local_bash' },
    toolResult('b1', 'Command running in background'),
    result(),
  ]);
  assert.equal(of(events, EV.CREATED).length, 0);
  assert.equal(of(events, EV.TURN, ROOT).find((e) => e.phase === 'end').backgroundTasks, 1);
});

test('plans: TaskUpdate changes an item, deleted removes it, TodoWrite replaces a plan', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('c1', 'TaskCreate', { subject: 'Read the code' })]),
    toolResult('c1', 'Task #7 created successfully: Read the code'),
    assistant('m1', [toolUse('c2', 'TaskCreate', { subject: 'Fix the bug' })]),
    toolResult('c2', 'Task #8 created successfully: Fix the bug', false, null, { tool_use_result: { task: { id: '8', subject: 'Fix the bug' } } }),
    assistant('m2', [toolUse('u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' })]),
    assistant('m2', [toolUse('u2', 'TaskUpdate', { taskId: 7, status: 'completed', subject: 'Read all the code' })]),
    assistant('m2', [toolUse('u3', 'TaskUpdate', { taskId: '8', status: 'deleted' })]),
    assistant('m2', [toolUse('u4', 'TaskUpdate', { taskId: '99', status: 'completed' })]),
  ]);
  const plans = of(events, EV.PLAN, ROOT);
  assert.deepEqual(plans.at(-1).items, [{ id: '7', text: 'Read all the code', status: 'completed' }]);
  assert.deepEqual(plans[1].items, [{ id: '7', text: 'Read the code', status: 'pending' }], 'the id is fixed from "Task #7 created"');
  assert.equal(plans.length, 7, 'one plan event per change; an unknown task id changes nothing');

  const todo = run([
    init(),
    assistant('m1', [toolUse('t1', 'TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }, { content: 'Test', status: 'pending' }] })]),
    assistant('m2', [toolUse('t2', 'TodoWrite', { todos: [{ content: 'Ship', status: 'pending' }] })]),
  ]).events;
  const todoPlans = of(todo, EV.PLAN, ROOT);
  assert.deepEqual(todoPlans[0].items.map((i) => [i.text, i.status]), [['Read', 'completed'], ['Write', 'in_progress'], ['Test', 'pending']]);
  assert.deepEqual(todoPlans[1].items.map((i) => i.text), ['Ship']);
});

test('a failed TaskCreate removes its plan item', () => {
  const { events } = run([
    init(),
    assistant('m1', [toolUse('c1', 'TaskCreate', { subject: 'Read the code' })]),
    toolResult('c1', 'Error: no task list', true),
  ]);
  assert.deepEqual(of(events, EV.PLAN, ROOT).map((p) => p.items.length), [1, 0]);
});

test('an error result ends the turn with isError and a plain reason', () => {
  const { events } = run([init(), result({ subtype: 'error_max_budget_usd', is_error: true, result: undefined })]);
  const end = of(events, EV.TURN, ROOT).find((e) => e.phase === 'end');
  assert.equal(end.isError, true);
  assert.equal(end.reason, 'It reached its spending limit.');

  const api = run([init(), result({ is_error: true, result: 'API Error: 529 **Overloaded**' })]).events;
  const apiEnd = of(api, EV.TURN, ROOT).find((e) => e.phase === 'end');
  assert.equal(apiEnd.isError, true);
  assert.equal(apiEnd.reason, 'Claude Code reported a problem: API Error: 529 Overloaded');

  const odd = run([init(), result({ subtype: 'error_during_execution' })]).events;
  assert.equal(of(odd, EV.TURN, ROOT).find((e) => e.phase === 'end').isError, true, 'subtype other than success is an error');
});

test('the final text falls back to the latest root text', () => {
  const { events } = run([
    init(),
    assistant('m1', [{ type: 'text', text: 'I fixed the redirect.' }]),
    assistant('h1', [{ type: 'text', text: 'helper text' }], 'unknown-call'),
    result({ result: '' }),
  ]);
  assert.equal(of(events, EV.TURN, ROOT).find((e) => e.phase === 'end').finalText, 'I fixed the redirect.');
  assert.equal(of(events, EV.USAGE).length, 2, 'messages from an unknown helper are dropped, not blamed on the root');
});

test('unknown and malformed input is ignored', () => {
  const p = createClaudeParser({ rootId: ROOT, onError: (e) => { throw e; } });
  assert.deepEqual(p.push({ type: 'stream_event', event: {} }), []);
  assert.deepEqual(p.push({ type: 'system', subtype: 'compact_boundary' }), []);
  assert.deepEqual(p.push({ type: 'rate_limit_event' }), []);
  assert.deepEqual(p.push(null), []);
  assert.deepEqual(p.push('text'), []);
  assert.deepEqual(p.push({ type: 'assistant' }), []);
  assert.deepEqual(p.push({ type: 'user', message: { content: 'plain text' } }), []);
  assert.deepEqual(p.push({ type: 'system', subtype: 'task_progress', task_id: 'nobody' }), []);
  assert.throws(() => createClaudeParser({}), /root agent/);
});

test('thinking_tokens between turns do not mark the root as thinking', () => {
  const { events } = run([
    init(),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 6 },
    assistant('m1', [{ type: 'thinking', thinking: '...' }, toolUse('r1', 'Read', { file_path: 'a.js' })]),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 9 },
    assistant('m2', [{ type: 'text', text: 'Done.' }]),
    result(),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 },
  ]);
  assert.deepEqual(of(events, EV.THINKING, ROOT).map((e) => e.on), [true, true, false]);
});

test('endOpenHelpers stops helpers that are still running', () => {
  const { p } = run([
    init(),
    assistant('m1', [toolUse('call', 'Agent', { description: 'Check links' })]),
    { type: 'system', subtype: 'task_started', task_id: 'cafecafe99', tool_use_id: 'call', description: 'Check links', subagent_type: 'Explore' },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'cafecafe99' }] },
  ]);
  assert.deepEqual(p.info().openHelpers, ['abc123-cafecafe']);
  assert.equal(p.info().backgroundTasks, 1);
  const ends = p.endOpenHelpers('stopped', 'It was stopped.');
  assert.deepEqual(ends.map((e) => [e.kind, e.state || e.outcome]), [[EV.STATE, 'stopped'], [EV.ENDED, 'stopped']]);
  assert.equal(ends[0].reason, 'It was stopped.');
  assert.deepEqual(p.endOpenHelpers('stopped'), [], 'only once');
  assert.equal(p.info().backgroundTasks, 0);
});

test('spend continues across a relaunch whether or not the new process counts from zero', () => {
  const usage = (cost, input) => result({ total_cost_usd: cost, modelUsage: { m: { inputTokens: input, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  // Counts from zero again: carry the earlier totals.
  const fresh = run([init(), usage(0.5, 100)]);
  fresh.p.processRestarted();
  const after = [...fresh.p.push(init()), ...fresh.p.push(usage(0.1, 20)), ...fresh.p.push(usage(0.2, 30))];
  const freshCosts = of(after, EV.USAGE, ROOT).map((e) => [e.costUsd, e.inputTokens]);
  assert.deepEqual(freshCosts.map(([c, t]) => [Math.round(c * 1000) / 1000, t]), [[0.6, 120], [0.7, 130]]);
  // Restores its totals: keep them as they are.
  const restored = run([init(), usage(0.5, 100)]);
  restored.p.processRestarted();
  const after2 = [...restored.p.push(init()), ...restored.p.push(usage(0.55, 110))];
  assert.deepEqual(of(after2, EV.USAGE, ROOT).map((e) => [e.costUsd, e.inputTokens]), [[0.55, 110]]);

  // Counts from zero, but its first turn costs more than everything before: the message tokens tell.
  const msg = (id, input) => assistant(id, [{ type: 'text', text: 'ok' }], null, { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const big = run([init(), msg('a1', 100), usage(0.05, 100)]);
  big.p.processRestarted();
  const after3 = [...big.p.push(init()), ...big.p.push(msg('b1', 500)), ...big.p.push(usage(0.06, 500))];
  const last3 = of(after3, EV.USAGE, ROOT).at(-1);
  assert.deepEqual([Math.round(last3.costUsd * 100) / 100, last3.inputTokens], [0.11, 600]);
  // The same message tokens on top of the old totals mean the totals were kept.
  const kept = run([init(), msg('a1', 100), usage(0.05, 100)]);
  kept.p.processRestarted();
  const after4 = [...kept.p.push(init()), ...kept.p.push(msg('b1', 500)), ...kept.p.push(usage(0.11, 600))];
  const last4 = of(after4, EV.USAGE, ROOT).at(-1);
  assert.deepEqual([last4.costUsd, last4.inputTokens], [0.11, 600]);
});

test('helper ids keep only safe characters', () => {
  assert.equal(helperIdFor('abc123', 'a71ea18c16a7bba8d'), 'abc123-a71ea18c');
  assert.equal(helperIdFor('abc123', 'toolu_01Uy/z:1pPp9'), 'abc123-01Uyz1pP');
  assert.ok(!/[/:]/.test(helperIdFor('r', 'a/b:c/d:e/f:g/h')));
});

test('the Agent tool result is launch metadata, not the end of the helper', () => {
  const lines = fixture('claude-subagent-run.jsonl');
  const upToLaunch = lines.slice(0, lines.findIndex((o) => o.type === 'user' && o.message.content[0].tool_use_id === AGENT_CALL) + 1);
  const { events, p } = run(upToLaunch);
  assert.deepEqual(of(events, EV.STATE, HELPER).map((e) => e.state), ['working']);
  assert.deepEqual(p.info().openHelpers, [HELPER]);
  // A foreground helper that reports completion in its result is ended by it.
  const sync = run([
    init(),
    assistant('m1', [toolUse('fg', 'Agent', { description: 'Summarize the readme' })]),
    { type: 'system', subtype: 'task_started', task_id: 'beefbeef11', tool_use_id: 'fg', description: 'Summarize the readme' },
    toolResult('fg', [{ type: 'text', text: 'The readme explains setup. More later.' }], false, null, { tool_use_result: { status: 'completed' } }),
  ]).events;
  assert.deepEqual(of(sync, EV.STATE, 'abc123-beefbeef').map((e) => e.state), ['working', 'finished']);
  assert.equal(of(sync, EV.SAYS, 'abc123-beefbeef')[0].text, 'The readme explains setup.');
});
