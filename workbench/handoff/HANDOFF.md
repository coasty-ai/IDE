# Handoff: source control and dogfooding

This note is for the Claude Code session that continues this work in the cloud (Claude Code on the web). The owner started it on their laptop and went offline. Everything below `workbench/handoff/` is temporary: delete it before this branch is merged anywhere.

## The owner's request

> "Finish building the git source control stuff and make sure this is ready for dogfooding and building it even more!"

Today each agent works in its own git worktree, on a branch named `workbench/<slug>-<id>`. The page offers no way to see the work, merge it or throw it away. The owner's design for the git part, in their words:

> "So most don't do git manually anymore, so it's handled by the agents obviously. There should be a DRAM looking object connected to the core in the main page which has the word git on it. And when you click it, it scrolls down by going through a wire that goes from the DRAM to the bottom, where it ends up in the git source control screen, where there is a graph tree connected by circuit lines, just like how the VS Code git source control graph is, but it branches downwards and spreads out."

Decisions already made:

- **Merge style: a merge commit.** The agent's work becomes a commit on its own branch, and a merge commit joins it into the owner's current branch. The graph then shows each agent's branch joining back.
- **Newest commits at the top**, where the wire arrives. This is an interpretation, so keep it one constant (`NEWEST_AT_TOP`).

## Where things are

| | |
|---|---|
| Branch | `source-control`, made from `cloud-build` (the earlier work, 541 tests). `main` holds only the initial commit. Do not merge into `main`, do not push to `main`, and do not open a pull request unless the owner asks. |
| The spec | **`workbench/SPEC-source-control.md`**: the interface every builder builds against, with each builder's files. Read it first. It is folded into `ARCHITECTURE.md` at the end. |
| Code notes | `workbench/handoff/maps/*.json`: six reader maps of the current code (git and worktrees, engine, words, the lid, the UI checks, the server, CLI and Claude adapter). They hold verified git behaviour, such as `merge-tree` output formats and data-loss traps, plus risks and open questions. Line numbers are approximate, and paths start at `/Users/nkov47/IDE/`. |
| Builder briefs | `workbench/handoff/builders.md`: the exact prompts used to start the seven builders. |
| Baseline | `workbench/handoff/baseline.md`: test and Chrome-check results on the unchanged code. |

## Status

- **Done:** reading the code; the spec; a baseline on Linux with Chrome 157 (541/541 tests; behaviour check 57/57).
- **Built partway:** seven builders ran on the laptop and were stopped mid-work for the move to the cloud. None of them got to report. Each one's work is pushed to its own branch, made from this branch at `1769f75`. A commit starting "WIP" holds edits made after the builder's last commit; they are unfinished and untested.

| Branch | Builder | State when stopped |
|---|---|---|
| `wip/source-control/A-git-core` | A: `workspace.mjs` and its tests | one full commit (all six functions), then WIP |
| `wip/source-control/B-engine-server` | B: engine, store, history, events, server and tests | one full commit, then WIP |
| `wip/source-control/C-words` | C: `commands.mjs` and its tests | two commits, nothing left unsaved: probably close to done |
| `wip/source-control/D2-lid-checks` | D2: lid, confirm cards, API, mock merge routes | one commit: the behaviour-check part is probably not done |
| `wip/source-control/E-dogfood` | E: CLI, Claude adapter, root `package.json`, `workbench.json`, `CLAUDE.md` | one commit, nothing left unsaved: probably close to done |
| `wip/source-control/D1-git-screen` | D1: git screen | WIP only: early `ui/gitgraph.js`, `ui/diffview.js` and its test. The DRAM, the transition and the screen itself are not started |
| `wip/source-control/F-demo` | F: simulator | WIP only: early `simulator.mjs` changes, no tests |

For each branch:

1. Check it out.
2. Run `cd workbench && npm test`.
3. Compare it against its section of the spec.
4. Finish it.

Then integrate, as described below. D1 is the biggest piece of work left.

## What to do next

1. **Finish the builders' branches**, as listed under "Status": start from their `wip/source-control/*` branches, not from scratch. Each builder owns disjoint files, as the spec lists them:
   - A: git core
   - B: engine, store, history and server
   - C: words
   - D1: the git screen, the DRAM and the transition
   - D2: the lid, the confirm cards and the checks
   - E: dogfooding
   - F: the demo

   Use the prompts in `builders.md`, adjusted for this machine (see "This environment" below). Each builder works in its own worktree and commits.
2. **Integrate** in the order A, F, C, E, B, D1, D2:
   - `ui/app.js`, `ui/app.css` and `scripts/ui-mock.mjs` take additions from both D1 and D2;
   - apply every builder's "needs";
   - then add `test/live-fake.test.mjs` cases for merge and throw-away against real git, through the real CLI.
3. **Verify:**
   - `npm test`, on Node 22, 24 and 26 if available;
   - the Chrome checks (`node scripts/ui-behaviour-check.mjs`, `node scripts/ui-fit-check.mjs`, with `CHROME_BIN` set);
   - screenshots (`node scripts/ui-shots.mjs /tmp/shots`). **Look at them**: the DRAM and the git screen must belong to the same circuit board as `workbench/docs/screens/board-*.png`.
4. **Review adversarially**, then fix what survives verification:
   - git data safety, from the risks in `maps/git-core.json`;
   - engine races and lifecycle, from `maps/engine.json`;
   - words that hijack work or answers, from `maps/commands.json`;
   - the UI contract (binding, guard, fit, accessibility, three looks, contrast);
   - security: escaping, bidirectional and zero-width characters, the nested-Workbench hole, the environment scrub;
   - dogfooding readiness.
5. **Docs:**
   - fold the spec into `workbench/ARCHITECTURE.md`, which must match the code;
   - update `workbench/README.md`: the git screen, merge and throw away, and a "Dogfooding" section;
   - add a line to `workbench/CLOUD_PROGRESS.md`;
   - delete `SPEC-source-control.md` and `handoff/`.
6. **Commit and push** to this branch, or your session's branch. Leave the Mac-only steps below for the owner's laptop.

## Rules from the owner and the codebase

- **No third-party packages.** Node built-ins only, as `ARCHITECTURE.md` says. Plain language in everything a person sees.
- **Tests:** never start a real `claude` or `codex`, and never depend on a git identity. Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in tests.
- **Commits:** never change git config. Author commits as `Workbench cloud builder <builder@workbench.local>`, through `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **AWS:** do not use AWS from this session. No keys are here, and the owner's rule is to use only a scoped IAM key that lives on their laptop. Never put Claude credentials on any machine.

## This environment

- The builder briefs point at the laptop: Node under `~/.local/opt/...`, a sandbox helper `~/.workbench-ide-aws/sbx`, and maps in `/tmp/wb-maps`. Here, use the Node on PATH, take the maps from `workbench/handoff/maps/`, and run the Chrome checks locally if you can install Chrome or Chromium. If you cannot, say so plainly in your report, and leave them for the laptop.
- Do not create sandboxes.

## Mac-only steps, for when the owner is back on the laptop

- **Dogfooding start:**
  - `npm run dogfood` at the repo root (builder E adds it), with Claude Code found in the VS Code extension: `~/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude`;
  - Node is not on PATH there (`~/.local/opt/node-v26.13.1-darwin-arm64/bin`);
  - git has no `user.name` or `user.email`, so Workbench must say so, and merge must refuse plainly until the owner sets them.
- **Acceptance:**
  - one real run of `scripts/accept-real.mjs` against a throwaway repo, with Claude Code 2.1.322 (haiku, at most $0.50), including merge and throw-away;
  - this also checks that the permission hook still fails closed on 2.1.322;
  - plus a stop-then-continue run, to settle whether 2.1.322 restores spend totals on `--resume` (the spec gates `_withEarlierSpend` on the version).

## Known risks found while reading (all in the maps)

- **Data-loss traps a plain `git merge` falls into:**
  - it overwrites ignored files such as `.env`;
  - `merge.autoStash` writes conflict markers;
  - a detached HEAD "succeeds" onto no branch;
  - hooks, filters and drivers planted in the shared `.git`.

  The spec's `mergeWork` steps avoid them. Keep them.
- **Nested Workbench:** an agent working on this repo can run `node bin/workbench.mjs` or `accept-real`, which are auto-approved, and start real agents on the owner's login. The spec's section 5 closes this.
- **Claude Code 2.1.322:**
  - new tools need adding to `--disallowedTools`: `SendFile`, `SendToProject`, `PublishPlugin`, `ListAgents`, `WrapUp`;
  - continuing an earlier agent counts its spend twice;
  - `--permission-mode default` is still accepted.
- **The engine:**
  - any confirm kind it does not know falls into the launch path and crashes on `c.tasks`;
  - the parser treats "start it" as a yes to every card.
