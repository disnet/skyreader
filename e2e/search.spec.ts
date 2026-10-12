import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  cleanupFeedItems,
  disableSearch,
  enableSearchFor,
  enableSearchSwitch,
  seedFeedItems,
  seedItemLabel,
  seedSavedArticle,
  seedSubscription,
  type TestUser,
} from './seed';

// Full-text search (Supporter): the `/` shortcut, the search overlay, the mobile
// bottom-bar button, and opening a hit in the reader. The index is the reader's own Durable Object on the dev
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

  test('/ opens search over the page; a read article is found by its body and opens in the reader', async ({
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
    await expect(authedPage.getByTestId('search-overlay')).toBeVisible();
    await expect(authedPage).toHaveURL(/\/feeds/);
    await expect(searchInput(authedPage)).toBeFocused();

    await searchInput(authedPage).fill(READ_WORD);
    const hit = authedPage.locator('.hit-open', { hasText: 'A morning dive' });
    await expect(hit).toBeVisible({ timeout: 15_000 });
    await expect(hit.locator('mark')).toHaveText(READ_WORD);

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

    // Back closes the reader onto the results, then closes search onto the page.
    await authedPage.goBack();
    await expect(authedPage.locator('.reader-overlay')).toHaveCount(0);
    await expect(hit).toBeVisible();
    await authedPage.keyboard.press('Escape');
    await authedPage.keyboard.press('Escape');
    await expect(authedPage.getByTestId('search-overlay')).toHaveCount(0);
    await expect(authedPage).not.toHaveURL(/[?&]read=/);
  });

  test('on a phone, the bottom bar opens search full screen', async ({ authedPage, testUser }) => {
    await enableSearchFor(testUser);
    await authedPage.setViewportSize({ width: 390, height: 844 });

    await authedPage.goto('/feeds');
    await authedPage.waitForLoadState('networkidle');
    await authedPage.locator('.mobile-bottom-bar').getByRole('button', { name: 'Search' }).click();
    await expect(searchInput(authedPage)).toBeVisible();

    await authedPage.getByRole('button', { name: 'Cancel' }).click();
    await expect(authedPage.getByTestId('search-overlay')).toHaveCount(0);
  });

  test('without search, / keeps opening the switcher and /search explains the plan', async ({
    authedPage,
  }) => {
    await authedPage.goto('/feeds');
    await authedPage.waitForLoadState('networkidle');
    await authedPage.keyboard.press('/');
    await expect(authedPage.getByTestId('search-overlay')).toHaveCount(0);

    // An old /search link lands on the default view with search open over it.
    await authedPage.goto('/search');
    await expect(authedPage.getByText('Find anything you’ve read')).toBeVisible();
    await expect(searchInput(authedPage)).toHaveCount(0);
  });

  test('the Supporter page lists search only once it is live here', async ({ authedPage }) => {
    const benefit = authedPage.getByText('Search everything you’ve read').first();

    await authedPage.goto('/supporter');
    await expect(authedPage.getByText('Newsletters by email').first()).toBeVisible();
    await expect(benefit).toHaveCount(0);

    await enableSearchSwitch();
    await authedPage.reload();
    await expect(benefit).toBeVisible({ timeout: 15_000 });
  });
});
