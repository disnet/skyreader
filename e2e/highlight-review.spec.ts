import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle, type TestUser } from './seed';

// Highlight review: the deck is derived at open from the least-recently-reviewed
// highlights, and "already reviewed today" is a `lastReviewedAt` stamp written
// back into the highlights label. These cover the loop end to end — Home entry
// card → session → the stamp reaching D1 → deck gone on reload.

const ARTICLE_URL = 'https://example.com/review/source';
const ARTICLE_GUID = 'review-article-guid';
const DECK_SIZE = 5;

// Well past the 24 h freshness filter, so every seeded highlight is eligible.
const OLD = Date.now() - 30 * 24 * 60 * 60 * 1000;

function highlights(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `hl-${i + 1}`,
    selector: { type: 'TextQuoteSelector', exact: `Seeded highlight number ${i + 1}` },
    createdAt: OLD + i,
  }));
}

async function seedHighlights(user: TestUser, count: number) {
  await seedSavedArticle(user, {
    url: ARTICLE_URL,
    title: 'The Highlighted Article',
    itemGuid: ARTICLE_GUID,
    source: 'feed',
    domain: 'example.com',
    contentType: 'article',
  });
  await seedItemLabel(user, {
    itemKey: ARTICLE_GUID,
    itemType: 'article',
    label: 'highlights',
    props: JSON.stringify({ highlights: highlights(count) }).replaceAll("'", "''"),
  });
}

test.describe('highlight review', () => {
  test('Home offers a deck, the session completes, and the stamp lands in D1', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, DECK_SIZE + 2);

    await authedPage.goto('/home');
    const start = authedPage.getByRole('link', { name: `Review ${DECK_SIZE} highlights` });
    await expect(start).toBeVisible({ timeout: 15_000 });
    await start.click();

    await expect(authedPage.getByText(`1 of ${DECK_SIZE}`)).toBeVisible();

    // Advancing writes the whole highlights array back through PATCH-equivalent
    // POST /api/labels. Wait on the response so D1 has the stamp before reload.
    for (let card = 1; card <= DECK_SIZE; card++) {
      await expect(authedPage.getByText(`${card} of ${DECK_SIZE}`)).toBeVisible();
      const written = authedPage.waitForResponse(
        (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
      );
      await authedPage
        .getByRole('button', { name: card === DECK_SIZE ? 'Finish' : 'Next' })
        .click();
      await written;
    }

    await expect(authedPage.getByRole('heading', { name: "That's your review" })).toBeVisible();
    await expect(
      authedPage.getByText(`${DECK_SIZE} highlights revisited`, { exact: false })
    ).toBeVisible();

    // Only 2 highlights are left unreviewed today, so the next deck is smaller —
    // proof the stamp survived the round trip rather than the deck resetting.
    await authedPage.goto('/home');
    await expect(authedPage.getByRole('link', { name: 'Review 2 highlights' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the Home card disappears once every highlight was reviewed today', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 2);

    await authedPage.goto('/home');
    const start = authedPage.getByRole('link', { name: 'Review 2 highlights' });
    await expect(start).toBeVisible({ timeout: 15_000 });
    await start.click();

    for (const label of ['Next', 'Finish']) {
      const written = authedPage.waitForResponse(
        (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
      );
      await authedPage.getByRole('button', { name: label }).click();
      await written;
    }

    await expect(authedPage.getByRole('heading', { name: "That's your review" })).toBeVisible();

    await authedPage.goto('/home');
    // Give the lanes time to render, then assert the review panel is absent.
    await expect(authedPage.getByRole('link', { name: /^Review \d+ highlight/ })).toHaveCount(0);

    // The deck itself reports it, calmly, rather than dealing the same cards again.
    await authedPage.goto('/highlights/review');
    await expect(
      authedPage.getByRole('heading', { name: 'Nothing to review right now' })
    ).toBeVisible({ timeout: 15_000 });
  });

  test('the nav carries a quiet count that clears when the deck is done', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, DECK_SIZE + 2);

    await authedPage.goto('/home');
    // Label + count: today's deck, not the whole corpus (7 highlights seeded).
    const nav = authedPage.getByRole('link', { name: `Review ${DECK_SIZE}`, exact: true });
    await expect(nav).toBeVisible({ timeout: 15_000 });
    await nav.click();

    for (let card = 1; card <= DECK_SIZE; card++) {
      const written = authedPage.waitForResponse(
        (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
      );
      await authedPage
        .getByRole('button', { name: card === DECK_SIZE ? 'Finish' : 'Next' })
        .click();
      await written;
    }

    // 2 highlights still unreviewed today, so the count shrinks rather than clearing.
    await expect(authedPage.getByRole('link', { name: 'Review 2', exact: true })).toBeVisible();
  });

  test('the mobile bottom bar is the way off the deck', async ({ authedPage, testUser }) => {
    await seedHighlights(testUser, DECK_SIZE);
    await authedPage.setViewportSize({ width: 390, height: 844 });

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText(`1 of ${DECK_SIZE}`)).toBeVisible({ timeout: 15_000 });

    // The installed PWA has no back button, so the bar's switcher is the only
    // in-app way out of the deck.
    const bar = authedPage.locator('.mobile-bottom-bar');
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Switch feed' })).toContainText('Review');

    // The card clears the bar rather than sitting under it.
    const gap = await authedPage.evaluate(() => {
      const card = document.querySelector('.review-body .card');
      const chrome = document.querySelector('.mobile-bottom-bar');
      if (!card || !chrome) return null;
      return chrome.getBoundingClientRect().top - card.getBoundingClientRect().bottom;
    });
    expect(gap).not.toBeNull();
    expect(gap!).toBeGreaterThan(0);

    await bar.getByRole('button', { name: 'Switch feed' }).click();
    await authedPage.getByRole('button', { name: 'Highlights', exact: true }).click();
    await expect(authedPage).toHaveURL(/\/highlights$/);
  });

  test('the gear opens the deck settings, and resizing redeals an untouched deck', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, DECK_SIZE + 2);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText(`1 of ${DECK_SIZE}`)).toBeVisible({ timeout: 15_000 });

    const gear = authedPage.getByRole('button', { name: 'Review settings' });
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
    await gear.click();

    const deckSize = authedPage.getByLabel('Review deck');
    await expect(deckSize).toBeVisible();
    await expect(authedPage.getByText('Bring in highlights from Margin')).toBeVisible();

    // Nothing has been reviewed yet, so a resize applies to the hand on screen
    // rather than silently waiting for the next session.
    await deckSize.selectOption('3');
    await expect(authedPage.getByText('1 of 3')).toBeVisible();

    // Once the reader is under way the dealt deck is theirs to finish: the new
    // size waits for the next session instead of reshuffling mid-deck.
    await gear.click();
    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: 'Next' }).click();
    await written;
    await expect(authedPage.getByText('2 of 3')).toBeVisible();

    await gear.click();
    await authedPage.getByLabel('Review deck').selectOption('10');
    await expect(authedPage.getByText('2 of 3')).toBeVisible();
  });

  test('a highlight with no local article still shows its source and quote', async ({
    authedPage,
    testUser,
  }) => {
    // An imported Margin highlight: keyed by its normalized URL, carrying its own
    // source metadata because no article/save in the local cache matches.
    await seedItemLabel(testUser, {
      itemKey: 'https://elsewhere.test/essay',
      itemType: 'article',
      label: 'highlights',
      props: JSON.stringify({
        highlights: [
          {
            id: 'imported-1',
            selector: { type: 'TextQuoteSelector', exact: 'A passage highlighted in Margin' },
            createdAt: OLD,
            note: 'Worth coming back to',
            marginUri: 'at://did:plc:someone/at.margin.note/abc',
            marginRkey: 'abc',
            sourceUrl: 'https://elsewhere.test/essay',
            sourceTitle: 'An Essay Elsewhere',
          },
        ],
      }).replaceAll("'", "''"),
    });

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('A passage highlighted in Margin')).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByText('An Essay Elsewhere')).toBeVisible();
    await expect(authedPage.getByText('Worth coming back to')).toBeVisible();
  });
});
