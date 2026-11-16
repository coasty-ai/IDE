// The page's file view calls (ui/api.js): the engine's refusal comes back as data, its reply word for word, whatever its
// 4xx code; a 401 is the stale key's; no answer at all, and anything else, is an Error in plain words. The addresses
// carry what was asked, encoded, and never the page's key, which goes in a header. fetch is a stand-in: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, whenRefused } from '../ui/api.js';

/** Answer every fetch with `status` and `body` (or throw, for no answer), and keep what was asked. */
function stub(status, body) {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url, init });
    if (status === null) throw new TypeError('Failed to fetch');
    return { status, ok: status >= 200 && status < 300, json: async () => (body === undefined ? Promise.reject(new SyntaxError('no JSON')) : body) };
  };
  return asked;
}

test('a refusal comes back as data, its reply word for word, even when it names a "token" or "fetch"', async () => {
  const reply = 'config/token-fetch.js changed on disk since it was opened, so nothing was written.';
  stub(409, { ok: false, reply, why: 'changed', hash: 'a'.repeat(64) });
  assert.deepEqual(await api.saveFile('you', 'config/token-fetch.js', { text: 'x\n', hash: 'b'.repeat(64) }), { ok: false, reply, why: 'changed', status: 409, hash: 'a'.repeat(64) });
  stub(404, { ok: false, reply: 'I can’t find that agent.', why: 'gone' });
  assert.deepEqual(await api.file('nobody', 'a.ts'), { ok: false, reply: 'I can’t find that agent.', why: 'gone', status: 404 });
  stub(400, { ok: false, reply: 'Type at least two characters to search for.', why: 'refused' });
  assert.equal((await api.search('you', 'x')).reply, 'Type at least two characters to search for.');
  stub(413, { ok: false, reply: 'The text is larger than 1 MB, so Workbench did not save it.', why: 'refused' });
  assert.equal((await api.saveFile('you', 'a', { text: '', hash: 'c' })).why, 'refused');
  stub(400, { ok: false, reply: 'x', why: 'something new' });
  assert.equal((await api.file('you', 'a')).why, 'refused', 'a why it does not know reads as refused');
});

test('what was asked is in the address, encoded; the key is in a header; a save is a JSON body, force only when asked', async () => {
  let asked = stub(200, { ok: true, same: true });
  await api.file('a1b2', 'src/a b/ü&x.ts', { check: 'f00' });
  assert.equal(asked[0].url, '/api/file?in=a1b2&path=src%2Fa%20b%2F%C3%BC%26x.ts&check=f00');
  assert.ok('X-Workbench-Token' in asked[0].init.headers);
  assert.doesNotMatch(asked[0].url, /[?&]t=/, 'never the key in the address');
  asked = stub(200, { ok: true, files: [] });
  await api.files('you');
  assert.equal(asked[0].url, '/api/files?in=you');
  asked = stub(200, { ok: true, results: [] });
  await api.search('you', 'big total');
  assert.equal(asked[0].url, '/api/search?in=you&q=big%20total');
  asked = stub(200, { ok: true, hash: 'h', size: 2 });
  assert.deepEqual(await api.saveFile('you', 'a.ts', { text: 'x\n', hash: 'h0' }), { ok: true, hash: 'h', size: 2 });
  assert.equal(asked[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(asked[0].init.body), { in: 'you', path: 'a.ts', text: 'x\n', hash: 'h0' });
  asked = stub(200, { ok: true, hash: 'h', size: 2 });
  await api.saveFile('you', 'a.ts', { text: 'x\n', hash: 'h1', force: true });
  assert.equal(JSON.parse(asked[0].init.body).force, true);
});

test('a stale key, an error and no answer at all are Errors in plain words', async () => {
  let refused = 0;
  whenRefused(() => { refused++; });
  stub(401, { error: 'Missing or wrong token.' });
  await assert.rejects(api.files('you'), e => e.status === 401 && /key no longer works/.test(e.message) && !/token/i.test(e.message));
  assert.equal(refused, 1, 'the page learns its key is stale');
  stub(500, { error: 'Something went wrong in the workbench. The details are in its log.' });
  await assert.rejects(api.file('you', 'a'), e => e.status === 500 && e.message === 'Something went wrong in the workbench. The details are in its log.');
  stub(null);
  await assert.rejects(api.search('you', 'ab'), e => /isn’t answering/.test(e.message));
  stub(200, undefined);
  await assert.rejects(api.files('you'), e => e.status === 200, 'an answer that is not JSON is not a list of files');
});
