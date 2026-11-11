// Talking instead of typing, with the browser's own speech recognition (Chrome, Edge, Safari).
// Hold the space bar (or tap the microphone) to talk; the words then go through the same path as typing.
// cancel() throws away what was heard: used for Esc, and when the window loses focus while listening.

export function setupVoice({ mic, heard, onListening, onFinal, onNotice }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    mic.setAttribute('aria-disabled', 'true');
    mic.title = 'Voice needs Chrome, Edge or Safari. You can type instead.';
    mic.addEventListener('click', () => onNotice('Voice is not available in this browser. Type instead.'));
    return { available: false, start() { onNotice('Voice is not available in this browser. Type instead.'); }, stop() {}, cancel() {}, get listening() { return false; } };
  }
  mic.title = 'Talk (or hold the space bar). Your browser turns speech into text.';
  let rec = null, finalText = '', discard = false;

  function setListening(on) {
    mic.setAttribute('aria-pressed', String(on));
    mic.setAttribute('aria-label', on ? 'Stop listening' : 'Talk');
    onListening(on);
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
    finalText = ''; discard = false;
    heard.textContent = '';
    setListening(true);
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      heard.textContent = (finalText + ' ' + interim).trim();
    };
    rec.onerror = e => {
      const why = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'The microphone is blocked. Allow it in the browser to talk.'
        : e.error === 'no-speech' ? 'I did not hear anything.'
        : e.error === 'aborted' ? '' : 'Voice stopped: ' + e.error + '.';
      if (why) onNotice(why);
    };
    rec.onend = () => {
      const text = discard ? '' : (finalText || heard.textContent || '').trim();
      rec = null;
      heard.textContent = '';
      setListening(false);
      if (text) onFinal(text);
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
