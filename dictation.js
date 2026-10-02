'use strict';
window.InklingDictation = (() => {
  let stream, recorder, timeout, ticker, controller, recordingBlob;
  let token = 0, phase = 'idle', transcript = '', error = '', started = 0;
  const supported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));
  const notify = () => document.dispatchEvent(new Event('dictationchange'));
  const cleanup = () => {
    clearTimeout(timeout); clearInterval(ticker);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
  };
  function cancel() {
    ++token; controller?.abort(); controller = null;
    if (recorder) { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); }
    recorder = null; cleanup(); recordingBlob = null;
    phase = 'idle'; transcript = ''; error = ''; notify();
  }
  async function wav(blob) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await audioContext.decodeAudioData(await blob.arrayBuffer());
      const bytes = new ArrayBuffer(44 + audio.length * 2), view = new DataView(bytes);
      const label = (offset, text) => [...text].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
      label(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); label(8, 'WAVE');
      label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, audio.length * 2, true);
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      for (let i = 0; i < audio.length; i++) {
        const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length));
        view.setInt16(44 + i * 2, sample * (sample < 0 ? 32768 : 32767), true);
      }
      return new Blob([bytes], { type: 'audio/wav' });
    } finally { await audioContext.close(); }
  }
  const base64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
  });
  async function transcribe(run, callback) {
    phase = 'transcribing'; error = ''; notify();
    controller = new AbortController();
    timeout = setTimeout(() => controller?.abort(), 60000);
    try {
      const audio = await wav(recordingBlob);
      if (run !== token) return;
      if (audio.size > 15 * 1024 * 1024) throw Error('錄音太大，請縮短內容再試。');
      const data = await base64(audio);
      if (run !== token) return;
      const result = await callback(data, controller.signal);
      if (run !== token) return;
      if (!result.trim()) throw Error('沒有辨識到說話內容，請重新錄音。');
      transcript = result.trim(); phase = 'review'; recordingBlob = null;
    } catch (e) {
      if (run !== token) return;
      error = e.name === 'AbortError' ? '轉文字逾時，請重試。' : e.userMessage || e.message || '無法轉成文字，請重試。';
      phase = 'error';
    } finally {
      if (run === token) { clearTimeout(timeout); controller = null; notify(); }
    }
  }
  async function start(callback) {
    if (!supported || ['preparing', 'recording', 'transcribing'].includes(phase)) return;
    cancel(); const run = token;
    phase = 'preparing'; notify();
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== token) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      const parts = [];
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      recorder.onerror = () => { cancel(); phase = 'error'; error = '錄音中斷，請重新錄音。'; notify(); };
      recorder.onstop = () => {
        cleanup();
        if (run !== token) return;
        recordingBlob = new Blob(parts, { type: recorder.mimeType }); recorder = null;
        if (!recordingBlob.size) { phase = 'error'; error = '沒有錄到聲音，請重新錄音。'; notify(); return; }
        transcribe(run, callback);
      };
      recorder.start(); started = Date.now(); phase = 'recording'; notify();
      ticker = setInterval(notify, 1000);
      timeout = setTimeout(stop, 60000);
    } catch (e) {
      if (run !== token) return;
      cleanup(); phase = 'error';
      error = e.name === 'NotAllowedError' ? '麥克風未獲授權，請在瀏覽器允許麥克風後再試。'
        : e.name === 'NotFoundError' ? '找不到麥克風，請確認裝置已連接。' : '無法開始錄音，請確認麥克風與瀏覽器權限。';
      notify();
    }
  }
  function stop() { if (phase === 'recording' && recorder?.state !== 'inactive') recorder.stop(); }
  function retry(callback) { if (recordingBlob && phase === 'error') transcribe(token, callback); }
  window.addEventListener('pagehide', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden && phase === 'recording') stop(); });
  return { start, stop, cancel, retry, supported, edit(text) { transcript = text; },
    get state() { return { phase, transcript, error, seconds: Math.floor((Date.now() - started) / 1000), retry: !!recordingBlob, busy: ['preparing', 'recording', 'transcribing'].includes(phase) }; },
  };
})();
