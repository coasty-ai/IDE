// The permission policy. For one tool call an agent wants to make, decide whether it may go ahead
// on its own ('allow'), must wait for the person ('ask'), or is refused at once ('deny').
//
// Strict by design: anything that is not clearly safe asks. The contract in ARCHITECTURE.md lists
// what may be allowed; this module adds a few extra conditions (documented inline) that only ever
// turn an allow into an ask, never the other way round. Refused outright, because an OK could not
// make them safe: changes to Claude Code's own settings (.claude folders, .mcp.json) and helpers
// that would work outside the agent's folder.
//
// With full permissions on (decide's `full`), the person is not asked at all: every step that would ask runs, except
// the floor, which is refused. The floor is what is refused anyway (above), any step that would ask and would write into
// Claude Code's own settings as far as the policy can tell, and any whose landing place it cannot tell (withFull).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRequest, commandAction, shellCommands, FILLED } from '../shared/narrate.mjs';

/**
 * Tools that only plan, look up tools or skills, report, search the web or manage the agent's own
 * background tasks. Always allowed. Never add a tool that can run a command, change a file, read files
 * or send a message: the hook is the only gate. Those are judged below by what they ask for, or kept
 * away from agents at launch (DISALLOWED_TOOLS in src/adapters/claude/args.mjs).
 */
export const SAFE_TOOLS = new Set([
  'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TodoWrite',
  'Skill', 'WebSearch', 'ReportFindings',
]);

/**
 * Tools that only read, and the input fields that name where. Allowed when every place they look is
 * inside the agent's folder or one of its own scratch folders (readAlso); otherwise they ask.
 * Grep, Glob and LS look in the agent's folder when they name no place.
 */
const READ_TOOLS = Object.freeze({
  Read: ['file_path'], NotebookRead: ['notebook_path', 'file_path'], LS: ['path'], Grep: ['path'], Glob: ['path'],
});

/** Tools that change one file. Allowed only inside the agent's folder, outside .git and .claude. */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Tools that start a helper (a subagent). A helper works in the agent's own folder. */
const HELPER_TOOLS = new Set(['Agent', 'Task']);

/**
 * Claude Code's Monitor runs `command` in a background shell, or opens the WebSocket in `ws`, and
 * streams what it prints. Its command is judged exactly like Bash. Any field not listed here asks, so
 * a new mode cannot slip through.
 */
const MONITOR_FIELDS = new Set(['command', 'description', 'timeout_ms', 'persistent']);

/** Plain-language reasons, shown to the person and returned to the agent. */
const R = Object.freeze({
  noTool: 'It did not say which tool it wants to use.',
  safeTool: 'Planning, looking up tools and searching the web are always allowed.',
  webFetch: 'Opening a web page needs your OK.',
  mcp: 'Tools that reach other services need your OK.',
  unknownTool: 'This tool is not on the list of safe tools.',
  broken: 'Something about this request could not be checked, so it needs your OK.',
  noCwd: "The agent's own folder could not be checked.",
  noFile: 'It did not say which file it wants to change.',
  noRead: 'It did not say which file it wants to read.',
  readInside: "Looking at files inside the agent's own folder is always allowed.",
  readOutside: "It wants to look at something outside the agent's own folder.",
  readLinks: "This command would follow links, which can lead outside the agent's own folder.",
  readList: 'This command reads a list of file names from a file, and those files could be anywhere.',
  fileInside: "The file is inside the agent's own folder.",
  fileOutside: "The file is outside the agent's own folder.",
  fileFolder: "That is the agent's own folder, not a file in it.",
  fileGit: "The file is part of git's own records, in the .git folder or a folder laid out like it.",
  fileLinked: 'The file is also linked from another place on disk.',
  fileClaude: 'Files in a .claude folder change how Claude Code itself runs, so agents may not change them.',
  fileMcp: 'The .mcp.json file connects Claude Code to other services, so agents may not change it.',
  helper: "Helpers work in the agent's own folder, and each of their steps is checked too.",
  helperElsewhere: "Helpers must work in this agent's own folder, not in a separate copy or on another computer. Start the helper again without isolation.",
  message: "The message goes to this agent's own helpers.",
  messageAddress: 'The address belongs to another Claude session, outside this agent and its helpers.',
  messageOther: "It is not one of this agent's helpers, so it could be another Claude session.",
  messageUnchecked: 'Who would receive this message could not be checked.',
  monitorWeb: 'Keeping a live connection open to a web address needs your OK.',
  monitorOther: 'This watch uses a setting that could not be checked.',
  pathUnclear: 'The path could not be checked.',
  pathPadded: 'The path starts or ends with blank space, so where it leads could not be checked.',
  pathBack: 'The path steps back out of a folder that does not exist yet.',
  pathLink: 'The path goes through a link that points to something missing.',
  noCommand: 'It did not say which command it wants to run.',
  meta: 'The command chains, redirects or substitutes other commands.',
  control: 'The command contains hidden control characters.',
  quotes: 'The quotes in the command do not match up.',
  comment: 'Part of the command is hidden behind a # comment.',
  globCommand: 'The name of the command uses a wildcard.',
  globOption: 'A wildcard in this command could turn file names into options.',
  globMany: 'A wildcard in this command matches more files than can be checked.',
  globUnclear: 'A wildcard in this command is written in a way that could not be checked.',
  globOutside: "A wildcard in this command searches a folder outside the agent's own.",
  equals: "To zsh, a word that starts with = is the full path of a program, which is outside the agent's own folder.",
  notSafe: 'This command is not on the list of safe commands.',
  readOnly: 'This command only reads.',
  writesFile: 'This command can write to a file.',
  runsProgram: 'This command can start other programs.',
  findDanger: 'This find command can delete files, write files or run other commands.',
  gitOption: 'This option before the git command can point git at another repository or make it run other programs.',
  gitNone: 'It did not say which git command to run.',
  gitElsewhere: "It wants git to work in a folder outside the agent's own.",
  gitOtherRepo: 'Git would work in another repository there, whose settings can make git run other programs.',
  gitSeparate: "This keeps git's records for a repository in a separate folder, and moves them there when the repository is already set up.",
  gitInitAgain: "This sets up again a repository whose records are outside the agent's own folder, which can change its settings.",
  gitReflog: "This deletes git's record of earlier commits, which is how work that no branch holds any more can be brought back.",
  gitPrune: 'This deletes commits that no branch holds any more, so they could never be brought back.',
  gitBranchGone: "This deletes a branch other than the agent's own, with git's record of where it has been.",
  gitRefGone: "This deletes a branch, tag or other name for a commit, with git's record of where it has been.",
  gitWorktreeGone: "This removes another working copy of the repository, or git's records of one, with any work in it that is not committed.",
  gitWorktreeOther: "This moves, locks or repairs another working copy of the repository, or git's records of one: git finds one by the end of its path, so it could be another agent's.",
  gitRepack: "This tidies git's records in a way that can delete work that no branch holds any more, so it could never be brought back.",
  gitReplace: 'This makes git show other commits in place of the ones it has, in every working copy of the repository, yours included.',
  gitNetwork: "It names an address or a folder that is not one of the repository's own remotes, and git may use your saved sign-in to reach it.",
  gitSubmodules: 'Submodules come from the addresses in the .gitmodules file, which the agent can change, and git may use your saved sign-in to reach them.',
  gitPatch: "A patch can change any file in the agent's folder, links and Claude Code's own settings included, which the agent may not change on its own.",
  gitSettingsOutside: "This reads git's settings from outside the agent's own folder, which can hold your sign-ins.",
  gitUnknown: "This is not one of git's own commands, so it could be an alias or another program.",
  gitPrograms: 'This git command starts other programs.',
  gitRunsProgram: 'This option makes git start another program.',
  gitAddress: 'This address makes git start another program.',
  gitSettings: "This changes git's settings, which can make git run other programs.",
  gitSchedule: "This changes git's settings for the whole computer and schedules tasks on it.",
  gitSignIn: 'This reads or changes the sign-in that git keeps for you.',
  ghSignIn: "This shows the sign-in that GitHub's command-line tool keeps for you.",
  gitRemote: 'This push replaces or deletes what is already on the remote.',
  gitMirror: 'This sets up a mirror of a remote: every later push to it replaces or deletes what is already there.',
  gitOutside: "It names a place outside the agent's own folder, where git could write.",
  gitRecords: "It names a place in git's own records, in the .git folder or a folder laid out like it.",
  gitClaude: "It names a place in a .claude folder, which holds Claude Code's own settings.",
  gitUnsafe: "This lets git change files outside the agent's own folder.",
  gitRead: 'This git command only reads.',
  gitAny: "Git commands that stay in the agent's own folder run without asking.",
  tests: "This runs the project's tests, checks or build.",
  testsExtra: 'Extra options for this command need your OK.',
  testsOutside: "The command points at something outside the agent's own folder.",
  testsGit: "The command points into git's own records, in the .git folder or a folder laid out like it.",
  testsClaude: "The command points into a .claude folder, which holds Claude Code's own settings.",
  testsOption: 'This test command uses an option that can delete files, upload results or run other programs.',
  codeAddress: 'Part of this command is an address (data:, file: or a web address) that could be loaded and run as code.',
  nodeInside: "The script is inside the agent's own folder.",
  nodeOutside: "The script is outside the agent's own folder.",
  nodeGit: "The script is part of git's own records, in the .git folder or a folder laid out like it.",
  nodeClaude: "The script is in a .claude folder, which holds Claude Code's own settings.",
  nodeMissing: "The script is not a file in the agent's own folder.",
  nodeOption: 'This node command uses an option that can run code it was not given as a file.',
  nodeValue: 'An option of this node command has a value that could not be checked.',
  extra: "This command is on the repository's list of allowed commands.",
  full: 'Full permissions are on.',
  fullClaude: "This would change Claude Code's own settings, which agents may not change, even with full permissions on.",
  fullUnchecked: "Whether this would change Claude Code's own settings could not be checked, so it was refused.",
  fullEditUnclear: 'Full permissions are on, but Workbench could not tell where this edit lands, so it did not allow it.',
  fullWriteUnclear: 'Full permissions are on, but Workbench could not tell where this command writes, so it did not allow it.',
  fullToolUnclear: 'Full permissions are on, but Workbench could not tell where this tool works, so it did not allow it.',
  fullToolClaude: "Full permissions are on, but this tool works on a place in Claude Code's own settings, and Workbench could not tell whether it changes it, so it did not allow it.",
  fullCdClaude: "Full permissions are on, but this would move the shell into Claude Code's own settings, where its next commands could change them, so it did not allow it.",
  fullCodeClaude: "Full permissions are on, but Workbench could not tell what this does with Claude Code's own settings, which it names, so it did not allow it.",
});

/**
 * How an ask says where, added to its sentence ("wants to change app.js outside its own folder"), so the
 * person sees it without opening the details. The "uses" forms follow a sentence about running something.
 */
const WHERE = Object.freeze({
  outside: ' outside its own folder',
  git: " in git's own records",
  claude: " in Claude Code's own settings",
  linked: ', which is also linked from another place',
  usesOutside: ', using something outside its own folder',
  usesGit: ", using git's own records",
  usesClaude: ", using Claude Code's own settings",
  usesLinked: ', using a file that is also linked from another place',
  mayLeave: ', which may reach outside its own folder',
});
const USES = Object.freeze({ outside: 'usesOutside', git: 'usesGit', claude: 'usesClaude', linked: 'usesLinked' });

// A verdict: the decision and its reason, plus optionally where (a WHERE key), what an ask does in plain words
// when the policy knows better than the command's everyday reading (does), or a whole sentence (say).
const allow = (reason, where) => ({ decision: 'allow', reason, where });
const ask = (reason, where, does) => ({ decision: 'ask', reason, where, does });
const deny = (reason, where) => ({ decision: 'deny', reason, where });

/** What an ask says when the command, or the option that made it ask, has no plainer words. */
const RUN = 'run a command';

/**
 * Decide on one tool call.
 * @param {{ tool: string, input?: object, cwd: string, extraAllow?: string[],
 *           readAlso?: (string | { root: string, session: string })[], recipients?: string[], full?: boolean }} req
 *   cwd is the agent's own folder (its workspace); extraAllow holds command prefixes from workbench.json.
 *   readAlso names the agent's own scratch folders, which it may read without asking: a string is a folder
 *   that belongs to this agent alone; { root, session } covers <root>/<any key>/<session id>/..., where
 *   Claude Code keeps one session's files (the key folder is shared with other sessions, so only the
 *   folder named after this session's id counts).
 *   recipients are the names SendMessage may reach without asking: "main" and this agent's own helpers.
 *   full (exactly true): full permissions are on, so nothing asks: see withFull.
 * @returns {{ decision: 'allow'|'ask'|'deny', reason: string, sentence: string, detail: string }}
 */
export function decide(req) {
  const { tool, input, cwd, extraAllow, readAlso, recipients, full } = req && typeof req === 'object' ? req : {};
  const inp = input && typeof input === 'object' ? input : {};
  const ctx = { cwd, extraAllow, also: [], recipients };
  let verdict;
  remotesMemo = new Map();
  try {
    ctx.also = readRoots(readAlso);
    verdict = judge(tool, inp, ctx);
  } catch {
    verdict = ask(R.broken); // fail closed on anything unexpected
  }
  if (full === true) verdict = withFull(tool, inp, ctx, verdict);
  let desc;
  try {
    desc = describeRequest(typeof tool === 'string' && tool ? tool : 'a tool', inp);
  } catch {
    desc = { sentence: 'wants to use a tool', detail: '' };
  }
  // The words never change the decision: anything that goes wrong here falls back to plainer words.
  let sentence;
  try {
    sentence = sentenceFor(tool, inp, verdict, desc.sentence, ctx);
  } catch {
    sentence = null;
  }
  if (typeof sentence !== 'string' || !sentence) sentence = tool === 'Bash' && verdict.decision !== 'allow' ? 'wants to ' + RUN : desc.sentence;
  remotesMemo = null;
  return { decision: verdict.decision, reason: verdict.reason, sentence, detail: desc.detail };
}

function judge(tool, input, ctx) {
  if (typeof tool !== 'string' || !tool) return ask(R.noTool);
  if (SAFE_TOOLS.has(tool)) return allow(R.safeTool);
  if (HELPER_TOOLS.has(tool)) return judgeHelper(input);
  if (Object.hasOwn(READ_TOOLS, tool)) return judgeRead(tool, input, ctx);
  if (EDIT_TOOLS.has(tool)) return judgeEdit(tool, input, ctx.cwd);
  if (tool === 'Bash') return judgeBash(input, ctx);
  if (tool === 'Monitor') return judgeMonitor(input, ctx);
  if (tool === 'SendMessage') return judgeMessage(input, ctx.recipients);
  if (tool === 'WebFetch') return ask(R.webFetch);
  if (tool.startsWith('mcp__')) return ask(R.mcp);
  return ask(R.unknownTool);
}

/**
 * A helper works in the agent's own folder. One that would get its own copy of the repository
 * (isolation 'worktree') or run on another computer ('remote') is refused, not asked about: the
 * workbench could neither show nor limit that work. The agent can start it again without isolation.
 */
function judgeHelper(input) {
  return input.isolation !== undefined ? deny(R.helperElsewhere) : allow(R.helper);
}

/**
 * SendMessage may reach the agent's own helpers: the names the engine lists. Anything else, such as
 * another of the person's Claude sessions on this machine or beyond, asks. An address (uds:..., bridge:...,
 * a path) is never one of its helpers, even when a helper was given that name. The sentence says only what
 * is known: without the engine's list, a plain name could be a helper or not.
 */
function judgeMessage(input, recipients) {
  const to = input.to;
  if (typeof to !== 'string' || !to) return { ...ask(R.messageUnchecked), say: 'wants to send a message' };
  if (/[:/\\]/.test(to)) return { ...ask(R.messageAddress), say: 'wants to send a message to another Claude session' };
  if (!Array.isArray(recipients)) return { ...ask(R.messageUnchecked), say: 'wants to send a message' };
  if (!recipients.includes(to)) return { ...ask(R.messageOther), say: 'wants to send a message to someone other than its helpers' };
  return { ...allow(R.message), say: `wants to send a message to ${to === 'main' ? 'the main agent' : to}` };
}

/** Monitor: a WebSocket, or any field it does not know, asks; its command gets the same answer as Bash. */
function judgeMonitor(input, ctx) {
  if (input.ws !== undefined) return ask(R.monitorWeb);
  if (Object.keys(input).some(k => !MONITOR_FIELDS.has(k))) return ask(R.monitorOther);
  return judgeBash({ command: input.command }, ctx); // its sentence stays "run a command in the background..."
}

// ---------------------------------------------------------------------------------------------
// Full permissions

/**
 * Full permissions: a step the policy would ask about runs without asking, with the reason "Full permissions are on.",
 * unless the floor refuses it (fullFloor): a step that would write into Claude Code's own settings, as far as the policy can
 * tell, or one whose landing place it cannot tell. What the policy allows or refuses anyway stays exactly as it is: edits
 * to Claude Code's settings and helpers that would work elsewhere are refused as before. A check that fails refuses: it
 * never allows by mistake.
 */
function withFull(tool, input, ctx, verdict) {
  if (verdict.decision !== 'ask') return verdict;
  let refused;
  try {
    refused = fullFloor(tool, input, ctx);
  } catch {
    return deny(R.fullUnchecked, 'claude');
  }
  if (refused) return deny(refused, 'claude');
  const out = allow(R.full, verdict.where);
  return verdict.say ? { ...out, say: verdict.say } : out;
}

/**
 * Why full permissions refuse a step that would ask, or null when it runs. An edit (editFloor), a command (commandFloor) and
 * a tool of another service or one the policy does not know (toolFloor) are judged by where they write, as far as the
 * policy can tell, and each reason is said only when it is true. Reads, web pages, messages and helpers change no file.
 * Best effort: code a step runs can still write anywhere the person can (ARCHITECTURE.md, "Permission policy").
 */
function fullFloor(tool, input, ctx) {
  const base = realFolder(ctx.cwd);
  if (EDIT_TOOLS.has(tool)) return editFloor(tool, input, base);
  if (tool === 'Bash' || tool === 'Monitor') return typeof input.command === 'string' ? commandFloor(input.command, base) : null;
  if (Object.hasOwn(READ_TOOLS, tool) || HELPER_TOOLS.has(tool) || ['WebFetch', 'WebSearch', 'SendMessage'].includes(tool)) return null;
  return toolFloor(input, base);
}

/**
 * An edit writes where its path leads. A path that names Claude Code's settings as written is refused for that (also
 * ~nobody/.claude/… and missing/../.claude/…, which cannot be resolved); one whose landing place cannot be resolved (more
 * links in a row than the policy follows, a step back out of a folder that is not there, ~user, links that lead to each
 * other, a file taken for a folder, blank space around it, no path, an agent's folder that cannot be checked) is refused
 * too, never allowed.
 */
function editFloor(tool, input, base) {
  if ([input.file_path, input.notebook_path].some(p => typeof p === 'string' && textNamesClaude(p))) return R.fullClaude;
  const target = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : (input.file_path ?? input.notebook_path);
  if (typeof target !== 'string' || !target.trim() || padded(target) || !base) return R.fullEditUnclear;
  const v = landing(target, base, base);
  return v === 'claude' ? R.fullClaude : v === 'unclear' ? R.fullEditUnclear : null;
}

/** Whether a real path is in Claude Code's own settings: in the agent's folder (placeOf), or anywhere else (claudeSetting). */
function settingsPlace(real, base) {
  const place = placeOf(real, base);
  return place === 'claude' || (place === 'outside' && claudeSetting(real));
}

/** Whether a real path is a folder. */
function isFolder(real) {
  try { return fs.statSync(real).isDirectory(); } catch { return false; }
}

/**
 * Whether a folder holds Claude Code's own settings, so that removing or moving it as a whole changes them: it is the agent's
 * folder, the home folder, or a folder above them where they are (<agent's folder>/.claude or .mcp.json, ~/.claude), or it
 * has a .claude folder or a .mcp.json of its own.
 */
function holdsClaude(real, base) {
  if (!isFolder(real)) return false;
  const within = p => p === real || p.startsWith(real === '/' ? '/' : real + '/');
  for (const p of [base + '/.claude', base + '/.mcp.json', path.join(os.homedir(), '.claude')]) if (within(p) && present(p)) return true;
  try {
    return fs.readdirSync(real).some(n => { const f = foldName(n); return f === '.claude' || f === '.mcp.json'; });
  } catch {
    return false;
  }
}

/**
 * Where writing at `p`, read from folder `b`, lands: 'claude' (Claude Code's settings, here or anywhere else), 'clear', or
 * 'unclear' when the path cannot be resolved (links followed, through a link to something missing too). `deep`: the step
 * changes what is inside a folder there as well (rm -r, mv, chmod -R). `into`: a name it gives inside it when it is a
 * folder (`cp evil/.mcp.json .` writes ./.mcp.json).
 */
function landing(p, b, base, { deep = false, into = null } = {}) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return 'unclear';
  const r = throughLinks(resolveReal(p, b), base);
  if (!r.ok) return 'unclear';
  if (settingsPlace(r.real, base)) return 'claude';
  if (deep && r.exists && holdsClaude(r.real, base)) return 'claude';
  if (into && r.exists && isFolder(r.real) && settingsPlace(path.join(r.real, into), base)) return 'claude';
  return 'clear';
}

/**
 * A command line, as far as the policy can tell. Refused when a part would write into Claude Code's own settings (its
 * redirections, and the files its program writes: writeTargets), when the shell would be left in them when the line ends
 * (staysInClaude: the next command's words are read from the agent's own folder), when a part runs code it is given whose
 * text names them (codeNamesClaude, xargs and parallel too) or a program whose name is put together when it runs and is
 * given their name (`$(echo rm) -rf .claude`), or when the policy cannot tell where a part writes (a place that cannot be
 * resolved; in a line that names them outside a heredoc's text, a place that holds a variable or another command's
 * output). Reads, mentions in the words of commands that write elsewhere, and a script run from there all run.
 *
 * The line is read with its braces expanded into the words they make (expandBraces) and each part whole (narrate's
 * shellCommands, `whole`): another command's output ($(…), `…`, <(…)) leaves a hole (FILLED) in its word and the command
 * goes on past it, so the places it writes stay where they are written; the commands inside, those of sh -c '…' and eval,
 * and those find -exec and xargs run are parts of their own. Relative words are read from the agent's folder and from
 * each folder the line cd's into.
 */
function commandFloor(command, base) {
  const line = expandBraces(command);
  if (line === null) return R.fullWriteUnclear;
  let unclear = false;
  let code = false;
  let carried = false; // a place a command writes holds a value the shell fills in: "$X", another command's output
  const named = textNamesClaude(withoutHeredocs(command)); // the line names them, outside a heredoc's text
  const parts = shellCommands(line, { whole: true });
  const bases = base ? cdFolders(parts, base) : [];
  for (const c of parts) {
    for (const t of writeTargets(c)) {
      const v = targetLanding(t, bases, base);
      if (v === 'claude') return R.fullClaude;
      if (v === 'unclear') unclear = true;
      if (v === 'carried') carried = true;
    }
    if (codeNamesClaude(c, line) || builtProgram(c)) code = true;
  }
  if (!code && feedsNames(parts) && textNamesClaude(line)) code = true;
  if (base && staysInClaude(parts, base)) return R.fullCdClaude;
  if (code) return R.fullCodeClaude;
  if (unclear) return R.fullWriteUnclear;
  // Where a line that names them writes cannot be read when a place it writes holds a variable or another command's output:
  // "X=.claude; rm -rf "$X"", "for d in .claude …; do rm -rf "$d"; done", "rm -rf "$(echo .claude)"", "$(pwd)/.claude/x".
  if (carried && named) return R.fullWriteUnclear;
  return null;
}

/** Whether a word holds a value the shell fills in when the line runs: a variable ($X, ${X}), or another command's output. */
const filled = w => typeof w === 'string' && (w.includes(FILLED) || /[$`]/.test(w));

/**
 * Whether a part runs a program whose name is put together when the line runs ($RM, $(echo rm), "$(which rm)") and gives it
 * Claude Code's own settings by name: what that program does with them cannot be told.
 */
function builtProgram(c) {
  const p = c.bare === undefined ? c : c.bare;
  return !!p && !p.empty && filled(p.words[p.at]) && textNamesClaude(p.args.join(' '));
}

/**
 * Where one place a command writes lands, read from each folder of the line (or from the folders git's -C words lead to):
 * 'claude', 'unclear', 'carried' when the place, or the folder it is read from, holds a value the shell fills in (commandFloor
 * reads the line around it), or null when it is clear. A wildcard is judged by what it matches the loose way (any case,
 * hidden names, as zsh's NO_CASE_GLOB and GLOB_DOTS); one that cannot be expanded here by its dot patterns (textNamesClaude).
 */
function targetLanding(t, bases, base) {
  const word = withHome(t.word);
  if (!word || word === '-' || /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(word)) return null;
  if (filled(word) || filled(t.into) || (t.chain ?? []).some(w => filled(withHome(w)))) return 'carried';
  if (textNamesClaude(word)) return 'claude';
  if (!base) return 'unclear';
  const folders = t.chain ? chainFolders(t.chain, bases) : bases;
  if (!folders) return 'unclear';
  let unclear = false;
  for (const b of folders) {
    if (/[*?[]/.test(word)) {
      const x = expandPattern(word, b, [], true, { entries: 0, matches: 0 });
      if (!x.error && x.paths.some(p => landing(p, b, base, t) === 'claude')) return 'claude';
      continue;
    }
    const v = landing(word, b, base, t);
    if (v === 'claude') return 'claude';
    if (v === 'unclear') unclear = true;
  }
  return unclear ? 'unclear' : null;
}

/** The folders git's -C words lead to, each read from the one before it, from each folder of the line; null when one cannot be resolved. */
function chainFolders(chain, bases) {
  const out = [];
  for (const b of bases) {
    let d = b;
    for (const w of chain) {
      if (w === '') continue; // git ignores an empty -C
      const r = resolveReal(withHome(w), d);
      if (!r.ok) return null;
      if (!r.exists) { d = null; break; } // git stops there: no folder, no write
      d = r.real;
    }
    if (d) out.push(d);
  }
  return out;
}

/**
 * The folders a line's relative words are read from: the agent's own, and each folder it cd's or pushd's into (a bare cd:
 * home), also one it makes first (`mkdir -p x && cd x`), in a subshell or not.
 */
function cdFolders(parts, base) {
  const out = [base];
  for (const c of parts) {
    const to = cdTo(c);
    if (to === null || filled(to)) continue;
    for (const b of [...out]) {
      const r = resolveReal(withHome(to), b);
      if (r.ok && (!r.exists || isFolder(r.real)) && !out.includes(r.real)) out.push(r.real);
    }
  }
  return out;
}

/** Where a cd or pushd goes (its last word that is no option; a bare cd: home), or null for anything else. */
function cdTo(c) {
  const p = c.bare === undefined ? c : c.bare;
  if (!p || (p.prog !== 'cd' && p.prog !== 'pushd')) return null;
  return p.args.filter(a => !a.startsWith('-')).at(-1) ?? (p.prog === 'cd' && !p.args.includes('-') ? '~' : null);
}

/** A folder in Claude Code's own settings that a cd leads to, though its path cannot be resolved (~nobody/.claude). */
const IN_CLAUDE = Symbol('in Claude Code’s settings');

/**
 * Whether the shell would be left in Claude Code's own settings when the line ends, so that its next commands, whose words
 * are read from the agent's own folder, would run there. Only the shell's own commands count: a cd in a subshell, in
 * another command's output, in a shell of its own (sh -c), in the background, or before the last command of a pipe stays
 * there (zsh runs a pipe's last command in the shell itself; eval runs its commands there too). The line is read as it runs
 * when each of its commands succeeds, a command after || may run or not, and cd, cd -, pushd and popd are followed, each
 * folder resolved before it is judged (`cd .claude/..` is the agent's folder). A folder held in a variable is not known.
 */
function staysInClaude(parts, base) {
  const key = s => [s.dir, s.prev, ...s.stack].map(d => (typeof d === 'symbol' ? '\u0001' : String(d))).join('\n');
  const uniq = list => [...new Map(list.map(s => [key(s), s])).values()];
  const walk = (list, start) => {
    let states = start;
    let listStart = start;
    let cond = '';
    for (const c of list) {
      if (c.sep === '|') continue; // before the last command of a pipe: a subshell of its own
      const next = c.kids ? walk(c.kids.filter(kid => !kid.nested), states) : uniq(states.flatMap(s => moveDir(s, c, base)));
      if (next === null) return null;
      states = cond === '||' ? uniq([...states, ...next]) : next;
      if (states.length > 64) return null;
      cond = c.sep;
      if (c.sep === '&') states = listStart; // the list before & runs in the background
      if (c.sep !== '&&' && c.sep !== '||') listStart = states;
    }
    return states;
  };
  const end = walk(parts.filter(c => !c.nested && !c.inEval), [{ dir: base, prev: null, stack: [] }]);
  if (end === null) return true; // more ways than can be followed
  return end.some(s => {
    if (typeof s.dir !== 'string') return s.dir === IN_CLAUDE;
    const r = throughLinks(resolveReal(s.dir, base), base); // links followed: `cd cfg`, where cfg leads into .claude
    return r.ok ? settingsPlace(r.real, base) : textNamesClaude(s.dir);
  });
}

/**
 * Where one command leaves the shell, from one state `{ dir, prev, stack }` (dir null: not known): a list of states, one for
 * each way it can go. cd (none: home; "-": where it was), pushd (none: swap; +N or -N: any folder on the stack) and popd
 * (+N or -N: any folder on the stack; none on the stack: it stays). Each cd is taken to succeed, as the line is read.
 */
function moveDir(s, c, base) {
  const p = c.bare === undefined ? c : c.bare;
  if (!p || !['cd', 'pushd', 'popd'].includes(p.prog)) return [s];
  let k = 0;
  for (; k < p.args.length; k++) {
    const a = p.args[k];
    if (a === '--') { k++; break; }
    if (a === '-' || !a.startsWith('-') || /^-\d+$/.test(a)) break;
  }
  const ops = p.args.slice(k);
  const noMove = p.args.slice(0, k).some(a => /^-[A-Za-z]*n/.test(a)); // pushd -n and popd -n change only the stack
  const to = (dir, stack = s.stack) => ({ dir, prev: s.dir, stack });
  const anyOnStack = () => [s, ...[...s.stack, s.dir].map(d => to(d))];
  if (p.prog === 'popd') {
    if (noMove) return [s];
    if (ops.length) return anyOnStack();
    return s.stack.length ? [to(s.stack.at(-1), s.stack.slice(0, -1))] : [s];
  }
  if (p.prog === 'pushd') {
    if (noMove) return [s];
    if (!ops.length) return s.stack.length ? [to(s.stack.at(-1), [...s.stack.slice(0, -1), s.dir])] : [s];
    if (/^[+-]\d+$/.test(ops[0])) return anyOnStack();
  }
  if (p.prog === 'cd' && ops.length > 1) return [to(null)]; // zsh's cd OLD NEW: a folder not known
  if (p.prog === 'cd' && ops[0] === '-') return [to(s.prev)];
  const dir = dirOf(ops.length ? ops[0] : '~', s.dir);
  return [p.prog === 'pushd' ? to(dir, [...s.stack, s.dir]) : to(dir)];
}

/**
 * The folder a cd to `word` leads to from folder `from`, as the shell's cd reads it: the path, with each ".." taking away the
 * folder before it (links are followed when it is judged), a folder the line makes first included. IN_CLAUDE for ~user/.claude
 * and the like, which cannot be resolved but name Claude Code's settings; null when it cannot be known (a variable, another
 * command's output, ~user, a relative path from a folder not known).
 */
function dirOf(word, from) {
  if (filled(word)) return null;
  let w = withHome(word);
  if (w === '~' || w.startsWith('~/')) w = os.homedir() + w.slice(1);
  else if (w.startsWith('~')) return textNamesClaude(w) ? IN_CLAUDE : null;
  if (!w.startsWith('/')) {
    // from a folder not known, a relative path is not known either; from inside the settings, one that never steps back stays there
    if (typeof from !== 'string') return from === IN_CLAUDE && !w.split('/').includes('..') ? IN_CLAUDE : null;
    w = from + '/' + w;
  }
  return path.resolve(w);
}

/** Programs that run code they are given: inline, on their input, or as a script file (which runs, wherever it lives). */
const CODE_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'source', '.', 'python', 'python2', 'python3', 'node', 'perl',
  'ruby', 'php', 'deno', 'bun', 'osascript', 'awk', 'gawk', 'pwsh', 'lua', 'tclsh', 'Rscript']);
/** Programs that write every file they are given: names that xargs hands them reach them. */
const FEEDS_WRITE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'touch', 'mkdir', 'truncate', 'tee', 'chmod', 'chown', 'chgrp', 'chflags',
  'mv', 'cp', 'ln', 'install', 'rsync', 'ditto', 'sed', 'perl']);
/** What codeGiven answers for a part that reads its code from its input. */
const STDIN = Symbol('stdin');

/**
 * Whether a part runs code it is given, which the policy cannot follow, whose text names Claude Code's own settings: code
 * given inline (python -c, node -e, perl -e, an awk program…; a shell's inline command is read as parts of its own), or code
 * read from its input (a shell or an interpreter with no script, fed through a pipe, a heredoc or a redirection: the line,
 * its heredocs included, is what it may be given). A script run from a file runs.
 */
function codeNamesClaude(c, line) {
  const p = c.bare === undefined ? c : c.bare;
  if (!p || p.empty || c.inline || !CODE_RUNNERS.has(p.prog)) return false;
  const code = codeGiven(p);
  if (code === null) return false;
  if (code !== STDIN) return textNamesClaude(code);
  const fed = hasPipe(line) || (c.redirects ?? []).some(r => r.kind === 'read' || r.kind === 'heredoc' || r.kind === 'string');
  return fed && textNamesClaude(line);
}

/** Whether a line hands names to a program that writes or runs code: xargs before one, or parallel. */
function feedsNames(parts) {
  const feeds = parts.some(c => { const p = c.bare === undefined ? c : c.bare; return c.words?.includes('xargs') || p?.prog === 'parallel'; });
  return feeds && parts.some(c => { const p = c.bare === undefined ? c : c.bare; return !!p && (FEEDS_WRITE.has(p.prog) || CODE_RUNNERS.has(p.prog) || p.prog === 'parallel'); });
}

/** Whether a line has a pipe outside quotes (not ||). */
function hasPipe(line) {
  let q = null;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { k++; continue; }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') q = ch;
    else if (ch === '|' && line[k + 1] !== '|' && line[k - 1] !== '|' && line[k - 1] !== '>') return true;
  }
  return false;
}

/**
 * Interpreters' options: the letters (and long names) whose value is code, those that take another value (`values`: the rest
 * of the word or the next one; `attached`: the rest of the word only), those that take only digits and let the word go on
 * (`digits`: perl's -l and -0, as in -lne), and those that run a module rather than code (python -m).
 */
const INTERPRETERS = Object.freeze({
  python: { code: 'c', values: 'WX', module: 'm' }, python2: { code: 'c', values: 'WX', module: 'm' }, python3: { code: 'c', values: 'WX', module: 'm' },
  node: { code: 'ep', long: ['eval', 'print'], values: 'rC', longValues: ['require', 'import', 'loader', 'experimental-loader', 'conditions', 'input-type'] },
  perl: { code: 'eE', attached: 'IMmxCdDVFi', digits: 'l0' }, ruby: { code: 'e', values: 'IrCEF' }, php: { code: 'rRBE', values: 'cdfz' },
  lua: { code: 'e', values: 'l' }, Rscript: { code: 'e' }, osascript: { code: 'e', values: 'lis' }, bun: { code: 'e', long: ['eval', 'print'] },
});

/** The code a part is given: its inline code, STDIN when it reads it from its input, or null when it runs a script file or a module. */
function codeGiven(p) {
  const args = p.args;
  if (args.some(a => /^(?:-V|--version|-h|--help)$/.test(a))) return null;
  if (p.prog === 'node' && args.some(a => /^--(?:test|run)(?:=|$)/.test(a))) return null;
  if (Object.hasOwn(INTERPRETERS, p.prog)) return interpreterCode(args, INTERPRETERS[p.prog]);
  if (p.prog === 'awk' || p.prog === 'gawk') {
    // the program is the first word that is no option, unless -f names a file that holds it
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a === '-f' || a.startsWith('--file')) return null;
      if (a === '-F' || a === '-v') { k++; continue; }
      if (a.startsWith('-') && a !== '-') continue;
      return a;
    }
    return null;
  }
  if (p.prog === 'pwsh') {
    const k = args.findIndex(a => /^-(?:c|command)$/i.test(a));
    if (k >= 0) return args.slice(k + 1).join(' ');
    return args.some(a => !a.startsWith('-')) ? null : STDIN;
  }
  if (p.prog === 'deno') return args[0] === 'eval' ? args.slice(1).join(' ') : args.length ? null : STDIN;
  if (p.prog === 'source' || p.prog === '.' || p.prog === 'tclsh') return args.length ? null : STDIN;
  // a shell: a script file, or its commands from its input (-s, or nothing to run); -c is read as parts of its own
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-s') return STDIN;
    if (/^[-+]o$|^-O$/.test(a)) { k++; continue; }
    if (/^[-+]/.test(a) && a !== '-') continue;
    return a === '-' ? STDIN : null;
  }
  return STDIN;
}

/** An interpreter's inline code (joined when there are several), STDIN with neither code nor a script, or null for a script or a module. */
function interpreterCode(args, spec) {
  const code = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return code.length ? code.join('\n') : args[k + 1] === undefined || args[k + 1] === '-' ? STDIN : null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq < 0 ? a : a.slice(0, eq)).slice(2);
      if ((spec.long ?? []).includes(name)) code.push(eq < 0 ? (args[++k] ?? '') : a.slice(eq + 1));
      else if ((spec.longValues ?? []).includes(name) && eq < 0) k++;
      continue;
    }
    if (a === '-') return code.length ? code.join('\n') : STDIN;
    if (a.startsWith('-')) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        const rest = () => (j === a.length - 1 ? (args[++k] ?? '') : a.slice(j + 1));
        if (spec.code.includes(ch)) {
          // followed only by other letters for code (node's -pe: -p prints what -e runs), the last of them takes it
          if (j < a.length - 1 && [...a.slice(j + 1)].every(x => spec.code.includes(x))) continue;
          code.push(rest());
          break;
        }
        if ((spec.digits ?? '').includes(ch)) { j = perlDigits(a, j); continue; }
        if ((spec.module ?? '').includes(ch)) return null;
        if ((spec.values ?? '').includes(ch)) { rest(); break; }
        if ((spec.attached ?? '').includes(ch)) break;
      }
      continue;
    }
    return code.length ? code.join('\n') : null; // the first other word: an argument of the inline code, or the script
  }
  return code.length ? code.join('\n') : STDIN;
}

/** A command's operands and options, read as gitArgs reads git's: `short` and `long` name the options that take a value. */
const argsOf = (args, short = '', long = []) => gitArgs(args, { short, long });
/** The words of a command that are options, up to "--". */
function optionWords(args) {
  const k = args.indexOf('--');
  return (k < 0 ? args : args.slice(0, k)).filter(a => a.startsWith('-') && a !== '-');
}
/** Every value of an option, given by its short letter or its long name (git's abbreviations too), from argsOf's opts. */
const optValues = (opts, short, long) => opts.filter(([n, v]) => typeof v === 'string' && (n === short || (!!long && n.length > 1 && long.startsWith(n)))).map(([, v]) => v);
/** The last value of an option, or undefined. */
const optValue = (opts, short, long) => optValues(opts, short, long).at(-1);

/** A mode chmod takes as its first word: octal, or symbolic (u+x, go-w, a=r,u+w; -x and -w are modes written as options). */
const CHMOD_MODE = /^(?:[0-7]{1,4}|[ugoa]*(?:[-+=][rwxXstugo]*)+(?:,[ugoa]*(?:[-+=][rwxXstugo]*)+)*)$/;
/** The options of the copying programs that take a value, as `short` letters and `long` names. */
const COPY_VALUES = Object.freeze({
  cp: { short: 'tS', long: ['target-directory', 'suffix'] }, ln: { short: 'tS', long: ['target-directory', 'suffix'] },
  install: { short: 'tSmogBf', long: ['target-directory', 'suffix', 'mode', 'owner', 'group'] }, ditto: { short: '', long: ['arch', 'bom'] },
  rsync: { short: 'eTfBM', long: ['rsh', 'exclude', 'include', 'filter', 'temp-dir', 'log-file', 'backup-dir', 'files-from', 'exclude-from', 'include-from',
    'partial-dir', 'compare-dest', 'copy-dest', 'link-dest', 'chmod', 'chown', 'rsync-path', 'password-file'] },
  scp: { short: 'cFiJlLoPS', long: [] },
});
/** git commands that write the files they name in the working tree (clean deletes them). */
const GIT_WRITES_NAMED = new Set(['checkout', 'restore', 'rm', 'mv', 'apply', 'clean', 'stash']);

/**
 * The places one part of a command writes, as far as the policy can tell: each `{ word, deep?, into?, chain? }` (see landing;
 * `chain`: git's -C words, which the word is read from). Its redirections into files, and what its program writes:
 * - rm, rmdir, unlink, shred, touch, mkdir, truncate, tee: every file they name (an option's value is not one); chmod,
 *   chown, chgrp and chflags: every file after the mode, owner or flags. rm -r, mv's sources and -R count what is inside.
 * - mv: its sources and its destination; cp, ln, install, ditto, rsync and scp: their destination (or -t), and the name each
 *   source gets inside it when it is a folder; ln with one word links it into this folder; rsync --log-file.
 * - dd's of=; sed -i's and perl -i's files; the file patch patches; the files gzip, bzip2, xz and zstd replace, and zip's
 *   archive; an archive tar creates (-f), and where tar and unzip unpack (-C, -d, and the members they name); what curl
 *   and wget save (-o, -O…); sort's and tree's -o, uniq's second file, find's -fprint and, with -delete or -exec, where it
 *   searches and the names it looks for that name them.
 * - git checkout, restore, rm, mv, apply, clean and stash: the places they name (a message names none); where clone,
 *   worktree add, init, submodule add, checkout-index and merge-file write (gitDestinations); any git command's --output,
 *   and archive's and format-patch's -o; node's (and a package script's) --test-reporter-destination.
 * sudo and doas stand for the command after them; narrate already skips env, timeout, nohup, xargs and the like.
 */
function writeTargets(c) {
  const out = (c.redirects ?? []).filter(r => r.kind === 'write').map(r => ({ word: r.target }));
  const p = c.bare === undefined ? c : c.bare;
  if (!p || p.empty) return out;
  let { prog, args } = p;
  for (let n = 0; (prog === 'sudo' || prog === 'doas') && n < 3; n++) {
    let k = 0;
    while (k < args.length && args[k].startsWith('-')) k += /^-[ugCDhprtTU]$/.test(args[k]) ? 2 : 1;
    prog = String(args[k] ?? '').replace(/^.*\//, '');
    args = args.slice(k + 1);
  }
  const targets = out.concat(programTargets(prog, args));
  return c.finder ? foundTargets(targets, c.finder) : targets;
}

function programTargets(prog, args) {
  const each = (words, extra = {}) => words.map(word => ({ word, ...extra }));
  const recursive = letters => optionWords(args).some(a => shortHas(a, letters) || longIs(a, ['recursive']));
  switch (prog) {
    case 'rm': case 'srm': case 'trash': return each(argsOf(args).operands, { deep: prog !== 'rm' || recursive('rR') });
    case 'rmdir': case 'unlink': case 'tee': return each(argsOf(args).operands);
    case 'shred': return each(argsOf(args, 'ns', ['iterations', 'size', 'random-source']).operands);
    case 'touch': return each(argsOf(args, 'rtdA', ['reference', 'date', 'time']).operands);
    case 'mkdir': return each(argsOf(args, 'm', ['mode', 'context']).operands);
    case 'truncate': return each(argsOf(args, 'sr', ['size', 'reference']).operands);
    case 'chmod': case 'chown': case 'chgrp': case 'chflags': {
      const { operands, opts } = argsOf(args);
      const byReference = opts.some(([n]) => n.length > 2 && 'reference'.startsWith(n));
      const first = byReference ? 0 : prog === 'chmod' ? (CHMOD_MODE.test(operands[0] ?? '') ? 1 : 0) : 1;
      return each(operands.slice(first), { deep: recursive('R') });
    }
    case 'mv': {
      const { operands, opts } = argsOf(args, 'tS', ['target-directory', 'suffix']);
      const dir = optValue(opts, 't', 'target-directory');
      // one word that holds another command's output may stand for several, the last of them where it moves them
      if (dir === undefined && operands.length === 1 && filled(operands[0])) return [{ word: operands[0], deep: true }];
      const dest = dir ?? (operands.length > 1 ? operands.at(-1) : undefined);
      const sources = dir !== undefined ? operands : operands.slice(0, -1);
      return [...each(sources, { deep: true }), ...(dest === undefined ? [] : [{ word: dest }, ...sources.map(s => ({ word: dest, into: path.basename(s) }))])];
    }
    case 'cp': case 'ln': case 'install': case 'ditto': case 'rsync': case 'scp': return copyTargets(prog, args);
    case 'dd': return args.filter(a => a.startsWith('of=')).map(a => ({ word: a.slice(3) }));
    case 'sed': return sedTargets(args);
    case 'perl': return perlTargets(args);
    case 'tar': return tarTargets(args);
    case 'unzip': return unzipTargets(args);
    case 'patch': {
      // the file it patches (its first word), what -o writes, and the folder -d has it patch in
      const { operands, opts } = argsOf(args, 'odipFBDrVYzg', ['output', 'directory', 'input', 'strip', 'fuzz', 'prefix', 'ifdef', 'reject-file', 'suffix',
        'version-control', 'basename-prefix', 'get', 'quoting-style']);
      return each([operands[0], optValue(opts, 'o', 'output'), optValue(opts, 'd', 'directory')].filter(w => w !== undefined));
    }
    case 'gzip': case 'gunzip': case 'bzip2': case 'bunzip2': case 'xz': case 'unxz': case 'lzma': case 'zstd': case 'unzstd': {
      // each file they are given is replaced by its other form, unless they write to their output (-c); zstd's -o names one
      if (optionWords(args).some(a => shortHas(a, 'c') || longIs(a, ['stdout', 'to-stdout']))) return [];
      const { operands, opts } = argsOf(args, 'SoTMD', ['suffix', 'output', 'threads', 'memlimit']);
      return each([...operands, ...optValues(opts, 'o', 'output')]);
    }
    case 'zip': {
      // the archive it writes: its first word, or -O's
      const { operands, opts } = argsOf(args, 'bntOP', ['temp-path', 'suffixes', 'output-file', 'password']);
      return each([operands[0], optValue(opts, 'O', 'output-file')].filter(w => w !== undefined));
    }
    case 'curl': return optionTargets(args, 'AbcCdDeEFHKmoPQrtTuUwxXyYz', 'oDc',
      ['output', 'output-dir', 'dump-header', 'cookie-jar', 'trace', 'trace-ascii', 'stderr', 'libcurl', 'etag-save', 'hsts', 'alt-svc']);
    case 'wget': return optionTargets(args, 'OoaPieBtTwQlARDIXU', 'OoaP', ['output-document', 'output-file', 'append-output', 'directory-prefix']);
    case 'sort': case 'tree': {
      const spec = READ_ONLY[prog];
      const k = args.findIndex(a => optionIs(a, spec.writes));
      const into = k >= 0 && (args[k].startsWith('--') || args[k].includes(spec.target)) ? optionValue(args, k, spec.target) : undefined;
      return into === undefined ? [] : [{ word: into }];
    }
    case 'uniq': { const files = uniqFiles(args); return files.length > 1 ? [{ word: files[1] }] : []; }
    case 'find': return findTargets(args);
    case 'git': return gitTargets(args);
    case 'node': case 'npm': case 'pnpm': case 'yarn': case 'npx': return reporterTargets(args);
    default: return [];
  }
}

/** cp, ln, install, ditto, rsync and scp: the destination, and the name each source gets inside it when it is a folder. */
function copyTargets(prog, args) {
  const { short, long } = COPY_VALUES[prog];
  const { operands, opts } = argsOf(args, short, long);
  const out = prog === 'rsync' ? optValues(opts, null, 'log-file').map(word => ({ word })) : [];
  if (prog === 'install' && optionWords(args).some(a => shortHas(a, 'd') || longIs(a, ['directory']))) return [...out, ...operands.map(word => ({ word }))];
  const remote = w => /^[^/]*:/.test(w); // host:path, user@host:path, rsync://
  const dir = optValue(opts, 't', 'target-directory');
  let dest;
  let sources;
  if (dir !== undefined) [dest, sources] = [dir, operands];
  else if (prog === 'ln' && operands.length === 1) [dest, sources] = ['.', operands]; // a link in this folder, named as what it links to
  else [dest, sources] = [operands.at(-1), operands.slice(0, -1)];
  if (dest === undefined || remote(dest)) return out;
  // rsync --delete removes what the source does not have, everywhere inside its destination
  out.push({ word: dest, deep: prog === 'rsync' && optionWords(args).some(a => /^--del/.test(a)) });
  for (const s of sources) out.push({ word: dest, into: path.basename(s.replace(/^[^/]*:/, '')) });
  return out;
}

/**
 * sed -i (or -I, --in-place): its files, after its script (the first word, unless -e or -f gives it). BSD sed takes the
 * backup extension as the next word ('' for none, or one that starts with a dot); GNU's, like -i.bak, is attached, so to
 * GNU sed that next word is a file (`sed -e s/a/b/ -i .mcp.json`): it counts as one too.
 */
function sedTargets(args) {
  let inPlace = false;
  let script = false;
  const operands = [];
  const either = []; // a word BSD sed takes for the backup extension and GNU sed for a file
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      if (name.length > 1 && 'in-place'.startsWith(name)) inPlace = true;
      else if (name && ['expression', 'file'].some(n => n.startsWith(name))) { script = true; if (!a.includes('=')) k++; }
      else if (name.length > 1 && 'line-length'.startsWith(name) && !a.includes('=')) k++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'i' || ch === 'I') {
          inPlace = true;
          if (j === a.length - 1 && k + 1 < args.length && /^(?:\.[^\s/]*)?$/.test(args[k + 1])) either.push(args[++k]);
          break;
        }
        if (ch === 'e' || ch === 'f') { script = true; if (j === a.length - 1) k++; break; }
        if (ch === 'l') { if (j === a.length - 1) k++; break; }
      }
      continue;
    }
    operands.push(a);
  }
  return inPlace ? [...(script ? operands : operands.slice(1)), ...either].map(word => ({ word })) : [];
}

/** perl -i (-pi, -i.bak): its files, after its script (the first word, unless -e or -E gives the code). */
function perlTargets(args) {
  let inPlace = false;
  let code = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'e' || ch === 'E') { code = true; if (j === a.length - 1) k++; break; }
        if (ch === 'i') { inPlace = true; break; } // the rest of the word is the backup extension
        if (ch === 'l' || ch === '0') { j = perlDigits(a, j); continue; } // only digits, and the word goes on: -lpi, -0777pi
        if ('IMmxCdDVF'.includes(ch)) break; // the rest of the word is this option's value
      }
      continue;
    }
    operands.push(a);
  }
  return inPlace ? (code ? operands : operands.slice(1)).map(word => ({ word })) : [];
}

/** perl's -l and -0 take only digits (octal; -0x… hexadecimal): the index of the last of them in the word, after a[j]. */
function perlDigits(a, j) {
  let k = j;
  if (a[j] === '0' && /^[xX]/.test(a[k + 1] ?? '')) { k++; while (/^[0-9a-fA-F]/.test(a[k + 1] ?? '')) k++; return k; }
  while (/^[0-7]/.test(a[k + 1] ?? '')) k++;
  return k;
}

/**
 * tar: the archive it creates, appends to or updates (-f, unless "-"), its --listed-incremental file, and where it unpacks:
 * each -C folder, and each member it names, inside them (or in this folder). The old form without a dash (tar xzf a.tgz)
 * counts. What it unpacks without naming members cannot be told, and runs.
 */
function tarTargets(args) {
  const list = args.length && /^[A-Za-z]+$/.test(args[0]) && /[crtuxA]/.test(args[0]) ? ['-' + args[0], ...args.slice(1)] : args;
  const { operands, opts } = argsOf(list, 'fCTXbKLNVgI', ['file', 'directory', 'files-from', 'exclude-from', 'blocking-factor', 'starting-file',
    'tape-length', 'newer', 'label', 'listed-incremental', 'use-compress-program', 'exclude']);
  const words = optionWords(list);
  const create = words.some(a => shortHas(a, 'cruA') || longIs(a, ['create', 'append', 'update', 'catenate', 'concatenate']));
  const extract = words.some(a => shortHas(a, 'x') || longIs(a, ['extract', 'get']));
  const out = optValues(opts, 'g', 'listed-incremental').map(word => ({ word }));
  const file = optValue(opts, 'f', 'file');
  if (create && file !== undefined && file !== '-') out.push({ word: file });
  if (extract) {
    const dirs = optValues(opts, 'C', 'directory');
    out.push(...dirs.map(word => ({ word })));
    for (const m of operands) for (const d of dirs.length ? dirs : ['.']) out.push({ word: d === '.' ? m : `${d.replace(/\/+$/, '')}/${m}` });
  }
  return out;
}

/** unzip: the folder it unpacks into (-d), and each member it names, inside it (or in this folder); -x's names are left out. */
function unzipTargets(args) {
  let dir = null;
  let exclude = false;
  let archive = null;
  const members = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-d') { dir = args[++k] ?? null; exclude = false; continue; }
    if (/^-d./.test(a)) { dir = a.slice(2); exclude = false; continue; }
    if (a === '-x') { exclude = true; continue; }
    if (a === '-P') { k++; continue; }
    if (a.startsWith('-')) { exclude = false; continue; }
    if (archive === null) archive = a;
    else if (!exclude) members.push(a);
  }
  const into = dir ?? '.';
  return [...(dir === null ? [] : [{ word: dir }]), ...members.map(m => ({ word: into === '.' ? m : `${into.replace(/\/+$/, '')}/${m}` }))];
}

/**
 * The files a program's options write: short letters in `writeShort` (in a word of short options, the first letter that takes
 * a value, `valueShort`, ends it) and long names in `writeLong`, given with "=" or as the next word.
 */
function optionTargets(args, valueShort, writeShort, writeLong) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq < 0 ? a : a.slice(0, eq)).slice(2);
      if (writeLong.includes(name)) out.push({ word: eq < 0 ? (args[++k] ?? '') : a.slice(eq + 1) });
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      if (!valueShort.includes(a[j])) continue;
      const value = j === a.length - 1 ? (args[++k] ?? '') : a.slice(j + 1);
      if (writeShort.includes(a[j])) out.push({ word: value });
      break;
    }
  }
  return out;
}

/**
 * find: what -fprint and its kin write, and with -delete (or bfs's -rm), which deletes what it finds, findPlaces. What -exec,
 * -execdir, -ok and -okdir change is what the command they run writes, read as a part of its own (narrate's findRuns), with
 * "{}" standing for findPlaces: `find .claude -exec cat {} \;` only reads.
 */
function findTargets(args) {
  const out = [];
  args.forEach((a, i) => { if (FIND_WRITES.has(a) && args[i + 1] !== undefined) out.push({ word: args[i + 1] }); });
  if (!args.some(a => a === '-delete' || a === '-rm')) return out;
  const { roots, names } = findPlaces(args);
  return out.concat([...roots, ...names].map(word => ({ word })));
}

/**
 * What find finds, as far as its words say: where it searches (`roots`, the words before its first test; "." with none) and
 * the names it looks for that name Claude Code's settings (`names`: -name, -path and their kin).
 */
function findPlaces(args) {
  const roots = [];
  let i = 0;
  while (i < args.length && /^-[HLPEXdsx]+$/.test(args[i])) i++;
  for (; i < args.length && !/^[-(!]/.test(args[i]); i++) roots.push(args[i]);
  if (!roots.length) roots.push('.');
  const names = args.filter((a, k) => k > 0 && /^-(?:i?name|i?path|i?wholename|i?regex|i?lname)$/.test(args[k - 1]) && textNamesClaude(a));
  return { roots, names };
}

/**
 * The places a command find runs writes (-exec and its kin), "{}" standing for what find finds: a place written at "{}" is
 * each folder find searches and each name it looks for that names Claude Code's settings (`find .claude -exec rm {} \;`);
 * the name a copy gets inside a folder ("{}" as cp's source) is each such name (`find . -name .mcp.json -exec cp {} backup/ \;`).
 */
function foundTargets(targets, finder) {
  const { roots, names } = findPlaces(finder.args);
  return targets.flatMap(t => {
    if (t.word.includes('{}')) return [...roots, ...names].map(place => ({ word: t.word.replaceAll('{}', place) }));
    if (!(t.into ?? '').includes('{}')) return [t];
    return [t, ...names.map(n => ({ ...t, into: t.into.replaceAll('{}', path.basename(n)) }))];
  });
}

/**
 * git: what checkout, restore, rm, mv, apply, clean and stash name (each piece of a word, as readPieces finds them; a message
 * names nothing), read from the folders its -C words lead to; and what --output writes, or -o for archive and format-patch.
 */
function gitTargets(args) {
  const chain = [];
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '-C' && i + 1 < args.length) chain.push(args[++i]);
    else if (/^(?:-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix|--attr-source)$/.test(args[i])) i++;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const out = [];
  const at = word => ({ word, ...(chain.length ? { chain } : {}) });
  for (const k of outputWords(rest)) if (k < rest.length && !rest[k].startsWith('--')) out.push(at(rest[k]));
  for (const a of rest) { const m = /^--output=(.*)$/.exec(a); if (m) out.push(at(m[1])); }
  if (sub === 'archive' || sub === 'format-patch') {
    rest.forEach((a, k) => { if (a === '-o' && rest[k + 1] !== undefined) out.push(at(rest[k + 1])); else if (/^-o./.test(a)) out.push(at(a.slice(2))); });
  }
  out.push(...gitDestinations(sub, rest).map(at));
  if (!GIT_WRITES_NAMED.has(sub)) return out;
  const { text } = gitTextWords(sub, rest);
  rest.forEach((a, k) => { if (!text.has(k)) for (const piece of readPieces({ text: a, glob: false })) out.push(at(piece)); });
  return out;
}

/** The options that take a value, of the git commands that make a folder or write where they are told (`git <command> -h`). */
const GIT_DEST_VALUES = Object.freeze({
  clone: { short: 'obucj', long: ['origin', 'branch', 'upload-pack', 'reference', 'reference-if-able', 'separate-git-dir', 'depth', 'shallow-since',
    'shallow-exclude', 'config', 'server-option', 'jobs', 'filter', 'template', 'bundle-uri', 'ref-format'] },
  worktree: { short: 'bB', long: ['reason'] },
  submodule: { short: 'b', long: ['branch', 'name', 'reference', 'depth'] },
  'merge-file': { short: 'L', long: ['diff-algorithm', 'marker-size'] },
});

/**
 * Where git makes a folder or writes files it is told to: the folder clone makes (its second word, or one named after the
 * address: `git clone https://…/.claude` makes .claude), worktree add's path, init's folders, the records --separate-git-dir
 * puts somewhere (init, clone), submodule add's path (or one named after the address), checkout-index's --prefix, the file
 * merge-file writes its result into (unless -p sends it out), and the file bundle create writes.
 */
function gitDestinations(sub, rest) {
  const named = address => path.basename(String(address).replace(/[/\\]+$/, '').replace(/^.*:/, '')).replace(/\.git$/, '');
  const separate = sub === 'init' || sub === 'clone'
    ? rest.flatMap((a, k) => (!a.startsWith('--') || !longIs(a, ['separate-git-dir']) ? [] : a.includes('=') ? [a.slice(a.indexOf('=') + 1)] : rest[k + 1] !== undefined ? [rest[k + 1]] : []))
    : [];
  if (sub === 'clone') {
    const { operands } = gitArgs(rest, GIT_DEST_VALUES.clone);
    return [...separate, ...(operands.length > 1 ? [operands[1]] : operands.length ? [named(operands[0])] : [])];
  }
  if (sub === 'bundle') {
    const { operands } = gitArgs(rest, { short: '', long: ['version'] });
    return operands[0] === 'create' && operands[1] !== undefined ? [operands[1]] : [];
  }
  if (sub === 'worktree') {
    const { operands } = gitArgs(rest, GIT_DEST_VALUES.worktree);
    return operands[0] === 'add' && operands[1] !== undefined ? [operands[1]] : [];
  }
  if (sub === 'init') return [...separate, ...initDirs(rest)];
  if (sub === 'submodule') {
    const { operands } = gitArgs(rest, GIT_DEST_VALUES.submodule);
    if (operands[0] !== 'add') return [];
    return operands.length > 2 ? [operands[2]] : operands[1] !== undefined ? [named(operands[1])] : [];
  }
  if (sub === 'checkout-index') {
    return rest.flatMap((a, k) => (a.startsWith('--prefix=') ? [a.slice(9)] : a === '--prefix' && rest[k + 1] !== undefined ? [rest[k + 1]] : []));
  }
  if (sub === 'merge-file') {
    if (optionWords(rest).some(a => a === '-p' || longIs(a, ['stdout']))) return [];
    const { operands } = gitArgs(rest, GIT_DEST_VALUES['merge-file']);
    return operands.length ? [operands[0]] : [];
  }
  return [];
}

/** node's --test-reporter-destination (also after a package script's "--"): the file it writes, unless stdout or stderr. */
function reporterTargets(args) {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const m = /^--test-reporter-destination(?:=(.*))?$/.exec(args[k]);
    if (!m) continue;
    const v = m[1] ?? args[++k];
    if (v !== undefined && v !== 'stdout' && v !== 'stderr') out.push({ word: v });
  }
  return out;
}

/**
 * A tool of another service, or one the policy does not know, by the places it is given and the code it carries (toolArgs,
 * a few levels down, lists too):
 * - an argument named for a place that names Claude Code's settings or leads into them is refused, since a tool's name does
 *   not say whether it only reads. For a name that only ever holds a place (a path, a file, a folder, a target, a
 *   destination), one that cannot be resolved is refused too; for one that may hold other words (a source, from, to, an
 *   output), only a value written as a path counts (no blank space in it), and one that cannot be resolved counts for nothing,
 *   so a message's `to: "~bob"` runs;
 * - an argument that carries a command or code (`command`, `cmd`, `script`, `code`…, and the `args` given with it) whose text
 *   names them is refused: what the tool does with them cannot be followed.
 * What its other words mention (a title, a message, a query) counts for nothing.
 */
function toolFloor(input, base) {
  let unclear = false;
  const { places, code } = toolArgs(input);
  for (const { value, strict } of places) {
    if ((strict || !/\s/.test(value)) && textNamesClaude(value)) return R.fullToolClaude;
    if (!base || padded(value)) { if (strict) unclear = true; continue; }
    const v = landing(value, base, base);
    if (v === 'claude') return R.fullToolClaude;
    if (v === 'unclear' && strict) unclear = true;
  }
  if (code.some(textNamesClaude)) return R.fullCodeClaude;
  return unclear ? R.fullToolUnclear : null;
}

/** The last word of an argument's name that says it holds a place on disk, and nothing else (`file_path`, `targetDir`, `dst`). */
const PLACE_WORDS = new Set(['path', 'paths', 'file', 'files', 'filename', 'filenames', 'filepath', 'filepaths', 'dir', 'dirs', 'directory',
  'directories', 'folder', 'folders', 'target', 'targets', 'destination', 'destinations', 'dest', 'dst', 'cwd', 'workdir']);
/** An argument's whole name that may hold a place, or other words. */
const MAYBE_PLACE = new Set(['source', 'sources', 'src', 'from', 'to', 'output', 'out', 'root', 'location']);
/** The last word of an argument's name that says it carries a command or code; with one, `args` and the like are its words. */
const CODE_WORDS = new Set(['command', 'commands', 'cmd', 'cmds', 'script', 'scripts', 'code', 'shell', 'bash', 'powershell', 'pwsh', 'exec']);
const ARG_WORDS = new Set(['args', 'argv', 'arguments']);

/** The words of an argument's name, however it is written: `old_path`, `sourcePath`, `target-dir`. */
const nameWords = k => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * A tool's arguments named for a place (`places`: `{ value, strict }`, strict for a name that only ever holds a place) and
 * the text of those that carry a command or code (`code`), a few levels down (at most 200): strings, and strings in lists.
 */
function toolArgs(value, depth = 0, out = { places: [], code: [] }) {
  if (out.places.length + out.code.length >= 200 || depth > 4 || !value || typeof value !== 'object') return out;
  const entries = Object.entries(value);
  const runs = entries.some(([k]) => CODE_WORDS.has(nameWords(k).at(-1)));
  for (const [k, v] of entries) {
    const words = nameWords(k);
    const last = words.at(-1);
    const strings = (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : []).filter(Boolean);
    if (PLACE_WORDS.has(last) || (last === 'name' && ['file', 'dir', 'folder', 'directory'].includes(words.at(-2)))) {
      for (const s of strings) out.places.push({ value: s, strict: true });
    } else if (words.length === 1 && MAYBE_PLACE.has(last)) {
      for (const s of strings) out.places.push({ value: s, strict: false });
    } else if ((CODE_WORDS.has(last) || (runs && ARG_WORDS.has(last))) && strings.length) out.code.push(strings.join(' '));
    if (v && typeof v === 'object') toolArgs(v, depth + 1, out);
  }
  return out;
}

/** $HOME or ${HOME} at the start of a word, as the home folder. */
const withHome = text => String(text).replace(/^\$(HOME|\{HOME\})(?=\/|$)/, os.homedir());

/**
 * A command line with its unquoted braces expanded as the shell expands them: a word that holds one ({a,b}, nested ones
 * too) becomes its forms, side by side in the same command, so `mv .claude{,-old}` is read as `mv .claude .claude-old`
 * and `rm -rf .{claude,git}` as `rm -rf .claude .git`. Braces in quotes, ${…}, {} and a { … } group stay as they are.
 * null past `limit` braces: too many to read.
 */
function expandBraces(line, limit = 64) {
  let out = line;
  for (let n = 0; ; n++) {
    const at = braceAt(out);
    if (!at) return out;
    if (n >= limit || out.length > 65536) return null;
    const before = out.slice(at.start, at.open);
    const after = out.slice(at.close + 1, at.end);
    out = out.slice(0, at.start) + at.alts.map(alt => before + alt + after).join(' ') + out.slice(at.end);
  }
}

/** What ends a word to the shell, outside quotes. */
const WORD_ENDS = ' \t\n\r;&|<>()';

/**
 * The first unquoted brace expansion in a line: where it opens and closes, its alternatives, and where the word it is part
 * of starts and ends; null when there is none.
 */
function braceAt(line) {
  let q = null;
  let start = 0;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { k++; continue; }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (WORD_ENDS.includes(ch)) { start = k + 1; continue; }
    if (ch === '$' && line[k + 1] === '{') { const close = line.indexOf('}', k); if (close < 0) return null; k = close; continue; }
    if (ch !== '{') continue;
    const found = braceBody(line, k);
    if (found) return { ...found, start, end: wordEnd(line, found.close + 1) };
  }
  return null;
}

/** Where the word that goes on at `from` ends: at the first blank or piece of the shell's punctuation outside quotes. */
function wordEnd(line, from) {
  let q = null;
  for (let k = from; k < line.length; k++) {
    const ch = line[k];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { k++; continue; }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (WORD_ENDS.includes(ch)) return k;
  }
  return line.length;
}

/** The brace expansion that starts at line[open], if it is one: a matching }, an unquoted comma at its own level, all in one word. */
function braceBody(line, open) {
  let depth = 0;
  let q = null;
  let start = open + 1;
  const alts = [];
  for (let k = open; k < line.length; k++) {
    const ch = line[k];
    if (q === "'") { if (ch === "'") q = null; continue; }
    if (ch === '\\') { k++; continue; }
    if (q === '"') { if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; continue; }
    if (WORD_ENDS.includes(ch)) return null; // a brace expansion is one word
    if (ch === '$' && line[k + 1] === '{') { const close = line.indexOf('}', k); if (close < 0) return null; k = close; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        if (!alts.length) return null;
        alts.push(line.slice(start, k));
        return { open, close: k, alts };
      }
    } else if (ch === ',' && depth === 1) {
      alts.push(line.slice(start, k));
      start = k + 1;
    }
  }
  return null;
}

/**
 * Whether text names Claude Code's settings by name: a piece of it between spaces, the shell's punctuation, slashes, =,
 * : and commas (and the holes another command's output leaves, FILLED), that the disk takes for .claude or .mcp.json
 * (foldName), after the shell's quotes and backslashes are taken away and its braces expanded; or a wildcard piece that
 * starts with a dot and could match one of them.
 */
function textNamesClaude(text) {
  const t = String(text ?? '').replace(/[\\'"]/g, '');
  for (const word of t.split(/[ \t\n\r;&|<>()`$\0]+/)) {
    for (const form of braceForms(word)) {
      for (const seg of form.split(/[/=:,{}]+/)) {
        if (!seg) continue;
        const f = foldName(seg);
        if (f === '.claude' || f === '.mcp.json') return true;
        if (/[*?[]/.test(seg) && dotPatternMatchesClaude(seg)) return true;
      }
    }
  }
  return false;
}

/** A word's forms with its braces expanded as the shell would ({a,b} and nested ones, at most 32 forms). */
function braceForms(word, limit = 32) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) return [word];
  const out = [];
  for (const alt of m[1].split(',')) {
    for (const f of braceForms(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length), limit)) {
      out.push(f);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Whether a wildcard segment that starts with a dot (or with a bracket that lists one) could match .claude or .mcp.json:
 * a hidden name matches only a pattern that starts with a dot, zsh's default. Any case counts.
 */
function dotPatternMatchesClaude(seg) {
  if (seg[0] !== '.' && !/^\[[!^]?[^\]]*\.[^\]]*\]/.test(seg)) return false;
  let re = '';
  for (let k = 0; k < seg.length; k++) {
    const ch = seg[k];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[' && seg.indexOf(']', k + 2) > 0) {
      const close = seg.indexOf(']', k + 2);
      let body = seg.slice(k + 1, close);
      const not = body[0] === '!' || body[0] === '^';
      if (not) body = body.slice(1);
      re += `[${not ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      k = close;
    } else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    const r = new RegExp(`^${re}$`, 'i');
    return r.test('.claude') || r.test('.mcp.json');
  } catch {
    return true; // a pattern that cannot be read could match anything
  }
}

/** The command without the text of its heredocs (from the line after <<WORD up to the line WORD), which is data. */
function withoutHeredocs(command) {
  let out = '';
  let rest = String(command);
  for (;;) {
    const m = /<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(rest);
    if (!m) return out + rest;
    const nl = rest.indexOf('\n', m.index + m[0].length);
    if (nl < 0) return out + rest;
    out += rest.slice(0, nl + 1);
    const lines = rest.slice(nl + 1).split('\n');
    const end = lines.findIndex(line => (m[1] ? line.replace(/^\t+/, '') : line) === m[3]);
    rest = end < 0 ? '' : lines.slice(end).join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// What an ask says

/** Reasons that are only about where a command reaches. Such an ask keeps the command's everyday words. */
const WHERE_REASONS = new Set([R.readOutside, R.readLinks, R.readList, R.testsOutside, R.testsGit, R.testsClaude,
  R.nodeOutside, R.nodeGit, R.nodeClaude, R.fileLinked, R.pathUnclear, R.pathBack, R.pathLink, R.globMany, R.globUnclear, R.globOutside,
  R.gitSettingsOutside]);

/** Words that read oddly before " outside its own folder": they get ", using something outside its own folder". */
const OFF_PLACE = /internet|another computer|on this computer|administrator|stop a program/;

const suffix = where => (typeof where === 'string' && Object.hasOwn(WHERE, where) ? WHERE[where] : '');

/**
 * The sentence for the person. A command that waits is named by what it does and where it reaches. An everyday
 * word ("read a file", "run the tests") is used only when the policy itself, judging each part of the command
 * alone, would allow it or asks only because of where it reaches. Otherwise the sentence names the riskier
 * part, the option that made it ask ("write to a file", "delete files", "run another program"), or says
 * "run a command"; the exact command is always the detail. Never the agent's own description.
 */
function sentenceFor(tool, input, verdict, plain, ctx) {
  if (verdict.say) return verdict.say;
  const command = tool === 'Bash' || (tool === 'Monitor' && input.ws === undefined) ? input.command : undefined;
  if (verdict.decision === 'allow' || typeof command !== 'string' || !command.trim()) return plain + suffix(verdict.where);
  const base = realFolder(ctx.cwd);
  const wheres = [];
  // Output of another command used as words ($(…), `…`, <(…)) can be anything, so no part is vouched for.
  const filled = /\$\(|`|[<>]\(/.test(command);
  const act = commandAction(command, base && !filled ? c => vouch(c, base, ctx, wheres) : () => false);
  // The single command's own where; otherwise the most serious place any part reaches.
  const where = verdict.where ?? strongest([...wheres, base ? scanWhere(command, base, ctx.also) : undefined]);
  if (tool === 'Monitor') return plain + suffix(USES[where] ?? where);
  const does = act && !act.routine ? act.does : verdict.does ?? act?.does ?? RUN;
  return 'wants to ' + does + suffix(OFF_PLACE.test(does) ? USES[where] ?? where : where);
}

/** How serious a place is, for picking one when parts of a command reach several. */
const WHERE_RANK = { outside: 3, usesOutside: 3, claude: 2, usesClaude: 2, git: 1, usesGit: 1, linked: 1, usesLinked: 1, mayLeave: 1 };
const strongest = list => list.reduce((best, w) => ((WHERE_RANK[w] ?? 0) > (WHERE_RANK[best] ?? 0) ? w : best), undefined);

/** Redirections that only move output between the terminal, its error stream and /dev/null. */
const QUIET_REDIRECT = /^\d*(>|>>|&>|>&)(&\d|&-|\/dev\/(null|stdout|stderr|tty))$/;
const REDIRECT_ALONE = /^\d*(>|>>|&>|>&)$/;
const QUIET_TARGET = /^(&\d|&-|\/dev\/(null|stdout|stderr|tty))$/;

/**
 * Whether one part of a command (from shellCommands) is the everyday thing its words say: the policy, judging
 * that part alone, would allow it, or would ask only because of where it reaches (noted in `wheres`). A part
 * with a value the shell fills in ($VAR, `…`) or an escape, a variable set before it, `env` or `xargs` before
 * it, or a redirection other than to the terminal or /dev/null, is not vouched for: what it runs is not known.
 */
function vouch(c, base, ctx, wheres) {
  if (c.words.some(w => /[$`\\]/.test(w) || CONTROL.test(w))) return false;
  if (c.words.slice(0, c.at).some(w => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w) || w === 'env' || w === 'xargs')) return false;
  const rest = [];
  for (let k = c.at; k < c.words.length; k++) {
    const w = c.words[k];
    if (QUIET_REDIRECT.test(w)) continue;
    if (REDIRECT_ALONE.test(w) && QUIET_TARGET.test(c.words[k + 1] ?? '')) { k++; continue; }
    if (/[<>]/.test(w)) return false;
    rest.push(w);
  }
  if (c.inline) {
    // A shell given its command inline stands for that command (judged as its own part), if nothing else is added.
    return (rest.length === 3 && /^-l?c$|^-cl$/.test(rest[1])) || (c.prog === 'eval' && rest.length === 2);
  }
  // narrate's words have their quotes taken off already, so every wildcard and "=" counts as unquoted here.
  const words = rest.map(text => {
    const glob = /[*?[^#]/.test(text);
    return { text, glob, globLead: glob && /^[-*?[^#]/.test(text), pattern: text, equals: /^=.|[=:]=./.test(text) };
  });
  const v = judgeExpanded(words, base, ctx);
  if (v.decision === 'allow') return true;
  if (!WHERE_REASONS.has(v.reason)) return false;
  if (v.where) wheres.push(v.where);
  return true;
}

/**
 * Best effort, for the sentence of a command that already waits: does any word of any part name something
 * that exists outside the agent's folder (or in its .claude or .git folders)? `~` and $HOME are expanded, and
 * relative words are also tried from every folder the command `cd`s into. A `cd` out of the folder (a bare
 * `cd` goes to the home folder) counts as outside by itself.
 */
function scanWhere(command, base, also) {
  const cmds = shellCommands(command);
  const home = text => text.replace(/^\$(HOME|\{HOME\})(?=\/|$)/, os.homedir());
  const rank = { outside: 3, claude: 2, git: 1 };
  let found;
  const note = w => { if (!found || rank[w] > rank[found]) found = w; };
  const bases = [base];
  for (const c of cmds) {
    if (c.prog !== 'cd' && c.prog !== 'pushd') continue;
    const to = c.args.filter(a => !a.startsWith('-')).at(-1) ?? (c.prog === 'cd' && !c.args.includes('-') ? '~' : null);
    const r = to === null ? null : resolveReal(home(to), base);
    if (!r?.ok || !r.exists) continue;
    bases.push(r.real);
    if (placeOf(r.real, base) === 'outside' && !also.some(test => test(r.real))) note('outside');
  }
  for (const c of cmds) {
    for (let k = 0; k < c.words.length; k++) {
      if (k === c.at && !c.script) continue; // the program itself
      const text = home(c.words[k]);
      const word = { text, glob: /[*?[]/.test(text) };
      if (/^=.|[=:]=./.test(text)) note('outside'); // zsh's =program: a program's full path
      if (word.glob && globClimbs(text)) note('outside');
      for (const piece of readPieces(word)) {
        for (const b of bases) {
          const r = resolveReal(piece, b);
          if (!r.ok) continue;
          const place = placeOf(r.real, base);
          if (place === 'outside') {
            if (also.some(test => test(r.real))) continue;
            if (r.exists || climbsOut(piece)) note('outside');
          } else if (place === 'claude' || place === 'git') note(place);
        }
      }
    }
  }
  return found;
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
 * @returns {{ ok: true, real: string, exists: boolean }
 *   | { ok: false, reason: string, link?: string, rest?: string[] }}  link: the dangling link, and the rest after it
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
        return { ok: false, reason: R.pathLink, link: path.join(real, rest[0]), rest: rest.slice(1) };
      } catch (e) {
        if (!e || e.code !== 'ENOENT') return { ok: false, reason: R.pathUnclear };
      }
    }
    return { ok: true, real: rest.length ? path.join(real, ...rest) : real, exists: rest.length === 0 };
  }
  return { ok: false, reason: R.pathUnclear };
}

/**
 * Where writing through a link to something missing would land: the link's target, resolved the same way.
 * Links to links are followed a few times; past that, or when the link cannot be read, it stays unclear.
 */
function throughLinks(r, baseReal) {
  for (let hops = 0; !r.ok && r.link && hops < 8; hops++) {
    let to;
    try {
      to = fs.readlinkSync(r.link);
    } catch {
      return { ok: false, reason: R.pathLink };
    }
    const target = (to.startsWith('/') ? to : path.dirname(r.link) + '/' + to) + (r.rest.length ? '/' + r.rest.join('/') : '');
    r = resolveReal(target, baseReal);
  }
  return r.ok || !r.link ? r : { ok: false, reason: R.pathLink };
}

/**
 * Characters HFS+ leaves out when it compares names (git's own list, for .git): joiners and direction marks (U+200C to
 * U+200F, U+202A to U+202E, U+206A to U+206F) and the byte-order mark (U+FEFF). Written as numbers, so none hides here.
 */
const hfsIgnored = cp => (cp >= 0x200c && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x206a && cp <= 0x206f) || cp === 0xfeff;

/**
 * A name as the Mac's disks compare it, for the names the policy protects (.git, .claude, .mcp.json). APFS folds case and
 * Unicode forms, so ".CLAUDE", and ".mcp.json" written with a long s (U+017F) in place of its s, are the same files as
 * ".claude" and ".mcp.json". Compared after NFKC normalisation and case folding (upper, then lower case, which also folds
 * the sharp s and the long s), with the characters HFS+ ignores left out. It folds a little more than a disk does (a
 * dotless i, fullwidth letters): that only ever protects more.
 */
function foldName(seg) {
  const kept = [...seg].filter(ch => !hfsIgnored(ch.codePointAt(0))).join('');
  return kept.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

/**
 * The folder names that hold Claude Code's own settings: a .claude folder at any depth (settings, hooks,
 * skills, agents, commands) and .mcp.json, compared as the disk compares names (foldName).
 */
function claudeSetting(rel) {
  return rel.split('/').some(seg => { const s = foldName(seg); return s === '.claude' || s === '.mcp.json'; });
}

/**
 * Where a real path sits relative to the agent's real folder: 'cwd', 'inside', 'git', 'claude' or 'outside'. git's records
 * are a .git folder at any depth, and any folder laid out like one (gitRecordsAt), with everything in them.
 */
function placeOf(real, baseReal) {
  if (real === baseReal) return 'cwd';
  const prefix = baseReal.endsWith('/') ? baseReal : baseReal + '/';
  if (!real.startsWith(prefix)) return 'outside';
  const rel = real.slice(prefix.length);
  if (claudeSetting(rel)) return 'claude'; // before .git: a .claude folder is refused at any depth
  // As the disk compares names: on a default macOS disk ".GIT/config" is the same file as ".git/config".
  const segs = rel.split('/');
  if (segs.some(seg => foldName(seg) === '.git')) return 'git';
  for (let k = 1; k <= segs.length; k++) if (gitRecordsAt(prefix + segs.slice(0, k).join('/'))) return 'git';
  return 'inside';
}

/** Whether something is at `p` (a link to something missing counts). Anything but "not there" counts, to stay careful. */
function present(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
  }
}

/**
 * A folder laid out as git's records, which git takes for a repository: HEAD, with objects and refs (a bare repository, or
 * the records `--separate-git-dir` put there), or with a commondir file (a worktree's own records). Its settings and hooks
 * make git run programs just as those in .git do.
 */
function gitRecordsAt(dir) {
  return present(dir + '/HEAD') && ((present(dir + '/objects') && present(dir + '/refs')) || present(dir + '/commondir'));
}

/**
 * Whether git working in `dir`, a folder inside the agent's, would find a repository other than the agent's own: a folder
 * on its way up to the agent's folder has a .git of its own (a folder, or a file that points anywhere), or is laid out
 * as git's records.
 */
function otherRepository(dir, base) {
  const prefix = base.endsWith('/') ? base : base + '/';
  for (let d = dir; d.startsWith(prefix); d = path.dirname(d)) {
    if (present(d + '/.git') || gitRecordsAt(d)) return true;
  }
  return false;
}

/** For a sentence: where a path a command writes or deletes sits ('outside', 'git', 'claude'), if anywhere special. */
function placeWhere(p, base) {
  if (typeof p !== 'string' || !p) return undefined;
  const r = resolveReal(p, base);
  if (!r.ok) return undefined;
  const place = placeOf(r.real, base);
  return place === 'outside' || place === 'git' || place === 'claude' ? place : undefined;
}

/** A file that shares its contents with another path (a hard link), possibly outside the folder. */
function linkedFile(real) {
  try {
    const st = fs.statSync(real);
    return st.isFile() && st.nlink > 1; // folders always have more than one link
  } catch {
    return false;
  }
}

/**
 * Claude Code trims a path before it uses it (2.1.221: its expandPath, `Wi`, for Grep's and Glob's `path` and Glob's
 * folder), so blank space at either end can hide a `~` or a `/`: " ~/.ssh" reads as a folder inside the agent's own.
 * The policy never vouches for such a path. JavaScript's trim() is exactly what Claude Code strips.
 */
const padded = v => typeof v === 'string' && v !== v.trim();

function judgeEdit(tool, input, cwd) {
  const target = tool === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : (input.file_path ?? input.notebook_path);
  if (typeof target !== 'string' || !target.trim()) return ask(R.noFile);
  const base = realFolder(cwd);
  if (!base) return ask(R.noCwd);
  if (padded(target)) {
    // Claude Code expands an edit's path before the hook sees it, so this should not happen. Should it, the path is
    // refused when either reading of it would be (an OK must not open .claude), and asks otherwise.
    const refused = [target, target.trim()].map(t => judgeEditTarget(t, base)).find(v => v.decision === 'deny');
    return refused ?? ask(R.pathPadded, 'mayLeave');
  }
  return judgeEditTarget(target, base);
}

function judgeEditTarget(target, base) {
  // Through a link to something missing, writing would create the link's target: judge that instead.
  const r = throughLinks(resolveReal(target, base), base);
  if (!r.ok) return ask(r.reason);
  const where = placeOf(r.real, base);
  // Claude Code's own settings, in the agent's folder or anywhere else (the person's ~/.claude, the main
  // checkout's .claude): refused, since they could switch off this very check.
  if (where === 'claude' || (where === 'outside' && claudeSetting(r.real))) {
    const rel = where === 'claude' ? path.relative(base, r.real) : r.real;
    return deny(rel.split('/').some(s => foldName(s) === '.claude') ? R.fileClaude : R.fileMcp, 'claude');
  }
  if (where === 'git') return ask(R.fileGit, 'git');
  if (where === 'cwd') return ask(R.fileFolder);
  if (where !== 'inside') return ask(R.fileOutside, 'outside');
  if (r.exists && linkedFile(r.real)) return ask(R.fileLinked, 'linked');
  return allow(R.fileInside);
}

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent's own scratch folders (decide's readAlso), as tests on a real path. Entries that are not
 * absolute paths, roots that do not exist, and session ids that are not UUIDs are ignored.
 */
function readRoots(list) {
  const out = [];
  const real = p => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return null;
    try { return fs.realpathSync.native(p); } catch { return null; } // missing: nothing to read there
  };
  for (const e of Array.isArray(list) ? list : []) {
    if (typeof e === 'string') {
      const r = real(e);
      if (r && r !== '/') out.push(p => p === r || p.startsWith(r + '/'));
    } else if (e && typeof e === 'object' && typeof e.session === 'string' && SESSION_RE.test(e.session)) {
      const r = real(e.root);
      const session = e.session.toLowerCase();
      // <root>/<any key>/<session id>, and anything in it
      if (r && r !== '/') out.push(p => p.startsWith(r + '/') && (p.slice(r.length + 1).split('/')[1] || '').toLowerCase() === session);
    }
  }
  return out;
}

/**
 * A relative path that climbs out of the folder it starts from. Claude Code keeps the shell in a subfolder
 * after a `cd`, so such words are not judged by whether they exist from the agent's folder.
 */
function climbsOut(p) {
  if (/^[/~]/.test(p)) return false;
  const n = path.posix.normalize(p);
  return n === '..' || n.startsWith('../');
}

/**
 * null when reading `p` stays inside the agent's folder (its .git and .claude included) or one of its
 * scratch folders; otherwise an ask. `missingOk`: a path that does not exist names nothing to read, such
 * as the grep pattern "/api/users"; used for command words, never for the file tools. A missing relative
 * path that climbs out of the folder still asks (see climbsOut). `from` is the folder a relative path is read
 * from (git -C), inside the agent's folder; by default the agent's folder itself.
 */
function readCheck(p, base, also, missingOk = false, from = base) {
  if (typeof p !== 'string' || !p.trim()) return ask(R.pathUnclear);
  if (p === '/dev/null') return null;
  const r = resolveReal(p, from);
  if (!r.ok) return ask(r.reason, 'mayLeave'); // ~user, a missing link target: it could be anywhere
  if (placeOf(r.real, base) !== 'outside') return null;
  if (also.some(test => test(r.real))) return null;
  if (missingOk && !r.exists && !climbsOut(p)) return null;
  return ask(R.readOutside, 'outside');
}

/** The folder a wildcard pattern searches: its literal text up to the last '/' before the first wildcard. */
function globFolder(text) {
  const at = text.search(/[*?[^#{]/);
  if (at < 0) return text;
  const cut = text.lastIndexOf('/', at);
  return cut < 0 ? '' : text.slice(0, cut + 1);
}

/**
 * Whether one segment of a wildcard path could match "..": bash before 5.2, sh, dash and ksh let `.*`,
 * `..*`, `.?` and `.[.]` match it, so the wildcard climbs out of the folder it searches. Only a segment
 * that starts with a dot (or with a bracket listing one) and whose other literal characters are all dots
 * can; `.env*` and `.eslintrc*` cannot. A bracket may stand for a dot.
 */
function mayClimb(seg) {
  if (seg === '..') return true;
  if (!/[*?[]/.test(seg)) return false;
  const lead = /^\[([!^]?)(\]?[^\]]*)\]/.exec(seg);
  if (seg[0] !== '.' && !(lead && !lead[1] && lead[2].includes('.'))) return false; // a wildcard never matches a leading dot
  return /^\.*$/.test(seg.replace(/\[[!^]?\]?[^\]]*\]/g, '').replace(/[*?]/g, ''));
}

/**
 * Where Claude Code itself takes a place to be (2.1.221: its expandPath, `Wi`, after the trim): "~" and "~/" are the
 * home folder, and ".." is taken away as text, before the system follows any link. So with a link that leads deeper
 * inside the folder ("deep" -> "a/b"), "deep/../.." is the folder above the agent's own, although the system would land
 * back inside it. Checked as well as the system's own reading.
 */
function claudePlace(v, base) {
  if (v === '~') return os.homedir();
  if (v.startsWith('~/')) return path.join(os.homedir(), v.slice(2));
  return path.isAbsolute(v) ? path.normalize(v) : path.resolve(base, v);
}

/**
 * The folder Claude Code's Glob searches for an absolute pattern (2.1.221: kTy), before it trims it: the text before
 * the last '/' ahead of the first *, ?, [ or { ("/" when that is the first character), or the pattern's own folder
 * when it has none of them. It can be deeper than globFolder's, which also stops at ^ and #.
 */
function claudeGlobFolder(pattern) {
  const at = pattern.search(/[*?[{]/);
  if (at < 0) return path.dirname(pattern);
  const cut = pattern.lastIndexOf('/', at);
  return cut <= 0 ? '/' : pattern.slice(0, cut);
}

/** A wildcard word with '..', or a segment that can match it, at or after its first wildcard. */
function globClimbs(text) {
  const segs = text.split('/');
  const first = segs.findIndex(s => /[*?[^#]/.test(s));
  return first >= 0 && segs.slice(first).some(mayClimb);
}

function judgeRead(tool, input, { cwd, also }) {
  const base = realFolder(cwd);
  if (!base) return ask(R.noCwd);
  const targets = [];
  for (const k of READ_TOOLS[tool]) {
    const v = input[k];
    if (v === undefined || v === null || (v === '' && tool !== 'Read')) continue; // no place: the agent's folder
    if (padded(v)) return ask(R.pathPadded, 'mayLeave'); // " ~/.codex" searches the home folder's .codex
    targets.push(v);
    if (typeof v === 'string' && v) targets.push(claudePlace(v, base)); // and as Claude Code reads it
  }
  if (tool === 'Read' && !targets.length) return ask(R.noRead);
  if (tool === 'Glob') {
    const pattern = input.pattern;
    if (typeof pattern !== 'string' || !pattern) return ask(R.pathUnclear);
    if (pattern.includes('..')) return ask(R.readOutside, 'outside'); // even inside {a,..} or [.][.]
    // The search starts at the folder before the pattern's first wildcard: its own when absolute,
    // otherwise inside `path` (or the agent's folder). Joined as text, so the system resolves any link.
    const folder = globFolder(pattern);
    const from = typeof input.path === 'string' && input.path ? input.path.replace(/\/+$/, '') + '/' : '';
    if (/^[/~]/.test(folder)) targets.push(folder);
    else if (folder) targets.push(from + folder);
    // An absolute pattern is searched from the folder Claude Code reads in it, trimmed: judged as it reads it too.
    if (pattern.startsWith('/')) {
      const searched = claudeGlobFolder(pattern);
      if (padded(searched)) return ask(R.pathPadded, 'mayLeave'); // "<folder>/link /*" searches <folder>/link
      targets.push(searched);
    }
  }
  for (const t of targets) {
    const v = readCheck(t, base, also);
    if (v) return v;
  }
  return allow(R.readInside);
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
 * `pattern` is the word as the shell matches it against file names: every quoted character escaped with a backslash
 * (SHELL_META keeps a backslash of the command's own out). `equals`: zsh would replace it with a program's full path,
 * since an unquoted "=" starts it (`=node`, also after empty quotes) or, with the MAGIC_EQUAL_SUBST option the person may
 * have set, follows "=" or ":" (`--output==node`), and something comes after that "=".
 * @returns {{ words: { text: string, glob: boolean, globLead: boolean, pattern: string, equals: boolean }[] } | { error: string }}
 */
export function splitWords(cmd) {
  const words = [];
  let cur = null;
  let quote = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else { cur.text += ch; cur.pattern += '\\' + ch; }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (!cur) cur = { text: '', pattern: '', glob: false, globLead: false, quoted: false, eq: -1 };
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur.quoted = true;
      continue;
    }
    if (ch === '#' && cur.text === '' && !cur.quoted) return { error: R.comment };
    if (ch === '=' && cur.eq < 0 && (cur.text === '' || /[=:]$/.test(cur.text))) cur.eq = cur.text.length;
    // '^' and '#' are wildcards too when zsh's extendedglob option is on.
    if (GLOB_CHARS.has(ch) || ch === '^' || ch === '#') {
      cur.glob = true;
      // The expansion starts with the literal text before the wildcard. Empty or '-' means it
      // could become an option, such as a file someone named "-delete".
      if (cur.text === '' || cur.text.startsWith('-')) cur.globLead = true;
    }
    cur.text += ch;
    cur.pattern += ch;
  }
  if (quote) return { error: R.quotes };
  if (cur) words.push(cur);
  return {
    words: words.map(({ text, pattern, glob, globLead, eq }) => ({ text, glob, globLead, pattern, equals: eq >= 0 && eq < text.length - 1 })),
  };
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

/** Whether an option matches a { short, long } spec. */
const optionIs = (arg, o) => shortHas(arg, o.short ?? '') || longIs(arg, o.long ?? []);

/**
 * The value an option takes, given as --opt=value, --opt value, -ovalue (in a cluster such as -uovalue) or
 * -o value. `letters` are the short forms that take it.
 */
function optionValue(args, k, letters) {
  const a = args[k];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    return eq >= 0 ? a.slice(eq + 1) : args[k + 1];
  }
  const at = [...a.slice(1)].findIndex(ch => letters.includes(ch));
  return (at >= 0 && a.slice(at + 2)) || args[k + 1];
}

/**
 * Read-only commands from the contract. `null`: no option of the command writes or runs anything,
 * so wildcards are harmless. Otherwise the options in `writes` and `runs` make it ask (extra strictness:
 * these are the options that turn a "read-only" command into one that writes files or starts programs);
 * `target` is the option whose value is the file written, so the ask can say where it is.
 */
const READ_ONLY = {
  ls: null, pwd: null, cat: null, head: null, tail: null, wc: null, echo: null, which: null,
  stat: null, diff: null, cut: null, grep: null,
  file: { writes: { short: 'C', long: ['compile'] } },
  tree: { writes: { short: 'oR', long: ['output'] }, target: 'o' },
  sort: { writes: { short: 'o', long: ['output'] }, runs: { long: ['compress-program'] }, target: 'o' },
  rg: { runs: { short: 'z', long: ['pre', 'pre-glob', 'search-zip', 'hostname-bin'] } },
  uniq: { uniq: true },
};

// In an agent's shell, Claude Code replaces `find` and `grep` with its own embedded bfs and ugrep, so their
// extra options are on these lists too (bfs: -rm, -files0-from; ugrep: --dereference-files, --from).
const FIND_BAD = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-rm', '-fprint', '-fprint0', '-fprintf', '-fls']);
const FIND_WRITES = new Set(['-fprint', '-fprint0', '-fprintf', '-fls']); // the next word is the file written
const findDoes = opt => (opt === '-delete' || opt === '-rm' ? 'delete files' : FIND_WRITES.has(opt) ? 'write to a file' : 'run another program');

/**
 * git's own commands (`git help -a`, git 2.47), which an agent may run in its own folder without asking (see judgeGit
 * for what still asks). Any other word after `git` is an alias or another program named git-<word>, so it asks.
 */
const GIT_OWN = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'backfill', 'bisect', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file',
  'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format', 'checkout', 'checkout-index', 'cherry', 'cherry-pick',
  'clean', 'clone', 'column', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'describe', 'diagnose',
  'diff', 'diff-files', 'diff-index', 'diff-pairs', 'diff-tree', 'fast-export', 'fast-import', 'fetch', 'fetch-pack',
  'fmt-merge-msg', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'get-tar-commit-id', 'grep', 'hash-object', 'help', 'hook',
  'index-pack', 'init', 'interpret-trailers', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'mailinfo', 'mailsplit', 'maintenance',
  'merge', 'merge-base', 'merge-file', 'merge-tree', 'mktag', 'mktree', 'multi-pack-index', 'mv', 'name-rev', 'notes',
  'pack-objects', 'pack-redundant', 'pack-refs', 'patch-id', 'prune', 'prune-packed', 'pull', 'push', 'range-diff', 'read-tree',
  'rebase', 'reflog', 'refs', 'remote', 'repack', 'replace', 'replay', 'request-pull', 'rerere', 'reset', 'restore', 'rev-list',
  'rev-parse', 'revert', 'rm', 'send-pack', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref', 'sparse-checkout',
  'stage', 'stash', 'status', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-file', 'unpack-objects',
  'update-index', 'update-ref', 'update-server-info', 'var', 'verify-commit', 'verify-pack', 'verify-tag', 'version',
  'whatchanged', 'worktree', 'write-tree',
]);
/**
 * git commands that start other programs, servers or windows, run git in other repositories, or send mail: they ask.
 * `credential` and its helpers (credential-osxkeychain, credential-store...) work with the person's stored sign-in.
 */
const GIT_PROGRAMS = new Set(['archimport', 'citool', 'cvsexportcommit', 'cvsimport', 'cvsserver', 'daemon', 'difftool',
  'filter-branch', 'for-each-repo', 'fsmonitor--daemon', 'gui', 'http-backend', 'imap-send', 'instaweb', 'merge-index',
  'merge-one-file', 'mergetool', 'p4', 'quiltimport', 'receive-pack', 'remote-ext', 'remote-fd', 'send-email', 'shell', 'svn',
  'upload-archive', 'upload-pack', 'web--browse']);
/**
 * git commands that only read. A word of theirs that names nothing (a search pattern such as "/api") is fine, as for the
 * other read-only commands; every other git command may write, so its words are held to where git could write.
 * narrate.mjs keeps its own copy (GIT_LOOK: the page loads that file), held in step by test/narrate.test.mjs.
 */
export const GIT_READ = new Set(['annotate', 'blame', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'cherry', 'count-objects', 'describe', 'diff', 'diff-files', 'diff-index', 'diff-pairs', 'diff-tree', 'for-each-ref',
  'get-tar-commit-id', 'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'name-rev', 'range-diff',
  'rev-list', 'rev-parse', 'shortlog', 'show', 'show-branch', 'show-ref', 'status', 'var', 'verify-commit', 'verify-tag',
  'version', 'whatchanged']);
/** Options before the subcommand that change nothing about where git works or what it runs. -C is judged on its own. */
const GIT_QUIET = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--no-lazy-fetch', '--no-advice']);
/** Options of a git command that make it start a program it is given, or write settings that can name one. */
const GIT_RUNS = Object.freeze({
  push: { long: ['receive-pack', 'exec'] }, 'send-pack': { long: ['receive-pack', 'exec'] },
  fetch: { long: ['upload-pack'] }, pull: { long: ['upload-pack'] }, 'ls-remote': { long: ['upload-pack'] },
  'fetch-pack': { long: ['upload-pack', 'exec'] }, archive: { long: ['exec'] },
  clone: { short: 'uc', long: ['upload-pack', 'config', 'template'] }, init: { long: ['template'] },
  rebase: { short: 'x', long: ['exec'] }, grep: { short: 'O', long: ['open-files-in-pager'] }, help: { short: 'w', long: ['web'] },
});
/** git push: options and refspecs that replace or delete what is on the remote, and the options that take a value. */
const PUSH_REWRITES = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune'];
const PUSH_VALUES = ['repo', 'push-option', 'receive-pack', 'exec'];
/** git config: what writes, what only reads, and the options that take a value (git 2.46 also has `git config set …`). */
const CONFIG_WRITES = ['add', 'replace-all', 'unset', 'unset-all', 'rename-section', 'remove-section', 'edit', 'comment'];
const CONFIG_READS = ['get', 'get-all', 'get-regexp', 'get-urlmatch', 'get-color', 'get-colorbool', 'list'];
const CONFIG_VALUES = ['file', 'blob', 'type', 'default', 'comment', 'value', 'url'];
const CONFIG_ACTIONS = new Set(['set', 'unset', 'rename-section', 'remove-section', 'edit']);
/**
 * Commands whose -m (--message) is text, never a place: the letters of options that take no value, which may stand
 * before m in one word (`git commit -am "…"`).
 */
const MESSAGE_FLAGS = Object.freeze({ commit: 'apsneioqvz', tag: 'asfdvlei', merge: 'nqve', stash: 'pkuaqS', notes: 'f', 'commit-tree': '' });
/** A web address (https://, ssh://, git://...): a place on another computer, not in this one. file:// is a path here. */
const WEB_ADDRESS = /^(?!file:)[a-z][a-z0-9+.-]*:\/\//i;
/** Where a git command could write, by what kind of place it is: each asks. */
const GIT_PLACE = Object.freeze({ outside: R.gitOutside, git: R.gitRecords, claude: R.gitClaude });
/**
 * Options `node --test` may take, from `node --help` on Node 26, and what each one's value may be (null: a
 * switch with no value). Every other option asks, among them each option that loads a module: --import,
 * --require, --loader, --test-global-setup, and --test-reporter with anything but Node's own reporters
 * (a module path or a data: URL is code, run as the person).
 */
const NODE_TEST_OPTS = Object.freeze({
  '--test': null, '--test-only': null, '--test-force-exit': null, '--test-update-snapshots': null, '--test-randomize': null,
  '--test-coverage-include-all': null, '--experimental-test-coverage': null, '--experimental-test-module-mocks': null,
  '--test-concurrency': 'number', '--test-timeout': 'number', '--test-random-seed': 'number',
  '--test-coverage-branches': 'number', '--test-coverage-functions': 'number', '--test-coverage-lines': 'number',
  '--test-shard': 'shard', '--test-isolation': 'isolation', '--experimental-test-isolation': 'isolation',
  // Patterns matched against test names, tags or file names: never opened or run.
  '--test-name-pattern': 'text', '--test-skip-pattern': 'text', '--experimental-test-tag-filter': 'text',
  '--test-coverage-include': 'text', '--test-coverage-exclude': 'text',
  '--test-reporter': 'reporter', '--test-reporter-destination': 'destination', '--test-rerun-failures': 'file',
  // Not test options, and harmless with them.
  '--no-warnings': null, '--enable-source-maps': null,
  '--experimental-strip-types': null, '--no-strip-types': null, '--no-experimental-strip-types': null, '--experimental-transform-types': null,
});
const NODE_REPORTERS = new Set(['spec', 'tap', 'dot', 'junit', 'lcov']);
/**
 * node's options that load or run code, or let another program run code in it (a debugger), wherever they
 * appear: -r (--require), -e (--eval), -p (--print), -C (--conditions) and these. Node reads `_` as `-` in
 * option names (--experimental_loader is --experimental-loader).
 */
const NODE_CODE_SHORT = 'repC';
const NODE_CODE_OPTS = new Set(['--import', '--require', '--loader', '--experimental-loader', '--eval', '--print',
  '--env-file', '--env-file-if-exists', '--experimental-config-file', '--experimental-default-config-file', '--inspect',
  '--inspect-brk', '--inspect-wait', '--inspect-port', '--debug-port', '--run', '--entry-url', '--snapshot-blob',
  '--build-snapshot', '--build-snapshot-config', '--openssl-config', '--experimental-network-imports',
  '--experimental-policy', '--conditions', '--experimental-addon-modules']);

/** Read-only commands whose words are never opened as files. */
const NO_FILE_ARGS = new Set(['echo', 'which', 'pwd']);
/** Options that make a command follow links while it walks through folders (or compares them). */
const FOLLOWS = {
  // -R (GNU), -S (BSD grep on macOS; ugrep's --dereference-files)
  grep: a => shortHas(a, 'RS') || longIs(a, ['dereference-recursive', 'dereference-files']),
  rg: a => shortHas(a, 'L') || longIs(a, ['follow']),
  find: a => a === '-L' || a === '-follow',
  tree: a => shortHas(a, 'l'),
  ls: a => shortHas(a, 'L') || longIs(a, ['dereference']),
  diff: a => shortHas(a, 'r') || longIs(a, ['recursive']),
};
/** Options that read the names of the files to open from another file. */
const NAMES_FROM = {
  sort: a => longIs(a, ['files0-from']),
  wc: a => longIs(a, ['files0-from']),
  file: a => shortHas(a, 'f') || longIs(a, ['files-from']),
  find: a => a === '-files0-from', // bfs
  grep: a => longIs(a, ['from']), // ugrep: "Read additional pathnames of files to search from FILE"
};

function judgeBash(input, ctx) {
  const command = input.command;
  if (typeof command !== 'string' || !command.trim()) return ask(R.noCommand);
  if (SHELL_META.test(command)) return ask(R.meta);
  if (CONTROL.test(command)) return ask(R.control, undefined, RUN);
  const base = realFolder(ctx.cwd);
  if (!base) return ask(R.noCwd);
  const split = splitWords(command);
  if (split.error) return ask(split.error, undefined, RUN);
  return judgeExpanded(split.words, base, ctx);
}

/** One simple command, already split into words, against the agent's real folder. */
function judgeWords(words, base, { extraAllow, also = [] }) {
  if (!words.length || !words[0].text) return ask(R.noCommand);
  if (words[0].glob) return ask(R.globCommand, undefined, RUN);
  const argv = words.map(w => w.text);

  // The repository owner's own prefixes. Their options are unknown to us, so wildcards that
  // could become options still ask.
  if (matchesExtra(argv, extraAllow)) {
    return words.some(w => w.globLead) ? ask(R.globOption, undefined, RUN) : allow(R.extra);
  }
  // zsh replaces =node with the full path of the node program: a place outside the folder, whatever the command.
  if (words.some(w => w.equals)) return ask(R.equals, 'outside');

  // Commands that only read must also read only inside the agent's folder (or its scratch folders).
  const cmd = argv[0];
  if (Object.hasOwn(READ_ONLY, cmd)) {
    const v = judgeReadOnly(READ_ONLY[cmd], argv, words, base);
    return v.decision === 'allow' ? (wordsStayInside(cmd, words.slice(1), base, also) || v) : v;
  }
  if (cmd === 'find') {
    const k = argv.findIndex((a, i) => i > 0 && FIND_BAD.has(a));
    if (k > 0) return ask(R.findDanger, FIND_WRITES.has(argv[k]) ? placeWhere(argv[k + 1], base) : undefined, findDoes(argv[k]));
    if (words.some(w => w.globLead)) return ask(R.globOption, undefined, RUN);
    return wordsStayInside(cmd, words.slice(1), base, also) || allow(R.readOnly);
  }
  if (cmd === 'git') return judgeGit(argv, words, base, also);
  if (cmd === 'gh' && ghShowsSignIn(argv)) return ask(R.ghSignIn, undefined, 'see your GitHub sign-in');
  return judgeRunner(argv, words, base) || ask(R.notSafe);
}

// ---------------------------------------------------------------------------------------------
// Wildcards, expanded the way zsh would

/**
 * How much one command's wildcards may read before the policy stops and asks, for each of the two readings below: the
 * folder entries read, and the files matched.
 */
const GLOB_LIMIT = Object.freeze({ entries: 10000, matches: 500 });

/** Reasons a wildcard could not be expanded safely, as asks. */
const GLOB_ASK = Object.freeze({
  many: () => ask(R.globMany, 'mayLeave'), unclear: () => ask(R.globUnclear, 'mayLeave'), outside: () => ask(R.globOutside, 'outside'),
});

/**
 * One simple command, its wildcards included. zsh turns a word with an unquoted *, ? or [...] into the names of the files it
 * matches before the command sees them, so such a word is judged by what it can become, by the same rules as words written
 * out in full: judgeWords on the words as they are written (which also asks for wildcards that could become options or
 * climb out of the folder), then on each reading of the command that globReadings finds. The first ask decides.
 * The repository owner's own prefixes allow any words after them, as before; echo, which and pwd open no file.
 */
function judgeExpanded(words, base, ctx) {
  const written = judgeWords(words, base, ctx);
  if (written.decision !== 'allow' || written.reason === R.extra || !words.some(w => w.glob) || NO_FILE_ARGS.has(words[0].text)) return written;
  const readings = globReadings(words, base, ctx.also ?? []);
  if (!Array.isArray(readings)) return readings;
  for (const r of readings) {
    const v = judgeWords(r, base, ctx);
    if (v.decision !== 'allow') return v;
  }
  return written;
}

/**
 * The commands a line with wildcards can become, each a list of plain words. Claude Code keeps the person's own zsh options
 * (it turns off only extendedglob and bare glob qualifiers), and those decide some of what a wildcard becomes, so every
 * reading they allow is covered:
 * - each wildcard word replaced by every file it matches the strict way (zsh's defaults: case counts; a hidden name only
 *   for a pattern that starts with a dot; `**` only as a whole segment before "/", which descends into folders without
 *   following links, `***` following them), and by every file it matches the loose way (any case, hidden names and folders
 *   too, and `**` at the start of any segment standing for `**` / `*`: the NO_CASE_GLOB, GLOB_DOTS and GLOB_STAR_SHORT
 *   options);
 * - for git, whose words take roles by where they stand (an option's value, `worktree move`), each loose match alone in
 *   its word's place;
 * - the words as written (NO_NOMATCH, NOGLOB, and bash, which keep a word that matches nothing), and the line without each
 *   word that matches nothing the strict way (NULL_GLOB drops it, so the next word takes its place).
 * Matches are judged with links followed, as paths written out in full are. Only folders inside the agent's own folder or
 * its scratch folders are searched: a search elsewhere, too many matches, or a form this does not read (a quoted character
 * inside [...], ~user) is returned as an ask instead.
 * @returns {object[][] | object} the readings, or an ask
 */
function globReadings(words, base, also) {
  const budgets = [{ entries: 0, matches: 0 }, { entries: 0, matches: 0 }];
  const plain = text => ({ text, glob: false, globLead: false, pattern: text, equals: false });
  const found = [];
  for (const w of words) {
    const pattern = w.pattern ?? w.text;
    if (!w.glob || !hasWildcard(pattern)) { found.push(null); continue; } // ^ and # alone: plain text without extendedglob
    const strict = expandPattern(pattern, base, also, false, budgets[0]);
    if (strict.error) return GLOB_ASK[strict.error]();
    const loose = expandPattern(pattern, base, also, true, budgets[1]);
    if (loose.error) return GLOB_ASK[loose.error]();
    found.push({ strict: strict.paths, loose: loose.paths });
  }
  const at = found.flatMap((f, k) => (f ? [k] : []));
  const fill = pick => words.flatMap((w, k) => {
    const list = found[k] ? pick(found[k], k) : null;
    return list === null ? [plain(w.text)] : list.map(plain);
  });
  const readings = [fill(() => null), fill(f => (f.loose.length ? f.loose : null)), fill(f => f.strict)];
  // NULL_GLOB drops the words that match nothing for the person's options: any of those that match nothing the strict way.
  const none = at.filter(k => !found[k].strict.length);
  if (none.length > 3) return GLOB_ASK.unclear();
  for (let mask = 1; mask < 1 << none.length; mask++) {
    const gone = new Set(none.filter((k, b) => mask & (1 << b)));
    readings.push(words.flatMap((w, k) => (gone.has(k) ? [] : [plain(w.text)])));
  }
  if (words[0].text === 'git') {
    for (const k of at) for (const m of found[k].loose) readings.push(words.map((w, j) => plain(j === k ? m : w.text)));
  }
  const seen = new Set();
  return readings.filter(r => { const key = r.map(w => w.text).join('\0'); return !seen.has(key) && seen.add(key); });
}

/** Whether a pattern (quoted characters escaped with a backslash) has an unquoted *, ? or [. */
function hasWildcard(pattern) {
  for (let k = 0; k < pattern.length; k++) {
    if (pattern[k] === '\\') { k++; continue; }
    if (GLOB_CHARS.has(pattern[k])) return true;
  }
  return false;
}

/** A pattern's characters, one for each code point, each noting whether it was quoted (escaped with a backslash). */
function patternChars(pattern) {
  const cps = [...pattern];
  const out = [];
  for (let k = 0; k < cps.length; k++) {
    if (cps[k] === '\\' && k + 1 < cps.length) out.push({ ch: cps[++k], lit: true });
    else out.push({ ch: cps[k], lit: false });
  }
  return out;
}

/**
 * One segment of a pattern (between slashes) as tokens: a character { c }, any run { star }, one character { one }, or a
 * set [...] { set: { neg, items } }, whose items are ranges { from, to } (code points) and classes { cls } ([:alpha:]).
 * A [ with no closing ] is a plain character (zsh refuses the pattern; bash keeps it as it is). null for a quoted
 * character inside [...], which this does not read. `wild`: some token is not a plain character.
 */
function segmentTokens(chars) {
  const tokens = [];
  let wild = false;
  for (let k = 0; k < chars.length; k++) {
    const { ch, lit } = chars[k];
    if (lit) tokens.push({ c: ch });
    else if (ch === '*') { if (!tokens.at(-1)?.star) tokens.push({ star: true }); wild = true; }
    else if (ch === '?') { tokens.push({ one: true }); wild = true; }
    else if (ch === '[') {
      const set = parseSet(chars, k);
      if (set === null) return null;
      if (!set) tokens.push({ c: ch });
      else { tokens.push({ set: set.set }); wild = true; k = set.end; }
    } else tokens.push({ c: ch });
  }
  return { tokens, wild };
}

/** The set that starts with the [ at chars[k]: { set, end } (end: the index of its ]), false when nothing closes it, null when a quoted character is inside. */
function parseSet(chars, k) {
  let j = k + 1;
  let neg = false;
  if (j < chars.length && !chars[j].lit && (chars[j].ch === '!' || chars[j].ch === '^')) { neg = true; j++; }
  const items = [];
  const code = s => s.codePointAt(0);
  for (let first = true; j < chars.length; j++, first = false) {
    const { ch, lit } = chars[j];
    if (lit) return null;
    if (ch === ']' && !first) return { set: { neg, items }, end: j };
    if (ch === '[' && chars[j + 1]?.ch === ':') { // [:name:]
      let e = j + 2;
      while (e + 1 < chars.length && !(chars[e].ch === ':' && chars[e + 1].ch === ']')) e++;
      if (e + 1 < chars.length) {
        if (chars.slice(j, e + 2).some(c => c.lit)) return null;
        items.push({ cls: chars.slice(j + 2, e).map(c => c.ch).join('') });
        j = e + 1;
        continue;
      }
    }
    const to = chars[j + 2];
    if (chars[j + 1] && !chars[j + 1].lit && chars[j + 1].ch === '-' && to && !(to.ch === ']' && !to.lit)) {
      if (to.lit) return null;
      items.push({ from: code(ch), to: code(to.ch) });
      j += 2;
      continue;
    }
    items.push({ from: code(ch), to: code(ch) });
  }
  return false;
}

/**
 * Whether one character matches a set. The strict way reads a class ([:alpha:]) as matching nothing; the loose way, also
 * trying the character's other case, as matching anything: so what the strict way matches, zsh matches whatever its
 * options, and what zsh matches, the loose way matches too. `bytes`: c is one byte of a name read byte by byte, as zsh does
 * in the C locale; a byte of a longer character then matches any set the loose way, and none the strict way.
 */
function setHas(set, c, loose, bytes = false) {
  if (bytes && c.charCodeAt(0) >= 0x80) return loose;
  const tries = loose ? [c, c.toLowerCase(), c.toUpperCase()].filter(x => [...x].length === 1) : [c];
  const known = x => set.items.some(it => !it.cls && x.codePointAt(0) >= it.from && x.codePointAt(0) <= it.to);
  const cls = set.items.some(it => it.cls);
  if (!set.neg) return tries.some(known) || (loose && cls);
  return loose ? tries.some(x => !known(x)) : !known(c) && !cls;
}

/**
 * Whether a name matches a segment's tokens; the loose way ignores case. zsh reads a name character by character, or byte by
 * byte in the C locale (Workbench may well run without LANG, started from the Dock), where ? matches one of the two bytes
 * of an accented letter. So when the name or the tokens are not plain ASCII, both are tried: the loose way takes either
 * match, the strict way only both.
 */
function matchTokens(tokens, name, loose) {
  const ascii = s => /^[\x00-\x7f]*$/.test(s);
  const plainAscii = ascii(name) && tokens.every(t => (t.c === undefined || ascii(t.c)) && (!t.set || t.set.items.every(it => it.cls || it.to < 0x80)));
  const byChar = matchUnits(tokens, [...name], loose, false);
  if (plainAscii) return byChar;
  const asBytes = s => [...new TextEncoder().encode(s)].map(b => String.fromCharCode(b));
  const byteTokens = tokens.flatMap(t => (t.c !== undefined && !ascii(t.c) ? asBytes(t.c).map(c => ({ c })) : [t]));
  const byByte = matchUnits(byteTokens, asBytes(name), loose, true);
  return loose ? byChar || byByte : byChar && byByte;
}

/** Whether a list of characters (or bytes) matches the tokens: row[n] says the tokens so far match the first n of them. */
function matchUnits(tokens, cs, loose, bytes) {
  const same = (a, b) => a === b || (loose && (a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase()));
  let row = cs.map(() => false);
  row.unshift(true);
  for (const t of tokens) {
    const next = new Array(cs.length + 1).fill(false);
    for (let n = 0; n <= cs.length; n++) {
      if (t.star) next[n] = row[n] || (n > 0 && next[n - 1]);
      else if (n > 0 && row[n - 1]) next[n] = t.one || (t.set ? setHas(t.set, cs[n - 1], loose, bytes) : same(t.c, cs[n - 1]));
    }
    row = next;
  }
  return row[cs.length];
}

/** Thrown when a wildcard reads or matches more than GLOB_LIMIT allows. */
const TOO_MANY = Symbol('too many');

/**
 * The paths one pattern matches, as zsh would write them, read the strict or the loose way (see globReadings). The folder the
 * search starts in, the pattern's text before its first wildcard segment, must be inside the agent's folder or one of its
 * scratch folders.
 * @returns {{ paths: string[] } | { error: 'many' | 'unclear' | 'outside' }}
 */
function expandPattern(pattern, base, also, loose, budget) {
  let chars = patternChars(pattern);
  let prefix = '';
  if (chars[0]?.ch === '~' && !chars[0].lit) { // tilde expansion comes first: only ~ and ~/ are the home folder
    if (chars.length > 1 && chars[1].ch !== '/') return { error: 'unclear' };
    prefix = os.homedir().replace(/\/+$/, '') + '/';
    chars = chars.slice(1);
  } else if (chars[0]?.ch === '/') prefix = '/';
  while (chars[0]?.ch === '/') chars = chars.slice(1);
  const segs = [[]];
  for (const c of chars) { if (c.ch === '/') segs.push([]); else segs.at(-1).push(c); }
  const dirsOnly = segs.length > 1 && !segs.at(-1).length; // a pattern that ends in "/" matches folders only
  const parts = segs.filter(s => s.length);
  const tok = parts.map(segmentTokens);
  if (tok.some(t => t === null)) return { error: 'unclear' };
  const stars = p => { let n = 0; while (n < p.length && p[n].ch === '*' && !p[n].lit) n++; return n; };
  const firstWild = tok.findIndex(t => t.wild);
  const where = resolveReal(prefix + parts.slice(0, firstWild < 0 ? parts.length : firstWild).map(p => p.map(c => c.ch).join('')).join('/') || '.', base);
  if (!where.ok) return { error: 'unclear' };
  if (placeOf(where.real, base) === 'outside' && !also.some(test => test(where.real))) return { error: 'outside' };

  const fsPath = text => (text.startsWith('/') ? text : text ? base + '/' + text : base);
  const join = (dir, name) => (!dir ? name : dir.endsWith('/') ? dir + name : dir + '/' + name);
  const list = (dir, types) => {
    let names;
    try { names = fs.readdirSync(fsPath(dir), types ? { withFileTypes: true } : undefined); } catch { return []; }
    budget.entries += names.length;
    if (budget.entries > GLOB_LIMIT.entries) throw TOO_MANY;
    return names;
  };
  const isDir = text => { try { return fs.statSync(fsPath(text)).isDirectory(); } catch { return false; } };
  const hidden = name => name.startsWith('.');
  // A folder whose names the agent could have chosen: in its own folder or its scratch folders, not the ones above them.
  const mine = text => {
    let real;
    try { real = fs.realpathSync.native(fsPath(text)); } catch { return false; }
    return placeOf(real, base) !== 'outside' || also.some(test => test(real));
  };
  // The folders below `dir`, at any depth: not through links, unless `follow` (***), and hidden ones only the loose way.
  const below = (dir, follow) => {
    const out = [];
    const seen = new Set();
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const e of list(d, true)) {
        if (!loose && hidden(e.name)) continue;
        const text = join(d, e.name);
        if (!(e.isDirectory() || (follow && e.isSymbolicLink() && isDir(text)))) continue;
        if (follow) {
          let real;
          try { real = fs.realpathSync.native(fsPath(text)); } catch { continue; }
          if (seen.has(real)) continue;
          seen.add(real);
        }
        out.push(text);
        stack.push(text);
      }
    }
    return out;
  };
  const matchIn = (dirs, tokens, last) => {
    const out = [];
    for (const d of dirs) {
      for (const name of list(d, false)) {
        if (!loose && hidden(name) && tokens[0]?.c !== '.') continue; // zsh: a leading dot must be written
        if (!matchTokens(tokens, name, loose)) continue;
        const text = join(d, name);
        if (last || isDir(text)) out.push(text); // a folder, or a link to one, to go on into
      }
    }
    return out;
  };

  try {
    let cur = [prefix];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      const n = stars(p);
      if (n >= 2 && (loose || (n === p.length && n <= 3 && !last))) { // ** and ***, recursive
        const dirs = cur.flatMap(c => [c, ...below(c, n >= 3)]);
        const rest = p.slice(n);
        if (!rest.length && !last) { cur = dirs; continue; }
        cur = matchIn(dirs, segmentTokens([{ ch: '*', lit: false }, ...rest]).tokens, last);
        continue;
      }
      if (!tok[i].wild) {
        const name = p.map(c => c.ch).join('');
        const next = [];
        for (const c of cur) {
          const text = join(c, name);
          if (!last || present(fsPath(text))) next.push(text);
          // NO_CASE_GLOB on a disk that minds case: an entry that differs only in case
          if (loose && name !== '.' && name !== '..' && mine(c)) {
            for (const e of list(c, false)) if (e !== name && matchTokens(tok[i].tokens, e, true)) next.push(join(c, e));
          }
        }
        cur = next;
        continue;
      }
      cur = matchIn(cur, tok[i].tokens, last);
    }
    if (dirsOnly) cur = cur.filter(isDir).map(t => t + '/');
    budget.matches += cur.length;
    if (budget.matches > GLOB_LIMIT.matches) return { error: 'many' };
    return { paths: cur };
  } catch (e) {
    if (e === TOO_MANY) return { error: 'many' };
    throw e;
  }
}

/**
 * Every piece of a word that could name a path; a piece with a wildcard stands for the folder it searches.
 * The parts of a value are split on = : and , except that the slashes right after "scheme:" in a web address
 * (the "//" of "http://") are not a path of their own. A piece that starts with "-" is an option only while it has no
 * "/": git and the system read "--/../x" (a word, or a value as in --prefix=--/../x) as a path through a folder named
 * "--", which git makes itself.
 */
function readPieces(w) {
  const t = w.text;
  const out = new Set();
  const add = s => {
    if (!s || (s.startsWith('-') && !s.includes('/'))) return;
    if (w.glob && /[*?[^#]/.test(s)) s = globFolder(s);
    if (s) out.add(s);
  };
  // A short-option cluster can end in an attached value: -bf/path, -rf../x. Check every tail.
  if (/^-[^-]/.test(t)) for (let k = 2; k < t.length; k++) add(t.slice(k));
  const parts = t.split(/([=:,])/);
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i - 1] === ':' && /^\/+$/.test(parts[i])) continue;
    add(parts[i]);
  }
  add(t); // after its parts, so an ask names where an option's value leads, not a folder named "--prefix=--"
  return out;
}

/** null when no word of a read-only command reaches outside the agent's folder; otherwise an ask. */
function wordsStayInside(cmd, words, base, also) {
  if (NO_FILE_ARGS.has(cmd)) return null;
  for (const w of words) {
    if (FOLLOWS[cmd]?.(w.text)) return ask(R.readLinks, 'mayLeave');
    if (NAMES_FROM[cmd]?.(w.text)) return ask(R.readList, 'mayLeave');
    // After the first wildcard, '..' or a segment that can match it climbs out of the folder it searches.
    if (w.glob && globClimbs(w.text)) return ask(R.readOutside, 'outside');
    for (const piece of readPieces(w)) {
      const v = readCheck(piece, base, also, true);
      if (v) return v;
    }
  }
  return null;
}

/** uniq's files, in order: it reads the first and writes the second. After "--" every word is a file, even one that starts with "-". */
function uniqFiles(args) {
  const files = [];
  let operands = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!operands && a === '--') { operands = true; continue; }
    if (!operands && /^-[fsw]$/.test(a)) { k++; continue; } // these take a separate number
    if (operands || !a.startsWith('-') || a === '-') files.push(a);
  }
  return files;
}

function judgeReadOnly(spec, argv, words, base) {
  if (!spec) return allow(R.readOnly);
  if (spec.uniq) {
    // uniq writes its second file argument, and a wildcard can supply one.
    if (words.some(w => w.glob)) return ask(R.globOption, undefined, RUN);
    const files = uniqFiles(argv.slice(1));
    return files.length > 1 ? ask(R.writesFile, placeWhere(files[1], base), 'write to a file') : allow(R.readOnly);
  }
  if (words.some(w => w.globLead)) return ask(R.globOption, undefined, RUN);
  const args = argv.slice(1);
  if (spec.runs && args.some(a => optionIs(a, spec.runs))) return ask(R.runsProgram, undefined, 'run another program');
  const k = spec.writes ? args.findIndex(a => optionIs(a, spec.writes)) : -1;
  if (k >= 0) {
    const into = spec.target && (args[k].startsWith('--') || args[k].includes(spec.target)) ? optionValue(args, k, spec.target) : undefined;
    return ask(R.writesFile, placeWhere(into, base), 'write to a file');
  }
  return allow(R.readOnly);
}

/**
 * git, in the agent's own folder: any of git's own commands runs without asking (committing, branching, merging,
 * rebasing, fetching from and pushing to the repository's own remotes...). What reaches past the agent's own work still asks:
 * - options before the command that point git elsewhere or make it run programs (-c, --git-dir, --work-tree,
 *   --exec-path...), and -C with a folder outside the agent's own (-C inside it is fine), or one where git would find
 *   another repository, whose settings act as -c does;
 * - a word that is not one of git's own commands (an alias or another program), and the commands that start programs;
 * - the person's stored sign-in (`git credential`, its helpers);
 * - writing git's settings (`git config` that is not a plain read), and options that run a program they are given;
 * - a push that replaces or deletes what is on the remote, and a remote set up as a push mirror;
 * - a place outside the agent's folder in any word (and, for a command that can write, a place in .git or .claude);
 * - init and clone that keep a repository's records in a separate folder, and init that would set up again a repository
 *   whose records are outside the folder (gitRecordsMove);
 * - what destroys what no fetch can bring back, and what reaches another working copy (gitForGood);
 * - a patch, a replacement commit, another repository's address instead of one of the repository's own remotes, and git's
 *   settings read from outside the folder (gitReaches).
 * Wildcards that could turn file names into options ask, as for every command; judgeExpanded judges what the others become.
 */
function judgeGit(argv, words, base, also) {
  let i = 1;
  const from = [base]; // the folders git reads relative words from: the agent's own, then each -C folder
  for (; i < argv.length && argv[i].startsWith('-'); i++) {
    const a = argv[i];
    if (GIT_QUIET.has(a)) continue;
    if (a === '--version' && i === argv.length - 1) return allow(R.gitRead);
    if (a !== '-C' || i + 1 >= argv.length) return ask(R.gitOption, undefined, 'run a git command');
    i++;
    if (words[i].glob) return ask(R.globOption, undefined, RUN);
    if (argv[i] === '') continue; // git ignores an empty -C
    // Each -C is read from the folder the one before it led to, as git does.
    const r = resolveReal(argv[i], from.at(-1));
    if (!r.ok) return ask(r.reason, 'mayLeave', 'run a git command');
    const place = placeOf(r.real, base);
    if (place === 'outside') return ask(R.gitElsewhere, 'outside', 'run a git command');
    if (place === 'git') return ask(R.testsGit, 'git', 'run a git command');
    if (place === 'claude') return ask(R.testsClaude, 'claude', 'run a git command');
    if (!r.exists) return ask(R.pathUnclear, undefined, 'run a git command');
    from.push(r.real);
  }
  const sub = argv[i];
  if (sub === undefined) return ask(R.gitNone, undefined, 'run a git command');
  if (words[i].glob) return ask(R.globCommand, undefined, RUN);
  if (/^credential(-|$)/.test(sub)) return ask(R.gitSignIn, undefined, 'use your saved sign-in');
  if (GIT_PROGRAMS.has(sub)) return { ...ask(R.gitPrograms), say: 'wants to run another program' };
  if (!GIT_OWN.has(sub)) return { ...ask(R.gitUnknown), say: 'wants to run a git command' };
  // In a folder of its own, git looks for its repository from there up: it may find another one before the agent's.
  const at = from.at(-1);
  if (at !== base && otherRepository(at, base)) return ask(R.gitOtherRepo, undefined, 'run a git command');
  const rest = words.slice(i + 1);
  if (rest.some(w => w.globLead)) return ask(R.globOption, undefined, RUN);
  const args = argv.slice(i + 1);
  const v = gitOptions(sub, args);
  if (v) return v;
  const read = GIT_READ.has(sub) || sub === 'config'; // config gets here only when it reads
  return gitWords(sub, args, rest, from, base, also, read) || gitRecordsMove(sub, args, at, base) || gitForGood(sub, args, base)
    || gitReaches(sub, args, base) || allow(read ? R.gitRead : R.gitAny);
}

/** The asks that depend on a git command's options, not on the places it names; null when there are none. */
function gitOptions(sub, args) {
  // An address that makes git start a program (ext::<command>, fd::), whichever command is given it.
  if (args.some(a => /(^|=)(ext|fd)::/i.test(a))) return { ...ask(R.gitAddress), say: 'wants to run another program' };
  if (sub === 'config') return configWrites(args) ? ask(R.gitSettings, undefined, 'change git settings') : null;
  if ((sub === 'push' || sub === 'send-pack') && pushRewrites(args)) return ask(R.gitRemote); // narrate says what it replaces
  const first = args.find(a => !a.startsWith('-'));
  // A remote set up as a push mirror (remote.<name>.mirror): every later plain push to it acts as push --mirror.
  // `clone --mirror` sets one up for origin, and so do `remote add --mirror` and `--mirror=push` (not `=fetch`).
  if ((sub === 'clone' && args.some(a => longIs(a, ['mirror'])))
    || (sub === 'remote' && first === 'add' && args.some(a => longIs(a, ['mirror']) && !/=fetch$/.test(a)))) return ask(R.gitMirror);
  const runs = GIT_RUNS[sub];
  if (runs && args.some(a => optionIs(a, runs))) return { ...ask(R.gitRunsProgram), say: 'wants to run another program' };
  if ((sub === 'bisect' && first === 'run') || (sub === 'submodule' && first === 'foreach')) {
    return { ...ask(R.gitPrograms), say: 'wants to run another program' };
  }
  if (sub === 'maintenance' && /^(start|stop|register|unregister)$/.test(first ?? '')) {
    return { ...ask(R.gitSchedule), say: 'wants to change git settings for this computer' };
  }
  if (sub === 'apply' && args.some(a => longIs(a, ['unsafe-paths']))) return ask(R.gitUnsafe, 'mayLeave');
  return null;
}

/**
 * Whether `git config <args>` could write. Only a plain read is not: --get and its kin, --list (-l), git 2.46's
 * `get` and `list`, or a single name. --edit (-e) opens an editor on the settings, so it counts as a write.
 */
function configWrites(args) {
  let reads = false;
  const names = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { names.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0];
      // git takes an abbreviation of a long option: whatever could be a write counts as one.
      if (!name || (CONFIG_WRITES.some(n => n.startsWith(name)) && !CONFIG_READS.includes(name))) return true;
      if (CONFIG_READS.some(n => n.startsWith(name))) reads = true;
      else if (!a.includes('=') && CONFIG_VALUES.some(n => n.startsWith(name))) k++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'e') return true; // --edit
        if (a[j] === 'l') reads = true; // --list
        if (a[j] === 'f') { if (j === a.length - 1) k++; break; } // --file <file>: the rest is its value
      }
      continue;
    }
    names.push(a);
  }
  if (CONFIG_ACTIONS.has(names[0])) return true;
  if (names[0] === 'get' || names[0] === 'list') return false;
  return !reads && names.length > 1;
}

/**
 * Whether a push replaces or deletes what is on the remote: --force and its kin, --mirror, --delete (-d), --prune, or a
 * refspec that starts with + (force) or : (delete). git takes abbreviations of long options, so they count too.
 */
function pushRewrites(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') return args.slice(k + 1).some(x => x.startsWith('+') || x.startsWith(':'));
    if (a.startsWith('--')) {
      if (longIs(a, PUSH_REWRITES)) return true;
      if (!a.includes('=') && longIs(a, PUSH_VALUES)) k++; // its value is the next word
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'f' || a[j] === 'd') return true;
        if (a[j] === 'o') { if (j === a.length - 1) k++; break; } // -o <push option>
      }
      continue;
    }
    if (a.startsWith('+') || a.startsWith(':')) return true;
  }
  return false;
}

/** git init's options that take a value, which may be the next word. */
const INIT_VALUES = ['template', 'separate-git-dir', 'initial-branch', 'object-format', 'ref-format'];

/**
 * init and clone that would put a repository's records where the agent's folder does not keep them apart, null when
 * neither does. `--separate-git-dir` keeps them in a folder of their own, which edits do not treat as git's records
 * unless it is laid out like them already; run in a repository that is there already, init moves all its records there,
 * and from the agent's own folder that is the person's whole repository. And init that would set up again a repository
 * whose records are elsewhere: the folder it names (or, naming none, the one it runs in, `at`) has a .git file, as a
 * worktree has (the agent's own folder too), or a .git that leads outside. That holds with --bare too, which a later
 * --no-bare takes back. The places it names are judged as for any git command that writes, before this.
 */
function gitRecordsMove(sub, args, at, base) {
  if (sub !== 'init' && sub !== 'clone') return null;
  if (args.some(a => longIs(a, ['separate-git-dir']))) return ask(R.gitSeparate);
  if (sub !== 'init') return null;
  const dirs = initDirs(args);
  for (const d of dirs.length ? dirs : ['.']) {
    const r = resolveReal(d, at);
    if (r.ok && r.exists && initsElsewhere(r.real, base)) return ask(R.gitInitAgain, 'outside');
  }
  return null;
}

/** The folders git init names: its words that are no option or an option's value (none: the folder it runs in). */
function initDirs(args) {
  const dirs = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { dirs.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      if (!a.includes('=') && longIs(a, INIT_VALUES)) k++; // its value is the next word
      continue;
    }
    if (/^-[^-]/.test(a)) {
      if (a.indexOf('b') === a.length - 1) k++; // -b <branch> (also -qb <branch>); in -bmain the name follows b
      continue;
    }
    dirs.push(a);
  }
  return dirs;
}

/** Whether git init in folder `dir` would set up records outside it: its .git is a file (pointing anywhere) or leads out. */
function initsElsewhere(dir, base) {
  if (!present(dir + '/.git')) return false; // nothing there yet: a new repository, in the folder
  try {
    const real = fs.realpathSync.native(dir + '/.git');
    return !fs.statSync(real).isDirectory() || placeOf(real, base) === 'outside';
  } catch {
    return true; // a link to something missing, or a .git that cannot be read
  }
}

/** What an ask says for the worktree commands that reach another working copy by the end of its path. */
const WORKTREE_SAYS = Object.freeze({
  move: 'wants to move another working copy of the repository', lock: 'wants to lock another working copy of the repository',
  unlock: 'wants to unlock another working copy of the repository', repair: "wants to repair git's records of other working copies",
});

/**
 * What destroys what no fetch can bring back, null for anything else: git's record of earlier commits (reflog expire,
 * delete and drop), the commits no branch holds (gc --prune with any value, prune), upkeep that can delete them too
 * (maintenance run with any task, repack -d, prune-packed: after a dropped stash, `maintenance run --task=loose-objects` and
 * `repack -a -d` leave nothing to bring back), a branch other than the agent's own with its record (branch -d or -D:
 * Workbench names the agent's branch workbench/<its folder's name>), any of git's names for a commit (update-ref -d, or a
 * new value of all zeros, which deletes too), and other working copies of the repository (worktree remove and prune, with
 * their uncommitted work, and move, lock, unlock and repair: git finds a working copy by the end of its path, so the words
 * cannot show whose it is, and a working copy moved into the agent's folder goes when that folder is thrown away). An
 * agent's own work needs none of them.
 */
function gitForGood(sub, args, base) {
  const first = args.find(a => !a.startsWith('-'));
  if (sub === 'reflog' && /^(expire|delete|drop)$/.test(first ?? '')) return { ...ask(R.gitReflog), say: "wants to delete git's record of earlier commits" };
  if (sub === 'prune' || (sub === 'gc' && args.some(a => longIs(a, ['prune'])))) {
    return { ...ask(R.gitPrune), say: 'wants to delete commits that no branch holds' };
  }
  if ((sub === 'maintenance' && first === 'run') || sub === 'prune-packed' || (sub === 'repack' && args.some(a => /^-[^-]*d/.test(a)))) {
    return { ...ask(R.gitRepack), say: "wants to tidy git's records, which can delete work that no branch holds" };
  }
  if (sub === 'worktree' && Object.hasOwn(WORKTREE_SAYS, first ?? '')) return { ...ask(R.gitWorktreeOther), say: WORKTREE_SAYS[first] };
  if (sub === 'update-ref' && refDeletes(args)) return { ...ask(R.gitRefGone), say: 'wants to delete a branch, tag or other name for a commit' };
  const gone = sub === 'branch' ? branchDeletes(args) : null;
  if (gone && (gone.remotes || gone.names.some(n => n !== 'workbench/' + path.basename(base)))) {
    return { ...ask(R.gitBranchGone), say: 'wants to delete a branch that is not its own' };
  }
  if (sub === 'worktree' && first === 'remove') return { ...ask(R.gitWorktreeGone), say: 'wants to remove another working copy of the repository' };
  if (sub === 'worktree' && first === 'prune') return { ...ask(R.gitWorktreeGone), say: "wants to remove git's records of other working copies" };
  return null;
}

/**
 * git branch that deletes (-d, -D, --delete): the names it deletes, and whether they are remote-tracking branches (-r).
 * null when it deletes nothing. Every other word counts as a name (the value of --sort, say), and so does a lone "-".
 */
function branchDeletes(args) {
  let deletes = false;
  let remotes = false;
  const names = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { names.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      if (longIs(a, ['delete'])) deletes = true;
      else if (longIs(a, ['remotes'])) remotes = true;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'u' || ch === 't') break; // -u <upstream>, -t<mode>: the rest is its value
        if (ch === 'd' || ch === 'D') deletes = true;
        if (ch === 'r') remotes = true;
      }
      continue;
    }
    names.push(a);
  }
  return deletes ? { names, remotes } : null;
}

/** Whether git update-ref deletes: -d, or a new value of all zeros (`update-ref <ref> 000…`), which git takes as "delete". */
function refDeletes(args) {
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) continue; // --stdin, --no-deref, --create-reflog...: none takes a value
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'd') return true;
        if (a[j] === 'm') { if (j === a.length - 1) k++; break; } // -m <reason>
      }
      continue;
    }
    operands.push(a);
  }
  return /^(0{40}|0{64})$/.test(operands[1] ?? '');
}

/**
 * What reaches past the agent's own work by what a git command does, rather than by the places it names; null for
 * anything else: a patch, which can write any file in the folder (apply, am); a replacement commit, which changes what
 * every working copy shows (gitReplaces); another repository, reached with the person's saved sign-in, and submodules from
 * the addresses in .gitmodules (gitNetwork); and
 * git's settings read from outside the folder: the person's own, the computer's, or a list across all of them
 * (configReadsOutside, and `git var -l`, which lists them too), as `cat ~/.gitconfig` asks.
 */
function gitReaches(sub, args, base) {
  if (sub === 'apply' && appliesPatch(args)) return { ...ask(R.gitPatch), say: 'wants to apply a patch to its files' };
  if (sub === 'am' && !(args.length === 1 && /^--show-current-patch(=|$)/.test(args[0]))) return { ...ask(R.gitPatch), say: 'wants to apply patches and commit them' };
  const replaced = gitReplaces(sub, args);
  if (replaced) return replaced;
  const far = gitNetwork(sub, args, base);
  if (far) return far;
  if ((sub === 'config' && configReadsOutside(args)) || (sub === 'var' && args.some(a => /^-[^-]*l/.test(a)))) {
    return { ...ask(R.gitSettingsOutside, 'outside'), say: "wants to read git's settings from outside its own folder" };
  }
  return null;
}

/** Whether `git apply` applies the patch: unless --stat, --numstat, --summary or --check turn that off and --apply does not turn it back on. */
function appliesPatch(args) {
  let inspects = false;
  for (const a of args) {
    if (a === '--') break;
    if (/^--(stat|numstat|summary|check)$/.test(a)) inspects = true;
    else if (longIs(a, ['apply']) || longIs(a, ['build-fake-ancestor'])) return true; // --build-fake-ancestor writes a file of its own
  }
  return !inspects;
}

/**
 * A replacement commit: git then shows other contents in place of a commit it has, in every working copy, the person's
 * own included, until the replacement goes. `git replace` in any form but a list, and the same done another way: a name
 * under refs/replace written directly (update-ref, symbolic-ref) or fetched into (a refspec, or a --refmap, whose
 * destination can be there, such as refs/replace/* or refs/*). null for anything else.
 */
function gitReplaces(sub, args) {
  const hit = { ...ask(R.gitReplace), say: 'wants to make git show a different commit in place of another' };
  if (sub === 'replace') return replaceWrites(args) ? hit : null;
  if (sub === 'update-ref' || sub === 'symbolic-ref') return args.some(a => /^refs\/replace(\/|$)/i.test(a)) ? hit : null;
  if (sub === 'fetch' || sub === 'pull') {
    const { operands, opts } = gitArgs(args, NET_VALUES[sub]);
    // --refmap maps the refs named on the command line as a refspec in the settings would (`refs/heads/*:refs/replace/*`).
    const refmaps = opts.filter(([n, v]) => n.length >= 3 && 'refmap'.startsWith(n) && typeof v === 'string').map(([, v]) => v);
    for (const spec of [...operands.slice(1), ...refmaps]) {
      const at = spec.indexOf(':');
      if (at >= 0 && intoReplace(spec.slice(at + 1))) return hit;
    }
  }
  return null;
}

/** Whether a fetch refspec's destination can name something under refs/replace/: it is there, or a pattern whose fixed start is on the way. */
function intoReplace(dst) {
  const d = dst.toLowerCase();
  const star = d.indexOf('*');
  return d.startsWith('refs/replace/') || (star >= 0 && 'refs/replace/'.startsWith(d.slice(0, star)));
}

/** Whether `git replace` writes: anything but listing (no words, or -l/--list with patterns, and --format). */
function replaceWrites(args) {
  let lists = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    if (a === '-l' || (longIs(a, ['list']) && !a.includes('='))) { lists = true; continue; }
    if (a.startsWith('--') && a.length > 4 && 'format'.startsWith(a.slice(2).split('=')[0])) { if (!a.includes('=')) k++; continue; }
    if (a.startsWith('-')) return true; // -f, -d, --edit, --graft, --raw, --convert-graft-file...: each changes what git shows
    operands.push(a);
  }
  return !lists && operands.length > 0;
}

/**
 * The options of the git commands that reach another repository which take the next word as their value (from
 * `git <command> -h`; an option shown with [=<value>] takes it only after "=", and is not here). They matter: the first
 * other word is the repository. `flags`: options with no value of their own whose whole name starts one of `long`; git takes
 * a whole name over an abbreviation, so `fetch --recurse-submodules <repository>` is not `--recurse-submodules-default`.
 */
const NET_VALUES = Object.freeze({
  fetch: { long: ['upload-pack', 'jobs', 'depth', 'shallow-since', 'shallow-exclude', 'deepen', 'refmap', 'server-option', 'negotiation-tip',
    'filter', 'submodule-prefix', 'recurse-submodules-default'], short: 'jo', flags: ['recurse-submodules'] },
  pull: { long: ['cleanup', 'strategy', 'strategy-option', 'upload-pack', 'depth', 'shallow-since', 'shallow-exclude', 'deepen', 'refmap',
    'server-option', 'negotiation-tip'], short: 'sXo', flags: ['recurse-submodules'] },
  push: { long: ['repo', 'recurse-submodules', 'receive-pack', 'exec', 'push-option'], short: 'o' },
  'ls-remote': { long: ['upload-pack', 'exec', 'sort', 'server-option'], short: 'o' },
  archive: { long: ['format', 'prefix', 'add-file', 'add-virtual-file', 'output', 'remote', 'exec', 'mtime'], short: 'o' },
});

/**
 * A git command's words that are not options or their values (`operands`), and its options with their values (`opts`,
 * [name, value]). git takes any start of a long option that fits only one: a start that fits one with a value takes the next
 * word (when it fits more than one, git refuses the command). `--no-…` takes none.
 */
function gitArgs(args, values) {
  const operands = [];
  const opts = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { operands.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = (eq < 0 ? a : a.slice(0, eq)).slice(2);
      const takes = values.long.includes(name) || (!(values.flags ?? []).includes(name) && values.long.some(n => n.startsWith(name)));
      if (eq >= 0) opts.push([name, a.slice(eq + 1)]);
      else if (name && !name.startsWith('no-') && takes) { opts.push([name, args[k + 1]]); k++; }
      else opts.push([name, undefined]);
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (!values.short.includes(a[j])) continue;
        if (j === a.length - 1) { opts.push([a[j], args[k + 1]]); k++; } else opts.push([a[j], a.slice(j + 1)]);
        break;
      }
      continue;
    }
    operands.push(a);
  }
  return { operands, opts };
}

/** A word that is an address wherever it stands: a web address, user@host:path, or a file: address. A refspec is never one. */
const ADDRESS = /^([a-z][a-z0-9+.-]*:\/\/|[^@/:\s]+@[^/:\s]+:|file:)/i;

/**
 * Another repository, reached from the agent's: a git command that names an address (a web address, ssh, user@host:path,
 * host:path, file:) or a folder where git takes a repository, instead of one of the repository's own remotes
 * (configuredRemotes). git would reach it with the person's saved sign-in, or read and write another repository on this
 * computer. A remote's name decides only when the repository's settings name it: git takes any other word for a path.
 * - fetch, pull, push, ls-remote: the repository is the first other word (all of them after fetch --multiple), or push's
 *   --repo; an address among the other words asks too, wherever it stands. Naming none uses the repository's own remotes.
 * - clone, send-pack and fetch-pack always name an address or a folder; so do `submodule add`, `remote add` and
 *   `remote set-url`. `submodule init`, `sync`, `set-url` and `update` take addresses from .gitmodules, a file the agent can
 *   change: `update` with --init, and a plain `update` too when the settings make every submodule active (submodule.active,
 *   as `git clone --recurse-submodules` leaves it), which then clones a submodule only .gitmodules names.
 * - `remote show` and `remote prune` with a name that is not a remote's, `archive --remote`, and request-pull's address.
 */
function gitNetwork(sub, args, base) {
  const far = (say, reason = R.gitNetwork) => ({ ...ask(reason, undefined, 'reach another repository'), ...(say ? { say } : {}) });
  const own = r => r !== undefined && configuredRemotes(base).has(r);
  const first = args.find(a => !a.startsWith('-'));
  if (sub === 'clone') return far(); // narrate names what it downloads, and from where
  if (sub === 'send-pack' || sub === 'fetch-pack') return far('wants to reach another repository');
  if (sub === 'submodule') {
    if (first === 'add') return far('wants to add a submodule from another repository');
    if (first === 'init' || first === 'sync' || first === 'set-url') return far('wants to set up submodules from the addresses in .gitmodules', R.gitSubmodules);
    if (first === 'update') {
      return far(args.some(a => longIs(a, ['init'])) ? 'wants to download submodules from the addresses in .gitmodules' : 'wants to download submodules', R.gitSubmodules);
    }
    return null;
  }
  if (sub === 'remote') {
    if (first === 'add') return far('wants to add a remote');
    if (first === 'set-url') return far('wants to change where a remote points');
    if (first === 'show' || first === 'prune') return args.filter(a => !a.startsWith('-')).slice(1).every(own) ? null : far();
    return null;
  }
  if (sub === 'request-pull') return own(args.filter(a => !a.startsWith('-'))[1]) ? null : far('wants to reach another repository');
  if (!Object.hasOwn(NET_VALUES, sub)) return null;
  const { operands, opts } = gitArgs(args, NET_VALUES[sub]);
  if (sub === 'archive') {
    const remote = opts.filter(([n]) => n.length >= 2 && 'remote'.startsWith(n));
    return remote.every(([, v]) => own(v)) ? null : far('wants to download an archive from another repository');
  }
  const multiple = sub === 'fetch' && args.some(a => /^--mu/.test(a) || /^-[^-]*m/.test(a));
  const repos = multiple ? operands : operands.slice(0, 1);
  if (sub === 'push') repos.push(...opts.filter(([n]) => n.length >= 1 && 'repo'.startsWith(n)).map(([, v]) => v));
  if (!repos.every(own)) return far();
  if (args.some(a => ADDRESS.test(a) || ADDRESS.test(a.slice(a.indexOf('=') + 1)))) return far();
  return null;
}

/** Set by decide() for one decision: the repository's own remotes, by the agent's folder, so its settings are read once. */
let remotesMemo = null;

/**
 * The names of the repository's own remotes: the [remote "<name>"] sections of its settings (for a worktree, the main
 * repository's, and the worktree's own config.worktree), and git's oldest forms, a file in remotes/ or branches/. Read from
 * the records git uses from the agent's folder (gitDirsOf). A remote set only in the person's own settings (~/.gitconfig)
 * or in an included file is not counted, so naming it asks.
 */
function configuredRemotes(base) {
  if (remotesMemo?.has(base)) return remotesMemo.get(base);
  const names = new Set();
  const dirs = gitDirsOf(base);
  if (dirs) {
    for (const file of [dirs.common + '/config', dirs.git + '/config.worktree']) {
      const text = readText(file);
      if (text === null) continue;
      for (const m of text.matchAll(/^[ \t]*\[[ \t]*remote[ \t]+"((?:[^"\\\n]|\\.)*)"[ \t]*\]/gim)) names.add(m[1].replace(/\\(.)/g, '$1'));
      for (const m of text.matchAll(/^[ \t]*\[[ \t]*remote\.([^\]\s]+)[ \t]*\]/gim)) names.add(m[1].toLowerCase()); // the old [remote.name]
    }
    for (const sub of ['remotes', 'branches']) {
      try { for (const n of fs.readdirSync(dirs.common + '/' + sub)) names.add(n); } catch { /* none */ }
    }
  }
  remotesMemo?.set(base, names);
  return names;
}

/** The records git uses from `dir`: the nearest .git on the way up, a folder or a file that names one, and the folder they share (commondir). */
function gitDirsOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    let st = null;
    try { st = fs.statSync(d + '/.git'); } catch { /* not here */ }
    if (st) {
      let git = d + '/.git';
      if (st.isFile()) {
        const m = /^gitdir:[ \t]*(.*?)[ \t]*$/m.exec(readText(git) ?? '');
        if (!m || !m[1]) return null;
        git = path.resolve(d, m[1]);
      }
      const common = (readText(git + '/commondir') ?? '').trim();
      return { git, common: common ? path.resolve(git, common) : git };
    }
    if (path.dirname(d) === d) return null;
  }
}

/** A file's text, or null when it cannot be read. */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** git config's long options (git 2.39 to 2.47), to read an abbreviation as git does. */
const CONFIG_OPTS = ['global', 'system', 'local', 'worktree', 'file', 'blob', 'get', 'get-all', 'get-regexp', 'get-urlmatch', 'replace-all', 'add',
  'unset', 'unset-all', 'rename-section', 'remove-section', 'list', 'fixed-value', 'edit', 'get-color', 'get-colorbool', 'type', 'bool', 'int',
  'bool-or-int', 'bool-or-str', 'path', 'expiry-date', 'no-type', 'null', 'name-only', 'includes', 'show-origin', 'show-scope', 'default', 'comment',
  'value', 'url', 'all', 'regexp', 'append'];

/**
 * Whether a `git config` that only reads reaches settings outside the agent's folder: the person's own or the computer's
 * (--global, --system), or a list or search across every scope (--list, -l, --get-regexp, --show-origin, --show-scope,
 * git 2.46's `list` and `get --regexp`, --get-urlmatch with a section and no key) unless --local, --worktree, --file or --blob
 * keeps it to one file, and --includes does not reach past it. One setting read by its name stays a plain read: git uses it
 * here anyway. A file named with --file is judged as a place, as for any command.
 */
function configReadsOutside(args) {
  let wide = false;
  let scoped = false;
  let widen = false;
  let lists = false;
  let url = false;
  const names = [];
  // An option's meanings: its exact name, or every long option it is the start of (git refuses one that fits several).
  const means = name => (CONFIG_OPTS.includes(name) ? [name] : CONFIG_OPTS.filter(n => n.startsWith(name)));
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') { names.push(...args.slice(k + 1)); break; }
    if (a.startsWith('--')) {
      const m = means(a.slice(2).split('=')[0]);
      if (m.some(n => n === 'global' || n === 'system')) wide = true;
      if (m.some(n => ['list', 'get-regexp', 'show-origin', 'show-scope', 'regexp'].includes(n))) lists = true;
      if (m.some(n => n === 'includes')) widen = true;
      if (m.some(n => n === 'get-urlmatch' || n === 'url')) url = true;
      if (m.length === 1 && ['local', 'worktree', 'file', 'blob'].includes(m[0])) scoped = true;
      if (!a.includes('=') && m.length === 1 && ['file', 'blob', 'type', 'default', 'comment', 'value', 'url'].includes(m[0])) k++;
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        if (a[j] === 'l') lists = true;
        if (a[j] === 'f') { scoped = true; if (j === a.length - 1) k++; break; } // -f <file>: the rest is its value
      }
      continue;
    }
    names.push(a);
  }
  if (names[0] === 'list') lists = true;
  const name = names[0] === 'get' || names[0] === 'list' ? names[1] : names[0];
  if (url && typeof name === 'string' && !name.includes('.')) lists = true; // a section alone: every key in it
  return wide || (lists && (!scoped || widen));
}

/** `gh auth token`, `gh auth status --show-token` (-t) and `gh auth git-credential` show the person's GitHub sign-in. */
function ghShowsSignIn(argv) {
  const plainWords = argv.slice(1).filter(a => !a.startsWith('-'));
  if (plainWords[0] !== 'auth') return false;
  if (plainWords.includes('token') || plainWords.includes('git-credential')) return true;
  return plainWords.includes('status') && argv.some(a => /^--show-token(=|$)/.test(a) || /^-[^-]*t/.test(a));
}

/**
 * The words of a git command that are not read piece by piece: the text of a message (-m, --message) for the commands
 * that take one, which names no place (`text`, indexes into `args`), and web addresses (`addresses`, index -> the
 * address). An address is checked only as a whole: taken apart at its "//" it would look like a path from the top of
 * the disk, but as a path it is read from the agent's folder ("https:" would be a folder there), so only `..` or a link
 * could take it out.
 */
function gitTextWords(sub, args) {
  const skip = new Set();
  const addresses = new Map();
  const flags = Object.hasOwn(MESSAGE_FLAGS, sub) ? MESSAGE_FLAGS[sub] : null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') break;
    const value = a.startsWith('--') && a.includes('=') ? a.slice(a.indexOf('=') + 1) : a;
    if (WEB_ADDRESS.test(value)) { addresses.set(k, value); continue; }
    if (flags === null) continue;
    if (a.startsWith('--')) {
      if (!longIs(a, ['message']) || a.slice(2).split('=')[0].length < 3) continue;
      skip.add(k);
      if (!a.includes('=')) skip.add(k + 1);
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    // A word of short options: letters that take no value, then m and the message, here or in the next word.
    let j = 1;
    while (j < a.length && flags.includes(a[j])) j++;
    if (a[j] !== 'm') continue;
    skip.add(k);
    if (j === a.length - 1) skip.add(k + 1);
  }
  return { text: skip, addresses };
}

/** The indexes of what diff's --output option writes to: its value, given with = or as the next word. */
function outputWords(args) {
  const out = new Set();
  args.forEach((a, k) => {
    if (!a.startsWith('--') || !longIs(a, ['output'])) return; // git takes --outp for --output, and so on
    out.add(k);
    if (!a.includes('=')) out.add(k + 1);
  });
  return out;
}

/**
 * null when every word of a git command stays in the agent's folder; otherwise an ask. Each word is read from the agent's
 * folder and from any -C folder. A command that only reads (`read`) may name what is not there, as a search pattern can.
 * A command that can write may not name a place outside the folder even when nothing is there yet (git would make it,
 * as `clone <address> /tmp/x` does), nor one in .git or .claude; neither may what --output writes to. Messages and web
 * addresses name no place.
 */
function gitWords(sub, args, words, from, base, also, read) {
  const { text, addresses } = gitTextWords(sub, args);
  const outputs = read ? outputWords(args) : new Set();
  for (let k = 0; k < words.length; k++) {
    if (text.has(k)) continue;
    const w = words[k];
    if (w.glob && globClimbs(w.text)) return ask(R.readOutside, 'outside');
    const writes = !read || outputs.has(k);
    for (const piece of addresses.has(k) ? [addresses.get(k)] : readPieces(w)) {
      for (const f of from) {
        const v = writes ? gitWriteCheck(piece, f, base, outputs.has(k)) : readCheck(piece, base, also, true, f);
        if (v) return v;
      }
    }
  }
  return null;
}

/**
 * null when git writing at `p` (read from `from`) would stay in the agent's folder, out of .git and .claude; otherwise
 * an ask. `output`: the place is a file that --output writes, which the ask then says.
 */
function gitWriteCheck(p, from, base, output) {
  if (p === '/dev/null') return null;
  const r = resolveReal(p, from);
  if (!r.ok) return ask(r.reason, 'mayLeave', output ? 'write to a file' : undefined);
  const place = placeOf(r.real, base);
  if (place === 'inside' || place === 'cwd') return null;
  return output ? ask(R.writesFile, place, 'write to a file') : ask(GIT_PLACE[place], place);
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
    if (argv[scriptAt] !== '--') return ask(R.testsExtra, undefined, RUN);
    return scriptArgs(words.slice(scriptAt + 1), base);
  }
  if (c0 === 'make' && c1 === 'test') return n === 2 ? allow(R.tests) : ask(R.testsExtra, undefined, RUN);

  if (c0 === 'pytest') return runnerArgs(words.slice(1), base, PYTEST_BAD);
  if ((c0 === 'python' || c0 === 'python3') && c1 === '-m' && c2 === 'pytest') return runnerArgs(words.slice(3), base, PYTEST_BAD);
  if (c0 === 'go' && c1 === 'test') return runnerArgs(words.slice(2), base, GO_BAD);
  if (c0 === 'cargo' && c1 === 'test') return runnerArgs(words.slice(2), base, CARGO_BAD);
  if (c0 === 'npx' && (c1 === 'jest' || c1 === 'vitest')) return runnerArgs(words.slice(2), base, null);

  if (c0 === 'node') {
    if (c1 === '--test') return judgeNodeTest(words, base);
    if (!c1 || c1.startsWith('-')) return ask(R.nodeOption, undefined, 'run a script'); // -e, -p, --import, a REPL...
    if (words[1].glob) return ask(R.globOption, undefined, RUN);
    const r = resolveReal(c1, base);
    if (!r.ok) return ask(r.reason);
    const where = placeOf(r.real, base);
    if (where === 'git') return ask(R.nodeGit, 'git');
    if (where === 'claude') return ask(R.nodeClaude, 'claude');
    if (where === 'outside') return ask(R.nodeOutside, 'outside');
    // It must be a file that is there: "node inspect /tmp/x.js" names no file but runs one.
    if (where !== 'inside' || !r.exists || !fs.statSync(r.real).isFile()) return ask(R.nodeMissing);
    return allow(R.nodeInside); // arguments after the script belong to the script
  }
  return null;
}

/**
 * `node --test [options] [files]`. Each option must be on NODE_TEST_OPTS, with a value that fits, given
 * as --opt=value or as the next word. The rest are test files, which must be inside the folder.
 */
function judgeNodeTest(words, base) {
  const files = [];
  for (let k = 2; k < words.length; k++) {
    const w = words[k];
    if (w.globLead) return ask(R.globOption, undefined, RUN); // a wildcard could turn file names into options
    if (!w.text.startsWith('-')) { files.push(w); continue; }
    const eq = w.text.indexOf('=');
    const name = eq < 0 ? w.text : w.text.slice(0, eq);
    if (!Object.hasOwn(NODE_TEST_OPTS, name)) return ask(R.nodeOption, undefined, 'run a script');
    const v = nodeTestOption(name, eq < 0 ? undefined : w.text.slice(eq + 1), words[k + 1], base);
    if (v) return v;
    if (eq < 0 && NODE_TEST_OPTS[name] !== null) k++; // the value was the next word
  }
  return runnerArgs(files, base, null);
}

/**
 * null when one option from NODE_TEST_OPTS has a value that fits (`value` given with "=", or else the next word).
 * A next word that starts with "-" asks: node refuses it, but another program would read it as an option of
 * its own (mocha's `-r x` after `--test-name-pattern`), and it would be skipped here as a value.
 */
function nodeTestOption(name, value, next, base) {
  const kind = NODE_TEST_OPTS[name];
  if (kind === null) return value === undefined ? null : ask(R.nodeValue, undefined, RUN);
  if (value === undefined) {
    if (!next || next.text.startsWith('-')) return ask(R.nodeValue, undefined, RUN);
    if (next.glob) return ask(R.globOption, undefined, RUN);
    value = next.text;
  }
  return nodeTestValue(kind, value, base);
}

/** null when the value fits its kind; otherwise an ask. */
function nodeTestValue(kind, value, base) {
  switch (kind) {
    case 'text': return null;
    case 'number': return /^\d+(\.\d+)?$/.test(value) ? null : ask(R.nodeValue, undefined, RUN);
    case 'shard': return /^\d+\/\d+$/.test(value) ? null : ask(R.nodeValue, undefined, RUN);
    case 'isolation': return value === 'process' || value === 'none' ? null : ask(R.nodeValue, undefined, RUN);
    case 'reporter': return NODE_REPORTERS.has(value) ? null : ask(R.nodeOption, undefined, 'run a script'); // anything else is loaded as code
    case 'destination': if (value === 'stdout' || value === 'stderr') return null; // otherwise a file it writes
    // falls through
    case 'file': {
      const r = resolveReal(value, base);
      if (!r.ok) return ask(R.testsOutside, 'usesOutside');
      const where = placeOf(r.real, base);
      if (where === 'git') return ask(R.testsGit, 'usesGit');
      if (where === 'claude') return ask(R.testsClaude, 'usesClaude');
      if (where !== 'inside') return ask(R.testsOutside, 'usesOutside');
      return r.exists && linkedFile(r.real) ? ask(R.fileLinked, 'usesLinked') : null;
    }
    default: return ask(R.nodeValue, undefined, RUN);
  }
}

/**
 * The words after `--` of a package script (`npm test -- …`). npm hands them to the script, which can be any
 * program and is often `node --test`, so on top of the usual runner checks they follow node's rules: an option
 * that loads code asks wherever it appears, and node's own test options must fit as for `node --test`.
 */
function scriptArgs(words, base) {
  for (let k = 0; k < words.length; k++) {
    const t = words[k].text;
    if (!t.startsWith('-') || t === '-' || t === '--') continue;
    const eq = t.indexOf('=');
    const name = (eq < 0 ? t : t.slice(0, eq)).replace(/_/g, '-'); // node reads --foo_bar as --foo-bar
    if (!name.startsWith('--')) {
      if (shortHas(name, NODE_CODE_SHORT)) return ask(R.nodeOption, undefined, 'run a script');
      continue;
    }
    if (NODE_CODE_OPTS.has(name)) return ask(R.nodeOption, undefined, 'run a script');
    if (!/^--(experimental-)?test(-|$)/.test(name)) continue; // another program's option, such as jest's --watch=false
    if (!Object.hasOwn(NODE_TEST_OPTS, name)) return ask(R.nodeOption, undefined, 'run a script');
    const v = nodeTestOption(name, eq < 0 ? undefined : t.slice(eq + 1), words[k + 1], base);
    if (v) return v;
    if (eq < 0 && NODE_TEST_OPTS[name] !== null) k++;
  }
  return runnerArgs(words, base, null);
}

// Test-runner options that delete folders, upload results or wrap the tests in another program. Each returns
// what the option does in plain words, and whether its value names the folder it deletes.
const PYTEST_BAD = a => (longIs(a, ['basetemp']) ? { does: 'delete files', named: true }
  : longIs(a, ['pastebin']) ? { does: 'send data to the internet' } : null);
const GO_BAD = a => (/^--?(exec|toolexec)(=|$)/.test(a) ? { does: 'run another program' } : null);
const CARGO_BAD = a => (/^--config(=|$)/.test(a) ? { does: 'run another program' } : a.startsWith('-Z') ? { does: RUN } : null);

/**
 * An address a runner could load code from: data:, file:, http(s): or blob:, at the start of a word, of a
 * value (after "=" or ","), or after a short option. Node ignores the case of the scheme, spaces before it
 * and tabs or new lines inside it, so this does too.
 */
function codeAddress(text) {
  return /(^|[=,]|^-[A-Za-z]+)[\x00-\x20]*(data|file|https?|blob):/i.test(text.replace(/[\t\n\r]/g, ''));
}

/**
 * Arguments of a test runner: no option from the runner's bad list, no wildcard that could become an
 * option, no address code could be loaded from, and nothing that points outside the agent's folder, or
 * into its .git or .claude folders (extra strictness: a config, plugin or output path there would run or
 * write things elsewhere, or change git's records or Claude Code's settings), or at a hard-linked file.
 */
function runnerArgs(words, base, bad) {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (w.globLead) return ask(R.globOption, undefined, RUN);
    const b = bad ? bad(w.text) : null;
    if (b) {
      const value = w.text.includes('=') ? w.text.slice(w.text.indexOf('=') + 1) : words[k + 1]?.text;
      return ask(R.testsOption, b.named ? placeWhere(value, base) : undefined, b.does);
    }
    if (codeAddress(w.text)) return ask(R.codeAddress, undefined, 'run a script');
    for (const piece of pathPieces(w)) {
      const r = resolveReal(piece, base);
      if (!r.ok) return ask(R.testsOutside, 'usesOutside');
      const where = placeOf(r.real, base);
      if (where === 'git') return ask(R.testsGit, 'usesGit');
      if (where === 'claude') return ask(R.testsClaude, 'usesClaude');
      if (where === 'outside') return ask(R.testsOutside, 'usesOutside');
      if (r.exists && linkedFile(r.real)) return ask(R.fileLinked, 'usesLinked');
    }
  }
  return allow(R.tests);
}

/**
 * Every piece of a word that could name a path: the word, `--opt=<value>`, `-c<value>`, `a:b,c`. As in readPieces, a
 * piece that starts with "-" but has a "/" is a path too (`--outputFile=--/../x`).
 */
function pathPieces(w) {
  let t = w.text;
  if (w.glob) t = t.slice(0, t.search(/[*?[^#]/)); // only the literal text before a wildcard is known
  const out = new Set();
  const add = s => { if (s && (!s.startsWith('-') || s.includes('/'))) out.add(s); };
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
