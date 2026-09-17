import { test, expect } from './fixtures';
import { cleanupFeedItems, seedFeedItems, seedSubscription } from './seed';

// The mobile switcher and the collapsed card are the two surfaces the view-switch
// speed work touched. Both changes are invisible when they work and invisible
// when they break, so pin the behavior they're allowed to keep:
//  - the sheet stays mounted between opens (and must be inert while hidden),
//  - selecting a row navigates even though `goto` now runs a frame after close,
//  - a collapsed card's body is no longer sanitized eagerly, so the expand
//    affordance and the rendered HTML have to still be there when it opens.
test.use({ viewport: { width: 393, height: 727 }, hasTouch: true });

const FEED_URL = 'https://example.com/mobile-switcher.xml';
const FEED_TITLE = 'Switcher Feed';

function longBody() {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `<p class="body-para">Body paragraph ${index + 1}: ${'reading context '.repeat(12)}</p>`
  ).join('');
}

test.describe('Mobile switcher', () => {
  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  test.beforeEach(async ({ testUser }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'switcher-item-1',
          url: 'https://example.com/switcher-1',
          title: 'Switcher Article One',
          summary: 'Summary one '.repeat(40),
          content: longBody(),
        },
        {
          guid: 'switcher-item-2',
          url: 'https://example.com/switcher-2',
          title: 'Switcher Article Two',
          summary: 'Summary two '.repeat(40),
          content: '<p class="body-para">Short body two</p>',
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
  });

  test('selecting Saved navigates and marks the row active', async ({ authedPage }) => {
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText('Switcher Article One', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await authedPage.getByRole('button', { name: 'Switch feed' }).click();

    const savedRow = authedPage.locator('.feed-switcher .nav-item-row', {
      has: authedPage.locator('.item-label', { hasText: 'Saved' }),
    });
    await expect(savedRow).toBeVisible({ timeout: 5_000 });
    await savedRow.locator('.nav-item-main').click();

    // `goto` is deferred a frame behind the sheet dismissal, so the navigation
    // still has to land — this is the assertion that the deferral didn't drop it.
    await expect(authedPage).toHaveURL(/\/saved/, { timeout: 10_000 });

    // Reopening shows Saved as the active row.
    await authedPage.getByRole('button', { name: 'Switch feed' }).click();
    await expect(savedRow).toHaveClass(/active/, { timeout: 5_000 });
  });

  test('keeps the sheet mounted between opens, and inert while closed', async ({ authedPage }) => {
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText('Switcher Article One', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const portal = authedPage.locator('.bottom-sheet-portal');
    await expect(portal).toHaveCount(0);

    await authedPage.getByRole('button', { name: 'Switch feed' }).click();
    await expect(portal).toHaveClass(/shown/, { timeout: 5_000 });
    await expect(authedPage.locator('.feed-switcher')).toBeVisible();

    // Dismiss via the backdrop.
    await authedPage.locator('.bottom-sheet-portal .backdrop').click({ force: true });

    // Still in the DOM (that's what makes the next open free) but hidden, out of
    // the tab order, and out of the accessibility tree.
    await expect(portal).toHaveCount(1);
    await expect(portal).not.toHaveClass(/shown/);
    await expect(authedPage.locator('.feed-switcher')).toBeHidden();
    expect(await portal.evaluate((el) => (el as HTMLElement).inert)).toBe(true);
    await expect(authedPage.locator('.feed-switcher .search-input')).not.toBeFocused();

    await authedPage.getByRole('button', { name: 'Switch feed' }).click();
    await expect(portal).toHaveClass(/shown/, { timeout: 5_000 });
    expect(await portal.evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  });

  test('a search inside the switcher does not survive a reopen', async ({ authedPage }) => {
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText('Switcher Article One', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    await authedPage.getByRole('button', { name: 'Switch feed' }).click();
    const search = authedPage.locator('.feed-switcher .search-input');
    await search.fill('switcher');
    await expect(search).toHaveValue('switcher');

    await authedPage.locator('.bottom-sheet-portal .backdrop').click({ force: true });
    await authedPage.getByRole('button', { name: 'Switch feed' }).click();
    await expect(search).toHaveValue('');
  });
});

test.describe('Collapsed card body', () => {
  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  // A collapsed card renders no body at all, so its HTML is no longer sanitized
  // on mount. The measurement that drives the "More" affordance was the one
  // thing still forcing that work — this asserts it still runs once the card is
  // actually open, and that the body renders as HTML rather than escaped text.
  test('still expands, measures truncation, and renders HTML', async ({ authedPage, testUser }) => {
    // Expand-all is the product default. This scenario specifically exercises
    // the collapsed-card path, so opt out before the app initializes rather
    // than asserting against a state the default configuration never enters.
    await authedPage.addInitScript(() => {
      const stored = localStorage.getItem('skyreader-preferences');
      const preferences = stored ? JSON.parse(stored) : {};
      localStorage.setItem(
        'skyreader-preferences',
        JSON.stringify({ ...preferences, expandAllItems: false })
      );
    });
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'switcher-item-1',
          url: 'https://example.com/switcher-1',
          title: 'Switcher Article One',
          summary: 'Summary one '.repeat(40),
          content: longBody(),
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );

    await authedPage.goto('/feeds');
    const title = authedPage.getByText('Switcher Article One', { exact: true });
    await expect(title).toBeVisible({ timeout: 15_000 });

    const card = authedPage.locator('.article-item-anchor', { has: title });

    // Closed: no body in the DOM.
    await expect(card.locator('.article-body')).toHaveCount(0);

    await title.click();

    // Open: the body is real HTML (paragraph elements), not escaped markup.
    const body = card.locator('.article-body');
    await expect(body).toBeVisible({ timeout: 10_000 });
    await expect(body.locator('p.body-para').first()).toBeVisible();

    // The clamped preview overflows, so the "More" affordance is live — that
    // enabled state IS the truncation measurement, which is what the lazy
    // sanitize had to keep working.
    const more = card.locator('button.show-more-btn');
    await expect(more).toBeVisible({ timeout: 10_000 });
    await expect(more).not.toHaveClass(/disabled/, { timeout: 10_000 });
    await more.click();
    await expect(card.locator('.article-item.expanded')).toHaveCount(1);
  });
});
