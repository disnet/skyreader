import { test, expect } from './fixtures';
import { seedSubscription } from './seed';
import type { Page, Locator } from '@playwright/test';

/** Locate the SourceRow for a given title on the /sources page. */
function sourceRowByTitle(page: Page, title: string): Locator {
  return page.locator('.source-row', {
    has: page.locator('.source-title', { hasText: title }),
  });
}

/** Open the edit modal for a source row via its popover menu. */
async function openEditModal(page: Page, row: Locator) {
  await row.locator('button.menu-trigger').click({ force: true });
  const editItem = page.locator('.menu-item', { hasText: 'Edit' });
  await expect(editItem).toBeVisible({ timeout: 5_000 });
  await editItem.click();
}

test.describe('Custom Fields', () => {
  const FEED_URL = 'https://example.com/feed.xml';
  const FEED_TITLE = 'Example Feed';

  test('edit custom title via sources page', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });

    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();

    const row = sourceRowByTitle(authedPage, FEED_TITLE);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await openEditModal(authedPage, row);

    // The EditFeedModal should be open
    const titleInput = authedPage.locator('#feed-title');
    await expect(titleInput).toBeVisible();

    // Type a custom title
    const customTitle = 'My Custom Feed Title';
    await titleInput.fill(customTitle);

    // Save and wait for the PATCH request to complete (fires in background)
    const patchPromise = authedPage.waitForResponse(
      (resp) => resp.url().includes('/api/subscriptions/') && resp.request().method() === 'PATCH',
      { timeout: 10_000 }
    );
    await authedPage.locator('button[type="submit"]').click();

    // Wait for modal to close
    await expect(authedPage.locator('#feed-title')).not.toBeVisible({ timeout: 5_000 });

    // Verify the sources page now shows the custom title
    await expect(
      sourceRowByTitle(authedPage, customTitle)
    ).toBeVisible({ timeout: 10_000 });

    // Wait for the PATCH to actually complete so D1 is updated
    const patchResp = await patchPromise;
    expect(patchResp.status()).toBe(200);

    // Reload and verify persistence (round-trips through D1 → backend → IndexedDB).
    // Reload lands on /sources which doesn't initialize the store — bounce through
    // '/' to trigger appManager.initialize() and re-sync subscriptions from backend.
    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Everything' }).click();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();
    await expect(
      sourceRowByTitle(authedPage, customTitle)
    ).toBeVisible({ timeout: 15_000 });
  });

  test('clear custom title resets to original', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, {
      feedUrl: FEED_URL,
      title: FEED_TITLE,
      customTitle: 'Old Custom Title',
    });

    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();

    const row = sourceRowByTitle(authedPage, 'Old Custom Title');
    await expect(row).toBeVisible({ timeout: 15_000 });

    await openEditModal(authedPage, row);

    // The custom title input should have the current custom title
    const titleInput = authedPage.locator('#feed-title');
    await expect(titleInput).toHaveValue('Old Custom Title');

    // Click the Reset button next to the title field
    await authedPage.locator('.title-input-row .reset-btn').click();

    // The input should now be empty (placeholder shows original title)
    await expect(titleInput).toHaveValue('');

    // Save
    await authedPage.locator('button[type="submit"]').click();

    // Sources page should show the original title now
    await expect(
      sourceRowByTitle(authedPage, FEED_TITLE)
    ).toBeVisible({ timeout: 5_000 });
  });

  test('set custom icon URL shows preview', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });

    await authedPage.reload();
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await authedPage.locator('button.tab', { hasText: 'Websites' }).click();

    const row = sourceRowByTitle(authedPage, FEED_TITLE);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await openEditModal(authedPage, row);

    // Fill the custom icon URL
    const iconInput = authedPage.locator('#feed-icon');
    await expect(iconInput).toBeVisible();

    const iconUrl = 'https://example.com/icon.png';
    await iconInput.fill(iconUrl);

    // The preview image should update to show the custom icon URL
    const previewImg = authedPage.locator('.icon-preview img');
    await expect(previewImg).toHaveAttribute('src', iconUrl);
  });
});
