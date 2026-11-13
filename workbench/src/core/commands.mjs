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
//   changes { agentId }     merge { agentId, into? }                     discard { agentId }
//   confirm { go }          help                    connect              unknown { text }
// Extra fields some intents carry: askId (allow, deny, answer), text (deny: the person's words, such as
// "no, use the staging database"), conditional (deny: a yes that came with conditions, "yes but only in the
// tests folder"; text is the whole reply), sure: false (stop, say: the words found the agent but did not name
// it, so the engine asks first), needsMe (status: "what needs me"), into (merge: the branch the person named,
// "main" or "master" or their current branch by name; left out for "my branch"). An allow never carries words.
// changes, merge and discard always name a root agent (a helper stands for its agent); agentId is null when the
// words did not make clear which one. Merge and discard are always asked first (the engine shows a card).
// A launch's harness is the agent the words named ("codex", "claude"), or null: the engine then gives the work to
// the person's default agent. A start that says no work ("start an agent", "new agent", "start codex") is { kind:
// 'start', tasks: [], task: null, harness }, with harness the one agent the words named (else null), and the engine
// asks what that agent should work on.
import { clip } from '../shared/format.mjs';
import { ENDED, LOOK } from '../shared/states.mjs';

// ---------------------------------------------------------------------------------------------
// Words

const CONTRACTIONS = {
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
};

/** Disfluencies, dropped wherever they appear. */
const DISFLUENCY = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'uhm', 'er', 'erm', 'err', 'hmm', 'hm', 'hmmm', 'mm', 'mmm', 'ah', 'ahh', 'eh']);
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
const TRAILING = [['please'], ['thanks'], ['thank', 'you'], ['for', 'me'], ['right', 'now'], ['now'], ['asap'], ['if', 'you', 'can'], ['okay']];

/** Words that never identify an agent. */
const REF_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'its', 'it', 'one', 'ones',
  'agent', 'agents', 'helper', 'helpers', 'task', 'tasks', 'job', 'jobs', 'thing', 'things', 'guy', 'bot', 'worker',
  'please', 'now', 'just', 'on', 'in', 'of', 'for', 'to', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'doing',
  'about', 'up', 'all', 'any', 'some', 'which', 'who', 'called', 'named', 'working', 'running', 'session', 'instance',
  'from', 'at', 'by', 'there', 'here', 'me', 'i', 'you', 'we', 'do', 'does', 'did', 'has', 'have', 'had']);

/** Phrases that point at the focused agent. */
const PRONOUN_REFS = new Set(['it', 'this', 'that', 'this one', 'that one', 'the current one', 'current one', 'the current agent',
  'this agent', 'that agent', 'the agent', 'the focused one', 'the selected one', 'the one i am looking at', 'him', 'her']);

const NUMBER = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// Speech-to-text often writes these for numbers right after "cloud": "cloud to" is Cloud 2.
const NUMBER_SOUNDALIKE = { won: 1, to: 2, too: 2, tree: 3, free: 3, for: 4, fore: 4, ate: 8 };

function normWord(raw) {
  return raw.toLowerCase().replace(/[‘’ʼ`´]/g, "'").replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
}

/**
 * Split text into tokens. `w` is the normalized word used for matching; `raw`, `start` and `end`
 * point back into the original text, so task and message text keep the person's own wording.
 */
function lex(text) {
  const toks = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const tail = /[,;:.!?]["'”’)]*$/.test(raw); // the token ends a phrase
    if (raw === '&' || raw === '+') { toks.push({ w: 'and', raw, start, end, tail }); continue; }
    const w = normWord(raw);
    if (!w) continue;
    const parts = CONTRACTIONS[w] || [w.endsWith("'s") ? w.slice(0, -2) : w];
    for (const p of parts) toks.push({ w: p, raw, start, end, tail });
  }
  return toks;
}

/** The person's own words for a run of tokens. */
function spanText(toks) {
  const seen = new Set();
  const parts = [];
  for (const t of toks) {
    if (seen.has(t.start)) continue;
    seen.add(t.start);
    parts.push(t.raw);
  }
  return parts.join(' ');
}

/** Trim quotes and closing punctuation from task or message text. */
function tidy(s) {
  return String(s).replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').replace(/[\s,;:.!]+$/, '').replace(/["'“”‘’]+$/, '').trim();
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

function stripPolite(toks) {
  let cur = toks;
  for (let changed = true; changed;) {
    changed = false;
    const ws = cur.map(t => t.w);
    for (const seq of POLITE) {
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
  if (irregular[lower]) return irregular[lower];
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
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// Agent references: fuzzy word overlap with name and task

const wordCache = new WeakMap();

function wordSet(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    if (!REF_STOP.has(words[i])) set.add(stem(words[i]));
    if (i + 1 < words.length) set.add(stem(words[i] + words[i + 1])); // "check out" also reads as "checkout"
  }
  return set;
}

function agentWords(a) {
  const cached = wordCache.get(a);
  if (cached && cached.name === a.name && cached.task === a.task && cached.state === a.state) return cached;
  const label = (LOOK[a.state] && LOOK[a.state].label) || '';
  const v = { name: a.name, task: a.task, state: a.state, nameW: wordSet(a.name), taskW: wordSet(a.task), stateW: wordSet(label), nameKey: refKey(String(a.name || '').toLowerCase().split(/[^a-z0-9]+/)) };
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
    if (i + 1 < ws.length) {
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
    if (i + 1 < ws.length && !REF_STOP.has(ws[i]) && A.nameW.has(stem(ws[i] + ws[i + 1]))) { n += 2; i++; continue; }
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
  for (const a of c.agents) {
    const sc = scoreAgent(ws, a);
    if (!sc.units || !sc.matched) continue;
    const coverage = sc.matched / sc.units;
    if (coverage < 0.5) continue;
    const key = [coverage, sc.total, a.kind === 'helper' ? 0 : 1, ENDED.has(a.state) ? 0 : 1, a.id === c.focusId ? 1 : 0];
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
const CARD_YES = { stop: ['stop'], say: ['send'], merge: ['merge', 'land', 'bring'], discard: ['discard', 'throw'] };
/** Words that may come with a card's own yes: "bring it in", "throw it away", "merge its changes". */
const CARD_YES_FILL = { merge: ['in', 'its', 'work', 'changes', 'branch'], discard: ['away', 'out', 'its', 'work', 'changes', 'branch'] };
/** A card's own no: the throw-away card's "Keep it" button, said. */
const CARD_NO = { discard: ['keep'] };
const CARD_NO_FILL = { discard: ['its', 'work', 'changes', 'them', 'all'] };

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
  // Before the fillers go: "so" is one. Throwing work away takes its own words, so "make it so" keeps that card.
  if (toks.map(t => t.w).join(' ') === 'make it so') return yesAsked(toks) ? 'asks' : kind === 'discard' ? 'keep' : true;
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
    return true;
  }
  // "start it", "yes launch it", "start it is that right" to a card that is no launch: not its yes, and no new launch
  // either ("Start Claude on “it is that right”?"). The card stays.
  if (!launch && !no && ws.some(w => START_YES.has(w)) && ws.every(w => isYes(w) || START_YES.has(w) || CONFIRM_YES_FILL.has(w)
    || ownFill.includes(w) || QUESTION_START.has(w))) return 'keep';
  return null;
}

// A clear yes or no at the start of a longer reply. "go", "do", "okay" and "fine" are not here: they also begin
// commands and work requests ("go to search cleanup", "okay fix the login"), which are tried first.
const FIRST_YES = new Set(['yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'yea', 'sure', 'allow', 'allowed', 'approve', 'approved',
  'accept', 'accepted', 'permit', 'grant', 'granted', 'proceed', 'lgtm', 'absolutely', 'definitely', 'certainly', 'affirmative']);
const FIRST_NO = new Set(['no', 'nope', 'nah', 'deny', "don't"]);

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
  if (FIRST_NO.has(ws[0])) return { kind: 'deny', text: tidy(spanText(toks.slice(k + 1))) };
  // "yes, but what does it delete?" asks first: no answer yet (see parse, step 5).
  if (FIRST_YES.has(ws[0]) && !asksSomething(toks)) return { kind: 'deny', text: tidy(spanText(toks.slice(k))), conditional: true };
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
  if (NO_STRONG.has(first)) return { kind: 'deny', text: tidy(spanText(toks.slice(k))) };
  if (YES_STRONG.has(first)) return { kind: 'deny', text: tidy(spanText(toks.slice(k))), conditional: true };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Commands. Each matcher returns { intent, strong } or null. `strong` means the words cannot
// reasonably be an answer to a question the focused agent asked.

const STOP_ALL_WORDS = new Set(['everything', 'everyone', 'everybody', 'all', 'every']);
const STOP_ALL_FILL = new Set(['the', 'of', 'them', 'agents', 'agent', 'single', 'work', 'lot', 'now', 'right', 'at', 'once',
  'it', 'things', 'stuff', 'jobs', 'tasks', 'running', 'working', 'that', 'is', 'are', 'helpers', 'immediately']);
const STOP_VERBS = [['shut', 'down'], ['stop'], ['pause'], ['halt'], ['kill'], ['cancel'], ['abort'], ['terminate'], ['end'], ['quit'], ['interrupt']];
// "stop the flaky test immediately": how soon, not which agent.
const STOP_TAIL = [['right', 'away'], ['at', 'once'], ['immediately'], ['already'], ['again'], ['too']];

function matchStopAll(ws) {
  if (ws.length === 2 && STOP_ALL_WORDS.has(ws[0]) && ['stop', 'pause', 'halt'].includes(ws[1])) return true; // "everyone stop"
  if (ws.join(' ') === 'emergency stop') return true;
  const v = startsWithSeq(ws, STOP_VERBS);
  if (!v) return false;
  const rest = ws.slice(v);
  return rest.length > 0 && rest.some(w => STOP_ALL_WORDS.has(w)) && rest.every(w => STOP_ALL_WORDS.has(w) || STOP_ALL_FILL.has(w));
}

function matchStop(core, c) {
  const ws = core.map(t => t.w);
  const v = startsWithSeq(ws, STOP_VERBS);
  if (!v) return null;
  let rest = core.slice(v);
  if (rest.length >= 2 && (rest[0].w === 'working' || rest[0].w === 'work') && rest[1].w === 'on') rest = rest.slice(2);
  if (!rest.length) {
    // A bare "stop" means the focused agent. A bare "cancel" or "end" is too vague to stop anything.
    if (!['stop', 'pause', 'halt', 'kill', 'abort', 'terminate'].includes(ws[0])) return null;
    return { intent: { kind: 'stop', agentIds: c.focusId ? [c.focusId] : [] }, strong: !!c.focusId };
  }
  const refWords = rest.map(t => t.w).join(' ');
  if (ws[0] === 'cancel' && PRONOUN_REFS.has(refWords)) return null; // "cancel that" is not about an agent
  // "stop an agent to fix the login" says what a new agent should do: work that gets the start confirm, never a stop
  // of "Login fix" (the reference words would skip "an agent to" and find it).
  if (launchPhrase(rest.map(t => t.w))) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  const r = resolveList(stripTrailing(rest, STOP_TAIL), c);
  // Words that match nothing beside the agent's words say what to do, not which agent:
  // "stop the flaky test from timing out" is work, so it gets the start confirm like other work.
  if (r.ids.length && !r.full) return { intent: { kind: 'task', task: tidy(spanText(core)) }, strong: false };
  // No agent matches (and it is no "it" or "that"): a work request that starts with a stop verb, so it gets the
  // start confirm with the whole sentence as the task: "Start an agent to stop the flaky test from timing out?"
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
  return { intent: { kind: 'forget', agentIds: r.ids }, strong: r.named };
}

/** "continue search cleanup", "pick up it again": only for an agent from an earlier run (else the words go on). */
function matchContinue(core, c) {
  const ws = core.map(t => t.w);
  const v = startsWithSeq(ws, [['pick', 'up'], ['continue'], ['resume'], ['carry', 'on']]);
  if (!v) return null;
  const rest = stripTrailing(core.slice(v), [['again'], ['please']]);
  if (!rest.length) return null;
  const r = resolveRef(rest, c);
  const a = r.ids.length === 1 && r.full ? c.agents.find(x => x.id === r.ids[0]) : null;
  if (!a || !a.earlier) return null;
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
  if (PRONOUN_REFS.has(phrase)) return { id: focusRoot(c), form: 'pronoun', noun: false };
  if (GENERIC_WORK.test(phrase)) return { id: focusRoot(c), form: 'generic', noun: true };
  // "search cleanup's changes" (lexed without its "'s"), "this agent's work".
  if (ws.length > 1 && WORK_NOUN.has(ws[ws.length - 1])) {
    const head = ws.slice(0, -1);
    const named = namedRoot(head, c);
    if (named) return { ...named, noun: true };
    if (PRONOUN_REFS.has(head.join(' '))) return { id: focusRoot(c), form: 'pronoun', noun: true };
  }
  // "the changes from search cleanup", "all the work of 1a2b3c".
  const n = ws.findIndex(w => WORK_NOUN.has(w));
  if (n >= 0 && n + 2 < ws.length && WORK_OF.has(ws[n + 1]) && WORK_HEAD.test(ws.slice(0, n + 1).join(' '))) {
    const of = ws.slice(n + 2);
    const named = namedRoot(of, c);
    if (named) return { ...named, noun: true };
    if (PRONOUN_REFS.has(of.join(' '))) return { id: focusRoot(c), form: 'pronoun', noun: true };
  }
  return null;
}

/**
 * Something else on screen that "it" or "the changes" may be about: a confirm card, or a request (a question, a
 * stuck ask, a permission) from the focused agent or its one waiting helper. Words that do not name an agent then
 * keep their old meaning (the card's words, the answer, the permission's reply), never these commands.
 */
function screenBusy(c) {
  return !!c.pendingConfirm || hasAsk(c.asker);
}

/** A form that does not name the agent: "it", "its changes", a bare "merge". */
const weakForm = ref => ref.form === 'pronoun' || ref.form === 'generic' || ref.form === 'bare';
/** The words name the agent outright, so they win over an answer: its id, or its whole name. */
const strongRef = ref => !weakForm(ref) && !ref.partial;
/**
 * Words too loose to act on now, so they keep their old meaning. A weak form, while anything waits on screen: "it" may
 * be about that. Part of a name ("the unused imports" for Remove unused imports), while a question, a stuck ask or a
 * permission waits: the words are the reply to it, never a card that takes its place. A card has no "it" for a name,
 * so on a card part of a name is another command, as a whole name is (its old meaning would be a launch).
 */
const tooLoose = (ref, c) => (weakForm(ref) && screenBusy(c)) || (!!ref.partial && hasAsk(c.asker));

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
    ref = { id: focusRoot(c), form: 'bare', noun: false }; // "merge", "land"
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
        if (!ref && !toks.length && !bring) ref = { id: focusRoot(c), form: 'bare', noun: false }; // "merge into main"
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
  if (tooLoose(ref, c)) return null;
  const intent = { kind: 'merge', agentId: ref.id };
  if (into) intent.into = into;
  return { intent, strong: strongRef(ref) };
}

const DISCARD_VERBS = new Set(['discard', 'scrap', 'trash']);

/**
 * "throw away search cleanup's changes", "discard it", "throw it away", "scrap it": always asked first (the engine
 * shows a throw-away card). The words must name the agent, as for a merge; "discard unused imports" is no throw-away.
 * Strength is as for a merge: while Remove unused imports asks, "discard the unused imports" is the answer.
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
    if (!last || (last.w !== 'away' && last.w !== 'out')) return null;
    rest = rest.slice(0, -1);
  }
  if (!rest.length) return null; // "discard" alone throws nothing away
  // "scrap that" and "trash this" say never mind ("scratch that"), not which work to throw away. "scrap it" does.
  if ((ws[0] === 'scrap' || ws[0] === 'trash') && rest.length === 1 && (rest[0].w === 'that' || rest[0].w === 'this')) return null;
  if (launchPhrase(rest.map(t => t.w))) return null;
  const ref = workRef(rest, c);
  if (!ref) return null;
  if (tooLoose(ref, c)) return null;
  return { intent: { kind: 'discard', agentId: ref.id }, strong: strongRef(ref) };
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
  const show = ref => (!tooLoose(ref, c) ? { intent: { kind: 'changes', agentId: ref.id }, strong: strongRef(ref) }
    : weakForm(ref) ? cardReview(c) : null);
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
  // "review the changes" is work for an agent, but on a merge or throw-away card it looks at the work, as "show" does.
  m = cardReview(c) && CHANGES_REVIEW.exec(s);
  if (m) {
    const ref = workRef(refTokens(m, s, core), c);
    if (ref && ref.noun) return show(ref);
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
// for a general status; the others only count when the name matches an agent.
const STATUS_AGENT = [
  { re: /^(?:what|wat) (?:is|was|has|are) (?<ref>.+?) (?:doing|been doing|up to|working on|done|thinking)$/d, ask: true },
  { re: /^what did (?<ref>.+?) (?:do|change|find|say|finish|get done)$/d, ask: true },
  { re: /^what is the (?:status|progress|latest) (?:of|on|for|with) (?<ref>.+)$/d, ask: true },
  { re: /^how (?:is|are) (?<ref>.+?)(?: doing| going| getting on| coming along| progressing| looking)?$/d, ask: true },
  { re: /^how far (?:along )?(?:is|are) (?<ref>.+?)(?: along)?$/d, ask: true },
  { re: /^where (?:is|are) (?<ref>.+?)(?: at| up to| with it)?$/d, ask: true },
  { re: /^(?:is|has|did) (?<ref>.+?) (?:done|finished|finish|stuck|working|still working|still going|okay|alright|running|still running|ready|failing|broken|complete|completed|making progress|waiting)$/d, ask: true },
  { re: /^(?:status|update|progress|news) (?:of|on|for|about) (?<ref>.+)$/d, ask: true },
  { re: /^(?:give me|get me|show me) (?:the|a|an) (?:status|update|progress) (?:of|on|for|about) (?<ref>.+)$/d, ask: true },
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

function isNeedsMe(ws) {
  if (!ws.length || ws.length > 12) return false;
  const NEED = new Set(['need', 'needs', 'needing', 'needed', 'waiting', 'wait', 'waits', 'blocked', 'blocking', 'want', 'wants', 'require', 'requires']);
  const ME = new Set(['me', 'my', 'attention', 'approval', 'input', 'okay', 'decision', 'answer', 'help', 'review', 'reviewing', 'eyes']);
  const Q = new Set(['what', 'who', 'which', 'anything', 'anyone', 'anybody', 'something', 'is', 'are', 'does', 'do', 'show', 'list', 'tell', 'any', 'whatever']);
  const lead = Q.has(ws[0]) || (ws.length <= 4 && NEED.has(ws[0]));
  return lead && ws.some(w => NEED.has(w)) && ws.some(w => ME.has(w));
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

function matchStatusOrSpend(core, c) {
  const ws = core.map(t => t.w);
  const s = ws.join(' ');
  // One word ("update", "cost") could be the answer to a question, so only longer phrases are strong.
  if (GENERAL_STATUS.has(s)) return { intent: { kind: 'status' }, strong: ws.length > 1 };
  if (isNeedsMe(ws)) return { intent: { kind: 'status', needsMe: true }, strong: true };
  if (SPEND_EXACT.some(re => re.test(s))) return { intent: { kind: 'spend' }, strong: ws.length > 1 };
  for (const { re, ask } of STATUS_AGENT) {
    const m = re.exec(s);
    if (!m) continue;
    const ref = refTokens(m, s, core);
    if (SPEND_WORD.test(ref.map(t => t.w).join(' '))) break; // "how much is this costing" is spend, below
    const r = resolveRef(ref, c);
    if (r.ids.length) return { intent: { kind: 'status', agentId: r.ids[0] }, strong: r.sure };
    if (r.pronoun) return { intent: { kind: 'status' }, strong: true }; // "how is it going", nothing focused
    if (ask) return { intent: { kind: 'status' }, strong: false };
  }
  if (SPEND_WORD.test(s) && /^(how|what|show|tell)\b/.test(s)) return { intent: { kind: 'spend' }, strong: false };
  return null;
}

// Say -----------------------------------------------------------------------------------------

const SAY_VERBS = new Set(['tell', 'ask', 'remind', 'message', 'inform', 'instruct', 'nudge', 'ping', 'warn', 'advise']);
const SAY_SPLIT = new Set(['to', 'that', 'if', 'whether', 'why', 'what', 'how', 'when', 'where', 'which', 'about', 'not']);
const SAY_DROP = new Set(['to', 'that']);
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
    // One step needs the name and a clear break before the message: "tell search cleanup to ...".
    const sure = best.r.named && (best.cand.sep || !!best.r.pronoun);
    const intent = { kind: 'say', agentId: best.r.ids[0], text: tidy(spanText(best.cand.msg)) };
    if (!sure) intent.sure = false;
    return { intent, strong: sure };
  }
  // "tell it to ..." with nothing focused: a say with no agent, so the engine can ask which one.
  // A name that matches no agent is not a say: sending it to whatever is focused would be wrong.
  if (pronoun) {
    const text = tidy(spanText(pronoun.msg));
    return text ? { intent: { kind: 'say', agentId: null, text }, strong: false } : null;
  }
  return null;
}

// Start ---------------------------------------------------------------------------------------

const HARNESS_ALIAS = { claude: 'claude', claud: 'claude', clawed: 'claude', clod: 'claude', claudes: 'claude',
  'claude-code': 'claude', codex: 'codex', codecs: 'codex', codexes: 'codex', 'codex-cli': 'codex' };
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
    const first = tidy(spanText(toks.slice(0, k)));
    const second = tidy(spanText(toks.slice(k + 2 + h.len)));
    if (!first || !second) break;
    const h1 = noun.harnesses[0] || har.harness || null;
    return [{ task: first, harness: h1, machine }, { task: second, harness: h.harness, machine }];
  }

  if (!toks.length || emptyTask(toks)) return null;
  const task = tidy(spanText(toks));
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
  }
  if (noun.hasNoun && noun.definite && !noun.harnesses.length) return null; // "start the agent" refers to one that exists
  const tasks = buildTasks(core.slice(noun.end), noun, c);
  // A start verb with no work after it ("start an agent", "start codex", "start", "add an agent on cloud 2"): the
  // engine asks what the agent should work on. Only a start verb with a named agent wins over a waiting question:
  // "use codex", "ask claude" or a bare "start" may well be the answer.
  if (!tasks) return { intent: NO_TASK_START(noTaskHarness(noun, core.slice(noun.end), c)), strong: strongVerb && noun.named };
  return { intent: { kind: 'start', tasks }, strong: noun.named };
}

// Help, and connecting agents and keys ---------------------------------------------------------

/**
 * What "help" gets: what to say, and where agents are set up. Short, so it fits three lines under the DRAM at the
 * narrowest board. The engine answers the `help` intent with it.
 */
export const HELP_REPLY = 'Say what to work on, like “fix the login bug”. Or ask “what needs me”, or “stop everything”. Agents & keys sets up agents.';

/** A greeting and nothing more: "hi", "hello there", "hey workbench", "good morning". */
const GREETING = new Set(['hi', 'hello', 'hey', 'hiya', 'howdy', 'yo', 'greetings', 'morning', 'afternoon', 'evening']);
const GREETING_FILL = new Set(['there', 'workbench', 'again', 'everyone', 'everybody', 'all', 'folks', 'good', 'oh', 'okay', 'so', 'well', 'and']);
/** Asking what Workbench can do, said whole (after "please", "can you" and the like are dropped). */
const HELP_PHRASES = new Set(['help', 'help me', 'i need help', 'need help', 'get help', 'what can you do', 'what can you do for me',
  'what do you do', 'what can i do', 'what can i say', 'what can i ask', 'what can i type', 'what do i say', 'what should i say',
  'what do i do', 'how does this work', 'how does it work', 'how does workbench work', 'how do i use this', 'how do i use it',
  'how do i use workbench', 'how do i start', 'how do i begin', 'what is this', 'what is workbench', 'commands',
  'what are the commands', 'list the commands']);

/**
 * "help", "hi", "what can you do", "how does this work". Weak: while the focused agent (or its one waiting helper) asks
 * something, the words are about that ask, and keep their old meaning (the answer, or what exactly a permission asks).
 * On a card they settle nothing, and the card stays with its own hint.
 */
function matchHelp(core, base, c) {
  const all = base.map(t => t.w);
  const greeting = all.every(w => GREETING.has(w) || GREETING_FILL.has(w)) && all.some(w => GREETING.has(w));
  if (!greeting && !HELP_PHRASES.has(core.map(t => t.w).join(' '))) return null;
  if (c.pendingConfirm) return { intent: { kind: 'unknown' }, strong: true };
  if (hasAsk(c.asker)) return null;
  return { intent: { kind: 'help' }, strong: false };
}

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
 * A work request with no start verb: "fix the login redirect", and "work on the login bug", whose task is what comes
 * after "work on" ("the login bug"), as for "start an agent working on the login bug".
 */
function matchTask(core, c) {
  let words = core;
  if (core.length > 2 && core[0].w === 'work' && core[1].w === 'on') words = core.slice(2);
  else if (core.length < 2 || !WORK_VERBS.has(core[0].w)) return null;
  if (emptyTask(words === core ? core.slice(1) : words)) return null; // "fix it", "do that", "work on it"
  const last = core[core.length - 1].raw;
  if (/\?["'”’]*$/.test(last)) return null; // a question, not a request
  // An explicit harness or machine makes it a launch: "fix the login redirect using codex".
  const mach = takeMachine(words, c);
  const har = takeHarness(mach.toks);
  if (mach.machine || har.harness) {
    const task = tidy(spanText(har.toks));
    if (task && !emptyTask(har.toks)) {
      return { kind: 'start', tasks: [{ task, harness: har.harness || null, machine: mach.machine || laptopId(c) }] };
    }
  }
  const task = tidy(spanText(words));
  return task ? { kind: 'task', task } : null;
}

// Answers -------------------------------------------------------------------------------------

const KEEP_TRYING = new Set(['keep trying', 'keep going', 'let it keep trying', 'let it keep going', 'let it try', 'let it continue',
  'carry on', 'continue', 'leave it', 'leave it be', 'let it be', 'it is fine', 'fine', 'let it run', 'give it more time',
  'let it go on', 'try again', 'keep at it', 'let it keep at it']);

function answerIntent(base, focus, ask) {
  const toks = stripSoft(base);
  let text = spanText(toks).replace(/[\s,]+$/, '').trim();
  const said = toks.map(t => t.w).join(' ');
  const options = Array.isArray(ask.options) ? ask.options.filter(o => typeof o === 'string') : [];
  // A reply that names one of the offered choices uses that choice's exact words.
  const exact = options.find(o => normName(o) === normName(said));
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

function parse(said, c) {
  const base = lex(said).filter(t => !DISFLUENCY.has(t.w));
  if (!base.length) return { kind: 'unknown', text: said };
  const holder = c.asker; // the focused agent, or its one helper that is waiting on the person
  const ask = holder ? holder.ask : null;

  // 1. A confirm on screen is waiting for "yes" or "cancel" (only the one the page shows: see the engine).
  // "is that right?" asks about the card rather than answering it: it settles nothing, and the card stays. So does a
  // yes that is not enough for that card (a bare "yes" to throwing work away): it never falls through to an answer.
  if (c.pendingConfirm) {
    const go = confirmReply(base, c.pendingConfirm.kind, c);
    if (go === 'asks' || go === 'keep') return { kind: 'unknown', text: said };
    if (go !== null) return { kind: 'confirm', go };
  }
  // 2. The focused agent is waiting for permission.
  const permission = ask && ask.type === 'permission';
  const reply = (r) => {
    const intent = { kind: r.kind, agentId: holder.id, askId: ask.id ?? null };
    if (r.text) intent.text = r.text;
    if (r.conditional) intent.conditional = true;
    return intent;
  };
  if (permission) {
    const r = permissionReply(base);
    // "is it okay?" gets what exactly is asked for, and the request keeps waiting (as in step 5).
    if (r && r.kind === 'asks') return { kind: 'status', agentId: holder.id };
    if (r) return reply(r);
  }
  // 3. Commands. While a question waits, only unmistakable commands win over an answer.
  const core = stripTrailing(stripPolite(stripSoft(base)));
  const found = matchCommand(core, c, base);
  // Words about the card on screen that it cannot act on ("show me the changes" on a card that does not say whose work
  // it is): the card stays, with its hint.
  if (found && found.intent.kind === 'unknown') return { kind: 'unknown', text: said };
  const waiting = ask && (ask.type === 'question' || ask.type === 'stuck');
  if (found && (found.strong || !waiting)) return found.intent;
  if (waiting) return answerIntent(base, holder, ask);
  // 4. A work request with no start verb.
  const task = matchTask(core, c);
  if (task) return task;
  // 5. Words for the permission that are no command and no work. A question about it ("do I need to approve this?")
  // gets what exactly it asks for, and the request keeps waiting; words that start like a yes or a no but say more
  // are a no that carries them.
  if (permission) {
    if (asksSomething(base)) return { kind: 'status', agentId: holder.id };
    const r = looseReply(base);
    if (r) return reply(r);
  }
  return { kind: 'unknown', text: said };
}

function matchCommand(core, c, base = core) {
  if (!core.length) return null;
  const ws = core.map(t => t.w);
  if (matchStopAll(ws)) return { intent: { kind: 'stop_all' }, strong: true };
  // Help and Agents & keys take only their own words whole, so they come first: "open agents and keys" would be a
  // launch of "keys", and "connect github" work. Changes, merge and throw-away come before status: "what did search
  // cleanup change" and "show search cleanup's changes" were status questions, and still are when they name no agent.
  return matchHelp(core, base, c)
    || matchConnect(core)
    || matchMachines(core, c)
    || matchStop(core, c)
    || matchForget(core, c)
    || matchContinue(core, c)
    || matchChanges(core, c)
    || matchMerge(core, c)
    || matchDiscard(core, c)
    || matchStatusOrSpend(core, c)
    || matchSay(core, c)
    || matchStart(core, c);
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
    return `Start ${whoStarts(ts.map(t => t.harness))} on ${quote(ts[0].task)}${where}?`;
  }
  const parts = ts.map((t, k) => `${whoStarts([t.harness])} on ${quote(t.task)}${sameMachine ? '' : placePhrase(machines[k], 1, c)}`);
  return `Start ${joinAnd(parts)}${where}?`;
}

/**
 * A plain sentence describing an intent, for a confirm card.
 * "Start Claude on “fix the flaky checkout test”?"
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
