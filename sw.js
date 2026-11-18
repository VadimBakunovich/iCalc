// Офлайн-кэш приложения.
// ВАЖНО: при любом изменении файлов увеличьте номер версии — иначе телефон не узнает об обновлении.
const CACHE = 'icalc-v5';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'i18n.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// Скачиваем все файлы новой версии целиком, в обход кэша браузера,
// чтобы не смешать старые и новые файлы.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Отдаём файлы только из кэша текущей версии — работает без интернета.
// Новая версия приходит вместе с новым sw.js.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      return (await cache.match(key, { ignoreSearch: true })) || fetch(req);
    })
  );
});
