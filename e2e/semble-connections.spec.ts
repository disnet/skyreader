import { test, expect } from './fixtures';
import { cleanupSembleConnection, seedSavedArticle, seedSembleConnection } from './seed';

// Semble connections other people drew off a save: a quiet "new" badge on the
// card in the Queue and on the Shelf, a New connections lane at the top of the
// Shelf whose tiles say who connected what, and both stay until the reader
// marks them seen in the save's discussion.
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
      const markSeen = authedPage.getByRole('button', { name: /as seen/ });
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
});
