// GitHub through gh (src/core/github.mjs): finding gh, downloading it, its sign-in, setup-git, status, the repository
// list and sign-out. gh is the stand-in in test/helpers/gh-fake.mjs, never the real one; a download is a release made
// here and served by a fetch of these tests, never GitHub; git's settings are a GIT_CONFIG_GLOBAL file of these tests
// (with GIT_CONFIG_NOSYSTEM=1), never the person's; HOME is a temporary folder. Nothing reaches a network or a keychain.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ghFind, ghOwnPath, ghEnv, versionOf, versionAtLeast, ghAsset, checksumFor, ghInstall, codesignVerify, ghVersion, ghStatus,
  startGhLogin, ghSetupGit, ghLogout, ghRepos, ghReposOrNull, ghSignInProgram, ghSignInSteps, ghSignOutProgram,
  ghSignInCommand, ghSignOutCommand, isGhHelper, gitUsesGh, forgetGhGitHelper,
  GH_LOGIN_ARGS, GH_REPOS_PATH, GH_DEVICE_URL, GH_MIN_VERSION, GH_HELPER_KEYS,
} from '../src/core/github.mjs';
import { GH_FAKE, FAKE_CODE, FAKE_REPOS, ghWrapper, wrapperScript, fakeRelease, releaseFetch } from './helpers/gh-fake.mjs';

let T;
const saved = { ...process.env };
const HAS_UNZIP = fs.existsSync('/usr/bin/unzip');
const HAS_TAR = ['/usr/bin/tar', '/bin/tar'].some((p) => fs.existsSync(p));

before(() => {
  T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-github-')));
  fs.mkdirSync(path.join(T, 'home'));
  fs.writeFileSync(path.join(T, 'gitconfig'), '');
  Object.assign(process.env, {
    HOME: path.join(T, 'home'), XDG_CONFIG_HOME: path.join(T, 'home', '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(T, 'gitconfig'),
  });
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'WORKBENCH_GH_BIN', 'FAKE_GH_STATE', 'FAKE_GH_LOGIN', 'FAKE_GH_VERSION', 'FAKE_GH_LOG']) delete process.env[k];
});

after(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(T, { recursive: true, force: true });
});

function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(T, 'case-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A gh stand-in of its own for one test: its wrapper, its sign-in file, its log, and the environment that reaches it. */
function standIn(t, vars = {}) {
  const dir = scratch(t);
  const gh = ghWrapper(path.join(dir, 'bin'));
  const state = path.join(dir, 'gh-state.json');
  const log = path.join(dir, 'gh-log.jsonl');
  const env = { ...process.env, FAKE_GH_STATE: state, FAKE_GH_LOG: log, ...vars };
  const signIn = (user = 'octo-cat') => fs.writeFileSync(state, JSON.stringify({ user }));
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const signedInAs = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')).user ?? null; } catch { return null; } };
  return { dir, gh, state, env, signIn, calls, signedInAs };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gone(pid) {
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(50);
  return !alive(pid);
}
const mode = (p) => fs.statSync(p).mode & 0o777;
const gitGlobal = (...args) => execFileSync('git', ['config', '--global', ...args], { encoding: 'utf8', env: process.env }).trim();
/** Every value of a key in the global settings of these tests, an empty one too. */
const gitValues = (key) => execFileSync('git', ['config', '--global', '-z', '--get-all', key], { encoding: 'utf8', env: process.env }).split('\0').slice(0, -1);

// ------------------------------------------------------------------ finding gh

test('ghFind: WORKBENCH_GH_BIN alone when it is set; else the PATH, then ~/.local/bin, then Homebrew’s folders', (t) => {
  const d = scratch(t);
  const home = path.join(d, 'home');
  const [a, b, extra] = ['a', 'b', 'extra'].map((x) => path.join(d, x));
  const inB = ghWrapper(b);
  const dirs = [extra];
  assert.equal(ghFind({ PATH: `${a}:${b}` }, { home, dirs }), inB);
  const inA = ghWrapper(a);
  assert.equal(ghFind({ PATH: `${a}:${b}` }, { home, dirs }), inA, 'the first on the PATH');
  assert.equal(ghFind({ PATH: `relative:${b}` }, { home, dirs }), inB, 'a relative folder is not looked in');
  const own = ghWrapper(path.join(home, '.local', 'bin'));
  assert.equal(own, ghOwnPath(home));
  const inExtra = ghWrapper(extra);
  assert.equal(ghFind({ PATH: '/nowhere' }, { home, dirs }), own, '~/.local/bin before the other folders');
  fs.rmSync(own);
  assert.equal(ghFind({ PATH: '/nowhere' }, { home, dirs }), inExtra);
  assert.equal(ghFind({ PATH: '' }, { home, dirs: [] }), null);
  // Not a program: a folder called gh, or a file that cannot run.
  const c = path.join(d, 'c');
  fs.mkdirSync(path.join(c, 'gh'), { recursive: true });
  const e = path.join(d, 'e');
  fs.mkdirSync(e);
  fs.writeFileSync(path.join(e, 'gh'), '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(ghFind({ PATH: `${c}:${e}:${b}` }, { home, dirs: [] }), inB);
  // WORKBENCH_GH_BIN: that program, and nothing else, even when it is not there.
  assert.equal(ghFind({ PATH: b, WORKBENCH_GH_BIN: inA }, { home, dirs }), inA);
  assert.equal(ghFind({ PATH: b, WORKBENCH_GH_BIN: path.join(d, 'no-gh-here') }, { home, dirs }), null);
  assert.equal(ghFind({ PATH: b, WORKBENCH_GH_BIN: GH_FAKE }, { home, dirs }), GH_FAKE, 'a node script runs with node');
});

test('versions: read from gh --version, and compared as numbers', () => {
  assert.equal(versionOf('gh version 2.104.0 (2026-11-12)\nhttps://github.com/cli/cli/releases/tag/v2.104.0\n'), '2.104.0');
  assert.equal(versionOf('gh version 2.40.1 (2023-12-13)'), '2.40.1');
  assert.equal(versionOf('something else'), null);
  assert.equal(versionAtLeast('2.104.0', GH_MIN_VERSION), true);
  assert.equal(versionAtLeast('2.81.0', '2.81.0'), true);
  assert.equal(versionAtLeast('2.80.9', '2.81.0'), false);
  assert.equal(versionAtLeast('10.0.0', '2.81.0'), true);
  assert.equal(versionAtLeast('2.9.0', '2.81.0'), false, 'not compared as text');
  assert.equal(versionAtLeast(null, '2.81.0'), false);
  assert.equal(GH_MIN_VERSION, '2.81.0');
});

test('ghEnv: no token, host, terminal or debug switch of the person’s reaches gh; prompts, the update check and telemetry are off', () => {
  const env = ghEnv({ HOME: '/h', PATH: '/p', GH_CONFIG_DIR: '/c', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GH_HOST: 'ghe.example', GH_DEBUG: 'api', DEBUG: '1', GH_FORCE_TTY: '1' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/p', GH_CONFIG_DIR: '/c', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false', NO_COLOR: '1' });
});

// ------------------------------------------------------------------ downloading gh

test('the release files for each computer GitHub publishes gh for, and a plain refusal for any other', () => {
  assert.deepEqual(ghAsset({ version: '2.104.0', platform: 'darwin', arch: 'arm64' }),
    { name: 'gh_2.104.0_macOS_arm64.zip', kind: 'zip', member: 'gh_2.104.0_macOS_arm64/bin/gh', checksums: 'gh_2.104.0_checksums.txt' });
  assert.equal(ghAsset({ version: '2.104.0', platform: 'darwin', arch: 'x64' }).name, 'gh_2.104.0_macOS_amd64.zip');
  assert.deepEqual(ghAsset({ version: '2.104.0', platform: 'linux', arch: 'x64' }),
    { name: 'gh_2.104.0_linux_amd64.tar.gz', kind: 'tar.gz', member: 'gh_2.104.0_linux_amd64/bin/gh', checksums: 'gh_2.104.0_checksums.txt' });
  assert.equal(ghAsset({ version: '2.104.0', platform: 'linux', arch: 'arm64' }).name, 'gh_2.104.0_linux_arm64.tar.gz');
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'ia32'], ['freebsd', 'x64'], ['linux', 'ppc64']]) {
    assert.throws(() => ghAsset({ version: '2.104.0', platform, arch }), {
      plain: true, why: 'platform', message: 'GitHub does not publish its command-line tool for this kind of computer, so Workbench cannot get it. Use a token instead.',
    });
  }
  for (const version of ['2.104', 'v2.104.0', '2.104.0-rc1', '../2.104.0', '2.104.0/x']) {
    assert.throws(() => ghAsset({ version, platform: 'darwin', arch: 'arm64' }), { why: 'github' }, version);
  }
  const r = fakeRelease({ platform: 'darwin', arch: 'arm64' });
  assert.equal(checksumFor(r.checksums, r.name), r.sha256, 'its own line, not the .sig line that starts with its name');
  assert.equal(checksumFor(r.checksums.toUpperCase().replaceAll('GH_2.104.0_MACOS_ARM64.ZIP', r.name), r.name), r.sha256, 'upper-case hex is read too');
  assert.equal(checksumFor(r.checksums, 'gh_2.104.0_macOS_ppc.zip'), null);
  assert.equal(checksumFor('not a checksums file', r.name), null);
});

/** A home folder for one install: its ~/.local/bin, and Workbench's own private folder, where the download goes. */
function installPlace(t) {
  const d = scratch(t);
  const home = path.join(d, 'home');
  fs.mkdirSync(home);
  return { home, bin: path.join(home, '.local', 'bin'), own: path.join(home, '.workbench', 'tmp') };
}
/** What ghInstall left in Workbench's own private folder (nothing, once it is done). */
const leftIn = (p) => (fs.existsSync(p.own) ? fs.readdirSync(p.own) : []);

/** Every file under `dir`. */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

/** Run `fn` with TMPDIR set to `dir`, then put it back. */
async function withTmpdir(dir, fn) {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

test('ghInstall on a Mac: the latest release from the redirect, checked against its checksum and GitHub’s signature, leaves only ~/.local/bin/gh', { skip: !HAS_UNZIP && 'needs /usr/bin/unzip' }, async (t) => {
  const p = installPlace(t);
  const release = fakeRelease({ platform: 'darwin', arch: 'arm64' });
  const { fetchImpl, calls } = releaseFetch(release);
  const verified = [];
  const progress = [];
  const r = await ghInstall({
    fetchImpl, platform: 'darwin', arch: 'arm64', home: p.home, osRelease: '27.0.0', env: process.env,
    verify: async (file) => {
      // Where the download is meanwhile: a private folder of Workbench's own.
      const work = fs.readdirSync(p.own).filter((n) => n.startsWith('workbench-gh-'));
      verified.push({ file, there: fs.existsSync(file), installed: fs.existsSync(path.join(p.bin, 'gh')), work, own: mode(p.own) });
      return true;
    },
    onProgress: (x) => progress.push(x),
  });
  assert.deepEqual(r, { path: path.join(p.bin, 'gh'), version: '2.104.0' });
  assert.deepEqual(fs.readdirSync(p.bin), ['gh'], 'the program alone: no licence, no manual, no temporary file');
  assert.equal(mode(r.path), 0o755);
  assert.equal(fs.readFileSync(r.path, 'utf8'), wrapperScript({ version: '2.104.0' }));
  assert.deepEqual(leftIn(p), [], 'the download’s folder is gone');
  assert.deepEqual(calls.map((c) => [c.url, c.redirect]), [
    ['https://github.com/cli/cli/releases/latest', 'manual'],
    ['https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_checksums.txt', 'follow'],
    ['https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_macOS_arm64.zip', 'follow'],
  ]);
  // The signature is checked on the program taken out of the archive, in Workbench's own private folder, before it
  // goes in place.
  assert.equal(verified.length, 1);
  assert.ok(verified[0].file.startsWith(`${p.own}${path.sep}`), verified[0].file);
  assert.deepEqual([verified[0].there, verified[0].installed], [true, false]);
  assert.equal(verified[0].work.length, 1);
  assert.equal(verified[0].own, 0o700);
  assert.deepEqual(progress.map((x) => x.phase).filter((x, i, all) => x !== all[i - 1]), ['finding', 'downloading', 'checking', 'installing']);
  assert.equal(progress.filter((x) => x.phase === 'downloading').at(-1).percent, 100);
  assert.equal(await ghVersion({ ghPath: r.path }), '2.104.0', 'the installed gh runs');
});

test('ghInstall on Linux: the tar.gz for this processor, with no signature check (GitHub signs only the macOS builds)', { skip: !HAS_TAR && 'needs tar' }, async (t) => {
  const p = installPlace(t);
  const release = fakeRelease({ platform: 'linux', arch: 'x64' });
  const { fetchImpl, calls } = releaseFetch(release);
  const r = await ghInstall({
    fetchImpl, platform: 'linux', arch: 'x64', home: p.home, env: process.env,
    verify: async () => { throw new Error('the signature is checked on macOS only'); },
  });
  assert.deepEqual(r, { path: path.join(p.bin, 'gh'), version: '2.104.0' });
  assert.equal(calls.at(-1).url, 'https://github.com/cli/cli/releases/download/v2.104.0/gh_2.104.0_linux_amd64.tar.gz');
  assert.deepEqual(fs.readdirSync(p.bin), ['gh']);
  assert.deepEqual(leftIn(p), []);
});

test('ghInstall refuses, before any download, when it cannot make its private folder', { skip: !HAS_UNZIP && 'needs /usr/bin/unzip' }, async (t) => {
  const p = installPlace(t);
  fs.mkdirSync(path.join(p.home, '.workbench'));
  fs.writeFileSync(p.own, ''); // a file where its folder would be
  const { fetchImpl, calls } = releaseFetch(fakeRelease());
  await assert.rejects(ghInstall({ fetchImpl, platform: 'darwin', arch: 'arm64', home: p.home, osRelease: '27.0.0', verify: async () => true }), {
    plain: true, why: 'disk', message: `Workbench could not make a private folder for its temporary files in ${p.own}.`,
  });
  assert.deepEqual(calls.map((c) => c.url), ['https://github.com/cli/cli/releases/latest'], 'only the version was asked');
  assert.equal(fs.existsSync(p.bin), false);
});

test('ghInstall refuses a download whose checksum does not match, and installs nothing', { skip: !HAS_UNZIP && 'needs /usr/bin/unzip' }, async (t) => {
  const p = installPlace(t);
  const release = fakeRelease({ platform: 'darwin', arch: 'arm64' });
  const other = fakeRelease({ platform: 'darwin', arch: 'arm64', program: '#!/bin/sh\necho "gh version 2.104.0"\n' });
  let verified = 0;
  const { fetchImpl } = releaseFetch(release, { archive: other.bytes });
  await assert.rejects(ghInstall({ fetchImpl, platform: 'darwin', arch: 'arm64', home: p.home, osRelease: '27.0.0', verify: async () => { verified++; return true; } }), {
    plain: true, why: 'checksum', message: 'The download of GitHub’s command-line tool did not match the checksum GitHub published for it, so Workbench did not install it.',
  });
  assert.equal(verified, 0, 'nothing was taken out of it');
  assert.equal(fs.existsSync(p.bin), false);
  assert.deepEqual(leftIn(p), []);
  // A checksums file with no line for this computer's file: refused too.
  const { fetchImpl: noLine } = releaseFetch({ ...release, checksums: release.checksums.split('\n').filter((l) => !l.endsWith(`  ${release.name}`)).join('\n') });
  await assert.rejects(ghInstall({ fetchImpl: noLine, platform: 'darwin', arch: 'arm64', home: p.home, osRelease: '27.0.0', verify: async () => true }), { why: 'github' });
  assert.equal(fs.existsSync(p.bin), false);
  assert.deepEqual(leftIn(p), []);
});

test('ghInstall refuses a gh GitHub did not sign, a link in place of the program, and a program that does not run', { skip: !HAS_UNZIP && 'needs /usr/bin/unzip' }, async (t) => {
  const p = installPlace(t);
  const opts = { platform: 'darwin', arch: 'arm64', home: p.home, osRelease: '27.0.0', env: process.env };
  await assert.rejects(ghInstall({ ...opts, fetchImpl: releaseFetch(fakeRelease()).fetchImpl, verify: async () => false }), {
    plain: true, why: 'signature', message: 'The copy of GitHub’s command-line tool that was downloaded is not signed by GitHub, so Workbench did not install it.',
  });
  await assert.rejects(ghInstall({ ...opts, fetchImpl: releaseFetch(fakeRelease()).fetchImpl, verify: async () => { throw new Error('codesign broke'); } }), { why: 'signature' });
  await assert.rejects(ghInstall({ ...opts, fetchImpl: releaseFetch(fakeRelease({ symlink: true })).fetchImpl, verify: async () => true }), {
    plain: true, why: 'github', message: 'The download of GitHub’s command-line tool did not hold the program Workbench expected, so it was not installed.',
  });
  for (const program of ['#!/bin/sh\nexit 1\n', '#!/bin/sh\necho "gh version 2.103.0 (2026-10-01)"\n']) {
    await assert.rejects(ghInstall({ ...opts, fetchImpl: releaseFetch(fakeRelease({ program })).fetchImpl, verify: async () => true }), {
      plain: true, why: 'runs', message: 'The copy of GitHub’s command-line tool that was downloaded does not run on this computer, so Workbench did not install it.',
    });
  }
  // The program is tried beside ~/.local/bin/gh under a temporary name: neither it nor a gh is left there.
  assert.deepEqual(fs.existsSync(p.bin) ? fs.readdirSync(p.bin) : [], []);
  assert.deepEqual(leftIn(p), []);
});

test('ghInstall tries the downloaded gh where it will live, under a temporary name, never in the temporary folder (which may be noexec)', async (t) => {
  const kinds = [HAS_UNZIP && 'darwin', HAS_TAR && 'linux'].filter(Boolean);
  if (!kinds.length) { t.skip('needs /usr/bin/unzip or tar'); return; }
  for (const platform of kinds) {
    await t.test(platform, async (st) => {
      const p = installPlace(st);
      const ran = path.join(p.home, 'ran.txt');
      // A gh that cannot be started from the temporary folder, as on a Linux whose /tmp is mounted noexec; it notes
      // where it was started from.
      const program = [
        '#!/bin/sh',
        `printf '%s\\n' "$0" >> '${ran}'`,
        'case "$0" in */workbench-gh-*) echo "Permission denied" >&2; exit 126;; esac',
        ...wrapperScript({ version: '2.104.0' }).split('\n').slice(1),
      ].join('\n');
      const r = await ghInstall({
        fetchImpl: releaseFetch(fakeRelease({ platform, arch: 'arm64', program })).fetchImpl, platform, arch: 'arm64', home: p.home,
        osRelease: '27.0.0', env: process.env, verify: async () => true,
      });
      assert.deepEqual(r, { path: path.join(p.bin, 'gh'), version: '2.104.0' });
      const where = fs.readFileSync(ran, 'utf8').trim().split('\n');
      assert.equal(where.length, 1, 'tried once');
      assert.match(where[0], /\/\.local\/bin\/\.gh-[0-9]+-[0-9a-f]{8}\.tmp$/, 'under its temporary name beside ~/.local/bin/gh');
      assert.equal(path.dirname(where[0]), p.bin);
      assert.deepEqual(fs.readdirSync(p.bin), ['gh']);
      assert.deepEqual(leftIn(p), []);
      assert.equal(await ghVersion({ ghPath: r.path }), '2.104.0');
    });
  }
});

test('ghInstall refuses before any download: a computer GitHub publishes no gh for, a Mac older than macOS 13; and with no network', async (t) => {
  const p = installPlace(t);
  const { fetchImpl, calls } = releaseFetch(fakeRelease());
  await assert.rejects(ghInstall({ fetchImpl, platform: 'win32', arch: 'x64', home: p.home }), { plain: true, why: 'platform' });
  await assert.rejects(ghInstall({ fetchImpl, platform: 'darwin', arch: 'arm64', osRelease: '21.6.0', home: p.home }), {
    plain: true, why: 'macos', message: 'GitHub’s command-line tool needs macOS 13 or later, so Workbench cannot use it on this Mac. Use a token instead.',
  });
  assert.equal(calls.length, 0);
  const offline = releaseFetch(fakeRelease(), { fail: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) });
  await assert.rejects(ghInstall({ fetchImpl: offline.fetchImpl, platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', home: p.home }), {
    plain: true, why: 'network', message: 'Workbench could not reach GitHub to get its command-line tool. Check the internet connection, then try again.',
  });
  // GitHub answering something else than a release's redirect.
  for (const o of [{ latest: 'https://evil.example/cli/cli/releases/tag/v2.104.0' }, { latest: 'https://github.com/cli/cli/releases/tag/v2.104.0-rc.1' },
    { latest: 'https://github.com/cli/cli/releases/tag/v2.104.0/../../x' }, { status: 500 }]) {
    await assert.rejects(ghInstall({ fetchImpl: releaseFetch(fakeRelease(), o).fetchImpl, platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', home: p.home }), {
      plain: true, why: 'github', message: 'GitHub did not give Workbench the number of its latest command-line tool. Try again in a few minutes.',
    }, JSON.stringify(o));
  }
  assert.equal(fs.existsSync(p.bin), false);
  assert.deepEqual(leftIn(p), []);
});

test('ghInstall updates ~/.local/bin/gh in place, and stops when asked, leaving the gh that was there', { skip: !HAS_UNZIP && 'needs /usr/bin/unzip' }, async (t) => {
  const p = installPlace(t);
  const old = ghWrapper(p.bin, { version: '2.40.1' });
  assert.equal(await ghVersion({ ghPath: old }), '2.40.1');
  // Stopped while the archive downloads.
  const stop = new AbortController();
  const hanging = releaseFetch(fakeRelease(), { hang: true });
  const stopped = ghInstall({
    fetchImpl: hanging.fetchImpl, platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', home: p.home, signal: stop.signal, verify: async () => true,
    onProgress: (x) => { if (x.phase === 'downloading') stop.abort(); },
  });
  await assert.rejects(stopped, { plain: true, why: 'cancelled', message: 'Stopped getting GitHub’s command-line tool.' });
  assert.equal(await ghVersion({ ghPath: old }), '2.40.1', 'the gh that was there stays');
  assert.deepEqual(leftIn(p), []);
  // Updated in place: the same path, the new program, nothing else beside it.
  const r = await ghInstall({ fetchImpl: releaseFetch(fakeRelease()).fetchImpl, platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', home: p.home, verify: async () => true });
  assert.equal(r.path, old);
  assert.equal(await ghVersion({ ghPath: old }), '2.104.0');
  assert.deepEqual(fs.readdirSync(p.bin), ['gh']);
  assert.deepEqual(leftIn(p), []);
});

test('the signature check on a Mac refuses a program GitHub did not sign (the real codesign, on files of this test)', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
  const d = scratch(t);
  const unsigned = path.join(d, 'gh');
  fs.writeFileSync(unsigned, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  assert.equal(await codesignVerify(unsigned), false);
  assert.equal(await codesignVerify('/bin/ls'), false, 'signed, but by Apple, not GitHub');
  assert.equal(await codesignVerify(path.join(d, 'not-there')), false);
});

// ------------------------------------------------------------------ status

test('ghStatus reads the sign-in from gh’s own settings, with no network call; with verify, an unclear answer asks gh auth status', async (t) => {
  const s = standIn(t, { GH_TOKEN: 'not-for-gh', GITHUB_TOKEN: 'not-for-gh-either', GH_HOST: 'ghe.example' });
  assert.deepEqual(await ghStatus({ ghPath: s.gh, env: s.env }), { installed: true, version: '2.104.0', signedIn: false, login: null });
  s.signIn('octo-cat');
  assert.deepEqual(await ghStatus({ ghPath: s.gh, env: s.env }), { installed: true, version: '2.104.0', signedIn: true, login: 'octo-cat' });
  assert.deepEqual(await ghStatus({ ghPath: s.gh, env: s.env, version: '2.104.0' }), { installed: true, version: '2.104.0', signedIn: true, login: 'octo-cat' });
  // What reached gh: no token, no host, no terminal, nothing to answer; only `--version` and `config get user`.
  const calls = s.calls();
  assert.deepEqual([...new Set(calls.map((c) => c.argv.join(' ')))].sort(), ['--version', 'config get user -h github.com']);
  for (const c of calls) {
    assert.deepEqual(c.tokens, { GH_TOKEN: false, GITHUB_TOKEN: false });
    assert.equal(c.host, false);
    assert.equal(c.stdin, 'ignored');
    assert.equal(c.prompt, '1');
    assert.equal(c.telemetry, 'false');
  }
  // gh's settings give no clear answer: with verify (only after the person acted), gh auth status says.
  const broken = standIn(t, { FAKE_GH_CONFIG: 'broken' });
  broken.signIn('octo-cat');
  assert.deepEqual(await ghStatus({ ghPath: broken.gh, env: broken.env }), { installed: true, version: '2.104.0', signedIn: null, login: null });
  assert.deepEqual(await ghStatus({ ghPath: broken.gh, env: broken.env, verify: true }), { installed: true, version: '2.104.0', signedIn: true, login: 'octo-cat' });
  assert.ok(broken.calls().some((c) => c.argv.join(' ') === 'auth status --json hosts --hostname github.com'));
  // No gh, a gh that does not run, a gh that does not answer in time.
  const none = { installed: false, version: null, signedIn: false, login: null };
  assert.deepEqual(await ghStatus({ ghPath: null }), none);
  assert.deepEqual(await ghStatus({ ghPath: s.gh, env: { ...s.env, FAKE_GH_VERSION: 'broken' } }), none);
  assert.deepEqual(await ghStatus({ ghPath: s.gh, env: { ...s.env, FAKE_GH_VERSION: 'hang' }, timeoutMs: 300 }), none);
  assert.deepEqual(await ghStatus({ ghPath: path.join(s.dir, 'not-there') }), none);
});

// ------------------------------------------------------------------ the sign-in

test('startGhLogin: gh’s login with no terminal gives its one-time code, then signs in; no token of the person’s reaches it', async (t) => {
  const s = standIn(t, { GH_TOKEN: 'person-token', GITHUB_TOKEN: 'person-token' });
  const codes = [];
  const login = startGhLogin({ ghPath: s.gh, env: s.env, onCode: (c) => codes.push(c) });
  const r = await login.done;
  assert.deepEqual({ outcome: r.outcome, code: r.code, exitCode: r.exitCode }, { outcome: 'done', code: FAKE_CODE, exitCode: 0 });
  assert.deepEqual(codes, [{ code: FAKE_CODE, url: GH_DEVICE_URL }]);
  assert.equal(GH_DEVICE_URL, 'https://github.com/login/device');
  assert.equal(s.signedInAs(), 'octo-cat');
  const [call] = s.calls();
  assert.deepEqual(call.argv, GH_LOGIN_ARGS);
  assert.deepEqual(call.argv, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow']);
  assert.equal(call.stdin, 'ignored', 'standard input is /dev/null: nothing can be typed');
  assert.deepEqual(call.tokens, { GH_TOKEN: false, GITHUB_TOKEN: false });
  // The code printed on standard output is read too; one of another shape is not taken.
  const out = standIn(t, { FAKE_GH_LOGIN_OUT: 'stdout', FAKE_GH_CODE: 'abcd-1234' });
  const seen = [];
  const r2 = await startGhLogin({ ghPath: out.gh, env: out.env, onCode: (c) => seen.push(c.code) }).done;
  assert.deepEqual([r2.outcome, seen], ['done', ['ABCD-1234']]);
  const odd = standIn(t, { FAKE_GH_CODE: 'ABCD-12345' });
  const none = [];
  const r3 = await startGhLogin({ ghPath: odd.gh, env: odd.env, onCode: (c) => none.push(c) }).done;
  assert.deepEqual([r3.outcome, r3.code, none], ['done', null, []]);
});

test('startGhLogin stops gh when it asks a question, when no code comes in time, when the code runs out, and when cancelled', async (t) => {
  const pidOf = (s) => s.calls().find((c) => c.argv[1] === 'login')?.pid;
  const question = standIn(t, { FAKE_GH_LOGIN: 'question' });
  const q = await startGhLogin({ ghPath: question.gh, env: question.env, codeWaitMs: 5000 }).done;
  assert.equal(q.outcome, 'question');
  assert.ok(await gone(pidOf(question)), 'gh is stopped');
  const silent = standIn(t, { FAKE_GH_LOGIN: 'silent' });
  const started = Date.now();
  const n = await startGhLogin({ ghPath: silent.gh, env: silent.env, codeWaitMs: 400 }).done;
  assert.equal(n.outcome, 'no-code');
  assert.ok(Date.now() - started >= 350);
  assert.ok(await gone(pidOf(silent)));
  const waiting = standIn(t, { FAKE_GH_LOGIN: 'wait' });
  const codes = [];
  const e = await startGhLogin({ ghPath: waiting.gh, env: waiting.env, maxMs: 400, onCode: (c) => codes.push(c.code) }).done;
  assert.deepEqual([e.outcome, e.code, codes], ['expired', FAKE_CODE, [FAKE_CODE]]);
  assert.ok(await gone(pidOf(waiting)));
  const cancelled = standIn(t, { FAKE_GH_LOGIN: 'wait' });
  const login = startGhLogin({ ghPath: cancelled.gh, env: cancelled.env, onCode: () => login.cancel() });
  assert.equal((await login.done).outcome, 'cancelled');
  assert.ok(await gone(pidOf(cancelled)));
  assert.equal(cancelled.signedInAs(), null);
});

test('startGhLogin: a gh that fails, before or after its code, or cannot be started, is "failed"', async (t) => {
  const fail = standIn(t, { FAKE_GH_LOGIN: 'fail' });
  const f = await startGhLogin({ ghPath: fail.gh, env: fail.env }).done;
  assert.deepEqual([f.outcome, f.exitCode, f.code], ['failed', 1, null]);
  assert.match(f.detail, /error connecting to api\.github\.com/, 'gh’s own words go to the log only');
  const deny = standIn(t, { FAKE_GH_LOGIN: 'deny' });
  const d = await startGhLogin({ ghPath: deny.gh, env: deny.env }).done;
  assert.deepEqual([d.outcome, d.exitCode, d.code], ['failed', 1, FAKE_CODE]);
  const tokenSet = standIn(t);
  // A token the person set reaches gh only if Workbench passes it: here the stand-in would refuse, as gh does.
  const r = await startGhLogin({ ghPath: tokenSet.gh, env: { ...tokenSet.env, GH_TOKEN: 'x' } }).done;
  assert.equal(r.outcome, 'done');
  const missing = await startGhLogin({ ghPath: path.join(tokenSet.dir, 'no-gh') }).done;
  assert.equal(missing.outcome, 'failed');
});

test('startGhLogin: gh giving up by itself near the end of the wait is "expired", not "failed"', async (t) => {
  // GitHub's own end of the code can come a little before Workbench's: gh then exits 1 by itself.
  const late = standIn(t, { FAKE_GH_LOGIN: 'deny', FAKE_GH_LOGIN_DELAY_MS: '2500' });
  const l = await startGhLogin({ ghPath: late.gh, env: late.env, maxMs: 4000 }).done;
  assert.deepEqual([l.outcome, l.exitCode, l.code], ['expired', 1, FAKE_CODE]);
  // Early in the wait it is a failure, as before (the person denied it, say).
  const early = standIn(t, { FAKE_GH_LOGIN: 'deny', FAKE_GH_LOGIN_DELAY_MS: '100' });
  const e = await startGhLogin({ ghPath: early.gh, env: early.env, maxMs: 4000 }).done;
  assert.deepEqual([e.outcome, e.exitCode], ['failed', 1]);
});

test('startGhLogin: Workbench’s own limit ends the wait at 14.5 minutes, before the code runs out on GitHub (15 minutes)', async (t) => {
  const waiting = standIn(t, { FAKE_GH_LOGIN: 'wait' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let shown;
  const codeShown = new Promise((resolve) => { shown = resolve; });
  const login = startGhLogin({ ghPath: waiting.gh, env: waiting.env, onCode: (c) => shown(c) });
  t.after(() => login.cancel());
  assert.deepEqual(await codeShown, { code: FAKE_CODE, url: GH_DEVICE_URL });
  let outcome = null;
  login.done.then((r) => { outcome = r.outcome; });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(14 * 60_000);
  await settle();
  assert.equal(outcome, null, 'still waiting after 14 minutes');
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(outcome, 'expired', 'stopped by 14.5 minutes');
});

// ------------------------------------------------------------------ git's helper

test('setup-git makes git ask gh for github.com; forgetGhGitHelper takes out exactly what it wrote, and nothing of the person’s', async (t) => {
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Ada\n[credential]\n\thelper = store\n[credential "https://example.com"]\n\thelper = cache\n');
  t.after(() => fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, ''));
  const s = standIn(t);
  assert.equal(await gitUsesGh(), false);
  const out = await ghSetupGit({ ghPath: s.gh, env: s.env });
  assert.equal(out.ok, false, 'not signed in: gh refuses');
  assert.match(out.detail, /not logged into any GitHub hosts/);
  s.signIn();
  assert.deepEqual(await ghSetupGit({ ghPath: s.gh, env: s.env }), { ok: true });
  assert.deepEqual(s.calls().at(-1).argv, ['auth', 'setup-git', '--hostname', 'github.com']);
  for (const key of GH_HELPER_KEYS) assert.deepEqual(gitValues(key), ['', `!${s.gh} auth git-credential`], key);
  assert.equal(await gitUsesGh(), true);
  assert.deepEqual(await forgetGhGitHelper(), { removed: [...GH_HELPER_KEYS], kept: [] });
  assert.equal(await gitUsesGh(), false);
  const left = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8');
  assert.doesNotMatch(left, /github\.com/, 'no empty section is left');
  assert.equal(gitGlobal('--get', 'user.name'), 'Ada');
  assert.equal(gitGlobal('--get', 'credential.helper'), 'store');
  assert.equal(gitGlobal('--get', 'credential.https://example.com.helper'), 'cache');
  assert.deepEqual(await forgetGhGitHelper(), { removed: [], kept: [] }, 'nothing to take out twice');
  // A helper of the person's own for github.com, or a pair whose second value is not gh's: left as it is.
  gitGlobal('--add', 'credential.https://github.com.helper', 'osxkeychain');
  gitGlobal('--add', 'credential.https://gist.github.com.helper', '');
  gitGlobal('--add', 'credential.https://gist.github.com.helper', '!/usr/local/bin/hub auth git-credential');
  assert.deepEqual(await forgetGhGitHelper(), { removed: [], kept: [...GH_HELPER_KEYS] });
  assert.equal(gitGlobal('--get-all', 'credential.https://github.com.helper'), 'osxkeychain');
  assert.equal(await gitUsesGh(), false);
});

test('forgetGhGitHelper also takes out what two setup-gits run at once leave (gh’s helper twice), and still nothing of the person’s', async (t) => {
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  t.after(() => fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, ''));
  const gh = '!/Users/ada/.local/bin/gh auth git-credential';
  const set = (key, values) => {
    try { gitGlobal('--unset-all', key); } catch { /* not there */ }
    for (const v of values) gitGlobal('--add', key, v);
  };
  // Two setup-gits whose writes interleaved: the empty value, then gh's helper twice.
  set(GH_HELPER_KEYS[0], ['', gh, gh]);
  set(GH_HELPER_KEYS[1], ['', gh]);
  assert.equal(await gitUsesGh(), true);
  assert.deepEqual(await forgetGhGitHelper(), { removed: [...GH_HELPER_KEYS], kept: [] });
  assert.equal(await gitUsesGh(), false);
  assert.doesNotMatch(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8'), /github\.com/);
  // A helper of the person's own among them, or gh's helper with no empty value before it: left as it is.
  set(GH_HELPER_KEYS[0], ['', gh, 'osxkeychain']);
  set(GH_HELPER_KEYS[1], [gh, gh]);
  assert.deepEqual(await forgetGhGitHelper(), { removed: [], kept: [...GH_HELPER_KEYS] });
  assert.deepEqual(gitValues(GH_HELPER_KEYS[0]), ['', gh, 'osxkeychain']);
  assert.deepEqual(gitValues(GH_HELPER_KEYS[1]), [gh, gh]);
});

test('git’s settings for gh are read and changed from a folder of Workbench’s own, never from the temporary folder', async (t) => {
  // A temporary folder no one may write: a folder Workbench made there, which another process could fill with a
  // repository of its own, would show as a failure.
  fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
  t.after(() => fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, ''));
  const tmp = scratch(t);
  fs.chmodSync(tmp, 0o500); // nothing can be made in it, so it stays empty, and goes like any other
  const gh = '!/Users/ada/.local/bin/gh auth git-credential';
  for (const key of GH_HELPER_KEYS) for (const v of ['', gh]) gitGlobal('--add', key, v);
  await withTmpdir(tmp, async () => {
    assert.equal(await gitUsesGh(), true);
    assert.deepEqual(await forgetGhGitHelper(), { removed: [...GH_HELPER_KEYS], kept: [] });
  });
  assert.deepEqual(fs.readdirSync(tmp), []);
  const own = path.join(process.env.HOME, '.workbench', 'tmp');
  assert.deepEqual(fs.readdirSync(own).filter((n) => n.startsWith('workbench-')), [], 'its folders there are gone');
});

test('isGhHelper: gh’s own helper line, its path quoted or not; nothing else', () => {
  assert.equal(isGhHelper('!/Users/ada/.local/bin/gh auth git-credential'), true);
  assert.equal(isGhHelper("!'/Users/Ada Lovelace/.local/bin/gh' auth git-credential"), true);
  assert.equal(isGhHelper('!/opt/homebrew/bin/gh auth git-credential'), true);
  for (const v of ['', 'osxkeychain', '!/usr/local/bin/hub auth git-credential', '!/x/gh auth git-credential --extra', '/x/gh auth git-credential', `!${GH_FAKE} auth git-credential`, null]) {
    assert.equal(isGhHelper(v), false, String(v));
  }
});

// ------------------------------------------------------------------ the list, sign-out, Terminal

test('ghRepos: the person’s repositories through gh api, organisations’ too, in the shape the clone sheet reads; [] when anything fails', async (t) => {
  const s = standIn(t);
  const logged = [];
  assert.deepEqual(await ghRepos({ ghPath: s.gh, env: s.env, log: (m) => logged.push(m) }), [], 'signed out');
  assert.equal(await ghReposOrNull({ ghPath: s.gh, env: s.env }), null);
  assert.ok(logged.some((m) => m.startsWith('GitHub\'s command-line tool could not list the repositories')));
  s.signIn();
  assert.deepEqual(await ghRepos({ ghPath: s.gh, env: s.env }), FAKE_REPOS.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private, pushedAt: r.pushed_at })));
  assert.deepEqual(s.calls().at(-1).argv, ['api', '--hostname', 'github.com', GH_REPOS_PATH]);
  assert.equal(GH_REPOS_PATH, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  const odd = [
    { full_name: 'evil/repo', clone_url: 'ext::sh -c touch% /tmp/pwned' },
    { full_name: '../../etc', clone_url: 'https://github.com/../../etc.git' },
    null, 7,
    { full_name: 'octo-cat/ok', clone_url: 'https://github.com/octo-cat/ok.git', private: 'yes' },
  ];
  assert.deepEqual(await ghRepos({ ghPath: s.gh, env: { ...s.env, FAKE_GH_REPOS: JSON.stringify(odd) } }),
    [{ fullName: 'octo-cat/ok', cloneUrl: 'https://github.com/octo-cat/ok.git', private: false, pushedAt: null }]);
  const many = Array.from({ length: 150 }, (_, i) => ({ full_name: `octo-cat/r${i}`, clone_url: `https://github.com/octo-cat/r${i}.git` }));
  assert.equal((await ghRepos({ ghPath: s.gh, env: { ...s.env, FAKE_GH_REPOS: JSON.stringify(many) } })).length, 100);
  for (const env of [{ FAKE_GH_API: 'fail' }, { FAKE_GH_REPOS: 'not json' }, { FAKE_GH_REPOS: '{"message":"Bad credentials"}' }]) {
    assert.deepEqual(await ghRepos({ ghPath: s.gh, env: { ...s.env, ...env } }), [], JSON.stringify(env));
  }
  assert.deepEqual(await ghRepos({ ghPath: null }), []);
});

test('ghLogout signs out with the login named, so gh asks nothing; it fails plainly otherwise', async (t) => {
  const s = standIn(t, { GH_TOKEN: 'person-token' });
  s.signIn('octo-cat');
  assert.deepEqual(await ghLogout({ ghPath: s.gh, env: s.env, login: 'octo-cat' }), { ok: true });
  assert.equal(s.signedInAs(), null);
  assert.deepEqual(s.calls().at(-1).argv, ['auth', 'logout', '--hostname', 'github.com', '--user', 'octo-cat']);
  assert.equal(s.calls().at(-1).tokens.GH_TOKEN, false, 'gh refuses to sign out while GH_TOKEN is set');
  const r = await ghLogout({ ghPath: s.gh, env: s.env, login: 'octo-cat' });
  assert.equal(r.ok, false);
  s.signIn('octo-cat');
  assert.equal((await ghLogout({ ghPath: s.gh, env: { ...s.env, FAKE_GH_LOGOUT: 'fail' }, login: 'octo-cat' })).ok, false);
  assert.deepEqual(await ghLogout({ ghPath: s.gh, env: s.env, login: 'not a login; rm' }), { ok: true }, 'a login that is not one is not passed');
  assert.deepEqual(s.calls().at(-1).argv, ['auth', 'logout', '--hostname', 'github.com']);
});

test('the steps for Terminal: gh through env -u GH_TOKEN -u GITHUB_TOKEN, the login with --scopes workflow, then setup-git', () => {
  const gh = '/Users/ada/.local/bin/gh';
  const unset = ['-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN'];
  assert.deepEqual(ghSignInProgram(gh), { program: '/usr/bin/env', args: [...unset, gh, 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--scopes', 'workflow'] });
  assert.deepEqual(ghSignInSteps(gh), [
    ghSignInProgram(gh),
    { program: '/usr/bin/env', args: [...unset, gh, 'auth', 'setup-git', '--hostname', 'github.com'] },
  ]);
  assert.deepEqual(ghSignOutProgram(gh), { program: '/usr/bin/env', args: [...unset, gh, 'auth', 'logout', '--hostname', 'github.com'] });
  assert.deepEqual(ghSignInProgram(GH_FAKE).args.slice(4, 6), [process.execPath, GH_FAKE], 'a node script runs with node');
  assert.equal(ghSignInCommand(gh), `${gh} auth login --hostname github.com --git-protocol https --web --scopes workflow && ${gh} auth setup-git --hostname github.com`);
  assert.equal(ghSignOutCommand("/home/Ada O'Neil/.local/bin/gh"), "'/home/Ada O'\\''Neil/.local/bin/gh' auth logout --hostname github.com");
});

test('the one-time code is read in both of the forms gh prints: with no terminal, and in a terminal', async (t) => {
  // gh 2.104.0 with no terminal (as Workbench runs it) printed "! One-time code (B2C1-9080) copied to clipboard" on the
  // owner's Mac, and the old pattern, which knew only "…your one-time code: ABCD-1234", missed it: no code was shown.
  for (const [form, extra] of [['no terminal', {}], ['terminal', { FAKE_GH_CODE_LINE: 'first-copy' }]]) {
    const s = standIn(t, { FAKE_GH_CODE: 'B2C1-9080', ...extra });
    const codes = [];
    const r = await startGhLogin({ ghPath: s.gh, env: s.env, onCode: (c) => codes.push(c.code) }).done;
    assert.equal(r.outcome, 'done', form);
    assert.deepEqual(codes, ['B2C1-9080'], form);
  }
});
