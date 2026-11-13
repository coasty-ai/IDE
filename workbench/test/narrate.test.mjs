// git's sentences in src/shared/narrate.mjs: a push, pull, fetch or clone says what it names, read from the command
// alone. The rest of narrate.mjs is tested in shared.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, describeCommand, commandAction, pastTense } from '../src/shared/narrate.mjs';
import { GIT_READ } from '../src/core/policy.mjs';

const doing = command => describeCommand(command);
/** A remote named by the command: the agent chose that name, so it reads as a name, never as a place. */
const O = 'the remote “origin”';

test('a push says which branch goes where: GitHub for a github.com address, else the remote by its name', () => {
  const rows = [
    ['git push', 'Pushing its branch'], ['git push origin', `Pushing its branch to ${O}`],
    ['git push origin main', `Pushing main to ${O}`], ['git push -u origin feature/login', `Pushing feature/login to ${O}`],
    ['git push --set-upstream origin HEAD', `Pushing its branch to ${O}`], ['git push origin HEAD:refs/heads/fix', `Pushing its branch to fix on ${O}`],
    ['git push origin refs/heads/main:refs/heads/main', `Pushing main to ${O}`], ['git push origin main dev', `Pushing main and dev to ${O}`],
    ['git push origin a b c', `Pushing 3 branches to ${O}`], ['git push origin v1.2.0', `Pushing v1.2.0 to ${O}`],
    ['git push --tags', 'Pushing its tags'], ['git push origin --tags', `Pushing its tags to ${O}`], ['git push --all origin', `Pushing every branch to ${O}`],
    ['git push https://github.com/owner/repo.git main', 'Pushing main to GitHub'], ['git push git@github.com:owner/repo.git main', 'Pushing main to GitHub'],
    ['git push ssh://git@gitlab.example.com:2222/team/repo.git main', 'Pushing main to gitlab.example.com'],
    ['git push -o ci.skip origin main', `Pushing main to ${O}`], ['git push --push-option ci.skip origin main', `Pushing main to ${O}`],
    ['git -C src push origin main', `Pushing main to ${O}`], ['git --git-dir /x/.git push origin main', `Pushing main to ${O}`],
    ["/bin/zsh -lc 'git push origin main'", `Pushing main to ${O}`], // as Codex runs it
  ];
  for (const [command, sentence] of rows) {
    assert.equal(doing(command), sentence, command);
    assert.equal(narrate('Bash', { command, description: 'Save the work' }).sentence, sentence, command);
  }
});

test('a push that replaces or deletes what is on the remote says so', () => {
  const rows = [
    ['git push --force', 'Replacing its branch on the remote'], ['git push -f origin main', `Replacing main on ${O}`],
    ['git push -uf origin main', `Replacing main on ${O}`], ['git push origin +main', `Replacing main on ${O}`],
    ['git push --force-with-lease origin main', `Replacing main on ${O}`], ['git push --force-if-includes origin main', `Replacing main on ${O}`],
    ['git push --forc origin main', `Replacing main on ${O}`], ['git push --tags --force', 'Replacing its tags on the remote'],
    ['git push --mirror backup', 'Replacing everything on the remote “backup”'],
    ['git push origin --delete old', `Deleting old on ${O}`], ['git push origin -d old', `Deleting old on ${O}`],
    ['git push origin :old', `Deleting old on ${O}`], ['git push --prune origin', `Deleting branches on ${O}`],
    ['git push --no-force-with-lease origin main', `Pushing main to ${O}`],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  assert.deepEqual(commandAction('git push -f origin main'), { does: `replace main on ${O}`, doing: `Replacing main on ${O}`, routine: false });
});

test('a push names the branch it changes on the remote: the destination of a refspec, not what is sent onto it', () => {
  const gh = 'https://github.com/owner/repo.git';
  const rows = [
    [`git push --force ${gh} HEAD:main`, 'Replacing main on GitHub'], [`git push -f ${gh} workbench/agent:main`, 'Replacing main on GitHub'],
    [`git push ${gh} +HEAD:refs/heads/main`, 'Replacing main on GitHub'], [`git push ${gh} +feature:refs/tags/v1`, 'Replacing v1 on GitHub'],
    [`git push ${gh} HEAD:main`, 'Pushing its branch to main on GitHub'], [`git push ${gh} feature:main`, 'Pushing feature to main on GitHub'],
    [`git push ${gh} @:refs/heads/fix`, 'Pushing its branch to fix on GitHub'], [`git push ${gh} main:main`, 'Pushing main to GitHub'],
    [`git push ${gh} main:`, 'Pushing main to GitHub'], [`git push ${gh} HEAD:main feature:dev`, 'Pushing main and dev to GitHub'],
    [`git push ${gh} --delete main`, 'Deleting main on GitHub'], [`git push ${gh} :old`, 'Deleting old on GitHub'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  assert.equal(pastTense(doing(`git push ${gh} HEAD:main`)), 'Pushed its branch to main on GitHub');
});

test('a remote reads as GitHub only for an address on github.com: a remote’s own name reads as that name', () => {
  const rows = [
    ['git push GitHub main', 'Pushing main to the remote “GitHub”'], ['git push github main', 'Pushing main to the remote “github”'],
    ['git push --force GitHub main', 'Replacing main on the remote “GitHub”'], ['git push GitHub :main', 'Deleting main on the remote “GitHub”'],
    ['git pull GitHub main', 'Bringing in main from the remote “GitHub”'], ['git fetch GitHub', 'Downloading new commits from the remote “GitHub”'],
    ['git push ../backup.git main', 'Pushing main to the remote “../backup.git”'],
    ['git push https://github.com/owner/repo.git main', 'Pushing main to GitHub'], ['git push git@github.com:owner/repo.git main', 'Pushing main to GitHub'],
    ['git push https://www.github.com/owner/repo.git main', 'Pushing main to GitHub'],
    ['git push https://github.com.evil.example/owner/repo.git main', 'Pushing main to github.com.evil.example'],
    // A name cannot close its own quote: git allows ” and non-breaking spaces in a remote's name.
    ['git push "x” on GitHub" main', 'Pushing main to the remote “x" on GitHub”'],
    [`git push x”${String.fromCharCode(0xa0)}on${String.fromCharCode(0xa0)}GitHub main`, 'Pushing main to the remote “x" on GitHub”'],
    ['git fetch “x”', 'Downloading new commits from the remote “"x"”'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
});

test('pull, fetch and clone have plain sentences of their own', () => {
  const rows = [
    ['git pull', 'Bringing in changes'], ['git pull --rebase', 'Bringing in changes'], ['git pull origin main', `Bringing in main from ${O}`],
    ['git pull --rebase origin main', `Bringing in main from ${O}`], ['git pull -s ours origin main', `Bringing in main from ${O}`],
    ['git pull --recurse-submodules origin main', `Bringing in main from ${O}`], ['git fetch --recurse-submodules origin', `Downloading new commits from ${O}`],
    ['git pull https://github.com/owner/repo', 'Bringing in changes from GitHub'],
    ['git fetch', 'Downloading new commits'], ['git fetch origin', `Downloading new commits from ${O}`],
    ['git fetch --all --prune', 'Downloading new commits from every remote'], ['git fetch --depth 1 origin main', `Downloading new commits from ${O}`],
    ['git fetch https://github.com/owner/repo main', 'Downloading new commits from GitHub'],
    ['git clone https://github.com/owner/repo.git', 'Downloading owner/repo from GitHub'], ['git clone git@github.com:owner/repo.git work', 'Downloading owner/repo from GitHub'],
    ['git clone --depth 1 -b main https://github.com/owner/repo', 'Downloading owner/repo from GitHub'],
    ['git clone https://gitlab.com/group/sub/repo.git', 'Downloading repo from gitlab.com'], ['git clone ../other', 'Copying a repository'],
    ['git clone', 'Downloading a repository'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  // Finished steps read in the past tense.
  assert.equal(pastTense(`Bringing in main from ${O}`), `Brought in main from ${O}`);
  assert.equal(pastTense(`Replacing main on ${O}`), `Replaced main on ${O}`);
  assert.equal(pastTense('Pushing main to GitHub'), 'Pushed main to GitHub');
  assert.equal(pastTense('Downloading owner/repo from GitHub'), 'Downloaded owner/repo from GitHub');
});

test("git's settings, its stored sign-in, and what only looks", () => {
  const rows = [
    ['git config user.name', "Checking git's settings"], ['git config --list', "Checking git's settings"], ['git config -l', "Checking git's settings"],
    ['git config --global --get user.email', "Checking git's settings"], ['git config get user.name', "Checking git's settings"],
    ['git config user.name x', 'Changing git settings'], ['git config --global --unset user.name', 'Changing git settings'],
    ['git config set user.name x', 'Changing git settings'], ['git config -e', 'Changing git settings'],
    ['git credential fill', 'Using your saved sign-in'], ['git credential-osxkeychain get', 'Using your saved sign-in'],
    ['git stash list', 'Checking what changed'], ['git remote -v', 'Checking what changed'], ['git worktree list', 'Checking what changed'],
    ['git tag', 'Checking what changed'], ['git tag -l "v*"', 'Checking what changed'], ['git reflog', 'Checking what changed'],
    ['git ls-tree HEAD', 'Checking what changed'], ['git rev-list --count HEAD', 'Checking what changed'],
    ['git stash pop', 'Changing the repository'], ['git tag v1', 'Changing the repository'], ['git remote add origin https://github.com/o/r', 'Changing the repository'],
    ['git archive -o out.zip HEAD', 'Writing files from the repository'], ['git format-patch -1', 'Writing files from the repository'],
    ['git bundle create repo.bundle HEAD', 'Writing files from the repository'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  assert.equal(commandAction('git config --list').routine, true, 'reading settings is an everyday word');
  assert.equal(commandAction('git config user.name x').routine, false);
});

test('every git command the permission policy allows as one that only reads also reads as looking, never as a change', () => {
  for (const command of ['git check-ignore -v x', 'git var GIT_EDITOR', 'git help status', 'git version', 'git check-attr -a x', 'git check-mailmap a',
    'git check-ref-format main', 'git get-tar-commit-id', 'git diff-pairs -z']) {
    assert.equal(doing(command), 'Checking what changed', command);
  }
  // narrate.mjs is loaded by the page too, so it cannot share the policy's list: the two are kept in step here.
  assert.ok(GIT_READ.size > 30);
  for (const sub of GIT_READ) assert.equal(doing(`git ${sub}`), 'Checking what changed', sub);
});

test("names from a command never bring hidden characters into a sentence, and a long one is clipped", () => {
  const rtl = String.fromCharCode(0x202e);
  const sentence = doing(`git push origin "ma${rtl}in"`);
  assert.equal(sentence, `Pushing ma in to ${O}`);
  const long = doing(`git push origin ${'b'.repeat(80)}`);
  assert.ok(long.length < `Pushing  to ${O}`.length + 33, long);
  assert.match(long, /^Pushing b+… to the remote “origin”$/);
  // A remote's name is cleaned and clipped the same way.
  assert.equal(doing(`git push "ori${rtl}gin" main`), 'Pushing main to the remote “ori gin”');
  assert.match(doing(`git push ${'r'.repeat(80)} main`), /^Pushing main to the remote “r+…”$/);
});
