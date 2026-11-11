import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, describeCommand, describeRequest, nameFromTask, extractQuestion, firstSentence, plain, baseName, pastTense } from '../src/shared/narrate.mjs';
import { duration, tokens, money, percent, clip, shortModel } from '../src/shared/format.mjs';
import { STATE, LOOK, PRIORITY, NEEDS_YOU, lookOf } from '../src/shared/states.mjs';
import { EV, newAgentView, SPARK_BUCKETS } from '../src/shared/events.mjs';

test('narrate turns tool calls into short sentences', () => {
  assert.equal(narrate('Read', { file_path: '/repo/src/greet.js' }).sentence, 'Reading greet.js');
  assert.equal(narrate('Edit', { file_path: '/repo/a/b.ts' }).kind, 'edit');
  assert.equal(narrate('Grep', { pattern: 'checkout' }).sentence, 'Searching for “checkout”');
  assert.equal(narrate('Bash', { command: 'node test.mjs', description: 'Run the tests' }).sentence, 'Running the tests');
  assert.equal(narrate('Bash', { command: 'npm install left-pad' }).sentence, 'Installing packages');
  assert.equal(narrate('Bash', { command: 'git status' }).sentence, 'Checking what changed');
  assert.equal(narrate('Bash', { command: 'make deploy', description: 'Deploy the app.' }).sentence, 'Deploy the app');
  assert.equal(narrate('Agent', { description: 'List repository files and explain greet.js' }).sentence, 'Asking a helper to list repository files and explain greet.js');
  assert.equal(narrate('command_execution', { command: "/bin/zsh -lc 'node test.mjs'" }).sentence, 'Running the tests');
  assert.equal(narrate('mcp__plugin_slack_slack__slack_send_message', {}).sentence, 'Using slack (slack_send_message)');
  assert.equal(narrate('SomethingNew', {}).sentence, 'Using SomethingNew');
});

test('describeCommand and describeRequest stay plain', () => {
  assert.equal(describeCommand('pytest -q'), 'Running the tests');
  assert.equal(describeRequest('Bash', { command: 'rm -rf build' }).sentence, 'wants to run a command');
  assert.equal(describeRequest('Bash', { command: 'rm -rf build' }).detail, 'rm -rf build');
  assert.equal(describeRequest('Write', { file_path: '/etc/hosts' }).sentence, 'wants to create hosts');
  assert.equal(baseName('/a/b/c/'), 'c');
});

test('nameFromTask makes short names', () => {
  assert.equal(nameFromTask('Fix the flaky checkout test'), 'Fix flaky checkout test');
  assert.equal(nameFromTask('please can you write tests for the parser module and the lexer'), 'Write tests for parser');
  assert.equal(nameFromTask('List repository files and explain greet.js'), 'List repository files');
  assert.equal(nameFromTask(''), 'New task');
});

test('extractQuestion finds a closing question only', () => {
  assert.equal(extractQuestion('I changed the file.\n\nShould I also update the docs?'), 'Should I also update the docs?');
  assert.equal(extractQuestion('Done. Would you like me to run the full suite as well.'), 'Would you like me to run the full suite as well.');
  assert.equal(extractQuestion('Why did it fail? Because the cache was cold.\n\nI fixed it and the tests pass.'), null);
  assert.equal(extractQuestion('All 12 tests pass.'), null);
  assert.equal(extractQuestion(''), null);
});

test('firstSentence and plain strip markdown', () => {
  assert.equal(firstSentence('## Result\n\nThe **export** now streams rows. It also batches.'), 'Result The export now streams rows.');
  assert.equal(plain('Use `npm test` and [docs](http://x)'), 'Use npm test and docs');
});

test('format helpers', () => {
  assert.equal(duration(4000), '4 s');
  assert.equal(duration(125000), '2 min');
  assert.equal(duration(3_900_000), '1 h 5 min');
  assert.equal(tokens(980), '980');
  assert.equal(tokens(12_400), '12.4k');
  assert.equal(tokens(1_250_000), '1.3M');
  assert.equal(money(null), 'not reported');
  assert.equal(money(0.0797), '$0.08');
  assert.equal(money(0.004), '<$0.01');
  assert.equal(percent(0.153), '15%');
  assert.equal(clip('one two three four five', 12), 'one two…');
  assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku 4.5');
  assert.equal(shortModel('claude-opus-5-5'), 'opus 5.5');
});

test('states and events are consistent', () => {
  for (const s of Object.values(STATE)) {
    assert.ok(LOOK[s], 'look for ' + s);
    assert.ok(PRIORITY[s] !== undefined, 'priority for ' + s);
  }
  assert.ok(NEEDS_YOU.has('needs_ok'));
  assert.equal(lookOf('nonsense').shape, 'work');
  const v = newAgentView({ agentId: 'abc123', name: 'X', harness: 'codex' }, 1000);
  assert.equal(v.usage.costUsd, null, 'codex cost is not reported');
  assert.equal(v.spark.length, SPARK_BUCKETS);
  assert.equal(v.state, 'starting');
  assert.ok(EV.CREATED && EV.APPROVAL);
});

test('pastTense rewrites finished steps', () => {
  assert.equal(pastTense('Running the tests'), 'Ran the tests');
  assert.equal(pastTense('Reading greet.js'), 'Read greet.js');
  assert.equal(pastTense('Writing a reply'), 'Wrote a reply');
  assert.equal(pastTense('Asking a helper to find bugs'), 'Asked a helper to find bugs');
  assert.equal(pastTense('Deploy the app'), 'Deploy the app');
});
