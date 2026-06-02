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
      if (reg.active && navigator.serviceWorker.controller) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      activeState: reg.active?.state ?? null,
      controller: !!navigator.serviceWorker.controller,
    };
  }, timeoutMs);
}

/** True if the in-app.html recovery overlay ("Something went wrong") is visible. */
export function recoveryVisible(page: Page) {
  return page.evaluate(() => {
    const r = document.getElementById('skyreader-recovery');
    return r ? getComputedStyle(r).display !== 'none' : false;
  });
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
