import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

test.describe('Saved Articles', () => {
  test('seeded saved article appears in saved view', async ({ authedPage, testUser }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/saved-article',
      title: 'My Saved Article',
      domain: 'example.com',
    });

    await authedPage.goto('/?saved=true');

    await expect(authedPage.getByText('My Saved Article')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('delete saved article via API', async ({ authedPage, testUser }) => {
    const rkey = await seedSavedArticle(testUser, {
      url: 'https://example.com/to-delete',
      title: 'Article To Delete',
      domain: 'example.com',
    });

    await authedPage.goto('/?saved=true');
    await expect(authedPage.getByText('Article To Delete')).toBeVisible({
      timeout: 15_000,
    });

    // Delete via API
    const response = await authedPage.request.delete(`http://127.0.0.1:8787/api/saved/${rkey}`);
    expect(response.status()).toBe(200);

    // Reload and verify it's gone
    await authedPage.reload();
    await expect(authedPage.getByText('Article To Delete')).not.toBeVisible({
      timeout: 10_000,
    });
  });

  test('empty saved view shows empty state', async ({ authedPage }) => {
    await authedPage.goto('/?saved=true');

    await expect(authedPage.getByText('Your Queue is empty')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('one menu switches the Queue between Inbox and Archive and sets the sort', async ({
    authedPage,
  }) => {
    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Your Queue is empty')).toBeVisible({ timeout: 15_000 });

    const trigger = authedPage.getByRole('button', { name: 'Showing Inbox, newest first' });
    await trigger.click();
    await authedPage.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(authedPage.getByText('Nothing archived yet')).toBeVisible();

    await authedPage.getByRole('button', { name: 'Showing Archive, newest first' }).click();
    await authedPage.getByRole('button', { name: 'Oldest first', exact: true }).click();
    await expect(
      authedPage.getByRole('button', { name: 'Showing Archive, oldest first' })
    ).toBeVisible();
    // Choosing closes the menu.
    await expect(authedPage.getByRole('button', { name: 'Newest first', exact: true })).toHaveCount(
      0
    );
  });
});
