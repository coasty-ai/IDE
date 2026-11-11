import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../src/adapters/claude/hook-bridge.mjs', import.meta.url));
const ROOT_BASH = readFileSync(new URL('./fixtures/hook-pretool-root-bash.json', import.meta.url), 'utf8');
const SUBAGENT = readFileSync(new URL('./fixtures/hook-pretool-subagent.json', import.meta.url), 'utf8');
const TOKEN = 'tok-' + 'a'.repeat(60);

/** Run the bridge the way Claude Code does: payload on stdin, details in the environment. */
function runBridge(input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, WORKBENCH_HOOK_TOKEN: TOKEN, WORKBENCH_AGENT_ID: 'abc123', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** A stand-in for the engine's /hook/pretool route. */
function startEngine(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body, bytes: Buffer.byteLength(body) };
      requests.push(r);
      handler(r, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/hook/pretool`;
      resolve({ url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
    });
  });
}

const answer = (decision, reason, extra = {}) => JSON.stringify({
  ...extra,
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
});

const reply = (status, body) => (req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); };

function assertBlocked(r, pattern) {
  assert.equal(r.code, 2, 'exit 2 blocks the tool call');
  assert.equal(r.stdout, '');
  const lines = r.stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'a one-line reason');
  assert.match(lines[0], /^Workbench blocked this step because it could not check it with the person: /);
  if (pattern) assert.match(lines[0], pattern);
}

test('an allow answer is printed for Claude Code', async () => {
  const engine = await startEngine(reply(200, answer('allow', 'Running the tests is fine')));
  try {
    const r = await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: engine.url });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Running the tests is fine' },
    });
    assert.equal(engine.requests.length, 1);
    const req = engine.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/hook/pretool');
    assert.equal(req.headers['x-workbench-token'], TOKEN);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.origin, undefined, 'no Origin header');
    assert.match(req.headers.host, /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(JSON.parse(req.body), { agentId: 'abc123', payload: JSON.parse(ROOT_BASH) });
  } finally { await engine.close(); }
});

test('a deny answer is printed with its reason', async () => {
  const engine = await startEngine(reply(200, answer('deny', 'The person said no')));
  try {
    const r = await runBridge(SUBAGENT, { WORKBENCH_HOOK_URL: engine.url });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'The person said no' });
    const sent = JSON.parse(engine.requests[0].body);
    assert.equal(sent.payload.agent_id, 'a71ea18c16a7bba8d', 'the sub-agent id reaches the engine');
  } finally { await engine.close(); }
});

test('only the decision is printed, whatever else the answer holds', async () => {
  const engine = await startEngine(reply(200, answer('allow', undefined, { continue: false, systemMessage: 'x', suppressOutput: true })));
  try {
    const r = await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: engine.url });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  } finally { await engine.close(); }
});

test('the bridge waits while the engine holds the request', async () => {
  const engine = await startEngine((req, res) => setTimeout(() => reply(200, answer('allow', 'The person allowed it'))(req, res), 1500));
  try {
    const t0 = Date.now();
    const r = await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: engine.url });
    assert.ok(Date.now() - t0 >= 1400);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'allow');
  } finally { await engine.close(); }
});

test('a decision that cannot be handed to Claude Code still blocks the call', async () => {
  let child;
  const engine = await startEngine((req, res) => {
    child.stdout.destroy(); // nobody reads the answer any more
    setTimeout(() => reply(200, answer('allow', 'Fine'))(req, res), 100);
  });
  try {
    const r = await new Promise((resolve) => {
      child = spawn(process.execPath, [BRIDGE], {
        env: { ...process.env, WORKBENCH_HOOK_URL: engine.url, WORKBENCH_HOOK_TOKEN: TOKEN, WORKBENCH_AGENT_ID: 'abc123' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (code) => resolve({ code, stderr }));
      child.stdin.end(ROOT_BASH);
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /could not be handed to Claude Code/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
  } finally { await engine.close(); }
});

test('an unreachable engine blocks the call with exit 2', async () => {
  const engine = await startEngine(reply(200, '{}'));
  const url = engine.url;
  await engine.close(); // nothing listens there any more
  const r = await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: url });
  assertBlocked(r, /not running or cannot be reached/);
});

test('a refused, garbled or undecided answer blocks the call', async () => {
  const cases = [
    [reply(403, '{"error":"bad token"}'), /status 403/],
    [reply(200, 'not json'), /not valid JSON/],
    [reply(200, '{"ok":true}'), /no decision/],
    [reply(200, answer('ask', 'Ask the person')), /no clear decision/],
    [reply(200, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', permissionDecision: 'allow' } })), /different hook/],
    [(req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.write('{"hookSpecific'); setTimeout(() => res.destroy(), 50); }, /closed before it answered|connection to the workbench was lost/],
  ];
  for (const [handler, pattern] of cases) {
    const engine = await startEngine(handler);
    try {
      assertBlocked(await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: engine.url }), pattern);
    } finally { await engine.close(); }
  }
});

test('events other than PreToolUse pass silently without asking the engine', async () => {
  const engine = await startEngine(reply(200, answer('deny', 'no')));
  try {
    for (const name of ['PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      const r = await runBridge(JSON.stringify({ session_id: 's', hook_event_name: name }), { WORKBENCH_HOOK_URL: engine.url });
      assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
    }
    assert.equal(engine.requests.length, 0);
  } finally { await engine.close(); }
});

test('bad input or missing details block the call', async () => {
  assertBlocked(await runBridge('{not json', { WORKBENCH_HOOK_URL: 'http://127.0.0.1:9/' }), /not valid JSON/);
  assertBlocked(await runBridge('[1,2]', { WORKBENCH_HOOK_URL: 'http://127.0.0.1:9/' }), /not a JSON object/);
  assertBlocked(await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: '' }), /connection details are missing/);
  assertBlocked(await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: 'http://127.0.0.1:9/', WORKBENCH_HOOK_TOKEN: '' }), /connection details are missing/);
  assertBlocked(await runBridge(ROOT_BASH, { WORKBENCH_HOOK_URL: 'ftp://127.0.0.1:9/' }), /not an http address/);
});

test('a large file write is shortened to fit; a huge command is refused, never shortened', async () => {
  const engine = await startEngine(reply(200, answer('allow', 'Inside the folder')));
  try {
    const write = JSON.stringify({
      session_id: 's', cwd: '/workspace/repo', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1',
      tool_input: { file_path: '/workspace/repo/big.txt', content: 'z'.repeat(300_000) },
    });
    const r = await runBridge(write, { WORKBENCH_HOOK_URL: engine.url });
    assert.equal(r.code, 0);
    const req = engine.requests[0];
    assert.ok(req.bytes <= 64 * 1024, `body of ${req.bytes} bytes fits the engine's limit`);
    const sent = JSON.parse(req.body).payload;
    assert.equal(sent.tool_input.file_path, '/workspace/repo/big.txt', 'the path is kept whole');
    assert.ok(sent.tool_input.content.length < 3000);
    assert.equal(sent.workbench_shortened, true);

    const bash = JSON.stringify({
      session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't2',
      tool_input: { command: 'echo ' + 'a'.repeat(100_000) },
    });
    assertBlocked(await runBridge(bash, { WORKBENCH_HOOK_URL: engine.url }), /too large to check/);
    assert.equal(engine.requests.length, 1, 'the huge command was never sent');
  } finally { await engine.close(); }
});
