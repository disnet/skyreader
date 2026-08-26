import { test, expect } from './fixtures';

test.describe('Settings', () => {
  test('displays user info', async ({ authedPage, testUser }) => {
    await authedPage.goto('/settings');
    // Handle appears in both sidebar and settings page; use the main content area
    await expect(authedPage.getByRole('main').getByText('@' + testUser.handle)).toBeVisible({
      timeout: 10_000,
    });
    await expect(authedPage.getByRole('main').getByText(testUser.did)).toBeVisible();
  });

  test('displays plan info', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await expect(authedPage.locator('.plan-name')).toHaveText('Free', {
      timeout: 10_000,
    });
    await expect(authedPage.getByText('Feed subscriptions')).toBeVisible();
  });

  test('font option buttons work', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    await expect(authedPage.locator('.font-option').first()).toBeVisible({
      timeout: 10_000,
    });

    // Click "Serif" option
    const serifButton = authedPage.locator('.font-option', { hasText: 'Serif' }).first();
    await serifButton.click();
    await expect(serifButton).toHaveClass(/selected/);
  });

  test('font size stepper works', async ({ authedPage }) => {
    await authedPage.goto('/settings');
    const readout = authedPage.locator('.size-readout');
    await expect(readout).toBeVisible({ timeout: 10_000 });

    // Read the current px value (readout renders e.g. "18px").
    const currentSize = async () =>
      parseInt(((await readout.textContent()) ?? '').replace(/[^0-9]/g, ''), 10);
    const before = await currentSize();

    // Bumping the size up increases the number by one step (2px).
    await authedPage.getByRole('button', { name: 'Increase font size' }).click();
    await expect(readout).toHaveText(`${before + 2}px`);
  });

  test('community highlights are enabled by default and can be turned off', async ({
    authedPage,
  }) => {
    await authedPage.goto('/settings');
    const toggle = authedPage.getByRole('checkbox', { name: 'Show community highlights' });

    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();

    await authedPage.reload();
    await expect(toggle).not.toBeChecked();
  });

  test('migrates the former implicit community highlights default to on', async ({
    authedPage,
  }) => {
    await authedPage.goto('/settings');
    await authedPage.evaluate(() => {
      localStorage.setItem(
        'skyreader-preferences',
        JSON.stringify({ communityHighlights: false, articleFont: 'serif' })
      );
    });
    await authedPage.reload();

    await expect(
      authedPage.getByRole('checkbox', { name: 'Show community highlights' })
    ).toBeChecked();
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
