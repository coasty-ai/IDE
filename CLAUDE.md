# Workbench

Workbench is a local program that runs coding agents (Claude Code, and Codex when it is installed), each in its own git worktree, and shows a person what each agent and its helpers are doing, in plain language. The person answers by typing or talking. The program is in `workbench/`; `docs/` holds the research and mockups it was designed from.

## Where things are

- `workbench/ARCHITECTURE.md` is the contract between the parts. It must describe the code as it is: change it in the same commit as the code.
- `workbench/README.md`: what a person sees, and how to run it.
- `workbench/src/core/`: engine, store, history, commands, permission policy, worktrees and git, receipts, the key store and Agents & keys (`keys.mjs`, `connect.mjs`, `terminal.mjs`). `workbench/src/adapters/`: Claude Code, Codex, the simulator. `workbench/src/server/`: the local web server. `workbench/src/shared/`: code the page loads too. `workbench/ui/`: the page, with no build step.
- `workbench/test/`: one `<module>.test.mjs` per module; stand-ins for Claude Code, Codex, macOS's `security` and Linux's `secret-tool` in `test/helpers/`.
- `workbench/app/mac/`: the Mac app, a window around the page, with Node and Workbench inside (Swift; not part of `npm test`).

## Rules

- Node 22 or later, ES modules, no third-party packages: only `node:` built-ins. Add no packages and no lock files.
- `workbench/src/shared/` must not import `node:` modules: the page loads those files as they are.
- Plain language in anything a person sees: whole sentences built from facts (paths, branch names, counts). Never identifiers, and never git's own error text.
- Every child process gets an argument array, never a shell string. There are two exceptions. The first is the checks in `workbench.json`: commands the repository's owner wrote, run with `/bin/sh -c`. The second is the two agent installers in `workbench/src/core/connect.mjs`, `curl -fsSL https://claude.ai/install.sh | bash` and `curl -fsSL https://chatgpt.com/codex/install.sh | sh`: fixed lines Workbench carries, which Terminal runs as `/bin/sh -c <line>` when the person presses Install. Never build a shell line from anything a person or an agent typed. Every git call goes through `git()` in `workbench/src/core/workspace.mjs`, or through `gitStream()` beside it for clones.
- GitHub's command-line tool, `gh`, is the one program Workbench downloads itself: from GitHub's releases (`https://github.com/cli/cli/releases`), checked against the release's published SHA-256 checksums and, on macOS, GitHub's signature (team VEKTX9H2N7), into `~/.local/bin/gh` (`workbench/src/core/github.mjs`). Tests use the stand-in `workbench/test/helpers/gh-fake.mjs`, never a real `gh`: set `WORKBENCH_GH_BIN` in every test environment that reaches Connect.
- Workbench's own temporary files go in a folder from `privateTemp()` (`src/core/workspace.mjs`: `~/.workbench/tmp`, mode 0700), never in the system's temporary folder (`os.tmpdir()`, `$TMPDIR`), which a Codex agent's sandbox can write. Tests may use the system's temporary folder for their own fixtures.
- The page's key never goes on a command line, and the page has no fixed address: each run picks a free port unless `--port` is given.
- Keys (API keys, tokens, cloud keys) never go in a log, an argv, an address or a test fixture. Show a secret only as "•••• " and its last four characters, or as "••••" when it is short. A test that needs a key-shaped value builds it from parts at run time.
- Escape everything an agent controls before it reaches the page (paths, diffs, commit subjects, branch names), and show control, bidirectional and zero-width characters as visible symbols.
- Buttons carry what they were drawn for (`data-agent`, `data-state`, `data-confirm`, `data-work`); the engine checks everything again when it acts.
- Tests use `node:test` and `node:assert/strict`, need no network, use temporary folders and a temporary HOME, and never start a real `claude` or `codex` (use the stand-ins). They never depend on the machine's git identity: set `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, or pass `-c user.name=… -c user.email=…`. Workbench's own merge reads `user.name` and `user.email` from git config only, never from `GIT_AUTHOR_*`: a test that merges sets them in its temporary repository, or in a `GIT_CONFIG_GLOBAL` file of its own.
- Tests never touch the real keychain or keyring: they use the stand-ins for `security` and `secret-tool` (`test/helpers/security-fake.mjs`, `test/helpers/secret-tool-fake.mjs`). A test that makes git keep or forget a sign-in sets `GIT_CONFIG_NOSYSTEM=1` and a `GIT_CONFIG_GLOBAL` of its own: on a Mac, git's system config hands sign-ins to the login keychain. A test never reaches GitHub: it gives Connect a `fetchJson` of its own, or runs the CLI's GitHub helpers only with nothing that would be sent. No test adds a key through `workbench/bin/workbench.mjs`, whose key store uses `/usr/bin/security`.
- Do not change the research and mockups in `docs/`.

## Running things

- Run the tests with `npm test` at the repo root (a minute or so), and before you say you are done. Type exactly `npm test`, with nothing before or after it (no `cd … &&`, no `2>&1`, no `| tail`): that exact command is approved without asking, and anything added to it makes Workbench stop and ask the person. Its output is already short enough.
- `node` (22 or later) and `npm` must be on the PATH. When it has no node, Workbench puts its own there for its agents and checks; in a shell of your own, put the `bin` folder of a Node install in front of `PATH` first.
- `npm run demo` starts Workbench with simulated agents; nothing is spent.
- The page checks need Chrome (set `CHROME_BIN` when it is not in the usual place) and are not part of `npm test`. From `workbench/`: `node scripts/ui-behaviour-check.mjs`, `node scripts/ui-fit-check.mjs`, `node scripts/ui-shots.mjs <folder>`.
- The Mac app: `bash workbench/app/mac/build.sh --no-dmg` builds it into `workbench/dist/` (it needs the Xcode command line tools), and `workbench/dist/Workbench.app/Contents/MacOS/Workbench --demo --self-test` checks it: its window comes in front of the person's for a few seconds, and it exits with 0 when the page drew. `--install` is refused inside an agent: it would replace the app the person may be using.
- Never start a live Workbench (`npm run dogfood`, or `workbench/bin/workbench.mjs --repo …`) or `workbench/scripts/accept-real.mjs` from inside an agent: they start real Claude Code agents on the owner's login and spend money. Both refuse when `WORKBENCH_AGENT_ID` is set. Leave them to the owner.
- `workbench/bin/workbench.mjs --clone …`, `--connect-github`, `--github-signin`, `--github-status` and `--github-repos` refuse inside an agent too: they reach the owner's keychain and GitHub account. Leave anything that reads or writes the real keychain to the owner.
