// ChordBook service worker — network-first для оболочки приложения.
// Онлайн: всегда свежая версия (никакого «протухшего» кэша — из-за этого SW
// раньше был отключён). Офлайн: последняя закэшированная версия.
const CACHE = 'chordbook-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html']).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // API Firebase/Telegram — никогда не кэшируем
  if (/googleapis\.com$/.test(url.hostname) && !/fonts/.test(url.hostname)) return;
  if (url.hostname === 'telegram.org') return;

  // Шрифты — cache-first (не меняются, а офлайн без них некрасиво)
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(e.request).then(m => m || fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }))
    );
    return;
  }

  // Оболочка приложения — network-first
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      }).catch(() =>
        caches.match(e.request).then(m => m || caches.match('./index.html'))
      )
    );
  }
});
