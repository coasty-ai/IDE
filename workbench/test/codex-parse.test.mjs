import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCodexParser, plainError, STOPPED_EARLY } from '../src/adapters/codex/parse.mjs';
import { EV } from '../src/shared/events.mjs';

const ROOT = 'abc123';

function fixture(name) {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const newParser = () => createCodexParser({ rootId: ROOT, now: () => 1000 });
const feed = (parser, lines) => lines.flatMap(o => parser.push(o));
const ofKind = (events, kind) => events.filter(e => e.kind === kind);
const cmd = (id, command, extra = {}) => ({ id, type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress', ...extra });

test('codex-run fixture: session, turn, activities with exit codes, says, usage and final text', () => {
  const lines = fixture('codex-run.jsonl');
  const events = feed(newParser(), lines);

  for (const e of events) {
    assert.equal(e.agentId, ROOT);
    assert.equal(e.ts, 1000);
  }
  assert.deepEqual(events[0], { kind: EV.SESSION, ts: 1000, agentId: ROOT, sessionId: '01a1c80d-4a72-7201-8a09-2038b4caad2a' });

  const turns = ofKind(events, EV.TURN);
  assert.deepEqual(turns.map(t => t.phase), ['start', 'end']);
  assert.equal(events[1].kind, EV.TURN, 'the turn starts before any work');
  assert.equal(events.at(-1).kind, EV.TURN, 'the turn ends last');

  const acts = ofKind(events, EV.ACTIVITY);
  const starts = acts.filter(a => a.phase === 'start');
  const ends = acts.filter(a => a.phase === 'end');
  assert.deepEqual(starts.map(a => a.sentence), ['Reading a file', 'Running the tests', 'Looking at the files']);
  assert.ok(starts.every(a => a.toolKind === 'run'));
  assert.deepEqual(ends.map(a => a.ok), [true, true, true], 'ok comes from exit_code 0');
  assert.deepEqual(ends.map(a => a.toolUseId), starts.map(a => a.toolUseId), 'each end matches its start');
  assert.equal(new Set(starts.map(a => a.toolUseId)).size, 3);
  assert.equal(starts[0].input.command, "/bin/zsh -lc 'cat greet.js'");

  const says = ofKind(events, EV.SAYS).map(s => s.text);
  assert.deepEqual(says, [
    'I’ll list the files, read greet.js, and run node test.mjs.',
    'The repository contains README.md, greet.js, and test.mjs; greet.js returns a personalized greeting, and node test.mjs passes with ok.',
  ]);

  const usage = ofKind(events, EV.USAGE);
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0], {
    kind: EV.USAGE, ts: 1000, agentId: ROOT, mode: 'add',
    inputTokens: 30655 - 27392, outputTokens: 269, cacheReadTokens: 27392, cacheWriteTokens: 0,
    costUsd: null, contextTokens: 30655,
  });
  assert.equal(events.at(-2), usage[0], 'usage is reported just before the turn ends');

  const end = turns[1];
  assert.equal(end.isError, false);
  assert.equal(end.backgroundTasks, 0);
  assert.equal(end.finalText, lines.at(-2).item.text, 'final text is the latest agent_message, unchanged');
});

test('codex-resume fixture: session, one reply, usage added with no cost', () => {
  const events = feed(newParser(), fixture('codex-resume.jsonl'));
  assert.deepEqual(events.map(e => e.kind), [EV.SESSION, EV.TURN, EV.SAYS, EV.USAGE, EV.TURN]);
  assert.equal(events[0].sessionId, '01a1c811-3768-7ae0-a0f1-9cef21af1d04');
  assert.equal(events[1].phase, 'start');
  assert.equal(events[2].text, 'banana');
  const u = events[3];
  assert.equal(u.mode, 'add');
  assert.equal(u.costUsd, null);
  assert.equal(u.inputTokens, 35477 - 24576);
  assert.equal(u.cacheReadTokens, 24576);
  assert.equal(u.outputTokens, 10);
  assert.equal(u.contextTokens, 35477);
  assert.deepEqual(events[4], { kind: EV.TURN, ts: 1000, agentId: ROOT, phase: 'end', finalText: 'banana', isError: false, backgroundTasks: 0 });
});

test('one parser across a run and a resume keeps tool ids unique and resets the final text', () => {
  const parser = newParser();
  const first = feed(parser, fixture('codex-run.jsonl'));
  const second = feed(parser, [{ type: 'thread.started', thread_id: 'T2' }, { type: 'turn.started' }, { type: 'item.started', item: cmd('item_1', 'ls') }, { type: 'turn.completed', usage: { input_tokens: 5 } }]);
  assert.equal(parser.threadId, 'T2');
  const ids = [...first, ...second].filter(e => e.kind === EV.ACTIVITY && e.phase === 'start').map(e => e.toolUseId);
  assert.equal(new Set(ids).size, ids.length, 'item_1 in the second process gets a new id');
  const end = second.at(-1);
  assert.equal(end.finalText, null, 'no reply in this turn, so no leftover text from the last one');
  const closed = second.find(e => e.kind === EV.ACTIVITY && e.phase === 'end');
  assert.equal(closed.ok, null, 'a step still open at turn end is closed with an unknown outcome');
});

test('ok follows the exit code, and odd orderings stay balanced', () => {
  const parser = newParser();
  parser.push({ type: 'turn.started' });
  const failed = feed(parser, [
    { type: 'item.started', item: cmd('item_1', "/bin/zsh -lc 'node test.mjs'") },
    { type: 'item.completed', item: cmd('item_1', "/bin/zsh -lc 'node test.mjs'", { exit_code: 1, status: 'failed', aggregated_output: 'AssertionError: expected 2 to equal 3\n' }) },
  ]);
  assert.equal(failed[1].ok, false);
  assert.equal(failed[1].error, 'AssertionError: expected 2 to equal 3');

  const declined = parser.push({ type: 'item.completed', item: cmd('item_2', 'rm -rf build', { status: 'declined' }) });
  assert.deepEqual(declined.map(e => e.phase), ['start', 'end'], 'a completion without a start still counts as a step');
  assert.equal(declined[1].ok, false);

  assert.deepEqual(parser.push({ type: 'item.completed', item: cmd('item_2', 'rm -rf build', { exit_code: 0 }) }), [], 'a repeated completion is ignored');
  const killed = parser.push({ type: 'item.completed', item: cmd('item_3', 'sleep 100', { status: 'completed' }) });
  assert.equal(killed[1].ok, null, 'no exit code: outcome unknown');
});

test('errors: a passing error does not end the turn; turn.failed ends it once, in plain words', () => {
  const parser = newParser();
  const ok = feed(parser, [
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
  ]);
  const okTurns = ofKind(ok, EV.TURN);
  assert.equal(okTurns.length, 2);
  assert.equal(okTurns[1].isError, false);
  assert.equal(okTurns[1].finalText, 'Done.');

  const bad = feed(parser, [
    { type: 'turn.started' },
    { type: 'error', message: 'unexpected status 401 Unauthorized: {"error":{"message":"Missing bearer authentication"}}' },
    { type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: {"error":{"message":"Missing bearer authentication"}}' } },
    { type: 'turn.failed', error: { message: 'again' } },
  ]);
  const ends = ofKind(bad, EV.TURN).filter(t => t.phase === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].isError, true);
  assert.equal(ends[0].finalText, 'Codex is not signed in, or its sign-in has expired.');
  assert.equal(ends[0].error, ends[0].finalText);
  assert.equal(ofKind(bad, EV.USAGE).length, 0);
});

test('finish() ends an unfinished turn as an error; abort() only closes open steps', () => {
  const parser = newParser();
  feed(parser, [{ type: 'turn.started' }, { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } }, { type: 'item.started', item: cmd('item_1', 'make') }]);
  const done = parser.finish();
  assert.deepEqual(done.map(e => [e.kind, e.phase ?? e.on]), [[EV.ACTIVITY, 'end'], [EV.TURN, 'end']]);
  assert.equal(done[0].ok, null);
  assert.equal(done[1].isError, true);
  assert.equal(done[1].finalText, STOPPED_EARLY);
  assert.deepEqual(parser.finish(), [], 'nothing left to close');

  const other = newParser();
  feed(other, [{ type: 'turn.started' }, { type: 'item.completed', item: { id: 'r', type: 'reasoning' } }, { type: 'item.started', item: cmd('item_1', 'make') }, { type: 'item.completed', item: { id: 'r2', type: 'reasoning' } }]);
  const stopped = other.abort();
  assert.deepEqual(stopped.map(e => e.kind), [EV.ACTIVITY, EV.THINKING]);
  assert.equal(stopped[1].on, false);
  assert.ok(!stopped.some(e => e.kind === EV.TURN), 'a stopped turn gets no end, so the engine keeps "stopped"');
  assert.deepEqual(other.finish(), []);
});

test('reasoning, file changes, plans, web searches and tool calls (shapes not in the fixtures)', () => {
  const parser = newParser();
  parser.push({ type: 'turn.started' });

  assert.deepEqual(parser.push({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: '**Planning**' } }).map(e => e.on), [true]);
  assert.deepEqual(parser.push({ type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: 'more' } }), [], 'thinking is reported once');
  const reply = parser.push({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Now editing.' } });
  assert.deepEqual(reply.map(e => e.kind), [EV.THINKING, EV.SAYS]);
  assert.equal(reply[0].on, false);

  const changes = [{ path: '/w/src/a.js', kind: 'update' }, { path: '/w/b.js', kind: 'add' }, { path: '/w/c.js', kind: 'delete' }];
  const edit = parser.push({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes, status: 'completed' } });
  assert.deepEqual(edit.map(e => e.phase), ['start', 'end']);
  assert.equal(edit[0].sentence, 'Editing a.js, b.js and 1 more');
  assert.equal(edit[0].toolKind, 'edit');
  assert.equal(edit[1].ok, true);

  const plan1 = parser.push({ type: 'item.started', item: { id: 'p', type: 'todo_list', items: [{ text: 'Read code', completed: false }, { text: 'Fix bug', completed: false }] } });
  assert.deepEqual(plan1[0].items, [{ id: '1', text: 'Read code', status: 'pending' }, { id: '2', text: 'Fix bug', status: 'pending' }]);
  const plan2 = parser.push({ type: 'item.updated', item: { id: 'p', type: 'todo_list', items: [{ text: 'Read code', completed: true }, { text: 'Fix bug', completed: false }] } });
  assert.equal(plan2[0].kind, EV.PLAN);
  assert.equal(plan2[0].items[0].status, 'completed');
  assert.deepEqual(parser.push({ type: 'item.completed', item: { id: 'p', type: 'todo_list', items: [{ text: 'Read code', completed: true }, { text: 'Fix bug', completed: false }] } }), [], 'an unchanged plan is not sent again');

  const web = [
    ...parser.push({ type: 'item.started', item: { id: 'w', type: 'web_search', query: '' } }),
    ...parser.push({ type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'codex exec resume flags' } }),
  ];
  assert.equal(web[0].sentence, 'Searching the web');
  assert.equal(web[1].sentence, 'Searching the web for “codex exec resume flags”');
  assert.equal(web[1].toolKind, 'web');
  assert.equal(web[1].ok, true);

  const mcp = [
    ...parser.push({ type: 'item.started', item: { id: 'x', type: 'mcp_tool_call', server: 'github', tool: 'search_issues', status: 'in_progress' } }),
    ...parser.push({ type: 'item.completed', item: { id: 'x', type: 'mcp_tool_call', server: 'github', tool: 'search_issues', status: 'failed', error: { message: 'rate limited' } } }),
  ];
  assert.equal(mcp[0].sentence, 'Using github (search_issues)');
  assert.equal(mcp[1].ok, false);
  assert.equal(mcp[1].error, 'rate limited');
});

test('unknown events and junk are ignored, and input objects are not changed', () => {
  const parser = newParser();
  for (const junk of [null, undefined, 'text', 42, {}, { type: 'something.new' }, { type: 'item.completed' }, { type: 'item.completed', item: { id: 'c', type: 'collab_tool_call' } }, { type: 'thread.started' }]) {
    assert.deepEqual(parser.push(junk), []);
  }
  const lines = fixture('codex-run.jsonl');
  const copy = structuredClone(lines);
  feed(newParser(), lines);
  assert.deepEqual(lines, copy);
});

test('plainError gives one plain sentence', () => {
  assert.equal(plainError(''), null);
  assert.equal(plainError("You've hit your usage limit. Try again later."), 'Codex has reached its usage limit for now.');
  assert.equal(plainError('stream disconnected before completion: error sending request'), 'Codex lost its connection to the model.');
  assert.equal(plainError('No saved session found with ID 0199'), 'Codex could not find the earlier conversation to continue.');
  assert.equal(plainError('Not inside a trusted directory and --skip-git-repo-check was not specified.'), 'Codex only works inside a git repository.');
  assert.equal(plainError('unexpected status 400: {"error":{"message":"Bad things happened"}}'), 'Codex stopped with an error: Bad things happened');
  assert.equal(plainError("thread 'main' panicked at boom\nnote: run with RUST_BACKTRACE=1"), "Codex stopped with an error: thread 'main' panicked at boom");
});
