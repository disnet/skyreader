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

type SwipePage = import('@playwright/test').Page;
type SwipeWindow = Window & { __finishSwipe?: (how: string) => void };

/** Drags the front card by (dx, dy) and leaves the finger down. How the gesture
    ends is the test's business: `finishSwipe` releases it, cancels it, or lands
    a second finger on it. */
async function swipeCard(page: SwipePage, delta: { dx?: number; dy?: number }) {
  await page.evaluate(
    async ({ dx, dy }) => {
      const card = document.querySelector('.deck-card') as HTMLElement;
      const rect = card.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + 40;
      const at = (step: number) => [startX + (dx * step) / 10, startY + (dy * step) / 10];
      const touch = (atX: number, atY: number, identifier = 1) =>
        new Touch({ identifier, target: card, clientX: atX, clientY: atY });
      const event = (type: string, touches: Touch[], changed: Touch[]) =>
        new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: changed });

      const [x0, y0] = at(0);
      card.dispatchEvent(event('touchstart', [touch(x0, y0)], [touch(x0, y0)]));
      for (let step = 1; step <= 10; step++) {
        const [x, y] = at(step);
        card.dispatchEvent(event('touchmove', [touch(x, y)], [touch(x, y)]));
        await new Promise((resolve) => setTimeout(resolve, 16));
      }

      const [x, y] = at(10);
      (window as SwipeWindow).__finishSwipe = (how) => {
        if (how === 'end') card.dispatchEvent(event('touchend', [], [touch(x, y)]));
        else if (how === 'cancel') card.dispatchEvent(event('touchcancel', [], [touch(x, y)]));
        // A second finger arrives as a touchstart carrying both points, and no
        // touchend for the first ever follows.
        else {
          const second = touch(x + 40, y + 40, 2);
          card.dispatchEvent(event('touchstart', [touch(x, y), second], [second]));
        }
      };
    },
    { dx: delta.dx ?? 0, dy: delta.dy ?? 0 }
  );
}

async function finishSwipe(page: SwipePage, how: 'end' | 'cancel' | 'second-finger') {
  await page.evaluate((mode) => (window as SwipeWindow).__finishSwipe?.(mode), how);
  await page.waitForTimeout(400);
}

const endSwipe = (page: SwipePage) => finishSwipe(page, 'end');

/** 'none' once the card is square on the deck again. */
async function cardTransform(page: SwipePage) {
  return page.evaluate(
    () => getComputedStyle(document.querySelector('.deck-card') as HTMLElement).transform
  );
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
  test('setting a highlight to Never hides it from the deck without deleting it', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    // The control names where the highlight currently sits: untuned reads Later.
    const control = authedPage.getByRole('button', { name: /When should this come back/ });
    await expect(control).toContainText('Later');

    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await control.click();
    await authedPage.getByRole('button', { name: /^Never/ }).click();
    await written;

    // The card is gone and the deck is one shorter — no card was "reviewed".
    await expect(authedPage.getByText('1 of 2')).toBeVisible();
    await expect(authedPage.getByText("won't come up in review again")).toBeVisible();

    // Nothing was deleted: all three are still in the list, one marked.
    await authedPage.goto('/highlights');
    await expect(authedPage.getByText('3 highlights')).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Not in review')).toHaveCount(1);

    // And it survived the round trip through D1: reopening deals two, not three.
    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 2')).toBeVisible({ timeout: 15_000 });
  });

  test('retiring the last highlight says so, rather than "highlight a passage"', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 1);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 1')).toBeVisible({ timeout: 15_000 });

    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: /When should this come back/ }).click();
    await authedPage.getByRole('button', { name: /^Never/ }).click();
    await written;

    // The highlight is still in the list, so the empty-corpus copy would be a lie.
    await expect(authedPage.getByRole('heading', { name: 'Nothing in rotation' })).toBeVisible();
    await expect(authedPage.getByText('Highlight a passage while reading')).toHaveCount(0);
  });

  test('undoing Never restores the pace it replaced, not the default', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    const control = authedPage.getByRole('button', { name: /When should this come back/ });

    // Set a pace first. The deck holds the highlight as it was dealt, so undo
    // has to read this back from the store rather than from its own card.
    let written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await control.click();
    await authedPage.getByRole('button', { name: /^Soon/ }).click();
    await written;
    await expect(control).toContainText('Soon');

    // Then retire it on the same card, without moving on.
    written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await control.click();
    await authedPage.getByRole('button', { name: /^Never/ }).click();
    await written;
    await expect(authedPage.getByText('1 of 2')).toBeVisible();

    written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: 'Undo' }).click();
    await written;

    // Back where it was, still on Soon — undo means "as you were".
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    await expect(
      authedPage.getByRole('button', { name: /When should this come back/ })
    ).toContainText('Soon');

    // And that's what reached D1, not a reset to the default pace.
    await authedPage.goto('/highlights');
    await expect(authedPage.getByText('Soon', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByText('Not in review')).toHaveCount(0);
  });

  test('Someday persists and sinks the highlight down the deck', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    const passage = authedPage.locator('.passage');
    const first = (await passage.textContent())!.trim();

    const control = authedPage.getByRole('button', { name: /When should this come back/ });
    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await control.click();
    await authedPage.getByRole('button', { name: /^Someday/ }).click();
    await written;

    // Unlike Never, a pace setting doesn't change this session: the card stays
    // put, and the control reports the new setting.
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    await expect(control).toContainText('Someday');

    // It reached D1, and the ranking acts on it: on the next deal the same three
    // highlights are dealt, but this one is now last instead of first.
    await authedPage.reload();
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });
    await expect(passage).not.toHaveText(first);

    await authedPage.getByRole('button', { name: 'Next' }).click();
    await expect(authedPage.getByText('2 of 3')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Next' }).click();
    await expect(authedPage.getByText('3 of 3')).toBeVisible();
    await expect(passage).toHaveText(first);
    await expect(
      authedPage.getByRole('button', { name: /When should this come back/ })
    ).toContainText('Someday');

    // The list reports it too.
    await authedPage.goto('/highlights');
    await expect(authedPage.getByText('Someday', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('the highlights list puts a hidden highlight back in rotation', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 2);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 2')).toBeVisible({ timeout: 15_000 });
    const hidden = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: /When should this come back/ }).click();
    await authedPage.getByRole('button', { name: /^Never/ }).click();
    await hidden;

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

  // The one gesture that isn't navigation: lifting a card off the top of the
  // deck says never show this one again. Synthetic touches, because the deck
  // owns the vertical axis by hand rather than through a pointer event.
  test('swiping a card up takes it out of rotation', async ({ authedPage, testUser }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });
    const first = await authedPage.locator('.deck-card .passage').first().textContent();

    // Short of the threshold the cue shows what it would do, and the card
    // springs back when the finger says no.
    await swipeCard(authedPage, { dy: -30 });
    await expect(authedPage.locator('.retire-cue')).toHaveText('Never show again');
    await expect(authedPage.locator('.retire-cue')).not.toHaveClass(/armed/);
    await endSwipe(authedPage);
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    expect(await authedPage.locator('.deck-card .passage').first().textContent()).toBe(first);

    const written = authedPage.waitForResponse(
      (res) => res.url().includes('/api/labels') && res.request().method() === 'POST'
    );
    await swipeCard(authedPage, { dy: -90 });
    await expect(authedPage.locator('.retire-cue')).toHaveClass(/armed/);
    await endSwipe(authedPage);
    await written;

    // Retired, not reviewed: the deck is one shorter and the card is undoable.
    await expect(authedPage.getByText('1 of 2')).toBeVisible();
    await expect(authedPage.getByText("won't come up in review again")).toBeVisible();
    expect(await authedPage.locator('.deck-card .passage').first().textContent()).not.toBe(first);

    await authedPage.getByRole('button', { name: 'Undo' }).click();
    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    expect(await authedPage.locator('.deck-card .passage').first().textContent()).toBe(first);
  });

  // A gesture the reader never released isn't a decision. When the system takes
  // the touch back mid-lift, the card goes down again — retiring a highlight on
  // an interruption would spend the one action that isn't navigation.
  test('a cancelled touch puts the card back instead of retiring it', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });
    const first = await authedPage.locator('.deck-card .passage').first().textContent();

    // Far enough that releasing here would retire it.
    await swipeCard(authedPage, { dy: -90 });
    await expect(authedPage.locator('.retire-cue')).toHaveClass(/armed/);
    await finishSwipe(authedPage, 'cancel');

    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    await expect(authedPage.getByText("won't come up in review again")).toHaveCount(0);
    expect(await authedPage.locator('.deck-card .passage').first().textContent()).toBe(first);
    expect(await cardTransform(authedPage)).toBe('none');
  });

  // A second finger ends the gesture without a touchend, so the card has to be
  // put back by hand — nothing else is coming to do it.
  test('a second finger mid-swipe puts the card back on the deck', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });
    const first = await authedPage.locator('.deck-card .passage').first().textContent();

    // Well past the commit threshold: held there, not thrown.
    await swipeCard(authedPage, { dx: -260 });
    expect(await cardTransform(authedPage)).not.toBe('none');
    await finishSwipe(authedPage, 'second-finger');

    await expect(authedPage.getByText('1 of 3')).toBeVisible();
    expect(await authedPage.locator('.deck-card .passage').first().textContent()).toBe(first);
    expect(await cardTransform(authedPage)).toBe('none');
  });

  // Going back is navigation, not un-reviewing, so coming forward over a card
  // you already passed must not tally it a second time.
  test('stepping back and forward again does not double-count the tally', async ({
    authedPage,
    testUser,
  }) => {
    await seedHighlights(testUser, 3);

    await authedPage.goto('/highlights/review');
    await expect(authedPage.getByText('1 of 3')).toBeVisible({ timeout: 15_000 });

    const next = authedPage.getByRole('button', { name: 'Next' });
    await next.click();
    await expect(authedPage.getByText('2 of 3')).toBeVisible();

    await authedPage.getByRole('button', { name: 'Previous highlight' }).click();
    await expect(authedPage.getByText('1 of 3')).toBeVisible();

    await next.click();
    await expect(authedPage.getByText('2 of 3')).toBeVisible();
    await next.click();
    await expect(authedPage.getByText('3 of 3')).toBeVisible();
    await authedPage.getByRole('button', { name: 'Finish' }).click();

    await expect(authedPage.getByText('3 highlights revisited.')).toBeVisible();
  });
});
