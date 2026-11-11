# Workbench (prototype)

A place to run coding agents and see, in plain language, what each one and its helpers are doing. You answer what they need by typing or talking.

It does not replace your editor: it sits beside it.

## Run it

You need Node 22 or later. There is nothing to install.

```sh
cd workbench
npm run demo                       # simulated agents and machines; nothing is spent
npm start -- --repo ~/code/myapp   # real agents on your own git repository
```

The terminal prints a link like `http://127.0.0.1:4317/?t=…`. Open it in Chrome, which is needed for voice; it opens by itself unless you pass `--no-open`. The `t=` part is a key that only this run knows.

Options for real agents:

| Option | Meaning |
|---|---|
| `--repo <path>` | the git repository agents work on (required) |
| `--budget 2` | the most each agent may spend, in US dollars (default 2) |
| `--model <name>` | the Claude model to use, for example `sonnet` or `haiku` |
| `--port 4317` | where the page is served (`0` picks a free port) |

## What you see

- **Agents (left):** every agent you started, with its helpers (sub-agents) nested under it. Each row shows a shape, a name and a few words on what it is doing.
- **Hover a row:** a card with live progress and the main numbers:
  - what it is doing now, and its last steps;
  - its own plan, when it made one;
  - an activity sparkline;
  - time, cost against its budget, and tokens;
  - how much of its context is used, its helpers, and files changed;
  - how many actions were approved automatically and how many by you.

  Click a row to pin its card. Esc unpins it.
- **Centre:** one thing at a time, starting with whatever needs you: a permission, a question, an agent that might be stuck, or finished work to look at.
- **Bottom:** type or tap the microphone. Examples:
  - "start an agent to fix the flaky checkout test"
  - "start Claude and Codex on the checkout bug"
  - "what needs me"
  - "stop the flaky test"
  - "sleep idle machines"

  Anything that starts an agent asks you to confirm first.
- **Top right:** spend today and the machines.

The shapes are distinct, so state reads without colour:

| Shape | Meaning |
|---|---|
| filled square | needs you |
| triangle | might be stuck |
| filled diamond | done, and its checks passed |
| hollow diamond | says it is done (nothing checked it) |
| circle | working |
| cross | failed |

## What is real in this prototype

- **Claude Code agents are real.** Each runs the Claude Code program installed on this machine, with your own login, in its own git worktree of the repository. Worktrees start from your last commit, so uncommitted changes are not in them.
  - Your personal Claude Code plugins, hooks and MCP servers are deliberately **not** loaded into these agents. The repository's own `.claude/` settings are.
  - Helpers (sub-agents) appear in the tree as they start and finish.
- **Permissions.** Every action an agent takes passes through the workbench first:
  - **Approved automatically:** reading and searching, edits inside the agent's own folder, and a short list of safe single commands such as `git status`, `ls` and test runners.
  - **Waits for your OK:** everything else.
  - **Blocked:** if the workbench cannot be reached, the action is blocked rather than allowed.
- **Codex agents are real** when Codex is installed and logged in. They run in Codex's own sandbox, so they never ask for permission. Codex does not report cost, so it shows as "not reported".
- **Your laptop's** CPU and memory are real.
- **Cloud machines are simulated** and appear only in demo mode.
- **Voice** uses the browser's speech recognition. In Chrome this sends the audio to Google's speech service. Typing works everywhere.

## Checks and rules (optional)

Put a `workbench.json` at the root of your repository and commit it:

```json
{
  "checks": [{ "name": "tests", "run": "npm test", "timeoutSec": 300 }],
  "rules": [{ "say": "Do not touch migrations/", "paths": ["migrations/**"] }],
  "allow": ["npm run lint"]
}
```

| Key | What it does |
|---|---|
| `checks` | Run after an agent says it is done. It becomes "done and checked" or "done, but a check failed". With no checks, it stays "says it is done". |
| `rules` | Each one is checked against the files the agent changed. |
| `allow` | Adds command prefixes to the automatic approvals. |

The workbench reads this file from your last commit, never from an agent's copy, so an agent cannot loosen its own checks.

## Safety

- The page and its programming interface listen on `127.0.0.1` only. Every request needs the run's key, and requests from other websites are refused.
- Every agent has a spending limit (`--budget`).
- Stopping the workbench (Ctrl-C) stops every agent it started.

## Limits (first prototype)

- Nothing is kept after the workbench stops: no history, and no resuming agents from an earlier run.
- Sessions started outside the workbench, for example `claude` in your own terminal, do not appear.
- How far along an agent is cannot be measured honestly, so there is no percentage or finish time. The card shows elapsed time, steps, the agent's own plan and spend instead.
- Voice cannot be tested automatically. Try it in Chrome.

## For developers

- `ARCHITECTURE.md` is the contract between the parts.
- `npm test` runs the tests. They use recorded agent output in `test/fixtures/` and never start real agents.

| Folder | Contents |
|---|---|
| `src/core/` | the engine, state, commands, permission policy, worktrees and receipts |
| `src/adapters/` | Claude Code, Codex and the simulator |
| `src/server/` | the local web server |
| `src/shared/` | code used by both the engine and the page |
| `ui/` | the page; no build step |
