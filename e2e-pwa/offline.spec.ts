import { test, expect } from '@playwright/test';
import { recoveryVisible, shellRendered, waitForControl } from './helpers';

// Runs on chromium AND webkit (webkit = closest Safari engine proxy). This is the direct
// regression test for the original symptom: blank screen / "Something went wrong".
test.describe('offline resilience', () => {
  test('recovery overlay stays hidden on a healthy load', async ({ page }) => {
    await page.goto('/');
    await waitForControl(page);
    expect(await shellRendered(page)).toBe(true);
    expect(await recoveryVisible(page)).toBe(false);
  });

  test('reload while offline still renders the app shell', async ({
    browserName,
    context,
    page,
  }) => {
    // Playwright's webkit throws "internal error" when navigating with setOffline(true);
    // the SW itself works in webkit (lifecycle + healthy-load tests pass). Offline serving
    // is verified on chromium here and on real iOS Safari via manual device testing.
    test.skip(browserName === 'webkit', 'Playwright webkit cannot navigate while offline');
    await page.goto('/');
    await waitForControl(page);

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      expect(await shellRendered(page), 'app shell should render offline').toBe(true);
      expect(await recoveryVisible(page), 'recovery overlay should not show offline').toBe(false);
    } finally {
      await context.setOffline(false);
    }
  });

  test('deep-link navigation while offline serves the precached shell', async ({
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright webkit cannot navigate while offline');
    await page.goto('/');
    await waitForControl(page);

    await context.setOffline(true);
    try {
      await page.goto('/settings', { waitUntil: 'domcontentloaded' });
      expect(await shellRendered(page), 'deep link should render offline').toBe(true);
      expect(await recoveryVisible(page)).toBe(false);
    } finally {
      await context.setOffline(false);
    }
  });
});
