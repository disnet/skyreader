import { test, expect } from './fixtures';

test.describe('Settings', () => {
  test('displays user info', async ({ authedPage, testUser }) => {
    await authedPage.goto('/settings');
    // Handle appears in both sidebar and settings page; use the main content area
    await expect(
      authedPage.getByRole('main').getByText('@' + testUser.handle)
    ).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByRole('main').getByText(testUser.did)).toBeVisible();
  });

  test('displays plan info', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await expect(authedPage.locator('.plan-name')).toHaveText('Free', { timeout: 10_000 });
    await expect(authedPage.getByText('Feed subscriptions')).toBeVisible();
  });

  test('font option buttons work', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await expect(authedPage.locator('.font-option').first()).toBeVisible({ timeout: 10_000 });

    // Click "Serif" option
    const serifButton = authedPage.locator('.font-option', { hasText: 'Serif' }).first();
    await serifButton.click();
    await expect(serifButton).toHaveClass(/selected/);
  });

  test('font size buttons work', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await expect(authedPage.locator('.font-size-option').first()).toBeVisible({ timeout: 10_000 });

    // Click "L" option
    const largeButton = authedPage.locator('.font-size-option', { hasText: 'L' }).first();
    await largeButton.click();
    await expect(largeButton).toHaveClass(/selected/);
  });

  test('logout shows confirm dialog', async ({ authedPage }) => {
    await authedPage.goto('/settings');

    // Dismiss the confirm dialog so the user stays on the page
    authedPage.on('dialog', (dialog) => dialog.dismiss());

    const logoutButton = authedPage.getByRole('button', { name: 'Log Out' });
    await expect(logoutButton).toBeVisible({ timeout: 10_000 });
    await logoutButton.click();

    // User should still be on settings page after dismissing
    await expect(authedPage).toHaveURL(/\/settings/);
  });
});
