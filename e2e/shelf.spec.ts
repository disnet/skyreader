import { test, expect } from './fixtures';
import { seedSavedArticle, seedShelfCollection } from './seed';

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

  test('the collection row holds a few; the rest are under All, where one is pinned', async ({
    authedPage,
    testUser,
  }) => {
    for (let n = 1; n <= 8; n++) {
      await seedShelfCollection(testUser, {
        id: `3shelfrow000${n}`,
        name: `Topic ${n}`,
        position: n,
      });
    }

    await authedPage.goto('/shelf');
    const nav = authedPage.getByRole('navigation', { name: 'Collections' });
    await expect(nav.getByRole('button', { name: /^Topic 1/ })).toBeVisible({ timeout: 15_000 });
    // Five on the row (none opened yet, so in order); the eighth isn't there.
    await expect(nav.getByRole('button', { name: /^Topic 5/ })).toBeAttached();
    await expect(nav.getByRole('button', { name: /^Topic 8/ })).toHaveCount(0);

    await nav.getByRole('button', { name: 'All 8' }).click();
    const list = authedPage.getByRole('dialog', { name: 'Collections' });
    await list.getByRole('searchbox', { name: 'Find a collection' }).fill('8');
    const pinned = authedPage.waitForResponse(
      (r) => r.url().includes('/api/shelf/collections/') && r.request().method() === 'PATCH'
    );
    await list.getByRole('button', { name: 'Pin Topic 8' }).click();
    expect((await pinned).status()).toBe(200);
    await authedPage.keyboard.press('Escape');
    await expect(list).toHaveCount(0);

    // Pinned, it leads the row, and stays there after a reload.
    await expect(nav.getByRole('button', { name: /^Topic 8/ })).toBeVisible();
    await authedPage.reload();
    await expect(nav.getByRole('button', { name: /^Topic 8/ })).toBeVisible({ timeout: 15_000 });
    const chips = await nav.locator('.row .chip').allTextContents();
    expect(chips[1]).toMatch(/^\s*Topic 8/);

    // Opened cold by link on a narrow screen, the open collection's chip is
    // scrolled into the row's view, though it sits past the edge.
    await authedPage.setViewportSize({ width: 390, height: 844 });
    await authedPage.goto('/shelf?collection=3shelfrow0007');
    await expect(nav.locator('.chip.active')).toContainText('Topic 7', { timeout: 15_000 });
    await expect(nav.locator('.chip.active')).toBeInViewport({ ratio: 0.9 });
  });

  test('a linked collection opens as a room, and the room links back to it', async ({
    authedPage,
    testUser,
  }) => {
    const roomUri = `at://${testUser.did}/network.cosmik.collection/3shelfroom0001`;
    await seedShelfCollection(testUser, {
      id: '3shelfroomcol1',
      name: 'Slow reading',
      position: 0,
      link: { provider: 'semble', uri: roomUri },
    });
    // The room read resolves the collection off a PDS the test user doesn't
    // have; answer it here, and keep the sync-on-open off the network.
    await authedPage.route('**/api/shelf/collections/*/sync', (route) =>
      route.fulfill({ json: { synced: false, reason: 'gated' } })
    );
    await authedPage.route('**/api/rooms?uri=*', (route) =>
      route.fulfill({
        json: {
          uri: roomUri,
          provider: 'semble',
          ownerDid: testUser.did,
          name: 'Slow reading',
          canAdd: true,
          complete: true,
          items: [],
        },
      })
    );
    await authedPage.route('**/api/rooms/join?uri=*', (route) =>
      route.fulfill({ json: { joined: false } })
    );

    await authedPage.goto('/shelf?collection=3shelfroomcol1');
    const open = authedPage.getByRole('link', { name: 'Open as room' });
    await expect(open).toHaveAttribute('href', `/rooms?uri=${encodeURIComponent(roomUri)}`, {
      timeout: 15_000,
    });
    await open.click();

    await expect(authedPage.getByRole('heading', { name: 'Slow reading' })).toBeVisible({
      timeout: 15_000,
    });
    await authedPage.getByRole('link', { name: 'On your Shelf as Slow reading' }).click();
    await expect(authedPage).toHaveURL(/\/shelf\?collection=3shelfroomcol1$/);
  });

  test('a room started from Rooms lands on the Shelf, linked', async ({ authedPage, testUser }) => {
    const roomUri = `at://${testUser.did}/network.cosmik.collection/3shelfroom0002`;
    // Creating the collection and linking it both write to a PDS the test user
    // doesn't have, so those two answer here; the Shelf collection itself is
    // made for real.
    await authedPage.route('**/api/rooms', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 201,
            json: {
              uri: roomUri,
              provider: 'semble',
              name: 'Field notes',
              access: 'closed',
              joined: true,
            },
          })
        : route.fallback()
    );
    let linkBody: unknown = null;
    await authedPage.route('**/api/shelf/collections/*/link', (route) => {
      linkBody = route.request().postDataJSON();
      return route.fulfill({
        json: {
          success: true,
          link: { provider: 'semble', uri: roomUri, syncedAt: null },
          sync: null,
        },
      });
    });
    await authedPage.route('**/api/shelf/collections/*/sync', (route) =>
      route.fulfill({ json: { synced: false, reason: 'gated' } })
    );
    await authedPage.route('**/api/rooms?uri=*', (route) =>
      route.fulfill({
        json: {
          uri: roomUri,
          provider: 'semble',
          ownerDid: testUser.did,
          name: 'Field notes',
          canAdd: true,
          complete: true,
          items: [],
        },
      })
    );

    await authedPage.goto('/rooms');
    await authedPage.getByRole('button', { name: 'Start a new room' }).click();
    const form = authedPage.getByRole('form', { name: 'Start a new room' });
    await form.getByLabel('Name').fill('Field notes');
    const made = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/shelf/collections') && r.request().method() === 'POST'
    );
    await form.getByRole('button', { name: 'Create room' }).click();
    expect((await made).status()).toBeLessThan(300);

    await expect(authedPage.getByRole('heading', { name: 'Field notes' })).toBeVisible({
      timeout: 15_000,
    });
    expect(linkBody).toMatchObject({ provider: 'semble', collectionUri: roomUri });
    await expect(
      authedPage.getByRole('link', { name: 'On your Shelf as Field notes' })
    ).toHaveAttribute('href', /^\/shelf\?collection=/);
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
    const dismissed = authedPage.waitForEvent('dialog').then((d) => d.dismiss());
    await bar.getByRole('button', { name: 'Delete' }).click();
    await dismissed;
    await expect(bar.getByText('2 selected')).toBeVisible();
    await expect(
      authedPage.locator('.bookmark-card', { hasText: 'Doomed Article 1' })
    ).toBeVisible();

    let message = '';
    authedPage.once('dialog', (d) => {
      message = d.message();
      void d.accept();
    });
    // One bulk request carries both.
    const deleted = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/saved/delete') && r.request().method() === 'POST'
    );
    await bar.getByRole('button', { name: 'Delete' }).click();
    expect(await (await deleted).json()).toEqual({ deleted: 2 });
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

  test('a Delete cut short by a refresh finishes after the page reloads', async ({
    authedPage,
    testUser,
  }) => {
    for (const n of [1, 2, 3]) {
      await seedSavedArticle(testUser, {
        url: `https://example.com/interrupted-${n}`,
        title: `Interrupted Article ${n}`,
        domain: 'example.com',
      });
    }
    const card = (n: number) =>
      authedPage.locator('.bookmark-card', { hasText: `Interrupted Article ${n}` });

    await authedPage.goto('/saved');
    await expect(card(3)).toBeVisible({ timeout: 15_000 });
    await authedPage.getByRole('button', { name: 'Select', exact: true }).click();
    await card(1).click();
    await card(2).click();

    // The server never answers, as though the tab were closed mid-delete.
    const bulkDelete = '**/api/saved/delete';
    let hung = 0;
    await authedPage.route(bulkDelete, () => {
      hung++;
    });
    authedPage.once('dialog', (d) => void d.accept());
    await authedPage
      .getByRole('toolbar', { name: 'Selection' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect.poll(() => hung, { timeout: 15_000 }).toBe(1);
    await expect(card(1)).toHaveCount(0);

    // The queued deletes go out once the page is back.
    await authedPage.unroute(bulkDelete);
    const resent = authedPage.waitForResponse(
      (r) => r.url().endsWith('/api/saved/delete') && r.request().method() === 'POST' && r.ok(),
      { timeout: 20_000 }
    );
    await authedPage.reload();
    await expect(card(3)).toBeVisible({ timeout: 15_000 });
    await expect(card(1)).toHaveCount(0);
    // (It may find them gone already: a request cut off by the reload can still
    // land, and the bulk delete is safe to repeat.)
    await resent;

    // And the server no longer has them.
    const titles = await authedPage.evaluate(async () => {
      const res = await fetch('/api/saved?limit=50');
      const body = (await res.json()) as { articles: { title: string }[] };
      return body.articles.map((a) => a.title);
    });
    expect(titles.filter((t) => t.startsWith('Interrupted'))).toEqual(['Interrupted Article 3']);
  });
});
