import { test, expect } from './fixtures';
import { seedSavedArticle, seedShelfCollection } from './seed';

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

// On a link already in the Library, Edit save… turns the menu into the
// reader's Save panel, where it's kept on the Shelf or filed into a collection. (A save made from
// the menu is refused here: the seeded session's scopes predate the save API.)
test('the link menu files a saved link into a collection', async ({ authedPage, testUser }) => {
  await seedShelfCollection(testUser, { id: '3linkmenu00001', name: 'Field notes', position: 0 });
  await seedSavedArticle(testUser, {
    url: 'https://example.com/with-link',
    title: TITLE,
    domain: 'example.com',
    contentType: 'article',
    content: BODY,
    wordCount: 200,
  });
  await seedSavedArticle(testUser, {
    url: 'https://other.example/linked-piece',
    title: 'The Linked Piece',
    domain: 'other.example',
  });

  await authedPage.goto('/saved');
  await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
  const reader = authedPage.locator('.reader-overlay');
  await expect(reader).toBeVisible({ timeout: 15_000 });

  await reader.getByText('the linked piece').click();
  await expect(authedPage.getByText('In your Queue')).toBeVisible();
  await authedPage.getByRole('menuitem', { name: 'Edit save…' }).click();

  const panel = authedPage.getByRole('dialog', { name: 'Save to Library' });
  await expect(panel.getByText('Saved to your Queue')).toBeVisible();
  await expect(authedPage.getByRole('menu', { name: 'Link actions' })).toBeHidden();

  const added = authedPage.waitForResponse(
    (r) => r.url().includes('/items') && r.request().method() === 'POST'
  );
  await panel.getByRole('checkbox', { name: /Field notes/ }).check();
  expect((await added).status()).toBe(200);
  await expect(panel.getByRole('checkbox', { name: /Shelf/ })).toBeChecked();

  // Back to the link's actions, which now say where it's kept.
  await panel.getByRole('button', { name: 'Back to link actions' }).click();
  await expect(authedPage.getByText('In 1 collection')).toBeVisible();
  await authedPage.getByRole('menuitem', { name: 'Edit save…' }).click();

  // Escape from the panel itself puts the panel away, not the reader.
  await panel.focus();
  await authedPage.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(reader).toBeVisible();
});

// A collection ticked while the save is still on its way is filed once the
// save lands. (The save's own requests are answered here: the seeded
// session's scopes predate the save API.)
test('the link menu files a link ticked while it was still saving', async ({
  authedPage,
  testUser,
}) => {
  await seedShelfCollection(testUser, { id: '3linkmenu00002', name: 'Field notes', position: 0 });
  await seedSavedArticle(testUser, {
    url: 'https://example.com/with-link',
    title: TITLE,
    domain: 'example.com',
    contentType: 'article',
    content: BODY,
    wordCount: 200,
  });
  await authedPage.route('**/api/extract', (r) =>
    r.fulfill({
      json: {
        title: 'The Linked Piece',
        content: '<p>' + 'Words worth keeping. '.repeat(60) + '</p>',
        domain: 'other.example',
        wordCount: 180,
      },
    })
  );
  let landSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (landSave = resolve));
  await authedPage.route('**/api/saved', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    await saveHeld;
    await r.fulfill({
      json: {
        uri: 'at://did:plc:test/app.skyreader.feed.saved/3linkmenusave1',
        savedAt: new Date().toISOString(),
      },
    });
  });
  const filed: string[] = [];
  await authedPage.route('**/api/shelf/collections/*/items', (r) => {
    filed.push(r.request().method());
    return r.fulfill({ json: { success: true, added: 1 } });
  });

  await authedPage.goto('/saved');
  await authedPage.getByText(TITLE).first().click({ timeout: 15_000 });
  const reader = authedPage.locator('.reader-overlay');
  await expect(reader).toBeVisible({ timeout: 15_000 });

  await reader.getByText('the linked piece').click();
  await authedPage.getByRole('menuitem', { name: 'Save to Skyreader' }).click();
  const panel = authedPage.getByRole('dialog', { name: 'Save to Library' });
  await expect(panel.getByText('Saving…')).toBeVisible();

  // Ticked while saving: shown at once, filed only once the save lands.
  await panel.getByRole('checkbox', { name: /Field notes/ }).check();
  await expect(panel.getByRole('checkbox', { name: /Shelf/ })).toBeChecked();
  expect(filed).toEqual([]);

  landSave();
  await expect(panel.getByText('Saved to your Queue')).toBeVisible();
  await expect.poll(() => filed).toContain('POST');
  await expect(panel.getByRole('checkbox', { name: /Field notes/ })).toBeChecked();
});
