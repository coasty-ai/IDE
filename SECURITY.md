# Security

## Report a vulnerability

Report it privately: on GitHub, open this repository's **Security** tab and press **Report a vulnerability** ([the form](https://github.com/coasty-ai/IDE/security/advisories/new)). Only the maintainers see your report.

Never report a vulnerability in a public issue, pull request or discussion.

## Threat model

- **The page is local.** The page and its API listen on 127.0.0.1 only. The API needs a key made for this run, and refuses requests from other websites. Each Claude Code agent asks for permission with a key of its own, which cannot open the API.
- **Agents run as you.** Their commands can do anything you can. Test runners and scripts in an agent's folder run without asking, and may run code the agent wrote. An agent's git can move your branches and delete your tags, which the whole repository shares.
- **Permissions.** Claude Code agents ask Workbench before every step, and the step is blocked if Workbench cannot be reached. Reading, editing and git in their own folder, and a few safe commands, run at once; anything else waits for your OK. Codex agents never ask: they run in Codex's own sandbox, with the network on and the repository's git folders writable.
- **Full permissions** remove your check before steps: while they are on, everything that would wait for your OK runs at once, except a step that names Claude Code's own settings, which still asks. Workbench still refuses edits to those settings, and helpers that would work elsewhere, but that floor is only what its check can read: edits are checked, and commands only on a best-effort basis (a patch such as `git apply`, code an interpreter runs, and names built at run time can reach those settings without naming them, as can a name the shell puts together from escapes or ranges, such as `$'\x2eclaude'` or `{.,.}claude`), and code an agent runs can do anything you can. They stay on across restarts, until you turn them off, and Workbench says so when it starts. The choice is kept in `~/.workbench/prefs.json`; a script an agent runs can write that file like any other of yours, as such scripts can already do anything you can. Turning them on through Workbench always asks first, and needs the page's key, which agents never have.
- **Git settings.** So a Codex agent can change the repository's git settings and hooks. Git runs those settings (a filter, say) and hooks as you, outside any sandbox, whenever it works in the repository, and Workbench's own git is no exception: Workbench checks your folder with git every 15 seconds, and runs git at the end of each agent's turn and when it shows, merges or throws away an agent's work. Such a setting can therefore run a program as you within seconds, with no click from you. Workbench turns off `core.fsmonitor` for all of its git, and hooks for its reviews, merges and throw-aways, but not filters.
- **Temporary files.** Workbench keeps its own temporary files (scripts it opens in Terminal, the download of GitHub's `gh`, git's scratch files) in `~/.workbench/tmp`, a private folder, and never in the system's temporary folder, which Codex agents can write.
- **Keys.** Keys you give agents are kept in your login keychain (on Linux, a keyring or private files), never in a log, a command line or the history, and the page shows only their last four characters. Agents can read the keys you give them, and so can anything they run.
- **Agents' copies.** Each agent's copy of your repository gets the files git ignores that it needs to run: your `.env` files, keys included, and `node_modules`, or what a `.worktreeinclude` file lists, copied from your folder. The agent and anything it runs can read those keys. Values in the copied env files are hidden in what agents print, on the page and in the log, the same way as the keys you give agents. Values that cannot be secrets (plain words, numbers and addresses such as `production` or `localhost:3000`) are not, unless the variable's name says it holds one (`DB_PASSWORD`).
- **The setup command.** A repository's `workbench.json` may name a setup command, such as `npm ci`. It runs as you, in each new agent's copy before the agent starts, only after you say Run it to it, and Workbench asks again whenever it changes.

## Out of scope

- What an agent, or code it runs, does with your rights: Workbench is not a sandbox. To keep agents away from your own files, run Workbench on a separate machine, such as a cloud VM.
- Other programs that run as you on the same computer. They can read your agents' environments, and the keys in them.
- What the repository you open sets up: the checks in its `workbench.json` run as shell commands, so does its setup command once you said Run it, and its committed `.claude/` settings load into agents.
- Bugs in Claude Code, Codex, git, GitHub's `gh` or your browser. Report those to their makers.
- The demo, whose agents and machines are simulated.

The details are in [workbench/README.md](workbench/README.md) ("Safety") and [workbench/ARCHITECTURE.md](workbench/ARCHITECTURE.md).
