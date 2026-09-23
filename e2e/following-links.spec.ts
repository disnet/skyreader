import { test, expect } from './fixtures';
import { seedFollowLinks } from './seed';

// From your follows (docs/plans/FOLLOWS_LINKS_PLAN.md): the page asks for the
// timeline permission in place (never via the app-wide re-login banner), then
// lists what the people you follow shared, most-shared first. A hidden link
// stays hidden across a reload, because that state lives in D1.

const HOUR = 60 * 60 * 1000;

test.describe('From your follows', () => {
  test('asks for the timeline permission in the page, not the app banner', async ({
    authedPage,
  }) => {
    await authedPage.goto('/following');
    await expect(
      authedPage.getByRole('heading', { name: 'See what your follows are sharing' })
    ).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Allow access' })).toBeVisible();
    await expect(authedPage.locator('.scope-upgrade-banner')).toHaveCount(0);
  });

  test('lists links most-shared first, shows what people said, and remembers a hide', async ({
    authedPage,
    testUser,
  }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/solo',
        sharerDid: 'did:plc:sam',
        sharerName: 'Sam',
        title: 'Solo Piece',
      },
      {
        url: 'https://example.com/popular',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya',
        title: 'Popular Piece',
        text: 'Worth your whole afternoon.',
        ageMs: 2 * HOUR,
      },
      {
        url: 'https://example.com/popular',
        sharerDid: 'did:plc:ben',
        sharerName: 'Ben',
        ageMs: 3 * HOUR,
      },
      // Older than a day: only in the week window.
      {
        url: 'https://example.com/old',
        sharerDid: 'did:plc:kat',
        sharerName: 'Kat',
        title: 'Old Piece',
        ageMs: 40 * HOUR,
      },
    ]);

    await authedPage.goto('/following');
    const titles = authedPage.locator('.following-title');
    await expect(titles).toHaveText(['Popular Piece', 'Solo Piece']);

    await authedPage.getByRole('button', { name: /Maya and Ben shared this/ }).click();
    await expect(authedPage.getByText('Worth your whole afternoon.')).toBeVisible();

    await authedPage.getByRole('button', { name: 'Week' }).click();
    await expect(titles).toHaveText(['Popular Piece', 'Solo Piece', 'Old Piece']);

    const hidden = authedPage.waitForResponse(
      (r) => r.url().includes('/api/v2/following-links/state') && r.ok()
    );
    await authedPage
      .locator('.following-row', { hasText: 'Solo Piece' })
      .getByRole('button', { name: 'Hide this link' })
      .click();
    await hidden;
    await expect(titles).toHaveText(['Popular Piece', 'Old Piece']);

    await authedPage.reload();
    await expect(titles).toHaveText(['Popular Piece']);
  });

  test('puts the most-shared links on Home', async ({ authedPage, testUser }) => {
    await seedFollowLinks(testUser, [
      {
        url: 'https://example.com/home-lane',
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya Ortiz',
        title: 'Lane Piece',
      },
    ]);
    await authedPage.goto('/home');
    await expect(
      authedPage.getByRole('heading', { name: 'Shared by people you follow' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Lane Piece')).toBeVisible();
    await expect(authedPage.getByText('Maya shared')).toBeVisible();
  });
});
