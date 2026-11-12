// One real acceptance run of Workbench with Claude Code. IT SPENDS REAL MONEY: at most $0.50 (the --budget it
// passes) on the account Claude Code is logged in to, with the haiku model.
//
//   node scripts/accept-real.mjs <throwaway git repo> [screenshots folder] [--keep] [--claude <path>]
//
// The repository needs a branch checked out and a committed workbench.json with a check and a rule, for example:
//   { "checks": [{ "name": "tests", "run": "node test.mjs" }], "rules": [{ "say": "Do not change greet.js", "paths": ["greet.js"] }]
// Set git's user.name and user.email first: without them Workbench cannot merge, and the merge step then only checks
// that it says so (and fails, since the merge itself was not tried).
// It drives the product only through its HTTP API, as the page does, and prints PASS or FAIL for each point:
//   a helper appears -> the agent's `touch agent-was-here-<run>.txt` waits for an OK -> Allow releases it ->
//   the agent ends "done and checked" with one new file and the rule kept -> its changes show exactly that file ->
//   Merge asks first, then joins its work into your branch with a merge commit -> Throw it away asks first, then
//   deletes its folder and branch and keeps a hidden copy in git -> after stopping, nothing is left running.
// Asks are answered one by one: the touch is allowed, and so is a helper's command that only lists or reads files
// (helperAskMayRun: find, ls, cat, head, tail, wc, stat or git ls-files, piped at most into sort, head, tail, wc or
// uniq, with nothing that writes, deletes, redirects, substitutes or chains, and an ask whose sentence says no more);
// anything else is refused and reported, and fails the step "nothing else needed an answer". Each run uses its own
// file name, so the merge it leaves on your branch never gets in the way of the next run. Unless --keep is given, it
// removes what is left of the agent's folder, its branch and the hidden copy at the end; the merge commit stays on your
// branch. For the record, it also prints the version, permission mode and tools Claude Code offered the agent (from
// Workbench's --verbose log).
// Claude Code is found the way Workbench finds it: --claude, WORKBENCH_CLAUDE_BIN, `claude` on the PATH, then the
// VS Code extension. It refuses to run inside a Workbench agent, as Workbench itself does.
// Dry run without spending (FAKE_CLAUDE_ROOT_BASH may hold anything: this script puts its own `touch` there):
//   WORKBENCH_CLAUDE_BIN=test/helpers/claude-fake.mjs FAKE_CLAUDE_FIXTURE=claude-subagent-run.jsonl
//   FAKE_CLAUDE_HOOKS=1 FAKE_CLAUDE_ROOT_BASH=1 node scripts/accept-real.mjs <repo>
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, rmdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitWords } from '../src/core/policy.mjs';

// ---------------------------------------------------------------- the helper rule
// An Allow here lets the person's own Claude Code run the command; a refusal only fails one step of the run. So a
// helper's held command is allowed only when it can do nothing but list or read files, and anything this rule does not
// know is refused.

/** Refused anywhere, even quoted: chaining, redirection, substitution, grouping, and control characters (tab too). */
const HELPER_NEVER = /[;&`$(){}<>\x00-\x1f\x7f-\x9f\u2028\u2029]/;
/** What a helper's command may start with: these only list or read, whatever their options. */
const HELPER_FIRST = new Set(['find', 'ls', 'cat', 'head', 'tail', 'wc', 'stat']);
/**
 * find's words that delete, write a file or run another program, in GNU find and in the bfs Claude Code puts in its
 * place (the policy's FIND_BAD lists them one by one). Refused by family, so a variant (-fprintx, -okdir) is refused too.
 */
const FIND_ACTS = /^--?(exec|ok|delete|rm|fprint|fls)/;
/** git ls-files: the switches that only choose what is listed and how. Nothing may come between git and ls-files. */
const LS_FILES_SHORT = /^-[cdmoiskutvfz]+$/;
const LS_FILES_LONG = new Set(['--cached', '--deleted', '--modified', '--others', '--ignored', '--stage', '--unmerged', '--killed',
  '--directory', '--no-empty-directory', '--exclude-standard', '--full-name', '--deduplicate', '--error-unmatch', '--eol']);
/** head and tail in a pipe: a count of lines or bytes, and no file of their own. */
const countOnly = (words) => {
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (/^-\d+$|^-[nc][+-]?\d+$|^--(lines|bytes)=[+-]?\d+$/.test(w)) continue;
    if ((w === '-n' || w === '-c') && /^[+-]?\d+$/.test(words[k + 1] ?? '')) { k += 1; continue; }
    return false;
  }
  return true;
};
/**
 * What a listing may be piped into, with what: filters that read only the pipe and write only to it. No file names
 * (uniq writes its second one), and no option that takes a value (sort -o writes it, --compress-program runs it).
 */
const HELPER_FILTERS = {
  sort: (words) => words.every((w) => /^-[bdfghiMnRrsuVz]+$/.test(w)),
  uniq: (words) => words.every((w) => /^-[cdiu]+$/.test(w)),
  wc: (words) => words.every((w) => /^-[clmw]+$/.test(w)),
  head: countOnly,
  tail: countOnly,
};

/**
 * The command cut at each "|" outside quotes. null when it has a backslash anywhere but inside single quotes (an
 * escape can hide any character), an unquoted "~" (the shell puts a home folder there, after "=" too), a word that
 * starts with an unquoted "=" (zsh puts a program's path there), a quote left open, or an empty part ("||", a "|" at
 * either end).
 */
function pipeParts(text) {
  const parts = [];
  let cur = '', quote = null, wordStart = true;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') return null;
      cur += ch;
      continue;
    }
    if (ch === '|') { parts.push(cur); cur = ''; wordStart = true; continue; }
    if (ch === '\\' || ch === '~' || (ch === '=' && wordStart)) return null;
    if (ch === "'" || ch === '"') quote = ch;
    cur += ch;
    wordStart = ch === ' ';
  }
  if (quote) return null;
  parts.push(cur);
  return parts.every((p) => p.trim()) ? parts : null;
}

/**
 * Whether this script answers "Allow" for a helper's held command (the ask's detail): one of HELPER_FIRST (find without
 * its acting words) or `git ls-files`, piped into nothing or into HELPER_FILTERS only, with no unquoted wildcard (a file
 * an agent named "-delete" would become a word of the command). Nothing that writes, deletes, redirects, substitutes or
 * chains. Words are split as the policy splits them, quotes taken off, so '-delete' and -del""ete are -delete. Pure.
 */
export function helperMayRun(command) {
  const text = String(command ?? '').trim();
  if (!text || HELPER_NEVER.test(text)) return false;
  const parts = pipeParts(text);
  if (!parts) return false;
  const split = parts.map((p) => splitWords(p));
  if (split.some((s) => s.error || !s.words.length || s.words.some((w) => w.glob))) return false;
  const [[name, ...words], ...filters] = split.map((s) => s.words.map((w) => w.text));
  if (name === 'git') {
    if (words[0] !== 'ls-files') return false;
    const end = words.indexOf('--'); // after it, only names of files to list
    if (!words.slice(1, end < 0 ? undefined : end).every((w) => !w.startsWith('-') || LS_FILES_SHORT.test(w) || LS_FILES_LONG.has(w))) return false;
  } else if (!HELPER_FIRST.has(name) || (name === 'find' && words.some((w) => FIND_ACTS.test(w)))) {
    return false;
  }
  return filters.every(([filter, ...args]) => Object.hasOwn(HELPER_FILTERS, filter) && HELPER_FILTERS[filter](args));
}

/**
 * A held ask carries no tool name, and the detail of a Write, Edit or NotebookEdit ask is only its path, which can read
 * like a command ("cat a/../../x" creates x two folders up). So an ask whose sentence (Workbench's own words, from the
 * policy) says the call creates, changes, writes, deletes, sends, opens or uses something is refused, whatever its
 * detail says. Listing and reading say "look at the files", "read a file", "check what changed" or "run a command".
 */
const ASK_DOES_MORE = /\bwants to (create|change|write|delete|move|copy|install|send|connect|download|push|publish|save|open|keep|use|stop|search the web|run another program|run a script)\b/i;

/** Whether this script answers "Allow" for a helper's held permission ask, { sentence, detail }. Pure. */
export function helperAskMayRun(ask) {
  return !ASK_DOES_MORE.test(String(ask?.sentence ?? '')) && helperMayRun(ask?.detail);
}

// ---------------------------------------------------------------- the run
async function main() {
  if (process.env.WORKBENCH_AGENT_ID !== undefined) {
    console.error('Workbench is running inside an agent. It will not start real agents from there.');
    process.exit(2);
  }

  const USAGE = 'Usage: node scripts/accept-real.mjs <throwaway git repo> [screenshots folder] [--keep] [--claude <path>]';
  const argv = process.argv.slice(2);
  let keep = false;
  let claudePath = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') keep = true;
    else if (a === '--claude') {
      const v = argv[i + 1];
      claudePath = v != null && !v.startsWith('--') ? v : ''; // a missing path is a usage error, never the next option
      if (claudePath) i += 1;
    }
    else if (a.startsWith('--claude=')) claudePath = a.slice('--claude='.length);
    else positional.push(a);
  }
  const [repoArg, shotsArg] = positional;
  if (!repoArg || claudePath === '' || positional.length > 2) { console.error(USAGE); process.exit(2); }
  const repo = realpathSync(repoArg);
  const shots = shotsArg ? path.resolve(shotsArg) : null;
  if (shots) mkdirSync(shots, { recursive: true });

  const BIN = fileURLToPath(new URL('../bin/workbench.mjs', import.meta.url));
  const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const RUN = randomBytes(3).toString('hex');
  const MARKER = `agent-was-here-${RUN}.txt`; // its own name for each run: an earlier run's merge already holds the last one
  const MORE = `more-work-${RUN}.txt`; // written into the agent's folder after the merge, so the throw-away has work to keep
  const BUDGET = 0.5;
  const TASK = 'Use the Agent tool to launch one Explore helper that lists the files in this repository and says what greet.js does. '
    + `When it has finished, run the shell command \`touch ${MARKER}\` with Bash. Then finish with one short sentence.`;

  const t0 = Date.now();
  const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); log(ok ? 'PASS' : 'FAIL', name, detail ? `(${detail})` : ''); };
  /** Processes whose command line holds this text. No shell: pgrep leaves itself out. */
  const processesWith = (text) => { try { return execFileSync('pgrep', ['-f', text]).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
  /** git in a folder, with an argument array. */
  const gitIn = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const git = (...args) => gitIn(repo, ...args);
  const gitOr = (fallback, ...args) => { try { return git(...args); } catch { return fallback; } };
  const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };

  // Without both, Workbench cannot make the merge commit (it never uses a name git guesses).
  const identity = !!(gitOr('', 'config', '--get', 'user.name') && gitOr('', 'config', '--get', 'user.email'));
  const into = gitOr(null, 'symbolic-ref', '--short', '-q', 'HEAD');
  if (!identity) log(`Git does not know your name and email in ${repo}: the merge step will only check that Workbench says so.`);
  if (!into) log(`${repo} is not on a branch: the merge step will be refused.`);

  const childEnv = { ...process.env };
  if (childEnv.FAKE_CLAUDE_ROOT_BASH !== undefined) childEnv.FAKE_CLAUDE_ROOT_BASH = `touch ${MARKER}`; // a dry run
  // --verbose: Workbench then logs the version, permission mode and tools Claude Code offers the agent (printed at the end).
  const eng = spawn(process.execPath, [BIN, '--repo', repo, '--no-open', '--port', '0', '--budget', String(BUDGET), '--model', 'haiku', '--verbose', ...(claudePath ? ['--claude', claudePath] : [])], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let url = null;
  eng.stdout.on('data', (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?t=([0-9a-f]+)/.exec(out); if (m && !url) url = { base: m[1], t: m[2] }; });
  eng.stderr.on('data', (d) => { out += d; });
  const engExit = new Promise((r) => eng.on('exit', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !url; i++) await sleep(200);
  if (!url) { console.error('Workbench did not start:\n' + out); eng.kill('SIGINT'); process.exit(1); }
  log('Workbench is running.', out.split('\n').filter((l) => !l.startsWith('[workbench ') && /ready|spend|Git does not know/.test(l)).join(' | '));

  const H = { 'Content-Type': 'application/json', 'X-Workbench-Token': url.t };
  const post = async (p, b) => { const r = await fetch(url.base + p, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const get = async (p) => { const r = await fetch(url.base + p, { headers: H }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const agents = async () => (await get('/api/state')).body?.agents || [];
  const userData = mkdtempSync(path.join(tmpdir(), 'wb-chrome-'));
  const shot = (name, query) => {
    if (!shots) return;
    try {
      execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${userData}`, '--window-size=1440,900', '--force-device-scale-factor=2', '--virtual-time-budget=3000', `--screenshot=${path.join(shots, name + '.png')}`, `${url.base}/?t=${url.t}&static=1&still=1${query || ''}`], { stdio: 'ignore', timeout: 60_000 });
      log('screenshot', name + '.png');
    } catch (err) { log('screenshot failed:', name, err.message); }
  };

  const asked = await post('/api/command', { text: 'start an agent to ' + TASK });
  if (!asked.body?.confirm) { console.error('No confirm came back:', JSON.stringify(asked.body)); eng.kill('SIGINT'); process.exit(1); }
  const go = await post(`/api/confirm/${encodeURIComponent(asked.body.confirm.id)}`, { go: true });
  const rootId = go.body?.agentIds?.[0];
  if (!rootId) { console.error('The agent did not start:', JSON.stringify(go.body)); eng.kill('SIGINT'); process.exit(1); }
  log('Started:', go.body.reply);
  const view = async () => (await agents()).find((a) => a.id === rootId) || null;

  const answered = new Set();
  let sawHelper = false, shotHelper = false, touchHeld = false, touchAbsentWhileHeld = false, refused = 0;
  let sessionId = null, workspace = null, branch = null, last = '', final = null, merged = null;
  while (Date.now() - t0 < 300_000) {
    await sleep(1000);
    const all = await agents();
    const root = all.find((a) => a.id === rootId);
    if (!root) continue;
    sessionId = root.sessionId || sessionId;
    workspace = root.workspace || workspace;
    if (workspace && !branch) { try { branch = gitIn(workspace, 'symbolic-ref', '--short', '-q', 'HEAD'); } catch { /* not ready yet */ } }
    const line = all.map((a) => `${a.parentId ? '└ ' : ''}${a.name} [${a.state}] ${a.now || ''}`).join(' | ');
    if (line !== last) { log(line); last = line; }
    const helper = all.find((a) => a.parentId === rootId);
    if (helper && !sawHelper) { sawHelper = true; log('A helper appeared:', helper.name, `(${helper.helperType || 'helper'})`); }
    if (helper && helper.state === 'working' && !shotHelper) { shotHelper = true; shot('real-helper-working', '&pin=' + helper.id); }

    for (const a of all) {
      if (!a.ask || answered.has(a.ask.id) || a.rootId !== rootId) continue;
      answered.add(a.ask.id);
      log(`ASK (${a.ask.type}) from ${a.parentId ? 'the helper' : 'the agent'}: ${a.ask.sentence} | ${a.ask.detail || ''}`);
      let answer;
      if (a.ask.type === 'permission') {
        const detail = String(a.ask.detail || '').trim();
        if (!a.parentId && detail === `touch ${MARKER}`) {
          touchHeld = true;
          touchAbsentWhileHeld = !!workspace && !existsSync(path.join(workspace, MARKER));
          shot('real-needs-ok', '&pin=' + a.id);
          answer = 'Allow';
        } else if (a.parentId && helperAskMayRun(a.ask)) {
          answer = 'Allow';
        } else { answer = 'Deny'; refused++; }
      } else if (a.ask.type === 'question') {
        answer = 'Please carry on with the task as written.';
      } else {
        answer = 'Stop it';
      }
      const r = await post(`/api/agents/${a.id}/answer`, { askId: a.ask.id, answer });
      log(`  answered "${answer}":`, r.status, r.body?.reply || '');
    }

    if (['done_checked', 'done_claimed', 'checks_failed', 'failed', 'stopped'].includes(root.state) && !all.some((a) => a.rootId === rootId && a.ask)) {
      final = root;
      shot('real-done', '&pin=' + root.id);
      break;
    }
  }

  console.log('');
  if (!final) log('The agent did not finish within 5 minutes.');
  else log('FINAL', final.state, '| says:', final.says, '| files:', JSON.stringify(final.files && { changed: final.files.changed, list: final.files.list?.map((f) => f.path) }), '| checks:', JSON.stringify(final.checks), '| rules:', JSON.stringify(final.rules), '| approvals:', JSON.stringify(final.approvals), '| cost: $' + final.usage?.costUsd);
  check('a helper appeared in the tree', sawHelper);
  check(`\`touch ${MARKER}\` waited for an OK`, touchHeld && touchAbsentWhileHeld, touchHeld ? (touchAbsentWhileHeld ? 'and had not run' : 'but the file already existed') : 'never asked');
  check('Allow released it', touchHeld && workspace && existsSync(path.join(workspace, MARKER)));
  check('the agent ended done and checked', final?.state === 'done_checked', final?.state || 'not finished');
  check('the receipt shows exactly that one new file', final?.files?.changed === 1 && final.files.list?.[0]?.path === MARKER, JSON.stringify(final?.files?.list?.map((f) => f.path)));
  check('the rule was kept', final?.rules && Array.isArray(final.rules.broken) && final.rules.broken.length === 0, JSON.stringify(final?.rules));
  check(`it stayed within the $${BUDGET} limit`, final?.usage?.costUsd != null && final.usage.costUsd <= BUDGET, final?.usage?.costUsd != null ? '$' + final.usage.costUsd.toFixed(4) : 'unknown');
  check('nothing else needed an answer', refused === 0, refused ? `${refused} refused` : '');

  // ---- its changes, the merge and the throw-away, through the same routes the page uses
  if (final && workspace) {
    console.log('');
    const changes = await get(`/api/agents/${rootId}/changes`);
    const files = changes.body?.diff?.files || [];
    check('its changes show exactly that one new file', changes.body?.ok === true && files.length === 1 && files[0].path === MARKER && files[0].status === 'added',
      changes.body?.ok === false ? changes.body.reply : `${changes.status} ${JSON.stringify(files.map((f) => `${f.status} ${f.path}`))}`);

    const before = { head: gitOr(null, 'rev-parse', 'HEAD'), status: gitOr('', 'status', '--porcelain') };
    let v = await view();
    const proposed = await post(`/api/agents/${rootId}/merge`, { state: v?.state ?? null });
    const card = proposed.body?.confirm || null;
    let mergeReply = proposed.body?.reply || '';
    log('Merge:', proposed.status, mergeReply);
    if (card) {
      log(`  card: ${card.sentence} | ${card.detail || ''}`);
      check('Merge asks first', card.kind === 'merge' && card.yes === 'Merge' && card.no === 'Cancel' && String(card.sentence).startsWith(`Merge ${v?.name} into `), `${card.kind}: ${card.sentence}`);
      const done = await post(`/api/confirm/${encodeURIComponent(card.id)}`, { go: true });
      mergeReply = done.body?.reply || '';
      log('  answered "Merge":', done.status, mergeReply);
    }
    const head = gitOr(null, 'rev-parse', 'HEAD');
    if (identity) {
      const parents = head ? gitOr('', 'rev-list', '--parents', '-n', '1', head).split(' ').slice(1) : [];
      if (head && head !== before.head) merged = head;
      check(`its work was joined into ${into} with a merge commit`, !!card && head !== before.head && parents.length === 2 && parents[0] === before.head, mergeReply || JSON.stringify(proposed.body));
      check(`${MARKER} is in ${into} and in your folder`, head !== before.head && gitOk('cat-file', '-e', `${head}:${MARKER}`) && existsSync(path.join(repo, MARKER)));
      const workMsg = parents[1] ? gitOr('', 'log', '-1', '--format=%B', parents[1]) : '';
      const mergeMsg = head !== before.head ? gitOr('', 'log', '-1', '--format=%B', head) : '';
      check('both commits say which agent made them',
        workMsg.includes(`Workbench-Agent: ${rootId}`) && workMsg.includes('Workbench-Kind: work') && workMsg.includes('Co-authored-by: Claude <noreply@anthropic.com>')
          && mergeMsg.startsWith(`Merge ${v?.name}: `) && mergeMsg.includes(`Workbench-Agent: ${rootId}`) && mergeMsg.includes('Workbench-Kind: merge'),
        mergeMsg.split('\n')[0]);
      check('nothing else in your folder changed', gitOr(null, 'status', '--porcelain') === before.status);
      v = await view();
      check('Workbench shows it as merged', !!head && v?.work?.merged?.merge === head && !v.work.problem, JSON.stringify(v?.work?.merged || v?.work?.problem || null));
      const graph = await get('/api/git');
      const top = graph.body?.commits?.[0];
      check('the git screen has the merge at the top', top?.id === head && top.kind === 'merge' && top.agentId === rootId, top ? `${top.kind} ${String(top.id).slice(0, 7)} ${top.subject}` : `${graph.status} ${JSON.stringify(graph.body)}`);
    } else {
      check('without a git name and email, Merge is refused in plain words', /^Git does not know your name and email yet/.test(mergeReply) && head === before.head, mergeReply);
      check('the merge itself', false, `git has no user.name and user.email for ${repo}: set them, then run this again`);
    }

    console.log('');
    if (existsSync(workspace)) writeFileSync(path.join(workspace, MORE), 'Work that is thrown away.\n');
    v = await view();
    const asked2 = await post(`/api/agents/${rootId}/discard`, { state: v?.state ?? null });
    const dcard = asked2.body?.confirm || null;
    log('Throw it away:', asked2.status, asked2.body?.reply || '');
    check('Throw it away asks first', dcard?.kind === 'discard' && dcard.danger === true && dcard.yes === 'Throw it away' && dcard.no === 'Keep it',
      dcard ? `${dcard.sentence} | ${dcard.detail}` : JSON.stringify(asked2.body));
    if (dcard) {
      const done = await post(`/api/confirm/${encodeURIComponent(dcard.id)}`, { go: true });
      log('  answered "Throw it away":', done.status, done.body?.reply || '');
      check('its folder and branch are gone', !existsSync(workspace) && !!branch && !gitOk('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`), done.body?.reply);
      check('a hidden copy of its work is kept in git', gitOk('cat-file', '-e', `refs/workbench/discarded/${rootId}:${MORE}`), `refs/workbench/discarded/${rootId}`);
      v = await view();
      check('Workbench shows it as thrown away', !!v?.work?.thrownAway && v.work.folder === false, JSON.stringify(v?.work?.thrownAway || null));
    }
  }

  console.log('');
  const running = sessionId ? processesWith(sessionId) : [];
  log('Claude Code processes for this agent before stopping:', running.length ? running.join(' ') : 'none');
  eng.kill('SIGINT');
  const exit = await Promise.race([engExit, sleep(20_000).then(() => null)]);
  await sleep(1000);
  const left = sessionId ? processesWith(sessionId) : ['(no session id was seen)'];
  check('Workbench stopped cleanly', exit && exit.code === 0, JSON.stringify(exit));
  check('no Claude Code process was left running', left.length === 0, left.join(' '));

  if (!keep) {
    // Whatever the steps above left: the folder, the branch this run made, and the hidden copy. Never the merge.
    if (workspace && existsSync(workspace)) { try { git('worktree', 'remove', '--force', workspace); } catch { /* already gone */ } }
    try { git('worktree', 'prune'); } catch { /* ignore */ }
    if (branch && branch.startsWith('workbench/')) { try { git('branch', '-D', branch); } catch { /* already gone */ } }
    try { git('update-ref', '-d', `refs/workbench/discarded/${rootId}`); } catch { /* none */ }
    // Remove the folders Workbench made for it, only if nothing else is in them.
    if (workspace) {
      for (let d = path.dirname(workspace); d.startsWith(path.join(homedir(), '.workbench')); d = path.dirname(d)) {
        try { rmdirSync(d); } catch { break; }
      }
    }
  }
  // For the record (not a check): what Claude Code offered the agent, from Workbench's log.
  console.log('');
  const offered = out.split('\n').filter((l) => / offers \d+ tools: |turned off for its agents|runs this agent in permission mode/.test(l));
  log('What Claude Code offered the agent:', offered.length ? '' : 'Workbench logged nothing about it.');
  for (const l of offered) log(`  ${l.replace(/^\[workbench \w+\] claude [0-9a-f]+: /, '')}`);
  if (merged) log(`The merge commit ${merged.slice(0, 7)} stays on ${into} in ${repo}.`);
  rmSync(userData, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} passed.`);
  process.exit(failed ? 1 : 0);
}

// Only when started as a script: a test imports helperMayRun, and that must start nothing. Both paths are resolved, so
// a start through a link (/tmp on macOS) is still a start, never a run that silently does nothing.
const started = import.meta.main ?? (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (started) await main();
