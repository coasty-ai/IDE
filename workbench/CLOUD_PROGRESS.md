# Cloud build progress

One line per step: time (UTC), what, result.

- 02:04 step 1 — integrate backend: `npm test` script fixed for Node 24 (glob instead of `test/`); 3 simulator tests assumed no checks while the simulator reports them on ~65% of runs, so tests fixed; http test temp dir moved to os.tmpdir(). Result: 238/238 pass, no stray temp dirs.
