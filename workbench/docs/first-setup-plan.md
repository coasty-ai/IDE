# First setup: quick and easy

Goal: a stranger goes from download to an agent working on their own project in a few minutes, with as little to set up as possible. The moment people give up is "when it's too hard to set up anything."

This list comes from research on 2026-11-15: Hacker News launch threads and GitHub issues for Conductor, Crystal, Vibe Kanban, Superset, Sculptor, the Codex app and Claude Code, plus vendor docs. People want:

1. Their own Claude or ChatGPT plan, through the vendor's sign-in. Workbench already does this.
2. Nothing to redo: the agent and its sign-in found on the Mac.
3. No sign-up and no GitHub or git questions before the first task.
4. An agent at work within a minute, with no tour.
5. No Terminal.
6. An agent's copy that runs.
7. Plain words when a sign-in fails.

Sources:
- https://github.com/anthropics/claude-code/issues/17118
- https://news.ycombinator.com/item?id=44594584
- https://news.ycombinator.com/item?id=46859054
- https://www.warp.dev/blog/lifting-login-requirement
- https://www.nngroup.com/articles/onboarding-tutorials/
- https://code.claude.com/docs/en/desktop-quickstart

## Tasks for agents, in order

Each task can be given to a Workbench agent as it is ("do task 3 in workbench/docs/first-setup-plan.md"). Follow CLAUDE.md, write tests first, and change ARCHITECTURE.md and the README with the code. Keep the look calm, with little text and one thing at a time.

1. **Starter tasks on an empty board.** When nothing needs the person and no agent has worked in this repository yet, the middle offers up to three tasks that only read the project:
   - "What does this project do?"
   - "How do I run it?"
   - "Find likely bugs"

   A click is the same as typing it: the usual "Start Claude on …?" card follows.
   - Where: the idle lid in `ui/focus.js`, its action in `ui/app.js`, and a mock scenario in `scripts/ui-mock.mjs`.
   - Done when: the behaviour check and the fit check pass with the new state.

2. **Name and email at the first merge, in place.** Today a merge with no git identity says to run `git config` (`ui/queue.js:78`, `ui/gitscreen.js:960`). Instead, the merge card shows two fields, filled from git config when it knows part of it, and **Save and merge**. They are saved with Agents & keys' `setGitIdentity` (`src/core/connect.mjs`), then the merge runs.
   - Done when: a person with no identity merges without leaving the page.

3. **One question when no agent is ready.** Today Agents & keys opens with everything at once. On a first run with no agent ready, the middle shows one card: "Which plan do you have?", with **Claude**, **ChatGPT**, and a small "Use an API key" link.
   - Picking one does the rest, with one line of progress: install the agent if it is missing (task 4), then run the vendor's own browser sign-in (`src/core/signin.mjs`).
   - The card closes when the agent reports it is signed in.
   - If a step fails, the card says which one in plain words and offers **Try again**, **Sign in in Terminal** or **Use an API key**.
   - Agents & keys stays where it is, for everything else.

4. **Install agents inside the app.** Run the vendor's own installer (the fixed lines in `src/core/connect.mjs`) in the background instead of in Terminal. Show progress, check that the program runs, and fall back to Terminal on failure.
   - Owner decision first: check Anthropic's and OpenAI's terms for installing their agent from another app. See https://code.claude.com/docs/en/legal-and-compliance.

5. **Find more installs.** Find `claude` and `codex` installed through npm under nvm, fnm, volta or asdf, through `~/.npm-global` and through Homebrew, as well as the places already searched.
   - Where: `findClaude` in `src/adapters/claude/args.mjs`, `codexBin` in `src/adapters/codex/runner.mjs`, and the Mac app's `Environment.forWorkbench`.

6. **"Set up git here."** A folder that is not a git repository, or has no commits yet, is refused today (`src/core/workspace.mjs:265` and `:274`). Offer to set it up instead: `git init`, a `.gitignore` check that warns about secrets and build output, and a first commit.
   - The commit needs a name and email, so they are asked then (task 2).

7. **An agent's copy that runs.** Agents' folders hold only what git tracks: no `.env`, no installed packages. Give each repository a list of ignored files to copy into every agent's folder, and an optional setup command such as `npm install`.
   - Ask for them the first time a task needs them, and keep them in `workbench.json`.
   - Say plainly that each copied secret is then in every agent's folder.
   - Where: `createWorkspace` in `src/core/workspace.mjs`.

8. **Plain words when a sign-in fails.** Turn the common vendor failures into a sentence and a next step each: a phone check, an expired or rejected login (401), the wrong plan, a timeout.
   - Where: `src/core/signin.mjs` and `src/core/connect.mjs`.

9. **One-line install, until the app is signed.** Add an `install.sh` at the top of the repository that does four things, then put the line in the README's Download section with the disk image as the other way:
   - downloads the latest release's disk image with curl;
   - checks it against the release's `.sha256`;
   - copies Workbench.app to /Applications (or ~/Applications);
   - opens it.

   Files curl downloads are not quarantined, so macOS does not block the app.
   - Owner decision first: is a curl install line acceptable?

10. **Rebuild the app from this folder (for dogfooding).** The Mac app runs its own copy of Workbench, so merged changes reach it only after `npm run app` in Terminal. Add a menu item that rebuilds the app from the repository it has open, then reopens it once its agents are stopped.
    - `build.sh --install` refuses while the app is open, so the install has to happen after it quits.

11. **Signed release (owner first).** After enrolling in the Apple Developer Program:
    - build with `build.sh --sign … --notarize …`;
    - test the first launch on a clean Mac (hardened ad-hoc builds stalled on first launch during release testing);
    - replace the release's disk image.

    Then consider a Homebrew tap, and in-app updates with Sparkle.

12. **Intel Macs.** Either a universal build (a second bundled Node and a bigger download), or a clear line in the README pointing Intel users to the local web page.

## Owner decisions

- A Developer ID: 99 USD a year, for an app that opens with one click.
- Whether a curl install line is acceptable until then.
- Whether installing the vendors' agents from inside the app is within their terms.
- Whether a stranger with no plan is steered to ChatGPT's free tier or to Claude. Codex agents never ask before steps, and have no spending limit.
- Whether ignored files such as `.env` may be copied into agents' folders.
