import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// The moment a connection occurs to a reader is often mid-passage. Selecting
// text offers Connect on Semble, and the dialog opens with the passage quoted
// in the note, since the connection record has no field of its own for it.
test('connecting from a selection quotes the passage in the note', async ({
  authedPage: page,
  testUser,
}) => {
  await seedSavedArticle(testUser, {
    url: 'https://example.com/connect-from-a-passage',
    title: 'An Essay With a Passage',
    domain: 'example.com',
    contentType: 'article',
    content:
      '<p>The passage worth connecting says that reading adds up when it is kept.</p>' +
      '<p>A second paragraph follows it, so the first is plainly prose.</p>',
    wordCount: 30,
  });

  await page.goto('/?saved=true');
  await page.getByText('An Essay With a Passage').first().click({ timeout: 15_000 });
  const paragraph = page.locator('.reader-body p').first();
  await expect(paragraph).toBeVisible({ timeout: 15_000 });

  // Drag across the opening words, the way a reader selects.
  const box = (await paragraph.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = (await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim();
  expect(selected.length).toBeGreaterThan(5);

  await page.getByRole('button', { name: 'Connect on Semble' }).click();

  const note = page.locator('textarea.note');
  await expect(note).toBeVisible();
  await expect(note).toHaveValue(`“${selected}”`);
  // Connecting isn't also highlighting.
  await expect(page.locator('.reader-body mark.highlight')).toHaveCount(0);
});
