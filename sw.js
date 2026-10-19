/* Network-first for this app's static files only. Never cache HEMIS or ntfy data. */
const CACHE_VERSION = '2026.10.20.5';
const ROOT = new URL('./', self.location.href);
const CACHE_PREFIX = `hemis-planner:${ROOT.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const STATIC_FILES = [
  './', './index.html', './styles.css', './app.js', './api.js', './sync.js', './data.js', './theme.js',
  './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './bridge-setup.html', './cloud-bridge/worker.js'
];
const STATIC_URLS = new Set(STATIC_FILES.map(path => new URL(path, ROOT).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A failed app-shell download aborts the update, preserving the working version.
    await cache.addAll(STATIC_FILES.map(path => new Request(new URL(path, ROOT), { cache: 'reload' })));
    // No automatic skipWaiting: an open session keeps its matching worker.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname) || url.searchParams.has('diagnostic') || url.pathname === '/health' || url.pathname === '/hemis-proxy') return;
  // Exact allowlist prevents accidental storage of API responses or credentials.
  const cleanURL = new URL(url.pathname, ROOT.origin).href;
  const isNavigation = request.mode === 'navigate' && (url.pathname === ROOT.pathname || url.pathname === `${ROOT.pathname}index.html`);
  if (!STATIC_URLS.has(cleanURL) && !isNavigation) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(request, {signal: controller.signal});
      if (response.ok && response.type === 'basic') await cache.put(cleanURL, response.clone());
      if (response.ok) return response;
      const cached = await cache.match(cleanURL);
      return cached || response;
    } catch {
      const cached = await cache.match(cleanURL);
      if (cached) return cached;
      if (isNavigation) return (await cache.match(new URL('./index.html', ROOT).href)) || Response.error();
      return Response.error();
    } finally { clearTimeout(timeout); }
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (event.data?.type !== 'SHOW_REMINDER') return;
  const title = String(event.data.title || 'HEMIS Planner — завтра').slice(0, 120);
  const body = String(event.data.body || 'Проверьте расписание и задания на завтра.').slice(0, 1000);
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: new URL('./icon-192.png', ROOT).href,
    badge: new URL('./icon-192.png', ROOT).href,
    tag: String(event.data.tag || 'hemis-evening-reminder').slice(0, 100),
    data: { url: ROOT.href },
    renotify: false
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (client.url.startsWith(ROOT.href) && 'focus' in client) return client.focus();
    return self.clients.openWindow(ROOT.href);
  })());
});
