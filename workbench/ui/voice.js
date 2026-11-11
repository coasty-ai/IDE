// Talking instead of typing, with the browser's own speech recognition (Chrome, Edge, Safari).
// Hold the space bar (or tap the microphone) to talk; the words then go through the same path as typing.
// While listening, the centre's ring follows the loudness of your voice.

async function startMeter(onLevel) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0, smooth = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      smooth = smooth * 0.7 + level * 0.3;
      onLevel(smooth);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => { cancelAnimationFrame(raf); stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); onLevel(0); };
  } catch {
    return () => onLevel(0);
  }
}

export function setupVoice({ mic, host, heard, onFinal, onNotice, onLevel }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    mic.setAttribute('aria-disabled', 'true');
    mic.title = 'Voice needs Chrome, Edge or Safari. You can type instead.';
    mic.addEventListener('click', () => onNotice('Voice is not available in this browser. Type instead.'));
    return { available: false, start() { onNotice('Voice is not available in this browser. Type instead.'); }, stop() {} };
  }
  mic.title = 'Talk (or hold the space bar). Your browser turns speech into text.';
  let rec = null;
  let finalText = '';
  let stopMeter = null;

  function setListening(on) {
    host.classList.toggle('listening', on);
    mic.setAttribute('aria-pressed', String(on));
    mic.setAttribute('aria-label', on ? 'Stop listening' : 'Talk');
  }

  function start({ hold = false } = {}) {
    if (rec) return;
    let told = false;
    try { told = sessionStorage.getItem('wb-voice-told') === '1'; } catch {}
    if (!told) {
      onNotice('Voice uses your browser’s speech service, which may send the audio to its provider.');
      try { sessionStorage.setItem('wb-voice-told', '1'); } catch {}
    }
    rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = hold;          // holding the key: keep listening until it is released
    rec.maxAlternatives = 1;
    finalText = '';
    heard.textContent = '';
    setListening(true);
    startMeter(onLevel).then(stop => { if (rec) stopMeter = stop; else stop(); });
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      heard.textContent = (finalText + ' ' + interim).trim();
    };
    rec.onerror = e => {
      const why = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'The microphone is blocked. Allow it in the browser to talk.'
        : e.error === 'no-speech' ? 'I did not hear anything.'
        : e.error === 'aborted' ? '' : 'Voice stopped: ' + e.error + '.';
      if (why) onNotice(why);
    };
    rec.onend = () => {
      const text = (finalText || heard.textContent || '').trim();
      rec = null;
      if (stopMeter) { stopMeter(); stopMeter = null; }
      setListening(false);
      if (text) onFinal(text);
    };
    try { rec.start(); } catch { rec = null; setListening(false); onNotice('Voice could not start.'); }
  }

  function stop() { if (rec) rec.stop(); }

  mic.addEventListener('click', () => { if (rec) stop(); else start(); });
  return { available: true, start, stop, get listening() { return !!rec; } };
}
