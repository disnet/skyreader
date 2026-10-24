import { test, expect } from './fixtures';
import { seedSavedArticle } from './seed';

// The Shelf: the reference half of the Library (the Queue is the other). Books
// and PDFs are on it by default, anything else is kept from its menu, and
// collections group what's there.
test.describe('Shelf', () => {
  test('books and PDFs are on the Shelf by default; a webpage is kept from the Queue', async ({
    authedPage,
    testUser,
  }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/book.epub',
      title: 'A Shelved Book',
      author: 'Ursula K. Le Guin',
      contentType: 'epub',
    });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/paper.pdf',
      title: 'A Shelved Paper',
      contentType: 'pdf',
    });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/post',
      title: 'A Plain Webpage',
      domain: 'example.com',
    });

    await authedPage.goto('/shelf');
    await expect(
      authedPage.getByRole('button', { name: 'A Shelved Book', exact: true })
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      authedPage.getByRole('button', { name: 'A Shelved Paper', exact: true })
    ).toBeVisible();
    await expect(authedPage.getByText('A Plain Webpage')).toHaveCount(0);

    // Keep the webpage from its Queue menu.
    await authedPage.goto('/saved');
    const card = authedPage.locator('.bookmark-card', { hasText: 'A Plain Webpage' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    const keep = authedPage.waitForResponse(
      (r) => r.url().includes('/api/labels') && r.request().method() === 'POST'
    );
    await card.locator('.menu-trigger').click();
    await authedPage.getByRole('menuitem', { name: 'Add to Shelf' }).click();
    await keep;

    await authedPage.goto('/shelf');
    await expect(
      authedPage.getByRole('button', { name: 'A Plain Webpage', exact: true })
    ).toBeVisible({
      timeout: 15_000,
    });

    // Narrowing by kind.
    await authedPage.getByRole('button', { name: 'Books', exact: true }).click();
    await expect(
      authedPage.getByRole('button', { name: 'A Shelved Book', exact: true })
    ).toBeVisible();
    await expect(
      authedPage.getByRole('button', { name: 'A Plain Webpage', exact: true })
    ).toHaveCount(0);
  });

  test('archiving in the Queue keeps a save on the Shelf, marked Archived', async ({
    authedPage,
    testUser,
  }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/finished.pdf',
      title: 'A Finished Paper',
      contentType: 'pdf',
    });

    // In the Queue, a PDF says it's also on the Shelf.
    await authedPage.goto('/saved');
    const card = authedPage.locator('.bookmark-card', { hasText: 'A Finished Paper' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText('On Shelf')).toBeVisible();

    const archive = authedPage.waitForResponse(
      (r) => r.url().includes('/api/labels') && r.request().method() === 'POST'
    );
    await card.locator('.menu-trigger').click();
    await authedPage.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await archive;
    await expect(card).toHaveCount(0);

    // It's still on the Shelf, and says where it sits in the Queue.
    await authedPage
      .getByRole('navigation', { name: 'Library' })
      .getByRole('link', { name: 'Shelf' })
      .click();
    const item = authedPage.locator('.shelf-card', { hasText: 'A Finished Paper' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.getByText('Archived', { exact: true })).toBeVisible();
  });

  test('a collection is created, filled and survives a reload', async ({
    authedPage,
    testUser,
  }) => {
    await seedSavedArticle(testUser, {
      url: 'https://example.com/sicp.pdf',
      title: 'Structure and Interpretation',
      contentType: 'pdf',
    });
    await seedSavedArticle(testUser, {
      url: 'https://example.com/other.pdf',
      title: 'Something Else',
      contentType: 'pdf',
    });

    await authedPage.goto('/shelf');
    await expect(
      authedPage.getByRole('button', { name: 'Structure and Interpretation', exact: true })
    ).toBeVisible({ timeout: 15_000 });

    await authedPage.getByRole('button', { name: 'New collection' }).click();
    await authedPage.getByPlaceholder('Collection name').fill('Course reading');
    const created = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/shelf/collections') && r.request().method() === 'POST'
    );
    await authedPage.getByRole('button', { name: 'Create' }).click();
    expect((await created).status()).toBe(200);

    // The new collection is selected and empty.
    await expect(authedPage.getByRole('heading', { name: 'Course reading' })).toBeVisible();
    await expect(authedPage.getByText('This collection is empty')).toBeVisible();

    // Back to everything, file one item via the picker.
    await authedPage.getByRole('button', { name: /^Everything/ }).click();
    const item = authedPage.locator('.shelf-card', { hasText: 'Structure and Interpretation' });
    await item.locator('.menu-trigger').click();
    await authedPage.getByRole('menuitem', { name: 'Add to collection' }).click();
    const added = authedPage.waitForResponse(
      (r) => r.url().includes('/items') && r.request().method() === 'POST'
    );
    await authedPage.getByRole('checkbox', { name: /Course reading/ }).check();
    expect((await added).status()).toBe(200);
    await authedPage.keyboard.press('Escape');

    await authedPage.reload();
    await authedPage.getByRole('button', { name: /^Course reading/ }).click();
    await expect(
      authedPage.getByRole('button', { name: 'Structure and Interpretation', exact: true })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      authedPage.getByRole('button', { name: 'Something Else', exact: true })
    ).toHaveCount(0);

    // Opening from the Shelf uses the shared reader stack (`?read=`).
    await authedPage
      .getByRole('button', { name: 'Structure and Interpretation', exact: true })
      .click();
    await expect(authedPage).toHaveURL(/[?&]read=/);

    // The sidebar lists the collection under Library, and opens it from anywhere.
    await authedPage.goto('/feeds');
    await authedPage.locator('.collection-item', { hasText: 'Course reading' }).click();
    await expect(authedPage).toHaveURL(/\/shelf\?collection=/);
    await expect(authedPage.getByRole('heading', { name: 'Course reading' })).toBeVisible();
  });

  test('select all in the Queue files many saves at once; Remove takes some back out', async ({
    authedPage,
    testUser,
  }) => {
    for (const n of [1, 2, 3]) {
      await seedSavedArticle(testUser, {
        url: `https://example.com/bulk-${n}`,
        title: `Bulk Article ${n}`,
        domain: 'example.com',
      });
    }

    await authedPage.goto('/saved');
    await expect(authedPage.locator('.bookmark-card', { hasText: 'Bulk Article 3' })).toBeVisible({
      timeout: 15_000,
    });

    await authedPage.getByRole('button', { name: 'Select', exact: true }).click();
    const bar = authedPage.getByRole('toolbar', { name: 'Selection' });
    await bar.getByRole('button', { name: /^Select all/ }).click();
    await expect(bar.getByText('3 selected')).toBeVisible();

    // A tap toggles in select mode instead of opening the reader.
    await authedPage.locator('.bookmark-card', { hasText: 'Bulk Article 2' }).click();
    await expect(bar.getByText('2 selected')).toBeVisible();
    await expect(authedPage).not.toHaveURL(/[?&]read=/);
    await authedPage.locator('.bookmark-card', { hasText: 'Bulk Article 2' }).click();

    await bar.getByRole('button', { name: 'Add to collection' }).click();
    await expect(authedPage.getByText('3 items')).toBeVisible();
    await authedPage.getByPlaceholder('New collection').fill('Bulk reading');
    const added = authedPage.waitForResponse(
      (r) => r.url().includes('/items') && r.request().method() === 'POST'
    );
    await authedPage
      .getByLabel('Add to collection')
      .getByRole('button', { name: 'Add', exact: true })
      .click();
    const addResponse = await added;
    expect(addResponse.status()).toBe(200);
    expect(addResponse.request().postDataJSON().rkeys).toHaveLength(3);
    await authedPage.keyboard.press('Escape');

    // On the Shelf, in the collection: select one and take it out.
    await authedPage.goto('/shelf');
    await authedPage.getByRole('button', { name: /^Bulk reading/ }).click();
    await authedPage.getByRole('button', { name: 'List' }).click();
    await expect(authedPage.getByRole('button', { name: /Bulk Article 1/ })).toBeVisible({
      timeout: 15_000,
    });
    await authedPage.getByRole('button', { name: 'Select', exact: true }).click();
    await authedPage.getByRole('button', { name: /Bulk Article 1/ }).click();
    const removed = authedPage.waitForResponse(
      (r) => r.url().endsWith('/items') && r.request().method() === 'DELETE'
    );
    await authedPage
      .getByRole('toolbar', { name: 'Selection' })
      .getByRole('button', { name: 'Remove' })
      .click();
    expect((await removed).status()).toBe(200);

    await authedPage.reload();
    await authedPage.getByRole('button', { name: /^Bulk reading/ }).click();
    await expect(authedPage.getByRole('button', { name: /Bulk Article 2/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(authedPage.getByRole('button', { name: /Bulk Article 1/ })).toHaveCount(0);
  });

  test('Delete removes the selected saves, after a confirm, and they stay gone', async ({
    authedPage,
    testUser,
  }) => {
    for (const n of [1, 2, 3]) {
      await seedSavedArticle(testUser, {
        url: `https://example.com/doomed-${n}`,
        title: `Doomed Article ${n}`,
        domain: 'example.com',
      });
    }

    await authedPage.goto('/saved');
    await expect(authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 3' })).toBeVisible(
      {
        timeout: 15_000,
      }
    );
    await authedPage.getByRole('button', { name: 'Select', exact: true }).click();
    await authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 1' }).click();
    await authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 2' }).click();
    const bar = authedPage.getByRole('toolbar', { name: 'Selection' });

    // Dismissing the confirm deletes nothing.
    authedPage.once('dialog', (d) => void d.dismiss());
    await bar.getByRole('button', { name: 'Delete' }).click();
    await expect(bar.getByText('2 selected')).toBeVisible();
    await expect(
      authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 1' })
    ).toBeVisible();

    let message = '';
    authedPage.once('dialog', (d) => {
      message = d.message();
      void d.accept();
    });
    const deletes = Promise.all(
      [0, 1].map(() =>
        authedPage.waitForResponse(
          (r) => /\/api\/saved\/[a-z0-9]+$/.test(r.url()) && r.request().method() === 'DELETE'
        )
      )
    );
    await bar.getByRole('button', { name: 'Delete' }).click();
    await deletes;
    expect(message).toContain('Delete 2 items');
    await expect(authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 1' })).toHaveCount(
      0
    );

    await authedPage.reload();
    await expect(authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 3' })).toBeVisible(
      {
        timeout: 15_000,
      }
    );
    await expect(
      authedPage.locator('.bookmark-card', { hasText: /Doomed Article [12]/ })
    ).toHaveCount(0);
  });
});
