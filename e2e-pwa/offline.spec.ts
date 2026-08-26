import { test, expect } from '@playwright/test';
import { shellRendered, waitForControl } from './helpers';

// Runs on chromium AND webkit (webkit = closest Safari engine proxy). This is the direct
// regression test for the original symptom: blank screen.
test.describe('offline resilience', () => {
  test('app shell renders on a healthy load', async ({ page }) => {
    await page.goto('/');
    await waitForControl(page);
    expect(await shellRendered(page)).toBe(true);
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
    } finally {
      await context.setOffline(false);
    }
  });

  // An open article is a `?read=` query on a normal surface (see `readerLink.ts`),
  // and the app-shell handler answers navigations regardless of query — so a link
  // into the reader must survive offline exactly like any other deep link. This
  // suite runs without a backend or a signed-in user, so it pins the shell half of
  // that; reopening the article itself from Dexie is covered in the main E2E suite.
  test('a reader deep link while offline serves the precached shell', async ({
    browserName,
    context,
    page,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright webkit cannot navigate while offline');
    await page.goto('/');
    await waitForControl(page);

    await context.setOffline(true);
    try {
      await page.goto('/saved?read=https%3A%2F%2Fexample.com%2Fa', {
        waitUntil: 'domcontentloaded',
      });
      expect(await shellRendered(page), 'reader deep link should render offline').toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });
});
