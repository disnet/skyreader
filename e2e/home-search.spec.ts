import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle, type TestUser } from './seed';

const BODY_WORD = 'quokkatelemetry';

async function seedHomeLibrary(testUser: TestUser) {
  await seedSavedArticle(testUser, {
    url: 'https://example.com/gardening',
    title: 'Gardening Basics',
    domain: 'example.com',
    content: '<p>Tomatoes want sun and patience.</p>',
  });
  await seedSavedArticle(testUser, {
    url: 'https://example.com/ownership',
    title: 'Ownership Explained',
    domain: 'example.com',
    content: `<p>The body-only marker is ${BODY_WORD}.</p>`,
  });
  const archivedRkey = await seedSavedArticle(testUser, {
    url: 'https://example.com/sourdough',
    title: 'Sourdough Notes',
    domain: 'example.com',
    content: '<p>Feed the starter twice a day.</p>',
  });
  await seedItemLabel(testUser, {
    itemKey: `at://${testUser.did}/app.skyreader.feed.saved/${archivedRkey}`,
    itemType: 'saved',
    label: 'archived',
  });
}

test.describe('Home search', () => {
  test('replaces lanes with title and body results, then restores them on clear', async ({
    authedPage,
    testUser,
  }) => {
    await seedHomeLibrary(testUser);
    await authedPage.goto('/home');
    await expect(authedPage.getByLabel('Recently saved', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await authedPage.getByRole('button', { name: 'Search saved items' }).click();
    const input = authedPage.getByTestId('saved-search-input');
    await input.fill('gardening');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible();
    await expect(authedPage.getByLabel('Recently saved', { exact: true })).not.toBeVisible();

    await input.fill(BODY_WORD);
    await expect(authedPage.getByText('Ownership Explained')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.locator('mark', { hasText: BODY_WORD })).toBeVisible();

    await input.fill('');
    await expect(authedPage.getByLabel('Recently saved', { exact: true })).toBeVisible();
  });

  test('hands an archived-only query to the Saved archive', async ({ authedPage, testUser }) => {
    await seedHomeLibrary(testUser);
    await authedPage.goto('/home');
    await authedPage.locator('body').press('/');
    const input = authedPage.getByTestId('saved-search-input');
    await expect(input).toBeFocused();
    await input.fill('sourdough');

    const hint = authedPage.getByRole('button', { name: '1 match in your Saved archive' });
    await expect(hint).toBeVisible({ timeout: 10_000 });
    await hint.click();

    await expect(authedPage).toHaveURL(/\/saved$/);
    await expect(authedPage.getByText('Sourdough Notes')).toBeVisible();
    await expect(authedPage.getByTestId('saved-search-input')).toHaveValue('sourdough');
  });

  test.describe('on a mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('the bottom bar opens search', async ({ authedPage, testUser }) => {
      await seedHomeLibrary(testUser);
      await authedPage.goto('/home');
      await expect(authedPage.getByLabel('Recently saved', { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await authedPage.getByRole('button', { name: 'Search saved items' }).click();
      await expect(authedPage.getByTestId('saved-search-input')).toBeFocused();
    });
  });
});
