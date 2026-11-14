#!/usr/bin/env node
// A stand-in for GitHub's command-line tool, `gh`, for the tests of src/core/github.mjs, Agents & keys and the CLI.
// It never reaches a network, a keychain or GitHub, and holds no token. Run it with node, or through ghWrapper(), a
// small `gh` shell script that runs it (a gh found on a PATH, or put in ~/.local/bin, has to be called gh).
//
// - With no arguments it exits 0 at once.
// - Its sign-in is a file, FAKE_GH_STATE (default <HOME>/.config/gh/fake-state.json): {"user":"<login>"} when signed in.
// - `--version`: "gh version <FAKE_GH_VERSION, default 2.104.0> (2026-11-12)". FAKE_GH_VERSION=hang never answers;
//   broken exits 1.
// - `config get user -h github.com`: the login (exit 0), or `could not find key "user"` (exit 1) when signed out.
//   FAKE_GH_CONFIG=broken: gh's settings cannot be read (exit 2).
// - `auth status --json hosts`: {"hosts":{"github.com":[{…,"login":…}]}} or {"hosts":{}}, always exit 0.
// - `auth login`: refuses while GH_TOKEN or GITHUB_TOKEN is set, as gh does, and refuses flags gh does not know. Then
//   FAKE_GH_LOGIN says how it goes:
//     code (default)  prints the one-time code (FAKE_GH_CODE, default WDJB-MJHT) and the device page, as gh does with no
//                     terminal (on stderr; on stdout with FAKE_GH_LOGIN_OUT=stdout), waits FAKE_GH_LOGIN_DELAY_MS
//                     (default 50), signs in as FAKE_GH_USER (default octo-cat) and exits 0
//     wait            prints the code, then waits until it is stopped
//     deny            prints the code, waits, then fails as when the person denies it (exit 1)
//     fail            fails at once, with no code (exit 1)
//     question        asks gh's git question with no line break after it, and waits
//     silent          prints nothing, and waits
// - `auth setup-git --hostname github.com`: writes git's global settings as gh does (an empty helper, then
//   `!<FAKE_GH_SELF> auth git-credential`, for github.com and gist.github.com), through the git on the PATH. Fails when
//   signed out, or with FAKE_GH_SETUP_GIT=fail. FAKE_GH_SETUP_GIT_PAUSE_MS: it waits that long between each host's two
//   writes, as a slow setup-git would.
// - `auth logout --hostname github.com [--user <login>]`: signs out; fails when signed out, for another user, or with
//   FAKE_GH_LOGOUT=fail.
// - `api [--hostname github.com] <path>`: FAKE_GH_REPOS (JSON text), or two repositories; exit 4 when signed out, 1 with
//   FAKE_GH_API=fail.
// - FAKE_GH_LOG=<file> gets one JSON line per call: { argv, stdin, tokens, prompt, telemetry, host, pid }.
// - A program that waits ends by itself after 60 seconds, so a broken test run never leaves it behind for long.
//
// Imported, it gives the tests ghWrapper, the archives of a made-up release (zipOf, tarGzOf, fakeRelease) and a fetch
// that serves it (releaseFetch).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const GH_FAKE = fileURLToPath(import.meta.url);
export const FAKE_CODE = 'WDJB-MJHT';
/** What `gh api /user/repos…` prints unless FAKE_GH_REPOS says otherwise. */
export const FAKE_REPOS = [
  { full_name: 'octo-cat/app', clone_url: 'https://github.com/octo-cat/app.git', private: true, pushed_at: '2026-11-10T09:00:00Z' },
  { full_name: 'octo-org/site', clone_url: 'https://github.com/octo-org/site.git', private: false, pushed_at: '2026-11-01T09:00:00Z' },
];

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The shell script of a `gh` that runs this stand-in with this node (with `version`, it says that version). */
export function wrapperScript({ version } = {}) {
  return [
    '#!/bin/sh',
    ...(version ? [`FAKE_GH_VERSION=${quote(version)}`, 'export FAKE_GH_VERSION'] : []),
    'FAKE_GH_SELF="$0"',
    'export FAKE_GH_SELF',
    `exec ${quote(process.execPath)} ${quote(GH_FAKE)} "$@"`,
    '',
  ].join('\n');
}

/** Put a `gh` (mode 0755) that runs this stand-in in `dir`, and return its path. */
export function ghWrapper(dir, { name = 'gh', version } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, wrapperScript({ version }), { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

// ------------------------------------------------------------------ archives of a made-up release

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const TYPE_BITS = { file: 0o100000, dir: 0o040000, symlink: 0o120000 };

/**
 * A zip archive (stored, not compressed), made by "Unix" so unzip gives each entry its mode.
 * @param {{ name: string, type?: 'file'|'dir'|'symlink', data?: string|Buffer, target?: string, mode?: number }[]} entries
 */
export function zipOf(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const type = e.type || 'file';
    const name = Buffer.from(type === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name);
    const data = type === 'dir' ? Buffer.alloc(0) : Buffer.from(type === 'symlink' ? e.target : (e.data ?? ''));
    const crc = crc32(data);
    const mode = (TYPE_BITS[type] | (e.mode ?? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644))) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt16LE(0, 34);
    c.writeUInt16LE(0, 36);
    c.writeUInt32LE((mode * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const octal = (n, width) => n.toString(8).padStart(width, '0');

/** A gzipped tar archive (ustar), with the same entries as zipOf takes. */
export function tarGzOf(entries) {
  const blocks = [];
  for (const e of entries) {
    const type = e.type || 'file';
    const data = type === 'file' ? Buffer.from(e.data ?? '') : Buffer.alloc(0);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write(`${octal(e.mode ?? (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644), 7)}\0`, 100);
    h.write(`${octal(0, 7)}\0`, 108);
    h.write(`${octal(0, 7)}\0`, 116);
    h.write(`${octal(data.length, 11)}\0`, 124);
    h.write(`${octal(0, 11)}\0`, 136);
    h.write('        ', 148);
    h.write(type === 'dir' ? '5' : type === 'symlink' ? '2' : '0', 156);
    if (type === 'symlink') h.write(e.target, 157, 100, 'utf8');
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${octal(sum, 6)}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * A made-up gh release for one computer, laid out as GitHub's: `gh_<v>_<os>_<arch>.zip|.tar.gz`, holding
 * `gh_<v>_<os>_<arch>/bin/gh` (by default a wrapper that runs this stand-in and says version <v>), a LICENSE and a man
 * page; and a checksums file with a line for it among the other assets' lines.
 * @param {{ version?: string, platform?: 'darwin'|'linux', arch?: 'arm64'|'x64', program?: string|Buffer,
 *   symlink?: boolean }} [o] symlink: bin/gh is a link to /bin/sh instead of a program
 */
export function fakeRelease({ version = '2.104.0', platform = 'darwin', arch = 'arm64', program, symlink = false } = {}) {
  const osName = { darwin: 'macOS', linux: 'linux' }[platform];
  const archName = { arm64: 'arm64', x64: 'amd64' }[arch];
  const folder = `gh_${version}_${osName}_${archName}`;
  const kind = platform === 'darwin' ? 'zip' : 'tar.gz';
  const name = `${folder}.${kind}`;
  const entries = [
    { name: `${folder}/`, type: 'dir' },
    { name: `${folder}/bin/`, type: 'dir' },
    symlink ? { name: `${folder}/bin/gh`, type: 'symlink', target: '/bin/sh' } : { name: `${folder}/bin/gh`, data: program ?? wrapperScript({ version }), mode: 0o755 },
    { name: `${folder}/LICENSE`, data: 'MIT License\n' },
    { name: `${folder}/share/`, type: 'dir' },
    { name: `${folder}/share/man/`, type: 'dir' },
    { name: `${folder}/share/man/man1/`, type: 'dir' },
    { name: `${folder}/share/man/man1/gh.1`, data: '.TH GH 1\n' },
  ];
  const bytes = kind === 'zip' ? zipOf(entries) : tarGzOf(entries);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const line = (file, sum) => `${sum}  ${file}`;
  const fake = (file) => crypto.createHash('sha256').update(file).digest('hex');
  const others = ['linux_386.tar.gz', 'linux_amd64.tar.gz', 'linux_arm64.tar.gz', 'macOS_amd64.zip', 'macOS_arm64.zip', 'macOS_universal.pkg']
    .map((s) => `gh_${version}_${s}`).filter((f) => f !== name);
  // A name that starts like this one's must not be taken for it.
  const lines = [...others.map((f) => line(f, fake(f))), line(`${name}.sig`, fake(`${name}.sig`)), line(name, sha256)].sort();
  return { version, name, bytes, sha256, checksums: `${lines.join('\n')}\n`, checksumsName: `gh_${version}_checksums.txt` };
}

/**
 * A fetch for ghInstall that serves `release` the way github.com does: /releases/latest answers 302 to /tag/v<v>, and
 * /releases/download/v<v>/<file> the checksums and the archive. Everything else is 404. `calls` records each address.
 * @param {object} release fakeRelease()'s
 * @param {{ calls?: object[], latest?: string, fail?: Error, hang?: boolean, archive?: Buffer, status?: number }} [o]
 *   latest: another Location; fail: thrown for every request (no network); hang: the archive never comes until the
 *   request is stopped; archive: other bytes served for the archive (a checksum that does not match)
 */
export function releaseFetch(release, { calls = [], latest, fail, hang = false, archive, status } = {}) {
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect ?? null, signal: !!init.signal });
    if (fail) throw fail;
    if (url === 'https://github.com/cli/cli/releases/latest') {
      if (status) return new Response('Server error', { status });
      return new Response(null, { status: 302, headers: { location: latest ?? `https://github.com/cli/cli/releases/tag/v${release.version}` } });
    }
    const base = `https://github.com/cli/cli/releases/download/v${release.version}/`;
    if (url === `${base}${release.checksumsName}`) return new Response(release.checksums, { status: 200 });
    if (url === `${base}${release.name}`) {
      if (hang) {
        return new Promise((resolve, reject) => {
          const stop = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) stop();
          init.signal?.addEventListener('abort', stop);
        });
      }
      const bytes = archive ?? release.bytes;
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    return new Response('Not Found', { status: 404 });
  };
  return { fetchImpl, calls };
}

// ------------------------------------------------------------------ the program

function stateFile(env) {
  if (env.FAKE_GH_STATE) return env.FAKE_GH_STATE;
  return path.join(env.HOME || '/nonexistent', '.config', 'gh', 'fake-state.json');
}

function readState(env) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(env), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeState(env, state) {
  const file = stateFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function stdinKind() {
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO() || st.isSocket()) return 'pipe';
    if (st.isCharacterDevice()) return 'ignored';
    return 'other';
  } catch {
    return 'closed';
  }
}

function record(argv, env) {
  if (!env.FAKE_GH_LOG) return;
  fs.appendFileSync(env.FAKE_GH_LOG, `${JSON.stringify({
    argv, stdin: stdinKind(), tokens: { GH_TOKEN: 'GH_TOKEN' in env, GITHUB_TOKEN: 'GITHUB_TOKEN' in env },
    prompt: env.GH_PROMPT_DISABLED ?? null, telemetry: env.GH_TELEMETRY ?? null, host: 'GH_HOST' in env, pid: process.pid,
  })}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function quit(code, text = '') {
  if (text) process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(code);
}

/** Wait until stopped (or 60 seconds). */
function waitForever() {
  setTimeout(() => process.exit(3), 60_000);
  setInterval(() => {}, 1000);
}

/** The value after a flag (`--name value` or `--name=value`), or null. */
function flag(argv, ...names) {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1] ?? null;
      if (argv[i].startsWith(`${n}=`)) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}

const LOGIN_FLAGS = new Set(['--hostname', '-h', '--git-protocol', '-p', '--scopes', '-s']);
const LOGIN_SWITCHES = new Set(['--web', '-w', '--clipboard', '-c', '--insecure-storage', '--skip-ssh-key', '--with-token']);

async function login(argv, env) {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (k in env) quit(1, `The value of the ${k} environment variable is being used for authentication.\nTo have GitHub CLI store credentials instead, first clear the value from the environment.`);
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i].split('=')[0];
    if (LOGIN_FLAGS.has(a)) { if (!argv[i].includes('=')) i += 1; continue; }
    if (!LOGIN_SWITCHES.has(a)) quit(1, `unknown flag: ${argv[i]}\n\nUsage:  gh auth login [flags]`);
  }
  const mode = env.FAKE_GH_LOGIN || 'code';
  const out = env.FAKE_GH_LOGIN_OUT === 'stdout' ? process.stdout : process.stderr;
  const say = (text) => new Promise((r) => out.write(text, r));
  const delay = Number(env.FAKE_GH_LOGIN_DELAY_MS ?? 50);
  if (mode === 'fail') quit(1, 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com');
  if (mode === 'silent') return waitForever();
  if (mode === 'question') {
    await say('? Authenticate Git with your GitHub credentials? (Y/n) ');
    return waitForever();
  }
  // What gh 2.104.0 printed with no terminal on the owner's Mac (2026-11-13): the code in brackets, "copied to
  // clipboard". FAKE_GH_CODE_LINE=first-copy prints the form gh uses in a terminal instead.
  const code = env.FAKE_GH_CODE || FAKE_CODE;
  const line = env.FAKE_GH_CODE_LINE === 'first-copy' ? `! First copy your one-time code: ${code}` : `! One-time code (${code}) copied to clipboard`;
  await say(`${line}\nOpen this URL to continue in your web browser: https://github.com/login/device\n`);
  if (mode === 'wait') return waitForever();
  await sleep(delay);
  if (mode === 'deny') quit(1, 'failed to authenticate via web browser: The user has denied your application access.');
  const user = env.FAKE_GH_USER || 'octo-cat';
  writeState(env, { user, scopes: flag(argv, '--scopes', '-s') });
  await say(`✓ Authentication complete.\n- gh config set -h github.com git_protocol https\n✓ Configured git protocol\n✓ Logged in as ${user}\n`);
  process.exit(0);
}

async function setupGit(env, state) {
  if (!state.user) quit(1, 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.');
  if (env.FAKE_GH_SETUP_GIT === 'fail') quit(1, 'failed to configure git credential helper: could not lock config file');
  const self = env.FAKE_GH_SELF || GH_FAKE;
  const helper = `!${/[ $\\]/.test(self) ? `'${self}'` : self} auth git-credential`;
  const pause = Number(env.FAKE_GH_SETUP_GIT_PAUSE_MS || 0);
  for (const host of ['https://github.com', 'https://gist.github.com']) {
    execFileSync('git', ['config', '--global', '--replace-all', `credential.${host}.helper`, ''], { stdio: 'pipe' });
    if (pause > 0) await sleep(pause);
    execFileSync('git', ['config', '--global', '--add', `credential.${host}.helper`, helper], { stdio: 'pipe' });
  }
  process.exit(0);
}

async function main(argv, env) {
  if (!argv.length) process.exit(0);
  record(argv, env);
  const state = readState(env);
  const [a, b] = argv;
  if (a === '--version') {
    const v = env.FAKE_GH_VERSION || '2.104.0';
    if (v === 'hang') return waitForever();
    if (v === 'broken') quit(1, 'dyld: Library not loaded');
    process.stdout.write(`gh version ${v} (2026-11-12)\nhttps://github.com/cli/cli/releases/tag/v${v}\n`);
    process.exit(0);
  }
  if (a === 'config' && b === 'get') {
    if (env.FAKE_GH_CONFIG === 'broken') quit(2, 'failed to read configuration: yaml: line 3: mapping values are not allowed in this context');
    const host = flag(argv, '-h', '--host');
    if (argv[2] === 'user' && host === 'github.com' && state.user) {
      process.stdout.write(`${state.user}\n`);
      process.exit(0);
    }
    quit(1, `could not find key "${argv[2]}"`);
  }
  if (a === 'auth' && b === 'status') {
    if (!argv.includes('--json')) quit(1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
    const hosts = state.user ? { 'github.com': [{ state: 'success', active: true, host: 'github.com', login: state.user, tokenSource: 'keyring', scopes: 'gist, read:org, repo, workflow', gitProtocol: 'https' }] } : {};
    process.stdout.write(`${JSON.stringify({ hosts })}\n`);
    process.exit(0);
  }
  if (a === 'auth' && b === 'login') return login(argv, env);
  if (a === 'auth' && b === 'setup-git') return setupGit(env, state);
  if (a === 'auth' && b === 'logout') {
    const user = flag(argv, '--user', '-u');
    if (!state.user) quit(1, 'not logged in to any hosts');
    if (user && user !== state.user) quit(1, `not logged in to github.com account ${user}`);
    if (env.FAKE_GH_LOGOUT === 'fail') quit(1, 'failed to remove the token from the keyring: the keyring is locked');
    writeState(env, {});
    quit(0, `✓ Logged out of github.com account ${state.user}`);
  }
  if (a === 'api') {
    if (!state.user) quit(4, 'To get started with GitHub CLI, please run:  gh auth login');
    if (env.FAKE_GH_API === 'fail') quit(1, 'HTTP 502: Bad Gateway (https://api.github.com/user/repos)');
    process.stdout.write(env.FAKE_GH_REPOS ?? JSON.stringify(FAKE_REPOS));
    process.exit(0);
  }
  quit(1, `unknown command "${argv.join(' ')}" for "gh"`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(GH_FAKE);
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2), process.env);
