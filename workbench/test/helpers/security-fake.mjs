#!/usr/bin/env node
// A stand-in for macOS's /usr/bin/security, used by test/keys.test.mjs. It never opens a keychain: its items live in
// a JSON file. Run with node (process.execPath), so it needs no exec bit and works on Linux too.
//
// It reproduces what env-secrets.md (5.1) observed of `security -i` on macOS 27:
// - It reads commands on stdin and prints no prompt on a pipe. It takes only `-i`: anything else in argv exits 2,
//   since Workbench never passes a command, let alone a value, as an argument.
// - Words: whitespace separates them; '…' and "…" group one, and a quoted part is a whole word (`"a b"c` gives `a b`,
//   then `c`). A backslash makes the next character literal everywhere, even inside single quotes. No $VAR, ~,
//   wildcards or #. An unbalanced quote or a trailing backslash ends at the end of the line. A CR before the LF is
//   dropped.
// - It reads at most 4095 bytes at a time, and what follows runs as the next command line.
// - Command names match by prefix: the first in the real table's order wins, so `a` runs add-generic-password.
// - The exit status is the last command's only: 1 when it failed, else 0. Each failure prints
//   `<command>: returned <n>` on stderr.
// - Errors echo the words parsed: `security: unknown command "<word>"`, `security: help: no such command: <word>`.
//
// It knows add-generic-password (-a -s -l -j -w -X, flags -U -A, and -T), find-generic-password (-a -s, -w, -g) and
// delete-generic-password (-a -s), plus help. The other commands of the real table are known for prefix matching
// only: they fail, and are recorded, so a test sees it if one ever runs. Item data is kept as hex.
// find-generic-password -w prints the data as text when every byte is printable ASCII, and as hex otherwise (what the
// real one is believed to do; not confirmed).
//
// Environment:
//   FAKE_SECURITY_DB    the items: { items: [{ service, account, label, data /* hex */ }] }
//   FAKE_SECURITY_LOG   one JSON line per process: { argv, envNames, commands, lines, bytes }. Only names: never a
//                       word of a command, which may hold a value
//   FAKE_SECURITY_MODE  '' (default) | 'canceled': keychain commands fail as when the person cancels the dialog that
//                       asks to unlock it | 'no-window': they fail as over SSH ("User interaction is not allowed.") |
//                       'echo': they fail and repeat every word they were given on stderr, as a parse error would
import fs from 'node:fs';

const env = process.env;
const LINE_MAX = 4095;
const SELF_DESTRUCT_MS = 20_000;
setTimeout(() => process.exit(9), SELF_DESTRUCT_MS).unref();

/** The real command table's order (security help), which decides prefix matches. */
const TABLE = ['help', 'list-keychains', 'list-smartcards', 'default-keychain', 'login-keychain', 'create-keychain',
  'delete-keychain', 'lock-keychain', 'unlock-keychain', 'set-keychain-settings', 'set-keychain-password',
  'show-keychain-info', 'dump-keychain', 'create-keypair', 'add-generic-password', 'add-internet-password',
  'add-certificates', 'find-generic-password', 'delete-generic-password', 'set-generic-password-partition-list',
  'find-internet-password', 'delete-internet-password', 'set-internet-password-partition-list', 'find-key',
  'set-key-partition-list', 'find-certificate', 'find-identity', 'delete-certificate', 'delete-identity',
  'set-identity-preference', 'get-identity-preference', 'create-db', 'export', 'import', 'cms', 'install-mds',
  'add-trusted-cert', 'remove-trusted-cert', 'dump-trust-settings', 'user-trust-settings-enable',
  'trust-settings-export', 'trust-settings-import', 'verify-cert', 'authorize', 'authorizationdb',
  'execute-with-privileges', 'leaks', 'error', 'create-filevaultmaster-keychain', 'smartcards'];

const commandFor = (word) => TABLE.find(c => c.startsWith(word)) || null;

/** The lines `security -i` would read: at most LINE_MAX bytes each, newline and a CR before it dropped. */
function readLines(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    const end = Math.min(nl === -1 ? buf.length : nl + 1, i + LINE_MAX);
    let s = buf.subarray(i, end).toString('utf8');
    i = end;
    if (s.endsWith('\n')) s = s.slice(0, -1);
    if (s.endsWith('\r')) s = s.slice(0, -1);
    out.push(s);
  }
  return out;
}

/** The words of one line, by the rules above. */
function words(line) {
  const out = [];
  const space = (c) => c === ' ' || c === '\t';
  let i = 0;
  while (i < line.length) {
    while (i < line.length && space(line[i])) i++;
    if (i >= line.length) break;
    let w = '';
    const q = line[i] === '"' || line[i] === "'" ? line[i] : null;
    if (q) i++;
    while (i < line.length && (q ? line[i] !== q : !space(line[i]))) {
      if (line[i] === '\\') {
        if (i + 1 < line.length) w += line[i + 1];
        i += 2;
      } else {
        w += line[i++];
      }
    }
    if (q) i++; // past the closing quote; whatever follows starts a new word
    out.push(w);
  }
  return out;
}

function loadDb() {
  if (!env.FAKE_SECURITY_DB) return { items: [] };
  try { return JSON.parse(fs.readFileSync(env.FAKE_SECURITY_DB, 'utf8')); } catch { return { items: [] }; }
}
function saveDb(db) {
  if (env.FAKE_SECURITY_DB) fs.writeFileSync(env.FAKE_SECURITY_DB, JSON.stringify(db, null, 2));
}

const say = (text) => process.stdout.write(text);
const complain = (text) => process.stderr.write(text);

/** getopt for one command: { values: Map, flags: Set, rest: [] } or { error }. */
function options(args, withValue, flags) {
  const out = { values: new Map(), flags: new Set(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.length === 2 && a[0] === '-') {
      if (flags.includes(a)) { out.flags.add(a); continue; }
      if (withValue.includes(a)) {
        if (i + 1 >= args.length) return { error: `option requires an argument -- ${a[1]}` };
        if (a === '-T') out.values.set(a, [...(out.values.get(a) || []), args[++i]]);
        else out.values.set(a, args[++i]);
        continue;
      }
      return { error: `illegal option -- ${a.slice(1)}` };
    }
    out.rest.push(a);
  }
  return out;
}

const USAGE = {
  'add-generic-password': 'Usage: add-generic-password [-a account] [-s service] [-w password] [-X hex] [-U] [keychain]\n',
  'find-generic-password': 'Usage: find-generic-password [-a account] [-s service] [-g] [-w] [keychain]\n',
  'delete-generic-password': 'Usage: delete-generic-password [-a account] [-s service] [keychain]\n',
};
const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n';

/** Fail as the mode says, for a command that would open the keychain; null when the mode lets it through. */
function modeFailure(cmd, args) {
  const mode = env.FAKE_SECURITY_MODE || '';
  if (mode === 'canceled') { complain(`security: ${cmd}: User canceled the operation.\n`); return 128; }
  if (mode === 'no-window') { complain(`security: ${cmd}: User interaction is not allowed.\n`); return 36; }
  if (mode === 'echo') { complain(`security: ${cmd}: could not use: ${args.join(' ')}\n`); return 1; }
  return null;
}

const printable = (buf) => buf.every(b => b >= 0x20 && b <= 0x7e);
const find = (db, service, account) => db.items.findIndex(it => (service == null || it.service === service) && (account == null || it.account === account));

function addGeneric(args) {
  const o = options(args, ['-a', '-s', '-l', '-j', '-w', '-X', '-c', '-C', '-D', '-G', '-T'], ['-U', '-A']);
  if (o.error || o.rest.length || !o.values.has('-a') || !o.values.has('-s') || (!o.values.has('-w') && !o.values.has('-X'))) {
    if (o.error) complain(`add-generic-password: ${o.error}\n`);
    complain(USAGE['add-generic-password']);
    return 2;
  }
  const failed = modeFailure('add-generic-password', args);
  if (failed != null) return failed;
  let data;
  if (o.values.has('-X')) {
    const hex = o.values.get('-X');
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) { complain('security: Invalid hex string\n'); return 1; }
    data = hex.toLowerCase();
  } else {
    data = Buffer.from(o.values.get('-w'), 'utf8').toString('hex');
  }
  const db = loadDb();
  const at = find(db, o.values.get('-s'), o.values.get('-a'));
  if (at !== -1 && !o.flags.has('-U')) {
    complain('security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\n');
    return 45;
  }
  const item = { service: o.values.get('-s'), account: o.values.get('-a'), label: o.values.get('-l') ?? o.values.get('-s'), data };
  if (at === -1) db.items.push(item); else db.items[at] = item;
  saveDb(db);
  return 0;
}

function findGeneric(args) {
  const o = options(args, ['-a', '-s', '-l', '-j', '-c', '-C', '-D', '-G'], ['-g', '-w']);
  if (o.error || o.rest.length) {
    if (o.error) complain(`find-generic-password: ${o.error}\n`);
    complain(USAGE['find-generic-password']);
    return 2;
  }
  const failed = modeFailure('find-generic-password', args);
  if (failed != null) return failed;
  const db = loadDb();
  const at = find(db, o.values.get('-s'), o.values.get('-a'));
  if (at === -1) { complain(NOT_FOUND); return 44; }
  const data = Buffer.from(db.items[at].data, 'hex');
  if (o.flags.has('-w')) say(`${printable(data) ? data.toString('latin1') : data.toString('hex')}\n`);
  else say(`keychain: "login.keychain-db"\nclass: "genp"\n`);
  return 0;
}

function deleteGeneric(args) {
  const o = options(args, ['-a', '-s', '-l', '-j', '-c', '-C', '-D', '-G'], []);
  if (o.error || o.rest.length) {
    if (o.error) complain(`delete-generic-password: ${o.error}\n`);
    complain(USAGE['delete-generic-password']);
    return 2;
  }
  const failed = modeFailure('delete-generic-password', args);
  if (failed != null) return failed;
  const db = loadDb();
  const at = find(db, o.values.get('-s'), o.values.get('-a'));
  if (at === -1) { complain(NOT_FOUND); return 44; }
  db.items.splice(at, 1);
  saveDb(db);
  say('password has been deleted.\n');
  return 0;
}

function help(args) {
  if (!args.length) { say(`Usage: security [-h] [-i] [-l] [-p prompt] [-q] [-v] [command] [opt ...]\n${TABLE.join('\n')}\n`); return 0; }
  let status = 0;
  for (const a of args) {
    const c = commandFor(a);
    if (c) say(USAGE[c] || `Usage: ${c}\n`);
    else { complain(`security: help: no such command: ${a}\n`); status = 1; }
  }
  return status;
}

const RUN = { help, 'add-generic-password': addGeneric, 'find-generic-password': findGeneric, 'delete-generic-password': deleteGeneric };

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return; // loaded with no arguments (a test runner looking at every file): nothing to do
  const ran = [];
  const chunks = [];
  if (argv.length === 1 && argv[0] === '-i') for await (const c of process.stdin) chunks.push(c);
  const input = Buffer.concat(chunks);
  const lines = readLines(input);
  const record = () => {
    if (!env.FAKE_SECURITY_LOG) return;
    fs.appendFileSync(env.FAKE_SECURITY_LOG, JSON.stringify({ argv, envNames: Object.keys(env).sort(), commands: ran, lines: lines.length, bytes: input.length }) + '\n');
  };
  if (argv.length !== 1 || argv[0] !== '-i') {
    complain('fake security: Workbench only ever runs security -i\n');
    record();
    process.exit(2);
  }
  let status = 0;
  for (const line of lines) {
    const w = words(line);
    if (!w.length) continue;
    const cmd = commandFor(w[0]);
    if (!cmd) {
      complain(`security: unknown command "${w[0]}"\n`);
      ran.push('unknown');
      status = 1;
      continue;
    }
    ran.push(cmd);
    const code = RUN[cmd] ? RUN[cmd](w.slice(1)) : (complain(`fake security: ${cmd} is not part of the stand-in\n`), 1);
    if (code !== 0) complain(`${cmd}: returned ${code}\n`);
    status = code === 0 ? 0 : 1;
  }
  record();
  process.exitCode = status;
}

main();
