import { test, expect } from './fixtures';
import { seedSubscription } from './seed';

test.describe('Navigation', () => {
  test('sidebar shows all nav items', async ({ authedPage }) => {
    await expect(authedPage.locator('.nav-label', { hasText: 'All' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.locator('.nav-label', { hasText: 'Saved' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Shared' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Activity' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Settings' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Feedback' })).toBeVisible();
  });

  test('clicking Saved sets filter', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Saved' }).click();
    await expect(authedPage).toHaveURL(/saved=true/);
  });

  test('clicking Shared sets filter', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Shared' }).click();
    await expect(authedPage).toHaveURL(/shared=true/);
  });

  test('Settings link navigates to /settings', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Settings' }).click();
    await expect(authedPage).toHaveURL(/\/settings/);
    await expect(authedPage.locator('h2', { hasText: 'Account' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Activity link navigates to /activity', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Activity' }).click();
    await expect(authedPage).toHaveURL(/\/activity/);
  });

  test('clicking a feed sets feed filter', async ({ authedPage, testUser }) => {
    seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Nav Test Feed',
    });

    await authedPage.reload();

    const feedItem = authedPage.locator('.nav-label', { hasText: 'Nav Test Feed' });
    await expect(feedItem).toBeVisible({ timeout: 15_000 });

    await feedItem.click();
    await expect(authedPage).toHaveURL(/feed=/);
  });
});
