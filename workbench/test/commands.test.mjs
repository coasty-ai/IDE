import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, describeIntent, HELP_REPLY } from '../src/core/commands.mjs';
import { nameFromTask } from '../src/shared/narrate.mjs';

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
  pendingStop: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c2', kind: 'stop' } },
  pendingStart: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c3', kind: 'start' } },
  pendingSay: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c4', kind: 'say' } },
  helper: { agents, machines, harnesses, focusId: 'a1b2c3-11111111' },
  pendingForget: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c5', kind: 'forget' } },
  pendingMerge: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c6', kind: 'merge' } },
  pendingDiscard: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c7', kind: 'discard' } },
  // A card with a permission behind it: the card takes the words first, and what it does not take never reaches the permission.
  pendingMergeOnPermission: { agents, machines, harnesses, focusId: 'a1b2c3', pendingConfirm: { id: 'c6', kind: 'merge' } },
  pendingDiscardOnPermission: { agents, machines, harnesses, focusId: 'a1b2c3', pendingConfirm: { id: 'c7', kind: 'discard' } },
  // A card that ran out while it was on screen (the engine answers a yes to it with "no longer waiting").
  pendingGone: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c0', gone: true } },
  // Merge and throw-away cards as the engine shows them: they say whose work they are about.
  pendingMergeOf: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c12', kind: 'merge', agentId: '1a2b3c' } },
  pendingDiscardOf: { agents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c13', kind: 'discard', agentId: '1a2b3c' } },
  pendingMergeOfOnQuestion: { agents, machines, harnesses, focusId: 'd4e5f6', pendingConfirm: { id: 'c14', kind: 'merge', agentId: '1a2b3c' } },
};

// Dogfooding: Workbench working on its own repository, so agent names share words with the commands themselves.
const dogAgents = [
  { id: 'aa0001', name: 'Merge command', task: 'Add a merge command to the words', state: 'done_checked', kind: 'agent' },
  { id: 'bb0002', name: 'Diff viewer', task: 'Build the diff viewer for the git screen', state: 'done_claimed', kind: 'agent' },
  { id: 'cc0003', name: 'Git screen', task: 'Draw the git screen with circuit traces', state: 'working', kind: 'agent' },
  { id: 'cc0003-33333333', name: 'Draw the graph', task: 'Draw the commit graph', state: 'working', kind: 'helper', parentId: 'cc0003', rootId: 'cc0003' },
  { id: 'dd0004', name: 'Config merge', task: 'Merge the two config files', state: 'done_claimed', kind: 'agent' },
  { id: 'ee0005', name: 'Login fix', task: 'Fix the login page error', state: 'done_checked', kind: 'agent' },
  // Same-named twins ("start two agents on …" names both alike); one is from an earlier run, one was stopped.
  { id: 'ff0006', name: 'Search cleanup', task: 'Clean up the search route handlers', state: 'done_checked', kind: 'agent', earlier: true },
  { id: 'ff0007', name: 'Search cleanup', task: 'Clean up the search tests', state: 'stopped', kind: 'agent' },
  { id: '110008', name: 'Invoice export', task: 'Stream rows in the invoice export', state: 'done_checked', kind: 'agent', earlier: true },
  { id: '220009', name: 'Work queue', task: 'Add a work queue for agents', state: 'question', kind: 'agent',
    ask: { id: 'ask-wq', type: 'question', sentence: 'Should the queue be first in, first out?', options: [] } },
  { id: '33000a', name: 'Branch picker', task: 'Let people pick a branch', state: 'needs_ok', kind: 'agent',
    ask: { id: 'ask-bp', type: 'permission', sentence: 'Branch picker wants to run a command', options: ['Allow', 'Deny'], primary: 'Allow' } },
];
const DOG = {
  dogNone: { agents: dogAgents, machines, harnesses, focusId: null },
  dogDone: { agents: dogAgents, machines, harnesses, focusId: 'aa0001' },
  dogHelper: { agents: dogAgents, machines, harnesses, focusId: 'cc0003-33333333' },
  dogEarlier: { agents: dogAgents, machines, harnesses, focusId: '110008' },
  dogTwin: { agents: dogAgents, machines, harnesses, focusId: 'ff0007' },
  dogQuestion: { agents: dogAgents, machines, harnesses, focusId: '220009' },
  dogPermission: { agents: dogAgents, machines, harnesses, focusId: '33000a' },
  dogPendingMerge: { agents: dogAgents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c8', kind: 'merge' } },
  dogPendingDiscard: { agents: dogAgents, machines, harnesses, focusId: null, pendingConfirm: { id: 'c9', kind: 'discard' } },
  dogBranch: { agents: dogAgents, machines, harnesses, focusId: 'aa0001', repo: { branch: 'feature/login-v2' } },
};

// Names as the engine makes them from a task (nameFromTask): a verb first, so people say the rest of the name.
const fromTask = (task, fields) => ({ name: nameFromTask(task), task, kind: 'agent', ...fields });
// Two names share "config files", and neither is only that; a third agent asks a question with "merge" in it.
const configAgents = [
  fromTask('Update the config files', { id: 'cf0001', state: 'done_claimed' }),
  fromTask('Split the config files per environment', { id: 'cf0002', state: 'done_checked' }),
  fromTask('Fix the login page error', { id: 'cf0003', state: 'question',
    ask: { id: 'ask-cf', type: 'question', sentence: 'Should I merge them into one?', options: [] } }),
];
// An agent whose name people say without its verb ("the unused imports"), in each of the ways it can wait on the person.
const importsAgent = fromTask('Remove the unused imports', { id: 'ab0001', state: 'question',
  ask: { id: 'ask-ui', type: 'question', sentence: 'Should I keep the ones the tests use, or discard them too?', options: [] } });
const stagingAgent = fromTask('Update the config files for staging', { id: 'ab0002', state: 'done_claimed' });
const importsWith = (fields, staging = {}, more = []) => [{ ...importsAgent, ...fields }, { ...stagingAgent, ...staging }, ...more];
const NAMED = {
  configNone: { agents: configAgents, machines, harnesses, focusId: null },
  configQuestion: { agents: configAgents, machines, harnesses, focusId: 'cf0003' },
  importsQuestion: { agents: importsWith({}), machines, harnesses, focusId: 'ab0001' },
  importsNone: { agents: importsWith({ state: 'done_claimed', ask: undefined }), machines, harnesses, focusId: null },
  importsStuck: { agents: importsWith({ state: 'maybe_stuck', ask: { id: 'ask-us', type: 'stuck',
    sentence: 'Remove unused imports has hit the same error three times.', options: ['Stop it', 'Let it keep trying'] } }), machines, harnesses, focusId: 'ab0001' },
  importsPermission: { agents: importsWith({ state: 'needs_ok', ask: { id: 'ask-up', type: 'permission',
    sentence: 'Remove unused imports wants to run a command', options: ['Allow', 'Deny'], primary: 'Allow' } }), machines, harnesses, focusId: 'ab0001' },
  // Its helper asks, with the agent in the centre.
  importsHelper: { agents: importsWith({ state: 'working', ask: undefined }, {}, [{ id: 'ab0001-44444444', name: 'Find unused imports',
    task: 'Find the unused imports', state: 'question', kind: 'helper', parentId: 'ab0001', rootId: 'ab0001',
    ask: { id: 'ask-uh', type: 'question', sentence: 'Should I look in the tests too?', options: [] } }]), machines, harnesses, focusId: 'ab0001' },
  // Its helper holds a permission, with the agent in the centre.
  importsHelperPermission: { agents: importsWith({ state: 'working', ask: undefined }, {}, [{ id: 'ab0001-55555555', name: 'Scan imports',
    task: 'Scan the imports', state: 'needs_ok', kind: 'helper', parentId: 'ab0001', rootId: 'ab0001',
    ask: { id: 'ask-hp', type: 'permission', sentence: 'Scan imports wants to run a command', options: ['Allow', 'Deny'], primary: 'Allow' } }]),
  machines, harnesses, focusId: 'ab0001' },
  // Another agent asks; this one is done.
  importsOther: { agents: importsWith({ state: 'done_claimed', ask: undefined }, { state: 'question',
    ask: { id: 'ask-st', type: 'question', sentence: 'Which unused imports should go?', options: [] } }), machines, harnesses, focusId: 'ab0002' },
  // A merge card for the other agent is on screen (the page sends no focus then).
  importsCard: { agents: importsWith({ state: 'done_claimed', ask: undefined }), machines, harnesses, focusId: null,
    pendingConfirm: { id: 'c11', kind: 'merge', agentId: 'ab0002' } },
};

// A launch's harness is the agent the words named, or null: then the engine gives the work to the person's default agent.
const start = (...tasks) => ({ kind: 'start', tasks: tasks.map(([task, harness = null, machine = 'laptop']) => ({ task, harness, machine })) });
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
  ['the checkout bug', 'none', { kind: 'status', agentId: 'a1b2c3' }], // an agent at work's words, and nothing more

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
  ['start an agent on a cloud machine to fix the login', 'none', start(['fix the login', null, 'cloud'])],
  ['start claude on the parser and codex on the docs', 'none', start(['the parser', 'claude'], ['the docs', 'codex'])],
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
  ['stop the one fixing the flaky test', 'none', { kind: 'stop', agentIds: ['0a0b0c'], sure: false }], // "fixing" is from its task
  ['stop the stuck one', 'none', { kind: 'stop', agentIds: ['0a0b0c'], sure: false }], // found by its state, not its name
  ['stop 0a0b0c', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  ['stop it', 'onboarding', { kind: 'stop', agentIds: ['7a8b9c'] }],
  ['stop this one', 'onboarding', { kind: 'stop', agentIds: ['7a8b9c'] }],
  ['kill them all', 'none', { kind: 'stop_all' }],
  ['stop all agents now', 'none', { kind: 'stop_all' }],
  ['tell it to use the new route', 'onboarding', { kind: 'say', agentId: '7a8b9c', text: 'use the new route' }],
  ['tell add tests to parser to use vitest', 'none', { kind: 'say', agentId: '9f9f9f', text: 'use vitest' }],
  ['tell search cleanup keep the old route', 'none', { kind: 'say', agentId: 'd4e5f6', text: 'keep the old route', sure: false }], // no break after the name
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
  // ...and while "Stop Flaky test?" waits, "stop" means yes
  ['stop', 'pendingStop', { kind: 'confirm', go: true }],
  ['stop it', 'pendingStop', { kind: 'confirm', go: true }],
  ['cancel', 'pendingStop', { kind: 'confirm', go: false }],

  // --- A stop or a message acts at once only when the words name the agent
  // Words left over that match no agent say what to do: that is work, and gets the start confirm.
  ['stop the flaky test from timing out', 'none', { kind: 'task', task: 'stop the flaky test from timing out' }],
  ['end the onboarding flow with a summary screen', 'none', { kind: 'task', task: 'end the onboarding flow with a summary screen' }],
  ['cancel the invoice export when the account is closed', 'none', { kind: 'task', task: 'cancel the invoice export when the account is closed' }],
  ['kill the help pages popup on mobile', 'none', { kind: 'task', task: 'kill the help pages popup on mobile' }],
  ['warn the user when the onboarding flow fails', 'none', { kind: 'task', task: 'warn the user when the onboarding flow fails' }],
  // How soon is not which agent.
  ['stop the flaky test immediately', 'none', { kind: 'stop', agentIds: ['0a0b0c'] }],
  // Found through task words or one loose word: the engine asks first, and a waiting question gets the words.
  ['end the onboarding flow', 'none', { kind: 'stop', agentIds: ['7a8b9c'], sure: false }],
  ['stop the search route', 'none', { kind: 'stop', agentIds: ['d4e5f6'], sure: false }],
  ['stop the search route', 'question', answer('stop the search route')],
  ['what is the rounding bug one doing', 'question', { kind: 'status', agentId: 'a1b2c3' }], // asking is read-only: task words still do
  ['stop the tests', 'none', { kind: 'stop', agentIds: ['0a0b0c'], sure: false }],
  ['message the help pages team about billing', 'none', { kind: 'say', agentId: '4d5e6f', text: 'team about billing', sure: false }],

  // --- Nothing waiting: short replies mean nothing
  ['yes', 'none', { kind: 'unknown', text: 'yes' }],
  ['do it', 'none', { kind: 'unknown', text: 'do it' }],
  ['go ahead', 'none', { kind: 'unknown', text: 'go ahead' }],
  ['cancel', 'onboarding', { kind: 'unknown', text: 'cancel' }],
  ['fix it', 'none', { kind: 'unknown', text: 'fix it' }],
  ['start the agent', 'none', { kind: 'unknown', text: 'start the agent' }], // one that exists: no new launch
  ['why is the build slow', 'none', { kind: 'task', task: 'why is the build slow' }], // a question is work, as a prompt
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
  // ...except a stop verb with words that match no agent: that is work, with the whole sentence as its task.
  assert.deepEqual(parseCommand('stop the frobnicator', CTX.none), { kind: 'task', task: 'stop the frobnicator' });
  assert.deepEqual(parseCommand('tell it to hurry up', CTX.none), { kind: 'say', agentId: null, text: 'hurry up' });
  // A name that matches nothing is not sent anywhere, not even to the focused agent: the words are new work, asked first.
  assert.deepEqual(parseCommand('tell the frobnicator to hurry up', CTX.onboarding), { kind: 'task', task: 'tell the frobnicator to hurry up' });
  assert.deepEqual(parseCommand('what is the frobnicator doing', CTX.none), { kind: 'status' });
  assert.deepEqual(parseCommand('stop it', CTX.none), { kind: 'stop', agentIds: [] });
  // A machine that does not exist: no ids, so the engine can say it found nothing.
  assert.deepEqual(parseCommand('sleep cloud 7', CTX.none), { kind: 'sleep', machineIds: [] });
  assert.deepEqual(parseCommand('sleep the cloud machines', CTX.none), { kind: 'sleep', machineIds: ['cloud-1', 'cloud-2', 'cloud-3'] });
});

test('a stop names one agent only when no other running agent has those name words', () => {
  const one = { id: 'aa0001', name: 'Fix flaky checkout test', task: 'fix the flaky checkout test', state: 'working', kind: 'agent' };
  const two = { ...one, id: 'bb0002' }; // "start two agents on …" gives both the same name
  assert.deepEqual(parseCommand('stop the flaky test', { agents: [one, two] }), { kind: 'stop', agentIds: ['aa0001'], sure: false });
  // The other one has ended (stopped, then started again): the running one is meant.
  assert.deepEqual(parseCommand('stop the flaky test', { agents: [{ ...one, state: 'stopped' }, two] }), { kind: 'stop', agentIds: ['bb0002'] });
  // A helper that shares words does not count against its root.
  const helper = { id: 'aa0001-11111111', name: 'Find why checkout test', task: 'Find why the checkout test is flaky', state: 'working', kind: 'helper', parentId: 'aa0001', rootId: 'aa0001' };
  assert.deepEqual(parseCommand('stop the checkout test', { agents: [one, helper] }), { kind: 'stop', agentIds: ['aa0001'] });
});

test('only a plain yes allows: a yes with conditions is a no that carries the whole reply', () => {
  const cond = text => ({ ...deny, text, conditional: true });
  const rows = [
    // A clear yes followed by more words.
    ['yes but only in the tests folder', cond('yes but only in the tests folder')],
    ['allow it but only once', cond('allow it but only once')],
    ['Yes, only the tests folder.', cond('Yes, only the tests folder')],
    ['sure but only in tests', cond('sure but only in tests')],
    ['approve the onboarding copy changes', cond('approve the onboarding copy changes')],
    ['so yes but not on main', cond('yes but not on main')],
    // A softer start, when the words are no command and no work: still not a yes.
    ['ok but not on main', cond('ok but not on main')],
    ['okay but only in the tests folder', cond('okay but only in the tests folder')],
    ['fine, only the tests folder', cond('fine, only the tests folder')],
    // A no that says more carries its words; one that starts with "no" carries the words after it.
    ['not on main', { ...deny, text: 'not on main' }],
    ['no, use the staging database', { ...deny, text: 'use the staging database' }],
    // A plain yes or no is still one.
    ['yes', allow], ['yes please', allow], ['go ahead', allow], ['yes go for it', allow], ['no', deny], ['absolutely not', deny],
    // Commands and work still win when they come first, and a question that is no reply leaves the request waiting.
    ['go to search cleanup', { kind: 'status', agentId: 'd4e5f6' }],
    ['okay what needs me', { kind: 'status', needsMe: true }],
    ['okay fix the login redirect', { kind: 'task', task: 'fix the login redirect' }],
    ['ok stop it', { kind: 'stop', agentIds: ['a1b2c3'] }],
    ['do it but only in the tests folder', cond('do it but only in the tests folder')],
    // A question about the request answers nothing: it gets what exactly is asked for, and the request waits.
    ['why is it not using the test database', { kind: 'status', agentId: 'a1b2c3' }],
    ['do I need to approve this?', { kind: 'status', agentId: 'a1b2c3' }],
    ['do I need to approve this', { kind: 'status', agentId: 'a1b2c3' }],
    ['sure, but what does it delete?', { kind: 'status', agentId: 'a1b2c3' }],
    ['should I allow it', { kind: 'status', agentId: 'a1b2c3' }],
    ['okay what does it delete', { kind: 'status', agentId: 'a1b2c3' }],
    // ...but a clear no stays a no, question and all, and the agent hears it.
    ['no, why would you delete it?', { ...deny, text: 'why would you delete it?' }],
    ['hmm', { kind: 'unknown', text: 'hmm' }],
  ];
  const failures = [];
  for (const [text, expected] of rows) {
    const got = parseCommand(text, CTX.permission);
    try { assert.deepEqual(got, expected); } catch { failures.push(`${JSON.stringify(text)}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`); }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
  // Without a permission waiting, the same words are not answers.
  assert.deepEqual(parseCommand('ok but not on main', CTX.none), { kind: 'unknown', text: 'ok but not on main' });
});

test('a yes asked rather than said answers nothing: at a permission it is a status, and a card stays', () => {
  const status = { kind: 'status', agentId: 'a1b2c3' };
  const failures = [];
  const check = (text, ctxName, expected) => {
    const got = parseCommand(text, CTX[ctxName]);
    try { assert.deepEqual(got, expected); } catch { failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`); }
  };
  // Made only of yes words, typed with "?" or spoken without one: the request keeps waiting, and the reply says what it is.
  for (const text of ['is it okay', 'is it okay?', 'is it okay to run that?', 'is this allowed?', 'is it allowed', 'is that alright',
    'do you allow it', 'yes?', 'ok?', 'do it?', 'go ahead?', 'sure thing?', 'no problem?', 'why not', 'why not?',
    'yes is that right', 'yes is it okay', 'go ahead, is that okay', 'okay is that it', 'do it is that right', 'allow it is that okay',
    'go for it is that okay', 'yes is that it', 'do it is that it', 'yes is this the one',
    // ...and with its "is", "are" or "do" left out, as people say them.
    'you sure', 'that okay', 'that alright', 'it fine', 'that allowed', 'that one okay', 'you okay with that', 'you allow it', 'okay with you']) {
    check(text, 'permission', status);
  }
  // Said, not asked: still a yes. A clear no stays a no, question and all.
  for (const text of ['yes', 'yes it is', 'that is fine', "it's fine", "that's fine", "that's okay", 'yes that is right', 'yes do it', 'go ahead',
    'go for it', 'okay let it run', 'no problem', 'okay thank you', 'you go ahead', 'yes that one', 'allow it okay']) {
    check(text, 'permission', allow);
  }
  check('no?', 'permission', deny);
  // On a card: "is that right?" settles nothing, so the card stays with its hint.
  for (const ctxName of ['pending', 'pendingStart', 'pendingStop', 'pendingSay']) {
    for (const text of ['is that right?', 'is that the right one?', 'right?', 'is that okay', 'is that alright', 'is it the right one',
      'yes?', 'do it?', 'yeah is that the right one', 'make it so?', 'that right', 'that the right one', 'that okay', 'you sure']) {
      check(text, ctxName, { kind: 'unknown', text });
    }
    for (const text of ['yes', 'do it', 'right', 'that is right', "that's right", 'yes that is right', 'sounds good', 'make it so',
      'the right one', 'yes that one', 'you go ahead']) {
      check(text, ctxName, { kind: 'confirm', go: true });
    }
  }
  check('stop it is that right', 'pendingStop', { kind: 'unknown', text: 'stop it is that right' });
  check('send it is that okay', 'pendingSay', { kind: 'unknown', text: 'send it is that okay' });
  check('start it is that right', 'pendingStart', { kind: 'unknown', text: 'start it is that right' });
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
});

test('a card takes the yes words for what it does: "start it" for a launch, "stop it" for a stop, "send it" for a message', () => {
  const yes = { kind: 'confirm', go: true };
  const no = { kind: 'confirm', go: false };
  const rows = [
    ['start it', 'pendingStart', yes], ['launch it', 'pendingStart', yes], ['start it', 'pending', yes],
    ['send it', 'pendingStart', { kind: 'unknown', text: 'send it' }], ['stop it', 'pendingStart', no],
    // "start it" is no yes to "Stop Flaky test?".
    ['start it', 'pendingStop', { kind: 'unknown', text: 'start it' }], ['launch it', 'pendingStop', { kind: 'unknown', text: 'launch it' }],
    ['yes start it', 'pendingStop', { kind: 'unknown', text: 'yes start it' }], ['stop it', 'pendingStop', yes], ['yes stop it', 'pendingStop', yes],
    ['send it', 'pendingStop', { kind: 'unknown', text: 'send it' }],
    // "send it" is the natural yes to "Tell Flaky test “…”?", and "stop" there means do not send it.
    ['send it', 'pendingSay', yes], ['send', 'pendingSay', yes], ['yes send it', 'pendingSay', yes],
    ['start it', 'pendingSay', { kind: 'unknown', text: 'start it' }], ['stop', 'pendingSay', no], ['cancel', 'pendingSay', no],
  ];
  const failures = [];
  for (const [text, ctxName, expected] of rows) {
    const got = parseCommand(text, CTX[ctxName]);
    try { assert.deepEqual(got, expected); } catch { failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`); }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
});

test('sleep and wake act only when every word is about machines', () => {
  assert.deepEqual(parseCommand('turn off the laptop screen saver', CTX.none), { kind: 'task', task: 'turn off the laptop screen saver' });
  assert.notEqual(parseCommand('shut down cloud 2 search index', CTX.none).kind, 'sleep');
  assert.notEqual(parseCommand('wake cloud 2 deploy pipeline', CTX.none).kind, 'wake');
  // Plain machine commands, with the usual fillers, still act at once.
  assert.deepEqual(parseCommand('please put cloud 2 to sleep', CTX.none), { kind: 'sleep', machineIds: ['cloud-2'] });
  assert.deepEqual(parseCommand('wake up both cloud machines', CTX.none), { kind: 'wake', machineIds: ['cloud-1', 'cloud-2', 'cloud-3'] });
  assert.deepEqual(parseCommand('shut down the cloud machines', CTX.none), { kind: 'sleep', machineIds: ['cloud-1', 'cloud-2', 'cloud-3'] });
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
  assert.deepEqual(parseCommand('start an agent to fix the login', custom), start(['fix the login', null, 'mbp']));
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
  assert.equal(describeIntent(start(['fix the flaky checkout test', 'claude']), CTX.none), 'Start Claude on “fix the flaky checkout test”?');
  // No agent named: the engine gives the work to the person's default agent, and names it on its own card.
  assert.equal(describeIntent(start(['fix the flaky checkout test']), CTX.none), 'Start an agent on “fix the flaky checkout test”?');
  assert.equal(describeIntent(start(['the parser bug'], ['the parser bug']), CTX.none), 'Start two agents on “the parser bug”?');
  assert.equal(describeIntent(start(['the parser'], ['the docs', 'codex']), CTX.none), 'Start an agent on “the parser” and Codex on “the docs”?');
  assert.equal(describeIntent(start(['the checkout bug', 'claude', 'cloud'], ['the checkout bug', 'codex', 'cloud']), CTX.none),
    'Start Claude and Codex on “the checkout bug”, each on a cloud machine?');
  // straight from parsing, and without any context at all
  assert.equal(describeIntent(parseCommand('start Claude and Codex on the checkout bug, each on its own cloud machine', CTX.none), CTX.none),
    'Start Claude and Codex on “the checkout bug”, each on a cloud machine?');
  assert.equal(describeIntent(start(['fix the flaky checkout test', 'claude'])), 'Start Claude on “fix the flaky checkout test”?');
  assert.equal(describeIntent(start(['the parser bug', 'codex'], ['the parser bug', 'codex']), CTX.none), 'Start two Codex agents on “the parser bug”?');
  assert.equal(describeIntent(start(['the parser', 'claude'], ['the docs', 'codex']), CTX.none), 'Start Claude on “the parser” and Codex on “the docs”?');
  assert.equal(describeIntent(start(['clean up the search index', 'codex', 'cloud-3']), CTX.none), 'Start Codex on “clean up the search index” on Cloud 3?');
  assert.equal(describeIntent(start(['fix the login', 'claude', 'cloud']), CTX.none), 'Start Claude on “fix the login” on a cloud machine?');
  assert.equal(describeIntent({ kind: 'task', task: 'fix the login redirect' }, CTX.none), 'Start an agent on “fix the login redirect”?');
  assert.equal(describeIntent({ kind: 'help' }), 'Show what you can say?');
  assert.equal(describeIntent({ kind: 'connect' }), 'Open Agents & keys?');
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
  for (const odd of [null, undefined, 5, {}, { kind: 'start' }, { kind: 'start', tasks: [null, { task: 3 }] }, { kind: 'stop' }, { kind: 'nope' },
    { kind: 'changes' }, { kind: 'merge' }, { kind: 'discard' }, { kind: 'merge', agentId: 7, into: {} }, { kind: 'discard', agentId: ['x'] }]) {
    assert.equal(typeof describeIntent(odd, null), 'string');
  }
});

test('a stop verb that matches no agent is a work request; a name still stops at once', () => {
  assert.deepEqual(parseCommand('stop the flaky test from timing out', { agents: [] }), { kind: 'task', task: 'stop the flaky test from timing out' });
  assert.equal(describeIntent(parseCommand('stop the flaky test from timing out', { agents: [] }), { agents: [] }),
    'Start an agent on “stop the flaky test from timing out”?');
  assert.deepEqual(parseCommand('stop it', { agents: [] }), { kind: 'stop', agentIds: [] });
  assert.deepEqual(parseCommand('stop', { agents: [] }), { kind: 'stop', agentIds: [] });
  assert.deepEqual(parseCommand('stop the onboarding agent', CTX.none), { kind: 'stop', agentIds: ['7a8b9c'] });
  // While a question waits, the words answer it.
  assert.deepEqual(parseCommand('stop the frobnicator', CTX.question), answer('stop the frobnicator'));
});

// ------------------------------------------------------------------ source control: changes, merge, throw away

const ctxOf = name => CTX[name] || DOG[name] || NAMED[name];
const changes = agentId => ({ kind: 'changes', agentId });
const merge = (agentId, into) => (into ? { kind: 'merge', agentId, into } : { kind: 'merge', agentId });
const discard = agentId => ({ kind: 'discard', agentId });
const task = t => ({ kind: 'task', task: t });
const unknown = t => ({ kind: 'unknown', text: t });
const yes = { kind: 'confirm', go: true };
const no = { kind: 'confirm', go: false };

function checkRows(rows) {
  const failures = [];
  for (const [text, ctxName, expected] of rows) {
    const got = parseCommand(text, ctxOf(ctxName));
    try { assert.deepEqual(got, expected); } catch {
      failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`);
    }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
}

// [what the person typed or said, context, expected intent]
const SOURCE_CONTROL = [
  // --- The spec's own words
  ['what did search cleanup change', 'none', changes('d4e5f6')],
  ['what changed', 'invoice', changes('1a2b3c')],
  ['show me the changes', 'invoice', changes('1a2b3c')],
  ["show search cleanup's changes", 'none', changes('d4e5f6')],
  ['diff it', 'invoice', changes('1a2b3c')],
  ['merge search cleanup', 'none', merge('d4e5f6')],
  ['merge it', 'invoice', merge('1a2b3c')],
  ['land it', 'invoice', merge('1a2b3c')],
  ['bring its changes in', 'invoice', merge('1a2b3c')],
  ['merge search cleanup into main', 'none', merge('d4e5f6', 'main')],
  ['merge it into my branch', 'invoice', merge('1a2b3c')],
  ["throw away search cleanup's changes", 'none', discard('d4e5f6')],
  ['discard it', 'invoice', discard('1a2b3c')],
  ['throw it away', 'invoice', discard('1a2b3c')],
  ['scrap it', 'invoice', discard('1a2b3c')],

  // --- Seeing what an agent changed: read-only, so a question may also find the agent by its task words
  ['what did invoice export change', 'none', changes('1a2b3c')],
  ['What did Invoice export change?', 'none', changes('1a2b3c')],
  ["what's changed", 'invoice', changes('1a2b3c')],
  ['what has changed', 'invoice', changes('1a2b3c')],
  ['what changed so far', 'invoice', changes('1a2b3c')],
  ['what changed?', 'invoice', changes('1a2b3c')],
  ['what did it change', 'invoice', changes('1a2b3c')],
  ['what has it changed', 'invoice', changes('1a2b3c')],
  ['what changes did invoice export make', 'none', changes('1a2b3c')],
  ['what are its changes', 'invoice', changes('1a2b3c')],
  ['what are the changes from invoice export', 'none', changes('1a2b3c')],
  ['what changed in invoice export', 'none', changes('1a2b3c')],
  ['what files did invoice export change', 'none', changes('1a2b3c')],
  ['which files changed', 'invoice', changes('1a2b3c')],
  ['show me what changed', 'invoice', changes('1a2b3c')],
  ['show me what invoice export changed', 'none', changes('1a2b3c')],
  ['tell me what changed', 'invoice', changes('1a2b3c')],
  ['show the changes', 'invoice', changes('1a2b3c')],
  ['show me its changes', 'invoice', changes('1a2b3c')],
  ["show me invoice export's diff", 'none', changes('1a2b3c')],
  ['let me see the changes', 'invoice', changes('1a2b3c')],
  ['can i see the changes', 'invoice', changes('1a2b3c')],
  ['can you show me the changes', 'invoice', changes('1a2b3c')],
  ['show me the diff', 'invoice', changes('1a2b3c')],
  ['open the diff', 'invoice', changes('1a2b3c')],
  ['diff', 'invoice', changes('1a2b3c')],
  ['diff invoice export', 'none', changes('1a2b3c')],
  ['what did the rounding bug one change', 'none', changes('a1b2c3')], // a question: its task words find it, as for status
  ['what did read cart code change', 'none', changes('a1b2c3')], // a helper's words: its agent's folder
  ['what changed', 'helper', changes('a1b2c3')], // a helper in the centre stands for its agent
  ['what changed', 'onboarding', changes('7a8b9c')], // still working: the engine says it may still change
  // Nothing focused: which agent is not clear, and the engine asks.
  ['what changed', 'none', changes(null)],
  ['show me the changes', 'none', changes(null)],
  ['diff it', 'none', changes(null)],

  // --- Merging: the words name the agent, or "it" means the one in the centre
  ['merge invoice export', 'none', merge('1a2b3c')],
  ['Merge Invoice export.', 'none', merge('1a2b3c')],
  ['please merge invoice export', 'none', merge('1a2b3c')],
  ['can you merge invoice export', 'none', merge('1a2b3c')],
  ['um merge invoice export please', 'none', merge('1a2b3c')],
  ['land invoice export', 'none', merge('1a2b3c')],
  ['land the invoice export', 'none', merge('1a2b3c')],
  ['merge the invoice export agent', 'none', merge('1a2b3c')],
  ["merge invoice export's changes", 'none', merge('1a2b3c')],
  ['merge the changes from invoice export', 'none', merge('1a2b3c')],
  ['merge 1a2b3c', 'none', merge('1a2b3c')],
  ['merge help pages', 'none', merge('4d5e6f')],
  ['merge onboarding', 'none', merge('7a8b9c')], // still working: the engine refuses, in plain words
  ['merge', 'invoice', merge('1a2b3c')],
  ['land', 'invoice', merge('1a2b3c')],
  ['merge this one', 'invoice', merge('1a2b3c')],
  ['merge its work', 'invoice', merge('1a2b3c')],
  ['merge the changes', 'invoice', merge('1a2b3c')],
  ['merge its branch', 'invoice', merge('1a2b3c')],
  ['merge it in', 'invoice', merge('1a2b3c')],
  ['merge it now', 'invoice', merge('1a2b3c')],
  ['merge it right away', 'invoice', merge('1a2b3c')],
  ['merge it please', 'invoice', merge('1a2b3c')],
  ['go ahead and merge it', 'invoice', merge('1a2b3c')],
  ["let's merge it", 'invoice', merge('1a2b3c')],
  ['okay merge it', 'invoice', merge('1a2b3c')],
  ['bring it in', 'invoice', merge('1a2b3c')],
  ['bring in its changes', 'invoice', merge('1a2b3c')],
  ['bring the changes in', 'invoice', merge('1a2b3c')],
  ['bring over the changes', 'invoice', merge('1a2b3c')],
  ["bring invoice export's changes in", 'none', merge('1a2b3c')],
  ["bring in invoice export's changes", 'none', merge('1a2b3c')],
  ['merge it', 'none', merge(null)], // nothing focused: the engine asks which one
  ['merge', 'none', merge(null)],
  ['merge it', 'helper', merge('a1b2c3')], // a helper works in its agent's folder
  ['merge a1b2c3-11111111', 'none', merge('a1b2c3')], // a helper's id stands for its agent

  // --- Throwing work away: the same rule
  ['discard invoice export', 'none', discard('1a2b3c')],
  ["discard invoice export's work", 'none', discard('1a2b3c')],
  ['throw away invoice export', 'none', discard('1a2b3c')],
  ['throw invoice export away', 'none', discard('1a2b3c')],
  ["throw out invoice export's changes", 'none', discard('1a2b3c')],
  ["uh throw away invoice export's changes", 'none', discard('1a2b3c')],
  ['scrap invoice export', 'none', discard('1a2b3c')],
  ['discard 1a2b3c', 'none', discard('1a2b3c')],
  ['trash it', 'invoice', discard('1a2b3c')],
  ['throw that away', 'invoice', discard('1a2b3c')],
  ['throw it out', 'invoice', discard('1a2b3c')],
  ['Throw it away!', 'invoice', discard('1a2b3c')],
  ['throw it away right away', 'invoice', discard('1a2b3c')],
  ['discard it now please', 'invoice', discard('1a2b3c')],
  ['discard the changes', 'invoice', discard('1a2b3c')],
  ['discard its changes', 'invoice', discard('1a2b3c')],
  ['throw away its work', 'invoice', discard('1a2b3c')],
  ['throw away the work', 'invoice', discard('1a2b3c')],
  ['throw away all of its changes', 'invoice', discard('1a2b3c')],
  ["throw away it's changes", 'invoice', discard('1a2b3c')], // "it's" typed for "its"
  ['discard it', 'onboarding', discard('7a8b9c')], // still working: the engine says it will be stopped first
  ['discard it', 'none', discard(null)],
  ['discard it', 'helper', discard('a1b2c3')],
];

test(`parseCommand reads changes, merge and throw-away (${SOURCE_CONTROL.length} phrasings)`, () => {
  checkRows(SOURCE_CONTROL);
});

test('the new words never take over work, answers or replies to a permission', () => {
  checkRows([
    // Work stays work: the words name no agent, so they keep their old meaning.
    ['merge the two config files', 'none', task('merge the two config files')],
    ['merge the two config files', 'invoice', task('merge the two config files')],
    ['merge the two config files', 'dogNone', task('merge the two config files')], // "Config merge" has that as its task
    ['merge the two config files', 'dogDone', task('merge the two config files')],
    ['merge branch main into feature', 'none', task('merge branch main into feature')],
    ['merge the onboarding flow into the wizard', 'none', task('merge the onboarding flow into the wizard')],
    ['merge main into search cleanup', 'none', task('merge main into search cleanup')], // the other way round
    ['merge main into it', 'invoice', task('merge main into it')],
    ['merge it with main', 'invoice', task('merge it with main')],
    ['merge it into the wizard', 'invoice', task('merge it into the wizard')],
    ['merge it into develop', 'invoice', task('merge it into develop')], // a branch it cannot check: see the "into" test
    ['merge everything', 'none', task('merge everything')],
    ['merge the done one', 'none', task('merge the done one')], // state words find, never name
    ['merge the flaky checkout test', 'none', task('merge the flaky checkout test')], // task words, not its name
    ['merge search', 'none', task('merge search')], // one word of a two-word name
    ['merge read cart code', 'none', task('merge read cart code')], // a helper's name is not its agent's
    ['merge my branch', 'invoice', task('merge my branch')],
    ['merge my changes', 'invoice', task('merge my changes')],
    ['merge invoice export and help pages', 'none', task('merge invoice export and help pages')], // one at a time
    ['merge them', 'invoice', unknown('merge them')],
    ['discard unused imports', 'none', unknown('discard unused imports')],
    ['discard unused imports', 'invoice', unknown('discard unused imports')],
    ['discard my changes', 'invoice', unknown('discard my changes')], // the person's own, never an agent's
    ['throw away my work', 'invoice', unknown('throw away my work')],
    ['throw away your changes', 'invoice', unknown('throw away your changes')],
    ['discard all changes', 'invoice', unknown('discard all changes')],
    ['discard changes', 'invoice', unknown('discard changes')],
    ['discard read cart code', 'none', unknown('discard read cart code')],
    ['discard', 'invoice', unknown('discard')], // throwing away needs an object
    ['throw away', 'invoice', unknown('throw away')],
    ['throw away the old logs', 'none', unknown('throw away the old logs')],
    ['throw an error when the token expires', 'none', task('throw an error when the token expires')], // "throw" throws away only with "away" or "out"
    ['scrap the old parser', 'none', unknown('scrap the old parser')],
    // "scrap that" is never mind ("scratch that"), even with an agent in the centre; "scrap it" asks to throw its work away.
    ['scrap that', 'invoice', unknown('scrap that')],
    ['trash this', 'invoice', unknown('trash this')],
    ['scrap that', 'none', unknown('scrap that')],
    ['scrap that now', 'invoice', unknown('scrap that now')],
    ['scrap that idea', 'invoice', unknown('scrap that idea')],
    ['land the plane', 'none', unknown('land the plane')],
    ['show the error on the login page', 'none', task('show the error on the login page')],
    ['show the error on the login page', 'invoice', task('show the error on the login page')],
    // With an agent whose task is about the login page this was a status before these words existed, and it still is.
    ['show the error on the login page', 'dogNone', { kind: 'status', agentId: 'ee0005' }],
    ['show the changes to the login page', 'none', task('show the changes to the login page')],
    ['review the changes', 'none', task('review the changes')],
    ['diff the two config files', 'none', task('diff the two config files')],
    ['diff the two config files', 'dogNone', task('diff the two config files')],
    ['what does it change', 'invoice', { kind: 'status', agentId: '1a2b3c' }], // a short question about "it": the agent in the centre
    ['what will it change', 'invoice', { kind: 'status', agentId: '1a2b3c' }],
    ['what is changing', 'invoice', unknown('what is changing')],
    ['what did you change', 'invoice', { kind: 'status' }],
    ['the changes', 'invoice', unknown('the changes')],
    // Starting an agent stays a start.
    ['bring in an agent to fix the login', 'none', start(['fix the login'])],
    ['bring in an agent to fix the login', 'dogNone', start(['fix the login'])], // "Login fix" is there
    ['bring in codex to write tests', 'none', start(['write tests', 'codex'])],
    ['bring invoice export in', 'none', task('bring invoice export in')], // "bring" needs its work or "it"
    // A question that waits takes "it": a pronoun is weak.
    ['merge it', 'question', answer('merge it')],
    ['land it', 'question', answer('land it')],
    ['merge', 'question', answer('merge')],
    ['bring its changes in', 'question', answer('bring its changes in')],
    ['discard it', 'question', answer('discard it')],
    ['throw it away', 'question', answer('throw it away')],
    ['what changed', 'question', answer('what changed')],
    ['show me the changes', 'question', answer('show me the changes')],
    ['diff it', 'question', answer('diff it')],
    ['what did it change', 'question', { kind: 'status', agentId: 'd4e5f6' }], // as before
    ['scrap it', 'question', answer('scrap it')],
    ['trash it', 'question', answer('trash it')],
    ['throw it away', 'stuck', answer('throw it away', '0a0b0c', 'ask-stuck')], // a hint for a stuck agent
    ['merge it', 'stuck', answer('merge it', '0a0b0c', 'ask-stuck')],
    ['merge it', 'dogQuestion', answer('merge it', '220009', 'ask-wq')],
    // ...but a name is strong.
    ['merge search cleanup', 'question', merge('d4e5f6')],
    ['merge invoice export', 'question', merge('1a2b3c')],
    ["throw away invoice export's changes", 'question', discard('1a2b3c')],
    ['what did invoice export change', 'question', changes('1a2b3c')],
    ["show invoice export's changes", 'question', changes('1a2b3c')],
    ['merge invoice export', 'stuck', merge('1a2b3c')],
    ['merge the work queue', 'dogQuestion', merge('220009')], // its own name, said while it asks
    // A permission keeps its replies exactly as they were.
    ['sure, land it', 'permission', { ...deny, text: 'sure, land it', conditional: true }],
    ['yes merge it', 'permission', { ...deny, text: 'yes merge it', conditional: true }],
    ['okay merge it', 'permission', { ...deny, text: 'okay merge it', conditional: true }],
    ['go ahead and merge it', 'permission', { ...deny, text: 'go ahead and merge it', conditional: true }],
    ['accept its changes', 'permission', { ...deny, text: 'accept its changes', conditional: true }],
    ['no, throw it away', 'permission', { ...deny, text: 'throw it away' }],
    ['accept it', 'permission', allow],
    ['merge it', 'permission', unknown('merge it')],
    ['land it', 'permission', unknown('land it')],
    ['discard it', 'permission', unknown('discard it')],
    ['throw it away', 'permission', unknown('throw it away')],
    ['what changed', 'permission', { kind: 'status', agentId: 'a1b2c3' }],
    ['what did it change', 'permission', { kind: 'status', agentId: 'a1b2c3' }],
    ['okay merge it', 'dogPermission', { kind: 'deny', agentId: '33000a', askId: 'ask-bp', text: 'okay merge it', conditional: true }],
    ['throw it away', 'dogPermission', unknown('throw it away')],
    // ...and a name still acts there.
    ['merge invoice export', 'permission', merge('1a2b3c')],
    ['what did invoice export change', 'permission', changes('1a2b3c')],
  ]);
});

test('merge and throw-away name the agent: dogfood names, same-named twins, earlier agents, helpers', () => {
  checkRows([
    // Agent names that are also command words.
    ['merge the merge command', 'dogNone', merge('aa0001')],
    ['merge merge command', 'dogNone', merge('aa0001')],
    ['merge the merge command into main', 'dogNone', merge('aa0001', 'main')],
    ['merge merge command into my branch', 'dogNone', merge('aa0001')],
    ['discard the merge command please', 'dogNone', discard('aa0001')],
    ['what did the merge command change', 'dogNone', changes('aa0001')],
    ['merge diff viewer', 'dogNone', merge('bb0002')],
    ['merge the diff viewer', 'dogNone', merge('bb0002')],
    ["throw away the diff viewer's changes", 'dogNone', discard('bb0002')],
    ['throw away the diff viewer', 'dogNone', discard('bb0002')],
    ['what did diff viewer change', 'dogNone', changes('bb0002')],
    ['diff the diff viewer', 'dogNone', changes('bb0002')],
    ['diff diff viewer', 'dogNone', changes('bb0002')],
    ["show the diff viewer's changes", 'dogNone', changes('bb0002')],
    ['merge git screen', 'dogNone', merge('cc0003')], // still working: the engine refuses
    ['merge the git screen', 'dogNone', merge('cc0003')],
    ['scrap the git screen', 'dogNone', discard('cc0003')],
    ['diff the git screen', 'dogNone', changes('cc0003')],
    ['show the git screen changes', 'dogNone', changes('cc0003')],
    // Its name, then its work, when the name has the work word in it.
    ["show the diff viewer's diff", 'dogNone', changes('bb0002')],
    ["show me the work queue's work", 'dogNone', changes('220009')],
    ["show the branch picker's branch", 'dogNone', changes('33000a')],
    ["merge the diff viewer's diff", 'dogNone', merge('bb0002')],
    ["throw away the work queue's work", 'dogQuestion', discard('220009')], // its own name while it asks: strong
    ['merge the config merge', 'dogNone', merge('dd0004')],
    ['merge config merge', 'dogNone', merge('dd0004')],
    ['merge the work queue', 'dogNone', merge('220009')],
    ['merge work queue', 'dogNone', merge('220009')],
    ["throw away the work queue's work", 'dogNone', discard('220009')],
    ['merge the branch picker', 'dogNone', merge('33000a')],
    ['merge login fix', 'dogNone', merge('ee0005')],
    // A name said alone is a name, not a command: its words keep their old meaning.
    ['merge command', 'dogNone', task('merge command')],
    ['merge config', 'dogNone', task('merge config')],
    ['diff viewer', 'dogNone', { kind: 'status', agentId: 'bb0002' }], // a name said alone: how that agent is doing
    ['git screen', 'dogNone', { kind: 'status', agentId: 'cc0003' }],
    ['show diff viewer', 'dogNone', { kind: 'status', agentId: 'bb0002' }],
    ['open the diff viewer', 'dogNone', { kind: 'status', agentId: 'bb0002' }],
    ['show the git screen', 'dogNone', { kind: 'status', agentId: 'cc0003' }],
    ['show me the merge command', 'dogNone', { kind: 'status', agentId: 'aa0001' }],
    // "its changes", "the diff" and "the branch" mean the agent in the centre, whatever names share those words.
    ['merge its branch', 'dogDone', merge('aa0001')],
    ['merge the branch', 'dogDone', merge('aa0001')],
    ['discard the work', 'dogDone', discard('aa0001')],
    ['show me the diff', 'dogDone', changes('aa0001')],
    ['show me the diff', 'dogNone', changes(null)],
    // Same-named twins (one from an earlier run): never a guess. The engine asks which one.
    ['merge search cleanup', 'dogNone', merge(null)],
    ['merge the search cleanup agent', 'dogNone', merge(null)],
    ["throw away search cleanup's changes", 'dogNone', discard(null)],
    ['throw away search cleanup', 'dogNone', discard(null)],
    ['what did search cleanup change', 'dogNone', changes(null)],
    ['merge search cleanup', 'dogQuestion', merge(null)], // a name, so strong even while a question waits
    // ...an id or "it" still names one of them.
    ['merge ff0006', 'dogNone', merge('ff0006')],
    ['discard ff0007', 'dogNone', discard('ff0007')],
    ['merge it', 'dogTwin', merge('ff0007')],
    // Agents from an earlier run are merged and thrown away like any other.
    ['merge invoice export', 'dogNone', merge('110008')],
    ['merge it', 'dogEarlier', merge('110008')],
    ['throw it away', 'dogEarlier', discard('110008')],
    ['what changed', 'dogEarlier', changes('110008')],
    // A helper stands for its agent: by its id, or as the one in the centre. Its name is not its agent's name.
    ['merge it', 'dogHelper', merge('cc0003')],
    ['discard it', 'dogHelper', discard('cc0003')],
    ['show me the changes', 'dogHelper', changes('cc0003')],
    ['merge cc0003-33333333', 'dogNone', merge('cc0003')],
    ['discard cc0003-33333333', 'dogNone', discard('cc0003')],
    ['what did cc0003-33333333 change', 'dogNone', changes('cc0003')],
    ['merge draw the graph', 'dogNone', task('merge draw the graph')],
    ['what did draw the graph change', 'dogNone', changes('cc0003')], // a question: its helper's words find it
    // Launches stay launches with a "Login fix" there.
    ['stop an agent to fix the login', 'dogNone', task('stop an agent to fix the login')],
    ['forget an agent to fix the login', 'dogNone', unknown('forget an agent to fix the login')],
  ]);
  // A name made only of words for work ("Changes") is named by its id or "it", never by "the changes".
  const withChanges = { agents: [...dogAgents, { id: '55000c', name: 'Changes', task: 'Track changes', state: 'done_claimed', kind: 'agent' }], focusId: 'aa0001' };
  assert.deepEqual(parseCommand('discard the changes', withChanges), discard('aa0001'));
  assert.deepEqual(parseCommand('bring in the changes', withChanges), merge('aa0001'));
  assert.deepEqual(parseCommand('merge the changes from it', withChanges), merge('aa0001'));
  assert.deepEqual(parseCommand('throw away your changes', withChanges), unknown('throw away your changes'));
  assert.deepEqual(parseCommand('merge 55000c', withChanges), merge('55000c'));
  // The whole name of one agent names it, even when a longer name has the same words; a shorter part names neither, so
  // the words keep their old meaning (a task here), rather than asking which one.
  const v2 = { agents: [{ id: 'aa0001', name: 'Search cleanup', task: 'x', state: 'done_checked', kind: 'agent' },
    { id: 'bb0002', name: 'Search cleanup v2', task: 'y', state: 'done_checked', kind: 'agent' }] };
  assert.deepEqual(parseCommand('merge search cleanup', v2), merge('aa0001'));
  assert.deepEqual(parseCommand('merge search cleanup v2', v2), merge('bb0002'));
  assert.deepEqual(parseCommand('merge search clean', v2), task('merge search clean'));
  // A helper whose agent is not in the list stands for nothing.
  assert.deepEqual(parseCommand('discard it', { agents: [{ id: 'q-1', name: 'Lost helper', kind: 'helper', parentId: 'gone' }], focusId: 'q-1' }), discard(null));
});

test('words that two names share, and that are neither one\'s whole name, name no agent: they keep their old meaning', () => {
  assert.deepEqual(configAgents.map(a => a.name), ['Update config files', 'Split config files per', 'Fix login page error']);
  const answerCf = text => answer(text, 'cf0003', 'ask-cf');
  checkRows([
    // Nothing waits: work stays work, words about throwing work away that name no agent stay nothing, and other words
    // that say something are work. Never “Which one do you mean?”.
    ['merge the config files', 'configNone', task('merge the config files')],
    ['merge config files', 'configNone', task('merge config files')],
    ['discard the config files', 'configNone', unknown('discard the config files')],
    ['trash the config files', 'configNone', unknown('trash the config files')],
    ['throw away the config files', 'configNone', unknown('throw away the config files')],
    ['diff the config files', 'configNone', task('diff the config files')],
    ['show me the config files changes', 'configNone', { kind: 'status', agentId: 'cf0001' }], // as before these words
    // A question waits: the words are its answer.
    ['merge the config files', 'configQuestion', answerCf('merge the config files')],
    ['discard the config files', 'configQuestion', answerCf('discard the config files')],
    ['trash the config files', 'configQuestion', answerCf('trash the config files')],
    ['diff the config files', 'configQuestion', answerCf('diff the config files')],
    ['show me the config files changes', 'configQuestion', answerCf('show me the config files changes')],
    // A question about what changed finds the agent by its words, as "what is the config files doing" always has (the
    // best match, here the first of two): it only shows, and it was never an answer.
    ['what did the config files change', 'configNone', changes('cf0001')],
    ['what did the config files change', 'configQuestion', changes('cf0001')],
    ['what is the config files doing', 'configQuestion', { kind: 'status', agentId: 'cf0001' }],
    // A whole name or an id still names one, and acts whatever waits.
    ['merge update config files', 'configNone', merge('cf0001')],
    ['merge the update config files agent', 'configQuestion', merge('cf0001')],
    ['discard split config files per', 'configQuestion', discard('cf0002')],
    ['merge cf0002', 'configQuestion', merge('cf0002')],
    ["show update config files' changes", 'configQuestion', changes('cf0001')],
    // Same-named twins still give no agent, so the engine asks which one.
    ['merge search cleanup', 'dogNone', merge(null)],
  ]);
});

test('part of a name finds the agent but is not strong: while it, or anything, asks, the words keep their old meaning', () => {
  assert.equal(importsAgent.name, 'Remove unused imports');
  const answerUi = text => answer(text, 'ab0001', 'ask-ui');
  checkRows([
    // Its own question waits: part of its name is the answer, never a card that throws its work away.
    ['discard the unused imports', 'importsQuestion', answerUi('discard the unused imports')],
    ['discard unused imports', 'importsQuestion', answerUi('discard unused imports')],
    ['throw away the unused imports', 'importsQuestion', answerUi('throw away the unused imports')],
    ['throw the unused imports away', 'importsQuestion', answerUi('throw the unused imports away')],
    ['scrap the unused imports', 'importsQuestion', answerUi('scrap the unused imports')],
    ['trash the unused imports', 'importsQuestion', answerUi('trash the unused imports')],
    ["throw away the unused imports' changes", 'importsQuestion', answerUi("throw away the unused imports' changes")],
    ['merge the unused imports', 'importsQuestion', answerUi('merge the unused imports')],
    ['land the unused imports', 'importsQuestion', answerUi('land the unused imports')],
    ['merge the unused imports into main', 'importsQuestion', answerUi('merge the unused imports into main')],
    ['diff the unused imports', 'importsQuestion', answerUi('diff the unused imports')],
    ["show the unused imports' changes", 'importsQuestion', answerUi("show the unused imports' changes")],
    ['discard them', 'importsQuestion', answerUi('discard them')],
    ['keep the unused imports', 'importsQuestion', answerUi('keep the unused imports')],
    // A question about what changed finds it by its words, as a status question does: it only shows.
    ['what did the unused imports change', 'importsQuestion', changes('ab0001')],
    // Its whole name or its id still acts at once.
    ['discard remove unused imports', 'importsQuestion', discard('ab0001')],
    ['throw away the remove unused imports agent', 'importsQuestion', discard('ab0001')],
    ['merge remove unused imports', 'importsQuestion', merge('ab0001')],
    ['discard ab0001', 'importsQuestion', discard('ab0001')],
    ['diff remove unused imports', 'importsQuestion', changes('ab0001')],
    // A stop keeps its own rule: two words of the name and nothing else name the agent (see ARCHITECTURE.md).
    ['stop the unused imports', 'importsQuestion', { kind: 'stop', agentIds: ['ab0001'] }],
    // Stuck, a helper asking, another agent asking: the answer too.
    ['discard the unused imports', 'importsStuck', answer('discard the unused imports', 'ab0001', 'ask-us')],
    ['merge the unused imports', 'importsStuck', answer('merge the unused imports', 'ab0001', 'ask-us')],
    ['discard the unused imports', 'importsHelper', answer('discard the unused imports', 'ab0001-44444444', 'ask-uh')],
    ['discard the unused imports', 'importsOther', answer('discard the unused imports', 'ab0002', 'ask-st')],
    ['merge the unused imports', 'importsOther', answer('merge the unused imports', 'ab0002', 'ask-st')],
    // A permission keeps its replies, as before these words existed.
    ['discard the unused imports', 'importsPermission', unknown('discard the unused imports')],
    ['throw away the unused imports', 'importsPermission', unknown('throw away the unused imports')],
    ['merge the unused imports', 'importsPermission', task('merge the unused imports')],
    ['no, discard the unused imports', 'importsPermission', { kind: 'deny', agentId: 'ab0001', askId: 'ask-up', text: 'discard the unused imports' }],
    ['merge remove unused imports', 'importsPermission', merge('ab0001')], // the whole name still acts there
    ['discard the unused imports', 'importsHelperPermission', unknown('discard the unused imports')],
    ['merge the unused imports', 'importsHelperPermission', task('merge the unused imports')],
    ['no, discard the unused imports', 'importsHelperPermission',
      { kind: 'deny', agentId: 'ab0001-55555555', askId: 'ask-hp', text: 'discard the unused imports' }],
    // Nothing waits: part of the name finds it, and the engine asks first, as before.
    ['discard the unused imports', 'importsNone', discard('ab0001')],
    ['throw away the unused imports', 'importsNone', discard('ab0001')],
    ['merge the unused imports', 'importsNone', merge('ab0001')],
    ['diff the unused imports', 'importsNone', changes('ab0001')],
    ["show the unused imports' changes", 'importsNone', changes('ab0001')],
    // A card is no question to answer and has no "it" for a name: part of a name is another command there, as a whole
    // name is (the engine withdraws the card), never a launch of "merge the unused imports".
    ['merge the unused imports', 'importsCard', merge('ab0001')],
    ['discard the unused imports', 'importsCard', discard('ab0001')],
    ["show the unused imports' changes", 'importsCard', changes('ab0001')],
  ]);
  // A name said as two words where it has one ("check out" for Checkout) is still the whole name: strong while a
  // question waits.
  assert.deepEqual(parseCommand('merge the check out fix', CTX.question), merge('a1b2c3'));
  assert.deepEqual(parseCommand('merge the checkout fix', CTX.question), merge('a1b2c3'));
  assert.deepEqual(parseCommand('merge the checkout', CTX.question), answer('merge the checkout'));
});

test('cards take their own words: "start it" only for a launch, "merge it" for a merge, "throw it away" for a throw-away', () => {
  checkRows([
    // A merge card.
    ['merge it', 'pendingMerge', yes], ['merge', 'pendingMerge', yes], ['land it', 'pendingMerge', yes], ['yes merge it', 'pendingMerge', yes],
    ['sure, land it', 'pendingMerge', yes], ['bring it in', 'pendingMerge', yes], ['merge its changes', 'pendingMerge', yes],
    ['merge it into my branch', 'pendingMerge', yes], ['do it', 'pendingMerge', yes], ['yes', 'pendingMerge', yes], ['okay', 'pendingMerge', yes],
    ['merge it into main', 'pendingMerge', unknown('merge it into main')], // the card says where it merges: say "do it" to that
    ['merge it is that right', 'pendingMerge', unknown('merge it is that right')],
    ['merge it?', 'pendingMerge', unknown('merge it?')],
    ['start it', 'pendingMerge', unknown('start it')], ['launch it', 'pendingMerge', unknown('launch it')],
    ['yes start it', 'pendingMerge', unknown('yes start it')],
    ['forget it', 'pendingMerge', no], ['cancel', 'pendingMerge', no], ['no', 'pendingMerge', no], ['not now', 'pendingMerge', no],
    ["don't merge it", 'pendingMerge', no], ['do not merge it', 'pendingMerge', no],
    ['discard it', 'pendingMerge', unknown('discard it')], // "it" is the card: the card stays, with its hint
    ['throw it away', 'pendingMerge', unknown('throw it away')],
    ['merge help pages', 'pendingMerge', merge('4d5e6f')], // a name is another command: the engine withdraws the card
    // A throw-away card: its own words or "do it". A bare yes keeps the card.
    ['throw it away', 'pendingDiscard', yes], ['discard it', 'pendingDiscard', yes], ['do it', 'pendingDiscard', yes],
    ['yes do it', 'pendingDiscard', yes], ['yes throw it away', 'pendingDiscard', yes], ['okay throw it away', 'pendingDiscard', yes],
    ['yes discard it', 'pendingDiscard', yes], ['just do it', 'pendingDiscard', yes], ['please do it', 'pendingDiscard', yes],
    ['discard', 'pendingDiscard', yes], ['throw away', 'pendingDiscard', yes],
    ['throw away its work', 'pendingDiscard', yes], ['discard that', 'pendingDiscard', yes], ['throw it out', 'pendingDiscard', yes],
    // "scrap it" and "trash it" ask for this card but do not answer it; "scrap that" is one sound from "scratch that".
    ['scrap it', 'pendingDiscard', unknown('scrap it')], ['trash it', 'pendingDiscard', unknown('trash it')],
    ['scrap that', 'pendingDiscard', unknown('scrap that')], ['trash that', 'pendingDiscard', unknown('trash that')],
    ['yes scrap it', 'pendingDiscard', unknown('yes scrap it')], ['scratch that', 'pendingDiscard', no],
    ['keep it', 'pendingDiscard', no], ['keep its work', 'pendingDiscard', no], ['cancel', 'pendingDiscard', no], ['no', 'pendingDiscard', no],
    ['forget it', 'pendingDiscard', no], ["don't throw it away", 'pendingDiscard', no], ['do not discard it', 'pendingDiscard', no],
    ['throw it away is that right', 'pendingDiscard', unknown('throw it away is that right')],
    ['discard it?', 'pendingDiscard', unknown('discard it?')],
    ['throw', 'pendingDiscard', unknown('throw')], ['throw it', 'pendingDiscard', unknown('throw it')], // cut short: no answer
    ['yes throw it', 'pendingDiscard', unknown('yes throw it')],
    ['start it', 'pendingDiscard', unknown('start it')], ['launch it', 'pendingDiscard', unknown('launch it')],
    ['merge it', 'pendingDiscard', unknown('merge it')],
    // A forget card: "forget it" is never mind there too, and "start it" is no yes.
    ['yes', 'pendingForget', yes], ['do it', 'pendingForget', yes], ['forget it', 'pendingForget', no], ['cancel', 'pendingForget', no],
    ['start it', 'pendingForget', unknown('start it')], ['launch it', 'pendingForget', unknown('launch it')],
    ['yes start it', 'pendingForget', unknown('yes start it')], ['start it is that right', 'pendingForget', unknown('start it is that right')],
    ['merge it', 'pendingForget', unknown('merge it')], ['discard it', 'pendingForget', unknown('discard it')],
    // A launch card: the merge and throw-away words are not its words.
    ['merge it', 'pendingStart', unknown('merge it')], ['throw it away', 'pendingStart', unknown('throw it away')],
    ['start it', 'pendingStart', yes], ['start it', 'pending', yes],
    // Launch words said to a stop or message card keep it too, rather than starting "it is that right".
    ['start it is that right', 'pendingStop', unknown('start it is that right')],
    ['start it is that right', 'pendingSay', unknown('start it is that right')],
    ["don't stop it", 'pendingStop', no], ["don't send it", 'pendingSay', no],
    // The dogfood world's cards.
    ['merge it', 'dogPendingMerge', yes], ['merge the merge command', 'dogPendingMerge', merge('aa0001')],
    ['throw it away', 'dogPendingDiscard', yes], ['yes', 'dogPendingDiscard', unknown('yes')],
    // A card that ran out: "it" is still the card, so the engine can say it is no longer waiting; a name is a new command.
    ['merge it', 'pendingGone', unknown('merge it')], ['throw it away', 'pendingGone', unknown('throw it away')],
    ['yes', 'pendingGone', yes], ['merge invoice export', 'pendingGone', merge('1a2b3c')],
    ["don't scrap it", 'pendingDiscard', unknown("don't scrap it")], // not its words: the card stays, with its hint
  ]);
});

test('a bare yes is not enough to throw work away, and it never falls through to a permission behind the card', () => {
  for (const text of ['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'alright', 'right', 'go ahead', 'go for it', 'yes please', 'sounds good',
    'make it so', 'confirm', 'that is right', 'perfect', 'fine', 'the right one', 'yes go for it', 'sure thing']) {
    assert.deepEqual(parseCommand(text, CTX.pendingDiscard), unknown(text), text);
    assert.deepEqual(parseCommand(text, CTX.pendingDiscardOnPermission), unknown(text), `${text} (permission behind the card)`);
    // On every other card the same words are a yes.
    for (const ctxName of ['pending', 'pendingStart', 'pendingForget', 'pendingMerge']) {
      assert.deepEqual(parseCommand(text, CTX[ctxName]), yes, `${text} [${ctxName}]`);
    }
  }
  assert.deepEqual(parseCommand('throw it away', CTX.pendingDiscardOnPermission), yes);
  assert.deepEqual(parseCommand('keep it', CTX.pendingDiscardOnPermission), no);
  assert.deepEqual(parseCommand('okay merge it', CTX.pendingMergeOnPermission), yes);
  assert.deepEqual(parseCommand('yes start it', CTX.pendingMergeOnPermission), unknown('yes start it'));
  // Asked rather than said, on any card: it settles nothing.
  for (const ctxName of ['pendingForget', 'pendingMerge', 'pendingDiscard']) {
    for (const text of ['is that right?', 'right?', 'is that okay', 'yes?', 'do it?', 'that right', 'you sure']) {
      assert.deepEqual(parseCommand(text, CTX[ctxName]), unknown(text), `${text} [${ctxName}]`);
    }
  }
});

test('on a throw-away card "do" counts only as "do it" or "do that": a "do" cut short is no answer', () => {
  // A "do" on its own is a yes word, and the first word of "do not throw it away": said alone, or cut short by
  // speech-to-text, it keeps the card, as a "throw" cut short does.
  for (const text of ['do', 'Do.', 'sure do', 'yes do', 'yes, do.', 'you do', 'okay do', 'go do', 'do please', 'do so', 'well do']) {
    assert.deepEqual(parseCommand(text, CTX.pendingDiscard), unknown(text), text);
    assert.deepEqual(parseCommand(text, CTX.pendingDiscardOnPermission), unknown(text), `${text} (permission behind the card)`);
    assert.deepEqual(parseCommand(text, DOG.dogPendingDiscard), unknown(text), `${text} [dogPendingDiscard]`);
    // On every other card it is a yes, as before.
    for (const ctxName of ['pending', 'pendingStart', 'pendingForget', 'pendingMerge']) {
      assert.deepEqual(parseCommand(text, CTX[ctxName]), yes, `${text} [${ctxName}]`);
    }
  }
  checkRows([
    ['do it', 'pendingDiscard', yes], ['Do it.', 'pendingDiscard', yes], ['do that', 'pendingDiscard', yes], ['DO IT', 'pendingDiscard', yes],
    ['yes do it', 'pendingDiscard', yes], ['yes, do it', 'pendingDiscard', yes], ['just do it', 'pendingDiscard', yes],
    ['please do it', 'pendingDiscard', yes], ['do it please', 'pendingDiscard', yes], ['do it now', 'pendingDiscard', yes],
    ['go ahead and do it', 'pendingDiscard', yes], ['okay do it', 'pendingDiscard', yes], ['do it', 'pendingDiscardOnPermission', yes],
    ['do not throw it away', 'pendingDiscard', no],
    ['do it?', 'pendingDiscard', unknown('do it?')], ['do it is that right', 'pendingDiscard', unknown('do it is that right')],
  ]);
  for (const text of ['do not', 'do not do it', "don't do it"]) assert.notDeepEqual(parseCommand(text, CTX.pendingDiscard), yes, text);
});

test('on a merge or throw-away card, review words show its work; they never withdraw it for a launch', () => {
  // "it" is the card: the words are about the work it would merge or throw away.
  const REVIEW = ['show me the changes', 'show me the diff', 'show me what changed', 'show me its changes', 'open the diff',
    'look at the changes', 'let me see the changes', 'can I see the diff', 'can you show me the changes', 'pull up the diff',
    'show me the changes please', 'what changed', 'what changed?', 'what did it change', 'what are its changes', 'which files changed',
    'diff it', 'diff',
    // Elsewhere these are work for an agent ("review the changes" is a task); on such a card they look at its work.
    'review the changes', 'check the diff', 'read the diff', 'check out its changes', 'go through the changes', 'look over the work',
    'let me review the changes', 'view the diff',
    // Words that say when or what for, after the review words.
    'show me the changes first', 'let me see the diff first', 'review the changes first', 'show me the diff again',
    'show me what changed first', 'what changed first', 'diff it first', 'show me the changes before I merge',
    'show me the changes before I merge it', 'can I see the changes before merging', 'show me the changes real quick',
    'show me the changes one more time', 'show me the changes again please', 'open the diff for a second', 'show me the changes so far'];
  for (const text of REVIEW) {
    for (const ctxName of ['pendingMergeOf', 'pendingDiscardOf', 'pendingMergeOfOnQuestion']) {
      assert.deepEqual(parseCommand(text, CTX[ctxName]), changes('1a2b3c'), `${text} [${ctxName}]`);
    }
    // A card that does not say whose work it is keeps them: it stays, with its hint. So does one with a permission behind it.
    for (const ctxName of ['pendingMerge', 'pendingDiscard', 'pendingMergeOnPermission', 'pendingDiscardOnPermission']) {
      assert.deepEqual(parseCommand(text, CTX[ctxName]), unknown(text), `${text} [${ctxName}]`);
    }
  }
  checkRows([
    // The card's own words still answer it.
    ['merge it', 'pendingMergeOf', yes], ['do it', 'pendingMergeOf', yes], ['cancel', 'pendingMergeOf', no],
    ['throw it away', 'pendingDiscardOf', yes], ['keep it', 'pendingDiscardOf', no], ['yes', 'pendingDiscardOf', unknown('yes')],
    ['discard it', 'pendingMergeOf', unknown('discard it')],
    // A name is another agent's work, whatever card waits.
    ["show me help pages' changes", 'pendingMergeOf', changes('4d5e6f')],
    ['what did help pages change', 'pendingDiscardOf', changes('4d5e6f')],
    ["show me help pages' changes first", 'pendingMergeOf', changes('4d5e6f')],
    ["review help pages' changes", 'pendingMergeOf', changes('4d5e6f')],
    ['show me the changes from help pages before I merge', 'pendingMergeOf', changes('4d5e6f')],
    // Review words about the work that are still not understood keep the card, with its hint: never a launch.
    ['show me the changes to the login page', 'pendingMergeOf', unknown('show me the changes to the login page')],
    ['show me the diff the way git does', 'pendingDiscardOf', unknown('show me the diff the way git does')],
    // Work that is not a review keeps its old meaning.
    ['show the error on the login page', 'pendingMergeOf', task('show the error on the login page')],
    ['review it', 'pendingMergeOf', unknown('review it')],
    ['check the tests first', 'pendingMergeOf', { kind: 'status', agentId: '0a0b0c' }], // as before: no word for the work
    // Without a card, review words keep their old meaning: "review the changes" is work, and a question takes the words.
    ['review the changes', 'invoice', task('review the changes')],
    ['show me the changes', 'question', answer('show me the changes')],
    ['what did it change', 'question', { kind: 'status', agentId: 'd4e5f6' }],
  ]);
  // Only a merge or throw-away card has work to show: on the other cards the words are what they were.
  for (const text of ['show me the changes', 'what changed', 'review the changes']) {
    for (const ctxName of ['pending', 'pendingStart', 'pendingStop', 'pendingSay', 'pendingForget', 'pendingGone']) {
      assert.notEqual(parseCommand(text, CTX[ctxName]).kind, 'changes', `${text} [${ctxName}]`);
    }
  }
});

test('"stop an agent to fix the login" is a launch, not a stop of "Login fix"; "forget an agent …" forgets nothing', () => {
  const world = { agents: [
    { id: 'aa1111', name: 'Login fix', task: 'Fix the login page error', state: 'working', kind: 'agent' },
    { id: 'c0dec0', name: 'Codex adapter', task: 'Fix the codex adapter', state: 'working', kind: 'agent' },
  ] };
  assert.deepEqual(parseCommand('stop an agent to fix the login', world), task('stop an agent to fix the login'));
  assert.equal(describeIntent(parseCommand('stop an agent to fix the login', world), world), 'Start an agent on “stop an agent to fix the login”?');
  assert.deepEqual(parseCommand('stop someone to fix the login', world), task('stop someone to fix the login'));
  assert.deepEqual(parseCommand('stop codex to fix the login', world), task('stop codex to fix the login'));
  assert.notEqual(parseCommand('forget an agent to fix the login', world).kind, 'forget');
  assert.notEqual(parseCommand('forget a new agent that fixes the login', world).kind, 'forget');
  // A name that starts with a harness word, or "the agent", still names one.
  assert.deepEqual(parseCommand('stop codex adapter', world), { kind: 'stop', agentIds: ['c0dec0'] });
  assert.deepEqual(parseCommand('stop the codex adapter', world), { kind: 'stop', agentIds: ['c0dec0'] });
  assert.deepEqual(parseCommand('forget codex adapter', world), { kind: 'forget', agentIds: ['c0dec0'] });
  assert.deepEqual(parseCommand('stop the login fix', world), { kind: 'stop', agentIds: ['aa1111'] });
  // While a question waits, the launch-shaped words are the answer, as any work is.
  const asking = { agents: world.agents.map(a => (a.id === 'aa1111' ? { ...a, state: 'question', ask: { id: 'q1', type: 'question', sentence: 'Which page?', options: [] } } : a)), focusId: 'aa1111' };
  assert.deepEqual(parseCommand('stop an agent to fix the login', asking), { kind: 'answer', agentId: 'aa1111', askId: 'q1', text: 'stop an agent to fix the login' });
});

test('"into main" and "into my branch": a branch named is carried, so the engine can refuse one it is not on', () => {
  checkRows([
    ['merge it into main', 'invoice', merge('1a2b3c', 'main')],
    ['merge it onto main', 'invoice', merge('1a2b3c', 'main')],
    ['merge it to the main branch', 'invoice', merge('1a2b3c', 'main')],
    ['land it on main', 'invoice', merge('1a2b3c', 'main')],
    ['merge invoice export into master', 'none', merge('1a2b3c', 'master')],
    ['merge invoice export into main please', 'none', merge('1a2b3c', 'main')],
    ['merge 1a2b3c into main', 'none', merge('1a2b3c', 'main')],
    ['merge into main', 'invoice', merge('1a2b3c', 'main')],
    ['bring its changes into main', 'invoice', merge('1a2b3c', 'main')],
    ['bring it into my branch', 'invoice', merge('1a2b3c')],
    ['merge it into my own branch', 'invoice', merge('1a2b3c')],
    ['merge it here', 'invoice', merge('1a2b3c')],
    // The person's current branch by name, when the engine gives it (ctx.repo.branch).
    ['merge it into feature/login-v2', 'dogBranch', merge('aa0001', 'feature/login-v2')],
    ['merge it into Feature/Login-V2', 'dogBranch', merge('aa0001', 'feature/login-v2')],
    ['merge invoice export into the feature/login-v2 branch', 'dogBranch', merge('110008', 'feature/login-v2')],
    ['merge it into main', 'dogBranch', merge('aa0001', 'main')], // not its branch: the engine refuses, never retargets
    ['merge it into develop', 'dogBranch', task('merge it into develop')], // a branch it cannot check keeps the old meaning
    ['merge it into feature/login-v2', 'dogDone', task('merge it into feature/login-v2')],
    // An agent whose name has "to" in it is not a target.
    ['merge add tests to parser', 'none', merge('9f9f9f')],
    ['merge add tests to parser into main', 'none', merge('9f9f9f', 'main')],
  ]);
  // A branch with a word for a name: on it, "into the wizard" names it after an agent's name or "it"; work stays work.
  const onWizard = { ...CTX.invoice, repo: { branch: 'wizard' } };
  assert.deepEqual(parseCommand('merge it into the wizard', onWizard), merge('1a2b3c', 'wizard'));
  assert.deepEqual(parseCommand('merge help pages into wizard', onWizard), merge('4d5e6f', 'wizard'));
  assert.deepEqual(parseCommand('merge the onboarding flow into the wizard', onWizard), task('merge the onboarding flow into the wizard'));
  assert.deepEqual(parseCommand('merge main into wizard', onWizard), task('merge main into wizard'));
  assert.deepEqual(parseCommand('merge it into the wizard', CTX.invoice), task('merge it into the wizard')); // not its branch
  // On a merge card a branch named is not a yes, even the one it merges into: "do it" is.
  assert.deepEqual(parseCommand('merge it into the wizard', { ...CTX.pendingMerge, repo: { branch: 'wizard' } }), unknown('merge it into the wizard'));
});

test('"merge it in to main" and "bring it over to main": the particle, then where it goes', () => {
  checkRows([
    ['merge it in to main', 'invoice', merge('1a2b3c', 'main')],
    ['merge it in to the main branch', 'invoice', merge('1a2b3c', 'main')],
    ['merge it over to main', 'invoice', merge('1a2b3c', 'main')],
    ['land it in to main', 'invoice', merge('1a2b3c', 'main')],
    ['merge it on to main', 'invoice', merge('1a2b3c', 'main')], // "onto", heard as two words
    ['land it on to master', 'invoice', merge('1a2b3c', 'master')],
    ['merge in to main', 'invoice', merge('1a2b3c', 'main')], // "into", heard as two words
    ['bring its changes in to main', 'invoice', merge('1a2b3c', 'main')],
    ['bring the changes over to master', 'invoice', merge('1a2b3c', 'master')],
    ['bring it over to main', 'invoice', merge('1a2b3c', 'main')],
    ['merge it in to my branch', 'invoice', merge('1a2b3c')],
    ['bring it in to my branch', 'invoice', merge('1a2b3c')],
    ['merge invoice export in to main', 'none', merge('1a2b3c', 'main')],
    ["bring invoice export's changes in to main", 'none', merge('1a2b3c', 'main')],
    ['merge it in to feature/login-v2', 'dogBranch', merge('aa0001', 'feature/login-v2')],
    // As without the particle: a branch it cannot check keeps the old meaning, and "bring" still needs its work or "it".
    ['merge it in to develop', 'invoice', task('merge it in to develop')],
    ['bring invoice export in to main', 'none', task('bring invoice export in to main')],
    ['bring in to main', 'invoice', task('bring in to main')],
    // "it" is weak: while a question waits, the words are the answer; on a merge card a branch named keeps the card.
    ['merge it in to main', 'question', answer('merge it in to main')],
    ['merge it in to main', 'pendingMerge', unknown('merge it in to main')],
    ['merge it in to my branch', 'pendingMerge', yes],
  ]);
  // A name that ends in "over" keeps its last word: the particle is dropped only when the words name nothing with it.
  const failOver = { agents: [{ id: 'f0f0f0', name: 'Fail over', task: 'Add a fail over for the database', state: 'done_checked', kind: 'agent' }] };
  assert.deepEqual(parseCommand('merge fail over to main', failOver), merge('f0f0f0', 'main'));
  assert.deepEqual(parseCommand('merge fail over in to main', failOver), merge('f0f0f0', 'main'));
});

test('describeIntent words changes, merge and throw-away', () => {
  assert.equal(describeIntent(changes('1a2b3c'), CTX.none), 'Show what Invoice export changed?');
  assert.equal(describeIntent(changes(null), CTX.none), 'Show what an agent changed? It is not clear which one.');
  assert.equal(describeIntent(merge('1a2b3c'), CTX.none), 'Merge Invoice export into your branch?');
  assert.equal(describeIntent(merge('1a2b3c', 'main'), CTX.none), 'Merge Invoice export into main?');
  assert.equal(describeIntent(merge(null), CTX.none), 'Merge an agent? It is not clear which one.');
  assert.equal(describeIntent(discard('1a2b3c'), CTX.none), 'Throw away Invoice export’s work?');
  assert.equal(describeIntent(discard(null), CTX.none), 'Throw away an agent’s work? It is not clear which one.');
  assert.equal(describeIntent(parseCommand('merge the merge command', DOG.dogNone), DOG.dogNone), 'Merge Merge command into your branch?');
  assert.equal(describeIntent(parseCommand("throw away the diff viewer's changes", DOG.dogNone), DOG.dogNone), 'Throw away Diff viewer’s work?');
  assert.equal(describeIntent(parseCommand('what did the git screen change', DOG.dogNone), DOG.dogNone), 'Show what Git screen changed?');
  assert.ok(describeIntent(merge('1a2b3c', 'x'.repeat(300)), CTX.none).length < 120);
});

test('the source-control words stay fast on long dictation and never throw', () => {
  const t0 = Date.now();
  for (const verb of ['merge ', 'land ', 'bring in ', 'discard ', 'throw away ', 'throw ', 'diff ', 'show me ', 'what did ', 'what changed in ']) {
    parseCommand(verb + 'word '.repeat(3000) + 'away', CTX.invoice);
  }
  parseCommand('merge ' + 'search cleanup and '.repeat(500), CTX.none);
  parseCommand('throw away ' + 'the changes from '.repeat(500) + 'it', CTX.invoice);
  parseCommand('merge it into ' + 'main '.repeat(2000), CTX.invoice);
  // On a merge or throw-away card review words may run on ("show me the changes first"): long runs stay fast too.
  for (const tail of ['first ', 'again ', 'before ', 'real quick ', 'word ']) parseCommand('show me the changes ' + tail.repeat(1500), CTX.pendingMergeOf);
  parseCommand('show me ' + 'word '.repeat(3000) + 'first', CTX.pendingDiscardOf);
  parseCommand('review ' + 'the changes from '.repeat(500) + 'it first', CTX.pendingMergeOf);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  for (const [text, ctx] of [['merge it', { focusId: 'zz' }], ['discard it', { agents: [{ id: 'h', parentId: 'h', kind: 'helper' }], focusId: 'h' }],
    ['merge it into main', { repo: 'x' }], ['merge it into x', { repo: { branch: 5 } }], ['yes', { pendingConfirm: { id: 'c', kind: 'toString' } }],
    ['start it', { pendingConfirm: { id: 'c', kind: '__proto__' } }], ['merge it', { pendingConfirm: { id: 'c', kind: 'merge' }, repo: { branch: null } }],
    ['what changed', { agents: [{ id: 'a', rootId: 'b', parentId: 'b', kind: 'helper' }, { id: 'b', rootId: 'a', parentId: 'a', kind: 'helper' }], focusId: 'a' }]]) {
    assert.equal(typeof parseCommand(text, ctx).kind, 'string', text);
  }
  // A focus the list does not have is passed on as it is (the engine says it cannot find it), as "stop it" does.
  assert.deepEqual(parseCommand('merge it', { focusId: 'zz' }), merge('zz'));
});

// ------------------------------------------------------------------ help, Agents & keys, a start with no work, "work on"

/** Check rows of [words, context name, expected intent], and report every miss at once. */
function rows(list) {
  const failures = [];
  for (const [text, ctxName, expected] of list) {
    const got = parseCommand(text, ctxOf(ctxName));
    try { assert.deepEqual(got, expected); } catch { failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`); }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
}

const help = { kind: 'help' };
const connect = { kind: 'connect' };
const noWork = { kind: 'start', tasks: [], task: null, harness: null };
/** A start with no work that names one agent: the engine asks what that agent should work on. */
const noWorkFor = (harness) => ({ ...noWork, harness });

test('help: the words, greetings, and the reply the engine gives them', () => {
  // Short, so it fits three lines under the DRAM at the narrowest board, and it says where agents are set up.
  assert.equal(HELP_REPLY, 'Say what to work on, like “fix the login bug”. Or ask “what needs me”, or “stop everything”. Agents & keys sets up agents.');
  const said = ['help', 'Help!', 'help me', 'help?', 'can you help', 'please help', 'I need help', 'hi', 'Hello', 'hey', 'hello there',
    'Hi again', 'hey workbench', 'um hi', 'good morning', 'what can you do', 'What can you do?', 'what can I say', 'how does this work',
    'How does this work?', 'so how does it work', 'what is this', 'commands'];
  rows(said.flatMap(text => [[text, 'none', help], [text, 'onboarding', help], [text, 'invoice', help]]));
  rows([
    // While a question or a stuck ask waits, the words are its answer.
    ['help', 'question', answer('help')],
    ['how does this work', 'question', answer('how does this work')],
    ['hi', 'stuck', answer('hi', '0a0b0c', 'ask-stuck')],
    // At a permission they are about the request: a question gets what exactly it asks for.
    ['what do i do', 'permission', { kind: 'status', agentId: 'a1b2c3' }],
    ['how does this work?', 'permission', { kind: 'status', agentId: 'a1b2c3' }],
    ['help', 'permission', unknown('help')],
    // On a card they settle nothing: the card stays, with its own hint.
    ['help', 'pendingStart', unknown('help')],
    ['hi', 'pendingMerge', unknown('hi')],
    ['what can you do', 'pendingDiscardOf', unknown('what can you do')],
    // Words that only begin like help, or greet and then ask, keep their meaning.
    ['help me fix the login bug', 'none', task('fix the login bug')],
    ['hey workbench what is happening', 'none', { kind: 'status' }],
    ['hi, what needs me', 'none', { kind: 'status', needsMe: true }],
    ['how is help pages doing', 'none', { kind: 'status', agentId: '4d5e6f' }],
    ['stop help pages', 'none', { kind: 'stop', agentIds: ['4d5e6f'] }],
  ]);
});

test('connect: the words open Agents & keys, and only these words whole', () => {
  const weak = ['connect', 'Connect.', 'set up', 'setup', 'sign in', 'sign-in', 'log in', 'login', 'agents', 'Agents?', 'keys', 'api key', 'API keys'];
  const strong = ['connect github', 'Connect GitHub', 'connect to github', 'connect my GitHub account', 'connect git hub', 'connect claude',
    'connect claude code', 'connect codex', 'connect a coding agent', 'connect my agents', 'connect my keys', 'connect an api key',
    'set up claude', 'set up claude code', 'setup codex', 'set up an agent', 'set up git', 'set up github', 'set up my keys', 'set up workbench',
    'sign in to github', 'sign in to Claude', 'sign into codex', 'log in with github', 'log into my github account', 'sign in to chatgpt',
    'add a key', 'add keys', 'add an API key', 'add my aws keys', 'add AWS access keys', 'add a github token', 'add a new key', 'add stripe secrets',
    'add google cloud credentials',
    'agents and keys', 'Agents & keys', 'agents & api keys', 'open agents and keys', 'show me agents & keys', 'go to the agents and keys panel',
    'please connect github', 'can you connect github', 'okay so connect github please', 'how do I connect github?', 'where do i add a key',
    'how can i sign in to claude'];
  rows([...weak, ...strong].flatMap(text => [[text, 'none', connect], [text, 'onboarding', connect], [text, 'permission', connect], [text, 'pendingStart', connect]]));
  rows([
    // Bare, they may be the answer to a question: then they are. Said with what to connect, they open Agents & keys.
    ...weak.map(text => [text, 'question', answer(text)]),
    ['connect github', 'question', connect],
    ['agents and keys', 'question', connect],
    ['add a key', 'stuck', connect],
    // Work that starts with the same verbs stays work, and a launch stays a launch.
    ['connect the form to the API', 'none', task('connect the form to the API')],
    ['connect the database', 'none', task('connect the database')],
    ['connect github to slack', 'none', task('connect github to slack')],
    ['set up the ci pipeline', 'none', task('set up the ci pipeline')],
    ['set up codex to fix the login', 'none', start(['fix the login', 'codex'])],
    ['add a key to the config', 'none', task('add a key to the config')],
    // Tokens, credentials and secrets are keys only with whose they are: alone they are work in a parser or an auth module.
    ['add a token', 'none', task('add a token')],
    ['add some secrets', 'none', task('add some secrets')],
    ['add credentials', 'none', task('add credentials')],
    ['add tokens to the lexer', 'none', task('add tokens to the lexer')],
    ['add an api key field to the settings page', 'none', task('add an api key field to the settings page')],
    ['log in page is broken', 'none', task('log in page is broken')],
    ['fix the sign in page', 'none', task('fix the sign in page')],
    ['start an agent to add keys to the vault', 'none', start(['add keys to the vault'])],
  ]);
});

test('a start with no work asks what the agent should work on; naming an agent wins over a question', () => {
  rows([
    ...['start an agent', 'Start an agent.', 'start a new agent', 'new agent', 'New agent!', 'a new agent', 'another agent', 'one more agent',
      'launch an agent', 'spin up an agent', 'please start an agent', 'create an agent',
      'get me an agent', 'start an agent on cloud 2', 'start an agent on it', 'start', 'start one']
      .map(text => [text, 'none', noWork]),
    ['a new codex agent', 'none', noWorkFor('codex')],
    ['start codex', 'none', noWorkFor('codex')],
    ['start claude', 'none', noWorkFor('claude')],
    ['add a codex agent', 'none', noWorkFor('codex')],
    // A start verb with an agent named is unmistakable; a bare "start", "start one", or a weaker verb may be the answer.
    ['start an agent', 'question', noWork],
    ['start codex', 'question', noWorkFor('codex')],
    ['new agent', 'question', noWork],
    ['start', 'question', answer('start')],
    ['start one', 'question', answer('start one')],
    ['use codex', 'question', answer('use codex')],
    ['ask claude', 'question', answer('ask claude')],
    ['get me an agent', 'question', answer('get me an agent')],
    ['have codex', 'stuck', answer('have codex', '0a0b0c', 'ask-stuck')],
    ['use codex', 'none', noWorkFor('codex')],
    // An agent that exists, or a name alone, is no new launch.
    ['start the agent', 'none', unknown('start the agent')],
    ['codex', 'none', unknown('codex')],
    ['agent', 'none', unknown('agent')],
    ['the new agent', 'none', unknown('the new agent')],
    // With work, it is the launch it always was; "start it" still answers a launch card.
    ['start an agent to fix the login', 'none', start(['fix the login'])],
    ['new agent: fix the login page', 'none', start(['fix the login page'])],
    ['start over', 'none', start(['over'])],
    ['start it', 'pendingStart', { kind: 'confirm', go: true }],
  ]);
  assert.equal(describeIntent(noWork, CTX.none), 'Start an agent?');
});

test('a start with no work keeps the one agent it names, so the engine asks what that agent should work on', () => {
  rows([
    ['start codex', 'none', noWorkFor('codex')],
    ['use codex', 'none', noWorkFor('codex')],
    ['start a codex agent', 'none', noWorkFor('codex')],
    ['new codex agent', 'none', noWorkFor('codex')],
    ['another claude agent', 'none', noWorkFor('claude')],
    ['start claude code', 'none', noWorkFor('claude')],
    ['start two codex agents', 'none', noWorkFor('codex')],
    ['spin up a codex agent on cloud 2', 'none', noWorkFor('codex')],
    // Named after the noun, as a launch with work names it.
    ['start an agent with codex', 'none', noWorkFor('codex')],
    ['start an agent using claude', 'none', noWorkFor('claude')],
    // Two agents and no work: there is no one agent to ask about.
    ['start claude and codex', 'none', noWork],
    ['start an agent', 'none', noWork],
    ['start an agent on cloud 2', 'none', noWork],
  ]);
});

test('"work on X" is work, like "fix X": its task is what comes after "work on"', () => {
  rows([
    ['work on the login bug', 'none', task('the login bug')],
    ['Work on the login bug.', 'none', task('the login bug')],
    ['please work on the docs', 'none', task('the docs')],
    ["let's work on the flaky test", 'none', task('the flaky test')],
    ['can you work on fixing the parser', 'none', task('fixing the parser')],
    // The same words after a start: one task text either way.
    ['start an agent working on the login bug', 'none', start(['the login bug'])],
    // An agent or a machine named makes it a launch.
    ['work on the login bug using codex', 'none', start(['the login bug', 'codex'])],
    ['work on the parser on cloud 2', 'none', start(['the parser', null, 'cloud-2'])],
    // Nothing to work on, or a question waiting: as for other work.
    ['work on it', 'none', unknown('work on it')],
    ['work on', 'none', unknown('work on')],
    ['work on the login bug', 'question', answer('work on the login bug')],
    ['work queue', 'dogNone', { kind: 'status', agentId: '220009' }], // its name alone: how it is doing
  ]);
});

test('no launch names Claude unless the words do: the engine gives the rest to the default agent', () => {
  rows([
    ['start an agent to fix the login', 'none', start(['fix the login', null])],
    ['fix the login redirect on cloud 2', 'none', start(['fix the login redirect', null, 'cloud-2'])],
    ['start two agents on the parser bug', 'none', start(['the parser bug', null], ['the parser bug', null])],
    ['start claude on the parser', 'none', start(['the parser', 'claude'])],
    ['start codex on the parser', 'none', start(['the parser', 'codex'])],
    ['fix the login redirect using claude code', 'none', start(['fix the login redirect', 'claude'])],
    ['start an agent on the parser and codex on the docs', 'none', start(['the parser'], ['the docs', 'codex'])],
  ]);
  for (const text of ['start an agent to fix the login', 'fix the login on cloud 2', 'spin up three agents to look into the memory leak']) {
    const intent = parseCommand(text, CTX.none);
    for (const t of intent.tasks || []) assert.equal(t.harness, null, text);
  }
});

// ------------------------------------------------------------------ free text is work

test('anything else that says something is work, as a prompt is to a coding agent; words that say nothing are not', () => {
  checkRows([
    // What people type to a coding agent: problems, wants, questions, labels, a link.
    ['the login page is broken', 'none', task('the login page is broken')],
    ['There is a bug in the checkout flow.', 'none', task('There is a bug in the checkout flow')],
    ['tests are failing in CI', 'none', task('tests are failing in CI')],
    ['the app crashes when I click save', 'none', task('the app crashes when I click save')],
    ['I want a dark mode toggle', 'none', task('I want a dark mode toggle')],
    ['I need a function that sorts users by age', 'none', task('I need a function that sorts users by age')],
    ['why does the build fail?', 'none', task('why does the build fail?')],
    ['how do I run the tests?', 'none', task('how do I run the tests?')],
    ['can you explain how the engine works?', 'none', task('explain how the engine works?')],
    ['Hello! Can you help me build a website?', 'none', task('build a website?')],
    ['what does this repo do?', 'none', task('what does this repo do?')], // one word of work, in a question
    ['go through the code and find bugs', 'none', task('go through the code and find bugs')],
    ['dark mode for the settings page', 'none', task('dark mode for the settings page')],
    ['new feature: export to pdf', 'none', task('new feature: export to pdf')],
    ['bug: login redirect loops', 'none', task('bug: login redirect loops')],
    ['todo app in react', 'none', task('todo app in react')],
    ['https://github.com/acme/shop/issues/12', 'none', task('https://github.com/acme/shop/issues/12')],
    ['the login page is broken', 'onboarding', task('the login page is broken')], // an agent in the centre, asking nothing
    ['um so the login page is like broken', 'none', task('the login page is like broken')], // spoken
    // Said to an agent by name: that agent.
    ['claude fix the readme', 'none', start(['fix the readme', 'claude'])],
    ['claude code fix the readme', 'none', start(['fix the readme', 'claude'])],
    ['codex: why is the build slow?', 'none', start(['why is the build slow?', 'codex'])],
    ['codex, the login page is broken', 'none', start(['the login page is broken', 'codex'])],
    ['Claude Code, please add tests', 'none', start(['add tests', 'claude'])],
    // Words that say nothing, or only about an agent, are not work.
    ['ok', 'none', unknown('ok')],
    ['thanks', 'none', unknown('thanks')],
    ['thank you so much', 'none', unknown('thank you so much')],
    ['sounds good', 'none', unknown('sounds good')],
    ['makes sense', 'none', unknown('makes sense')],
    ['never mind', 'none', unknown('never mind')],
    ['good job', 'none', unknown('good job')],
    ['go ahead', 'none', unknown('go ahead')],
    ['keep going', 'none', unknown('keep going')],
    ['is anyone there', 'none', unknown('is anyone there')],
    ['can you hear me', 'none', unknown('can you hear me')],
    ['readme', 'none', unknown('readme')], // one word is not enough
    ['ok but not on main', 'none', unknown('ok but not on main')],
    ['claude is stuck', 'none', unknown('claude is stuck')], // the agent's name is no work
    ['claude code is stuck', 'none', unknown('claude code is stuck')],
    ['claude, stop', 'none', { kind: 'stop', agentIds: [] }], // the words after the name are a command: which one is not clear
    ['what is changing', 'invoice', unknown('what is changing')], // a thin question, with an agent in the centre: about it
    ['scrap the old parser', 'none', unknown('scrap the old parser')], // throw-away words start nothing
    ['forget an agent to fix the login', 'dogNone', unknown('forget an agent to fix the login')],
    // An agent's name, or an agent at work's words, and nothing more: how it is doing.
    ['onboarding', 'none', { kind: 'status', agentId: '7a8b9c' }],
    ['search cleanup', 'none', task('search cleanup')], // a name that starts with a work verb stays work, as before
    ['diff viewer', 'dogNone', { kind: 'status', agentId: 'bb0002' }], // ended, but named
    // Something waits: the words are for it, as before.
    ['the login page is broken', 'pending', unknown('the login page is broken')], // a card keeps its hint
    ['the login page is broken', 'permission', unknown('the login page is broken')], // a permission waits
    ['the login page is broken', 'question', answer('the login page is broken')], // a question waits: the answer
  ]);
  // A word said twice is still one word (with no agent whose words it could be).
  assert.deepEqual(parseCommand('testing testing', { agents: [] }), unknown('testing testing'));
});

// ------------------------------------------------------------------ what a sweep of real prompts found

/** Agents named as the engine names them from free text, as a person's board has them after a few launches. */
const sweptAgents = [
  fromTask('Stop the checkout test from timing out', { id: 'e5f005', state: 'maybe_stuck' }),
  fromTask('Clean up the search route handlers', { id: 's3c003', state: 'done_checked' }),
  fromTask('tests are failing in CI', { id: 'b00002', state: 'working' }),
  fromTask('Fix the menu on mobile', { id: 'm00001', state: 'working' }),
  fromTask('Update the user profile page', { id: 'u6a006', state: 'done_claimed' }),
  fromTask('memory leak in the websocket handler', { id: 'b00007', state: 'working' }),
];
const SWEPT = {
  W: { agents: sweptAgents, machines, harnesses, focusId: null },
  Wdone: { agents: sweptAgents, machines, harnesses, focusId: 's3c003' },
  empty: { agents: [], machines, harnesses, focusId: null },
};
const sweptRows = rows => {
  const failures = [];
  for (const [text, ctxName, expected] of rows) {
    const got = parseCommand(text, SWEPT[ctxName] || ctxOf(ctxName));
    try { assert.deepEqual(got, expected); } catch { failures.push(`${JSON.stringify(text)} [${ctxName}]\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(got)}`); }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
};

test('reports, wants and questions are work, not a stop, a message or a status of an agent they only share a word with', () => {
  sweptRows([
    ['prod is down', 'empty', task('prod is down')],
    ["the server won't start", 'empty', task("the server won't start")],
    ['can we have tabs?', 'empty', task('can we have tabs?')],
    ['it would be nice to have tabs', 'none', task('it would be nice to have tabs')],
    ['What does this repo do?', 'invoice', task('What does this repo do?')], // an agent in the centre does not change that
    ['fix the constructor in the user class', 'empty', task('fix the constructor in the user class')], // no lookup through the prototype
    ['修复登录错误', 'empty', task('修复登录错误')], // a script written without spaces
    ['fix the 登录 bug', 'empty', task('fix the 登录 bug')],
    ['исправь ошибку входа на сайте', 'empty', task('исправь ошибку входа на сайте')],
    ['right panel is empty on mobile', 'empty', task('right panel is empty on mobile')], // the person's words, as typed
    ['the tests pass now', 'empty', task('the tests pass now')],
    ['login 🐛 is back', 'empty', task('login 🐛 is back')],
    ['yeah the tests are failing', 'empty', task('the tests are failing')],
    ['throw an error when the config is missing', 'none', task('throw an error when the config is missing')],
    ['stop the tests from failing', 'W', task('stop the tests from failing')], // never a stop of "Tests are failing"
    ['tell the user their session expired instead of a blank page', 'W', task('tell the user their session expired instead of a blank page')],
    ['warn the user when their password is weak', 'W', task('warn the user when their password is weak')],
    ['tell me why the build is slow', 'none', task('tell me why the build is slow')],
    ['tell me why the tests fail', 'none', task('tell me why the tests fail')],
    ['can you tell me why the build is slow?', 'none', task('can you tell me why the build is slow?')], // the person's words: "tell" is no work verb
    ['we should tell people when a merge fails', 'dogNone', task('tell people when a merge fails')],
    ['how are errors handled in the api?', 'W', task('how are errors handled in the api?')],
    ['is the login page broken?', 'none', task('is the login page broken?')],
    ['is the login page working?', 'none', task('is the login page working?')],
    ['where is the config loaded', 'empty', task('where is the config loaded')],
    ['where is the login handler', 'none', task('where is the login handler')],
    ['is the build broken?', 'empty', task('is the build broken?')],
    ['what is this function doing?', 'empty', task('what is this function doing?')],
    ['where are the tests?', 'Wdone', task('where are the tests?')],
    ['open the diff viewer in a split pane', 'dogNone', task('open the diff viewer in a split pane')],
    ['show a spinner while the invoice export runs', 'none', task('show a spinner while the invoice export runs')],
    ['add build status', 'none', task('add build status')],
    ['check this out https://github.com/acme/shop/issues/12', 'none', task('check this out https://github.com/acme/shop/issues/12')],
    ['never mind, fix the checkout bug', 'none', task('fix the checkout bug')],
    ['forget it just fix the checkout bug', 'none', task('fix the checkout bug')], // never a forget of Checkout fix
    ['scrap that and fix the login bug', 'none', task('fix the login bug')],
    // An agent named, first or last, takes the work, as with a work verb.
    ['codex why is the build slow', 'empty', start(['why is the build slow', 'codex'])],
    ['the login page is broken using codex', 'empty', start(['the login page is broken', 'codex'])],
    ['the login page is broken, codex', 'empty', start(['the login page is broken', 'codex'])],
    ['codex add csv export', 'none', start(['add csv export', 'codex'])],
    // While a question waits, words that open with an agent's program are its answer ("claude keep the old route")
    ['codex add csv export', 'question', answer('codex add csv export')],
    ['claude keep the old route', 'question', answer('claude keep the old route')],
    ['new agent for this', 'none', { kind: 'start', tasks: [], task: null, harness: null }], // still asks what to work on
  ]);
});

test('commands keep their meaning after a reaction, said twice, or said to an agent by name; never-minds and asides start nothing', () => {
  const stop = (...agentIds) => ({ kind: 'stop', agentIds });
  sweptRows([
    ['wait, stop everything', 'question', { kind: 'stop_all' }], // an emergency stop wins over a waiting question
    ['stop all my agents', 'none', { kind: 'stop_all' }],
    ['stop the agents', 'question', { kind: 'stop_all' }],
    ['stop working', 'onboarding', stop('7a8b9c')],
    ['stop stop stop', 'question', stop('d4e5f6')],
    ['yeah stop it', 'stuck', answer('Stop it', '0a0b0c', 'ask-stuck')], // its own "Stop it", which the engine acts on
    ['claude, stop', 'stuck', stop('0a0b0c')],
    ['cool, stop the flaky test', 'none', stop('0a0b0c')],
    ['looks good, merge it', 'Wdone', merge('s3c003')],
    ['stop them', 'W', stop()], // which ones is not clear: never one picked by its spelling ("the menu")
    ['stop checkout test?', 'W', { kind: 'status', agentId: 'e5f005' }], // a question about the agent of that name
    ['forget it', 'question', answer('forget it')], // never mind, said to the question
    ['is it done yet?', 'onboarding', { kind: 'status', agentId: '7a8b9c' }],
    ["what's waiting for me?", 'onboarding', { kind: 'status', needsMe: true }],
    ['which agents are done?', 'onboarding', { kind: 'status' }],
    ['what do you mean?', 'empty', unknown('what do you mean?')],
    ["what's next?", 'empty', unknown("what's next?")],
    ['let me think', 'empty', unknown('let me think')],
    ['why is nothing happening', 'empty', unknown('why is nothing happening')],
    ['thanks, that fixed it', 'invoice', unknown('thanks, that fixed it')],
    ['great job on the login fix', 'empty', unknown('great job on the login fix')],
  ]);
  // At a permission: a question that starts with "don't" asks; a "don't" keeps its words, so the agent hears the no
  assert.deepEqual(parseCommand("don't we already have a linter?", CTX.permission), { kind: 'status', agentId: 'a1b2c3' });
  assert.deepEqual(parseCommand("don't use the production database", CTX.permission),
    { kind: 'deny', agentId: 'a1b2c3', askId: 'ask-perm', text: "don't use the production database" });
});

test('a task that is a question gets no second question mark on its card', () => {
  assert.equal(describeIntent(task('why does the build fail?'), CTX.none), 'Start an agent on “why does the build fail?”');
  assert.equal(describeIntent(start(['why is the build slow?', 'codex']), CTX.none), 'Start Codex on “why is the build slow?”');
  assert.equal(describeIntent(task('the login page is broken'), CTX.none), 'Start an agent on “the login page is broken”?');
});

// ------------------------------------------------------------------ what a second sweep found

const pair = [
  { id: '0a0b0c', name: 'Flaky test', task: 'Fix the flaky checkout test', state: 'working', kind: 'agent', harness: 'claude' },
  { id: '7a8b9c', name: 'Onboarding', task: 'Improve the onboarding flow', state: 'working', kind: 'agent', harness: 'claude' },
];
const stopAsker = { id: 'd4e5f6', name: 'Search cleanup', task: 'Clean up the search route handlers', state: 'question', kind: 'agent', harness: 'claude',
  ask: { id: 'ask-q', type: 'question', sentence: 'The old dev server is still running on port 3000. Should I stop it?', options: [] } };
const voiceAgents = [
  fromTask('fix the login bug', { id: 'v00001', state: 'working' }),
  fromTask('make the save button close the dialog', { id: 'v00002', state: 'question', ask: { id: 'ask-v', type: 'question', sentence: 'Should the save button also close the dialog?', options: [] } }),
];
Object.assign(SWEPT, {
  pair: { agents: pair, machines, harnesses, focusId: null },
  pairFocus: { agents: pair, machines, harnesses, focusId: '7a8b9c' },
  stopQ: { agents: [stopAsker], machines, harnesses, focusId: 'd4e5f6' },
  optionsQ: { agents: [{ ...stopAsker, ask: { id: 'ask-o', type: 'question', sentence: '要继续吗？', options: ['是', '否'] } }], machines, harnesses, focusId: 'd4e5f6' },
  voice: { agents: voiceAgents, machines, harnesses, focusId: null },
  voiceQ: { agents: voiceAgents, machines, harnesses, focusId: 'v00002' },
});

test('never-minds take back, praise praises, and an answer is never turned around', () => {
  sweptRows([
    ['never mind, I fixed it', 'none', unknown('never mind, I fixed it')], // a reason, not a request
    ['never mind, it works now', 'none', unknown('never mind, it works now')],
    ['never mind the login bug', 'none', unknown('never mind the login bug')],
    ['never mind the warnings, just fix the errors', 'none', task('fix the errors')],
    ['ignore my last message', 'none', unknown('ignore my last message')],
    ['cancel that deploy job', 'none', task('cancel that deploy job')], // "that" belongs to the job
    ['cancel that onboarding agent', 'none', { kind: 'stop', agentIds: ['7a8b9c'] }],
    ['forget that invoice export', 'none', { kind: 'forget', agentIds: ['1a2b3c'] }],
    ['nice work on the parser', 'none', unknown('nice work on the parser')],
    ['good work on the docs', 'none', unknown('good work on the docs')],
    ['great work on the login fix', 'Wdone', unknown('great work on the login fix')],
    ['yes, add tests too', 'pending', unknown('yes, add tests too')], // the card stays: no other launch in its place
    ['yes, stop it', 'stopQ', answer('yes, stop it')], // the answer to "Should I stop it?", not a stop of the one asking
    ['否', 'optionsQ', answer('否', 'd4e5f6', 'ask-o')], // never the first option because both lose their letters
    ['好的', 'empty', unknown('好的')], ['谢谢', 'empty', unknown('谢谢')], ['muchas gracias', 'empty', unknown('muchas gracias')],
    ['that fixed it', 'empty', unknown('that fixed it')], ['this is annoying', 'empty', unknown('this is annoying')],
    ["it's stuck", 'onboarding', { kind: 'status', agentId: '7a8b9c' }],
    ['why did that fail?', 'onboarding', { kind: 'status', agentId: '7a8b9c' }],
    ['please fix it', 'onboarding', unknown('please fix it')],
    ['testing one two three', 'empty', unknown('testing one two three')],
  ]);
});

test('stops said in a hurry stop; a name before a command gives the command; a name before a remark is no launch', () => {
  const stop = (...agentIds) => ({ kind: 'stop', agentIds });
  sweptRows([
    ['hold on, stop everything', 'none', { kind: 'stop_all' }],
    ['stop, stop everything', 'onboarding', { kind: 'stop_all' }],
    ['stop everything stop everything', 'none', { kind: 'stop_all' }],
    ['stop all claude agents', 'none', { kind: 'stop_all' }],
    ['shut it down', 'onboarding', stop('7a8b9c')],
    ['kill kill kill', 'onboarding', stop('7a8b9c')],
    ['claude make it stop', 'onboarding', stop('7a8b9c')],
    ['no, stop it', 'onboarding', stop('7a8b9c')],
    ['hang on, stop the onboarding', 'onboarding', stop('7a8b9c')],
    ["stop, it's deleting the wrong files", 'pairFocus', stop('7a8b9c')], // after the comma comes why
    ['can you stop the flaky test?', 'pair', stop('0a0b0c')],
    ['stop the onboarding agent from running', 'none', stop('7a8b9c')],
    ['we need to pause onboarding', 'none', { kind: 'stop', agentIds: ['7a8b9c'], sure: false }], // a want is asked first
    ['claude stop', 'stuck', stop('0a0b0c')],
    ['claude, stop the flaky test', 'none', stop('0a0b0c')],
    ['claude: what needs me?', 'none', { kind: 'status', needsMe: true }],
    ['Flaky test: stop', 'none', stop('0a0b0c')],
    ['Onboarding: use the new copy on step 2', 'none', { kind: 'say', agentId: '7a8b9c', text: 'use the new copy on step 2', sure: false }],
    ['tell onboarding the copy is final', 'none', { kind: 'say', agentId: '7a8b9c', text: 'the copy is final', sure: false }],
    ['claude is stuck', 'none', unknown('claude is stuck')], ["codex isn't installed", 'empty', unknown("codex isn't installed")],
    ['claude and codex fix the login bug', 'empty', start(['fix the login bug', 'claude'], ['fix the login bug', 'codex'])],
    ['codex is there a memory leak in the worker', 'empty', start(['is there a memory leak in the worker', 'codex'])],
    ['codex，修复登录错误', 'empty', start(['修复登录错误', 'codex'])],
    ['use codex instead', 'none', { kind: 'start', tasks: [], task: null, harness: 'codex' }],
    ['nah, throw it away', 'invoice', { kind: 'discard', agentId: '1a2b3c' }],
    ['good job! merge it into main', 'invoice', merge('1a2b3c', 'main')],
    ['approve and merge', 'Wdone', merge('s3c003')],
    ['good morning! what needs me?', 'none', { kind: 'status', needsMe: true }],
    ['claude keep the old route', 'question', answer('claude keep the old route')],
    ['scrap that and fix the login bug', 'voiceQ', answer('scrap that and fix the login bug', 'v00002', 'ask-v')],
  ]);
});

test('questions about an agent said loosely find it; questions about code and the person\'s words stay work', () => {
  sweptRows([
    ['is the parser agent running?', 'none', { kind: 'status', agentId: '9f9f9f' }],
    ['check on the login one', 'voice', { kind: 'status', agentId: 'v00001' }],
    ['whats the login one doing', 'voiceQ', { kind: 'status', agentId: 'v00001' }], // about another agent: not the answer
    ["how's the export?", 'none', { kind: 'status', agentId: '1a2b3c' }],
    ['tell me what checkout fix is doing', 'none', { kind: 'status', agentId: 'a1b2c3' }],
    ['why did invoice export fail?', 'none', { kind: 'status', agentId: '1a2b3c' }],
    ['is the login bug fixed yet', 'voice', { kind: 'status', agentId: 'v00001' }],
    ['how are my agents?', 'none', { kind: 'status' }],
    ['is claude still running?', 'onboarding', { kind: 'status' }],
    ['wat needs me', 'none', { kind: 'status', needsMe: true }],
    ['what do I type here', 'empty', { kind: 'help' }],
    ['does the signup form need my email?', 'empty', task('does the signup form need my email?')],
    ['how is shipping cost calculated?', 'empty', task('how is shipping cost calculated?')],
    ['open the login page in a modal', 'dogNone', task('open the login page in a modal')],
    ['add an agents page to the dashboard', 'none', task('add an agents page to the dashboard')],
    ['error in claude code extension', 'empty', task('error in claude code extension')],
    ['the tests pass locally but fail in CI', 'empty', task('the tests pass locally but fail in CI')],
    ['No error is shown when the upload fails', 'empty', task('No error is shown when the upload fails')],
    ['no emails are being sent', 'empty', task('no emails are being sent')],
    ['check if the deploy is ok', 'empty', task('check if the deploy is ok')],
    ['use === instead of == in the validator', 'empty', task('use === instead of == in the validator')],
    ['Hey there! Could you please fix the readme?', 'empty', task('fix the readme?')],
    ['love it! can we also get tabs?', 'empty', task('can we also get tabs?')],
    ['thanks! also the footer is broken', 'empty', task('also the footer is broken')],
    ['site down', 'empty', task('site down')],
  ]);
  // At a permission, words that only start like a yes are no reply; a "don't," with a reason is a no that carries it
  assert.deepEqual(parseCommand('allow users to export their data as CSV', CTX.permission), unknown('allow users to export their data as CSV'));
  assert.deepEqual(parseCommand('go to the login page and it shows a 500', CTX.permission), unknown('go to the login page and it shows a 500'));
  assert.deepEqual(parseCommand("don't, it deletes the database", CTX.permission),
    { kind: 'deny', agentId: 'a1b2c3', askId: 'ask-perm', text: "don't, it deletes the database" });
  assert.deepEqual(parseCommand('claude, allow it', CTX.permission), { kind: 'allow', agentId: 'a1b2c3', askId: 'ask-perm' });
});
