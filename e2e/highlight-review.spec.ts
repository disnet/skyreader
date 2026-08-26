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
    author: 'Ada Lovelace',
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
    await expect(authedPage.getByRole('heading', { name: "That's today's review" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the Home card names who the deck draws from', async ({ authedPage, testUser }) => {
    await seedHighlights(testUser, 3);
    await seedSavedArticle(testUser, {
      url: 'https://elsewhere.test/review/other',
      title: 'Another Article',
      // No byline: this one falls back to where it came from rather than
      // dropping out of the sentence.
      itemGuid: 'review-other-guid',
      source: 'feed',
      domain: 'elsewhere.test',
      contentType: 'article',
    });
    await seedItemLabel(testUser, {
      itemKey: 'review-other-guid',
      itemType: 'article',
      label: 'highlights',
      props: JSON.stringify({
        highlights: [
          {
            id: 'hl-other',
            selector: { type: 'TextQuoteSelector', exact: 'A passage from the other article' },
            createdAt: OLD,
          },
        ],
      }).replaceAll("'", "''"),
    });

    await authedPage.goto('/home');
    // Both sources are named; which comes first is the deck's date-seeded order.
    await expect(
      authedPage.getByText(
        /^Highlights from (Ada Lovelace and elsewhere\.test|elsewhere\.test and Ada Lovelace)\.$/
      )
    ).toBeVisible({ timeout: 15_000 });
  });

  test('finishing a deck offers another hand of what is still due', async ({
    authedPage,
    testUser,
  }) => {
    // Two full decks' worth plus one, so the second hand is short.
    await seedHighlights(testUser, DECK_SIZE * 2 + 1);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText(`1 of ${DECK_SIZE}`)).toBeVisible({ timeout: 15_000 });

    async function finishHand(size: number) {
      for (let card = 1; card <= size; card++) {
        const written = authedPage.waitForResponse(
          (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
        );
        await authedPage.getByRole('button', { name: card === size ? 'Finish' : 'Next' }).click();
        await written;
      }
    }

    await finishHand(DECK_SIZE);
    await expect(authedPage.getByText(`${DECK_SIZE} highlights revisited.`)).toBeVisible();

    const more = authedPage.getByRole('button', { name: `Review ${DECK_SIZE} more` });
    await expect(more).toBeVisible();
    await more.click();

    // The stamps from the first hand make its cards ineligible, so this is the
    // next ones due rather than the same deck again.
    await expect(authedPage.getByText(`1 of ${DECK_SIZE}`)).toBeVisible();
    await expect(authedPage.getByText('Seeded highlight number 1')).toHaveCount(0);

    await finishHand(DECK_SIZE);
    // The tally is the session's, not the hand's.
    await expect(authedPage.getByText(`${DECK_SIZE * 2} highlights revisited.`)).toBeVisible();

    // One highlight left: the offer says so, and disappears once it's spent.
    await authedPage.getByRole('button', { name: 'Review 1 more' }).click();
    await expect(authedPage.getByText('1 of 1')).toBeVisible();
    await finishHand(1);
    await expect(authedPage.getByText(`${DECK_SIZE * 2 + 1} highlights revisited.`)).toBeVisible();
    await expect(authedPage.getByRole('button', { name: /^Review \d+ more$/ })).toHaveCount(0);
  });

  test('an exhausted deck still offers to keep going', async ({ authedPage, testUser }) => {
    // Everything already reviewed today: what a reader sees on coming back after
    // finishing, rather than by finishing in this session.
    const reviewedToday = Date.now();
    await seedSavedArticle(testUser, {
      url: ARTICLE_URL,
      title: 'The Highlighted Article',
      author: 'Ada Lovelace',
      itemGuid: ARTICLE_GUID,
      source: 'feed',
      domain: 'example.com',
      contentType: 'article',
    });
    await seedItemLabel(testUser, {
      itemKey: ARTICLE_GUID,
      itemType: 'article',
      label: 'highlights',
      props: JSON.stringify({
        highlights: highlights(3).map((h) => ({ ...h, lastReviewedAt: reviewedToday })),
      }).replaceAll("'", "''"),
    });

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByRole('heading', { name: "That's today's review" })).toBeVisible({
      timeout: 15_000,
    });
    // Not the empty state: there are highlights, they're just spent for today.
    await expect(
      authedPage.getByRole('heading', { name: 'Nothing to review right now' })
    ).toHaveCount(0);

    // No count on the offer — going around again isn't new material, and it says so.
    const more = authedPage.getByRole('button', { name: 'Review more', exact: true });
    await expect(more).toBeVisible();
    await expect(
      authedPage.getByText('This brings back the ones you saw earliest today.')
    ).toBeVisible();

    await more.click();
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    // Which of the three leads is the date-seeded tie-break; that one is back.
    await expect(authedPage.getByText(/^Seeded highlight number [123]$/)).toBeVisible();
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
      const card = document.querySelector('.review-body .deck-card');
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
  test('"Don\'t show again" retires a highlight without deleting it', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: "Don't show again" }).click();
    await written;

    // The card is gone and the deck is one shorter — no card was "reviewed".
    await expect(authedPage.getByText('1 of 2')).toBeVisible();
    await expect(authedPage.getByText("won't come up in review again")).toBeVisible();

    // Nothing was deleted: all three are still in the list, one marked.
    await authedPage.goto('/highlights');
    await expect(authedPage.getByText('3 highlights')).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Not in review')).toHaveCount(1);

    // And the stamp survived the round trip: reopening deals two, not three.
    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 2')).toBeVisible({ timeout: 15_000 });
  });

  test('the highlights list puts a retired highlight back in rotation', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 2);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 2')).toBeVisible({ timeout: 15_000 });
    const retired = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: "Don't show again" }).click();
    await retired;

    await authedPage.goto('/highlights');
    const restore = authedPage.getByRole('button', { name: 'Put back in the review deck' });
    await expect(restore).toBeVisible({ timeout: 15_000 });
    const restored = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await restore.click();
    await restored;
    await expect(authedPage.getByText('Not in review')).toHaveCount(0);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 2')).toBeVisible({ timeout: 15_000 });
  });

  test('the deck steps backward as well as forward', async ({ authedPage, testUser }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    // Nothing behind the first card, so back is offered but inert.
    const back = authedPage.getByRole('button', { name: 'Previous highlight' });
    await expect(back).toBeDisabled();

    await authedPage.getByRole('button', { name: 'Next' }).click();
    await expect(authedPage.getByText('2 of 3')).toBeVisible();
    await expect(back).toBeEnabled();

    await back.click();
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
  });
});
