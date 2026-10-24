import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle, type TestUser } from './seed';

// The highlights page is a library: narrow by view, tag, source and search, and
// pin and tag highlights in place. Pins and tags ride the highlights label like
// notes do, so they must survive a reload (i.e. reach D1).

const DAY = 24 * 60 * 60 * 1000;

async function seed(user: TestUser) {
  const articles = [
    {
      guid: 'lib-slow',
      title: 'The Craft of Slow Reading',
      highlights: [
        {
          id: 'hl-slow-1',
          exact: 'Reading slowly is a decision about attention.',
          tags: ['attention'],
        },
        { id: 'hl-slow-2', exact: 'We remember what we argue with.', note: 'Pairs with Adler' },
      ],
    },
    {
      guid: 'lib-garden',
      title: 'Digital Gardens and the Stream',
      highlights: [{ id: 'hl-garden-1', exact: 'The stream is optimised for recency.' }],
    },
  ];
  let n = 0;
  for (const article of articles) {
    await seedSavedArticle(user, {
      url: `https://example.com/${article.guid}`,
      title: article.title,
      itemGuid: article.guid,
      source: 'feed',
      domain: 'example.com',
      contentType: 'article',
    });
    await seedItemLabel(user, {
      itemKey: article.guid,
      itemType: 'article',
      label: 'highlights',
      props: JSON.stringify({
        highlights: article.highlights.map(({ exact, ...rest }) => ({
          ...rest,
          selector: { type: 'TextQuoteSelector', exact },
          createdAt: Date.now() - ++n * DAY,
        })),
      }).replaceAll("'", "''"),
    });
  }
}

const labelWrite = (page: import('@playwright/test').Page) =>
  page.waitForResponse(
    (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
  );

test.describe('highlights library', () => {
  test('filters by tag, source and search', async ({ authedPage, testUser }) => {
    await seed(testUser);
    await authedPage.goto('/highlights');
    const rail = authedPage.getByRole('complementary', { name: 'Filter highlights' });
    const list = authedPage.locator('.highlight-list');
    await expect(list.locator('.highlight-row')).toHaveCount(3, { timeout: 15_000 });

    await rail.getByRole('button', { name: /attention/ }).click();
    await expect(list.locator('.highlight-row')).toHaveCount(1);
    await expect(list).toContainText('Reading slowly');
    await authedPage.getByRole('button', { name: 'Clear', exact: true }).click();

    await rail.getByRole('button', { name: /Digital Gardens/ }).click();
    await expect(list.locator('.highlight-row')).toHaveCount(1);
    await expect(list).toContainText('optimised for recency');
    await authedPage.getByRole('button', { name: 'Clear', exact: true }).click();

    // Search reaches notes, not just the passage.
    await rail.getByRole('searchbox', { name: 'Search highlights' }).fill('adler');
    await expect(list.locator('.highlight-row')).toHaveCount(1);
    await expect(list).toContainText('argue with');

    await rail.getByRole('searchbox', { name: 'Search highlights' }).fill('nothing matches this');
    await expect(authedPage.getByText('No highlights match.')).toBeVisible();
  });

  test('a pin and a new tag survive a reload', async ({ authedPage, testUser }) => {
    await seed(testUser);
    await authedPage.goto('/highlights');
    const row = authedPage.locator('.highlight-row', { hasText: 'optimised for recency' });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.hover();
    let written = labelWrite(authedPage);
    await row.getByRole('button', { name: 'Pin to top' }).click();
    await written;

    const pinned = authedPage.locator('.pinned-card', { hasText: 'optimised for recency' });
    await expect(pinned).toBeVisible();

    await authedPage.locator('.highlight-row', { hasText: 'argue with' }).hover();
    await authedPage
      .locator('.highlight-row', { hasText: 'argue with' })
      .getByRole('button', { name: 'Tag' })
      .click();
    written = labelWrite(authedPage);
    await authedPage.getByRole('textbox', { name: 'Tag name' }).fill('memory');
    await authedPage.keyboard.press('Enter');
    await written;
    await authedPage.keyboard.press('Escape');

    await authedPage.reload();
    await expect(
      authedPage.locator('.pinned-card', { hasText: 'optimised for recency' })
    ).toBeVisible({ timeout: 15_000 });
    const rail = authedPage.getByRole('complementary', { name: 'Filter highlights' });
    await rail.getByRole('button', { name: /memory/ }).click();
    await expect(authedPage.locator('.highlight-list .highlight-row')).toHaveCount(1);
    await expect(authedPage.locator('.highlight-list')).toContainText('argue with');
  });
});
