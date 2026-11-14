# Changelog

## 0.2.0 (release candidate)

- **Agents & keys.** A panel on the page that helps install Claude Code and Codex, signs them in through the browser or gives them an API key, and picks the agent for new work. An agent connected while Workbench runs takes work at once, and earlier agents that used it can be continued again.
- **The key store.** Keys you give agents are kept in the login keychain on a Mac (on Linux, a keyring or private files). They reach only the agents you choose and their checks, show only as their last four characters, are hidden in everything agents print, and are never sent from the board's input.
- **GitHub and cloning.** Sign in to GitHub with no token, through GitHub's own `gh`, which Workbench downloads and checks itself. Clone a repository with `--clone` or from the Mac app, private ones included. Where `gh` cannot run, a token works instead.
- **Git in an agent's folder.** Agents may run git's own commands in their own folder, Codex agents too. Git that reaches past an agent's work, such as a force push, waits for your OK and says what it would change. Agents & keys saves git's name and email, which merging needs.
- **Free text starts work.** Anything you type that says what you want, such as "the login page is broken" or "why is the build slow?", becomes a new agent's task once you say yes. Say an agent's name to pick it.
- **The Mac app** clones repositories, lists your GitHub repositories, signs you in to GitHub, and offers to install git. With no agent ready, it opens the board anyway, and Agents & keys helps.
- **Fixes.** Codex agents start when Workbench runs with `--model`, which now names only the Claude model. A slow check for passwords in pasted links made `npm test` fail on a busy Mac; it now takes milliseconds. An agent that fails after it started is now in the log, with the reason.

## 0.1.0

The first preview, for the Mac.

- The board: each agent is a chip on its own lane, and the middle shows what needs you, in plain language. You answer by typing, or by holding the space bar to talk.
- Claude Code and Codex agents, each in its own git worktree and branch. Claude Code agents wait for your OK before anything beyond safe work in their own folder, and have a spending limit.
- Source control: the git screen draws your branch and your agents' branches. Review an agent's changes, then merge them into your branch or throw them away; a hidden copy stays in git.
- Earlier agents come back when Workbench starts again, and can be continued or forgotten.
- Checks and rules in `workbench.json`, run on an agent's work when it is done.
- The Mac app: Workbench in its own window, with Node inside.
- A demo with simulated agents and machines, where nothing is spent.
