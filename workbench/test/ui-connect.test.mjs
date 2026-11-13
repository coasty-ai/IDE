// Agents & keys on the page: ui/connectview.js (pure: from a ConnectStatus to rows, words and buttons, how keys read,
// what a new key sends, the board's key guard), the lid's "Connect a coding agent to start." (ui/focus.js), the panel's
// requests (ui/api.js), and the CSS and wiring they are drawn with. The page imports /shared/... by URL, so that path is
// mapped to src/shared/ with module.registerHooks (Node 22.15 or later), as test/ui-focus.test.mjs does.
// Fake keys are made from parts at runtime: nothing here looks like a real key to a secret scanner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as V from '../ui/connectview.js';
import { esc } from '../ui/util.js';
import { hasHidden } from '../ui/diffview.js';
import * as presetModule from '../src/shared/keypresets.mjs';
import * as shape from '../src/shared/secretshape.mjs';
import { palettes, ratio, THEMES, PAIRS } from '../scripts/ui-contrast.mjs';

const SHARED = fileURLToPath(new URL('../src/shared/', import.meta.url));
const canMap = typeof nodeModule.registerHooks === 'function';
if (canMap) {
  nodeModule.registerHooks({
    resolve(spec, ctx, next) {
      if (spec.startsWith('/shared/')) return { url: pathToFileURL(SHARED + spec.slice('/shared/'.length)).href, shortCircuit: true };
      return next(spec, ctx);
    },
  });
}
const skip = canMap ? false : 'needs module.registerHooks (Node 22.15 or later)';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const U = code => String.fromCodePoint(code);   // no hidden character is ever in this file raw
const fake = (...parts) => parts.join('');
const PRESETS = presetModule.KEY_PRESETS;
const looks = shape.looksLikeSecret;

// ---------------------------------------------------------------- fixtures: ConnectStatus as the spec gives it
const agent = (o = {}) => ({ id: 'claude', name: 'Claude Code', found: true, version: '2.1.322', from: 'the VS Code extension', signedIn: 'yes',
  how: 'your Claude subscription', ready: true, isDefault: true, sentence: '', actions: ['key', 'recheck'], ...o });
const CODEX_OUT = { id: 'codex', name: 'Codex', found: true, version: '0.166.0', from: 'your PATH', signedIn: 'no', how: null, ready: false, isDefault: false, sentence: '', actions: ['signin', 'key', 'recheck', 'default'] };
const CODEX_MISSING = { id: 'codex', name: 'Codex', found: false, version: null, from: null, signedIn: 'unknown', how: null, ready: false, isDefault: false, sentence: '', actions: ['install', 'key', 'recheck'] };
const AWS_KEY = { id: 'k1', preset: 'aws', label: 'AWS', vars: [{ name: 'AWS_ACCESS_KEY_ID', shown: '•••• 7QXA' }, { name: 'AWS_SECRET_ACCESS_KEY', shown: '•••• 9f2b' }],
  scope: { kind: 'all' }, agents: 'all', created: 1 };
const status = (o = {}) => ({
  agents: [agent(), CODEX_OUT], defaultAgent: 'claude', platform: 'darwin', canOpenTerminal: true,
  git: { name: 'Sam Lee', email: 'sam@example.com', sentence: '' }, github: { connected: false, login: null, agentsUseIt: false, sentence: '' },
  keys: [AWS_KEY], ready: true, ...o,
});
const html = (s, v = {}) => V.panelParts(s, { presets: PRESETS, looksLikeSecret: looks, ...v }).map(p => p.html).join('');
/** Every button in some markup, with its data-* attributes, aria-disabled and its label. */
const buttons = h => [...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({
  ...Object.fromEntries([...m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map(x => [x[1], x[2]])),
  disabled: /aria-disabled="true"/.test(m[1]), pri: /class="cn-btn pri"/.test(m[1]), label: m[2].replace(/<[^>]+>/g, ''),
}));
const inputs = h => [...h.matchAll(/<input\b([^>]*)>/g)].map(m => m[1]);

// ---------------------------------------------------------------- the snapshot's meta.connect, the band, the lid
test('meta.connect is read from the snapshot (flat or under meta); without it the board is as it was', () => {
  for (const snap of [{}, { connect: null }, { connect: { ready: 'no' } }, { meta: {} }, null, undefined, { connect: { agents: [] } }]) assert.equal(V.connectMeta(snap), null, JSON.stringify(snap));
  const m = { ready: false, defaultAgent: null, agents: [{ id: 'claude', name: 'Claude Code', ready: false }, { id: 'bad id', name: 'x', ready: true }, null] };
  assert.deepEqual(V.connectMeta({ connect: m }), { ready: false, defaultAgent: null, agents: [{ id: 'claude', name: 'Claude Code', ready: false }] });
  assert.deepEqual(V.connectMeta({ meta: { connect: m } }), V.connectMeta({ connect: m }));
  assert.equal(V.connectMeta({ connect: { ready: true, defaultAgent: '../x', agents: [] } }).defaultAgent, null, 'an id that does not fit is dropped');
});

test('the top band’s light: calm when an agent is ready for new work, lit when none is; none without meta.connect', () => {
  assert.equal(V.bandView(null), null);
  const ready = V.bandView(V.connectMeta({ connect: { ready: true, defaultAgent: 'codex', agents: [{ id: 'claude', name: 'Claude Code', ready: true }, { id: 'codex', name: 'Codex', ready: true }] } }));
  assert.equal(ready.light, 'ok');
  assert.equal(ready.label, 'Agents & keys');
  assert.equal(ready.said, 'Codex is ready for new work.');
  assert.match(ready.aria, /^Agents & keys: /, 'its name starts with its words');
  const none = V.bandView(V.connectMeta({ connect: { ready: false, defaultAgent: null, agents: [{ id: 'claude', name: 'Claude Code', ready: false }] } }));
  assert.equal(none.light, 'need');
  assert.equal(none.said, 'No coding agent is ready yet. Connect one here.');
  const odd = V.bandView({ ready: true, defaultAgent: 'claude', agents: [{ id: 'claude', name: `Cl${U(0x202e)}aude`, ready: true }] });
  assert.equal(hasHidden(odd.aria), false, 'an agent’s name shows its hidden characters');
});

test('the lid’s words when no agent is ready name the agents Workbench drives', () => {
  const w = V.lidConnectWords({ ready: false, agents: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }] });
  assert.equal(w.sentence, 'Connect a coding agent to start.');
  assert.equal(w.sub, 'Sign in to Claude Code or Codex, or give one an API key.');
  assert.equal(V.lidConnectWords({ ready: false, agents: [] }).sub, 'Sign in to a coding agent, or give one an API key.');
  assert.equal(V.listOr(['A', 'B', 'C']), 'A, B or C');
  assert.equal(V.listAnd(['A', 'B']), 'A and B');
});

test('the lid: "Connect a coding agent to start." with Connect, in place of "Nothing needs you."; its own key', { skip }, async () => {
  const { lidView, focusKey } = await import('../ui/focus.js');
  const { S } = await import('../ui/model.js');
  S.agents.clear();
  const meta = V.connectMeta({ connect: { ready: false, defaultAgent: null, agents: [{ id: 'claude', name: 'Claude Code', ready: false }, { id: 'codex', name: 'Codex', ready: false }] } });
  const v = lidView({ empty: true, aside: [], connect: meta }, { detail: 'calm' });
  assert.equal(v.key, 'connect');
  assert.equal(focusKey({ empty: true, connect: meta }), 'connect');
  assert.equal(focusKey({ empty: true }), 'empty', 'without it, the key is as before');
  assert.equal(v.idle, false, 'it needs the person: the lit lid');
  assert.match(v.html, /<h1[^>]*>Connect a coding agent to start\.<\/h1>/);
  assert.match(v.html, /Sign in to Claude Code or Codex, or give one an API key\./);
  const b = buttons(v.html);
  assert.equal(b.length, 1);
  assert.equal(b[0].act, 'connect');
  assert.equal(b[0].label, 'Connect');
  assert.match(v.html, /class="big pri"/);
  assert.deepEqual(v.bind, {}, 'words typed while it shows are bound to nothing');
  assert.doesNotMatch(v.html, /Not connected/, 'those words belong to the page’s own link');
  // short of room, the meta line goes; the sentence and Connect stay
  const tight = lidView({ empty: true, aside: [], connect: meta }, { detail: 'calm', fit: 6 });
  assert.doesNotMatch(tight.html, /class="meta"/);
  assert.match(tight.html, /Connect a coding agent to start\./);
  assert.equal(buttons(tight.html)[0].act, 'connect');
  // without meta.connect the empty lid is unchanged
  const empty = lidView({ empty: true, aside: [] }, { detail: 'calm' });
  assert.equal(empty.key, 'empty');
  assert.match(empty.html, /Nothing needs you\./);
});

// ---------------------------------------------------------------- agents: every state, its sentence, light and buttons
test('every agent state has its own sentence, made from the facts when Workbench sent none', () => {
  const s = a => V.agentSentence(V.agentsOf({ agents: [a] })[0]);
  assert.equal(s(agent()), 'Claude Code 2.1.322 is ready, signed in with your Claude subscription.');
  assert.equal(s(agent({ how: 'an API key' })), 'Claude Code 2.1.322 is ready, signed in with an API key.');
  assert.equal(s(agent({ how: null })), 'Claude Code 2.1.322 is ready.');
  assert.equal(s(CODEX_OUT), 'Codex is installed but not signed in.');
  assert.equal(s(CODEX_MISSING), 'Codex is not installed.');
  assert.equal(s(agent({ ready: false, signedIn: 'unknown', how: null })), 'Claude Code 2.1.322 is installed, but Workbench could not tell whether it is signed in.');
  assert.equal(s(agent({ ready: false, signedIn: 'yes' })), 'Claude Code 2.1.322 is installed, but it cannot start work yet.');
  assert.equal(s(agent({ sentence: 'Claude Code 2.1.322 is ready,\n signed in with an API key.' })), 'Claude Code 2.1.322 is ready, signed in with an API key.', 'Workbench’s own sentence comes first');
  for (const a of [agent(), CODEX_OUT, CODEX_MISSING]) assert.doesNotMatch(s(a), /Not connected/);
  assert.deepEqual(V.agentLight(V.agentsOf({ agents: [agent()] })[0]), { tone: 'ok', shape: 'ok', words: 'ready' });
  assert.equal(V.agentLight(V.agentsOf({ agents: [CODEX_OUT] })[0]).tone, 'need');
  assert.equal(V.agentLight(V.agentsOf({ agents: [CODEX_MISSING] })[0]).words, 'not installed');
});

test('an agent row draws exactly the actions Workbench lists, each bound to the agent and the facts it was drawn for', () => {
  const h = html(status({ agents: [agent(), CODEX_OUT, { ...CODEX_MISSING, id: 'gemini', name: 'Gemini CLI', actions: ['install', 'teleport', 'recheck'] }] }));
  const of = id => buttons(h).filter(b => b.cn === 'agent' && b.agent === id);
  assert.deepEqual(of('claude').map(b => b.label), ['Use an API key instead', 'Check again']);
  assert.deepEqual(of('codex').map(b => b.label), ['Sign in', 'Use an API key instead', 'Use for new work', 'Check again'], 'in the panel’s order');
  assert.deepEqual(of('gemini').map(b => b.label), ['Install', 'Check again'], 'an action it does not know is not drawn; the list is not two agents long');
  for (const b of of('codex')) {
    assert.equal(b.state, V.agentStamp(V.agentsOf({ agents: [CODEX_OUT] })[0]), 'the facts it was drawn for');
    assert.ok(b.key && b.action, 'a focus key and an action');
    assert.equal(b['key-id'], undefined);
  }
  assert.equal(of('codex').find(b => b.action === 'signin').pri, true, 'the way in is the first answer while it is not ready');
  assert.equal(of('claude').some(b => b.pri), false);
  assert.match(h, /Used for new work\./, 'a light marks the agent new work goes to');
  assert.match(h, /Found in the VS Code extension\./);
  // an agent whose id does not fit is never drawn
  assert.equal(V.agentsOf({ agents: [{ ...CODEX_OUT, id: 'co dex' }, { ...CODEX_OUT, id: 'x/../y' }] }).length, 0);
  // a request on its way: its button says so and waits
  const busy = buttons(html(status(), { busy: new Set(['agent:codex:signin']) })).find(b => b.action === 'signin');
  assert.equal(busy.disabled, true);
});

test('"Use an API key" opens a password field that says who pays; never a name, a value or the browser’s memory', () => {
  const h = html(status({ agents: [agent(), CODEX_OUT, { ...CODEX_OUT, id: 'goose', name: 'goose' }] }), { open: { keyFor: 'claude' } });
  assert.match(h, /Claude Code will use this key instead of your Claude subscription, and each request is billed to the key\./);
  assert.equal(V.agentKeyNote({ id: 'codex', name: 'Codex' }), 'Codex will use this key, and each request is billed to it.');
  assert.equal(V.agentKeyNote({ id: 'goose', name: 'goose' }), 'goose will use this key, and each request is billed to it.');
  const field = inputs(h).filter(i => /data-field="agent-key"/.test(i));
  assert.equal(field.length, 1);
  assert.match(field[0], /type="password"/);
  assert.match(field[0], /autocomplete="off"/);
  assert.doesNotMatch(field[0], /\bname=|\bvalue=/);
  assert.ok(buttons(h).some(b => b.cn === 'keysave' && b.agent === 'claude' && b.pri));
  assert.match(h, /data-enter="keysave"/, 'Enter in it saves');
  assert.equal(buttons(h).find(b => b.action === 'key' && b.agent === 'claude') && /aria-expanded="true"/.test(h), true);
});

test('where Terminal cannot open, the command to run is shown with Copy; the ways into Terminal say which they do', () => {
  const failed = { ...CODEX_OUT, actions: ['signin-terminal', 'signin', 'key', 'recheck'] };
  const h = html(status({ canOpenTerminal: false, agents: [agent(), failed, { ...CODEX_MISSING, id: 'gemini', name: 'Gemini CLI' }] }), { open: { cmd: { codex: 'codex login' } } });
  assert.match(h, /<code class="cn-cmd"[^>]*>codex login<\/code>/);
  assert.ok(buttons(h).some(b => b.cn === 'copy' && b.agent === 'codex'));
  const title = (src, agentId, action) => new RegExp(`data-agent="${agentId}" data-action="${action}"[^>]*title="([^"]*)"`).exec(src)?.[1];
  assert.equal(title(h, 'codex', 'signin-terminal'), 'Shows the command to run in a terminal.');
  assert.equal(title(h, 'gemini', 'install'), 'Shows the command to run in a terminal.');
  assert.equal(buttons(h).find(b => b.action === 'signin-terminal').label, 'Sign in in a terminal', 'no Terminal here: a terminal of the person’s own');
  const mac = html(status({ agents: [agent(), failed, { ...CODEX_MISSING, id: 'gemini', name: 'Gemini CLI' }] }));
  assert.equal(title(mac, 'codex', 'signin-terminal'), 'Opens Terminal, where it runs.');
  assert.equal(title(mac, 'gemini', 'install'), 'Opens Terminal, where it runs.');
  assert.equal(buttons(mac).find(b => b.action === 'signin-terminal').label, 'Sign in in Terminal');
  // Sign in itself opens the browser, wherever Workbench runs
  for (const src of [h, mac]) assert.equal(title(src, 'codex', 'signin'), 'Opens ChatGPT’s sign-in page in your browser.');
});

// ---------------------------------------------------------------- agents signing in in the browser (milestone 1.5)
const CLAUDE_OUT = agent({ signedIn: 'no', how: null, ready: false, isDefault: false, actions: ['signin', 'signin-console', 'key', 'recheck'] });
const row = (h, id) => { const at = h.indexOf(`data-k="agent:${id}"`); return h.slice(at, h.indexOf('data-k=', at + 10)); };

test('Claude Code signed out: Sign in (its browser), "Use your Anthropic Console account" and "Use an API key instead"', () => {
  const h = html(status({ agents: [CLAUDE_OUT, { ...CODEX_OUT, actions: ['signin', 'signin-console', 'key', 'recheck'] }], ready: false }));
  const of = id => buttons(h).filter(b => b.cn === 'agent' && b.agent === id);
  assert.deepEqual(of('claude').map(b => b.label), ['Sign in', 'Use your Anthropic Console account', 'Use an API key instead', 'Check again']);
  assert.deepEqual(of('claude').map(b => b.pri), [true, false, false, false], 'Sign in is the way in');
  assert.deepEqual(of('codex').map(b => b.label), ['Sign in', 'Use an API key instead', 'Check again'], 'the Anthropic Console account is Claude Code’s alone');
  assert.ok(of('claude').every(b => b.state === V.agentStamp(V.agentsOf({ agents: [CLAUDE_OUT] })[0])), 'each carries what it was drawn for');
  assert.match(row(h, 'claude'), /data-action="signin"[^>]*title="Opens Claude’s sign-in page in your browser\."/);
  assert.match(row(h, 'claude'), /data-action="signin-console"[^>]*title="Opens the Anthropic Console’s sign-in page in your browser\."/);
  assert.match(row(h, 'codex'), /data-action="signin"[^>]*title="Opens ChatGPT’s sign-in page in your browser\."/);
  assert.equal(V.actionTitle('signin', { id: 'goose', name: 'goose' }, true), 'Opens the sign-in page in your browser.');
  assert.doesNotMatch(h, /Opens Terminal/, 'nothing here opens Terminal');
  assert.equal(V.ACTION_LABEL.key, 'Use an API key instead');
});

test('a sign-in waiting in the browser: its words, the waiting light, Cancel, and no other way in until it ends', () => {
  const waiting = { ...CLAUDE_OUT, signingIn: { since: 1_800_000_000_000, browser: true, sentence: '' } };
  const s = status({ agents: [waiting, { ...CODEX_OUT, signingIn: { since: 1, browser: true, sentence: '' } }, { ...CODEX_OUT, id: 'goose', name: 'goose', signingIn: { since: 1 } }], ready: false });
  const h = html(s);
  assert.match(row(h, 'claude'), /<p class="cn-note cn-step">Finish signing in to Claude in your browser\.<\/p>/);
  assert.match(row(h, 'codex'), /Finish signing in to ChatGPT in your browser\./);
  assert.match(row(h, 'goose'), /Finish signing in to goose in your browser\./);
  const said = V.agentsOf(status({ agents: [{ ...waiting, signingIn: { since: 1, browser: true, sentence: 'Finish signing in to Claude in your browser.\n It opened.' } }] }))[0];
  assert.equal(V.agentWaitWords(said), 'Finish signing in to Claude in your browser. It opened.', 'Workbench’s own sentence first');
  const [a] = V.agentsOf(s);
  assert.deepEqual(V.agentLight(a), { tone: 'work', shape: 'wait', words: 'signing in' });
  assert.match(row(h, 'claude'), /aria-label="signing in"><svg class="g k-work"[^>]*><use href="#g-wait"\/>/);
  const of = buttons(row(h, 'claude'));
  assert.deepEqual(of.map(b => b.label), ['Cancel', 'Use an API key instead', 'Check again'], 'one sign-in at a time: no Sign in while one waits');
  const cancel = of[0];
  assert.deepEqual([cancel.cn, cancel.agent, cancel.state, cancel.pri], ['agent-cancel', 'claude', V.agentStamp(a), false]);
  assert.match(row(h, 'claude'), /aria-label="Cancel the sign-in to Claude Code"/);
  assert.notEqual(V.agentStamp(a), V.agentStamp({ ...a, signingIn: null }), 'a button drawn while it waited is stale once it ended');
  assert.equal((row(h, 'claude').match(/class="cn-line"/g) || []).length, 1, 'one sentence per agent: the page checks read it');
  assert.equal(V.signingInWaits(s), true);
  assert.equal(V.signingInWaits(status()), false);
  assert.equal(V.signingInWaits(null), false);
  // busy while its cancel is on its way
  assert.equal(buttons(row(html(s, { busy: new Set(['agent-cancel:claude']) }), 'claude'))[0].disabled, true);
});

test('a sign-in in the browser that did not finish: the panel says so and offers the sign-in in Terminal first', () => {
  const failed = { ...CLAUDE_OUT, actions: ['signin-terminal', 'signin', 'signin-console', 'key', 'recheck'] };
  const h = html(status({ agents: [failed, CODEX_MISSING], ready: false }));
  assert.match(row(h, 'claude'), /<p class="cn-note cn-step">The sign-in in the browser did not finish\. Sign in in Terminal instead\.<\/p>/);
  assert.equal(V.BROWSER_FAILED, 'The sign-in in the browser did not finish. Sign in in Terminal instead.');
  const of = buttons(row(h, 'claude'));
  assert.deepEqual(of.map(b => b.label), ['Sign in in Terminal', 'Sign in', 'Use your Anthropic Console account', 'Use an API key instead', 'Check again']);
  assert.deepEqual(of.map(b => b.pri), [true, false, false, false, false], 'the sign-in in Terminal is the way in now');
  assert.equal(V.agentFailed(V.agentsOf({ agents: [failed] })[0]), true);
  assert.equal(V.agentFailed(V.agentsOf({ agents: [{ ...failed, signingIn: { since: 1 } }] })[0]), false, 'a new sign-in waits: not failed');
  // where Workbench cannot open Terminal, a terminal of the person's own
  assert.match(html(status({ agents: [failed], canOpenTerminal: false })), /Sign in in a terminal instead\./);
  // Workbench's sentence that says it already is not said twice
  const told = html(status({ agents: [{ ...failed, sentence: `Claude Code is installed but not signed in. ${V.BROWSER_FAILED}` }] }));
  assert.equal(told.split('did not finish').length - 1, 1);
});

// ---------------------------------------------------------------- git and GitHub
test('git: the name and email git has, and Save; Merging needs these', () => {
  const h = html(status({ git: { name: 'Sam <Lee>', email: 'sam@example.com', sentence: '' } }));
  assert.match(h, /Git knows you as Sam &lt;Lee&gt;, sam@example\.com\. Merging needs these\./);
  assert.match(h, /data-field="git-name"[^>]*value="Sam &lt;Lee&gt;"/);
  assert.ok(buttons(h).some(b => b.cn === 'git' && b.label === 'Save'));
  assert.match(html(status({ git: { name: null, email: null } })), /Git does not know your name and email yet\. Merging needs these\./);
  assert.deepEqual(V.gitRequest(' Sam Lee ', 'sam@example.com'), { name: 'Sam Lee', email: 'sam@example.com' });
  assert.match(V.gitRequest('', 'a@b.c').error, /Fill in your name/);
  assert.match(V.gitRequest('Sam', 'not an address').error, /does not look right/);
});

test('GitHub, not connected: Sign in to GitHub first; "Use a token instead" shows milestone 1’s token form, as it was', () => {
  const folded = html(status());
  assert.match(folded, /<h4 class="cn-h4">GitHub<\/h4><p class="cn-line">Not signed in to GitHub\.<\/p>/, 'no sentence from Workbench: the panel’s own');
  assert.match(html(status({ github: { connected: false, login: null, agentsUseIt: false, sentence: 'Not connected.' } })), /<p class="cn-line">Not connected\.<\/p>/, 'Workbench’s own sentence first');
  const signIn = buttons(folded).find(b => b.cn === 'gh-signin');
  assert.deepEqual([signIn.label, signIn.pri, signIn.state], ['Sign in to GitHub', true, 'off'], 'the main button, carrying what it was drawn for');
  assert.equal(inputs(folded).some(i => /data-field="gh-(token|agents)"/.test(i)), false, 'the token form is folded away');
  const toggle = buttons(folded).find(b => b.cn === 'gh-token-toggle');
  assert.equal(toggle.label, 'Use a token instead');
  assert.match(folded, /data-cn="gh-token-toggle"[^>]*aria-expanded="false"/);
  assert.equal(buttons(folded).filter(b => b.pri).filter(b => /^gh-/.test(b.cn)).length, 1, 'one main button for GitHub');
  const h = html(status(), { open: { ghToken: true } });
  assert.match(h, /data-cn="gh-token-toggle"[^>]*aria-expanded="true"/);
  const parts = V.panelParts(status(), { presets: PRESETS, open: { ghToken: true } }).map(p => p.k);
  assert.ok(parts.indexOf('gh-token') === parts.indexOf('gh-off') + 1, 'the form is a part of its own, under GitHub’s: a sign-in’s progress never redraws a token being typed');
  assert.ok(buttons(h).some(b => b.cn === 'gh-signin'), 'Sign in to GitHub stays');
  const token = inputs(h).find(i => /data-field="gh-token"/.test(i));
  assert.match(token, /type="password"/);
  assert.match(token, /autocomplete="off"/);
  assert.doesNotMatch(token, /\bname=|\bvalue=/);
  const box = inputs(h).find(i => /data-field="gh-agents"/.test(i));
  assert.match(box, /type="checkbox"/);
  assert.doesNotMatch(box, /checked/, 'off by default');
  assert.match(h, /Let agents use this token \(as GH_TOKEN\)/);
  assert.match(h, /Copilot may sign in with it\./);
  assert.match(h, /<a class="cn-link" href="https:\/\/github\.com\/settings\/tokens\/new\?description=Workbench&amp;scopes=repo" target="_blank" rel="noopener noreferrer">Create a token<\/a>/);
  assert.ok(buttons(h).some(b => b.cn === 'gh-connect' && b.pri));
  assert.match(V.githubRequest('  ').error, /Fill in the token/);
  assert.deepEqual(V.githubRequest(' abc '), { token: 'abc' });
});

// GitHub, connected: "Let agents use this token (as GH_TOKEN)" acts at once, through POST /api/connect/github/agents
const gh = (o = {}) => ({ connected: true, login: 'octocat', agentsUseIt: false, sentence: '', ...o });
const shareBox = h => inputs(h).find(i => /data-field="gh-share"/.test(i));
const stateOf = i => /data-state="([^"]*)"/.exec(i)?.[1];

test('GitHub, connected: as whom, the box for agents ticked as Workbench says, Copilot under it, and Disconnect', () => {
  const on = html(status({ github: gh({ login: 'octo<cat>', agentsUseIt: true }) }));
  assert.match(on, /Connected to GitHub as octo&lt;cat&gt;\./);
  assert.match(on, /<label class="cn-check"><input [^>]*data-field="gh-share"[^>]*><span>Let agents use this token \(as GH_TOKEN\)<\/span><\/label><p class="cn-sub cn-under">Copilot may sign in with it\.<\/p>/,
    'the box, and under it what Copilot may do with the token');
  const box = shareBox(on);
  assert.match(box, /type="checkbox"/);
  assert.match(box, /\bchecked\b/, 'agents get the token: ticked');
  assert.doesNotMatch(box, /aria-disabled|\bname=|\bvalue=/);
  assert.match(box, /data-key="gh-share"/, 'the keyboard stays on it when it is drawn again');
  assert.equal(stateOf(box), esc(V.githubStamp(gh({ login: 'octo<cat>', agentsUseIt: true }))), 'it carries what it was drawn for');
  assert.ok(buttons(on).some(b => b.cn === 'gh-disconnect'));
  assert.doesNotMatch(on, /data-field="gh-token"|data-field="gh-agents"/, 'no token is asked for again');
  assert.doesNotMatch(on, /connect again|Only git uses/, 'the box works: nothing says to disconnect and connect again');
  const gitOnly = html(status({ github: gh() }));
  assert.doesNotMatch(shareBox(gitOnly), /\bchecked\b/, 'git alone uses it: not ticked');
  assert.match(gitOnly, /Let agents use this token \(as GH_TOKEN\)/);
  assert.match(gitOnly, /Copilot may sign in with it\./);
  // the box's stamp: whether agents get the token, and whose it is
  assert.equal(V.githubStamp(gh()), 'git-only:octocat');
  assert.equal(V.githubStamp(gh({ agentsUseIt: true })), 'agents:octocat');
  for (const off of [null, {}, { connected: false, login: 'octocat', agentsUseIt: true }]) assert.equal(V.githubStamp(off), 'off');
});

test('GitHub’s box while its change is on its way shows what was asked and waits; refused or failed, it is back as it was', () => {
  // ticked, on its way: ticked, and it waits (a click on it is undone)
  const asked = html(status({ github: gh() }), { open: { ghShare: true }, busy: new Set(['gh-share']) });
  assert.match(shareBox(asked), /\bchecked\b/);
  assert.match(shareBox(asked), /aria-disabled="true"/);
  // untick, on its way
  const untick = html(status({ github: gh({ agentsUseIt: true }) }), { open: { ghShare: false }, busy: new Set(['gh-share']) });
  assert.doesNotMatch(shareBox(untick), /\bchecked\b/);
  assert.match(shareBox(untick), /aria-disabled="true"/);
  // refused ({ ok: false, why: 'token', sentence } changes nothing) or failed: drawn from what Workbench says, as it was
  for (const left of [null, true]) {
    const back = html(status({ github: gh() }), { open: { ghShare: left } });
    assert.doesNotMatch(shareBox(back), /\bchecked\b|aria-disabled/, `asked ${left}: back as it was`);
  }
  // taken: the fresh status says agents get it
  assert.match(shareBox(html(status({ github: gh({ agentsUseIt: true }) }))), /\bchecked\b/);
  assert.equal(V.githubBoxOn(gh({ agentsUseIt: true })), true);
  assert.equal(V.githubBoxOn(gh(), true, true), true, 'what was asked, while it is on its way');
  assert.equal(V.githubBoxOn(gh(), true, false), false, 'otherwise what Workbench says');
  assert.equal(V.githubBoxOn(gh({ agentsUseIt: true }), null, true), true, 'nothing asked: what Workbench says');
  assert.equal(V.githubBoxOn(null), false);
  // the not-connected form keeps its own box (sent with Connect), off by default, and no box of this kind
  const notYet = html(status(), { open: { ghToken: true } });
  assert.equal(shareBox(notYet), undefined);
  assert.doesNotMatch(inputs(notYet).find(i => /data-field="gh-agents"/.test(i)), /checked/);
});

test('what GitHub’s box sends: { agentsUseIt } when it was drawn for what is so; nothing when that changed', () => {
  const s = status({ github: gh() });
  const drawn = V.githubStamp(s.github);
  assert.deepEqual(V.githubShareRequest(s, drawn, true), { agentsUseIt: true });
  assert.deepEqual(V.githubShareRequest(status({ github: gh({ agentsUseIt: true }) }), 'agents:octocat', false), { agentsUseIt: false });
  // drawn before a change: agents given the token since, another account, GitHub disconnected, or no status at all
  assert.equal(V.githubShareRequest(status({ github: gh({ agentsUseIt: true }) }), drawn, true), null);
  assert.equal(V.githubShareRequest(status({ github: gh({ login: 'someone-else' }) }), drawn, true), null);
  assert.equal(V.githubShareRequest(status(), drawn, true), null);
  assert.equal(V.githubShareRequest(null, drawn, true), null);
  assert.equal(V.githubShareRequest(s, undefined, true), null);
});

test('GitHub’s box is wired: a change is sent at once and checked first, a waiting box ignores clicks, and it goes back', () => {
  const conn = read('../ui/connect.js');
  assert.match(conn, /el\.dialog\.addEventListener\('change', onChange\)/);
  const at = conn.indexOf('async function shareGithub(');
  const fn = conn.slice(at, conn.indexOf('\n}\n', at));
  assert.ok(at > 0, 'shareGithub');
  const order = ['githubShareRequest(st.status, box.dataset.state, box.checked)', 'changed()', 'st.open.ghShare = q.agentsUseIt', 'connectApi.githubAgents(q.agentsUseIt)',
    "busyKey: 'gh-share'", 'st.open.ghShare = null', 'githubBoxOn(st.status && st.status.github)', 'recheck()', 'connectApi.status()'];
  let last = -1;
  for (const s of order) { const i = fn.indexOf(s); assert.ok(i > last, `shareGithub: ${s}`); last = i; }
  const click = conn.slice(conn.indexOf('function onClick('), conn.indexOf('\n}\n', conn.indexOf('function onClick(')));
  assert.match(click, /t\.type === 'checkbox' && t\.getAttribute\('aria-disabled'\) === 'true'\) \{ e\.preventDefault\(\); return; \}/);
});

// ---------------------------------------------------------------- git missing, and GitHub through its own tool (milestone 1.5)
/** One part of the panel's markup, by its key ('' when it is not drawn). */
const part = (h, k) => {
  const at = h.indexOf(`data-k="${k}"`);
  if (at < 0) return '';
  const end = h.indexOf('data-k=', at + 10);
  return h.slice(at, end < 0 ? undefined : end);
};
const ghOff = (o = {}) => ({ connected: false, via: null, login: null, ghInstalled: false, ghVersion: null, ghPath: null, agentsUseIt: false, sentence: '', signingIn: null, ...o });
const signing = (o = {}) => ghOff({ signingIn: { phase: 'installing', code: null, url: null, since: 1_800_000_000_000, sentence: '', ...o } });

test('git missing: what to do, and Install where Workbench can start Apple’s installer; no name and email to give', () => {
  const mac = html(status({ git: { name: '', email: '', installed: false, canInstall: true, sentence: 'Workbench could not read git’s settings.' } }));
  const git = part(mac, 'git');
  assert.match(git, /<p class="cn-line">Git is not installed yet\. Apple’s developer tools include it\.<\/p>/, 'the panel’s own words, whatever else the status says');
  assert.match(git, /aria-label="needs you"/);
  const install = buttons(git);
  assert.deepEqual(install.map(b => [b.cn, b.label, b.pri, b.state]), [['git-install', 'Install', true, 'missing']]);
  assert.match(git, /aria-label="Install git"/, 'its name says what it installs, and starts with its label');
  assert.match(git, /title="Opens Apple’s installer for its developer tools, which include git\."/);
  assert.doesNotMatch(mac, /data-field="git-(name|email)"|Merging needs these/, 'git cannot keep a name and email until it runs');
  // elsewhere: a package manager, and no button
  const linux = html(status({ platform: 'linux', canOpenTerminal: false, git: { name: '', email: '', installed: false, canInstall: false, sentence: '' } }));
  assert.match(part(linux, 'git'), /Git is not installed yet\. Install git with your package manager\./);
  assert.equal(buttons(part(linux, 'git')).length, 0);
  // a Mac where Workbench cannot start the installer: Apple's words, no button
  const noButton = html(status({ git: { installed: false, canInstall: false } }));
  assert.match(part(noButton, 'git'), /Apple’s developer tools include it\./);
  assert.equal(buttons(part(noButton, 'git')).length, 0);
  // git here, or a status that does not say: the name and email, as before
  for (const g of [{ name: 'Sam Lee', email: 'sam@example.com', installed: true, canInstall: true, sentence: '' }, { name: 'Sam Lee', email: 'sam@example.com', sentence: '' }]) {
    const h = html(status({ git: g }));
    assert.match(h, /Git knows you as Sam Lee, sam@example\.com\. Merging needs these\./);
    assert.ok(!buttons(h).some(b => b.cn === 'git-install'));
  }
  assert.deepEqual(V.gitOf({ git: { installed: false } }), { name: '', email: '', sentence: '', installed: false, canInstall: false });
  assert.equal(V.gitOf({}).installed, true, 'missing only when Workbench says so');
});

test('Sign in to GitHub says what happens: Workbench gets GitHub’s command-line tool first when it is not here', () => {
  const missing = part(html(status({ github: ghOff() })), 'gh-off');
  assert.match(missing, /Workbench first gets GitHub’s command-line tool from GitHub\. Then you approve the sign-in on GitHub’s website: there is no token to copy\./);
  for (const ghInstalled of [true, null, undefined]) {
    const here = part(html(status({ github: ghOff({ ghInstalled }) })), 'gh-off');
    assert.match(here, /<p class="cn-sub">You approve the sign-in on GitHub’s website: there is no token to copy\.<\/p>/, String(ghInstalled));
  }
});

test('a sign-in to GitHub under way, by its phase: getting the tool, the code with Open GitHub, or Terminal; Cancel in each', () => {
  // getting the tool
  const installing = part(html(status({ github: signing() })), 'gh-off');
  assert.match(installing, /<p class="cn-line cn-wait"><svg class="g k-work"[^>]*><use href="#g-wait"\/><\/svg><span>Getting GitHub’s command-line tool…<\/span><\/p>/);
  assert.deepEqual(buttons(installing).map(b => [b.cn, b.label]), [['gh-cancel', 'Cancel'], ['gh-token-toggle', 'Use a token instead']], 'no second sign-in while one is under way');
  assert.equal(buttons(installing)[0].state, 'signing');
  assert.match(installing, /aria-label="Cancel the sign-in to GitHub"/);
  assert.match(part(html(status({ github: signing({ sentence: 'Getting GitHub’s command-line tool… 40%' }) })), 'gh-off'), /Getting GitHub’s command-line tool… 40%/, 'Workbench’s own words first');
  // Terminal, when no code came
  const terminal = part(html(status({ github: signing({ phase: 'terminal' }) })), 'gh-off');
  assert.match(terminal, /<span>Terminal is open: follow the steps there, then come back\.<\/span>/);
  assert.deepEqual(buttons(terminal).map(b => b.cn), ['gh-cancel', 'gh-token-toggle']);
  // the code: GitHub's own (it shows it too), with Open GitHub on github.com, Copy the code and Cancel
  const code = part(html(status({ github: signing({ phase: 'code', code: 'WDJB-MJHT', url: 'https://github.com/login/device' }) })), 'gh-off');
  assert.match(code, /<p class="cn-line cn-codeline">Your code: <span class="cn-code">WDJB-MJHT<\/span><\/p>/);
  assert.match(code, /<p class="cn-sub">Open GitHub, type the code there and approve the sign-in\. The code works for 15 minutes\.<\/p>/);
  assert.match(code, /<a class="cn-btn pri" href="https:\/\/github\.com\/login\/device" target="_blank" rel="noopener noreferrer" data-key="gh-open" title="Opens github\.com\/login\/device in your browser\.">Open GitHub<\/a>/);
  assert.deepEqual(buttons(code).map(b => [b.cn, b.label]), [['gh-copy', 'Copy the code'], ['gh-cancel', 'Cancel'], ['gh-token-toggle', 'Use a token instead']]);
  // Workbench's sentence goes under the code, unless it only says the code again
  assert.match(part(html(status({ github: signing({ phase: 'code', code: 'WDJB-MJHT', sentence: 'Type it on GitHub.' }) })), 'gh-off'), /<p class="cn-sub">Type it on GitHub\.<\/p>/);
  assert.match(part(html(status({ github: signing({ phase: 'code', code: 'WDJB-MJHT', sentence: 'Your code: WDJB-MJHT.' }) })), 'gh-off'), /The code works for 15 minutes\./);
  // Open GitHub goes to github.com only; a code that is not a code's shape is not shown
  for (const url of ['https://evil.example/login/device', 'http://github.com/login/device', 'javascript:alert(1)', 'https://github.com.evil.example/x', null, 'https://github.com/x" onclick="y']) {
    const h = part(html(status({ github: signing({ phase: 'code', code: 'WDJB-MJHT', url }) })), 'gh-off');
    assert.match(h, /href="https:\/\/github\.com\/login\/device"/, String(url));
  }
  assert.equal(V.githubUrl('https://github.com/login/device?user_code=WDJB-MJHT'), 'https://github.com/login/device?user_code=WDJB-MJHT');
  for (const bad of ['<b>x</b>', 'WDJB MJHT', '', 'a'.repeat(40), `WDJB${U(0x202e)}MJHT`]) {
    const h = part(html(status({ github: signing({ phase: 'code', code: bad }) })), 'gh-off');
    assert.doesNotMatch(h, /cn-code|gh-open|<b>/, JSON.stringify(bad));
    assert.match(h, /Waiting for a code from GitHub…/);
  }
  // another phase Workbench may add: its sentence, else plain words
  assert.match(part(html(status({ github: signing({ phase: 'later' }) })), 'gh-off'), /Signing in to GitHub…/);
  // the panel reads the status again while any of these is under way, until Workbench says it ended: also once gh has
  // the sign-in, since its last step (making git use it) may still be running
  assert.equal(V.signingInWaits(status({ github: signing() })), true);
  assert.equal(V.signingInWaits(status({ github: { ...signing(), connected: true, via: 'gh', login: 'octocat' } })), true);
  assert.equal(V.signingInWaits(status({ github: { ...signing(), signingIn: null, connected: true, via: 'gh', login: 'octocat' } })), false);
});

test('signed in through GitHub’s command-line tool: who uses the sign-in, and Sign out; no token, no box', () => {
  // git uses the sign-in (Connect says so with agentsUseIt: true)
  const gh = { connected: true, via: 'gh', login: 'octocat', ghInstalled: true, ghVersion: '2.104.0', ghPath: '/Users/sam/.local/bin/gh', agentsUseIt: true, sentence: '', signingIn: null };
  const h = html(status({ github: gh }));
  const signed = part(h, 'gh-signed');
  assert.match(signed, /<p class="cn-line">Signed in to GitHub as octocat\. Git in Terminal, Workbench and your agents use this sign-in\.<\/p>/);
  assert.deepEqual(buttons(signed).map(b => [b.cn, b.label, b.state]), [['gh-signout', 'Sign out', 'gh:octocat']]);
  assert.doesNotMatch(h, /data-field="gh-(share|token|agents)"|gh-token-toggle|gh-disconnect|Sign in to GitHub/);
  assert.match(html(status({ github: { ...gh, sentence: 'Signed in to GitHub as octocat.\nWorkbench uses its own copy of the tool.' } })), /Signed in to GitHub as octocat\. Workbench uses its own copy of the tool\./, 'Workbench’s own sentence first');
  assert.match(html(status({ github: { ...gh, login: null } })), /Signed in to GitHub\. Git in Terminal, Workbench and your agents use this sign-in\./);
  assert.equal(V.githubShareRequest(status({ github: gh }), V.githubStamp(gh), true), null, 'no token to give agents here');
  assert.equal(V.githubState(V.githubOf(status({ github: gh }))), 'gh:octocat');
});

test('a refused install says why, in Workbench’s words, and Sign in to GitHub and the token are offered again', () => {
  const refused = 'Workbench did not install GitHub’s command-line tool, because the download did not match the checksum GitHub publishes for it.';
  const h = part(html(status({ github: ghOff({ sentence: refused }) })), 'gh-off');
  assert.ok(h.includes(`<p class="cn-line">${esc(refused)}</p>`));
  assert.deepEqual(buttons(h).map(b => b.cn), ['gh-signin', 'gh-token-toggle']);
});

test('GitHub’s part of a status is read field by field: a token connection without `via`, nothing guessed', () => {
  assert.deepEqual(V.githubOf({}), { connected: false, via: null, login: '', agentsUseIt: false, sentence: '', ghInstalled: null, signingIn: null });
  assert.equal(V.githubOf({ github: { connected: true, login: 'octocat' } }).via, 'token', 'milestone 1’s connection');
  assert.equal(V.githubOf({ github: { connected: true, via: 'gh' } }).via, 'gh');
  assert.equal(V.githubOf({ github: { connected: false, via: 'gh' } }).via, null);
  assert.equal(V.githubOf({ github: { connected: true, via: 'gh', signingIn: { phase: 'code' } } }).signingIn.phase, 'code', 'connected, and still signing in: as Workbench says');
  assert.equal(V.githubOf({ github: { signingIn: { phase: 'code', code: ' WDJB-MJHT ' } } }).signingIn.code, 'WDJB-MJHT');
  assert.equal(V.githubState(V.githubOf({ github: { connected: true, login: `oct${U(0x202e)}o` } })), 'token:oct⟦U+202E⟧o');
  assert.equal(V.githubState(V.githubOf({})), 'off');
  assert.equal(V.githubState(V.githubOf({ github: signing() })), 'signing');
  // milestone 1's token view is as it was, whatever the tool's facts
  const token = html(status({ github: { connected: true, via: 'token', login: 'octocat', ghInstalled: true, agentsUseIt: true, sentence: '' } }));
  assert.match(token, /Connected to GitHub as octocat\./);
  assert.ok(buttons(token).some(b => b.cn === 'gh-disconnect'));
  assert.match(shareBox(token), /\bchecked\b/);
});

test('where Workbench gave a command for GitHub instead of opening Terminal, the panel shows it with Copy', () => {
  const h = html(status(), { open: { ghCmd: `gh auth login --hostname github.com${U(0x200b)}` } });
  const cmd = part(h, 'gh-cmd');
  assert.match(cmd, /Run this in a terminal, then come back here\./);
  assert.match(cmd, /<code class="cn-cmd" tabindex="0" data-scroll="1">gh auth login --hostname github\.com⟦U\+200B⟧<\/code>/);
  assert.ok(buttons(cmd).some(b => b.cn === 'gh-cmd-copy'));
  assert.equal(part(html(status()), 'gh-cmd'), '');
});

// Where Terminal cannot open (Linux, or a Mac where it did not open), Connect gives gh's command: the sign-in's in its
// status (github.signingIn: phase 'terminal', opened: false, command), Sign out's in its answer. These are Connect's own
// commands (ghSignInCommand and ghSignOutCommand in src/core/github.mjs) for gh at /home/sam/.local/bin/gh.
const GH_LINUX = '/home/sam/.local/bin/gh';
const GH_SIGN_IN_CMD = `${GH_LINUX} auth login --hostname github.com --git-protocol https --web --scopes workflow && ${GH_LINUX} auth setup-git --hostname github.com`;
const GH_SIGN_OUT_CMD = `${GH_LINUX} auth logout --hostname github.com`;
const NO_TERMINAL = 'Run this command in a terminal, then come back here.';
/** github.signingIn as Connect gives it once gh's sign-in without a terminal failed and Terminal could not open. */
const inATerminal = (o = {}) => ({ phase: 'terminal', code: null, url: null, since: 1_800_000_000_000, sentence: NO_TERMINAL, opened: false, command: GH_SIGN_IN_CMD, ...o });
const SIGNED_GH = 'Signed in to GitHub as octocat. Git in Terminal, Workbench and your agents use this sign-in.';
const NOT_GIT = 'Signed in to GitHub as octocat, but git does not use this sign-in yet. Sign in to GitHub again to set that up.';
/** status.github as Connect gives it while gh is signed in; git uses the sign-in when agentsUseIt is true. */
const viaGh = (o = {}) => ({ connected: true, via: 'gh', login: 'octocat', ghInstalled: true, ghVersion: '2.104.0', ghPath: '/Users/sam/.local/bin/gh', agentsUseIt: true,
  sentence: SIGNED_GH, signingIn: null, ...o });
/** connect.js: one case of the buttons' switch, up to the next one. */
const caseOf = (src, cn) => { const at = src.indexOf(`case '${cn}':`); return at < 0 ? '' : src.slice(at, src.indexOf('\n    case ', at + 1)); };

test('where Terminal cannot open, GitHub’s sign-in shows the command in its status, with Copy, while Workbench waits for it', () => {
  const s = status({ platform: 'linux', canOpenTerminal: false, github: ghOff({ ghInstalled: true, signingIn: inATerminal() }) });
  const h = html(s);
  const cmd = part(h, 'gh-cmd');
  assert.ok(cmd.includes(`<code class="cn-cmd" tabindex="0" data-scroll="1">${esc(GH_SIGN_IN_CMD)}</code>`), 'the command, escaped');
  assert.match(cmd, /Run this in a terminal, then come back here\./);
  assert.deepEqual(buttons(cmd).map(b => [b.cn, b.label]), [['gh-cmd-copy', 'Copy']]);
  const off = part(h, 'gh-off');
  assert.match(off, /<span>Run this command in a terminal, then come back here\.<\/span>/, 'Workbench’s words');
  assert.deepEqual(buttons(off).map(b => b.cn), ['gh-cancel', 'gh-token-toggle'], 'Workbench still waits for it: Cancel');
  const g = V.githubOf(s);
  assert.deepEqual([g.signingIn.opened, g.signingIn.command], [false, GH_SIGN_IN_CMD]);
  assert.equal(V.githubCommand(g, {}), GH_SIGN_IN_CMD, 'what Copy copies');
  assert.equal(V.githubCommand(g, { ghCmd: 'something else' }), GH_SIGN_IN_CMD, 'the sign-in’s own command first');
  // a Mac where Terminal did not open: the same, in Workbench's words for it
  const mac = html(status({ github: ghOff({ ghInstalled: true, signingIn: inATerminal({ sentence: `Workbench could not open Terminal. ${NO_TERMINAL}` }) }) }));
  assert.ok(part(mac, 'gh-cmd').includes(esc(GH_SIGN_IN_CMD)));
  assert.match(part(mac, 'gh-off'), /<span>Workbench could not open Terminal\. Run this command in a terminal, then come back here\.<\/span>/);
  // with no words from Workbench, the panel never says Terminal is open when it is not
  assert.match(part(html(status({ github: ghOff({ signingIn: inATerminal({ sentence: '' }) }) })), 'gh-off'), /<span>Run this command in a terminal, then come back here\.<\/span>/);
  // Terminal open on it: no command; nor in any other phase, or with no sign-in under way
  const opened = html(status({ github: signing({ phase: 'terminal', opened: true }) }));
  assert.equal(part(opened, 'gh-cmd'), '');
  assert.match(part(opened, 'gh-off'), /<span>Terminal is open: follow the steps there, then come back\.<\/span>/);
  for (const github of [signing(), signing({ phase: 'code', code: 'WDJB-MJHT', opened: false, command: GH_SIGN_IN_CMD }), ghOff()]) {
    assert.equal(part(html(status({ github })), 'gh-cmd'), '', JSON.stringify(github.signingIn));
  }
  // hidden characters in it are shown, and nothing in it becomes markup
  const odd = part(html(status({ github: ghOff({ signingIn: inATerminal({ command: `gh auth login <b>x</b>${U(0x202e)}` }) }) })), 'gh-cmd');
  assert.match(odd, />gh auth login &lt;b&gt;x&lt;\/b&gt;⟦U\+202E⟧<\/code>/);
  // connect.js copies the command the panel shows
  assert.match(caseOf(read('../ui/connect.js'), 'gh-cmd-copy'), /githubCommand\(githubOf\(s\), st\.open\)/);
});

test('where gh cannot sign out by itself and Terminal cannot open, Sign out’s command shows with Copy while gh is still signed in, until GitHub changes', () => {
  const s = status({ platform: 'linux', canOpenTerminal: false, github: viaGh({ sentence: '' }) });
  const ps = V.panelParts(s, { presets: PRESETS, open: { ghCmd: GH_SIGN_OUT_CMD } });
  const keys = ps.map(p => p.k);
  assert.equal(keys.indexOf('gh-cmd'), keys.indexOf('gh-signed') + 1, 'under GitHub’s part, as the sign-in’s is');
  const h = ps.map(p => p.html).join('');
  assert.deepEqual(buttons(part(h, 'gh-signed')).map(b => b.cn), ['gh-signout'], 'gh is still signed in: Sign out stays');
  const cmd = part(h, 'gh-cmd');
  assert.ok(cmd.includes(`<code class="cn-cmd" tabindex="0" data-scroll="1">${esc(GH_SIGN_OUT_CMD)}</code>`));
  assert.match(cmd, /Run this in a terminal, then come back here\./);
  assert.deepEqual(buttons(cmd).map(b => [b.cn, b.label]), [['gh-cmd-copy', 'Copy']]);
  assert.equal(V.githubCommand(V.githubOf(s), { ghCmd: ` ${GH_SIGN_OUT_CMD} ` }), GH_SIGN_OUT_CMD);
  // connect.js keeps the command Sign out's answer carries, as an agent's way in does ...
  const conn = read('../ui/connect.js');
  const out = caseOf(conn, 'gh-signout');
  const keep = "if (r && typeof r.command === 'string' && r.command.trim()) { st.open.ghCmd = r.command.trim(); paint(); }";
  assert.ok(out.indexOf('connectApi.githubSignOut()') > 0 && out.indexOf(keep) > out.indexOf('connectApi.githubSignOut()'), 'Sign out keeps its answer’s command');
  // the keyboard goes to Sign in to GitHub only once gh is signed out: while Terminal still signs it out (git no longer
  // using it), that button would make git use gh again
  assert.match(out, /if \(okAnswer\(r\) && !githubOf\(st\.status\)\.connected\) focusKey\('gh-signin'\);/);
  // ... and lets it go once GitHub signs in or out (it was for the state it was given in), before anything is drawn
  const req = conn.slice(conn.indexOf('async function request('), conn.indexOf('\n}\n', conn.indexOf('async function request(')));
  const drop = "if (githubState(githubOf(before)) !== githubState(githubOf(s))) st.open.ghCmd = '';";
  assert.ok(req.indexOf(drop) > req.indexOf('st.status = s;') && req.indexOf(drop) < req.indexOf('signInEnded(before, s)'), 'a new status that changed GitHub drops it');
});

test('signed in through GitHub’s command-line tool, but git does not use it: Sign in to GitHub (which only sets git up) beside Sign out, and the panel sends it', () => {
  const s = status({ github: viaGh({ agentsUseIt: false, sentence: NOT_GIT }) });
  const signed = part(html(s), 'gh-signed');
  assert.ok(signed.includes(`<p class="cn-line">${esc(NOT_GIT)}</p>`));
  assert.deepEqual(buttons(signed).map(b => [b.cn, b.label, b.state, b.pri]), [['gh-signin', 'Sign in to GitHub', 'gh:octocat', true], ['gh-signout', 'Sign out', 'gh:octocat', false]]);
  assert.equal(V.githubCanSignIn(V.githubOf(s)), true);
  assert.equal(buttons(part(html(s, { busy: new Set(['gh-signin']) }), 'gh-signed'))[0].disabled, true, 'it waits while its request is on its way');
  // with no sentence from Workbench, the panel's own words say the same
  assert.ok(part(html(status({ github: viaGh({ agentsUseIt: false, sentence: '' }) })), 'gh-signed').includes(`<p class="cn-line">${esc(NOT_GIT)}</p>`));
  // git uses it: Sign out alone. Sign in to GitHub is offered (and sent) only where it does something, one at a time.
  assert.deepEqual(buttons(part(html(status({ github: viaGh() })), 'gh-signed')).map(b => b.cn), ['gh-signout']);
  const can = github => V.githubCanSignIn(V.githubOf(status({ github })));
  assert.deepEqual([can(ghOff()), can(viaGh({ agentsUseIt: false })), can(viaGh()), can(gh()), can(gh({ agentsUseIt: true })), can(signing()),
    can(viaGh({ agentsUseIt: false, signingIn: signing().signingIn }))], [true, true, false, false, false, false, false]);
  // connect.js sends it in that state: its check is the drawing's
  const signin = caseOf(read('../ui/connect.js'), 'gh-signin');
  assert.match(signin, /if \(!s \|\| githubState\(g\) !== b\.dataset\.state \|\| !githubCanSignIn\(g\)\) \{ changed\(\); return; \}/);
  assert.ok(signin.indexOf('connectApi.githubSignIn()') > signin.indexOf('!githubCanSignIn(g)'));
});

test('a sign-in to GitHub whose last step (making git use it) still runs once gh has it: the panel keeps reading, and shows the sign-in until it ends', () => {
  // Connect's status then: gh signed in, git not using it yet, and the sign-in still under way (its code still shown)
  const code = { phase: 'code', code: 'WDJB-MJHT', url: 'https://github.com/login/device', since: 1_800_000_000_000, sentence: 'Your code: WDJB-MJHT. Open GitHub, enter the code there, and approve the sign-in.' };
  const finishing = status({ github: viaGh({ agentsUseIt: false, sentence: NOT_GIT, signingIn: code }) });
  assert.equal(V.signingInWaits(finishing), true, 'it reads the status again in 2 seconds');
  assert.equal(V.githubState(V.githubOf(finishing)), 'signing');
  const h = html(finishing);
  assert.equal(part(h, 'gh-signed'), '', 'not “Sign in to GitHub again”: Workbench is doing that now');
  assert.doesNotMatch(h, /does not use this sign-in yet/);
  assert.deepEqual(buttons(part(h, 'gh-off')).map(b => b.cn), ['gh-copy', 'gh-cancel', 'gh-token-toggle'], 'the sign-in under way, with Cancel');
  // nothing is said until it ends, then GitHub's sentence, git using the sign-in; and the reading stops
  const before = status({ github: signing({ phase: 'code', code: 'WDJB-MJHT' }) });
  assert.deepEqual(V.signInEnded(before, finishing), []);
  const done = status({ github: viaGh() });
  assert.deepEqual(V.signInEnded(finishing, done), [{ who: 'github', ok: true, sentence: SIGNED_GH }]);
  assert.equal(V.signingInWaits(done), false);
  // beside a token connection, a sign-in under way keeps the panel reading too, and the token's part is drawn as it was
  const token = status({ github: { ...gh(), signingIn: code } });
  assert.equal(V.signingInWaits(token), true);
  assert.notEqual(part(html(token), 'gh-on'), '');
  assert.equal(part(html(token), 'gh-off'), '');
});

test('what is said when a sign-in ends: signed in, not finished (then Terminal), or GitHub’s own words; a cancel says nothing here', () => {
  const waitingClaude = { ...CLAUDE_OUT, signingIn: { since: 1, browser: true, sentence: '' } };
  const before = status({ agents: [waitingClaude, { ...CODEX_OUT, signingIn: { since: 1 } }], github: signing({ phase: 'code', code: 'WDJB-MJHT' }) });
  // Claude Code signed in, Codex's did not finish, GitHub signed in through the tool
  const after = status({ agents: [{ ...CLAUDE_OUT, signedIn: 'yes', how: 'your Claude subscription', ready: true }, { ...CODEX_OUT, actions: ['signin-terminal', 'signin', 'key', 'recheck'] }],
    github: { connected: true, via: 'gh', login: 'octocat', agentsUseIt: true, sentence: '' } });
  assert.deepEqual(V.signInEnded(before, after), [
    { who: 'claude', ok: true, sentence: 'Claude Code is signed in.' },
    { who: 'codex', ok: false, sentence: V.BROWSER_FAILED },
    { who: 'github', ok: true, sentence: 'Signed in to GitHub as octocat. Git in Terminal, Workbench and your agents use this sign-in.' },
  ]);
  // cancelled: nothing (the cancel's own answer says so); still waiting: nothing
  assert.deepEqual(V.signInEnded(before, status({ agents: [CLAUDE_OUT, CODEX_OUT], github: ghOff() })), [
    { who: 'github', ok: false, sentence: 'The sign-in to GitHub did not finish.' }]);
  assert.deepEqual(V.signInEnded(before, before), []);
  // GitHub refused, in Workbench's words; a terminal of the person's own where Terminal cannot open
  const refused = V.signInEnded(before, status({ canOpenTerminal: false, agents: [CLAUDE_OUT, { ...CODEX_OUT, actions: ['signin-terminal', 'key'] }], github: ghOff({ sentence: 'Workbench could not reach GitHub.' }) }));
  assert.deepEqual(refused.map(x => x.sentence), ['The sign-in in the browser did not finish. Sign in in a terminal instead.', 'Workbench could not reach GitHub.']);
  // nothing before (the first status), or nothing waited
  assert.deepEqual(V.signInEnded(null, after), []);
  assert.deepEqual(V.signInEnded(status(), after), []);
});

test('the panel reads the status every 2 seconds while a sign-in waits, one read at a time, only while it is open', () => {
  const conn = read('../ui/connect.js');
  assert.match(conn, /const POLL_MS = 2000;/);
  const poll = conn.slice(conn.indexOf('function pollSoon('), conn.indexOf('\n}\n', conn.indexOf('function pollSoon(')));
  assert.match(poll, /if \(st\.poll \|\| st\.polling \|\| !connectShown\(\) \|\| !signingInWaits\(st\.status\)\) return;/);
  assert.match(poll, /setTimeout\(async \(\) => \{/);
  assert.match(poll, /request\(\(\) => connectApi\.status\(\), \{ quiet: true \}\)/, 'GET /api/connect, quietly: never the slower re-check');
  assert.doesNotMatch(poll, /recheck/);
  assert.match(poll, /finally \{ st\.polling = false; if \(r\) pollSoon\(\); \}/, 'a read that failed does not repeat every 2 seconds');
  const req = conn.slice(conn.indexOf('async function request('), conn.indexOf('\n}\n', conn.indexOf('async function request(')));
  assert.ok(req.indexOf('pollSoon()') > req.indexOf('finally'), 'after every answer, whichever it was');
  assert.match(req, /signInEnded\(before, s\)/);
  assert.match(req, /answered \? \[\] :/, 'an answer’s own words come first');
  // an agent's sign-in that ended at all (its outcome in this status or not) has the agents checked again, once
  assert.match(req, /const waited = new Set\(agentsOf\(before\)\.filter\(a => a\.signingIn\)\.map\(a => a\.id\)\);\n\s+if \(agentsOf\(s\)\.some\(a => waited\.has\(a\.id\) && !a\.signingIn\) && connectShown\(\)\) setTimeout\(\(\) => recheck\(\), 0\);/);
  const fin = conn.slice(conn.indexOf('function finish('), conn.indexOf('\n}\n', conn.indexOf('function finish(')));
  assert.match(fin, /clearTimeout\(st\.poll\);/, 'closing the panel stops reading');
  // every way in sends its own request; the token form is read from its own part
  for (const s of ["signin: () => connectApi.signin(a.id)", "'signin-console': () => connectApi.signin(a.id, { console: true })",
    "'signin-terminal': () => connectApi.signin(a.id, { terminal: true })", 'install: () => connectApi.install(a.id)', 'connectApi.cancelSignin(a.id)',
    'connectApi.githubSignIn()', 'connectApi.githubSignInCancel()', 'connectApi.githubSignOut()', 'connectApi.gitInstall()', "const part = partOf('gh-token');"]) {
    assert.ok(conn.includes(s), s);
  }
});

// ---------------------------------------------------------------- keys: the list, and how values read
test('a key reads as the spec says: what it is, where, who gets it, and each name with only its last 4 characters', () => {
  const [k] = V.keysOf(status(), { presets: PRESETS });
  assert.equal(k.sentence, 'AWS for all repositories, given to all agents: AWS_ACCESS_KEY_ID •••• 7QXA, AWS_SECRET_ACCESS_KEY •••• 9f2b');
  const h = html(status());
  assert.ok(h.includes(esc(k.sentence)));
  const remove = buttons(h).find(b => b.cn === 'key-remove');
  assert.equal(remove['key-id'], 'k1', 'Remove carries the key it was drawn for');
  assert.equal(remove.key, 'key-remove:k1:Remove');
  // scope and agents, in words
  const names = new Map([['claude', 'Claude Code'], ['codex', 'Codex']]);
  assert.equal(V.givenWords(['claude'], names), 'given to Claude Code');
  assert.equal(V.givenWords(['claude', 'codex'], names), 'given to Claude Code and Codex');
  assert.equal(V.givenWords([], names), 'given to no agent');
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/shop', here: true }, 'shop'), 'for this repository');
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/link-to-shop', here: true }, 'shop'), 'for this repository', 'Workbench says so');
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/shop/', here: false }, 'other'), 'for the repository shop');
  // "this repository" only when Workbench says so (it compares real paths, as agents get keys), never from a folder's
  // name: the same project cloned twice is two repositories called shop, and the other one's key reads by its place
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/Developer/shop', here: false }, 'shop'), 'for the repository at /Users/sam/Developer/shop');
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/shop' }, 'shop'), 'for the repository at /Users/sam/shop', 'nothing said: not this one');
  const twin = { ...AWS_KEY, scope: { kind: 'repo', root: '/Users/sam/Developer/shop', here: false } };
  assert.equal(V.keysOf(status({ keys: [twin] }), { presets: PRESETS, repoName: 'shop' })[0].sentence,
    'AWS for the repository at /Users/sam/Developer/shop, given to all agents: AWS_ACCESS_KEY_ID •••• 7QXA, AWS_SECRET_ACCESS_KEY •••• 9f2b');
  // removing asks first, in place
  const asking = html(status(), { open: { removing: 'k1' } });
  assert.match(asking, /Remove AWS\? Agents started from now on will not get it\./);
  assert.deepEqual(buttons(asking).filter(b => b['key-id'] === 'k1').map(b => b.label), ['Remove it', 'Keep it']);
});

test('a secret never shows: only "•••• " and 4 characters (12 or more), "••••", or a value the preset says is not secret', () => {
  assert.equal(V.maskTail(fake('abcd', 'efgh', 'ijkl')), '•••• ijkl');
  assert.equal(V.maskTail(fake('abcd', 'efgh', 'ijk')), '••••', 'shorter than 12: no tail at all');
  for (const ok of ['••••', '•••• 7QXA', '•••• a']) assert.equal(V.isMasked(ok), true, ok);
  for (const bad of ['•••• 7QXAB', '•••••', '•••• ', 'AKIA', '7QXA', null, '•••• 7Q XA']) assert.equal(V.isMasked(bad), false, String(bad));
  // a store that sent a value whole, for a secret field, still shows nothing of it
  const whole = fake('wJalr', 'XUtnF', 'EMI/K7', 'MDENG/bPxRfi', 'CYEXAMPLEKEY');
  const k = { ...AWS_KEY, vars: [{ name: 'AWS_SECRET_ACCESS_KEY', shown: whole }, { name: 'AWS_REGION', shown: 'eu-west-2' }, { name: 'MY_TOKEN', shown: 'plain words' }] };
  const [row] = V.keysOf({ agents: [], keys: [k] }, { presets: PRESETS, looksLikeSecret: looks });
  assert.deepEqual(row.vars.map(v => v.shown), ['••••', 'eu-west-2', '••••'], 'region is not secret; a name no preset knows counts as secret');
  assert.ok(!row.sentence.includes(whole.slice(-8)));
  // a value the preset calls not secret but that looks like a key is masked too
  const akia = fake('AKIA', 'Z7Q2', 'WX4E', 'R5T6', 'Y7U8');
  const [row2] = V.keysOf({ agents: [], keys: [{ ...k, vars: [{ name: 'AWS_REGION', shown: akia }] }] }, { presets: PRESETS, looksLikeSecret: looks });
  assert.equal(row2.vars[0].shown, '••••');
  assert.ok(!html({ ...status(), keys: [k] }).includes(whole), 'nor in the panel');
});

test('the warning about keys is always there, and says checks get them too', () => {
  for (const keys of [[], [AWS_KEY], { list: [AWS_KEY] }]) {
    const h = html(status({ keys }));
    assert.ok(h.includes(esc(V.KEYS_WARNING)));
    assert.ok(h.includes(esc(V.CHECKS_NOTE)));
  }
  assert.equal(V.KEYS_WARNING, 'Agents can read the keys you give them, and so can anything they run. Give them keys that can do only what their work needs.');
  assert.match(html(status({ keys: [] })), /No keys yet\./);
  assert.equal(V.keysOf({ agents: [], keys: { list: [AWS_KEY] } }).length, 1, 'a list under the status’s keys is read too');
});

// ---------------------------------------------------------------- adding a key: every preset's form
test('every preset’s form: secret fields are password fields, the rest plain; who gets it and where; its note and link', () => {
  const s = status({ agents: [agent(), CODEX_OUT] });
  const notes = V.signInNotes(presetModule.signInVariables);
  assert.ok(PRESETS.length >= 9, 'the presets the spec lists');
  for (const id of ['anthropic', 'openai', 'gemini', 'aws', 'google-cloud', 'azure', 'github', 'stripe', 'custom']) assert.ok(PRESETS.some(p => p.id === id), id);
  for (const p of PRESETS) {
    const h = V.addForm(s, { preset: p.id, rows: 1 }, { presets: PRESETS, signIn: notes, canRepo: true }, new Set());
    assert.ok(buttons(h).some(b => b.cn === 'preset' && b.preset === p.id && /aria-pressed="true"/.test(h)), `${p.id}: its pill is pressed`);
    const ins = inputs(h);
    for (const i of ins) {
      assert.doesNotMatch(i, /type="password"[^]*\bvalue=|\bvalue=[^]*type="password"/, `${p.id}: no value is ever written into a password field`);
      if (!/type="(radio|checkbox)"/.test(i)) { assert.match(i, /autocomplete="off"/, `${p.id}: ${i}`); assert.doesNotMatch(i, /\bname=/, `${p.id}: ${i}`); }
    }
    if ((p.fields || []).length) {
      for (const f of p.fields) {
        const field = ins.find(i => i.includes(`data-var="${f.name}"`));
        assert.ok(field, `${p.id}: ${f.name} has a field`);
        assert.match(field, f.secret === false ? /type="text"/ : /type="password"/, `${p.id}: ${f.name}`);
        assert.ok(h.includes(`<code>${f.name}</code>`), `${p.id}: the variable’s name is shown`);
        if (f.optional) assert.match(h, /\(optional\)/);
        for (const also of f.also || []) assert.ok(h.includes(`also as ${also}`) || h.includes(also), `${p.id}: ${also}`);
      }
    } else {
      assert.match(h, /class="cn-rows"/, 'the person’s own names and values');
      assert.ok(buttons(h).some(b => b.cn === 'add-row'));
    }
    assert.match(h, /<legend>For<\/legend>.*this repository.*all repositories/s);
    assert.match(h, /<legend>Given to<\/legend>.*all agents.*Claude Code.*Codex/s);
    const given = /<input type="radio" name="cn-given" value="([^"]+)"[^>]*checked/.exec(h)[1];
    assert.equal(given, Array.isArray(p.agents) && p.agents.length === 1 && ['claude', 'codex'].includes(p.agents[0]) ? p.agents[0] : 'all', `${p.id}: who it suits is chosen first`);
    if (p.note) assert.ok(h.includes(esc(p.note.split(/\s+/).filter(Boolean).join(' '))), `${p.id}: its note`);
    if (p.link) assert.match(h, /href="https:\/\//, `${p.id}: its link`);
    assert.ok(buttons(h).some(b => b.cn === 'add-save' && b.pri));
  }
  // the AWS preset as the spec gives it
  const aws = PRESETS.find(p => p.id === 'aws');
  assert.deepEqual(aws.fields.map(f => [f.name, f.secret !== false, !!f.optional]),
    [['AWS_ACCESS_KEY_ID', true, false], ['AWS_SECRET_ACCESS_KEY', true, false], ['AWS_SESSION_TOKEN', true, true], ['AWS_REGION', false, true]]);
  // without a repository (the demo, no git), a key is for all repositories only
  assert.doesNotMatch(V.addForm(s, { preset: 'aws' }, { presets: PRESETS, canRepo: false }), /this repository/);
  // a name an agent signs in with is said (the shape of the shared module's list is its own: a literal one here)
  const said = new Map([['ANTHROPIC_API_KEY', 'Claude Code signs in with ANTHROPIC_API_KEY before your subscription.']]);
  const anthropic = V.addForm(s, { preset: 'anthropic' }, { presets: PRESETS, signIn: said, canRepo: true });
  assert.ok(anthropic.includes(esc('Claude Code signs in with ANTHROPIC_API_KEY before your subscription.')));
  assert.doesNotMatch(V.addForm(s, { preset: 'aws' }, { presets: PRESETS, signIn: said, canRepo: true }), /signs in with ANTHROPIC_API_KEY/);
  // before a preset is chosen: the presets and Cancel only
  const first = V.addForm(s, { preset: null }, { presets: PRESETS });
  assert.equal(buttons(first).filter(b => b.cn === 'preset').length, PRESETS.length);
  assert.doesNotMatch(first, /<input/);
});

test('a link a preset gives is used only when it is https', () => {
  const odd = [{ id: 'x', label: 'X', agents: 'all', note: null, link: 'javascript:alert(1)', fields: [{ name: 'X_KEY', label: 'Key', secret: true }] }];
  assert.doesNotMatch(V.addForm(status(), { preset: 'x' }, { presets: odd }), /javascript:|<a /);
});

test('signInVariables is read whatever its shape', () => {
  assert.equal(V.signInNotes({ GH_TOKEN: 'Copilot may sign in with it.' }).get('GH_TOKEN'), 'Copilot may sign in with it.');
  assert.deepEqual([...V.signInNotes(['ANTHROPIC_API_KEY', 'not a name', 7]).keys()], ['ANTHROPIC_API_KEY']);
  assert.equal(V.signInNotes([{ name: 'GEMINI_API_KEY', sentence: 'Gemini signs in with it.' }]).get('GEMINI_API_KEY'), 'Gemini signs in with it.');
  assert.ok(V.signInNotes(new Map([['CODEX_API_KEY', { why: 'Codex bills it.' }]])).has('CODEX_API_KEY'));
  assert.deepEqual([...V.signInNotes({ claude: ['ANTHROPIC_API_KEY'], codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'] }).keys()], ['ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_API_KEY']);
  assert.equal(V.signInNotes(null).size, 0);
  assert.match(V.signInWarning('GITHUB_TOKEN', new Map([['GITHUB_TOKEN', null]])), /Some agents sign in with GITHUB_TOKEN/);
  assert.equal(V.signInWarning('AWS_REGION', new Map()), null);
});

test('what a new key sends: its fields (also names given the same value), where, who, and nothing it should not', () => {
  const secret = fake('ab', 'cd', '1234', 'efgh', '5678');
  const openai = V.newKeyRequest({ preset: 'openai', label: '', entries: [{ name: 'OPENAI_API_KEY', value: ` ${secret} ` }], scope: 'all', given: 'codex' }, PRESETS);
  const openaiLabel = PRESETS.find(p => p.id === 'openai').label;   // the preset's own name, when the person gives none
  assert.deepEqual(openai.body, { preset: 'openai', label: openaiLabel, values: { OPENAI_API_KEY: secret, CODEX_API_KEY: secret }, scope: 'all', agents: ['codex'] });
  const aws = V.newKeyRequest({ preset: 'aws', label: 'Deploy', scope: 'repo', given: 'all',
    entries: [{ name: 'AWS_ACCESS_KEY_ID', value: 'A1' }, { name: 'AWS_SECRET_ACCESS_KEY', value: 'B2' }, { name: 'AWS_SESSION_TOKEN', value: '' }, { name: 'AWS_REGION', value: 'eu-west-2' }] }, PRESETS);
  assert.deepEqual(aws.body, { preset: 'aws', label: 'Deploy', values: { AWS_ACCESS_KEY_ID: 'A1', AWS_SECRET_ACCESS_KEY: 'B2', AWS_REGION: 'eu-west-2' }, scope: 'repo', agents: 'all' });
  assert.match(V.newKeyRequest({ preset: 'aws', entries: [{ name: 'AWS_ACCESS_KEY_ID', value: 'A1' }] }, PRESETS).error, /^Fill in .+\.$/, 'the missing secret access key, by its label');
  assert.match(V.newKeyRequest({ preset: 'stripe', entries: [{ name: 'STRIPE_SECRET_KEY', value: 'x'.repeat(2001) }] }, PRESETS).error, /longer than 2,000 characters/);
  assert.match(V.newKeyRequest({ preset: 'stripe', entries: [{ name: 'STRIPE_SECRET_KEY', value: 'a\nb' }] }, PRESETS).error, /line break/);
  assert.match(V.newKeyRequest({ preset: 'nope', entries: [] }, PRESETS).error, /Choose what the key is for/);
  // the person's own names
  const custom = V.newKeyRequest({ preset: 'custom', label: 'Sentry', given: 'claude', entries: [{ name: 'SENTRY_DSN', value: 'v1' }, { name: '', value: '' }] }, PRESETS);
  assert.deepEqual(custom.body, { preset: 'custom', label: 'Sentry', values: { SENTRY_DSN: 'v1' }, scope: 'all', agents: ['claude'] });
  assert.equal(V.newKeyRequest({ preset: 'custom', label: 'X', entries: [{ name: '1BAD', value: 'v' }] }, PRESETS).error,
    'The variable name in row 1 can use only letters, digits and _, and must start with a letter or _.', 'the name is never repeated');
  assert.match(V.newKeyRequest({ preset: 'custom', label: 'X', entries: [{ name: '', value: 'v' }] }, PRESETS).error, /variable name/);
  assert.match(V.newKeyRequest({ preset: 'custom', label: '', entries: [{ name: 'A', value: 'v' }] }, PRESETS).error, /Name this key/);
  assert.match(V.newKeyRequest({ preset: 'custom', label: 'X', entries: [] }, PRESETS).error, /at least one/);
  const many = Array.from({ length: 21 }, (_, i) => ({ name: `N${i}`, value: 'v' }));
  assert.match(V.newKeyRequest({ preset: 'custom', label: 'X', entries: many }, PRESETS).error, /at most 20 names/);
  assert.match(V.newKeyRequest({ preset: 'aws', label: 'L'.repeat(81), entries: [{ name: 'AWS_ACCESS_KEY_ID', value: 'A' }, { name: 'AWS_SECRET_ACCESS_KEY', value: 'B' }] }, PRESETS).error, /shorter name/);
  assert.equal(V.newKeyRequest({ preset: 'aws', entries: [{ name: 'AWS_ACCESS_KEY_ID', value: 'A' }, { name: 'AWS_SECRET_ACCESS_KEY', value: 'B' }], given: '../x' }, PRESETS).body.agents, 'all');
  // an agent's own key
  assert.deepEqual(V.agentKeyRequest(` ${secret} `), { value: secret });
  assert.match(V.agentKeyRequest('').error, /Fill in the key/);
  assert.match(V.agentKeyRequest('x'.repeat(2001)).error, /longer than 2,000/);
});

test('a key typed into a variable name’s field is never said, kept or drawn again: its row is named, and the name dropped', () => {
  const proj = fake('sk-', 'proj-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz', 'Mn8Bv7Cx6');   // not a variable name ('-')
  const ghp = fake('ghp', '_', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz', 'Mn8B');             // a variable name's shape
  const akia = fake('AK', 'IA', 'Q4R7', 'T2W9', 'X5Z8', 'C3V6');                      // so is this one
  for (const k of [proj, ghp, akia]) assert.equal(looks(k).secret, true, 'each looks like a key');
  const isKey = row => `The variable name in row ${row} looks like a key itself. Put the key in its value, and give it a name such as SENTRY_DSN.`;
  const said = [];
  for (const [entries, row] of [
    [[{ name: proj, value: 'v' }], 1],
    [[{ name: 'SENTRY_DSN', value: 'v1' }, { name: '', value: '' }, { name: ghp, value: '' }], 3],
    [[{ name: '1BAD', value: 'v' }, { name: akia, value: 'a\nb' }], 2],
  ]) {
    const q = V.newKeyRequest({ preset: 'custom', label: 'X', entries }, PRESETS, looks);
    assert.deepEqual(q, { error: isKey(row) }, 'said first, by its row, and nothing is sent');
    said.push(q.error);
  }
  // Without the shared check, a name that cannot be a variable name is not repeated either.
  const q = V.newKeyRequest({ preset: 'custom', label: 'X', entries: [{ name: 'GOOD', value: 'v' }, { name: proj, value: 'v' }] }, PRESETS);
  assert.equal(q.error, 'The variable name in row 2 can use only letters, digits and _, and must start with a letter or _.');
  said.push(q.error);
  for (const s of said) for (const k of [proj, ghp, akia]) assert.ok(!s.includes(k.slice(0, 6)) && !s.includes(k.slice(-6)), `nothing of the key in “${s}”`);
  // Ordinary names still go through.
  assert.deepEqual(V.newKeyRequest({ preset: 'custom', label: 'X', entries: [{ name: 'SENTRY_DSN', value: 'v1' }] }, PRESETS, looks).body.values, { SENTRY_DSN: 'v1' });
  // The form keeps the names it was given through keptNames: one that looks like a key is dropped, by its row.
  const kept = V.keptNames(['SENTRY_DSN', ghp, '', ` ${proj} `, 'A'], looks);
  assert.deepEqual(kept, { names: ['SENTRY_DSN', '', '', '', 'A'], dropped: [2, 4] });
  const form = V.addForm(status(), { preset: 'custom', rows: 5, names: kept.names }, { presets: PRESETS });
  for (const k of [proj, ghp]) assert.ok(!form.includes(k.slice(3, 15)), 'nothing of it is drawn again');
  assert.match(form, /value="SENTRY_DSN"/);
  // connect.js keeps names only through keptNames, empties the field a dropped one is in, and checks what it sends the
  // same way.
  const conn = read('../ui/connect.js');
  const save = conn.slice(conn.indexOf('async function saveKey'), conn.indexOf('async function copyCommand'));
  const at = s => save.indexOf(s);
  assert.ok(at('keptNames(') > 0 && at('keptNames(') < at('names: kept.names'), 'a name is checked before it is kept');
  assert.ok(at('kept.dropped') > 0 && at("value = ''") > at('kept.dropped') && at("value = ''") < at('names: kept.names'), 'its field is emptied');
  assert.match(save, /newKeyRequest\(\{[^}]*\}, presets\(\), ctx\.looksLikeSecret\)/);
});

test('while a save is on its way, or was refused, the person’s choices stay in the form; values never do', () => {
  const s = status();
  const add = { preset: 'aws', rows: 1, label: 'Deploy <prod>', scope: 'repo', given: 'codex' };
  const h = V.addForm(s, add, { presets: PRESETS, canRepo: true });
  assert.match(h, /data-field="key-label"[^>]*value="Deploy &lt;prod&gt;"/);
  assert.match(h, /name="cn-scope" value="repo"[^>]*checked/);
  assert.match(h, /name="cn-given" value="codex"[^>]*checked/);
  assert.doesNotMatch(h, /name="cn-given" value="all"[^>]*checked/);
  // no repository: "all repositories" whatever was chosen
  assert.match(V.addForm(s, add, { presets: PRESETS, canRepo: false }), /name="cn-scope" value="all"[^>]*checked/);
  // the person's own names come back; their values do not
  const custom = V.addForm(s, { preset: 'custom', rows: 2, names: ['SENTRY_DSN', '<x>'] }, { presets: PRESETS });
  assert.match(custom, /class="cn-in cn-name"[^>]*value="SENTRY_DSN"/);
  assert.match(custom, /value="&lt;x&gt;"/);
  for (const i of inputs(custom).filter(x => /type="password"/.test(x))) assert.doesNotMatch(i, /\bvalue=/);
  // git's fields keep what was typed until git has it; the GitHub box keeps its tick
  const typed = html(s, { open: { git: { name: 'New Name', email: 'new@example.com' }, ghToken: true, ghAgents: true } });
  assert.match(typed, /data-field="git-name"[^>]*value="New Name"/);
  assert.match(typed, /data-field="gh-agents"[^>]*checked/);
});

test('the person’s own rows: one to start, more one at a time, at most 20', () => {
  const s = status();
  assert.equal((V.addForm(s, { preset: 'custom', rows: 1 }, { presets: PRESETS }).match(/class="cn-crow"/g) || []).length, 1);
  const full = V.addForm(s, { preset: 'custom', rows: 99 }, { presets: PRESETS });
  assert.equal((full.match(/class="cn-crow"/g) || []).length, 20);
  assert.equal(buttons(full).find(b => b.cn === 'add-row').disabled, true);
  const row = V.customRow(3);
  assert.match(row, /data-row="3"/);
  assert.match(row, /class="cn-in cn-value"[^>]*/);
  assert.match(inputs(row)[1], /type="password"/);
});

// ---------------------------------------------------------------- the panel as a whole
test('the panel is one keyed part per row and form; while the first status is on its way, or when it failed, it says so', () => {
  const parts = V.panelParts(status(), { presets: PRESETS, open: { keyFor: 'codex', cmd: { codex: 'codex login' }, add: { preset: 'aws' } } });
  const keys = parts.map(p => p.k);
  assert.equal(new Set(keys).size, keys.length, 'each part has its own key');
  for (const p of parts) {
    assert.match(p.html, new RegExp(`^<[a-z0-9]+ [^>]*data-k="${esc(p.k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), p.k);
    assert.equal((p.html.match(/data-k="/g) || []).length, 1, `${p.k}: one element`);
  }
  assert.deepEqual(keys.filter(k => /^(agents-h|git-h|keys-h)$/.test(k)), ['agents-h', 'git-h', 'keys-h'], 'Agents, Git and GitHub, Keys for your agents');
  assert.match(V.panelParts(null, {})[0].html, /Looking for your coding agents…/);
  const failed = V.panelParts(null, { error: 'Workbench isn’t answering. Is it still running?' })[0].html;
  assert.match(failed, /Workbench isn’t answering/);
  assert.ok(buttons(failed).some(b => b.cn === 'retry'));
  assert.equal(V.statusOf({ ok: true, sentence: 'x', status: status() }).platform, 'darwin');
  assert.equal(V.statusOf(status()).platform, 'darwin');
  for (const bad of [null, {}, { status: {} }, { agents: 'no' }, 'x']) assert.equal(V.statusOf(bad), null);
  assert.deepEqual(V.metaFromStatus(status({ ready: false })), { ready: false, defaultAgent: 'claude', agents: [{ id: 'claude', name: 'Claude Code', ready: true }, { id: 'codex', name: 'Codex', ready: false }] });
});

test('everything Workbench or a person wrote is escaped, and hidden characters are shown, in text and attributes', () => {
  const rlo = U(0x202e), zw = U(0x200b);
  const evil = `<img src=x onerror=alert(1)>${rlo}`;
  const s = status({
    agents: [agent({ name: `Claude${zw} <b>Code</b>`, version: `2.1${rlo}`, from: evil, sentence: '' }), { ...CODEX_OUT, sentence: `Codex ${evil} is out.` }],
    git: { name: evil, email: 'a@b.c', sentence: `Git says ${evil}` },
    github: { connected: true, login: evil, agentsUseIt: false },
    keys: [{ ...AWS_KEY, label: evil, vars: [{ name: 'AWS_REGION', shown: evil }, { name: `BAD${rlo}`, shown: '••••' }] }],
  });
  const h = html(s, { open: { keyFor: 'claude', cmd: { claude: `claude auth login ${evil}` } } });
  assert.doesNotMatch(h, /<img|<b>|onerror=alert\(1\)>/);
  // the only raw hidden character allowed is none: a field's value keeps what git has (it is the person's own text)
  assert.equal(hasHidden(h.replace(/ value="[^"]*"/g, '')), false);
  assert.match(h, /⟦U\+202E⟧/);
  assert.match(h, /⟦U\+200B⟧/);
  assert.doesNotMatch(h, /BAD/, 'a variable name that does not fit is dropped, never guessed');
  // milestone 1.5's words: a sign-in's sentences, GitHub's sign-in and its code, its login, git missing, a command
  const later = [
    status({ agents: [{ ...CLAUDE_OUT, name: evil, signingIn: { since: 1, browser: true, sentence: `Finish ${evil}` } }, { ...CODEX_OUT, name: evil, actions: ['signin-terminal', 'key'] }],
      git: { installed: false, canInstall: true, sentence: evil }, github: signing({ phase: 'code', code: evil, url: `https://github.com/${evil}`, sentence: evil }) }),
    status({ github: signing({ phase: 'terminal', sentence: `Terminal ${evil}` }) }),
    status({ github: ghOff({ signingIn: inATerminal({ sentence: `Run ${evil}`, command: `gh auth login ${evil}${zw}` }) }) }),
    status({ github: { connected: true, via: 'gh', login: evil, sentence: '' } }),
    status({ github: ghOff({ sentence: `Refused ${evil}` }) }),
  ];
  for (const x of later) {
    const m = html(x, { open: { ghCmd: `gh auth login ${evil}`, ghToken: true } });
    assert.doesNotMatch(m, /<img|onerror=alert\(1\)>/);
    assert.equal(hasHidden(m), false);
    assert.match(m, /⟦U\+202E⟧/);
  }
});

// ---------------------------------------------------------------- the board's key guard
test('text that looks like a key is refused before it is sent; sentences, paths and commit hashes are not keys', () => {
  const keys = [
    fake('sk-', 'ant-', 'api03-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz'),
    fake('sk-', 'proj-', 'Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXc9V'),
    fake('AK', 'IA', 'Z7Q2', 'WX4E', 'R5T6', 'Y7U8'),
    fake('gh', 'p_', 'Ab3De5Gh7Jk9Mn2Pq4St6Vw8Yz1Bc3Df5Gh7'),
    fake('-----', 'BEGIN OPENSSH PRIVATE KEY', '-----'),
    fake('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    `here is my key: ${fake('sk-', 'ant-', 'api03-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz')} thanks`,
  ];
  for (const k of keys) assert.equal(V.keyRefusal(k, looks), V.KEY_REFUSAL, `${k.slice(0, 6)}…`);
  assert.equal(V.KEY_REFUSAL, 'That looks like a key, so it was not sent. Keys go in Agents & keys, where they are kept safe.');
  const plain = ['fix the login bug', 'start an agent to fix the flaky checkout test', 'work on the login bug', 'src/core/engine.mjs', 'what needs me',
    'merge it into main', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'look at 3f2c9a1', 'connect github', 'add a key'];
  for (const p of plain) assert.equal(V.keyRefusal(p, looks), null, p);
  assert.equal(V.keyRefusal('anything', null), null, 'no check: nothing is refused here (the engine checks again)');
  assert.equal(V.keyRefusal('anything', () => { throw new Error('x'); }), null);
});

test('the board’s input and the git screen’s refuse a key before anything else, and the board takes no keys while the panel is open', () => {
  const app = read('../ui/app.js');
  const body = name => { const i = app.indexOf(`async function ${name}(`); return app.slice(i, app.indexOf('\n}\n', i)); };
  for (const fn of ['submit', 'gitCommand']) {
    const b = body(fn);
    const guard = b.indexOf('refuseKey(text, ');
    assert.ok(guard > 0, `${fn} guards`);
    const code = b.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
    assert.match(code[code.indexOf('if (!text) return;') + 1], /^if \(refuseKey\(text, (true|false)\)\) return;$/, `${fn}: right after the empty check`);
    for (const later of ['S.reply', 'pageCommand', 'gitScreenWords', 'api.command']) if (b.includes(later)) assert.ok(b.indexOf(later) > guard, `${fn}: ${later} comes after the guard`);
  }
  // the guard empties the input and never says or keeps the text
  const refuse = app.slice(app.indexOf('function refuseKey('), app.indexOf('\n}\n', app.indexOf('function refuseKey(')));
  assert.match(refuse, /if \(board\) \{ el\.say\.value = ''/);
  assert.match(body('submit'), /refuseKey\(text, true\)/, 'the board’s input is emptied');
  assert.doesNotMatch(refuse, /say\(text|console\.|localStorage|sessionStorage/);
  // keys: while the panel is open, nothing reaches the board's input
  const keydown = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf('\n});\n', app.indexOf("document.addEventListener('keydown'")));
  const early = keydown.indexOf('if (connectShown())');
  assert.ok(early > 0 && early < keydown.indexOf("e.key === 'Escape') { escape()") && early < keydown.indexOf('input.value += e.key'));
  assert.match(app, /^import \* as secretShape from '\/shared\/secretshape\.mjs';/m, 'the shared check is read as a whole');
  // replies that ask for it open the panel
  assert.ok((app.match(/openConnect === true\) showConnect\(/g) || []).length >= 4);
});

test('nothing on the page logs, keeps or puts a key in an address', () => {
  const apiSrc = read('../ui/api.js');
  for (const [f, src] of [['connect.js', read('../ui/connect.js')], ['connectview.js', read('../ui/connectview.js')], ['api.js, the panel’s part', apiSrc.slice(apiSrc.indexOf('async function connectCall'), apiSrc.indexOf('export function connect('))]]) {
    assert.ok(src.length > 500, f);
    assert.doesNotMatch(src, /console\.|localStorage|sessionStorage|location\.|history\./, f);
  }
  const conn = read('../ui/connect.js');
  assert.doesNotMatch(conn, /\bS\./, 'the panel keeps nothing in the page’s state');
  assert.doesNotMatch(conn, /\bsay\(/, 'and says nothing on the board');
  assert.match(conn, /^import \* as presetModule from '\/shared\/keypresets\.mjs';/m);
});

// ---------------------------------------------------------------- the panel's requests (ui/api.js)
test('the panel’s requests: their routes and bodies; a refusal comes back as it is; Workbench’s own sentence is kept', async () => {
  const api = await import('../ui/api.js');
  const sent = [];
  let answer = { status: 200, body: { ok: true, sentence: 'Done.', status: status() } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init) => { sent.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }); return { status: answer.status, ok: answer.status < 300, json: async () => answer.body }; };
  try {
    const value = fake('sk-', 'ant-', 'api03-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz');
    await api.connectApi.status();
    await api.connectApi.recheck();
    await api.connectApi.install('codex');
    await api.connectApi.signin('claude');
    await api.connectApi.key('claude', value);
    await api.connectApi.setDefault('codex');
    await api.connectApi.git('Sam Lee', 'sam@example.com');
    await api.connectApi.github('gh-token-value', true);
    await api.connectApi.githubDisconnect();
    await api.connectApi.addKey({ preset: 'aws', label: 'AWS', values: { AWS_REGION: 'eu-west-2' }, scope: 'all', agents: 'all', extra: 'dropped' });
    await api.connectApi.removeKey('k/1');
    await api.connectApi.githubAgents(true);
    await api.connectApi.githubAgents('yes');
    // milestone 1.5: the agents' own logins (in the browser, the Anthropic Console account, in Terminal) and Cancel,
    // git's installer, and GitHub through its own command-line tool
    await api.connectApi.signin('claude', { console: true });
    await api.connectApi.signin('codex', { terminal: true });
    await api.connectApi.signin('codex', { console: 'yes', terminal: 1 });
    await api.connectApi.cancelSignin('claude');
    await api.connectApi.gitInstall();
    await api.connectApi.githubSignIn();
    await api.connectApi.githubSignInCancel();
    await api.connectApi.githubSignOut();
    assert.deepEqual(sent.map(r => `${r.method} ${r.path}`), [
      'GET /api/connect', 'POST /api/connect/recheck', 'POST /api/connect/agents/codex/install', 'POST /api/connect/agents/claude/signin',
      'POST /api/connect/agents/claude/key', 'POST /api/connect/agents/codex/default', 'POST /api/connect/git', 'POST /api/connect/github',
      'POST /api/connect/github/disconnect', 'POST /api/connect/keys', 'POST /api/connect/keys/k%2F1/remove',
      'POST /api/connect/github/agents', 'POST /api/connect/github/agents',
      'POST /api/connect/agents/claude/signin', 'POST /api/connect/agents/codex/signin', 'POST /api/connect/agents/codex/signin',
      'POST /api/connect/agents/claude/signin/cancel', 'POST /api/connect/git/install', 'POST /api/connect/github/signin',
      'POST /api/connect/github/signin/cancel', 'POST /api/connect/github/signout']);
    assert.deepEqual(sent[3].body, {}, 'Sign in alone: the agent’s own login, in the browser');
    assert.deepEqual(sent[4].body, { value });
    assert.deepEqual(sent[7].body, { token: 'gh-token-value', agentsUseIt: true });
    assert.deepEqual(sent[9].body, { preset: 'aws', label: 'AWS', values: { AWS_REGION: 'eu-west-2' }, scope: 'all', agents: 'all' });
    assert.deepEqual(sent[11].body, { agentsUseIt: true }, 'GitHub’s box: whether agents get the token, and no token');
    assert.deepEqual(sent[12].body, { agentsUseIt: false }, 'only true gives it to them');
    assert.deepEqual(sent.slice(13, 16).map(r => r.body), [{ console: true }, { terminal: true }, {}], 'only the flags that are true');
    for (const r of sent.slice(16)) assert.deepEqual(r.body, {}, r.path);
    for (const r of sent) { assert.ok(!r.path.includes(value) && !r.path.includes('gh-token-value'), 'values never in an address'); assert.equal(r.headers['Content-Type'], 'application/json'); }
    // a refusal: its sentence and status come back, nothing thrown
    answer = { status: 200, body: { ok: false, sentence: 'GitHub did not accept that token.', status: status() } };
    const r = await api.connectApi.github('x', false);
    assert.equal(r.ok, false);
    assert.equal(r.sentence, 'GitHub did not accept that token.');
    // GitHub's box refused because the key store cannot give the token back: its sentence, why and a fresh status, as
    // the route answers, kept as they are; the box goes back to what that status says
    const cannot = 'Workbench could not read the GitHub token it keeps, so this cannot change. Disconnect GitHub, then connect it again.';
    answer = { status: 200, body: { why: 'token', ok: false, sentence: cannot, status: status() } };
    const share = await api.connectApi.githubAgents(true);
    assert.deepEqual(share, { why: 'token', ok: false, sentence: cannot, status: status() });
    assert.deepEqual(V.statusOf(share), status());
    // a refusal with no status draws nothing: the box goes back to the status the panel has
    answer = { status: 200, body: { ok: false, why: 'token', sentence: cannot } };
    assert.equal(V.statusOf(await api.connectApi.githubAgents(true)), null);
    // and when GitHub is not connected any more: 409, its sentence, and the status code for the panel
    answer = { status: 409, body: { error: 'GitHub is not connected.' } };
    await assert.rejects(api.connectApi.githubAgents(false), { message: 'GitHub is not connected.', status: 409 });
    // an error keeps Workbench's own sentence, "token" and all
    answer = { status: 400, body: { error: 'That does not look like a GitHub token.' } };
    await assert.rejects(api.connectApi.github('x', false), { message: 'That does not look like a GitHub token.' });
    answer = { status: 404, body: {} };
    await assert.rejects(api.connectApi.status(), { message: 'Agents & keys is not available in this Workbench.' });
    answer = { status: 500, body: { error: 'fetch failed' } };
    await assert.rejects(api.connectApi.status(), { message: 'Something went wrong in Workbench. Try again.' });
    let refused = 0;
    api.whenRefused(() => { refused++; });
    answer = { status: 401, body: { error: 'Missing or wrong token.' } };
    await assert.rejects(api.connectApi.recheck(), { message: /This page’s key no longer works/ });
    assert.equal(refused, 1);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(api.connectApi.recheck(), { message: 'Workbench isn’t answering. Is it still running?' });
  } finally { globalThis.fetch = realFetch; }
});

// ---------------------------------------------------------------- the stand-in API of the page checks (scripts/ui-mock.mjs)
test('the page checks’ stand-in API answers Agents & keys as the panel reads it, and never sends a value back', async () => {
  const { startMock, scenario, SCENARIOS } = await import('../scripts/ui-mock.mjs');
  for (const name of ['connect-none', 'connect-claude', 'connect-nocodex', 'connect-github', 'connect-fail']) assert.ok(SCENARIOS.includes(name), name);
  assert.equal(V.connectMeta(scenario('connect-none')).ready, false, 'no agent ready: the lid’s Connect, and the panel opens by itself');
  assert.equal(V.connectMeta(scenario('connect-fail')).ready, true, 'a failed read opens only from the band, so no check meets its 500 by itself');
  for (const name of ['demo', 'merge', 'git', 'live']) assert.equal(V.connectMeta(scenario(name)), null, `${name}: the board as it was`);
  const mock = await startMock({ quiet: true });
  const base = `http://127.0.0.1:${mock.port}`;
  const ctl = (p, b) => fetch(`${base}/ctl/${p}`, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const call = (p, body) => fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': 'k' },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ code: r.status, body: await r.json() }));
  const sentences = s => V.agentsOf(s).map(a => `${V.agentSentence(a)} [${a.actions.join(' ')}]`);
  try {
    assert.equal((await call('/api/connect')).code, 404, 'the demo has nothing to connect');
    await ctl('scenario', { name: 'connect-claude' });
    let s = V.statusOf((await call('/api/connect')).body);
    assert.deepEqual(sentences(s), ['Claude Code 2.1.322 is ready, signed in with your Claude subscription. [key recheck]', 'Codex 0.166.0 is installed but not signed in. [signin key recheck]']);
    assert.deepEqual(V.metaFromStatus(s), V.connectMeta(scenario('connect-claude')), 'the snapshot says what the status says');
    // a preset form's key, and an agent's own: listed masked, never sent back
    const id = fake('AK', 'IA', 'Q4R7', 'T2W9', 'X5Z8', 'C3V6'), secret = fake('wJal', 'rXUtnFEMI', 'K7MDENGbPxRfi', 'CYZQ8EXAMPLE');
    const key = fake('sk-', 'ant-', 'api03-', 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz');
    let r = await call('/api/connect/keys', { preset: 'aws', label: 'AWS', values: { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'eu-west-2' }, scope: 'all', agents: 'all' });
    assert.equal(r.body.sentence, 'Saved AWS, for all repositories.');
    r = await call('/api/connect/agents/claude/key', { value: key });
    for (const v of [id, secret, key]) assert.ok(!JSON.stringify(r.body).includes(v), 'no value comes back');
    assert.deepEqual(V.keysOf(V.statusOf(r.body), { presets: PRESETS, repoName: 'shop', looksLikeSecret: looks }).map(k => k.sentence), [
      `AWS for all repositories, given to all agents: AWS_ACCESS_KEY_ID •••• ${id.slice(-4)}, AWS_SECRET_ACCESS_KEY •••• ${secret.slice(-4)}, AWS_REGION eu-west-2`,
      `Anthropic for all repositories, given to Claude Code: ANTHROPIC_API_KEY •••• ${key.slice(-4)}`]);
    // GitHub: connected, the box given and refused as Connect refuses it, then 409 once disconnected
    assert.equal((await call('/api/connect/github', { token: 'gh-token-value', agentsUseIt: false })).body.login, 'octocat');
    r = await call('/api/connect/github/agents', { agentsUseIt: true });
    assert.equal(V.githubBoxOn(V.statusOf(r.body).github), true);
    await ctl('mode', { connect: { githubAgents: 'token' } });
    r = await call('/api/connect/github/agents', { agentsUseIt: false });
    assert.deepEqual([r.code, Object.keys(r.body).sort()], [200, ['ok', 'sentence', 'status', 'why']], 'a refusal with a fresh status, as the route answers');
    assert.equal(V.githubBoxOn(V.statusOf(r.body).github), true, 'and nothing changed');
    await ctl('mode', { connect: null });
    await call('/api/connect/github/disconnect', {});
    r = await call('/api/connect/github/agents', { agentsUseIt: true });
    assert.deepEqual([r.code, r.body], [409, { error: 'GitHub is not connected.' }]);
    // a key for this repository: the stand-in marks it as Connect does (`here`), and the page words it from that
    await ctl('scenario', { name: 'connect-github' });
    s = V.statusOf((await call('/api/connect')).body);
    assert.deepEqual(s.keys.map(k => k.scope), [{ kind: 'all' }, { kind: 'repo', root: '/Users/someone/code/shop', here: true }]);
    assert.equal(V.keysOf(s, { presets: PRESETS, repoName: 'shop', looksLikeSecret: looks })[1].sentence, 'Stripe for this repository, given to Claude Code: STRIPE_SECRET_KEY •••• 4eC3');
    // no agent ready, a missing one installed through "Terminal", and a read that fails
    await ctl('scenario', { name: 'connect-none' });
    s = V.statusOf((await call('/api/connect')).body);
    assert.deepEqual(sentences(s), ['Claude Code 2.1.322 is installed but not signed in. [signin signin-console key recheck]', 'Codex is not installed. [install recheck]']);
    assert.equal(s.ready, false);
    assert.equal((await call('/api/connect/agents/codex/install', {})).body.opened, true);
    assert.match(sentences(V.statusOf((await call('/api/connect/recheck', {})).body))[1], /^Codex 0\.166\.0 is installed but not signed in\./);
    await ctl('scenario', { name: 'connect-fail' });
    assert.deepEqual([(await call('/api/connect')).code, (await call('/api/connect/recheck', {})).code], [500, 500]);
  } finally { await mock.close(); }
});

test('the stand-in API’s milestone 1.5 scenarios hold still, and its sign-ins move on one step per read, as the panel reads them', async () => {
  const { startMock, scenario, SCENARIOS } = await import('../scripts/ui-mock.mjs');
  const FIRST_RUN = ['connect-gh-none', 'connect-gh-installing', 'connect-gh-code', 'connect-gh-signed', 'connect-gh-refused', 'connect-git-missing', 'connect-browser', 'connect-browser-failed'];
  for (const name of FIRST_RUN) {
    assert.ok(SCENARIOS.includes(name), name);
    assert.equal(V.connectMeta(scenario(name)).ready, false, `${name}: no agent ready, so the panel opens by itself and the fit check lays it out`);
  }
  const mock = await startMock({ quiet: true });
  const base = `http://127.0.0.1:${mock.port}`;
  const ctl = (p, b) => fetch(`${base}/ctl/${p}`, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const call = (p, body) => fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': 'k' },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ code: r.status, body: await r.json() }));
  const read = async () => V.statusOf((await call('/api/connect')).body);
  const gh = s => V.githubOf(s);
  const claude = s => V.agentsOf(s).find(a => a.id === 'claude');
  try {
    // each scenario, as the panel draws it, and the same at every read
    const seen = {};
    for (const name of FIRST_RUN) {
      await ctl('scenario', { name });
      const s = await read();
      assert.deepEqual(await read(), s, `${name} holds still`);
      seen[name] = s;
    }
    assert.deepEqual([gh(seen['connect-gh-none']).connected, gh(seen['connect-gh-none']).ghInstalled, gh(seen['connect-gh-none']).signingIn], [false, false, null]);
    assert.equal(gh(seen['connect-gh-installing']).signingIn.phase, 'installing');
    assert.deepEqual([gh(seen['connect-gh-code']).signingIn.phase, gh(seen['connect-gh-code']).signingIn.code, gh(seen['connect-gh-code']).signingIn.url], ['code', 'WDJB-MJHT', V.GITHUB_DEVICE_PAGE]);
    assert.deepEqual([gh(seen['connect-gh-signed']).via, gh(seen['connect-gh-signed']).login], ['gh', 'octocat']);
    assert.match(gh(seen['connect-gh-refused']).sentence, /did not match the checksum/);
    assert.deepEqual(V.gitOf(seen['connect-git-missing']), { name: '', email: '', sentence: 'Git is not installed yet. Apple’s developer tools include it.', installed: false, canInstall: true });
    assert.equal(V.agentWaitWords(claude(seen['connect-browser'])), 'Finish signing in to Claude in your browser.');
    assert.equal(V.agentFailed(claude(seen['connect-browser-failed'])), true);
    assert.equal(V.signingInWaits(seen['connect-gh-code']) && V.signingInWaits(seen['connect-browser']) && !V.signingInWaits(seen['connect-gh-none']), true);
    // Sign in to GitHub: the tool first, then the code, then signed in through it; one at a time
    await ctl('scenario', { name: 'connect-gh-none' });
    let r = await call('/api/connect/github/signin', {});
    assert.deepEqual([r.body.ok, r.body.sentence, gh(V.statusOf(r.body)).signingIn.phase], [true, 'Getting GitHub’s command-line tool…', 'installing']);
    assert.match((await call('/api/connect/github/signin', {})).body.sentence, /already signing you in/);
    const phases = [];
    for (let i = 0; i < 4; i++) { const g = gh(await read()); phases.push(g.signingIn ? g.signingIn.phase : `${g.via}:${g.login}`); }
    assert.deepEqual(phases, ['code', 'code', 'code', 'gh:octocat']);
    r = await call('/api/connect/github/signout', {});
    assert.equal(r.body.sentence, 'Signed out of GitHub. GitHub still lists this sign-in under Settings → Applications until you revoke it there.');
    assert.equal(gh(V.statusOf(r.body)).connected, false);
    assert.equal(gh(V.statusOf(r.body)).ghInstalled, true, 'the tool stays');
    // installed already: the code at once; Cancel stops it
    r = await call('/api/connect/github/signin', {});
    assert.equal(gh(V.statusOf(r.body)).signingIn.phase, 'code');
    r = await call('/api/connect/github/signin/cancel', {});
    assert.deepEqual([r.body.sentence, gh(V.statusOf(r.body)).signingIn], ['Stopped signing in to GitHub.', null]);
    // a refused download, and the Terminal fallback
    await ctl('scenario', { name: 'connect-gh-none' });
    await ctl('mode', { connect: { gh: 'refused' } });
    await call('/api/connect/github/signin', {});
    const refused = await read();
    assert.deepEqual([gh(refused).signingIn, gh(refused).connected], [null, false]);
    assert.match(gh(refused).sentence, /^Workbench did not install GitHub’s command-line tool/);
    assert.deepEqual(V.signInEnded(seen['connect-gh-installing'], refused), [{ who: 'github', ok: false, sentence: gh(refused).sentence }], 'the panel says why');
    await ctl('scenario', { name: 'connect-gh-none' });
    await ctl('mode', { connect: { gh: 'terminal' } });
    await call('/api/connect/github/signin', {});
    assert.equal(gh(await read()).signingIn.phase, 'terminal');
    await ctl('mode', { connect: null });
    // an agent's own login in the browser: it waits, then is signed in; one that does not finish offers Terminal
    await ctl('scenario', { name: 'connect-gh-none' });
    r = await call('/api/connect/agents/claude/signin', {});
    assert.deepEqual([r.body.waiting, claude(V.statusOf(r.body)).signingIn !== null], [true, true]);
    assert.match(r.body.sentence, /Claude’s sign-in page/);
    assert.match((await call('/api/connect/agents/claude/signin', {})).body.sentence, /already waiting/);
    assert.notEqual(claude(await read()).signingIn, null);
    const done = await read();
    assert.deepEqual([claude(done).signingIn, claude(done).signedIn, claude(done).ready], [null, 'yes', true]);
    assert.equal((await call('/api/connect/agents/codex/signin', { console: true })).code, 409, 'Codex is not installed here');
    await ctl('scenario', { name: 'connect-browser-failed' });
    assert.deepEqual(claude(await read()).actions, ['signin-terminal', 'signin', 'signin-console', 'key', 'recheck']);
    r = await call('/api/connect/agents/claude/signin', { terminal: true });
    assert.equal(r.body.opened, true);
    assert.equal(claude(V.statusOf((await call('/api/connect/recheck', {})).body)).signedIn, 'yes', 'Terminal, then the re-check');
    await ctl('scenario', { name: 'connect-browser' });
    await ctl('mode', { connect: { browser: 'fail' } });
    r = await call('/api/connect/agents/claude/signin/cancel', {});
    assert.deepEqual([r.body.sentence, claude(V.statusOf(r.body)).signingIn], ['Stopped the sign-in to Claude Code.', null]);
    await call('/api/connect/agents/claude/signin', { console: true });
    await read();
    assert.equal(V.agentFailed(claude(await read())), true);
    await ctl('mode', { connect: null });
    // git: Install "opens Apple's installer", and the re-check finds git
    await ctl('scenario', { name: 'connect-git-missing' });
    assert.equal((await call('/api/connect/git', { name: 'Sam', email: 'sam@example.com' })).code, 409);
    r = await call('/api/connect/git/install', {});
    assert.equal(r.body.opened, true);
    assert.equal(V.gitOf(V.statusOf((await call('/api/connect/recheck', {})).body)).installed, true);
    assert.equal((await call('/api/connect/git/install', {})).code, 409);
  } finally { await mock.close(); }
});

test('the stand-in API answers GitHub as Connect does where Terminal cannot open, while git does not use gh’s sign-in, and while that is being set up', async () => {
  const { startMock, scenario, SCENARIOS } = await import('../scripts/ui-mock.mjs');
  for (const name of ['connect-gh-nogit', 'connect-gh-command']) {
    assert.ok(SCENARIOS.includes(name), name);
    assert.equal(V.connectMeta(scenario(name)).ready, false, `${name}: no agent ready, so the panel opens by itself and the fit check lays it out`);
  }
  const mock = await startMock({ quiet: true });
  const base = `http://127.0.0.1:${mock.port}`;
  const ctl = (p, b) => fetch(`${base}/ctl/${p}`, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  const call = (p, body) => fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': 'k' },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ code: r.status, body: await r.json() }));
  const read = async () => V.statusOf((await call('/api/connect')).body);
  const drawn = (s, open = {}) => V.panelParts(s, { presets: PRESETS, open }).map(p => p.html).join('');
  const cns = (s, k, open) => buttons(part(drawn(s, open), k)).map(b => b.cn);
  try {
    // signed in through the tool, git using it: Sign out alone
    await ctl('scenario', { name: 'connect-gh-signed' });
    let s = await read();
    assert.deepEqual([s.github.agentsUseIt, s.github.sentence, cns(s, 'gh-signed')], [true, SIGNED_GH, ['gh-signout']]);
    // git not using it: Connect's sentence, with Sign in to GitHub beside Sign out; Sign in then only sets git up
    await ctl('scenario', { name: 'connect-gh-nogit' });
    s = await read();
    assert.deepEqual([s.github.connected, s.github.via, s.github.login, s.github.agentsUseIt, s.github.sentence], [true, 'gh', 'octocat', false, NOT_GIT]);
    assert.deepEqual(await read(), s, 'it holds still');
    assert.deepEqual(cns(s, 'gh-signed'), ['gh-signin', 'gh-signout']);
    let r = await call('/api/connect/github/signin', {});
    assert.deepEqual([r.code, r.body.ok, r.body.sentence, r.body.status.github.agentsUseIt, r.body.status.github.signingIn], [200, true, SIGNED_GH, true, null]);
    assert.equal((await call('/api/connect/github/signin', {})).code, 409, 'git uses it now: nothing to sign in to');
    // Sign out where gh cannot sign out by itself and Terminal cannot open: the command (Connect's), and gh still signed in
    const ghPath = r.body.status.github.ghPath;
    await ctl('mode', { connect: { signout: 'fail' } });
    r = await call('/api/connect/github/signout', {});
    assert.deepEqual([r.code, r.body.ok, r.body.why, r.body.opened, r.body.command, r.body.sentence], [200, false, 'gh', false, `${ghPath} auth logout --hostname github.com`,
      'Workbench could not sign out of GitHub. Run this command in a terminal, then check again.']);
    assert.equal(V.statusOf(r.body).github.connected, true);
    assert.ok(part(drawn(V.statusOf(r.body), { ghCmd: r.body.command }), 'gh-cmd').includes(`>${esc(r.body.command)}</code>`), 'the panel shows it');
    await ctl('mode', { connect: null });
    r = await call('/api/connect/github/signout', {});
    assert.deepEqual([r.body.ok, r.body.opened, V.statusOf(r.body).github.connected], [true, false, false]);
    // signing in again: gh has the sign-in one read before git uses it, and the panel keeps reading until it ends
    r = await call('/api/connect/github/signin', {});
    assert.equal(V.statusOf(r.body).github.signingIn.phase, 'code');
    assert.equal((await read()).github.connected, false);
    s = await read();
    assert.deepEqual([s.github.connected, s.github.agentsUseIt, s.github.sentence, s.github.signingIn.phase], [true, false, NOT_GIT, 'code'], 'gh signed in, git not set up yet');
    assert.equal(V.signingInWaits(s), true);
    assert.deepEqual([part(drawn(s), 'gh-signed'), cns(s, 'gh-off')], ['', ['gh-copy', 'gh-cancel', 'gh-token-toggle']]);
    s = await read();
    assert.deepEqual([s.github.agentsUseIt, s.github.sentence, s.github.signingIn, V.signingInWaits(s)], [true, SIGNED_GH, null, false]);
    // a sign-in where Terminal could not open: Workbench waits, and its status carries the command (Connect's)
    await ctl('scenario', { name: 'connect-gh-command' });
    s = await read();
    const si = s.github.signingIn;
    assert.deepEqual(si, { phase: 'terminal', code: null, url: null, since: si.since, sentence: `Workbench could not open Terminal. ${NO_TERMINAL}`, opened: false,
      command: `${ghPath} auth login --hostname github.com --git-protocol https --web --scopes workflow && ${ghPath} auth setup-git --hostname github.com` });
    assert.deepEqual(await read(), s, 'it holds still');
    assert.ok(part(drawn(s), 'gh-cmd').includes(`>${esc(si.command)}</code>`));
    assert.deepEqual(cns(s, 'gh-off'), ['gh-cancel', 'gh-token-toggle']);
    // and the same through Sign in to GitHub, with no Terminal: { gh: 'terminal', terminal: false }
    await ctl('scenario', { name: 'connect-gh-none' });
    await ctl('mode', { connect: { gh: 'terminal', terminal: false } });
    await call('/api/connect/github/signin', {});
    s = await read();
    assert.deepEqual([s.github.signingIn.phase, s.github.signingIn.opened, s.github.signingIn.command], ['terminal', false, si.command]);
    await read();
    assert.deepEqual([(await read()).github.via, V.signingInWaits(await read())], ['gh', false], 'then signed in');
    await ctl('scenario', { name: 'connect-gh-none' });
    await ctl('mode', { connect: { gh: 'terminal' } });
    await call('/api/connect/github/signin', {});
    s = await read();
    assert.deepEqual([s.github.signingIn.phase, 'opened' in s.github.signingIn, 'command' in s.github.signingIn], ['terminal', false, false], 'Terminal open: no command');
  } finally { await mock.close(); }
});

test('the panel module links (its imports resolve) and touches nothing when it loads', { skip }, async () => {
  const m = await import('../ui/connect.js');
  for (const f of ['setupConnect', 'openConnect', 'closeConnect', 'connectShown', 'connectNeeds']) assert.equal(typeof m[f], 'function', f);
  assert.equal(m.connectShown(), false, 'not set up, not shown');
});

// ---------------------------------------------------------------- markup and colours
test('the panel is a dialog outside both screens; the band’s button is in the top band, hidden until meta.connect says', () => {
  const page = read('../ui/index.html');
  const dialog = page.indexOf('<dialog id="connect"');
  assert.ok(dialog > page.indexOf('</section>', page.indexOf('id="gitScreen"')), 'after the git screen, a child of the body');
  assert.ok(dialog > page.lastIndexOf('</div>', page.indexOf('<section id="gitScreen"')), 'outside the board screen');
  assert.match(page, /<dialog id="connect" aria-labelledby="connectTitle"/);
  assert.match(page, /<h2 id="connectTitle" tabindex="-1">Agents &amp; keys<\/h2>/);
  assert.match(page, /<p id="connectSaid" class="cn-said" role="status" aria-live="polite"><\/p>/);
  const top = page.slice(page.indexOf('<header id="top">'), page.indexOf('</header>', page.indexOf('<header id="top">')));
  assert.match(top, /<button id="connectBtn" type="button" hidden aria-haspopup="dialog" aria-controls="connect"/);
});

test('every colour the panel and its button use clears its minimum on the surface it sits on, in all three looks', () => {
  const css = read('../ui/app.css');
  const pal = palettes(css);
  const resolve = (vars, name, d = 0) => { const v = vars[name]; const m = /^var\(--([\w-]+)\)$/.exec(v || ''); return m && d < 5 ? resolve(vars, m[1], d + 1) : v; };
  const lid = ['lid-1', 'lid-2', 'lid-3'], mask = ['mask-1', 'mask-2', 'mask-3'];
  const pairs = [
    ...lid.flatMap(bg => [['lid-ink', bg, 4.5], ['lid-ink-2', bg, 4.5], ['lid-ink-3', bg, 4.5], ['k-need', bg, 3], ['k-ok', bg, 3], ['k-work', bg, 3], ['k-word', bg, 3], ['lid-focus', bg, 3]]),
    ['field-ink', 'field', 4.5], ['field-ph', 'field', 4.5], ['lid-focus', 'field', 3],
    ['btn-ink', 'btn-1', 4.5], ['btn-ink', 'btn-2', 4.5], ['btn-pri-ink', 'btn-pri', 4.5],
    ['exact-ink', 'exact', 4.5], ['k-need', 'exact', 3],
    ...mask.flatMap(bg => [['silk', bg, 4.5], ['t-ok', bg, 3], ['lit', bg, 3], ['focus', bg, 3]]),
  ];
  const bad = [];
  for (const theme of THEMES) for (const [fg, bg, min] of pairs) {
    const f = resolve(pal[theme], fg), b = resolve(pal[theme], bg);
    const r = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(f || '') && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(b || '') ? ratio(f, b) : 0;
    if (!(r >= min)) bad.push(`${theme}: --${fg} ${f} on --${bg} ${b} is ${r.toFixed(2)}, needs ${min}`);
  }
  assert.deepEqual(bad, []);
  // and scripts/ui-contrast.mjs (with test/ui-contrast.test.mjs) checks every one of them too, at its minimum or more
  const missing = pairs.filter(([fg, bg, min]) => !PAIRS.some(([f, b, , m = 4.5]) => f === fg && b === bg && m >= min)).map(([fg, bg]) => `--${fg} on --${bg}`);
  assert.deepEqual(missing, [], 'pairs the contrast script does not check');
  // the panel's colours come only from the looks: every var() it uses is defined in each look
  const block = css.slice(css.indexOf('Agents & keys: the button in the top band'));
  for (const [, name] of block.matchAll(/var\(--([\w-]+)/g)) {
    if (name.startsWith('l-') || name === 'ease') continue;   // sizes from board.js, and the one easing
    for (const theme of THEMES) assert.ok(pal[theme][name], `--${name} in ${theme}`);
  }
});

test('the panel’s focus rings are the lid’s, which stand out on its surface (never the card’s or the board’s)', () => {
  const css = read('../ui/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
  const mine = rules.filter(r => /:focus/.test(r.sel) && /#connect(?!Btn)|\.cn-/.test(r.sel));
  assert.ok(mine.length >= 3, 'the title, the buttons and links, and the fields');
  for (const r of mine) {
    for (const [, name] of r.body.matchAll(/(?:outline|box-shadow)[^;]*var\(--([\w-]+)\)/g)) assert.equal(name, 'lid-focus', r.sel);
  }
  assert.doesNotMatch(css, /#connect[^{]*\.pop\b|class="pop/, 'not a menu: menus use the card’s focus colour');
  const band = rules.find(r => r.sel === '#connectBtn:focus-visible');
  assert.match(band.body, /var\(--focus\)/, 'the band’s button sits on the board: the board’s ring');
});

test('nothing in the panel moves while a sign-in waits: its marks are still, as everything at rest is', () => {
  const css = read('../ui/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = css.slice(css.indexOf('#connectBtn {'));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /\binfinite\b|animation-iteration-count/);
  // the code's well, Open GitHub (a link drawn as a button) and the token form's link use the looks' own colours
  for (const sel of ['#connect .cn-code', '#connect a.cn-btn', '#connect .cn-textbtn', '#connect .cn-row', '#connect .cn-wait']) assert.ok(block.includes(`${sel} {`), sel);
});

test("a new key is for this repository unless it is a model key; the person’s choice wins", () => {
  assert.equal(V.keyScope({}, 'aws', true), 'repo');
  assert.equal(V.keyScope({}, 'stripe', true), 'repo');
  assert.equal(V.keyScope({}, 'custom', true), 'repo');
  assert.equal(V.keyScope({}, 'github', true), 'repo');
  for (const id of ['anthropic', 'openai', 'gemini']) assert.equal(V.keyScope({}, id, true), 'all');
  assert.equal(V.keyScope({ scope: 'all' }, 'aws', true), 'all');
  assert.equal(V.keyScope({ scope: 'repo' }, 'anthropic', true), 'repo');
  assert.equal(V.keyScope({}, 'aws', false), 'all', 'no repository open: only all');
  assert.equal(V.keyScope({ scope: 'repo' }, 'aws', false), 'all');
});
