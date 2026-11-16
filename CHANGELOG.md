# Changelog

## Unreleased

- **Every prompt goes to an agent.** Anything you type or say that is not one of Workbench's own commands (stop, what needs me, status, merge, throw away, forget, Full permissions), or an answer to what is on screen, starts an agent at once, exactly as you wrote it: "thanks", "hi", "how are you", a question about the project and pasted code with its first and last lines all go. Say it to Codex or Claude by name ("codex, …", "codex who are you?", "ask codex to …", "ask claude which tests are flaky") and only the name comes off: "please", "thanks", "which" and "that" go too, and so does an emoji ("codex 👍"). The same words said again start another agent, even while the first still works, and words that only share a few with an agent's task no longer show that agent instead. "status" is the status even while an agent asks you something, "never mind, stop" stops the agent in the middle, and pasted code that begins with `stop()` is a prompt like any other. There is no launch question any more, with Full permissions on or off; a line under the board says what started, and a card in the middle stays where it is. Workbench no longer answers "I did not catch that". The input is a box that grows with its text: Enter sends, Shift+Enter adds a line. Text too long to send in one go (more than 64 KB) stays in the box, and the line under the board says so; on the git screen too, whose input now keeps a paste's lines, and keeps words a failed request did not send; "um" or "hmm" alone, said aloud, sends nothing. The input's focus ring now shows in the ivory look too.
- **Full permissions.** A button in the top band, beside Agents & keys, for when you want agents to stop asking. Turning it on asks first ("Let agents do anything without asking?"), and the questions already waiting are allowed too. While it is on, it is lit amber and every step that would wait for your OK runs, counted as an automatic approval. Changes to Claude Code's own settings, and helpers that would work elsewhere, are refused: edits are checked, and commands only on a best-effort basis (a patch such as `git apply`, code an interpreter runs, and names built at run time can get past it). A command is refused for what it would write there, so reading those settings, copying them elsewhere or mentioning them runs. It stays on across restarts, and Workbench says so when it starts; pressing it again, or saying "ask first", turns it off at once. "full permissions", "stop asking" and "allow everything" ask for it in words. In the demo it lasts for that run only.

## 0.2.0 (2026-11-14)

- **Agents & keys.** A panel on the page that helps install Claude Code and Codex, signs them in through the browser or gives them an API key, and picks the agent for new work. An agent connected while Workbench runs takes work at once, and earlier agents that used it can be continued again.
- **The key store.** Keys you give agents are kept in the login keychain on a Mac (on Linux, a keyring or private files). They reach only the agents you choose and their checks, show only as their last four characters, are hidden in everything agents print, and are never sent from the board's input.
- **GitHub and cloning.** Sign in to GitHub with no token, through GitHub's own `gh`, which Workbench downloads and checks itself. Clone a repository with `--clone` or from the Mac app, private ones included. Where `gh` cannot run, a token works instead.
- **Git in an agent's folder.** Agents may run git's own commands in their own folder, Codex agents too. Git that reaches past an agent's work, such as a force push, waits for your OK and says what it would change. Agents & keys saves git's name and email, which merging needs.
- **Free text starts work.** Anything you type that says what you want, such as "the login page is broken" or "why is the build slow?", becomes a new agent's task once you say yes. Say an agent's name to pick it.
- **The Mac app** clones repositories, lists your GitHub repositories, signs you in to GitHub, and offers to install git. With no agent ready, it opens the board anyway, and Agents & keys helps.
- **More spending limit, in place.** A Claude Code agent stopped by its spending limit can be given one more limit for this run (**Give it $2.00 more**), and it continues where it left off. Before, it could go on only after Workbench was started again.
- **A release you can sign.** The Mac app's build can sign it with a Developer ID, with the hardened runtime, and have Apple notarize it. The app carries the licenses of Node, npm and its typeface, and every disk image comes with a SHA-256 checksum.
- **Words that match what happens.** A Codex agent's launch card no longer promises a spending limit Codex does not have, and Agents & keys says which name and email merges use when a repository has its own.
- **Security review before release.** A fresh review reproduced each issue against the real code, and each is fixed and pinned by tests:
  - Permissions: zsh's `=program` words and wildcards that reach through links no longer slip past the checks. Git that reaches other working copies, other repositories' addresses, patches (`git apply`, `git am`), `git replace`, upkeep that deletes for good and settings outside the folder now waits for your OK. Claude Code's protected files are known by name the way the Mac's disks compare names.
  - The page: each run serves it on a free port picked at random, so nothing another program left at an earlier address applies; the Mac app's web view keeps nothing between runs. Your look and detail are kept in `~/.workbench/prefs.json` instead. The page's key is never on a command line.
  - Files: Workbench keeps its temporary files in a private folder under `~/.workbench`, runs its own merges with no git hooks, installs the very `gh` it checked, and makes agents' folders private to your account.
- **Tests on every push.** GitHub runs `npm test` on Linux with Node 22, 24 and 26.
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
