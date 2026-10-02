importScripts('voice-cache.js');
// Pinned browser build; inference and diary text stay on this device.
let modelPromise;
let activeId = 0;
let queue = Promise.resolve();
let releaseAudio;
const send = (id, type, data = {}) => self.postMessage({ id, type, ...data });

async function model() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { KokoroTTS } = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
      return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8', device: 'wasm',
        progress_callback: (p) => {
          const message = {
            message: p.status === 'progress' && Number.isFinite(p.progress)
              ? `下載語音模型：${Math.round(p.progress)}%` : '正在準備語音模型…',
          };
          send(0, 'preload-progress', message);
          if (activeId) send(activeId, 'progress', message);
        },
      });
    })().catch((error) => { modelPromise = null; throw error; });
  }
  return modelPromise;
}

// Bound each input so the model cannot silently truncate a long diary sentence.
function chunks(text) {
  const result = [];
  for (const sentence of text.match(/[^.!?\n]+[.!?]*|[.!?]+/g) || []) {
    let part = '';
    for (const word of sentence.trim().split(/\s+/)) {
      for (let offset = 0; offset < word.length; offset += 220) {
        const piece = word.slice(offset, offset + 220);
        if (part.length + piece.length + 1 > 220) { result.push(part); part = ''; }
        part += (part ? ' ' : '') + piece;
      }
    }
    if (part) result.push(part);
  }
  return result;
}

self.onmessage = ({ data }) => {
  if (data.type === 'preload') {
    model().then(() => send(0, 'preload-ready')).catch(() => send(0, 'preload-error'));
    return;
  }
  if (data.type === 'consumed') {
    if (data.id === activeId && releaseAudio) { releaseAudio(); releaseAudio = null; }
    return;
  }
  activeId = data.type === 'speak' ? data.id : 0;
  if (releaseAudio) { releaseAudio(); releaseAudio = null; }
  if (data.type === 'clear-cache') {
    queue = queue.then(() => VoiceCache.clear());
    return;
  }
  if (data.type !== 'speak') return;
  queue = queue.then(async () => {
    const { id, text, voice, speed } = data;
    if (id !== activeId) return;
    try {
      const selectedVoice = voice === 'am_michael' ? voice : 'af_heart';
      for (const part of chunks(text)) {
        if (id !== activeId) return;
        const cacheKey = VoiceCache.key(part, selectedVoice, speed);
        const cached = await VoiceCache.get(cacheKey);
        if (id !== activeId) return;
        let samples, sampleRate;
        if (cached) {
          samples = cached.samples.slice(); sampleRate = cached.sampleRate;
        } else {
          send(id, 'progress', { message: '正在產生自然語音…' });
          const tts = await model();
          if (id !== activeId) return;
          const audio = await tts.generate(part, { voice: selectedVoice, speed });
          samples = audio.audio; sampleRate = audio.sampling_rate;
          await VoiceCache.put(cacheKey, samples, sampleRate);
        }
        if (id !== activeId) return;
        // Backpressure: only generate the next sentence once this one finishes.
        await new Promise((resolve) => {
          releaseAudio = resolve;
          self.postMessage({ id, type: 'audio', samples, sampleRate, cached: !!cached }, [samples.buffer]);
        });
      }
      if (id === activeId) send(id, 'done');
    } catch (error) {
      if (id === activeId) send(id, 'error', { message: String(error.message || error) });
    }
  });
};
