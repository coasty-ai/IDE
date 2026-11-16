// Turns agent tool calls into short plain-language sentences.
// Shared by the engine and the UI. No Node imports.
import { clip } from './format.mjs';

/** Kinds of activity, used for the hover-card counts. */
export const KIND = Object.freeze({
  READ: 'read', SEARCH: 'search', EDIT: 'edit', RUN: 'run', WEB: 'web',
  HELPER: 'helper', PLAN: 'plan', TALK: 'talk', OTHER: 'other',
});

export function baseName(p) {
  if (!p) return 'a file';
  const parts = String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || String(p);
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function lower1(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
function noDot(s) { return String(s || '').trim().replace(/[.\s]+$/, ''); }
function quoted(s, n = 32) { return '“' + clip(String(s), n) + '”'; }

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

// ---------------------------------------------------------------------------------------------
// Shell commands in plain words. Judged from the command alone, never from the agent's own description of
// it: the agent writes that, so it can say anything ("Run the tests" for `curl … | sh`).

/**
 * Split a shell command into the simple commands it runs: the parts joined by ; & | && || or new lines, and
 * the commands inside $( ), ` ` and ( ). Quotes are respected and heredoc text is skipped, so quoted text is
 * not taken for a command. Each part notes whether it sends its output into a file.
 * Only used to put a command into words; the permission policy never relies on it.
 * @returns {{ text: string, writes: boolean }[]}
 */
function shellParts(cmd) {
  const parts = [];
  let cur = { text: '', writes: false };
  let q = null; // the open quote, ' or "
  const outer = []; // the quote to go back to when a $( ), ( ) or ` ` ends
  let heredoc = null; // { word, tabs }: the text from the next line up to `word` is data, not commands
  const end = () => { if (cur.text.trim()) parts.push(cur); cur = { text: '', writes: false }; };
  for (let k = 0; k < cmd.length; k++) {
    const ch = cmd[k];
    if (q === "'") { if (ch === "'") q = null; cur.text += ch; continue; }
    if (ch === '\\') { cur.text += ch + (cmd[k + 1] || ''); k++; continue; }
    if (ch === '`') {
      end();
      if (outer.at(-1)?.tick) q = outer.pop().q;
      else { outer.push({ q, tick: true }); q = null; }
      continue;
    }
    if (ch === '$' && cmd[k + 1] === '(') { end(); outer.push({ q, tick: false }); q = null; k++; continue; }
    if (ch === '$' && cmd[k + 1] === '{') { // ${NAME} is part of a word
      const close = cmd.indexOf('}', k);
      const to = close < 0 ? cmd.length : close + 1;
      cur.text += cmd.slice(k, to);
      k = to - 1;
      continue;
    }
    if (q === '"') { if (ch === '"') q = null; cur.text += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur.text += ch; continue; }
    if (ch === '(') { end(); outer.push({ q: null, tick: false }); continue; }
    if (ch === ')') { end(); if (outer.length && !outer.at(-1).tick) q = outer.pop().q; continue; }
    if (ch === '\n' && heredoc) { // skip the heredoc's text, up to its end word
      end();
      let at = k + 1;
      for (;;) {
        const nl = cmd.indexOf('\n', at);
        const line = cmd.slice(at, nl < 0 ? cmd.length : nl);
        if ((heredoc.tabs ? line.replace(/^\t+/, '') : line) === heredoc.word || nl < 0) { k = nl < 0 ? cmd.length : nl; break; }
        at = nl + 1;
      }
      heredoc = null;
      continue;
    }
    if (ch === '&' && cmd[k + 1] === '>') { cur.text += ch; continue; } // &> file: a redirection, not "&"
    if (';&|{}\n\r'.includes(ch)) { end(); continue; }
    if (ch === '<' && cmd[k + 1] === '<' && cmd[k + 2] !== '<') {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(cmd.slice(k, k + 200));
      if (m) { heredoc = { word: m[3], tabs: m[1] === '-' }; cur.text += m[0]; k += m[0].length - 1; continue; }
    }
    if (ch === '>') {
      // `> file` and `>> file` write a file; `2>&1` and `> /dev/null` do not.
      const m = /^>[>|]?\s*(&|\/dev\/(null|stdout|stderr|tty)\b)?/.exec(cmd.slice(k, k + 40));
      if (!m[1]) cur.writes = true;
      else if (m[1] === '&') { cur.text += m[0]; k += m[0].length - 1; continue; } // keep "&1" in this part
    }
    cur.text += ch;
  }
  end();
  return parts;
}

/** The words of one part, with quotes and backslashes removed the way the shell would. */
function shellWords(text) {
  const out = [];
  let w = null;
  let q = null;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && k + 1 < text.length) w += text[++k];
      else w += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') { if (w !== null) out.push(w); w = null; continue; }
    if (w === null) w = '';
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '\\' && k + 1 < text.length) w += text[++k];
    else w += ch;
  }
  if (w !== null) out.push(w);
  return out;
}

/** Words that run the command after them (with their own options and numbers), and shell keywords. */
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'xargs', 'stdbuf',
  'caffeinate', 'unbuffer', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const RUNS_CODE = new Set([...SHELLS, 'source', '.', 'eval', 'node', 'python', 'python2', 'python3', 'perl', 'ruby',
  'php', 'deno', 'bun', 'tsx', 'ts-node', 'osascript', 'Rscript', 'lua', 'awk', 'gawk', 'pwsh']);
const PACKAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/**
 * git commands that only look: the same list as the permission policy's GIT_READ, which this file cannot import (the page
 * loads it as it is). test/narrate.test.mjs keeps the two in step.
 */
const GIT_LOOK = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse', 'shortlog', 'describe',
  'annotate', 'cat-file', 'cherry', 'count-objects', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'ls-remote', 'ls-tree',
  'merge-base', 'name-rev', 'range-diff', 'rev-list', 'show-branch', 'show-ref', 'verify-commit', 'verify-tag', 'whatchanged',
  'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'diff-pairs', 'get-tar-commit-id', 'help', 'var', 'version']);
/** Options before git's command that take the next word as their value. */
const GIT_VALUE_OPTS = /^(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source)$/;

/**
 * One simple command: its program (without a folder), the words after it, and what git or a package tool is asked
 * to do. `words` keeps every word of the part, and `at` is where the program is among them (after NAME=value and
 * wrappers such as `timeout 10`).
 */
function simpleCommand(words, writes) {
  let k = 0;
  for (;;) {
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++; // NAME=value before the command
    if (k < words.length && WRAPPERS.has(words[k])) {
      k++;
      while (k < words.length && /^(-|\d)/.test(words[k])) k++;
      continue;
    }
    break;
  }
  if (k >= words.length) return null;
  const word = words[k];
  // A program named by its path is a script, unless the path is one of the system's own program folders.
  const script = word.includes('/') && !/^\/(usr\/(local\/)?)?s?bin\/|^\/opt\/homebrew\/bin\//.test(word);
  const c = { prog: word.replace(/^.*\//, ''), script, args: words.slice(k + 1), writes, sub: '', subArgs: [], gitOpts: false, words, at: k };
  if (c.prog === 'git') {
    let j = 0;
    while (j < c.args.length && c.args[j].startsWith('-')) {
      if (!/^(--no-pager|-P|--paginate|--no-optional-locks)$/.test(c.args[j])) c.gitOpts = true;
      if (GIT_VALUE_OPTS.test(c.args[j])) j++;
      j++;
    }
    c.sub = c.args[j] || '';
    c.subArgs = c.args.slice(j + 1);
  } else c.sub = c.args[0] || '';
  return c;
}

/**
 * Every simple command in a command line, looking inside `sh -c '…'`, `eval '…'` and `find … -exec …`.
 * A shell given its command inline (`zsh -lc 'cat a.js'`, as Codex runs everything) stands for that
 * command, so it is marked `inline` and is not counted as a script of its own. A part that only sets
 * variables (`PATH=/x:$PATH`) runs nothing itself, but it can change what the parts after it run; it is
 * kept, marked `empty`.
 */
function simpleCommands(command, depth = 0) {
  const out = [];
  for (const part of shellParts(String(command || ''))) {
    const words = shellWords(part.text);
    const c = simpleCommand(words, part.writes);
    if (!c) {
      if (words.length) out.push({ empty: true, prog: '', script: false, args: [], writes: part.writes, sub: '', subArgs: [], gitOpts: false, words, at: words.length });
      continue;
    }
    out.push(c);
    const dashC = SHELLS.has(c.prog) ? c.args.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a)) : -1;
    const inner = dashC >= 0 && c.args[dashC + 1] !== undefined ? c.args[dashC + 1] : c.prog === 'eval' ? c.args.join(' ') : null;
    if (inner !== null) c.inline = true;
    if (depth > 2) continue;
    if (inner !== null) out.push(...simpleCommands(inner, depth + 1));
    const exec = c.prog === 'find' ? c.args.findIndex(a => /^-(exec|execdir|ok|okdir)$/.test(a)) : -1;
    if (exec >= 0) {
      const inner = simpleCommand(c.args.slice(exec + 1), false);
      if (inner) out.push(inner);
    }
  }
  return out;
}

const isTest = c => (PACKAGERS.has(c.prog) && (/^(test|t)$/.test(c.sub) || (c.sub === 'run' && /^test\b/.test(c.args[1] || ''))))
  || (c.prog === 'node' && (c.sub === '--test' || (!c.sub.startsWith('-') && c.sub.includes('test'))))
  || ['pytest', 'jest', 'vitest', 'mocha', 'rspec', 'phpunit', 'ava'].includes(c.prog)
  || (/^python[23]?$/.test(c.prog) && c.args[0] === '-m' && /^(pytest|unittest)$/.test(c.args[1] || ''))
  || (['go', 'cargo', 'make', 'deno', 'dotnet', 'mvn', 'gradle', 'mix'].includes(c.prog) && c.sub === 'test');
const isLint = c => ['eslint', 'prettier', 'ruff', 'flake8', 'black', 'rubocop', 'golangci-lint', 'stylelint', 'pylint', 'biome', 'shellcheck'].includes(c.prog)
  || (PACKAGERS.has(c.prog) && c.sub === 'run' && /^(lint|format)\b/.test(c.args[1] || ''));
const isBuild = c => (PACKAGERS.has(c.prog) && c.sub === 'run' && /^build\b/.test(c.args[1] || ''))
  || (c.prog === 'make' && (!c.args.length || /^(all|build)$/.test(c.sub)))
  || (['cargo', 'go', 'gradle'].includes(c.prog) && c.sub === 'build') || c.prog === 'tsc';
/** npx and friends: a test, lint or build tool is that; anything else may be fetched from the internet and run. */
const packageTool = c => {
  let rest = null;
  if (['npx', 'pnpx', 'bunx', 'uvx'].includes(c.prog)) rest = c.args;
  else if ((c.prog === 'npm' && /^(exec|x)$/.test(c.sub)) || (['pnpm', 'yarn'].includes(c.prog) && c.sub === 'dlx') || (c.prog === 'pipx' && c.sub === 'run')) rest = c.args.slice(1);
  if (!rest) return null;
  const at = rest.findIndex(a => !a.startsWith('-'));
  return at < 0 ? { prog: '', args: [], sub: '' } : { prog: rest[at], args: rest.slice(at + 1), sub: rest[at + 1] || '' };
};
const isInstall = c => (PACKAGERS.has(c.prog) && (/^(install|i|add|ci)$/.test(c.sub) || (c.prog === 'yarn' && !c.args.length)))
  || (/^pip3?$/.test(c.prog) && c.sub === 'install')
  || (/^python[23]?$/.test(c.prog) && c.args[0] === '-m' && /^pip3?$/.test(c.args[1] || '') && c.args[2] === 'install')
  || (['brew', 'apt', 'apt-get', 'yum', 'dnf', 'gem', 'port', 'pipx', 'conda', 'pipenv'].includes(c.prog) && c.sub === 'install')
  || (['uv', 'poetry', 'cargo', 'go', 'composer', 'apk'].includes(c.prog) && /^(add|install|get|require|sync)$/.test(c.sub))
  || (c.prog === 'uv' && c.sub === 'pip' && c.args[1] === 'install') || (c.prog === 'bundle' && (!c.args.length || c.sub === 'install'));
const isUpload = c => (c.prog === 'curl' && c.args.some((a, k) => /^-[a-zA-Z]*[dFT]/.test(a) || /^--(data|form|upload-file|json)/.test(a)
    || /^-X(POST|PUT|PATCH)/i.test(a) || (/^(-X|--request)$/.test(a) && /^(POST|PUT|PATCH)$/i.test(c.args[k + 1] || ''))))
  || (c.prog === 'wget' && c.args.some(a => /^--(post|body)-(data|file)|^--method/.test(a)));
const DOWNLOADERS = new Set(['curl', 'wget', 'aria2c', 'http', 'https', 'xh']);
/** git branch that deletes, renames, copies or reconfigures a branch, rather than listing them. */
const branchChange = c => c.subArgs.some(a => /^(-[a-zA-Z]*[dDmMcCfu]|--(delete|move|copy|force|set-upstream|unset-upstream|edit-description))/.test(a));
/** git commands that only look: the readers, and the listing forms of branch, stash, remote, worktree, tag and reflog. */
const gitLooks = c => GIT_LOOK.has(c.sub) || (c.sub === 'branch' && !branchChange(c))
  || (c.sub === 'stash' && /^(list|show)$/.test(c.subArgs[0] || ''))
  || (c.sub === 'remote' && (!c.subArgs.length || /^(-v|--verbose|show|get-url)$/.test(c.subArgs[0])))
  || (c.sub === 'worktree' && c.subArgs[0] === 'list')
  || (c.sub === 'tag' && (!c.subArgs.length || /^(-l|--list|-n\d*)$/.test(c.subArgs[0])))
  || (c.sub === 'reflog' && (!c.subArgs.length || c.subArgs[0] === 'show'));

// ---------------------------------------------------------------------------------------------
// git's words: what a push, pull, fetch or clone names, read from the command alone (never from the repository).

/** A name a command gives, fit for a sentence: hidden characters become spaces, and a long one is clipped. */
const said = (s, n = 40) => clip(String(s).replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim(), n);

/** A long option, or the start of one (git takes `--forc` for `--force`): whether it names one of `list`. */
const longOf = (name, list) => !!name && list.some(n => n.startsWith(name));

/**
 * The words of a git command that are not options or their values. `values`: the options that take the next word, by
 * their whole names (so --recurse-submodules, which takes none, is not read as --recurse-submodules-default).
 */
function gitOperands(args, values = {}) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { out.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      if (!a.includes('=') && (values.long || []).includes(a.slice(2))) k++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const at = [...a.slice(1)].findIndex(ch => (values.short || '').includes(ch));
      if (at >= 0 && at === a.length - 2) k++; // a short option that takes a value, last in its word: the next word
      continue;
    }
    out.push(a);
  }
  return out;
}

/** The computer an address names, or null for a folder on this one: https://host/…, ssh://…, user@host:path. */
function addressOf(word) {
  const w = String(word);
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)(?::\d*)?(\/[^?#]*)?/i.exec(w);
  if (url) return { host: url[1], path: url[2] || '' };
  const scp = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.*)$/.exec(w);
  return scp && !/^[./~]/.test(w) ? { host: scp[1], path: scp[2] } : null;
}

/**
 * Where a remote is, in words: GitHub for an address on github.com, the computer's name for another address, and
 * anything else as a name, "the remote “origin”": the agent chooses a remote's name, so a remote it calls "GitHub" must
 * not read as GitHub. Curly quotes in the name become straight ones, so it cannot close its own quote ("x” on GitHub").
 */
function remoteWords(word) {
  const at = addressOf(word);
  if (!at) return `the remote “${said(word, 32).replace(/[“-‟″‶]/g, '"')}”`;
  return /^(www\.)?github\.com$/i.test(at.host) ? 'GitHub' : said(at.host.toLowerCase());
}

/** A branch or tag as a refspec names it: main for refs/heads/main, its branch for HEAD (or @, or nothing). */
const refName = r => (!r || r === 'HEAD' || r === '@' ? 'its branch' : said(r.replace(/^refs\/(heads|tags|remotes)\//, ''), 32));

/** The branch or tag a pull's refspec brings in, its source: main for refs/heads/main or main:main, old for :old. */
function refWord(spec) {
  const s = String(spec).replace(/^\+/, '');
  const at = s.indexOf(':');
  let src = at < 0 ? s : s.slice(0, at);
  if (!src && at >= 0) src = s.slice(at + 1); // ":old" deletes old
  return refName(src);
}

/**
 * A push refspec: what it sends (`from`, null for ":old", which deletes old) and the branch or tag it changes on the
 * remote (`to`): its destination, or the source's own name when it names none. HEAD:main sends its branch to main.
 */
function pushRef(spec) {
  const s = String(spec).replace(/^\+/, '');
  const at = s.indexOf(':');
  const src = at < 0 ? s : s.slice(0, at);
  const dst = at < 0 ? '' : s.slice(at + 1);
  return { from: src ? refName(src) : null, to: dst ? said(dst.replace(/^refs\/(heads|tags|remotes)\//, ''), 32) : refName(src) };
}

const listNames = names => {
  const u = [...new Set(names)];
  return u.length === 1 ? u[0] : u.length === 2 ? `${u[0]} and ${u[1]}` : `${u.length} branches`;
};

/** git push: whether it replaces (force, mirror) or deletes (delete, prune, a :refspec), and what it names. */
function readPush(args) {
  const p = { force: false, delete: false, mirror: false, prune: false, all: false, tags: false, ops: [] };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { p.ops.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (longOf(name, ['force', 'force-with-lease', 'force-if-includes'])) p.force = true;
      else if (longOf(name, ['delete'])) p.delete = true;
      else if (longOf(name, ['mirror'])) p.mirror = true;
      else if (longOf(name, ['prune'])) p.prune = true;
      else if (name === 'all' || name === 'branches') p.all = true;
      else if (name === 'tags') p.tags = true;
      else if (!a.includes('=') && longOf(name, ['repo', 'push-option', 'receive-pack', 'exec'])) k++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'f') p.force = true;
        if (a[j] === 'd') p.delete = true;
        if (a[j] === 'o') { if (j === a.length - 1) k++; break; } // -o <push option>
      }
      continue;
    }
    p.ops.push(a);
  }
  const [remote, ...refs] = p.ops;
  if (p.ops.some(r => r.startsWith('+'))) p.force = true;
  if (refs.some(r => r.startsWith(':'))) p.delete = true;
  return { ...p, remote, refs };
}

/**
 * "Pushing main to the remote “origin”", "Pushing its branch to GitHub", "Pushing its branch to main on GitHub" (HEAD:main),
 * "Replacing main on the remote “origin”", "Deleting old on GitHub". A refspec is named by the branch it changes on the
 * remote, its destination: `push --force origin HEAD:main` replaces main, whatever is sent onto it.
 */
function pushWords(c) {
  const p = readPush(c.subArgs);
  const remote = p.remote ? remoteWords(p.remote) : '';
  const refs = p.refs.map(pushRef);
  const names = refs.map(r => r.to);
  if (p.delete || p.prune) {
    const what = p.delete && names.length ? listNames(names) : 'branches';
    const on = ` on ${remote || 'the remote'}`;
    return { does: `delete ${what}${on}`, doing: `Deleting ${what}${on}` };
  }
  const what = p.mirror ? 'everything' : names.length ? listNames(names) : p.all ? 'every branch' : p.tags ? 'its tags' : 'its branch';
  if (p.force || p.mirror) {
    const on = ` on ${remote || 'the remote'}`;
    return { does: `replace ${what}${on}`, doing: `Replacing ${what}${on}` };
  }
  // One branch sent onto a branch of another name: both are named.
  const [one] = refs;
  if (refs.length === 1 && one.from && one.from !== one.to && remote) {
    return { does: `push ${one.from} to ${one.to} on ${remote}`, doing: `Pushing ${one.from} to ${one.to} on ${remote}` };
  }
  const to = remote ? ` to ${remote}` : '';
  return { does: `push ${what}${to}`, doing: `Pushing ${what}${to}` };
}

const FETCH_VALUES = ['depth', 'deepen', 'shallow-since', 'shallow-exclude', 'jobs', 'upload-pack', 'server-option',
  'negotiation-tip', 'refmap', 'filter', 'submodule-prefix', 'recurse-submodules-default'];

/** "Bringing in main from origin", "Bringing in changes". */
function pullWords(c) {
  const [remote, ...refs] = gitOperands(c.subArgs, { short: 'sXjo', long: [...FETCH_VALUES, 'strategy', 'strategy-option'] });
  const what = refs.length ? listNames(refs.map(refWord)) : 'changes';
  const from = remote ? ` from ${remoteWords(remote)}` : '';
  return { does: `bring in ${what}${from}`, doing: `Bringing in ${what}${from}` };
}

/** "Downloading new commits from origin", "… from every remote". */
function fetchWords(c) {
  const [remote] = gitOperands(c.subArgs, { short: 'jo', long: FETCH_VALUES });
  const from = remote ? ` from ${remoteWords(remote)}` : c.subArgs.includes('--all') ? ' from every remote' : '';
  return { does: `download new commits${from}`, doing: `Downloading new commits${from}` };
}

/** "Downloading owner/repo from GitHub", "Downloading repo from gitlab.com"; a folder on this computer is copied. */
function cloneWords(c) {
  const [source] = gitOperands(c.subArgs, { short: 'objuc', long: ['origin', 'branch', 'upload-pack', 'reference', 'reference-if-able',
    'separate-git-dir', 'depth', 'shallow-since', 'shallow-exclude', 'jobs', 'config', 'template', 'filter', 'server-option',
    'bundle-uri', 'ref-format', 'revision'] });
  if (!source) return null;
  const at = addressOf(source);
  if (!at) return { does: 'copy a repository', doing: 'Copying a repository' };
  const github = /^(www\.)?github\.com$/i.test(at.host);
  const where = github ? 'GitHub' : said(at.host.toLowerCase());
  const parts = at.path.split('/').filter(Boolean).map(s => s.replace(/\.git$/i, ''));
  const name = (github ? parts.slice(-2).join('/') : parts.at(-1)) || '';
  const what = name ? said(name) : 'a repository';
  return { does: `download ${what} from ${where}`, doing: `Downloading ${what} from ${where}` };
}

/** git config that only reads (words only: the permission policy decides this for itself). */
function configReads(args) {
  let reads = false;
  const names = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { names.push(...args.slice(k + 1)); break; }
    if (/^--(add|replace-all|unset|unset-all|rename-section|remove-section|edit|comment)(=|$)/.test(a) || /^-[a-z]*e/.test(a)) return false;
    if (/^--(get|list)/.test(a) || /^-[a-z]*l/.test(a)) { reads = true; continue; }
    if (/^--(file|blob|type|default|value|url)$/.test(a) || /^-[a-z]*f$/.test(a)) { k++; continue; }
    if (!a.startsWith('-')) names.push(a);
  }
  if (/^(set|unset|rename-section|remove-section|edit)$/.test(names[0] || '')) return false;
  return reads || names[0] === 'get' || names[0] === 'list' || names.length <= 1;
}

/** A download and something that runs code, anywhere in the same command line. */
const FROM_INTERNET = ['run code from the internet', 'Running code from the internet'];

/**
 * What one simple command does, most important first: each command gets the first entry it matches.
 * Each entry: [does, doing, test, routine, words]. Routine entries only ever describe a whole command line when
 * every other part of it is routine too, or does nothing (see commandAction). `words` (optional) puts what the
 * command names into the sentence ("push main to origin"); without it, or when it has nothing, does and doing stand.
 */
const ACTIONS = [
  ['run a command with administrator rights', 'Running a command with administrator rights', c => ['sudo', 'doas', 'su', 'pkexec'].includes(c.prog)],
  ['send data to the internet', 'Sending data to the internet', isUpload],
  ['connect to another computer', 'Connecting to another computer', c => ['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'mosh'].includes(c.prog)
    || (c.prog === 'rsync' && c.args.some(a => /^[^-/][^/]*:/.test(a)))],
  ['use your saved sign-in', 'Using your saved sign-in', c => c.prog === 'git' && /^credential(-|$)/.test(c.sub)],
  ['delete files', 'Deleting files', c => ['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash'].includes(c.prog)
    || (c.prog === 'git' && /^(clean|rm)$/.test(c.sub)) || (c.prog === 'find' && c.args.includes('-delete'))],
  ['push changes', 'Pushing changes', c => c.prog === 'git' && c.sub === 'push', false, pushWords],
  ['publish a package', 'Publishing a package', c => ([...PACKAGERS, 'cargo'].includes(c.prog) && c.sub === 'publish')
    || (c.prog === 'twine' && c.sub === 'upload') || (c.prog === 'gem' && c.sub === 'push')],
  ['install packages', 'Installing packages', isInstall],
  ['run a package from the internet', 'Running a package from the internet', c => { const t = packageTool(c); return !!t && !(isTest(t) || isLint(t) || isBuild(t)); }],
  ['bring in changes', 'Bringing in changes', c => c.prog === 'git' && c.sub === 'pull', false, pullWords],
  ['download a repository', 'Downloading a repository', c => c.prog === 'git' && c.sub === 'clone', false, cloneWords],
  ['download new commits', 'Downloading new commits', c => c.prog === 'git' && c.sub === 'fetch', false, fetchWords],
  ['download from the internet', 'Downloading from the internet', c => DOWNLOADERS.has(c.prog)],
  ['save its changes in git', 'Saving its changes in git', c => c.prog === 'git' && c.sub === 'commit'],
  ['run a git command', 'Running a git command', c => c.prog === 'git' && c.gitOpts], // -C, -c, --git-dir...
  ['change git settings', 'Changing git settings', c => c.prog === 'git' && c.sub === 'config' && !configReads(c.subArgs)],
  ['write files from the repository', 'Writing files from the repository', c => c.prog === 'git'
    && (c.sub === 'archive' || c.sub === 'format-patch' || (c.sub === 'bundle' && c.subArgs[0] === 'create'))],
  ['change the repository', 'Changing the repository', c => c.prog === 'git' && !!c.sub && c.sub !== 'config' && !gitLooks(c)],
  ['run the tests', 'Running the tests', c => isTest(c) || (!!packageTool(c) && isTest(packageTool(c))), true],
  ['check the code style', 'Checking the code style', c => isLint(c) || (!!packageTool(c) && isLint(packageTool(c))), true],
  ['build the project', 'Building the project', c => isBuild(c) || (!!packageTool(c) && isBuild(packageTool(c))), true],
  ['run a script', 'Running a script', c => (RUNS_CODE.has(c.prog) && !c.inline) || (['go', 'cargo'].includes(c.prog) && c.sub === 'run') || c.script],
  ['stop a program', 'Stopping a program', c => ['kill', 'pkill', 'killall'].includes(c.prog)],
  ['change file permissions', 'Changing file permissions', c => ['chmod', 'chown', 'chgrp', 'chflags', 'xattr', 'setfacl'].includes(c.prog)],
  ['move files', 'Moving files', c => c.prog === 'mv'],
  ['copy files', 'Copying files', c => ['cp', 'rsync', 'ditto'].includes(c.prog)],
  ['write to a file', 'Writing to a file', c => c.writes || ['tee', 'dd'].includes(c.prog)
    || (c.prog === 'sed' && c.args.some(a => /^-[a-zA-Z]*i|^--in-place/.test(a)))],
  ['create a folder', 'Creating a folder', c => c.prog === 'mkdir'],
  ['create a file', 'Creating a file', c => c.prog === 'touch'],
  ['create a link', 'Creating a link', c => c.prog === 'ln'],
  ['open something on this computer', 'Opening something on this computer', c => c.prog === 'open' || c.prog === 'xdg-open'],
  ["check git's settings", "Checking git's settings", c => c.prog === 'git' && c.sub === 'config', true], // one that only reads
  ['check what changed', 'Checking what changed', c => c.prog === 'git' && gitLooks(c), true],
  ['compare files', 'Comparing files', c => ['diff', 'cmp', 'comm'].includes(c.prog), true],
  ['look at the files', 'Looking at the files', c => ['ls', 'find', 'tree', 'fd', 'du', 'stat', 'file'].includes(c.prog) || (c.prog === 'rg' && c.args.includes('--files')), true],
  ['search the code', 'Searching the code', c => ['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack'].includes(c.prog), true],
  ['read a file', 'Reading a file', c => ['cat', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'sort', 'uniq', 'cut', 'nl', 'od', 'xxd', 'strings'].includes(c.prog)
    || (c.prog === 'sed' && c.args[0] === '-n'), true],
];

const WRITES = ACTIONS.findIndex(([does]) => does === 'write to a file');

/**
 * Commands with nothing to tell the person that do not change what the commands after them mean. (`cd` is
 * here: the folder shows in the exact command. `export` and `set` are not: a changed PATH is not a no-op.)
 */
const NOOPS = new Set(['cd', 'pushd', 'popd', 'echo', 'printf', 'true', 'false', ':', 'pwd', 'sleep', 'wait', 'test', '[', '[[',
  'which', 'type', 'date', 'exit']);

/**
 * What a shell command does, in plain words: `{ does: 'delete files', doing: 'Deleting files', routine: false }`,
 * or null when the command is not one these words cover. `routine` marks everyday words ("run the tests", "read a
 * file"), which only ever speak for a line whose other parts are everyday too or do nothing.
 *
 * `vouch` (optional, used by the permission policy) is called with each part that would get an everyday word, and
 * with each inline shell (`sh -c '…'`). When it returns false, that part counts as one these words cannot name, so
 * a risky option such as `sort -o ~/.zshrc` never reads as "read a file". With `vouch`, a part that only sets
 * variables counts as unnamed too.
 */
export function commandAction(command, vouch) {
  let cmds;
  try { cmds = simpleCommands(command); } catch { return null; } // words are a courtesy; never break narration
  if (cmds.some(c => DOWNLOADERS.has(c.prog)) && cmds.some(c => RUNS_CODE.has(c.prog))) return { does: FROM_INTERNET[0], doing: FROM_INTERNET[1], routine: false };
  let main = -1; // the most important entry that is not routine
  let routine = -1; // the most important routine entry
  let unknown = false; // a part these words cannot name
  const named = new Map(); // entry -> the first part it describes, for its words
  const note = (k, c) => {
    if (c && !named.has(k)) named.set(k, c);
    if (ACTIONS[k][3]) { if (routine < 0 || k < routine) routine = k; } else if (main < 0 || k < main) main = k;
  };
  for (const c of cmds) {
    if (c.empty) {
      if (vouch) { unknown = true; if (c.writes) note(WRITES); }
      continue;
    }
    const k = ACTIONS.findIndex(([, , test]) => test(c));
    if (k >= 0) {
      if (ACTIONS[k][3] && vouch && !vouch(c)) unknown = true;
      else note(k, c);
    } else if (c.inline) {
      if (vouch && !vouch(c)) unknown = true;
    } else if (!NOOPS.has(c.prog)) unknown = true;
    if (c.writes) note(WRITES); // "npm test > out.txt" also writes a file
  }
  // "npm test; rm -rf ~" deletes files, and "npm test && ./deploy.sh" runs a script. A routine word such as
  // "run the tests" speaks for the line only when nothing else in it needs naming.
  const k = main >= 0 ? main : unknown ? -1 : routine;
  if (k < 0) return null;
  const [does, doing, , everyday, words] = ACTIONS[k];
  let own = null; // the words of what this command names, if its entry has them
  if (words && named.has(k)) { try { own = words(named.get(k)); } catch { own = null; } }
  return { does: own?.does ?? does, doing: own?.doing ?? doing, routine: !!everyday };
}

/**
 * The simple commands of a command line, each with all its words (`words`), where the program is among them
 * (`at`), the program's name (`prog`), the words after it (`args`), whether the program is named by a path to a
 * script (`script`), and whether the part sends its output into a file (`writes`). For the permission policy's
 * wording only: the policy never decides anything from this reading.
 */
export function shellCommands(command) {
  try { return simpleCommands(command); } catch { return []; }
}

/** A script name worth reading out: no spaces or slashes, so it is the name and nothing else. */
const SCRIPT_NAME = /^[A-Za-z0-9][\w:.-]{0,39}$/;

/**
 * The package.json script a part runs: `npm run <name>` (also `pnpm`, `yarn`, `npm run-script`), or `npm start`.
 * The name is the word right after `run`. When that is an option (`npm run -w api test`), the next word may be the
 * option's value rather than the script, so there is no name to read out.
 */
function packageScript(c) {
  if (!['npm', 'pnpm', 'yarn'].includes(c.prog)) return null;
  let name = null;
  if (/^(start|stop|restart)$/.test(c.sub)) name = c.sub;
  else if (c.sub === 'run' || (c.prog === 'npm' && c.sub === 'run-script')) name = c.args[1] ?? null;
  return name && SCRIPT_NAME.test(name) ? name : null;
}

/**
 * The script a command line runs, when that is the one thing in it these words do not already cover: an inline
 * shell stands for its command, and parts that do nothing or get an everyday word ("| tail -20", "cd api &&") are
 * not counted. Used only once commandAction has nothing to say.
 */
function scriptRun(command) {
  let cmds;
  try { cmds = simpleCommands(command); } catch { return null; }
  const routine = c => { const k = ACTIONS.findIndex(([, , test]) => test(c)); return k >= 0 && !!ACTIONS[k][3]; };
  const rest = cmds.filter(c => !c.inline && !NOOPS.has(c.prog) && !routine(c));
  return rest.length === 1 ? packageScript(rest[0]) : null;
}

/**
 * Control, line-separator and direction-changing characters, which could make a shown command read as something else.
 * The direction-changing ones are Unicode's Bidi_Control set: U+061C, U+200E-200F, U+202A-202E, U+2066-2069.
 */
const HIDDEN_CHARS = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x061c, 0x061c], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
  .map(([from, to]) => String.fromCharCode(from) + '-' + String.fromCharCode(to)).join('') + ']', 'g');

/**
 * Exact words (a command, a path, an address) made fit to quote in a sentence: hidden characters become spaces, and a
 * long one keeps its start and its end around "…", because the end ("| sh") can matter as much as the start.
 */
export function quotable(text, n = 160) {
  const t = String(text ?? '').replace(HIDDEN_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = Math.ceil((n - 1) * 0.6);
  return t.slice(0, head).trimEnd() + '…' + t.slice(t.length - (n - 1 - head)).trimStart();
}

/**
 * Describe a shell command in a few words, for the activity line: by what it does when these words cover it, a
 * package script by its name ("Running the db:migrate script"), and anything else by the command itself, clipped
 * ("Running make deploy"). Never by the agent's own description of it: the agent writes that, so it can say
 * anything ("Run the tests" for `curl … | sh`).
 */
export function describeCommand(command) {
  const act = commandAction(command);
  if (act) return act.doing;
  const script = scriptRun(command);
  if (script) return `Running the ${script} script`;
  let c = String(command || '').replace(HIDDEN_CHARS, ' ');
  const inline = /^\s*\/bin\/(z|ba)?sh\s+-l?c\s+(['"])([\s\S]*)\2\s*$/.exec(c); // Codex runs every command this way
  if (inline) c = inline[3];
  return c.trim() ? 'Running ' + clip(c, 40) : 'Running a command';
}

/**
 * Narrate one tool call.
 * @param {string} tool  tool name (Claude Code) or item type (Codex)
 * @param {object} input tool input
 * @returns {{ sentence: string, kind: string }}
 */
export function narrate(tool, input = {}) {
  const i = input || {};
  switch (tool) {
    case 'Read': case 'NotebookRead':
      return { sentence: 'Reading ' + baseName(i.file_path || i.notebook_path), kind: KIND.READ };
    case 'Write':
      return { sentence: 'Writing ' + baseName(i.file_path), kind: KIND.EDIT };
    case 'Edit': case 'MultiEdit':
      return { sentence: 'Editing ' + baseName(i.file_path), kind: KIND.EDIT };
    case 'NotebookEdit':
      return { sentence: 'Editing ' + baseName(i.notebook_path), kind: KIND.EDIT };
    case 'Glob':
      return { sentence: 'Looking for files like ' + clip(i.pattern || '', 28), kind: KIND.SEARCH };
    case 'Grep':
      return { sentence: 'Searching for ' + quoted(i.pattern || ''), kind: KIND.SEARCH };
    case 'LS':
      return { sentence: 'Looking around ' + baseName(i.path), kind: KIND.SEARCH };
    case 'Bash': case 'command_execution':
      return { sentence: describeCommand(i.command), kind: KIND.RUN }; // never i.description: the agent writes that
    case 'Agent': case 'Task':
      return { sentence: 'Asking a helper to ' + lower1(noDot(i.description || 'help')), kind: KIND.HELPER };
    case 'TaskCreate':
      return { sentence: 'Adding a step to its plan', kind: KIND.PLAN };
    case 'TaskUpdate': case 'TodoWrite': case 'todo_list':
      return { sentence: 'Updating its plan', kind: KIND.PLAN };
    case 'TaskList': case 'TaskGet':
      return { sentence: 'Checking its plan', kind: KIND.PLAN };
    // A background task is a helper or a command left running (Claude Code's Bash run_in_background, Monitor).
    case 'TaskOutput':
      return { sentence: 'Checking on a background task', kind: KIND.HELPER };
    case 'TaskStop':
      return { sentence: 'Stopping a background task', kind: KIND.HELPER };
    case 'WebSearch': case 'web_search':
      return { sentence: 'Searching the web for ' + quoted(i.query || ''), kind: KIND.WEB };
    case 'WebFetch': {
      let host = '';
      try { host = new URL(i.url).hostname.replace(/^www\./, ''); } catch {}
      return { sentence: 'Reading a web page' + (host ? ' on ' + host : ''), kind: KIND.WEB };
    }
    case 'file_change': {
      const ch = Array.isArray(i.changes) ? i.changes : [];
      const names = ch.slice(0, 2).map(c => baseName(c.path)).join(', ');
      return { sentence: 'Editing ' + (names || 'files') + (ch.length > 2 ? ` and ${ch.length - 2} more` : ''), kind: KIND.EDIT };
    }
    case 'ToolSearch':
      return { sentence: 'Looking up a tool', kind: KIND.OTHER };
    case 'Skill':
      return { sentence: 'Using the ' + (i.skill || i.name || 'a') + ' skill', kind: KIND.OTHER };
    case 'Monitor': {
      // What is really watched, never the agent's own description of it.
      if (i.ws !== undefined) return { sentence: 'Watching a live feed' + (hostOf(i.ws?.url) ? ' from ' + hostOf(i.ws.url) : ''), kind: KIND.WEB };
      const cmd = String(i.command || '').replace(HIDDEN_CHARS, ' ').trim(); // cleaned before clipping, as for Bash
      return { sentence: 'Watching ' + (cmd ? clip(cmd, 40) : 'a command'), kind: KIND.RUN };
    }
    case 'SendMessage':
      // The address it really goes to: one of its helpers, or another Claude session.
      return { sentence: 'Sending a message' + (typeof i.to === 'string' && i.to ? ' to ' + (i.to === 'main' ? 'the main agent' : clip(i.to, 32)) : ''), kind: KIND.HELPER };
    case 'reasoning':
      return { sentence: 'Thinking', kind: KIND.TALK };
    case 'agent_message':
      return { sentence: 'Writing a reply', kind: KIND.TALK };
    case 'mcp_tool_call':
      return { sentence: `Using ${i.server || 'a tool'}${i.tool ? ' (' + i.tool + ')' : ''}`, kind: KIND.OTHER };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(tool));
      if (m) return { sentence: `Using ${m[1].replace(/^plugin_[^_]+_/, '')} (${m[2]})`, kind: KIND.OTHER };
      return { sentence: 'Using ' + tool, kind: KIND.OTHER };
    }
  }
}

const PAST = [
  [/^Reading\b/, 'Read'], [/^Writing a reply\b/, 'Wrote a reply'], [/^Writing\b/, 'Wrote'], [/^Editing\b/, 'Edited'],
  [/^Running\b/, 'Ran'], [/^Searching\b/, 'Searched'], [/^Looking\b/, 'Looked'], [/^Asking\b/, 'Asked'],
  [/^Installing\b/, 'Installed'], [/^Checking\b/, 'Checked'], [/^Building\b/, 'Built'], [/^Adding\b/, 'Added'],
  [/^Updating\b/, 'Updated'], [/^Using\b/, 'Used'], [/^Thinking\b/, 'Thought'], [/^Saving\b/, 'Saved'],
  [/^Pushing\b/, 'Pushed'], [/^Stopping\b/, 'Stopped'], [/^Sending\b/, 'Sent'], [/^Watching\b/, 'Watched'],
  [/^Starting\b/, 'Started'], [/^Waiting\b/, 'Waited'], [/^Deleting\b/, 'Deleted'], [/^Downloading\b/, 'Downloaded'],
  [/^Connecting\b/, 'Connected'], [/^Publishing\b/, 'Published'], [/^Changing\b/, 'Changed'], [/^Moving\b/, 'Moved'],
  [/^Copying\b/, 'Copied'], [/^Creating\b/, 'Created'], [/^Opening\b/, 'Opened'], [/^Comparing\b/, 'Compared'],
  [/^Bringing in\b/, 'Brought in'], [/^Replacing\b/, 'Replaced'],
];

/** "Running the tests" -> "Ran the tests", for steps that are finished. Other text is left alone. */
export function pastTense(sentence) {
  const s = String(sentence || '');
  for (const [re, past] of PAST) if (re.test(s)) return s.replace(re, past);
  return s;
}

/**
 * Describe what an agent is asking permission to do, for the person. The sentence comes from what the call
 * really does, never from the agent's own description of it; the detail is the exact command, path or address.
 * @returns {{ sentence: string, detail: string }}
 */
export function describeRequest(tool, input = {}) {
  const i = input || {};
  switch (tool) {
    case 'Bash':
      return { sentence: 'wants to ' + (commandAction(i.command)?.does || 'run a command'), detail: String(i.command || '') };
    case 'Monitor':
      if (i.ws !== undefined) return { sentence: 'wants to keep a live connection open to a web address', detail: typeof i.ws?.url === 'string' ? i.ws.url : clip(JSON.stringify(i), 300) };
      return { sentence: 'wants to run a command in the background and watch what it prints', detail: String(i.command || '') };
    case 'Write':
      return { sentence: 'wants to create ' + baseName(i.file_path), detail: String(i.file_path || '') };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return { sentence: 'wants to change ' + baseName(i.file_path || i.notebook_path), detail: String(i.file_path || i.notebook_path || '') };
    case 'Read': case 'NotebookRead':
      return { sentence: 'wants to read ' + baseName(i.file_path || i.notebook_path), detail: String(i.file_path || i.notebook_path || '') };
    case 'Grep':
      return { sentence: 'wants to search', detail: `${JSON.stringify(String(i.pattern ?? ''))} in ${i.path || 'its own folder'}` };
    case 'Glob':
      return { sentence: 'wants to look for files', detail: String(i.pattern ?? '') + (i.path ? ' in ' + i.path : '') };
    case 'LS':
      return { sentence: 'wants to look at a folder', detail: String(i.path || '') };
    case 'SendMessage': {
      // Only an address (uds:…, bridge:…, a path) is known from the input alone to be another Claude session.
      // Whether a plain name is one of the agent's helpers is for the permission policy to say.
      const text = typeof i.message === 'string' ? i.message : JSON.stringify(i.message ?? '');
      const address = typeof i.to === 'string' && /[:/\\]/.test(i.to);
      return { sentence: 'wants to send a message' + (address ? ' to another Claude session' : ''), detail: `To ${String(i.to ?? '(no address)')}: ${clip(text, 400)}` };
    }
    case 'WebFetch':
      return { sentence: 'wants to open a web page', detail: String(i.url || '') };
    case 'WebSearch':
      return { sentence: 'wants to search the web', detail: String(i.query || '') };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(String(tool));
      if (m) return { sentence: `wants to use ${m[1]} (${m[2]})`, detail: clip(JSON.stringify(i), 300) };
      return { sentence: 'wants to use ' + tool, detail: clip(JSON.stringify(i), 300) };
    }
  }
}

const FILLER = /^(please|pls|can you|could you|would you|i want you to|i need you to|go and|try to|help me|let's|lets|there's|there is|there are|i want|i need|i would like|i'd like|we need|we should|it would be nice to have|it would be nice if|can we have|can we)\s+/i;
/** A label in front of the work: "bug: login redirect loops", "feat: export to csv". */
const LABEL = /^(?:new )?(?:bug|bugs|feature|feat|fix|todo|to do|issue|chore|task|idea|request|question)\s*:\s*/i;
/** Named by what a link points to: "Shop issue 12" for github.com/acme/shop/issues/12, else "Link to example.com". */
function linkName(t) {
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  let u;
  try { u = new URL(t); } catch { return null; }
  const m = /^\/[^/]+\/([^/]+)\/(issues|pull|pulls|merge_requests)\/(\d+)/.exec(u.pathname);
  if (m) return cap(clip(`${m[1]} ${m[2] === 'issues' ? 'issue' : 'pull request'} ${m[3]}`, 30));
  return cap(clip(`Link to ${u.hostname.replace(/^www\./, '')}`, 30));
}
const STOP = new Set(['the', 'a', 'an', 'my', 'our', 'this', 'that', 'some', 'please', 'just', 'quickly', 'really']);
const TRAILING = new Set(['and', 'or', 'to', 'for', 'of', 'with', 'in', 'on', 'at', 'by', 'from', 'so', 'then', 'that', 'the', 'a', 'an',
  'when', 'if', 'while', 'because', 'i', 'we', 'you', 'it', 'is', 'are', 'my', 'our']);

/** A short name for an agent from its task: "Fix the flaky checkout test" -> "Fix flaky checkout test". */
export function nameFromTask(task, maxWords = 4) {
  // Quotes go only at the edges of words: "doesn't" and "there's" keep their apostrophe.
  let t = String(task || '').replace(/(^|\s)[`"“”'‘’]+/g, '$1').replace(/[`"“”'‘’]+(?=\s|$)/g, '').replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim();
  const link = linkName(t);
  if (link) return link;
  for (let k = 0; k < 3; k++) t = t.replace(FILLER, '').replace(LABEL, '');
  const words = t.split(' ').filter(w => w && !STOP.has(w.toLowerCase()));
  const picked = [];
  for (const w of words) {
    const clean = w.replace(/[.,;:!?()]+$/g, '');
    if (!clean) continue;
    picked.push(clean);
    if (picked.length >= maxWords) break;
    if (/[.;:!?]$/.test(w)) break;
  }
  const trim = () => { while (picked.length > 1 && TRAILING.has(picked[picked.length - 1].toLowerCase())) picked.pop(); };
  trim();
  // Too long: drop whole words from the end rather than cut one in half; only a single long word is clipped.
  while (picked.length > 1 && picked.join(' ').length > 30) { picked.pop(); trim(); }
  const name = picked.join(' ');
  return cap(clip(name || 'New task', 30));
}

/** Strip markdown so text reads as plain prose. */
export function plain(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a root still waits for once its turn is over, as words after "Waiting for": "2 helpers", "its helper",
 * "a background command", "its helper and a background command". Commands are shell commands it left running
 * (Claude Code's Bash run_in_background, a command moved to the background at its timeout, a Monitor); any other
 * kind is "a background task". With nothing to name it is "its helpers".
 */
export function waitingFor({ helpers = 0, commands = 0, others = 0 } = {}) {
  const say = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
  const parts = [];
  if (helpers > 0) parts.push(say(helpers, 'its helper', 'helpers'));
  if (commands > 0) parts.push(say(commands, 'a background command', 'background commands'));
  if (others > 0) parts.push(say(others, 'a background task', 'background tasks'));
  if (!parts.length) return 'its helpers';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** First sentence of a message, in plain prose. */
export function firstSentence(text, n = 160) {
  const p = plain(text);
  const m = /^(.+?[.!?])(\s|$)/.exec(p);
  return clip(m ? m[1] : p, n);
}

const ASKING = /\b(would you like|should i|shall i|do you want|want me to|do you prefer|which (one|option|approach|would you)|can you confirm|please confirm|let me know (if|whether|which)|is it ok(ay)? (if|to)|may i|ok to proceed|how (you(['’]d| would) like (me )?to |to )proceed)\b/i;

/**
 * Closing lines that invite more contact but ask nothing ("Let me know if you need anything else.", "Is there
 * anything else you'd like me to do?", "Hope this helps."). A line that also names a decision (DECIDES: "should",
 * "which", "whether", "prefer", "proceed", "before I") is never a courtesy.
 */
const COURTESY = [
  /^(i )?hope (this|that|it) helps\b/i,
  /^(i['’]m |i am )?happy to help\b/i,
  /^feel free\b/i,
  /^(is there )?anything else\b/i,
  /^anything (more|further)\b/i,
  // "Want me to do anything else?", "Need anything else?", "Can I help with anything else?": only when nothing is named.
  /^(do you |would you )?(want|need|like|wish)( me to( do| help with)?)? (any ?thing|something) (else|more|further)( for you| from me| today| now| right now)?\s*[?.!]*$/i,
  /^(shall|can|could|may) i (do|help (you )?with|get you) (any ?thing|something) (else|more|further)( for you| today| now)?\s*[?.!]*$/i,
  /^what else (can|could|shall) i (do|help with)( for you| today| now)?\s*[?.!]*$/i,
  /^do you have any (other |more |further )?questions\b/i,
  /^(just |please )?let me know if\b.*\b(any|anything|something|questions?|issues?|problems?|changes?|adjustments?|tweaks?|feedback|(this|that|it) works)\b/i,
  /^if you (have|run into|hit|see|notice|find|need) any(thing)?\b/i,
];
const DECIDES = /\b(should|shall|which|whether|prefer|rather|instead|proceed|continue|go ahead|before i)\b/i;
const isCourtesy = (s) => COURTESY.some(re => re.test(s)) && !DECIDES.test(s);

// These are words of their own (after a space or an opening bracket or quote), so "src/main.cf." still ends a sentence.
// A period after these never ends one: "(e.g. README.md)", "i.e.", "vs.", "cf.".
const NEVER_ENDS = /(?:^|[\s(["'“‘])(?:[Ee]\.[Gg]|[Ii]\.[Ee]|[Vv]s|[Cc]f)\.$/;
// After "etc." or an initial ("A.", "U.S.") the sentence goes on only when the next word starts in lower case: "the U.S.
// date format" is one sentence, "I went with option A. Should I continue?" two.
const MAY_END = /(?:^|[\s(["'“‘])(?:[Ee]tc|(?:[A-Z]\.)*[A-Z])\.$/;

/**
 * Sentences of plain prose: they end at . ! or ? followed by a space or the end, so "node test.mjs?" stays whole, but
 * not after "e.g.", "i.e.", "vs." or "cf.", nor after "etc." or an initial when the next word starts in lower case.
 */
function sentencesOf(p) {
  const out = [];
  for (const piece of p.split(/(?<=[.!?])\s+/)) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && (NEVER_ENDS.test(last) || (MAY_END.test(last) && /^[a-z]/.test(piece)))) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * If a final message ends by asking the person something, return that question. Closing courtesies ask nothing and
 * are skipped. Looks only at the last paragraph that is not only courtesy, and at its last three sentences, so a
 * question in the middle of a report does not count.
 */
export function extractQuestion(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const paras = raw.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  for (let p = paras.length - 1; p >= 0; p--) {
    const said = sentencesOf(plain(paras[p])).filter(s => !isCourtesy(s));
    if (!said.length) continue; // only courtesy: the closing paragraph is the one before
    for (let k = said.length - 1; k >= Math.max(0, said.length - 3); k--) {
      const s = said[k];
      if (/\?\s*$/.test(s) || ASKING.test(s)) return clip(s, 220);
    }
    return null;
  }
  return null;
}
