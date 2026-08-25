import { type Page } from '@playwright/test';

/**
 * Poll until the service worker has activated and taken control of the page
 * (via clientsClaim on first install), or time out. Returns a lifecycle snapshot.
 * Registers the SW explicitly if the app hasn't yet (injectRegister is false).
 */
export function waitForControl(page: Page, timeoutMs = 15000) {
  return page.evaluate(async (timeout) => {
    const reg =
      (await navigator.serviceWorker.getRegistration()) ||
      (await navigator.serviceWorker.register('/service-worker.js'));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // `reg.active` is populated the moment the worker enters *activating*, and
      // clientsClaim() sets the controller during activation too — so both can be
      // true while the state is still 'activating'. Wait for the terminal state.
      if (reg.active?.state === 'activated' && navigator.serviceWorker.controller) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      activeState: reg.active?.state ?? null,
      controller: !!navigator.serviceWorker.controller,
    };
  }, timeoutMs);
}

/** True if the app shell rendered something (not a blank page). */
export async function shellRendered(page: Page) {
  try {
    await page.waitForSelector('.app, .login-btn, main', {
      state: 'attached',
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}
