// Service worker: makes the panel installable as an app and gives it a proper
// offline screen. It deliberately caches nothing that carries server data:
// pages and /api always come from the network, so nothing shown is ever stale.
// Only the offline page and the static look it needs are kept, plus fonts and
// icons (content-stable, see the immutable Cache-Control in web/app.js).
// Notifications are shown through this worker: local "task finished" ones
// (Android Chrome cannot construct `new Notification()` in a page) and Web Push
// from the panel (crashes, problems, updates, ...), which arrive even when the
// app is closed. See services/push.js and the Mobile App settings page.

const CACHE = 'oxyx-shell-v5';
const SHELL = ['/offline.html', '/css/app.css', '/favicon.svg', '/icons/oxyx-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: always the network; the offline screen only when it can't answer.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // Fonts and icons never change under the same name: cache-first.
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // The stylesheet: fresh when online (keeps the offline page's copy current).
  if (url.pathname === '/css/app.css') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/css/app.css', copy));
          }
          return res;
        })
        .catch(() => caches.match('/css/app.css'))
    );
  }
  // Everything else (scripts, /api, …) goes straight to the network untouched.
});

// ---- Web Push ----
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: 'Oxyx', body: event.data ? event.data.text() : '' };
  }
  const title = msg.title || 'Oxyx';
  const options = {
    body: msg.body || '',
    icon: '/icons/oxyx-192.png',
    badge: '/icons/oxyx-badge-96.png',
    tag: msg.tag || undefined,
    // A newer notification with the same tag still buzzes the phone.
    renotify: Boolean(msg.tag),
    // Crashes and problems stay on screen until dealt with.
    requireInteraction: Boolean(msg.critical),
    vibrate: msg.critical ? [120, 60, 120, 60, 240] : [80],
    timestamp: Date.now(),
    data: { url: msg.url || '/' },
    actions: Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [],
  };
  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      // Keep the app icon's count in step with unseen alerts.
      if (msg.critical && 'setAppBadge' in self.navigator) return self.navigator.setAppBadge().catch(() => {});
      return undefined;
    })
  );
});

// The browser rotated this device's push subscription: hand the new one to the
// panel so notifications keep arriving (the session cookie travels with it).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      const sub =
        event.newSubscription ||
        (key
          ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
          : null);
      if (!sub) return;
      await fetch('/api/account/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      }).catch(() => {});
    })()
  );
});

// Tapping a notification (or its Open Server action) focuses an open panel
// window on the right page, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = event.notification.data && event.notification.data.url;
  // Only ever a page of this panel.
  const target = typeof wanted === 'string' && wanted.startsWith('/') && !wanted.startsWith('//') ? wanted : '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => 'focus' in w);
      if (win) {
        // navigate() only works on a window this worker controls; otherwise open one.
        const moved = await win.navigate(target).catch(() => null);
        if (moved) return moved.focus();
      }
      return self.clients.openWindow(target);
    })()
  );
});
