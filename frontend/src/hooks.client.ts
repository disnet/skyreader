import type { HandleClientError } from '@sveltejs/kit';
import { reportClientError } from '$lib/services/telemetry';

// Two jobs, both about surviving a deploy:
//
// 1. Recover from stale dynamic-import failures (below).
// 2. Tell the backend when the app breaks in a browser, so "the deploy bricked
//    the PWA" stops being something we learn from user reports. Sampled and
//    stripped of identifiers — see $lib/services/telemetry.
//
// Recover from stale dynamic-import failures after a deploy / service-worker update.
//
// When a new build ships, an old, still-running page can issue a dynamic import()
// for a hashed chunk from its own (now previous) build. The deploy pipeline keeps
// recent builds' immutable assets servable (scripts/retain-immutable-assets.mjs),
// so that import normally still succeeds from the network — this handler is the
// backstop for when it doesn't (retention expired or skipped). Because these are
// Vite preload imports (not router-managed), the failure surfaces as an uncaught
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
  if (lastReloadAt && Date.now() - lastReloadAt < RELOAD_GUARD_TTL_MS) {
    // We already reloaded for this, and it happened again: the chunk is genuinely
    // gone and the user is now stuck on a page that can't navigate. This is the
    // "a deploy bricked the PWA" signal, and it was invisible until now — the
    // guard's whole job is to stop reloading, which also stops anyone finding
    // out. Never sampled away.
    reportClientError(
      'preload_recovery_failed',
      new Error(
        `Preload failed again ${Math.round((Date.now() - lastReloadAt) / 1000)}s after reload guard tripped`
      )
    );
    return;
  }
  event.preventDefault();
  sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  window.location.reload();
});

// Anything the framework didn't route through a boundary. `error` is whatever was
// thrown, so it may not be an Error at all — the reporter handles that.
window.addEventListener('error', (event) => {
  // A failed <img>/<script>/<link> also fires `error` on the window (it bubbles
  // from the element), with no `error` and no `message`. That's a broken asset,
  // not a broken app, and reporting it would be a stream of "undefined".
  if (event.target && event.target !== window) return;
  reportClientError('uncaught', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportClientError('rejection', event.reason);
});

/**
 * SvelteKit's client-side error hook: an error thrown while loading or rendering
 * a route. Returning the shape SvelteKit shows the user unchanged — this hook
 * only adds the report.
 */
export const handleError: HandleClientError = ({ error, message }) => {
  reportClientError('render', error);
  return { message };
};
