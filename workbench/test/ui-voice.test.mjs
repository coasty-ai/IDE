// Hold to talk (ui/voice.js), with a stand-in for the browser's speech recognition: the words heard show in every place
// given (the board's input and the git screen's band), and the end of a session says what it will send: the words, or
// nothing when it heard nothing or they were thrown away (Esc, the window losing focus). The page keys its bindings on
// that: a session that heard nothing leaves none behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupVoice } from '../ui/voice.js';

class FakeSR {
  static last = null;
  constructor() { FakeSR.last = this; }
  start() {}
  stop() { this.onend && this.onend(); }
  abort() { this.onerror && this.onerror({ error: 'aborted' }); this.onend && this.onend(); }
  hear(text, isFinal = true) { this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] }); }
}
const store = new Map();
globalThis.window = { SpeechRecognition: FakeSR };
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } });
const el = () => { const attrs = {}; return { textContent: '', title: '', setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: k => attrs[k], addEventListener() {} }; };

function talk() {
  const log = [], board = el(), git = el();
  const v = setupVoice({ mic: el(), heard: [board, git], onListening: (on, words) => log.push(['listening', on, words]), onFinal: t => log.push(['final', t]), onNotice: t => log.push(['notice', t]) });
  return { v, log, board, git };
}

test('the words heard so far show in every place given, and go when listening ends', () => {
  const { v, board, git } = talk();
  v.start({ hold: true });
  FakeSR.last.hear('merge it', false);
  assert.equal(board.textContent, 'merge it');
  assert.equal(git.textContent, 'merge it');
  v.stop();
  assert.equal(board.textContent, '');
  assert.equal(git.textContent, '');
});

test('the end of a session says what it will send, and then sends it', () => {
  const { v, log } = talk();
  v.start({ hold: true });
  FakeSR.last.hear('what changed');
  v.stop();
  const end = log.filter(x => x[0] !== 'notice');
  assert.deepEqual(end, [['listening', true, ''], ['listening', false, 'what changed'], ['final', 'what changed']]);
});

test('a session that heard nothing, or whose words were thrown away, ends with nothing and sends nothing', () => {
  let t = talk();
  t.v.start({ hold: true });
  t.v.stop();
  assert.deepEqual(t.log.filter(x => x[0] !== 'notice'), [['listening', true, ''], ['listening', false, '']]);
  t = talk();
  t.v.start({ hold: true });
  FakeSR.last.hear('yes');
  t.v.cancel();
  assert.deepEqual(t.log.filter(x => x[0] !== 'notice'), [['listening', true, ''], ['listening', false, '']]);
  assert.equal(t.v.listening, false);
});
