import { test, expect } from './fixtures';
import {
  seedSubscription,
  seedFeedItems,
  seedSavedArticle,
  seedShelfCollection,
  cleanupFeedItems,
} from './seed';

// A feed card's Save and Share open the reader's own menus: Save puts the
// article in the Library and opens the panel where it's kept on the Shelf or
// filed, Share lists where it can go.
test.describe('Feed card Save and Share menus', () => {
  const FEED_URL = 'https://example.com/card-menus-feed.xml';
  const FEED_TITLE = 'Card Menus Feed';

  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  test('Share opens the Share menu; Saved opens the Save panel', async ({
    authedPage,
    testUser,
  }) => {
    await seedShelfCollection(testUser, { id: '3cardmenus0001', name: 'Field notes', position: 0 });
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'card-menus-item',
          title: 'A Card With Menus',
          url: 'https://example.com/card-menus',
          summary: 'Something worth keeping.',
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
    // Already saved: the seeded test session's scopes predate the save API's,
    // so a save made from the card is refused (and queued) here. Saved opens
    // the panel to file it.
    await seedSavedArticle(testUser, {
      url: 'https://example.com/card-menus',
      title: 'A Card With Menus',
      itemGuid: 'card-menus-item',
      domain: 'example.com',
    });

    await authedPage.goto('/feeds');
    const card = authedPage.locator('.article-item-anchor', {
      has: authedPage.getByText('A Card With Menus', { exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('button.article-header').click();

    // Share: the reader's menu, and Escape hands focus back to the button.
    const share = card.getByRole('button', { name: /^Share/ });
    await expect(share).toHaveAttribute('aria-haspopup', 'menu');
    await share.click();
    const menu = authedPage.getByRole('menu', { name: 'Share' });
    await expect(menu.getByRole('menuitem', { name: 'Share to your linkblog' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Post to Bluesky' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Open discussion page' })).toBeVisible();
    // While it's up, the feed's keys stand down: j doesn't move off this card.
    await authedPage.keyboard.press('j');
    await expect(menu).toBeVisible();
    await expect(card.locator('.article-item.highlighted')).toBeVisible();
    await authedPage.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(share).toBeFocused();

    // Saved: opens the panel to keep it on the Shelf or file it.
    const save = card.getByRole('button', { name: /^Saved/ });
    await expect(save).toHaveAttribute('aria-haspopup', 'dialog');
    await save.click();
    const panel = authedPage.getByRole('dialog', { name: 'Save to Library' });
    await expect(panel.getByText('Saved to your Library')).toBeVisible();
    await expect(save).toHaveAttribute('aria-expanded', 'true');

    const added = authedPage.waitForResponse(
      (r) => r.url().includes('/items') && r.request().method() === 'POST'
    );
    await panel.getByRole('checkbox', { name: /Field notes/ }).check();
    expect((await added).status()).toBe(200);
    await expect(panel.getByRole('checkbox', { name: /Shelf/ })).toBeChecked();

    // A click elsewhere puts it away; the card stays saved.
    await authedPage.mouse.click(5, 300);
    await expect(panel).toBeHidden();
    await expect(card.getByRole('button', { name: /^Saved/ })).toBeVisible();

    // Remove, from the panel, unsaves.
    await card.getByRole('button', { name: /^Saved/ }).click();
    await panel.getByRole('button', { name: 'Remove' }).click();
    await expect(panel).toBeHidden();
    await expect(card.getByRole('button', { name: /^Save$/ })).toBeVisible();
  });
});
