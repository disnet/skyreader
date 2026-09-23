import { test, expect } from './fixtures';
import { seedFollowLinks, seedSavedArticle } from './seed';

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
      {
        url: 'https://example.com/week-old',
        sharerDid: 'did:plc:kat',
        sharerName: 'Kat',
        title: 'Week-old Piece',
        ageMs: 4 * 24 * HOUR,
      },
    ]);
    await authedPage.goto('/home');
    await expect(
      authedPage.getByRole('heading', { name: 'Shared by people you follow' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Lane Piece')).toBeVisible();
    await expect(authedPage.getByText('Maya shared')).toBeVisible();
    // The lane looks back a week, whatever window /following was left on.
    await expect(authedPage.getByText('Week-old Piece')).toBeVisible();

    // "View all" continues the same list: the page opens on the week.
    await authedPage
      .getByRole('region', { name: 'Shared by people you follow' })
      .getByRole('link', { name: 'View all' })
      .click();
    await expect(authedPage).toHaveURL(/\/following\?window=7d/);
    await expect(authedPage.getByRole('button', { name: 'Week', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(authedPage.locator('.following-title')).toHaveText([
      'Lane Piece',
      'Week-old Piece',
    ]);
  });

  test("leads an article's Discussion with the people you follow", async ({
    authedPage,
    testUser,
  }) => {
    const url = 'https://example.com/discussed';
    await seedSavedArticle(testUser, {
      url,
      title: 'A Discussed Piece',
      content: '<p>' + 'Words worth reading. '.repeat(60) + '</p>',
      wordCount: 180,
    });
    await seedFollowLinks(testUser, [
      {
        url,
        sharerDid: 'did:plc:maya',
        sharerName: 'Maya',
        text: 'The part about margins is the best bit.',
      },
      { url, sharerDid: 'did:plc:ben', sharerName: 'Ben', kind: 'repost', ageMs: 2 * HOUR },
    ]);

    await authedPage.goto('/?saved=true');
    await authedPage.getByText('A Discussed Piece').first().click({ timeout: 15_000 });

    const discussion = authedPage.locator('section.reader-discussion');
    await discussion.scrollIntoViewIfNeeded();
    // Maya said something, so she's a row with her words and the mark.
    const row = discussion.locator('li.entry', { hasText: 'Maya' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('You follow')).toBeVisible();
    await expect(row.getByText('The part about margins is the best bit.')).toBeVisible();
    // Ben only reposted: no words of his own, so he's in the linked-by line.
    await expect(discussion.locator('.also-linked')).toContainText('Ben');
  });
});
