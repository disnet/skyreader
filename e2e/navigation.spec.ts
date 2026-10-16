import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('sidebar shows all nav items', async ({ authedPage }) => {
    await expect(authedPage.locator('.nav-label', { hasText: 'Feeds' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.locator('.nav-label', { hasText: 'Library' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Manage Sources' })).toBeVisible();
    await expect(authedPage.locator('.nav-label', { hasText: 'Settings' })).toBeVisible();
  });

  test('clicking Library opens the Queue', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Library' }).click();
    await expect(authedPage).toHaveURL(/\/saved/);
  });

  test('the Library switch moves between Queue and Shelf', async ({ authedPage }) => {
    await authedPage.goto('/saved');
    const library = authedPage.getByRole('navigation', { name: 'Library' });
    await expect(library.getByRole('link', { name: 'Queue' })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: 15_000 }
    );
    await library.getByRole('link', { name: 'Shelf' }).click();
    await expect(authedPage).toHaveURL(/\/shelf/);
    await expect(
      authedPage.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: 'Shelf' })
    ).toHaveAttribute('aria-current', 'page');
  });

  test('Settings link navigates to /settings', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Settings' }).click();
    await expect(authedPage).toHaveURL(/\/settings/);
    await expect(authedPage.locator('h2', { hasText: 'Account' })).toBeVisible({
      timeout: 10_000,
    });
  });
});
