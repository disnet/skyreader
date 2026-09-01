import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { seedSubscription, seedFeedItems, cleanupFeedItems, type TestUser } from './seed';

/**
 * Two devices, one account — the decisive test for the report behind this work:
 *
 *   "the same feed will show different unread numbers on different devices"
 *
 * Every assertion here failed before the canonical window and server-computed
 * counts: device A cold-started with a different slice than device B kept, and
 * "mark all read" only ever covered the acting device's slice.
 *
 * The two contexts share one seeded session cookie, which is what makes them two
 * devices rather than two tabs: separate IndexedDB, separate cursors, separate
 * in-memory stores.
 */
test.describe('Cross-device sync convergence', () => {
  const FEED_URL = 'https://example.com/two-device-feed.xml';
  const FEED_TITLE = 'Two Device Feed';
  // Deliberately more than the canonical window (100), so a device that
  // cold-starts and a device that accumulates could hold different sets.
  const ITEM_COUNT = 150;

  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  /** A second "device": its own context, same session, same account. */
  async function openDevice(context: BrowserContext, user: TestUser): Promise<Page> {
    await context.addCookies([
      {
        name: 'session_id',
        value: user.sessionId,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(
      ({ handle, did }) => {
        localStorage.setItem(
          'skyreader-auth',
          JSON.stringify({
            user: { did, handle, displayName: 'Test User' },
          })
        );
      },
      { handle: user.handle, did: user.did }
    );
    await page.reload();
    return page;
  }

  /** Wait for a completed refresh, then read the server-authoritative count. */
  async function unreadForFeed(page: Page): Promise<number> {
    const response = await page.waitForResponse(
      (r) => r.url().includes('/api/v2/timeline') && r.url().includes('include_counts=1'),
      { timeout: 30_000 }
    );
    const body = (await response.json()) as { unreadCounts?: Record<string, number> };
    return body.unreadCounts?.[FEED_URL] ?? -1;
  }

  async function seedFeed() {
    await seedFeedItems(
      FEED_URL,
      Array.from({ length: ITEM_COUNT }, (_, i) => ({
        guid: `two-device-${String(i).padStart(4, '0')}`,
        title: `Two Device Article ${i}`,
        publishedAt: new Date(Date.now() - i * 60_000).toISOString(),
      })),
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
  }

  test('two devices agree on the unread count for the same feed', async ({
    authedPage,
    testUser,
    browser,
  }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeed();

    const countsA = unreadForFeed(authedPage);
    await authedPage.reload();
    const a = await countsA;

    const contextB = await browser.newContext();
    const pageB = await openDevice(contextB, testUser);
    const countsB = unreadForFeed(pageB);
    await pageB.reload();
    const b = await countsB;

    // Both are the canonical window, and — the actual point — they are equal.
    expect(a).toBe(b);
    expect(a).toBe(100);

    await contextB.close();
  });

  test('a read on one device reaches the other, and mark-all converges both to zero', async ({
    authedPage,
    testUser,
    browser,
  }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeed();

    await authedPage.reload();
    await unreadForFeed(authedPage);

    // Device A marks three items read, through the same API the UI uses.
    await authedPage.evaluate(async () => {
      await fetch('/api/reading/mark-read-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          items: [
            { itemGuid: 'two-device-0000' },
            { itemGuid: 'two-device-0001' },
            { itemGuid: 'two-device-0002' },
          ],
          updatedAt: Date.now(),
        }),
      });
    });

    // Device B, opened fresh, sees the reduced count.
    const contextB = await browser.newContext();
    const pageB = await openDevice(contextB, testUser);
    const countsB = unreadForFeed(pageB);
    await pageB.reload();
    expect(await countsB).toBe(97);

    // Mark-all is a SERVER operation over the window, so it covers items neither
    // device necessarily held — which is exactly what the local loop couldn't do.
    await pageB.evaluate(async () => {
      await fetch('/api/reading/mark-feed-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          feedUrl: 'https://example.com/two-device-feed.xml',
          updatedAt: Date.now(),
        }),
      });
    });

    const countsAfterA = unreadForFeed(authedPage);
    await authedPage.reload();
    expect(await countsAfterA).toBe(0);

    await contextB.close();
  });

  test('a late-draining un-read loses to a newer read from the other device', async ({
    authedPage,
    testUser,
  }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeed();
    await authedPage.reload();
    await unreadForFeed(authedPage);

    const guid = 'two-device-0000';

    const finalState = await authedPage.evaluate(async (itemGuid) => {
      const now = Date.now();
      // Device A read it a minute ago; its request lands first.
      await fetch('/api/reading/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ itemGuid, updatedAt: now - 60_000 }),
      });
      // Device B un-read it an HOUR ago and only now drains its offline queue.
      // Arrival order says B wins; user time says A does, and the user is right.
      await fetch('/api/reading/mark-unread', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ itemGuid, updatedAt: now - 3_600_000 }),
      });

      const res = await fetch('/api/reading/positions?since=0', { credentials: 'include' });
      const body = (await res.json()) as {
        positions: Array<{ item_guid: string; deleted: boolean }>;
      };
      return body.positions.find((p) => p.item_guid === itemGuid);
    }, guid);

    expect(finalState?.deleted).toBe(false);
  });

  // The same-second case a seconds-only cursor cannot express a position inside:
  // every row written in the cursor's own second used to be dropped and never
  // offered again.
  test('same-second read changes are all delivered exactly once', async ({
    authedPage,
    testUser,
  }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeed();
    await authedPage.reload();
    await unreadForFeed(authedPage);

    const delivered = await authedPage.evaluate(async () => {
      // Three reads inside one wall-clock second.
      await fetch('/api/reading/mark-read-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          items: [
            { itemGuid: 'two-device-0010' },
            { itemGuid: 'two-device-0011' },
            { itemGuid: 'two-device-0012' },
          ],
        }),
      });

      // Drain one row at a time, which is what forces the cursor to sit INSIDE
      // that second between pages.
      const seen: string[] = [];
      let since = '0';
      for (let page = 0; page < 10; page++) {
        const res = await fetch(
          `/api/reading/positions?since=${encodeURIComponent(since)}&limit=1`,
          { credentials: 'include' }
        );
        const body = (await res.json()) as {
          positions: Array<{ item_guid: string }>;
          nextSince: string;
          hasMore: boolean;
        };
        seen.push(...body.positions.map((p) => p.item_guid));
        since = body.nextSince;
        if (!body.hasMore) break;
      }
      return seen;
    });

    for (const guid of ['two-device-0010', 'two-device-0011', 'two-device-0012']) {
      expect(delivered.filter((g) => g === guid)).toHaveLength(1);
    }
  });
});
