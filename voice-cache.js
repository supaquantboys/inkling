// Persistent, bounded PCM cache. A storage failure never prevents speech.
const VoiceCache = (() => {
  const VERSION = 'kokoro-1.2.1-q8-v1';
  const LIMIT = 32 * 1024 * 1024;
  const MEMORY_LIMIT = 8 * 1024 * 1024;
  const memory = new Map();
  let memoryBytes = 0, database;
  const key = (text, voice, speed) => JSON.stringify([VERSION, text, voice, speed]);
  const request = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function db() {
    if (!database) database = new Promise((resolve, reject) => {
      const req = indexedDB.open('inkling-voice', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('audio', { keyPath: 'key' }).createIndex('used', 'used');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Audio storage blocked'));
    });
    return database;
  }
  function remember(entry) {
    if (memory.has(entry.key)) memoryBytes -= memory.get(entry.key).bytes;
    memory.delete(entry.key);
    if (entry.bytes > MEMORY_LIMIT) return;
    memory.set(entry.key, entry); memoryBytes += entry.bytes;
    while (memoryBytes > MEMORY_LIMIT) {
      const oldest = memory.keys().next().value;
      memoryBytes -= memory.get(oldest).bytes; memory.delete(oldest);
    }
  }
  async function get(cacheKey) {
    try {
      const entry = memory.get(cacheKey) || await request((await db()).transaction('audio').objectStore('audio').get(cacheKey));
      if (!entry) return null;
      entry.used = Date.now(); remember(entry);
      try { await request((await db()).transaction('audio', 'readwrite').objectStore('audio').put(entry)); } catch {}
      return entry;
    } catch { return null; }
  }
  async function put(cacheKey, samples, sampleRate) {
    const entry = { key: cacheKey, samples: samples.slice(), sampleRate, bytes: samples.byteLength, used: Date.now() };
    remember(entry);
    if (entry.bytes > LIMIT) return;
    try {
      const store = (await db()).transaction('audio', 'readwrite').objectStore('audio');
      await new Promise((resolve, reject) => {
        const entries = [], cursor = store.index('used').openCursor();
        let bytes = entry.bytes;
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row) {
            if (row.value.key !== cacheKey) { entries.push([row.primaryKey, row.value.bytes]); bytes += row.value.bytes; }
            row.continue(); return;
          }
          for (const [oldKey, size] of entries) {
            if (bytes <= LIMIT) break;
            store.delete(oldKey); bytes -= size;
          }
          store.put(entry);
        };
        store.transaction.oncomplete = resolve;
        store.transaction.onerror = () => reject(store.transaction.error);
        store.transaction.onabort = () => reject(store.transaction.error);
      });
    } catch {}
  }
  async function clear() {
    memory.clear(); memoryBytes = 0;
    try { await request((await db()).transaction('audio', 'readwrite').objectStore('audio').clear()); } catch {}
  }
  return { key, get, put, clear };
})();
