// ============================================================================
// ASB Inbox — service worker
//
// Two jobs only:
//   1. show a notification when the server pushes a new customer message,
//      even with the phone locked or the inbox closed;
//   2. when the notification is tapped, open (or bring forward) the inbox on
//      that customer's chat.
// Nothing is cached: the inbox needs the network anyway, and a cached copy
// of an old page is the classic way a fixed bug keeps coming back.
// ============================================================================

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data && event.data.text() }; }
  const title = d.title || 'ASB Inbox';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || 'New WhatsApp message',
    tag: d.tag || 'asb',
    renotify: true,                 // a second message from her still buzzes
    icon: '/inbox/icon-192.png',
    badge: '/inbox/icon-badge.png',
    data: { url: d.url || '/inbox', phone: d.phone || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  const phone = event.notification.data && event.notification.data.phone;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).pathname === '/inbox') {
        await w.focus();
        if (phone) w.postMessage({ type: 'open-chat', phone });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
