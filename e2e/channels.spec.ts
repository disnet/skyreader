import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/** Create a channel via the sidebar + button and modal form. */
async function createChannel(page: Page, name: string) {
  const channelsSection = page.locator('.section-header', { hasText: 'Channels' });
  await expect(channelsSection).toBeVisible({ timeout: 15_000 });
  await channelsSection.locator('.add-btn').click();

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
  test('sidebar shows Channels section', async ({ authedPage }) => {
    await expect(authedPage.locator('text=Channels')).toBeVisible({ timeout: 15_000 });
  });

  test('create a new channel via + button', async ({ authedPage }) => {
    await createChannel(authedPage, 'Test Channel');

    // URL should include view= parameter
    await expect(authedPage).toHaveURL(/view=/);
  });

  test('rename a channel via context menu', async ({ authedPage }) => {
    await createChannel(authedPage, 'Rename Me');

    // Click the more (three dot) button to open context menu
    const viewItem = authedPage.locator('.view-item', { hasText: 'Rename Me' });
    const moreBtn = viewItem.locator('.more-btn');
    // Force click since the more-btn may be hidden until hover
    await moreBtn.click({ force: true });

    // Click Rename in the context menu
    const renameItem = authedPage.locator('.context-menu-item', { hasText: 'Rename' });
    await expect(renameItem).toBeVisible({ timeout: 5_000 });
    await renameItem.click();

    // An input should appear with the current name
    const renameInput = viewItem.locator('.rename-input');
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
