import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.mjs';
import { EV, SPARK_BUCKET_MS, SPARK_BUCKETS } from '../src/shared/events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, `.store-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0); // a fixed moment, aligned to the spark grid

function created(agentId, extra = {}) {
  return { kind: EV.CREATED, ts: T0, agentId, parentId: null, name: 'Fix login', task: 'Fix the login', harness: 'claude', machineId: 'laptop', ...extra };
}
function state(agentId, s, ts = T0 + 1000, extra = {}) {
  return { kind: EV.STATE, ts, agentId, state: s, ...extra };
}
function act(agentId, phase, sentence, ts = T0 + 1000, extra = {}) {
  return { kind: EV.ACTIVITY, ts, agentId, phase, sentence, toolKind: 'read', ...extra };
}
/** A store that records every 'agents' emission. */
function recording() {
  const s = new Store();
  const emitted = [];
  s.on('agents', ids => emitted.push(ids));
  return { s, emitted };
}

test('agent.created makes a root and helpers with depth, rootId and kind', () => {
  const { s } = recording();
  s.apply(created('aaa111'));
  s.apply(created('aaa111-h1', { parentId: 'aaa111', name: 'Find tests', harness: undefined, machineId: undefined }));
  s.apply(created('aaa111-h2', { parentId: 'aaa111-h1', name: 'Deep helper' }));
  const root = s.get('aaa111');
  const h1 = s.get('aaa111-h1');
  const h2 = s.get('aaa111-h2');
  assert.equal(root.kind, 'agent');
  assert.equal(root.depth, 0);
  assert.equal(root.rootId, 'aaa111');
  assert.equal(h1.kind, 'helper');
  assert.equal(h1.depth, 1);
  assert.equal(h1.rootId, 'aaa111');
  assert.equal(h1.harness, 'claude', 'helpers inherit the harness');
  assert.equal(h1.machineId, 'laptop', 'helpers inherit the machine');
  assert.equal(h2.depth, 2);
  assert.equal(h2.rootId, 'aaa111');
  assert.deepEqual(root.helpers, { total: 1, working: 1, done: 0 });
  assert.equal(root.state, 'starting');
  assert.equal(root.startedAt, T0);
});

test('a duplicate agentId is ignored', () => {
  const { s, emitted } = recording();
  s.apply(created('aaa111', { name: 'First' }));
  s.apply(created('aaa111', { name: 'Second' }));
  assert.equal(s.get('aaa111').name, 'First');
  assert.equal(emitted.length, 1);
});

test('agent.state sets state, reason, since; ENDED sets endedAt; parent helpers recomputed', () => {
  const { s } = recording();
  s.apply([created('r1'), created('r1-a', { parentId: 'r1' }), created('r1-b', { parentId: 'r1' })]);
  s.apply(state('r1-a', 'finished', T0 + 5000, { reason: 'All good' }));
  const a = s.get('r1-a');
  assert.equal(a.state, 'finished');
  assert.equal(a.stateReason, 'All good');
  assert.equal(a.stateSince, T0 + 5000);
  assert.equal(a.endedAt, T0 + 5000);
  assert.deepEqual(s.get('r1').helpers, { total: 2, working: 1, done: 1 });
  s.apply(state('r1-b', 'failed', T0 + 6000));
  assert.deepEqual(s.get('r1').helpers, { total: 2, working: 0, done: 2 });
});

test('unknown states and events for unknown agents are ignored', () => {
  const { s, emitted } = recording();
  s.apply(created('r1'));
  s.apply(state('r1', 'dancing'));
  s.apply(state('nobody', 'working'));
  s.apply({ kind: 'agent.whatever', agentId: 'r1', ts: T0 });
  assert.equal(s.get('r1').state, 'starting');
  assert.equal(emitted.length, 1);
});

test('leaving an ask state clears the ask, unless an agent.ask follows in the same batch', () => {
  const { s } = recording();
  const ask = (id, type) => ({ kind: EV.ASK, ts: T0 + 10, agentId: 'r1', ask: { id, type, sentence: 'Fix login wants to run a command', options: ['Allow', 'Deny'], primary: 'Allow' } });
  s.apply(created('r1'));
  s.apply([ask('k1', 'permission'), state('r1', 'needs_ok')]);
  assert.equal(s.get('r1').ask.id, 'k1');
  assert.equal(s.get('r1').ask.createdAt, T0 + 10);
  s.apply(state('r1', 'working'));
  assert.equal(s.get('r1').ask, null, 'leaving needs_ok clears the ask');

  s.apply([ask('k2', 'question'), state('r1', 'question')]);
  s.apply([state('r1', 'maybe_stuck'), ask('k3', 'stuck')]);
  assert.equal(s.get('r1').ask.id, 'k3', 'an ask in the same batch survives');

  // The engine emits agent.ask before agent.state: moving from one ask state to another keeps the new ask.
  s.apply([ask('k4', 'permission'), state('r1', 'needs_ok')]);
  assert.equal(s.get('r1').ask.id, 'k4');
});

test('askCleared clears only the matching ask', () => {
  const { s } = recording();
  s.apply([created('r1'), { kind: EV.ASK, ts: T0, agentId: 'r1', ask: { id: 'q1', type: 'question', sentence: 'Which one?', options: [] } }]);
  s.apply({ kind: EV.ASK_CLEARED, ts: T0, agentId: 'r1', askId: 'other' });
  assert.equal(s.get('r1').ask.id, 'q1');
  s.apply({ kind: EV.ASK_CLEARED, ts: T0, agentId: 'r1', askId: 'q1', answer: 'the first' });
  assert.equal(s.get('r1').ask, null);
});

test('a root entering waiting_helpers says how many helpers it waits for', () => {
  const { s } = recording();
  s.apply([created('r1'), created('r1-a', { parentId: 'r1' }), state('r1-a', 'working')]);
  s.apply(state('r1', 'waiting_helpers', T0 + 2000, { backgroundTasks: 1 }));
  assert.equal(s.get('r1').now, 'Waiting for 1 helper');
  s.apply([created('r1-b', { parentId: 'r1' })]);
  assert.equal(s.get('r1').now, 'Waiting for 2 helpers');
  s.apply([state('r1-a', 'finished'), state('r1-b', 'finished')]);
  assert.equal(s.get('r1').now, 'Waiting for 1 helper', 'falls back to the background task count');
});

test('agent.activity start and end update now, counts, spark, recent and state', () => {
  const { s } = recording();
  s.apply(created('r1'));
  s.apply({ kind: EV.THINKING, ts: T0 + 100, agentId: 'r1', on: true });
  assert.equal(s.get('r1').thinking, true);
  assert.equal(s.get('r1').now, 'Thinking');
  s.apply(act('r1', 'start', 'Reading greet.js', T0 + 1000, { toolUseId: 't1' }));
  let v = s.get('r1');
  assert.equal(v.now, 'Reading greet.js');
  assert.equal(v.toolCalls, 1);
  assert.deepEqual(v.toolKinds, { read: 1 });
  assert.equal(v.spark[SPARK_BUCKETS - 1], 1);
  assert.equal(v.thinking, false);
  assert.equal(v.state, 'working', 'starting becomes working');
  assert.equal(v.lastEventAt, T0 + 1000);

  // Thinking while a tool is in progress does not replace `now`.
  s.apply({ kind: EV.THINKING, ts: T0 + 1100, agentId: 'r1', on: true });
  assert.equal(s.get('r1').now, 'Reading greet.js');

  // An end without a sentence takes it from the matching start.
  s.apply(act('r1', 'end', undefined, T0 + 2000, { toolUseId: 't1', ok: true }));
  v = s.get('r1');
  assert.deepEqual(v.recent, [{ ts: T0 + 2000, sentence: 'Reading greet.js', ok: true }]);
  assert.equal(v.lastEventAt, T0 + 2000);
  s.apply({ kind: EV.THINKING, ts: T0 + 2100, agentId: 'r1', on: true });
  assert.equal(s.get('r1').now, 'Thinking', 'no tool in progress any more');

  for (let i = 0; i < 10; i++) s.apply(act('r1', 'end', `Step ${i}`, T0 + 3000 + i, { ok: i % 2 === 0 }));
  v = s.get('r1');
  assert.equal(v.recent.length, 8);
  assert.equal(v.recent[7].sentence, 'Step 9');
  assert.equal(v.recent[7].ok, false);
  assert.equal(v.toolCalls, 1, 'ends do not count as tool calls');
});

test('agent.usage set and add, cost replacement, context percentage', () => {
  const { s } = recording();
  s.apply(created('r1'));
  s.apply({ kind: EV.USAGE, ts: T0, agentId: 'r1', mode: 'add', inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
  s.apply({ kind: EV.USAGE, ts: T0, agentId: 'r1', mode: 'add', inputTokens: 10, outputTokens: 5 });
  let u = s.get('r1').usage;
  assert.equal(u.inputTokens, 20);
  assert.equal(u.outputTokens, 10);
  assert.equal(u.cacheReadTokens, 1);
  assert.equal(u.costUsd, null, 'cost is not reported until the harness reports it, and untouched when the field is absent');
  assert.equal(u.unreportedUsd, 0);
  s.apply({ kind: EV.USAGE, ts: T0, agentId: 'r1', mode: 'set', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, contextTokens: 50_000, contextWindow: 200_000 });
  u = s.get('r1').usage;
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.costUsd, 0.05);
  assert.equal(u.contextPct, 0.25);
  s.apply({ kind: EV.USAGE, ts: T0, agentId: 'r1', mode: 'set', costUsd: null });
  assert.equal(s.get('r1').usage.costUsd, null, 'null means not reported');
  assert.equal(s.get('r1').usage.inputTokens, 100);
});

test('agent.turn start counts turns and wakes resting roots; helpers do not resume', () => {
  const { s } = recording();
  s.apply([created('r1'), created('r1-h', { parentId: 'r1' })]);
  s.apply({ kind: EV.TURN, ts: T0, agentId: 'r1', phase: 'start' });
  assert.equal(s.get('r1').turns, 1);
  for (const rest of ['question', 'done_checked', 'done_claimed', 'checks_failed', 'waiting_helpers', 'failed']) {
    s.apply(state('r1', rest, T0 + 100));
    s.apply({ kind: EV.TURN, ts: T0 + 200, agentId: 'r1', phase: 'start' });
    assert.equal(s.get('r1').state, 'working', `${rest} returns to working`);
    assert.equal(s.get('r1').endedAt, null);
  }
  s.apply(state('r1', 'stopped', T0 + 300));
  s.apply({ kind: EV.TURN, ts: T0 + 400, agentId: 'r1', phase: 'start' });
  assert.equal(s.get('r1').state, 'stopped', 'only the person brings a stopped agent back, with a message');

  s.apply(state('r1-h', 'finished'));
  s.apply({ kind: EV.TURN, ts: T0, agentId: 'r1-h', phase: 'start' });
  assert.equal(s.get('r1-h').state, 'finished');

  s.apply(state('r1', 'working'));
  s.apply({ kind: EV.TURN, ts: T0 + 500, agentId: 'r1', phase: 'end', finalText: 'Done.' });
  assert.equal(s.get('r1').state, 'working', 'turn end changes no state');
});

test('agent.turn start: a failed root resumes, saying it is working on the message that waited', () => {
  const { s } = recording();
  s.apply([created('r1'), state('r1', 'working')]);
  s.apply([{ kind: EV.ENDED, ts: T0 + 2000, agentId: 'r1', outcome: 'error', error: 'Codex lost its connection to the model.' }, state('r1', 'failed', T0 + 2000, { reason: 'Codex lost its connection to the model.' })]);
  assert.equal(s.get('r1').error, 'Codex lost its connection to the model.');
  s.apply({ kind: EV.TURN, ts: T0 + 3000, agentId: 'r1', phase: 'start' });
  const v = s.get('r1');
  assert.equal(v.state, 'working');
  assert.equal(v.now, 'Working on your message');
  assert.equal(v.endedAt, null);
  assert.equal(v.error, null, 'the earlier run’s error no longer describes it');
  assert.equal(v.stateReason, null);
});

test('agent.turn start leaves an agent that is asking alone', () => {
  const { s } = recording();
  const ask = (agentId, id, type) => ({ kind: EV.ASK, ts: T0 + 10, agentId, ask: { id, type, sentence: 'x', options: ['A', 'B'] } });
  s.apply([created('r1'), created('r2')]);
  s.apply([ask('r1', 'ok-1', 'permission'), state('r1', 'needs_ok')]);
  s.apply([ask('r2', 'stuck-1', 'stuck'), state('r2', 'maybe_stuck')]);
  s.apply([{ kind: EV.TURN, ts: T0 + 20, agentId: 'r1', phase: 'start' }, { kind: EV.TURN, ts: T0 + 20, agentId: 'r2', phase: 'start' }]);
  assert.equal(s.get('r1').state, 'needs_ok');
  assert.equal(s.get('r1').ask.id, 'ok-1');
  assert.equal(s.get('r2').state, 'maybe_stuck');
  assert.equal(s.get('r2').ask.id, 'stuck-1');
});

test('a root picked up again by a message drops the error of its earlier run', () => {
  const { s } = recording();
  s.apply([created('r1'), state('r1', 'working')]);
  s.apply([{ kind: EV.ENDED, ts: T0 + 2000, agentId: 'r1', outcome: 'error', error: 'Exit code 3' }, state('r1', 'failed', T0 + 2000)]);
  s.apply(state('r1', 'working', T0 + 3000)); // the engine, after "Try again" reached the agent
  assert.equal(s.get('r1').error, null);
  s.apply([{ kind: EV.ENDED, ts: T0 + 4000, agentId: 'r1', outcome: 'error', error: 'Exit code 4' }, state('r1', 'failed', T0 + 4000)]);
  assert.equal(s.get('r1').error, 'Exit code 4', 'a later failure says its own error');
});

test('plan, says, files, checks, rules, model, session, approvals and ended', () => {
  const { s } = recording();
  s.apply(created('r1'));
  s.apply({ kind: EV.PLAN, ts: T0, agentId: 'r1', items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }] });
  assert.deepEqual(s.get('r1').plan.done, 1);
  assert.deepEqual(s.get('r1').plan.total, 3);
  s.apply({ kind: EV.SAYS, ts: T0, agentId: 'r1', text: 'I fixed the login.' });
  assert.equal(s.get('r1').says, 'I fixed the login.');
  const files = { changed: 1, adds: 3, dels: 1, list: [{ path: 'a.js', adds: 3, dels: 1 }] };
  s.apply({ kind: EV.FILES, ts: T0, agentId: 'r1', files });
  files.changed = 99;
  assert.equal(s.get('r1').files.changed, 1, 'the store keeps its own copy');
  s.apply({ kind: EV.CHECKS, ts: T0, agentId: 'r1', checks: { state: 'passed', results: [{ name: 'tests', ok: true, ms: 10 }] } });
  s.apply({ kind: EV.RULES, ts: T0, agentId: 'r1', rules: { kept: [{ say: 'No new packages' }], broken: [] } });
  s.apply({ kind: EV.MODEL, ts: T0, agentId: 'r1', model: 'claude-haiku-4-5' });
  s.apply({ kind: EV.SESSION, ts: T0, agentId: 'r1', sessionId: 'sess-1' });
  const v = s.get('r1');
  assert.equal(v.checks.state, 'passed');
  assert.equal(v.rules.kept[0].say, 'No new packages');
  assert.equal(v.model, 'claude-haiku-4-5');
  assert.equal(v.sessionId, 'sess-1');

  s.apply([
    { kind: EV.APPROVAL, ts: T0, agentId: 'r1', how: 'auto', decision: 'allow', sentence: 'x' },
    { kind: EV.APPROVAL, ts: T0, agentId: 'r1', how: 'person', decision: 'allow', sentence: 'x' },
    { kind: EV.APPROVAL, ts: T0, agentId: 'r1', how: 'person', decision: 'deny', sentence: 'x' },
    { kind: EV.APPROVAL, ts: T0, agentId: 'r1', how: 'timeout', decision: 'deny', sentence: 'x' },
    { kind: EV.APPROVAL, ts: T0, agentId: 'r1', how: 'auto', decision: 'deny', sentence: 'x' },
  ]);
  assert.deepEqual(s.get('r1').approvals, { auto: 1, byYou: 1, denied: 3 });

  s.apply({ kind: EV.ENDED, ts: T0 + 9000, agentId: 'r1', outcome: 'error', error: 'Exited with code 1' });
  assert.equal(s.get('r1').endedAt, T0 + 9000);
  assert.equal(s.get('r1').error, 'Exited with code 1');
});

test('machine.update inserts or replaces; notice passes through', () => {
  const s = new Store();
  const machineEvents = [];
  const notices = [];
  s.on('machines', m => machineEvents.push(m));
  s.on('notice', n => notices.push(n));
  s.apply({ kind: EV.MACHINE, ts: T0, machine: { id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true } });
  s.apply([
    { kind: EV.MACHINE, ts: T0, machine: { id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true, cpuPct: 12 } },
    { kind: EV.MACHINE, ts: T0, machine: { id: 'cloud-1', name: 'Cloud 1', kind: 'cloud', awake: false } },
  ]);
  assert.equal(s.machines().length, 2);
  assert.equal(s.machines()[0].cpuPct, 12);
  assert.equal(machineEvents.length, 2);
  assert.equal(machineEvents[1].length, 2, 'one emission per apply, with the changed machines');
  s.apply({ kind: EV.NOTICE, ts: T0, text: 'Started Fix login.' });
  assert.deepEqual(notices, [{ text: 'Started Fix login.' }]);
});

test("'agents' is emitted once per apply with deduped ids, including a parent whose helpers changed", () => {
  const { s, emitted } = recording();
  s.apply([created('r1'), created('r1-a', { parentId: 'r1' }), act('r1-a', 'start', 'Reading a.js'), act('r1-a', 'end', 'Reading a.js')]);
  assert.equal(emitted.length, 1);
  assert.deepEqual([...emitted[0]].sort(), ['r1', 'r1-a']);
});

test('list() sorts roots by priority then newest, each followed by its helpers', () => {
  const { s } = recording();
  s.apply([
    created('old', { ts: T0, startedAt: T0 }),
    created('new', { ts: T0 + 10, startedAt: T0 + 10 }),
    created('ask', { ts: T0 + 5, startedAt: T0 + 5 }),
    created('fin', { ts: T0 + 20, startedAt: T0 + 20 }),
  ]);
  s.apply([state('old', 'working'), state('new', 'working'), state('ask', 'needs_ok'), state('fin', 'stopped')]);
  s.apply([
    created('old-1', { parentId: 'old', ts: T0 + 30 }),
    created('ask-1', { parentId: 'ask', ts: T0 + 31 }),
    created('old-2', { parentId: 'old', ts: T0 + 32 }),
    created('old-1-x', { parentId: 'old-1', ts: T0 + 33 }),
  ]);
  assert.deepEqual(s.list().map(v => v.id), ['ask', 'ask-1', 'new', 'old', 'old-1', 'old-1-x', 'old-2', 'fin']);
  assert.deepEqual(s.children('old').map(v => v.id), ['old-1', 'old-2']);
  assert.deepEqual(s.descendants('old').map(v => v.id), ['old-1', 'old-1-x', 'old-2']);
  assert.deepEqual(s.children('nobody'), []);
});

test('spendTodayUsd sums reported root costs for roots started since local midnight', () => {
  const { s } = recording();
  const now = new Date(2026, 10, 10, 15, 0, 0).getTime();
  const midnight = new Date(2026, 10, 10, 0, 0, 0).getTime();
  s.apply([
    created('a', { ts: now, startedAt: midnight + 1000 }),
    created('b', { ts: now, startedAt: midnight - 1000 }),
    created('c', { ts: now, startedAt: midnight + 2000, harness: 'codex' }),
    created('a-h', { ts: now, parentId: 'a' }),
  ]);
  s.apply([
    { kind: EV.USAGE, ts: now, agentId: 'a', mode: 'set', costUsd: 0.25 },
    { kind: EV.USAGE, ts: now, agentId: 'b', mode: 'set', costUsd: 5 },
    { kind: EV.USAGE, ts: now, agentId: 'a-h', mode: 'set', costUsd: 1 },
  ]);
  assert.equal(s.get('c').usage.costUsd, null);
  assert.equal(s.spendTodayUsd(now), 0.25);
  const snap = s.snapshot(now);
  assert.equal(snap.spendTodayUsd, 0.25);
  assert.equal(snap.agents.length, 4);
  assert.deepEqual(snap.machines, []);
});

test('tick rolls spark buckets and reports only views whose spark changed', () => {
  const { s, emitted } = recording();
  s.apply([created('busy'), created('idle')]);
  s.apply(act('busy', 'start', 'Reading a.js', T0 + 1000));
  emitted.length = 0;
  const v = s.get('busy');
  const endsAt = v.sparkEndsAt;
  assert.equal(endsAt, T0 + SPARK_BUCKET_MS, 'buckets line up on a 30 s grid');
  s.tick(T0 + 2000);
  assert.equal(emitted.length, 0, 'nothing to roll yet');
  s.tick(endsAt + 10);
  assert.deepEqual(emitted, [['busy']]);
  assert.equal(s.get('busy').spark[SPARK_BUCKETS - 2], 1);
  assert.equal(s.get('busy').spark[SPARK_BUCKETS - 1], 0);
  assert.equal(s.get('busy').sparkEndsAt, endsAt + SPARK_BUCKET_MS);
  assert.equal(s.get('idle').sparkEndsAt, endsAt + SPARK_BUCKET_MS, 'idle views roll silently');
  s.tick(endsAt + SPARK_BUCKET_MS * (SPARK_BUCKETS + 5));
  assert.ok(s.get('busy').spark.every(n => n === 0), 'old activity falls off');
  emitted.length = 0;
  s.tick(endsAt + SPARK_BUCKET_MS * (SPARK_BUCKETS + 7));
  assert.equal(emitted.length, 0);
});

test('activity after a gap lands in the right bucket', () => {
  const { s } = recording();
  s.apply(created('r1'));
  s.apply(act('r1', 'start', 'A', T0 + 1000));
  s.apply(act('r1', 'start', 'B', T0 + 3 * SPARK_BUCKET_MS + 5));
  const v = s.get('r1');
  assert.equal(v.spark[SPARK_BUCKETS - 1], 1);
  assert.equal(v.spark[SPARK_BUCKETS - 4], 1);
  assert.equal(v.spark.reduce((a, b) => a + b, 0), 2);
});

test('the event log appends JSONL and never throws on write errors', async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'logs', 'events.jsonl');
  const s = new Store({ logPath: file });
  s.apply([created('r1'), state('r1', 'working')]);
  s.close();
  await new Promise(r => setTimeout(r, 50));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.kind), ['agent.created', 'agent.state']);

  // A path that cannot be written: a directory where the file should be.
  const warnings = [];
  const bad = new Store({ logPath: TMP, log: { warn: (m) => warnings.push(m) } });
  bad.apply(created('r2'));
  await new Promise(r => setTimeout(r, 50));
  bad.apply(state('r2', 'working'));
  assert.equal(bad.get('r2').state, 'working', 'the store keeps working');
  assert.ok(warnings.length >= 1);
  bad.close();
});

test('a root waiting only on a background command says so, and the line follows the live split', () => {
  const s = new Store();
  s.apply([created('r1'), created('h1', { parentId: 'r1', name: 'Read docs' }), state('h1', 'working')]);
  s.apply(state('r1', 'waiting_helpers', T0 + 2000, { backgroundTasks: 2, background: { helpers: 1, commands: 1, others: 0 } }));
  assert.equal(s.get('r1').now, 'Waiting for its helper and a background command');
  s.apply([state('h1', 'finished', T0 + 3000), { kind: EV.BACKGROUND, ts: T0 + 3000, agentId: 'r1', helpers: 0, commands: 1, others: 0, work: [] }]);
  assert.equal(s.get('r1').now, 'Waiting for a background command', 'not "Waiting for 2 helpers"');
  s.apply({ kind: EV.BACKGROUND, ts: T0 + 4000, agentId: 'r1', helpers: 0, commands: 0, others: 0, work: [] });
  assert.equal(s.get('r1').now, 'Its background work is done');
});

test('a turn after a wait for background commands only does not mention helpers; after helpers it does', () => {
  const s = new Store();
  s.apply([created('r1'), state('r1', 'working')]);
  s.apply(state('r1', 'waiting_helpers', T0 + 2000, { backgroundTasks: 1, background: { helpers: 0, commands: 1, others: 0 } }));
  s.apply({ kind: EV.TURN, ts: T0 + 3000, agentId: 'r1', phase: 'start' });
  assert.equal(s.get('r1').state, 'working');
  assert.equal(s.get('r1').now, 'Reading what came back');
  s.apply(state('r1', 'waiting_helpers', T0 + 4000, { backgroundTasks: 1, background: { helpers: 1, commands: 0, others: 0 } }));
  s.apply({ kind: EV.TURN, ts: T0 + 5000, agentId: 'r1', phase: 'start' });
  assert.equal(s.get('r1').now, 'Reading what its helpers found');
});

test('a turn that starts by itself while an agent is done does not claim a follow-up was sent; a follow-up does', () => {
  const s = new Store();
  s.apply([created('r1'), state('r1', 'working'), state('r1', 'done_claimed', T0 + 2000)]);
  s.apply({ kind: EV.TURN, ts: T0 + 3000, agentId: 'r1', phase: 'start' }); // Claude Code woke it: its command ended
  assert.equal(s.get('r1').state, 'working');
  assert.equal(s.get('r1').now, 'Picking up where it left off');
  s.apply(state('r1', 'done_claimed', T0 + 4000));
  s.apply(state('r1', 'working', T0 + 5000)); // the engine, once the person's follow-up reached it
  assert.equal(s.get('r1').now, 'Working on your follow-up');
});

test('spend not reported yet is kept apart from the reported cost, and counted, as such, in spend today', () => {
  const { s } = recording();
  const now = new Date(2026, 10, 10, 15, 0, 0).getTime();
  s.apply(created('a', { ts: now, startedAt: now - 1000, harness: 'claude' }));
  assert.equal(s.get('a').usage.costUsd, null, 'nothing reported yet: not "$0"');
  assert.equal(s.get('a').usage.unreportedUsd, 0);
  assert.equal(s.spendTodayEstimated(now), false);
  s.apply({ kind: EV.USAGE, ts: now, agentId: 'a', mode: 'add', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, unreportedUsd: 0.04 });
  assert.equal(s.get('a').usage.costUsd, null, 'costUsd is only what the harness reported');
  assert.equal(s.get('a').usage.unreportedUsd, 0.04);
  assert.equal(s.spendTodayUsd(now), 0.04);
  assert.equal(s.spendTodayEstimated(now), true);
  assert.deepEqual([s.snapshot(now).spendTodayUsd, s.snapshot(now).spendTodayEstimated], [0.04, true]);
  s.apply({ kind: EV.USAGE, ts: now, agentId: 'a', mode: 'set', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, unreportedUsd: 0 });
  assert.equal(s.spendTodayUsd(now), 0.05);
  assert.equal(s.spendTodayEstimated(now), false);
});

test('a new turn clears the last turn\'s receipt: says, files, rules and checks', () => {
  const { s } = recording();
  s.apply(created('r1'));
  s.apply(act('r1', 'start', 'Editing a.js', T0 + 1000, { toolUseId: 't' }));
  s.apply({ kind: EV.TURN, ts: T0 + 1500, agentId: 'r1', phase: 'start' });
  s.apply({ kind: EV.SAYS, ts: T0 + 2000, agentId: 'r1', text: 'All fixed.' });
  s.apply({ kind: EV.FILES, ts: T0 + 2000, agentId: 'r1', files: { changed: 1, adds: 1, dels: 0, list: [] } });
  s.apply({ kind: EV.RULES, ts: T0 + 2000, agentId: 'r1', rules: { kept: [], broken: [] } });
  s.apply({ kind: EV.CHECKS, ts: T0 + 2000, agentId: 'r1', checks: { state: 'passed', results: [] } });
  s.apply(state('r1', 'done_checked', T0 + 2100));
  assert.equal(s.get('r1').checks.state, 'passed');
  s.apply({ kind: EV.TURN, ts: T0 + 3000, agentId: 'r1', phase: 'start' });
  const v = s.get('r1');
  assert.equal(v.says, null);
  assert.equal(v.files, null);
  assert.equal(v.rules, null);
  assert.equal(v.checks.state, 'none');
});

test('a follow-up that brings a stopped agent back also clears the old receipt', () => {
  const { s } = recording();
  s.apply(created('r2'));
  s.apply({ kind: EV.SAYS, ts: T0 + 2000, agentId: 'r2', text: 'All fixed.' });
  s.apply({ kind: EV.CHECKS, ts: T0 + 2000, agentId: 'r2', checks: { state: 'passed', results: [] } });
  s.apply(state('r2', 'stopped', T0 + 2100));
  s.apply(state('r2', 'working', T0 + 3000));
  assert.equal(s.get('r2').says, null);
  assert.equal(s.get('r2').checks.state, 'none');
});

test('any output moves a starting root to working: init, a turn, thinking, text', () => {
  const outputs = {
    session: { kind: EV.SESSION, sessionId: 's1' },
    turn: { kind: EV.TURN, phase: 'start' },
    thinking: { kind: EV.THINKING, on: true },
    text: { kind: EV.SAYS, text: 'Looking at the code.' },
  };
  for (const [name, out] of Object.entries(outputs)) {
    const { s } = recording();
    s.apply(created('s1'));
    s.apply(state('s1', 'starting', T0 + 500));
    assert.equal(s.get('s1').state, 'starting', name);
    s.apply({ ...out, ts: T0 + 1000, agentId: 's1' });
    assert.equal(s.get('s1').state, 'working', name);
  }
  const { s } = recording();
  s.apply(created('s2'));
  s.apply(state('s2', 'starting', T0 + 500));
  s.apply({ kind: EV.THINKING, ts: T0 + 1000, agentId: 's2', on: false });
  assert.equal(s.get('s2').state, 'starting', 'thinking switching off is not output');
});

test('a view has fullName: the event\'s whole description, or the name itself', () => {
  const { s } = recording();
  s.apply(created('f1', { name: 'Repository exploration', fullName: 'Repository exploration and architecture mapping' }));
  s.apply(created('f2'));
  assert.equal(s.get('f1').fullName, 'Repository exploration and architecture mapping');
  assert.equal(s.get('f1').name, 'Repository exploration');
  assert.equal(s.get('f2').fullName, 'Fix login');
});
