import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { seedSavedArticle } from './seed';

// A piece read in pages reopens on the page it was left on, even when the
// reader closes right after the turn (the place's write is debounced, and the
// close has to flush it rather than drop it).

const TITLE = 'A Long Piece in Pages';

/** The place's write: a readProgress POST that isn't the reader's "opened" marker. */
function placeSaved(page: Page) {
  return page.waitForResponse((r) => {
    const body = r.request().postData() ?? '';
    return (
      r.url().includes('/api/labels') &&
      r.request().method() === 'POST' &&
      body.includes('readProgress') &&
      !body.includes('"paragraphIndex":-1')
    );
  });
}

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
  // The whole body is laid out (not yet the description's one page).
  await expect(count).toHaveText(/^Page 1 of (?!1$)\d+$/, { timeout: 15_000 });
  // Listening from before the turns, so a write that beats the close still counts.
  const saved = placeSaved(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  const leftAt = (await count.textContent())?.trim();
  expect(leftAt).not.toMatch(/^Page 1 of/);

  // Close at once, inside the save's debounce: the close writes the place.
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-overlay')).toHaveCount(0);
  await saved;

  // Come back fresh, so the page comes from what was stored.
  await page.goto('/saved');
  await openIt();
  await expect(count).toHaveText(leftAt!);
});

test('the daily magazine keeps the page when it closes right after a turn', async ({
  authedPage: page,
  testUser,
}) => {
  for (const [i, url] of [
    'https://example.com/daily/one',
    'https://example.org/daily/two',
  ].entries()) {
    await seedSavedArticle(testUser, {
      url,
      title: `Daily Story ${i + 1}`,
      domain: new URL(url).hostname,
      contentType: 'article',
      content: Array.from(
        { length: 300 },
        (_, n) =>
          `<p>Paragraph ${n} of daily story ${i + 1}, about reading on the web, at length.</p>`
      ).join(''),
      wordCount: 2000,
    });
  }
  await page.goto('/home');
  await page.getByRole('button', { name: 'Generate issue' }).click({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/daily$/);
  await expect(page.locator('.issue-article')).toHaveCount(2, { timeout: 15_000 });
  await page.getByTitle('Switch to paged view').locator('visible=true').click({ timeout: 15_000 });
  const count = page.locator('.paged-count');
  await expect(count).toHaveText(/^Page 1 of (?!1$)\d+$/, { timeout: 15_000 });
  // Settle on the first page past the magazine's own resume bookkeeping.
  await page.waitForTimeout(1500);

  const saved = placeSaved(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect(count).toHaveText(/^Page 4 of/);
  const leftAt = (await count.textContent())?.trim();

  // Leave at once (back to Home), inside the save's debounce: leaving writes the place.
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await saved;

  await page.goto('/daily');
  await expect(page.locator('.issue-article')).toHaveCount(2, { timeout: 15_000 });
  await expect(count).toHaveText(leftAt!, { timeout: 15_000 });
});
