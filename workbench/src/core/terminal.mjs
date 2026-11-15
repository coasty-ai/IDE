// A terminal window for the person, for the steps only they can do: a vendor's own sign-in (`claude auth login`,
// `codex login`), a vendor's installer, or GitHub's sign-in through gh when it cannot be done without Terminal (two
// steps: gh's login, then `gh auth setup-git`). On macOS, Terminal opens running one program, or a few in a row; the
// person answers them there, and the window reports nothing back (the page checks again when it gets focus).
// Elsewhere nothing opens, and the caller shows the command for the person to run.
//
// The program and its arguments go into a small script, every word quoted for the shell, so nothing in them is read as
// shell syntax. The one shell line Workbench writes itself is an installer, fixed text in connect.mjs, run as
// `/bin/sh -c '<installer>'` (see ARCHITECTURE.md, "Rules for all code"). The script waits for Terminal in a private
// folder of Workbench's own under ~/.workbench, never in the temporary folder, where an agent's process could rewrite it.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../adapters/claude/args.mjs';
import { privateTemp } from './workspace.mjs';

/** How long a script's folder is kept after Terminal was asked to open it. */
export const KEEP_MS = 10 * 60_000;

/** Script folders not removed yet: removed at exit, if their time has not come. */
const folders = new Set();
let watching = false;

function remove(dir) {
  folders.delete(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

function removeAtExit(dir) {
  folders.add(dir);
  if (watching) return;
  watching = true;
  process.on('exit', () => {
    for (const d of [...folders]) remove(d);
  });
}

/** `open` with an argument array (macOS's /usr/bin/open): resolves once it exits 0. */
function openWithMacOS(argv) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', argv, { timeout: 15_000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** One line of text for the window: control, line-separator and direction-changing characters become spaces. */
function oneLine(text, max) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function checkProgram(program, args) {
  if (typeof program !== 'string' || !program || program.includes('\u0000')) throw Object.assign(new Error('Workbench was not told which program to run.'), { plain: true });
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\u0000'))) {
    throw Object.assign(new Error('Workbench was given words it cannot pass to a program.'), { plain: true });
  }
}

/**
 * The script Terminal runs: it clears the window, prints the title, runs the program with every word quoted for the
 * shell, then says the window can be closed.
 * @param {{ title: string, program: string, args?: string[] }} what
 */
export function terminalScript({ title, program, args = [] } = {}) {
  checkProgram(program, args);
  return [
    '#!/bin/sh',
    'clear',
    `printf '%s\\n\\n' ${shellQuote(oneLine(title, 200) || 'Workbench')}`,
    [program, ...args].map(shellQuote).join(' '),
    `printf '\\n%s\\n' ${shellQuote('You can close this window.')}`,
    '',
  ].join('\n');
}

/**
 * Open a terminal window running one program, for the person to answer.
 *
 * macOS: the script (terminalScript) goes into a new private folder (0700) of Workbench's own,
 * ~/.workbench/tmp/workbench-terminal-XXXXXX (privateTemp in workspace.mjs), never the temporary folder, as a .command
 * file of mode 0700, which `open -a Terminal <file>` opens (an argument array). Terminal can take a while to run it,
 * and a process that can write the temporary folder (a Codex agent's, in its sandbox) could rewrite it there first.
 * The folder is removed after `keepMs` (10 minutes), or when Workbench exits, whichever is first, and at once when
 * Terminal could not be asked. When the folder cannot be made, nothing is opened: `{ opened: false }`.
 * Elsewhere: nothing is written or opened, and the answer is `{ opened: false }`; the caller shows the command.
 *
 * @param {{ title: string, program: string, args?: string[] }} what
 * @param {{ platform?: string, home?: string, open?: (argv: string[]) => Promise<void>, keepMs?: number }} [o]
 *   for tests: the platform, the home folder (os.homedir()), and the `open` to call
 * @returns {Promise<{ opened: boolean }>}
 */
export async function openTerminal({ title, program, args = [] } = {}, opts = {}) {
  return openScript(title, terminalScript({ title, program, args }), opts);
}

/**
 * The script for a few steps in a row, each a program and its arguments, every word quoted as in terminalScript. A step
 * runs only when the one before it ended well (they are joined with `&&`, Workbench's own fixed text); then the script
 * says the window can be closed. GitHub's sign-in in Terminal is two steps: gh's login, then `gh auth setup-git`.
 * @param {{ title: string, steps: { program: string, args?: string[] }[] }} what
 */
export function terminalStepsScript({ title, steps } = {}) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10) {
    throw Object.assign(new Error('Workbench was not told which programs to run.'), { plain: true });
  }
  for (const s of steps) checkProgram(s && s.program, (s && s.args) || []);
  return [
    '#!/bin/sh',
    'clear',
    `printf '%s\\n\\n' ${shellQuote(oneLine(title, 200) || 'Workbench')}`,
    steps.map((s) => [s.program, ...(s.args || [])].map(shellQuote).join(' ')).join(' &&\n'),
    `printf '\\n%s\\n' ${shellQuote('You can close this window.')}`,
    '',
  ].join('\n');
}

/**
 * Open a terminal window running a few programs in a row (terminalStepsScript), as openTerminal runs one: the same
 * private folder, file mode, `open -a Terminal`, clean-up, and `{ opened: false }` elsewhere than macOS.
 * @param {{ title: string, steps: { program: string, args?: string[] }[] }} what
 * @param {{ platform?: string, home?: string, open?: (argv: string[]) => Promise<void>, keepMs?: number }} [o]
 * @returns {Promise<{ opened: boolean }>}
 */
export async function openTerminalSteps({ title, steps } = {}, opts = {}) {
  return openScript(title, terminalStepsScript({ title, steps }), opts);
}

/** Write `script` as a private .command file and ask Terminal to open it (macOS); elsewhere `{ opened: false }`. */
async function openScript(title, script, { platform = process.platform, home = os.homedir(), open = openWithMacOS, keepMs = KEEP_MS } = {}) {
  if (platform !== 'darwin') return { opened: false };
  let dir;
  try {
    dir = privateTemp('workbench-terminal-', { home });
  } catch {
    return { opened: false }; // no private folder: never the temporary folder instead
  }
  removeAtExit(dir);
  const name = oneLine(title, 60).replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/^[ .-]+|[ .]+$/g, '') || 'Workbench';
  const file = path.join(dir, `${name}.command`);
  try {
    fs.writeFileSync(file, script, { mode: 0o700, flag: 'wx' });
    fs.chmodSync(file, 0o700);
    await open(['-a', 'Terminal', file]);
  } catch {
    remove(dir);
    return { opened: false };
  }
  setTimeout(() => remove(dir), keepMs).unref?.();
  return { opened: true };
}
