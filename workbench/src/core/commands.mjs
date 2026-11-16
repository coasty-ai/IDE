// Natural-language commands: turn what the person typed or said into an intent for the engine.
//
// Rule-based, no model calls. Forgiving of speech-to-text output: no punctuation, all lowercase,
// filler words ("um", "okay so", "please"), contractions with or without apostrophes, and a few
// common mishearings ("code x" for Codex, "cloud and codex" for "Claude and Codex").
//
// Intents (see ARCHITECTURE.md, "Natural-language commands"):
//   start { tasks: [{ task, harness, machine }] }   task { task }        answer { agentId, text }
//   allow { agentId } / deny { agentId }            stop { agentIds }    stop_all
//   say { agentId, text }   status { agentId? }     spend                sleep / wake { machineIds }
//   sleep_idle              forget { agentIds }     continue { agentId }
//   changes { agentId }     merge { agentId, into?, bare? }              discard { agentId, bare? }
//   confirm { go }          connect                 unknown { text }
//   permissions { mode: 'full'|'ask' }   full permissions on (the engine asks first, with a card) or off
// Anything that is not one of Workbench's own commands, or an answer to what is on screen, is the prompt for a new
// agent: { kind: 'task', task } with the person's words exactly as typed (only the spaces around them go), and the
// engine starts it at once. "thanks", "ok", "hi", "help", an emoji, a never-mind: all prompts. `unknown` is left for
// nothing said, a yes that is not enough for the card on screen (or asked), and words that answer nothing while a
// permission waits. Answers, messages and a start's task keep their edges too (asTyped).
// Extra fields some intents carry: askId (allow, deny, answer), text (deny: the person's words, such as
// "no, use the staging database"), conditional (deny: a yes that came with conditions, "yes but only in the
// tests folder"; text is the whole reply), sure: false (stop, say: the words found the agent but did not name
// it, so the engine asks first), needsMe (status: "what needs me"), into (merge: the branch the person named,
// "main" or "master" or their current branch by name; left out for "my branch"). An allow never carries words.
// changes, merge and discard always name a root agent (a helper stands for its agent); agentId is null when the
// words did not make clear which one, and `bare` when they pointed at work with no agent meant ("throw it away" with
// none in the centre): the engine then takes the one finished agent, or names them. Merge and discard are always asked
// first (the engine shows a card). While two helpers of the agent in the centre wait, a yes or a no is { kind: 'allow' |
// 'deny', agentId: <that agent>, askId: null }: the engine says which wait.
// A launch's harness is the agent the words named ("codex", "claude"), or null: the engine then gives the work to
// the person's default agent. A start that says no work ("start an agent", "new agent", "start codex") is { kind:
// 'start', tasks: [], task: null, harness }, with harness the one agent the words named (else null), and the engine
// asks what that agent should work on.
import { clip } from '../shared/format.mjs';
import { ENDED, LOOK, DONE } from '../shared/states.mjs';
import { FILLER } from '../shared/filler.mjs';

// ---------------------------------------------------------------------------------------------
// Words

// Tables that typed words index have no prototype: "constructor" and "toString" are no entries.
const CONTRACTIONS = Object.assign(Object.create(null), {
  "what's": ['what', 'is'], whats: ['what', 'is'], "how's": ['how', 'is'], hows: ['how', 'is'],
  "it's": ['it', 'is'], "that's": ['that', 'is'], thats: ['that', 'is'], "where's": ['where', 'is'],
  "who's": ['who', 'is'], "there's": ['there', 'is'], "here's": ['here', 'is'],
  "i'm": ['i', 'am'], "i'd": ['i', 'would'], "i've": ['i', 'have'], "i'll": ['i', 'will'],
  "we're": ['we', 'are'], "you're": ['you', 'are'], "they're": ['they', 'are'], "we've": ['we', 'have'],
  dont: ["don't"], cant: ["can't"], wont: ["won't"], lets: ["let's"], "let's": ["let's"],
  didnt: ["didn't"], doesnt: ["doesn't"], isnt: ["isn't"],
  ok: ['okay'], k: ['okay'], kay: ['okay'], 'o.k': ['okay'], okey: ['okay'],
  pls: ['please'], plz: ['please'], thx: ['thanks'], nevermind: ['never', 'mind'],
  todays: ["today's"],
});

/**
 * Filler (disfluencies), dropped wherever it appears to find a command ("um, stop everything"). Shared with the page,
 * which sends nothing spoken that is only filler; typed, it is said all the same (parse).
 */
const DISFLUENCY = FILLER;
/** Soft openers, dropped from the start ("okay so", "hey", "right"). */
const SOFT_LEAD = new Set(['okay', 'so', 'well', 'hey', 'hi', 'hello', 'alright', 'right', 'like', 'actually', 'basically', 'oh', 'and', 'then', 'now', 'also', 'workbench', 'yo', 'listen']);
/** Polite or framing openers, dropped from the start of commands and tasks. */
const POLITE = [
  ['please'], ['kindly'], ['just'], ['maybe'], ['can', 'you'], ['could', 'you'], ['would', 'you'], ['will', 'you'],
  ['can', 'we'], ['could', 'we'], ['i', 'want', 'you', 'to'], ['i', 'need', 'you', 'to'],
  ['i', 'would', 'like', 'you', 'to'], ['i', 'want', 'to'], ['i', 'would', 'like', 'to'], ['we', 'need', 'to'],
  ['i', 'need', 'to'], ['we', 'should'], ['you', 'should'], ['i', 'think', 'we', 'should'], ['go', 'ahead', 'and'],
  ['go', 'and'], ["let's"], ['try', 'and'], ['help', 'me'],
];
const TRAILING = [['please'], ['thanks'], ['thank', 'you'], ['for', 'me'], ['right', 'now'], ['now'], ['asap'], ['if', 'you', 'can']];

/** Words that never identify an agent. */
const REF_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'its', 'it', 'one', 'ones',
  'agent', 'agents', 'helper', 'helpers', 'task', 'tasks', 'job', 'jobs', 'thing', 'things', 'guy', 'bot', 'worker',
  'please', 'now', 'just', 'on', 'in', 'of', 'for', 'to', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'doing',
  'about', 'up', 'all', 'any', 'some', 'which', 'who', 'called', 'named', 'working', 'running', 'session', 'instance',
  'from', 'at', 'by', 'there', 'here', 'me', 'i', 'you', 'we', 'do', 'does', 'did', 'has', 'have', 'had',
  'why', 'what', 'how', 'where', 'when', 'them', 'they', 'their', 'us']);
/** Little words that never join the next word into one ("the menu" is no "themenu"); "check out" and "clean up" do. */
const PAIR_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'its', 'it', 'in', 'on',
  'of', 'for', 'to', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'me', 'i', 'you', 'we', 'them', 'they', 'their', 'from',
  'at', 'by', 'why', 'what', 'how', 'where', 'when']);
const pairable = (x, y) => !PAIR_STOP.has(x) && !PAIR_STOP.has(y);

/** Phrases that point at the focused agent. */
const PRONOUN_REFS = new Set(['it', 'this', 'that', 'this one', 'that one', 'the current one', 'current one', 'the current agent',
  'this agent', 'that agent', 'the agent', 'the focused one', 'the selected one', 'the one i am looking at', 'him', 'her']);

const NUMBER = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// Speech-to-text often writes these for numbers right after "cloud": "cloud to" is Cloud 2.
const NUMBER_SOUNDALIKE = { won: 1, to: 2, too: 2, tree: 3, free: 3, for: 4, fore: 4, ate: 8 };

function normWord(raw) {
  // Letters and digits of any script count ("登录", "исправь"); full-width ones read as their plain forms ("ｆｉｘ").
  return raw.normalize('NFKC').toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/^[^\p{L}\p{M}\p{N}]+/u, '').replace(/[^\p{L}\p{M}\p{N}]+$/u, '');
}

/** A line break, as typed or pasted: "\n", "\r\n", "\r", or Unicode's line and paragraph separators. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;
/** A letter or a digit, in any script: what makes a word. */
const WORDY = /[\p{L}\p{M}\p{N}]/u;

/**
 * Split text into tokens. `w` is the normalized word used for matching; `raw`, `start` and `end`
 * point back into the original text, so task and message text keep the person's own wording.
 */
function lex(text) {
  const toks = [];
  // Words end at spaces, and at the punctuation of scripts written without them ("codex，修复登录错误").
  const re = /[^\s，。！？：；、]+[，。！？：；、]*|[，。！？：；、]+/g;
  const gap = /\s*/y; // the spaces after a token, up to the next one
  let m;
  let piece = -1; // which piece of the text a token is, counting pieces that hold no word ("===")
  let skipped = 0; // pieces with no word since the last token
  while ((m = re.exec(text))) {
    piece++;
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    gap.lastIndex = end;
    // the token ends a phrase: punctuation, or the end of a line (a line of its own reads as a phrase, as after a comma)
    const nl = LINE_BREAK.test(gap.exec(text)[0]);
    const tail = /[,;:.!?，。！？：；、]["'”’)]*$/.test(raw) || nl;
    const at = { raw, start, end, tail, nl, piece, skipped, src: text };
    if (raw === '&' || raw === '+') { toks.push({ w: 'and', ...at }); skipped = 0; continue; }
    const w = normWord(raw);
    if (!w) { skipped++; continue; }
    const parts = CONTRACTIONS[w] || [w.endsWith("'s") ? w.slice(0, -2) : w];
    for (const p of parts) toks.push({ w: p, ...at });
    skipped = 0;
  }
  return toks;
}

/**
 * The person's own words for a run of tokens. Symbols between two words that follow each other in the text stay
 * ("use === instead of =="), and so does what lies between them over a line break (the next line's indentation); where
 * a caller took words out of the middle, the rest are joined by a space.
 */
function spanText(toks) {
  const seen = new Set();
  let out = '';
  let prev = null;
  for (const t of toks) {
    if (seen.has(t.start)) continue;
    seen.add(t.start);
    if (prev) {
      const together = prev.src === t.src && t.piece - prev.piece - 1 === t.skipped; // nothing taken out between them
      const between = together ? t.src.slice(prev.end, t.start) : '';
      out += together && LINE_BREAK.test(between) ? between : together && t.skipped > 0 ? ` ${between.trim()} ` : ' ';
    }
    out += t.raw;
    prev = t;
  }
  return out;
}

/** Trim quotes and closing punctuation from words that were joined after others were taken out of them (spanText). */
function tidy(s) {
  const t = String(s);
  if (LINE_BREAK.test(t.trim())) return t.trim();
  return t.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').replace(/[\s,;:.!]+$/, '').replace(/["'“”‘’]+$/, '').trim();
}

/** Whether nothing was taken out between these tokens: each follows the one before in the text. */
function together(toks) {
  return toks.every((t, i) => i === 0 || t.start === toks[i - 1].start || (t.src === toks[i - 1].src && t.piece - toks[i - 1].piece - 1 === t.skipped));
}

/**
 * The person's own words for a run of tokens, as typed: an answer, a message, a task after the words that start it.
 * When nothing was taken out between them, it is the text itself from the first to the last, reaching to the start of the
 * text when nothing before the first is a word, and to the end when nothing after the last is one (an opening brace, a
 * code fence, a closing quote or full stop: a pasted snippet keeps its edges). Only the spaces around it go. The first
 * word may have been put in its base form ("an agent that fixes" -> "fix"). Words taken out of the middle (a program's
 * name, a machine) leave the rest joined as spanText joins them.
 */
function asTyped(toks) {
  if (!toks.length) return '';
  if (!together(toks)) return tidy(spanText(toks));
  const first = toks[0];
  const last = toks[toks.length - 1];
  const src = first.src;
  const from = WORDY.test(src.slice(0, first.start)) ? first.start : 0;
  const more = WORDY.test(src.slice(last.end)); // words follow: a machine, a program or a "please" taken off after it
  const to = more ? last.end : src.length;
  const head = src.slice(first.start, first.end) === first.raw ? '' : first.raw; // a word put in its base form
  const text = (head ? src.slice(from, first.start) + head + src.slice(first.end, to) : src.slice(from, to)).trim();
  // the comma that set off the words taken off after it is no part of it ("the checkout bug, each on its own machine")
  return more ? text.replace(/[\s,;:]+$/, '') : text;
}

function seqAt(ws, i, seq) {
  return seq.every((x, k) => ws[i + k] === x);
}

/** Length of the first sequence in `seqs` that `ws` starts with, or 0. */
function startsWithSeq(ws, seqs) {
  for (const seq of seqs) if (seqAt(ws, 0, seq)) return seq.length;
  return 0;
}

function stripSoft(toks) {
  let k = 0;
  while (k < toks.length - 1 && SOFT_LEAD.has(toks[k].w)) k++;
  return toks.slice(k);
}

function stripPolite(toks, seqs = POLITE) {
  let cur = toks;
  for (let changed = true; changed;) {
    changed = false;
    const ws = cur.map(t => t.w);
    for (const seq of seqs) {
      if (seq.length < cur.length && seqAt(ws, 0, seq)) {
        cur = stripSoft(cur.slice(seq.length));
        changed = true;
        break;
      }
    }
  }
  return cur;
}

function stripTrailing(toks, seqs = TRAILING) {
  let cur = toks;
  // "fix the login, okay": an "okay" after a break is an aside; "check if the deploy is ok" keeps its own
  if (seqs === TRAILING && cur.length > 1 && cur[cur.length - 1].w === 'okay' && cur[cur.length - 2].tail) cur = cur.slice(0, -1);
  for (let changed = true; changed;) {
    changed = false;
    const ws = cur.map(t => t.w);
    for (const seq of seqs) {
      if (seq.length < cur.length && seqAt(ws, ws.length - seq.length, seq)) {
        cur = cur.slice(0, cur.length - seq.length);
        changed = true;
        break;
      }
    }
  }
  return cur;
}

/** Light stemming so "tests", "testing" and "tested" all match "test". */
function stem(w) {
  let s = w;
  if (s.length > 5 && s.endsWith('ing')) {
    s = s.slice(0, -3);
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) s = s.slice(0, -1); // running -> run
  } else if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/** "fixes" -> "fix", for "start an agent that fixes the login". */
function baseVerb(raw) {
  const lower = raw.toLowerCase();
  const irregular = { does: 'do', goes: 'go', has: 'have', is: 'be' };
  if (Object.hasOwn(irregular, lower)) return irregular[lower];
  if (lower.length <= 3 || !lower.endsWith('s') || lower.endsWith('ss')) return raw;
  if (lower.endsWith('ies')) return raw.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z)es$/.test(lower)) return raw.slice(0, -2);
  return raw.slice(0, -1);
}

function numberish(w, soundalikes) {
  if (w == null) return null;
  if (/^\d{1,2}$/.test(w)) return Number(w);
  if (Object.hasOwn(NUMBER, w)) return NUMBER[w];
  if (soundalikes && Object.hasOwn(NUMBER_SOUNDALIKE, w)) return NUMBER_SOUNDALIKE[w];
  return null;
}

// ---------------------------------------------------------------------------------------------
// Context

function context(ctx) {
  const x = ctx && typeof ctx === 'object' ? ctx : {};
  const agents = Array.isArray(x.agents) ? x.agents.filter(a => a && typeof a === 'object' && typeof a.id === 'string') : [];
  const machines = Array.isArray(x.machines) ? x.machines.filter(m => m && typeof m === 'object' && typeof m.id === 'string') : [];
  const focusId = typeof x.focusId === 'string' && x.focusId ? x.focusId : null;
  const focus = focusId ? agents.find(a => a.id === focusId) || null : null;
  // The person's current branch, when the engine knows it: "merge it into <branch>" may then name it.
  const repo = x.repo && typeof x.repo === 'object' ? x.repo : null;
  const branch = repo && typeof repo.branch === 'string' && repo.branch.trim() ? repo.branch.trim() : null;
  return { agents, machines, focusId, focus, asker: askHolder(focus, agents), pendingConfirm: x.pendingConfirm || null, branch };
}

const hasAsk = a => !!(a && a.ask && typeof a.ask === 'object');

/**
 * The agent whose question a short reply answers: the focused agent, or, when the focused agent
 * waits on nothing itself, its one helper that does.
 */
function askHolder(focus, agents) {
  if (!focus) return null;
  if (hasAsk(focus)) return focus;
  const waiting = agents.filter(a => a.id !== focus.id && (a.parentId === focus.id || a.rootId === focus.id) && hasAsk(a));
  return waiting.length === 1 ? waiting[0] : null;
}

function laptopId(c) {
  const m = c.machines.find(x => x.kind === 'laptop');
  return m ? m.id : 'laptop';
}

function cloudMachineId(n, c) {
  const m = c.machines.find(x => normName(x.name) === `cloud ${n}` || x.id === `cloud-${n}` || x.id === `cloud${n}`);
  return m ? m.id : 'cloud';
}

function normName(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Agent references: fuzzy word overlap with name and task

const wordCache = new WeakMap();

function wordSet(text) {
  const words = String(text || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    if (!REF_STOP.has(words[i])) set.add(stem(words[i]));
    if (i + 1 < words.length && pairable(words[i], words[i + 1])) set.add(stem(words[i] + words[i + 1])); // "check out" also reads as "checkout"
  }
  return set;
}

function agentWords(a) {
  const cached = wordCache.get(a);
  if (cached && cached.name === a.name && cached.task === a.task && cached.state === a.state) return cached;
  const label = (LOOK[a.state] && LOOK[a.state].label) || '';
  const v = { name: a.name, task: a.task, state: a.state, nameW: wordSet(a.name), taskW: wordSet(a.task), stateW: wordSet(label), nameKey: refKey(String(a.name || '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) };
  wordCache.set(a, v);
  return v;
}

/** The meaningful words of a name, for "is this the whole name?": "the Onboarding agent" = "onboarding". */
function refKey(words) {
  return [...new Set(words.filter(w => w && !REF_STOP.has(w)).map(w => stem(w.replace(/-/g, ''))))].sort().join(' ');
}

function hit(set, s) {
  if (set.has(s)) return true;
  if (s.length >= 4) for (const x of set) if (x.startsWith(s)) return true; // "clean" finds "cleanup"
  return false;
}

/** How well the reference words match one agent. Name words count 2, task or state words 1. */
function scoreAgent(ws, a) {
  const A = agentWords(a);
  let units = 0;
  let matched = 0;
  let total = 0;
  for (let i = 0; i < ws.length; i++) {
    if (i + 1 < ws.length && pairable(ws[i], ws[i + 1])) {
      const pair = stem(ws[i] + ws[i + 1]);
      if (A.nameW.has(pair) || A.taskW.has(pair)) {
        // Two words matched as one ("check out" = "checkout"): worth the same as two word matches.
        units += 2; matched += 2; total += A.nameW.has(pair) ? 4 : 2; i++;
        continue;
      }
    }
    if (REF_STOP.has(ws[i])) continue;
    const s = stem(ws[i].replace(/-/g, ''));
    units++;
    if (hit(A.nameW, s)) { matched++; total += 2; } else if (hit(A.taskW, s) || A.stateW.has(s)) { matched++; total += 1; }
  }
  return { units, matched, total };
}

/**
 * How many words of the agent's name the reference says, when it says nothing but words of the
 * name; 0 when it says anything else. "the check out fix" says both words of Checkout fix.
 */
function nameWords(ws, a) {
  const A = agentWords(a);
  let n = 0;
  for (let i = 0; i < ws.length; i++) {
    if (i + 1 < ws.length && !REF_STOP.has(ws[i]) && pairable(ws[i], ws[i + 1]) && A.nameW.has(stem(ws[i] + ws[i + 1]))) { n += 2; i++; continue; }
    if (REF_STOP.has(ws[i])) continue;
    if (!hit(A.nameW, stem(ws[i].replace(/-/g, '')))) return 0;
    n++;
  }
  return n;
}

/** The reference names this agent: two or more words of its name, or all of a shorter name, and nothing else. */
function names(ws, a) {
  const n = nameWords(ws, a);
  const size = agentWords(a).nameKey ? agentWords(a).nameKey.split(' ').length : 0;
  return n > 0 && n >= Math.min(2, size);
}

/**
 * The reference says every word of the agent's name, and nothing else: "the invoice export agent", and "the check out
 * fix" for Checkout fix (two words heard for one). Part of it, "the unused imports" for Remove unused imports, does not.
 */
function saysWhole(ws, a) {
  const key = agentWords(a).nameKey;
  if (!key || nameWords(ws, a) === 0) return false;
  const said = new Set();
  for (let i = 0; i < ws.length; i++) {
    if (REF_STOP.has(ws[i])) continue;
    said.add(stem(ws[i].replace(/-/g, '')));
    for (const part of ws[i].split('-')) if (part) said.add(stem(part)); // "feature-flag" says "feature" and "flag"
    if (i + 1 < ws.length) said.add(stem(ws[i] + ws[i + 1]));
  }
  return key.split(' ').every(k => said.has(k));
}

/**
 * Resolve one reference ("the flaky test", "it", "search cleanup") to an agent.
 * `full`: every word of the reference matched. `sure`: also unmistakable, because it is "it",
 * an id, the agent's whole name, or at least two matching words ("stop the tests" is not sure).
 * `named`: stricter, for what acts at once (stop, tell): "it", an id, or two or more words of one
 * agent's name (all of it, when the name is one word) and nothing else. Words of its task or state
 * find an agent but do not name it ("stop the stuck one", "cancel the half-finished orders"), and
 * neither do words that another running agent's name has too. A helper does not count against its root.
 * @returns {{ ids: string[], full: boolean, sure: boolean, named: boolean, pronoun?: boolean, coverage: number, total: number }}
 */
function resolveRef(toks, c) {
  const ws = toks.map(t => t.w);
  const none = { ids: [], full: false, sure: false, named: false, coverage: 0, total: 0 };
  if (!ws.length) return none;
  if (PRONOUN_REFS.has(ws.join(' '))) {
    return c.focusId ? { ids: [c.focusId], full: true, sure: true, named: true, pronoun: true, coverage: 1, total: 99 } : { ...none, pronoun: true };
  }
  for (const a of c.agents) if (ws.includes(a.id.toLowerCase())) return { ids: [a.id], full: true, sure: true, named: true, coverage: 1, total: 99 };
  let best = null;
  const said = refKey(ws);
  for (const a of c.agents) {
    const sc = scoreAgent(ws, a);
    if (!sc.units || !sc.matched) continue;
    const coverage = sc.matched / sc.units;
    if (coverage < 0.5) continue;
    // as well matched, the agent whose whole name the words are wins ("stop asking" for Stop asking, not Stop asking for password)
    const key = [coverage, sc.total, agentWords(a).nameKey === said ? 1 : 0, a.kind === 'helper' ? 0 : 1, ENDED.has(a.state) ? 0 : 1, a.id === c.focusId ? 1 : 0];
    if (!best || compareKeys(key, best.key) > 0) best = { a, key, coverage, total: sc.total, matched: sc.matched };
  }
  if (!best) return none;
  const full = best.coverage === 1;
  const sure = full && (best.matched >= 2 || refKey(ws) === agentWords(best.a).nameKey);
  const named = full && names(ws, best.a) && !c.agents.some(a => a !== best.a && !ENDED.has(a.state)
    && (best.a.kind === 'helper' || a.kind !== 'helper') && nameWords(ws, a) > 0);
  return { ids: [best.a.id], full, sure, named, coverage: best.coverage, total: best.total };
}

function compareKeys(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Resolve "the flaky test and search cleanup" to one or more agents. */
function resolveList(toks, c) {
  const whole = resolveRef(toks, c);
  if (whole.full) return whole;
  const parts = [];
  let cur = [];
  for (const t of toks) {
    if (t.w === 'and' || t.w === 'plus') { if (cur.length) parts.push(cur); cur = []; continue; }
    cur.push(t);
    if (t.tail) { parts.push(cur); cur = []; }
  }
  if (cur.length) parts.push(cur);
  if (parts.length < 2) return whole;
  const each = parts.map(p => resolveRef(p, c));
  if (each.every(r => r.ids.length)) {
    const ids = [...new Set(each.flatMap(r => r.ids))];
    return { ids, full: each.every(r => r.full), sure: each.every(r => r.sure), named: each.every(r => r.named), coverage: 1, total: 0 };
  }
  return whole;
}

// ---------------------------------------------------------------------------------------------
// Short replies: yes / no

const YES_STRONG = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yea', 'sure', 'okay', 'alright', 'fine', 'go', 'allow',
  'allowed', 'approve', 'approved', 'accept', 'accepted', 'permit', 'grant', 'granted', 'proceed', 'lgtm', 'affirmative',
  'absolutely', 'definitely', 'certainly', 'do']);
const YES_FILL = new Set(['ahead', 'for', 'it', 'that', 'this', 'one', 'please', 'just', 'once', 'now', 'then', 'run', 'let',
  'the', 'command', 'request', 'thing', 'is', 'good', 'great', 'sounds', 'looks', 'right', 'thanks', 'thank', 'you', 'and',
  'so', 'with', 'them', 'him', 'her', 'in', 'to', 'sure', 'go', 'yes', 'okay', 'do', 'whatever']);
const NO_STRONG = new Set(['no', 'nope', 'nah', 'nay', 'deny', 'denied', 'reject', 'rejected', 'refuse', 'block', 'never',
  "don't", 'not', 'decline', 'negative']);
const NO_FILL = new Set(['it', 'that', 'this', 'please', 'thanks', 'thank', 'you', 'way', 'allow', 'do', 'let', 'run', 'now',
  'yet', 'the', 'command', 'request', 'one', 'for', 'go', 'ahead', 'with', 'them', 'him', 'her', 'and', 'i', 'said']);

const CONFIRM_YES = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yea', 'sure', 'okay', 'alright', 'right', 'go', 'do', 'confirm',
  'confirmed', 'start', 'launch', 'proceed', 'absolutely', 'definitely', 'lgtm', 'correct', 'affirmative', 'good', 'great',
  'perfect', 'cool', 'nice', 'fine', 'please']);
const CONFIRM_YES_FILL = new Set(['it', 'that', 'ahead', 'for', 'please', 'now', 'then', 'sounds', 'looks', "let's", 'thanks',
  'thank', 'you', 'so', 'is', 'right', 'and', 'them', 'both', 'the', 'one', 'way', 'all', 'run', 'make', 'thing', 'just',
  'yes', 'okay', 'go', 'do', 'sure', 'very', 'that is', 'all', 'of']);
const CONFIRM_NO = new Set(['no', 'nope', 'nah', 'cancel', 'never', 'abort', 'stop', "don't", 'forget', 'scratch', 'wait',
  'hold', 'not', 'negative']);
const CONFIRM_NO_FILL = new Set(['mind', 'it', 'that', 'this', 'please', 'thanks', 'thank', 'you', 'on', 'off', 'now', 'yet',
  'the', 'idea', 'way', 'actually', 'maybe', 'later', 'do', 'about', 'sorry', 'a', 'second', 'sec', 'minute', 'one']);

/** Yes words that say what a launch does: "start it" is a yes only to a launch, never to a stop, a forget or a merge. */
const START_YES = new Set(['start', 'launch']);

/**
 * Each card's own words: "stop it" while "Stop Flaky test?" waits, "send it" for a message, "merge it" or "land it"
 * for a merge, "throw it away" or "discard it" for a throw-away. A forget card has none: "forget it" means never mind.
 * "scrap it" and "trash it" ask for a throw-away card, but they do not answer one: that card takes only its button,
 * "throw it away", "discard it" or "do it", and "scrap that" is one sound from "scratch that", which means never mind.
 */
const CARD_YES = { stop: ['stop'], say: ['send'], merge: ['merge', 'land', 'bring'], discard: ['discard', 'throw'], permissions: ['turn', 'switch'] };
/** Words that may come with a card's own yes: "bring it in", "throw it away", "merge its changes", "turn it on". */
const CARD_YES_FILL = { merge: ['in', 'its', 'work', 'changes', 'branch'], discard: ['away', 'out', 'its', 'work', 'changes', 'branch'],
  permissions: ['on', 'full', 'permissions', 'permission'] };
/** A card's own no: the throw-away card's "Keep it" button, and the full permissions card's "Keep asking", said. */
const CARD_NO = { discard: ['keep'], permissions: ['keep'] };
const CARD_NO_FILL = { discard: ['its', 'work', 'changes', 'them', 'all'], permissions: ['asking', 'off', 'me'] };

/**
 * A reply to the confirm card on screen: true (yes), false (no), 'asks' (a yes asked rather than said, such as
 * "is that right?": it answers nothing, so the card stays), 'keep' (a yes that is not enough for this card, such as
 * a bare "yes" to throwing work away: the card stays), or null (not a reply).
 */
function confirmReply(toks, kind, c) {
  // While "Stop Flaky test?" waits, "stop" and "stop it" mean yes; while "Tell Flaky test …?" waits, "send it" does.
  // A card without a kind is a launch.
  const launch = kind == null || kind === 'start';
  const own = (typeof kind === 'string' && Object.hasOwn(CARD_YES, kind)) ? CARD_YES[kind] : [];
  const ownFill = (typeof kind === 'string' && Object.hasOwn(CARD_YES_FILL, kind)) ? CARD_YES_FILL[kind] : [];
  const ownNo = (typeof kind === 'string' && Object.hasOwn(CARD_NO, kind)) ? CARD_NO[kind] : [];
  const ownNoFill = (typeof kind === 'string' && Object.hasOwn(CARD_NO_FILL, kind)) ? CARD_NO_FILL[kind] : [];
  const isYes = w => (CONFIRM_YES.has(w) && (launch || !START_YES.has(w))) || own.includes(w);
  const isNo = w => (CONFIRM_NO.has(w) && !own.includes(w)) || ownNo.includes(w);
  // The full permissions card: the words that ask for them say yes to it ("stop asking"), and the words that turn them
  // off say no: "ask first", "keep asking", and "turn it off", "switch it off" or "leave it off", which keep them off.
  // Those words with a question mark ask about the card rather than answer it: it stays. An agent's whole name is no answer.
  if (kind === 'permissions') {
    const bare = stripTrailing(stripPolite(stripSoft(toks), MODE_POLITE));
    const mode = namesAgent(toks, c) ? null : permissionsMode(bare);
    const off = /^(?:(?:no|nope|nah) )?(?:keep asking(?: me)?|(?:turn|switch|leave|keep) (?:(?:it|them) )?off)$/.test(bare.map(t => t.w).join(' '));
    if (mode || off) return endsAsking(toks) ? 'asks' : mode === 'full';
  }
  // Before the fillers go: "so" is one. Throwing work away and full permissions take their own words, so "make it so"
  // keeps those cards.
  if (toks.map(t => t.w).join(' ') === 'make it so') return yesAsked(toks) ? 'asks' : kind === 'discard' || kind === 'permissions' ? 'keep' : true;
  // "don't merge it", "do not throw it away": a no, though the card's own word is in it.
  const first = toks.map(t => t.w).filter(w => !SOFT_LEAD.has(w));
  const negated = first[0] === "don't" ? 1 : first[0] === 'do' && first[1] === 'not' ? 2 : first[0] === 'never' ? 1 : 0;
  if (negated && own.includes(first[negated]) && first.slice(negated + 1).every(w => CONFIRM_YES_FILL.has(w) || ownFill.includes(w))) return false;
  // A merge card says where it merges: "merge it into my branch" agrees with it, but a branch named here may not.
  let words = toks;
  let named = false;
  if (kind === 'merge') {
    const t = takeTarget(toks, c);
    if (t.said && t.toks.length) { words = t.toks; named = t.into !== undefined; }
  }
  const ws = words.map(t => t.w).filter(w => !SOFT_LEAD.has(w) || isYes(w));
  if (!ws.length) return null;
  const no = ws.some(isNo);
  const yes = ws.some(isYes);
  if (no && !yes && ws.every(w => isNo(w) || CONFIRM_NO_FILL.has(w) || ownNoFill.includes(w))) return false;
  if (yes && !no && ws.every(w => isYes(w) || CONFIRM_YES_FILL.has(w) || ownFill.includes(w))) {
    if (yesAsked(words)) return 'asks';
    if (named) return 'keep';
    // On a throw-away card a bare "yes" is not enough: only its own words ("throw it away", "discard it") or "do it".
    // "throw" counts only with its "away" or "out", and "do" only with its "it" or "that": a "throw" or a "do" cut short
    // ("do", "sure do", "yes do") is no answer.
    if (kind === 'discard') {
      const explicit = ws.some((w, i) => (w === 'do' && (ws[i + 1] === 'it' || ws[i + 1] === 'that')) || (own.includes(w) && w !== 'throw'))
        || (ws.includes('throw') && (ws.includes('away') || ws.includes('out')));
      if (!explicit) return 'keep';
    }
    // Turning full permissions on takes its own words too: "turn it on", "turn on full permissions" or "do it".
    if (kind === 'permissions') {
      const explicit = ws.some((w, i) => w === 'do' && (ws[i + 1] === 'it' || ws[i + 1] === 'that')) || (ws.some(w => own.includes(w)) && ws.includes('on'));
      if (!explicit) return 'keep';
    }
    return true;
  }
  // Another card's own yes ("start it", "yes launch it", "send it", "start it is that right" to a stop card): not this
  // card's yes, and no new work either: the card stays.
  if (!no && ws.some(w => CARD_VERBS.has(w) && !isYes(w)) && ws.every(w => isYes(w) || CARD_VERBS.has(w) || CONFIRM_YES_FILL.has(w)
    || ownFill.includes(w) || QUESTION_START.has(w))) return 'keep';
  // "scrap it", "trash that", "don't scrap it" to a throw-away card: one sound from "scratch that", so neither its yes nor
  // its no, and never new work: the card stays, and says how to answer it.
  if (kind === 'discard' && ws.some(w => w === 'scrap' || w === 'trash')
    && ws.every(w => isYes(w) || isNo(w) || w === 'scrap' || w === 'trash' || CONFIRM_YES_FILL.has(w) || CONFIRM_NO_FILL.has(w) || ownFill.includes(w))) return 'keep';
  // A permission's own answer ("allow it", "approve", "deny that"): not this card's, and never new work either.
  const pr = permissionReply(words);
  if (pr && (pr.kind === 'allow' || pr.kind === 'asks' || (pr.kind === 'deny' && !pr.text))) return 'keep';
  return null;
}

/** The yes words of one card kind or another that another card does not take: they keep that card (confirmReply). */
const CARD_VERBS = new Set(['start', 'launch', 'send']);

// A clear yes or no at the start of a longer reply. "go", "do", "okay" and "fine" are not here: they also begin
// commands and work requests ("go to search cleanup", "okay fix the login"), which are tried first.
const FIRST_YES = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yea', 'sure', 'allow', 'allowed', 'approve', 'approved',
  'accept', 'accepted', 'permit', 'grant', 'granted', 'proceed', 'lgtm', 'absolutely', 'definitely', 'certainly', 'affirmative']);
const FIRST_NO = new Set(['no', 'nope', 'nah', 'deny', "don't"]);
const PERMIT_WORDS = new Set(['allow', 'allowed', 'approve', 'approved', 'accept', 'accepted', 'permit', 'grant', 'granted']);
/** What an "allow" may be about when it answers a request: "allow it", "allow it once", "approve, but only in tests". */
const PERMIT_OBJECT = new Set(['it', 'that', 'this', 'them', 'once', 'only', 'but', 'the', 'just', 'for', 'please', 'and', 'if',
  'its', 'their', 'his', 'her', 'my', 'your', 'our', 'all', 'everything', 'both', 'these', 'those', 'a', 'an', 'one', 'one-time']);

/** Where the reply really starts: past "so", "well", "hey" (but not past "okay", which can be the yes itself). */
function replyStart(toks) {
  const k = toks.findIndex(t => !SOFT_LEAD.has(t.w) || YES_STRONG.has(t.w));
  return k < 0 ? toks.length : k;
}

const QUESTION_START = new Set(['what', 'why', 'how', 'which', 'who', 'whom', 'whose', 'where', 'when', 'is', 'are', 'was',
  'were', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have']);

/**
 * Words that ask something rather than answer: they end with "?", or start like a question ("what does it delete",
 * "should I allow it", "do I need to approve this"; "do it" is not one).
 */
function asksSomething(toks) {
  if (!toks.length) return false;
  if (/\?["'”’)]*$/.test(toks[toks.length - 1].raw)) return true;
  const ws = stripSoft(toks).map(t => t.w);
  return QUESTION_START.has(ws[0]) || (ws[0] === 'do' && ['i', 'we', 'you', 'they'].includes(ws[1]));
}

/**
 * Words a reply can open with before it says, or asks, anything: "yes", "okay", "go ahead", "so", "stop" on a stop card,
 * "merge it" on a merge card, "throw it away" on a throw-away card.
 */
const OPENERS = new Set([...SOFT_LEAD, ...YES_STRONG, ...CONFIRM_YES, 'ahead', 'please', 'thanks', 'for', 'stop', 'send', 'run', 'let', 'make',
  'merge', 'land', 'bring', 'in', 'discard', 'throw', 'away', 'out']);
/** Words whose "it" is the thing said yes to: "do it", "allow it", "go for it", "stop it". In "yes it is", "it" is no such word. */
const YES_VERB = new Set(['do', 'allow', 'approve', 'accept', 'permit', 'grant', 'confirm', 'start', 'launch', 'run', 'send', 'stop', 'let', 'make', 'for',
  'merge', 'land', 'bring', 'discard', 'throw']);

/** Words a left-out "is" or "are" leaves next to what is asked about: "that okay", "you sure", "that the right one". */
const STATE_YES = new Set(['okay', 'alright', 'fine', 'good', 'great', 'sure', 'right', 'correct', 'allowed', 'approved', 'accepted',
  'granted', 'perfect', 'cool', 'nice']);
const PERMIT = new Set(['allow', 'approve', 'accept', 'permit', 'grant']);

/**
 * A question said with its "is", "are" or "do" left out, as people say them: "that okay", "you sure", "it fine",
 * "that the right one", "you allow it", "okay with you". Typed, "that's okay" keeps its "is" and is no question; so are
 * "you go ahead", "allow it" and "thank you".
 */
function leftOutVerb(ws) {
  for (let i = 0; i < ws.length; i++) {
    if (!['it', 'that', 'this', 'you', 'we'].includes(ws[i])) continue;
    if (i > 0 && (YES_VERB.has(ws[i - 1]) || ws[i - 1] === 'thank')) continue; // "allow it", "thank you"
    if ((ws[i] === 'you' || ws[i] === 'we') && PERMIT.has(ws[i + 1])) return true;
    let j = i + 1;
    while (['the', 'one', 'thing', 'command', 'request'].includes(ws[j])) j++;
    if (STATE_YES.has(ws[j])) return true;
  }
  return /\b(?:with|for|by) you\b/.test(ws.join(' '));
}

/**
 * A yes asked rather than said, which answers nothing: it asks something (see asksSomething), it leaves out its "is"
 * (see leftOutVerb), or a question follows its opening yes ("yes is that right", "go ahead, is that okay", "do it, is
 * that right"). Spoken words have no "?". "yes do it", "that is fine" and "yes it is" are a yes.
 */
function yesAsked(toks) {
  if (asksSomething(toks)) return true;
  const ws = toks.map(t => t.w);
  if (leftOutVerb(ws)) return true;
  for (let i = 0; i < ws.length; i++) {
    if (QUESTION_START.has(ws[i]) || (ws[i] === 'do' && ['i', 'we', 'you', 'they'].includes(ws[i + 1]))) return true;
    const object = i > 0 && YES_VERB.has(ws[i - 1]) && ['it', 'that', 'this', 'them'].includes(ws[i]);
    if (!OPENERS.has(ws[i]) && !object) return false;
  }
  return false;
}

/**
 * "yes", "go ahead", "allow it" / "no", "don't", "deny". Returns { kind, text?, conditional? } or null.
 * Only a plain yes allows. A yes with more words ("yes but only in the tests folder", "allow it but only once") is a
 * no that carries the whole reply (`conditional`), so the agent hears the condition; an allow could not carry it.
 * A no with more words ("no, use the staging database") carries the words after the no.
 * A yes asked rather than said ("is it okay?", "do you allow it", "yes?") gives { kind: 'asks' }: it answers nothing.
 */
function permissionReply(toks) {
  const ws = toks.map(t => t.w).filter(w => !SOFT_LEAD.has(w) || YES_STRONG.has(w));
  if (!ws.length) return null;
  const no = ws.some(w => NO_STRONG.has(w));
  const yes = ws.some(w => YES_STRONG.has(w));
  const plainYes = /^(no problem|no worries|not a problem)$/.test(ws.join(' '))
    || (yes && !no && ws.every(w => YES_STRONG.has(w) || YES_FILL.has(w)));
  if (plainYes) return yesAsked(toks) ? { kind: 'asks' } : { kind: 'allow' };
  if (no && ws.every(w => NO_STRONG.has(w) || NO_FILL.has(w) || YES_STRONG.has(w))) return { kind: 'deny' };
  const k = replyStart(toks);
  // "don't we already have a linter?" asks; "don't use the production database" is a no that keeps its "don't"
  const dont = toks[replyStart(toks)];
  if (ws[0] === "don't" && (/[?？]["'”’)]*$/.test(toks[toks.length - 1].raw) || (!dont?.tail && ['we', 'you', 'i', 'they'].includes(ws[1])))) return { kind: 'asks' };
  if (FIRST_NO.has(ws[0])) return { kind: 'deny', text: asTyped(toks.slice(ws[0] === "don't" ? k : k + 1)) };
  // "yes, but what does it delete?" asks first: no answer yet (see parse, step 5). "allow users to export their data" is
  // no reply at all: what is allowed there is not the request.
  if (PERMIT_WORDS.has(ws[0]) && ws[1] && !PERMIT_OBJECT.has(ws[1])) return null;
  if (FIRST_YES.has(ws[0]) && !asksSomething(toks)) return { kind: 'deny', text: asTyped(toks.slice(k)), conditional: true };
  return null;
}

/**
 * A reply to a permission that is no command and no work, but starts like a yes or a no ("okay but not on main",
 * "fine, only the tests folder", "not on main"): a no that carries the words. Anything else stays unanswered.
 */
function looseReply(toks) {
  const k = replyStart(toks);
  const first = toks[k] && toks[k].w;
  if (!first || k + 1 >= toks.length) return null;
  if (NO_STRONG.has(first)) return { kind: 'deny', text: asTyped(toks.slice(k)) };
  // "go to the login page and it shows a 500", "do the same for the API" and "allow users to export" are no yes
  if ((first === 'go' || first === 'do') && !['ahead', 'it', 'for', 'on'].includes(toks[k + 1]?.w)) return null;
  if (PERMIT_WORDS.has(first) && toks[k + 1] && !PERMIT_OBJECT.has(toks[k + 1].w)) return null;
  if (YES_STRONG.has(first)) return { kind: 'deny', text: asTyped(toks.slice(k)), conditional: true };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Commands. Each matcher returns { intent, strong } or null. `strong` means the words cannot
// reasonably be an answer to a question the focused agent asked.

const STOP_ALL_WORDS = new Set(['everything', 'everyone', 'everybody', 'all', 'every']);
const STOP_ALL_FILL = new Set(['the', 'of', 'them', 'agents', 'agent', 'single', 'work', 'lot', 'now', 'right', 'at', 'once',
  'it', 'things', 'stuff', 'jobs', 'tasks', 'running', 'working', 'that', 'is', 'are', 'helpers', 'immediately', 'my', 'your', 'our']);
const STOP_VERBS = [['shut', 'down'], ['stop'], ['pause'], ['halt'], ['kill'], ['cancel'], ['abort'], ['terminate'], ['end'], ['quit'], ['interrupt']];
const STOP_WORDS = new Set(['stop', 'pause', 'halt', 'kill', 'abort', 'terminate']);
// "stop the flaky test immediately": how soon, not which agent.
const STOP_TAIL = [['right', 'away'], ['at', 'once'], ['immediately'], ['already'], ['again'], ['too']];

function matchStopAll(ws) {
  if (ws.length === 2 && STOP_ALL_WORDS.has(ws[0]) && ['stop', 'pause', 'halt'].includes(ws[1])) return true; // "everyone stop"
  if (ws.join(' ') === 'emergency stop') return true;
  const v = startsWithSeq(ws, STOP_VERBS);
  if (!v) return false;
  const rest = ws.slice(v);
  // "stop the agents", "stop all my agents", "stop all claude agents" and "stop, stop everything" are everything too
  const fill = w => STOP_ALL_WORDS.has(w) || STOP_ALL_FILL.has(w) || STOP_WORDS.has(w) || Object.hasOwn(HARNESS_ALIAS, w);
  return rest.length > 0 && rest.some(w => STOP_ALL_WORDS.has(w) || w === 'agents') && rest.every(fill);
}

/** Words after a stop verb that say nothing more than the stop: "stop it", "stop working", "stop stop stop". */
const BARE_STOP = new Set(['stop', 'pause', 'halt', 'kill', 'abort', 'it', 'now', 'please', 'right', 'there', 'working', 'running',
  'already', 'what', 'you', 'are', 'doing', 'immediately', 'at', 'once', 'for', 'a', 'moment', 'sec', 'second', 'everything',
  'that', 'trying', 'this']);

function matchStop(core, c) {
  let ws = core.map(t => t.w);
  // "shut it down", "shut everything off", "make it stop": a stop said the other way round
  const around = /^(?:shut (it|this|that|everything|them all|all of them) (?:down|off)|make (it|everything) stop)$/.exec(ws.join(' '));
  if (around) {
    const what = around[1] || around[2];
    if (what === 'everything' || what === 'them all' || what === 'all of them') return { intent: { kind: 'stop_all' }, strong: true };
    return { intent: { kind: 'stop', agentIds: c.focusId ? [c.focusId] : [] }, strong: !!c.focusId };
  }
  const v = startsWithSeq(ws, STOP_VERBS);
  if (!v) return null;
  // "Stop asking for password" is the name of the agent "Stop asking for password": said alone, it shows it, as any name does
  if (bareName(ws, c)) return null;
  // "stop checkout test?" asks about the agent of that name; "can you stop the flaky test?" still stops
  if (/[?？]["'”’)]*$/.test(core[core.length - 1].raw) && c.agents.some(a => saysWhole(ws, a))) return null;
  let rest = core.slice(v);
  // "stop, it's deleting the wrong files": after the stop and its comma comes why, not which agent
  // only after a comma, a full stop or the end of a line ("stop", then the reason on the next line), and not when the
  // words name the agent ("stop, stop the flaky test", "stop, onboarding"); "kill: (1234) No such process" is pasted output
  if (core[v - 1].tail && (/[,.!，。！]["'”’)]*$/.test(core[v - 1].raw) || core[v - 1].nl) && rest.length && STOP_WORDS.has(ws[0]) && !rest.some(t => STOP_ALL_WORDS.has(t.w))) {
    if (startsWithSeq(rest.map(t => t.w), STOP_VERBS)) {
      const again = matchStop(rest, c); // "stop, stop the flaky test"; "stop, stop deleting the files" is still a bare stop
      if (again && (again.intent.kind === 'stop' || again.intent.kind === 'stop_all') && again.intent.agentIds?.length !== 0) return again;
    }
    const named = resolveList(stripTrailing(rest, STOP_TAIL), c);
    if (!(named.ids.length && named.named && !named.pronoun)) rest = [];
  }
  if (rest.length >= 2 && (rest[0].w === 'working' || rest[0].w === 'work') && rest[1].w === 'on') rest = rest.slice(2);
  // "stop working", "stop what you're doing", "stop stop stop": a bare stop (not "stop everything", which is stop-all)
  if (rest.length && rest.every(t => BARE_STOP.has(t.w)) && !rest.some(t => t.w === 'everything') && ['stop', 'pause', 'halt', 'kill', 'abort', 'terminate'].includes(ws[0])) {
    if (!(rest.length === 1 && rest[0].w === 'that')) rest = [];
  }
  if (!rest.length) {
    // A bare "stop" means the focused agent. A bare "cancel" or "end" is too vague to stop anything.
    if (!['stop', 'pause', 'halt', 'kill', 'abort', 'terminate'].includes(ws[0])) return null;
    return { intent: { kind: 'stop', agentIds: c.focusId ? [c.focusId] : [] }, strong: !!c.focusId };
  }
  const refWords = rest.map(t => t.w).join(' ');
  if (ws[0] === 'cancel' && PRONOUN_REFS.has(refWords)) return null; // "cancel that" is not about an agent
  // "stop them": which ones is not clear, so the engine says so; never one agent picked by its spelling
  if (refWords === 'them' || refWords === 'they') return { intent: { kind: 'stop', agentIds: [] }, strong: false };
  // "stop its work", "stop the work": the agent in the centre, as "stop it"
  if (GENERIC_WORK.test(refWords)) return { intent: { kind: 'stop', agentIds: c.focusId ? [c.focusId] : [] }, strong: !!c.focusId };
  // "stop the tests from failing", "stop the flaky test from timing out": what to prevent, which is work; but "stop the
  // onboarding agent from running" is a stop
  const from = rest.findIndex((t, i) => i > 0 && i < rest.length - 1 && t.w === 'from');
  if (from > 0 && !rest.slice(from + 1).every(t => BARE_STOP.has(t.w))) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  if (from > 0) rest = rest.slice(0, from);
  // "stop an agent to fix the login" says what a new agent should do: work (the prompt, as typed: see parse), never a
  // stop of "Login fix" (the reference words would skip "an agent to" and find it).
  if (launchPhrase(rest.map(t => t.w))) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  const r = resolveList(stripTrailing(rest, STOP_TAIL), c);
  // Words that match nothing beside the agent's words say what to do, not which agent:
  // "stop the flaky test from timing out" is work, the prompt for a new agent like other work.
  if (r.ids.length && !r.full) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  // No agent matches (and it is no "it" or "that"): a work request that starts with a stop verb, so the whole sentence
  // is the prompt for a new agent: "Started Claude on “stop the flaky test from timing out”."
  if (!r.ids.length && !PRONOUN_REFS.has(refWords)) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  const intent = { kind: 'stop', agentIds: r.ids };
  if (r.ids.length && !r.named) intent.sure = false; // found, but not by its name: the engine asks first
  return { intent, strong: r.named };
}

// Earlier agents (from history) --------------------------------------------------------------

/** "forget search cleanup", "forget about it": take an agent out of history. Always asked first (engine). */
function matchForget(core, c) {
  const ws = core.map(t => t.w);
  if (ws[0] !== 'forget') return null;
  let rest = core.slice(1);
  if (rest[0] && rest[0].w === 'about') rest = rest.slice(1);
  if (!rest.length) return null;
  if (launchPhrase(rest.map(t => t.w))) return null; // "forget an agent to fix the login" names no agent
  const r = resolveList(stripTrailing(rest, STOP_TAIL), c);
  if (!r.ids.length || !r.full) return null; // "forget the old plan, use the new one" is work or an answer
  // "forget it" may mean never mind: it wins over a waiting question only when the words name the agent
  return { intent: { kind: 'forget', agentIds: r.ids }, strong: r.named && !r.pronoun };
}

/** Going on, said with nothing more: "go on", "keep going", "carry on", "continue". */
const GO_ON = /^(?:go on|keep going|carry on|continue|resume|keep at it|keep working|continue working|go on then|carry on then)$/;

/**
 * "continue search cleanup", "pick up it again": only for an agent from an earlier run (else the words go on). "go on",
 * "keep going", "carry on" and "continue" with nothing more continue the agent in the centre (a message that continues
 * it); with none, they are a prompt. Weak: a question takes them as its answer, and a stuck agent as its own choice.
 */
function matchContinue(core, c) {
  const ws = core.map(t => t.w);
  if (GO_ON.test(ws.join(' '))) return c.focusId ? { intent: { kind: 'continue', agentId: focusRoot(c) }, strong: false } : null;
  const v = startsWithSeq(ws, [['pick', 'up'], ['continue'], ['resume'], ['carry', 'on']]);
  if (!v) return null;
  const rest = stripTrailing(core.slice(v), [['again'], ['please']]);
  if (!rest.length) return null;
  const r = resolveRef(rest, c);
  const a = r.ids.length === 1 && r.full ? c.agents.find(x => x.id === r.ids[0]) : null;
  if (!a) return null;
  // "continue update docs" while Update docs is still here: how it is doing, not a new agent that names it
  if (!a.earlier) return r.sure ? { intent: { kind: 'status', agentId: a.id }, strong: false } : null;
  return { intent: { kind: 'continue', agentId: a.id }, strong: r.named };
}

// Source control: an agent's changes, merging them, throwing them away -----------------------

/** Words for what an agent did in its folder: "its changes", "search cleanup's diff", "the work from it". */
const WORK_NOUN = new Set(['changes', 'change', 'work', 'diff', 'diffs', 'edits', 'edit', 'commits', 'commit', 'branch']);
/**
 * The focused agent's work, said without its name: "its changes", "the diff", "all of its work", and "it's changes"
 * typed for "its". Only these determiners: "my changes" and "all changes" are not an agent's.
 */
const GENERIC_WORK = /^(?:all (?:of )?)?(?:its|their|the|this|that|his|her|it is) (?:changes|change|work|diff|diffs|edits|edit|commits|commit|branch)$/;
const WORK_HEAD = /^(?:all (?:of )?)?(?:(?:its|their|the|this|that) )?(?:changes|change|work|diff|diffs|edits|edit|commits|commit|branch)$/;
/** "the changes from search cleanup", "the work of 1a2b3c". */
const WORK_OF = new Set(['from', 'of', 'by', 'in', 'for']);
/** Agent names are short (four words at most from a task): a longer reference names nothing. Keeps dictation fast. */
const MAX_WORK_REF = 12;
/** How soon, not whose work: "merge it right away", "throw it away now". */
const WORK_TAIL = [['right', 'away'], ['at', 'once'], ['immediately'], ['again'], ['too'], ['as', 'well'], ['now'], ['please'], ['for', 'me']];
/** Words that start a new agent and give it work: "bring in an agent to fix the login", "stop an agent to fix the login". */
const LAUNCH_JOIN = new Set(['to', 'that', 'which', 'who', 'for', 'on', 'and']);

function launchPhrase(ws) {
  if (!launchNoun(ws)) return false;
  const n = parseNoun(ws, 0);
  return n.end < ws.length && LAUNCH_JOIN.has(ws[n.end]);
}

const isRoot = a => !a.parentId && a.kind !== 'helper';

/** The root agent an agent belongs to: itself, or a helper's agent (helpers work in their agent's folder). */
function rootOf(a, c) {
  let cur = a;
  for (let i = 0; cur && !isRoot(cur) && i < 16; i++) {
    const up = (typeof cur.rootId === 'string' && cur.rootId && cur.rootId !== cur.id) ? cur.rootId : cur.parentId;
    cur = typeof up === 'string' ? c.agents.find(x => x.id === up) || null : null;
  }
  return cur && isRoot(cur) ? cur : null;
}

/** The focused agent, as a root: a helper in the centre stands for its agent. */
function focusRoot(c) {
  if (!c.focusId) return null;
  if (!c.focus) return c.focusId; // not in the list: the engine looks it up and says so
  const r = rootOf(c.focus, c);
  return r ? r.id : null;
}

/** A card on screen that still waits (not one that ran out). */
const liveCard = c => (c.pendingConfirm && !c.pendingConfirm.gone ? c.pendingConfirm : null);

/**
 * The root that words pointing at work mean ("it", "all of it", "everything it did"). With a card on screen, "it" is
 * the card: its one agent (a merge or throw-away card names it, a stop card may), else none. Otherwise the agent in the
 * centre, else the one agent of a card that ran out, else null.
 */
function pointedRoot(c) {
  const card = c.pendingConfirm;
  if (!liveCard(c)) {
    const f = focusRoot(c);
    if (f || !card) return f;
  }
  const id = typeof card.agentId === 'string' && card.agentId ? card.agentId
    : Array.isArray(card.agentIds) && card.agentIds.length === 1 && typeof card.agentIds[0] === 'string' ? card.agentIds[0] : null;
  if (!id) return null;
  const a = c.agents.find(x => x.id === id);
  return a ? (rootOf(a, c)?.id ?? null) : id;
}

/** The words are nothing but an agent's whole name ("diff viewer", "merge command"): a name, not a command. */
function bareName(ws, c) {
  const meaningful = ws.filter(w => !REF_STOP.has(w));
  if (!meaningful.length || meaningful.length > MAX_WORK_REF) return false;
  const key = refKey(ws);
  return key.split(' ').length === meaningful.length && c.agents.some(a => agentWords(a).nameKey === key);
}

/**
 * The root agent these words name by themselves: its id (a helper's id stands for its agent), or words of its name
 * and nothing else, two or more of them (all of a one-word name), that no other root agent's name also has. Agents
 * that ended, and agents from an earlier run, count: theirs is the work that is merged or thrown away. When several
 * root agents have the words, the one whose whole name they are is named; two with that name give id null, so the
 * engine asks which one. Words that several names share and that are none's whole name ("the config files" beside
 * Update config files and Split config files per) name no agent: they keep their old meaning. Task words, state words
 * and helpers' names never name a root agent here, and neither do words for work alone: "the changes" and "your
 * changes" are no agent's name, even when an agent is called "Changes" (its id or "it" still name it).
 * `partial`: the words are part of the one agent's name, not all of it ("the unused imports" for Remove unused
 * imports). They name it, but they are not strong (see tooLoose).
 * @returns {{ id: string|null, form: 'id'|'name', partial?: true } | null}
 */
function namedRoot(ws, c) {
  const meaningful = ws.filter(w => !REF_STOP.has(w));
  if (!meaningful.length || meaningful.length > MAX_WORK_REF) return null;
  if (meaningful.length === 1) {
    const a = c.agents.find(x => x.id.toLowerCase() === meaningful[0]);
    if (a) {
      const r = rootOf(a, c);
      return r ? { id: r.id, form: 'id' } : null;
    }
  }
  if (meaningful.every(w => WORK_NOUN.has(w))) return null;
  const having = c.agents.filter(a => isRoot(a) && nameWords(ws, a) > 0);
  if (!having.some(a => names(ws, a))) return null;
  if (having.length === 1) {
    const a = having[0];
    return saysWhole(ws, a) ? { id: a.id, form: 'name' } : { id: a.id, form: 'name', partial: true };
  }
  const whole = having.filter(a => saysWhole(ws, a));
  if (!whole.length) return null;
  return { id: whole.length === 1 ? whole[0].id : null, form: 'name' };
}

/**
 * Whose work the words mean, for merging, throwing away and showing changes. Strict: the words must name the agent
 * (see namedRoot), or point at the focused one ("it", "this one", "its changes", "the diff").
 * `form`: 'id' and 'name' name it; 'pronoun' ("it") and 'generic' ("its changes") mean the focused agent.
 * `partial`: a 'name' that is only part of the agent's name (see namedRoot).
 * `noun`: the words said "changes", "work", "diff" or the like. `id` is null when nothing is focused, or when two
 * root agents share the name. Null when the words name no agent, so they keep their old meaning.
 * @returns {{ id: string|null, form: 'id'|'name'|'pronoun'|'generic', partial?: true, noun: boolean } | null}
 */
function workRef(toks, c) {
  const ws = toks.map(t => t.w);
  if (!ws.length || ws.length > MAX_WORK_REF) return null;
  // The words whole first: an agent may be called "Diff viewer" or "Work queue". "the diff viewer's diff" and "the
  // work queue's work" are its name and then its work: the last word is no part of the name the rest already says.
  const whole = namedRoot(ws, c);
  if (whole) {
    const head = ws.length > 1 && WORK_NOUN.has(ws[ws.length - 1]) ? namedRoot(ws.slice(0, -1), c) : null;
    return { ...whole, noun: !!head && head.id === whole.id };
  }
  const phrase = ws.join(' ');
  if (PRONOUN_REFS.has(phrase) || POINTED_WORK.test(phrase)) return { id: pointedRoot(c), form: 'pronoun', noun: false };
  if (GENERIC_WORK.test(phrase)) return { id: pointedRoot(c), form: 'generic', noun: true };
  // "search cleanup's changes" (lexed without its "'s"), "this agent's work".
  if (ws.length > 1 && WORK_NOUN.has(ws[ws.length - 1])) {
    const head = ws.slice(0, -1);
    const named = namedRoot(head, c);
    if (named) return { ...named, noun: true };
    if (PRONOUN_REFS.has(head.join(' '))) return { id: pointedRoot(c), form: 'pronoun', noun: true };
  }
  // "the changes from search cleanup", "all the work of 1a2b3c".
  const n = ws.findIndex(w => WORK_NOUN.has(w));
  if (n >= 0 && n + 2 < ws.length && WORK_OF.has(ws[n + 1]) && WORK_HEAD.test(ws.slice(0, n + 1).join(' '))) {
    const of = ws.slice(n + 2);
    const named = namedRoot(of, c);
    if (named) return { ...named, noun: true };
    if (PRONOUN_REFS.has(of.join(' '))) return { id: pointedRoot(c), form: 'pronoun', noun: true };
  }
  return null;
}

/**
 * Words that point at an agent's work without naming it, said after merge or throw away: "them", "all of it", "it all",
 * "everything", "everything it did", "whatever it changed". Like "it", they mean the agent in the centre (pointedRoot).
 */
const POINTED_WORK = /^(?:all (?:of )?)?(?:it|that|this|them|these|those)(?: all)?$|^(?:everything|all|it all|them all|all of them)(?: (?:it|they) (?:did|made|changed|wrote|has done|have done|has changed|did here))?$|^(?:whatever|what) (?:it|they) (?:did|made|changed|wrote)$/;

/**
 * Something else on screen that "it" or "the changes" may be about: a confirm card, or a request (a question, a
 * stuck ask, a permission) from the focused agent or its one waiting helper. Words that do not name an agent then
 * keep their old meaning (the card's words, the answer, the permission's reply), never these commands.
 */
function screenBusy(c) {
  return !!liveCard(c) || hasAsk(c.asker);
}

/** A form that does not name the agent: "it", "its changes", a bare "merge". */
const weakForm = ref => ref.form === 'pronoun' || ref.form === 'generic' || ref.form === 'bare';
/** The words name the agent outright, so they win over an answer: its id, or its whole name. */
const strongRef = ref => !weakForm(ref) && !ref.partial;
/**
 * Words too loose to act on now, so they keep their old meaning. A weak form, while a question, a stuck ask or a
 * permission waits ("it" may be about that), or while a card waits that is about no one agent ("it" is that card).
 * Part of a name ("the unused imports" for Remove unused imports), while a question, a stuck ask or a permission waits:
 * the words are the reply to it, never a card that takes its place. A card has no "it" for a name, so on a card part of
 * a name is another command, as a whole name is.
 */
const tooLoose = (ref, c) => (weakForm(ref) && (liveCard(c) ? !ref.id : hasAsk(c.asker))) || (!!ref.partial && hasAsk(c.asker));

/**
 * What a merge or throw-away whose words are too loose for now gives: on a card about no one agent, the card stays
 * (unknown: never new work); else nothing, and the words keep their old meaning (the answer, the permission's reply).
 */
const looseWork = (ref, c) => (weakForm(ref) && liveCard(c) ? { intent: { kind: 'unknown' }, strong: true } : null);

/**
 * The intent for a merge or throw-away of `ref`'s agent. Words that point at work without naming it, with no agent in
 * the centre or on a card, are `bare`: the engine takes the one agent whose work it could act on, or names the ones it
 * could, never a new prompt. Two agents of the name give no agent and no `bare`: the engine asks which one.
 */
function workIntent(kind, ref) {
  const intent = { kind, agentId: ref.id };
  if (!ref.id && weakForm(ref)) intent.bare = true;
  return intent;
}

const INTO = new Set(['into', 'onto', 'to', 'in', 'on']);
/** The person's current branch, said without its name. */
const MINE = new Set(['my branch', 'my own branch', 'my current branch', 'the current branch', 'this branch', 'mine', 'my code',
  'my copy', 'my checkout', 'my folder', 'my repo', 'my repository', 'the repo', 'the repository', 'here']);

/** "main", "the master branch", "my branch", or the current branch by name (when ctx gives it). Null for anything else. */
function targetOf(ws, c) {
  const s = ws.join(' ');
  if (!s) return null;
  if (MINE.has(s)) return { into: undefined };
  const m = /^(?:the )?(main|master)(?: branch)?$/.exec(s);
  if (m) return { into: m[1] };
  if (c && c.branch) {
    const b = c.branch.toLowerCase();
    if (s === b || s === `the ${b} branch` || s === `${b} branch` || s === `the ${b}`) return { into: c.branch };
  }
  return null;
}

/**
 * Where to merge, said at the end: "into main", "onto my branch", "to master". `said`: a target was there;
 * `into`: the branch it names, or undefined for the current branch ("my branch", "here"). Anything else is no target.
 */
function takeTarget(toks, c) {
  const ws = toks.map(t => t.w);
  if (ws.length > 1 && ws[ws.length - 1] === 'here') return { toks: toks.slice(0, -1), into: undefined, said: true }; // "merge it here"
  for (let i = Math.max(0, ws.length - 5); i < ws.length; i++) {
    if (!INTO.has(ws[i])) continue;
    const t = targetOf(ws.slice(i + 1), c);
    if (t) return { toks: toks.slice(0, i), into: t.into, said: true };
  }
  return { toks, into: undefined, said: false };
}

/**
 * "merge search cleanup", "merge it", "land it", "bring its changes in", "merge it into main": always asked first (the
 * engine shows a merge card). The words must name the agent; "merge the two config files" stays work. A whole name or
 * an id is strong. "it", "its changes" and a bare "merge" are weak, and they keep their old meaning while anything else
 * waits on screen; so does part of a name while a question, a stuck ask or a permission waits (see tooLoose).
 */
function matchMerge(core, c) {
  const ws = core.map(t => t.w);
  const bring = ws[0] === 'bring';
  if (!bring && ws[0] !== 'merge' && ws[0] !== 'land') return null;
  if (bareName(ws, c)) return null; // "merge command" is the name of the agent "Merge command"
  let rest = stripTrailing(core.slice(1), WORK_TAIL);
  let particle = false; // "bring" needs one: "bring its changes in", "bring in its changes", "bring it into main"
  if (bring && rest[0] && (rest[0].w === 'in' || rest[0].w === 'over')) { rest = rest.slice(1); particle = true; }
  if (launchPhrase(rest.map(t => t.w))) return null; // "bring in an agent to fix the login" starts one
  let into;
  let ref = null;
  if (!rest.length) {
    if (bring || particle) return null;
    ref = { id: pointedRoot(c), form: 'bare', noun: false }; // "merge", "land"
  } else {
    ref = workRef(rest, c); // the words whole: "merge add tests to parser"
    if (!ref) {
      const t = takeTarget(rest, c);
      if (t.said) {
        into = t.into;
        particle = true;
        let toks = t.toks;
        ref = toks.length ? workRef(toks, c) : null;
        // "merge it in to main", "merge it on to main", "bring it over to main": the particle, then where it goes. Only
        // when the words name nothing with it, so a name that ends in "over" keeps its last word.
        if (!ref && toks.length && ['in', 'on', 'over'].includes(toks[toks.length - 1].w)) {
          toks = toks.slice(0, -1);
          ref = toks.length ? workRef(toks, c) : null;
        }
        if (!ref && !toks.length && !bring) ref = { id: pointedRoot(c), form: 'bare', noun: false }; // "merge into main"
      }
    }
    if (!ref && ['in', 'over'].includes(rest[rest.length - 1].w)) { // "merge it in", "bring its changes in"
      particle = true;
      ref = rest.length > 1 ? workRef(rest.slice(0, -1), c) : null;
    }
  }
  if (!ref) return null;
  // "bring" means a merge only with its work or "it": "bring search cleanup in" is no merge.
  if (bring && (!particle || !(ref.form === 'pronoun' || ref.noun))) return null;
  if (tooLoose(ref, c)) return looseWork(ref, c);
  const intent = workIntent('merge', ref);
  if (into) intent.into = into;
  return { intent, strong: strongRef(ref) };
}

const DISCARD_VERBS = new Set(['discard', 'scrap', 'trash']);

/**
 * "throw away search cleanup's changes", "discard it", "throw it away", "scrap it", "discard all of it", "throw away
 * everything it did", a bare "discard": always asked first (the engine shows a throw-away card). The words must name the
 * agent, as for a merge, or point at its work (POINTED_WORK); "discard unused imports" is no throw-away. Strength is as
 * for a merge: while Remove unused imports asks, "discard the unused imports" is the answer.
 */
function matchDiscard(core, c) {
  const ws = core.map(t => t.w);
  let rest;
  let particle = true;
  if (DISCARD_VERBS.has(ws[0])) rest = core.slice(1);
  else if (ws[0] === 'throw' && (ws[1] === 'away' || ws[1] === 'out')) rest = core.slice(2);
  else if (ws[0] === 'throw') { rest = core.slice(1); particle = false; } // "throw it away"
  else return null;
  if (bareName(ws, c)) return null;
  rest = stripTrailing(rest, WORK_TAIL);
  if (!particle) {
    const last = rest[rest.length - 1];
    if (!last || (last.w !== 'away' && last.w !== 'out') || rest.length < 2) return null;
    rest = rest.slice(0, -1);
  }
  // "scrap that" and "trash this" say never mind ("scratch that"), not which work to throw away. "scrap it" does.
  if ((ws[0] === 'scrap' || ws[0] === 'trash') && rest.length === 1 && (rest[0].w === 'that' || rest[0].w === 'this')) return null;
  if ((ws[0] === 'scrap' || ws[0] === 'trash') && (rest[0]?.w === 'that' || rest[0]?.w === 'this') && (rest[0].tail || NEVER_MIND_JOIN.has(rest[1]?.w))) return null;
  // a bare "discard", "throw away" or "scrap": the agent in the centre, as "discard it"
  if (rest.length && launchPhrase(rest.map(t => t.w))) return null;
  const ref = rest.length ? workRef(rest, c) : { id: pointedRoot(c), form: 'bare', noun: false };
  if (!ref) return null;
  if (tooLoose(ref, c)) return looseWork(ref, c);
  return { intent: workIntent('discard', ref), strong: strongRef(ref) };
}

/** Questions about what an agent changed. They may find the agent by its task words too, as status questions do. */
const CHANGES_ASK = [
  /^what (?:did|has|have) (?<ref>.+?) (?:change|changed)(?: so far)?$/d,
  /^what (?:is |has |have )?(?:been )?changed(?: so far)?(?: (?:in|for|with|from|by|on) (?<ref>.+?))?(?: so far)?$/d,
  /^what changes (?:did|has|have) (?<ref>.+?) (?:make|made)(?: so far)?$/d,
  /^what (?:are|were) (?:the |its |their )?changes(?: (?:in|from|of|by|for) (?<ref>.+))?$/d,
  /^what (?:are|were) (?<ref>.+?) changes$/d,
  /^(?:what|which) files (?:did|has|have) (?<ref>.+?) (?:change|changed|touch|touched|edit|edited)$/d,
  /^(?:what|which) files (?:have |were |got )?changed(?: so far)?$/d,
  /^(?:show me|show us|show|tell me|let me see|let us see) what (?:(?<ref>.+?) )?(?:has |have )?changed(?: so far)?$/d,
];
/** "show me the changes", "show search cleanup's diff": it needs a word for the work, or it is a status ("show search cleanup"). */
const CHANGES_SHOW = /^(?:show me|show us|show|let me see|let us see|can i see|could i see|may i see|see|look at|open|pull up|bring up|give me) (?<ref>.+)$/d;
const CHANGES_DIFF = /^diff(?: (?<ref>.+))?$/d;
/** On a merge or throw-away card only: "review the changes", "check the diff", "go over its work" (elsewhere, work). */
const CHANGES_REVIEW = /^(?:let me |let us )?(?:review|check out|check|read through|read|inspect|examine|view|go over|go through|look over|look through|look at) (?<ref>.+)$/d;
/**
 * When, after review words on a merge or throw-away card: "first", "again", "real quick" ("before I merge it" too).
 * The longer of two that end alike comes first: stripTrailing takes the first that fits.
 */
const REVIEW_TAIL = [...WORK_TAIL, ['first'], ['quickly'], ['real', 'quick'], ['quick'], ['one', 'more', 'time'], ['once', 'more'],
  ['for', 'a', 'second'], ['for', 'a', 'sec'], ['for', 'a', 'moment'], ['so', 'far']];

/**
 * Review words that mean "it" ("show me the changes", "what changed", "diff it") while something else waits on screen.
 * On a merge or throw-away card "it" is the card, so they show the work it is about, and never start anything. A card
 * that does not say whose work it is keeps them (unknown: it stays, with its hint). Anything else on screen (a question,
 * a permission, another kind of card) keeps their old meaning (null).
 */
function cardReview(c) {
  const card = c.pendingConfirm;
  if (!card || (card.kind !== 'merge' && card.kind !== 'discard')) return null;
  const id = typeof card.agentId === 'string' && card.agentId ? card.agentId : null;
  return { intent: id ? { kind: 'changes', agentId: id } : { kind: 'unknown' }, strong: true };
}

/**
 * "what did search cleanup change", "what changed" (the focused agent), "show me the changes", "show search cleanup's
 * changes", "diff it": read-only, so the engine shows them at once (the page opens the git screen on that agent).
 * While a merge or throw-away card waits, the words without a name show the card's work (see cardReview), also when
 * they go on with when ("show me the changes first", "review the diff before I merge it"). Review words about the work
 * that are still not understood keep the card there, rather than becoming work for a new agent.
 */
function matchChanges(core, c) {
  const found = changesIn(core, c);
  if (found || !cardReview(c)) return found;
  const before = core.findIndex((t, i) => i > 1 && t.w === 'before'); // "… before I merge it", "… before merging"
  const short = stripTrailing(before > 0 ? core.slice(0, before) : core, REVIEW_TAIL);
  const again = short.length < core.length ? changesIn(short, c) : null;
  if (again) return again;
  const s = core.map(t => t.w).join(' ');
  const m = CHANGES_SHOW.exec(s) || CHANGES_REVIEW.exec(s);
  const aboutWork = m && refTokens(m, s, core).some(t => WORK_NOUN.has(t.w) || t.w === 'changed');
  return aboutWork ? { intent: { kind: 'unknown' }, strong: true } : null;
}

function changesIn(core, c) {
  const ws = core.map(t => t.w);
  if (bareName(ws, c)) return null; // "diff viewer" is the name of the agent "Diff viewer"
  const s = ws.join(' ');
  // "what changed", a bare "diff": the focused agent, said without its name (on a merge or throw-away card, its agent).
  const focused = () => (screenBusy(c) ? cardReview(c) : { intent: { kind: 'changes', agentId: focusRoot(c) }, strong: false });
  // The work of the agent the words found. Words too loose for now (see tooLoose) are about what waits on screen.
  // A weak form while anything waits on screen is about that: on a merge or throw-away card, the card's work (strong).
  const show = ref => (weakForm(ref) && screenBusy(c) ? cardReview(c)
    : !tooLoose(ref, c) ? { intent: { kind: 'changes', agentId: ref.id }, strong: strongRef(ref) } : null);
  for (const re of CHANGES_ASK) {
    const m = re.exec(s);
    if (!m) continue;
    const refToks = refTokens(m, s, core);
    if (!refToks.length) return focused();
    const ref = workRef(refToks, c);
    if (ref && !ref.partial) return show(ref);
    // A question may find the agent by its task words, or by part of its name, as "what is the rounding bug one doing"
    // does: it only shows.
    const r = resolveRef(refToks, c);
    const a = r.ids.length && r.full ? c.agents.find(x => x.id === r.ids[0]) : null;
    const root = a ? rootOf(a, c) : null;
    return root ? { intent: { kind: 'changes', agentId: root.id }, strong: r.sure } : null;
  }
  let m = CHANGES_SHOW.exec(s);
  if (m) {
    const ref = workRef(refTokens(m, s, core), c);
    if (!ref || !ref.noun) return null; // "show search cleanup" is a status; "show the error on the login page" is work
    return show(ref);
  }
  m = CHANGES_DIFF.exec(s);
  if (m) {
    const refToks = refTokens(m, s, core);
    if (!refToks.length) return focused();
    const ref = workRef(refToks, c);
    if (!ref) return null; // "diff the two config files" is not about an agent
    return show(ref);
  }
  // "review the changes" is work for an agent, but on a merge or throw-away card it looks at the work, as "show" does;
  // so does "review it" or "check it", whose "it" is the card's
  m = cardReview(c) && CHANGES_REVIEW.exec(s);
  if (m) {
    const ref = workRef(refTokens(m, s, core), c);
    if (ref && (ref.noun || ref.form === 'pronoun')) return show(ref);
  }
  return null;
}

// Machines -----------------------------------------------------------------------------------

const MACHINE_FILL = new Set(['sleep', 'suspend', 'hibernate', 'turn', 'switch', 'shut', 'shutdown', 'power', 'stop', 'pause', 'put',
  'send', 'to', 'off', 'down', 'wake', 'up', 'on', 'boot', 'start', 'resume', 'spin', 'fire', 'the', 'machine', 'machines',
  'computer', 'computers', 'box', 'boxes', 'server', 'servers', 'please', 'and', 'both', 'my', 'our', 'your', 'ones', 'one',
  'them', 'that', 'are', 'is', 'of', 'back']);
const LAPTOP_WORDS = new Set(['laptop', 'mac', 'macbook', 'local']);

/** A machine that is really there, by number: "cloud 2". Null when there is no such machine. */
function existingCloud(n, c) {
  const id = cloudMachineId(n, c);
  return id === 'cloud' ? null : id;
}

function machineMentions(ws, c) {
  const ids = [];
  const used = new Set();
  let idle = false;
  let all = false;
  let any = false;
  let lastWasCloud = false;
  const addCloud = n => { const id = existingCloud(n, c); if (id) ids.push(id); };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const m = /^cloud-?(\d+)$/.exec(w);
    if (m) { addCloud(+m[1]); used.add(i); any = true; lastWasCloud = true; continue; }
    if (w === 'cloud' || w === 'clouds') {
      const n = numberish(ws[i + 1], true);
      used.add(i);
      any = true;
      if (n != null) { addCloud(n); used.add(i + 1); i++; lastWasCloud = true; }
      else if (w === 'clouds' || ['machines', 'ones', 'boxes', 'servers', 'computers'].includes(ws[i + 1])) all = true; // "the cloud machines"
      continue;
    }
    if (lastWasCloud && (w === 'and' || w === 'plus') && numberish(ws[i + 1], false) != null) { // "cloud 2 and 3"
      addCloud(numberish(ws[i + 1], false));
      used.add(i); used.add(i + 1); i++;
      continue;
    }
    lastWasCloud = false;
    if (LAPTOP_WORDS.has(w)) { ids.push(laptopId(c)); used.add(i); any = true; continue; }
    if (w === 'idle') { idle = true; used.add(i); any = true; continue; }
    if (STOP_ALL_WORDS.has(w)) { all = true; used.add(i); continue; }
    if (w === 'machine' || w === 'machines') any = true;
    // A machine named something else ("GPU box"): match its whole name.
    for (const mc of c.machines) {
      const name = normName(mc.name).split(' ').filter(Boolean);
      if (name.length && name[0] !== 'cloud' && seqAt(ws, i, name)) {
        ids.push(mc.id);
        name.forEach((_, k) => used.add(i + k));
        any = true;
      }
    }
  }
  if (all && !idle) {
    for (const mc of c.machines) if (mc.kind !== 'laptop') ids.push(mc.id);
  }
  return { ids: [...new Set(ids)], used, idle, any: any || (all && ws.some(w => w === 'machines' || w === 'clouds')) };
}

function matchMachines(core, c) {
  const ws = core.map(t => t.w);
  const s = ws.join(' ');
  let mode = null;
  if (/^(sleep|suspend|hibernate|turn off|switch off|shut down|shutdown|power down|power off|stop|pause)\b/.test(s)
    || /^(put|send)\b.*\bto sleep$/.test(s) || /^(shut|turn|switch|power)\b.* (down|off)$/.test(s)) mode = 'sleep';
  else if (/^(wake|turn on|switch on|power on|power up|boot|start|resume|spin up|fire up)\b/.test(s)
    || /^(turn|switch|power)\b.* on$/.test(s)) mode = 'wake';
  if (!mode) return null;
  const men = machineMentions(ws, c);
  if (!men.any) return null;
  // Sleep and wake act at once, so every word must be about machines. Any other word makes it something else:
  // "start an agent on cloud 2 to ..." is a launch, "turn off the laptop screen saver" and
  // "shut down cloud 2 search index" are work.
  const leftover = ws.filter((w, i) => !men.used.has(i) && !MACHINE_FILL.has(w));
  if (leftover.length) return null;
  if (mode === 'sleep' && men.idle) return { intent: { kind: 'sleep_idle' }, strong: true };
  return { intent: { kind: mode, machineIds: men.ids }, strong: true };
}

// Status and spend ----------------------------------------------------------------------------

const GENERAL_STATUS = new Set(['status', 'status update', 'status report', 'update', 'updates', 'an update', 'any updates',
  'report', 'progress', 'progress report', 'overview', 'summary', 'give me an update', 'give me a status update',
  'give me the status', 'give me a status', 'give me a summary', 'give me an overview', 'what is the status',
  'what is the latest', 'what is new', 'anything new', 'what did i miss', 'catch me up', 'what is going on',
  'what is happening', 'what is up', 'how are things', 'how are things going', 'how is everything', 'how is everything going',
  'how is it all going', 'how are we doing', 'how are we', 'where are we', 'where are we at', 'where are things',
  'what is everyone doing', 'what is everybody doing', 'what are the agents doing', 'what are my agents doing',
  'what are they doing', 'what are they all doing', 'how are the agents doing', 'how are my agents doing', 'show status',
  'show me the status', 'show me everything', 'show me all agents', 'show all agents', 'list agents', 'list the agents',
  'list all agents', 'who is working', 'what is running', 'status please']);

// Questions about one agent. `ask: true` patterns are questions, so an unknown name still asks
// for a general status; the others only count when the name matches an agent. `of: true` patterns ask about a thing
// ("status of …", "what did … change"): a thing with words of its own that is no agent ("the repo", "the last commit") is
// the project's, so the words are a prompt, not a status.
const STATUS_AGENT = [
  { re: /^(?:what|wat) (?:is|was|has|are) (?<ref>.+?) (?:doing|been doing|up to|working on|done|thinking)$/d, ask: true, code: true },
  { re: /^what did (?<ref>.+?) (?:do|change|find|say|finish|get done)$/d, ask: true, of: true },
  { re: /^what is the (?:status|progress|latest) (?:of|on|for|with) (?<ref>.+)$/d, ask: true, of: true },
  { re: /^how (?:is|are) (?<ref>.+?) (?:doing|going|getting on|coming along|progressing)$/d, ask: true },
  // without a tail about progress, "how is …" and "where is …" ask about the code as often: only an agent named counts
  { re: /^how (?:is|are) (?<ref>.+?)(?: looking)?$/d, ask: false },
  { re: /^how far (?:along )?(?:is|are) (?<ref>.+?)(?: along)?$/d, ask: true },
  { re: /^where (?:is|are) (?<ref>.+?) (?:at|up to|with it)$/d, ask: true },
  { re: /^where (?:is|are) (?<ref>.+?)$/d, ask: false },
  { re: /^(?:is|has|did) (?<ref>.+?) (?:done|finished|finish|stuck|still working|still going|complete|completed|making progress|waiting)(?: yet| already| so far| now)?$/d, ask: true },
  { re: /^(?:is|has|did) (?<ref>.+?) (?:working|okay|alright|running|still running|ready|failing|broken)$/d, ask: false },
  { re: /^(?:is|has) (?<ref>.+?) (?:been )?(?:fixed|merged|landed)(?: yet| already| now)?$/d, ask: false },
  { re: /^why (?:did|has|is|was) (?<ref>.+?) (?:fail|failed|failing|stop|stopped|stuck|crash|crashed)$/d, ask: false },
  { re: /^(?:tell me |show me )?(?:what|how) (?<ref>.+?) (?:is|was|has been) (?:doing|up to|working on|getting on|going)$/d, ask: true },
  { re: /^(?:status|update|progress|news) (?:of|on|for|about) (?<ref>.+)$/d, ask: true, of: true },
  { re: /^(?:give me|get me|show me) (?:the|a|an) (?:status|update|progress) (?:of|on|for|about) (?<ref>.+)$/d, ask: true, of: true },
  { re: /^(?<ref>.+?) status$/d, ask: false },
  { re: /^(?:check on|check in on|check up on|look in on|look at|check) (?<ref>.+)$/d, ask: false },
  { re: /^(?:show me|show|open|focus on|focus|go to|switch to|jump to|zoom in on|select|pull up|bring up|take me to) (?<ref>.+)$/d, ask: false },
  { re: /^(?:tell me about|what about|how about) (?<ref>.+)$/d, ask: false },
];

const SPEND_EXACT = [
  /^(?:how much|what) (?:money )?(?:in total )?(?:have|did|has|had) (?:i|we|you|it|this|they|everything|the agents|my agents|all this|all of this)(?: all)?(?: been)? (?:spent|spend|cost|costing|used)(?: (?:so far|today|in total|altogether|total|overall|this session))*$/,
  /^(?:how much|what) (?:is|are) (?:this|it|everything|all this|all of this|the agents|my agents) costing(?: me| us)?(?: (?:so far|today))*$/,
  /^what (?:is|are) (?:my|our|the|today's|total) (?:spend|spending|costs?|total|bill|total spend|total cost|budget)(?: (?:so far|today|total))*$/,
  /^(?:my |total |today's |the )?(?:spend|spending|costs?|cost so far|money spent|budget)(?: (?:so far|today|total))*$/,
  /^how much (?:money )?(?:so far|today)$/,
  /^(?:show|tell) me (?:my|the) (?:spend|spending|costs?)(?: (?:so far|today))*$/,
];
const SPEND_WORD = /\b(spen[dt]|spending|cost|costs|costing|money|bill|budget|dollars|bucks)\b/;

/**
 * What may come after "what needs me" and keep it the command: what the person does for an agent that waits ("what needs
 * me to look at", "… to approve"), and a time, an urgency or a reason ("now", "urgently", "first", "today", "right now",
 * "most", "this morning", "and why"). A tail that names something in the project makes it a prompt ("what needs me to
 * approve this PR?").
 */
const NEEDS_ME_DO = new Set(['look', 'check', 'answer', 'approve', 'review', 'decide', 'sign', 'confirm', 'respond', 'reply', 'read', 'first', 'most', 'currently',
  'urgently', 'urgent', 'asap', 'immediately', 'soon', 'soonest', 'quickly', 'mostly', 'especially', 'presently', 'tonight', 'morning', 'afternoon',
  'evening', 'week', 'day', 'moment', 'anymore', 'before', 'lunch', 'end', 'because', 'reason', 'reasons', 'importantly', 'pressing', 'pressingly']);

function isNeedsMe(ws) {
  if (!ws.length || ws.length > 12) return false;
  const NEED = new Set(['need', 'needs', 'needing', 'needed', 'waiting', 'wait', 'waits', 'blocked', 'blocking', 'want', 'wants', 'require', 'requires']);
  const ME = new Set(['me', 'my', 'attention', 'approval', 'input', 'okay', 'decision', 'answer', 'help', 'review', 'reviewing', 'eyes']);
  const Q = new Set(['what', 'wat', 'who', 'which', 'anything', 'anyone', 'anybody', 'something', 'is', 'are', 'does', 'do', 'show', 'list', 'tell', 'any', 'whatever']);
  const lead = Q.has(ws[0]) || (ws.length <= 4 && NEED.has(ws[0]));
  // "my" counts only for what the person gives ("my attention", "my okay"): "does the signup form need my email?" is work
  if (!lead || !ws.some(w => NEED.has(w)) || !ws.some((w, i) => ME.has(w) && (w !== 'my' || ME.has(ws[i + 1])))) return false;
  // The words are the command, with nothing more after what the person gives ("what needs my attention right now", "what
  // needs me to look at"): "what needs me to approve this PR?" and "does the login page need help text" are prompts.
  let last = -1;
  ws.forEach((w, i) => { if (ME.has(w) && w !== 'my') last = i; });
  return ws.slice(last + 1).every(w => NOTHING_WORDS.has(w) || NEEDS_ME_DO.has(w));
}

/** Words that describe which agent by when it started: the last, the first, the newest. -1 is the newest, 0 the oldest. */
const WHICH_BY_AGE = Object.assign(Object.create(null), { last: -1, latest: -1, newest: -1, recent: -1, previous: -2, first: 0, oldest: 0, earliest: 0, second: 1, third: 2 });
/** Words that describe which agent by how it is, and the states they mean. */
const WHICH_BY_STATE = Object.assign(Object.create(null), {
  stuck: ['maybe_stuck'], finished: [...DONE], done: [...DONE], failed: ['failed', 'checks_failed'], failing: ['failed', 'checks_failed'],
  broken: ['failed', 'checks_failed'], working: ['starting', 'working', 'waiting_helpers'], running: ['starting', 'working', 'waiting_helpers'],
  busy: ['starting', 'working', 'waiting_helpers'], waiting: ['needs_ok', 'question', 'maybe_stuck'], asking: ['needs_ok', 'question'],
  blocked: ['needs_ok', 'question', 'maybe_stuck'], stopped: ['stopped'],
});
const DESCRIBED_NOUN = new Set(['agent', 'agents', 'one', 'ones', 'helper']);
const DESCRIBED_FILL = new Set(['the', 'a', 'an', 'that', 'this', 'my', 'most', 'very', 'just', 'one', 'agent', 'helper']);

/**
 * An agent the words describe without naming it: "the last agent", "the latest one", "the first one", "the stuck one",
 * "the newest agent", "the last stuck one". Null when they are no such words ("the last commit" names no agent: it needs
 * "agent" or "one"); else { id }, the root they find, or { id: null } when they find none or several (then how they all
 * are). By age, the order agents started in (`startedAt`, else the board's order).
 */
function describedAgent(ref, c) {
  const ws = ref.map(t => t.w);
  if (!ws.some(w => DESCRIBED_NOUN.has(w))) return null;
  const desc = ws.filter(w => !DESCRIBED_FILL.has(w) && !DESCRIBED_NOUN.has(w));
  if (!desc.length || !desc.every(w => Object.hasOwn(WHICH_BY_AGE, w) || Object.hasOwn(WHICH_BY_STATE, w))) return null;
  const helper = ws.includes('helper');
  let pool = c.agents.map((a, i) => ({ a, i })).filter(({ a }) => (helper ? !isRoot(a) : isRoot(a)) && !a.earlier);
  for (const w of desc) if (Object.hasOwn(WHICH_BY_STATE, w)) pool = pool.filter(({ a }) => WHICH_BY_STATE[w].includes(a.state));
  pool.sort((x, y) => (Number(x.a.startedAt) || 0) - (Number(y.a.startedAt) || 0) || x.i - y.i);
  const age = desc.find(w => Object.hasOwn(WHICH_BY_AGE, w));
  if (age === undefined) return { id: pool.length === 1 ? pool[0].a.id : null };
  const k = WHICH_BY_AGE[age];
  const pick = k < 0 ? pool[pool.length + k] : pool[k];
  return { id: pick ? pick.a.id : null };
}

/** Map a regex capture group back to tokens (words are joined by single spaces). */
function refTokens(m, s, core) {
  const g = m.indices && m.indices.groups && m.indices.groups.ref;
  if (!g) return [];
  const spaces = str => (str.match(/ /g) || []).length;
  const from = spaces(s.slice(0, g[0]));
  const to = from + spaces(s.slice(g[0], g[1])) + 1;
  return core.slice(from, to);
}

/** Questions about the agents together: "which agents are done?", "are any agents still running", "how many agents are left". */
const GENERAL_STATUS_RE = [
  /^(?:which|what) (?:of )?(?:the |my )?(?:agents|ones) (?:is|are) (?:still )?(?:done|finished|working|running|stuck|waiting|left|busy|idle|ready)$/,
  /^(?:are|is) (?:any|all) (?:of )?(?:the |my )?agents (?:still )?(?:done|finished|working|running|stuck|waiting|busy|ready)$/,
  /^how many (?:of )?(?:the |my )?agents (?:are )?(?:still )?(?:running|working|done|left|waiting|stuck)$/,
  /^(?:is|are) (?:anything|anyone|anybody) (?:still )?(?:running|working|stuck)$/,
  /^how (?:are|is) (?:my |the |all |all my |all the )?(?:agents|things|everyone|everybody)$/,
];

function matchStatusOrSpend(core, c, base = core) {
  const ws = core.map(t => t.w);
  const s = ws.join(' ');
  // One word ("update", "cost") could be the answer to a question, so only longer phrases are strong.
  if (GENERAL_STATUS.has(s)) return { intent: { kind: 'status' }, strong: ws.length > 1 };
  if (GENERAL_STATUS_RE.some(re => re.test(s))) return { intent: { kind: 'status' }, strong: true };
  // "what's waiting for me?": the trailing "for me" was taken off core, so the words as said count too
  if (isNeedsMe(ws) || isNeedsMe(stripPolite(stripSoft(base)).map(t => t.w))) return { intent: { kind: 'status', needsMe: true }, strong: true };
  if (SPEND_EXACT.some(re => re.test(s))) return { intent: { kind: 'spend' }, strong: ws.length > 1 };
  for (const { re, ask, code, of } of STATUS_AGENT) {
    const m = re.exec(s);
    if (!m) continue;
    const ref = refTokens(m, s, core);
    if (SPEND_WORD.test(ref.map(t => t.w).join(' '))) break; // "how much is this costing" is spend, below
    // "what did the last agent do", "status of the stuck one": an agent described, not named. The one the words find, or
    // how they all are when they find none.
    const described = describedAgent(ref, c);
    if (described) return { intent: described.id ? { kind: 'status', agentId: described.id } : { kind: 'status' }, strong: false };
    const r = resolveRef(ref, c);
    if (r.pronoun) return r.ids.length ? { intent: { kind: 'status', agentId: r.ids[0] }, strong: true } : { intent: { kind: 'status' }, strong: true };
    // A form that asks about progress takes a loose match; any other ("where is the config loaded", "open the diff
    // viewer in a split pane", "is the login page broken?") needs the agent named, or two words of three about it
    // ("show me the config files changes"), or it is about the code: work. While a card waits, a look at an agent
    // keeps the old loose match, so it never withdraws the card for a launch ("check the tests first").
    const units = ref.filter(t => !REF_STOP.has(t.w)).length;
    // two words of three about it, with a word for its work ("show me the config files changes")
    const most = units >= 2 && units <= 4 && r.coverage >= 2 / 3 && ref.some(t => WORK_NOUN.has(t.w));
    // said as an agent ("the parser agent", "the login one"), one word of its name is enough, and it is about an agent
    const asAgent = ref.some(t => t.w === 'agent' || t.w === 'one' || t.w === 'helper');
    // "how's the export?", "how is the leak": one word of its name
    const oneName = /^how (?:is|are) /.test(s) && units === 1 && r.full && r.ids.length && hit(agentWords(c.agents.find(a => a.id === r.ids[0])).nameW, stem(ref.find(t => !REF_STOP.has(t.w)).w));
    if (r.ids.length && (ask || r.sure || most || asAgent || oneName || c.pendingConfirm)) {
      return { intent: { kind: 'status', agentId: r.ids[0] }, strong: asAgent || (ask ? r.sure : r.named) };
    }
    // "is claude still running?": agents named by their program
    if (ref.length && ref.every(t => REF_STOP.has(t.w) || Object.hasOwn(HARNESS_ALIAS, t.w) || AGENT_NOUN.has(t.w))) return { intent: { kind: 'status' }, strong: false };
    if (!ask) continue;
    // "what is this function doing?" asks about code; "what is the frobnicator doing" about an agent not found
    if (code && ['this', 'that', 'these', 'those'].includes(ref[0]?.w) && ref.length > 1) return null;
    // "status of the repo", "what did the last commit change": the project's; "update on everything" is the agents'
    if (of && contentCount(ref) > 0) continue;
    return { intent: { kind: 'status' }, strong: false };
  }
  // "how much is this costing" and "how much have I spent" are spend; "how is shipping cost calculated?" is code
  if (/\b(spen[dt]|spending|money|bill|budget|dollars|bucks)\b/.test(s) && /^(how|what|show|tell)\b/.test(s)) return { intent: { kind: 'spend' }, strong: false };
  return null;
}

// Say -----------------------------------------------------------------------------------------

const SAY_VERBS = new Set(['tell', 'ask', 'remind', 'message', 'inform', 'instruct', 'nudge', 'ping', 'warn', 'advise']);
const SAY_SPLIT = new Set(['to', 'that', 'if', 'whether', 'why', 'what', 'how', 'when', 'where', 'which', 'about', 'not']);
const SAY_DROP = new Set(['to', 'that']);
/** The people a program serves: in "tell the user …" they are no agent's name. */
const SERVED = new Set(['user', 'users', 'people', 'person', 'customer', 'customers', 'client', 'clients', 'visitor', 'visitors',
  'admin', 'admins', 'owner', 'owners', 'member', 'members', 'team', 'everyone', 'someone', 'player', 'players', 'buyer', 'buyers']);
const MAX_REF_WORDS = 8;

function matchSay(core, c) {
  const ws = core.map(t => t.w);
  let v = 0;
  let know = -1;
  if (SAY_VERBS.has(ws[0])) v = 1;
  else if (ws[0] === 'let' && (know = ws.indexOf('know')) > 1) v = 1;
  else if (ws[0] === 'say' && ws[1] === 'to') v = 2;
  if (!v) return null;
  const rest = core.slice(v);
  if (rest.length < 2) return null;
  if (launchNoun(rest.map(t => t.w))) return null; // "ask codex to write tests" starts an agent
  if (rest[0].w === 'me' || rest[0].w === 'us') return null; // "tell me what checkout fix is doing" asks Workbench

  const candidates = [];
  if (know > 1) {
    const k = know - v;
    let msg = rest.slice(k + 1);
    if (msg[0] && msg[0].w === 'that') msg = msg.slice(1);
    candidates.push({ ref: rest.slice(0, k), msg, sep: true });
  } else {
    // Agent names are short, so only the first few words can be the name: this keeps long dictation fast.
    const maxRef = Math.min(rest.length, MAX_REF_WORDS + 1);
    for (let k = 1; k < maxRef; k++) {
      if (SAY_SPLIT.has(rest[k].w)) candidates.push({ ref: rest.slice(0, k), msg: rest.slice(SAY_DROP.has(rest[k].w) ? k + 1 : k), sep: true });
      else if (rest[k - 1].tail) candidates.push({ ref: rest.slice(0, k), msg: rest.slice(k), sep: true });
    }
    for (let k = 1; k < maxRef; k++) candidates.push({ ref: rest.slice(0, k), msg: rest.slice(k), sep: false });
  }
  let best = null;
  let pronoun = null;
  for (const cand of candidates) {
    if (!cand.ref.length || !cand.msg.length) continue;
    const r = resolveRef(cand.ref, c);
    if (r.pronoun && !pronoun) pronoun = cand;
    if (!r.ids.length) continue;
    const key = [r.full ? 1 : 0, r.coverage, cand.sep ? 1 : 0, r.total, -cand.ref.length];
    if (!best || compareKeys(key, best.key) > 0) best = { key, r, cand };
  }
  if (best) {
    // A name that only partly matches is not a name: "warn the user when the onboarding flow fails" is work.
    if (!best.r.full) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
    // Neither is one loose word: a word the agent's name does not have ("we should tell people …" beside Let people
    // pick a branch), or one for the people a program serves ("warn the user when …", "tell the user their session …").
    // A one-word name also needs a clear break before the message ("tell flaky to stop"): in "tell me why the tests
    // fail" no word marks where a name would end.
    const refWs = best.cand.ref.map(t => t.w).filter(w => !REF_STOP.has(w));
    const found = c.agents.find(x => x.id === best.r.ids[0]);
    const whole = found && saysWhole(refWs, found); // "tell onboarding the copy is final": the whole name
    if (!best.r.pronoun && refWs.length === 1 && found && !whole && (!best.cand.sep || SERVED.has(refWs[0]) || !hit(agentWords(found).nameW, stem(refWs[0])))) {
      return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
    }
    // One step needs the name and a clear break before the message: "tell search cleanup to ...".
    const sure = best.r.named && (best.cand.sep || !!best.r.pronoun);
    const intent = { kind: 'say', agentId: best.r.ids[0], text: asTyped(best.cand.msg) };
    if (!sure) intent.sure = false;
    return { intent, strong: sure };
  }
  // "tell it to ..." with nothing focused: a say with no agent, so the engine can ask which one.
  // A name that matches no agent is not a say: sending it to whatever is focused would be wrong.
  if (pronoun) {
    const text = asTyped(pronoun.msg);
    return text ? { intent: { kind: 'say', agentId: null, text }, strong: false } : null;
  }
  return null;
}

// Start ---------------------------------------------------------------------------------------

const HARNESS_ALIAS = Object.assign(Object.create(null), { claude: 'claude', claud: 'claude', clawed: 'claude', clod: 'claude', claudes: 'claude',
  'claude-code': 'claude', codex: 'codex', codecs: 'codex', codexes: 'codex', 'codex-cli': 'codex' });
// Words that name an agent for sure, and generic ones that only count after a clear start verb
// ("start a new task to ..."): "add a job to the queue" and "make a copy" are work, not launches.
const AGENT_WORD = new Set(['agent', 'agents', 'someone', 'somebody']);
const GENERIC_NOUN = new Set(['instance', 'instances', 'session', 'sessions', 'worker', 'workers', 'bot', 'bots', 'copy', 'copies',
  'assistant', 'assistants', 'task', 'tasks', 'job', 'jobs', 'one', 'ones']);
const AGENT_NOUN = new Set([...AGENT_WORD, ...GENERIC_NOUN]);
const NOUN_DET = new Set(['a', 'an', 'another', 'some', 'new', 'fresh', 'separate', 'extra', 'more', 'of', 'both', 'each',
  'second', 'different', 'brand', 'the', 'my', 'couple', 'pair']);
const COUNT = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, pair: 2,
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 };
const MAX_LAUNCH = 5;

const START_STRONG = [['spin', 'up'], ['kick', 'off'], ['fire', 'up'], ['boot', 'up'], ['start', 'up'], ['set', 'off'], ['start'], ['launch'], ['spawn'], ['begin']];
// These only start an agent when an agent or harness is named: "have codex write tests".
const START_WEAK = [['i', 'want'], ['i', 'need'], ['i', 'would', 'like'], ['get', 'me'], ['give', 'me'], ['set', 'up'], ['have'],
  ['get'], ['put'], ['use'], ['let'], ['ask'], ['tell'], ['assign'], ['send'], ['run'], ['create'], ['open'], ['make'], ['add'], ['bring', 'in'], ['bring']];

/** A harness named at ws[j]: { harness, len } or null. */
function harnessAt(ws, j) {
  const w = ws[j];
  if (w == null) return null;
  const h = HARNESS_ALIAS[w];
  if (h === 'claude' && ws[j + 1] === 'code') return { harness: 'claude', len: 2 }; // "claude code"
  if (h) return { harness: h, len: 1 };
  if (w === 'code' && ws[j + 1] === 'x') return { harness: 'codex', len: 2 }; // "code x"
  // Speech-to-text hears "Claude" as "cloud"; only trusted right next to "and codex".
  if (w === 'cloud' && ws[j + 1] === 'and' && HARNESS_ALIAS[ws[j + 2]] === 'codex') return { harness: 'claude', len: 1 };
  if (w === 'cloud' && ws[j - 1] === 'and' && HARNESS_ALIAS[ws[j - 2]] === 'codex') return { harness: 'claude', len: 1 };
  if (w === 'cloud' && ws[j + 1] === 'code') return { harness: 'claude', len: 2 };
  return null;
}

/** The agent noun phrase after a start verb: "a new claude agent", "claude and codex", "two agents". */
function parseNoun(ws, i) {
  const harnesses = [];
  let count = null;
  let hasNoun = false;
  let named = false; // a harness or "agent" was said, not only a generic noun
  let cloud = false;
  let definite = false;
  let j = i;
  while (j < ws.length) {
    const w = ws[j];
    const h = harnessAt(ws, j);
    if (h) { harnesses.push(h.harness); hasNoun = true; named = true; j += h.len; continue; }
    if (w === 'one' && (AGENT_NOUN.has(ws[j + 1]) || harnessAt(ws, j + 1))) { count = 1; j++; continue; }
    if (Object.hasOwn(COUNT, w) && (AGENT_NOUN.has(ws[j + 1]) || harnessAt(ws, j + 1) || ws[j + 1] === 'of' || ws[j + 1] === 'new' || ws[j + 1] === 'cloud')) { count = COUNT[w]; j++; continue; }
    if (AGENT_NOUN.has(w)) { hasNoun = true; named = named || AGENT_WORD.has(w); j++; continue; }
    if (w === 'cloud' && numberish(ws[j + 1], false) == null && (AGENT_NOUN.has(ws[j + 1]) || harnessAt(ws, j + 1))) { cloud = true; j++; continue; }
    if (NOUN_DET.has(w) && w !== 'couple' && w !== 'pair') { if (w === 'the' || w === 'my') definite = true; j++; continue; }
    if (['and', 'plus', 'with', 'using', 'via'].includes(w) && harnessAt(ws, j + 1)) { j++; continue; }
    if (w === 'and' && hasNoun && (ws[j + 1] === 'a' || ws[j + 1] === 'an' || ws[j + 1] === 'one') && harnessAt(ws, j + 2)) { j += 2; continue; }
    break;
  }
  if (!hasNoun) return { end: i, harnesses: [], count: null, hasNoun: false, named: false, cloud: false, definite: false };
  return { end: j, harnesses: [...new Set(harnesses)], count, hasNoun, named, cloud, definite };
}

/** True when words start with a launchable noun: a harness, or "a new agent", "someone". */
function launchNoun(ws) {
  const n = parseNoun(ws, 0);
  if (!n.named) return false;
  return n.harnesses.length > 0 || !n.definite;
}

const MACHINE_PREP = new Set(['on', 'in', 'onto', 'using', 'with', 'at', 'via']); // not "to": "migrate the database to the cloud"
const MACHINE_DET = new Set(['its', 'their', 'his', 'her', 'a', 'an', 'the', 'my', 'our', 'your', 'one', 'separate', 'own',
  'different', 'dedicated', 'new', 'individual', 'each', 'single', 'remote', 'this']);
const MACHINE_NOUN = new Set(['machine', 'machines', 'computer', 'computers', 'box', 'boxes', 'server', 'servers', 'instance',
  'instances', 'vm', 'vms', 'host', 'hosts', 'node', 'nodes']);
const AFTER_MACHINE = new Set(['to', 'and', 'for', 'with', 'each', 'both', 'please', 'so', 'then', 'that', 'which', 'who', 'on', 'working']);

/**
 * Take a machine phrase out of the task words: "each on its own cloud machine", "on cloud 2",
 * "in the cloud", "on my laptop", "locally". Returns { machine, toks } (machine null when none).
 */
function takeMachine(toks, c) {
  const ws = toks.map(t => t.w);
  for (let i = 0; i < ws.length; i++) {
    if (!MACHINE_PREP.has(ws[i])) continue;
    let j = i + 1;
    while (j < ws.length && MACHINE_DET.has(ws[j])) j++;
    let machine = null;
    let end = j;
    let sure = false; // a number or a machine noun makes it unambiguous
    const m = /^cloud-?(\d+)$/.exec(ws[j] || '');
    if (m) { machine = cloudMachineId(+m[1], c); end = j + 1; sure = true; }
    else if (ws[j] === 'cloud' || ws[j] === 'clouds') {
      const n = numberish(ws[j + 1], true);
      if (n != null && !(ws[j + 1] === 'to' && !numberIsLikely(ws, j + 2))) { machine = cloudMachineId(n, c); end = j + 2; sure = true; }
      else { machine = 'cloud'; end = j + 1; }
    } else if (LAPTOP_WORDS.has(ws[j]) || ((ws[j] === 'computer' || ws[j] === 'machine') && j > i + 1 && ['my', 'this', 'your', 'the'].includes(ws[j - 1]))) {
      machine = laptopId(c); end = j + 1; sure = true;
    }
    if (!machine) continue;
    if (MACHINE_NOUN.has(ws[end])) { end++; sure = true; }
    if (!sure && end < ws.length && !AFTER_MACHINE.has(ws[end]) && !toks[end - 1].tail) continue; // "the cloud sync bug"
    let from = i;
    if (from > 0 && ['each', 'both', 'all'].includes(ws[from - 1])) from--;
    return { machine, toks: [...toks.slice(0, from), ...toks.slice(end)] };
  }
  const k = ws.indexOf('locally');
  if (k >= 0) return { machine: laptopId(c), toks: [...toks.slice(0, k), ...toks.slice(k + 1)] };
  for (let i = 0; i + 1 < ws.length; i++) {
    if (ws[i] === 'cloud' && MACHINE_NOUN.has(ws[i + 1])) return { machine: 'cloud', toks: [...toks.slice(0, i), ...toks.slice(i + 2)] };
  }
  return { machine: null, toks };
}

/** "cloud to fix the bug": the "to" is a connector, not "two". */
function numberIsLikely(ws, next) {
  return next >= ws.length || AFTER_MACHINE.has(ws[next]) || MACHINE_NOUN.has(ws[next]);
}

/** Take "using codex", "with claude", "in codex", or a harness as the very last word. */
function takeHarness(toks) {
  const ws = toks.map(t => t.w);
  for (let i = 0; i < ws.length; i++) {
    if (!['using', 'use', 'with', 'via', 'in', 'on', 'through', 'by'].includes(ws[i])) continue;
    const h = harnessAt(ws, i + 1);
    if (!h) continue;
    let end = i + 1 + h.len;
    if (AGENT_NOUN.has(ws[end]) || ws[end] === 'cli') end++;
    return { harness: h.harness, toks: [...toks.slice(0, i), ...toks.slice(end)] };
  }
  // An afterthought after a comma: "fix the login, codex". Without the comma it may be part of
  // the task ("review codex").
  const last = ws.length - 1;
  if (last > 0 && HARNESS_ALIAS[ws[last]] && toks[last - 1].tail) return { harness: HARNESS_ALIAS[ws[last]], toks: toks.slice(0, last) };
  return { harness: null, toks };
}

/** Drop the words that join the noun phrase to the task: "to", "on", "that fixes", "and have it". */
function stripConnectors(toks) {
  const ws = toks.map(t => t.w);
  let k = 0;
  let conj = false;
  if (ws[0] === 'and' && ['have', 'get', 'ask', 'tell', 'let', 'make'].includes(ws[1]) && ['it', 'them', 'him', 'her'].includes(ws[2])) {
    k = ws[3] === 'to' ? 4 : 3;
  } else if (['to', 'on', 'for', 'about', 'with', 'at', 'into', 'and'].includes(ws[0])) {
    k = 1;
    if (['the', 'a', 'this'].includes(ws[1]) && ['task', 'job'].includes(ws[2])) k = ['of', 'to'].includes(ws[3]) ? 4 : 3;
  } else if (['that', 'which', 'who'].includes(ws[0])) {
    k = 1;
    if (['will', 'can', 'should', 'could', 'would', 'must'].includes(ws[1])) k = 2;
    else conj = true;
  } else if (ws[0] === 'working' && ws[1] === 'on') k = 2;
  const rest = toks.slice(k);
  if (conj && rest.length) rest[0] = { ...rest[0], raw: baseVerb(rest[0].raw) };
  return rest;
}

/** Only pronouns and fillers: "start an agent on it" has no task. */
function emptyTask(toks) {
  return !toks.some(t => !['it', 'this', 'that', 'them', 'one', 'please', 'now', 'the', 'a', 'an'].includes(t.w));
}

/**
 * Build the start tasks from the words after the noun phrase. A harness is the agent the words named, or null when
 * they named none: the engine then gives the work to the person's default agent.
 * @returns {{ task: string, harness: string|null, machine: string }[] | null}
 */
function buildTasks(rest, noun, c) {
  const mach = takeMachine(rest, c);
  let toks = mach.toks;
  const har = takeHarness(toks);
  toks = har.toks;
  toks = stripConnectors(toks);
  const machine = mach.machine || (noun.cloud ? 'cloud' : laptopId(c));
  const ws = toks.map(t => t.w);

  // Different work for each: "start claude on the parser and codex on the docs".
  for (let k = 1; k < ws.length - 2; k++) {
    if (ws[k] !== 'and') continue;
    const h = harnessAt(ws, k + 1);
    if (!h || !['on', 'to', 'for', 'with'].includes(ws[k + 1 + h.len])) continue;
    const first = asTyped(toks.slice(0, k));
    const second = asTyped(toks.slice(k + 2 + h.len));
    if (!first || !second) break;
    const h1 = noun.harnesses[0] || har.harness || null;
    return [{ task: first, harness: h1, machine }, { task: second, harness: h.harness, machine }];
  }

  if (!toks.length || emptyTask(toks)) return null;
  const task = asTyped(toks);
  if (!task) return null;
  let harnesses = noun.harnesses.length ? noun.harnesses : [har.harness || null];
  if (harnesses.length === 1 && noun.count > 1) harnesses = new Array(Math.min(noun.count, MAX_LAUNCH)).fill(harnesses[0]);
  return harnesses.slice(0, MAX_LAUNCH).map(harness => ({ task, harness, machine }));
}

/**
 * A start that says no work: the engine asks what the agent should work on. `harness` is the one agent the words named
 * ("start codex", "a new codex agent", "start an agent with codex"), or null, so the engine can ask about that agent,
 * or say why it cannot start.
 */
const NO_TASK_START = (harness = null) => ({ kind: 'start', tasks: [], task: null, harness });

/** The one agent a start with no work names, before or after its noun ("start an agent with codex"), or null. */
function noTaskHarness(noun, rest, c) {
  const named = noun.harnesses.length ? noun.harnesses : [takeHarness(takeMachine(rest, c).toks).harness].filter(Boolean);
  return named.length === 1 ? named[0] : null;
}
/** Words that make a bare noun phrase a request for one more agent: "new agent", "another codex agent". */
const NEW_WORDS = new Set(['new', 'another', 'fresh', 'extra', 'more', 'second', 'separate', 'different']);

function matchStart(core, c) {
  const ws = core.map(t => t.w);
  let v = startsWithSeq(ws, START_STRONG);
  let strongVerb = v > 0;
  if (!v) v = startsWithSeq(ws, START_WEAK);
  let noun = parseNoun(ws, v);
  if (!v) {
    // No verb, but a launchable noun and a clear join: "codex, write tests", "new agent to fix the login".
    if (!noun.named || !launchNoun(ws) || noun.definite) return null;
    // A new agent and nothing more: "new agent", "another codex agent". Work comes next, so ask for it.
    if (noun.end === ws.length) return ws.some(w => NEW_WORDS.has(w)) ? { intent: NO_TASK_START(noTaskHarness(noun, [], c)), strong: true } : null;
    const joined = core[noun.end - 1] && core[noun.end - 1].tail;
    if (!joined && !['to', 'on', 'for', 'that'].includes(ws[noun.end])) return null;
  } else if (!strongVerb && !noun.named) {
    return null;
  } else if (!strongVerb && !noun.harnesses.length && noun.end < ws.length && !LAUNCH_JOIN.has(ws[noun.end]) && ws[noun.end] !== 'working') {
    return null; // a word for agents used as a noun's modifier: "add an agents page to the dashboard"
  }
  if (noun.hasNoun && noun.definite && !noun.harnesses.length) return null; // "start the agent" refers to one that exists
  let rest = core.slice(noun.end);
  if (!v && core[noun.end - 1]?.tail && !ws.some(w => NEW_WORDS.has(w))) {
    // "claude, please add tests": the politeness after the name goes too; "claude, stop" says no work (see parse:
    // the words after the name are tried as a command). "new agent for this" and "codex on it" still ask for work.
    rest = stripPolite(stripSoft(rest));
    if (!rest.some(t => !NOTHING_WORDS.has(t.w))) return null;
  }
  const tasks = buildTasks(rest, noun, c);
  // A start verb with no work after it ("start an agent", "start codex", "start", "add an agent on cloud 2"): the
  // engine asks what the agent should work on. Only a start verb with a named agent wins over a waiting question:
  // "use codex", "ask claude" or a bare "start" may well be the answer.
  if (!tasks) return { intent: NO_TASK_START(noTaskHarness(noun, core.slice(noun.end), c)), strong: strongVerb && noun.named };
  // "use codex instead", "ask claude too": which agent, and no work; the engine asks what it should work on
  if (tasks.every(t => /^(?:(?:instead|rather|too|also|then|now|please|again)\b ?)+$/i.test(t.task))) {
    return { intent: NO_TASK_START(noTaskHarness(noun, core.slice(noun.end), c)), strong: strongVerb && noun.named };
  }
  return { intent: { kind: 'start', tasks }, strong: noun.named };
}

// Connecting agents and keys -----------------------------------------------------------------------
//
// "help", "hi" and "what can you do" are no command of Workbench's: like any words that are none, they are a prompt for
// a new agent (see parse). Agents & keys takes its own words.

// The things a person connects: an agent program, GitHub or git, and keys.
const C_DET = '(?:(?:my|your|our|the|a|an|some|new|more|another|other) )*';
const C_AGENT = '(?:(?:claude|claud|clawed|clod)(?: code)?|cloud code|claudes|codex(?: cli)?|codecs|codexes|code x|(?:coding )?agents?)(?: account| subscription)?';
const C_GITHUB = '(?:github|git hub|git)(?: account)?';
// Keys: "keys", "an API key", "secret keys"; tokens, credentials and secrets only with whose they are ("a github token",
// "aws credentials"), since "add a token" alone is work in a parser.
const C_KEYS = '(?:(?:aws|amazon|anthropic|openai|gemini|google(?: cloud)?|gcp|azure|github|stripe|cloud)(?: (?:api|access|secret))? (?:keys?|tokens?|credentials?|secrets?)|(?:(?:api|access|secret) )?keys?)';
/** Words that open Agents & keys and say what for: strong, they win over a waiting question. */
const CONNECT_STRONG = [
  /^(?:(?:open|show|show me|go to|take me to|bring up|pull up) )?(?:the )?agents and (?:api )?keys(?: (?:panel|page|screen|settings))?$/,
  new RegExp(`^connect (?:to |with |up )?${C_DET}(?:${C_AGENT}|${C_GITHUB}|${C_KEYS})$`),
  new RegExp(`^(?:set up|setup) ${C_DET}(?:${C_AGENT}|${C_GITHUB}|${C_KEYS}|workbench)$`),
  new RegExp(`^(?:(?:sign|log) (?:in|on)|signin|login)(?: (?:to|into|with|on))? ${C_DET}(?:${C_AGENT}|${C_GITHUB}|chatgpt|openai|anthropic)(?: account)?$`),
  new RegExp(`^(?:sign|log) into ${C_DET}(?:${C_AGENT}|${C_GITHUB}|chatgpt|openai|anthropic)(?: account)?$`),
  new RegExp(`^add ${C_DET}${C_KEYS}$`),
];
/** The same, said bare: weak, so while a question waits they are the answer ("agents" may well be one). */
const CONNECT_WEAK = /^(?:connect|set up|setup|(?:sign|log) (?:in|on)|signin|login|agents|keys|api keys?)$/;
/** "how do I connect github", "where do I add a key": the question is the request. */
const CONNECT_FRAME = /^(?:how|where) (?:do|can|should) (?:i|we) /;

/**
 * "connect", "set up", "add a key", "sign in", "connect github", "agents", "agents and keys", "api key": open Agents &
 * keys. Only these words whole: "connect the form to the api", "set up codex to fix the login" and "add a key to the
 * config" keep their old meaning.
 */
function matchConnect(core) {
  const s = core.map(t => t.w).join(' ').replace(/&/g, ' and ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(CONNECT_FRAME, '');
  if (CONNECT_STRONG.some(re => re.test(s))) return { intent: { kind: 'connect' }, strong: true };
  if (CONNECT_WEAK.test(s)) return { intent: { kind: 'connect' }, strong: false };
  return null;
}

// Full permissions ----------------------------------------------------------------------------

/**
 * The words that turn full permissions on, said whole: the engine asks first, with a card. Said whole, they are never a
 * prompt: anything typed that is no command starts an agent at once, so the ways a person asks for the mode are here.
 */
const PERMISSIONS_ON = [
  /^(?:(?:turn|switch) on )?full (?:permissions?|access)(?: on)?$/,
  /^(?:turn|switch) full (?:permissions?|access) on$/,
  /^(?:enable|use|switch to|go to|give (?:agents|the agents|every agent|all agents|them)) full (?:permissions?|access)$/,
  /^allow everything$/,
  /^stop asking(?: me)?$/,
  /^(?:don't|do not) ask me$/,
];
/** The words that turn them off, said whole: agents ask again, at once. */
const PERMISSIONS_OFF = [
  /^ask (?:me )?(?:first|again)$/,
  /^(?:turn|switch) off full (?:permissions?|access)$/,
  /^(?:turn|switch) full (?:permissions?|access) off$/,
  /^full (?:permissions?|access) off$/,
  /^disable full (?:permissions?|access)$/,
  /^(?:switch|go) (?:back )?to ask(?:ing)? (?:me )?first$/,
];

/** 'full', 'ask', or null: what these words, whole, ask of full permissions. */
function permissionsMode(core) {
  const s = core.map(t => t.w).join(' ');
  if (PERMISSIONS_ON.some(re => re.test(s))) return 'full';
  if (PERMISSIONS_OFF.some(re => re.test(s))) return 'ask';
  return null;
}

/**
 * The polite words that may stand before the mode's words: they ask Workbench to do it, and leave who acts as it is. "I
 * need to", "we should", "you should", "let's", "help me" and the other openers of POLITE are not here: "we should ask
 * first" is a thought, not the mode.
 */
const MODE_POLITE = [['please'], ['kindly'], ['just'], ['can', 'you'], ['could', 'you'], ['would', 'you'], ['will', 'you']];

/** Whether the words end with a question mark: then they ask, and act on nothing. */
const endsAsking = toks => toks.length > 0 && /[?？]["'”’)]*$/.test(toks[toks.length - 1].raw);

/**
 * Whether the words are exactly an agent's name, as the person would say it: the name read as their words are (case and
 * punctuation aside), word for word, a plural ending aside ("full permission" for an agent called Full permissions).
 */
function namesAgent(toks, c) {
  const ws = toks.map(t => t.w);
  return c.agents.some(a => {
    const name = lex(String(a.name ?? '')).filter(t => !DISFLUENCY.has(t.w)).map(t => t.w);
    return name.length === ws.length && name.every((w, i) => w === ws[i] || stem(w) === stem(ws[i]));
  });
}

/**
 * 'full', 'ask' or null: what the person's words, whole, ask of full permissions. Soft openers ("okay", "um"), the polite
 * words of MODE_POLITE ("please", "can you") and trailing ones ("please", "thanks", "now") may go with them. An opener that
 * changes who acts ("I need to ask first", "we should stop asking", "help me stop asking") makes them something else, and
 * so does a question mark at the end ("ask first?"). Words that are exactly the name of an agent on the board ("Ask first",
 * "Full permissions") are that agent's.
 */
function modeWords(toks, c) {
  if (!toks.length || endsAsking(toks) || namesAgent(toks, c)) return null;
  return permissionsMode(stripTrailing(stripPolite(stripSoft(toks), MODE_POLITE)));
}

/**
 * "full permissions", "stop asking", "allow everything", "don't ask me", "full access" (on); "ask first", "ask me first",
 * "ask again", "turn off full permissions", "full permissions off" (off). Only these words whole (modeWords, read from what
 * the person said, `base`), so "give the deploy role full permissions on the bucket", "add full access for admins", "stop
 * asking for a password on login" and "make the app ask first before deleting" are work. Weak: while a question waits,
 * they are its answer.
 */
function matchPermissions(base, c) {
  const mode = modeWords(base, c);
  return mode ? { intent: { kind: 'permissions', mode }, strong: false } : null;
}

// Work requests without a start verb ----------------------------------------------------------

const WORK_VERBS = new Set(['add', 'fix', 'write', 'rewrite', 'create', 'build', 'implement', 'refactor', 'update', 'upgrade',
  'remove', 'delete', 'rename', 'move', 'clean', 'tidy', 'improve', 'optimize', 'optimise', 'speed', 'make', 'change',
  'convert', 'migrate', 'port', 'document', 'investigate', 'debug', 'find', 'research', 'figure', 'explain', 'set', 'setup',
  'configure', 'install', 'bump', 'replace', 'split', 'merge', 'translate', 'generate', 'draft', 'design', 'profile', 'audit',
  'lint', 'format', 'polish', 'simplify', 'extract', 'handle', 'support', 'test', 'review', 'look', 'check', 'see', 'try',
  'sort', 'prepare', 'organize', 'organise', 'increase', 'reduce', 'lower', 'raise', 'enable', 'disable', 'turn', 'revert',
  'undo', 'restore', 'patch', 'resolve', 'address', 'finish', 'complete', 'summarize', 'summarise', 'list', 'compare',
  'benchmark', 'measure', 'cache', 'wire', 'hook', 'connect', 'integrate', 'run', 'use', 'deploy', 'publish', 'release',
  'ship', 'commit', 'push', 'open', 'close', 'archive', 'scan', 'verify', 'validate', 'trace', 'diagnose', 'reproduce',
  'rerun', 'retry', 'harden', 'secure', 'localize', 'style', 'restyle', 'redesign', 'rework', 'reorganize', 'decouple',
  'inline', 'expose', 'hide', 'show', 'display', 'render', 'log', 'track', 'record', 'map', 'parse', 'read', 'tighten',
  'loosen', 'drop', 'pin', 'unpin', 'stub', 'mock', 'cover', 'type', 'annotate', 'comment', 'describe', 'plan', 'outline',
  'study', 'analyze', 'analyse', 'evaluate', 'assess', 'explore', 'search', 'locate', 'identify', 'prevent', 'avoid', 'get',
  'bring', 'teach', 'shorten', 'lengthen', 'split', 'combine', 'dedupe', 'deduplicate', 'untangle', 'fill', 'draw', 'build']);

/**
 * A work request with no start verb: "fix the login redirect", "work on the login bug". The task is the person's words as
 * typed (the caller gives them: `{ kind: 'task' }` carries no text here), unless they name a program or a machine ("fix
 * the login redirect using codex", "… on cloud 2"): then a start for it, with those words taken off.
 */
function matchTask(core, c) {
  let words = core;
  if (core.length > 2 && core[0].w === 'work' && core[1].w === 'on') words = core.slice(2);
  else if (core.length < 2 || !WORK_VERBS.has(core[0].w)) return null;
  if (emptyTask(words === core ? core.slice(1) : words)) return null; // "fix it", "do that", "work on it"
  // "merge everything", "merge its work", "bring it all in": Workbench's own verb for an agent's work, pointing at an agent;
  // where that is no command now (a request waits), it is no work either
  const after = stripTrailing(core.slice(1), WORK_TAIL).map(t => t.w).filter(w => w !== 'in').join(' ');
  if (['merge', 'land', 'bring'].includes(core[0].w) && (PRONOUN_REFS.has(after) || POINTED_WORK.test(after) || GENERIC_WORK.test(after))) return null;
  const last = core[core.length - 1].raw;
  if (/\?["'”’]*$/.test(last)) return null; // a question, not a request
  // An explicit harness or machine makes it a launch: "fix the login redirect using codex".
  const mach = takeMachine(words, c);
  const har = takeHarness(mach.toks);
  // "use codex instead": which agent, but no work; the engine asks what Codex should work on
  if (har.harness && !mach.machine && har.toks.slice(1).every(t => NOTHING_WORDS.has(t.w) || t.w === 'instead' || t.w === 'rather')) {
    return { kind: 'start', tasks: [], task: null, harness: har.harness };
  }
  if (mach.machine || har.harness) {
    const task = asTyped(har.toks);
    if (task && !emptyTask(har.toks)) {
      return { kind: 'start', tasks: [{ task, harness: har.harness || null, machine: mach.machine || laptopId(c) }] };
    }
  }
  return { kind: 'task' };
}

// Work said to an agent by name, and free text --------------------------------------------------

/** Words after an agent's name that say how it is, not what to do: "claude is stuck", "codex isn't installed". */
const COPULA = new Set(['is', 'was', 'are', 'were', 'has', 'had', 'seems', 'looks', 'keeps', 'got', 'gets', 'did', "isn't",
  "wasn't", "doesn't", "didn't", "won't", "can't", 'broke', 'crashed', 'crashes', 'failed', 'fails', 'stopped', 'hangs', 'hung',
  'froze', 'freezes', 'never', 'always', 'still', 'just']);
/** After "is" or "are", these words make a question, not a remark: "codex is there a memory leak in the worker". */
const ASK_AFTER_IS = new Set(['there', 'it', 'this', 'that', 'the', 'a', 'an', 'any', 'my', 'our', 'your']);

/** The words after an agent's name (and a second one: "claude and codex …") say work for it, or null. */
function workAfterName(rest, named, c) {
  if (!rest.length || emptyTask(rest)) return false;
  const first = rest[0].w;
  if (!named.tail && COPULA.has(first) && !((first === 'is' || first === 'are') && ASK_AFTER_IS.has(rest[1]?.w))) return false;
  if (WORK_VERBS.has(first)) return rest.length >= 2 && !emptyTask(rest.slice(1));
  return saysSomething(rest, c);
}

/**
 * Work said to an agent by its name first, as people say it: "claude fix the readme", "codex why is the build slow",
 * "claude and codex add dark mode" (with a comma or a colon after the name, matchStart reads it first). After the name
 * comes a work verb, or words that say something; "claude is stuck" and "codex isn't installed" say how an agent is.
 * Weak: while a question waits, words that open with an agent's name ("claude keep the old route") are its answer.
 */
function matchAddressed(core, c) {
  const ws = core.map(t => t.w);
  const h = harnessAt(ws, 0);
  if (!h || ws.length <= h.len) return null;
  const harnesses = [h.harness];
  let end = h.len;
  if (ws[end] === 'and') {
    const h2 = harnessAt(ws, end + 1);
    if (!h2) return null;
    harnesses.push(h2.harness);
    end += 1 + h2.len;
  }
  const named = core[end - 1];
  const rest = stripTrailing(stripPolite(stripSoft(core.slice(end))));
  if (!workAfterName(rest, named, c)) return null;
  const task = asTyped(rest);
  if (!task) return null;
  // weak only when the words may be said to the agent asking: no comma or colon after the name (as for
  // "claude, fix the login page", read by matchStart), and a program the asker runs, when its program is known
  const asker = c.asker;
  const notTheAsker = !!(asker && (asker.harness === 'claude' || asker.harness === 'codex') && !harnesses.includes(asker.harness));
  return { intent: { kind: 'start', tasks: [...new Set(harnesses)].map(harness => ({ task, harness, machine: laptopId(c) })) }, strong: !!named.tail || notTheAsker };
}

/**
 * Words that say nothing about work by themselves: function words and pronouns, acknowledgements and reactions (in a
 * few languages besides English), the words for agents and the agents' own names, the words for going on, waiting and
 * starting, and asides ("let me think", "what's next", "testing one two three"). Text needs other words to be work
 * (see saysSomething).
 */
const NOTHING_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'there', 'here', 'i', 'me', 'my',
  'mine', 'we', 'us', 'our', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'one', 'ones', 'some', 'any', 'all',
  'each', 'every', 'both', 'anyone', 'anybody', 'everyone', 'everybody', 'what', 'which', 'who', 'whom', 'whose', 'when',
  'where', 'why', 'how', 'whatever', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'from', 'into', 'onto',
  'through', 'up', 'out', 'off', 'over', 'as', 'and', 'or', 'but', 'so', 'if', 'then', 'than', 'too', 'also', 'just',
  'only', 'very', 'really', 'much', 'more', 'not', 'no', 'yes', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do',
  'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
  'must', "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't",
  "hadn't", "shouldn't", "wouldn't", "couldn't", "let's", "i'll", 'okay', 'yeah', 'yep', 'yup', 'ya', 'yea', 'nope', 'nah',
  'sure', 'fine', 'good', 'great', 'nice', 'cool', 'awesome', 'perfect', 'excellent', 'amazing', 'brilliant', 'neat', 'sweet',
  'lovely', 'love', 'thanks', 'thank', 'ty', 'cheers', 'please', 'sorry', 'lol', 'haha', 'wow', 'whoa', 'yay', 'oops', 'ugh',
  'argh', 'hell', 'heck', 'damn', 'crap', 'right', 'correct', 'exactly', 'indeed', 'true', 'agreed', 'agree', 'sounds',
  'looks', 'seems', 'lgtm', 'got', 'see', 'understood', 'understand', 'noted', 'makes', 'sense', 'mean', 'means', 'mind',
  'never', 'worries', 'bye', 'goodbye', 'later', 'again', 'now', 'today', 'still', 'already', 'yet', 'well', 'hi', 'hello',
  'hey', 'next', 'long', 'longer', 'let', 'think', 'thinking', 'give', 'minute', 'minutes', 'sec', 'second', 'seconds',
  'moment', 'hang', 'happen', 'happens', 'happened', 'happening', 'changing', 'taking', 'forever', 'testing', 'two', 'three',
  'four', 'five', 'agent', 'agents', 'helper', 'helpers', 'task', 'tasks', 'job', 'jobs', 'thing', 'things', 'stuff',
  'something', 'anything', 'everything', 'nothing', 'workbench', ...Object.keys(HARNESS_ALIAS), 'start', 'go', 'going',
  'ahead', 'keep', 'keeps', 'continue', 'resume', 'proceed', 'wait', 'hold', 'cancel', 'stop', 'launch', 'begin', 'work',
  'working', 'new', 'old', 'another', 'other', 'different', 'same', 'myself', 'yourself',
  // thanks, yes, no and okay in a few other languages
  'gracias', 'muchas', 'danke', 'schön', 'merci', 'beaucoup', 'grazie', 'mille', 'obrigado', 'obrigada', 'спасибо', 'большое',
  'धन्यवाद', 'shukriya', 'sí', 'si', 'oui', 'ja', 'да', 'нет', 'nein', 'non', 'vale', 'genau', 'd\'accord', 'хорошо', 'ок',
  '好', '好的', '谢谢', '谢谢你', '是', '是的', '不', '不是', '对', '嗯', '行', '可以', '没问题', '收到', 'はい', 'いいえ',
  'ありがとう', 'ありがとうございます', '了解', 'わかりました', 'うん', '네', '아니요', '감사합니다', '고마워',
]);
const QUESTION_LEAD = new Set(['what', 'why', 'how', 'where', 'when', 'which', 'who', 'is', 'are', 'does', 'do', 'did', 'can',
  'could', 'should', 'would', 'will', 'was', 'were', 'has', 'have']);
/** Words in scripts written without spaces: one such word can be a whole request ("修复登录错误"). */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Reactions that start a reply rather than a request: "thanks, …", "great job on …". */
const PRAISE = new Set(['thanks', 'thank', 'cool', 'great', 'nice', 'perfect', 'awesome', 'lgtm', 'sweet', 'excellent', 'wow',
  'amazing', 'brilliant', 'love', 'cheers', 'good']);
/** Reactions a command may come after: "looks good, merge it", "wait, stop everything", "nah, throw it away". */
const REACTION = new Set([...PRAISE, 'yes', 'yeah', 'yep', 'yup', 'sure', 'looks', 'sounds', 'good', 'wait', 'ugh', 'oops', 'no',
  'nope', 'nah', 'whoa', 'approved', 'approve', 'fine', 'crap', 'damn', 'alright', 'okay', 'oh', 'hey']);
const REACTION_SEQ = [['hold', 'on'], ['hang', 'on'], ['one', 'sec'], ['one', 'second'], ['oh', 'no'], ['no', 'wait'], ['thank', 'you'],
  ['good', 'job'], ['great', 'job'], ['nice', 'job'], ['good', 'work'], ['great', 'work'], ['nice', 'work'], ['well', 'done'],
  ['thanks', 'a', 'lot'], ['good', 'morning'], ['good', 'afternoon'], ['good', 'evening'], ['not', 'good'], ['not', 'great'],
  ['love', 'it'], ['looks', 'good'], ['looks', 'great'], ['sounds', 'good'], ['hey', 'there'], ['hi', 'there'], ['hello', 'there']];

/** Past the reactions at the start ("looks good, merge it" is "merge it"); at least one word is kept. */
function stripReactions(toks) {
  let k = 0;
  for (let moved = true; moved && k < toks.length - 1;) {
    moved = false;
    const n = startsWithSeq(toks.slice(k).map(t => t.w), REACTION_SEQ);
    if (n && k + n < toks.length) { k += n; moved = true; continue; }
    if (REACTION.has(toks[k].w)) { k++; moved = true; }
  }
  return toks.slice(k);
}
/** Subjects that point at what is on screen: "that fixed it", "it's still broken", "this is annoying". */
const POINTING = new Set(['it', 'that', 'this', 'everything']);
/** "this" and "that" point when a verb, not a noun, follows them ("why did that fail?", not "what does this repo do?"). */
const POINTED_VERB = new Set(['is', 'was', 'did', 'does', 'do', 'has', 'had', 'fail', 'failed', 'work', 'worked', 'works', 'break',
  'broke', 'crash', 'crashed', 'mean', 'happen', 'happened', 'change', 'changed', 'fixed', 'go', 'went', 'looks', 'seems']);
const isQuestion = toks => QUESTION_LEAD.has(toks[0]?.w) || /[?？]["'”’)]*$/.test(toks[toks.length - 1]?.raw || '');
/** Whether the words point at something on screen: "it", or "this" or "that" before a verb, or at the end. */
function pointsAtScreen(toks) {
  return toks.some((t, i) => t.w === 'it' || t.w === 'its'
    || ((t.w === 'this' || t.w === 'that') && ((i === toks.length - 1 && !(WH_LEAD.has(toks[0].w) && contentCount(toks) > 0))
      || POINTED_VERB.has(toks[i + 1]?.w))));
}
// "how do I deploy this", "what language is this?": a question that asks something of its own, about the project
const WH_LEAD = new Set(['how', 'what', 'where', 'which', 'who', 'when', 'why']);

/** The words that say something, as a count: a word in a script written without spaces, four characters or more, counts twice. */
function contentCount(toks) {
  const content = new Set(toks.map(t => t.w).filter(w => !NOTHING_WORDS.has(w)));
  let n = content.size;
  for (const w of content) if (SPACELESS.test(w) && [...w].length >= 4) n++;
  return n;
}

/**
 * Whether words after an agent's name, with no comma or colon after it, say work for it (workAfterName): two words that
 * are not NOTHING_WORDS (a long word in a script written without spaces counts twice); or one, in three words or more
 * ("codex the server won't start"), unless the words speak to Workbench ("are you working"), or point at what is on
 * screen ("it's still broken"; "it would be nice to have tabs" is a want).
 * @param {object[]} toks the words that count
 * @param {object} [o] `all`: the whole sentence, for its length and pronouns
 */
function saysSomething(toks, c, { all = toks } = {}) {
  const n = contentCount(toks);
  if (n >= 2) return true;
  if (n !== 1 || all.length < 3) return false;
  const aw = all.map(t => t.w);
  if (aw.includes('you') || aw.includes('your')) return false;
  const want = POINTING.has(aw[0]) && ['would', 'should', 'could', 'might'].includes(aw[1]);
  return want || !pointsAtScreen(all);
}

// Free text ------------------------------------------------------------------------------------------

/** The agent in the centre waits on the person through its helpers, more than one of them, so a yes cannot say which. */
function helpersWait(c) {
  if (!c.focus || hasAsk(c.focus)) return false;
  return c.agents.filter(a => a.id !== c.focus.id && (a.parentId === c.focus.id || a.rootId === c.focus.id) && hasAsk(a)).length > 1;
}

/** The words of an agent's task that say something: retyping them is the same work again. */
function sameWork(core, a) {
  const task = lex(String(a.task || '')).map(t => t.w).filter(w => !NOTHING_WORDS.has(w));
  if (!task.length) return false;
  const said = new Set(core.map(t => t.w));
  return task.every(w => said.has(w));
}

/**
 * An agent named in free text, as work for it: first ("codex why is the build slow"), last after a comma ("the login
 * page is broken, codex": `last`), or with "using", "via" or "through" ("… using codex"), or at the very end after "with",
 * "in" or "on" ("… in codex"). Not in the middle of what the words say: "error in claude code extension" is a bug report.
 * @returns {{ harness: string|null, toks: object[], first?: true, last?: true }}
 */
function harnessInFree(toks) {
  const ws = toks.map(t => t.w);
  const h = harnessAt(ws, 0);
  if (h) return { harness: h.harness, toks: toks.slice(h.len), first: true };
  for (let i = 0; i < ws.length; i++) {
    const via = ['using', 'via', 'through'].includes(ws[i]);
    const at = ['with', 'in', 'on'].includes(ws[i]);
    if (!via && !at) continue;
    const g = harnessAt(ws, i + 1);
    if (!g) continue;
    let end = i + 1 + g.len;
    if (AGENT_NOUN.has(ws[end]) || ws[end] === 'cli') end++;
    if (at && end < ws.length) continue;
    return { harness: g.harness, toks: [...toks.slice(0, i), ...toks.slice(end)] };
  }
  const last = ws.length - 1;
  if (last > 0 && HARNESS_ALIAS[ws[last]] && toks[last - 1].tail) return { harness: HARNESS_ALIAS[ws[last]], toks: toks.slice(0, last), last: true };
  return { harness: null, toks };
}

/**
 * Free text, the last step, after the commands and the answers to what is on screen. Null means the prompt: the caller
 * gives the person's words, exactly as typed, to a new agent (on the default program). Otherwise:
 * - a short remark or question that points at what is on screen, with an agent in the centre ("is it done yet", "it's
 *   still broken", "why did that fail?"): its status; so is an agent's whole name and nothing more ("diff viewer"), and
 *   an agent at work's own words ("the checkout bug"), unless they ask for it ("can we have …"). Retyping an ended
 *   agent's task is that work again, not its status;
 * - an agent named alone ("codex", "claude code", "the agent", "start the agent"): a start with no work, so the engine
 *   asks what it should work on;
 * - a program named first, with a comma or a colon after it ("codex, thanks") or before work or a question ("codex why
 *   is the build slow"), last after a comma ("the login page is broken, codex"), or with "using", "via" or "through"
 *   (harnessInFree): a start for that program, its name taken off and the rest as typed (asTyped). Named first before
 *   words that say how it is ("claude is stuck", "codex isn't installed"), the whole sentence is the prompt.
 */
function matchFreeWork(core, c, base) {
  if (!core.length) return null;
  const ws = core.map(t => t.w);
  const soft = stripSoft(base);
  if (c.focusId && soft.length <= 7 && contentCount(core) <= 2 && pointsAtScreen(soft) && (isQuestion(soft) || POINTING.has(soft[0].w))
    && !(POINTING.has(soft[0].w) && ['would', 'should', 'could', 'might'].includes(soft[1]?.w))) {
    return { kind: 'status', agentId: c.focusId };
  }
  const asked = stripPolite(stripSoft(base)).length < stripSoft(base).length;
  if (core.length <= MAX_REF_WORDS) {
    const r = resolveRef(core, c);
    if (r.full && r.sure && !r.pronoun && r.ids.length === 1) {
      const a = c.agents.find(x => x.id === r.ids[0]);
      if (a && (ENDED.has(a.state) || a.earlier ? r.named && !sameWork(core, a) : r.named || !asked)) return { kind: 'status', agentId: a.id };
    }
  }
  const noun = parseNoun(ws, startsWithSeq(ws, START_STRONG));
  if (noun.named && noun.end === ws.length) return NO_TASK_START(noun.harnesses.length === 1 ? noun.harnesses[0] : null);
  const har = harnessInFree(core);
  if (!har.harness) return null;
  const name = har.first ? core[harnessAt(ws, 0).len - 1] : null;
  const words = har.first ? stripPolite(stripSoft(har.toks)) : har.toks;
  // "claude is stuck", "claude broke the build": said about a program, not to it
  if (name && !name.tail && !workAfterName(words, name, c)) return null;
  const task = har.last ? asTyped(words).replace(/[\s,;:]+$/, '') : asTyped(words);
  return task ? { kind: 'start', tasks: [{ task, harness: har.harness, machine: laptopId(c) }] } : null;
}

// Answers -------------------------------------------------------------------------------------

const KEEP_TRYING = new Set(['keep trying', 'keep going', 'let it keep trying', 'let it keep going', 'let it try', 'let it continue',
  'carry on', 'continue', 'leave it', 'leave it be', 'let it be', 'it is fine', 'fine', 'let it run', 'give it more time',
  'let it go on', 'try again', 'keep at it', 'let it keep at it']);

/**
 * The words as an answer to the question or stuck ask on screen: as typed, from the first word past a soft opener or the
 * agent's name to the end, its edges kept (asTyped: a pasted snippet's braces, a last full stop). A reply that names one
 * of the offered choices takes that choice's exact words.
 */
function answerIntent(base, focus, ask) {
  const toks = stripSoft(base);
  let text = asTyped(toks).replace(/,+$/, '').trim();
  const said = toks.map(t => t.w).join(' ');
  const options = Array.isArray(ask.options) ? ask.options.filter(o => typeof o === 'string') : [];
  // A reply that names one of the offered choices uses that choice's exact words, also past a reaction ("yeah stop it"
  // is "Stop it"). Words of no script the choices share ("否" against "是") match nothing.
  const pick = (words) => { const n = normName(words); return n ? options.find(o => normName(o) === n) : undefined; };
  const exact = pick(said) || pick(stripReactions(toks).map(t => t.w).join(' '));
  if (exact) text = exact;
  else if (KEEP_TRYING.has(said)) {
    const keep = options.find(o => /keep trying/i.test(o));
    if (keep) text = keep;
  }
  return { kind: 'answer', agentId: focus.id, askId: ask.id ?? null, text };
}

// ---------------------------------------------------------------------------------------------
// Entry points

/**
 * Parse what the person typed or said.
 * @param {string} text
 * @param {{ agents?: object[], focusId?: string|null, machines?: object[], harnesses?: object, pendingConfirm?: any,
 *   repo?: { branch?: string|null } }} [ctx] `repo.branch`: the person's current branch, so "merge it into <that branch>"
 *   can name it; without it only "main", "master" and "my branch" are understood as where to merge.
 * @returns {object} an intent; never throws
 */
export function parseCommand(text, ctx) {
  const said = (typeof text === 'string' ? text : text == null ? '' : String(text)).trim();
  try {
    return parse(said, context(ctx));
  } catch {
    return { kind: 'unknown', text: said };
  }
}

/**
 * What the words are, in order. 1. Answers to what is on screen: a card's yes or no, the words for full permissions, a
 * permission's reply. 2. A command after a never-mind. 3. Workbench's own commands (stop, status and what needs me, merge,
 * throw away, forget, tell, continue, changes, machines, connect). 4. The answer to a question. 5. Anything else is the
 * prompt for a new agent, exactly as typed (`said`): there is no dead end, and no word back in place of work. `unknown`
 * is left for three things only: nothing said; a yes that is not enough for the card on screen, or one asked rather than
 * said (the card stays, and the engine says how to answer it); and words that answer nothing while a permission waits
 * (the engine says so). With `free` false (the words after a never-mind), what would be the prompt is `unknown`.
 */
function parse(said, c, { free = true } = {}) {
  const base = lex(said).filter(t => !DISFLUENCY.has(t.w));
  const holder = c.asker; // the focused agent, or its one helper that is waiting on the person
  const ask = holder ? holder.ask : null;
  const card = liveCard(c);
  const waiting = !!ask && (ask.type === 'question' || ask.type === 'stuck');
  // A card on screen takes the words first: what it does not take never reaches a permission behind it.
  const permission = !!ask && ask.type === 'permission' && !card;
  const prompt = free ? { kind: 'task', task: said } : { kind: 'unknown', text: said };
  // Nothing but filler, symbols or emoji ("👍", "hmm", "}"): typed, it is said all the same.
  if (!base.length) {
    if (!said) return { kind: 'unknown', text: said };
    if (card) return prompt;
    if (waiting) return { kind: 'answer', agentId: holder.id, askId: ask.id ?? null, text: said };
    if (permission) return { kind: 'unknown', text: said };
    return prompt;
  }
  // Replies to a card or a permission may open with the agent's name: "claude, yes", "claude, allow it".
  const replyBase = addressedRest(base) || base;

  // 1. A confirm on screen is waiting for "yes" or "cancel" (only the one the page shows: see the engine).
  // "is that right?" asks about the card rather than answering it: it settles nothing, and the card stays. So does a
  // yes that is not enough for that card (a bare "yes" to throwing work away): it never falls through to a prompt.
  if (c.pendingConfirm) {
    const go = confirmReply(replyBase, c.pendingConfirm.kind, c);
    if (go === 'asks' || go === 'keep') return { kind: 'unknown', text: said };
    if (go !== null) return { kind: 'confirm', go };
  }
  // Full permissions, said whole, come before a permission's own reply: "allow everything" and "don't ask me" would
  // otherwise be a no that carries those words. "yes" is no such word, so a yes still allows. While a question waits,
  // they are its answer (below). Only the whole utterance counts: after an agent's name ("claude, stop asking",
  // "Onboarding, ask first") the words are work or a message for that agent, as before.
  if (!waiting) {
    const mode = matchPermissions(base, c);
    if (mode) return mode.intent;
  }
  const reply = (r) => {
    const intent = { kind: r.kind, agentId: holder.id, askId: ask.id ?? null };
    if (r.text) intent.text = r.text;
    if (r.conditional) intent.conditional = true;
    return intent;
  };
  // The focused agent is waiting for permission.
  if (permission) {
    const r = permissionReply(replyBase);
    // "is it okay?" gets what exactly is asked for, and the request keeps waiting (as below).
    if (r && r.kind === 'asks') return { kind: 'status', agentId: holder.id };
    if (r) return reply(r);
  }
  // Two helpers of the agent in the centre wait: a yes or a no is for one of them, and the engine says which wait.
  if (!card && !ask && helpersWait(c)) {
    const r = permissionReply(replyBase);
    if (r && (r.kind === 'allow' || r.kind === 'deny')) return { kind: r.kind, agentId: c.focusId, askId: null };
  }
  // 2. "never mind, fix the checkout bug", "forget it, just stop the flaky test": a command after the never-mind is what is
  // asked. Anything else after it, or a never-mind alone, is said as it is: the prompt, never-mind and all ("never
  // mind, the login page is broken"), or a card's no, or a question's answer.
  if (!waiting && !permission) {
    const nm = neverMind(base);
    if (nm && nm !== 'alone') {
      const r = parse(said.slice(nm.start), c, { free: false });
      if (r.kind !== 'unknown' && r.kind !== 'task' && !(r.kind === 'start' && r.tasks?.length)) return r;
      return prompt;
    }
  }
  // 3. Commands. While a question waits, only unmistakable commands win over an answer.
  const core = stripTrailing(stripPolite(stripSoft(base)));
  // Past a reaction ("looks good, merge it", "nah, throw it away", "hold on, stop everything"): with nothing waiting, any
  // command; while a question or stuck ask waits, only a stop of everything (a "yes, stop it" may answer "Should I stop
  // the dev server?"; a stuck agent's "yeah stop it" picks its "Stop it" as the answer).
  const reacted = stripTrailing(stripPolite(stripSoft(stripReactions(stripSoft(base)))));
  const brk = reacted.length < core.length && base.some(t => t.tail && t.end <= reacted[0].start);
  let found = null;
  // An agent's name with a comma or colon, then a command: the command ("claude, stop the flaky test", "codex: what
  // needs me?", "claude stop"). Work after a name is a start for that agent (matchStart, matchAddressed).
  const voc = vocativeRest(core, c) || agentAddressed(core, c);
  if (voc) found = voc;
  if (!found) found = matchCommand(core, c, base);
  if (!found && reacted.length < core.length) {
    const r = matchCommand(reacted, c, base);
    if (r && r.intent.kind !== 'unknown' && (!waiting || r.intent.kind === 'stop_all')) found = r;
    // a sure stop past a reaction: of another agent, it is no answer to this one ("ugh, stop onboarding");
    // of the stuck agent itself, it is its own "Stop it" ("yes stop", "wait wait wait stop")
    else if (r && waiting && r.strong && r.intent.kind === 'stop' && r.intent.agentIds?.length) {
      if (!r.intent.agentIds.some(id => id === holder.id || id === c.focusId)) found = r;
      else if (ask.type === 'stuck' && r.intent.agentIds.length === 1 && r.intent.agentIds[0] === holder.id) {
        const opt = (Array.isArray(ask.options) ? ask.options : []).find(o => typeof o === 'string' && /^stop\b/i.test(o));
        return { kind: 'answer', agentId: holder.id, askId: ask.id ?? null, text: opt || 'Stop it' };
      }
    }
  }
  // "we need to pause onboarding", "I want to kill the flaky test": a want said about an agent is asked first
  if (found && (found.intent.kind === 'stop' || found.intent.kind === 'say') && found.intent.agentIds?.length !== 0 && saysWant(base)) {
    // still asked first, but a want about another agent than the one asking is no answer to it
    const ids = found.intent.agentIds || [found.intent.agentId];
    const other = !!holder && !ids.some(id => id === holder.id || id === c.focusId);
    found = { intent: { ...found.intent, sure: false }, strong: found.strong && other };
  }
  // Words about the card on screen that it cannot act on ("show me the changes" on a card that does not say whose work
  // it is): the card stays, with its hint.
  if (found && found.intent.kind === 'unknown') return { kind: 'unknown', text: said };
  // Work that a command's verb led ("stop the flaky test from timing out", "warn the user when …") is the prompt, as typed.
  if (found && found.intent.kind === 'task') found = { ...found, intent: prompt };
  if (found && (found.strong || !waiting)) return found.intent;
  // 4. The answer to the question or stuck ask on screen: the whole reply, as typed.
  if (waiting) return answerIntent(addressedRest(base) || base, holder, ask);
  // A work request with no start verb ("fix the login redirect"): the prompt, or a start for the program or machine it
  // names. Past a reaction only after a break, and with nothing on screen to answer: "yes, add tests too" on a card is
  // no new work. With a permission waiting it is work all the same, as it was.
  const calm = !card && !permission;
  const work = matchTask(core, c) || (brk && calm ? matchTask(reacted, c) : null);
  if (work) return work.kind === 'task' ? prompt : work;
  // Words for the permission that are no command and no work. A question about it ("do I need to approve this?") gets
  // what exactly it asks for, and the request keeps waiting; words that start like a yes or a no but say more are a no
  // that carries them. Anything else answers nothing: the engine says the permission waits ("… is waiting for your OK").
  if (permission) {
    if (asksSomething(replyBase)) return { kind: 'status', agentId: holder.id };
    const r = looseReply(replyBase);
    return r ? reply(r) : { kind: 'unknown', text: said };
  }
  // 5. Free text: words about an agent are its status, and a program named makes them work for it; anything else is the
  // prompt, exactly as typed. With a card on screen the card stays where it is (the engine keeps it). After a reaction
  // and a break, the rest is read by itself for a status ("thanks! is it done?").
  if (free) {
    const r = matchFreeWork(brk ? reacted : core, c, base);
    if (r) return r;
  }
  return prompt;
}

const NEVER_MIND = [['never', 'mind'], ['forget', 'about', 'it'], ['forget', 'about', 'that'], ['forget', 'it'], ['forget', 'that'],
  ['scrap', 'that'], ['scratch', 'that'], ['cancel', 'that'], ['ignore', 'that'], ['ignore', 'my', 'last', 'message'],
  ['ignore', 'what', 'i', 'said'], ['disregard', 'that'], ['disregard', 'my', 'last', 'message']];
const NEVER_MIND_JOIN = new Set(['and', 'just', 'instead', 'then', 'but', 'rather', 'so']);

/**
 * A never-mind at the start: 'alone' when it asks nothing more ("never mind", "never mind the login bug", "ignore my last
 * message"), else the first word of what follows a break or a join ("never mind, fix the checkout bug", "forget it
 * just fix the checkout bug", "never mind the warnings, just fix the errors"), or null. After "cancel that", "forget
 * that" and "scrap that" with no break, "that" belongs to what follows ("cancel that deploy job"): no never-mind.
 */
function neverMind(base) {
  const soft = stripSoft(base);
  const n = startsWithSeq(soft.map(t => t.w), NEVER_MIND);
  if (!n) return null;
  // "forget it", "scrap that" and "cancel that" alone keep their meaning as commands (a forget card for an earlier agent,
  // never mind on a card); only "never mind", "ignore …" and "disregard …" are a never-mind by themselves
  const alone = ['never', 'ignore', 'disregard'].includes(soft[0].w) ? 'alone' : null;
  if (n === soft.length) return alone;
  const that = soft[n - 1].w === 'that';
  let k = n;
  if (!soft[k - 1].tail) {
    if (that && !NEVER_MIND_JOIN.has(soft[k]?.w)) return k === soft.length ? 'alone' : null;
    // "never mind the warnings, just fix the errors": past the words it waves away, to the next break or join
    while (k < soft.length && !soft[k - 1].tail && !NEVER_MIND_JOIN.has(soft[k].w)) k++;
  }
  let rest = soft.slice(k);
  while (rest.length && NEVER_MIND_JOIN.has(rest[0].w)) rest = rest.slice(1);
  return rest.length >= 2 ? rest[0] : alone;
}

/**
 * An agent addressed by its own whole name, then a colon or comma, as in a chat: "Flaky test: stop" is a stop of it,
 * "Onboarding: use the new copy on step 2" a message to it, asked first. Its name must be one agent's, said whole.
 */
function agentAddressed(core, c) {
  const k = core.findIndex(t => t.tail);
  if (k < 0 || k > MAX_REF_WORDS || k === core.length - 1) return null;
  const name = core.slice(0, k + 1).map(t => t.w);
  const whole = c.agents.filter(a => saysWhole(name, a) && nameWords(name, a) === agentWords(a).nameKey.split(' ').length);
  if (whole.length !== 1) return null;
  const a = whole[0];
  const rest = stripSoft(core.slice(k + 1));
  if (!rest.length) return null;
  // "the login page is broken, codex", "…, use codex": a program named after the work picks who does it
  const rw = rest.map(t => t.w).filter(w => !['use', 'using', 'with', 'via', 'please'].includes(w));
  const prog = harnessAt(rw, 0);
  if (prog && prog.len === rw.length) return null;
  const r = matchCommand(rest, { ...c, focusId: a.id, focus: a, asker: null }, rest);
  // full permissions are Workbench's, never an agent's: "Onboarding, ask first" is a message to it
  if (r && !['start', 'task', 'unknown', 'permissions'].includes(r.intent.kind)) return r;
  const text = asTyped(rest);
  return text ? { intent: { kind: 'say', agentId: a.id, text, sure: false }, strong: false } : null;
}

/** "we need to …", "I want to …": a want, not an order (see parse). */
const WANT = /^(?:(?:i|we) (?:want|need|would like|should|have) to|we should|you should|i think we should|let's) /;
function saysWant(base) {
  return WANT.test(stripSoft(base).map(t => t.w).join(' ') + ' ');
}

/** The words after an agent's name and its comma or colon ("claude, yes"), else null. */
function addressedRest(base) {
  const h = harnessAt(base.map(t => t.w), 0);
  if (!h || base.length <= h.len || !base[h.len - 1].tail) return null;
  return base.slice(h.len);
}

/**
 * An agent's name, then a command: the command. After "claude," or "codex:" any command but work (which is a launch
 * for that agent: matchStart); with no comma, a stop ("claude stop", "claude stop it"). A stop meant for the agent in
 * the centre stops it only when it is that agent ("codex, stop" with a Claude agent in the centre names none).
 */
function vocativeRest(core, c) {
  const ws = core.map(t => t.w);
  const h = harnessAt(ws, 0);
  if (!h || core.length <= h.len) return null;
  const rest = stripSoft(core.slice(h.len));
  if (!rest.length) return null;
  const r = matchCommand(rest, c, rest);
  // "claude, stop asking" is work for Claude, as before: full permissions take their words only whole
  if (!r || ['start', 'task', 'unknown', 'permissions'].includes(r.intent.kind)) return null;
  if (!core[h.len - 1].tail && r.intent.kind !== 'stop' && r.intent.kind !== 'stop_all') return null;
  if (r.intent.kind === 'stop' && r.intent.agentIds?.length === 1 && r.intent.agentIds[0] === c.focusId) {
    const f = c.focus;
    if (f && typeof f.harness === 'string' && f.harness !== h.harness) return { intent: { kind: 'stop', agentIds: [] }, strong: false };
  }
  return r;
}

function matchCommand(core, c, base = core) {
  if (!core.length) return null;
  const ws = core.map(t => t.w);
  if (matchStopAll(ws)) return { intent: { kind: 'stop_all' }, strong: true };
  // Agents & keys takes only its own words whole, so it comes first: "open agents and keys" would be a start on
  // "keys", and "connect github" work. Changes, merge and throw-away come before status: "what did search cleanup
  // change" and "show search cleanup's changes" were status questions, and still are when they name no agent.
  return matchConnect(core)
    || matchPermissions(base, c)
    || matchMachines(core, c)
    || matchStop(core, c)
    || matchForget(core, c)
    || matchContinue(core, c)
    || matchChanges(core, c)
    || matchMerge(core, c)
    || matchDiscard(core, c)
    || matchStatusOrSpend(core, c, base)
    || matchSay(core, c)
    || matchStart(core, c)
    || matchAddressed(core, c);
}

// ---------------------------------------------------------------------------------------------
// Sentences for confirm cards

const HARNESS_NAME = { claude: 'Claude', codex: 'Codex', sim: 'simulated' };
const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const quote = t => '“' + clip(String(t ?? ''), 80) + '”';

function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

function agentName(id, c) {
  const a = c.agents.find(x => x.id === id);
  return a && a.name ? a.name : 'that agent';
}

function machineName(id, c) {
  if (id === 'cloud') return 'a cloud machine';
  const m = c.machines.find(x => x.id === id);
  return m && m.name ? m.name : String(id);
}

/**
 * "Claude and Codex", "two Claude agents", "Claude". No harness (none was named; the engine picks the person's default
 * agent): "an agent", "two agents".
 */
function whoStarts(harnesses) {
  const counts = new Map();
  for (const raw of harnesses) {
    const h = raw || null;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return joinAnd([...counts].map(([h, n]) => {
    if (h == null) return n === 1 ? 'an agent' : `${NUM_WORD[n] || n} agents`;
    const name = HARNESS_NAME[h] || String(h);
    if (h === 'sim') return n === 1 ? 'a simulated agent' : `${NUM_WORD[n] || n} simulated agents`;
    return n === 1 ? name : `${NUM_WORD[n] || n} ${name} agents`;
  }));
}

function placePhrase(machine, n, c) {
  if (!machine || machine === laptopId(c) || machine === 'laptop') return '';
  if (machine === 'cloud') return n === 1 ? ' on a cloud machine' : ', each on a cloud machine';
  const name = machineName(machine, c);
  if (n === 1) return ` on ${name}`;
  return n === 2 ? `, both on ${name}` : `, all on ${name}`;
}

function describeStart(tasks, c) {
  const ts = (Array.isArray(tasks) ? tasks : []).filter(t => t && typeof t.task === 'string' && t.task);
  if (!ts.length) return 'Start an agent?';
  const machines = ts.map(t => t.machine || laptopId(c));
  const sameMachine = machines.every(m => m === machines[0]);
  const where = sameMachine ? placePhrase(machines[0], ts.length, c) : '';
  if (ts.every(t => t.task === ts[0].task)) {
    // "Start Claude on “why does the build fail?”": a question already ends the sentence
    const end = !where && /\?$/.test(clip(ts[0].task, 80)) ? '' : '?';
    return `Start ${whoStarts(ts.map(t => t.harness))} on ${quote(ts[0].task)}${where}${end}`;
  }
  const parts = ts.map((t, k) => `${whoStarts([t.harness])} on ${quote(t.task)}${sameMachine ? '' : placePhrase(machines[k], 1, c)}`);
  return `Start ${joinAnd(parts)}${where}?`;
}

/**
 * A plain sentence describing an intent, for a confirm card: "Stop Flaky test?", "Tell Onboarding “use the new copy”?".
 * The engine asks first only for a stop or a message whose words did not name the agent; work starts at once, so the
 * sentence for a start ("Start Claude on “fix the flaky checkout test”?") is for other callers.
 */
export function describeIntent(intent, ctx) {
  const c = context(ctx);
  const it = intent && typeof intent === 'object' ? intent : { kind: 'unknown', text: '' };
  const names = ids => joinAnd((Array.isArray(ids) ? ids : []).map(id => agentName(id, c)));
  const machines = ids => (Array.isArray(ids) && ids.length ? joinAnd(ids.map(id => machineName(id, c))) : 'that machine');
  switch (it.kind) {
    case 'start': return describeStart(it.tasks, c);
    case 'task': return describeStart([{ task: it.task, harness: typeof it.harness === 'string' ? it.harness : null, machine: null }], c);
    case 'stop': return Array.isArray(it.agentIds) && it.agentIds.length ? `Stop ${names(it.agentIds)}?` : 'Stop an agent? It is not clear which one.';
    case 'stop_all': return 'Stop every agent?';
    case 'forget': return Array.isArray(it.agentIds) && it.agentIds.length ? `Forget ${names(it.agentIds)}?` : 'Forget an agent? It is not clear which one.';
    case 'continue': return `Continue ${agentName(it.agentId, c)} where it left off?`;
    case 'changes': return it.agentId ? `Show what ${agentName(it.agentId, c)} changed?` : 'Show what an agent changed? It is not clear which one.';
    case 'merge': {
      const into = typeof it.into === 'string' && it.into.trim() ? clip(it.into.trim(), 60) : 'your branch';
      return it.agentId ? `Merge ${agentName(it.agentId, c)} into ${into}?` : 'Merge an agent? It is not clear which one.';
    }
    case 'discard': return it.agentId ? `Throw away ${agentName(it.agentId, c)}’s work?` : 'Throw away an agent’s work? It is not clear which one.';
    case 'say': return it.agentId ? `Tell ${agentName(it.agentId, c)} ${quote(it.text)}?` : `Send ${quote(it.text)}? It is not clear to which agent.`;
    case 'answer': return `Answer ${agentName(it.agentId, c)} with ${quote(it.text)}?`;
    case 'allow': return `Allow the request from ${agentName(it.agentId, c)}?`;
    case 'deny': return `Deny the request from ${agentName(it.agentId, c)}?`;
    case 'status':
      if (it.agentId) return `Show what ${agentName(it.agentId, c)} is doing?`;
      return it.needsMe ? 'Show what needs you?' : 'Show how every agent is doing?';
    case 'spend': return 'Show what you have spent today?';
    case 'sleep': return `Put ${machines(it.machineIds)} to sleep?`;
    case 'wake': return `Wake ${machines(it.machineIds)}?`;
    case 'sleep_idle': return 'Put the idle machines to sleep?';
    case 'confirm': return it.go ? 'Go ahead?' : 'Cancel?';
    case 'help': return 'Show what you can say?';
    case 'connect': return 'Open Agents & keys?';
    default: return `Not sure what ${quote(it.text)} means.`;
  }
}
