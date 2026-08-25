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
