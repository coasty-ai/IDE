// The files of a project, for the file view: the list of them, one file read, one file saved, and the lines of a file
// that an agent's work added or changed.
//
// Paths come from the page, and an agent can steer what it asks for (agents name files and make links), so every path
// is checked here (checkPath) and again by the engine: relative, with "/" between its parts, nothing that climbs out,
// nothing in git's own folder, and, by its real path, nothing outside the folder it is relative to. A link is shown as
// a link: it is never followed to read or write what it points at.
//
// Once a path is checked, a file is read or saved standing in the folder that holds it (standingIn): by its bare name
// in that folder, not by a path an agent could change meanwhile by swapping a folder on the way for a link.
//
// A save is atomic. The new bytes go into a new file beside the original, which is then renamed over it. That file is
// the one exception to privateTemp(): a rename is atomic only within one folder's volume.
//
// Every git call goes through git() in workspace.mjs. Every refusal is a plain sentence: Node's and git's own words go
// only in an error's `.detail`, for the log.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git, privateTemp } from './workspace.mjs';
import { shownValue } from './keys.mjs';
import { looksLikeSecret } from '../shared/secretshape.mjs';

/** The largest file the view shows or saves, in bytes: 1 MB. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** The most files listFiles gives. */
export const MAX_LIST_FILES = 50_000;
/** The longest path the view takes, in bytes of UTF-8. */
export const MAX_PATH_BYTES = 4096;
/** How old the sibling of a save must be before a later save in its folder takes it for one cut short and removes it. */
export const LEFTOVER_MS = 10 * 60_000;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
/** Opening a FIFO with this returns at once, writer or not (it changes nothing for a regular file). */
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** UTF-8 that must be whole: anything else throws. A BOM is left for the caller to see. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** The longest name of one file, in bytes, on the file systems Workbench runs on. */
const NAME_MAX = 255;
/** The name of the sibling a save writes beside a file (see saveName). */
const SAVE_NAME = /^\.[\s\S]+\.workbench-save-[0-9a-f]{16}$/;
/**
 * The diff flags of workspace.mjs's patches (PATCH, which patchesOf uses), and no others: diff-index in place of
 * diff-tree, since one side is the working folder, which needs no -r.
 */
const DIFF = ['-c', 'core.quotePath=false', '-c', `core.bigFileThreshold=${2 * 1024 * 1024}`, '--literal-pathspecs',
  'diff-index', '-p', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
const MISSING = Object.freeze({ kind: 'missing', hash: null, size: 0, eol: 'none', bom: false });

// ------------------------------------------------------------------ plain errors

/**
 * An error a person can read. `why` is 'refused', or 'changed' for a save over a file that changed (with `hash`, the
 * file's hash now). `cause`'s own words, Node's or git's, go only in `.detail`, for the log.
 */
function plainError(message, { why = 'refused', hash, cause } = {}) {
  const e = new Error(message);
  e.plain = true;
  e.why = why;
  if (hash !== undefined) e.hash = hash;
  if (cause) {
    e.cause = cause;
    e.detail = String(cause.stderr || cause.message || '').trim();
  }
  return e;
}

/** A plain error for the ways git itself can fail to run, or null (workspace.mjs says the same). */
function gitTrouble(e) {
  if (e && e.code === 'ENOENT') return plainError('Git is not installed, or it is not on the PATH.', { cause: e });
  if (e && e.killed) return plainError('Git took too long and was stopped.', { cause: e });
  if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return plainError('Git gave back more than Workbench can read at once.', { cause: e });
  return null;
}

/** A path as a sentence names it: as it is, or its end when it is very long. */
function shown(rel) {
  const chars = Array.from(String(rel));
  return chars.length > 160 ? `…${chars.slice(-159).join('')}` : String(rel);
}

/** Nothing is there, or nothing could be: a folder on the way is missing or is a file, or the name is too long. */
const gone = e => !!e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'ENAMETOOLONG');

/** A plain error for a file Workbench could not read (`verb` 'open') or save (`verb` 'change'). */
function fsFailure(e, rel, verb) {
  if (e && e.plain) return e;
  const code = e && e.code;
  const doing = verb === 'open' ? 'read' : 'save';
  if (code === 'EACCES' || code === 'EPERM') return plainError(`Workbench is not allowed to ${doing} ${shown(rel)}.`, { cause: e });
  if (code === 'ENOSPC' || code === 'EDQUOT') return plainError(`There is no room left on the disk, so ${shown(rel)} was not saved.`, { cause: e });
  if (code === 'EROFS') return plainError(`${shown(rel)} is on a disk Workbench cannot write to.`, { cause: e });
  return plainError(`Workbench could not ${doing} ${shown(rel)}.`, { cause: e });
}

const notThere = rel => plainError(`${shown(rel)} is not there any more, and Workbench does not make new files.`);
const isLink = rel => plainError(`${shown(rel)} is a link, and Workbench does not write through links.`);
const tooLarge = rel => plainError(`${shown(rel)} is larger than 1 MB, so Workbench does not edit it.`);
const moved = (rel, verb) => plainError(verb === 'open' ? `The folder that holds ${shown(rel)} moved while Workbench read it.`
  : `The folder that holds ${shown(rel)} moved while Workbench saved it, so nothing was written.`);

function notAFile(st, rel, verb) {
  if (st.isDirectory()) return plainError(`${shown(rel)} is a folder, not a file.`);
  return plainError(`${shown(rel)} is not a regular file, so Workbench does not ${verb} it.`);
}

function changed(rel, hash, force) {
  return plainError(force ? `${shown(rel)} changed again, so nothing was written.`
    : `${shown(rel)} changed on disk since it was opened, so nothing was written.`, { why: 'changed', hash });
}

// ------------------------------------------------------------------ path rules

/** Characters HFS+ leaves out when it compares names, so ".git" with one of them is .git there (git's core.protectHFS). */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;
const isGitName = part => part.replace(HFS_IGNORED, '').toLowerCase() === '.git';

/** Why `rel` is not a path the file view takes, as a sentence, or null when it is one. */
function pathProblem(rel, verb) {
  if (typeof rel !== 'string' || rel === '') return 'No file was named.';
  if (Buffer.byteLength(rel) > MAX_PATH_BYTES) return `That file name is longer than ${MAX_PATH_BYTES} bytes, so Workbench does not look for it.`;
  const parts = rel.split('/');
  if (rel.includes('\0') || parts.some(p => p === '' || p === '.' || p === '..')) return `“${shown(rel)}” is not the name of a file inside the project.`;
  if (parts.some(isGitName)) return `Workbench leaves git’s own folder alone, so it does not ${verb} ${shown(rel)}.`;
  return null;
}

function partsOf(rel, verb) {
  const problem = pathProblem(rel, verb);
  if (problem) throw plainError(problem);
  return rel.split('/');
}

/**
 * The parts of `rel`, a path the file view takes: a string of at most 4096 bytes of UTF-8, relative (no leading "/"),
 * with "/" between its parts, none of them empty, "." or "..", none named .git in any case (nor with a character HFS+
 * leaves out of names), and no NUL. Throws a plain error with `why: 'refused'` otherwise. The engine checks with it too.
 * @param {string} rel
 * @returns {string[]}
 */
export function checkPath(rel) {
  return partsOf(rel, 'open');
}

const isFolder = p => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The real path of the folder that paths are relative to. */
function realFolder(root) {
  if (typeof root !== 'string' || !root.trim()) throw plainError('No project folder was given.');
  let top;
  try {
    top = fs.realpathSync.native(path.resolve(root));
  } catch (e) {
    throw plainError(`The folder ${root} does not exist.`, { cause: e });
  }
  if (!isFolder(top)) throw plainError(`${root} is not a folder.`);
  return top;
}

const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

/**
 * Where `rel` is, checked: { top, dir, name, real }. `top` is the real path of `root`; `dir` the real path of the
 * folder that holds the file, folder links on the way followed, which must stay inside `top` and out of every .git;
 * `name` the file's own name in `dir`, never followed; `real` its path from `top` through real folders. Or
 * { top, missing: true } when a folder on the way is not there. Throws a plain refusal for a path the rules refuse.
 * The file itself is then reached standing in `dir` (see standingIn), never by a path.
 */
function locate(root, rel, verb) {
  const parts = partsOf(rel, verb);
  const top = realFolder(root);
  let dir;
  try {
    dir = fs.realpathSync.native(path.join(top, ...parts.slice(0, -1)));
  } catch (e) {
    if (gone(e)) return { top, missing: true };
    throw fsFailure(e, rel, verb);
  }
  if (!within(dir, top)) throw plainError(`${shown(rel)} leads outside the project folder, so Workbench does not ${verb} it.`);
  const inner = dir === top ? [] : path.relative(top, dir).split(path.sep);
  if (inner.some(isGitName)) throw plainError(`${shown(rel)} leads into git’s own folder, which Workbench leaves alone.`);
  const name = parts[parts.length - 1];
  return { top, dir, name, real: [...inner, name].join('/') };
}

/**
 * Run `fn` standing in the folder `at.dir`, then come back. Node has no openat, so this is how a file is named by the
 * folder that holds it rather than by a path to it: Workbench makes that folder its working folder (process.chdir),
 * checks that the folder it now stands in has the real path that was checked (a refusal saying it moved otherwise),
 * and `fn` names files by their bare names. A folder on the path swapped for a link afterwards sends no step
 * elsewhere: the working folder is the folder itself, wherever it goes. `fn` is synchronous, so no other JavaScript
 * runs while Workbench stands there, and nothing else in Workbench hands Node a relative path (which Node's thread pool
 * would look for here meanwhile). Before this returns, Workbench is back where it was, or at "/" when that folder is
 * gone: never left standing in a project's folder. Throws what chdir and realpath throw (gone() when the folder is
 * not there any more), and in a worker thread, which cannot change folder.
 */
function standingIn(at, rel, verb, fn) {
  let back = null;
  try {
    back = process.cwd();
  } catch {} // the folder Workbench stood in was removed
  process.chdir(at.dir);
  try {
    if (fs.realpathSync.native('.') !== at.dir) throw moved(rel, verb);
    return fn();
  } finally {
    try {
      process.chdir(back ?? '/');
    } catch {
      process.chdir('/'); // where it stood was removed meanwhile
    }
  }
}

/**
 * Whether `rel` names the sibling a save writes beside a file, `.<name>.workbench-save-<16 hex>`: one is there only
 * while a save runs, or after a save was cut short. The list leaves these out.
 * @param {string} rel
 * @returns {boolean}
 */
export function isSaveFile(rel) {
  const s = String(rel);
  return SAVE_NAME.test(s.slice(s.lastIndexOf('/') + 1));
}

// ------------------------------------------------------------------ reading

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * The regular file `name`, in the folder Workbench stands in, read once: { bytes, size, mode }, with bytes null when it
 * holds more than MAX_FILE_BYTES. Opened without following a link (O_NOFOLLOW) and without waiting (O_NONBLOCK: a FIFO
 * put there meanwhile never blocks). { link: true } when a link is there now; { missing: true } when nothing is.
 */
function readRegular(name, rel, verb) {
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP') return { link: true };
    if (gone(e)) return { missing: true };
    throw fsFailure(e, rel, verb);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw notAFile(st, rel, verb);
    if (st.size > MAX_FILE_BYTES) return { bytes: null, size: st.size, mode: st.mode };
    // Read to the end, a byte past the limit at most: a file that grew while it was read is seen as it is.
    const buf = Buffer.alloc(st.size + 1);
    const chunks = [];
    let total = 0;
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      total += n;
      if (total > MAX_FILE_BYTES) return { bytes: null, size: total, mode: st.mode };
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return { bytes: Buffer.concat(chunks, total), size: total, mode: st.mode };
  } catch (e) {
    throw fsFailure(e, rel, verb);
  } finally {
    fs.closeSync(fd);
  }
}

/** The link `name`, in the folder Workbench stands in, described by where it points; what it points at is never read. */
function linkAt(name, rel) {
  let target;
  try {
    target = fs.readlinkSync(name, { encoding: 'buffer' });
  } catch (e) {
    if (gone(e)) return { ...MISSING };
    throw fsFailure(e, rel, 'open');
  }
  return { kind: 'link', link: target.toString('utf8'), hash: sha256(target), size: target.length, eol: 'none', bom: false };
}

/**
 * The line endings of `text`: 'lf', 'crlf', 'none' when it has no line break, and 'mixed' when it has both, or a
 * carriage return on its own, which is a line ending Workbench never writes (and which a text box would turn into LF).
 */
function eolOf(text) {
  const crlf = text.includes('\r\n');
  const lf = /(?:^|[^\r])\n/.test(text);
  if (/\r(?!\n)/.test(text) || (crlf && lf)) return 'mixed';
  return crlf ? 'crlf' : lf ? 'lf' : 'none';
}

/** Lines in `text`, counted the way git counts them: a last line without a newline counts, an empty text has none. */
function lineCount(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n : n + 1;
}

/**
 * Whether `rel` names an env file, which holds keys: .env, .env.<anything>, <anything>.env or direnv's .envrc, in any
 * case.
 */
function isEnvFile(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  return name === '.env' || name === '.envrc' || name.startsWith('.env.') || name.endsWith('.env');
}

/** What the bytes of the file at `rel` are, and the text when they are text: see readFile. */
function describe(rel, bytes) {
  const hash = sha256(bytes);
  const size = bytes.length;
  if (bytes.includes(0)) return { kind: 'binary', hash, size, eol: 'none', bom: false };
  const bom = bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
  let decoded;
  try {
    decoded = UTF8.decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return { kind: 'notutf8', hash, size, eol: 'none', bom: false };
  }
  const eol = eolOf(decoded);
  const text = eol === 'crlf' || eol === 'mixed' ? decoded.replace(/\r\n/g, '\n') : decoded;
  const lines = lineCount(text);
  if (isEnvFile(rel)) return { kind: 'secret', text: maskEnv(text), hash, size, lines, eol, bom };
  return { kind: 'text', text, hash, size, lines, eol, bom };
}

/**
 * One file, as the view shows it.
 * @param {{ root: string, rel: string }} o root: the folder `rel` is relative to (the person's repository or an agent's
 *   folder)
 * @returns {Promise<{ kind: 'text'|'binary'|'large'|'link'|'secret'|'notutf8'|'missing', text?: string, hash: string|null,
 *   size: number, lines?: number, link?: string, eol: 'lf'|'crlf'|'mixed'|'none', bom: boolean }>}
 *   hash: the SHA-256 of the bytes on disk (of where a link points, for a link); null for a large or missing file.
 *   text (text and secret only): without its BOM, CRLF as LF; for secret, every value masked. lines: the lines in text.
 *   eol and bom describe the text: 'none' and false for the other kinds. Rejects with a plain error (`why: 'refused'`)
 *   for a path the rules refuse, a folder, anything that is not a regular file or a link, and a folder on the way that
 *   was swapped for another while Workbench stepped into it.
 */
export async function readFile({ root, rel } = {}) {
  const at = locate(root, rel, 'open');
  if (at.missing) return { ...MISSING };
  return readAt(at, rel);
}

/** The file `at` names (see locate), read standing in its folder (see standingIn): what readFile gives. */
function readAt(at, rel) {
  try {
    return standingIn(at, rel, 'open', () => {
      const st = fs.lstatSync(at.name);
      if (st.isSymbolicLink()) return linkAt(at.name, rel);
      if (!st.isFile()) throw notAFile(st, rel, 'open');
      const got = readRegular(at.name, rel, 'open');
      if (got.link) return linkAt(at.name, rel);
      if (got.missing) return { ...MISSING };
      if (!got.bytes) return { kind: 'large', hash: null, size: got.size, eol: 'none', bom: false };
      return describe(rel, got.bytes);
    });
  } catch (e) {
    if (gone(e)) return { ...MISSING };
    throw fsFailure(e, rel, 'open');
  }
}

// ------------------------------------------------------------------ env files

const QUOTES = '"\'`';
/** `NAME=value`, `export NAME=value` or `NAME: value`, as dotenv reads them: [line, before, name, between, value]. */
const ASSIGNMENT = /^(\s*(?:export\s+)?)([\w.-]+)(\s*(?:=|:(?=\s|$))\s*)([\s\S]*)$/;
/** The same, commented out: `# NAME=value`. */
const COMMENTED = /^(\s*#+\s*(?:export\s+)?)([\w.-]+)(\s*(?:=|:(?=\s|$))\s*)([\s\S]*)$/;

/**
 * Whether `name` may be shown as the name of a value: a variable's shape (a letter or "_", then letters, digits, "_",
 * "." or "-"), at most 64 characters, and nothing that reads as a key itself. So: no mix of upper case, lower case and
 * digits, as random text has (base64); no part between "_", "." and "-" longer than 10 characters that holds a digit
 * (base32, hex; K8S, OAUTH2 and POSTGRES15 are kept); and nothing looksLikeSecret flags. Otherwise a token padded with
 * "=" would pass for a name with an empty value, and be shown whole.
 */
function nameShaped(name) {
  if (name.length > 64 || !/^[A-Za-z_][\w.-]*$/.test(name)) return false;
  if (/[a-z]/.test(name) && /[A-Z]/.test(name) && /\d/.test(name)) return false;
  if (name.split(/[_.-]/).some(part => part.length > 10 && /\d/.test(part))) return false;
  return !looksLikeSecret(name).secret;
}

/** Where the quote `q` closes in `s`, from `from` on (a backslash escapes the character after it), or -1. */
function closingQuote(s, q, from) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

/**
 * A value masked, its quotes kept: { text, open }, where `open` is the quote of a value that goes on past its line.
 * `spaced`: whether whitespace came before it, after the `=` or `:`. A comment starts at a "#" that follows whitespace,
 * as dotenv and sh read it: it is not part of the value, and shows as "••••". A "#" with no whitespace before it is
 * part of the value, as sh reads it.
 */
function maskedValue(value, spaced) {
  if (!value.trim()) return { text: value };
  if (spaced && value[0] === '#') return { text: '••••' }; // no value, then a comment
  const q = value[0];
  if (!QUOTES.includes(q)) {
    const comment = value.search(/\s#/);
    return { text: comment < 0 ? shownValue(value.trimEnd()) : `${shownValue(value.slice(0, comment).trimEnd())} ••••` };
  }
  const end = closingQuote(value, q, 1);
  if (end < 0) return { text: `${q}••••`, open: q };
  const inner = value.slice(1, end);
  return { text: `${q}${inner ? shownValue(inner) : ''}${q}${value.slice(end + 1).trim() ? ' ••••' : ''}` };
}

/**
 * An env file's text with every value masked, as Workbench shows a secret (shownValue: "•••• " and its last four
 * characters, or "••••"); each line stays a line. A line that names its value (see nameShaped), commented out or not,
 * keeps the name, `export`, the `=` or `: ` and the quotes; a comment after the value is " ••••" (see maskedValue). A
 * value in quotes that goes on past its line is "••••" on each line up to the one with its closing quote. Blank lines
 * stay. Every other line, a comment too, is "••••" with no last characters, after its "#": one that names nothing may
 * be part of a key, such as a line of a pasted private key.
 */
function maskEnv(text) {
  let open = null; // the quote of a value that goes on past its line
  const out = [];
  for (const line of text.split('\n')) {
    if (open) {
      const end = closingQuote(line, open, 0);
      if (end < 0) {
        out.push(line.trim() ? '••••' : line);
      } else {
        out.push(`••••${open}${line.slice(end + 1).trim() ? ' ••••' : ''}`);
        open = null;
      }
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const plain = ASSIGNMENT.exec(line);
    const m = plain || COMMENTED.exec(line);
    if (m && nameShaped(m[2])) {
      const value = maskedValue(m[4], /\s$/.test(m[3]));
      out.push(m[1] + m[2] + m[3] + value.text);
      if (plain && value.open) open = value.open;
      continue;
    }
    out.push(`${/^\s*(?:#+\s*)?/.exec(line)[0]}••••`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ saving

/** `s` cut to at most `max` bytes of UTF-8, at a character's end. */
function cutToBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    n += Buffer.byteLength(ch);
    if (n > max) break;
    out += ch;
  }
  return out;
}

/** `.<name>.workbench-save-<16 random hex>`, the name cut short when the whole would be longer than a name may be. */
function saveName(name) {
  const tail = `.workbench-save-${crypto.randomBytes(8).toString('hex')}`;
  return `.${cutToBytes(name, NAME_MAX - 1 - Buffer.byteLength(tail))}${tail}`;
}

/** Sync the folder Workbench stands in, so a rename in it lasts; nothing happens when the system does not allow it. */
function syncFolder() {
  let fd = null;
  try {
    fd = fs.openSync('.', fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {} finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Remove, from the folder Workbench stands in, the siblings that saves cut short left there (see isSaveFile): regular
 * files only, never a link or a folder, and only once they are older than LEFTOVER_MS, so a save still under way (in
 * another Workbench) keeps its own.
 */
function sweepLeftovers() {
  let names;
  try {
    names = fs.readdirSync('.');
  } catch {
    return;
  }
  const before = Date.now() - LEFTOVER_MS;
  for (const name of names) {
    if (!SAVE_NAME.test(name)) continue;
    try {
      const st = fs.lstatSync(name);
      if (st.isFile() && st.mtimeMs < before) fs.unlinkSync(name);
    } catch {} // gone meanwhile, or not Workbench's to remove
  }
}

/**
 * Put `bytes` in place of the file `at.name` in one step, standing in its folder (see standingIn), so every name here
 * is a bare name in that folder. A new file beside it (see saveName) is made only where nothing is (flag wx: it fails
 * if anything, even a link, is there), given the original's `mode`, written and synced. Then, once the folder is still
 * where it was and the file is still a regular file (lstat) that holds `hash`, the new file is renamed over it. On any
 * failure the new file is removed; only a file this call made is ever removed. `force` words a change caught here as
 * writeFile's own check would.
 */
function replace(at, mode, bytes, hash, rel, force) {
  const tmp = saveName(at.name);
  let fd = null;
  let made = false;
  let done = false;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    made = true;
    try {
      fs.fchmodSync(fd, mode & 0o7777);
    } catch {
      fs.fchmodSync(fd, mode & 0o777); // a special bit this account may not set
    }
    for (let off = 0; off < bytes.length;) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // The last look before the rename: an agent may have moved the folder, written the file, or put something else
    // there meanwhile.
    if (fs.realpathSync.native('.') !== at.dir) throw moved(rel, 'change');
    const now = fs.lstatSync(at.name);
    if (now.isSymbolicLink()) throw isLink(rel);
    if (!now.isFile()) throw notAFile(now, rel, 'change');
    const again = readRegular(at.name, rel, 'change');
    if (again.link) throw isLink(rel);
    if (again.missing) throw notThere(rel);
    if (!again.bytes) throw tooLarge(rel);
    const current = sha256(again.bytes);
    if (current !== hash) throw changed(rel, current, force);
    fs.renameSync(tmp, at.name);
    done = true;
  } catch (e) {
    throw gone(e) ? notThere(rel) : fsFailure(e, rel, 'change');
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    if (made && !done) try { fs.unlinkSync(tmp); } catch {}
  }
  syncFolder();
}

/**
 * Save the person's text over one file. The text arrives with LF line breaks; the file is written with the line
 * endings it has (CRLF stays CRLF; a file with no line break gets LF), its BOM put back, and its final newline as the
 * text has it.
 * @param {{ root: string, rel: string, text: string, hash: string, force?: boolean }} o hash: the SHA-256 the file was
 *   read with; with `force` (the person saves theirs anyway), the one the 'changed' refusal gave. Either way it must
 *   match the bytes on disk now: `force` skips no check.
 * @returns {Promise<{ hash: string, size: number }>} the SHA-256 and size of the bytes written.
 *   Rejects with a plain error: `why: 'changed'` with `hash` (the file's hash now) when the file is no longer what was
 *   read, so nothing was written; `why: 'refused'` for everything else Workbench does not write: a path the rules
 *   refuse, a file that is not there (it never makes one), a link (it never writes through one), a folder or anything
 *   but a regular file, a binary, large, not UTF-8 or env file, mixed line endings, a read-only file, text holding a
 *   carriage return, a NUL or a broken character, a result over 1 MB, a folder on the way that moved while it saved,
 *   or a failure to write.
 */
export async function writeFile({ root, rel, text, hash, force = false } = {}) {
  partsOf(rel, 'change');
  if (typeof text !== 'string') throw plainError('There was no text to save.');
  if (typeof hash !== 'string' || !SHA256.test(hash)) {
    throw plainError(`Workbench does not know which version of ${shown(rel)} was edited, so nothing was saved.`);
  }
  if (text.includes('\r')) throw plainError('The text to save has a carriage return in it, which Workbench does not write, so nothing was saved.');
  if (text.includes('\0')) throw plainError('The text to save has a NUL character in it, so nothing was saved.');
  if (!text.isWellFormed()) throw plainError('The text to save has characters that cannot be written as UTF-8, so nothing was saved.');
  const at = locate(root, rel, 'change');
  if (at.missing) throw notThere(rel);
  try {
    return standingIn(at, rel, 'change', () => save(at, rel, text, hash, force));
  } catch (e) {
    throw gone(e) ? notThere(rel) : fsFailure(e, rel, 'change');
  }
}

/** writeFile's steps once Workbench stands in the file's folder (see standingIn): the file is `at.name` there. */
function save(at, rel, text, hash, force) {
  sweepLeftovers();
  const st = fs.lstatSync(at.name);
  if (st.isSymbolicLink()) throw isLink(rel);
  if (!st.isFile()) throw notAFile(st, rel, 'change');
  const cur = readRegular(at.name, rel, 'change');
  if (cur.link) throw isLink(rel);
  if (cur.missing) throw notThere(rel);
  if (!cur.bytes) throw tooLarge(rel);
  const was = describe(rel, cur.bytes);
  const kept = { binary: 'is a binary file', notutf8: 'is not UTF-8 text', secret: 'holds keys' }[was.kind];
  if (kept) throw plainError(`${shown(rel)} ${kept}, so Workbench does not edit it.`);
  if (was.eol === 'mixed') throw plainError(`${shown(rel)} mixes line endings, so Workbench does not edit it.`);
  if (was.hash !== hash) throw changed(rel, was.hash, force);
  try {
    fs.accessSync(at.name, fs.constants.W_OK);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') throw plainError(`${shown(rel)} is read-only, so Workbench did not change it.`);
    throw e;
  }
  const body = Buffer.from(was.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  const bytes = was.bom ? Buffer.concat([BOM, body]) : body;
  if (bytes.length > MAX_FILE_BYTES) throw plainError(`The edit would make ${shown(rel)} larger than 1 MB, so Workbench did not save it.`);
  replace(at, cur.mode, bytes, hash, rel, force);
  return { hash: sha256(bytes), size: bytes.length };
}

// ------------------------------------------------------------------ the list

/**
 * The fields of `buf` between NUL bytes, as buffers, one at a time. What follows the last NUL is a field too, unless
 * the answer was `cut` short: then it is a name cut off part-way, and left out.
 */
function* nulFields(buf, cut = false) {
  let at = 0;
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0, at)) {
    yield buf.subarray(at, i);
    at = i + 1;
  }
  if (!cut && at < buf.length) yield buf.subarray(at);
}

/**
 * The new files no ignore rule hides, as git lists them: { stdout, cut }. When git says more than git() reads at once
 * (64 MB), or is stopped for taking too long, what it said up to then is kept, and `cut` is true.
 */
async function newFiles(cwd) {
  try {
    const r = await git(['ls-files', '-z', '--others', '--exclude-standard'], { cwd, encoding: 'buffer' });
    return { stdout: r.stdout, cut: false };
  } catch (e) {
    const tooMuch = !!e && (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || e.killed === true);
    if (tooMuch && Buffer.isBuffer(e.stdout)) return { stdout: e.stdout, cut: true };
    throw e;
  }
}

const utf8OrNull = bytes => {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * The project's files: what `git ls-files -z --cached --others --exclude-standard` lists, run as its two halves so that
 * tracked files come first when the list is cut: every tracked file (one in a conflict once), then every new file no
 * ignore rule hides. Left out: a repository inside the folder (git names it "folder/"), a name that is not UTF-8 (the
 * page could not ask for it by name), a name the path rules refuse, and the sibling of a save (see isSaveFile). When
 * the new files are more than git() reads at once, or git is stopped for taking too long listing them (an un-ignored
 * node_modules in an agent's copy, say), the names it gave whole are kept and the list is cut there: what git did not
 * give is not known. The tracked files are not cut that way: without them all, the list is refused.
 * @param {{ root: string, max?: number }} o max: at most this many, and never more than 50,000 (MAX_LIST_FILES)
 * @returns {Promise<{ files: string[], truncated?: true }>} paths from root with "/", ordered by path; truncated when
 *   there were more, or may have been. Rejects with a plain error when git cannot list them.
 */
export async function listFiles({ root, max = MAX_LIST_FILES } = {}) {
  const top = realFolder(root);
  const limit = Number.isInteger(max) && max >= 0 ? Math.min(max, MAX_LIST_FILES) : MAX_LIST_FILES;
  let halves;
  try {
    halves = await Promise.all([
      git(['ls-files', '-z', '--cached'], { cwd: top, encoding: 'buffer' }).then(r => ({ stdout: r.stdout, cut: false })),
      newFiles(top),
    ]);
  } catch (e) {
    throw gitTrouble(e) || plainError(`Git could not list the files in ${top}.`, { cause: e });
  }
  const files = [];
  const seen = new Set();
  let truncated = false;
  for (const { stdout, cut } of halves) {
    for (const raw of nulFields(stdout, cut)) {
      const name = utf8OrNull(raw);
      if (name === null || name.endsWith('/') || seen.has(name) || isSaveFile(name) || pathProblem(name, 'open')) continue;
      if (files.length >= limit) {
        truncated = true;
        break;
      }
      seen.add(name);
      files.push(name);
    }
    if (cut) truncated = true;
    if (truncated) break;
  }
  files.sort();
  return truncated ? { files, truncated: true } : { files };
}

// ------------------------------------------------------------------ changed lines

/**
 * The new side's line numbers that a patch adds. Each hunk is walked by its counts, so a line of the file that looks
 * like a header ("+++ x") is still a line, and an empty line inside a hunk is context (as diff.suppressBlankEmpty
 * writes it).
 */
function addedLines(patch) {
  const out = [];
  let oldLeft = 0;
  let newLeft = 0;
  let at = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line[0] === '+') {
        out.push(at++);
        newLeft--;
      } else if (line[0] === '-') {
        oldLeft--;
      } else if (line[0] !== '\\') { // "\ No newline at end of file" is not a line
        at++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) [oldLeft, at, newLeft] = [m[1] === undefined ? 1 : Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
  }
  return out;
}

/** A plain error for a diff git could not make. */
async function diffFailure(e, cwd, since, rel) {
  if (e && e.plain) return Object.assign(e, { why: e.why || 'refused' }); // a scratch folder Workbench could not make
  const trouble = gitTrouble(e);
  if (trouble) return trouble;
  const known = await git(['cat-file', '-e', `${since}^{commit}`], { cwd }).then(() => true, () => false);
  if (!known) return plainError('The commit its work started from is no longer in this repository.', { cause: e });
  return plainError(`Git could not tell which lines of ${shown(rel)} changed.`, { cause: e });
}

/**
 * The patch of the file `real` in the folder `run` runs git in, against its version at `since` (`entry`, its line from
 * `ls-tree -z`), for a file the folder's own index does not have: the same diff-index, through a scratch index that
 * holds that one entry, in a private folder (privateTemp). Nothing is written to the repository: the blob is in it.
 */
async function againstSince(run, since, real, entry) {
  const scratch = privateTemp('workbench-index-');
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    await run(['update-index', '-z', '--index-info'], { env, input: `${entry}\0` });
    return (await run([...DIFF, since, '--', real], { env })).stdout;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The line numbers, in the file as it is now, that the work since `since` added or changed: committed or not, from
 * `git diff-index -p <since> -- <path>` in `root` with the diff flags of workspace.mjs's patches. The file is read
 * once, standing in its folder as readFile reads it: one the view shows no lines of (a link, a binary, large or not
 * UTF-8 file, a missing one) has none, nor has an empty one. A file that was never added (new, and not hidden by an
 * ignore rule) is new altogether, as the git screen calls it: every line of what was read counts. But when `since` has
 * a file there (the agent took it out of git, or removed it and wrote it again), it is compared with that one, as the
 * git screen compares it. Lines only taken away mark nothing. The path goes to git through real folders, so a path
 * through a folder link gives the real file's lines. git reads the file again by that path, so a line number past
 * the end of the file as Workbench read it is left out.
 * @param {{ root: string, since: string, rel: string }} o root: the agent's folder; since: the commit its unmerged work
 *   starts from (40 or 64 hex)
 * @returns {Promise<number[]>} ascending, from 1
 */
export async function changedLines({ root, since, rel } = {}) {
  partsOf(rel, 'open');
  if (typeof since !== 'string' || !OID.test(since)) throw plainError('Workbench does not know which commit its work started from.');
  const at = locate(root, rel, 'open');
  if (at.missing) return [];
  const now = readAt(at, rel);
  if ((now.kind !== 'text' && now.kind !== 'secret') || !now.lines) return [];
  const run = (args, o = {}) => git(args, { cwd: at.top, ...o });
  const name = at.real.normalize('NFC'); // git on a Mac lists names composed (core.precomposeUnicode)
  const same = p => p === at.real || p.normalize('NFC') === name;
  // git reads the file again, by its path: what it diffed may have changed since (or been another file, its folder
  // swapped for a link meanwhile), so only lines of the file as read count.
  const read = lines => lines.filter(n => n <= now.lines);
  try {
    const [untracked, patch] = await Promise.all([
      run(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', at.real])
        .then(r => r.stdout.split('\0').some(same)),
      run([...DIFF, since, '--', at.real]).then(r => r.stdout),
    ]);
    if (!untracked) return read(addedLines(patch));
    const listed = (await run(['--literal-pathspecs', 'ls-tree', '-z', since, '--', at.real])).stdout.split('\0');
    const entry = listed.find(r => /^\d{6} blob [0-9a-f]+\t/.test(r) && same(r.slice(r.indexOf('\t') + 1)));
    if (!entry) return Array.from({ length: now.lines }, (_, i) => i + 1);
    return read(addedLines(await againstSince(run, since, at.real, entry)));
  } catch (e) {
    throw await diffFailure(e, at.top, since, rel);
  }
}
