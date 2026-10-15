import { test, expect } from './fixtures';
import { cleanupFeedItems, seedFeedItems, seedSubscription } from './seed';
import type { Page } from '@playwright/test';

// Guards the reader's responsiveness on a long, expanded list. The budgets are on
// WORK, counted by dev-build counters (frontend/src/lib/utils/workCounters.ts),
// not on milliseconds: a runner's speed varies run to run, the amount of work
// doesn't. "Marking one item read re-checks a few cards" is the property; a
// regression to re-rendering every card multiplies the counts by the list length
// and fails loudly however fast the machine is.
//
// A wall-clock backstop rides along with a budget loose enough for any runner,
// to catch a slow path the counters don't see.

const FEED_URL = 'https://example.com/responsiveness.xml';
const CARDS = 100;

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

function body(i: number) {
  return Array.from(
    { length: 20 },
    (_, p) =>
      `<p>Article ${i}, paragraph ${p}: ${'reading text <em>with</em> markup '.repeat(8)}</p>`
  ).join('');
}

async function seedLongList(page: Page, user: Parameters<typeof seedSubscription>[0]) {
  await seedSubscription(user, { feedUrl: FEED_URL, title: 'Responsiveness' });
  await seedFeedItems(
    FEED_URL,
    Array.from({ length: CARDS }, (_, i) => ({
      guid: `resp-${i}`,
      url: `https://example.com/resp-${i}`,
      title: `Responsive article ${i}`,
      summary: `Summary ${i}`,
      content: body(i),
      publishedAt: new Date(Date.UTC(2026, 7, 12) - i * 60_000).toISOString(),
    })),
    { title: 'Responsiveness', siteUrl: 'https://example.com' }
  );
  await page.goto('/feeds');
  await expect(page.getByText('Responsive article 0', { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // Page the whole list in: the first page is 50 cards, the sentinel adds more.
  for (let i = 0; i < 6; i++) {
    const count = await page.locator('.read-toggle').count();
    if (count >= CARDS) break;
    await page
      .getByText(`Responsive article ${Math.max(count - 1, 0)}`, { exact: true })
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
  await expect(page.locator('.read-toggle')).toHaveCount(CARDS, { timeout: 15_000 });
}

/** Lets reactive work and body hydration settle, then zeroes the counters. */
async function settleAndReset(page: Page) {
  await page.waitForTimeout(1000);
  await page.evaluate(() => (window.__skyreaderWork = {}));
}

async function work(page: Page) {
  return page.evaluate(() => ({ sanitize: 0, cardLabels: 0, ...window.__skyreaderWork }));
}

test.afterEach(async () => {
  await cleanupFeedItems(FEED_URL);
});

test('marking one item read re-checks a few cards, not the whole list', async ({
  authedPage: page,
  testUser,
}) => {
  await seedLongList(page, testUser);

  for (const index of [3, 40, 90]) {
    await settleAndReset(page);
    const elapsed = await page.evaluate(async (i) => {
      const toggle = document.querySelectorAll<HTMLElement>('.read-toggle')[i];
      const t0 = performance.now();
      toggle.click();
      // The click's work, through the next frame.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    }, index);
    // Let any trailing effects (the label write, the count) land before counting.
    await page.waitForTimeout(500);
    const counts = await work(page);

    // An open card's body is sanitized once, when it renders. Re-sanitizing on a
    // read toggle means each card got a new article object.
    // Guard against a vacuous pass: the counters only exist in a dev build, so
    // the toggled card itself must have been counted.
    expect(counts.cardLabels, 'work counters are live (dev build)').toBeGreaterThan(0);
    expect(counts.sanitize, 'bodies re-sanitized by one mark-read').toBeLessThanOrEqual(2);
    // The toggled card, plus the odd neighbour sharing its reactivity bucket
    // (utils/keyedSignals). Before per-key reactivity this was every card.
    expect(counts.cardLabels, 'cards re-checking labels after one mark-read').toBeLessThanOrEqual(
      5
    );
    expect(elapsed, 'click to next frame (ms)').toBeLessThan(250);
  }

  await expect(page.locator('.read-toggle:not(.unread)')).toHaveCount(3);
});

test('the list holds still while it loads', async ({ authedPage: page, testUser }) => {
  await seedSubscription(testUser, { feedUrl: FEED_URL, title: 'Responsiveness' });
  await seedFeedItems(
    FEED_URL,
    Array.from({ length: 20 }, (_, i) => ({
      guid: `resp-cls-${i}`,
      url: `https://example.com/resp-cls-${i}`,
      title: `Steady article ${i}`,
      summary: `Summary ${i}`,
      content: body(i),
      publishedAt: new Date(Date.UTC(2026, 7, 12) - i * 60_000).toISOString(),
    })),
    { title: 'Responsiveness', siteUrl: 'https://example.com' }
  );
  // A first visit, so the next one is the everyday case: a returning reader
  // with a warm cache. (A first boot on a device can't know what to ask
  // before the server answers.)
  await page.goto('/feeds');
  await expect(page.getByText('Steady article 0', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(2000);

  // Collect layout shifts from the reload on, the way CLS does: shifts right
  // after input are expected and excluded.
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.reload();
  await expect(page.getByText('Steady article 0', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(2000);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  // 0.1 is the line between "good" and "needs improvement" for CLS.
  expect(cls, 'cumulative layout shift while the list loads').toBeLessThan(0.1);
});
