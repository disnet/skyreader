import { test, expect } from './fixtures';
import { seedSubscription } from './seed';

test.describe('Feed Management', () => {
  test('add feed by URL via sidebar add trigger', async ({ authedPage }) => {
    // Open the AddSourceInput popover from the sidebar
    await authedPage.locator('button.add-trigger[aria-label="Add source"]').click();

    const addFeedInput = authedPage.getByPlaceholder('Paste URL or @handle...');
    await expect(addFeedInput).toBeVisible({ timeout: 15_000 });

    await addFeedInput.fill('https://xkcd.com/atom.xml');
    await addFeedInput.press('Enter');

    // AddFeedModal opens with the URL prefilled — click Add to submit
    const modalInput = authedPage.locator('.modal-content input.search-input');
    await expect(modalInput).toBeVisible({ timeout: 5_000 });
    await authedPage.locator('.modal-content button.add-btn', { hasText: 'Add' }).click();

    // Navigate to the sources page via SPA navigation (preserves store state)
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();
    await expect(authedPage.locator('.source-title', { hasText: 'xkcd' })).toBeVisible({
      timeout: 30_000,
    });
  });

  test('remove feed via sources page menu', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/delete-test.xml',
      title: 'Delete Test Feed',
    });

    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();

    const sourceRow = authedPage.locator('.source-row', {
      has: authedPage.locator('.source-title', { hasText: 'Delete Test Feed' }),
    });
    await expect(sourceRow).toBeVisible({ timeout: 15_000 });

    // Accept the confirm dialog that pops up on Remove
    authedPage.on('dialog', (dialog) => dialog.accept());

    // Open the row's popover menu and click Remove
    await sourceRow.locator('button.menu-trigger').click({ force: true });
    await authedPage.locator('.menu-item.danger', { hasText: 'Remove' }).click();

    // Row should disappear
    await expect(sourceRow).not.toBeVisible({ timeout: 10_000 });
  });

  test('articles load after adding feed', async ({ authedPage }) => {
    await authedPage.locator('button.add-trigger[aria-label="Add source"]').click();

    const addFeedInput = authedPage.getByPlaceholder('Paste URL or @handle...');
    await expect(addFeedInput).toBeVisible({ timeout: 15_000 });

    await addFeedInput.fill('https://xkcd.com/atom.xml');
    await addFeedInput.press('Enter');

    const modalInput = authedPage.locator('.modal-content input.search-input');
    await expect(modalInput).toBeVisible({ timeout: 5_000 });
    await authedPage.locator('.modal-content button.add-btn', { hasText: 'Add' }).click();

    // Already on the main feed — articles should load as the feed is fetched
    await expect(authedPage.locator('article.article-item').first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('multiple feeds show on sources page', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed1.xml',
      title: 'Multi Feed One',
    });
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed2.xml',
      title: 'Multi Feed Two',
    });
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/feed3.xml',
      title: 'Multi Feed Three',
    });

    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();

    await expect(authedPage.locator('.source-title', { hasText: 'Multi Feed One' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.locator('.source-title', { hasText: 'Multi Feed Two' })).toBeVisible();
    await expect(
      authedPage.locator('.source-title', { hasText: 'Multi Feed Three' })
    ).toBeVisible();
  });
});
