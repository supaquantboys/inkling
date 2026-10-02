'use strict';
// AudioContext is unlocked in the original click, before asynchronous model loading.
window.InklingVoice = (() => {
  let worker, context, source, timer;
  const preparations = new Map();
  let preloadStatus = '正在預載自然語音…';
  let preloadPhase = 'idle', preloadPromise, finishPreload, preloadVoice;
  const touchPreparation = (id, pending) => {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => { preparations.delete(id); pending.resolve(false); }, 180000);
  };
  const preloadUpdate = (message) => {
    preloadStatus = message;
    const el = document.getElementById('voice-preload-status');
    if (el) el.textContent = message;
  };
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
    for (const pending of preparations.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    preparations.clear();
    preloadPhase = 'failed'; finishPreload?.(false); finishPreload = null; preloadPromise = null;
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
    worker.onerror = () => {
      if (current || preparations.size) fail();
      else { worker?.terminate(); worker = null; preloadPhase = 'failed'; finishPreload?.(false); finishPreload = null; preloadPromise = null; preloadUpdate('語音預載失敗，連線恢復後會重試。'); }
    };
    worker.onmessage = ({ data }) => {
      if (data.type.startsWith('prepare-')) {
        const pending = preparations.get(data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (data.type === 'prepare-progress') {
          pending.progress?.(data.completed, data.total);
          touchPreparation(data.id, pending);
        } else { preparations.delete(data.id); pending.resolve(data.type === 'prepare-ready'); }
        return;
      }
      if (data.type === 'preload-progress') {
        preloadUpdate(data.message);
        for (const [id, pending] of preparations) touchPreparation(id, pending);
        return;
      }
      if (data.type === 'preload-ready') {
        preloadPhase = 'ready'; preloadUpdate('自然語音已準備好');
        finishPreload?.(true); finishPreload = null; return;
      }
      if (data.type === 'preload-error') {
        preloadPhase = 'failed'; preloadUpdate('語音預載失敗，連線恢復後會重試。');
        finishPreload?.(false); finishPreload = null; preloadPromise = null; return;
      }
      if (!current || data.id !== current) return;
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
          status(data.cached ? '正在播放已快取的語音…' : '正在朗讀…');
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
    status('準備播放…');
    try {
      context ||= new (window.AudioContext || window.webkitAudioContext)();
      await context.resume();
      if (current !== id) return;
      watchdog();
      getWorker().postMessage({ type: 'speak', id, text, voice: settings.voice, speed });
    } catch { if (current === id) fail(); }
  }
  window.addEventListener('pagehide', stop);
  function prepare(texts, settings, progress) {
    if (settings.voiceEngine === 'device') return Promise.resolve(true);
    const id = ++serial;
    return new Promise(resolve => {
      const pending = { resolve, progress, timer: setTimeout(() => { preparations.delete(id); resolve(false); }, 180000) };
      preparations.set(id, pending);
      try {
        getWorker().postMessage({ type: 'prepare', id, texts: texts.filter(Boolean), voice: settings.voice,
          speed: ['0.85', '1', '1.15'].includes(String(settings.voiceSpeed)) ? Number(settings.voiceSpeed) : 1 });
      } catch { clearTimeout(pending.timer); preparations.delete(id); resolve(false); }
    });
  }
  function preload(settings = {}) {
    if (settings?.voice) preloadVoice = settings.voice;
    if (preloadPromise) return preloadPromise;
    preloadPhase = 'loading'; preloadUpdate('正在預載自然語音…');
    const promise = new Promise(resolve => { finishPreload = resolve; });
    preloadPromise = promise;
    try { getWorker().postMessage({ type: 'preload', voice: preloadVoice, speed: 1 }); }
    catch {
      preloadPhase = 'failed'; preloadUpdate('語音預載失敗，連線恢復後會重試。');
      finishPreload?.(false); finishPreload = null; preloadPromise = null;
    }
    return promise;
  }
  function clearCache() {
    stop();
    try { getWorker().postMessage({ type: 'clear-cache' }); } catch {}
  }
  return { speak, stop, prepare, preload, clearCache, get preloadStatus() { return preloadStatus; }, get ready() { return preloadPhase === 'ready'; } };
})();
// Start before app rendering and AI work; use the saved voice for warmup.
try { InklingVoice.preload(JSON.parse(localStorage.getItem('inkling.settings') || '{}')); }
catch { InklingVoice.preload(); }
window.addEventListener('online', () => InklingVoice.preload());
