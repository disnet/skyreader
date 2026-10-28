import { expect } from '@playwright/test';
import { test } from './fixtures';
import type { Page } from '@playwright/test';

// The Queue says where the saves live, and opens the backing picker in place.
// The backing itself is stubbed on GET /api/settings: a real one would make
// GET /api/saved read through a Semble collection this stack doesn't have.

const URI = 'at://did:plc:test/network.cosmik.collection/3queuebacking';

async function stubBacking(page: Page, backed: boolean) {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const json = await res.json();
    json.backing = backed ? { provider: 'semble', collectionUri: URI } : { provider: 'skyreader' };
    json.lastSuccessfulBackingPoll = backed ? Date.now() - 4 * 60_000 : null;
    await route.fulfill({ response: res, json });
  });
  await page.route('**/api/integrations/status', (route) =>
    route.fulfill({ json: { scopeStatus: { semble: true, margin: true } } })
  );
  await page.route('**/api/integrations/semble/collections', (route) =>
    route.fulfill({ json: { collections: [{ uri: URI, name: 'Reading queue' }] } })
  );
}

test.describe('Queue backing line', () => {
  test('says the Queue is private, and opens the picker', async ({ authedPage: page }) => {
    await stubBacking(page, false);
    await page.goto('/saved');

    const line = page.locator('.queue-backing');
    await expect(line).toContainText('Private to Skyreader.');
    await line.getByRole('button', { name: 'Link to Semble or Margin' }).click();

    const dialog = page.getByRole('dialog', { name: 'Where your Queue lives' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Semble/ }).click();
    await expect(dialog.getByText('Backing publishes all of your saves publicly.')).toBeVisible();
  });

  test('names the linked collection and when it synced', async ({ authedPage: page }) => {
    await stubBacking(page, true);
    await page.goto('/saved');

    const line = page.locator('.queue-backing');
    await expect(line).toContainText('Linked to Semble · Reading queue, public.');
    await expect(line).toContainText('Synced 4m ago.');
    await line.getByRole('button', { name: 'Change' }).click();
    await expect(page.getByRole('dialog', { name: 'Where your Queue lives' })).toContainText(
      'Backed by Semble.'
    );
  });

  test('reopens the picker on return from granting a permission', async ({ authedPage: page }) => {
    await stubBacking(page, false);
    await page.goto('/saved?backing');

    await expect(page.getByRole('dialog', { name: 'Where your Queue lives' })).toBeVisible();
    await expect(page).toHaveURL(/\/saved$/);
  });
});
