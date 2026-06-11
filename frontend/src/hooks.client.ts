// Recover from stale dynamic-import failures after a deploy / service-worker update.
//
// When a new build ships, an old, still-running page can issue a dynamic import()
// for a hashed chunk that no longer exists on the host. Because these are Vite
// preload imports (not router-managed), the failure surfaces as an uncaught
// promise rejection — Vite dispatches `vite:preloadError` for it — and the app
// gets stuck until a manual hard refresh.
//
// A single full reload should pull the active SW's shell + chunks and recover cleanly.
// Keep a short sessionStorage guard so a genuinely missing chunk cannot trap us in a
// rapid reload loop, while still allowing recovery from a later deploy in the same tab.

const RELOAD_GUARD_KEY = 'sw-preload-reload';
const RELOAD_GUARD_TTL_MS = 5 * 60 * 1000;

window.addEventListener('vite:preloadError', (event) => {
  // Don't fight a real, persistent failure — only auto-reload once.
  const lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
  if (lastReloadAt && Date.now() - lastReloadAt < RELOAD_GUARD_TTL_MS) return;
  event.preventDefault();
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
});
