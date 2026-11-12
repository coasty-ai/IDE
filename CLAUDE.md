# Workbench

Workbench is a local program that runs coding agents (Claude Code, and Codex when it is installed), each in its own git worktree, and shows a person what each agent and its helpers are doing, in plain language. The person answers by typing or talking. The program is in `workbench/`; `docs/` holds the research and mockups it was designed from.

## Where things are

- `workbench/ARCHITECTURE.md` is the contract between the parts. It must describe the code as it is: change it in the same commit as the code.
- `workbench/README.md`: what a person sees, and how to run it.
- `workbench/src/core/`: engine, store, history, commands, permission policy, worktrees and git, receipts. `workbench/src/adapters/`: Claude Code, Codex, the simulator. `workbench/src/server/`: the local web server. `workbench/src/shared/`: code the page loads too. `workbench/ui/`: the page, with no build step.
- `workbench/test/`: one `<module>.test.mjs` per module; stand-ins for Claude Code and Codex in `test/helpers/`.
- `workbench/app/mac/`: the Mac app, a window around the page, with Node and Workbench inside (Swift; not part of `npm test`).

## Rules

- Node 22 or later, ES modules, no third-party packages: only `node:` built-ins. Add no packages and no lock files.
- `workbench/src/shared/` must not import `node:` modules: the page loads those files as they are.
- Plain language in anything a person sees: whole sentences built from facts (paths, branch names, counts). Never identifiers, and never git's own error text.
- Every child process gets an argument array, never a shell string. The one exception is the checks in `workbench.json`: commands the repository's owner wrote, run with `/bin/sh -c`. Every git call goes through `git()` in `workbench/src/core/workspace.mjs`.
- Escape everything an agent controls before it reaches the page (paths, diffs, commit subjects, branch names), and show control, bidirectional and zero-width characters as visible symbols.
- Buttons carry what they were drawn for (`data-agent`, `data-state`, `data-confirm`, `data-work`); the engine checks everything again when it acts.
- Tests use `node:test` and `node:assert/strict`, need no network, use temporary folders and a temporary HOME, and never start a real `claude` or `codex` (use the stand-ins). They never depend on the machine's git identity: set `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, or pass `-c user.name=… -c user.email=…`. Workbench's own merge reads `user.name` and `user.email` from git config only, never from `GIT_AUTHOR_*`: a test that merges sets them in its temporary repository, or in a `GIT_CONFIG_GLOBAL` file of its own.
- Do not change the research and mockups in `docs/`.

## Running things

- Run the tests with `npm test` at the repo root (a minute or so), and before you say you are done. Type exactly `npm test`, with nothing before or after it (no `cd … &&`, no `2>&1`, no `| tail`): that exact command is approved without asking, and anything added to it makes Workbench stop and ask the person. Its output is already short enough.
- `node` (22 or later) and `npm` must be on the PATH. When it has no node, Workbench puts its own there for its agents and checks; in a shell of your own, put the `bin` folder of a Node install in front of `PATH` first.
- `npm run demo` starts Workbench with simulated agents; nothing is spent.
- The page checks need Chrome (set `CHROME_BIN` when it is not in the usual place) and are not part of `npm test`. From `workbench/`: `node scripts/ui-behaviour-check.mjs`, `node scripts/ui-fit-check.mjs`, `node scripts/ui-shots.mjs <folder>`.
- The Mac app: `bash workbench/app/mac/build.sh --no-dmg` builds it into `workbench/dist/` (it needs the Xcode command line tools), and `workbench/dist/Workbench.app/Contents/MacOS/Workbench --demo --self-test` checks it. `--install` is refused inside an agent: it would replace the app the person may be using.
- Never start a live Workbench (`npm run dogfood`, or `workbench/bin/workbench.mjs --repo …`) or `workbench/scripts/accept-real.mjs` from inside an agent: they start real Claude Code agents on the owner's login and spend money. Both refuse when `WORKBENCH_AGENT_ID` is set. Leave them to the owner.
