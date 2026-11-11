// Demo mode: a stand-in for real coding agents.
// It emits only normalized events (src/shared/events.mjs), shaped like what the Claude Code parser produces:
// agents and helpers, plain-language activity from narrate(), thinking blips, usage and cost, plans, turns, asks.
// Time is simulated: tick(now) advances it by the real time elapsed multiplied by `speed`.
// Event timestamps are always real wall-clock milliseconds; speed only compresses the pacing.
// Everything random comes from a small seeded PRNG, so a given seed always plays out the same way.
import { EV } from '../../shared/events.mjs';
import { STATE, ENDED } from '../../shared/states.mjs';
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
    if (tool === 'Write' && !root.files.has(path)) f.adds += r.int(14, 72);
    else { f.adds += r.int(2, 18); f.dels += r.int(0, 9); }
    root.files.set(path, f);
    if (!this._buffer) this._emitFiles(root);   // history writes one files event at the end instead
  }

  _emitFiles(root) {
    const list = [...root.files.values()].map(f => ({ ...f }));
    this._ev(root, EV.FILES, { files: {
      changed: list.length,
      adds: list.reduce((s, f) => s + f.adds, 0),
      dels: list.reduce((s, f) => s + f.dels, 0),
      list,
    } });
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
  }

  /** End a turn the way Claude Code's result message does. The engine decides the root's state from it. */
  _turnEnd(a, finalText, { backgroundTasks = 0, isError = false } = {}) {
    this._ev(a, EV.THINKING, { on: false });
    this._ev(a, EV.USAGE, {
      ...a.session, costUsd: a.harness === 'codex' ? null : round4(a.cost), contextTokens: a.context,
      contextWindow: CONTEXT_WINDOW, mode: 'set',
    });
    this._ev(a, EV.TURN, { phase: 'end', finalText, backgroundTasks, isError });
    a.lastFinal = finalText;
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
    do { id = this._rng.hex(6); } while (this._agents.has(id));
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
    const files = a.script ? a.script.files : [...a.files.keys()];
    const main = files[0] || 'src/index.ts';
    let plan;
    if (question && NEGATIVE_RE.test(text)) plan = { steps: [['Bash', 'git diff --stat']], done: 'OK, I left that as it is. Everything else is done.' };
    else if (question) plan = { steps: question.steps(key, files), done: question.done(key) };
    else plan = this._specialFollowUp(a, text) || {
      steps: [['Read', main], ['Edit', main], ['Bash', 'npm test']],
      done: 'I made the change you asked for, and the tests still pass.',
    };
    yield* this._doSteps(a, plan.steps);
    if (plan.forget) {
      for (const p of plan.forget) a.files.delete(p);
      this._emitFiles(a);
    }
    if (plan.checks) a.checkNames = plan.checks;
    yield* this._doChecks(a);
    this._turnEnd(a, this._withHints(a, plainFinal(plan.done)));
  }

  /** Follow-ups the mockup offers for the two finished demo agents. */
  _specialFollowUp(a, text) {
    if (a.name === 'Invoice export' && /\b(undo|revert|remove|take (it |that )?out|back out)\b/i.test(text)) {
      return {
        steps: [['Bash', 'git rm migrations/0042_invoice_lookup_index.sql', true, 'Take out the database change'], ['Edit', 'src/invoices/query.ts'], ['Bash', 'npm test']],
        forget: ['migrations/0042_invoice_lookup_index.sql'],
        done: 'I took out the database change, so nothing under migrations/ is touched any more. Invoices still go out in small batches, and the tests pass.',
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
      async stop() { sim._sync(); if (a.phase !== 'stopped') sim._stopTree(a, false); },   // the engine emits the stopped state
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
}
