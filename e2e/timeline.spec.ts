import { test, expect } from './fixtures';
import { seedSubscription, seedFeedItems, seedItemLabel, cleanupFeedItems } from './seed';

/**
 * The D1-served timeline: a refresh is ONE request that already carries read
 * state, instead of a per-feed batch fan-out against the Fly proxy.
 */
test.describe('Timeline refresh', () => {
  const FEED_URL = 'https://example.com/timeline-feed.xml';
  const FEED_TITLE = 'Timeline Feed';

  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  test('renders archived items from a single timeline request, with read state', async ({
    authedPage,
    testUser,
  }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        { guid: 'timeline-item-1', title: 'Archived Article One' },
        { guid: 'timeline-item-2', title: 'Archived Article Two' },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
    // Read on another device: the timeline join must stamp it inline.
    await seedItemLabel(testUser, {
      itemKey: 'timeline-item-1',
      itemType: 'article',
      label: 'read',
    });

    const timelineRequests: string[] = [];
    const batchRequests: string[] = [];
    authedPage.on('request', (request) => {
      const url = request.url();
      if (url.includes('/api/v2/timeline')) timelineRequests.push(url);
      if (url.includes('/api/v2/feeds/batch')) batchRequests.push(url);
    });

    const timelineResponsePromise = authedPage.waitForResponse((response) =>
      response.url().includes('/api/v2/timeline')
    );
    await authedPage.reload();
    const timelineResponse = await timelineResponsePromise;
    expect(timelineResponse.ok()).toBe(true);
    const timelineBody = (await timelineResponse.json()) as {
      items: Array<{ title?: string }>;
    };
    expect(timelineBody.items.map((item) => item.title)).toEqual(
      expect.arrayContaining(['Archived Article One', 'Archived Article Two'])
    );

    // Both articles land in IndexedDB. Assert the durable client merge directly:
    // a read article may be hidden by the reader's current filter, which made the
    // old visibility assertion depend on incidental UI state.
    await expect
      .poll(async () => {
        return authedPage.evaluate(async () => {
          const request = indexedDB.open('skyreader');
          const database: IDBDatabase = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const store = database.transaction('articles', 'readonly').objectStore('articles');
          const all: Array<{ title: string }> = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          return all.map((row) => row.title);
        });
      })
      .toEqual(expect.arrayContaining(['Archived Article One', 'Archived Article Two']));

    // The refresh is a single timeline call (at most one extra drain page), and
    // the legacy per-feed fan-out never runs — the point of the architecture.
    expect(timelineRequests.length).toBeGreaterThanOrEqual(1);
    expect(timelineRequests.length).toBeLessThanOrEqual(2);
    expect(batchRequests.length).toBe(0);

    // Read state arrived with the articles (no separate read fetch).
    const readGuids = await authedPage.evaluate(async () => {
      const request = indexedDB.open('skyreader');
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = database.transaction('itemLabels', 'readonly').objectStore('itemLabels');
      const all: Array<{ itemKey: string; label: string }> = await new Promise(
        (resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }
      );
      return all.filter((row) => row.label === 'read').map((row) => row.itemKey);
    });
    expect(readGuids).toContain('timeline-item-1');
    expect(readGuids).not.toContain('timeline-item-2');
  });

  test('reader extracts a truncated article once and reuses it on reopen', async ({
    authedPage,
    testUser,
  }) => {
    const articleUrl = 'https://example.com/truncated-reader';
    const description = 'Short RSS description while the full article loads.';
    const extractedText = 'Full extracted article text that was absent from the feed archive.';
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'truncated-reader-item',
          title: 'Truncated Reader Article',
          url: articleUrl,
          summary: description,
          contentTruncated: true,
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );

    let extractCalls = 0;
    await authedPage.route('**/api/extract', async (route) => {
      extractCalls += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          title: 'Truncated Reader Article',
          author: null,
          description,
          content: `<p>${extractedText}</p>`,
          domain: 'example.com',
          image: null,
          published: null,
          wordCount: 12,
        }),
      });
    });

    await authedPage.goto('/feeds');
    const card = authedPage.locator('.article-item-anchor', {
      has: authedPage.getByText('Truncated Reader Article', { exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('button.article-header').click();
    await card.getByRole('button', { name: 'Reader', exact: true }).click();
    await expect(authedPage.locator('.reader-body')).toContainText(extractedText);
    expect(extractCalls).toBe(1);

    await authedPage.getByRole('button', { name: 'Back', exact: true }).click();
    await card.getByRole('button', { name: 'Reader', exact: true }).click();
    await expect(authedPage.locator('.reader-body')).toContainText(extractedText);
    expect(extractCalls).toBe(1);
  });
});
