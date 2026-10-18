import { reportClientError } from './telemetry';

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

// One stale route load fails several imports at once, so this page can see more
// preload errors after it has already asked for the reload. Those are the same
// failure the reload is about to fix, not proof that the reload didn't work:
// reporting them is what made `preload_recovery_failed` fire "0s after" the
// guard tripped on pages that went on to recover. They are left to Vite (not
// prevented), exactly as before; they just aren't reported.
let reloading = false;
// A stuck page reports once. Each later failure carries a new elapsed time, so
// telemetry's per-load dedup wouldn't catch it, and one tab clicking around would
// otherwise meet the page threshold on its own.
let reported = false;

export function handlePreloadError(event: Event): void {
  if (reloading) return;
  // Don't fight a real, persistent failure — only auto-reload once.
  const lastReloadAt = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
  if (lastReloadAt && Date.now() - lastReloadAt < RELOAD_GUARD_TTL_MS) {
    // We already reloaded for this, and it happened again: the chunk is genuinely
    // gone and the user is now stuck on a page that can't navigate. This is the
    // "a deploy bricked the PWA" signal, and it was invisible until now — the
    // guard's whole job is to stop reloading, which also stops anyone finding
    // out. Never sampled away.
    if (reported) return;
    reported = true;
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
  // Only once the reload is really going: if the guard can't be written, later
  // failures must still get their chance to recover or report.
  reloading = true;
  window.location.reload();
}

/** Test seam: per-page-load state that would otherwise leak between cases. */
export function resetPreloadRecoveryForTests(): void {
  reloading = false;
  reported = false;
}
