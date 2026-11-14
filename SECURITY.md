# Security

## Report a vulnerability

Report it privately: on GitHub, open this repository's **Security** tab and press **Report a vulnerability** ([the form](https://github.com/coasty-ai/IDE/security/advisories/new)). Only the maintainers see your report.

Never report a vulnerability in a public issue, pull request or discussion.

## Threat model

- **The page is local.** The page and its API listen on 127.0.0.1 only. The API needs a key made for this run, and refuses requests from other websites. Each Claude Code agent asks for permission with a key of its own, which cannot open the API.
- **Agents run as you.** Claude Code and Codex run with your rights, so their commands can do anything you can. Test runners and scripts in an agent's folder run without asking, and they may run code the agent wrote.
- **Permissions.** Claude Code agents ask Workbench before every step. Reading, editing and git in their own folder, and a short list of safe commands, run at once; anything else waits for your OK. If Workbench cannot be reached, the step is blocked. Edits to Claude Code's own settings are refused. Codex agents never ask: they run in Codex's own sandbox, with the network on and the repository's git folders writable.
- **Keys.** Keys you give agents are kept in your login keychain (on Linux, a keyring or private files). They never go into a log, a command line or the history, and the page shows only their last four characters. Agents can read the keys you give them, and so can anything they run.
- **Git.** Each agent has its own worktree and branch. Merging and throwing work away always ask first. Branches, tags and stashes are shared by the whole repository, so an agent's git can move your branches and delete your tags.
- **What agents say.** Everything an agent controls is escaped before it reaches the page, and characters that hide text or change its direction show as marks.

## Out of scope

- What an agent, or code it runs, does with your rights. Workbench shows agents and holds what they ask, but it is not a sandbox. To keep agents away from your own files, run Workbench on a separate machine, such as a cloud VM.
- Other programs that run as you on the same computer. They can read your agents' environments, and the keys in them.
- What the repository you open sets up: the checks in its `workbench.json` run as shell commands, and its committed `.claude/` settings load into agents.
- Bugs in Claude Code, Codex, git, GitHub's `gh` or your browser. Report those to their makers.
- The demo, whose agents and machines are simulated.

The details are in [workbench/README.md](workbench/README.md) ("Safety") and [workbench/ARCHITECTURE.md](workbench/ARCHITECTURE.md).
