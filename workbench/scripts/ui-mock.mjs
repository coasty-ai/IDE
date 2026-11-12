// A stand-in for Workbench's HTTP API, for checking the page without the engine. It serves the repo's ui/ and
// src/shared/ the way the real server does (same security headers), and answers /api from scenarios.
// Not part of npm test. Used by scripts/ui-fit-check.mjs and scripts/ui-shots.mjs.
//
//   node scripts/ui-mock.mjs [port]           prints "mock on <port>"; the page is http://127.0.0.1:<port>/?t=k
//
// The page's key is any value except "bad"; "bad" (or /ctl/mode {"auth":"bad"}) gets 401, like a key from an earlier
// run. Control routes need no key:
//   POST /ctl/scenario {"name"}    switch the world (new streams get it; open pages get a fresh snapshot)
//   POST /ctl/push {"event","data"} send one stream event to every open page
//   POST /ctl/mode {...}           answer: "ok" | "refuse" ({ok:false}) | "500" | "drop" (no answer);
//                                  auth: "ok" | "bad"; holdMs: hold each new stream's snapshot; down: refuse streams;
//                                  steps: true to make working agents take steps; merge: what the next merge does,
//                                  "ok" | "conflict" | "blocked" | "moved" | "identity" | "detached" | "busy" |
//                                  "ancestry" | "git" | "changed" | "refuse" (see the D2 block in startMock)
//   GET  /ctl/log                  every request the page sent to /api, with its body
//   POST /ctl/clear                empty the log;  POST /ctl/drop  close every open stream
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const MIN = 60000;

// The demo world, as the simulator seeds it (times relative to now).
const DEMO_AGENTS = [
  {"id":"399e17","parentId":null,"name":"Checkout fix","task":"Fix the checkout bug where half-finished orders are lost","harness":"claude","helperType":null,"model":"claude-sonnet-4-5","machineId":"cloud-1","state":"needs_ok","now":"Update the test database","thinking":false,"ageMin":21.1,"sinceMin":4.1,"endedMin":null,"turns":1,"toolCalls":28,"toolKinds":{"read":10,"search":5,"plan":4,"helper":2,"edit":4,"run":3},"recent":[["Editing order.ts",true],["Searching for “resumeToken”",true],["Editing checkout.ts",true],["Reading orders.ts",true],["Editing orders.ts",true],["Searching for “resumeToken”",true],["Checking what changed",true],["Updating its plan",true]],"spark":[1,1,1,1,0,2,0,1,1,1,1,0,0,0,0,0,0,0,0,0],"helpers":{"total":2,"working":0,"done":2},"usage":{"inputTokens":258,"outputTokens":6850,"cacheReadTokens":760862,"cacheWriteTokens":21391,"costUsd":0.62,"contextTokens":38468,"contextWindow":200000,"contextPct":0.19234},"budgetUsd":2,"plan":{"items":[{"id":"1","text":"Find where checkouts are saved","status":"completed"},{"id":"2","text":"Reproduce the lost order bug","status":"completed"},{"id":"3","text":"Save a resume token with each order","status":"completed"},{"id":"4","text":"Update the test database","status":"in_progress"},{"id":"5","text":"Run the checkout tests","status":"pending"}],"done":3,"total":5},"files":{"changed":4,"adds":49,"dels":15,"list":[{"path":"test/checkout/resume.test.ts","adds":15,"dels":0},{"path":"src/orders/order.ts","adds":8,"dels":7},{"path":"src/checkout/checkout.ts","adds":14,"dels":5},{"path":"src/db/schema/orders.ts","adds":12,"dels":3}]},"checks":null,"rules":null,"ask":{"id":"sim-1-12a274","type":"permission","sentence":"Checkout fix wants to run a command","detail":"npm run db:migrate -- --env test","options":["Allow","Deny"],"primary":"Allow","ageMin":4.1},"approvals":{"auto":27,"byYou":0,"denied":0},"says":null,"error":null},
  {"id":"399e17-7a7143c0","parentId":"399e17","name":"Find similar bugs","task":"Find similar bugs","harness":"claude","helperType":"Explore","model":"claude-haiku-4-5-20251001","machineId":"cloud-1","state":"finished","now":"Searching for “deleteOrder”","thinking":false,"ageMin":18.2,"sinceMin":13.7,"endedMin":13.7,"turns":0,"toolCalls":6,"toolKinds":{"search":3,"read":3},"recent":[["Searching for “status: 'pending'”",true],["Reading cart.ts",true],["Reading retry.ts",true],["Searching for “abandoned”",true],["Reading cleanup.ts",true],["Searching for “deleteOrder”",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":69,"outputTokens":1813,"cacheReadTokens":89130,"cacheWriteTokens":4012,"costUsd":0,"contextTokens":null,"contextWindow":null,"contextPct":null},"budgetUsd":null,"plan":null,"files":null,"checks":null,"rules":null,"ask":null,"approvals":{"auto":6,"byYou":0,"denied":0},"says":"I found two other places where unfinished orders are dropped: the cart timeout and the payment retry.","error":null},
  {"id":"399e17-89a362b1","parentId":"399e17","name":"Trace checkout flow","task":"Trace the checkout flow from cart to payment","harness":"claude","helperType":"Explore","model":"claude-haiku-4-5-20251001","machineId":"cloud-1","state":"finished","now":"Searching for “onPaymentFailed”","thinking":false,"ageMin":15.9,"sinceMin":12.4,"endedMin":12.4,"turns":0,"toolCalls":5,"toolKinds":{"read":3,"search":2},"recent":[["Reading checkout.ts",true],["Searching for “createOrder”",true],["Reading charge.ts",true],["Reading order.ts",true],["Searching for “onPaymentFailed”",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":55,"outputTokens":1494,"cacheReadTokens":66092,"cacheWriteTokens":4596,"costUsd":0,"contextTokens":null,"contextWindow":null,"contextPct":null},"budgetUsd":null,"plan":null,"files":null,"checks":null,"rules":null,"ask":null,"approvals":{"auto":5,"byYou":0,"denied":0},"says":"The order is only saved after the payment goes through, so anything that fails before that is lost.","error":null},
  {"id":"5f49d4","parentId":null,"name":"Search cleanup","task":"Clean up the old search code now that the new search page is live","harness":"claude","helperType":null,"model":"claude-sonnet-4-5","machineId":"laptop","state":"question","now":"Reading search-traffic.csv","thinking":false,"ageMin":26.1,"sinceMin":11.1,"endedMin":null,"turns":1,"toolCalls":21,"toolKinds":{"search":6,"read":8,"plan":3,"edit":3,"run":1},"recent":[["Editing Help.tsx",true],["Editing index.ts",true],["Running the tests",true],["Searching for “v1/search”",true],["Reading results.tsx",true],["Reading SearchBox.tsx",true],["Updating its plan",true],["Reading search-traffic.csv",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":203,"outputTokens":5614,"cacheReadTokens":578279,"cacheWriteTokens":18584,"costUsd":0.41,"contextTokens":36033,"contextWindow":200000,"contextPct":0.180165},"budgetUsd":2,"plan":{"items":[{"id":"1","text":"Find every use of the old search","status":"completed"},{"id":"2","text":"Point links to the new search page","status":"completed"},{"id":"3","text":"Remove the old search code","status":"in_progress"},{"id":"4","text":"Run the tests","status":"pending"}],"done":2,"total":4},"files":{"changed":3,"adds":25,"dels":19,"list":[{"path":"src/components/Header.tsx","adds":6,"dels":5},{"path":"src/pages/Help.tsx","adds":16,"dels":9},{"path":"src/search/index.ts","adds":3,"dels":5}]},"checks":null,"rules":null,"ask":{"id":"sim-2-0f05f5","type":"question","sentence":"Should the old search address keep working for existing customers, or can I remove it?","options":["Keep it working","Remove it"],"ageMin":11.1},"approvals":{"auto":21,"byYou":0,"denied":0},"says":"I pointed every link at the new search page.","error":null},
  {"id":"2bb0b8","parentId":null,"name":"Flaky test","task":"Find out why the cart total test fails now and then, and make it reliable","harness":"claude","helperType":null,"model":"claude-sonnet-4-5","machineId":"cloud-3","state":"maybe_stuck","now":"Running the tests","thinking":false,"ageMin":38.1,"sinceMin":6.1,"endedMin":null,"turns":1,"toolCalls":24,"toolKinds":{"run":4,"read":9,"plan":3,"helper":1,"search":4,"edit":3},"recent":[["Reading discounts.ts",true],["Updating its plan",true],["Editing total.test.ts",true],["Running the tests",false],["Editing total.ts",true],["Running the tests",false],["Editing total.test.ts",true],["Running the tests",false]],"spark":[0,1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":1,"working":0,"done":1},"usage":{"inputTokens":262,"outputTokens":7016,"cacheReadTokens":662201,"cacheWriteTokens":15232,"costUsd":0.93,"contextTokens":38344,"contextWindow":200000,"contextPct":0.19172},"budgetUsd":2,"plan":{"items":[{"id":"1","text":"Run the cart tests many times","status":"completed"},{"id":"2","text":"Find what changes between runs","status":"completed"},{"id":"3","text":"Fix the cause","status":"in_progress"},{"id":"4","text":"Run the tests 50 times","status":"pending"}],"done":2,"total":4},"files":{"changed":2,"adds":32,"dels":10,"list":[{"path":"test/cart/total.test.ts","adds":15,"dels":7},{"path":"src/cart/total.ts","adds":17,"dels":3}]},"checks":null,"rules":null,"ask":{"id":"sim-3-2555ea","type":"stuck","sentence":"Flaky test has hit the same error three times.","detail":"The cart total test keeps failing: it expected 42.10 but got 42.09.","options":["Stop it","Let it keep trying"],"ageMin":6.1},"approvals":{"auto":24,"byYou":0,"denied":0},"says":null,"error":null},
  {"id":"2bb0b8-b6006be2","parentId":"2bb0b8","name":"Look for timing problems","task":"Look for timing problems in the cart tests","harness":"claude","helperType":"Explore","model":"claude-haiku-4-5-20251001","machineId":"cloud-3","state":"finished","now":"Searching for “useFakeTimers”","thinking":false,"ageMin":31.9,"sinceMin":26.9,"endedMin":26.9,"turns":0,"toolCalls":5,"toolKinds":{"search":3,"read":2},"recent":[["Searching for “setTimeout”",true],["Searching for “Date.now”",true],["Reading total.test.ts",true],["Reading clock.ts",true],["Searching for “useFakeTimers”",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":42,"outputTokens":1068,"cacheReadTokens":65213,"cacheWriteTokens":3311,"costUsd":0,"contextTokens":null,"contextWindow":null,"contextPct":null},"budgetUsd":null,"plan":null,"files":null,"checks":null,"rules":null,"ask":null,"approvals":{"auto":5,"byYou":0,"denied":0},"says":"There are no timers or sleeps in the cart tests, so the failures come from the price total itself.","error":null},
  {"id":"228202","parentId":null,"name":"Invoice export","task":"Make the invoice export work for large accounts by sending invoices in small batches","harness":"claude","helperType":null,"model":"claude-opus-5-5","machineId":"cloud-1","state":"done_checked","now":"Searching for “BATCH_SIZE”","thinking":false,"ageMin":64.1,"sinceMin":22.1,"endedMin":22.1,"turns":1,"toolCalls":24,"toolKinds":{"read":7,"search":4,"plan":5,"run":3,"edit":5},"recent":[["Updating its plan",true],["Reading pdf.ts",true],["Checking the code style",true],["Reading pool.ts",true],["Searching for “timeout”",true],["Reading pool.ts",true],["Updating its plan",true],["Searching for “BATCH_SIZE”",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":270,"outputTokens":7649,"cacheReadTokens":688149,"cacheWriteTokens":20818,"costUsd":0.71,"contextTokens":38914,"contextWindow":200000,"contextPct":0.19457},"budgetUsd":2,"plan":{"items":[{"id":"1","text":"Find why big exports time out","status":"completed"},{"id":"2","text":"Send invoices in small batches","status":"completed"},{"id":"3","text":"Add tests for large accounts","status":"completed"},{"id":"4","text":"Run all the tests","status":"completed"}],"done":4,"total":4},"files":{"changed":5,"adds":156,"dels":2,"list":[{"path":"src/invoices/batch.ts","adds":47,"dels":0},{"path":"src/invoices/export.ts","adds":8,"dels":2},{"path":"src/invoices/query.ts","adds":13,"dels":0},{"path":"migrations/0042_invoice_lookup_index.sql","adds":24,"dels":0},{"path":"test/invoices/large-account.test.ts","adds":64,"dels":0}]},"checks":{"state":"passed","results":[{"name":"Unit tests","ok":true,"ms":48200},{"name":"Type check","ok":true,"ms":9400}]},"rules":{"kept":[{"say":"Keep the public invoice API the same"}],"broken":[{"say":"Do not touch migrations/","paths":["migrations/0042_invoice_lookup_index.sql"]}]},"ask":null,"approvals":{"auto":24,"byYou":0,"denied":0},"says":"Invoices now go out in small batches, so large accounts can export without timing out.","error":null},
  {"id":"2f4ffc","parentId":null,"name":"Help pages","task":"Rewrite the help pages for getting started, billing and exports in plain language","harness":"codex","helperType":null,"model":"gpt-5-codex","machineId":"laptop","state":"done_claimed","now":"Searching for “invoice”","thinking":false,"ageMin":44.1,"sinceMin":17.1,"endedMin":17.1,"turns":1,"toolCalls":18,"toolKinds":{"search":3,"read":7,"plan":4,"edit":3,"run":1},"recent":[["Reading faq.md",true],["Editing billing.md",true],["Updating its plan",true],["Editing exports.md",true],["Checking what changed",true],["Updating its plan",true],["Reading style-guide.md",true],["Searching for “invoice”",true]],"spark":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":161,"outputTokens":5060,"cacheReadTokens":428483,"cacheWriteTokens":15049,"costUsd":null,"contextTokens":31223,"contextWindow":200000,"contextPct":0.156115},"budgetUsd":2,"plan":{"items":[{"id":"1","text":"Read the current help pages","status":"completed"},{"id":"2","text":"Rewrite getting started","status":"completed"},{"id":"3","text":"Rewrite billing","status":"completed"},{"id":"4","text":"Rewrite exports","status":"completed"}],"done":4,"total":4},"files":{"changed":3,"adds":36,"dels":6,"list":[{"path":"docs/help/getting-started.md","adds":6,"dels":4},{"path":"docs/help/billing.md","adds":17,"dels":2},{"path":"docs/help/exports.md","adds":13,"dels":0}]},"checks":{"state":"none","results":[]},"rules":{"kept":[{"say":"Do not touch migrations/"}],"broken":[]},"ask":null,"approvals":{"auto":0,"byYou":0,"denied":0},"says":"I rewrote the help pages for getting started, billing and exports in plain language.","error":null},
  {"id":"902d13","parentId":null,"name":"Onboarding","task":"Make the first-run onboarding clearer for new customers and add tests for the sign-up flow","harness":"claude","helperType":null,"model":"claude-haiku-4-5-20251001","machineId":"laptop","state":"working","now":"Running the tests","thinking":false,"ageMin":12.1,"sinceMin":12.1,"endedMin":null,"turns":1,"toolCalls":44,"toolKinds":{"search":13,"read":19,"plan":3,"helper":2,"edit":4,"run":3},"recent":[["Searching for “skipOnboarding”",true],["Searching for “welcomeStep”",true],["Reading onboarding.css",true],["Searching for “skipOnboarding”",true],["Reading Checklist.tsx",true],["Reading onboarding.css",true],["Searching for “welcomeStep”",true],["Checking what changed",true]],"spark":[2,1,2,2,2,1,2,3,1,2,2,2,1,2,2,2,2,1,3,0],"helpers":{"total":2,"working":2,"done":0},"usage":{"inputTokens":456,"outputTokens":13277,"cacheReadTokens":1635502,"cacheWriteTokens":33214,"costUsd":0.3809,"contextTokens":54225,"contextWindow":200000,"contextPct":0.271125},"budgetUsd":5,"plan":{"items":[{"id":"1","text":"Read the current onboarding screens","status":"completed"},{"id":"2","text":"List the confusing steps","status":"completed"},{"id":"3","text":"Rewrite the welcome steps","status":"in_progress"},{"id":"4","text":"Add tests for the sign-up flow","status":"pending"},{"id":"5","text":"Check it on small screens","status":"pending"}],"done":2,"total":5},"files":{"changed":4,"adds":95,"dels":16,"list":[{"path":"src/onboarding/steps.ts","adds":2,"dels":0},{"path":"src/onboarding/copy.json","adds":18,"dels":3},{"path":"test/signup/flow.test.ts","adds":57,"dels":5},{"path":"src/onboarding/Welcome.tsx","adds":18,"dels":8}]},"checks":null,"rules":null,"ask":null,"approvals":{"auto":44,"byYou":0,"denied":0},"says":null,"error":null},
  {"id":"902d13-4936c2b5","parentId":"902d13","name":"Check welcome email copy","task":"Check the welcome email copy","harness":"claude","helperType":"Explore","model":"claude-haiku-4-5-20251001","machineId":"laptop","state":"working","now":"Reading welcome.mjml","thinking":false,"ageMin":6.5,"sinceMin":6.5,"endedMin":null,"turns":0,"toolCalls":11,"toolKinds":{"read":4,"search":7},"recent":[["Looking for files like emails/*.mjml",true],["Searching for “Welcome to”",true],["Searching for “planName”",true],["Reading welcome.mjml",true],["Looking for files like emails/*.mjml",true],["Searching for “planName”",true],["Reading strings.json",true],["Searching for “Welcome to”",true]],"spark":[0,0,0,0,0,0,0,1,1,1,1,0,1,1,1,0,1,0,1,2],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":117,"outputTokens":3521,"cacheReadTokens":136381,"cacheWriteTokens":9101,"costUsd":0,"contextTokens":null,"contextWindow":null,"contextPct":null},"budgetUsd":null,"plan":null,"files":null,"checks":null,"rules":null,"ask":null,"approvals":{"auto":11,"byYou":0,"denied":0},"says":null,"error":null},
  {"id":"902d13-58d802d4","parentId":"902d13","name":"Write sign-up flow tests","task":"Write sign-up flow tests","harness":"claude","helperType":"general-purpose","model":"claude-haiku-4-5-20251001","machineId":"laptop","state":"working","now":"Running the tests","thinking":false,"ageMin":4.4,"sinceMin":4.4,"endedMin":null,"turns":0,"toolCalls":5,"toolKinds":{"edit":2,"search":1,"read":1,"run":1},"recent":[["Writing flow.test.ts",true],["Editing flow.test.ts",true],["Searching for “onSubmit”",true],["Reading render.ts",true]],"spark":[0,0,0,0,0,0,0,0,0,0,1,0,0,0,1,0,1,1,0,1],"helpers":{"total":0,"working":0,"done":0},"usage":{"inputTokens":47,"outputTokens":1554,"cacheReadTokens":61798,"cacheWriteTokens":3540,"costUsd":0,"contextTokens":null,"contextWindow":null,"contextPct":null},"budgetUsd":null,"plan":null,"files":null,"checks":null,"rules":null,"ask":null,"approvals":{"auto":5,"byYou":0,"denied":0},"says":null,"error":null},
];
const DEMO_MACHINES = [{"id":"laptop","name":"Your laptop","kind":"laptop","awake":true,"simulated":false,"cpuPct":62,"memPct":98,"costPerHourUsd":null,"agents":2,"note":"2 agents"},{"id":"cloud-1","name":"Cloud 1","kind":"cloud","awake":true,"simulated":true,"cpuPct":45,"memPct":46,"costPerHourUsd":0.4,"agents":1,"note":"1 agent"},{"id":"cloud-2","name":"Cloud 2","kind":"cloud","awake":false,"simulated":true,"cpuPct":null,"memPct":null,"costPerHourUsd":0.4,"agents":0,"note":"asleep"},{"id":"cloud-3","name":"Cloud 3","kind":"cloud","awake":true,"simulated":true,"cpuPct":45,"memPct":46,"costPerHourUsd":0.4,"agents":1,"note":"1 agent"}];

const HELPER_NAMES = ['Trace checkout flow', 'Find similar bugs', 'Check welcome email copy', 'Write sign-up flow tests', 'Look for timing problems', 'Review the cache layer'];
const WORDS = ['Checkout', 'Search', 'Invoice', 'Onboarding', 'Billing', 'Login', 'Profile', 'Export', 'Cache', 'Payments', 'Emails', 'Reports', 'Settings', 'Upload', 'Sync', 'Audit', 'Pricing', 'Webhooks', 'Mobile nav', 'Dark mode', 'Docs site', 'Rate limits', 'Signup', 'Analytics', 'Feature flags'];
const NOWS = ['Reading checkout.ts', 'Running the tests', 'Editing PaymentForm.tsx', 'Searching for “retryPolicy”', 'Thinking', 'Looking at the files', 'Installing packages', 'Asking a helper to trace the login flow'];

/** A full AgentView, as newAgentView in src/shared/events.mjs makes it, with times relative to `now`. */
function view(o, now) {
  const started = now - (o.ageMin ?? 10) * MIN;
  const v = {
    id: o.id, parentId: o.parentId || null, rootId: o.rootId || o.parentId || o.id, depth: o.parentId ? 1 : 0,
    name: o.name, task: o.task || o.name, harness: o.harness || 'claude', kind: o.parentId ? 'helper' : 'agent',
    helperType: o.helperType || null, model: o.model || (o.parentId ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-5'),
    machineId: o.machineId || 'laptop', state: o.state || 'working', stateReason: null,
    stateSince: now - (o.sinceMin ?? 2) * MIN, now: o.now || 'Reading checkout.ts', thinking: !!o.thinking,
    startedAt: started, endedAt: o.endedMin != null ? now - o.endedMin * MIN : null, lastEventAt: now - 5000,
    turns: o.turns ?? 1, toolCalls: o.toolCalls ?? o.calls ?? 12, toolKinds: o.toolKinds || {},
    recent: (o.recent || []).map(([sentence, ok], i, all) => ({ ts: now - (all.length - i) * 20000, sentence, ok })),
    spark: o.spark || Array.from({ length: 20 }, (_, i) => (i > 14 ? (i % 3) + 1 : 0)), sparkEndsAt: now,
    helpers: o.helpers || { total: 0, working: 0, done: 0 },
    usage: o.usage || { inputTokens: 12000, outputTokens: 3400, cacheReadTokens: 480000, cacheWriteTokens: 22000, costUsd: o.parentId ? 0 : (o.cost ?? 0.42), contextTokens: 52000, contextWindow: 200000, contextPct: 0.26 },
    budgetUsd: o.parentId ? null : (o.budgetUsd ?? 2), plan: o.plan || null, files: o.files || null, checks: o.checks || null, rules: o.rules || null,
    ask: o.ask ? { ...o.ask, createdAt: now - (o.ask.ageMin ?? 1) * MIN } : null,
    approvals: o.approvals || { auto: 8, byYou: 0, denied: 0 }, says: o.says || null, error: o.error || null, sessionId: null, workspace: null,
    work: o.work ? JSON.parse(JSON.stringify(o.work)) : null,
    earlier: !!o.earlier, canContinue: o.earlier ? o.canContinue !== false : null,
    continueReason: o.earlier && o.canContinue === false ? (o.continueReason || 'Its folder is gone, so it cannot continue.') : null,
  };
  delete v.ask?.ageMin;
  if (['finished', 'failed', 'stopped', 'done_checked', 'done_claimed', 'checks_failed'].includes(v.state) && v.endedAt == null) v.endedAt = now - MIN;
  return v;
}

function countHelpers(list) {
  const active = new Set(['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']);
  for (const a of list) {
    const kids = list.filter(k => k.parentId === a.id);
    a.helpers = { total: kids.length, working: kids.filter(k => active.has(k.state)).length, done: kids.filter(k => !active.has(k.state)).length };
  }
  return list;
}

const demo = () => DEMO_AGENTS.map(a => JSON.parse(JSON.stringify(a)));
const by = (list, id) => list.find(a => a.id === id);
const backToWork = (a, now) => Object.assign(a, { state: 'working', ask: null, now, sinceMin: 0.6, approvals: { ...(a.approvals || {}), byYou: (a.approvals?.byYou || 0) + 1 } });

const BUSY = [
  { id: 'b-speed', name: 'Report speed-up', machineId: 'cloud-3', state: 'working', now: 'Reading report.sql', ageMin: 31, toolCalls: 37, plan: { items: [{ text: 'Time the report', status: 'completed' }, { text: 'Find the slow query', status: 'in_progress' }, { text: 'Add an index', status: 'pending' }], done: 1, total: 3 } },
  { id: 'b-login', name: 'Login page', machineId: 'laptop', state: 'working', now: 'Editing LoginForm.tsx', ageMin: 22, toolCalls: 29 },
  { id: 'b-login-1', parentId: 'b-login', name: 'Update login tests', machineId: 'laptop', state: 'needs_ok', now: 'Deleting old tests', ageMin: 9, sinceMin: 1.2,
    ask: { id: 'busy-1', type: 'permission', sentence: 'Update login tests wants to delete files', detail: 'rm test/login/legacy-*.test.ts', why: 'Deleting files cannot be undone from Workbench.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 1.2 } },
  { id: 'b-login-2', parentId: 'b-login', name: 'Find old login code', machineId: 'laptop', state: 'finished', ageMin: 20, endedMin: 15, says: 'The old login code lives in session.ts and is no longer used.' },
  { id: 'b-dark', name: 'Dark mode', machineId: 'cloud-1', state: 'failed', now: 'Running the build', ageMin: 48, endedMin: 9, error: 'The build ran out of memory.' },
  { id: 'b-digest', name: 'Email digest', machineId: 'laptop', state: 'stopped', ageMin: 70, endedMin: 25 },
  { id: 'b-price', name: 'Price rounding', machineId: 'cloud-3', state: 'waiting_helpers', now: 'Waiting for 2 helpers', ageMin: 18, sinceMin: 5 },
  { id: 'b-price-1', parentId: 'b-price', name: 'Check tax rules', machineId: 'cloud-3', state: 'working', now: 'Reading tax.ts', ageMin: 5 },
  { id: 'b-price-2', parentId: 'b-price', name: 'Compare old totals', machineId: 'cloud-3', state: 'working', now: 'Running the tests', ageMin: 4 },
  { id: 'b-history', name: 'Order history', machineId: 'laptop', state: 'working', now: 'Searching for “orderBy”', ageMin: 14, toolCalls: 19 },
  { id: 'b-history-1', parentId: 'b-history', name: 'List slow queries', machineId: 'laptop', state: 'working', now: 'Reading orders.sql', ageMin: 6 },
];

const LONG_COMMAND = 'npm run db:migrate -- --env test && curl -fsSL https://example.com/install-the-tools.sh | sh -s -- --prefix "$HOME/.local" --with-plugins=alpha,beta,gamma,delta --yes\n'
  + 'node scripts/seed.js --rows 50000 --tables orders,customers,invoices,refunds,payments,addresses --truncate-first\t# then rebuild the indexes for every table in the test database';

/** The worlds the page can be shown. */
export const SCENARIOS = ['demo', 'helper', 'longq', 'many', 'many-asks', 'busy', 'idle', 'alldone', 'zero', 'long', 'longcmd', 'helpers6', 'setaside', 'live', 'race', 'race2', 'background', 'earlier', 'earlier-many', 'earlier-only'];

export function scenario(name, now = Date.now()) {
  let raw = [];
  if (MERGE_SCENARIOS.includes(name)) return mergeWorld(name, now);
  if (name === 'demo' || name === 'helper' || name === 'longq' || name === 'busy' || name === 'idle') {
    raw = demo();
    if (name === 'helper' || name === 'longq' || name === 'idle') backToWork(by(raw, '399e17'), 'Running checkout tests');
    if (name === 'helper') {
      Object.assign(by(raw, '902d13-58d802d4'), { state: 'needs_ok', now: 'Installing a test package', sinceMin: 1.05,
        ask: { id: 'sim-4-7c1d09', type: 'permission', sentence: 'Write sign-up flow tests wants to install packages', detail: 'npm install --save-dev @testing-library/user-event',
          why: 'Installing packages can run code from the internet.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 1.05 } });
    }
    if (name === 'longq') Object.assign(by(raw, '5f49d4').ask, {
      sentence: 'Should the old search address keep working for existing customers who saved it in their bookmarks and old emails, or can I remove it now and send those people to the new search page with a short notice?',
      options: ['Keep the old address working', 'Remove it and add a notice'] });
    if (name === 'idle') {
      backToWork(by(raw, '5f49d4'), 'Removing dead code');
      backToWork(by(raw, '2bb0b8'), 'Rerunning the tests');
      raw = raw.filter(a => a.id !== '228202' && a.id !== '2f4ffc');
    }
    if (name === 'busy') raw.push(...BUSY);
    return world(raw, now);
  }
  if (name === 'many' || name === 'many-asks') {
    const states = ['working', 'working', 'working', 'done_checked', 'working', 'question', 'working', 'done_claimed', 'needs_ok', 'working', 'waiting_helpers', 'maybe_stuck', 'working', 'stopped', 'working', 'failed', 'working', 'working', 'done_checked', 'working', 'working', 'question', 'working', 'working', 'done_claimed'];
    const machinesOf = ['laptop', 'cloud-1', 'laptop', 'cloud-3', 'laptop'];
    for (let i = 0; i < 25; i++) {
      const st = name === 'many' ? states[i] : (i % 3 === 0 ? 'needs_ok' : states[i]);
      raw.push({ id: 'r' + i, name: WORDS[i] + (i % 4 === 0 ? ' redesign work' : ' fix'), state: st, now: NOWS[i % NOWS.length], ageMin: 60 - i, machineId: machinesOf[i % 5],
        ask: st === 'needs_ok' ? { id: 'k' + i, type: 'permission', sentence: `${WORDS[i]} fix wants to run a command`, detail: 'npm run migrate -- --env=staging', why: 'The command is not on the list of safe ones.', options: ['Allow', 'Deny'], ageMin: 1 + i / 10 }
          : st === 'question' ? { id: 'k' + i, type: 'question', sentence: 'Should I keep the old endpoint?', options: ['Yes', 'No'], ageMin: 2 }
          : st === 'maybe_stuck' ? { id: 'k' + i, type: 'stuck', sentence: `${WORDS[i]} fix has hit the same error three times.`, options: ['Stop it', 'Let it keep trying'], ageMin: 3 } : null });
      for (let j = 0; j < 4; j++) {
        const hs = st === 'working' || st === 'waiting_helpers' ? (j % 2 ? 'finished' : 'working') : 'finished';
        raw.push({ id: `r${i}h${j}`, parentId: 'r' + i, name: HELPER_NAMES[(i + j) % HELPER_NAMES.length], state: hs, now: NOWS[(i + j + 1) % NOWS.length], ageMin: 50 - i - j, machineId: machinesOf[i % 5] });
      }
    }
    return world(raw, now);
  }
  if (name === 'alldone') {
    ['Checkout fix', 'Search cleanup', 'Invoice export', 'Help pages'].forEach((n, i) => {
      raw.push({ id: 'r' + i, name: n, state: i % 2 ? 'done_claimed' : 'done_checked', says: 'All done: the change is small and every test passes.', machineId: i % 2 ? 'laptop' : 'cloud-1', ageMin: 30 - i, endedMin: 3 + i,
        files: { changed: 2 + i, adds: 20 + 3 * i, dels: 4, list: [{ path: 'src/a.ts', adds: 10, dels: 2 }, { path: 'src/b.ts', adds: 10, dels: 2 }] } });
      raw.push({ id: `r${i}h0`, parentId: 'r' + i, name: HELPER_NAMES[i], state: 'finished', ageMin: 25 - i, endedMin: 10 });
    });
    return world(raw, now);
  }
  if (name === 'long') {
    raw.push({ id: 'r0', name: 'Investigate intermittent payment provider timeouts', state: 'question', machineId: 'cloud-1',
      ask: { id: 'k0', type: 'question', sentence: 'The payment provider sometimes returns a 504 after 30 seconds, and our retry wrapper then charges the card a second time because the idempotency key is regenerated on each attempt; should I change the wrapper to reuse the key across retries, or would you rather I add a database lock?', options: ['Reuse the idempotency key across retries', 'Add a database lock around the charge'], ageMin: 3 } });
    raw.push({ id: 'r1', name: 'Internationalization infrastructure overhaul', state: 'working', now: 'Editing src/i18n/loaders/fallbackChainResolver.ts' });
    raw.push({ id: 'h1', parentId: 'r1', name: 'Catalogue untranslated strings in every screen', state: 'working', now: 'Searching for “t(”' });
    raw.push({ id: 'r2', name: 'Upgrade the authentication library', state: 'done_claimed', machineId: 'laptop', says: 'I upgraded the library to version 5, replaced the deprecated session helpers in eleven files, and every test passes locally, but the admin login page still logs a deprecation warning that comes from a plugin we do not own.' });
    raw.push({ id: 'r3', name: 'Make the export page remember filters between visits', state: 'working', machineId: 'cloud-3', now: 'Reading ExportFilters.tsx' });
    return world(raw, now);
  }
  if (name === 'longcmd') {
    raw.push({ id: 'r0', name: 'Seed test data', state: 'needs_ok', machineId: 'laptop', now: 'Seeding the test database',
      ask: { id: 'k0', type: 'permission', sentence: 'Seed test data wants to run several commands in one go', detail: LONG_COMMAND,
        why: 'Part of the command downloads a script from the internet and runs it, and part of it is not on the list of safe commands.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 2 } });
    raw.push({ id: 'r1', name: 'Search cleanup', state: 'question', machineId: 'laptop', ask: { id: 'k1', type: 'question', sentence: 'Can I remove the old search address?', options: [], ageMin: 1 } });
    raw.push({ id: 'r2', name: 'Docs site', state: 'working', machineId: 'cloud-1', now: 'Writing endpoints.md' });
    return world(raw, now);
  }
  if (name === 'helpers6') {
    raw.push({ id: 'r0', name: 'Checkout fix', state: 'waiting_helpers', now: 'Waiting for 6 helpers' });
    for (let j = 0; j < 6; j++) raw.push({ id: 'h' + j, parentId: 'r0', name: HELPER_NAMES[j], state: j === 5 ? 'needs_ok' : 'working', now: NOWS[j], ageMin: 9 - j,
      ask: j === 5 ? { id: 'k5', type: 'permission', sentence: 'Review the cache layer wants to delete files', detail: 'rm -rf .cache', why: 'Deleting files cannot be undone from Workbench.', options: ['Allow', 'Deny'], ageMin: 1 } : null });
    raw.push({ id: 'r1', name: 'Search cleanup', state: 'working', machineId: 'cloud-1' });
    return world(raw, now);
  }
  if (name === 'setaside') {
    raw.push({ id: 'X', name: 'Invoice export', state: 'checks_failed', machineId: 'cloud-1', endedMin: 2, checks: { state: 'failed', results: [{ name: 'Unit tests', ok: false, ms: 4200 }, { name: 'Lint', ok: true, ms: 900 }] },
      files: { changed: 3, adds: 40, dels: 9, list: [{ path: 'src/invoice/export.ts', adds: 30, dels: 7 }] } });
    raw.push({ id: 'D', name: 'Help pages', state: 'done_claimed', machineId: 'laptop', endedMin: 5, says: 'I rewrote the three help pages in plain words.' });
    raw.push({ id: 'W', name: 'Onboarding', state: 'working', machineId: 'laptop', now: 'Running the tests' });
    return world(raw, now);
  }
  if (name === 'live') {
    // live mode: one machine, a repository with uncommitted changes, real harnesses (Codex reports no cost)
    raw.push({ id: 'a1b2c3', name: 'Fix the login redirect loop', state: 'needs_ok', machineId: 'laptop', now: 'Reading auth.ts',
      ask: { id: 'ok-1a2b3c4d', type: 'permission', sentence: 'Fix the login redirect loop wants to read a file outside its own folder', detail: '/Users/someone/.ssh/config',
        why: 'The file is outside the agent’s own folder.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 0.5 } });
    raw.push({ id: 'd4e5f6', name: 'Parser tests', harness: 'codex', model: 'gpt-5-codex', state: 'working', machineId: 'laptop', now: 'Running the tests',
      usage: { inputTokens: 52000, outputTokens: 4100, cacheReadTokens: 180000, cacheWriteTokens: 0, costUsd: null, contextTokens: 52000, contextWindow: 272000, contextPct: 0.19 } });
    raw.push({ id: '0a9b8c', name: 'Tidy the README', state: 'question', machineId: 'laptop', ask: { id: 'q-77aa', type: 'question', sentence: 'Should the setup steps stay in the README, or move to a new docs/setup.md?', options: [], ageMin: 3 } });
    const st = world(raw, now);
    st.mode = 'live';
    st.repo = { name: 'checkout-service-payments-and-refunds-monorepo', root: '/Users/someone/code/checkout', head: 'abc1234', branch: 'main', dirty: 3 };
    st.machines = [{ ...LAPTOP, agents: 3, note: '3 agents' }];
    return st;
  }
  if (name === 'background') {
    // the engine's newer words: work left running in the background (not "might be stuck"), a root waiting on a command
    // it started, a question from an agent that changed files, and cost Workbench estimated before it was reported
    raw.push({ id: 'g1', name: 'Dev server', state: 'maybe_stuck', machineId: 'laptop', now: 'Waiting for a background command',
      ask: { id: 'bg-1', type: 'stuck', about: 'background', sentence: 'Dev server has finished, but a command it started is still running.', detail: 'Runs the development server (npm run dev)', options: ['It is done', 'Keep waiting'], ageMin: 4 },
      usage: { inputTokens: 9000, outputTokens: 2100, cacheReadTokens: 120000, cacheWriteTokens: 8000, costUsd: null, unreportedUsd: 0.05, contextTokens: 30000, contextWindow: 200000, contextPct: 0.15 } });
    raw.push({ id: 'g2', name: 'Release notes', state: 'waiting_helpers', machineId: 'cloud-1', now: 'Waiting for its helper and a background command', sinceMin: 3 });
    raw.push({ id: 'g2h', parentId: 'g2', name: 'Collect merged changes', state: 'working', machineId: 'cloud-1', now: 'Reading CHANGELOG.md' });
    raw.push({ id: 'g3', name: 'Search cleanup', state: 'question', machineId: 'laptop', ask: { id: 'q-g3', type: 'question', sentence: 'Should the old search address keep working?', options: ['Keep it working', 'Remove it'], ageMin: 0.3 },
      files: { changed: 2, adds: 14, dels: 30, list: [{ path: 'src/search/index.ts', adds: 4, dels: 22 }, { path: 'src/search/redirects.ts', adds: 10, dels: 8 }] },
      usage: { inputTokens: 5000, outputTokens: 1200, cacheReadTokens: 90000, cacheWriteTokens: 4000, costUsd: 0.21, unreportedUsd: 0.03, contextTokens: 20000, contextWindow: 200000, contextPct: 0.1 } });
    return world(raw, now);
  }
  if (name === 'earlier' || name === 'earlier-many' || name === 'earlier-only') {
    // Agents restored from history (src/core/history.mjs): finished or stopped, from another run, with no process now.
    // A checks_failed one must not ask for the person; one whose folder is gone cannot continue.
    if (name !== 'earlier-only') {
      raw.push({ id: 'e-live1', name: 'Checkout fix', state: 'needs_ok', machineId: 'laptop', ask: { id: 'e-p1', type: 'permission', sentence: 'Checkout fix wants to run a command', detail: 'npm run db:migrate -- --env test', why: 'Running it changes the test database.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 1 } });
      raw.push({ id: 'e-live2', name: 'Docs site', state: 'working', machineId: 'laptop', now: 'Editing the getting started page' });
    }
    const past = [
      { name: 'Invoice export', state: 'done_checked', endedMin: 2 * 24 * 60, says: 'Invoices now go out in small batches, so large accounts no longer time out.' },
      { name: 'Help pages', state: 'done_claimed', endedMin: 3 * 60, harness: 'codex', says: 'I rewrote the three help pages in plain language.' },
      { name: 'Email digest', state: 'stopped', endedMin: 26 * 60, canContinue: false, continueReason: 'Its folder is gone, so it cannot continue.' },
      { name: 'Price rounding', state: 'checks_failed', endedMin: 50, checks: { state: 'failed', results: [{ name: 'tests', ok: false, ms: 4100 }] } },
      { name: 'Dark mode', state: 'failed', endedMin: 9 * 60, error: 'The build ran out of memory.' },
    ];
    const n = name === 'earlier-many' ? 16 : past.length;
    for (let i = 0; i < n; i++) {
      const o = past[i % past.length];
      raw.push({ id: `e-old${i}`, earlier: true, machineId: 'laptop', ageMin: o.endedMin + 30, sinceMin: o.endedMin, toolCalls: 20 + i, ...o, name: i < past.length ? o.name : `${o.name} ${Math.floor(i / past.length) + 1}`, endedMin: o.endedMin + i });
    }
    return world(raw, now);
  }
  if (name === 'race') {
    raw.push({ id: 'A', name: 'Search cleanup', state: 'question', ask: { id: 'qa', type: 'question', sentence: 'Should I keep the old search address working?', options: ['Yes', 'No'], ageMin: 1 } });
    raw.push({ id: 'C', name: 'Docs site', state: 'working' });
    return world(raw, now);
  }
  if (name === 'race2') {
    raw.push({ id: 'A', name: 'Checkout fix', state: 'needs_ok', ask: { id: 'pa', type: 'permission', sentence: 'Checkout fix wants to run the tests', detail: 'npm test -- --silent', options: ['Allow', 'Deny'], ageMin: 1 } });
    raw.push({ id: 'C', name: 'Docs site', state: 'working' });
    return world(raw, now);
  }
  return world([], now);   // zero: a fresh start
}

const LAPTOP = { id: 'laptop', name: 'Your laptop', kind: 'laptop', awake: true, simulated: false, cpuPct: 31, memPct: 62, costPerHourUsd: null, agents: 0, note: '' };
function world(raw, now) {
  const agents = countHelpers(raw.map(o => view(o, now)));
  const machines = (raw.some(a => a.machineId && a.machineId !== 'laptop') || raw === null ? DEMO_MACHINES : [LAPTOP]).map(m => ({ ...m }));
  for (const m of machines) m.agents = agents.filter(a => !a.parentId && a.machineId === m.id && !['done_checked', 'done_claimed', 'checks_failed', 'failed', 'stopped'].includes(a.state)).length;
  return { mode: 'demo', repo: null, harnesses: { claude: true, codex: true, sim: true }, agents, machines, spendTodayUsd: agents.filter(a => !a.parentId).reduce((s, a) => s + (a.usage.costUsd || 0) + (a.usage.unreportedUsd || 0), 0),
    spendTodayEstimated: agents.some(a => !a.parentId && a.usage.unreportedUsd > 0), defaultBudgetUsd: 2 };
}

// ---------------------------------------------------------------- D2: merge and throw-away (the lid, its cards, the checks)
// Live repositories whose finished agents have work (AgentView.work) in every state it can be in.
//   merge           on main: unmerged, merged, a merge that conflicts, one your own changes block, thrown away, and an
//                   earlier agent whose folder is still there
//   merge-more      on a long branch: a failed check (Merge anyway), failed and stopped agents with folders, a merge git
//                   refused for want of a name and email, an unmerged one, and one still working
//   merge-detached  not on a branch, and merge-noid with no name and email for git: no Merge, and the lid says why
const MERGE_SCENARIOS = ['merge', 'merge-more', 'merge-detached', 'merge-noid'];
SCENARIOS.push(...MERGE_SCENARIOS);
const NO_IDENTITY = 'Git does not know your name and email yet, so Workbench cannot make the merge commit. Set user.name and user.email with git config, then try again.';
function mergeWorld(name, now) {
  const raw = [];
  const work = (slug, id, o = {}) => ({ branch: `workbench/${slug}-${id}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
  const files = list => ({ changed: list.length, adds: list.reduce((s, x) => s + x.adds, 0), dels: list.reduce((s, x) => s + x.dels, 0), list });
  const invoice = id => ({ id, name: 'Invoice export', state: 'done_checked', endedMin: 2, says: 'Invoices now go out in small batches, so large accounts can export without timing out.',
    files: files([{ path: 'src/invoices/batch.ts', adds: 22, dels: 0 }, { path: 'src/invoices/export.ts', adds: 8, dels: 2 }, { path: 'test/invoices/large-account.test.ts', adds: 10, dels: 0 }]),
    checks: { state: 'passed', results: [{ name: 'Unit tests', ok: true, ms: 48200 }] }, work: work('invoice-export', id) });
  let repo = { name: 'invoices-api', head: 'abc1234', branch: 'main', dirty: 2, identity: true };
  if (name === 'merge') {
    raw.push(invoice('m1a2b3'));
    raw.push({ id: 'm4c5d6', name: 'Help pages', harness: 'codex', model: 'gpt-5-codex', state: 'done_claimed', endedMin: 30, says: 'I rewrote the three help pages in plain language.',
      files: files([]), work: work('help-pages', 'm4c5d6', { merged: { into: 'main', merge: 'e4f1c3a9b8d7e4f1c3a9b8d7e4f1c3a9b8d7e4f1', at: now - 4 * MIN, files: 3, adds: 36, dels: 6 } }) });
    raw.push({ id: 'm7e8f9', name: 'Search cleanup', state: 'done_checked', endedMin: 6, says: 'The old search code is gone, and its links point at the new page.',
      files: files([{ path: 'src/search/index.ts', adds: 4, dels: 22 }, { path: 'src/search/redirects.ts', adds: 10, dels: 8 }]),
      work: work('search-cleanup', 'm7e8f9', { problem: { why: 'conflict', sentence: 'Search cleanup’s work does not merge cleanly into main.', paths: ['src/search/index.ts', 'src/search/redirects.ts'], at: now - 3 * MIN } }) });
    raw.push({ id: 'mab0c1', name: 'Price rounding', state: 'done_claimed', endedMin: 9, says: 'Totals now round once, at the end.',
      files: files([{ path: 'src/cart/total.ts', adds: 17, dels: 3 }]),
      work: work('price-rounding', 'mab0c1', { problem: { why: 'blocked', sentence: 'Your own changes are in the way: src/cart/total.ts. Commit or put them aside, then merge again.', paths: ['src/cart/total.ts'], at: now - 2 * MIN } }) });
    raw.push({ id: 'md2e3f', name: 'Dark mode', state: 'stopped', endedMin: 15,
      work: work('dark-mode', 'md2e3f', { branch: null, folder: false, thrownAway: { at: now - 10 * MIN, saved: 'refs/workbench/discarded/md2e3f' } }) });
    raw.push({ id: 'mf4a5b', name: 'Email digest', state: 'done_checked', earlier: true, ageMin: 27 * 60, sinceMin: 26 * 60, endedMin: 26 * 60,
      says: 'The weekly digest now groups orders by customer.', files: files([{ path: 'src/email/digest.ts', adds: 30, dels: 4 }]), work: work('email-digest', 'mf4a5b') });
  } else if (name === 'merge-more') {
    repo = { ...repo, branch: 'release/2026-11-payments-and-refunds' };
    const from = { from: repo.branch };
    raw.push({ id: 'n1', name: 'Release notes', state: 'checks_failed', endedMin: 3, checks: { state: 'failed', results: [{ name: 'Unit tests', ok: false, ms: 4100 }, { name: 'Lint', ok: true, ms: 900 }] },
      files: files([{ path: 'CHANGELOG.md', adds: 40, dels: 0 }, { path: 'docs/releases/2026-11.md', adds: 22, dels: 1 }]), work: work('release-notes', 'n1', from) });
    raw.push({ ...invoice('n2'), endedMin: 1, work: work('invoice-export', 'n2', from) });
    raw.push({ id: 'n3', name: 'Order history', state: 'failed', endedMin: 12, error: 'The tests ran out of memory.', work: work('order-history', 'n3', from) });
    raw.push({ id: 'n4', name: 'Price rounding', state: 'stopped', endedMin: 20, work: work('price-rounding', 'n4', from) });
    raw.push({ id: 'n5', name: 'Billing page', state: 'done_checked', endedMin: 5, files: files([{ path: 'src/billing/Page.tsx', adds: 12, dels: 9 }]),
      work: work('billing-page', 'n5', { ...from, problem: { why: 'identity', sentence: NO_IDENTITY, paths: [], at: now - MIN } }) });
    raw.push({ id: 'n6', name: 'Onboarding', state: 'working', now: 'Running the tests', work: work('onboarding', 'n6', from) });
  } else {
    if (name === 'merge-detached') repo = { ...repo, head: '9f8e7d6', branch: null, dirty: 0 };
    else repo = { ...repo, identity: false };
    raw.push(invoice('d1'));
    raw.push({ id: 'd2', name: 'Help pages', harness: 'codex', model: 'gpt-5-codex', state: 'done_claimed', endedMin: 7, says: 'I rewrote the three help pages in plain language.',
      files: files([{ path: 'docs/help/billing.md', adds: 17, dels: 2 }]), work: work('help-pages', 'd2') });
  }
  const st = world(raw, now);
  st.mode = 'live';
  st.repo = repo;
  const n = st.agents.filter(a => !a.parentId && !a.earlier && ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck'].includes(a.state)).length;
  st.machines = [{ ...LAPTOP, agents: n, note: n ? `${n} agent${n === 1 ? '' : 's'}` : 'idle' }];
  return st;
}

/** Start the mock. Resolves to { port, close() }. */
export function startMock({ port = 0, host = '127.0.0.1', quiet = false } = {}) {
  const clients = new Set();
  const posted = [];
  const mode = { answer: 'ok', auth: 'ok', holdMs: 0, down: false, steps: false, merge: 'ok' };
  let name = 'demo';
  let state = scenario(name);
  let confirmSeq = 0;
  const confirms = new Map();
  const send = (event, data) => { const f = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(f); };
  // a launch the person confirmed, as the engine does it: the reply names the new agent (focusId) before the stream
  // brings it, about a third of a second later
  let startSeq = 0;
  const started = c => {
    const id = 'n' + (++startSeq);
    const task = /“(.+?)”/.exec(c?.sentence || '')?.[1] || 'the new task';
    const a = view({ id, name: task.replace(/^./, x => x.toUpperCase()).split(' ').slice(0, 4).join(' '), task, state: 'working', now: 'Starting', ageMin: 0, sinceMin: 0, toolCalls: 0 }, Date.now());
    setTimeout(() => { state.agents.push(a); countHelpers(state.agents); send('agents', [a]); }, 350);
    return { reply: 'Started it. It will show on the board in a moment.', agentIds: [id], focusId: id };
  };
  const changed = list => send('agents', list);

  // ---------------------------------------------------------------- D2: merge and throw-away
  // POST /api/agents/:id/merge|discard { state } answer with the engine's card, or its refusal ({ ok: false, reply });
  // /api/confirm/:id and a typed yes or no settle a card by its kind. mode.merge is what the next merge does: 'ok', or it
  // fails and the agent keeps the problem ('conflict' | 'blocked' | 'moved' | 'identity' | 'detached' | 'busy' |
  // 'ancestry' | 'git'), or 'changed' (refused when answered), or 'refuse' (the card itself is refused).
  const AT_WORK = new Set(['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']);
  let mergeSeq = 0;
  const newConfirm = (card, extra = {}) => {
    const id = 'c' + (++confirmSeq).toString(16).padStart(6, '0');
    confirms.set(id, { id, ...card, ...extra });
    return { id, ...card };
  };
  const cardOf = c => ({ id: c.id, sentence: c.sentence, detail: c.detail, kind: c.kind, yes: c.yes, no: c.no, danger: c.danger });
  const rootOf = a => (a && a.parentId ? state.agents.find(x => x.id === a.rootId) || a : a);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const mergeRefusal = a => {
    const w = a.work, into = state.repo && state.repo.branch;
    if (state.mode !== 'live') return 'This is the demo, so nothing is really merged.';
    if (a.parentId) return 'Helpers work in their agent’s folder. Merge the agent instead.';
    if (AT_WORK.has(a.state)) return `${a.name} is still working. Merge it when it is done.`;
    if (!w || !w.folder || w.thrownAway) return 'Its folder is gone, so there is nothing to merge.';
    if (!into) return 'Your folder is not on a branch, so there is nowhere to merge it.';
    if (state.repo.identity === false) return NO_IDENTITY;
    if (a.files && !a.files.changed) return `${a.name}’s work is already in ${into}.`;
    return null;
  };
  const discardRefusal = a => {
    const w = a.work;
    if (state.mode !== 'live') return 'This is the demo, so nothing is really thrown away.';
    if (a.parentId) return 'Helpers work in their agent’s folder. Throw away the agent’s work instead.';
    if (!w || !w.folder || w.thrownAway) return 'Its folder is gone, so there is nothing to throw away.';
    return null;
  };
  // the engine's cards, in its words (section 2 of SPEC-source-control.md)
  const mergeCard = a => {
    const into = state.repo.branch, f = a.files || { changed: 0, adds: 0, dels: 0, list: [] }, list = f.list || [];
    const parts = [];
    if (f.changed) parts.push(`${plural(f.changed, 'file')}, +${f.adds} −${f.dels}.`);
    parts.push(`Its work becomes a commit on its branch, joined into ${into} by a merge commit.`);
    const failed = (a.checks?.results || []).filter(r => !r.ok).map(r => r.name);
    if (failed.length) parts.push(`A check failed: ${failed.join(', ')}.`);
    else if (!a.checks || a.checks.state === 'none') parts.push('Nothing checked its work.');
    for (const r of a.rules?.broken || []) parts.push(`It broke a rule you set: ${r.say.replace(/[.\s]+$/, '')}.`);
    const settings = list.map(x => x.path).find(p => p === 'workbench.json' || p === '.mcp.json' || p.startsWith('.claude/'));
    if (settings) parts.push(`It changes ${settings}, which sets the checks for later agents.`);
    const left = list.filter(x => x.ignored).length;
    if (left) parts.push(`${plural(left, 'file')} ${left === 1 ? 'stays' : 'stay'} out: hidden by a .gitignore.`);
    if (state.repo.dirty) parts.push(`Your ${plural(state.repo.dirty, 'uncommitted change')} ${state.repo.dirty === 1 ? 'stays' : 'stay'} as ${state.repo.dirty === 1 ? 'it is' : 'they are'}.`);
    return { kind: 'merge', sentence: `Merge ${a.name} into ${into}?`, detail: parts.join(' '), yes: 'Merge', no: 'Cancel', danger: false };
  };
  const discardCard = a => {
    const n = a.files?.changed || 0;
    const detail = `Its folder and its branch ${a.work.branch} are deleted${n ? `, with ${plural(n, 'changed file')}` : ''}. Workbench keeps a hidden copy in git.`
      + (AT_WORK.has(a.state) ? ' It is still working: it will be stopped first.' : '');
    return { kind: 'discard', sentence: `Throw away ${a.name}’s work?`, detail, yes: 'Throw it away', no: 'Keep it', danger: true };
  };
  const PROBLEM = {
    conflict: (a, into) => `${a.name}’s work does not merge cleanly into ${into}.`,
    blocked: (a, into, paths) => `Your own changes are in the way: ${paths.slice(0, 3).join(', ')}. Commit or put them aside, then merge again.`,
    moved: (a, into) => `${into} changed since you looked. Have another look.`,
    identity: () => NO_IDENTITY,
    detached: () => 'Your folder is not on a branch, so there is nowhere to merge it.',
    busy: () => 'Your folder is in the middle of a merge or rebase. Finish that first.',
    ancestry: (a, into) => `${a.name} started from a commit that is no longer in ${into}, so merging it would bring in other work.`,
    git: () => 'Git could not finish the merge. Nothing in your folder changed.',
  };
  /** Settle a card: a launch starts, a forget forgets, a merge merges (or fails as mode.merge says), a throw-away throws away. */
  const settle = (c, go) => {
    if (c.kind === 'forget') {
      if (!go) return { reply: 'OK, I won’t forget it.' };
      state.agents = state.agents.filter(x => x.id !== c.forget);
      setTimeout(() => send('snapshot', state), 60);
      return { reply: 'Forgot it. Its folder and branch are still on this computer.' };
    }
    if (c.kind !== 'merge' && c.kind !== 'discard') return go ? started(c) : { reply: 'OK, I won’t start it.' };
    if (!go) return { reply: c.kind === 'merge' ? 'OK, I won’t merge it.' : 'OK, I won’t throw it away.' };
    const a = state.agents.find(x => x.id === c.agentId);
    if (!a || !a.work) return { ok: false, reply: 'That agent is no longer here.' };
    const now = Date.now();
    if (c.kind === 'discard') {
      if (AT_WORK.has(a.state)) Object.assign(a, { state: 'stopped', endedAt: now, stateSince: now, ask: null });
      a.work = { ...a.work, branch: null, folder: false, problem: null, thrownAway: { at: now, saved: `refs/workbench/discarded/${a.id}` } };
      setTimeout(() => send('agents', [a]), 60);
      return { ok: true, reply: `Threw away ${a.name}’s work. Its folder and branch are gone.` };
    }
    const into = state.repo.branch, how = mode.merge || 'ok';
    if (how === 'changed') return { ok: false, reply: `${a.name}’s work changed since you looked. Have another look.` };
    if (PROBLEM[how]) {
      const paths = how === 'blocked' ? ['src/cart/total.ts', 'README.md'] : how === 'conflict' ? (a.files?.list || []).map(x => x.path).slice(0, 4) : [];
      const sentence = PROBLEM[how](a, into, paths);
      a.work = { ...a.work, problem: { why: how, sentence, paths, at: now } };
      setTimeout(() => send('agents', [a]), 60);
      return { ok: false, reply: sentence };
    }
    const f = a.files || { changed: 0, adds: 0, dels: 0 };
    const merge = ((++mergeSeq).toString(16) + 'c0ffee5eed'.repeat(4)).slice(0, 40);
    a.work = { ...a.work, merged: { into, merge, at: now, files: f.changed || 0, adds: f.adds || 0, dels: f.dels || 0 }, problem: null };
    a.files = { changed: 0, adds: 0, dels: 0, list: [] };
    state.repo = { ...state.repo, head: merge.slice(0, 7) };
    setTimeout(() => { send('agents', [a]); send('repo', state.repo); }, 60);
    return { ok: true, reply: `Merged ${a.name} into ${into}.`, focusId: a.id };
  };

  let stepTimer = null;
  const stepTick = () => {
    const working = state.agents.filter(a => a.state === 'working' || a.state === 'starting');
    if (working.length) {
      const a = working[Math.floor(Math.random() * working.length)];
      a.toolCalls += 1; a.lastEventAt = Date.now(); a.spark[a.spark.length - 1] += 1;
      changed([a]);
    }
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/ctl/')) {
      let body = '';
      for await (const c of req) body += c;
      const b = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (p === '/ctl/scenario') {
        name = b.name; state = scenario(name); confirms.clear();
        if (b.push !== false) send('snapshot', state);
        res.end(JSON.stringify({ ok: true, agents: state.agents.length })); return;
      }
      if (p === '/ctl/push') { send(b.event, b.data); res.end(JSON.stringify({ ok: true, clients: clients.size })); return; }
      if (p === '/ctl/mode') {
        Object.assign(mode, b);
        clearInterval(stepTimer); stepTimer = mode.steps ? setInterval(stepTick, 700) : null;
        res.end(JSON.stringify(mode)); return;
      }
      if (p === '/ctl/state') { res.end(JSON.stringify(state)); return; }
      if (p === '/ctl/drop') { for (const c of clients) c.destroy(); clients.clear(); res.end('{"ok":true}'); return; }
      if (p === '/ctl/log') { res.end(JSON.stringify(posted)); return; }
      if (p === '/ctl/clear') { posted.length = 0; res.end('{"ok":true}'); return; }
      res.statusCode = 404; res.end('{}'); return;
    }
    if (p.startsWith('/api/')) {
      const tok = req.headers['x-workbench-token'] || (req.method === 'GET' ? u.searchParams.get('t') : null);
      let body = '';
      for await (const c of req) body += c;
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = null; }
      if (req.method === 'POST') posted.push({ at: Date.now(), method: req.method, path: p, body: json });
      if (!tok || tok === 'bad' || mode.auth === 'bad') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Missing or wrong token."}'); return; }
      if (p === '/api/state') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(state)); return; }
      if (p === '/api/stream') {
        if (mode.down) { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('retry: 1000\n\n');
        const hello = () => { if (!res.writableEnded) res.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`); };
        if (mode.holdMs) setTimeout(hello, mode.holdMs); else hello();
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (mode.answer === 'drop') { req.socket.destroy(); return; }
      if (mode.answer === '500') { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Something went wrong."}'); return; }
      res.setHeader('content-type', 'application/json');
      const reply = r => res.end(JSON.stringify(r));
      const m = /^\/api\/agents\/([^/]+)\/(answer|say|stop)$/.exec(p);
      if (m) {
        const a = state.agents.find(x => x.id === decodeURIComponent(m[1]));
        if (!a) return reply({ ok: false, reply: 'There is no such agent.' });
        if (mode.answer === 'refuse') return reply({ ok: false, reply: `I could not reach ${a.name}.` });
        if (m[2] === 'answer') {
          if (!a.ask && json && !json.askId && ['done_checked', 'done_claimed', 'checks_failed'].includes(a.state)) return reply({ ok: true, reply: `Good. ${a.name} stays as it is.` });
          if (!a.ask || !json || json.askId !== a.ask.id) return reply({ ok: false, reply: json && !json.askId && a.ask ? `Have a look at what ${a.name} is asking first.` : `${a.name} is not waiting for that any more.` });
          const was = a.ask, ans = String(json.answer || '');
          a.ask = null;
          a.state = was.type === 'stuck' && /^stop/i.test(ans) ? 'stopped' : 'working';
          if (a.state === 'stopped') a.endedAt = Date.now();
          a.stateSince = Date.now(); a.now = 'Carrying on';
          if (was.type === 'permission') a.approvals = { ...a.approvals, byYou: a.approvals.byYou + 1 };
          countHelpers(state.agents);
          setTimeout(() => changed(state.agents.filter(x => x.id === a.id || x.id === a.parentId)), 60);
          return reply({ ok: true, reply: was.type === 'permission' ? (/^allow$/i.test(ans) ? `${a.name} will go ahead.` : `${a.name} will not do that.`) : `${a.name} has your answer and is carrying on.` });
        }
        if (m[2] === 'say' && a.earlier) {
          if (!a.canContinue) return reply({ ok: false, reply: `${a.name} cannot continue. ${a.continueReason}` });
          Object.assign(a, { earlier: false, canContinue: null, continueReason: null, state: 'working', endedAt: null, stateSince: Date.now(), now: 'Picking up where it left off', budgetUsd: 2 });
          setTimeout(() => changed([a]), 60);
          return reply({ ok: true, reply: `${a.name} is continuing in its own folder. It has a new spending limit of $2.00 for this run.` });
        }
        if (m[2] === 'say' && a.work && !a.parentId && !AT_WORK.has(a.state)) {
          // D2: a message to a root at rest starts a turn, as the engine's does: it works again, and a merge problem clears
          Object.assign(a, { state: 'working', endedAt: null, stateSince: Date.now(), now: 'Working on your message', files: null, checks: null });
          a.work = { ...a.work, problem: null };
          setTimeout(() => changed([a]), 60);
          return reply({ ok: true, reply: `Sent to ${a.name}.` });
        }
        if (m[2] === 'say') return reply({ ok: true, reply: `Sent to ${a.name}.` });
        a.state = 'stopped'; a.endedAt = Date.now(); a.stateSince = Date.now(); a.ask = null;
        setTimeout(() => changed([a]), 60);
        return reply({ ok: true, reply: `Stopped ${a.name}.` });
      }
      // D2: merge and throw-away always ask first, with the engine's card
      const wm = /^\/api\/agents\/([^/]+)\/(merge|discard)$/.exec(p);
      if (wm && req.method === 'POST') {
        const a = state.agents.find(x => x.id === decodeURIComponent(wm[1]));
        if (!a) return reply({ ok: false, reply: 'There is no such agent.' });
        if (mode.merge === 'refuse') return reply({ ok: false, reply: `${a.name} is being merged now.` });
        if (json && json.state && json.state !== a.state) return reply({ ok: false, reply: 'That changed. Have another look.' });
        const no = wm[2] === 'merge' ? mergeRefusal(a) : discardRefusal(a);
        if (no) return reply({ ok: false, reply: no });
        const card = wm[2] === 'merge' ? mergeCard(a) : discardCard(a);
        return reply({ reply: card.sentence, confirm: newConfirm(card, { agentId: a.id }) });
      }
      const cm = /^\/api\/confirm\/([^/]+)$/.exec(p);
      if (cm) {
        const c = confirms.get(decodeURIComponent(cm[1]));
        if (!c) return reply({ reply: 'That request is no longer waiting. Ask again if you still want it.' });
        confirms.delete(c.id);
        return reply(settle(c, !!json && json.go === true));
      }
      if (p === '/api/command') {
        const text = String(json?.text || '').trim();
        const shown = json?.confirmId ? confirms.get(json.confirmId) : null;
        if (shown) {
          // a card's own words: "merge it" is a yes to a merge; a throw-away needs its own words, a bare "yes" is not enough
          const yes = shown.kind === 'discard' ? /^(throw it away|discard it|do it)$/i
            : shown.kind === 'merge' ? /^(yes|ok|do it|go ahead|sure|merge it|merge|land it)$/i : /^(yes|ok|do it|go ahead|sure)$/i;
          if (yes.test(text)) { confirms.delete(shown.id); return reply(settle(shown, true)); }
          if (/^(no|cancel|never mind|stop|forget it|keep it)$/i.test(text)) { confirms.delete(shown.id); return reply(settle(shown, false)); }
          if (shown.kind === 'discard' && /^(yes|yeah|yep|ok|okay|sure|go ahead)$/i.test(text)) return reply({ reply: 'To throw its work away, press “Throw it away” or say “throw it away”.', confirm: cardOf(shown) });
        }
        if (/^(merge|land)\b|^bring its changes in\b/i.test(text) || /^(throw (it|its work|its changes) away|throw away|discard|scrap)\b/i.test(text)) {
          const merge = /^(merge|land|bring)/i.test(text);
          const a = rootOf(state.agents.find(x => x.id === json?.focusId));
          if (!a) return reply({ reply: `I couldn’t tell which agent to ${merge ? 'merge' : 'throw away'}.` });
          const no = merge ? mergeRefusal(a) : discardRefusal(a);
          if (no) return reply({ reply: no, focusId: a.id });
          const card = merge ? mergeCard(a) : discardCard(a);
          return reply({ reply: card.sentence, confirm: newConfirm(card, { agentId: a.id }), focusId: a.id });
        }
        if (/^forget\b/i.test(text)) {
          const a = state.agents.find(x => x.id === json?.focusId && x.earlier);
          if (!a) return reply({ reply: 'I couldn’t tell which agent to forget.' });
          const sentence = `Forget ${a.name}?`, detail = 'It will not show here again. Its folder and branch stay on this computer.';
          return reply({ reply: sentence, confirm: newConfirm({ kind: 'forget', sentence, detail }, { forget: a.id }) });
        }
        if (/^start\b/i.test(text)) {
          const id = 'c' + (++confirmSeq).toString(16).padStart(6, '0');
          const eight = /eight|8/.test(text);
          const sentence = eight
            ? 'Start 8 agents: a simulated Claude on “fix the flaky checkout test”, a simulated Codex on “write tests for the parser”, a simulated Claude on “tidy up the invoice export”, a simulated Claude on “make the login page remember the last email”, a simulated Codex on “add a dark mode to the settings page”, a simulated Claude on “speed up the monthly report”, a simulated Claude on “translate the help pages into French” and a simulated Codex on “find and remove dead code in the search service”?'
            : `Start a simulated Claude on “${text.replace(/^start (an agent|a helper|claude|codex)? ?(to |on )?/i, '').slice(0, 90)}”?`;
          const detail = eight ? 'This is the demo: the agents are simulated and nothing is spent. Each one gets its own cloud machine, and each one can spend up to $2.' : 'This is the demo: the agents are simulated and nothing is spent. It runs on your laptop.';
          confirms.set(id, { id, kind: 'start', sentence, detail });
          return reply({ reply: sentence, confirm: { id, kind: 'start', sentence, detail } });
        }
        if (/what needs me/i.test(text)) {
          const need = state.agents.filter(a => ['needs_ok', 'question', 'maybe_stuck', 'checks_failed'].includes(a.state));
          return reply({ reply: need.length ? `${need.length} thing${need.length === 1 ? '' : 's'} need${need.length === 1 ? 's' : ''} you.` : 'Nothing needs you.', focusId: need[0]?.id });
        }
        return reply({ reply: 'I did not catch that. Try “start an agent to fix the flaky test”.' });
      }
      const mm = /^\/api\/machines\/([^/]+)\/awake$/.exec(p);
      if (mm) {
        const mc = state.machines.find(x => x.id === decodeURIComponent(mm[1]));
        if (!mc) return reply({ ok: false, reply: 'There is no such machine.' });
        mc.awake = json?.awake === true; mc.note = mc.awake ? 'idle' : 'asleep';
        setTimeout(() => send('machines', [mc]), 60);
        return reply({ ok: true, reply: mc.awake ? `${mc.name} is awake.` : `${mc.name} is asleep.` });
      }
      res.statusCode = 404; reply({ error: 'Not found.' }); return;
    }
    let file = p === '/' ? path.join(ROOT, 'ui/index.html') : p.startsWith('/ui/') ? path.join(ROOT, 'ui', p.slice(4)) : p.startsWith('/shared/') ? path.join(ROOT, 'src/shared', p.slice(8)) : null;
    if (file && !file.startsWith(path.join(ROOT, p.startsWith('/shared/') ? 'src/shared' : 'ui'))) file = null;
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, SECURITY); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...SECURITY });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, host, () => {
    const actual = server.address().port;
    if (!quiet) console.log('mock on', actual);
    resolve({
      port: actual,
      setScenario(n) { name = n; state = scenario(n); confirms.clear(); },
      close: () => new Promise(r => { clearInterval(stepTimer); for (const c of clients) c.destroy(); server.close(() => r()); }),
    });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startMock({ port: Number(process.argv[2] || 0) });
}
