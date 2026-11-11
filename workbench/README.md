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

A circuit board. The chip in the middle is you; each agent is a chip on its own lane.

- **Where a chip sits says how much it needs you.** Beside you, its line lit and numbered in the order to answer: it, or one of its helpers, is waiting for you. Mid-board: working. At the edge, dimmed: done, failed or stopped. An agent keeps its lane for life, so you always find it where it was.
- **Helpers** (sub-agents) are small parts beside their agent. A pulse runs along the copper when an agent takes a step; otherwise the board is still.
- **The middle** shows one thing at a time, in one sentence, with at most two buttons. A permission always shows the exact command or file, and why it is asked. "next" (or →) steps through what is waiting.
- **Hover a chip** (or Tab to the board and use the arrow keys) for its card: what it is doing, its helpers, its plan, time and cost. Click to pin it.
- **Type anywhere, or hold the space bar to talk**: "start an agent to fix the flaky checkout test", "what needs me", "stop the flaky test". Anything that starts an agent asks you first. A stop naming an agent acts at once ("Continue" picks it up again), and a "yes" answers only what was on screen when you began. The exact rules are in `ARCHITECTURE.md`.
- **Machines** are the gold connector along the bottom; click one for the machines menu. Spend today is at the top right: "about" while part of it is the workbench's estimate, and "not reported yet", never "$0", for an agent that has reported nothing.
- **Make it yours**: click the workbench mark for the look (green, black and gold, ivory) and the detail (calm, or more). Typing "ivory" or "more detail" does the same.
- When the tab is in the background and something needs you, its title gets a dot.

Each state has its own mark and its own words, so nothing depends on colour:

| Mark | Meaning |
|---|---|
| filled square | needs your OK |
| speech bubble | has a question |
| triangle | might be stuck |
| circle | working |
| half-filled circle | waiting on its helpers, or on a command it left running |
| filled diamond | done, and its checks passed |
| hollow diamond | says it is done (nothing checked it) |
| diamond with a cross | done, but a check failed |
| cross | failed |
| ring | stopped |

Screenshots of each look and view are in `docs/screens/`.

## What is real in this prototype

- **Claude Code agents are real.** Each runs the Claude Code program installed on this machine, with your own login, in its own git worktree of the repository. Worktrees start from your last commit, so uncommitted changes are not in them.
  - Your personal Claude Code plugins, hooks and MCP servers are deliberately **not** loaded into these agents, and neither is your own `.claude/settings.local.json`. The repository's committed `.claude/` settings are loaded too. Agents cannot change them, but treat them like the rest of your repository's code: a committed setting can change how an agent runs, including where its permission questions go.
  - Helpers (sub-agents) appear beside their agent as they start, and settle when they finish.
  - On a machine without a browser login, such as a cloud VM, set `CLAUDE_CODE_OAUTH_TOKEN` before starting the workbench; the agents use it.
- **Permissions.** Every action an agent takes passes through the workbench first:
  - **Approved automatically:** reading and searching inside the agent's own folder, edits inside it, and a short list of safe single commands such as `git status`, `ls` and test runners.
  - **Waits for your OK:** everything else, including reading anything outside the agent's folder. The question says in plain words what the agent wants to do and where, it comes with the workbench's reason for asking, and "What exactly?" shows the exact command or file. Asking "what is it doing", or "is it okay?", says the exact command too. Only "Allow", or a plain "yes" while that request is on screen, lets it run. Stopping a helper that is waiting says no to what it asked.
  - A command an agent runs reads on its card as what the command does, or as the command itself, not as the agent's own description of it.
  - **Refused:** changes to Claude Code's own settings (any `.claude` folder, and `.mcp.json`), and helpers that would work in a separate copy of the repository or on another computer.
  - **Blocked:** if the workbench cannot be reached, the action is blocked rather than allowed.
  - **Tests and scripts run code the agent may have written.** Test runners and scripts in the agent's folder are approved automatically, and they run as you, so that code can do anything you can. On your laptop, a repository or web page that tricks an agent is a real risk. Running the workbench on a cloud machine keeps that away from your own files.
- **When an agent finishes.** A closing "Let me know if you need anything else." is not a question: its work is checked and it is done. A real question at the end ("Should I remove the old route?") waits for your answer; "What changed?" already shows its changes, and its checks run only once it is done.
- **Commands left running.** An agent may leave a command running when it finishes, such as a development server. Its card says "Waiting for a background command". After four quiet minutes you are asked once whether it is done: "It is done" checks its work (the command keeps running until you stop the agent or close the workbench), "Keep waiting" waits on.
- **Might be stuck.** An agent that tries the same step three times without success, hits the same error three times close together, or goes quiet for four minutes is marked "might be stuck". The mark goes away as soon as a step works again.
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
| `checks` | Run after an agent says it is done. It becomes "done and checked" or "done, but a check failed". With no checks, it stays "says it is done". Sending the agent a new message, or stopping it, stops its checks. |
| `rules` | Each one is checked against the files the agent changed, including new files hidden by a `.gitignore` the agent added or changed. Those show in "What changed?" too. |
| `allow` | Adds command prefixes to the automatic approvals. |

The workbench reads this file from your last commit, never from an agent's copy, so an agent cannot loosen its own checks.

## Safety

- The page and its programming interface listen on `127.0.0.1` only. Every request needs the run's key, and requests from other websites are refused. A link with anything after the address except this run's key (an old link, say) opens the plain page instead; a tab without the key then asks you to open the link printed in the terminal.
- Each agent gets its own key for asking permission, so one agent's key cannot ask in another agent's name, and it never opens the page's interface.
- Every agent has a spending limit (`--budget`).
- Stopping an agent stops any checks it is running. Stopping the workbench (Ctrl-C) stops every agent it started and every check it is running. An agent still being set up at that moment is not started, and the folder made for it is removed.

## Limits (first prototype)

- The workbench keeps no history: after it stops, earlier agents do not appear again and cannot be resumed.
- Each agent's changes stay on your computer after the workbench stops, in its own folder under `~/.workbench/worktrees/`, on a branch named `workbench/<task>-<id>`; the terminal lists them when the workbench stops. The changes may not be committed. Folders where an agent changed nothing are removed, unless you press Ctrl-C twice: then the workbench stops without tidying up, every folder stays, and the terminal lists them all. To remove one yourself: `git worktree remove <folder>`, then `git branch -D workbench/<task>-<id>`.
- Sessions started outside the workbench, for example `claude` in your own terminal, do not appear.
- How far along an agent is cannot be measured honestly, so there is no percentage or finish time. The card shows elapsed time, steps, the agent's own plan and spend instead.
- Voice cannot be tested automatically. Try it in Chrome.

## For developers

- `ARCHITECTURE.md` is the contract between the parts.
- `npm test` runs the tests. They use recorded agent output in `test/fixtures/` and never start real agents. `test/live-fake.test.mjs` runs the whole chain (the CLI, the engine, the real permission hook, the HTTP API) with a stand-in for Claude Code that replays a recorded run.
- `scripts/demo-e2e.mjs` walks the demo through its HTTP API.
- The page's debug switches (`static=1`, `still=1`, `pin=<agent id>`, `focus=<agent id>`) count only when the same address carries the run's `t=` key. `scripts/ui-fit-check.mjs`, `scripts/ui-behaviour-check.mjs` and `scripts/ui-shots.mjs` drive the page in headless Chrome against a stand-in API (`scripts/ui-mock.mjs`), and `scripts/ui-contrast.mjs` checks the colours of all three looks.
- `scripts/accept-real.mjs <throwaway repo> [screenshots folder]` does one real run with Claude Code (haiku, at most $0.50) and prints PASS or FAIL for each step. Its header explains how to dry-run it with the stand-in first.

| Folder | Contents |
|---|---|
| `src/core/` | the engine, state, commands, permission policy, worktrees and receipts |
| `src/adapters/` | Claude Code, Codex and the simulator |
| `src/server/` | the local web server |
| `src/shared/` | code used by both the engine and the page |
| `ui/` | the page; no build step |
