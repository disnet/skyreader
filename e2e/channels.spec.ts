import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Create a source channel via the Everything row's + button and modal form. */
async function createChannel(page: Page, name: string) {
  // Channels live under the Everything nav row. Click the + add button on that row.
  const everythingRow = page.locator('.nav-row', {
    has: page.locator('.nav-label', { hasText: 'Everything' }),
  });
  await expect(everythingRow).toBeVisible({ timeout: 15_000 });
  await everythingRow.locator('.row-add-btn').click({ force: true });

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
  test('sidebar shows Everything section', async ({ authedPage }) => {
    await expect(authedPage.locator('.nav-label', { hasText: 'Everything' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('create a new channel via + button', async ({ authedPage }) => {
    await createChannel(authedPage, 'Test Channel');

    // URL should include view= parameter
    await expect(authedPage).toHaveURL(/view=/);
  });

  test('rename a channel via context menu', async ({ authedPage }) => {
    await createChannel(authedPage, 'Rename Me');

    // Right-click the view item to open the context menu
    const viewItem = authedPage.locator('.view-item', { hasText: 'Rename Me' });
    await viewItem.click({ button: 'right' });

    // Click Rename in the context menu
    const renameItem = authedPage.locator('.context-menu-item', { hasText: 'Rename' });
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
      authedPage.locator('.view-item .nav-label', { hasText: 'My Tech Channel' })
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
    const deleteItem = authedPage.locator('.context-menu-item.danger', { hasText: 'Delete' });
    await expect(deleteItem).toBeVisible({ timeout: 5_000 });
    await deleteItem.click();

    // Channel should be gone — wait for it to disappear
    const channel = authedPage.locator('.view-item .nav-label', { hasText: 'Delete Me' });
    await expect(channel).not.toBeVisible({ timeout: 5_000 });
  });

  test('clicking a channel navigates to its view', async ({ authedPage }) => {
    await createChannel(authedPage, 'Nav Channel');

    const viewItem = authedPage.locator('.view-item', { hasText: 'Nav Channel' });

    // Navigate away first
    await authedPage.locator('.nav-label', { hasText: 'Everything' }).click();
    await expect(authedPage).toHaveURL(/\/$/);

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
