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
import { palettes, ratio, THEMES } from '../scripts/ui-contrast.mjs';

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
  assert.deepEqual(of('claude').map(b => b.label), ['Use an API key', 'Check again']);
  assert.deepEqual(of('codex').map(b => b.label), ['Sign in', 'Use an API key', 'Use for new work', 'Check again'], 'in the panel’s order');
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

test('where Terminal cannot open, the command to run is shown with Copy', () => {
  const h = html(status({ canOpenTerminal: false }), { open: { cmd: { codex: 'codex login' } } });
  assert.match(h, /<code class="cn-cmd"[^>]*>codex login<\/code>/);
  assert.ok(buttons(h).some(b => b.cn === 'copy' && b.agent === 'codex'));
  assert.match(h, /title="Shows the command to run in a terminal\."/);
  assert.match(html(status()), /title="Opens Terminal, where it runs\."/);
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

test('GitHub, not connected: a token field, the box for agents (off), Connect and the page that makes a token', () => {
  const h = html(status());
  assert.match(h, /<h4 class="cn-h4">GitHub<\/h4><p class="cn-line">Not connected\.<\/p>/);
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

test('GitHub, connected: as whom, whether agents get the token, and Disconnect', () => {
  const on = html(status({ github: { connected: true, login: 'octo<cat>', agentsUseIt: true, sentence: '' } }));
  assert.match(on, /Connected to GitHub as octo&lt;cat&gt;\./);
  assert.match(on, /Agents get this token as GH_TOKEN\. Copilot may sign in with it\./);
  assert.ok(buttons(on).some(b => b.cn === 'gh-disconnect'));
  assert.doesNotMatch(on, /data-field="gh-token"/);
  const gitOnly = html(status({ github: { connected: true, login: 'octocat', agentsUseIt: false } }));
  assert.match(gitOnly, /Only git uses this token: agents do not get it\./);
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
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/shop' }, 'shop'), 'for this repository');
  assert.equal(V.scopeWords({ kind: 'repo', root: '/Users/sam/shop/' }, 'other'), 'for the repository shop');
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
  assert.match(V.newKeyRequest({ preset: 'custom', label: 'X', entries: [{ name: '1BAD', value: 'v' }] }, PRESETS).error, /cannot be a variable name/);
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
  const typed = html(s, { open: { git: { name: 'New Name', email: 'new@example.com' }, ghAgents: true } });
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
    assert.deepEqual(sent.map(r => `${r.method} ${r.path}`), [
      'GET /api/connect', 'POST /api/connect/recheck', 'POST /api/connect/agents/codex/install', 'POST /api/connect/agents/claude/signin',
      'POST /api/connect/agents/claude/key', 'POST /api/connect/agents/codex/default', 'POST /api/connect/git', 'POST /api/connect/github',
      'POST /api/connect/github/disconnect', 'POST /api/connect/keys', 'POST /api/connect/keys/k%2F1/remove']);
    assert.deepEqual(sent[4].body, { value });
    assert.deepEqual(sent[7].body, { token: 'gh-token-value', agentsUseIt: true });
    assert.deepEqual(sent[9].body, { preset: 'aws', label: 'AWS', values: { AWS_REGION: 'eu-west-2' }, scope: 'all', agents: 'all' });
    for (const r of sent) { assert.ok(!r.path.includes(value) && !r.path.includes('gh-token-value'), 'values never in an address'); assert.equal(r.headers['Content-Type'], 'application/json'); }
    // a refusal: its sentence and status come back, nothing thrown
    answer = { status: 200, body: { ok: false, sentence: 'GitHub did not accept that token.', status: status() } };
    const r = await api.connectApi.github('x', false);
    assert.equal(r.ok, false);
    assert.equal(r.sentence, 'GitHub did not accept that token.');
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
