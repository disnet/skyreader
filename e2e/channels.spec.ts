import { test, expect } from './fixtures';
import type { Page, Response } from '@playwright/test';
import { seedSubscription, seedFeedItems, cleanupFeedItems } from './seed';
import type { TestUser } from './seed';

/** Create a channel via a nav row's + button and the modal form. */
async function createChannel(page: Page, name: string, row: 'Feeds' | 'Saved' = 'Feeds') {
  // Channels live under the Feeds and Saved nav rows. Click the + add button.
  const navRow = page.locator('.nav-row', {
    has: page.locator('.nav-label', { hasText: row }),
  });
  await expect(navRow).toBeVisible({ timeout: 15_000 });
  await navRow.locator('.row-add-btn').click({ force: true });

  // Fill the channel name in the modal
  const nameInput = page.locator('#view-name');
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  await nameInput.fill(name);

  // Click the Create button
  await page.locator('button.btn-primary', { hasText: 'Create' }).click();

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

  test('the header Edit button opens a saved channel in its editor', async ({ authedPage }) => {
    // A saved channel routes to /saved?view=<uuid> and puts an Edit button in
    // the header. That button used to resolve the channel with
    // `parseInt(viewFilter)` — but `viewFilter` is the uuid, so it passed NaN
    // and the editor opened blank, with its Save writing to no row at all.
    await createChannel(authedPage, 'Edit From Header', 'Saved');
    await expect(authedPage).toHaveURL(/\/saved\?view=/);

    await authedPage.getByRole('button', { name: 'Edit channel' }).click();

    // The editor is populated with this channel, not an empty create form.
    await expect(authedPage.getByRole('heading', { name: 'Edit Channel' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(authedPage.locator('#view-name')).toHaveValue('Edit From Header');
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
    await page.getByRole('radio', { name: 'Exclude only' }).check();
    await page.getByRole('checkbox', { name: 'Noisy Blog' }).check();

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
    await expect(authedPage.getByRole('button', { name: 'Edit Channel' })).toBeVisible();
    await expect(authedPage.getByRole('button', { name: 'Update' })).toHaveCount(0);
  });
});
