/* Inkling service worker：離線開啟 app 殼層
   改了任何檔案要上線時，把 VERSION 加一，使用者下次開啟就會拿到新版 */
const VERSION = 'inkling-v0.3.0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './voice.js',
  './voice-worker.js',
  './voice-cache.js',
  './dictation.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkling-') && k !== VERSION && k !== VERSION + '-fonts').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;           // AI 請求（POST）一律不快取
  const url = new URL(req.url);

  // Google Fonts：先用快取，沒有再抓
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(VERSION + '-fonts').then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 自己的檔案：先抓網路（拿到最新版），離線時用快取
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./index.html') : undefined))
  );
});
