import { test, expect } from './fixtures';
import { seedSubscription } from './seed';

test.describe('Feed Management', () => {
  test('add feed by URL via sidebar input', async ({ authedPage }) => {
    const addFeedInput = authedPage.getByPlaceholder('Add feed, URL, or @handle...');
    await expect(addFeedInput).toBeVisible({ timeout: 15_000 });

    await addFeedInput.fill('https://xkcd.com/atom.xml');
    await addFeedInput.press('Enter');

    // Wait for the feed to appear in the sidebar (discovery + add)
    await expect(authedPage.locator('.nav-label', { hasText: 'xkcd' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('remove feed via context menu', async ({ authedPage, testUser }) => {
    seedSubscription(testUser, {
      feedUrl: 'https://example.com/delete-test.xml',
      title: 'Delete Test Feed',
    });

    await authedPage.reload();

    const feedItem = authedPage.locator('.nav-label', { hasText: 'Delete Test Feed' });
    await expect(feedItem).toBeVisible({ timeout: 15_000 });

    // Accept the confirm dialog
    authedPage.on('dialog', (dialog) => dialog.accept());

    // Right-click to open context menu
    await feedItem.click({ button: 'right' });

    const deleteButton = authedPage.locator('.context-menu-item', { hasText: 'Delete' });
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Feed should disappear from sidebar
    await expect(feedItem).not.toBeVisible({ timeout: 10_000 });
  });

  test('articles load after adding feed', async ({ authedPage }) => {
    const addFeedInput = authedPage.getByPlaceholder('Add feed, URL, or @handle...');
    await expect(addFeedInput).toBeVisible({ timeout: 15_000 });

    await addFeedInput.fill('https://xkcd.com/atom.xml');
    await addFeedInput.press('Enter');

    // Wait for feed to appear
    const feedItem = authedPage.locator('.nav-label', { hasText: 'xkcd' });
    await expect(feedItem).toBeVisible({ timeout: 30_000 });

    // Click the feed to view its articles
    await feedItem.click();

    // Articles should load
    await expect(authedPage.locator('article.article-item').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('multiple feeds show in sidebar', async ({ authedPage, testUser }) => {
    seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed1.xml',
      title: 'Multi Feed One',
    });
    seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed2.xml',
      title: 'Multi Feed Two',
    });
    seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed3.xml',
      title: 'Multi Feed Three',
    });

    await authedPage.reload();

    await expect(
      authedPage.locator('.nav-label', { hasText: 'Multi Feed One' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      authedPage.locator('.nav-label', { hasText: 'Multi Feed Two' })
    ).toBeVisible();
    await expect(
      authedPage.locator('.nav-label', { hasText: 'Multi Feed Three' })
    ).toBeVisible();
  });
});
