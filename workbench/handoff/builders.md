# Builder briefs

These are the exact prompts that started the seven builders, as a Claude Code workflow script. `COMMON` is shared by all of them, and `SANDBOX()` is added for the two UI builders. On the cloud machine, change three things: use the Node on PATH, take the maps from `workbench/handoff/maps/<area>.json` instead of `/tmp/wb-maps/areaN.json`, and drop the sandbox part (run the Chrome checks locally, if Chrome can be installed). The maps line up like this: area4 = git-core, area2 = engine, area5 = server-cli-claude, area1 = commands, area0 = ui-lid, area3 = ui-checks.

```js

export const meta = {
  name: 'build-source-control',
  description: 'Seven builders implement the source-control spec in parallel worktrees (git core, engine, words, git screen, lid, dogfooding, demo)',
  phases: [{ title: 'Build', detail: 'one builder per area, each in its own git worktree, committing its work' }],
}

const COMMON = `You are a builder on "Workbench". Your current working directory is a fresh git worktree of /Users/nkov47/IDE (branch made for you; the program lives in ./workbench). The interface you build against is ./workbench/SPEC-source-control.md: read ALL of it first (other builders build the parts you talk to), then the parts of ./workbench/ARCHITECTURE.md and ./workbench/README.md that touch your files, then your own files in full.

RULES
- Edit ONLY the files your section of the spec says you own. If another builder's file must change, do NOT edit it: describe the exact change under "needs" in your report.
- Node is not on PATH. Start every shell command that runs node or npm with: export PATH="$HOME/.local/opt/node-v26.13.1-darwin-arm64/bin:$PATH";
- Before you finish, run the whole suite: cd workbench && npm test (about 25 s). It must pass, except tests that fail only because another builder's part is not there yet; name each such failure in your report.
- Never start a real claude or codex. Tests need no network and use temporary folders and a temporary HOME, like the existing ones. Never depend on this machine's git identity (it has none): set GIT_AUTHOR_*/GIT_COMMITTER_* or -c user.name/-c user.email in tests.
- Plain language in anything a person sees; use the spec's words exactly where it gives them. No third-party packages.
- Write tests with the code, in the existing style (node:test, node:assert/strict). Pin the spec's words.
- This code will merge into people's real repositories and show their work: be careful and thorough, and refuse with a plain sentence rather than guess.
- Never change git config. When done (and at sensible points before), commit in THIS worktree only:
  git add -A && GIT_AUTHOR_NAME="Workbench cloud builder" GIT_AUTHOR_EMAIL="builder@workbench.local" GIT_COMMITTER_NAME="Workbench cloud builder" GIT_COMMITTER_EMAIL="builder@workbench.local" git commit -q -m "<what you built>"
  Do not push, do not switch branches, do not touch other worktrees or /Users/nkov47/IDE itself.
- Your final answer is a structured report (it goes to the integrator, not to a person): be exact and complete.`

const SANDBOX = (n, name) => `
BROWSER CHECKS: you have Linux sandbox ${n} with headless Chrome for the page checks (only sandbox ${n} is yours). The helper is ~/.workbench-ide-aws/sbx:
  ~/.workbench-ide-aws/sbx push ${n} "$(git rev-parse --show-toplevel)" ${name}     # copies this worktree's tracked and new unignored files (never docs/ or .env) to ~/w/${name}, replacing what was there
  ~/.workbench-ide-aws/sbx run ${n} ${name} '<command>'                                # runs in ~/w/${name}/workbench, with CHROME_BIN set and node 26
  ~/.workbench-ide-aws/sbx pull ${n} '<remote path>' <local folder>                     # copies files back
Examples: sbx run ${n} ${name} 'node scripts/ui-fit-check.mjs --scenario git --quick'; screenshots: sbx run ${n} ${name} 'node scripts/ui-shots.mjs /tmp/shots' (add your own SHOTS entries) then sbx pull ${n} /tmp/shots /tmp/${name}-shots and LOOK at the PNGs with the Read tool. Push again after every change. Iterate on what you see until it is right: the look matters as much as the checks.
A baseline of the Chrome checks on the unchanged code is being run; when it is ready it is at ~/.workbench-ide-aws/baseline.txt (it may appear after you start). Failures listed there predate your work.`

const REPORT = {
  type: 'object',
  properties: {
    builder: { type: 'string' },
    branch: { type: 'string', description: 'git rev-parse --abbrev-ref HEAD in your worktree' },
    worktree: { type: 'string', description: 'absolute path of your worktree' },
    headCommit: { type: 'string', description: 'git rev-parse HEAD after your last commit' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    tests: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' }, failures: { type: 'array', items: { type: 'string' } } }, required: ['command', 'passed', 'failed', 'failures'] },
    browserChecks: { type: 'string', description: 'what you ran in the sandbox and the results (UI builders), else empty' },
    deviations: { type: 'array', items: { type: 'string' }, description: 'where you differed from the spec, and why' },
    needs: { type: 'array', items: { type: 'string' }, description: 'exact changes needed in files you do not own' },
    contractNotes: { type: 'string', description: 'text to fold into ARCHITECTURE.md for your part: exact functions, shapes, rules and words' },
    openIssues: { type: 'array', items: { type: 'string' } },
  },
  required: ['builder', 'branch', 'worktree', 'headCommit', 'summary', 'filesChanged', 'tests', 'browserChecks', 'deviations', 'needs', 'contractNotes', 'openIssues'],
}

const BUILDERS = [
  { key: 'A-git-core', prompt: `You are builder A: section 1 of the spec (src/core/workspace.mjs and test/workspace.test.mjs). Notes on the current code, with verified git behaviour (merge-tree output formats on this git, data-loss traps): /tmp/wb-maps/area4.json. Local git is 2.54; the code must also work on git 2.38 or newer (Ubuntu 24.04 has 2.43): if an option you need is newer than 2.38, detect the version and refuse with 'git-old' when it is missing. Prove every safety rule in the spec with a test against real temporary repositories (first show the danger is real with plain git where the spec says so, then that your call avoids it), including: the person's ignored .env survives, merge.autoStash and hooks have no effect, a refused merge leaves the person's folder byte-identical and the agent's index untouched, a second merge takes only the new work, the throw-away keeps refs/workbench/discarded/<id>.` },
  { key: 'B-engine-server', prompt: `You are builder B: section 2 of the spec (engine, store, history, events, server and their tests). Notes on the current code: /tmp/wb-maps/area2.json (engine) and /tmp/wb-maps/area5.json (server, CLI). Builder A writes the git functions; you call them through deps.workspace and test with fakes in test/helpers/engine-fakes.mjs (guard each new call with typeof === 'function' so an older workspace module degrades to a plain refusal). Builder F adds optional simulator methods (sim.gitGraph, sim.changes, sim.proposeMerge, sim.merge, sim.discard): call them in demo mode when present. Mind the risks in the notes: unknown confirm kinds falling into the launch path, the held-request invariant, quiescing the agent (idle process, background commands, checks) before git work, one engine-wide lock, shutdown waiting for git work, follow-ups refused while busy, history records rebuilt field by field, a removed view not coming back from history, pinned tests that must be updated deliberately. Also the version-gated earlier spend (_withEarlierSpend) from the spec.` },
  { key: 'C-words', prompt: `You are builder C: section 3 of the spec (src/core/commands.mjs and test/commands.test.mjs). Notes on the current code: /tmp/wb-maps/area1.json. Keep every existing test passing; the new intents must never take over ordinary work ("merge the two config files", "discard unused imports", "show the error on the login page", "bring in an agent to fix the login") or answers to a waiting question/permission ("merge it" while a question waits is the answer; "sure, land it" at a permission stays what it is today). Pin a large table of positive and negative cases, including dogfood-style agent names ("Merge command", "Diff viewer", "Git screen") and same-named twins.` },
  { key: 'D1-git-screen', prompt: `You are builder D1: the git screen, the DRAM on the board and the transition (section 4, D1). Notes: /tmp/wb-maps/area0.json (the lid and page wiring) and /tmp/wb-maps/area3.json (the mock and Chrome checks). Look at the existing screenshots first (workbench/docs/screens/board-*.png, live-*.png and /Users/nkov47/IDE/docs/pcb/*.png) so the DRAM and the git screen belong to the same circuit board: deep mask, copper traces with 45 degree bends, gold for you, chips with fine pins, silkscreen labels, vias, mounting holes, JetBrains Mono. The owner described it like this: "There should be a DRAM looking object connected to the core in the main page which has the word git on it. And when you click it, it scrolls down by going through a wire that goes from the DRAM to the bottom, where it ends up in the git source control screen, where there is a graph tree connected by circuit lines, just like the VS Code git source control graph, but it branches downwards and spreads out." Build exactly that, in all three looks (green, black and gold, ivory), both detail levels and the size classes. Builder D2 edits ui/focus.js, ui/words.js, ui/model.js, ui/queue.js, ui/card.js, ui/look.js, ui/api.js and adds action handlers to ui/app.js; keep your app.js changes to screen switching and the git screen's own wiring, and put your CSS in a clearly marked section at the END of ui/app.css. Add the git views to ui-fit-check and make them pass; keep the board's existing checks passing at every size (the DRAM must not break any of them). Include screenshots of your result in your report's browserChecks (local paths of the PNGs you pulled).` + SANDBOX(1, 'd1') },
  { key: 'D2-lid-checks', prompt: `You are builder D2: the lid, the confirm cards and the behaviour checks (section 4, D2). Notes: /tmp/wb-maps/area0.json (the lid and page wiring) and /tmp/wb-maps/area3.json (the mock and Chrome checks). Builder D1 builds the git screen (ui/gitscreen.js and friends) and the screen switching in ui/app.js; to open the git screen on an agent you call the function D1 exports from ui/gitscreen.js — agree on it via the spec: openGit({ agentId }) and closeGit(); if it is not there yet in your worktree, call it through a guarded dynamic import or a tiny shim and say so in "needs". Put your CSS in a clearly marked section at the END of ui/app.css (D1 also appends a section). Keep the existing pinned behaviour checks passing (several pin "Looks good"; it stays wherever merge does not apply, including the demo and the mock's existing scenarios). Add the merge and discard scenarios and routes to scripts/ui-mock.mjs (D1 adds the git scenarios and GET routes there; append yours in a clearly separate block).` + SANDBOX(2, 'd2') },
  { key: 'E-dogfood', prompt: `You are builder E: dogfooding (section 5 of the spec). Notes: /tmp/wb-maps/area5.json (CLI, Claude Code adapter, compatibility with 2.1.322: every launch flag still exists, --permission-mode default is still accepted, the new tools, the nested-Workbench risk, the double period). The only Claude Code on this Mac is /Users/nkov47/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude: you may run it with --version or --help, never with -p and never a session. The repo-root files (package.json, workbench.json, CLAUDE.md) go in the worktree's top folder (the parent of ./workbench). workbench.json's check must work when node and npm are not on the person's PATH (the PATH rule in the spec makes them available to checks). In CLAUDE.md keep it short and practical for agents and for future sessions working on Workbench itself.` },
  { key: 'F-demo', prompt: `You are builder F: the demo (section 6 of the spec): src/adapters/sim/simulator.mjs and test/simulator.test.mjs. Read the simulator in full first. The synthetic graph must be deterministic for a seed, shaped exactly like the spec's gitGraph() result (commit ids as 40-hex strings, parents, subjects in the style of a real project, authors 'you' and the seeded agents' names, refs, agentId and kind from the same rules as real trailers), and consistent with the seeded agents (their names, states and files). The synthetic diff must look like a real unified diff for the files the agent's 'files' lists. Merge and throw-away outcomes go through the same events the engine uses for real agents (agent.work, agent.files), so the page needs no demo special cases.` },
]

phase('Build')
const reports = await parallel(BUILDERS.map(b => () =>
  agent(`${COMMON}\n\n${b.prompt}`, { label: `build:${b.key}`, phase: 'Build', schema: REPORT, isolation: 'worktree' })
))
return reports.map((r, i) => r ? { ...r, key: BUILDERS[i].key } : { key: BUILDERS[i].key, failed: true })
```
