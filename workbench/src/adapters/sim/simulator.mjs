// Demo mode: a stand-in for real coding agents.
// It emits only normalized events (src/shared/events.mjs), shaped like what the Claude Code parser produces:
// agents and helpers, plain-language activity from narrate(), thinking blips, usage and cost, plans, turns, asks.
// Time is simulated: tick(now) advances it by the real time elapsed multiplied by `speed`.
// Event timestamps are always real wall-clock milliseconds; speed only compresses the pacing.
// Everything random comes from a small seeded PRNG, so a given seed always plays out the same way.
// The demo also has a pretend git repository (see "The demo's git repository" below): a history, a branch per agent,
// diffs, and merging or throwing away an agent's work, shaped like what workspace.mjs returns for a real repository.
import { EV } from '../../shared/events.mjs';
import { STATE, ENDED, ACTIVE } from '../../shared/states.mjs';
import { narrate, nameFromTask, describeRequest, firstSentence, extractQuestion, baseName } from '../../shared/narrate.mjs';
import { clip, money } from '../../shared/format.mjs';

export const harness = 'sim';

/** The simulator needs nothing installed. */
export async function available() {
  return { ok: true };
}

const SEC = 1000;
const MIN = 60 * SEC;
const CONTEXT_WINDOW = 200_000;
const COMPACT_AT = 150_000;        // a root's context is compacted back down past this
const MAX_HELPERS_PER_ROOT = 24;   // the endless demo agent stops adding helpers after this many (about an hour)

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-5';
const OPUS = 'claude-opus-5-5';

// USD per million tokens, used to make cost grow believably with the tokens.
const RATES = {
  haiku:  { in: 1, out: 5,  read: 0.10, write: 1.25 },
  sonnet: { in: 3, out: 15, read: 0.30, write: 3.75 },
  opus:   { in: 5, out: 25, read: 0.50, write: 6.25 },
};

// ---------------------------------------------------------------------------
// Seeded randomness (no Math.random anywhere)

function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  constructor(seed) { this.next = mulberry32(hash32(seed)); }
  between(lo, hi) { return lo + (hi - lo) * this.next(); }
  int(lo, hi) { return lo + Math.floor(this.next() * (hi - lo + 1)); }
  chance(p) { return this.next() < p; }
  pick(list) { return list[Math.floor(this.next() * list.length)]; }
  hex(n) {
    let s = '';
    while (s.length < n) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
  shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Small helpers

const round4 = x => Math.round(x * 10000) / 10000;
const ACCEPT_RE = /^(looks good|keep it|accept( it)?|ok(ay)?|fine|great|good|thanks?|thank you|leave it)\b/i;
const NEGATIVE_RE = /^(no\b|nope|don'?t|do not|not now|skip|leave it|no thanks|never mind|nah)/i;
// A stuck agent stops only on its button's words, as in the engine: "stop using the old fixture" is a hint.
const STOP_RE = /^(stop it|stop)[.!]*$/i;
const KEEP_TRYING_RE = /keep (it )?trying|let it (keep )?try/i;

/**
 * Is a permission answer a yes? Only the Allow button's own word, as in the engine: the engine turns a typed or
 * spoken plain "yes" into "Allow", and anything else, "yes but only in the tests folder" included, is a no.
 */
function isAllow(text) {
  return /^allow$/i.test(String(text || '').trim());
}

function familyOf(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : 'sonnet';
}

function resolveModel(model, harnessName) {
  if (harnessName === 'codex') return model || 'gpt-5-codex';
  if (!model) return SONNET;
  const m = String(model).toLowerCase();
  if (m === 'opus') return OPUS;
  if (m === 'sonnet') return SONNET;
  if (m === 'haiku') return HAIKU;
  return String(model);
}

/** Turn a compact step tuple from the scripts below into { tool, input, ok }. */
function stepOf(t) {
  if (!Array.isArray(t)) return t;
  const [tool, arg, ok = true, description] = t;
  switch (tool) {
    case 'Read': case 'Edit': case 'Write': return { tool, input: { file_path: arg }, ok };
    case 'Grep': case 'Glob': return { tool, input: { pattern: arg }, ok };
    case 'Bash': return { tool, input: description ? { command: arg, description } : { command: arg }, ok };
    case 'WebFetch': return { tool, input: { url: arg }, ok };
    case 'plan': return { plan: arg };
    case 'spawn': return { spawn: arg };
    default: return { tool, input: arg || {}, ok };
  }
}

const isTestCommand = input => /\btest\b/.test(String(input?.command || ''));

/** Why the workbench's permission check asks about a scripted risky step, in the check's own words. */
const whyAsk = step => (step.tool === 'WebFetch' ? 'Opening a web page needs your OK.' : 'This command is not on the list of safe commands.');

// ---------------------------------------------------------------------------
// Reading a task: what is it about, and what would the agent say when done?

const PAST = {
  fix: 'fixed', add: 'added', write: 'wrote', make: 'made', update: 'updated', remove: 'removed',
  delete: 'deleted', change: 'changed', improve: 'improved', clean: 'cleaned', refactor: 'refactored',
  implement: 'implemented', create: 'created', build: 'built', rewrite: 'rewrote', investigate: 'looked into',
  find: 'found', check: 'checked', review: 'reviewed', document: 'documented', migrate: 'migrated',
  upgrade: 'upgraded', test: 'tested', debug: 'debugged', rename: 'renamed', move: 'moved',
  simplify: 'simplified', replace: 'replaced', tidy: 'tidied', prevent: 'prevented', handle: 'handled',
  convert: 'converted', port: 'ported', split: 'split', optimize: 'optimized', optimise: 'optimised',
  polish: 'polished', speed: 'sped', translate: 'translated', explain: 'explained', support: 'added support for',
};
const STOPWORDS = new Set(('the a an my our this that these those some please just quickly really to for of with in on at by ' +
  'from so then and or it its is are be all up out into when where why how what which who now again also more less too ' +
  'very any each every there their them they we you i me can could would should will agent agents claude codex cloud ' +
  'machine machines laptop own new old make sure way').split(' '));
const WEAK = new Set(('flaky broken slow bug bugs issue issues problem problems error errors test tests code file files page pages ' +
  'thing things stuff function functions module modules feature features support docs doc documentation readme small big ' +
  'better faster clearer proper properly').split(' '));
const LAUNCH_RE = /^(please\s+)?(start|launch|spin up|run|have|get|ask|use)\s+(an?\s+)?(new\s+)?(agent|claude|codex|helper)s?\s*(to\s+|on\s+|and\s+|for\s+)?/i;
const FILLER_RE = /^(please|pls|can you|could you|would you|i want you to|i need you to|go and|try to|help me|let's|lets)\s+/i;

/** Pull a topic out of a task: its verb, the object, and one specific key word for names and files. */
export function topicOf(task) {
  let text = String(task || '').replace(/\s+/g, ' ').trim();
  text = text.replace(LAUNCH_RE, '');
  for (let k = 0; k < 3; k++) text = text.replace(FILLER_RE, '');
  const words = text.split(' ').filter(Boolean);
  const verb = (words[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  const past = PAST[verb] || null;
  const object = clip((past ? words.slice(1).join(' ') : text).replace(/[.!?;:,\s]+$/, ''), 90);
  const file = /([\w-]+)\.(m?js|cjs|ts|tsx|jsx|py|go|rs|rb|java|css|md|json)\b/i.exec(text);
  const tokens = object.toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
  const specific = tokens.find(w => w.length > 2 && !STOPWORDS.has(w) && !WEAK.has(w) && !PAST[w]);
  const anyWord = tokens.find(w => w.length > 2 && !STOPWORDS.has(w));
  const key = ((file ? file[1].toLowerCase() : specific || anyWord) || 'project').replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'project';
  return { verb: past ? verb : null, past, object, key, file: file ? file[0] : null };
}

/** "I fixed the flaky checkout test." */
function doneSentence(topic) {
  if (topic.past && topic.object) return `I ${topic.past} ${topic.object}.`;
  if (topic.object) return `I finished the work on ${lowerFirst(topic.object)}.`;
  return 'I finished the task.';
}

function lowerFirst(s) {
  return s && /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** A plain final message: never reads as a question unless we mean it to. */
function plainFinal(...sentences) {
  const text = sentences.filter(Boolean).join(' ');
  return extractQuestion(text) ? 'I finished the task, and the tests pass.' : text;
}

const PLAN_TEMPLATES = {
  fix: k => ['Find where the problem starts', 'Reproduce it with a test', `Fix the ${k} code`, 'Run the tests', 'Write a short summary'],
  test: k => [`Read the ${k} code`, 'List the cases to cover', 'Write the tests', 'Run the tests', 'Write a short summary'],
  docs: k => [`Read the current ${k} docs`, 'Rewrite the unclear parts', 'Check the examples still work', 'Write a short summary'],
  remove: k => [`Find every use of ${k}`, `Remove the ${k} code`, 'Run the tests', 'Write a short summary'],
  general: k => [`Read the ${k} code`, 'Plan the change', 'Make the change', 'Run the tests', 'Write a short summary'],
};

function planKind(topic, task) {
  if (/\b(fix|debug|investigate)\b/i.test(topic.verb || '') || /\b(bug|broken|fails?|failing|flaky|crash)/i.test(task)) return 'fix';
  if (/\btests?\b/i.test(task) && /\b(write|add|create)\b/i.test(topic.verb || '')) return 'test';
  if (/\b(docs?|documentation|readme|help pages?)\b/i.test(task)) return 'docs';
  if (/\b(remove|delete)\b/i.test(topic.verb || '')) return 'remove';
  return 'general';
}

// Helper (sub-agent) jobs a scripted agent can hand out. Their names come from nameFromTask(description).
const HELPER_JOBS = [
  { when: 'fix', description: k => `Find similar ${k} bugs`, type: 'Explore', summary: (k, n) => `I found ${n === 1 ? 'one other place' : n + ' other places'} in the ${k} code with the same problem.` },
  { description: k => `Map the ${k} code`, type: 'Explore', summary: (k, n, f) => `Most of the ${k} logic lives in one file, ${baseName(f)}.` },
  { description: k => `Find uses of ${k}`, type: 'Explore', summary: (k, n) => `It is used in ${n + 2} places, and none of them need to change.` },
  { description: k => `Write ${k} tests`, type: 'general-purpose', summary: (k, n) => `I added ${n + 3} tests for ${k}, and they pass.` },
  { description: k => `Review the ${k} changes`, type: 'general-purpose', summary: () => 'The changes look right; I suggested one small cleanup.' },
  { description: k => `Check ${k} edge cases`, type: 'general-purpose', summary: (k, n) => `I checked ${n + 3} edge cases, and one needed a small fix.` },
];

// Risky steps that need the person's OK, and what the agent does if the answer is no.
const PERMISSIONS = [
  { step: ['Bash', 'npm install --save-dev fast-check', true, 'Install a testing library'],
    after: [['Bash', 'npm test']],
    alt: k => [['Write', `test/helpers/random-${k}.ts`], ['Bash', 'npm test']],
    note: 'I did not install the new testing library; I wrote a small test helper instead.' },
  { step: ['Bash', 'npm run db:reset -- --env test', true, 'Reset the test database'],
    after: [['Bash', 'npm test']],
    alt: () => [['Read', 'test/setup.ts'], ['Edit', 'test/setup.ts']],
    note: 'I did not reset the shared test database; the tests now use their own temporary copy.' },
  { step: ['WebFetch', 'https://nodejs.org/api/test.html'],
    after: [['Grep', 'describe(']],
    alt: k => [['Grep', 'describe('], ['Read', `test/${k}.test.ts`]],
    note: 'I did not open the web page; I worked from the code that is already here.' },
  { step: ['Bash', 'rm -rf build/cache', true, 'Clear the build cache'],
    after: [['Bash', 'npm run build']],
    alt: () => [['Bash', 'npm run build']],
    note: 'I did not delete the build cache; a fresh build worked without it.' },
];

// Closing questions a scripted agent may ask, and what it does when the answer is yes.
const QUESTIONS = [
  { q: () => 'Should I also add a note about this to the changelog?',
    steps: () => [['Read', 'CHANGELOG.md'], ['Edit', 'CHANGELOG.md']],
    done: () => 'I added a note about this to the changelog.' },
  { q: k => `Should I also add a few more tests for ${k}?`,
    steps: k => [['Write', `test/${k}-more.test.ts`], ['Bash', 'npm test']],
    done: k => `I added more tests for ${k}, and they pass.` },
  { q: k => `Should I also tidy up the old ${k} code while I am here?`,
    steps: (k, files) => [['Edit', files[1]], ['Bash', 'npm test']],
    done: k => `I tidied up the old ${k} code, and the tests still pass.` },
  { q: () => 'Should I update the README to match?',
    steps: () => [['Read', 'README.md'], ['Edit', 'README.md']],
    done: () => 'I updated the README to match.' },
];

// ---------------------------------------------------------------------------
// The starting world for demo mode, close to the approved mockup.
// Times are minutes before seedWorld() runs. Plan strings: x done, > in progress, . pending.
// Seeded agents look like Claude Code agents (their events are shaped like the Claude parser's);
// Help pages looks like Codex, as in the mockup: no helpers, no permission hook, no cost reported.

// The checks the demo repository declares; simulated agents report them before their turn ends,
// and in the demo the engine takes the result from there.
const REPO_CHECKS = ['Unit tests', 'Type check'];
// The rules the demo repository sets (workbench.json). A merge card checks them against the work it would merge, as the
// engine does: a path breaks a rule when it starts with one of the rule's paths.
const REPO_RULES = [
  { say: 'Do not touch migrations/', paths: ['migrations/'] },
  { say: 'Keep the public invoice API the same', paths: ['src/api/invoices'] },
];

const SEED_WORLD = [
  {
    name: 'Checkout fix', machineId: 'cloud-1', model: SONNET, budgetUsd: 2, costUsd: 0.62,
    task: 'Fix the checkout bug where half-finished orders are lost',
    startedAgo: 21, endAgo: 4, end: 'permission',
    plan: ['Find where checkouts are saved', 'Reproduce the lost order bug', 'Save a resume token with each order', 'Update the test database', 'Run the checkout tests'],
    steps: [
      ['Read', 'src/checkout/checkout.ts'], ['Grep', 'saveOrder'], ['plan', '>....'], ['spawn', 0],
      ['Read', 'src/orders/order.ts'], ['spawn', 1], ['Read', 'src/checkout/session.ts'], ['plan', 'x>...'],
      ['Write', 'test/checkout/resume.test.ts'], ['Bash', 'npm test -- checkout', false], ['plan', 'xx>..'],
      ['Edit', 'src/orders/order.ts'], ['Edit', 'src/checkout/checkout.ts'], ['Read', 'src/db/schema/orders.ts'],
      ['Edit', 'src/db/schema/orders.ts'], ['Bash', 'git diff --stat'], ['plan', 'xxx>.'],
    ],
    fill: { count: 10, pool: [['Read', 'src/checkout/cart.ts'], ['Grep', 'resumeToken'], ['Read', 'src/payments/charge.ts'], ['Grep', 'orderStatus'], ['Read', 'src/orders/types.ts']] },
    helpers: [
      { description: 'Find similar bugs', type: 'Explore', model: HAIKU, minutes: 4.5,
        steps: [['Grep', "status: 'pending'"], ['Read', 'src/cart/cart.ts'], ['Read', 'src/payments/retry.ts'], ['Grep', 'abandoned'], ['Read', 'src/orders/cleanup.ts'], ['Grep', 'deleteOrder']],
        summary: 'I found two other places where unfinished orders are dropped: the cart timeout and the payment retry.' },
      { description: 'Trace the checkout flow from cart to payment', type: 'Explore', model: HAIKU, minutes: 3.5,
        steps: [['Read', 'src/routes/checkout.ts'], ['Grep', 'createOrder'], ['Read', 'src/payments/charge.ts'], ['Read', 'src/orders/order.ts'], ['Grep', 'onPaymentFailed']],
        summary: 'The order is only saved after the payment goes through, so anything that fails before that is lost.' },
    ],
    pending: ['Bash', 'npm run db:migrate -- --env test', true, 'Update the test database'],
  },
  {
    name: 'Search cleanup', machineId: 'laptop', model: SONNET, budgetUsd: 2, costUsd: 0.41,
    task: 'Clean up the old search code now that the new search page is live',
    startedAgo: 26, endAgo: 11, end: 'question',
    plan: ['Find every use of the old search', 'Point links to the new search page', 'Remove the old search code', 'Run the tests'],
    steps: [
      ['Grep', 'legacySearch'], ['Glob', 'src/**/search*'], ['Read', 'src/search/legacy-search.ts'], ['plan', '>...'],
      ['Read', 'src/routes/search.ts'], ['Grep', '/search/v1'], ['plan', 'x>..'], ['Edit', 'src/components/Header.tsx'],
      ['Edit', 'src/pages/Help.tsx'], ['Edit', 'src/search/index.ts'], ['Bash', 'npm test'], ['plan', 'xx>.'],
      ['Read', 'reports/search-traffic.csv'],
    ],
    fill: { count: 8, pool: [['Read', 'src/search/results.tsx'], ['Grep', 'searchUrl'], ['Read', 'src/components/SearchBox.tsx'], ['Grep', 'v1/search']] },
    says: 'I pointed every link at the new search page.',
    ask: { type: 'question', sentence: 'Should the old search address keep working for existing customers, or can I remove it?', options: ['Keep it working', 'Remove it'] },
  },
  {
    name: 'Flaky test', machineId: 'cloud-3', model: SONNET, budgetUsd: 2, costUsd: 0.93,
    task: 'Find out why the cart total test fails now and then, and make it reliable',
    startedAgo: 38, endAgo: 6, end: 'stuck',
    plan: ['Run the cart tests many times', 'Find what changes between runs', 'Fix the cause', 'Run the tests 50 times'],
    steps: [
      ['Bash', 'npm test -- cart/total'], ['Read', 'test/cart/total.test.ts'], ['plan', '>...'], ['spawn', 0],
      ['Read', 'src/cart/total.ts'], ['plan', 'x>..'], ['Read', 'src/money/round.ts'], ['Grep', 'toFixed'], ['plan', 'xx>.'],
      // The same error three times: this is what makes it look stuck.
      ['Edit', 'test/cart/total.test.ts'], ['Bash', 'npm test -- cart/total --repeat 20', false],
      ['Edit', 'src/cart/total.ts'], ['Bash', 'npm test -- cart/total --repeat 20', false],
      ['Edit', 'test/cart/total.test.ts'], ['Bash', 'npm test -- cart/total --repeat 20', false],
    ],
    fill: { count: 9, pool: [['Read', 'src/cart/discounts.ts'], ['Grep', 'Date.now'], ['Read', 'test/helpers/cart.ts'], ['Grep', 'Math.round']], before: 9 },
    helpers: [
      { description: 'Look for timing problems in the cart tests', type: 'Explore', model: HAIKU, minutes: 5,
        steps: [['Grep', 'setTimeout'], ['Grep', 'Date.now'], ['Read', 'test/cart/total.test.ts'], ['Read', 'test/helpers/clock.ts'], ['Grep', 'useFakeTimers']],
        summary: 'There are no timers or sleeps in the cart tests, so the failures come from the price total itself.' },
    ],
    ask: { type: 'stuck', sentence: 'Flaky test has hit the same error three times.', detail: 'The cart total test keeps failing: it expected 42.10 but got 42.09.', options: ['Stop it', 'Let it keep trying'] },
  },
  {
    name: 'Invoice export', machineId: 'cloud-1', model: OPUS, budgetUsd: 2, costUsd: 0.71,
    task: 'Make the invoice export work for large accounts by sending invoices in small batches',
    startedAgo: 64, endAgo: 23, end: 'done_checked',
    plan: ['Find why big exports time out', 'Send invoices in small batches', 'Add tests for large accounts', 'Run all the tests'],
    steps: [
      ['Read', 'src/invoices/export.ts'], ['Grep', 'exportInvoices'], ['plan', '>...'], ['Read', 'src/invoices/query.ts'],
      ['Bash', 'npm test -- invoices'], ['plan', 'x>..'], ['Write', 'src/invoices/batch.ts'], ['Edit', 'src/invoices/export.ts'],
      ['Edit', 'src/invoices/query.ts'], ['Write', 'migrations/0042_invoice_lookup_index.sql'], ['plan', 'xx>.'],
      ['Write', 'test/invoices/large-account.test.ts'], ['Bash', 'npm test'], ['plan', 'xxx>'], ['Bash', 'npm run lint'], ['plan', 'xxxx'],
    ],
    fill: { count: 10, pool: [['Read', 'src/invoices/pdf.ts'], ['Grep', 'BATCH_SIZE'], ['Read', 'src/db/pool.ts'], ['Grep', 'timeout']] },
    says: 'Invoices now go out in small batches, so large accounts can export without timing out.',
    checks: [{ name: 'Unit tests', ok: true, ms: 48_200 }, { name: 'Type check', ok: true, ms: 9_400 }],
    rules: { kept: [{ say: 'Keep the public invoice API the same' }], broken: [{ say: 'Do not touch migrations/', paths: ['migrations/0042_invoice_lookup_index.sql'] }] },
  },
  {
    name: 'Help pages', machineId: 'laptop', harness: 'codex', model: 'gpt-5-codex', budgetUsd: 2, costUsd: null,
    task: 'Rewrite the help pages for getting started, billing and exports in plain language',
    startedAgo: 44, endAgo: 17, end: 'done_claimed',
    plan: ['Read the current help pages', 'Rewrite getting started', 'Rewrite billing', 'Rewrite exports'],
    steps: [
      ['Glob', 'docs/help/*.md'], ['Read', 'docs/help/getting-started.md'], ['Read', 'docs/help/billing.md'],
      ['Read', 'docs/help/exports.md'], ['plan', 'x>..'], ['Edit', 'docs/help/getting-started.md'], ['plan', 'xx>.'],
      ['Edit', 'docs/help/billing.md'], ['plan', 'xxx>'], ['Edit', 'docs/help/exports.md'], ['Bash', 'git diff --stat'], ['plan', 'xxxx'],
    ],
    fill: { count: 6, pool: [['Read', 'docs/help/faq.md'], ['Grep', 'invoice'], ['Read', 'docs/style-guide.md']] },
    says: 'I rewrote the help pages for getting started, billing and exports in plain language.',
    rules: { kept: [{ say: 'Do not touch migrations/' }], broken: [] },
    // You changed the billing help on main after it started (TRUNK below), so its work clashes there until it
    // brings in main: merging it gives a conflict, as the demo should show once.
    git: { conflict: ['docs/help/billing.md'] },
  },
  {
    name: 'Onboarding', machineId: 'laptop', model: HAIKU, budgetUsd: 5, costUsd: 0.38, costScale: 0.05,
    task: 'Make the first-run onboarding clearer for new customers and add tests for the sign-up flow',
    startedAgo: 12, endAgo: 0, end: 'working',
    plan: ['Read the current onboarding screens', 'List the confusing steps', 'Rewrite the welcome steps', 'Add tests for the sign-up flow', 'Check it on small screens'],
    steps: [
      ['Glob', 'src/onboarding/**'], ['Read', 'src/onboarding/Welcome.tsx'], ['Read', 'src/onboarding/steps.ts'], ['plan', '>....'],
      ['Read', 'src/onboarding/copy.json'], ['Grep', 'onboardingStep'], ['plan', 'x>...'], ['Read', 'src/signup/SignUpForm.tsx'],
      ['spawn', 0], ['plan', 'xx>..'], ['Edit', 'src/onboarding/steps.ts'], ['Edit', 'src/onboarding/copy.json'], ['spawn', 1],
      ['Edit', 'src/onboarding/Welcome.tsx'], ['Read', 'src/onboarding/Progress.tsx'], ['Bash', 'npm test -- onboarding'],
      ['Edit', 'src/onboarding/Welcome.tsx'], ['Bash', 'git diff --stat'],
    ],
    fill: { count: 30, pool: [['Read', 'src/onboarding/Checklist.tsx'], ['Grep', 'welcomeStep'], ['Read', 'src/styles/onboarding.css'], ['Grep', 'skipOnboarding'], ['Read', 'src/onboarding/Progress.tsx']] },
    helpers: [{ job: 0, minutes: 5, done: 9 }, { job: 1, minutes: 2.5, done: 4 }],
  },
];

// The endless demo agent (Onboarding): what it keeps doing, the plan steps it adds, the helpers it hands work to.
const ONBOARDING_POOL = [
  ['Read', 'src/onboarding/Welcome.tsx'], ['Edit', 'src/onboarding/Welcome.tsx'], ['Read', 'src/onboarding/steps.ts'],
  ['Edit', 'src/onboarding/steps.ts'], ['Edit', 'src/onboarding/copy.json'], ['Read', 'src/onboarding/Progress.tsx'],
  ['Edit', 'src/onboarding/Progress.tsx'], ['Grep', 'skipOnboarding'], ['Grep', 'welcomeStep'], ['Read', 'src/signup/SignUpForm.tsx'],
  ['Bash', 'npm test -- onboarding'], ['Bash', 'git diff --stat'], ['Glob', 'src/onboarding/*.tsx'],
  ['Read', 'src/styles/onboarding.css'], ['Edit', 'src/styles/onboarding.css'], ['Bash', 'npm run lint'],
];
const ONBOARDING_MORE_PLAN = ['Make the step indicator clearer', 'Shorten the welcome email', 'Add a skip-for-now option',
  'Check the screens with a screen reader', 'Tidy up the old onboarding code', 'Update the onboarding help page'];
const ONBOARDING_JOBS = [
  { description: 'Check the welcome email copy', type: 'Explore', model: HAIKU,
    pool: [['Read', 'emails/welcome.mjml'], ['Grep', 'Welcome to'], ['Read', 'src/emails/welcome.ts'], ['Glob', 'emails/*.mjml'], ['Grep', 'planName'], ['Read', 'src/emails/strings.json']],
    summary: 'The welcome email still uses the old plan names in three places.' },
  { description: 'Write sign-up flow tests', type: 'general-purpose', model: HAIKU,
    pool: [['Read', 'src/signup/SignUpForm.tsx'], ['Write', 'test/signup/flow.test.ts'], ['Edit', 'test/signup/flow.test.ts'], ['Bash', 'npm test -- signup'], ['Read', 'test/helpers/render.ts'], ['Grep', 'onSubmit']],
    summary: 'I added six tests for the sign-up flow, and they all pass.' },
  { description: 'Find old onboarding screens', type: 'Explore', model: HAIKU,
    pool: [['Glob', 'src/**/Onboarding*'], ['Grep', 'OldWelcome'], ['Read', 'src/legacy/OldWelcome.tsx'], ['Grep', 'routes.onboarding'], ['Read', 'src/routes/index.ts']],
    summary: 'Two old onboarding screens are no longer linked from anywhere and can be removed.' },
  { description: 'Check the invite form on small screens', type: 'general-purpose', model: HAIKU,
    pool: [['Read', 'src/invite/InviteForm.tsx'], ['Read', 'src/styles/invite.css'], ['Edit', 'src/styles/invite.css'], ['Bash', 'npm test -- invite'], ['Grep', 'max-width']],
    summary: 'The invite form fits on small screens once its buttons stack.' },
  { description: 'Find unclear button labels', type: 'Explore', model: HAIKU,
    pool: [['Grep', '>Continue<'], ['Read', 'src/onboarding/copy.json'], ['Grep', 'aria-label'], ['Read', 'src/components/Button.tsx'], ['Glob', 'src/onboarding/*.tsx']],
    summary: 'Four buttons just say Continue where a clearer label would help.' },
  { description: 'Review the new welcome steps', type: 'general-purpose', model: HAIKU,
    pool: [['Read', 'src/onboarding/Welcome.tsx'], ['Read', 'src/onboarding/steps.ts'], ['Bash', 'git diff --stat'], ['Read', 'src/onboarding/copy.json'], ['Bash', 'npm test -- onboarding']],
    summary: 'The new welcome steps read well; I suggested shorter titles for two of them.' },
  { description: 'Test the skip-for-now path', type: 'general-purpose', model: HAIKU,
    pool: [['Read', 'src/onboarding/skip.ts'], ['Write', 'test/onboarding/skip.test.ts'], ['Bash', 'npm test -- onboarding'], ['Edit', 'src/onboarding/skip.ts'], ['Grep', 'skipOnboarding']],
    summary: 'Skipping onboarding now keeps what the customer already chose, and the tests pass.' },
];

// ---------------------------------------------------------------------------
// The demo's git repository. Nothing here touches a real repository: it is a believable history for the git screen,
// a branch per agent, and what merging or throwing away an agent's work does to it. The shapes follow workspace.mjs
// (gitGraph, workDiff, mergeWork, discardWork) and the engine's cards, so the page treats the demo like a real run.

// The engine's event for what became of a root's work in git (EV.WORK in src/shared/events.mjs).
const WORK_EVENT = EV.WORK || 'agent.work';
const DEMO_REPO = 'storefront';
const TRUNK_BRANCH = 'main';
const YOU = 'you';                 // the author of the person's own commits and of every merge commit
const DEMO_DIRTY = 2;              // the person's own uncommitted changes, which no merge touches
const DAY_MIN = 24 * 60;
// What workspace.mjs accepts in a Workbench-Agent trailer, and the trailer it adds to a Claude Code agent's work.
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const CLAUDE_TRAILER = 'Co-authored-by: Claude <noreply@anthropic.com>';
// The demo says plainly that nothing real happened: after the fact, and on the cards before it.
const SIM_SAYS_MERGED = 'This is the demo: nothing was really merged.';
const SIM_SAYS_THROWN = 'This is the demo: nothing was really thrown away.';
const SIM_CARD_MERGE = 'This is the demo, so nothing is really merged.';
const SIM_CARD_DISCARD = 'This is the demo, so nothing is really thrown away.';

// The repository's history, oldest first, in minutes before seedWorld(). Each line is a commit by the person, or
// (`merge`) the merge commit that joined an earlier agent's work into main (EARLIER_MERGES). The seeded agents start
// from whatever was newest on main when they started (SEED_WORLD's startedAgo), so their branches leave the trunk at
// different places; main moved on after each of them started.
const TRUNK = [
  { ago: 6 * DAY_MIN + 300, subject: 'Initial commit' },
  { ago: 6 * DAY_MIN + 120, subject: 'Add product list and product pages' },
  { ago: 6 * DAY_MIN + 10, subject: 'Add the cart, with quantities and a running total' },
  { ago: 5 * DAY_MIN + 200, subject: 'Set up the test runner and CI' },
  { ago: 5 * DAY_MIN + 40, subject: 'Add checkout with card payments' },
  { ago: 4 * DAY_MIN + 260, subject: 'Save orders and send an order confirmation email' },
  { ago: 4 * DAY_MIN + 90, subject: 'Add invoices and a CSV export' },
  { ago: 3 * DAY_MIN + 300, subject: 'Add help pages for getting started, billing and exports' },
  { ago: 3 * DAY_MIN + 150, subject: 'Add search across products and orders' },
  { ago: 3 * DAY_MIN + 20, subject: 'Show prices in local currencies' },
  { ago: 2 * DAY_MIN + 280, subject: 'Move the payment code into its own folder' },
  { ago: 2 * DAY_MIN + 130, subject: 'Add sign-up with email confirmation' },
  { ago: 2 * DAY_MIN + 10, subject: 'Add order history to the account page' },
  { ago: DAY_MIN + 250, subject: 'Fix the sign-up email link on small screens' },
  { ago: DAY_MIN + 120, subject: 'Cache product images for a day' },
  { ago: DAY_MIN + 15, subject: 'Bump Node to 22 in CI' },
  { ago: 300, subject: 'Add a staging deploy script' },
  { ago: 230, subject: 'Fix the cart badge count after removing an item' },
  { ago: 160, merge: 0 },
  { ago: 125, subject: 'Show the order number on the confirmation page' },
  { ago: 88, merge: 1 },
  { ago: 75, subject: 'Turn on the new search page for everyone' },
  { ago: 52, subject: 'Log slow checkout requests' },
  { ago: 40, subject: 'Update the billing help for annual plans' },   // Help pages changed docs/help/billing.md too
  { ago: 30, subject: 'Fix a typo in the order confirmation email' },
  { ago: 16, subject: 'Add alt text to product images' },
  { ago: 5, subject: 'Update the README for the new search page' },
];

// Two Claude Code agents from earlier today whose work was merged. Their folders and branches were tidied away after
// the merge, so they are not on the board: the graph shows them through their work and merge commits (and those
// commits' trailers). `says`: the agent's own summary, which became its work commit's body.
const EARLIER_MERGES = [
  { name: 'Payment retry', task: 'Retry a failed card payment once before showing an error', fromAgo: 280, workAgo: 170,
    says: 'A failed card payment is now tried once more before the customer sees an error.' },
  { name: 'New search page', task: 'Build the new search page with filters and instant results', fromAgo: 220, workAgo: 100,
    says: 'The new search page has filters and shows results as you type.' },
];

/** 40 hex characters made from text, like a git object id: the same text gives the same id. */
function hex40(text) {
  let out = '';
  for (let i = 0; i < 5; i++) out += hash32(`${i}:${text}`).toString(16).padStart(8, '0');
  return out;
}

/** The branch name part the engine makes from an agent's name (engine.mjs slugify): "workbench/<slug>-<id>". */
function slugify(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return s || 'task';
}

/** One line of plain text: no control, direction or zero-width characters, spaces collapsed. */
function oneLine(text) {
  return String(text ?? '').replace(/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A work commit's subject, made from the agent's task as the engine makes it: the first sentence (one ends before a
 * capital, so "e.g. the" does not end it), without a closing full stop, cut at a word boundary to at most 72
 * characters, its first letter capitalised. `name`: the agent's, for "Work by <name>" when the task gives nothing.
 */
export function subjectOf(task, name = 'an agent') {
  let t = oneLine(task);
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9“"'(]|$)/.exec(t);
  if (m) t = m[1];
  t = t.replace(/(?<!\.)\.$/, '').trim();
  if (t.length > 72) {
    const cut = t.slice(0, 73);
    const sp = cut.lastIndexOf(' ');
    t = (sp >= 24 ? cut.slice(0, sp) : t.slice(0, 72)).replace(/[\s,;:–—-]+$/, '');
  }
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t || `Work by ${oneLine(name) || 'an agent'}`;
}

/**
 * The messages Workbench writes (workspace.mjs mergeWork and discardWork). The work commit W: the subject, the agent's
 * own summary, then its trailers (Co-authored-by only for a Claude Code agent). The merge commit M: "Merge <Name>:
 * <subject>" and its trailers. The hidden copy kept when work is thrown away: "Thrown away: <branch>".
 */
function workMessage({ subject, body, agentId, harness }) {
  const lines = [subject, ''];
  const said = oneLine(body);
  if (said && !/^[A-Za-z0-9-]+\s*:/.test(said)) lines.push(said, '');   // never a line that could pass for a trailer
  lines.push(`Workbench-Agent: ${agentId}`, 'Workbench-Kind: work');
  if (harness === 'claude') lines.push(CLAUDE_TRAILER);
  return `${lines.join('\n')}\n`;
}

function mergeMessage({ name, subject, agentId }) {
  return `Merge ${oneLine(name)}: ${subject}\n\nWorkbench-Agent: ${agentId}\nWorkbench-Kind: merge\n`;
}

function discardMessage({ branch, agentId }) {
  return `Thrown away: ${branch}\n\nWorkbench-Agent: ${agentId}\nWorkbench-Kind: discarded\n`;
}

/**
 * What gitGraph reads from a commit's own trailers, never from its subject: `agentId` from the last Workbench-Agent
 * (when it is a valid agent id), `kind` from the last Workbench-Kind ('merge' needs two parents too; anything else is
 * 'commit'). Trailers are the lines of the message's last paragraph, after its subject, each "Key: value".
 */
function trailersOf(message, parents) {
  const paras = String(message ?? '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/);
  const last = paras.length > 1 ? paras[paras.length - 1].split('\n') : [];
  const lines = last.length && last.every(l => /^[A-Za-z0-9-]+[ \t]*:/.test(l)) ? last : [];
  const valueOf = key => {
    let v = '';
    for (const l of lines) {
      const m = /^([A-Za-z0-9-]+)[ \t]*:(.*)$/.exec(l);
      if (m && m[1].toLowerCase() === key) v = m[2].trim();
    }
    return v;
  };
  const agent = valueOf('workbench-agent');
  const word = valueOf('workbench-kind');
  return {
    agentId: AGENT_ID_RE.test(agent) ? agent : null,
    kind: word === 'merge' && parents.length > 1 ? 'merge' : word === 'work' ? 'work' : 'commit',
  };
}

/** Git keeps a commit's time in whole seconds. */
const toSeconds = ms => Math.floor(ms / 1000) * 1000;

function joinAnd(list) {
  const a = list.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const copyOf = (x) => (x == null ? x : structuredClone(x));

/**
 * The commits reachable from `tips`, newest first in topological order, the way `git log --topo-order` lists them:
 * no commit before all of its children, and a merged branch's commits right after the merge that joined them.
 */
function topoOrder(commits, tips) {
  const seen = new Set();
  const walk = [...tips];
  while (walk.length) {
    const id = walk.pop();
    if (seen.has(id) || !commits.has(id)) continue;
    seen.add(id);
    walk.push(...commits.get(id).parents);
  }
  const children = new Map([...seen].map(id => [id, 0]));
  for (const id of seen) for (const p of commits.get(id).parents) if (children.has(p)) children.set(p, children.get(p) + 1);
  // A stack: the newest tip first, then down each line until a commit still waits for another child.
  const stack = [...seen].filter(id => children.get(id) === 0).map(id => commits.get(id))
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1)).map(c => c.id);
  const out = [];
  while (stack.length) {
    const c = commits.get(stack.pop());
    out.push(c);
    for (const p of c.parents) {
      if (!children.has(p)) continue;
      const left = children.get(p) - 1;
      children.set(p, left);
      if (left === 0) stack.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Synthetic diffs. One unified diff per file, shaped like `git diff --no-ext-diff --no-textconv --no-color
// --no-renames` with core.quotePath=false, with exactly the added and removed line counts the agent's `files` list
// reports. The lines are made up, in the style of each kind of file, from the file's own name and folder. A new file is
// whole declarations (functions, tests, sections) in a sensible order; a changed file has one to three hunks, each a
// change inside one function, test or section, with the three unchanged lines above and below it as they would stand.

/** Names for made-up code, from a path: src/invoices/large-account.ts gives invoice, Invoice, largeAccount, ... */
function diffWords(path) {
  const parts = String(path).split('/');
  const file = parts[parts.length - 1];
  const stem = file.replace(/\.(test|spec)\.[^.]+$/, '').replace(/\.[^.]+$/, '');
  const split = s => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !/^\d+$/.test(w));
  // Folders that hold any kind of thing do not name it: migrations/0042_invoice_lookup_index.sql is about invoices.
  const containers = ['src', 'test', 'tests', 'lib', 'docs', 'app', 'db', 'schema', 'migrations', 'components', 'pages', 'routes', 'utils', 'helpers'];
  const dirs = parts.slice(0, -1).filter(d => !containers.includes(d.toLowerCase()));
  const stemWords = split(stem).length ? split(stem) : ['main'];
  const dirWord = split(dirs[dirs.length - 1] || '')[0] || stemWords[0];
  const one = w => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  const cap = w => w.charAt(0).toUpperCase() + w.slice(1);
  const noun = one(dirWord);
  const table = /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return {
    noun, Noun: cap(noun), table,
    thing: stemWords.map((w, i) => (i ? cap(w) : w)).join(''),
    Thing: stemWords.map(cap).join(''),
    THING: stemWords.join('_').toUpperCase(),
    topic: stemWords.join(' '), Title: cap(stemWords.join(' ')),
  };
}

// Placeholders that stand for a number: within one block (or one changed line) each keeps its value, so a test that
// makes 12 invoices expects 12 back.
const NUMBERS = new Set(['n', 'm']);

/**
 * Fill the {{name}} placeholders of some lines that belong together. A word may be a function: the next card of a
 * deck, or a number (kept for all of these lines). A card may hold placeholders of its own.
 */
function fillLines(lines, words) {
  const kept = {};
  return lines.map(line => {
    let out = String(line);
    for (let pass = 0; pass < 2 && out.includes('{{'); pass++) {
      out = out.replace(/\{\{(\w+)\}\}/g, (m, k) => {
        const v = words[k];
        if (typeof v !== 'function') return v == null ? m : String(v);
        if (!NUMBERS.has(k)) return String(v());
        if (!(k in kept)) kept[k] = v();
        return String(kept[k]);
      });
    }
    return out;
  });
}

const fillLine = (line, words) => fillLines([line], words)[0];

/** Cards from a list in a shuffled order, all of them before any comes again, never the same one twice in a row. */
function deck(list, rng) {
  let cards = [];
  let last;
  return () => {
    if (!cards.length) {
      cards = rng.shuffle(list);
      if (cards.length > 1 && cards[cards.length - 1] === last) [cards[0], cards[cards.length - 1]] = [cards[cards.length - 1], cards[0]];
    }
    last = cards.pop();
    return last;
  };
}

const VERBS = ['load', 'send', 'retry', 'group', 'count', 'sort', 'find', 'mark', 'split', 'check', 'build', 'save', 'queue', 'export'];
const BEHAVIOURS = ['handles an empty list', 'keeps the order it was given', 'sends them in small batches', 'gives up after one retry',
  'works for a large account', 'rounds the total to the cent', 'picks up a half-finished one', 'skips the ones already done',
  'stops when it is cancelled', 'counts each one once', 'leaves the others alone', 'says what went wrong'];
// Help text, before and after a rewrite in plain words.
const PROSE = [
  ['Navigate to the Billing section of the account dashboard to manage your subscription.', 'Open Billing to change your plan.'],
  ['Utilise the Export functionality to generate a CSV of your invoices.', 'To download your invoices, choose Export, then CSV.'],
  ['In the event that a payment fails, the system will reattempt the charge.', 'If a payment fails, we try again the next day.'],
  ['Prior to inviting team members, ensure that you possess administrator privileges.', 'You need to be an admin to invite people to your team.'],
  ['Upon successful registration, a verification email will be dispatched.', 'After you sign up, we send you an email to confirm your address.'],
  ['Exports exceeding 10,000 rows are processed asynchronously.', 'Big exports take a few minutes. We email you when yours is ready.'],
  ['Annual subscriptions are invoiced in advance for the full term.', 'Annual plans are paid up front for the whole year.'],
  ['Refunds are issued to the original payment instrument.', 'Refunds go back to the card you paid with.'],
  ['Users may modify their notification preferences at any time.', 'You can choose which emails you get, at any time.'],
  ['Data is retained for a period of 90 days following account closure.', 'We keep your data for 90 days after you close your account.'],
];
const MORE_PROSE = ['Your plan renews on the same day each month.', 'You can switch to a yearly plan at any time.',
  'Each invoice shows what you paid for, line by line.', 'Prices include tax where your country asks for it.',
  'You can download any invoice again from the Invoices page.', 'Changes to your plan start right away.',
  'If you downgrade, you keep the higher plan until the end of the month.', 'We send a receipt to the billing email after every payment.',
  'Your card is never stored on our servers.', 'Need a hand? Write to us and a person will answer.'];
const HEADINGS = ['## Before you start', '## Changing your plan', '## Downloading your invoices', '## If something goes wrong', '## Getting help'];
const COPY = [
  ['"welcome.title": "Welcome aboard",', '"welcome.title": "Welcome! Let us set up your shop",'],
  ['"welcome.body": "Complete the onboarding flow to activate your account.",', '"welcome.body": "Three short steps and your shop is ready.",'],
  ['"steps.profile": "Profile configuration",', '"steps.profile": "Tell us about your shop",'],
  ['"steps.payments": "Payment provider integration",', '"steps.payments": "Choose how you get paid",'],
  ['"steps.products": "Catalogue population",', '"steps.products": "Add your first products",'],
  ['"steps.done": "Onboarding complete",', '"steps.done": "You are all set",'],
  ['"button.next": "Proceed",', '"button.next": "Next",'],
  ['"button.back": "Return",', '"button.back": "Back",'],
  ['"button.skip": "Skip onboarding",', '"button.skip": "Skip for now",'],
  ['"errors.required": "This field is mandatory",', '"errors.required": "Please fill this in",'],
  ['"errors.email": "Invalid email format",', '"errors.email": "That email address does not look right",'],
  ['"hint.storeName": "Enter store designation",', '"hint.storeName": "The name your customers will see",'],
];
const NEW_COPY = ['"checklist.title": "Your first steps",', '"checklist.products": "Add a product",', '"checklist.payments": "Connect payments",',
  '"checklist.share": "Share your shop",', '"tips.photos": "Clear photos sell better",', '"tips.prices": "You can change prices later",',
  '"progress.label": "Step {step} of {total}",', '"skip.confirm": "You can finish this later from Settings",',
  '"done.title": "Your shop is ready",', '"done.body": "Share the link with your first customers.",',
  '"errors.network": "We could not save that. Try again in a moment.",', '"hint.currency": "Prices show in the currency of your customer",',
  '"tips.shipping": "Set your shipping prices before your first sale",', '"tips.tax": "We add tax for you where it applies",',
  '"checklist.domain": "Use your own web address",', '"checklist.logo": "Upload your logo",', '"done.cta": "Open my shop",',
  '"errors.storeName": "Pick a name with at least two letters",'];
// A copy file's lines in order, for the unchanged lines around a change.
const OLD_COPY_CONTEXT = ['"nav.home": "Home",', '"nav.products": "Products",', '"nav.orders": "Orders",', '"nav.customers": "Customers",',
  '"nav.help": "Help",', '"account.title": "Your account",', '"account.signOut": "Sign out",', '"footer.contact": "Contact us",',
  '"footer.terms": "Terms",', '"footer.privacy": "Privacy",'];

// A migration, step by step: what it adds, in order, and how each is taken back out. The first step is what the file
// is named for (an index to look rows up by account and date); the rest come in any order.
const SQL_STEPS = [
  { up: ['CREATE INDEX CONCURRENTLY IF NOT EXISTS {{table}}_account_id_created_at_idx', '  ON {{table}} (account_id, created_at);'],
    down: ['DROP INDEX CONCURRENTLY IF EXISTS {{table}}_account_id_created_at_idx;'] },
  { up: ['ALTER TABLE {{table}} ADD COLUMN IF NOT EXISTS batch_id uuid;'], down: ['ALTER TABLE {{table}} DROP COLUMN IF EXISTS batch_id;'] },
  { up: ['CREATE INDEX CONCURRENTLY IF NOT EXISTS {{table}}_batch_id_idx', '  ON {{table}} (batch_id) WHERE batch_id IS NOT NULL;'],
    down: ['DROP INDEX CONCURRENTLY IF EXISTS {{table}}_batch_id_idx;'] },
  { up: ['ALTER TABLE {{table}} ADD COLUMN IF NOT EXISTS sent_at timestamptz;'], down: ['ALTER TABLE {{table}} DROP COLUMN IF EXISTS sent_at;'] },
  { up: ['CREATE INDEX CONCURRENTLY IF NOT EXISTS {{table}}_status_idx', "  ON {{table}} (status) WHERE status <> 'sent';"],
    down: ['DROP INDEX CONCURRENTLY IF EXISTS {{table}}_status_idx;'] },
];
const SQL_NOTES = ['-- Large accounts look up {{table}} by account and date when they export.',
  '-- CONCURRENTLY keeps the table usable while each index is built.', '-- Safe to run again: every step checks first.',
  '-- Reviewed with the on-call engineer.'];

/** Exactly `n` lines of a migration: "-- Up", its steps, then "-- Down" undoing them in reverse order. */
function migrationLines(n, words, rng) {
  const steps = [SQL_STEPS[0], ...rng.shuffle(SQL_STEPS.slice(1))];
  const cost = list => 3 + list.reduce((s, x) => s + x.up.length + x.down.length, 0);   // with "-- Up", "" and "-- Down"
  const pick = [];
  for (const s of steps) if (cost([...pick, s]) <= n) pick.push(s);
  if (!pick.length) return fillLines(['-- Up', ...SQL_NOTES, ...SQL_NOTES].slice(0, n), words);
  let spare = n - cost(pick);
  const notes = rng.shuffle(SQL_NOTES);
  const lead = [];
  while (spare > 0 && notes.length && lead.length < 2) { lead.push(notes.pop()); spare--; }
  const up = [];
  pick.forEach((s, i) => {
    if (i && spare > 0) { up.push(''); spare--; }
    up.push(...s.up);
  });
  const rest = [...notes, ...SQL_NOTES];
  while (spare > 0) { lead.push(rest[(spare - 1) % rest.length]); spare--; }
  return fillLines(['-- Up', ...lead, ...up, '', '-- Down', ...pick.slice().reverse().flatMap(s => s.down)], words);
}

// Test names that fit what each kind of test checks. A test block is used at most once per name it has, so no two
// tests in a file share a name.
const TEST_NAMES = {
  testTotal: ['adds up the total', 'rounds the total to the cent', 'counts each one once'],
  testEmpty: ['handles an empty list', 'does nothing when there is nothing to do'],
  testStatus: ['marks each one done', 'picks up a half-finished one', 'skips the ones already done'],
  testBatch: ['works for a large account', 'sends them in small batches', 'keeps the order it was given'],
  testAbort: ['stops when it is cancelled', 'stops cleanly half-way'],
};
/** A block named from the list `name` (a deck of TEST_NAMES): it can come as often as that list has names. */
const named = (lines, name) => Object.assign(lines, { max: TEST_NAMES[name].length });

// Each kind of file.
// A new file: `head`, then whole `blocks` (and one-line `notes` where no block fits), then `foot`; `make`, when there,
// writes the whole file instead. `renames`: a block may come again under a new name (another test, another section).
// A changed file: in each hunk, three unchanged lines from `before` (or a run of `context`) above the change, the
// changed lines (`pairs` [old, new]), lines only added (`adds`, and `inner`: a few lines that go together), then three
// unchanged lines from `after`. `func` is what git puts after a hunk's @@: the line that opens the function, test or
// section the change is in (none where git usually finds nothing).
const KITS = {
  code: {
    head: ["import { db } from '../db/pool';", "import { log } from '../log';", "import type { {{Noun}} } from './types';", '',
      'export const {{THING}}_LIMIT = {{n}};', ''],
    foot: [],
    blocks: [
      ['export type {{Thing}}Options = {', '  limit?: number;', '  retries?: number;', '  signal?: AbortSignal;', '};'],
      ['export function is{{Thing}}Ready({{noun}}: {{Noun}}): boolean {', "  return {{noun}}.status === 'ready' && {{noun}}.total > 0;", '}'],
      ['export async function load{{Thing}}(accountId: string) {', '  const rows = await db.{{table}}.findMany({ where: { accountId } });',
        "  log.debug('{{topic}}: {{table}} loaded', { accountId, count: rows.length });", '  return rows;', '}'],
      ['export function to{{Noun}}Row({{noun}}: {{Noun}}) {', '  return {', '    id: {{noun}}.id,', '    total: {{noun}}.total,', '  };', '}'],
      ['export async function send{{Thing}}({{table}}: {{Noun}}[], size = {{THING}}_LIMIT) {', '  const sent = [];',
        '  for (let i = 0; i < {{table}}.length; i += size) {', '    sent.push(...(await save{{Noun}}Batch({{table}}.slice(i, i + size))));', '  }',
        '  return sent;', '}'],
      ['export async function list{{Thing}}ForAccount(account: Account, options: {{Thing}}Options = {}) {',
        '  if (options.signal?.aborted) return [];', '  const rows = await db.{{table}}.findMany({ where: { accountId: account.id }, take: options.limit });',
        '  return rows.map(to{{Noun}}Row);', '}'],
      ['function totalOf(rows: {{Noun}}[]): number {', '  return rows.reduce((sum, row) => sum + row.total, 0);', '}'],
      ['export class {{Thing}}Error extends Error {', '  constructor(message: string, readonly accountId: string) {', '    super(message);',
        "    this.name = '{{Thing}}Error';", '  }', '}'],
      ['export function chunk<T>(items: T[], size: number): T[][] {', '  const out: T[][] = [];',
        '  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));', '  return out;', '}'],
      ['async function withRetry<T>(work: () => Promise<T>, retries = 1): Promise<T> {', '  try {', '    return await work();', '  } catch (err) {',
        '    if (retries <= 0) throw err;', "    log.warn('{{topic}}: trying again', { err });", '    return withRetry(work, retries - 1);', '  }', '}'],
      ['export function sortByDate(rows: {{Noun}}[]): {{Noun}}[] {', '  return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());', '}'],
      ['export async function count{{Thing}}(accountId: string): Promise<number> {', '  return db.{{table}}.count({ where: { accountId } });', '}'],
      ['const DEFAULTS: {{Thing}}Options = {', '  limit: {{THING}}_LIMIT,', '  retries: 1,', '};'],
    ],
    notes: ['// Keep each batch small, so one slow {{noun}} cannot hold up the rest.', '// Safe to run twice: it skips the {{table}} that are already done.',
      '// Large accounts can have thousands of {{table}}.', '// Amounts are in cents, never in floats.', '// Times are in UTC everywhere in this file.',
      '// Each step is logged, so support can follow what happened.'],
    func: 'export async function {{verb}}{{Thing}}(accountId: string, options: {{Thing}}Options = {}) {',
    before: [
      ['  const started = Date.now();', "  log.debug('{{topic}} started', { accountId });", '  const rows = await db.{{table}}.findMany({ where: { accountId } });'],
      ['  if (!accountId) return [];', '  const limit = options.limit ?? 100;', ''],
      ['  const rows = await load{{Thing}}(accountId);', '  if (rows.length === 0) return [];', '  const total = totalOf(rows);'],
      ['  const account = await db.accounts.findUnique({ where: { id: accountId } });', "  if (!account) throw new {{Thing}}Error('No such account', accountId);", ''],
    ],
    after: [
      ['', "  log.info('{{topic}} done', { accountId, ms: Date.now() - started });", '  return rows;'],
      ['  await saveProgress(accountId, rows.length);', '  return rows.map(to{{Noun}}Row);', '}'],
      ['', '  return { sent, total };', '}'],
      ["  metrics.timing('{{topic}}', Date.now() - started);", '  return sent;', '}'],
    ],
    pairs: [
      ['  const rows = await db.{{table}}.findMany({ where: { accountId } });', '  const rows = await db.{{table}}.findMany({ where: { accountId }, take: limit });'],
      ['  if (rows.length === 0) return [];', '  if (rows.length === 0) return { sent: [], total: 0 };'],
      ["  log.info('{{topic}} done', { accountId });", "  log.info('{{topic}} done', { accountId, count: rows.length });"],
      ['  const total = rows.reduce((sum, row) => sum + row.amount, 0);', '  const total = roundToCents(rows.reduce((sum, row) => sum + row.amount, 0));'],
      ['  await save{{Noun}}(row);', '  await save{{Noun}}(row, { retry: 1 });'],
      ['  const started = Date.now();', '  const started = performance.now();'],
      ["  if (!{{noun}}) throw new Error('{{Noun}} not found');", "  if (!{{noun}}) throw new {{Thing}}Error('{{Noun}} not found', accountId);"],
      ['  return rows.map(to{{Noun}}Row);', '  return rows.filter(is{{Thing}}Ready).map(to{{Noun}}Row);'],
      ['  const limit = options.limit ?? 100;', '  const limit = options.limit ?? {{THING}}_LIMIT;'],
      ['  const sent = await send{{Thing}}(rows);', '  const sent = await send{{Thing}}(rows, limit);'],
      ['  const timeout = 30_000;', '  const timeout = 60_000;'],
      ["  log.debug('{{topic}} started', { accountId });", "  log.debug('{{topic}} started', { accountId, limit });"],
      ['  await sleep(1000);', '  await sleep(BATCH_PAUSE_MS);'],
    ],
    adds: ['  const batches = chunk(rows, limit);', "  log.info('{{topic}}: sending in batches', { accountId, batches: batches.length });",
      '  if (options.signal?.aborted) return { sent, stopped: true };', "  metrics.increment('{{topic}}.batches');",
      '  const retries = options.retries ?? 1;', '  // One slow {{noun}} no longer holds up the rest.', '  await sleep(BATCH_PAUSE_MS);',
      '  options.onProgress?.(sent.length, rows.length);', '  const startedAt = new Date();', '  const pending = rows.filter(row => !row.sentAt);',
      "  log.debug('{{topic}}: {{table}} loaded', { accountId, count: rows.length });", '  const sent = [];'],
    inner: [
      ['  for (const batch of batches) {', '    sent.push(...(await send{{Noun}}Batch(batch)));', '  }'],
      ['  if (options.signal?.aborted) {', "    log.info('{{topic}} stopped', { accountId, sent: sent.length });", '    return { sent, stopped: true };', '  }'],
      ['  try {', '    await save{{Noun}}Batch(pending);', '  } catch (err) {', "    log.warn('{{topic}}: a batch failed, trying once more', { accountId, err });",
        '    await save{{Noun}}Batch(pending);', '  }'],
      ['  const page = await db.{{table}}.findMany({', '    where: { accountId, createdAt: { gte: startedAt } },', "    orderBy: { createdAt: 'asc' },",
        '    take: limit,', '  });'],
      ['  if (rows.length > limit) {', "    log.info('{{topic}}: a large account', { accountId, count: rows.length });", '  }'],
    ],
  },
  test: {
    head: ["import { describe, it, expect, vi } from 'vitest';", "import { {{thing}}, make{{Noun}} } from './helpers/{{noun}}';", '', "describe('{{topic}}', () => {"],
    foot: ['});'],
    renames: true,
    blocks: [
      named(["  it('{{testTotal}}', async () => {", '    const result = await {{thing}}(make{{Noun}}({ total: {{n}} }));', '    expect(result.total).toBe({{n}});', '  });'], 'testTotal'),
      named(["  it('{{testEmpty}}', () => {", '    expect({{thing}}([])).toEqual([]);', '  });'], 'testEmpty'),
      named(["  it('{{testStatus}}', async () => {", "    const {{noun}} = make{{Noun}}({ status: 'pending' });", '    await {{thing}}([{{noun}}]);',
        "    expect({{noun}}.status).toBe('done');", '  });'], 'testStatus'),
      named(["  it('{{testBatch}}', async () => {", '    const account = makeAccount({ {{table}}: {{n}} });', '    const result = await {{thing}}(account);',
        '    expect(result.sent).toHaveLength({{n}});', '    expect(log.warn).not.toHaveBeenCalled();', '  });'], 'testBatch'),
      named(["  it('{{testAbort}}', async () => {", '    const result = await {{thing}}(makeAccount(), { signal: AbortSignal.abort() });',
        '    expect(result.stopped).toBe(true);', '  });'], 'testAbort'),
    ],
    notes: ['  // These run against an account with forty {{table}}.', '  // Uses the fake clock, so no test waits for real.',
      '  // Kept small, so a failure points at one thing.', '  // Slow on purpose: it checks the retry.'],
    func: "describe('{{topic}}', () => {",
    before: [
      ["  it('{{behaviour}}', async () => {", '    const account = makeAccount({ {{table}}: {{n}} });', '    const result = await {{thing}}(account);'],
      ["  it('{{behaviour}}', async () => {", "    const {{noun}} = make{{Noun}}({ status: 'pending' });", '    await {{thing}}([{{noun}}]);'],
      ["  it('{{behaviour}}', async () => {", '    vi.useFakeTimers();', '    const result = await {{thing}}(make{{Noun}}({ total: {{n}} }));'],
    ],
    after: [
      ['    expect(log.warn).not.toHaveBeenCalled();', '  });', ''],
      ['  });', '', "  it('{{behaviour}}', async () => {"],
      ["    expect({{noun}}.status).toBe('done');", '  });', ''],
    ],
    pairs: [
      ['    expect(result).toHaveLength({{n}});', '    expect(result).toHaveLength({{m}});'],
      ['    expect(result.total).toBe({{n}});', '    expect(result.total).toBeCloseTo({{m}}.1, 2);'],
      ["    const {{noun}} = make{{Noun}}({ status: 'pending' });", "    const {{noun}} = make{{Noun}}({ status: 'paid', paidAt: new Date() });"],
      ['    vi.useFakeTimers();', "    vi.useFakeTimers({ now: new Date('2026-01-01') });"],
      ['    await {{thing}}([{{noun}}]);', '    await {{thing}}([{{noun}}], { retries: 1 });'],
      ['    expect(result.sent).toHaveLength({{n}});', '    expect(result.sent).toHaveLength({{m}});'],
      ["    expect({{noun}}.status).toBe('done');", "    expect({{noun}}.status).toBe('sent');"],
    ],
    adds: ['    expect(log.warn).not.toHaveBeenCalled();', '    await vi.runAllTimersAsync();', '    expect(result.stopped).toBe(false);',
      '    expect(result.batches).toBeGreaterThan(1);', "    expect(log.info).toHaveBeenCalledWith('{{topic}} done', expect.anything());",
      '    expect(result.sent.every(x => x.sentAt)).toBe(true);'],
    inner: [
      ['    for (const batch of result.batches) {', '      expect(batch.length).toBeLessThanOrEqual({{n}});', '    }'],
      ['    await expect({{thing}}(account, { signal: AbortSignal.abort() }))', '      .resolves.toMatchObject({ stopped: true });'],
    ],
  },
  sql: {
    make: migrationLines,
    func: null,
    context: ['BEGIN;', '', '-- Up', '', 'COMMIT;', '', '-- Down', ''],
    pairs: [
      ['CREATE INDEX {{table}}_account_id_idx ON {{table}} (account_id);', 'CREATE INDEX {{table}}_account_id_idx ON {{table}} (account_id, created_at);'],
      ['ALTER TABLE {{table}} ADD COLUMN status text;', "ALTER TABLE {{table}} ADD COLUMN status text NOT NULL DEFAULT 'open';"],
      ['DROP INDEX {{table}}_account_id_idx;', 'DROP INDEX IF EXISTS {{table}}_account_id_idx;'],
    ],
    adds: ['ALTER TABLE {{table}} ADD COLUMN IF NOT EXISTS batch_id uuid;', '-- CONCURRENTLY keeps the table usable while each index is built.',
      'ALTER TABLE {{table}} ADD COLUMN IF NOT EXISTS sent_at timestamptz;'],
  },
  prose: {
    head: ['# {{Title}}', ''],
    foot: [],
    renames: true,
    blocks: [Object.assign(['{{heading}}', '', '{{more}}', '{{more}}'], { max: HEADINGS.length }),
      Object.assign(['1. Open Settings.', '2. Choose Billing.', '3. Pick a plan and press Save.'], { max: 1 }), ['- {{more}}', '- {{more}}', '- {{more}}']],
    notes: ['{{more}}'],
    func: '{{more}}',
    before: [
      ['## Before you start', '', 'This page is for shop owners.'],
      ['## Changing your plan', '', 'Your plan renews on the same day each month.'],
      ['## Downloading your invoices', '', 'Each invoice shows what you paid for, line by line.'],
      ['## If something goes wrong', '', 'Most problems clear up if you sign out and back in.'],
    ],
    after: [
      ['', '## Getting help', ''],
      ['', 'Questions? Write to help@storefront.example.', ''],
      ['', '## Your invoices', ''],
      ['', '## Your team', ''],
    ],
    pairs: PROSE,
    adds: MORE_PROSE,
    inner: [['', '{{heading}}', '', '{{more}}'], ['1. Open Settings.', '2. Choose Billing.', '3. Pick a plan and press Save.'],
      ['- {{more}}', '- {{more}}']],
  },
  json: {
    head: ['{'],
    foot: ['}'],
    blocks: [],
    notes: NEW_COPY.map(l => `  ${l}`),
    func: null,
    context: OLD_COPY_CONTEXT.map(l => `  ${l}`),
    pairs: COPY.map(p => p.map(l => `  ${l}`)),
    adds: NEW_COPY.map(l => `  ${l}`),
  },
  ui: {
    head: ["import { useState } from 'react';", "import { Button } from '../components/Button';", "import { t } from '../i18n';", '', 'export function {{Thing}}() {'],
    foot: ['}'],
    blocks: [
      ['  const [step, setStep] = useState(0);', '  const lastStep = steps.length - 1;'],
      ['  function next() {', '    setStep(Math.min(step + 1, lastStep));', '  }'],
      ['  return (', '    <section className="{{thing}}">', "      <h1>{t('{{noun}}.title')}</h1>", "      <p className=\"lead\">{t('{{noun}}.intro')}</p>",
        '    </section>', '  );'],
    ],
    notes: ['  // {{Title}} reads its words from the {{noun}} copy file.'],
    func: 'export function {{Thing}}() {',
    before: [
      ['  return (', '    <section className="{{thing}}">', "      <h1>{t('{{noun}}.title')}</h1>"],
      ['    <section className="{{thing}}">', "      <h1>{t('{{noun}}.title')}</h1>", "      <p className=\"lead\">{t('{{noun}}.intro')}</p>"],
      ["      <p className=\"lead\">{t('{{noun}}.intro')}</p>", '      <Progress step={step} />', "      <p>{t('{{noun}}.help')}</p>"],
    ],
    after: [
      ['    </section>', '  );', '}'],
      ["      <p>{t('{{noun}}.help')}</p>", '    </section>', '  );'],
      ["      <Button onClick={next}>{t('button.next')}</Button>", '    </section>', '  );'],
    ],
    pairs: [
      ["      <p className=\"lead\">{t('{{noun}}.intro')}</p>", "      <p className=\"lead muted\">{t('{{noun}}.intro')}</p>"],
      ["      <h1>{t('{{noun}}.title')}</h1>", "      <h1 id=\"{{thing}}-title\">{t('{{noun}}.title')}</h1>"],
      ["      <Button onClick={() => setStep(step + 1)}>{t('button.next')}</Button>", "      <Button onClick={next}>{t('button.next')}</Button>"],
      ["      <Button variant=\"link\" onClick={skip}>{t('button.skip')}</Button>", "      <Button variant=\"secondary\" onClick={skip}>{t('button.skip')}</Button>"],
      ["      <Link to=\"/search/v1\">{t('nav.search')}</Link>", "      <Link to=\"/search\">{t('nav.search')}</Link>"],
      ["      <p>{t('{{noun}}.help')}</p>", "      <p className=\"help\">{t('{{noun}}.help')}</p>"],
      ['      <Progress step={step} />', '      <Progress step={step} of={lastStep} />'],
      ['      <img src={hero} />', '      <img src={hero} alt="" />'],
    ],
    adds: ['      <Progress step={step} of={lastStep} />', '      {error && <p role="alert">{error}</p>}',
      "      <Button variant=\"secondary\" onClick={skip}>{t('button.skip')}</Button>", "      <p className=\"hint\">{t('{{noun}}.hint')}</p>",
      '      <Checklist items={checklist} />', "      <a href=\"/help/getting-started\">{t('{{noun}}.learnMore')}</a>"],
    inner: [
      ['      {step > 0 && (', "        <Button variant=\"link\" onClick={back}>{t('button.back')}</Button>", '      )}'],
      ['      <ol className="{{thing}}-steps">', '        {steps.map(s => <li key={s.id}>{t(s.title)}</li>)}', '      </ol>'],
    ],
  },
  css: {
    head: [],
    foot: [],
    blocks: [['.{{thing}} {', '  display: flex;', '  gap: 8px;', '}'], ['@media (max-width: 480px) {', '  .{{thing}} {', '    flex-direction: column;', '  }', '}']],
    notes: ['/* {{Title}} on small screens */', '/* Keep tap targets at least 44px tall. */', ''],
    func: null,
    before: [['.{{thing}} {', '  display: flex;', '  padding: 12px 16px;'], ['.{{thing}}-actions {', '  display: grid;', '  gap: 8px;']],
    after: [['  font-size: 14px;', '}', ''], ['  border-radius: 6px;', '}', '']],
    pairs: [['  gap: 8px;', '  gap: 12px;'], ['  display: grid;', '  display: flex;'], ['  padding: 12px;', '  padding: 8px 12px;'],
      ['  font-size: 13px;', '  font-size: 14px;']],
    adds: ['  flex-wrap: wrap;', '  min-height: 44px;', '  align-items: center;', '  justify-content: space-between;'],
  },
  text: {
    head: [],
    foot: [],
    blocks: [],
    notes: ['{{more}}'],
    func: null,
    context: ['', '{{Title}} notes'],
    pairs: PROSE,
    adds: MORE_PROSE,
  },
};

function kitFor(path) {
  const p = String(path).toLowerCase();
  if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/.test(p)) return KITS.test;
  if (/\.(tsx|jsx)$/.test(p)) return KITS.ui;
  if (/\.(ts|js|mjs|cjs)$/.test(p)) return KITS.code;
  if (/\.sql$/.test(p)) return KITS.sql;
  if (/\.(md|markdown|txt)$/.test(p)) return KITS.prose;
  if (/\.json$/.test(p)) return KITS.json;
  if (/\.(css|scss)$/.test(p)) return KITS.css;
  return KITS.text;
}

/**
 * Exactly `n` lines of whole blocks (a function, a test), a blank line after each, and single lines from `one()` where
 * no block fits. Each block comes once, unless the kit lets a block come again under a new name: then up to its `max`.
 */
function blockLines(n, kit, words, rng, one) {
  const out = [];
  const uses = new Map();
  let room = n;
  let last = null;
  while (room > 0) {
    const fits = room >= 3 ? (kit.blocks || []).filter(b => b.length <= room && b !== last) : [];
    const fresh = fits.filter(b => !uses.has(b));
    const again = kit.renames ? fits.filter(b => (uses.get(b) || 0) < (b.max ?? Infinity)) : [];
    const choice = fresh.length ? fresh : again;
    const block = choice.length ? rng.pick(choice) : null;
    if (!block) {
      out.push(fillLine(one(), words));
      room -= 1;
      continue;
    }
    uses.set(block, (uses.get(block) || 0) + 1);
    last = block;
    out.push(...fillLines(block, words));
    room -= block.length;
    if (room > 1) { out.push(''); room -= 1; }
  }
  return out;
}

/** Exactly `n` lines added inside a function, test or section: single lines, and a few lines that go together. */
function innerLines(n, kit, words, rng, one, used) {
  const out = [];
  let room = n;
  while (room > 0) {
    const fits = (kit.inner || []).filter(b => b.length <= room && !used.has(b));
    if (fits.length && room >= 2 && rng.chance(0.6)) {
      const block = rng.pick(fits);
      used.add(block);
      out.push(...fillLines(block, words));
      room -= block.length;
    } else {
      out.push(fillLine(one(), words));
      room -= 1;
    }
  }
  return out;
}

/** Exactly `n` lines of a new file of this kind. */
function newFileLines(n, kit, words, rng) {
  if (kit.make) return kit.make(n, words, rng);
  const framed = n >= kit.head.length + kit.foot.length + 2;
  const head = framed ? kit.head : [];
  const foot = framed ? kit.foot : [];
  const body = blockLines(n - head.length - foot.length, kit, words, rng, deck(kit.notes, rng));
  return [...fillLines(head, words), ...body, ...fillLines(foot, words)];
}

/** `@@` ranges leave out a count of 1, as git does. */
const hunkRange = (start, len) => (len === 1 ? `${start}` : `${start},${len}`);

/**
 * A unified diff of one file, for `workDiff`'s `patch`. status 'added' is a new file of `adds` lines, 'deleted' a file
 * of `dels` lines taken out; 'modified' has one to three hunks with three lines of context around them, `dels` lines
 * taken out and `adds` put in. `origin` ({ key, lines }), for a file deleted after it was added and merged: the key its
 * diff had then, so that the lines (and the blob) taken out are the ones that were put in.
 */
function syntheticPatch({ path, status, adds, dels, key, origin = null }) {
  const [k, s, a, d] = status === 'deleted' && origin && origin.lines === dels ? [origin.key, 'added', dels, 0] : [key, status, adds, dels];
  const rng = new Rng(`diff:${k}:${path}:${s}:${a}:${d}`);
  const kit = kitFor(path);
  const words = {
    ...diffWords(path), n: () => rng.int(3, 48), m: () => rng.int(3, 48),
    verb: deck(VERBS, rng), behaviour: deck(BEHAVIOURS, rng), more: deck(MORE_PROSE, rng), heading: deck(HEADINGS, rng),
    ...Object.fromEntries(Object.entries(TEST_NAMES).map(([name, list]) => [name, deck(list, rng)])),
  };
  const blob = (side) => hex40(`blob:${k}:${path}:${a}:${d}:${side}`).slice(0, 7);
  const out = [`diff --git a/${path} b/${path}`];
  if (status === 'added') {
    const lines = newFileLines(adds, kit, words, rng);
    out.push('new file mode 100644', `index 0000000..${blob('new')}`, '--- /dev/null', `+++ b/${path}`);
    if (lines.length) out.push(`@@ -0,0 +${hunkRange(1, lines.length)} @@`, ...lines.map(l => `+${l}`));
    return `${out.join('\n')}\n`;
  }
  if (status === 'deleted') {
    const lines = newFileLines(dels, kit, words, rng);
    out.push('deleted file mode 100644', `index ${blob(s === 'added' ? 'new' : 'old')}..0000000`, `--- a/${path}`, '+++ /dev/null');
    if (lines.length) out.push(`@@ -${hunkRange(1, lines.length)} +0,0 @@`, ...lines.map(l => `-${l}`));
    return `${out.join('\n')}\n`;
  }
  out.push(`index ${blob('old')}..${blob('new')} 100644`, `--- a/${path}`, `+++ b/${path}`);
  const total = adds + dels;
  const count = Math.max(1, Math.min(total > 30 ? 3 : total > 10 ? 2 : 1, total));
  // Spread the changes over the hunks so that each one changes something: added lines from the first hunk on,
  // removed lines from the last hunk back.
  const share = (n, i, fromEnd) => Math.floor(n / count) + ((fromEnd ? i >= count - (n % count) : i < n % count) ? 1 : 0);
  // The unchanged lines above and below each change: three as they stand around a change in a function (`before`,
  // `after`), or else the next run of the kit's `context`, in its order.
  let at = rng.int(0, (kit.context || ['']).length - 1);
  const run = () => fillLines([0, 1, 2].map(() => kit.context[at++ % kit.context.length]), words);
  const above = kit.before ? (d => () => fillLines(d(), words))(deck(kit.before, rng)) : run;
  const below = kit.after ? (d => () => fillLines(d(), words))(deck(kit.after, rng)) : run;
  const pair = deck(kit.pairs, rng);
  const added = deck(kit.adds, rng);
  const used = new Set();   // what this file already added, so no hunk adds the same lines again
  let near = [];            // the unchanged lines of the hunk being written
  const gone = new Set();   // the lines this file already changed
  const changed = () => {
    for (let k = 0; ; k++) {
      const [before, after] = fillLines(pair(), words);
      const fresh = before !== after && !near.includes(before) && !near.includes(after) && !gone.has(before);
      if (fresh || k >= 2 * kit.pairs.length) {
        gone.add(before);
        return [before, after];
      }
    }
  };
  let oldAt = rng.int(4, 28);
  let shift = 0;
  for (let i = 0; i < count && total > 0; i++) {
    const a = share(adds, i, false);
    const d = share(dels, i, true);
    const top = above();
    const bottom = below();
    near = [...top, ...bottom];
    const pairs = Array.from({ length: Math.min(a, d) }, changed);
    const removed = [...pairs.map(p => p[0]), ...Array.from({ length: d - pairs.length }, () => changed()[0])];
    const put = [...pairs.map(p => p[1]), ...innerLines(a - pairs.length, kit, words, rng, added, used)];
    const func = kit.func ? ` ${fillLine(kit.func, words)}` : '';
    const oldLen = top.length + d + bottom.length;
    const newLen = top.length + a + bottom.length;
    out.push(`@@ -${hunkRange(oldAt, oldLen)} +${hunkRange(oldAt + shift, newLen)} @@${func}`);
    for (const l of top) out.push(` ${l}`);
    for (const l of removed) out.push(`-${l}`);
    for (const l of put) out.push(`+${l}`);
    for (const l of bottom) out.push(` ${l}`);
    shift += a - d;
    oldAt += oldLen + rng.int(6, 40);   // the next hunk is further down the file
    at += rng.int(1, 4);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const PLAN_CODES = { x: 'completed', '>': 'in_progress', '.': 'pending' };

function uuid(rng) {
  return `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-${rng.pick(['8', '9', 'a', 'b'])}${rng.hex(3)}-${rng.hex(12)}`;
}

function sameStep(x, y) {
  return !!x && !!y && x.tool === y.tool && JSON.stringify(x.input) === JSON.stringify(y.input);
}

export class Simulator {
  /**
   * @param {object} [opts]
   * @param {(event: object) => void} [opts.emit]  receives every normalized event; read at call time, so it may be replaced
   * @param {(() => number)|number} [opts.now]       a clock (ms epoch), or a fixed start time advanced only by tick(now)
   * @param {number} [opts.speed]                    simulated time per real time; 0 pauses
   * @param {number|string} [opts.seed]              same seed, same world
   * @param {number} [opts.maxTickMs]                longest real gap one tick will simulate (after a laptop sleep, say)
   */
  constructor({ emit, now, speed = 1, seed = 1, log, maxTickMs = 10_000 } = {}) {
    this.harness = harness;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.speed = Number.isFinite(speed) && speed >= 0 ? speed : 1;
    this.seed = seed;
    this.maxTickMs = maxTickMs;
    this.log = log || null;
    if (typeof now === 'function') this._clock = now;
    else if (typeof now === 'number') this._clock = () => this._real;
    else this._clock = Date.now;
    this._real = typeof now === 'number' ? now : this._clock();
    this._sim = 0;           // simulated ms since construction
    this._timers = [];       // { at, seq, fn }, sorted by at then seq
    this._seq = 0;
    this._ts = null;         // timestamp to stamp on events: set while replaying a timer or writing history
    this._advancing = false;
    this._buffer = null;     // collects events while the seeded history is written
    this._agents = new Map();
    this._answered = new Set();
    this._rng = new Rng(`world:${seed}`);
    this._askSeq = 0;
    this._seeded = null;
    this._git = null;        // the demo's git repository, made by seedWorld() or on first use (_gitWorld)
  }

  /** Same as the module's available(): the instance stands in for an adapter module. */
  async available() { return available(); }

  setSpeed(speed) {
    if (Number.isFinite(speed) && speed >= 0) this.speed = speed;
  }

  /** Advance simulated time to match `now` (real ms). The engine calls this about once a second. */
  tick(now) {
    this._advance(typeof now === 'number' && Number.isFinite(now) ? now : this._clock());
  }

  /** Ids of every simulated agent and helper. */
  agentIds() { return [...this._agents.keys()]; }

  has(agentId) { return this._agents.has(agentId); }

  // ---- time ----

  _now() { return Math.max(this._clock(), this._real); }

  /** Catch up with the clock before acting on a call from outside, so timestamps stay in order. */
  _sync() { this._advance(this._clock()); }

  _advance(now) {
    if (this._advancing || !(now > this._real)) return;   // re-entrant call from an emit handler, or no time passed
    const dtReal = Math.min(now - this._real, this.maxTickMs);
    this._real = now;
    const speed = this.speed;
    if (!(speed > 0)) return;
    const realBase = now - dtReal;
    const simStart = this._sim;
    const simEnd = simStart + dtReal * speed;
    this._advancing = true;
    try {
      let guard = 0;
      while (this._timers.length && this._timers[0].at <= simEnd && guard++ < 100_000) {
        const t = this._timers.shift();
        this._sim = Math.max(this._sim, t.at);
        this._ts = Math.min(now, Math.round(realBase + (this._sim - simStart) / speed));
        try { t.fn(); } catch (err) { this._warn(err); }
      }
    } finally {
      this._sim = simEnd;
      this._ts = null;
      this._advancing = false;
    }
  }

  _after(delayMs, fn) {
    const t = { at: this._sim + Math.max(1, Math.round(delayMs)), seq: this._seq++, fn };
    let lo = 0, hi = this._timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this._timers[mid];
      if (m.at < t.at || (m.at === t.at && m.seq < t.seq)) lo = mid + 1; else hi = mid;
    }
    this._timers.splice(lo, 0, t);
  }

  /** Run `fn` with events stamped at time `t` (history writing). */
  _at(t, fn) {
    const prev = this._ts;
    this._ts = Math.round(t);
    try { return fn(); } finally { this._ts = prev; }
  }

  _warn(err) {
    const log = this.log;
    if (typeof log === 'function') log(err);
    else if (log && typeof log.warn === 'function') log.warn(err);
    else if (log && typeof log.error === 'function') log.error(err);
  }

  // ---- scripted processes ----
  // Each agent runs at most one generator. It yields a number (simulated ms to wait) or
  // { wait: 'answer' | 'helpers' | 'message' } to pause until the person or its helpers move it on.

  _run(a, gen) {
    const proc = { gen };
    a.proc = proc;
    a.waiting = null;
    this._step(a, proc, undefined);
  }

  _step(a, proc, value) {
    if (a.proc !== proc) return;
    let r;
    try { r = proc.gen.next(value); } catch (err) { a.proc = null; this._warn(err); return; }
    if (a.proc !== proc) return;            // it stopped or replaced itself
    if (r.done) { a.proc = null; return; }
    if (typeof r.value === 'number') this._after(r.value, () => this._step(a, proc, undefined));
    else a.waiting = r.value || { wait: 'message' };
  }

  _resume(a, value) {
    if (!a.proc || !a.waiting) return false;
    a.waiting = null;
    this._step(a, a.proc, value);
    return true;
  }

  // ---- events ----

  _ev(a, kind, fields = {}) {
    let ts = this._ts ?? this._now();
    if (!this._buffer && a.lastTs != null && ts < a.lastTs) ts = a.lastTs;   // never go back in time per agent
    const ev = { kind, ts, agentId: a.id, ...fields };
    ev.kind = kind;   // a field must never replace the event's kind
    if (kind === EV.SAYS && typeof ev.text === 'string') a.says = ev.text;   // its own summary, for its work commit
    if (this._buffer) { this._buffer.push(ev); return ev; }
    a.lastTs = ts;
    this._deliver(a, ev);
    return ev;
  }

  _deliver(a, ev) {
    const target = (a && a.emitTo) || this.emit;
    try { target(ev); } catch (err) { this._warn(err); }
  }

  // ---- agents ----

  _agent({ id, parentId = null, rootId = null, name, task = '', kind = 'agent', machineId = 'laptop', model = null,
    helperType = null, budgetUsd = null, emitTo = null, harnessName = 'sim', costScale = 1, rngKey = null }) {
    const a = {
      id, parentId, rootId: rootId || id, name, task, kind, machineId, model, helperType, budgetUsd, emitTo,
      harness: harnessName, costScale,
      rng: new Rng(`${this.seed}:${rngKey || id}`),
      state: kind === 'helper' ? STATE.WORKING : STATE.STARTING,
      phase: 'new',        // roots: new | working | asking | waiting_helpers | idle | stopped | failed
      turns: 0, cost: 0, context: 0,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },   // own
      session: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },  // roots: own + helpers
      plan: [], files: new Map(), helpers: [], hints: [],
      proc: null, waiting: null, pendingAsk: null, openTool: null, lastSentence: null, lastAnswer: null, lastTs: null,
      sessionId: null, script: null, lastFinal: null,
      checkNames: null,    // checks reported before each final turn end, if the "repo" declares any
      // What the person sees after the engine decides a turn (see _shownState), and what a merge card says about it.
      checks: 'none', checkResults: [], rules: null, closedFrom: null,
      // Its pretend git: the branch and where it stands (see "the demo's git repository"); for roots that have one.
      git: null,
      created: new Set(),  // paths its work added as new files since its unmerged work began: their diff is all new lines
      deleted: new Set(),  // paths its work took out that were there when its unmerged work began
      paths: new Set(),    // every path it has changed, kept after a merge empties `files`
      lines: new Map(),    // path -> { lines, key }: the files it added and merged, and what taking one out again removes
      says: null,          // the last thing it said to the person: the body of its work commit
    };
    this._agents.set(id, a);
    return a;
  }

  _root(a) { return this._agents.get(a.rootId) || a; }

  _helpersOf(root) { return root.helpers.map(id => this._agents.get(id)).filter(Boolean); }

  _workingHelpers(root) { return this._helpersOf(root).filter(h => h.state === STATE.WORKING).length; }

  // ---- steps: tool calls, thinking, usage, files, plans ----

  _toolStart(a, tool, input, { auto = true } = {}) {
    const { sentence, kind } = narrate(tool, input);
    const t = { id: 'toolu_' + a.rng.hex(20), tool, input, sentence, kind };
    this._ev(a, EV.ACTIVITY, { sentence, toolKind: kind, toolUseId: t.id, phase: 'start' });
    // Real Claude Code agents ask the engine before every tool call; safe ones are allowed automatically.
    if (auto && a.harness !== 'codex') this._ev(a, EV.APPROVAL, { how: 'auto', decision: 'allow', sentence });
    this._charge(a);
    a.openTool = t;
    a.lastSentence = sentence;
    return t;
  }

  _toolEnd(a, t, ok = true) {
    if (!t) return;
    this._ev(a, EV.ACTIVITY, { sentence: t.sentence, toolKind: t.kind, toolUseId: t.id, phase: 'end', ok: !!ok });
    if (a.openTool === t) a.openTool = null;
    if (ok && (t.tool === 'Edit' || t.tool === 'Write') && t.input?.file_path) this._fileChanged(a, t.tool, t.input.file_path);
  }

  _think(a) { this._ev(a, EV.THINKING, { on: true }); }

  /** Tokens and cost for one model call. The root's cost includes its helpers', like Claude Code's session cost. */
  _charge(a) {
    const root = this._root(a);
    const r = a.rng;
    if (a === root) {
      root.context = root.context ? root.context + r.int(250, 1400) : r.int(16_000, 22_000);
      if (root.context > COMPACT_AT) root.context = r.int(38_000, 52_000);   // compacted, as long sessions are
    } else {
      a.context = a.context ? a.context + r.int(200, 900) : r.int(9_000, 14_000);
    }
    const u = { inputTokens: r.int(6, 14), outputTokens: r.int(40, 520), cacheReadTokens: a.context, cacheWriteTokens: r.int(150, 1400) };
    const rate = RATES[familyOf(a.model || root.model)];
    let delta = (u.inputTokens * rate.in + u.outputTokens * rate.out + u.cacheReadTokens * rate.read + u.cacheWriteTokens * rate.write) / 1e6;
    delta *= root.costScale / (1 + Math.max(0, root.cost - 1));   // spending slows past a dollar, keeping long demos believable
    for (const k of Object.keys(u)) { a.tokens[k] += u[k]; root.session[k] += u[k]; }
    root.cost += delta;
    const costUsd = root.harness === 'codex' ? null : round4(root.cost);
    let costEv;
    if (a === root) {
      costEv = this._ev(a, EV.USAGE, { ...u, costUsd, contextTokens: root.context, contextWindow: CONTEXT_WINDOW, mode: 'add' });
    } else {
      this._ev(a, EV.USAGE, { ...u, mode: 'add' });
      costEv = this._ev(root, EV.USAGE, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, mode: 'add' });
    }
    if (this._buffer && costEv && costUsd !== null) costEv._costDelta = delta;   // recomputed in time order after seeding
  }

  _fileChanged(a, tool, path) {
    const root = this._root(a);
    const r = a.rng;
    const f = root.files.get(path) || { path, adds: 0, dels: 0 };
    if (tool === 'Write' && !root.files.has(path)) {
      const n = r.int(14, 72);
      f.adds += /\.sql$/i.test(path) ? 6 + (n % 9) : n;   // a migration is short
      if (!root.paths.has(path)) root.created.add(path);   // a file its work adds, not one it rewrote
    } else {
      const adds = r.int(2, 18);
      const dels = r.int(0, 9);
      root.deleted.delete(path);   // written again after it was taken out: it is back, changed
      // A file its work added is all new lines in its diff, however often it was edited since.
      if (root.created.has(path)) f.adds += adds;
      else { f.adds += adds; f.dels += dels; }
    }
    root.files.set(path, f);
    root.paths.add(path);
    if (!this._buffer) this._emitFiles(root);   // history writes one files event at the end instead
  }

  /** What the agent changed and has not merged: the `files` of its view. */
  _filesOf(root) {
    const list = [...root.files.values()].map(f => ({ ...f }));
    return {
      changed: list.length,
      adds: list.reduce((s, f) => s + f.adds, 0),
      dels: list.reduce((s, f) => s + f.dels, 0),
      list,
    };
  }

  _emitFiles(root) {
    return this._ev(root, EV.FILES, { files: this._filesOf(root) });
  }

  _emitPlan(a) { this._ev(a, EV.PLAN, { items: a.plan.map(p => ({ ...p })) }); }

  _planCodes(a, codes) {
    a.plan = a.plan.map((p, i) => ({ ...p, status: PLAN_CODES[codes[i]] || p.status }));
  }

  /** Finish the step in progress and start the next. Returns false when nothing was left to start. */
  _planAdvance(a) {
    const plan = a.plan.map(p => ({ ...p }));
    const cur = plan.findIndex(p => p.status === 'in_progress');
    if (cur >= 0) plan[cur].status = 'completed';
    const next = plan.findIndex(p => p.status === 'pending');
    if (next >= 0) plan[next].status = 'in_progress';
    a.plan = plan;
    return next >= 0;
  }

  _planAllDone(a) { a.plan = a.plan.map(p => ({ ...p, status: 'completed' })); }

  _durFor(a, t) {
    const r = a.rng;
    switch (t.kind) {
      case 'read': return r.between(600, 2200);
      case 'search': return r.between(800, 2600);
      case 'edit': return r.between(1200, 3600);
      case 'run': return isTestCommand(t.input) ? r.between(3500, 8000) : r.between(1500, 4000);
      case 'plan': return r.between(250, 700);
      case 'helper': return r.between(500, 1200);
      case 'web': return r.between(2000, 4500);
      default: return r.between(600, 1500);
    }
  }

  // ---- live step generators ----

  /** One tool call: maybe a thinking blip, the call, its result, a short pause. */
  *_doTool(a, step) {
    if (this._overBudget(a)) { this._budgetStop(this._root(a)); yield 1; return; }
    if (a.rng.chance(step.think ?? 0.35)) { this._think(a); yield a.rng.between(700, 2000); }
    const t = this._toolStart(a, step.tool, step.input);
    yield this._durFor(a, t);
    this._toolEnd(a, t, step.ok !== false);
    yield a.rng.between(500, 1800);
  }

  /** A plan update, the way Claude Code does it: a TodoWrite (or TaskCreate) call, then the new plan. */
  *_doPlan(a, change, tool = 'TodoWrite', input = {}) {
    if (this._overBudget(a)) { this._budgetStop(this._root(a)); yield 1; return; }
    const t = this._toolStart(a, tool, input);
    yield a.rng.between(250, 600);
    change(a);
    this._emitPlan(a);
    this._toolEnd(a, t, true);
    yield a.rng.between(400, 1200);
  }

  /**
   * Declared checks, reported as the engine's receipt would: running, then each result.
   * In the demo there is no workspace, so the engine decides "done and checked" from these.
   */
  *_doChecks(a) {
    const names = a.checkNames || [];
    if (!names.length) return;
    this._ev(a, EV.CHECKS, { checks: { state: 'running', results: [] } });
    const results = [];
    for (const name of names) {
      const ms = Math.round(a.rng.between(1500, 4000));
      yield ms;
      results.push({ name, ok: true, ms });
      const state = results.length === names.length ? 'passed' : 'running';
      this._ev(a, EV.CHECKS, { checks: { state, results: results.map(r => ({ ...r })) } });
    }
    a.checks = results.every(r => r.ok) ? 'passed' : 'failed';
    a.checkResults = results.map(r => ({ ...r }));
  }

  *_doSteps(a, steps) {
    for (const s of steps) {
      const step = stepOf(s);
      if (step.plan) yield* this._doPlan(a, x => this._planCodes(x, step.plan));
      else yield* this._doTool(a, step);
    }
  }

  /** Hand work to a helper (an Agent tool call), then let the helper run on its own. */
  *_doSpawn(root, job) {
    if (this._overBudget(root)) { this._budgetStop(root); yield 1; return null; }
    const t = this._toolStart(root, 'Agent', { description: job.description, subagent_type: job.type });
    yield root.rng.between(400, 900);
    const h = this._createHelper(root, job);
    this._toolEnd(root, t, true);   // "Async agent launched": the helper keeps going in the background
    this._run(h, this._helperProc(h, job));
    yield root.rng.between(500, 1500);
    return h;
  }

  _createHelper(root, job) {
    let id;
    do { id = `${root.id}-${root.rng.hex(8)}`; } while (this._agents.has(id));
    const h = this._agent({
      id, parentId: root.id, rootId: root.id, name: nameFromTask(job.description), task: job.description, kind: 'helper',
      machineId: root.machineId, model: job.model || (job.type === 'Explore' ? HAIKU : root.model), helperType: job.type,
      emitTo: root.emitTo, harnessName: root.harness, rngKey: id,
    });
    root.helpers.push(id);
    // No `kind` field: it would overwrite the event's own kind. The store derives 'helper' from parentId.
    this._ev(h, EV.CREATED, {
      parentId: root.id, name: h.name, task: h.task, harness: h.harness,
      helperType: h.helperType, model: h.model, machineId: h.machineId,
    });
    this._ev(h, EV.STATE, { state: STATE.WORKING });
    return h;
  }

  *_helperProc(h, job) {
    yield h.rng.between(800, 2000);   // a moment to read its instructions
    for (const s of job.steps) yield* this._doTool(h, stepOf(s));
    this._endHelper(h, STATE.FINISHED, job.summary);
  }

  /** A helper ends: finished its part, or stopped. A root waiting on its helpers carries on after the last one. */
  _endHelper(h, state, summary) {
    if (ENDED.has(h.state)) return;
    h.proc = null;
    h.waiting = null;
    if (h.openTool) this._toolEnd(h, h.openTool, false);
    if (summary && state === STATE.FINISHED) this._ev(h, EV.SAYS, { text: firstSentence(summary) });
    h.state = state;
    this._ev(h, EV.STATE, { state });
    this._ev(h, EV.ENDED, { outcome: state === STATE.FINISHED ? 'ok' : state === STATE.STOPPED ? 'stopped' : 'error' });
    const root = this._agents.get(h.rootId);
    if (root && root.waiting?.wait === 'helpers' && this._workingHelpers(root) === 0) this._resume(root, undefined);
  }

  // ---- turns and asks ----

  _turnStart(a) {
    a.turns += 1;
    this._ev(a, EV.MODEL, { model: a.model });
    this._ev(a, EV.SESSION, { sessionId: a.sessionId });
    this._ev(a, EV.TURN, { phase: 'start' });
    this._ev(a, EV.STATE, { state: STATE.WORKING });
    a.phase = 'working';
    // A new turn clears the last receipt (the store does the same), and a merge problem, as the engine does.
    a.checks = 'none';
    a.checkResults = [];
    a.rules = null;
    if (a.git && a.git.problem) {
      a.git.problem = null;
      this._emitWork(a);
    }
  }

  /** End a turn the way Claude Code's result message does. The engine decides the root's state from it. */
  _turnEnd(a, finalText, { backgroundTasks = 0, isError = false } = {}) {
    this._ev(a, EV.THINKING, { on: false });
    this._ev(a, EV.USAGE, {
      ...a.session, costUsd: a.harness === 'codex' ? null : round4(a.cost), contextTokens: a.context,
      contextWindow: CONTEXT_WINDOW, mode: 'set',
    });
    // What it changed and has not merged, as the engine's receipt records it when a turn ends in a real run (the store
    // clears it when a turn starts): without it a demo agent that took a second turn would end with no files.
    if (a.kind !== 'helper' && a.git) this._emitFiles(a);
    this._ev(a, EV.TURN, { phase: 'end', finalText, backgroundTasks, isError });
    a.lastFinal = finalText;
    if (!isError && !backgroundTasks) a.says = firstSentence(finalText) || a.says;   // what the engine shows it saying
    a.phase = isError ? 'failed' : backgroundTasks > 0 ? 'waiting_helpers' : 'idle';
  }

  _askId(a) {
    this._askSeq += 1;
    return `sim-${this._askSeq}-${a.rng.hex(6)}`;
  }

  /** An ask the simulator raises itself (permission or stuck, or a seeded question), then the matching state. */
  _raiseAsk(a, ask, state, reason) {
    const full = { id: this._askId(a), ...ask };
    a.pendingAsk = full;
    a.phase = 'asking';
    this._ev(a, EV.ASK, { ask: full });
    this._ev(a, EV.STATE, reason ? { state, reason } : { state });
    return full;
  }

  _overBudget(a) {
    const root = this._root(a);
    return root.harness !== 'codex' && root.budgetUsd > 0 && root.cost >= root.budgetUsd;
  }

  /** Like Claude Code's --max-budget-usd: the session ends with an error, and its helpers stop. */
  _budgetStop(root) {
    if (root.phase === 'failed' || root.phase === 'stopped') return;
    root.proc = null;
    root.waiting = null;
    for (const h of this._helpersOf(root)) if (h.state === STATE.WORKING) this._endHelper(h, STATE.STOPPED);
    if (root.openTool) this._toolEnd(root, root.openTool, false);
    this._turnEnd(root, `It stopped because it reached its budget of ${money(root.budgetUsd)}.`, { isError: true });
  }

  // ---- the seeded world ----

  /**
   * Emit the demo's starting world: six root agents with believable history, already in their stated states.
   * Returns the roots as [{ agentId, name, machineId, state }]. Calling it again emits nothing.
   */
  seedWorld() {
    if (this._seeded) return this._seeded.map(r => ({ ...r }));
    this._sync();
    const now = this._now();
    this._gitWorld(now);      // the repository's history first: each agent starts from what was newest on main then
    const live = [];          // [agent, generator] to start once the history is out
    const roots = [];
    const factors = new Map();
    let events;
    this._buffer = [];
    try {
      for (const spec of SEED_WORLD) roots.push(this._seedRoot(spec, now, live, factors));
    } finally {
      events = this._buffer;
      this._buffer = null;
    }
    // Out in time order. Cumulative cost is worked out in that order too, scaled to each root's target.
    events.sort((x, y) => x.ts - y.ts);
    const spent = new Map();
    for (const ev of events) {
      if (ev._costDelta !== undefined) {
        const c = (spent.get(ev.agentId) || 0) + ev._costDelta;
        spent.set(ev.agentId, c);
        ev.costUsd = round4(c * (factors.get(ev.agentId) ?? 1));
        delete ev._costDelta;
      }
      const a = this._agents.get(ev.agentId);
      if (a) a.lastTs = ev.ts;
    }
    for (const ev of events) this._deliver(this._agents.get(ev.agentId), ev);
    for (const [a, gen] of live) this._run(a, gen);
    this._seeded = roots.map(a => ({ agentId: a.id, name: a.name, machineId: a.machineId, state: a.state }));
    return this._seeded.map(r => ({ ...r }));
  }

  _seedRoot(spec, now, live, factors) {
    let id;
    do { id = this._rng.hex(6); } while (this._agents.has(id) || this._gitWorld().agentIds.has(id));
    const a = this._agent({
      id, name: spec.name, task: spec.task, machineId: spec.machineId, model: spec.model, harnessName: spec.harness || 'claude',
      budgetUsd: spec.budgetUsd, costScale: spec.costScale || 1, rngKey: `seed:${spec.name}`,
    });
    if (a.harness !== 'codex') a.checkNames = REPO_CHECKS;
    a.sessionId = uuid(a.rng);
    a.plan = spec.plan.map((text, i) => ({ id: String(i + 1), text, status: 'pending' }));
    const t0 = now - spec.startedAgo * MIN;
    const t1 = now - spec.endAgo * MIN;
    const working = spec.end === 'working';

    // What the engine emits for a root it launches, then the first turn.
    this._at(t0, () => {
      this._ev(a, EV.CREATED, {
        parentId: null, name: a.name, task: a.task, harness: a.harness, model: a.model,
        machineId: a.machineId, budgetUsd: a.budgetUsd, startedAt: t0,
      });
      this._ev(a, EV.STATE, { state: STATE.STARTING });
    });
    // Its own branch, from what was newest on main when it started, as the engine makes for a real agent.
    this._attachGit(a, this._gitBaseAt(t0), spec.git);
    this._at(t0, () => this._emitWork(a));
    this._at(t0 + 1500, () => this._turnStart(a));

    const jobs = (spec.helpers || []).map(h => this._seedJob(a, h));
    const steps = this._withFillers(a.rng, spec.steps.map(stepOf), spec.fill);
    const stepsEnd = working ? now - 2 * SEC : t1 - (spec.pending ? 15 : 25) * SEC;
    this._historySteps(a, steps, t0 + 4 * SEC, stepsEnd, (index, t) => {
      const job = jobs[index];
      const until = job.live ? now - 1500 : Math.min(t + job.minutes * MIN, t1 - 10 * SEC);
      const h = this._histSpawn(a, t, job, until);
      if (job.live) live.push([h, this._helperProc(h, { ...job, steps: job.more })]);
      return t + 900;
    });

    // Where it stands now.
    if (!working && spec.end !== 'done_checked' && spec.end !== 'done_claimed') this._at(t1 - 3 * SEC, () => this._emitFiles(a));
    switch (spec.end) {
      case 'permission': {
        // Claude Code shows the tool call first; the hook then holds it for the person.
        const step = stepOf(spec.pending);
        const pending = this._at(t1 - 1500, () => this._toolStart(a, step.tool, step.input, { auto: false }));
        const req = describeRequest(step.tool, step.input);
        this._at(t1, () => this._raiseAsk(a, {
          type: 'permission', sentence: `${a.name} ${req.sentence}`, detail: req.detail, why: whyAsk(step), options: ['Allow', 'Deny'], primary: 'Allow',
        }, STATE.NEEDS_OK));
        a.state = STATE.NEEDS_OK;
        live.push([a, this._afterCheckoutAsk(a, pending)]);
        break;
      }
      case 'question':
        this._at(t1 - 1000, () => this._ev(a, EV.SAYS, { text: spec.says }));
        this._at(t1, () => this._raiseAsk(a, { ...spec.ask, options: [...spec.ask.options] }, STATE.QUESTION));
        a.state = STATE.QUESTION;
        live.push([a, this._afterSearchAsk(a)]);
        break;
      case 'stuck':
        this._at(t1, () => this._raiseAsk(a, { ...spec.ask, options: [...spec.ask.options] }, STATE.MAYBE_STUCK, 'It hit the same error three times'));
        a.state = STATE.MAYBE_STUCK;
        live.push([a, this._afterFlakyAsk(a)]);
        break;
      case 'done_checked':
      case 'done_claimed': {
        // The receipt, in the order the engine builds one: files, rules, checks, then the state and what it says.
        const checked = spec.end === 'done_checked';
        this._at(t1, () => {
          this._emitFiles(a);
          if (spec.rules) this._ev(a, EV.RULES, { rules: structuredClone(spec.rules) });
          this._ev(a, EV.CHECKS, { checks: { state: checked ? 'running' : 'none', results: [] } });
        });
        const tDone = checked ? t1 + spec.checks.reduce((s, c) => s + c.ms, 0) + 2 * SEC : t1 + 500;
        this._at(tDone, () => {
          if (checked) this._ev(a, EV.CHECKS, { checks: { state: 'passed', results: spec.checks.map(c => ({ ...c })) } });
          this._ev(a, EV.STATE, { state: spec.end });
          this._ev(a, EV.SAYS, { text: spec.says });
        });
        a.state = spec.end;
        a.phase = 'idle';
        a.checks = checked ? 'passed' : 'none';
        a.checkResults = checked ? spec.checks.map(c => ({ ...c })) : [];
        a.rules = spec.rules ? structuredClone(spec.rules) : null;
        live.push([a, this._conversation(a, null)]);
        break;
      }
      default:   // working
        this._at(now - 500, () => this._emitFiles(a));
        a.state = STATE.WORKING;
        live.push([a, this._onboardingRoot(a)]);
    }

    if (spec.costUsd != null) {            // Codex reports no cost, so there is nothing to scale
      factors.set(a.id, spec.costUsd / (a.cost || spec.costUsd));
      a.cost = spec.costUsd;
    }
    return a;
  }

  _seedJob(a, h) {
    if (h.job !== undefined) {
      const base = ONBOARDING_JOBS[h.job];
      const steps = this._pickSteps(a.rng, base.pool, h.done);
      const left = base.type === 'Explore' ? a.rng.int(12, 24) : a.rng.int(30, 50);
      const more = this._pickSteps(a.rng, base.pool, left, steps[steps.length - 1]);
      return { ...base, steps, more, live: true };
    }
    return { ...h, steps: h.steps.map(stepOf), live: false };
  }

  _pickSteps(rng, pool, n, prev = null) {
    const out = [];
    let last = prev ? stepOf(prev) : null;
    for (let i = 0; i < n; i++) {
      let s, k = 0;
      do { s = stepOf(rng.pick(pool)); } while (sameStep(s, last) && ++k < 8);
      out.push(s);
      last = s;
    }
    return out;
  }

  /** Mix filler steps from a pool into a scripted history, never next to an identical step. */
  _withFillers(rng, steps, fill) {
    if (!fill) return steps;
    const out = steps.slice();
    let limit = Math.min(fill.before ?? out.length, out.length);
    for (let k = 0; k < fill.count; k++) {
      const pos = rng.int(1, limit);
      const s = stepOf(rng.pick(fill.pool));
      if (sameStep(out[pos - 1], s) || sameStep(out[pos], s)) continue;
      out.splice(pos, 0, s);
      limit += 1;
    }
    return out;
  }

  /** Write steps as past events spread between t0 and t1. Returns the time of the last one. */
  _historySteps(a, steps, t0, t1, onSpawn) {
    const n = steps.length;
    if (!n) return t0;
    const slot = Math.max(1000, (t1 - t0) / n);
    const room = Math.max(700, slot * 0.6);
    let cursor = t0;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      const t = Math.max(cursor + 400, t0 + slot * (i + 0.5) + a.rng.between(-0.3, 0.3) * slot);
      if (s.plan) cursor = this._histPlan(a, t, s.plan);
      else if (s.spawn !== undefined) cursor = onSpawn ? onSpawn(spawned++, t) : t;
      else cursor = this._histTool(a, t, s, room);
    }
    return cursor;
  }

  _histTool(a, t, step, room) {
    if (a.rng.chance(0.35)) this._at(t - Math.min(2500, room * 0.5), () => this._think(a));
    const tool = this._at(t, () => this._toolStart(a, step.tool, step.input));
    const end = t + Math.min(this._durFor(a, tool), room);
    this._at(end, () => this._toolEnd(a, tool, step.ok !== false));
    return end;
  }

  _histPlan(a, t, codes) {
    const tool = this._at(t, () => this._toolStart(a, 'TodoWrite', {}));
    this._at(t + 250, () => { this._planCodes(a, codes); this._emitPlan(a); });
    this._at(t + 500, () => this._toolEnd(a, tool, true));
    return t + 500;
  }

  _histSpawn(root, t, job, until) {
    const tool = this._at(t, () => this._toolStart(root, 'Agent', { description: job.description, subagent_type: job.type }));
    const h = this._at(t + 600, () => this._createHelper(root, job));
    this._at(t + 900, () => this._toolEnd(root, tool, true));
    const end = this._historySteps(h, job.steps, t + 2 * SEC, until - SEC);
    if (!job.live) this._at(Math.max(until, end + 500), () => this._endHelper(h, STATE.FINISHED, job.summary));
    return h;
  }

  // ---- what the seeded agents do once the person answers ----

  *_afterCheckoutAsk(a, pending) {
    const ans = yield { wait: 'answer', kind: 'permission' };
    if (ans.allow) {
      yield a.rng.between(2500, 4500);       // the command runs
      this._toolEnd(a, pending, true);
      yield a.rng.between(600, 1500);
      yield* this._doPlan(a, x => this._planAdvance(x));
      yield* this._doSteps(a, [['Bash', 'npm test -- checkout'], ['Read', 'src/checkout/checkout.ts'], ['Edit', 'src/checkout/checkout.ts'], ['Bash', 'npm test']]);
    } else {
      this._toolEnd(a, pending, false);      // denied: it tries another way
      this._think(a);
      yield a.rng.between(1500, 3000);
      yield* this._doSteps(a, [['Read', 'test/setup.ts'], ['Edit', 'test/setup.ts'], ['Bash', 'npm test -- checkout']]);
      yield* this._doPlan(a, x => this._planAdvance(x));
      yield* this._doSteps(a, [['Edit', 'src/checkout/checkout.ts'], ['Bash', 'npm test']]);
    }
    yield* this._doPlan(a, x => this._planAllDone(x));
    yield* this._doChecks(a);
    this._turnEnd(a, this._withHints(a, ans.allow
      ? 'I fixed the checkout bug: each order now keeps a resume token, so a customer can pick up a half-finished checkout where they left off. The checkout tests pass.'
      : 'I fixed the checkout bug without changing the shared test database: the tests now set up their own temporary copy. Each order keeps a resume token, so a half-finished checkout can be picked up again.'));
    yield* this._conversation(a, null);
  }

  *_afterSearchAsk(a) {
    const { text } = yield { wait: 'answer', kind: 'question' };
    this._turnStart(a);
    yield a.rng.between(800, 1600);
    this._think(a);
    yield a.rng.between(1200, 2500);
    const t = text.toLowerCase();
    const keep = /\bkeep\b/.test(t) && !/\bremove\b/.test(t);
    const remove = !keep && /\b(remove|delete|drop)\b/.test(t);
    let final;
    if (keep) {
      yield* this._doSteps(a, [['Read', 'src/routes/search.ts'], ['Edit', 'src/routes/search.ts'], ['Write', 'test/search/old-address.test.ts']]);
      yield* this._doPlan(a, x => this._planAdvance(x));
      yield* this._doSteps(a, [['Edit', 'src/search/legacy-search.ts'], ['Bash', 'npm test']]);
      final = 'I kept the old search address working: it now sends people to the new search page, and the rest of the old search code is gone. The tests pass.';
    } else if (remove) {
      yield* this._doSteps(a, [['Edit', 'src/routes/search.ts'], ['Edit', 'src/search/legacy-search.ts']]);
      yield* this._doPlan(a, x => this._planAdvance(x));
      yield* this._doSteps(a, [['Grep', 'legacySearch'], ['Bash', 'npm test']]);
      final = 'I removed the old search address along with the rest of the old search code. Old saved links now show the usual page-not-found screen, and the tests pass.';
    } else {
      yield* this._doSteps(a, [['Read', 'src/routes/search.ts'], ['Edit', 'src/routes/search.ts']]);
      yield* this._doPlan(a, x => this._planAdvance(x));
      yield* this._doSteps(a, [['Edit', 'src/search/index.ts'], ['Bash', 'npm test']]);
      final = 'I followed your answer and finished cleaning up the old search code. The tests pass.';
    }
    yield* this._doPlan(a, x => this._planAllDone(x));
    yield* this._doChecks(a);
    this._turnEnd(a, this._withHints(a, final));
    yield* this._conversation(a, null);
  }

  *_afterFlakyAsk(a) {
    const { text } = yield { wait: 'answer', kind: 'stuck' };   // "Stop it" never gets here
    const hinted = !!text && !KEEP_TRYING_RE.test(text);
    this._think(a);
    yield a.rng.between(1500, 3000);
    // Something different from the three failed attempts, and it works.
    yield* this._doSteps(a, hinted
      ? [['Read', 'src/money/round.ts'], ['Edit', 'src/cart/total.ts']]
      : [['Grep', 'roundToCents'], ['Read', 'src/money/round.ts'], ['Read', 'src/cart/total.ts'], ['Edit', 'src/cart/total.ts']]);
    yield* this._doTool(a, stepOf(['Bash', 'npm test -- cart/total']));
    yield* this._doPlan(a, x => this._planAdvance(x));
    yield* this._doTool(a, stepOf(['Bash', 'npm test -- cart/total --repeat 50']));
    yield* this._doPlan(a, x => this._planAllDone(x));
    const final = 'I found why the cart total test failed now and then: prices were rounded at different steps, so some totals were a cent off. It now passes 50 times in a row.';
    yield* this._doChecks(a);
    this._turnEnd(a, this._withHints(a, hinted ? `${final} Your hint helped.` : final));
    yield* this._conversation(a, null);
  }

  // ---- the endless demo agent ----

  *_onboardingRoot(a) {
    if (a.jobCursor === undefined) { a.jobCursor = 2; a.morePlan = 0; }
    let sinceSpawn = 4;
    let sincePlan = 0;
    for (;;) {
      sinceSpawn += 1;
      sincePlan += 1;
      if (this._workingHelpers(a) < 2 && a.helpers.length < MAX_HELPERS_PER_ROOT && sinceSpawn > 15 && a.rng.chance(0.15)) {
        // Helpers here are long-lived, so the tree grows slowly: a few minutes each at speed 1.
        const base = ONBOARDING_JOBS[a.jobCursor++ % ONBOARDING_JOBS.length];
        const n = base.type === 'Explore' ? a.rng.int(30, 50) : a.rng.int(50, 90);
        yield* this._doSpawn(a, { ...base, steps: this._pickSteps(a.rng, base.pool, n) });
        sinceSpawn = 0;
        continue;
      }
      if (sincePlan > 60 && a.rng.chance(0.05)) {     // a plan step every four or five minutes
        yield* this._onboardingPlanStep(a);
        sincePlan = 0;
        continue;
      }
      let step, k = 0;
      do { step = stepOf(a.rng.pick(ONBOARDING_POOL)); } while (narrate(step.tool, step.input).sentence === a.lastSentence && ++k < 8);
      yield* this._doTool(a, step);
    }
  }

  /** Move the plan on; when it runs out, add the next step (Claude Code agents add tasks as they go). */
  *_onboardingPlanStep(a) {
    if (a.plan.some(p => p.status === 'pending')) {
      yield* this._doPlan(a, x => this._planAdvance(x));
    } else if (a.morePlan < ONBOARDING_MORE_PLAN.length) {
      const text = ONBOARDING_MORE_PLAN[a.morePlan++];
      yield* this._doPlan(a, x => {
        this._planAdvance(x);
        x.plan.push({ id: String(x.plan.length + 1), text, status: 'in_progress' });
      }, 'TaskCreate', { subject: text });
    }
  }

  _withHints(a, text) {
    if (!a.hints.length) return text;
    a.hints = [];
    return `${text} I also took your note into account.`;
  }

  // ---- after a turn ends ----

  /** Wait for the person's next message, then do a short follow-up turn. `question` is the closing question, if any. */
  *_conversation(a, question) {
    for (;;) {
      const { text } = yield { wait: 'message', question: !!question };
      yield* this._followUp(a, text, question);
      question = null;
    }
  }

  *_followUp(a, text, question) {
    this._turnStart(a);
    yield a.rng.between(700, 1500);
    this._think(a);
    yield a.rng.between(1000, 2200);
    const key = a.script ? a.script.topic.key : 'project';
    // After a merge its `files` are empty: it goes on with the files it worked on before.
    const files = a.script ? a.script.files : [...(a.files.size ? a.files.keys() : a.paths)];
    const main = files[0] || 'src/index.ts';
    let plan;
    if (question && NEGATIVE_RE.test(text)) plan = { steps: [['Bash', 'git diff --stat']], done: 'OK, I left that as it is. Everything else is done.' };
    else if (question) plan = { steps: question.steps(key, files), done: question.done(key) };
    else plan = this._specialFollowUp(a, text) || {
      steps: [['Read', main], ['Edit', main], ['Bash', 'npm test']],
      done: 'I made the change you asked for, and the tests still pass.',
    };
    yield* this._doSteps(a, plan.steps);
    if (plan.after) plan.after();
    if (plan.forget) {
      for (const p of plan.forget) {
        if (a.created.delete(p)) {
          // Its unmerged work had added it: taken out again, it was never there.
          a.files.delete(p);
          a.paths.delete(p);
        } else if (a.paths.has(p)) {
          // It was there when its unmerged work began (merged earlier, say): taking it out deletes it.
          const f = a.files.get(p);
          a.files.set(p, { path: p, adds: 0, dels: a.lines.get(p)?.lines ?? Math.max(12, f ? f.dels : 0) });
          a.deleted.add(p);
        } else {
          a.files.delete(p);
        }
      }
      this._emitFiles(a);
    }
    if (plan.checks) a.checkNames = plan.checks;
    yield* this._doChecks(a);
    this._turnEnd(a, this._withHints(a, plainFinal(plan.done)));
  }

  /** Follow-ups the mockup offers for the two finished demo agents, and bringing in main after a conflict. */
  _specialFollowUp(a, text) {
    // "Ask it to bring in main" after a conflict: it merges main into its own branch and settles the clash there.
    if (a.git && a.git.behind && !a.git.thrownAway && /\b(conflicts?|bring in|merge)\b/i.test(text)) {
      const path = (a.git.conflict || []).find(p => a.files.has(p)) || [...a.files.keys()][0] || 'README.md';
      return {
        steps: [['Bash', `git merge ${a.git.from}`, true, 'Bring in the latest work'], ['Read', path], ['Edit', path], ['Bash', 'git commit --no-edit']],
        after: () => this._bringInMain(a),
        done: `I brought in the latest ${a.git.from} and resolved the conflict in ${baseName(path)}, keeping both changes.`,
      };
    }
    if (a.name === 'Invoice export' && /\b(undo|revert|remove|take (it |that )?out|back out)\b/i.test(text)) {
      const migration = 'migrations/0042_invoice_lookup_index.sql';
      // Once its work is merged, the migration is in main: taking it out is a change of its own, to merge again.
      const merged = !a.created.has(migration) && a.paths.has(migration) && !a.deleted.has(migration);
      return {
        steps: [['Bash', `git rm ${migration}`, true, 'Take out the database change'], ['Edit', 'src/invoices/query.ts'], ['Bash', 'npm test']],
        forget: [migration],
        done: merged
          ? 'I took out the database change. It is already in main, so merging this takes the migration out of main again. Invoices still go out in small batches, and the tests pass.'
          : 'I took out the database change, so nothing under migrations/ is touched any more. Invoices still go out in small batches, and the tests pass.',
      };
    }
    if (a.name === 'Help pages' && /\bcheck/i.test(text)) {
      return {
        steps: [['Bash', 'npx markdown-link-check docs/help/getting-started.md', true, 'Check the links in the help pages'], ['Read', 'docs/help/billing.md'], ['Read', 'docs/help/exports.md']],
        checks: ['Link check'],
        done: 'I checked the three help pages: every link works, and the steps match the app.',
      };
    }
    return null;
  }

  // ---- the person answers or says something ----

  /**
   * The person answered an ask. Moves the scripted agent on: Allow continues, Deny makes it try another way,
   * a question's answer starts a new turn, "Stop it" stops it, "Let it keep trying" (or a hint) lets it carry on.
   * Each ask moves the agent on once, so it is safe to also pass the same answer through runner.send().
   * @param {string} agentId
   * @param {{ id?: string, type?: string }|null} ask  the ask being answered, as the store holds it
   * @param {string} answer
   * @returns {{ ok: boolean, reply: string }}
   */
  onAnswer(agentId, ask, answer) {
    this._sync();
    const a = this._agents.get(agentId);
    if (!a) return { ok: false, reply: 'That agent is not part of the demo.' };
    const text = String(answer ?? '').trim();
    const askId = ask && ask.id ? String(ask.id) : null;
    if (askId && this._answered.has(askId)) return { ok: true, reply: 'That was already answered.' };
    const own = a.pendingAsk;
    // Its own ask is answered only by its id; words that name no ask are a message, as in the engine.
    if (own && askId === own.id) return this._resolveOwnAsk(a, own, text);
    if (askId) this._answered.add(askId);
    const type = ask ? ask.type : null;
    if (type === 'stuck') {
      if (STOP_RE.test(text)) return this.stopAgent(agentId);
      if (!text || KEEP_TRYING_RE.test(text)) return { ok: true, reply: `${a.name} will keep trying.` };
    }
    if (type === 'permission') return { ok: false, reply: `${a.name} is not waiting for that any more.` };
    // A question the engine raised from a final message, or a message once the agent is done.
    return this._message(a, text, askId);
  }

  /** Say something to a simulated agent outside an ask: a hint while it works, a follow-up once it is done. */
  say(agentId, text) {
    this._sync();
    const a = this._agents.get(agentId);
    if (!a) return { ok: false, reply: 'That agent is not part of the demo.' };
    return this._message(a, String(text ?? '').trim(), null);
  }

  _resolveOwnAsk(a, ask, text) {
    this._answered.add(ask.id);
    a.pendingAsk = null;
    a.lastAnswer = { text, at: this._now() };
    this._ev(a, EV.ASK_CLEARED, { askId: ask.id, answer: text });
    if (ask.type === 'permission') {
      const allow = isAllow(text);
      this._ev(a, EV.APPROVAL, { how: 'person', decision: allow ? 'allow' : 'deny', sentence: ask.sentence });
      this._ev(a, EV.STATE, { state: STATE.WORKING });
      a.phase = 'working';
      this._resume(a, { allow, text });
      return { ok: true, reply: allow ? `${a.name} will go ahead.` : `${a.name} will not do that and will try another way.` };
    }
    if (ask.type === 'stuck') {
      if (STOP_RE.test(text)) return this.stopAgent(a.id);
      this._ev(a, EV.STATE, { state: STATE.WORKING });
      a.phase = 'working';
      this._resume(a, { text });
      return { ok: true, reply: !text || KEEP_TRYING_RE.test(text) ? `${a.name} will keep trying.` : `${a.name} will try your hint.` };
    }
    this._resume(a, { text });   // a question: the generator starts the new turn
    return { ok: true, reply: `${a.name} has your answer and is carrying on.` };
  }

  _message(a, text, askId) {
    const now = this._now();
    if (a.lastAnswer && a.lastAnswer.text === text && now - a.lastAnswer.at < 5 * SEC) {
      return { ok: true, reply: `${a.name} already has that.` };   // the same answer arriving by a second route
    }
    if (a.kind === 'helper' && ENDED.has(a.state)) return { ok: false, reply: `${a.name} has already finished its part.` };
    // Its folder is gone with its work, as for an earlier agent: "Its work was thrown away, so it cannot continue."
    if (a.git && a.git.thrownAway) return { ok: false, reply: `${a.name}’s work was thrown away, so it cannot continue.` };
    if (a.phase === 'stopped' || a.phase === 'failed') return { ok: false, reply: `${a.name} has stopped, so it cannot take messages.` };
    if (a.pendingAsk && a.pendingAsk.type === 'question') return this._resolveOwnAsk(a, a.pendingAsk, text);
    if (a.waiting && a.waiting.wait === 'message') {
      const answering = !!askId || a.waiting.question;
      if (!answering && (!text || ACCEPT_RE.test(text))) return { ok: true, reply: `${a.name} is left as it is.` };
      a.lastAnswer = { text, at: now };
      if (askId) this._ev(a, EV.ASK_CLEARED, { askId, answer: text });
      this._resume(a, { text });
      return { ok: true, reply: answering ? `${a.name} has your answer and is carrying on.` : `${a.name} is on it.` };
    }
    if (!text) return { ok: true, reply: 'There was nothing to pass on.' };
    a.hints.push(text);
    a.lastAnswer = { text, at: now };
    return { ok: true, reply: `${a.name} got your message and will take it into account.` };
  }

  // ---- stopping ----

  /** Stop a simulated agent and its helpers, as when the person stops it. Emits the stopped state itself. */
  stopAgent(agentId) {
    this._sync();
    const a = this._agents.get(agentId);
    if (!a) return { ok: false, reply: 'That agent is not part of the demo.' };
    if (a.kind === 'helper') {
      if (ENDED.has(a.state)) return { ok: true, reply: `${a.name} had already finished.` };
      this._endHelper(a, STATE.STOPPED);
      return { ok: true, reply: `${a.name} is stopped.` };
    }
    if (a.phase === 'stopped') return { ok: true, reply: `${a.name} is already stopped.` };
    this._stopTree(a, true);
    return { ok: true, reply: `${a.name} is stopped.` };
  }

  _stopTree(root, emitState) {
    root.proc = null;
    root.waiting = null;
    if (root.pendingAsk) { this._answered.add(root.pendingAsk.id); root.pendingAsk = null; }
    for (const h of this._helpersOf(root)) if (h.state === STATE.WORKING) this._endHelper(h, STATE.STOPPED);
    if (root.openTool) this._toolEnd(root, root.openTool, false);
    root.phase = 'stopped';
    root.state = STATE.STOPPED;
    if (emitState) this._ev(root, EV.STATE, { state: STATE.STOPPED, reason: 'Stopped by you' });
    this._ev(root, EV.ENDED, { outcome: 'stopped' });
  }

  // ---- runners ----

  /** A Runner handle for any simulated root, seeded ones included, so the engine can treat them all alike. */
  runnerFor(agentId) {
    const a = this._agents.get(agentId);
    return a && a.kind !== 'helper' ? this._handle(a, null) : null;
  }

  _handle(a, start) {
    const sim = this;
    return {
      async start() { sim._sync(); if (start) start(); },
      async send(text) {
        sim._sync();
        // A simulated agent that has stopped or failed cannot be picked up again: say so, rather than "Sent".
        const res = sim._message(a, String(text ?? '').trim(), null);
        if (res && res.ok === false) throw Object.assign(new Error(res.reply), { plain: true });
      },
      async stop() {
        sim._sync();
        if (a.phase === 'stopped') return;
        // The engine closes a finished agent's idle process quietly: it still shows the state it finished in.
        if (a.phase === 'idle') a.closedFrom = sim._shownState(a);
        sim._stopTree(a, false);   // the engine emits the stopped state, when there is one to show
      },
      info() { return { pid: null, sessionId: a.sessionId, alive: !['new', 'stopped', 'failed'].includes(a.phase) }; },
    };
  }

  /**
   * A Runner for a task started in demo mode. It plays a scripted tree derived from the task text:
   * a plan of 3 to 5 steps, 1 to 3 helpers named from the task, about 40 to 90 s of simulated work,
   * sometimes a permission ask, then a turn end whose final message sometimes asks a question.
   * @param {{ agentId: string, name?: string, task?: string, emit?: Function, machineId?: string,
   *           model?: string, budgetUsd?: number, harness?: 'claude'|'codex'|'sim' }} opts
   *        Other Runner options (cwd, hook, log) are accepted and ignored.
   */
  createRunner(opts = {}) {
    const { agentId, task = '', emit, machineId = 'laptop', model, budgetUsd } = opts;
    if (!agentId) throw new Error('createRunner needs an agentId');
    // In the demo the engine passes the harness the person asked for ('claude' or 'codex'); helpers inherit it.
    const harnessName = ['claude', 'codex', 'sim'].includes(opts.harness) ? opts.harness : 'sim';
    const a = this._agent({
      id: String(agentId), name: opts.name || nameFromTask(task), task: String(task), machineId,
      model: resolveModel(model, harnessName), budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 2,
      emitTo: typeof emit === 'function' ? emit : null, harnessName, rngKey: `run:${agentId}:${task}`,
    });
    a.sessionId = uuid(a.rng);
    a.script = this._scriptFor(a);
    a.checkNames = a.script.checks;
    let started = false;
    return this._handle(a, () => {
      if (started) return;
      started = true;
      // Like a real agent, it works on its own branch, made from what is newest on main now.
      this._attachGit(a, this._gitWorld().head);
      this._emitWork(a);
      this._run(a, this._runnerProc(a));
    });
  }

  _scriptFor(a) {
    const r = a.rng;
    const topic = topicOf(a.task);
    const k = topic.key;
    const kind = planKind(topic, a.task);
    const main = topic.file ? `src/${topic.file}` : `src/${k}/${k}.ts`;
    const files = [main, `src/${k}/${r.pick(['index', 'utils', 'store', 'api'])}.ts`, `test/${k}.test.ts`];
    let plan = PLAN_TEMPLATES[kind](k);
    if (plan.length > 3 && r.chance(0.5)) plan = plan.slice(0, -1);
    const codex = a.harness === 'codex';     // Codex runs have no helpers and no permission asks
    const jobs = codex ? [] : r.shuffle(HELPER_JOBS.filter(j => !j.when || j.when === kind)).slice(0, r.int(1, 3)).map(j => {
      const pool = j.type === 'Explore'
        ? [['Read', files[0]], ['Read', files[1]], ['Grep', k], ['Glob', `src/**/*${k}*`], ['Grep', `${k}(`], ['Read', files[2]]]
        : [['Read', files[0]], ['Edit', files[2]], ['Read', files[2]], ['Bash', `npm test -- ${k}`], ['Grep', k], ['Edit', files[1]]];
      return { description: j.description(k), type: j.type, steps: this._pickSteps(r, pool, r.int(5, 8)), summary: j.summary(k, r.int(1, 3), files[0]) };
    });
    return {
      topic, kind, files, plan, jobs,
      permission: !codex && r.chance(0.4) ? r.pick(PERMISSIONS) : null,
      question: r.chance(0.35) ? r.pick(QUESTIONS) : null,
      endTurnWhileWaiting: r.chance(0.6),
      work: r.int(6, 9),
      checks: r.chance(0.65) ? REPO_CHECKS.slice(0, r.int(1, 2)) : null,   // otherwise nothing was set up to check it
      deniedNote: null,
    };
  }

  *_runnerProc(a) {
    const s = a.script;
    const r = a.rng;
    const k = s.topic.key;
    a.plan = s.plan.map((text, i) => ({ id: String(i + 1), text, status: 'pending' }));
    this._turnStart(a);
    yield r.between(800, 1600);
    this._think(a);
    yield r.between(1200, 2600);
    yield* this._doTool(a, stepOf(['Grep', k]));
    yield* this._doTool(a, stepOf(['Read', s.files[0]]));
    yield* this._doPlan(a, x => this._planAdvance(x));
    for (const job of s.jobs) yield* this._doSpawn(a, job);

    // The main work, moving the plan along as it goes, maybe with a risky step that needs the person.
    const work = [['Read', s.files[1]], ['Edit', s.files[0]], ['Grep', `${k}(`], ['Edit', s.files[1]], ['Write', s.files[2]],
      ['Bash', `npm test -- ${k}`], ['Read', s.files[2]], ['Edit', s.files[0]], ['Bash', 'git diff --stat']].slice(0, s.work);
    const advances = Math.max(0, a.plan.length - 2);
    const advanceAt = Array.from({ length: advances }, (_, j) => Math.max(1, Math.round(((j + 1) * work.length) / (advances + 1))));
    const permAt = s.permission ? r.int(2, work.length) : -1;
    for (let i = 0; i <= work.length; i++) {
      for (const at of advanceAt) if (at === i) yield* this._doPlan(a, x => this._planAdvance(x));
      if (i === permAt) yield* this._permissionStep(a, s.permission);
      if (i < work.length) yield* this._doTool(a, stepOf(work[i]));
    }

    // Helpers still busy: like Claude Code, end the turn and pick up again when they report back, or just wait.
    const busy = this._workingHelpers(a);
    if (busy > 0) {
      if (s.endTurnWhileWaiting) {
        this._turnEnd(a, 'My helpers are still working. I will pick up again when they report back.', { backgroundTasks: busy });
        yield { wait: 'helpers' };
        this._turnStart(a);
        yield r.between(600, 1400);
      } else {
        yield { wait: 'helpers' };
      }
    }

    yield* this._doPlan(a, x => this._planAdvance(x));
    yield* this._doTool(a, stepOf(['Bash', 'npm test']));
    yield* this._doPlan(a, x => this._planAllDone(x));
    yield* this._doChecks(a);
    this._turnEnd(a, this._finalText(a));
    yield* this._conversation(a, s.question);
  }

  *_permissionStep(a, perm) {
    if (this._overBudget(a)) { this._budgetStop(a); yield 1; return; }
    const step = stepOf(perm.step);
    this._think(a);
    yield a.rng.between(800, 1800);
    // The tool call shows first; then it is held until the person answers.
    const pending = this._toolStart(a, step.tool, step.input, { auto: false });
    yield a.rng.between(300, 700);
    const req = describeRequest(step.tool, step.input);
    this._raiseAsk(a, { type: 'permission', sentence: `${a.name} ${req.sentence}`, detail: req.detail, why: whyAsk(step), options: ['Allow', 'Deny'], primary: 'Allow' }, STATE.NEEDS_OK);
    const ans = yield { wait: 'answer', kind: 'permission' };
    if (ans.allow) {
      yield this._durFor(a, pending);
      this._toolEnd(a, pending, true);
      yield a.rng.between(500, 1500);
      yield* this._doSteps(a, perm.after);
    } else {
      this._toolEnd(a, pending, false);
      a.script.deniedNote = perm.note;
      this._think(a);
      yield a.rng.between(1200, 2500);
      yield* this._doSteps(a, perm.alt(a.script.topic.key));
    }
  }

  _finalText(a) {
    const s = a.script;
    const n = s.jobs.length;
    const helpers = n === 0 ? '' : n === 1 ? 'A helper checked part of it for me.' : `${n === 2 ? 'Two' : 'Three'} helpers checked parts of it for me.`;
    const check = a.rng.pick(['The tests pass.', 'All the tests pass.', 'I ran the tests and they pass.']);
    let text = this._withHints(a, plainFinal(doneSentence(s.topic), check, s.deniedNote, helpers));
    if (s.question) text += `\n\n${s.question.q(s.topic.key)}`;
    return text;
  }

  // ---- the demo's git repository ----
  // Every root agent gets a branch, workbench/<slug>-<id>, from what was newest on main when it started. Its work stays
  // uncommitted in its folder until it is merged, as with a real agent: then a work commit W goes on its branch and a
  // merge commit M joins W into main. The engine calls the public methods below in demo mode (section 6 of the spec).
  // gitGraph() and changes() only read: they never draw from a random stream, move simulated time or emit anything.

  /**
   * The repository, made once, at seedWorld() or on first use: the person's history and two agents' work merged earlier
   * today, ending at main. Ids come from the repository's own seeded stream, so the same seed gives the same ids.
   */
  _gitWorld(at) {
    if (this._git) return this._git;
    const now = Number.isFinite(at) ? at : this._now();
    const rng = new Rng(`git:${this.seed}`);
    this._git = {
      name: DEMO_REPO, branch: TRUNK_BRANCH, dirty: DEMO_DIRTY, identity: true, head: null,
      commits: new Map(),   // id -> { id, parents, subject, author, at, agentId, kind, message, tree }
      refs: new Map(),      // branch name -> commit id: main and every workbench/* branch
      hidden: new Map(),    // refs/workbench/discarded/<id> -> the copy kept of work thrown away
      agentIds: new Set(),  // the ids in the earlier agents' trailers
    };
    const g = this._git;
    const when = ago => now - ago * MIN + Math.round(rng.between(-30, 30) * SEC);
    for (const step of TRUNK) {
      if (step.merge === undefined) {
        g.head = this._addCommit({ id: rng.hex(40), parents: g.head ? [g.head] : [], author: YOU, at: when(step.ago), message: `${step.subject}\n` }).id;
        continue;
      }
      const e = EARLIER_MERGES[step.merge];
      let agentId;
      do { agentId = rng.hex(6); } while (g.agentIds.has(agentId));
      g.agentIds.add(agentId);
      const subject = subjectOf(e.task, e.name);
      const work = this._addCommit({
        id: rng.hex(40), parents: [this._gitBaseAt(now - e.fromAgo * MIN)], author: e.name, at: when(e.workAgo),
        message: workMessage({ subject, body: e.says, agentId, harness: 'claude' }),
      });
      g.head = this._addCommit({
        id: rng.hex(40), parents: [g.head, work.id], author: YOU, at: when(step.ago),
        message: mergeMessage({ name: e.name, subject, agentId }),
      }).id;
    }
    g.refs.set(TRUNK_BRANCH, g.head);
    return g;
  }

  /** Record a commit. Its subject is its message's first line; agentId and kind come from its trailers, as gitGraph reads them. */
  _addCommit({ id, parents, author, at, message, tree = null }) {
    const ps = [...parents];
    const { agentId, kind } = trailersOf(message, ps);
    const commit = {
      id, parents: ps, subject: String(message).split('\n')[0], author, at: toSeconds(at), agentId, kind,
      message: String(message), tree: tree || hex40(`tree:${id}`),
    };
    this._git.commits.set(id, commit);
    return commit;
  }

  /** A commit made now: its id comes from everything it holds, as git's does. */
  _newCommit(c) {
    const at = toSeconds(c.at);
    const id = hex40(`commit|${c.tree}|${c.parents.join(',')}|${c.author}|${at}|${c.message}`);
    return this._git.commits.get(id) || this._addCommit({ ...c, at, id });
  }

  _treeOf(id) {
    const c = this._gitWorld().commits.get(id);
    return c ? c.tree : hex40(`tree:${id}`);
  }

  /** The newest commit on main's own line (first parents) made at or before `t`: where an agent started then. */
  _gitBaseAt(t) {
    const g = this._gitWorld();
    let id = g.head;
    for (;;) {
      const c = g.commits.get(id);
      if (!c || c.at <= t || !c.parents.length) return id;
      id = c.parents[0];
    }
  }

  _isAncestor(ancestor, of) {
    const g = this._gitWorld();
    const walk = [of];
    const seen = new Set();
    while (walk.length) {
      const id = walk.pop();
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = g.commits.get(id);
      if (c) walk.push(...c.parents);
    }
    return false;
  }

  /**
   * Give a root its branch at `base`, as the engine's createWorkspace does for a real agent. `extra.conflict`: the paths
   * you changed on main after it started, which its work clashes with until it brings in main.
   */
  _attachGit(a, base, extra = null) {
    const g = this._gitWorld();
    const branch = `workbench/${slugify(a.name)}-${a.id}`;
    const conflict = extra && Array.isArray(extra.conflict) && extra.conflict.length ? [...extra.conflict] : null;
    a.git = {
      branch, from: g.branch, base, since: base, head: base, folder: true, behind: !!conflict, conflict,
      merged: null, problem: null, thrownAway: null,
    };
    g.refs.set(branch, base);
    return a.git;
  }

  /** The AgentView's `work`, whole: `agent.work` replaces it as a whole. */
  _workOf(a) {
    const w = a.git;
    return {
      branch: w.thrownAway ? null : w.branch,
      from: w.from,
      folder: w.folder,
      merged: w.merged ? { ...w.merged } : null,
      problem: w.problem ? { ...w.problem, paths: [...w.problem.paths] } : null,
      thrownAway: w.thrownAway ? { ...w.thrownAway } : null,
    };
  }

  _emitWork(a) {
    return this._ev(a, WORK_EVENT, { work: this._workOf(a) });
  }

  /**
   * The state the person sees for a root, as the engine decides it from this agent's events: the end of a turn is
   * decided from the final message and the checks it reported, as the engine does in the demo.
   */
  _shownState(a) {
    if (a.kind === 'helper') return a.state;
    switch (a.phase) {
      case 'new': return STATE.STARTING;
      case 'working': return STATE.WORKING;
      case 'waiting_helpers': return STATE.WAITING_HELPERS;
      case 'asking': {
        const type = a.pendingAsk && a.pendingAsk.type;
        return type === 'permission' ? STATE.NEEDS_OK : type === 'stuck' ? STATE.MAYBE_STUCK : STATE.QUESTION;
      }
      case 'failed': return STATE.FAILED;
      case 'stopped': return a.closedFrom || STATE.STOPPED;
      default:
        if (a.lastFinal && extractQuestion(a.lastFinal)) return STATE.QUESTION;
        return a.checks === 'passed' ? STATE.DONE_CHECKED : a.checks === 'failed' ? STATE.CHECKS_FAILED : STATE.DONE_CLAIMED;
    }
  }

  /**
   * Its work now, like workspace.mjs's snapshotWork: every changed file not hidden by a .gitignore, as a tree, and the
   * ones left out. Status: 'added' for a file its work added, 'deleted' for one it took out, else 'modified' (no rename
   * detection). `workId` binds a card to exactly what it showed.
   */
  _snapshotWork(a) {
    const w = a.git;
    const all = this._filesOf(a).list;
    const files = all.filter(f => !f.ignored).map(f => {
      const status = a.created.has(f.path) ? 'added' : a.deleted.has(f.path) ? 'deleted' : 'modified';
      const out = { path: f.path, status, adds: f.adds, dels: f.dels };
      if (f.binary) out.binary = true;
      if (f.large) out.large = true;
      return out;
    });
    const left = all.filter(f => f.ignored).map(f => ({ path: f.path, why: 'ignored' }));
    const sinceTree = this._treeOf(w.since);
    const tree = files.length
      ? hex40(`tree|${sinceTree}|${JSON.stringify(files.map(f => [f.path, f.status, f.adds, f.dels, !!f.binary, !!f.large]))}`)
      : sinceTree;
    return { head: w.head, tree, since: w.since, workId: `${w.head}:${tree}`, changed: tree !== sinceTree, files, left };
  }

  /** What an agent's diffs are made from: the same work since the same commit always reads the same. */
  _diffKey(a) {
    return `${this.seed}:${a.id}:${a.git.since}`;
  }

  /** The root a git method is about, or the plain reason it cannot be. `use`: 'show' takes a helper to its agent. */
  _gitTarget(agentId, use) {
    const a = this._agents.get(String(agentId ?? ''));
    if (!a) return { refusal: 'That agent is not part of the demo.' };
    if (a.kind === 'helper') {
      if (use === 'show') return this._gitTarget(a.rootId, use);
      return { refusal: use === 'merge'
        ? 'Helpers work in their agent’s folder. Merge the agent instead.'
        : 'Helpers work in their agent’s folder. Throw away the agent’s work instead.' };
    }
    if (!a.git) {
      return { refusal: use === 'merge' ? SIM_CARD_MERGE : use === 'discard' ? SIM_CARD_DISCARD
        : 'This is the demo, so there are no real changes to show.' };
    }
    return { agent: a };
  }

  /**
   * The git screen's data, shaped like the engine's gitGraph() and workspace.mjs's gitGraph() at once:
   *   { ok: true, head, branch, repo: { name, branch, head, dirty, identity }, commits, more, agents }
   * commits: [{ id, parents, subject, author, at, refs, agentId, kind }], newest first in topological order (as
   * `git log --topo-order` from main and every workbench/* branch), at most `limit`. `at`: ms, in whole seconds. `refs`:
   * the branches at that commit, main first. `agentId` and `kind` come from each commit's own Workbench trailers.
   * agents: every root with a branch: [{ id, name, state, earlier, harness, branch, from, base, since, files, work }].
   * `views` (optional: AgentViews, a Map of them, or a function from id to view) gives the name, state, files and work
   * the page shows; without them the simulator's own record of each agent is used. Read-only.
   */
  gitGraph({ views = null, limit = 200 } = {}) {
    const g = this._gitWorld();
    const viewOf = typeof views === 'function' ? views
      : views instanceof Map ? (id) => views.get(id)
        : Array.isArray(views) ? ((byId) => (id) => byId.get(id))(new Map(views.filter(Boolean).map(v => [v.id, v])))
          : () => null;
    const refsAt = new Map();
    for (const [name, id] of g.refs) {
      if (!refsAt.has(id)) refsAt.set(id, []);
      refsAt.get(id).push(name);
    }
    const byName = (x, y) => (x === g.branch ? -1 : y === g.branch ? 1 : x < y ? -1 : x > y ? 1 : 0);
    for (const names of refsAt.values()) names.sort(byName);
    const tips = [g.head, ...[...g.refs].filter(([name]) => name.startsWith('workbench/')).map(([, id]) => id)];
    const order = topoOrder(g.commits, [...new Set(tips)]);
    const max = Math.max(1, Math.min(5000, Math.floor(Number(limit)) || 200));
    const commits = order.slice(0, max).map(c => ({
      id: c.id, parents: [...c.parents], subject: c.subject, author: c.author, at: c.at,
      refs: [...(refsAt.get(c.id) || [])], agentId: c.agentId, kind: c.kind,
    }));
    const agents = [];
    for (const a of this._agents.values()) {
      if (a.kind === 'helper' || !a.git || a.git.thrownAway) continue;
      const v = viewOf(a.id) || null;
      agents.push({
        id: a.id, name: (v && v.name) || a.name, state: (v && v.state) || this._shownState(a), earlier: !!(v && v.earlier),
        harness: (v && v.harness) || a.harness, branch: a.git.branch, from: a.git.from, base: a.git.base, since: a.git.since,
        files: v && v.files !== undefined ? copyOf(v.files) : this._filesOf(a),
        work: v && v.work ? copyOf(v.work) : this._workOf(a),
      });
    }
    return {
      ok: true, head: g.head, branch: g.branch,
      repo: { name: g.name, branch: g.branch, head: g.head, dirty: g.dirty, identity: g.identity },
      commits, more: order.length > max, agents,
    };
  }

  /**
   * An agent's work as a diff, in workspace.mjs's workDiff shape: { workId, since, head, files, left, omitted }.
   * files: [{ path, status: 'added'|'modified', adds, dels, binary?, large?, patch }]: the files its `files` lists, but
   * for those a .gitignore hides (in `left`). Each patch is a unified diff with exactly that many added and removed
   * lines, and the same every time for the same work. A helper's id gives its agent's work. Refusals: { ok: false, reply }.
   */
  changes(agentId, { maxFiles = 300 } = {}) {
    const t = this._gitTarget(agentId, 'show');
    if (t.refusal) return { ok: false, reply: t.refusal };
    const a = t.agent;
    if (a.git.thrownAway) return { ok: false, reply: `${a.name}’s work was thrown away, so there is nothing to show.` };
    if (!a.git.folder) return { ok: false, reply: 'Its folder is gone, so there is nothing to show.' };
    const snap = this._snapshotWork(a);
    const max = Math.max(0, Math.floor(Number(maxFiles)) || 0);
    const files = snap.files.slice(0, max).map(f => ({
      ...f,
      patch: f.binary || f.large ? null
        : syntheticPatch({ path: f.path, status: f.status, adds: f.adds, dels: f.dels, key: this._diffKey(a), origin: a.lines.get(f.path) || null }),
    }));
    return { workId: snap.workId, since: snap.since, head: snap.head, files, left: snap.left, omitted: snap.files.length - files.length };
  }

  /** Why it cannot be merged now, in the engine's words ({ why?, reply }), or null. */
  _mergeRefusal(a, shown, state, into) {
    if (ACTIVE.has(shown)) return { reply: `${a.name} is still working. Merge it when it is done.` };
    if (a.git.thrownAway) return { why: 'gone', reply: `${a.name}’s work was thrown away, so there is nothing to merge.` };
    if (!a.git.folder) return { why: 'gone', reply: 'Its folder is gone, so there is nothing to merge.' };
    if (state && state !== shown) return { reply: 'That changed. Have another look.' };
    if (!this._snapshotWork(a).changed) return { why: 'nothing', reply: `${a.name}’s work is already in ${into}.` };
    return null;
  }

  /** The merge card's detail, in the engine's words: the counts first, then whatever applies, then that it is the demo. */
  _mergeDetail(a, snap, into) {
    const g = this._gitWorld();
    const adds = snap.files.reduce((s, f) => s + f.adds, 0);
    const dels = snap.files.reduce((s, f) => s + f.dels, 0);
    const parts = [`${plural(snap.files.length, 'file', 'files')}, +${adds} −${dels}. Its work becomes a commit on its branch, joined into ${into} by a merge commit.`];
    if (a.checks === 'failed') {
      const failed = a.checkResults.filter(r => !r.ok).map(r => String(r.name));
      parts.push(failed.length > 1 ? `${failed.length} checks failed: ${joinAnd(failed)}.` : `A check failed: ${failed[0] || 'one of its checks'}.`);
    } else if (a.checks !== 'passed') {
      parts.push('Nothing checked its work.');
    }
    const broken = REPO_RULES.filter(r => snap.files.some(f => r.paths.some(p => f.path.startsWith(p))))
      .map(r => r.say.trim().replace(/[.!?]+$/, ''));
    if (broken.length === 1) parts.push(`It broke a rule you set: ${broken[0]}.`);
    else if (broken.length > 1) parts.push(`It broke ${broken.length} rules you set: ${joinAnd(broken)}.`);
    const paths = snap.files.map(f => f.path);
    if (paths.includes('workbench.json')) parts.push('It changes workbench.json, which sets the checks for later agents.');
    if (paths.some(p => /(^|\/)\.claude(\/|$)/i.test(p))) parts.push('It changes .claude/, which holds Claude Code’s settings for this repository.');
    if (paths.some(p => /(^|\/)\.mcp\.json$/i.test(p))) parts.push('It changes .mcp.json, which can give Claude Code new tools here.');
    const ignored = snap.left.filter(l => l.why === 'ignored').length;
    if (ignored) parts.push(`${ignored} file${ignored === 1 ? ' stays' : 's stay'} out: hidden by a .gitignore.`);
    if (g.dirty > 0) parts.push(`Your ${g.dirty} uncommitted change${g.dirty === 1 ? ' stays as it is' : 's stay as they are'}.`);
    parts.push(SIM_CARD_MERGE);
    return parts.join(' ');
  }

  /**
   * The merge card for an agent, or why not. Never merges. `state`: the state the page drew its button for.
   * -> { ok: true, agentId, kind: 'merge', into, sentence, detail, yes, no, danger, reply, files, adds, dels,
   *      expect: { workId, into, intoHead } }   (the engine gives the card its id, and may pass `expect` to merge())
   *  | { ok: false, why?, reply }
   */
  proposeMerge(agentId, { state = null, view = null } = {}) {
    const t = this._gitTarget(agentId, 'merge');
    if (t.refusal) return { ok: false, reply: t.refusal };
    const a = t.agent;
    const g = this._gitWorld();
    const into = g.branch;
    const no = this._mergeRefusal(a, (view && view.state) || this._shownState(a), state, into);
    if (no) return { ok: false, ...no };
    const snap = this._snapshotWork(a);
    const sentence = `Merge ${a.name} into ${into}?`;
    return {
      ok: true, agentId: a.id, kind: 'merge', into, sentence, detail: this._mergeDetail(a, snap, into),
      yes: 'Merge', no: 'Cancel', danger: false, reply: sentence,
      files: snap.files.length, adds: snap.files.reduce((s, f) => s + f.adds, 0), dels: snap.files.reduce((s, f) => s + f.dels, 0),
      expect: { workId: snap.workId, into, intoHead: g.head },
    };
  }

  /** A merge that did not happen, for a reason the engine keeps on the agent (work.problem) until it clears. */
  _mergeProblem(a, why, sentence, paths = []) {
    a.git.problem = { why, sentence, paths: [...paths], at: this._ts ?? this._now() };
    this._emitWork(a);
    return { ok: false, why, sentence, paths: [...paths], into: this._gitWorld().branch, reply: `${sentence} ${SIM_SAYS_MERGED}` };
  }

  /**
   * Merge an agent's work, as mergeWork does: its work becomes a commit W on its branch, and a merge commit M (main
   * first, W second) joins W into main, even when main has not moved. Always works, except for Help pages, whose work
   * clashes with yours until it brings in main. `expect` (from proposeMerge) binds it to what the card showed.
   * The outcome goes out as the same events the engine sends for a real merge: `agent.work` (merged, or the problem)
   * and, after a merge, `agent.files` emptied. From then on its unmerged work starts at W.
   * -> { ok: true, into, merge, work, files, adds, dels, reply }
   *  | { ok: false, why, sentence, paths?, into, reply }   why: 'gone'|'moved'|'changed'|'nothing'|'ancestry'|'conflict'
   *  | { ok: false, reply }                                 not a git reason: not in the demo, a helper, still working
   */
  merge(agentId, { expect = null, view = null } = {}) {
    this._sync();
    const t = this._gitTarget(agentId, 'merge');
    if (t.refusal) return { ok: false, reply: t.refusal };
    const a = t.agent;
    const w = a.git;
    const g = this._gitWorld();
    const into = g.branch;
    if (ACTIVE.has((view && view.state) || this._shownState(a))) return { ok: false, reply: `${a.name} is still working. Merge it when it is done.` };
    const fail = (why, sentence) => ({ ok: false, why, sentence, into, reply: `${sentence} ${SIM_SAYS_MERGED}` });
    if (w.thrownAway) return fail('gone', `${a.name}’s work was thrown away, so there is nothing to merge.`);
    if (!w.folder) return fail('gone', 'Its folder is gone, so there is nothing to merge.');
    if (expect && ((expect.into && expect.into !== into) || (expect.intoHead && expect.intoHead !== g.head))) {
      return this._mergeProblem(a, 'moved', `${into} changed since you looked. Have another look.`);
    }
    const snap = this._snapshotWork(a);
    if (expect && expect.workId && expect.workId !== snap.workId) return fail('changed', `${a.name}’s work changed since you looked. Have another look.`);
    const nothing = `${a.name}’s work is already in ${into}.`;
    if (!snap.changed) return fail('nothing', nothing);
    if (!this._isAncestor(w.since, g.head)) {
      return this._mergeProblem(a, 'ancestry', `${a.name} started from a commit that is no longer in ${into}, so merging it would bring in other work.`);
    }
    const at = this._ts ?? this._now();
    const subject = subjectOf(a.task, a.name);
    let work = w.head;
    if (snap.tree !== this._treeOf(w.head)) {   // its folder holds work not committed yet: it becomes W on its branch
      work = this._newCommit({
        parents: [w.head], tree: snap.tree, author: a.name, at,
        message: workMessage({ subject, body: a.says, agentId: a.id, harness: a.harness }),
      }).id;
      g.refs.set(w.branch, work);
      w.head = work;
    }
    if (this._isAncestor(work, g.head)) return fail('nothing', nothing);
    if (w.behind) {   // W stays on its branch, and nothing changes on main
      const clash = (w.conflict || []).filter(p => snap.files.some(f => f.path === p));
      return this._mergeProblem(a, 'conflict', `${a.name}’s work does not merge cleanly into ${into}.`, clash.length ? clash : w.conflict || []);
    }
    const m = this._newCommit({
      parents: [g.head, work], tree: hex40(`tree|${this._treeOf(g.head)}|${snap.tree}`), author: YOU, at,
      message: mergeMessage({ name: a.name, subject, agentId: a.id }),
    });
    g.head = m.id;
    g.refs.set(into, m.id);
    const files = snap.files.length;
    const adds = snap.files.reduce((s, f) => s + f.adds, 0);
    const dels = snap.files.reduce((s, f) => s + f.dels, 0);
    // What is in main now, so that taking a file out later removes all of it: its lines, and the key its diff had.
    for (const f of snap.files) {
      if (f.status === 'added') a.lines.set(f.path, { lines: f.adds, key: this._diffKey(a) });
      else if (f.status === 'deleted') a.lines.delete(f.path);
    }
    w.since = work;
    w.merged = { into, merge: m.id, at, files, adds, dels };
    w.problem = null;
    a.files.clear();
    a.created.clear();
    a.deleted.clear();
    this._emitWork(a);
    this._ev(a, EV.FILES, { files: { changed: 0, adds: 0, dels: 0, list: [] } });   // nothing is left unmerged
    return { ok: true, into, merge: m.id, work, files, adds, dels, reply: `Merged ${a.name} into ${into}. ${SIM_SAYS_MERGED}` };
  }

  /**
   * After a conflict, the agent brought in main and settled the clash on its own branch, as a real agent does: its work
   * so far as a commit (when none is on its branch yet), then "Merge branch 'main' into <its branch>". Neither carries
   * Workbench trailers. Its next merge goes through.
   */
  _bringInMain(a) {
    const g = this._gitWorld();
    const w = a.git;
    if (!w || w.thrownAway || !w.folder || !w.behind) return;
    const at = this._ts ?? this._now();
    const snap = this._snapshotWork(a);
    let head = w.head;
    if (head === w.since && snap.changed) {
      head = this._newCommit({ parents: [head], tree: snap.tree, author: a.name, at, message: `${subjectOf(a.task, a.name)}\n` }).id;
    }
    const c = this._newCommit({ parents: [head, g.head], tree: snap.tree, author: a.name, at, message: `Merge branch '${g.branch}' into ${w.branch}\n` });
    g.refs.set(w.branch, c.id);
    w.head = c.id;
    w.behind = false;
    w.conflict = null;
  }

  /**
   * The throw-away card for an agent, or why not. `state`: the state the page drew its button for.
   * -> { ok: true, agentId, kind: 'discard', sentence, detail, yes, no, danger: true, active, reply, expect: { workId } }
   *  | { ok: false, why?, reply }
   */
  proposeDiscard(agentId, { state = null, view = null } = {}) {
    const t = this._gitTarget(agentId, 'discard');
    if (t.refusal) return { ok: false, reply: t.refusal };
    const a = t.agent;
    const w = a.git;
    if (w.thrownAway) return { ok: false, reply: `${a.name}’s work was already thrown away.` };
    if (!w.folder) return { ok: false, why: 'gone', reply: 'Its folder is gone, so there is nothing to throw away.' };
    const shown = (view && view.state) || this._shownState(a);
    if (state && state !== shown) return { ok: false, reply: 'That changed. Have another look.' };
    const snap = this._snapshotWork(a);
    const n = snap.files.length;
    const active = ACTIVE.has(shown);
    const sentence = `Throw away ${a.name}’s work?`;
    const parts = [`Its folder and its branch ${w.branch} are deleted, with ${n ? plural(n, 'changed file', 'changed files') : 'no changed files'}. Workbench keeps a hidden copy in git.`];
    if (active) parts.push('It is still working: it will be stopped first.');
    parts.push(SIM_CARD_DISCARD);
    return {
      ok: true, agentId: a.id, kind: 'discard', sentence, detail: parts.join(' '), yes: 'Throw it away', no: 'Keep it', danger: true,
      active, reply: sentence, expect: { workId: snap.workId },
    };
  }

  /**
   * Throw away an agent's work, as discardWork does: a hidden copy is kept (refs/workbench/discarded/<id>), then its
   * folder and branch go. Nothing may run in its folder meanwhile: an agent at work is stopped first, and a finished
   * one's idle process is closed quietly (it keeps showing the state it finished in). The outcome goes out as
   * `agent.work` (thrownAway, no folder, no branch), the event the engine sends for a real throw-away.
   * -> { ok: true, saved, reply } | { ok: false, why?, sentence?, reply }   why: 'gone'|'changed'
   */
  discard(agentId, { expect = null, view = null } = {}) {
    this._sync();
    const t = this._gitTarget(agentId, 'discard');
    if (t.refusal) return { ok: false, reply: t.refusal };
    const a = t.agent;
    const w = a.git;
    const g = this._gitWorld();
    if (w.thrownAway) return { ok: false, reply: `${a.name}’s work was already thrown away.` };
    const fail = (why, sentence) => ({ ok: false, why, sentence, reply: sentence });
    if (!w.folder) return fail('gone', 'Its folder is gone, so there is nothing to throw away.');
    const snap = this._snapshotWork(a);
    if (expect && expect.workId && expect.workId !== snap.workId) return fail('changed', `${a.name}’s work changed since you looked. Have another look.`);
    if (a.phase !== 'stopped') {
      if (ACTIVE.has((view && view.state) || this._shownState(a))) {
        this._stopTree(a, true);
      } else {
        a.closedFrom = this._shownState(a);
        this._stopTree(a, false);
      }
    }
    const at = this._ts ?? this._now();
    const saved = `refs/workbench/discarded/${a.id}`;
    const copy = snap.tree === this._treeOf(w.head) ? w.head
      : this._newCommit({ parents: [w.head], tree: snap.tree, author: YOU, at, message: discardMessage({ branch: w.branch, agentId: a.id }) }).id;
    g.hidden.set(saved, copy);
    g.refs.delete(w.branch);
    w.folder = false;
    w.problem = null;
    w.thrownAway = { at, saved };
    a.files.clear();
    a.created.clear();
    a.deleted.clear();
    this._emitWork(a);
    return { ok: true, saved, reply: `Threw away ${a.name}’s work. Its folder and branch are gone. ${SIM_SAYS_THROWN}` };
  }
}
