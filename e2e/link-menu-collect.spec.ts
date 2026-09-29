import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// Tapping a link in the reader opens a menu whose "Save to Semble / Margin…"
// hands the link to the app-wide collection picker. The menu closes first, and
// its host clears the state the menu's props read from — so the link has to be
// taken before the close, or the picker never opens. A component test with
// static props can't see that; this drives the real host.

const TITLE = 'An Article With A Link';
const BODY =
  '<p>Before the link. <a href="https://other.example/linked-piece">the linked piece</a> after.</p>' +
  Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}.</p>`).join('');

for (const label of ['Semble', 'Margin'] as const) {
  test(`the link menu opens the ${label} collection picker`, async ({ authedPage, testUser }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/with-link',
      title: TITLE,
      domain: 'example.com',
      contentType: 'article',
      content: BODY,
      wordCount: 200,
    });

    await authedPage.goto('/saved');
    await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
    const reader = authedPage.locator('.reader-overlay');
    await expect(reader).toBeVisible({ timeout: 15_000 });

    await reader.getByText('the linked piece').click();
    await authedPage.getByRole('menuitem', { name: `Save to ${label}…` }).click();

    await expect(authedPage.getByRole('heading', { name: `Save to ${label}` })).toBeVisible();
  });
}
