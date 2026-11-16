// The file view's gentle colouring: comments, strings, numbers and keywords, a line at a time. No packages, and only a
// few kinds, so a file reads calmly: k (a keyword, or a key in JSON, YAML and TOML), s (a string), n (a number or a
// constant such as true or null), c (a comment) and h (a Markdown heading). Anything else is plain.
//
// A line is read with the state the line before left (a block comment, or a string that goes on), and gives the state
// it leaves: the view reads states down a file in idle slices, and colours only the rows it draws. A line's parts always
// join back into the line: nothing is dropped, added or reordered, so the view can show hidden characters in every part.
// Pure: no DOM, no imports (node:test loads it).

const words = s => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words(`break case catch class const continue debugger default delete do else export extends finally for function if import in
  instanceof let new return super switch this throw try typeof var void while with yield async await of from as static interface enum implements
  private protected public readonly declare namespace abstract keyof infer satisfies override`);
const C_KW = words(`auto break case char const continue default do double else enum extern float for goto if inline int long register restrict
  return short signed sizeof static struct switch typedef union unsigned void volatile while bool class namespace template typename public private
  protected virtual override final new delete this throw try catch using operator friend explicit constexpr noexcept static_cast dynamic_cast
  reinterpret_cast const_cast decltype mutable thread_local co_await co_return co_yield concept requires import module export`);
const JAVA_KW = words(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally
  float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp
  super switch synchronized this throw throws transient try void volatile while var record sealed permits yield fun val when is in out object
  companion data inline suspend override open internal lateinit init typealias reified crossinline noinline vararg tailrec operator infix
  external expect actual constructor by def trait implicit lazy type with given using then match`);
const CS_KW = words(`abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else
  enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator
  out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try
  typeof uint ulong unchecked unsafe ushort using virtual void volatile while async await var dynamic record init required yield when where
  global nameof`);
const SWIFT_KW = words(`associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private
  precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough
  for guard if in repeat return throw switch where while as await async is self Self super throws try some any`);
const PY_KW = words(`and as assert async await break class continue def del elif else except finally for from global if import in is lambda
  nonlocal not or pass raise return try while with yield match case`);
const GO_KW = words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range
  return select struct switch type var`);
const RUST_KW = words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref
  return self Self static struct super trait type unsafe use where while yield`);
const RUBY_KW = words(`alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry
  return self super then undef unless until when while yield require require_relative include extend attr_reader attr_writer attr_accessor
  private protected public raise lambda proc`);
const SH_KW = words('if then else elif fi case esac for while until do done in function select time return exit export local readonly declare unset shift source alias break continue');

const Q = (open, esc = true, ml = false, close = open) => ({ open, close, esc, ml });

/** Each language: its comments, strings, words and the few rules of its own. */
export const LANGS = {
  js: { id: /[\w$]/, line: ['//'], block: [['/*', '*/']], strings: [Q('`', true, true), Q('"'), Q("'")], kw: JS_KW,
    consts: words('null undefined true false NaN Infinity'), regex: true, member: true },
  json: { line: ['//'], block: [['/*', '*/']], strings: [Q('"')], kw: new Set(), consts: words('true false null'), keys: true, neg: true },
  css: { id: /[\w-]/, block: [['/*', '*/']], strings: [Q('"'), Q("'")], kw: new Set(), css: true, neg: true, unit: true },
  html: { html: true },
  py: { line: ['#'], strings: [Q('"""', true, true), Q("'''", true, true), Q('"'), Q("'")], prefix: /^(?:[rR][bBfF]|[bBfF][rR]|[rRbBuUfF])(?=['"])/,
    kw: PY_KW, consts: words('None True False') },
  go: { line: ['//'], block: [['/*', '*/']], strings: [Q('`', false, true), Q('"'), Q("'")], kw: GO_KW, consts: words('true false nil iota'), member: true },
  rust: { line: ['//'], block: [['/*', '*/']], strings: [Q('"', true, true)], kw: RUST_KW, consts: words('true false'), rawRust: true, charRust: true },
  ruby: { id: /[\w]/, line: ['#'], strings: [Q('"'), Q("'")], kw: RUBY_KW, consts: words('nil true false'), ruby: true, member: true },
  c: { line: ['//'], block: [['/*', '*/']], strings: [Q('"'), Q("'")], kw: C_KW, consts: words('true false NULL nullptr YES NO nil'), pre: true, member: true },
  java: { line: ['//'], block: [['/*', '*/']], strings: [Q('"""', true, true), Q('"'), Q("'")], kw: JAVA_KW, consts: words('true false null'), member: true },
  cs: { line: ['//'], block: [['/*', '*/']], strings: [Q('"'), Q("'")], kw: CS_KW, consts: words('true false null'), pre: true, member: true, verbatim: true },
  swift: { line: ['//'], block: [['/*', '*/']], strings: [Q('"""', true, true), Q('"')], kw: SWIFT_KW, consts: words('true false nil'), member: true },
  sh: { line: ['#'], wordHash: true, strings: [Q('"'), Q("'", false)], kw: SH_KW, consts: new Set(), member: false },
  yaml: { yaml: true },
  toml: { toml: true, line: ['#'], strings: [Q('"""', true, true), Q("'''", false, true), Q('"'), Q("'", false)], kw: new Set(), consts: words('true false') },
  md: { md: true },
};

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', vue: 'html', plist: 'html',
  py: 'py', pyw: 'py', pyi: 'py',
  go: 'go', rs: 'rust', rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java', gradle: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hxx: 'c', hh: 'c', m: 'c', mm: 'c', cs: 'cs', swift: 'swift',
  sh: 'sh', bash: 'sh', zsh: 'sh', ksh: 'sh',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'md', markdown: 'md', mdx: 'md',
};
const NAMES = { rakefile: 'ruby', gemfile: 'ruby', '.bashrc': 'sh', '.zshrc': 'sh', '.bash_profile': 'sh', '.profile': 'sh', '.zprofile': 'sh' };

/** The language of a file, from its name: one of LANGS' keys, or null for anything else (shown plain). */
export function langOf(path) {
  const name = String(path ?? '').split('/').pop().toLowerCase();
  if (!name) return null;
  if (NAMES[name]) return NAMES[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXT[name.slice(dot + 1)] || null : null;
}

// ------------------------------------------------------------------ reading a line

const DIGIT = /[0-9]/;
const NUM = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)[A-Za-z_]*/;
const NUM_UNIT = /^(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[A-Za-z]+|%)?/;
const REGEX_AFTER = words('return typeof case do else in of new delete void throw yield await instanceof');
/** A character that belongs to a name: the language's own, and anything past ASCII (a name in another script). */
const idChar = (cfg, ch) => !!ch && (ch > '\x7f' || (cfg.id || /\w/).test(ch));

/** Parts of a line, merged as they come: plain text runs together, and so do neighbours of one kind. */
function parts() {
  const out = [];
  return {
    out,
    add(kind, text) {
      if (!text) return;
      const last = out[out.length - 1];
      if (last && last[0] === kind) last[1] += text;
      else out.push([kind, text]);
    },
  };
}

/** Where a run that ends with `close` ends on this line (just past it), or -1; with `esc`, a backslash hides what follows. */
function closeAt(line, from, close, esc) {
  if (!esc) { const j = line.indexOf(close, from); return j < 0 ? -1 : j + close.length; }
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

// A state is '' (code), or a run that goes on: its kind (c or s), e for backslash escapes or r for none, then what
// ends it ('c' + 'r' + '*/', 's' + 'e' + '`', 's' + 'r' + '"#'). Ruby's =begin ends at a line that starts with =end
// ('cl=end'); HTML keeps its own ('T' inside a tag).
const stateOf = (kind, esc, close) => kind + (esc ? 'e' : 'r') + close;

/**
 * Colour one line.
 * @param {string} line   the line, without its line break
 * @param {string|null} lang  one of LANGS' keys; anything else is plain
 * @param {string} [state]  what the line before left ('' at the top of a file)
 * @returns {{ parts: [kind: ''|'k'|'s'|'n'|'c'|'h', text: string][], state: string }}
 */
export function tokenizeLine(line, lang, state = '') {
  const s = String(line ?? '');
  const cfg = LANGS[lang];
  if (!cfg) return { parts: s ? [['', s]] : [], state: '' };
  const p = parts();
  let next;
  if (cfg.md) { p.add(/^#{1,6}(?:\s|$)/.test(s) ? 'h' : '', s); next = ''; }
  else if (cfg.html) next = html(s, state, p);
  else if (cfg.yaml) next = yaml(s, p);
  else next = code(s, cfg, state, p);
  return { parts: p.out, state: next };
}

/** The general reader: comments, strings, numbers, words, and JavaScript's regular expressions. */
function code(s, cfg, state, p) {
  const n = s.length;
  let i = 0;
  // a run carried from the line before
  if (state) {
    if (state === 'cl=end') {
      p.add('c', s);
      return /^=end(?:\s|$)/.test(s) ? '' : state;
    }
    const kind = state[0], esc = state[1] === 'e', close = state.slice(2);
    const end = closeAt(s, 0, close, esc);
    if (end < 0) { p.add(kind, s); return state; }
    p.add(kind, s.slice(0, end));
    i = end;
  }
  if (cfg.ruby && i === 0 && /^=begin(?:\s|$)/.test(s)) { p.add('c', s); return 'cl=end'; }
  if (cfg.toml && i === 0) {
    // a table's header, [package] or [[bin]], as one part
    const m = /^(\s*)(\[\[?[^\]\n]*\]\]?)/.exec(s);
    if (m) { p.add('', m[1]); p.add('k', m[2]); i = m[0].length; }
    else {
      const k = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)(?=\s*=)/.exec(s);
      if (k) { p.add('', k[1]); p.add('k', k[2]); i = k[0].length; }
    }
  }
  if (cfg.pre && i === 0) {
    // a preprocessor line: its directive, and what #include and #import bring in
    const m = /^(\s*)(#\s*[A-Za-z_]+)/.exec(s);
    if (m) {
      p.add('', m[1]); p.add('k', m[2]); i = m[0].length;
      const inc = /^(\s*)(<[^>\n]*>)/.exec(s.slice(i));
      if (/include|import/.test(m[2]) && inc) { p.add('', inc[1]); p.add('s', inc[2]); i += inc[0].length; }
    }
  }
  let prev = '';   // the last thing read that is not a space or a comment: '' (none), 'id', 'kw:<word>', 'num', 'str', 'p:<char>'
  let prevCh = i > 0 ? s[i - 1] : '';   // the character just before, for names and numbers
  let lastSolid = '';   // the last character that is not a space, for "after a dot"
  const take = (kind, text, what) => { p.add(kind, text); i += text.length; prevCh = s[i - 1]; if (what !== undefined) prev = what; const t = text.trimEnd(); if (t) lastSolid = t[t.length - 1]; };
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t') { let j = i + 1; while (j < n && (s[j] === ' ' || s[j] === '\t')) j++; take('', s.slice(i, j)); continue; }
    // comments to the end of the line; a shell or YAML # only where a word starts
    if (cfg.line && cfg.line.some(m => s.startsWith(m, i)) && (!cfg.wordHash || i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) { take('c', s.slice(i)); break; }
    const bc = cfg.block && cfg.block.find(([o]) => s.startsWith(o, i));
    if (bc) {
      const end = s.indexOf(bc[1], i + bc[0].length);
      if (end < 0) { take('c', s.slice(i)); return stateOf('c', false, bc[1]); }
      take('c', s.slice(i, end + bc[1].length));
      continue;
    }
    // strings: Rust's raw strings, C#'s verbatim ones, prefixed ones (Python's r'', f''), then the language's own
    if (cfg.rawRust && !idChar(cfg, prevCh)) {
      const m = /^b?r(#*)"/.exec(s.slice(i, i + 40));
      if (m) {
        const close = '"' + m[1], end = s.indexOf(close, i + m[0].length);
        if (end < 0) { take('s', s.slice(i)); return stateOf('s', false, close); }
        take('s', s.slice(i, end + close.length), 'str');
        continue;
      }
    }
    if (cfg.verbatim && !idChar(cfg, prevCh) && /^\$?@"/.test(s.slice(i, i + 3))) {
      const open = s[i] === '$' ? 3 : 2, end = s.indexOf('"', i + open);
      take('s', end < 0 ? s.slice(i) : s.slice(i, end + 1), 'str');
      continue;
    }
    let pre = 0;
    if (cfg.prefix && !idChar(cfg, prevCh)) { const m = cfg.prefix.exec(s.slice(i, i + 3)); if (m) pre = m[0].length; }
    if (cfg.charRust && c === "'") {
      // 'x' or '\n' is a character; 'a on its own is a lifetime or a label, and plain
      const ch = s.codePointAt(i + 1);
      const w = ch > 0xffff ? 2 : 1;
      if (s[i + 1] === '\\') { const end = closeAt(s, i + 1, "'", true); take('s', end < 0 ? s.slice(i) : s.slice(i, end), 'str'); continue; }
      if (s[i + 1 + w] === "'") { take('s', s.slice(i, i + 2 + w), 'str'); continue; }
      take('', c, 'p:' + c);
      continue;
    }
    const q = cfg.strings && cfg.strings.find(x => s.startsWith(x.open, i + pre));
    if (q) {
      const from = i + pre + q.open.length, end = closeAt(s, from, q.close, q.esc);
      if (end < 0) {
        take('s', s.slice(i));
        if (q.ml) return stateOf('s', q.esc, q.close);
        break;
      }
      const text = s.slice(i, end);
      // a JSON key is a string followed by a colon
      let kind = 's';
      if (cfg.keys) { let j = end; while (s[j] === ' ' || s[j] === '\t') j++; if (s[j] === ':') kind = 'k'; }
      take(kind, text, 'str');
      continue;
    }
    // numbers: not inside a name; a minus sign where a value starts (JSON, CSS)
    if (cfg.neg && c === '-' && DIGIT.test(s[i + 1] || '') && (i === 0 || /[\s:,([]/.test(s[i - 1]))) {
      const m = (cfg.unit ? NUM_UNIT : NUM).exec(s.slice(i + 1));
      take('n', '-' + m[0], 'num');
      continue;
    }
    if (DIGIT.test(c) && !idChar(cfg, prevCh)) {
      const m = (cfg.unit ? NUM_UNIT : NUM).exec(s.slice(i));
      take('n', m[0], 'num');
      continue;
    }
    if (cfg.css) {
      // at-rules, !important, and colours (#d2a650)
      const at = /^@[\w-]+/.exec(s.slice(i)) || (/^!important\b/i.exec(s.slice(i)));
      if (at) { take('k', at[0], 'kw'); continue; }
      const hex = c === '#' && /^#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{3,4})(?![\w-])/.exec(s.slice(i));
      if (hex) { take('n', hex[0], 'num'); continue; }
    }
    if (cfg.ruby && c === ':' && s[i + 1] !== ':' && prevCh !== ':' && /[A-Za-z_]/.test(s[i + 1] || '') && !idChar(cfg, prevCh)) {
      const m = /^:[A-Za-z_]\w*[?!]?/.exec(s.slice(i));
      take('n', m[0], 'num');
      continue;
    }
    // names and the language's words (a word after a dot is a member's name, and plain)
    if (idChar(cfg, c) && !DIGIT.test(c)) {
      let j = i + 1;
      while (j < n && idChar(cfg, s[j])) j++;
      if (cfg.ruby && (s[j] === '?' || s[j] === '!') && s[j + 1] !== '=') j++;
      const w = s.slice(i, j);
      const member = cfg.member && lastSolid === '.';
      const kind = member ? '' : cfg.kw.has(w) ? 'k' : cfg.consts && cfg.consts.has(w) ? 'n' : '';
      take(kind, w, kind === 'k' ? 'kw:' + w : 'id');
      continue;
    }
    // JavaScript's regular expressions, where a value can start (never after a name, a number or a closing bracket)
    if (cfg.regex && c === '/' && regexCanStart(prev)) {
      let j = i + 1, inClass = false;
      for (; j < n; j++) {
        const d = s[j];
        if (d === '\\') { j++; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      if (j < n && j > i + 1) {
        j++;
        while (j < n && /[a-z]/.test(s[j])) j++;
        take('s', s.slice(i, j), 'str');
        continue;
      }
    }
    // anything else, one character at a time (a whole character, past U+FFFF too)
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
    take('', ch, 'p:' + ch);
  }
  return '';
}

function regexCanStart(prev) {
  if (!prev) return true;
  if (prev.startsWith('kw:')) return REGEX_AFTER.has(prev.slice(3));
  if (prev.startsWith('p:')) return !')]}'.includes(prev.slice(2));
  return false;
}

/** HTML and XML: tag names, quoted attribute values, comments; text between tags is text. 'T' is inside a tag. */
function html(s, state, p) {
  const n = s.length;
  let i = 0, inTag = state === 'T';
  if (state && state !== 'T') {
    const end = s.indexOf('-->');
    if (end < 0) { p.add('c', s); return state; }
    p.add('c', s.slice(0, end + 3));
    i = end + 3;
  }
  while (i < n) {
    if (inTag) {
      const c = s[i];
      if (c === '>') { p.add('', c); i++; inTag = false; continue; }
      if (c === '"' || c === "'") {
        const end = s.indexOf(c, i + 1);
        if (end < 0) { p.add('s', s.slice(i)); return 'T'; }
        p.add('s', s.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
      p.add('', ch);
      i += ch.length;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) { p.add('c', s.slice(i)); return 'cr-->'; }
      p.add('c', s.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    const m = s[i] === '<' && /^<(\/?)([A-Za-z!?][\w:.-]*)/.exec(s.slice(i));
    if (m) {
      p.add('', '<' + m[1]);
      p.add('k', m[2]);
      i += m[0].length;
      inTag = true;
      continue;
    }
    // text up to the next '<'
    let j = s.indexOf('<', i + 1);
    if (j < 0) j = n;
    p.add('', s.slice(i, j));
    i = j;
  }
  return inTag ? 'T' : '';
}

const YAML_LIT = /^(?:true|false|null|yes|no|on|off|~|True|False|Null|Yes|No|On|Off|TRUE|FALSE|NULL|[-+]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|0x[\da-fA-F]+)$/;

/** YAML: keys, comments, quoted strings, and a value that is a literal (true, 42, null). */
function yaml(s, p) {
  let i = 0;
  const m = /^(\s*(?:-\s+)*)((?:"[^"]*"|'[^']*'|[^\s#'"{[\]}:,-][^#:]*?|-[^\s#:][^#:]*?))(\s*:)(?=\s|$)/.exec(s);
  if (m) { p.add('', m[1]); p.add('k', m[2]); p.add('', m[3]); i = m[0].length; }
  else { const d = /^(\s*(?:-\s+)*)/.exec(s); p.add('', d[0]); i = d[0].length; }
  // the rest: a value, perhaps quoted, then perhaps a comment
  const rest = s.slice(i);
  let j = 0;
  while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
  p.add('', rest.slice(0, j));
  let body = rest.slice(j), comment = '';
  // a # starts a comment where a word starts, outside quotes
  if (body[0] === '"' || body[0] === "'") {
    const end = closeAt(body, 1, body[0], body[0] === '"');
    const str = end < 0 ? body : body.slice(0, end);
    p.add('s', str);
    body = body.slice(str.length);
    const c = /(^|\s)#/.exec(body);
    if (c) { p.add('', body.slice(0, c.index + c[1].length)); p.add('c', body.slice(c.index + c[1].length)); }
    else p.add('', body);
    return '';
  }
  const c = /(^|\s)#/.exec(body);
  if (c) { comment = body.slice(c.index + c[1].length); body = body.slice(0, c.index + c[1].length); }
  const trimmed = body.trimEnd();
  if (trimmed && YAML_LIT.test(trimmed)) { p.add('n', trimmed); p.add('', body.slice(trimmed.length)); }
  else p.add('', body);
  p.add('c', comment);
  return '';
}
