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

const voiceId = voice => ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck'].includes(voice) ? voice : 'af_heart';
let inference = Promise.resolve();
let prepareEpoch = 0;
async function cachedAudio(part, voice, speed) {
  const cacheKey = VoiceCache.key(part, voice, speed);
  const hit = await VoiceCache.get(cacheKey);
  if (hit) return { samples: hit.samples.slice(), sampleRate: hit.sampleRate, cached: true };
  const task = inference.then(async () => {
    const cached = await VoiceCache.get(cacheKey);
    if (cached) return { samples: cached.samples.slice(), sampleRate: cached.sampleRate, cached: true };
    const tts = await model();
    const audio = await tts.generate(part, { voice, speed });
    await VoiceCache.put(cacheKey, audio.audio, audio.sampling_rate);
    return { samples: audio.audio, sampleRate: audio.sampling_rate, cached: false };
  });
  inference = task.catch(() => {});
  return task;
}
async function prepare(data) {
  const epoch = prepareEpoch;
  const parts = [...new Set(data.texts.flatMap(chunks))];
  try {
    for (let i = 0; i < parts.length; i++) {
      // Interactive playback takes priority over background preparation.
      while (activeId && epoch === prepareEpoch) await new Promise(resolve => setTimeout(resolve, 25));
      if (epoch !== prepareEpoch) { send(data.id, 'prepare-error'); return; }
      await cachedAudio(parts[i], voiceId(data.voice), data.speed);
      if (epoch !== prepareEpoch) { send(data.id, 'prepare-error'); return; }
      send(data.id, 'prepare-progress', { completed: i + 1, total: parts.length });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    send(data.id, 'prepare-ready');
  } catch (error) { send(data.id, 'prepare-error', { message: String(error.message || error) }); }
}

self.onmessage = ({ data }) => {
  if (data.type === 'prepare') { prepare(data); return; }
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
    ++prepareEpoch;
    queue = queue.then(async () => { await inference; await VoiceCache.clear(); });
    return;
  }
  if (data.type !== 'speak') return;
  queue = queue.then(async () => {
    const { id, text, voice, speed } = data;
    if (id !== activeId) return;
    try {
      const selectedVoice = voiceId(voice);
      for (const part of chunks(text)) {
        if (id !== activeId) return;
        send(id, 'progress', { message: '正在準備語音…' });
        const { samples, sampleRate, cached } = await cachedAudio(part, selectedVoice, speed);
        if (id !== activeId) return;
        // Backpressure: only generate the next sentence once this one finishes.
        await new Promise((resolve) => {
          releaseAudio = resolve;
          self.postMessage({ id, type: 'audio', samples, sampleRate, cached }, [samples.buffer]);
        });
      }
      if (id === activeId) send(id, 'done');
    } catch (error) {
      if (id === activeId) send(id, 'error', { message: String(error.message || error) });
    }
  });
};
