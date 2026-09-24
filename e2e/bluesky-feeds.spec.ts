import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { seedBlueskyAccess } from './seed';

// Bluesky feeds as sources (docs/plans/BLUESKY_FEEDS_PLAN.md): the Following
// timeline, or a feed saved in Bluesky, is added on Manage Sources and becomes a
// channel of posts, with reply, repost and like. Adding a source and the
// channel are real; the feed pages and the writes would go to the reader's PDS,
// which the E2E session doesn't have, so they're routed here.

const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function post(name: string, text: string, over: Record<string, unknown> = {}) {
  return {
    uri: `at://did:plc:maya/app.bsky.feed.post/${name}`,
    cid: 'bafyreiaaaaaaaa',
    url: `https://bsky.app/profile/maya.test/post/${name}`,
    author: { did: 'did:plc:maya', handle: 'maya.test', displayName: 'Maya Ortiz' },
    text,
    segments: [{ text }],
    createdAt: iso(2 * HOUR),
    indexedAt: iso(2 * HOUR),
    replyCount: 1,
    repostCount: 0,
    likeCount: 4,
    quoteCount: 0,
    viewer: {},
    sortAt: iso(2 * HOUR),
    ...over,
  };
}

const TIMELINE = [
  post('one', 'Worth your whole afternoon.', {
    external: {
      uri: 'https://example.com/essay',
      title: 'An Essay About Reading',
      description: 'On attention, and what it adds up to.',
    },
  }),
  post('two', 'Morning, everyone.', {
    author: { did: 'did:plc:ben', handle: 'ben.test', displayName: 'Ben' },
    repostedBy: { did: 'did:plc:kat', handle: 'kat.test', displayName: 'Kat' },
    sortAt: iso(3 * HOUR),
  }),
];

async function routeTimeline(page: Page) {
  await page.route(/\/api\/v2\/bsky\/feed\?/, (route: Route) =>
    route.fulfill({ json: { scopeRequired: false, posts: TIMELINE, cursor: null } })
  );
}

async function addFollowing(page: Page) {
  await page.goto('/sources#bluesky');
  const section = page.locator('#bluesky');
  const row = section.locator('.source-row', { hasText: 'Following on Bluesky' });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const added = page.waitForResponse(
    (r) => r.url().includes('/api/v2/bsky/feeds') && r.request().method() === 'POST' && r.ok()
  );
  await row.getByRole('button', { name: 'Add' }).click();
  await added;
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/feeds\?view=/, { timeout: 15_000 });
}

test.describe('Bluesky feeds', () => {
  test('asks to read Bluesky feeds on Manage Sources, not the app banner', async ({
    authedPage,
  }) => {
    await authedPage.goto('/sources#bluesky');
    const section = authedPage.locator('#bluesky');
    await expect(section.getByText('Following on Bluesky')).toBeVisible({ timeout: 15_000 });
    await expect(section.getByRole('button', { name: 'Allow access' })).toBeVisible();
    await expect(authedPage.locator('.scope-upgrade-banner')).toHaveCount(0);
  });

  test('makes a channel of the timeline and reads its posts', async ({ authedPage, testUser }) => {
    await seedBlueskyAccess(testUser);
    await routeTimeline(authedPage);
    await addFollowing(authedPage);

    await expect(
      authedPage.locator('.sidebar').getByText('Following on Bluesky', { exact: true })
    ).toBeVisible();
    const posts = authedPage.locator('.article-list .bsky-post');
    await expect(posts).toHaveCount(2);
    await expect(posts.first()).toContainText('Worth your whole afternoon.');
    await expect(posts.nth(1)).toContainText('Reposted by Kat');
    await authedPage.screenshot({ path: 'test-results/bluesky-feed.png', fullPage: false });

    // The source is in the channel pickers by name.
    await expect(authedPage.locator('.scope-upgrade-banner')).toHaveCount(0);
  });

  test('asks before the first like, then likes and replies', async ({ authedPage, testUser }) => {
    await seedBlueskyAccess(testUser);
    await routeTimeline(authedPage);
    await addFollowing(authedPage);

    // Without the write permission, a like asks inline instead of sending.
    const first = authedPage.locator('.article-list .bsky-post').first();
    await first.getByRole('button', { name: 'Like' }).click();
    await expect(first.getByText('Skyreader needs permission to post to Bluesky')).toBeVisible();
    await first.getByRole('button', { name: 'Not now' }).click();

    await seedBlueskyAccess(testUser, { write: true });
    await authedPage.reload();
    let likeBody: unknown = null;
    await authedPage.route(/\/api\/v2\/bsky\/like$/, (route) => {
      likeBody = route.request().postDataJSON();
      return route.fulfill({ json: { uri: `at://${testUser.did}/app.bsky.feed.like/3new` } });
    });
    let replyBody: unknown = null;
    await authedPage.route(/\/api\/v2\/bsky\/post$/, (route) => {
      replyBody = route.request().postDataJSON();
      return route.fulfill({
        json: { uri: 'at://x/app.bsky.feed.post/r', cid: 'c', url: 'https://bsky.app/x' },
      });
    });

    const card = authedPage.locator('.article-list .bsky-post').first();
    await card.getByRole('button', { name: 'Like' }).click();
    await expect(card.getByRole('button', { name: 'Unlike' })).toContainText('5');
    expect(likeBody).toEqual({ uri: TIMELINE[0].uri, cid: TIMELINE[0].cid });

    await card.getByRole('button', { name: 'Reply' }).click();
    await card.getByRole('textbox', { name: /Reply to/ }).fill('Reading it now.');
    await card.getByRole('button', { name: 'Reply', exact: true }).last().click();
    await expect(authedPage.getByText('Replied')).toBeVisible();
    expect(replyBody).toMatchObject({
      text: 'Reading it now.',
      reply: {
        root: { uri: TIMELINE[0].uri },
        parent: { uri: TIMELINE[0].uri },
      },
    });
    await expect(card.getByRole('button', { name: 'Reply' }).first()).toContainText('2');
  });
});
