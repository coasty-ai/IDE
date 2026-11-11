# Cloud build progress

One line per step: time (UTC), what, result.

- 02:04 step 1 — integrate backend: `npm test` script fixed for Node 24 (glob instead of `test/`); 3 simulator tests assumed no checks while the simulator reports them on ~65% of runs, so tests fixed; http test temp dir moved to os.tmpdir(). Result: 238/238 pass, no stray temp dirs.
- 02:06 step 2 — demo end to end: state, SSE (snapshot then coalesced agents ~250 ms), command→confirm, answers to all 3 asks, wake/sleep machines, 12 safety rejections (no/bad token, Host, Origin, content type, size, traversal). Result: all behaved as specified, no code changes; script kept as scripts/demo-e2e.mjs.
- 02:10 step 3 — UI against real engine: fixed hidden hover card (HTML hidden attr never removed), invisible text from lazy font weights (preload all 4 + swap), card placement (own label, centre circle, window edges), truncated approvals/helper lines, status clipped mid-word, moons colliding with a root's name, wrapped answer buttons overlapping the input at long text, redundant confirm line. Checked 87/211-char questions, helper-needs-OK (agent moves inner, thread ends at helper), live SSE mode via CDP (no console errors, Allow click works). 8 screenshots in docs/screens/demo-*.png.
