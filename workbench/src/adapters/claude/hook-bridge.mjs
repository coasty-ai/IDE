#!/usr/bin/env node
// Claude Code PreToolUse hook bridge (see "Permission flow" in ARCHITECTURE.md).
// Claude Code runs this before every tool call of a workbench agent. It sends the hook payload to the engine,
// waits as long as the person takes, and prints the engine's decision for Claude Code.
//
// Fail closed: on any error it writes one line to stderr and exits 2, which makes Claude Code block the call.
// (Exit 1 would fall back to Claude Code's own permission check instead.)
//
// It uses node:http rather than fetch on purpose: Node's fetch gives up after 300 s without response headers
// (UND_ERR_HEADERS_TIMEOUT), and the engine may hold a request for 25 minutes.
import http from 'node:http';
import https from 'node:https';

const EXIT_BLOCK = 2;
/** Longest wait for the engine: past its 25 minute hold and Claude Code's 30 minute hook timeout. */
const WAIT_MS = 31 * 60 * 1000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
/** The engine refuses request bodies over 64 KB. */
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 1024 * 1024;
/** File-editing tools whose bulky text fields may be shortened to fit; the policy decides on their paths. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const BULKY_FIELDS = ['content', 'new_string', 'old_string', 'new_source'];
const KEEP_CHARS = 2000;

let finished = false; // a decision (pass or block) has been made
let blocked = false;

const oneLine = (s) => String(s || 'an unexpected error').replace(/\s+/g, ' ').trim().slice(0, 300).replace(/[.\s]+$/, '');

/**
 * Block the tool call: one line on stderr, exit 2. This wins even after pass() has started, because an
 * error then means Claude Code may not have received the decision.
 */
function block(reason) {
  if (blocked) return;
  blocked = true;
  finished = true;
  process.exitCode = EXIT_BLOCK;
  const line = `Workbench blocked this step because it could not check it with the person: ${oneLine(reason)}.\n`;
  try { process.stderr.write(line, () => process.exit(EXIT_BLOCK)); } catch { process.exit(EXIT_BLOCK); }
  setTimeout(() => process.exit(EXIT_BLOCK), 2000).unref();
}

/** Succeed, printing `text` (may be empty). Exits 0 only once the text is handed over. */
function pass(text) {
  if (finished) return;
  finished = true;
  process.exitCode = 0;
  if (!text) { process.exit(0); return; }
  process.stdout.write(text, (err) => {
    if (err) block(`the decision could not be handed to Claude Code (${err.message})`);
    else if (!blocked) process.exit(0);
  });
}

process.stdout.on('error', (err) => block(`the decision could not be handed to Claude Code (${err.message})`));
process.on('uncaughtException', (err) => block(err && err.message));
process.on('unhandledRejection', (err) => block(err && err.message));

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_INPUT_BYTES) { process.stdin.destroy(); reject(new Error('the hook input is too large')); return; }
      chunks.push(c);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (err) => reject(new Error(`could not read the hook input (${err.message})`)));
  });
}

function shorten(obj) {
  let changed = false;
  const copy = { ...obj };
  for (const k of BULKY_FIELDS) {
    if (typeof copy[k] === 'string' && copy[k].length > KEEP_CHARS) {
      copy[k] = copy[k].slice(0, KEEP_CHARS) + '…';
      changed = true;
    }
  }
  return { copy, changed };
}

/**
 * The request body. Large file contents are shortened so the request fits the engine's 64 KB limit.
 * Paths and commands are never shortened: the decision depends on them.
 */
function requestBody(agentId, payload) {
  const body = JSON.stringify({ agentId, payload });
  if (Buffer.byteLength(body) <= MAX_BODY_BYTES) return body;
  const input = payload.tool_input;
  if (!EDIT_TOOLS.has(payload.tool_name) || !input || typeof input !== 'object') return body;
  const top = shorten(input);
  let changed = top.changed;
  if (Array.isArray(top.copy.edits)) {
    top.copy.edits = top.copy.edits.map((e) => {
      if (!e || typeof e !== 'object') return e;
      const r = shorten(e);
      changed = changed || r.changed;
      return r.copy;
    });
  }
  if (!changed) return body;
  return JSON.stringify({ agentId, payload: { ...payload, tool_input: top.copy, workbench_shortened: true } });
}

function networkProblem(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code === 'ECONNREFUSED') return 'the workbench is not running or cannot be reached';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'the connection to the workbench was lost';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the workbench address could not be found';
  return (err && err.message) || 'the request to the workbench failed';
}

function post(address, token, body) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(address); } catch { reject(new Error('the workbench address is not valid')); return; }
    const lib = url.protocol === 'http:' ? http : url.protocol === 'https:' ? https : null;
    if (!lib) { reject(new Error('the workbench address is not an http address')); return; }
    const req = lib.request(url, {
      method: 'POST',
      agent: false, // one request, then close: nothing keeps the process alive afterwards
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Workbench-Token': token,
        Connection: 'close',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('the workbench answer was too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => { if (!res.complete) reject(new Error('the connection to the workbench closed before it answered')); });
      res.on('error', (err) => reject(new Error(networkProblem(err))));
    });
    // The person may take many minutes to answer: no shorter timeout than this.
    req.setTimeout(WAIT_MS, () => req.destroy(new Error('the workbench did not answer in time')));
    req.on('error', (err) => reject(new Error(networkProblem(err))));
    req.end(body);
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { block('the hook input was not valid JSON'); return; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { block('the hook input was not a JSON object'); return; }

  // Only PreToolUse is handled. Anything else passes silently.
  if (payload.hook_event_name !== 'PreToolUse') { pass(''); return; }

  const address = process.env.WORKBENCH_HOOK_URL;
  const token = process.env.WORKBENCH_HOOK_TOKEN;
  const agentId = process.env.WORKBENCH_AGENT_ID;
  if (!address || !token || !agentId) { block('the workbench connection details are missing'); return; }

  const body = requestBody(agentId, payload);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) { block('the request is too large to check'); return; }

  const res = await post(address, token, body);
  if (res.status !== 200) { block(`the workbench answered with status ${res.status}`); return; }
  let answer;
  try { answer = JSON.parse(res.body); } catch { block('the workbench answer was not valid JSON'); return; }
  const out = answer && typeof answer === 'object' ? answer.hookSpecificOutput : null;
  if (!out || typeof out !== 'object') { block('the workbench answer had no decision'); return; }
  if (out.hookEventName != null && out.hookEventName !== 'PreToolUse') { block('the workbench answer was for a different hook'); return; }
  const decision = out.permissionDecision;
  if (decision !== 'allow' && decision !== 'deny') { block('the workbench answer had no clear decision'); return; }

  // Print only the decision, so nothing else in the answer can change how Claude Code behaves.
  const result = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision } };
  if (typeof out.permissionDecisionReason === 'string') result.hookSpecificOutput.permissionDecisionReason = out.permissionDecisionReason;
  pass(JSON.stringify(result) + '\n');
}

main().catch((err) => block(err && err.message));
