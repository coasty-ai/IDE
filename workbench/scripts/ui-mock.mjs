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
//                                  "ancestry" | "git" | "changed" | "nothing" | "git-old" | "gone" | "refuse"
//                                  (see the D2 block in startMock); delay: { command, merge, discard, confirm: ms },
//                                  how long those replies take (the engine does git work before it answers)
//   GET  /ctl/log                  every request the page sent to /api, with its body
//   POST /ctl/clear                empty the log;  POST /ctl/drop  close every open stream
//   GET  /ctl/reads                the git screen's reads: every GET of /api/git and /api/agents/:id/changes (D1)
//   POST /ctl/prefs {...}          the person's choices as Workbench keeps them ({ theme, detail, answered }, any of
//                                  them): the page arrives with them on <html>; answers what is kept now ({} reads it).
//                                  { permissions: 'full' | 'ask' } sets whether full permissions are on in this world
// The person's choices: GET and POST /api/prefs, as the real server answers them (src/core/prefs.mjs), and the page sent
// with them on its <html> tag.
// The git screen's routes (D1): GET /api/git (any scenario) and GET /api/agents/:id/changes; answer "refuse" refuses them.
// The spending limit: POST /api/agents/:id/raise-limit, answered as the engine does in short (see the 'limit' scenario);
// answer "refuse" refuses it.
// Agents & keys: the connect panel's routes, /api/connect*, in the 'connect-*' scenarios (see connectFacts below); mode
// gains connect: { terminal, github, githubAgents, fail, gh, browser } and delay.connect.
// Full permissions: POST /api/permissions { mode }, answered as the engine does (the card for 'full', which only its yes
// turns on, counting what it allowed; 'ask' at once, withdrawing every such card; a card from before the last change of
// mode is refused, "That changed. Have another look."), the snapshot's `permissions`, the page sent with data-permissions
// on <html>, and the words for them in POST /api/command. See the 'full' scenarios.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetById } from '../src/shared/keypresets.mjs';
import { memoryPrefs, cleanPrefs, prefsChange, pageWithPrefs } from '../src/core/prefs.mjs';

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
    machineId: o.machineId || 'laptop', state: o.state || 'working', stateReason: o.stateReason || null, atLimit: !!o.atLimit,
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
  if (FULL_SCENARIOS.includes(name)) return fullWorld(name, now);
  if (MERGE_SCENARIOS.includes(name)) return mergeWorld(name, now);
  if (name === 'limit') return limitWorld(now);
  if (TRAY_SCENARIOS.includes(name)) return trayWorld(name, now);
  if (CONNECT_SCENARIOS.includes(name)) return connectWorld(name, now);
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
  if (GIT_SCENARIOS.includes(name)) return gitWorld(name, now);
  return world([], now);   // zero: a fresh start
}

// ---------------------------------------------------------------- D1: the git screen (GET /api/git, GET /api/agents/:id/changes)
// Live repositories whose history the git screen draws, in the engine's gitGraph() shape:
//   git           invoices-api on main: your commits over a few days, an agent's work merged with a merge commit, done
//                 agents with work not merged yet (one with a commit of its own), one working from HEAD, a stopped one,
//                 an earlier one whose folder is still there, and one thrown away (it has no branch, so it is not drawn)
//   git-many      48 commits and 6 agent branches, a very long branch name, a subject with a right-to-left override
//   git-empty     a repository with only its first commit, and no agents
//   git-detached  your folder is not on a branch
//   git-bring     an agent on the left lane that brought your branch in (a merge of HEAD into its branch), beside one
//                 working on the right: its line runs down the gutter beside HEAD
// Every other scenario gets a history made from its own agents, so the DRAM opens a git screen on any board.
// "Invoice export", in any scenario, answers /changes with the stress diff: CRLF, tabs, a 400-character line, a binary,
// a large and a deleted file, files left out, a link, a right-to-left override and zero-width characters, a long path.
const GIT_SCENARIOS = ['git', 'git-many', 'git-empty', 'git-detached', 'git-bring'];
SCENARIOS.push(...GIT_SCENARIOS);
const GIT_READS = [];        // every GET the page made of /api/git and /api/agents/:id/changes (GET /ctl/reads)
const RLO = String.fromCodePoint(0x202e), ZWSP = String.fromCodePoint(0x200b);
/** A commit id that looks like one: 40 hex characters, the same for the same seed. */
function gitId(seed) {
  let h = 2166136261 ^ [...String(seed)].reduce((s, c) => Math.imul(s ^ c.charCodeAt(0), 16777619) >>> 0, 7);
  let s = '';
  while (s.length < 40) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; s += h.toString(16).padStart(8, '0'); }
  return s.slice(0, 40);
}
const slugOf = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
const workOf = (a, o = {}) => ({ branch: `workbench/${slugOf(a.name)}-${a.id}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
const filesOf = list => ({ changed: list.length, adds: list.reduce((s, x) => s + x.adds, 0), dels: list.reduce((s, x) => s + x.dels, 0), list });
const YOUR_SUBJECTS = ['Tidy the order emails', 'Fix the checkout total on small screens', 'Add the export page', 'Speed up the invoice query', 'Tidy the tests',
  'Start the refunds page', 'Explain the tax rules in the README', 'Move the price helpers into one file', 'Log failed payments with their order id',
  'Show the customer name on invoices', 'Use the new date picker', 'Keep the cart when the session ends', 'Add a health check', 'Set up linting',
  'Write the first invoice tests', 'Add the invoices service', 'Initial commit'];

/**
 * A history in gitGraph()'s shape. `trunk` is your branch's commits, newest first (their subjects). `branches` are the
 * agents' lines of work: { agent, from: index of the trunk commit it started at, own: [subjects of its own commits],
 * merged: index of the trunk commit that merged it (its work commit W comes just below), atHead: its branch is HEAD }.
 */
function gitHistory({ seed, trunk, branches, branch = 'main', now, author = 'Sam Lee', stepMin = 170 }) {
  const ids = trunk.map((_, i) => gitId(`${seed}:t${i}`));
  const at = i => now - (i * stepMin + 3) * MIN;
  const rows = trunk.map((subject, i) => ({ id: ids[i], parents: i < trunk.length - 1 ? [ids[i + 1]] : [], subject, author, at: at(i), refs: [], agentId: null, kind: 'commit' }));
  const above = new Map(), below = new Map();   // trunk index -> commits listed just above or just below it
  const put = (m, i, list) => { if (!m.has(i)) m.set(i, []); m.get(i).push(...list); };
  for (const b of branches) {
    const a = b.agent, ref = a.work && a.work.branch;
    if (b.merged != null) {
      // the merge commit M is trunk commit `merged`; the work commit W it joined (from trunk commit `from`) comes after it
      const m = rows[b.merged];
      const W = { id: gitId(`${seed}:w:${a.id}`), parents: [ids[b.from]], subject: b.subject || 'Its work', author, at: at(b.merged) + MIN, refs: ref ? [ref] : [], agentId: a.id, kind: 'work' };
      Object.assign(m, { parents: [m.parents[0], W.id].filter(Boolean), subject: `Merge ${a.name}: ${W.subject}`, agentId: a.id, kind: 'merge' });
      put(below, b.merged, [W]);
      continue;
    }
    const own = b.own || [];
    if (!own.length) { if (ref) rows[b.from].refs.push(ref); continue; }
    // its own commits, on top of the trunk commit it started from, newest first, just above that commit
    let parent = ids[b.from];
    const chain = own.map((subject, k) => {
      const c = { id: gitId(`${seed}:o:${a.id}:${k}`), parents: [parent], subject, author: a.name, at: at(b.from) + (k + 1) * 7 * MIN, refs: [], agentId: null, kind: 'commit' };
      parent = c.id;
      return c;
    }).reverse();
    if (ref) chain[0].refs.push(ref);
    put(above, b.from, chain);
  }
  if (branch) rows[0].refs.unshift(branch);
  const out = [];
  rows.forEach((r, i) => { out.push(...(above.get(i) || []), r, ...(below.get(i) || [])); });
  return out;
}

function gitWorld(name, now) {
  const raw = [];
  let repo = { name: 'invoices-api', root: '/Users/someone/code/invoices-api', head: '', branch: 'main', dirty: 2, identity: true };
  let commits = [], headId = null;   // HEAD is the newest commit, unless a world says otherwise
  const add = o => { raw.push(o); return o; };
  if (name === 'git-empty') {
    commits = [{ id: gitId('empty:0'), parents: [], subject: 'Initial commit', author: 'Sam Lee', at: now - 5 * MIN, refs: ['main'], agentId: null, kind: 'commit' }];
    repo = { ...repo, name: 'new-project', dirty: 0 };
  } else if (name === 'git' || name === 'git-detached') {
    const invoice = add({ id: 'g1', name: 'Invoice export', state: 'done_checked', endedMin: 4, says: 'Invoices now go out in small batches, so large accounts can export without timing out.',
      files: filesOf([{ path: 'src/invoices/batch.ts', adds: 47, dels: 0 }, { path: 'src/invoices/export.ts', adds: 8, dels: 2 }, { path: 'test/invoices/large-account.test.ts', adds: 64, dels: 0 }]),
      checks: { state: 'passed', results: [{ name: 'Unit tests', ok: true, ms: 48200 }] } });
    const help = add({ id: 'g2', name: 'Help pages', harness: 'codex', model: 'gpt-5-codex', state: 'done_claimed', endedMin: 11, says: 'I rewrote the three help pages in plain language.',
      files: filesOf([{ path: 'docs/help/billing.md', adds: 17, dels: 2 }, { path: 'docs/help/exports.md', adds: 13, dels: 0 }]), checks: { state: 'none', results: [] } });
    const search = add({ id: 'g3', name: 'Search cleanup', state: 'working', now: 'Removing the old search code', ageMin: 9 });
    const price = add({ id: 'g4', name: 'Price rounding', state: 'done_checked', endedMin: 50, says: 'Totals now round once, at the end.', files: filesOf([]) });
    const digest = add({ id: 'g5', name: 'Email digest', state: 'done_checked', earlier: true, ageMin: 27 * 60, sinceMin: 26 * 60, endedMin: 26 * 60,
      says: 'The weekly digest now groups orders by customer.', files: filesOf([{ path: 'src/email/digest.ts', adds: 30, dels: 4 }]) });
    const orders = add({ id: 'g7', name: 'Order history', state: 'stopped', endedMin: 35 });
    add({ id: 'g6', name: 'Dark mode', state: 'stopped', endedMin: 90, work: { branch: null, from: 'main', folder: false, merged: null, problem: null, thrownAway: { at: now - 80 * MIN, saved: 'refs/workbench/discarded/g6' } } });
    for (const a of [invoice, help, search, price, digest, orders]) a.work = workOf(a);
    const trunk = YOUR_SUBJECTS.slice(0, 17);
    commits = gitHistory({ seed: name, now, trunk, branches: [
      { agent: price, from: 4, merged: 1, subject: 'Round totals once, at the end' },
      { agent: invoice, from: 3, own: ['Batch invoices for large accounts'] },
      { agent: help, from: 2 }, { agent: search, from: 0 }, { agent: orders, from: 5 }, { agent: digest, from: 9 },
    ] });
    price.work.merged = { into: 'main', merge: commits.find(c => c.kind === 'merge').id, at: now - 6 * MIN, files: 1, adds: 9, dels: 3 };
    if (name === 'git-detached') { repo = { ...repo, branch: null, dirty: 0 }; for (const c of commits) c.refs = c.refs.filter(r => r !== 'main'); }
  } else if (name === 'git-bring') {
    // Search cleanup started from an older commit of yours, then brought your branch in (as "Ask it to bring in main"
    // asks): its merge commit, newest of all, has your HEAD as its second parent. Help pages works from the commit under
    // HEAD, on the right, so Search cleanup's longer line takes the left lane.
    const search = add({ id: 'gb1', name: 'Search cleanup', state: 'done_checked', endedMin: 1, says: 'The old search code is gone, and main is merged in.',
      files: filesOf([{ path: 'src/search/index.ts', adds: 4, dels: 22 }, { path: 'src/search/redirects.ts', adds: 10, dels: 8 }]), checks: { state: 'passed', results: [{ name: 'Unit tests', ok: true, ms: 9100 }] } });
    const help = add({ id: 'gb2', name: 'Help pages', harness: 'codex', model: 'gpt-5-codex', state: 'working', now: 'Editing billing.md', ageMin: 40 });
    for (const a of [search, help]) a.work = workOf(a);
    const ids = YOUR_SUBJECTS.slice(0, 9).map((_, i) => gitId(`bring:t${i}`));
    const at = i => now - (i * 170 + 3) * MIN;
    const trunk = YOUR_SUBJECTS.slice(0, 9).map((subject, i) => ({ id: ids[i], parents: i < ids.length - 1 ? [ids[i + 1]] : [], subject, author: 'Sam Lee', at: at(i), refs: [], agentId: null, kind: 'commit' }));
    trunk[0].refs.push('main');
    trunk[1].refs.push(help.work.branch);
    const own = { id: gitId('bring:own'), parents: [ids[2]], subject: 'Remove the old search code', author: search.name, at: at(2) + 7 * MIN, refs: [], agentId: null, kind: 'commit' };
    const brought = { id: gitId('bring:in'), parents: [own.id, ids[0]], subject: 'Merge main into its branch', author: search.name, at: now - 2 * MIN, refs: [search.work.branch], agentId: null, kind: 'merge' };
    commits = [brought, trunk[0], trunk[1], own, ...trunk.slice(2)];
    headId = ids[0];
  } else {
    // git-many: a long history, six lines of work, a long branch name and a subject that tries to read backwards
    const names = ['Invoice export', 'Help pages', 'Search cleanup', 'Price rounding', 'Onboarding emails for the new pricing plans and trial periods', 'Release notes'];
    const states = ['done_checked', 'done_claimed', 'working', 'done_checked', 'done_checked', 'checks_failed'];
    const agents = names.map((n, i) => add({ id: `m${i + 1}`, name: n, state: states[i], endedMin: states[i] === 'working' ? null : 3 + 7 * i, ageMin: 30 + 9 * i,
      files: states[i] === 'working' ? null : filesOf([{ path: `src/${slugOf(n).slice(0, 18)}/index.ts`, adds: 10 + 3 * i, dels: i }, { path: `test/${slugOf(n).slice(0, 18)}.test.ts`, adds: 20, dels: 0 }]),
      checks: states[i] === 'checks_failed' ? { state: 'failed', results: [{ name: 'Unit tests', ok: false, ms: 4100 }] } : null }));
    for (const a of agents) a.work = workOf(a);
    agents[4].work.branch = 'workbench/onboarding-emails-for-the-new-pricing-plans-and-trial-periods-m5';
    agents[3].files = filesOf([]);
    const trunk = [];
    for (let i = 0; i < 44; i++) trunk.push(i === 7 ? `Fix the ${RLO}gnp.tropxe file name check` : i === 43 ? 'Initial commit' : `${YOUR_SUBJECTS[i % (YOUR_SUBJECTS.length - 1)]}${i >= 16 ? ` (part ${Math.floor(i / 16) + 1})` : ''}`);
    commits = gitHistory({ seed: name, now, trunk, stepMin: 95, branches: [
      { agent: agents[3], from: 6, merged: 2, subject: 'Round totals once, at the end' },
      { agent: agents[0], from: 4, own: ['Batch invoices', 'Add a test for large accounts'] },
      { agent: agents[1], from: 1 }, { agent: agents[2], from: 0 }, { agent: agents[4], from: 12, own: ['Draft the trial emails'] }, { agent: agents[5], from: 9 },
    ] });
    agents[3].work.merged = { into: 'main', merge: commits.find(c => c.kind === 'merge').id, at: now - 20 * MIN, files: 2, adds: 12, dels: 4 };
  }
  const head = headId || commits[0].id;
  repo.head = head.slice(0, 7);
  const st = world(raw, now);
  st.mode = 'live';
  st.repo = repo;
  const n = st.agents.filter(a => !a.parentId && !a.earlier && ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck'].includes(a.state)).length;
  st.machines = [{ ...LAPTOP, agents: n, note: n ? `${n} agent${n === 1 ? '' : 's'}` : 'idle' }];
  st.git = { commits, head };
  return st;
}

/** The git screen's data for any world: the scenario's own history, or one made from its agents. */
function gitGraphOf(state, now = Date.now()) {
  const roots = state.agents.filter(a => !a.parentId);
  let commits = state.git && state.git.commits, head = state.git && state.git.head;
  const repo = state.repo ? { name: state.repo.name, branch: state.repo.branch, head: state.repo.head, dirty: state.repo.dirty || 0, identity: state.repo.identity !== false }
    : { name: 'demo-shop', branch: 'main', head: '', dirty: 0, identity: true };
  // agents as the engine lists them: every root with a branch, this run's and earlier ones (the demo makes branches up)
  const agentsOf = list => list.filter(a => (a.work ? a.work.branch : state.mode === 'demo')).map((a, i) => {
    const work = a.work || workOf(a);
    return { id: a.id, name: a.name, state: a.state, earlier: !!a.earlier, harness: a.harness, branch: work.branch, from: work.from, base: null, since: null, files: a.files, work, i };
  });
  if (!commits) {
    // a history from the world's own agents: work merged near the top, the rest started from a commit of yours
    const agents = agentsOf(roots).filter(a => a.work && a.work.branch);
    const trunk = YOUR_SUBJECTS.slice(0, 14);
    const merged = agents.filter(a => a.work.merged);
    const branches = agents.map((a, i) => (a.work.merged ? { agent: a, from: Math.min(trunk.length - 2, 3 + i), merged: Math.min(trunk.length - 3, merged.indexOf(a) + 1) }
      : { agent: a, from: ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck'].includes(a.state) ? 0 : Math.min(trunk.length - 2, 1 + (i % 6)) }));
    commits = gitHistory({ seed: state.agents.map(a => a.id).join(','), now, trunk, branches, branch: repo.branch });
    head = commits[0].id;
  }
  const agents = agentsOf(roots).filter(a => a.branch);
  const byId = new Map(commits.map(c => [c.id, c]));
  const trunk = new Set();
  for (let c = byId.get(head); c && !trunk.has(c.id); c = byId.get(c.parents[0])) trunk.add(c.id);
  for (const a of agents) {
    // base: the commit of yours its lane leaves from; since: where its unmerged work starts (its work commit, once merged)
    const tip = commits.find(c => c.refs.includes(a.branch));
    let base = tip;
    while (base && !trunk.has(base.id)) base = byId.get(base.parents[0]);
    a.base = base ? base.id : head;
    a.since = a.work.merged && tip ? tip.id : a.base;
    delete a.i;
  }
  return { ok: true, repo: { ...repo, head: repo.head || head.slice(0, 7) }, commits, more: false, agents };
}

/** A unified diff of one file, made up from its counts: a hunk of believable lines. */
function filePatch(f, i) {
  const ctx = ['', 'export function total(items) {', '  return items.reduce((sum, item) => sum + item.price, 0);', '}'];
  const adds = Math.min(f.adds, 40), dels = Math.min(f.dels, 20);
  const lines = [];
  for (let k = 0; k < 2; k++) lines.push(' ' + ctx[(k + i) % ctx.length]);
  for (let k = 0; k < dels; k++) lines.push(`-  const old${k} = load(${k});`);
  for (let k = 0; k < adds; k++) lines.push(`+  const batch${k} = await sendBatch(invoices.slice(${k * 50}, ${(k + 1) * 50}));`);
  lines.push(' ' + ctx[3]);
  const head = f.status === 'added' ? 'new file mode 100644\nindex 0000000..1d2e3f4\n--- /dev/null' : f.status === 'deleted' ? 'deleted file mode 100644\nindex 4f3e2d1..0000000\n--- a/' + f.path : 'index 1a2b3c4..5d6e7f8 100644\n--- a/' + f.path;
  return `diff --git a/${f.path} b/${f.path}\n${head}\n+++ ${f.status === 'deleted' ? '/dev/null' : 'b/' + f.path}\n@@ -${10 + i},${dels + 3} +${10 + i},${adds + 3} @@ export function total(items) {\n${lines.join('\n')}\n`;
}

/** The stress diff, for "Invoice export" in any scenario. */
function stressFiles() {
  const crlf = ['@@ -1,6 +1,9 @@ import { db } from "../db";', ' import { db } from "../db";\r', '-const BATCH = 1000;\r', '+const BATCH = 50;\r',
    '+\tconst total' + ZWSP + ' = 0;\r', '+\t\tif (invoice.lines.length > BATCH) { split(invoice); }\r', '+// ' + 'a very long line that never breaks '.repeat(11).slice(0, 400) + '\r',
    ' export async function exportAll(account) {\r', '   const invoices = await db.invoices.forAccount(account.id);\r', '+  return sendBatches(invoices, BATCH);\r', ' }\r'].join('\n');
  const longPath = 'src/' + 'deeply/nested/'.repeat(9) + 'invoice-export-batch-sender-for-large-accounts.ts';
  return [
    { path: 'src/invoices/export.ts', status: 'modified', adds: 6, dels: 1, patch: `diff --git a/src/invoices/export.ts b/src/invoices/export.ts\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/invoices/export.ts\n+++ b/src/invoices/export.ts\n${crlf}\n` },
    { path: 'assets/invoice-logo.png', status: 'added', adds: 0, dels: 0, binary: true, patch: null },
    { path: 'data/fixtures/large-accounts.json', status: 'added', adds: 48211, dels: 0, large: true, patch: null },
    { path: 'src/legacy/old-export.ts', status: 'deleted', adds: 0, dels: 5, patch: 'diff --git a/src/legacy/old-export.ts b/src/legacy/old-export.ts\ndeleted file mode 100644\nindex 4f3e2d1..0000000\n--- a/src/legacy/old-export.ts\n+++ /dev/null\n@@ -1,5 +0,0 @@\n-// the old export, one invoice at a time\n-export function exportOld(account) {\n-  for (const invoice of account.invoices) send(invoice);\n-}\n-\n' },
    { path: `docs/notes/readme${RLO}txt.exe`, status: 'added', adds: 1, dels: 0, patch: `diff --git a/docs/notes/x b/docs/notes/x\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/docs/notes/x\n@@ -0,0 +1 @@\n+This file name reads backwards on purpose.\n` },
    { path: 'config/keys', status: 'added', adds: 1, dels: 0, patch: 'diff --git a/config/keys b/config/keys\nnew file mode 120000\nindex 0000000..2222222\n--- /dev/null\n+++ b/config/keys\n@@ -0,0 +1 @@\n+../../../.ssh/config\n\\ No newline at end of file\n' },
    { path: longPath, status: 'added', adds: 3, dels: 0, patch: `diff --git a/${longPath} b/${longPath}\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/${longPath}\n@@ -0,0 +1,3 @@\n+export const BATCH = 50;\n+export const PAUSE_MS = 200;\n+export const RETRIES = 3;\n` },
  ];
}

/** GET /api/agents/:id/changes, as engine.changes() answers it. */
function changesOf(state, agentId) {
  const a = state.agents.find(x => x.id === agentId);
  if (!a) return { ok: false, reply: 'There is no such agent.' };
  const root = a.parentId ? state.agents.find(x => x.id === a.rootId) || a : a;
  const work = root.work || (state.mode === 'demo' ? workOf(root) : null);
  if (!work || !work.branch || work.folder === false) return { ok: false, reply: `${root.name}’s folder is gone, so there is nothing to show.` };
  let files = ((root.files && root.files.list) || []).map((f, i) => ({ path: f.path, status: f.adds && !f.dels && /test|docs|new/.test(f.path) ? 'added' : 'modified', adds: f.adds, dels: f.dels }));
  files = files.map((f, i) => ({ ...f, patch: filePatch(f, i), cut: f.adds > 40 ? true : undefined }));
  let left = [];
  if (root.name === 'Invoice export') { files = [...stressFiles(), ...files]; left = [{ path: '.env.local', why: 'ignored' }, { path: 'vendor/payments-sdk', why: 'nested-repo' }]; }
  const active = ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck'].includes(root.state);
  return { ok: true, agentId: root.id, name: root.name, branch: work.branch, into: state.repo ? state.repo.branch : 'main', live: active,
    diff: { workId: `${gitId(root.id + ':head')}:${gitId(root.id + ':tree')}`, since: gitId(root.id + ':since'), head: gitId(root.id + ':head'), files, left, omitted: 0 } };
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

// ---------------------------------------------------------------- the spending limit (POST /api/agents/:id/raise-limit)
//   limit   live, on main: Checkout fix, a Claude Code agent stopped at its spending limit with its work not merged yet,
//           comes first ("Give it $2.00 more" and Dismiss); Parser tests, a Codex agent that failed for another reason,
//           keeps "Try again"; Docs site is still working
SCENARIOS.push('limit');
function limitWorld(now) {
  const work = (slug, id) => ({ branch: `workbench/${slug}-${id}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null });
  const st = world([
    { id: 'l1', name: 'Checkout fix', state: 'failed', atLimit: true, stateReason: 'It reached its spending limit.', endedMin: 1, sinceMin: 1, model: 'claude-opus-5-5',
      usage: { inputTokens: 38000, outputTokens: 21000, cacheReadTokens: 2900000, cacheWriteTokens: 160000, costUsd: 2.04, unreportedUsd: 0, contextTokens: 98000, contextWindow: 200000, contextPct: 0.49 },
      work: work('checkout-fix', 'l1') },
    { id: 'l2', name: 'Parser tests', harness: 'codex', model: 'gpt-5-codex', state: 'failed', endedMin: 6, sinceMin: 6, error: 'Codex stopped: the tests ran out of memory.', work: work('parser-tests', 'l2') },
    { id: 'l3', name: 'Docs site', state: 'working', now: 'Editing the getting started page', work: work('docs-site', 'l3') },
  ], now);
  st.mode = 'live';
  st.repo = { name: 'storefront', head: 'abc1234', branch: 'main', dirty: 0, identity: true };
  st.machines = [{ ...LAPTOP, agents: 1, note: '1 agent' }];
  return st;
}

// ---------------------------------------------------------------- the done tray: agents the person is finished with
// A root leaves the board for the done tray once its run has ended and the person is finished with it: its work merged
// with nothing new since, or thrown away (the snapshot says so, as here), or looked at ("Looks good", "Not now",
// "Dismiss": the page keeps those for its tab, so no snapshot can carry them).
//   done-tray    live, on main: Docs site at work; Help pages, merged with nothing new, and Dark mode, stopped and its
//                work thrown away, wait in the done tray ("2 done"); Move invoices older than seven years to the cold
//                archive, stopped with its work kept, waits at the board's edge until the person dismisses it
//   done-waits   live, on main: Invoice export, done and checked, its work not merged yet and not looked at: it stays on
//                the board, at the edge, until the person merges it, says "Not now", or throws its work away
const TRAY_SCENARIOS = ['done-tray', 'done-waits'];
SCENARIOS.push(...TRAY_SCENARIOS);
function trayWorld(name, now) {
  const work = (slug, id, o = {}) => ({ branch: `workbench/${slug}-${id}`, from: 'main', folder: true, merged: null, problem: null, thrownAway: null, ...o });
  const raw = name === 'done-tray' ? [
    { id: 't1', name: 'Docs site', state: 'working', now: 'Editing the getting started page', ageMin: 14, work: work('docs-site', 't1') },
    { id: 't2', name: 'Help pages', harness: 'codex', model: 'gpt-5-codex', state: 'done_claimed', ageMin: 40, endedMin: 12, says: 'I rewrote the three help pages in plain language.',
      files: { changed: 0, adds: 0, dels: 0, list: [] }, work: work('help-pages', 't2', { merged: { into: 'main', merge: 'b7d1e0c4a9f2b7d1e0c4a9f2b7d1e0c4a9f2b7d1', at: now - 6 * MIN, files: 3, adds: 36, dels: 6 } }) },
    { id: 't3', name: 'Dark mode', state: 'stopped', ageMin: 55, endedMin: 20,
      work: work('dark-mode', 't3', { branch: null, folder: false, thrownAway: { at: now - 15 * MIN, saved: 'refs/workbench/discarded/t3' } }) },
    // stopped with its work kept, and a long name: at the board's edge until the person dismisses it ("· stopped")
    { id: 't4', name: 'Move invoices older than seven years to the cold archive', state: 'stopped', ageMin: 35, endedMin: 8,
      work: work('archive-old-invoices', 't4') },
  ] : [
    { id: 'w1', name: 'Invoice export', state: 'done_checked', ageMin: 30, endedMin: 3, says: 'Invoices now go out in small batches, so large accounts can export without timing out.',
      files: { changed: 3, adds: 40, dels: 2, list: [{ path: 'src/invoices/batch.ts', adds: 22, dels: 0 }, { path: 'src/invoices/export.ts', adds: 8, dels: 2 }, { path: 'test/invoices/large-account.test.ts', adds: 10, dels: 0 }] },
      checks: { state: 'passed', results: [{ name: 'Unit tests', ok: true, ms: 48200 }] }, work: work('invoice-export', 'w1') },
  ];
  const st = world(raw, now);
  st.mode = 'live';
  st.repo = { name: 'invoices-api', head: 'abc1234', branch: 'main', dirty: 0, identity: true };
  const n = st.agents.filter(a => !a.parentId && ['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck'].includes(a.state)).length;
  st.machines = [{ ...LAPTOP, agents: n, note: n ? `${n} agent${n === 1 ? '' : 's'}` : 'idle' }];
  return st;
}

// ---------------------------------------------------------------- Agents & keys: the connect panel (/api/connect*)
// Live repositories whose snapshot carries `connect` ({ ready, defaultAgent, agents: [{ id, name, ready }] }, at its top
// level, as the engine sends it), and the panel's routes, answered as src/server/http.mjs answers them: { ok, sentence,
// status } with a ConnectStatus as src/core/connect.mjs makes it, a refusal as { ok: false, sentence, status }, or
// { error } with a 4xx code. A key's values are kept only as the key store shows them ("•••• " and the last four
// characters, or a value that is not secret). No other scenario has `connect`, so the page shows nothing of Agents & keys
// there, and these routes answer 404, as the demo's do.
//   connect-none     no coding agent is ready: Claude Code is installed but not signed in, Codex is not installed, and git
//                    has no name and email. The lid says "Connect a coding agent to start.", and the panel opens by itself
//   connect-claude   Claude Code is ready, and new work goes to it; Codex is installed but signed out
//   connect-nocodex  Claude Code is ready; Codex is not installed; an agent needs you
//   connect-github   both are ready; GitHub is connected (git alone uses the token), with two keys: AWS for all
//                    repositories and agents, and Stripe for this repository and Claude Code
//   connect-fail     reading what is connected fails: GET /api/connect and the re-check answer 500, so the panel says so,
//                    with Try again. An agent is ready, so the panel opens only from the top band's button
// Milestone 1.5 (GitHub through its own command-line tool, git missing, agents signing in in the browser). In each of
// these no coding agent is ready (Claude Code is installed but signed out, Codex is not installed), so the panel opens
// by itself and the fit check lays it out. Each holds still until the page presses something:
//   connect-gh-none        GitHub's command-line tool is not installed, and GitHub is not signed in: Sign in to GitHub
//   connect-gh-installing  a sign-in to GitHub under way, getting the tool: "Getting GitHub’s command-line tool…"
//   connect-gh-code        a sign-in to GitHub waiting for the person: "Your code: WDJB-MJHT", with Open GitHub
//   connect-gh-signed      signed in to GitHub through the tool, as octocat, and git uses that sign-in: Sign out
//   connect-gh-nogit       signed in through the tool as octocat, but git does not use that sign-in (gh signed in in a
//                          terminal of the person's own): Sign in to GitHub, which only makes git use it, and Sign out
//   connect-gh-command     a sign-in to GitHub where Terminal could not open: Workbench waits, and its status carries the
//                          command to run in a terminal, which the panel shows with Copy
//   connect-gh-refused     the tool's download was refused (its checksum did not match): GitHub's sentence says so
//   connect-git-missing    git is not installed (a Mac, no developer tools): Install, and no name or email to give
//   connect-browser        Claude Code's own login waits in the browser: "Finish signing in to Claude in your browser."
//   connect-browser-failed that sign-in did not finish: the panel offers the sign-in in Terminal
// Sign in and Install "open Terminal", and so does Sign in with { terminal: true }: the next re-check finds the agent
// signed in, or installed and signed out. Sign in alone (or { console: true }, Claude Code's Anthropic Console account)
// is the agent's own login in the browser: it waits (`signingIn`), and the second read after it finds it signed in.
// Sign in to GitHub gets the tool when it is missing ("installing"; the next read has the code), shows the code
// ("code"), and the third read after the code came finds it signed in as octocat (the second finds gh signed in while
// git does not use it yet, the sign-in still under way, as Connect's status is while setup-git runs); signed in
// already but git not using it, it only makes git use it, at once. git's Install "opens Apple's installer", and the
// next re-check finds git. Each read (GET /api/connect, the re-check) moves a sign-in under way on by
// one step (advanceSignIns). Through POST /ctl/mode, connect: { terminal: false }
// answers the Terminal ones with the command to run instead (no Terminal), GitHub's sign-in too (its status then has
// `opened: false` and the command); { github: 'token' } refuses the token Connect
// GitHub sends; { githubAgents: 'token' } refuses GitHub's box ("Let agents use this token") as Connect does when the key
// store cannot give it the token it keeps, with { ok: false, why: 'token', sentence, status }, as the route answers;
// { gh: 'refused' } refuses the tool's download, { gh: 'terminal' } falls back to Terminal (no code came), { gh: 'wait' }
// keeps showing the code; { signout: 'fail' } answers Sign out as Connect does when gh cannot sign out by itself and
// Terminal cannot open ({ ok: false, why: 'gh', opened: false, command, sentence, status }, gh still signed in);
// { browser: 'fail' } makes an agent's sign-in in the browser not finish, { browser: 'wait' }
// keeps it waiting; { fail: true } fails every read. delay: { connect: ms } makes every answer take that long. A key
// for one repository says whether it is this one (`here`), as Connect's status does.
const CONNECT_SCENARIOS = ['connect-none', 'connect-claude', 'connect-nocodex', 'connect-github', 'connect-fail',
  'connect-gh-none', 'connect-gh-installing', 'connect-gh-code', 'connect-gh-signed', 'connect-gh-refused', 'connect-git-missing', 'connect-browser', 'connect-browser-failed',
  'connect-gh-nogit', 'connect-gh-command'];
/** The milestone 1.5 scenarios: no coding agent is ready in them. */
const FIRST_RUN = new Set(CONNECT_SCENARIOS.slice(5));
SCENARIOS.push(...CONNECT_SCENARIOS);
const CONNECT_REPO = { name: 'shop', root: '/Users/someone/code/shop', head: 'c0ffee1', branch: 'main', dirty: 0 };
const INSTALLERS = { claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' };
const SIGN_INS = { claude: 'claude auth login', codex: 'codex login' };
const AGENT_KEYS = { claude: ['anthropic', ['ANTHROPIC_API_KEY']], codex: ['openai', ['OPENAI_API_KEY', 'CODEX_API_KEY']] };
const NOT_INSTALLED = { found: false, version: null, from: null, signedIn: 'unknown', how: null };
/** How each agent is signed in once its own login finishes in the browser. */
const SIGNED_IN_HOW = { claude: 'your Claude subscription', codex: 'your ChatGPT account' };
const SIGN_IN_SITE = { claude: 'Claude', codex: 'ChatGPT' };
/** GitHub's command-line tool, as Workbench keeps it, and what its sign-in shows. */
const GH_PATH = '/Users/someone/.local/bin/gh', GH_VERSION = '2.104.0', GH_CODE = 'WDJB-MJHT', GH_DEVICE = 'https://github.com/login/device';
const GH_PHASE_WORDS = { installing: 'Getting GitHub’s command-line tool…', code: 'Open GitHub, type the code there and approve the sign-in.',
  terminal: 'Terminal is open: follow the steps there, then come back.' };
/** Where Terminal could not open (Connect's words on a Mac), and the commands Connect gives then for that gh. */
const GH_NO_TERMINAL = 'Workbench could not open Terminal. Run this command in a terminal, then come back here.';
const GH_SIGN_IN_COMMAND = `${GH_PATH} auth login --hostname github.com --git-protocol https --web --scopes workflow && ${GH_PATH} auth setup-git --hostname github.com`;
const GH_SIGN_OUT_COMMAND = `${GH_PATH} auth logout --hostname github.com`;
/** What GitHub's part says once signed in through the tool, as Connect says it: git uses the sign-in, or not yet. */
const ghSignedWords = (login, git) => (git ? `Signed in to GitHub as ${login}. Git in Terminal, Workbench and your agents use this sign-in.`
  : `Signed in to GitHub as ${login}, but git does not use this sign-in yet. Sign in to GitHub again to set that up.`);
/** A sign-in's words for its phase: in Terminal's place, the command to run. */
const ghPhaseWords = si => (si.phase === 'terminal' && si.opened === false ? GH_NO_TERMINAL : GH_PHASE_WORDS[si.phase]);
const GH_REFUSED = 'Workbench did not install GitHub’s command-line tool, because the download did not match the checksum GitHub publishes for it. Try again later, or use a token instead.';
/** When the milestone 1.5 scenarios' sign-ins began: a fixed time, so a scenario's status is the same at every read. */
const SINCE = 1_800_000_000_000;
const andList = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** How the key store shows a secret value: "•••• " and its last 4 characters (12 or more), else "••••". */
const maskedValue = v => { const a = Array.from(String(v)); return a.length >= 12 ? `•••• ${a.slice(-4).join('')}` : '••••'; };

/** What Connect knows in a connect scenario (null in the others): the agents' facts, git, GitHub, and the keys, masked. */
function connectFacts(name) {
  if (!CONNECT_SCENARIOS.includes(name)) return null;
  const claude = { id: 'claude', name: 'Claude Code', found: true, version: '2.1.322', from: 'the VS Code extension', signedIn: 'yes', how: 'your Claude subscription' };
  const codex = { id: 'codex', name: 'Codex', found: true, version: '0.166.0', from: 'your PATH', signedIn: 'yes', how: 'your ChatGPT account' };
  // chosen: the person's default (settings.json); pending: what Terminal is doing, which the next re-check finds done;
  // github: milestone 1's token; gh: GitHub's own command-line tool (installed, signed in as `login`, whether git uses
  // that sign-in, a sign-in under way, and what Connect said of the last one); an agent's `signing` is its own login
  // waiting in the browser, and `failed` says one did not finish. A sign-in's `steps` are what each read does next
  // (none: it holds still); GitHub's has `opened: false` once it is in Terminal's place, where Terminal could not open.
  const f = { agents: [claude, codex], chosen: null, git: { name: 'Sam Lee', email: 'sam@example.com', installed: true }, github: null,
    gh: { installed: false, login: null, git: false, signing: null, said: null }, keys: [], fail: name === 'connect-fail', pending: new Map(), seq: 0 };
  for (const a of f.agents) Object.assign(a, { signing: null, failed: false });
  if (name === 'connect-none') { Object.assign(claude, { signedIn: 'no', how: null }); Object.assign(codex, NOT_INSTALLED); f.git = { name: '', email: '', installed: true }; }
  if (name === 'connect-claude') { Object.assign(codex, { signedIn: 'no', how: null }); f.gh.installed = true; }
  if (name === 'connect-nocodex') Object.assign(codex, NOT_INSTALLED);
  if (FIRST_RUN.has(name)) { Object.assign(claude, { signedIn: 'no', how: null }); Object.assign(codex, NOT_INSTALLED); }
  if (name === 'connect-gh-installing') f.gh.signing = { phase: 'installing', since: SINCE, steps: [] };
  if (name === 'connect-gh-code') Object.assign(f.gh, { installed: true, signing: { phase: 'code', code: GH_CODE, url: GH_DEVICE, since: SINCE, steps: [] } });
  if (name === 'connect-gh-signed') Object.assign(f.gh, { installed: true, login: 'octocat', git: true });
  if (name === 'connect-gh-nogit') Object.assign(f.gh, { installed: true, login: 'octocat', git: false });
  if (name === 'connect-gh-command') Object.assign(f.gh, { installed: true, signing: { phase: 'terminal', opened: false, since: SINCE, steps: [] } });
  if (name === 'connect-gh-refused') f.gh.said = GH_REFUSED;
  if (name === 'connect-git-missing') f.git = { name: '', email: '', installed: false };
  if (name === 'connect-browser') claude.signing = { since: SINCE, console: false, steps: [] };
  if (name === 'connect-browser-failed') claude.failed = true;
  if (name === 'connect-github') {
    f.github = { login: 'octocat', agentsUseIt: false };
    f.keys.push({ id: 'k-aws', preset: 'aws', label: 'AWS', scope: { kind: 'all' }, agents: 'all', created: 1_800_000_000_000,
      vars: [{ name: 'AWS_ACCESS_KEY_ID', shown: '•••• 7QXA' }, { name: 'AWS_SECRET_ACCESS_KEY', shown: '•••• 9f2b' }, { name: 'AWS_REGION', shown: 'eu-west-2' }] });
    f.keys.push({ id: 'k-stripe', preset: 'stripe', label: 'Stripe', scope: { kind: 'repo', root: CONNECT_REPO.root }, agents: ['claude'], created: 1_800_000_060_000,
      vars: [{ name: 'STRIPE_SECRET_KEY', shown: '•••• 4eC3' }] });
  }
  return f;
}

const agentReady = a => a.found && a.signedIn !== 'no';
/** The person's choice when that agent is ready, else the first ready agent, else null (Connect's defaultAgent()). */
const defaultAgentOf = f => (f.agents.find(a => a.id === f.chosen && agentReady(a)) || f.agents.find(agentReady) || null)?.id ?? null;

/** A ConnectStatus, as Connect's status() gives it: its sentences, and each agent's buttons in the panel's order. */
function connectStatus(f) {
  const def = defaultAgentOf(f);
  const nameOf = id => f.agents.find(a => a.id === id)?.name || id;
  const agents = f.agents.map(a => {
    const v = a.version ? ` ${a.version}` : '', ready = agentReady(a);
    const sentence = !a.found ? `${a.name} is not installed.` : a.signedIn === 'no' ? `${a.name}${v} is installed but not signed in.`
      : a.signedIn === 'unknown' ? `${a.name}${v} is installed, but Workbench could not check whether it is signed in.` : `${a.name}${v} is ready, signed in with ${a.how}.`;
    const out = a.found && a.signedIn !== 'yes';
    const actions = [a.failed && out && 'signin-terminal', out && 'signin', out && a.id === 'claude' && 'signin-console', !a.found && 'install', a.found && 'key',
      ready && a.id !== def && 'default', 'recheck'].filter(Boolean);
    const signingIn = a.signing ? { since: a.signing.since, browser: true, sentence: `Finish signing in to ${SIGN_IN_SITE[a.id] || a.name} in your browser.` } : null;
    return { id: a.id, name: a.name, found: a.found, version: a.version, from: a.from, signedIn: a.signedIn, how: a.how, ready, isDefault: a.id === def, sentence, actions, signingIn };
  });
  const g = f.git, gh = f.github, tool = f.gh, si = tool.signing;
  const toolFacts = { ghInstalled: tool.installed, ghVersion: tool.installed ? GH_VERSION : null, ghPath: tool.installed ? GH_PATH : null };
  // the sign-in under way, as Connect's githubSignInState() gives it, whether gh has the sign-in yet or not
  const noTerminal = !!si && si.phase === 'terminal' && si.opened === false;
  const signingIn = si ? { phase: si.phase, code: si.phase === 'code' ? si.code : null, url: si.phase === 'code' ? si.url : null, since: si.since, sentence: ghPhaseWords(si),
    ...(noTerminal ? { opened: false, command: GH_SIGN_IN_COMMAND } : {}) } : null;
  const keySentence = k => `${k.label} for ${k.scope.kind === 'repo' ? (k.scope.root === CONNECT_REPO.root ? 'this repository' : `the repository at ${k.scope.root}`) : 'all repositories'}, `
    + `given to ${k.agents === 'all' ? 'all agents' : k.agents.length ? andList(k.agents.map(nameOf)) : 'no agent'}: ${k.vars.map(x => `${x.name} ${x.shown}`).join(', ')}`;
  return {
    agents, defaultAgent: def, platform: 'darwin', canOpenTerminal: true,
    git: g.installed === false ? { name: '', email: '', installed: false, canInstall: true, sentence: 'Git is not installed yet. Apple’s developer tools include it.' }
      : { name: g.name, email: g.email, installed: true, canInstall: true, sentence: g.name && g.email ? `Git knows you as ${g.name}, ${g.email}.` : 'Git does not know your name and email yet.' },
    github: gh ? { connected: true, via: 'token', login: gh.login, ...toolFacts, agentsUseIt: gh.agentsUseIt, sentence: `Connected to GitHub as ${gh.login}.`, signingIn: null }
      : tool.login ? { connected: true, via: 'gh', login: tool.login, ...toolFacts, agentsUseIt: tool.git === true, sentence: ghSignedWords(tool.login, tool.git === true), signingIn }
      : { connected: false, via: null, login: null, ...toolFacts, agentsUseIt: false, sentence: tool.said || 'Not signed in to GitHub.', signingIn },
    keys: f.keys.map(k => ({ ...k, scope: k.scope.kind === 'repo' ? { ...k.scope, here: k.scope.root === CONNECT_REPO.root } : { ...k.scope },
      vars: k.vars.map(x => ({ ...x })), sentence: keySentence(k) })),
    ready: agents.some(a => a.ready),
  };
}
/** The snapshot's `connect`, from a status: which agents can start work, and which one new work goes to. */
const connectMetaOf = s => ({ ready: s.ready, defaultAgent: s.defaultAgent, agents: s.agents.map(a => ({ id: a.id, name: a.name, ready: a.ready })) });

/**
 * A read of the status moves each sign-in under way on by one step: GitHub's from getting the tool to its code ('code'),
 * to Terminal ('terminal', or in its place the command, where Terminal could not open), to gh signed in while git does
 * not use it yet ('login': setup-git still running, the sign-in still under way), to signed in ('done') or to a refused
 * download ('refused'); an agent's in the browser to signed in ('done') or not finished ('fail'). 'wait' is one more
 * read as it is. With no steps left it holds still.
 */
function advanceSignIns(f) {
  const g = f.gh;
  const step = g.signing && g.signing.steps.length ? g.signing.steps.shift() : null;
  if (step === 'code') { g.installed = true; Object.assign(g.signing, { phase: 'code', code: GH_CODE, url: GH_DEVICE }); }
  if (step === 'terminal') { g.installed = true; Object.assign(g.signing, { phase: 'terminal', code: null, url: null, opened: !g.signing.noTerminal }); }
  if (step === 'login') Object.assign(g, { installed: true, login: 'octocat', git: false });
  if (step === 'done') Object.assign(g, { installed: true, login: 'octocat', git: true, signing: null, said: null });
  if (step === 'refused') Object.assign(g, { signing: null, said: GH_REFUSED });
  for (const a of f.agents) {
    const next = a.signing && a.signing.steps.length ? a.signing.steps.shift() : null;
    if (next === 'done') Object.assign(a, { signedIn: 'yes', how: a.signing.console ? 'your Anthropic Console account' : SIGNED_IN_HOW[a.id] || 'its own sign-in', signing: null, failed: false });
    if (next === 'fail') Object.assign(a, { signing: null, failed: true });
  }
}

function connectWorld(name, now) {
  const raw = [];
  if (name === 'connect-claude' || name === 'connect-github' || name === 'connect-fail') {
    raw.push({ id: 'cw1', name: 'Login page', state: 'working', machineId: 'laptop', now: 'Editing LoginForm.tsx', ageMin: 12, toolCalls: 23 });
  }
  if (name === 'connect-nocodex') {
    raw.push({ id: 'cw2', name: 'Checkout fix', state: 'needs_ok', machineId: 'laptop', now: 'Running the tests', ageMin: 9, sinceMin: 1,
      ask: { id: 'cw-p1', type: 'permission', sentence: 'Checkout fix wants to run the tests', detail: 'npm test -- --silent', why: 'The command is not on the list of safe ones.', options: ['Allow', 'Deny'], primary: 'Allow', ageMin: 1 } });
  }
  const st = world(raw, now);
  const f = connectFacts(name), s = connectStatus(f);
  st.mode = 'live';
  st.repo = { ...CONNECT_REPO, identity: !!(f.git.name && f.git.email) };
  st.harnesses = Object.fromEntries(s.agents.map(a => [a.id, a.ready]));
  const n = st.agents.filter(a => !a.parentId).length;
  st.machines = [{ ...LAPTOP, agents: n, note: n ? `${n} agent${n === 1 ? '' : 's'}` : 'idle' }];
  st.connect = connectMetaOf(s);
  return st;
}

// ---------------------------------------------------------------- full permissions (POST /api/permissions)
//   full        the demo with full permissions on: the band's Full permissions button is lit, and nothing waits for an OK
//               (Checkout fix's migration was allowed by itself, as an automatic approval)
//   full-live   a live repository with Agents & keys beside it (connect-github's), full permissions on: both of the top
//               band's buttons, the widest the band gets
// Every other world starts with them off. The card's words, and what is said when they go on and off, are the engine's.
const FULL_SCENARIOS = ['full', 'full-live'];
SCENARIOS.push(...FULL_SCENARIOS);
const FULL_DETAIL = 'Every agent and its helpers can then run any command, change or delete any file your account can, and use your sign-ins, without asking. It stays on until you turn it off.';
const FULL_ON = 'Full permissions are on. Agents no longer ask.';
const FULL_OFF = 'Agents ask again before risky steps.';
function fullWorld(name, now) {
  const st = name === 'full-live' ? connectWorld('connect-github', now) : scenario('demo', now);
  for (const a of st.agents) {
    if (a.ask?.type !== 'permission') continue;
    Object.assign(a, { ask: null, state: 'working', now: 'Updating the test database', stateSince: now - 20000, approvals: { ...a.approvals, auto: a.approvals.auto + 1 } });
  }
  st.permissions = 'full';
  return st;
}
/** A world as a scenario gives it, with full permissions off unless the scenario turns them on. */
function worldOf(name) {
  const st = scenario(name);
  if (st.permissions !== 'full') st.permissions = 'ask';
  return st;
}
/** Agents & keys' facts for a world: full-live has connect-github's. */
const factsOf = name => connectFacts(name === 'full-live' ? 'connect-github' : name);

/** Start the mock. Resolves to { port, close() }. */
export function startMock({ port = 0, host = '127.0.0.1', quiet = false } = {}) {
  const clients = new Set();
  const posted = [];
  const mode = { answer: 'ok', auth: 'ok', holdMs: 0, down: false, steps: false, merge: 'ok', delay: null };
  const prefs = memoryPrefs();   // the person's choices, as Workbench keeps them across runs
  let name = 'demo';
  let state = worldOf(name);
  let cw = factsOf(name);   // Agents & keys: what Connect knows, in the connect scenarios (null elsewhere)
  let confirmSeq = 0;
  let modeChanges = 0;   // how often full permissions went on or off in this world (permissionsAnswer)
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
  // As the engine does them (ARCHITECTURE.md, "Source control in the engine"; replies and words as src/core/engine.mjs gives them):
  //   POST /api/agents/:id/merge|discard { state }  the engine's card ({ reply, confirm }), or a refusal ({ ok: false, reply })
  //   POST /api/confirm/:id { go }                    settles a card by its kind; a merge or throw-away replies { reply, focusId }
  //   POST /api/command                               "merge it", "throw it away" and the cards' own yes and no words
  // mode.merge is what the next merge does: 'ok'; or it fails and the agent keeps the problem ('conflict' | 'blocked' |
  // 'moved' | 'identity' | 'detached' | 'busy' | 'ancestry' | 'git'); or it fails without one ('changed' | 'nothing' |
  // 'git-old' | 'gone'); or 'refuse': the card itself is refused, as while another merge runs.
  const AT_WORK = new Set(['starting', 'working', 'waiting_helpers', 'needs_ok', 'question', 'maybe_stuck']);
  let mergeSeq = 0;
  const newConfirm = (card, extra = {}) => {
    const id = 'c' + (++confirmSeq).toString(16).padStart(6, '0');
    confirms.set(id, { id, ...card, ...extra });
    // as the engine's _card: a merge or throw-away card names the agent it is about
    return { id, ...card, ...((card.kind === 'merge' || card.kind === 'discard') && extra.agentId ? { agentId: extra.agentId } : {}) };
  };
  const cardOf = c => ({ id: c.id, sentence: c.sentence, detail: c.detail, kind: c.kind, ...(c.yes ? { yes: c.yes } : {}), ...(c.no ? { no: c.no } : {}), ...(typeof c.danger === 'boolean' ? { danger: c.danger } : {}), ...((c.kind === 'merge' || c.kind === 'discard') && c.agentId ? { agentId: c.agentId } : {}), ...(c.kind === 'start' && c.agents ? { agents: c.agents } : {}) });
  const rootOf = a => (a && a.parentId ? state.agents.find(x => x.id === a.rootId) || a : a);
  const joinAnd = xs => (xs.length <= 1 ? xs.join('') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const unend = s => String(s || '').replace(/[.\s]+$/, '');
  /** Why there is no work here to show, merge or throw away (the engine's _noWorkReply). */
  const noWork = (a, verb) => {
    const w = a.work;
    if (w && w.thrownAway) return verb === 'throw away' ? `${a.name}’s work was already thrown away.` : `${a.name}’s work was thrown away, so there is nothing to ${verb}.`;
    if (!w || !w.folder) return `Its folder is gone, so there is nothing to ${verb}.`;
    return null;
  };
  const mergeRefusal = a => {
    if (a.parentId) return 'Helpers work in their agent’s folder. Merge the agent instead.';
    if (AT_WORK.has(a.state)) return `${a.name} is still working. Merge it when it is done.`;
    if (state.mode !== 'live') return 'This is the demo, so nothing is really merged.';
    const gone = noWork(a, 'merge');
    if (gone) return gone;
    const into = state.repo && state.repo.branch;
    if (!into) return 'Your folder is not on a branch, so there is nowhere to merge it.';
    if (state.repo.identity === false) return NO_IDENTITY;
    if (a.files && !a.files.changed) return `${a.name}’s work is already in ${into}.`;
    return null;
  };
  const discardRefusal = a => {
    if (a.parentId) return 'Helpers work in their agent’s folder. Throw away the agent’s work instead.';
    if (state.mode !== 'live') return 'This is the demo, so nothing is really thrown away.';
    return noWork(a, 'throw away');
  };
  // what the engine counts with snapshotWork; the mock's stand-in when nothing counted the files (a stopped or failed agent)
  const workSet = a => a.files || { changed: 2, adds: 9, dels: 3, list: [] };
  /** The engine's merge card: the counts first, then what to know before it merges. */
  const mergeCard = a => {
    const into = state.repo.branch, f = workSet(a), list = f.list || [];
    const parts = [`${f.changed} file${f.changed === 1 ? '' : 's'}, +${f.adds} −${f.dels}. Its work becomes a commit on its branch, joined into ${into} by a merge commit.`];
    if (a.checks?.state === 'failed') {
      const failed = (a.checks.results || []).filter(r => !r.ok).map(r => String(r.name));
      parts.push(failed.length > 1 ? `${failed.length} checks failed: ${joinAnd(failed)}.` : `A check failed: ${failed[0] || 'one of its checks'}.`);
    } else if (a.checks?.state !== 'passed') parts.push('Nothing checked its work.');
    const says = (a.rules?.broken || []).map(r => unend(r.say)).filter(Boolean);
    if (says.length === 1) parts.push(`It broke a rule you set: ${says[0]}.`);
    else if (says.length > 1) parts.push(`It broke ${says.length} rules you set: ${joinAnd(says)}.`);
    const paths = list.map(x => String(x.path || ''));
    if (paths.includes('workbench.json')) parts.push('It changes workbench.json, which sets the checks for later agents.');
    if (paths.some(p => /(^|\/)\.claude(\/|$)/i.test(p))) parts.push('It changes .claude/, which holds Claude Code’s settings for this repository.');
    if (paths.some(p => /(^|\/)\.mcp\.json$/i.test(p))) parts.push('It changes .mcp.json, which can give Claude Code new tools here.');
    const ignored = list.filter(x => x.ignored).length;
    if (ignored) parts.push(`${ignored} file${ignored === 1 ? ' stays' : 's stay'} out: hidden by a .gitignore.`);
    const d = state.repo.dirty || 0;
    if (d) parts.push(`Your ${d} uncommitted change${d === 1 ? ' stays as it is' : 's stay as they are'}.`);
    return { kind: 'merge', sentence: `Merge ${a.name} into ${into}?`, detail: parts.join(' '), yes: 'Merge', no: 'Cancel', danger: false };
  };
  /** The engine's throw-away card: what is deleted, and that a hidden copy is kept. It never has a default answer. */
  const discardCard = a => {
    const n = workSet(a).changed, w = a.work;
    const parts = [`Its folder and ${w.branch ? `its branch ${w.branch}` : 'its branch'} are deleted, with ${n ? `${n} changed file${n === 1 ? '' : 's'}` : 'no changed files'}. Workbench keeps a hidden copy in git.`];
    if (AT_WORK.has(a.state)) parts.push('It is still working: it will be stopped first.');
    return { kind: 'discard', sentence: `Throw away ${a.name}’s work?`, detail: parts.join(' '), yes: 'Throw it away', no: 'Keep it', danger: true };
  };
  // a merge git refused: the engine's sentence for each `why` (mergeSentence); PROBLEM ones stay on the agent
  const WHY = {
    conflict: (a, into) => `${a.name}’s work does not merge cleanly into ${into}.`,
    blocked: (a, into, paths) => `Your own changes are in the way: ${paths.slice(0, 3).join(', ')}. Commit or put them aside, then merge again.`,
    moved: (a, into) => `${into} changed since you looked. Have another look.`,
    identity: () => NO_IDENTITY,
    detached: () => 'Your folder is not on a branch, so there is nowhere to merge it.',
    busy: () => 'Your folder is in the middle of a merge or rebase. Finish that first.',
    ancestry: (a, into) => `${a.name} started from a commit that is no longer in ${into}, so merging it would bring in other work.`,
    git: () => 'Git could not finish the merge. Nothing in your folder changed.',
    changed: a => `${a.name}’s work changed since you looked. Have another look.`,
    nothing: (a, into) => `${a.name}’s work is already in ${into}.`,
    'git-old': () => 'Workbench needs git 2.38 or newer to merge.',
    gone: () => 'Its folder is gone, so there is nothing to merge.',
  };
  const PROBLEM = new Set(['conflict', 'blocked', 'moved', 'identity', 'detached', 'busy', 'ancestry', 'git']);
  /** Settle a card: a launch starts, a forget forgets, a merge merges (or fails as mode.merge says), a throw-away throws away. */
  /**
   * Full permissions on or off, as the engine's _permissions: 'full' is a card, 'ask' is at once, and withdraws every card
   * that would turn them on. modeChanges counts the changes: a card made before the last one is refused (settle).
   */
  const permissionsAnswer = want => {
    if (want === 'ask') {
      for (const [id, c] of confirms) if (c.kind === 'permissions') confirms.delete(id);
      if (state.permissions !== 'full') return { ok: true, reply: 'Agents already ask before risky steps.', permissions: 'ask' };
      state.permissions = 'ask';
      modeChanges++;
      setTimeout(() => { send('snapshot', state); send('notice', { text: FULL_OFF }); }, 60);
      return { ok: true, reply: FULL_OFF, permissions: 'ask' };
    }
    if (state.permissions === 'full') return { ok: true, reply: 'Full permissions are already on.', permissions: 'full' };
    const n = state.agents.filter(a => a.ask && a.ask.type === 'permission').length;
    const detail = n ? `${FULL_DETAIL} The ${n} question${n === 1 ? '' : 's'} waiting now ${n === 1 ? 'is' : 'are'} allowed too.` : FULL_DETAIL;
    const card = { kind: 'permissions', sentence: 'Let agents do anything without asking?', detail, yes: 'Turn on full permissions', no: 'Keep asking', danger: true };
    return { reply: card.sentence, confirm: newConfirm(card, { modeAt: modeChanges }) };
  };
  const settle = (c, go) => {
    if (c.kind === 'permissions') {
      if (c.modeAt !== modeChanges) return { reply: 'That changed. Have another look.' };
      if (!go) return { reply: 'OK, agents still ask before risky steps.' };
      state.permissions = 'full';
      modeChanges++;
      // every permission question waiting is allowed, as an automatic approval, and the reply counts them
      let n = 0;
      for (const a of state.agents) {
        if (a.ask?.type !== 'permission') continue;
        Object.assign(a, { ask: null, state: 'working', stateSince: Date.now(), now: 'Carrying on', approvals: { ...a.approvals, auto: a.approvals.auto + 1 } });
        n++;
      }
      countHelpers(state.agents);
      const reply = n ? `Full permissions are on. ${n} waiting question${n === 1 ? ' was' : 's were'} allowed.` : FULL_ON;
      setTimeout(() => { send('snapshot', state); send('notice', { text: reply }); }, 60);
      return { reply, permissions: 'full' };
    }
    if (c.kind === 'forget') {
      if (!go) return { reply: 'OK, I won’t forget it.' };
      state.agents = state.agents.filter(x => x.id !== c.forget);
      setTimeout(() => send('snapshot', state), 60);
      return { reply: 'Forgot it. Its folder and branch are still on this computer.' };
    }
    if (c.kind !== 'merge' && c.kind !== 'discard') return go ? started(c) : { reply: 'OK, I won’t start it.' };
    if (!go) return { reply: c.kind === 'merge' ? 'OK, I won’t merge it.' : 'OK, I won’t throw it away.' };
    const a = state.agents.find(x => x.id === c.agentId);
    if (!a) return { reply: 'I can’t find that agent.' };
    // everything is checked again at the moment of acting
    const no = c.kind === 'merge' ? mergeRefusal(a) : discardRefusal(a);
    if (no) return { reply: no, focusId: a.id };
    const now = Date.now();
    if (c.kind === 'discard') {
      if (AT_WORK.has(a.state)) Object.assign(a, { state: 'stopped', endedAt: now, stateSince: now, ask: null });
      a.work = { ...a.work, branch: null, folder: false, problem: null, thrownAway: { at: now, saved: `refs/workbench/discarded/${a.id}` } };
      setTimeout(() => send('agents', [a]), 60);
      return { reply: `Threw away ${a.name}’s work. Its folder and branch are gone.`, focusId: a.id };
    }
    const into = state.repo.branch, how = mode.merge || 'ok';
    if (WHY[how]) {
      const paths = how === 'blocked' ? ['src/cart/total.ts', 'README.md'] : how === 'conflict' ? (a.files?.list || []).map(x => x.path).slice(0, 4) : [];
      const sentence = WHY[how](a, into, paths);
      if (PROBLEM.has(how)) a.work = { ...a.work, problem: { why: how, sentence, paths, at: now } };
      else if (how === 'gone') a.work = { ...a.work, folder: false };
      if (PROBLEM.has(how) || how === 'gone') setTimeout(() => send('agents', [a]), 60);
      return { reply: sentence, focusId: a.id };
    }
    const f = workSet(a);
    const merge = ((++mergeSeq).toString(16) + 'c0ffee5eed'.repeat(4)).slice(0, 40);
    a.work = { ...a.work, merged: { into, merge, at: now, files: f.changed || 0, adds: f.adds || 0, dels: f.dels || 0 }, problem: null };
    a.files = { changed: 0, adds: 0, dels: 0, list: [] };
    state.repo = { ...state.repo, head: merge.slice(0, 7) };
    setTimeout(() => { send('agents', [a]); send('repo', state.repo); }, 60);
    return { reply: `Merged ${a.name} into ${into}.`, focusId: a.id };
  };

  // ---------------------------------------------------------------- Agents & keys: the connect panel's routes
  // As src/server/http.mjs and src/core/connect.mjs answer them (see "Agents & keys" above startMock), in their words.
  const NO_CONNECT_DEMO = 'The demo’s agents are simulated, so there is nothing to connect. Run Workbench on a repository to connect your own agents and keys.';
  const NO_CONNECT = 'Agents & keys is not available in this Workbench. The details are in its log.';
  const WENT_WRONG = 'Something went wrong in the workbench. The details are in its log.';
  /** A fresh status; when what it says of the agents changed, open pages get a fresh snapshot, as the server sends one. */
  const connectNow = () => {
    const s = connectStatus(cw), meta = connectMetaOf(s);
    if (JSON.stringify(meta) !== JSON.stringify(state.connect)) {
      state.connect = meta;
      state.harnesses = Object.fromEntries(s.agents.map(a => [a.id, a.ready]));
      setTimeout(() => send('snapshot', state), 60);
    }
    return s;
  };
  const connectRoute = (method, p, b, res) => {
    const answer = (code, o) => { res.statusCode = code; res.end(JSON.stringify(o)); };
    if (!cw) return answer(404, { error: state.mode === 'demo' ? NO_CONNECT_DEMO : NO_CONNECT });
    const k = mode.connect || {};
    const done = (sentence = null, extra = {}) => answer(200, { ...extra, ok: true, sentence, status: connectNow() });
    const no = (code, error) => answer(code, { error });
    const text = v => (typeof v === 'string' ? v.trim() : '');
    if (p === '/api/connect') {
      if (method !== 'GET') return no(405, 'That method is not allowed here.');
      if (cw.fail || k.fail) return no(500, WENT_WRONG);
      advanceSignIns(cw);
      return done();
    }
    if (method !== 'POST') return no(405, 'That method is not allowed here.');
    if (p === '/api/connect/recheck') {
      if (cw.fail || k.fail) return no(500, WENT_WRONG);
      // what the person did in Terminal (or Apple's installer) meanwhile: signed in, or installed (and not signed in yet)
      for (const [id, what] of cw.pending) {
        const a = cw.agents.find(x => x.id === id);
        if (id === 'git') cw.git.installed = true;
        else if (a && what === 'install') Object.assign(a, { found: true, version: id === 'claude' ? '2.1.322' : '0.166.0', from: 'your PATH', signedIn: 'no', how: null });
        else if (a) Object.assign(a, { signedIn: 'yes', how: id === 'claude' ? 'your Claude subscription' : 'your ChatGPT account', failed: false });
      }
      cw.pending.clear();
      advanceSignIns(cw);
      return done();
    }
    const am = /^\/api\/connect\/agents\/([^/]+)\/(install|signin|signin\/cancel|key|default)$/.exec(p);
    if (am) {
      const a = cw.agents.find(x => x.id === decodeURIComponent(am[1])), act = am[2];
      if (!a) return no(404, 'Workbench does not know that agent.');
      if (act === 'signin/cancel') {
        if (!a.signing) return done(`${a.name} was not waiting for a sign-in.`);
        a.signing = null;
        return done(`Stopped the sign-in to ${a.name}.`);
      }
      if (act === 'signin' && !a.found) return no(409, `${a.name} is not installed yet, so there is nothing to sign in to.`);
      if (act === 'signin' && b?.terminal !== true) {
        // the agent's own login, in the browser (Claude Code's Anthropic Console account with { console: true }): one at
        // a time, so a second press answers with the one already waiting
        if (b?.console === true && a.id !== 'claude') return no(400, 'Only Claude Code signs in with an Anthropic Console account.');
        if (a.signing) return done(`${a.name} is already waiting for you to finish signing in in your browser.`, { waiting: true });
        const how = k.browser || 'ok';
        a.failed = false;
        a.signing = { since: Date.now(), console: b?.console === true, steps: how === 'fail' ? ['wait', 'fail'] : how === 'wait' ? [] : ['wait', 'done'] };
        const site = a.signing.console ? 'the Anthropic Console' : SIGN_IN_SITE[a.id] || a.name;
        return done(`Your browser is opening ${site}’s sign-in page. Finish signing in there.`, { waiting: true });
      }
      if (act === 'install' || act === 'signin') {
        const command = act === 'install' ? INSTALLERS[a.id] : SIGN_INS[a.id];
        a.signing = null;
        if (k.terminal === false) {
          return done(`Run this command in a terminal to ${act === 'install' ? 'install' : 'sign in to'} ${a.name}, then check again.`, { opened: false, command });
        }
        cw.pending.set(a.id, act);
        return done(act === 'install' ? `Terminal is installing ${a.name}. When it finishes, come back here.`
          : `Terminal is open for you to sign in to ${a.name}. When you are done, come back here.`, { opened: true });
      }
      if (act === 'key') {
        // "Use an API key": kept for all repositories, for this agent only, in place of the one this button kept before
        const v = text(b?.value);
        if (!v) return no(400, 'Paste the key first.');
        const [preset, names] = AGENT_KEYS[a.id] || ['custom', ['API_KEY']];
        cw.keys = cw.keys.filter(x => !(x.preset === preset && x.scope.kind === 'all' && Array.isArray(x.agents) && x.agents.length === 1 && x.agents[0] === a.id));
        cw.keys.push({ id: `k${++cw.seq}`, preset, label: presetById(preset)?.label || 'Key', scope: { kind: 'all' }, agents: [a.id], created: Date.now(),
          vars: names.map(n => ({ name: n, shown: maskedValue(v) })) });
        if (a.found) Object.assign(a, { signedIn: 'yes', how: 'an API key' });
        return done(`${a.name} will use this API key from now on, and each request is billed to it.`);
      }
      cw.chosen = a.id;
      return done(agentReady(a) ? `New work will go to ${a.name}.` : `New work will go to ${a.name} once it is ready.`);
    }
    if (p === '/api/connect/git/install') {
      // Apple's installer for its developer tools "opens"; the next re-check finds git
      if (cw.git.installed !== false) return no(409, 'Git is already installed.');
      cw.pending.set('git', 'install');
      return done('Apple’s installer is open. When it has installed the developer tools, come back here.', { opened: true });
    }
    if (p === '/api/connect/git') {
      if (cw.git.installed === false) return no(409, 'Git is not installed yet, so it cannot keep your name and email.');
      const n = text(b?.name), e = text(b?.email);
      if (!n || Array.from(n).length > 100 || /[<>\p{Cc}]/u.test(n)) return no(400, 'A name for git must be 1 to 100 characters on one line, without < or >.');
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) || e.length > 254) return no(400, 'That does not look like an email address.');
      cw.git = { name: n, email: e, installed: true };
      return done(`Git will make your merges as ${n}, ${e}.`);
    }
    if (p === '/api/connect/github/signin') {
      // GitHub's own command-line tool: got first when it is missing, then its sign-in, by steps (advanceSignIns). One at
      // a time: a second press answers with the one under way. Signed in already but git not using it: Workbench only
      // makes git use it (setup-git), and answers when that is done.
      const tool = cw.gh;
      if (cw.github || (tool.login && tool.git)) return no(409, 'GitHub is already connected.');
      if (tool.signing) return done('Workbench is already signing you in to GitHub.');
      if (tool.login) {
        tool.git = true;
        return done(ghSignedWords(tool.login, true));
      }
      const how = k.gh || 'ok';
      const after = how === 'terminal' ? ['terminal', 'wait', 'done'] : how === 'wait' ? ['code'] : ['code', 'wait', 'login', 'done'];
      const noTerminal = k.terminal === false;
      tool.said = null;
      if (!tool.installed) {
        tool.signing = { phase: 'installing', since: Date.now(), noTerminal, steps: how === 'refused' ? ['refused'] : after };
        return done(GH_PHASE_WORDS.installing);
      }
      const first = after.shift();
      tool.signing = first === 'terminal' ? { phase: 'terminal', opened: !noTerminal, since: Date.now(), noTerminal, steps: after }
        : { phase: 'code', code: GH_CODE, url: GH_DEVICE, since: Date.now(), noTerminal, steps: after };
      return done(ghPhaseWords(tool.signing));
    }
    if (p === '/api/connect/github/signin/cancel') {
      if (!cw.gh.signing) return done('Workbench was not signing you in to GitHub.');
      cw.gh.signing = null;
      return done('Stopped signing in to GitHub.');
    }
    if (p === '/api/connect/github/signout') {
      // answered with `opened` (and `command`), as the route answers it
      if (!cw.gh.login) return no(409, 'GitHub is not signed in.');
      if (k.signout === 'fail') {
        return answer(200, { why: 'gh', opened: false, command: GH_SIGN_OUT_COMMAND, ok: false,
          sentence: 'Workbench could not sign out of GitHub. Run this command in a terminal, then check again.', status: connectNow() });
      }
      Object.assign(cw.gh, { login: null, git: false });
      return done('Signed out of GitHub. GitHub still lists this sign-in under Settings → Applications until you revoke it there.', { opened: false });
    }
    if (p === '/api/connect/github') {
      if (!text(b?.token)) return no(400, 'Paste the code GitHub made for you first.');
      if (k.github === 'token') {
        return answer(200, { login: null, ok: false, sentence: 'GitHub did not accept that token. Check that you copied all of it, then try again.', status: connectNow() });
      }
      cw.github = { login: 'octocat', agentsUseIt: b.agentsUseIt === true };
      return done('Connected to GitHub as octocat.', { login: 'octocat' });
    }
    if (p === '/api/connect/github/agents') {
      // "Let agents use this token": Connect reads the token from the key store, and keeps it again with the other choice
      if (!cw.github) return no(409, 'GitHub is not connected.');
      if (k.githubAgents === 'token') {
        return answer(200, { why: 'token', ok: false, sentence: 'Workbench cannot read the GitHub token back from git, so this cannot change. Disconnect GitHub, then connect it again.', status: connectNow() });
      }
      cw.github.agentsUseIt = b?.agentsUseIt === true;
      return done(cw.github.agentsUseIt ? 'Agents can use your GitHub token now, as GH_TOKEN.' : 'Agents no longer get your GitHub token. Git still uses it.');
    }
    if (p === '/api/connect/github/disconnect') {
      cw.github = null;
      return done('GitHub is disconnected. The token itself still works until you delete it on GitHub.');
    }
    if (p === '/api/connect/keys') {
      // which values are secret comes from the preset (a custom key's are all secret); `also` names get the same value
      const preset = typeof b?.preset === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(b.preset) ? presetById(b.preset) : null;
      if (!preset) return no(400, 'Workbench does not know that kind of key.');
      if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) return no(400, 'Fill in the key first.');
      const values = {};
      for (const [n, v] of Object.entries(b.values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n) || n === '__proto__') return no(400, 'A name may have only letters, digits and _, and may not start with a digit.');
        if (typeof v !== 'string') return no(400, 'Each value must be text.');
        if (v.trim()) values[n] = v.trim();
      }
      const fields = preset.id !== 'custom' && Array.isArray(preset.fields) ? preset.fields : null;
      let secret = new Set(Object.keys(values));
      if (fields) {
        const also = f => (Array.isArray(f.also) ? f.also : []);
        const known = new Set(fields.flatMap(f => [f.name, ...also(f)]));
        if (Object.keys(values).some(n => !known.has(n))) return no(400, `${preset.label} keys take only ${andList(fields.map(f => f.name))}.`);
        for (const f of fields) {
          if (!values[f.name] && !f.optional) return no(400, `Fill in ${f.name}.`);
          if (values[f.name]) for (const x of also(f)) if (!values[x]) values[x] = values[f.name];
        }
        secret = new Set(fields.filter(f => f.secret).flatMap(f => [f.name, ...also(f)]));
      }
      if (!Object.keys(values).length) return no(400, 'Fill in the key first.');
      const scope = b.scope === 'repo' ? 'repo' : b.scope === 'all' || b.scope == null ? 'all' : null;
      if (!scope) return no(400, 'Choose this repository or all repositories.');
      const agents = b.agents === 'all' || b.agents == null ? 'all'
        : Array.isArray(b.agents) && b.agents.length && b.agents.length <= 20 && b.agents.every(x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(x)) ? [...new Set(b.agents)] : null;
      if (!agents) return no(400, 'Choose which agents get the key.');
      const label = text(b.label) || preset.label || 'Key';
      cw.keys.push({ id: `k${++cw.seq}`, preset: preset.id, label, scope: scope === 'repo' ? { kind: 'repo', root: CONNECT_REPO.root } : { kind: 'all' }, agents, created: Date.now(),
        vars: Object.entries(values).map(([n, v]) => ({ name: n, shown: secret.has(n) ? maskedValue(v) : v })) });
      return done(`Saved ${label}, for ${scope === 'repo' ? 'this repository' : 'all repositories'}.`);
    }
    const rm = /^\/api\/connect\/keys\/([^/]+)\/remove$/.exec(p);
    if (rm) {
      const before = cw.keys.length;
      cw.keys = cw.keys.filter(x => x.id !== decodeURIComponent(rm[1]));
      return done(cw.keys.length < before ? 'Removed the key.' : 'That key was already gone.');
    }
    return no(404, 'Not found.');
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
        name = b.name; state = worldOf(name); cw = factsOf(name); confirms.clear();
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
      if (p === '/ctl/reads') { res.end(JSON.stringify(GIT_READS)); return; }   // D1: the git screen's GETs
      if (p === '/ctl/clear') { posted.length = 0; res.end('{"ok":true}'); return; }
      if (p === '/ctl/prefs') {
        if ((b.permissions === 'full' || b.permissions === 'ask') && b.permissions !== state.permissions) { state.permissions = b.permissions; modeChanges++; }
        const { permissions, ...choices } = b;
        if (Object.keys(choices).length) prefs.set(cleanPrefs({ ...prefs.get(), ...choices }));
        const { permissions: kept, ...now } = prefs.get();
        res.end(JSON.stringify({ ...now, permissions: state.permissions })); return;
      }
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
      // the person's choices, whatever mode.answer says, as the real server keeps them apart from the engine
      if (p === '/api/prefs') {
        res.setHeader('content-type', 'application/json');
        const page = ({ theme, detail, answered }) => ({ theme, detail, answered });   // never the permission mode
        if (req.method === 'GET') { res.end(JSON.stringify(page(prefs.get()))); return; }
        let change;
        try { change = prefsChange(json); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); return; }
        res.end(JSON.stringify({ ok: true, ...page(prefs.set(change).prefs) })); return;
      }
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
      // the engine does git work before it answers a merge or a throw-away: mode.delay makes those replies (and typed
      // words, and a card's answers) take as long as it says
      const slow = req.method === 'POST' && mode.delay && mode.delay[p === '/api/command' ? 'command' : p.startsWith('/api/confirm/') ? 'confirm' : (/\/(merge|discard)$/.exec(p) || [])[1]];
      if (slow > 0) await new Promise(r => setTimeout(r, slow));
      res.setHeader('content-type', 'application/json');
      const reply = r => res.end(JSON.stringify(r));
      // D1: the git screen's two reads. Refusals are 200 { ok: false, reply }, as the engine's are.
      const gm = req.method === 'GET' && (p === '/api/git' ? [p] : /^\/api\/agents\/([^/]+)\/changes$/.exec(p));
      if (gm) {
        GIT_READS.push({ at: Date.now(), path: p });
        if (mode.answer === 'refuse') return reply({ ok: false, reply: p === '/api/git' ? 'Workbench could not read the history of your repository.' : 'Workbench could not read that agent’s changes.' });
        return reply(p === '/api/git' ? gitGraphOf(state) : changesOf(state, decodeURIComponent(gm[1])));
      }
      const m = /^\/api\/agents\/([^/]+)\/(answer|say|stop|raise-limit)$/.exec(p);
      if (m) {
        const a = state.agents.find(x => x.id === decodeURIComponent(m[1]));
        if (!a) return reply({ ok: false, reply: 'There is no such agent.' });
        if (mode.answer === 'refuse') return reply({ ok: false, reply: `I could not reach ${a.name}.` });
        if (m[2] === 'raise-limit') {
          // as the engine checks it: the state the button was drawn for, then a live Claude Code root at its limit
          if (json && json.state && json.state !== a.state) return reply({ ok: false, reply: 'That changed. Have another look.' });
          if (state.mode !== 'live') return reply({ ok: false, reply: 'This is the demo, so nothing is really spent.' });
          if (a.parentId || a.earlier || a.harness !== 'claude' || a.state !== 'failed' || !a.atLimit) return reply({ ok: false, reply: `${a.name} has not reached its spending limit.` });
          const limit = (a.budgetUsd || state.defaultBudgetUsd) + state.defaultBudgetUsd;
          Object.assign(a, { state: 'working', stateReason: null, atLimit: false, endedAt: null, stateSince: Date.now(), now: 'Picking up where it left off', budgetUsd: limit });
          setTimeout(() => changed([a]), 60);
          return reply({ ok: true, reply: `${a.name} can spend $${limit.toFixed(2)} in all now, and it is continuing.` });
        }
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
      // D2: merge and throw-away always ask first, with the engine's card; refusals are { ok: false, reply }
      const wm = /^\/api\/agents\/([^/]+)\/(merge|discard)$/.exec(p);
      if (wm && req.method === 'POST') {
        const a = state.agents.find(x => x.id === decodeURIComponent(wm[1]));
        if (!a) return reply({ ok: false, reply: 'I can’t find that agent.' });
        const merge = wm[2] === 'merge', refusal = merge ? mergeRefusal : discardRefusal;
        if (mode.merge === 'refuse') return reply({ ok: false, reply: `${a.name} is being merged now.` });
        const first = a.parentId || (merge && AT_WORK.has(a.state)) ? refusal(a) : null;
        if (first) return reply({ ok: false, reply: first });
        if (json && json.state && json.state !== a.state) return reply({ ok: false, reply: 'That changed. Have another look.' });
        const no = refusal(a);
        if (no) return reply({ ok: false, reply: no });
        const card = merge ? mergeCard(a) : discardCard(a);
        return reply({ reply: card.sentence, confirm: newConfirm(card, { agentId: a.id }) });
      }
      if (p === '/api/permissions' && req.method === 'POST') {
        const want = json?.mode;
        if (want !== 'full' && want !== 'ask') { res.statusCode = 400; return reply({ error: 'Say whether agents should ask first or have full permissions.' }); }
        if (mode.answer === 'refuse') return reply({ ok: false, reply: 'Workbench could not do that just now.' });
        const out = permissionsAnswer(want);
        if (!out.confirm) send('notice', { text: out.reply });
        return reply(out);
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
        if (shown && shown.kind === 'permissions') {
          // its own words (src/core/commands.mjs): "turn it on", "do it" or the words that ask for them; "keep asking",
          // "turn it off" and its kin, or a no. A bare "yes" is not enough, and a question answers nothing: the card stays.
          if (/^(turn (it|them) on|turn on full permissions|do it|stop asking|full permissions|allow everything)$/i.test(text)) { confirms.delete(shown.id); return reply(settle(shown, true)); }
          if (/^(keep asking|no|cancel|never mind|ask first|ask me first|(turn|switch|leave|keep) ((it|them) )?off)$/i.test(text)) { confirms.delete(shown.id); return reply(settle(shown, false)); }
          return reply({ reply: 'I did not catch that. Say “do it” to turn on full permissions, or “cancel”.', confirm: cardOf(shown) });
        }
        if (shown) {
          // a card's own words (src/core/commands.mjs): "merge it" is a yes to a merge; a throw-away needs its own words or
          // "do it", and a bare "yes" is not enough; "forget it" cancels everywhere. Words not understood keep the card.
          const yes = shown.kind === 'discard' ? /^(throw it away|discard it|do it)$/i
            : shown.kind === 'merge' ? /^(yes|ok|do it|go ahead|sure|merge it|merge|land it)$/i
            : shown.kind === 'start' ? /^(yes|ok|do it|go ahead|sure|start it|launch it)$/i : /^(yes|ok|do it|go ahead|sure)$/i;
          if (yes.test(text)) { confirms.delete(shown.id); return reply(settle(shown, true)); }
          if (/^(no|cancel|never mind|stop|forget it|keep it|don.t)$/i.test(text)) { confirms.delete(shown.id); return reply(settle(shown, false)); }
          const verb = { merge: 'merge it', discard: 'throw it away', forget: 'forget it', start: 'start it' }[shown.kind] || 'go ahead';
          if (/^(yes|yeah|yep|ok|okay|sure|go ahead|merge it|land it|start it)$/i.test(text) || !/^(merge|land|throw|discard|scrap|forget|start|what)\b/i.test(text)) {
            return reply({ reply: `I did not catch that. Say “do it” to ${verb}, or “cancel”.`, confirm: cardOf(shown) });
          }
          confirms.delete(shown.id);   // any other command withdraws the card on screen
        }
        if (/^(merge|land)\b|^bring its changes in\b/i.test(text) || /^(throw (it|its work|its changes) away|throw away|discard|scrap)\b/i.test(text)) {
          const merge = /^(merge|land|bring)/i.test(text);
          // the agent the words name ("merge search cleanup"), else the one on screen ("merge it"), as the parser does
          const named = text.replace(/^(merge|land|bring its changes in|throw (it|its work|its changes) away|throw away|discard|scrap)\b\s*/i, '').replace(/\s+into\s+\S+$/i, '').trim().toLowerCase();
          const byName = named && !/^(it|its work|its changes|that|this)$/.test(named) ? state.agents.find(x => !x.parentId && x.name.toLowerCase() === named) : null;
          const a = byName || rootOf(state.agents.find(x => x.id === json?.focusId));
          if (!a) return reply({ reply: `I couldn’t tell which agent to ${merge ? 'merge' : 'throw away'}.` });
          const no = merge ? mergeRefusal(a) : discardRefusal(a);
          if (no) return reply({ reply: no, focusId: a.id });
          const card = merge ? mergeCard(a) : discardCard(a);
          // the engine's reply to a typed merge or throw-away is the card alone: no focusId; the card names its agent
          return reply({ reply: card.sentence, confirm: newConfirm(card, { agentId: a.id }) });
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
          // as the engine's _card: a launch card says how many agents it starts
          const agents = eight ? 8 : 1;
          confirms.set(id, { id, kind: 'start', sentence, detail, agents });
          return reply({ reply: sentence, confirm: { id, kind: 'start', sentence, detail, agents } });
        }
        // full permissions, said whole: on asks first with the card, off is at once
        if (/^(full permissions|turn on full permissions|full permissions on|allow everything|stop asking|don'?t ask me|full access)$/i.test(text)) {
          const out = permissionsAnswer('full');
          return reply(out.confirm ? out : { reply: out.reply });
        }
        if (/^(ask (me )?first|ask (me )?again|turn off full permissions|full permissions off)$/i.test(text)) {
          const out = permissionsAnswer('ask');
          send('notice', { text: out.reply });
          return reply({ reply: out.reply });
        }
        if (/what needs me/i.test(text)) {
          const need = state.agents.filter(a => ['needs_ok', 'question', 'maybe_stuck', 'checks_failed'].includes(a.state));
          return reply({ reply: need.length ? `${need.length} thing${need.length === 1 ? '' : 's'} need${need.length === 1 ? 's' : ''} you.` : 'Nothing needs you.', focusId: need[0]?.id });
        }
        return reply({ reply: 'I did not catch that. Say what to work on, like “the login page is broken”, or ask “what needs me”.' });
      }
      // Agents & keys: the connect panel's routes (404 outside the connect scenarios, as in the demo)
      if (p === '/api/connect' || p.startsWith('/api/connect/')) {
        if (mode.delay && mode.delay.connect > 0) await new Promise(r => setTimeout(r, mode.delay.connect));
        return connectRoute(req.method, p, json, res);
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
    if (file === path.join(ROOT, 'ui', 'index.html')) {
      // the page, with the person's choices on <html>, as the real server sends it
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', ...SECURITY });
      res.end(pageWithPrefs(fs.readFileSync(file, 'utf8'), { ...prefs.get(), permissions: state.permissions })); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...SECURITY });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, host, () => {
    const actual = server.address().port;
    if (!quiet) console.log('mock on', actual);
    resolve({
      port: actual,
      setScenario(n) { name = n; state = scenario(n); cw = connectFacts(n); confirms.clear(); },
      close: () => new Promise(r => { clearInterval(stepTimer); for (const c of clients) c.destroy(); server.close(() => r()); }),
    });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startMock({ port: Number(process.argv[2] || 0) });
}
