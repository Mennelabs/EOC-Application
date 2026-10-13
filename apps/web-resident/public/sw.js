/* Resident app service worker (CHN-02, SCL-06): the app shell is cached so the
 * flow opens offline; API calls always go to the network (the device outbox
 * handles failures); nothing personal is ever cached here. */
const CACHE = 'cg-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/config.json') return;
  // Built assets are content-hashed: cache first. Pages: network first, shell as the fallback.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches
              .open(CACHE)
              .then((c) => c.put(event.request, copy))
              .catch(() => undefined);
            return res;
          }),
      ),
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (event.request.mode === 'navigate') {
          const copy = res.clone();
          caches
            .open(CACHE)
            .then((c) => c.put('/index.html', copy))
            .catch(() => undefined);
        }
        return res;
      })
      .catch(() => caches.match(event.request.mode === 'navigate' ? '/index.html' : event.request)),
  );
});
