# Baseline on the unchanged code (commit 0e27395, same code as cloud-build d0bab7b)

Run on 2026-11-11 on an Ubuntu 24.04 sandbox (2 vCPU), with Node 26.13.1, git 2.43.0 and Google Chrome 157.0.8103.78 headless.

- `npm test`: **541/541 pass** on Linux (65 s; 23 s on the Mac with Node 26.13.1).
- `node scripts/ui-behaviour-check.mjs`: **57 of 57 passed**, no script errors.
- `node scripts/ui-fit-check.mjs` (full sweep): **incomplete.** It was stopped for the handoff and reported no failures in the scenarios and views it had finished:

```
demo helper longq many many-asks busy idle alldone zero long longcmd helpers6 setaside live race race2 background earlier earlier-many earlier-only 
card-root card-helper card-pinned machines menu tray earlier exact reply notice 
```

So every Chrome failure on the new code is new. Fonts are the bundled JetBrains Mono on both machines, so Linux and Mac layouts should match.
