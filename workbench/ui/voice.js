// Talking instead of typing, with the browser's own speech recognition (Chrome, Edge, Safari).
// Hold the space bar (or tap the microphone) to talk; the words then go through the same path as typing.
// cancel() throws away what was heard: used for Esc, and when the window loses focus while listening.
// `heard` is where the words heard so far show: one element, or several (the board's input and the git screen's band).
// onListening(on, words) is told when listening starts, and when it ends with the words it will send ('' when nothing
// was heard or it was thrown away); onFinal(words) then gets them. Words that are only filler ("um", "uh": `onlyFiller`,
// from /shared/filler.mjs, passed in so this module imports nothing) send nothing, as when the browser heard no speech:
// onNotice('Nothing heard.', 2500) says so for a moment.

/** How long "Nothing heard." stays under the board, in ms: a moment. */
const NOTHING_HEARD_MS = 2500;

export function setupVoice({ mic, heard, onListening, onFinal, onNotice, onlyFiller = () => false }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    mic.setAttribute('aria-disabled', 'true');
    mic.title = 'Voice needs Chrome, Edge or Safari. You can type instead.';
    mic.addEventListener('click', () => onNotice('Voice is not available in this browser. Type instead.'));
    return { available: false, start() { onNotice('Voice is not available in this browser. Type instead.'); }, stop() {}, cancel() {}, get listening() { return false; } };
  }
  mic.title = 'Talk (or hold the space bar). Your browser turns speech into text.';
  const places = [].concat(heard).filter(Boolean);
  const show = t => { for (const p of places) if (p.textContent !== t) p.textContent = t; };
  let rec = null, finalText = '', heardText = '', discard = false;

  function setListening(on, words = '') {
    mic.setAttribute('aria-pressed', String(on));
    mic.setAttribute('aria-label', on ? 'Stop listening' : 'Talk');
    onListening(on, words);
  }

  function start({ hold = false } = {}) {
    if (rec) return;
    let told = false;
    try { told = sessionStorage.getItem('wb-voice-told') === '1'; } catch { told = false; }
    if (!told) {
      onNotice('Voice uses your browser’s speech service, which may send the audio to its provider.');
      try { sessionStorage.setItem('wb-voice-told', '1'); } catch { /* fine */ }
    }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = hold;          // holding the key: keep listening until it is released
    rec.maxAlternatives = 1;
    finalText = ''; heardText = ''; discard = false;
    show('');
    setListening(true);
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      heardText = (finalText + ' ' + interim).trim();
      show(heardText);
    };
    rec.onerror = e => {
      if (e.error === 'no-speech') { onNotice('Nothing heard.', NOTHING_HEARD_MS); return; }
      const why = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'The microphone is blocked. Allow it in the browser to talk.'
        : e.error === 'aborted' ? '' : 'Voice stopped: ' + e.error + '.';
      if (why) onNotice(why);
    };
    rec.onend = () => {
      const said = discard ? '' : (finalText || heardText || '').trim();
      const filler = !!said && onlyFiller(said); // "um", "uh": nothing to send
      const text = filler ? '' : said;
      rec = null;
      heardText = '';
      show('');
      setListening(false, text);
      if (text) onFinal(text);
      else if (filler) onNotice('Nothing heard.', NOTHING_HEARD_MS);
    };
    try { rec.start(); } catch { rec = null; setListening(false); onNotice('Voice could not start.'); }
  }

  /** Stop and send what was heard. */
  function stop() { if (rec) rec.stop(); }
  /** Stop and throw away what was heard. */
  function cancel() { if (rec) { discard = true; try { rec.abort(); } catch { rec.stop(); } } }

  mic.addEventListener('click', () => { if (rec) stop(); else start(); });
  return { available: true, start, stop, cancel, get listening() { return !!rec; } };
}
