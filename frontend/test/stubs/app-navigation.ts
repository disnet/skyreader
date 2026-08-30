// Stands in for SvelteKit's `$app/navigation` in tests, which run outside the
// SvelteKit build and so can't resolve it. Aliased in vitest.config.ts.
//
// `afterNavigate` is the interesting one: real navigation can't happen in
// jsdom, so the stub records the callbacks and lets a test fire them. The real
// hook unregisters when its component is destroyed; here `resetNavigation()`
// between tests does that job.

export type NavigationType = 'enter' | 'link' | 'goto' | 'popstate' | 'form' | 'leave';

type Callback = (nav: { type: NavigationType }) => void;

const beforeCallbacks: Callback[] = [];
const afterCallbacks: Callback[] = [];

export function beforeNavigate(callback: Callback) {
  beforeCallbacks.push(callback);
}

export function afterNavigate(callback: Callback) {
  afterCallbacks.push(callback);
}

/** Fire the registered hooks as if the app had navigated. */
export function simulateNavigation(type: NavigationType = 'link') {
  for (const callback of [...beforeCallbacks]) callback({ type });
  for (const callback of [...afterCallbacks]) callback({ type });
}

/** Fire only the start of a navigation, for ordering cases. */
export function simulateNavigationStart(type: NavigationType = 'link') {
  for (const callback of [...beforeCallbacks]) callback({ type });
}

/** Fire only the end of one, e.g. a redirect that began before a modal opened. */
export function simulateNavigationEnd(type: NavigationType = 'link') {
  for (const callback of [...afterCallbacks]) callback({ type });
}

export function resetNavigation() {
  beforeCallbacks.length = 0;
  afterCallbacks.length = 0;
}
