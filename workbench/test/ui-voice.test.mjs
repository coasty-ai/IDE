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
  const v = setupVoice({ mic: el(), heard: [board, git], onListening: (on, words) => log.push(['listening', on, words]), onFinal: t => log.push(['final', t]),
    onNotice: (t, ms) => log.push(ms ? ['notice', t, ms] : ['notice', t]), onlyFiller: t => /^(?:\s|um|uh|hmm|[.,!?])*$/i.test(t) });
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

test('words heard that are only filler send nothing, and the page says, for a moment, that nothing was heard', () => {
  for (const said of ['um', 'uh, um', 'hmm...']) {
    const t = talk();
    t.v.start({ hold: true });
    FakeSR.last.hear(said);
    t.v.stop();
    assert.deepEqual(t.log.filter(x => x[0] !== 'notice' || x[1] === 'Nothing heard.'), [['listening', true, ''], ['listening', false, ''], ['notice', 'Nothing heard.', 2500]], said);
  }
  // the browser hearing no speech at all says the same
  const t = talk();
  t.v.start({ hold: true });
  FakeSR.last.onerror({ error: 'no-speech' });
  t.v.stop();
  assert.deepEqual(t.log.filter(x => x[0] === 'notice' && x[1] !== 'Voice uses your browser’s speech service, which may send the audio to its provider.'), [['notice', 'Nothing heard.', 2500]]);
  // anything more is said as it was heard, filler and all
  const more = talk();
  more.v.start({ hold: true });
  FakeSR.last.hear('um stop everything');
  more.v.stop();
  assert.deepEqual(more.log.filter(x => x[0] === 'final'), [['final', 'um stop everything']]);
});
