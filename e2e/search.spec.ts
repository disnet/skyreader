import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  cleanupFeedItems,
  disableSearch,
  enableSearchFor,
  seedFeedItems,
  seedItemLabel,
  seedSavedArticle,
  seedSubscription,
  type TestUser,
} from './seed';

// Full-text search (Supporter): the `/` shortcut, the /search page, and opening
// a hit in the reader. The index is the reader's own Durable Object on the dev
// backend; the first search syncs it from D1, so seeded rows are findable at once.

const FEED_URL = `https://search-e2e-${Date.now()}.example/feed.xml`;
// Words that appear only in bodies, so a hit proves the body was indexed.
const READ_WORD = 'bathyscaphe';
const SAVED_WORD = 'phosphorescence';

async function seedReadArticle(user: TestUser) {
  await seedSubscription(user, { feedUrl: FEED_URL, title: 'Deep Sea Notes' });
  await seedFeedItems(
    FEED_URL,
    [
      {
        guid: 'search-e2e-dive',
        title: 'A morning dive',
        url: 'https://deepsea.example/dive',
        content: `<p>We went down in the ${READ_WORD} at dawn.</p>`,
      },
    ],
    { title: 'Deep Sea Notes' }
  );
  await seedItemLabel(user, {
    itemKey: 'search-e2e-dive',
    itemType: 'article',
    label: 'read',
    props: JSON.stringify({
      readAt: Date.now(),
      itemUrl: 'https://deepsea.example/dive',
      itemTitle: 'A morning dive',
    }),
  });
}

function searchInput(page: Page) {
  return page.getByTestId('search-input');
}

test.describe('Full-text search', () => {
  test.afterEach(async () => {
    await disableSearch();
    await cleanupFeedItems(FEED_URL);
  });

  test('/ opens search from anywhere; a read article is found by its body and opens in the reader', async ({
    authedPage,
    testUser,
  }) => {
    await enableSearchFor(testUser);
    await seedReadArticle(testUser);
    await seedSavedArticle(testUser, {
      url: 'https://elsewhere.example/glow',
      title: 'Things that glow',
      content: `<p>On ${SAVED_WORD} in the open ocean.</p>`,
    });

    await authedPage.goto('/feeds');
    await authedPage.waitForLoadState('networkidle');
    await authedPage.keyboard.press('/');
    await expect(authedPage).toHaveURL(/\/search/);
    await expect(searchInput(authedPage)).toBeFocused();

    await searchInput(authedPage).fill(READ_WORD);
    const hit = authedPage.locator('.hit-open', { hasText: 'A morning dive' });
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await expect(hit.locator('mark')).toHaveText(READ_WORD);
    await expect(authedPage).toHaveURL(new RegExp(`[?&]q=${READ_WORD}`));

    // Filtering to saved leaves the read-only article out.
    await authedPage.getByRole('radio', { name: 'Saved' }).click();
    await expect(authedPage.getByText(`Nothing matches “${READ_WORD}” in saved.`)).toBeVisible();

    await searchInput(authedPage).fill(SAVED_WORD);
    await expect(authedPage.locator('.hit-open', { hasText: 'Things that glow' })).toBeVisible({
      timeout: 15_000,
    });

    await authedPage.getByRole('radio', { name: 'Everything' }).click();
    await searchInput(authedPage).fill(READ_WORD);
    await hit.click();
    await expect(authedPage.locator('.reader-overlay')).toBeVisible({ timeout: 15_000 });
    await expect(authedPage).toHaveURL(/[?&]read=search-e2e-dive/);
  });

  test('without search, / keeps opening the switcher and /search explains the plan', async ({
    authedPage,
  }) => {
    await authedPage.goto('/feeds');
    await authedPage.waitForLoadState('networkidle');
    await authedPage.keyboard.press('/');
    await expect(authedPage).not.toHaveURL(/\/search/);

    await authedPage.goto('/search');
    await expect(authedPage.getByText('Find anything you’ve read')).toBeVisible();
    await expect(searchInput(authedPage)).toHaveCount(0);
  });
});
