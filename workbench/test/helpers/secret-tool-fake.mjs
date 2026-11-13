#!/usr/bin/env node
// A stand-in for libsecret's `secret-tool`, used by test/keys.test.mjs. It never talks to D-Bus: its items live in a
// JSON file. Run with node (process.execPath).
//
// It follows secret-tool's manual page (Ubuntu noble; env-secrets.md 5.3):
// - `store --label=<label> <attribute> <value> …` reads the secret from stdin until EOF, and keeps everything, a
//   trailing newline included. An item with the same attributes is replaced.
// - `lookup <attribute> <value> …` prints the secret of the first item that has all those attributes, with no newline
//   (stdout is not a terminal), and exits 0; when none matches it prints nothing and exits 1.
// - `clear <attribute> <value> …` removes every item that matches, and exits 0.
// - Attributes come in pairs; a missing label or an odd count is a usage error (exit 2).
//
// Environment:
//   FAKE_SECRET_TOOL_DB    the items: { items: [{ label, attributes: { name: value }, secret /* base64 */ }] }
//   FAKE_SECRET_TOOL_LOG   one JSON line per process: { argv, envNames, stdinBytes }. Never the secret
//   FAKE_SECRET_TOOL_MODE  '' (default) | 'no-bus': every command fails as with no D-Bus session |
//                          'locked': store and lookup fail as with a locked collection
import fs from 'node:fs';

const env = process.env;
setTimeout(() => process.exit(9), 20_000).unref();

function loadDb() {
  if (!env.FAKE_SECRET_TOOL_DB) return { items: [] };
  try { return JSON.parse(fs.readFileSync(env.FAKE_SECRET_TOOL_DB, 'utf8')); } catch { return { items: [] }; }
}
function saveDb(db) {
  if (env.FAKE_SECRET_TOOL_DB) fs.writeFileSync(env.FAKE_SECRET_TOOL_DB, JSON.stringify(db, null, 2));
}

const usage = () => {
  process.stderr.write('usage: secret-tool store --label=\'label\' attribute value ...\n       secret-tool lookup attribute value ...\n       secret-tool clear attribute value ...\n');
  return 2;
};
const matches = (item, attrs) => Object.entries(attrs).every(([k, v]) => item.attributes[k] === v);

function pairs(list) {
  if (!list.length || list.length % 2) return null;
  const out = {};
  for (let i = 0; i < list.length; i += 2) out[list[i]] = list[i + 1];
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return; // loaded with no arguments: nothing to do
  const [cmd, ...rest] = argv;
  let stdin = Buffer.alloc(0);
  if (cmd === 'store') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    stdin = Buffer.concat(chunks);
  }
  if (env.FAKE_SECRET_TOOL_LOG) {
    fs.appendFileSync(env.FAKE_SECRET_TOOL_LOG, JSON.stringify({ argv, envNames: Object.keys(env).sort(), stdinBytes: stdin.length }) + '\n');
  }
  const mode = env.FAKE_SECRET_TOOL_MODE || '';
  if (mode === 'no-bus') {
    process.stderr.write('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n');
    return 1;
  }
  if (cmd === 'store') {
    let label = null;
    const attrList = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith('--label=')) label = rest[i].slice('--label='.length);
      else if (rest[i] === '--label' || rest[i] === '-l') label = rest[++i] ?? null;
      else attrList.push(rest[i]);
    }
    const attrs = pairs(attrList);
    if (label == null || !attrs) return usage();
    if (mode === 'locked') {
      process.stderr.write('secret-tool: Cannot create an item in a locked collection\n');
      return 1;
    }
    const db = loadDb();
    db.items = db.items.filter(it => !(Object.keys(it.attributes).length === Object.keys(attrs).length && matches(it, attrs)));
    db.items.push({ label, attributes: attrs, secret: stdin.toString('base64') });
    saveDb(db);
    return 0;
  }
  if (cmd === 'lookup' || cmd === 'clear') {
    const attrs = pairs(rest);
    if (!attrs) return usage();
    const db = loadDb();
    if (cmd === 'clear') {
      db.items = db.items.filter(it => !matches(it, attrs));
      saveDb(db);
      return 0;
    }
    if (mode === 'locked') {
      process.stderr.write('secret-tool: Cannot get secret of a locked object\n');
      return 1;
    }
    const item = db.items.find(it => matches(it, attrs));
    if (!item) return 1;
    process.stdout.write(Buffer.from(item.secret, 'base64'));
    return 0;
  }
  return usage();
}

main().then((code) => { if (code != null) process.exitCode = code; });
