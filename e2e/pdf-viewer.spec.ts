import { test, expect } from './fixtures';
import { makeSupporter, seedSavedArticle } from './seed';
import { makePdf, type Placed } from '../frontend/src/routes/dev/_harness/pdfFixture';

// A saved PDF reads as reflowed text, and flips to its original pages (drawn by
// PDF.js) and back. The original's bytes come from GET /api/saved/<rkey>/file,
// which is stubbed here: a real upload needs the pdf-extractor Worker and R2.

const TITLE = 'A Paper About Attention';
const BODY = `<section data-pdf-page="1"><h2>Introduction</h2>${Array.from(
  { length: 6 },
  (_, i) => `<p>Reflowed paragraph ${i + 1} of the paper, set as ordinary text.</p>`
).join('')}</section>`;

function pdfBytes(): Buffer {
  const pages: Placed[][] = [1, 2, 3].map((p) => [
    [72, 720, 20, `Page ${p} heading`],
    [72, 680, 11, `Original text on page ${p}.`],
  ]);
  return Buffer.from(makePdf(pages));
}

test.describe('PDF original view', () => {
  test('flips between the reflowed text and the original pages', async ({
    authedPage,
    testUser,
  }) => {
    await makeSupporter(testUser);
    const rkey = await seedSavedArticle(testUser, {
      url: '',
      title: TITLE,
      source: 'upload',
      contentType: 'pdf',
      content: BODY,
      wordCount: 60,
    });
    let fileRequests = 0;
    await authedPage.route(`**/api/saved/${rkey}/file`, (route) => {
      fileRequests++;
      return route.fulfill({ body: pdfBytes(), contentType: 'application/pdf' });
    });
    await authedPage.evaluate(() => localStorage.removeItem('skyreader-pdf-view'));

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });

    const reader = authedPage.locator('.reader-body');
    // Text first: the reflow, where highlights and notes live.
    const toggle = authedPage.getByRole('group', { name: 'Show this PDF as' });
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await expect(reader.getByText('Reflowed paragraph 1')).toBeVisible();
    expect(fileRequests).toBe(0);

    await toggle.getByRole('button', { name: 'Original' }).click();
    await expect(authedPage.locator('.pdf-page')).toHaveCount(3, { timeout: 15_000 });
    await expect(authedPage.locator('.pdf-page canvas').first()).toBeVisible();
    await expect(authedPage.locator('.textLayer').first()).toContainText('Page 1 heading');
    await expect(reader.getByText('Reflowed paragraph 1')).toHaveCount(0);

    // The choice sticks: reopening the reader comes back to the pages.
    await authedPage.reload();
    await expect(authedPage.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });

    await authedPage
      .getByRole('group', { name: 'Show this PDF as' })
      .getByRole('button', { name: 'Text' })
      .click();
    await expect(reader.getByText('Reflowed paragraph 1')).toBeVisible();
    await expect(authedPage.locator('.pdf-page')).toHaveCount(0);
  });

  test('a web article has no PDF toggle', async ({ authedPage, testUser }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/plain-article',
      title: 'A Plain Article',
      content: '<p>Just a web page.</p>',
    });
    await authedPage.goto('/saved');
    await authedPage.getByText('A Plain Article').first().click({ timeout: 15_000 });
    await expect(authedPage.locator('.reader-body').getByText('Just a web page.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByRole('group', { name: 'Show this PDF as' })).toHaveCount(0);
  });
});
