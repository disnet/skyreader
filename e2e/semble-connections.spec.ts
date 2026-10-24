import { test, expect } from './fixtures';
import { cleanupSembleConnection, seedSavedArticle, seedSembleConnection } from './seed';

// Semble connections other people drew off a save: a quiet "new" badge on the
// card in the Queue and on the Shelf, a New connections lane at the top of the
// Shelf whose tiles say who connected what, and both stay until the reader
// marks them seen, in the save's discussion or on the tile.
test.describe('Semble connections on saves', () => {
  test('a new connection badges the save until the reader marks it seen', async ({
    authedPage,
    testUser,
  }) => {
    const savedUrl = 'https://example.com/connected-essay';
    await seedSavedArticle(testUser, {
      url: savedUrl,
      title: 'A Connected Essay',
      domain: 'example.com',
      content: '<p>The essay itself.</p>',
      savedAt: Date.now() - 60_000,
    });
    const uri = await seedSembleConnection(testUser, {
      savedUrl,
      otherUrl: 'https://elsewhere.example/a-careful-response',
      note: 'Picks up the argument where the essay stops.',
    });

    try {
      await authedPage.goto('/saved');
      const card = authedPage.locator('.bookmark-card', { hasText: 'A Connected Essay' });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByLabel('1 new connection on Semble')).toBeVisible({
        timeout: 15_000,
      });

      await authedPage.goto('/shelf');
      const lane = authedPage.locator('section', { hasText: 'New connections' }).first();
      await expect(lane).toBeVisible({ timeout: 15_000 });
      // The lane says what happened: to what, how, and the curator's note.
      await expect(lane.getByText('elsewhere.example · a careful response')).toBeVisible();
      await expect(lane.getByText('supports')).toBeVisible();
      await expect(lane.getByText('Picks up the argument where the essay stops.')).toBeVisible();

      // Opening the save keeps the news: its discussion opens on Connections with
      // the new one there (from Skyreader's own record, ahead of Semble's index),
      // until the reader marks it seen.
      await lane.getByText('A Connected Essay').click();
      const markSeen = authedPage.getByRole('button', { name: 'Mark 1 new connection as seen' });
      await expect(markSeen).toBeVisible({ timeout: 15_000 });
      await expect(
        authedPage.locator('.connection-row', { hasText: 'elsewhere.example' }).first()
      ).toBeVisible();
      const seen = authedPage.waitForResponse(
        (r) => r.url().includes('/api/saved/connections/seen') && r.request().method() === 'POST'
      );
      await markSeen.click();
      expect((await seen).ok()).toBe(true);
      await expect(markSeen).toHaveCount(0);

      // Back on the Queue the badge is gone, and stays gone after a reload.
      await authedPage.goto('/saved');
      await expect(card).toBeVisible({ timeout: 15_000 });
      await authedPage.reload();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await expect(card.getByLabel(/new connection/)).toHaveCount(0);
    } finally {
      await cleanupSembleConnection(uri);
    }
  });

  test("a tile's connection opens the link menu, and the tile clears itself", async ({
    authedPage,
    testUser,
  }) => {
    const savedUrl = 'https://example.com/tile-essay';
    const otherUrl = 'https://elsewhere.example/a-tile-response';
    await seedSavedArticle(testUser, {
      url: savedUrl,
      title: 'A Tile Essay',
      domain: 'example.com',
      content: '<p>The essay itself.</p>',
      savedAt: Date.now() - 60_000,
    });
    // Four new connections: the server sends the newest three, and the tile
    // counts the rest.
    const uris = [
      await seedSembleConnection(testUser, { savedUrl, otherUrl: 'https://older.example/one' }),
      await seedSembleConnection(testUser, { savedUrl, otherUrl: 'https://older.example/two' }),
      await seedSembleConnection(testUser, { savedUrl, otherUrl: 'https://older.example/three' }),
      await seedSembleConnection(testUser, { savedUrl, otherUrl, indexedAt: Date.now() + 1000 }),
    ];

    try {
      await authedPage.goto('/shelf');
      const tile = authedPage.getByRole('group', { name: /A Tile Essay/ });
      await expect(tile).toBeVisible({ timeout: 15_000 });
      await expect(tile.getByRole('link')).toHaveCount(3);
      await expect(tile.getByText('+1 more')).toBeVisible();
      // Each connection says how it connects.
      await expect(tile.getByText('supports → this')).toHaveCount(3);

      // The far end is a real link, and a tap asks what to do with it rather than
      // opening the save's discussion.
      const link = tile.getByRole('link', { name: 'elsewhere.example · a tile response' });
      await expect(link).toHaveAttribute('href', otherUrl);
      await link.click();
      const menu = authedPage.getByRole('menu', { name: 'Link actions' });
      await expect(menu.getByRole('menuitem', { name: 'Open in new tab' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Save to Skyreader' })).toBeVisible();
      await authedPage.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(authedPage).toHaveURL(/\/shelf/);
      // Focus goes back to the link the menu came from.
      await expect(link).toBeFocused();

      // The reader can add their own edge back: the dialog opens with their
      // save and the page someone linked to it.
      await link.click();
      await menu.getByRole('menuitem', { name: 'Connect back on Semble…' }).click();
      await expect(authedPage.locator('.chosen-url')).toHaveText(otherUrl);
      await authedPage.getByRole('button', { name: 'Cancel' }).click();
      await expect(authedPage.locator('.chosen-url')).toHaveCount(0);

      // Home carries the same lane.
      await authedPage.goto('/home');
      await expect(tile).toBeVisible({ timeout: 15_000 });
      await authedPage.goto('/shelf');
      await expect(tile).toBeVisible({ timeout: 15_000 });

      // The tile clears itself, here and on the server.
      const seen = authedPage.waitForResponse(
        (r) => r.url().includes('/api/saved/connections/seen') && r.request().method() === 'POST'
      );
      await tile.getByRole('button', { name: /as seen/ }).click();
      expect((await seen).ok()).toBe(true);
      await expect(tile).toHaveCount(0);
    } finally {
      for (const uri of uris) await cleanupSembleConnection(uri);
    }
  });
});
