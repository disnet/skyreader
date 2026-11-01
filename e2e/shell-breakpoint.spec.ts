import { test, expect } from './fixtures';

/**
 * Which layout a window gets depends on the pointer as well as the width (see
 * frontend/src/lib/utils/shellMedia.js). A mouse-driven window between 851px and
 * 1000px — a desktop PWA, a half-screen window, a laptop at 150% scaling — gets
 * the framed shell with its rail and toolbar, not the phone layout whose bottom
 * bar slides away on scroll. Touch screens keep the phone layout up to 1000px.
 */
const rail = (page: import('@playwright/test').Page) =>
  page.getByRole('separator', { name: 'Resize sidebar' });

test.describe('narrow desktop window', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('gets the framed shell', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(rail(page)).toBeVisible();
    await expect(page.locator('#shell-toolbar')).toBeVisible();
    await expect(page.locator('.mobile-bottom-bar')).toHaveCount(0);
  });
});

test.describe('touch screen at the same width', () => {
  test.use({ viewport: { width: 900, height: 800 }, hasTouch: true });

  test('keeps the phone layout', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('.mobile-bottom-bar')).toBeVisible();
    await expect(rail(page)).toBeHidden();
  });
});

test.describe('phone-width window with a mouse', () => {
  test.use({ viewport: { width: 700, height: 800 } });

  test('keeps the phone layout', async ({ authedPage: page }) => {
    await page.goto('/feeds');
    await expect(page.locator('.mobile-bottom-bar')).toBeVisible();
    await expect(rail(page)).toBeHidden();
  });
});
