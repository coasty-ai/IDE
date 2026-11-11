# Workbench prototype: architecture and module contract

This is the contract the prototype's modules are built against. Code must match it. Where code and this document disagree, fix one of them; do not leave both.

## What it is

One local program, the **engine**, that launches coding agents, watches them, and shows a person what each one is doing, in plain language.

- `node bin/workbench.mjs --demo` runs with **simulated** agents and machines. Nothing is spent.
- `node bin/workbench.mjs --repo <git repo>` runs **real** agents: Claude Code, and Codex if installed. Each agent works in its own git worktree of that repo. Only "Your laptop" appears as a machine; cloud machines exist only in demo mode.

The browser UI is served by the engine on `127.0.0.1` and talks to it over HTTP plus Server-Sent Events.

## Rules for all code

- Node 22 or later, ES modules (`.mjs`), **no third-party packages**: only `node:` built-ins.
- Files in `src/shared/` must not import `node:` modules; the browser loads them as-is.
- Tests use `node:test` and `node:assert/strict`, live in `test/<module>.test.mjs`, run with `npm test`, need no network, and never start a real `claude` or `codex`. Use the fixtures in `test/fixtures/` and the fake-binary overrides below.
- Every child process is spawned with an argument array (`execFile`/`spawn`, never a shell string), except declared checks, which are shell commands the repo owner wrote in `workbench.json`.
- Plain language in anything a person sees: sentences, not identifiers. Use `src/shared/narrate.mjs`.

## Files and owners

| Area | Files |
|---|---|
| Shared (done) | `src/shared/states.mjs`, `src/shared/events.mjs`, `src/shared/narrate.mjs`, `src/shared/format.mjs` |
| Store, engine, server, CLI | `src/core/store.mjs`, `src/core/stuck.mjs`, `src/core/engine.mjs`, `src/server/http.mjs`, `bin/workbench.mjs`, `package.json` |
| Claude Code adapter | `src/adapters/claude/args.mjs`, `src/adapters/claude/parse.mjs`, `src/adapters/claude/runner.mjs`, `src/adapters/claude/hook-bridge.mjs` |
| Codex adapter | `src/adapters/codex/parse.mjs`, `src/adapters/codex/runner.mjs` |
| Language, policy, workspaces, receipt | `src/core/commands.mjs`, `src/core/policy.mjs`, `src/core/workspace.mjs`, `src/core/receipt.mjs` |
| Simulator and machines | `src/adapters/sim/simulator.mjs`, `src/core/machines.mjs` |
| UI | `ui/index.html`, `ui/app.css`, `ui/app.js`, `ui/*.js`, `ui/fonts/` |

Each module's tests are owned with it. A builder edits only its own files.

## Events (adapters to store)

Adapters and the engine emit **normalized events**, defined in `src/shared/events.mjs` (`EV`). Every event is `{ kind, ts, agentId?, ...fields }`. `ts` is milliseconds since the epoch.

The store reduces events into **AgentViews** (`newAgentView` in `events.mjs` lists every field) and **Machines**.

Reducer rules (in `store.mjs`):

| Event | Effect on the AgentView |
|---|---|
| `agent.created` | New view. If `parentId` is set: `depth = parent.depth + 1`, `rootId = parent.rootId`, `kind = 'helper'`. Recompute the parent's `helpers`. Ignore a duplicate `agentId`. |
| `agent.state` | Set `state`, `stateReason`, `stateSince`. Entering a state in `ENDED` sets `endedAt`. Leaving `needs_ok`, `question` or `maybe_stuck` clears `ask` unless an `agent.ask` follows in the same batch. Recompute the parent's `helpers`. If a root enters `waiting_helpers`, set `now` to "Waiting for N helpers". |
| `agent.activity` | `phase: 'start'`: `now = sentence`, `toolCalls += 1`, `toolKinds[toolKind] += 1`, add 1 to the current spark bucket, `thinking = false`. `phase: 'end'`: push `{ ts, sentence, ok }` onto `recent` (keep the last 8). Either phase: `lastEventAt = ts`; `starting` becomes `working`. |
| `agent.thinking` | `thinking = on`. If `on` and no tool is in progress, `now = 'Thinking'`. |
| `agent.usage` | `mode: 'set'` replaces token totals; `'add'` adds. `costUsd` is replaced when the field is present (it may be `null`: not reported). `contextTokens` and `contextWindow` set `contextPct = contextTokens / contextWindow`. |
| `agent.turn` | `phase: 'start'`: `turns += 1`; a root in `question`, `done_*`, `checks_failed` or `waiting_helpers` returns to `working`. `phase: 'end'`: no state change (the engine decides). |
| `agent.plan` | `plan = { items, done: <completed count>, total: items.length }`. |
| `agent.says` | `says = text` (plain prose, the engine strips markdown). |
| `agent.ask` | `ask = { ...ask, createdAt: ts }`. The state is set by a separate `agent.state`. |
| `agent.askCleared` | `ask = null` if `ask.id === askId`. |
| `agent.files` / `agent.checks` / `agent.rules` / `agent.model` / `agent.session` | Set the field. |
| `agent.approval` | `approvals.auto`, `.byYou` or `.denied` += 1 (`denied` for any `decision: 'deny'`). |
| `agent.ended` | `endedAt = ts`; `error` from the event. |
| `machine.update` | Insert or replace the machine by `id`. |
| `notice` | Pass through to the UI as a notice. |

Every second the engine calls `store.tick(now)`. That rolls spark buckets (`SPARK_BUCKET_MS`, `SPARK_BUCKETS`) so `sparkEndsAt` stays current. Only views whose spark changed are reported as changed.

**Ids.** Root agents: 6 lowercase hex characters from `crypto.randomBytes`. Helpers: `<rootId>-<first 8 chars of the harness task id>`. Ids never contain `/` or `:`.

**Sorting.** `store.list()` returns roots ordered by `PRIORITY[state]` and then newest first, each root followed by its descendants in creation order.

## Agent lifecycle (engine)

The engine creates every root agent. It emits `agent.created`, then `agent.state starting`, then starts the adapter's runner. Runners create helpers themselves.

When a **root's** turn ends (`agent.turn` with `phase: 'end'`), the engine decides the state, in this order:

1. If `backgroundTasks > 0`: `waiting_helpers`. Claude Code sub-agents run in the background: the root's turn ends while helpers work, and their results start a new turn automatically.
2. If `isError`: `failed`, with `stateReason` from the result. Examples: budget reached, model error.
3. If `extractQuestion(finalText)` returns a question: emit `agent.ask { type: 'question', sentence, options: [] }`, then `agent.state question`.
4. Otherwise build the **receipt**: files changed (`diffStats`), rules (`checkRules`) and declared checks (`runChecks`, with `agent.checks state: 'running'` while they run). Then:
   - all checks passed: `done_checked`;
   - a check failed: `checks_failed`;
   - no checks declared: `done_claimed`;
   - and `agent.says firstSentence(finalText)`.

The engine gives a **helper** its final state when its runner reports the helper's task completed: `finished`, `failed` or `stopped`.

**Stuck** (`stuck.mjs`, called from the engine's tick). An active agent is possibly stuck when any of these holds:

- the same tool sentence and input started 3 times in a row with no successful step in between;
- the same error text came back 3 times;
- it is `working` with no event for 4 minutes and no helpers working.

The engine then emits `agent.ask { type: 'stuck', sentence: '<name> has hit the same error three times.', options: ['Stop it', 'Let it keep trying'] }` and `agent.state maybe_stuck`. The state clears when the person answers, or when a different step succeeds.

## Permission flow (Claude Code)

Every Claude Code agent runs with a `PreToolUse` hook that calls `src/adapters/claude/hook-bridge.mjs`:

1. The bridge reads the hook payload from stdin. It POSTs `{ agentId, payload }` to `WORKBENCH_HOOK_URL` with header `X-Workbench-Token: $WORKBENCH_HOOK_TOKEN`, then waits as long as it takes.
2. The engine calls `policy.decide(...)`:
   - **allow**: answer at once and emit `agent.approval how:'auto'`.
   - **deny**: answer at once.
   - **ask**: emit `agent.ask { type: 'permission', sentence: '<Name> <sentence>', detail, options: ['Allow', 'Deny'], primary: 'Allow' }` and `agent.state needs_ok` on the agent that asked. That is the helper if `payload.agent_id` is set, otherwise the root. Then hold the HTTP response until the person answers, or until 25 minutes pass, which counts as a deny with the reason "No answer from the person in time".
3. The engine responds with `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny', permissionDecisionReason } }`. The bridge prints it to stdout and exits 0.
4. **Fail closed.** On any bridge error (unreachable engine, non-200, bad JSON), the bridge writes a one-line reason to stderr and **exits 2**, which blocks the tool. This was verified against Claude Code 2.1.221: exit 2 blocks the call; exit 1 falls back to Claude Code's own permission check, which in headless mode refuses anything that needs approval.

The hook is registered with `"timeout": 1800` (seconds). Holding a request for more than 60 seconds was verified to work.

## Claude Code adapter

Facts below were observed in real runs of Claude Code 2.1.221. Fixtures: `test/fixtures/claude-*.jsonl` (one stdout JSON object per line) and `test/fixtures/hook-pretool-*.json`.

**Launch** (`args.mjs` builds this; `runner.mjs` spawns it in the agent's workspace):

```
claude -p --input-format stream-json --output-format stream-json --verbose --forward-subagent-text
       --setting-sources project,local --strict-mcp-config
       --disallowedTools "Workflow CronCreate CronDelete ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger"
       --settings '<JSON with the PreToolUse hook>'
       --append-system-prompt '<WORKBENCH_PROMPT>'
       --max-budget-usd <budget> --session-id <uuid> --name <name> [--model <model>]
```

- `--setting-sources project,local` and `--strict-mcp-config` keep the person's own plugins, hooks and MCP servers out of launched agents. Without them, the plugins on this machine injected instructions, an extra Stop hook and Slack tools into every agent.
- **Environment.** Copy `process.env`, delete every key matching `/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK)/`, then add `WORKBENCH_HOOK_URL`, `WORKBENCH_HOOK_TOKEN` and `WORKBENCH_AGENT_ID`.
- **`WORKBENCH_PROMPT`:** "You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did."
- **First message.** Written to stdin as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<task>"}]}}` plus a newline. Further messages (answers, hints) use the same shape. The process stays alive between turns while stdin is open. Closing stdin ends it.
- **Binary.** `WORKBENCH_CLAUDE_BIN` overrides the binary. Tests point it at a script that replays a fixture.

**Parsing** (`parse.mjs`; pure; `createClaudeParser({ rootId, now })` returns `{ push(obj) -> Event[] }`):

- **`system/init`.** Comes once per turn. Emit `agent.model` with `obj.model` and `agent.session` with `session_id` for the root, then `agent.turn phase:'start'`.
- **Root assistant messages** (`parent_tool_use_id` null). For each content block:
  - `thinking`: `agent.thinking on`.
  - `text`: remember it as the latest root text.
  - `tool_use`: `agent.activity start` with `narrate(name, input)`. Remember `id` mapped to `{ agentId, sentence, toolKind }`.
  - `Agent` or `Task` tool_use: remember it as a pending helper, keyed by tool_use `id`.
  - `TaskCreate { subject }`: add a plan item `{ id, text: subject, status: 'pending' }`. The id comes from the tool result `"Task #N created"` or the item's position.
  - `TaskUpdate { taskId, status, subject? }`: update that item.
  - `TodoWrite { todos: [{ content, status }] }`: replace the plan.
  - Emit `agent.plan` after any change.
- **Usage dedupe.** One assistant message is split across several stream objects that repeat the same `message.usage`. Count usage once per `message.id`. For the root, `contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the latest message.
- **Tool results** (`type: 'user'`, `tool_result` blocks). `agent.activity end` for the remembered `tool_use_id`, with `ok = !is_error`. The Agent tool's result is metadata ("Async agent launched"), not an end of work.
- **`system/task_started { task_id, tool_use_id, description, subagent_type }`.** `agent.created` for a helper: `agentId = <rootId>-<task_id[:8]>`, `parentId` = the agent that issued `tool_use_id`, `name = nameFromTask(description)`, `helperType = subagent_type`, `harness: 'claude'`. Then `agent.state working`. Keep the map `task_id` and `tool_use_id` to helper id.
- **Messages with `parent_tool_use_id = X`** belong to the helper whose `tool_use_id` is X. Their tool_use, tool_result, thinking and usage become that helper's events. Usage uses `mode: 'add'`, deduped by `message.id`.
- **`system/task_progress { task_id, description, usage: { total_tokens, tool_uses, duration_ms }, last_tool_name }`.** The `description` is already plain ("Reading greet.js"). Emit `agent.activity start` on the helper with that sentence. Do not double count a tool start already emitted from the forwarded message: compare against the helper's last sentence.
- **Helper ends.** On `system/task_updated` with `patch.status` in `completed | failed | killed | stopped`, or on `system/task_notification { status, summary }`, emit `agent.says firstSentence(summary)` (when there is a summary), then `agent.state finished | failed | stopped` and `agent.ended` for the helper. Ignore duplicates.
- **`system/background_tasks_changed { tasks }`.** Track the root's running background task count.
- **`system/thinking_tokens`.** Emit `agent.thinking on` only when it was off. A later tool_use or text turns it off.
- **`result { total_cost_usd, modelUsage, num_turns, is_error, result, permission_denials, subtype }`.**
  - `total_cost_usd` is **cumulative for the session**: set it, never sum it.
  - Token totals are the sums over `modelUsage[*]` of `inputTokens`, `outputTokens`, `cacheReadInputTokens` and `cacheCreationInputTokens` (also cumulative): `agent.usage mode:'set'`.
  - `contextWindow` comes from `modelUsage[*].contextWindow`.
  - Then `agent.turn phase:'end'` with `finalText: result`, `backgroundTasks: <count>`, `isError: is_error || subtype !== 'success'`.
- Unknown message types are ignored.

**Runner** (`runner.mjs`; `createClaudeRunner(opts)` returns a Runner, see below):

- Split stdout on newlines, buffering partial lines. Keep the last 4 KB of stderr.
- On exit with code 0: `agent.ended outcome:'ok'`, unless the engine already ended it. On non-zero exit: emit `agent.ended outcome:'error'` with the stderr tail, then `agent.state failed`.
- `stop()` sends SIGTERM to the process group (spawn `detached: true`; kill `-pid`), then SIGKILL after 3 seconds.
- `send(text)` writes to stdin if the process is alive. Otherwise it relaunches with `--resume <sessionId>` (same flags, no `--session-id`) and writes the message.

## Codex adapter

Facts observed with `codex-cli 0.166.0`. Fixtures: `test/fixtures/codex-run.jsonl`, `test/fixtures/codex-resume.jsonl`.

- **Launch:** `codex exec --json -C <workspace> --sandbox workspace-write [-m <model>] <task>`, with stdin ignored. Otherwise Codex waits for stdin.
- **Follow-up:** `codex exec resume --json <threadId> <text>`. Read `codex exec resume --help` for the options it accepts. It worked without `--ephemeral`.
- **Events:**

  | Codex event | Normalized |
  |---|---|
  | `thread.started { thread_id }` | `agent.session` |
  | `turn.started` | `agent.turn start` |
  | `item.started` / `item.completed` with `item.type` `command_execution { command, exit_code }` | `activity start` / `end`, with `ok = exit_code === 0` |
  | `agent_message { text }` | remember as final text; `agent.says` |
  | `reasoning` | `thinking on` |
  | `file_change { changes }` | activity, kind edit |
  | `todo_list { items }` | `agent.plan` |
  | `web_search`, `mcp_tool_call` | activity |
  | `turn.completed { usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }` | `agent.usage mode:'add'` with `costUsd: null` (Codex reports no cost); `contextTokens = input_tokens`; then `agent.turn end { finalText }` |
  | `turn.failed`, `error` | `turn end { isError: true }` |

- **No permission asks.** Codex runs inside its own `workspace-write` sandbox.
- **Binary:** `WORKBENCH_CODEX_BIN` overrides it.

## Runner interface (all adapters)

The adapter modules are `src/adapters/claude/runner.mjs`, `src/adapters/codex/runner.mjs` and `src/adapters/sim/simulator.mjs`. The simulator exports a `Simulator` class whose instance has `createRunner(opts)`.

```js
// Each adapter module exports:
export const harness;                       // 'claude' | 'codex' | 'sim'
export async function available();          // -> { ok, version?, reason? }
export function createRunner(opts);         // opts: { agentId, name, task, cwd, model?, budgetUsd?, emit, hook: { url, token }, log }
// A Runner:
//   start(): Promise<void>       launch and send the task
//   send(text): Promise<void>    next message: an answer or a hint
//   stop(): Promise<void>        stop the process tree; afterwards the engine emits agent.state stopped
//   info(): { pid: number|null, sessionId: string|null, alive: boolean }
```

`emit(event)` takes one normalized event. The runner fills in `ts` if it is missing.

## Engine (`src/core/engine.mjs`)

```js
export class Engine extends EventEmitter {
  constructor({ store, mode, repo, hook, defaultBudgetUsd, defaultModel, adapters, machines, deps, log, options })
  // adapters: { claude?, codex?, sim? }  (claude/codex: the runner modules; sim: a Simulator instance)
  // deps: { policy, commands, workspace, receipt }  injected so the engine can be tested with fakes;
  //        bin/workbench.mjs passes the real modules. engine.mjs must not import them directly.
  // options: { permissionTimeoutMs = 25 min, stuckSilenceMs = 4 min, tickMs = 1000 } (tests shorten these)
  async start()                                   // demo: seed the simulator; live: check adapters; start the 1 s tick
  async shutdown()                                // stop every runner; resolve held hooks as deny
  async startAgent({ task, harness, model, machineId, budgetUsd, name }) // -> AgentView
  async answer(agentId, { askId, answer })        // -> { ok, reply }
  async say(agentId, text)                        // -> { ok, reply }
  async stop(agentId)                             // -> { ok, reply }
  async command(text, { focusId })                // -> { reply, confirm?: { id, sentence, detail }, focusId? }
  async confirm(confirmId, go)                    // -> { reply, agentIds? }
  async hookPreToolUse(agentId, payload)          // -> hook response object (may wait for the person)
  async setMachineAwake(machineId, awake)         // -> { ok, reply }
  snapshot()                                      // -> { mode, repo, harnesses, agents, machines, spendTodayUsd, defaultBudgetUsd }
}
```

- **Launches always go through a confirm step** when they come from `command()`, whether typed or spoken. `startAgent` itself does not ask; the HTTP route that calls it is only used after a confirm.
- **Budget.** Every launch has one: `--max-budget-usd` for Claude Code. The default per agent is `defaultBudgetUsd` (2 USD).
- **Live mode** needs `repo`. Workspaces come from the repo's last commit; `snapshot().repo.dirty` counts uncommitted changes, so the UI can say they are not included.
- **Answers:**
  - permission: resolve the held hook;
  - question: `runner.send(answer)` and clear the ask;
  - stuck: "Stop it" means `stop`, "Let it keep trying" clears the ask, and any other text is sent as a hint;
  - done states: "Looks good" leaves it as is, and any other text is sent as a follow-up message.
- **On process exit** (`SIGINT`, `SIGTERM`, `exit`), stop every runner. Orphaned agents keep spending.

## Natural-language commands (`src/core/commands.mjs`)

`parseCommand(text, ctx)` returns an intent. `ctx` is `{ agents: AgentView[], focusId, machines: Machine[], harnesses: { claude, codex, sim }, pendingConfirm }`. Rule-based, no model calls.

| Intent | Example wording |
|---|---|
| `{ kind: 'start', tasks: [{ task, harness, machine }] }` | "start an agent to fix the flaky checkout test", "have codex write tests for the parser", "start Claude and Codex on the checkout bug, each on its own cloud machine" |
| `{ kind: 'task', task }` | an imperative work request with no start verb, such as "fix the login redirect" (when no question is waiting) |
| `{ kind: 'answer', agentId, text }` | free text while the focused agent has a question |
| `{ kind: 'allow', agentId }` / `{ kind: 'deny', agentId }` | "yes", "go ahead", "allow it", "approve" / "no", "don't", "deny" (focused permission ask) |
| `{ kind: 'stop', agentIds }` / `{ kind: 'stop_all' }` | "stop the flaky test" / "stop everything", "pause everything" |
| `{ kind: 'say', agentId, text }` | "tell search cleanup to keep the old route" |
| `{ kind: 'status', agentId? }` | "what needs me", "status", "what is checkout fix doing" |
| `{ kind: 'spend' }` | "how much have I spent today" |
| `{ kind: 'sleep', machineIds }`, `{ kind: 'wake', machineIds }`, `{ kind: 'sleep_idle' }` | "sleep cloud 2", "wake cloud 2", "sleep idle machines" |
| `{ kind: 'confirm', go }` | "do it", "yes", "cancel", "never mind" (only when `pendingConfirm` is set) |
| `{ kind: 'unknown', text }` | anything else |

Agent references resolve by fuzzy word overlap with `name` and `task`. "it" and "this one" resolve to `focusId`. The default harness is `claude`; "codex" anywhere in the clause picks Codex. "cloud" picks `machine: 'cloud'`.

## Permission policy (`src/core/policy.mjs`)

`decide({ tool, input, cwd, extraAllow })` returns `{ decision: 'allow'|'ask'|'deny', reason, sentence, detail }`. `sentence` and `detail` come from `describeRequest`.

- **Allow:**
  - Tools: `Read`, `Glob`, `Grep`, `LS`, `NotebookRead`, `ToolSearch`, `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TodoWrite`, `Agent`, `Task`, `Monitor`, `SendMessage`, `Skill`, `WebSearch`.
  - `Edit`, `MultiEdit`, `Write` and `NotebookEdit`, when the **real path** of the target (or of its nearest existing parent folder) is inside the real path of `cwd` and not inside `.git/`.
  - `Bash`, only when the command is a **single command with no shell metacharacters** (`; & | \` $ ( ) { } < > ` and newline) and its words match the safe list:
    - read-only commands: `ls pwd cat head tail wc echo which file stat tree diff sort uniq cut grep rg`, plus `find` without `-exec`, `-execdir`, `-delete` or `-ok`;
    - `git` with one of `status diff log show rev-parse ls-files blame grep`, or `branch` without `-d`, `-D` or `--delete`;
    - test runners: `npm test`, `npm run test|lint|build`, `pnpm test`, `yarn test`, `node --test …`, `node <path inside cwd>`, `pytest …`, `python -m pytest …`, `go test …`, `cargo test …`, `make test`, `npx jest|vitest …`;
    - any exact prefix listed in `extraAllow`.
- **Ask:** everything else, including `WebFetch`, every `mcp__*` tool and unknown tools.
- **Deny:** nothing by default.

## Workspaces and receipt

`src/core/workspace.mjs` uses `execFile('git', …)`.

- `prepareRepo(path)` -> `{ root, name, head, branch, dirty }`. It throws a plain-language error if the path is not a git repo or has no commits.
- `createWorkspace({ repoRoot, agentId, slug })` -> `{ path, branch, base }`. Runs `git worktree add -b workbench/<slug>-<agentId> <path> HEAD`, with `path` under `~/.workbench/worktrees/<repoName>-<hash of repoRoot>/`.
- `removeWorkspace({ repoRoot, path })`.
- `diffStats({ path, base })` -> `{ changed, adds, dels, list }`. Tracked changes come from `git diff --numstat <base>`. Untracked files come from `git ls-files --others --exclude-standard`, counted as additions by line count.
- `readRepoConfig({ repoRoot, ref })` reads `workbench.json` from the commit with `git show <ref>:workbench.json`, never from an agent's working copy. Default: `{ checks: [], rules: [], allow: [] }`.
  - `checks`: `[{ name, run, timeoutSec }]`
  - `rules`: `[{ say, paths: [glob] }]`
  - `allow`: `[command prefix]`

`src/core/receipt.mjs`:

- `checkRules(rules, changedPaths)` -> `{ kept: [{ say }], broken: [{ say, paths }] }`. A built-in glob matcher handles `**`, `*` and `?`.
- `runChecks({ cwd, checks, onProgress })` -> `{ state: 'passed'|'failed'|'none', results: [{ name, ok, ms, tail }] }`. Each check runs through `/bin/sh -c` in `cwd`, with the scrubbed environment and a timeout (default 300 s), killed at the timeout.

## Simulator and machines

- `src/adapters/sim/simulator.mjs` exports `class Simulator { constructor({ emit, now, speed, seed }); seedWorld(); createRunner(opts); onAnswer(agentId, ask, answer); tick(now) }`, plus `harness = 'sim'` and `available()`.
  - `seedWorld()` emits a starting world close to the approved mockup. Roots: Checkout fix (needs your OK; 2 finished helpers), Search cleanup (question), Flaky test (maybe stuck; 1 helper), Invoice export (done and checked; one rule broken), Help pages (says it is done) and Onboarding (working, with 2 helpers working).
  - Every working agent keeps producing believable plain-language activity, tokens, cost, thinking blips, plan progress and helpers coming and going. It is deterministic for a given seed.
  - New tasks get a scripted tree: plan, 1 to 3 helpers, work, sometimes a permission ask, then a finish.
  - Answers move scripted agents on.
- `src/core/machines.mjs` exports `class Machines extends EventEmitter { constructor({ demo }); list(); setAwake(id, awake); refresh(agentCountsByMachine) }`.
  - "Your laptop" is real: CPU from `os.loadavg()[0] / os.cpus().length`, memory from `os.totalmem()` and `os.freemem()`.
  - Demo mode adds Cloud 1 (awake, idle), Cloud 2 (asleep) and Cloud 3 (awake, 1 agent), each at 0.40 USD an hour while awake, with `simulated: true`.

## HTTP server (`src/server/http.mjs`)

`createServer({ engine, store, token, port, host: '127.0.0.1', rootDir, log })` returns `{ listen() -> Promise<{ url }>, close() }`.

**Static files:**

- `GET /` serves `ui/index.html`.
- `GET /ui/<file>` serves from `ui/`.
- `GET /shared/<file>.mjs` serves from `src/shared/`.
- No directory listing and no path traversal (resolve the path and require it to stay inside the root).
- `Content-Type` comes from the file extension.

**API:** JSON in and out. The token goes in header `X-Workbench-Token`, or in query `t` for GET routes only.

| Route | Does |
|---|---|
| `GET /api/state` | `engine.snapshot()` |
| `GET /api/stream` | SSE. `event: snapshot` on connect, then `event: agents` (AgentView[] for changed ids, coalesced every 250 ms), `event: machines`, `event: notice` (`{ text }`), and a `: ping` comment every 15 s |
| `POST /api/command` `{ text, focusId }` | `engine.command` |
| `POST /api/confirm/:id` `{ go }` | `engine.confirm` |
| `POST /api/agents` `{ task, harness, model, machineId, budgetUsd }` | `engine.startAgent` |
| `POST /api/agents/:id/answer` `{ askId, answer }` | `engine.answer` |
| `POST /api/agents/:id/say` `{ text }` | `engine.say` |
| `POST /api/agents/:id/stop` | `engine.stop` |
| `POST /api/machines/:id/awake` `{ awake }` | `engine.setMachineAwake` |
| `POST /hook/pretool` `{ agentId, payload }` | `engine.hookPreToolUse`; may wait for minutes |

**Safety, all required:**

- Listen on `127.0.0.1` only.
- The token is 32 random bytes as hex. Compare it in constant time.
- Every `/api` and `/hook` route needs the token.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
- POSTs need `Content-Type: application/json`, a body of at most 64 KB, and an `Origin` that is absent or equal to the server's own origin.
- Responses carry `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. No CORS headers.

## CLI (`bin/workbench.mjs`)

```
node bin/workbench.mjs --demo [--port 4317] [--no-open]
node bin/workbench.mjs --repo <path> [--budget 2] [--model <name>] [--port 4317] [--no-open]
```

- Prints `Workbench is running at http://127.0.0.1:<port>/?t=<token>`.
- Opens the browser with `open` (macOS) or `xdg-open`, unless `--no-open`.
- `--port 0` picks a free port.
- Exits with a plain-language message if `--repo` is missing in live mode.
- Ctrl-C shuts down cleanly.

## UI contract

- The UI reads the token from `?t=` on first load, then removes it from the address bar with `history.replaceState` and keeps it in memory.
- Debug parameters: `?pin=<agentId|first-helper|first-root>` pins a hover card; `?focus=<agentId>` sets the focus.
- Layout:
  - top bar: name, repo, spend today, machines;
  - left: the agent tree, where each row is a shape, a name and at most a few words of status;
  - centre: one thing at a time;
  - bottom: one bar to type or talk.
- Hovering a tree row shows a card of about eight lines with live progress and stats. Clicking pins it.
- The UI never shows a percentage of completion or an estimated finish time.
