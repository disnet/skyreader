import { test, expect } from './fixtures';
import {
  cleanupFeedItems,
  disableSavedSearch,
  enableSavedSearchFor,
  enableSavedSearchSwitch,
  seedChannelMatches,
  seedFeedItems,
  seedSearchChannel,
  seedSubscription,
} from './seed';

// Saved searches: a channel with a query shows what the server matched for it
// (GET /api/channels/:uuid/items), with the matched words marked, and counts its
// unread matches in the sidebar. The matcher (the Percolator) runs only when a
// channel save kicks it, so the first test seeds matches as it would have
// written them, and the editor test lets the kick do the look back.
// See docs/plans/SAVED_SEARCH_CHANNELS.md.

const FEED_URL = `https://saved-search-e2e-${Date.now()}.example/feed.xml`;
const CHANNEL_UUID = '5ea4c0de-0000-4000-8000-00000000e2e1';

async function seedMatchedFeed(testUser: Parameters<typeof seedSubscription>[0]) {
  await seedSubscription(testUser, { feedUrl: FEED_URL, title: 'Home Energy Weekly' });
  const now = Date.now();
  await seedFeedItems(
    FEED_URL,
    [
      {
        guid: 'ss-e2e-pumps',
        title: 'Winter with a heat pump',
        url: 'https://energy.example/pumps',
        publishedAt: new Date(now - 60_000).toISOString(),
      },
      {
        guid: 'ss-e2e-grid',
        title: 'What the grid did in the cold snap',
        url: 'https://energy.example/grid',
        publishedAt: new Date(now - 120_000).toISOString(),
      },
      {
        guid: 'ss-e2e-solar',
        title: 'Rooftop solar, a year in',
        url: 'https://energy.example/solar',
        publishedAt: new Date(now - 180_000).toISOString(),
      },
    ],
    { title: 'Home Energy Weekly' }
  );
  await seedSearchChannel(testUser, {
    uuid: CHANNEL_UUID,
    name: 'Heat pumps',
    query: 'heat pump',
  });
  await seedChannelMatches(testUser, CHANNEL_UUID, [
    {
      guid: 'ss-e2e-pumps',
      feedUrl: FEED_URL,
      url: 'https://energy.example/pumps',
      snippet: 'We swapped the boiler for a [heat] [pump] in October, and the house…',
      publishedAt: now - 60_000,
    },
    {
      guid: 'ss-e2e-grid',
      feedUrl: FEED_URL,
      url: 'https://energy.example/grid',
      snippet: '…demand peaked at 6pm, when every [heat] [pump] on the street…',
      publishedAt: now - 120_000,
    },
  ]);
}

test.describe('Saved searches', () => {
  test.afterEach(async () => {
    await disableSavedSearch();
    await cleanupFeedItems(FEED_URL);
  });

  test('a saved search shows its matches with the words marked, and counts the unread ones', async ({
    authedPage,
    testUser,
  }) => {
    await enableSavedSearchFor(testUser);
    await seedMatchedFeed(testUser);

    await authedPage.goto(`/feeds?view=${CHANNEL_UUID}`);

    const cards = authedPage.locator('.article-item');
    await expect(cards.filter({ hasText: 'Winter with a heat pump' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(cards.filter({ hasText: 'What the grid did in the cold snap' })).toBeVisible();
    // The feed's other item is in the timeline, not in the search.
    await expect(cards.filter({ hasText: 'Rooftop solar, a year in' })).toHaveCount(0);

    await expect(authedPage.locator('.search-status')).toContainText('Matching');
    await expect(authedPage.locator('.search-status q')).toHaveText('heat pump');
    await expect(cards.first().locator('.match-snippet mark').first()).toHaveText('heat');

    const sidebarRow = authedPage.locator('.view-item', { hasText: 'Heat pumps' });
    await expect(sidebarRow.locator('.nav-count')).toHaveText('2');

    // Reading one here takes it off the count at once.
    await cards.filter({ hasText: 'Winter with a heat pump' }).locator('.read-toggle').click();
    await expect(sidebarRow.locator('.nav-count')).toHaveText('1');
  });

  test('the channel editor previews a query on its sources, and the new channel fills at once', async ({
    authedPage,
    testUser,
  }) => {
    await enableSavedSearchFor(testUser);
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: 'Home Energy Weekly' });
    const now = Date.now();
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'ss-e2e-new-pumps',
          title: 'Winter with a heat pump',
          url: 'https://energy.example/new-pumps',
          publishedAt: new Date(now - 60_000).toISOString(),
        },
        {
          guid: 'ss-e2e-new-podcast',
          title: 'The heat pump podcast',
          url: 'https://energy.example/new-podcast',
          publishedAt: new Date(now - 120_000).toISOString(),
        },
      ],
      { title: 'Home Energy Weekly' }
    );
    await authedPage.reload();

    const navGroup = authedPage.locator('.nav-group', {
      has: authedPage.locator('.nav-row .nav-label', { hasText: 'Channels' }),
    });
    await navGroup.locator('.new-channel-btn').click();
    const queryInput = authedPage.locator('#channel-query');
    await expect(queryInput).toBeVisible({ timeout: 5_000 });
    await queryInput.fill('"heat pump" -podcast');
    // Named for what it looks for, until you name it.
    await expect(authedPage.locator('#channel-name')).toHaveValue('"heat pump" -podcast');
    // The preview reads the sources' recent items, unread ones included.
    await expect(authedPage.locator('.preview')).toContainText(
      '1 of 2 items from these sources match',
      { timeout: 10_000 }
    );

    const put = authedPage.waitForResponse(
      (r) => /\/api\/channels\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'PUT'
    );
    await authedPage.getByRole('button', { name: 'Create channel' }).click();
    expect((await put).ok()).toBe(true);

    // Saving starts the look back at once, so the match shows without a wait.
    const cards = authedPage.locator('.article-item');
    await expect(cards.filter({ hasText: 'Winter with a heat pump' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(cards.filter({ hasText: 'The heat pump podcast' })).toHaveCount(0);
    await expect(authedPage.locator('.view-item', { hasText: 'heat pump' })).toBeVisible();

    const uuid = new URL(authedPage.url()).searchParams.get('view');
    const res = await authedPage.request.get(`http://127.0.0.1:8787/api/channels/${uuid}/items`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.query).toBe('"heat pump" -podcast');
  });

  test('without the plan, the query field shows greyed with a Supporter label', async ({
    authedPage,
  }) => {
    await enableSavedSearchSwitch();
    await authedPage.reload();
    const navGroup = authedPage.locator('.nav-group', {
      has: authedPage.locator('.nav-row .nav-label', { hasText: 'Channels' }),
    });
    await expect(navGroup).toBeVisible({ timeout: 15_000 });
    await navGroup.locator('.new-channel-btn').click();
    await expect(authedPage.locator('#channel-query')).toBeDisabled();
    await expect(authedPage.getByRole('link', { name: 'Supporter' })).toHaveAttribute(
      'href',
      '/supporter'
    );
  });

  test('with saved searches off here, a channel has no query field', async ({ authedPage }) => {
    const navGroup = authedPage.locator('.nav-group', {
      has: authedPage.locator('.nav-row .nav-label', { hasText: 'Channels' }),
    });
    await expect(navGroup).toBeVisible({ timeout: 15_000 });
    await navGroup.locator('.new-channel-btn').click();
    await expect(authedPage.locator('#channel-name')).toBeVisible();
    await expect(authedPage.locator('#channel-query')).toHaveCount(0);
  });
});
