import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle } from './seed';

// "Come back to this": a save the reader asked to see again waits in Home's
// Back again lane once its day has come, and leaves when it's opened.
test.describe('Come back to this', () => {
  test('a due save is Back again on Home, and opening it takes it off', async ({
    authedPage,
    testUser,
  }) => {
    const url = 'https://example.com/worth-a-reread';
    await seedSavedArticle(testUser, {
      url,
      title: 'Worth A Reread',
      domain: 'example.com',
      content: '<p>Some pieces read differently the second time.</p>',
    });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/not-yet-due',
      title: 'Not Yet Due',
      domain: 'example.com',
      content: '<p>Later.</p>',
    });
    const day = 24 * 60 * 60 * 1000;
    await seedItemLabel(testUser, {
      itemKey: url,
      itemType: 'saved',
      label: 'resurface',
      props: JSON.stringify({ at: Date.now() - day, setAt: Date.now() - 30 * day }),
    });
    await seedItemLabel(testUser, {
      itemKey: 'https://example.com/not-yet-due',
      itemType: 'saved',
      label: 'resurface',
      props: JSON.stringify({ at: Date.now() + 14 * day, setAt: Date.now() }),
    });

    await authedPage.goto('/home');
    const lane = authedPage.getByRole('region', { name: 'Back again' });
    await expect(lane).toBeVisible({ timeout: 15_000 });
    await expect(lane.getByText('Worth A Reread')).toBeVisible();
    await expect(lane.getByText(/You asked to come back to this in/)).toBeVisible();
    await expect(lane.getByText('Not Yet Due')).toHaveCount(0);

    await lane.getByRole('button', { name: 'Worth A Reread' }).click();
    await expect(authedPage.getByText('Some pieces read differently')).toBeVisible();
    await authedPage.goBack();
    await expect(authedPage.getByRole('region', { name: 'Back again' })).toHaveCount(0);
  });

  test('asking from the Queue says when it comes back', async ({ authedPage, testUser }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/for-later',
      title: 'For Later',
      domain: 'example.com',
      content: '<p>Text.</p>',
    });

    await authedPage.goto('/saved');
    const card = authedPage.locator('.bookmark-card', { hasText: 'For Later' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.hover();
    await card.locator('.menu-trigger').click();
    await authedPage.getByRole('menuitem', { name: 'Come back to this' }).click();

    const dialog = authedPage.getByRole('dialog', { name: 'Come back to this' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /In 2 weeks/ }).click();
    await expect(authedPage.getByText(/It'll come back on/)).toBeVisible();

    await card.hover();
    await card.locator('.menu-trigger').click();
    await expect(authedPage.getByRole('menuitem', { name: /Comes back/ })).toBeVisible();
  });
});
