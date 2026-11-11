import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  seedSubscription,
  seedFeedItems,
  seedSavedArticle,
  seedShelfCollection,
  cleanupFeedItems,
} from './seed';

// A feed card's Save and Share use the reader's own menus: Save is split, its
// button saving and unsaving and its arrow opening the panel where the article
// is kept on the Shelf or filed; Share lists where it can go.
test.describe('Feed card Save and Share menus', () => {
  const FEED_URL = 'https://example.com/card-menus-feed.xml';
  const FEED_TITLE = 'Card Menus Feed';

  test.afterEach(async () => {
    await cleanupFeedItems(FEED_URL);
  });

  test("Share opens the Share menu; Save's arrow opens the Save panel", async ({
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
    // so a save made from the card is refused (and queued) here. Save's arrow
    // opens the panel to file it.
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

    // Save's arrow opens the panel to keep it on the Shelf or file it.
    const save = card.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await expect(save).toHaveText('Saved');
    await expect(save).not.toHaveAttribute('aria-haspopup');
    const arrow = card.getByRole('button', { name: 'Shelf and collections' });
    await expect(arrow).toHaveAttribute('aria-haspopup', 'dialog');
    await arrow.click();
    const panel = authedPage.getByRole('dialog', { name: 'Save to Library' });
    await expect(panel.getByText('Saved to your Queue')).toBeVisible();
    await expect(arrow).toHaveAttribute('aria-expanded', 'true');

    const added = authedPage.waitForResponse(
      (r) => r.url().includes('/items') && r.request().method() === 'POST'
    );
    await panel.getByRole('checkbox', { name: /Field notes/ }).check();
    expect((await added).status()).toBe(200);
    await expect(panel.getByRole('checkbox', { name: /Shelf/ })).toBeChecked();

    // A click elsewhere puts it away; the card stays saved.
    await authedPage.mouse.click(5, 300);
    await expect(panel).toBeHidden();
    await expect(save).toHaveAttribute('aria-pressed', 'true');

    // Remove, from the panel, unsaves.
    await arrow.click();
    await panel.getByRole('button', { name: 'Remove' }).click();
    await expect(panel).toBeHidden();
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    await expect(save).toHaveText('Save');
  });

  test('Save itself unsaves, without opening the panel', async ({ authedPage, testUser }) => {
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'card-toggle-item',
          title: 'A Card To Unsave',
          url: 'https://example.com/card-toggle',
          summary: 'Saved by mistake.',
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
    await seedSavedArticle(testUser, {
      url: 'https://example.com/card-toggle',
      title: 'A Card To Unsave',
      itemGuid: 'card-toggle-item',
      domain: 'example.com',
    });

    await authedPage.goto('/feeds');
    const card = authedPage.locator('.article-item-anchor', {
      has: authedPage.getByText('A Card To Unsave', { exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('button.article-header').click();

    const save = card.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toHaveAttribute('aria-pressed', 'true');
    await save.click();
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    await expect(authedPage.getByRole('dialog', { name: 'Save to Library' })).toHaveCount(0);
  });

  // On a phone the row leads with Save, labeled, and the rest are full-size
  // icon buttons that never spill off the card; Recommend waits in ⋯.
  test('Phone card: Save leads, every action is a full tap target', async ({
    authedPage,
    testUser,
  }) => {
    await authedPage.setViewportSize({ width: 360, height: 760 });
    await seedSubscription(testUser, { feedUrl: FEED_URL, title: FEED_TITLE });
    await seedFeedItems(
      FEED_URL,
      [
        {
          guid: 'card-phone-item',
          title: 'A Card On A Phone',
          url: 'https://example.com/card-phone',
          summary: 'Small screen, same row.',
        },
        {
          guid: 'card-phone-saved',
          title: 'A Saved Card On A Phone',
          url: 'https://example.com/card-phone-saved',
          summary: 'Saved reads longer than Save.',
        },
      ],
      { title: FEED_TITLE, siteUrl: 'https://example.com' }
    );
    await seedSavedArticle(testUser, {
      url: 'https://example.com/card-phone-saved',
      title: 'A Saved Card On A Phone',
      itemGuid: 'card-phone-saved',
      domain: 'example.com',
    });

    await authedPage.goto('/feeds');
    const card = authedPage.locator('.article-item-anchor', {
      has: authedPage.getByText('A Card On A Phone', { exact: true }),
    });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.locator('button.article-header').click();

    const save = card.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeVisible();
    await expect(save.locator('.action-label')).toBeVisible();
    await expect(card.locator('.recommend-btn')).toBeHidden();

    // Icon-only buttons keep their names.
    await expect(card.getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'More', exact: true })).toBeVisible();

    // The row fits, saved or not ("Saved" is the widest Save gets).
    const saved = authedPage.locator('.article-item-anchor', {
      has: authedPage.getByText('A Saved Card On A Phone', { exact: true }),
    });
    await expectRowFits(card);
    await card.locator('.overflow-trigger').click();
    await expect(card.locator('.overflow-menu').getByText('Recommend')).toBeVisible();
    await card.locator('.overflow-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(card.locator('.overflow-menu')).toBeHidden();

    await saved.locator('button.article-header').click();
    await expect(saved.getByRole('button', { name: 'Save', exact: true })).toHaveText('Saved');
    await expectRowFits(saved);
  });
});

async function expectRowFits(card: Locator) {
  const row = card.locator('.article-actions');
  const { cardRight, buttons } = await row.evaluate((el) => {
    const item = el.closest('.article-item')!.getBoundingClientRect();
    return {
      cardRight: item.right,
      buttons: [...el.querySelectorAll<HTMLElement>('.action-btn')]
        .filter((b) => b.offsetParent)
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { name: b.className, w: r.width, h: r.height, right: r.right };
        }),
    };
  });
  expect(buttons.length).toBeGreaterThan(3);
  for (const b of buttons) {
    expect(b.h, b.name).toBeGreaterThanOrEqual(44);
    expect(b.w, b.name).toBeGreaterThanOrEqual(32);
    expect(b.right, b.name).toBeLessThanOrEqual(cardRight + 0.5);
  }
}
