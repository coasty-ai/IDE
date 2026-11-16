# Workbench

This is an early release: "Limits", below, says what is not in it yet.

A place to run coding agents and see, in plain language, what each one and its helpers are doing. You answer what they need by typing or talking. When an agent is done, you look at its changes, then merge them into your branch or throw them away.

It does not replace your editor: it sits beside it.

## Run it

You need Node 22 or later. There is nothing to install. Merging an agent's work also needs git 2.38 or later.

```sh
cd workbench
npm run demo                       # simulated agents and machines; nothing is spent
npm start -- --repo ~/code/myapp   # real agents on your own git repository
npm start -- --clone https://github.com/owner/repo --into ~/Developer   # copy a repository first, then run agents on it
```

The terminal prints a link like `http://127.0.0.1:52817/?t=…`. Open it in Chrome, which is needed for voice; it opens by itself unless you pass `--no-open`. The port is a free one, new each run, and the `t=` part is a key that only this run knows.

Workbench starts even when neither Claude Code nor Codex is ready. It says "No coding agent is ready yet. Open the page to connect one.", and **Agents & keys** on the page helps you install one, sign in, or give it an API key (see "Agents & keys" below).

`--clone` copies the repository into a new folder in `--into` (the current folder unless you say), showing git's progress, then runs agents on the copy. Ctrl-C while it copies stops it, and removes what it had copied. To clone a private repository, git must be able to sign in to it: sign in to GitHub first, in Agents & keys or in the Mac app's clone sheet.

Options for real agents:

| Option | Meaning |
|---|---|
| `--repo <path>` | the git repository agents work on (this, or `--clone`, is required) |
| `--clone <address>` | copy this repository first, like `https://github.com/owner/repo` or `git@github.com:owner/repo.git`, then work on the copy |
| `--into <folder>` | where `--clone` puts the copy (default: the current folder) |
| `--budget 2` | each agent's spending limit for a run, in US dollars (default 2). An agent that reaches it can be given as much again (see "The spending limit" below) |
| `--model <name>` | the Claude model to use, for example `sonnet` or `haiku`. Codex agents keep Codex's own model |
| `--claude <path>` | the Claude Code program to run. Without it: `WORKBENCH_CLAUDE_BIN`, then `claude` on the PATH, then the newest Claude Code extension in VS Code, VS Code Insiders or Cursor |
| `--port <n>` | where the page is served. Without it, a free port, new each run (see "Safety"). A port you choose is refused while another program answers on it |

## The Mac app

Workbench is also a Mac app, for Apple silicon and macOS 13.5 or later. From the top of this repository, `bash workbench/app/mac/build.sh --install` (or `npm run app`) builds it and puts `Workbench.app` in your Applications folder. It also leaves `Workbench-<version>-arm64.dmg` in `workbench/dist/`, to copy to another Mac. Building needs the Xcode command line tools (`xcode-select --install`). The first build downloads Node from nodejs.org and checks it against its published checksum. To install a new build, quit the app first.

- **Open it like any app.** Its first window offers Clone Repository…, Open Folder… and Try the Demo, and lists the folders you opened lately. File → Clone Repository… (⇧⌘O), File → Open Folder… (⌘O), File → Open Recent, and dropping a folder on its icon do the same. It starts Workbench on that git repository and shows the board in its own window. It works on one folder at a time: opening another stops the first folder's agents, after asking.
- **Clone a repository.** Paste its address, or pick one of your repositories on GitHub from the list (type to narrow it); the list appears once you are signed in to GitHub. The repository goes in `~/Developer` unless you choose another folder with Choose…, and the app remembers your choice. You see git's progress ("Downloading owner/repo: 45%"), then the board on the new folder, which also goes in Open Recent. Cancel stops the clone, and what it had copied is removed.
  - If GitHub does not let Workbench read a private repository, the sheet says so and offers **Sign in to GitHub…**. No token is needed: it gets GitHub's own command-line tool first if your Mac has none ("Getting GitHub’s command-line tool…"), then shows a one-time code. **Open GitHub** copies the code and opens GitHub's page in your browser: paste it there and approve. If the sign-in cannot run that way, Terminal opens on it instead: follow the steps there, then come back. If Terminal cannot open either, the sheet shows the command to run in a terminal of your own, with **Copy**. Once you are signed in, the clone runs again by itself. GitHub's tool keeps the sign-in, not Workbench, and git in Terminal, Workbench and your agents all use it.
  - **Use a token instead…**, beside it, is for a Mac where GitHub's tool cannot run. It asks for a token, and its link, "Create a token on GitHub", makes one on github.com with the right access. Workbench checks the token with GitHub and keeps it in your login keychain; then the clone runs again by itself.
  - Leave your name and password out of the address: the app refuses an address that holds them, since other programs on the Mac can read the command Workbench runs. Sign in to GitHub instead.
- **Nothing else to install.** Node and npm are inside the app, so agents and checks can run `npm test` on a Mac with no Node. It still needs git: if git is not installed yet, the first window says "Git is not installed yet. Apple’s developer tools include it.", and **Install Git** opens Apple's installer for them. Clone Repository… waits until git runs, and so does opening a folder: it says the same, with Install Git. The app checks again each time you come back to it. If Xcode is installed but its license has not been accepted yet, the app says so instead: "Xcode’s license has not been accepted yet. Open Terminal and run sudo xcodebuild -license, or open Xcode once." It looks for Claude Code where the command does (on the PATH, then in VS Code's Claude Code extension), and also where Claude Code's installer and Homebrew put it, which an app is not told. With no Claude Code or Codex ready, the board opens anyway, and Agents & keys helps you install one or sign in.
- **Closing the window, or quitting, stops the agents.** If any are still working, it asks first. What they did stays in their folders. If the app is closed in any other way (it crashed, say), Workbench notices and stops its agents too.
- **A copy downloaded on another Mac** opens only after System Settings → Privacy & Security → Open Anyway, unless it was signed with a Developer ID and notarized by Apple. A copy you build yourself opens directly. To build one that opens like any app from the web: `bash workbench/app/mac/build.sh --sign "Developer ID Application: Your Name (TEAMID)" --notarize <profile>`, where `<profile>` was saved once with `xcrun notarytool store-credentials`. Every disk image comes with a `.sha256` file: `shasum -a 256 -c Workbench-<version>-arm64.dmg.sha256` checks a download.
- **Licenses** of what the app carries (Node, npm, the JetBrains Mono typeface) are listed in `Contents/Resources/THIRD_PARTY_NOTICES.md` inside the app.
- **Each folder you open gets a new address for its page**, and the window keeps nothing from one session to the next. Your look and detail stay: Workbench keeps them.
- **Its log** is `~/Library/Logs/Workbench/workbench.log` (View → Show Log). What Workbench prints in a terminal goes there, such as the folders that keep an agent's work when it stops, each yes to start an agent, and why an agent failed ("Fix login failed: …").

## What you see

A circuit board. The chip in the middle is you; each agent is a chip on its own lane.

- **Where a chip sits says how much it needs you.** Beside you, its line lit and numbered in the order to answer: it, or one of its helpers, is waiting for you. Mid-board: working. At the edge, dimmed: done, failed or stopped, and not finished with yet. An agent keeps its lane while it is on the board, so you always find it where it was. Past twelve agents the lanes split to make room, and they stay split while agents are on the board, so one leaving never moves the others. A new agent whose side of the board is full waits in the done tray ("1 more working") until there is room on its own side.
- **An agent you are finished with leaves the board** for the done tray at the bottom left ("3 done", or "2 done, 1 not merged" when work you let go with **Not now** is still on its branch; its row in the tray says "not merged"): once its work is merged or thrown away, or you said **Looks good**, **Dismiss**, or **Not now** to merging it. **Look later** keeps it on the board. So does a merge that did not go through, even for an agent you had let go, until the merge goes through, you send it a message, its work is thrown away, or you press **Dismiss** under its answers (**Look later** and **Not now** there only set it aside, and a failed check has no **Dismiss**: ask it to fix that, merge it anyway, or set it aside); dismissed, it waits in the tray as "not merged". An agent that leaves fades away with its helpers, its lane is free for the next agent, and the others stay where they are. Pick it in the tray and the middle shows it again, with what you can still do with it; continue it, or send it a message, and it comes back to the board, and when it finishes it waits at the edge for you to look at what it did, even when it changed nothing. A reload keeps it in the tray.
- **Helpers** (sub-agents) are small parts beside their agent. A pulse runs along the copper when an agent takes a step; otherwise the board is still.
- **The middle** shows one thing at a time, in one sentence, with at most two buttons. A permission always shows the exact command or file, and why it is asked. "next" (or →) steps through what is waiting. When it shows a finished agent, typing or saying "not now" presses its button for that (**Not now**, **Look later**, **Dismiss** or **Close**), and "looks good" its **Looks good** (or its only way on, when its work is thrown away or merged already). Where no button means "looks good" (work you could merge, a failed check, a merge that did not go through, a stopped or failed agent), it only says which buttons there are, like "Choose “Merge into main” or “Not now”."
- **Hover a chip** (or Tab to the board and use the arrow keys) for its card: what it is doing, its helpers, its plan, time and cost. Click to pin it.
- **A new agent's copy gets what it needs to run.** An agent works in its own copy of your repository, which holds only what git tracks. So before it starts, its copy gets the files git ignores that a project needs: your `.env` files and `node_modules`, or exactly what a `.worktreeinclude` file at the top of your repository lists (on a Mac, as copies that take almost no disk). Its card says what it copies ("Copying .env and node_modules into its copy"), then, until the agent's first step, what its copy has ("Its copy has your .env, apps/web/.env.local and node_modules."), and what could not be copied and why ("node_modules was not copied: this disk cannot make quick copies."). The first time, the board says: "Agents’ copies now get your .env files, keys included, and node_modules, so they can run the project. A .worktreeinclude file at the top of the repository chooses what is copied." Values in those `.env` files are hidden in everything agents print, as the keys you give agents are, except those that cannot be secrets: plain words, numbers and addresses, such as `production` or `http://localhost:3000`, unless the variable's name says secret (`DB_PASSWORD`). What you type is never hidden for them.
- **A setup command** in your `workbench.json` (`"setup": "npm ci"`, see "Checks and rules") runs in each new agent's copy before the agent starts, once you say so. The first time, and again whenever it changes, the middle asks: "Run this setup command in each agent’s copy before it starts?", with the command, **Run it** and **Not now**. Typing "run it" or "not now" answers it too (a bare "yes" does not, so a second "yes" after starting an agent never runs it). Several agents started together wait on one question. **Run it** is kept for that repository and command; **Not now** starts them without it, and asks again next time. If the command fails, the agent starts anyway, and its card says so: "The setup command failed (exit 1), so its copy may not run yet."
- **Type anywhere, or hold the space bar to talk**: say what you want as you would to a coding agent ("the login page is broken", "prod is down", "why is the build slow?", "add a dark mode toggle", in any language), or "what needs me", "stop the flaky test". Anything that starts an agent asks you first: "Start Claude on “the login page is broken”?". Say an agent's name to pick it: "codex why is the build slow", "the login page is broken, codex". While an agent asks you something, what you type answers it; while one waits for your OK, say "yes" or "no" first. A stop naming an agent acts at once ("Continue" picks it up again), and a "yes" answers only what was on screen when you began. The exact rules are in `ARCHITECTURE.md`.
  - "help" (or "hi", "what can you do") says what you can type. "start an agent" with nothing more asks what it should work on, and "work on the login bug" starts work as "fix the login bug" does.
  - Work that names no agent goes to your default agent ("Use for new work" in Agents & keys), or else to the first one ready, Claude Code first. Saying "codex" or "claude" still picks one.
- **Agents & keys**, in the top band, is where you connect coding agents and give them keys (see "Agents & keys" below). Its light is green when an agent is ready for new work, and lit amber when none is. With no agent ready, the middle says "Connect a coding agent to start." with a **Connect** button, and Agents & keys opens by itself, once. Typing "connect", "add a key", "sign in" or "connect github" opens it too, and so does asking for work when no agent is ready ("No coding agent is ready yet. Connect one in Agents & keys."). Esc closes it.
- **Full permissions**, in the top band beside Agents & keys, stops the questions: press it, and the middle asks first, "Let agents do anything without asking?", with **Turn on full permissions** and **Keep asking**. While they are on, the button is lit amber, agents run every step without asking (see "Permissions" under "What is real"), and a launch question says "Full permissions are on, so it will not ask before any step.". Press it again and agents ask again, at once. Typing "full permissions", "stop asking" or "allow everything" asks the same question; "ask first" turns them off.
- **Keys never go through the board's input.** Paste a key there, or in a reply to an agent, and it is not sent: the board says "That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe." and opens Agents & keys.
- **The git chip** sits under you, wired to the core: a long memory chip with **git** printed on it. Click it (or Tab to it and press Enter), or type or say "git", "show git", "open git", "source control" or "show the graph", and the view travels down its wire to the **git screen**, below the board. "Back to the board" at the top left, Esc, or "back" or "board" takes you back up.
- **The git screen** draws your branch and your agents' branches as a circuit, newest commits at the top, where the wire arrives at your branch's tip (HEAD). Your branch is the thick gold trunk. Each agent's branch is a copper trace that leaves the trunk at the commit the agent started from, and comes back with a merge commit when you merge it. Your commits are gold vias, an agent's work commits small chips with its mark, merge commits square pads. Work not merged yet waits at the top of its trace, a dashed circle marked "not merged yet · 3 files" or "working". Beside each row: the subject, then who, when and the short id. It shows the newest 200 commits; work not merged yet on a branch that starts further back than that waits at the bottom, above "Older commits are not shown here."
- **Pick a row** (click it, or ↑ ↓ and Enter) for its detail; Esc closes it. An agent's detail shows its branch, its counts, its diff and what you can do with its work (see "Source control" below). A commit's shows who made it, when, its id, parents and branches.
- **The git screen's top band** says which repository and branch you are on, and how many uncommitted changes your folder has. When something needs you, it lights "<Name> needs you" (and a screen reader hears what comes while you are there), which takes you back to the board with that in the middle. What you type or say there goes to the workbench, about the agent whose detail is open, and, as in the middle, a "yes" answers only what was on screen when you began. While you hold the space bar to talk, the band shows a wave and the words heard so far in place of the input. Esc while you talk throws the words away ("Stopped listening.") and leaves the git screen, its detail and any card in it as they are.
- **Machines** are the gold connector along the bottom; click one for the machines menu. Spend today is at the top right: "about" while part of it is the workbench's estimate, and "not reported yet", never "$0", for an agent that has reported nothing.
- **Make it yours**: click the workbench mark for the look (green, black and gold, ivory) and the detail (calm, or more). Typing "ivory" or "more detail" does the same. Workbench keeps your choice for the next time it starts, in `~/.workbench/prefs.json`, in the browser and in the Mac app alike.
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

Screenshots of each look and view are in `docs/screens/`: the board (`board-*.png`, with the git chip) and the git screen (`git-*.png`). `node scripts/ui-shots.mjs <folder>` takes them again, along with the lid's merge views (`merge-*.png`) and an agent at its spending limit (`limit-*.png`), which are not kept in the repository so that every agent's copy of it stays smaller; the `live-*.png` shots come from an earlier real run.

## Agents & keys

The **Agents & keys** button in the top band opens a panel over the board with three parts.

**Agents.** One row for Claude Code and one for Codex, each with a light and what Workbench found: "Claude Code 2.1.322 is ready, signed in with your Claude subscription.", "Codex is installed but not signed in.", "Codex is not installed.". Workbench asks the agents themselves (`claude auth status`, `codex login status`); it never reads their logins. Each row has only the buttons that make sense:

- **Sign in** happens in your browser, with no Terminal and no key. Workbench runs the agent's own sign-in in the background (`claude auth login --claudeai`, `codex login`), which opens Anthropic's or OpenAI's own sign-in page in your browser. You approve there, and the agent keeps the sign-in itself: Workbench never sees it. Meanwhile the panel says "Finish signing in to Claude in your browser." (or "… to ChatGPT …"), with **Cancel**. Workbench asks the agent every 2 seconds whether it is signed in, and the row turns ready as soon as it is. Only one sign-in runs per agent; pressing Sign in again shows the one under way.
- **Use your Anthropic Console account** (Claude Code only) signs in the same way with an Anthropic Console account, whose requests are billed per use (`claude auth login --console`).
- If the sign-in in the browser does not finish (it fails, the agent asks for a code to be pasted, or 10 minutes pass), the panel says "The sign-in in the browser did not finish. Sign in in Terminal instead.", with **Sign in in Terminal**. That opens Terminal on a Mac, running the agent's own sign-in (`claude auth login`, `codex login`), for you to answer there; when you come back to the page, it checks again. After a **Cancel**, Sign in in Terminal is offered too. On other systems the panel shows the command to run instead, with **Copy**.
- **Install** opens Terminal on a Mac, running the vendor's own installer, for you to answer there (elsewhere it shows the command, with **Copy**). Both installers put the program in `~/.local/bin`. When you come back to the page, it checks again.
- **Use an API key instead** saves a key for that agent, for people who want each request billed to a key. "Claude Code will use this key instead of your Claude subscription, and each request is billed to the key." For Codex: "Codex will use this key, and each request is billed to it."
- **Use for new work** chooses the agent new work goes to; a mark shows which one it is. Naming an agent in what you say ("… with codex") still wins.
- **Check again** looks again, for example after you installed one or signed in from a terminal of your own.

An agent connected while Workbench runs can take work at once, and agents from an earlier run that used it can be continued again. Agents already working carry on as they were.

**Git and GitHub.**

- When git cannot run yet, the panel says so first. On a Mac without Apple's developer tools: "Git is not installed yet. Apple’s developer tools include it.", with **Install**, which opens Apple's own installer (`xcode-select --install`); the panel checks again when you come back. Elsewhere: "Git is not installed yet. Install git with your package manager.". Workbench never runs Apple's stand-in `/usr/bin/git` before the developer tools are there, since that would open Apple's installer by itself. On Linux it says "Install git with your package manager.", with no button.
- Your name and email for git, with **Save**, which writes them into git's global settings. Merging needs them.
- **Sign in to GitHub**, with no token to make or copy. Workbench signs you in with GitHub's own command-line tool, `gh`:
  - If `gh` is not on this computer, the panel first says "Getting GitHub's command-line tool…". Workbench downloads GitHub's official build for this computer from GitHub's releases, checks it against the checksums GitHub publishes with them and, on a Mac, against GitHub's own signature, and puts it in `~/.local/bin/gh`. No Homebrew, admin rights or installer are needed. If an older `gh` is already there, Workbench gets its own copy and says so.
  - The panel then shows a one-time code ("Your code: ABCD-1234") with **Open GitHub**. Enter the code on GitHub's page and approve. If that cannot work (no code comes, say), Terminal opens on the same sign-in instead: follow the steps there, then come back. Where Terminal cannot open (on Linux, say), the panel shows the command to run in a terminal of your own, with **Copy**, and Workbench waits for it.
  - Then the panel says "Signed in to GitHub as <login>. Git in Terminal, Workbench and your agents use this sign-in.": `git clone`, `pull` and `push` work in any terminal, private repositories included, and so do Workbench's own clone, the Mac app's list of your repositories (organisations' too), and your agents' git and `gh` commands. `gh` keeps the sign-in, in your login keychain; Workbench never sees or keeps the token.
  - If `gh` was signed in already but git does not use it (you signed in with `gh` in a terminal of your own and answered no to its git question, say), the panel says "Signed in to GitHub as <login>, but git does not use this sign-in yet. Sign in to GitHub again to set that up.", with **Sign in to GitHub**, which only makes git use the sign-in, beside **Sign out**.
  - **Sign out** signs `gh` out on this computer and sets git back to how it was (when `gh` has to sign out in Terminal, once you have done that and come back). Git also forgets any GitHub sign-in it kept for that account, even one you saved yourself, since a sign-in in Terminal can leave git a copy of `gh`'s token; a token you connected for the same account stays. GitHub still lists the sign-in under Settings → Applications until you revoke it there. If `gh` cannot sign out by itself and Terminal cannot open, the panel shows the command to run, with **Copy**.
- **Use a token instead**, for computers where `gh` cannot run: paste a token (**Create a token** opens GitHub's page for one, with the right access) and press **Connect**. Workbench checks the token with GitHub, keeps it with your keys, and gives it to git's own credential helper (the login keychain, on a Mac), so git can clone and fetch your private repositories. The panel then says "Connected to GitHub as <login>.".
  - Agents get the token (as GH_TOKEN, and GITHUB_TOKEN) only when you tick "Let agents use this token (as GH_TOKEN)", before connecting or after; untick it to take it back. Copilot may sign in with it.
  - **Disconnect** makes git forget the token. The token itself still works until you delete it on GitHub.

**Keys for your agents.** API keys, cloud keys and tokens that agents and their checks need, such as AWS keys for a deploy script. **Add a key** offers Anthropic, OpenAI, Gemini, AWS, Google Cloud, Azure, GitHub, Stripe, or names of your own ("Other"), then asks which repositories it is for (this one, or all) and which agents get it (all, or one).

- **Agents can read the keys you give them, and so can anything they run.** The panel always says so: give them keys that can do only what their work needs, never your root or admin keys.
- **Checks get them too.** The checks Workbench runs on an agent's work (see "Checks and rules") get the same keys as that agent, and the panel says so.
- **Where keys are kept.** On a Mac, in your login keychain, as items named "Workbench key". On Linux, in your keyring when one is running, and otherwise in private files in `~/.workbench/keys/`. `~/.workbench/keys.json` lists what each key is, never its value. Keys never go into your repositories, Workbench's logs or its history.
- **Workbench never shows a key again.** A secret appears as "•••• " and its last four characters, or "••••" when it is short. Settings that are not secret, such as AWS_REGION, are shown as they are. Anything an agent or a check says that holds one of your keys is shown with the key hidden the same way: on the board, in a permission's command, in errors, the event log and the history. It is not hidden in an agent's changes: you need to see a key an agent wrote into a file before you merge it.
- A key goes to agents started after you add it; **Remove** asks first, and agents started from then on do not get it.
- Some names cannot be keys, because they change how programs run or where they look: PATH, HOME, NODE_OPTIONS, anything starting GIT_ or WORKBENCH_, and the like. A Claude or ChatGPT subscription's own sign-in tokens cannot be keys either: sign in with Claude Code or Codex instead.
- A key can be at most 2,000 characters, on one line (on a Mac, the keychain takes a little less: about 1,950). You can keep up to 50 keys.
- If your keychain is locked when Workbench starts, it asks once, and says in the terminal (or the Mac app's log) which keys agents will not get.

## What is real

- **Claude Code agents are real.** Each runs the Claude Code program installed on this machine, with your own login (or the API key you gave it in Agents & keys), in its own git worktree of the repository. Worktrees start from your last commit, so uncommitted changes are not in them.
  - Your personal Claude Code plugins, hooks and MCP servers are deliberately **not** loaded into these agents, and neither is your own `.claude/settings.local.json`. The repository's committed `.claude/` settings are loaded too. Agents cannot change them, but treat them like the rest of your repository's code: a committed setting can change how an agent runs. It cannot switch off the permission questions or redirect them: the workbench sets those on the command line, which outranks the repository's settings.
  - Helpers (sub-agents) appear beside their agent as they start, and settle when they finish.
  - On a machine without a browser login, such as a cloud VM, set `CLAUDE_CODE_OAUTH_TOKEN` before starting the workbench; the agents use it.
- **Permissions.** Every action an agent takes passes through the workbench first:
  - **Approved automatically:** reading and searching inside the agent's own folder, edits inside it, any git command that stays in its folder (committing, branching, merging, and pulling from and pushing to the repository's own remotes included), and a short list of safe single commands such as `ls` and test runners.
  - **Wildcards are checked file by file.** Your shell expands a wildcard (`*`, `?`, `[…]`) into file names before the command sees them, so the workbench expands it the same way, against the agent's folder, and judges every file it matches as if it were written out: `cat src/*.js` runs, and a wildcard that reaches through a link to somewhere outside the folder waits, as the full path would. A wildcard that matches too many files to check, or searches outside the folder, waits too, and so does a word that starts with `=`, which zsh turns into the full path of a program.
  - **Waits for your OK:** everything else, including reading anything outside the agent's folder. The question says in plain words what the agent wants to do and where, it comes with the workbench's reason for asking, and "What exactly?" shows the exact command or file. Asking "what is it doing", or "is it okay?", says the exact command too. Only "Allow", or a plain "yes" while that request is on screen, lets it run. Stopping a helper that is waiting says no to what it asked.
  - **Git still waits for your OK** when it reaches past the agent's own work: when it would change git's settings (`git config` that writes), or read your own or the computer's (`git config --global`, `--system`, or a list across all of them such as `git config --list`); use the sign-in that git or GitHub's command-line tool keeps for you (`git credential`, `gh auth token`); reach an address or a folder that is not one of the repository's own remotes, with that sign-in (`git fetch https://…`, `git push <address>`, `git clone`, `git ls-remote <address>`, `git remote add` and `set-url`, `git submodule add`, and `git submodule update`, which can use the addresses in `.gitmodules`); apply a patch, which can change any file in the folder, Claude Code's own settings included (`git apply`, `git am`); make git show a different commit in place of one of yours (`git replace`); work in, or write to, a place outside the agent's folder (`git -C ../other`, `git clone … /tmp/x`); work in another repository inside its folder (`git -C sub` where `sub` has a `.git` of its own, or is a bare repository), whose settings can make git run programs; take an option that points it at another repository or makes it run a program (`-c`, `--git-dir`, `git rebase -x`), or start another program (`git difftool`); keep a repository's records in a separate folder (`git init --separate-git-dir`, which in the agent's folder would move your whole repository), or set up your repository again (`git init` in the agent's folder); replace or delete what is on a remote, or set one up as a mirror (`git push --force`, `--delete`, `--mirror`, a `+` or `:` refspec, `git clone --mirror`); destroy what no fetch can bring back (`git reflog expire`, `git gc --prune`, `git prune`, `git maintenance run`, `git repack -d`, `git prune-packed`, deleting a branch other than the agent's own with `git branch -D`, deleting any branch or tag with `git update-ref -d`, and `git worktree remove`, `prune`, `move`, `lock`, `unlock` or `repair`, which can reach another agent's folder); or run a command that is not git's own (`git lfs`). A plain push of any branch to one of the repository's own remotes runs. Branches, tags and stashes are shared by the whole repository, so an agent can move your branches and tags (git refuses for a branch you have checked out) and delete your tags and stashes. A command line that chains or substitutes commands still waits, and that includes Claude Code's usual way of writing a commit message, `git commit -m "$(cat <<'EOF' …)"`.
  - A command an agent runs reads on its card as what the command does, or as the command itself, not as the agent's own description of it.
  - **Refused:** changes to Claude Code's own settings (any `.claude` folder, and `.mcp.json`, however the name is written: your Mac's disk takes `.MCP.json`, or `.mcp.jſon` with a long s, for the same file), and helpers that would work in a separate copy of the repository or on another computer.
  - **Blocked:** if the workbench cannot be reached, the action is blocked rather than allowed.
  - **Full permissions** (the top band's button, or "full permissions", "stop asking", "allow everything", "don't ask me", "full access") stop the questions. Turning them on always asks first; the questions already waiting are then allowed too (one that full permissions would refuse keeps waiting for you). While they are on, every step that would wait for your OK runs without asking, counted as an automatic approval, and only a floor is refused: a change to Claude Code's own settings, as far as the workbench can tell (an edit there; a command that would write there, such as a redirection into them, `rm`, `mv`, a copy into them, `sed -i`, an archive unpacked there or `git checkout` of them; a `cd` into them; code given inline or on its input that names them; another service's tool given a path there), a step whose landing place it cannot tell (a path it cannot resolve), and helpers that would work in a separate copy of the repository or on another computer. Reading those settings, copying them elsewhere, mentioning them in a message or a file, and running a script that lives there all run. Edits are checked; commands only on a best-effort basis: a patch such as `git apply`, code an interpreter runs, and names built at run time can get past it. They stay on until you turn them off, also when the workbench starts again (it says so when it starts); press the lit button, or say "ask first", and agents ask again from their next step. Codex never asks anyway, and the spending limit, the checks and rules, and Merge and Throw it away are as before. In the demo they last for that run only, and never turn on for your own agents.
  - **Tests and scripts run code the agent may have written.** Test runners and scripts in the agent's folder are approved automatically, and they run as you, so that code can do anything you can. On your laptop, a repository or web page that tricks an agent is a real risk. Running the workbench on a cloud machine keeps that away from your own files.
- **When an agent finishes.** A closing "Let me know if you need anything else." is not a question: its work is checked and it is done. A real question at the end ("Should I remove the old route?") waits for your answer; "What changed?" already shows its changes, and its checks run only once it is done.
- **Commands left running.** An agent may leave a command running when it finishes, such as a development server. Its card says "Waiting for a background command". After four quiet minutes you are asked once whether it is done: "It is done" checks its work (the command keeps running until you stop the agent or close the workbench), "Keep waiting" waits on.
- **Might be stuck.** An agent that tries the same step three times without success, hits the same error three times close together, or goes quiet for four minutes is marked "might be stuck". The mark goes away as soon as a step works again.
- **The spending limit.** Each agent may spend up to `--budget` in a run ($2 unless you set it; the Mac app always uses $2). Claude Code stops an agent that reaches it, and the middle says "Checkout fix stopped with an error." and "It reached its spending limit.", with **Give it $2.00 more** in place of **Try again**, beside **Dismiss**. Press it and the agent may spend that much more in this run, and it continues where it left off: "Checkout fix can spend $4.00 in all now, and it is continuing." Nothing more is spent unless you press it, and you can press it again each time the agent reaches its new limit. Codex reports no cost, so it has no limit to raise. An agent from an earlier run gets a fresh limit when you continue it (see "Earlier agents").
- **Codex agents are real** when Codex is installed and signed in, with your ChatGPT account or an API key. They run in Codex's own sandbox, so they never ask for permission. Codex does not report cost, so it shows as "not reported".
  - **Codex can do git too.** Workbench turns on the network in Codex's sandbox and lets it write the repository's git folders, so a Codex agent can commit, fetch, pull and push. That means Codex can reach the network for anything, not only git: it can download, upload and reach any address. It can also change the repository's git settings and hooks, which git runs as you, outside the sandbox, whenever git works in your repository: when you use git there, and when Workbench does. Workbench checks your folder with git every 15 seconds, and also runs git at the end of each agent's turn, when it shows, merges or throws away an agent's work, and when it makes or tidies away an agent's folder. So a setting such as a filter can run a program as you within seconds, without you doing anything. Workbench turns off hooks when it shows, merges or throws away work, but not filters, which repositories that use Git LFS need. Writable folders you set in your own Codex config do not apply to Workbench's Codex agents.
- **Your laptop's** CPU and memory are real.
- **Cloud machines are simulated** and appear only in demo mode.
- **Voice** uses the browser's speech recognition. In Chrome this sends the audio to Google's speech service. Typing works everywhere.

## Source control

Each agent works on its own branch, `workbench/<task>-<id>`, in its own folder. Its work is not in your branch until you merge it. The workbench does the git for you, and asks before it changes anything.

**Looking at an agent's changes.** For a finished, failed or stopped agent, or one from earlier, whose folder may hold work not merged yet, the middle offers **Review the changes**. It opens the git screen on that agent, with its diff. So do the words "what did search cleanup change", or "show me the changes" and "diff it" for the agent in the middle. The diff shows what merging it would change in your branch: each file with its counts ("+12 −3", "new file, +40", "deleted, −8", "binary file", "too large to show here"), and each added or removed line marked + or −. Files hidden by a .gitignore the agent added or changed, and folders that are git repositories of their own, are listed as not merged. While the agent works, the detail says "It is still working, so its work may still change." Looking changes nothing; Esc takes you back.

**Merging.** When an agent is done and its work is not merged yet, the middle offers **Merge into main** (your branch's name) and **Ask for a change**, with **Review the changes** and **Not now** under them. "Not now" leaves the work where it is, unmerged, and tells the agent nothing: "OK. Search cleanup’s work stays on its branch for now." The agent goes to the done tray, where you can pick it to merge it later. When a check failed, **Merge anyway** is under the answers. For a failed or stopped agent, or one from earlier, Merge is in its detail on the git screen. You can also type "merge search cleanup", or "merge it" for the agent in the middle (or whose detail is open).

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

**When a merge does not go through,** nothing in your folder has changed, and the workbench says why. Most reasons stay in the middle until they are settled, or until you press **Dismiss** under the answers, which sends the agent to the done tray, its work not merged:

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

**Your name and email.** The workbench makes the commits as you, with the name and email in your git config. It never uses a name git guesses, nor `GIT_AUTHOR_NAME` and the like. Without them, the terminal says so when the workbench starts ("Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: …"), the git screen says "Git does not know your name and email yet, so Workbench cannot merge.", and the middle offers no Merge. Set them in Agents & keys (Save writes them into git's global settings), or in a terminal, and within 15 seconds Merge is offered; there is no need to restart:

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
  "allow": ["npm run lint"],
  "setup": "npm ci"
}
```

| Key | What it does |
|---|---|
| `checks` | Run after an agent says it is done. It becomes "done and checked" or "done, but a check failed". With no checks, it stays "says it is done". Sending the agent a new message, or stopping it, stops its checks. They get the same keys as the agent whose work they check (see "Agents & keys"), and a key in their output is hidden. |
| `rules` | Each one is checked against the files the agent changed, including new files hidden by a `.gitignore` the agent added or changed. Those show in "What changed?" too. The merge card checks them again, against what the merge would bring in. |
| `allow` | Adds command prefixes to the automatic approvals. |
| `setup` | One command (`npm ci`, `uv sync`) that each new agent's copy runs before the agent starts, after its `.env` files and `node_modules` are copied in, once you said **Run it** to it (see "What you see"). It runs for up to 10 minutes, with no key; its output goes to the log only. `WORKBENCH_ROOT` holds your own folder, for a command that needs something from it. |

The workbench reads this file from your last commit, never from an agent's copy, so an agent cannot loosen its own checks.

## Dogfooding: Workbench on its own repository

Workbench can run agents on its own repository. At the top of this repository:

```sh
npm run dogfood                            # node workbench/bin/workbench.mjs --repo .
npm run dogfood -- --budget 1 --verbose    # options go after --
```

Or open this folder in the Mac app (see "The Mac app"), which needs no Node on your PATH.

- **Claude Code is found** in this order: `--claude <path>`, then `WORKBENCH_CLAUDE_BIN`, then `claude` on the PATH, then the newest Claude Code that the VS Code extension installed, in `~/.vscode`, `~/.vscode-insiders` or `~/.cursor`. With only the extension, nothing needs setting: the terminal says, for example, "Claude Code 2.1.322 is ready, signed in with your Claude subscription. Found in the VS Code extension." (`--verbose` also prints where it is). It is looked up again at each launch, because the extension moves to a new folder with each update. A path you give that is not there is reported as it is, never swapped for another Claude Code.
- **Node on the PATH.** `npm run dogfood` itself needs node and npm. Agents and checks get node from the workbench: when the PATH it gives them has no `node`, the folder of the node running the workbench goes first, so `npm test` and `node --test` can find it.
- **Checks and rules.** This repository's `workbench.json` runs `npm test` (the whole suite, for up to 600 seconds) when an agent says it is done, and sets two rules: "Do not change the research and mockups in docs/" (the top `docs/` folder, not `workbench/docs/`) and "Add no packages" (any `package-lock.json` or `node_modules/`).
- **Git's name and email** must be set before you can merge (see "Your name and email" above). When git has none, the terminal says so at the start.
- **Merging into the folder the workbench runs from.** `npm run dogfood` runs the workbench from this folder, and a merge changes its files. Reload the page to see a merged change to the page (`ui/` and `src/shared/`). The engine runs the code it started with until you restart the workbench (Ctrl-C, then `npm run dogfood` again). One exception: Claude Code starts the permission hook, `src/adapters/claude/hook-bridge.mjs`, afresh for each step, so a merged change to it reaches running agents at once. When a change touches both the page and the engine, restart and reload.
- **The Mac app runs its own copy of the workbench,** not the one in this folder. A change you merge reaches the app once you quit it, build it again (`bash workbench/app/mac/build.sh --install`), and open the folder again.
- **An agent cannot start a live workbench.** Every agent has `WORKBENCH_AGENT_ID` in its environment, and so do the checks the workbench runs for it. With it set, `bin/workbench.mjs` refuses to start real agents ("Workbench is running inside an agent. It will not start real agents from there."), and so does `scripts/accept-real.mjs`. `--demo` still works. This guards against accidents, not against code that removes the variable on purpose.

`CLAUDE.md` at the top of this repository gives agents working on the workbench its rules.

## Safety

- The page and its programming interface listen on `127.0.0.1` only. Every request needs the run's key, and requests from other websites are refused. A link with anything after the address except this run's key (an old link, say) opens the plain page instead; a tab without the key then asks you to open the link printed in the terminal.
- The page has a new address every run: a free port, picked at random from more than 16,000. Something another program left in your browser for an address it served earlier (a script it cached, say) is almost never at this run's address, so it does not get this run's key. A port you choose with `--port` is the same address every run, so leave it out unless you need it.
- Each agent gets its own key for asking permission, so one agent's key cannot ask in another agent's name, and it never opens the page's interface.
- Every Claude Code agent has a spending limit (`--budget`). Only you can raise it, one limit at a time, with the button the middle shows when an agent reaches its own. Codex reports no cost, so Codex agents have no limit, and their launch card says so.
- Agents can read the keys you give them, and so can anything they run: give them keys that can do only what their work needs. Workbench keeps keys out of its page, its logs, its history and the agents you did not give them to; it cannot keep an agent from its own keys. The page shows a key only as "•••• " and its last four characters, never keeps one, and never sends text that looks like a key from the board's input.
- A key's value never goes into a command line, which other programs on the computer can read. The Mac app gives Workbench a GitHub token on its standard input, never as an argument. The page's own key stays off command lines too when Workbench opens your browser: on a Mac it goes to `osascript` on its standard input; elsewhere the browser opens a private file, removed soon after, that sends it on to the page.
- **Full permissions take you out of the loop.** With them on, nobody is asked before a step: an agent, and any helper, can run any command, change or delete any file your account can (outside its folder too), reach any address, and use your sign-ins (git's, GitHub's, the keys you gave it), and so can a repository or web page that tricks it. The workbench still refuses changes to Claude Code's own settings, and helpers that would work elsewhere, but only as far as it can tell: edits are checked, and commands only on a best-effort basis (a patch such as `git apply`, code an interpreter runs, and names built at run time can get past it), and code an agent runs can write anywhere you can, those settings included. They stay on until you turn them off, across restarts, so the workbench says so when it starts ("Full permissions are on: agents run every step without asking. Turn them off on the page.") and the button stays lit. Turning them on always asks first; turning them off is at once. Use them on a machine and a repository you can afford to lose, such as a cloud machine; the spending limit still holds. The choice is kept in `~/.workbench/prefs.json`, which a script an agent runs can write like any of your files.
- An agent's copy gets your ignored `.env` files, keys included (see "What you see"), so the agent and anything it runs can read them, as they can read your folder. Their values are hidden in what agents print, on the page and in the log, except plain words, numbers and addresses that cannot be secrets (`production`, `localhost:3000`) when the variable's name does not say secret. Put in `.worktreeinclude` only what agents should have.
- A repository's setup command runs as you, with no sandbox, only after you said **Run it** to that very command, and Workbench asks again when it changes.
- Merge and Throw it away always ask first, and check everything again when you answer. A merge goes ahead only if the agent's work and your branch are as its card showed them; otherwise it says so and changes nothing.
- A Codex agent can change your repository's git settings and hooks (see "Codex can do git too" above). Git runs those as you whenever it works in your repository, and that includes Workbench's own regular checks: it looks at your folder with git every 15 seconds, so a setting such as a filter can run a program as you within seconds, with no click from you. Workbench's merges, throw-aways and reviews run no hooks, but filters still run.
- Workbench keeps its own temporary files (the scripts it opens in Terminal, the download of GitHub's command-line tool, git's scratch files) in a private folder, `~/.workbench/tmp`, which Codex's sandbox cannot write. Never in the system's temporary folder, which it can. Code that runs as you, such as the tests an agent runs, can still write anywhere you can (see "What is real").
- Characters that hide text or change the order it reads in (zero-width and direction-changing characters, tag characters, a line break inside a name, and the like) show as marks, such as ⟦U+202E⟧ or ⏎, where an agent's or a repository's words appear: names, paths, branch names, questions, answers, replies, commit subjects and diffs.
- Agents' folders are yours alone: Workbench makes `~/.workbench` and the folders under it that hold agents' copies of your repository readable by your account only, and makes an older `~/.workbench` private when it starts.
- Stopping an agent stops any checks it is running. Stopping the workbench (Ctrl-C) stops every agent it started and every check it is running. An agent still being set up at that moment is not started: a folder git was still making for it is removed, and one its files were being copied into stays, with the others. A merge or throw-away under way finishes first.

## Limits

- Not in this release yet: choosing the Claude model in the Mac app (the command line has `--model`), a file view, a pull or push button, real cloud machines (the demo only simulates them), Windows, and the Mac app on Intel Macs.
- Only agents started by the workbench come back (see “Earlier agents” above). Their helpers, plans and step lists are not kept, and an agent that was working when the workbench closed comes back stopped.
- Until you merge it or throw it away, each agent's work stays on your computer after the workbench stops, in its own folder under `~/.workbench/worktrees/`, on a branch named `workbench/<task>-<id>`; the terminal lists them when the workbench stops. The changes may not be committed. Folders where an agent changed nothing are removed with their branches, and so are merged agents that changed nothing since, unless you press Ctrl-C twice: then the workbench stops without tidying up, every folder stays, and the terminal lists them all. Throw it away removes a folder and its branch for you. For a folder the workbench no longer shows (an agent you forgot, say), remove it yourself: `git worktree remove <folder>`, then `git branch -D workbench/<task>-<id>`.
- An agent's copy holds the `.env` files and `node_modules` copied into it, so its folder is kept when the workbench stops, even when the agent changed nothing, and the terminal lists it with the others.
- A second Ctrl-C (or 12 seconds) during a merge stops waiting for it. Git still finishes the merge, but the workbench does not record it; the next Merge says the work is already in your branch.
- After an agent brings in your branch, the file counts in the middle and on its card can include your own commits, and a rule can read as broken by them. The merge card and the diff count only what the merge would bring in.
- Clean and smudge filters and merge drivers set in your git config still run when Workbench's own git works in your repository: in its check of your folder every 15 seconds, at the end of an agent's turn, and when it shows or merges an agent's work.
- Sessions started outside the workbench, for example `claude` in your own terminal, do not appear.
- When git has no credential helper (common on Linux), a GitHub token cannot let git clone private repositories, and Agents & keys says so. Sign in to GitHub instead, which makes `gh` git's helper for github.com, or set one up with `git config --global credential.helper store` or your system's keychain helper, then connect again.
- Sign in to GitHub needs GitHub's command-line tool to run here: macOS 13 or later, or Linux on an Intel/AMD or ARM 64-bit processor. Elsewhere, use a token instead. Signing in with a GitHub Enterprise server is not offered yet.
- Check again finds a program installed while the workbench runs when it is in a folder on the workbench's PATH. The workbench adds `~/.local/bin`, where both installers put their programs; for a program installed anywhere else, start the workbench again.
- How far along an agent is cannot be measured honestly, so there is no percentage or finish time. The card shows elapsed time, steps, the agent's own plan and spend instead.
- Voice cannot be tested automatically. Try it in Chrome.

## For developers

- `ARCHITECTURE.md` is the contract between the parts.
- `npm test` runs the tests, here or at the top of the repository. They use recorded agent output in `test/fixtures/` and never start real agents. They never touch your keychain, keyring or GitHub account either: the key store's tests run stand-ins for macOS's `security` and Linux's `secret-tool` (`test/helpers/security-fake.mjs`, `test/helpers/secret-tool-fake.mjs`), GitHub's answers are made up in the tests, and GitHub's command-line tool is a stand-in (`test/helpers/gh-fake.mjs`), downloaded from a release the tests make themselves. The GitHub tests never run a `gh` installed on your computer: they set `WORKBENCH_GH_BIN`, which names the one `gh` Workbench may use. `test/live-fake.test.mjs` runs the whole chain (the CLI, the engine, the real permission hook, the HTTP API) with a stand-in for Claude Code that replays a recorded run, merges and throw-aways against real git included.
- `scripts/demo-e2e.mjs` walks the demo through its HTTP API.
- The page's debug switches (`static=1`, `still=1`, `pin=<agent id>`, `focus=<agent id>`) count only when the same address carries the run's `t=` key. `scripts/ui-fit-check.mjs`, `scripts/ui-behaviour-check.mjs` and `scripts/ui-shots.mjs` drive the page in headless Chrome against a stand-in API (`scripts/ui-mock.mjs`), and `scripts/ui-contrast.mjs` checks the colours of all three looks.
- `scripts/accept-real.mjs <throwaway repo> [screenshots folder] [--keep] [--claude <path>]` does one real run with Claude Code (haiku, at most $0.50) and prints PASS or FAIL for each step, merge and throw-away included. The repository needs a branch, a committed `workbench.json` with a check and a rule, and git's name and email. The merge commit stays on its branch; unless you pass `--keep`, the agent's folder, its branch and the hidden copy go at the end. It answers Allow only to the agent's own `touch` and to a helper's command that only lists or reads files; anything else is refused, and fails a step. Its header explains how to dry-run it with the stand-in first.
- `scripts/keychain-check.mjs` checks the key store against this computer's real keychain, which no test may touch: it saves three made-up values (plain, non-ASCII, near the length limit), reads them back from a second process, removes them and checks they are gone, printing no value. Run it yourself after changing `src/core/keys.mjs`; agents must not. `--file-only` runs the same steps with the file store.

| Folder | Contents |
|---|---|
| `src/core/` | the engine, state, commands, permission policy, worktrees and git, receipts |
| `src/adapters/` | Claude Code, Codex and the simulator |
| `src/server/` | the local web server |
| `src/shared/` | code used by both the engine and the page |
| `ui/` | the page; no build step |
