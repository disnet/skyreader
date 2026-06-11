// Recover from stale dynamic-import failures after a deploy / service-worker update.
//
// When a new build ships, the old build's hashed chunks are dropped from the SW
// precache (cleanupOutdatedCaches + the new precache install) and 404 on the
// host. Any dynamic import() the still-running OLD page issues for one of those
// chunks then fails with "error loading dynamically imported module". Because
// these are Vite preload imports (not router-managed), the failure surfaces as
// an uncaught promise rejection — Vite dispatches `vite:preloadError` for it —
// and the app gets stuck until a manual hard refresh.
//
// A single full reload pulls the new shell + new chunks from the freshly
// activated SW and recovers cleanly. The sessionStorage guard makes it one-shot
// so a genuinely missing chunk can't trap us in a reload loop; it's cleared once
// the page next loads successfully, so a later deploy can recover again.

const RELOAD_GUARD_KEY = 'sw-preload-reload';

window.addEventListener('vite:preloadError', (event) => {
  // Don't fight a real, persistent failure — only auto-reload once.
  if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return;
  event.preventDefault();
  sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  window.location.reload();
});

// A clean load means recovery succeeded (or no error occurred) — re-arm the
// guard so a future stale-chunk event after the next deploy can recover too.
window.addEventListener('load', () => {
  sessionStorage.removeItem(RELOAD_GUARD_KEY);
});
