// The person's choices for the page, kept across runs: the look (theme), how much detail it shows, and whether they
// have answered something once (the hint under the core then stays away). The page gets a new address every run, so
// its own storage starts empty each time; Workbench keeps these three in ~/.workbench/prefs.json instead, and the server
// puts them on the page's <html> tag before the first paint (pageWithPrefs), so the board never flashes the wrong look.
//
// Only these keys, and only the values the page offers, are ever read, written or sent: never a secret, never anything
// else. The folder is made private (0700) and the file is 0600, written to a new temporary file and renamed. A file
// that is a link, another account's, damaged or larger than 4 KB reads as the defaults; a link is never followed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The looks and detail levels, as ui/prefs.js lists them (test/prefs.test.mjs keeps the two lists the same). */
export const THEMES = Object.freeze(['green', 'black-gold', 'ivory']);
export const DETAILS = Object.freeze(['calm', 'more']);
export const DEFAULT_PREFS = Object.freeze({ theme: 'green', detail: 'calm', answered: false });

const MAX_FILE = 4096;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const NOT_KEPT = 'Workbench could not keep that choice for the next time it starts. The details are in its log.';

/** Where the choices are kept: <home>/.workbench/prefs.json. */
export function prefsFile(home) {
  return path.join(home, '.workbench', 'prefs.json');
}

/** The choices in `raw`, each a known value or its default, and nothing else. */
export function cleanPrefs(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    theme: THEMES.includes(o.theme) ? o.theme : DEFAULT_PREFS.theme,
    detail: DETAILS.includes(o.detail) ? o.detail : DEFAULT_PREFS.detail,
    answered: o.answered === true,
  };
}

/** An error the server answers with its status and its plain sentence. */
function refusal(message) {
  return Object.assign(new Error(message), { status: 400, plain: true });
}

/**
 * The change a request asks for: `theme`, `detail` and `answered` (only ever true), each checked. Other names are left
 * out, never kept. Nothing known, or a value the page does not offer, is refused with a plain sentence (status 400).
 * @returns {{ theme?: string, detail?: string, answered?: true }}
 */
export function prefsChange(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const change = {};
  if (Object.hasOwn(b, 'theme')) {
    if (!THEMES.includes(b.theme)) throw refusal('Workbench has no such look.');
    change.theme = b.theme;
  }
  if (Object.hasOwn(b, 'detail')) {
    if (!DETAILS.includes(b.detail)) throw refusal('Workbench has no such detail level.');
    change.detail = b.detail;
  }
  if (Object.hasOwn(b, 'answered')) {
    if (b.answered !== true) throw refusal('Workbench keeps only that you have answered once.');
    change.answered = true;
  }
  if (!Object.keys(change).length) throw refusal('Say which look or detail level to keep.');
  return change;
}

/**
 * A folder only this account may open (0700). Made when missing (with `create`), with any missing folder above it.
 * An existing folder of this account's that others could open is made 0700. A link is followed, as the key store does
 * for ~/.workbench (it may live on another disk); anything that is not a folder, or is another account's, is left
 * alone.
 * @returns {boolean} whether the folder is there and private now
 */
export function privateFolder(dir, { create = true } = {}) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT' && !create) return false;
    throw err;
  }
  if (!st.isDirectory()) return false;
  const uid = process.getuid?.();
  if (uid != null && st.uid !== uid) return false;
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return true;
}

/** What the file holds, or {} when there is nothing usable there. */
function readFile(file) {
  let fd;
  try {
    // a link is refused (ELOOP), and a FIFO never blocks
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return {};
  }
  try {
    const st = fs.fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid != null && st.uid !== uid) || st.size > MAX_FILE) return {};
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

/** Write the choices so a reader never sees half of them: a new 0600 file beside the old one, then a rename. */
function writeFile(file, prefs) {
  const dir = path.dirname(file);
  if (!privateFolder(dir)) throw new Error(`${dir} is not a folder of this account's`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(prefs)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * The choices kept in `file` (prefsFile(home)). `get()` reads the file each time, so a change another run saved counts
 * at the next page load. `set(change)` (a prefsChange) saves the change over what the file holds now, and answers
 * `{ ok, prefs }`; when the file cannot be written, the failure is logged, the answer is `{ ok: false, sentence, prefs }`,
 * and the choice still lasts for this run.
 * @param {{ file: string, log?: object }} opts
 */
export function createPrefs({ file, log } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('The prefs file needs an absolute path.');
  let unsaved = {};
  const get = () => cleanPrefs({ ...cleanPrefs(readFile(file)), ...unsaved });
  return {
    file,
    get,
    set(change) {
      const next = cleanPrefs({ ...cleanPrefs(readFile(file)), ...unsaved, ...change });
      try {
        writeFile(file, next);
      } catch (err) {
        unsaved = { ...unsaved, ...change };
        (log?.warn || log?.info)?.call(log, `Workbench could not save the page’s choices in ${file}:`, err?.message || String(err));
        return { ok: false, sentence: NOT_KEPT, prefs: get() };
      }
      unsaved = {};
      return { ok: true, prefs: next };
    },
  };
}

/** Choices kept for one run only, with the same rules: the server's own when it is given no store (tests, the mock). */
export function memoryPrefs(start = {}) {
  let now = cleanPrefs(start);
  return {
    file: null,
    get: () => ({ ...now }),
    set(change) {
      now = cleanPrefs({ ...now, ...change });
      return { ok: true, prefs: { ...now } };
    },
  };
}

/**
 * The page with the person's choices on its first <html> tag: data-theme, data-detail and data-answered ("1" or "0"),
 * replaced where they are and added where they are not. The values come from the lists only (cleanPrefs), so nothing
 * else ever reaches the page. A page without an <html> tag goes out as it is.
 */
export function pageWithPrefs(html, prefs) {
  const p = cleanPrefs(prefs);
  const attrs = [['data-theme', p.theme], ['data-detail', p.detail], ['data-answered', p.answered ? '1' : '0']];
  // the tag, with quoted values that may hold ">"; each attribute with any form of value, or none
  return String(html).replace(/<html(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>/i, (tag) => {
    let t = tag;
    for (const [name, value] of attrs) {
      const re = new RegExp(`(\\s)${name}(?=[\\s=/>])(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?`, 'i');
      t = re.test(t) ? t.replace(re, `$1${name}="${value}"`) : t.replace(/>$/, ` ${name}="${value}">`);
    }
    return t;
  });
}
