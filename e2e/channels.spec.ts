import { test, expect } from './fixtures';
import type { Page, Response } from '@playwright/test';
import {
  seedSubscription,
  seedFeedItems,
  cleanupFeedItems,
  seedChannel,
  seedShelfCollection,
  seedSavedArticle,
} from './seed';
import type { TestUser } from './seed';

/** The sidebar's Channels section, which ends in New channel. */
function channelsGroup(page: Page) {
  return page.locator('.nav-group', {
    has: page.locator('.nav-row .nav-label', { hasText: 'Channels' }),
  });
}

/** Create a channel via the Channels section's New channel button and the modal form. */
async function createChannel(page: Page, name: string) {
  const navGroup = channelsGroup(page);
  await expect(navGroup).toBeVisible({ timeout: 15_000 });
  await navGroup.locator('.new-channel-btn').click();

  // Fill the channel name in the modal
  const nameInput = page.locator('#channel-name');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(name);

  await page.getByRole('button', { name: 'Create channel' }).click();

  // Wait for the channel to appear in the sidebar
  const channel = page.locator('.view-item .nav-label', { hasText: name });
  await expect(channel).toBeVisible({ timeout: 10_000 });
}

test.describe('Channels', () => {
  test('sidebar shows Feeds section', async ({ authedPage }) => {
    await expect(authedPage.locator('.nav-label', { hasText: 'Feeds' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('create a new channel via + button', async ({ authedPage }) => {
    await createChannel(authedPage, 'Test Channel');

    // URL should include view= parameter
    await expect(authedPage).toHaveURL(/view=/);
  });

  test('a channel picked from a folder names itself and keeps the folder', async ({
    authedPage,
    testUser,
  }) => {
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/folder-a.xml',
      title: 'Folder Feed A',
      category: 'Tech',
    });
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/folder-b.xml',
      title: 'Folder Feed B',
      category: 'Tech',
    });
    await seedSubscription(testUser, {
      feedUrl: 'https://example.com/loose.xml',
      title: 'Loose Feed',
    });
    await authedPage.reload();

    await channelsGroup(authedPage).locator('.new-channel-btn').click();

    // A new channel starts with every source; with none, there's nothing to make.
    await expect(authedPage.getByRole('button', { name: 'Select all' })).toBeDisabled();
    await authedPage.getByRole('button', { name: 'Select none' }).click();
    await authedPage.getByRole('button', { name: 'Create channel' }).click();
    await expect(authedPage.getByRole('alert')).toHaveText('Pick at least one source');

    await authedPage.getByRole('button', { name: 'Show only Tech' }).click();
    await expect(authedPage.locator('#channel-name')).toHaveValue('Tech');
    await authedPage.getByRole('button', { name: 'Create channel' }).click();

    const channel = authedPage.locator('.view-item .nav-label', { hasText: 'Tech' });
    await expect(channel).toBeVisible({ timeout: 10_000 });

    // It reopens holding the folder itself, not the two feeds in it.
    await authedPage.locator('.view-item', { hasText: 'Tech' }).click({ button: 'right' });
    await authedPage.getByRole('menuitem', { name: 'Edit' }).click();
    await expect(authedPage.getByRole('heading', { name: 'Edit channel' })).toBeVisible();
    const folder = authedPage.locator('.source-row', { hasText: 'Tech' }).getByRole('checkbox');
    await expect(folder).toBeChecked();
    const loose = authedPage
      .locator('.source-row', { hasText: 'Loose Feed' })
      .getByRole('checkbox');
    await expect(loose).not.toBeChecked();
  });

  test('the header Edit button opens a saved channel in its editor', async ({
    authedPage,
    testUser,
  }) => {
    // A channel of your saves routes to /saved?view=<uuid> and puts an Edit
    // button in the header. That button used to resolve the channel with
    // `parseInt(viewFilter)` — but `viewFilter` is the uuid, so it passed NaN
    // and the editor opened blank, with its Save writing to no row at all.
    // Seeded as an old Saved channel, which now opens as a channel of your saves
    // with its filter kept.
    await seedChannel(testUser, {
      uuid: crypto.randomUUID(),
      name: 'Edit From Header',
      config: {
        mode: 'saved',
        readFilter: 'unread',
        sortOrder: 'newest',
        savedSourceFilter: ['feed'],
      },
    });
    await authedPage.reload();
    await authedPage.locator('.view-item .nav-label', { hasText: 'Edit From Header' }).click();
    await expect(authedPage).toHaveURL(/\/saved\?view=/);

    await authedPage.getByRole('button', { name: 'Edit channel' }).click();

    // The editor is populated with this channel, not an empty create form.
    await expect(authedPage.getByRole('heading', { name: 'Edit channel' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(authedPage.locator('#channel-name')).toHaveValue('Edit From Header');
    await expect(authedPage.getByRole('button', { name: 'Feed Articles' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('rename a channel via context menu', async ({ authedPage }) => {
    await createChannel(authedPage, 'Rename Me');

    // Right-click the view item to open the context menu
    const viewItem = authedPage.locator('.view-item', { hasText: 'Rename Me' });
    await viewItem.click({ button: 'right' });

    // Click Rename in the context menu
    const renameItem = authedPage.locator('.context-menu-item', {
      hasText: 'Rename',
    });
    await expect(renameItem).toBeVisible({ timeout: 5_000 });
    await renameItem.click();

    // An input should appear — when the view enters rename mode the nav-label
    // is replaced with an input, so we can't filter by the old name's text.
    const renameInput = authedPage.locator('.view-item .rename-input');
    await expect(renameInput).toBeVisible({ timeout: 5_000 });

    // Clear and type a new name
    await renameInput.fill('My Tech Channel');
    await renameInput.press('Enter');

    // The channel should now display the new name
    await expect(
      authedPage.locator('.view-item .nav-label', {
        hasText: 'My Tech Channel',
      })
    ).toBeVisible({
      timeout: 5_000,
    });
  });

  test('delete a channel via context menu', async ({ authedPage }) => {
    await createChannel(authedPage, 'Delete Me');

    // Open context menu
    const viewItem = authedPage.locator('.view-item', { hasText: 'Delete Me' });
    await viewItem.locator('.more-btn').click({ force: true });

    // Handle the confirmation dialog
    authedPage.on('dialog', (dialog) => dialog.accept());

    // Click Delete
    const deleteItem = authedPage.locator('.context-menu-item.danger', {
      hasText: 'Delete',
    });
    await expect(deleteItem).toBeVisible({ timeout: 5_000 });
    await deleteItem.click();

    // Channel should be gone — wait for it to disappear
    const channel = authedPage.locator('.view-item .nav-label', {
      hasText: 'Delete Me',
    });
    await expect(channel).not.toBeVisible({ timeout: 5_000 });
  });

  test('clicking a channel navigates to its view', async ({ authedPage }) => {
    await createChannel(authedPage, 'Nav Channel');

    const viewItem = authedPage.locator('.view-item', {
      hasText: 'Nav Channel',
    });

    // Navigate away first
    await authedPage.locator('.nav-label', { hasText: 'Feeds' }).click();
    await expect(authedPage).toHaveURL(/\/feeds/);

    // Click the channel to navigate to it
    await viewItem.click();
    await expect(authedPage).toHaveURL(/view=/);

    // The channel should be active (highlighted)
    await expect(viewItem).toHaveClass(/active/);
  });

  test('a new channel takes in your saves beside its feeds', async ({ authedPage, testUser }) => {
    const feedUrl = `https://example.com/mixed-${testUser.did.slice(-8)}.xml`;
    await seedSubscription(testUser, { feedUrl, title: 'Mixed Feed' });
    await seedFeedItems(feedUrl, [
      { guid: `mixed-${testUser.did.slice(-8)}`, title: 'A feed post' },
    ]);
    await seedSavedArticle(testUser, {
      url: 'https://elsewhere.example/kept-page',
      title: 'A page I saved',
    });
    try {
      await authedPage.reload();
      await channelsGroup(authedPage).locator('.new-channel-btn').click();
      // Every source is picked, the Library's included.
      await expect(
        authedPage.locator('.source-row', { hasText: 'Your saves' }).getByRole('checkbox')
      ).toBeChecked();
      await authedPage.locator('#channel-name').fill('Everything I read');
      await authedPage.getByRole('button', { name: 'Create channel' }).click();

      await expect(authedPage.getByText('A feed post', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(authedPage.getByText('A page I saved', { exact: true })).toBeVisible();
    } finally {
      await cleanupFeedItems(feedUrl);
    }
  });

  test('Manage Sources link navigates to /sources', async ({ authedPage }) => {
    await authedPage.locator('.nav-label', { hasText: 'Manage Sources' }).click();
    await expect(authedPage).toHaveURL(/\/sources/);
  });
});

/**
 * "I hit SAVE, but then when I refresh the page it goes back to the old
 * unfiltered view."
 *
 * The channel really was persisted — the load path lost it. `?view=` is read
 * out of the URL before the channel store has hydrated from Dexie, the lookup
 * missed, and the toolbar was reset to "all sources" with nothing to re-run it.
 * This is a lifecycle bug in the ordering of a component effect against an
 * async store load, so only a real reload can pin it.
 */
test.describe('A channel filter survives a reload', () => {
  const NOISY_FEED = 'https://example.com/channel-noisy-feed.xml';
  const QUIET_FEED = 'https://example.com/channel-quiet-feed.xml';
  const NOISY_POST = 'Noisy Post One';
  const QUIET_POST = 'Quiet Post One';

  test.afterEach(async () => {
    await cleanupFeedItems(NOISY_FEED);
    await cleanupFeedItems(QUIET_FEED);
  });

  async function seedTwoFeeds(user: TestUser) {
    await seedSubscription(user, { feedUrl: NOISY_FEED, title: 'Noisy Blog' });
    await seedSubscription(user, { feedUrl: QUIET_FEED, title: 'Quiet Blog' });
    await seedFeedItems(NOISY_FEED, [{ guid: 'channel-noisy-1', title: NOISY_POST }], {
      title: 'Noisy Blog',
      siteUrl: 'https://example.com',
    });
    await seedFeedItems(QUIET_FEED, [{ guid: 'channel-quiet-1', title: QUIET_POST }], {
      title: 'Quiet Blog',
      siteUrl: 'https://example.com',
    });
  }

  function openFilterToolbar(page: Page) {
    return page.locator('button[aria-label="Toggle filters"]').click();
  }

  /**
   * Drive the toolbar exactly as the user does: exclude one source, then Save
   * the resulting view as a named channel. Save writes the channel immediately
   * under a generated name and opens that name for editing, so renaming it is a
   * second write. Leaves the page on `?view=<uuid>` with both through to D1.
   */
  async function excludeNoisyAndSaveChannel(page: Page, name: string) {
    await openFilterToolbar(page);

    await page.locator('.filter-toolbar .source-btn').click();
    // Every source starts checked; unchecking one leaves it out.
    await expect(page.getByRole('checkbox', { name: 'Noisy Blog' })).toBeChecked();
    await page.getByRole('checkbox', { name: 'Noisy Blog' }).uncheck();

    // The excluded source drops out of the list right away — the state the user
    // is trying to make permanent.
    await expect(page.getByText(NOISY_POST, { exact: true })).toHaveCount(0);

    // Close the popover so it isn't covering the Save button.
    await page.keyboard.press('Escape');

    const isChannelWrite = (r: Response) =>
      /\/api\/channels\//.test(r.url()) && r.request().method() === 'PUT';

    const created = page.waitForResponse(isChannelWrite);
    await page.locator('.filter-toolbar .save-btn').click();

    // The channel exists already; the input carries its auto-generated name.
    await expect(page).toHaveURL(/view=/);
    await created;

    const nameInput = page.locator('.filter-toolbar .save-name-input .name-input');
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    const renamed = page.waitForResponse(isChannelWrite);
    await nameInput.fill(name);
    await nameInput.press('Enter');
    // Don't reload until the rename has actually landed in D1.
    await renamed;
  }

  test('the excluded source is still excluded after a refresh', async ({
    authedPage,
    testUser,
  }) => {
    await seedTwoFeeds(testUser);
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText(NOISY_POST, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(authedPage.getByText(QUIET_POST, { exact: true })).toBeVisible();

    await excludeNoisyAndSaveChannel(authedPage, 'No Noise');

    await authedPage.reload();

    // The channel's own item is what tells us the list has rendered; asserting
    // the absence of the noisy one first would pass against an empty list.
    await expect(authedPage.getByText(QUIET_POST, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(authedPage.getByText(NOISY_POST, { exact: true })).toHaveCount(0);
  });

  test('a reload restores the active channel toolbar', async ({ authedPage, testUser }) => {
    await seedTwoFeeds(testUser);
    await authedPage.goto('/feeds');
    await expect(authedPage.getByText(NOISY_POST, { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    await excludeNoisyAndSaveChannel(authedPage, 'Still No Noise');

    await authedPage.reload();
    await expect(authedPage.getByText(QUIET_POST, { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // An active desktop channel uses the dedicated editor instead of rendering
    // the inline Save/Update control. Verify the restored channel reaches that
    // state; the store-level tests cover the transient unsaved-changes guard.
    await openFilterToolbar(authedPage);
    await expect(authedPage.getByRole('button', { name: 'Edit channel' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Update' })).toHaveCount(0);
  });
});

test.describe('Channel order', () => {
  test('channels reorder by drag and by the menu, and the order syncs', async ({
    authedPage,
    testUser,
  }) => {
    const names = ['First', 'Second', 'Third'];
    const uuids = names.map((_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
    for (const [i, name] of names.entries()) {
      await seedChannel(testUser, {
        uuid: uuids[i],
        name,
        config: { readFilter: 'all', sortOrder: 'newest', sourceMode: 'exclude', sourceKeys: [] },
        position: i,
      });
    }
    await authedPage.reload();

    const rows = channelsGroup(authedPage).locator('.view-item .nav-label');
    await expect(rows).toHaveText(names, { timeout: 15_000 });

    // Drag Third above First with the mouse.
    const third = (await rows.nth(2).boundingBox())!;
    const first = (await rows.nth(0).boundingBox())!;
    await authedPage.mouse.move(third.x + 10, third.y + third.height / 2);
    await authedPage.mouse.down();
    await authedPage.mouse.move(first.x + 10, first.y + first.height / 2, { steps: 8 });
    await authedPage.mouse.move(first.x + 10, first.y + 2, { steps: 2 });
    const pushed = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/channels/order') && r.request().method() === 'PUT'
    );
    await authedPage.mouse.up();
    await pushed;
    await expect(rows).toHaveText(['Third', 'First', 'Second']);
    // The release didn't open the channel it dropped.
    await expect(authedPage).not.toHaveURL(/view=/);

    // Move Second up a step from its menu.
    await rows.nth(2).click({ button: 'right' });
    const pushedAgain = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/channels/order') && r.request().method() === 'PUT'
    );
    await authedPage.getByRole('menuitem', { name: 'Move up' }).click();
    await pushedAgain;
    await expect(rows).toHaveText(['Third', 'Second', 'First']);

    // The server holds the new order, so another device gets it.
    const res = await authedPage.request.get('http://127.0.0.1:8787/api/channels');
    const { channels } = (await res.json()) as { channels: Array<{ name: string }> };
    expect(channels.map((c) => c.name)).toEqual(['Third', 'Second', 'First']);
  });

  test('Library collections reorder by drag and from the keyboard', async ({
    authedPage,
    testUser,
  }) => {
    const names = ['Books', 'Papers', 'Essays'];
    for (const [i, name] of names.entries()) {
      await seedShelfCollection(testUser, { id: `3kcollorder00${i}`, name, position: i });
    }
    await authedPage.reload();

    const rows = authedPage.locator('.collection-item .nav-label');
    await expect(rows).toHaveText(names, { timeout: 15_000 });

    // Drag Essays above Books. The row follows the pointer while the others
    // slide aside; nothing reorders until the drop.
    const essays = (await rows.nth(2).boundingBox())!;
    const books = (await rows.nth(0).boundingBox())!;
    await authedPage.mouse.move(essays.x + 10, essays.y + essays.height / 2);
    await authedPage.mouse.down();
    await authedPage.mouse.move(books.x + 10, books.y + books.height / 2, { steps: 8 });
    await authedPage.mouse.move(books.x + 10, books.y + 2, { steps: 2 });
    await expect(rows).toHaveText(names);
    const lifted = authedPage.locator('.collection-item.lifted');
    await expect(lifted).toHaveText('Essays');
    const pushed = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/shelf/collections') && r.request().method() === 'PUT'
    );
    await authedPage.mouse.up();
    await pushed;
    await expect(rows).toHaveText(['Essays', 'Books', 'Papers']);
    // The drop didn't follow the link.
    await expect(authedPage).not.toHaveURL(/collection=/);

    // From the keyboard: Alt+↑ on the focused row.
    await authedPage.locator('.collection-item', { hasText: 'Papers' }).focus();
    const pushedAgain = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/shelf/collections') && r.request().method() === 'PUT'
    );
    await authedPage.keyboard.press('Alt+ArrowUp');
    await pushedAgain;
    await expect(rows).toHaveText(['Essays', 'Papers', 'Books']);

    await authedPage.reload();
    await expect(rows).toHaveText(['Essays', 'Papers', 'Books'], { timeout: 15_000 });
  });
});
