import { test, expect } from './fixtures';
import { seedItemLabel, seedSavedArticle, type TestUser } from './seed';

// A word that exists ONLY inside an article body, so a hit proves full-text
// search reached the cached body rather than the metadata.
const BODY_WORD = 'quokkatelemetry';

async function seedLibrary(testUser: TestUser) {
  await seedSavedArticle(testUser, {
    url: 'https://example.com/gardening',
    title: 'Gardening Basics',
    domain: 'example.com',
    description: 'Starting a first vegetable bed',
    content: '<p>Tomatoes want sun and patience.</p>',
  });

  await seedSavedArticle(testUser, {
    url: 'https://example.com/ownership',
    title: 'Ownership Explained',
    domain: 'example.com',
    description: 'Borrowing, moves, and lifetimes',
    content: `<p>Somewhere deep in the piece sits the word ${BODY_WORD}, which never appears in the title.</p>`,
  });

  await seedSavedArticle(testUser, {
    url: 'https://example.com/cafe',
    title: 'An Afternoon at the Café',
    domain: 'example.com',
    content: '<p>Espresso, a notebook, and two hours.</p>',
  });

  // Archived, and the only item whose title carries "sourdough" — the cross-view
  // hint has to be what surfaces it while the inbox is showing.
  const archivedRkey = await seedSavedArticle(testUser, {
    url: 'https://example.com/sourdough',
    title: 'Sourdough Notes',
    domain: 'example.com',
    content: '<p>Feed the starter twice a day.</p>',
  });
  await seedItemLabel(testUser, {
    itemKey: `at://${testUser.did}/app.skyreader.feed.saved/${archivedRkey}`,
    itemType: 'saved',
    label: 'archived',
  });
}

test.describe('Saved search', () => {
  test('filters the saved list by title, body text, and clears back', async ({
    authedPage,
    testUser,
  }) => {
    await seedLibrary(testUser);
    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible({ timeout: 15_000 });

    await authedPage.getByRole('button', { name: 'Search saved items' }).click();
    const input = authedPage.getByTestId('saved-search-input');
    await expect(input).toBeFocused();

    // Metadata (title) search.
    await input.fill('gardening');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible();
    await expect(authedPage.getByText('An Afternoon at the Café')).not.toBeVisible();

    // Full-text search: the phrase only exists inside the stored body, and the
    // card swaps its preview line for a snippet around the hit.
    await input.fill(BODY_WORD);
    await expect(authedPage.getByText('Ownership Explained')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Gardening Basics')).not.toBeVisible();
    await expect(authedPage.locator('mark', { hasText: BODY_WORD })).toBeVisible();
    await expect(authedPage.getByText('sits the word')).toBeVisible();

    // AND terms can be split across metadata and full text: "ownership" is
    // only in the title, while BODY_WORD is only in the cached article body.
    // Entered from a query that hides the item, so the assertion below is a
    // hidden → visible transition and not the state the list already sat in —
    // matching each source as a whole (the bug this covers) leaves it hidden.
    await input.fill('gardening');
    await expect(authedPage.getByText('Ownership Explained')).not.toBeVisible();

    await input.fill(`ownership ${BODY_WORD}`);
    await expect(authedPage.getByText('Ownership Explained')).toBeVisible({ timeout: 10_000 });
    await expect(authedPage.getByText('Gardening Basics')).not.toBeVisible();

    // Diacritic-folded metadata match.
    await input.fill('cafe');
    await expect(authedPage.getByText('An Afternoon at the Café')).toBeVisible();

    // Clearing restores the full list.
    await input.fill('');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible();
    await expect(authedPage.getByText('Ownership Explained')).toBeVisible();
  });

  test('offers the archive match count and flips to it', async ({ authedPage, testUser }) => {
    await seedLibrary(testUser);
    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible({ timeout: 15_000 });

    await authedPage.getByRole('button', { name: 'Search saved items' }).click();
    await authedPage.getByTestId('saved-search-input').fill('sourdough');

    // Nothing in the inbox matches, but the archive has exactly one.
    await expect(authedPage.getByText('No matches for')).toBeVisible({ timeout: 10_000 });
    const hint = authedPage.getByRole('button', { name: '1 match in Archive' });
    await expect(hint).toBeVisible();

    await hint.click();
    await expect(authedPage.getByText('Sourdough Notes')).toBeVisible();
  });

  test('leaving Saved hands "/" back to the navigation switcher', async ({
    authedPage,
    testUser,
  }) => {
    await seedLibrary(testUser);
    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible({ timeout: 15_000 });

    // Search on Saved, then leave the surface with the query still applied.
    await authedPage.locator('body').press('/');
    const input = authedPage.getByTestId('saved-search-input');
    await expect(input).toBeFocused();
    await input.fill('gardening');
    await expect(authedPage.getByText('An Afternoon at the Café')).not.toBeVisible();

    // Client-side navigation, deliberately: a full reload would rebuild every
    // store and hide the residual-state bug this covers.
    await authedPage.getByRole('link', { name: 'Home' }).click();
    await expect(authedPage).toHaveURL(/\/home$/);
    await expect(authedPage.getByTestId('saved-search-input')).toHaveCount(0);

    // Off the saved surface, "/" is the switcher again.
    await authedPage.locator('body').press('/');
    await expect(authedPage.getByRole('listbox')).toBeVisible();
    await expect(authedPage.getByTestId('saved-search-input')).toHaveCount(0);
    await authedPage.keyboard.press('Escape');
    await expect(authedPage.getByRole('listbox')).toHaveCount(0);

    // And coming back is a clean list, not the query from last time.
    await authedPage.getByRole('button', { name: 'Saved' }).first().click();
    await expect(
      authedPage
        .getByLabel('Recently saved', { exact: true })
        .getByRole('button', { name: 'An Afternoon at the Café' })
    ).toBeVisible({ timeout: 15_000 });
    await expect(authedPage.getByTestId('saved-search-input')).toHaveCount(0);
  });

  test.describe('on a mobile viewport', () => {
    // Below 1000px the desktop header is hidden and the bottom bar takes over,
    // so the bar is the only way into search there.
    test.use({ viewport: { width: 390, height: 844 } });

    test('the bottom bar opens search', async ({ authedPage, testUser }) => {
      await seedLibrary(testUser);
      await authedPage.goto('/saved');
      await expect(authedPage.getByText('Gardening Basics')).toBeVisible({ timeout: 15_000 });

      await authedPage.getByRole('button', { name: 'Search saved items' }).click();
      const input = authedPage.getByTestId('saved-search-input');
      await expect(input).toBeVisible();

      await input.fill('gardening');
      await expect(authedPage.getByText('Gardening Basics')).toBeVisible();
      await expect(authedPage.getByText('An Afternoon at the Café')).not.toBeVisible();
    });
  });

  test('"/" opens search and Escape clears it', async ({ authedPage, testUser }) => {
    await seedLibrary(testUser);
    await authedPage.goto('/saved');
    await expect(authedPage.getByText('Gardening Basics')).toBeVisible({ timeout: 15_000 });

    await authedPage.locator('body').press('/');
    const input = authedPage.getByTestId('saved-search-input');
    await expect(input).toBeFocused();

    await input.fill('gardening');
    await expect(authedPage.getByText('An Afternoon at the Café')).not.toBeVisible();

    await input.press('Escape');
    await expect(input).not.toBeVisible();
    await expect(authedPage.getByText('An Afternoon at the Café')).toBeVisible();
  });
});
