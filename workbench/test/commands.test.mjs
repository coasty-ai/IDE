import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, describeIntent } from '../src/core/commands.mjs';

// A small world like the demo seed. Asks sit on the agents, as in AgentView.
const agents = [
  { id: 'a1b2c3', name: 'Checkout fix', task: 'Fix the checkout total rounding bug', state: 'needs_ok', kind: 'agent',
    ask: { id: 'ask-perm', type: 'permission', sentence: 'Checkout fix wants to run a command', options: ['Allow', 'Deny'], primary: 'Allow' } },
  { id: 'a1b2c3-11111111', name: 'Read cart code', task: 'Read the cart code', state: 'finished', kind: 'helper', parentId: 'a1b2c3' },
  { id: 'd4e5f6', name: 'Search cleanup', task: 'Clean up the search route handlers', state: 'question', kind: 'agent',
    ask: { id: 'ask-q', type: 'question', sentence: 'Should I keep the old route?', options: [] } },
  { id: '0a0b0c', name: 'Flaky test', task: 'Fix the flaky checkout test', state: 'maybe_stuck', kind: 'agent',
    ask: { id: 'ask-stuck', type: 'stuck', sentence: 'Flaky test has hit the same error three times.', options: ['Stop it', 'Let it keep trying'] } },
  { id: '0a0b0c-22222222', name: 'Find flaky cause', task: 'Find why the checkout test is flaky', state: 'working', kind: 'helper', parentId: '0a0b0c' },
  { id: '1a2b3c', name: 'Invoice export', task: 'Stream rows in the invoice export', state: 'done_checked', kind: 'agent' },
  { id: '4d5e6f', name: 'Help pages', task: 'Update the help pages', state: 'done_claimed', kind: 'agent' },
  { id: '7a8b9c', name: 'Onboarding', task: 'Improve the onboarding flow', state: 'working', kind: 'agent' },
  { id: '9f9f9f', name: 'Add tests to parser', task: 'Add tests to the parser', state: 'working', kind: 'agent' },
];
const machines = [
  { id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true },
  { id: 'cloud-1', name: 'Cloud 1', kind: 'cloud', awake: true },
  { id: 'cloud-2', name: 'Cloud 2', kind: 'cloud', awake: false },
  { id: 'cloud-3', name: 'Cloud 3', kind: 'cloud', awake: true },
];
const harnesses = { claude: true, codex: true, sim: false };

const CTX = {
  none: { agents, machines, harnesses, focusId: null },
  onboarding: { agents, machines, harnesses, focusId: '7a8b9c' },
  invoice: { agents, machines, harnesses, focusId: '1a2b3c' },
  permission: { agents, machines, harnesses, focusId: 'a1b2c3' },
  question: { agents, machines, harnesses, focusId: 'd4e5f6' },
  stuck: { agents, machines, harnesses, focusId: '0a0b0c' },
  pending: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c1' } },
  pendingOnPermission: { agents, machines, harnesses, focusId: 'a1b2c3', pendingConfirm: { id: 'c1' } },
};

const start = (...tasks) => ({ kind: 'start', tasks: tasks.map(([task, harness = 'claude', machine = 'laptop']) => ({ task, harness, machine })) });
const allow = { kind: 'allow', agentId: 'a1b2c3', askId: 'ask-perm' };
const deny = { kind: 'deny', agentId: 'a1b2c3', askId: 'ask-perm' };
const answer = (text, agentId = 'd4e5f6', askId = 'ask-q') => ({ kind: 'answer', agentId, askId, text });

// [what the person typed or said, context, expected intent]
const TABLE = [
  // --- The contract's own examples
  ['start an agent to fix the flaky checkout test', 'none', start(['fix the flaky checkout test'])],
  ['have codex write tests for the parser', 'none', start(['write tests for the parser', 'codex'])],
  ['start Claude and Codex on the checkout bug, each on its own cloud machine', 'none',
    start(['the checkout bug', 'claude', 'cloud'], ['the checkout bug', 'codex', 'cloud'])],
  ['fix the login redirect', 'none', { kind: 'task', task: 'fix the login redirect' }],
  ['keep the old route', 'question', answer('keep the old route')],
  ['yes', 'permission', allow],
  ['go ahead', 'permission', allow],
  ['allow it', 'permission', allow],
  ['approve', 'permission', allow],
  ['no', 'permission', deny],
  ["don't", 'permission', deny],
  ['deny', 'permission', deny],
  ['stop the flaky test', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  ['stop everything', 'none', { kind: 'stop_all' }],
  ['pause everything', 'none', { kind: 'stop_all' }],
  ['tell search cleanup to keep the old route', 'none', { kind: 'say', agentId: 'd4e5f6', text: 'keep the old route' }],
  ['what needs me', 'none', { kind: 'status', needsMe: true }],
  ['status', 'none', { kind: 'status' }],
  ['what is checkout fix doing', 'none', { kind: 'status', agentId: 'a1b2c3' }],
  ['how much have I spent today', 'none', { kind: 'spend' }],
  ['sleep cloud 2', 'none', { kind: 'sleep', machineIds: ['cloud-2'] }],
  ['wake cloud 2', 'none', { kind: 'wake', machineIds: ['cloud-2'] }],
  ['sleep idle machines', 'none', { kind: 'sleep_idle' }],
  ['do it', 'pending', { kind: 'confirm', go: true }],
  ['yes', 'pending', { kind: 'confirm', go: true }],
  ['cancel', 'pending', { kind: 'confirm', go: false }],
  ['never mind', 'pending', { kind: 'confirm', go: false }],
  ['the checkout bug', 'none', { kind: 'unknown', text: 'the checkout bug' }],

  // --- Typed with punctuation and capitals
  ['Start Claude and Codex on the checkout bug, each on its own cloud machine.', 'none',
    start(['the checkout bug', 'claude', 'cloud'], ['the checkout bug', 'codex', 'cloud'])],
  ["What's checkout fix doing?", 'none', { kind: 'status', agentId: 'a1b2c3' }],
  ['Update the docs for the new API.', 'none', { kind: 'task', task: 'Update the docs for the new API' }],
  ['new agent: fix the login page', 'none', start(['fix the login page'])],
  ['codex, write tests for the parser', 'none', start(['write tests for the parser', 'codex'])],
  ['message flaky test: try a longer timeout', 'none', { kind: 'say', agentId: '0a0b0c', text: 'try a longer timeout' }],

  // --- Speech-to-text: lowercase, no punctuation, fillers, mishearings
  ['okay so um start claude and codex on the checkout bug each on its own cloud machine please', 'none',
    start(['the checkout bug', 'claude', 'cloud'], ['the checkout bug', 'codex', 'cloud'])],
  ['um okay so start cloud and codex on the checkout bug', 'none', start(['the checkout bug', 'claude'], ['the checkout bug', 'codex'])],
  ['uh stop everything', 'none', { kind: 'stop_all' }],
  ['um what needs me', 'none', { kind: 'status', needsMe: true }],
  ['hey workbench what is happening', 'none', { kind: 'status' }],
  ['whats checkout fix doing', 'none', { kind: 'status', agentId: 'a1b2c3' }],
  ['how much have i spent', 'none', { kind: 'spend' }],
  ['whats my spend', 'none', { kind: 'spend' }],
  ['can you please fix the login redirect', 'none', { kind: 'task', task: 'fix the login redirect' }],
  ['could you spin up an agent for the checkout bug', 'none', start(['the checkout bug'])],
  ['uh start a codex agent to refactor the payments module', 'none', start(['refactor the payments module', 'codex'])],
  ['start code x on the parser', 'none', start(['the parser', 'codex'])],
  ['wake up cloud two', 'none', { kind: 'wake', machineIds: ['cloud-2'] }],
  ['put cloud to to sleep', 'none', { kind: 'sleep', machineIds: ['cloud-2'] }],
  ['put the idle machines to sleep', 'none', { kind: 'sleep_idle' }],
  ['stop the check out fix', 'none', { kind: 'stop', agentIds: ['a1b2c3'] }],
  ['stop search clean up', 'none', { kind: 'stop', agentIds: ['d4e5f6'] }],
  ['yeah sure go for it', 'permission', allow],
  ['okay', 'permission', allow],
  ['nah', 'permission', deny],
  ["don't allow it", 'permission', deny],
  ['not now', 'permission', deny],
  ['no use the staging database instead', 'permission', { ...deny, text: 'use the staging database instead' }],
  ['sure thing', 'pending', { kind: 'confirm', go: true }],
  ['right', 'pending', { kind: 'confirm', go: true }],
  ['yeah do it', 'pending', { kind: 'confirm', go: true }],
  ['nevermind', 'pending', { kind: 'confirm', go: false }],
  ['forget it', 'pending', { kind: 'confirm', go: false }],
  ['um yes keep the old route', 'question', answer('yes keep the old route')],

  // --- More ways to launch
  ['spin up two agents to look into the memory leak', 'none', start(['look into the memory leak'], ['look into the memory leak'])],
  ['start two codex agents on the parser bug', 'none', start(['the parser bug', 'codex'], ['the parser bug', 'codex'])],
  ['launch an agent that fixes the flaky test', 'none', start(['fix the flaky test'])],
  ['start an agent that will write the release notes', 'none', start(['write the release notes'])],
  ['get codex to clean up the search index on cloud 3', 'none', start(['clean up the search index', 'codex', 'cloud-3'])],
  ['start claude in the cloud to fix the login', 'none', start(['fix the login', 'claude', 'cloud'])],
  ['start an agent on a cloud machine to fix the login', 'none', start(['fix the login', 'claude', 'cloud'])],
  ['start claude on the parser and codex on the docs', 'none', start(['the parser'], ['the docs', 'codex'])],
  ['ask codex to write tests for the parser', 'none', start(['write tests for the parser', 'codex'])],
  ['i want codex to write tests for the parser', 'none', start(['write tests for the parser', 'codex'])],
  ['fix the login redirect using codex', 'none', start(['fix the login redirect', 'codex'])],
  ['send an agent to look at the logs locally', 'none', start(['look at the logs'])],
  ['go ahead and start an agent to fix the login', 'none', start(['fix the login'])],
  // "cloud" or "codex" inside the task itself does not pick a machine or a harness
  ['start an agent to fix the cloud sync bug', 'none', start(['fix the cloud sync bug'])],
  ['start an agent to write tests for the codex adapter', 'none', start(['write tests for the codex adapter'])],
  ['start an agent to review codex', 'none', start(['review codex'])],
  ['start an agent to fix the login, codex', 'none', start(['fix the login', 'codex'])],
  ['start ten agents on the parser bug', 'none', start(...new Array(5).fill(['the parser bug']))], // at most five at once

  // --- Stopping, talking, asking how things are
  ['stop the flaky test and search cleanup', 'none', { kind: 'stop', agentIds: ['0a0b0c', 'd4e5f6'] }],
  ['please stop the onboarding agent', 'none', { kind: 'stop', agentIds: ['7a8b9c'] }],
  ['stop the one fixing the flaky test', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  ['stop the stuck one', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  ['stop 0a0b0c', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  ['stop it', 'onboarding', { kind: 'stop', agentIds: ['7a8b9c'] }],
  ['stop this one', 'onboarding', { kind: 'stop', agentIds: ['7a8b9c'] }],
  ['kill them all', 'none', { kind: 'stop_all' }],
  ['stop all agents now', 'none', { kind: 'stop_all' }],
  ['tell it to use the new route', 'onboarding', { kind: 'say', agentId: '7a8b9c', text: 'use the new route' }],
  ['tell add tests to parser to use vitest', 'none', { kind: 'say', agentId: '9f9f9f', text: 'use vitest' }],
  ['tell search cleanup keep the old route', 'none', { kind: 'say', agentId: 'd4e5f6', text: 'keep the old route' }],
  ['ask search cleanup why it chose the old route', 'none', { kind: 'say', agentId: 'd4e5f6', text: 'why it chose the old route' }],
  ['let search cleanup know that the old route is deprecated', 'none', { kind: 'say', agentId: 'd4e5f6', text: 'the old route is deprecated' }],
  ['how is onboarding going', 'none', { kind: 'status', agentId: '7a8b9c' }],
  ['is invoice export done', 'none', { kind: 'status', agentId: '1a2b3c' }],
  ['is it done', 'invoice', { kind: 'status', agentId: '1a2b3c' }],
  ['what is the status of help pages', 'none', { kind: 'status', agentId: '4d5e6f' }],
  ['check on onboarding', 'none', { kind: 'status', agentId: '7a8b9c' }],
  ['who needs me', 'none', { kind: 'status', needsMe: true }],
  ['is anything waiting on me', 'none', { kind: 'status', needsMe: true }],
  ['give me an update', 'none', { kind: 'status' }],
  ['how much is this costing me', 'none', { kind: 'spend' }],
  ['turn off cloud 1 and cloud 3', 'none', { kind: 'sleep', machineIds: ['cloud-1', 'cloud-3'] }],
  ['wake cloud 2 and 3', 'none', { kind: 'wake', machineIds: ['cloud-2', 'cloud-3'] }],
  ['stop cloud 2', 'none', { kind: 'sleep', machineIds: ['cloud-2'] }],
  ['check the logs', 'none', { kind: 'task', task: 'check the logs' }],
  ['turn off the dark mode', 'none', { kind: 'task', task: 'turn off the dark mode' }],
  // Generic nouns after an ordinary verb are work, not a launch.
  ['add a job to the queue', 'none', { kind: 'task', task: 'add a job to the queue' }],
  ['create a worker pool', 'none', { kind: 'task', task: 'create a worker pool' }],
  ['make a copy of the config', 'none', { kind: 'task', task: 'make a copy of the config' }],
  ['run one test at a time', 'none', { kind: 'task', task: 'run one test at a time' }],
  ['start a new task to fix the login', 'none', start(['fix the login'])],
  // "to the cloud" in a task is not a machine.
  ['migrate the database to the cloud', 'none', { kind: 'task', task: 'migrate the database to the cloud' }],
  ['start an agent to migrate the database to the cloud', 'none', start(['migrate the database to the cloud'])],

  // --- While a question waits, ordinary words are the answer...
  ['stop after the first failure', 'question', answer('stop after the first failure')],
  ['start with the unit tests', 'question', answer('start with the unit tests')],
  ['how much would the second option cost', 'question', answer('how much would the second option cost')],
  ['fix the old route first', 'question', answer('fix the old route first')],
  ['yes', 'question', answer('yes')],
  ['one for each module', 'question', answer('one for each module')],
  ['make a copy of the config', 'question', answer('make a copy of the config')],
  ['stop the tests', 'question', answer('stop the tests')], // one loose word is not enough to stop an agent
  ['cost', 'question', answer('cost')],
  ['budget', 'question', answer('budget')],
  ['update', 'question', answer('update')],
  ['summary', 'question', answer('summary')],
  ['report', 'question', answer('report')],
  ['stop onboarding', 'question', { kind: 'stop', agentIds: ['7a8b9c'] }], // a whole name is
  ['tell onboarding to use the new route', 'question', { kind: 'say', agentId: '7a8b9c', text: 'use the new route' }],
  ['give me an update', 'question', { kind: 'status' }],
  // ...but unmistakable commands still work
  ['stop everything', 'question', { kind: 'stop_all' }],
  ['what is onboarding doing', 'question', { kind: 'status', agentId: '7a8b9c' }],
  ['how much have i spent', 'question', { kind: 'spend' }],
  ['sleep cloud 2', 'question', { kind: 'sleep', machineIds: ['cloud-2'] }],
  ['start an agent to fix the login', 'question', start(['fix the login'])],
  ['tell search cleanup to keep the old route', 'question', { kind: 'say', agentId: 'd4e5f6', text: 'keep the old route' }],

  // --- Stuck: the offered choice keeps its exact words; anything else is a hint
  ['keep going', 'stuck', answer('Let it keep trying', '0a0b0c', 'ask-stuck')],
  ['let it keep trying', 'stuck', answer('Let it keep trying', '0a0b0c', 'ask-stuck')],
  ['try a longer timeout', 'stuck', answer('try a longer timeout', '0a0b0c', 'ask-stuck')],
  ['stop it', 'stuck', { kind: 'stop', agentIds: ['0a0b0c'] }],

  // --- A pending launch takes "yes" before a permission ask does
  ['yes', 'pendingOnPermission', { kind: 'confirm', go: true }],
  ['stop', 'pendingOnPermission', { kind: 'confirm', go: false }],

  // --- Nothing waiting: short replies mean nothing
  ['yes', 'none', { kind: 'unknown', text: 'yes' }],
  ['do it', 'none', { kind: 'unknown', text: 'do it' }],
  ['go ahead', 'none', { kind: 'unknown', text: 'go ahead' }],
  ['cancel', 'onboarding', { kind: 'unknown', text: 'cancel' }],
  ['fix it', 'none', { kind: 'unknown', text: 'fix it' }],
  ['start codex', 'none', { kind: 'unknown', text: 'start codex' }],
  ['why is the build slow', 'none', { kind: 'unknown', text: 'why is the build slow' }],
  ['', 'none', { kind: 'unknown', text: '' }],
  ['um uh', 'none', { kind: 'unknown', text: 'um uh' }],
];

test(`parseCommand handles ${TABLE.length} phrasings`, () => {
  assert.ok(TABLE.length >= 40);
  const failures = [];
  for (const [text, ctxName, expected] of TABLE) {
    const got = parseCommand(text, CTX[ctxName]);
    try {
      assert.deepEqual(got, expected);
    } catch {
      failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`);
    }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
});

test('unresolved references still give the intent, with no agent', () => {
  assert.deepEqual(parseCommand('stop the frobnicator', CTX.none), { kind: 'stop', agentIds: [] });
  assert.deepEqual(parseCommand('tell it to hurry up', CTX.none), { kind: 'say', agentId: null, text: 'hurry up' });
  // A name that matches nothing is not sent anywhere, not even to the focused agent.
  assert.deepEqual(parseCommand('tell the frobnicator to hurry up', CTX.onboarding), { kind: 'unknown', text: 'tell the frobnicator to hurry up' });
  assert.deepEqual(parseCommand('what is the frobnicator doing', CTX.none), { kind: 'status' });
  assert.deepEqual(parseCommand('stop it', CTX.none), { kind: 'stop', agentIds: [] });
  // A machine that does not exist: no ids, so the engine can say it found nothing.
  assert.deepEqual(parseCommand('sleep cloud 7', CTX.none), { kind: 'sleep', machineIds: [] });
  assert.deepEqual(parseCommand('sleep the cloud machines', CTX.none), { kind: 'sleep', machineIds: ['cloud-1', 'cloud-2', 'cloud-3'] });
});

test('long dictation stays fast', () => {
  const t0 = Date.now();
  parseCommand('tell ' + 'word '.repeat(3000), CTX.none);
  parseCommand('stop ' + 'the flaky test and '.repeat(500), CTX.none);
  parseCommand('start an agent to ' + 'clean up the cloud thing and '.repeat(500), CTX.none);
  parseCommand('what is ' + 'very '.repeat(3000) + 'doing', CTX.none);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
});

test('a short reply goes to the helper that waits when its root is focused', () => {
  const tree = [
    { id: 'b0b0b0', name: 'Docs refresh', task: 'Refresh the docs site', state: 'working', kind: 'agent' },
    { id: 'b0b0b0-33333333', name: 'Verify links', task: 'Verify the docs links', state: 'needs_ok', kind: 'helper', parentId: 'b0b0b0', rootId: 'b0b0b0',
      ask: { id: 'ask-helper', type: 'permission', sentence: 'Verify links wants to run a command', options: ['Allow', 'Deny'] } },
    { id: 'b0b0b0-44444444', name: 'Draft intro', task: 'Draft the intro', state: 'working', kind: 'helper', parentId: 'b0b0b0', rootId: 'b0b0b0' },
  ];
  assert.deepEqual(parseCommand('yes', { agents: tree, focusId: 'b0b0b0' }), { kind: 'allow', agentId: 'b0b0b0-33333333', askId: 'ask-helper' });
  assert.deepEqual(parseCommand('no', { agents: tree, focusId: 'b0b0b0' }), { kind: 'deny', agentId: 'b0b0b0-33333333', askId: 'ask-helper' });
  // Two helpers waiting: not clear which one, so "yes" means nothing.
  const two = tree.map(a => (a.id === 'b0b0b0-44444444' ? { ...a, ask: { id: 'ask-2', type: 'question', sentence: 'Which tone?', options: [] } } : a));
  assert.deepEqual(parseCommand('yes', { agents: two, focusId: 'b0b0b0' }), { kind: 'unknown', text: 'yes' });
});

test('the default machine is the laptop from ctx, or "laptop" when there is none', () => {
  const custom = { agents: [], machines: [{ id: 'mbp', name: 'Your laptop', kind: 'laptop' }] };
  assert.deepEqual(parseCommand('start an agent to fix the login', custom), start(['fix the login', 'claude', 'mbp']));
  assert.deepEqual(parseCommand('start an agent to fix the login', {}), start(['fix the login']));
});

test('parseCommand never throws on odd input', () => {
  for (const [text, ctx] of [[undefined, undefined], [null, null], [42, { agents: 'x', machines: 3, focusId: 7 }],
    ['stop it', { focusId: 'zz' }], ['tell it to go', { agents: [null, { id: 1 }, { id: 'ok', name: null, task: 5 }], focusId: 'ok' }],
    ['yes', { agents: [{ id: 'q', ask: 'not an object' }], focusId: 'q' }], ['x'.repeat(5000), {}], ['start ' + 'and codex '.repeat(200), {}]]) {
    const got = parseCommand(text, ctx);
    assert.equal(typeof got.kind, 'string');
  }
  assert.deepEqual(parseCommand(42, {}), { kind: 'unknown', text: '42' });
  assert.deepEqual(parseCommand('stop it', { focusId: 'zz' }), { kind: 'stop', agentIds: ['zz'] });
});

test('describeIntent writes plain confirm sentences', () => {
  assert.equal(describeIntent(start(['fix the flaky checkout test']), CTX.none), 'Start Claude on “fix the flaky checkout test”?');
  assert.equal(describeIntent(start(['the checkout bug', 'claude', 'cloud'], ['the checkout bug', 'codex', 'cloud']), CTX.none),
    'Start Claude and Codex on “the checkout bug”, each on a cloud machine?');
  // straight from parsing, and without any context at all
  assert.equal(describeIntent(parseCommand('start Claude and Codex on the checkout bug, each on its own cloud machine', CTX.none), CTX.none),
    'Start Claude and Codex on “the checkout bug”, each on a cloud machine?');
  assert.equal(describeIntent(start(['fix the flaky checkout test'])), 'Start Claude on “fix the flaky checkout test”?');
  assert.equal(describeIntent(start(['the parser bug', 'codex'], ['the parser bug', 'codex']), CTX.none), 'Start two Codex agents on “the parser bug”?');
  assert.equal(describeIntent(start(['the parser'], ['the docs', 'codex']), CTX.none), 'Start Claude on “the parser” and Codex on “the docs”?');
  assert.equal(describeIntent(start(['clean up the search index', 'codex', 'cloud-3']), CTX.none), 'Start Codex on “clean up the search index” on Cloud 3?');
  assert.equal(describeIntent(start(['fix the login', 'claude', 'cloud']), CTX.none), 'Start Claude on “fix the login” on a cloud machine?');
  assert.equal(describeIntent({ kind: 'task', task: 'fix the login redirect' }, CTX.none), 'Start Claude on “fix the login redirect”?');
  assert.equal(describeIntent({ kind: 'stop', agentIds: ['0a0b0c', 'd4e5f6'] }, CTX.none), 'Stop Flaky test and Search cleanup?');
  assert.equal(describeIntent({ kind: 'stop_all' }), 'Stop every agent?');
  assert.equal(describeIntent({ kind: 'say', agentId: 'd4e5f6', text: 'keep the old route' }, CTX.none), 'Tell Search cleanup “keep the old route”?');
  assert.equal(describeIntent({ kind: 'sleep', machineIds: ['cloud-2'] }, CTX.none), 'Put Cloud 2 to sleep?');
  assert.equal(describeIntent({ kind: 'wake', machineIds: ['cloud-2', 'cloud-3'] }, CTX.none), 'Wake Cloud 2 and Cloud 3?');
  assert.equal(describeIntent({ kind: 'sleep_idle' }), 'Put the idle machines to sleep?');
  assert.equal(describeIntent({ kind: 'status', needsMe: true }), 'Show what needs you?');
  assert.equal(describeIntent({ kind: 'spend' }), 'Show what you have spent today?');
  assert.equal(describeIntent({ kind: 'allow', agentId: 'a1b2c3' }, CTX.none), 'Allow the request from Checkout fix?');
  assert.equal(describeIntent({ kind: 'confirm', go: false }), 'Cancel?');
  // Long tasks are shortened, and nothing odd ever throws.
  assert.ok(describeIntent(start(['word '.repeat(100)])).length < 120);
  for (const odd of [null, undefined, 5, {}, { kind: 'start' }, { kind: 'start', tasks: [null, { task: 3 }] }, { kind: 'stop' }, { kind: 'nope' }]) {
    assert.equal(typeof describeIntent(odd, null), 'string');
  }
});
