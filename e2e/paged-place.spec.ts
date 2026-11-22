import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// A piece read in pages reopens on the page it was left on, even when the
// reader closes right after the turn (the place's write is debounced, and the
// close has to flush it rather than drop it).

const TITLE = 'A Long Piece in Pages';

test('closing right after a page turn keeps the page', async ({ authedPage: page, testUser }) => {
  await seedSavedArticle(testUser, {
    url: 'https://pages.example/long',
    title: TITLE,
    domain: 'pages.example',
    contentType: 'article',
    content: Array.from(
      { length: 120 },
      (_, n) => `<p>Paragraph ${n} of a long piece about reading on the web, at some length.</p>`
    ).join(''),
    wordCount: 3000,
  });
  await page.goto('/saved');
  const openIt = () =>
    page.locator('.bookmark-title', { hasText: TITLE }).click({ timeout: 15_000 });
  const count = page.locator('.paged-count');

  await openIt();
  await page.locator('.reader-header').getByRole('button', { name: 'Pages' }).click();
  await expect(count).toHaveText(/^Page 1 of/);
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  const leftAt = (await count.textContent())?.trim();
  expect(leftAt).not.toMatch(/^Page 1 of/);

  // Close at once, inside the save's debounce: the close writes the place.
  const saved = page.waitForResponse(
    (r) =>
      r.url().includes('/api/labels') &&
      r.request().method() === 'POST' &&
      (r.request().postData() ?? '').includes('readProgress')
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-overlay')).toHaveCount(0);
  await saved;

  // Come back fresh, so the page comes from what was stored.
  await page.goto('/saved');
  await openIt();
  await expect(count).toHaveText(leftAt!);
});
