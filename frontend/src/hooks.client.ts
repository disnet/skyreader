import type { HandleClientError } from '@sveltejs/kit';
import { reportClientError } from '$lib/services/telemetry';
import { startVitals } from '$lib/services/vitals';
import { handlePreloadError } from '$lib/services/preloadRecovery';

// Two jobs, both about surviving a deploy:
//
// 1. Recover from stale dynamic-import failures ($lib/services/preloadRecovery).
// 2. Tell the backend when the app breaks in a browser, so "the deploy bricked
//    the PWA" stops being something we learn from user reports. Sampled and
//    stripped of identifiers — see $lib/services/telemetry.

window.addEventListener('vite:preloadError', handlePreloadError);

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

// Field vitals for a sampled share of page loads ($lib/services/vitals). The
// first view's route is filled in by the root layout's first afterNavigate.
startVitals();
