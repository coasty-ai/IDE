# Workbench (prototype)

A place to run coding agents and see, in plain language, what each one and its helpers are doing. You answer what they need by typing or talking. When an agent is done, you look at its changes, then merge them into your branch or throw them away.

It does not replace your editor: it sits beside it.

## Run it

You need Node 22 or later. There is nothing to install. Merging an agent's work also needs git 2.38 or later.

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
| `--claude <path>` | the Claude Code program to run. Without it: `WORKBENCH_CLAUDE_BIN`, then `claude` on the PATH, then the newest Claude Code extension in VS Code, VS Code Insiders or Cursor |
| `--port 4317` | where the page is served (`0` picks a free port) |

## What you see

A circuit board. The chip in the middle is you; each agent is a chip on its own lane.

- **Where a chip sits says how much it needs you.** Beside you, its line lit and numbered in the order to answer: it, or one of its helpers, is waiting for you. Mid-board: working. At the edge, dimmed: done, failed or stopped. An agent keeps its lane for life, so you always find it where it was.
- **Helpers** (sub-agents) are small parts beside their agent. A pulse runs along the copper when an agent takes a step; otherwise the board is still.
- **The middle** shows one thing at a time, in one sentence, with at most two buttons. A permission always shows the exact command or file, and why it is asked. "next" (or →) steps through what is waiting.
- **Hover a chip** (or Tab to the board and use the arrow keys) for its card: what it is doing, its helpers, its plan, time and cost. Click to pin it.
- **Type anywhere, or hold the space bar to talk**: "start an agent to fix the flaky checkout test", "what needs me", "stop the flaky test". Anything that starts an agent asks you first. A stop naming an agent acts at once ("Continue" picks it up again), and a "yes" answers only what was on screen when you began. The exact rules are in `ARCHITECTURE.md`.
- **The git chip** sits under you, wired to the core: a long memory chip with **git** printed on it. Click it (or Tab to it and press Enter), or type or say "git", "show git", "open git", "source control" or "show the graph", and the view travels down its wire to the **git screen**, below the board. "Back to the board" at the top left, Esc, or "back" or "board" takes you back up.
- **The git screen** draws your branch and your agents' branches as a circuit, newest commits at the top, where the wire arrives at your branch's tip (HEAD). Your branch is the thick gold trunk. Each agent's branch is a copper trace that leaves the trunk at the commit the agent started from, and comes back with a merge commit when you merge it. Your commits are gold vias, an agent's work commits small chips with its mark, merge commits square pads. Work not merged yet waits at the top of its trace, a dashed circle marked "not merged yet · 3 files" or "working". Beside each row: the subject, then who, when and the short id. It shows the newest 200 commits; work not merged yet on a branch that starts further back than that waits at the bottom, above "Older commits are not shown here."
- **Pick a row** (click it, or ↑ ↓ and Enter) for its detail; Esc closes it. An agent's detail shows its branch, its counts, its diff and what you can do with its work (see "Source control" below). A commit's shows who made it, when, its id, parents and branches.
- **The git screen's top band** says which repository and branch you are on, and how many uncommitted changes your folder has. When something needs you, it lights "<Name> needs you" (and a screen reader hears what comes while you are there), which takes you back to the board with that in the middle. What you type or say there goes to the workbench, about the agent whose detail is open, and, as in the middle, a "yes" answers only what was on screen when you began. While you hold the space bar to talk, the band shows a wave and the words heard so far in place of the input. Esc while you talk throws the words away ("Stopped listening.") and leaves the git screen, its detail and any card in it as they are.
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

Screenshots of each look and view are in `docs/screens/`: the board (`board-*.png`, with the git chip) and the git screen (`git-*.png`). `node scripts/ui-shots.mjs <folder>` takes them again, along with the lid's merge views (`merge-*.png`), which are not kept in the repository so that every agent's copy of it stays smaller; the `live-*.png` shots come from an earlier real run.

## What is real in this prototype

- **Claude Code agents are real.** Each runs the Claude Code program installed on this machine, with your own login, in its own git worktree of the repository. Worktrees start from your last commit, so uncommitted changes are not in them.
  - Your personal Claude Code plugins, hooks and MCP servers are deliberately **not** loaded into these agents, and neither is your own `.claude/settings.local.json`. The repository's committed `.claude/` settings are loaded too. Agents cannot change them, but treat them like the rest of your repository's code: a committed setting can change how an agent runs. It cannot switch off the permission questions or redirect them: the workbench sets those on the command line, which outranks the repository's settings.
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

## Source control

Each agent works on its own branch, `workbench/<task>-<id>`, in its own folder. Its work is not in your branch until you merge it. The workbench does the git for you, and asks before it changes anything.

**Looking at an agent's changes.** For a finished, failed or stopped agent, or one from earlier, whose folder may hold work not merged yet, the middle offers **Review the changes**. It opens the git screen on that agent, with its diff. So do the words "what did search cleanup change", or "show me the changes" and "diff it" for the agent in the middle. The diff shows what merging it would change in your branch: each file with its counts ("+12 −3", "new file, +40", "deleted, −8", "binary file", "too large to show here"), and each added or removed line marked + or −. Files hidden by a .gitignore the agent added or changed, and folders that are git repositories of their own, are listed as not merged. While the agent works, the detail says "It is still working, so its work may still change." Looking changes nothing; Esc takes you back.

**Merging.** When an agent is done and its work is not merged yet, the middle offers **Merge into main** (your branch's name) and **Ask for a change**, with **Review the changes** and **Not now** under them. "Not now" leaves the work where it is, unmerged, and tells the agent nothing: "OK. Search cleanup’s work stays on its branch for now." When a check failed, **Merge anyway** is under the answers. For a failed or stopped agent, or one from earlier, Merge is in its detail on the git screen. You can also type "merge search cleanup", or "merge it" for the agent in the middle (or whose detail is open).

Merge always asks first: "Merge Search cleanup into main?" The card gives the counts and what will happen ("3 files, +40 −2. Its work becomes a commit on its branch, joined into main by a merge commit."), then anything you should know first: a failed check, "Nothing checked its work.", a rule it broke, a change to `workbench.json`, `.claude/` or `.mcp.json`, files that stay out, and "Your 2 uncommitted changes stay as they are." Answer **Merge** or **Cancel**.

What a merge does:

1. The agent's work becomes one commit on its own branch: what `git add -A` would take in its folder, without files a .gitignore hides or folders that are git repositories of their own. The message is the task's first sentence, then the agent's last summary. It names the agent, and for Claude Code it adds `Co-authored-by: Claude <noreply@anthropic.com>`. The agent's folder then shows that work as committed.
2. A merge commit, "Merge Search cleanup: " and that first sentence, joins its branch into yours, even when git could simply have moved your branch forward, so the git screen always shows where it joined. Your folder moves to that commit.

Both commits are made with your git name and email. A merge never touches:

- your uncommitted changes. They stay as they are. If one is in the way, your folder stays as it was and the workbench says so;
- files git ignores in your folder, such as a `.env`: a merge that would overwrite one is refused;
- any branch but the agent's and yours. It merges only into the branch your folder is on, and it never pushes.

It never leaves conflict markers in your folder: git tries the merge first, without writing anything there. No git hooks run, and the commits are not signed, even if you sign your own.

After the merge, the middle says "Search cleanup’s work is in main.", with **See it in git** and **Ask for a change**. The agent keeps its folder and branch. It can take more work, and the next merge brings in only what it did since. When the workbench stops, a merged agent that changed nothing since is removed with its branch, as long as one of your branches still holds its work.

**When a merge does not go through,** nothing in your folder has changed, and the workbench says why. Most reasons stay in the middle until they are settled:

| It says | What to do |
|---|---|
| "Search cleanup’s work does not merge cleanly into main." and "Both changed: a.js, b.js" | Press **Ask it to bring in main**: it asks the agent to merge main into its own branch, resolve the conflicts and finish. Then merge again. |
| "Your own changes are in the way: a.js. Commit or put them aside, then merge again." | Commit them, or put them aside (`git stash`), then **Try again**. |
| "main changed since you looked. Have another look." or "Search cleanup’s work changed since you looked. Have another look." | Merge again (**Try again**) for a new card. |
| "Your folder is in the middle of a merge or rebase. Finish that first.", "Your folder has unresolved conflicts in a.js. Finish that first." or "Another git command is busy in your folder. Try again in a moment." | Finish what git is doing in your folder, then **Try again**. |
| "Your folder is not on a branch, so there is nowhere to merge it." | Check out a branch. |
| "Search cleanup started from a commit that is no longer in main, so merging it would bring in other work." | Your folder is on another branch now, or your branch was reset or rebased. If you switched branches, switch back to the one it started from: its detail on the git screen says which. |
| "Workbench needs git 2.38 or newer to merge." | Update git. |
| "Git does not know your name and email yet, so Workbench cannot make the merge commit. …" | Set them (below). |

One refusal is different, and says so: "Git could not finish the merge into main. Have a look at your folder before you try again." Git may have stopped part-way through updating your folder: look at it before you merge again.

**Your name and email.** The workbench makes the commits as you, with the name and email in your git config. It never uses a name git guesses, nor `GIT_AUTHOR_NAME` and the like. Without them, the terminal says so when the workbench starts ("Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: …"), the git screen says "Git does not know your name and email yet, so Workbench cannot merge.", and the middle offers no Merge. Set them, and within 15 seconds Merge is offered; there is no need to restart:

```sh
git config --global user.name "Your Name"
git config --global user.email you@example.com
```

Throwing work away does not need them.

**Throwing work away.** On the git screen, an agent's detail offers **Throw it away**, also while it works: it is stopped first. You can also type "throw away search cleanup's changes", or "discard it" and "scrap it" for the agent in the middle (or whose detail is open). It always asks first: "Throw away Search cleanup’s work?", then "Its folder and its branch workbench/search-cleanup-a1b2c3 are deleted, with 3 changed files. Workbench keeps a hidden copy in git." **Throw it away** and **Keep it** carry equal weight, and a plain "yes" is not enough: say "throw it away", "discard it" or "do it".

Afterwards its folder and branch are gone, it cannot continue, and the middle says "Search cleanup’s work was thrown away." The hidden copy is a commit at `refs/workbench/discarded/<agent id>`. It holds what a merge would have taken. Files a .gitignore hides, and folders that are git repositories of their own, are not in it: they go with the folder. The agent's id is the last part of its branch's name: `a1b2c3` in `workbench/search-cleanup-a1b2c3`. To get the work back as a branch:

```sh
git branch <name> refs/workbench/discarded/<agent id>
```

`git for-each-ref refs/workbench/discarded/` lists every hidden copy. If the agent's folder was already gone, Throw it away deletes its branch and keeps the branch's last commit as the copy.

**In the demo** the git screen shows a made-up repository, and the middle and the git screen offer no Merge or Throw it away button. Type "merge invoice export" (it merges) or "merge help pages" (it does not merge cleanly) once they are done; throwing work away works by words too. Nothing is really merged or thrown away, and the replies say so.

## Earlier agents

The workbench remembers the last 50 agents of each repository in `~/.workbench/history/`, one small file per repository (written when something meaningful changes, and when the workbench stops). Start it again on the same repository and they are back:

- They wait in the done tray, dimmed, marked “from earlier”, and are never counted as needing you. Pick one from the tray and the middle says how it ended and how long ago. If its folder may hold work not merged yet, it also offers **Review the changes**; merging that work, or throwing it away, is in its detail on the git screen.
- **Continue** (or sending it a message, or typing “continue search cleanup”) picks it up where it left off, in its own folder and with its own conversation: Claude Code resumes its session, Codex its thread. It gets a **fresh spending limit** for this run (your `--budget`), and the middle says so before you press the button.
- If its folder or conversation is gone, it still shows, says why in plain words (“Its folder is gone, so it cannot continue.”) and offers only **Forget**. So does one whose work was thrown away (“Its work was thrown away, so it cannot continue.”).
- **Forget** (or typing “forget search cleanup”) takes it out of the list after asking you first. It does not delete its folder or branch: to delete those, throw its work away first (see “Source control”).
- The file holds the task, the agent's last words, what it changed, its cost, where its folder and conversation are, and where its work went (merged, or thrown away). It holds no keys. Delete the file to forget everything. The demo keeps nothing.

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
| `rules` | Each one is checked against the files the agent changed, including new files hidden by a `.gitignore` the agent added or changed. Those show in "What changed?" too. The merge card checks them again, against what the merge would bring in. |
| `allow` | Adds command prefixes to the automatic approvals. |

The workbench reads this file from your last commit, never from an agent's copy, so an agent cannot loosen its own checks.

## Dogfooding: Workbench on its own repository

Workbench can run agents on its own repository. At the top of this repository:

```sh
npm run dogfood                            # node workbench/bin/workbench.mjs --repo .
npm run dogfood -- --budget 1 --verbose    # options go after --
```

- **Claude Code is found** in this order: `--claude <path>`, then `WORKBENCH_CLAUDE_BIN`, then `claude` on the PATH, then the newest Claude Code that the VS Code extension installed, in `~/.vscode`, `~/.vscode-insiders` or `~/.cursor`. With only the extension, nothing needs setting: the terminal says, for example, "Claude Code 2.1.322 is ready (from the VS Code extension)." (`--verbose` also prints where it is). It is looked up again at each launch, because the extension moves to a new folder with each update. A path you give that is not there is reported as it is, never swapped for another Claude Code.
- **Node on the PATH.** `npm run dogfood` itself needs node and npm. Agents and checks get node from the workbench: when the PATH it gives them has no `node`, the folder of the node running the workbench goes first, so `npm test` and `node --test` can find it.
- **Checks and rules.** This repository's `workbench.json` runs `npm test` (the whole suite, for up to 600 seconds) when an agent says it is done, and sets two rules: "Do not change the research and mockups in docs/" (the top `docs/` folder, not `workbench/docs/`) and "Add no packages" (any `package-lock.json` or `node_modules/`).
- **Git's name and email** must be set before you can merge (see "Your name and email" above). When git has none, the terminal says so at the start.
- **Merging into the folder the workbench runs from.** `npm run dogfood` runs the workbench from this folder, and a merge changes its files. Reload the page to see a merged change to the page (`ui/` and `src/shared/`). The engine runs the code it started with until you restart the workbench (Ctrl-C, then `npm run dogfood` again). One exception: Claude Code starts the permission hook, `src/adapters/claude/hook-bridge.mjs`, afresh for each step, so a merged change to it reaches running agents at once. When a change touches both the page and the engine, restart and reload.
- **An agent cannot start a live workbench.** Every agent has `WORKBENCH_AGENT_ID` in its environment, and so do the checks the workbench runs for it. With it set, `bin/workbench.mjs` refuses to start real agents ("Workbench is running inside an agent. It will not start real agents from there."), and so does `scripts/accept-real.mjs`. `--demo` still works. This guards against accidents, not against code that removes the variable on purpose.

`CLAUDE.md` at the top of this repository gives agents working on the workbench its rules.

## Safety

- The page and its programming interface listen on `127.0.0.1` only. Every request needs the run's key, and requests from other websites are refused. A link with anything after the address except this run's key (an old link, say) opens the plain page instead; a tab without the key then asks you to open the link printed in the terminal.
- Each agent gets its own key for asking permission, so one agent's key cannot ask in another agent's name, and it never opens the page's interface.
- Every agent has a spending limit (`--budget`).
- Merge and Throw it away always ask first, and check everything again when you answer. A merge goes ahead only if the agent's work and your branch are as its card showed them; otherwise it says so and changes nothing.
- Characters that hide text or change the order it reads in (zero-width and direction-changing characters, tag characters, a line break inside a name, and the like) show as marks, such as ⟦U+202E⟧ or ⏎, where an agent's or a repository's words appear: names, paths, branch names, questions, answers, replies, commit subjects and diffs.
- Stopping an agent stops any checks it is running. Stopping the workbench (Ctrl-C) stops every agent it started and every check it is running. An agent still being set up at that moment is not started, and the folder made for it is removed. A merge or throw-away under way finishes first.

## Limits (first prototype)

- Only agents started by the workbench come back (see “Earlier agents” above). Their helpers, plans and step lists are not kept, and an agent that was working when the workbench closed comes back stopped.
- Until you merge it or throw it away, each agent's work stays on your computer after the workbench stops, in its own folder under `~/.workbench/worktrees/`, on a branch named `workbench/<task>-<id>`; the terminal lists them when the workbench stops. The changes may not be committed. Folders where an agent changed nothing are removed with their branches, and so are merged agents that changed nothing since, unless you press Ctrl-C twice: then the workbench stops without tidying up, every folder stays, and the terminal lists them all. Throw it away removes a folder and its branch for you. For a folder the workbench no longer shows (an agent you forgot, say), remove it yourself: `git worktree remove <folder>`, then `git branch -D workbench/<task>-<id>`.
- A second Ctrl-C (or 12 seconds) during a merge stops waiting for it. Git still finishes the merge, but the workbench does not record it; the next Merge says the work is already in your branch.
- After an agent brings in your branch, the file counts in the middle and on its card can include your own commits, and a rule can read as broken by them. The merge card and the diff count only what the merge would bring in.
- Clean and smudge filters and merge drivers set in your git config still run during a merge.
- Sessions started outside the workbench, for example `claude` in your own terminal, do not appear.
- How far along an agent is cannot be measured honestly, so there is no percentage or finish time. The card shows elapsed time, steps, the agent's own plan and spend instead.
- Voice cannot be tested automatically. Try it in Chrome.

## For developers

- `ARCHITECTURE.md` is the contract between the parts.
- `npm test` runs the tests, here or at the top of the repository. They use recorded agent output in `test/fixtures/` and never start real agents. `test/live-fake.test.mjs` runs the whole chain (the CLI, the engine, the real permission hook, the HTTP API) with a stand-in for Claude Code that replays a recorded run, merges and throw-aways against real git included.
- `scripts/demo-e2e.mjs` walks the demo through its HTTP API.
- The page's debug switches (`static=1`, `still=1`, `pin=<agent id>`, `focus=<agent id>`) count only when the same address carries the run's `t=` key. `scripts/ui-fit-check.mjs`, `scripts/ui-behaviour-check.mjs` and `scripts/ui-shots.mjs` drive the page in headless Chrome against a stand-in API (`scripts/ui-mock.mjs`), and `scripts/ui-contrast.mjs` checks the colours of all three looks.
- `scripts/accept-real.mjs <throwaway repo> [screenshots folder] [--keep] [--claude <path>]` does one real run with Claude Code (haiku, at most $0.50) and prints PASS or FAIL for each step, merge and throw-away included. The repository needs a branch, a committed `workbench.json` with a check and a rule, and git's name and email. The merge commit stays on its branch; unless you pass `--keep`, the agent's folder, its branch and the hidden copy go at the end. It answers Allow only to the agent's own `touch` and to a helper's command that only lists or reads files; anything else is refused, and fails a step. Its header explains how to dry-run it with the stand-in first.

| Folder | Contents |
|---|---|
| `src/core/` | the engine, state, commands, permission policy, worktrees and git, receipts |
| `src/adapters/` | Claude Code, Codex and the simulator |
| `src/server/` | the local web server |
| `src/shared/` | code used by both the engine and the page |
| `ui/` | the page; no build step |
