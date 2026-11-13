// A terminal window for the person, for the steps only they can do: a vendor's own sign-in (`claude auth login`,
// `codex login`) or a vendor's installer. On macOS, Terminal opens running one program; the person answers it there,
// and the window reports nothing back (the page checks again when it gets focus). Elsewhere nothing opens, and the
// caller shows the command for the person to run.
//
// The program and its arguments go into a small script, every word quoted for the shell, so nothing in them is read as
// shell syntax. The one shell line Workbench writes itself is an installer, fixed text in connect.mjs, run as
// `/bin/sh -c '<installer>'` (see ARCHITECTURE.md, "Rules for all code").
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../adapters/claude/args.mjs';

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
 * macOS: the script (terminalScript) goes into a new private folder (0700) under the temporary folder, as a .command
 * file of mode 0700, which `open -a Terminal <file>` opens (an argument array). The folder is removed after `keepMs`
 * (10 minutes), or when Workbench exits, whichever is first, and at once when Terminal could not be asked.
 * Elsewhere: nothing is written or opened, and the answer is `{ opened: false }`; the caller shows the command.
 *
 * @param {{ title: string, program: string, args?: string[] }} what
 * @param {{ platform?: string, tmpDir?: string, open?: (argv: string[]) => Promise<void>, keepMs?: number }} [o]
 *   for tests: the platform, the temporary folder, and the `open` to call
 * @returns {Promise<{ opened: boolean }>}
 */
export async function openTerminal({ title, program, args = [] } = {}, { platform = process.platform, tmpDir = os.tmpdir(), open = openWithMacOS, keepMs = KEEP_MS } = {}) {
  const script = terminalScript({ title, program, args });
  if (platform !== 'darwin') return { opened: false };
  const dir = fs.mkdtempSync(path.join(tmpDir, 'workbench-terminal-'));
  fs.chmodSync(dir, 0o700);
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
