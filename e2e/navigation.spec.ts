import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('sidebar shows all nav items', async ({ authedPage }) => {
    await expect(authedPage.locator('.nav-label', { hasText: 'Feeds' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.locator('.nav-label', { hasText: 'Saved' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Manage Sources' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Settings' })).toBeVisible();
  });

  test('clicking Saved sets filter', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Saved' }).click();
    await expect(authedPage).toHaveURL(/\/saved/);
  });

  test('Settings link navigates to /settings', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Settings' }).click();
    await expect(authedPage).toHaveURL(/\/settings/);
    await expect(authedPage.locator('h2', { hasText: 'Account' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
