// What looks like a key (src/shared/secretshape.mjs): the page and the engine refuse to send such text to an agent.
// Every key-shaped string here is built from parts at run time, so no secret scanner mistakes this file for a leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { looksLikeSecret } from '../src/shared/secretshape.mjs';

const join = (...parts) => parts.join('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE64 = `${ALNUM}+/`;
const HEX = '0123456789abcdef';
/** The same "random" text on every run: characters picked by SHA-256 of a seed. */
function randomish(n, seed, alphabet = ALNUM) {
  let out = '';
  for (let i = 0; out.length < n; i++) {
    for (const b of crypto.createHash('sha256').update(`${seed}:${i}`).digest()) {
      if (out.length < n) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

const shapes = {
  anthropic: join('sk', '-ant-', 'api03-', randomish(60, 'a', `${ALNUM}_-`)),
  openaiProject: join('sk', '-proj-', randomish(48, 'b', `${ALNUM}_-`)),
  openaiLegacy: join('sk', '-', randomish(40, 'c'), '7'),
  aws: join('AK', 'IA', randomish(16, 'd', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  awsSession: join('AS', 'IA', randomish(16, 'e', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  github: join('gh', 'p_', randomish(36, 'f')),
  githubOauth: join('gh', 'o_', randomish(36, 'g')),
  githubServer: join('gh', 's_', randomish(36, 'h')),
  githubFine: join('github', '_pat_', randomish(22, 'i'), '_', randomish(59, 'j')),
  slack: join('xo', 'xb-', '1234567890', '12-', '12345678901', '23-', randomish(24, 'k')),
  stripe: join('sk', '_live_', randomish(24, 'l')),
  stripeRestricted: join('rk', '_live_', randomish(24, 'm')),
  privateKey: join('-----BEGIN ', 'RSA PRI', 'VATE KEY-----\n', randomish(64, 'n', BASE64)),
  openssh: join('-----BEGIN ', 'OPENSSH PRI', 'VATE KEY-----'),
  jwt: join('ey', 'JhbGciOiJIUzI1', 'NiIsInR5cCI6IkpXVCJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', randomish(43, 'o', `${ALNUM}_-`)),
};
const KINDS = {
  anthropic: 'anthropic', openaiProject: 'openai', openaiLegacy: 'openai', aws: 'aws', awsSession: 'aws', github: 'github',
  githubOauth: 'github', githubServer: 'github', githubFine: 'github', slack: 'slack', stripe: 'stripe',
  stripeRestricted: 'stripe', privateKey: 'private-key', openssh: 'private-key', jwt: 'jwt',
};

test('known shapes are keys, alone, in a sentence, after NAME=, in quotes and in a link', () => {
  for (const [name, key] of Object.entries(shapes)) {
    const kind = KINDS[name];
    for (const text of [key, `please use ${key} for the deploy`, `export SOME_KEY=${key}`, `"${key}"`, `'${key}',`,
      `https://example.com/callback?token=${key}&next=1`, `(${key})`, `Bearer ${key}`]) {
      assert.deepEqual(looksLikeSecret(text), { secret: true, kind }, `${name} in: ${text.slice(0, 30)}…`);
    }
  }
});

test('a long random word of base64 or hex is a key', () => {
  for (const [i, word] of [randomish(40, 'p', BASE64), randomish(64, 'q', BASE64), randomish(32, 'r', HEX), randomish(64, 's', HEX),
    randomish(48, 't'), join(randomish(20, 'u'), '/', randomish(19, 'v'), '+')].entries()) {
    assert.deepEqual(looksLikeSecret(`the key is ${word}`), { secret: true, kind: 'generic' }, `word ${i}`);
  }
  // Most generated keys, by far: the rule leans towards letting text through, and misses a few.
  let caught = 0;
  for (let i = 0; i < 400; i++) if (looksLikeSecret(randomish(40, `w${i}`)).secret) caught++;
  assert.ok(caught >= 0.92 * 400, `${caught} of 400 random 40-character keys`);
});

test('ordinary sentences and the board’s own words are not keys', () => {
  for (const text of ['fix the login bug', 'Fix the login redirect so users land on /dashboard after signing in.',
    'merge Fix login into main', 'what needs me', 'stop everything', 'throw away Fix login', 'tell Fix login to use the staging database',
    'start an agent', 'work on the checkout page: the total is wrong when a coupon is applied twice', 'help', 'connect github',
    'Run npm test and then fix whatever fails in src/core/engine.mjs', 'continue the agent from yesterday',
    'Rename AbstractSingletonProxyFactoryBean2 to ProxyFactory and update every caller.', '']) {
    assert.deepEqual(looksLikeSecret(text), { secret: false, kind: null }, text);
  }
});

test('paths are not keys', () => {
  for (const text of ['src/components/v2/authentication/LoginForm2.tsx', 'src/components/v2/authentication/LoginForm2',
    '/Users/someone/code/shop/app/src/main/java/com/example/MyApp2/ui/MainActivity.kt', 'workbench/src/adapters/claude/hookBridge2Helper',
    'node_modules/@babel/core/lib/transformation/file/File2.js', 'packages/api/src/routes/v1/UserProfileController3',
    'test/e2e/specs/checkout/PayWithStripe3DS2.spec.ts', 'k8s/overlays/prod-eu1/HPAv2ForAPIGw3/deployment.yaml',
    '/home/someone/.workbench/worktrees/shop-1a2b3c4d/fix-login-a1b2c3/src/App.tsx', 'C:\\Users\\someone\\Projects\\MyApp2\\src\\Program.cs']) {
    assert.equal(looksLikeSecret(`look at ${text}`).secret, false, text);
  }
});

test('commit ids are not keys: 40 hex characters alone, or in a sentence', () => {
  const sha = randomish(40, 'x', HEX);
  for (const text of [sha, `revert ${sha}`, `cherry-pick ${sha} onto main`, `${sha.slice(0, 7)} broke the build`,
    `https://github.com/owner/repo/commit/${sha}`, `git show ${sha}:src/app.js`]) {
    assert.equal(looksLikeSecret(text).secret, false, text);
  }
});

test('long names, links, ids and digests are not keys', () => {
  for (const text of ['AbstractSingletonProxyFactoryBean2', 'XMLHttpRequestEventTarget2ProgressHandler', 'handleUserAuthenticationCallbackV2Async',
    'getS3BucketPolicyForUser2FAInRegionEU1', 'useGetUserProfileQueryV2WithOAuth2', 'TestS3ToGCSOperatorWithKMS2Encryption',
    'K8sPodOperatorXComPushTest2Handler', 'test_handles_UTF8_and_ISO8859_1_in_JSON5', 'QT5WebEngineCore2DRenderPassV3Test',
    'R2D2C3POBB8DroidFactoryMk2TestCase', 'h264ToVP9TranscoderWithOpus48kHz2Ch', 'MP4BoxParserForISOBMFFv2WithAV1Codec',
    'OpenAPI3ToGraphQLSDLv2SchemaMapper', 'TLSv1_3_ECDHE_RSA_AES256_GCM_SHA384', 'antidisestablishmentarianism',
    'Supercalifragilisticexpialidocious', '0f8fad5b-d9cb-469f-a165-70867728950e', 'workbench/fix-login-redirect-a1b2c3',
    'claude-opus-4-5-20251101', 'https://github.com/owner/repo/pull/123', 'https://example.com/a/b/c?x=1&y=two',
    `sha256:${randomish(64, 'y', HEX)}`, `image@sha256:${randomish(64, 'z', HEX)}`, `sha512-${randomish(86, 'A', BASE64)}==`,
    'MY_SERVICE_PRODUCTION_DATABASE_PASSWORD', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.equal(looksLikeSecret(text).secret, false, text);
  }
});

test('a link’s path is not searched for random words: documents and pages are named there by long ids', () => {
  const B64URL = `${ALNUM}-_`;
  for (const text of [`build what this doc says: https://docs.google.com/document/d/${randomish(44, 'C', B64URL)}/edit`,
    `the spec is at https://drive.google.com/file/d/${randomish(33, 'D', B64URL)}/view?usp=sharing`,
    `see https://www.notion.so/Some-Title-${randomish(32, 'E', HEX)}`, `docs.google.com/spreadsheets/d/${randomish(44, 'F', B64URL)}/edit#gid=0`,
    `www.notion.so/${randomish(32, 'G', HEX)}`, `http://localhost:3000/files/${randomish(40, 'H')}`]) {
    assert.equal(looksLikeSecret(text).secret, false, text);
  }
  // A link's query and what comes before its host are still searched, and known shapes are found anywhere.
  assert.equal(looksLikeSecret(`https://example.com/reset?token=${randomish(40, 'I')}`).kind, 'generic');
  assert.equal(looksLikeSecret(`https://deploy:${randomish(40, 'J')}@example.com/repo.git`).kind, 'generic');
  assert.equal(looksLikeSecret(`https://example.com/hooks/${shapes.github}`).kind, 'github');
});

test('a prefix with too little after it is not a key', () => {
  for (const text of ['what is a ghp_ token?', 'use sk-learn for the model', 'the branch sk-improve-error-handling-in-auth',
    join('AK', 'IA'), join('AK', 'IA', 'SHORT'), join('ey', 'J'), 'xoxb- tokens are for bots', 'sk_live_ keys move real money',
    join('-----BEGIN ', 'CERTIFICATE-----'), join('-----BEGIN ', 'PUBLIC KEY-----'), 'risk-free-refactor-of-the-payment-module-2',
    'the task-sk-improve-the-checkout-flow-2 branch']) {
    assert.equal(looksLikeSecret(text).secret, false, text);
  }
  // Inside a word a prefix does not count, though a random word is still a key of no particular kind.
  assert.deepEqual(looksLikeSecret(join('task', '-sk-', randomish(30, 'B'), '1')), { secret: true, kind: 'generic' });
});

test('anything that is not text is not a key', () => {
  for (const x of [undefined, null, 42, {}, ['sk-'], true]) assert.deepEqual(looksLikeSecret(x), { secret: false, kind: null });
});

test('a long paste is checked in good time', () => {
  const text = `${'word '.repeat(40_000)}${'sk-'.repeat(20_000)}${'a'.repeat(50_000)}`;
  const started = Date.now();
  assert.equal(looksLikeSecret(text).secret, false);
  assert.ok(Date.now() - started < 2000, 'checked in under two seconds');
});

test('secretshape.mjs is pure: the page loads it as it is', () => {
  const text = fs.readFileSync(new URL('../src/shared/secretshape.mjs', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(text) && !/import\(\s*['"]node:/.test(text), 'no node: imports');
  assert.ok(!/\b(?:Buffer|process|require)\b/.test(text.replace(/\/\/.*$/gm, '')), 'nothing only Node has');
});
