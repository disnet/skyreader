import { test, expect } from './fixtures';
import { cleanupFeedItems, seedFeedItems, seedSubscription } from './seed';
import type { Locator, Page } from '@playwright/test';

const FEED_URL = 'https://example.com/expand-scroll.xml';

test.use({ viewport: { width: 393, height: 727 }, hasTouch: true });

function longBody(label: string) {
  return Array.from(
    { length: 55 },
    (_, index) => `<p>${label} paragraph ${index + 1}: ${'reading context '.repeat(12)}</p>`
  ).join('');
}

// Collapsing a long card removes thousands of pixels of height. For the
// re-anchor (`scrollIntoView({ block: 'start' })`) to actually be able to put
// the card at the top of the viewport there has to be at least a viewport's
// worth of content left below it — otherwise the browser clamps at max scroll
// and the card lands wherever the shortened document allows.
const FILLER_COUNT = 10;

function fillerItems() {
  return Array.from({ length: FILLER_COUNT }, (_, index) => ({
    guid: `filler-${index}`,
    url: `https://example.com/filler-${index}`,
    title: `Filler article ${index + 1}`,
    summary: `Filler ${index + 1} summary `.repeat(20),
    content: `<p>Filler ${index + 1} body</p>`,
    publishedAt: new Date(Date.UTC(2026, 7, 12, 10, 0, 0) - index * 60_000).toISOString(),
  }));
}

// Seed the server-side archive the timeline serves from, rather than mocking the
// legacy `POST /api/v2/feeds/batch` fan-out.
//
// The client only takes the batch path when the timeline answers
// `ingestActive: false`, and that is `crawlerFresh` — whether a crawler has
// checked into this D1 within CRAWLER_HEARTBEAT_FRESH_SECONDS (30 min). So a
// batch-mock fixture passed or failed on ambient environment state: with the
// local feed proxy running, the timeline served an empty archive, the mock was
// never reached, and the feed rendered "No unread articles". `seedFeedItems`
// stamps that heartbeat itself, which puts these tests on the production
// timeline path deterministically — and keeps them working when the batch path
// is finally removed.
async function seedLongFeed(page: Page, user: Parameters<typeof seedSubscription>[0]) {
  await seedSubscription(user, { feedUrl: FEED_URL, title: 'Long articles' });
  await seedFeedItems(
    FEED_URL,
    [
      {
        guid: 'long-article-a',
        url: 'https://example.com/a',
        title: 'Long article A',
        summary: 'A summary '.repeat(80),
        content: longBody('A'),
        publishedAt: '2026-08-12T12:00:00.000Z',
      },
      {
        guid: 'long-article-b',
        url: 'https://example.com/b',
        title: 'Long article B',
        summary: 'B summary '.repeat(80),
        content: longBody('B'),
        publishedAt: '2026-08-12T11:00:00.000Z',
      },
      ...fillerItems(),
    ],
    { title: 'Long articles', siteUrl: 'https://example.com' }
  );
  await page.goto('/feeds');
  // Wait on the card wrapper the assertions measure, not on the title text.
  await expect(card(page, 'Long article B')).toBeVisible({ timeout: 15_000 });
  await expect(card(page, `Filler article ${FILLER_COUNT}`)).toBeAttached();

  // Make the regression deterministic instead of depending on Chromium's
  // heuristic choice of a native scroll anchor.
  await page.addStyleTag({ content: 'html, body, * { overflow-anchor: none !important; }' });
}

function card(page: Page, title: string): Locator {
  return page.locator('.article-item-anchor', {
    has: page.getByText(title, { exact: true }),
  });
}

// Every position in this file is measured from the top of the surface that
// actually scrolls: the app shell's framed content card above 1000px, the window
// below it. The app makes the same distinction (frontend/src/lib/utils/appScroll.ts),
// so measuring against the window here would read a viewport that never moves.
// Scroll until the card sits at `top` and stays there. Each attempt scrolls, then
// re-measures after a beat: scrolling into a fresh part of a long expanded article
// can shift the layout slightly (read-marking, the sticky action bar), and the
// retry absorbs that so a test never takes its baseline from a position the layout
// is about to invalidate.
async function moveCardTo(target: Locator, top: number) {
  await expect
    .poll(
      () =>
        target.evaluate(
          (element, targetTop) =>
            new Promise<number>((resolve) => {
              const pane = window.matchMedia('(min-width: 1001px)').matches
                ? document.getElementById('app-scroll')
                : null;
              const origin = pane ? pane.getBoundingClientRect().top : 0;
              const delta = element.getBoundingClientRect().top - origin - targetTop;
              if (pane) pane.scrollTop += delta;
              else window.scrollTo({ top: window.scrollY + delta, behavior: 'instant' });
              setTimeout(() => {
                const nextOrigin = pane ? pane.getBoundingClientRect().top : 0;
                resolve(element.getBoundingClientRect().top - nextOrigin);
              }, 250);
            }),
          top
        ),
      { timeout: 10_000 }
    )
    .toBeCloseTo(top, 0);
}

function cardTop(target: Locator): Promise<number> {
  return target.evaluate((element) => {
    const pane = window.matchMedia('(min-width: 1001px)').matches
      ? document.getElementById('app-scroll')
      : null;
    return element.getBoundingClientRect().top - (pane ? pane.getBoundingClientRect().top : 0);
  });
}

// The component's compensation runs across a `tick()` and a `requestAnimationFrame`,
// so read the position only once it has stopped moving. Waiting for a stable value
// (instead of retrying the assertion) means a transiently-correct frame can't make a
// broken fix look green.
async function settledTop(target: Locator): Promise<number> {
  return target.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const pane = window.matchMedia('(min-width: 1001px)').matches
          ? document.getElementById('app-scroll')
          : null;
        const measure = () =>
          element.getBoundingClientRect().top - (pane ? pane.getBoundingClientRect().top : 0);
        const deadline = performance.now() + 4000;
        let previous = measure();
        let stableFrames = 0;
        const step = () => {
          const top = measure();
          stableFrames = Math.abs(top - previous) < 0.5 ? stableFrames + 1 : 0;
          previous = top;
          // Report the last position rather than hanging until the test timeout if
          // it never settles — a failure that names the real number is more useful.
          if (stableFrames >= 4 || performance.now() > deadline) resolve(top);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      })
  );
}

async function expectSettledTopNear(target: Locator, expected: number, tolerance = 2) {
  const top = await settledTop(target);
  const message = `card top settled at ${top}, expected within ${tolerance}px of ${expected}`;
  expect(top, message).toBeGreaterThanOrEqual(expected - tolerance);
  expect(top, message).toBeLessThanOrEqual(expected + tolerance);
}

test.describe('expand scroll anchoring', () => {
  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  test('keeps a tapped card fixed when selecting it collapses a long card above', async ({
    authedPage,
    testUser,
  }) => {
    await seedLongFeed(authedPage, testUser);
    const first = card(authedPage, 'Long article A');
    const second = card(authedPage, 'Long article B');

    await first.locator('button.article-header').click();
    await first.locator('button.show-more-btn:not(.disabled)').click();
    await expect(first.locator('article.article-item')).toHaveClass(/expanded/);
    // Let A's full body finish hydrating before measuring anything below it.
    await expect(first.getByText('A paragraph 55:', { exact: false })).toBeVisible();

    await moveCardTo(second, 280);
    const beforeSelect = await cardTop(second);
    await second.locator('button.article-header').click();
    await expect(second.locator('article.article-item')).toHaveClass(/selected/);
    await expectSettledTopNear(second, beforeSelect);

    const beforeExpand = await cardTop(second);
    await second.locator('button.show-more-btn:not(.disabled)').click();
    await expect(second.locator('article.article-item')).toHaveClass(/expanded/);
    // The summary → full body swap happens after expand; the card top must
    // survive it too.
    await expect(second.getByText('B paragraph 55:', { exact: false })).toBeVisible();
    await expectSettledTopNear(second, beforeExpand);
  });

  test('re-anchors an offscreen card when Less collapses it', async ({ authedPage, testUser }) => {
    await seedLongFeed(authedPage, testUser);
    const second = card(authedPage, 'Long article B');

    await second.locator('button.article-header').click();
    await second.locator('button.show-more-btn:not(.disabled)').click();
    await expect(second.locator('article.article-item')).toHaveClass(/expanded/);

    // Reading down a long post puts its top well above the viewport; the Less
    // button stays reachable because the action bar is sticky.
    await moveCardTo(second, -300);
    await second.locator('button.show-less-btn').click();
    await expect(second.locator('article.article-item')).not.toHaveClass(/expanded/);

    // `.article-item-anchor` has scroll-margin-top: 0.5rem at this width.
    await expectSettledTopNear(second, 8);
  });

  test('keeps a card in place when its header deselects it', async ({ authedPage, testUser }) => {
    await seedLongFeed(authedPage, testUser);
    const second = card(authedPage, 'Long article B');

    await second.locator('button.article-header').click();
    await second.locator('button.show-more-btn:not(.disabled)').click();
    await expect(second.locator('article.article-item')).toHaveClass(/expanded/);

    // The header is only tappable while it is on screen, so this is the
    // reachable deselect: collapsing the card must not move it under the finger,
    // even though the page shrinks by the whole article body.
    await moveCardTo(second, 120);
    await second.locator('button.article-header').click();
    await expect(second.locator('article.article-item')).not.toHaveClass(/expanded/);
    // `selected` stays on every card in the default expand-all view; `highlighted`
    // is the class that actually tracks the selected key.
    await expect(second.locator('article.article-item')).not.toHaveClass(/highlighted/);

    await expectSettledTopNear(second, 120);
  });
});
