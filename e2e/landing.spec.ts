import { test, expect } from './fixtures';

// The logged-out landing (WelcomePage.svelte). Its one piece of behavior is
// "Start reading": guest mode, seeded with the starter channels, opened on
// /feeds with no account. Everything else on the page is copy and links.
test.describe('Landing page', () => {
  test('says what Skyreader is, and Start reading opens the reader as a guest', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Read everything you follow.',
      { timeout: 15_000 }
    );
    await expect(page.getByRole('link', { name: 'Sign in with Bluesky' }).first()).toHaveAttribute(
      'href',
      '/auth/login'
    );

    await page.getByRole('button', { name: 'Start reading' }).first().click();
    await expect(page).toHaveURL(/\/feeds/, { timeout: 15_000 });
    expect(await page.evaluate(() => localStorage.getItem('skyreader-guest'))).not.toBeNull();
  });
});
