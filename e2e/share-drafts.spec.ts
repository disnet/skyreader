import { test, expect } from './fixtures';
import { seedShareDraft } from './seed';

// Share drafts are durable and cross-device: D1 is the store of record and
// IndexedDB is a cache. These specs exercise the two directions of that claim
// against the real backend — a draft written elsewhere shows up here, and a
// draft discarded here stays discarded after the cache is gone.

const ARTICLE_URL = 'https://example.com/drafts/cross-device';
const ARTICLE_TITLE = 'A Piece Worth Linking';
const DRAFT_TEXT = 'Started this on the phone and never finished the thought.';

/** Wipe the Dexie cache so the next load has nothing but the server to go on. */
async function evictCache(page: import('@playwright/test').Page) {
  // The delete is queued behind this document's open connection; the reload
  // closes it, the delete runs, and the fresh document then opens an empty DB.
  await page.evaluate(() => {
    indexedDB.deleteDatabase('skyreader');
  });
  await page.reload();
}

test.describe('Share drafts', () => {
  test('a draft written on another device appears here, and survives an evicted cache', async ({
    authedPage,
    testUser,
  }) => {
    await seedShareDraft(testUser, {
      articleUrl: ARTICLE_URL,
      articleTitle: ARTICLE_TITLE,
      text: DRAFT_TEXT,
    });

    await authedPage.goto('/linkblog');

    // The entry renders in the draft shape — chip, headline, the words typed
    // elsewhere. Generous timeout: the drafts sync rides the background refresh.
    const entry = authedPage.locator('article.entry.draft');
    await expect(entry).toHaveCount(1, { timeout: 15_000 });
    await expect(entry.getByText(ARTICLE_TITLE)).toBeVisible();
    await expect(entry.getByText(DRAFT_TEXT)).toBeVisible();

    // Nothing about this came from IndexedDB the first time, but prove it can't
    // have: wipe the cache and load again.
    await evictCache(authedPage);
    await expect(authedPage.locator('article.entry.draft')).toHaveCount(1, { timeout: 15_000 });
    await expect(authedPage.getByText(DRAFT_TEXT)).toBeVisible();
  });

  test('discarding a draft tombstones it on the server', async ({ authedPage, testUser }) => {
    await seedShareDraft(testUser, {
      articleUrl: ARTICLE_URL,
      articleTitle: ARTICLE_TITLE,
      text: DRAFT_TEXT,
    });

    await authedPage.goto('/linkblog');
    const entry = authedPage.locator('article.entry.draft');
    await expect(entry).toHaveCount(1, { timeout: 15_000 });

    // Discard is two-step (arm, then confirm) — the same one-way-action pattern
    // the rest of the linkblog uses.
    const deleteRequest = authedPage.waitForResponse(
      (res) => res.url().includes('/api/linkblog/drafts') && res.request().method() === 'DELETE'
    );
    await entry.locator('.menu-trigger').click();
    await authedPage.getByRole('menuitem', { name: 'Discard draft' }).click();
    await authedPage.getByRole('menuitem', { name: 'Discard draft?' }).click();
    await deleteRequest;

    await expect(authedPage.locator('article.entry.draft')).toHaveCount(0);

    // The delete has to have reached D1, not just the local cache: come back
    // with an empty cache and the draft must still be gone.
    await evictCache(authedPage);
    await expect(authedPage.locator('article.entry.draft')).toHaveCount(0);
    await expect(authedPage.getByText(DRAFT_TEXT)).toHaveCount(0);
  });
});
