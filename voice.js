'use strict';
// AudioContext is unlocked in the original click, before asynchronous model loading.
window.InklingVoice = (() => {
  let worker, context, source, timer;
  let serial = 0, current = 0, currentText = '';
  const bar = () => document.getElementById('voice-player');
  const status = (message) => {
    bar().hidden = false;
    document.getElementById('voice-status').textContent = message;
  };
  function stop() {
    current = 0;
    currentText = '';
    clearTimeout(timer);
    if (source) { source.onended = null; source.stop(); source = null; }
    window.speechSynthesis?.cancel();
    worker?.postMessage({ type: 'stop' });
    bar().hidden = true;
  }
  function fail() {
    stop();
    worker?.terminate(); worker = null;
    status('自然語音載入失敗。請連線後重試，或在設定選擇裝置語音。');
  }
  function watchdog() {
    clearTimeout(timer);
    timer = setTimeout(fail, 180000);
  }
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('voice-worker.js');
    worker.onerror = fail;
    worker.onmessage = ({ data }) => {
      if (data.id !== current) return;
      watchdog();
      if (data.type === 'progress') status(data.message);
      if (data.type === 'error') fail();
      if (data.type === 'done') stop();
      if (data.type === 'audio') {
        try {
          const buffer = context.createBuffer(1, data.samples.length, data.sampleRate);
          buffer.copyToChannel(data.samples, 0);
          source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          const id = current;
          source.onended = () => {
            source = null;
            if (current === id) worker?.postMessage({ type: 'consumed', id });
          };
          source.start();
          status('正在朗讀…');
        } catch { fail(); }
      }
    };
    return worker;
  }
  async function speak(text, settings) {
    text = String(text || '').trim();
    if (!text) return;
    const same = current && currentText === text;
    stop();
    if (same) return;
    const id = ++serial;
    current = id; currentText = text;
    const speed = ['0.85', '1', '1.15'].includes(String(settings.voiceSpeed)) ? Number(settings.voiceSpeed) : 1;
    if (settings.voiceEngine === 'device') {
      if (!window.speechSynthesis) { stop(); status('這個瀏覽器不支援裝置語音，請改用自然語音。'); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US'; utterance.rate = speed;
      utterance.voice = speechSynthesis.getVoices().find(v => v.lang === 'en-US') || null;
      utterance.onend = () => { if (current === id) stop(); };
      utterance.onerror = () => { if (current === id) { stop(); status('裝置語音無法播放，請重試或改用自然語音。'); } };
      status('正在使用裝置語音朗讀…');
      speechSynthesis.speak(utterance);
      return;
    }
    status('正在準備自然語音；首次使用需下載模型，請稍候…');
    try {
      context ||= new (window.AudioContext || window.webkitAudioContext)();
      await context.resume();
      if (current !== id) return;
      watchdog();
      getWorker().postMessage({ type: 'speak', id, text, voice: settings.voice, speed });
    } catch { if (current === id) fail(); }
  }
  window.addEventListener('pagehide', stop);
  return { speak, stop };
})();
