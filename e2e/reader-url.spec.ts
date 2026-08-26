import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedSavedArticle, type SeedSavedArticleOpts, type TestUser } from './seed';

// The reader is an overlay stack, not a route — but every level now rides a
// shallow-routed `?read=<item key>` URL, so a reading session survives a reload,
// can be linked, and Forward reopens what Back closed. These walk that contract
// through the history stack on the surface it matters most: Saved.

const TITLE = 'An Addressable Article';
const URL_ = 'https://example.com/addressable-article';
const BODY = Array.from(
  { length: 12 },
  (_, i) => `<p>Paragraph ${i} of an article you should be able to link to.</p>`
).join('');

async function seedArticle(user: TestUser, overrides: Partial<SeedSavedArticleOpts> = {}) {
  return seedSavedArticle(user, {
    url: URL_,
    title: TITLE,
    domain: 'example.com',
    contentType: 'article',
    content: BODY,
    wordCount: 400,
    ...overrides,
  });
}

/** The reader overlay, identified by the article body it renders full-screen. */
function reader(page: Page) {
  return page.locator('.reader-overlay');
}

function readParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get('read');
}

/**
 * The reader's Save control, by its title. The overlay mounts both chromes —
 * the desktop header row and the mobile bottom bar — and hides the one the
 * viewport isn't using, so two buttons carry the title but only one is on
 * screen. Match the one the reader is actually showing.
 */
function saveControl(page: Page, title: 'Unsave' | 'Save (s)') {
  return reader(page).getByTitle(title).filter({ visible: true });
}

test.describe('Reader URLs', () => {
  test('opening an article puts it in the URL, and a reload reopens it', async ({
    authedPage,
    testUser,
  }) => {
    await seedArticle(testUser);

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });

    // The key is the save's record uri; the surface (path) is unchanged.
    await expect(authedPage).toHaveURL(/\/saved\?read=/);
    const key = readParam(authedPage);
    expect(key).toContain('app.skyreader.feed.saved');
    // Exactly one read param, at every depth.
    expect(new URL(authedPage.url()).searchParams.getAll('read')).toHaveLength(1);
    // The tab (and so the history entry, and any shared link) is named after it.
    await expect(authedPage).toHaveTitle(new RegExp(TITLE));

    await authedPage.reload();
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });
    expect(readParam(authedPage)).toBe(key);
  });

  test('Back closes the reader and drops the param; Forward reopens it', async ({
    authedPage,
    testUser,
  }) => {
    await seedArticle(testUser);

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });

    await authedPage.goBack();
    await expect(reader(authedPage)).toBeHidden();
    await expect(authedPage).toHaveURL(/\/saved$/);

    await authedPage.goForward();
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });
    await expect(authedPage).toHaveURL(/\/saved\?read=/);
  });

  test('a deep link opens the reader, and Back lands on the list it belongs to', async ({
    authedPage,
    testUser,
  }) => {
    const rkey = await seedArticle(testUser);
    const key = `at://${testUser.did}/app.skyreader.feed.saved/${rkey}`;

    await authedPage.goto(`/saved?read=${encodeURIComponent(key)}`);
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.locator('.reader-overlay').getByText(TITLE).first()).toBeVisible();

    // The base entry is synthesized, so the single close path still works and
    // lands on the container list rather than leaving the app.
    await authedPage.goBack();
    await expect(reader(authedPage)).toBeHidden();
    await expect(authedPage).toHaveURL(/\/saved$/);
    await expect(authedPage.getByText(TITLE).first()).toBeVisible();
  });

  test('a link to an item this reader does not have says so and strips the param', async ({
    authedPage,
  }) => {
    await authedPage.goto('/saved?read=https%3A%2F%2Fexample.com%2Fnever-saved-here');

    await expect(authedPage.getByText('Article unavailable')).toBeVisible({ timeout: 20_000 });
    await expect(authedPage).toHaveURL(/\/saved$/);
    await expect(reader(authedPage)).toBeHidden();
  });

  test('opening a reader keeps the surface it was opened from', async ({
    authedPage,
    testUser,
  }) => {
    await seedArticle(testUser);

    // A channel view: the reader must not drop the ?view= that selects it.
    await authedPage.goto('/saved?view=nonexistent-channel');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });

    const url = new URL(authedPage.url());
    expect(url.pathname).toBe('/saved');
    expect(url.searchParams.get('view')).toBe('nonexistent-channel');
    expect(url.searchParams.get('read')).toBeTruthy();

    await authedPage.goBack();
    await expect(reader(authedPage)).toBeHidden();
    await expect(authedPage).toHaveURL('/saved?view=nonexistent-channel');
  });

  test('a link still opens on a surface whose list is empty, and Save works there', async ({
    authedPage,
    testUser,
  }) => {
    // A save made from a feed article: it carries the article's guid, which is
    // how a `?read=` restore finds it — and why it comes back typed 'saved'.
    const rkey = await seedArticle(testUser, { source: 'feed', itemGuid: URL_ });
    const key = `at://${testUser.did}/app.skyreader.feed.saved/${rkey}`;

    // This user has no subscriptions, so /feeds would render an empty state —
    // and an empty state hosts no reader stack for the link to land in.
    await authedPage.goto(`/feeds?read=${encodeURIComponent(key)}`);
    await expect(reader(authedPage)).toBeVisible({ timeout: 20_000 });
    await expect(authedPage.locator('.reader-overlay').getByText(TITLE).first()).toBeVisible();

    // Restored from a URL the item is the save it already is, not the feed
    // article — the reader's Save control has to know that and still act.
    const unsave = saveControl(authedPage, 'Unsave');
    await expect(unsave).toBeVisible();
    await unsave.click();
    await expect(saveControl(authedPage, 'Save (s)')).toBeVisible();
  });

  test('an unresolvable link on an empty surface says so and restores the empty state', async ({
    authedPage,
  }) => {
    await authedPage.goto('/feeds?read=https%3A%2F%2Fexample.com%2Fnever-seen-here');

    await expect(authedPage.getByText('Article unavailable')).toBeVisible({ timeout: 20_000 });
    await expect(authedPage).toHaveURL(/\/feeds$/);
    await expect(reader(authedPage)).toBeHidden();
    await expect(authedPage.getByText('Your library is empty')).toBeVisible();
  });

  test('the list under the reader keeps its scroll position on close', async ({
    authedPage,
    testUser,
  }) => {
    // Enough saves that the list scrolls, so a pagination reset triggered by the
    // reader's own URL write would be visible as a jump back to the top.
    for (let i = 0; i < 20; i++) {
      await seedSavedArticle(testUser, {
        url: `https://example.com/scroll/${i}`,
        title: `Scroll fixture ${i}`,
        domain: 'example.com',
        contentType: 'article',
        content: BODY,
        savedAt: Date.now() - i * 60_000,
      });
    }

    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Scroll fixture 0').first()).toBeVisible({ timeout: 15_000 });

    await authedPage.evaluate(() => window.scrollTo(0, 600));
    await expect
      .poll(() => authedPage.evaluate(() => Math.round(window.scrollY)))
      .toBeGreaterThan(400);
    const before = await authedPage.evaluate(() => Math.round(window.scrollY));

    await authedPage.getByText('Scroll fixture 8').first().click();
    await expect(reader(authedPage)).toBeVisible({ timeout: 15_000 });
    await authedPage.goBack();
    await expect(reader(authedPage)).toBeHidden();

    await expect
      .poll(() => authedPage.evaluate(() => Math.round(window.scrollY)))
      .toBeGreaterThan(before - 50);
    // The whole list is still rendered — the URL write must not have reset paging.
    await expect(authedPage.getByText('Scroll fixture 19').first()).toBeAttached();
  });
});
