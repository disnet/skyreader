import { test, expect } from './fixtures';
import { seedSubscription } from './seed';

// Folders hold any kind of source, not only RSS feeds: a newsletter filed
// beside a feed shows in that folder on Manage Sources and in the sidebar.
test.describe('Folders for every source type', () => {
  test('files a newsletter into a folder alongside a feed', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/folders-feed.xml',
      title: 'Folder Feed',
      category: 'Climate',
    });
    await seedSubscription(testUser, {
      feedUrl: 'newsletter:inbox/letters@example.com',
      title: 'Folder Letter',
      sourceType: 'email.newsletter',
    });

    await authedPage.goto('/sources');
    const letter = authedPage.locator('.source-row', { hasText: 'Folder Letter' });
    await expect(letter).toBeVisible({ timeout: 15_000 });

    await authedPage.getByRole('button', { name: 'Select', exact: true }).click();
    await letter.locator('.row-checkbox input').check();

    await authedPage.getByRole('button', { name: /Add to folder/ }).click();
    const patched = authedPage.waitForResponse(
      (r) => r.url().includes('/api/subscriptions') && r.request().method() !== 'GET'
    );
    await authedPage.locator('.assign-item', { hasText: 'Climate' }).click();
    expect((await patched).ok()).toBe(true);

    // On Manage Sources the newsletter now sits under its folder, in its own section.
    const newsletters = authedPage.locator('.sources-section', { hasText: 'Newsletters' });
    await expect(newsletters.locator('.group', { hasText: 'Climate' })).toContainText(
      'Folder Letter'
    );

    // It sticks across a reload.
    await authedPage.reload();
    await expect(
      authedPage
        .locator('.sources-section', { hasText: 'Newsletters' })
        .locator('.group', { hasText: 'Climate' })
    ).toContainText('Folder Letter', { timeout: 15_000 });
  });
});
