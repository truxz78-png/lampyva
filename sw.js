// Lampyva — service worker used ONLY to show the "your images are ready" notification.
// It does not store or serve any page or file (no offline cache), so updates are always seen at once.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) if (c.url.includes("/lampyva/") || c.url.startsWith(self.registration.scope)) return c.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
