// git's sentences in src/shared/narrate.mjs: a push, pull, fetch or clone says what it names, read from the command
// alone. The rest of narrate.mjs is tested in shared.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, describeCommand, commandAction, pastTense } from '../src/shared/narrate.mjs';

const doing = command => describeCommand(command);

test('a push says which branch goes where: GitHub for a github.com address, else the remote by its name', () => {
  const rows = [
    ['git push', 'Pushing its branch'], ['git push origin', 'Pushing its branch to origin'],
    ['git push origin main', 'Pushing main to origin'], ['git push -u origin feature/login', 'Pushing feature/login to origin'],
    ['git push --set-upstream origin HEAD', 'Pushing its branch to origin'], ['git push origin HEAD:refs/heads/fix', 'Pushing its branch to origin'],
    ['git push origin refs/heads/main:refs/heads/main', 'Pushing main to origin'], ['git push origin main dev', 'Pushing main and dev to origin'],
    ['git push origin a b c', 'Pushing 3 branches to origin'], ['git push origin v1.2.0', 'Pushing v1.2.0 to origin'],
    ['git push --tags', 'Pushing its tags'], ['git push origin --tags', 'Pushing its tags to origin'], ['git push --all origin', 'Pushing every branch to origin'],
    ['git push https://github.com/owner/repo.git main', 'Pushing main to GitHub'], ['git push git@github.com:owner/repo.git main', 'Pushing main to GitHub'],
    ['git push ssh://git@gitlab.example.com:2222/team/repo.git main', 'Pushing main to gitlab.example.com'],
    ['git push -o ci.skip origin main', 'Pushing main to origin'], ['git push --push-option ci.skip origin main', 'Pushing main to origin'],
    ['git -C src push origin main', 'Pushing main to origin'], ['git --git-dir /x/.git push origin main', 'Pushing main to origin'],
    ["/bin/zsh -lc 'git push origin main'", 'Pushing main to origin'], // as Codex runs it
  ];
  for (const [command, sentence] of rows) {
    assert.equal(doing(command), sentence, command);
    assert.equal(narrate('Bash', { command, description: 'Save the work' }).sentence, sentence, command);
  }
});

test('a push that replaces or deletes what is on the remote says so', () => {
  const rows = [
    ['git push --force', 'Replacing its branch on the remote'], ['git push -f origin main', 'Replacing main on origin'],
    ['git push -uf origin main', 'Replacing main on origin'], ['git push origin +main', 'Replacing main on origin'],
    ['git push --force-with-lease origin main', 'Replacing main on origin'], ['git push --force-if-includes origin main', 'Replacing main on origin'],
    ['git push --forc origin main', 'Replacing main on origin'], ['git push --tags --force', 'Replacing its tags on the remote'],
    ['git push --mirror backup', 'Replacing everything on backup'],
    ['git push origin --delete old', 'Deleting old on origin'], ['git push origin -d old', 'Deleting old on origin'],
    ['git push origin :old', 'Deleting old on origin'], ['git push --prune origin', 'Deleting branches on origin'],
    ['git push --no-force-with-lease origin main', 'Pushing main to origin'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  assert.deepEqual(commandAction('git push -f origin main'), { does: 'replace main on origin', doing: 'Replacing main on origin', routine: false });
});

test('pull, fetch and clone have plain sentences of their own', () => {
  const rows = [
    ['git pull', 'Bringing in changes'], ['git pull --rebase', 'Bringing in changes'], ['git pull origin main', 'Bringing in main from origin'],
    ['git pull --rebase origin main', 'Bringing in main from origin'], ['git pull -s ours origin main', 'Bringing in main from origin'],
    ['git pull --recurse-submodules origin main', 'Bringing in main from origin'], ['git fetch --recurse-submodules origin', 'Downloading new commits from origin'],
    ['git pull https://github.com/owner/repo', 'Bringing in changes from GitHub'],
    ['git fetch', 'Downloading new commits'], ['git fetch origin', 'Downloading new commits from origin'],
    ['git fetch --all --prune', 'Downloading new commits from every remote'], ['git fetch --depth 1 origin main', 'Downloading new commits from origin'],
    ['git fetch https://github.com/owner/repo main', 'Downloading new commits from GitHub'],
    ['git clone https://github.com/owner/repo.git', 'Downloading owner/repo from GitHub'], ['git clone git@github.com:owner/repo.git work', 'Downloading owner/repo from GitHub'],
    ['git clone --depth 1 -b main https://github.com/owner/repo', 'Downloading owner/repo from GitHub'],
    ['git clone https://gitlab.com/group/sub/repo.git', 'Downloading repo from gitlab.com'], ['git clone ../other', 'Copying a repository'],
    ['git clone', 'Downloading a repository'],
  ];
  for (const [command, sentence] of rows) assert.equal(doing(command), sentence, command);
  // Finished steps read in the past tense.
  assert.equal(pastTense('Bringing in main from origin'), 'Brought in main from origin');
  assert.equal(pastTense('Replacing main on origin'), 'Replaced main on origin');
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

test("names from a command never bring hidden characters into a sentence, and a long one is clipped", () => {
  const rtl = String.fromCharCode(0x202e);
  const sentence = doing(`git push origin "ma${rtl}in"`);
  assert.equal(sentence, 'Pushing ma in to origin');
  const long = doing(`git push origin ${'b'.repeat(80)}`);
  assert.ok(long.length < 'Pushing  to origin'.length + 33, long);
  assert.match(long, /^Pushing b+… to origin$/);
});
