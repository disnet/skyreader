import { test, expect } from '@playwright/test';
import { shellRendered } from './helpers';

test.describe('preload error recovery', () => {
  test('auto-reloads at most once per tab', async ({ page }) => {
    await page.goto('/');
    expect(await shellRendered(page)).toBe(true);

    const firstReload = page.waitForEvent('domcontentloaded');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    });
    await firstReload;
    expect(await shellRendered(page)).toBe(true);

    const secondReload = page.waitForEvent('domcontentloaded').then(() => true);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    });
    const secondReloaded = await Promise.race([
      secondReload,
      page.waitForTimeout(1000).then(() => false),
    ]);

    expect(secondReloaded).toBe(false);
  });
});
