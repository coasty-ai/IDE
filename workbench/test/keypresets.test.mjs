// The kinds of key a person can add (src/shared/keypresets.mjs): the presets, presetById and signInVariables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { KEY_PRESETS, presetById, signInVariables, ANTHROPIC_KEY_NOTE } from '../src/shared/keypresets.mjs';
import { NAME_RE, forbiddenName } from '../src/core/keys.mjs';

const AGENT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const names = (p) => p.fields.flatMap(f => [f.name, ...(f.also || [])]);

test('the presets, as the spec lists them: variables, which are secret, which are optional, and who they suit', () => {
  const table = Object.fromEntries(KEY_PRESETS.map(p => [p.id, {
    fields: p.fields.map(f => [f.name, f.secret ? 'secret' : 'not secret', f.optional ? 'optional' : 'required', ...(f.also ? [`also ${f.also.join(' ')}`] : [])]),
    agents: p.agents,
  }]));
  assert.deepEqual(table, {
    anthropic: { fields: [['ANTHROPIC_API_KEY', 'secret', 'required']], agents: ['claude'] },
    openai: { fields: [['OPENAI_API_KEY', 'secret', 'required', 'also CODEX_API_KEY']], agents: ['codex'] },
    gemini: { fields: [['GEMINI_API_KEY', 'secret', 'required']], agents: 'all' },
    aws: { fields: [['AWS_ACCESS_KEY_ID', 'secret', 'required'], ['AWS_SECRET_ACCESS_KEY', 'secret', 'required'],
      ['AWS_SESSION_TOKEN', 'secret', 'optional'], ['AWS_REGION', 'not secret', 'optional']], agents: 'all' },
    'google-cloud': { fields: [['GOOGLE_CLOUD_PROJECT', 'not secret', 'required'], ['GOOGLE_API_KEY', 'secret', 'optional']], agents: 'all' },
    azure: { fields: [['AZURE_CLIENT_ID', 'not secret', 'required'], ['AZURE_CLIENT_SECRET', 'secret', 'required'],
      ['AZURE_TENANT_ID', 'not secret', 'required'], ['AZURE_SUBSCRIPTION_ID', 'not secret', 'optional']], agents: 'all' },
    github: { fields: [['GH_TOKEN', 'secret', 'required', 'also GITHUB_TOKEN']], agents: 'all' },
    stripe: { fields: [['STRIPE_SECRET_KEY', 'secret', 'required']], agents: 'all' },
    custom: { fields: [], agents: 'all' },
  });
});

test('every preset has the shape the page builds its form from', () => {
  const ids = new Set();
  for (const p of KEY_PRESETS) {
    assert.deepEqual(Object.keys(p).sort(), ['agents', 'fields', 'id', 'label', 'link', 'note'], p.id);
    assert.match(p.id, /^[a-z][a-z-]*$/);
    assert.ok(!ids.has(p.id), `${p.id} once`);
    ids.add(p.id);
    assert.ok(typeof p.label === 'string' && p.label.length > 0 && p.label.length <= 80, `${p.id} label`);
    assert.ok(p.agents === 'all' || (Array.isArray(p.agents) && p.agents.every(a => AGENT_ID.test(a))), `${p.id} agents`);
    assert.ok(p.note === null || (typeof p.note === 'string' && /^[A-Z].*\.$/.test(p.note)), `${p.id} note is a sentence or null`);
    assert.ok(p.link === null || (typeof p.link === 'string' && new URL(p.link).protocol === 'https:'), `${p.id} link is https or null`);
    for (const f of p.fields) {
      const keys = Object.keys(f).sort();
      assert.ok(['label,name,optional,secret', 'also,label,name,optional,secret'].includes(keys.join(',')), `${p.id} ${f.name} fields`);
      assert.equal(typeof f.secret, 'boolean');
      assert.equal(typeof f.optional, 'boolean');
      assert.ok(typeof f.label === 'string' && f.label.length > 0);
    }
    assert.ok(p.fields.some(f => !f.optional) || p.id === 'custom', `${p.id} asks for something`);
    const all = names(p);
    assert.equal(new Set(all).size, all.length, `${p.id} names a variable once`);
  }
});

test('every variable a preset sets is one the key store accepts', () => {
  for (const p of KEY_PRESETS) {
    for (const name of names(p)) {
      assert.match(name, NAME_RE, name);
      assert.equal(forbiddenName(name), null, `${name} is not refused`);
    }
  }
});

test('the notes and the link the spec gives', () => {
  assert.equal(presetById('anthropic').note, 'Claude Code will use this key instead of your Claude subscription, and each request is billed to the key.');
  assert.equal(presetById('anthropic').note, ANTHROPIC_KEY_NOTE);
  assert.equal(presetById('aws').note, 'Give agents a key that can do only what their work needs, never your root or admin keys.');
  assert.equal(presetById('github').note, 'Copilot CLI may sign in with it.');
  assert.equal(presetById('github').link, 'https://github.com/settings/tokens/new?description=Workbench&scopes=repo');
});

test('presetById finds a preset, or null', () => {
  for (const p of KEY_PRESETS) assert.equal(presetById(p.id), p);
  for (const x of ['nope', '', null, undefined, 'AWS', 'constructor', '__proto__']) assert.equal(presetById(x), null, String(x));
  assert.deepEqual(presetById('custom').fields, []);
});

test('signInVariables: NAME → { agents, sentence }, for the variables an agent’s own sign-in reads', () => {
  assert.ok(Object.keys(signInVariables).length >= 10);
  for (const [name, v] of Object.entries(signInVariables)) {
    assert.match(name, NAME_RE);
    assert.deepEqual(Object.keys(v).sort(), ['agents', 'sentence'], name);
    assert.ok(Array.isArray(v.agents) && v.agents.length && v.agents.every(a => AGENT_ID.test(a)), `${name} agents`);
    assert.ok(v.sentence.includes(name) && /^[A-Z].*\.$/.test(v.sentence), `${name} sentence names it`);
  }
  assert.deepEqual(signInVariables.ANTHROPIC_API_KEY.agents, ['claude']);
  assert.match(signInVariables.ANTHROPIC_API_KEY.sentence, /instead of your Claude subscription/);
  assert.ok(signInVariables.CODEX_API_KEY.agents.includes('codex'));
  assert.ok(signInVariables.GITHUB_TOKEN.sentence.startsWith('Copilot CLI may sign in with'));
  assert.ok(signInVariables.GH_TOKEN && signInVariables.GEMINI_API_KEY && signInVariables.CLAUDE_CODE_USE_BEDROCK);
  // A preset that sets one of these is one the panel warns about.
  assert.ok(names(presetById('anthropic')).some(n => n in signInVariables));
  assert.ok(names(presetById('github')).every(n => n in signInVariables));
  assert.ok(!names(presetById('aws')).some(n => n in signInVariables), 'AWS keys alone do not move Claude Code to Bedrock');
});

test('the presets cannot be changed by the page', () => {
  assert.ok(Object.isFrozen(KEY_PRESETS) && Object.isFrozen(signInVariables));
  for (const p of KEY_PRESETS) {
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.fields) && p.fields.every(Object.isFrozen), p.id);
    if (Array.isArray(p.agents)) assert.ok(Object.isFrozen(p.agents));
  }
  for (const v of Object.values(signInVariables)) assert.ok(Object.isFrozen(v) && Object.isFrozen(v.agents));
});

test('keypresets.mjs is pure: the page loads it as it is', () => {
  const text = fs.readFileSync(new URL('../src/shared/keypresets.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(text) && !/import\(\s*['"]node:/.test(text), 'no node: imports');
  assert.ok(!/^import /m.test(text), 'imports nothing at all');
  assert.ok(!/\b(?:Buffer|process|require)\b/.test(text.replace(/\/\/.*$/gm, '')), 'nothing only Node has');
});
