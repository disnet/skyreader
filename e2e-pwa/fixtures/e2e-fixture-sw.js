// Test fixture only — NOT part of the app, never registered by production code.
// The PWA suite copies this into the served client dir (see playwright.pwa.config.ts)
// and registers it to simulate a genuinely NEW build: a worker that self-activates,
// claims the page, and reports a build version different from the running app's, so
// the version-gated update banner in +layout.svelte should appear.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'GET_VERSION') {
    e.ports[0] && e.ports[0].postMessage({ version: 'e2e-fixture-new-build' });
  }
});
