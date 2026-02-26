import { test, expect } from './fixtures';
import { seedSubscription } from './seed';

test.describe('Custom Fields', () => {
  const FEED_URL = 'https://example.com/feed.xml';
  const FEED_TITLE = 'Example Feed';

  test('edit custom title via sidebar context menu', async ({ authedPage, testUser }) => {
    // Seed a subscription so it shows up in the sidebar
    seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });

    // Reload to pick up the seeded subscription from the backend
    await authedPage.reload();

    // Wait for the feed to appear in the sidebar
    const feedItem = authedPage.locator('.nav-label', { hasText: FEED_TITLE });
    await expect(feedItem).toBeVisible({ timeout: 15_000 });

    // Right-click to open context menu
    await feedItem.click({ button: 'right' });

    // Click "Edit" in the context menu
    const editButton = authedPage.locator('.context-menu-item', { hasText: 'Edit' });
    await expect(editButton).toBeVisible();
    await editButton.click();

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

    // Verify the sidebar now shows the custom title
    const customFeedItem = authedPage.locator('.nav-label', { hasText: customTitle });
    await expect(customFeedItem).toBeVisible({ timeout: 10_000 });

    // Wait for the PATCH to actually complete so D1 is updated
    const patchResp = await patchPromise;
    expect(patchResp.status()).toBe(200);

    // Reload and verify persistence (round-trips through D1 → backend → IndexedDB)
    await authedPage.reload();
    await expect(
      authedPage.locator('.nav-label', { hasText: customTitle })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('clear custom title resets to original', async ({ authedPage, testUser }) => {
    // Seed a subscription with a custom title already set
    seedSubscription(testUser, {
      feedUrl: FEED_URL,
      title: FEED_TITLE,
      customTitle: 'Old Custom Title',
    });

    await authedPage.reload();

    // Wait for the feed to appear with the custom title
    const feedItem = authedPage.locator('.nav-label', { hasText: 'Old Custom Title' });
    await expect(feedItem).toBeVisible({ timeout: 15_000 });

    // Right-click → Edit
    await feedItem.click({ button: 'right' });
    await authedPage.locator('.context-menu-item', { hasText: 'Edit' }).click();

    // The custom title input should have the current custom title
    const titleInput = authedPage.locator('#feed-title');
    await expect(titleInput).toHaveValue('Old Custom Title');

    // Click the Reset button next to the title field
    await authedPage.locator('.title-input-row .reset-btn').click();

    // The input should now be empty (placeholder shows original title)
    await expect(titleInput).toHaveValue('');

    // Save
    await authedPage.locator('button[type="submit"]').click();

    // Sidebar should show the original title now
    await expect(
      authedPage.locator('.nav-label', { hasText: FEED_TITLE })
    ).toBeVisible({ timeout: 5_000 });
  });

  test('set custom icon URL shows preview', async ({ authedPage, testUser }) => {
    seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });

    await authedPage.reload();

    const feedItem = authedPage.locator('.nav-label', { hasText: FEED_TITLE });
    await expect(feedItem).toBeVisible({ timeout: 15_000 });

    // Right-click → Edit
    await feedItem.click({ button: 'right' });
    await authedPage.locator('.context-menu-item', { hasText: 'Edit' }).click();

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
