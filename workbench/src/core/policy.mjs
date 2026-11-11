// The permission policy. For one tool call an agent wants to make, decide whether it may go ahead
// on its own ('allow') or must wait for the person ('ask'). Nothing is denied outright by default.
//
// Strict by design: anything that is not clearly safe asks. The contract in ARCHITECTURE.md lists
// what may be allowed; this module adds a few extra conditions (documented inline) that only ever
// turn an allow into an ask, never the other way round.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRequest } from '../shared/narrate.mjs';

/** Tools that only look at things, plan, or coordinate helpers. Always allowed. */
export const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'ToolSearch',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TodoWrite',
  'Agent', 'Task', 'Monitor', 'SendMessage', 'Skill', 'WebSearch',
]);

/** Tools that change one file. Allowed only inside the agent's folder and outside .git. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Plain-language reasons, shown to the person and returned to the agent. */
const R = Object.freeze({
  noTool: 'It did not say which tool it wants to use.',
  safeTool: 'Looking at files, searching and planning are always allowed.',
  webFetch: 'Opening a web page needs your OK.',
  mcp: 'Tools that reach other services need your OK.',
  unknownTool: 'This tool is not on the list of safe tools.',
  broken: 'Something about this request could not be checked, so it needs your OK.',
  noCwd: "The agent's own folder could not be checked.",
  noFile: 'It did not say which file it wants to change.',
  fileInside: "The file is inside the agent's own folder.",
  fileOutside: "The file is outside the agent's own folder.",
  fileGit: "The file is part of git's own records, in the .git folder.",
  fileLinked: 'The file is also linked from another place on disk.',
  pathUnclear: 'The path could not be checked.',
  pathBack: 'The path steps back out of a folder that does not exist yet.',
  pathLink: 'The path goes through a link that points to something missing.',
  noCommand: 'It did not say which command it wants to run.',
  meta: 'The command chains, redirects or substitutes other commands.',
  control: 'The command contains hidden control characters.',
  quotes: 'The quotes in the command do not match up.',
  comment: 'Part of the command is hidden behind a # comment.',
  globCommand: 'The name of the command uses a wildcard.',
  globOption: 'A wildcard in this command could turn file names into options.',
  notSafe: 'This command is not on the list of safe commands.',
  readOnly: 'This command only reads.',
  writesFile: 'This command can write to a file.',
  runsProgram: 'This command can start other programs.',
  findDanger: 'This find command can delete files, write files or run other commands.',
  gitOption: 'Options before the git command can change what git runs.',
  gitSub: 'This git command can change the repository.',
  gitBranchDelete: 'This deletes a branch.',
  gitBranchChange: 'This renames, copies, moves or reconfigures a branch.',
  gitRead: 'This git command only reads.',
  tests: "This runs the project's tests, checks or build.",
  testsExtra: 'Extra options for this command need your OK.',
  testsOutside: "The command points at something outside the agent's own folder.",
  testsOption: 'This test command uses an option that can delete files, upload results or run other programs.',
  nodeInside: "The script is inside the agent's own folder.",
  nodeOutside: "The script is outside the agent's own folder.",
  nodeMissing: "The script is not a file in the agent's own folder.",
  nodeOption: 'This node command uses an option that can run code it was not given as a file.',
  extra: "This command is on the repository's list of allowed commands.",
});

const allow = reason => ({ decision: 'allow', reason });
const ask = reason => ({ decision: 'ask', reason });

/**
 * Decide on one tool call.
 * @param {{ tool: string, input?: object, cwd: string, extraAllow?: string[] }} req
 *   cwd is the agent's own folder (its workspace); extraAllow holds command prefixes from workbench.json.
 * @returns {{ decision: 'allow'|'ask'|'deny', reason: string, sentence: string, detail: string }}
 */
export function decide(req) {
  const { tool, input, cwd, extraAllow } = req && typeof req === 'object' ? req : {};
  const inp = input && typeof input === 'object' ? input : {};
  let verdict;
  try {
    verdict = judge(tool, inp, cwd, extraAllow);
  } catch {
    verdict = ask(R.broken); // fail closed on anything unexpected
  }
  let desc;
  try {
    desc = describeRequest(typeof tool === 'string' && tool ? tool : 'a tool', inp);
  } catch {
    desc = { sentence: 'wants to use a tool', detail: '' };
  }
  return { decision: verdict.decision, reason: verdict.reason, sentence: desc.sentence, detail: desc.detail };
}

function judge(tool, input, cwd, extraAllow) {
  if (typeof tool !== 'string' || !tool) return ask(R.noTool);
  if (SAFE_TOOLS.has(tool)) return allow(R.safeTool);
  if (EDIT_TOOLS.has(tool)) return judgeEdit(tool, input, cwd);
  if (tool === 'Bash') return judgeBash(input, cwd, extraAllow);
  if (tool === 'WebFetch') return ask(R.webFetch);
  if (tool.startsWith('mcp__')) return ask(R.mcp);
  return ask(R.unknownTool);
}

// ---------------------------------------------------------------------------------------------
// Paths

/** The real path of the agent's folder, or null when it is missing or not a folder. */
function realFolder(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) return null;
  try {
    const real = fs.realpathSync.native(cwd);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a path the way the operating system would, without requiring it to exist.
 * The longest existing prefix goes through realpath(3) (fs.realpathSync.native: unlike the JS
 * version it resolves `link/..` after following the link). The missing remainder is appended as
 * text, which is only safe when it has no '..' and does not start with a dangling link.
 * @returns {{ ok: true, real: string, exists: boolean } | { ok: false, reason: string }}
 */
export function resolveReal(p, baseReal) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return { ok: false, reason: R.pathUnclear };
  let s = p;
  if (s === '~' || s.startsWith('~/')) s = os.homedir() + s.slice(1);
  else if (s.startsWith('~')) return { ok: false, reason: R.pathUnclear }; // ~user: not worth guessing
  if (!s.startsWith('/')) s = baseReal + '/' + s; // keep '..' for the OS to resolve
  const parts = s.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/') || '/';
    let real;
    try {
      real = fs.realpathSync.native(prefix);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      return { ok: false, reason: R.pathUnclear }; // ELOOP, EACCES, ENOTDIR...: fail closed
    }
    const rest = parts.slice(i).filter(x => x !== '' && x !== '.');
    if (rest.includes('..')) return { ok: false, reason: R.pathBack };
    if (rest.length) {
      // realpath said "missing" but the entry is there: a link pointing at something missing.
      try {
        fs.lstatSync(path.join(real, rest[0]));
        return { ok: false, reason: R.pathLink };
      } catch (e) {
        if (!e || e.code !== 'ENOENT') return { ok: false, reason: R.pathUnclear };
      }
    }
    return { ok: true, real: rest.length ? path.join(real, ...rest) : real, exists: rest.length === 0 };
  }
  return { ok: false, reason: R.pathUnclear };
}

/** Where a real path sits relative to the agent's real folder: 'cwd', 'inside', 'git' or 'outside'. */
function placeOf(real, baseReal) {
  if (real === baseReal) return 'cwd';
  const prefix = baseReal.endsWith('/') ? baseReal : baseReal + '/';
  if (!real.startsWith(prefix)) return 'outside';
  // Case-insensitive: on a default macOS disk ".GIT/config" is the same file as ".git/config".
  const segs = real.slice(prefix.length).split('/');
  return segs.some(seg => seg.toLowerCase() === '.git') ? 'git' : 'inside';
}

function judgeEdit(tool, input, cwd) {
  const target = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : (input.file_path ?? input.notebook_path);
  if (typeof target !== 'string' || !target.trim()) return ask(R.noFile);
  const base = realFolder(cwd);
  if (!base) return ask(R.noCwd);
  const r = resolveReal(target, base);
  if (!r.ok) return ask(r.reason);
  const where = placeOf(r.real, base);
  if (where === 'git') return ask(R.fileGit);
  if (where !== 'inside') return ask(R.fileOutside);
  if (r.exists) {
    // A hard link shares its contents with another path, possibly outside the folder.
    const st = fs.statSync(r.real);
    if (st.isFile() && st.nlink > 1) return ask(R.fileLinked);
  }
  return allow(R.fileInside);
}

// ---------------------------------------------------------------------------------------------
// Bash

/** Shell metacharacters from the contract, plus backslash (escapes can hide any of them). */
const SHELL_META = /[;&|`$(){}<>\\\n\r]/;
/** Other control characters a terminal would not show. Tab is fine. */
const CONTROL = new RegExp("[\\x00-\\x08\\x0b-\\x1f\\x7f" + String.fromCharCode(0x2028, 0x2029) + "]");
const GLOB_CHARS = new Set(['*', '?', '[']);

/**
 * Split a command into words the way a POSIX shell would, once SHELL_META has been ruled out.
 * Quotes join onto the surrounding word ('ec'ho is "echo"). Each word records whether it has an
 * unquoted wildcard, and whether that wildcard could expand to something that starts with '-'.
 * @returns {{ words: { text: string, glob: boolean, globLead: boolean }[] } | { error: string }}
 */
export function splitWords(cmd) {
  const words = [];
  let cur = null;
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur.text += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { text: '', glob: false, globLead: false, quoted: false };
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur.quoted = true;
      continue;
    }
    if (ch === '#' && cur.text === '' && !cur.quoted) return { error: R.comment };
    // '^' and '#' are wildcards too when zsh's extendedglob option is on.
    if (GLOB_CHARS.has(ch) || ch === '^' || ch === '#') {
      cur.glob = true;
      // The expansion starts with the literal text before the wildcard. Empty or '-' means it
      // could become an option, such as a file someone named "-delete".
      if (cur.text === '' || cur.text.startsWith('-')) cur.globLead = true;
    }
    cur.text += ch;
  }
  if (quote) return { error: R.quotes };
  if (cur) words.push(cur);
  return { words: words.map(({ text, glob, globLead }) => ({ text, glob, globLead })) };
}

/** A short-option cluster (like -uo) that contains any of the letters. */
function shortHas(arg, letters) {
  return /^-[^-]/.test(arg) && [...arg.slice(1)].some(ch => letters.includes(ch));
}

/** A long option that is one of the names or an abbreviation of one (GNU tools accept those). */
function longIs(arg, names) {
  if (!arg.startsWith('--') || arg.length < 3) return false;
  const name = arg.slice(2).split('=')[0];
  return names.some(n => n.startsWith(name));
}

/**
 * Read-only commands from the contract. `null`: no option of the command writes or runs anything,
 * so wildcards are harmless. Otherwise the listed options make it ask (extra strictness: these are
 * the options that turn a "read-only" command into one that writes files or starts programs).
 */
const READ_ONLY = {
  ls: null, pwd: null, cat: null, head: null, tail: null, wc: null, echo: null, which: null,
  stat: null, diff: null, cut: null, grep: null,
  file: { short: 'C', long: ['compile'], why: R.writesFile },
  tree: { short: 'oR', long: ['output'], why: R.writesFile },
  sort: { short: 'o', long: ['output', 'compress-program'], why: R.writesFile },
  rg: { short: 'z', long: ['pre', 'pre-glob', 'search-zip', 'hostname-bin'], why: R.runsProgram },
  uniq: { uniq: true },
};

const FIND_BAD = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'branch']);
// git branch: only options that list branches. Creating a branch (a plain name) is fine.
const BRANCH_SHORT_OK = 'arvliq';
const BRANCH_LONG_OK = new Set(['all', 'remotes', 'verbose', 'list', 'show-current', 'merged', 'no-merged', 'contains',
  'no-contains', 'points-at', 'sort', 'format', 'color', 'no-color', 'column', 'no-column', 'ignore-case', 'abbrev',
  'no-abbrev', 'quiet']);
// node --test: test-runner options only. --import, --require, -e and friends run other code.
const NODE_TEST_OPT = /^--(test(-[a-z0-9-]+)?|experimental-test-[a-z0-9-]+|no-warnings|enable-source-maps|(no-)?experimental-strip-types|experimental-transform-types)(=.*)?$/;

function judgeBash(input, cwd, extraAllow) {
  const command = input.command;
  if (typeof command !== 'string' || !command.trim()) return ask(R.noCommand);
  if (SHELL_META.test(command)) return ask(R.meta);
  if (CONTROL.test(command)) return ask(R.control);
  const base = realFolder(cwd);
  if (!base) return ask(R.noCwd);
  const split = splitWords(command);
  if (split.error) return ask(split.error);
  const words = split.words;
  if (!words.length || !words[0].text) return ask(R.noCommand);
  if (words[0].glob) return ask(R.globCommand);
  const argv = words.map(w => w.text);

  // The repository owner's own prefixes. Their options are unknown to us, so wildcards that
  // could become options still ask.
  if (matchesExtra(argv, extraAllow)) {
    return words.some(w => w.globLead) ? ask(R.globOption) : allow(R.extra);
  }

  const cmd = argv[0];
  if (Object.hasOwn(READ_ONLY, cmd)) return judgeReadOnly(READ_ONLY[cmd], argv, words);
  if (cmd === 'find') {
    if (argv.slice(1).some(a => FIND_BAD.has(a))) return ask(R.findDanger);
    if (words.some(w => w.globLead)) return ask(R.globOption);
    return allow(R.readOnly);
  }
  if (cmd === 'git') return judgeGit(argv, words);
  return judgeRunner(argv, words, base) || ask(R.notSafe);
}

function judgeReadOnly(spec, argv, words) {
  if (!spec) return allow(R.readOnly);
  if (spec.uniq) {
    // uniq writes its second file argument, and a wildcard can supply one.
    if (words.some(w => w.glob)) return ask(R.globOption);
    let files = 0;
    for (let k = 1; k < argv.length; k++) {
      const a = argv[k];
      if (/^-[fsw]$/.test(a)) { k++; continue; } // these take a separate number
      if (!a.startsWith('-') || a === '-') files++;
    }
    return files > 1 ? ask(R.writesFile) : allow(R.readOnly);
  }
  if (words.some(w => w.globLead)) return ask(R.globOption);
  const args = argv.slice(1);
  if (args.some(a => shortHas(a, spec.short) || longIs(a, spec.long))) return ask(spec.why);
  return allow(R.readOnly);
}

function judgeGit(argv, words) {
  let i = 1;
  // Extra: --no-pager / -P only turn the pager off. Any other option before the subcommand
  // (-c, -C, --exec-path, --git-dir...) can change what git runs, so it asks.
  while (argv[i] === '--no-pager' || argv[i] === '-P') i++;
  const sub = argv[i];
  if (!sub || sub.startsWith('-')) return ask(R.gitOption);
  if (!GIT_READ.has(sub)) return ask(R.gitSub);
  const rest = argv.slice(i + 1);
  if (words.slice(i + 1).some(w => w.globLead)) return ask(R.globOption);
  if (rest.some(a => longIs(a, ['output']))) return ask(R.writesFile); // diff/log/show --output=<file>
  if (sub === 'grep' && rest.some(a => shortHas(a, 'O') || longIs(a, ['open-files-in-pager']))) return ask(R.runsProgram);
  if (sub === 'branch') {
    for (const a of rest) {
      if (a.startsWith('--')) {
        const name = a.slice(2).split('=')[0];
        if (!BRANCH_LONG_OK.has(name)) return ask('delete'.startsWith(name) && name ? R.gitBranchDelete : R.gitBranchChange);
      } else if (a.startsWith('-') && a.length > 1) {
        if ([...a.slice(1)].some(ch => !BRANCH_SHORT_OK.includes(ch))) return ask(/[dD]/.test(a) ? R.gitBranchDelete : R.gitBranchChange);
      }
    }
  }
  return allow(R.gitRead);
}

/** Test runners and `node <script>`. Returns null when the command is not one of them. */
function judgeRunner(argv, words, base) {
  const [c0, c1, c2] = argv;
  const n = argv.length;

  // Package scripts: exactly as listed, optionally followed by `--` and arguments for the script.
  // Extra: npm/pnpm/yarn options (--prefix, --script-shell...) can run other code, so they ask.
  let scriptAt = 0;
  if (c0 === 'npm' && c1 === 'test') scriptAt = 2;
  else if (c0 === 'npm' && c1 === 'run' && ['test', 'lint', 'build'].includes(c2)) scriptAt = 3;
  else if ((c0 === 'pnpm' || c0 === 'yarn') && c1 === 'test') scriptAt = 2;
  if (scriptAt) {
    if (n === scriptAt) return allow(R.tests);
    if (argv[scriptAt] !== '--') return ask(R.testsExtra);
    return runnerArgs(words.slice(scriptAt + 1), base, null);
  }
  if (c0 === 'make' && c1 === 'test') return n === 2 ? allow(R.tests) : ask(R.testsExtra);

  if (c0 === 'pytest') return runnerArgs(words.slice(1), base, PYTEST_BAD);
  if ((c0 === 'python' || c0 === 'python3') && c1 === '-m' && c2 === 'pytest') return runnerArgs(words.slice(3), base, PYTEST_BAD);
  if (c0 === 'go' && c1 === 'test') return runnerArgs(words.slice(2), base, GO_BAD);
  if (c0 === 'cargo' && c1 === 'test') return runnerArgs(words.slice(2), base, CARGO_BAD);
  if (c0 === 'npx' && (c1 === 'jest' || c1 === 'vitest')) return runnerArgs(words.slice(2), base, null);

  if (c0 === 'node') {
    if (c1 === '--test') {
      for (const w of words.slice(2)) {
        if (w.text.startsWith('-') && !NODE_TEST_OPT.test(w.text)) return ask(R.nodeOption);
      }
      return runnerArgs(words.slice(2), base, null);
    }
    if (!c1 || c1.startsWith('-')) return ask(R.nodeOption); // -e, -p, --import, a REPL...
    if (words[1].glob) return ask(R.globOption);
    const r = resolveReal(c1, base);
    if (!r.ok) return ask(r.reason);
    if (placeOf(r.real, base) !== 'inside') return ask(R.nodeOutside);
    // It must be a file that is there: "node inspect /tmp/x.js" names no file but runs one.
    if (!r.exists || !fs.statSync(r.real).isFile()) return ask(R.nodeMissing);
    return allow(R.nodeInside); // arguments after the script belong to the script

  }
  return null;
}

// Test-runner options that delete folders, upload results or wrap the tests in another program.
const PYTEST_BAD = arg => longIs(arg, ['basetemp', 'pastebin']);
const GO_BAD = arg => /^--?(exec|toolexec)(=|$)/.test(arg);
const CARGO_BAD = arg => /^--config(=|$)/.test(arg) || arg.startsWith('-Z');

/**
 * Arguments of a test runner: no option from the runner's bad list, no wildcard that could
 * become an option, and nothing that points outside the agent's folder (extra strictness:
 * a config, plugin or output path outside the folder would run or write things elsewhere).
 */
function runnerArgs(words, base, bad) {
  for (const w of words) {
    if (w.globLead) return ask(R.globOption);
    if (bad && bad(w.text)) return ask(R.testsOption);
    for (const piece of pathPieces(w)) {
      const r = resolveReal(piece, base);
      if (!r.ok) return ask(R.testsOutside);
      const where = placeOf(r.real, base);
      if (where !== 'inside' && where !== 'cwd') return ask(R.testsOutside);
    }
  }
  return allow(R.tests);
}

/** Every piece of a word that could name a path: the word, `--opt=<value>`, `-c<value>`, `a:b,c`. */
function pathPieces(w) {
  let t = w.text;
  if (w.glob) t = t.slice(0, t.search(/[*?[^#]/)); // only the literal text before a wildcard is known
  const out = new Set();
  const add = s => { if (s && !s.startsWith('-')) out.add(s); };
  if (/^-[^-]/.test(t)) add(t.slice(2));
  add(t);
  for (const part of t.split(/[=:,]/)) add(part);
  return out;
}

/** Whole-word prefixes from workbench.json's "allow" list. Blank or shell-like entries are skipped. */
function matchesExtra(argv, extraAllow) {
  const list = typeof extraAllow === 'string' ? [extraAllow] : Array.isArray(extraAllow) ? extraAllow : [];
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    if (SHELL_META.test(entry) || CONTROL.test(entry)) continue;
    const split = splitWords(entry.trim());
    if (split.error || !split.words.length || split.words.some(w => w.glob)) continue;
    const prefix = split.words.map(w => w.text);
    if (prefix.length <= argv.length && prefix.every((p, k) => p === argv[k])) return true;
  }
  return false;
}
