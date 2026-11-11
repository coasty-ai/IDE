# Workbench as a circuit board (final)
**Concept.** You are the core: a BGA package in the middle of a calm, deep-green board. Its nickel lid is the only light surface, and it shows one thing: one plain sentence, at most two answers, and the only input, "type, or hold space to talk". Every agent is a chip that keeps one lane for life and only slides along it: beside you when it needs you, mid-board while it works, and at the edge, powered down, once it is done.
**Mapping.**
- **Core = you.** Silkscreen YOU, pin 1, balls on all four sides, no modal glow. The lid says "Checkout fix wants to update the test database." (worded from the plan step it serves). "What exactly?" opens `npm run db:migrate -- --env test`, with room above the input.
- **Agents and helpers.** An agent is a chip showing its name and state. Helpers are small parts on twigs from their chip, with words for up to two. A step is one pulse along the copper toward you.
- **Needs you.** The chip's interrupt line lights into the core. A numbered pad sits where it meets the core, in queue order (1 filled, the rest outlined), and white brackets mark the agent the lid shows. A helper's ask lights core → agent → helper; the brackets go on its agent.
- **Machines.** Each is a section of the gold edge connector and a button that opens the existing machines popover, with an LED, a moon when asleep, and notes such as "memory almost full" or "$0.40 an hour". Hovering an agent lights its section. Laptop agents take left lanes and cloud agents right lanes, while the sides stay balanced.

**States**, each by mark, words, place and line style, never colour alone. Beside you, lit: needs your OK ■, has a question (speech bubble), might be stuck ▲ (dashed line). Mid-board, with copper to you: working ●, waiting on its helpers ◑. At the edge, powered down (flat body, dull leads, no copper to you): done and checked ◆, says it is done ◇, stopped ○, failed ✕ (its line cut, like a fuse).
**Motion**, only on change. `?motion` plays it, `?motion&t=ms` holds any moment, and motion.png shows 12 frames.
- A new ask: the chip slides in (900 ms), then the line charges (600 ms) and its pad pops in.
- An answer: the line drains (500 ms), the pads renumber, the old words lift and the next ask rises (380 ms); the chip slides back (900 ms).
- Finishing: the chip slides to the edge as its copper retracts, then powers down (800 ms).
- One pulse per real step, at most every 1.1 s. Hover lifts the chip 2 px, warms its copper, lights its machine, fades the card in (220 ms) and draws its leader (260 ms). With reduced motion nothing travels.

**Scale.** Twelve lanes (six a side) at every size, so the same agents sit in the same places in every view. Past 12, finished work moves to a done tray and each lane splits in two: agents stay beside their old place on one-line chips, with helpers as marks. `?many` shows 25 agents at 1280×720 with nothing overlapping.
**Accessibility.**
- Chips and helpers are HTML buttons in a list over an aria-hidden board, named like "Checkout fix, needs your OK, on Cloud 1. Number 1 of 3 that need you."
- Enter or Space pins the card, Esc closes it, focus opens it and leaving focus closes it; the focus outline is 2 px.
- The lid's words are announced through a live region without the buttons. Space starts voice only when no control has focus.
- All text is 10.5 px or larger; chip text is 13.5/12.5 px. `node tools/contrast.mjs` checks 43 pairs; the lowest text pair is 5.6:1.

**What to build first.**
1. A lane allocator saved in sessionStorage, with chips as buttons kept by id (replacing orbit.angleFor and orbit.ensure).
2. The lid: focus.js with lenClass tuned for the lid, and the inset field in form#bar. In card.js, placeCardAt avoids the lid rectangle; shortStatus moves out of orbit.js.
3. Speech-bubble and half-dot marks in states.mjs LOOK and the index.html sprite; then a dark retheme of app.css with dark inks for the lid.
4. Machine connectors that open the popover. Then the motion, then the dense mode.

**Views.** `?card=onboarding` · `?busy` · `?helper` · `?idle` · `?exact` · `?longq` · `?many` · `?voice&confirm` · `?machines` · `?motion` · `?cards` (card probe). The audit is in `#audit`; `tools/` rebuilds the page (build.mjs), shoots it (shoot.sh) and runs it in real time (live.mjs: answers, motion and resize leave no stray wires, pages or pinned chips).
