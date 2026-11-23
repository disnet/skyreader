import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// A cold start paints Home's lanes as they were last time (utils/homeSnapshot.ts)
// instead of skeleton lanes that fill in a beat later.
test.describe('Home first paint', () => {
  test('a return visit paints last time’s tiles, never the skeleton', async ({
    authedPage,
    testUser,
  }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/first-paint',
      title: 'Painted On The First Frame',
      domain: 'example.com',
      content: '<p>One.</p>',
      savedAt: Date.now() - 60_000,
    });

    await authedPage.goto('/home');
    const recent = authedPage.getByRole('region', { name: 'Recently saved' });
    await expect(recent.getByText('Painted On The First Frame')).toBeVisible({ timeout: 15_000 });
    // The snapshot is written a moment after the live lanes settle.
    await expect
      .poll(
        () =>
          authedPage.evaluate(() =>
            Object.keys(localStorage).some((k) => k.startsWith('skyreader-home-snapshot:'))
          ),
        { timeout: 10_000 }
      )
      .toBe(true);

    // Watch every frame of the next load for skeleton tiles.
    await authedPage.addInitScript(() => {
      const w = window as unknown as { __sawSkeleton: boolean };
      w.__sawSkeleton = false;
      new MutationObserver(() => {
        if (document.querySelector('.skeleton-card')) w.__sawSkeleton = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await authedPage.reload();
    await expect(recent.getByText('Painted On The First Frame')).toBeVisible({ timeout: 15_000 });
    // Let the live lanes take over from the snapshot.
    await authedPage.waitForTimeout(1500);
    await expect(recent.getByText('Painted On The First Frame')).toBeVisible();
    expect(
      await authedPage.evaluate(
        () => (window as unknown as { __sawSkeleton: boolean }).__sawSkeleton
      )
    ).toBe(false);
  });
});
