# Source control: the build spec

This is the interface every builder works against. It is temporary. When the work is integrated, its contract moves into `ARCHITECTURE.md` and `README.md`, and this file is deleted. Where this spec and `ARCHITECTURE.md` disagree, this spec wins for the new parts. `ARCHITECTURE.md` wins for everything else.

## What we are building

Today an agent's work stays in its own worktree on a `workbench/<slug>-<id>` branch, and the page offers no way to see it, merge it or throw it away. Most people no longer do git by hand: agents do the work and Workbench handles git for the person. We add four things:

1. **A git screen.** The board gets a DRAM-looking module, wired to the core, with **git** printed on it. Clicking it moves the view down along a wire. The wire runs from the DRAM to the bottom of the board and on into the git screen below. That screen shows a **commit graph tree drawn with circuit traces**, like VS Code's Source Control Graph, but it branches downwards and spreads out. The newest commits are at the top, where the wire arrives, at your branch's tip (HEAD). Your branch is the trunk (a gold bus). Each agent's branch is a copper trace. It leaves the trunk at the commit the agent started from and comes back with a merge commit when it is merged. Selecting an agent's branch shows its diff and its actions.
2. **Review.** You can see an agent's actual diff, not only its file names.
3. **Merge.** Workbench commits the agent's work on the agent's own branch. A **merge commit** then joins that branch into your current branch in your main folder. Workbench never touches your uncommitted edits and never leaves conflict markers in your folder.
4. **Throw away.** This deletes the agent's folder and branch after asking first. A hidden copy is kept in git.

It also has to be ready for **dogfooding**: running Workbench on its own repository with Claude Code 2.1.322.

Decisions already made by the owner:

- **Merge style:** the agent's work becomes a commit on its own branch, and a merge commit (two parents) joins it into the person's branch. This holds even when a fast-forward would be possible, so the graph always shows the branch joining.
- **The graph's look:** described above. Newest commits are at the top. Keep the direction one constant (`NEWEST_AT_TOP = true` in `ui/gitgraph.js`), so it is easy to flip.

## Rules (unchanged, still binding)

- Node ≥ 22, ES modules, **no third-party packages**. `src/shared/` must not import `node:`. Tests use `node:test` and need no network. They never start a real `claude` or `codex`.
- Plain language in anything a person sees. Never show git's own error text. Build every sentence from facts: paths, branch names, counts.
- Every child process gets an argument array. Every git call goes through `workspace.mjs`'s `git()` helper, which keeps `-c core.fsmonitor=false` and the scrubbed git environment.
- Everything an agent controls is escaped in the page. That covers paths, diff text, commit subjects and branch names. Show control characters, bidirectional overrides (U+202A to U+202E, U+2066 to U+2069) and zero-width characters (U+200B to U+200F, U+FEFF) as visible symbols, never raw.
- Buttons carry what they were drawn for (`data-agent`, `data-state`, `data-confirm`, and here also `data-work`). The engine re-checks everything at the moment of acting.
- No test may depend on the machine's git identity. Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, or pass `-c user.name -c user.email`, in tests.

## 1. Git core: `src/core/workspace.mjs` (builder A)

### The work set

"The agent's work" is one set of files, and the diff, the merge card's counts, what is merged and what a throw-away removes all use exactly that set:

- every tracked change in the agent's folder compared with `since` (committed, staged, or unstaged), plus every untracked file that is **not ignored**. These are `git add -A` semantics, computed in a **temporary index**, never in the agent's own index;
- symbolic links are stored as links (their target text), never followed;
- **left out, and named as left out:**
  - files that a `.gitignore` hides (including a `.gitignore` the agent added or changed: these are the receipt's `ignored: true` files);
  - nested git repositories (a folder with its own `.git`).

  They appear in `left: [{ path, why: 'ignored' | 'nested-repo' }]`. The diff and the merge card both say they will not be merged.

`since` is where the agent's unmerged work starts. It is the agent's `base` (the commit it started from) until its first merge. After a merge it is the agent's work commit that was merged (see below).

### New exports

All of them take `repoRoot`, which is the main checkout's top folder (`prepareRepo().root`). The agent's `path` must be listed by `git worktree list --porcelain` for that root, and its branch must start with `workbench/`. Otherwise they refuse.

```js
// The agent's work as git objects. Never writes the agent's index or files.
snapshotWork({ repoRoot, path, since })
// -> { head, tree, since, workId, changed: boolean, files: [{ path, status, adds, dels, binary?, large? }], left: [{ path, why }] }
//    head: the agent folder's HEAD commit; tree: the work set as a tree id
//    workId: `${head}:${tree}`. It binds a card to exactly what it showed.
//    changed: tree differs from since's tree
//    status: 'added' | 'modified' | 'deleted' (no rename detection)

// The diff of the work set against `since`, for people to read.
workDiff({ repoRoot, path, since, maxFiles = 300, maxFileBytes = 200_000, maxTotalBytes = 2_000_000 })
// -> { workId, since, head, files: [{ path, status, adds, dels, binary?, large?, patch: string|null, cut?: true }], left, cut?: true, omitted: number }
//    patch: a unified diff of that one file (`diff --git` header included), made with
//    --no-ext-diff --no-textconv --no-color --no-renames and core.quotePath=false; null for binary or large files
//    cut: the patch was cut at maxFileBytes, or the whole list at maxTotalBytes; omitted: files beyond maxFiles

// Commit the work on the agent's branch, then join it into the person's current branch with a merge commit.
mergeWork({ repoRoot, path, branch, since, expect: { workId, into, intoHead }, message: { subject, body }, agentId, harness })
// -> { ok: true, into, merge, work, files, adds, dels }
//      merge: the merge commit id (now the person's HEAD); work: the agent's work commit (the merge's second parent)
//  | { ok: false, why, sentence, paths? }
//      why: 'detached' | 'busy' | 'identity' | 'git-old' | 'changed' | 'moved' | 'nothing' | 'ancestry' | 'conflict' | 'blocked' | 'gone' | 'git'

// Remove the agent's folder and branch, keeping a hidden copy of its work.
discardWork({ repoRoot, path, branch, since, expect: { workId }, agentId })
// -> { ok: true, saved: 'refs/workbench/discarded/<agentId>' } | { ok: false, why, sentence }

// The commit graph for the git screen.
gitGraph({ repoRoot, limit = 200 })
// -> { ok: true, head, branch, commits: [{ id, parents: [id], subject, author, at, refs: [name], agentId: string|null, kind: 'commit'|'merge'|'work' }], more: boolean }
//    newest first in topological order: HEAD plus every refs/heads/workbench/* branch, at most `limit` commits
//    refs: short branch names pointing at the commit ('main', 'workbench/search-cleanup-a1b2c3')
//    agentId and kind come from the commit's own trailers (below), never from its subject

// Who commits: the person's configured identity, or null.
gitIdentity({ repoRoot }) // -> { name, email } | null   (both user.name and user.email must be set; git's guessed identity never counts)
```

### `mergeWork` steps, in this order (each refusal changes nothing)

1. Read the repository afresh, without trusting `repoInfo`:
   - Refuse `detached` when HEAD is not on a branch.
   - Refuse `busy` when a merge, rebase, cherry-pick, revert or bisect is under way (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, all checked with `git rev-parse --git-path`).
   - Refuse `identity` when `gitIdentity` is null.
   - Refuse `git-old` when git is older than 2.38.
   - Refuse `moved` when the branch or HEAD is not `expect.into` and `expect.intoHead`.
2. Run `snapshotWork`. Refuse `changed` when `workId !== expect.workId`, and `nothing` when `!changed`.
3. **Ancestry guard.** Refuse `ancestry` when `since` is not an ancestor of the person's HEAD (`merge-base --is-ancestor`). Otherwise the merge would bring in another branch's commits.
4. **The work commit W.** If the tree differs from the agent's HEAD tree, run `commit-tree <tree> -p <agent HEAD>` with the message below. Then:
   - move the agent's branch with `update-ref refs/heads/<branch> W <agent HEAD>` (compare-and-swap);
   - run `git -C <path> reset -q`, so the agent's index matches and its folder shows clean.

   Otherwise W is the agent's HEAD.
5. Refuse `nothing` when W is already an ancestor of HEAD.
6. Run `merge-tree --write-tree --name-only -z <HEAD> <W>`, without `--merge-base`:
   - exit 0 with a tree id: clean;
   - exit 1 with a tree id: refuse `conflict`, with the conflicted `paths` taken from the `-z` records;
   - anything else: `git`.

   Nothing is written to the person's folder in any case.
7. **The merge commit M.** Run `commit-tree <tree> -p <HEAD> -p <W>` with the message below.
8. Check the branch and HEAD again. Then, in the main folder, run:

   `git -c core.hooksPath=<empty temp dir> merge --ff-only --no-autostash --no-overwrite-ignore --no-verify-signatures -q <M>`

   - Exit 0: done.
   - Exit 1: refuse `blocked`, with the `paths` the person's own changes or files are in the way of. They are parsed from the tab-indented lists under "would be overwritten by merge" and "would lose untracked files". W stays on the agent's branch, which is fine.
   - Exit 128: refuse `moved` or `busy`.

   Never run a non-fast-forward `git merge` in the main folder. Never run `update-ref` on a checked-out branch.
9. Return `{ ok: true, into, merge: M, work: W, files, adds, dels }`. From now on the engine uses W as the agent's `since`.

Messages:

- **W:** `<subject>` on the first line. Then a blank line and `<body>` (the agent's own summary, if any). Then the trailers:
  - `Workbench-Agent: <agentId>`;
  - `Workbench-Kind: work`;
  - `Co-authored-by: Claude <noreply@anthropic.com>`, only for a Claude Code agent.
- **M:** `Merge <Name>: <subject>`. Then a blank line, `Workbench-Agent: <agentId>` and `Workbench-Kind: merge`.
- **Author and committer:** the person's identity. Never git's guessed identity.
- **`subject`:** made by the engine from the task. It is the first sentence, its first letter capitalised, cut at a word boundary to at most 72 characters.

Commits made here never run hooks, because `commit-tree` runs none. Every git command that runs in the main folder also gets `-c core.hooksPath=<empty temp dir>`. Clean and smudge filters and merge drivers from `.git/config` can still run during the checkout step. That is a documented limit: setting them needs the person's OK.

### `discardWork` steps

1. Run `snapshotWork` and require `workId === expect.workId`.
2. Make a snapshot commit S (`commit-tree <tree> -p <head>`), then run `update-ref refs/workbench/discarded/<agentId> S`.
3. Run `worktree remove --force <path>`, using `--force --force` only when the worktree is locked.
4. Run `update-ref -d refs/heads/<branch> <head>`. If the branch exists but its folder is already gone, still delete the branch.
5. Return `{ ok: true, saved }`. Failures are plain sentences; none is swallowed.

### `diffStats` and the tidy after a merge

- `diffStats({ path, base })` keeps its signature. The engine passes `since ?? base` as `base`.
- `removeWorkspace(... onlyIfUnchanged, base)`, also used by the shutdown tidy, receives `since ?? base`. A merged agent whose folder has not changed since is then removed at shutdown, together with its branch.

Tests (`test/workspace.test.mjs`) use temporary repositories and `HOME`. They cover:

- **The work set:** untracked, deleted and staged files; a symlink pointing outside the folder; a `.gitignore` the agent changed; a nested repository. The agent's `ls-files -s` and `status` are unchanged after `snapshotWork`, `workDiff` and a refused merge.
- **A clean merge:** M has two parents, the person's folder is at M, and their unrelated dirty file is byte-identical afterwards.
- **A merge refused for each `why`:**
  - `conflict`: the person's folder is unchanged and holds no markers;
  - `blocked`: by a dirty file, and by an untracked file in the way;
  - `detached`, `busy` (MERGE_HEAD), `identity` (empty HOME, no config), `moved`, `ancestry`, `nothing`.
- **Two merges in a row:** the second merges only the new work.
- **Safety:**
  - an ignored `.env` in the person's folder survives a merge that adds `.env`, which is refused as `blocked`;
  - `merge.autoStash=true` in the person's config does not change the outcome;
  - a `post-merge` hook and a `pre-commit` hook do not run.
- **Throw-away:** the branch is deleted by compare-and-swap, the hidden ref is kept, and a locked worktree is handled.
- **`gitGraph`:** the trailers become `agentId` and `kind`, and `refs` are correct.
- **Isolation:** nothing is written to the real home folder.

## 2. Engine, store, history, server (builder B)

Owned files: `src/core/engine.mjs`, `src/core/store.mjs`, `src/core/history.mjs`, `src/shared/events.mjs`, `src/server/http.mjs`, and their tests: `test/engine.test.mjs`, `test/history.test.mjs`, `test/http.test.mjs`, `test/store.test.mjs`, `test/shared.test.mjs` and `test/helpers/engine-fakes.mjs`. The live-chain cases for merge and throw-away against real git (`test/live-fake.test.mjs`) are written at integration, once builder A's code is in.

### Events and the view

- New event `EV.WORK = 'agent.work'`, with the shape `{ agentId, work }`. `work` replaces `view.work` as a whole.
- New AgentView field `work`, which is `null` for helpers, for demo agents without git, and before a root has a folder:

```js
work: {
  branch: 'workbench/search-cleanup-a1b2c3',  // its branch; null once thrown away
  from: 'main',            // the person's branch when it started (recorded at launch; null if detached or unknown)
  folder: true,            // its folder is still there
  merged: { into: 'main', merge: '<sha>', at: ms, files: 3, adds: 40, dels: 2 } | null,  // the last successful merge
  problem: { why: 'conflict'|'blocked'|'ancestry'|'moved'|'identity'|'detached'|'busy'|'git', sentence, paths: [], at: ms } | null,
  thrownAway: { at: ms, saved: 'refs/workbench/discarded/<id>' } | null,
}
```

- `problem` is set by a failed merge. It clears on the next successful merge, on any turn start, on a message the agent takes, and when the agent is thrown away.
- `files` after a merge is `{ changed: 0, adds: 0, dels: 0, list: [] }`, because nothing is unmerged.
- Store: reduce `agent.work`; `restore()` puts `work` back from history; `newAgentView` gets `work: null`.
- `EV.SESSION` gains an optional `version` (the harness version, from Claude Code's `system/init` `claude_code_version`; builder E emits it).

### Run record, history, tidy

- `run.workspace` is `{ path, branch, base, since, from }`:
  - `since` starts as `base` and becomes W after each merge;
  - `from` is `prepareRepo(root).branch` at launch.
- The receipt's `diffStats` and the tidy use `since`, as described in section 1.
- History records keep `workspace.since`, `workspace.from` and `work`, field by field. Loaded values are cleaned: shas are 40 or 64 hex characters, and branches must start with `workbench/` and pass `validRef`.
- After a throw-away: `run.folderRemoved = true`, and an earlier agent's record gets `workspace: null`. `canContinue` becomes false with the reason "Its work was thrown away, so it cannot continue."

### Public engine methods (all return `{ ok?, reply, ... }`; refusals are `{ ok: false, reply }`)

```js
changes(agentId)          // -> { ok: true, agentId, name, branch, into, live, diff } | { ok:false, reply }   read-only, posts no notice
gitGraph()                // -> { ok: true, repo, commits, more, agents }  (see "Git screen data") | { ok:false, reply }
proposeMerge(agentId, { state })    // -> { reply, confirm } | { ok:false, reply }   never merges by itself
proposeDiscard(agentId, { state })  // -> { reply, confirm } | { ok:false, reply }
```

- `changes` works in any state for a root with a folder. `live: true` while the agent is active, and then the page says its work may still change. A helper's id resolves to its root. In demo mode the simulator answers it (section 6).
- `proposeMerge`:
  - **Refusals, in plain words:**
    - in the demo: "This is the demo, so nothing is really merged.", unless the simulator handles it;
    - a helper: "Helpers work in their agent’s folder. Merge the agent instead.";
    - an active agent, or one with a receipt being built: "<Name> is still working. Merge it when it is done.";
    - no folder: "Its folder is gone, so there is nothing to merge.";
    - an agent being merged or thrown away right now: "<Name> is being merged now.";
    - the `state` the page saw differs: "That changed. Have another look.";
    - nothing to merge: "<Name>’s work is already in <into>.";
    - and the git refusals below, after a fresh `prepareRepo` and `snapshotWork`.
  - **The card it returns:**
    - `{ id, kind: 'merge', sentence: 'Merge <Name> into <into>?', detail, yes: 'Merge', no: 'Cancel', danger: false }`;
    - `detail` gives the counts first: "3 files, +40 −2. Its work becomes a commit on its branch, joined into main by a merge commit.";
    - then, when they apply: "A check failed: unit tests.", "Nothing checked its work.", "It broke a rule you set: Do not touch migrations/.", "It changes workbench.json, which sets the checks for later agents." (also for `.claude/` and `.mcp.json`), "2 files stay out: hidden by a .gitignore.", and "Your 2 uncommitted changes stay as they are.";
    - the stored confirm keeps `{ agentId, expect: { workId, into, intoHead } }`.
- `proposeDiscard`:
  - its card is `{ kind: 'discard', sentence: 'Throw away <Name>’s work?', detail: 'Its folder and its branch <branch> are deleted, with 3 changed files. Workbench keeps a hidden copy in git.', yes: 'Throw it away', no: 'Keep it', danger: true }`;
  - an active agent is stopped first, and the detail then also says "It is still working: it will be stopped first.".
- `confirm(id, true)` for `merge` and `discard` is handled **before** the launch fall-through:
  - every check is repeated;
  - all git work runs through one engine-wide lock (a promise chain), with a `_busy` set per agent;
  - `_sendTo`, `_continueEarlier`, `stop` and `forget` refuse a busy agent with a plain sentence;
  - the agent is quiesced first: `_closeIdle(v)`, then `await run.checksDone`;
  - shutdown waits for git work under way (`_gitWork`), and no new git work starts once shutting down.
- `confirm(id, false)` gets the cancel replies "OK, I won’t merge it." and "OK, I won’t throw it away.".
- `confirmVerb` gives "merge it" and "throw it away".
- After a merge:
  - `agent.work` with `merged` set and `problem: null`, plus `agent.files` with the empty files, in one batch;
  - `run.workspace.since = W`, and the history is saved;
  - `repoInfo` is refreshed and the server is told: the store emits `repo`;
  - reply: "Merged <Name> into <into>." with `focusId`.
- After a failed merge: `agent.work` with `problem`, and the reply is that sentence.
- After a throw-away: `agent.work` with `thrownAway` and `folder: false`, the history is saved, and the reply is "Threw away <Name>’s work. Its folder and branch are gone.".
- Git refusal sentences, from the `why` values in section 1:
  - `detached`: "Your folder is not on a branch, so there is nowhere to merge it."
  - `busy`: "Your folder is in the middle of a merge or rebase. Finish that first."
  - `identity`: "Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again."
  - `git-old`: "Workbench needs git 2.38 or newer to merge."
  - `changed`: "<Name>’s work changed since you looked. Have another look."
  - `moved`: "<into> changed since you looked. Have another look."
  - `nothing`: "<Name>’s work is already in <into>."
  - `ancestry`: "<Name> started from a commit that is no longer in <into>, so merging it would bring in other work."
  - `conflict`: "<Name>’s work does not merge cleanly into <into>." The `paths` are kept on `problem`.
  - `blocked`: "Your own changes are in the way: <up to 3 paths>. Commit or put them aside, then merge again."
  - `gone`: "Its folder is gone, so there is nothing to merge."
  - `git`: "Git could not finish the merge. Nothing in your folder changed."
- `snapshot()`:
  - `repo` gains `identity: boolean` (from `gitIdentity`, read at start and on every refresh), and `engine.test.mjs`'s pinned `deepEqual` is updated;
  - `harnesses.claude` gains `version` when known.
- **Earlier spend on resume.** `_withEarlierSpend` must not add the earlier spend when the resumed process's harness `version` is 2.1.277 or newer: those versions restore the totals themselves. This is gated on `agent.session.version`; when the version is unknown, keep today's behaviour. Cover it with tests.

### Git screen data: `gitGraph()`

```js
{ ok: true,
  repo: { name, branch, head, dirty, identity },
  commits: [ ...from workspace.gitGraph ],
  more: boolean,
  agents: [ { id, name, state, earlier, harness, branch, from, base, since, files, work } ] }  // every root with a branch: this run's and earlier ones
```

Demo mode returns the simulator's synthetic graph (section 6).

### HTTP (`src/server/http.mjs`)

| Route | Calls |
|---|---|
| `GET /api/git` | `engine.gitGraph()` |
| `GET /api/agents/:id/changes` | `engine.changes(id)` |
| `POST /api/agents/:id/merge` `{ state }` | `engine.proposeMerge(id, { state: optState(b.state) })` |
| `POST /api/agents/:id/discard` `{ state }` | `engine.proposeDiscard(id, { state: optState(b.state) })` |

- `optState`: a known state name, else null.
- The SSE stream gains `event: repo`, sent when the store emits `repo`.
- `test/http.test.mjs` covers the new routes: the token and the 405s, a hook token refused, and the confirm round trip.

The confirm payload in every reply, and in `/api/command` replies, is `{ id, sentence, detail, kind, yes?, no?, danger? }`. `kind` is always present: `start`, `stop`, `say`, `forget`, `merge` or `discard`.

## 3. Words (`src/core/commands.mjs`, builder C)

Owned files: `src/core/commands.mjs`, `test/commands.test.mjs`.

| Intent | Words | Engine |
|---|---|---|
| `{ kind: 'changes', agentId }` | "what did search cleanup change", "what changed" (focused), "show me the changes", "show search cleanup's changes", "diff it" | read-only; the reply carries `review: agentId`, and the page opens the git screen on that agent |
| `{ kind: 'merge', agentId }` | "merge search cleanup", "merge it", "land it", "bring its changes in", optional "into main" or "into my branch" | always a merge card |
| `{ kind: 'discard', agentId }` | "throw away search cleanup's changes", "discard it", "throw it away", "scrap it" | always a discard card |

**Merge and throw-away references** must *name* the agent:

- its id, a pronoun for the focused root, or its name's words that **no other root** (ended and earlier included) also has;
- otherwise the words keep their old meaning: "merge the two config files" stays a task;
- two roots with the same name give `agentId: null`, and the engine asks which one;
- task or state words alone never pick an agent for these;
- a helper's id maps to its root.

**Strength:** a pronoun is weak. "merge it" while a question waits is the answer to it. A full name is strong.

**Card words:**

- "start it" and "launch it" are a yes only to a launch, never to forget, merge or discard;
- "merge it", "merge" and "land it" are a yes to a merge card;
- "throw it away" and "discard it" are a yes to a discard card;
- on a discard card a bare "yes" is **not** enough: only the button, "throw it away", "discard it" or "do it" count;
- "forget it" stays a cancel everywhere.

Fix the `launchNoun` hole for stop and forget: "stop an agent to fix the login" is a launch, not a stop of "Login fix". `describeIntent` covers the new kinds. All of it is pinned in tests, with dogfood-style names: "Merge command", "Diff viewer", "Git screen".

## 4. The page (builders D1 and D2)

### D1: the git screen, the DRAM and the transition

Owned files:

- new: `ui/gitgraph.js` (pure), `ui/diffview.js` (pure), `ui/gitscreen.js` (DOM);
- `ui/index.html`, `ui/layout.js`, `ui/board.js`;
- the git-screen part of `ui/app.js` (screen switching only) and a new section at the end of `ui/app.css`;
- tests: `test/ui-gitgraph.test.mjs`, `test/ui-diffview.test.mjs`, `test/ui-layout.test.mjs`;
- in `scripts/ui-mock.mjs`: the `git` scenarios and the `GET /api/git` and `GET /api/agents/:id/changes` routes;
- in `scripts/ui-fit-check.mjs`: the views `git`, `git-detail` and `git-empty`.

**The DRAM on the board.**

- It is a DRAM package, `#dram`, a `<button>`: a long rectangle with a fine row of pins along its long edges, a notch, a designator (`U2`), and **git** printed large on its body.
- A short parallel bus of 6 to 8 thin traces joins it to the core's bottom edge.
- Place it centred below the core. The layout reserves room for it in every size class (S, M, L) and in dense mode, and the core's maximum height shrinks by that room.
- The line under the core (`#said`) moves under the DRAM.
- A single wire runs from the DRAM's bottom edge to the board's bottom edge, and the machines connector leaves a gap for it. With one machine, the section goes left of the wire.
- `boardProblems()` covers the DRAM, its bus and its wire (no overlap with chips, lanes, pads, machines, the tray or `#said`).
- Hover and focus warm its copper. Its accessible name is "Git: your branch <branch> and your agents’ branches. Opens the git screen."

**The transition.**

- The page becomes two full-window screens stacked vertically: `#boardScreen` (everything that exists today) and `#gitScreen`.
- Opening the git screen means: clicking `#dram`, pressing Enter or Space on it, typing or saying "git", "show git", "open git", "source control" or "show the graph" (a `pageCommand()` in `prefs.js`, never sent to the engine), or a reply carrying `review` (see below).
- The view travels down the wire over about 900 ms (ease-in-out):
  - a pulse runs along the wire from the DRAM to the bottom edge;
  - both screens slide up together;
  - the wire continues from the top edge of the git screen to the HEAD node.
- Going back reverses it. Back is "Back to the board" (top-left on the git screen), Esc when no detail is open, the wire's top end on the git screen, or the words "board" or "back".
- With `prefers-reduced-motion`, and with `still=1`, the screens swap at once.
- The screen not shown is `inert`, `aria-hidden` and `visibility:hidden` once the move ends. The fit check then sees one screen at a time.
- Focus goes to the git screen's heading on the way down, and back to `#dram` on the way up.
- The lid keeps holding while the git screen is shown: `engaged()` is true.
- The address never changes, and nothing in the address opens the git screen.

**The git screen** (`#gitScreen`) uses the same board surface and looks (green, black and gold, ivory) and the same JetBrains Mono.

- **Top band:**
  - the git mark;
  - `<repo> · <branch>` with the HEAD short id;
  - your folder's state: "2 uncommitted changes in your folder", or "Your folder is not on a branch";
  - a warning when `repo.identity` is false: "Git does not know your name and email yet, so Workbench cannot merge.";
  - "Back to the board";
  - a lit "<Name> needs you" button when anything needs the person. It goes back to the board and puts that item in the lid.
- **The graph** (`ui/gitgraph.js`, pure; `graphLayout({ commits, agents, branch, head, width, height }, P)`):
  - It returns `{ rows, lanes, nodes, edges, trunkX, rowH, w, h }` in CSS pixels.
  - **Rows:** one row per commit, newest at the top. Each agent with unmerged work gets one more row at the top of its branch, its *work node*: a hollow, dashed via labelled with the agent's state mark and "not merged yet · 3 files", or "working".
  - **Lanes:**
    - the trunk is your branch's first-parent chain, as a thick gold bus;
    - other lanes are copper traces placed outward, alternating right and left, so branches **spread out** as they go down;
    - the lane pitch is generous: 56 to 112 px, depending on the width.
  - **Edges:** a line that changes lanes does so with 45° bends, like the board's traces.
  - **Node kinds:**
    - your commits: gold vias;
    - an agent's work commits: small chips carrying the agent's mark;
    - merge commits: larger square pads;
    - HEAD: a pad with HEAD in silkscreen.
  - **Text:**
    - rows hold their text in a column to the right of the graph, as VS Code does: subject, then "who · when · short id" muted;
    - text never overlaps, and the column clips at a word boundary, with the full text in `title`;
    - a commit with `agentId` reads "<agent name>" for who.
  - **Too many lanes:** past `maxLanes` (what the width allows), extra lanes fold into the outermost lane with a "+N" marker. Rows past the window scroll inside the graph's own scroll box (`data-scroll`).
- **Detail** (`#gitDetail`, a panel at the right that covers the text column; the graph stays visible), opened by selecting a node or an agent's lane label:
  - **An agent's branch or work node:**
    - its mark and name, its state words, and "On its branch <branch>, from <from> at <short>";
    - its counts and the files left out;
    - its actions, as big buttons bound like the lid's: **Merge into <branch>** (primary) and **Throw it away**, shown only when they apply (see D2's rules);
    - a merge or throw-away card from the engine is shown in place of the actions, with its own `yes`/`no` labels;
    - `problem.sentence` and its `paths`, when set;
    - the diff (`ui/diffview.js`) in one scroll box, fetched from `GET /api/agents/:id/changes` when opened.
  - **Any other commit:** subject, author, time, full id, parents, and "Made by <agent>" when it has `agentId`.
  - Esc closes the detail and returns focus to the node.
- **The diff** (`ui/diffview.js`, pure; `diffHtml(diff, { maxLines = 4000 })`):
  - each file gets a header (path, +a −d, or "new file", "deleted", "binary file", "too large to show here");
  - lines start with visible `+` and `−` gutter marks, plus words for screen readers, with add and delete colours that never carry meaning alone;
  - long lines wrap (`white-space: pre-wrap; overflow-wrap: anywhere`), so nothing scrolls sideways;
  - past `maxLines`, the rest is "and 1,240 more lines";
  - `left` files are listed as "Not merged: hidden by a .gitignore it changed";
  - everything goes through `esc()` plus the visible-controls rule (bidirectional and zero-width characters included).
- **Keyboard:**
  - the graph is one tab stop (`role="listbox"`, roving focus);
  - ↑ and ↓ move between rows, Enter opens the detail, Home and End jump, and Esc closes the detail, then goes back;
  - letters typed on the git screen go to a small input on its top band. It sends `/api/command` exactly as the core's input does, with `focusId` set to the agent whose detail is open.
- **Data:** fetch `GET /api/git` on open, on an SSE `repo` event while open, and when an `agents` event changes any root's `work` or `state` while open. Nothing repaints at rest.

**The mock (D1's part):** scenarios `git` and `git-many` (40 or more commits, 6 agent branches, a long branch name, bidirectional characters in a subject), `git-empty` (no commits beyond the initial one) and `git-detached`. Routes `GET /api/git` and `GET /api/agents/:id/changes` serve a stress diff: CRLF, tabs, a 400-character line, binary, large, deleted, left-out files, U+202E, and a long path.

### D2: the lid, the confirm cards and the checks

Owned files:

- `ui/focus.js`, `ui/words.js`, `ui/model.js`, `ui/queue.js`, `ui/card.js`, `ui/look.js`, `ui/api.js`;
- the action handlers in `ui/app.js` (`merge`, `discard`, `review`, and confirm kinds), and a separate section at the end of `ui/app.css`;
- in `scripts/ui-mock.mjs`: the POST routes for merge and throw-away, confirm kinds, and `mode.merge` refusals;
- `scripts/ui-behaviour-check.mjs`;
- the merge and throw-away card views in `scripts/ui-fit-check.mjs`;
- tests: `test/ui-focus.test.mjs`, `test/ui-history.test.mjs`, `test/ui-queue.test.mjs`, `test/ui-words.test.mjs`.

**When merge applies:** live mode (`S.meta.mode === 'live'`), a root, not active, `work.folder`, `!work.thrownAway`, `repo.branch` set, and unmerged work, where `files.changed > 0`, or `files` is null for stopped, failed and earlier agents.

**The lid:**

- **`done_checked` and `done_claimed` with unmerged work, when merge applies:**
  - big **Merge into <branch>** (primary; the branch is cut in the middle past 16 characters, with all of it in `title`) and **Ask for a change**;
  - quiet **Review the changes** and **Not now**. "Not now" does what "Looks good" does today.
  - Review is shown in calm too, and at every fit level.
- **When it does not apply:** today's **Looks good** and **Ask for a change**. If the reason is about git (not on a branch, or no identity), a meta line says it in the engine's words.
- **`checks_failed`:** today's buttons, plus quiet **Review the changes** and quiet **Merge anyway** (it goes through the same card, whose detail names the failed check).
- **`failed`, `stopped` and earlier agents with a folder:** today's buttons, plus quiet **Review the changes**. Merge and throw-away are in the git screen's detail.
- **Merged, nothing new:** "<Name>’s work is in <into>." Meta: "Merged 2 min ago · 3 files". Big **See it in git** (primary) and **Ask for a change**. It is out of the review queue once merged.
- **`work.problem`, persistent until it clears:**
  - `conflict`: "<Name>’s work does not merge cleanly into <into>." Meta: "Both changed: a.js, b.js". Big **Ask it to bring in <into>**, which sends "Your work conflicts with the latest <into> in: a.js, b.js. Please merge <into> into your branch, resolve the conflicts, and finish." Second big button: **Look later**.
  - `blocked`: "Your own changes are in the way." Big **Try again** (proposes the merge again) and **Not now**.
  - Others: the sentence, with **Try again** and **Not now**.
- **Thrown away:** "<Name>’s work was thrown away." Big **Dismiss**.
- The lid key includes a work signature: merged, problem and thrown-away state. That way an outcome swaps the page, and the guard arms.
- **Binding:** Merge, Merge anyway and Try again post `POST /api/agents/<id>/merge { state }`, and Throw it away posts `POST /api/agents/<id>/discard { state }`. Both go through `GUARDED`, busy and retry, and `changed()` on a stale state. Review the changes posts nothing: it opens the git screen with that agent's detail.

**Confirm cards:**

- They show `yes` and `no` when given (default "Do it" and "Cancel").
- The count line follows `kind`: launch "You said"; merge "Before it merges"; throw-away "Before it is thrown away"; forget "Before it is forgotten".
- A `danger` card has no primary button (equal weight, like Allow and Deny), and keeps its `detail` at every fit level up to 5. At level 6 the detail goes under "See all of it".

**The card (`card.js`):** "Merged into main · 2 min ago" or "Not merged yet" on the Now line's second row, in "more" detail.

**Checks:**

- **`ui-behaviour-check`** covers:
  - Merge posts the agent and state it was drawn for;
  - a click during a swap is ignored;
  - a stale state gives `changed()` and no post;
  - the merge card's yes and no post `/api/confirm/<id>`;
  - Throw it away always asks;
  - Review opens the git screen on that agent, and Esc comes back to the lid with focus on the link;
  - the DRAM opens the git screen and "Back to the board" returns;
  - while the git screen shows, something new needing you lights the top band's button.
- **`ui-fit-check`** gets the views `merge-card`, `discard-card`, `merge-conflict` and `merge-blocked`, plus the git views from D1.
- **The `scripts/ui-mock.mjs` scenario `merge`:** a live repo on `main`, with these done agents: unmerged, merged, conflict, blocked, thrown away, and earlier with a folder.

## 5. Dogfooding (builder E)

Owned files:

- `bin/workbench.mjs`;
- `src/adapters/claude/*` and `src/adapters/codex/*`;
- `src/core/receipt.mjs`, for the checks' PATH only;
- `scripts/accept-real.mjs`;
- `package.json`, and new at the repo root: `package.json`, `workbench.json` and `CLAUDE.md`;
- tests: `test/claude-*.test.mjs`, `test/codex-*.test.mjs`, `test/workbench-cli.test.mjs`, `test/helpers/claude-fake.mjs`, `test/helpers/codex-fake.mjs`, `test/receipt.test.mjs`.

**Finding Claude Code.** Add a `--claude <path>` flag. Then fall back in this order: `WORKBENCH_CLAUDE_BIN`, then `claude` on PATH, then the newest `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` (also `~/.vscode-insiders` and `~/.cursor`). Resolve it again at each launch.

- `available()` reports `{ ok, version, path, from: 'flag'|'env'|'path'|'vscode' }`.
- The CLI prints "Claude Code 2.1.322 is ready (from the VS Code extension)."
- A clearer error names `--claude` and `WORKBENCH_CLAUDE_BIN`.
- A path that does not exist gets its own reason.

**Node for agents and checks.** When `node` is not on PATH, prepend `dirname(process.execPath)` to PATH for agents and checks. That keeps `npm test` and `node --test` working and auto-approved.

**No nested Workbench.**

- `bin/workbench.mjs` refuses live mode when `WORKBENCH_AGENT_ID` is set: "Workbench is running inside an agent. It will not start real agents from there." Demo mode is fine.
- `scripts/accept-real.mjs` refuses the same way.
- Agents' environment loses `WORKBENCH_CLAUDE_BIN` and `WORKBENCH_CODEX_BIN`, and the editor-host variables (`VSCODE_*`, `ELECTRON_RUN_AS_NODE`, `GIT_EDITOR`).
- The live-fake tests must still pass. They delete `WORKBENCH_AGENT_ID` from the environment they give the CLI.

**Claude Code 2.1.322.**

- Add `SendFile`, `SendToProject`, `PublishPlugin`, `ListAgents` and `WrapUp` to `DISALLOWED_TOOLS`, and update the four pinned places.
- Record `claude_code_version` and `tools` from `system/init`: emit `agent.session { sessionId, version }`, and log the tools once.
- Keep `--permission-mode default` (still accepted).

**Startup.**

- Fix "could not be found.." (a doubled full stop).
- When `gitIdentity` is null, print: "Git does not know your name and email yet. Agents can work, but Workbench cannot merge their work until you set them: git config --global user.name "Your Name" and git config --global user.email you@example.com".

**Repo-root files.**

- **`package.json`** (private, no dependencies), with these scripts:
  - `"test": "npm --prefix workbench test"`;
  - `"demo": "node workbench/bin/workbench.mjs --demo"`;
  - `"dogfood": "node workbench/bin/workbench.mjs --repo ."`.
- **`workbench.json`:** the check `{ "name": "tests", "run": "npm test", "timeoutSec": 600 }`, and the rules "Do not change the research and mockups in docs/" for `docs/**`, and "Add no packages" for `**/package-lock.json` and `**/node_modules/**`.
- **`CLAUDE.md`,** for agents working on Workbench itself:
  - what it is;
  - that `workbench/ARCHITECTURE.md` is the contract and must change with the code;
  - the rules above;
  - "run the tests with `npm test` at the repo root";
  - plain language;
  - never start a live Workbench or `accept-real` from inside an agent;
  - the UI checks need Chrome.

**Acceptance.** `scripts/accept-real.mjs` gains merge and throw-away steps against the throwaway repo, and deletes the branch it made.

## 6. Demo (builder F)

Owned files: `src/adapters/sim/simulator.mjs` and `test/simulator.test.mjs`.

The simulator gets optional methods. The engine calls them in demo mode when they are there:

- `sim.gitGraph()` returns a believable synthetic graph in the same shape as `gitGraph()`: about 30 commits by "you" and by seeded agents, two merged agent branches with merge commits, and branches for the seeded done agents with unmerged work;
- `sim.changes(agentId)` returns a small synthetic diff in `workDiff` shape;
- `sim.proposeMerge(agentId)`, `sim.merge(agentId)` and `sim.discard(agentId)` simulate the outcomes. Merge always succeeds for "Invoice export" and gives a `conflict` for "Help pages", so the demo shows both.

Demo replies say plainly that nothing real happened: "This is the demo: nothing was really merged."
