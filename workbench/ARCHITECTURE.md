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
| `agent.state` | Set `state`, `stateReason`, `stateSince`. Entering a state in `ENDED` sets `endedAt`; leaving one clears `endedAt` and `error` (the agent was picked up again). Leaving `needs_ok`, `question` or `maybe_stuck` clears `ask` unless an `agent.ask` follows in the same batch. Recompute the parent's `helpers`. If a root enters `waiting_helpers`, set `now` to what it waits for: "Waiting for " + `waitingFor()` (narrate.mjs) of the working helper views (else the helpers in the split) and of the commands and other background tasks in the latest split (the event's `background`, or `agent.background`): "Waiting for 2 helpers", "Waiting for a background command", "Waiting for its helper and a background command". Without a split (Codex, the simulator) `backgroundTasks` counts helpers. An empty split reads "Its background work is done". |
| `agent.activity` | `phase: 'start'`: `now = sentence`, `toolCalls += 1`, `toolKinds[toolKind] += 1`, add 1 to the current spark bucket, `thinking = false`. `phase: 'end'`: push `{ ts, sentence, ok }` onto `recent` (keep the last 8). Either phase: `lastEventAt = ts`; `starting` becomes `working`. |
| `agent.thinking` | `thinking = on`. If `on` and no tool is in progress, `now = 'Thinking'`. |
| `agent.usage` | `mode: 'set'` replaces token totals; `'add'` adds. `costUsd` is what the harness reported: `null` until it reports any (a new view starts at `null`, never `0`), and replaced when the field is present (it may be `null`: not reported). `unreportedUsd` (Workbench's estimate of what the harness spent but has not reported yet; `0` when none) is replaced when present. `contextTokens` and `contextWindow` set `contextPct = contextTokens / contextWindow`. |
| `agent.turn` | `phase: 'start'`: `turns += 1`; a root in `question`, `done_*`, `checks_failed`, `waiting_helpers` or `failed` returns to `working`, because a new turn means it is working again (a message that waited while a turn failed starts the next one: `now` is "Working on your message"). Other states are kept: `stopped` comes back only through a message from the person, and `needs_ok` and `maybe_stuck` keep their ask. `now` says what it takes up: "Reading what its helpers found" after waiting on helpers, "Reading what came back" after waiting on commands only, "Picking up where it left off" for a done root (no message from the person started that turn: the engine sets `working` first for those, with "Working on your follow-up"). `phase: 'end'`: no state change (the engine decides). |
| `agent.background` | A root's background work now, from Claude Code's `background_tasks_changed`: `{ helpers, commands, others, work, ids }`. Kept with the view's meta; while the root is `waiting_helpers`, `now` is worded again from it. Not part of the AgentView. |
| `agent.plan` | `plan = { items, done: <completed count>, total: items.length }`. |
| `agent.says` | `says = text` (plain prose, the engine strips markdown). |
| `agent.ask` | `ask = { ...ask, createdAt: ts }`. The state is set by a separate `agent.state`. A permission ask also carries `why`, the permission check's reason in plain words (the simulator gives the words the check would). |
| `agent.askCleared` | `ask = null` if `ask.id === askId`. |
| `agent.files` / `agent.checks` / `agent.rules` / `agent.model` / `agent.session` | Set the field. |
| `agent.approval` | `approvals.auto`, `.byYou` or `.denied` += 1 (`denied` for any `decision: 'deny'`). |
| `agent.ended` | `endedAt = ts`; `error` from the event. |
| `machine.update` | Insert or replace the machine by `id`. |
| `notice` | Pass through to the UI as a notice. |

Every second the engine calls `store.tick(now)`. That rolls spark buckets (`SPARK_BUCKET_MS`, `SPARK_BUCKETS`) so `sparkEndsAt` stays current. Only views whose spark changed are reported as changed.

**Ids.** Root agents: 6 lowercase hex characters from `crypto.randomBytes`. Helpers: `<rootId>-<first 8 chars of the harness task id>`, or of the launching tool_use id (without `toolu_`) when the helper's messages arrive before its task id is known. A helper keeps its first id. Ids never contain `/` or `:`.

**Sorting.** `store.list()` returns roots ordered by `PRIORITY[state]` and then newest first, each root followed by its descendants in creation order.

## Agent lifecycle (engine)

The engine creates every root agent. It emits `agent.created`, then `agent.state starting`, then starts the adapter's runner. Runners create helpers themselves.

When a **root's** turn ends (`agent.turn` with `phase: 'end'`), the engine decides the state, in this order:

1. If `backgroundTasks > 0`: `waiting_helpers`, with the turn end's `background` split on the state event. Claude Code runs sub-agents in the background, and also shell commands the agent left running (Bash `run_in_background`, a command moved to the background at its timeout, a `Monitor`): the root's turn ends while they run, and Claude Code starts a new turn when they end. That new turn is recorded for sub-agents (fixture lines 297-298); for commands it is read from 2.1.221's code, not recorded. A command may never end (a dev server), so:
   - once the root has no helper working and nothing has happened for `stuckSilenceMs` (4 minutes; counted from its last event, its state change, the last change to its background list and the end of its last helper), it is asked once: `agent.ask { type: 'stuck', about: 'background', sentence: '<Name> has finished, but a command it started is still running.', detail: <what each command does, in Workbench's own words>, options: ['It is done', 'Keep waiting'] }` and `agent.state maybe_stuck` (reason "It left something running");
   - "It is done" (or "done") decides the turn as if nothing were left: the receipt below. The root leaves `maybe_stuck` at once (`agent.ask.cleared` and `agent.state working` in one batch), so the receipt is built while it is `working`, as after any turn, and a turn that starts during its checks is `working` and watched by the usual stuck rules. Its `now` keeps its last words ("Waiting for a background command") until the next step. The command keeps running until the person stops the agent or closes Workbench, and later turns do not wait again for the same task ids. "Keep waiting" goes back to `waiting_helpers` and is not asked again in that turn. "Stop it" stops the agent. Other words are a message for it;
   - a new turn takes the question back (the root works again); a process that exits while it is asked makes the root `failed` ("It stopped before finishing its work."). "It is done" or "Keep waiting" that comes between the exit and that change does nothing: the reply is "<Name> stopped running before your answer reached it." (`ok: false`);
   - if the background list is empty by then but no new turn came, the turn is decided without asking.
2. If `isError`: `failed`, with `stateReason` from the result. Examples: budget reached, model error.
3. Record what changed so far, whether or not a question follows: files changed (`diffStats`) and rules (`checkRules`).
4. Read the closing ask with `extractQuestion(finalText)`. It looks at the last paragraph that is not only courtesy, and at its last three sentences. A sentence ends at `.`, `!` or `?` followed by a space or the end, so "node test.mjs?" stays whole; never after "e.g.", "i.e.", "vs." or "cf.", nor after "etc." or an initial ("A.", "U.S.") when the next word starts in lower case ("the U.S. date format" goes on; "I went with option A. Should I continue?" is two sentences). These count only as words of their own, so "src/main.cf." still ends one. Known limit: an initialism before a capital still ends a sentence ("Should I use the U.S. English spelling?" reads "English spelling?"). A courtesy asks nothing and is skipped ("Let me know if you need anything else.", "Is there anything else...?", "Anything else?", "Feel free to...", "Hope this helps."); a line that names a decision ("should", "which", "whether", "prefer", "proceed", "continue", "before I") is never a courtesy. The ask is the last remaining sentence that ends with `?` or asks for a decision ("how would you like to proceed" included). An offer of more work ("Would you like me to also add a test?") is a question too.
   If there is one: emit `agent.says firstSentence(finalText)` when it differs, `agent.checks null` when older checks are showing, `agent.ask { type: 'question', sentence, options: [] }`, then `agent.state question`. The declared checks do not run: they judge finished work, and half-done work fails them. If step 3 failed, the question is still asked.
5. Otherwise run the declared checks (`runChecks`, with `agent.checks state: 'running'` while they run). Then:
   - all checks passed: `done_checked`;
   - a check failed: `checks_failed`;
   - no checks declared: `done_claimed` (also when step 3 or the checks could not run, with a plain reason: "Workbench could not check its work.");
   - and `agent.says firstSentence(finalText)`.

**One receipt at a time per agent.** Steps 3 to 5 are one receipt. A new turn, a message the agent took (`runner.send` succeeded), stopping the agent, or shutdown cancels a receipt still being built: the engine aborts the signal it gave `runChecks` (its checks' process groups are ended), applies nothing more from that receipt, and sets `agent.checks` to `{ state: 'none', results: [] }` if it said running. A newer receipt starts its checks only after the cancelled ones have ended, so two sets never run in one folder, and while a receipt is being built the agent is not checked for being stuck and a clean exit is not a failure (Codex exits after every turn). `agent.ended` does not cancel it.

**Held requests come first.** If the root is showing a held permission request when its turn ends (a helper's request Workbench could only show on the root), the decided state and the question's `agent.ask` wait: the engine applies them once the person has answered the last held request, and drops them if a new turn starts or the agent is stopped first. Files, checks, rules and `agent.says` show at once. A `failed` turn goes through at once, and the root's held requests are answered no. See "Held requests stay in view" below.

The engine gives a **helper** its final state when its runner reports the helper's task completed: `finished`, `failed` or `stopped`.

**Agent folders after Workbench stops.** An agent's worktree and its `workbench/<task>-<id>` branch are the only copy of its work, and the page offers no merge, so they are kept: Workbench removes neither while it runs (stopped, failed and done agents take follow-ups in the same folder). It removes a folder and its branch only when they hold nothing: at once when the agent could not start, and at shutdown, after the agent's process has stopped, for every agent (`removeWorkspace` with `onlyIfUnchanged`). Shutdown first lets a launch under way finish (up to `stopTimeoutMs`, 8 s), so no agent starts unseen after it began: an agent whose folder git was still making starts nothing, and that folder and branch go again (listed with the kept folders if they cannot), and one whose process was starting is stopped with the others. At exit the CLI prints where the kept work is. A forced exit (a second Ctrl-C, or 12 seconds) skips the tidying: every folder stays, and the CLI lists them all from `keptFolders()` without claiming they hold work.

**Stuck** (`stuck.mjs`, called from the engine's tick). An active agent is possibly stuck when any of these holds:

- the same tool sentence and input started 3 times in a row with no successful step in between;
- the same error text came back 3 times, each time within 10 steps of the time before and from a step started after it. A step is one tool call that finished, whatever its outcome; calls made together count as one step, so a batch that fails the same way counts once. Other steps succeeding in between do not reset the count: that is the agent editing and retrying into the same error. Only failed steps with error text count, and counts start afresh each turn. The same error now and then over a long turn is not a loop;
- it is `working` with no event for 4 minutes and no helpers working.

The engine then emits `agent.ask { type: 'stuck', sentence: '<name> has hit the same error three times.', options: ['Stop it', 'Let it keep trying'] }` and `agent.state maybe_stuck`. The state clears when the person answers, or when any step succeeds (after a silence, also when any step starts), whichever rule flagged it. So in an edit-and-retest loop the flag can come and go: the next edit that works clears it, and three more of the same error raise it again. Only `working` agents are checked, and never while their receipt is being built; a root that is `waiting_helpers` gets the question about background work in step 1 above instead.

## Permission flow (Claude Code)

Every Claude Code agent runs with a `PreToolUse` hook that calls `src/adapters/claude/hook-bridge.mjs`:

1. The bridge reads the hook payload from stdin. A payload whose `hook_event_name` is not exactly `PreToolUse` is blocked (exit 2) without asking the engine. It POSTs `{ agentId, payload }` to `WORKBENCH_HOOK_URL` with header `X-Workbench-Token: $WORKBENCH_HOOK_TOKEN`, which is that agent's own hook token, then waits as long as it takes.
2. The engine checks who is asking, then calls `policy.decide(...)`:
   - Only a live Claude Code root the engine launched may ask ("Workbench does not know this agent, so it said no." otherwise, for a Codex or simulated agent too). A stopped agent gets "This agent was stopped."; a request that arrives after the agent's process has gone (its runner's `info().alive` is false) gets "This agent is no longer running."; a helper the person stopped gets "The person stopped this helper.", even for tools the rules allow (a live helper from the moment its agent is asked to stop it; checked again after the policy, in case the stop came while the request was being checked). None of these shows anything.
   - The policy gets `cwd` (the engine's workspace, never the payload's), `extraAllow` (workbench.json), `readAlso` (the runner's `readAlso()`: Claude Code's own folders for this agent's session, keyed by the runner's session id, never the payload's) and `recipients` (`"main"`, the root's helper ids from the store, and the runner's `recipients()`: the helpers' task ids and the names their Agent calls gave them, read from Claude Code's own output, never from the payload).
   - **allow**: answer at once and emit `agent.approval how:'auto'`.
   - **deny**: answer at once.
   - **ask**: emit `agent.ask { type: 'permission', sentence: '<Name> <sentence>', detail, why, options: ['Allow', 'Deny'], primary: 'Allow' }` and `agent.state needs_ok` on the agent that asked. `why` is the policy's `reason` ("The file is outside the agent's own folder."), so the page can say why it asks. Who asks: without `payload.agent_id`, the root. With it, the runner names the agent from Claude Code's own output (`agentFor({ toolUseId: payload.tool_use_id, taskId: payload.agent_id })`), whatever id the helper got; a runner without `agentFor` gets the helper `<rootId>-<agent_id[:8]>`. If no helper is found within 1.5 seconds, the root asks in its place. A request from a helper that has already ended (`finished`, `failed` or `stopped`), checked again just before holding, is denied at once with "The helper is no longer running.": it is not asked about and does not bring the helper back. Then hold the HTTP response until the person answers, or until 25 minutes pass, which counts as a deny with the reason "No answer from the person in time".
   - **Held requests stay in view.** After every batch of events, each held request shows on its agent (its `ask`, with `agent.state needs_ok`) or waits behind another held request of the same agent that shows. While an agent shows one, the engine's other `agent.state` and `agent.ask` events for it wait (`finished`, `failed` and `stopped` go through); after the last request is answered the agent goes on to what was decided meanwhile, else to `working` if its turn is running, else back to `waiting_helpers` or `working`. An agent that finishes, fails, is stopped or is gone has its held requests answered no. Anything else that hid a held request (it should never happen) shows it again, with a warning in the log.
3. The engine responds with `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow'|'deny', permissionDecisionReason } }`. The bridge prints it to stdout and exits 0.
4. **Fail closed.** On any bridge error (unreachable engine, non-200, bad JSON, a payload that is not `PreToolUse`), the bridge writes a one-line reason to stderr and **exits 2**, which blocks the tool. This was verified against Claude Code 2.1.221: exit 2 blocks the call; exit 1 falls back to Claude Code's own permission check, which in headless mode refuses anything that needs approval.

The hook is registered with `"timeout": 1800` (seconds). Holding a request for more than 60 seconds was verified to work.

**Hook tokens.** Each Claude Code agent gets its own token: an HMAC-SHA256 of `workbench-hook:<agentId>` under a key that only the Workbench process holds (`bin/workbench.mjs`). The server accepts it on `/hook/pretool` only for that `body.agentId`, compared in constant time, and never on `/api`. So an agent's own environment cannot put asks on another agent's card. This does not separate agents that run as the same user: code an agent runs can read a sibling's environment (`ps eww`).

## Claude Code adapter

Facts below were observed in real runs of Claude Code 2.1.221. Fixtures: `test/fixtures/claude-*.jsonl` (one stdout JSON object per line) and `test/fixtures/hook-pretool-*.json`.

**Launch** (`args.mjs` builds this; `runner.mjs` spawns it in the agent's workspace):

```
claude -p --input-format stream-json --output-format stream-json --verbose --forward-subagent-text
       --setting-sources project --permission-mode default --strict-mcp-config
       --disallowedTools "Workflow CronCreate CronDelete CronList ScheduleWakeup PushNotification EnterWorktree ExitWorktree AskUserQuestion RemoteTrigger DesignSync"
       --settings '{"disableAllHooks":false,"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"<hook command>","timeout":1800}]}]}}'
       --append-system-prompt '<WORKBENCH_PROMPT>'
       --max-budget-usd <budget> --session-id <uuid> --name <name> [--model <model>]
```

- `--setting-sources project` and `--strict-mcp-config` keep the person's own plugins, hooks and MCP servers out of launched agents. Without them, the plugins on this machine injected instructions, an extra Stop hook and Slack tools into every agent. `project` loads the repository's committed `.claude/` settings, `CLAUDE.md`, rules, skills, agents and commands. `local` is left out: `.claude/settings.local.json` is the person's own, and in a worktree Claude Code reads it from the person's main checkout.
- `--permission-mode default`: no settings file can choose `bypassPermissions`, which would switch off Claude Code's own refusal to change protected files (`.git`, `.claude`, `.vscode`, `.npmrc`, shell rc files and the like).
- **`--settings`** carries `disableAllHooks: false` next to the hook. Settings given on the command line outrank the repository's, so a `disableAllHooks: true` in any settings file cannot remove the workbench's check (it would fail open).
- **Hook command:** `'/usr/bin/env' '-u' 'NODE_OPTIONS' '<node>' '<bridge>'`, every word quoted for the shell Claude Code runs it through. Claude Code takes the hook's environment from settings files, and a planted `NODE_OPTIONS` could load a script into node that prints "allow" without asking the engine.
- **`--disallowedTools`**: tools that schedule work outside the workbench's view (`Workflow`, `Cron*`, `ScheduleWakeup`, `RemoteTrigger`), change worktrees (`EnterWorktree`, `ExitWorktree`), wait for a terminal (`AskUserQuestion`), send notifications (`PushNotification`), or need a sign-in that cannot finish in a headless run (`DesignSync`).
- **Environment.** Copy `process.env`, delete the markers a surrounding Claude Code session or its editor/SDK host sets for the programs it runs (`SCRUB_ENV_RE` in `args.mjs`: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_JOB_DIR`, `CLAUDE_AGENT_SDK_*`, and `CLAUDE_CODE_` + `CHILD_SESSION`, `SESSION_*`, `BRIDGE_SESSION_ID`, `MESSAGING_*`, `REMOTE*`, `ENTRYPOINT`, `EXECPATH`, `SSE_PORT` and a few editor-host switches), then add `WORKBENCH_HOOK_URL`, `WORKBENCH_HOOK_TOKEN` (this agent's own hook token) and `WORKBENCH_AGENT_ID`. Never put the token in the command line or `--settings`: other users can read command lines with `ps`. The person's own settings and credentials stay: `CLAUDE_CODE_OAUTH_TOKEN` may be the only login on a cloud machine, and `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` choose the provider. (Codex agents and declared checks still get no `CLAUDE_CODE_*` at all.)
- **The session's own folders** (`sessionFolders` in `args.mjs`, the runner's `readAlso()`): `{ root: <CLAUDE_CONFIG_DIR or ~/.claude>/projects, session }` for long tool results and `{ root: realpath(<CLAUDE_CODE_TMPDIR or /tmp>)/claude-<uid>, session }` for background task output, with the runner's own session id. Nothing before the session id is known or when it is not a UUID; no temporary folder without a user id. Workbench does not set `CLAUDE_CODE_TMPDIR`.
- **`WORKBENCH_PROMPT`:** "You are running inside Workbench, which shows your progress to a person in plain language. Work only inside the current folder. If you need a decision from the person, end your turn with one short, clear question. When you finish, begin your final message with one plain sentence, understandable by someone who does not write code, saying what you did."
- **First message.** Written to stdin as `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<task>"}]}}` plus a newline. Further messages (answers, hints) use the same shape. The process stays alive between turns while stdin is open. Closing stdin ends it.
- **Binary.** `WORKBENCH_CLAUDE_BIN` overrides the binary. Tests point it at a script that replays a fixture.

**Parsing** (`parse.mjs`; pure; `createClaudeParser({ rootId, now })` returns `{ push(obj) -> Event[] }`):

- **`system/init`.** Comes once per turn. Emit `agent.model` with `obj.model` and `agent.session` with `session_id` for the root, then `agent.turn phase:'start'`.
- **Root assistant messages** (`parent_tool_use_id` null). For each content block:
  - `thinking`: `agent.thinking on`.
  - `text`: remember it as the latest root text.
  - `tool_use`: `agent.activity start` with `narrate(name, input)`. Remember `id` mapped to `{ agentId, sentence, toolKind }`. A shell command reads as what it does ("Running the tests"), a package script by its name ("Running the db:migrate script"), or else as the command itself, clipped ("Running make deploy"); never as the agent's own `description` of it, which the agent writes.
    - The script name is the word right after `run` or `run-script`. If that word is an option (`npm run -w api test`), the line shows the command itself, since the next word may be the option's value.
    - Control, line-separator and direction-changing characters (Unicode's Bidi_Control set) become spaces before a command is clipped, for Bash and Monitor alike.
  - `Agent` or `Task` tool_use: remember it as a pending helper, keyed by tool_use `id`, with the `name` the call gives it (`SendMessage` can reach the helper by that name).
  - `TaskCreate { subject }`: add a plan item `{ id, text: subject, status: 'pending' }`. The id comes from the tool result `"Task #N created"` or the item's position.
  - `TaskUpdate { taskId, status, subject? }`: update that item.
  - `TodoWrite { todos: [{ content, status }] }`: replace the plan.
  - Emit `agent.plan` after any change.
- **Usage dedupe.** One assistant message is split across several stream objects that repeat the same `message.usage`. Count usage once per `message.id`. For the root, `contextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the latest message.
- **Spend not reported yet.** Observed: `total_cost_usd` and `modelUsage` come only on `result` lines, so before a turn ends nothing is reported (the view's `costUsd` stays `null`, "not reported yet", never `$0`). A message's input-side tokens are exact, but its `output_tokens` is only the count when the message began. *From the docs, not yet recorded:* a turn stopped with SIGTERM records no result. Each new message (root or helper) adds to an estimate, priced with `PRICES` in `parse.mjs` (`estimateUsd`); a model not listed is priced as the most expensive. Root `agent.usage` events carry it as `unreportedUsd`. In the recorded runs the result reported 6 to 14 percent more than the estimate, so it is a lower bound.
- **Tool results** (`type: 'user'`, `tool_result` blocks). `agent.activity end` for the remembered `tool_use_id`, with `ok = !is_error`. The Agent tool's result is metadata ("Async agent launched"), not an end of work.
- **`system/task_started { task_id, tool_use_id, description, subagent_type }`.** `agent.created` for a helper: `agentId = <rootId>-<task_id[:8]>`, `parentId` = the agent that issued `tool_use_id`, `name = nameFromTask(description)`, `helperType = subagent_type`, `harness: 'claude'`. Then `agent.state working`. Keep the map `task_id` and `tool_use_id` to helper id. If the helper already exists (made from its forwarded messages), only map `task_id` to it: no new helper, no new id. A task that is not a sub-agent (a shell command, `task_type: 'local_bash'`) makes no helper; its task id is mapped to what the shell call that started it does, in Workbench's own words.
- **`agentFor({ toolUseId, taskId })`** returns the agent that issued that tool call (the root or a helper, while the call is open), else the helper with that task id, else null. The PreToolUse hook payload carries both (`tool_use_id`, `agent_id`).
- **Messages with `parent_tool_use_id = X`** belong to the helper whose `tool_use_id` is X. Their tool_use, tool_result, thinking and usage become that helper's events. Usage uses `mode: 'add'`, deduped by `message.id`.
- **`system/task_progress { task_id, description, usage: { total_tokens, tool_uses, duration_ms }, last_tool_name }`.** Emit `agent.activity start` on the helper.
  - Claude Code builds `description` from the call's input for Read, Write, Edit, NotebookEdit, Glob, Grep, WebFetch and WebSearch ("Reading greet.js"); that sentence is used as it is.
  - For any other tool, Claude Code uses words the agent wrote: "Running <the Bash call's description>", "Monitoring: <description>", an Agent call's description, or the helper's task. Those lines, and lines without `last_tool_name`, are not shown. The forwarded call names the step by what it really does, so each step still starts once (the store counts every start).
  - Do not double count a tool start: `usage.tool_uses` numbers the helper's steps, and forwarded tool_use blocks are counted the same way. A forwarded call for a step a progress line already described from its input is not shown again. A forwarded call for any other tool is always shown, even when a later step's progress line came first. Without a count, compare against the helper's last sentence.
- **Helper ends.** On `system/task_updated` with `patch.status` in `completed | failed | killed | stopped`, or on `system/task_notification { status, summary }`, emit `agent.says firstSentence(summary)` (when there is a summary), then `agent.state finished | failed | stopped` and `agent.ended` for the helper. Ignore duplicates.
- **`system/background_tasks_changed { tasks: [{ task_id, task_type, description }] }`.** Track the root's running background tasks. A task is a helper when the parser shows a live helper for its id; otherwise it is a command (`task_type: 'local_bash'`: Bash `run_in_background`, a command moved to the background at its timeout, a `Monitor`) or another background task (any other kind; unknown kinds are never taken for helpers). After any stream object that changed it, emit `agent.background { helpers, commands, others, work, ids }` for the root: `work` is up to three lines saying what the commands do, in Workbench's own words (never the task's `description`, which the agent wrote), `ids` the task ids that are not helpers. *These shapes come from 2.1.221's code and were never recorded for commands; record one run with Bash `run_in_background`, a timeout and TaskStop before relying on them.*
- **`system/thinking_tokens`.** Emit `agent.thinking on` only when it was off. A later tool_use or text turns it off.
- **`result { total_cost_usd, modelUsage, num_turns, is_error, result, permission_denials, subtype }`.**
  - `total_cost_usd` is **cumulative for the session**: set it, never sum it.
  - Token totals are the sums over `modelUsage[*]` of `inputTokens`, `outputTokens`, `cacheReadInputTokens` and `cacheCreationInputTokens` (also cumulative): `agent.usage mode:'set'`, with `unreportedUsd`.
  - A result covers what its totals grew by; the estimate keeps only what they do not include yet (a helper's message can stream before a result and be billed after it).
  - After a relaunch, the first result shows whether the new process counted what the stopped one spent after its last result (the same input-side token test as for the totals). If not, its tokens stay in the totals and its estimate stays in `unreportedUsd` for good. *From the docs and the 2.1.221 bundle, not yet recorded:* a `-p --resume` process starts its totals at zero; the docs say totals are restored from v2.1.277. Follow-up: record one stop-then-resume run as a fixture.
  - `contextWindow` comes from `modelUsage[*].contextWindow`.
  - Then `agent.turn phase:'end'` with `finalText: result`, `backgroundTasks: <count>`, `background: <the split, as in agent.background>`, `isError: is_error || subtype !== 'success'`.
- Unknown message types are ignored.

**Runner** (`runner.mjs`; `createClaudeRunner(opts)` returns a Runner, see below):

- Split stdout on newlines, buffering partial lines. Keep the last 4 KB of stderr.
- On exit with code 0: `agent.ended outcome:'ok'`, unless the engine already ended it. On non-zero exit: emit `agent.ended outcome:'error'` with the stderr tail, then `agent.state failed`.
- `stop()` sends SIGTERM to the process group (spawn `detached: true`; kill `-pid`), then SIGKILL after 3 seconds.
- `send(text)` writes to stdin if the process is alive. Otherwise it relaunches with `--resume <sessionId>` (same flags, no `--session-id`) and writes the message.
- **Budget on a relaunch.** `--max-budget-usd` counts only the new process's own spend (from the docs, not yet recorded: totals restored on resume don't count toward it, and in the 2.1.221 bundle the check is the process's running total against the limit). So a relaunch gets the budget minus the reported cost minus `unreportedUsd`. If less than one cent is left, `send` refuses with a plain error the engine passes on as it is: "<Name> has used its whole spending limit, so it can’t continue."
- `readAlso()`: `sessionFolders` for its current session id and the environment it launched Claude Code with.
- `recipients()`: the parser's list of what `SendMessage` may call this root's own helpers: each helper's workbench id, its full task id (Claude Code tells the agent to continue a helper with `to: '<task id>'`) and the `name` its Agent call gave it. Helpers that have ended count too.
- `agentFor({ toolUseId, taskId })`: the parser's answer, for the hook.

## Codex adapter

Facts observed with `codex-cli 0.166.0`. Fixtures: `test/fixtures/codex-run.jsonl`, `test/fixtures/codex-resume.jsonl`.

- **Launch:** `codex exec --json -C <workspace> --sandbox workspace-write [-m <model>] -- <task>`, with stdin ignored. Otherwise Codex waits for stdin. `--` ends the options, so a task that starts with "-" or is a subcommand name ("review") stays text.
- **Follow-up:** `codex exec resume --json -c sandbox_mode="workspace-write" [-m <model>] -- <threadId> <text>`, spawned with its cwd set to the workspace. `resume` accepts neither `-C` nor `--sandbox`, so the folder is the process's cwd and the sandbox a config override. It worked without `--ephemeral`.
- **Environment.** A copy of `process.env` without Claude Code's session markers (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK*`), without the variables a running Codex sets for its commands (`CODEX_THREAD_ID`, `_SESSION_ID`, `_TOOL_CALL_ID`, `_SANDBOX`, `_SANDBOX_NETWORK_DISABLED`, `_PERMISSION_PROFILE`, and `CODEX_EXEC_SERVER_*`, `CODEX_NETWORK_PROXY_*`, `CODEX_SNAPSHOT_*`, `CODEX_SHELL_SNAPSHOT_*`) and without `WORKBENCH_HOOK_URL`/`WORKBENCH_HOOK_TOKEN` (Codex has no hook; its commands must not reach the engine), plus `WORKBENCH_AGENT_ID`. `CODEX_HOME`, `CODEX_API_KEY` and other sign-in and config variables stay. `test/live-fake-codex.test.mjs` runs the whole chain against `test/helpers/codex-fake.mjs`.
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
export function createRunner(opts);         // opts: { agentId, name, task, cwd, model?, budgetUsd?, emit, hook: { url, token } | null, log }
//                                          // hook is null for anything but a live Claude Code agent
// A Runner:
//   start(): Promise<void>       launch and send the task
//   send(text): Promise<void>    next message: an answer or a hint
//   stop(): Promise<void>        stop the process tree; afterwards the engine emits agent.state stopped
//   info(): { pid: number|null, sessionId: string|null, alive: boolean }
//   readAlso?(): ({ root, session } | string)[]  its own scratch folders, for the policy (Claude Code only)
//   recipients?(): string[]      what SendMessage may call its own helpers, from its output (Claude Code only)
//   agentFor?({ toolUseId, taskId }): string|null   the agent behind a hook call, from its output (Claude Code only)
```

`emit(event)` takes one normalized event. The runner fills in `ts` if it is missing.

## Engine (`src/core/engine.mjs`)

```js
export class Engine extends EventEmitter {
  constructor({ store, mode, repo, hook, defaultBudgetUsd, defaultModel, adapters, machines, deps, log, options })
  // hook: { url, tokenFor(agentId) }  where the hook posts, and each agent's own hook token. Read at each launch;
  //        a live Claude Code runner gets { url, token: tokenFor(id) } (null when tokenFor is missing or fails, and
  //        Claude Code then refuses to start); every other runner gets hook: null.
  // adapters: { claude?, codex?, sim? }  (claude/codex: the runner modules; sim: a Simulator instance)
  // deps: { policy, commands, workspace, receipt }  injected so the engine can be tested with fakes;
  //        bin/workbench.mjs passes the real modules. engine.mjs must not import them directly.
  // options: { permissionTimeoutMs = 25 min, stuckSilenceMs = 4 min, tickMs = 1000, tidyTimeoutMs = 3 s } (tests shorten these)
  async start()                                   // demo: seed the simulator; live: check adapters; start the 1 s tick
  async shutdown()                                // -> { kept: [{ id, name, path, branch }] }  stop every runner and every running
                                                  //    check, and wait for them; resolve held hooks as deny; remove the agent
                                                  //    folders that hold nothing; `kept` lists the ones that hold work.
                                                  //    A launch under way finishes first (see "Agent folders after Workbench stops")
  keptFolders()                                   // -> [{ id, name, path, branch }]  the agent folders still on disk, now
                                                  //    (synchronous: a forced exit lists them too; untidied ones included)
  killAllSync()                                   // on process exit: SIGTERM every agent's process group, SIGKILL every check's
  async startAgent({ task, harness, model, machineId, budgetUsd, name }) // -> AgentView
  async answer(agentId, { askId, answer })        // -> { ok, reply }
  async say(agentId, text)                        // -> { ok, reply }
  async stop(agentId)                             // -> { ok, reply }
  async command(text, { focusId, confirmId, askId }) // -> { reply, confirm?: { id, sentence, detail }, focusId? }
  async confirm(confirmId, go)                    // -> { reply, agentIds?, focusId? }  a launch, stop or message
  async hookPreToolUse(agentId, payload)          // -> hook response object (may wait for the person)
  async setMachineAwake(machineId, awake)         // -> { ok, reply }
  snapshot()                                      // -> { mode, repo, harnesses, agents, machines, spendTodayUsd, spendTodayEstimated, defaultBudgetUsd }
                                                  //    spendTodayUsd includes cost not reported yet (unreportedUsd); then spendTodayEstimated is true
}
```

- **Launches always go through a confirm step** when they come from `command()`, whether typed or spoken. `startAgent` itself does not ask; the HTTP route that calls it is only used after a confirm.
- **So do stops and messages whose words did not name the agent** (`sure: false` from the parser: "stop the stuck one", "tell the flaky test keep going"). `command()` returns a confirm card ("Stop Flaky test?"; "Tell Flaky test “keep going”?"; for one agent, both carry the detail "Its task: “…”", since two agents can have the same name), and `confirm(id, true)` then stops or sends. Cancel replies "OK, I won’t stop it.", "OK, I won’t stop them." or "OK, I won’t send it.".
- **A yes or no answers only the confirm on screen.** `confirmId` is the card the page shows. `ctx.pendingConfirm` is that confirm, or `{ id, gone: true }` when the id is unknown or has run out (so "yes" hears "That request is no longer waiting. Ask again if you still want it."), or null when no id comes. A confirm is never picked because it is the newest. With a card shown:
  - "do it", "yes", "cancel" and the like settle it (while a stop card shows, "stop" and "stop it" mean yes; while a message card shows, "send it" does; "start it" and "launch it" are a yes only to a launch);
  - a yes asked rather than said ("is that right?", "right?", "is that the right one", "that the right one", spoken without a "?") settles nothing, and keeps it like words not understood;
  - words not understood keep it: the reply is "I did not catch that. Say “do it” to start it, or “cancel”." (or "stop it", "stop them", "send it") and carries the same `confirm`, and it is not sent as a notice;
  - any other command withdraws it, without a notice, and the reply carries no `confirm`.
  Confirms the page lost (a reload, a second tab) can be answered only by their id and run out after 10 minutes. When a typed or spoken yes starts agents, the reply's `focusId` is the first one, so a second "yes" said out of habit finds nothing to answer.
- **Answers are bound to the ask on screen.** An ask is answered only by its own id, never as "whatever is showing now":
  - `answer(agentId, { askId })`: `askId` must be the agent's ask on screen or one of its held requests. Without it, an agent that has an ask is not answered ("Have a look at what Checkout fix is asking first."); an id that names something else is refused ("Checkout fix is asking something else now. Have a look, then answer again.", or "… is not waiting for that any more." when nothing is asked). Refusals are `{ ok: false, reply }` and leave the request waiting.
  - `command()`: the intents that answer (`allow`, `deny`, `answer`) need `askId`, and it must be the ask the parser read the words against (`intent.askId`); the same two refusals apply, with `focusId` set to the agent. When `confirmId` comes too, `askId` is not used: with a card on screen, no ask was. Commands that are not answers (stop, tell, status, start, sleep) act on what the words and `focusId` name, even when the ask on screen has changed since: "stop it" still stops the agent the person was looking at.
- **Answers:**
  - permission: from a button (`answer()`), exactly "Allow" or "Deny" (any case); anything else ("Yes", "OK", another ask's "Keep it working" or "Stop it") is refused with "Choose Allow or Deny." and the request stays held. Typed or spoken words reach it only through `command()`: a plain yes allows ("OK, Checkout fix can go ahead."); a no denies; a no with words denies and passes them on ("The person said no, and added: use the staging database"); a yes with conditions ("yes but only in the tests folder") is a no that passes on the whole reply ("The person did not allow this step as asked. They said: “…”", reply "OK, Checkout fix will not do it as asked. I passed on your words."). A yes asked rather than said ("is it okay?", "is this allowed?", "do you allow it", "yes?", "yes is that right", "you sure", "that okay", spoken without a "?") answers nothing: the reply is the request's status (below), and it stays held. An allow never carries words, and free text never allows;
  - question: any text (an option, or the person's own words) is sent with `runner.send(answer)` and clears the ask;
  - stuck: "Stop it" (or "stop") means `stop`, "Let it keep trying" clears the ask, and any other text is sent as a hint and clears it. The question about background work (`about: 'background'`) takes "It is done" (or "done"), "Keep waiting" (or "wait"), "Stop it", or a message (see Agent lifecycle, step 1);
  - done states (no ask, no `askId`): "Looks good" leaves it as is, and any other text is sent as a follow-up message.
  - `say()` is a message: it answers a question, but never settles a permission or a stuck ask (a held request stays held).
  - The demo follows the same rules: the simulator hears "Allow", "Deny" or the words of a no, and allows only on "Allow", and the person gets the same replies as in live mode ("OK, Checkout fix can go ahead.", "OK, Checkout fix will not do that."); a message to a seeded agent answers only a question; a stuck demo agent stops only on "Stop it" (or "stop").
- **Stopping a helper** (`stop()`, or "stop it" with the helper in the centre). In live mode a helper runs inside its agent's Claude Code process, so the engine asks the agent to stop it ("I asked Fix login redirect to stop its helper List repository files.") and, at once, says no to the helper's held requests and to every tool it asks for after that, even the ones the rules allow ("The person stopped this helper."). The helper's request leaves the centre and the helper goes back from `needs_ok` to `working` (it is not marked `stopped`): it ends when its agent reports it ended. A simulated helper, or one whose agent cannot be reached, is stopped by the engine itself.
- **Status of a held request** names the exact command, path or address: "Checkout fix wants to run a command: “npm run db:migrate -- --env test”. It needs your OK." Hidden characters become spaces, and a long one keeps its start and its end around "…" (`quotable` in narrate.mjs).
- **On process exit** (`SIGINT`, `SIGTERM`, `exit`), stop every runner and every running check (`killAllSync` also calls `receipt.killChecksSync()`). Orphaned agents keep spending; orphaned checks keep running with nothing left to time them out. After a clean shutdown the CLI prints the folders that hold an agent's work ("What the agents did stays on this computer, each in its own folder:"); after a forced exit, every folder still there (`keptFolders()`: "The agents’ folders are still on this computer:").
- **Spend** says "about" while part of it is Workbench's estimate: "You have spent about $0.62 today." Less than a cent is "under $0.01", estimated or not (`spentAmount` in `format.mjs`). A message an agent cannot take because its spending limit is used up gets the runner's own sentence as the reply.

## Natural-language commands (`src/core/commands.mjs`)

`parseCommand(text, ctx)` returns an intent. `ctx` is `{ agents: AgentView[], focusId, machines: Machine[], harnesses: { claude, codex, sim }, pendingConfirm }`. Rule-based, no model calls.

| Intent | Example wording |
|---|---|
| `{ kind: 'start', tasks: [{ task, harness, machine }] }` | "start an agent to fix the flaky checkout test", "have codex write tests for the parser", "start Claude and Codex on the checkout bug, each on its own cloud machine" |
| `{ kind: 'task', task }` | an imperative work request with no start verb, such as "fix the login redirect" (when no question is waiting); also a stop or tell verb followed by words that match no agent: "stop the flaky test from timing out", "warn the user when the onboarding flow fails" |
| `{ kind: 'answer', agentId, askId, text }` | free text while the focused agent has a question or might be stuck |
| `{ kind: 'allow', agentId, askId }` | a plain yes to the focused permission ask: "yes", "go ahead", "allow it", "approve", "yes please", "that's fine". Said, not asked: the same words as a question are a `status` |
| `{ kind: 'deny', agentId, askId, text?, conditional? }` | "no", "don't", "deny"; "no, use the staging database" (`text`: the words after the no); a yes with more words, "yes but only in the tests folder", "allow it but only once", "ok but not on main" (`conditional: true`, `text`: the whole reply). A reply that starts like a yes or a no but is no command and no work is a no with its words. An allow never carries words |
| `{ kind: 'stop', agentIds, sure? }` / `{ kind: 'stop_all' }` | "stop the flaky test", "stop the flaky test immediately" / "stop everything", "pause everything" |
| `{ kind: 'say', agentId, text, sure? }` | "tell search cleanup to keep the old route" |
| `{ kind: 'status', agentId? }` | "what needs me", "status", "what is checkout fix doing"; also a question typed at the focused permission ("do I need to approve this?", "sure, but what does it delete?", "should I allow it": it ends with "?" or starts like a question), which answers nothing and says exactly what is asked for. So is a yes asked rather than said: "is it okay?", "is this allowed", "do you allow it", "yes?", "why not", or a question right after the yes ("yes is that right", "go ahead, is that okay", "do it, is that right"), or one said with its "is", "are" or "do" left out ("that okay", "you sure", "it fine", "you allow it", "okay with you"), with or without a "?". Typed, "that's okay" keeps its "is" and is a yes. A clear "no, why …?" is still a no |
| `{ kind: 'spend' }` | "how much have I spent today" |
| `{ kind: 'sleep', machineIds }`, `{ kind: 'wake', machineIds }`, `{ kind: 'sleep_idle' }` | "sleep cloud 2", "wake cloud 2", "sleep idle machines": only when every word is about machines ("turn off the laptop screen saver" is work) |
| `{ kind: 'confirm', go }` | "do it", "yes", "cancel", "never mind", "make it so" (only when `pendingConfirm` is set: a confirm card is on screen). While a stop card shows, "stop" and "stop it" mean yes; while a message card shows, "send it" does; "start it" and "launch it" are a yes only to a launch. A yes asked rather than said ("is that right?", "right?", "is that the right one") is `unknown`, so the card stays |
| `{ kind: 'unknown', text }` | anything else |

Agent references resolve by fuzzy word overlap with `name` and `task`. "it" and "this one" resolve to `focusId`. The default harness is `claude`; "codex" anywhere in the clause picks Codex. "cloud" picks `machine: 'cloud'`.

A stop or a message acts at once only when the words **name** the agent: its id, "it" for the focused agent, or two or more words of its name (all of a one-word name) and nothing else, with no other running agent's name having all of them (a helper does not count against its root). A message also needs a clear break before the text ("tell search cleanup **to** …"). Words of how soon ("immediately", "right away", "at once") are not part of the reference. An agent found by its task or state words, or by one loose word, gets `sure: false`, and the engine asks first. Words left over beside an agent's words mean work, not a stop: a `task` ("stop the flaky test from timing out"). Words that match no agent at all give a stop with no agent, and the engine says it could not tell which one. While a question waits, a stop that does not name an agent is the answer.

## Permission policy (`src/core/policy.mjs`)

`decide({ tool, input, cwd, extraAllow, readAlso, recipients })` returns `{ decision: 'allow'|'ask'|'deny', reason, sentence, detail }`.

- `readAlso`: the agent's own scratch folders, which it may read without asking. A string is a folder that belongs to this agent alone. `{ root, session }` covers `<root>/<any key>/<session id>/…`, where Claude Code keeps one session's tool results and task output; the session id must be a UUID, and other sessions under the same key still ask. Entries that are not absolute paths are ignored.
- `recipients`: the names `SendMessage` may reach without asking: `"main"` and this agent's own helper ids, task ids and names.
- `sentence` and `detail` come from `describeRequest` and the policy, never from the agent's own `description` of a command, which the agent controls. `detail` is the exact command, path or address. `reason` says why it was allowed, asked or refused. The sentence says what the call does in plain words, and where:
  - An edit or read outside the folder, an edit in `.git` or to a hard-linked file says so ("wants to change app.js outside its own folder").
  - A command that waits is named by what it does ("wants to delete files", "wants to install packages", "wants to run code from the internet"). An everyday word ("read a file", "run the tests", "search the code") is used only when the policy, judging each part of the command on its own, would allow it or asks only because of where it reaches. A part with a risky option, a value the shell fills in (`$HOME`), a variable set before it, or a command that is not on the safe list never gets one, and neither does any part of a command that uses another command's output as words (`$(…)`, backticks, `<(…)`).
  - When an option is what makes it wait, the sentence names what the option does: "write to a file" (`sort -o`, `git log --output`, `find -fls`, uniq's second file), "delete files" (`find -delete`, `pytest --basetemp`), "run another program" (`rg --pre`, `git grep -O`, `go test -exec`), "run a script" (a `node` option that loads code), with where the file is when the command names it. Anything else is "wants to run a command".
  - Where a command reaches is added even when it chains or redirects: the words of every part are checked, with `~` and `$HOME` expanded and relative words also tried from any folder it `cd`s into ("wants to read a file outside its own folder" for `cat ~/.ssh/id_ed25519 | head`). A place that cannot be checked (`~user`, a link to something missing) or links that are followed add ", which may reach outside its own folder". A `Monitor` sentence ends ", using something outside its own folder".
  - `SendMessage` says only what is known: "to another Claude session" for an address, "to someone other than its helpers" for a name not in `recipients`, and just "wants to send a message" when the engine passed no `recipients`.

- **Allow:**
  - Tools that only plan, look up tools or skills, report, search the web or manage the agent's own background tasks: `ToolSearch`, `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TodoWrite`, `Skill`, `WebSearch`, `ReportFindings`. A tool that can run a command, read or change files, or send a message never goes on this list: the hook is the only gate.
  - `Agent` and `Task` (helpers) without `isolation`. Each step a helper takes passes the hook too.
  - Reads (`Read`, `NotebookRead`, `Grep`, `Glob`, `LS`) when every place they look is inside the **real path** of `cwd` (its `.git` and `.claude` included) or in `readAlso`. The place is `file_path`, `notebook_path` or `path`; for `Glob` also the folder before the pattern's first wildcard. `Grep`, `Glob` and `LS` with no place look in `cwd`. A `Glob` pattern containing `..` asks. A place with blank space at its start or end asks: Claude Code trims it before it searches (`" ~/.ssh"` is the home folder's `.ssh`; JavaScript's `trim()` strips exactly the same). An absolute `Glob` pattern is also judged by the folder Claude Code searches for it: the text before the last `/` ahead of its first `*`, `?`, `[` or `{` (or the pattern's own folder when it has none), which asks when it ends in blank space. Each place is also judged as Claude Code reads it: `~` expanded and `..` taken away as text before any link is followed, so `deep/../..` asks when `deep` is a link that leads deeper inside the folder (the system would land back inside; Claude Code searches the folder above it).
  - `Edit`, `MultiEdit`, `Write` and `NotebookEdit`, when the **real path** of the target (or of its nearest existing parent folder) is inside the real path of `cwd`, not inside `.git/` or `.claude/`, and not a file that is hard-linked elsewhere. A link to something missing is judged by where it points, since writing through it creates that file. A target with blank space at its start or end asks, and is refused when it would be either as written or trimmed.
  - `Bash`, only when the command is a **single command with no shell metacharacters** (`; & | \` $ ( ) { } < > ` and newline) and its words match the safe list:
    - read-only commands: `ls pwd cat head tail wc echo which file stat tree diff sort uniq cut grep rg`, plus `find` without `-exec`, `-execdir`, `-delete`, `-rm` or `-ok`. Every word that names an existing file or folder must be inside `cwd` or `readAlso` (a wildcard counts as the folder it searches; `echo`, `which` and `pwd` are exempt). A relative word that climbs out of `cwd` asks even when nothing is there: after a `cd`, Claude Code runs the next command in that subfolder, where the same words can reach an existing file outside. After a wildcard, `..` or a segment that could match it asks: bash before 5.2, sh, dash and ksh expand `.*`, `..*`, `.?` and `.[.]` to `..` (`.env*` cannot match it and stays automatic). The slashes after `scheme:` in a web address (`grep "https://"`) are not a path. Options that follow links while walking folders (`grep -R`, `rg -L`, `find -L`, `tree -l`, `ls -L`, `diff -r`) and options that read a list of file names from a file (`--files0-from`, `file -f`) ask. In an agent's shell, Claude Code replaces `find` and `grep` with its own bfs and ugrep, so their extra options are covered too (`find -rm`, `find -files0-from`, `grep --dereference-files`, `grep --from`);
    - `git` with one of `status diff log show rev-parse ls-files blame grep`, or `branch` without `-d`, `-D` or `--delete`, with the same rule for the files it names (`diff --no-index`, `blame --contents`);
    - test runners: `npm test`, `npm run test|lint|build`, `pnpm test`, `yarn test`, `node --test …`, `node <path inside cwd>`, `pytest …`, `python -m pytest …`, `go test …`, `cargo test …`, `make test`, `npx jest|vitest …`. Their paths must stay inside `cwd`, out of `.git` and `.claude`, and not at a hard-linked file. An argument that is an address code could be loaded from (`data:`, `file:`, `http:`, `https:`, `blob:`, in any case, after any spaces) asks. `node --test` takes only the test options that `node --help` lists, each with a value that fits (a value given as the next word must not start with `-`), and `--test-reporter` only with Node's own reporters (`spec tap dot junit lcov`). Every option that loads a module asks: `--import`, `--require`, `--test-global-setup`, and a reporter given as a module or a `data:` URL. The words after `--` of a package script go to the script, which is often `node --test`, so they follow node's rules as well: an option that loads or runs code (`-r`, `-e`, `-p`, `--import`, `--loader`, `--env-file`, `--inspect` and the like, with `_` read as `-` as node does) asks, and node's own `--test-*` options must fit as above. Other programs' options, such as `--watch=false` or `-t login`, stay automatic;
    - any exact prefix listed in `extraAllow`.
  - `Monitor` (a command run in the background) when `Bash` would allow its `command`, with the same reason. A `ws` Monitor, or any field other than `command`, `description`, `timeout_ms` and `persistent`, asks.
  - `SendMessage` to a name in `recipients`. An address (anything with `:` or `/`, such as `uds:…`) never counts as a helper.
- **Ask:** everything else, including reads outside the folder, `WebFetch`, `SendMessage` to anyone not in `recipients` (it could be another Claude session), every `mcp__*` tool and unknown tools. The launch refuses `CronList` and `DesignSync`; should one reach the hook anyway, it asks.
- **Deny** (answered at once, and the agent hears why):
  - edits to Claude Code's own settings: any path through a `.claude` folder at any depth, or a file named `.mcp.json`, compared case-insensitively, in the agent's folder or anywhere else. They could switch this very check off. Commands that would run code from there or write there ask, like `.git`;
  - `Agent` or `Task` with `isolation` set (a separate worktree, or a cloud session): the workbench could neither show nor limit that work. The agent starts the helper again without isolation.
- **What it cannot see.** Test runners and `node <script>` run code from the agent's folder, which the agent may have written or changed, with the person's own rights. That code can read, change and send anything the person can. On a laptop, a repository or web page that tricks the agent is therefore a real risk; running the workbench on a cloud machine keeps that away from the person's own files. The same goes for the checks in `workbench.json` and for any command the person allows. A prefix in `extraAllow` allows any words after it, as the owner listed it. Git read commands also see the whole repository, including branches and stashes outside the agent's worktree. A wildcard, or a non-recursive `diff` of two folders, can still read through links that the repository itself contains.

## Workspaces and receipt

`src/core/workspace.mjs` uses `execFile('git', …)`.

- `prepareRepo(path)` -> `{ root, name, head, branch, dirty }`. It throws a plain-language error if the path is not a git repo or has no commits.
- `createWorkspace({ repoRoot, agentId, slug })` -> `{ path, branch, base }`. Runs `git worktree add -b workbench/<slug>-<agentId> <path> HEAD`, with `path` under `~/.workbench/worktrees/<repoName>-<hash of repoRoot>/`.
- `createWorkspace` removes the new worktree and its branch again (`worktree remove --force`, `branch -D`) if it cannot finish making it after `git worktree add` succeeded: nothing has run in it yet. It does the same when `git worktree add` itself fails part-way (a Ctrl-C in the terminal reaches git too, which leaves the branch it made first; a failing post-checkout hook leaves the whole worktree), but only when the branch was not there before it began (`git rev-parse --verify --quiet`): a branch that was there could hold kept work, and is never touched.
- `removeWorkspace({ repoRoot, path, deleteBranch?, onlyIfUnchanged?, base? })`. With `onlyIfUnchanged` nothing that might hold work is removed: the folder goes only if its HEAD is still `base`, `git status --porcelain --ignored --untracked-files=all` is empty (an ignored `.env` or build may be work too) and `git worktree remove` without `--force` succeeds; then the branch only through `git update-ref -d refs/heads/<branch> <base>`, in that order (update-ref would delete the branch of a folder that was kept). Without `base` it refuses. The engine calls it this way when an agent could not start, and for every agent at shutdown. Workspaces with changes are kept, with their branches.
- `diffStats({ path, base })` -> `{ changed, adds, dels, list }`. Tracked changes come from `git diff --numstat <base>`. Untracked files come from `git ls-files --others --exclude-standard`, counted as additions by line count.
  - A .gitignore the agent adds or changes cannot hide its new files from the receipt or the rules. Files that the ignore rules hide now but the rules at `base` would not are listed too, marked `ignored: true`.
    - What they hide now: `git ls-files --others --ignored --exclude-standard --directory`. It is run without `--no-empty-directory`, which leaves out a hidden file in a new folder that also holds a visible one. Git may then list a folder and the files inside it, so the result is de-duplicated.
    - The rules at `base`: its .gitignore files on the way to each path, written to a scratch folder and read there by `git check-ignore --no-index`, with the repository's own `info/exclude` and the person's global excludes.
    - A folder git lists as `out/` is judged as `out`, made as a real folder in the scratch folder. Judged as `out/`, a rule such as `out/*` would match it, although git looks inside and judges each file. If the rules at `base` do not hide the folder itself, it is listed file by file, without what they hid inside it (a `node_modules`, say).
    - Paths go to `check-ignore` as `./<path>`, and to `ls-tree` with `--literal-pathspecs`, so a name such as `:!x` or `:/x` is that file, never pathspec magic. Folder lists go to git a few hundred at a time.
    - If git still fails here, `diffStats` rejects with a plain error, and the receipt says "Workbench could not check its work." without running the checks.
- `readRepoConfig({ repoRoot, ref })` reads `workbench.json` from the commit with `git show <ref>:workbench.json`, never from an agent's working copy. Default: `{ checks: [], rules: [], allow: [] }`.
  - `checks`: `[{ name, run, timeoutSec }]`
  - `rules`: `[{ say, paths: [glob] }]`
  - `allow`: `[command prefix]`

`src/core/receipt.mjs`:

- `checkRules(rules, changedPaths)` -> `{ kept: [{ say }], broken: [{ say, paths }] }`. A built-in glob matcher handles `**`, `*` and `?`.
- `runChecks({ cwd, checks, onProgress, signal })` -> `{ state: 'passed'|'failed'|'none', results: [{ name, ok, ms, tail }] }`. Each check runs through `/bin/sh -c` in `cwd`, in its own process group, with the scrubbed environment and a timeout (default 300 s), killed at the timeout. Aborting `signal` ends the running check's whole process group (SIGTERM, then SIGKILL after 2 s) and marks the rest "Not run".
- `killChecksSync()` sends SIGKILL to every running check's process group at once, for the exit handler.

## Simulator and machines

- `src/adapters/sim/simulator.mjs` exports `class Simulator { constructor({ emit, now, speed, seed }); seedWorld(); createRunner(opts); onAnswer(agentId, ask, answer); tick(now) }`, plus `harness = 'sim'` and `available()`.
  - `seedWorld()` emits a starting world close to the approved mockup. Roots: Checkout fix (needs your OK; 2 finished helpers), Search cleanup (question), Flaky test (maybe stuck; 1 helper), Invoice export (done and checked; one rule broken), Help pages (says it is done) and Onboarding (working, with 2 helpers working).
  - Every working agent keeps producing believable plain-language activity, tokens, cost, thinking blips, plan progress and helpers coming and going. It is deterministic for a given seed.
  - New tasks get a scripted tree: plan, 1 to 3 helpers, work, sometimes a permission ask, then a finish.
  - Answers move scripted agents on, by the engine's rules. `onAnswer` settles the agent's own ask only when `ask.id` names it; with no ask it is a message (`say`). A permission allows only on "Allow"; any other words are a no, so a yes with conditions is one. A stuck agent stops only on "Stop it" (or "stop"); other words are a hint.
  - A simulated agent that has stopped or failed cannot be picked up again: its runner's `send` rejects with a plain error ("Checkout fix has stopped, so it cannot take messages."), which the engine passes on as the reply ("Continue" and "Try again" in the demo), and the agent stays as it is.
- `src/core/machines.mjs` exports `class Machines extends EventEmitter { constructor({ demo }); list(); setAwake(id, awake); refresh(agentCountsByMachine) }`.
  - "Your laptop" is real: CPU from `os.loadavg()[0] / os.cpus().length`, memory from `os.totalmem()` and `os.freemem()`.
  - Demo mode adds Cloud 1 (awake, idle), Cloud 2 (asleep) and Cloud 3 (awake, 1 agent), each at 0.40 USD an hour while awake, with `simulated: true`.

## HTTP server (`src/server/http.mjs`)

`createServer({ engine, store, token, hookTokenFor, port, host: '127.0.0.1', rootDir, log })` returns `{ listen() -> Promise<{ url }>, close() }`. `hookTokenFor(agentId)` gives each agent's own hook token (64 hex characters).

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
| `POST /api/command` `{ text, focusId, confirmId, askId }` | `engine.command`. Each id that is not an id string (`[A-Za-z0-9_-]{1,80}`) is passed as null |
| `POST /api/confirm/:id` `{ go }` | `engine.confirm` |
| `POST /api/agents` `{ task, harness, model, machineId, budgetUsd }` | `engine.startAgent` |
| `POST /api/agents/:id/answer` `{ askId, answer }` | `engine.answer`. An `askId` that is not an id string is passed as null |
| `POST /api/agents/:id/say` `{ text }` | `engine.say` |
| `POST /api/agents/:id/stop` | `engine.stop` |
| `POST /api/machines/:id/awake` `{ awake }` | `engine.setMachineAwake` |
| `POST /hook/pretool` `{ agentId, payload }` | `engine.hookPreToolUse`; may wait for minutes. Takes the page token, or that agent's own hook token |

**Safety, all required:**

- Listen on `127.0.0.1` only.
- The token is 32 random bytes as hex. Compare it in constant time.
- Every `/api` and `/hook` route needs the token. `/hook/pretool` also takes the asking agent's own hook token: once the body is read, it must equal `hookTokenFor(body.agentId)` (compared in constant time). Anything else gets `401 Missing or wrong token.` and the engine never sees it. A hook token never opens `/api`.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`.
- POSTs need `Content-Type: application/json`, a body of at most 64 KB, and an `Origin` that is absent or equal to the server's own origin.
- The page (any `.html` file served) with a query is served only when the query's `t` is the token. Anything else (`/?static=1`, `/?t=<wrong>`, `/ui/index.html?…`) gets `303` to `/` with `Cache-Control: no-store`. Any website can send the person's tab to an address here, so the address must not be able to change what the page does or replace the key the tab holds. Queries on other files (`/ui/app.js?v=2`) are unaffected.
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
- Ctrl-C shuts down cleanly: it stops every agent and every check, then prints each folder that keeps an agent's work (`engine.shutdown()`'s `kept`) with its branch. A second Ctrl-C, or 12 seconds, forces the exit: `killAllSync`, then every folder still on disk (`engine.keptFolders()`, untouched ones too, since the tidying was skipped) under "The agent’s folder is still on this computer:" (or "The agents’ folders are…"). Either way it exits once the words have reached the terminal or pipe, or after half a second; a third Ctrl-C exits at once.

## UI contract (`ui/`)

The page is plain ES modules with no build step, served by the engine. `/shared/*` is served from `src/shared/`, so the page and the engine use the same states, narration and formatting. Modules marked *pure* touch no DOM when they load and import nothing from `/shared/` (state sets are passed in), so `test/ui-*.test.mjs` load them in Node.

| File | Role |
|---|---|
| `index.html` | the page: the state marks (`#g-<shape>` symbols), the board's two SVG layers, then the core (the lid's page and the one input), the agents' toolbar, the machines, the done tray, the line under the core, the top band, the look menu, the card and the menus |
| `boot.js` | a classic script that puts the saved look and detail on `<html>` before the first paint (the CSP allows no inline script) |
| `app.css` | the three looks as custom properties, the board's surfaces, chips, the lid, the card, the menus; JetBrains Mono, all four weights |
| `app.js` | wiring: data and link states, one render (coalesced, at most one queued), the lid fitter, held swaps and the half-second guard, the lid's buttons, typing and voice, keys, the menus |
| `board.js` | `Board`: draws a layout as SVG copper and HTML chips kept by id, places the card, and animates what changed |
| `layout.js` | *pure*: size classes, rows, the core, every lane, chip, helper, pad and machine; `placeCard()`; `boardProblems()` for checks |
| `lanes.js` | *pure*: `Lanes` (lanes for life, in `sessionStorage`) and `denseLanes()` |
| `boardmodel.js` | *pure*: from AgentViews to what the board draws (stops, lit lines, queue numbers, helpers by need) |
| `focus.js` | `lidView(focus, options)`: the lid's words and buttons; `fitSteps()` |
| `card.js` | `cardHtml(agent, options)`: the card |
| `model.js` | client state `S`, the queues, `currentFocus()`, `stepQueue()` |
| `queue.js`, `look.js`, `words.js`, `numbers.js`, `prefs.js`, `link.js`, `address.js`, `util.js` | *pure*: the queues and set-aside; marks and words for states; text shaping; the card's numbers; the look, the detail level and the words the page answers itself; link states and plain errors; debug switches; `esc`, `coalesce`, `patchChildren` |
| `api.js` | the access key, JSON calls, the SSE stream |
| `voice.js` | hold to talk with the browser's speech recognition; `cancel()` throws away what was heard |

**Data.**
- The page reads the key from `?t=` once, keeps it in `sessionStorage` for this tab and removes it from the address bar with `history.replaceState`. Nothing in the address makes the page send anything.
- It opens `GET /api/stream?t=…`: a `snapshot`, then `agents` (changed views, coalesced), `machines` and `notice` events. A reconnect gets a new snapshot; chips are kept by id, so nothing replays. Only a snapshot prunes lanes.
- Every action is a JSON POST with `X-Workbench-Token` (see Answers).
- A page put in the browser's back/forward cache closes its stream (`pagehide`) and opens a new one when it comes back (`pageshow`), so streams nobody sees never hold the browser's few connections to the address.
- **Link states** (`link.js`): *no key*; *connecting* (a key, no snapshot yet: the lid is blank, then "Connecting…"); *live*; *reconnecting* (the stream dropped and the browser retries: "reconnecting…" beside the mark; after 10 s the lid says "Workbench isn’t answering."); *stale* (a 401 on any request, or on the one `/api/state` probe after the browser gives up on the stream: "This page’s key no longer works."). Without a working key the input is hidden, typing and space do nothing, and spend and machines are hidden; a stale board dims and is inert. Errors read in plain words, never "token" or "fetch".

**Layout: a circuit board.** You are the core in the middle; each root agent is a chip on its own lane.
- **Size classes.** `layout.js` picks S (narrower than 1180 px), M, or L (at least 1380×840) for type sizes, then lays everything out in CSS pixels from the room there is, so text never shrinks with the window.
- **Lanes for life.** Twelve lanes, six a side. The first time the tab sees a root it gets a lane (`Lanes`, kept in `sessionStorage`, pruned to live ids on each snapshot) and keeps it: laptop agents prefer the left, cloud agents the right, unless that side is full or two lanes fuller; rows fill top, bottom, then the middle, mirrored. A chip only slides along its lane:
  - beside the core when it, or one of its helpers, needs the person (`needs_ok`, `question`, `maybe_stuck`, or a failed check not set aside);
  - mid-board while it works;
  - at the board's edge, powered down (flat, dull leads, no copper to the core), once done, failed or stopped.
- **Traces.** Each lane is copper with 45° bends from a pin on the core to a via by the edge. A working chip's copper runs to the core. An asking chip's line is lit into the core (dashed when it might be stuck), with a numbered pad at the core in queue order (1 filled, the rest outlined). White corner brackets mark the agent the lid is showing. A failed agent's line is cut like a fuse.
- **The core** is a package (BGA balls, or one straight row of gold leads per side that stops short of the corners; pin 1; a courtyard; the designator YOU, at the courtyard's top-left corner, or its top-right one while a numbered pad sits by the left, or a little further left while pads sit by both). Its lid holds the lid's page and the one input. It grows for long content, within limits, and its edges always fall between rows, so no lane meets a corner: rows beside it are side lanes (the outer ones jog in at 45°), rows above and below come in from its top or bottom edge, nested so no two cross.
- **Helpers** are small parts on twigs from their chip: away from the core while the agent asks, towards it otherwise. They go in order of need (asking, working, latest ended), the asking one is always drawn, and those that do not fit fold into a "+N" button that pins the agent's card. A helper's ask lights core → agent → helper, and the brackets go on its agent.
- **Machines** are sections of the gold edge connector along the bottom: an LED, a moon when asleep. Each is a button that opens the machines menu (awake switches, the laptop's CPU and memory). Hovering an agent lights its machine's section.
- **Past twelve roots** the board goes dense: finished work moves to a done tray (a button that lists it; a row puts that agent in the lid), each lane splits in two so agents stay beside their old place on one-line chips, and helpers show as two marks and "+N". A one-line chip grows into the room on its lane (up to 1.3 times the usual width, keeping room to slide), so a name is cut only when the lane is full, and then to the chip's whole width at a word boundary. Rows are capped by what fits the window, and agents that need the person get the free rows first; any working agent beyond them is counted in the tray, whose list names it.
- **The line under the core** shows the hint "a lit line means it needs you" until the person first answers anything, and otherwise what Workbench just said. It wraps within the core's width, between the lanes that leave the core's bottom, and is cut to three lines (screen readers get all of it).
- **The top band**: the workbench mark (it opens the look menu), DEMO in the demo, the repository's name (in full where the band has room before the fiducial left of the core, else cut, with all of it in its title), "reconnecting…" when it applies, and spend today ("about $0.62 today" while the snapshot's `spendTodayEstimated` is true: part of it is Workbench's estimate of cost not reported yet).

**Looks.** `data-theme` on `<html>`: `green` (the default), `black-gold` or `ivory`. Each is a set of custom properties in `app.css`, taken from the three mockups and scoped to the surface text sits on (mask, chip, powered-down chip, lid, idle lid, card), plus a few surface details (balls or leads on the core, grain or a dot grid on the mask, a cut corner or a seal on the lid, cut or pill-shaped buttons). Layout and motion are the same in all three. `scripts/ui-contrast.mjs` (and `test/ui-contrast.test.mjs`) check every text pair at 4.5:1 and every mark and lit line at 3:1, in all three.

**Detail levels.** `data-detail` on `<html>`: `calm` (the default) or `more`.
- Calm: chips show the name and the state mark only; helpers are unlabelled parts (their names are in the card on hover or focus); machine sections show the name and the light; the lid keeps one sentence, a short meta line, at most two answers and the input; the card shows what the agent is doing now, its helpers, its plan, time and cost.
- More: status words under each chip, the names and doing-words of up to two helpers where they fit, machine notes ("memory almost full", "$0.40 an hour"), the meta line in full ("Claude · Cloud 1 · waiting 4 min"), the quiet links ("Answer in your own words", "Give it a hint", "What changed?") and the full card.
- Security over calm, in both: a permission always shows the exact command or path in small type under the sentence, cut in the middle past about 160 characters ("See all of it" opens all of it in its own scroll box), control characters shown as symbols, and the policy's reason (`ask.why`).

**Customising.** The workbench mark opens a small menu: "Look: Green · Black and gold · Ivory" and "Detail: Calm · More" (two radio groups). Typing or saying "black and gold", "ivory", "green board", "more detail" or "less detail" does the same: `pageCommand()` in `prefs.js` matches whole utterances only, so "make the button green" still reaches the agents, and these words are never sent to the engine. The choice is kept in `localStorage` (`wb-theme`, `wb-detail`) and applies at once, with a cross-fade (a view transition).

**The lid** holds one thing at a time. `currentFocus()` picks it, in this order:
1. a confirm card of a typed or spoken command (a launch, or a stop or message whose words did not name the agent);
2. the agent the person picked, stepped to, or that the engine's reply named (`focusId`);
3. the most urgent thing that needs the person (`needsQueue()`: by `PRIORITY`, then oldest first; a failed check set aside with "Look later" waits until that agent finishes again);
4. finished work not yet looked at (`reviewQueue()`: "2 of 3 to look at");
5. otherwise "Nothing needs you." (with "1 set aside" and "Look at … now" when something is set aside).
- A question's count line says who asks: "Search cleanup asks · 1 of 3", in the characters the lid has room for, with the name cut at a word boundary. A live question comes with what the agent changed so far (`files`, and `rules`, recorded before it is asked; no checks), so a question from an agent that changed files has a quiet "What changed?". "next", the → and ← keys when no control has focus, and a typed or spoken "next" step through the queue without sending anything.
- **Fitting.** The lid's words are measured before the board is laid out. When they do not fit, `fitSteps()` makes room in order: a smaller headline, a shorter meta line, no meta line, long texts cut at 190 characters with "Read all of it" (all of it in its own scroll box), then tighter buttons and a closer command. A permission keeps about 160 characters of its command and the whole of its reason through all of these; only the last step, a last resort, cuts both (all of both under "See all of it").
- **Answers.** Two answers sit side by side while each fits on one line, with tighter padding when that is what it takes, and otherwise one above the other at the lid's full width, the first still the primary one (`buttonRow()` in `words.js`). A label never wraps to squeeze a row.
- **Counters** say "asked just now" (or "just now") under a minute and then whole minutes ("waiting 4 min"), so nothing in the lid or the card changes every second.
- **Changing what it shows** takes three steps, so no words are ever outside the lid: the old page fades out (200 ms) at the size the core was laid out for; with the lid empty, the core takes the new item's size; then the new page rises in (360 ms). A page drifts only within the room its words leave in the lid. The new item's answers ignore clicks during the swap and for a moment after (about 760 ms from the change), and typed or spoken words begun in that window, or while the old page still shows, are bound to nothing: a "yes" then gets "Have a look at what … is asking first." instead of answering something unseen. The same item, updated, is patched rather than rebuilt: focus, an opened detail and a button whose answer is on its way all survive.
- **Holding.** While the pointer or keyboard focus is in the core, the input has text, voice is listening or a reply is open, the lid keeps what it shows (as long as that is unchanged) against what arrives on the stream, and adds "Another one needs you" (also for a launch question waiting behind it) instead of swapping. It swaps when the person leaves the core, or after 20 s without input. The person's own moves are never held: a lid button ("next", "Look later", "Looks good", "Back", …), → and ←, a typed "next", picking a chip or a done-tray row, and the reply to their own command (a new card, or a `focusId`) show at once; an agent the reply names before the stream has brought it (the first agent of a launch just confirmed) comes to the core as soon as it arrives. Words typed or spoken before such a move are not bound to the item that comes in. A failed or refused answer is not a move: the core keeps what the person answered (still held) and its button can be tried again, with the keyboard back on it.

**Card.** Hovering or focusing a chip or helper shows its card beside it on a drawn leader, never on the core or the top band (it gets narrower when it must). Clicking pins it; clicking again, Esc, or a click on the bare board unpins it. It is rebuilt only when its words change. Calm: Now, Helpers (by need: four on hover, six in "more", ten once pinned, then "and N more"), Its plan, Time and Cost. More adds harness · model · machine, Last, Activity (the steps in the bars' 10-minute window, and the count in all), Tokens (new tokens: input, output and cache writes; re-reads from memory are in the tooltip), Context used, Approvals and Files changed. A cost not reported yet reads "not reported yet" (`costUsd` null and no estimate); a cost that is partly Workbench's estimate reads "about $0.05" (`unreportedUsd` > 0); `spentText(usage, harness)` in `format.mjs` words all three, and two more cases: "not reported" for Codex, which never reports cost (no "yet"), and "under $0.01" below a cent, never "<$0.01" or "about <$0.01" (the page uses `spentWords(usage, money, harness)` in `numbers.js`, with the same words for all five cases, so it also runs against an engine whose `format.mjs` has no `spentText`; spend today sums reported cost and the estimate the same way and words its amount like `spentAmount()`). A Claude helper's cost is "in its agent". A root that is `waiting_helpers` says what it waits for with its `now` ("Waiting for a background command"), never a count of its helper views: it may be waiting on a command it left running. Time and "quiet for" show whole minutes ("under 1 min" at first). A stuck ask with `about: 'background'` reads "left a command running" (the half-dot mark, lit like an ask, not dashed); the lid shows its sentence and `detail`, with "It is done" and "Keep waiting".

**Typing and voice.**
- Letters typed anywhere except a text field go to the input, also after clicking a chip or a button: a mouse click never moves the keyboard focus.
- Space types in a text field and presses a control reached with the keyboard; anywhere else, holding it talks and letting go sends what was heard. Esc while listening, or the window losing focus, throws it away.
- Text goes to `POST /api/command` with what the lid showed when the person began (see Answers), except the page's own words (the looks, the detail levels, "next"). Anything that starts agents comes back as a confirm, shown in the lid, and so does a stop or message whose words did not name the agent.
- "Tell it something", "Ask for a change", "Answer in your own words" and "Give it a hint" turn the input into a reply to one agent ("to Search cleanup:"). The reply keeps the agent, its ask and the state it was opened in: an answer goes only to that ask, and a message only while the agent is still in that state; otherwise the page says "That changed. Have another look." and keeps the words in the input.

**Answers: what the page sends.** Every answer names what the person saw, by id. The engine refuses anything else and the request keeps waiting, so a click or a "yes" can never land on something that took the old one's place.
- **Buttons** send the ids they were drawn for (keep them on the button: `data-agent`, `data-ask`, `data-confirm`), never what the centre holds at click time; it may have changed during the fade.

  | Button | Request |
  |---|---|
  | Permission "Allow" / "Deny" | `POST /api/agents/<asker>/answer { askId, answer: 'Allow' \| 'Deny' }`: the asker's own id (a helper's, when a helper asks). No other words are accepted |
  | A question's option | `POST /api/agents/<agent>/answer { askId, answer: <the option's exact words> }` |
  | Stuck "Stop it" / "Let it keep trying" | `POST /api/agents/<agent>/answer { askId, answer: 'Stop it' \| 'Let it keep trying' }` |
  | Background work "It is done" / "Keep waiting" (a stuck ask with `about: 'background'`: "<Name> has finished, but a command it started is still running.", `detail` says what the command does; it is not "might be stuck") | `POST /api/agents/<agent>/answer { askId, answer: 'It is done' \| 'Keep waiting' }` |
  | Finished work "Looks good" | `POST /api/agents/<agent>/answer { answer: 'Looks good' }`, no `askId` (a finished agent has no ask; if it has one by then, this is refused) |
  | A typed follow-up on finished work | `POST /api/agents/<agent>/answer { answer: <text> }`, no `askId`, or `POST /api/agents/<agent>/say { text }` |
  | "Ask it to fix that" (a check failed), "Try again" (failed), "Continue" (stopped) | `POST /api/agents/<agent>/say { text: <the button's message> }` |
  | Confirm card "Do it" / "Cancel" | `POST /api/confirm/<confirmId> { go: true \| false }` |
  | "Stop it" on a working agent | `POST /api/agents/<agent>/stop`. On a live helper the reply is "I asked Fix login redirect to stop its helper …": its held requests are refused at once and its request leaves the centre; the helper shows `working` (not `stopped`) until its agent reports it ended |
  | "Dismiss", "Back", "next", "What exactly?" and the like | nothing: they only change what the page shows |

  `/say` and `/stop` carry no ask id, so the engine cannot tell what the person saw: the page sends them only for the agent the button was drawn for (`data-agent`), and only while that agent is still in the state it was drawn in (keep it on the button too). If it has changed, the page says so ("That changed. Have another look.") and redraws instead of sending.
- **The reply box** keeps the agent and the ask it was opened on. "Answer in your own words" on a question or a stuck ask sends `POST /api/agents/<agent>/answer { askId, answer: <text> }` (on a stuck ask, the text is a hint). "Tell it something" sends `POST /api/agents/<agent>/say { text }`, a message: it answers a question, but never settles a permission or a stuck ask. The reply box never posts text to a permission: words for a permission go through `/api/command`.
- **Typed or spoken text** sends `POST /api/command { text, focusId, confirmId, askId }`, all taken together at the first keystroke, or when the microphone turns on, not at Enter:
  - a confirm card on screen: `confirmId` is its id; `focusId` and `askId` are null (the engine ignores an `askId` that comes with a `confirmId`);
  - an ask on screen: `focusId` is the asker (the helper, when a helper asks) and `askId` is that ask's id;
  - an agent on screen with no ask: `focusId` is that agent; `askId` is null;
  - nothing on screen: all null.

  A typed or spoken "yes" allows only the permission whose `askId` came with it. Without it, the reply is "Have a look at what Checkout fix is asking first."; with an ask that has changed since, "Checkout fix is asking something else now. Have a look, then answer again." Both carry `focusId`, the asker. "yes but only in the tests folder" is a no, and the agent gets the words. A yes asked rather than said ("is it okay?", "do you allow it", spoken without a "?") answers nothing: the reply says exactly what it wants to run ("… It needs your OK."), with `focusId`, and the request keeps waiting. With a card on screen, "is that right?" keeps the card, as words not understood do. "stop it" with a helper's request on screen stops the helper (see the "Stop it" row above).
- **The reply to `/api/command`:**
  - `confirm` with a new id: show that card. It replaces any card shown, which the engine has already withdrawn.
  - `confirm` with the id of the card shown: the words were not understood. Keep the card and show `reply` with it; it is not sent as a notice.
  - no `confirm`: drop the card shown, if any, and do not post anything for it. The engine has already settled or withdrawn it, and a cancel would put "OK, I won’t start it." over the reply. Show `reply`.
  - `focusId`: put that agent in the centre: the asker after a refused answer, the stopped or told agent, or the first new agent after a typed "yes" to a launch.
  - A refused answer is an ordinary `reply` (status 200, no `ok` field).
- **Refusals from `/answer`** are `{ ok: false, reply }` with status 200 (`ui/api.js` throws them, marked `refused`). Show the reply and redraw from the current state; the request keeps waiting.
- **Withdrawing a card.** When the page drops a card for a reason that is not a command reply or one of the card's own buttons (the person picks an agent, or presses Esc), it posts `POST /api/confirm/<id> { go: false }`, so no card waits unseen. If that post fails, keep the card. A reload or a second tab forgets the card without telling anyone; the engine's copy can then be answered only by its id and runs out after 10 minutes. A card the page still shows after that answers "That request is no longer waiting. Ask again if you still want it."

**Motion** (`board.js`). Things move only when something changes; with `still=1` nothing moves at all.
- A chip slides along its own lane (900 ms) and its copper follows. A line that lights charges from the chip into the core (600 ms), after the slide, and its pad pops in; a line that goes out drains back (500 ms); pads renumber; the brackets move to what the lid shows; a finished chip powers down after its slide. A slide that is interrupted starts again from where the chip is.
- One pulse runs along the copper towards the core per real step (a rise in `toolCalls`), at most one per agent every 1.1 s.
- Hover lifts the chip 2 px, warms its copper, lights its machine, fades the card in (220 ms) and draws its leader (260 ms).
- A new ask's line breathes three times and then rests: while something waits, nothing repaints (counters change at most once a minute).
- The lid's swap: the old page fades (200 ms), the core resizes while the lid is empty, the new page rises (360 ms); see "Changing what it shows".
- `prefers-reduced-motion`, watched live, turns travel off: chips and lines jump, and there are no pulses or breaths.
- The first snapshot, a resize and a hidden tab draw without motion; a hidden tab queues at most one render and no step pulses.

**Accessibility.**
- The core comes first in the tab order. The board is one tab stop (`role="toolbar"`, a roving tabindex): ↑ ↓ move through chips and their helpers, ← → cross to the nearest chip on the other side, Home and End go to the ends, Enter or Space pins the card. Chips and helpers are buttons named like "Checkout fix, needs your OK, on Cloud 1. Number 1 of 3 that need you."; the agent the lid shows has `aria-current`, a pinned one `aria-expanded`, and each points to its card's one-sentence summary with `aria-describedby`.
- When the lid's item changes, focus that was in the lid moves to its sentence (`h1`, `tabindex=-1`), never to an answer. Focus is never dropped: a button waiting for its answer first hands it to the lid's sentence; a machine's switch keeps it (`aria-disabled` while its request is on the way); Esc in the done tray's list returns to the tray; a row chosen there by keyboard takes it to the lid's sentence. Its words are announced through a separate live region; the lid itself is not live. Allow and Deny have equal weight.
- Every state has its own mark (including a speech bubble for a question and a half dot for waiting on helpers) and its own words; colour only repeats them. The input shows when it has focus. Text is 10.5 px or larger.

**Debug parameters**, for scripts. They count only when the same address carries `t=<token>` (`debugSwitches()` in `address.js`, read once, before the key leaves the address bar); the server sends any other page address with a query to `/`. Nothing in the address makes the page send anything.

| Parameter | Effect |
|---|---|
| `static=1` | loads `/api/state` once instead of streaming. Headless Chrome never finishes loading a page with an open stream. |
| `still=1` | no motion at all: everything at rest at once |
| `pin=<agentId\|first-helper\|first-root>` | pins a card |
| `focus=<agentId>` | puts that agent in the lid |

**Checks** (they need Chrome, so they are not part of `npm test`):
- `scripts/ui-fit-check.mjs` loads every scenario of `scripts/ui-mock.mjs` (a stand-in for the API with the same security headers) at 960×900, 1024×700, 1280×680, 1440×789, 1512×862, 1728×1000, 1920×970 and 2560×1300, in both detail levels and all three looks, plus hover cards, the menus, an opened command, the reply chip, a long notice, a launch question and the link states. It fails on any text outside its box, any clipped text, anything off-screen, any overlap on the board, and any overlay (card, machines menu, done-tray list, look menu) on the core or the top band. Its `swap` view samples the page with motion on, from 30 to 800 ms into a swap between a long and a short item both ways and when a new ask arrives, and `card-pinned` checks pinned cards in each look. Screen-reader text, the one scroll box that holds a long command or question in full (`data-scroll`) and the live transcript (`data-clip-ok`) are allowed.
- `scripts/ui-behaviour-check.mjs` checks the rules above in the page (answers bound by id, the half-second guard, holding against the stream and letting go for the person's own moves with a real mouse and keyboard, focus, failed answers, "Look later", "next", typed and spoken words bound to nothing during a swap, confirm cards, the looks, the stale key, rest, reduced motion, voice, keys) and prints every request the page sent.
- `scripts/ui-shots.mjs` makes `docs/screens/`.

**Rules.**
- The UI never shows a percentage of completion or an estimated finish time.
- Everything an agent controls is escaped (`esc` in `util.js`) before it reaches the page.
- When the tab is hidden and something starts needing the person, the tab title becomes "• Workbench".
