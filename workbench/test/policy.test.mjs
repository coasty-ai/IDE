import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, splitWords } from '../src/core/policy.mjs';

// A real folder layout: the agent's folder ("work"), a folder outside it, and links between them.
// os.tmpdir() is under /var on macOS, which is itself a link to /private/var.
let T, cwd, outside, worktree;

before(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-policy-'));
  cwd = T + '/work';
  outside = T + '/outside';
  worktree = T + '/worktree';
  for (const d of [cwd + '/src', cwd + '/tests', cwd + '/test', cwd + '/.git/hooks', cwd + '/sub/.git', outside + '/dir', worktree]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['/test.mjs', '/src/existing.js', '/README.md', '/nb.ipynb']) fs.writeFileSync(cwd + f, 'x\n');
  fs.writeFileSync(outside + '/evil.mjs', '');
  fs.writeFileSync(outside + '/shared.txt', '');
  fs.writeFileSync(worktree + '/.git', 'gitdir: /somewhere/.git/worktrees/x\n'); // a worktree's .git is a file
  fs.symlinkSync(outside + '/dir', cwd + '/link');
  fs.symlinkSync(outside + '/nofile', cwd + '/dangling');
  fs.symlinkSync(outside + '/evil.mjs', cwd + '/evil-link.mjs');
  fs.symlinkSync(outside, cwd + '/tests/link-out');
  fs.linkSync(outside + '/shared.txt', cwd + '/hard.txt');
});

after(() => fs.rmSync(T, { recursive: true, force: true }));

const bash = (command, extraAllow) => ({ tool: 'Bash', input: { command }, extraAllow });

function check(rows, want) {
  const wrong = [];
  for (const row of rows) {
    const req = typeof row === 'function' ? row() : row;
    const d = decide({ cwd, ...req });
    // Every answer has the four fields, in plain words.
    assert.deepEqual(Object.keys(d).sort(), ['decision', 'detail', 'reason', 'sentence']);
    assert.ok(['allow', 'ask', 'deny'].includes(d.decision));
    assert.ok(typeof d.reason === 'string' && d.reason.length > 5 && !/undefined|null|\[object/.test(d.reason), d.reason);
    assert.equal(typeof d.sentence, 'string');
    assert.equal(typeof d.detail, 'string');
    if (d.decision !== want) wrong.push(`${JSON.stringify({ tool: req.tool, input: req.input, extraAllow: req.extraAllow, cwd: req.cwd })} -> ${d.decision}: ${d.reason}`);
  }
  assert.equal(wrong.length, 0, `expected ${want}:\n  ` + wrong.join('\n  '));
}

test('safe tools are allowed', () => {
  check(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput',
    'TaskStop', 'TodoWrite', 'Agent', 'Task', 'Monitor', 'SendMessage', 'Skill', 'WebSearch']
    .map(tool => ({ tool, input: { file_path: '/etc/passwd', pattern: 'x', query: 'x' } })), 'allow');
});

test('web pages, outside services and unknown tools ask', () => {
  check([
    { tool: 'WebFetch', input: { url: 'https://example.com' } },
    { tool: 'mcp__slack__send_message', input: { text: 'hi' } },
    { tool: 'mcp__plugin_slack_slack__slack_send_message', input: {} },
    { tool: 'KillShell', input: {} },
    { tool: 'FooTool', input: {} },
    { tool: 'read', input: { file_path: '/etc/passwd' } }, // tool names are exact
    { tool: undefined, input: {} },
    { tool: '', input: {} },
    { tool: 42, input: {} },
  ], 'ask');
});

test('file changes inside the folder are allowed', () => {
  check([
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/new.js' } }),
    () => ({ tool: 'Write', input: { file_path: 'src/new/deep/a.js' } }), // relative to cwd; folders made later
    () => ({ tool: 'Edit', input: { file_path: cwd + '/src/existing.js' } }),
    () => ({ tool: 'MultiEdit', input: { file_path: cwd + '/src/existing.js' } }),
    () => ({ tool: 'NotebookEdit', input: { notebook_path: cwd + '/nb.ipynb' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/../ok.js' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/.gitignore' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/.github/workflows/ci.yml' } }),
    // The same folder by its real path (/private/var/...) while cwd was given as /var/...
    () => ({ tool: 'Write', input: { file_path: fs.realpathSync.native(cwd) + '/src/b.js' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/c.js' }, cwd: fs.realpathSync.native(cwd) }),
    // link/.. is resolved the way the system does: through the link, then up.
    () => ({ tool: 'Write', input: { file_path: cwd + '/link/../../work/src/ok.js' } }),
  ], 'allow');
});

test('file changes outside the folder, in .git, or through links ask', () => {
  check([
    () => ({ tool: 'Write', input: { file_path: outside + '/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: '../outside/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/../../outside/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: '/etc/hosts' } }),
    () => ({ tool: 'Write', input: { file_path: '~/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: '~root/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/link/x.js' } }), // a link pointing outside
    () => ({ tool: 'Write', input: { file_path: 'link/x.js' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/link/../x.js' } }), // through the link, then up: outside
    () => ({ tool: 'Write', input: { file_path: cwd + '/dangling' } }), // writing would create a file outside
    () => ({ tool: 'Write', input: { file_path: cwd + '/newdir/../x.js' } }), // ".." after a folder that does not exist
    () => ({ tool: 'Edit', input: { file_path: cwd + '/hard.txt' } }), // a hard link shares its contents with outside
    () => ({ tool: 'Write', input: { file_path: cwd + '/.git/config' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/.git/hooks/pre-commit' } }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/.GIT/config' } }), // same folder on a case-insensitive disk
    () => ({ tool: 'Edit', input: { file_path: cwd + '/sub/.git/config' } }),
    () => ({ tool: 'Write', input: { file_path: worktree + '/.git' }, cwd: worktree }), // a worktree's .git file
    () => ({ tool: 'Write', input: { file_path: cwd } }), // the folder itself is not a file inside it
    () => ({ tool: 'Write', input: {} }),
    () => ({ tool: 'Write', input: { file_path: '' } }),
    () => ({ tool: 'Write', input: { file_path: 7 } }),
    () => ({ tool: 'Write', input: null }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/a\0.js' } }),
    // The agent's folder itself cannot be checked.
    () => ({ tool: 'Write', input: { file_path: cwd + '/src/a.js' }, cwd: undefined }),
    () => ({ tool: 'Write', input: { file_path: 'src/a.js' }, cwd: 'work' }),
    () => ({ tool: 'Write', input: { file_path: '/nope/a.js' }, cwd: '/nope' }),
    () => ({ tool: 'Write', input: { file_path: cwd + '/README.md/x' }, cwd: cwd + '/README.md' }),
  ], 'ask');
});

test('safe commands are allowed', () => {
  check([
    // the command from the fixtures, and other test runners
    bash('node test.mjs'), bash('node ./test.mjs'), bash('node test.mjs --verbose extra args'),
    bash('node --test'), bash('node --test test/'), bash('node --test --test-name-pattern=checkout'),
    bash('node --test --test-reporter=spec test/'), bash("node --test 'test/**/*.test.mjs'"), bash('node --test test/*.test.mjs'),
    bash('npm test'), bash('npm run test'), bash('npm run lint'), bash('npm run build'), bash('npm test -- --grep checkout'),
    bash('pnpm test'), bash('yarn test'), bash('make test'),
    bash('pytest'), bash('pytest -q tests/test_x.py'), bash('pytest -k "not slow" -x'), bash('pytest tests/test_x.py::test_y'),
    bash('python -m pytest -x'), bash('python3 -m pytest tests'),
    bash('go test ./...'), bash('go test -run TestCheckout ./pkg/...'), bash('cargo test'), bash('cargo test -- --nocapture'),
    bash('npx jest'), bash('npx vitest run'), bash('npx jest src/checkout'),
    // read-only commands
    bash('ls -la'), bash('ls src/*.mjs'), bash('pwd'), bash('cat README.md'), bash('cat /etc/hosts'), bash('head -n 5 README.md'),
    bash('tail -n 20 README.md'), bash('wc -l src/*.js'), bash('echo hello world'), bash('which node'), bash('file README.md'),
    bash('stat README.md'), bash('tree -L 2'), bash('diff a b'), bash('sort README.md'), bash('uniq -c README.md'),
    bash('uniq -f 2 README.md'), bash('cut -d , -f 1 README.md'), bash('grep -rn "foo bar" src'), bash('rg TODO'), bash('rg --files'),
    bash('rg --pretty TODO'), bash('find . -name "*.js" -type f'), bash('find src -type f'), bash('find src/* -maxdepth 1'),
    bash('ec\'h\'o quoted words join'), bash('ls\t-la'),
    // git that only reads
    bash('git status'), bash('git diff'), bash('git diff --stat HEAD'), bash('git log --oneline -5'), bash('git show HEAD'),
    bash('git rev-parse HEAD'), bash('git ls-files'), bash('git blame src/existing.js'), bash('git grep checkout'),
    bash('git branch'), bash('git branch -a'), bash('git branch -vv'), bash('git branch --show-current'), bash('git branch newname'),
    bash('git branch --list "work*"'), bash('git --no-pager diff'), bash('git -P log --oneline'), bash("git log -- '*.js'"),
    bash('git show HEAD^'), bash('git log -3 HEAD~1'), bash('grep "#include" src/existing.js'),
    // the repository's own allowed prefixes
    bash('npm run e2e', ['npm run e2e']), bash('npm run e2e --headless', ['npm run e2e']), bash('./scripts/check.sh fast', ['./scripts/check.sh']),
  ], 'allow');
});

test('shell tricks ask', () => {
  check([
    bash('ls; rm -rf /'), bash('ls && rm x'), bash('ls || rm x'), bash('ls | sh'), bash('ls & rm x'), bash('echo $(whoami)'),
    bash('echo `whoami`'), bash('echo $HOME'), bash('cat < /etc/passwd'), bash('echo hi > out.txt'), bash('ls\nrm -rf /'),
    bash('ls\r\nrm -rf /'), bash('cat a\\;b'), bash('echo \\$HOME'), bash('ls \\\nrm'), bash('echo {a,b}'), bash('ls (x)'),
    bash('echo "unclosed'), bash("echo 'unclosed"), bash('ls # -la'), bash('ls ' + String.fromCharCode(7)),
    bash('ls' + String.fromCharCode(0x2028) + 'rm -rf /'), bash('"r"m -rf build'), bash("'git' push"), bash("g'i't push"),
    bash('l* -la'), bash('/bin/l? -la'), bash(''), bash('   '), { tool: 'Bash', input: {} }, { tool: 'Bash', input: { command: 42 } },
    // the subagent fixture: a pipe and a backslash
    bash("find /workspace/repo -type f -not -path '*/\\.*' | sort"),
  ], 'ask');
});

test('commands that write, delete, run other programs or escape the folder ask', () => {
  check([
    bash('rm -rf build'), bash('curl https://example.com'), bash('python script.py'), bash('node'), bash('node -e "x"'), bash('node --eval x'),
    bash('node -p 1'), bash('node --import ./x.mjs test.mjs'), bash('npx some-tool'), bash('npm install'), bash('npm run deploy'), bash('npm t'),
    bash('npm test --prefix /tmp'), bash('npm run test --script-shell=/bin/x'), bash('make deploy'), bash('make test CC=evil'), bash('pnpm test --filter x'),
    // git that changes things
    bash('git push'), bash('git commit -m x'), bash('git checkout main'), bash('git reset --hard'), bash('git -c core.pager=evil log'),
    bash('git -C /tmp status'), bash('git --exec-path=/x status'), bash('git --git-dir=/x status'), bash('git'),
    bash('git branch -d old'), bash('git branch -D old'), bash('git branch --delete old'), bash('git branch -dr origin/x'), bash('git branch --del old'),
    bash('git branch -m new'), bash('git branch -f main HEAD~3'), bash('git branch --edit-description'), bash('git branch -u origin/main'),
    bash('git log --output=/tmp/x'), bash('git diff --output=x.patch'), bash('git show --outp=x'), bash('git grep -O vim foo'),
    bash('git grep --open-files-in-pager=vim foo'),
    // find and the "read-only" commands that have writing options
    bash('find . -exec rm x +'), bash('find . -execdir ls +'), bash('find . -delete'), bash('find . -ok rm'), bash('find . -okdir rm'),
    bash('find . -fprint out.txt'), bash('find . -fls out.txt'),
    bash('sort -o out.txt a'), bash('sort --output=out.txt a'), bash('sort --out=out.txt a'), bash('sort -uo out.txt a'),
    bash('sort --compress-program=gzip a'), bash('uniq a b'), bash('uniq - out.txt'), bash('tree -o out.txt'), bash('tree -R'),
    bash('rg --pre=cat foo'), bash('rg --pre-glob=*.gz foo'), bash('rg -z foo'), bash('rg --search-zip foo'), bash('file -C -m magic'),
    // wildcards that could expand to an option, such as a file named "-delete"
    bash('find . *'), bash('find . -name *.js'), bash('find . -^x'), bash('git diff *'), bash('sort *'), bash('sort -- -*'), bash('uniq src/*.txt'),
    bash('rg foo *'), bash('tree *'), bash('node *.mjs'), bash('node src/*.mjs'), bash('pytest *'), bash('npm test -- *'),
    bash('npm run e2e *', ['npm run e2e']),
    // scripts and test files outside the folder
    bash('node ../outside/evil.mjs'), bash('node /tmp/x.js'), bash('node ~/x.js'), bash('node evil-link.mjs'), bash('node .git/hooks/x'),
    bash('node link/x.js'), bash('node inspect /tmp/x.js'), bash('node missing.mjs'), bash('node src'), bash('node --test /tmp/evil.test.mjs'), bash('node --test ../outside'), bash('node --test --import=./x.mjs'),
    bash('node --test --require x'), bash('node --test -e "x"'), bash('node --test --test-reporter-destination=/tmp/out'),
    bash('pytest --basetemp=.'), bash('pytest --basetemp=/tmp/x'), bash('pytest --pastebin=all'), bash('pytest --junitxml=/tmp/x.xml'),
    bash('pytest -c /tmp/pytest.ini'), bash('pytest -c/tmp/pytest.ini'), bash('pytest tests/link-out'), bash('pytest --cov-report=html:/tmp/cov'),
    bash('python -m pytest --rootdir=/'), bash('go test -exec sudo ./...'), bash('go test -toolexec=x ./...'), bash('go test -o /tmp/x ./...'),
    bash('go test ../other/...'), bash('cargo test --config x'), bash('cargo test -Zbuild-std'), bash('cargo test --manifest-path ../other/Cargo.toml'),
    bash('npx jest --config=/tmp/x.js'), bash('npx -p evil jest'), bash('npx vitest --root ../other'),
    // allowed prefixes match whole words only, and never what the shell would chain
    bash('npm run e2e-destroy', ['npm run e2e']), bash('npm run e2e && rm -rf /', ['npm run e2e']),
    bash('rm -rf x', ['', '   ']), bash('rm -rf x', ['ls; rm']), bash('rm -rf x', 'rm -r'), bash('rm -rf x', [42, null, {}]),
    bash('rm -rf x', ['rm *']),
  ], 'ask');
});

test('commands need a folder to be checked against', () => {
  for (const bad of [undefined, null, '', 'relative/path', '/does/not/exist', T + '/work/README.md']) {
    const d = decide({ tool: 'Bash', input: { command: 'ls' }, cwd: bad });
    assert.equal(d.decision, 'ask');
  }
});

test('sentence and detail come from describeRequest', () => {
  const d = decide({ tool: 'Bash', input: { command: 'rm -rf build' }, cwd });
  assert.equal(d.sentence, 'wants to run a command');
  assert.equal(d.detail, 'rm -rf build');
  assert.equal(decide({ tool: 'Write', input: { file_path: '/etc/hosts' }, cwd }).sentence, 'wants to create hosts');
  assert.equal(decide({ tool: 'WebFetch', input: { url: 'https://example.com/a' }, cwd }).detail, 'https://example.com/a');
  assert.equal(decide({ tool: 'mcp__slack__send', input: {}, cwd }).sentence, 'wants to use slack (send)');
  const none = decide();
  assert.equal(none.decision, 'ask');
  assert.equal(none.sentence, 'wants to use a tool');
  assert.deepEqual(Object.keys(decide(null)).sort(), ['decision', 'detail', 'reason', 'sentence']);
});

test('splitWords reads quotes the way the shell does', () => {
  assert.deepEqual(splitWords(`echo 'a b' "c d" e'f'g`).words.map(w => w.text), ['echo', 'a b', 'c d', 'efg']);
  assert.deepEqual(splitWords(`find . -name '*.js'`).words.map(w => w.glob), [false, false, false, false]);
  assert.deepEqual(splitWords('ls src/*.js -*').words.map(w => [w.glob, w.globLead]), [[false, false], [true, false], [true, true]]);
  assert.ok(splitWords('echo "open').error);
  assert.ok(splitWords('ls #x').error);
  assert.equal(splitWords("ls ''#x").error, undefined); // not a comment once quotes started the word
});
