# Contributing

Workbench is plain Node: no packages and no build step. These are the rules from [CLAUDE.md](CLAUDE.md), written for people.

## Run the tests

At the top of the repository:

```sh
npm test
```

It takes about a minute, needs no network, and never starts a real Claude Code or Codex. Run it before you send a change.

## Run the page checks

They are not part of `npm test`. The first three drive the page in headless Chrome against a stand-in API, so they need Chrome: set `CHROME_BIN` when it is not in the usual place. From `workbench/`:

```sh
node scripts/ui-behaviour-check.mjs   # what the page does
node scripts/ui-fit-check.mjs         # text fits, at every size and in every look
node scripts/ui-shots.mjs <folder>    # screenshots of each look and view
node scripts/ui-contrast.mjs          # contrast of every colour, in all three looks
```

## Rules

- **No packages.** Node 22 or later, ES modules, and only `node:` built-ins. Add no dependencies and no lock files. Files in `workbench/src/shared/` must not import `node:` modules, because the page loads them as they are.
- **Plain language in anything a person sees.** Whole sentences built from facts, such as paths, branch names and counts. No identifiers, and never git's own error text.
- **ARCHITECTURE.md changes with the code.** [workbench/ARCHITECTURE.md](workbench/ARCHITECTURE.md) is the contract between the parts, and must describe the code as it is. Change it in the same commit.
- **Tests use stand-ins and temporary folders.** Use `node:test` and `node:assert/strict`, a temporary folder and a temporary HOME, and no network. A test sets git's name and email itself, and never relies on yours.
- **Never start real agents in tests.** Use the stand-ins in `workbench/test/helpers/` for Claude Code, Codex, GitHub's `gh`, macOS's `security` and Linux's `secret-tool`. No test touches the real keychain, a keyring or GitHub.
- **Keys stay out** of logs, command lines, addresses and test fixtures. A test that needs a key-shaped value builds it from parts as it runs.
- **Child processes get an argument array**, never a shell line built from what a person or an agent typed. Every git call goes through `git()` in `workbench/src/core/workspace.mjs`.
- Leave the top-level `docs/` folder, the research and mockups, as it is.

`npm run dogfood` and `workbench/scripts/accept-real.mjs` start real Claude Code agents on your own account, and `workbench/scripts/keychain-check.mjs` uses your real keychain. Run them yourself, never from a test or an agent.

Write each commit message as one plain sentence that says what changed, like the rest of the git log.

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, never in a public issue.
