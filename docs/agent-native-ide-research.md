# Reimagining the IDE for agentic coding: research report and product concept

10 November 2026

This report answers one question: if you designed a development environment for coding agents from a blank page today, what does the evidence say it should be?

**How it was made.** AI research agents gathered web sources on 10 November 2026. A second agent then re-opened each cited page and tried to refute the claim. 404 claims survived: 335 as written, 62 with corrections, and 7 whose source could not be re-opened, which are not relied on here. No person has checked the sources. "Vendor-reported" marks a company's figures about its own product. "Preprint" marks a paper that has not been peer reviewed.

Sections 1 to 8 are findings. Sections 9 to 12 are my proposal and are labelled as such.

## Bottom line

The evidence points at a different product from "a new editor with fewer tabs". Much of what you want turns out to be untested, not proven.

1. **Vendors now ship a session-centred view beside the file-centred editor.** Several are previews or opt-in, and adoption data is thin. Redesigns that pushed code inspection into the background drew vocal pushback.
2. **In the cost data available, the bill is mostly the prompt that is re-sent on every turn.** Each turn re-sends the whole conversation so far, and providers bill that at a discount if it was sent recently (the prompt cache). In short Claude Code benchmark runs (a vendor preprint), this re-sending was about 80% of cost. In the multi-turn tests found, add-on tools that trimmed search or tool output moved bills between -3% and +48%. Larger savings were measured by the tools' own authors, or came from one single-shot test in which far fewer patches applied.
3. **The cost levers with the best support sit inside the agent's own loop.** A product that wraps other vendors' agents sees cost only as far as each vendor exposes it. In the one estimate found, from short benchmark runs, it could influence about 6% of the bill. That is the central tension with "works with every existing tool".
4. **Sessions sit idle between messages for most of their life.** In one production trace the median session executed for 20% of its lifetime. The waste is idle time more than slow sandboxes.
5. **Agents misreport their own progress.** In a preprint covering 20,574 sessions, premature "done" claims were the third most common reason a developer pushed back. None of the status documentation opened describes an estimated time to completion.
6. **The better-measured cost is review.** A Harvard working paper estimates pull requests up about 36% and time to approval up about 56% after firms adopt agents. No controlled study was found showing that any way of presenting agent work helps people catch more bugs.
7. **"Fun" has thin evidence.** The nearest studies, from games, favour moderate feedback tied to success. Playful agent visualisers are popular, and no study was found showing they help.
8. **Standalone agent managers are consolidating fast.** Conductor joined Meta and is winding down, Ona joined OpenAI, and HumanLayer joined Factory.

**Recommendation.** The reimagined IDE is not an editor. It is the half of the job an editor was never designed for: directing agents, verifying what they did, and accepting or rejecting it.

Build a workbench that sits beside the editor people already use. It has two parts. A background program on the developer's machine records what each agent observably did: files changed per turn, commands run, checks passed or failed, cost. A small app shows three screens: what needs you, what happened, and review.

Start with the record and one output from it: a receipt for each turn that sets the agent's claim of "done" against what was observed. Build the window only if that receipt turns out to catch something.

**What this does not do.** It will not make Claude Code or Codex cheaper per turn. It does not manage cloud machines. It leaves your editor and its tabs in place and adds a smaller tool beside it. Its first build answers one of your asks, knowing what the agent did. And none of it is hard for a vendor to copy.

## Your assumptions against the evidence

| Your assumption | What the evidence says | What the proposal does |
|---|---|---|
| Most IDE chrome is unused | Untested. No recent data on panel use was found. Old studies show toolbars and menus little used and code reading dominant | Leaves the editor alone, starts with three screens and counts the use of every panel (sections 6 and 9) |
| Token waste is mainly search | Not supported as a cost claim. Reading and searching are roughly a quarter to a third of real tool calls and up to 76% of tokens in a minimal agent, but trimming them did not reliably cut bills | Ships no search or index tool by default, measures billed cost, and tests one targeted hand-off of files (sections 2 and 9) |
| A from-scratch IDE is the right vehicle | Not for an editor: Zed's took five years. Open for an agent-management app, where vendors disagree on the form | Builds nothing for writing code: a background program plus thin clients, with a read-only code view (sections 8 and 10) |
| Fun and engaging is good | Untested for professional tools | Speed first, restrained feedback on verified events, playful skins optional (sections 6 and 9) |
| I cannot tell what the agent did or how far along it is | Supported: agents' own completion claims are unreliable. Rarely raised in public complaints | A record built from observed facts, "done, claimed" kept apart from "done, checks passed", and no invented estimates (sections 4 and 9) |
| Notifications would save time and tokens | Untested. Some vendors are holding notifications back | One push: blocked on you while you are away. Everything else waits in a queue. Measured with the queue shown and hidden (sections 4 and 11) |
| Agents need efficient VMs | Idle time is the waste. In one pulse survey 69% of respondents ran a single agent | Fixes what worktrees leave unsolved: ports, environment files, caches. Defers VM tiers and sleep until measured, so this ask is mostly unanswered (sections 3 and 9) |
| It can work with every existing tool | Agents: yes, at several depths. Microsoft's extension marketplace and its own extensions: no | Two deep adapters, a standard protocol for the rest, and a published list of what each agent cannot show (sections 7 and 9) |

## Terms

- **Agent, harness.** The program that runs a model in a loop with tools, such as Claude Code or Codex. "Harness" means that loop and its settings.
- **Host.** An app that launches or observes someone else's agent. This proposal is a host.
- **Turn.** One user message and everything the agent does until it stops and waits.
- **Prompt cache.** Each turn re-sends the whole conversation so far, including files the agent read earlier. Providers charge much less for the unchanged front part if it was sent recently. Anthropic's cache entries last five minutes or one hour depending on the setting, and OpenAI's last roughly five to ten minutes of inactivity, or up to 24 hours where extended retention applies. After that, the next message pays to write the cache again. This report calls that a cold resume.
- **Compaction.** Replacing old conversation history with a summary when the context fills up.
- **Sub-agent.** A second agent started by the first. "Forked" means it starts with a copy of the parent's whole conversation.
- **Worktree.** A second checkout of the same git repository in another folder.
- **MCP server.** A small program that offers extra tools to an agent.

## 1. Where the field stands

The ten vendors below each shipped or previewed an agent-management view in 2026. They disagree about where it belongs.

| Placement | Product | What shipped | Date |
|---|---|---|---|
| Separate app | [Google Antigravity 2.0](https://antigravity.google/blog/introducing-google-antigravity-2/) | Standalone desktop app; "there is no IDE"; meant to run beside an editor | 19 May |
| Separate app | GitHub Copilot app | A ["My Work" view](https://github.blog/news-insights/product-news/github-copilot-app-the-agent-native-desktop-experience/) of sessions, issues and pull requests; [each session on its own branch and worktree](https://github.blog/changelog/2026-06-17-github-copilot-app-generally-available/) | 17 Jun |
| Separate app | [Claude Code desktop](https://claude.com/blog/claude-code-desktop-redesign) | Sidebar of all sessions, filterable by status | 14 Apr |
| Separate app | OpenAI | Codex and ChatGPT unified in one desktop app, with Codex as a mode ([press report](https://www.techtimes.com/articles/320087/20260710/chatgpt-work-free-every-plan-what-openais-codex-merger-changes-you.htm)) | 9 Jul |
| Inside the editor | [Cursor 3](https://cursor.com/blog/cursor-3) | Agents Window listing local and cloud agents; users can switch back | 2 Apr |
| Inside the editor | [Zed](https://zed.dev/blog/parallel-agents) | Threads Sidebar as the default left dock; opt-in for existing users | 22 Apr |
| Inside the editor | [Devin Desktop](https://cognition.com/blog/introducing-devin-desktop) | Announced as the next generation of Windsurf; Agent Command Center as the default view | 2 Jun |
| Inside the editor | [Kiro](https://kiro.dev/changelog/ide/1-0-293/) | Attention cards when a session needs input, in an experimental focus mode | 11 Aug |
| Companion window | [VS Code](https://code.visualstudio.com/updates/v1_120) | Agents window, a preview described as a companion to the editor | 13 May |
| Appears to be moving into the IDE | JetBrains Air | [Public preview in March](https://www.techzine.eu/news/devops/139409/jetbrains-air-agentic-development-environment-in-preview) as a separate environment; [current docs](https://www.jetbrains.com/help/air/quick-start-with-air.html) recommend "Air in IDEs" to users of the app | Mar to Nov |

Session lists recur across these products. Beyond that, the evidence documents a worktree per session for the Copilot app, a diff pane that can be scoped to the last turn for Codex, and pull-request tracking for GitHub, Claude Code desktop and Devin Desktop. The products were not compared feature by feature.

**Demoting code tooling drew vocal pushback.** A Cursor forum user who writes as staff said in April that the Agents Window [lacked full language-server support and per-change accept or reject](https://forum.cursor.com/t/agents-window-is-not-good/157226); the classic editor stayed. The two most-replied comments on the [Cursor 3 Hacker News thread](https://news.ycombinator.com/item?id=47618084) object to demoting code and to forced "swarms of agents". One outlet reported that Antigravity 2.0 users believed the editor had been removed and that Google [added "Open IDE" entry points](https://piunikaweb.com/2026/05/23/google-antigravity-2-0-ide-update-gemini-quota-reset/) within days. These are self-selected posts and one news report, and the same forum also carries praise.

**Demand evidence is thinner than supply evidence.** Among the vendor posts read, only Cursor's gives a usage ratio: [twice as many agent users as tab-completion users](https://cursor.com/blog/third-era) by February 2026 (vendor-reported, no method). In a Stack Overflow pulse survey of about 1,100 respondents, [69% use a single agent, 68% prefer that, and 63% rarely or never let agents run entirely on autopilot](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/). The base for each of those figures is not stated.

### How developers work with agents

- **Editors.** [VS Code is used by 70.9%](https://survey.stackoverflow.co/2026/technology/data.md) of Stack Overflow's 2026 respondents, Cursor by 14.9% and Zed by 11.4%. On the survey's "admired" measure Cursor scores 33.0% and Windsurf 22.7%, against 55.7% for VS Code, 57.3% for Zed and 69.9% for Neovim.
- **Agents.** Among respondents who used at least one listed coding agent or assistant in the past year, [Claude Code is at 65.5%, GitHub Copilot at 58.7% and Codex at 29.5%](https://survey.stackoverflow.co/2026/ai/data.md). About three-quarters use two to five AI tools in a typical week.
- **Terminal plus editor.** In a self-selected newsletter survey with 906 responses, [Claude Code was the most loved tool at 46%](https://newsletter.pragmaticengineer.com/p/ai-tooling-2026). The author describes a terminal agent with an IDE open for review as a common arrangement.
- **Conditional trust.** [48.0% trust AI output only when they can easily verify it, and 76.5% say they run it locally before using it](https://survey.stackoverflow.co/2026/ai/data.md).
- **What costs time, by self-report.** The AI mistakes respondents say cost most time are [plausible-but-wrong code (69.3%), hard-to-review generated code (54.2%) and missing context (49.3%)](https://survey.stackoverflow.co/2026/technology/data.md). No time was measured.

## 2. Tokens: where the money goes

### What the bill is made of

A vendor-authored preprint on [2,848 billed Claude Code benchmark runs](https://arxiv.org/html/2607.12161v5) split cost as follows: cache writes 44.3%, cache reads 35.4%, output 10.4%, uncached input 1.3%, unattributed 8.7%. These were short runs of about 4.5 turns, so they may not describe a long session.

The same authors also sliced cost by content, in 1,212 benchmark sessions. The fixed system prompt and tool definitions carried about 75% of cost and tool outputs 3.3%. Everything a product outside the agent could change came to about 6%. For interactive sessions, which they modelled from 41 sessions without billing data, they put that changeable share at roughly 30% and the ceiling on actual savings at about 9%. They call this an upper bound, "not a forecast".

Two other sources show the same pattern. A separate preprint (500 benchmark tasks, a different agent) found [cache-read input the largest token and dollar category in every phase](https://arxiv.org/html/2604.22750v3). A Microsoft preprint on [GitHub Copilot telemetry](https://arxiv.org/html/2608.00101) found the median model call carrying 68,000 prompt tokens and 247 output tokens. In those traces cache hit rates averaged 90% within a turn, fell across turn boundaries, and averaged 8% after a model switch.

### Search: a large share of activity; its share of the bill is barely measured

In short: reading and searching are a quarter to three-quarters of what an agent does, depending on the measure. Their share of the bill was measured once, at 3.3% for all tool output, in short runs only. No source measured it for a long session.

How much effort goes to reading and searching depends heavily on what is counted, and on the agent, model and tasks measured. A "round" below is one model call and the tool calls it makes.

| What is counted | Out of what | Share | Source |
|---|---|---|---|
| Read-type operations | Tokens per round, in a minimal agent | 76.1% (67.5% with another model) | [SWE-Pruner preprint](https://arxiv.org/html/2601.16746) |
| Explore phase | Rounds, on 500 benchmark tasks | 30.4% | [arXiv 2604.22750](https://arxiv.org/html/2604.22750v3) |
| Read, grep and glob | 2 million real-user tool calls | about 23% | [SWE-chat](https://arxiv.org/html/2604.20779) |
| All tool outputs, not only search | Reconstructed cost, short Claude Code runs | 3.3% | [PointFive preprint](https://arxiv.org/html/2607.12161v5) |

Your intuition is right in one respect. What an agent reads stays in the conversation and is re-sent on every later turn. In one engineer's logs, published by a tooling vendor, [reaching 100,000 tokens of context cost a median 1.4 million tokens in total](https://langwatch.ai/research/finding-the-optimal-context-window).

Tools that try to trim this have mixed results on the bill:

- In the vendor preprint above, one compressor removed an estimated 38.4% of tool-output tokens and [billed cost rose 6.8%](https://arxiv.org/html/2607.12161v5). Another product raised cost 48.4%. A shipped release that removed only 1.3% of tokens lowered cost 2.7%.
- In a separate single-shot test in that paper, aggressive compression cut cost 59%, but patches applied in 15 of 40 cases instead of 27.
- A self-described independent test of a code-graph index, on one repository, [cut tool calls 55% and raised cost 6.8%](https://dev.to/harrisonsec/i-tested-codegraph-on-hono-the-tool-call-savings-reproduce-the-cost-savings-dont-389p) (coincidentally the same figure), against the tool's published 35% saving. Cost did fall 28.9% on the one broad multi-file question.
- In a CircleCI blog test on one repository, telling Claude to prefer a language server [cut tool-output tokens 31% and cost 3%](https://circleci.com/blog/claude-code-lsp/) on three tasks.
- Offered a language server with no steering, Claude models [used it in 0 to 6% of code-location episodes](https://arxiv.org/abs/2608.13568), and about half the time on find-all-references tasks (a small preprint).
- Two papers report cost cuts measured by their own authors: [26.8% from pruning what is read](https://arxiv.org/html/2601.16746), and [21 to 36% from trimming history](https://arxiv.org/html/2509.23586) after a 40 to 60% cut in input tokens.

My reading of why token cuts shrink or vanish on the bill: tool output is a small share of a prompt that is mostly cached, cached tokens are already cheap, and an agent given less may fetch again.

One result on task success stands out. In a preprint using a small model on 200 benchmark tasks with a $1 cap per task, handing the agent ten candidates up front, and retiring them once it had first read source code, [solved 79 tasks, against 66 for on-demand exploration and 56 with a standing repository map](https://arxiv.org/html/2607.25431). Its spend figures were incomplete.

### Candidate levers, and who can pull them

| Lever | Evidence | Strength | Who can pull it |
|---|---|---|---|
| Keep the cached prefix stable | Changing tool definitions [invalidates the whole cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). In Copilot traces, cache hits averaged 8% after a model switch | Strong | Agent vendor. A host can avoid adding tools mid-session and warn before a model switch |
| Avoid cold resumes after pauses | [17 to 27% of user turns follow a pause over five minutes](https://arxiv.org/html/2609.28919) in about 10,000 Claude Code sessions; the cost effect is simulated. One user of a different agent found requests after any gap over five minutes were [40% of spend in total](https://github.com/diegopetrucci/the-last-harness/issues/642) | Weak: saving unmeasured | Host and user |
| Defer tool schemas | Filtering removed [about 21,000 tokens per turn](https://arxiv.org/abs/2609.22114) (vendor paper; tokens, no cost figure). Claude Code now [defers tool-server schemas by default](https://code.claude.com/docs/en/mcp) | Moderate; partly done | Agent vendor, or a gateway placed in the request path, as in the cited study |
| Be sparing with instruction files | Files such as AGENTS.md [raised cost over 20% on average without generally improving success](https://arxiv.org/abs/2602.11988) (preprint; file against no file) | Moderate | User. A host can show the cost |
| Summarise history carefully | Replacing history with a summary [damaged 5 to 64% of 22 repairs](https://arxiv.org/abs/2610.31710), depending on the summariser | Weak: small sample | Agent vendor |
| Avoid sub-agent fan-out on small tasks | Fan-outs used [2.6 to 5.9 times the input tokens and none was faster](https://systima.ai/blog/subagent-tax) (run counts not stated). Two forked sub-agents [consumed 1.14 billion tokens](https://langwatch.ai/blog/context-tax-when-to-compact) in one developer's day | Weak: single cases | Agent vendor and user. A host can flag it |
| Cut redundant work | Repeated retrieval, near-duplicate scripts and test reruns reached [up to 22.75% of task cost](https://arxiv.org/abs/2609.30725) in the worst of four benchmark settings | Weak to moderate | Agent vendor. A host can flag repeats |
| Stop wrong-direction runs early | In failed benchmark runs the decisive error came at [median step 7 of 27](https://arxiv.org/html/2607.09510v1). But in an offline study of recorded traces, early failure prediction was [near chance, and continuing beat restarting in 216 of 224 settings](https://arxiv.org/abs/2610.35971) | Not a lever today | Nobody yet |

Any before-and-after cost comparison needs repeated runs on fixed tasks. On one benchmark, token use on the same task [varied up to 30 times between runs](https://arxiv.org/abs/2604.22750), and models' predictions of their own usage correlated at most 0.39.

### Who cares about cost

When shaping prompts and picking models, [75% of Stack Overflow respondents cite quality and 38% cost](https://stackoverflow.blog/2026/10/06/the-results-of-the-2026-developer-survey-are-here/), and 38% say their employer sets usage limits. In the survey data, [6.4% gave lower cost as their main reason for switching AI tools](https://survey.stackoverflow.co/2026/ai/data.md). In a newsletter's sample of developers at 15 businesses, [about half said AI spend was rising dramatically](https://newsletter.pragmaticengineer.com/p/the-pulse-token-spend-breaks-budgets) and that they had decided to do nothing about it. In one vendor's machine-labelled analysis of Reddit complaint posts, ["excessive token consumption" rose from 9.1% to 13.7%](https://openchamber.dev/blog/ai-coding-complaints/) in a year.

**What this means for the design (my inference).** The buyer of token efficiency is more likely a team lead or a heavy user than a typical developer. Measure billed cost by cache category, and never report "tokens saved". Treat the pause before a reply as a cost event. Add nothing to an agent's prompt by default. Accept that a host cannot fix the prefix of an agent it does not own.

## 3. Machines: workspaces, sandboxes and idle time

### Sessions sit idle most of the time

- In a preprint's [24-hour trace of 35,037 sessions](https://arxiv.org/html/2608.15127) of one unnamed production agent, the median session executed for 20% of its lifetime. Most idle gaps lasted 1 to 10 minutes.
- In the Copilot traces, estimated container idle gaps had a median of 5.8 seconds within a turn and 243 seconds across turn boundaries. The paper also gives [a median user idle time of about 25 minutes](https://arxiv.org/html/2608.00101) at turn boundaries, without defining the population.
- Across 43 developers' own Claude Code and Codex sessions, [the gap before the next user message was 92.3% of wall-clock time](https://arxiv.org/html/2606.30560v2), or 64.3% with gaps capped at an hour. That gap includes time away from the keyboard.
- Running the Claude Code harness on 144 benchmark tasks, memory averaged [about 185 MB early in execution, with one-to-two-second bursts to 2 to 4 GB](https://arxiv.org/html/2602.09345).

These traces cannot tell an agent waiting on a person from a person who has stepped away. They do show that a machine kept running for each session is mostly unused. My note: on a laptop the saving is smaller than it sounds. An idle agent is light, and the dev server it started usually has to stay up so you can look at the result.

### Worktrees isolate files only

Worktrees are the most-mentioned isolation mechanism. A keyword count of [163 listed orchestration tools](https://raw.githubusercontent.com/andyrewlee/awesome-agent-orchestrators/main/README.md) finds worktrees in 55 one-line descriptions and containers, sandboxes or VMs in 6 to 9. Their limits are documented by the vendors that use them:

- A new worktree [needs its own dependency install and does not copy ignored files such as `.env`](https://code.claude.com/docs/en/worktrees.md) unless configured.
- Worktrees [do not sandbox processes or prevent merge conflicts](https://raw.githubusercontent.com/ParadevAI/Paradev/HEAD/README.md).
- Dev-server ports collide, the dev database and the Docker compose namespace stay shared, and [dependencies are duplicated](https://dev.to/rohansx/every-ai-agent-tool-creates-git-worktrees-none-of-them-make-worktrees-actually-work-3ae9) (one tool author's list).

Fixes exist, with self-reported numbers:

- **Copy-on-write clones.** An [unmerged git proposal](https://github.com/git/git/pull/2317) reports, in its author's benchmark on a very large checkout, about 1.3 GB per ordinary worktree against none with cloned files. One tool's author reports a [first build falling from 68 seconds to 3](https://worktrunk.dev/step/) when build caches are cloned.
- **Database branches** that [take about a second](https://neon.com/guides/git-worktrees-neon-branching) (vendor guide).
- **Cached environment snapshots** in the cloud. Claude Code [reuses a setup snapshot for about seven days](https://code.claude.com/docs/en/cloud-environments.md). GitHub calls an agent's trial-and-error dependency setup [slow and unreliable](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment).

### Vendor boot figures are not end-to-end times

[Firecracker's specification](https://firecracker-microvm.github.io/) is a virtual-machine boot under 125 ms. One blog benchmark, with no run count stated, measured [717 to 2,824 ms from create to first command](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/) across hosted providers. A second benchmark, by a vendor that buys sandbox compute, ran a real test pipeline and [ranked the providers common to both in a different order](https://starsling.dev/blog/beyond-cold-starts-benchmarking-sandboxes-for-real-workloads).

Locally, Claude Code's operating-system sandbox [cut permission prompts 84%](https://www.anthropic.com/engineering/claude-code-sandboxing) (vendor-reported, 2025). Docker Sandboxes give each agent a small virtual machine with [its own Docker daemon and no shared image layers](https://docs.docker.com/ai/sandboxes/architecture/).

For two questions, limited searching found only anecdotes: how many agent workspaces a laptop sustains with dev servers and language servers running, and how much memory is saved by sharing one language server across worktrees.

**What this means for the design (my inference).** Fix what worktrees leave unsolved first: colliding ports, environment files that are not copied, and caches that have to be rebuilt. Treat container and VM tiers, and putting workspaces to sleep, as options to add when your own measurements ask for them. If you add cloud sandboxes, put them behind your own interface and benchmark them on the user's real pipeline.

## 4. Knowing what the agent did, and being told at the right time

### The agent's account of itself is unreliable

A preprint studied [20,574 real coding-agent sessions](https://arxiv.org/html/2605.29442) and classified the 16,118 episodes in which a developer pushed back on the agent. Labels were assigned by a model, and one episode can carry several.

- The agent broke a constraint the developer had stated: 38.33% of episodes.
- The agent misread the intent: 26.95%.
- The agent reported inaccurately on its own work, mainly premature claims of success or completion: 22.58%.

A fix was visible in the logs for 9.33% of episodes. Of those, 91.49% needed explicit correction by the developer. These shares are of pushback episodes, not turns, so they do not show how often a turn ends with a false "done". Failures nobody pushed back on are not counted.

My reading: this is the strongest evidence behind your complaint. The study did not examine status displays, but a display that repeats what the agent says would inherit these errors.

### The raw signals exist and are not standardised

- **States.** Tools have converged on a small vocabulary. Claude Code's agent view uses [Working, Needs input, Idle, Completed, Failed and Stopped](https://code.claude.com/docs/en/agent-view). GitHub Mobile shows [In progress, Waiting for user input, Idle and Finished](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions/). The draft of version 2 of the Agent Client Protocol defines [running, requires_action and idle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md).
- **Hooks.** Claude Code documents [33 lifecycle events](https://code.claude.com/docs/en/hooks.md) by my count, including notifications for a waiting permission prompt and an idle prompt. Codex's hook events [overlap heavily with those names and include no notification event](https://learn.chatgpt.com/docs/hooks.md), though a separate setting [fires when a turn completes](https://learn.chatgpt.com/docs/config-file/config-advanced). Cursor imports Claude hooks but [drops the permission and notification events](https://cursor.com/docs/reference/third-party-hooks). No adopted cross-vendor standard was found.
- **Telemetry.** The OpenTelemetry conventions for agents are [still in development status](https://github.com/open-telemetry/semantic-conventions-genai/issues/511).
- **Progress.** None of the first-party status documentation opened describes an estimated time or percent complete. Claude Code's task tools, a natural source for a progress list, are [on by default only for older models](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md).
- **Stuck detection** ships mostly as simple rules. Gemini CLI's source flags [a tool-call cycle repeated five times](https://raw.githubusercontent.com/google-gemini/gemini-cli/HEAD/packages/core/src/services/loopDetectionService.ts) and adds a model check after 30 turns. Kiro's task runner [warns after 60 minutes without activity and fails a step after three identical errors](https://kiro.dev/docs/crew/features/task-runner/).
- **Rewind** is partial. Claude Code checkpoints [do not track files changed only by shell commands](https://code.claude.com/docs/en/checkpointing).

### Approval prompts are not oversight

All of the following are vendor figures.

- Anthropic reports that users approve [93%](https://www.anthropic.com/research/claude-code-auto-mode) or [97%](https://claude.com/resources/articles/auto-mode-default-in-claude-code) of permission prompts, in two posts that do not reconcile the numbers. In its own test, people caught a dangerous command swapped into a prompt 13.6% of the time.
- [Experienced Claude Code users](https://www.anthropic.com/research/measuring-agent-autonomy) switch on full auto-approval in over 40% of sessions, against about 20% for new users. They also interrupt more: in about 9% of turns, against 5%.
- Cursor reports that [36.3% of agent changes reached commits without its in-editor acceptance step](https://cursor.com/insights/developer-habits) by May 2026, up from 7% in January.

They suggest supervision is moving from approving each step to watching and interrupting. The Cursor figure also cuts against any design that asks for a review at every turn: people are already skipping an acceptance step that exists.

### Some vendors are holding notifications back

Cursor's release notes say its cloud agents [no longer push when a turn finishes](https://cursor.com/docs/release-notes), keeping pushes for questions and approvals, though its mobile documentation still describes one. In Kiro's experimental focus mode, the [attention panel never opens on its own](https://kiro.dev/docs/ide/experimental/focus-mode/). Claude Code [skips pushes while you are at the terminal](https://code.claude.com/docs/en/remote-control). GitHub went the other way and added live notifications on phones. The author of one terminal tool says it was built partly because Claude Code's notifications [carried no context](https://raw.githubusercontent.com/manaflow-ai/cmux/HEAD/README.md).

A Google Labs position paper reviewed public documentation for five deployed agents, including Google's own, and found [none documenting a cost of interruption or a decision to stay silent](https://arxiv.org/html/2605.06717). It recommends logging the notifications a system withheld as well as those it sent. The interruption research is old and small: in a 2008 study with 16 users, deferring notifications to natural task boundaries [reduced frustration for a delay of about 90 seconds](https://interruptions.net/literature/Iqbal-CHI08.pdf).

### How big is the problem

Explicit complaints about visibility are a small share of Reddit complaint posts: [about 3.0%, against 13.7% for token consumption](https://openchamber.dev/blog/ai-coding-complaints/), in one vendor's machine-labelled analysis. Anthropic reports a median Claude Code turn of [about 45 seconds](https://www.anthropic.com/research/measuring-agent-autonomy) between October 2025 and January 2026, while the longest one in a thousand rose from under 25 minutes to over 45. Long blind waits are a tail.

None of the sources gathered shows that a status display or notification scheme for coding agents reduces wasted time or tokens. That absence was not separately checked. Treat the idea as an untested hypothesis.

Warning you that a run is heading the wrong way is not possible today. In an offline study of recorded runs, early prediction of failure was near chance (section 2).

**What this means for the design (my inference).** Build status from what happened: files changed, commands run, exit codes, checks. Treat "done" as a claim until evidence is attached. Check the developer's stated constraints against each diff, since that is the largest category above. Show progress as time elapsed, steps taken and spend, with no invented estimate. Push a notification in one case, when the agent is blocked on you and you are away, and keep everything else in a queue you pull from.

## 5. Review: the better-measured bottleneck

A Harvard working paper on [655 firms](https://fion.ac/jellyfish.pdf), not peer reviewed and built on one analytics vendor's data, finds that after firms adopt agents (the first two figures are twelve-month estimates):

- pull requests opened rise 35.7%;
- resolved issues rise 13.7%, which falls just short of statistical significance;
- time from submission to approval rises 56.1%, and active review time 58.5%.

By July 2026, 79.1% of those firms had used AI review tools, and the authors conclude the bottleneck remains. The review-time figures are measured on pull requests, after one is opened.

Vendor telemetry points the same way. Agent-created pull requests [wait 5.3 times longer for a first look](https://assets.linearb.io/image/upload/v1765300694/resources/LinearB_2026_Software_Engineering_Benchmarks_Report.pdf) at the 75th percentile. Between periods of low and high AI adoption, median time to first review [rose 156.6% and pull requests merged with no review rose 31.3%](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways). GitHub reports that by September 2026 [more than 40% of pull requests began with an agent's first draft](https://github.blog/news-insights/octoverse/octoverse-commits-pushes-reach-new-highs-in-2026-as-developers-build-with-agents/).

### No evidence yet on what helps reviewers

Shipped products go beyond the raw diff:

- Antigravity produces [plans, diagrams, images and browser recordings](https://antigravity.google/docs/artifacts/) for review at milestones.
- Cursor's cloud agents [produce videos, screenshots and logs](https://cursor.com/blog/agent-computer-use).
- The Codex app's review pane [can scope a diff to the last turn and revert per file or per hunk](https://learn.chatgpt.com/docs/code-review?surface=app).
- [Devin Review](https://cognition.com/blog/devin-review) regroups and orders changes and lets you question them.
- Zed's Delta [records edits between commits alongside the conversation](https://zed.dev/blog/delta-public-beta).

No controlled study was found showing that any of these improves bug-catching. The nearest experiments are warnings:

- In a 2024 experiment with 29 experts, reviewers given a machine-written review [focused where it pointed, found more minor issues but no more serious ones, and saved no time](https://arxiv.org/abs/2411.11401).
- In a 34-person study, fuller explanations [got the highest trust](https://arxiv.org/html/2607.24601v1) with no significant change in decision time. Error detection was not measured.
- In a 32-person eye-tracking study, labelling code as machine-written [added reading time without changing a measure of thoroughness](https://arxiv.org/abs/2606.26505).
- In an Anthropic experiment on its own product, 50 data analysts [went with the option the agent had been set to favour 86% of the time](https://www.anthropic.com/research/agents-judgment-calls).

Automated review has measured limits. On the open-source part of one benchmark (a preprint), the best agent [caught 71.9% of known bugs at about $3 and 10 minutes per review](https://arxiv.org/abs/2610.13668), and detection odds fell as diffs grew. In one startup's own account, [27% of gated merges rested on an approval an agent had submitted through a human's account](https://arxiv.org/abs/2610.28683).

A design study run with JetBrains proposes a review that goes [from overview to file to snippet, with risk marked per file and per line](https://arxiv.org/abs/2606.01969). It measured expectations, not outcomes.

**What this means for the design (my inference).** Review belongs at the centre of the product. Put observed facts ahead of the agent's summary, and say what was not checked, since a confident summary invites over-trust. Attach that evidence to the pull request, because that is where the measured delay sits. Note the limit: that delay is between people on the code host, and nothing shows that better evidence from the author shortens it. Record whether a person or an agent approved. Measure defect-catching yourself, because no study was found that says which presentation works.

## 6. Interface: unused chrome and "fun"

### Is most IDE chrome unused?

No public data from after 2020 on which panels developers use was found in two rounds of searching. Three older or indirect sources are the nearest:

- A 2006 study of 41 heavy users of Eclipse: [at least 93% made at least one selection in each of the seven most-used views](https://www.cs.ubc.ca/~murphy/papers/mylar/software-eclipse-usage.pdf), out of 42. Toolbars and menus were little used to invoke commands (8% and 5% of executions, against 84% by keyboard), and nobody used one default view.
- A 2015 study of 18 developers, which estimated from interaction logs that [about 70% of IDE time went to understanding code, 14% to fiddling with the interface and about 5% to editing](https://sonar.ch/documents/328164/files/Mine2015b.pdf).
- An observational JetBrains telemetry study of 800 developers, which found [switches into the IDE window rising slightly for users of its AI assistant](https://arxiv.org/html/2601.10258) and falling for non-users.

So the premise is untested. My reading of the old data: toolbars and menus are fair targets, and reading code is the core of the job.

### Does "fun and engaging" help?

No user study was found showing that playful agent visualisers help developers track agent state. The nearest evidence on fun more broadly:

| Finding | Source | Caveat |
|---|---|---|
| A pixel-art office that visualises Claude Code agents shows about [96,500 installs](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents) | Marketplace counter | Installs, not active users. No study found showing such tools help track state |
| Game voice lines triggered by agent events reached [1,006 points on Hacker News](https://news.ycombinator.com/item?id=46985151). One commenter moved to plain spoken status once the novelty wore off | Forum | One anecdote |
| No feedback and extreme feedback both reduced play time and motivation, relative to medium and high levels | [Kao 2020, N=3,018](https://api.semanticscholar.org/graph/v1/paper/search/match?query=The%20effects%20of%20juiciness%20in%20an%20action%20RPG&fields=title,abstract,year,venue,authors,externalIds,citationCount) | A game; abstract only |
| Feedback tied to success raised motivation. Amplified effects lowered it, which the authors say may be an artefact | [CHI 2024, n=1,699](https://spiral.imperial.ac.uk/entities/publication/253c32f5-d124-4a23-88b5-9aaaf114608d) | A game; abstract only |
| Gamification effects fell after about four weeks, then partly recovered | [Rodrigues et al. 2022, N=756](https://doi.org/10.1186/s41239-021-00314-6) | Students; abstract only |
| Removing GitHub's streak counters changed developer behaviour. The authors warn gamification can steer people in unwanted directions | [ICSE 2021](https://arxiv.org/abs/2006.02371) | Natural experiment; abstract only |
| Continuous sound improved monitoring of a background process over a visual-only display | [Hildebrandt et al. 2016, n=18](https://api.semanticscholar.org/graph/v1/paper/search/match?query=Continuous+sonification+enhances+adequacy+of+interactions+in+peripheral+process+monitoring&fields=title,abstract,year,venue,authors,externalIds) | Lab task; abstract only |
| Only 5.52% of the Arc browser's daily users regularly used more than one of its workspaces; two other features were used by 4.17% and 0.4%. The same letter describes a "novelty tax" | [The Browser Company](https://browsercompany.substack.com/p/letter-to-arc-members-2025) | A browser; vendor-reported |
| Claude Code, the most loved tool in one survey, has a deliberately minimal interface | [Its founding engineer, 2025](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built) | Maker's statement |

A 2020 review of 103 studies of gamification in software engineering concluded that [the empirical evidence is very limited](https://arxiv.org/abs/2011.07115).

**What this means for the design (my inference).** Make the interface fast first. Give each agent state a distinct, restrained signal in shape, colour and sound, tied to real events. Reserve any celebration for checks that pass, and keep it small. Offer characters, pixel offices and sound packs as optional skins over the same signals, so the product still works when the novelty fades. Leave out streaks, points and leaderboards. Count the use of your own panels from the first build, because no recent public data was found.

## 7. Working with every existing tool

### Agents: possible, with a trade between breadth and depth

The Agent Client Protocol (ACP) is the closest thing to a standard between hosts and agents. Its registry [listed 45 agents](https://agentclientprotocol.com/get-started/registry.md) by my count on 10 November 2026, including Claude, Codex, Cursor, Copilot, Gemini CLI and OpenCode. Version 1 gives a host [structured tool calls with diffs and permission requests](https://agentclientprotocol.com/protocol/v1/tool-calls.md) over [a single local transport](https://agentclientprotocol.com/protocol/v1/transports.md). Its documentation describes how a host can offer its own tools to an agent by [passing an MCP server when a session starts](https://agentclientprotocol.com/get-started/related-protocols.md), though the agent is not guaranteed to connect.

What ACP does not yet carry matters for your asks:

- Per-turn token usage is [still a draft proposal](https://agentclientprotocol.com/rfds/end-turn-token-usage.md).
- Remote transport is [still being specified](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md).
- Version 2, which adds session states and background work, [has been a draft since July](https://agentclientprotocol.com/announcements/acp-v2-draft.md) with no date for stabilisation.
- Users of the Claude adapter report that [background-task state does not reach generic clients](https://github.com/agentclientprotocol/claude-agent-acp/issues/1285). The issue is open, with no maintainer reply.

Each vendor's own interface is richer. Codex's app-server emits [diff, plan and token-usage events](https://learn.chatgpt.com/docs/app-server) and exposes rate limits. Claude Code offers hooks and an Agent SDK, though its [cost fields are documented as estimates](https://code.claude.com/docs/en/agent-sdk/cost-tracking.md).

Deep integration has a maintenance cost that wrappers describe themselves. Omnara abandoned wrapping the Claude Code command line as [unfeasible to maintain](https://raw.githubusercontent.com/omnara-ai/omnara/500a82ad85ba35d0a478810bb00e944ba93071b1/README.md). Sculptor's documentation acknowledges [a cost per supported agent](https://raw.githubusercontent.com/imbue-ai/sculptor/HEAD/docs/help/integrated_harnesses.md). Zed's notes that an external agent [usually owns its own runtime, authentication, tools and configuration](https://zed.dev/docs/ai/external-agents).

### Terms: the Claude route is constrained

Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance) bars third parties from offering Claude.ai login or routing requests through subscription credentials, and says products built on its Agent SDK should use API keys. It allows a product to run the unmodified Claude Code program when each user signs in and is billed directly. It does not say whether an adapter built on the Agent SDK counts as the unmodified program. No source read covers a host that registers hooks. A [help-centre note](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says a billing change announced for the SDK is paused: for now, use through the SDK and through third-party apps still draws on a subscription's limits. If the change resumes, that may stop. Conductor described itself as [subject to that change](https://www.conductor.build/blog/claude-subscription-update).

OpenAI's preview lets an app request permission to use a person's ChatGPT plan. It is documented for [open-source and locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source), and paid or remotely hosted apps are sent to [a partner waitlist](https://developers.openai.com/siwc/request-client-id). No source read covers a host that launches the Codex command line.

### Extensions and language tooling: not portable

Microsoft's [Marketplace terms](https://cdn.vsassets.io/v/M264_20251020.18/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf) restrict its offerings to Microsoft products, and [certain Microsoft extensions and the VS Code Server](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code) carry the same restriction. The open registry, Open VSX, listed about 21,000 extensions on 10 November 2026 with Microsoft's C/C++, Pylance, C# Dev Kit and Remote-SSH [all absent](https://open-vsx.org/api/-/search?size=2). Cursor [announced its own replacements](https://forum.cursor.com/t/new-in-house-extensions-c-c-ssh-devcontainers-wsl-python/94531) in 2025, built on open language servers and debuggers.

Agent-side code intelligence is uneven. Claude Code's language-server tool is [inactive until a plugin is installed](https://code.claude.com/docs/en/tools-reference), and OpenCode's language-server support is [disabled by default](https://opencode.ai/docs/lsp/). Android Studio now [supplies project and build information to external agents over ACP](https://developer.android.com/studio/releases).

**What this means for the design (my inference).** Go deep on two agents and use ACP for the rest. Claude Code and Codex are the natural first two: they are first and third in usage and have the richest documented interfaces. Normalise their events into your own format and publish what each agent cannot show. Never handle subscription credentials: let the vendor's own program sign in. "Every existing tool" cannot include the VS Code extension marketplace, so plan on open language servers and a hand-off to the user's editor.

## 8. What others built with, and who survived

### What agent-first apps are built with

| App | Built with | Source |
|---|---|---|
| Codex desktop | Electron and React, supervising a separate agent program (one build from about May 2026) | [teardown](https://www.kitze.io/posts/codex-electron-app-technical-breakdown) |
| Claude desktop | Electron; staff said this may change | [staff comment, Feb 2026](https://news.ycombinator.com/item?id=47106368) |
| Conductor | Tauri 2.0 on the system web view | [co-creator comment](https://news.ycombinator.com/item?id=46751354) |
| GitHub Copilot app | Operating-system web views | [changelog](https://raw.githubusercontent.com/github/app/HEAD/changelog.md) |
| cmux | Native Swift with an embedded terminal library | [README](https://raw.githubusercontent.com/manaflow-ai/cmux/HEAD/README.md) |
| Herdr app, Zed | GPUI, Zed's Rust interface framework | [Herdr manifest](https://raw.githubusercontent.com/herdrdev/herdr-app/HEAD/Cargo.toml) |

Some of these keep agents in a separate background program. The teardown shows Codex's window supervising one. Herdr describes its agents as running in a small server on the machine, with [a local programming interface](https://herdr.dev/docs/socket-api/) through which scripts and agents drive it. The author of another orchestrator describes [a background service that keeps terminal sessions alive](https://news.ycombinator.com/item?id=48236770) when the app closes or updates. The evidence does not cover how the other apps are structured.

Measurements are sparse:

- An automated benchmark of an empty app found [Tauri using 96 MB against Electron's 370 MB on macOS by one of its two memory measures, no Tauri advantage on Windows, and Electron starting faster on macOS](https://raw.githubusercontent.com/Elanis/web-to-desktop-framework-comparison/HEAD/README.md). Its authors warn the results are noisy.
- The only 2026 typing-latency data found, published by a competing editor, has [VS Code ahead of Zed at the median](https://peeknext.com/benchmarks/).
- GPUI is [pre-1.0 with frequent breaking changes](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md).
- Zed says its native editor took [five years and more than a million lines](https://zed.dev/blog/zed-1-0).

### Why earlier reinventions stalled

JetBrains ended its Fleet editor in December 2025. [Press coverage](https://devclass.com/2025/12/09/jetbrains-abandons-fleet-ide-pins-hopes-on-forthcoming-air-agentic-development-tool/) relays the company saying it could neither replace its main IDE with Fleet nor narrow it, and the journalist adds that Fleet never left preview and lacked the main IDE's plugin ecosystem. GitHub [retired Atom](https://github.blog/2022-06-08-sunsetting-atom/) citing stalled development and a shrinking community. Its creators later said [the platform, Electron, had become the limit](https://zed.dev/blog/we-have-to-start-over). None of these accounts blames the idea of a new interface, though the Fleet account points at a missing plugin ecosystem, which bears on your wish to work with every existing tool.

### Consolidation

| Date | Event | Source |
|---|---|---|
| 2026 | Vibe Kanban, a board-style agent tool, says in its README that it is sunsetting | [repository](https://github.com/BloopAI/vibe-kanban) |
| Aug 2026 | Ona completes its move to OpenAI's Codex team | [Ona](https://ona.com/stories/ona-joins-openai) |
| Aug 2026 | OpenAI moves to end model access for Cursor after SpaceX's acquisition of Cursor | [CNBC](https://www.cnbc.com/2026/08/29/openai-cursor-spacex-model-access.html) |
| 4 Nov 2026 | Conductor, a Mac app for running several agents, joins Meta; its cloud shuts on 20 November | [Conductor](https://www.conductor.build/announcement) |
| 4 Nov 2026 | Factory takes on HumanLayer and says it will open-source it | [Factory](https://factory.com/news/humanlayer) |

Conductor had raised [$22 million in March and claims over 100,000 users](https://siliconangle.com/2026/11/04/meta-acquires-ai-coding-startup-conductor-whose-app-runs-several-coding-agents-at-once/). In the [discussion of its sale](https://news.ycombinator.com/item?id=50369503), one commenter called such tools "a dime-a-dozen now", and at least two said they prefer open-source tools that can outlive an acquisition. The field is crowded with free options: one open-source tool already [runs six agents on the user's own credentials](https://t3.codes/). No evidence was found on what anyone will pay for a host layer when agents come bundled with model subscriptions.

**What this means for the design (my inference).** Do not build an editor. Keep agents and session state in a background program so the interface technology can change later. Publish that program's source and file format, keep all data on the user's machine, and allow full export. Decide early what you would charge for, because the evidence does not answer that.

## 9. Proposed concept (my proposal)

An **agent workbench**: a place to see what agents did and to accept or reject it, beside the editor people already use. This version reflects a design panel in which four competing concepts were scored against the evidence; the alternatives are listed at the end of this section.

### The record keeper

A small background program on the developer's machine. It does not replace the agent, hold any login, or add anything to the agent's prompt. For each session it keeps an append-only record. Every entry is tagged by where it came from:

- **Observed by the workbench.** A snapshot of the working tree at the end of every turn, so that "what changed this turn" includes edits made by shell commands and sub-agents. Check commands the workbench ran itself, and their exit codes.
- **Reported by the agent's harness.** Tool calls and permission requests, through hooks, Codex's app-server or ACP, and usage where the agent exposes it.
- **Said by the model.** Its summary, and its claim to be finished.

Session state and "what changed" are computed only from the first two kinds.

### The receipt

At the end of each turn the record keeper produces a receipt. It is the product's central object and the first thing to build.

| Line on the receipt | Where it comes from |
|---|---|
| What the agent claimed | The model's last message, shown as a claim |
| What changed | The difference between this turn's snapshot and the last |
| Checks | Fast check commands the repository declares, run by the workbench on a frozen copy of the snapshot |
| Constraints broken | Rules such as "do not touch these paths" or "add no dependencies", tested mechanically against the diff |
| Not checked | Anything the workbench could not observe: network calls, database writes, files outside the worktree |
| Cost | Usage for the turn, labelled as an estimate where the agent provides only an estimate |

Checks and rules are declared by the developer in one file in the repository, which the workbench can draft from the project's existing test and lint commands. With none declared, the receipt shows what changed and what it cost, and every turn stays "done, claimed". Mechanical rules cover only part of what developers ask for in conversation; how much is unknown.

Two details keep the receipt honest. The check commands are read from the commit the task started from, never from the agent's working copy, and a turn that edits tests or the check configuration is flagged "checks modified". And "checks passed" is never presented as "correct". It says the declared checks ran and passed; plausible-but-wrong code is what review is for.

### Session states

| State | Rule |
|---|---|
| Working | A harness event in the last few seconds, or a child process still running |
| Blocked | A permission request, a question, an error or a passed budget is waiting on a person; the reason is shown. No source read shows Codex signalling a question that ends a turn, so there it may appear as "done, claimed" |
| Possibly stuck | The same tool call or the same error several times in a row |
| Done, claimed | The turn ended and no check has run on its snapshot |
| Done, checks passed | The declared checks ran on that snapshot and passed. If no checks are declared, the state stays "done, claimed" |
| Done, checks failed | The declared checks ran on that snapshot and at least one failed |
| Failed or stopped | The agent exited with an error, or a person stopped it |

### Three screens

The window comes after the receipt has proved itself (section 11).

1. **Queue.** The home screen lists what is waiting on you: blocked agents first, with the longest wait and any prompt cache close to expiry on top, then possibly stuck and failed runs, then finished turns awaiting review. You pull from it and answer in place. It sends an operating-system notification in one case: an agent is blocked and you have not touched the machine for a few minutes. Reaching you when you are away from the machine needs a relay to a phone, which is not in the first version. It keeps a list of what it chose not to interrupt you with. A notification for a long turn that finished while you were away is an option to test, not a default.
2. **Session.** A timeline built from the record: what was asked, what changed, what ran, what it cost. Progress is shown as elapsed time, turns, tool calls and spend against the budget you set. There is no percentage and no estimated finish: how far along an agent is cannot be measured today, only how much it has used. Where an agent publishes its own plan or task list, the screen shows it, labelled as the agent's.
3. **Review.** The receipt first, then the diff for the turn or the whole task, then the agent's own summary, collapsed and labelled as a claim. You accept or revert per hunk, rewind files to any turn, and send comments back as the next prompt. Code opens in a read-first view with go-to-definition and diagnostics, with a file finder, and one key opens your own editor at that line. Approvals record whether a person or an agent gave them. The receipt can be posted to the pull request as a comment.

A sketch of the Queue and of one receipt in Review. Each state has its own shape, so it reads at a glance and without colour.

```
QUEUE                                                2 blocked on you
---------------------------------------------------------------------
■ BLOCKED   checkout-refactor   permission: run db:migrate?     4 min
            Claude Code · cache likely expires in 1 min   [Allow] [Deny]
■ BLOCKED   search-api          question: keep the v1 route?   11 min
            Claude Code · cache likely cold                  [Answer]
▲ STUCK?    flaky-test-fix      same error 3 times in a row
◆ REVIEW    billing-export      done, checks passed · 1 rule broken
◇ REVIEW    docs-update         done, claimed · no checks declared
● WORKING   onboarding-flow     turn 7 · 12 min · $1.90 of $5.00

REVIEW   billing-export · turn 4            done, checks passed · 1 rule broken
---------------------------------------------------------------------
Claimed     "Export now streams rows. All tests pass."
Changed     6 files, +212 -48   (2 files changed by shell commands)
Checks      unit passed 41 s · lint passed 3 s · types passed 9 s
            run on snapshot a3f9c1, checks not modified this turn
Rules       no new dependencies: kept
            do not touch migrations/: BROKEN (1 file)
Not seen    network calls, database writes
Cost        $0.84 this turn (estimate)
---------------------------------------------------------------------
[diff, hunk by hunk: accept · revert · comment]     [open in my editor]
```

The second example shows why "checks passed" is kept separate from "acceptable": the checks passed, and the turn still broke a rule the developer had set.

A clickable version of this sketch is in [workbench-mockup.html](workbench-mockup.html), with screenshots of the [Review](mockup-review.png) and [Session](mockup-session.png) screens. The data in it is made up. A second mockup, [workbench-mockup-plain.html](workbench-mockup-plain.html), shows the same record and states with no code on screen and with typed or spoken commands; see section 12.

There is no file tree, extensions bar or settings maze in the default layout. That is a bet the evidence cannot settle, so the tree is one key away and every panel's use is counted.

### How it answers each of your asks

**Tokens.** As proposed, the workbench will not make Claude Code or Codex cheaper per turn. The prefix, the tool schemas and compaction belong to the vendor. What it can do:

- show cost by cache category for each session, turn and sub-agent where the agent exposes it, which step 3 in section 11 has to establish, or the share of a subscription's rate limit where the vendor exposes that;
- warn before actions that discard the cache, such as switching model mid-session;
- show when a blocked session's cache is about to expire, so that answering now is cheaper than answering in ten minutes;
- flag a task that passes its budget and ask whether to continue (stopping it sooner depends on the agent allowing an interrupt);
- reduce turns that are thrown away, by catching false "done" claims and broken constraints at the turn where they happen.

All of these depend on what each agent exposes, and the last four are hypotheses. It adds nothing to the agent's prompt by default. The one context idea worth testing is naming a few likely files in the first message, measured on fixed tasks with repeated runs. A host cannot later remove them from the agent's context, as the study did, so the result may not carry over.

**Machines.** One file in the repository declares what a workspace needs: a block of ports, which ignored files to copy, a compose project name, which caches to clone. The workbench applies it whenever a worktree is created. Rewind restores files only, and says so. Container and VM tiers, sleeping idle workspaces and cloud sandboxes are left out until measurement shows a need.

This leaves your VM ask mostly unanswered, on purpose. The idle-time findings come from hosted agents, where a sleeping machine saves money. On a laptop little is saved, and a local record cannot see agents that run in a vendor's cloud. Managing cloud machines is a larger product; section 12 returns to it.

**Visibility and notifications.** The record, the receipt, the three "done" states and the queue, as above.

**Interface and fun.** State is readable at a glance: one shape and colour per state, in the window and in a menu-bar indicator. Interactions respond instantly. A turn whose checks pass gets a small animation and an optional sound; a claim does not. It stays small, because passing checks is not the same as being right. Characters and sound packs are optional skins over the same states. There are no streaks, points or leaderboards. Motion and sound follow the operating system's accessibility settings. This does not remove tabs from your editor: it leaves the editor alone and adds a smaller tool beside it.

**Existing tools.** Three depths, shown to the user as a table of what each agent can and cannot report:

| Depth | Agents | What the workbench gets, beyond what it observes itself |
|---|---|---|
| Native, started through the workbench | Claude Code through hooks and its telemetry export; Codex through its app-server | Tool calls, permission requests, sub-agents and turn ends. Usage for Codex. For Claude Code, whatever its telemetry exposes, which step 3 in section 11 establishes |
| Native, attached from your own terminal | Claude Code and Codex through hooks alone | Tool calls, permission requests and turn ends. No usage for Codex, and no answering in place |
| Standard protocol | Any ACP agent | Tool calls, diffs, permission requests and session usage. No per-turn cost or background tasks yet |
| Terminal only | Anything else | Nothing from the agent. The workbench sees file changes and can run checks, but cannot tell blocked from finished, so there is no notification and no cost. Snapshots are taken when the files stop changing |

Sessions can be started through the workbench or attached from your own terminal. The Claude route uses the unmodified program with the user's own login. Anthropic's terms describe that arrangement. No source read covers a host that also registers hooks, which is why section 11 begins with a written question to Anthropic.

### What it leaves out

- An editor for writing code, a debugger and the VS Code extension ecosystem. The Review screen has a read-only code view, because people reject tools that cannot inspect code (section 1). Writing happens in your editor.
- Its own agent loop.
- Search, index or repository-map tools pushed to agents by default.
- Percentages, estimated finish times and "this run will fail" predictions.
- Hosted state. Everything is local, stored as plain git references and a local database, and exports.

### How it differs from what exists, and what could absorb it

Several of the orchestrators read for this report manage panes and worktrees and take status from the agent's hooks or terminal output. The field was not audited, so this is an impression. The differences here are the provenance tag on every entry, checks run by the host on a frozen snapshot, constraints tested against the diff, and a receipt that travels to the pull request.

None of that is hard to copy. First parties are close: Claude Code can already [have a second model judge whether a goal is met](https://code.claude.com/docs/en/goal), Codex scopes diffs to the last turn, and VS Code now [runs other vendors' harnesses inside its own sessions](https://code.visualstudio.com/updates). The argument that a vendor will not keep a neutral record of a competitor's agent is mine and has no evidence behind it.

### Alternatives considered

Three AI judges, part of this report's own process, scored four concepts on fit with the evidence, coverage of your asks, feasibility for a small team, durability and differentiation, ten points each. The scores are opinion, not evidence.

| Concept | Score (of 150) | Verdict |
|---|---|---|
| Review desk: host agents, record what they did, review facts first | 94 | Best coverage of your asks; too much to build at once |
| Run ledger: a background recorder and a receipt, with no window | 89 | Most feasible; answers only one of your asks, visibility |
| Workspace runtime: own ports, databases, sandboxes, sleep and a cost meter | 82 | Solves a problem mostly felt by the minority who run several agents |
| Own agent loop, with other agents as guests | 55 | No independent comparison of a third-party loop with a vendor's was found; for Claude it needs API keys, so subscribers could not use their plan |

The recommendation is to build the run ledger first, grow it into the review desk, and take only the workspace file from the workspace runtime.

## 10. What to build it with (my proposal)

- **Record keeper.** One background program shipped as a single binary, with a local programming interface. Each client gets a token limited to its own workspace, so one agent cannot read or drive another's session. That lack of scoping is why [one reviewer uninstalled a competing tool](https://martintapia.com/blog/2026/i-tried-orca-and-vscode-agents-window-i-went-back-to-tmux-shortly-after).
- **Storage.** A local database for events, and git references in a private namespace for per-turn snapshots, written through a separate index so the user's branch and staging area are untouched.
- **First clients.** A terminal view, a menu-bar indicator, and the receipt as a pull-request comment. These reach people where they already work, on every operating system.
- **The window.** Electron or Tauri; I lean to Electron. It gives one rendering engine across operating systems, and the Codex and Claude desktop apps were reported to use it. In the one benchmark found, a noisy test of an empty app, Tauri used much less memory on macOS, which is the window's first platform, and no less on Windows. If memory on macOS matters more to you than sameness across platforms, choose Tauri. Because the record keeper is separate, the choice can be reversed.
- **Code view.** A lightweight embeddable editor component connected to open language servers launched directly. I would avoid embedding VS Code's editor component: the usual bridge for connecting it to language servers lists each of its releases as [aligned with one specific VS Code version](https://raw.githubusercontent.com/TypeFox/monaco-languageclient/HEAD/README.md).
- **An editor extension.** A VS Code panel showing the queue and the receipt is the cheapest route to users, given VS Code's share. Whether the long-term home is the window or the extension should be decided by usage.
- **Platform.** The record keeper and terminal view on all platforms. The window on macOS first, where file cloning and an [operating-system sandbox](https://learn.chatgpt.com/docs/sandboxing.md) are built in.

## 11. What to build first (my proposal)

**Before writing code.** Ask Anthropic and OpenAI in writing whether a host may launch their command-line programs, register hooks and read usage for users on subscriptions. If either says no or does not answer, use API keys for that agent and tell users so, or drop it from the native tier. If this is to be a company, ask ten engineering leads whose organisations cap AI spend whether they would pay for the record.

**Step 1, weeks 1 to 3: the record and the receipt, with no interface.** Claude Code through hooks, Codex through its app-server, on five to ten real repositories. This tests the riskiest assumption in the whole concept: that the receipt catches something. Measure how often a turn ends in a completion claim while a declared check fails, how many turns have no check to run, and whether fast checks can run on every turn without flaking or slowing the machine.

**Step 2, weeks 3 to 6: the receipt where review happens, and the queue.** Post the receipt to pull requests. Ship the terminal view and the one notification. Alternate weeks with the queue shown and hidden while the record keeper runs throughout, so its effect is measured against a baseline.

**Step 3, weeks 5 to 9: can cost be seen?** Find which routes expose cache reads and writes. Reconcile the meter against real invoices. Measure what share of spend falls in turns after a long pause, after a model switch, or flagged as repeats. That share is the ceiling on any token claim you can honestly make.

**Step 4, weeks 6 to 10: the window and the Review screen.** Run the experiment the research could not find: the same agent changes with seeded defects, reviewed as a plain diff, with the agent's summary first, and with the receipt first. Count defects caught and time to decide. Ship the same queue and receipt as a VS Code panel alongside, so that usage can decide between window and extension.

**Step 5, weeks 8 to 12: the workspace file and stuck rules.** Ship the workspace file. Run the stuck and constraint rules silently, hand-label a sample, and show only the rules that prove accurate.

**Alongside: test your own premises.** With consent, log which editor panels your design partners focus on for two weeks, or record and review their sessions. Two rounds of searching found no recent data on the "unused chrome" question; this would produce some.

### Measures and stop lines

The thresholds are my proposals. Set your own before you start, and do not move them afterwards.

| Question | Measure | Stop or rethink if |
|---|---|---|
| Does the receipt catch anything? | Of completed turns with a "done" claim on which a declared check ran, the share where a check failed. Turns with no check available are counted separately | Under about 3% |
| Can state be trusted? | 300 hand-labelled turn boundaries per agent | More than one in ten is wrong after two rounds of fixes |
| Does the queue help? | Median time from blocked to answered, queue shown against hidden | It improves by less than 20% |
| Can cost be seen? | Meter against invoice | They differ by more than 15% |
| Is there a token story? | Share of spend in post-pause, post-switch and repeat turns | Under 5%: drop every token claim |
| Does the Review screen earn its place? | Seeded defects caught; reviews finished without leaving for the editor | No gain over a plain diff, or more than half of reviews leave |
| Can a small team keep up? | Engineer-days per month spent on adapters | More than five for two agents |
| Will anyone pay? | Paid pilots among ten leads asked | Fewer than two |

## 12. Open decisions and what the research could not establish

**Decisions that are yours.**

- **Your own agent loop.** My recommendation is not now. The AI panel scored it lowest, and the evidence gathered includes no independent comparison of a third-party loop with a vendor's. This is the real trade between two of your asks: lower token use points to owning the loop, and working with every agent points to hosting. I chose hosting, and you may weigh it differently. Revisit it if step 3 shows the share of spend a host can reach is too small and you still want lower bills. The test then is billed cost per solved task against the vendor's harness on the same model, with repeated runs.
- **Window or extension.** Vendors are split and JetBrains appears to have reversed course. The plan above defers the choice until there is usage to decide it.
- **Who it is for.** My suggestion: professional developers on existing codebases who run Claude Code or Codex in a terminal beside an editor, one to three sessions at a time. The queue matters more as the number of sessions grows. In one pulse survey 69% of respondents said they use a single agent.
- **Whether people will review each turn.** The Cursor figure suggests many skip an acceptance step that exists, and Anthropic says its own reviewers now [examine a change's intent, not every line](https://www.anthropic.com/research/redesigning-source-control). The receipt may be read at the pull request and nowhere else. That would still be useful, and it would argue against building the Review screen.
- **Plain language, voice and cloud machines.** After this research you sketched a simpler interface: no code on screen, plain language throughout, and several agents and machines directed by typing or speaking ([mockup](workbench-mockup-plain.html)). The record, the states and the receipt carry over unchanged. Two cautions apply. Tools that hid code drew pushback (section 1), so the mockup keeps one link to the exact changes. And managing cloud machines is new scope: idle time is the waste there, and a local record cannot see agents in a vendor's cloud unless the workbench starts the machines itself.
- **What is paid.** A team view of spend, budgets and an audit trail is the obvious candidate. It needs a server, which sits awkwardly with "no hosted state" unless customers host it themselves.

**Not established by this research.**

- Whether any status display, notification scheme or review presentation saves time or catches more bugs.
- How often a turn ends with a false "done". The 22.58% figure is a share of episodes where developers pushed back, not of turns.
- Which IDE panels developers use today.
- How many parallel agent workspaces a laptop sustains.
- How much of a bill a host can change for an agent it does not own.
- Whether a host that registers hooks, or an adapter built on Anthropic's Agent SDK, may be used with Claude subscriptions.
- What developers do during the long gaps between turns. That decides whether a faster notification helps or interrupts.
- Agents that run in a vendor's cloud. A local record sees nothing of them.
- Team use: shared sessions, organisation budgets, and how local review relates to review on the code host.
- Security. One program would install hooks into agent settings, store transcripts and expose a control interface. No threat model was researched, and an organisation's security team may simply forbid it.

## Method and limits

Research ran in seven passes on 10 November 2026, all by AI agents:

1. A scout, to find current product names.
2. A sweep by 11 researchers, one per angle.
3. Verification: a separate fact-checker tried to re-open every cited page and to refute each claim. For 9 of the 404 claims the page could not be opened.
4. A second round of 9 targeted researchers on leads the sweep missed, each followed by its own fact-checker, with a critic reporting where evidence was thin.
5. A design panel: four concepts written from different positions and scored by three judges.
6. An audit of a draft of this report. Five auditors checked 358 statements against the verified claims and found 2 wrong, 11 unsupported and 54 overstated. A sixth read the draft cold for clarity.
7. A second audit of the rewritten text. Six auditors checked 589 statements and found no wrong numbers, 2 unsupported statements and 18 overstated ones. This version corrects them.

Limits to keep in mind:

- No claim received a "refuted" verdict, but corrections were common: typically a wrong denominator, an overstated scope or a missing caveat. At least one correction reversed the original reading of a quote.
- Researchers gathered about 790 sourced claims and kept 404, so 383 were dropped for space and never checked.
- The first sweep's instructions let researchers fetch pages while identifying as an ordinary browser. Later passes were told to respect sites that refuse automated reading, and every cited page was re-read under that rule.
- Several sites refuse automated reading, including JetBrains' blog and OpenAI's own pages. Statements about those companies rest on press coverage or public documentation and are worded accordingly.
- Many figures are vendor self-reports, preprints, abstracts or small samples. The text marks the important ones.
- Web search was rate-limited during the sweep, so coverage of protocols, build technology and survey data is narrower than planned.
- Absences ("no study was found") reflect a few searches each, and are not proof that nothing exists.
- This field changes monthly. Several product facts above are weeks old.
