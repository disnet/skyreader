import { test, expect } from './fixtures';
import { seedSubscription } from './seed';
import type { Locator, Page } from '@playwright/test';

const FEED_URL = 'https://example.com/expand-scroll.xml';

test.use({ viewport: { width: 393, height: 727 }, hasTouch: true });

function longBody(label: string) {
  return Array.from(
    { length: 55 },
    (_, index) => `<p>${label} paragraph ${index + 1}: ${'reading context '.repeat(12)}</p>`
  ).join('');
}

async function seedLongFeed(page: Page, user: Parameters<typeof seedSubscription>[0]) {
  await seedSubscription(user, { feedUrl: FEED_URL, title: 'Long articles' });
  await page.route('**/api/v2/feeds/batch', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        feeds: {
          [FEED_URL]: {
            title: 'Long articles',
            status: 'ready',
            hasMore: false,
            items: [
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
            ],
          },
        },
        readCursor: Math.floor(Date.now() / 1000),
      }),
    });
  });
  await page.goto('/feeds');
  await expect(page.getByText('Long article B', { exact: true })).toBeVisible({ timeout: 15_000 });

  // Make the regression deterministic instead of depending on Chromium's
  // heuristic choice of a native scroll anchor.
  await page.addStyleTag({ content: 'html, body, * { overflow-anchor: none !important; }' });
}

function card(page: Page, title: string): Locator {
  return page.locator('.article-item-anchor', {
    has: page.getByText(title, { exact: true }),
  });
}

async function moveCardTo(page: Page, target: Locator, top: number) {
  await target.evaluate((element, targetTop) => {
    window.scrollTo({
      top: window.scrollY + element.getBoundingClientRect().top - targetTop,
      behavior: 'instant',
    });
  }, top);
  await expect
    .poll(() => target.evaluate((element) => element.getBoundingClientRect().top))
    .toBeCloseTo(top, 0);
}

async function expectTopNear(target: Locator, expected: number, tolerance = 2) {
  await expect
    .poll(() => target.evaluate((element) => element.getBoundingClientRect().top))
    .toBeGreaterThanOrEqual(expected - tolerance);
  await expect
    .poll(() => target.evaluate((element) => element.getBoundingClientRect().top))
    .toBeLessThanOrEqual(expected + tolerance);
}

test.describe('expand scroll anchoring', () => {
  test('keeps a tapped card fixed when selecting it collapses a long card above', async ({
    authedPage,
    testUser,
  }) => {
    await seedLongFeed(authedPage, testUser);
    const first = card(authedPage, 'Long article A');
    const second = card(authedPage, 'Long article B');

    await first.locator('button.article-header').click();
    await first.locator('button.show-more-btn').click();
    await expect(first.locator('article.article-item')).toHaveClass(/expanded/);

    await moveCardTo(authedPage, second, 280);
    const beforeSelect = await second.evaluate((element) => element.getBoundingClientRect().top);
    await second.locator('button.article-header').click();
    await expectTopNear(second, beforeSelect);

    const beforeExpand = await second.evaluate((element) => element.getBoundingClientRect().top);
    await second.locator('button.show-more-btn').click();
    await expect(second.locator('article.article-item')).toHaveClass(/expanded/);
    await expect(second.getByText('B paragraph 55:', { exact: false })).toBeVisible();
    await expectTopNear(second, beforeExpand);
  });

  test('re-anchors an offscreen card when Less collapses it', async ({ authedPage, testUser }) => {
    await seedLongFeed(authedPage, testUser);
    const second = card(authedPage, 'Long article B');

    await second.locator('button.article-header').click();
    await second.locator('button.show-more-btn').click();
    await moveCardTo(authedPage, second, -300);
    await second.locator('button.show-less-btn').click();

    await expectTopNear(second, 8);
  });

  test('re-anchors an offscreen expanded card when its header deselects it', async ({
    authedPage,
    testUser,
  }) => {
    await seedLongFeed(authedPage, testUser);
    const second = card(authedPage, 'Long article B');

    await second.locator('button.article-header').click();
    await second.locator('button.show-more-btn').click();
    await moveCardTo(authedPage, second, -300);
    await second.locator('button.article-header').click();

    await expect(second.locator('article.article-item')).not.toHaveClass(/expanded/);
    await expectTopNear(second, 8);
  });
});
